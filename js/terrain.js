// 地形高度场 —— **零 THREE、零 DOM**（与 noise.js / pathfind.js 同一路子）。
//
// 为什么独立成一份纯模块：`js/world.js` 是**客户端预测与服务端权威共用的同一份文件**
// （server/headless-game.mjs 动态 import 它），而"连绵起伏的丘陵"要求地面不再是一张
// y=0 的平板 —— 于是地面高度第一次成了**模拟输入**。它一旦参与模拟，就必须两端逐位一致：
// 高度算错一点点，客户端预测与权威端的着地判定就分叉，回滚链每拍都在纠偏（判据
// test/rollback / reconcile-chain / lagcomp 全踩在上面）。所以这里只有纯算术，没有
// 任何对象分配顺序、Map遍历序、Date/随机数之类的东西。
//
// 三条纪律：
//   ① **采样与渲染同面**。渲染网格按 cell 铺三角形，采样用同一套三角形的重心坐标插值
//      ——不是双线性、也不是格心值。视觉上是一张坡，走上去的高度就是那张坡的高；
//      两者一旦分了家，就会出现"脚陷进土里 / 悬在半空"这种一眼看穿的错。
//   ② **一行高度场 = 一个数**，与查询顺序无关：height() 只依赖 (x,z) 与已烘好的数组，
//      不依赖"上一次问过哪里"。碰撞查询的候选集是超集、遍历序不影响结果，这条是命门。
//   ③ **ray 的步进与细化步数固定**，不做自适应外插：自适应会让"同一发子弹在服务端
//      走了 3 步、客户端走了 4 步"，落点差几厘米。宁可多走几步也要两端同序同数。
//
// 高度场用 Float32Array 烘焙（一张图 200×200 格 = 4 万个 float = 160KB，逐位可复现）。
// 噪声用 noise.js 的 TileNoise —— 它是既有的、纯数值的、已被远山(mountains)用过的。
import { TileNoise, clamp } from './noise.js';

// 坡度分类（tan 角）：导航与摆件的判据都读这张表，别在别处另写一份阈值。
// 坡度分级（tan 值，即每米水平抬升多少米）：
//   FLAT0.18 ≈ 10°  路面/平地    ROLLING 0.42 ≈ 23°  可正常行走（导航门槛）
//   ROAD  0.62 ≈ 32°  **修出来的路**（盘山公路本来就比野地陡，见world.js buildGrid）
//   STEEP 0.85 ≈ 40°  需要攀爬    CLIFF 更大    挡人
// 玩家物理（world.js collide）的两挡也用这张表：ROLLING..STEEP 是**爬坡阻力带**
// （走得上去但越陡越慢，贴 STEEP 处一步一滑），> STEEP 才硬挡。墙取 STEEP 是因为
// A* 的路点是格子级采样、玩家走连续坐标，路面接缝处两套读数能差 0.1+ —— 墙低于
// 导航放行口径的话，bot 会被自己的物理墙钉死在缝上。
export const SLOPE = { FLAT: 0.18, ROLLING: 0.42, ROAD: 0.62, STEEP: 0.85 };

// 一格 cell 的米数。2m：细到能承住"上坡走着硌一下"的体感，粗到一张大图只有几万格。
export const CELL = 2;

