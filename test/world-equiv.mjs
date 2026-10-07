// 宽相等价判据（docs/client-performance-audit.md C2 落地时立）。
//
// js/world.js 的碰撞查询走均匀哈希格子的宽相（buildBroad/_query），服务端与客户端
// 共用这一份文件 —— **候选集与全量线性扫的命中/推挤结果必须逐位一致**，这是客户端
// 预测/回滚的命根子（test/rollback、reconcile-chain、lagcomp 都踩在它上面）。
// 本文件把"旧的全量线性扫"逐字拷来当基准，对真地图 + 对抗性几何做差分：
//   · raycast / lineBlocked / collide / groundHeight / ceilingHeight 五条查询
//   · 边缘用例：原点贴盒面（内/外/正上）× 轴向方向 —— 这里抓到过两类真 bug：
//     ①格网范围按 def.size 取、而地面大平面横跨 size+80 米，格外查询一格都取不到；
//     ②rayAABB 的 NaN 幽灵命中（d 某轴为 0 且原点与某盒面精确相等时 (0)×∞=NaN
//       毒化 tmax，任何远处的盒子都可能被判成 t=0 命中）—— 这是两端共有的既有行为，
//       **必须复刻而不是修**（修了=两端同时悄悄改物理），宽相为此带 _faceX/Y/Z 精确
//       贴面索引，且轴零射线不做 y 粗筛（幽灵连 y 几何都不认）。
//   · collide 的包络重试：推挤会在循环中途改 pos，固定候选框可能漏"被推出去之后才
//     碰到的盒子"——嵌套大盒（中心在盒内分支一次推出几米）逼出重试路径。
//   · 闸门场景：战役会直接 filter w.boxes（campaign.js:openGate），长度校验必须触发重建。
// 反证臂 R1：故意挪一个盒 1e-9 再比对，证明这套差分 harness 真的会红（不是恒绿）。
// 改 world.js 碰撞相关代码（含 rayAABB、_query、包络常数）之后必须先过这里。
import { installBrowserShim } from '../server/browser-shim.mjs';
installBrowserShim();
const { World } = await import('../js/world.js');
const { MAPS } = await import('../js/maps.js');
const { rayAABB, clamp, mulberry32 } = await import('../js/util.js');
const { initTextures } = await import('../js/materials.js');
const THREE = (await import('three')).default ?? (await import('three'));

await initTextures();

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);

