// 程序化枪械模型（含配件可视化）
import * as THREE from 'three';
import { WEAPONS } from './data.js';
import { mat, camoMaterial } from './materials.js';

const geoCache = new Map();
function bgeo(w, h, d) {
  const k = `b${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)}`;
  if (!geoCache.has(k)) geoCache.set(k, new THREE.BoxGeometry(w, h, d));
  return geoCache.get(k);
}
function cgeo(r1, r2, len, seg = 14) {
  const k = `c${r1},${r2},${len},${seg}`;
  if (!geoCache.has(k)) { const g = new THREE.CylinderGeometry(r1, r2, len, seg); g.rotateX(Math.PI / 2); geoCache.set(k, g); }
  return geoCache.get(k);
}
// 开口管（两端不封盖）：凡是"要从当中望出去"的筒一律走这里。
// 用 cgeo 画瞄具镜筒会在射手眼底留一个封盖圆面 —— 玩家 ADS 看到的是一堵金属墙而不是镜片，
// MRS 红点就是这么坏的。判据与它的反证臂在 test/optic.mjs（O1/O1⁻）。
// 配套材质是 gunTube（DoubleSide）：只有一层 FrontSide 的管壁从内侧会被整片剔除，
// 看过去就不是筒起见而是"没有壁" —— 那比实心更不像筒。
function tgeo(r1, r2, len, seg = 14) {
  const k = `t${r1},${r2},${len},${seg}`;
  if (!geoCache.has(k)) { const g = new THREE.CylinderGeometry(r1, r2, len, seg, 1, true); g.rotateX(Math.PI / 2); geoCache.set(k, g); }
  return geoCache.get(k);
}

