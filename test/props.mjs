// 摆件判据（test/props.mjs）
//
// 盯的是**看不见但摸得着**的那一类问题。地形判据（test/terrain.mjs）盯高度场本身，
// 这里盯它之上的东西：摆件有没有落在地上、碰撞体和模型是不是对得上。
//
//   B1 摆件贴地（逐点判定 + 结构洪泛，带反证臂）
//   B7 没有裸露碰撞盒 —— 玩家撞到的东西必须建了可见几何
//   B8 卡车碰撞盒容得下视觉（早一版 7×2.1 对 2.1×6.0，两侧各 2.5m 空气）
//   B9 岩石/树不压在建筑与围墙上（"围墙夹着块石头"）
//   B10 圆盘地坪不用外接方盒（四角悬空 5.5m）
//
//判据纪律：这里特别在意"**事后从场景图反查**"这条路的失效。
// finalize() 会把上千个 box 合并成几个巨型 mesh，所以包围盒对不上 ——
// 反查法曾把 550 张盒全报成"虚空"（全是误报）。正解是在**生成现场**记录映射。
import { installBrowserShim } from '../server/browser-shim.mjs';
installBrowserShim();
const { World } = await import('../js/world.js');
const { MAPS } = await import('../js/maps.js');
const { SLOPE } = await import('../js/terrain.js');
const { initTextures, mat } = await import('../js/materials.js');
await initTextures();

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
const THREE = (await import('three')).default ?? (await import('three'));
const mkGame = () => ({
  scene: new THREE.Scene(),
  settings: { quality: 'low', maxLights: 4 },
  renderer: { toneMappingExposure: 1 },
  effects: { addFireSource: () => {} },
  time: 0,
});

// ══════════════ B 段：摆件贴地与错位 ══════════════
// 这一段盯两件事，都是"玩家能感觉到但读数上看不出来"的：
//   B1摆件贴地（逐点判定 + 结构洪泛）
//   B2  碰撞体必须与可见几何一致 —— 玩家撞到的每面墙，眼睛都要看得见