// ── 基准：git 里旧实现的全量线性扫，逐字拷贝（宽相的对照面）──
function bruteRaycast(w, o, d, maxT) {
  let best = maxT, hit = null;
  const bx = w.boxes;
  for (let i = 0; i < bx.length; i++) {
    const b = bx[i];
    const t = rayAABB(o.x, o.y, o.z, d.x, d.y, d.z, b, best);
    if (t >= 0 && t < best) { best = t; hit = b; }
  }
  // 地形也要进基准：被测实现把地形算进去了，基准不跟上的话每一次地形命中都会
  // 被报成"分歧"—— 那样这张表就变成了恒红的摆设，而不是差分器。
  if (w.terrain) {
    const th = w.terrain.ray(o.x, o.y, o.z, d.x, d.y, d.z, best);
    if (th) { best = th.t; hit = w._terrainHit; }
  }
  if (!hit) return null;
  const px = o.x + d.x * best, py = o.y + d.y * best, pz = o.z + d.z * best;
  const e = 0.002;
  let nx = 0, ny = 0, nz = 0;
  if (hit.terrain) {
    const g = w.terrain.grad(px, pz);
    const m = Math.hypot(g.x, 1, g.z) || 1;
    nx = -g.x / m; ny = 1 / m; nz = -g.z / m;
  }
  else if (Math.abs(px - hit.x0) < e) nx = -1; else if (Math.abs(px - hit.x1) < e) nx = 1;
  else if (Math.abs(py - hit.y0) < e) ny = -1; else if (Math.abs(py - hit.y1) < e) ny = 1;
  else if (Math.abs(pz - hit.z0) < e) nz = -1; else nz = 1;
  return { t: best, point: { x: px, y: py, z: pz }, normal: { x: nx, y: ny, z: nz }, box: hit };
}
function bruteLineBlocked(w, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const L = Math.hypot(dx, dy, dz);
  if (L < 0.01) return false;
  const ix = dx / L, iy = dy / L, iz = dz / L;
  const bx = w.boxes;
  for (let i = 0; i < bx.length; i++) {
    if (rayAABB(a.x, a.y, a.z, ix, iy, iz, bx[i], L - 0.05) >= 0) return true;
  }
  if (w.terrain && w.terrain.ray(a.x, a.y, a.z, ix, iy, iz, L - 0.05)) return true;
  return false;
}
function bruteCollide(w, pos, vel, radius, height, step = 0.45) {
  const bx = w.boxes;
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < bx.length; i++) {
      const b = bx[i];
      if (b.y1 <= pos.y + step || b.y0 >= pos.y + height) continue;
      if (pos.x + radius < b.x0 || pos.x - radius > b.x1 || pos.z + radius < b.z0 || pos.z - radius > b.z1) continue;
      const cx = clamp(pos.x, b.x0, b.x1), cz = clamp(pos.z, b.z0, b.z1);
      let dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > radius * radius) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2), push = radius - d;
        dx /= d; dz /= d;
        pos.x += dx * push; pos.z += dz * push;
        const vn = vel.x * dx + vel.z * dz;
        if (vn < 0) { vel.x -= vn * dx; vel.z -= vn * dz; }
      } else {
        const l = pos.x - b.x0, r = b.x1 - pos.x, n = pos.z - b.z0, s = b.z1 - pos.z;
        const m = Math.min(l, r, n, s);
        if (m === l) pos.x = b.x0 - radius; else if (m === r) pos.x = b.x1 + radius;
        else if (m === n) pos.z = b.z0 - radius; else pos.z = b.z1 + radius;
      }
    }
  }
  // 陡坡分级：被测实现在包络收敛之后做这一步，基准照做一次（阈值与阻力公式同
  // world.js collide 的两挡：ROLLING..STEEP 阻力、>STEEP 硬挡）。这段不属于宽相 ——
  // 它对不对由 test/terrain.mjs 的正面判据盯；这里跟做，是为了让"盒命中/推挤逐位
  // 一致"这条仍然只测宽相，不被坡度规则搅进来。
  if (w.terrain) {
    const g = w.terrain.slope(pos.x, pos.z);
    if (g > 0.42) {
      const gr = w.terrain.grad(pos.x, pos.z);
      const m = Math.hypot(gr.x, gr.z);
      if (m > 1e-9) {
        const ux = gr.x / m, uz = gr.z / m, vn = vel.x * ux + vel.z * uz;
        if (g > 0.85) {
          const pen = (g - 0.85) / g;
          pos.x -= ux * radius * pen * 2;
          pos.z -= uz * radius * pen * 2;
          if (vn > 0) { vel.x -= vn * ux; vel.z -= vn * uz; }
        } else if (vn > 0) {
          const keep = 1 - 0.9 * (g - 0.42) / (0.85 - 0.42);
          vel.x -= vn * (1 - keep) * ux;
          vel.z -= vn * (1 - keep) * uz;
        }
      }
    }
  }
}
function bruteGround(w, x, z, feetY, radius, step = 0.45) {
  let g = w.terrain ? w.terrain.height(x, z) : 0;
  const bx = w.boxes;
  const r = radius * 0.7;
  for (let i = 0; i < bx.length; i++) {
    const b = bx[i];
    if (b.y1 > feetY + step || b.y1 <= g) continue;
    if (x + r < b.x0 || x - r > b.x1 || z + r < b.z0 || z - r > b.z1) continue;
    g = b.y1;
  }
  return g;
}
function bruteCeiling(w, x, z, feetY, radius) {
  let c = Infinity;
  const r = radius * 0.7;
  for (const b of w.boxes) {
    if (b.y0 < feetY + 0.5 || b.y0 >= c) continue;
    if (x + r < b.x0 || x - r > b.x1 || z + r < b.z0 || z - r > b.z1) continue;
    c = b.y0;
  }
  return c;
}

const mkGame = () => ({
  scene: new THREE.Scene(),
  settings: { quality: 'low', maxLights: 4 },
  renderer: { toneMappingExposure: 1 },
  effects: { addFireSource: () => {} },
  time: 0,
});
const eq = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
let diverge = 0;   // 差分计数（R1 反证臂要它 > 0）

