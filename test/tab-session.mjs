// 同一个浏览器、两个标签页、两个账号 —— 跨账号污染的判据。
//
// 会话令牌在 HttpOnly cookie 里，而 cookie 的作用域是"源"不是"标签页"：
// 同一浏览器开两个标签页各登一个账号时，后登录的那份 Set-Cookie 会把先登录的顶掉，
// 于是先登录那个标签页的每一次请求、每一条 WS 握手都在替**别人**说话 ——
// 症状就是玩家报的"A 在大厅说话，显示成 B 发的言"。
//
// 这一条必须在**真浏览器**里量（与 test/hardening.mjs 的分工：那边用裸 HTTP/WS 量
// cookie 语义本身，这边量"sessionStorage 里的标签页选择器 → x-tab 头 / ?tab= 参数"
// 这段客户端接线真的接上了）：两个 page 放进**同一个 context** —— cookie 罐共享、
// sessionStorage 各自一份 —— 那正是真实用户的处境。分开的 context 各有一个 cookie 罐，
// 那是 multi-account-probe 的形状，量不到这个 bug。
//
//   node test/tab-session.mjs    自己起临时服务，不需要事先手起 8080
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

const INVITE = 'TAB-CODE';
const PW = 'a-long-enough-password';
const NAME_A = 'TabSoldierA';
const NAME_B = 'TabSoldierB';
const ARGS = ['--mute-audio', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label, extra]); console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); return !!cond; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 轮询而不是死等：WS 帧什么时候到不由测试说了算，但判据必须在有限时间里给结论
const until = async (fn, ms = 6000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
};

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

const srv = await withServer({ JOIN_CODE: INVITE });
const BASE = srv.base + '/index.html';
const browser = await launch();
let code = 0;

try {
  // 同一个 context：共享 cookie 罐、各自 sessionStorage —— 真实用户的处境
  const ctx = await browser.newContext();
  const p1 = await ctx.newPage();
  const p2 = await ctx.newPage();
  for (const p of [p1, p2]) {
    await p.addInitScript(() => {
      localStorage.setItem('mf_settings', JSON.stringify({ quality: 'low', volume: 0, showFps: false }));
      window.addEventListener('error', e => { (window.__bootErr = window.__bootErr || []).push(String(e.message)); });
    });
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  }

  // ── 两个标签页各自注册登录（走 game.account 的真路径，x-tab 头才有机会接上）──
  const reg = (p, name) => p.evaluate(({ name, pw, code }) =>
    game.account.register({ name, password: pw, code }).then(r => ({ ok: r.ok, msg: r.message || '' })), { name, pw: PW, code: INVITE });
  const r1 = await reg(p1, NAME_A);
  ok('T1 标签页 1 注册登录为 ' + NAME_A, r1 && r1.ok, JSON.stringify(r1));
  const r2 = await reg(p2, NAME_B);
  ok('T2 标签页 2 注册登录为 ' + NAME_B, r2 && r2.ok, JSON.stringify(r2));

  // ── HTTP 半边：登录 B 之后，标签页 1 问"我是谁"必须还是 A ──
  // 修前这里返回 B：cookie 被后登录的顶掉，而 /api/me 只认 cookie。
  const me1 = await until(() => p1.evaluate(() => game.account.me().then(() => (game.account.user || {}).name || null)));
  ok('T3 标签页 1 的"我是谁"仍是 ' + NAME_A + '（HTTP 侧身份没被标签页 2 的登录顶掉）',
    me1 === NAME_A, `me=${me1}`);

  // ── WS 半边：两个标签页都连上大厅，A 说话必须署名 A ──
  const con1 = await p1.evaluate(() => game.onlineLobby().then(() => true)).catch(e => { console.log('  p1 大厅连接失败: ' + e.message); return false; });
  ok('T4 标签页 1 连上大厅', !!con1);
  const con2 = await p2.evaluate(() => game.onlineLobby().then(() => true)).catch(e => { console.log('  p2 大厅连接失败: ' + e.message); return false; });
  ok('T5 标签页 2 连上大厅', !!con2);

  await p1.evaluate(() => game.lobby.send({ t: 'say', ch: 'lobby', text: 'hello-from-A' }));
  const seenA = await until(() => p2.evaluate(() => {
    const m = (game.lobby && game.lobby.chat || []).find(x => x.text === 'hello-from-A');
    return m ? m.name : null;
  }));
  ok('T6 **被测对象**：A 说话，B 标签页看到署名 ' + NAME_A + '（修前这里是 B —— 跨账号污染本身）',
    seenA === NAME_A, `署名=${seenA}`);

  await p2.evaluate(() => game.lobby.send({ t: 'say', ch: 'lobby', text: 'hello-from-B' }));
  const seenB = await until(() => p1.evaluate(() => {
    const m = (game.lobby && game.lobby.chat || []).find(x => x.text === 'hello-from-B');
    return m ? m.name : null;
  }));
  ok('T7 反方向也归位：B 说话，A 标签页看到署名 ' + NAME_B, seenB === NAME_B, `署名=${seenB}`);

  // ── 座位归属跟着同一份身份走：A 建房，房间状态里"我"必须是 A ──
  await p1.evaluate(() => game.lobby.createRoom({}));
  const seat1 = await until(() => p1.evaluate(() => {
    const st = game.lobby && game.lobby.state;
    return st && st.me ? st.me.name : null;
  }));
  ok('T8 A 建的房，座位上的"我"是 ' + NAME_A + '（聊天之外，座位/XP/账号归属同源）',
    seat1 === NAME_A, `me.name=${seat1}`);

  const bootErrs = await Promise.all([p1, p2].map(p => p.evaluate(() => window.__bootErr || [])));
  ok('T9 两个页面控制台没有真错误', bootErrs.every(l => !l.length), JSON.stringify(bootErrs));

  code = checks.every(c => c[0]) ? 0 : 1;
} catch (e) {
  console.log('判据本身跑挂了: ' + (e && e.stack || e));
  code = 2;
} finally {
  await browser.close();
  srv.kill();
}

console.log(code === 0 ? '\n✅ 跨账号污染判据全绿' : `\n❌ ${checks.filter(c => !c[0]).length} 条红`);
process.exit(code);
