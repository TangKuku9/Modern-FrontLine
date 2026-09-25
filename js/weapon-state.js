// 武器状态机 —— 权威侧。
//
// 这里只放"裁决玩法需要的量"：弹药、射速、状态机、散布、后坐力、命中判定。
// 判据是这条：**凡是通过 player.js:214-219 写进 game.camera 的量都属于这里**，
// 因为 weapons.js 的弹道是从 game.camera 取原点和方向的（cam.getWorldDirection），
// 而相机又是纯由模拟状态算出来的 —— 所以相机是派生状态，不是渲染状态。
// 视图模型（枪的位移、火光贴图、激光点、呼吸、换弹动画）在 js/viewmodel.js，
// 它按渲染帧跑，可以高于或低于模拟帧率，不参与裁决。
//
// 本文件不得 import gunmodel/materials/effects，也不得 new 任何 THREE 场景对象。
// 服务端跑这一份；js/weapons.js 只是给它加上视图模型影子。
import * as THREE from 'three';
import { computeStats } from './data.js';
import { fireHitscan, Projectile } from './combat.js';
import { clamp, damp, lerp, spreadDir, DEG, rng } from './util.js';

export class WeaponState {
  constructor(game, owner) {
    this.game = game; this.owner = owner;
    this.slots = [];
    this.cur = 0;
    this.loadoutVersion = 0;          // 视图模型据此判断要不要重建枪模
    this.state = 'idle'; this.stateT = 0; this.stateDur = 0;
    this.adsT = 0; this.cool = 0; this.triggerHeld = false; this.cycleT = 0;
    this.rp = 0; this.lastShot = 0; this.shotsInRow = 0;
    this.bobPhase = 0;                // 写进相机高度与横滚，所以是玩法量
    this.sprintT = 0; this.equipT = 1;
    this.grenade = null; this.cookT = 0; this.cooking = false;
    this.reloadStage = 0;
    this.meleeHit = false;
    // 表现事件的出口。没接视图模型（权威服务端）时它是 null，
    // 于是 fire() 连事件对象都不构造 —— 既不会攒出一个无限增长的队列，
    // 也不会在服务端为每次开火分配数组。
    this.sink = null;
    this.replay = false;              // 客户端回滚重放中：见 update() 的注释
    this.aimAccum = new THREE.Vector2();  // 攒给视图模型做摆动用的视线位移
  }
  dispose() { this.sink = null; }

  // 纯数据弹匣槽：几何/材质/精灵都在 Viewmodel 里按同样的 cfg 另建一份
  makeSlot(cfg) {
    const stats = computeStats(cfg.id, cfg.att || {});
    return { id: cfg.id, att: cfg.att || {}, camo: cfg.camo, stats, mag: stats.mag, reserve: stats.reserve };
  }
  setLoadout(list) {
    this.slots = list.map(c => this.makeSlot(c));
    this.cur = 0;
    this.loadoutVersion++;
    this.state = 'switch'; this.stateT = 0; this.stateDur = 0.5;
  }
  replaceSlot(i, cfg, mag, reserve) {
    const s = this.makeSlot(cfg);
    if (mag !== undefined) { s.mag = mag; s.reserve = reserve; }
    this.slots[i] = s;
    this.cur = i;
    this.loadoutVersion++;
    this.state = 'switch'; this.stateT = 0; this.stateDur = 0.45;
  }
  get w() { return this.slots[this.cur]; }
  switchTo(i) {
    if (i === this.cur || !this.slots[i] || this.state === 'throw') return;
    this.cur = i;
    this.state = 'switch'; this.stateT = 0;
    this.stateDur = this.owner.hasPerk('amped') ? 0.3 : 0.55;
    this.game.audio.ui('equip');
    this.adsT = Math.min(this.adsT, 0.3);
  }
  canAct() { return this.state === 'idle'; }
  startReload() {
    const w = this.w;
    if (!w || this.state !== 'idle' || w.mag >= w.stats.mag || w.reserve <= 0) return;
    this.state = 'reload'; this.stateT = 0; this.reloadStage = 0;
    let t = w.stats.reload;
    if (this.owner.hasPerk('sleight')) t *= 0.65;
    if (w.stats.type === 'launcher' && this.owner.hasPerk('amped')) t *= 0.6;
    if (w.stats.shellReload) t = w.stats.reload * (this.owner.hasPerk('sleight') ? 0.65 : 1);
    this.stateDur = t;
  }
  refill(frac = 1) {
    for (const s of this.slots) s.reserve = Math.min(s.stats.reserve * 2, s.reserve + Math.ceil(s.stats.reserve * frac));
  }
  fullAmmo() { for (const s of this.slots) { s.mag = s.stats.mag; s.reserve = s.stats.reserve; } }

