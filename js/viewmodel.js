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
const _mw = new THREE.Vector3(), _shellP = new THREE.Vector3(), _hand = new THREE.Vector3(), _belt = new THREE.Vector3(), _magOff = new THREE.Vector3();
// 副手抓弹匣的握点（弹匣自身坐标里往左前探一点）
const MAG_GRAB_OFF = new THREE.Vector3(-0.03, 0.02, 0.02);
// 枪口火光基准尺寸（枪型 → 米），霰弹枪/轻机枪最大、手枪最小
const FLASH_BY_TYPE = { pistol: 0.15, smg: 0.17, ar: 0.21, marksman: 0.24, sniper: 0.26, lmg: 0.26, shotgun: 0.3, launcher: 0.34 };
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

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
    // 枪口闪光灯挂在 vmScene 上：世界那盏（effects.flashLight）加在 game.scene，
    // 而枪模渲染在 vmScene —— 开火时枪身/手套一直是冷的，只有那张贴片在发光。
    this.flashLamp = new THREE.PointLight(0xffb060, 0, 4, 2);
    game.vmScene.add(this.flashLamp);
    this.handDirty = false;   // 换弹结束后把副手放回护木一次
  }
  dispose() {
    this.ws.sink = null;
    this.game.vmScene.remove(this.pivot);
    this.game.vmScene.remove(this.flashLamp);
    for (const s of this.groups) if (s && s.laserDot) this.game.scene.remove(s.laserDot);
    this.groups = [];
  }

  build(cfg) {
    const stats = cfg.stats;
    const info = buildGun(cfg.id, cfg.att || {}, cfg.camo || 'none', { noShadow: true });
    const sleeve = mat(this.game.playerSleeve || 'fab_ally');
    const arms = buildArms(info, sleeve);
    const g = new THREE.Group();
    g.add(info.group); g.add(arms.group);
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    // 火光尺寸与持续时间按枪口装置走：消焰器要真的消焰 —— 原来只把点光源 4→1.5，
    // 贴片尺寸和 35ms 的闪光时间一动不动，装了它照样一大团火（名实不符）。
    // 基准还按枪型分级：以前全枪一个 0.22，手枪和轻机枪一样大。
    const base = FLASH_BY_TYPE[stats.type] ?? 0.21;
    const flashScale = (stats.suppressed ? 0.36 : stats.flashHide ? 0.5 : 1) * base;
    const flashDur = (stats.suppressed ? 0.5 : stats.flashHide ? 0.62 : 1) * 0.035;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.game.effects.texFlash, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(3, 2.2, 1.4) }));
    flash.scale.setScalar(flashScale); flash.visible = false;
    info.muzzle.add(flash);
    let laserDot = null;
    if (stats.laser) {
      laserDot = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.5, 0.5) }));
      this.game.scene.add(laserDot); laserDot.visible = false;
    }
    return { info, group: g, arms, flash, flashDur, laserDot };
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
          this.flashT = cur.flashDur;
          const mw = this.muzzleWorld(_mw);
          if (!e.suppressed) game.effects.flashLight(mw, 0xffb060, e.flashHide ? 1.5 : 4, 0.05, 8);
          // 枪口烟与火星：以前只有一张贴片 + 一次闪光（effects.muzzle 那套只有哨戒机枪在用），
          // 打起来是"一闪而过"。消音器把烟一并压掉（这才是"看不出谁在开枪"）。灯自己已经加过。
          if (!e.suppressed) game.effects.muzzle(mw, e.fwd, st.type === 'shotgun' || st.type === 'lmg' ? 1.3 : st.type === 'pistol' ? 0.7 : 1, false);
          for (const p of e.tracers) game.effects.tracer(mw.clone().addScaledVector(e.fwd, 0.5), p, [1.4, 1.0, 0.55]);
          if (e.shell) {
            // 弹壳从**抛壳窗**（info.eject）出来，不是"枪口后方 0.4 m"那个固定点 ——
            // 枪越长偏得越多：L115A3 的弹壳原本会从护木/枪管那儿冒出来。
            const right = _v2.set(1, 0, 0).applyQuaternion(game.camera.quaternion);
            game.effects.shell(cur.info.eject.getWorldPosition(_shellP), right, e.shell);
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
    // 火光要打亮自己的枪与手：世界那盏点光源挂在 game.scene，照不到 vmScene 里的枪模
    this.flashLamp.position.copy(this.muzzleWorld(_mw));
    this.flashLamp.intensity = this.flashT > 0
      ? (st.suppressed ? 0.5 : st.flashHide ? 0.8 : 2.0) * clamp(this.flashT / cur.flashDur, 0, 1)
      : 0;
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
    const arms = cur.arms;
    if (ws.state === 'reload') {
      if (st.shellReload) {
        rz += 0.25; rx += 0.1 + Math.sin(k * Math.PI) * 0.08; pos.y -= 0.03;
        // 逐发装填：副手每一发去装弹口递一发（k 每发走一轮，stateT 在 weapon-state.js:121 被清零）
        _belt.set(0, -0.05, -0.02);
        _hand.copy(arms.leftHome).lerp(_belt, k < 0.25 ? smooth01(k / 0.25) : k < 0.62 ? 1 : 1 - smooth01((k - 0.62) / 0.38));
      } else {
        const e = Math.sin(k * Math.PI);
        rz += e * 0.55; rx += e * 0.25; pos.y -= e * 0.05; pos.x -= e * 0.03;
        if (cur.info.mag) {
          const m = cur.info.mag;
          if (!m.userData.base) m.userData.base = m.position.clone();
          let off = 0;
          if (k > 0.2 && k < 0.62) off = Math.min(1, (k - 0.2) / 0.12);
          if (k >= 0.62 && k < 0.75) off = 1 - (k - 0.62) / 0.13;
          m.position.copy(m.userData.base).add(_magOff.set(0, -0.25 * off, 0.05 * off));
          m.visible = !(k > 0.33 && k < 0.5);
          // 副手全程跟着弹匣：伸手抓住 → 押着它下来 → 去弹挂取新的 → 装到位 → 回护木。
          // 原来手臂是枪组的刚性子件，弹匣在手里下坠、消失、再回来，两只手纹丝不动。
          _hand.copy(m.position).add(MAG_GRAB_OFF);
          if (k < 0.16) _hand.copy(arms.leftHome);
          else if (k < 0.40) { /* 抓着弹匣一起走 */ }
          else if (k < 0.52) _hand.lerp(_belt.set(0.04, -0.26, 0.12), smooth01((k - 0.40) / 0.12));
          else if (k < 0.62) _hand.lerp(_belt.set(0.04, -0.26, 0.12), 1 - smooth01((k - 0.52) / 0.10));
          else if (k < 0.80) { /* 押着弹匣装到位 */ }
          else _hand.lerp(arms.leftHome, smooth01((k - 0.80) / 0.20));
        } else _hand.copy(arms.leftHome);
      }
      arms.poseLeft(_hand);
      this.handDirty = true;
    } else if (this.handDirty) { arms.poseLeft(arms.leftHome); this.handDirty = false; }
    if (ws.state !== 'reload' && cur.info.mag && cur.info.mag.userData.base) {
      cur.info.mag.position.copy(cur.info.mag.userData.base); cur.info.mag.visible = true;
    }
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
