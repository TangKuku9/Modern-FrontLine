// 真实客户端（js/main.js 那条 RAF 循环）的帧率无关性回归。
// server/fps-independence.mjs 测的是 Node 侧复刻的主循环，这里测玩家实际跑的那一条。
//
// 手法上被自己坑过一次，记在这里：输入要按 **tick** 给，不能按渲染帧给。
// 按帧给的话，15Hz 一帧攒 4 个 tick 只有第一个 tick 拿得到输入，本来就该和 240Hz 不一样，
// 量出来的是"输入总线粒度"而不是"物理离散化"。所以拆开测：
//   S1 纯按住   —— 只考物理离散化，固定步长下必须逐位全等
//   参考行      —— 绕开渲染帧手动逐 tick 喂输入（=服务端循环形状），必须等于客户端 60Hz
//   S2 带转向   —— 输入仍按帧到达，量出总线粒度的残余影响，作为 P1 tick 化输入队列的依据
//   对照组      —— fixedStep=false（改造前）必须漂，否则这把尺子永远绿、白测
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

const HZ = [15, 30, 60, 100, 144, 240];
const TICKS = 120;                    // 2 秒模拟量，按 tick 数而不是墙钟
const seed = +(process.env.SEED || 20260925);

const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
// 机器上装的 playwright 1.63 要 chromium build 1243，实际只有 1234 —— 不为这个去下载新浏览器：
// 先用系统 Chrome（Playwright 开独立临时 profile，不碰用户配置），再退回已装的 1234。
async function launch() {
  const tries = [
    ['chrome', { channel: 'chrome', args: ARGS }],
    // 中间这一档是 `npx playwright install chromium` 装的那一份（不带 channel/executablePath），
    // 也是**别人的机器**上唯一可能起得来的那一档 —— docs-guard 的 G 段拿它当判据。
    ['playwright-chromium', { args: ARGS }],
    ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }],
  ];
  for (const [label, opts] of tries) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('没有可用浏览器：跑 `npx playwright install chromium` 后重试');
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const problems = [];
const httpBad = [];
page.on('pageerror', e => problems.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('[console.error] ' + m.text()); });
page.on('response', r => { if (r.status() >= 400) httpBad.push(`[HTTP ${r.status()}] ${r.url()}`); });
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
const srv = await withServer();
await page.goto(srv.base + '/index.html');
await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 180000 });

