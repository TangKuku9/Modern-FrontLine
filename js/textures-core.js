// 程序化纹理生成核心（性能审查 C4 抽核）——**纯计算**，零 THREE、零 DOM。
//
// 为什么要单独一份：这个核心要同时活在两个世界 —— 主线程（textures.js 把它包成
// CanvasTexture）和 Worker（js/worker.mjs 加载期把逐像素循环整体搬过去）。ES module
// worker 的模块解析不走页面的 import map，`'three'` 裸说明符当场解析失败，而 util.js
// 顶层 import 'three' —— 所以核心只能 import noise.js / rng.js 这种纯模块。
// 同一份代码喂两个世界，输出**逐位一致**（种子化噪声 + mulberry32，无任何 Math.random），
// 这是"worker 生成 vs 主线程回退"可以随时互换的根据。
import { TileNoise, clamp } from './noise.js';
import { mulberry32 } from './rng.js';

let SIZE = 512;
export function setTextureSize(s) { SIZE = s; }
export function getTextureSize() { return SIZE; }

// build 的纯计算一半：逐像素跑 gen，回填颜色/高度，再由高度场差分出法线，粗糙度可选。
// 返回裸 typed arrays（颜色/法线/粗糙度），包 canvas 是 textures.js 的事。
function buildData(gen, opts = {}) {
  const N = opts.size || SIZE;
  const H = new Float32Array(N * N);
  const C = new Uint8ClampedArray(N * N * 4);
  const R = opts.rough ? new Uint8ClampedArray(N * N * 4) : null;
  const out = { h: 0, r: 0, g: 0, b: 0, rough: 0.8 };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      out.h = 0.5; out.rough = 0.8;
      gen(x / N, y / N, out, x, y, N);
      H[i] = out.h;
      C[i * 4] = out.r; C[i * 4 + 1] = out.g; C[i * 4 + 2] = out.b; C[i * 4 + 3] = 255;
      if (R) { const v = clamp(out.rough, 0, 1) * 255; R[i * 4] = v; R[i * 4 + 1] = v; R[i * 4 + 2] = v; R[i * 4 + 3] = 255; }
    }
  }
  // 法线
  const strength = opts.normal ?? 3;
  const Nm = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const xl = H[y * N + ((x - 1 + N) % N)], xr = H[y * N + ((x + 1) % N)];
      const yu = H[((y - 1 + N) % N) * N + x], yd = H[((y + 1) % N) * N + x];
      let nx = (xl - xr) * strength * N / 256, ny = (yd - yu) * strength * N / 256, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * N + x) * 4;
      Nm[i] = (nx * 0.5 + 0.5) * 255; Nm[i + 1] = (ny * 0.5 + 0.5) * 255; Nm[i + 2] = (nz * 0.5 + 0.5) * 255; Nm[i + 3] = 255;
    }
  }
  return { color: C, normal: Nm, rough: R, N };
}

const n1 = new TileNoise(11, 128), n2 = new TileNoise(23, 128), n3 = new TileNoise(37, 128);

function setC(o, r, g, b) { o.r = r; o.g = g; o.b = b; }

// scree 的石头站点表：每格 6 个分量 [抖动x, 抖动y, 每石亮度, 面倾角x, 面倾角y, 备用]，
// 由格号种子化 mulberry32 一次性生成后缓存。站点数只有 G² 个，逐像素再各开 9 个
// mulberry32 太贵；这份缓存是纯函数结果（同种子同内容），Worker 路与同步路各自构建
// 也逐位一致。
const SCREE_G = 24;
let _screeSites = null;
function screeSites() {
  if (_screeSites) return _screeSites;
  const G = SCREE_G, S = new Float32Array(G * G * 6);
  for (let cy = 0; cy < G; cy++) {
    for (let cx = 0; cx < G; cx++) {
      const r = mulberry32(cy * G + cx + 1331), i = (cy * G + cx) * 6;
      S[i] = 0.14 + r() * 0.72;      // 站点抖动（留在格内，保证 3×3 邻域搜索完备）
      S[i + 1] = 0.14 + r() * 0.72;
      S[i + 2] = r();                // 每石亮度 0~1
      S[i + 3] = r() * 2 - 1;        // 石面倾角 x
      S[i + 4] = r() * 2 - 1;        // 石面倾角 y
      S[i + 5] = r();                // 备用
    }
  }
  _screeSites = S;
  return S;
}

