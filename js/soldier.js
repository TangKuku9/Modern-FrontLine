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

function capsule(r, len, m) {
  const g = new THREE.CapsuleGeometry(r, len, 4, 10);
  return new THREE.Mesh(g, m);
}

export function createSoldierModel(styleName, weaponId, attachments = {}, camo = 'none') {
  const st = STYLES[styleName] || STYLES.ally;
  const cloth = mat(st.fab);
  const vest = vestMat(st.vest);
  const helm = vestMat(st.helmet);
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = 0.95; root.add(hips);
  const parts = { root, hips };

  const mkLeg = (side) => {
    const leg = new THREE.Group(); leg.position.set(side * 0.11, 0, 0); hips.add(leg);
    const thigh = capsule(0.085, 0.3, cloth); thigh.position.y = -0.22; leg.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -0.44; leg.add(knee);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.05), vest); pad.position.set(0, 0, -0.07); knee.add(pad);
    const shin = capsule(0.075, 0.3, cloth); shin.position.y = -0.2; knee.add(shin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.25), mat('boot')); boot.position.set(0, -0.44, -0.05); knee.add(boot);
    return { leg, knee };
  };
  parts.legL = mkLeg(-1); parts.legR = mkLeg(1);

  const torso = new THREE.Group(); hips.add(torso); parts.torso = torso;
  const belly = capsule(0.16, 0.25, cloth); belly.scale.set(1.15, 1, 0.8); belly.position.y = 0.22; torso.add(belly);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.28), vest); chest.position.y = 0.34; torso.add(chest);
  for (let i = -1; i <= 1; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.06), vest); p.position.set(i * 0.12, 0.24, -0.16); torso.add(p);
  }
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 0.14), vest); pack.position.set(0, 0.36, 0.2); torso.add(pack);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.3), mat('glove')); belt.position.y = 0.05; torso.add(belt);

  const neck = new THREE.Group(); neck.position.y = 0.6; torso.add(neck); parts.neck = neck;
  const headMat = st.face === 'balaclava' ? mat('glove') : mat(st.face);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), headMat); head.position.y = 0.1; head.scale.set(0.95, 1.1, 1); neck.add(head);
  parts.head = head;
  if (st.head === 'helmet') {
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), helm);
    h.position.y = 0.13; neck.add(h);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.04), helm); rim.position.set(0, 0.14, -0.12); neck.add(rim);
    if (st.nvg) {
      const nv = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.06), mat('darkMetal')); nv.position.set(0, 0.2, -0.13); neck.add(nv);
      const eyeM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.5, 0.4) });
      for (const x of [-0.02, 0.02]) { const e = new THREE.Mesh(new THREE.CircleGeometry(0.008, 8), eyeM); e.position.set(x, 0.2, -0.161); e.rotation.y = Math.PI; neck.add(e); }
    }
  } else if (st.head === 'shemagh') {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), vestMat(0x9a8a74)); s.position.y = 0.12; s.scale.set(1, 1.05, 1.05); neck.add(s);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.03), vestMat(0x9a8a74)); band.position.set(0, 0.07, -0.11); neck.add(band);
    head.position.z = -0.02;
  } else if (st.head === 'beanie') {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), vestMat(0x2a2a2a)); s.position.y = 0.12; neck.add(s);
  } else if (st.head === 'beret') {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.12, 0.04, 14), helm); s.position.set(0.02, 0.2, 0); s.rotation.z = 0.2; neck.add(s);
  }
  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.03), mat('darkMetal')); goggles.position.set(0, 0.12, -0.1); neck.add(goggles);

  // 手臂与枪（持枪姿势）
  const gunInfo = buildGun(weaponId, attachments, camo, { low: true });
  const gun = gunInfo.group;
  gun.position.set(0.08, 0.4, -0.3);
  torso.add(gun);
  parts.gun = gun; parts.muzzle = gunInfo.muzzle;
  const limb = (a, b, r, m) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const mesh = capsule(r, len, m);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    torso.add(mesh);
  };
  parts.gunHome = gun.position.clone();
  const grip = gun.position.clone().add(new THREE.Vector3(0, -0.03, 0.04));
  const fore = gun.position.clone().add(gunInfo.leftHand);
  const shR = new THREE.Vector3(0.23, 0.5, 0), shL = new THREE.Vector3(-0.23, 0.5, 0);
  const elR = new THREE.Vector3(0.24, 0.3, -0.12), elL = new THREE.Vector3(-0.2, 0.3, -0.25);
  limb(shR, elR, 0.065, cloth); limb(elR, grip, 0.055, cloth);
  limb(shL, elL, 0.065, cloth); limb(elL, fore, 0.055, cloth);
  const shoulderPad = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), vest); shoulderPad.position.copy(shR); torso.add(shoulderPad);
  const sp2 = shoulderPad.clone(); sp2.position.copy(shL); torso.add(sp2);

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

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
  // s: {speed, phase, crouch(0..1), pitch, dead, deadT, recoil}
  if (s.dead) {
    const k = Math.min(1, s.deadT / 0.55);
    const e = 1 - Math.pow(1 - k, 3);
    p.root.rotation.x = e * (Math.PI / 2) * s.fallDir;
    p.root.rotation.z = e * s.fallRoll;
    p.hips.position.y = 0.95 - e * 0.75;
    p.legL.leg.rotation.x = e * 0.3; p.legR.leg.rotation.x = -e * 0.2;
    p.torso.rotation.x = 0;
    return;
  }
  const c = s.crouch;
  // 存活分支必须**自己**把倒地姿态复位。死亡分支写的是 root.rotation.x/z，而这里以前
  // 从不碰它们 —— 于是"死过又活过来"的人一直保持倒地角度，只是站着滑。症状是
  // "远端重生后一直趴着"，而它不报错、也不影响位置，只是看起来像在游泳。
  // 放在 animateSoldier 里而不是各调用点：调用点有三处（本机预测不画、Bot、NetPlayer），
  // 漏掉任何一处都会在那一路上复现。ai.js 的 respawn 里那句 rotation.set(0,yaw,0) 保留 ——
  // 它管的是同一帧就位，这里管的是"之后每一帧都不会被旧姿态污染"。
  p.root.rotation.x = 0; p.root.rotation.z = 0;
  // 滑铲与举枪是两个**只给模型**的姿态通道（0..1）。它们的源头是权威状态位
  // （FLAG.Sliding / FLAG.Ads），由 NetPlayer 平滑后递进来；本地 Bot 不产生它们
  // （ai.js 里没有这两个状态），缺省 0 ⇒ 模型与从前逐帧一致。本机玩家是第一人称，
  // 这两件事在单机里体现在相机上（滑铲降 0.25 m、侧倾 0.06，js/player.js:331,357），
  // 第三人称的姿态只在联机看别人时才有观众。
  const sl = s.slide || 0, ad = s.ads || 0;
  const moving = s.speed > 0.3;
  const sw = moving ? Math.sin(s.phase) : 0;
  const amp = Math.min(1, s.speed / 5) * (1 - c * 0.5);
  const baseThigh = c * 1.25 + sl * 0.85, baseKnee = -c * 1.7 - sl * 0.55;
  p.legL.leg.rotation.x = baseThigh + sw * 0.55 * amp;
  p.legR.leg.rotation.x = baseThigh - sw * 0.55 * amp;
  p.legL.knee.rotation.x = baseKnee - Math.max(0, -Math.cos(s.phase)) * 0.9 * amp;
  p.legR.knee.rotation.x = baseKnee - Math.max(0, Math.cos(s.phase)) * 0.9 * amp;
  p.hips.position.y = 0.95 - c * 0.36 - sl * 0.3 + (moving ? Math.abs(Math.cos(s.phase)) * 0.04 * amp : 0);
  p.torso.rotation.x = s.pitch * 0.8 - c * 0.1 + sl * 0.3 + (s.recoil || 0) * 0.12;
  p.torso.rotation.y = moving ? sw * 0.06 : 0;
  p.neck.rotation.x = s.pitch * 0.2;
  // 举枪：枪从持枪位收到肩/眼线上（GUN_ADS 是终点，ad=0 时恰好回到 createSoldierModel
  // 摆的那一位 —— 所以不传 ads 的调用点一个字都不会变）。
  if (p.gun && p.gunHome) p.gun.position.lerpVectors(p.gunHome, GUN_ADS, ad);
}

// 举枪到位的枪位（torso 局部坐标）。取"贴中线、抬到眼线"：模型正面在 -Z，
// 值由 createSoldierModel 的持枪位 (0.08, 0.4, -0.3) 收上来的那一小段，别问它像不像
// 真的据枪 —— 它要回答的问题只是"这个人正在瞄我吗"，而那一位在持枪位上看不出来。
const GUN_ADS = new THREE.Vector3(0.02, 0.52, -0.24);
