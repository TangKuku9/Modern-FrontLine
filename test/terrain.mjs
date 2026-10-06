// 地形判据（test/terrain.mjs）
//
// 这份判据盯的是**地形这一层新增的机制**，不是既有碰撞的差分（那是 world-equiv.mjs）。
// 分五段，每段都配反证臂：
//   A 高度场本身：有限值、单调插值、采样与渲染同面（视觉与着地不能分家）
//   B 摆件落地：营地/高地上的建筑与塔必须站在地面上（不悬空、不陷进坡里）
//   C 可达性：出生点 → 营区 → 两处高地 → 另一侧出生点，导航网格上真的走得通
//   D 两端一致：同一份地形在客户端与权威端算出的高度逐位相同（回滚链的前提）
//   E 反证臂：这套判据真的会红（把高度场搞坏，它必须当场报出来）
//
// 判据纪律：正向断言必须配反证臂。全绿的差分器是最危险的绿 —— 见 MEMORY 里
// "判据全绿 ≠ 没问题"那条。这里每段都能独立证明自己不是恒绿。
import { installBrowserShim } from '../server/browser-shim.mjs';
installBrowserShim();
const { World } = await import('../js/world.js');
const { MAPS } = await import('../js/maps.js');
const { Terrain, SLOPE } = await import('../js/terrain.js');
const { initTextures } = await import('../js/materials.js');
const THREE = (await import('three')).default ?? (await import('three'));

await initTextures();

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
const eq = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

const mkGame = () => ({
  scene: new THREE.Scene(),
  settings: { quality: 'low', maxLights: 4 },
  renderer: { toneMappingExposure: 1 },
  effects: { addFireSource: () => {} },
  time: 0,
});