function sweep(w, tag, rnd, N, scale = 1) {
  const _t0=Date.now(); const _log=(k)=>console.error(`  [sweep ${tag}] ${k} ${Date.now()-_t0}ms`);
  const half = w.half;
  const diff = (label) => { diverge++; ok(label, false, `第 ${diverge} 处分歧`); };
  for (let i = 0; i < N.ray; i++) {
    const o = { x: (rnd() * 2 - 1) * half, y: rnd() * 8, z: (rnd() * 2 - 1) * half };
    const th = rnd() * Math.PI * 2, ph = (rnd() - 0.5) * Math.PI, sc = 0.2 + rnd() * 3;
    const d = { x: Math.cos(th) * Math.cos(ph) * sc, y: Math.sin(ph) * sc, z: Math.sin(th) * Math.cos(ph) * sc };
    const maxT = 1 + rnd() * 120;
    const h1 = bruteRaycast(w, o, d, maxT), h2 = w.raycast(o, d, maxT);
    const same = (h1 === null) === (h2 === null) && (!h1 || (eq(h1.t, h2.t) && h1.box === h2.box
      && eq(h1.point.x, h2.point.x) && eq(h1.point.y, h2.point.y) && eq(h1.point.z, h2.point.z)
      && eq(h1.normal.x, h2.normal.x) && eq(h1.normal.y, h2.normal.y) && eq(h1.normal.z, h2.normal.z)));
    if (!same) diff(`${tag} raycast 逐位一致 #${i}`);
  }
  for (let i = 0; i < N.los; i++) {
    const a = { x: (rnd() * 2 - 1) * half, y: rnd() * 6, z: (rnd() * 2 - 1) * half };
    const b = { x: (rnd() * 2 - 1) * half, y: rnd() * 6, z: (rnd() * 2 - 1) * half };
    if (bruteLineBlocked(w, a, b) !== w.lineBlocked(a, b)) diff(`${tag} lineBlocked 一致 #${i}`);
  }
  for (let i = 0; i < N.col; i++) {
    let px = (rnd() * 2 - 1) * half, pz = (rnd() * 2 - 1) * half, py = rnd() * 3;
    if (i % 2 === 1 && w.boxes.length) {           // 一半刻意塞进盒子里/盒面上
      const b = w.boxes[(rnd() * w.boxes.length) | 0];
      px = b.x0 + rnd() * (b.x1 - b.x0); pz = b.z0 + rnd() * (b.z1 - b.z0);
      py = clamp(py, Math.max(0, b.y0 - 0.5), b.y1);
    }
    const radius = [0.2, 0.35, 0.4, 0.5][(rnd() * 4) | 0], height = rnd() < 0.5 ? 1.7 : 1.8, step = rnd() < 0.5 ? 0.45 : 0.3;
    const p1 = { x: px, y: py, z: pz }, v1 = { x: (rnd() * 2 - 1) * 8, z: (rnd() * 2 - 1) * 8 };
    const p2 = { ...p1 }, v2 = { ...v1 };
    bruteCollide(w, p1, v1, radius, height, step);
    w.collide(p2, v2, radius, height, step);
    if (!(eq(p1.x, p2.x) && eq(p1.y, p2.y) && eq(p1.z, p2.z) && eq(v1.x, v2.x) && eq(v1.z, v2.z))) diff(`${tag} collide 逐位一致 #${i}`);
  }
  for (let i = 0; i < N.gc; i++) {
    const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half, feetY = rnd() * 4;
    const radius = [0.2, 0.35, 0.45][(rnd() * 3) | 0];
    if (bruteGround(w, x, z, feetY, radius) !== w.groundHeight(x, z, feetY, radius)) diff(`${tag} groundHeight 一致 #${i}`);
    if (bruteCeiling(w, x, z, feetY, radius) !== w.ceilingHeight(x, z, feetY, radius)) diff(`${tag} ceilingHeight 一致 #${i}`);
  }
  _log("前四段完成");
  // 边缘用例：原点贴盒面（内/外/正上）× 轴向/对角方向 × 几档 maxT —— 两类真 bug 都在这里
  // 这一段是**基准侧**（全量线性扫）成本最高的地方：盒数 × 6 面 × 3 eps × 8 方向 × 3 maxT
  // 每次都要两遍全量扫。大图（ridges 444 盒）跑到 27648 次组合要几分钟。
  // 所以给遍历的盒数封个顶：边缘用例的价值在"原点贴面"这个**形态**上，
  // 60~80 个盒足够覆盖各种面朝向；再多只是重复同一形态。
  const cap = Math.max(12, Math.round(64 * scale));
  const stride = Math.max(1, Math.ceil(w.boxes.length / cap));
  for (let bi = 0; bi < w.boxes.length; bi += stride) {
    const b = w.boxes[bi];
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
    for (const [fx, fy, fz] of [[b.x0, cy, cz], [b.x1, cy, cz], [cx, b.y0, cz], [cx, b.y1, cz], [cx, cy, b.z0], [cx, cy, b.z1]]) {
      for (const eps of [-1e-4, 0, 1e-4]) {
        const o = { x: fx + (fx === cx ? 0 : eps), y: fy + (fy === cy ? 0 : eps), z: fz + (fz === cz ? 0 : eps) };
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, -1, -1]]) {
          for (const maxT of [0.5, 3, 60]) {
            const d = { x: dx, y: dy, z: dz };
            const h1 = bruteRaycast(w, o, d, maxT), h2 = w.raycast(o, d, maxT);
            const same = (h1 === null) === (h2 === null) && (!h1 || (eq(h1.t, h2.t) && h1.box === h2.box
              && eq(h1.point.x, h2.point.x) && eq(h1.point.y, h2.point.y) && eq(h1.point.z, h2.point.z)
              && eq(h1.normal.x, h2.normal.x) && eq(h1.normal.y, h2.normal.y) && eq(h1.normal.z, h2.normal.z)));
            if (!same) { diff(`${tag} raycast 边缘逐位一致 bi=${bi}`); }
            const v = { x: 0, z: -2 };
            const p1 = { ...o }, p2 = { ...o }, v1 = { ...v }, v2 = { ...v };
            bruteCollide(w, p1, v1, 0.4, 1.7);
            w.collide(p2, v2, 0.4, 1.7);
            if (!(eq(p1.x, p2.x) && eq(p1.z, p2.z) && eq(v1.z, v2.z))) diff(`${tag} collide 边缘逐位一致 bi=${bi}`);
          }
        }
      }
    }
  }
}

