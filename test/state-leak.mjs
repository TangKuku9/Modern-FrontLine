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
  ok('D1ᶠ 死亡时把手 Diane（状态机）松开', ws.state === 'idle' && !ws.cooking && ws.grenade === null && ws.nadeMode === null, `state=${ws.state} cooking=${ws.cooking} nade=${ws.nadeMode && ws.nadeMode.kind}`);

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

  // ---------- ⑥ 联机的死亡路径：onNetDeath ----------
  // 联机里本地玩家的血量由快照直接覆盖（js/net/predict.mjs 写 pl.hp / pl.alive），
  // 全程不走 takeDamage —— 单机那条致死分支里的清场（ws.onDeath / FOV 复位 / alive
  // 落地）在这条路径上一处都不会跑。这里直接调 onNetDeath 模拟"服务端 kill 事件到达"
  // （ev 形状与真实调用点 js/net/client.mjs 的 kill 分支一致），量三件事：
  //   · 清场本体：scopeState / adsT / FOV / alive；
  //   · 读取侧兜底：死亡期间对账重放会拿死前输入重演 ws.update、把 scopeState 写回
  //     scoped —— HUD 与 thermal 必须按 alive 挡住（与 NVG 那行同一防护）；
  //   · 重放本身不写真相机（否则 FOV 又被拽回 ADS）。
  {
    // D3 那一步重新 startGame 过，g.player 已经是新实例 —— 这一段必须取**新鲜引用**
    // （第一版沿用了文件顶部的旧 ws/pl，量的是上上局的死对象：adsT 恒 0、而 fov 的
    // 窄值来自新玩家在真开镜 —— 一半新一半旧，怎么都对不上）。
    const plN = g.player, wsN = plN.ws;
    wsN.replaceSlot(0, { id: 'l115', att: {}, camo: 'none' }, 5, 30);
    frames(20);
    wsN.switchTo(0);
    frames(60);
    frames(200, () => { g.input.buttons = 4; });
    ok('L0 前提：活着时开镜（联机路径的同一套摆位）', wsN.adsT > 0.9 && g.scopeState === 'sniper' && !hidden('scope'),
      `adsT=${wsN.adsT.toFixed(3)} scopeState=${g.scopeState}`);
    const fovAds = g.camera.fov;
    ok('L0ᵃ 前提：FOV 确实被收窄', fovAds < g.settings.fov - 5, `${fovAds.toFixed(1)}° < ${g.settings.fov}°`);

    g.onNetDeath({ killer: '凶手甲', victim: plN.name, weapon: 'ak', head: false });
    // 快照对账随后到（真实时序里它和 kill 事件几乎同时、甚至先到：predict.mjs 直接
    // 覆盖 pl.hp / pl.alive）。**必须**在这之后才断言 —— 第一版没有这两行，旧实现上
    // "kill 事件不清场"的症状被活人正常收镜那条路掩盖了（alive 还挂着 true，
    // frames 期间 ws.update 照跑，adsT 自己衰减回去），四条断言全是假绿。
    plN.alive = false; plN.hp = 0;
    g.input.buttons = 0;
    frames(30);
    ok('L1ᵃ 联机死亡后 scopeState 归 null', g.scopeState === null, String(g.scopeState));
    ok('L1ᵇ 联机死亡后 adsT 清零（onNetDeath 调了 ws.onDeath）', wsN.adsT === 0, 'adsT=' + wsN.adsT);
    ok('L1ᶜ 死亡视角上没有瞄具遮罩', hidden('scope'), 'hidden=' + hidden('scope'));
    ok('L1ᵈ 相机 FOV 回到腰射值', Math.abs(g.camera.fov - g.settings.fov) < 0.5, `${g.camera.fov.toFixed(1)}° vs ${g.settings.fov}°`);
    ok('L1ᵉ alive 已落地（无论 kill 事件与快照谁先到）', plN.alive === false, 'alive=' + plN.alive);
    ok('L1ᶠ 死亡界面出现', !hidden('deathScreen'), 'hidden=' + hidden('deathScreen'));

    // 读取侧兜底：伪造"对账重放把 scopeState 写回 scoped"（predict 的重放窗口覆盖死亡
    // 时刻时真的会发生，用的还是死前那份按着开镜的输入），HUD / thermal 必须挡住。
    g.scopeState = 'sniper';
    frames(5);
    ok('L2ᵃ scopeState 被重放写回时，死亡视角仍无遮罩（HUD 读取侧有 alive 防护）', hidden('scope'),
      `scopeState=${g.scopeState}`);
    ok('L2ᵇ 热成像也不因重放写回而点亮（与 NVG 同一条防护）', g.thermalOn === false, 'thermalOn=' + g.thermalOn);
    g.scopeState = null;

    // 重放不写真相机。重放的真实形状是：predict 先 applyJournal 把人退回死前那一拍
    // （alive=true、adsT=1），再调 replay 的 update —— 所以守卫必须在"复活 + 开镜 +
    // replay"上量才有意义；对尸体直接 update 的话 _sim 在 alive 检查处整个早退，
    // 两条断言都是恒真绿灯（第一版就栽在这）。
    const fovBefore = g.camera.fov;
    plN.alive = true; wsN.adsT = 1;            // 手动摆出"journal 退回死前那一拍"的形状
    plN.update(1 / 60, g.input, { replay: true });
    ok('L3ᵃ 回滚重放不写真相机（FOV 不被拽回 ADS）',
      Math.abs(g.camera.fov - fovBefore) < 1e-6 && Math.abs(g.camera.fov - g.settings.fov) < 0.5,
      `${fovBefore.toFixed(1)}° → ${g.camera.fov.toFixed(1)}°`);
    // 反证臂：同一份状态、非 replay 的正常 update 必须写相机 —— 它红了说明
    // updateCamera 整个被跳过了，那是修过头。
    plN.update(1 / 60, g.input);
    ok('L3ᵇ 反证：非重放的正常 update 仍写相机（开镜状态的窄 FOV 可见）', g.camera.fov < g.settings.fov - 5,
      `${g.camera.fov.toFixed(1)}° < ${g.settings.fov}°`);
    plN.alive = false;                         // 摆位结束，把人放回死亡态（本段到此为止）
  }

  // ---------- ⑦ 远端玩家的退出淡出：不许碰共享材质 ----------
  // bug 形状：淡出直接写材质的 transparent/opacity、dispose 再一刀切恢复 opacity=1 ——
  // 而士兵与枪的材料来自 materials.js 的全局 MATS，与我的第一人称枪是**同一批实例**
  // （镜片 lens=0.25、分划 reticle、军服 fab_*、枪身 gunMetal…）。症状："xxx 退出了
  // 对局"之后，我的瞄准镜片在那 0.8 秒里跟着变透明（0.25→0），淡完被永久恢复成
  // 不透明玻璃（0.25→1），军服那批 opaque 材质从此走透明渲染管线（transparent 没人恢复）。
  {
    const { NetPlayer } = await import('./js/net/remote.mjs');
    const matsMod = await import('./js/materials.js');
    const lens = matsMod.mat('lens'), fab = matsMod.mat('fab_enemy');
    ok('F0 前提：镜片基线 0.25 半透明、军服 opaque',
      lens.opacity === 0.25 && lens.transparent === true && fab.transparent === false,
      `lens=${lens.opacity}/${lens.transparent} fab=${fab.transparent}`);
    // 枪必须带红点镜（optic: reddot）：lens/reticle 材质只存在于装了瞄具的枪模上，
    // 素枪只有军服和枪身 —— 第一版没装 optic，lens 那几条断言整个空转（假绿）。
    const mk = (id) => new NetPlayer(g, { id, name: '路人' + id, team: 'B', weapon: 'm4',
      kits: { m4: { att: { optic: 'reddot' } } },
      x: g.player.pos.x + 2, y: g.player.pos.y, z: g.player.pos.z, yaw: 0 });
    const r1 = mk(901), r2 = mk(902);
    r1.beginLeave(); r2.beginLeave();          // 两个人先后脚退出（共享同一批全局材质）
    // 前提中的前提：镜片真的被收进了淡出集合 —— 这条不成立的话，下面 F1/F2 里
    // 所有 lens 断言都是"压根没人碰它"的恒真绿灯。
    ok('F0ᵇ 前提：镜片材质在淡出集合里', !!r1._fadeMats && r1._fadeMats.some(m => m.opacity === 0.25),
      `fadeMats=${r1._fadeMats && r1._fadeMats.length}`);
    r1.update(0.05); r2.update(0.05);          // 淡出进行中
    ok('F1 淡出进行中：全局镜片一个字段都没动', lens.opacity === 0.25 && lens.transparent === true, `opacity=${lens.opacity}`);
    ok('F1ᵇ 军服也没被拉进透明管线', fab.transparent === false, 'transparent=' + fab.transparent);
    // 反证臂：淡出本身必须真的在走（否则 F1/F1ᵇ 是"淡出根本没跑"的恒真绿灯）
    const mid = r1._fadeMats && r1._fadeMats.map(m => m.opacity);
    ok('F1ᶜ 反证：模型自己的材质确实在变透明', !!mid && mid.length > 0 && mid.every(v => v < 1),
      JSON.stringify(mid && mid.slice(0, 4)));
    for (let i = 0; i < 20; i++) { r1.update(0.05); r2.update(0.05); }   // 推完 0.8s 淡出
    r1.dispose();                              // 旧实现在这里把 lens.opacity 一刀切成 1
    ok('F2 第一个退出者 dispose 后：镜片仍是 0.25', lens.opacity === 0.25, `opacity=${lens.opacity}`);
    ok('F2ᵇ 军服仍是 opaque', fab.transparent === false, 'transparent=' + fab.transparent);
    r2.dispose();
    ok('F3 第二个退出者 dispose 后全局材质仍未动（同时退出互不污染）',
      lens.opacity === 0.25 && fab.transparent === false, `lens=${lens.opacity} fab=${fab.transparent}`);
  }

  // 性质：**纵深防御**。服务端的呼号白名单（NAME_RE）眼下把 `<` 压死了，所以它在真机上
  // 一次都触发不了 —— 而"永远触发不了"的东西最容易被下一次重构顺手删掉（看起来没人用）。
  // 所以判据直接在真 DOM 上打一枪，看两件事：
  //   (a) 有没有**真的多出一个元素**（注入成功的话这里会出现 <img>）；
  //   (b) 屏幕上是不是**原样**显示那串字。
  // 只写 (b) 不行（把内容整个删掉也读不出那串字）；只写 (a) 也不行（内容改成空串就没有 <img>）。
  // 谁是拼 innerHTML 的那一处，转义就归谁 —— 所以 HUD 这两处（killfeed / announce）
  // 现在是**自己**转，调用方不再转（调用方转的话会显示成 `&lt;`）。
  {
    const XSS = '<img src=x onerror="window.__xssHud=1"><b>粗</b>';
    const XSS2 = '<script>window.__xssHud=2</script>';
    delete window.__xssHud;
    g.hud.killfeed({ name: XSS, isPlayer: false, team: 'B' }, { name: XSS2, isPlayer: true, team: 'A' }, XSS, false);
    const kf = document.querySelector('#killfeed .kf');
    ok('X1 击杀提示里的两个呼号 + 武器名都不许被当成标签解析（改动前 weapon 由调用方转义、两个名字裸着）',
      !!kf && !kf.querySelector('img, script, b') && kf.textContent.includes('<img src=x'),
      kf ? JSON.stringify(kf.innerHTML.slice(0, 120)) : '没有 .kf 行');
    ok('X2 而且它们必须**原样**显示出来（反证臂：把内容整个删掉也能让 X1 成立）',
      !!kf && kf.textContent.includes('<script>window.__xssHud=2</script>'),
      kf ? JSON.stringify(kf.textContent.slice(0, 120)) : '');
    g.hud.announce(XSS, XSS2, 3);
    const an = document.getElementById('announce');
    ok('X3 开局播报的 title / sub 两格同样要转 —— sub 那一格是**可能来自服务端**的（掉线说明、大厅 note 帧）',
      !an.querySelector('img, script, b') && an.textContent.includes('<img src=x'),
      JSON.stringify(an.innerHTML.slice(0, 120)));
    // onerror 是**异步**的（图片加载失败要等一轮网络）—— 不等一小会儿再读的话，
    // 注入真的发生了这条也照样绿：X1 红了而 X4 还是 ✅（第一版就是这样）。
    // 判据自己要先站到"能看见"的时刻上，否则它只是一句好听的断言。
    await new Promise(r => setTimeout(r, 90));
    ok('X4 注入确实没有得手（onerror 一次都没跑）', window.__xssHud === undefined, 'window.__xssHud=' + window.__xssHud);
    // X5 先决：**这套判据自己活着**。同一串字（只摘掉触发那一格，标签形状留着）裸着进
    // innerHTML 必须真的多出一个元素 —— 它红了说明 X1/X3 量的是空气（比如 #killfeed 里
    // 根本没有我们那一行、或者 announce 被别的东西盖着）。
    const probe = document.createElement('div');
    probe.innerHTML = XSS.replace(/onerror="[^"]*"/, '');
    probe.style.display = 'none'; document.body.appendChild(probe);
    ok('X5【先决】同一串字裸着进 innerHTML 真的会多出一个元素（这条红了 = X1/X3 是空断言）',
      !!probe.querySelector('img'), JSON.stringify(probe.innerHTML.slice(0, 80)));
    probe.remove();
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