export class Terrain {
  // shape: (x, z) => 高度（米）。烘焙期跑 (n+1)² 次，查询期一次都不再调它 ——
  // 所以 shape 里可以放任意贵的噪声，代价全在开局那一次。
  constructor(half, shape, opt = {}) {
    this.half = half;
    this.cell = opt.cell || CELL;
    this.n = opt.n || Math.ceil((half * 2) / this.cell);
    this.sandY = opt.sandY ?? 0.15;      // 沙地最低处：低于它就算下沉区
    this.waterY = opt.waterY ?? null;     // 有值时低于它的格子在 minimap 上画水
    // (n+1)×(n+1) 个格点：格点 (i,j) 覆盖角点，四格点围一个 cell。
    const n1 = this.n + 1;
    this.h = new Float32Array(n1 * n1);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j <= this.n; j++) {
      const z = -half + j * this.cell;
      for (let i = 0; i <= this.n; i++) {
        const x = -half + i * this.cell;
        const v = shape(x, z);
        this.h[j * n1 + i] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    this.min = lo; this.max = hi;
  }

  // 格点原始高度（不做面插值）。给烘焙/摆件/判据用。
  at(i, j) {
    const n1 = this.n + 1;
    if (i < 0) i = 0; else if (i > this.n) i = this.n;
    if (j < 0) j = 0; else if (j > this.n) j = this.n;
    return this.h[j * n1 + i];
  }

  // 重心坐标插值：把 (x,z) 落到它所在的那个 cell 的三角面上（与 render() 同一套对角线划分）。
  // 出图界返回边界格点的值 —— 查询照常发生（子弹会飞出图外），不能返回 NaN/0 之类。
  height(x, z) {
    const c = this.cell, half = this.half, n = this.n;
    let fx = (x + half) / c, fz = (z + half) / c;
    // 出图界：把 fx/fz 夹进 [0, n]，再把**下标**并进最后一个 cell。
    //
    // 这里必须**先算出 fx/fz 再定下标**，不能反过来夹下标。四个角（含 (0,n) 那个
    // 图角）要还原出原始格点高度，就要求落在角上时 u、v 都等于 1：
    //   角 (0,n) → 落进 cell (0, n-1)，u=0, v=1，走三角形 B，权重把 h01 拉满 ✓
    // 早一版先 floor 再夹下标，角点被并到 cell(0, n-1) 时 v 仍按 fz 算成 0，
    // 于是拿 h00/h10 去插值，角上凭空差出几厘米（实测 2.9e-2 m）。
    if (fx < 0) fx = 0; else if (fx > n) fx = n;
    if (fz < 0) fz = 0; else if (fz > n) fz = n;
    // 图缘那一圈（fx==n 或 fz==n）直接返回格点原值。
    //
    // 最外圈的格点只在**一个**三角形里有定义（图内那一侧）；把它当成 cell 的 u=1
    // 角落去插值，权重会把它往图内侧的邻居上拉，于是在边上那列/行出现偏差
    // （实测 539/194400 个顶点，量级 1e-5~3e-2 m）。这些点本来就是边界，
    // 直接返回烘焙值既精确又便宜 —— 子弹打出图外时也走这条路。
    if (fx >= n || fz >= n) return this.at(Math.round(fx), Math.round(fz));
    let i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    // 对角线 (i,j)-(i+1,j+1)：u+v<1 走三角形 A(h00,h10,h11)，否则走 B(h00,h11,h01)。
    // 分界用 `<` 而不是 `<=`：对角线本身属于三角形 B。用 `<=` 时落在对角线上的点
    // 会走 A，而 A 在那条边上是通过 h10 的，与"对角线属于 B"的前提自相矛盾。
    const h00 = this.at(i, j), h10 = this.at(i + 1, j), h11 = this.at(i + 1, j + 1), h01 = this.at(i, j + 1);
    let y;
    if (u + v < 1) y = h00 + (h10 - h00) * u + (h11 - h10) * v;
    else y = h00 + (h11 - h01) * u + (h01 - h00) * v;
    return y;
  }

  // 中心差分梯度（每米）。步长取一格：再小会陷进噪声的颗粒里，再大会抹平真实的脊。
  grad(x, z) {
    const e = this.cell;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const k = 1 / (2 * e);
    return { x: hx * k, z: hz * k };
  }

  // 坡度（tan 角 = 梯度模长）。判定用 <= 还是 >= 见各自调用点。
  slope(x, z) {
    const g = this.grad(x, z);
    return Math.hypot(g.x, g.z);
  }

  // 导航可行走：坡度低于 ROLLING 才算数。陡坡挡路 —— 既是"人能爬上去吗"，
  // 也是 bot 的 A* 能不能过（astarPath 只看 grid 这一个数组）。
  walkableAt(x, z, maxSlope = SLOPE.ROLLING) {
    return this.slope(x, z) <= maxSlope;
  }

  // 把点夹回图内，并让出生点/摆件离开陡坡 —— 直接拿手放的坐标常常正好在斜坡上，
  // 站着会一路往下滑。往坡度梯度下降方向多走几步就是平的。
  settle(x, z, maxSlope = SLOPE.FLAT, tries = 24) {
    let px = clamp(x, -this.half + 4, this.half - 4);
    let pz = clamp(z, -this.half + 4, this.half - 4);
    for (let i = 0; i < tries; i++) {
      const g = this.grad(px, pz);
      const m = Math.hypot(g.x, g.z);
      if (m <= maxSlope) break;
      // 沿梯度反向走一步；梯度近零（局部洼地）时随便找个方向先离开，再由下一轮收敛
      const dx = m > 1e-6 ? -g.x / m : Math.cos(i * 2.399);
      const dz = m > 1e-6 ? -g.z / m : Math.sin(i * 2.399);
      px = clamp(px + dx * this.cell, -this.half + 4, this.half - 4);
      pz = clamp(pz + dz * this.cell, -this.half + 4, this.half - 4);
    }
    return { x: px, z: pz };
  }

  // 射线 × 高度场：沿射线固定步长采样，找到"由上而下穿出面"的那一段再二分细化。
  //
  // 为什么不做 DDA/精确三角求交：高度场的面是**斜的**，射线与斜面求交要解一次线性方程
  // 再算重心坐标，跨越格边界时还要处理正好打在棱上的退化情形。步进 + 二分在这些
  // 边界上稳得多，代价只是几微米的落点误差 —— 而落点误差在 2m 的子弹体积面前可以忽略。
  // 真正要守住的是**确定性**：步数与二分数固定（见 STEPS / REFINE），两端同一条子弹
  // 走过同一串采样点。这条纪律是回滚链的前提。
  ray(ox, oy, oz, dx, dy, dz, maxT) {
    const STEPS = 256;    // 步进上限：400m 的典型射程配 2m 步长富富有余
    const REFINE = 24;    // 二分细化次数：2m/2^24 ≈ 1.2e-7 m，比双精度噪声小好几个量级
    const maxSlopeY = this.max + 2;
    const minSlopeY = this.min - 2;
    let t = 0, tPrev = 0;
    let above = oy - this.height(ox, oz) > 0;
    if (!above) {                       // 起点就在地下：立刻判为命中，t=0
      return { t: 0, y: oy - this.height(ox, oz), slope: 0 };
    }
    for (let i = 0; i <= STEPS; i++) {
      // 剩下的路程按固定格长铺满：最后一段用 min 保证不越过 maxT（越界会算到图外的面）
      const remain = maxT - t;
      const step = Math.min(this.cell, remain);
      const nt = t + step;
      const px = ox + dx * nt, py = oy + dy * nt, pz = oz + dz * nt;
      // 整段都在高度带之外 → 不可能相交，跳过（省掉大半采样）
      if (py > maxSlopeY && dy >= 0) { t = nt; tPrev = t; continue; }
      if (py < minSlopeY && dy <= 0) { t = nt; tPrev = t; continue; }
      const h = this.height(px, pz);
      if (py <= h) {
        // [tPrev, nt] 之间穿面：固定二分 REFINE 次（不提前退出 —— 提前退出会让两端步数不同）
        let lo = tPrev, hi = nt;
        for (let k = 0; k < REFINE; k++) {
          const m = (lo + hi) * 0.5;
          const my = oy + dy * m, mxx = ox + dx * m, mzz = oz + dz * m;
          if (my <= this.height(mxx, mzz)) hi = m; else lo = m;
        }
        const hy = this.height(ox + dx * hi, oz + dz * hi);
        return { t: hi, y: oy + dy * hi - hy, slope: this.slope(ox + dx * hi, oz + dz * hi) };
      }
      tPrev = nt; t = nt;
      if (t >= maxT) break;
    }
    return null;
  }

  // 渲染缓冲：顶点 (x,y,z)、UV（按世界尺度铺，贴图不随图变大而缩密）、可选逐顶点色、三角索引。
  // 法线由 three 的 computeVertexNormals 从同一批三角形算出 —— 采样用的面和画出来的面
  // 必须是同一张（见开头纪律①），所以这里只交出位置与索引。
  // colorFn(x, z, y, slope) -> [r,g,b]（0..1，可选）。**道路与岩面就是靠它画出来的**：
  // 一条压着坡面的路没法用平板去铺（会一段段翘起来），而逐顶点色天然贴合每一张面。
  render(stride = 6, colorFn = null) {
    const n = this.n, c = this.cell, half = this.half, n1 = n + 1;
    const vcount = n1 * n1;
    const pos = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    const col = colorFn ? new Float32Array(vcount * 3) : null;
    const idx = new Uint32Array(n * n * 6);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const k = j * n1 + i;
        const x = -half + i * c, z = -half + j * c, y = this.h[k];
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / stride;
        uv[k * 2 + 1] = z / stride;
        if (col) {
          // 坡度用相邻格点差分（不递归调 slope —— 那会在格点重复算三次同样的中心差分）
          const dx = this.at(i + 1, j) - this.at(i - 1, j);
          const dz = this.at(i, j + 1) - this.at(i, j - 1);
          const rgb = colorFn(x, z, y, Math.hypot(dx, dz) / (2 * c));
          col[k * 3] = rgb[0]; col[k * 3 + 1] = rgb[1]; col[k * 3 + 2] = rgb[2];
        }
      }
    }
    let p = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * n1 + i, b = a + 1, d = a + n1, e = d + 1;
        // 与 height() 同一条对角线 (i,j)-(i+1,j+1)，两个三角形绕向相反
        idx[p++] = a; idx[p++] = d; idx[p++] = b;
        idx[p++] = b; idx[p++] = d; idx[p++] = e;
      }
    }
    return { pos, uv, idx, col, n1 };
  }

  // 法线（由采样点两侧的面法线平均得到，只给摆件用：让树/箱子贴合坡向，不参与模拟）
  normalAt(x, z) {
    const g = this.grad(x, z);
    const m = Math.hypot(g.x, 1, g.z);
    return { x: -g.x / m, y: 1 / m, z: -g.z / m };
  }

  // minimap 用的低分辨率高程图（含坡向明暗）。回调用 imageData 填，
  // 但**本模块不碰 DOM** —— 由 world.js 拿着像素数组来调。
  paintHeight(cb, N) {
    const half = this.half;
    const span = (half * 2) / (N - 1);
    for (let py = 0; py < N; py++) {
      const z = -half + py * span;
      for (let px = 0; px < N; px++) {
        const x = -half + px * span;
        const y = this.height(x, z);
        // 明暗：西向光（太阳偏西），用 -gx 做亮度项，凸起的地方亮
        const g = this.grad(x, z);
        const lit = clamp(0.5 - g.x * 0.42 + g.z * 0.18, 0, 1);
        cb(px, py, y, lit, this.waterY != null && y < this.waterY);
      }
    }
  }
}

