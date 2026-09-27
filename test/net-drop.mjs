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
  for (const [label, opts] of [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }]]) {
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
const only = (process.argv[2] || 'ABCDEF').toUpperCase();
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
    console.log('\n── E：联机入口在菜单里 —— 房间列表，不用手打网址 ──');
    // 联机的代码早就在了，但要玩家自己敲 ?online=1&room=… 才算真的有这个模式吗？不算。
    // 这一段就从主菜单开始用鼠标点：联网对战 →（访客服直接进）房间列表大厅 → 填房名建一间 →
    // 进局内，再回头查 /api/rooms —— 大厅那张列表必须和服务端的清单是同一份东西。
    // 先收掉前面几段的页面：这一段是唯一要点鼠标的，而"6 个画布页同时软件渲染"会让
    // Playwright 的点击派发卡住 —— 读数与排除过程见文件开头 closeOpened() 的注释。
    await closeOpened();
    const srv = await withServer(GUEST);
    // 视口给成玩家真会用的大小：480×270 是其余几段为了软件渲染快用的，那种尺寸下
    // 菜单本来就滚不到按钮，拿它来点"加入对局"只会量到视口，量不到入口。
    const { page, logs } = await newPage(browser, srv, 'menu-e', null, '', { width: 1280, height: 720 });
    for (let i = 0; i < 200; i++) {
      const ready = await page.evaluate(() => !!(window.game && window.game.menu && window.game.menu.el && window.game.menu.el.querySelector('[data-a=online]')));
      if (ready) break;
      await sleep(250);
    }
    const hasEntry = await page.evaluate(() => !!document.querySelector('[data-a=online]'));
    ok('主菜单上有"联网对战"这一项（不是只能靠 ?online=1 的隐藏入口）', hasEntry);
    // 先决：这一页还答得上话。没有它的话，"按钮点不动"与"页面自己卡住了"分不开 ——
    // 而这两件事一个是入口坏了、一个是我们自己的量具在重载下失效（上次的红就属于后者）。
    await page.bringToFront();
    const t0 = Date.now();
    await page.evaluate(() => 1);
    const rt = Date.now() - t0;
    ok('先决：E 页还答得上话（卡死的页面上"点不动"归因不到入口）', rt < 500, `evaluate 往返 ${rt} ms`);
    await page.click('[data-a=online]');
    // 层级路由要等策略回来才落定（访客服直接进大厅；策略未知时先过一拍"正在进入联网对战…"）
    let form = null;
    for (let i = 0; i < 40; i++) {
      form = await page.evaluate(() => ({
        rows: !!document.querySelector('#roomRows'), quick: !!document.querySelector('[data-a=quick]'),
        create: !!document.querySelector('[data-a=create]'), refresh: !!document.querySelector('[data-a=refresh]'),
        title: !!document.querySelector('#roomTitle'),
        name: !!document.querySelector('#onName'), team: document.querySelectorAll('#onTeam div').length,
        gate: !!document.querySelector('#acctPw'),
        screen: (window.game.menu || {}).screen,
      }));
      if (form.screen === 'online') break;
      await sleep(250);
    }
    ok('联网大厅是房间列表：列表区 + 刷新 + 创建并进入 + 快速加入，阵营/呼号还在',
      form.rows && form.quick && form.create && form.refresh && form.title && form.name && form.team === 2 && form.screen === 'online', JSON.stringify(form));
    ok('层级：访客可玩的服**跳过注册页**，直接进大厅（反证臂 —— 要账号的服才过闸，见 F 段）',
      form.screen === 'online' && !form.gate, JSON.stringify(form));
    ok('反证：光是站在大厅里还没连服务器（进了大厅不等于已经进场）',
      await page.evaluate(() => !window.game.net || !window.game.net.connected), '');
    // 进对局 URL 的拼装是纯函数（menu.onlineJoinParams）：两条都能**不点按钮**就量到 ——
    // 真点一下是整页导航，"没塞 room="这件事到了结果页上已经看不见了，
    // 而"按钮没接线"和"接了线但参数拼错"在结果页上是同一副长相。
    const urls = await page.evaluate(() => ({
      auto: String(window.game.menu.onlineJoinParams({ room: '', title: '', team: 'A', name: '士兵', guest: true })),
      created: String(window.game.menu.onlineJoinParams({ room: 'r1a2b3', title: '菜单甲的房', team: 'B', name: '菜单甲', guest: true })),
    }));
    ok('没选房间时 URL 不带 room=（让服务端去做 fill-first 分配）', !/room=/.test(urls.auto), urls.auto);
    ok('建房时 URL 带 room= 与 title=（房名是显示名，不是房号）',
      /room=r1a2b3/.test(urls.created) && /title=/.test(urls.created), urls.created);
    // 真点一次"创建并进入"：按钮要真的把人送进局内（"按钮存在" ≠ "接线了"）
    // 呼号框照旧要填（访客服上它是这一局的显示名）—— 判据"呼号带进去了"量的就是这一步的接线。
    await page.fill('#onName', '菜单甲');
    await page.fill('#roomTitle', '菜单甲的房');
    await page.click('#onTeam div[data-v="B"]');
    await page.click('[data-a=create]');
    let landed = null;
    for (let i = 0; i < 200; i++) {
      landed = await page.evaluate(() => {
        const g = window.game, n = g && g.net;
        return { url: location.search, cid: n && n.cid, team: n && n.team, name: n && n.name, state: g && g.state, snaps: n && n.snaps };
      });
      if (landed.cid && landed.snaps > 3) break;
      await sleep(250);
    }
    ok('点"创建并进入"之后真的换页进了局内（拿到 cid 且在收快照，URL 带 room= 与 title=）',
      /online=1/.test(landed.url) && /room=/.test(landed.url) && /title=/.test(landed.url) && !!landed.cid && landed.snaps > 3, JSON.stringify(landed).slice(0, 150));
    ok('大厅里选的阵营带进了对局（B 队不是写在表单上就完事）', landed.team === 'B', 'team=' + landed.team + ' url=' + landed.url);
    ok('呼号带进去了（服务端按白名单收 2~16 字，中文不该被截坏）', landed.name === '菜单甲', JSON.stringify(landed.name));
    // 大厅那张列表必须和服务端的清单是**同一份东西** —— 进房之后反过来查 /api/rooms：
    // 刚建的那间（title=菜单甲的房）要在清单里，人数是活的。画一张假列表也能"看起来有房间"。
    const rooms = await page.evaluate(() => fetch('/api/rooms').then(r => r.json()).catch(e => ({ ok: false, err: String(e) })));
    const mine = (rooms.rooms || []).find(x => x.title === '菜单甲的房');
    ok('进房之后 /api/rooms 里看得见这间房（title 透出、人数是活的）',
      !!mine && mine.players >= 1, JSON.stringify(mine || rooms).slice(0, 150));
    ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 3).join(' ⏐ '));
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
    ok('主菜单上"联网对战"标着 🔒 注册后开放（不是假装开放、点了才拒）',
      entry.locked && /注册后开放/.test(entry.text), JSON.stringify(entry));
    await page.bringToFront();
    await page.click('[data-a=online]');
    // 等层级路由落定（策略未知时它会先进"正在进入联网对战…"，别把那一瞬间当注册页）
    let atGate = null;
    for (let i = 0; i < 40; i++) {
      atGate = await page.evaluate(() => ({
        screen: (window.game.menu || {}).screen,
        form: !!document.querySelector('#acctPw') && !!document.querySelector('[data-a=reg]'),
        rows: !!document.querySelector('#roomRows'),
        msg: ((document.querySelector('.gate-card') || {}).textContent || '').slice(0, 60),
      }));
      if (atGate.screen === 'onlineGate') break;
      await sleep(250);
    }
    ok('点入口先落在**注册页**（闸），且注册表单在、提示写着"注册后开放"',
      atGate.screen === 'onlineGate' && atGate.form && /注册后开放/.test(atGate.msg), JSON.stringify(atGate));
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
          rows: !!document.querySelector('#roomRows'),
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
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  bad++; n++;
} finally {
  await browser.close();
}
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过`);
process.exit(bad ? 1 : 0);
