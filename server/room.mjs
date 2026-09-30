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
import { sanitizeLoadout, kitsOf } from '../js/loadout.mjs';
import { PoseRing, rewindTick } from './lagcomp.mjs';
import { MatchRules, StreakBook, UAV_SECONDS, WP_SECONDS, SENTRY_SECONDS, HELI_SECONDS, killScore, KILL_POINTS, onKillPerks, uavHints, maybeDropWeapon, pickupsExpire, pickupAction, flagsTick } from '../js/match-rules.js';
import { clusterStrike, phosphorusSweep } from '../js/combat.js';
import { Sentry, Heli, BOT_WEAPONS, randomAtt } from '../js/mp.js';
import { KILLSTREAKS, DEFAULT_STREAKS, BOT_NAMES } from '../js/data.js';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const SNAP_EVERY = 3;                       // 60Hz 模拟 / 3 = 20Hz 快照
export const RESPAWN_DELAY = 3.0;
// 每人最多攒几拍没消费的输入。正常客户端一渲染帧 flush 一次，1 秒也就 60 拍；
// 上限取 1 秒的量：再小就会在"客户端卡了一帧"时把中间拍丢掉，那等于服务端偷偷
// 少跑了几拍，客户端的预测只能靠下一次校正拽回来 —— 一种没人报错的橡皮筋。
export const INPUT_QUEUE = 60;
// 受伤事件的最小间隔（拍）。12 拍 = 0.2 s：正常人挨一枪到下一枪之间比这长；
// 而火焰那种每拍掉血的连续伤害会被压成 5 条/秒 —— 再密就不是"反馈"是刷屏了。
export const HURT_EVERY = 12;
// 直升机损伤状态（头顶血量标记 / 七成以下冒烟）的同步节奏（拍）。0.2 s 一条、只在变化时发：
// 那条百分比是给人看"我还在不在有效输出"的，不需要 60 Hz，而每拍发是纯浪费。
export const HELI_HP_EVERY = 12;

// cid 必须是"这台进程范围内唯一"，不能每个房间各自从 1 开始编号。
// 各房间自己数的话，房间 A 的 1 号和房间 B 的 1 号同名 —— 只看自己房间时不出事，
// 但任何拿 id 路由的地方（广播、回放、排障日志、跨房间的赛事统计）都会撞车，
// 而且探针也没法用"包里有没有出现陌生 id"来判断串门。串门的成因见 net-server:broadcast。
let NEXT_CID = 1;

// 连杀奖励的槽位表。玩家自带哪三项由他自己的选（js/menu.js:pickStreaks → profile.streaks，
// 搭 _id() 那一帧进座位），服务端**解析后回显**（welcome.streaks）—— 两端共读的仍是
// 服务端这一份，客户端从不自己另算一份槽位表。
// 这份表必须只列**完整实现**的项：能呼叫却生效不了（只发一条通知、实体只长在部署者
// 那台机器上）比根本没有这一项更糟 —— 别人会被一个自己看不见的东西打死。
export const STREAK_DEFS = DEFAULT_STREAKS.map(id => KILLSTREAKS.find(k => k.id === id)).filter(Boolean);
export const STREAK_IDS = STREAK_DEFS.map(d => d.id);
// 白名单重建，与 js/loadout.mjs 同一套哲学：非法项**换掉**而不是原样挂上、也不是整组拒绝。
// 恰好 3 项（按 3/4/5 就是三个槽）：报了 5 项只认前 3 个合法的，不足 3 项拿 DEFAULT_STREAKS
// 补齐。不写成"必须正好 3 项否则退回默认"：那样一个过期 id 会让玩家精心选的另外两项陪葬，
// 而症状只是"进局发现连杀换了"，没人会想到是那一格没过期。
// **返回前按 kills 升序**：StreakBook 的槽位、welcome 的回显、客户端按 3/4/5 报的下标
// 全靠同一个顺序对上。顺序各排各的症状是"按 3 出来的是另一个奖励"，不报错。
export const resolveStreaks = (ids) => {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const d = KILLSTREAKS.find(k => k.id === id);
    if (d && !out.includes(d) && out.length < 3) out.push(d);
  }
  for (const id of DEFAULT_STREAKS) {
    if (out.length >= 3) break;
    const d = KILLSTREAKS.find(k => k.id === id);
    if (d && !out.includes(d)) out.push(d);
  }
  return out.sort((a, b) => a.kills - b.kills);
};

// 集束空袭落点的合法距离上限。落点由玩家在屏幕上选（客户端发 {t:'streak'} 窄帧带上），
// 权威端只负责两件事：验它在不在这半径内、把地面高度算出来。取 200 m = 单机
// updateTargeting 的 raycast 上限（js/mp.js:428）—— 两端同一条上限，联机能点到的
// 就是单机能点到的，不会出现"联机的空袭能炸得更远"。
const CLUSTER_MAX = 200;

// Bot 的迷彩池（五格里两格 'none' = 一半不涂）。与 js/mp.js:101 的那一行同池。
const BOT_CAMOS = ['none', 'none', 'desert', 'woodland', 'digital'];

