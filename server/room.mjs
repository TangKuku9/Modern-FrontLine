// 权威对局房间：一份 HeadlessGame + 若干真人玩家，按固定 60Hz 步长推进。
//
// 这一层刻意不复用 js/mp.js 的 MPMatch —— 那个类把"本地玩家"当成 game.player，
// 还把 HUD/DOM 当成规则的输出端（document.getElementById 在服务端会直接炸）。
// 但**规则**不能各写一份：计分、连杀槽的充能/就绪、UAV 计时、空袭排程都走
// js/match-rules.js，那是单机 MPMatch 与这里共用的同一份内核。
import * as THREE from 'three';
import { HeadlessGame, preloadMaterials } from './headless-game.mjs';
import { Player } from '../js/player.js';
import { Bot } from '../js/ai.js';
import { MAPS } from '../js/maps.js';
import { rng } from '../js/rng.js';
import { FLAG, weaponIndex, teamIndex, unpackInput, unpackStreak, uavBit, WORLD } from '../js/quant.js';
import { sanitizeLoadout } from '../js/loadout.mjs';
import { PoseRing, rewindTick } from './lagcomp.mjs';
import { MatchRules, StreakBook, UAV_SECONDS, WP_SECONDS, SENTRY_SECONDS, HELI_SECONDS, killScore, KILL_POINTS } from '../js/match-rules.js';
import { clusterStrike, phosphorusSweep } from '../js/combat.js';
import { Sentry, Heli } from '../js/mp.js';
import { KILLSTREAKS, DEFAULT_STREAKS } from '../js/data.js';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const SNAP_EVERY = 3;                       // 60Hz 模拟 / 3 = 20Hz 快照
export const RESPAWN_DELAY = 3.0;
// 每人最多攒几拍没消费的输入。正常客户端一渲染帧 flush 一次，1 秒也就 60 拍；
// 上限取 1 秒的量：再小就会在"客户端卡了一帧"时把中间拍丢掉，那等于服务端偷偷
// 少跑了几拍，客户端的预测只能靠下一次校正拽回来 —— 一种没人报错的橡皮筋。
export const INPUT_QUEUE = 60;

// cid 必须是"这台进程范围内唯一"，不能每个房间各自从 1 开始编号。
// 各房间自己数的话，房间 A 的 1 号和房间 B 的 1 号同名 —— 只看自己房间时不出事，
// 但任何拿 id 路由的地方（广播、回放、排障日志、跨房间的赛事统计）都会撞车，
// 而且探针也没法用"包里有没有出现陌生 id"来判断串门。串门的成因见 net-server:broadcast。
let NEXT_CID = 1;

// 连杀奖励的槽位表。账户系统还没做（README 待办 1），所以默认用 DEFAULT_STREAKS 的三项。
// 这份表必须只列**完整实现**的项：能呼叫却生效不了（只发一条通知、实体只长在部署者
// 那台机器上）比根本没有这一项更糟 —— 别人会被一个自己看不见的东西打死。
// 五项都已经实现，所以这里就是随手挑一个子集；将来账号做了之后，
// 每个人带哪三项进对局会走 `opts.streaks`（房间级）而不是全局常量。
export const STREAK_DEFS = DEFAULT_STREAKS.map(id => KILLSTREAKS.find(k => k.id === id)).filter(Boolean);
export const STREAK_IDS = STREAK_DEFS.map(d => d.id);
export const resolveStreaks = (ids) => (Array.isArray(ids) ? ids : STREAK_IDS)
  .map(id => KILLSTREAKS.find(k => k.id === id)).filter(Boolean);

// 联机下集束空袭的弹幕中心落在呼叫者视线前方多远。单机是玩家在地图上点的那一点
// （距离不定），联机省掉那次点击（见 NetRoom.callStreak）。取 22 m：比一发手雷远、
// 比半个地图近，也就是"看得见的那片开阔地"。它是**输入**的差别，不是规则的差别。
const CLUSTER_RANGE = 22;

// 位包 → sim 的 input 形状。打包/解包这对函数只在 js/quant.js 里有一份：
// 客户端与服务端各写一个 switch 的话，错位不会报错，只会手感怪。
export function decodeInputBits(keys, buttons) {
  return unpackInput(keys, buttons);
}