// 平滑衰减（smootherstep 的 0..1 版本）：山脚、营地台地、堤道都用它，
// 比线性插值少一道折痕 —— 在 60Hz 的坡面上，一折就是一道可见的"台阶线"。
export function falloff(d, edge0, edge1) {
  if (edge1 <= edge0) return d < edge0 ? 1 : 0;
  const t = clamp((d - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// 高斯鼓包：给两处高地用。h += amp * exp(-(d/r)²)，比 1/(1+d²) 更"顶得住"，
// 中心近似平台、四周衰减干净。
//
// 指数是 **2 不是 4**：写成 q=(d/r)² 之后再 exp(-q*q) 等于 exp(-(d/r)⁴)，
// 那是"台顶 + 陡壁"—— 侧坡最陡处梯度是同半径高斯的四倍，一座高地就变成一圈
// 爬不上去的悬崖，整张图的导航网格会被切成孤岛（实测：连通率 0%）。
// 高地要的是"缓坡登顶"，所以指数必须是 2。
export function mound(dx, dz, cx, cz, r, amp) {
  const q = (dx * dx + dz * dz) / (r * r);
  return amp * Math.exp(-q);
}

// 台地：在 radius 内压到 target 高，edge 处平滑过渡。军营、高地台顶、出生平台都靠它 ——
// 它是唯一能把"某块地必须平"这件事写进高度场的东西。
export function terrace(h, dx, dz, cx, cz, radius, edge, target) {
  const d = Math.hypot(dx - cx, dz - cz);
  const w = 1 - falloff(d, radius, edge);
  return h + (target - h) * w;
}

// 坡道：把地形往"沿折线线性插值出来的高度"拉，形成一条能走上高地的路。
//
// 为什么非有它不可：terrace() 把高台压平是对的，可它两侧就是 mound 的陡坡
// （实测坡度 0.6~0.9，直接被导航网格判成不可走），于是高台成了一座**孤岛** ——
// 塔盖好了，人却上不去。真实地图里高地从来配一条盘山路：不是地形自己长出来的，
// 是修出来的。所以这里显式开一条走廊，沿路把高度往线性剖面拉。
//
// path: [[x,z,h], ...] 折线，h 是该点应有的高度（必须与两端台地高度接得上）。
// width: 走廊半宽；edge: 完全过渡出去的距离。
export function ramp(h, dx, dz, path, width, edge) {
  // 先找最近的**段**，并记住它是第几段 —— 下面按段插值高度。
  let best = Infinity, bestT = 0, bestI = 0, found = false;
  for (let i = 0; i + 1 < path.length; i++) {
    const ax = path[i][0], az = path[i][1];
    const vx = path[i + 1][0] - ax, vz = path[i + 1][1] - az;
    const L2 = vx * vx + vz * vz;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((dx - ax) * vx + (dz - az) * vz) / L2)) : 0;
    const d = Math.hypot(dx - (ax + vx * t), dz - (az + vz * t));
    if (!found || d < best) { best = d; bestT = t; bestI = i; found = true; }
  }
  if (!found) return h;
  // 段内线性插值出该点的目标高度。注意用 bestI/bestT，**不要**把它们当成
  // "整条折线上的参数"再乘一遍总长 —— 那会取到别的段的高度去用（实测：山顶被
  // 拉低到 13m，路修到了半山腰）。
  const target = path[bestI][2] + (path[bestI + 1][2] - path[bestI][2]) * bestT;
  const w = 1 - falloff(best, width, edge);
  return h + (target - h) * w;
}

// 坡道 + **起点冻结区**：走廊头几米不抬升，让路贴着起点的地面走。
//
// 为什么需要它：ramp 把走廊往目标剖面拉，而剖面从起点就开始爬。起点在营区台地上时，
// 于是**整片台地都被往上抬** —— 实测南坡道把营区东南角（弹药油料区）垫高了 3.4m，
// 箱堆和油桶就摆在这块凭空隆起的土包上，高差 2.5m。
//
// freeze 段（折线开头 freeze 个长度）内，目标高恒等于**起点那一点的地面高**，
// 于是"路在营区里"与"地形在营区里"完全一致，谁也不动谁；出了 freeze 段才开始爬。
// 这也更贴近真实：山路起点就是从平地开始的，不会在村口就抬升起来。
export function rampFrom(h, dx, dz, path, width, edge, freeze) {
  let best = Infinity, bestI = 0, bestT = 0, bestU = 0, found = false;
  let acc = 0;
  const segs = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const L = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    segs.push(L); acc += L;
  }
  for (let i = 0; i + 1 < path.length; i++) {
    const ax = path[i][0], az = path[i][1];
    const vx = path[i + 1][0] - ax, vz = path[i + 1][1] - az;
    const L2 = vx * vx + vz * vz;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((dx - ax) * vx + (dz - az) * vz) / L2)) : 0;
    const d = Math.hypot(dx - (ax + vx * t), dz - (az + vz * t));
    if (!found || d < best) {
      best = d; found = true; bestI = i; bestT = t;
      bestU = acc * 0;   // 占位，下面重算
    }
  }
  if (!found) return h;
  // bestU：最近点沿折线的累计距离（米）
  let u = 0;
  for (let i = 0; i < bestI; i++) u += segs[i];
  u += segs[bestI] * bestT;
  // freeze 段内：目标高 = 折线第一点的高（= 起点地面高），权重随距离衰减 → 起点附近完全不动
  let target, w;
  if (u < freeze) {
    target = path[0][2];
    // freeze 区内也用同一套宽度：走廊中心线权重仍是 1，但目标高是"不抬升"的常数，
    // 所以它只会把地形往这个常数拉 —— 台地本来就是这个高，等于什么都不做。
    w = 1 - falloff(best, width, edge);
    return h + (target - h) * w;
  }
  // freeze 段之外：在"起点高"与"正常剖面"之间平滑过渡，避免在 freeze 边界出现台阶
  const normal = path[bestI][2] + (path[bestI + 1][2] - path[bestI][2]) * bestT;
  const ramp2 = path[0][2] + (normal - path[0][2]) * Math.min(1, (u - freeze) / Math.max(1e-6, freeze));
  target = ramp2;
  w = 1 - falloff(best, width, edge);
  return h + (target - h) * w;
}