const out = await page.evaluate(async ({ HZ, TICKS, seed }) => {
  const { rng } = await import('./js/rng.js');
  const g = window.game;
  const DT = 1 / 60;
  g.renderer.setAnimationLoop(null);            // 关掉真 RAF，改成手动喂假时钟
  const realRender = g.composer.render.bind(g.composer);
  const realClock = g.clock;
  const realNow = performance.now;
  g.composer.render = () => {};                  // 只跑模拟；渲染另外用截图验一次
  const CFG = { mode: 'tdm', map: 'yard', diff: 1, allies: 4, enemies: 4, scoreLimit: 50, timeLimit: 10 };
  // 帧率上限吃的是 performance.now()，而模拟吃的是 clock.getDelta()。要控住上限
  // 就必须两边一起造假，且假时钟要走**单调递增**的虚拟墙钟：真实 rAF 里这两个源同进，
  // 只把 getDelta 钉成常数而让 performance.now() 走真实时间的话，虚拟墙钟与虚拟 dt
  // 相互脱钩，量到的既不是帧率也不是墙钟推进。所以两者共用一个变量。
  // 时钟按**帧**跳，不按调用跳：一帧之内所有读数是同一个时刻（本帧第一次读时推进，
  // 之后同一帧内的读者拿到同一个值）。按调用跳会把"帧内的表现时钟"（soldier.js 的呼吸
  // 微晃、viewmodel.js 的摆动）也一起推走 —— 一帧里士兵、视图模型各读一次，虚拟墙上就
  // 过去了十几毫秒，量出来的"墙钟"随即与真实节拍脱钩（第一版就是这么红的）。
  // 每一帧的第一次 performance.now() 就该是这一帧的时刻，所以计数在**读**里加。
  // 虚拟时钟：一次只有一个"假时间源"。每一帧的推进写在**喂帧的那一刻**（tapFrame），
  // 不在某个"第一次读"里 —— 时钟是 main.js 帧首读的，窗口里读到的必须是这一帧的时刻，
  // 而 performance.now() 读到的必须和它一样。挂在"第一次读"上的话，谁先读谁决定
  // 这一帧算几毫秒，量出来的时间线就跟着读序漂（第三版就是这么红的）。
  let simNow = 0, simDt = 1 / 60;
  const V = { base: 0, set(t) { simNow = t; V.last = t; } };
  const tapClock = { getDelta: () => simDt };
  // 一格 = 一帧：先按这一帧的 dt 把虚拟墙钟推到位，再让 main.js 走一整帧。
  const tapFrame = (dt) => { simDt = dt; simNow += dt * 1000; V.last = simNow; g.frame(); };
  const installVirtualTime = (base) => { V.base = base; simNow = base; V.last = base; simDt = 1 / 60; performance.now = () => V.last; };
  const restoreVirtualTime = () => { performance.now = realNow; };

  async function boot(hz) {
    rng.seed(seed);
    // 性能审查 C5：Worker 寻路的送达拍随墙钟抖，会把下面"跨帧率逐位全等"的判据
    // 打碎（bot 的走位进 hp/aliveBots 比对行）。本套件量的是物理离散化，寻路 Worker
    // 的端到端判据在 test/worker-live.mjs —— 这里整条走同步路保确定性。
    g.pathWorker = null;
    await g.startGame('mp', CFG);                // startGame 自己会把 time/tick/acc 归零
    g.clock = { getDelta: () => 1 / hz };
    g.input.keys.KeyW = true;
  }
  function sample(tag, hz, fixed) {
    const p = g.player, w = p.ws.w;
    return {
      tag, hz, fixed, tick: g.tick, simT: +g.time.toFixed(6),
      x: +p.pos.x.toFixed(6), y: +p.pos.y.toFixed(6), z: +p.pos.z.toFixed(6),
      yaw: +p.yaw.toFixed(6), pitch: +p.pitch.toFixed(6),
      onGround: !!p.onGround, crouchT: +p.crouchT.toFixed(6),
      rp: +p.ws.rp.toFixed(6), shotsInRow: p.ws.shotsInRow,
      mag: w.mag, reserve: w.reserve, hp: +p.hp.toFixed(3),
      aliveBots: g.bots.filter(b => b.alive).length,
      draws: rng.draws,
    };
  }

  // 停止条件按模式给：固定步长数 tick（各档跑的是同一段模拟），
  // 变步长数渲染帧（它压根不推进 tick，只能按 2 秒墙钟对齐——这正是它的毛病所在：
  // 同样 2 秒，15Hz 走 30 步、240Hz 走 480 步）
  const stop = (fixed, hz, guard) => fixed ? (g.tick >= TICKS || guard > 5000) : guard >= Math.round(2 * hz);

  // S1：只有按住（前进 + 一直开火）。输入内容与帧率无关，纯考物理离散化。
  async function holdsRun(hz, fixed) {
    g.settings.fixedStep = fixed;
    await boot(hz);
    g.input.buttons = 1;
    let guard = 0;
    while (!stop(fixed, hz, guard++)) g.frame();
    g.input.buttons = 0; g.input.keys.KeyW = false;
    return sample('holds', hz, fixed);
  }

  // 参考行：绕开渲染帧，一个 tick 一份输入 —— 服务端权威循环就是这个形状
  async function refRun() {
    g.settings.fixedStep = true;
    await boot(60);
    const per = 120 / 60;                        // 与 S2 相同的每秒鼠标总量
    for (let k = 0; k < TICKS; k++) {
      g.input.mdx = per;
      g.input.buttons = (k >= 12 && k < 84) ? 1 : 0;
      if (k === 30) g.input.pressed.Space = true;
      if (k === 60) g.input.pressed.KeyC = true;
      g.update(DT, g.snapshotInput());
      g.tick++;
    }
    g.input.buttons = 0; g.input.keys.KeyW = false;
    return sample('ref', 60, true);
  }

  // S2：带转向和蹲跳边沿。输入只能按渲染帧到达（真客户端就是这个粒度）。
  // 输入脚本按"模拟时间"给（固定步长取 tick/60，变步长取 帧号/hz），
  // 这样两种模式下 0.2s 开火、0.5s 跳、1.0s 蹲都发生在同一时刻，对照组才是公平的。
  async function steerRun(hz, fixed) {
    g.settings.fixedStep = fixed;
    await boot(hz);
    let guard = 0, prevT = 0;
    while (!stop(fixed, hz, guard)) {
      const wt = fixed ? g.tick / 60 : guard / hz;
      g.input.mdx += 120 / hz;                   // 每渲染帧攒一点，整份交给下一个 tick
      if (wt >= 0.2 && prevT < 0.2) g.input.buttons = 1;
      if (wt >= 1.4 && prevT < 1.4) g.input.buttons = 0;
      if (wt >= 0.5 && prevT < 0.5) g.input.pressed.Space = true;
      if (wt >= 1.0 && prevT < 1.0) g.input.pressed.KeyC = true;
      prevT = wt; guard++;
      g.frame();
    }
    g.input.buttons = 0; g.input.keys.KeyW = false;
    return sample('steer', hz, fixed);
  }

  // ── 帧率上限 ─────────────────────────────────────────────────────────────
  // 一条节拍脚本 = 一帧一个 dt（= rAF 给的那一拍）。只跳帧不 sleep，所以"每帧的 dt"
  // 才是唯一的输入；虚拟墙钟由 installVirtualTime 按同一个 dt 推进。
  const script = (n, makeDt) => Array.from({ length: n }, (_, i) => makeDt(i));
  const scripts = {
    '60': script(140, () => 1 / 60),                                    // 60Hz 屏
    '240': script(560, () => 1 / 240),                                  // 240Hz 屏
    // 144Hz 屏的节拍不是 6.94ms 的等间隔：rAF 把帧对齐到 6.94ms 的格子上，
    // 16.667/6.944 不是整数，于是一拍 6.944、下一拍 13.889 交替。带上它才知道
    // 节拍锚的容差是不是真的在干活（对照组见下）。
    '144/60cap': script(210, i => (i % 2 ? 2 : 1) / 144),
    '144': script(210, () => 1 / 144),
    // 一帧一停：3 个 2ms 的短拍后跟一个 30ms 的长拍。上限放行时 raw 要带上攒下的
    // _capPend，否则墙钟会被砍掉一截（详见 main.js 那段注释）。
    'jitter': script(160, i => (i % 4 === 3 ? 30 : 2) / 1000),
    // 恒定相位差：每帧都比节拍锚早 1.0ms（容差 1.5ms 之内）。这是容差那一侧的边界，
    // 钉住两件事：一是早到 1ms 的墙钟不该被误判成"还没到"（真误判了就是无谓掉帧，
    // 挡掉的 dt 还得补给下一拍）；二是这种情况下的掉帧必须仍然罕见 —— 实测 1/160。
    // 60Hz 屏上 rAF 的抖动就在 1ms 上下，这正是那 1.5ms 要吃的量。
    'early': script(160, () => (16.667 - 1.0) / 1000),
  };
  let sseq = 0;
  // 跑一条脚本。onMeter/onNow 只在每次 frame() **真的进了渲染路径**时记一笔 ——
  // 跳过帧会提前 return，两个都不该被调到。
  function testCap(cap, dts, onMeter, onNow) {
    installVirtualTime(1e6 * (++sseq));
    g.clock = tapClock;
    g.settings.fixedStep = true; g.settings.fpsCap = cap;
    g._capNext = 0; g._capPend = 0;
    const base = V.last, f0 = g.frames, r0 = g.renders, k0 = g.skipped;
    const meters = [];
    const realMeter = g.hud.meterFrame, realComposer = g.composer.render;
    g.hud.meterFrame = (dt) => { meters.push(dt); if (onMeter) onMeter(dt); };
    g.composer.render = (dt) => { if (onNow) onNow(V.last); realComposer(dt); };
    for (const dt of dts) tapFrame(dt);
    g.hud.meterFrame = realMeter; g.composer.render = realComposer;
    const wall = V.last - base;
    return {
      cap, wall, frames: g.frames - f0, draws: g.renders - r0, skipped: g.skipped - k0,
      tick: g.tick, simT: g.time, fps: meters.length / (wall / 1000), meters,
    };
  }
  // 上限的生命周期：先锁 30 跑一段（必须真挡掉），关成 0 再跑一段（必须一帧不挡）。
  async function capTrial(cap, dts) {
    rng.seed(seed); await g.startGame('mp', CFG);
    const a = testCap(cap, dts);
    const b = testCap(0, script(30, () => 1 / 60));
    return { a, b };
  }
  // 锁帧不得改变对局结果：同一份输入、同一条墙钟，带上限与不带上限必须逐位全等。
  // 与 S1 同一个手法（只按住、按 tick 判停），但墙上推进由 30Hz 的节拍脚本给。
  async function cappedHold(hz, cap) {
    rng.seed(seed); await g.startGame('mp', CFG);
    const dts = script(400, () => 1 / hz);
    installVirtualTime(1e6 * (++sseq));
    g.clock = tapClock;
    g.settings.fixedStep = true; g.settings.fpsCap = cap;
    g._capNext = 0; g._capPend = 0;
    g.input.keys.KeyW = true; g.input.buttons = 1;
    let i = 0;
    while (g.time < 1.0 && i < dts.length) tapFrame(dts[i++]);
    const s = sample(`cap${cap}`, hz, true);
    g.input.keys.KeyW = false; g.input.buttons = 0;
    return s;
  }

  const rows = { holdsF: [], holdsV: [], steerF: [], steerV: [], ref: null };
  for (const hz of HZ) rows.holdsF.push(await holdsRun(hz, true));
  for (const hz of HZ) rows.holdsV.push(await holdsRun(hz, false));
  for (const hz of HZ) rows.steerF.push(await steerRun(hz, true));
  for (const hz of HZ) rows.steerV.push(await steerRun(hz, false));
  rows.ref = await refRun();

  // 锁帧：默认（不锁）必须一帧不挡；每一档上限都要真的把帧率压到设定值附近，
  // 同时**模拟推进的墙钟一秒不少**（少一秒就是慢动作）；关回 0 要立刻恢复不挡。
  const caps = [];
  for (const [cap, name] of [[0, '60'], [30, '240'], [60, '144/60cap'], [60, '144'], [60, 'jitter'], [60, 'early']]) {
    const { a, b } = await capTrial(cap, scripts[name]);
    caps.push({ ...a, name, resumed: b.frames, resumedSkipped: b.skipped, resumedDraws: b.draws });
  }
  // 读数本身：meterFrame 每次放行帧各来一次，且喂进来的是那一帧的**墙钟差**。
  // 用一条 100ms 一帧的节拍单独验一次 —— 这时墙钟差 0.1s 而 rdt 只到 0.05s，
  // 读数报的是前者才说明右下角的 FPS 没被 rdt 的截断压在 20 FPS 上。
  rng.seed(seed); await g.startGame('mp', CFG);
  const meter = { sum: 0, min: Infinity, at: [] };
  const meterRun = testCap(0, script(10, () => 0.1),
    dt => { meter.sum += dt; meter.min = Math.min(meter.min, dt); },
    at => { meter.at.push(at); });
  // 对局结果不变性：同一份输入、同一段墙钟，30Hz 节拍下锁 30 与不锁必须逐位全等。
  const capped30 = await cappedHold(30, 30);
  const capped0 = await cappedHold(30, 0);
  const ROW_KEYS = ['tick', 'simT', 'x', 'y', 'z', 'yaw', 'pitch', 'onGround', 'crouchT', 'rp',
    'shotsInRow', 'mag', 'reserve', 'hp', 'aliveBots', 'draws'];
  const rowKey = r => JSON.stringify(ROW_KEYS.map(k => r[k]));
  const sameRun = rowKey(capped30) === rowKey(capped0);
  const diffKeys = ROW_KEYS.filter(k => capped30[k] !== capped0[k]);

  // 后面的暂停/视图模型两段要回真时钟：假 clock 的 getDelta 是被脚本推的，
  // 「按渲染帧驱动」那条断言会变成在验脚本，不是验实现。
  g.settings.fpsCap = 0;
  g.clock = realClock; restoreVirtualTime();
  realClock.getDelta();

  // 暂停排空：暂停 30 帧狂甩鼠标，解除后不该把攒下的位移一次性甩飞
  g.settings.fixedStep = true;
  const yawBefore = g.player.yaw;
  g.paused = true;
  for (let i = 0; i < 30; i++) { g.input.mdx += 40; g.input.mdy += 12; g.frame(); }
  const yawPaused = g.player.yaw;
  g.paused = false; g.frame();
  const yawAfter = g.player.yaw;

  // 视图模型必须按渲染帧走，不能退回 60Hz：高刷屏上手持画面才不卡
  g.settings.fixedStep = true;
  await boot(240);
  const vm = g.player.ws.vm;
  let vmCalls = 0;
  const origVm = vm.update.bind(vm);
  vm.update = (dt) => { vmCalls++; origVm(dt); };
  const tick0 = g.tick;
  for (let i = 0; i < 12; i++) g.frame();        // 12 帧 @240Hz = 0.05s = 3 个 tick
  const tickDelta = g.tick - tick0;
  vm.update = origVm;

  g.composer.render = realRender;
  g.clock = realClock; realClock.getDelta();     // 丢掉假时钟期间攒下的时间，别一恢复就补 8 步
  g.input.keys.KeyW = false; g.input.buttons = 0; g.paused = false;
  g.renderer.setAnimationLoop(() => g.frame());
  return {
    rows, caps, sameRun, diffKeys,
    meter: { calls: meterRun.draws, sum: meter.sum, min: meter.min, wall: meterRun.wall, fps: meterRun.fps },
    pause: { yawBefore, yawPaused, yawAfter, mdxLeft: g.input.mdx }, vm: { vmCalls, tickDelta },
  };
}, { HZ, TICKS, seed });