export function buildGun(weaponId, att = {}, camo = 'none', opts = {}) {
  const def = WEAPONS[weaponId];
  const M = def.model;
  const root = new THREE.Group();
  // eject 是**抛壳口**的锚点：弹壳从这里出来，不是从枪口后方 0.4 m 的固定点。
  // 它必须是挂在枪上的 Object3D（跟 muzzle 一样），否则枪一动弹壳就落在旧位置。
  const info = { group: root, muzzle: new THREE.Object3D(), sight: new THREE.Vector3(), mag: null, leftHand: new THREE.Vector3(0, 0, -0.2), eject: new THREE.Object3D(), optic: 'iron', reticle: null, slide: null, bolt: null, pump: null, cylinder: null, grip: null, laserMod: null };
  root.add(info.eject);
  const low = !!opts.low;

  const furnBase = M.color === 'wood' ? mat('gunWood') : M.color === 'tan' ? mat('gunTan') : M.color === 'green' ? mat('gunGreen') : M.color === 'steel' ? mat('gunSteel') : mat('gunPoly');
  const metal = M.color === 'steel' ? mat('gunSteel') : mat('gunMetal');
  const furn = camoMaterial(camo, furnBase);
  const body = camo !== 'none' ? camoMaterial(camo, metal) : metal;
  const add = (geo, m, x, y, z, rx = 0, ry = 0, rz = 0, parent = root) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = !opts.noShadow; mesh.receiveShadow = false;
    parent.add(mesh); return mesh;
  };

  if (M.rpg) {
    add(cgeo(0.042, 0.042, 0.95), furn, 0, 0.06, -0.15);
    add(cgeo(0.05, 0.05, 0.25), mat('gunWood'), 0, 0.06, -0.05);
    add(cgeo(0.06, 0.03, 0.14), metal, 0, 0.06, 0.37);
    const wh = new THREE.Group(); wh.position.set(0, 0.06, -0.62); root.add(wh);
    add(cgeo(0.04, 0.045, 0.12), mat('gunGreen'), 0, 0, 0, 0, 0, 0, wh);
    add(new THREE.ConeGeometry(0.07, 0.25, 14).rotateX(-Math.PI / 2), mat('gunGreen'), 0, 0, -0.18, 0, 0, 0, wh);
    add(cgeo(0.07, 0.07, 0.12), mat('gunGreen'), 0, 0, -0.03, 0, 0, 0, wh);
    add(bgeo(0.03, 0.1, 0.04), mat('gunPoly'), 0, -0.03, 0.02, 0.2);
    add(bgeo(0.03, 0.1, 0.04), mat('gunPoly'), 0, -0.03, -0.2, 0.1);
    add(bgeo(0.02, 0.05, 0.02), metal, 0, 0.12, -0.1);
    add(bgeo(0.02, 0.04, 0.02), metal, 0, 0.12, 0.08);
    info.mag = wh;
    info.muzzle.position.set(0, 0.06, -0.8);
    info.sight.set(0, 0.14, 0.14);
    info.leftHand.set(0, -0.02, -0.2);
    info.eject.position.set(0, 0.06, 0.28);   // 火箭筒不抛壳，锚点只求不落在筒内
    root.add(info.muzzle);
    return info;
  }

  if (M.pistol) {
    if (M.revolver) {
      add(bgeo(0.028, 0.035, 0.16), body, 0, 0.055, -0.1);
      add(cgeo(0.011, 0.011, 0.2), body, 0, 0.06, -0.14);
      info.cylinder = add(cgeo(0.028, 0.028, 0.05, 12), metal, 0, 0.05, -0.02);   // 弹巢：每发转一格
      add(bgeo(0.03, 0.1, 0.045), mat('gunWood'), 0, -0.02, 0.04, 0.3);
      add(bgeo(0.004, 0.012, 0.01), metal, 0, 0.078, -0.23);
      info.muzzle.position.set(0, 0.06, -0.25);
      info.sight.set(0, 0.083, 0.02);
      info.eject.position.set(0.034, 0.05, -0.02);   // 弹巢与底把之间的缝，装弹时才打开
      info.mag = add(bgeo(0.001, 0.001, 0.001), metal, 0, 0.05, -0.02);
    } else {
      info.slide = add(bgeo(0.03, 0.032, 0.2), body, 0, 0.05, -0.07);   // 套筒：击发时后坐、空仓挂机
      add(bgeo(0.028, 0.025, 0.16), metal, 0, 0.022, -0.06);
      add(bgeo(0.03, 0.1, 0.045), furn, 0, -0.03, 0.03, 0.25);
      add(bgeo(0.005, 0.03, 0.04), metal, 0, 0.0, -0.035);
      add(bgeo(0.004, 0.01, 0.008), metal, 0, 0.071, -0.16);
      // 照门改成"底座 + 两耳"的缺口式：原先那块 20×10 的实心板顶面正好压在瞄准线上
      // （0.076 = info.sight.y），把准星整根挡在后面 —— ADS 看到的是一堵小墙而不是三点一线。
      // 缺口 0.065…0.083，容得下整根准星（0.066…0.076）且瞄准线在当中。
      add(bgeo(0.02, 0.006, 0.01), metal, 0, 0.062, 0.02);
      add(bgeo(0.005, 0.018, 0.01), metal, -0.0075, 0.074, 0.02);
      add(bgeo(0.005, 0.018, 0.01), metal, 0.0075, 0.074, 0.02);
      info.mag = add(bgeo(0.024, 0.09, 0.035), metal, 0, -0.03, 0.03, 0.25);
      info.muzzle.position.set(0, 0.05, -0.18);
      info.sight.set(0, 0.076, 0.03);
      info.eject.position.set(0.022, 0.058, -0.06);   // 套筒抛壳窗
      if (att.mag) info.mag.scale.y = 1.6;
    }
    if (att.muzzle === 'suppressor') { add(cgeo(0.018, 0.018, 0.14), mat('gunPoly'), 0, 0.05, -0.25); info.muzzle.position.z -= 0.14; }
    else if (att.muzzle) { add(cgeo(0.014, 0.014, 0.04), metal, 0, 0.05, -0.2); info.muzzle.position.z -= 0.04; }
    if (att.laser) {
      const small = att.laser === 'mw1';
      info.laserMod = add(bgeo(small ? 0.02 : 0.025, small ? 0.018 : 0.022, small ? 0.04 : 0.05), mat('gunPoly'), 0, 0.005, -0.12);
      addLaser(add, 0, 0.005, -0.146);
    }
    if (att.optic === 'reddot') {
      add(bgeo(0.03, 0.006, 0.04), metal, 0, 0.07, -0.02);
      add(bgeo(0.004, 0.035, 0.012), metal, -0.016, 0.09, -0.035);
      add(bgeo(0.004, 0.035, 0.012), metal, 0.016, 0.09, -0.035);
      add(bgeo(0.036, 0.004, 0.012), metal, 0, 0.108, -0.035);
      add(new THREE.PlaneGeometry(0.028, 0.03), mat('lens'), 0, 0.09, -0.035);
      // 分划点按**角直径**跟长枪对齐，不是照抄那个米数：这里分划离眼 0.076 m，长枪 0.1155 m。
      // 同一配件在两个枪型上要一样大（判据 test/optic.mjs 的 O6ᶜ）
      info.reticle = add(new THREE.CircleGeometry(0.00012, 10), mat('reticle'), 0, 0.09, -0.036);
      info.sight.set(0, 0.09, 0.04);
      info.optic = 'reddot';
    }
    info.leftHand.set(-0.01, -0.03, 0.02);
    root.add(info.muzzle);
    return info;
  }

  // ---------- 长枪 ----------
  const recv = M.recv, hand = M.hand;
  let barrel = M.barrel;
  if (att.barrel === 'long') barrel += 0.1;
  if (att.barrel === 'short') barrel -= 0.08;
  const zRear = 0.07, zFront = zRear - recv;
  const recvH = M.stock === 'scar' ? 0.075 : 0.065;
  // 机匣
  add(bgeo(0.052, recvH, recv), body, 0, 0.03, (zRear + zFront) / 2);
  add(bgeo(0.046, 0.04, recv * 0.8), metal, 0, -0.012, (zRear + zFront) / 2 + 0.02);
  const railY = 0.03 + recvH / 2;
  add(bgeo(0.024, 0.012, recv), metal, 0, railY + 0.006, (zRear + zFront) / 2);
  if (!low) {
    for (let i = 0; i < Math.floor(recv / 0.02); i++) add(bgeo(0.026, 0.004, 0.008), metal, 0, railY + 0.014, zRear - 0.01 - i * 0.02);
    add(bgeo(0.005, 0.025, 0.06), mat('gunSteel'), 0.027, 0.035, -0.03); // 抛壳窗
    info.bolt = add(bgeo(0.02, 0.01, 0.03), metal, 0.03, 0.045, zRear - 0.04); // 拉机柄：上膛时后拉
  }
  // 护木
  const hz0 = zFront, hz1 = zFront - hand;
  const handH = M.color === 'wood' ? 0.05 : 0.06;
  const forend = add(bgeo(0.056, handH, hand), furn, 0, 0.03, (hz0 + hz1) / 2);
  if (M.mag === 'tube') info.pump = forend;   // 泵动霰弹枪的护木就是护木：上膛时前后推
  if (!low && M.color !== 'wood') {
    for (let i = 0; i < 4; i++) add(bgeo(0.058, 0.006, 0.03), metal, 0, 0.03 + (i % 2 ? -0.012 : 0.012), hz0 - 0.03 - i * (hand / 4.5));
  }
  if (M.color !== 'wood') add(bgeo(0.022, 0.01, hand), metal, 0, 0.03 + handH / 2 + 0.005, (hz0 + hz1) / 2);
  info.leftHand.set(0, -0.005, hz0 - hand * 0.55);
  // 枪管
  const bz0 = hz1, bz1 = hz1 - barrel;
  // 枪管：凹槽管比标准管细一圈，外加 6 条纵向筋（真枪是车掉的槽，这里用筋做出同一件事的
  // "看得出这是凹槽管"）。以前 'fluted' 只改数值不改模型，装了等于没装。
  const flute = att.barrel === 'fluted';
  add(cgeo(flute ? 0.0082 : 0.0095, flute ? 0.0082 : 0.0095, barrel + 0.05), mat('gunMetal'), 0, 0.035, (bz0 + bz1) / 2 + 0.025);
  if (flute && !low) for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    add(bgeo(0.0024, 0.0024, barrel + 0.04), mat('gunSteel'), Math.cos(a) * 0.0086, 0.035 + Math.sin(a) * 0.0086, (bz0 + bz1) / 2 + 0.018);
  }
  let muzzleZ = bz1;
  if (M.mag === 'tube') add(cgeo(0.015, 0.015, hand + barrel * 0.7), metal, 0, 0.005, hz0 - (hand + barrel * 0.7) / 2);
  if (M.stock === 'ak' && M.color === 'wood') add(cgeo(0.012, 0.012, hand * 0.9), metal, 0, 0.07, (hz0 + hz1) / 2); // 导气管
  // 枪口
  const mz = att.muzzle;
  if (mz === 'suppressor') { add(cgeo(0.022, 0.022, 0.19, 16), mat('gunPoly'), 0, 0.035, muzzleZ - 0.095); muzzleZ -= 0.19; }
  else if (mz === 'comp') { add(bgeo(0.03, 0.03, 0.06), metal, 0, 0.035, muzzleZ - 0.03); muzzleZ -= 0.06; }
  else if (mz === 'brake') { add(cgeo(0.017, 0.017, 0.06), metal, 0, 0.035, muzzleZ - 0.03); add(bgeo(0.04, 0.008, 0.02), metal, 0, 0.035, muzzleZ - 0.03); muzzleZ -= 0.06; }
  else if (mz === 'flash') { add(cgeo(0.014, 0.018, 0.07), metal, 0, 0.035, muzzleZ - 0.035); muzzleZ -= 0.07; }
  else { add(cgeo(0.013, 0.013, 0.04), metal, 0, 0.035, muzzleZ - 0.02); muzzleZ -= 0.04; }
  info.muzzle.position.set(0, 0.035, muzzleZ);
  // 抛壳口锚点：贴着那扇抛壳窗（gunmodel 上方 0.027, 0.035, -0.03）的外侧，
  // 稍微外推以免弹壳生成时嵌在窗框里。low 简模没有窗，但锚点照样要给（第三人称也抛壳）。
  info.eject.position.set(0.038, 0.042, -0.03);
  // 机械瞄具
  const optic = att.optic || (def.defaultOptic && !att.optic ? def.defaultOptic : null);
  const sightY = railY + 0.035;
  if (!optic) {
    add(bgeo(0.004, 0.03, 0.006), metal, 0, railY + 0.019, hz1 + 0.02);
    add(bgeo(0.02, 0.012, 0.012), metal, 0, railY + 0.006, hz1 + 0.02);
    // 照门 = 底座 + 两耳，中间留 11mm 缺口。原先是一整块 22×22 的实心铁（顶面 railY+0.031），
    // 正好横在瞄准线（railY+0.034）下面 3mm —— 从眼位看过去就是准星后面一堵矮墙。
    // 缺口要容得下整根准星（柱顶到柱脚），并且瞄准线落在缺口当中：
    // 缺口 railY+0.020…0.044，瞄准线 railY+0.034，上下各留 1cm 余量给摆动。
    // 判据 test/viewmodel.mjs 的 S1：眼位→准星的光路不许被照门挡住（±8mm 三条）。
    add(bgeo(0.022, 0.008, 0.016), metal, 0, railY + 0.016, zRear - 0.02);
    add(bgeo(0.0055, 0.024, 0.016), metal, -0.00825, railY + 0.032, zRear - 0.02);
    add(bgeo(0.0055, 0.024, 0.016), metal, 0.00825, railY + 0.032, zRear - 0.02);
    info.sight.set(0, railY + 0.034, zRear + 0.13);
  }
  // 瞄具
  info.optic = optic || 'iron';
  const oz = zRear - recv * 0.45;
  if (optic === 'reddot') {
    add(bgeo(0.03, 0.012, 0.04), metal, 0, railY + 0.018, oz);
    // 镜筒：开口管 + 双面壁，两端各留一个通透的口（见本文件开头的注释）
    add(tgeo(0.02, 0.02, 0.042, 20), mat('gunTube'), 0, sightY, oz);
    // 镜片与分划都收进筒里（原先飘在筒口外面 1mm，从侧面看像粘上去的一块盖片）
    add(new THREE.CircleGeometry(0.0175, 20), mat('lens'), 0, sightY, oz - 0.017);
    // 分划点：0.0009 → 0.00018（2026-09-27，嫌 ADS 下太大）。这件事要用**角直径**说话，不能用米数：
    // 同一个 MRS 配件装在手枪上时，分划离眼只有 0.076 m、这里是 0.1155 m，照抄这个常数会让它大一倍半
    // —— 所以手枪那处取 0.00012 而不是 0.00018。改完实测 ø 0.179°，1080p ADS 下约 4.8 px；
    // 上下限 0.08°/0.30° 由 test/optic.mjs 的 O6 钉住（太小看不见、太大糊成饼，两个方向都要红）。
    info.reticle = add(new THREE.CircleGeometry(0.00018, 10), mat('reticle'), 0, sightY, oz - 0.0155);
    info.sight.set(0, sightY, oz + 0.1);
  } else if (optic === 'holo') {
    add(bgeo(0.04, 0.016, 0.07), metal, 0, railY + 0.02, oz);
    add(bgeo(0.005, 0.04, 0.05), metal, -0.021, sightY + 0.005, oz - 0.01);
    add(bgeo(0.005, 0.04, 0.05), metal, 0.021, sightY + 0.005, oz - 0.01);
    add(bgeo(0.047, 0.005, 0.05), metal, 0, sightY + 0.026, oz - 0.01);
    add(new THREE.PlaneGeometry(0.036, 0.034), mat('lens'), 0, sightY + 0.004, oz - 0.03);
    const ret = new THREE.Group(); ret.position.set(0, sightY, oz - 0.031); root.add(ret);
    add(new THREE.RingGeometry(0.0045, 0.0052, 24), mat('reticle'), 0, 0, 0, 0, 0, 0, ret);
    // 中心点：0.0007 → 0.00035（2026-09-27，嫌太大）。与红点一样按**角直径**说话：
    // 这处分划离眼 0.151 m（红点 0.1155 m），改完 ø0.266°，1080p ADS 下约 7.2 px。
    // 上下限仍由 test/optic.mjs 的 O6ᵉ 钉着。
    add(new THREE.CircleGeometry(0.00035, 8), mat('reticle'), 0, 0, 0, 0, 0, 0, ret);
    info.reticle = ret;
    info.sight.set(0, sightY, oz + 0.12);
  } else if (optic === 'acog' || optic === 'thermal') {
    add(bgeo(0.03, 0.02, 0.05), metal, 0, railY + 0.02, oz);
    // 主镜筒/物镜锥/目镜锥一律开口管：这三段原本都是实心 cgeo，从枪口方向看过去
    // 从枪口方向看过去就是三根摞在一起的金属柱（镜身 + 物镜镯 + 目镜镯），
    add(tgeo(0.019, 0.019, 0.12, 16), mat('gunTube'), 0, sightY + 0.005, oz);
    add(tgeo(0.024, 0.019, 0.03, 16), mat('gunTube'), 0, sightY + 0.005, oz - 0.07);
    add(tgeo(0.022, 0.019, 0.025, 16), mat('gunTube'), 0, sightY + 0.005, oz + 0.065);
    if (optic === 'thermal') add(bgeo(0.03, 0.03, 0.05), mat('gunPoly'), 0.025, sightY + 0.005, oz + 0.02);
    // 物镜片塞进物镜锥里（原来飘在锥口外 1mm）
    add(new THREE.CircleGeometry(0.021, 16), mat('lensDark'), 0, sightY + 0.005, oz - 0.082);
    info.sight.set(0, sightY + 0.005, oz + 0.14);
  } else if (optic === 'sniper') {
    const sy = sightY + 0.018;
    add(bgeo(0.02, 0.03, 0.02), metal, 0, railY + 0.02, oz - 0.06);
    add(bgeo(0.02, 0.03, 0.02), metal, 0, railY + 0.02, oz + 0.06);
    add(tgeo(0.016, 0.016, 0.26, 16), mat('gunTube'), 0, sy, oz);
    add(tgeo(0.028, 0.017, 0.08, 16), mat('gunTube'), 0, sy, oz - 0.15);
    add(tgeo(0.022, 0.016, 0.05, 16), mat('gunTube'), 0, sy, oz + 0.14);
    // 上方的调节旋钮：骑在筒顶，不许伸进通光孔 —— 老位置 sy+0.025 让它的底面戳进内壁 6mm，
    // 于是从眼里斜穿镜筒的那条光路会被它挡住一格（test/optic.mjs 的 O1 就是靠这条发现的）
    add(cgeo(0.02, 0.02, 0.03, 12), metal, 0, sy + 0.042, oz, Math.PI / 2);
    add(new THREE.CircleGeometry(0.023, 16), mat('lensDark'), 0, sy, oz - 0.185);
    info.sight.set(0, sy, oz + 0.2);
  }
  // 激光
  if (att.laser) {
    // 两种激光模块各是各的：1mW（mw1）小方块，5mW（tac）大一号带散热片。以前两者同一个模型。
    const small = att.laser === 'mw1';
    info.laserMod = add(bgeo(small ? 0.018 : 0.022, small ? 0.02 : 0.025, small ? 0.045 : 0.06), mat('gunPoly'), 0.038, 0.03, hz1 + 0.05);
    if (!small) add(bgeo(0.024, 0.004, 0.05), mat('gunSteel'), 0.038, 0.045, hz1 + 0.05);
    addLaser(add, 0.038, 0.03, hz1 + 0.019);
  }
  // 下挂
  if (att.under === 'vgrip') add(bgeo(0.03, 0.09, 0.03), mat('gunPoly'), 0, -0.035, hz0 - hand * 0.55);
  else if (att.under === 'agrip') add(bgeo(0.03, 0.035, 0.08), mat('gunPoly'), 0, -0.01, hz0 - hand * 0.5, -0.4);
  else if (att.under === 'bipod') {
    add(bgeo(0.035, 0.02, 0.03), metal, 0, -0.005, hz1 + 0.03);
    add(cgeo(0.006, 0.006, 0.16), metal, -0.012, -0.015, hz1 + 0.1, -0.12);
    add(cgeo(0.006, 0.006, 0.16), metal, 0.012, -0.015, hz1 + 0.1, -0.12);
  }
  if (att.under) info.leftHand.set(0, -0.06, hz0 - hand * 0.55);
  // 握把
  // 握把也吃迷彩，否则迷彩只糊了护木和枪托，握把留一块原色。三种胶带各是各的材质。
  const gripM = camoMaterial(camo, att.rear === 'rubber' ? mat('rubber') : att.rear === 'grain' ? mat('gripGrain') : att.rear === 'stip' ? mat('gripStip') : furnBase === mat('gunWood') ? mat('gunPoly') : furnBase);
  if (M.grip === 'sniper') info.grip = add(bgeo(0.03, 0.09, 0.045), gripM, 0, -0.035, 0.07, 0.35);
  else info.grip = add(bgeo(0.028, 0.095, 0.04), gripM, 0, -0.04, 0.035, 0.3);
  add(bgeo(0.006, 0.006, 0.07), metal, 0, -0.032, -0.005); // 扳机护圈
  // 弹匣
  const magG = new THREE.Group(); magG.position.set(0, -0.01, -0.035); root.add(magG);
  info.mag = magG;
  const ext = att.mag === 'ext' ? 1.45 : 1;
  const mm = mat('gunMetal');
  if (att.mag === 'drum') {
    add(cgeo(0.075, 0.075, 0.07, 20), mm, 0, -0.1, 0, 0, Math.PI / 2, 0, magG);
    add(bgeo(0.028, 0.06, 0.05), mm, 0, -0.03, 0, 0, 0, 0, magG);
  } else if (M.mag === 'straight' || M.mag === 'pistol_long') {
    const L = (M.mag === 'pistol_long' ? 0.15 : 0.17) * ext;
    add(bgeo(0.026, L, 0.065), M.color === 'tan' && M.mag === 'straight' ? mat('gunTan') : mm, 0, -L / 2, 0, 0.12, 0, 0, magG);
    if (att.mag === 'fast') add(bgeo(0.026, L, 0.065), mm, 0.03, -L / 2, 0, 0.12, 0, 0, magG);
  } else if (M.mag === 'curved' || M.mag === 'curved_small') {
    // 香蕉弹匣沿弧线走链：每段中心 = 顶点沿**该段自己的朝向**下移半段高，走完整段
    // 再加下一角的转量 —— 相邻两段的弦向恒等于两段转角的均值，侧视是连续的弧。
    // 旧写法每段多转 0.1 rad、位置却按 i² 独立前探，转角与弦线对不上，侧视是锯齿
    // 楼梯、底段翘近 30°；末端还是个平齐断口 —— 现在底板顺末段角度收尾（S11 及其反证臂）。
    // 材质就传 magM：原来写的是 `magM === mm ? mm : mat('gunMetal')`，AK 那支恒为假，
    // 于是橙色胶木意图一个像素都没生效，12 把枪的弹匣全是同一种深灰。
    const small = M.mag === 'curved_small';
    const n = Math.round((small ? 4 : 5) * ext);
    const h = small ? 0.04 : 0.042, depth = small ? 0.04 : 0.06;
    const a0 = small ? 0.04 : 0.06, da = small ? 0.05 : 0.07;
    const magM = weaponId === 'ak' ? mat('containerOrange') : mm;
    const chain = (x0) => {
      let a = a0, y = 0, z = 0;
      for (let i = 0; i < n; i++) {
        add(bgeo(0.026, h + 0.004, depth), magM, x0, y - Math.cos(a) * h / 2, z - Math.sin(a) * h / 2, a, 0, 0, magG);
        y -= Math.cos(a) * h; z -= Math.sin(a) * h; a += da;
      }
      add(bgeo(0.034, 0.014, depth + 0.012), magM, x0, y - Math.cos(a - da) * 0.007, z - Math.sin(a - da) * 0.007, a - da, 0, 0, magG);
    };
    chain(0);
    if (att.mag === 'fast') chain(0.03);
  } else if (M.mag === 'box') {
    add(bgeo(0.1, 0.11, 0.12), mat('gunGreen'), -0.03, -0.07, 0, 0, 0, 0, magG);
    add(bgeo(0.03, 0.02, 0.1), mm, 0.02, 0.03, 0, 0, 0, 0, magG);
  } else if (M.mag === 'box5' || M.mag === 'box10') {
    const L = (M.mag === 'box10' ? 0.07 : 0.06) * ext;
    add(bgeo(0.03, L, 0.08), mm, 0, -L / 2, 0, 0, 0, 0, magG);
    if (att.mag === 'fast') add(bgeo(0.03, L, 0.08), mm, 0.035, -L / 2, 0, 0, 0, 0, magG);
  } else if (M.mag === 'tube') {
    magG.position.set(0, -0.02, -0.03);
    add(bgeo(0.02, 0.012, 0.03), mat('brass'), 0, 0, 0, 0, 0, 0, magG);
  }
  // 枪托
  const st = att.stock || null;
  const sz = zRear;
  if (st === 'none') {
    add(bgeo(0.03, 0.04, 0.03), metal, 0, 0.03, sz + 0.015);
  } else {
    const kind = st === 'heavy' ? 'heavy' : st === 'tac' ? 'tac' : M.stock;
    const sm = furn;
    if (kind === 'm4' || kind === 'tac') {
      add(cgeo(0.016, 0.016, 0.2), metal, 0, 0.03, sz + 0.1);
      add(bgeo(0.045, 0.09, 0.14), sm, 0, 0.005, sz + 0.2);
      add(bgeo(0.047, 0.1, 0.02), mat('rubber'), 0, 0.0, sz + 0.28);
      if (kind === 'tac') add(bgeo(0.03, 0.03, 0.1), sm, 0, 0.06, sz + 0.2);
    } else if (kind === 'ak' || kind === 'fixed') {
      const g = new THREE.Group(); g.position.set(0, 0.015, sz); g.rotation.x = kind === 'ak' ? -0.12 : -0.06; root.add(g);
      add(bgeo(0.042, 0.06, 0.2), sm, 0, 0, 0.1, 0, 0, 0, g);
      add(bgeo(0.044, 0.11, 0.12), sm, 0, -0.02, 0.24, 0, 0, 0, g);
      add(bgeo(0.046, 0.12, 0.015), mat('gunPoly'), 0, -0.02, 0.305, 0, 0, 0, g);
    } else if (kind === 'mp5') {
      add(bgeo(0.008, 0.008, 0.22), metal, -0.02, 0.04, sz + 0.11);
      add(bgeo(0.008, 0.008, 0.22), metal, 0.02, 0.04, sz + 0.11);
      add(bgeo(0.05, 0.08, 0.02), metal, 0, 0.02, sz + 0.22);
    } else if (kind === 'scar') {
      add(bgeo(0.045, 0.06, 0.12), sm, 0, 0.035, sz + 0.06);
      add(bgeo(0.045, 0.11, 0.1), sm, 0, 0.01, sz + 0.17);
      add(bgeo(0.048, 0.12, 0.02), mat('rubber'), 0, 0.01, sz + 0.23);
    } else if (kind === 'sniper' || kind === 'heavy') {
      add(bgeo(0.05, 0.07, 0.26), sm, 0, 0.01, sz + 0.13);
      add(bgeo(0.05, 0.13, 0.12), sm, 0, -0.01, sz + 0.24);
      add(bgeo(0.04, 0.025, 0.14), sm, 0, 0.06, sz + 0.16);
      add(bgeo(0.052, 0.14, 0.02), mat('rubber'), 0, -0.01, sz + 0.31);
    }
  }
  root.add(info.muzzle);
  return info;
}