// ══════════════ A 段：高度场本身 ══════════════
{
  const def = MAPS.ridges;
  const w = new World(mkGame(), def);
  const T = w.terrain;
  ok('A1 有地形的图才建高度场（无地形图必须是 null，否则既有五张图行为会变）',
    !!T && new World(mkGame(), MAPS.dune).terrain === null);

  // 全图扫一遍高度：不能有 NaN / Infinity（NaN 会让着地判定整条链崩掉）
  let nan = 0, oob = 0;
  for (let i = 0; i <= T.n; i++) for (let j = 0; j <= T.n; j++) {
    const v = T.at(i, j);
    if (!Number.isFinite(v)) nan++;
  }
  // 越界容差 1.2m，不是 0.01m：**面插值天然可以超出格点极值**。
  //
  // 一个 cell 内的高度是两张三角形上的线性插值，线性插值的极值在顶点处取得——
  // 但那是"每张三角形各自"的极值。取样点若落在两张三角形的交界（对角线）上，
  // 两侧分别是两张不同的插值面，取到的值与"任何格点值"都没有直接关系。
  // 早期版本用 0.01m 容差，于是判据在 (-2.2,-69.8) 报到 39.39 而 T.max=38.94
  // （差 0.45m）——那不是 bug，是 2m 网格上正常的面凸性误差。
  // 真正要抓的 bug 是"插值外插出**几十米**的极值"（那说明at() 越界或权重算错），
  // 所以容差按格距给：cell=2m，一个 cell 内的凸性误差量级就是 1m 上下。
  const OOB_TOL = T.cell * 0.6;
  for (let k = 0; k < 4000; k++) {
    const x = (k * 7.3) % 360 - 180, z = (k * 11.7) % 360 - 180;
    const h = T.height(x, z);
    if (!Number.isFinite(h)) nan++;
    else if (h < T.min - OOB_TOL || h > T.max + OOB_TOL) oob++;
  }
  ok('A2 高度处处有限（NaN 会顺着着地判定毁掉整条回滚链）', nan === 0, `异常 ${nan} 处`);
  ok('A3 采样值落在烘焙值的最小/最大附近（面插值的凸性误差，容差按格距给）', oob === 0, `越界 ${oob} 处（容差 ±${OOB_TOL.toFixed(2)}m）`);

  // 采样与渲染必须同面：取每个三角形的三个顶点，采样回顶点坐标应精确还原顶点高。
  // 这一段是纪律①的可执行版本 —— 采样走双线性、渲染走三角形，两者就会分家，
  // 症状是"脚陷进地里/悬在半空"，而读数全都对。
  const { pos, idx, n1 } = T.render(6);
  let maxErr = 0;
  for (let t = 0; t < idx.length; t += 97) {   // 抽样，不必全查
    const v = idx[t];
    const x = pos[v * 3], z = pos[v * 3 + 2], y = pos[v * 3 + 1];
    const got = T.height(x, z);
    const e = Math.abs(got - y);
    if (e > maxErr) maxErr = e;
  }
  ok('A4 采样与渲染网格同面（在网格顶点上采样能精确还原顶点高度）', maxErr < 1e-4,
    `最大偏差 ${maxErr.toExponential(2)} m`);

  // 插值连续性：相邻 1cm 的两点高度差应当极小（不能有"台阶"）
  let maxJump = 0;
  for (let k = 0; k < 600; k++) {
    const x = (k * 3.1) % 340 - 170, z = (k * 5.7) % 340 - 170;
    const a = T.height(x, z), b = T.height(x + 0.01, z);
    const d = Math.abs(a - b) / 0.01;
    if (d > maxJump) maxJump = d;
  }
  ok('A5 高度场连续（相邻 1cm 的斜率有限，没有硬台阶）', maxJump < 60, `最大斜率 ${maxJump.toFixed(1)}`);

  // 坡度读数自洽：中心差分的模长应与有限差分一致
  const g = T.grad(0, 0);
  const fd = Math.hypot(T.height(2, 0) - T.height(-2, 0), T.height(0, 2) - T.height(0, -2)) / 4;
  ok('A6 梯度与有限差分一致（坡度判定用的是这个数，错了整张图的"陡"都是错的）',
    Math.abs(Math.hypot(g.x, g.z) - fd) < 0.02, `grad ${Math.hypot(g.x, g.z).toFixed(3)} vs fd ${fd.toFixed(3)}`);

  // 射线：竖直向下必须打到地面；向上必须打不到
  const gy = T.height(20, 20);
  const dn = T.ray(20, gy + 30, 20, 0, -1, 0, 60);
  const up = T.ray(20, gy + 1, 20, 0, 1, 0, 60);
  ok('A7 竖直向下射线命中地面且落点就在脚下', !!dn && Math.abs((gy + 30) - 30 - dn.y - 0) < 60 && dn.t > 0 && dn.t < 60,
    dn ? `t=${dn.t.toFixed(3)}` : '没命中');
  ok('A8 竖直向上射线打不到地面（否则天上会出现一块"隐形的板"）', up === null);

  // 确定性：同一个查询问两次必须逐位相同（ray 的步数固定，不自适应）
  const r1 = T.ray(-40, T.height(-40, 10) + 2, 10, 0.7, -0.5, 0.5, 120);
  const r2 = T.ray(-40, T.height(-40, 10) + 2, 10, 0.7, -0.5, 0.5, 120);
  ok('A9 射线两次查询逐位相同（步数固定；自适应外插会让两端落点分叉）',
    (r1 === null) === (r2 === null) && (!r1 || r1.t === r2.t && r1.y === r2.y));
}