const KEYS = ['tick', 'simT', 'x', 'y', 'z', 'yaw', 'pitch', 'onGround', 'crouchT', 'rp', 'shotsInRow', 'mag', 'reserve', 'hp', 'aliveBots', 'draws'];
const key = r => JSON.stringify(KEYS.map(k => r[k]));
const maxMinus = (rows, k) => Math.max(...rows.map(r => r[k])) - Math.min(...rows.map(r => r[k]));
function report(title, rows) {
  console.log(`\n${title}`);
  for (const r of rows) {
    console.log(`  ${String(r.hz).padStart(4)}Hz  tick ${String(r.tick).padStart(3)}  simT ${r.simT.toFixed(4)}  ` +
      `落点 ${r.x.toFixed(5)},${r.z.toFixed(5)}  yaw ${r.yaw.toFixed(5)}  弹匣 ${r.mag}  rp ${r.rp.toFixed(5)}  抽数 ${r.draws}`);
  }
  const uniq = new Set(rows.map(key)).size;
  const dist = rows.map(r => Math.hypot(r.x - rows[0].x, r.z - rows[0].z));
  const s = { identical: uniq === 1, uniq, maxDist: +Math.max(...dist).toFixed(4), mag: maxMinus(rows, 'mag'), tick: maxMinus(rows, 'tick'), draws: maxMinus(rows, 'draws') };
  console.log(`  → ${s.identical ? '逐位全等' : `${uniq} 种不同结果`}   落点最大偏差 ${s.maxDist} m   弹匣极差 ${s.mag}   tick 极差 ${s.tick}   抽数极差 ${s.draws}`);
  return s;
}

