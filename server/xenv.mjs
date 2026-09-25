// 跨环境一致性：浏览器跑一份 js/ 模拟，Node 跑同一份，逐 tick 相比。
// 这是"能把这份代码搬到服务端跑权威"最直接的证据 —— 两边连浮点摘要都要相同。
//
// 前置：本地服务在 8080（node server/serve.mjs 或任意静态服务器），
// 且先跑过 node server/gate.mjs 生成 server/trace-node.json 与 match-node.json。
import './browser-shim.mjs';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
async function launch() {
  for (const [label, opts] of [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }]]) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('没有可用浏览器');
}
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const nodeTrace = read('./trace-node.json');
const nodeMatch = read('./match-node.json');

const browser = await launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
await page.goto('http://localhost:8080/net-trace.html');
await page.waitForFunction(() => window.__TRACE, null, { timeout: 300000 });
const br = await page.evaluate(() => ({
  trace: { digest: window.__TRACE.digest, samples: window.__TRACE.samples, meta: window.__TRACE.meta },
  match: { digest: window.__MATCH.digest, samples: window.__MATCH.samples, meta: window.__MATCH.meta, final: window.__MATCH.final, last: window.__MATCH.last },
}));
await browser.close();

const { diffTraces } = await import('./sim-twin.mjs');
let green = errs.length === 0;
for (const [label, a, b] of [['单飞轨迹 300 tick', nodeTrace, br.trace], ['整场对局 900 tick', nodeMatch, br.match]]) {
  const d = diffTraces(a, b);
  if (d.identical) {
    console.log(`  ✅ ${label}：Node 与 Chrome 逐 tick 全等  (digest ${d.digestA})`);
  } else {
    green = false;
    console.log(`  ❌ ${label}：首处分歧 tick=${d.firstDivergentTick}（t=${d.atSeconds}s）  ${d.changed.slice(0, 6).join(' | ')}`);
    console.log(`     Node ${d.digestA} vs Chrome ${d.digestB}`);
  }
}
console.log(`  Chrome 侧 meta: ${JSON.stringify(br.match.meta)}`);
console.log(`  Chrome 侧终局: ${JSON.stringify(br.match.final)}`);
if (errs.length) { console.log('  页面异常:\n    ' + errs.slice(0, 6).join('\n    ')); }
console.log(`\n  结论：${green ? '绿' : '红'}`);
process.exit(green ? 0 : 1);