// ── 真地图差分（dune 盒最多、kaldash 地图最大、ridges 唯一带地形）──
// ridges 的采样数比另两张少一档：它是 360m 的大图，基准侧（全量线性扫 + 逐点地形
// 射线）本身是 O(盒数 × 采样数)，按另两张的量级会跑到分钟级。
// 少一档不等于放水 —— 差异比对本身是逐位的，采样少只影响"覆盖了多少种情形"，
// 而地形那条路径另有 test/terrain.mjs 的 A/C/D 三段专门盯。
for (const id of ['dune', 'kaldash', 'ridges']) {
  const scale = id === 'ridges' ? 0.25 : 1;
  const def = MAPS[id];
  const w = new World(mkGame(), def);
  def.build(w, w.game);
  w.finalize();
  sweep(w, id, mulberry32(def.seed || 7), {
    ray: Math.round(5000 * scale), los: Math.round(2500 * scale),
    col: Math.round(3500 * scale), gc: Math.round(3500 * scale),
  }, scale);
  ok(`${id} 宽相候选确实在剪（40m 射线候选 < 盒数的 1/4）`, (() => {
    let cand = 0;
    const rnd = mulberry32(1);
    for (let i = 0; i < 200; i++) {
      const o = { x: (rnd() * 2 - 1) * w.half, y: 1.5, z: (rnd() * 2 - 1) * w.half };
      const th = rnd() * Math.PI * 2;
      w._query(o.x, o.z, o.x + Math.cos(th) * 40, o.z + Math.sin(th) * 40);
      cand += w._qOut.length;
    }
    return cand / 200 < w.boxes.length / 4;
  })(), `${w.boxes.length} 盒`);
}

