// 士兵模型与动画
import * as THREE from 'three';
import { mat } from './materials.js';
import { buildGun } from './gunmodel.js';
import { textTexture } from './textures.js';

export const STYLES = {
  ally: { fab: 'fab_ally', vest: 0x5e5440, helmet: 0x5a513d, head: 'helmet', nvg: true, face: 'skin' },
  enemy: { fab: 'fab_enemy', vest: 0x262626, helmet: 0x1e1e1e, head: 'helmet', face: 'balaclava' },
  insurgent: { fab: 'fab_snowB', vest: 0x4a4032, helmet: 0x8a7560, head: 'shemagh', face: 'skinDark' },
  snowA: { fab: 'fab_snowA', vest: 0xc9ced3, helmet: 0xd5d9de, head: 'helmet', nvg: true, face: 'skin' },
  snowB: { fab: 'fab_snowB', vest: 0x3a3a30, helmet: 0x2d2d26, head: 'beanie', face: 'balaclava' },
  urbanB: { fab: 'fab_urbanB', vest: 0x2a1a1a, helmet: 0x201515, head: 'helmet', face: 'balaclava' },
  hvt: { fab: 'fab_enemy', vest: 0x3a2e22, helmet: 0x7a1e1e, head: 'beret', face: 'skinDark' },
};

const vestMats = {};
function vestMat(c) {
  if (!vestMats[c]) vestMats[c] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 });
  return vestMats[c];
}
// 装具压暗一档:弹匣包若与胸挂同一份材质,深色布料下整个胸口糊成一块,包形读不出
const vestDarkMats = {};
function vestDarkMat(c) {
  if (!vestDarkMats[c]) vestDarkMats[c] = new THREE.MeshStandardMaterial({ color: new THREE.Color(c).multiplyScalar(0.68), roughness: 0.92 });
  return vestDarkMats[c];
}

// —— 手臂的"两点一线"工具(建模与每帧动画共用) ——
const _dir = new THREE.Vector3(), _hand = new THREE.Vector3(), _elb = new THREE.Vector3();
const _ikA = new THREE.Vector3(), _ikB = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
function placeLimb(mesh, a, b) {
  _dir.subVectors(b, a);
  const len = _dir.length() || 1e-5;
  mesh.position.copy(a).addScaledVector(_dir, 0.5);
  mesh.quaternion.setFromUnitVectors(_UP, _dir.divideScalar(len));
  mesh.scale.y = len / mesh.userData.len;
}
// 两骨 IK:肩/手/两段骨长 → 肘位。pole 把肘推离"肩→手"连线(右臂向右下、左臂向左下),
// 手够不着就夹到最远 —— 骨长永远不变,变的只有折叠角。手臂因此能跟着枪走:
// 以前四根胶囊建模时摆死,举枪手离枪 0.147 m、倒地的人保持着持枪姿势,都源于此。
function solveElbow(s, h, l1, l2, pole, out) {
  _ikA.subVectors(h, s);
  const dWanted = _ikA.length();
  const d = Math.min((l1 + l2) * 0.999, Math.max(Math.abs(l1 - l2) + 0.01, dWanted || 1e-5));
  _ikA.divideScalar(dWanted || 1e-5);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _ikB.copy(pole).addScaledVector(_ikA, -pole.dot(_ikA));
  if (_ikB.lengthSq() < 1e-8) _ikB.set(-_ikA.y, _ikA.x, 0);
  out.copy(s).addScaledVector(_ikA, a).addScaledVector(_ikB.normalize(), hh);
}
const POLE_R = new THREE.Vector3(1, -0.5, 0.35), POLE_L = new THREE.Vector3(-0.7, -0.7, 0.35);
// 倒地后的枪位(torso 局部):收到胸口、枪口转向脚尖 —— Rx(-π/2) 把枪局部 -Z 转向躯干 -Y。
// 以前死亡分支只倒 root/髋/腿,躯干上的枪跟着躺平但指向不变,躺平的人背上竖着一根朝天枪管。
const GUN_DEAD = new THREE.Vector3(0.06, 0.28, -0.16);
// 枪上某点在 torso 局部的当下位置:offset 是持枪姿态(gun 未转)下定义的,枪在倒地时
// 绕 X 转了 -π/2,靶点必须跟着转 —— 不转的话 IK 会去够"持枪时护木的旧位置",
// 在躺平的人身上那一点悬在半空,左前臂就戳向天(右手的 gripOff 偏移小,误差看不出来)。
const _hOff = new THREE.Vector3();
function gunPoint(p, off, out) {
  const t = p.gun.rotation.x - p.gunBaseRotX;
  const c = Math.cos(t), s = Math.sin(t);
  return out.set(off.x, off.y * c - off.z * s, off.y * s + off.z * c).add(p.gun.position);
}
// 冲刺持枪的枪位:收向胸口,枪口上抬(rotation.x 由 animateSoldier 按 sprint 通道抬)。
const GUN_SPRINT = new THREE.Vector3(0.10, 0.33, -0.22);

