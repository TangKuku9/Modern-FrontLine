// 跨环境一致性：浏览器跑一份 js/ 模拟，Node 跑同一份，逐 tick 相比。
// 这是"能把这份代码搬到服务端跑权威"最直接的证据。
//
// 前置：先跑过 node server/gate.mjs 生成 server/trace-node.json 与 match-node.json。
// 静态服务由 test/with-server.mjs 自己起在随机端口 —— 依赖手工起的 8080 会被旧代码坑到。
//
// ────────────────────────────────────────────────────────────────────────────
// 【判据的形状在 2026-09-26 改过一次，改动理由与证据都在这一段里】
//
// 原来只有一条：整场 900 拍 digest 必须相同（逐位全等）。这条**不成立，也不该成立**，
// 因为它把一个依赖"两台引擎恰好实现相同"的性质，当成了这份代码的正确性判据。
//
// 证据是本文件开头的 ENGINE_BATTERY：它每次运行都实测一遍两台引擎的数学函数指纹。
// 实测（Node V8 12.4 vs 本机 Chrome/153）：
//     逐位相同：sqrt / hypot / 乘加       ← 规范要求"精确舍入"的那一类
//     逐位不同：sin cos tan atan2 asin acos pow(0.8) pow(0.85) exp log cbrt
//                                        ← 规范只要求"实现近似"的那一类（11/17）
// 而 sin/cos/atan2 正是"朝向 → 移动方向"用的，pow(x,0.8) 正是爆炸伤害用的 ——
// 两台引擎的 sim 从某一拍起必然分叉，并按 ULP 混沌放大。这与这份代码写得对不对无关：
// 换一个 Chrome 版本、换一个 Node 版本，分歧点就会换个拍号重新出现。
// 把它当判据，结果就是"红是常态、绿是侥幸"，于是红灯被无视，判据等于没有。
//
// 于是改成两档，且**由引擎指纹自校准**：
//   档 1  指纹全同 → 仍然严格要求整场逐位全等。此时任何分歧都是这份代码的 bug。
//   档 2  指纹有异 → 不要求逐位，但下面三条仍然严格，它们才是部署真正依赖的性质：
//        a. 单飞 300 拍逐位全等（无 AI 决策参与，两端跑的代码路径完全一样）；
//        b. 每个采样点的世界几何签名相同（两端命中判定拿的是同一份碰撞体集合 ——
//           几何一旦不同，"这发打中墙还是打人"就会分环境，而且不报错）；
//        c. 累计玩法抽数相等（没有"只在一侧存在的代码在抽玩法随机数"，即特效偷流那类）。
//     并把分歧的**形状**（错拍拍数 / 错拍总量 / 首分歧拍）印出来：错拍而不增抽数，
//     是"离散事件被挪了一拍"的签名；增抽数，才是分支分叉 —— 两者修法完全相反。
//
// 为什么补演/回滚这套东西不受影响：只有服务端（Node）跑权威 sim，浏览器是客户端，
// 它每 20Hz 被权威快照校正一次。跨引擎分叉表现为"客户端预测的误差下限"，不是"两边状态
// 永久错开"—— 后者才是需要修的东西，而它已经被 net-play 的拍号探针（offset 分布）盯着。
// ────────────────────────────────────────────────────────────────────────────
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

// 引擎指纹：把每个函数 30000 次调用结果的双精度**位模式**逐位混进哈希。
// 不许做任何取整 —— 第一版这里写了 Math.round(v * 1e9)，那等于亲手把 ULP 差异抹掉，
// 量具自己制造出"两台引擎一致"的假象，然后据此去别处找了半天原因。
function engineBattery() {
  const buf = new DataView(new ArrayBuffer(8));
  const mix = (h, v) => {
    if (!Number.isFinite(v)) return Math.imul(h ^ (Number.isNaN(v) ? 0x7ff8 : 0x7ff0), 0x01000193) | 0;
    buf.setFloat64(0, v);
    return Math.imul(Math.imul(h ^ buf.getUint32(0), 0x01000193) ^ buf.getUint32(4), 0x1000193) | 0;
  };
  const out = {};
  const h = (name, f) => {
    let s = 0x811c9dc5 | 0, n = 0;
    for (let i = 0; i < 30000; i++) {
      const a = (i * 0.0137) % 40 - 20, b = (i * 0.0071) % 13 - 6.5, c = (i * 0.0031) % 7 - 3.5;
      let v; try { v = f(a, b, c, i); } catch (e) { v = NaN; }
      s = mix(s, v); n++;
    }
    out[name] = { s: s >>> 0, n };
  };
  h('hypot2', (a, b) => Math.hypot(a, b));
  h('hypot3', (a, b, c) => Math.hypot(a, b, c));
  h('sqrt', (a, b) => Math.sqrt(a * a + b * b));
  h('sin', (a) => Math.sin(a));
  h('cos', (a) => Math.cos(a));
  h('tan', (a) => Math.tan(a * 0.01));
  h('atan2', (a, b) => Math.atan2(a, b));
  h('asin', (a) => Math.asin(Math.max(-1, Math.min(1, a / 20))));
  h('acos', (a) => Math.acos(Math.max(-1, Math.min(1, a / 20))));
  h('pow08', (a) => Math.pow(1 - Math.abs(a) / 40, 0.8));
  h('pow085', (a) => Math.pow(Math.abs(a) + 1, 0.85));
  h('pow2', (b) => Math.pow(Math.abs(b) + 1, 2));
  h('exp', (a) => Math.exp(-Math.abs(a) / 5));
  h('log', (a) => Math.log(Math.abs(a) + 1e-6));
  h('cbrt', (a) => Math.cbrt(a));
  h('div_mul_add', (a, b) => (a * 1.37 + b) / 2.11 - a * 0.0011);
  return out;
}

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const nodeTrace = read('./trace-node.json');
const nodeMatch = read('./match-node.json');

