// Worker 抽核判据（性能审查 C4/C5，docs/client-performance-audit.md）。
//
// textures-core（贴图生成核心）与 pathfind（A*）都要同时活在主线程与 Worker 里，
// 且 Worker 里没有 import map —— 'three' 裸说明符解析失败，所以这两个核心必须零 THREE。
// 这份判据钉三件事：
//   ① 核心确定性：同参数两次生成逐位一致（核心里不许混入 Math.random / 时钟）；
//   ② 工单完备性：initTextures 同步回退路跑完 19 种 TEX 全部就位 —— 工单表
//      （materials.js 的 texJobs）是 Worker 路与同步路唯一的数据源，漏一种就是
//      "加载屏走完但某格材质空了"；
//   ③ 寻路等价：world.findPath（两端同步路）== astarPath 直调（Worker 持格子拷贝后
//      调的就是它），路径点逐位一致、可重复；BinaryHeap 必须是同一份实现（util 转出）。
// 真浏览器端到端（Worker 真跑起来 + 被封锁时的整条回退）在 test/worker-live.mjs。
import { installBrowserShim } from '../server/browser-shim.mjs';
installBrowserShim();
const { initTextures, tex } = await import('../js/materials.js');
const { genTextureData, genCamoData } = await import('../js/textures-core.js');
const { World } = await import('../js/world.js');
const { MAPS } = await import('../js/maps.js');
const { astarPath, BinaryHeap } = await import('../js/pathfind.js');
const { BinaryHeap: BinaryHeapViaUtil } = await import('../js/util.js');
const THREE = (await import('three')).default ?? (await import('three'));

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);

// ── C4：贴图核心 ──
{
  const a = genTextureData('concrete', { rough: true });
  const b = genTextureData('concrete', { rough: true });
  ok('C4a 核心同参数两次生成逐位一致（不许混入非确定源）',
    Buffer.from(a.color).equals(Buffer.from(b.color)) && Buffer.from(a.normal).equals(Buffer.from(b.normal))
    && Buffer.from(a.rough).equals(Buffer.from(b.rough)) && a.N === b.N,
    `color=${a.color.length}B N=${a.N}`);
  const fab = genTextureData('fabric', { size: 64, normal: 1, cfg: { colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]] } });
  ok('C4b fabric 工单形状（尺寸/无粗糙度图，cfg 色板透传）',
    fab.color.length === 64 * 64 * 4 && fab.N === 64 && !fab.rough);
  const camo = genCamoData('gold');
  ok('C4c 迷彩工单形状（256²，无粗糙度图）', camo.color.length === 256 * 256 * 4 && camo.N === 256 && !camo.rough);
  // 同步回退路整条跑通：19 种 TEX 全部就位（这条同时钉住工单表完备性 —— 加种类只改
  // texJobs()，漏了这里当场红）
  await initTextures();
  const KEYS = ['concrete', 'plaster', 'brick', 'sand', 'snow', 'asphalt', 'metal', 'wood', 'crate', 'dirt', 'grass', 'rock', 'sandbag', 'tiles', 'fab_ally', 'fab_enemy', 'fab_snowA', 'fab_snowB', 'fab_urbanB'];
  const missing = KEYS.filter(k => { const t = tex(k); return !t || !t.map || !t.normalMap; });
  ok('C4d initTextures 同步路：19 种 TEX 全部就位（含 map/normalMap）', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : '');
  ok('C4e Node（无 Worker）标记为同步回退路', globalThis.__texViaWorker === false);
}

// ── C5：寻路核心 ──
{
  const mkGame = () => ({ scene: new THREE.Scene(), settings: { quality: 'low', maxLights: 4 }, renderer: { toneMappingExposure: 1 }, effects: { addFireSource: () => {} }, time: 0 });
  const def = MAPS['yard'];
  const w = new World(mkGame(), def);
  def.build(w, w.game);
  w.finalize();
  const pairs = [[-20, -20, 20, 20], [-24, 24, 24, -24], [0, 0, 25, 0], [-10, 0, 10, 1]];
  for (const [fx, fz, tx, tz] of pairs) {
    const p1 = w.findPath({ x: fx, z: fz }, { x: tx, z: tz });
    const p2 = w.findPath({ x: fx, z: fz }, { x: tx, z: tz });
    const repeat = !!p1 && !!p2 && p1.length === p2.length && p1.every((p, i) => p.x === p2[i].x && p.z === p2[i].z && p.y === 0);
    ok(`C5a yard 寻路(${fx},${fz}→${tx},${tz})可达且可重复`, repeat, p1 ? `${p1.length} 点` : 'findPath=null');
    const direct = astarPath(w.grid, w.gn, w.cs, w.half, fx, fz, tx, tz);
    const same = !!direct === !!p1 && (!direct || (direct.length === p1.length && direct.every((p, i) => p.x === p1[i].x && p.z === p1[i].z && p1[i].y === 0)));
    ok(`C5b 包装层 == astarPath 直调(${fx},${fz}→${tx},${tz})`, same);
    const copy = astarPath(w.grid.slice(), w.gn, w.cs, w.half, fx, fz, tx, tz);
    const copySame = !!copy === !!direct && (!copy || (copy.length === direct.length && copy.every((p, i) => p.x === direct[i].x && p.z === direct[i].z)));
    ok(`C5c 格子拷贝（Worker 持有的形状）结果不变(${fx},${fz}→${tx},${tz})`, copySame);
  }
  ok('C5d BinaryHeap 同一份实现（util 转出，不许抄出第二份漂移）', BinaryHeap === BinaryHeapViaUtil);
  ok('C5e 终点吸附：末点就是目标点', (() => {
    const p = w.findPath({ x: -20, z: -20 }, { x: 20, z: 20 });
    return !!p && p[p.length - 1].x === 20 && p[p.length - 1].z === 20;
  })());
  ok('C5f 起点不进路径（旧语义 out.shift() 保留）', (() => {
    const p = w.findPath({ x: -20, z: -20 }, { x: 20, z: 20 });
    return !!p && !(p[0].x === -20 && p[0].z === -20);
  })());
}

const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);
