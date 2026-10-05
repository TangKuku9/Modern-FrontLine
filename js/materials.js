// 材质库
import * as THREE from 'three';
import { genTexture, genCamo, textureFromData, getTextureSize } from './textures.js';

const TEX = {};
const MATS = {};
const CAMO = {};

const TEX_KINDS = ['concrete', 'plaster', 'brick', 'sand', 'snow', 'asphalt', 'metal', 'wood', 'crate', 'dirt', 'grass', 'rock', 'sandbag', 'tiles'];
const FABRICS = {
  fab_ally: [[150, 130, 95], [110, 100, 70], [85, 90, 60], [175, 155, 115]],
  fab_enemy: [[48, 50, 52], [32, 33, 35], [70, 68, 62], [58, 60, 64]],
  fab_snowA: [[215, 220, 225], [150, 158, 165], [110, 118, 125], [235, 238, 240]],
  fab_snowB: [[60, 64, 58], [40, 42, 38], [85, 80, 70], [52, 55, 50]],
  fab_urbanB: [[70, 30, 30], [40, 22, 22], [90, 88, 85], [55, 28, 26]],
};
const CAMO_KINDS = ['desert', 'woodland', 'digital', 'tiger', 'gold', 'dragon'];

// 贴图工单（性能审查 C4）：kind/opts 数据化 —— Worker 路与同步回退路都从这一张表
// 出发，加种类只改这里，两条路不会漂。
function texJobs() {
  const jobs = [];
  for (const k of TEX_KINDS) jobs.push({ key: k, kind: k, opts: { rough: k === 'asphalt' || k === 'metal' || k === 'tiles', normal: k === 'metal' ? 4 : 3 } });
  for (const k of Object.keys(FABRICS)) jobs.push({ key: k, kind: 'fabric', opts: { size: 256, normal: 1, cfg: { colors: FABRICS[k] } } });
  return jobs;
}

// 判据读数：真浏览器里 worker 路应置 true（test/worker-live.mjs），被封锁/回退为 false
export let texturesViaWorker = false;

export async function initTextures(progress, worker) {
  const jobs = texJobs();
  let viaWorker = false;
  if (worker) {
    // Worker 路（性能审查 C4）：逐像素循环整体在 worker 里跑，裸数组 transferable
    // 回来，这里只包 canvas。任何失败（起不来/脚本 404/生成抛错/看门狗超时）都整体
    // 退回下面的同步路 —— 同一份 textures-core，结果逐位一致，重生成是安全的。
    try {
      await new Promise((res, rej) => {
        let settled = false;
        const done = (ok2, err) => { if (!settled) { settled = true; clearTimeout(wd); ok2 ? res() : rej(err); } };
        const wd = setTimeout(() => done(false, new Error('texture worker watchdog (30s)')), 30000);
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'texOne') {
            const tex = textureFromData(m.data);
            if (m.camo) CAMO[m.key] = tex;
            else {
              TEX[m.key] = tex;
              progress && progress((m.i + 1) / jobs.length);
            }
            if (m.i + 1 === m.total) done(true);
          } else if (m.type === 'texFail') done(false, new Error(m.message || 'texture worker failed'));
        };
        worker.onerror = (e) => done(false, new Error('texture worker error: ' + (e.message || 'unknown')));
        worker.postMessage({ type: 'textures', size: getTextureSize(), jobs: [...jobs, ...CAMO_KINDS.map(c => ({ key: c, camo: c }))] });
      });
      viaWorker = true;
    } catch (e) {
      viaWorker = false;      // 回退重生成会整份覆盖 TEX/CAMO，无残留
    }
  }
  if (!viaWorker) {
    let i = 0;
    for (const j of jobs) {
      TEX[j.key] = genTexture(j.kind, j.opts);
      i++;
      progress && progress(i / jobs.length);
      await new Promise(r => setTimeout(r, 0));
    }
    for (const c of CAMO_KINDS) CAMO[c] = genCamo(c);
  }
  texturesViaWorker = viaWorker;
  if (typeof globalThis !== 'undefined') globalThis.__texViaWorker = viaWorker;
  buildMaterials();
  // Worker 活着回来了就交给调用方兼跑寻路（C5）；回退路返回 null —— 寻路也走同步
  return viaWorker ? worker : null;
}

function std(texKey, scale, params = {}) {
  const t = TEX[texKey];
  const m = new THREE.MeshStandardMaterial({
    map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap || null,
    roughness: params.roughness ?? 1, metalness: params.metalness ?? 0, color: params.color ?? 0xffffff,
  });
  if (params.normalScale) m.normalScale.set(params.normalScale, params.normalScale);
  m.userData.texScale = scale;
  return m;
}

