// 权威对局房间：一份 HeadlessGame + 若干真人玩家，按固定 60Hz 步长推进。
//
// 这一层刻意不复用 js/mp.js 的 MPMatch —— 那个类把"本地玩家"当成 game.player，
// 还带着连杀/UAV/直升机这些要按联机规则重做的东西（见任务 P2）。
// 这里只做联网必需的最小集合：出生点、输入落地、快照、重生。
import * as THREE from 'three';
import { HeadlessGame, preloadMaterials } from './headless-game.mjs';
import { Player } from '../js/player.js';
import { MAPS } from '../js/maps.js';
import { rng } from '../js/rng.js';
import { FLAG, weaponIndex, teamIndex, unpackInput } from '../js/quant.js';
import { sanitizeLoadout } from '../js/loadout.mjs';
import { PoseRing, rewindTick } from './lagcomp.mjs';

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
    // 延迟补偿的读数（/healthz 会带出去）。它必须落在生产代码里而不是只在探针里数：
    // 这条链路**每一种失效方式都是静默的** —— 报值出窗 ⇒ 服务端一律拒绝 ⇒ 这个玩家永远
    // 没有补偿，不报错、不崩，只是"我明明打中了"。四个计数各指一种成因，修法完全不同：
    //   shots    裁决过多少发（0 = 这条链路根本没被走过，判据可能量的是空气）
    //   ok       真的按历史姿态判的；depth 是回溯深度（INTERP_DELAY 被改成 0 这类事故的读数）
    //   noView   客户端没报拍号（还没收到过快照 / 老客户端）—— 这是设计好的退化，不算故障
    //   stale    报了**非零**拍号却被闸门拒 —— 口径不合或客户端卡住；健康链路上必须为 0
    //   poseMiss 闸门放行了、姿态缓冲里却没有那一拍 —— 缓冲比窗短，症状是"延迟越大越打不中"
    this.lag = { shots: 0, ok: 0, noView: 0, stale: 0, poseMiss: 0, dMin: 0, dMax: 0, dSum: 0, staleWhy: [] };
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

  addClient({ name = '士兵', team = 'A', loadout = null } = {}) {
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
      return { c, inp };
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
    this.tick++;
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
    return { tick, rngState: rng.state(), worldFlags: 0, entities: this.snapshotEntities() };
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
