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
// 不联网：全程单机（主菜单 → 设置 → 配装 → 枪匠 → 开一局对局）。服务只是页面得有人发；
// 大厅与房间屏的键盘路径要真服务端状态，那一块随 HU-22~HU-26 一起做，不在这一份里半成品。
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
try {
  const srv = await withServer({ REQUIRE_ACCOUNT: '0' });
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

  ok('页面没有真错误', realErrs(logs).length === 0, logs.slice(0, 2).join(' ⏐ '));
  await ctx.close(); srv.kill();
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message))); n++; bad++;
} finally { await browser.close(); }
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过`);
process.exit(bad ? 1 : 0);