export class NetRoom {
  constructor(opts = {}) {
    this.id = opts.id || 'room0';
    this.mapId = opts.mapId || 'yard';
    this.seed = (opts.seed ?? 20260925) >>> 0;
    this.tick = 0;
    this.clients = new Map();                     // cid -> { cid, pl, name, lastInput, dead, respawnT }
    // 反查表（玩家对象 → 客户端条目）。用它而不是往 pl 上挂一个 __cid：加了 own key 会撞
    // test/net-journal.mjs 那道"新字段必须登记"的守卫，而它本来就只是房间的簿记。
    this.byPlayer = new Map();
    this.events = [];                             // 待下发的游戏事件，排干即清
    // 待落库的对局结果。**刻意和 events 分开**：events 每拍就被排干发给客户端，
    // 而这个是给"循环外面"的账号层去处理的。混在一起的话，某次排干 events 顺手把它也清掉，
    // 症状是"打了一晚上战绩一点没涨"，而且不报错。
    this.__results = [];
    // 延迟补偿的读数（/healthz 会带出去）。它必须落在生产代码里而不是只在探针里数：
    // 这条链路**每一种失效方式都是静默的** —— 报值出窗 ⇒ 服务端一律拒绝 ⇒ 这个玩家永远
    // 没有补偿，不报错、不崩，只是"我明明打中了"。四个计数各指一种成因，修法完全不同：
    //   shots    裁决过多少发（0 = 这条链路根本没被走过，判据可能量的是空气）
    //   ok       真的按历史姿态判的；depth 是回溯深度（INTERP_DELAY 被改成 0 这类事故的读数）
    //   noView   客户端没报拍号（还没收到过快照 / 老客户端）—— 这是设计好的退化，不算故障
    //   stale    报了**非零**拍号却被闸门拒 —— 口径不合或客户端卡住；健康链路上必须为 0
    //   poseMiss 闸门放行了、姿态缓冲里却没有那一拍 —— 缓冲比窗短，症状是"延迟越大越打不中"
    this.lag = { shots: 0, ok: 0, noView: 0, stale: 0, poseMiss: 0, dMin: 0, dMax: 0, dSum: 0, staleWhy: [] };
    // 规则内核：分数、UAV/白磷弹计时、按拍排程的空袭，都在它里面。单机 MPMatch
    // 用的是同一个类 —— 这就是"联机规则"这一项的全部含义。
    this.rules = new MatchRules(opts.cfg || { mode: opts.mode || 'tdm' });
    // 这一局带哪几项连杀奖励。它必须是**房间**的属性而不是客户端的：槽位表决定了
    // "按 3/4/5 各是什么"，两端各拿一份的话，服务端换一项客户端还显示旧的 ——
    // 症状是"按了没反应"，正是这一轮要消灭的那类静默失效。
    this.streakDefs = resolveStreaks(opts.streaks);
    // 连杀呼叫的读数。/healthz 会带出去。它和 lag 那条链路的性质一样：**每一种失效
    // 都是静默的** —— 玩家按 3 没反应，既不报错也不崩。
    //   calls     收到多少次呼叫请求（0 = 上行那一位根本没接通，判据可能量的是空气）
    //   accepted  真的生效了
    //   rejected  报了请求但槽位不就绪 / 越界（正常对局里该是 0：HUD 只让按就绪的）
    this.streak = { calls: 0, accepted: 0, rejected: 0, byId: {}, why: [] };
    // 群体警戒（js/ai.js 的 alertGroup）。房间目前不放 AI，但这条链路要能通 ——
    // 它是 headless-game 已经铺好、只断在最后一跳的那种**静默失效**：调用点被
    // `game.alertGroup &&` 挡着，缺了实现在两边都不报错，只是"整组敌人不会一起警戒"。
    this.alerted = new Set();
    this.alertSpread = 0;                         // 被扩散到的人数累计（判据的可读数）
    this.bots = new Map();                        // bot -> 分组名（联机侧目前只有探针往里放）
    this.active = [];                             // 连杀奖励产生的权威实体（哨戒机枪 / 直升机）
    this.netIds = 0;                              // 给它们编的同步 id（事件里带出去，客户端按它删）
    this.matchOverSent = false;
    this.started = false;
  }

  async start() {
    if (this.started) return this;
    rng.seed(this.seed);
    await preloadMaterials();                     // MATS 是模块级单例，多个房间共享一次
    this.game = new HeadlessGame();
    await this.game.loadMap(this.mapId);
    this.game.mode = this;                        // 让 makeNoise/计分等走房间而不是 MPMatch
    this.started = true;
    return this;
  }

  spawnPoint(team) {
    const w = this.game.world;
    const cands = [...(w.spawns[team] || []), ...(team === 'P' ? [...w.spawns.A, ...w.spawns.B] : [])];
    for (let i = 0; i < 6; i++) cands.push(w.randomWalkable());
    const foes = [...this.clients.values()].filter(c => c.pl.alive && c.pl.team !== team && c.pl.pos);
    let best = cands[0], bs = -1;
    for (const c of cands) {
      let md = 1e9;
      for (const f of foes) md = Math.min(md, f.pl.pos.distanceTo(c));   // clients 不是 players
      const s = Math.min(md, 60) + rng.next() * 8;
      if (s > bs) { bs = s; best = c; }
    }
    const pos = best.clone();
    return { pos, yaw: Math.atan2(pos.x, pos.z) };
  }