function addLaser(add, x, y, z) {
  add(new THREE.CircleGeometry(0.004, 8), mat('laserDot'), x, y, z, 0, Math.PI, 0);
}

// 第一人称手臂
//
// 左臂是**可重摆的两骨链**，因为换弹时副手要离开护木去抓弹匣：手臂以前是枪组的
// 刚性子件，弹匣在手里下坠、消失、再回来，而两只手纹丝不动（test/viewmodel.mjs 的 H1）。
// 骨长（L1/L2）烤死在胶囊几何里不许变 —— 只摆位姿，所以永远合身。
const _armV = new THREE.Vector3(), _armV2 = new THREE.Vector3();
export function buildArms(gunInfo, sleeveMat) {
  const g = new THREE.Group();
  const glove = mat('glove');
  const limb = (a, b, r, m) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const geo = new THREE.CapsuleGeometry(r, len, 4, 10);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    g.add(mesh);
    return mesh;
  };
  // 只改位姿，不改几何（骨长恒定）
  const pose = (mesh, a, b) => {
    const dir = _armV.subVectors(b, a);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  };
  // 右手（握把）—— 扣扳机的手不参与换弹，保持刚性
  const rh = new THREE.Vector3(0.0, -0.035, 0.05);
  const re = new THREE.Vector3(0.1, -0.16, 0.22);
  const rs = new THREE.Vector3(0.16, -0.3, 0.5);
  limb(rh, re, 0.032, glove);
  limb(re.clone().lerp(rh, 0.35), re, 0.042, sleeveMat);
  limb(re, rs, 0.055, sleeveMat);
  const rhand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.09), glove); rhand.position.copy(rh).add(new THREE.Vector3(0.012, 0, 0)); g.add(rhand);
  // 左手（护木）
  const lh = gunInfo.leftHand.clone().add(new THREE.Vector3(-0.012, -0.015, 0));
  const le = new THREE.Vector3(-0.14, -0.14, lh.z + 0.2);
  const ls = new THREE.Vector3(-0.22, -0.3, lh.z + 0.55);
  const lfore = limb(lh, le, 0.032, glove);
  const lsleeve = limb(le.clone().lerp(lh, 0.3), le, 0.042, sleeveMat);
  const lupper = limb(le, ls, 0.055, sleeveMat);
  const lhand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.1), glove); lhand.position.copy(lh); lhand.rotation.z = 0.5; g.add(lhand);
  g.traverse(o => { if (o.isMesh) o.castShadow = false; });

  const L1 = le.distanceTo(ls), L2 = lh.distanceTo(le);
  // 肘往侧下方弯（pole），跟人手自然持枪一致
  const pole = new THREE.Vector3(-0.7, -0.8, 0.1);
  // 两骨 IK：给手的目标位置反解肘。目标超长就夹到够得着的最远处（不许把骨头拉长）。
  const poseLeft = (target) => {
    const d = _armV.subVectors(target, ls);
    const want = d.length() || 1e-5;
    const dist = Math.min((L1 + L2) * 0.995, Math.max(Math.abs(L1 - L2) + 0.02, want));
    d.multiplyScalar(dist / want);
    const u = _armV2.copy(d).normalize();
    const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const p = pole.clone().addScaledVector(u, -pole.dot(u));
    if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(u, u.y);
    p.normalize();
    const elbow = ls.clone().addScaledVector(u, a).addScaledVector(p, h);
    const hand = ls.clone().add(d);
    pose(lupper, elbow, ls);
    pose(lfore, hand, elbow);
    pose(lsleeve, elbow.clone().lerp(hand, 0.3), elbow);
    lhand.position.copy(hand);
    return hand;
  };
  return { group: g, leftHome: lh.clone(), handMesh: lhand, poseLeft };
}