{
  const def = MAPS.ridges;
  const w = new World(mkGame(), def);
  def.build(w, w.game);
  w.finalize();
  const T = w.terrain;
  const { SITE, CORRIDOR } = await import('../js/maps/ridges.js');
  const THREE = await import('three');

  // ── B1 逐点判定 + 结构洪泛（说明见 A 段之后那段注释） ──
  const TOL = 0.35;
  const boxes = w.boxes;
  const N = boxes.length;
  const ovX = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const ovZ = (a, b) => Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  const ovY = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
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
  ok('B1b 判据覆盖了全图碰撞盒（不是只查营区那几十个）', N > 400, `${N} 张盒`);
  {
    const fake = { x0: 0, x1: 2, y0: T.height(1, 1) + 9, z0: 0, z1: 2, y1: T.height(1, 1) + 10, mat: '假悬空盒' };
    const saved = rec[0];
    rec[0] = { b: fake, idx: 0, minC: 9, maxC: 9, held: false, seed: false };
    const legal2 = rec.map(r => r.seed);
    let bad2 = 0;
    for (let i = 0; i < rec.length; i++) if (!legal2[i]) bad2++;
    rec[0] = saved;
    ok('B1c【反证臂】塞一张悬空盒进去，判据必须看见（B1 不是恒绿）',
      !legal2[0] && bad2 > 0, `注入后未合法盒 ${bad2} 个`);
  }

  // ── B7 碰撞体不得比可见几何大出一圈 ──
  //
  // 这是"虚空碰撞箱"的核心：玩家在卡车旁 1m 被挡住，撞的是**空气**。
  // 判据问的是"这个碰撞盒是不是**某件可见物**的忠实近似"——
  // 不合格的典型是圆盘配方盒（直升机坪）、长条配短盒（卡车）。
  //
  // 做法：**在生成现场记录**每个 box/collider 对应的可见几何尺寸。
  // 不能事后从场景图反查 —— finalize() 把上千个 box 合并成几个巨型 mesh，
  // 包围盒对不上（这个坑踩过：反查法把 550 张盒全报成"虚空"）。
  //
  // 重建一次 build，带上记录钩子。
  const marks = [];
  const w2 = new World(mkGame(), def);
  const origBox = w2.box.bind(w2);
  w2.box = (cx, y0, cz, bw, bh, bd, mn, opt = {}) => {
    const b = origBox(cx, y0, cz, bw, bh, bd, mn, opt);
    if (b) marks.push({ kind: 'box', b, visible: opt.visible !== false });
    return b;
  };
  const origCol = w2.collider.bind(w2);
  w2.collider = (x0, y0, z0, x1, y1, z1) => {
    const b = origCol(x0, y0, z0, x1, y1, z1);
    marks.push({ kind: 'collider', b, visible: false });
    return b;
  };
  // 各类物件：内部产生可见几何，所以它内部的 box 不算"虚空"
  const OWNER = {};
  for (const k of ['sandbags', 'rock', 'tree', 'crate', 'crateStack', 'container', 'barrel',
    'watchtower', 'tent', 'car', 'truck', 'truckCollider', 'building', 'wall', 'wallBy',
    'jersey', 'barrier', 'tank', 'pipe', 'lampPost', 'stairs', 'pad', 'a wing', 'awning']) {
    if (typeof w2[k] !== 'function') continue;
    const orig = w2[k].bind(w2);
    w2[k] = (...a) => {
      const start = marks.length;
      const r = orig(...a);
      for (let i = start; i < marks.length; i++) if (!marks[i].owner) marks[i].owner = k;
      return r;
    };
  }
  // mesh() 也产生可见几何（独立 Mesh，不进 geoLists）
  const origMesh = w2.mesh.bind(w2);
  w2.mesh = (...a) => {
    const start = marks.length;
    const r = origMesh(...a);
    for (let i = start; i < marks.length; i++) if (!marks[i].owner) marks[i].owner = 'mesh';
    return r;
  };
  def.build(w2, w2.game);
  w2.finalize();

  // 虚空碰撞：owner 为空 + collider() 裸调用（box 至少有 box 形状可对）
  const ghosts = marks.filter(m => m.kind === 'collider' && !m.owner);
  const byOwner = {};
  for (const g of ghosts) byOwner[g.owner || '(裸调用)'] = (byOwner[g.owner || '(裸调用)'] || 0) + 1;
  ok('B7 没有裸露的碰撞盒（玩家撞到的东西必须建了可见几何）',
    ghosts.length === 0,
    ghosts.length ? `${ghosts.length} 个：${JSON.stringify(byOwner)}` : `${marks.length} 次调用全部有可见几何`);

  // ── B8 卡车这类"视觉是一组 mesh、碰撞是单独一个盒"的物件：盒子必须包住视觉 ──
  //
  // 口径：**按调用现场配对，不写死坐标**。
  // 早一版这里硬编码了"车场 4 辆在 cx-15+i*10, cz+26"，于是布局一改
  // 判据就悄悄核对0 辆、报"核对 0 辆"（看起来像通过，其实是空集合）。
  // 同一个坑 B1b 已经踩过一次（"判据覆盖了 N 张盒"必须钉住 N > 阈值）。
  //
  // 现在：每次 truck() 记视觉包围盒 → 下一次 truckCollider() 记碰撞盒 → 按顺序配对。
  // 卡车建模尺寸：2.1 宽 × 6.04 长（rotY=π/2 时长轴在 x）。
  const tw = new World(mkGame(), def);
  const pairs = [];
  let pendingVisual = null;
  const origTruck = tw.truck.bind(tw);
  tw.truck = (x, z, rotY, color) => {
    const g = origTruck(x, z, rotY, color);
    pendingVisual = { x, z, rotY, bb: new THREE.Box3().setFromObject(g) };
    return g;
  };
  const origTC = tw.truckCollider.bind(tw);
  tw.truckCollider = (x, z, rotY) => {
    const n0 = tw.boxes.length;
    origTC(x, z, rotY);
    const cols = tw.boxes.slice(n0);
    if (pendingVisual) pairs.push({ v: pendingVisual, cols, x, z, rotY });
    pendingVisual = null;
  };
  def.build(tw, tw.game);
  let mismatch = 0;
  const badTruck = [];
  for (const p of pairs) {
    const vs = p.v.bb.getSize(new THREE.Vector3());     // 视觉：世界轴对齐的包围盒
    const vLong = Math.max(vs.x, vs.z), vShort = Math.min(vs.x, vs.z);
    if (p.cols.length !== 1) {
      mismatch++;
      badTruck.push(`(${p.x.toFixed(0)},${p.z.toFixed(0)}) 碰撞盒 ${p.cols.length} 个（应为 1）`);
      continue;
    }
    const c = p.cols[0];
    const cw = c.x1 - c.x0, cd = c.z1 - c.z0;
    const cLong = Math.max(cw, cd), cShort = Math.min(cw, cd);
    // 碰撞盒必须**容得下**视觉：长边 ≥ 视觉长边，短边 ≥ 视觉短边
    if (cLong < vLong - 0.01 || cShort < vShort - 0.01) {
      mismatch++;
      badTruck.push(`(${p.x.toFixed(0)},${p.z.toFixed(0)}) 碰撞 ${cw.toFixed(2)}×${cd.toFixed(2)}` +
        ` 容不下视觉 ${vs.x.toFixed(2)}×${vs.z.toFixed(2)}`);
    }
  }
  ok('B8 卡车碰撞盒容得下视觉（早一版给了 7×2.1，两侧各 2.5m 空气）',
    mismatch === 0 && pairs.length > 0,
    badTruck.length ? badTruck.slice(0, 3).join('； ')
      : `${pairs.length} 辆全部对齐（每辆 2.2×6.1，视觉 2.1×6.04）`);
  // B8b 先决臂：判据必须真的核对了车辆，否则"0 不一致"是空集合的假绿
  ok('B8b【先决臂】B8 确实核对了卡车（不是空集合假绿）', pairs.length >= 4,
    `核对 ${pairs.length} 辆`);

  // B9/B10 要读的"完整 build 结果"（B8 用的是带钩子的 tw，不需要它）
  const w3 = new World(mkGame(), def);
  def.build(w3, w3.game);

  // ── B9 装饰不许压在建筑/围墙上 ──
  // 这是"围墙夹着一块石头"的根因：岩石/植被在建筑之后才生成，两类互不知情。
  const manMade = w3.boxes.filter(b => b.mat && b.mat !== 'sandbag');
  let onBuilding = 0;
  const samples = [];
  for (const b of w3.boxes) {
    // 找"岩石/树"类（无 mat，且水平尺寸接近正方、体积不大）
    if (b.mat) continue;
    const sx = b.x1 - b.x0, sz = b.z1 - b.z0;
    if (sx < 0.6 || sx > 5 || Math.abs(sx - sz) > 0.4) continue;
    for (const m of manMade) {
      const ox = Math.min(b.x1, m.x1) - Math.max(b.x0, m.x0);
      const oz = Math.min(b.z1, m.z1) - Math.max(b.z0, m.z0);
      const oy = Math.min(b.y1, m.y1) - Math.max(b.y0, m.y0);
      // 只算"埋进建筑里"的程度：水平重叠 >40% 且有实质竖向重叠
      if (ox > sx * 0.4 && oz > sz * 0.4 && oy > Math.min(0.8, (b.y1 - b.y0) * 0.5)) {
        onBuilding++;
        if (samples.length < 4) samples.push(
          `(${(b.x0 + b.x1) / 2 | 0},${b.y0.toFixed(1)},${(b.z0 + b.z1) / 2 | 0}) 压在 ${m.mat} 上 ${(ox).toFixed(1)}×${(oz).toFixed(1)}m`);
        break;
      }
    }
  }
  ok('B9 岩石/树不压在建筑与围墙上（否则远看就是"墙夹着块石头"）',
    onBuilding === 0, onBuilding ? `${onBuilding} 处：${samples.join('; ')}` : '装饰与建筑无重叠');

  // ── B10 圆形地坪的碰撞不得是外接方盒 ──
  // 直升机坪：视觉是 R=9 的圆盘，早一版给 18×18 的方盒 —— 四角各伸到圆外 5.5m，
  // 玩家在草坪上被看不见的空气墙挡住。
  const padBoxes = w3.boxes.filter(b => {
    const sx = b.x1 - b.x0, sz = b.z1 - b.z0;
    return Math.abs(sx - 18) < 1.5 && Math.abs(sz - 18) < 1.5 && b.y1 - b.y0 < 0.5;
  });
  ok('B10 直升机坪不再是 18×18 的方盒（四角会悬空 5.5m）', padBoxes.length === 0,
    padBoxes.length ? `还有 ${padBoxes.length} 块大方盒` : '圆盘用八边形近似');

  // ── 其余原有的 B3~B6 ──
  let towerWorst = 0;
  for (const site of [SITE.north, SITE.south]) {
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < 16; a++) for (let d = 2; d <= 7; d += 2.5) {
      const ang = a / 16 * Math.PI * 2;
      const h = T.height(site.x + Math.cos(ang) * d, site.z + Math.sin(ang) * d);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (hi - lo > towerWorst) towerWorst = hi - lo;
  }
  ok('B3 两处瞭望塔的塔基足够平（四条腿要同时着地，否则一眼假）', towerWorst < 2.0,
    `塔周 7m 内最大高差 ${towerWorst.toFixed(2)}m`);

  let cLo = Infinity, cHi = -Infinity;
  for (let dx = -26; dx <= 26; dx += 2) for (let dz = -26; dz <= 26; dz += 2) {
    if (Math.hypot(dx, dz) > 26) continue;
    const h = T.height(SITE.camp.x + dx, SITE.camp.z + dz);
    if (h < cLo) cLo = h;
    if (h > cHi) cHi = h;
  }
  ok('B4 军营台地足够平整（用户要"较为平整"，不是一块斜坡）', cHi - cLo < 3.0,
    `52m 范围内高差 ${(cHi - cLo).toFixed(2)}m`);

  let worstSpawn = 0;
  for (const list of [w.spawns.A, w.spawns.B]) {
    for (const p of list) worstSpawn = Math.max(worstSpawn, T.slope(p.x, p.z));
  }
  ok('B5 出生点坡度平缓（站在陡坡上会滑进图外）', worstSpawn < SLOPE.ROLLING,
    `最大坡度 ${worstSpawn.toFixed(3)}`);

  // ── B11 光照的三个量要一起看，不能只看sun ──
  //
  // 用户反馈"太阳太刺眼"。踩过的坑：只把 sun 从 4.2 降到 3.0，顺光坡好转了，
  // 背阴坡却变成死黑 —— 因为低角度太阳（sunDir.y 0.28）本来就只点亮朝上的面，
  // 直射光一降，背阴面就没人照了。
  //
  // 判据是**配比**：直射与环境光的比例决定对比度，曝光决定整体亮度。
  // 三个都要在合理区间，少一个都会出现"过曝"或"死黑"中的一边。
  const env = def.env;
  ok('B11a 直射光强度合理（>3 会在顺光坡上过曝成白片）',
    env.sun >= 1.6 && env.sun <= 3.2, `sun ${env.sun}`);
  ok('B11b 环境光补上来了（低角度太阳下 hemi 必须够，否则背阴坡死黑）',
    env.hemi >= 1.3, `hemi ${env.hemi}`);
  ok('B11c 曝光不过高（>1.1 叠加直射光就是刺眼）',
    env.exposure <= 1.0, `exposure ${env.exposure}`);
  ok('B11d 环境光与直射光的比例合理（hemi/sun 在 0.4~1.2 之间才既不糊也不死）',
    env.hemi / env.sun >= 0.4 && env.hemi / env.sun <= 1.2,
    `比例 ${(env.hemi / env.sun).toFixed(2)}`);

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

  // ══════════════ B12~B14：营区专项 ══════════════
  //
  // 这一段盯的是"营区是重灾区"。用户报的问题（三棱柱形绿色片状物 + 大量错位）
  // 追下去是两类病因，判据必须分别钉住：
  //
  //   B12 布局：营区内任意两件**不同物件**的占地不得重叠。
  //        早一版是各区各写各的偏移量，加着加着就压到别人身上（实测 29 处）。
  //   B13 大门：门柱必须贴在门洞两侧（`c` 是沿墙的米，写错就整根门柱骑在墙上）。
  //   B14 帐篷：几何必须"脊线水平、顶点朝上"（早一版是横躺的三棱柱，
  //        视觉上就是一片竖着的绿色三角板 —— 用户说的"意义不明的物体"）。
  {
    // ── 重建一次 build，给每件物件打上"哪一次调用"的标记 ──
    // 口径：**按调用聚合，不按类型聚合**。按 owner 聚会把两个出生点的沙袋
    // 并成一件（横跨全图 300m），随后每一条重叠都是假的。
    const items = [];
    let cur = null;
    const mkItem = (owner) => { const it = { owner, boxes: [] }; items.push(it); return it; };
    cur = mkItem('(裸)');
    const wi = new World(mkGame(), def);
    // **只挂一层 box/collider wrapper**。早一版把它和下面的 owner 名单套在一起，
    // 两层 wrapper 争夺 cur 的归属，循环里 8 次 crateStack 被并成一件
    // （实测报出 "crate [14,-13→28,37] 14m×50m" —— 那是整个弹药区的并集）。
    // 正确做法：owner wrapper **调完之后**才切 cur（而不是"产生新盒就切"），
    // 这样一次调用的所有盒（含它内部的 box）都归同一件。
    //
    // **裸 box()/collider() 调用各自成一件。**
    // 地图里有大量直接调`w.box()` 的摆件（弹药箱、门柱、屋顶哨台、白色标线……），
    // 它们不经过任何 owner 助手。早一版把它们全塞进初始那个 '(裸)' 件，
    // 于是那件横跨 30×53m（整个营区东南），报出的"冲突"没有一条是真的。
    //
    // 怎么区分"裸调用"和"某个助手内部的 box"？用**调用深度**：
    // 助手 wrapper 会把 depth 加一，裸调用时 depth 为 0。
    let depth = 0;
    const oBx = wi.box.bind(wi);
    wi.box = (...a) => {
      const b = oBx(...a);
      if (b) {
        if (depth === 0) cur = mkItem('(裸)');
        cur.boxes.push(b);
      }
      return b;
    };
    const oCl = wi.collider.bind(wi);
    wi.collider = (...a) => {
      const b = oCl(...a);
      if (b) {
        if (depth === 0) cur = mkItem('(裸碰撞)');
        cur.boxes.push(b);
      }
      return b;
    };
    for (const k of ['sandbags', 'rock', 'tree', 'crate', 'crateStack', 'container', 'barrel',
      'watchtower', 'tent', 'car', 'truck', 'truckCollider', 'building', 'wall', 'wallBy',
      'jersey', 'barrier', 'tank', 'pipe', 'lampPost', 'stairs', 'pad', 'awning']) {
      if (typeof wi[k] !== 'function') continue;
      const o = wi[k].bind(wi);
      wi[k] = (...a) => {
        // 先切到新的一件，再跑 —— 它内部产生的盒（含嵌套 box）都进这一件
        const keep = cur;
        const mine = mkItem(k);
        cur = mine;
        depth++;
        const r = o(...a);
        depth--;
        // **无条件切回**（这是关键）。
        // 早一版只在"没产生盒"时切回，于是循环里连续两件之间隔着
        // 一个不产生盒的调用（place/padTo/free）时，两件会被并成一件 ——
        // 实测鞍部两块岩石并成 [0,-30→13,-7]（13m×23m），报出的"冲突"全是假的。
        cur = keep;
        if (mine.boxes.length === 0) {
          const idx = items.indexOf(mine);
          if (idx >= 0) items.splice(idx, 1);
        }
        return r;
      };
    }
    def.build(wi, wi.game);
    wi.finalize();
    // 归占地
    for (const it of items) {
      if (!it.boxes.length) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const b of it.boxes) {
        x0 = Math.min(x0, b.x0); z0 = Math.min(z0, b.z0);
        x1 = Math.max(x1, b.x1); z1 = Math.max(z1, b.z1);
      }
      it.bb = { x0, z0, x1, z1 };
    }
    // 营区范围 = 围墙矩形（cx±36, cz-24..cz+30）
    const CAMP = { x0: SITE.camp.x - 36, z0: SITE.camp.z - 24, x1: SITE.camp.x + 36, z1: SITE.camp.z + 30 };
    const inCamp = items.filter(it => it.bb && it.bb.x1 >= CAMP.x0 && it.bb.x0 <= CAMP.x1 &&
      it.bb.z1 >= CAMP.z0 && it.bb.z0 <= CAMP.z1);

    // ── B12 布局不重叠 ──
    //
    // 阈值 0.4m：墙是 0.3~0.4m 厚，"贴着墙摆"的东西本来就该零间隙，
    // 但 0.4m 以内的接触读不出来（分不清是紧贴还是嵌进去）。
    //
    // **口径：只比"不同功能区"，不比同一件东西的内部构件。**
    // 早一版按 owner 名分组，但building 内部会调box() 建墙/屋顶/勒脚，
    // 这些盒在同一次调用里，却和另一次调用的墙段交叉 —— 报出来全是假的
    // （实测"wall × building 11.2×4.0m"就是 HQ 的墙与自己的屋顶）。
    // 所以：**每件东西只取它的"外轮廓"**（各盒的并集包围盒），
    // 再比外轮廓之间是否重叠。
    const OV = 0.4;
    // 一体结构白名单：这些 owner 内部会建出多个互相**贴着**的盒，
    // 它们本就是一件东西（不是两件东西撞在一起）：
    //   building  墙/屋顶/勒脚/女儿墙
    //   wall/wallBy 墙段本来就首尾相接
    //   crateStack 三层箱子叠在一起（层间只错 0.6m）
    //   pad      八边形的8 条窄条
    // 判据要问的是"**两件不同的东西**有没有撞在一起"，
    // 不是"一件东西的零件之间有没有贴在一起"。
    const ONE = new Set(['building', 'wall', 'wallBy', 'crateStack', 'crate', 'pad', '(裸)']);
    const clashes = [];
    for (let i = 0; i < inCamp.length; i++) {
      for (let j = i + 1; j < inCamp.length; j++) {
        const A = inCamp[i], B = inCamp[j];
        // 同属一体结构（墙/建筑/箱堆/地坪/裸件）之间不判
        if (ONE.has(A.owner) && ONE.has(B.owner)) continue;
        const a = A.bb, b = B.bb;
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
        if (ox > OV && oz > OV) {
          clashes.push(`${A.owner} [${a.x0.toFixed(0)},${a.z0.toFixed(0)}→${a.x1.toFixed(0)},${a.z1.toFixed(0)}]` +
            ` × ${B.owner} [${b.x0.toFixed(0)},${b.z0.toFixed(0)}→${b.x1.toFixed(0)},${b.z1.toFixed(0)}]` +
            ` ${ox.toFixed(1)}×${oz.toFixed(1)}m`);
        }
      }
    }
    ok('B12 营区内没有两件不同物件互相穿模（帐篷插进兵营、箱子压围墙那一类）',
      clashes.length === 0,
      clashes.length ? `${clashes.length} 对：${clashes.slice(0, 3).join('； ')}` : `${inCamp.length} 件物件互不重叠`);
    // B12a 先决臂：物件数必须够（营区有 100+ 件）。件数太少说明聚合口径坏了——
    // 早一版把整个弹药区并成一件（"14m×50m"），报"无冲突"其实是没在比。
    ok('B12a【先决臂】营区物件数合理（聚合口径没把多件并成一件）', inCamp.length >= 60,
      `聚合出 ${inCamp.length} 件`);

    // ── B12b 反证臂：塞一件压进兵营的物件进去，判据必须看见 ──
    // 口径教训（地形那轮踩过）：正向断言必须配反证臂，否则判据可能恒绿。
    {
      const saved = items.length;
      const fake = { owner: '假帐篷', boxes: [], bb: { x0: SITE.camp.x - 25, z0: SITE.camp.z - 6, x1: SITE.camp.x - 20, z1: SITE.camp.z + 1 } };
      items.push(fake);
      const inCamp2 = items.filter(it => it.bb && it.bb.x1 >= CAMP.x0 && it.bb.x0 <= CAMP.x1 &&
        it.bb.z1 >= CAMP.z0 && it.bb.z0 <= CAMP.z1);
      let bad = 0;
      for (let i = 0; i < inCamp2.length; i++) for (let j = i + 1; j < inCamp2.length; j++) {
        const A = inCamp2[i].bb, B = inCamp2[j].bb;
        if (Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) > OV &&
          Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0) > OV) bad++;
      }
      items.length = saved;
      ok('B12b【反证臂】塞一件压进兵营的帐篷，判据必须看见（B12 不是恒绿）', bad > 0,
        `注入后报出 ${bad} 对重叠`);
    }

    // ── B13 大门：门柱贴在门洞两侧 ──
    // 口径：`wallBy` 的开口参数 `c` 是"沿墙的米"（从墙起点算），不是世界坐标。
    // 写错 c 门洞就偏，门柱便一根卡在门洞里、一根骑在墙上（实测偏 2m）。
    //
    // 检测口径：**直接从碰撞盒列表按位置找北墙分段**，不靠 owner 标记 ——
    // `wallBy` 内部是调`wall()` 逐段建盒的，钩子抓不到"这是哪次 wallBy"。
    //
    // **口径：按盒中心线筛，不按传入的 z 值筛。**
    // `wallBy(..., z0, ...)` 传进去的 z0 是墙的**内侧边界**，而 wall() 生成的盒
    // 中心线落在 z0 + 厚/2 = z0 + 0.15（实测北墙盒 z ∈ [-15.15, -14.85]，
    // 而传入值是 -16）。早一版按 |z0 - WZ| < 1.2 筛，一个都筛不到 ——
    // 判据报"北墙没有门洞"，读起来像地图坏了，其实是判据自己找错了线。
    const WZ = SITE.camp.z - 24;
    const onNorthWall = (b) => {
      const mid = (b.z0 + b.z1) / 2;
      return Math.abs(mid - (WZ + 0.15)) < 0.6;
    };
    const northSegs = wi.boxes.filter(onNorthWall)
      .map(b => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 }))
      .sort((a, b) => a.x0 - b.x0);
    // 门洞 = 分段之间的缺口（>1m）。
    //
    // **口径：按"贴地"筛要看y0 与当地地面的差，不是看 y0 的绝对值。**
    // 早一版写 `s.y0 < 1.5`，但营区在y≈10 的台地上，墙盒的 y0 是**世界高度** 9.8，
    // 于是 21 段全被滤掉、报"北墙没有门洞"—— 读起来像墙是封死的，
    // 其实是判据拿"绝对高度 1.5m"去比"海拔 10m 的地面"。
    // 正确口径：y0 - 当地地面高度 < 0.5m 才是贴地段（门洞上方的过梁悬在 3m高处，
    // 会被正确排除）。
    const ground = northSegs.filter(s => s.y0 - T.height((s.x0 + s.x1) / 2, WZ + 0.15) < 0.5);
    //
    // 门洞 = **墙两端之间的空隙**（不是"某一段墙的左边缘"）。
    // 早一版找的是"相邻两段之间的缺口 > 1m"，可门洞两端**本来就有墙**（只是没有门洞那段），
    // 所以缺口找不到；找到的是"门柱左边那条0.6m 的缝"——
    // 于是门洞位置算成 x = -11.7 而不是真的-18。
    // 正确口径：**把所有墙段的并集取出来，找被墙包住的那段空隙**；
    // 若没有空隙（门洞等于 0 宽），就取"最宽的那段没有墙的区间"。
    let gapLo = null, gapHi = null;
    {
      // 墙并集：合并相邻/重叠的段
      const merged = [];
      for (const sg of ground) {
        const last = merged[merged.length - 1];
        if (last && sg.x0 <= last.x1 + 0.05) last.x1 = Math.max(last.x1, sg.x1);
        else merged.push({ x0: sg.x0, x1: sg.x1 });
      }
      // 找最大的空隙
      let best = -1;
      for (let i = 1; i < merged.length; i++) {
        const g = merged[i].x0 - merged[i - 1].x1;
        if (g > best) { best = g; gapLo = merged[i - 1].x1; gapHi = merged[i].x0; }
      }
      // 没有空隙（门洞宽度为 0）：取"离路心最近的那段墙的左边界"当门洞位置
      if (best <= 1) { gapLo = null; gapHi = null; }
    }
    // 门柱：北墙线上、高 4.2m 的细柱（0.6m 见方）
    const posts = wi.boxes
      .filter(b => onNorthWall(b) && (b.y1 - b.y0) > 3.8 && (b.x1 - b.x0) < 1.2)
      .map(b => ({ x0: b.x0, x1: b.x1 }))
      .sort((a, b) => a.x0 - b.x0);
    //
    // **门洞中心必须与"盘山路穿墙处"对齐，不是与营心对齐。**
    // 早一版判据写的是"门开在营心正上方"，于是本轮把门从营心挪到
    // 盘山路出口（x ≈ -12）之后，它报"门洞中心 -11.7，应 2"——
    // 读起来像门摆错了，其实是**判据钉错了基准**：
    // 门的作用是"让路进来"，门开在实墙上就没有意义（门外没路）。
    // 所以基准改成从 RAMPS 算出的路心穿墙位置。
    const { RAMPS: RB } = await import('../js/maps/ridges.js');
    let roadX = SITE.camp.x;
    {
      // 找路心穿过北墙（WALL_Z0）的那一点
      const wz = SITE.camp.z - 24;
      outer: for (const path of RB) {
        for (let i = 0; i + 1 < path.length; i++) {
          const [ax, az] = path[i], [bx, bz] = path[i + 1];
          if ((az < wz) === (bz < wz)) continue;
          const t = (wz - az) / (bz - az);
          roadX = ax + (bx - ax) * t;
          break outer;
        }
      }
    }
    const gapC = gapLo !== null ? (gapLo + gapHi) / 2 : NaN;
    const gapOk = gapLo !== null && gapHi !== null && Math.abs(gapC - roadX) <= 9;
    const postOk = posts.length === 2 &&
      Math.abs(posts[0].x1 - gapLo) < 0.35 && Math.abs(posts[1].x0 - gapHi) < 0.35;
    ok('B13 大门对齐：门洞开在盘山路穿墙处，两根门柱贴住洞口两侧',
      gapOk && postOk,
      gapLo === null ? `北墙 ${ground.length} 段却没有门洞（墙是封死的，玩家进不去营区）`
        : `门洞 x ∈ [${gapLo.toFixed(1)}, ${gapHi.toFixed(1)}] 中心 ${gapC.toFixed(1)}` +
        `（盘山路穿墙处 ${roadX.toFixed(1)}，容差 9m），门柱 ${posts.length} 根` +
        (posts.length ? ` [${posts.map(p => p.x0.toFixed(1) + '→' + p.x1.toFixed(1)).join(', ')}]` : ''));
    // B13b 先决臂：门洞地面必须可走（否则门开着也进不去）
    const gateCx = gapLo !== null ? (gapLo + gapHi) / 2 : SITE.camp.x;
    ok('B13b【先决臂】大门前的地面可走（门开着也要能进出）',
      T.slope(gateCx, WZ + 0.15) < SLOPE.ROLLING, `门洞中心坡度 ${T.slope(gateCx, WZ + 0.15).toFixed(2)}`);

    // ── B14 帐篷几何：脊线水平、顶点朝上 ──
    // 病根：早一版是 `CylinderGeometry(w/2,w/2,d,3,1,true)` 加两次旋转，
    // 三棱柱的底边 rotateZ 后变成**竖直边**，顶点指向水平方向 ——
    // 于是"帐篷"是一片竖着的绿色三角板（用户报"三棱柱形绿色片状物，意义不明"）。
    //
    // 判据直接量最终几何的三个性质：
    //   底面贴地（min.y = 0）、脊线水平、截面是矩形。
    //
    // **口径：必须在旋转前量**。帐篷带 rotY（±0.08 的小角度），
    // 旋转后的外接盒必然比旋转前大（w=5,d=7 量出 7.38）——
    // 那是几何变换的正常结果，不是建模错误。
    // 办法：临时把 rotY 置0 再量，量完恢复。
    const tw = new World(mkGame(), def);
    const tentBB = [];
    // 钩住 mesh()：tent() 内部只调一次 mesh()，量它的几何即可。
    // **必须在 rotY=0 时量** —— 帐篷带 ±0.08 的小角度，旋转后外接盒必然变大
    // （w=5,d=7 量出 7.38），那是几何变换的正常结果，不是建模错误。
    const oMesh = tw.mesh.bind(tw);
    let probeMesh = null;
    tw.mesh = (geo, ...rest) => {
      const m = oMesh(geo, ...rest);
      probeMesh = m;
      return m;
    };
    const oTent = tw.tent.bind(tw);
    tw.tent = (x, z, ww, dd, rotY, opt) => {
      const r = oTent(x, z, ww, dd, rotY, opt);
      // 用同参数、rotY=0 再跑一次拿"未旋转"的尺寸（几何同构，只是朝向不同）
      probeMesh = null;
      oTent(x, z, ww, dd, 0, opt);
      if (probeMesh) {
        probeMesh.geometry.computeBoundingBox();
        tentBB.push({ bb: probeMesh.geometry.boundingBox.clone(), w: ww, d: dd, rotY });
      }
      return r;
    };
    def.build(tw, tw.game);
    let tentBad = [];
    for (const t of tentBB) {
      const sy = t.bb.max.y - t.bb.min.y;
      const sx = t.bb.max.x - t.bb.min.x, sz = t.bb.max.z - t.bb.min.z;
      // 底面贴地
      if (Math.abs(t.bb.min.y) > 1e-6) tentBad.push(`底面 y=${t.bb.min.y.toFixed(3)} 不贴地`);
      // 脊高至少 2m（横躺时脊高是 0.87×w 也能过这条，所以下面两条才是关键）
      if (sy < 2) tentBad.push(`脊高只有 ${sy.toFixed(2)}m`);
      // 关键 1：**水平最大跨度必须等于 d**（脊线水平）。横躺时最大跨度是 w。
      const hSpan = Math.max(sx, sz);
      if (Math.abs(hSpan - t.d) > 0.01) {
        tentBad.push(`水平跨度 ${hSpan.toFixed(2)} ≠ 脊长 ${t.d}（脊线不水平）`);
      }
      // 关键 2：另一轴必须等于 w（截面是矩形）。横躺时是 0.87w（斜切的三角截面）。
      const other = Math.min(sx, sz);
      if (Math.abs(other - t.w) > 0.01) {
        tentBad.push(`截面宽 ${other.toFixed(2)} ≠ 帐篷宽 ${t.w}`);
      }
    }
    ok('B14 帐篷几何正确：脊线水平、顶点朝上、底面贴地（不是竖着的三棱柱）',
      tentBad.length === 0 && tentBB.length === 5,
      tentBad.length ? tentBad.slice(0, 3).join('； ') : `${tentBB.length} 顶帐篷几何正确`);
    // B14b 先决臂：判据必须真的量到了 5 顶帐篷
    ok('B14b【先决臂】B14 确实量到了全部 5 顶帐篷', tentBB.length === 5, `量到 ${tentBB.length} 顶`);
  }

  // ══════════════ B15~B17：导航网格（B 段的前置依赖）══════════════
  //
  // 这一段盯的是"看不见的网格"。用户看不见导航网格，但 bot 走它 ——
  // 网格错了玩家体验就是"bot 穿墙""bot 卡在出生点""高地上不去"。
  //
  // 三个坑都是同一类：**判定用了绝对世界高度，而地面不在 y=0**。
  //   B15 墙体必须进网格（否则整圈营区墙对 bot 是空气）
  //   B16 路廊要豁免墙体（否则盘山路被门洞/岩壁拦腰截断，高地成孤岛）
  //   B17 出生点要清场（否则某个 spawn 格子被沙袋压住，玩家开局出不去）
  {
    const RAMPS_B15 = (await import('../js/maps/ridges.js')).RAMPS;
    const gw = new World(mkGame(), def);
    def.build(gw, gw.game);
    gw.finalize();
    const n = gw.gn, cs = gw.cs, half = gw.half;
    const W2 = (x) => Math.floor((x + half) / cs);
    const walkAt = (x, z) => gw.walkable(W2(x), Math.floor((z + half) / cs));

    // ── B15 营区围墙必须真的封住导航网格 ──
    //
    // **门洞位置从碰撞盒实测拿，不写死。** 早一版判据采样 x ∈ [-6, 6]
    // （假定门开在正中），而门实际开在盘山路穿墙处（x = -18）——
    // 判据量的是实墙，报"18/60 不可走，墙体多半被跳过了"，
    // 读起来像地图坏了，其实是判据找错了门。
    const WALL_X_R = 36;                            // = 围墙半宽（cx±36）
    //
    // **探测 z 必须用墙盒的中心线，不能用"北墙所在的 z"。**
    // `wallBy(x0, WALL_Z0, x1, WALL_Z0, ...)` 传进去的 WALL_Z0 = cz-24 是墙的
    // **内侧边界**，而 wall() 生成的盒中心线在该 z 上（实测 cz-24 = -16，
    // 盒落在 z ∈ [-16.18, -15.82]，中心 -16.0 —— 两侧各错 0.15）。
    // 判据早一版探 z = -15.0，距墙心 0.85m，而墙的膨胀半宽只有
    // 0.35/2 + 0.4 = 0.575m —— **探在墙外面**，于是每一段都报"漏"，
    // 读起来像围墙没封住，其实是探针没碰到墙。
    const WZc = SITE.camp.z - 24;                  // 北墙盒中心线（= 传入的那个 z）
    const wallBoxes = gw.boxes.filter(b => Math.abs((b.z0 + b.z1) / 2 - WZc) < 0.6);
    const segs = wallBoxes.map(b => ({ x0: b.x0, x1: b.x1, y0: b.y0, mat: b.mat }))
      .filter(s => s.y0 - T.height((s.x0 + s.x1) / 2, WZc) < 0.5)   // 贴地段
      // **只认围墙自己的段（`concreteDark`）**：HQ 的北墙正好压在这条线上
      // （x ∈ [-8, 4]，材质 plasterWhite），不筛掉就会把指挥部当成围墙 ——
      // 判据报"21 格漏"，读起来像围墙漏了，其实是取样取错了对象。
      // 材质是唯一的可靠区分：营区围墙一律 concreteDark，兵营/HQ 是 plaster/plasterWhite。
      .filter(s => s.mat === 'concreteDark')
      .sort((a, b) => a.x0 - b.x0);
    // 门洞 = 墙并集里被包住的空隙（口径与 B13 段同一份，见那里���注释）。
    // 早一版这里是"找相邻两段之间 >1m 的缺口"，可门洞两端本来就有墙，
    // 缺口不存在，找到的反而是"门柱左边那条 0.6m 的缝" ——
    // 于是门心算成 -8，判据报"门被堵了一半"。同一段代码里写两份口径，
    // 迟早会有一份忘掉更新。
    let gateLo = null, gateHi = null;
    {
      const merged = [];
      for (const sg of segs) {
        const last = merged[merged.length - 1];
        if (last && sg.x0 <= last.x1 + 0.05) last.x1 = Math.max(last.x1, sg.x1);
        else merged.push({ x0: sg.x0, x1: sg.x1 });
      }
      let best = -1;
      for (let i = 1; i < merged.length; i++) {
        const g = merged[i].x0 - merged[i - 1].x1;
        if (g > best) { best = g; gateLo = merged[i - 1].x1; gateHi = merged[i].x0; }
      }
      if (best <= 1) { gateLo = null; gateHi = null; }
    }
    const gateC = gateLo !== null ? (gateLo + gateHi) / 2 : SITE.camp.x;
    //
    // **只在"北墙自己的盒"覆盖的 x 区间上采样。**
    // 早一版扫整条 z=-15 的行，把别的建筑（HQ 的北墙正好压在这条线上，
    // x ∈ [-8, 4]）也算成"北墙不可走"—— 读起来像围墙没封住，
    // 其实是判据把 HQ 当成了围墙。
    // 正确口径：对每一段北墙盒，逐格验证"这段墙在网格里确实封住了"。
    //
    // **只验"墙的中心带"，不验墙的两条边。**
    // buildGrid 用 `inf = 0.4` 把盒子向外膨胀，好让贴墙走的玩家被推开 ——
    // 于是每段墙的**边缘那0.4m** 在网格里是可走的（实测每段漏 1~3 格，
    // 都在两端）。这是设计，不是漏洞：人贴着 0.4m 宽的墙边走过去不穿墙。
    // 早一版要求"墙内每格都不可走"，报21 格漏 —— 读起来像围墙漏了，
    // 其实是判据把"设计上的贴墙余量"当成了缺陷。
    // 正确口径：**墙的中心 50% 必须每一格都不可走**。
    //
    // **离盘山路 ≤ 8m 的格豁免（那是门）。**
    // 门开在 x ≈ -18（路心穿墙处），而 buildGrid 对"距折线 ≤ terrainRoadGate(8m)"
    // 的格不记障碍 —— 这是设计：路要从门洞过去。
    // 所以判据不能要求"门附近的墙也封住"，那等于要求"路被墙堵死"
    // （实测早一版报 8 格漏，全在 x ∈ [-26, -6]，正是门那一段）。
    // 正确口径：**不在门/ 路廊内的墙，每一格都必须不可走**。
    const distToRoad = (x, z) => {
      let m = Infinity;
      for (const path of RAMPS_B15) {
        for (let i = 0; i + 1 < path.length; i++) {
          const ax = path[i][0], az = path[i][1], vx = path[i + 1][0] - ax, vz = path[i + 1][1] - az;
          const L2 = vx * vx + vz * vz;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2)) : 0;
          const dx = x - (ax + vx * t), dz = z - (az + vz * t);
          m = Math.min(m, Math.hypot(dx, dz));
        }
      }
      return m;
    };
    const GATE_HALF = def.terrainRoadGate ?? 8;
    let segBad = 0, segTotal = 0, exempt = 0;
    for (const sg of segs) {
      const mid = (sg.x0 + sg.x1) / 2, halfw = (sg.x1 - sg.x0) / 2;
      const a = Math.ceil(mid - halfw * 0.5), b = Math.floor(mid + halfw * 0.5);
      for (let x = a; x <= b; x++) {
        if (distToRoad(x, WZc) <= GATE_HALF) { exempt++; continue; }
        segTotal++;
        if (walkAt(x, WZc)) segBad++;
      }
    }
    const wallBlocked = segTotal - segBad;
    ok('B15 营区围墙在导航网格里真的封得住（bot 不会穿墙进营区）',
      gateLo !== null && segTotal > 20 && segBad === 0,
      `北墙 ${segTotal} 个墙心采样点（另有${exempt} 个在门/路廊内、已豁免）里 ${wallBlocked} 个不可走` +
      (segBad ? `（${segBad} 格漏了）` : `，门洞 x ∈ [${gateLo?.toFixed(1)}, ${gateHi?.toFixed(1)}]`));
    // B15b 先决臂：门洞必须是通的（否则墙封住了路，B15 就成了"整圈都堵"的假绿）
    let gateOpen = 0, gateN = 0;
    for (let x = gateLo ?? (SITE.camp.x - 4); x <= (gateHi ?? SITE.camp.x + 4); x += 1) {
      gateN++; if (walkAt(x, WZc)) gateOpen++;
    }
    ok('B15b【先决臂】大门在导航网格里是通的（墙堵门=B15 的假绿）',
      gateN > 0 && gateOpen >= gateN * 0.7,
      `门洞 ${gateN} 个采样点里 ${gateOpen} 个可走（门在 x≈${gateC.toFixed(0)}）`);

    // ── B16 盘山路在网格里全程可走（路廊豁免了墙体）──
    const RAMPS = RAMPS_B15;
    let rampBlocked = 0;
    for (const path of RAMPS) {
      for (let i = 0; i + 1 < path.length; i++) {
        const [ax, az] = path[i], [bx, bz] = path[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const steps = Math.max(2, Math.round(L));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          if (!walkAt(ax + (bx - ax) * t, az + (bz - az) * t)) rampBlocked++;
        }
      }
    }
    ok('B16 两条盘山路在导航网格里全程可走（路廊豁免墙体）',
      rampBlocked === 0, rampBlocked ? `${rampBlocked} 个采样点被封` : `两条路全段可走`);

    // ── B17 出生点都在主连通域里（出生点清场生效）──
    const seen = new Uint8Array(n * n);
    const stack = [[n >> 1, n >> 1]];
    seen[(n >> 1) * n + (n >> 1)] = 1;
    while (stack.length) {
      const [x, z] = stack.pop();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 1 || nz < 1 || nx >= n - 1 || nz >= n - 1) continue;
        if (seen[nz * n + nx] || !gw.walkable(nx, nz)) continue;
        seen[nz * n + nx] = 1;
        stack.push([nx, nz]);
      }
    }
    let orphan = 0;
    const orphanList = [];
    for (const list of [gw.spawns.A, gw.spawns.B]) {
      for (const p of list) {
        const ix = W2(p.x), iz = Math.floor((p.z + half) / cs);
        if (!seen[iz * n + ix]) { orphan++; if (orphanList.length < 3) orphanList.push(`(${p.x.toFixed(0)},${p.z.toFixed(0)})`); }
      }
    }
    ok('B17 每个出生点都在主连通域里（玩家一出生就能走出去）',
      orphan === 0, orphan ? `${orphan} 个出不去：${orphanList.join(' ')}` :
        `A ${gw.spawns.A.length} 个 + B ${gw.spawns.B.length} 个出生点全通`);

    // ── B18 门梁不许把门洞封死（baseY 归位）──
    //
    // 病根：`box(cx, y0, ...)` 的 y0 相对 `this.baseY`，而 baseY 是上一次
    // padTo() 留下的。门梁之前没归位，生成的盒从地面起算 4.2m 高、
    // 横跨整个门洞 —— 于是一根 17m 长的横梁把门洞整个封死
    // （实测门洞那两格都不可走，玩家进不去营区）。
    //
    // 判据分两半，各验各的：
    //   门梁本身：横跨门洞的那张盒，**底面必须离地 ≥ 3m**（否则它就是堵门的板子）
    //   门洞本身：门洞区间内每一格都必须可走（端点±1 允许是门柱）
    const beam = gw.boxes.find(b => b.mat === 'darkMetal' &&
      Math.abs((b.z0 + b.z1) / 2 - WZc) < 0.6 && (b.x1 - b.x0) > 6);
    let beamBad = null;
    if (!beam) beamBad = '找不到门梁';
    else {
      const relBottom = beam.y0 - T.height((beam.x0 + beam.x1) / 2, WZc);
      if (relBottom < 3) beamBad = `门梁底面只离地 ${relBottom.toFixed(2)}m（<3m就是堵门的板子）`;
    }
    let gateCellsBad = 0, gateCellsN = 0;
    if (gateLo !== null) {
      for (let x = Math.ceil(gateLo) + 1; x <= Math.floor(gateHi) - 1; x++) {
        gateCellsN++;
        if (!walkAt(x, WZc)) gateCellsBad++;
      }
    }
    ok('B18 门梁离地够高、门洞里没有墙（门是能走的门，不是画出来的门）',
      !beamBad && gateCellsN > 4 && gateCellsBad === 0,
      beamBad ? beamBad :
      `门梁底面离地 ${(beam.y0 - T.height((beam.x0 + beam.x1) / 2, WZc)).toFixed(2)}m，` +
      `门洞内 ${gateCellsN} 格全可走`);
  }
}