  addClient({ name = '士兵', team = 'A', loadout = null, account = null } = {}) {
    const cid = NEXT_CID++;
    const sp = this.spawnPoint(team);
    // rngSeed/rngTag：这个人那条私有玩法流的播种对（见 js/player.js 构造函数）。客户端要用
    // 同一对值才算得出同一个后坐/散布，而 cid 是它从 welcome 里拿到的那个 —— 服务端这里
    // 必须在建人之前就把 cid 交出去，两端才不会出现"流对不上"的第三种版本。
    const pl = new Player(this.game, { team, pos: sp.pos, yaw: sp.yaw, name, rngSeed: this.seed, rngTag: cid });
    // 装备以服务端查表重建为准（为什么要拦、拦掉的是什么，见 js/loadout.mjs）。
    // 重建后这份要挂到人身上：welcome 得把同一个对象发回去，客户端按它配枪 —— 两边各自
    // 拿一份副本算 stats，就是"本地打中了、权威说没有"那种没人报错的分歧。
    const lo = sanitizeLoadout(loadout);
    pl.equip(lo);
    this.game.entities.push(pl);
    if (!this.game.player) this.game.player = pl;   // 第一个人占住"本机玩家"那个老位置，
    // 其余的人靠 NetRoom.step 传的 pairs 列表被推进。
    const c = {
      cid, pl, name, team, loadout: lo, lastInput: decodeInputBits(0, 0), q: [], lastQueued: -1, ack: 0, rep: 0, got: false, dead: false, respawnT: 0,
      // —— 对局规则的簿记（每个人一份）——
      // book：连杀槽。成本里含"强硬路线"的减 1 —— 那是装备带来的，所以要在装好装备之后
      // （pl.equip 已经在上面跑过）算，且中途换职业时要重算（js/match-rules.js:setDiscount）。
      // kills/deaths/score：记分板要读。以前这三个数只存在于单机的 pl.stats 上，
      // 联机侧没有任何地方记 —— 于是记分板是空的。
      book: new StreakBook(this.streakDefs, pl.hasPerk('hardline') ? 1 : 0),
      kills: 0, deaths: 0, score: 0,
      // account 是**握手时验过的会话**给出的账号 key（不是 join 帧里自报的）。
      // 它是"这个人是谁"在权威侧的唯一凭据，也是战绩唯一能落到谁头上的依据；
      // 访客（REQUIRE_ACCOUNT=0）这里是 null，于是这一局的数字**只进记分板、不进档案**。
      account,
      // —— 延迟补偿的三件簿记 ——
      // pose：每拍的命中盒参数（见 server/lagcomp.mjs:PoseRing）
      // view：这一拍消费掉的那份输入里，客户端说它当时在渲染哪一拍
      // lastSnapSent：我最近一次给它下发快照时的拍号 —— rewindTick 拿它当"不可伪造的上界"
      pose: new PoseRing(), view: 0, lastSnapSent: 0,
    };
    this.clients.set(cid, c);
    this.byPlayer.set(pl, c);
    this.events.push({ e: 'join', cid, name, team, pos: [sp.pos.x, sp.pos.y, sp.pos.z], yaw: sp.yaw });
    return c;
  }

  removeClient(cid) {
    const c = this.clients.get(cid);
    if (!c) return;
    c.pl.alive = false;
    const i = this.game.entities.indexOf(c.pl);
    if (i >= 0) this.game.entities.splice(i, 1);
    this.byPlayer.delete(c.pl);
    this.clients.delete(cid);
    this.events.push({ e: 'leave', cid });
  }

