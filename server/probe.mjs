// P0-1 探针：证明 js/ 下的同一份代码能否在 Node 里原样运行，
// 以及它构建出的关卡几何是否可复现（联机一致性的前提）。
//
//   node server/probe.mjs
//
// 三个阶段，任何一步失败都打印真实错误而不是笼统的 ok/fail。
import '../server/browser-shim.mjs';

const T = (s) => performance.now();

function stableKey(v, depth = 0) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v.toFixed(6) : String(v);
  if (t === 'boolean' || t === 'string') return JSON.stringify(v);
  if (t === 'function') return 'fn';
  if (depth > 6) return '...';
  if (Array.isArray(v)) return '[' + v.map(x => stableKey(x, depth + 1)).join(',') + ']';
  if (v && v.isObject3D) return 'obj3d:' + (v.name || v.type);
  if (v && typeof v === 'object') {
    if ('x' in v && 'y' in v && 'z' in v && Object.keys(v).length === 3) return `v(${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)})`;
    const ks = Object.keys(v).filter(k => !k.startsWith('_') && k !== 'parent' && k !== 'material' && k !== 'geometry').sort();
    return '{' + ks.map(k => k + ':' + stableKey(v[k], depth + 1)).join(',') + '}';
  }
  return String(v);
}

async function fnv(buf) {
  const bytes = new TextEncoder().encode(buf);
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

const results = [];
async function stage(label, fn) {
  const t0 = T();
  try { const r = await fn(); results.push({ stage: label, ok: true, ms: +(T() - t0).toFixed(1), info: r }); return r; }
  catch (e) { results.push({ stage: label, ok: false, ms: +(T() - t0).toFixed(1), error: e && (e.stack || e.message) }); return null; }
}

// ---------- 阶段 1：逐模块 import ----------
const MODULES = ['util', 'data', 'materials', 'textures', 'world', 'maps', 'combat', 'gunmodel', 'weapons', 'player', 'soldier', 'ai'];
import { deepRecorder } from '../server/stubs.mjs';

// 一个足够喂饱 World.setupEnvironment 的假 renderer：
// world.js:408 会写 game.renderer.toneMappingExposure，:75 读 getPixelRatio。
const fakeRenderer = () => deepRecorder('renderer', [], {
  'renderer.getPixelRatio': () => 1,
  'renderer.capabilities.getMaxAnisotropy': () => 8,
});

const mkGame = async (THREE) => {
  const { makeStubs } = await import('../server/stubs.mjs');
  const { mat } = await import('../js/materials.js');
  const s = makeStubs();
  return { scene: new THREE.Scene(), vmScene: new THREE.Scene(), vmCamera: new THREE.PerspectiveCamera(), camera: new THREE.PerspectiveCamera(), renderer: fakeRenderer(), ...s, settings: {}, entities: [], bots: [], projectiles: [], pickups: [], noises: [], mat, time: 0 };
};

const buildMap = async (id) => {
  const { World } = await import('../js/world.js');
  const { MAPS } = await import('../js/maps.js');
  const THREE = await import('three');
  const game = await mkGame(THREE);
  const def = MAPS[id];
  const w = new World(game, def);
  w.setupEnvironment(def.env);
  def.build(w, game);
  w.finalize();
  return { w, boxes: w.boxes || [], colliders: w.colliders || [] };
};

const MAP_IDS = ['dune', 'frost', 'neon', 'yard'];

const imports = await stage('1 import 每个 sim 模块', async () => {
  const out = {};
  for (const m of MODULES) {
    try { await import(`../js/${m}.js`); out[m] = 'ok'; }
    catch (e) { out[m] = 'FAIL: ' + (e.message || e).toString().slice(0, 90); }
  }
  return out;
});

// ---------- 阶段 2：程序化材质能否在无 GL 下构建 ----------
const mats = await stage('2 initTextures（15 种程序化纹理 + 全部材质）', async () => {
  const { initTextures, mat } = await import('../js/materials.js');
  const t0 = T();
  await initTextures();
  const genMs = +(T() - t0).toFixed(0);
  const probe = ['concrete', 'plaster', 'metal', 'wood', 'sandbag', 'glass', 'gunMetal', 'gunWood', 'brass', 'snow'];
  const resolved = {};
  for (const p of probe) { const m = mat(p); resolved[p] = m ? ('texScale=' + (m.userData?.texScale ?? 'MISSING')) : 'UNDEFINED'; }
  return { genMs, unresolvedMaterials: globalThis.__matMiss ? globalThis.__matMiss.size : 0, canvasesMade: globalThis.__browserShimStats().createElement, sample: resolved };
});

// ---------- 阶段 3/4：建图 + 几何可复现性 ----------
const shapeOf = (w) => { const o = {}; for (const k of Object.keys(w)) if (Array.isArray(w[k])) o[k] = w[k].length; return o; };

const sigOf = async (w) => await fnv((w.boxes || []).map(b => stableKey(b, 3)).join('|') + '##' + (w.colliders || []).map(c => stableKey(c, 3)).join('|'));

const worldA = await stage('3 构建 4 张多人地图（第一次）', async () => {
  const out = {};
  for (const id of MAP_IDS) {
    const t0 = T();
    const { w, boxes, colliders } = await buildMap(id);
    out[id] = { buildMs: +(T() - t0).toFixed(0), boxes: boxes.length, colliders: colliders.length, arrays: shapeOf(w), sig: await sigOf(w) };
  }
  return out;
});

const worldB = await stage('4 重复构建同一批地图，比对几何签名（可复现性）', async () => {
  if (!worldA) throw new Error('阶段 3 失败，无法比对');
  const out = {};
  for (const id of Object.keys(worldA)) {
    const { w } = await buildMap(id);
    out[id] = await sigOf(w);
  }
  const mismatched = Object.keys(out).filter(id => out[id] !== worldA[id].sig);
  return { perMap: out, reproducible: mismatched.length === 0, mismatched };
});

// ---------- 阶段 5：跑一个真正的 sim tick（无渲染器）----------
const simrun = await stage('5 Player + WeaponSystem 在无渲染器进程里跑 240 tick', async () => {
  if (!mats) throw new Error('阶段 2 失败');
  const THREE = await import('three');
  const { Player } = await import('../js/player.js');
  const { MAPS } = await import('../js/maps.js');
  const { w: world } = await buildMap('yard');
  const game = await mkGame(THREE);
  game.world = world;
  world.scene = game.scene;

  const pl = new Player(game, { pos: new THREE.Vector3(0, 0, 0), yaw: 0 });
  // 落位：用 World 自己的地面查询，不猜出生点数据结构
  const gy = world.groundHeight(0, 0, 50, 0.35);
  pl.pos.set(0, (Number.isFinite(gy) ? gy : 0) + 0.05, 0);
  pl.eyeSmooth = pl.pos.y + 1.62;
  pl.equip({ primary: { id: 'm4', att: { optic: 'holo', under: 'vgrip', muzzle: 'comp' } }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: ['sleight', 'doubletime'] });
  game.player = pl;

  const base = { fwd: 0, back: 0, left: 0, right: 0, sprint: false, jumpPressed: false, crouchPressed: false, pronePressed: false, fire: false, ads: false, reloadPressed: false, swapPressed: false, slot1: false, slot2: false, meleePressed: false, lethalPressed: false, lethal: false, tacticalPressed: false, tactical: false, interact: false, interactPressed: false, nvgPressed: false, streak: -1, firePressed: false, adsPressed: false, mdx: 0, mdy: 0 };
  const DT = 1 / 60;
  const trace = [];
  for (let i = 0; i < 240; i++) {
    game.time += DT;
    const inp = { ...base };
    if (i > 20 && i < 180) inp.fwd = true;
    if (i === 40) inp.crouchPressed = true;
    if (i === 90) inp.mdx = 240;
    if (i > 100 && i < 140) inp.ads = true;
    if (i > 110 && i % 5 === 0) inp.fire = true;
    if (i === 150) inp.sprint = true;
    pl.update(DT, inp);
    if (i % 40 === 0 || i === 239) trace.push({ i, x: +pl.pos.x.toFixed(5), y: +pl.pos.y.toFixed(5), z: +pl.pos.z.toFixed(5), yaw: +pl.yaw.toFixed(6), pitch: +pl.pitch.toFixed(6), eye: +pl.eyeSmooth.toFixed(5), mag: pl.ws.w ? pl.ws.w.mag : -1, state: pl.ws.state, recoilVis: +pl.ws.rp.toFixed(6) });
  }
  return { ticks: 240, finalHp: pl.hp, samples: trace };
});


// ---------- 输出 ----------
console.log('\n================ P0-1 探针结果 ================');
for (const r of results) {
  console.log(`\n[${r.ok ? 'PASS' : 'FAIL'}] ${r.stage}  (${r.ms}ms)`);
  if (!r.ok) { console.log('  ' + String(r.error).split('\n').slice(0, 6).join('\n  ')); continue; }
  if (r.info && typeof r.info === 'object') {
    for (const [k, v] of Object.entries(r.info)) console.log('  ' + k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v));
  } else console.log('  ' + JSON.stringify(r.info));
}
console.log('\n===============================================');