// 坡道的**接缝软化**：路廊把中心线拉平了，可走廊边缘与原地形之间仍有一道坎。
//
// 什么时候需要它：台地（terrace）的过渡带 edge 太短时，台缘是一堵墙
//（实测北岭台缘从 30m 一跌到 22m，8m 落差挤在 4m 水平距离里 =坡度 2.0，
// 导航网格直接判成断路）。ramp 把路廊中心线拉对了，可它宽度有限 ——
// 走廊边缘仍在台缘那堵墙上，坡度超限。
//
// 做法：把路廊两侧一段距离内的高度**额外往目标剖面拉一点**（权重比走廊本身更平），
// 于是台壁被"推开"成缓坡。这不是重复ramp —— ramp 的权重在 width 处就归零了，
// 这里补的正是 width 之外那一段。
export function rampShoulder(h, dx, dz, path, width, edge, shoulder) {
  let best = Infinity, found = false, target = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const ax = path[i][0], az = path[i][1];
    const vx = path[i + 1][0] - ax, vz = path[i + 1][1] - az;
    const L2 = vx * vx + vz * vz;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((dx - ax) * vx + (dz - az) * vz) / L2)) : 0;
    const d = Math.hypot(dx - (ax + vx * t), dz - (az + vz * t));
    if (!found || d < best) {
      best = d; found = true;
      target = path[i][2] + (path[i + 1][2] - path[i][2]) * t;
    }
  }
  if (!found || best <= width) return h;
  // width..edge 这一圈：权重从 (edge-width) 处的 1 衰减到 edge 处的 0，
  // 与 ramp 的权重曲线首尾相接（width 处 ramp 已归零，这里刚好满权重），
  // 两层叠起来就是一条**连续**的剖面，中间没有台阶。
  const w = 1 - falloff(best, width, edge + shoulder) / 1;
  if (w <= 0) return h;
  return h + (target - h) * w;
}

