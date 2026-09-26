// 联机里的"别人的玩家"。
//
// 它只要满足 combat.js / ai.js 对实体的那套接口（pos / yaw / hp / alive / team /
// hitTest / takeDamage / chestPos / eyePos），就能直接插进 game.entities，
// 被本机玩家的子弹认到、被 HUD 认到。刻意不复用 ai.js 的 Bot —— 那个类带大脑，
// 而这里的人由另一台机器驱动，任何本地"决策"都会和权威端打架。
//
// 快照 20Hz、渲染 144Hz：不插值就只能看见 20Hz 的顿挫，所以渲染时刻统一往回退
// INTERP_DELAY，用两个相邻快照做插值，超出最新快照就用速度外推（有上限，防止
// 断线时人飞出去）。
import * as THREE from 'three';
import { createSoldierModel, animateSoldier, makeNameTag, applyFlashTex } from '../soldier.js';
import { WEAPONS } from '../data.js';
import { angleDiff, clamp, lerp, DEG } from '../util.js';
import { hitTestPlayer } from '../combat.js';
import { FLAG, WEAPON_IDS } from '../quant.js';

export const INTERP_DELAY = 0.10;                   // 渲染回退量，秒
export const MAX_EXTRAPOLATION = 0.15;              // 速度外推上限，秒

const _v = new THREE.Vector3();

