// 第一人称视图模型 —— 渲染侧影子。
//
// 它读 WeaponState 的标量，写 three 场景图，按**渲染帧**更新而不是按模拟 tick，
// 所以 144Hz 屏上枪的摆动/后坐回落是 144Hz 的，而弹道仍然是 60Hz 权威的。
// 判据反过来也成立：这里任何量都不许回流到 WeaponState 或相机
// （唯一例外是 game.scopeState，它已经挪到 WeaponState 里算了）。
import * as THREE from 'three';
import { buildGun, buildArms } from './gunmodel.js';
import { mat } from './materials.js';
import { clamp, damp, lerp } from './util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class Viewmodel {
  constructor(game, owner, ws) {
    this.game = game; this.owner = owner; this.ws = ws;
    this.sway = new THREE.Vector2();
    this.vmKick = 0; this.vmRot = 0; this.flashT = 0;
    this.fx = [];                     // 权威侧开火时经 sink 回调投递进来，每渲染帧取干
    this.sfx = [];                    // 延迟音效改用渲染时钟计时，不再用 setTimeout 挂墙钟
    ws.sink = (e) => { this.fx.push(e); };
    this.pivot = new THREE.Group();
    game.vmScene.add(this.pivot);
    this.holder = new THREE.Group();
    this.pivot.add(this.holder);
    this.seenVersion = -1;
    this.groups = [];
  }
  dispose() {
    this.ws.sink = null;
    this.game.vmScene.remove(this.pivot);
    for (const s of this.groups) if (s && s.laserDot) this.game.scene.remove(s.laserDot);
    this.groups = [];
  }

  build(cfg) {
    const stats = cfg.stats;
    const info = buildGun(cfg.id, cfg.att || {}, cfg.camo || 'none', { noShadow: true });
    const sleeve = mat(this.game.playerSleeve || 'fab_ally');
    const arms = buildArms(info, sleeve);
    const g = new THREE.Group();
    g.add(info.group); g.add(arms);
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.game.effects.texFlash, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(3, 2.2, 1.4) }));
    flash.scale.setScalar(stats.suppressed ? 0.08 : 0.22); flash.visible = false;
    info.muzzle.add(flash);
    let laserDot = null;
    if (stats.laser) {
      laserDot = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.5, 0.5) }));
      this.game.scene.add(laserDot); laserDot.visible = false;
    }
    return { info, group: g, flash, laserDot };
  }
  syncLoadout() {
    if (this.ws.loadoutVersion === this.seenVersion) return;
    this.seenVersion = this.ws.loadoutVersion;
    for (const s of this.groups) { if (s) { this.holder.remove(s.group); if (s.laserDot) this.game.scene.remove(s.laserDot); } }
    this.groups = this.ws.slots.map(c => c ? this.build(c) : null);
  }
  showCurrent() {
    this.syncLoadout();
    this.groups.forEach((s, i) => {
      if (!s) return;
      if (i === this.ws.cur) { if (!s.group.parent) this.holder.add(s.group); }
      else if (s.group.parent) this.holder.remove(s.group);
      if (s.laserDot) s.laserDot.visible = false;
    });
  }
  muzzleWorld(out) {
    const cur = this.groups[this.ws.cur];
    this.pivot.updateMatrixWorld(true);
    cur.info.muzzle.getWorldPosition(out);
    // 视图模型坐标系与世界同步（pivot = 相机变换）
    return out;
  }

  // 每渲染帧一次
  update(dt) {
    const game = this.game, ws = this.ws, w = ws.w;
    if (!w) return;
    this.syncLoadout();
    this.showCurrent();
    const cur = this.groups[ws.cur];
    if (!cur) return;
    const st = w.stats;
    // 取走权威侧攒下的表现事件：枪口火光、曳光、抛壳、顶枪
    if (this.fx.length) {
      for (const e of this.fx) {
        if (e.kind === 'shot') {
          this.flashT = 0.035;
          const mw = this.muzzleWorld(new THREE.Vector3());
          if (!e.suppressed) game.effects.flashLight(mw, 0xffb060, e.flashHide ? 1.5 : 4, 0.05, 8);
          for (const p of e.tracers) game.effects.tracer(mw.clone().addScaledVector(e.fwd, 0.5), p, [1.4, 1.0, 0.55]);
          if (e.shell) {
            const right = _v2.set(1, 0, 0).applyQuaternion(game.camera.quaternion);
            game.effects.shell(mw.clone().addScaledVector(e.fwd, -0.4).addScaledVector(right, 0.05), right);
          }
          this.vmKick += 0.02 + e.recoilV * 0.012;
          this.vmRot += 0.02 + e.recoilV * 0.02;
        } else if (e.kind === 'sfx') {
          this.sfx.push({ t: e.at, name: e.name });
        }
      }
      this.fx.length = 0;
    }
    for (let i = this.sfx.length - 1; i >= 0; i--) {
      this.sfx[i].t -= dt;
      if (this.sfx[i].t <= 0) { game.audio.reload(this.sfx[i].name); this.sfx.splice(i, 1); }
    }
    this.vmKick = damp(this.vmKick, 0, 14, dt);
    this.vmRot = damp(this.vmRot, 0, 10, dt);
    this.flashT -= dt;
    cur.flash.visible = this.flashT > 0;
    if (cur.flash.visible) cur.flash.material.rotation = Math.random() * 6;

    const pl = this.owner, cam = game.camera;
    this.pivot.position.copy(cam.position);
    this.pivot.quaternion.copy(cam.quaternion);
    game.vmCamera.position.copy(cam.position);
    game.vmCamera.quaternion.copy(cam.quaternion);
    // 摆动：视线位移由权威侧按拍攒过来，这里一次取干，总量与帧率无关
    const aim = ws.aimAccum;
    this.sway.x = damp(this.sway.x, clamp(-aim.x * 0.0006, -0.05, 0.05), 8, dt);
    this.sway.y = damp(this.sway.y, clamp(aim.y * 0.0006, -0.05, 0.05), 8, dt);
    aim.x = 0; aim.y = 0;
    const spd = Math.hypot(pl.vel.x, pl.vel.z);
    const bobAmt = Math.min(1, spd / 5) * (1 - ws.adsT * 0.9);
    const a = ws.adsT, ae = a * a * (3 - 2 * a);
    const hip = st.type === 'pistol' ? new THREE.Vector3(0.12, -0.13, -0.3) : st.type === 'launcher' ? new THREE.Vector3(0.15, -0.16, -0.25) : new THREE.Vector3(0.15, -0.16, -0.3);
    const extra = st.type === 'pistol' ? 0.26 : st.type === 'launcher' ? 0.12 : cur.info.optic === 'iron' ? 0.03 : 0.0;
    const ads = _v.set(-cur.info.sight.x, -cur.info.sight.y, -cur.info.sight.z - extra);
    const pos = hip.clone().lerp(ads, ae);
    const bx = Math.sin(ws.bobPhase) * 0.012 * bobAmt, by = -Math.abs(Math.cos(ws.bobPhase)) * 0.012 * bobAmt;
    pos.x += bx + this.sway.x * (1 - ae * 0.8); pos.y += by + this.sway.y * (1 - ae * 0.8);
    pos.z += this.vmKick * (1 - ae * 0.5);
    // 呼吸：纯画面，留在墙钟上
    const t = performance.now() * 0.001;
    pos.y += Math.sin(t * 1.6) * 0.002 * (1 - ae);
    let rx = this.vmRot * (1 - ae * 0.6), ry = 0, rz = bx * 2;
    // 冲刺姿势
    const s = ws.sprintT;
    pos.x += -0.06 * s; pos.y += -0.05 * s; pos.z += 0.03 * s;
    rx += -0.25 * s; ry += 0.7 * s; rz += 0.35 * s;
    // 滑铲
    if (pl.sliding) { rz -= 0.3; }
    // 状态动画
    const k = ws.stateDur ? clamp(ws.stateT / ws.stateDur, 0, 1) : 1;
    if (ws.state === 'reload') {
      if (st.shellReload) { rz += 0.25; rx += 0.1 + Math.sin(k * Math.PI) * 0.08; pos.y -= 0.03; }
      else {
        const e = Math.sin(k * Math.PI);
        rz += e * 0.55; rx += e * 0.25; pos.y -= e * 0.05; pos.x -= e * 0.03;
        if (cur.info.mag) {
          const m = cur.info.mag;
          if (!m.userData.base) m.userData.base = m.position.clone();
          let off = 0;
          if (k > 0.2 && k < 0.62) off = Math.min(1, (k - 0.2) / 0.12);
          if (k >= 0.62 && k < 0.75) off = 1 - (k - 0.62) / 0.13;
          m.position.copy(m.userData.base).add(new THREE.Vector3(0, -0.25 * off, 0.05 * off));
          m.visible = !(k > 0.33 && k < 0.5);
        }
      }
    } else if (cur.info.mag && cur.info.mag.userData.base) { cur.info.mag.position.copy(cur.info.mag.userData.base); cur.info.mag.visible = true; }
    if (ws.state === 'switch') { const e = 1 - k; pos.y -= e * 0.3; rx -= e * 0.6; }
    if (ws.state === 'melee') { const e = Math.sin(k * Math.PI); pos.z -= e * 0.15; pos.x -= e * 0.1; ry += e * 0.8; rz -= e * 0.4; }
    if (ws.state === 'throw' || ws.state === 'cook' || ws.state === 'use') {
      const e = ws.state === 'cook' ? 1 : Math.sin(k * Math.PI);
      pos.y -= e * 0.25; rx -= e * 0.5; pos.x += e * 0.05;
    }
    if (st.fire === 'bolt' && ws.cycleT > 0) { const e = Math.sin((1 - ws.cycleT / (60 / st.rpm)) * Math.PI); rz += e * 0.2 * (1 - ae * 0.5); pos.y -= e * 0.02; }
    if (st.fire === 'pump' && ws.cycleT > 0) { const e = Math.sin((1 - ws.cycleT / (60 / st.rpm)) * Math.PI); pos.z += e * 0.04; }
    this.holder.position.copy(pos);
    this.holder.rotation.set(rx, ry, rz);
    // 瞄具遮罩：高倍镜隐藏模型（scopeState 本身已由 WeaponState 给出，这里只管模型可见性）
    const scoped = (cur.info.optic === 'sniper' || cur.info.optic === 'acog' || cur.info.optic === 'thermal') && ws.adsT > 0.85;
    this.holder.visible = !scoped;
    game.vmCamera.fov = lerp(52, st.type === 'pistol' ? 45 : 40, ae);
    game.vmCamera.updateProjectionMatrix();
    // 激光点
    if (cur.laserDot) {
      const d = cam.getWorldDirection(_v2);
      const hit = game.world.raycast(cam.position, d, 60);
      cur.laserDot.visible = !!hit && ws.adsT < 0.5 && ws.sprintT < 0.3;
      if (hit) cur.laserDot.position.copy(hit.point).addScaledVector(hit.normal, 0.02);
    }
  }
}