const browser = await launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
const { withServer } = await import('../test/with-server.mjs');
const srv = await withServer();
await page.goto(srv.base + '/net-trace.html');
// net-trace.html 在 catch 里把真实失败塞进 __TRACE.error，此时 __MATCH 根本没有。
// 上一版这里先死在 "Cannot read properties of undefined (reading 'digest')" 上，
// 量具把被测对象的失败签名吞掉了 —— 看到的永远是量具自己的报错，不是页面的报错。
await page.waitForFunction(() => window.__TRACE || window.__MATCH, null, { timeout: 300000 });
const raw = await page.evaluate(() => ({
  ua: navigator.userAgent,
  err: window.__TRACE && window.__TRACE.error,
  trace: window.__TRACE && window.__TRACE.digest !== undefined ? { digest: window.__TRACE.digest, samples: window.__TRACE.samples, meta: window.__TRACE.meta } : undefined,
  match: window.__MATCH && window.__MATCH.digest !== undefined ? { digest: window.__MATCH.digest, samples: window.__MATCH.samples, meta: window.__MATCH.meta, final: window.__MATCH.final, last: window.__MATCH.last, drawsPerTick: window.__MATCH.drawsPerTick } : undefined,
}));
if (raw.err || !raw.trace || !raw.match) {
  console.log('  ❌ 浏览器侧没跑完模拟：' + (raw.err || `TRACE=${raw.trace ? 'ok' : '缺'} MATCH=${raw.match ? 'ok' : '缺'}`));
  console.log('     ' + String(raw.err || '').split('\n').slice(0, 12).join('\n     '));
  await browser.close(); srv.kill(); process.exit(1);
}
const br = raw;

// ── 引擎指纹：决定下面用哪一档判据 ────────────────────────────────────────────
const fpExpr = '(' + engineBattery.toString() + ')()';
const nodeFp = eval(fpExpr);
const chromeFp = await page.evaluate(fpExpr);
await browser.close(); srv.kill();

const fpKeys = Object.keys(nodeFp);
const fpDiff = fpKeys.filter(k => nodeFp[k].s !== chromeFp[k].s);
const fpSame = fpKeys.filter(k => nodeFp[k].s === chromeFp[k].s);
console.log(`\n  引擎指纹（每个函数 3 万次调用的双精度位模式，${fpKeys.length} 个函数）：`);
console.log(`    逐位相同 ${fpSame.length} 个：${fpSame.join(' ')}`);
console.log(`    逐位不同 ${fpDiff.length} 个：${fpDiff.join(' ') || '（无）'}`);
console.log(`    Node V8 ${process.versions.v8} · 浏览器 ${String(br.ua).replace(/^.*?(Chrome\/[\d.]+).*$/, '$1')}`);

const { diffTraces } = await import('./sim-twin.mjs');
const strict = fpDiff.length === 0;
let green = errs.length === 0;
const fail = (why) => { green = false; console.log(`  ❌ ${why}`); };