// ══════════════ B19：岩石网格不撕裂 / 沙袋袋体不缩水 ══════════════
// 两把钉子都问**被画出来的量**：
//   岩石 —— 岩石已实例化（全部共享 ROCK_VARIANTS 个基底几何），基底是 detail=1 的
//          非索引十二面体（432 顶点只有 ~74 个唯一角点，每个角点被复制 ~6 份），
//          随机缩放后**唯一角点数必须与原始网格一致**：逐顶点独立随机会把共享
//          角点撕向不同位置，岩石碎成满地三角薄片（远看"大石头周围一片一片的
//          碎石堆"）。实例化本体（count、包围球）一并量到。
//   沙袋 —— 袋体量的是 geoLists 里**合并前**的单袋几何（生成现场记录，躲开合并后
//          无法分袋的死角）：尺寸下限防"改回瘦香肠"，视觉顶 ≤ 碰撞盒顶防
//          "打得中看得见的袋体却打不中盒"。
{
  const { mulberry32 } = await import('../js/util.js');
  const uniquePts = (g, q = 1e-4) => {
    const p = g.attributes.position, set = new Set();
    for (let i = 0; i < p.count; i++)
      set.add(Math.round(p.getX(i) / q) + ',' + Math.round(p.getY(i) / q) + ',' + Math.round(p.getZ(i) / q));
    return set.size;
  };
  const nPristine = uniquePts(new THREE.DodecahedronGeometry(1, 1));
  // 反证臂：老算法（逐顶点独立 k）必须被 B19 抓住，判据不是恒绿
  const torn = new THREE.DodecahedronGeometry(1, 1);
  { const p = torn.attributes.position, rr = mulberry32(7);
    for (let i = 0; i < p.count; i++) { const k = 0.75 + rr() * 0.45; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k); } }

  const w = new World(mkGame(), { id: 'b19', size: 60, seed: 3 });
  // 沙袋先量后 finalize：finalize 会把 geoLists 合并并清空
  w.sandbags(0, 0, 4, 0);
  const bagList = w.geoLists.get(mat('sandbag'));
  const bagBB = bagList && bagList.length ? (bagList[0].computeBoundingBox(), bagList[0].boundingBox) : null;
  const sz = new THREE.Vector3();
  if (bagBB) bagBB.getSize(sz);
  ok('B19b 沙袋袋体不缩水（长≥0.62 高≥0.24，旧瘦袋 0.58×0.22 必须过不了）',
    !!bagBB && sz.x >= 0.62 && sz.y >= 0.24,
    bagBB ? `单袋 ${sz.x.toFixed(2)}×${sz.y.toFixed(2)}×${sz.z.toFixed(2)}` : 'geoLists 里没有沙袋几何');
  const collider = w.boxes.find(b => b.mat === 'sandbag');
  let topY = -Infinity;
  if (bagList) for (const g of bagList) { g.computeBoundingBox(); topY = Math.max(topY, g.boundingBox.max.y); }
  ok('B19c 沙袋视觉顶不高于碰撞盒顶（打得中看得见的袋体必有盒可撞）',
    !!collider && isFinite(topY) && topY <= collider.y1 + 0.02,
    isFinite(topY) ? `视觉顶 ${topY.toFixed(2)} vs 盒顶 ${collider ? collider.y1.toFixed(2) : '无盒'}` : '没有沙袋几何');

  // 岩石：实例化在 finalize() 里合成，量的是共享基底几何 + 实例数
  w.rock(0, 0, 2.2);
  w.finalize();
  const rockMesh = w.root.children.find(m => m.isInstancedMesh && m.geometry.type === 'DodecahedronGeometry');
  ok('B19 岩石基底角点副本同位移（闭合岩石，不是一片一片的碎石）+ 实例化生效',
    !!rockMesh && uniquePts(rockMesh.geometry) === nPristine && rockMesh.count >= 1,
    rockMesh ? `唯一角点 ${uniquePts(rockMesh.geometry)}（应为 ${nPristine}），实例 ${rockMesh.count}` : 'root 里没有岩石 InstancedMesh');
  ok('B19a【反证臂】逐顶点独立随机的老算法必须被 B19 抓住', uniquePts(torn) > nPristine,
    `老算法唯一角点 ${uniquePts(torn)}`);
}
// ══════════════ 输出 ══════════════
let pass = 0;
for (const [good, label] of out) {
  console.log((good ? '  ✅ ' : '  ❌ ') + label);
  if (good) pass++;
}
console.log('\n' + (pass === out.length ? 'GREEN' : 'RED') + '  ' + pass + '/' + out.length + ' 通过');
process.exit(pass === out.length ? 0 : 1);
