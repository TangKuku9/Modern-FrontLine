// P0 闸门：把"这份代码能不能联网"从观点变成数字。
//
//   node server/gate.mjs
//
// A 播种后同进程跑两次        → 必须逐 tick 全等，否则 sim 里仍有墙钟/进程态依赖
// B 中途故意多造 200 个 three 对象 → 轨迹必须仍然全等；这是 geoCache/UUID 那个
//   实测缺陷的回归测试：只要玩法流还沾 Math.random，这条一定红
// C 落盘 Node 轨迹            → 交给浏览器跑同一份代码后跨环境比对
import './browser-shim.mjs';
import * as THREE from 'three';
import { runTrace, diffTraces, sampleFields, DT } from './sim-twin.mjs';
import { rng } from './prng.mjs';
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

hr('F. 落盘供浏览器跨环境比对');
writeFileSync(new URL('./trace-node.json', import.meta.url), JSON.stringify({ meta: a1.meta, digest: a1.digest, samples: a1.samples }));
console.log('  server/trace-node.json 已写出（' + a1.samples.length + ' ticks，digest ' + a1.digest + '）');

hr('结论');
console.log('  A 单飞轨迹同种子可复现 = ' + passA);
console.log('  B 对 three 对象构造数量差异免疫 = ' + passB);
console.log('  E 整场对局（含 8 个 bot 与计分/重生/掉落）可复现 = ' + passE);
console.log('  三项全绿才叫"能把同一份 sim 搬到服务端跑权威"。');
process.exit(passA && passB && passE ? 0 : 1);
