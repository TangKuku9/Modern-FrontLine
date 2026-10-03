// P0 闸门：把"这份代码能不能联网"从观点变成数字。
//
//   node server/gate.mjs
//
// A 播种后同进程跑两次        → 必须逐 tick 全等，否则 sim 里仍有墙钟/进程态依赖
// B 中途故意多造 200 个 three 对象 → 轨迹必须仍然全等；这是 geoCache/UUID 那个
//   实测缺陷的回归测试：只要玩法流还沾 Math.random，这条一定红
// E 整场对局（9 个实体 + 计分/重生/掉落）同种子两跑与加扰动物体都必须全等
// G 权威进程里没有视图模型，且瞄具遮罩状态仍由模拟侧产出（P0-2 拆分的验收）
// C/F 落盘 Node 轨迹          → 交给浏览器跑同一份代码后跨环境比对
import './browser-shim.mjs';
import * as THREE from 'three';
import { runTrace, diffTraces, sampleFields, DT } from './sim-twin.mjs';
import { rng, seedGameplayRng, resetGameplayRng } from './prng.mjs';
import { writeFileSync } from 'node:fs';

const TICKS = 300;
const hr = (t) => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76));
const report = (label, d, a, b) => {
  if (d.identical) { console.log(`  ✅ ${label}：逐 tick 全等  (digest ${d.digestA})`); return true; }
  console.log(`  ❌ ${label}：首处分歧 tick=${d.firstDivergentTick}（t=${d.atSeconds}s）`);
  console.log('     ' + d.changed.slice(0, 8).join('\n     '));
  console.log(`     digest ${d.digestA} vs ${d.digestB}`);
  return false;
};

hr('A. 同种子、同进程跑两次');
const a1 = await runTrace({ seed: 2026, ticks: TICKS });
const a2 = await runTrace({ seed: 2026, ticks: TICKS });
console.log('  meta: ' + JSON.stringify(a1.meta));
console.log('  玩法流消耗（两次的阶段计数）: ' + JSON.stringify(a1.meta.phases) + '  vs ' + JSON.stringify(a2.meta.phases));
console.log('  每 tick 玩法随机消耗合计: ' + a1.drawsPerTick.reduce((x, y) => x + y, 0) + ' 次');
const passA = report('A', diffTraces(a1, a2));

hr('B. 在第 100 tick 凭空多造 200 个 three 材质/几何（模拟客户端 LOD/剔除/缓存差异）');
const perturb = (i, THREE) => {
  if (i !== 100) return;
  for (let k = 0; k < 200; k++) { new THREE.MeshStandardMaterial(); new THREE.BoxGeometry(1, 1, 1); }
};
const b1 = await runTrace({ seed: 2026, ticks: TICKS, perturb });
const passB = report('B', diffTraces(a1, b1));
console.log('  （Math.random 确实被 three 的 generateUUID 抽走了：'
  + 'B 组比 A 组多消耗约 ' + (200 * 5) + ' 次宿主随机，但玩法流计数应为 '
  + a1.meta.gameplayDraws + ' = ' + b1.meta.gameplayDraws + '）');

hr('E. 整场对局（Player + 8 个 Bot + MPMatch 计分/重生/掉落）跨进程可比性');
const { runMatchTrace } = await import('./match-trace.mjs');
let e1, e2, e3, passE = true;
try {
  e1 = await runMatchTrace({ seed: 777, ticks: 900 });
  e2 = await runMatchTrace({ seed: 777, ticks: 900 });
  const dE = diffTraces(e1, e2);
  passE &&= dE.identical;
  console.log('  meta: ' + JSON.stringify(e1.meta));
  console.log('  终局: ' + JSON.stringify(e1.final));
  report('E-同种子两跑', dE);
  e3 = await runMatchTrace({ seed: 777, ticks: 900, perturb: (i) => { if (i === 200) { new THREE.MeshStandardMaterial(); new THREE.BoxGeometry(1, 1, 1); } } });
  const dE2 = diffTraces(e1, e3);
  passE &&= dE2.identical;
  report('E-扰动物体构造', dE2);
  console.log('  末拍摘要片段:\n    ' + String(e1.last).split('\n').slice(0, 5).join('\n    '));
  writeFileSync(new URL('./match-node.json', import.meta.url), JSON.stringify({ meta: e1.meta, digest: e1.digest, samples: e1.samples, drawsPerTick: e1.drawsPerTick }));
} catch (err) {
  passE = false;
  console.log('  ❌ 对局级轨迹跑不起来，缺的服务端 game 成员：\n     '
    + String(err && err.stack || err).split('\n').slice(0, 7).join('\n     '));
}

