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
    this.events = [];                             // 待下发的游戏事件，排干即清
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
    const pl = new Player(this.game, { team, pos: sp.pos, yaw: sp.yaw, name });
    // 装备以服务端查表重建为准（为什么要拦、拦掉的是什么，见 js/loadout.mjs）。
    // 重建后这份要挂到人身上：welcome 得把同一个对象发回去，客户端按它配枪 —— 两边各自
    // 拿一份副本算 stats，就是"本地打中了、权威说没有"那种没人报错的分歧。
    const lo = sanitizeLoadout(loadout);
    pl.equip(lo);
    this.game.entities.push(pl);
    if (!this.game.player) this.game.player = pl;   // 第一个人占住"本机玩家"那个老位置，
    // 其余的人靠 NetRoom.step 传的 pairs 列表被推进。
    const c = { cid, pl, name, team, loadout: lo, lastInput: decodeInputBits(0, 0), q: [], lastQueued: -1, ack: 0, rep: 0, got: false, dead: false, respawnT: 0 };
    this.clients.set(cid, c);
    this.events.push({ e: 'join', cid, name, team, pos: [sp.pos.x, sp.pos.y, sp.pos.z], yaw: sp.yaw });
    return c;
  }

  removeClient(cid) {
    const c = this.clients.get(cid);
    if (!c) return;
    c.pl.alive = false;
    const i = this.game.entities.indexOf(c.pl);
    if (i >= 0) this.game.entities.splice(i, 1);
    this.clients.delete(cid);
    this.events.push({ e: 'leave', cid });
  }

  applyInput(cid, net) {
    const c = this.clients.get(cid);
    if (!c) return;
    const inp = decodeInputBits(net.keys, net.buttons);
    inp.mdx = net.mdx; inp.mdy = net.mdy;
    inp.tick = net.tick & 0xffff;
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
      // rep = "我这一拍没有你的新输入，又拿上一份折叠了一次"。
      // 只看 ack 客户端看不出这件事：它以为服务端折叠的序列就是我发到 ack 的那几拍，
      // 于是每包都被往前拽 rep 拍 —— 实测权威读数恰好等于我日记本第 start+2 拍的位置
      // （差 4 mm），稳态里 ~9% 的样本错 1~3 拍，撞墙时放大成 0.9 m 的硬拉。
      // 预测回滚的前提是"服务端折叠过的输入序列客户端能逐拍重建"，这一字节就是前提本身。
      // 只从收到过第一份输入起计数：新人进场那几拍服务端在拿全零输入空跑，
      // 那不是一次"重复"，而是一段客户端根本没有日记本的过去。
      // 计数刻意**不在拿到新输入时归零**，而归零点放在广播之后（见 snapshot()）：
      // 一个快照窗里 [重复,重复,新输入] 按"末尾连拍"定义报 0，可那两拍的位移实实在在进了
      // 权威状态，客户端却永远不会补 —— 实测 20/754 包如此，残差沿行进方向摊成 0.07~0.16 m。
      // 累计值到"自上次告知以来"正是客户端该补的数目；WS 走 TCP，每包必达，所以这个归零点
      // 不丢账，且上限就是 SNAP_EVERY 拍，u8 绰绰有余。
      if (!fromQ && c.got) c.rep = Math.min(255, c.rep + 1);
      c.lastInput = inp;
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
    const entities = this.snapshotEntities();
    // 打包即销账：rep 的含义是"自上次告知以来服务端替这个客户端多走的拍数"，告知之后客户端
    // 就不欠补演了。归零必须和广播绑死（全仓库只有 net-server.mjs 的 broadcast() 调这里，
    // 走 TCP 必达）；放回 step() 里"拿到新输入就归零"就退回成末尾连拍那个错定义。
    for (const c of this.clients.values()) c.rep = 0;
    return { tick: this.tick, rngState: rng.state(), worldFlags: 0, entities };
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