// rock 的大断裂胞元站点表：每格 6 分量 [抖动x, 抖动y, 每块亮度, 面倾角x, 面倾角y, 备用]。
// 环面绕回与 screeSites 同款写法（那份是 scree 的，不动）：格数取整数、站点属性由格号
// 种子化 mulberry32 生成、邻格索引绕回 ⇒ 全周期、无 Math.random，两条路逐位一致。
const ROCK_BG = 6;                       // 粗胞元 6×6：大小不一的岩块，块间是大断裂
const ROCK_FX = 14, ROCK_FY = 5;         // 细胞元 x 密 y 疏：缝沿 y 拉长；第二族转置采样 → 横躺
let _rockBlocks = null, _rockJoints = null;
function rockBlocks() {
  if (_rockBlocks) return _rockBlocks;
  const G = ROCK_BG, S = new Float32Array(G * G * 6);
  for (let cy = 0; cy < G; cy++) {
    for (let cx = 0; cx < G; cx++) {
      const r = mulberry32(cy * G + cx + 7717), i = (cy * G + cx) * 6;
      S[i] = 0.16 + r() * 0.68;
      S[i + 1] = 0.16 + r() * 0.68;
      S[i + 2] = r();
      S[i + 3] = r() * 2 - 1;
      S[i + 4] = r() * 2 - 1;
      S[i + 5] = r();
    }
  }
  _rockBlocks = S;
  return S;
}
// 细裂隙族的站点抖动表（两族共用一张，第二族靠转置坐标采样）
function rockJoints() {
  if (_rockJoints) return _rockJoints;
  const GX = ROCK_FX, GY = ROCK_FY, S = new Float32Array(GX * GY * 2);
  for (let cy = 0; cy < GY; cy++) {
    for (let cx = 0; cx < GX; cx++) {
      const r = mulberry32(cy * GX + cx + 9931), i = (cy * GX + cx) * 2;
      S[i] = 0.18 + r() * 0.64;
      S[i + 1] = 0.18 + r() * 0.64;
    }
  }
  _rockJoints = S;
  return S;
}
// 周期 Voronoi 的"离下一条缝多远"：out=[次近距离-最近距离, 次近站点偏移x, 偏移y]（格单位）。
// fx/fy 是格单位坐标，邻格索引环面绕回 ⇒ 图缘两侧读到同一批站点。
function rockEdge(fx, fy, GX, GY, J, out) {
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const lx = fx - ix, ly = fy - iy;
  let d1 = 1e9, d2 = 1e9, s1x = 0, s1y = 0, s2x = 1, s2y = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const si = (((iy + dj) % GY + GY) % GY) * GX + ((ix + di) % GX + GX) % GX;
      const sx = di + J[si * 2] - lx, sy = dj + J[si * 2 + 1] - ly;
      const d = sx * sx + sy * sy;
      if (d < d1) { d2 = d1; s2x = s1x; s2y = s1y; d1 = d; s1x = sx; s1y = sy; }
      else if (d < d2) { d2 = d; s2x = sx; s2y = sy; }
    }
  }
  out[0] = Math.sqrt(d2) - Math.sqrt(d1); out[1] = s2x; out[2] = s2y;
}
const _re1 = new Float64Array(3), _re2 = new Float64Array(3);
// 各向异性格网里缝的像素宽在两轴上不等（1 格 = 512/FX px vs 512/FY px）：缝垂直于
// "次近站点偏移方向"，偏移越偏疏轴（e[2]，512/FY px 那一轴）就越相对压窄，用平滑
// 权重而不是硬切换，避免斜缝处出现跳变。
function rockAniso(e) {
  const uy = (e[2] * e[2]) / (e[1] * e[1] + e[2] * e[2] + 1e-9);
  return e[0] * (1 + (ROCK_FX / ROCK_FY - 1) * uy);
}

