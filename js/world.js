// 世界：几何构建、碰撞、射线、导航网格、光照天空
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { mat } from './materials.js';
import { rayAABB, TileNoise, mulberry32, clamp, rng } from './util.js';
import { astarPath } from './pathfind.js';
import { Terrain, SLOPE } from './terrain.js';

function boxGeo(w, h, d, s) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0] / s, uv.getY(i) * dims[f][1] / s);
    }
  }
  return g;
}

const _asc = (a, b) => a - b;

// 岩石实例化的基底几何：全部岩石共享这 ROCK_VARIANTS 个形状，多样性由
// 变体 + 每块自己的旋转/缩放承担（旧做法逐块独建几何，双丘 240+ 份顶点数据和
// 240+ 个 draw call）。实例化要求**共享几何**，所以逐块随机会挪进变体里。
const ROCK_VARIANTS = 8;
const _rockBase = new Map();
function rockBaseGeo(v) {
  if (_rockBase.has(v)) return _rockBase.get(v);
  const g = new THREE.DodecahedronGeometry(1, 1);
  const p = g.attributes.position; const r = mulberry32(913 + v * 137);
  // 非索引几何里同一角点被复制了 ~6 份（432 顶点只有 74 个唯一角点），随机 k 必须
  // **按角点共享**：逐顶点独立取 k 会把共享角点撕向不同位置，岩石碎成满地三角薄片
  // （边界 3.2m 大石头裂口实测最大 1.4m，远看就是"大石头周围一片一片的碎石堆"）。
  // 量化到 1e-4：相邻面算共享棱中点时 lerp 实参顺序不同、末位浮点会差一 bit；
  // 真角点间距 ≥0.1，不会误并。判据 test/props.mjs B19。
  const kByCorner = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = p.getX(i).toFixed(4) + ',' + p.getY(i).toFixed(4) + ',' + p.getZ(i).toFixed(4);
    if (!kByCorner.has(key)) kByCorner.set(key, 0.75 + r() * 0.45);
    const k = kByCorner.get(key);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  _rockBase.set(v, g);
  return g;
}

// 小地图配色用：#rrggbb → [r,g,b]（0..255）。放模块级是因为它无状态、纯函数。
const hexRGB = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

// 「这条路有多宽到算个门」：盘山路的**墙体豁免**半宽（米）。
//
// 为什么不用 def.terrainRoadHalf：那个数（ridges 上是 30）是给**坡度**判定设计的，
// 坡度连续、放宽一点无害；但障碍是二值的 —— 30m 半宽会把营区北墙整60m 都标成
// "可走"，等于给 bot 开了一整面墙的门（实测北墙只剩 9/60 格不可走）。
// 8m 才是"路本身"的宽度：够车行，够窄到墙还在。地图可用 terrainRoadGate 覆盖。
const def_gateHalf = (def) => def.terrainRoadGate ?? 8;

