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
const only = (process.argv[2] || 'ABCDE').toUpperCase();
const skip = t => !only.includes(t);

const realErrs = (logs) => logs.filter(l => !/favicon|WebGL|AudioContext|pointer lock|ERR_NETWORK|ERR_INTERNET|Failed to load/i.test(l));

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
    console.log('\n── E：联机入口在菜单里，不用手打网址 ──');
    // 联机的代码早就在了，但要玩家自己敲 ?online=1&room=… 才算真的有这个模式吗？不算。
    // 这一段就从主菜单开始用鼠标点：联网对战 → 填呼号 → 选阵营 → 加入对局，看它到不到得了局内。
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
    await page.click('[data-a=online]');
    await sleep(500);
    const form = await page.evaluate(() => ({
      name: !!document.querySelector('#onName'), team: document.querySelectorAll('#onTeam div').length,
      room: !!document.querySelector('#onRoom'), join: !!document.querySelector('[data-a=join]'),
      screen: (window.game.menu || {}).screen,
    }));
    ok('联网大厅给出呼号 / 阵营 / 房间号三项，还有"加入对局"', form.name && form.team === 2 && form.room && form.join && form.screen === 'online', JSON.stringify(form));
    ok('反证：光是站在大厅里还没连服务器（进了大厅不等于已经进场）',
      await page.evaluate(() => !window.game.net || !window.game.net.connected), '');
    await page.fill('#onName', '菜单甲');
    await page.click('#onTeam div[data-v="B"]');
    await page.click('[data-a=join]');
    let landed = null;
    for (let i = 0; i < 200; i++) {
      landed = await page.evaluate(() => {
        const g = window.game, n = g && g.net;
        return { url: location.search, cid: n && n.cid, team: n && n.team, name: n && n.name, state: g && g.state, snaps: n && n.snaps };
      });
      if (landed.cid && landed.snaps > 3) break;
      await sleep(250);
    }
    ok('点"加入对局"之后真的换页进了局内（拿到 cid 且在收快照）',
      /online=1/.test(landed.url) && !!landed.cid && landed.snaps > 3, JSON.stringify(landed).slice(0, 150));
    ok('大厅里选的阵营带进了对局（B 队不是写在表单上就完事）', landed.team === 'B', 'team=' + landed.team + ' url=' + landed.url);
    ok('呼号带进去了（服务端按白名单收 2~16 字，中文不该被截坏）', landed.name === '菜单甲', JSON.stringify(landed.name));
    ok('没填房间时不往 URL 里塞 room=（让服务端去做 fill-first 分配）', !/room=/.test(landed.url), landed.url);
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