const H = report('S1 纯按住 · fixedStep=true（物理离散化，应当逐位全等）', out.rows.holdsF);
const HV = report('S1 对照组 · fixedStep=false（改造前，应当漂）', out.rows.holdsV);
const SF = report('S2 带转向+蹲跳 · fixedStep=true（残余＝输入总线粒度）', out.rows.steerF);
const SV = report('S2 对照组 · fixedStep=false', out.rows.steerV);
console.log('\n参考行 · 绕开渲染帧逐 tick 喂输入（服务端循环形状）');
const ref = out.rows.ref;
console.log(`  60Hz 逐tick  tick ${ref.tick}  落点 ${ref.x.toFixed(5)},${ref.z.toFixed(5)}  yaw ${ref.yaw.toFixed(5)}  弹匣 ${ref.mag}  rp ${ref.rp.toFixed(5)}  抽数 ${ref.draws}`);
const ref60 = out.rows.steerF.find(r => r.hz === 60);
const refMatches60 = key(ref) === key(ref60);
console.log(`  与 S2@60Hz 全等 = ${refMatches60}${refMatches60 ? '' : '   差异字段: ' + KEYS.filter(k => ref[k] !== ref60[k]).join(',')}`);
console.log(`  与 S1@60Hz 全等 = ${key(ref) === key(out.rows.holdsF.find(r => r.hz === 60))}（不同输入脚本，本就该不等）`);