const GEN = {
  concrete(x, y, o) {
    const f = n1.fbm(x, y, 8, 6);
    const s = n2.fbm(x, y, 2, 3);
    const pit = n3.get(x, y, 128) > 0.93 ? -0.25 : 0;
    const v = 118 + (f - 0.5) * 60 - (s > 0.6 ? (s - 0.6) * 120 : 0) + pit * 80;
    setC(o, v, v * 0.99, v * 0.96);
    o.h = f * 0.6 + pit; o.rough = 0.85;
    // 接缝
    if (y % 0.5 < 0.004) { o.h -= 0.4; o.r *= 0.7; o.g *= 0.7; o.b *= 0.7; }
  },
  plaster(x, y, o) {
    const f = n1.fbm(x, y, 8, 6);
    const big = n2.fbm(x, y, 2, 4);
    const chip = n3.fbm(x, y, 4, 5);
    let r = 196, g = 172, b = 136;
    const t = (big - 0.5) * 50;
    r += t; g += t * 0.9; b += t * 0.8;
    o.h = 0.6 + f * 0.25;
    if (chip > 0.62) { // 剥落露出砖
      const bx = (x * 16 + (Math.floor(y * 32) % 2) * 0.5) % 1, by = (y * 32) % 1;
      const mortar = bx < 0.06 || by < 0.12;
      r = mortar ? 150 : 150 + f * 50; g = mortar ? 140 : 95 + f * 30; b = mortar ? 125 : 70;
      o.h = mortar ? 0.1 : 0.35;
    }
    const dirt = Math.max(0, y - 0.7) * 120 * big;
    setC(o, r + (f - 0.5) * 30 - dirt, g + (f - 0.5) * 30 - dirt, b + (f - 0.5) * 25 - dirt);
    o.rough = 0.92;
  },
  brick(x, y, o) {
    const rows = 16, cols = 6;
    const ry = y * rows, row = Math.floor(ry);
    const rx = x * cols + (row % 2) * 0.5, col = Math.floor(rx);
    const fx = rx - col, fy = ry - row;
    const mortar = fx < 0.05 || fy < 0.1;
    const f = n1.fbm(x, y, 16, 4);
    const rr = mulberry32(row * 131 + (col % cols) * 7)();
    if (mortar) { setC(o, 150 + f * 30, 145 + f * 30, 135 + f * 25); o.h = 0.1 + f * 0.1; }
    else {
      const k = 0.75 + rr * 0.4;
      setC(o, (140 + f * 50) * k, (70 + f * 30) * k, (50 + f * 20) * k);
      o.h = 0.6 + f * 0.3;
    }
    o.rough = 0.9;
  },
  sand(x, y, o) {
    const f = n1.fbm(x, y, 8, 6);
    const w = n2.fbm(x, y, 2, 3);
    const rip = Math.sin((y * 30 + w * 6) * Math.PI * 2) * 0.5 + 0.5;
    const grain = n3.get(x, y, 128);
    const v = (f - 0.5) * 40 + (grain - 0.5) * 18;
    setC(o, 196 + v, 164 + v * 0.9, 118 + v * 0.8);
    o.h = rip * 0.35 + f * 0.4 + grain * 0.1;
    o.rough = 0.95;
  },
  snow(x, y, o) {
    const f = n1.fbm(x, y, 4, 6);
    const d = n2.fbm(x, y, 8, 4);
    const v = 225 + (f - 0.5) * 40;
    setC(o, v - 8, v - 2, v + 6);
    if (d > 0.68) { const k = (d - 0.68) * 200; o.r -= k; o.g -= k; o.b -= k * 0.8; }
    o.h = f * 0.8; o.rough = 0.7;
  },
  asphalt(x, y, o) {
    const g = n3.get(x, y, 128), f = n1.fbm(x, y, 8, 5);
    const pud = n2.fbm(x, y, 2, 4);
    let v = 58 + (g - 0.5) * 30 + (f - 0.5) * 25;
    o.h = g * 0.3 + f * 0.3; o.rough = 0.85;
    if (pud > 0.58) { v *= 0.55; o.h = 0.3; o.rough = 0.06; }
    else if (pud > 0.53) { v *= 0.75; o.rough = 0.35; }
    setC(o, v, v, v * 1.03);
  },
  metal(x, y, o) {
    const ridge = Math.abs(Math.sin(x * Math.PI * 12));
    const f = n1.fbm(x, y, 8, 5);
    const rust = n2.fbm(x, y, 4, 5);
    const streak = n3.fbm(x * 0.1, y, 16, 3);
    let v = 200 + (f - 0.5) * 30 - streak * 25;
    let r = v, g = v, b = v;
    o.rough = 0.55;
    if (rust > 0.62) { const k = Math.min(1, (rust - 0.62) * 6); r = r * (1 - k) + 140 * k; g = g * (1 - k) + 80 * k; b = b * (1 - k) + 45 * k; o.rough = 0.9; }
    if (y > 0.9) { const k = (y - 0.9) * 6; r *= 1 - k * 0.5; g *= 1 - k * 0.5; b *= 1 - k * 0.5; }
    setC(o, r, g, b);
    o.h = ridge * 0.8 + f * 0.1;
  },
  wood(x, y, o) {
    const planks = 6;
    const py = y * planks, p = Math.floor(py), fy = py - p;
    const off = mulberry32(p * 17)();
    const grain = n1.fbm((x + off) % 1, y, 4, 5);
    const ring = Math.sin((grain * 20 + y * 40) * 2) * 0.5 + 0.5;
    const k = 0.8 + off * 0.35;
    let r = (120 + ring * 30) * k, g = (85 + ring * 20) * k, b = (55 + ring * 10) * k;
    o.h = 0.5 + ring * 0.2;
    if (fy < 0.05 || fy > 0.97) { r *= 0.4; g *= 0.4; b *= 0.4; o.h = 0; }
    setC(o, r, g, b); o.rough = 0.8;
  },
  crate(x, y, o) {
    GEN.wood(x, y, o);
    const e = Math.min(x, y, 1 - x, 1 - y);
    const diag = Math.abs(x - y) < 0.05;
    if (e < 0.08 || diag) { o.r *= 0.8; o.g *= 0.75; o.b *= 0.7; o.h = 0.9; }
    if (e > 0.075 && e < 0.09) { o.h = 0.1; o.r *= 0.5; o.g *= 0.5; o.b *= 0.5; }
  },
  dirt(x, y, o) {
    const f = n1.fbm(x, y, 8, 6), s = n2.fbm(x, y, 3, 4), p = n3.get(x, y, 128);
    let r = 98 + (f - 0.5) * 50, g = 80 + (f - 0.5) * 40, b = 60 + (f - 0.5) * 30;
    if (s > 0.6) { r -= 20; g -= 16; b -= 12; }
    o.h = f * 0.6;
    if (p > 0.9) { r += 40; g += 38; b += 36; o.h += 0.3; }
    setC(o, r, g, b); o.rough = 0.95;
  },
  grass(x, y, o) {
    const f = n1.fbm(x, y, 8, 6), s = n2.fbm(x, y, 2, 4), bl = n3.get(x, y * 0.3, 128);
    const dry = s;
    let r = 70 + dry * 70 + bl * 30, g = 80 + dry * 40 + bl * 30, b = 40 + bl * 10;
    r += (f - 0.5) * 30; g += (f - 0.5) * 30;
    setC(o, r, g, b); o.h = bl * 0.6 + f * 0.3; o.rough = 0.95;
  },
  // 岩体：暖灰大起伏的底（原 f）+ **块状断裂**缝网（两级尺度、两族走向）。
  // 旧实现取平滑噪声 c 的一条等值线（|c-0.5|<0.02）当裂隙 —— 等值线在数学上必然是
  // 闭合曲线族，硬阈值又让边缘锯齿，读起来就是手绘等高线。改法：
  // ① 粗 Voronoi 胞元（6×6）给大小不一的岩块，块间是大断裂，缝宽随位置连续起伏；
  // ② 细裂隙两族正交：胞元 x 密 y 疏 → 缝沿 y 拉长（构造应力拉出的节理），第二族把
  //    采样坐标转置 → 横躺一族；单一平行缝族在局部与等值线族同构（方向一致性尺子
  //    实测新旧分不开，见交付报告），两族交切才既像真岩体又打破等值线指纹；
  // ③ 所有缝深都是 smoothstep 连续过渡，没有任何硬阈值。
  // 全部周期源（整数格 Voronoi + TileNoise + mulberry32 站点表），图缘不撕裂、逐位一致。
  rock(x, y, o) {
    const f = n1.fbm(x, y, 4, 7); // 原有大起伏：保住暖灰基调与明暗
    // ── 粗胞元：大断裂（岩块之间的宽缝；还要拿块号取亮度/倾角，循环留在原地）──
    const G = ROCK_BG, S = rockBlocks();
    const fx = x * G, fy = y * G;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const lx = fx - ix, ly = fy - iy;
    let d1 = 1e9, d2 = 1e9, bi = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const si = (((iy + dj) % G + G) % G) * G + ((ix + di) % G + G) % G;
        const sx = di + S[si * 6] - lx, sy = dj + S[si * 6 + 1] - ly;
        const d = sx * sx + sy * sy;
        if (d < d1) { d2 = d1; d1 = d; bi = si; }
        else if (d < d2) d2 = d;
      }
    }
    const b1 = Math.sqrt(d1), b2 = Math.sqrt(d2);
    // 缝宽随位置连续变化（周期噪声调制），深度 smoothstep —— 硬阈值是旧锯齿的来源
    const wB = 0.10 + 0.10 * n2.get(x, y, 8);
    let gB = clamp((b2 - b1) / wB, 0, 1); gB = gB * gB * (3 - 2 * gB);
    // ── 细胞元：两族正交节理（各族内部各向异性，族间交切）──
    const J = rockJoints();
    rockEdge(x * ROCK_FX, y * ROCK_FY, ROCK_FX, ROCK_FY, J, _re1);
    rockEdge(y * ROCK_FX, x * ROCK_FY, ROCK_FX, ROCK_FY, J, _re2); // 转置采样 → 缝族横躺
    const wS = 0.075 + 0.05 * n3.get(x, y, 16) + 0.03 * n1.get(x, y, 48);
    let gS1 = clamp(rockAniso(_re1) / wS, 0, 1); gS1 = gS1 * gS1 * (3 - 2 * gS1);
    let gS2 = clamp(rockAniso(_re2) / wS, 0, 1); gS2 = gS2 * gS2 * (3 - 2 * gS2);
    // 节理成群不铺满（真实岩体裂隙有密集带也有完整块面）：两族各由一片低频周期 fbm
    // 连续门控（clamp 线性过渡，非硬阈值），缝深按门控比例衰减到 0。
    const gate1 = clamp((n3.fbm(x, y, 2, 3) - 0.40) * 3.2, 0, 1);
    const gate2 = clamp((n2.fbm(x, y, 3, 3) - 0.42) * 3.2, 0, 1);
    const gs1 = 1 - (1 - gS1) * gate1, gs2 = 1 - (1 - gS2) * gate2;
    // ── 合成：缝深连续、块体各有亮度、块面微倾 ──
    const tone = S[bi * 6 + 2], tiltx = S[bi * 6 + 3], tilty = S[bi * 6 + 4];
    const facet = ((lx - S[bi * 6]) * tiltx + (ly - S[bi * 6 + 1]) * tilty) * 0.14;
    const grit = n2.get(x, y, 24); // 中尺度砂面起伏（不用高频：高频噪声会让梯度方向总体杂乱，掩盖缝网结构）
    const crack = (1 - gB) + 0.45 * (1 - gs1) + 0.45 * (1 - gs2); // 缝深（块内部为 0）
    const v = (120 + (f - 0.5) * 48 + (tone - 0.5) * 24 + (grit - 0.5) * 14)
      * (0.52 + 0.48 * gB) * (0.83 + 0.17 * gs1) * (0.83 + 0.17 * gs2);
    setC(o, v, v * 0.95, v * 0.88);
    o.h = 0.42 + (f - 0.5) * 0.5 + tone * 0.10 + facet + (grit - 0.5) * 0.06 - crack * 0.26;
    o.rough = 0.9;
  },
  // 松散碎石坡：Voronoi 胞元做"一颗一颗"的棱角石子，无方向性（没有任何 sin 条纹）。
  // 周期性靠三点：格数 G 是整数、格内抖动与每石属性由 (格号 mod G) 种子化 mulberry32
  // 生成、邻格搜索用环面绕回 —— 图缘两侧读到的是同一批石头，法线差分的 wrap 取邻居
  // 因此不会撕裂。高度场 = 石面隆起 + 缝隙下凹，缝隙窄而深；颜色亮灰偏暖、每石一亮度，
  // 粗糙度石面 0.7~0.9 起伏、缝隙压到 0.95+（"石头亮、缝隙暗"同时体现在 albedo 与 rough）。
  scree(x, y, o) {
    const G = SCREE_G, S = screeSites();
    const fx = x * G, fy = y * G;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const lx = fx - ix, ly = fy - iy; // 格内局部坐标
    let d1 = 1e9, d2 = 1e9, bi = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        // 环面绕回的站点索引：di/dj 是真格阵偏移（跨图缘不折返），索引只用于取站点数据
        const si = (((iy + dj) % G + G) % G) * G + ((ix + di) % G + G) % G;
        const sx = di + S[si * 6] - lx, sy = dj + S[si * 6 + 1] - ly;
        const d = sx * sx + sy * sy;
        if (d < d1) { d2 = d1; d1 = d; bi = si; }
        else if (d < d2) d2 = d;
      }
    }
    const r1 = Math.sqrt(d1), r2 = Math.sqrt(d2);
    // 缝隙场：到第二近站点的距离减一就是"离边界多远"，smoothstep 收成窄脊
    let gt = clamp((r2 - r1) * 3.2, 0, 1); gt = gt * gt * (3 - 2 * gt);
    const tone = S[bi * 6 + 2], tiltx = S[bi * 6 + 3], tilty = S[bi * 6 + 4];
    const grain = n1.fbm(x, y, 32, 4), grit = n3.get(x, y, 128);
    // 石面各自微倾（各向异性的斜面，但倾角逐石随机 → 整体无方向性）
    const facet = ((lx - S[bi * 6]) * tiltx + (ly - S[bi * 6 + 1]) * tilty) * 0.16;
    o.h = 0.12 + gt * (0.5 + tone * 0.22) - r1 * 0.16 + facet + (grain - 0.5) * 0.08;
    const v = (128 + tone * 66 + (grain - 0.5) * 26 + (grit - 0.5) * 14) * (0.34 + 0.66 * gt);
    setC(o, v * 1.05, v, v * 0.92); // 亮灰偏暖
    o.rough = clamp(0.74 + tone * 0.16 + (grit - 0.5) * 0.1 + (1 - gt) * 0.18, 0, 1);
  },
  // 细节法线专用高频颗粒：着色器只读它的 normalMap，颜色做中性灰占位。三层 TileNoise
  // 叠加（96/64/128 格，256px 图上约 1~3px 一格 → 逐像素级起伏），配合 texJobs 里
  // 单独给的高 normal 强度，保证法线不是平面。全部周期源，无图缘撕裂。
  micro(x, y, o) {
    const a = n1.get(x, y, 96), b = n2.get(x, y, 64), c = n3.get(x, y, 128);
    const v = 122 + (a - 0.5) * 44 + (b - 0.5) * 32 + (c - 0.5) * 24;
    setC(o, v, v, v);
    o.h = a * 0.4 + b * 0.34 + c * 0.26;
    o.rough = 0.9;
  },
  sandbag(x, y, o) {
    const wx = Math.sin(x * Math.PI * 256), wy = Math.sin(y * Math.PI * 256);
    const f = n1.fbm(x, y, 8, 4);
    const v = (wx * wy) * 0.5 + 0.5;
    setC(o, 150 + f * 40 + v * 15, 130 + f * 35 + v * 12, 90 + f * 25 + v * 8);
    o.h = v * 0.4 + f * 0.3; o.rough = 1;
  },
  fabric(x, y, o, px, py, N, cfg) {
    const c = cfg.colors;
    const f = n1.fbm(x, y, 4, 4);
    const f2 = n2.fbm(x, y, 8, 3);
    let col = c[0];
    if (f > 0.55) col = c[1];
    if (f2 > 0.6) col = c[2];
    if (f < 0.38) col = c[3] || c[0];
    const weave = (Math.sin(x * Math.PI * 200) * Math.sin(y * Math.PI * 200)) * 6;
    setC(o, col[0] + weave, col[1] + weave, col[2] + weave);
    o.h = 0.5 + weave * 0.03; o.rough = 0.95;
  },
  tiles(x, y, o) {
    const fx = (x * 8) % 1, fy = (y * 8) % 1;
    const f = n1.fbm(x, y, 16, 3);
    const g = fx < 0.04 || fy < 0.04;
    const v = g ? 90 : 170 + (f - 0.5) * 30;
    setC(o, v, v * 0.97, v * 0.92); o.h = g ? 0 : 0.5; o.rough = g ? 0.9 : 0.4;
  },
};

