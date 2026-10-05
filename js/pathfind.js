// 纯导航寻路（性能审查 C5 抽核）—— **零 THREE、零 DOM**。
//
// 同一份 A* 要活在三个地方：world.findPath（两端共用的同步路）、js/worker.mjs
// （客户端离线 bot 的寻路 Worker）。Worker 里没有 import map，'three' 裸说明符
// 解析不了，所以这里只能 import rng.js（纯）；heap 从 util.js 迁来也是同一个原因
// （util 顶层 import 'three'），util.js 转出保持既有 import 不变。
// 迁移纪律：world.js findPath / gridLOS / nearestWalkable 的原文逐字搬入，
// 输出从 Vector3[] 改为裸 {x,z}[]（y 恒 0，由 world 包装层补）—— 两条路的
// 路径点必须逐位一致，判据在 test/worker-core.mjs。

export class BinaryHeap {
  constructor(score) { this.c = []; this.s = score; }
  push(e) { this.c.push(e); this._up(this.c.length - 1); }
  pop() {
    const r = this.c[0], e = this.c.pop();
    if (this.c.length) { this.c[0] = e; this._down(0); }
    return r;
  }
  get size() { return this.c.length; }
  _up(n) {
    const c = this.c, el = c[n], s = this.s(el);
    while (n > 0) {
      const p = ((n + 1) >> 1) - 1, pe = c[p];
      if (s >= this.s(pe)) break;
      c[p] = el; c[n] = pe; n = p;
    }
  }
  _down(n) {
    const c = this.c, len = c.length, el = c[n], es = this.s(el);
    while (true) {
      const r = (n + 1) << 1, l = r - 1;
      let sw = null, ls;
      if (l < len) { ls = this.s(c[l]); if (ls < es) sw = l; }
      if (r < len) { const rs = this.s(c[r]); if (rs < (sw === null ? es : ls)) sw = r; }
      if (sw === null) break;
      c[n] = c[sw]; c[sw] = el; n = sw;
    }
  }
}

// world.grid 的寻路本体。grid/gn/cs/half 是 World 建图后的四件套（Worker 拿的是
// 它的拷贝），from/to 是世界坐标。返回路径点（{x,z} 裸对象，不含起点、含终点），
// 不可达返回 null —— 与旧 world.findPath 的语义一格不差。
export function astarPath(grid, gn, cs, half, fx, fz, tx, tz) {
  const cellOf = (x, z) => [Math.floor((x + half) / cs), Math.floor((z + half) / cs)];
  const walkable = (ix, iz) => ix >= 0 && iz >= 0 && ix < gn && iz < gn && grid[iz * gn + ix] === 0;
  const nearestWalkable = (ix, iz) => {
    if (walkable(ix, iz)) return [ix, iz];
    for (let r = 1; r < 8; r++)
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++)
        if ((Math.abs(dx) === r || Math.abs(dz) === r) && walkable(ix + dx, iz + dz)) return [ix + dx, iz + dz];
    return null;
  };
  // Bresenham 走格子看两点间是否全是可走格（路径平滑用）
  const gridLOS = (ax, az, bx, bz) => {
    let x0 = ax, z0 = az; const dx = Math.abs(bx - ax), dz = Math.abs(bz - az);
    const sx = ax < bx ? 1 : -1, sz = az < bz ? 1 : -1; let err = dx - dz;
    while (true) {
      if (!walkable(x0, z0)) return false;
      if (x0 === bx && z0 === bz) return true;
      const e2 = 2 * err;
      if (e2 > -dz) { err -= dz; x0 += sx; }
      if (e2 < dx) { err += dx; z0 += sz; }
      if (e2 > -dz && e2 < dx && (!walkable(x0 - sx, z0) || !walkable(x0, z0 - sz))) return false;
    }
  };
  let s = cellOf(fx, fz), e = cellOf(tx, tz);
  s = nearestWalkable(s[0], s[1]); e = nearestWalkable(e[0], e[1]);
  if (!s || !e) return null;
  const si = s[1] * gn + s[0], ei = e[1] * gn + e[0];
  const g = new Float32Array(gn * gn).fill(1e9), par = new Int32Array(gn * gn).fill(-1), closed = new Uint8Array(gn * gn);
  const f = new Float32Array(gn * gn);
  const heap = new BinaryHeap(i => f[i]);
  g[si] = 0; f[si] = 0; heap.push(si);
  const ex = e[0], ez = e[1];
  let iter = 0, found = false;
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  while (heap.size && iter++ < 12000) {
    const c = heap.pop();
    if (c === ei) { found = true; break; }
    if (closed[c]) continue; closed[c] = 1;
    const cx = c % gn, cz = (c / gn) | 0;
    for (const [dx, dz, cost] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (!walkable(nx, nz)) continue;
      if (dx && dz && (!walkable(cx + dx, cz) || !walkable(cx, cz + dz))) continue;
      const ni = nz * gn + nx;
      if (closed[ni]) continue;
      const ng = g[c] + cost;
      if (ng < g[ni]) {
        g[ni] = ng; par[ni] = c;
        const hx = Math.abs(nx - ex), hz = Math.abs(nz - ez);
        f[ni] = ng + (hx + hz) + (1.414 - 2) * Math.min(hx, hz);
        heap.push(ni);
      }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let c = ei; c !== -1; c = par[c]) cells.push(c);
  cells.reverse();
  // 路径平滑
  const pts = [];
  let anchor = 0;
  pts.push(cells[0]);
  for (let i = 2; i < cells.length; i++) {
    const a = cells[anchor], b = cells[i];
    if (!gridLOS(a % gn, (a / gn) | 0, b % gn, (b / gn) | 0)) { anchor = i - 1; pts.push(cells[anchor]); }
  }
  pts.push(cells[cells.length - 1]);
  const out = pts.map(c => ({ x: (c % gn + 0.5) * cs - half, z: (((c / gn) | 0) + 0.5) * cs - half }));
  out.shift();
  out.push({ x: tx, z: tz });
  return out;
}