// ── 帧率上限 ──────────────────────────────────────────────────────────────
// 判据分两半，缺一不可：
//   节流（draws/fps）—— 上限得真的在挡帧；挡不住的"锁帧"是个摆设。
//   保真（tick/simT）—— 挡掉的帧其 dt 必须攒着补给放行帧，否则模拟按"放行帧数"
//   推进，锁 30 就整局慢一半。这一条是锁帧最容易错的地方，所以两半都上闸。
console.log('\n帧率上限 · 节拍脚本喂假墙钟（每档都是"只跳帧不 sleep"）');
const capChecks = [];
for (const c of out.caps) {
  const lock = c.cap > 0;
  const draws = c.draws, skipPct = 100 * c.skipped / Math.max(1, c.frames);
  // 模拟推进的墙钟：tick 是量化后的，所以拿 simT 比墙钟，容差 1/60 拍 + 5%。
  const simErr = Math.abs(c.simT - c.wall / 1000);
  console.log(`  cap ${String(c.cap).padStart(3)} @ ${c.name.padEnd(9)} 节拍 ${c.frames} 帧 / ${(c.wall / 1000).toFixed(3)}s  ` +
    `画了 ${String(draws).padStart(3)} 帧（挡掉 ${String(c.skipped).padStart(3)}，${skipPct.toFixed(0)}%）  ` +
    `实测 ${c.fps.toFixed(1)} FPS  模拟推进 ${(c.simT * 1000).toFixed(0)}ms（墙钟 ${c.wall.toFixed(0)}ms，差 ${simErr.toFixed(1)}ms）`);
  const tapFps = c.frames / (c.wall / 1000);   // 节拍脚本自己的速率：不锁时就该画这么多
  // 锁帧的实测帧率必须落在上限附近。12% 太松 —— 容差被人拿掉时锁 60 也只掉到
  // 59.8（那 1ms 相位差每 16 拍才吃掉一次误判），所以收到 5%：真正会塌一半的错法
  // （判早的阈值调大、节拍锚每帧都推进）掉到 30，一条都跑不掉。
  const throttleOk = lock
    ? Math.abs(c.fps - c.cap) / c.cap < 0.05 && c.skipped > 0 && c.fps < 1.5 * c.cap
    : c.skipped === 0 && c.draws === c.frames && Math.abs(c.fps - tapFps) / tapFps < 1e-9;
  const fidelityOk = simErr < 1 / 60 + 0.05 * c.wall / 1000;
  const resumeOk = c.skipped > 0 ? (c.resumedDraws === c.resumed && c.resumedSkipped === 0) : true;
  capChecks.push({ ...c, throttleOk, fidelityOk, resumeOk });
}
const uncapped = capChecks.find(c => c.cap === 0);
const allCapGreen = capChecks.every(c => c.throttleOk && c.fidelityOk && c.resumeOk);
console.log(`  不锁档：${uncapped.frames} 节拍全部放行 = ${uncapped.skipped === 0 && uncapped.draws === uncapped.frames}`);
console.log(`  关回 0 后：${capChecks.filter(c => c.skipped > 0).map(c => `cap${c.cap}@${c.name} 恢复 ${c.resumedDraws}/${c.resumed} 帧不挡`).join(' ／ ') || '（本次没有真挡帧的档）'}`);

