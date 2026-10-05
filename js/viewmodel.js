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

// 手上那颗雷（CS 制投掷，第一人称）。几何口径与 combat.js 的抛射物一致 ——
// 第一/第三人称看的是同一种雷，只是这里多了引信/握片这些手部细节。
function buildNadeMesh(id) {
  const g = new THREE.Group();
  if (id === 'frag') {
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), mat('gunGreen')));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.024, 8), mat('darkMetal'));
    cap.position.y = 0.054; g.add(cap);
    const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.055, 0.005), mat('steel'));
    spoon.position.set(0.022, 0.03, 0.012); spoon.rotation.z = -0.55; g.add(spoon);
  } else if (id === 'semtex') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.05, 0.05), mat('yellowPaint')));
    const lite = new THREE.Mesh(new THREE.SphereGeometry(0.013, 6, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.3, 0.3) }));
    lite.position.y = 0.031; g.add(lite);
  } else if (id === 'molotov') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.15, 10), mat('glass')));
    const fuel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.085, 10), mat('fire'));
    fuel.position.y = -0.015; g.add(fuel);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.045, 8), mat('glass'));
    neck.position.y = 0.095; g.add(neck);
    const rag = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), mat('clothRed'));
    rag.position.set(0.012, 0.125, 0); rag.rotation.z = 0.4; g.add(rag);
  } else if (id === 'flash' || id === 'smoke') {
    const r = id === 'flash' ? 0.026 : 0.032, h = id === 'flash' ? 0.105 : 0.13;
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat(id === 'flash' ? 'steel' : 'gunGreen')));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.7, 0.02, 8), mat('darkMetal'));
    cap.position.y = h / 2 + 0.01; g.add(cap);
    if (id === 'smoke') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.4, 0.004, 6, 12), mat('rubber'));
      ring.rotation.x = Math.PI / 2; ring.position.y = h / 2 + 0.022; g.add(ring);
    }
  } else {  // stim 兴奋剂：自动注射器
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.1, 8), mat('steel'));
    g.add(tube);
    const plunger = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.03, 8), mat('rubber'));
    plunger.position.y = 0.06; g.add(plunger);
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.035, 6), mat('darkMetal'));
    needle.position.y = -0.066; g.add(needle);
    const dose = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0115, 0.05, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.6, 3.2), transparent: true, opacity: 0.85 }));
    dose.position.y = 0.008; g.add(dose);
  }
  return g;
}

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
    // CS 制投掷的持雷架：左右臂 + 雷体，按雷种懒建（枪模照旧建着，只是藏掉）
    this.nadeRig = null; this.nadeBodyId = null;
  }
  dispose() {
    this.ws.sink = null;
    this.game.vmScene.remove(this.pivot);
    this.game.vmScene.remove(this.flashLamp);
    for (const s of this.groups) if (s && s.laserDot) this.game.scene.remove(s.laserDot);
    this.groups = [];
    this.nadeRig = null;
  }

  // 持雷架：雷体 + 攥着它的两只手套件，全部挂在 body（雷体组）下 —— 手跟着雷一起动
  // （烹饪抬起/出手前甩时不会脱手）。刻意不用 buildArms：它的右臂刚体坐标是按枪的
  // 跨度调的，雷的持握位下那些胶囊会横穿近裁剪面，实拍里是一坨怼在镜头上的黑块。
  ensureNade(id) {
    if (!this.nadeRig) {
      const glove = mat('glove'), sleeve = mat(this.game.playerSleeve || 'fab_ally');
      const body = new THREE.Group();
      body.position.set(0.012, -0.005, -0.03);
      body.rotation.set(0.35, -0.25, 0.15);
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.06, 0.075), glove);
      palm.position.set(0.005, -0.028, 0.04); body.add(palm);
      const wrist = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.16, 4, 8), sleeve);
      wrist.position.set(0.05, -0.11, 0.15);
      wrist.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-0.25, 0.55, -0.8).normalize());
      body.add(wrist);
      const lhand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.07), glove);
      lhand.position.set(-0.045, -0.04, 0.02); lhand.rotation.z = 0.5; body.add(lhand);
      const group = new THREE.Group();
      group.add(body);
      group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      this.nadeRig = { group, body };
    }
    if (this.nadeBodyId !== id) {
      // 换雷种只换雷体几何，手留着
      const body = this.nadeRig.body, old = body.userData.nade;
      if (old) body.remove(old);
      const nade = buildNadeMesh(id);
      body.add(nade);
      body.userData.nade = nade;
      this.nadeBodyId = id;
    }
    return this.nadeRig;
  }

  build(cfg) {
    const stats = cfg.stats;
    const info = buildGun(cfg.id, cfg.att || {}, cfg.camo || 'none', { noShadow: true });
    const sleeve = mat(this.game.playerSleeve || 'fab_ally');
    const arms = buildArms(info, sleeve);
    const g = new THREE.Group();
    g.add(info.group); g.add(arms.group);
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    // 火光尺寸与持续时间按枪口装置走。整体压一档：贴片是 HDR 加色，旧颜色(3,2.2,1.4)
    // 远超 bloom 阈值(0.92)，开镜时枪口又正贴在准星下方，一团泛光直接糊住瞄点。
    // 消焰器这次要真的消焰：贴片缩到三成、透明度砍近半，灯与火星同步压小（见 update
    // 的 shot 事件处理）；消音器仍然比它更狠。基准按枪型分级：手枪最小、霰弹枪最大。
    const base = FLASH_BY_TYPE[stats.type] ?? 0.21;
    const flashScale = (stats.suppressed ? 0.26 : stats.flashHide ? 0.3 : 0.8) * base;
    const flashOpacity = stats.suppressed ? 0.35 : stats.flashHide ? 0.45 : 0.85;
    const flashDur = (stats.suppressed ? 0.5 : stats.flashHide ? 0.55 : 1) * 0.035;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.game.effects.texFlash, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(2.0, 1.4, 0.9), opacity: flashOpacity }));
    flash.scale.setScalar(flashScale); flash.visible = false;
    info.muzzle.add(flash);
    let laserDot = null;
    if (stats.laser) {
      laserDot = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.5, 0.5) }));
      this.game.scene.add(laserDot); laserDot.visible = false;
    }
    // 分件动作的基准位：套筒/拉机柄/泵动护木都从原位往后/往前推
    for (const p of [info.slide, info.bolt, info.pump]) if (p && !p.userData.base) p.userData.base = p.position.clone();
    return { info, group: g, arms, flash, flashScale, flashDur, laserDot, act: 0, cylStep: 0 };
  }
  syncLoadout() {
    if (this.ws.loadoutVersion === this.seenVersion) return;
    this.seenVersion = this.ws.loadoutVersion;
    for (const s of this.groups) { if (s) { this.holder.remove(s.group); if (s.laserDot) this.game.scene.remove(s.laserDot); } }
    this.groups = this.ws.slots.map(c => c ? this.build(c) : null);
  }
  showCurrent() {
    this.syncLoadout();
    const nadeOn = !!this.ws.nadeMode;
    this.groups.forEach((s, i) => {
      if (!s) return;
      if (!nadeOn && i === this.ws.cur) { if (!s.group.parent) this.holder.add(s.group); }
      else if (s.group.parent) this.holder.remove(s.group);
      if (s.laserDot) s.laserDot.visible = false;
    });
    // 持雷架与枪模互斥：切出雷时整个枪组从 holder 摘下，雷组挂上去。
    // 出手的跟随段（throw 且雷已离手）只藏雷体 —— 手还是空的，摊在挥出位。
    if (nadeOn) {
      const rig = this.ensureNade(this.ws.nadeMode.id);
      if (!rig.group.parent) this.holder.add(rig.group);
      rig.body.visible = !(this.ws.state === 'throw' && !this.ws.grenade);
    } else if (this.nadeRig && this.nadeRig.group.parent) {
      this.holder.remove(this.nadeRig.group);
    }
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
          if (!e.suppressed) game.effects.flashLight(mw, 0xffb060, e.flashHide ? 0.5 : 2.5, 0.05, 8);
          // 枪口烟与火星：以前只有一张贴片 + 一次闪光（effects.muzzle 那套只有哨戒机枪在用），
          // 打起来是"一闪而过"。消音器把烟一并压掉（这才是"看不出谁在开枪"）。灯自己已经加过。
          // 消焰器只消焰不消烟：火星单独收档（spark 参数），烟保持原样。
          if (!e.suppressed) game.effects.muzzle(mw, e.fwd, st.type === 'shotgun' || st.type === 'lmg' ? 1.3 : st.type === 'pistol' ? 0.7 : 1, false, e.flashHide ? 0.35 : 1);
          for (const p of e.tracers) game.effects.tracer(mw.clone().addScaledVector(e.fwd, 0.5), p, [1.4, 1.0, 0.55]);
          if (e.shell) {
            // 弹壳从**抛壳窗**（info.eject）出来，不是"枪口后方 0.4 m"那个固定点 ——
            // 枪越长偏得越多：L115A3 的弹壳原本会从护木/枪管那儿冒出来。
            const right = _v2.set(1, 0, 0).applyQuaternion(game.camera.quaternion);
            game.effects.shell(cur.info.eject.getWorldPosition(_shellP), right, e.shell);
          }
          this.vmKick += 0.02 + e.recoilV * 0.012;
          this.vmRot += 0.02 + e.recoilV * 0.02;
          cur.act = 1;       // 套筒后坐
          cur.cylStep = 1;   // 左轮弹巢转一格
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
    cur.act = damp(cur.act, 0, 14, dt);
    this.flashT -= dt;
    cur.flash.visible = this.flashT > 0;
    if (cur.flash.visible) {
      cur.flash.material.rotation = Math.random() * 6;
      // 开镜时枪口就贴在准星正下方，贴片一大就把瞄点整个糊住 —— 开镜把火光再收四成
      cur.flash.scale.setScalar(cur.flashScale * (1 - 0.4 * smooth01(ws.adsT)));
    }

    const pl = this.owner, cam = game.camera;
    this.pivot.position.copy(cam.position);
    this.pivot.quaternion.copy(cam.quaternion);
    game.vmCamera.position.copy(cam.position);
    game.vmCamera.quaternion.copy(cam.quaternion);
    // 火光要打亮自己的枪与手：世界那盏点光源挂在 game.scene，照不到 vmScene 里的枪模
    this.flashLamp.position.copy(this.muzzleWorld(_mw));
    this.flashLamp.intensity = this.flashT > 0
      ? (st.suppressed ? 0.3 : st.flashHide ? 0.35 : 1.3) * clamp(this.flashT / cur.flashDur, 0, 1)
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
    // 持雷时不走枪械的 hip/ADS 表：雷攥在胸前偏中。枪模的可见体积从原点向上延伸，
    // 雷体却坐在原点上 —— 同一偏移会把小球推出画面右下（实拍校准过：52° FOV 下
    // (0.16,-0.17,-0.26) 的雷心 NDC y≈-1.3，整个在画外）。
    if (ws.nadeMode) pos.set(0.115, -0.075, -0.38);
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
    // 探头：相机已经带着横移与横滚（player.js:updateCamera），枪身给一点"滞后"——小幅反向
    // 平移 + 部分回正的滚转，读作"人探出去、枪还端着"，而不是整幅画面刚性平移。
    // 幅度是纯表现旋钮，不影响任何裁决（弹道从 camPos/aimDir 取）。
    // 开镜时必须随 (1-ae) 归零（与 sway/kick/呼吸同族）：ADS 位姿的全部意义是瞄具钉死在
    // 弹道轴上，而开镜后瞄点就贴在眼底，这点横移会把分划甩出半屏（m4 红点满倾实测
    // NDC x=0.52）。"枪滞后"是腰射的读法；贴腮了枪就没有滞后。
    if (pl.leanT) { pos.x -= pl.leanT * 0.03 * (1 - ae); rz += pl.leanT * 0.09 * (1 - ae); }
    // 状态动画
    const k = ws.stateDur ? clamp(ws.stateT / ws.stateDur, 0, 1) : 1;
    const arms = cur.arms;
    if (ws.state === 'reload') {
      if (st.shellReload) {
        rz += 0.25; rx += 0.1 + Math.sin(k * Math.PI) * 0.08; pos.y -= 0.03;
        // 逐发装填：副手每一发去装弹口递一发（k 每发走一轮，stateT 在 weapon-state.js:121 被清零）
        _belt.set(0, -0.05, -0.02);
        _hand.copy(arms.leftHome).lerp(_belt, k < 0.25 ? smooth01(k / 0.25) : k < 0.62 ? 1 : 1 - smooth01((k - 0.62) / 0.38));
        // 待装的那发霰弹只在手到装弹口的窗口露面。以前它常驻机匣侧面 —— 平时端着枪
        // 也有一发弹"贴"在装弹口上（gunmodel 的 tube 分支把它摆在装弹口位）。
        if (cur.info.mag) {
          const m = cur.info.mag;
          if (!m.userData.base) m.userData.base = m.position.clone();
          m.visible = k > 0.22 && k < 0.66;
        }
      } else if (cur.info.warhead) {
        // RPG 装填：弹头不是弹匣（gunmodel 里它单独挂 info.warhead）。空膛从击发那
        // 一刻就开始（弹头跟着世界里那枚 Projectile 飞了），手从背后弹袋兜一发新的，
        // 绕到筒口**前方**握着尾喷段，沿筒轴往后捅进膛 —— 真机的前插装填，不是把
        // 弹头往下拽 25cm 再插回来的"弹匣动画"。
        const m = cur.info.warhead;
        if (!m.userData.base) m.userData.base = m.position.clone();
        // 手：护木待位 → 后背取弹 → 托到筒下前位（臂展极限，IK 会自然截短）→ 回位
        if (k < 0.16) _hand.copy(arms.leftHome);
        else if (k < 0.42) _hand.copy(arms.leftHome).lerp(_belt.set(0.04, -0.26, 0.12), smooth01((k - 0.16) / 0.26));
        else if (k < 0.62) _hand.copy(_belt.set(0.04, -0.26, 0.12)).lerp(_magOff.set(-0.01, -0.03, -0.42), smooth01((k - 0.42) / 0.2));
        else if (k < 0.9) _hand.copy(_magOff.set(-0.01, -0.03, -0.42));
        else _hand.copy(_magOff.set(-0.01, -0.03, -0.42)).lerp(arms.leftHome, smooth01((k - 0.9) / 0.1));
        // 弹头：膛里有（未打完就换弹）就坐到手低头取弹那一刻；空膛则藏到手把新火箭
        // 兜上来。提弹偏移把手放在火箭尾段（握的是发动机段，战斗部前伸）。
        if (k < 0.42) {
          m.visible = w.mag > 0;
          m.position.copy(m.userData.base);
        } else if (k < 0.62) {
          m.visible = true;
          m.position.copy(_hand).add(_shellP.set(0.02, 0.08, -0.45));
        } else if (k < 0.9) {
          m.visible = true;
          m.position.copy(_hand).add(_shellP.set(0.02, 0.08, -0.45)).lerp(m.userData.base, smooth01((k - 0.62) / 0.28));
        } else {
          m.visible = true;
          m.position.copy(m.userData.base);
        }
      } else if (cur.info.cylPivot) {
        // 左轮装弹：甩巢 → 手到位倒壳 → 压弹 → 收巢。以前 info.mag 是个 1mm 的假
        // 弹匣，手对着纹丝不动的弹巢做完整套"拔匣-押匣-插匣"。甩角 0.6 rad（34°）
        // 是真实开巢的量级 —— 甩到 1.0 弹巢就快脱出铰架了。
        const c = cur.info.cylPivot;
        const o = k < 0.18 ? 0 : k < 0.32 ? smooth01((k - 0.18) / 0.14) : k < 0.72 ? 1 : k < 0.86 ? 1 - smooth01((k - 0.72) / 0.14) : 0;
        c.rotation.y = -0.6 * o;
        // 抓握点跟着甩出角走（甩满时巢尾扫到枪左侧），手全程贴着它
        _shellP.set(-0.015 - 0.028 * o, 0.02, -0.01);
        if (k < 0.16) _hand.copy(arms.leftHome);
        else if (k < 0.32) _hand.copy(arms.leftHome).lerp(_shellP, smooth01((k - 0.16) / 0.16));
        else if (k < 0.46) _hand.copy(_shellP);
        else if (k < 0.58) _hand.copy(_shellP).lerp(_belt.set(0.04, -0.26, 0.12), smooth01((k - 0.46) / 0.12));
        else if (k < 0.7) _hand.copy(_belt.set(0.04, -0.26, 0.12)).lerp(_shellP, smooth01((k - 0.58) / 0.12));
        else if (k < 0.86) _hand.copy(_shellP);
        else _hand.copy(_shellP).lerp(arms.leftHome, smooth01((k - 0.86) / 0.14));
        // 甩满那拍倒壳：弹壳从**甩开的弹巢**（巢网格世界位）掉出去，不走抛壳窗 ——
        // 左轮开火不抛壳（弹壳留在弹巢里），装弹时才一次退空（weapon-state 的 shell 注）
        if (!cur.cylDumped && k > 0.44) {
          cur.cylDumped = true;
          const right = _v2.set(1, 0, 0).applyQuaternion(game.camera.quaternion);
          this.pivot.updateMatrixWorld(true);
          const p = cur.info.cylinder.getWorldPosition(_shellP);   // 抓握点已用完，临时向量让给壳位
          for (let i = 0; i < 5; i++) game.effects.shell(p, right, 'pistol');
        }
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
    if (ws.state !== 'reload') {
      cur.cylDumped = false;
      if (cur.info.cylPivot) cur.info.cylPivot.rotation.y = 0;   // 甩巢被近战/切枪打断：收回来，别一直张着
      if (cur.info.warhead) {
        // RPG 弹头的生命周期锚在权威弹匣上：膛里有火箭（mag>0）才坐在筒口。击发扣
        // 弹的下一帧就空膛 —— 弹头"离膛"交给天上那枚 Projectile，而不是继续挂在
        // 筒口假装没打出去。位置常归位，可见性随弹匣走。
        const m = cur.info.warhead;
        if (m.userData.base) m.position.copy(m.userData.base);
        m.visible = w.mag > 0;
      } else if (cur.info.mag) {
        // 位置归位只在动画记过基准之后才有意义；可见性不依赖它 —— 管装霰弹的
        // 待装壳从上枪那一刻就得藏着（只在装填窗口露面），不能等第一次换弹才生效。
        if (cur.info.mag.userData.base) cur.info.mag.position.copy(cur.info.mag.userData.base);
        cur.info.mag.visible = !st.shellReload;
      }
    }
    // 切枪的下探-抬起：枪模从原点向上延伸，探 0.3 也只露个枪口；雷体坐在原点上，
    // 探 0.3 = 整颗雷滑出画面 —— 持雷时浅探一半高度。
    if (ws.state === 'switch') { const e = 1 - k; const dip = ws.nadeMode ? 0.12 : 0.3; pos.y -= e * dip; rx -= e * (ws.nadeMode ? 0.35 : 0.6); }
    if (ws.state === 'melee') { const e = Math.sin(k * Math.PI); pos.z -= e * 0.15; pos.x -= e * 0.1; ry += e * 0.8; rz -= e * 0.4; }
    // CS 制投掷的手部戏：动的是"雷体"而不是整架 —— 烹饪抬到眼前偏侧，出手向前下甩，
    // 兴奋剂举针。手件挂在雷体组下，跟着一起走。
    if (ws.nadeMode) {
      const rig = this.ensureNade(ws.nadeMode.id);
      const base = rig.body.userData.base || (rig.body.userData.base = rig.body.position.clone());
      const b = rig.body;
      if (ws.state === 'cook') {
        const wgt = smooth01(clamp(ws.stateT / 0.25, 0, 1));
        b.position.set(base.x + 0.005, base.y + 0.115 * wgt, base.z + 0.10 * wgt);
        b.rotation.x = 0.35 + 0.45 * wgt;
      } else if (ws.state === 'throw') {
        const e = Math.sin(k * Math.PI);
        b.position.set(base.x, base.y - 0.03 * e, base.z - 0.30 * e);
        b.rotation.x = 0.35 - 0.8 * e;
        rx -= e * 0.7; pos.z -= e * 0.06;
      } else if (ws.state === 'use') {
        const e = Math.sin(k * Math.PI);
        b.position.set(base.x, base.y + 0.09 * e, base.z - 0.02 * e);
        b.rotation.x = 0.35 - 0.5 * e;
      } else {
        b.position.copy(base);
        b.rotation.x = 0.35;
      }
    } else if (ws.state === 'throw' || ws.state === 'cook' || ws.state === 'use') {
      // 兜底（beginThrow 只从 nade 态进，理论到不了）：沿用枪模 dip 别把画面冻住。
      const e = ws.state === 'cook' ? 1 : Math.sin(k * Math.PI);
      pos.y -= e * 0.25; rx -= e * 0.5; pos.x += e * 0.05;
    }
    // 分件动作。以前栓动是"整枪滚 0.2 rad"、泵动是"整枪推 4cm" —— 动的是整把枪，
    // 而真正该动的拉机柄/泵动护木是死几何。现在分件自己走，整枪只留一点后坐回落。
    const cyc = ws.cycleT > 0 ? Math.sin((1 - ws.cycleT / (60 / st.rpm)) * Math.PI) : 0;
    if (st.fire === 'bolt') { rz += cyc * 0.06 * (1 - ae * 0.5); pos.y -= cyc * 0.012; }
    if (st.fire === 'pump') pos.z += cyc * 0.015;
    if (cur.info.bolt && cur.info.bolt.userData.base) cur.info.bolt.position.copy(cur.info.bolt.userData.base).add(_magOff.set(0, 0, 0.055 * cyc));
    if (cur.info.pump && cur.info.pump.userData.base) cur.info.pump.position.copy(cur.info.pump.userData.base).add(_magOff.set(0, 0, 0.09 * cyc));
    // 套筒：击发后坐再回位；打空了停在后方（空仓挂机）
    if (cur.info.slide && cur.info.slide.userData.base) {
      const back = w.mag <= 0 ? 1 : cur.act;
      cur.info.slide.position.copy(cur.info.slide.userData.base).add(_magOff.set(0, 0, 0.032 * back));
    }
    // 弹巢每发转一格（左轮不抛壳，但弹巢确实要跟着转）
    if (cur.info.cylinder && cur.cylStep) { cur.info.cylinder.rotation.z += Math.PI / 3; cur.cylStep = 0; }
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
      cur.laserDot.visible = !!hit && ws.adsT < 0.5 && ws.sprintT < 0.3 && !ws.nadeMode;
      if (hit) cur.laserDot.position.copy(hit.point).addScaledVector(hit.normal, 0.02);
    }
  }
}
