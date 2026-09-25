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
import { FLAG, weaponIndex } from '../js/quant.js';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const SNAP_EVERY = 3;                       // 60Hz 模拟 / 3 = 20Hz 快照
export const RESPAWN_DELAY = 3.0;

// 上行按键位 → sim 的 input 形状。sim 要的是"这一 tick 的边沿"，
// 而网络输入本来就按 tick 打时间戳，所以边沿是显式的，不需要服务端再推。
export function decodeInputBits(keys, buttons) {
  return {
    fwd: !!(keys & 1), back: !!(keys & 2), left: !!(keys & 4), right: !!(keys & 8),
    sprint: !!(keys & 16), jumpPressed: !!(keys & 32), crouchPressed: !!(keys & 64),
    reloadPressed: !!(keys & 128), interact: !!(keys & 256), nvgPressed: !!(keys & 512),
    meleePressed: !!(keys & 1024), lethalPressed: !!(keys & 2048), tacticalPressed: !!(keys & 4096),
    fire: !!(buttons & 1), ads: !!(buttons & 2),
    firePressed: !!(buttons & 4), adsPressed: !!(buttons & 8),
    swapPressed: !!(buttons & 16), slot1: false, slot2: false,
    lethal: !!(buttons & 1), tactical: !!(buttons & 2), interactPressed: false,
    mdx: 0, mdy: 0,
  };
}

export class NetRoom {
  constructor(opts = {}) {
    this.id = opts.id || 'room0';
    this.mapId = opts.mapId || 'yard';
    this.seed = (opts.seed ?? 20260925) >>> 0;
    this.tick = 0;
    this.clients = new Map();                     // cid -> { cid, pl, name, lastInput, dead, respawnT }
    this.nextCid = 1;
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
    const cid = this.nextCid++;
    const sp = this.spawnPoint(team);
    const pl = new Player(this.game, { team, pos: sp.pos, yaw: sp.yaw, name });
    pl.equip(loadout || { primary: { id: 'm4', att: { optic: 'holo', under: 'vgrip' } }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: [] });
    this.game.entities.push(pl);
    if (!this.game.player) this.game.player = pl;   // 第一个人占住"本机玩家"那个老位置，
    // 其余的人靠 NetRoom.step 传的 pairs 列表被推进。
    const c = { cid, pl, name, team, lastInput: decodeInputBits(0, 0), dead: false, respawnT: 0 };
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
    c.lastInput = inp;
  }

  step() {
    if (!this.started) return;
    // 没有新包的客户端沿用上一份输入：掉包时人是站住的，而不是回零乱走
    const inputs = [...this.clients.values()].map(c => ({ c, inp: c.lastInput }));
    for (const { c, inp } of inputs) {
      if (!c.pl.alive) {
        c.respawnT -= DT;
        if (c.respawnT <= 0) {
          const sp = this.spawnPoint(c.pl.team);
          c.pl.respawn(sp.pos, sp.yaw);
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
        phase: ws.bobPhase, vx: pl.vel.x, vz: pl.vel.z,
      });
    }
    return out;
  }
}