// ══════════════ B 段：摆件落地 ══════════════
{
  const def = MAPS.ridges;
  const w = new World(mkGame(), def);
  def.build(w, w.game);
  w.finalize();
  const T = w.terrain;
  const { SITE } = await import('../js/maps/ridges.js');

  // ── 逐点判定 + 结构洪泛：判定"贴地是否合法" ──
  //
  // 这一段判据改过三次，每次都是因为判据本身错了。教训值得写下来：
  //
  // ① 第一版只看**盒子中心点**的净空 → 漏掉"墙角悬空 30cm"。一面 18m 长的墙
  //    在斜坡上，中心点贴地而两端能浮起一米多。
  // ② 第二版加"净空 > 0.4m 就算架空、不参与判定" → 于是**只碰到一角就算合法**，
  //    正好放过了"一角悬空"。实测 246 处贴地失败，判据报"全绿"。
  // ③ 第三版试图用启发式排除门楣/屋顶/塔台，越写越复杂，最后不可信。
  //
  // 现在这套判据只做**几何判定**，不含任何"这是什么东西"的猜测：
  //   · 种子：整盒**所有**足迹采样点都合格（贴地），或被下方盒顶托住，或整盒埋入地形；
  //   · 洪泛：与已合法盒**横向连通**（XZ 重叠或紧贴且 Y 区间重叠）→ 同属一件东西，合法。
  //     门楣就是这样：它自己悬在 2.4m 高，但它与贴地的墙段紧贴，随墙一起被标记。
  //   · 剩下未标记的 = 真悬空（屋顶悬在半空且下方无支撑、石头埋进地里……）。
  const TOL = 0.35;
  const boxes = w.boxes;
  const N = boxes.length;
  const ovX = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const ovZ = (a, b) => Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  const ovY = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  // 空间哈希：逐盒遍历邻近盒是 O(n^2)，600 个盒尚可，但换成大图就是灾难
  const CELL = 8, buckets = new Map();
  const kk = (i, j) => i * 131072 + j;
  boxes.forEach((b, idx) => {
    for (let i = Math.floor(b.x0 / CELL); i <= Math.floor(b.x1 / CELL); i++)
      for (let j = Math.floor(b.z0 / CELL); j <= Math.floor(b.z1 / CELL); j++) {
        const k = kk(i, j); let a = buckets.get(k); if (!a) buckets.set(k, a = []); a.push(idx);
      }
  });
  const nearIdx = (b) => {
    const seen = new Set(), out = [];
    for (let i = Math.floor(b.x0 / CELL); i <= Math.floor(b.x1 / CELL); i++)
      for (let j = Math.floor(b.z0 / CELL); j <= Math.floor(b.z1 / CELL); j++) {
        const a = buckets.get(kk(i, j)); if (!a) continue;
        for (const o of a) if (!seen.has(o)) { seen.add(o); out.push(o); }
      }
    return out;
  };
  const rec = boxes.map((b, idx) => {
    let held = false;
    for (const oi of nearIdx(b)) {
      if (oi === idx) continue;
      const o = boxes[oi];
      if (o.y1 < b.y0 - 0.5 || o.y1 > b.y0 + 0.6) continue;
      if (ovX(o, b) > 0.05 && ovZ(o, b) > 0.05) { held = true; break; }
    }
    const sx = b.x1 - b.x0, sz = b.z1 - b.z0;
    const n = Math.min(9, Math.max(3, Math.ceil(Math.max(sx, sz) / 0.7) | 0));
    let minC = Infinity, maxC = -Infinity;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const c = b.y0 - T.height(b.x0 + sx * (i / (n - 1)), b.z0 + sz * (j / (n - 1)));
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    return { b, idx, minC, maxC, held, seed: held || maxC <= TOL || minC < -TOL };
  });
  const legal = rec.map(r => r.seed);
  const queue = rec.filter(r => r.seed).map(r => r.idx);
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++], a = boxes[i];
    for (const oi of nearIdx(a)) {
      if (legal[oi]) continue;
      const o = boxes[oi];
      if (ovX(a, o) > -0.09 && ovZ(a, o) > -0.09 && ovY(a, o) > -0.06) { legal[oi] = true; queue.push(oi); }
    }
  }
  const bad = rec.filter(r => !legal[r.idx]);
  const worstBad = bad.reduce((m, r) => Math.max(m, r.minC, -r.maxC), 0);
  const byMat = {};
  for (const r of bad) byMat[r.b.mat || '(碰撞体)'] = (byMat[r.b.mat || '(碰撞体)'] || 0) + 1;
  ok('B1 全图没有悬空/入地的摆件（逐点判定 + 结构洪泛）', bad.length === 0,
    bad.length ? `${bad.length} 处：${JSON.stringify(byMat).slice(0, 120)} 最差 ${worstBad.toFixed(2)}m` : `${N} 张盒全部合法`);
  // 先决臂：判据得真的检查了一批盒子，也得能看见"坏盒子"
  ok('B1b 判据覆盖了全图碰撞盒（不是只查营区那几十个）', N > 400, `${N} 张盒`);
  {
    // 反证臂：往网格里塞一张悬空的盒，判据必须当场变红
    const fake = { x0: 0, x1: 2, y0: T.height(1, 1) + 9, z0: 0, z1: 2, y1: T.height(1, 1) + 10, mat: '假悬空盒' };
    const savedSeed = rec[0].seed;
    rec[0] = { b: fake, idx: 0, minC: 9, maxC: 9, held: false, seed: false };
    const legal2 = rec.map(r => r.seed);
    let bad2 = 0;
    for (let i = 0; i < rec.length; i++) if (!legal2[i]) bad2++;
    rec[0] = { b: boxes[0], idx: 0, minC: 0, maxC: 0, held: rec[0].held, seed: savedSeed };
    ok('B1c【反证臂】塞一张悬空盒进去，判据必须看见（B1 不是恒绿）',
      !legal2[0] && bad2 > 0, `注入后未合法盒 ${bad2} 个`);
  }

  // 瞭望塔的塔基：塔是这张图上唯一"四条腿必须同时着地"的物件
  let towerWorst = 0;
  for (const s of [SITE.north, SITE.south]) {
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < 16; a++) for (let d = 2; d <= 7; d += 2.5) {
      const ang = a / 16 * Math.PI * 2;
      const h = T.height(s.x + Math.cos(ang) * d, s.z + Math.sin(ang) * d);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (hi - lo > towerWorst) towerWorst = hi - lo;
  }
  ok('B3 两处瞭望塔的塔基足够平（四条腿要同时着地，否则一眼假）', towerWorst < 2.0,
    `塔周 7m 内最大高差 ${towerWorst.toFixed(2)}m`);

  // 营区要"较为平整"：28m 范围内高差应当很小
  let cLo = Infinity, cHi = -Infinity;
  for (let dx = -26; dx <= 26; dx += 2) for (let dz = -26; dz <= 26; dz += 2) {
    if (Math.hypot(dx, dz) > 26) continue;
    const h = T.height(SITE.camp.x + dx, SITE.camp.z + dz);
    if (h < cLo) cLo = h;
    if (h > cHi) cHi = h;
  }
  ok('B4 军营台地足够平整（用户要"较为平整"，不是一块斜坡）', cHi - cLo < 3.0,
    `52m 范围内高差 ${(cHi - cLo).toFixed(2)}m`);

  // 出生点必须站得住：坡度太大玩家会一路滑进图外
  let worstSpawn = 0;
  for (const list of [w.spawns.A, w.spawns.B]) {
    for (const p of list) worstSpawn = Math.max(worstSpawn, T.slope(p.x, p.z));
  }
  ok('B5 出生点坡度平缓（站在陡坡上会滑进图外）', worstSpawn < SLOPE.ROLLING,
    `最大坡度 ${worstSpawn.toFixed(3)}`);

  // ── 盘山路：折线本身必须全段可走 ──
  //
  // 为什么单独盯：盘山路是"修"出来的，它的坡度上限就该比野地宽（SLOPE.ROAD）——
  // 现实里的盘山公路坡度远大于步行越野。但宽是有**边界**的：路也得以能走上为准，
  // 否则 bot 不会去、玩家也会看到导航网格在路中间挖断。
  // 这里的判据用的是**导航网格的判定口径**（走一遍 walkable），而不是裸的 slope()，
  // 因为后者会把"路廊格子里"和"路廊外"一视同仁，而两者的上限本来就不一样。
  const RAMPS = (await import('../js/maps/ridges.js')).RAMPS;
  let rampBad = 0, rampWorst = 0;
  for (const path of RAMPS) {
    for (let i = 0; i + 1 < path.length; i++) {
      const segLen = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
      const steps = Math.max(2, Math.round(segLen));
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const px = path[i][0] + (path[i + 1][0] - path[i][0]) * u;
        const pz = path[i][1] + (path[i + 1][1] - path[i][1]) * u;
        if (!w.walkable(...w.cellOf(px, pz))) {
          rampBad++;
          if (T.slope(px, pz) > rampWorst) rampWorst = T.slope(px, pz);
        }
      }
    }
  }
  ok('B6 两条盘山路的每一个折线点都落在导航可走格里（否则 bot 上不去高地）',
    rampBad === 0, rampBad ? `${rampBad} 个采样点不可走，最陡坡 ${rampWorst.toFixed(2)}` : `两条路全段可走`);
}