  applyInput(cid, net) {
    const c = this.clients.get(cid);
    if (!c) return;
    const inp = decodeInputBits(net.keys, net.buttons);
    inp.mdx = net.mdx; inp.mdy = net.mdy;
    inp.tick = net.tick & 0xffff;
    // 客户端说它发出这一拍时，屏幕上渲染的是服务端的哪一拍（低 16 位）。
    // 它只在这里被搬进队列，真正生效是在 step() 里被消费的那一刻 —— 和输入本身同一时刻，
    // 于是"打到的是当时看到的世界"这句话里的"当时"就是这一拍。
    inp.view = net.view & 0xffff;
    // 连杀呼叫：0..n = 呼叫第几个槽，0xff = 没按（解包成 -1）。
    // 它和别的输入一样**跟着这一拍走**：入队、等 step() 消费这一拍时才生效。
    // 不在收包时立刻处理 —— 那会让"第 100 拍按的 3"在第 103 拍生效，而玩家屏幕上
    // 那一刻的 HUD 已经跳到下一个槽了。
    inp.streak = unpackStreak(net.streak & 0xff);
    // 16 位回绕下的"更新"：差值落在 (0, 2000) 才算后面，重复包和迟到旧包一律丢。
    // 基准刻意不是 c.ack：新玩家一进场 ack 就是 0，而他发出的第一拍也是 0 —— 用 ack 当基准
    // 会把第 0 拍当成重复包丢掉（实测：出生后的第一拍输入永远不被消费）。
    const last = c.q.length ? c.q[c.q.length - 1].tick : c.lastQueued;
    const d = last < 0 ? 1 : (inp.tick - last) & 0xffff;
    if (d === 0 || d >= 2000) return;
    // 按拍入队，一步只取一条。直接在收包时覆盖 lastInput 会丢中间拍：
    // 一个包带 3 拍时只有最后一拍生效，而 mdx 是"那一拍的鼠标位移"，
    // 丢掉的就是转向 —— 客户端重放却会把它们全算上，两边永久错开。
    if (c.q.length < INPUT_QUEUE) { c.q.push(inp); c.lastQueued = inp.tick; c.got = true; }
  }

  step() {
    if (!this.started) return;
    // 规则时钟先走一格：UAV/白磷弹的剩余时间、以及**按拍排程**的空袭投弹都在这一步。
    // 放在 game.step **之前**是为了让"这一拍排出来的炸弹"被这一拍的 projectiles.update
    // 推进 —— 排在世界前进之后的话，每颗弹都会晚一拍照面出现。
    this.rules.step();
    // 每步从队列里取一条；取不到就沿用上一份 —— 掉包时人是站住的，而不是回零乱走
    const inputs = [...this.clients.values()].map(c => {
      const fromQ = c.q.length;
      const inp = fromQ ? c.q.shift() : c.lastInput;
      if (inp.tick !== undefined) c.ack = inp.tick;
      // rep = 从"ack 那一拍的状态"到"这份快照要编的状态"之间，服务端拿旧输入多折叠了几拍。
      // 判据端推导过一遍才敢写死：客户端的基态是 journal[ack+1] = "消费完 I_ack 之后"，而
      // ack 之后再发生的每一步都只能是折叠（一旦又消费到新输入，ack 就前进了、rep 归零），
      // 所以**末尾连拍**这个定义对"持续饥饿"是唯一正确的量：饿得越久 rep 越大，客户端每拍
      // 都从同一个基态重算，两边对齐。
      // 曾经改成"自上次广播以来累计、打包后归零"，那是错的：长时间饿住时 ack 不动，
      // 客户端每份快照都从同一个 journal[ack+1] 出发却只补这一窗的 3 拍，权威端每来一份
      // 快照就多走一整份（实测偏差正好是 0.2236 m = 4.46 m/s × 3 拍 的整数倍，一路累积到 1.56 m）。
      // 这个定义仍然漏掉一类：折叠发生在"消费新输入之前"的那几拍（见 rep0 那条待办）。
      c.rep = fromQ ? 0 : (c.got ? Math.min(255, c.rep + 1) : 0);
      c.lastInput = inp;
      // 这一拍生效的"看到了哪一拍"。取不到货（饿住）时沿用上一份输入的报值 —— 那是它最后
      // 一次真的告诉过我们的东西，而 rewindTick 的上界（lastSnapSent）会兜住它不许无限变旧。
      c.view = inp.view | 0;
      return { c, inp, fresh: fromQ > 0 };
    });
    for (const { c, inp } of inputs) {
      if (!c.pl.alive) {
        c.respawnT -= DT;
        if (c.respawnT <= 0) {
          const sp = this.spawnPoint(c.pl.team);
          c.pl.respawn(sp.pos, sp.yaw);
          // 排队里那些"死亡期间产生"的输入必须丢掉：客户端在重生那一刻会把日记本清空
          // （服务端整体重置，旧日记本没有可比性），留着它们只会让接下来好几包的
          // ack 指到一个已经没有日记本的拍上。
          // （这里原来写着"实测 12 次窗口不够长全是这个"，那句归因错了：后来带着
          //  拍号读数重测，那些空窗全是"服务端刚好消费到我最新那一拍"的边界情形，
          //  与重生无关，已单独立账为 caughtUp。）
          c.q.length = 0;
          c.rep = 0;          // 客户端在重生那一刻清空日记本，重复计数也要跟着归零
          this.events.push({ e: 'respawn', cid: c.cid, pos: [sp.pos.x, sp.pos.y, sp.pos.z], yaw: sp.yaw });
        }
      }
    }
    this.game.step(DT, inputs[0] ? inputs[0].inp : decodeInputBits(0, 0), inputs.map(({ c, inp }) => ({ pl: c.pl, inp })));
    // 连杀奖励生成的东西（哨戒机枪 / 武装直升机）：和 bot 一样是权威实体，每拍由这里推进。
    // 伤害是在**这一台**机器上算出来的（Sentry.update 里走 fireHitscan），这才是"权威"
    // 二字的全部含义 —— 客户端那边只有一个不开火的同形副本（dumb），它负责"看得见"。
    for (const a of this.active) a.update(DT);
    for (const a of this.active) {
      if (a.alive || a.__gone) continue;
      a.__gone = true;
      this.events.push({ e: 'gone', netId: a.netId, kind: a.isTurret ? 'sentry' : 'heli' });
    }
    this.active = this.active.filter(a => a.alive);
    this.tick++;
    // 连杀呼叫的生效。**只在真的消费到一条新输入的那一拍**处理：饥饿时服务端拿手里那份
    // 空跑（rep 期间同一份输入会被跑好几拍），而那一份里可能还留着上一次的请求 ——
    // 按"每拍都看一次 inp.streak"写的话，一个槽会被连点，症状是"按一次 UAV 出来三架"。
    // 客户端的按下沿保证了一条带请求的输入只会被**消费**一次，所以这里是安全的。
    for (const { c, inp, fresh } of inputs) {
      if (fresh && inp.streak >= 0 && c.pl.alive) this.callStreak(c, inp.streak);
    }
    // 记分板与比分。走**事件**而不是快照：快照是定长的（每实体 25 B），塞不下一张
    // 变长的表；而记分板本来也不需要 20Hz 的精度 —— 每 2 秒一份足够。
    // 120 拍是 SNAP_EVERY 的倍数，所以这一条总会落在一次广播里，不会白等一轮。
    if (this.tick % 120 === 0) this.pushBoard();
    // 每秒问一次"这一局结束了没有"。以前 checkEnd 只挂在 onKill 上，于是
    // **分数没到上限的一局永远不结束**：时间条走到 00:00 就停在那儿，人还能继续打死对方，
    // 而房间也永远回不到等待态（房主开不了下一局）。规则的判据在 rules 里，这里只是
    // 给它一个被问到的机会 —— 和 onKill 那次是同一个函数，不是第二份真相。
    if (!this.matchOverSent && this.tick % 60 === 0) {
      this.rules.checkEnd();
      if (this.rules.over) this.endMatch(this.rules.over.winner);
    }
    this.drainKillFeed();
    // 一拍一份姿态，拍号 = 这一拍刚产出的那个状态（this.tick 已经 ++，与快照头里的 tick 同义）。
    // 必须写在 game.step 之后：在那之前这一拍的位移还没算出来，存下去的就是上一拍的姿态，
    // 于是"回溯 N 拍"会系统性少一拍 —— 那种偏差只有半个身位，谁都不会报错。
    for (const c of this.clients.values()) c.pose.record(this.tick, c.pl);
  }

