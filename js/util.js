// 通用工具：数学、随机、噪声
import * as THREE from 'three';
import { rng, mulberry32 } from './rng.js';
import { clamp, lerp } from './noise.js';
// 随机相关的实现统一收在 rng.js（玩法流/画面流双流），此处转出以保持既有 import 不变
export { mulberry32, crandRange, rng, crand, rand, randInt, pick, shuffle, entStream } from './rng.js';
// clamp/lerp/TileNoise 收进 noise.js（性能审查 C4 抽核）：textures-core 与寻路 Worker
// 要在**没有 import map 的环境**里跑，'three' 裸说明符当场解析失败 —— 这三个小件必须
// 与 THREE 断开。此处转出保持既有 import 不变（rng.js 同款先例）。
export { clamp, lerp, TileNoise } from './noise.js';

export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const DEG = Math.PI / 180;

export function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// 射线-AABB (slab)，返回 t 或 -1
export function rayAABB(ox, oy, oz, dx, dy, dz, b, maxT) {
  let tmin = 0, tmax = maxT;
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  let t1 = (b.x0 - ox) * idx, t2 = (b.x1 - ox) * idx;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  if (tmin > tmax) return -1;
  t1 = (b.y0 - oy) * idy; t2 = (b.y1 - oy) * idy;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  if (tmin > tmax) return -1;
  t1 = (b.z0 - oz) * idz; t2 = (b.z1 - oz) * idz;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  if (tmin > tmax) return -1;
  return tmin;
}

export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return -1;
  const thc = Math.sqrt(r * r - d2);
  const t = tca - thc;
  return t >= 0 ? t : (tca + thc >= 0 ? 0 : -1);
}

// 在给定方向附近加扩散（玩法流：决定弹道，必须可播种）
const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3();
// stream 默认公共流；联机里"每个人各自要重算出同一个数"的那几处（枪的散布）必须传
// 这个人自己的私有流，否则服务端替别人抽的数会把这条流的游标挪走。见 js/rng.js:entStream。
export function spreadDir(dir, spreadRad, out = new THREE.Vector3(), stream = rng) {
  if (spreadRad <= 0) return out.copy(dir);
  const up = Math.abs(dir.y) > 0.99 ? _tmpA.set(1, 0, 0) : _tmpA.set(0, 1, 0);
  const right = _tmpB.crossVectors(dir, up).normalize();
  const up2 = up.crossVectors(right, dir).normalize();
  const r = Math.sqrt(stream.next()) * Math.tan(spreadRad);
  const a = stream.next() * Math.PI * 2;
  out.copy(dir).addScaledVector(right, Math.cos(a) * r).addScaledVector(up2, Math.sin(a) * r).normalize();
  return out;
}

export function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

// 启动那根进度条的台阶表（HUD 审计 HU-31）。贴图生成占 0~80% —— 那一段是**量出来的**
// （js/textures.js 的 initTextures 回调给的是真实完成比例，它也是加载期 CPU 的大头），
// 剩下的 20% 按这两步均分、每步**做完**才挪一格。原来那是两个硬写的 90% / 100%：后面
// 没有任何测量，屏幕上的数与还剩多少活没关系，而"卡住了"和"正在建菜单场景"在那一格上
// 长得一模一样。文字与宽度现在同取这一张表（HU-38 那条纪律：同一格只有一份）。
export const BOOT_STEPS = ['正在初始化渲染管线…', '正在构建菜单场景…'];
export const bootPct = (step, frac = 1) => 80 + Math.min(20, Math.max(0, ((step + frac) / BOOT_STEPS.length) * 20));

// BinaryHeap 迁去 pathfind.js（性能审查 C5 抽核）：寻路 Worker 里没有 import map，
// util.js 顶层 import 'three' 进不去 —— 本体在那边，此处转出保持既有 import 不变。
export { BinaryHeap } from './pathfind.js';