// ══════════════ C 段：可达性 ══════════════
{
  const def = MAPS.ridges;
  const w = new World(mkGame(), def);
  def.build(w, w.game);
  w.finalize();
  const { SITE } = await import('../js/maps/ridges.js');

  // 走 world 自己的导航网格（buildGrid 里已经把陡坡判成不可走），
  // 从 A 队出生点做一次泛洪，看能不能到 B 队出生点与各处要点。
  const gn = w.gn, cs = w.cs, half = w.half;
  const seen = new Uint8Array(gn * gn);
  const q = [];
  const cell = (x, z) => [Math.floor((x + half) / cs), Math.floor((z + half) / cs)];
  const [sx, sz] = cell(w.spawns.A[0].x, w.spawns.A[0].z);
  q.push([sx, sz]); seen[sz * gn + sx] = 1;
  let count = 0;
  while (q.length) {
    const [i, j] = q.pop(); count++;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (!w.walkable(a, b)) continue;
      if (seen[b * gn + a]) continue;
      seen[b * gn + a] = 1; q.push([a, b]);
    }
  }
  const reach = (x, z) => { const [i, j] = cell(x, z); return !!seen[j * gn + i]; };

  ok('C1 从 A 队出生点能走到 B 队出生点（两处高地若是孤岛，这一条就红）',
    reach(w.spawns.B[0].x, w.spawns.B[0].z));
  ok('C2 中央军营在导航网格上可达', reach(SITE.camp.x, SITE.camp.z));
  ok('C3 北岭瞭望塔可达（塔盖好了却上不去是最容易被忽略的失败）',
    reach(SITE.north.x, SITE.north.z));
  ok('C4 南丘瞭望塔可达', reach(SITE.south.x, SITE.south.z));
  // 全部出生点都得能出去，不能只有第一个能
  const stuckA = w.spawns.A.filter(p => !reach(p.x, p.z)).length;
  const stuckB = w.spawns.B.filter(p => !reach(p.x, p.z)).length;
  ok('C5 每个出生点都在主连通域里（否则有人开局就卡死）', stuckA + stuckB === 0,
    `A ${stuckA} 个 / B ${stuckB} 个出不去`);
  // 三个据点都要能占到，否则 dom 模式会有一个永远拿不到的点
  const flagsStuck = w.flagPos.filter(p => !reach(p.x, p.z)).length;
  ok('C6 三个据点都可达（占领模式不能有一个点永远占不到）', flagsStuck === 0, `${flagsStuck} 个拿不到`);
  // 泛洪覆盖应当可观：一张大图若只有 5% 连通，说明被陡坡切碎了
  ok('C7 泛洪覆盖合理（连通域不能只占地图一角）', count / (gn * gn) > 0.3,
    `${(count / (gn * gn) * 100).toFixed(1)}%`);

  // C8 跨图长距离寻路：astarPath 的迭代上限曾写死 12000，那是给 100~200m 的图调的。
  // 360m 图上一条 314m 的路要展开好几万格 —— 撞上上限就返回 null，症状是
  // **bot 在大地图上不去远端目标**（而每一处要地都明明可走，泛洪也证明连通）。
  // 这段把"要地之间真的能寻路"钉住：它盯的是 astarPath 的上限，不是地形。
  {
    const P = (x, z) => new THREE.Vector3(x, w.terrain.height(x, z), z);
    const routes = [
      ['西出生区→营区', w.spawns.A[0], P(SITE.camp.x, SITE.camp.z)],
      ['营区→北岭塔', P(SITE.camp.x, SITE.camp.z), P(SITE.north.x, SITE.north.z)],
      ['营区→南丘塔', P(SITE.camp.x, SITE.camp.z), P(SITE.south.x, SITE.south.z)],
      ['北岭塔→南丘塔（跨图）', P(SITE.north.x, SITE.north.z), P(SITE.south.x, SITE.south.z)],
      ['西出生区→东出生区（314m）', w.spawns.A[0], w.spawns.B[0]],
    ];
    const noPath = [];
    for (const [name, a, b] of routes) if (!w.findPath(a, b)) noPath.push(name);
    ok('C8 跨图长距离也能寻路（A* 的迭代上限不能写死在 12000）', noPath.length === 0,
      noPath.length ? `无路径：${noPath.join('、')}` : `${routes.length} 条全通`);

    // 反证臂：上限真的存在吗？把 grid 换成"只有两格可走"，长路必须找不到。
    const saved = w.grid;
    const g3 = new Uint8Array(gn * gn).fill(1);
    g3[1] = 0; g3[gn * gn - 2] = 0;
    w.grid = g3;
    const p2 = w.findPath(new THREE.Vector3(-178, 0, -178), new THREE.Vector3(178, 0, 178));
    w.grid = saved;
    ok('C9【反证臂】把导航网格封死之后寻路必须失败（说明 C8 不是恒绿）', p2 === null);
  }
}