  // 延迟补偿的取料口：js/weapon-state.js:fire 在裁决每一发之前问一句"这一发按哪一拍的姿态算"。
  // 返回 null = 不回溯（照旧按当下），三种情况：不是本房间的人、客户端报的拍号出窗、
  // 缓冲里查不到那一拍（后者在闭包里逐实体兜底）。
  shotRewind(shooter) {
    const c = this.byPlayer.get(shooter);
    if (!c) return null;
    // cur = "正在产出的那一拍"。此刻 this.tick 还没 ++，而 game.step 这一拍产出的状态
    // 会被标成 this.tick+1 —— 和上面 record 用的是同一个编号口径，两边必须一致。
    const cur = this.tick + 1;
    const t = rewindTick(c.view, cur, c.lastSnapSent);
    const L = this.lag;
    L.shots++;
    if (t < 0) {
      // 拒绝的成因要分开数，因为"报 0"是设计好的退化（客户端还没收到过快照），
      // 而"报了非零拍号却被拒"是可归因的故障（口径不合 / 客户端卡住）。
      if (c.view) {
        L.stale++;
        // 留现场：这三个数就足以把"口径不合"（view 与 cur 差着一个数量级）与
        // "客户端卡住"（view 只比窗沿旧一点）分开，不必再复现。
        if (L.staleWhy.length < 6) L.staleWhy.push({ view: c.view, cur, lastSnapSent: c.lastSnapSent, tick: this.tick });
      } else L.noView++;
      return null;
    }
    L.ok++;
    const depth = cur - t;                          // 回溯了几拍。它必须 ≈ INTERP_DELAY×60 + 在途
    if (L.ok === 1 || depth < L.dMin) L.dMin = depth;
    if (depth > L.dMax) L.dMax = depth;
    L.dSum += depth;
    return (e) => {
      if (e === shooter) return null;                 // 不回溯开枪者自己：它瞄的是自己预测的位置
      const oc = this.byPlayer.get(e);
      if (!oc) return null;
      const p = oc.pose.at(t);                        // 那一拍不在缓冲里 → 交回 null（= 按当下判）
      if (!p) L.poseMiss++;
      return p;
    };
  }

