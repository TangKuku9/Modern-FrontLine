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
import { DEFAULT_CLASSES } from '../js/data.js';

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 这四段量的是**掉线的可见性**（连接关掉、半开、进场被拒、存档被手改），
// 所以刻意用访客身份跑（REQUIRE_ACCOUNT=0）。账号与两道闸门由 test/hardening.mjs
// 专门量，不在这一份里重复 —— 在这里登一次录只会给每个用例多加一个无关的失败面。
// 不显式写这一条的话服务端默认要求登录，四段全会在"连不上"上红，而那看着像网络问题。
const GUEST = { REQUIRE_ACCOUNT: '0' };
let n = 0, bad = 0;
const ok = (label, cond, extra = '') => { n++; if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); };

async function launch() {
  // 三档依次试：系统 Chrome → **Playwright 自带的那一份**（不带 channel/executablePath，
  // 所以 `npx playwright install chromium` 装的就是它）→ 这台开发机上实际存在的那一份 1234
  // （Playwright 1.63 默认要 1243，机器上只有 1234）。中间这一档是**别人的机器能跑起来**的前提：
  // 少了它，README 里那句"没有 Chrome 的机器先 npx playwright install chromium"就是假的
  // （`test/docs-guard.mjs` 的 G 段拿这一档当判据，8 份浏览器判据逐个核）。
  const tries = [
    ['chrome', { channel: 'chrome', args: ARGS }],
    ['playwright-chromium', { args: ARGS }],
    ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }],
  ];
  for (const [label, opts] of tries) {
    try { return await chromium.launch(opts); } catch { /* 换下一个 */ }
  }
  throw new Error('没有可用浏览器');
}