export class World {
  constructor(game, def) {
    this.game = game;
    this.scene = game.scene;
    this.def = def;
    this.boxes = [];
    this.geoLists = new Map();
    // 岩石实例化队列：rock() 只记 {x,y,z,s,ry}，finalize() 按（材质|变体）分组
    // 合成 InstancedMesh —— 双丘 240+ 块岩石从 240+ 个 draw call 降到 ROCK_VARIANTS 个。
    this.rockInst = new Map();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.half = def.size / 2;
    this.spawns = { A: [], B: [], ffa: [] };
    this.flags = [];
    this.points = {};
    this.lights = [];
    this.animated = [];
    this.rng = mulberry32(def.seed || 7);
    // 地形：def.terrain 为空时 this.terrain 是 null，下面每一条查询都走原来那条分支 ——
    // 既有五张图的行为因此逐位不变（这是判据 test/world-equiv.mjs 的 A 段要盯的）。
    // 有地形时它是**唯一**的地面高度来源：ground()/那片 y=0 大平板对有地形图不再生成。
    this.terrain = def.terrain ? new Terrain(this.half, def.terrain.shape, def.terrain) : null;
    // 地形命中的替身盒：raycast 的返回结构里 box 是必填（combat.js 读 box.mat 决定
// 弹着点材质），所以给一个只带语义的轻对象。挂实例见上面的说明。
    this._terrainHit = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, mat: 'dirt', terrain: true, slope: 0 };
    // 摆件的"落地高度"偏置：无地形图恒为 0，于是既有五张图逐位不变；有地形图由
    // build() 按地面高度设它（w.baseY = w.groundY(x,z)），所有搭建助手自动跟着抬起来 ——
    // 否则房子会按 y=0 摆，在 30m 的高地上悬空一半。
    this.baseY = 0;
  }

  // 地面高度（无地形时就是 0）。摆件前先读它。
  groundY(x, z) { return this.terrain ? this.terrain.height(x, z) : 0; }
  // 把这一批摆件放到 (x,z) 的地面上。返回该处的地面高度，方便接着算相对高度。
  place(x, z) { this.baseY = this.groundY(x, z); return this.baseY; }
  // 抬到"离地多高"（摆第二层/屋顶/塔上平台时用）。
  placeAt(x, z, up = 0) { this.baseY = this.groundY(x, z) + up; return this.baseY; }
  // 建筑底面：取**足迹四角与中心的最高地面**，再往下沉 0.1m。
  //
  // 为什么不能只读中心那一点：建筑是 8~18m 见方，坡上中心比一角高 1m 时，
  // 按中心摆就会有一角悬空、一角埋进土里（判据 test/terrain.mjs B1/B2 盯这个）。
  // 取最高点保证整栋都在地面之上，代价是下坡那角最多露出一点墙基 ——
  // 与 building() 的墙同一个道理：**宁可露基，不可埋腰**。
  padTo(x, z, w = 8, d = 8) {
    let hi = -Infinity;
    for (const [dx, dz] of [[0, 0], [-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2],
      [-w / 2, 0], [w / 2, 0], [0, -d / 2], [0, d / 2]]) {
      const h = this.groundY(x + dx, z + dz);
      if (h > hi) hi = h;
    }
    this.baseY = hi - 0.1;
    return this.baseY;
  }

  // ---------- 基础构建 ----------
  box(cx, y0, cz, w, h, d, matName = 'concrete', opt = {}) {
    const m = mat(matName);
    // y0 是"相对这一批摆件落地面"的高度：加上 baseY 才落到地上。无地形图 baseY=0，
    // 于是这一行对既有两张图是恒等变换（判据 test/world-equiv.mjs 的 A 段盯的就是它）。
    y0 += this.baseY;
    if (opt.visible !== false) {
      const g = boxGeo(w, h, d, opt.texScale || m.userData.texScale || 2);
      if (opt.rotY) g.rotateY(opt.rotY);
      g.translate(cx, y0 + h / 2, cz);
      if (!this.geoLists.has(m)) this.geoLists.set(m, []);
      this.geoLists.get(m).push(g);
    }
    if (opt.collide !== false) {
      let hw = w / 2, hd = d / 2;
      if (opt.rotY && Math.abs(Math.sin(opt.rotY)) > 0.7) { hw = d / 2; hd = w / 2; }
      const b = { x0: cx - hw, x1: cx + hw, y0, y1: y0 + h, z0: cz - hd, z1: cz + hd, mat: matName, pen: opt.pen };
      this.boxes.push(b);
      this._broadDirty = true;
      return b;
    }
    return null;
  }
  collider(x0, y0, z0, x1, y1, z1) {
    // 与 box() 同一套 baseY 约定：调用方写的是相对落地面。
    const b = { x0, y0: y0 + this.baseY, z0, x1, y1: y1 + this.baseY, z1 };
    this.boxes.push(b); this._broadDirty = true; return b;
  }
  mesh(geo, matName, x, y, z, opt = {}) {
    const m = new THREE.Mesh(geo, typeof matName === 'string' ? mat(matName) : matName);
    m.position.set(x, y + this.baseY, z);   // 同 box()：y 是相对落地面
    if (opt.rotY) m.rotation.y = opt.rotY;
    m.castShadow = opt.cast !== false; m.receiveShadow = true;
    (opt.parent || this.root).add(m);
    return m;
  }

  // 贴地墙：把一段墙切成短块，每块各自站在自己那儿的地面上。
  //
  // 为什么需要它：wall() 是一整块 box，y0 只从一个值起步。有地形时一段 70m 的围墙
  // 会横穿 2m 落差 —— 按一端摆，另一端就悬空（或整段埋进土里）。
  // 无地形图 terrain 是 null，这层直接退化成原 wall() 一次调用，行为逐位不变。
  // seg 默认 4m：一段墙取的是自己两个端点的**最高**地面，段越长、这段两端的高差就越大，
  // 于是一头浮一头埋（实测 8m 分段时围墙有一段下沉 1.62m）。4m 配取高点，
  // 两端差值落到 0.2m 量级，肉眼读不出来。
  wallBy(x0, z0, x1, z1, h, t, matName, openings = [], seg = 4) {
    if (!this.terrain) return this.wall(x0, z0, x1, z1, h, t, matName, openings, 0);
    const len = Math.hypot(x1 - x0, z1 - z0);
    // 零长/非有限：退化成一次普通 wall。早一版不挡，`gAt` 里 `u/len` 成了 0/0 = NaN，
    // 造出一个 z0/z1 全是 NaN 的盒子 —— 而 NaN 盒子进宽相格网时会污染整格，
    // 让那一带的 ceilingHeight/raycast 全部漏命中（判据 test/world-equiv.mjs
    // 在 ridges 上逮到过：6 处分歧，追下去是一张 NaN 盒）。
    if (!(len > 0.001) || !Number.isFinite(len)) return this.wall(x0, z0, x1, z1, h, t, matName, openings, 0);
    const n = Math.max(1, Math.round(len / seg));
    const horiz = Math.abs(z1 - z0) < 0.001;
    const sx = Math.min(x0, x1), sz = Math.min(z0, z1);
    // 开口按"沿墙的米"换算成分段索引，落在哪一段就从哪一段挖掉。
    const ops = openings.map(o => {
      const c = horiz ? (o.c + sx - x0) : (o.c + sz - z0);
      return { from: c - o.w / 2, to: c + o.w / 2, y0: o.y0 || 0, y1: o.y1 || 2.3 };
    }).sort((p, q) => p.from - q.from);
    for (let i = 0; i < n; i++) {
      const a = i * len / n, b = (i + 1) * len / n;
      const cx = x0 + (x1 - x0) * (a + b) / (2 * len);
      const cz = z0 + (z1 - z0) * (a + b) / (2 * len);
      // 每段的落地高度取该段**两端地面的中点**。
      //
      // 取最高点会在下坡侧整段陷进土里（实测围墙沿坡下行时下沉 1.8m，墙腰看不见）；
      // 取最低点会在上坡侧整段悬空。两者都不对 —— 取中点：一段的最大偏差被摊到
      // 两端各一半（4m 分段、下坡 1.8m 高差时约 0.9m，肉眼读不出），
      // 且**两个方向的偏差是有号的**（一段要么整体略高、要么整体略低），
      // 不会像分段取极值那样忽上忽下。
      const gAt = (u) => this.groundY(x0 + (x1 - x0) * (u / len), z0 + (z1 - z0) * (u / len));
      this.baseY = (gAt(a) + gAt(b)) / 2 - 0.15;
      // 这一段若被开口覆盖，就只建开口之外的部分
      const segOps = ops.filter(o => o.to > a && o.from < b)
        .map(o => ({ c: (Math.max(o.from, a) + Math.min(o.to, b)) / 2 - a, w: Math.min(o.to, b) - Math.max(o.from, a), y0: o.y0, y1: o.y1 }));
      if (horiz) this.wall(sx + a, z0, sx + b, z0, h, t, matName, segOps);
      else this.wall(x0, sz + a, x0, sz + b, h, t, matName, segOps);
    }
    this.baseY = 0;
  }

  // 带开口的墙 (轴对齐)
  wall(x0, z0, x1, z1, h, t, matName, openings = [], y0 = 0) {
    const horiz = Math.abs(z1 - z0) < 0.001;
    const len = horiz ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const sx = Math.min(x0, x1), sz = Math.min(z0, z1);
    const seg = (a, b, ya, yb) => {
      if (b - a < 0.01 || yb - ya < 0.01) return;
      const c = (a + b) / 2;
      if (horiz) this.box(sx + c, y0 + ya, z0, b - a, yb - ya, t, matName);
      else this.box(x0, y0 + ya, sz + c, t, yb - ya, b - a, matName);
    };
    const ops = openings.map(o => ({ a: o.c - o.w / 2, b: o.c + o.w / 2, y0: o.y0 || 0, y1: o.y1 || 2.3 })).sort((p, q) => p.a - q.a);
    let cur = 0;
    for (const o of ops) {
      seg(cur, o.a, 0, h);
      seg(o.a, o.b, 0, o.y0);
      seg(o.a, o.b, o.y1, h);
      cur = o.b;
    }
    seg(cur, len, 0, h);
  }

  // 可进入建筑 doors/windows: {n:[offset...], s:[], e:[], w:[]}, offset 以墙中心为0
  // opt.baseY：建筑底面高度。缺省读 this.baseY（也就是"这一批摆件的落地面"）。
  // 有地形时**每面墙各自贴地**：12m 长的一面墙两端可能差 0.5m，按一个高度摆就会
  // 一端悬空。做法是每面墙各自算自己的落地高度，沿墙取 5 个采样点的**最高**地面：
  //
  // 为什么是最高而不是中心/平均：这面墙横跨的地面本身是斜的（兵营那面墙两端差 2m）。
  // 按中心摆 → 一头埋进土里 2m、另一头悬空 2m（实测）；按平均摆 → 两头各错 1m。
  // 取最高点则整面墙都在地面之上，代价是下坡那一头最多露出 2m 的墙基 ——
  // 而墙有 0.3m 厚度、两侧都立着，那点露出读不出来。**宁可露基，不可埋腰。**
  building(cx, cz, w, d, h, opt = {}) {
    const m = opt.mat || 'plaster', t = 0.3;
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const ground = this.terrain;
// 建筑底面高度：取整栋足迹上地面的**最高**点（墙的水平基准线取最高点，
  // 低于它的部分由勒脚填上）。
  //
  // 为什么取最高点：墙是竖直的一片，若按中心或最低点摆，下坡侧会整段悬空
  // —— 实测一栋 9×7.5m 的兵营压在 1.4m 高差上时，下坡侧墙脚能浮空 1.3m，
  // 从外面看就是"房子没落地"。
  const wallY = (ax, az, bx, bz) => {
    if (!ground) return this.baseY;
    let hi = -Infinity;
    for (let i = 0; i <= 4; i++) {
      const s = i / 4;
      const g = ground.height(ax + (bx - ax) * s, az + (bz - az) * s);
      if (g > hi) hi = g;
    }
    return hi - 0.1;
  };
  // 这面墙脚下的**最低**地面：勒脚要一路填到这里，墙才不会有一角悬空。
  const wallLo = (ax, az, bx, bz) => {
    if (!ground) return this.baseY;
    let lo = Infinity;
    for (let i = 0; i <= 4; i++) {
      const s = i / 4;
      const g = ground.height(ax + (bx - ax) * s, az + (bz - az) * s);
      if (g < lo) lo = g;
    }
    return lo;
  };
  const mk = (side, len) => {
    const arr = [];
    for (const c of (opt.doors?.[side] || [])) arr.push({ c: len / 2 + c, w: 1.5, y0: 0, y1: 2.4 });
    for (const c of (opt.windows?.[side] || [])) arr.push({ c: len / 2 + c, w: 1.3, y0: 1.0, y1: 2.1 });
    return arr;
  };
  const keep = this.baseY;
  // ---- 勒脚：把每面墙脚下的地形填成水平 ----
  //
  // 这是"建筑在斜坡上怎么站着"的正解：不是让地形迁就房子（改高度场），
  // 而是**房子自己带一道混凝土基座**（真实建筑就是这么做的）。基座顶与墙底齐，
  // 底一路填到该处地面的最低点。于是任何地形起伏下房子都不会悬空，
  // 视觉上是一圈勒脚，而不是踩空的墙。
  //
  // opt.plinth:false 可关掉（无地形图默认不生成，既有五张图行为逐位不变）。
  const wantPlinth = !!ground && opt.plinth !== false;
  const plinth = (ax, az, bx, bz, t2) => {
    const top = wallY(ax, az, bx, bz);
    const bottom = wallLo(ax, az, bx, bz) - 0.25;
    const hgt = top - bottom;
    if (hgt < 0.06) return;
    this.baseY = bottom;
    const horiz = Math.abs(bz - az) < 0.001;
    if (horiz) this.box((ax + bx) / 2, 0, az, Math.abs(bx - ax), hgt, t2, opt.plinthMat || 'concreteDark', { collide: false });
    else this.box(ax, 0, (az + bz) / 2, t2, hgt, Math.abs(bz - az), opt.plinthMat || 'concreteDark', { collide: false });
  };
  if (wantPlinth) {
    plinth(x0, z0, x1, z0, t + 0.24);
    plinth(x0, z1, x1, z1, t + 0.24);
    plinth(x0, z0 + t / 2, x0, z1 - t / 2, t + 0.24);
    plinth(x1, z0 + t / 2, x1, z1 - t / 2, t + 0.24);
  }
  this.baseY = wallY(x0, z0, x1, z0); this.wall(x0, z0, x1, z0, h, t, m, mk('n', w));
    this.baseY = wallY(x0, z1, x1, z1); this.wall(x0, z1, x1, z1, h, t, m, mk('s', w));
    this.baseY = wallY(x0, z0 + t / 2, x0, z1 - t / 2); this.wall(x0, z0 + t / 2, x0, z1 - t / 2, h, t, m, mk('w', d - t));
    this.baseY = wallY(x1, z0 + t / 2, x1, z1 - t / 2); this.wall(x1, z0 + t / 2, x1, z1 - t / 2, h, t, m, mk('e', d - t));
    this.baseY = keep;
    if (opt.roof !== false) {
      this.box(cx, h, cz, w + 0.4, 0.3, d + 0.4, opt.roofMat || 'concreteDark');
      if (opt.parapet) {
        const pm = opt.roofMat || m;
        this.box(cx, h + 0.3, z0 - 0.05, w + 0.4, 0.6, 0.3, m);
        this.box(cx, h + 0.3, z1 + 0.05, w + 0.4, 0.6, 0.3, m);
        this.box(x0 - 0.05, h + 0.3, cz, 0.3, 0.6, d, m);
        this.box(x1 + 0.05, h + 0.3, cz, 0.3, 0.6, d, m);
      }
    }
    if (opt.floor !== false) this.box(cx, 0, cz, w - 0.3, 0.03, d - 0.3, opt.floor || 'tiles', { collide: false });
    if (opt.light) this.pointLight(cx, h - 0.4, cz, opt.light, 1.2, 10);
    return { x0, x1, z0, z1 };
  }

  // 圆形夯土地坪：碰撞体是**内接正八边形**，不能用外接方盒，也不能用"四条方盒拼"。
  //
  // 为什么不能用外接方盒：视觉是CylinderGeometry(r,r,h) 圆盘，早一版直接给
  // r*2 见方的盒子 —— 方盒四个角各伸到圆盘外 r*(√2-1)（r=9 时 5.5m），
  // 玩家走到圆盘外的草地上会被一堵看不见的空气墙挡住。
  //
  // 为什么"四条方盒拼八边形"也不行：判据 test/props.mjs 的 B10 抓到过 ——
  // 那种拼法的外侧两块本身就是 r 见方的方盒，圆盘外的角又各自伸出去 0.076r。
  //
  // 这里用**8 块窄条**（每块对应八边形的一条边，法向沿半径），拼出来的正是内接八边形。
  // 每块的宽度只有边长，三角函数直接算，不需要任何"近似旋转盒"。
  pad(x, z, r, h = 0.25, matName = 'concrete') {
    const keep = this.baseY;
    this.baseY = this.groundY(x, z) - 0.05;
    const m = this.mesh(new THREE.CylinderGeometry(r, r, h, 32), matName, x, h / 2, z);
    // 正八边形：顶点方向 ap，边中点方向 am（两者都从圆心算起）
    const ap = r * Math.cos(Math.PI / 8);
    const T = 0.4;                              // 盒厚（径向），够挡住玩家
    for (let k = 0; k < 8; k++) {
      const a0 = Math.PI / 8 + k * Math.PI / 4;
      const a1 = Math.PI / 8 + (k + 1) * Math.PI / 4;
      const p0x = x + Math.cos(a0) * ap, p0z = z + Math.sin(a0) * ap;
      const p1x = x + Math.cos(a1) * ap, p1z = z + Math.sin(a1) * ap;
      // 边中点 → 沿半径方向向内收 T/2，得到这条边的中心 c
      const mx = (p0x + p1x) / 2, mz = (p0z + p1z) / 2;
      const dx = mx - x, dz = mz - z;
      const d = Math.hypot(dx, dz) || 1;
      const cx = mx - dx / d * T / 2, cz = mz - dz / d * T / 2;
      // 盒的半宽：这条边在两个轴上的半投影 + 一点余量（斜边不是轴对齐的）
      const hx = Math.abs(p1x - p0x) / 2 + 0.1;
      const hz = Math.abs(p1z - p0z) / 2 + 0.1;
      this.collider(cx - hx, 0, cz - hz, cx + hx, h, cz + hz);
    }
    this.baseY = keep;
    return m;
  }

  // 实心建筑（大楼）
  block(cx, cz, w, h, d, matName = 'concrete', opt = {}) {
    this.box(cx, 0, cz, w, h, d, matName);
    if (opt.windows) {
      // 窗户面板（装饰）
      const rows = Math.floor((h - 1) / 3.2);
      const wm = opt.windowMat || 'windowDark';
      for (let r = 0; r < rows; r++) {
        const y = 1.6 + r * 3.2 + (r === 0 && opt.shopfront ? 0 : 0);
        const colsX = Math.floor(w / 3), colsZ = Math.floor(d / 3);
        for (let c = 0; c < colsX; c++) {
          const x = cx - w / 2 + (c + 0.5) * (w / colsX);
          const lit = typeof wm === 'function' ? wm() : wm;
          this.box(x, y, cz - d / 2 - 0.02, 1.4, 1.6, 0.06, lit, { collide: false });
          this.box(x, y, cz + d / 2 + 0.02, 1.4, 1.6, 0.06, typeof wm === 'function' ? wm() : wm, { collide: false });
        }
        for (let c = 0; c < colsZ; c++) {
          const z = cz - d / 2 + (c + 0.5) * (d / colsZ);
          this.box(cx - w / 2 - 0.02, y, z, 0.06, 1.6, 1.4, typeof wm === 'function' ? wm() : wm, { collide: false });
          this.box(cx + w / 2 + 0.02, y, z, 0.06, 1.6, 1.4, typeof wm === 'function' ? wm() : wm, { collide: false });
        }
      }
    }
    if (opt.roofEdge) this.box(cx, h, cz, w + 0.3, 0.4, d + 0.3, opt.roofEdge);
  }

  crate(x, z, s = 1.2, y = 0, rot = 0) {
    this.box(x, y, z, s, s, s, 'crate', { texScale: s, rotY: rot });
  }
  crateStack(x, z) {
    // 整堆按足迹取一次地面（取两只箱子覆盖范围的最高点，与 padTo 同理）：
    // 逐只按中心高度摆的话，在一小片斜坡上后一只会比前一只高 0.2m，堆就歪了。
    const keep = this.baseY;
    if (this.terrain) this.baseY = Math.max(this.groundY(x, z), this.groundY(x + 1.25, z)) - 0.1;
    this.crate(x, z, 1.2); this.crate(x + 1.25, z, 1.2); this.crate(x + 0.6, z, 1.1, 1.2, 0.3);
    this.baseY = keep;
  }
  // 集装箱：6m 长，按中心点摆在坡上会让一端沉进土里（实测入地 0.68m）。
  // 取足迹最低点当底 → 整只箱体坐在坡下沿，被土埋一截反而像真的（箱体就那样放地上）。
  container(x, z, rotY = 0, color = 'containerRed', y = 0, doorOpen = false) {
    const L = 6.06, W = 2.44, H = 2.6;
    const along = Math.abs(Math.sin(rotY)) > 0.7;
    const w = along ? W : L, d = along ? L : W;
    const keep = this.baseY;
    if (this.terrain && y === 0) {
      let lo = Infinity;
      for (const [ux, uz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, 0]]) {
        const g = this.groundY(x + ux, z + uz);
        if (g < lo) lo = g;
      }
      this.baseY = lo - 0.12;
    }
    this.box(x, y, z, w, H, d, color);
    // 顶部框架条纹
    this.box(x, y + H - 0.05, z, w + 0.04, 0.1, d + 0.04, 'darkMetal', { collide: false });
    this.box(x, y, z, w + 0.04, 0.12, d + 0.04, 'darkMetal', { collide: false });
    this.baseY = keep;
  }
  sandbags(x, z, len, rotY = 0, h = 1.2) {
    const along = Math.abs(Math.sin(rotY)) > 0.7;
    const rows = Math.round(h / 0.25);
    // 有地形时按**整条沙袋的足迹**取地面：4~5m 长的一排在坡上按中心点摆，
    // 下坡那头会整排沉进土里（实测埋 0.55m，肉眼看得见沙袋变矮一截）。
    const keep = this.baseY;
    if (this.terrain) {
      const half = len / 2 + 0.3;
      let lo = Infinity;
      for (let i = 0; i <= 4; i++) {
        const s = -half + (half * 2) * (i / 4);
        const g = along ? this.groundY(x, z + s) : this.groundY(x + s, z);
        if (g < lo) lo = g;
      }
      this.baseY = lo - 0.1;
    }
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * 0.27;
      const n = Math.floor((len - off) / 0.60);
      // 视觉。袋体 0.65×0.26×0.40（旧 0.58×0.22×0.32，用户实测"偏瘦小"）。
      // 墙高 1.2（P2b 用户拍板：站姿也能靠的胸位掩体），5 排排距 0.235 ——
      // 墙顶 ≈1.202m 只许压线不许冒出 h=1.2 碰撞盒（冒头 = 打得中看得见的袋体
      // 却没盒可撞，判据 test/props.mjs B19b/c）。
      for (let i = 0; i < n; i++) {
        const t = -len / 2 + off + 0.30 + i * 0.60;
        const g = new THREE.CapsuleGeometry(0.155, 0.34, 3, 8);
        g.rotateZ(Math.PI / 2); g.scale(1, 0.85, 1.30);
        if (along) g.rotateY(Math.PI / 2);
        const px = along ? x : x + t, pz = along ? z + t : z;
        // y 必须带 baseY：胶囊进 geoLists 是**绝对坐标**，而碰撞盒走 box() 的
        // baseY 机制 —— 有地形图（双丘）地面在 8~30m，漏了 baseY 视觉就整体
        // 埋在 y≈0~1 的地形底下，只剩看不见的碰撞盒（用户实测）。
        g.translate(px, this.baseY + r * 0.235 + 0.13, pz);
        const m = mat('sandbag');
        if (!this.geoLists.has(m)) this.geoLists.set(m, []);
        this.geoLists.get(m).push(g);
      }
    }
    this.box(x, 0, z, along ? 0.6 : len, h, along ? len : 0.6, 'sandbag', { visible: false });
    this.baseY = keep;
  }
  barrier(x, z, rotY = 0) { // 混凝土防爆墙
    const along = Math.abs(Math.sin(rotY)) > 0.7;
    this.box(x, 0, z, along ? 0.9 : 2.2, 0.35, along ? 2.2 : 0.9, 'concrete');
    this.box(x, 0.35, z, along ? 0.35 : 2.2, 2.6, along ? 2.2 : 0.35, 'concrete');
  }
  jersey(x, z, rotY = 0) {
    const along = Math.abs(Math.sin(rotY)) > 0.7;
    this.box(x, 0, z, along ? 0.6 : 3, 0.3, along ? 3 : 0.6, 'concrete');
    this.box(x, 0.3, z, along ? 0.3 : 3, 0.6, along ? 3 : 0.3, 'concrete');
  }
  car(x, z, rotY = 0, color = 0x8a1c1c, burnt = false) {
    const g = new THREE.Group();
    const paint = burnt ? mat('burnt') : new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.15 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 4.2), paint); body.position.y = 0.65;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 2.2), paint); cabin.position.set(0, 1.25, 0.2);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.42, 2.0), burnt ? mat('burnt') : mat('windowDark')); glass.position.set(0, 1.27, 0.2);
    g.add(body, cabin, glass);
    const wg = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 16); wg.rotateZ(Math.PI / 2);
    for (const [wx, wz] of [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]]) {
      const w = new THREE.Mesh(wg, mat('rubber')); w.position.set(wx, 0.34, wz); g.add(w);
    }
    const lg = new THREE.BoxGeometry(0.3, 0.12, 0.05);
    if (!burnt) {
      for (const lx of [-0.6, 0.6]) {
        const l = new THREE.Mesh(lg, mat('lampCold')); l.position.set(lx, 0.75, -2.11); g.add(l);
        const r = new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff1010, emissiveIntensity: 2 })); r.position.set(lx, 0.8, 2.11); g.add(r);
      }
    }
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.position.set(x, this.baseY, z); g.rotation.y = rotY;
    this.root.add(g);
    const along = Math.abs(Math.sin(rotY)) > 0.7;
    this.collider(x - (along ? 2.1 : 0.9), 0, z - (along ? 0.9 : 2.1), x + (along ? 2.1 : 0.9), 1.1, z + (along ? 0.9 : 2.1));
    this.collider(x - (along ? 1.1 : 0.8), 1.1, z - (along ? 0.8 : 1.1), x + (along ? 1.1 : 0.8), 1.55, z + (along ? 0.8 : 1.1));
    return g;
  }
  truck(x, z, rotY = 0, color = 0xd9d4c4) {
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 });
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, 1.8), paint); cab.position.set(0, 1.3, -1.6);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 1.2), paint); hood.position.set(0, 1.0, -2.9);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 1.82), mat('windowDark')); glass.position.set(0, 1.55, -1.6);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.3, 3.2), paint); bed.position.set(0, 0.9, 0.9);
    const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 3.2), paint); s1.position.set(-1.0, 1.3, 0.9);
    const s2 = s1.clone(); s2.position.x = 1.0;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.5, 0.08), paint); tail.position.set(0, 1.3, 2.5);
    g.add(cab, hood, glass, bed, s1, s2, tail);
    const wg = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 16); wg.rotateZ(Math.PI / 2);
    for (const [wx, wz] of [[-0.95, -2.7], [0.95, -2.7], [-0.95, 1.4], [0.95, 1.4]]) {
      const w = new THREE.Mesh(wg, mat('rubber')); w.position.set(wx, 0.42, wz); g.add(w);
    }
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 0.05), mat('lampCold'));
    hl.position.set(-0.7, 1.05, -3.52); g.add(hl); const hl2 = hl.clone(); hl2.position.x = 0.7; g.add(hl2);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.position.set(x, this.baseY, z); g.rotation.y = rotY;
    this.root.add(g);
    return g;
  }
  // 卡车碰撞体：**必须与 truck() 的建模尺寸一致**。
  //
  // 这里的 `along` 语义是"车头朝 z（长轴在 z）"，而不是"旋转了 90°"。
  // 早一版写成 `Math.abs(Math.sin(rotY)) > 0.7`（"转过 90°"），于是 truck(rotY=π/2)
  // 拿到的是 **7m 宽 × 2.1m 长** 的盒子，而视觉卡车是 **2.1m 宽 × 6.0m 长**
  // —— 两侧各有 2.5m 的纯空气挡着玩家。这是"虚空碰撞箱"的典型来源：
  // 撞到了眼睛看不见的东西。
  //
  // 尺寸取自 truck() 的实际建模：局部 x 宽 2.1（s2 侧板在 ±1.0，宽 0.08），
  // 局部 z 从 -3.5（车头保险杠）到 +2.54（尾板）= 6.04。
  truckCollider(x, z, rotY) {
    // 尺寸必须**容得下** truck() 的建模包围盒，判据 B8 直接量这一点。
    // 车体 2.1 宽 × 6.04 长，但两侧有**后视镜**，实测视觉短边 2.22m
    // —— 碰撞盒给 2.2 时两侧各差 0.01m，判据B8 报"容不下"。
    // 碰撞盒的原则是"宁可略大不可略小"：略小会让玩家的子弹/身体
    // 从后视镜那里穿过去（视觉上打中了车却没中）。
    const W = 2.3, L = 6.2, H = 1.9;
    const along = Math.abs(Math.sin(rotY)) > 0.7;   // 车头朝 x → 长轴在 x
    this.collider(
      x - (along ? L / 2 : W / 2), 0, z - (along ? W / 2 : L / 2),
      x + (along ? L / 2 : W / 2), H, z + (along ? W / 2 : L / 2));
  }
  barrel(x, z, matName = 'containerBlue', fire = false) {
    const keep = this.baseY;
    // 油桶是 0.6m 直径的圆柱，摆在坡上按中心点取高会有一半陷进土里（实测 0.6m）。
    // 取桶底覆盖范围的最高地面：宁可露出一点桶底，也别让它坐进坡里。
    if (this.terrain) this.baseY = Math.max(this.groundY(x - 0.3, z - 0.3), this.groundY(x + 0.3, z + 0.3)) - 0.1;
    const m = this.mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16), matName, x, 0.45, z);
    this.collider(x - 0.3, 0, z - 0.3, x + 0.3, 0.9, z + 0.3);
    this.baseY = keep;
    if (fire) {
      this.game.effects && this.game.effects.addFireSource(new THREE.Vector3(x, 0.95 + this.baseY, z), 0.4);
      this.pointLight(x, 1.6, z, 0xff8a3a, 2.5, 12, true);
    }
    return m;
  }
  tank(x, z, r, h, matName = 'metal') {
    this.mesh(new THREE.CylinderGeometry(r, r, h, 32), matName, x, h / 2, z);
    this.mesh(new THREE.SphereGeometry(r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), matName, x, h, z).scale.y = 0.25;
    // 碰撞：近似为内接方框 + 边角
    const s = r * 0.85;
    this.collider(x - s, 0, z - s, x + s, h, z + s);
    this.collider(x - r, 0, z - r * 0.5, x + r, h, z + r * 0.5);
    this.collider(x - r * 0.5, 0, z - r, x + r * 0.5, h, z + r);
    // 楼梯环/扶手
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.05, 0.05, 6, 32), mat('darkMetal'));
    ring.rotation.x = Math.PI / 2; ring.position.set(x, h * 0.5, z); this.root.add(ring);
  }
  pipe(x0, z0, x1, z1, y, r = 0.4, collide = true) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const g = new THREE.CylinderGeometry(r, r, len, 16);
    g.rotateZ(Math.PI / 2);
    const m = this.mesh(g, 'metal', (x0 + x1) / 2, y, (z0 + z1) / 2);
    m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    if (collide) this.collider(Math.min(x0, x1) - r, y - r, Math.min(z0, z1) - r, Math.max(x0, x1) + r, y + r, Math.max(z0, z1) + r);
    // 支架
    const n = Math.floor(len / 6);
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0.5;
      const px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t;
      this.box(px, 0, pz, 0.2, y - r, 0.2, 'darkMetal');
    }
  }
  tree(x, z, s = 1, kind = 'broad') {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.2 * s, 3 * s, 8), mat('trunk'));
    trunk.position.y = 1.5 * s; g.add(trunk);
    if (kind === 'pine' || kind === 'pineSnow') {
      for (let i = 0; i < 4; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry((1.8 - i * 0.35) * s, 2.2 * s, 9), mat(i % 2 && kind === 'pineSnow' ? 'pineSnow' : 'pine'));
        c.position.y = (2.2 + i * 1.2) * s; c.rotation.y = i; g.add(c);
      }
    } else if (kind === 'palm') {
      trunk.scale.set(0.8, 2, 0.8); trunk.position.y = 3 * s; trunk.rotation.z = 0.08;
      for (let i = 0; i < 8; i++) {
        const lg = new THREE.PlaneGeometry(0.7 * s, 3.2 * s, 1, 4);
        const pos = lg.attributes.position;
        for (let v = 0; v < pos.count; v++) { const yy = pos.getY(v) + 1.6 * s; pos.setY(v, yy); pos.setZ(v, -yy * yy * 0.12 / s); }
        lg.rotateX(-Math.PI / 2 + 0.6);
        const l = new THREE.Mesh(lg, mat('palm'));
        l.position.y = 6 * s; l.rotation.y = i / 8 * Math.PI * 2; g.add(l);
      }
    } else {
      const r = mulberry32(Math.floor(x * 13 + z * 7));
      for (let i = 0; i < 5; i++) {
        const c = new THREE.Mesh(new THREE.IcosahedronGeometry((1.1 + r() * 0.6) * s, 1), mat('leaves'));
        c.position.set((r() - 0.5) * 1.6 * s, (3.2 + r() * 1.4) * s, (r() - 0.5) * 1.6 * s); g.add(c);
      }
    }
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // 有地形时按树干的**足迹四角**取地面，而不是读中心那一点：中心高、四角低时
    // 树干会一角悬空（实测局部 0.14m 起伏 → 一角浮 0.39m、一角埋 0.06m）。
    // 树是"半埋进土里"的造型，所以取最低点、往下沉 0.1 —— 悬空比埋一点难看得多。
    const keep = this.baseY;
    if (this.terrain) {
      const rr = 0.25 * s;
      this.baseY = Math.min(
        this.groundY(x - rr, z - rr), this.groundY(x + rr, z - rr),
        this.groundY(x - rr, z + rr), this.groundY(x + rr, z + rr)) - 0.1;
    }
    g.position.set(x, this.baseY, z);
    this.root.add(g);
    this.collider(x - 0.25 * s, 0, z - 0.25 * s, x + 0.25 * s, 4 * s, z + 0.25 * s);
    this.baseY = keep;
  }
  // 岩石：碰撞体要跟着**足迹最低点**走，否则陡坡上会有一大半埋进土里。
  //
  // 为什么取最低点而不是中心：岩石本来就是"半埋在土里"的造型，可它的可视网格是以
  // 中心为原点摆的（mesh(..., x, s*0.25, z)）。碰撞体若按足迹最高点取，坡下那一半
  // 会整个陷进地形（实测山腰一块石头 4.68m 高差，埋了 3.98m）——那不是"岩石埋在
  // 土里"，是"岩石大半不见了"。
  // 建模路床：沿折线铺一条**真有几何**的路——混凝土板 + 两侧路缘裙边 + 中线虚线。
  // 顶点色路（terrainColor）只是把颜色"画"在地形上，16m 顶点网格下近看是糊的；
  // 路床是实板：横向拉平到**路中心高**（真实修路的削/填断面），裙边垂直接到地形——
  // 挖方一侧成挡墙、填方一侧成路堤，坡地上的穿模被裙边吃掉。
  // 无碰撞、不进导航（板面取断面三处地形最高值 + 12cm 抬升，脚下就是它，物理仍走
  // 地形）；折线点 [x, z, y?]，有地形时一律取地形高（视觉必须坐在真地面上）。走
  // geoLists 合并进同材质批次，不增加 draw call。判据 test/props.mjs B20d。
  roadbed(pts, halfW = 3.4, matName = 'concrete', opt = {}) {
    const LIFT = 0.12, DASH_W = 0.22, DASH_ON = 3, DASH_OFF = 3;
    // 路面板纹理放大一档（3m→6m）：3m 的混凝土拼缝在 7m 宽的路面上碎得像地砖
    const ts = (mat(matName).userData.texScale || 3) * 2;
    const tsDash = mat('plasterWhite').userData.texScale || 4;
    // 稀疏折线 → ~3m 等距采样（虚线 3m 通/3m 断正好贴着采样步长）
    const S = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / 3));
      for (let k = 0; k < n; k++) S.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
    }
    S.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
    const gY = (x, z) => (this.terrain ? this.groundY(x, z) : 0);
    const pos = [], uvs = [], idx = [];
    const dpos = [], duvs = [], didx = [];
    let dvi = 0, dist = 0, prevDist = 0;
    let slabPrev = null;                                 // 上一断面板面顶点号
    let skirtPrev = {};                                  // 每侧上一断面 top/bot 顶点号
    for (let i = 0; i < S.length; i++) {
      const [x, z] = S[i];
      const q = S[Math.min(i + 1, S.length - 1)], r = S[Math.max(i - 1, 0)];
      let tx = q[0] - r[0], tz = q[1] - r[1];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const px = -tz, pz = tx;                           // 左法线
      if (i > 0) { prevDist = dist; dist += Math.hypot(x - S[i - 1][0], z - S[i - 1][1]); }
      const lx = x + px * halfW, lz = z + pz * halfW;
      const rx = x - px * halfW, rz = z - pz * halfW;
      // 断面横向拉平，但高度取**左右缘与中心三处地形的最高值** + 抬升 —— 横坡上
      // 挖方侧的地形永远不会盖回板面（否则板面与地形穿插出拉链纹，实测西坡道）；
      // 挖出的高差交给地形自己显形，填方侧的高差由裙边接住。
      const hC = Math.max(gY(x, z), gY(lx, lz), gY(rx, rz)) + LIFT;
      // 板面：横向拉平（两侧同高）。绕向用切线左法线构造，任何走向都朝上。
      // 顶点号必须显式记 —— pos 里每断面混着 4 个裙边顶点，靠 +2 差值数会指到
      // 裙边上（实测板面退化成竖鳍三角）。
      const iL = pos.length / 3, iR = iL + 1;
      pos.push(lx, hC, lz, rx, hC, rz);
      uvs.push(dist / ts, halfW / ts, dist / ts, -halfW / ts);
      if (slabPrev) idx.push(slabPrev.L, iL, slabPrev.R, slabPrev.R, iL, iR);
      slabPrev = { L: iL, R: iR };
      // 裙边：板缘垂直接到地形。挖方（地形高于板缘）= 挡墙，露面朝路心；
      // 填方（地形低于板缘）= 路堤，露面朝外 —— 两种绕向都要，按 cut 翻三角。
      for (const [sgn, ex, ez] of [[1, lx, lz], [-1, rx, rz]]) {
        const hE = gY(ex, ez) + 0.02;
        const iTop = pos.length / 3, iBot = iTop + 1;
        pos.push(ex, hC, ez, ex, hE, ez);                // [0]=板缘 [1]=地形脚
        uvs.push(dist / ts, 0, dist / ts, Math.abs(hE - hC) / ts);
        const key = sgn > 0 ? 'L' : 'R', prev = skirtPrev[key];
        if (prev) {
          const cut = hE > hC + 0.01;
          const flip = (sgn > 0) !== cut;                // A 绕向法线=朝路心
          if (!flip) idx.push(prev.top, iTop, prev.bot, prev.bot, iTop, iBot);
          else idx.push(prev.top, prev.bot, iTop, prev.bot, iBot, iTop);
        }
        skirtPrev[key] = { top: iTop, bot: iBot };
      }
      // 中线虚线：3m 通 3m 断，相位跟里程走（断面起点在"通"相位才连三角形）。
      // v 向采满整张贴图 —— 条带只有 0.22m 宽，按世界尺度采样会只取到贴图底部
      // 一行像素（实测颜色与混凝土同化，虚线隐形）。
      const hD = hC + 0.02, dw = DASH_W / 2;
      dpos.push(x + px * dw, hD, z + pz * dw, x - px * dw, hD, z - pz * dw);
      duvs.push(dist / tsDash, 0, dist / tsDash, 1);
      if (i > 0 && (prevDist % (DASH_ON + DASH_OFF)) < DASH_ON) {
        didx.push(dvi - 2, dvi, dvi - 1, dvi - 1, dvi, dvi + 1);
      }
      dvi += 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (!this.geoLists.has(mat(matName))) this.geoLists.set(mat(matName), []);
    this.geoLists.get(mat(matName)).push(g);
    if (dvi) {
      const gd = new THREE.BufferGeometry();
      gd.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dpos), 3));
      gd.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(duvs), 2));
      gd.setIndex(didx);
      gd.computeVertexNormals();
      if (!this.geoLists.has(mat('plasterWhite'))) this.geoLists.set(mat('plasterWhite'), []);
      this.geoLists.get(mat('plasterWhite')).push(gd);
    }
  }
  rock(x, z, s = 1, matName = 'rock', collide = true) {
    const r = mulberry32(Math.floor(x * 31 + z * 17));
    const variant = Math.floor(r() * ROCK_VARIANTS);
    const ry = r() * 6;
    const keep = this.baseY;
    // 有地形时按足迹（1.4s 见方）取最低点，让石体坐在坡下沿——被土埋一半是它该有的样子。
    if (this.terrain) {
      const rr = s * 0.7;
      this.baseY = Math.min(
        this.groundY(x - rr, z - rr), this.groundY(x + rr, z - rr),
        this.groundY(x - rr, z + rr), this.groundY(x + rr, z + rr)) - 0.15;
    }
    // 视觉进实例化队列（finalize 合成），位置口径与旧逐块 mesh 一致：中心抬 s*0.25。
    const key = matName + '|' + variant;
    if (!this.rockInst.has(key)) this.rockInst.set(key, []);
    this.rockInst.get(key).push({ x, y: s * 0.25 + this.baseY, z, s, ry });
    if (collide) this.collider(x - s * 0.7, 0, z - s * 0.7, x + s * 0.7, s * 0.8, z + s * 0.7);
    this.baseY = keep;
  }
  lampPost(x, z, color = 0xffd8a0, rotY = 0, intensity = 18, light = true) {
    this.box(x, 0, z, 0.18, 6, 0.18, 'darkMetal');
    const ax = Math.sin(rotY) * 1.2, az = Math.cos(rotY) * 1.2;
    this.box(x + ax / 2, 5.9, z + az / 2, Math.abs(ax) + 0.12, 0.12, Math.abs(az) + 0.12, 'darkMetal', { collide: false });
    this.box(x + ax, 5.75, z + az, 0.5, 0.15, 0.5, 'lamp', { collide: false });
    if (light) this.spotLight(x + ax, 5.6, z + az, color, intensity);
  }
  pointLight(x, y, z, color, intensity, dist, flicker = false) {
    if (this.lights.length >= (this.game.settings.maxLights ?? (this.game.settings.quality === 'low' ? 4 : 10))) return null;
    const l = new THREE.PointLight(color, intensity, dist, 2);
    l.position.set(x, y, z);
    this.root.add(l); this.lights.push(l);
    if (flicker) this.animated.push(t => { l.intensity = intensity * (0.8 + Math.sin(t * 17 + x) * 0.1 + Math.random() * 0.15); });
    return l;
  }
  spotLight(x, y, z, color, intensity) {
    if (this.lights.length >= (this.game.settings.maxLights ?? (this.game.settings.quality === 'low' ? 4 : 10))) return null;
    const l = new THREE.SpotLight(color, intensity * 3, 24, 0.9, 0.6, 1.6);
    l.position.set(x, y, z); l.target.position.set(x, 0, z);
    this.root.add(l, l.target); this.lights.push(l);
    return l;
  }
  neon(x, y, z, w, h, color, rotY = 0) {
    const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 5 });
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), mat('darkMetal'));
    const tube = new THREE.Mesh(new THREE.BoxGeometry(w - 0.2, 0.08, 0.1), m); tube.position.set(0, h / 2 - 0.12, 0.05);
    const tube2 = tube.clone(); tube2.position.y = -h / 2 + 0.12;
    const vt = new THREE.Mesh(new THREE.BoxGeometry(0.08, h - 0.2, 0.1), m); vt.position.set(-w / 2 + 0.12, 0, 0.05);
    const vt2 = vt.clone(); vt2.position.x = w / 2 - 0.12;
    g.add(frame, tube, tube2, vt, vt2);
    // 文字条
    for (let i = 0; i < 3; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry((w - 0.8) * (0.5 + 0.5 * ((i * 7) % 3) / 2), 0.06, 0.1), m);
      bar.position.set(0, (i - 1) * h * 0.22, 0.05); g.add(bar);
    }
    g.position.set(x, y, z); g.rotation.y = rotY;
    this.root.add(g);
    const flick = Math.random() < 0.3;
    if (flick) this.animated.push(t => { m.emissiveIntensity = Math.sin(t * 23 + x) > 0.93 ? 0.3 : 5; });
    return g;
  }
  awning(x, z, w, d, y, matName, rotY = 0) {
    const g = new THREE.PlaneGeometry(w, d);
    const m = this.mesh(g, matName, x, y, z);
    m.rotation.set(-Math.PI / 2 + 0.25, rotY, 0, 'YXZ');
    // 支柱
    this.box(x - w / 2 + 0.1, 0, z + d / 2 - 0.1, 0.08, y - 0.1, 0.08, 'wood', { collide: false });
    this.box(x + w / 2 - 0.1, 0, z + d / 2 - 0.1, 0.08, y - 0.1, 0.08, 'wood', { collide: false });
  }
  stairs(x, z, w, len, h, dir = 'n', matName = 'concrete') {
    const n = Math.ceil(h / 0.3), sh = h / n, sl = len / n;
    for (let i = 0; i < n; i++) {
      const hh = sh * (i + 1);
      let cx = x, cz = z, bw = w, bd = sl;
      if (dir === 'n') cz = z + len / 2 - sl * (i + 0.5);
      if (dir === 's') cz = z - len / 2 + sl * (i + 0.5);
      if (dir === 'e') { bw = sl; bd = w; cx = x - len / 2 + sl * (i + 0.5); }
      if (dir === 'w') { bw = sl; bd = w; cx = x + len / 2 - sl * (i + 0.5); }
      this.box(cx, 0, cz, bw, hh, bd, matName);
    }
  }
  watchtower(x, z, h = 4) {
    // 有地形时塔腿要各自踩在脚下那一块的地面上 —— 塔立在斜坡上时，四条腿
    // 下的地面高度并不相同（早一版统一用一个 baseY，斜坡上就有腿悬空）。
    const keep = this.baseY;
    const ground = this.terrain;
    const legY = (dx, dz) => ground ? ground.height(x + dx, z + dz) - 0.2 : keep;
    for (const [dx, dz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) {
      this.baseY = legY(dx, dz);
      this.box(x + dx, 0, z + dz, 0.2, h + 1.2, 0.2, 'wood');
    }
    // 平台取四条腿最高的那点，保证平台水平（平台斜了整座塔就歪）
    this.baseY = ground ? Math.max(legY(-1.3, -1.3), legY(1.3, -1.3), legY(-1.3, 1.3), legY(1.3, 1.3)) : keep;
    this.box(x, h, z, 3.2, 0.2, 3.2, 'wood');
    this.box(x, h + 0.2, z - 1.55, 3.2, 1.0, 0.1, 'wood');
    this.box(x, h + 0.2, z + 1.55, 3.2, 1.0, 0.1, 'wood');
    this.box(x - 1.55, h + 0.2, z, 0.1, 1.0, 3.2, 'wood');
    this.box(x + 1.55, h + 0.2, z, 0.1, 1.0, 3.2, 'wood');
    this.box(x, h + 2.2, z, 3.6, 0.15, 3.6, 'metalRoof');
    // 顶棚的四根支柱：**必须有碰撞**。它们是纯装饰时（collide:false）塔顶在碰撞层
    // 里是悬空的 7.5m —— 视觉上有人托着，子弹却直接从塔顶穿过去。
    // 这是"碰撞体必须与可见结构一致"的典型：眼看不见的不等于可以穿过的。
    for (const [dx, dz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
      this.box(x + dx, h + 1.2, z + dz, 0.12, 1.0, 0.12, 'wood');
    }
    this.baseY = keep;   // 还原：调用方（build()）接着还要摆别的东西
  }
  // 军用帐篷（A 字顶）：脊线水平、**顶点朝上**、两坡斜到地面。
  //
  // 早一版是 `CylinderGeometry(w/2, w/2, d, 3, 1, true)` 加两次旋转，结果是
  // 一片**竖着的绿色三角板**（用户报"三棱柱形绿色片状物，意义不明"）：
  // 三棱柱的截面三角形在rotateZ后底边变成了**竖直边**，顶点指向水平方向。
  // 判据 B12钉这个：帐篷的脊线必须水平、顶点必须在 Y 最高处。
  //
  // 现在直接构造顶点，不再靠旋转猜 —— 少一层间接就少一类"转错方向"的 bug。
  // 截面（沿 YZ，脊线沿 Z）：
  //   (0, H)         顶点
  //   (±w/2, 0)      底边两端
  // 沿 Z 从 -d/2 到 +d/2 拉伸，再加两个三角端盖（不拉伸就是"纸片屋"）。
  tent(x, z, w, d, rotY = 0, opt = {}) {
    const H = opt.h ?? Math.max(2.2, w * 0.62);   // 脊高：太扁会趴在地上
    const hw = w / 2, hd = d / 2;
    // 8 个侧面顶点：4 个在 -hd，4 个在 +hd
    const v = [];
    for (const sz of [-hd, hd]) {
      v.push(-hw, 0, sz, hw, 0, sz, 0, H, sz);          // 底-左, 底-右, 顶
    }
    const idx = [
      0, 1, 2,            // -hd 端面
      3, 5, 4,            // +hd 端面
      0, 3, 4, 0, 4, 1,   // 左坡
      2, 5, 3, 2, 0, 5,   // 右坡
      0, 2, 5, 0, 5, 3,   // -hd 三角盖
      1, 4, 5, 1, 5, 2,   // +hd 三角盖
    ];
    const pos = new Float32Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) {
      pos[i * 3] = v[idx[i] * 3]; pos[i * 3 + 1] = v[idx[i] * 3 + 1]; pos[i * 3 + 2] = v[idx[i] * 3 + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    if (rotY) g.rotateY(rotY);
    this.mesh(g, 'tarp', x, 0, z);
    // 碰撞盒：底面贴地，**容得下**视觉包围盒（不多不少，判据 B8/B12）。
    // 帐篷是实心的（玩家进不去），所以盒就是 w × d × H。
    const along = Math.abs(Math.sin(rotY)) > 0.7;
    const ex = along ? hd : hw, ez = along ? hw : hd;
    this.collider(x - ex, 0, z - ez, x + ex, H, z + ez);
  }

  // ---------- 环境 ----------
  setupEnvironment(env) {
    const game = this.game, scene = this.scene;
    this.env = env;
    scene.fog = new THREE.FogExp2(env.fog, env.fogDensity);
    game.renderer.toneMappingExposure = env.exposure ?? 1;
    const hemi = new THREE.HemisphereLight(env.sky2 || 0xbfd6ff, env.ground || 0x6b5a45, env.hemi ?? 0.6);
    this.root.add(hemi);
    const sun = new THREE.DirectionalLight(env.sunColor, env.sun);
    const sd = new THREE.Vector3(...env.sunDir).normalize();
    this.sunDir = sd;
    sun.castShadow = true;
    const q = game.settings.quality;
    const ss = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    sun.shadow.mapSize.set(ss, ss);
    const sc = sun.shadow.camera;
    const R = Math.min(70, this.half + 10);
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = 400;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
    sun.position.copy(sd).multiplyScalar(150);
    this.root.add(sun, sun.target);
    this.sun = sun; this.hemi = hemi;
    // 天空
    let skyMesh;
    if (env.sky === 'night') {
      skyMesh = nightSky(sd, env);
    } else {
      const sky = new Sky();
      sky.scale.setScalar(1800);
      const u = sky.material.uniforms;
      u.turbidity.value = env.turbidity ?? 6; u.rayleigh.value = env.rayleigh ?? 1.5;
      // mieDirectionalG：前向散射峰值宽度（0~1，越大光晕越窄越亮）——"太阳周围
      // 一片锥形白斑"的直接旋钮。默认 0.85 是 addon 出厂值，偏宽。
      u.mieCoefficient.value = env.mie ?? 0.005; u.mieDirectionalG.value = env.mieG ?? 0.85;
      u.sunPosition.value.copy(sd);
      skyMesh = sky;
    }
    this.root.add(skyMesh);
    // 环境贴图
    const pm = new THREE.PMREMGenerator(game.renderer);
    const envScene = new THREE.Scene();
    envScene.add(skyMesh.clone());
    if (env.sky === 'night') envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 16, 8), new THREE.MeshBasicMaterial({ color: 0x070a14, side: THREE.BackSide })));
    const rt = pm.fromScene(envScene, 0.04, 0.1, 2000);
    scene.environment = rt.texture;
    scene.environmentIntensity = env.envIntensity ?? 0.6;
    this._envRT = rt; pm.dispose();
    // 远山
    if (env.mountains) this.mountains(env.mountains);
  }
  mountains(matName) {
    const n = new TileNoise(3, 64);
    const segs = 96, rIn = this.half + 60, rOut = this.half + 260;
    const g = new THREE.CylinderGeometry(rIn, rOut, 1, segs, 1, true);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
      const a = (Math.atan2(z, x) / (Math.PI * 2) + 1) % 1;
      if (y > 0) { p.setY(i, 20 + n.fbm(a, 0.3, 6, 4) * 90); }
      else p.setY(i, -1);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat(matName));
    m.material = m.material.clone(); m.material.side = THREE.DoubleSide;
    m.receiveShadow = false;
    this.root.add(m);
  }
  ground(matName, size) {
    // 有地形：那张 y=0 大平板**不能要**。它会把整个丘陵埋掉（z -fighting 且挡住坡面），
    // 地面网格改由 finalize() 按高度场生成。
    if (this.terrain) return;
    const s = size || this.def.size + 80;
    this.box(0, -1, 0, s, 1, s, matName, { texScale: mat(matName).userData.texScale });
  }
  bounds() {
    const h = this.half;
    this.collider(-h - 1, -1, -h - 1, h + 1, 30, -h);
    this.collider(-h - 1, -1, h, h + 1, 30, h + 1);
    this.collider(-h - 1, -1, -h, -h, 30, h);
    this.collider(h, -1, -h, h + 1, 30, h);
  }

  finalize() {
    for (const [m, list] of this.geoLists) {
      // 移除非索引/索引差异：统一非索引
      const geos = list.map(g => g.index ? g.toNonIndexed() : g);
      geos.forEach(g => { if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); });
      const merged = mergeGeometries(geos, false);
      list.forEach(g => g.dispose());
      const mesh = new THREE.Mesh(merged, m);
      mesh.castShadow = m !== mat('sand') && m !== mat('snow');
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    this.geoLists.clear();
    // 岩石实例化：按（材质|变体）一组一个 InstancedMesh。包围球必须按实例矩阵算 ——
    // 默认包围球只包原点附近的基底网格，散到全图的实例会被视锥错误剔除（凭空消失）。
    for (const [key, list] of this.rockInst) {
      const sep = key.lastIndexOf('|');
      const im = new THREE.InstancedMesh(rockBaseGeo(+key.slice(sep + 1)), mat(key.slice(0, sep)), list.length);
      const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3();
      list.forEach((it, idx) => {
        E.set(0, it.ry, 0); Q.setFromEuler(E);
        P.set(it.x, it.y, it.z); S.setScalar(it.s);
        im.setMatrixAt(idx, M.compose(P, Q, S));
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true; im.receiveShadow = true;
      this.root.add(im);
    }
    this.rockInst.clear();
    this.buildTerrainMesh();
    this.buildGrid();
    this.buildTopDown();
  }

  // 地形网格。与 terrain.render() 的三角形一一对应 —— 采样用的面和画出来的面必须是
  // 同一张（terrain.js 开头纪律①），否则视觉与着地判定分家。
  buildTerrainMesh() {
    const T = this.terrain;
    if (!T) return;
    const cfn = this.def.terrainColor;
    const { pos, uv, idx, col } = T.render(this.def.terrainStride || 6, cfn);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    // 逐顶点色：道路与岩面靠它画出来。一条压着坡面的路没法用平板去铺（会一段段翘起来），
    // 而逐顶点色天然贴合每一张面。
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    // 基底贴图取 def.terrainBase（默认 surface）。逐顶点色是**乘**在贴图上的，
    // 所以底图要浅：拿 dirt（深棕）乘草绿会得到一片发黑的泥地（实测截图里
    // 整片丘陵糊成深褐色，起伏全读不出来）。草/土的底图 + 浅色顶点色才立得住。
    const base = mat(this.def.terrainBase || this.def.surface || 'dirt');
    const m = new THREE.Mesh(g, col ? base.clone() : base);
    if (col) { m.material.vertexColors = true; m.material.color.set(0xffffff); }
    m.castShadow = true;
    m.receiveShadow = true;
    this.root.add(m);
    this.terrainMesh = m;
  }

  update(dt, t, camPos) {
    for (const f of this.animated) f(t, dt);
    if (this.sun && camPos) {
      const tx = Math.round(camPos.x / 4) * 4, tz = Math.round(camPos.z / 4) * 4;
      this.sun.target.position.set(tx, 0, tz);
      this.sun.position.set(tx, 0, tz).addScaledVector(this.sunDir, 150);
    }
  }

  // ---------- 碰撞查询 ----------
  // 宽相（性能审查 C2）：静态盒的均匀哈希格子。查询按"查询包围盒(+裕量)覆盖的格子"取
  // 候选，**索引升序**返回 —— 五条查询的逐盒判定一字不改、顺序与全量线性扫一致，因此
  // 命中/推挤结果逐位相同（tie 也落在同一盒）。格子分派与查询都取 floor（单调），候选集
  // 是"可能命中"的超集；P=2cm 是实数↔浮点的裕量（浮点误差 ~1e-12 量级，裕量大十个数量级）。
  // 两端共用这份文件（server/headless-game.mjs 动态 import），逐位等价是预测/回滚的命根子：
  // 任何"顺手优化"判定式的改动都会让两端分叉，判据见 test/rollback / reconcile-chain / lagcomp。
  buildBroad() {
    // 格网范围取**全部盒子的联合包围盒**（不是 def.size）：地面那张大平面横跨
    // size+80 米，比任何"按地图尺寸"的格网都宽 —— 范围窄了的话，格外的查询一格
    // 都取不到，而全量扫照样命中（第一版在这里翻的车）。x/z 各有原点。
    const cs = this.bcs = 8, pad = 2;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const b of this.boxes) {
      if (b.x0 < minX) minX = b.x0; if (b.x1 > maxX) maxX = b.x1;
      if (b.z0 < minZ) minZ = b.z0; if (b.z1 > maxZ) maxZ = b.z1;
    }
    minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
    const nx = this.bnx = Math.max(1, Math.ceil((maxX - minX) / cs));
    const nz = this.bnz = Math.max(1, Math.ceil((maxZ - minZ) / cs));
    this.bx0 = minX; this.bz0 = minZ;
    const cells = this.broad = new Array(nx * nz);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const x0 = Math.floor((b.x0 - this.bx0) / cs), x1 = Math.floor((b.x1 - this.bx0) / cs);
      const z0 = Math.floor((b.z0 - this.bz0) / cs), z1 = Math.floor((b.z1 - this.bz0) / cs);
      for (let z = Math.max(0, z0); z <= Math.min(nz - 1, z1); z++)
        for (let x = Math.max(0, x0); x <= Math.min(nx - 1, x1); x++)
          cells[z * nx + x].push(i);
    }
    this._qStamp = new Int32Array(this.boxes.length);
    this._qTick = 0;
    this._qOut = [];
    // 精确贴面索引（rayAABB 的 NaN 幽灵命中兜底，见 raycast 内注释）：每轴一张
    // "面坐标 → 盒索引"表。键是精确浮点相等，Map 的 SameValueZero 恰好就是这个语义。
    const fx = this._faceX = new Map(), fy = this._faceY = new Map(), fz = this._faceZ = new Map();
    const push = (m, k, i) => { const a = m.get(k); if (a) a.push(i); else m.set(k, [i]); };
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      push(fx, b.x0, i); push(fx, b.x1, i);
      push(fy, b.y0, i); push(fy, b.y1, i);
      push(fz, b.z0, i); push(fz, b.z1, i);
    }
    this._broadLen = this.boxes.length;
    this._broadDirty = false;
  }
  // 返回候选盒**索引**的复用数组（升序、去重）。scratch 挂在实例上不挂模块级：
  // 服务端多房间各有一个 World，跨房互踩是立过账的事（快照 scratch 同款教训）。
  _query(minx, minz, maxx, maxz) {
    // 运行时增删盒子会绕过 box()/collider()（战役的闸门是直接 filter w.boxes，
    // campaign.js:openGate）—— 脏标记之外再校验一次长度，变了就重建。
    if (!this.broad || this._broadDirty || this._broadLen !== this.boxes.length) this.buildBroad();
    // Int32 戳的回绕守卫：戳写进 Int32Array 会截断，回绕后旧戳可能假阳性（重复候选）。
    if (this._qTick >= 0x7ffffffe) { this._qStamp.fill(0); this._qTick = 0; }
    const cs = this.bcs, nx = this.bnx, nz = this.bnz, P = 0.02;
    const x0 = Math.floor((minx - P - this.bx0) / cs), x1 = Math.floor((maxx + P - this.bx0) / cs);
    const z0 = Math.floor((minz - P - this.bz0) / cs), z1 = Math.floor((maxz + P - this.bz0) / cs);
    const tick = ++this._qTick, stamp = this._qStamp, out = this._qOut, cells = this.broad;
    out.length = 0;
    for (let z = z0; z <= z1; z++) {
      if (z < 0 || z >= nz) continue;
      const row = z * nx;
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || x >= nx) continue;
        const cell = cells[row + x];
        for (let j = 0; j < cell.length; j++) {
          const i = cell[j];
          if (stamp[i] !== tick) { stamp[i] = tick; out.push(i); }
        }
      }
    }
    out.sort(_asc);
    return out;
  }
  // 把"面坐标与 coord 精确相等"的盒子并进候选（通常一张都不剩）。只在对应 d 分量
  // 恰为 0 时调用 —— 平时一个 Map 查询都不付。
  _phantom(cand, map, coord) {
    const l = map.get(coord);
    if (!l) return;
    let added = false;
    for (let j = 0; j < l.length; j++) if (!cand.includes(l[j])) { cand.push(l[j]); added = true; }
    if (added) cand.sort(_asc);
  }
  raycast(o, d, maxT, ignorePen = false) {
    let best = maxT, hit = null;
    // 段包围盒（+2cm 裕量）取候选，y 范围再粗筛一道；逐盒 rayAABB 原样。
    const ex = o.x + d.x * maxT, ey = o.y + d.y * maxT, ez = o.z + d.z * maxT;
    const cand = this._query(Math.min(o.x, ex), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.z, ez));
    // NaN 幽灵命中兜底（既有行为，两端逐位共有，必须复刻而不是修）：d 某轴分量为 0
    // 时 rayAABB 走 1/0=∞，若原点坐标与某盒面**精确相等**，(0)×(∞)=NaN 毒化 tmax，
    // 之后所有比较恒 false —— 任何远处的盒子都会被判成 t=0 命中。这类盒子在空间上
    // 可以离段无限远、不认任何 slab 几何（连 y 都不认），格子取不到，只能按"贴面"
    // 精确索引进候选；且轴零射线的 y 粗筛必须整段跳过（幽灵连 y 几何都不遵守）。
    const axisZero = d.x === 0 || d.y === 0 || d.z === 0;
    if (axisZero) {
      if (d.x === 0) this._phantom(cand, this._faceX, o.x);
      if (d.y === 0) this._phantom(cand, this._faceY, o.y);
      if (d.z === 0) this._phantom(cand, this._faceZ, o.z);
    }
    const ymin = Math.min(o.y, ey) - 0.02, ymax = Math.max(o.y, ey) + 0.02;
    for (let k = 0; k < cand.length; k++) {
      const b = this.boxes[cand[k]];
      if (!axisZero && (b.y0 > ymax || b.y1 < ymin)) continue;
      const t = rayAABB(o.x, o.y, o.z, d.x, d.y, d.z, b, best);
      if (t >= 0 && t < best) { best = t; hit = b; }
    }
    // 地形：盒子全部判完之后再比一次，取更近的那个命中点。放在最后而不是穿插在
    // 循环里，是为了让**无地形图走的那条路径一个字节都不变**（best/hit 的赋值序不变）。
    if (this.terrain) {
      const th = this.terrain.ray(o.x, o.y, o.z, d.x, d.y, d.z, best);
      if (th) {
        best = th.t;
        // 地形命中盒挂实例、不挂模块级 —— 一个进程里有多个 World（服务端多房间），
        // 模块级 scratch 会被下一间房的查询当场改写，而返回值还捏在调用方手里。
        const hb = this._terrainHit;
        hb.mat = this.def.surface || 'dirt';
        hb.terrain = true; hb.slope = th.slope;
        hit = hb;
      }
    }
    if (!hit) return null;
    const px = o.x + d.x * best, py = o.y + d.y * best, pz = o.z + d.z * best;
    const e = 0.002;
    let nx = 0, ny = 0, nz = 0;
    if (hit.terrain) {
      // 地形法线取坡面梯度（指向“上坡”），与盒面那套 ±1 分量法不同源
      const g = this.terrain.grad(px, pz);
      const m = Math.hypot(g.x, 1, g.z) || 1;
      nx = -g.x / m; ny = 1 / m; nz = -g.z / m;
    }
    else if (Math.abs(px - hit.x0) < e) nx = -1; else if (Math.abs(px - hit.x1) < e) nx = 1;
    else if (Math.abs(py - hit.y0) < e) ny = -1; else if (Math.abs(py - hit.y1) < e) ny = 1;
    else if (Math.abs(pz - hit.z0) < e) nz = -1; else nz = 1;
    return { t: best, point: new THREE.Vector3(px, py, pz), normal: new THREE.Vector3(nx, ny, nz), box: hit };
  }
  // 两点之间是否有遮挡
  lineBlocked(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 0.01) return false;
    const ix = dx / L, iy = dy / L, iz = dz / L;
    const endT = L - 0.05;
    const ex = a.x + ix * endT, ey = a.y + iy * endT, ez = a.z + iz * endT;
    const cand = this._query(Math.min(a.x, ex), Math.min(a.z, ez), Math.max(a.x, ex), Math.max(a.z, ez));
    const axisZero = ix === 0 || iy === 0 || iz === 0;
    if (axisZero) {
      if (ix === 0) this._phantom(cand, this._faceX, a.x);
      if (iy === 0) this._phantom(cand, this._faceY, a.y);
      if (iz === 0) this._phantom(cand, this._faceZ, a.z);
    }
    const ymin = Math.min(a.y, ey) - 0.02, ymax = Math.max(a.y, ey) + 0.02;
    for (let k = 0; k < cand.length; k++) {
      const bx = this.boxes[cand[k]];
      if (!axisZero && (bx.y0 > ymax || bx.y1 < ymin)) continue;
      if (rayAABB(a.x, a.y, a.z, ix, iy, iz, bx, endT) >= 0) return true;
    }
    // 地形遮挡：山脊后面的人得看不见 —— 否则 bot 会隔着整座丘陵开火。
    if (this.terrain && this.terrain.ray(a.x, a.y, a.z, ix, iy, iz, endT)) return true;
    return false;
  }
  // 圆柱体与方块碰撞，修改 pos，返回是否着地
  collide(pos, vel, radius, height, step = 0.45) {
    // 候选按"入参 pos ± (radius+M)"取一轮，两轮迭代共用。陷阱：推挤会在循环中途改 pos
    // —— 原全量扫"处理到谁"取决于当时的活 pos，固定候选框可能漏掉被推出去之后才碰到的
    // 盒子。所以推挤全程记包络（min/max），出包络就还原入参、包络翻倍整轮重来 ——
    // 最终候选集收敛到全量，结果与旧实现逐位一致。正常几何一轮都出不了包络，重试是零成本。
    const ox = pos.x, oy = pos.y, oz = pos.z, ovx = vel.x, ovz = vel.z;
    // 坐标非有限就什么都别做：下面 `min/max` 包络与 `>=` 收敛判定在 NaN 下恒为 false，
    // 重试永远不会收敛（那是个永不返回的函数 —— 判据 test/world-equiv.mjs 的 col 段
    // 用"把玩家塞进盒子里"的样本撞到过，pos.z 已是 NaN 时整个判据卡死）。
    // 上层照旧处理 NaN；这里只保证不把模拟挂住。
    if (!Number.isFinite(ox) || !Number.isFinite(oz) || !Number.isFinite(oy)) return;
    let M = 1.5;
    for (;;) {
      pos.x = ox; pos.y = oy; pos.z = oz; vel.x = ovx; vel.z = ovz;
      let minX = ox, maxX = ox, minZ = oz, maxZ = oz;
      const cand = this._query(ox - radius - M, oz - radius - M, ox + radius + M, oz + radius + M);
      for (let iter = 0; iter < 2; iter++) {
        for (let k = 0; k < cand.length; k++) {
          const b = this.boxes[cand[k]];
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
            if (pos.x < minX) minX = pos.x; else if (pos.x > maxX) maxX = pos.x;
            if (pos.z < minZ) minZ = pos.z; else if (pos.z > maxZ) maxZ = pos.z;
            const vn = vel.x * dx + vel.z * dz;
            if (vn < 0) { vel.x -= vn * dx; vel.z -= vn * dz; }
          } else {
            // 中心在盒内
            const l = pos.x - b.x0, r = b.x1 - pos.x, n = pos.z - b.z0, s = b.z1 - pos.z;
            const m = Math.min(l, r, n, s);
            if (m === l) pos.x = b.x0 - radius; else if (m === r) pos.x = b.x1 + radius;
            else if (m === n) pos.z = b.z0 - radius; else pos.z = b.z1 + radius;
            if (pos.x < minX) minX = pos.x; else if (pos.x > maxX) maxX = pos.x;
            if (pos.z < minZ) minZ = pos.z; else if (pos.z > maxZ) maxZ = pos.z;
          }
        }
      }
      if (minX >= ox - M && maxX <= ox + M && minZ >= oz - M && maxZ <= oz + M) {
        // 陡坡分级（用户实测"山坡像撞墙一样卡住"后从一挡改两挡）：
        //
        //   ≤ ROLLING(0.42)       自由行走（导航网格的野地口径，一路）
        //   ROLLING..STEEP(0.85)  不挡，只吃掉部分上坡速度 —— keep 随坡度从 1
        //                         线性降到 0.1，稳态爬速大约 4.7 → 1 m/s：
        //                         缓坡只是"有点累"，贴近 STEEP 就是一步一滑的
        //                         攀爬。设计意图与逐顶点色对得上：>0.62 的坡
        //                         画成裸岩（ridges.color），裸岩可以慢慢爬，
        //                         草坡碎石坡更不在话下。
        //   > STEEP               硬挡：推回坡下 + 吃光上坡速度。真崖（全图
        //                         约 7% 面积）仍然拦人，两处高地的地形意义保留。
        //
        // 阈值为什么取 STEEP 而不是更低：导航网格给路廊放宽到 SLOPE.ROAD(0.62)
        // （buildGrid 的 roadCells），而 A* 的 LOS 平滑路点是**格子级**判定、
        // 玩家走的是**连续坐标** —— 路面接缝处同一点两套采样能差出 0.1+（实测
        // 北坡道接缝 0.25~0.70）。物理墙只压到 0.62 的话，bot 沿 A* 路线走到缝上
        // 会被自己的物理墙钉死（实测 A1→北岭在 (-51,-26)、营区→南丘在 (77,112)
        // 两处复现）。墙取 STEEP 之后，导航说能走的格子物理一定走得动，
        // "爬不上去的"只剩双方口径都公认的崖。
        //
        // **必须在入口挡掉非有限坐标**：入参 pos 若含 NaN（模拟里任何一处算错、
        // 或者外部传进来一个坏值），下面 `m > 1e-9` 对 NaN 是 false，倒不至于推挤，
        // 可 `_query(NaN…)` 拿不到候选、min/max 恒为 NaN，`>=` 比较恒 false ——
        // 于是 `for(;;)` 的收敛条件永远不成立，这个函数**永不返回**（判据
        // test/world-equiv.mjs 的 col 段撞到过：pos.z 已是 NaN 时卡死）。
        // 一次查询只要有一处坐标非有限就直接返回，让上层照旧处理 NaN，
        // 而不是在这里把整个模拟挂住。
        if (Number.isFinite(pos.x) && Number.isFinite(pos.z) && this.terrain) {
          const g = this.terrain.slope(pos.x, pos.z);
          if (g > SLOPE.ROLLING) {
            const gr = this.terrain.grad(pos.x, pos.z);
            const m = Math.hypot(gr.x, gr.z);
            if (m > 1e-9) {
              const ux = gr.x / m, uz = gr.z / m;      // 上坡单位方向
              const vn = vel.x * ux + vel.z * uz;
              if (g > SLOPE.STEEP) {
                const pen = (g - SLOPE.STEEP) / g;      // 越陡推得越远
                pos.x -= ux * radius * pen * 2;
                pos.z -= uz * radius * pen * 2;
                if (vn > 0) { vel.x -= vn * ux; vel.z -= vn * uz; }
              } else if (vn > 0) {
                // 爬坡阻力：只削上坡分量，横向与下坡不受影响。下一帧 _sim 的
                // 速度增益再把 vel 往目标拉回来，两相平衡出连续的稳态爬速 ——
                // 慢但走得动，没有任何"撞墙"点。
                const keep = 1 - 0.9 * (g - SLOPE.ROLLING) / (SLOPE.STEEP - SLOPE.ROLLING);
                vel.x -= vn * (1 - keep) * ux;
                vel.z -= vn * (1 - keep) * uz;
              }
            }
          }
        }
        return;
      }
      // 包络翻倍的重试没有上限：正常几何一轮就收敛，可一旦坐标变成 NaN/Infinity
      // 就再也收敛不了（上面已挡，但这里仍留一道上限当兜底 —— 一个永不返回的
      // 碰撞函数会挂住整个权威端，比少推一次严重得多）。
      if (M > 1e6) { pos.x = ox; pos.y = oy; pos.z = oz; vel.x = ovx; vel.z = ovz; return; }
      M *= 2;
    }
  }
  groundHeight(x, z, feetY, radius, step = 0.45) {
    // 地形是**地面本身**，不吃 step 限制 —— step 是"跨上箱子"用的，而坡面连续，
    // 逐帧高差远小于 0.45。陡坡挡人在 collide() 里做（见该函数），不靠这里夹高度：
    // 在这里夹会让玩家卡在崖脚却脚踩在坡里面（高度对不上视觉）。
    let g = this.terrain ? this.terrain.height(x, z) : 0;
    const r = radius * 0.7;
    const cand = this._query(x - r, z - r, x + r, z + r);
    for (let k = 0; k < cand.length; k++) {
      const b = this.boxes[cand[k]];
      if (b.y1 > feetY + step || b.y1 <= g) continue;
      if (x + r < b.x0 || x - r > b.x1 || z + r < b.z0 || z - r > b.z1) continue;
      g = b.y1;
    }
    return g;
  }
  ceilingHeight(x, z, feetY, radius) {
    let c = Infinity;
    const r = radius * 0.7;
    const cand = this._query(x - r, z - r, x + r, z + r);
    for (let k = 0; k < cand.length; k++) {
      const b = this.boxes[cand[k]];
      if (b.y0 < feetY + 0.5 || b.y0 >= c) continue;
      if (x + r < b.x0 || x - r > b.x1 || z + r < b.z0 || z - r > b.z1) continue;
      c = b.y0;
    }
    return c;
  }
  insideBuilding(p) { // 头顶有遮挡
    return this.ceilingHeight(p.x, p.z, p.y, 0.1) < p.y + 8;
  }

  // ---------- 导航网格 ----------
  buildGrid() {
    const cs = this.cs = 1;
    const n = this.gn = Math.ceil(this.def.size / cs);
    this.grid = new Uint8Array(n * n);
    const inf = 0.4;

    // ── 路廊表：先算出来，后面两处都要用 ──
    //
    // 盘山路是"修"出来的路：它从营区门洞穿出去、从山腰的岩壁间切过去。
    // 所以**路廊中心的墙体不该当障碍** —— 否则墙一进网格，盘山路立刻断成两截
    // （实测营区北墙把第一条路拦腰截断，17 个采样点不可走，高地成孤岛）。
    //
    // **两个半径，各管各的（这是本段最容易踩的坑）：**
    //   roadR  = terrainRoadHalf（30m）→ 给**坡度**用。坡度连续，30m 内都属于
    //            "路的过渡带"，放宽无害。
    //   gateHalf = 8m                 → 给**墙体豁免**用。障碍是二值的：
    //            30m 半宽会把营区北墙整整 60m 标成可走（实测北墙只剩 9/60
    //            不可走，等于给bot 开了一整面墙的门）。
    //
    // 8m 也不该用"采样点方块"膨胀 —— 折线按 6m 步长采样，采样点之间的墙
    // 会被漏掉豁免、而采样点附近的墙被多豁免（实测漏网段分布在 x=-34..-22、
    // -14..-6、10..14、18..22、26..34，正是采样点落点附近）。
    // 正确口径：**按格心到折线的真实距离**判定。
    const roads = this.def.terrainRoads || [];
    const roadR = this.def.terrainRoadHalf || 20;    // 坡度判定（宽）
    const gateHalf = def_gateHalf(this.def);          // 墙体豁免（窄）
    const roadCells = new Set();      // 坡度：宽（按 6m 采样方块，查表快）
    const gateCells = new Set();      // 墙体豁免：窄（按真实距离）
    // 折线段缓存：给"格心到折线距离"用
    const segList = [];
    for (const path of roads) {
      for (let i = 0; i + 1 < path.length; i++) {
        const ax = path[i][0], az = path[i][1], vx = path[i + 1][0] - ax, vz = path[i + 1][1] - az;
        const L2 = vx * vx + vz * vz;
        segList.push([ax, az, vx, vz, L2]);
        const steps = Math.max(1, Math.ceil(L2 / (6 * 6)));
        for (let s = 0; s <= steps; s++) {
          const t = steps ? s / steps : 0;
          const px = ax + vx * t, pz = az + vz * t;
          // 宽表：坡度豁免（每 6m 一格，查表比每次重算折线距离快得多）
          const i0 = Math.floor((px - roadR + this.half) / cs), i1 = Math.floor((px + roadR + this.half) / cs);
          const j0 = Math.floor((pz - roadR + this.half) / cs), j1 = Math.floor((pz + roadR + this.half) / cs);
          for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) {
            if (k >= 0 && j >= 0 && k < n && j < n) roadCells.add(j * n + k);
          }
        }
      }
    }
    // 窄表：只标"格心到某条折线段 ≤ gateHalf"的格。
    // 遍历折线段的包围盒（而不是全图），格数与折线总长成正比，不是 n²。
    if (segList.length && gateHalf > 0) {
      for (const [ax, az, vx, vz, L2] of segList) {
        const bx = ax + vx, bz = az + vz;
        const i0 = Math.floor((Math.min(ax, bx) - gateHalf + this.half) / cs);
        const i1 = Math.floor((Math.max(ax, bx) + gateHalf + this.half) / cs);
        const j0 = Math.floor((Math.min(az, bz) - gateHalf + this.half) / cs);
        const j1 = Math.floor((Math.max(az, bz) + gateHalf + this.half) / cs);
        for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) {
          if (k < 0 || j < 0 || k >= n || j >= n) continue;
          const wx = (k + 0.5) * cs - this.half, wz = (j + 0.5) * cs - this.half;
          // 点到线段的距离
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((wx - ax) * vx + (wz - az) * vz) / L2)) : 0;
          const dx = wx - (ax + vx * t), dz2 = wz - (az + vz * t);
          if (dx * dx + dz2 * dz2 <= gateHalf * gateHalf) gateCells.add(j * n + k);
        }
      }
    }

    for (const b of this.boxes) {
      // 判定"能不能挡住人"必须用**相对当地地面的高度**，不能用世界 y。
      //
      // 早一版写的是 `b.y1 <= 0.45 || b.y0 >= 1.7` —— 那是"地面在 y=0"的假设，
      // 只对无地形图成立。有地形时营区在海拔 10m 的台地上，围墙的
      // y0 = 9.9，于是 `y0 >= 1.7` 成立，**整圈围墙被当成"高处的平台"跳过**：
      // 实测营区 72×54m 内 4015 个导航格**零个**不可走，bot 直接穿墙进营区。
      //
      // 正确口径：盒底/盒顶与**当地地面**比。
      //   y0 - ground < 1.7：盒子从地面往上不到 1.7m → 人能撞到（墙、箱子、卡车）
      //   y1 - ground > 0.45：盒子底面高于地面 0.45m 以上 → 人在下面钻过
      const gy = this.terrain ? this.terrain.height((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) : 0;
      if (b.y1 - gy <= 0.45 || b.y0 - gy >= 1.7) continue;
      const ix0 = Math.floor((b.x0 - inf + this.half) / cs), ix1 = Math.floor((b.x1 + inf + this.half) / cs);
      const iz0 = Math.floor((b.z0 - inf + this.half) / cs), iz1 = Math.floor((b.z1 + inf + this.half) / cs);
      for (let z = Math.max(0, iz0); z <= Math.min(n - 1, iz1); z++)
        for (let x = Math.max(0, ix0); x <= Math.min(n - 1, ix1); x++) {
          // 细检查：单元中心是否在膨胀盒内
          const wx = (x + 0.5) * cs - this.half, wz = (z + 0.5) * cs - this.half;
          if (wx > b.x0 - inf - 0.5 && wx < b.x1 + inf + 0.5 && wz > b.z0 - inf - 0.5 && wz < b.z1 + inf + 0.5) {
            if (wx >= b.x0 - inf && wx <= b.x1 + inf && wz >= b.z0 - inf && wz <= b.z1 + inf) {
              // 路廊**中心8m** 内不封格：路是修出来的，本来就该从门洞/岩壁间穿过。
              // 用 gateCells（窄）而不是 roadCells（宽）—— 见上面那段注释。
              if (!gateCells.has(z * n + x)) this.grid[z * n + x] = 1;
            }
          }
        }
    }
    for (let i = 0; i < n; i++) { this.grid[i] = 1; this.grid[(n - 1) * n + i] = 1; this.grid[i * n] = 1; this.grid[i * n + n - 1] = 1; }
    // 坡度封锁：astarPath 只读这一个数组，所以陡坡要在这里就变成"不可走"。
    // 用格子四角的最陡值判定（取最保守的那个），免得一条 45° 的坡从格子中央穿过去。
    //
    // **路廊内用更宽的上限。** 盘山路是"修"出来的：它的坡度由shape() 里的
    // ramp() 显式指定，本来就可以比野地陡（现实里的盘山公路坡度远大于步行越野）。
    // 若对全图一律用 SLOPE.ROLLING(0.42)，那条被精心修出来的路会在导航网格里
    // 被判成断路 —— 实测两条路各有 9%~12% 的格子超限，南丘因此变成孤岛。
    // 地图通过 def.terrainRoads 声明"路在哪、半宽多少"，这里对圈内放宽到
    // SLOPE.ROAD；圈外仍守 ROLLING，玩家想抄近路爬陡坡仍然走不通。
    if (this.terrain) {
      const T = this.terrain;
      const roadSlope = SLOPE.ROAD || 0.62;
      // roadCells 已在上面算好（要给墙体豁免用），这里直接查表
      for (let z = 1; z < n - 1; z++) {
        for (let x = 1; x < n - 1; x++) {
          if (this.grid[z * n + x]) continue;
          const wx = (x + 0.5) * cs - this.half, wz = (z + 0.5) * cs - this.half;
          const d = cs * 0.5;
          const lim = roadCells.has(z * n + x) ? roadSlope : SLOPE.ROLLING;
          if (T.slope(wx - d, wz - d) > lim || T.slope(wx + d, wz - d) > lim ||
              T.slope(wx - d, wz + d) > lim || T.slope(wx + d, wz + d) > lim) {
            this.grid[z * n + x] = 1;
          }
        }
      }
    }

    // ── 出生点清场：玩家不能卡在出生点旁边 ──
    //
    // 出生平台上有沙袋、岩石这些战术物件（它们是"出生平台"的装饰）。
    // 障碍盒一旦真的进网格（见上面的"相对地面高度"修正），就可能出现
    // **某一个 spawn 格子被沙袋压住** —— 实测 A 队 (-150,18) 那个点
    // 落在主连通域外，玩家一出生就被判成"出不去"（判据 C5 报红）。
    //
    // 为什么在这里清而不是让地图别摆：地图物件是"看起来对"的（出生平台
    // 本来就该有掩体），而"每个 spawn 格子必须可达"是**硬规则**。
    // 所以让规则赢：spawn 点 1.5m 半径内的格子强制可走。
    //
    // 半径 1.5m：只清"人站的那个格"，不清出一片空地（否则掩体就不挡枪了）。
    // 只清 grid（导航），**不动 boxes（碰撞）** —— 玩家还是撞得到沙袋。
    if (this.spawns) {
      for (const list of [this.spawns.A || [], this.spawns.B || []]) {
        for (const p of list) {
          const [pix, piz] = [Math.floor((p.x + this.half) / cs), Math.floor((p.z + this.half) / cs)];
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            const x = pix + dx, z = piz + dz;
            if (x < 1 || z < 1 || x >= n - 1 || z >= n - 1) continue;
            // 圆盘形（3×3 的角上那四格不算）
            if (dx * dx + dz * dz > 2) continue;
            // 不许清掉"图缘封锁"和"真的太高/太陡"的格：那两种是硬边界
            const wx = (x + 0.5) * cs - this.half, wz = (z + 0.5) * cs - this.half;
            if (this.terrain) {
              const d = cs * 0.5;
              const lim = roadCells.has(z * n + x) ? (SLOPE.ROAD || 0.62) : SLOPE.ROLLING;
              if (this.terrain.slope(wx, wz) > lim) continue;
            }
            this.grid[z * n + x] = 0;
          }
        }
      }
    }
  }
  cellOf(x, z) { return [Math.floor((x + this.half) / this.cs), Math.floor((z + this.half) / this.cs)]; }
  walkable(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.gn && iz < this.gn && this.grid[iz * this.gn + ix] === 0; }
  randomWalkable(cx = 0, cz = 0, rad = 1e9) {
    for (let i = 0; i < 60; i++) {
      // 出生点/巡逻点/空袭落点都走这里 —— 玩法流，必须由服务端决定
      const x = cx + (rng.next() * 2 - 1) * Math.min(rad, this.half - 2), z = cz + (rng.next() * 2 - 1) * Math.min(rad, this.half - 2);
      const [ix, iz] = this.cellOf(x, z);
      if (this.walkable(ix, iz) && this.ceilingHeight(x, z, 0, 0.3) > 2) return new THREE.Vector3(x, this.terrain ? this.terrain.height(x, z) : 0, z);
    }
    return new THREE.Vector3(cx, this.terrain ? this.terrain.height(cx, cz) : 0, cz);
  }
  // 寻路本体在 pathfind.js（性能审查 C5 抽核）：那里是纯模块，寻路 Worker 装的是
  // 同一份 astarPath + 本格的拷贝 —— 两条路的路径点逐位一致，判据 test/worker-core.mjs。
  // nearestWalkable/gridLOS 随本体一起迁了过去（全仓无其他调用点；cellOf/walkable 留守，
  // ai.js 的侧向探针在用）。
  findPath(from, to) {
    const pts = astarPath(this.grid, this.gn, this.cs, this.half, from.x, from.z, to.x, to.z);
    return pts ? pts.map(p => new THREE.Vector3(p.x, 0, p.z)) : null;
  }

  // ---------- 小地图 ----------
  buildTopDown() {
    const N = 512, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(30,34,30,0.9)'; ctx.fillRect(0, 0, N, N);
    const k = N / this.def.size;
    // 地形先铺：一张没有高程的小地图在丘陵图上等于废图（两处高地看起来一样）。
    if (this.terrain) {
      const img = ctx.createImageData(N, N), d = img.data;
      const lo = this.terrain.min, hi = this.terrain.max;
      const base = hexRGB(this.def.surfaceColor || 0x6a7a4a);
      const rock = hexRGB(0xa8a294), sand = hexRGB(0xc4b489);
      this.terrain.paintHeight((px, py, y, lit, water) => {
        const t = Math.max(0, Math.min(1, (y - lo) / ((hi - lo) || 1)));
        // 高处偏岩、低处偏土；再叠一点坡向明暗让脊线读得出来
        let r = base[0] + (rock[0] - base[0]) * t, g2 = base[1] + (rock[1] - base[1]) * t, b = base[2] + (rock[2] - base[2]) * t;
        if (t < 0.18) { const k2 = (0.18 - t) / 0.18; r += (sand[0] - r) * k2; g2 += (sand[1] - g2) * k2; b += (sand[2] - b) * k2; }
        const sh = 0.72 + lit * 0.5;
        const o = (py * N + px) * 4;
        if (water) { d[o] = 40; d[o + 1] = 70; d[o + 2] = 96; }
        else { d[o] = r * sh; d[o + 1] = g2 * sh; d[o + 2] = b * sh; }
        d[o + 3] = 235;
      }, N);
      ctx.putImageData(img, 0, 0);
    }
    const sorted = [...this.boxes].filter(b => b.y1 > 0.3 && b.y1 < 40 && (b.x1 - b.x0) < this.def.size).sort((a, b) => a.y1 - b.y1);
    for (const b of sorted) {
      const v = Math.min(200, 70 + b.y1 * 12);
      ctx.fillStyle = `rgb(${v},${v},${v * 0.95})`;
      ctx.fillRect((b.x0 + this.half) * k, (b.z0 + this.half) * k, (b.x1 - b.x0) * k, (b.z1 - b.z0) * k);
    }
    this.topDown = cv; this.topK = k;
  }

  dispose() {
    this.root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
    });
    this.scene.remove(this.root);
    if (this._envRT) this._envRT.dispose();
    this.scene.environment = null;
    this.scene.fog = null;
  }
}

function nightSky(sunDir, env) {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { moon: { value: sunDir.clone() }, top: { value: new THREE.Color(env.skyTop || 0x040814) }, hor: { value: new THREE.Color(env.skyHorizon || 0x1a2238) }, glow: { value: new THREE.Color(env.cityGlow || 0x000000) } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 moon; uniform vec3 top; uniform vec3 hor; uniform vec3 glow;
      float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 c = mix(hor, top, pow(h, 0.45));
        c += glow * pow(1.0 - h, 6.0);
        vec3 sp = floor(d * 420.0);
        float s = hash(sp);
        if (s > 0.9975 && d.y > 0.05) c += vec3(0.8 + 0.2*hash(sp+1.0)) * (s - 0.9975) * 380.0 * h;
        float md = dot(d, normalize(moon));
        c += vec3(0.9,0.95,1.0) * smoothstep(0.9993, 0.9996, md) * 3.0;
        c += vec3(0.25,0.3,0.4) * pow(max(md,0.0), 60.0) * 0.4;
        if (d.y < 0.0) c = hor * 0.6;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const s = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), m);
  s.frustumCulled = false;
  return s;
}