// ── 1. 单飞 300 拍：两种档位下都要求逐位全等 ────────────────────────────────
// 这个局面里没有 AI 决策，两端跑的代码路径完全一样，所以"逐位全等"是应当成立的性质；
// 它一旦红，说明两端在**结构**上走了不同的路（而不是被实现近似的数学函数放大出来的噪声）。
{
  const d = diffTraces(nodeTrace, br.trace);
  if (d.identical) console.log(`  ✅ 单飞轨迹 300 拍：Node 与 Chrome 逐 tick 全等  (digest ${d.digestA})`);
  else fail(`单飞轨迹 300 拍：首处分歧第 ${d.firstDivergentTick} 拍（t=${d.atSeconds}s）  ${d.changed.slice(0, 4).join(' | ')}\n     Node ${d.digestA} vs Chrome ${d.digestB}\n     这个局面没有 AI 决策，两端路径应当完全相同 —— 红在这里就是这份代码的 bug，不是引擎差异。`);
  // 1b. 同一局的累计玩法抽数 —— "一侧多跑了抽随机的代码"这条在这里无处可躲：
  //     这一局两端**逐位全等**，于是混沌拿不到任何解释权（下面整场局里它拿得到，见 b）。
  //     实测 Node 15 = Chrome 15；反证臂：在只有浏览器侧走到的分支里每拍偷抽一次 ⇒ 15 vs 315。
  const ta = nodeTrace.meta.gameplayDraws, tb = br.trace.meta.gameplayDraws;
  if (ta === tb) console.log(`  ✅ 单飞局累计玩法抽数相等  | ${ta} 次（这一局逐位全等 ⇒ 差了就是有一侧多跑了代码，没有"混沌"可推诿）`);
  else fail(`单飞局累计玩法抽数不等：Node ${ta} vs Chrome ${tb}（差 ${ta - tb}）—— 逐位全等却抽得不一样多，只可能是一侧多跑了抽随机的代码（特效偷流那类）`);
}