// ── 对抗性：嵌套大盒（中心在盒内分支一次推出几米 → 必须走 collide 包络重试）──
{
  const def = { id: 'adv', name: 'adv', size: 40, seed: 3, env: {} };
  const w = new World(mkGame(), def);
  w.collider(-1, -1, -1, 1, 1, 1);
  w.collider(-3, -1, -3, 3, 2, 3);
  w.collider(-6, -1, -6, 6, 3, 6);
  w.collider(-20, -1, -20, 20, 0.01, 20);
  w.finalize();
  const rnd = mulberry32(9);
  let advBad = 0;
  for (let i = 0; i < 4000; i++) {
    const px = (rnd() * 2 - 1) * 8, pz = (rnd() * 2 - 1) * 8, py = rnd() * 2;
    const radius = [0.2, 0.35, 0.4][(rnd() * 3) | 0];
    const p1 = { x: px, y: py, z: pz }, v1 = { x: (rnd() * 2 - 1) * 6, z: (rnd() * 2 - 1) * 6 };
    const p2 = { ...p1 }, v2 = { ...v1 };
    bruteCollide(w, p1, v1, radius, 1.8);
    w.collide(p2, v2, radius, 1.8);
    if (!(eq(p1.x, p2.x) && eq(p1.z, p2.z) && eq(v1.x, v2.x) && eq(v1.z, v2.z))) { advBad++; diverge++; }
  }
  ok('adv 嵌套大盒：collide 包络重试路径与全量扫逐位一致', advBad === 0, `分歧 ${advBad}/4000`);
  sweep(w, 'adv', mulberry32(11), { ray: 1500, los: 800, col: 1200, gc: 1000 });
  // 闸门场景：直接 filter w.boxes（campaign.js:openGate 的形状），下一次查询必须重建
  const before = w.boxes.length;
  w.boxes = w.boxes.filter(b => b !== w.boxes[2]);
  const a = { x: 0, y: 0.5, z: 0 }, bb = { x: 10, y: 0.5, z: 0 };
  const h1 = bruteRaycast(w, a, { x: 1, y: 0, z: 0 }, 40), h2 = w.raycast(a, { x: 1, y: 0, z: 0 }, 40);
  ok('闸门删盒后重建：查询仍与全量扫一致', (h1 === null) === (h2 === null) && (h1 === null || h1.box === h2.box)
    && bruteLineBlocked(w, a, bb) === w.lineBlocked(a, bb) && w.boxes.length === before - 1);
}

// ── R1 反证臂：harness 必须真的会红 —— brute 在原世界取样后，只挪**被测实现眼里**的
// 盒面 1e-9，两次读数必须出现差（否则这套比对是恒绿的摆设）──
{
  const w = new World(mkGame(), { id: 'r1', name: 'r1', size: 20, seed: 5, env: {} });
  const b = w.collider(-1, 0, -1, 1, 2, 1);
  w.finalize();
  const o = { x: -1.3, y: 1, z: 0 }, d = { x: 1, y: 0, z: 0 };
  const h1 = bruteRaycast(w, o, d, 50);        // 原盒上的基准读数
  const saved = b.x0;
  b.x0 = saved + 1e-9;                          // 只动被测实现眼里的面
  const h2 = w.raycast(o, d, 50);
  b.x0 = saved;
  ok('R1【反证臂】差分 harness 会红：被测侧挪面 1e-9 当场被看见（不是恒绿的比对器）',
    !!h1 && !!h2 && h1.t !== h2.t && h1.box === h2.box, `t=${h1 && h1.t} vs ${h2 && h2.t}`);
  const h3 = bruteRaycast(w, o, d, 50), h4 = w.raycast(o, d, 50);
  ok('R1b 还原后两边重新一致（挪面只用于反证，不留痕）',
    !!h3 && !!h4 && h3.t === h4.t && h3.box === h4.box);
}

const bad = out.filter(([g]) => !g);

// ── 盒面有限性：非有限的盒会污染宽相格网 ──
// 踩过的坑：某张图里一个 `w.box(x, z, h, w, d, mat)` 少写了 y0 参数（box 的签名是
// (cx, y0, cz, w, h, d, mat)），参数整体错位，造出一个 z 为 NaN 的碰撞盒。
// 症状不是"那个盒子坏了"，而是**它所在那一格的 ceilingHeight/raycast 全部漏命中**
// —— 差分判据报出 6 处分歧，追下去是一张 NaN 盒。所以这里正向钉一道：
// 六张图的每一个碰撞盒，六个面都必须有限。
{
  let nanBoxes = 0, total = 0;
  for (const id of ['dune', 'frost', 'neon', 'yard', 'kaldash', 'ridges']) {
    const w = new World(mkGame(), MAPS[id]);
    MAPS[id].build(w, w.game);
    w.finalize();
    for (const b of w.boxes) {
      total++;
      if (!Number.isFinite(b.x0) || !Number.isFinite(b.y0) || !Number.isFinite(b.z0) ||
          !Number.isFinite(b.x1) || !Number.isFinite(b.y1) || !Number.isFinite(b.z1)) nanBoxes++;
    }
  }
  ok('六张图的碰撞盒面全部有限（一张 NaN 盒就会污染整格宽相，让邻域查询漏命中）',
    nanBoxes === 0, `${total} 张盒里 ${nanBoxes} 张非有限`);
  // 先决臂：得真的检查了一批盒，否则上面那条是"遍历了空集合"的恒绿
  ok('盒面检查确实覆盖了一批盒子（不是空集合）', total > 1000, `共 ${total} 张`);
}
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过（差分分歧 ${diverge} 处，R1 之外必须为 0）`);
process.exit(bad.length ? 1 : 0);
