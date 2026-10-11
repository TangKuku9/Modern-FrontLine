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
  // 这里走 DOM 的 click() 而不是 page.click：1280×720 下「重置存档」那一格**落在视口外面**
  // （设置屏比视口高，而这一层没有滚动 —— HU-32 那条"零响应式"的现场，实测读数记在审计里）。
  // K 段要量的是那一层本身，不是先把视口调大。
  ok('K0【顺带量到的 HU-32 现场】1280×720 下设置屏最后一行落在视口外（鼠标点不到它，只能滚 —— 而这一屏不滚）',
    await page.evaluate(() => { const b = document.querySelector('[data-a=resetp]'); if (!b) return false; const r = b.getBoundingClientRect(); return r.bottom > innerHeight || r.top < 0; }),
    await page.evaluate(() => { const b = document.querySelector('[data-a=resetp]'); return b ? Math.round(b.getBoundingClientRect().bottom) + '/' + innerHeight : '没这一格'; }));
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

  ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 2).join(' ⏐ '));
  await ctx.close(); srv.kill();
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message))); n++; bad++;
} finally { await browser.close(); if (srv) srv.kill(); }
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过`);
process.exit(bad ? 1 : 0);