  update(dt, input, opts = {}) {
    const game = this.game, pl = this.owner, w = this.w;
    // replay：客户端回滚重放。这一拍**所有自身状态与随机数都照原样推进**，
    // 只有外部出口关掉（见 fire/doMelee/releaseGrenade）。
    // 为什么不能整段跳过开火（我最初就是这么写的，错得很难看）：
    // 后坐横向 side 和散布 spreadDir 各抽一次玩法随机流，并写进 pl.yaw / pl.pitch / this.rp。
    // 跳过 → 重放窗口里那几发的后坐在回滚后凭空消失，每收一份快照就"吃一次枪口"，
    // 而且两边的随机流消耗次数从此差 N 次，之后每一发弹道都在不同的分支上。
    const replay = this.replay = !!opts.replay;
    if (!w) return;
    const st = w.stats;
    // 视线位移只喂视图模型，重放时不要再攒第二遍
    if (!replay) { this.aimAccum.x += input.mdx; this.aimAccum.y += input.mdy; }
    this.stateT += dt;
    this.cool -= dt; this.cycleT -= dt;
    const sprinting = pl.sprinting;
    // 状态机
    if (this.state === 'reload') {
      const k = this.stateT / this.stateDur;
      if (st.shellReload) {
        if (this.stateT >= this.stateDur) {
          w.mag++; w.reserve--; game.audio.reload('shell');
          if (w.mag < st.mag && w.reserve > 0 && !input.fire) { this.stateT = 0; }
          else { this.state = 'idle'; game.audio.reload('bolt'); }
        }
      } else {
        if (this.reloadStage === 0 && k > 0.2) { this.reloadStage = 1; game.audio.reload('out'); }
        if (this.reloadStage === 1 && k > 0.62) { this.reloadStage = 2; game.audio.reload('in'); }
        if (this.stateT >= this.stateDur) {
          const need = st.mag - w.mag, take = Math.min(need, w.reserve);
          w.mag += take; w.reserve -= take;
          this.state = 'idle';
          if (st.fire === 'bolt' || st.type === 'lmg') game.audio.reload('bolt');
        }
      }
    } else if (this.state === 'switch' || this.state === 'melee' || this.state === 'throw' || this.state === 'use') {
      if (this.state === 'melee' && !this.meleeHit && this.stateT > 0.12) { this.meleeHit = true; this.doMelee(); }
      if (this.state === 'throw' && this.grenade && this.stateT > 0.22) this.releaseGrenade();
      if (this.stateT >= this.stateDur) this.state = 'idle';
    }
    // 瞄准
    const wantAds = input.ads && !sprinting && !['switch', 'melee', 'throw', 'cook', 'use'].includes(this.state);
    this.adsT = clamp(this.adsT + (wantAds ? dt / st.ads : -dt / (st.ads * 0.8)), 0, 1);
    this.sprintT = damp(this.sprintT, sprinting ? 1 : 0, 10, dt);
    // 走路摆动：写进相机 y 与横滚（player.js:214/219），所以归玩法管
    const spd = Math.hypot(pl.vel.x, pl.vel.z);
    if (pl.onGround) this.bobPhase += dt * spd * (pl.sprinting ? 1.5 : 1.9);
    // 射击
    const semi = st.fire !== 'auto';
    const fireInput = input.fire && (!semi || !this.triggerHeld);
    if (input.fire && sprinting) pl.cancelSprint();
    if (fireInput && this.sprintT < 0.35 && this.state === 'idle' && this.cool <= 0 && this.cycleT <= 0 && !pl.sliding) {
      if (w.mag > 0) this.fire();
      else if (!this.triggerHeld) { game.audio.empty(); if (w.reserve > 0) this.startReload(); }
    } else if (fireInput && this.state === 'reload' && st.shellReload && w.mag > 0) {
      this.state = 'idle';
    }
    this.triggerHeld = input.fire;
    if (w.mag === 0 && this.state === 'idle' && w.reserve > 0 && this.cool < -0.15) this.startReload();
    // 后坐力恢复
    // 用 sim 时间而不是 performance.now()：墙钟会让这个分支在两次相同输入下走不
    // 同的路径，连带把随机流的消耗次数错开，服务端与客户端就无法复现同一条轨迹。
    // 语义等价：原阈值 120ms → 0.12s。
    if (this.game.time - this.lastShot > 0.12) { this.rp = damp(this.rp, 0, 4, dt); this.shotsInRow = 0; }
    // 手雷烹饪
    if (this.cooking) {
      this.cookT += dt;
      if (this.grenade && this.grenade.type === 'frag' && this.cookT >= 3.0) { this.cooking = false; this.releaseGrenade(true); }
    }
    // 高倍镜遮罩状态：main.js:422/425 用它压掉 NVG 与热成像，那是玩法可见性，不是画面
    const scoped = (st.optic === 'sniper' || st.optic === 'acog' || st.optic === 'thermal') && this.adsT > 0.85;
    game.scopeState = scoped ? st.optic : null;
  }