// 白磷弹持续灼烧的伤害方向（"从上方烧下来"）。做成常量而不是每拍 new 一个：它只被读。
const DOWN = new THREE.Vector3(0, -1, 0);

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
    // 这一局的**默认**连杀槽位表（没自带选单的客户端用它）。真人自带的三项在
    // addClient 里解析进各自的 c.streakDefs —— 每个人的槽位表以服务端解析结果为准，
    // welcome 回显同一份，两端才不会出现"服务端换一项客户端还显示旧的"（按了没反应）。
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
    // 白磷弹那一片火的**主人**：持续灼烧要对"他的敌人"生效（与单机 MPMatch 同一句）。
    // 只记一个 team 不够 —— 伤害的 attacker 要记成这个人，否则别人的击杀播报会缺失。
    this.wpOwner = null;
    // 击杀得分的随行数据。分数只有房间知道（killScore 在规则内核里，而 game.events 里的
    // kill 是 sim 层吐出来的、不带分），所以在这儿按"谁杀了谁"配一次对，drainKillFeed 取走。
    this.killExtra = [];
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
    // ── 两条"必须由房间提供的钩子" ──
    // 它们的存在形式是"浏览器侧没有它、服务端有它"，与 game.flashPlayer 的用法同构：
    // sim 层照旧按同一个函数写，区别只在有没有人能接住。
    //   ① onProjectile —— 投掷物**进世界**的那一刻编一条事件。以前下行协议里根本没有
    //      投掷物，于是别人扔的雷在你屏幕上不存在：你只看到血条突然掉一截，不知道是自己被炸了。
    //   ② flashPlayer —— 闪光弹对真人算出来的"闪多久"，必须发到那台机器上。
    //      以前服务端的 hud 是桩 ⇒ 真人被闪零效果，只有 Bot 会被 stun。
    this.game.onProjectile = (p) => this.announceProjectile(p);
    this.game.flashPlayer = (pl, dur) => {
      const c = this.byPlayer.get(pl);
      if (c) this.events.push({ e: 'flash', cid: c.cid, dur: +dur.toFixed(2) });
    };
    // 高度警觉：Bot 瞄上带这个技能的真人时（js/ai.js 问 game.highAlert），把"谁在哪瞄你"
    // 编成事件发过去 —— 与 flashPlayer 同一个形状：真人是另一台机器上的浏览器。
    this.game.highAlert = (pl, pos) => {
      const c = this.byPlayer.get(pl);
      if (c) this.events.push({ e: 'highAlert', cid: c.cid, x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) });
    };
    // 占领点：位置来自两端共读的地图（w.flagPos），这一侧只留**状态**（归属/进度）——
    // 3D 旗在客户端各建各的（js/mp.js:flagMesh），颜色按同步过去的归属刷。
    this.flags = (this.rules.mode === 'dom' && this.game.world.flagPos)
      ? this.game.world.flagPos.map((p, i) => ({ name: 'ABC'[i], pos: p.clone(), owner: null, prog: 0, capTeam: null }))
      : null;
    this.started = true;
    return this;
  }

  // 投掷物同步：一条事件带齐"起手状态"，客户端据此建一个**不开火的表现副本**（Projectile opts.dumb）。
  // 为什么不发逐拍位置：世界是同一份（js/maps.js + js/world.js 两端共用），物理是同一套
  // （固定 1/60），所以给一份起点+初速就够它自己飞完；发逐拍位置反而是 20Hz 的弹道，
  // 看起来像"手雷一跳一跳地飞"。
  // 为什么不起手位置也用"客户端自己算"：投掷的起点/初速来自两端各自的那一拍状态，
  // 差一两拍就是半个身位 —— 而雷是**看得见的**东西，半个身位一眼就看出来了。
  announceProjectile(p) {
    p.netId = ++this.netIds;
    const o = p.owner;
    this.events.push({
      e: 'proj', netId: p.netId, kind: p.type,
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
      fuse: Math.max(0, Math.round((p.fuse || 0) * 100) / 100),
      team: (o && o.team) || null,
    });
  }

  spawnPoint(team) {
    const w = this.game.world;
    // 自由混战没有"自己人的出生点"：所有人都从两边的点里挑（与单机 mp.js:121 同句）。
    const solo = team === 'P' || this.rules.ffa;
    const cands = [...(w.spawns[team] || []), ...(solo ? [...w.spawns.A, ...w.spawns.B] : [])];
    for (let i = 0; i < 6; i++) cands.push(w.randomWalkable());
    // Bot 也要算进"别贴着敌人出生"：房间里有 Bot 之后，只看 clients 的那份会把一堆 Bot
    // 摞在同一个出生点上（它们互相看不见对方，因为对方不在自己的敌情表里）。
    const foes = [...this.clients.values()].map(c => c.pl)
      .concat(this.game ? this.game.bots : [])
      .filter(p => p && p.alive && p.team !== team && p.pos);
    let best = cands[0], bs = -1;
    for (const c of cands) {
      let md = 1e9;
      for (const f of foes) md = Math.min(md, f.pos.distanceTo(c));
      const s = Math.min(md, 60) + rng.next() * 8;
      if (s > bs) { bs = s; best = c; }
    }
    const pos = best.clone();
    return { pos, yaw: Math.atan2(pos.x, pos.z) };
  }

  addClient({ name = '士兵', team = 'A', loadout = null, streaks = null, account = null } = {}) {
    const cid = NEXT_CID++;
    // 自由混战：每人一支独立"队"（与单机的 'P' / 'F'+i 同义）。这不是显示用的标签 ——
    // 友伤/闪光/白磷都按 team 判敌我，共用一支队的话同队的人互相打不掉血。
    if (this.rules.ffa) team = 'P' + cid;
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
    // 这个人自带的三项连杀（白名单重建过的那一份）。没带的用房间默认表兜底 ——
    // 兜底要走同一个闸门再解析一遍：房间默认表本身也可能不是正好 3 项。
    const sd = resolveStreaks(streaks && streaks.length ? streaks : this.streakDefs.map(d => d.id));
    this.game.entities.push(pl);
    if (!this.game.player) this.game.player = pl;   // 第一个人占住"本机玩家"那个老位置，
    // 其余的人靠 NetRoom.step 传的 pairs 列表被推进。
    const c = {
      cid, pl, name, team, loadout: lo, lastInput: decodeInputBits(0, 0), q: [], lastQueued: -1, ack: 0, rep: 0, got: false, dead: false, respawnT: 0,
      // —— 对局规则的簿记（每个人一份）——
      // streakDefs：他自带的三项。welcome 回显的就是这一份，HUD 按它画三个槽。
      // book：连杀槽。成本里含"强硬路线"的减 1 —— 那是装备带来的，所以要在装好装备之后
      // （pl.equip 已经在上面跑过）算，且中途换职业时要重算（js/match-rules.js:setDiscount）。
      // kills/deaths/score：记分板要读。以前这三个数只存在于单机的 pl.stats 上，
      // 联机侧没有任何地方记 —— 于是记分板是空的。
      streakDefs: sd,
      book: new StreakBook(sd, pl.hasPerk('hardline') ? 1 : 0),
      kills: 0, deaths: 0, score: 0, assists: 0,
      // 局内换配装：只**记住**，到重生那一刻才生效（与单机 MPMatch 的语义一致 ——
      // 死亡画面里换的装备在下次部署时到手）。以前联机侧连这个入口都没有，而暂停菜单
      // 照样弹"将在下次部署时生效"—— 那是一条没有人接的假反馈。
      nextLoadout: null,
      // 挨打的读数：hp 一掉就发一条 hurt 事件（带来源方向），客户端据此做方向指示、
      // 痛感音与镜头冲击。节奏由 lastHurtTick 限流（火焰那种每拍掉血的不能每拍发一条）。
      lastHp: 100, lastHurtTick: -999,
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
    // kits = 他手上那两把枪各自的配件/迷彩（js/loadout.mjs:kitsOf，与 welcome.others 同一张表）。
    // 远端模型按它建 —— 少了这一格的症状是"人人一把素枪"，而协议里根本没有这两个字段（差距 29）。
    this.events.push({ e: 'join', cid, name, team, pos: [sp.pos.x, sp.pos.y, sp.pos.z], yaw: sp.yaw, perks: lo.perks || [], kits: kitsOf(lo) });
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
    // ── 结算停摆 ── matchOver 下发之后，这一局在规则上已经结束；但房间要等
    // MATCH_RETURN_MS 才把人送回房间（resultDrain 在循环外面），这段窗口里 sim 若照旧
    // 推进，结算画面背后就还在开火、还在击杀、比分还在涨 —— 而玩家什么都改变不了。
    // 所以整局冻结：世界（Bot/投掷物/伤害/重生）一拍都不再走。快照却还得发 ——
    // 客户端的看门狗按"多久没收到快照"判下行断了，断流的话玩家看到的是
    // "连接丢失"而不是结算，所以这里只推拍号、不推世界。
    if (this.matchOverSent) { this.tick++; return; }
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
          // 局内换的配装到这一刻才生效（"死亡画面里选的装备，下次部署时到手"）。
          // 顺序讲究：先换枪再 respawn —— respawn 会 fullAmmo()/清状态，反过来的话
          // 新枪拿在手上、弹匣却是照旧枪补的。强硬路线的减 1 也要跟着重算（成本变了，
          // 客户端 HUD 上那三个槽的"要几杀"是同一份账）。
          if (c.nextLoadout) {
            c.loadout = c.nextLoadout; c.nextLoadout = null;
            c.pl.equip(c.loadout);
            c.book.setDiscount(c.pl.hasPerk('hardline') ? 1 : 0);
          }
          c.pl.respawn(sp.pos, sp.yaw);
          // 排队里那些"死亡期间产生"的输入必须丢掉：客户端在重生那一刻会把日记本清空
          // （服务端整体重置，旧日记本没有可比性），留着它们只会让接下来好几包的
          // ack 指到一个已经没有日记本的拍上。
          // （这里原来写着"实测 12 次窗口不够长全是这个"，那句归因错了：后来带着
          //  拍号读数重测，那些空窗全是"服务端刚好消费到我最新那一拍"的边界情形，
          //  与重生无关，已单独立账为 caughtUp。）
          c.q.length = 0;
          c.rep = 0;          // 客户端在重生那一刻清空日记本，重复计数也要跟着归零
          c.lastHp = c.pl.hp;
          this.game.dmgBy.delete(c.pl);      // 上一条命的伤害账不许算进下一条命的助攻
          this.events.push({
            e: 'respawn', cid: c.cid, pos: [sp.pos.x, sp.pos.y, sp.pos.z], yaw: sp.yaw,
            // 装备回声：让客户端手上那把枪与权威端一致 —— 换了职业时，这一格才是"生效"的证据；
            // 没换时它保证"对局中捡来的枪不跟到重生"这条规矩在联机侧同样成立。
            loadout: c.loadout,
            delay: RESPAWN_DELAY,
          });
        }
      }
    }
    this.game.step(DT, inputs[0] ? inputs[0].inp : decodeInputBits(0, 0), inputs.map(({ c, inp }) => ({ pl: c.pl, inp })));
    // Bot 的重生。单机那一半长在 MPMatch.update 的 respawns 队列里（js/mp.js:317，
    // 死了的人按 4 + rng.next()*2 秒排队），而联机权威端没有那份名单 ——
    // 少了它的症状是"Bot 死一个少一个"：一局打到后半段场上只剩真人，
    // 而那看起来像"对面不来了"，谁都不会把它当成 bug 去查。
    // 延迟刻意与单机同一条式子：抄成"更合理"的版本会让两端的手感分叉，且没人会去查。
    if (this.game) for (const b of this.game.bots) {
      if (b.alive) continue;
      if (b.__respawnT == null) b.__respawnT = 4 + rng.next() * 2;      // 刚死的这一拍排上队
      b.__respawnT -= DT;
      if (b.__respawnT <= 0) {
        const sp = this.spawnPoint(b.team);
        b.respawn(sp.pos, sp.yaw);
        b.__respawnT = null;
        this.game.dmgBy.delete(b);            // 上一条命的伤害账不许算进下一条命的助攻
      }
    }
    // 白磷弹的**持续灼烧**。这段以前只长在单机 js/mp.js:MPMatch.update 里：联机侧
    // rules.wpTicks 只被写、从来没被读，于是白磷弹在联机里只剩"一次 55 点 + 一层橙屏"。
    // 概率/伤害/目标集合刻意与单机那一行逐字一致（连 `rng.next() < dt*2` 都一样）——
    // 抄成"更合理"的版本会让两端的手感分叉，而那种差异没人会去查。走的也是同一条
    // 公共玩法流：客户端的流每份快照都会按 rngState 拨回来，所以这不产生分叉。
    if (this.rules.wpTicks > 0 && this.wpOwner) {
      for (const e of this.enemiesOf(this.wpOwner.team)) {
        if (rng.next() < DT * 2) e.takeDamage(6, { attacker: this.wpOwner, weapon: '白磷弹', explosive: true, dir: DOWN });
      }
    }
    // UAV 给持有方的 Bot 报点（幽灵除外）：规则在 js/match-rules.js:uavHints，单机跑的是
    // 同一份。skipTeam=null —— 服务端没有"我"，每队的 UAV 都喂自己的 Bot。
    uavHints(this.game, this.rules, this, DT, null, (team) => this.enemiesOf(team));
    // 占领点：规则在 js/match-rules.js:flagsTick（单机跑的是同一份）。换旗那一刻编
    // 两条定向播报 + 一条 flagCap（旗子的颜色要立刻翻，等下一班记分板太慢）。
    if (this.flags) {
      for (const cap of flagsTick(this.flags, this.rules, this.game.entities, DT).caps) {
        this.events.push({ e: 'flagCap', name: cap.f.name, owner: cap.team, prog: 0 });
        this.events.push({ e: 'announce', team: cap.team, to: 'own', text: `已占领 ${cap.f.name} 点` });
        this.events.push({ e: 'announce', team: cap.team, to: 'foes', text: `${cap.f.name} 点已失守` });
        for (const e of cap.inRange) {
          if (!e.alive || e.team !== cap.team) continue;
          const cc = this.byPlayer.get(e);
          if (cc) { cc.score += 200; this.events.push({ e: 'popup', cid: cc.cid, text: '+200 占领' }); }
          else if (e.isBot) e.score += 200;
        }
      }
    }
    // 地上的枪：过期收掉、谁够得着谁捡。规则在 js/match-rules.js（单机同一份）——
    // 这一侧裁完编事件，客户端照事件改自己那份（它只算提示、不许自己裁）。
    for (const p of pickupsExpire(this.game, DT)) {
      this.events.push({ e: 'pickupGone', id: p.netId, why: 'expire' });
    }
    for (const { c, inp } of inputs) {
      const r = pickupAction(this.game, c.pl, inp);
      for (const a of r.ammo) {
        this.events.push({ e: 'pickupAmmo', cid: c.cid, id: a.p.netId, weapon: a.p.weaponId, add: a.add, reserve: a.reserve });
      }
      if (r.swap) {
        // 换枪留下的旧枪**是真实体**：像击杀掉落一样编一条 'pickup'（客户端的 pickupTake
        // 处理只改手上的枪、不建模型 —— 两头都建的话地上会有两把）。
        const old = r.swap.old;
        const oldP = old ? this.game.spawnPickup(old.id, old.att, c.pl.pos, old.mag, old.reserve) : null;
        if (oldP) {
          oldP.netId = ++this.netIds;
          this.events.push({
            e: 'pickup', id: oldP.netId, weapon: oldP.weaponId, att: oldP.att,
            x: oldP.pos.x, y: oldP.pos.y, z: oldP.pos.z, mag: oldP.mag, reserve: oldP.reserve,
          });
        }
        this.events.push({
          e: 'pickupTake', cid: c.cid, id: r.swap.p.netId, idx: r.swap.idx,
          weapon: r.swap.st.id, att: r.swap.st.att, mag: r.swap.p.mag, reserve: r.swap.p.reserve,
        });
      }
    }
    // 连杀奖励生成的东西（哨戒机枪 / 武装直升机）：和 bot 一样是权威实体，每拍由这里推进。
    // 伤害是在**这一台**机器上算出来的（Sentry.update 里走 fireHitscan），这才是"权威"
    // 二字的全部含义 —— 客户端那边只有一个不开火的同形副本（dumb），它负责"看得见"。
    for (const a of this.active) a.update(DT);
    // 直升机的**损伤状态**同步（新产生那条差距：伤害与被击落在联机里是完整的 —— 那是这边
    // 裁的；缺的只是"还剩多少"这一路读数，哑副本没有血量可显示）。头顶的血量标记与七成以下
    // 的冒烟都靠这条事件（客户端的 Heli.update 跑的是同一段冒烟代码，喂进 hp 就会冒）。
    // 按变化发、每 HELI_HP_EVERY 拍最多一条：那条百分比是给人判断"我还在不在有效输出"的，
    // 0.2 s 的粒度足够，而每拍发是 60 条/秒的无用功。
    for (const a of this.active) {
      if (!a.isHeli || !a.alive) continue;
      const hp = Math.max(0, Math.round(a.hp));
      if (hp !== a.__hpSent && (a.__hpTick === undefined || this.tick - a.__hpTick >= HELI_HP_EVERY)) {
        a.__hpSent = hp; a.__hpTick = this.tick;
        this.events.push({ e: 'heliHp', netId: a.netId, hp, maxHp: Math.round(a.maxHp) });
      }
    }
    for (const a of this.active) {
      if (a.alive || a.__gone) continue;
      a.__gone = true;
      this.events.push({ e: 'gone', netId: a.netId, kind: a.isTurret ? 'sentry' : 'heli' });
      // 被**打**下来的那一种要另发两句话：自然到点离场不该被念成"xxx 被击落"。
      // （Heli.downed 只由 takeDamage 那条路置上，见 js/mp.js:Heli.destroy。）
      if (a.downed) {
        const kind = a.isTurret ? '哨戒机枪' : '武装直升机';
        // 这句不带 to：客户端按"是不是自己这一队"决定要不要在前面加"敌方"
        // （对面听到"敌方武装直升机被击落"，自己这边听到"武装直升机被击落"）。
        this.events.push({ e: 'announce', team: a.team, text: kind + '被摧毁' });
        const kc = a.killer ? this.byPlayer.get(a.killer) : null;
        if (kc) this.events.push({ e: 'popup', cid: kc.cid, text: '摧毁' + kind });
      }
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
      // 自由混战的赢家是**名次第一的那个人** —— 规则内核只说"结束了"（它不认人，
      // over.winner 是 null），名次在房间里才排得出来。
      if (this.rules.over) this.endMatch(this.rules.ffa ? this.ffaWinner() : this.rules.over.winner);
    }
    // 挨打要能被"看见"。本地玩家在联机里的血量是**快照直接覆盖**的（js/net/predict.mjs），
    // 全程不走 takeDamage ⇒ 方向指示、痛感音、镜头冲击四处全断（js/main.js 的死亡视角
    // 是唯一还有点反应的地方）。这里把"这一拍掉了血"编成一条事件，客户端据此补上那三件。
    // 限流是必需的：白磷弹/火每拍都在掉血，1:1 转发等于 60 条/秒的横幅。
    for (const c of this.clients.values()) {
      const hp = c.pl.hp;
      if (hp < c.lastHp) {
        if (this.tick - c.lastHurtTick >= HURT_EVERY) {
          c.lastHurtTick = this.tick;
          const a = c.pl.lastAttacker;
          const from = (a && a.pos) ? [a.pos.x, a.pos.y, a.pos.z] : null;
          this.events.push({ e: 'hurt', cid: c.cid, hp: Math.round(hp), from });
        }
      }
      c.lastHp = hp;
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

  // 与单机同一份语义（js/mp.js:MPMatch.enemiesOf）：**地面上的**敌对目标。
  // 直升机照样会被射线打得到，但不进"白磷弹烧谁 / 集束空袭炸哪儿"那类照地投放的集合。
  enemiesOf(team) {
    return this.game.entities.filter(e => e.alive && e.team !== team && e.pos && e.targetable !== false && !e.isHeli);
  }

  // ── 往对局里放一个 Bot（房主在房间屏上点的那个「+」）──
  // 它和 addClient 是并列的两条路：真人走「连接 → addClient」，Bot 走「房主名单 → spawnBot」。
  // 刻意**不给它造一个假的 client**：cid 是"这条连接"的编号，而 Bot 没有连接。造一个假 cid
  // 会让插值缓存、延迟补偿的 pose 环、战绩队列都开始给一个不存在的连接记账 —— 那类错误
  // 全是静默的（"某个人永远进不了记分板"）。所以它只有一个 netId（快照里的那个 id）。
  spawnBot({ name = 'Bot', team = 'A', skill = 1 } = {}) {
    if (!this.started) return null;
    const sp = this.spawnPoint(team);
    const wid = BOT_WEAPONS[Math.floor(rng.next() * BOT_WEAPONS.length) % BOT_WEAPONS.length];
    const def = MAPS[this.mapId] || {};
    const styles = def.styles || ['ally', 'enemy'];
    // 迷彩池与单机 addBot 同一份（js/mp.js:101 的 pick 那五格）：Bot 在联机里也是别人屏幕上的
    // 远端玩家，"本地 AI 是随机配件+随机迷彩"这一条对它同样成立（差距 29）。
    const bot = new Bot(this.game, {
      team, name, weaponId: wid, att: randomAtt(wid), difficulty: skill,
      pos: sp.pos, yaw: sp.yaw, role: 'mp',
      style: team === 'A' ? styles[0] : styles[1],
      camo: BOT_CAMOS[Math.floor(rng.next() * BOT_CAMOS.length) % BOT_CAMOS.length],
    });
    bot.isBot = true;
    // 同步 id 与真人的 cid **共用同一个分配器**。两边各起一套编号的话，某天一个 Bot 的 id
    // 撞上一个人的 cid，客户端会把两者认成同一个实体 —— 症状是"两个人共用一个位置"，
    // 而协议上没有任何一处会报错（快照里的 id 只是一个 u16）。
    bot.netId = NEXT_CID++;
    this.addBot(bot);
    return bot;
  }

  // 往房间里放一个 AI。当前联机对局里**不自动放**（真人对真人），但这条通道必须能跑：
  // 判据靠它验"群体警戒在房间里真的会扩散"，而"没人时拿 AI 填房"将来也走这里。
  addBot(bot) { this.game.addBot(bot); this.bots.set(bot, bot.group || null); return bot; }
  removeBot(bot) { this.game.removeBot(bot); this.bots.delete(bot); }

  // Bot 的快照行。它和真人那一份**必须长成一个形状**（同样的 25 字节、同样的字段顺序）：
  // 客户端只有一份 NetPlayer，按 id 取插值缓存，不区分对面是人还是 Bot。
  // 少了它的症状不是报错，是"房主加了一屋子 Bot，对面一个人也看不见" ——
  // 权威端的 Bot 照样在开枪、照样打死人（伤害是这一台机器算的），于是玩家被看不见的东西打死。
  botEntity(bot) {
    let flags = 0;
    if (bot.alive) flags |= FLAG.Alive;
    if (bot.crouchT > 0.5) flags |= FLAG.Crouch;
    // 开火位取 bot.flashT（js/ai.js:418 开火时置 0.05）：客户端那朵枪口火光就靠这一位。
    // 不给它的话，Bot 在你屏幕上是一边平移一边无声地让人掉血。
    if (bot.flashT > 0) flags |= FLAG.Firing;
    if (bot.mag < (bot.stats && bot.stats.mag || 30)) flags |= FLAG.Reloading;
    return {
      id: bot.netId, x: bot.pos.x, y: bot.pos.y, z: bot.pos.z, yaw: bot.yaw, pitch: bot.pitch || 0,
      hp: bot.hp, flags, weapon: weaponIndex(bot.weaponId || 'm4'), mag: bot.mag || 0,
      phase: (bot.anim && bot.anim.phase) || 0, vx: bot.vel.x, vz: bot.vel.z,
      team: teamIndex(bot.team), ack: 0, rep: 0,
    };
  }

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

  // 连杀槽进度的**即时**读数（差距 40 的那半条）。HUD 上"还差几杀"以前只随记分板走
  // （2 秒一份 = 0.5 Hz），而单机是每次击杀立刻充 —— 玩家看到的是自己刚杀了人、
  // 槽却过一两秒才动。charge / onDeath 每动一次账就发一条，客户端照它刷 HUD；
  // 记分板那份照旧带 sk（兜底：事件丢了也不会永远停在旧值上）。
  pushStreakCharge(c) {
    this.events.push({ e: 'streakCharge', cid: c.cid, sk: Math.floor(c.book.progress) });
  }

  // 击杀的规则侧：分数、连杀充能、首杀。表现走事件。
  // 这是 MPMatch.onKill 的**规则那一半**；分值问的是 js/match-rules.js:killScore。
  onKill(killer, victim, weapon, head, info) {
    // 结算之后的击杀一律不认（与单机 MPMatch 的 over 闸同一句语义）。撞线的那一杀
    // 在 endMatch 之前已经记完了账，这里拦的是**蜂鸣之后**的：同一拍里跟着死掉的第二个、
    // 以及 settle 窗口里任何一条还活着的伤害路径。
    if (this.matchOverSent) return;
    const R = this.rules;
    R.kills++;
    const kc = killer ? this.byPlayer.get(killer) : null;
    const vc = victim ? this.byPlayer.get(victim) : null;
    if (vc) { vc.deaths++; vc.book.onDeath(); this.pushStreakCharge(vc); }
    let pts = 0;
    if (killer && killer !== victim) {
      // 团队分：只有 tdm 按击杀加分，占领模式靠占点（与单机 MPMatch 的规则一致）
      if (!R.ffa && R.mode === 'tdm') R.addScore(killer.team, 1);
      const dist = (killer.pos && victim.pos) ? killer.pos.distanceTo(victim.pos) : 0;
      const sc = killScore({ head: !!head, melee: !!(info && info.melee), explosive: !!(info && info.explosive), dist, chain: R.killChain(), revenge: false });
      pts = sc.points;
      if (kc) {
        kc.kills++; kc.score += sc.points;
        // 自由混战的赢家是名次里的人（规则内核只认队伍）：杀到目标数在这儿收，
        // 与单机 MPMatch.onKill 的 `k >= scoreLimit → end(killer)` 同一条。
        if (R.ffa && kc.kills >= R.scoreLimit) this.endMatch(kc.cid);
        // 拾荒者 / 速愈：击杀生效的两个 Perk，规则在 js/match-rules.js:onKillPerks（单机
        // playerKill、客户端自己的击杀镜像用的是同一份）。这一侧只管权威端的血量与弹药；
        // 客户端屏幕上那份计数由它的击杀事件自己跑同一份 —— 各应用一次、互不覆盖。
        onKillPerks(killer);
        for (const i of kc.book.charge(1)) {
          R.charged++;
          this.events.push({ e: 'streakReady', cid: kc.cid, slot: i, id: kc.book.slots[i].id, name: kc.book.slots[i].name });
        }
        this.pushStreakCharge(kc);
      } else if (killer && killer.isBot) {
        // Bot 的账记在它自己身上（js/ai.js:51 那三个字段，单机记分板读的就是它们）。
        // 不记的话，Bot 杀了人却在自己那一行显示 0 —— 而队伍分是加了 1 的，
        // 于是"比分涨了但谁都没加分"，那正是这一局里有 Bot 时才看得见的错位。
        // 连杀槽不给：Bot 没有 StreakBook（那本账属于"真人按 3/4/5"那条链路）。
        killer.kills++; killer.score += sc.points;
      }
      if (!R.firstBlood) {
        R.firstBlood = true;
        if (kc) { kc.score += KILL_POINTS.firstBlood; this.events.push({ e: 'firstBlood', cid: kc.cid }); }
      }
    }
    // 助攻：账本在 game.dmgBy（HeadlessGame.onDamage 填）里，语义**与单机逐字对齐** ——
    // 单机是 `victim.dmgTaken.get(pl)`，即"打过就有"（不设伤害门槛）。门槛是个玩法决策，
    // 不该在联机这一侧偷偷加一条：加了的话"单机能拿助攻的场面联机拿不到"，而没人会当成 bug。
    // 击杀者本人不算助攻；已经死了的人也不算（单机那条路同样只看 dmgTaken）。
    if (victim) {
      const dm = this.game.dmgBy.get(victim);
      if (dm) {
        for (const [who, amt] of dm) {
          if (who === killer || !(amt > 0)) continue;
          const ac = this.byPlayer.get(who);
          if (!ac || !ac.pl.alive) continue;
          ac.assists++; ac.score += KILL_POINTS.assist;
          this.events.push({ e: 'assist', cid: ac.cid, victim: victim.name, victimCid: vc ? vc.cid : null });
          for (const i of ac.book.charge(0.5)) {
            R.charged++;
            this.events.push({ e: 'streakReady', cid: ac.cid, slot: i, id: ac.book.slots[i].id, name: ac.book.slots[i].name });
          }
          this.pushStreakCharge(ac);
        }
        this.game.dmgBy.delete(victim);
      }
    }
    const w = R.checkEnd();
    if (w) this.endMatch(w);
    // 掉落武器（规则与单机共用 js/match-rules.js:maybeDropWeapon）：地上那把枪是权威实体，
    // 事件带起手状态，客户端照它建一个哑模型（'pickup' 事件）—— 谁捡走由后续的权威裁决
    // 说了算（那一层见 NetRoom.step 里的 pickupTick）。
    const drop = maybeDropWeapon(this.game, victim);
    if (drop) {
      drop.netId = ++this.netIds;
      this.events.push({
        e: 'pickup', id: drop.netId, weapon: drop.weaponId, att: drop.att,
        x: drop.pos.x, y: drop.pos.y, z: drop.pos.z, mag: drop.mag, reserve: drop.reserve,
      });
    }
    this.killExtra.push({ killer: killer && killer.name, victim: victim && victim.name, pts });
    if (this.killExtra.length > 16) this.killExtra.splice(0, this.killExtra.length - 16);
  }

  endMatch(winner) {
    if (this.matchOverSent) return;
    this.matchOverSent = true;
    // 终局个人战绩**先于** matchOver 下发：结算面板要画得分/击杀/死亡，而权威端是这三个数
    // 的唯一来源（本地预测的 pl.stats.kills 在联机里根本不计数 —— 击杀是这边裁的）。
    // 带 cid 由客户端各取各的：定向在客户端筛，与 hurt / flash 同一条约定。
    for (const c of this.clients.values()) {
      this.events.push({ e: 'matchStats', cid: c.cid, k: c.kills, d: c.deaths, a: c.assists | 0, s: Math.round(c.score) });
    }
    this.events.push({ e: 'matchOver', winner });
    // 随手补一份**终局记分板**：平时它每 120 拍一班，撞线的那一杀往往落在两班之间 ——
    // 不补的话，结算面板上记分板的击杀列会比 matchStats 少最后一杀（相差的正是那一句）。
    this.pushBoard();
    // ── 战绩**不在这里落库**，只把名单和数字挂到队列上 ──
    // 这里跑在 60 拍/秒的权威循环里。写账号这一步以后完全可能（也理应）变成一次
    // 真的磁盘/网络调用 —— 那时这一行就会吃掉每一拍。所以规则是：
    // **这一侧只做 O(1) 的内存记账，真正的写由 net-server 在 tick 循环外面做。**
    // 加多少经验、单人上限多少，那一处定义在 accounts.addResult 里，这里不重复一份。
    const rows = [];
    for (const c of this.clients.values()) {
      const won = winner != null && (winner === c.team || winner === c.cid);
      if (!c.account) continue;                 // 访客没有档案可写（REQUIRE_ACCOUNT=0 时）
      rows.push({
        account: c.account,                       // 账号 key，不是呼号 —— 呼号可以改，key 不行
        // 胜负分与单机逐字同式（js/mp.js:end = score + 胜 500 / 平负 150）。少这一项的
        // 症状是"联机打一晚上涨的经验比单机慢一大截"，而没人会去核对那条式子。
        xp: Math.round(c.score) + (won ? 500 : 150),
        kills: c.kills, deaths: c.deaths,
        // winner 是队名（'A'/'B'）、cid（自由混战的那个人）或 null（时间到了没分出胜负）。
        // 写成"winner === null 就不给胜场"，而不是拿进球的队去猜 —— 猜的那一版会把
        // 每一局平局都记成一方的胜场，而表现只是"胜率慢慢偏高"，没人会去查。
        win: won,
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

  // 自由混战的名次（与单机 MPMatch.ranking 同一把尺：击杀优先、得分次之）。
  // 只有"人"才排得出名次 —— 这就是规则内核把 ffa 的赢家留成 null 的原因。
  ffaWinner() {
    const list = [...this.clients.values()].sort((a, b) => b.kills - a.kills || b.score - a.score);
    return list.length ? list[0].cid : null;
  }

  pushBoard() {
    const rows = [];
    for (const c of this.clients.values()) {
      // uav = 这个人自己的 UAV 还剩几秒。自由混战的队伍键是每人一支（'P'+cid），
      // 快照头那一位表达不了，只能随记分板走（2 秒一份 —— 30 秒的效果上够用）。
      rows.push({ cid: c.cid, name: c.name, team: c.team, k: c.kills, d: c.deaths, a: c.assists | 0, alive: !!c.pl.alive, s: Math.round(c.score), sk: Math.floor(c.book.progress), uav: Math.ceil(this.rules.uavLeft(c.pl.team) / 60) });
    }
    // Bot 也进记分板：它在这一局里真的在杀人、也真的在给队伍加分（onKill 那条路与真人同一句）。
    // 不列出来的话，房主加满一屋子 Bot 之后会看到一张只有真人的表，而比分却在涨 ——
    // 那种"分数对不上名单"谁都会先怀疑记分板算错了。
    if (this.game) for (const b of this.game.bots) {
      rows.push({ cid: b.netId, name: b.name, team: b.team, k: b.kills | 0, d: b.deaths | 0, a: 0, alive: !!b.alive, s: Math.round(b.score || 0), sk: 0, bot: true });
    }
    rows.sort((a, b) => b.k - a.k || b.s - a.s);
    // 名次是**排序结果**，不是自己算的位次：客户端数第几行就是第几名（排序在服务端做，
    // 两端各排一次的话"你的名次"会因为比较键不同而在两个地方不一样）。
    for (let i = 0; i < rows.length; i++) rows[i].rank = i + 1;
    this.events.push({
      e: 'board', tick: this.tick,
      scores: { A: Math.round(this.rules.scores.A), B: Math.round(this.rules.scores.B) },
      timeLeft: Math.round(this.rules.timeLeft()),
      uav: { A: this.rules.uavActive('A'), B: this.rules.uavActive('B') },
      // 占领点的归属/进度随记分板走（2 秒一份）；换旗那一拍另有 flagCap 事件顶着即时性
      flags: this.flags ? this.flags.map(f => ({ name: f.name, owner: f.owner, prog: Math.round(f.prog * 100) / 100 })) : undefined,
      rows,
    });
  }

  // ── 局内换配装（死亡画面 / 暂停菜单里的那一屏）──
  // 语义与单机 MPMatch.applyClass 一致：**记住，重生时生效**。所以这里只做两件事：
  // 过一遍入场用的同一个闸门（js/loadout.mjs，白名单重建），然后挂到 nextLoadout 上。
  // 不在这一步 equip：正在打的那条命装备不该突然换掉（那会与客户端的预测分叉一整条命）。
  applyLoadout(cid, raw) {
    const c = this.clients.get(cid);
    if (!c) return false;
    c.nextLoadout = sanitizeLoadout(raw);
    return true;
  }

  // 提前重生（死亡画面里按空格）。服务端只在"这个人确实躺着"时才认，而且只在
  // **倒计时的最后 0.1 s** 里认：早了不理（与单机同一条规矩 —— js/mp.js:319 是
  // `r.t <= 0 && keys.Space`，提前按没有用），到了就给，省掉"倒计时归零"到
  // "服务端下一次自动重生"之间那 0~1 拍的量化差。
  // 不写成"随便按就重生"：早重生是实打实的收益（少躺一会儿），这条闸门把它挡在服务端，
  // 而不是靠客户端自觉 —— 那种自觉在协议上不存在。
  requestRespawn(cid) {
    const c = this.clients.get(cid);
    // 结算停摆之后没有"下一条件"可部署：这一局的名单已经封盘（endMatch 落库的就是它）。
    if (!c || this.matchOverSent || c.pl.alive || c.respawnT > 0.12) return false;
    c.respawnT = 0;
    return true;
  }

  // 连杀呼叫的窄帧入口（{t:'streak'}，集束空袭的选点确认走这条路）。与 requestRespawn
  // 同一条纪律：只认"这条连接当前的座位"，死了的人叫不动（与输入字节那条路同一句 alive 闸门）。
  // 槽位就绪与否仍然只由 callStreak → StreakBook 裁决，这里不重复判断。
  requestStreak(cid, slot, target) {
    const c = this.clients.get(cid);
    if (!c || !c.pl.alive) return null;
    return this.callStreak(c, slot, target);
  }

  // 呼叫一个连杀奖励。**唯一入口**：槽位是否就绪由 StreakBook 裁决，这里不重复判断 ——
  // 两边各判一次的话，"什么时候算就绪"就有了两个真相。
  callStreak(c, i, target = null) {
    const S = this.streak;
    // 结算停摆之后呼叫一律不认：集束空袭按拍排程（时钟已停）投不下来，UAV 计时也不再走
    // —— 收下只会让"就绪槽"凭空消耗掉，玩家在下一局里莫名其妙少一个奖励。
    if (this.matchOverSent) return null;
    S.calls++;
    // 集束空袭必须带落点（走选点确认那条窄帧）。没带 / 落点不合法就拒，而且**槽不消耗** ——
    // 消耗发生在下面 book.take 里，这条提前返回保证"取消与乱按都扣不掉槽"（与单机同语义：
    // js/mp.js 的 useStreak 到确认那一刻才 consume）。旧的"按下即消耗"就是这么丢的槽。
    const want = c.book.slots[i];
    const dist = (target && Number.isFinite(target.x) && Number.isFinite(target.z))
      ? Math.hypot(target.x - c.pl.pos.x, target.z - c.pl.pos.z) : Infinity;
    if (want && want.id === 'cluster' && dist > CLUSTER_MAX) {
      S.rejected++;
      if (S.why.length < 6) S.why.push({ cid: c.cid, slot: i, reason: 'cluster-needs-target', dist: dist === Infinity ? null : +dist.toFixed(1) });
      return null;
    }
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
      // 弹幕中心 = 玩家**在屏幕上选的那一点**（与单机 updateTargeting 同语义）：
      // 选择来自客户端的确认帧，地面高度与成不成立由权威端算。
      const center = new THREE.Vector3(target.x, 0, target.z);
      center.y = game.world.groundHeight(center.x, center.z, pl.pos.y + 1, 0.5);
      // 投放轴线角与单机逐字一致（pl.yaw + π/2，js/mp.js:434）：两端各写一个"等价"
      // 式子的话，弹幕走向会不一样而没人会去量它（曾经这里写过 atan2(fwd.z, fwd.x)，
      // 与单机差一个镜像 —— 弹从反方向飞来）。
      clusterStrike(game, this.rules.clock, center, pl, pl.yaw + Math.PI / 2);
      this.events.push({ e: 'announce', team: pl.team, to: 'own', text: '集束空袭已呼叫' });
      // 「来袭」是**给对面**的那一句：单机里它是 announce('敌方空袭来袭！','立即寻找掩护')，
      // 联机以前只播"谁呼叫了什么"，被炸的那一方屏幕上没有任何预警。
      this.events.push({ e: 'announce', team: pl.team, to: 'foes', text: '空袭来袭，立即寻找掩护' });
    } else if (s.id === 'wp') {
      this.rules.wpTicks = WP_SECONDS * 60;
      this.wpOwner = pl;                       // 持续灼烧要认"谁放的这一片火"
      phosphorusSweep(game, this.rules.clock, pl, this.enemiesOf(pl.team));
      this.events.push({ e: 'announce', team: pl.team, to: 'own', text: '白磷弹投放' });
      this.events.push({ e: 'announce', team: pl.team, to: 'foes', text: '白磷弹来袭，离开火区' });
    } else if (s.id === 'sentry') {
      const fwd = pl.forward(new THREE.Vector3()); fwd.y = 0; fwd.normalize();
      const p = pl.pos.clone().addScaledVector(fwd, 2);
      if (game.world.lineBlocked(pl.pos.clone().setY(pl.pos.y + 0.5), p.clone().setY(p.y + 0.5))) {
        // 这里放不下：退还。单机那条路是"先检查后消耗"，而联机这边消耗已经发生 ——
        // 退还比"先检查后消耗"更稳：消耗点只有一个，不会出现"某天有人加了一条消耗路径
        // 忘了检查"，那种洞的症状是"放不下也扣掉了"。
        c.book.refund(s);
        // to:'self' —— 这句是**说给呼叫者自己**的失败原因，不是给别人看的战报。
        // 以前它按队广播，于是全场都收到"敌方 无法在此部署"（别人的失败被念成了敌情）。
        this.events.push({ e: 'announce', team: pl.team, to: 'self', cid: c.cid, text: '无法在此部署，位置被挡住' });
        return null;
      }
      const se = new Sentry(game, p, pl);
      se.netId = ++this.netIds;
      this.active.push(se);
      this.events.push({
        e: 'turret', netId: se.netId, kind: 'sentry', team: pl.team,
        x: se.pos.x, y: se.pos.y, z: se.pos.z, yaw: se.yaw, dur: SENTRY_SECONDS,
      });
      this.events.push({ e: 'announce', team: pl.team, to: 'self', cid: c.cid, text: '哨戒机枪已部署' });
    } else if (s.id === 'heli') {
      const h = new Heli(game, pl.team, pl);
      h.netId = ++this.netIds;
      this.active.push(h);
      this.events.push({
        e: 'turret', netId: h.netId, kind: 'heli', team: pl.team,
        ang: h.ang, dur: HELI_SECONDS, height: h.height, radius: h.radius,
        // 血量随出生一起给（之后的每一跳走 heliHp）：刚进场的人不该看到一架"100% 满血"
        // 的直升机 —— 它可能已经被打掉一半了，而下一班 heliHp 还没到。
        hp: Math.round(h.hp), maxHp: Math.round(h.maxHp),
      });
      this.events.push({ e: 'announce', team: pl.team, to: 'self', cid: c.cid, text: '武装直升机已就位' });
      // 对面那一句：单机是 announce('敌方武装直升机', '')（js/mp.js:255），联机原来完全没有 ——
      // 直升机在你头顶盘旋时，屏幕上不该什么提示都没有。
      this.events.push({ e: 'announce', team: pl.team, to: 'foes', text: '武装直升机来袭' });
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
        // 得分随行（上面 killExtra 那一段）。取不到就写 0，而不是猜一个数 ——
        // 播报里那个 "+N" 是要显示给人看的，宁可没有也不能错。
        const i = this.killExtra.findIndex(k => k.victim === e.victim && k.killer === e.killer);
        const extra = i >= 0 ? this.killExtra.splice(i, 1)[0] : null;
        this.events.push({ e: 'kill', killer: e.killer, victim: e.victim, weapon: e.weapon, head: e.head, pts: extra ? extra.pts : 0 });
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
    // Bot 排在真人**之后**：客户端按 id 建表，先到先得，把 Bot 放前面会让"开局那一帧"
    // 里真人的插入顺序跟着变（顺序本身不影响正确性，但每条日志与判据的读数会跟着跳）。
    if (this.game) for (const b of this.game.bots) if (b.netId) out.push(this.botEntity(b));
    return out;
  }
}