function buildMaterials() {
  MATS.concrete = std('concrete', 3);
  MATS.concreteDark = std('concrete', 3, { color: 0x8a8a90 });
  MATS.plaster = std('plaster', 4);
  MATS.plasterWhite = std('plaster', 4, { color: 0xf2eee6 });
  MATS.plasterBlue = std('plaster', 4, { color: 0xa8c0d0 });
  MATS.plasterRed = std('plaster', 4, { color: 0xd7a38a });
  MATS.brick = std('brick', 3);
  MATS.brickDark = std('brick', 3, { color: 0x8c7a78 });
  MATS.sand = std('sand', 6);
  MATS.snow = std('snow', 6, { color: 0xd4dae2 });
  MATS.asphalt = std('asphalt', 6, { roughness: 1 });
  MATS.asphaltWet = std('asphalt', 6, { roughness: 1, color: 0x9a9aa2 });
  MATS.sidewalk = std('tiles', 3, { color: 0xa9a8a4 });
  MATS.tiles = std('tiles', 2, { color: 0xd8cfc0 });
  const mk = (c) => std('metal', 2.5, { color: c, metalness: 0.55, roughness: 1 });
  MATS.metal = mk(0xb8bcc0);
  MATS.containerRed = mk(0xa8382c);
  MATS.containerBlue = mk(0x2f5f93);
  MATS.containerGreen = mk(0x3f6b3f);
  MATS.containerOrange = mk(0xc9772b);
  MATS.containerGray = mk(0x7a7f85);
  MATS.containerYellow = mk(0xc9a52b);
  MATS.metalRoof = std('metal', 3, { color: 0x8a8f94, metalness: 0.6 });
  MATS.wood = std('wood', 2);
  MATS.crate = std('crate', 1);
  MATS.dirt = std('dirt', 5);
  MATS.grass = std('grass', 6);
  MATS.rock = std('rock', 5);
  MATS.rockSnow = std('rock', 5, { color: 0xc8ccd4 });
  MATS.sandbag = std('sandbag', 1);
  MATS.tarp = new THREE.MeshStandardMaterial({ color: 0x55603f, roughness: 0.95, side: THREE.DoubleSide });
  MATS.clothRed = new THREE.MeshStandardMaterial({ color: 0x9a2b22, roughness: 0.95, side: THREE.DoubleSide });
  MATS.clothBlue = new THREE.MeshStandardMaterial({ color: 0x2a4e7a, roughness: 0.95, side: THREE.DoubleSide });
  MATS.clothYellow = new THREE.MeshStandardMaterial({ color: 0xc49a2e, roughness: 0.95, side: THREE.DoubleSide });
  MATS.clothGreen = new THREE.MeshStandardMaterial({ color: 0x3c6a3a, roughness: 0.95, side: THREE.DoubleSide });
  MATS.darkMetal = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.5, metalness: 0.7 });
  MATS.steel = new THREE.MeshStandardMaterial({ color: 0x8e9398, roughness: 0.35, metalness: 0.9 });
  MATS.rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  // 三种握把胶带要看得出差别：橡胶 / 颗粒（浅一点更糙）/ 防滑（最暗最糙）
  MATS.gripGrain = new THREE.MeshStandardMaterial({ color: 0x33302c, roughness: 0.95, metalness: 0.05 });
  MATS.gripStip = new THREE.MeshStandardMaterial({ color: 0x1b1a19, roughness: 1.0, metalness: 0.05 });
  MATS.glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.55 });
  MATS.windowLit = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffc27a, emissiveIntensity: 1.2 });
  MATS.windowDark = new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.1, metalness: 0.8 });
  MATS.lamp = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffe0b0, emissiveIntensity: 6 });
  MATS.lampCold = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xcfe6ff, emissiveIntensity: 5 });
  MATS.fire = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff7a20, emissiveIntensity: 8 });
  MATS.leaves = new THREE.MeshStandardMaterial({ color: 0x3f5a2a, roughness: 0.9, side: THREE.DoubleSide });
  MATS.palm = new THREE.MeshStandardMaterial({ color: 0x5c7a2e, roughness: 0.85, side: THREE.DoubleSide });
  MATS.pine = new THREE.MeshStandardMaterial({ color: 0x24402e, roughness: 0.9 });
  MATS.pineSnow = new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.8 });
  MATS.trunk = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
  MATS.invisible = new THREE.MeshBasicMaterial({ visible: false });
  MATS.burnt = new THREE.MeshStandardMaterial({ color: 0x1d1a18, roughness: 0.9, metalness: 0.3 });
  MATS.yellowPaint = new THREE.MeshStandardMaterial({ color: 0xd8b21c, roughness: 0.6 });
  MATS.whitePaint = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.7 });
  MATS.redPaint = new THREE.MeshStandardMaterial({ color: 0xa02020, roughness: 0.6 });
  // 人物
  MATS.skin = new THREE.MeshStandardMaterial({ color: 0xc08a6a, roughness: 0.75 });
  MATS.skinDark = new THREE.MeshStandardMaterial({ color: 0x7a5238, roughness: 0.75 });
  MATS.glove = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.85 });
  MATS.boot = new THREE.MeshStandardMaterial({ color: 0x3a2e22, roughness: 0.85 });
  for (const k of ['fab_ally', 'fab_enemy', 'fab_snowA', 'fab_snowB', 'fab_urbanB']) {
    MATS[k] = new THREE.MeshStandardMaterial({ map: TEX[k].map, normalMap: TEX[k].normalMap, roughness: 0.95 });
  }
  // 枪械
  MATS.gunMetal = new THREE.MeshStandardMaterial({ color: 0x1e2022, roughness: 0.42, metalness: 0.75 });
  MATS.gunPoly = new THREE.MeshStandardMaterial({ color: 0x232426, roughness: 0.7, metalness: 0.1 });
  MATS.gunTan = new THREE.MeshStandardMaterial({ color: 0x9c8660, roughness: 0.7, metalness: 0.1 });
  MATS.gunGreen = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.7, metalness: 0.1 });
  MATS.gunWood = new THREE.MeshStandardMaterial({ map: TEX.wood.map, normalMap: TEX.wood.normalMap, color: 0xb06a3a, roughness: 0.55 });
  MATS.gunSteel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.25, metalness: 0.95 });
  // 瞄具镜筒：开放性管，所以要双面 —— FrontSide 的话从膛内看过去整圈壁都被剔除，
  // 玩家看到的是"没有壁"，比实心还假。判据 test/optic.mjs（O2）
  MATS.gunTube = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.4, metalness: 0.8, side: THREE.DoubleSide });
  // 眼杯（橡胶）：同样从膛内看得见，双面；比镜筒更哑光
  MATS.rubberTube = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92, metalness: 0.05, side: THREE.DoubleSide });
  // ACOG 顶上的集光光纤：白天给分划供亮的琥珀色导光管，微微自发光才读得出"是根导光条不是铁丝"
  MATS.fiberOptic = new THREE.MeshStandardMaterial({ color: 0x3a1d02, emissive: 0xff9020, emissiveIntensity: 0.5, roughness: 0.35, metalness: 0.1 });
  // 镜片两面都要看得见：开放式瞄具从枪口方向看过去也该是一块玻璃，不是通心管
  MATS.lens = new THREE.MeshStandardMaterial({ color: 0x4a7a8a, roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide });
  MATS.lensDark = new THREE.MeshStandardMaterial({ color: 0x0a1418, roughness: 0.05, metalness: 1 });
  MATS.reticle = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, depthTest: true });
  MATS.reticle.color.multiplyScalar(4);
  MATS.laserDot = new THREE.MeshBasicMaterial({ color: 0xff3030 });
  MATS.laserDot.color.multiplyScalar(6);
  MATS.brass = new THREE.MeshStandardMaterial({ color: 0xc9a040, roughness: 0.3, metalness: 1 });
  // 12 号霰弹壳是红色塑料弹体，不是黄铜
  MATS.shellRed = new THREE.MeshStandardMaterial({ color: 0x8e1a12, roughness: 0.55, metalness: 0.05 });
}