// —— 几何缓存:每兵要 new ~45 份几何,而换枪(remote.mjs:swapWeapon)是整模重建 ——
// 全部按参数走模块级缓存后,重建与 Bot 成批刷出都不再分配几何/GPU 缓冲。
// mesh 对象本身仍每兵一份(共享几何 + 各自 transform),那是便宜的部分。
const _geoCache = new Map();
function geo(key, make) {
  let g = _geoCache.get(key);
  if (!g) _geoCache.set(key, g = make());
  return g;
}
function capsule(r, len, m) {
  return new THREE.Mesh(geo(`cap ${r} ${len}`, () => new THREE.CapsuleGeometry(r, len, 4, 10)), m);
}
const box = (w, h, d, m) => new THREE.Mesh(geo(`box ${w} ${h} ${d}`, () => new THREE.BoxGeometry(w, h, d)), m);
const sph = (r, ws, hs, m, thetaLen) => new THREE.Mesh(
  geo(`sph ${r} ${ws} ${hs} ${thetaLen || 0}`, () => thetaLen
    ? new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen)
    : new THREE.SphereGeometry(r, ws, hs)), m);
const cyl = (rt, rb, h, seg, m) => new THREE.Mesh(geo(`cyl ${rt} ${rb} ${h} ${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), m);
const circle = (r, seg, m) => new THREE.Mesh(geo(`cir ${r} ${seg}`, () => new THREE.CircleGeometry(r, seg)), m);

// —— 距离细节档(LOD):main.js 每帧把相机位置递进来,animateSoldier 按平方距离开关
// parts.detail 里的小件 —— 30 m 外一只 0.02 m 的护目镜不到 2 px,留着只费 draw call。
// 不调 setSoldierEye 就永远不裁(缺省安全)。
const _eyePos = new THREE.Vector3();
let _eyeOk = false;
const LOD_FAR2 = 30 * 30;
export function setSoldierEye(v) { _eyePos.copy(v); _eyeOk = true; }

export function createSoldierModel(styleName, weaponId, attachments = {}, camo = 'none') {
  const st = STYLES[styleName] || STYLES.ally;
  const cloth = mat(st.fab);
  const vest = vestMat(st.vest);
  const helm = vestMat(st.helmet);
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = 0.95; root.add(hips);
  const parts = { root, hips };
  // detail:距离细节档要裁的小件(LOD),同时它们不投影(见文件尾的阴影裁剪)
  const detail = [];
  parts.detail = detail;
  parts.swayPhase = Math.random() * Math.PI * 2;   // 待机微晃的相位错开,一群人不至于齐步晃
  // 骨盆:躯干底与两腿之间原本是空的,背面看得到一条透地的缝
  const pelvis = box(0.28, 0.15, 0.24, cloth);
  pelvis.position.set(0, -0.03, 0.03); hips.add(pelvis);

  const mkLeg = (side) => {
    const leg = new THREE.Group(); leg.position.set(side * 0.11, 0, 0); hips.add(leg);
    const thigh = capsule(0.085, 0.3, cloth); thigh.position.y = -0.22; leg.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -0.44; leg.add(knee);
    const pad = box(0.1, 0.1, 0.05, vest); pad.position.set(0, 0, -0.07); knee.add(pad); detail.push(pad);
    const shin = capsule(0.075, 0.3, cloth); shin.position.y = -0.2; knee.add(shin);
    const boot = box(0.12, 0.1, 0.25, mat('boot')); boot.position.set(0, -0.44, -0.05); knee.add(boot);
    return { leg, knee };
  };
  parts.legL = mkLeg(-1); parts.legR = mkLeg(1);

  const torso = new THREE.Group(); hips.add(torso); parts.torso = torso;
  const belly = capsule(0.16, 0.25, cloth); belly.scale.set(1.15, 1, 0.8); belly.position.y = 0.22; torso.add(belly);
  const chest = box(0.42, 0.4, 0.28, vest); chest.position.y = 0.34; torso.add(chest);
  for (let i = -1; i <= 1; i++) {
    const p = box(0.1, 0.13, 0.06, vestDarkMat(st.vest)); p.position.set(i * 0.12, 0.24, -0.175); torso.add(p); detail.push(p);
  }
  const pack = box(0.34, 0.36, 0.14, vest); pack.position.set(0, 0.36, 0.2); torso.add(pack);
  // 腰带要比肚囊收进去一点(肚囊在该高度半宽 ≈0.173、半深 ≈0.120),再外扩就是一圈"托盘"
  const belt = box(0.36, 0.06, 0.26, mat('glove')); belt.position.y = 0.04; torso.add(belt); detail.push(belt);

  const neck = new THREE.Group(); neck.position.y = 0.6; torso.add(neck); parts.neck = neck;
  const headMat = st.face === 'balaclava' ? mat('glove') : mat(st.face);
  // 脖子:头球原本直接坐在胸挂上,侧面看有条缝
  const neckMesh = cyl(0.045, 0.05, 0.09, 10, headMat);
  neckMesh.position.y = 0.555; torso.add(neckMesh); detail.push(neckMesh);
  const head = sph(0.11, 16, 12, headMat); head.position.y = 0.1; head.scale.set(0.95, 1.1, 1); neck.add(head);
  parts.head = head;
  if (st.head === 'helmet') {
    const h = sph(0.135, 16, 10, helm, Math.PI * 0.55);
    h.position.y = 0.13; neck.add(h);
    // 盔檐贴着盔壳下缘走(壳到 y≈0.109);原来悬在 0.14,与壳体之间看得见缝
    const rim = box(0.27, 0.025, 0.03, helm); rim.position.set(0, 0.105, -0.115); neck.add(rim); detail.push(rim);
    if (st.nvg) {
      const nv = box(0.08, 0.05, 0.06, mat('darkMetal')); nv.position.set(0, 0.2, -0.13); neck.add(nv); detail.push(nv);
      const eyeM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.5, 0.4) });
      for (const x of [-0.02, 0.02]) { const e = circle(0.008, 8, eyeM); e.position.set(x, 0.2, -0.161); e.rotation.y = Math.PI; neck.add(e); detail.push(e); }
    }
  } else if (st.head === 'shemagh') {
    const s = sph(0.13, 14, 10, vestMat(0x9a8a74)); s.position.y = 0.12; s.scale.set(1, 1.05, 1.05); neck.add(s);
    const band = box(0.24, 0.05, 0.03, vestMat(0x9a8a74)); band.position.set(0, 0.07, -0.11); neck.add(band); detail.push(band);
    head.position.z = -0.02;
  } else if (st.head === 'beanie') {
    const s = sph(0.125, 14, 10, vestMat(0x2a2a2a), Math.PI * 0.5); s.position.y = 0.12; neck.add(s);
  } else if (st.head === 'beret') {
    // 贝雷帽:原来 0.26 宽的圆盘悬在头顶上方,像飞碟;收小、压到头顶上
    const s = cyl(0.105, 0.1, 0.035, 14, helm); s.position.set(0.015, 0.205, 0); s.rotation.z = 0.15; neck.add(s); detail.push(s);
  }
  // 护目镜压到盔沿之下(y=0.105,盔壳下缘 ≈0.109):原来挂 0.12,正在脸中央,
  // 孤零零一条粗黑带读作"张着大嘴"。头巾风格整头被裹住,镜体会被吞进去 —— 改一条眼缝。
  if (st.head !== 'shemagh') {
    const goggles = box(0.18, 0.02, 0.025, mat('darkMetal'));
    goggles.position.set(0, 0.105, -0.1); neck.add(goggles); detail.push(goggles);
  } else {
    const slit = box(0.15, 0.028, 0.02, mat('darkMetal'));
    slit.position.set(0, 0.115, -0.132); neck.add(slit); detail.push(slit);
  }

  // 手臂与枪（持枪姿势）
  const gunInfo = buildGun(weaponId, attachments, camo, { low: true });
  const gun = gunInfo.group;
  gun.position.set(0.08, 0.4, -0.3);
  torso.add(gun);
  parts.gun = gun; parts.muzzle = gunInfo.muzzle;
  parts.gunHome = gun.position.clone();
  parts.gunBaseRotX = gun.rotation.x;
  const gripOff = new THREE.Vector3(0, -0.03, 0.04);
  const foreOff = gunInfo.leftHand.clone();
  // 手套是枪的子件:枪被举枪/倒地挪走时手跟着走,手臂只负责"连到这两个点上"。
  // 以前连手都没有,前臂胶囊直接怼进枪身。
  const handR = box(0.055, 0.07, 0.09, mat('glove'));
  handR.position.copy(gripOff); gun.add(handR); detail.push(handR);
  const handL = box(0.055, 0.065, 0.1, mat('glove'));
  handL.position.copy(foreOff); gun.add(handL); detail.push(handL);
  const mkLimb = (a, b, r, m) => {
    const mesh = capsule(r, a.distanceTo(b), m);
    mesh.userData.len = a.distanceTo(b);
    placeLimb(mesh, a, b);
    torso.add(mesh);
    return mesh;
  };
  const shR = new THREE.Vector3(0.23, 0.5, 0), shL = new THREE.Vector3(-0.23, 0.5, 0);
  const elR = new THREE.Vector3(0.24, 0.3, -0.12), elL = new THREE.Vector3(-0.2, 0.3, -0.25);
  const upperR = mkLimb(shR, elR, 0.065, cloth), foreR = mkLimb(elR, _hand.copy(gun.position).add(gripOff), 0.055, cloth);
  const upperL = mkLimb(shL, elL, 0.065, cloth), foreL = mkLimb(elL, _hand.copy(gun.position).add(foreOff), 0.055, cloth);
  // 骨长存档,IK 每帧按这个长度解肘:骨头不许被拉长压短,变的只是折叠角
  parts.arms = {
    upperR, foreR, upperL, foreL, shR, shL,
    l1R: upperR.userData.len, l2R: foreR.userData.len, l1L: upperL.userData.len, l2L: foreL.userData.len,
    gripOff, foreOff,
  };
  const shoulderPad = sph(0.055, 10, 8, vest);
  shoulderPad.position.copy(shR); shoulderPad.scale.set(1, 0.85, 0.85); torso.add(shoulderPad); detail.push(shoulderPad);
  const sp2 = shoulderPad.clone(); sp2.position.copy(shL); torso.add(sp2); detail.push(sp2);

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // 小件不投影:投影 pass 的 draw call 是双倍,而一付护目镜的影子没人看得出来
  for (const m of detail) m.castShadow = false;

  // 枪口火光
  const flashM = new THREE.SpriteMaterial({ color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const flash = new THREE.Sprite(flashM); flash.scale.setScalar(0.45); flash.visible = false;
  gunInfo.muzzle.add(flash);
  parts.flash = flash;
  return parts;
}

export function setFlashTexture(t) { flashTex = t; }
let flashTex = null;
export function applyFlashTex(parts) { if (flashTex) { parts.flash.material.map = flashTex; parts.flash.material.needsUpdate = true; } }

export function makeNameTag(text, color) {
  const t = textTexture(text, { color, size: 54, w: 256, h: 64 });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(1.2, 0.3, 1); s.position.y = 2.15; s.renderOrder = 10;
  return s;
}

// 动画状态机
export function animateSoldier(p, s, dt) {
  // s: {speed, phase, crouch(0..1), pitch, dead, deadT, fallDir, fallRoll, recoil, ads, slide}
  if (s.dead) {
    const k = Math.min(1, s.deadT / 0.55);
    const e = 1 - Math.pow(1 - k, 3);
    p.root.rotation.x = e * (Math.PI / 2) * s.fallDir;
    p.root.rotation.z = e * s.fallRoll;
    p.hips.position.y = 0.95 - e * 0.75;
    // 趴倒(root 转 -90°)时躯干的 -Z 半边(脸、胸、枪)指向世界下方,不垫就是半截埋进地里;
    // 沿 root-local +Z(= 世界 +Y)抬 0.16,身体落在胸口那个面上。仰倒埋进去的是背包,看不见,不用抬。
    p.hips.position.z = s.fallDir < 0 ? e * 0.16 : 0;
    p.legL.leg.rotation.x = e * 0.3; p.legR.leg.rotation.x = -e * 0.2;
    p.torso.rotation.x = 0;
    // 枪贴到身上:位置收到 GUN_DEAD、枪口转向脚尖。手是枪的子件、手臂 IK 的靶点跟着枪,
    // 于是落成"搂着枪倒下",而不是站姿的胳膊平摊在两边。
    if (p.gun && p.gunHome) {
      p.gun.position.lerpVectors(p.gunHome, GUN_DEAD, e);
      p.gun.rotation.x = p.gunBaseRotX - e * Math.PI / 2;
    }
  } else {
    const c = s.crouch;
    // 存活分支必须**自己**把倒地姿态复位。死亡分支写的是 root.rotation.x/z,而这里以前
    // 从不碰它们 —— 于是"死过又活过来"的人一直保持倒地角度,只是站着滑。症状是
    // "远端重生后一直趴着",而它不报错、也不影响位置,只是看起来像在游泳。
    // 放在 animateSoldier 里而不是各调用点:调用点有三处（本机预测不画、Bot、NetPlayer），
    // 漏掉任何一处都会在那一路上复现。ai.js 的 respawn 里那句 rotation.set(0,yaw,0) 保留 ——
    // 它管的是同一帧就位，这里管的是"之后每一帧都不会被旧姿态污染"。
    p.root.rotation.x = 0; p.root.rotation.z = 0;
    // 滑铲/举枪/冲刺/滞空是四个**只给模型**的姿态通道（0..1）。源头是权威状态位
    // （FLAG.Sliding / FLAG.Ads / FLAG.Sprint / FLAG.OnGround），由 NetPlayer 平滑后递进来；
    // 本地 Bot 不产生它们（ai.js 里没有这些状态），缺省 0 ⇒ 模型与从前逐帧一致。
    // 本机玩家是第一人称，滑铲/冲刺在单机里体现在相机上（js/player.js:331,357），
    // 第三人称的姿态只在联机看别人时才有观众。
    const sl = s.slide || 0, ad = s.ads || 0;
    const sp = s.sprint || 0, air = s.air || 0;
    // 同理要复位的还有:枪的倒地转角、趴倒垫高的髋 —— 都是死亡分支写过、活人分支曾放任不管的。
    // 冲刺在复位之上叠一个枪口上抬(gunPoint 会带着手靶一起转,手仍扣在枪上)。
    if (p.gun) p.gun.rotation.x = p.gunBaseRotX + sp * 0.5;
    p.hips.position.z = 0;
    const moving = s.speed > 0.3;
    const sw = moving ? Math.sin(s.phase) : 0;
    const amp = Math.min(1, s.speed / 5) * (1 - c * 0.5) * (1 + sp * 0.35);
    // 蹲姿三数(髋降/大腿/小腿)是按腿长反推的配套:膝在髋下 0.44、踝在膝下 0.49,
    // 大腿 1.08 + 小腿 -2.0 时脚正好踩地、臀落在 ≈0.52 高 —— 单独动一个就"坐在空气凳上",
    // 旧值(1.25/-1.7/降0.36)就是那个症状:臀悬空、大腿尖戳进肚囊。
    const baseThigh = c * 1.08 + sl * 0.85, baseKnee = -c * 2.0 - sl * 0.55;
    // 滞空(air):前腿抬、后腿伸、双膝收 —— 没有这一档,跳起来的人保持最后一步的迈步定格。
    p.legL.leg.rotation.x = baseThigh + sw * (0.55 + sp * 0.3) * amp + air * 0.55;
    p.legR.leg.rotation.x = baseThigh - sw * (0.55 + sp * 0.3) * amp - air * 0.3;
    p.legL.knee.rotation.x = baseKnee - Math.max(0, -Math.cos(s.phase)) * 0.9 * amp - air * 0.8;
    p.legR.knee.rotation.x = baseKnee - Math.max(0, Math.cos(s.phase)) * 0.9 * amp - air * 0.8;
    p.hips.position.y = 0.95 - c * 0.43 - sl * 0.3 + (moving ? Math.abs(Math.cos(s.phase)) * 0.04 * (1 + sp * 0.8) * amp : 0);
    // 冲刺前倾;站立时呼吸微晃(performance.now 是纯表现时钟,不进任何玩法流)
    const swT = performance.now() * 0.001;
    p.torso.rotation.x = s.pitch * 0.8 - c * 0.32 - sp * 0.22 + sl * 0.3 + (s.recoil || 0) * 0.12
      + (moving ? 0 : Math.sin(swT * 1.8 + p.swayPhase * 1.7) * 0.006);
    p.torso.rotation.y = moving ? sw * 0.06 : Math.sin(swT * 1.3 + p.swayPhase) * 0.014;
    p.neck.rotation.x = s.pitch * 0.2;
    // 举枪：枪从持枪位收到肩/眼线上（GUN_ADS 是终点，ad=0 时恰好回到 createSoldierModel
    // 摆的那一位 —— 所以不传 ads 的调用点一个字都不会变）。冲刺另收向胸口(GUN_SPRINT)。
    if (p.gun && p.gunHome) {
      p.gun.position.lerpVectors(p.gunHome, GUN_ADS, ad);
      if (sp > 0) p.gun.position.lerp(GUN_SPRINT, sp);
    }
  }
  // 手臂(两个分支共用):肩固定、手在枪上,两骨 IK 解肘。靶点经 gunPoint 跟着枪的
  // 当下转角走 —— 活人枪没转,退化为 gun.position + offset;死人枪转了 -π/2,靶点落在
  // 贴胸那把枪的握把/护木上,落成"搂着枪倒下"。旧写法四根胶囊建模时摆死,这就是
  // "举枪手离枪 15 cm"与"尸体持枪朝天"两笔账的出处。
  if (p.arms && p.gun) {
    gunPoint(p, p.arms.gripOff, _hand);
    solveElbow(p.arms.shR, _hand, p.arms.l1R, p.arms.l2R, POLE_R, _elb);
    placeLimb(p.arms.upperR, p.arms.shR, _elb);
    placeLimb(p.arms.foreR, _elb, _hand);
    gunPoint(p, p.arms.foreOff, _hand);
    solveElbow(p.arms.shL, _hand, p.arms.l1L, p.arms.l2L, POLE_L, _elb);
    placeLimb(p.arms.upperL, p.arms.shL, _elb);
    placeLimb(p.arms.foreL, _elb, _hand);
  }
  // 距离细节档:一次平方距离,越线才动 visible(三个调用点都从这儿过,尸体也走这条)。
  // 名牌不在 detail 里 —— 它的显隐是队友逻辑的事,与距离无关。
  if (_eyeOk && p.detail) {
    const r = p.root.position;
    const far = (r.x - _eyePos.x) * (r.x - _eyePos.x)
      + (r.y - _eyePos.y) * (r.y - _eyePos.y)
      + (r.z - _eyePos.z) * (r.z - _eyePos.z) > LOD_FAR2;
    if (far !== p._detailFar) {
      p._detailFar = far;
      for (const m of p.detail) m.visible = !far;
    }
  }
}

// 举枪到位的枪位（torso 局部坐标）。取"贴中线、抬到眼线"：模型正面在 -Z，
// 值由 createSoldierModel 的持枪位 (0.08, 0.4, -0.3) 收上来的那一小段，别问它像不像
// 真的据枪 —— 它要回答的问题只是"这个人正在瞄我吗"，而那一位在持枪位上看不出来。
const GUN_ADS = new THREE.Vector3(0.02, 0.52, -0.24);