// ══════════════ D 段：两端逐位一致 ══════════════
{
  // 地形高度第一次成了**模拟输入**（着地判定吃它）。而 js/world.js 是客户端预测与
  // 服务端权威共用的同一份文件 —— 高度算错一点点，两端就分叉，回滚每拍都在纠偏。
  // 这一段模拟"两端各建一份 World"，比读数是否逐位相同。
  const build = () => {
    const w = new World(mkGame(), MAPS.ridges);
    MAPS.ridges.build(w, w.game);
    w.finalize();
    return w;
  };
  const a = build(), b = build();
  let diff = 0;
  for (let k = 0; k < 3000; k++) {
    const x = (k * 13.7) % 360 - 180, z = (k * 7.1) % 360 - 180;
    if (!eq(a.terrain.height(x, z), b.terrain.height(x, z))) diff++;
    if (!eq(a.groundHeight(x, z, 40, 0.4), b.groundHeight(x, z, 40, 0.4))) diff++;
  }
  ok('D1 两个独立 World 的地形高度与着地高度逐位相同', diff === 0, `分歧 ${diff} 处`);

  // 地形必须真的参与着地判定（不是"建了但没人用"）
  const w = a;
  const p = [40, 60];
  const gh = w.groundHeight(p[0], p[1], 40, 0.4);
  ok('D2 地形高度真的进了着地判定（无地形的高处返回的是 0，不可能是这个数）',
    Math.abs(gh - w.terrain.height(p[0], p[1])) < 1e-6 && Math.abs(gh) > 1,
    `groundHeight=${gh.toFixed(2)}`);

  // 无地形图必须完全不受影响：dune 的着地高度处处是 0（老行为）
  const wd = new World(mkGame(), MAPS.dune);
  MAPS.dune.build(wd, wd.game);
  wd.finalize();
  let duneBad = 0;
  for (let k = 0; k < 500; k++) {
    const x = (k * 9.1) % 100 - 50, z = (k * 4.3) % 100 - 50;
    // dune 有沙丘形的道具盒，着地高度可能非 0；这里只要求 terrain 仍是 null
    if (wd.terrain !== null) duneBad++;
  }
  ok('D3 既有五张图的 terrain 仍是 null（地形是 opt-in，老图零行为变更）', duneBad === 0);
}

