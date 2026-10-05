// Worker 双路真浏览器实跑（性能审查 C4/C5，docs/client-performance-audit.md）。
//
// net-play 那两个页面是联机客户端（bot 在服务端跑，客户端不做寻路），fps.mjs 为了
// 跨帧率逐位全等把 Worker 关了 —— Worker 这两刀的**端到端**只有离线 bot 局能看见，
// 所以单独立这一份，一把局跑两条臂：
//   A（Worker 路）：贴图生成在 Worker 里跑完；离线 bot 的 A* 请求经 Worker 送达；
//      pathPending 门在（请求数有界，不是"每拍一发"的洪水）。
//   B（回退路）：把 Worker 封锁死 —— 加载屏照常走完（同步生成贴图）、对局照常开、
//      bot 靠同步现算照常拿路径。这条是 file:// / 老浏览器 / 策略封锁的替身。
// 核心层的逐位一致性判据在 test/worker-core.mjs。
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

const CFG = { mode: 'tdm', map: 'yard', diff: 1, allies: 4, enemies: 4, scoreLimit: 50, timeLimit: 10 };
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label, extra]); console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); return !!cond; };

async function launch() {
  const tries = [
    ['chrome', { channel: 'chrome', args: ARGS }],
    ['playwright-chromium', { args: ARGS }],
    ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }],
  ];
  for (const [label, opts] of tries) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ` + e.message.split('\n')[0]); }
  }
  throw new Error('没有可用浏览器');
}

const browser = await launch();
let code = 0;
const srv = await withServer();

async function openPage(blockWorker, tag) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  await page.addInitScript((blocked) => {
    localStorage.setItem('mf_settings', JSON.stringify({ sens: 1.0, adsSens: 0.9, fov: 78, quality: 'low', volume: 0, voice: false, invertY: false, fixedStep: true }));
    if (blocked) window.Worker = class { constructor() { throw new Error('worker blocked for test'); } };
    window.addEventListener('error', e => { (window.__bootErr = window.__bootErr || []).push(String(e.message)); });
  }, blockWorker);
  await page.goto(srv.base + '/index.html');
  await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 120000 });
  await page.evaluate(async (cfg) => { await window.game.startGame('mp', cfg); }, CFG);
  await page.waitForFunction(() => window.game.state === 'play' && window.game.bots.length === 8, null, { timeout: 60000 });
  return page;
}

try {
  // ── A：Worker 路 ──
  console.log('  ── A：Worker 路 ──');
  const A = await openPage(false, 'A');
  ok('A1 贴图生成走的是 Worker（不是回退）', await A.evaluate(() => window.__texViaWorker === true));
  ok('A2 寻路 Worker 在岗', await A.evaluate(() => !!window.game.pathWorker));
  await A.waitForFunction(() => (window.game.__pathsViaWorker || 0) >= 1, null, { timeout: 30000 });
  ok('A3 离线 bot 的 A* 请求经 Worker 送达并回流', await A.evaluate(() => (window.game.__pathsViaWorker || 0) >= 1));
  ok('A4 bot 真的拿到了路径在走', await A.evaluate(() => window.game.bots.some(b => b.path && b.path.length >= 1)));
  await A.waitForFunction(() => (window.game.__pathsViaWorker || 0) >= 3, null, { timeout: 30000 });
  const flood = await A.evaluate(() => ({ req: window.game.__pathRequests || 0, got: window.game.__pathsViaWorker || 0, t: window.game.time }));
  // 防洪臂：pathPending 门在 —— 请求数必须是"bot 每几秒一寻路"的量级；门没了的话
  // steer 的 !path 分支会让 8 个 bot 每拍连发（60 拍/s × 8 ≈ 480/s 起）。
  ok('A5 pathPending 门防洪：请求数有界', flood.req < 60 * flood.t, `req=${flood.req} · got=${flood.got} · t=${flood.t.toFixed(1)}s（无门应为 ~${Math.round(60 * flood.t * 8)} 起）`);
  ok('A6 页面没有真错误', await A.evaluate(() => !window.__bootErr), JSON.stringify(await A.evaluate(() => window.__bootErr || [])));
  await A.close();

  // ── B：Worker 被封锁 → 整条回退 ──
  console.log('  ── B：Worker 被封锁 → 整条回退 ──');
  const B = await openPage(true, 'B');
  ok('B1 贴图同步回退路走通（加载屏没被卡死）', await B.evaluate(() => window.__texViaWorker === false));
  ok('B2 对局照常开起来（8 个 bot 在场）', await B.evaluate(() => window.game.state === 'play' && window.game.bots.length === 8));
  await B.waitForFunction(() => window.game.bots.some(b => b.path && b.path.length >= 1), null, { timeout: 30000 });
  ok('B3 bot 靠同步现算照常拿路径', await B.evaluate(() => window.game.bots.some(b => b.path && b.path.length >= 1)));
  ok('B4 回退路不付 Worker 寻路一分钱', await B.evaluate(() => !window.game.pathWorker && !(window.game.__pathsViaWorker > 0)));
  ok('B5 页面没有真错误', await B.evaluate(() => !window.__bootErr), JSON.stringify(await B.evaluate(() => window.__bootErr || [])));
  await B.close();
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  code = 2;
} finally {
  await browser.close();
  srv.kill();
}
const fails = checks.filter(c => !c[0]).length;
console.log(`\n${fails || code ? 'RED' : 'GREEN'}  ${checks.length - fails}/${checks.length} 通过`);
process.exit(code || (fails ? 1 : 0));