const newPage = async (browser, srv, tag, profile, query, viewport) => {
  // 用 storageState 播 localStorage：它在任何页面脚本之前落地，比 initScript 少一层时机悬念。
  const ctx = await browser.newContext({
    viewport: viewport || { width: 480, height: 270 },
    storageState: {
      cookies: [], origins: [{
        origin: new URL(srv.base).origin,
        localStorage: [
          { name: 'mf_settings', value: JSON.stringify({ quality: 'low', volume: 0, fixedStep: true }) },
          ...(profile ? [{ name: 'mf_profile', value: JSON.stringify(profile) }] : []),
        ],
      }],
    },
  });
  const page = await ctx.newPage();
  OPENED.push({ ctx, page });
  const logs = [];
  page.on('pageerror', e => logs.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', m => { if (m.type() === 'error') logs.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    // 页面自己打的时间戳：记下加载页上出现过的每一句话。判据要的是"说的是服务端给的那句
    // 原因，还是我们自己放弃之后猜的那句" —— 隔了几秒量不出来（本机光握手就能 3 秒多）。
    window.__marks = [];
    const re = /正在连接对局服务|连接失败/;
    new MutationObserver(() => {
      const t = document.body && document.body.textContent || '';
      const m = re.exec(t);
      // 连句子一起截：只存匹配到的那几个字（"连接失败"）等于没说原因，判据就成了空断言
      if (m && window.__marks.length < 400) window.__marks.push([Math.round(performance.now()), t.slice(m.index, m.index + 46)]);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  // query 可以整段换掉：E 段量的是"从主菜单点进联机"，那第一页就不该带 ?online=1
  // name 必须是合法呼号（≥2 字）：这一份跑在访客可玩的服上，那条路上服务端会用注册的同一个
  // 白名单验自报呼号，单字会被**拒绝进场**。详见 test/net-play.mjs 的 openPage 注释。
  await page.goto(`${srv.base}/index.html${query === undefined ? '?online=1&room=' + tag + '&name=访客甲&team=A' : query}`, { waitUntil: 'domcontentloaded' });
  return { page, logs, ctx };
};

// 起一套"服务 + 页面"，并等到真的进了对局、拿到了快照
async function boot(browser, tag) {
  const srv = await withServer(GUEST);
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

// 只想跑某一段的时候：node test/net-drop.mjs D —— 一次全跑要五分钟，迭代等不起。
// 默认跑的是 A–F 加上 H（房间屏上"补人"那一格，十几秒、不拉对局）、I
// （账号闸上的"忘了密码？"，只点按钮、不进对局）与 J（大厅层断线，同样不进对局）。
// G（加 Bot 打一局）留在默认之外：它要开一局真的对局，一次全跑更慢 ——
// 想验它就显式写 node test/net-drop.mjs G。
const only = (process.argv[2] || 'ABCDEFHIJ').toUpperCase();
const skip = t => !only.includes(t);

const realErrs = (logs) => logs.filter(l => !/favicon|WebGL|AudioContext|pointer lock|ERR_NETWORK|ERR_INTERNET|Failed to load/i.test(l));

// 这一份里造出来的每个页面都记在这儿，供 closeOpened() 收尾。
const OPENED = [];

// 收掉前面几段留下的页面。为什么要有这一步 —— 2026-09-26 实测（E 段点不动那次）：
// 这几段各留一个还在渲染的画布页，到 E 段时同一浏览器里开着 6 个，E 页只剩 **2 fps**
// （单独跑这一段是 6 fps）。这时 Playwright 的 locator.click 会**在 30 秒里不返回**，
// 调用日志停在 "performing click action"，一条 "element intercepts pointer events" 都没有 ——
// 那就不是"被别的东西盖住"，而是派发这条路没回来。同一时刻同一个页面上：
//   · evaluate 往返 1 ms ⇒ 事件循环是好的，不是页面卡死；
//   · bringToFront() 之后再点，照样挂 ⇒ 不是"这一页不在最前面"；
//   · page.mouse.click 能点进去，page.close() 也是毫秒级 ⇒ 是那段派发路径在重载下不行。
// 单跑 `node test/net-drop.mjs E` 每次都绿，也就是"没有其余 5 个画布页"这个状态是好的。
// 所以修法不是改判据（那会变成把"入口点不动"这条悄悄放过），而是**让每个用例自己收尾**。
async function closeOpened() {
  const keep = OPENED.splice(0, OPENED.length);
  for (const o of keep) {
    try { await o.page.close(); } catch { /* 已经关掉的就算了 */ }
    try { await o.ctx.close(); } catch { /* 同上 */ }
  }
  if (keep.length) console.log(`  （收掉前面几段留下的 ${keep.length} 个页面）`);
}

const browser = await launch();
try {
  if (!skip('A')) {
    console.log('\n── A：连接被关掉（进程被杀 / 网络断） ──');
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

  if (!skip('B')) {
    console.log('\n── B：连接还在，但对端不发包了（半开） ──');
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

  if (!skip('C')) {
    console.log('\n── C：进场被服务端拒绝（房间已满）—— 原因要显示出来，不是挂死 ──');
    // MAX_CLIENTS=1 ⇒ 第二个访客一定被拒。这条路径落在 onControl 的 err 分支上，而它曾引用
    // 了一个类方法里根本不存在的 rej（那是 connect() 里 Promise 执行函数的局部变量）——
    // 症状不是报错而是**永远停在"正在连接对局服务…"**：throw 发生在 clearTimeout 之后，
    // 于是 connect() 既没 resolve 也没 reject，await 挂死。两头都要断言：页面上有原因、且没 pageerror。
    const srv = await withServer({ ...GUEST, MAX_CLIENTS: '1' });
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
  if (!skip('D')) {
    console.log('\n── D：存档被手改坏之后，页面还起得来吗、装的是哪一份装备 ──');
    // 这一段量两件事：
    //   (1) mf_profile 是玩家能自己编辑的文件，里面一个不存在的枪 id 会让菜单在
    //       new Menu → buildScene → buildGun 里抛，整页停在"初始化失败"—— 这是写这段测试时
    //       量到的一条真缺陷，js/loadout.mjs:repairClass 修的就是它。
    //   (2) 玩家身上那份装备必须就是服务端回声的那个对象（用对象同一判，不用深比较：
    //       两端共用同一张表之后深比较永远成立，那就什么都没量到）。
    // 闸门本身的重建规则由 server/deploy-probe.mjs 用原始 ws 帧量 —— 浏览器发不出非法配装，
    // 因为它自己就先按同一张表修好了。
    const srv = await withServer(GUEST);
    // 五套职业是 Game 构造函数守着的不变量（js/main.js:65：classes.length<5 就整套换回默认），
    // 所以"越权"只能长在一份合法形状的 profile 里 —— 只给一套的话读到的全是系统预设，
    // 这一段会全绿而什么都没量到（上一版就是这么错的，我还先怪到了 Playwright 头上）。
    const evil = {
      xp: 0, selClass: 0, campaignBest: null, streaks: ['uav', 'cluster', 'heli'],
      classes: [
        {
          name: '越权兵', primary: 'desert_eagle', patt: { optic: 'sniper', muzzle: 'nope' }, pcamo: 'gold+',
          secondary: 'rpg', satt: {}, scamo: 'none', lethal: 'nuke', tactical: 'stim',
          perks: ['ghost', 'ghost', 'ninja', 'sleight', 'doubletime'], extraLethal: 1e9, extraTac: 1e9,
        },
        ...DEFAULT_CLASSES.slice(1),
      ],
    };
    const { page, logs } = await newPage(browser, srv, 'gear-d', evil);
    let st = null;
    for (let i = 0; i < 160; i++) {
      st = await page.evaluate(() => {
        const g = window.game;
        if (!g || !g.net || !g.net.cid || !g.player || g.state !== 'play') {
          const n = (g || {}).net || {};
          return { ready: false, closed: n.closedInfo || null, lost: n.lost || null, echo: n.welcome ? n.welcome.loadout : null,
            text: (((g && g.menu) || {}).el || {}).textContent ? String(g.menu.el.textContent).replace(/\s+/g, ' ').slice(0, 40) : '' };
        }
        const pl = g.player;
        return {
          ready: true, echo: g.net.welcome.loadout, same: pl.loadout === g.net.welcome.loadout,
          asked: (JSON.parse(localStorage.getItem('mf_profile') || 'null') || {}).classes && (JSON.parse(localStorage.getItem('mf_profile') || 'null')).classes[0],
          slots: pl.ws.slots.map(s => s.id), lethal: pl.lethal && pl.lethal.count,
          tactical: pl.tactical && pl.tactical.count, perks: [...pl.perks],
        };
      });
      if (st.ready || /失败/.test(st.text || '')) break;
      await sleep(250);
    }
    ok('先决：手改坏的存档没把页面打死 —— 照样进了对局（这条就是那起白屏的回归）', st.ready, JSON.stringify(st).slice(0, 160));
    // 这条是"量具读的是哪份配装"：五套职业那条例外（js/main.js:65）会把只给一套的 profile
    // 整套换回系统预设，于是下面每条量的都不是我以为的那份。
    ok('先决：那份越权申请真的写进了这台浏览器（否则下面每条量的都是默认职业）',
      !!st.asked && st.asked.primary === 'desert_eagle' && st.asked.extraLethal === 1e9, JSON.stringify(st.asked).slice(0, 120));
    ok('非法主武器被修成 m4、合法的 rpg 副武器留着，服务端回声与这份一致',
      st.slots && st.slots[0] === 'm4' && st.slots[1] === 'rpg', JSON.stringify({ slots: st.slots, echo: st.echo }));
    ok('投掷物数量回到表里的值（职业卡上的 extraLethal 进不了网络形状）', st.lethal === 2 && st.tactical === 1, `lethal=${st.lethal} tactical=${st.tactical}`);
    ok('perk 去重、剔未知、限三件', st.perks && st.perks.length === 3 && st.perks[0] === 'ghost', JSON.stringify(st.perks));
    ok('非法 camo 与不允许的配件被筛干净（m4 上挂不了高倍狙击镜）',
      !!st.echo && st.echo.primary.camo === 'none' && Object.keys(st.echo.primary.att).length === 0, JSON.stringify(st.echo && st.echo.primary));
    // 对象同一，不是深比较：两端共用同一张表之后，"装了自己那份"的实现深比较也照样成立。
    ok('玩家身上那份就是服务端回声的**那个对象**（两套 stats 的口子从这里堵）', st.same === true, JSON.stringify({ same: st.same }));
    ok('页面没有真错误（白屏那起就是 buildGun 读 undefined.model 抛的）', realErrs(logs).length === 0, logs.slice(0, 2).join(' ⏐ '));
    srv.kill();
  }
  if (!skip('E')) {
    console.log('\n── E：联机的层级 —— 大厅 → 房间（准备 / 房主开始）→ 对局 → 回房间 ──');
    // 这一整段走的是 CF 那条路，而且**全程不换页**：一条 WebSocket 从大厅一路带到对局。
    // 一局压到 25 秒（MATCH_SECONDS）、打完当场回房（MATCH_RETURN_MS=0）—— 不压这两格，
    // "局末回房间"要真等十分钟才验得到，而它恰好是新增的那条"到点也判结束"
    // （server/room.mjs 每秒那次 checkEnd）唯一的症状级证据。
    await closeOpened();
    const srv = await withServer({ ...GUEST, MATCH_SECONDS: '25', MATCH_RETURN_MS: '0' });
    const V = { width: 1280, height: 720 };
    const A = await newPage(browser, srv, 'lobby-a', null, '', V);
    const B = await newPage(browser, srv, 'lobby-b', null, '', V);
    const a = A.page, b = B.page;
    // arg 必须显式传进页面：page.evaluate 只带走这个函数本身，带不走它的闭包。
    // 引用了外层变量的那一版会在页面里抛 ReferenceError，而下面的 .catch(() => null) 把它
    // 咽成"条件还没满足" —— 症状就是"轮询到超时、一条错误都没有"，最难查的那种红。
    const wait = async (page, fn, ms = 30000, arg = undefined) => {
      const t0 = Date.now();
      for (;;) {
        const v = await page.evaluate(fn, arg).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(250);
      }
    };
    let hall = null;
    for (let i = 0; i < 200; i++) { if (await a.evaluate(() => !!document.querySelector('[data-a=online]'))) break; await sleep(250); }
    ok('主菜单上有"联网对战"这一项（不是只能靠 ?online=1 的隐藏入口）', await a.evaluate(() => !!document.querySelector('[data-a=online]')));
    await a.bringToFront();
    await a.click('[data-a=online]');
    ok("点进去落在**大厅**：房间列表 + 全服频道 + 建房/快速加入，且这一屏没有注册表单",
      !!(hall = await wait(a, () => {
        const f = { s: (window.game.menu || {}).screen, rows: !!document.querySelector("#lbRows"), chat: !!document.querySelector("#lbChat"),
          create: !!document.querySelector("[data-a=create]"), quick: !!document.querySelector("[data-a=quick]"),
          name: !!document.querySelector("#onName"), gate: !!document.querySelector("#acctPw") };
        return f.s === "online" && f.rows && f.chat && f.create && f.quick && f.name && !f.gate ? f : null;
      })), JSON.stringify(hall));
    ok('反证：光是站在大厅里还没连上服务器（进了大厅不等于已经进场）',
      await a.evaluate(() => !window.game.net || !window.game.net.connected));
    // 模式那一格是**承诺**：列表里别人按它挑房 —— 界面上给得出的每一种，服务端都必须
    // 判得出胜负（给一格判不了的 = 点进去 0:0 打到时间耗尽的假玩法，闸门见 test/room-flow）。
    // 三种模式如今各有各的胜负规则（tdm/ffa/dom），判据改成"与服务端开放的集合**一字不差**"：
    // 少一格（界面对不上服务端）和多一格（假承诺）都红。
    ok('建房屏的模式选择器与服务端开放的玩法一字不差（多给一格少给一格都红）',
      await a.evaluate(async () => {
        const { MP_MODES } = await import('/js/data.js');
        const s = document.querySelector('#segMode');
        return !!s && s.textContent.replace(/\s+/g, '') === MP_MODES.filter(m => m.net).map(m => m.name).join('');
      }),
      await a.evaluate(() => (document.querySelector('#segMode') || {}).textContent));
    await a.screenshot({ path: 'test/lobby-hall.png' });
    await a.fill('#onName', '菜单甲');
    await a.fill('#lbSay', '有人一起玩吗');
    await a.press('#lbSay', 'Enter');
    await a.fill('#roomTitle', 'midnight');
    await a.click('#segMap div[data-v=frost]');
    await a.click('[data-a=create]');
    ok('建房之后落在**房间屏**：两队座位栏 + 房间频道 + 底部三个动作',
      !!(await wait(a, () => (window.game.menu || {}).screen === 'onlineRoom'
        && document.querySelectorAll('#seatA .seat, #seatB .seat').length >= 2
        && !!document.querySelector('#rmChat') && !!document.querySelector('[data-a=start]') && !!document.querySelector('[data-a=leave]'))));
    ok('房间设置那一格与服务端开放的玩法一字不差（房主点不到服务端判不了的）',
      await a.evaluate(async () => {
        const { MP_MODES } = await import('/js/data.js');
        const s = document.querySelector('#rmMode');
        return !!s && s.textContent.replace(/\s+/g, '') === MP_MODES.filter(m => m.net).map(m => m.name).join('');
      }),
      await a.evaluate(() => (document.querySelector('#rmMode') || {}).textContent));
    ok('一个人的时候不给开局，且把原因写在按钮旁边（不是把按钮藏起来）',
      await a.evaluate(() => { const s = document.querySelector('[data-a=start]'); return !!s && s.disabled === true && /至少/.test((document.querySelector('#rmWhy') || {}).textContent || ''); }),
      JSON.stringify(await a.evaluate(() => ({ d: (document.querySelector('[data-a=start]') || {}).disabled, why: (document.querySelector('#rmWhy') || {}).textContent }))));
    await a.screenshot({ path: 'test/lobby-room-solo.png' });

    await b.bringToFront();
    await b.click('[data-a=online]');
    ok('第二个人在大厅里**看得见那间房**（房名、地图、人数是服务端推的，不是本地编的）',
      !!(await wait(b, () => {
        const row = (document.querySelector('#lbRows [data-room=midnight]') || {}).closest && document.querySelector('#lbRows [data-room=midnight]').closest('.room-row');
        return row && { meta: row.querySelector('.rr-meta').textContent, n: row.querySelector('.rr-n').textContent, state: row.querySelector('.rr-state').textContent };
      })), JSON.stringify(await b.evaluate(() => { const r = (document.querySelector('#lbRows [data-room=midnight]') || { closest: () => null }).closest('.room-row'); return r && { meta: r.querySelector('.rr-meta').textContent, n: r.querySelector('.rr-n').textContent, state: r.querySelector('.rr-state').textContent }; })));
    ok('大厅里那个人也看得见全服频道刚说的那句', await wait(b, () => [...document.querySelectorAll('#lbChat .chat-line')].some(x => /有人一起玩吗/.test(x.textContent))));
    await b.fill('#onName', '菜单乙');
    await b.click('#lbRows [data-room=midnight]');
    ok('加入之后两个人在**同一间房**里，各自数得出两个座位',
      !!(await wait(a, () => document.querySelectorAll('#seatA .seat:not(.empty), #seatB .seat:not(.empty)').length === 2))
      && !!(await wait(b, () => document.querySelectorAll('#seatA .seat:not(.empty), #seatB .seat:not(.empty)').length === 2)));
    ok('服务端把人分到空着的那一队（不是两队都从 A 开始挤）',
      await b.evaluate(() => (window.game.lobby.state.me || {}).team === 'B'), 'team=' + await b.evaluate(() => (window.game.lobby.state.me || {}).team));
    await b.bringToFront();
    await b.fill('#rmSay', '我来了，等一下');
    await b.press('#rmSay', 'Enter');
    ok('房间频道只有房里的人收得到（这句话房主那边要出现）',
      await wait(a, () => [...document.querySelectorAll('#rmChat .chat-line')].some(x => /我来了/.test(x.textContent))));
    await b.click('[data-a=ready]');
    ok('第二个人点准备之后，房主那边的开始按钮当场变可点',
      await wait(a, () => { const s = document.querySelector('[data-a=start]'); return s && s.disabled === false && /都准备好/.test((document.querySelector('#rmWhy') || {}).textContent || ''); }));
    await a.bringToFront();
    await a.screenshot({ path: 'test/lobby-room-both.png' });
    // 按下开始之前先在这条连接上装一个''看客''监听器：这一句之后如果没进对局，判据要能
    // 自己说清是**服务端没回 welcome**、**回了 err**、还是**客户端在换世界时抛了**。
    // 少了这份现场，''没进对局''这一条红就只能靠猜（第一版就是这么连红三轮）。
    await a.evaluate(() => {
      window.__f = [];
      const lb = window.game.lobby;
      lb.ws.addEventListener('message', ev => { if (typeof ev.data === 'string') window.__f.push(ev.data.slice(0, 150)); });
      window.addEventListener('unhandledrejection', e => window.__f.push('REJECT ' + String((e.reason && e.reason.message) || e.reason)));
      // 再往里一层：onBegin 到底进没进、进去之后是同步抛还是异步抛。
    });
    await b.evaluate(() => {
      window.__f = [];
      const lb = window.game.lobby;
      lb.ws.addEventListener('message', ev => { if (typeof ev.data === 'string') window.__f.push(ev.data.slice(0, 120)); });
    });
    await a.click('[data-a=start]');
    const played = async (page, team) => wait(page, (t) => {
      const g = window.game, n = g.net;
      return g.state === 'play' && n && n.cid && n.snaps > 5 && n.team === t && !document.querySelector('.lobby');
    }, 40000, team);
    ok('房主按下开始之后**两个人都进了对局**（拿到 cid 且在收快照）', !!(await played(a, 'A')) && !!(await played(b, 'B')),
      'A 侧 ' + JSON.stringify(await a.evaluate(() => ({ s: game.state, snaps: game.net && game.net.snaps, tail: (window.__f || []).slice(-1) }))).slice(0, 200) + ' | B 侧 ' + JSON.stringify(await b.evaluate(() => ({ s: game.state, snaps: game.net && game.net.snaps, tail: (window.__f || []).slice(-1) }))).slice(0, 200))
    ok('进对局**没有换页也没有重连**：对局用的就是大厅那一条 WebSocket',
      await a.evaluate(() => !!(window.game.net && window.game.net.ws === window.game.lobby.ws && window.game.lobby.connected)),
      'same-socket=' + await a.evaluate(() => !!(window.game.net && window.game.net.ws === window.game.lobby.ws)));
    ok('房里选的地图带进了对局（不是服务端那一张默认图）',
      await a.evaluate(() => !!window.game.net && window.game.net.mapId === 'frost'), 'map=' + await a.evaluate(() => window.game.net && window.game.net.mapId));
    await a.screenshot({ path: 'test/lobby-match.png' });
    ok('局末自动回房间：回到房间屏、对局已经拆掉、座位还在',
      !!(await wait(a, () => (window.game.menu || {}).screen === 'onlineRoom' && window.game.state === 'menu' && !window.game.net && document.querySelectorAll('#seatA .seat:not(.empty), #seatB .seat:not(.empty)').length === 2, 60000))
      && !!(await wait(b, () => (window.game.menu || {}).screen === 'onlineRoom' && window.game.state === 'menu', 60000)));
    ok('回房间之后准备状态清零（下一局要重新点准备）',
      await b.evaluate(() => (window.game.lobby.state.me || {}).ready === false)
      && await a.evaluate(() => (window.game.lobby.state.me || {}).ready === true));
    await b.click('[data-a=ready]');
    await a.bringToFront();
    await a.click('[data-a=start]');
    ok('房主能接着开第二局（同一批座位、同一条连接）', !!(await played(a, 'A')) && !!(await played(b, 'B')));
    ok('页面没有真错误', realErrs(A.logs).length === 0 && realErrs(B.logs).length === 0, [...A.logs, ...B.logs].slice(0, 2).join(' ⏐ '));
    srv.kill();
  }

  if (!skip('F')) {
    console.log('\n── F：未完成注册前，联网对战不开放（层级：注册页 → 房间列表）──');
    // 这一段刻意用**默认配置**（要账号 + 邀请码）—— 那道闸只在那种服上存在。
    // 与 E 段互为反证臂：同一个入口，访客服（E）直接进大厅、要账号的服（F）先落在注册页。
    // 判据量的是**层级**：注册页上没有房间列表（先过闸再看房），大厅里没有注册表单（注册是前置，
    // 不是大厅的一部分）—— 只量"锁没锁"的话，把两块东西锁在同一屏上也能全绿，而那正是要拆掉的。
    await closeOpened();
    const srv = await withServer({ JOIN_CODE: 'SESAME' });
    const { page, logs } = await newPage(browser, srv, 'menu-f', null, '', { width: 1280, height: 720 });
    for (let i = 0; i < 200; i++) {
      const ready = await page.evaluate(() => !!(window.game && window.game.menu && window.game.menu.el && window.game.menu.el.querySelector('[data-a=online]')));
      if (ready) break;
      await sleep(250);
    }
    // 账号状态是**按需拉**的（js/main.js 的 accountSync）—— 锁标取决于"这个服要不要账号 +
    // 我登没登录"，两格都要等它回来。等待点是 accountSync() 这个 promise 本身，不是轮询
    // statusKnown 那个中间态：statusKnown 置位时 me() 还没回来、updateOnlineEntry 还没跑，
    // 全量跑（机器忙、/api/me 慢）时就量到"还没画锁"的瞬间 —— 第一版在 test:browser 里就是
    // 这么红过一次（单跑 F 每次都绿）。await 链上的回调按注册顺序执行，showMain 注册得早，
    // 所以 evaluate 返回时锁标一定已经画完。
    await page.evaluate(() => window.game.accountSync());
    const entry = await page.evaluate(() => {
      const b = document.querySelector('[data-a=online]');
      return { locked: !!(b && b.classList.contains('locked')), text: (b && b.textContent || '').trim().slice(0, 60) };
    });
    // 这条量的是"入口带着锁标、且文案里说了注册这件事"，**不钉死具体措辞** ——
    // 钉死五个字的话，每改一次 UI 文案就要改一次判据，而这条真正要看的是"锁没锁"。
    // （🔒 与"注册"两格只要还在，换任何说法都仍然红得起来；把锁标删掉就红。）
    ok('主菜单上"联网对战"标着 🔒（不是假装开放、点了才拒），且写明需要注册',
      entry.locked && /🔒/.test(entry.text) && /注册/.test(entry.text), JSON.stringify(entry));
    await page.bringToFront();
    await page.click('[data-a=online]');
    // 等层级路由落定（策略未知时它会先进"正在进入联网对战…"，别把那一瞬间当注册页）
    let atGate = null;
    for (let i = 0; i < 40; i++) {
      atGate = await page.evaluate(() => ({
        screen: (window.game.menu || {}).screen,
        form: !!document.querySelector('#acctPw') && !!document.querySelector('[data-a=reg]'),
        rows: !!document.querySelector('#lbRows'),
        msg: ((document.querySelector('.gate-card') || {}).textContent || '').slice(0, 60),
      }));
      if (atGate.screen === 'onlineGate') break;
      await sleep(250);
    }
    ok('点入口先落在**注册页**（闸），注册表单在，且这一屏写明要注册',
      atGate.screen === 'onlineGate' && atGate.form && /注册/.test(atGate.msg), JSON.stringify(atGate));
    ok('层级①：注册页上**没有房间列表**（先过闸再看房，不是两块锁在一屏上）', !atGate.rows, JSON.stringify(atGate));
    // 权限不在"哪一屏"里：服务端对没会话的清单请求直接 401。客户端只是把闸画出来 ——
    // 把它删掉也进不了场（这就是 ② 的服务端那一半）。
    const anon = await page.evaluate(async () => {
      const r = await fetch('/api/rooms');
      return { status: r.status, body: (await r.text()).slice(0, 120) };
    });
    ok('服务端也不给没注册的人房间清单（401，且响应里没有 rooms）',
      anon.status === 401 && !/rooms/.test(anon.body), JSON.stringify(anon));
    // 过闸 = 在注册页上办身份，办完**自动前进**到大厅（下一步不该让玩家自己找）
    await page.fill('#onName', '菜单乙');
    await page.fill('#acctPw', 'a-long-enough-password');
    await page.fill('#acctCode', 'SESAME');
    await page.click('[data-a=reg]');
    let inLobby = null;
    for (let i = 0; i < 80; i++) {
      inLobby = await page.evaluate(async () => {
        const r = await fetch('/api/rooms');
        return {
          screen: (window.game.menu || {}).screen,
          rows: !!document.querySelector('#lbRows'),
          regForm: !!document.querySelector('#acctPw'),
          create: !!(document.querySelector('[data-a=create]') || {}).disabled,
          status: r.status,
        };
      });
      if (inLobby.screen === 'online' && inLobby.rows && !inLobby.regForm) break;
      await sleep(250);
    }
    ok('注册之后**自动进大厅**（不用自己找下一步），房间列表在、创建可点、服务端给清单',
      inLobby && inLobby.screen === 'online' && inLobby.rows && !inLobby.create && inLobby.status === 200,
      JSON.stringify(inLobby));
    ok('层级②：大厅里**没有注册表单**（注册是前置，不是大厅的一部分）',
      !!inLobby && !inLobby.regForm, JSON.stringify(inLobby));
    // 层级③：登出 = 退回闸那一屏（身份没了，大厅不该给没身份的人看）
    await page.click('[data-a=logout]');
    let back = null;
    for (let i = 0; i < 40; i++) {
      back = await page.evaluate(() => ({ screen: (window.game.menu || {}).screen, form: !!document.querySelector('#acctPw') }));
      if (back.screen === 'onlineGate') break;
      await sleep(250);
    }
    ok('层级③：登出退回注册页（身份没了就回闸，不留在大厅里）',
      back && back.screen === 'onlineGate' && back.form, JSON.stringify(back));
    ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 3).join(' ⏐ '));
    srv.kill();
  }
  if (!skip('G')) {
    console.log('\n── G：房主在房间屏上加 Bot，一个人也能开一局 ──');
    // 这一段的判据是**看得见**：房主一个人加了 3 个 Bot 之后开局，他屏幕上要真的出现
    // 3 个远端实体。少了这一条，"Bot 进了权威端却没编进快照"那种失效会全绿 ——
    // 而它的症状是最糟的一种：房主加了一屋子 Bot，进去一个也看不见，然后被看不见的东西打死。
    // 服务端那一半（包长、重生、记分板）在 test/room-bots.mjs，真连接的名单规则在 room-flow 的 I 段。
    await closeOpened();
    const srv = await withServer(GUEST);
    const V2 = { width: 1280, height: 720 };
    const A = await newPage(browser, srv, 'bots-a', null, '', V2);
    const a = A.page;
    const wait = async (page, fn, ms = 30000, arg = undefined) => {
      const t0 = Date.now();
      for (;;) {
        const v = await page.evaluate(fn, arg).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(250);
      }
    };
    for (let i = 0; i < 200; i++) { if (await a.evaluate(() => !!document.querySelector('[data-a=online]'))) break; await sleep(250); }
    await a.bringToFront();
    await a.click('[data-a=online]');
    await wait(a, () => (window.game.menu || {}).screen === 'online' && !!document.querySelector('[data-a=create]'));
    await a.fill('#onName', '房主甲');
    await a.click('[data-a=create]');
    await wait(a, () => (window.game.menu || {}).screen === 'onlineRoom' && !!document.querySelector('[data-a=start]'));

    ok('只有房主看得见"+ Bot"那两个按钮（不是摆给所有人点、点了才拒）',
      await a.evaluate(() => document.querySelector('[data-a=addA]').style.display !== 'none'
        && document.querySelector('[data-a=addB]').style.display !== 'none'),
      JSON.stringify(await a.evaluate(() => ({ a: document.querySelector('[data-a=addA]').style.display, b: document.querySelector('[data-a=addB]').style.display }))));
    ok('一个人的时候不给开局（这一格是下面每一条的起点）',
      await a.evaluate(() => document.querySelector('[data-a=start]').disabled === true));

    await a.click('[data-a=addA]');
    await a.click('[data-a=addA]');
    await a.click('[data-a=addB]');
    const seats = await wait(a, () => {
      const all = [...document.querySelectorAll('#seatA .seat[data-bid], #seatB .seat[data-bid]')];
      return all.length === 3 ? all.map(el => ({
        name: el.querySelector('.s-name').textContent,
        team: el.closest('#seatA') ? 'A' : 'B',
        tag: el.querySelector('.s-tag').textContent,
        st: el.querySelector('.s-st').textContent,
      })) : null;
    });
    ok('点了三下，两队各多出几行 Bot（名字与队伍都画出来了）',
      !!seats && seats.filter(s => s.team === 'A').length === 2 && seats.filter(s => s.team === 'B').length === 1,
      JSON.stringify(seats));
    ok('Bot 那一行标着"Bot"，房主那一行写明"点击移除"（一行和人长得一样的话没人知道能点）',
      !!seats && seats.every(s => s.tag === 'Bot' && s.st === '点击移除'), JSON.stringify(seats && seats.map(s => s.tag + '/' + s.st)));
    ok('加了 Bot 之后一个人就能开局（这正是这一项存在的理由）',
      await a.evaluate(() => document.querySelector('[data-a=start]').disabled === false
        && /都准备好|可以开始/.test((document.querySelector('#rmWhy') || {}).textContent || '')),
      JSON.stringify(await a.evaluate(() => ({ d: document.querySelector('[data-a=start]').disabled, why: (document.querySelector('#rmWhy') || {}).textContent }))));
    ok('标题上把 Bot 数单写出来（只写"4 人"的话，点进去只看见一个人，像列表算错了）',
      /3 Bot/.test(await a.evaluate(() => (document.querySelector('#rmMeta') || {}).textContent || '')),
      await a.evaluate(() => (document.querySelector('#rmMeta') || {}).textContent));
    // 难度那一格：有 Bot 之后才画出来（空房子里摆一个 Bot 选择器 = "选了就会自动加 Bot"）
    ok('房间设置里多出 Bot 难度那一行，且能改',
      await a.evaluate(() => !!document.querySelector('#rmBot') && /正规军/.test(document.querySelector('#rmBot').textContent)),
      await a.evaluate(() => (document.querySelector('#rmBot') || {}).textContent));
    const botNames = await a.evaluate(() => (window.game.lobby.state.bots || []).map(b => b.name));
    await a.screenshot({ path: 'test/lobby-room-bots.png' });

    await a.click('[data-a=start]');
    ok('房主一个人也进了对局（拿到 cid、在收快照）',
      !!(await wait(a, () => window.game.state === 'play' && window.game.net && window.game.net.cid && window.game.net.snaps > 5, 40000)),
      JSON.stringify(await a.evaluate(() => ({ s: game.state, snaps: game.net && game.net.snaps }))));
    // ── 这一段的命门 ──
    const seen = await wait(a, () => window.game.net.remotes.size >= 3 ? [...window.game.net.remotes.values()].map(r => ({ name: r.name, team: r.team })) : null, 20000);
    ok('屏幕上真的出现 3 个远端实体（Bot 没编进快照的话这里是 0，而它照样在开枪）',
      !!seen && seen.length === 3, JSON.stringify(seen));
    ok('它们的名字就是房主在房间屏上加的那几个（不是服务端另起的一套）',
      !!seen && seen.every(s => botNames.includes(s.name)), JSON.stringify({ added: botNames, seen: seen && seen.map(s => s.name) }));
    ok('分在房主指定的那两队（A 队 2 个、B 队 1 个）',
      !!seen && seen.filter(s => s.team === 'A').length === 2 && seen.filter(s => s.team === 'B').length === 1,
      JSON.stringify(seen));
    // 反证臂：这些实体是**会动的**（插值在跑），不是建出来就杵在原地的空壳
    const moved = await (async () => {
      const p0 = await a.evaluate(() => [...window.game.net.remotes.values()].map(r => [+r.pos.x.toFixed(3), +r.pos.z.toFixed(3)]));
      await sleep(2500);
      const p1 = await a.evaluate(() => [...window.game.net.remotes.values()].map(r => [+r.pos.x.toFixed(3), +r.pos.z.toFixed(3)]));
      return p0.length === 3 && p0.some((p, i) => Math.hypot(p[0] - p1[i][0], p[1] - p1[i][1]) > 0.2);
    })();
    ok('【反证】这 3 个实体在自己走（Bot 在权威端跑，位置经插值送到屏幕上）', moved);
    await a.bringToFront();
    await a.screenshot({ path: 'test/lobby-match-bots.png' });
    ok('页面没有真错误', realErrs(A.logs).length === 0, A.logs.slice(0, 2).join(' ⏐ '));
    srv.kill();
  }
  if (!skip('H')) {
    console.log('\n── H：房间屏上的"补人"那一格（点了就补满，一个人也能开） ──');
    // 与上一节正好相反的一条：Bot **难度**那一行要有 Bot 才画，而"补人"这一行在空房里
    // 也必须画出来 —— 也等有 Bot 才画的话，房主永远造不出第一个 Bot：他把自己锁在门外了。
    // 所以这一节第一条（先决）不是形式主义，它是这一格唯一的死法。
    // 服务端那一半（谁让位、三种关法、数得出来的计数）在 room-flow 的 L 段。
    await closeOpened();
    const srv = await withServer(GUEST);
    const A = await newPage(browser, srv, 'fill-a', null, '', { width: 1280, height: 720 });
    const a = A.page;
    const wait = async (page, fn, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await page.evaluate(fn).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(250);
      }
    };
    for (let i = 0; i < 200; i++) { if (await a.evaluate(() => !!document.querySelector('[data-a=online]'))) break; await sleep(250); }
    await a.bringToFront();
    await a.click('[data-a=online]');
    await wait(a, () => (window.game.menu || {}).screen === 'online' && !!document.querySelector('[data-a=create]'));
    await a.fill('#onName', '补人甲');
    await a.click('[data-a=create]');
    await wait(a, () => (window.game.menu || {}).screen === 'onlineRoom' && !!document.querySelector('[data-a=start]'));

    const fill0 = await a.evaluate(() => {
      const el = document.querySelector('#rmFill');
      return el ? { txt: el.textContent, sel: (el.querySelector('.sel') || {}).textContent, bots: (window.game.lobby.state.bots || []).length } : null;
    });
    ok('【先决】空房里也有"补人"那一行、且停"手动"（有 Bot 才画的话，房主永远造不出第一个 Bot）',
      !!fill0 && fill0.sel === '手动' && fill0.bots === 0, JSON.stringify(fill0));
    ok('难度那一行此时**不该**在（两行的条件相反，摆在一起才看得出来不是随手画的）',
      await a.evaluate(() => !document.querySelector('#rmBot')));

    await a.click('#rmFill div[data-v="1"]');
    const filled = await wait(a, () => {
      const all = [...document.querySelectorAll('#seatA .seat[data-bid], #seatB .seat[data-bid]')];
      return all.length === 15 ? { rows: all.length, bots: all.filter(el => (el.querySelector('.s-tag') || {}).textContent === 'Bot').length } : null;
    });
    ok('点"补满"：座位栏当场补出 15 行 Bot（1 人 + 15 = 16，服务端那个上限）',
      !!filled && filled.bots === 15, JSON.stringify(filled));
    ok('补满之后开始按钮就亮了（一个人也能开一局，这正是这一格存在的理由）',
      await a.evaluate(() => document.querySelector('[data-a=start]').disabled === false
        && (document.querySelector('#rmFill .sel') || {}).textContent === '补满'
        && window.game.lobby.state.fill === true),
      JSON.stringify(await a.evaluate(() => ({ d: document.querySelector('[data-a=start]').disabled, sel: (document.querySelector('#rmFill .sel') || {}).textContent }))));
    await a.screenshot({ path: 'test/lobby-room-fill.png' });

    await a.click('#rmFill div[data-v="0"]');
    const kept = await wait(a, () => {
      const all = [...document.querySelectorAll('#seatA .seat[data-bid], #seatB .seat[data-bid]')];
      return (all.length === 15 && window.game.lobby.state.fill === false) ? { rows: all.length, sel: (document.querySelector('#rmFill .sel') || {}).textContent } : null;
    });
    ok('再点"手动"：这一格回到手动、服务端那格也变 false，场上的 15 行**留着**（关 = 不再补，不是把补出来的删掉）',
      !!kept && kept.sel === '手动', JSON.stringify(kept));
    ok('页面没有真错误', realErrs(A.logs).length === 0, A.logs.slice(0, 2).join(' ⏐ '));
    srv.kill();
  }
  if (!skip('I')) {
    console.log('\n── I：账号闸上的「忘了密码？」（恢复码横幅） ──');
    // 这一段量的是**客户端那一半**：闸的两种形态、切形态时名字不许被擦、码只在
    // 注册/重设那两条响应里出现一次、抄错时空格与 0/O 1/l 的分辨。
    // 服务端那一半（哈希、一次性、会话作废、限流、CLI、审计）在 test/hardening.mjs 的 J 段
    // 和 test/accounts.mjs 的 K 段；**这一段一条都不重复**，它只回答"人去点的时候看到了什么"。
    // 分工写在两边，是因为这一屏是那个功能的全部可见面：服务端做得再对，
    // 只要码没被摆到人眼前，这个功能就等于不存在。
    await closeOpened();
    const INV = 'DROP-INVITE', PW1 = 'first-password-ok', PW2 = 'second-password-ok';
    const srv = await withServer({ JOIN_CODE: INV, REQUIRE_ACCOUNT: '1' });
    const waitIn = async (page, fn, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await page.evaluate(fn).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(250);
      }
    };
    // 每张码都是 XXXX-XXXX-XXXX，且字母表里没有 I L O U（抄错的三个字都被换掉了）
    const codeShape = c => /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(c);
    const toGate = async (page) => {
      for (let i = 0; i < 200; i++) { if (await page.evaluate(() => !!document.querySelector('[data-a=online]'))) break; await sleep(250); }
      await page.bringToFront();
      await page.click('[data-a=online]');
      return waitIn(page, () => (window.game.menu || {}).screen === 'onlineGate' && !!document.querySelector('[data-a=forgot]'));
    };

    const A = await newPage(browser, srv, 'rec-a', null, '', { width: 1280, height: 720 });
    const a = A.page;
    ok('【先决】要账号的服上，从主菜单点进联机先落到账号闸（登录/注册两种按钮都在）',
      !!(await toGate(a)) && await a.evaluate(() => !!document.querySelector('[data-a=reg]') && !!document.querySelector('#acctCode')));

    await a.fill('#onName', '忘了甲');
    await a.click('[data-a=forgot]');
    const rf = await waitIn(a, () => {
      const el = document.querySelector('#acctRecov');
      return el ? { name: (document.querySelector('#onName') || {}).value, head: (document.querySelector('h1') || {}).textContent,
        invite: !!document.querySelector('#acctCode'), docover: !!document.querySelector('[data-a=docover]') } : null;
    });
    ok('点「忘了密码？」当场换成恢复表单：多出恢复码那一格、邀请码那一格消失、按钮换成"重设密码"',
      !!rf && /恢复码/.test(rf.head) && rf.invite === false && rf.docover === true, JSON.stringify(rf));
    ok('【反证】切形态时已经打好的呼号留着（被擦掉的话看起来像页面抽风）',
      !!rf && rf.name === '忘了甲', JSON.stringify(rf && rf.name));
    await a.click('[data-a=tologin]');
    const bk = await waitIn(a, () => {
      const el = document.querySelector('[data-a=reg]');
      return el ? { name: (document.querySelector('#onName') || {}).value, recov: !!document.querySelector('#acctRecov') } : null;
    });
    ok('再点「返回登录」切回来，名字**还在**、恢复码那一格收回去（切两次都不许擦）',
      !!bk && bk.name === '忘了甲' && bk.recov === false, JSON.stringify(bk));

    await a.fill('#acctPw', PW1);
    await a.fill('#acctCode', INV);
    await a.click('[data-a=reg]');
    const codesA = await waitIn(a, () => { const el = document.querySelector('#recovList'); return el ? el.innerText.split(/\s+/).filter(Boolean) : null; });
    ok('注册之后**先**把 5 张恢复码摆在大厅顶端（码只在这一次响应里，直接过去的话没人看见过这几张码）',
      !!codesA && codesA.length === 5 && codesA.every(codeShape), JSON.stringify(codesA));
    ok('这块横幅写着"只显示这一次"并劝人别截图（不写的话玩家会以为以后还能查到）',
      /只显示这一次/.test(await a.evaluate(() => document.body.innerText)) && /别截图/.test(await a.evaluate(() => document.body.innerText)));
    await a.bringToFront();
    await a.screenshot({ path: 'test/account-recovery-codes.png' });
    await a.click('[data-a=done]');
    const inLobby = await waitIn(a, () => (!!document.querySelector('[data-a=create]') ? { s: (window.game.menu || {}).screen, logged: !!(window.game.account || {}).loggedIn } : null));
    ok('点"抄好了"收掉横幅，人还在大厅里（而且这一页确实登录了，闸那一步没有被跳过）',
      !!inLobby && inLobby.logged === true, JSON.stringify(inLobby));
    ok('页面没有真错误', realErrs(A.logs).length === 0, A.logs.slice(0, 2).join(' ⏐ '));

    // ── 另一个客户端（干净存档）：走"忘了密码？"真重设一次 ──
    const B = await newPage(browser, srv, 'rec-b', null, '', { width: 1280, height: 720 });
    const b = B.page;
    await toGate(b);
    await b.click('[data-a=forgot]');
    await waitIn(b, () => !!document.querySelector('#acctRecov'));
    await b.fill('#onName', '忘了甲');
    await b.fill('#acctPw', PW2);
    await b.fill('#acctRecov', 'ZZZZ-ZZZZ-ZZZZ');
    await b.click('[data-a=docover]');
    const msg = await waitIn(b, () => {
      const t = ((document.querySelector('#acctMsg') || {}).textContent || '').trim();
      return t && t !== '正在重设…' ? t : null;
    });
    ok('码不对时把服务端那一句原样显示在表单里（不翻译、不吞成"失败了"）',
      msg === '呼号或恢复码不对', JSON.stringify(msg));
    // 故意抄得走形：小写 + 前后空格 + 把 0 抄成 o、1 抄成 l。
    // 这一条是**客户端与规范化函数合起来**才过得去的：填进去的是人的手，不是规范化的码。
    const messy = ' ' + codesA[3].toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l') + ' ';
    await b.fill('#acctRecov', messy);
    await b.click('[data-a=docover]');
    const codesB = await waitIn(b, () => { const el = document.querySelector('#recovList'); return el ? el.innerText.split(/\s+/).filter(Boolean) : null; });
    ok('真码（故意抄成小写 + 0→o / 1→l）能重设：当场换出新的一叠 5 张',
      !!codesB && codesB.length === 5 && codesB.every(codeShape), JSON.stringify(codesB));
    ok('【反证】新的一叠和老的那一叠**没有一张重合**（换了一整叠，不是把旧的又显示一遍）',
      !!codesB && !!codesA && codesA.every(c => !codesB.includes(c)),
      JSON.stringify({ old: codesA, now: codesB }));
    ok('这一屏的抬头写的是"密码已重设"（和"注册成功"那一屏分得开）',
      /密码已重设/.test(await b.evaluate(() => document.body.innerText)));
    await b.click('[data-a=done]');
    ok('重设完也直接进大厅（重设成功 = 一次登录）',
      !!(await waitIn(b, () => (!!document.querySelector('[data-a=create]') ? true : null))));
    ok('页面没有真错误', realErrs(B.logs).length === 0, B.logs.slice(0, 2).join(' ⏐ '));

    // ── 第三个客户端：旧密码必须登不上，新密码登上但**不再摆码** ──
    // "登不上"这一条是这一段的命门：不量它的话，"重设"可能只是**多了一个能用的密码**，
    // 而那样等于把找回变成了"多配一把钥匙"（被人捡到码之后，原主连改密码都赶不走他）。
    const C = await newPage(browser, srv, 'rec-c', null, '', { width: 1280, height: 720 });
    const c = C.page;
    await toGate(c);
    await c.fill('#onName', '忘了甲');
    await c.fill('#acctPw', PW1);
    await c.click('[data-a=login]');
    const oldMsg = await waitIn(c, () => {
      const t = ((document.querySelector('#acctMsg') || {}).textContent || '').trim();
      return t && t !== '正在登录…' ? t : null;
    });
    ok('【反证】用**旧**密码登录拿到"呼号或密码不对"，而且人还留在闸上（不是两个密码都能用）',
      oldMsg === '呼号或密码不对' && await c.evaluate(() => (window.game.menu || {}).screen === 'onlineGate'),
      JSON.stringify(oldMsg));
    await c.fill('#acctPw', PW2);
    await c.click('[data-a=login]');
    const okIn = await waitIn(c, () => (!!document.querySelector('[data-a=create]') ? { recovered: !!document.querySelector('#recovList') } : null));
    ok('用**新**密码登录直接进大厅，且**不再**摆一次恢复码（码只在那两条响应里存在，登录响应里不该有）',
      !!okIn && okIn.recovered === false, JSON.stringify(okIn));
    ok('页面没有真错误', realErrs(C.logs).length === 0, C.logs.slice(0, 2).join(' ⏐ '));
    await closeOpened();
    srv.kill();
  }

  if (!skip('J')) {
    console.log('\n── J：大厅层断线（房表要说话、点按钮不许卡在加载层、能重连） ──');
    // 起因（M9）：大厅这条连接断了之后**一个回调都没有** —— 房表不再刷、按钮静默失灵、
    // "正在进入大厅…"在已经断线时继续撒谎；而"正在进房…"那一层全屏加载更是永久卡死，
    // 唯一出路 F5。对局层早有 netLostUi（A/B/C 三段量的就是它），大厅层一直什么都没有。
    // 这一段量的是**玩家看得见的那个面**；LobbyClient 的语义（谁被通知、这一帧发出去没有）
    // 在 test/net-audit.mjs 的 H 段，两半不重复。
    await closeOpened();
    const srv = await withServer(GUEST);
    const { page, logs } = await newPage(browser, srv, 'hall-drop', null, '', { width: 1280, height: 720 });
    const wait = async (fn, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await page.evaluate(fn).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(250);
      }
    };
    // 「人在不在那张全屏加载页上」**不许**用 `.load-bar` 判：index.html 里那个启动用的
    // #loading 就带一个 .load-bar，它一直在 DOM 里 —— 拿它当判据的话，"没卡住"和"卡住了"
    // 读出来是同一个 true（第一版就是这么假红的三条）。真正的读数只有两格：
    // menu.screen === 'loading'，以及屏幕上有没有那一句"正在进房…"。
    const stuckNow = () => page.evaluate(() => ({
      want: !!window.game._wantRoom,
      screen: (window.game.menu || {}).screen,
      text: /正在进房/.test(document.body.textContent || ''),
    }));
    for (let i = 0; i < 200; i++) { if (await page.evaluate(() => !!document.querySelector('[data-a=online]'))) break; await sleep(250); }
    await page.bringToFront();
    await page.click('[data-a=online]');
    const up = await wait(() => {
      const lb = window.game.lobby;
      return (lb && lb.connected && (window.game.menu || {}).screen === 'online' && document.querySelector('[data-a=create]'))
        ? { rooms: (lb.rooms || []).length } : null;
    });
    ok('【先决】进了大厅、而且真的连上了（否则下面"断线之后…"量的是一个本来就断着的界面）', !!up, JSON.stringify(up));

    // ── ① 断线之后，房表那一格必须说人话 ──
    await page.evaluate(() => { window.game.lobby.ws.close(); });
    const told = await wait(() => {
      const r = document.querySelector('#lbRows'), re = document.querySelector('#lbRe');
      if (!r || !window.game.lobby || !window.game.lobby.lost) return null;
      return {
        txt: r.textContent.replace(/\s+/g, ''),
        re: !!re && getComputedStyle(re).display !== 'none',
        lost: window.game.lobby.lost,
      };
    });
    ok('【命门】断线之后房表那一格说的是"连接已断开"，而不是继续说"正在进入大厅…"（后者是一句会一直说下去的谎，而它是玩家唯一能看到发生了什么的地方）',
      !!told && /断开/.test(told.txt) && !/正在进入大厅/.test(told.txt) && told.lost === 'closed',
      JSON.stringify(told));
    ok('并且把「重新连接」摆出来（只说断开、不给出路的话，玩家能做的还是只有 F5）', !!(told && told.re), JSON.stringify(told));

    // ── ② 断着的时候点「创建房间」：不许盖上那一层加载页 ──
    await page.click('[data-a=create]');
    await sleep(500);
    const denied = await stuckNow();
    const errText = await page.evaluate(() => ((document.querySelector('#lbErr') || {}).textContent || '').trim());
    ok('【命门】断线时点「创建房间」：不盖加载页、_wantRoom 保持 false、人还站在大厅屏上，屏幕上有一句原因（改动前这一格是"帧静默丢掉 + 永久卡在正在进房…"）',
      denied.want === false && denied.screen === 'online' && denied.text === false && errText.length > 0,
      JSON.stringify(denied) + ' · ' + errText);

    // ── ③ 重新连接：不刷新页面就回得去 ──
    await page.screenshot({ path: 'test/lobby-lost.png' });
    await page.click('[data-a=relobby]');
    const back = await wait(() => {
      const lb = window.game.lobby;
      return (lb && lb.connected && !lb.lost && (window.game.menu || {}).screen === 'online' && document.querySelector('[data-a=create]'))
        ? { url: lb.url } : null;
    });
    ok('点「重新连接」回到连上的状态（不刷新页面 —— 房名、地图、装备选择、聊天框里没发完的字都还在）',
      !!back, JSON.stringify(back));

    // ── ⑤ 别人推来的房名 / 房号：拼进 innerHTML 之前必须转义（M10）──
    // 房间名是**玩家输入**、由服务端广播给所有人，而列表那一行是 innerHTML ——
    // 而且它比记分板更靠前：房名在**进房之前**就已经画在每个人屏幕上了。
    // 服务端的房名白名单眼下把标签字符洗掉了，所以这是纵深防御。
    // 判据用**往返恒等**（屏幕上那一格的字 === 我塞进去的原串）：少转一次会多出一个元素、
    // 多转一次会显示成 `&amp;` —— 两个方向都会被这一条同时抓住，比分别断言两种坏法更省。
    // 房号那一格单量**属性往返**：少转一个引号会把它劈成两个属性（值被截断）。
    const room = await page.evaluate(() => {
      const g = window.game;
      const XSS = 'A&B <img src=x onerror="window.__xssRoom=1">';
      const ID = `a'b"c`;
      delete window.__xssRoom;
      g.lobby.rooms = [{ id: ID, title: XSS, map: 'yard', mode: 'tdm', state: 'waiting', players: 1, max: 16, time: 10, ready: 0 }];
      g.menu.renderRooms();
      const rows = document.querySelector('#lbRows');
      const btn = rows.querySelector('[data-a=joinRow]');
      return {
        want: XSS, wantId: ID,
        n: rows.querySelectorAll('.room-row').length,
        injected: !!rows.querySelector('img'),
        text: (rows.querySelector('.rr-name') || {}).textContent || null,
        attr: btn ? btn.getAttribute('data-room') : null,
        xss: window.__xssRoom,
      };
    });
    ok('【命门】大厅列表里别人推来的房名一字不差地往返（它是最靠前的那个拼接点：进房之前就画在所有人屏幕上了）',
      room.n === 1 && room.injected === false && room.text === room.want && room.xss === undefined,
      JSON.stringify(room));
    ok('房号那一格的**属性往返**也要一字不差（少转一个引号会把它劈成两个属性、值被截断）',
      room.attr === room.wantId, JSON.stringify({ got: room.attr, want: room.wantId }));
    // 先决：这一格是活的 —— 同一串字（摘掉触发那一格、标签形状留着）裸着进 innerHTML
    // 必须真的多出一个元素。它红了说明上面两条量的是空气（比如 #lbRows 里根本没有那一行）。
    ok('【先决】同一串字裸着进 innerHTML 真的会多出一个元素（这条红了 = 上面两条是空断言）',
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.innerHTML = '<img src=x onerror="window.__xssRoom=1">'.replace(/onerror="[^"]*"/, '');
        const got = !!d.querySelector('img');
        d.remove();
        return got;
      }));

    // ── ④ 帧发出去了、应答永远不会来（审计里那一句"onRoomFrame/onlineError 都不会来"）──
    // 把 ws.send 换成空函数：LobbyClient 的 send() 照样返回 true（"发出去了"），
    // 而服务端永远收不到 ⇒ 应答永远不来。这不是造假：它正是"帧掉了"那一格，
    // 而且它把时机从"和服务端赛跑"变成**确定**的（真发真断的话，本机服务端有时先应答，
    // 那就变成"运气好就绿"的判据）。连接必须先是**连着**的（走真入口才过得了那道闸）。
    const pre = await page.evaluate(() => {
      const g = window.game, lb = g.lobby;
      lb.ws.send = () => {};
      g.menu.onlineCreate();                       // 真入口：发帧 + 盖"正在进房…" + _wantRoom=true
      const snap = { want: !!g._wantRoom, screen: g.menu.screen, text: /正在进房/.test(document.body.textContent || '') };
      setTimeout(() => lb.ws.close(), 60);          // 应答永远不会来，这时候连接才断
      return snap;
    });
    ok('【先决】这一格真的造出了"扣在加载页上"的现场（没造出来的话下面那条是空断言）',
      pre.want === true && pre.screen === 'loading' && pre.text === true, JSON.stringify(pre));
    const escaped = await wait(() => {
      // ⚠ 这里**不许**拿 `lb.lost` 当"收掉了没有"的读子：这一格被收掉的路径是
      // onlineError → showOnlineLobby()，而那一屏自己会在结尾再连一次
      // （这是改动前就有的行为：进大厅那一屏每次渲染都试着连一下）—— 于是
      // `g.lobby` 当场被换成一条**新的**连接，lost 从头到尾都是 null。
      // 第一版就是这么量出恒 null、干等到超时的（又是"读数取在对象被换掉之后"那一类）。
      // 要量的是玩家看得见的那三格：还扣着吗、在不在加载页上、屏幕上有字吗。
      const g = window.game;
      if (g._wantRoom) return null;
      return {
        screen: (g.menu || {}).screen,
        text: /正在进房/.test(document.body.textContent || ''),
        err: ((document.querySelector('#lbErr') || {}).textContent || '').trim(),
      };
    });
    ok('【命门】这一格必须被断线通知收掉：_wantRoom 落回 false、人回到大厅屏、加载页那句话不见了（改动前它永久停在"正在进房…"，唯一出路 F5）',
      !!escaped && escaped.screen === 'online' && escaped.text === false && escaped.err.length > 0,
      JSON.stringify(escaped));
    ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 2).join(' ⏐ '));
    await closeOpened();
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
