// 掉线会被"看见"吗 —— 断网/服务器重启时的玩家体验。
//
// 原来是这样的：NetClient 往 events 里塞一条 disconnected，而没人读 events ⇒
// 世界静止、屏幕上一个字都没有，玩家以为是自己卡了。上线后这必然是第一条工单。
//
// 三条掉线路径分开测，因为它们的成因和触发者都不同：
//   A 连接真的关了（进程被杀、网络断）  → ws 的 onclose        → lost='closed'
//   B 连接还在但对端不发包了（半开）    → 只能自己数快照间隔   → lost='stale'
//   C 压根没进得去（房间已满/在维护）   → welcome 之前的 err   → 加载页给原因
// 另有两段不在这三条里：D 存档被手改坏之后能不能起、装备听谁的；J 大厅层断线与房名转义。
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
  // （`test/docs-guard.mjs` 的 G 段拿这一档当判据，浏览器判据逐个核）。
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
  // query 可以整段换掉：J 段量的是大厅层的断线，那一页要停在大厅屏而不是直接进对局
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

// 只想跑某一段的时候：node test/net-drop.mjs D —— 一次全跑要几分钟，迭代等不起。
// 2026-10-18 测试瘦身：默认只保留 A–D（掉线/半开/拒进/坏存档）与 J（大厅层断线 + 房名转义）。
// 原来的 E（大厅→房间→开局）由 room-flow 覆盖、F（账号闸）与 I（恢复码 UI）由 accounts /
// hardening 覆盖、G（加 Bot 开一局）由 room-bots 覆盖；H（补人 UI）移除后补人当前没有专项判据
// （见 docs/net-vs-local-gaps.md 已收表里那条注记）。
const only = (process.argv[2] || 'ABCDJ').toUpperCase();
const skip = t => !only.includes(t);

const realErrs = (logs) => logs.filter(l => !/favicon|WebGL|AudioContext|pointer lock|ERR_NETWORK|ERR_INTERNET|Failed to load/i.test(l));

// 这一份里造出来的每个页面都记在这儿，供 closeOpened() 收尾。
const OPENED = [];

// 收掉已经跑完那几段留下的页面。为什么每段结束都要收 —— 2026-09-26 实测：
// 这几段各留一个还在渲染的画布页，同一浏览器里攒到 6 个时，后面的页只剩 **2 fps**
// （单独跑一段是 6 fps）。这时 Playwright 的 locator.click 会**在 30 秒里不返回**，
// 调用日志停在 "performing click action"，一条 "element intercepts pointer events" 都没有 ——
// 那就不是"被别的东西盖住"，而是派发这条路没回来。同一时刻同一个页面上：
//   · evaluate 往返 1 ms ⇒ 事件循环是好的，不是页面卡死；
//   · bringToFront() 之后再点，照样挂 ⇒ 不是"这一页不在最前面"；
//   · page.mouse.click 能点进去，page.close() 也是毫秒级 ⇒ 是那段派发路径在重载下不行。
// 所以修法不是改判据（那会变成把"入口点不动"这条悄悄放过），而是**让每个用例自己收尾**。
// 2026-10-18 又量了一次：同一份判据从 96.3s 降到 41.8s，全绿 —— 省下的是页面空转的 CPU。
async function closeOpened() {
  const keep = OPENED.splice(0, OPENED.length);
  for (const o of keep) {
    try { await o.page.close(); } catch { /* 已经关掉的就算了 */ }
    try { await o.ctx.close(); } catch { /* 同上 */ }
  }
  if (keep.length) console.log(`  （收掉已结束段落的 ${keep.length} 个页面）`);
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
    await closeOpened();
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
    await closeOpened();
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
    await closeOpened();
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
    await closeOpened();
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
