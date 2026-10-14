// 菜单层的键盘可达（docs/hud-ux-audit.md HU-06 的另一半）—— 真浏览器、真按键、真焦点。
//
// test/hud-ux.mjs 的 F 段只到**源码形状**：它证明接线在（Tab 拦在 play 分支里、键盘名单与
// 鼠标名单同一份 KEYPICK、Enter 不给原生按钮重复派 click）。它证明不了"键盘真的走得到"，
// 而那才是 HU-06 的症状本体。这一份量的是浏览器给的东西：按 Tab 之后焦点落在谁身上、
// 按 Enter 之后屏幕换没换、按 Esc 退了几层。
//
// 三条纪律：
//   ① 每条都配**反方向**的臂。只量"菜单里 Tab 能用"的话，把对局里的 Tab 一起放开照样全绿 ——
//      所以 E 段量的是"打得正热时焦点一步都不许动"（记分板那把键被抢走就是游戏被打断）。
//      D 段同理：既要证 Esc 退得了一层，也要证它不许一次退两层（把人从当前屏踢出去）。
//   ② 读数全取浏览器 / 取被测对象自己的状态：document.activeElement、getComputedStyle 的
//      outline、game.menu.screen、game.profile.classes[].primary —— 不读我们为了让测试好看而
//      新加的任何标记。
//   ③ 量具先自证活着：A1 先证"没按 Tab 之前焦点根本不在入口上"，B3 先证"计数器接得上"，
//      否则后面的"按了就到 / 只激活一次"都可能只是恒真。
//
// 联网那两屏（H/I 段）是第四批补上的：HU-06 当时欠的就是这一截 —— 大厅与房间屏要真服务端状态，
// 进程内那份（test/hud-ux.mjs 的 W~AB 段）量得到闸门、路由与"那一格写了什么字"，量不到
// 真 Tab 序列、真焦点落点、真滚轮、以及"服务端真的回了一句"。两边都不是半成品。
// 全程访客服（REQUIRE_ACCOUNT=0）：注册闸那一条路已经有 net-drop 覆盖，这里要的是能进大厅。
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, bad = 0;
const ok = (label, cond, extra = '') => { n++; if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  |  ' + extra : ''}`); };
const realErrs = l => l.filter(x => !/favicon|WebGL|AudioContext|pointer lock|ERR_NETWORK|ERR_INTERNET|Failed to load/i.test(x));

async function launch() {
  // 三档依次试（系统 Chrome → Playwright 自带的那一份 → 本机绝对路径），中间那一档是
  // "别人的机器能不能跑起来"的依据，由 test/docs-guard.mjs 的 G 段逐份核。
  const tries = [
    ['chrome', { channel: 'chrome', args: ARGS }],
    ['playwright-chromium', { args: ARGS }],
    ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }],
  ];
  for (const [, opts] of tries) { try { return await chromium.launch(opts); } catch { /* 换下一个 */ } }
  throw new Error('没有可用浏览器');
}

// 焦点落点读数：命中 KEYPICK 里任意一类就报它的 data-* 或 class（与 js/menu.js 那一份名单同形）。
// 名单在这里**抄了一份** —— page.evaluate 只把函数体搬到页面里，引用不到模块作用域，
// 这是 Playwright 的形状，不是懒。抄了就有漂的可能，所以 A2/C2 不比对名单字符串，
// 而是量行为：走不到就红。名单改了而这里没跟上，红的是"走不到"那一条，看得见。
const FOCUS_READ = () => {
  const PICK = '.mbtn,.btn,.pick,.cls,.slotc,.gs-att,.gs-slot,.mode,.mapc,.diff,.seg div,.camo';
  const ae = document.activeElement;
  const a = ae && ae.closest ? ae.closest(PICK) : null;
  if (!a) return { hit: '', cls: '', tag: ae ? ae.tagName : '', ring: false };
  const s = getComputedStyle(a);
  return {
    hit: String(a.dataset.a || a.dataset.i || a.dataset.id || a.dataset.w || a.dataset.g || a.className || ''),
    id: String(a.dataset.id || ''), cls2: String(a.className),
    cls: String(a.className), tag: a.tagName,
    ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2,
  };
};

