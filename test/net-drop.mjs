// 掉线会被"看见"吗 —— 断网/服务器重启时的玩家体验。
//
// 原来是这样的：NetClient 往 events 里塞一条 disconnected，而没人读 events ⇒
// 世界静止、屏幕上一个字都没有，玩家以为是自己卡了。上线后这必然是第一条工单。
//
// 三条路径分开测，因为它们的成因和触发者都不同：
//   A 连接真的关了（进程被杀、网络断）  → ws 的 onclose        → lost='closed'
//   B 连接还在但对端不发包了（半开）    → 只能自己数快照间隔   → lost='stale'
//   C 压根没进得去（房间已满/在维护）   → welcome 之前的 err   → 加载页给原因
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, bad = 0;
const ok = (label, cond, extra = '') => { n++; if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); };

async function launch() {
  for (const [label, opts] of [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }]]) {
    try { return await chromium.launch(opts); } catch { /* 换下一个 */ }
  }
  throw new Error('没有可用浏览器');
}

const newPage = async (browser, srv, tag) => {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const logs = [];
  page.on('pageerror', e => logs.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', m => { if (m.type() === 'error') logs.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('mf_settings', JSON.stringify({ quality: 'low', volume: 0, fixedStep: true }));
    // 页面自己打的时间戳：从"正在连接"到"连接失败"隔了几秒，只有页内的钟说得准。
    // 判据要的是"没等满 8 秒超时才说话"，用测试侧的 Date.now() 量会把加载应用的那 6 秒也算进去。
    window.__marks = [];
    const re = /正在连接对局服务|连接失败/;
    new MutationObserver(() => {
      const t = document.body && document.body.textContent || '';
      const m = re.exec(t);
      // 连句子一起截：只存匹配到的那几个字（"连接失败"）等于没说原因，判据就成了空断言
      if (m && window.__marks.length < 400) window.__marks.push([Math.round(performance.now()), t.slice(m.index, m.index + 46)]);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`${srv.base}/index.html?online=1&room=${tag}&name=甲&team=A`, { waitUntil: 'domcontentloaded' });
  return { page, logs };
};

// 起一套"服务 + 页面"，并等到真的进了对局、拿到了快照
async function boot(browser, tag) {
  const srv = await withServer();
  const { page, logs } = await newPage(browser, srv, 'drop-' + tag);
  for (let i = 0; i < 160; i++) {
    const s = await page.evaluate(() => !!(window.game && window.game.net && window.game.net.cid && window.game.net.snaps > 5));
    if (s) break;
    await sleep(250);
  }
  const st = await page.evaluate(() => ({
    lost: (window.game.net || {}).lost || null, snaps: window.game.net.snaps,
    cid: window.game.net.cid, state: window.game.state, gap: +(window.game.net.snapGap || 0).toFixed(2),
  }));
  return { srv, page, logs, st };
}

const realErrs = (logs) => logs.filter(l => !/favicon|WebGL|AudioContext|pointer lock|ERR_NETWORK|ERR_INTERNET|Failed to load/i.test(l));

const browser = await launch();
try {
  console.log('\n── A：连接被关掉（进程被杀 / 网络断） ──');
  {
    const { srv, page, logs, st } = await boot(browser, 'a');
    ok('先决：真的进了对局并在收快照（否则下面"看到断开"是空断言）', st.cid && st.snaps > 5 && !st.lost, JSON.stringify(st));
    // 优雅下线时服务端会先发一句 note。这台 Windows 上发不进信号（libuv 直接 TerminateProcess），
    // 所以直接把一条控制帧喂给真正的处理函数 onControl —— 测的是"这句话会不会显示出来"。
    const noted = await page.evaluate(() => {
      window.game.net.onControl({ t: 'note', msg: '服务器维护中，请刷新重连' });
      return { note: window.game.net.serverNote, lost: window.game.net.lost || null };
    });
    ok('服务端的 note 被记下来了', /维护/.test(noted.note || ''), JSON.stringify(noted));
    ok('但一句 note 不该被当成"已经断开"（随后才是 close）', noted.lost === null, JSON.stringify(noted));
    srv.kill();
    let seen = null;
    for (let i = 0; i < 40; i++) {
      seen = await page.evaluate(() => ({
        lost: window.game.net.lost || null, why: window.game.net.lostReason || '',
        connected: window.game.net.connected,
        text: (document.getElementById('announce') || {}).textContent || '',
        opacity: (document.getElementById('announce') || {}).style?.opacity,
        paused: window.game.paused,
      }));
      if (seen.lost) break;
      await sleep(250);
    }
    ok('连接关掉后 ≤10 秒内玩家被明确告知（不是默默静止）', !!seen.lost, JSON.stringify(seen));
    // 分辨是哪条机制报的：socket 关掉就该是 onclose 的 'closed'。
    // 读到 'stale' 说明是看门狗兜的底 —— 那也行，但它意味着 onclose 没工作，值得单独知道。
    ok('报的是"连接已断开"这一类（onclose 认出得比看门狗快）', seen.lost === 'closed', JSON.stringify({ lost: seen.lost, why: seen.why }));
    ok('横幅上真有字，且说的是这件事', /断开|失联|维护/.test(seen.text) && seen.opacity === '1', JSON.stringify(seen.text));
    ok('横幅里带上了服务端那句话（维护 ≠ 我网卡了）', /维护/.test(seen.text), JSON.stringify(seen.text));
    ok('世界被暂停，不再对着一具尸体做预测', seen.paused === true, `paused=${seen.paused}`);
    await sleep(3000);
    const still = await page.evaluate(() => ({ o: document.getElementById('announce').style.opacity, t: document.getElementById('announce').textContent }));
    ok('这条提示不会自己淡掉（玩家回来时还能看到原因）', still.o === '1' && /断开|失联/.test(still.t), JSON.stringify(still));
    // 反证：服务活着的时候不该冒出这个提示（否则"看到断开"只是永远红的横幅）
    ok('反证：断开之前那个横幅不存在', st.state === 'play' && !st.lost, JSON.stringify(st));
    ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 3).join(' ⏐ '));
  }

  console.log('\n── B：连接还在，但对端不发包了（半开） ──');
  {
    const { srv, page, logs, st } = await boot(browser, 'b');
    ok('先决：这一页正常在收快照，且没报断开', !st.lost && st.snaps > 5, JSON.stringify(st));
    // 把下行的*处理*掐掉而不动 socket —— 那正是半开在客户端这一侧的样子：字节不再进来，
    // 而 TCP 连接看起来完好，浏览器永远不会触发 onclose。
    const cut = await page.evaluate(() => { const nn = window.game.net; nn.ws.onmessage = () => {}; return { gap: +(nn.snapGap || 0).toFixed(2), snaps: nn.snaps }; });
    ok('掐之前看门狗读数是零（否则 2.5 秒阈值是从半路开始算的）', cut.gap < 0.5, JSON.stringify(cut));
    await sleep(4200);
    const after = await page.evaluate(() => {
      const a = document.getElementById('announce');
      return {
        lost: window.game.net.lost || null, why: window.game.net.lostReason, gap: +window.game.net.snapGap.toFixed(2),
        connected: window.game.net.connected, readyState: window.game.net.ws.readyState,
        text: a.textContent, opacity: a.style.opacity, snaps: window.game.net.snaps,
      };
    });
    ok('半开连接被看门狗认出（2.5 秒没快照 ⇒ 失联，而不是继续假装活着）', after.lost === 'stale', JSON.stringify(after));
    ok('它是看门狗报的，不是 onclose（socket 还开着：readyState=1、connected=true）',
      after.connected === true && after.readyState === 1, JSON.stringify({ c: after.connected, rs: after.readyState }));
    ok('失联走同一条横幅', /失联/.test(after.text) && after.opacity === '1', JSON.stringify(after.text));
    ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 3).join(' ⏐ '));
    srv.kill();
  }

  console.log('\n── C：进场被服务端拒绝（房间已满）—— 原因要显示出来，不是挂死 ──');
  {
    // MAX_CLIENTS=1 ⇒ 第二个访客一定被拒。这条路径落在 onControl 的 err 分支上，而它曾引用
    // 了一个类方法里根本不存在的 rej（那是 connect() 里 Promise 执行函数的局部变量）——
    // 症状不是报错而是**永远停在"正在连接对局服务…"**：throw 发生在 clearTimeout 之后，
    // 于是 connect() 既没 resolve 也没 reject，await 挂死。两头都要断言：页面上有原因、且没 pageerror。
    const srv = await withServer({ MAX_CLIENTS: '1' });
    const first = await newPage(browser, srv, 'cap-c');
    let gotIn = false;
    for (let i = 0; i < 160; i++) {
      gotIn = await first.page.evaluate(() => !!(window.game && window.game.net && window.game.net.cid));
      if (gotIn) break;
      await sleep(250);
    }
    ok('先决：第一个访客进得去（否则"第二个被拒"只是服务没起来的假象）', gotIn);

    const second = await newPage(browser, srv, 'cap-c');
    let text = '';
    for (let i = 0; i < 160; i++) {
      text = await second.page.evaluate(() => (window.game && window.game.menu && window.game.menu.el && window.game.menu.el.textContent) || '');
      if (/已满|失败/.test(text)) break;
      await sleep(250);
    }
    const diag = await second.page.evaluate(() => ({
      marks: window.__marks || [], closed: (window.game.net || {}).closedInfo || null,
      lost: (window.game.net || {}).lost || null, welcome: !!(window.game.net || {}).welcome,
      rs: window.game.net && window.game.net.ws ? window.game.net.ws.readyState : -1,
    }));
    const log = srv.log().split(/\r?\n/).filter(l => /join|leave|\[ws|\[wss|error|满/i.test(l)).slice(-4).join(' ⏐ ');
    const extras = JSON.stringify({ text: text.trim().slice(0, 46), closed: diag.closed, lost: diag.lost, rs: diag.rs }) + '  ‖ 服务端日志: ' + log;
    ok('被拒的原因出现在页面上（房间已满，而不是"连接超时"这种含糊话）', /已满/.test(text), extras);
    const j0 = diag.marks.find(m => /正在连接/.test(m[1]));
    const j1 = diag.marks.find(m => /连接失败/.test(m[1]));
    // 为什么不拿"隔了几秒"当判据：本机实测光 WebSocket 握手就能吃掉 3 秒多（后台标签页里），
    // 时长会把正常的加载也判成红。而"服务端已经说了原因"和"我们放弃并猜是超时"是两句不同的
    // 话 —— 那就直接看落在页面上的是哪一句。（上一版就是拿时长当判据，红得没有信息量。）
    ok('说的是那句拒绝，不是我们自己放弃猜的超时/关连接', !!j0 && !!j1 && /已满/.test(j1[1]) && !/超时|连不上|关连接|WebSocket/.test(j1[1]),
      JSON.stringify({ start: j0 && j0[0], fail: j1 && j1[1] }));
    ok('原因里没夹"连接超时"（那句话会把人往自己网线上引）', !/连接超时|WebSocket 错误/.test(text), extras);
    ok('进场被拒不标成"打着打着断了"：还没进过世界，HUD 横幅不该和加载页抢话', !diag.lost, extras);
    ok('被拒之后 socket 是我们自己拆的（迟到的 welcome 造不出僵尸局）', diag.rs === 3 || diag.rs === 2, `readyState=${diag.rs}`);
    ok('页面没有真错误（rej 越界这一类就靠这条抓住）', realErrs(second.logs).length === 0, second.logs.slice(0, 3).join(' ⏐ '));
    srv.kill();
  }
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  bad++; n++;
} finally {
  await browser.close();
}
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过`);
process.exit(bad ? 1 : 0);