const m = out.meter;
console.log('\nFPS 读数 · 10 帧 × 100ms 墙钟（rdt 只到 50ms，读数必须是墙钟）');
const meterSumOk = Math.abs(m.sum - m.wall / 1000) < 1e-9;
console.log(`  meterFrame ${m.calls} 次（10 帧各一次 = ${m.calls === 10}）  Σdt ${m.sum.toFixed(3)}s = 墙钟 ${(m.wall / 1000).toFixed(3)}s ${meterSumOk ? '✓' : '✗'}  ` +
  `单帧最小 ${m.min.toFixed(3)}s（截到 0.05 的话这里会是 0.05）  读数 ${m.fps.toFixed(1)} FPS`);
const meterOk = m.calls === 10 && meterSumOk && m.min > 0.09;

console.log('\n锁帧不改变对局结果 · 30Hz 节拍 + 纯按住 1 秒，cap 30 与不锁比对');
console.log(`  ${out.sameRun ? '逐位全等' : '不一致，差异字段: ' + out.diffKeys.join(',')}（比对 ${16} 个字段）`);

const p = out.pause, v = out.vm;
console.log('\n──────────────────────────────────────────────');
console.log(`  暂停期狂甩鼠标 30 帧：yaw ${p.yawBefore.toFixed(5)} -> ${p.yawPaused.toFixed(5)}，解除后 ${p.yawAfter.toFixed(5)}（残余 mdx ${p.mdxLeft}）`);
console.log(`  240Hz 下驱动 12 渲染帧：视图模型更新 ${v.vmCalls} 次，模拟只推进 ${v.tickDelta} 个 tick（手持画面不再被 60Hz 绑住）`);
if (problems.length) console.log('  控制台异常:\n    ' + problems.slice(0, 12).join('\n    '));
if (httpBad.length) console.log('  HTTP 4xx:\n    ' + [...new Set(httpBad)].slice(0, 8).join('\n    '));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test/fps_play.png' });   // 恢复真 RAF 后拍一帧，证明渲染没被测试搞坏

const green = H.identical && refMatches60 && !HV.identical && Math.abs(p.yawAfter - p.yawBefore) < 1e-9 && p.mdxLeft === 0 && problems.length === 0
  && v.vmCalls === 12 && v.tickDelta > 0 && v.tickDelta <= 4
  && allCapGreen && meterOk && out.sameRun;
console.log(`\n  落点偏差：S1 固定 ${H.maxDist} m ／ S1 变步长 ${HV.maxDist} m ／ S2 固定 ${SF.maxDist} m ／ S2 变步长 ${SV.maxDist} m`);
console.log(`  参照：玩家碰撞半径 0.35 m，门口约 1 m 宽。`);
console.log(`  结论：${green ? '绿' : '红'}（要求：S1 固定档全等 / 参考行==客户端60Hz / 对照组必须漂 / 暂停不甩视角 / 视图模型每渲染帧一次 / ` +
  `帧率上限每档节流+保真+恢复 / FPS 读数走墙钟 / 锁帧不改变对局 / 零控制台错误）`);
await browser.close();
srv.kill(); process.exit(green ? 0 : 1);