export function mat(name) { const m = MATS[name]; if (!m) { (window.__matMiss = window.__matMiss || new Set()).add(name); return MATS.concrete; } return m; }
export function tex(name) { return TEX[name]; }

const camoCache = {};
export function camoMaterial(camo, base) {
  if (!camo || camo === 'none') return base;
  // 迷彩是**叠在底材上**的。以前直接 new 一个统一材质（roughness 0.6 / metalness 0.15），
  // 于是装了迷彩的枪木托和钢机匣变成同一张贴图、同一份粗糙度 —— 一整块迷彩色块。
  // 现在以 base 克隆：金属度/粗糙度/法线都跟着底材走，只把迷彩当颜色贴图糊上去，
  // 所以 AK 的木托与机匣在迷彩下仍分得开。缓存键必须含 base，否则不同底材质会串。
  const key = camo + '@' + base.uuid;
  if (camoCache[key]) return camoCache[key];
  const m = base.clone();
  m.map = CAMO[camo].map;
  m.color = new THREE.Color(0xffffff);
  if (camo === 'gold') { m.metalness = 1; m.roughness = 0.22; }
  camoCache[key] = m;
  return m;
}

export function camoSwatch(c) {
  if (!CAMO[c]) return null;
  try { return CAMO[c].map.image.toDataURL(); } catch (e) { return null; }
}