// ── 2. 整场对局 900 拍 ─────────────────────────────────────────────────────
{
  const d = diffTraces(nodeMatch, br.match);
  if (d.identical) {
    console.log(`  ✅ 整场对局 900 拍：Node 与 Chrome 逐 tick 全等  (digest ${d.digestA})`);
    if (!strict) console.log('     （注意：本次引擎指纹有差异却仍然逐位全等 —— 是运气好，不是判据变严）');
  } else {
    console.log(`  ·  整场对局 900 拍：首处分歧第 ${d.firstDivergentTick} 拍（t=${d.atSeconds}s）  ${d.changed.slice(0, 3).join(' | ')}`);
    console.log(`     Node ${d.digestA} vs Chrome ${d.digestB}`);
    // a. 世界几何签名 —— 两端必须逐采样点相同
    const wl = (s) => { const m = /^#world (.*)$/m.exec(String(s)); return m ? m[1] : '(缺)'; };
    const nw = nodeMatch.samples.map(wl), bw = br.match.samples.map(wl);
    let wBad = -1;
    for (let i = 0; i < Math.min(nw.length, bw.length); i++) if (nw[i] !== bw[i]) { wBad = i; break; }
    if (wBad < 0) console.log(`  ✅ 世界几何签名逐采样点相同  | ${nw[0]}（${nw.length} 个采样点）`);
    else fail(`世界几何签名在第 ${wBad} 个采样点不同：Node ${nw[wBad]} vs Chrome ${bw[wBad]} —— 两端命中判定拿的不是同一份碰撞体，这会让"打中墙还是打人"分环境且不报错`);
    const da = nodeMatch.drawsPerTick, db = br.match.drawsPerTick;
    let ticks = 0, bulk = 0, maxD = 0;
    for (let i = 0; i < Math.min(da.length, db.length); i++) {
      if (da[i] === db[i]) continue;
      ticks++; bulk += Math.abs(da[i] - db[i]); maxD = Math.max(maxD, Math.abs(da[i] - db[i]));
    }
    const total = da.reduce((s, v) => s + v, 0);
    // b. 玩法抽数 —— 判的是**净差与错拍总量的比值**，不是"最后总数差多少"。
    //    〔判据形状在 2026-09-27 改过两轮，两轮的理由与证据都留在这一段〕
    //    第一版比整场累计次数（Node 1647 vs Chrome 1617 ⇒ 红）。但两端从第
    //    ${d.firstDivergentTick} 拍起就已经是两条混沌轨迹了：那之后 bot 每判一次
    //    "这发中不中"都各自不同 —— 中了的那一侧要额外抽散布与伤害，抽数自然岔开。
    //    也就是说**只要允许引擎数学有差异（档 2），累计抽数就必然不等**：红是常态、
    //    绿是侥幸。这和当初被废掉的那条"整场 digest 逐位全等"是同一类错 —— 把依赖
    //    "两台引擎恰好实现相同"的性质当成了这份代码的判据，红灯天天亮，等于没有判据。
    //    第二版改成"分歧点之前抽数必须逐位相同" —— 反证臂一跑就废了：偷流会让两端
    //    **从第 0 拍起**就分歧（它扰动了流本身），于是"分歧点"塌成 0，判据反而成立。
    //    判据的边界由嫌疑对象自己挪，这是这个仓库第四次栽在这上面。
    //    第三版（现在这条）只留下两个余量够大的形状：
    //      · 净差占总抽数的百分比 —— 混沌是**双向错拍**（离散事件被挪了拍号，两侧互有盈亏），
    //        净差只有总量的 2.2%；偷流是**单向漂移**，实测 65.8%。两个方向差 30 倍，阈值 5%。
    //        （试过"净差/错拍总量"这个比值，健康 0.21 vs 偷流 0.52 —— 只差 2.5 倍，不算判据，
    //         因为偷流一旦把流搅乱，混沌噪声也跟着涌进来，分母被自己抬高了。留着只打印。）
    //      · 首处逐位分歧的拍号 —— 见下面 b2：偷流扰动的是流本身 ⇒ 立刻分歧，混沌要放大几百拍。
    const na = nodeMatch.meta.gameplayDraws, nb = br.match.meta.gameplayDraws;
    const net = Math.abs(na - nb);
    const ratio = bulk ? net / bulk : 0;
    if (net <= total * 0.05)
      console.log(`  ✅ 整场局的抽数差是双向错拍而不是单向漂移  | 净差 ${net} 占总抽数 ${(net / total * 100).toFixed(1)}%（阈值 5%，实测健康 2.2% · 偷流 65.8%）· 净差/错拍 = ${ratio.toFixed(2)}`);
    else
      fail(`整场局抽数单向漂移：净差 ${net} 占总抽数 ${(net / total * 100).toFixed(1)}%（>5%）· 净差/错拍 = ${ratio.toFixed(2)} —— 混沌是双向错拍，一侧长期多抽只能是有一侧多跑了代码（特效偷流那类）`);
    // b2. 首处逐位分歧的拍号 —— 这一条抓的是"分歧来得太快"。
    //     引擎数学的 1 ULP 要放大成"采样点上读得出来的差别"得跑几百拍（实测第 760 拍 / 900）；
    //     而"只有一侧在抽流"会当场改变流的位置 ⇒ 两端**第一拍**就走不到一起（实测第 0 拍）。
    //     阈值 50：健康侧有 15 倍余量，反证臂一侧是 0，中间没有可争的地带。
    //     （它同时也罩住"只有一侧存在的代码改了物理量"这同一类结构差异，不只是偷流。）
    const cut = d.firstDivergentTick;
    if (cut >= 50) console.log(`  ✅ 首处逐位分歧来得够晚（混沌要放大几百拍，结构差异当场就分歧）  | 第 ${cut} 拍 / ${da.length}（阈值 50，实测偷流时为 0）`);
    else fail(`首处逐位分歧在第 ${cut} 拍 —— 引擎 ULP 差不可能在这么早的拍号上放大成可见分歧（健康侧实测 760）。这么早的分歧只能是两端**从第一拍起就跑了不一样的代码**（一侧偷抽了玩法随机、或某段只在浏览器/只在 Node 生效的分支），这是真 bug。`);
    // c. 分歧的形状：错拍而不增抽数 = 离散事件被挪了一拍
    console.log(`     逐拍抽数分歧形状：${ticks}/${da.length} 拍不同 · 错拍总量 ${bulk}（占 ${(bulk / total * 100).toFixed(1)}%）· 单拍最大 ${maxD} · 累计 Node ${na} vs Chrome ${nb}`);
    console.log('     ' + (bulk === 0
      ? '错拍量为 0 ⇒ 只有"某几拍抽数对了但落点不同"这种不可能的情形，值得看一眼。'
      : `错拍总量 ${bulk}：全部落在逐位分歧点之后 ⇒ 是混沌连带出来的量（一侧多打中几发就多抽几次），不是判据；判据是上面那条"分歧点之前必须逐位相同"。`));
    if (strict) fail('引擎指纹本次全同，逐位全等是应当成立的性质 —— 上面这些分歧都要当成这份代码的 bug 查，不能按"引擎差异"放行');
    else console.log('     （本次引擎指纹有差异，按档 2 判：上面三条结构性断言才是判据）');
  }
}

console.log(`  Chrome 侧 meta: ${JSON.stringify(br.match.meta)}`);
console.log(`  Chrome 侧终局: ${JSON.stringify(br.match.final)}`);
if (errs.length) { console.log('  页面异常:\n    ' + errs.slice(0, 6).join('\n    ')); }
console.log(`\n  判据档位：${strict ? '档 1（引擎指纹全同 ⇒ 要求逐位全等）' : '档 2（引擎指纹有异 ⇒ 要求结构性一致）'}`);
console.log(`  结论：${green ? '绿' : '红'}`);
process.exit(green ? 0 : 1);