export function genTextureData(kind, opts = {}) {
  let g = GEN[kind];
  if (opts.cfg) { const base = g; g = (x, y, o, px, py, N) => base(x, y, o, px, py, N, opts.cfg); }
  return buildData(g, opts);
}

// 枪械涂装
export function genCamoData(kind) {
  const N = 256;
  const gen = {
    desert: (x, y, o) => { const f = n1.fbm(x, y, 4, 4); const c = f > 0.6 ? [120, 95, 60] : f > 0.45 ? [175, 150, 105] : [205, 185, 140]; setC(o, ...c); },
    woodland: (x, y, o) => { const f = n1.fbm(x, y, 4, 4), g = n2.fbm(x, y, 6, 3); let c = [70, 85, 45]; if (f > 0.55) c = [45, 40, 30]; if (g > 0.6) c = [110, 100, 60]; if (f < 0.38) c = [30, 35, 25]; setC(o, ...c); },
    digital: (x, y, o) => { const qx = Math.floor(x * 32) / 32, qy = Math.floor(y * 32) / 32; const f = n1.fbm(qx, qy, 4, 3); const c = f > 0.6 ? [40, 44, 50] : f > 0.47 ? [110, 115, 120] : [175, 180, 185]; setC(o, ...c); },
    tiger: (x, y, o) => { const f = n1.fbm(x, y, 2, 3); const s = Math.sin((x * 10 + f * 4) * Math.PI) > 0.55; setC(o, ...(s ? [25, 20, 15] : [200, 120, 30])); },
    gold: (x, y, o) => { const f = n1.fbm(x, y, 8, 4); setC(o, 230 + f * 20, 180 + f * 30, 70 + f * 20); },
    dragon: (x, y, o) => { const sx = (x * 16) % 1, sy = (y * 16 + (Math.floor(x * 16) % 2) * 0.5) % 1; const d = Math.hypot(sx - 0.5, sy - 0.2); const f = n1.fbm(x, y, 4, 3); const e = d < 0.55 ? 1 - d : 0.3; setC(o, 150 * e + 60 * f, 20 * e, 20 * e); },
  }[kind];
  return buildData(gen, { size: N, normal: 1 });
}