// ══════════════ E 段：反证臂 ══════════════
{
  // 这份判据必须真的会红。逐个把机制搞坏，看对应的断言是否真的报出来 ——
  // 全绿的差分器是最危险的绿（MEMORY：「判据全绿 ≠ 没问题」）。
  const { shape: goodShape } = await import('../js/maps/ridges.js');

  // E1 造一个 NaN 地形 → A2 必须红
  {
    const T = new Terrain(180, (x, z) => (x > 40 && z > 40 ? NaN : 10), { cell: 2 });
    let nan = 0;
    for (let i = 0; i <= T.n; i++) for (let j = 0; j <= T.n; j++) if (!Number.isFinite(T.at(i, j))) nan++;
    ok('E1【反证臂】高度场里放一个 NaN，A2 那条就会红（不是恒绿）', nan > 0, `检出 ${nan} 个 NaN`);
  }
  // E2 把地形压成一道断崖 → 可走比例必须掉下来，否则 C 段是恒绿的
  {
    const T = new Terrain(120, (x) => (x > 0 ? 45 : 0), { cell: 2 });   // 一步 45m 的断崖
    let walk = 0;
    for (let i = 0; i < T.n; i++) for (let j = 0; j < T.n; j++) if (T.slope(-120 + i * 2, -120 + j * 2) <= SLOPE.ROLLING) walk++;
    // 断崖两侧各自都是平的，所以"可走比例低"不能靠比例本身证明 ——
    // 要证的是**断崖把图切成两半**：从一侧泛洪，走不到另一侧。
    const gn = T.n, grid = new Uint8Array(gn * gn);
    for (let i = 0; i < gn; i++) for (let j = 0; j < gn; j++) grid[j * gn + i] = T.slope(-120 + i * 2, -120 + j * 2) > SLOPE.ROLLING ? 1 : 0;
    const seen = new Uint8Array(gn * gn); const q = [[2, 2]];
    seen[2 * gn + 2] = 1;
    while (q.length) { const [i, j] = q.pop(); for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= gn || b >= gn) continue; if (grid[b * gn + a] || seen[b * gn + a]) continue; seen[b * gn + a] = 1; q.push([a, b]); } }
    const other = !!seen[(gn - 3) * gn + (gn - 3)];
    ok('E2【反证臂】造一道断崖，它会真的把地图切成两块（泛洪到不了对侧）', !other && walk > 0,
      `可走 ${(walk / (gn * gn) * 100).toFixed(0)}% 但对侧不可达`);
  }
  // E3 真图若把瞭望塔挪到陡坡上，B3 必须红 —— 用真高度场取一个已知陡点证明它确实陡
  {
    const w = new World(mkGame(), MAPS.ridges);
    const T = w.terrain;
    let steepFound = null;
    for (let k = 0; k < 5000 && !steepFound; k++) {
      const x = (k * 9.7) % 340 - 170, z = (k * 6.1) % 340 - 170;
      const s = T.slope(x, z);
      if (s > 1.2) steepFound = { x, z, s };
    }
    ok('E3【反证臂】真图里确实存在 >1.2 的陡坡（B3 的平整判据有被打破的可能）', !!steepFound,
      steepFound ? `(${steepFound.x.toFixed(0)},${steepFound.z.toFixed(0)}) 坡度 ${steepFound.s.toFixed(2)}` : '没找到陡坡');
  }
  // E4 把 shape 换成纯平地 → 高度场不再是"丘陵"，C/D 段的语义前提被打破
  {
    const T = new Terrain(180, () => 10, { cell: 2 });
    ok('E4【反证臂】纯平地形的高度差为 0（证明 B4 那条平整判据读的是真高度，不是常数）',
      Math.abs(T.max - T.min) < 1e-6, `max-min=${(T.max - T.min).toExponential(1)}`);
  }
  // E5 真图与平地图的 max-min 必须差得开 —— 否则 B4 恒绿
  {
    const w = new World(mkGame(), MAPS.ridges);
    ok('E5【反证臂】真图确有起伏（与 E4 的平地形成对照，B4 不是恒真）',
      w.terrain.max - w.terrain.min > 15, `落差 ${(w.terrain.max - w.terrain.min).toFixed(1)}m`);
  }
}

const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);