// 复合噪声丘陵场：shape() 的通用底子。oct 层倍频叠加 + 脊化（ridged），
// 让连绵起伏有"山脊"而不是一堆圆包 —— 纯 fbm 看着像棉花堆。
//
// scale = **主波长（米）**，图幅（size）也传进来：两者一起决定喂给噪声的频率。
// 这一步不能省 —— TileNoise 吃的是归一化 [0,1) 坐标，频率 = size/scale。
// 只按图幅调频率而不管波长，换一张更大的图主起伏就被拉长成"一马平川"
// （这是地形图最常见、也最难一眼看出的失真：读数全对，就是不平）。
// 返回 0..1。ridged 越大越出脊、越少越圆润。
export function hillNoise(noise, x, z, size, scale, oct = 5, gain = 0.5, ridged = 0.5) {
  const u = x / size + 0.5, v = z / size + 0.5;   // 世界坐标 → 噪声域（绕开 0,0 的低频谷）
  let sum = 0, norm = 0, amp = 1, f = 1;
  for (let o = 0; o < oct; o++) {
    // freq **必须取整** —— 这是个真陷阱：TileNoise.get 拿 freq 当格数用，
    // 内部 `((ix % p) + p) % p` 求的是整数取模；p 一旦是小数，取模结果带小数，
    // 拿它去索引 Float32Array 得到 undefined，整条 shape() 就变 NaN。
    // 更糟的是它**只在部分坐标上炸**：索引恰好落在 0 的那些点照样返回值，
    // 于是"某些格子是 NaN、某些正常"，读数全对、地形却是碎的。
    // 这里 Math.round 之后还有 Math.max(1,...) —— freq=0 会让所有点塌成同一个值。
    const raw = size / (scale / f);
    const freq = Math.max(1, Math.min(noise.p, Math.round(raw)));
    let val = noise.fbm(u, v, freq, 1, 0.5);
    if (ridged > 0) {
      const r = 1 - Math.abs(val * 2 - 1);
      val = val * (1 - ridged) + r * r * ridged;
    }
    sum += val * amp; norm += amp; amp *= gain; f *= 2;
  }
  return sum / norm;   // 0..1
}

export { TileNoise };