hr('G. 权威进程里没有视图模型，且遮罩状态仍由模拟侧产出（P0-2 拆分的验收）');
let passG = true;
try {
  const { HeadlessGame } = await import('./headless-game.mjs');
  const THREE2 = await import('three');
  const { Player } = await import('../js/player.js');
  seedGameplayRng(4242);
  const mk = (o) => Object.assign({
    fwd: 0, back: 0, left: 0, right: 0, sprint: false, jumpPressed: false, crouchPressed: false, pronePressed: false,
    fire: false, ads: false, reloadPressed: false, swapPressed: false, slot1: false, slot2: false,
    meleePressed: false, lethalPressed: false, lethal: false, tacticalPressed: false, tactical: false,
    interact: false, interactPressed: false, nvgPressed: false, streak: -1,
    firePressed: false, adsPressed: false, mdx: 0, mdy: 0,
  }, o);
  const solo = async (wid) => {
    const game = new HeadlessGame();
    await game.loadMap('yard');
    const pl = new Player(game, { pos: new THREE2.Vector3(0, 0, 0), yaw: 0 });
    pl.pos.set(0, (game.world.groundHeight(0, 0, 50, 0.35) || 0) + 0.02, 0);
    pl.eyeSmooth = pl.pos.y + 1.62;
    pl.equip({ primary: { id: wid, att: {} }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: [] });
    game.player = pl;
    return { game, pl, ws: pl.ws };
  }

  // G1 无 sink：枪模不该存在，渲染侧字段不该挂在权威对象上，但开火照常裁决
  const a = await solo('ak');
  const checks = [];
  checks.push(['服务端 game 没有 vmScene', a.game.vmScene === undefined]);
  checks.push(['WeaponSystem 未构造 Viewmodel (ws.vm === null)', a.ws.vm === null]);
  checks.push(['渲染侧字段已离开权威对象 (vmKick/vmRot undefined)', a.ws.vmKick === undefined && a.ws.vmRot === undefined]);
  const mag0 = a.ws.w.mag;
  for (let i = 0; i < 60; i++) a.game.step(DT, mk({ fire: true }));
  checks.push(['没有画面消费者时照常扣弹 (' + mag0 + '→' + a.ws.w.mag + ')', a.ws.w.mag < mag0]);
  checks.push(['权威侧不积压表现事件 (sink 仍为 null)', a.ws.sink === null]);

  // G2 接上 sink：事件确实投递，且带 tracers
  const got = [];
  a.ws.sink = (e) => got.push(e);
  const mag1 = a.ws.w.mag;
  for (let i = 0; i < 60; i++) a.game.step(DT, mk({ fire: true }));
  checks.push(['接上 sink 后收到 ' + got.length + ' 个开火事件', got.length > 0 && a.ws.w.mag < mag1],);
  checks.push(['事件带权威命中点列表', got.every(e => e.kind !== 'shot' || Array.isArray(e.tracers))]);

  // G3 遮罩状态归模拟侧：main.js:422/425 靠它压 NVG/热成像，拆分后必须仍然产出
  const b = await solo('l115');
  for (let i = 0; i < 90; i++) b.game.step(DT, mk({ ads: true }));
  checks.push(['狙击镜开镜后 game.scopeState = ' + JSON.stringify(b.game.scopeState) + '（模拟侧产出）', b.game.scopeState === 'sniper']);
  for (let i = 0; i < 90; i++) b.game.step(DT, mk({}));
  checks.push(['收镜后 scopeState 归 null', b.game.scopeState === null]);

  for (const [label, ok] of checks) {
    passG &&= ok;
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + label);
  }
  resetGameplayRng();
} catch (err) {
  passG = false;
  console.log('  ❌ G 跑不起来：\n     ' + String(err && err.stack || err).split('\n').slice(0, 7).join('\n     '));
}

hr('F. 落盘供浏览器跨环境比对');
writeFileSync(new URL('./trace-node.json', import.meta.url), JSON.stringify({ meta: a1.meta, digest: a1.digest, samples: a1.samples }));
console.log('  server/trace-node.json 已写出（' + a1.samples.length + ' ticks，digest ' + a1.digest + '）');

hr('结论');
console.log('  A 单飞轨迹同种子可复现 = ' + passA);
console.log('  B 对 three 对象构造数量差异免疫 = ' + passB);
console.log('  E 整场对局（含 8 个 bot 与计分/重生/掉落）可复现 = ' + passE);
console.log('  G 权威侧无视图模型、遮罩状态仍归模拟 = ' + passG);
console.log('  四项全绿才叫"能把同一份 sim 搬到服务端跑权威"。');
process.exit(passA && passB && passE && passG ? 0 : 1);