  // ================= 对局规则（连杀奖励 / 计分 / 警觉值）=================
  //
  // 这一节就是"联机规则"这一项的本体。规则的**定义**在 js/match-rules.js（连杀槽、
  // 按拍排程、分值）与 js/combat.js（呼叫之后会发生什么），单机 MPMatch 用的是同一份。
  // 这里只做权威端特有的三件事：
  //   ① 把"谁呼叫了什么"从上行输入里取出来并裁决；
  //   ② 把生效的结果编成事件下发给所有人（客户端据此做表现）；
  //   ③ 把规则的读数挂到 /healthz 上，让"静默失效"变成可数的东西。
  //
  // 为什么事件也是必需的：哨戒机枪与武装直升机是**权威实体**（伤害在这一台机器上算），
  // 如果不告诉客户端，别人就是被一个自己看不见的东西打死 —— 那比不做这一项更糟。

  enemiesOf(team) {
    return this.game.entities.filter(e => e.alive && e.team !== team && e.pos && e.targetable !== false);
  }

  // 往房间里放一个 AI。当前联机对局里**不自动放**（真人对真人），但这条通道必须能跑：
  // 判据靠它验"群体警戒在房间里真的会扩散"，而"没人时拿 AI 填房"将来也走这里。
  addBot(bot) { this.game.addBot(bot); this.bots.set(bot, bot.group || null); return bot; }
  removeBot(bot) { this.game.removeBot(bot); this.bots.delete(bot); }

  // 群体警戒。js/ai.js 有四处调 game.alertGroup，而以前 NetRoom 上没有这个方法 ——
  // `this.game.alertGroup && ...` 那条守卫把它整个挡掉：不报错、不崩，只是"整组敌人
  // 不会因为一个人发现了你而一起警戒"。**静默失效**的典型形状，而它离能用只差这十行
  // （HeadlessGame.alertGroup 早就在往 mode 转了）。
  // 返回值不是给调用方用的（ai.js 不看返回值），是给判据读的：n = 这次扩散到几个人。
  alertGroup(group, pos) {
    if (!group || !pos) return { first: false, n: 0 };
    const first = !this.alerted.has(group);
    this.alerted.add(group);
    let n = 0;
    for (const b of this.game.bots) {
      if (b.group !== group || !b.alive) continue;
      b.alerted = true;
      b.hint(pos);
      n++;
    }
    this.alertSpread += n;
    return { first, n };
  }

  // 击杀的规则侧：分数、连杀充能、首杀。表现走事件。
  // 这是 MPMatch.onKill 的**规则那一半**；分值问的是 js/match-rules.js:killScore。
  onKill(killer, victim, weapon, head, info) {
    const R = this.rules;
    R.kills++;
    const kc = killer ? this.byPlayer.get(killer) : null;
    const vc = victim ? this.byPlayer.get(victim) : null;
    if (vc) { vc.deaths++; vc.book.onDeath(); }
    if (killer && killer !== victim) {
      // 团队分：只有 tdm 按击杀加分，占领模式靠占点（与单机 MPMatch 的规则一致）
      if (!R.ffa && R.mode === 'tdm') R.addScore(killer.team, 1);
      const dist = (killer.pos && victim.pos) ? killer.pos.distanceTo(victim.pos) : 0;
      const sc = killScore({ head: !!head, melee: !!(info && info.melee), explosive: !!(info && info.explosive), dist, chain: R.killChain(), revenge: false });
      if (kc) {
        kc.kills++; kc.score += sc.points;
        for (const i of kc.book.charge(1)) {
          R.charged++;
          this.events.push({ e: 'streakReady', cid: kc.cid, slot: i, id: kc.book.slots[i].id, name: kc.book.slots[i].name });
        }
      }
      if (!R.firstBlood) {
        R.firstBlood = true;
        if (kc) { kc.score += KILL_POINTS.firstBlood; this.events.push({ e: 'firstBlood', cid: kc.cid }); }
      }
    }
    const w = R.checkEnd();
    if (w) this.endMatch(w);
  }