const browser = await launch();
let srv = null;               // 提到 try 外面：CRASH 走 catch 就跳过了原来那句 srv.kill()，
// 一次调试跑完留一个 node 进程挂着端口。这一份要反复跑，攒下的进程就是"下一个人假红"的来源。
try {
  srv = await withServer({ REQUIRE_ACCOUNT: '0' });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    storageState: { cookies: [], origins: [{ origin: new URL(srv.base).origin, localStorage: [
      { name: 'mf_settings', value: JSON.stringify({ quality: 'low', volume: 0, fixedStep: true }) }] }] },
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('pageerror', e => logs.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', m => { if (m.type() === 'error') logs.push('console: ' + m.text()); });
  await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
  // 原生弹窗计数器（HU-29）：**不转调真的那一个** —— 转调会让浏览器弹窗把页面卡死在这里，
  // 判据反而量不出来。这一格要量的是"我们的代码还叫不叫浏览器要一条灰框"，叫了就计数。
  await page.addInitScript(() => {
    window.__nativeDialog = 0;
    for (const k of ['prompt', 'confirm', 'alert']) window[k] = () => { window.__nativeDialog++; return k === 'confirm' ? false : null; };
  });
  const wait = async (fn, ms = 20000, step = 120) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await page.evaluate(fn)) return true; await sleep(step); }
    return false;
  };
  await page.goto(`${srv.base}/index.html`);
  await page.waitForFunction(() => window.game && window.game.state === 'menu' && game.menu.screen === 'main', null, { timeout: 120000 });
  await sleep(1500);   // accountSync 回来会重画"联网对战"那一格，先让重绘过完再走焦点

  const tabTo = async (want, tries = 24) => {
    for (let i = 0; i < tries; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(FOCUS_READ);
      if (r.hit === want || (want.startsWith('.') && r.cls.includes(want.slice(1)))) return r;
    }
    return null;
  };

  // ── A 段：Tab 走得到主菜单的每一个入口 ──
  ok('A1【先决】没按 Tab 之前，焦点不在任何入口上（否则"按了就到"可以是恒真）',
    !(await page.evaluate(FOCUS_READ)).hit);
  const seen = []; let ring = false;
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(FOCUS_READ);
    if (r.hit) { seen.push(r.hit); if (r.ring) ring = true; }
  }
  const NEED = ['campaign', 'mp', 'online', 'loadout', 'settings'];
  ok('A2 按 Tab 走遍主菜单五个入口（键盘到得了，屏幕才读得到）',
    NEED.every(k => seen.includes(k)), NEED.filter(k => !seen.includes(k)).join(',') || '五个都走到');
  ok('A3 焦点环是真的（浏览器算出来的 outline ≥ 2px，不是我们自己在 class 上写个"看着像焦点"）', ring);

  // ── B 段：Enter 激活，Esc 回上一层 ──
  await page.evaluate(() => document.body.focus());
  const got = await tabTo('settings');
  ok('B1 能 Tab 走到「设置」那一格', !!got, got && got.hit);
  // 激活次数计数器：一次 Enter 只许点一次。原生 BUTTON 自己会派 click，
  // 我们那条委托 keydown 要是没跳过它，这里就会数到 2。
  await page.evaluate(() => { window.__ui = 0; const o = game.audio.ui.bind(game.audio);
    game.audio.ui = k => { if (k === 'click') window.__ui++; return o(k); }; });
  const uiBefore = await page.evaluate(() => window.__ui);
  await page.keyboard.press('Enter');
  await sleep(400);
  ok('B2 Enter 换屏：screen main → settings（全程没碰鼠标）',
    (await page.evaluate(() => game.menu.screen)) === 'settings');
  ok('B2b【先决】计数器接得上：这一次激活真的被记到',
    (await page.evaluate(() => window.__ui)) > uiBefore, `__ui ${uiBefore}→${await page.evaluate(() => window.__ui)}`);
  ok('B3【反方向臂】一次 Enter 只激活一次（委托给原生 BUTTON 重复派 click 会在这里变 2）',
    (await page.evaluate(() => window.__ui)) === uiBefore + 1);
  await page.keyboard.press('Escape');
  await sleep(400);
  ok('B4 Esc 从设置回主菜单（按的是这一屏本来就有的那个返回键，不是另写的一套去处）',
    (await page.evaluate(() => game.menu.screen)) === 'main');
  await page.keyboard.press('Escape');
  await sleep(300);
  ok('B5 主菜单上 Esc 什么都不做（ESC_EXIT 里没有 main —— 宁可没反应，不许一按把人踢出界面）',
    (await page.evaluate(() => [game.menu.screen, game.state].join('/'))) === 'main/menu');

  // ── C 段：配装屏与选枪覆盖层 ──
  await page.click('.mbtn[data-a=loadout]'); await sleep(600);
  ok('C0 进配装屏', (await page.evaluate(() => game.menu.screen)) === 'loadout');
  const before = await page.evaluate(() => game.profile.classes[game.menu.selClass].primary);
  await page.click('[data-w=primary]'); await sleep(500);
  ok('C1 选枪覆盖层开着', !!(await page.evaluate(() => document.querySelector('.picker'))));
  // 落在**当前那张卡**上换不换得动才是关键：走到一张与现在配装不同的卡上再按 Enter，
  // 于是 C3 量的不只是"profile 动了"，而是"profile 动成了我键盘选中的那一张"。
  const tabToOtherPick = async (cur, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(FOCUS_READ);
      if (r.cls2 && r.cls2.includes('pick') && r.id && r.id !== cur) return r;
    }
    return null;
  };
  const onPick = await tabToOtherPick(before);
  ok('C2 覆盖层里的卡片 Tab 走得到（它不走 render()，keyify 单独补的那一刀在这里见真章）', !!onPick);
  await page.keyboard.press('Enter'); await sleep(600);
  const after = await page.evaluate(() => game.profile.classes[game.menu.selClass].primary);
  ok('C3 Enter 选中的那张卡就是落进 profile 的那一把（量被测对象的状态，不是界面）',
    !!onPick && after === onPick.id, `${before} → ${after}·键盘选的是 ${onPick && onPick.id}`);
  ok('C4 选完自动收回配装屏', (await page.evaluate(() => game.menu.screen)) === 'loadout'
    && !(await page.evaluate(() => document.querySelector('.picker'))));
  await page.click('[data-w=primary]'); await sleep(500);
  await page.keyboard.press('Escape'); await sleep(500);
  ok('C5 Esc 只退一层：覆盖层合上，人还在配装屏',
    !(await page.evaluate(() => document.querySelector('.picker')))
    && (await page.evaluate(() => game.menu.screen)) === 'loadout');
  await page.keyboard.press('Escape'); await sleep(500);
  ok('C5b 再按一次才离开配装屏（一层是一层，不是一按到底）',
    (await page.evaluate(() => game.menu.screen)) === 'main');

  // ── D 段：枪匠的出路（以前必须"完成 → 返回"两跳）──
  await page.click('.mbtn[data-a=loadout]'); await sleep(600);
  await page.click('[data-g=primary]'); await sleep(700);
  ok('D0 进枪匠', (await page.evaluate(() => game.menu.screen)) === 'gunsmith');
  await page.keyboard.press('Escape'); await sleep(600);
  ok('D1 枪匠里按 Esc 走的是它自己那个"完成"（表里那一行写的是 data-a=done，不是又一个返回）',
    (await page.evaluate(() => game.menu.screen)) === 'loadout');

  // ── E 段：反方向 —— 打得正热时，焦点一步都不许动 ──
  await page.evaluate(() => { game.menu.showMain(); game.startGame('mp',
    { mode: 'tdm', map: 'dune', diff: 1, allies: 3, enemies: 3, scoreLimit: 200, timeLimit: 5 }); });
  await page.waitForFunction(() => game.state === 'play' && !game.paused, null, { timeout: 60000 });
  await sleep(2000);
  const actBefore = await page.evaluate(() => document.activeElement.tagName + '.' + document.activeElement.className);
  await page.keyboard.press('Tab'); await sleep(300);
  const actAfter = await page.evaluate(() => document.activeElement.tagName + '.' + document.activeElement.className);
  ok('E1 对局里按 Tab 焦点不动（记分板用的就是这把键，焦点被抢=游戏被打断）',
    actBefore === actAfter, `${actBefore} → ${actAfter}`);
  // 记分板是"按住 Tab"才在的（keyup 会收掉，main.js 那条 keyup 分支），所以这里必须 down/up 分开量。
  await page.keyboard.down('Tab'); await sleep(250);
  const sbUp = await page.evaluate(() => !document.getElementById('scoreboard').classList.contains('hidden'));
  await page.keyboard.up('Tab'); await sleep(250);
  const sbDown = await page.evaluate(() => document.getElementById('scoreboard').classList.contains('hidden'));
  ok('E1b【判别臂】按住 Tab 记分板真的出来、松开就收（拦焦点不等于拦功能 —— 这把键两半都得还在）',
    sbUp && sbDown, `按住=${sbUp}·松开=${sbDown}`);

  // ── G 段：HU-17 按住 Tab 的那一屏会不会自己更新（只有真浏览器量得到）──
  // 进程内那一份（test/hud-ux.mjs T 段）钉的是"重画路径在不在、松开拆不拆表、签名门、不叠表"；
  // 这一份量的是审计当时**量不出来**的那件事：旧写法只挂在 keydown 沿，之后靠不靠得住
  // OS 键重复取决于浏览器 —— 现在的判据是"不靠那个行为也照样在动"。
  await page.evaluate(() => {
    window.__sbLog = [];
    window.__sbObs = new MutationObserver(() => window.__sbLog.push(1));
    window.__sbObs.observe(document.getElementById('scoreboard'), { childList: true, subtree: true });
  });
  await page.keyboard.down('Tab'); await sleep(150);
  const html0 = await page.evaluate(() => document.getElementById('scoreboard').innerHTML);
  // 输入由这里给：等 Bot 自己在五秒里打死人是不成立的（dune 3v3 那一局 5 秒可以一个都不死，
  // 上一版就是这么红的）。改的是**被测对象读的那本账**（mode.ranking() 取的就是 bot.kills），
  // 断言的是界面跟没跟上 —— 不是把界面改成什么样再量它。
  const changed = await page.evaluate(() => {
    const before = game.mode.ranking().map(x => x.k + '/' + x.d).join(',');
    game.bots[0].kills += 3;
    return before !== game.mode.ranking().map(x => x.k + '/' + x.d).join(',');
  });
  await sleep(900);                       // 跨过至少一个 500ms 的重画点
  const cntHeld = await page.evaluate(() => window.__sbLog.length);
  const html1 = await page.evaluate(() => document.getElementById('scoreboard').innerHTML);
  ok('G1【先决】这一次改的数真的进了榜单的输入（少了这条，"榜没刷"与"数据没变"在同一把尺下长得一样）',
    changed === true && html0.length > 0, `changed=${changed}·榜面长度=${html0.length}`);
  ok('G1 按住不放、榜单数据一变 ⇒ 那一屏自己跟上（旧写法冻在按下那一刻，全靠 OS 键重复赌一把）',
    html1 !== html0 && cntHeld > 0, `改DOM=${cntHeld}次·榜面变了=${html1 !== html0}`);
  await page.keyboard.up('Tab'); await sleep(200);
  await page.evaluate(() => { window.__sbLog.length = 0; game.bots[0].kills += 9; });
  await sleep(1300);
  const cntAfter = await page.evaluate(() => window.__sbLog.length);
  ok('G2【反方向】松开之后那一屏必须停（定时器漏在 keyup 外 = 藏着的面板每 0.5 秒白拆一次 DOM）',
    cntAfter === 0, `松开后又写了 ${cntAfter} 次`);
  await page.evaluate(() => window.__sbObs.disconnect());

  // ── F 段：暂停也算菜单（服务端照跑那一段，玩家需要的正是能看能走的这一屏）──
  await page.evaluate(() => game.pause(true)); await sleep(700);
  ok('F0 暂停屏画出来了', (await page.evaluate(() => [game.paused, game.menu.screen].join('/'))) === 'true/pause');
  const onMbtn = await tabTo('resume');
  ok('F1 暂停屏里 Tab 走得到那几行（paused 时不再拦 —— 这一条被 main.js 那个 && !this.paused 钉着）',
    !!onMbtn, onMbtn && onMbtn.hit);
  await page.keyboard.press('Escape'); await sleep(600);
  ok('F2 暂停屏上 Esc 仍是继续（原有的 resume 没被新的"返回上一层"抢走）',
    (await page.evaluate(() => game.paused)) === false);

  // ── H 段：HU-24 / HU-25 / HU-26 联网大厅与房间屏（HU-06 当时欠的那一截）──
  await page.evaluate(() => game.exitToMenu()); await sleep(800);
  await page.click('.mbtn[data-a=online]');
  ok('H0【先决】进得了联网大厅，而"按房号加入"那一格真的画出来了（HU-24：原来只有"房名 + 创建 + 快速加入"三样）',
    await wait(() => (game.menu || {}).screen === 'online' && !!document.querySelector('#joinRoomId') && !!document.querySelector('[data-a=joinId]')),
    await page.evaluate(() => (game.menu || {}).screen));
  await page.evaluate(() => document.body.focus());
  const gotJoin = await tabTo('joinId');
  ok('H1 那一格 Tab 走得到（键盘路径是 HU-06 明确留给这一批的，不在进程内那份里半成品）', !!gotJoin, gotJoin && gotJoin.hit);

  await page.fill('#joinRoomId', 'no-such-room-9');
  await page.click('[data-a=joinId]');
  // 页内那一段每次都自己取（不能把 Node 侧的函数搬进 evaluate 的回调里 —— 那是上一版 CRASH 的原因：
  // `errRead` 在页面里根本不存在，而 CRASH 只会报一句 ReferenceError，看着像被测对象坏了）。
  ok('H2【真服务端】按一个不存在的房号：服务端那句原话上了屏，而不是"点了没反应"',
    await wait(() => /那间房已经不在了/.test((document.querySelector('#lbErr') || {}).textContent || '')),
    await page.evaluate(() => (document.querySelector('#lbErr') || {}).textContent || ''));
  ok('H2b 那句错误不再是 12px 的灰字（HU-25：那一格与旁边的说明文字长得分不出来）',
    (await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#lbErr')).fontSize))) >= 13,
    await page.evaluate(() => getComputedStyle(document.querySelector('#lbErr')).fontSize));
  await sleep(7200);                      // 跨过**原来那 6 秒**：旧写法在这里已经把话擦干净了
  ok('H2c【命门·真浏览器】7.2 秒之后那句话还在（进程内那份只能证明"没装定时器"，这一条证的是"人看得见"）',
    await page.evaluate(() => /那间房已经不在了/.test((document.querySelector('#lbErr') || {}).textContent || '')),
    await page.evaluate(() => (document.querySelector('#lbErr') || {}).textContent || ''));
  ok('H2d 而且它自带一个看得见的落点：那一格里有一个「知道了」',
    !!(await page.evaluate(() => document.querySelector('#lbErr [data-a=errack]'))));
  await page.click('#lbErr [data-a=errack]'); await sleep(300);
  ok('H3 「知道了」按下去那一格就空了（不蒸发 ≠ 不许关掉）',
    await page.evaluate(() => (((document.querySelector('#lbErr') || {}).textContent || '').trim() === '')),
    await page.evaluate(() => (document.querySelector('#lbErr') || {}).textContent || ''));

  await page.fill('#roomTitle', '键盘测试房');
  await page.click('[data-a=create]');
  ok('H4 建房照旧进得去房间屏（新加的那道本地闸门不许把正路也一起挡住）',
    await wait(() => (game.menu || {}).screen === 'onlineRoom' && !!document.querySelector('[data-a=start]')));
  const meta = await page.evaluate(() => (document.querySelector('#rmMeta') || {}).textContent || '');
  ok('H4b 房间屏那一行写着**房号**（起了中文房名的房，房号原来从屏幕上消失，朋友没地方抄它）',
    /房号\s*\S/.test(meta), meta.slice(-46));
  await page.click('[data-a=addA]');
  ok('H5 房主眼里 Bot 那一行带 data-bid（CSS 的 cursor/hover 就是按它设门的，所以"不发这个属性"真的等于"不高亮"）',
    await wait(() => !!document.querySelector('#seatA .seat[data-bid]')));
  ok('H5b Bot 那一行的 s-st 写着"点击移除" —— 一行和真人长得一样的名单，玩家得有办法知道哪个点得掉',
    /点击移除/.test(await page.evaluate(() => (document.querySelector('#seatA .seat[data-bid] .s-st') || {}).textContent || '')));

  await page.evaluate(() => { game.lobby.ws.close(); });
  ok('H6【命门·HU-26】连接一断，房间屏上就长出「重新连接」：断线时服务端那一班状态推送永远到不了，不主动补画的话玩家站的是一屏"看起来还在房间里"',
    await wait(() => { const b = document.querySelector('#rmRe'); return !!b && b.style.display !== 'none'; }));
  await page.evaluate(() => document.body.focus());
  const gotRe = await tabTo('reconnect');
  ok('H6b 那一格 Tab 走得到（键盘用户也要有这条出路，不是只摆给鼠标）', !!gotRe, gotRe && gotRe.hit);
  await page.click('#rmRe');
  ok('H6c 那句"还没连上大厅（或点「重新连接」）"在这一屏不是说谎：点它真能重建连接、人回到大厅',
    await wait(() => (game.menu || {}).screen === 'online' && !!(game.lobby && game.lobby.connected)));

  // ── I 段：HU-22 房主的「开始游戏」连点 ──
  await page.fill('#roomTitle', '连点测试');
  await page.click('[data-a=create]');
  await wait(() => (game.menu || {}).screen === 'onlineRoom');
  await page.click('[data-a=addA]');
  ok('I0【先决】房主 + 一个 Bot ⇒「开始游戏」可按（这一条红了，后面两条就是空断言）',
    await wait(() => { const s = document.querySelector('[data-a=start]'); return !!s && s.disabled === false; }));
  // 把 socket 那一层换成计数器：帧不真到服务端 ⇒ 这一局不会真的开起来（不用加载一张图来量一个按钮），
  // 而"第二下到底发没发出去"变成一个可以数的数。与 test/net-drop.mjs 的 ④ 同一手法。
  // 原生那一份先存起来（H7 段还要换一次计数器，测完得还得回去）。
  await page.evaluate(() => { window.__frames = []; window.__realSend = game.lobby.ws.send;
    game.lobby.ws.send = m => { window.__frames.push(String(m)); }; });
  await page.click('[data-a=start]'); await sleep(300);
  const label1 = await page.evaluate(() => (document.querySelector('[data-a=start]') || {}).textContent || '');
  const dis1 = await page.evaluate(() => !!(document.querySelector('[data-a=start]') || {}).disabled);
  await page.evaluate(() => { game.menu.roomStart(); game.menu.roomStart(); }); await sleep(300);
  const cnt1 = await page.evaluate(() => window.__frames.filter(f => /"t":"start"/.test(f)).length);
  ok('I1【命门·真浏览器】第一下之后那一格改口「正在开局…」并灰掉（旧写法：文案不动、连点三下发三帧）',
    /正在开局/.test(label1) && dis1 === true && cnt1 === 1, `label=${label1}·disabled=${dis1}·帧=${cnt1}`);
  const rel = await page.evaluate(() => {
    game.menu.onlineError('测试用：那句拒绝');
    const b = document.querySelector('[data-a=start]');
    const out = { label: b ? b.textContent : '', dis: !!(b || {}).disabled };
    game.menu.roomStart();
    out.n = window.__frames.filter(f => /"t":"start"/.test(f)).length;
    return out;
  });
  ok('I2【反方向臂】一句拒绝之后：那一格**当场**自己回到「开始游戏」（不用谁补一次重画），而再点发得出第二帧',
    /开始游戏/.test(rel.label) && rel.dis === false && rel.n === 2, JSON.stringify(rel));

  // ── H7 段：审计里那句"连点会发两帧 createRoom"，鼠标到底复现得了吗 ──
  // 数的是两个量：handler 进来了几次（`__cc`，包在 onlineCreate 上）与帧真发出去几帧（`__cf`，
  // 接在原生 ws.send 上）。只数帧的话"闸门挡下了第二下"与"第二下压根没落到那枚按钮上"
  // 在同一把尺下长得一样 —— 而这两件事在审计里是两个结论：前者说明闸门在干活，后者说明
  // 这条路上根本没有那个病。对照那一次把闸门临时换成"永远放行"再双击：handler 仍只进 1 次
  // ⇒ 复现不了，审计那句话的现场在别处（「开始游戏」不换屏，I1 量的就是它；远端那一路要 await）。
  async function measureCreate(forceOpen) {
    // forceOpen 是**参数**传进页面的，不是闭包引的：page.evaluate 只把函数体搬到浏览器里，
    // 引用不到 Node 这一侧的作用域（这份文件上一次 CRASH 就是踩在这条上，别再踩第二次）。
    await page.evaluate((fo) => {
      game.menu.onlineError('清闸门'); game.menu.showOnlineLobby();
      window.__cf = []; window.__cc = 0;
      game.lobby.ws.send = m => { window.__cf.push(String(m)); };
      const P = Object.getPrototypeOf(game.menu);
      if (!game.menu.__ocReal) {
        game.menu.__ocReal = P.onlineCreate;
        game.menu.onlineCreate = function () { window.__cc++; return game.menu.__ocReal.apply(this, arguments); };
      }
      if (fo) game.menu.enterRoomGuard = () => true; else delete game.menu.enterRoomGuard;
    }, forceOpen);
    await sleep(500);
    const pre = await page.evaluate(() => ({ enter: game.menu._enterRoom, screen: game.menu.screen }));
    await page.fill('#roomTitle', '量连点');
    await page.dblclick('[data-a=create]'); await sleep(700);
    const r = await page.evaluate(() => ({
      f: window.__cf.filter(x => /"t":"createRoom"/.test(x)).length, h: window.__cc,
      scr: game.menu.screen, btn: !!document.querySelector('[data-a=create]'),
    }));
    return Object.assign(pre, r);
  }
  const on1 = await measureCreate(false);
  ok('H7a【先决】起点是"闸门开着、人坐在大厅屏"（少了这一条，"只发一帧"可能就是闸门本来就堵着）',
    !on1.enter && on1.screen === 'online', `enter=${on1.enter}·screen=${on1.screen}`);
  ok('H7 真鼠标双击「创建房间」只发一帧 createRoom',
    on1.f <= 1, `handler 进了 ${on1.h} 次·帧=${on1.f}·第二下之后落在 ${on1.scr}`);
  const on2 = await measureCreate(true);
  ok('H7b【读数·量具自证】把闸门换成"永远放行"再双击：帧=' + on2.f + '·handler 进了 ' + on2.h +
    ' 次 ⇒ 这一句决定审计那句"连点会发两帧"是不是鼠标能复现的（handler 只进 1 次 = 第二下被第一下画出来的那层"正在进房…"接走了，两帧这一句复现不了；帧=0 或 handler=0 = 这一双击根本没走到那枚按钮，H7 的"≤1"就成了恒真）',
    on2.h >= 1 && on2.f >= 1, `闸门关掉的 dblclick：handler=${on2.h}·帧=${on2.f}·screen=${on2.scr}·按钮还在=${on2.btn}`);
  await page.evaluate(() => { delete game.menu.enterRoomGuard;
    delete game.menu.onlineCreate; delete game.menu.__ocReal;      // 回到原型上那一份，不在实例上留影子
    game.lobby.ws.send = window.__realSend; });
  await page.evaluate(() => game.menu.leaveOnline()); await sleep(600);

  // ── J 段：HU-27 键盘预览 · HU-28 滚轮 · HU-29 页内改名 ──
  await page.evaluate(() => game.menu.showMain()); await sleep(600);
  await page.click('.mbtn[data-a=loadout]'); await sleep(700);
  await page.click('[data-a=rename]'); await sleep(500);
  ok('J1 改名开的是页面内那一层，而且焦点自己落在字格里（原生 prompt 自带这件事，换成层内就得自己做）',
    (await page.evaluate(() => !!(document.querySelector('.picker') && document.activeElement && document.activeElement.id === 'clsName'))));
  await page.keyboard.type('键盘改名'); await page.keyboard.press('Enter'); await sleep(700);
  ok('J1b 回车就是保存，名字落进 profile（量被测对象），并且浏览器一次弹窗都没被叫过',
    (await page.evaluate(() => game.profile.classes[game.menu.selClass].name)) === '键盘改名'
    && (await page.evaluate(() => window.__nativeDialog)) === 0,
    `__nativeDialog=${await page.evaluate(() => window.__nativeDialog)}`);

  await page.click('[data-g=primary]'); await sleep(1200);
  ok('J2 进得了枪匠', (await page.evaluate(() => game.menu.screen)) === 'gunsmith');
  const gs0 = await page.evaluate(() => (document.getElementById('gsStats') || {}).textContent || '');
  const patt0 = await page.evaluate(() => JSON.stringify(game.profile.classes[game.menu.selClass].patt));
  await page.evaluate(() => document.body.focus());
  const onAtt = await tabTo('.gs-att');
  await sleep(400);
  const gs1 = await page.evaluate(() => (document.getElementById('gsStats') || {}).textContent || '');
  ok('J3【命门·HU-27】键盘 Tab 到一张配件卡上，delta 预览就出来了（旧写法只挂 mouseenter：能走到、能回车，但全程看不到它会改什么）',
    !!onAtt && gs1 !== gs0 && /[+\-−–]\d/.test(gs1), `焦点在 ${onAtt && onAtt.cls2}`);
  ok('J3b 预览**不产生副作用**：配件一个都没被装上（看着它改 ≠ 已经改了）',
    (await page.evaluate(() => JSON.stringify(game.profile.classes[game.menu.selClass].patt))) === patt0, patt0);
  const z0 = await page.evaluate(() => game.menu.gsZoom || 1.45);
  await page.hover('.gs-right .gs-att'); await page.mouse.wheel(0, 240); await sleep(400);
  const z1 = await page.evaluate(() => game.menu.gsZoom || 1.45);
  ok('J4【命门·HU-28】滚轮停在配件列表上时镜头不缩放（那列是唯一会滚的：列表在滚、镜头也在抢同一个手势）',
    z1 === z0, `gsZoom ${z0}→${z1}`);
  await page.mouse.move(640, 300); await page.mouse.wheel(0, 240); await sleep(400);
  const z2 = await page.evaluate(() => game.menu.gsZoom || 1.45);
  ok('J4b【判别臂】指针回到"看枪"那块区域，滚轮照旧缩放（排除名单不许把功能一起禁掉）', z2 !== z1, `gsZoom ${z1}→${z2}`);

  // ── K 段：HU-29 重置存档那一层 ──
  await page.evaluate(() => game.menu.showMain()); await sleep(600);
  await page.click('.mbtn[data-a=settings]'); await sleep(700);
  // K 段要量的是那一层本身（重置存档的页内弹窗），K0 现在量的是"最后一行够得着吗"。
  // 原来这一条写的是**症状**（1280×720 下设置屏最后一行落在视口外、鼠标点不到 —— HU-32 的现场，
  // 读数当时就记在 docs/hud-ux-audit.md 里）。修好之后同一把尺子必须翻方向，否则它就恒绿。
  const reach = await page.evaluate(() => {
    const b = document.querySelector('[data-a=resetp]');
    if (!b) return { ok: false, why: '没这一格' };
    const r0 = b.getBoundingClientRect();
    const inView = r0.bottom <= innerHeight && r0.top >= 0;
    b.scrollIntoView({ block: 'nearest' });
    const r1 = b.getBoundingClientRect();
    return { ok: inView || (r1.bottom <= innerHeight && r1.top >= 0), scrolled: !inView,
      before: Math.round(r0.bottom) + '/' + innerHeight, after: Math.round(r1.bottom) + '/' + innerHeight };
  });
  ok('K0【HU-32 翻向】设置屏最后一行（重置存档）在 1280×720 下够得着：要么本来就在视口里，要么这一屏自己能滚到它',
    reach.ok, `${reach.before} → 滚后 ${reach.after}（${reach.scrolled ? '走了滚动' : '本来就在框内'}）`);
  ok('K0b【判别臂】把设置屏那层的封顶与滚动临时摘掉，最后一行立刻回到视口外 —— "够得着"靠的是这一修，不是窗口本来就大',
    await page.evaluate(() => {
      const st = document.createElement('style');
      st.textContent = '.settings { max-height: none !important; overflow: visible !important; }';
      document.head.appendChild(st);
      const b = document.querySelector('[data-a=resetp]');
      const r = b.getBoundingClientRect();
      const out = r.bottom > innerHeight || r.top < 0;
      st.remove();
      return out;
    }));
  await page.evaluate(() => document.querySelector('[data-a=resetp]').click()); await sleep(600);
  const dlgtxt = await page.evaluate(() => { const d = document.querySelector('.picker'); return d ? d.textContent : ''; });
  ok('K1【命门】重置存档走的是页面内那一层，它列得清"会丢哪几样"，浏览器弹窗一次都没被叫过',
    /清掉/.test(dlgtxt) && /配装/.test(dlgtxt) && /本地经验/.test(dlgtxt) && (await page.evaluate(() => window.__nativeDialog)) === 0,
    dlgtxt.replace(/\s+/g, ' ').slice(0, 70));
  ok('K1b 「先导出为文件」排在「确认重置」之前 —— 不可逆的操作得先给一次退路',
    !!(await page.evaluate(() => document.querySelector('[data-a=dump]') && document.querySelector('[data-a=doprofile]'))));
  const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.click('[data-a=dump]');
  const dlobj = await dl;
  const dlf = dlobj ? dlobj.suggestedFilename() : '';
  ok('K2 导出真能落成一个文件（文件名带 mf-profile 前缀），而且没点确认时那份存档还在',
    /^mf-profile-.*\.json$/.test(dlf || '') && !!(await page.evaluate(() => localStorage.getItem('mf_profile'))), String(dlf));
  ok('K2b【反方向】没有"点一下就静默清库 + 刷新整页"那条路了：确认按钮点下去之前，存档读子仍在',
    !!(await page.evaluate(() => localStorage.getItem('mf_profile'))));

  // ══ L 段：P4 适配性 —— 真浏览器量的那一半（HU-32 三档视口 / HU-33 缩放 / HU-34 对比度 / HU-35 目标）══
  // 进程内那份（test/hud-ux.mjs 的 AC~AH）钉的是单位、令牌、区间与接线；这一段的读数全部来自
  // 浏览器：getComputedStyle 的色与字号、getBoundingClientRect 的落点。审计里那句
  // "别靠算，要截图 + 元素 rect"（需真浏览器复验 第 3 条）就是在要这一段。
  const contrastRows = sels => page.evaluate(ss => {
    const P = c => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const a = m[1].split(/[,\s/]+/).filter(x => x !== '').map(Number); return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 }; };
    const LU = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const BL = (fg, bk) => ({ r: fg.r * fg.a + bk.r * (1 - fg.a), g: fg.g * fg.a + bk.g * (1 - fg.a), b: fg.b * fg.a + bk.b * (1 - fg.a), a: 1 });
    const bgOf = el => { const st = []; let e = el; while (e) { const c = P(getComputedStyle(e).backgroundColor); if (c && c.a > 0) st.push(c); e = e.parentElement; } let o = { r: 0, g: 0, b: 0, a: 1 }; for (let i = st.length - 1; i >= 0; i--) o = BL(st[i], o); return o; };
    const RT = (a, b) => { const l1 = LU(a), l2 = LU(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const rows = [];
    for (const s of ss) for (const el of document.querySelectorAll(s)) {
      const cs = getComputedStyle(el); const fg = P(cs.color); if (!fg) continue;
      const size = parseFloat(cs.fontSize), bold = parseFloat(cs.fontWeight) >= 700;
      rows.push({ s, ratio: +RT(fg, bgOf(el)).toFixed(2), size, need: (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 12) });
      if (rows.length >= 80) return rows;
    }
    return rows;
  }, sels);
  const CT_SEL = ['.menu-title', '.menu-sub', '.mbtn .mt', '.mbtn .md', '.menu-foot', '.menu-keys', '.menu-ver',
    '.hdr', '.hdr small', '.set-row span', '.set-row .val', '.set-sec', '.set-note', '.bind-row span', '.bind-key', '.bind-hint', '.btn'];

  await page.evaluate(() => game.menu.showSettings('main')); await sleep(500);
  const crows = await contrastRows(CT_SEL);
  const cworst = crows.slice().sort((a, b) => a.ratio - b.ratio)[0] || { s: '没读到', ratio: 99 };
  ok('L0【量具自证】这一屏读得到足够多的文字格（少于 10 格就是名单没落到 DOM 上，下面的比值全不可信）',
    crows.length >= 10, `${crows.length} 格`);
  ok('L1 设置屏每一格文字的对比度都过 WCAG AA（小字 4.5:1、大字 3:1）—— HU-34 要的就是这个读数，不是源码里有几个 var()',
    crows.every(r => r.ratio >= r.need), `最低 ${cworst.ratio}:1 @ ${cworst.s} "${cworst.text}" (${cworst.size}px)`);
  // 判别臂走的是**同一个函数**：往那一屏挂一个 #666 的小字，再让 contrastRows 去读它。
  // 另抄一份算法的臂只能证明"我抄的这份会算"，同一把尺子才证明这格没过是因为它真的没过。
  const probeHost = await page.evaluate(() => {
    const host = document.querySelector('.settings'); if (!host) return false;
    const d = document.createElement('div');
    d.className = 'probe-lowcontrast';
    d.style.cssText = 'color:#666;font-size:12px'; d.textContent = 'probe';
    host.appendChild(d); return true;
  });
  const prow = (await contrastRows(['.probe-lowcontrast']))[0] || null;
  await page.evaluate(() => { const d = document.querySelector('.probe-lowcontrast'); if (d) d.remove(); });
  ok('L1b【判别臂·同一把尺子】现场造一个当年那档 #666 的小字，contrastRows 必须判它不达标（≥4.5 的那条线拦得住它）',
    probeHost && !!prow && prow.ratio < prow.need, prow ? `${prow.ratio}:1 < 需要 ${prow.need}:1` : '探针没挂上去 / 没读到');

  // HU-33：浏览器"字号"设置要跟随 —— 把根字号改成 150%，量computed 有没有真的长
  const scaleTest = await page.evaluate(() => {
    const el = document.querySelector('.set-row span');
    const b = parseFloat(getComputedStyle(el).fontSize);
    document.documentElement.style.fontSize = '150%';
    const a = parseFloat(getComputedStyle(el).fontSize);
    document.documentElement.style.fontSize = '';
    return { b: +b.toFixed(2), a: +(a / b).toFixed(3) };
  });
  ok('L2 根字号 ×1.5 ⇒ 菜单文字的计算字号真的 ×1.5（HU-33：以前全是 px，浏览器放大字号一步都不跟）',
    Math.abs(scaleTest.a - 1.5) < 0.02, `${scaleTest.b}px → ${scaleTest.a}×`);
  const hudScaleTest = await page.evaluate(() => {
    const el = document.getElementById('hpNum');
    const b = parseFloat(getComputedStyle(el).fontSize);
    document.documentElement.style.setProperty('--hud-scale', '1.25');
    const a = parseFloat(getComputedStyle(el).fontSize);
    document.documentElement.style.setProperty('--hud-scale', '1');
    return { b: +b.toFixed(2), a: +(a / b).toFixed(3) };
  });
  ok('L3 HUD 缩放那一格落在 HUD 字号上（--hud-scale ×1.25 ⇒ #hpNum 的 computed 字号 ×1.25），且不牵连菜单（与 L2 两条轴分开）',
    Math.abs(hudScaleTest.a - 1.25) < 0.02, `${hudScaleTest.b}px → ${hudScaleTest.a}×`);

  // HU-35：点击目标尺寸。1024×768 是这一族最紧的一档。
  await page.setViewportSize({ width: 1024, height: 768 }); await sleep(300);
  const taps = await page.evaluate(() => {
    const out = [];
    for (const s of ['.seg div', '.btn.small', '.bind-key', '.mbtn', '.set-row input[type=range]']) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out.push({ s, h: Math.round(r.height), w: Math.round(r.width) });
        if (out.filter(x => x.s === s).length >= 6) break;
      }
    }
    return out;
  });
  const tooSmall = taps.filter(t => t.h < 32);
  ok('L4 1024×768 下每个可点目标的高度都 ≥32px（HU-35：房间设置那 6 档原来挤在 ~30px 里，触屏按不准）',
    taps.length >= 12 && tooSmall.length === 0, `读了 ${taps.length} 个·最矮 ${Math.min(...taps.map(t => t.h))}px${tooSmall.length ? ' 超标:' + tooSmall.map(t => t.s + '=' + t.h).join(',') : ''}`);

  // HU-32：三档视口逐屏扫一遍 —— 横向不许出视口，纵向每一个可点元素都够得着。
  const sweep = async (w, h) => {
    await page.setViewportSize({ width: w, height: h }); await sleep(250);
    const screens = [];
    const visit = async (name, act) => {
      await act(); await sleep(420);
      const r = await page.evaluate(() => {
        const PICK = '.mbtn,.btn,.pick,.cls,.slotc,.gs-att,.gs-slot,.mode,.mapc,.diff,.seg div,.camo,.bind-key';
        const bad = [];
        for (const el of document.querySelectorAll(PICK)) {
          const a = el.getBoundingClientRect();
          if (a.width < 1 || a.height < 1) continue;
          if (a.right > innerWidth + 2 || a.left < -2) { bad.push({ why: '横向出界', cls: el.className, x: Math.round(a.left) + '..' + Math.round(a.right) }); continue; }
          el.scrollIntoView({ block: 'nearest' });
          const b = el.getBoundingClientRect();
          if (b.bottom > innerHeight + 2 || b.top < -2) bad.push({ why: '滚也到不了', cls: el.className, y: Math.round(b.top) + '..' + Math.round(b.bottom) });
        }
        const host = document.scrollingElement || document.documentElement;
        return { bad, overflowX: Math.max(host.scrollWidth, document.body.scrollWidth) - innerWidth };
      });
      screens.push({ name, bad: r.bad, overflowX: r.overflowX });
    };
    await visit('main', () => page.evaluate(() => game.menu.showMain()));
    await visit('settings', () => page.evaluate(() => game.menu.showSettings('main')));
    await visit('lobby', () => page.evaluate(() => game.menu.showLobby()));
    await visit('loadout', () => page.evaluate(() => game.menu.showLoadouts('main')));
    // 枪匠是"进那一屏之后再点一层"才出现的，所以 act 自己等：420ms 的那一刀量到的是
    // 配装屏，等于把 loadout 扫了两遍、枪匠那一屏根本没进（HU-32 点名的重叠恰恰在它身上）。
    await visit('gunsmith', async () => {
      await page.evaluate(() => game.menu.showLoadouts('main')); await sleep(350);
      await page.evaluate(() => { const g = document.querySelector('[data-g=primary]'); if (g) g.click(); });
      await sleep(800);
    });
    return screens;
  };
  for (const [w, h] of [[1024, 768], [1280, 720], [2560, 1080]]) {
    const sc = await sweep(w, h);
    const flat = sc.flatMap(s => s.bad.map(b => s.name + ':' + b.why + ' ' + b.cls));
    ok(`L5 ${w}×${h}：五屏里每一个可点元素都在视口内或滚得到，且没有横向溢出（HU-32 点名却没量过的两档，现在各量一次）`,
      flat.length === 0 && sc.every(s => s.overflowX <= 2), `${flat.slice(0, 3).join(' ⏐ ')} 溢出X=${Math.max(...sc.map(s => s.overflowX))}`);
  }
  // HU-32 的枪匠那一族：窄窗下中列与数值板重叠（审计原话）。量 rect，不靠算。
  await page.setViewportSize({ width: 1024, height: 768 }); await sleep(250);
  await page.evaluate(() => { game.menu.showLoadouts('main'); }); await sleep(300);
  await page.evaluate(() => { const g = document.querySelector('[data-g=primary]'); if (g) g.click(); }); await sleep(900);
  const gsOver = await page.evaluate(() => {
    const R = s => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const hit = (a, b) => a && b && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
    const L = R('.gs-left'), Rt = R('.gs-right'), St = R('.gs-stats'), T = R('.gs-title');
    return [['左列×数值板', hit(L, St)], ['右列×数值板', hit(Rt, St)], ['标题×右列', hit(T, Rt), T && Rt ? Math.round(T.r) + ' vs ' + Math.round(Rt.l) : '']];
  });
  ok('L6 1024×768 的枪匠：中列、右列、数值板三块互不压（窄窗下重叠是 HU-32 里点名的原状）',
    gsOver.every(x => x[1] === false), gsOver.map(x => x[0] + '=' + (x[1] ? '重叠' : '不碰') + (x[2] ? '(' + x[2] + ')' : '')).join(' '));
  // HU-36 反向那一半（超宽屏上瞄具遮罩必须是**圆**）挪到 M9 之后的对局内去量：
  // #scope 住在 #hud 里，而菜单态下 #hud 整块是 display:none（getBoundingClientRect 全 0），
  // 在这一屏量到的是"量具没接上"，不是"遮罩不圆"。

  // ══ L8： HU-32 的"看得见却点不到"那一族 ══
  // 倒推自 npm run test:all 里 net-drop 那一条红：`.lb-rooms` 写成 `flex:1`（允许被压到内容以下）之后，
  // 那一栏被压到 38px 高而它自己的内容是 150px，溢出的房间行画在下一块**有不透明底色**的面板底下 ——
  // querySelector 找得到、`scrollIntoView` 之后 rect 也在框内，`click()` 却一直点不到。
  // 所以这一族不能只量 rect，还得问浏览器"那个坐标上的顶层元素是谁"。
  // 装数据源 → 真渲染器 → 量 rect 与落点，**全部在同一拍里做完**。
  // 分成两次 evaluate 的上一版量到 n=0：那一屏在两次 evaluate 之间被大厅自己的推送重画过一次
  // （真那份房间表是空的），于是两条判据都"因为没有行"而失配。同一拍做完，量具与被测对象之间就没有这道缝。
  const lobbyProbe = oldCss => {
    if (oldCss) { window.__lbSt = document.createElement('style'); window.__lbSt.textContent = oldCss; document.head.appendChild(window.__lbSt); }
    game.menu.showOnlineLobby();
    // 夹具写的是**这一屏自己读的那本账**（game.lobby 在 H/I 段之后是活的客户端，不是 null），
    // 所以量完必须原样还回去：留在里面的一份假房间表会让后面那一屏之后每一次推送都在说谎。
    const keep = { has: !!game.lobby, connected: game.lobby && game.lobby.connected, lost: game.lobby && game.lobby.lost,
      online: game.lobby && game.lobby.online, rooms: game.lobby && game.lobby.rooms };
    game.lobby = Object.assign(game.lobby || {}, { connected: true, lost: false, online: 3, rooms: [
      { id: 'probe-a', title: '甲房', map: 'dune', mode: 'tdm', time: 10, players: 3, max: 16, state: 'waiting', ready: 1 },
      { id: 'probe-b', title: '乙房', map: 'frost', mode: 'tdm', time: 10, players: 16, max: 16, state: 'waiting', ready: 0 }] });
    game.menu.renderRooms();
    const bad = [];
    for (const el of document.querySelectorAll('#lbRows .room-row, #lbRows [data-a=joinRow]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { bad.push({ why: '零尺寸', cls: String(el.className) }); continue; }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === el || (hit && (el.contains(hit) || hit.contains(el)))) continue;
      bad.push({ why: '被盖住', cls: String(el.className).slice(0, 16),
        by: hit ? hit.tagName + '.' + String(hit.className).slice(0, 20) + (hit.dataset && hit.dataset.a ? '[a=' + hit.dataset.a + ']' : '') : 'null' });
    }
    const pnl = document.querySelector('.lb-rooms');
    const out = { n: document.querySelectorAll('#lbRows .room-row').length,
      btn: document.querySelectorAll('#lbRows [data-a=joinRow]').length, bad,
      panel: pnl ? { h: Math.round(pnl.getBoundingClientRect().height), sh: pnl.scrollHeight } : null };
    if (window.__lbSt) { window.__lbSt.remove(); window.__lbSt = null; }
    if (keep.has) Object.assign(game.lobby, { connected: keep.connected, lost: keep.lost, online: keep.online, rooms: keep.rooms });
    return out;
  };
  // L8 的夹具是两份房间（一份进得去、一份满员），走的是真那一份渲染器（renderRooms 读的就是
  // game.lobby.rooms —— 服务端推来的那本账），不是手搓两行 HTML 假装是那一屏。
  const lr = await page.evaluate(lobbyProbe);
  ok('L8 大厅那两张房卡在 1280×720 下每一格都点得到：那一栏没被压到内容以下、每格的落点就是它自己（HU-32 这一族的病根是"被后面的面板压在底下"）',
    lr.n === 2 && lr.btn === 2 && lr.bad.length === 0 && !!lr.panel && lr.panel.h + 2 >= lr.panel.sh, JSON.stringify(lr));
  const lrOld = await page.evaluate(lobbyProbe, '.lb-rooms { flex: 1 1 0 !important; min-height: 0 !important; }');
  ok('L8b【判别臂·同一把尺子】把 `.lb-rooms` 的 flex-shrink 放开（就是 net-drop 那一红当时的写法），同一把尺子当场认出被压住的那几格',
    lrOld.bad.length > 0 && !!lrOld.panel && lrOld.panel.h < lrOld.panel.sh - 2, JSON.stringify(lrOld));

  // ── L9：联网大厅那一栏的 .opts 排版（**用户截图报的**"大厅 UI 大乱"）──
  // 症状：地图/模式/时长/目标四行选项挤进 110px 的标签列里（每行只放得下一个），标签浮到右边
  // 与控件同列，那一栏被撑到 998px —— 1280×720 下整块被顶出视口。
  // 成因是 .opts 的「标签列 + 控件列」逐格交替排版被一个**没有标签的控件行**（HU-24 的
  // 「按房号加入」）错开了一格；成因那一半（markup 与 CSS 的契约）在 test/hud-ux.mjs 的 AI 段，
  // 这里量的是屏幕上真正发生的事：谁在控件列、每个选择器几行、标签与它那一行是不是同带。
  // 与 L8 同法：装数据源 → 真渲染器 → 量 rect，**全部在同一拍里做完**（分两次 evaluate 会撞上大厅推送重画）。
  const optsProbe = oldCss => {
    if (oldCss) { window.__opSt = document.createElement('style'); window.__opSt.textContent = oldCss; document.head.appendChild(window.__opSt); }
    game.menu.showOnlineLobby();
    const opts = document.querySelector('.lobby .opts');
    const out = { found: !!opts };
    if (opts) {
      const title = document.getElementById('roomTitle');
      const ctlLeft = title ? title.getBoundingClientRect().left : null;
      const segs = [...opts.querySelectorAll('.seg')].map(s => {
        const r = s.getBoundingClientRect();
        const vis = [...s.children].filter(c => c.getBoundingClientRect().height > 0);
        const tops = vis.map(c => c.getBoundingClientRect().top);
        return { id: s.id, left: r.left, h: r.height, n: vis.length, oneLine: tops.every(t => Math.abs(t - tops[0]) < 2) };
      });
      // 标签 = .opts 里那些"不含表单控件、也不是 .seg/.note-wide"的直接子元素（不抄标签文字：
      // 文案改了不该让这一条红，位置关系才是被测对象）
      const labels = [...opts.children].filter(e => !e.classList.contains('seg') && !e.classList.contains('note-wide') && !e.querySelector('input,button'));
      const rows = segs.map(s => {
        const r = opts.querySelector('#' + s.id).getBoundingClientRect();
        const lab = labels.find(e => { const b = e.getBoundingClientRect(); const c = b.top + b.height / 2; return c >= r.top - 2 && c <= r.bottom + 2; });
        return { id: s.id, lab: lab ? (lab.textContent || '').trim().slice(0, 6) : null };
      });
      out.ctlLeft = ctlLeft; out.segs = segs; out.rows = rows; out.h = opts.getBoundingClientRect().height;
    }
    if (window.__opSt) { window.__opSt.remove(); window.__opSt = null; }
    return out;
  };
  await page.setViewportSize({ width: 1280, height: 720 }); await sleep(250);
  const op = await page.evaluate(optsProbe);
  const opOff = op.segs ? op.segs.filter(s => Math.abs(s.left - op.ctlLeft) > 2) : [];
  const opWrap = op.segs ? op.segs.filter(s => !s.oneLine || s.h > 40) : [];
  const opOrphan = op.rows ? op.rows.filter(r => !r.lab) : [];
  ok('L9 1280×720 下大厅那一栏：四个选择器都排在控件列（左边界与「房间名」输入框同一条）、每个只占一行、标签与它那一行同带，整栏高 ≤420px',
    op.found && op.segs.length === 4 && op.ctlLeft !== null
    && opOff.length === 0 && opWrap.length === 0 && opOrphan.length === 0 && op.h <= 420,
    `ctlLeft=${op.ctlLeft === null ? 'null' : Math.round(op.ctlLeft)}·栏高=${Math.round(op.h)}·离列=${opOff.map(s => s.id + '@' + Math.round(s.left)).join(',') || '无'}·换行=${opWrap.map(s => s.id + '=' + Math.round(s.h)).join(',') || '无'}·无标签=${opOrphan.map(r => r.id).join(',') || '无'}`);
  ok('L9a【先决】那四个选择器各自都画出了可见选项（"都在控件列"若是在一组空选择器上成立，L9 就是遍历空集合的恒绿）',
    op.segs && op.segs.every(s => s.n >= 2), JSON.stringify((op.segs || []).map(s => s.id + ':' + s.n)));
  // 反证臂：现场把那一格还原成 auto（就是用户截图那一版）—— 同一把尺子必须当场报出
  // "选择器离列 + 有换行 + 那一栏高到 900+"。少了这一条，L9 的绿分不清是"排对了"还是"量具没接上"。
  const opOld = await page.evaluate(optsProbe, '.opts .opt-ctl { grid-column: auto !important; }');
  const opOldOff = opOld.segs.filter(s => Math.abs(s.left - opOld.ctlLeft) > 2);
  ok('L9b【反证臂·现场装回错位那一版】把 .opt-ctl 的 grid-column 还原成 auto，同一把尺子当场报出"四个选择器全部离列 + 至少一个换行 + 那一栏高到 500px 以上"',
    opOldOff.length === 4 && opOld.segs.some(s => !s.oneLine || s.h > 40) && opOld.h > 500 && opOld.h > op.h + 200,
    `离列 ${opOldOff.length}/4·栏高=${Math.round(opOld.h)}（修好时 ${Math.round(op.h)}）`);
  // 同一把尺子在窄档上再过一遍：1280 那版的高度是内容撑出来的，窄窗下更容易顶出视口。
  await page.setViewportSize({ width: 1024, height: 768 }); await sleep(250);
  const opNarrow = await page.evaluate(optsProbe);
  ok('L9c 1024×768 下同一把尺子同样过（那四行是内容撑高的，窄档才是最容易把它顶出视口的一档）',
    opNarrow.found && opNarrow.segs.every(s => Math.abs(s.left - opNarrow.ctlLeft) <= 2) && opNarrow.h <= 420,
    `ctlLeft=${Math.round(opNarrow.ctlLeft)}·栏高=${Math.round(opNarrow.h)}`);

  // ── L10：全服频道的时间窗在真浏览器里自己走（用户报的"消息永远不清理"）──
  // 进程内那一半在 test/hud-ux.mjs 的 AI 段（驱动真渲染器与真 tick 本体）；这里量的是**这一拍真被喂着**：
  // 往缓冲里放一条"还有 1.2 秒过期"的行，之后谁都不点、什么都不按 —— 它必须自己消失。
  // ⚠ 不赌机器速度：这一档的 rAF 慢到 200~400ms 一帧，而 dt 还被 min(0.25,…) 截过一刀（本仓库
  // 在 pauseTick 那一轮踩过同一脚：1.3 秒墙钟只攒到 0.258，"死等一个固定秒数"等于替测试赌机器速度）。
  // 所以：先单独量"这一拍真的在攒 dt"（三次采样，tick 触发时会把 `_chatAcc` 归零，单次读数可能是 0），
  // 再**等条件**（那一行从 DOM 里消失）而不是等固定秒数。
  const feed = await page.evaluate(async () => {
    if (game.menu.screen !== 'online') game.menu.showOnlineLobby();
    const m = game.menu, sample = async () => { const v = []; for (let i = 0; i < 3; i++) { v.push(Number((m._chatAcc || 0).toFixed(3))); await new Promise(r => setTimeout(r, 400)); } return v; };
    m._chatAcc = 0;
    const on = await sample();
    m.showMain(); await new Promise(r => setTimeout(r, 600));
    const off = await sample();
    m.showOnlineLobby();
    return { on, off, screen: m.screen };
  });
  ok('L10a【先决·命门】大厅这一屏真的被渲染循环喂着 chatTick（三次采样里至少一次在攒 dt），而离开这一屏就停在 0 —— 少了这半句，"等一会儿它自己消失"在下一次重构里会变成一句空话',
    feed.on.some(v => v > 0) && feed.off.every(v => v === 0) && feed.screen === 'online', JSON.stringify(feed));
  await page.evaluate(() => {
    const now = Date.now();
    game.lobby.chat = [
      { ch: 'lobby', from: '甲', text: '马上过期', at: now - 10 * 60e3 + 1200 },
      { ch: 'lobby', from: '乙', text: '还很新', at: now },
    ];
    game.menu.renderChat(game.menu.el, 'lobby');
  });
  const chatBefore = await page.evaluate(() => document.querySelectorAll('#lbChat .chat-line').length);
  let agedInTime = true;
  try { await page.waitForFunction(() => document.querySelectorAll('#lbChat .chat-line').length === 1, null, { timeout: 30000 }); }
  catch { agedInTime = false; }
  const chatAfter = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#lbChat .chat-line')].map(x => x.textContent || '');
    game.lobby.chat = [];
    return rows;
  });
  ok('L10 进屏时两条都在，之后谁都不点：那条过期的行自己从聊天框里消失，新那句留着（时间窗在真浏览器里真的走到了 DOM 上，不是只写在源码里）',
    chatBefore === 2 && agedInTime && chatAfter.length === 1 && /还很新/.test(chatAfter[0] || '') && !/马上过期/.test(chatAfter.join('')),
    `进屏 ${chatBefore} 条 → ${JSON.stringify(chatAfter)}`);

  // ── L11：联网里点得到「占领」（HU-44 · 用户报"联网对战是不是还没有占点模式"）──
  // 成因（大厅/房间屏各多了一句"模式按当前图藏"，与「占领↔双丘战区」互为专属撞成死锁）
  // 与可达性的两个方向在 test/hud-ux.mjs 的 AJ 段（那把尺子量的是"点遍看得见的格子到不到得了"）。
  // 这里量的是**用户真的点得到、而且点出来的东西是对的**：模式那一行常驻三张卡、图那一行仍按模式滤，
  // 点「占领」之后图自己迁到双丘战区，建房与房内改设置之后屏幕上写的都是这一局（连档位表都换过）。
  const readRoomCfg = () => {
    const opts = id => { const e = document.getElementById(id); return e ? [...e.querySelectorAll('div')].filter(x => x.getBoundingClientRect().height > 0).map(x => x.dataset.v + (x.classList.contains('sel') ? '*' : '')).join(',') : null; };
    return { meta: (document.getElementById('rmMeta') || {}).textContent || '', mode: opts('rmMode'), map: opts('rmMap'), min: opts('rmMin'), score: opts('rmScore') };
  };
  const lobbyDom = await page.evaluate(() => {
    if (game.menu.screen !== 'online') game.menu.showOnlineLobby();
    const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.getBoundingClientRect().height > 0).map(e => e.dataset.v);
    const before = { modes: vis('#segMode div'), maps: vis('#segMap div') };
    const d = [...document.querySelectorAll('#segMode div')].find(x => x.dataset.v === 'dom');
    const clickable = !!d && d.getBoundingClientRect().height > 0;
    if (clickable) d.click();
    return { before, clickable, after: { modes: vis('#segMode div'), maps: vis('#segMap div'), mode: game.menu.lobby.mode, map: game.menu.lobby.map } };
  });
  ok('L11 大厅默认那一档（团队死斗 + 沙丘镇）下「占领」就是可见可点的（修前被"按当前图藏模式"那一句藏起来），点它之后**图自己迁到双丘战区**、图那一行只剩它；同时图那一行仍按模式滤（tdm 下双丘战区是藏着的）—— 两个方向都量，免得把"整行不再过滤"当成修好',
    lobbyDom.before.modes.join() === 'tdm,dom,ffa' && lobbyDom.before.maps.join() === 'dune,frost,neon,yard'
    && lobbyDom.clickable && lobbyDom.after.mode === 'dom' && lobbyDom.after.map === 'ridges'
    && lobbyDom.after.maps.join() === 'ridges' && lobbyDom.after.modes.join() === 'tdm,dom,ffa',
    JSON.stringify(lobbyDom));
  await page.fill('#roomTitle', '占领验证房');
  await page.click('[data-a=create]');
  const roomOpened = await page.waitForFunction(() => game.menu.screen === 'onlineRoom' && !!document.getElementById('rmMode'), null, { timeout: 30000 }).then(() => true).catch(() => false);
  await sleep(700);
  const roomDom = await page.evaluate(readRoomCfg);
  ok('L11b 建房之后房间屏上写的就是这一局：模式「占领」+ 图「双丘战区」+ **档位换过表**（时长 15/25/35 选 25、目标 100/200/500 选 200）—— 只换名字不换档位的话，房间标题上那两个数字从此是假的',
    roomOpened && /dom\*/.test(roomDom.mode || '') && roomDom.map === 'ridges*' && roomDom.min === '15,25*,35'
    && /200\*/.test(roomDom.score || '') && /占领/.test(roomDom.meta) && /双丘战区/.test(roomDom.meta), JSON.stringify(roomDom));
  const clickCfg = (id, v) => page.evaluate(([i, val]) => {
    const e = document.getElementById(i); if (!e) return false;
    const d = [...e.querySelectorAll('div')].find(x => x.dataset.v === val);
    if (!d || d.getBoundingClientRect().height === 0) return false;
    d.click(); return true;
  }, [id, v]);
  const waitMin = v => page.waitForFunction(x => {
    const e = document.getElementById('rmMin');
    return !!e && [...e.querySelectorAll('div')].some(d => d.dataset.v === x && d.classList.contains('sel'));
  }, v, { timeout: 15000 }).catch(() => { });
  await clickCfg('rmMode', 'tdm');
  await waitMin('10');
  await sleep(350);
  const backTdm = await page.evaluate(readRoomCfg);
  ok('L11c 房间里把模式换回「团队死斗」真的生效：图跟着迁回沙丘镇、时长换回 3/5/10/15（25 不在 tdm 的表里 ⇒ 落回 10），目标 200 在 tdm 的表里 ⇒ 留着 —— 这一帧发出去的是**一致的组合**；只发 mode 那一版会被服务端当场拒（症状就是"点了没反应"）',
    /tdm\*/.test(backTdm.mode || '') && /^dune\*/.test(backTdm.map || '') && backTdm.min === '3,5,10*,15'
    && /200\*/.test(backTdm.score || ''), JSON.stringify(backTdm));
  await clickCfg('rmMode', 'dom');
  await waitMin('25');
  await sleep(350);
  const backDom = await page.evaluate(readRoomCfg);
  ok('L11d 再换回「占领」同样生效（图那行只剩双丘战区、时长回到 15/25/35 选 25）—— 两个方向都量，免得把"某一支恰好写死"当成通',
    /dom\*/.test(backDom.mode || '') && backDom.map === 'ridges*' && backDom.min === '15,25*,35', JSON.stringify(backDom));
  // 开局。这一条才是"联网里真的打得了占点"的端到端那一半：房是**真大厅 UI** 建出来的，
  // 不是把 modeId 按进去（net-play 那份 dom 判据是后者 —— 量的是同一条链的另一半，入口不同）。
  await page.click('[data-a=addA]'); await sleep(300);
  await page.click('[data-a=addA]'); await sleep(500);
  await page.click('[data-a=start]');
  const domPlaying = await page.waitForFunction(() => game.state === 'play' && game.net && game.net.modeId === 'dom', null, { timeout: 180000 }).then(() => true).catch(() => false);
  await sleep(2000);
  const domLive = await page.evaluate(() => ({
    modeId: game.net && game.net.modeId, map: game.net && game.net.mapId,
    flags: game.net && game.net.flags ? game.net.flags.length : -1,
  }));
  ok('L11e 从这一屏真开得起一局占点：客户端按 dom 建起 3 面旗（A/B/C）—— 走的是"大厅 → 建房 → 房内改设置 → 开局"整条真界面链',
    domPlaying && domLive.modeId === 'dom' && domLive.map === 'ridges' && domLive.flags === 3, JSON.stringify(domLive));
  await page.evaluate(() => game.exitToMenu());
  await page.waitForFunction(() => game.state === 'menu' && game.menu.screen === 'main', null, { timeout: 60000 }).catch(() => { });

  // ══ M 段：HU-37 设置与重绑，在浏览器里真生效 ══
  await page.setViewportSize({ width: 1280, height: 720 }); await sleep(250);
  await page.evaluate(() => game.menu.showSettings('main')); await sleep(500);
  const setRows = await page.evaluate(() => {
    const ks = [...document.querySelectorAll('[data-k]')].map(e => e.dataset.k);
    return { n: ks.length, has: ['hudScale', 'hudOpacity', 'mmSize', 'crossColor', 'crossSize', 'crossGap', 'subtitles', 'volSfx', 'volAmbient', 'volVoice', 'mouseAccel'].every(k => ks.includes(k)), binds: document.querySelectorAll('.bind-key').length };
  });
  ok('M1 设置屏真的长出了那一批新格（P4 新增 11 项都在），键位那一格里有 ' + setRows.binds + ' 枚按钮',
    setRows.n >= 16 && setRows.has && setRows.binds >= 20, `[data-k]=${setRows.n}·bind=${setRows.binds}`);
  const mm = await page.evaluate(() => {
    const inp = document.querySelector('input[data-k=mmSize]');
    inp.value = '160'; inp.dispatchEvent(new Event('input', { bubbles: true }));
    const cv = document.getElementById('minimap');
    return { css: getComputedStyle(document.documentElement).getPropertyValue('--mm-size').trim(), attr: cv.width, live: game.hud.mmSize, stored: JSON.parse(localStorage.getItem('mf_settings')).mmSize };
  });
  ok('M2 拖「小地图尺寸」那一格：CSS 变量、<canvas> 位图、绘制用的那个数、存档 —— 四处一起动（漏一处就是"滑杆动了屏幕不动"）',
    mm.css === '160px' && mm.attr === 160 && mm.live === 160 && mm.stored === 160, JSON.stringify(mm));
  const cc = await page.evaluate(() => {
    const seg = document.querySelector('.seg[data-k=crossColor]');
    const q = [...seg.querySelectorAll('div')].find(d => d.dataset.v === '青');
    q.click();
    const arm = document.querySelector('#crosshair i');
    return { css: getComputedStyle(document.documentElement).getPropertyValue('--cross-col').trim(), arm: getComputedStyle(arm).backgroundColor };
  });
  ok('M3 准星颜色：CSS 变量与那四根臂的实际底色同时改色（屏上选的颜色 = 屏幕上打出来的颜色，HU-01 那一族的闭环）',
    cc.css.toLowerCase() === '#4fe3ff' && cc.arm === 'rgb(79, 227, 255)', JSON.stringify(cc));
  await page.evaluate(() => { document.querySelector('.bind-key[data-bind=fwd]').click(); }); await sleep(220);
  await page.keyboard.press('KeyG'); await sleep(320);
  const rb = await page.evaluate(() => {
    const cell = document.querySelector('.bind-key[data-bind=fwd]');
    game.input.keys = { KeyG: true }; const fwdG = game.snapshotInput().fwd;
    game.input.keys = { KeyW: true }; const fwdW = game.snapshotInput().fwd;
    game.input.keys = {};
    return { text: (cell.textContent || '').trim(), stored: JSON.parse(localStorage.getItem('mf_settings')).binds, fwdG, fwdW, live: game.binds().fwd.join() };
  });
  ok('M4 真重绑闭环：点那一格、按 G ⇒ 格上写 G、存档里存着、喂 G 真的前进、喂 W 不再前进（"表是静态文字"就是这一条的反面）',
    rb.text === 'G' && rb.live === 'KeyG' && rb.fwdG === true && rb.fwdW === false
    && rb.stored && rb.stored.fwd && rb.stored.fwd.join() === 'KeyG', JSON.stringify(rb));
  // 重画之后那一格还点得动吗：repaintBinds() 换掉的是 .binds 那块的 innerHTML，新节点上
  // 必须重新绑一次监听。少了那一刀的症状是"第一个键绑上了，后面 23 格全是死的"，
  // 而下面 M5/M6 会因为捕获态根本没进去而一起红 —— 所以这一条单独立着，让失败说出自己的名字。
  const armed = await page.evaluate(() => {
    const c = document.querySelector('.bind-key[data-bind=jump]');
    if (!c) return { found: false, cap: '' };
    c.click();
    return { found: true, cap: game.menu.capturing };
  });
  ok('M4b【命门·重画之后那一格还是活的】绑完一个键再点下一格，真的进捕获态（repaint 换掉的 innerHTML 必须重新绑监听）',
    armed.found && armed.cap === 'jump', JSON.stringify(armed));
  await page.evaluate(() => { document.querySelector('.bind-key[data-bind=jump]').click(); }); await sleep(200);
  await page.keyboard.press('KeyG'); await sleep(300);
  const clash = await page.evaluate(() => ({
    msg: (document.querySelector('.bind-msg') || {}).textContent || '',
    jump: game.binds().jump.join(), fwd: game.binds().fwd.join(),
  }));
  ok('M5 一个键不给两个动作：把跳跃也绑到 G 会被拒，并说出是「前进」占着（悄悄让两个动作同键的症状是按下只有一个动）',
    /前进/.test(clash.msg) && clash.jump === 'Space' && clash.fwd === 'KeyG', JSON.stringify(clash));
  await page.evaluate(() => { document.querySelector('.bind-key[data-bind=reload]').click(); }); await sleep(200);
  await page.keyboard.press('Escape'); await sleep(300);
  const cap = await page.evaluate(() => ({
    screen: game.menu.screen, cap: game.menu.capturing, reload: game.binds().reload.join(),
    cell: (document.querySelector('.bind-key[data-bind=reload]') || {}).textContent || '',
  }));
  ok('M6 捕获态里的 Esc 是"取消这一次"，不是"退出这一屏"（当年那条路会把人一脚踹出设置屏，而玩家以为自己已经取消了）',
    cap.screen === 'settings' && !cap.cap && cap.reload === 'KeyR' && cap.cell.trim() === 'R', JSON.stringify(cap));
  await page.evaluate(() => { document.querySelector('[data-a=breset]').click(); }); await sleep(300);
  const rst = await page.evaluate(() => ({
    binds: JSON.parse(localStorage.getItem('mf_settings')).binds || {}, fwd: game.binds().fwd.join(),
    cell: (document.querySelector('.bind-key[data-bind=fwd]') || {}).textContent || '',
  }));
  ok('M7 「键位恢复默认」把表清回去、输入层立刻按默认读（不是只清了屏上的字）',
    JSON.stringify(rst.binds) === '{}' && rst.fwd === 'KeyW' && rst.cell.trim() === 'W', JSON.stringify(rst));
  const ariaN = await page.evaluate(() => ({
    live: ['killfeed', 'subtitles', 'objective', 'announce', 'chatLog', 'netStat', 'teamAlive', 'prompt']
      .filter(id => { const e = document.getElementById(id); return e && (e.getAttribute('aria-live') || e.getAttribute('role') === 'alert'); }).length,
    roleBtn: document.querySelectorAll('#menu [role=button]').length,
    alert: !!document.querySelector('[role=alert]'),
  }));
  ok('M8 动态区都有 aria-live/role=alert（对局里那些只写在屏幕上的事，读屏用户现在收得到）',
    ariaN.live >= 8 && ariaN.alert, `live=${ariaN.live}/8·alert=${ariaN.alert}`);
  ok('M8b 可达性树里这些格子真的有名有姓：按角色 + 名字找得到（量的就是"读得到名字"，不是源码里有几个 aria-）',
    (await page.getByRole('button', { name: /前进，当前/ }).count()) >= 1
    && (await page.getByRole('button', { name: '开' }).count()) >= 1,
    `前进那格=${await page.getByRole('button', { name: /前进，当前/ }).count()}·开关那批=${await page.getByRole('button', { name: '开' }).count()}`);

  // HU-39：暂停屏 —— 要真进一局才量得到（联机暂停是假的这一条本来就只有对局里才成立）。
  // 进局走的是 E 段同一把钥匙（game.startGame），不靠大厅那个按钮：那一格能不能点
  // 是 H/I 段的事，这里要的是"确实有一个在跑的对局可以按暂停"。
  await page.evaluate(() => { game.exitToMenu(); }); await sleep(600);
  await page.evaluate(() => { game.menu.showMain(); game.startGame('mp',
    { mode: 'tdm', map: 'dune', diff: 1, allies: 3, enemies: 3, scoreLimit: 200, timeLimit: 5 }); });
  const inPlay = await wait(() => game.state === 'play' && !game.paused, 60000);
  ok('M9【先决】单机那一局开起来了（下面几条量的是对局内的屏，开不起来就必须红）', inPlay, `state=${await page.evaluate(() => game.state)}`);
  if (inPlay) {
    // HU-36 超宽那一档：**在真对局里**量（#scope 住在 #hud 内，菜单态整块 display:none，
    // 在那里量到的是 0×0 —— 量具没接上，不是遮罩不圆）。
    await page.setViewportSize({ width: 2560, height: 1080 }); await sleep(400);
    const scopeShape = await page.evaluate(() => {
      const sc = document.getElementById('scope');
      const old = sc.className;
      sc.classList.remove('hidden'); sc.className = 'sniper';
      const hole = document.querySelector('.scope-hole'); const r = hole.getBoundingClientRect();
      const cs = getComputedStyle(hole);
      // border-radius 写的是 50%，computed 也就原样回 '50%' —— 直接 parseFloat 得到 50，
      // 与"半径 = 边长一半"那条尺对不上（量具读错了量，不是遮罩不圆）。换算成像素再比。
      const br = cs.borderTopLeftRadius, pc = /^([\d.]+)%$/.exec(br);
      const radius = pc ? parseFloat(pc[1]) / 100 * r.width : parseFloat(br);
      sc.className = old;
      return { hudShown: !document.getElementById('hud').classList.contains('hidden'),
        w: Math.round(r.width), h: Math.round(r.height), ar: +(r.width / r.height).toFixed(3),
        radius: Math.round(radius), centeredX: Math.round(r.left + r.width / 2),
        centeredY: Math.round(r.top + r.height / 2) };
    });
    ok('L7 2560×1080 的对局里瞄具遮罩仍是正圆，且圆心就是屏幕中心（vmin 定径；当年 88vh ⇒ 圆孔按 1080 高定，2560 宽里左右各露出一大片）',
      scopeShape.hudShown && Math.abs(scopeShape.ar - 1) < 0.02
      && Math.abs(scopeShape.radius - scopeShape.w / 2) < 2
      && Math.abs(scopeShape.centeredX - 1280) < 3 && Math.abs(scopeShape.centeredY - 540) < 3,
      `${scopeShape.w}×${scopeShape.h} aspect=${scopeShape.ar}·圆角=${scopeShape.radius}·圆心=(${scopeShape.centeredX},${scopeShape.centeredY})`);
    await page.setViewportSize({ width: 1280, height: 720 }); await sleep(400);
    await page.evaluate(() => game.pause(true)); await sleep(700);
    const pz = await page.evaluate(() => {
      const sc = document.querySelector('.screen.scrim');
      const board = document.getElementById('pauseBoard');
      return {
        scrim: !!sc,
        bg: sc ? getComputedStyle(sc).background.slice(0, 40) : '',
        rows: board ? board.querySelectorAll('tr').length : 0,
        hasBoard: !!board && board.textContent.length > 4,
        keys: !!document.querySelector('.pause-keys'), vol: !!document.querySelector('[data-pv]'),
      };
    });
    ok('M10 暂停屏的底是半透的（战场透得出来 —— 联机那一局服务端照跑，糊掉屏幕不等于停下）',
      pz.scrim && /rgba?\(/.test(pz.bg), pz.bg);
    ok('M10b 暂停屏右侧那一栏有真榜单可读（同一份 scoreboardHTML，不抄第二份格式）',
      pz.hasBoard && pz.rows >= 1 && pz.keys && pz.vol, `行数=${pz.rows}·键位=${pz.keys}·音量=${pz.vol}`);
    const sig0 = await page.evaluate(() => {
      window.__pp = 0;
      const o = game.menu.paintPauseBoard.bind(game.menu);
      game.menu.paintPauseBoard = () => { window.__pp++; o(); };
      return (document.getElementById('pauseBoard') || {}).innerHTML || '';
    });
    // 改的是被测对象自己读的那本账（scoreboardHTML 的队名那一串就是 Math.floor(scores.A)）。
    // 明确写 A 而不是 Object.keys(...)[0]：那一局刚开局时 B 可能还没有记过账，
    // 取到空 key 就改成"数据没变"，与"界面不刷"在同一把尺下长得一样。
    await page.evaluate(() => { const m = game.mode; if (m && m.scores) m.scores.A = (m.scores.A || 0) + 7; });
    // 轮询而不是死等 1.3 秒：那一拍的进料是**渲染帧的 dt**，而暂停屏带着 backdrop-filter，
    // 在 swiftshader 下每帧 200~400ms，raw 又被 min(0.25, delta) 截掉一截 —— 实测 1.3 秒墙钟
    // 只攒到 0.258，那 0.5 的闸门当然还没开。等的是"它到底重画没有"，不是"给我固定多久"。
    await page.evaluate(w => { window.__sig0 = w; }, sig0);
    const repainted = await wait(() => (document.getElementById('pauseBoard') || {}).innerHTML !== window.__sig0, 12000, 250);
    const sig1 = await page.evaluate(() => (document.getElementById('pauseBoard') || {}).innerHTML || '');
    // 红了要一眼看出断在哪一环：pp=节拍根本没来 / acc 不涨=那一支没被喂 / scr 不是 pause=屏早换了。
    const diag = await page.evaluate(() => ({
      pp: window.__pp, acc: +(game.menu._pauseAcc || 0).toFixed(3), scr: game.menu.screen,
      paused: game.paused, state: game.state, A: game.mode && game.mode.scores && game.mode.scores.A,
      sig: (game.menu._pauseSig || '').length,
    }));
    ok('M10c 挂着不动它自己也活着：改了榜单的输入，那一栏真的重画，而且画它的是那一拍（不是按下 Esc 那一刻的快照）',
      repainted && sig1 !== sig0 && sig1.length > 4 && diag.pp >= 1,
      `${sig0.length}→${sig1.length} 字节·那一拍跑了 ${diag.pp} 次 ` + JSON.stringify(diag));
    await page.evaluate(() => game.pause(false)); await sleep(300);
  }

  ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 2).join(' ⏐ '));
  await ctx.close(); srv.kill();
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message))); n++; bad++;
} finally { await browser.close(); if (srv) srv.kill(); }
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过`);
process.exit(bad ? 1 : 0);
