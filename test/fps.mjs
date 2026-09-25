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

const HZ = [15, 30, 60, 100, 144, 240];
const TICKS = 120;                    // 2 秒模拟量，按 tick 数而不是墙钟
const seed = +(process.env.SEED || 20260925);

const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
// 机器上装的 playwright 1.63 要 chromium build 1243，实际只有 1234 —— 不为这个去下载新浏览器：
// 先用系统 Chrome（Playwright 开独立临时 profile，不碰用户配置），再退回已装的 1234。
async function launch() {
  const tries = [
    ['chrome', { channel: 'chrome', args: ARGS }],
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
await page.goto('http://localhost:8080/index.html');
await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 180000 });

const out = await page.evaluate(async ({ HZ, TICKS, seed }) => {
  const { rng } = await import('./js/rng.js');
  const g = window.game;
  const DT = 1 / 60;
  g.renderer.setAnimationLoop(null);            // 关掉真 RAF，改成手动喂假时钟
  const realRender = g.composer.render.bind(g.composer);
  const realClock = g.clock;
  g.composer.render = () => {};                  // 只跑模拟；渲染另外用截图验一次
  const CFG = { mode: 'tdm', map: 'yard', diff: 1, allies: 4, enemies: 4, scoreLimit: 50, timeLimit: 10 };

  async function boot(hz) {
    rng.seed(seed);
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

  const rows = { holdsF: [], holdsV: [], steerF: [], steerV: [], ref: null };
  for (const hz of HZ) rows.holdsF.push(await holdsRun(hz, true));
  for (const hz of HZ) rows.holdsV.push(await holdsRun(hz, false));
  for (const hz of HZ) rows.steerF.push(await steerRun(hz, true));
  for (const hz of HZ) rows.steerV.push(await steerRun(hz, false));
  rows.ref = await refRun();

  // 暂停排空：暂停 30 帧狂甩鼠标，解除后不该把攒下的位移一次性甩飞
  g.settings.fixedStep = true;
  const yawBefore = g.player.yaw;
  g.paused = true;
  for (let i = 0; i < 30; i++) { g.input.mdx += 40; g.input.mdy += 12; g.frame(); }
  const yawPaused = g.player.yaw;
  g.paused = false; g.frame();
  const yawAfter = g.player.yaw;

  g.composer.render = realRender;
  g.clock = realClock; realClock.getDelta();     // 丢掉假时钟期间攒下的时间，别一恢复就补 8 步
  g.input.keys.KeyW = false; g.input.buttons = 0; g.paused = false;
  g.renderer.setAnimationLoop(() => g.frame());
  return { rows, pause: { yawBefore, yawPaused, yawAfter, mdxLeft: g.input.mdx } };
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

const p = out.pause;
console.log('\n──────────────────────────────────────────────');
console.log(`  暂停期狂甩鼠标 30 帧：yaw ${p.yawBefore.toFixed(5)} -> ${p.yawPaused.toFixed(5)}，解除后 ${p.yawAfter.toFixed(5)}（残余 mdx ${p.mdxLeft}）`);
if (problems.length) console.log('  控制台异常:\n    ' + problems.slice(0, 12).join('\n    '));
if (httpBad.length) console.log('  HTTP 4xx:\n    ' + [...new Set(httpBad)].slice(0, 8).join('\n    '));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test/fps_play.png' });   // 恢复真 RAF 后拍一帧，证明渲染没被测试搞坏

const green = H.identical && refMatches60 && !HV.identical && Math.abs(p.yawAfter - p.yawBefore) < 1e-9 && p.mdxLeft === 0 && problems.length === 0;
console.log(`\n  落点偏差：S1 固定 ${H.maxDist} m ／ S1 变步长 ${HV.maxDist} m ／ S2 固定 ${SF.maxDist} m ／ S2 变步长 ${SV.maxDist} m`);
console.log(`  参照：玩家碰撞半径 0.35 m，门口约 1 m 宽。`);
console.log(`  结论：${green ? '绿' : '红'}（要求：S1 固定档全等 / 参考行==客户端60Hz / 对照组必须漂 / 暂停不甩视角 / 零控制台错误）`);
await browser.close();
process.exit(green ? 0 : 1);
