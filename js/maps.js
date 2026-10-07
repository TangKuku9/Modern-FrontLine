// 地图定义
import * as THREE from 'three';
import { mulberry32, pick } from './util.js';
import { shape as ridgeShape, color as ridgeColor, SITE as RIDGE, Y as RIDGE_Y, CORRIDOR as RIDGE_ROADS, RAMPS as RIDGE_RAMPS, FLAG_POS as RIDGE_FLAGS } from './maps/ridges.js';

const V = (x, z) => new THREE.Vector3(x, 0, z);

export const MAPS = {
  // ================= 沙丘镇 =================
  dune: {
    id: 'dune', name: '沙丘镇', size: 110, seed: 11, surface: 'sand', styles: ['ally', 'insurgent'],
    env: { sky: 'day', sunDir: [0.55, 0.62, 0.35], sunColor: 0xfff0d8, sun: 3.4, hemi: 0.75, sky2: 0xcfe2ff, ground: 0xb08a5a, fog: 0xd8c6a6, fogDensity: 0.0065, turbidity: 9, rayleigh: 1.3, mie: 0.006, exposure: 0.85, mountains: 'sand', envIntensity: 0.75, weather: 'dust', ambient: 'wind' },
    build(w) {
      w.ground('sand');
      w.bounds();
      // 主街道
      w.box(0, 0, 0, 104, 0.02, 9, 'dirt', { collide: false });
      // 北排建筑
      const N = [[-38, -15, 10, 10, 4.5, 'plaster'], [-24, -14, 9, 8, 4, 'plasterWhite'], [-8, -14, 12, 10, 4, 'plaster'], [8, -14, 9, 8, 5, 'plasterRed'], [22, -15, 10, 10, 4.2, 'plasterWhite'], [37, -14, 10, 8, 4.5, 'plaster']];
      N.forEach(([x, z, bw, bd, h, m], i) => {
        w.building(x, z, bw, bd, h, { mat: m, doors: { s: [i % 2 ? -1.5 : 1.5], n: [0] }, windows: { s: [i % 2 ? 2.5 : -2.5], e: [0], w: [0] }, parapet: i !== 2, roofMat: 'concreteDark', floor: 'tiles' });
      });
      // 可上的屋顶楼梯
      w.stairs(-5, -19.85, 1.4, 6, 4, 'e', 'concrete');
      // 南排
      const S = [[-37, 15, 10, 9, 4, 'plasterWhite'], [-23, 14, 9, 8, 4.6, 'plaster'], [-9, 15, 10, 9, 4, 'plasterRed'], [9, 15, 12, 9, 4.2, 'plaster'], [24, 14, 9, 8, 4, 'plasterBlue'], [38, 15, 10, 10, 4.8, 'plaster']];
      S.forEach(([x, z, bw, bd, h, m], i) => {
        w.building(x, z, bw, bd, h, { mat: m, doors: { n: [i % 2 ? 1.5 : -1.5], s: [0] }, windows: { n: [i % 2 ? -2.5 : 2.5], e: [0], w: [0] }, parapet: true, floor: 'tiles' });
      });
      // 集市摊位
      const cloths = ['clothRed', 'clothBlue', 'clothYellow', 'clothGreen'];
      [[-5, -3], [0, -3], [5, -3], [-5, 3], [0, 3], [5, 3]].forEach(([x, z], i) => {
        w.box(x, 0, z, 2.6, 0.9, 1.2, 'wood');
        w.awning(x, z + (z < 0 ? -0.2 : 0.2), 3, 1.8, 2.3, cloths[i % 4], z < 0 ? 0 : Math.PI);
        w.crate(x + 1.6, z, 0.7);
      });
      // 街道掩体
      w.car(-20, 1.5, 0.2, 0x7a6a50, true);
      w.car(16, -2, Math.PI + 0.1, 0x3a4a5a, true);
      w.jersey(-30, -2); w.jersey(30, 2);
      w.sandbags(-44, -3, 3, Math.PI / 2); w.sandbags(44, 3, 3, Math.PI / 2);
      w.crateStack(-14, 3); w.crateStack(12, -3.5);
      w.barrel(-11, -3, 'containerBlue'); w.barrel(26, 3, 'containerOrange'); w.barrel(26.7, 3.3, 'containerBlue');
      // 北部区域
      w.building(0, -38, 14, 12, 6, { mat: 'plasterWhite', doors: { s: [0], e: [2], w: [-2] }, windows: { s: [-4, 4], n: [-3, 3] }, parapet: true, floor: 'tiles' });
      const dome = w.mesh(new THREE.SphereGeometry(4.2, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), 'plasterBlue', 0, 6.3, -38);
      w.box(8.5, 0, -42, 2, 11, 2, 'plasterWhite');
      w.mesh(new THREE.ConeGeometry(1.3, 2.5, 8), 'plasterBlue', 8.5, 12.2, -42);
      w.wall(-30, -28, -12, -28, 2.4, 0.4, 'plaster', [{ c: 9, w: 2.5, y0: 0, y1: 2.4 }]);
      w.wall(12, -28, 30, -28, 2.4, 0.4, 'plaster', [{ c: 6, w: 2.5, y0: 0, y1: 2.4 }]);
      w.building(-32, -40, 10, 9, 4, { mat: 'plaster', doors: { e: [0], s: [2] }, windows: { n: [0] }, parapet: true });
      w.building(32, -40, 10, 9, 4, { mat: 'plasterRed', doors: { w: [0], s: [-2] }, windows: { n: [0] }, parapet: true });
      w.car(-18, -34, Math.PI / 2, 0x9a2020, false);
      w.tree(-20, -45, 1, 'palm'); w.tree(18, -46, 1.1, 'palm'); w.tree(-45, -30, 0.9, 'palm'); w.tree(46, -28, 1, 'palm');
      w.crateStack(20, -33); w.sandbags(-8, -30, 4, 0);
      // 南部区域
      w.wall(-48, 28, -14, 28, 2.2, 0.4, 'plasterWhite', [{ c: 12, w: 3, y0: 0, y1: 2.2 }, { c: 26, w: 2.4, y0: 0, y1: 2.2 }]);
      w.wall(14, 28, 48, 28, 2.2, 0.4, 'plaster', [{ c: 8, w: 3, y0: 0, y1: 2.2 }, { c: 24, w: 2.4, y0: 0, y1: 2.2 }]);
      w.building(-28, 40, 12, 10, 4.5, { mat: 'plaster', doors: { n: [0], e: [0] }, windows: { w: [0], s: [0] }, parapet: true });
      w.building(28, 40, 12, 10, 4.2, { mat: 'plasterWhite', doors: { n: [0], w: [0] }, windows: { e: [0], s: [0] }, parapet: true });
      w.car(0, 38, 0.5, 0x6a6a6a, true); w.car(-8, 33, -1.2, 0x2a3a5a, true);
      w.box(8, 0, 40, 4, 3, 4, 'concreteDark');
      w.sandbags(0, 30, 5, 0); w.barrier(-6, 44); w.barrier(6, 45, Math.PI / 2);
      w.tree(-45, 45, 1, 'palm'); w.tree(45, 45, 1, 'palm'); w.tree(14, 48, 0.9, 'palm');
      w.rock(-50, 20, 1.5, 'rock'); w.rock(50, -20, 1.8, 'rock'); w.rock(40, 25, 1.2, 'rock');
      // 出生点
      w.spawns.A = [V(-50, -3), V(-50, 3), V(-48, 8), V(-48, -8), V(-45, 22), V(-45, -22), V(-50, 0), V(-47, 36)];
      w.spawns.B = [V(50, -3), V(50, 3), V(48, 8), V(48, -8), V(45, 22), V(45, -22), V(50, 0), V(47, -36)];
      w.flagPos = [V(-36, 0), V(0, 0), V(36, 0)];
    },
  },

  // ================= 寒霜炼厂 =================
  frost: {
    id: 'frost', name: '寒霜炼厂', size: 120, seed: 21, surface: 'snow', styles: ['snowA', 'snowB'],
    env: { sky: 'day', sunDir: [-0.3, 0.35, -0.6], sunColor: 0xdde6f5, sun: 1.3, hemi: 0.8, sky2: 0xdfe8f5, ground: 0x9aa3ad, fog: 0xc4ccd6, fogDensity: 0.016, turbidity: 18, rayleigh: 0.6, mie: 0.05, exposure: 0.82, mountains: 'rockSnow', envIntensity: 0.7, weather: 'snow', ambient: 'wind' },
    build(w) {
      w.ground('snow');
      w.bounds();
      w.box(0, 0, 0, 116, 0.02, 8, 'asphalt', { collide: false });
      w.box(0, 0, 0, 8, 0.02, 116, 'asphalt', { collide: false });
      // 仓库1
      w.building(-28, -26, 26, 16, 8, { mat: 'metal', roofMat: 'metalRoof', doors: { s: [-6, 6], e: [0], w: [0], n: [0] }, windows: { n: [-8, 8] }, floor: 'concrete', light: 0xcfe0ff });
      w.box(-34, 0, -26, 6, 2.6, 2.4, 'containerBlue'); w.crateStack(-22, -28); w.crate(-26, -22, 1.2); w.box(-30, 0, -31, 8, 1.2, 1.2, 'wood');
      w.box(-20, 0, -20, 1.2, 3, 4, 'metal');
      // 仓库2
      w.building(28, 26, 22, 18, 7, { mat: 'containerGray', roofMat: 'metalRoof', doors: { n: [-5, 5], w: [0], e: [-3], s: [3] }, windows: { s: [-6] }, floor: 'concrete', light: 0xcfe0ff });
      w.box(24, 0, 28, 6, 2.6, 2.4, 'containerRed'); w.crateStack(32, 22); w.box(30, 0, 31, 1.2, 1.5, 6, 'wood');
      // 储油罐
      w.tank(20, -32, 5, 9, 'metal'); w.tank(36, -32, 4.5, 8, 'metal'); w.tank(28, -46, 4, 7, 'metal');
      w.pipe(10, -24, 44, -24, 3.2, 0.35); w.pipe(12, -38, 12, -50, 1.2, 0.5);
      // 行政楼
      w.building(-30, 26, 16, 10, 4, { mat: 'brick', doors: { n: [0], e: [0] }, windows: { n: [-5, 5], s: [-4, 0, 4], w: [0] }, parapet: true, floor: 'tiles', light: 0xffd9a0 });
      w.building(-30, 42, 10, 8, 3.6, { mat: 'brickDark', doors: { n: [2], w: [0] }, windows: { e: [0] }, parapet: true });
      // 集装箱区
      const cols = ['containerRed', 'containerBlue', 'containerGreen', 'containerOrange', 'containerGray', 'containerYellow'];
      const r = mulberry32(5);
      [[-10, -10, 0], [-10, -16, 0], [12, 10, Math.PI / 2], [16, 12, Math.PI / 2], [-14, 12, 0], [8, -12, Math.PI / 2], [-45, 0, Math.PI / 2], [46, 0, Math.PI / 2], [0, 44, 0], [4, -46, 0]].forEach(([x, z, rot]) => w.container(x, z, rot, cols[Math.floor(r() * cols.length)]));
      w.container(-10, -10, 0, 'containerYellow', 2.6);
      w.container(16, 12, Math.PI / 2, 'containerGreen', 2.6);
      w.jersey(-6, 5); w.jersey(6, -5); w.jersey(20, 3, Math.PI / 2); w.jersey(-20, -3, Math.PI / 2);
      w.sandbags(0, 14, 4); w.sandbags(0, -14, 4);
      w.truck(-6, 30, Math.PI / 2, 0x8a8f94); w.truckCollider(-6, 30, Math.PI / 2);
      w.car(40, 8, 0.1, 0x223344); w.car(-40, -8, Math.PI, 0x552222);
      w.pipe(-50, 12, -16, 12, 2.8, 0.3);
      for (let i = 0; i < 22; i++) {
        const a = r() * Math.PI * 2, d = 50 + r() * 7;
        w.tree(Math.cos(a) * d, Math.sin(a) * d, 0.9 + r() * 0.5, 'pineSnow');
      }
      w.tree(-8, 50, 1.2, 'pineSnow'); w.tree(40, 46, 1.1, 'pineSnow'); w.tree(-50, -44, 1.3, 'pineSnow');
      w.rock(-20, 45, 1.6, 'rockSnow'); w.rock(46, -12, 1.4, 'rockSnow'); w.rock(-48, 30, 1.2, 'rockSnow');
      w.lampPost(-4, 20, 0xcfe0ff, Math.PI / 2, 12); w.lampPost(4, -22, 0xcfe0ff, -Math.PI / 2, 12);
      w.spawns.A = [V(-54, -4), V(-54, 4), V(-52, 14), V(-52, -14), V(-50, 34), V(-50, -38), V(-54, 22)];
      w.spawns.B = [V(54, -4), V(54, 4), V(52, 14), V(52, -14), V(50, 38), V(50, -38), V(54, -22)];
      w.flagPos = [V(-30, 8), V(0, 0), V(30, -8)];
    },
  },

  // ================= 霓虹街区 =================
  neon: {
    id: 'neon', name: '霓虹街区', size: 100, seed: 31, surface: 'wet', night: false, styles: ['ally', 'urbanB'],
    env: { sky: 'night', sunDir: [-0.35, 0.65, -0.45], sunColor: 0x8ea8ff, sun: 0.45, hemi: 1.1, sky2: 0x505a90, ground: 0x2a2020, fog: 0x1a1630, fogDensity: 0.022, exposure: 1.45, envIntensity: 1.0, weather: 'rain', skyTop: 0x05060d, skyHorizon: 0x1e1830, cityGlow: 0x4a2050, ambient: 'rain' },
    build(w) {
      w.ground('asphaltWet');
      w.bounds();
      // 人行道
      const sw = (x, z, sx, sz) => w.box(x, 0, z, sx, 0.15, sz, 'sidewalk');
      sw(-28, -8, 44, 3); sw(28, -8, 44, 3); sw(-28, 8, 44, 3); sw(28, 8, 44, 3);
      sw(-8, -28, 3, 38); sw(8, -28, 3, 38); sw(-8, 28, 3, 38); sw(8, 28, 3, 38);
      // 车道线
      for (let i = -48; i < 48; i += 6) { w.box(i, 0.005, 0, 3, 0.01, 0.15, 'yellowPaint', { collide: false }); w.box(0, 0.005, i, 0.15, 0.01, 3, 'yellowPaint', { collide: false }); }
      for (let i = -4; i <= 4; i += 1.2) { w.box(i, 0.005, -11.5, 0.6, 0.01, 3, 'whitePaint', { collide: false }); }
      const lit = () => Math.random() < 0.35 ? 'windowLit' : 'windowDark';
      // 西北
      w.building(-15, -15, 10, 8, 4.5, { mat: 'concrete', doors: { s: [0], e: [0] }, windows: { s: [-3.2, 3.2], n: [0] }, floor: 'tiles', light: 0xffc890 });
      w.block(-15, -33, 12, 22, 20, 'brickDark', { windows: true, windowMat: lit });
      w.block(-38, -18, 14, 16, 16, 'concrete', { windows: true, windowMat: lit });
      w.block(-40, -40, 16, 24, 16, 'brick', { windows: true, windowMat: lit });
      w.box(-27, 0, -20, 1.5, 1.4, 3, 'containerGreen'); w.crate(-26, -28, 1); w.box(-27.5, 0, -34, 2, 1.2, 1.2, 'darkMetal');
      // 东北
      w.block(18, -18, 16, 18, 16, 'concrete', { windows: true, windowMat: lit });
      w.building(38, -15, 12, 10, 4.2, { mat: 'brick', doors: { s: [0], w: [0] }, windows: { s: [-3.5, 3.5] }, floor: 'tiles', light: 0x9ad0ff });
      w.block(36, -38, 18, 26, 18, 'brickDark', { windows: true, windowMat: lit });
      w.block(16, -42, 12, 12, 12, 'concrete', { windows: true, windowMat: lit });
      w.box(27, 0, -30, 2, 1.4, 1.5, 'containerBlue'); w.crateStack(26, -25);
      // 西南
      w.block(-18, 18, 16, 20, 16, 'brick', { windows: true, windowMat: lit });
      w.building(-38, 15, 12, 10, 4.2, { mat: 'concreteDark', doors: { n: [0], e: [0] }, windows: { n: [-3.5, 3.5] }, floor: 'tiles', light: 0xff9ad0 });
      w.block(-38, 38, 18, 14, 16, 'concrete', { windows: true, windowMat: lit });
      w.car(-20, 36, 0.05, 0x1a1a1a); w.car(-14, 40, 0.1, 0x6a1010); w.car(-18, 44, Math.PI / 2, 0xd0d0d0);
      // 东南 广场
      w.box(28, 0, 28, 3, 0.6, 3, 'concrete'); // 喷泉底座
      w.mesh(new THREE.CylinderGeometry(3, 3.2, 0.6, 24), 'concrete', 22, 0.3, 22);
      w.collider(19.5, 0, 19.5, 24.5, 0.6, 24.5);
      w.mesh(new THREE.CylinderGeometry(0.4, 0.5, 2, 12), 'concrete', 22, 1.3, 22);
      [[14, 16], [30, 16], [14, 32], [36, 26], [26, 38]].forEach(([x, z]) => w.tree(x, z, 1, 'broad'));
      w.box(20, 0, 32, 4, 0.5, 0.6, 'wood'); w.box(32, 0, 20, 0.6, 0.5, 4, 'wood');
      w.building(40, 40, 10, 10, 4, { mat: 'concrete', doors: { n: [0], w: [0] }, windows: { n: [3] }, floor: 'tiles', light: 0xa0ffd0 });
      w.box(30, 0, 44, 6, 1.1, 0.5, 'concrete'); w.box(44, 0, 28, 0.5, 1.1, 6, 'concrete');
      // 街道车辆与掩体
      w.car(-30, -4, Math.PI / 2 + 0.1, 0x202a40); w.car(-2.5, -24, 0.05, 0xb8b020); w.car(3, 22, Math.PI - 0.1, 0x303030);
      w.car(26, 4, -Math.PI / 2, 0x8a1010); w.car(-44, 4, Math.PI / 2, 0x506070);
      // 公交车
      w.box(3.5, 0, -38, 2.6, 3, 11, 'containerOrange'); w.box(3.5, 1.4, -38, 2.65, 1, 10.5, 'windowLit', { collide: false });
      w.jersey(-18, 0, Math.PI / 2); w.jersey(18, 0, Math.PI / 2); w.jersey(0, 16); w.jersey(0, -16);
      w.barrier(-8.5, -3); w.barrier(8.5, 3);
      // 霓虹
      w.neon(-10.4, 5.5, -15, 4, 1.4, 0xff2aa0, Math.PI / 2);
      w.neon(-15, 5.6, -10.9, 5, 1.2, 0x20e0ff, 0);
      w.neon(32.7, 5, -15, 4, 1.2, 0xffe020, -Math.PI / 2);
      w.neon(-38, 5.5, 9.9, 5, 1.3, 0xa040ff, Math.PI);
      w.neon(-9.9, 8, 18, 5, 2, 0xff3040, Math.PI / 2);
      w.neon(9.9, 9, -18, 5, 2, 0x30ff90, -Math.PI / 2);
      w.neon(40, 4.8, 34.9, 4, 1, 0x20e0ff, Math.PI);
      // 灯光
      w.lampPost(-10.5, -30, 0xffd0a0, Math.PI / 2, 16); w.lampPost(10.5, 30, 0xffd0a0, -Math.PI / 2, 16);
      w.lampPost(-30, 10.5, 0xffd0a0, Math.PI, 16); w.lampPost(30, -10.5, 0xffd0a0, 0, 16);
      w.pointLight(-10.5, 5, -14, 0xff2aa0, 8, 14); w.pointLight(10.5, 8, -18, 0x30ff90, 8, 14);
      w.pointLight(-10.5, 7, 18, 0xff3040, 8, 14); w.pointLight(-38, 5, 9, 0xa040ff, 8, 12);
      w.spawns.A = [V(-46, -3), V(-46, 3), V(-44, -12), V(-44, 12), V(-30, 46), V(-46, 26), V(-30, -46)];
      w.spawns.B = [V(46, -3), V(46, 3), V(44, -12), V(44, 12), V(30, 46), V(46, 20), V(46, -26)];
      w.flagPos = [V(-28, 0), V(0, 0), V(26, 26)];
    },
  },

  // ================= 货柜场 =================
  yard: {
    id: 'yard', name: '货柜场', size: 56, seed: 41, surface: 'concrete', styles: ['ally', 'enemy'],
    env: { sky: 'day', sunDir: [-0.8, 0.14, 0.35], sunColor: 0xffa060, sun: 2.8, hemi: 0.55, sky2: 0x9a90c0, ground: 0x6a4a3a, fog: 0xc89070, fogDensity: 0.01, turbidity: 10, rayleigh: 3, mie: 0.02, exposure: 0.8, mountains: 'rock', envIntensity: 0.7, ambient: 'wind' },
    build(w) {
      w.ground('concrete');
      w.bounds();
      const cols = ['containerRed', 'containerBlue', 'containerGreen', 'containerOrange', 'containerGray', 'containerYellow'];
      const r = mulberry32(9);
      const grid = [];
      for (let gx = -2; gx <= 2; gx++) for (let gz = -2; gz <= 2; gz++) {
        if (gx === 0 && gz === 0) continue;
        if (Math.abs(gx) === 2 && gz === 0) continue;
        grid.push([gx * 9 + (r() - 0.5) * 2, gz * 9 + (r() - 0.5) * 2, r() < 0.5 ? 0 : Math.PI / 2]);
      }
      grid.forEach(([x, z, rot], i) => {
        w.container(x, z, rot, cols[i % cols.length]);
        if (r() < 0.3) w.container(x, z, rot, cols[(i + 3) % cols.length], 2.6);
      });
      for (let i = 0; i < 10; i++) w.crate((r() - 0.5) * 44, (r() - 0.5) * 44, 1.1 + r() * 0.3, 0, r());
      w.crateStack(-3, 3); w.crateStack(2, -4);
      // 龙门吊
      for (const x of [-26, 26]) {
        w.box(x, 0, -24, 1, 14, 1, 'yellowPaint'); w.box(x, 0, 24, 1, 14, 1, 'yellowPaint');
        w.box(x, 14, 0, 1.2, 1.2, 50, 'yellowPaint');
      }
      w.box(0, 14, -24, 53, 1.2, 1.2, 'yellowPaint', { collide: false }); w.box(0, 14, 24, 53, 1.2, 1.2, 'yellowPaint', { collide: false });
      w.lampPost(0, -26, 0xffd8a0, 0, 10, true);
      w.spawns.A = [V(-25, -8), V(-25, 0), V(-25, 8), V(-22, -20), V(-22, 20)];
      w.spawns.B = [V(25, -8), V(25, 0), V(25, 8), V(22, -20), V(22, 20)];
      w.flagPos = [V(-18, 0), V(0, 0), V(18, 0)];
    },
  },

  // ================= 双丘战区 =================
  // 360m 超大图。连绵丘陵 + 两处高地（各带瞭望塔）+ 一处平整军营。
  // 地形形状与逐顶点色在 js/maps/ridges.js；这里只负责"往上面摆东西"。
  //
  // **摆放原则：不随机撒点。** 这张图上每一件东西都属于某个语义分区 ——
  // 高地是争夺点、营区是补给点、道路是通路。rng 只在"同一语义的簇内"用
  // （哪棵树先歪、哪块石头大一点），不用来决定"东西该不该在这儿"。
  ridges: {
    id: 'ridges', name: '双丘战区', size: 360, seed: 71, surface: 'dirt',
    styles: ['ally', 'insurgent'],
    terrain: { shape: ridgeShape, cell: 2 },
    // 盘山路走廊：告诉导航网格"路在这儿"，圈内坡度上限放宽到 SLOPE.ROAD(0.62)。
    // 路是修出来的，比野地陡是应该的（现实里的盘山公路坡度远大于步行越野）。
    terrainRoads: RIDGE_RAMPS,
    // 路廊在**导航判定**上的半宽（米）。要盖住台基过渡带那一圈 ——
    // 实测台基终压（半径 9 / 过渡 46）在距台心约 20m 处留下 0.5~1.06 的坎，
    // 18m 的圈没盖住它，于是那一段被判成断路（南坡道段 5 连续 10 个采样点不可走）。
    // 30m 把整条路的影响范围都圈进来。
    terrainRoadHalf: 30,
    terrainColor: ridgeColor,
    terrainBase: 'grass',        // 底图用草：逐顶点色是乘在上面的，深棕底图会把丘陵糊成一片黑
    // 底图铺开 16m 一格：草贴图是 6m 一格（materials.js 的 texScale），
    // 360m 的图上 6m 会密到看不出地形、只剩"刷子纹"。16m 配逐顶点色，
    // 大起伏由顶点色/坡度交代，贴图只负责近处的质感。
    terrainStride: 16,
    surfaceColor: 0x6a7a4a,        // 小地图的地貌基色
    // 光照。这张图的光分两层问题，**判据和药方都不一样**，别混：
    //
    //   ① 地面亮度/起伏可读性 —— 靠 sun/hemi/exposure 的配比。太阳要保留方向性
    //      （sunDir.y 0.45 ≈ 30°），朝阳坡亮、背阴坡暗，连绵丘陵才读得出来；
    //      只降 sun 背阴坡会死黑，所以 hemi 顶在 1.5。
    //   ② 顺光方向的**天空眩光盘** —— 前两轮反复被报"刺眼"的真凶在这里：太阳低角度
    //      + 高浊度时，Mie 前向散射把整条地平线糊成一面白墙（用户截图：画面一半
    //      以上是白的）。降 sun 治不了它，得动天空模型那一组：
    //      turbidity 3.5 / rayleigh 1.0 / mie 0.0012 + exposure 0.78。
    //      另外方位角从 +x/-z 挪到**南偏东**（[0.3,0.45,0.72]）：早先的方位正好在
    //      A 队出站的正前方（A 在西墙朝东看，太阳 dead ahead），开局就是逆光；
    //      挪开后两队出站都与太阳错开 60° 以上，仰角抬高也把光晕抬离地平线带。
    //
    // **改这组数必须实拍验证**（探针做法：真客户端载入 ridges、镜头对准太阳方位
    // 截屏、量"白斑率"）。实测记录：贴地平线向日 56.9% → 20.6%，直视太阳
    // 30.6% → 2.9%，背对太阳对照 0.2% → 0.3%（场景均亮 182，不变暗）。
    // 判据 test/props.mjs B11 盯配比区间；顺光坡不过曝、背阴坡读得出起伏靠这组配比。
    env: {
      sky: 'day', sunDir: [0.3, 0.45, 0.72], sunColor: 0xffe6bc, sun: 1.7,
      hemi: 1.5, sky2: 0xd8e8fa, ground: 0x8a7a58, fog: 0xcfdae4, fogDensity: 0.0022,
      turbidity: 3.5, rayleigh: 1.0, mie: 0.0012, exposure: 0.78,
      mountains: 'rock', envIntensity: 0.85, weather: 'wind', ambient: 'wind',
    },
    build(w) {
      const r = mulberry32(71);
      const T = w.terrain;
      // 高处风大：把出生点/据点/摆件放到地面上，而不是 y=0。
      const P = (x, z, up = 0) => w.placeAt(x, z, up);
      const flat = (x, z) => T.slope(x, z);

      // ══ 占位查询：装饰（岩石/树）不许压在建筑与围墙上 ══
      //
      // 为什么要这个：岩石/植被是**后面**才生成的，而营房/围墙是**前面**摆好的。
      // 早一版两类各生成各的，于是岩石会随机落在围墙上（实测东围墙 (37,23) 处
      // 正好卡了一块 3.4m 的石头），远看就是"围墙夹着块石头"。
      //
      // 判法：拿已有的碰撞盒列表做一次水平重叠测试。它在装饰生成**之前**建好快照，
      // 快照里只有人工摆的建筑（墙/房/箱堆），不含装饰自身 —— 否则后面摆的装饰
      // 会互相排斥，把树林变成稀疏的几何图案。
      const taken = [];
      for (const b of w.boxes) taken.push([b.x0, b.z0, b.x1, b.z1]);
      const free = (x, z, rad) => {
        for (const [x0, z0, x1, z1] of taken) {
          const ox = Math.min(x + rad, x1) - Math.max(x - rad, x0);
          const oz = Math.min(z + rad, z1) - Math.max(z - rad, z0);
          if (ox > 0 && oz > 0) return false;
        }
        return true;
      };
      // 记下新摆的装饰，让后面的装饰也知道这里已被占（但不去碰前面的人工建筑快照）
      const claim = (x, z, rad) => taken.push([x - rad, z - rad, x + rad, z + rad]);

      // ===== 地形网格（小地图的底色由 buildTopDown 画，这里不管）=====

      // ===== 出生平台 =====
      // 一队的出生点在西、二队在东，各自一块压平的台地（shape 里的 spawnA/B）。
      // 出生点朝图内排开，避免全挤在一个点上被狙。
      const spawnRing = (cx, cz, dirX) => [
        [cx, cz + 6], [cx + dirX * 3, cz - 5], [cx + dirX * 6, cz + 2],
        [cx + dirX * 3, cz + 10], [cx - dirX * 3, cz + 13], [cx, cz - 12],
        [cx + dirX * 8, cz + 12],
      ];
      // **沙袋只放"平台背后"（图缘一侧）两排，不放任何出生点的出站方向上。**
      // 用户实测"刚复活往前走总卡住"：早一版每点正前方 3m 一排沙袋，7 个出生点
      // 每个都撞；改成"每点背后 4m"后又踩了第二脚 —— 最外侧两个出生点的背后
      // 沙袋正好砌在次外侧出生点的出站线上（A#6 的沙袋角压住 A#3/A#4 的直行
      // 线）。环形排布下"某点的背后"必然是"另一点的侧前方"，逐点摆怎么摆都漏。
      // 所以只按**平台中心**摆：两排 8m 沙袋贴在平台后缘，距最近的出生点 7m
      // 以上、距所有出站线更远 —— 掩体感保留，出站方向完全净空。
      w.sandbags(RIDGE.spawnA.x - 10, RIDGE.spawnA.z - 8, 8, Math.PI / 2);
      w.sandbags(RIDGE.spawnA.x - 10, RIDGE.spawnA.z + 8, 8, Math.PI / 2);
      w.sandbags(RIDGE.spawnB.x + 10, RIDGE.spawnB.z - 8, 8, Math.PI / 2);
      w.sandbags(RIDGE.spawnB.x + 10, RIDGE.spawnB.z + 8, 8, Math.PI / 2);
      for (const [x, z] of spawnRing(RIDGE.spawnA.x, RIDGE.spawnA.z, 1)) P(x, z);
      for (const [x, z] of spawnRing(RIDGE.spawnB.x, RIDGE.spawnB.z, -1)) P(x, z);

      // ===== 高地 A：北岭 =====
      const buildRidge = (site, topY, faceOut) => {
        const { x: cx, z: cz } = site;
        // 瞭望塔：用户明确要求"两处高地上都有瞭望塔"。塔基已被 shape 压平，
        // 四条腿能同时着地（判据 test/terrain.mjs 盯这条：塔周 13m 高差 < 2m）。
        P(cx, cz);
        w.watchtower(cx, cz, 5.5);
        // 塔旁的观察位：沙袋 + 弹药箱 + 一辆停在台缘的车（视野朝图内）
        P(cx + faceOut * 7, cz - faceOut * 4);
        w.sandbags(cx + faceOut * 8.5, cz - faceOut * 4.5, 5, Math.PI * (faceOut > 0 ? 0.75 : -0.75));
        w.crate(cx + faceOut * 6, cz - faceOut * 7, 1.1);
        w.crate(cx + faceOut * 7.3, cz - faceOut * 7.6, 0.9);
        w.barrel(cx + faceOut * 5.4, cz - faceOut * 8.4, 'burnt', true);
        // 台缘的机枪位：位置选在朝向营区的一侧（两队争夺时这里先被看到）
        P(cx - faceOut * 10, cz + faceOut * 9);
        w.sandbags(cx - faceOut * 11, cz + faceOut * 9, 4, Math.PI / 2);
        w.crateStack(cx - faceOut * 12, cz + faceOut * 12);
        // 台面上的散石：不是随机撒，是沿台缘摆一圈（天然的胸墙）
        for (let i = 0; i < 9; i++) {
          const a = i / 9 * Math.PI * 2;
          const rx = cx + Math.cos(a) * (site.r * 0.62), rz = cz + Math.sin(a) * (site.r * 0.62);
          if (flat(rx, rz) > 0.42) continue;
          P(rx, rz);
          w.rock(rx, rz, 1.1 + r() * 1.5, 'rock');
        }
      };
      buildRidge(RIDGE.north, RIDGE_Y.ridgeTop, 1);
      buildRidge(RIDGE.south, RIDGE_Y.ridgeTop + 2, -1);

      // ===== 高地之间的鞍部：交战区 =====
      // 鞍部是两块高地的连接处，也是必经之路 —— 这里给的是"路障 + 掩体"，
      // 让它成为战术焦点，而不是一片空地。
      //
      // 鞍部 (0,4) **就在营区里面**（营心也是 (2,8)）—— 早一版这些物件按
      // 鞍部中心 ±偏移 摆，结果全落在营区的兵营/围墙上（实测 3 处穿模）。
      // 现在把它们推到**营区围墙之外**：营区北墙在 cz-24，往北的走廊才是交战区。
      {
        const s = RIDGE.saddle;
        const cz = RIDGE.camp.z;
        const OUT = cz - 30;                // 营区北墙外5m
        P(s.x - 18, OUT); w.jersey(s.x - 18, OUT, 0.3);
        P(s.x + 20, OUT + 3); w.jersey(s.x + 20, OUT + 3, -0.4);
        // 沙袋在指挥所**西侧**（x -12 那一列），不在它正南 ——
        // 早一版摆在 (s.x-4, OUT+11) = (-4,-11)，正落在指挥所肚子里
        // （指挥所 x ∈ [-7.2, 11.2]、z ∈ [-15.2, -2.8]，实测压 5.0×0.6m）。
        P(s.x - 12, OUT + 11); w.sandbags(s.x - 12, OUT + 11, 5, 0);
        P(s.x + 26, OUT - 4); w.crateStack(s.x + 26, OUT - 4);
        P(s.x - 24, OUT + 2); w.rock(s.x - 24, OUT + 2, 1.6);
        P(s.x + 12, OUT - 7); w.rock(s.x + 12, OUT - 7, 1.3);
      }
      // ===== 中央军营：用户要求"旁边一处较为平整的地方坐落着一个军营" =====
      //
      // 营区在 shape 里被压到近乎水平（实测三条横带高差都 ≤ 0.91m），
      // 所以这里的错位**不是地形问题，是布局坐标自己算错了**。
      // 早一版各区的偏移量是逐个手写的加法，加着加着就压到了别人身上：
      // 帐篷插进兵营、卡车撞围墙、弹药箱堆在兵营肚子里、停机坪压过北围墙、
      // 岩石卡在兵营墙里、鞍部的路障落在营区正中 —— 实测 29 处穿模。
      //
      // 现在的做法：**先量出营地尺寸，再划带，最后每区坐标都从带边界推出来**。
      //
      // 营地尺寸是量出来的：从营心向外扫"坡度 < SLOPE.ROLLING(0.42) 能走多远"，
      // 半尺寸 36×30 是极限（整块最大坡度 0.44）。围墙就取这个数。
      //
      // 三带划分（z 由北向南）：
      //   北带 z ∈ [cz-24, cz-10]  指挥所（正中）+ 直升机坪（西）+ 帐篷营（东）
      //   中带 z ∈ [cz-8,  cz+16]  兵营东西两列（cx±23）+ 中央集结地
      //   南带 z ∈ [cz+18, cz+30]  车场（西）+ 弹药油料区（东，围起来）
      //
      // 判据 test/props.mjs 的 B12 钉这个：营区内不得有任何两件不同物件的占地重叠。
      {
        const c = RIDGE.camp;
        const cx = c.x, cz = c.z;
        // 三条带的 z 边界。后面每一区的坐标都从这三条线推，不再写孤立数字 ——
        // 早一版就是各写各的偏移量，加着加着就压到了别人身上。
        const BAND_N = cz - 10;      // 北带南界
        const BAND_M = cz + 18;      // 中带南界 = 南带北界

        // ── 1) 指挥所：北带正中，18×12，是营区的视觉锚点 ──
        // padTo 用**足迹四角**取地面，不是只读中心 —— 18m 的大房子按中心摆会一角悬空。
        const HQ = [18, 12];
        const hqZ = cz - 17;                       // z ∈ [cz-23, cz-11]
        w.padTo(cx, hqZ, HQ[0], HQ[1]);
        w.building(cx, hqZ, HQ[0], HQ[1], 5, {
          mat: 'plasterWhite', roofMat: 'metalRoof', floor: 'concrete',
          doors: { s: [0], e: [0], w: [0] }, windows: { s: [-5, 5], n: [-5, 5], e: [3], w: [-3] },
          parapet: true, light: 0xffd9a0,
        });
        P(cx, hqZ);
        w.box(cx, 5.3, hqZ, 4, 2.4, 4, 'concreteDark');   // 屋顶哨台基座
        w.lampPost(cx + 9.4, hqZ, 0xffd8a0, Math.PI / 2, 14);
        w.lampPost(cx - 9.4, hqZ, 0xffd8a0, -Math.PI / 2, 14);

        // ── 2) 兵营：中带东西两列，各两间；门朝中央集结地 ──
        // 列位 cx±23：兵营 9m 宽 → 内缘 cx±18.5，中央留 37m 集结地（够装甲车调动）。
        //
        // **为什么是 2 间而不是 3 间**：列位 cx±23 距围墙（cx±36）只有 8.1m 净空，
        // 纵向再排下去（第3 间到 cz+24.25）就会把南带占满，弹药区只能塞进
        // 8m 宽的边条里—— 而弹药区最少要12m（4m 出入口 + 油料桶 + 两排箱堆）。
        // 2 间 → 占22m（cz-8.75 .. cz+13.25），中带南端腾出 16.7m 净深给弹药区。
        const BARRACK = [9, 7.5];
        for (const sgn of [-1, 1]) {
          for (let i = 0; i < 2; i++) {
            const bz = cz - 5 + i * 11;
            const bx = cx + sgn * 23;
            w.padTo(bx, bz, BARRACK[0], BARRACK[1]);
            w.building(bx, bz, BARRACK[0], BARRACK[1], 3.6, {
              mat: 'plaster', roofMat: 'metalRoof', floor: 'concrete',
              doors: { [sgn > 0 ? 'w' : 'e']: [0], s: [0] },
              windows: { s: [-2.6, 2.6], [sgn > 0 ? 'w' : 'e']: [0] },
              parapet: true,
            });
          }
        }

        // ── 3) 车场：南带西侧一排，车头朝外对着进来的路 ──
        // 卡车 6.1m 长、rotY=π/2时长轴在 x，10m 一个车位刚好不咬。
        // 起点 cx-30：4 辆占 40m（cx-33..cx+7），西端不越出围墙（围墙在 cx-36）。
        // z 取南带偏南 cz+27：卡车足迹 z ∈ [cz+25.9, cz+28.1]，
        // 与兵营末间（到 cz+24.25）不咬，与集装箱（cz+31.75起）也不咬。
        for (let i = 0; i < 4; i++) {
          const tx = cx - 30 + i * 10;
          P(tx, cz + 27);
          w.truck(tx, cz + 27, Math.PI / 2 + (r() - 0.5) * 0.08, [0xd9d4c4, 0xb8b0a0, 0xa8a49a][i % 3]);
          w.truckCollider(tx, cz + 27, Math.PI / 2);
        }
        // 集装箱：6m 长，按足迹贴地。摆在车场**南侧** cz+33 一线
        // （足迹 z ∈ [cz+31.75, cz+34.25]），三面都不咬。
        w.padTo(cx - 30, cz + 33, 6.2, 2.5); w.container(cx - 30, cz + 33, 0, 'containerGreen');
        w.padTo(cx - 14, cz + 33, 6.2, 2.5); w.container(cx - 14, cz + 33, 0, 'containerGray');

        // ── 4) 弹药与油料：中带南端偏东，围起来（危险品要隔离，这是它靠围栏的原因）──
        //
        // 围栏范围 x ∈ [cx+6, cx+32]、z ∈ [cz+17, cz+30]（26×13m）。
        //
        // **位置是算出来的，不是摆出来的**：早一版把弹药区放在东侧边条
        // （x从 cx+20 到 cx+34），但实测那一带只有 8.1m 净空（兵营列外缘 cx+27.7
        // 到东围墙 cx+36）—— 围栏西墙直接画在兵营肚子里，实测 8 处穿模。
        // 现在放到**中带南端**（兵营末间南缘 cz+13.25 之下），
        // 26m 宽 × 13m 深，四边都封（北面留 4m 出入口），箱子全部收进围栏内。
        const depX0 = cx + 6, depX1 = cx + 32, depZ0 = cz + 17, depZ1 = cz + 30;
        w.wall(depX0, depZ0, depX0, depZ1, 2.2, 0.3, 'concreteDark');
        w.wall(depX1, depZ0, depX1, depZ1, 2.2, 0.3, 'concreteDark');
        w.wall(depX0, depZ0, depX1, depZ0, 2.2, 0.3, 'concreteDark',
          [{ c: 8, w: 4, y0: 0, y1: 2.2 }]);           // 北面出入口（偏西，进出卡车场）
        w.wall(depX0, depZ1, depX1, depZ1, 2.2, 0.3, 'concreteDark');
        // 油料桶：靠东墙内侧一列，桶 0.6m 见方、间距 1.7m
        for (let i = 0; i < 3; i++) w.barrel(cx + 29.8, cz + 19.5 + i * 1.7, 'burnt', true);
        w.barrel(cx + 28, cz + 19.5, 'containerOrange', true);
        w.barrel(cx + 28, cz + 21.2, 'containerOrange');
        // 弹药箱堆：用 padTo 按整堆的足迹取地面，否则在坡上会有一半埋进土里
        // （实测下沉 1.8m —— 一堆只有最上面那个箱子露在外面）。
        // 箱堆 2.5×1.2，列间距 4.5m、行间距 4.5m —— 都在围栏内（x 8..30, z 19..27）。
        for (const dx of [11, 15.5, 20, 24.5]) for (const dz of [20, 25]) {
          w.padTo(cx + dx, cz + dz, 3.2, 1.3); w.crateStack(cx + dx, cz + dz);
        }
        // 弹药箱：注意 box() 的签名是 (cx, y0, cz, w, h, d, mat) —— 早一版漏写了 y0，
        // 于是 cz 被当成高度、参数整体错位，造出一个 z 为 NaN 的碰撞盒。
        // NaN 盒进宽相格网会污染整格，让那一带的 ceilingHeight/raycast 漏命中
        // （判据 test/world-equiv.mjs 在 ridges 上逮到过这 6 处分歧）。
        // 放在南墙内侧：箱足迹 z ∈ [cz+27.6, cz+29.1]，南墙在 cz+30 —— 不咬。
        for (const dx of [13, 17, 21, 25]) {
          w.padTo(cx + dx, cz + 28.4, 1.6, 1.3);
          w.box(cx + dx, 0, cz + 28.4, 1.5, 1.2, 1.2, 'gunGreen');
        }

        // ── 5) 帐篷营：北带东侧（指挥所与东围墙之间的空地）──
        //
        // 早一版帐篷摆在营区西北（cx-30 起），而西侧兵营列也在那儿——
        // 两顶帐篷直接落在兵营肚子里（实测穿模 4 处）。
        // 用户报的"三棱柱形绿色片状物"就是它们（几何另有一处 bug，见 world.js:tent）。
        //
        // 现在：5 顶排 3 列 2 行，**全在北带东侧**：
        //   x = cx+15/24/33（列间距 9m = 5m 宽 + 4m 走道）
        //   z = cz-20 / cz-11（行间距 9m = 7m 深 + 2m 走道）
        //
        // **行间距必须 ≥ 帐篷深度 7m**，否则两行帐篷直接压在一起
        // （早一版行间距 4.5m，实测 2 对帐篷重叠 5.0×2.5m）。
        //
        // 纵向可用净深：北墙内侧 cz-24 到兵营北缘 cz-8.75 = 15.25m。
        // 两行 7m = 14m，只剩 1.25m 走道 —— **不够**。
        // 帐篷深 7m，所以行间距至少 7m，两行就得 14m，加上南北各 0.5m
        // 的墙距与兵营距就是 15m，仍差 0.25m。实测按 cz-20/cz-11 摆时
        // 第二行南缘到 cz-7.5，压进兵营 1.5m。
        //
        // 解法：**第二行只摆 2 顶**（5 顶不必强行2×3），
        // 让出 7m 给行间走道与兵营间距：
        //   第一行 3 顶 @ cz-20（北缘 cz-23.5，距北墙 0.5m）
        //   第二行 2 顶 @ cz-12.6（南缘 cz-9.1，距兵营 0.35m）
        // 纵向占 cz-23.5..cz-9.1 = 14.4m，落在 15.25m 的净深里。
        //
        // **第二行要多留 0.6m**：帐篷带 rotY=±0.08 的小角度旋转，
        // 旋转后外接盒比 5×7 大0.2m（实测第二行南缘到 cz-8.5，
        // 正好压进兵营 0.5m）。留0.6m 余量把旋转量吃掉。
        for (let i = 0; i < 5; i++) {
          const col = i % 3, row = (i / 3) | 0;
          // 第二行（i≥3）只有 2 顶，col 复用 0/1
          const c = row ? (i - 3) : col;
          const tx = cx + 15 + c * 9, tz = row ? cz - 12.6 : cz - 20;
          P(tx, tz);
          w.tent(tx, tz, 5, 7, (i % 2 ? 0.08 : -0.08));
        }
        // 帐篷营的油料桶与箱堆：**只能放在西侧那3.5m 的空档里**
        // （指挥所东缘 cx+9 到帐篷首列西缘 cx+12.5）。
        //
        // 纵向已经没空档了：北墙 cz-24 到兵营北缘 cz-8.75 共 15.25m，
        // 两行帐篷 7+7=14m 加上必须的走道就用完了 —— 桶要是在阵列的
        // 南北两侧（cz-22 / cz-5.5），实测都会压在帐篷上
        //（早一版摆在 cz-23 与 cz-22，各压出 0.6×0.6 与 1.2×1.2m）。
        // 3.5m 宽的西侧空档：箱堆 2.5m + 桶 0.6m，一列排得下。
        P(cx + 11, cz - 20);
        w.padTo(cx + 11, cz - 20, 3.2, 1.3); w.crateStack(cx + 11, cz - 20);
        w.barrel(cx + 11, cz - 16, 'containerBlue');
        w.barrel(cx + 11, cz - 11, 'burnt', true);

        // ── 6) 营区围墙与门 ──
        //
        // **围墙尺寸是量出来的，不是拍的。** 从营心向外扫"坡度 < SLOPE.ROLLING(0.42)
        // 能走多远"，实测半尺寸 36×30 是极限（整块最大坡度 0.44，四角最陡）；
        // 放到 38×34 就有 0.80、40×36 到 1.04 —— 围墙自己会骑在斜坡上。
        // 早一版围墙是 ±36 × (cz-26..cz+34)，东北角已经踩到 0.80 的坡。
        //
        // 围三面（北/西/东），南面敞开对着指挥所后面的高地。
        // 围墙是**长条**，会横穿起伏 —— 每一段单独贴地：w.wallBy() 沿墙长采样，
        // 让每一截都站在自己那儿的地面上（否则 70m 长的墙总有一头悬空）。
        //
        // **大门开在盘山路真正出去的那一点**，不是开在墙的正中。
        // 早一版门开在x=cx（正中），而第一条盘山路从 x=-18 穿北墙 ——
        // 两者差 20m，于是"门"开在了一条实墙上，门外没有路。
        // 判据 B15/B15b/B18 三条一起盯这个：门要通、墙要封、门内要有路。
        // 路从哪穿出来就让门开在哪（这里的 -18 是从 ridges.js 的 RAMPS[0] 算出来的）。
        const WALL_X = 36, WALL_Z0 = cz - 24, WALL_Z1 = cz + 30;
        const GATE_X = -18;                        // = 盘山路穿墙处（见上）
        // 门洞宽 16m：不是"车行宽度"，是**让8m 路廊整个穿过**。
        // `wallBy` 按 4m 分段建墙，开口只能对齐到段边界 ——
        // 早一版 8m 宽的门洞实测落在 x ∈ [-13.4, -10.0]（中心 -11.7），
        // 离路心 -18 差 6.3m，路廊有 2/3 卡在墙里（B15 报 8 格豁免不够）。
        // 16m 让"路心 ± 8m"整条落在门洞内，边界与段也对得上。
        const gateW2 = 16;
        w.wallBy(cx - WALL_X, WALL_Z0, cx + WALL_X, WALL_Z0, 2.6, 0.35, 'concreteDark',
          [{ c: GATE_X - (cx - WALL_X), w: gateW2, y0: 0, y1: 3.2 }]);
        w.wallBy(cx - WALL_X, WALL_Z0, cx - WALL_X, WALL_Z1, 2.6, 0.35, 'concreteDark');
        w.wallBy(cx + WALL_X, WALL_Z0, cx + WALL_X, WALL_Z1, 2.6, 0.35, 'concreteDark',
          [{ c: 26, w: 6, y0: 0, y1: 3.2 }]);
        // 大门：两根门柱 + 横梁。
        //
        // 门柱必须**贴着门洞的两侧**：`c` 是"沿墙的米"（从墙的起点算），
        // 所以门洞中心在 `c = WALL_X`（墙中点），门柱在 `cx ± (WALL_X - 3.5)` ——
        // 早一版写的是 `cx ± 3.8` 而`c: 34`（不是 36），门洞偏西 2m，
        // 于是两根门柱一根卡在门洞里、一根骑在墙上（判据 B13 钉这个）。
        const gateX = GATE_X, gateW = gateW2;
        const postX = gateW / 2 + 0.3;              // 门柱内侧留 0.3m 贴门洞边
        w.padTo(gateX - postX, WALL_Z0, 0.6, 0.6);
        w.box(gateX - postX, 0, WALL_Z0, 0.6, 4.2, 0.6, 'concreteDark');
        w.padTo(gateX + postX, WALL_Z0, 0.6, 0.6);
        w.box(gateX + postX, 0, WALL_Z0, 0.6, 4.2, 0.6, 'concreteDark');
        // 门梁：**先P() 归位再摆**。
        //
        // `box(cx, y0, ...)` 的 y0 是相对 `this.baseY` 的高度，而 baseY 是
        // 上一次 `padTo()` 留下的值 —— 这里是**右门柱**脚下的地面。
        // 不归位就直接摆，门梁就会从"右门柱的地面"起算4.2m，
        // 而它横跨整个门洞（实测生成的盒 y0 = 9.90 = 地面高度，
        // 顶到 14.9 = 离地 5m）—— 于是一根 8.6m 长的门梁把门洞**整个封死**，
        // 导航网格里门洞两格都不可走，玩家进不去营区（判据 B13c钉这个）。
        P(gateX, WALL_Z0);
        w.box(gateX, 4.2, WALL_Z0, gateW + 1.2, 0.5, 0.6, 'darkMetal');
        w.lampPost(gateX - postX, WALL_Z0 + 2, 0xffd8a0, 0, 12);
        w.lampPost(gateX + postX, WALL_Z0 + 2, 0xffd8a0, 0, 12);

        // ── 7) 直升机坪：营区西北，圆形夯土地面 + 边灯（现代军营的标准件）──
        // 用 w.pad() 而不是"圆柱 mesh + 18m 见方碰撞盒"：方盒的四个角伸到圆盘外
        // 5.5m，玩家在草坪上会被看不见的空气墙挡住（判据 test/props.mjs 盯这条）。
        //
        // **位置由围墙内净空反推，两个方向都要让开**：
        //   北墙内侧 z = cz-24 → 圆盘北缘 ≥ cz-24 → 圆心 z ≥ cz-24 + r
        //   西侧兵营北缘 z = cz-7（圆心 cz-5、深 7.5、含墙与勒脚）
        //     → 圆盘南缘 ≤ cz-7 → 圆心 z ≤ cz-7 - r
        // 两边一夹：cz-24 + r ≤ cz-7 - r → r ≤ 8.5。取 r = 6.5 留余量。
        // 横向同理：西侧兵营西缘 cx-25.7、西围墙 cx-36，净空 10.3m，
        // 圆心 x ∈ [cx-29.5, cx-29.5] 附近，取 cx-29.5。
        // 早一版摆在 (cx-26, cz-22)：圆盘北缘伸到 cz-31，**压过北围墙 15.3m**。
        const padR = 6.5;
        const padX = cx - 29.5, padZ = cz - 15.5;
        w.pad(padX, padZ, padR, 0.25, 'concrete');
        w.box(padX, 0.26, padZ, 1.2, 0.05, 1.2, 'whitePaint', { collide: false });
        w.box(padX, 0.26, padZ, 0.4, 0.05, 6, 'whitePaint', { collide: false });
        // 边灯：贴在圆盘外沿（padR + 0.6），底面 y=0 随地面起伏
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * Math.PI * 2;
          const lx = padX + Math.cos(a) * (padR + 0.6), lz = padZ + Math.sin(a) * (padR + 0.6);
          P(lx, lz);
          w.box(lx, 0, lz, 0.3, 0.3, 0.3, 'burnt', { collide: false });
        }
      }

      // ===== 道路沿线的战术物件 =====
      // 沿 CORRIDOR 每隔一段放一处：这条路是双方都要走的，所以路上的掩体是有意义的。
      // 用固定间距而不是随机 —— 随机会让掩体忽疏忽密。
      for (let ri = 0; ri < RIDGE_ROADS.length; ri++) {
        const road = RIDGE_ROADS[ri];
        for (let i = 0; i + 1 < road.length; i++) {
          const [ax, az] = road[i], [bx, bz] = road[i + 1];
          const L = Math.hypot(bx - ax, bz - az);
          const n = Math.max(1, Math.round(L / 42));
          for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
            if (flat(x, z) > 0.34) continue;               // 太陡就别摆（会悬空）
            // 路侧（垂直方向偏 6.5m），左右交替 —— 交替是为了让两侧都能当掩体用
            const sgn = (k + i) % 2 ? 1 : -1;
            const px = x + (bz - az) / L * 6.5 * sgn, pz = z - (bx - ax) / L * 6.5 * sgn;
            if (flat(px, pz) > 0.42) continue;
            // 营区里不放路侧岩石。free()/claim() 的快照虽然包含营房，
            // 但它是**建在营区摆完之前**的一次快照，而路侧岩石这条走廊
            // 恰好穿过东南弹药区（实测 1 处卡进围栏）。这里按营区矩形直接排除。
            if (px > RIDGE.camp.x - 40 && px < RIDGE.camp.x + 40 &&
                pz > RIDGE.camp.z - 28 && pz < RIDGE.camp.z + 34) continue;
            P(px, pz);
            if (k % 2) { w.sandbags(px, pz, 4, Math.atan2(bz - az, bx - ax)); w.crate(px + 1.6, pz, 1); }
            else if (free(px, pz, 1.6)) { claim(px, pz, 2.0); w.rock(px, pz, 1.2 + r() * 0.7, 'rock'); }
          }
        }
      }

      // ===== 野外植被与岩石：按"哪里该长什么"分布 =====
      // 规则：低洼地（营区周围、平原）草多树少；坡陡的地方不长树；高地边缘有裸岩。
      // 这三条是地形与植被的关系，不是随机撒 —— 判据 test/terrain.mjs 会验它。
      // 密度取值：360m 的图上 150 棵看着是"稀疏的丘陵"，300 棵才连成"连绵"。
      // 树按**成簇**摆（三五棵一组）而不是各自独立随机 —— 独立随机会得到一片
      // 均匀的"钉子地"，成簇才像自然林。
      const clusterTrees = (cx, cz, rad, n, kind, scale) => {
        for (let i = 0; i < n; i++) {
          const a = r() * Math.PI * 2, d = Math.sqrt(r()) * rad;
          const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
          if (Math.abs(x) > 166 || Math.abs(z) > 166) continue;
          if (flat(x, z) > 0.32) continue;                       // 陡坡不长
          if (Math.hypot(x - RIDGE.camp.x, z - RIDGE.camp.z) < 44) continue;
          if (Math.hypot(x - RIDGE.spawnA.x, z - RIDGE.spawnA.z) < 24) continue;
          if (Math.hypot(x - RIDGE.spawnB.x, z - RIDGE.spawnB.z) < 24) continue;
          if (!free(x, z, 2.6)) continue;                          // 不许压在建筑/围墙上
          claim(x, z, 3.2);
          P(x, z);
          w.tree(x, z, (scale || 1) * (0.8 + r() * 0.6), kind);
        }
      };
      // 低地阔叶林（沿河谷与平原）
      for (let i = 0; i < 34; i++) {
        const a = r() * Math.PI * 2, d = 30 + r() * 130;
        clusterTrees(Math.cos(a) * d, Math.sin(a) * d, 9 + r() * 7, 3 + Math.floor(r() * 4), 'broad', 1);
      }
      // 高地针叶林（越高越密，只在 12m 以上）
      for (let i = 0; i < 30; i++) {
        const s = r() < 0.5 ? RIDGE.north : RIDGE.south;
        const a = r() * Math.PI * 2, d = 30 + r() * 62;
        const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
        if (T.height(x, z) < 12) continue;
        clusterTrees(x, z, 8 + r() * 6, 2 + Math.floor(r() * 3), 'pine', 0.9);
      }
      // 岩石：坡地上散布，高地侧翼更密
      for (let i = 0; i < 190; i++) {
        const x = (r() - 0.5) * 336, z = (r() - 0.5) * 336;
        if (Math.abs(x) > 168 || Math.abs(z) > 168) continue;
        const s = flat(x, z);
        if (s < 0.1 && r() > 0.25) continue;                    // 平地上少放，坡地上多放
        if (Math.hypot(x - RIDGE.camp.x, z - RIDGE.camp.z) < 40) continue;
        if (!free(x, z, 2.0)) continue;                          // 不许压在建筑/围墙上
        claim(x, z, 2.4);
        P(x, z);
        w.rock(x, z, 0.8 + r() * 1.7, 'rock');
      }
      // 高地侧翼的裸岩带：让两处高地在远处就能看出轮廓
      for (const site of [RIDGE.north, RIDGE.south]) {
        for (let i = 0; i < 14; i++) {
          const a = r() * Math.PI * 2;
          const d = site.r * (1.1 + r() * 0.7);
          const x = site.x + Math.cos(a) * d, z = site.z + Math.sin(a) * d;
          if (Math.abs(x) > 170 || Math.abs(z) > 170) continue;
          if (flat(x, z) > 0.5) continue;
          if (!free(x, z, 2.6)) continue;                        // 高地设施（塔/沙袋）也要避让
          claim(x, z, 3.0);
          P(x, z);
          w.rock(x, z, 1.2 + r() * 1.8, 'rock');
        }
      }

      // ===== 边界挡墙：内侧一圈岩石，防止玩家贴边卡进地形缝 =====
      for (let i = 0; i < 30; i++) {
        const a = i / 30 * Math.PI * 2;
        const x = Math.cos(a) * 174, z = Math.sin(a) * 174;
        P(x, z);
        w.rock(x, z, 1.6 + r() * 1.6, 'rock');
      }

      // 崖脚碎石：坡地与崖脚撒一层小石片，跟 ridges.color 的碎石/裸岩色带接上 ——
      // 色带从远处读，这层从近处摸。无碰撞、不进导航（纯视觉），复用岩石实例化
      // 管线：一百来块只多一两个 draw call。也避开旗位圈（磨损环上别长石头）。
      for (let i = 0; i < 260; i++) {
        const x = (r() - 0.5) * 336, z = (r() - 0.5) * 336;
        const s = flat(x, z);
        if (s < 0.38 || s > 0.92) continue;
        if (Math.hypot(x - RIDGE.camp.x, z - RIDGE.camp.z) < 44) continue;
        if (Math.hypot(x - RIDGE.spawnA.x, z - RIDGE.spawnA.z) < 24) continue;
        if (Math.hypot(x - RIDGE.spawnB.x, z - RIDGE.spawnB.z) < 24) continue;
        if (RIDGE_FLAGS.some(([fx, fz]) => Math.hypot(x - fx, z - fz) < 12)) continue;
        if (!free(x, z, 1.0)) continue;
        P(x, z);
        w.rock(x, z, 0.22 + r() * 0.38, 'rock', false);
      }

      // ===== 出生点与据点（高度取自地形，两端共用）=====
      w.spawns.A = spawnRing(RIDGE.spawnA.x, RIDGE.spawnA.z, 1).map(([x, z]) => V(x, z).setY(T.height(x, z)));
      w.spawns.B = spawnRing(RIDGE.spawnB.x, RIDGE.spawnB.z, -1).map(([x, z]) => V(x, z).setY(T.height(x, z)));
      // 据点：一处在北岭顶（塔下）、一处在南丘顶、一处在营区门内 —— 三点连线正好
      // 把两个高地和中央连起来，占领模式下会自然形成"抢高地→切中路"的节奏。
      // 坐标在 ridges.js 的 FLAG_POS（color() 的磨损环画同一份，别各写一个）。
      w.flagPos = RIDGE_FLAGS.map(([x, z]) => V(x, z).setY(T.height(x, z)));
      w.baseY = 0;
    },
  },

  // ================= 战役：卡尔达什 =================
  kaldash: {
    id: 'kaldash', name: '卡尔达什村', size: 200, seed: 51, surface: 'dirt', night: true, styles: ['ally', 'insurgent'],
    env: { sky: 'night', sunDir: [0.35, 0.55, -0.6], sunColor: 0xa8b8ff, sun: 0.55, hemi: 0.22, sky2: 0x3a4a70, ground: 0x1a1510, fog: 0x0b1020, fogDensity: 0.016, exposure: 1.15, envIntensity: 0.3, skyTop: 0x02040a, skyHorizon: 0x0f1828, cityGlow: 0x0a0a14, mountains: 'rock', ambient: 'wind' },
    build(w) {
      w.ground('dirt');
      w.bounds();
      const r = mulberry32(77);
      // 土路
      w.box(0, 0, 0, 196, 0.02, 7, 'sand', { collide: false, texScale: 6 });
      // 草地斑块
      for (let i = 0; i < 14; i++) w.box(-95 + r() * 190, 0.005, -90 + r() * 180, 8 + r() * 14, 0.01, 8 + r() * 14, 'grass', { collide: false });
      // ---- 着陆区 ----
      for (let i = 0; i < 14; i++) { const x = -95 + r() * 45, z = (r() < 0.5 ? -1 : 1) * (8 + r() * 30); w.rock(x, z, 0.8 + r() * 1.5, 'rock'); }
      for (let i = 0; i < 26; i++) { const x = -95 + r() * 190, z = (r() < 0.5 ? -1 : 1) * (26 + r() * 60); if (Math.abs(x - 65) < 30 && Math.abs(z) < 32) continue; w.tree(x, z, 0.9 + r() * 0.5, r() < 0.5 ? 'pine' : 'broad'); }
      w.wall(-70, -6, -60, -6, 1.1, 0.5, 'rock'); w.wall(-68, 6, -58, 6, 1.0, 0.5, 'rock');
      w.car(-64, 10, 0.8, 0x333333, true);
      // ---- 前哨站 ----
      w.sandbags(-50, -7, 6, 0); w.sandbags(-50, 7, 6, 0); w.sandbags(-54, 0, 5, Math.PI / 2);
      w.sandbags(-40, -9, 5, 0);
      w.watchtower(-43, -12, 4);
      w.tent(-48, 12, 4, 5, 0); w.tent(-40, 12, 4, 5, 0);
      w.barrel(-45, 3.5, 'burnt', true);
      w.box(-37, 0, -4, 1.5, 1.2, 1, 'darkMetal'); // 发电机
      w.lampPost(-36, -6, 0xffd0a0, Math.PI, 10);
      w.crateStack(-46, -4); w.truck(-34, 6, 0.2, 0xb8b0a0); w.truckCollider(-34, 6, 0);
      // ---- 村庄 ----
      const houses = [[-12, -14, 8, 7, 3.2, 'plaster'], [-8, 14, 9, 8, 3.2, 'plasterWhite'], [6, -16, 10, 8, 3.5, 'plaster'], [10, 15, 8, 8, 3.2, 'plasterRed'], [22, -12, 7, 7, 3, 'plasterWhite'], [25, 14, 8, 7, 3.2, 'plaster']];
      houses.forEach(([x, z, bw, bd, h, m], i) => w.building(x, z, bw, bd, h, { mat: m, doors: { [z < 0 ? 's' : 'n']: [i % 2 ? 1 : -1], [i % 2 ? 'e' : 'w']: [0] }, windows: { [z < 0 ? 's' : 'n']: [i % 2 ? -2 : 2] }, parapet: true, floor: 'dirt' }));
      w.wall(-20, -24, 32, -24, 1.6, 0.4, 'plaster', [{ c: 18, w: 3, y0: 0, y1: 1.6 }, { c: 36, w: 3, y0: 0, y1: 1.6 }]);
      w.wall(-20, 24, 32, 24, 1.6, 0.4, 'plaster', [{ c: 14, w: 3, y0: 0, y1: 1.6 }, { c: 34, w: 3, y0: 0, y1: 1.6 }]);
      w.box(2, 0, 4, 2.5, 1.0, 1.4, 'wood'); w.crate(-2, -5, 1); w.crate(16, 5, 1.1); w.barrel(14, -5, 'containerBlue');
      w.mesh(new THREE.CylinderGeometry(1, 1, 0.9, 16), 'rock', 5, 0.45, -4); w.collider(4, 0, -5, 6, 0.9, -3);
      w.car(30, -4, 0.3, 0x5a4a30, true);
      w.box(-8, 1.1, 10.3, 1.2, 1.0, 0.05, 'windowLit', { collide: false });
      w.pointLight(-8, 2.2, 14, 0xffb070, 3, 9, true);
      w.box(25, 1.1, 10.3, 1.2, 1.0, 0.05, 'windowLit', { collide: false });
      // ---- 大院 ----
      const T = 0.4, H = 3.2;
      w.wall(45, -22, 88, -22, H, T, 'plaster', [{ c: 5, w: 3, y0: 0, y1: H }]);
      w.wall(45, 22, 88, 22, H, T, 'plaster', [{ c: 5, w: 3, y0: 0, y1: H }]);
      w.wall(45, -22, 45, 22, H, T, 'plaster', [{ c: 22, w: 6, y0: 0, y1: H }]);
      w.wall(88, -22, 88, 22, H, T, 'plaster', [{ c: 22, w: 5, y0: 0, y1: H }]);
      // 主楼
      const hx0 = 57, hx1 = 79, hz0 = -8, hz1 = 8, hh = 3.6;
      w.building(68, 0, 22, 16, hh, { mat: 'plasterWhite', doors: { w: [0], e: [0] }, windows: { n: [-6, 2, 7], s: [-6, 4] }, parapet: true, floor: 'tiles' });
      w.wall(hx0 + 0.15, -2.5, hx1 - 0.15, -2.5, hh, 0.2, 'plaster', [{ c: 5, w: 1.3 }, { c: 16, w: 1.3 }]);
      w.wall(hx0 + 0.15, 2.5, hx1 - 0.15, 2.5, hh, 0.2, 'plaster', [{ c: 8, w: 1.3 }, { c: 18, w: 1.3 }]);
      w.wall(68, hz0 + 0.15, 68, -2.6, hh, 0.2, 'plaster');
      w.wall(70, 2.6, 70, hz1 - 0.15, hh, 0.2, 'plaster');
      // 情报室
      w.box(75, 0, -6.2, 2.2, 0.8, 1.0, 'wood');
      w.laptopPos = V(75, -6.2); w.laptopPos.y = 0.85;
      w.box(75, 0.8, -6.3, 0.4, 0.02, 0.3, 'darkMetal', { collide: false });
      w.box(75, 0.8, -6.45, 0.4, 0.28, 0.02, 'lampCold', { collide: false });
      w.box(71, 0, -7.4, 1.8, 2, 0.6, 'wood'); w.crate(77.5, -3.8, 0.9);
      w.box(60, 0, -6, 2, 0.5, 3, 'clothRed'); w.box(62, 0, 6.5, 2.5, 0.8, 1, 'wood'); w.box(76, 0, 6, 1, 1.8, 2, 'wood');
      w.pointLight(62, 3, 0, 0xffc080, 3, 10, true);
      w.pointLight(74, 3, -5, 0xffc080, 2.5, 8, true);
      // 庭院
      w.truck(51, -12, Math.PI / 2 + 0.2, 0xd9d4c4); w.truckCollider(51, -12, Math.PI / 2);
      w.crateStack(49, 12); w.sandbags(53, 4, 4, Math.PI / 2); w.sandbags(53, -4, 3, Math.PI / 2);
      w.barrel(55, 16, 'burnt', true);
      w.box(83, 0, -15, 3, 1.5, 3, 'crate', { texScale: 1.5 }); w.box(82, 0, 14, 2, 2.5, 4, 'wood');
      w.ammoCrate = V(55, -18);
      w.box(55, 0, -18.5, 1.2, 0.6, 0.7, 'gunGreen');
      w.lampPost(47, 18, 0xffc080, -Math.PI / 2, 10);
      // 撤离区
      w.lzPos = V(94, 0);
      w.rock(96, -12, 1.8); w.rock(97, 14, 1.4);
      w.points = {
        start: V(-88, 0), outpost: V(-45, 0), village: V(10, 0), gate: V(44, 0), house: V(58, 0),
      };
      w.spawns.A = [V(-88, 0)]; w.spawns.B = [V(40, 0)];
      w.flagPos = [];
    },
  },
};