  currentSpread() {
    const pl = this.owner, st = this.w.stats;
    const spd = Math.hypot(pl.vel.x, pl.vel.z);
    let hip = st.hip * (1 + spd / 6 * 0.6) * (pl.onGround ? 1 : 2.2) * (pl.crouchT > 0.5 ? 0.8 : 1);
    hip *= 1 + Math.min(this.shotsInRow, 10) * 0.03;
    const ads = st.adsSpread * (1 + spd / 6 * (st.type === 'sniper' ? 6 : 1.2));
    return lerp(hip, ads, this.adsT);
  }

  fire() {
    const game = this.game, pl = this.owner, w = this.w, st = w.stats;
    const replay = this.replay;
    w.mag--;
    this.cool = 60 / st.rpm;
    if (st.fire === 'bolt' || st.fire === 'pump') { this.cycleT = 60 / st.rpm; }
    this.lastShot = this.game.time;
    this.shotsInRow++;
    if (!replay) pl.stats.shots++;
    // 射线来自"这个玩家自己的视点与视线"，不是 game.camera —— 服务端同时跑 N 个
    // 玩家时那块相机不存在，而且它本来就是本机玩家的派生量（player.js:eyePoint）
    const origin = pl.eyePoint(new THREE.Vector3());
    const fwd = pl.aimDir(new THREE.Vector3());
    // 没有视图模型（权威服务端）或正在重放时，一个表现事件都不构造
    const wantFx = !replay && !!this.sink;
    if (st.projectile === 'rocket') {
      // 抛射物的位置由服务端算，客户端自己那份要靠下行事件同步（P2）；
      // 重放时绝对不能再挤出一枚，那会有两枚同 id 的火箭各炸各的。
      if (!replay) game.projectiles.push(new Projectile(game, 'rocket', origin.clone().addScaledVector(fwd, 0.8), fwd.clone().multiplyScalar(55), pl, 10));
    } else {
      // 散布一定要算、随机数一定要抽，哪怕这一发不去打世界
      const spread = this.currentSpread() * DEG * 0.5;
      let anyHit = false, kill = false, head = false;
      const tracers = wantFx ? [] : null;   // 交给视图模型画：命中点是权威结果，线段端点不是
      for (let i = 0; i < st.pellets; i++) {
        const d = spreadDir(fwd, spread, new THREE.Vector3());
        if (replay) continue;
        const r = fireHitscan(game, pl, origin, d, st, st.name);
        if (r.ent) { anyHit = true; if (r.killed) kill = true; if (r.part === 'head') head = true; }
        if (wantFx && i < 3 && (this.shotsInRow % 2 === 1 || st.pellets > 1 || st.fire !== 'auto')) tracers.push(r.point.clone());
      }
      if (anyHit) { pl.stats.hits++; game.hud.hitmarker(kill, head); game.audio.hit(kill, head); }
      // 开火事件无条件发：枪口火光、抛壳、后坐顶枪都靠它，tracers 只是其中可选的一段
      if (wantFx) this.sink({ kind: 'shot', tracers, fwd, recoilV: st.recoilV, suppressed: st.suppressed, flashHide: st.flashHide, shell: st.type !== 'launcher' && st.type !== 'shotgun' && st.fire !== 'pump' });
    }
    game.audio.shot(st.sound, null, st.suppressed);
    if (wantFx && st.fire === 'bolt') this.sink({ kind: 'sfx', name: 'bolt', at: 0.25 });
    if (wantFx && st.fire === 'pump') this.sink({ kind: 'sfx', name: 'shell', at: 0.2 });
    game.makeNoise(pl.pos, st.suppressed ? 12 : 70, pl.team);
    if (!st.suppressed) pl.revealT = 1.5;
    // 后坐力：pitch/yaw/punch 进相机，属于裁决；vmKick/vmRot 只动枪模，属于视图模型
    const adsMul = lerp(1, 0.75, this.adsT) * (pl.crouchT > 0.5 ? 0.85 : 1);
    const kick = st.recoilV * 0.55 * DEG * adsMul;
    // 横向抖动刻意偏向一侧（-0.4 而非 -0.5），且走玩法随机流：它直接写进 pl.yaw
    const side = (rng.next() - 0.4) * st.recoilH * 0.5 * DEG * adsMul;
    pl.pitch += kick * 0.55;
    this.rp += kick * 0.45;
    pl.yaw -= side;
    pl.punch(st.recoilV * 0.004);
  }
  doMelee() {
    const game = this.game, pl = this.owner;
    if (this.replay) return;      // 命中已经在真那一拍裁过了，meleeHit 由 journal 退回
    const fwd = pl.aimDir(new THREE.Vector3());
    const eye = pl.eyePoint(new THREE.Vector3());
    let best = null, bd = 2.3;
    for (const e of game.entities) {
      if (!e.alive || e === pl || e.team === pl.team) continue;
      const c = e.chestPos(new THREE.Vector3());
      const d = c.distanceTo(eye);
      if (d > bd) continue;
      const dir = c.clone().sub(eye).normalize();
      if (dir.dot(fwd) < 0.6) continue;
      best = e; bd = d;
    }
    if (best) {
      const killed = best.takeDamage(135, { attacker: pl, dir: fwd, weapon: '近战', melee: true });
      game.hud.hitmarker(killed, false); game.audio.hit(killed);
      game.effects.blood(best.chestPos(new THREE.Vector3()), fwd, false);
    } else {
      const hit = game.world.raycast(eye, fwd, 1.8);
      if (hit) { game.effects.impact(hit.point, hit.normal, hit.box.mat || 'concrete'); game.audio.click(700, 0.08, 0.4); }
    }
  }
  melee() {
    if (this.state !== 'idle' && this.state !== 'reload') return;
    this.state = 'melee'; this.stateT = 0; this.stateDur = 0.55; this.meleeHit = false;
    this.game.audio.whoosh && this.game.audio.click(500, 0.12, 0.25);
  }
  // 投掷
  beginThrow(kind, id) {
    const pl = this.owner;
    const inv = kind === 'lethal' ? pl.lethal : pl.tactical;
    if (!inv || inv.count <= 0 || (this.state !== 'idle' && this.state !== 'reload')) return false;
    if (id === 'stim') {
      inv.count--; pl.hp = pl.maxHp; pl.dmgT = 99;
      this.state = 'use'; this.stateT = 0; this.stateDur = 0.5;
      this.game.audio.tone(900, 0.15, 0.15, 'triangle'); this.game.hud.popup('兴奋剂 生命已恢复', '#7cf');
      return false;
    }
    inv.count--;
    this.grenade = { type: id };
    this.cooking = true; this.cookT = 0;
    this.state = 'cook'; this.stateT = 0;
    this.game.audio.click(2000, 0.05, 0.3);
    return true;
  }
  endThrow() {
    if (this.state === 'cook' && this.grenade) {
      this.cooking = false;
      this.state = 'throw'; this.stateT = 0; this.stateDur = this.owner.hasPerk('amped') ? 0.4 : 0.6;
    }
  }
  releaseGrenade(inHand = false) {
    const g = this.grenade; if (!g) return;
    this.grenade = null;
    const game = this.game, pl = this.owner;
    const fwd = pl.aimDir(new THREE.Vector3());
    const fuseBase = { frag: 3.0, semtex: 2.0, molotov: 99, flash: 1.4, smoke: 1.3 }[g.type];
    const fuse = g.type === 'frag' ? Math.max(0.05, fuseBase - this.cookT) : fuseBase;
    const pos = pl.eyePoint(new THREE.Vector3()).addScaledVector(fwd, 0.4).add(new THREE.Vector3(0, -0.1, 0));
    const vel = inHand ? new THREE.Vector3() : fwd.clone().multiplyScalar(17).add(new THREE.Vector3(0, 3.5, 0)).add(pl.vel.clone().multiplyScalar(0.5));
    if (!this.replay) game.projectiles.push(new Projectile(game, g.type, pos, vel, pl, fuse));
    if (inHand) { this.state = 'idle'; }
  }
}