  endMatch(winner) {
    if (this.matchOverSent) return;
    this.matchOverSent = true;
    this.events.push({ e: 'matchOver', winner });
    // ── 战绩**不在这里落库**，只把名单和数字挂到队列上 ──
    // 这里跑在 60 拍/秒的权威循环里。写账号这一步以后完全可能（也理应）变成一次
    // 真的磁盘/网络调用 —— 那时这一行就会吃掉每一拍。所以规则是：
    // **这一侧只做 O(1) 的内存记账，真正的写由 net-server 在 tick 循环外面做。**
    // 加多少经验、单人上限多少，那一处定义在 accounts.addResult 里，这里不重复一份。
    const rows = [];
    for (const c of this.clients.values()) {
      if (!c.account) continue;                 // 访客没有档案可写（REQUIRE_ACCOUNT=0 时）
      rows.push({
        account: c.account,                       // 账号 key，不是呼号 —— 呼号可以改，key 不行
        xp: Math.round(c.score),
        kills: c.kills, deaths: c.deaths,
        // winner 是队名（'A'/'B'）或 null（FFA、或者时间到了还没分出队伍赢家）。
        // 写成"winner === null 就不给胜场"，而不是拿进球的队去猜 —— 猜的那一版会把
        // 每一局平局都记成一方的胜场，而表现只是"胜率慢慢偏高"，没人会去查。
        win: !!winner && winner === c.team,
      });
    }
    this.__results.push({ tick: this.tick, winner: winner || null, rows });
    // 队列要有上限：一局结束只推一条，但万一 matchOver 被反复触发（守卫失效），
    // 无上限的数组会把房间变成内存泄漏 —— 而且它泄漏得很安静。
    if (this.__results.length > 8) this.__results.splice(0, this.__results.length - 8);
  }

  // 由 net-server 在 tick 循环外面调用。返回并清空 —— 排干语义和 events 一样，
  // 但**只有这一个入口**能动这个数组。
  takeResults() {
    if (!this.__results.length) return [];
    const out = this.__results;
    this.__results = [];
    return out;
  }

  pushBoard() {
    const rows = [];
    for (const c of this.clients.values()) {
      rows.push({ cid: c.cid, name: c.name, team: c.team, k: c.kills, d: c.deaths, s: Math.round(c.score), sk: Math.floor(c.book.progress) });
    }
    rows.sort((a, b) => b.k - a.k || b.s - a.s);
    this.events.push({
      e: 'board', tick: this.tick,
      scores: { A: Math.round(this.rules.scores.A), B: Math.round(this.rules.scores.B) },
      timeLeft: Math.round(this.rules.timeLeft()),
      uav: { A: this.rules.uavActive('A'), B: this.rules.uavActive('B') },
      rows,
    });
  }