export class NetPlayer {
  constructor(game, o = {}) {
    this.game = game;
    this.id = o.id;
    this.name = o.name || '玩家';
    this.team = o.team || 'A';
    this.isPlayer = false;
    this.targetable = true;
    this.pos = new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0);
    this.vel = new THREE.Vector3();
    this.yaw = o.yaw || 0; this.pitch = 0;
    this.hp = 100; this.maxHp = 100; this.alive = true;
    this.crouchT = 0; this.onGround = true; this.sprinting = false; this.sliding = false;
    this.revealT = 0; this.dmgT = 99; this.stealthy = false;
    this.radius = 0.35;
    this.lastAttacker = null;
    this.stats = { kills: 0, deaths: 0 };
    this.buf = [];                                  // 到达时间 → 快照，插值的原料
    this.renderT = performance.now() / 1000 - INTERP_DELAY;
    this.weaponId = WEAPON_IDS[o.weapon ?? 0] || 'm4';
    this.model = createSoldierModel(o.style || (this.team === 'A' ? 'ally' : 'enemy'), this.weaponId, {}, 'none');
    applyFlashTex(this.model);
    this.model.root.position.copy(this.pos);
    game.scene.add(this.model.root);
    this.tag = makeNameTag(this.name, this.team === 'A' ? '#6cf' : '#f77');
    this.model.root.add(this.tag);
    this.anim = { speed: 0, phase: 0, crouch: 0, pitch: 0, dead: false, deadT: 0, fallDir: 1, fallRoll: 0, recoil: 0 };
  }
  dispose() {
    this.game.scene.remove(this.model.root);
    this.buf.length = 0;
  }

  setName(name, team) {
    this.name = name;
    if (team) this.team = team;
    if (this.tag) {
      this.model.root.remove(this.tag);
      if (this.tag.material?.map) this.tag.material.map.dispose();
      if (this.tag.material) this.tag.material.dispose();
    }
    this.tag = makeNameTag(name, this.team === 'A' ? '#6cf' : '#f77');
    this.model.root.add(this.tag);
  }

  push(s, now) {
    this.buf.push({ t: now, s });
    if (this.buf.length > 24) this.buf.shift();
  }

  curEye() { return lerp(1.62, 1.05, this.crouchT); }
  eyePos(out) { return out.set(this.pos.x, this.pos.y + this.curEye(), this.pos.z); }
  chestPos(out) { return out.set(this.pos.x, this.pos.y + this.curEye() - 0.4, this.pos.z); }
  forward(out) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  // 命中盒与权威裁决**共用一处定义**（js/combat.js:hitTestPlayer）。本机这份只影响"打到了"
  // 的即时反馈（真值在服务端），但盒子必须是同一个：抄一份的症状是"改了常数之后本地反馈说中、
  // 权威说没中"，而两边都不报错。延迟补偿的缓冲里存的也正是这个函数的四个入参。
  hitTest(o, d, maxT) {
    return hitTestPlayer(this.pos.x, this.pos.y, this.pos.z, this.curEye(), o, d, maxT);
  }
  // 客户端不裁决伤害：只记下"我这一枪大概打掉多少"用于反馈，真值等服务器快照。
  takeDamage(dmg, info) {
    this.hp = Math.max(0, this.hp - dmg);
    this.dmgT = 0;
    if (info && info.attacker) this.lastAttacker = info.attacker;
    return false;
  }

  applyState(s) {
    this.hp = s.hp;
    this.alive = !!(s.flags & FLAG.Alive);
  }

  update(dt, now = performance.now() / 1000) {
    this.drives = (this.drives || 0) + 1;     // 插值有没有真的被驱动：没跑起来时 pos 会一直停在构造点
    const target = now - INTERP_DELAY;
    const buf = this.buf;
    let s;
    if (!buf.length) s = null;
    else if (target <= buf[0].t) s = buf[0].s;
    else if (target >= buf[buf.length - 1].t) {
      const last = buf[buf.length - 1];
      const dt2 = clamp(target - last.t, 0, MAX_EXTRAPOLATION);
      s = { ...last.s, x: last.s.x + last.s.vx * dt2, z: last.s.z + last.s.vz * dt2 };
    } else {
      let i = 0;
      while (i < buf.length - 1 && buf[i + 1].t < target) i++;
      const a = buf[i], b = buf[i + 1];
      const k = clamp((target - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
      s = {
        x: lerp(a.s.x, b.s.x, k), y: lerp(a.s.y, b.s.y, k), z: lerp(a.s.z, b.s.z, k),
        yaw: a.s.yaw + angleDiff(a.s.yaw, b.s.yaw) * k,
        pitch: lerp(a.s.pitch, b.s.pitch, k),
        hp: lerp(a.s.hp, b.s.hp, k), flags: k < 0.5 ? a.s.flags : b.s.flags,
        phase: k < 0.5 ? a.s.phase : b.s.phase,
        vx: lerp(a.s.vx, b.s.vx, k), vz: lerp(a.s.vz, b.s.vz, k),
        weapon: b.s.weapon,
      };
    }
    if (!s) return;
    this.hp = s.hp; this.alive = !!(s.flags & FLAG.Alive);
    this.crouchT = (s.flags & FLAG.Crouch) ? 1 : 0;
    this.sprinting = !!(s.flags & FLAG.Sprint);
    this.onGround = !!(s.flags & FLAG.OnGround);
    this.sliding = !!(s.flags & FLAG.Sliding);
    this.yaw = s.yaw; this.pitch = s.pitch;
    const px = this.pos.x, pz = this.pos.z;
    this.pos.set(s.x, s.y, s.z);
    this.vel.set(dt > 0 ? (this.pos.x - px) / dt : 0, 0, dt > 0 ? (this.pos.z - pz) / dt : 0);

    const wid = WEAPON_IDS[s.weapon ?? 0];
    if (wid && wid !== this.weaponId) this.swapWeapon(wid);

    const m = this.model.root;
    m.position.copy(this.pos);
    m.rotation.y = this.yaw + Math.PI;
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const a = this.anim;
    a.crouch = this.crouchT;
    a.pitch = -this.pitch;
    a.speed = spd;
    // 步态：优先用权威侧传来的相位（跑动时脚不会打滑），没有就按速度自己推
    if (s.phase !== undefined) { a.phase = s.phase; if (spd < 0.3) a.phase = 0; }
    else a.phase += dt * spd * 2.2;
    a.dead = !this.alive;
    if (!this.alive) { a.deadT += dt; } else a.deadT = 0;
    a.recoil = (s.flags & FLAG.Firing) ? 1 : 0;
    animateSoldier(this.model, a, dt);
    if (this.tag) this.tag.visible = this.alive;
    const flash = this.model.flash;
    if (flash && (s.flags & FLAG.Firing)) {
      flash.visible = true;
      flash.material.rotation = Math.random() * 6;
      this._flashT = 0.04;
    } else if (flash) {
      this._flashT = (this._flashT || 0) - dt;
      flash.visible = this._flashT > 0;
    }
  }
  swapWeapon(wid) {
    this.weaponId = wid;
    this.game.scene.remove(this.model.root);
    const style = this.modelStyle || (this.team === 'A' ? 'ally' : 'enemy');
    this.model = createSoldierModel(style, wid, {}, 'none');
    applyFlashTex(this.model);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw + Math.PI;
    this.game.scene.add(this.model.root);
    if (this.tag) this.model.root.add(this.tag);
  }
}
