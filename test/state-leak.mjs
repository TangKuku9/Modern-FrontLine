// 死亡 / 换局 / 热成像这三处的"状态残留"判据。
//
// 共同形状：**写这个字段的那行代码，在出问题的那一刻之后就再也不跑了** ——
// 于是它不是"错了一帧"，是冻在最后一帧上，而且不崩、不报错。
//   ① 开镜时被击杀：ws.update 之后不再被调用 ⇒ adsT / scopeState / cam.fov 冻住，
//      死亡视角上挂着一层瞄具遮罩。
//   ② 死着迎来终局再开一局：deathScreen 原先只在"重生"和"退回菜单"收过。
//   ③ 夜视/热成像瞄具关镜：热成像按 mesh 快照改人物材质，共享材质下第二块存的是"刚被涂白"
//      的值，恢复时又把它涂回去 ⇒ 352 个 mesh 一个都没回来。
// 每条都配反证臂：只写"清理之后要干净"那一半的话，把功能整个删掉也能全绿 ——
// 所以 D0/D1ᵈ/D4⁻ 三条是"该有的东西必须还在"，它们红了说明清理过头了。
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
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
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('没有可用浏览器');
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console.error] ' + m.text()); });
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
const srv = await withServer();
await page.goto(srv.base + '/index.html');
await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 180000 });