  // 呼叫一个连杀奖励。**唯一入口**：槽位是否就绪由 StreakBook 裁决，这里不重复判断 ——
  // 两边各判一次的话，"什么时候算就绪"就有了两个真相。
  callStreak(c, i) {
    const S = this.streak;
    S.calls++;
    const s = c.book.take(i);
    if (!s) {
      // 报了请求但拿不到槽。HUD 只让按就绪的那些，所以正常情况下这里该是 0；
      // 非 0 就是一个可归因的信号：客户端与服务端的连杀进度对不上（有一边的账本错了）。
      S.rejected++;
      if (S.why.length < 6) S.why.push({
        cid: c.cid, slot: i, progress: +c.book.progress.toFixed(2),
        costs: c.book.slots.map(x => x.cost), ready: c.book.slots.map(x => x.ready),
      });
      return null;
    }
    S.accepted++;
    S.byId[s.id] = (S.byId[s.id] || 0) + 1;
    this.events.push({ e: 'streak', cid: c.cid, team: c.pl.team, id: s.id, name: s.name });
    const pl = c.pl, game = this.game;

    if (s.id === 'uav') {
      this.rules.uavStart(pl.team);
      this.events.push({ e: 'announce', team: pl.team, text: 'UAV 已上线' });
    } else if (s.id === 'cluster') {
      // 弹幕中心 = 呼叫者**视线前方**一段距离的地面。单机那边是"玩家在地图上点一下"，
      // 联机这边省掉了那一步：选目标要占用屏幕和鼠标，而联机里你还在被人打。
      // 落点用权威端的 yaw 算 —— 客户端本地预测的 yaw 与权威差在一两拍内，屏幕上
      // 准心指哪儿弹就落哪儿。这是**输入**的差别（规则本身共用同一份 clusterStrike）。
      const fwd = pl.forward(new THREE.Vector3()); fwd.y = 0; fwd.normalize();
      const center = pl.pos.clone().addScaledVector(fwd, CLUSTER_RANGE);
      center.y = game.world.groundHeight(center.x, center.z, center.y + 1, 0.5);
      clusterStrike(game, this.rules.clock, center, pl, Math.atan2(fwd.z, fwd.x));
      this.events.push({ e: 'announce', team: pl.team, text: '集束空袭已呼叫' });
    } else if (s.id === 'wp') {
      this.rules.wpTicks = WP_SECONDS * 60;
      phosphorusSweep(game, this.rules.clock, pl, this.enemiesOf(pl.team));
      this.events.push({ e: 'announce', team: pl.team, text: '白磷弹投放' });
    } else if (s.id === 'sentry') {
      const fwd = pl.forward(new THREE.Vector3()); fwd.y = 0; fwd.normalize();
      const p = pl.pos.clone().addScaledVector(fwd, 2);
      if (game.world.lineBlocked(pl.pos.clone().setY(pl.pos.y + 0.5), p.clone().setY(p.y + 0.5))) {
        // 这里放不下：退还。单机那条路是"先检查后消耗"，而联机这边消耗已经发生 ——
        // 退还比"先检查后消耗"更稳：消耗点只有一个，不会出现"某天有人加了一条消耗路径
        // 忘了检查"，那种洞的症状是"放不下也扣掉了"。
        c.book.refund(s);
        this.events.push({ e: 'announce', team: pl.team, text: '无法在此部署' });
        return null;
      }
      const se = new Sentry(game, p, pl);
      se.netId = ++this.netIds;
      this.active.push(se);
      this.events.push({
        e: 'turret', netId: se.netId, kind: 'sentry', team: pl.team,
        x: se.pos.x, y: se.pos.y, z: se.pos.z, yaw: se.yaw, dur: SENTRY_SECONDS,
      });
    } else if (s.id === 'heli') {
      const h = new Heli(game, pl.team, pl);
      h.netId = ++this.netIds;
      this.active.push(h);
      this.events.push({
        e: 'turret', netId: h.netId, kind: 'heli', team: pl.team,
        ang: h.ang, dur: HELI_SECONDS, height: h.height, radius: h.radius,
      });
    }
    return s.id;
  }

  drainKillFeed() {
    const ev = this.game.events || [];
    if (!ev.length) return;
    for (const e of ev) {
      if (e.e === 'kill') {
        const victim = [...this.clients.values()].find(c => c.pl.name === e.victim);
        if (victim) { victim.dead = true; victim.respawnT = RESPAWN_DELAY; }
        this.events.push({ e: 'kill', killer: e.killer, victim: e.victim, weapon: e.weapon, head: e.head });
      }
    }
    ev.length = 0;
  }

  // 一份完整的下行快照：实体表 + 权威端玩法随机流的当前内部状态。
  // 客户端回滚重放时要把它拨回同一拍，否则重放多抽的随机数会让两边永久错开。
  snapshot() {
    // 盖章"这一刻的状态已经发给本房间每个人了"（net-server:broadcast 就是遍历 room.clients）。
    // 它是延迟补偿唯一**不可伪造**的上界：客户端不可能渲染过一份它还没收到的快照，
    // 所以 rewindTick 用它当窗的右端。盖在这里而不是 broadcast 里，是因为多房间时
    // 广播路径上有好几处，而"哪一拍的状态"只有这份对象自己知道。
    const tick = this.tick;
    for (const c of this.clients.values()) c.lastSnapSent = tick;
    return { tick, rngState: rng.state(), worldFlags: this.rules.worldFlags(), entities: this.snapshotEntities() };
  }

  snapshotEntities() {
    const out = [];
    for (const c of this.clients.values()) {
      const pl = c.pl, ws = pl.ws, w = ws.w;
      let flags = 0;
      if (pl.alive) flags |= FLAG.Alive;
      if (pl.crouchT > 0.5) flags |= FLAG.Crouch;
      if (pl.sprinting) flags |= FLAG.Sprint;
      if (ws.adsT > 0.5) flags |= FLAG.Ads;
      if (pl.onGround) flags |= FLAG.OnGround;
      if (pl.sliding) flags |= FLAG.Sliding;
      if (ws.state === 'reload') flags |= FLAG.Reloading;
      if (pl.game.time - ws.lastShot < 0.08) flags |= FLAG.Firing;
      out.push({
        id: c.cid, x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, yaw: pl.yaw, pitch: pl.pitch,
        hp: pl.hp, flags, weapon: weaponIndex(w ? w.id : 'm4'), mag: w ? w.mag : 0,
        phase: ws.bobPhase, vx: pl.vel.x, vz: pl.vel.z, team: teamIndex(pl.team), ack: c.ack, rep: c.rep,
      });
    }
    return out;
  }
}
