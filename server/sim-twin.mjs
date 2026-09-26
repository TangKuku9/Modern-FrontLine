// 同一份轨迹代码，Node 与浏览器都能跑 —— 这就是 P0 的验收装置。
//
// 它不"模拟服务器"：import 的就是游戏自己那份 js/player.js / js/weapons.js /
// js/combat.js，用固定 60Hz 步长推进，把每一步的全部 sim 状态序列化出来。
// Node 产物与浏览器产物逐 tick 相比，任何不一致都会报出首次分歧的 tick 和字段。
import { HeadlessGame, preloadMaterials } from './headless-game.mjs';
import { seedGameplayRng, resetGameplayRng, rng } from './prng.mjs';

export const DT = 1 / 60;

// 输入脚本必须是 tick 的纯函数，且与任何随机流无关
function inputAt(i) {
  const s = {
    fwd: 0, back: 0, left: 0, right: 0, sprint: false, jumpPressed: false, crouchPressed: false,
    fire: false, ads: false, reloadPressed: false, swapPressed: false, slot1: false, slot2: false,
    meleePressed: false, lethalPressed: false, lethal: false, tacticalPressed: false, tactical: false,
    interact: false, interactPressed: false, nvgPressed: false, streak: -1,
    firePressed: false, adsPressed: false, mdx: 0, mdy: 0,
  };
  if (i >= 10 && i < 200) s.fwd = 1;
  if (i >= 200 && i < 240) s.back = 1;
  if (i === 30 || i === 70) s.crouchPressed = true;
  if (i >= 40 && i < 70) { s.mdx = 3 + (i % 7); s.mdy = -1 - (i % 3); }
  if (i === 90) s.jumpPressed = true;
  if (i >= 100 && i < 190) s.ads = true;
  if (i >= 110 && i < 190 && i % 4 === 0) { s.fire = true; s.firePressed = (i % 8 === 0); }
  if (i === 150) s.reloadPressed = true;
  if (i === 210) s.sprint = true;
  if (i === 215) s.sprint = false;
  if (i === 230) { s.lethalPressed = true; s.lethal = true; }
  return s;
}

const F = (v, p = 6) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(p) : 'NaN') : String(v));

export function sampleFields() {
  // 注意：这里刻意不含 vmKick/vmRot —— 它们从 P0-2 起归 Viewmodel（js/viewmodel.js），
  // 按渲染帧衰减，不是权威状态的一部分。权威侧的对应量是 rp（写进相机俯仰）。
  return ['pos.x', 'pos.y', 'pos.z', 'vel.x', 'vel.y', 'vel.z', 'yaw', 'pitch', 'crouchT', 'eyeSmooth',
    'onGround', 'sprinting', 'sliding', 'hp', 'ws.state', 'ws.adsT', 'ws.rp', 'ws.cool',
    'ws.shotsInRow', 'ws.cur', 'mag', 'reserve', 'ws.bobPhase'];
}

export function sample(pl) {
  const ws = pl.ws, w = ws.w;
  return [
    F(pl.pos.x), F(pl.pos.y), F(pl.pos.z),
    F(pl.vel.x), F(pl.vel.y), F(pl.vel.z),
    F(pl.yaw), F(pl.pitch), F(pl.crouchT), F(pl.eyeSmooth),
    pl.onGround ? 1 : 0, pl.sprinting ? 1 : 0, pl.sliding ? 1 : 0, F(pl.hp, 3),
    ws.state, F(ws.adsT), F(ws.rp), F(ws.cool, 5),
    ws.shotsInRow, ws.cur, w ? w.mag : -1, w ? w.reserve : -1, F(ws.bobPhase, 4),
  ].join(',');
}

// 不依赖 node:crypto，Node 与浏览器同一实现，摘要才可比
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function runTrace(opts = {}) {
  const { seed = 12345, mapId = 'yard', ticks = 300, perturb = null } = opts;
  const seeded = opts.seedRandom !== false;
  if (seeded) seedGameplayRng(seed);
  const phase = {};
  const mark = (k) => { phase[k] = rng.draws; };

  const pre = await preloadMaterials();
  mark('afterMaterials');
  const game = new HeadlessGame();
  await game.loadMap(mapId);
  mark('afterLoadMap');
  const THREE = await import('three');
  const { Player } = await import('../js/player.js');

  const gy = game.world.groundHeight(0, 0, 50, 0.35);
  const pl = new Player(game, { pos: new THREE.Vector3(0, 0, 0), yaw: 0 });
  pl.pos.set(0, (Number.isFinite(gy) ? gy : 0) + 0.02, 0);
  pl.eyeSmooth = pl.pos.y + 1.62;
  pl.equip({
    primary: { id: 'ak', att: { optic: 'holo', under: 'vgrip', muzzle: 'brake', barrel: 'long' } },
    secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash',
    perks: ['sleight', 'doubletime'],
  });
  game.player = pl;
  mark('afterEquip');

  const samples = [], drawsPerTick = [];
  const t0 = Date.now();
  for (let i = 0; i < ticks; i++) {
    if (perturb) perturb(i, THREE);            // 故意改变"造了多少 three 对象"
    const before = rng.draws;
    game.step(DT, inputAt(i));
    drawsPerTick.push(rng.draws - before);
    samples.push(sample(pl));
  }
  const ms = Date.now() - t0;
  const gameplayDraws = rng.draws;        // 必须在重置流之前取，否则这里永远是 0
  if (seeded) resetGameplayRng();

  return {
    meta: {
      seed, mapId, ticks, dt: DT, seeded, msPerTick: +(ms / ticks).toFixed(4),
      materialMs: pre.ms, boxes: game.world.boxes.length, phases: phase, gameplayDraws,
    },
    samples, drawsPerTick,
    digest: fnv1a32(samples.join('\n')),
    firstSample: samples[0], lastSample: samples[ticks - 1],
  };
}

// 对局级轨迹每 10 拍才存一个样本，样本字符串带 "<tick>:" 前缀；单玩家轨迹每个 tick 一个样本、
// 不带前缀。报"首处分歧"时必须给出**真拍号**：混着样报过一次，把 760 拍报成了 76 拍
// （README 里"第 14 拍 / 第 76 拍"两处就是这么来的），排查时对着假拍号找了一圈。
function tickOf(s) {
  const m = /^(\d+):/.exec(String(s));
  return m ? +m[1] : null;
}

export function diffTraces(a, b) {
  const n = Math.min(a.samples.length, b.samples.length);
  const fields = sampleFields();
  for (let i = 0; i < n; i++) {
    if (a.samples[i] !== b.samples[i]) {
      const sa = String(a.samples[i]).split(','), sb = String(b.samples[i]).split(',');
      const changed = [];
      // 只有单玩家轨迹（字段数对得上）才给具名字段；对局级轨迹按行原样对比
      const labelable = sa.length === fields.length && sb.length === fields.length;
      for (let k = 0; k < Math.max(sa.length, sb.length); k++) {
        if (sa[k] === sb[k]) continue;
        changed.push(labelable ? fields[k] + ': ' + sa[k] + ' vs ' + sb[k] : 'field#' + k + ': ' + sa[k] + ' vs ' + sb[k]);
      }
      const tick = tickOf(a.samples[i]);
      return {
        identical: false, sampleIndex: i,
        firstDivergentTick: tick === null ? i : tick,
        atSeconds: +((tick === null ? i : tick) * DT).toFixed(3),
        changed, digestA: a.digest, digestB: b.digest,
      };
    }
  }
  return { identical: true, sampleIndex: -1, firstDivergentTick: -1, digestA: a.digest, digestB: b.digest };
}