const res = await page.evaluate(async () => {
  const out = [];
  const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
  const g = window.game;
  const hidden = (id) => document.getElementById(id).classList.contains('hidden');
  g.renderer.setAnimationLoop(null);
  // ①这一份不看像素，看的是字段与 DOM —— 2400 帧全真渲染（swiftshader）要跑七分钟。出图摘掉，
  // 模拟与 HUD 照常跑（viewmodel.mjs 也是这么做的）。
  const realRender = g.composer.render.bind(g.composer);
  g.composer.render = () => {};
  // ②时钟也得换成固定的：手写的 frames() 两次调用之间是微秒级，而主循环是**固定步长**，
  // 一次 g.frame() 只推得动零点几个 tick —— 不钉住它，跑 200 帧连"切枪那 0.45 秒"都走不完。
  const realClock = g.clock;
  g.clock = { getDelta: () => 1 / 60 };
  const frames = (n, inp) => { for (let i = 0; i < n; i++) { if (inp) inp(); g.frame(); } };

  await g.startGame('mp', { mode: 'tdm', map: 'yard', diff: 1, allies: 4, enemies: 4, scoreLimit: 50, timeLimit: 10 });
  const ws = g.player.ws, pl = g.player;
  frames(60);

  // ---------- ① 开镜时被击杀 ----------
  ws.replaceSlot(0, { id: 'l115', att: {}, camo: 'none' }, 5, 30);
  frames(20);
  ws.switchTo(0);
  frames(60);
  frames(200, () => { g.input.buttons = 4; });

  // D0 是后面每一条的前提，也是它们的反证臂：证明这套判据活在"真的开镜了"的世界里
  ok('D0 活着时能开镜（前提）', ws.adsT > 0.9 && g.scopeState === 'sniper' && !hidden('scope'),
    `adsT=${ws.adsT.toFixed(3)} scopeState=${g.scopeState}`);
  const fovAds = g.camera.fov;
  ok('D0ᵃ 开镜确实把 FOV 收窄了', fovAds < g.settings.fov - 5, `${fovAds.toFixed(1)}° < ${g.settings.fov}°`);

  const killer = g.bots.find(b => b.alive && !b.isPlayer) || g.bots[0];
  pl.takeDamage(999, { attacker: killer, weapon: 'x', head: false });
  g.input.buttons = 0;
  frames(30);

  ok('D1ᵃ 死了就不再是开镜状态', ws.adsT === 0, 'adsT=' + ws.adsT);
  ok('D1ᵇ scopeState 归 null（HUD 的瞄具遮罩据此开关）', g.scopeState === null, String(g.scopeState));
  ok('D1ᶜ 死亡视角上没有瞄具遮罩', hidden('scope'), 'scopeless=' + hidden('scope'));
  ok('D1ᵈ 相机 FOV 回到腰射值', Math.abs(g.camera.fov - g.settings.fov) < 0.5, `${g.camera.fov.toFixed(1)}° vs ${g.settings.fov}°`);
  ok('D1ᵉ 死亡界面倒是该出来的', !hidden('deathScreen'), 'dead=' + g.dead);
  ok('D1ᶠ 死亡时把手 Diane（状态机）松开', ws.state === 'idle' && !ws.cooking && ws.grenade === null, `state=${ws.state} cooking=${ws.cooking}`);

  // D1⁻ 反证臂：清理不许过头 —— 重生了还得能开镜
  for (let i = 0; i < 600 && !pl.alive; i++) g.frame();
  ok('D1⁻ 反证：重生之后还能开镜（清理没把活人的功能也清掉）', pl.alive, 'alive=' + pl.alive);
  // 重生会把装备拨回 class 那一套（见 D5），所以我进场时塞进 slot 0 的那把狙**已经不在手里了** ——
  // 这条判据的前提得自己重新摆一遍，否则它红的其实是"回装生效了"，而不是"开镜被清坏了"。
  // （第一版就栽在这里：D5 那条改动一落地，这条立刻变红，但红的原因是好事。）
  ws.replaceSlot(0, { id: 'l115', att: {}, camo: 'none' }, 5, 30);
  frames(20);
  ws.switchTo(0);
  frames(60);
  frames(200, () => { g.input.buttons = 4; });
  ok('D1⁻ 反证：重生后 ADS 仍然进镜', ws.adsT > 0.9 && g.scopeState === 'sniper', `adsT=${ws.adsT.toFixed(3)} scopeState=${g.scopeState}`);
  g.input.buttons = 0;
  frames(20);

  // ---------- ③ 热成像关镜后的材质 ----------
  {
    const whiteCount = () => {
      let white = 0, total = 0;
      for (const b of g.bots) b.model.root.traverse(o => {
        if (o.isMesh && o.material && o.material.emissive) {
          total++;
          const hex = o.material.emissive.getHex();
          if (hex !== 0) white++;
        }
      });
      return { white, total };
    };
    ws.replaceSlot(0, { id: 'm4', att: { optic: 'thermal' }, camo: 'none' }, 30, 150);
    frames(40);
    ws.switchTo(0);
    frames(90);
    const base = whiteCount();
    ok('D4ᵃ 进场时人物没有自发光（前提）', base.white === 0 && base.total > 0, JSON.stringify(base));
    frames(200, () => { g.input.buttons = 4; });
    const hot = whiteCount();
    // D4⁻ 反证臂：这条不红的话，下面那条"关镜后 white===0"就是恒真绿灯 ——
    // 因为压根没人去过 Fig、它就一直是 0
    ok('D4⁻ 反证：开镜时确实把人物点成了热源', hot.white > 0 && g.scopeState === 'thermal',
      `${hot.white}/${hot.total} scopeState=${g.scopeState}`);
    g.input.buttons = 0;
    frames(200);
    const cold = whiteCount();
    ok('D4⁺ 关镜后人物的自发光全部还原', cold.white === 0, `${cold.white}/${cold.total}（开镜时 ${hot.white}）`);
    ok('D4ᵇ 热成像开关本身也回到 off', g.thermalOn === false && g.grade.uniforms.thermal.value === 0,
      `thermalOn=${g.thermalOn} uniform=${g.grade.uniforms.thermal.value}`);
    // 第二次走的是"早退守卫"那条路；这里小心别犯 builder 的错 —— 关镜就是要把输入松开，
    // 只跑空帧是不会收镜的（第一版就漏了这一句，于是 352 个 mesh 亮着被判成"没恢复"）
    frames(200, () => { g.input.buttons = 4; });
    const hot2 = whiteCount();
    g.input.buttons = 0;
    frames(200);
    const cold2 = whiteCount();
    ok('D4ᶜ 第二次开镜关镜后仍然全还原', cold2.white === 0 && hot2.white > 0, `第二次开镜时 ${hot2.white} → 关镜后 ${cold2.white}`);
    g.input.buttons = 0;
    frames(20);
  }

  // ---------- ② 死着结束对局，再开一局 ----------
  ws.replaceSlot(0, { id: 'l115', att: {}, camo: 'none' }, 5, 30);
  frames(40);
  ws.switchTo(0);
  frames(90);
  pl.takeDamage(999, { attacker: killer, weapon: 'x', head: false });
  frames(30);
  ok('D2ᵃ 这一局确实是死着走到终局的（前提）', !pl.alive && !hidden('deathScreen'), `alive=${pl.alive}`);
  g.mode.end('A');
  frames(120);
  ok('D2⁺ 终局时死亡牌要收起来（不然它盖在结算上）', hidden('deathScreen'), 'hidden=' + hidden('deathScreen'));
  await g.startGame('mp', { mode: 'tdm', map: 'yard', diff: 1, allies: 4, enemies: 4, scoreLimit: 50, timeLimit: 10 });
  frames(60);
  ok('D3⁺ 新一局里没有上一局的死亡牌', hidden('deathScreen'), 'hidden=' + hidden('deathScreen'));
  ok('D3ᵇ 新一局的玩家是活的', g.player.alive && g.dead === false, `alive=${g.player.alive} dead=${g.dead}`);
  ok('D3ᶜ 新一局 scopeState 干净', g.scopeState === null, String(g.scopeState));

  // ---------- ⑤ 地上捡来的枪不该活过重生 ----------
  // 同一个形状（写装备的那一行在重生时没被跑到）：mp.js 的重生只在"死亡界面换过职业"
  // 时才 equip，于是从地上捡的那把枪会一路带到下一次死亡 —— 而捡枪本该是临时的。
  {
    const p2 = g.player, ws2 = p2.ws;
    frames(30);
    const own = ws2.slots[0].id;
    // 真走一遍捡枪路径：脚边放一把别的枪，然后按 F（updatePickups 认的是 inp.interactPressed）
    const drop = own === 'ak' ? 'm4' : 'ak';
    g.spawnPickup(drop, {}, { x: p2.pos.x, y: p2.pos.y, z: p2.pos.z }, 30, 90);
    // F 只按**一次**：捡枪会把手里那把掉回地上，连按就是在同一个回合里跟自己换枪
    // （偶数次正好换回原来那把 —— 第一版按了 12 次，于是"没捡到"的假象被 D5ᵃ 抓了出来）
    frames(1, () => { g.input.pressed['KeyF'] = true; });
    frames(3);
    const picked = ws2.slots[0].id;
    // D5ᵃ 是 D5⁺ 的反证臂：没捡到枪的话，"重生后 id 还是原来那个"就是恒真绿灯
    ok('D5ᵃ 脚边的枪确实被捡起来了（反证臂）', picked === drop, `${own} → ${picked}`);
    const k2 = g.bots.find(b => b.alive && !b.isPlayer) || g.bots[0];
    p2.takeDamage(999, { attacker: k2, weapon: 'x', head: false });
    frames(30);
    for (let i = 0; i < 700 && !p2.alive; i++) g.frame();
    frames(10);
    ok('D5⁺ 重生后握的是自己 class 里那把', ws2.slots[0].id === own,
      `捡到 ${picked} → 重生后 ${ws2.slots[0].id}（class=${own}）`);
    ok('D5ᵇ 重生后弹药是整套拨回来的（不是只换了个 id）', ws2.slots[0].mag === ws2.slots[0].stats.mag,
      `${ws2.slots[0].mag}/${ws2.slots[0].stats.mag}`);
  }

  g.composer.render = realRender;
  g.clock = realClock; realClock.getDelta();
  return out;
});

await browser.close();

let green = errs.length === 0;
for (const [okFlag, label] of res) { green &&= okFlag; console.log(`  ${okFlag ? '✅' : '❌'} ${label}`); }
if (errs.length) console.log('  页面异常:\n    ' + errs.slice(0, 8).join('\n    '));
console.log(`\n  结论：${green ? '绿' : '红'}  ${res.filter(r => r[0]).length}/${res.length}`);
srv.kill();
process.exit(green ? 0 : 1);
