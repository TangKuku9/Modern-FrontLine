// 枪械视觉的六条判据。这些都是"一眼能看出来"的东西，靠读代码盯不住：
// 弹壳从哪儿冒出来、开火照不照得亮自己的枪、换弹时副手动不动、AK 弹匣是不是橙的、
// 消焰器消不消焰、照门是缺口还是实心板。
//
// 每条判据都问**被画出来的那个量**（弹壳的世界坐标、灯的强度、手的网格位置、
// 贴片的缩放），不是问实现里有没有某段代码 —— 后者是"规格抄本"，改动一换写法就假绿。
// 反证臂同理：把改动前那条规则原样算一遍，判据必须能分出差别。
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { withServer } from './with-server.mjs';

// GL 参数跟 test/optic.mjs 一致（angle + swiftshader）：要真出图，不能 stub 渲染，
// 而 `--use-gl=swiftshader` 那套在这台机器上会在加载阶段丢 WebGL 上下文。
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
async function launch() {
  for (const [label, opts] of [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }]]) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('没有可用浏览器');
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console.error] ' + m.text()); });
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.resolve(); } });
const srv = await withServer();
await page.goto(srv.base + '/index.html');
await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 180000 });
await page.evaluate(() => { window.game.renderer.setAnimationLoop(null); });

// ---------- 阶段 A：几何与材质（不起局） ----------
const geo = await page.evaluate(async () => {
  const out = [];
  const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
  const THREE = await import('three');
  const { buildGun } = await import('/js/gunmodel.js');
  const mats = await import('/js/materials.js');
  const ray = new THREE.Raycaster();
  const axis = new THREE.Vector3(0, 0, -1);

  // S1 机械瞄具：眼位要看得见准星，照门不许是一堵实心板。
  // 探测线取瞄准线下方 2mm —— 准星柱顶正好压在瞄准线上，擦边射线打不中（那样量具永远绿）。
  // 取探测线上**最远**一处几何当准星：瞄准线只有瞄具几何横穿（枪管/护木都在它下面），
  // 而反证臂补的照门板离眼更近，取最近的话它会冒充准星，"照门挡住准星"就永远测不出来。
  const probeSight = (info) => {
    info.group.updateMatrixWorld(true);
    ray.set(info.sight.clone().add(new THREE.Vector3(0, -0.002, 0)), axis);
    const onAxis = ray.intersectObject(info.group, true).filter(h => h.distance > 1e-4);
    const tip = onAxis[onAxis.length - 1];
    if (!tip || tip.distance < 0.1) return null;
    const blocked = [];
    for (const dy of [-0.008, 0, 0.008]) {
      const o = info.sight.clone().add(new THREE.Vector3(0, dy - 0.002, 0));
      ray.set(o, tip.point.clone().sub(o).normalize());
      const hits = ray.intersectObject(info.group, true).filter(h => h.distance > 1e-4 && h.distance < tip.distance - 0.002);
      blocked.push(hits.length ? hits[0].point.z : null);
    }
    return { tip, blocked };
  };
  for (const id of ['m4', 'ak', 'sks', 'm1911']) {
    const r = probeSight(buildGun(id, {}, 'none'));
    ok(`S1 ${id} 探测线尽头是准星`, !!r, r ? `距眼 ${r.tip.distance.toFixed(3)} m` : '没找到准星');
    if (!r) continue;
    const bad = r.blocked.filter(z => z !== null);
    ok(`S1 ${id} 眼位 ±8mm 都看得见准星`, bad.length === 0, bad.length ? `被 z=${bad.map(z => z.toFixed(3)).join(',')} 挡住` : '三条光路全通');
  }
  {
    const info = buildGun('m4', {}, 'none');
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.016), new THREE.MeshBasicMaterial());
    slab.position.set(0, info.sight.y - 0.003, 0.05);   // 改动前那块实心照门的位置
    info.group.add(slab);
    const r = probeSight(info);
    ok('S1⁻ 反证：照老写法补回实心照门要报红', !!r && r.blocked.some(z => z !== null), r ? `检出 ${r.blocked.filter(z => z !== null).length} 条光路被挡` : '没测到');
  }

  // S7 迷彩叠在底材上：木托与钢机匣在迷彩下仍要分得开。以前两者是**同一个材质对象**
  // （camoMaterial 只按迷彩名缓存、完全忽略 base），装了迷彩的枪就是一块迷彩色块。
  {
    const ak = buildGun('ak', {}, 'woodland');
    const used = new Set();
    ak.group.traverse(o => { if (o.isMesh) used.add(o.material); });
    const met = mats.camoMaterial('woodland', mats.mat('gunMetal'));
    const wd = mats.camoMaterial('woodland', mats.mat('gunWood'));
    ok('S7 迷彩按底材质分：金属件与木件是两份材质', met !== wd && used.has(met) && used.has(wd), `枪上用到 ${used.size} 份材质`);
    ok('S7 各自保留底材的金属度/粗糙度', met.metalness > 0.5 && wd.metalness < 0.2 && wd.roughness === mats.mat('gunWood').roughness,
      `金属件 metalness=${met.metalness} 木件 metalness=${wd.metalness} roughness=${wd.roughness}`);
    ok('S7⁻ 反证：不同底材不许串成同一份材质', mats.camoMaterial('woodland', mats.mat('gunMetal')) !== mats.camoMaterial('woodland', mats.mat('gunPoly')));
  }
  // S10 配件装了要看得出差别：凹槽枪管 / 三种握把胶带 / 两种激光模块。
  // 以前 fluted、grain、stip、mw1 四个配件只改数值不改模型与材质，装了等于没装。
  {
    const meshes = (att) => { let n = 0; buildGun('m4', att, 'none').group.traverse(o => { if (o.isMesh) n++; }); return n; };
    ok('S10 凹槽枪管比标准枪管多几何', meshes({ barrel: 'fluted' }) > meshes({}), `标准=${meshes({})} 凹槽=${meshes({ barrel: 'fluted' })}`);
    const gripMat = (rear) => buildGun('m4', { rear }, 'none').grip.material;
    const rub = gripMat('rubber'), gr = gripMat('grain'), st = gripMat('stip');
    ok('S10 三种握把胶带各是各的材质', rub !== gr && gr !== st && st !== rub,
      `橡胶=${rub.color.getHexString()} 颗粒=${gr.color.getHexString()} 防滑=${st.color.getHexString()}`);
    const laserW = (id) => buildGun('m4', { laser: id }, 'none').laserMod.geometry.parameters.width;
    ok('S10 两种激光模块大小不同', laserW('tac') !== laserW('mw1'), `5mW 宽=${laserW('tac')} 1mW 宽=${laserW('mw1')}`);
  }

  // S4 AK 弹匣是橙色胶木（那段意图写了一半被自己的三元式吃掉），别的枪仍是深灰
  const magMat = (id) => { const m = buildGun(id, {}, 'none').mag; return m && m.children.length ? m.children[0].material : null; };
  ok('S4 AK 弹匣用橙色胶木材质', magMat('ak') === mats.mat('containerOrange'), String(magMat('ak') && magMat('ak').color && magMat('ak').color.getHexString()));
  ok('S4 M4 弹匣仍是深灰金属（不是"全体变橙"）', magMat('m4') === mats.mat('gunMetal'));
  ok('S4 快拔副弹匣跟主弹匣同材质', (() => {
    const m = buildGun('ak', { mag: 'fast' }, 'none').mag;
    return m.children.length > 1 && m.children[0].material === m.children[m.children.length - 1].material && m.children[0].material === mats.mat('containerOrange');
  })());

  // S11 弯弹匣（AK/MP5）是连续弧线不是楼梯：相邻两段的弦向角要等于两段转角的均值
  // （链式生成的数学保证），底板顺末段角度收尾。反证臂把旧规则原样重算一遍 ——
  // 旧写法每段独立多转 0.1 rad、位置按 i² 前探，同一把尺下最大偏差 ~0.29 rad。
  const chordErr = (ms) => {
    let worst = 0;
    for (let i = 0; i + 1 < ms.length; i++) {
      const dy = ms[i].position.y - ms[i + 1].position.y, dz = ms[i].position.z - ms[i + 1].position.z;
      const segA = (ms[i].rotation.x + ms[i + 1].rotation.x) / 2;
      worst = Math.max(worst, Math.abs(Math.atan2(dz, dy) - segA));
    }
    return worst;
  };
  const akMag = buildGun('ak', {}, 'none').mag.children.filter(o => o.isMesh).sort((a, b) => b.position.y - a.position.y);
  ok('S11 AK 弹匣是连续弧线（弦向≈段向）', chordErr(akMag) < 0.06, `最大偏差 ${chordErr(akMag).toFixed(3)} rad`);
  ok('S11 AK 弹匣有底板收尾', akMag.length === 6 && akMag[5].position.y < akMag[4].position.y, `段数=${akMag.length}`);
  ok('S11⁻ 反证：旧楼梯规则在同一把尺下偏差大得多', chordErr([
    ...Array.from({ length: 5 }, (_, i) => ({ position: { y: -i * 0.0392 - 0.02, z: -i * i * 0.004 - i * 0.008 }, rotation: { x: i * 0.1 + 0.1 } })),
  ]) > 0.15, `旧规则 ${chordErr(Array.from({ length: 5 }, (_, i) => ({ position: { y: -i * 0.0392 - 0.02, z: -i * i * 0.004 - i * 0.008 }, rotation: { x: i * 0.1 + 0.1 } }))).toFixed(3)} rad`);

  // S2 锚点本身：每把枪都得有一个挂在枪上的抛壳口
  for (const id of ['m4', 'ak', 'm1911', 'revolver', 'rpg']) {
    const info = buildGun(id, {}, 'none');
    ok(`S2 ${id} 抛壳口锚点挂在枪上`, info.eject && info.eject.parent === info.group, info.eject ? `pos=${info.eject.position.toArray().map(v => v.toFixed(3)).join(',')}` : 'null');
  }
  return out;
});

// ---------- 阶段 B：跑局（抛壳位置 / 火光灯 / 换弹副手 / 消焰器） ----------
const play = await page.evaluate(async () => {
  const out = [];
  const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
  const THREE = await import('three');
  const { computeStats } = await import('/js/data.js');
  const g = window.game;
  g.renderer.setAnimationLoop(null);
  const realRender = g.composer.render.bind(g.composer);
  g.composer.render = () => {};
  const realClock = g.clock;
  g.clock = { getDelta: () => 1 / 60 };
  const frames = (n, inp) => { for (let i = 0; i < n; i++) { if (inp) inp(); g.frame(); } };
  await g.startGame('mp', { mode: 'tdm', map: 'yard', diff: 1, allies: 2, enemies: 2, scoreLimit: 50, timeLimit: 10 });
  // 对面是活 bots：玩家一旦被打死 vm.update 就停跑，syncLoadout 挂起，后面所有
  // replaceSlot 都建不出新枪模（S9 的 info.cylinder 会是 null）。判据量的是枪模，
  // 不是存活，按探针惯例上无敌把 bot 火力从变量里剔掉。
  g.player.maxHp = 1e9; g.player.hp = 1e9;
  const ws = g.player.ws, vm = ws.vm;
  frames(40);          // setLoadout 会先进 switch（0.5s）：射击与换弹都只在 idle 开门
  ok('起局后状态机回到 idle', ws.state === 'idle', 'state=' + ws.state);
  let cur = vm.groups[ws.cur];   // S6 里换过枪，枪模会重建 —— 每次换完要重新取

  // S2 弹壳从抛壳窗出来。老规则是"枪口后方 0.4m"，枪越长偏得越多。
  const shells = [];
  const realShell = g.effects.shell;
  g.effects.shell = (pos, dir) => { shells.push(pos.clone()); };
  const v = () => new THREE.Vector3();
  frames(3, () => { g.input.buttons = 1; });
  g.input.buttons = 0; frames(3);
  g.effects.shell = realShell;
  const ejectWorld = cur.info.eject.getWorldPosition(v());
  ok('S2 开火有弹壳', shells.length > 0, 'n=' + shells.length);
  const worst = shells.reduce((a, p) => Math.max(a, p.distanceTo(ejectWorld)), 0);
  ok('S2 弹壳落在抛壳窗旁边', shells.length > 0 && worst < 0.08, `最远 ${worst.toFixed(3)} m`);
  const mw = vm.muzzleWorld(v());
  const fwd = g.camera.getWorldDirection(v());
  const right = v().set(1, 0, 0).applyQuaternion(g.camera.quaternion);
  const oldRule = mw.clone().addScaledVector(fwd, -0.4).addScaledVector(right, 0.05);
  ok('S2⁻ 反证：老规则（枪口后方 0.4m）离抛壳窗足够远，两把尺子分得清', oldRule.distanceTo(ejectWorld) > 0.25,
    `老规则离抛壳窗 ${oldRule.distanceTo(ejectWorld).toFixed(3)} m`);

  // S6 弹壳按口径分（读的是弹壳网格自己的缩放与材质，不是配置表）：
  // 手枪 < 步枪 < 狙击，霰弹枪是红色塑料弹壳，左轮根本不抛（弹壳留在弹巢里）。
  const mats = await import('/js/materials.js');
  const fired = [];
  const capShell = (pos, dir, kind) => {
    realShell.call(g.effects, pos, dir, kind);   // 原型方法，自己调要补回 this
    const m = g.effects.shells[g.effects.shells.length - 1];
    fired.push({ kind, h: +m.scale.y.toFixed(3), red: m.material === mats.mat('shellRed') });
  };
  const fireWith = (id) => {
    ws.replaceSlot(0, { id, att: {}, camo: 'none' }, 30, 200);
    frames(60);
    // 换枪不重置 cool/cycleT：上一把是栓动的话枪机还没复位（L115 cycleT=1.36s），
    // 接着打的那几帧一发都出不去 —— 那样量到的是"没开枪"，不是"没抛壳"。
    ws.cool = 0; ws.cycleT = 0;
    const mag0 = ws.w.mag;
    fired.length = 0;
    g.effects.shell = capShell;
    frames(3, () => { g.input.buttons = 1; });
    g.input.buttons = 0; frames(3);
    g.effects.shell = realShell;
    // 一定要带上"真开了几枪"：判据要能分清"这枪不抛壳"和"压根没开枪"
    return { shells: fired.slice(), shots: mag0 - ws.w.mag };
  };
  const kPistol = fireWith('m1911'), kRifle = fireWith('m4'), kSniper = fireWith('l115'), kShot = fireWith('m870'), kRev = fireWith('revolver');
  const hOf = (a) => (a.shells[0] ? a.shells[0].h : 0);
  const kinds = (a) => JSON.stringify(a.shells) + ` 开了 ${a.shots} 枪`;
  ok('S6 手枪抛 9mm 壳', kPistol.shells.some(x => x.kind === 'pistol') && kPistol.shots > 0, kinds(kPistol));
  ok('S6 步枪抛 rifle 壳', kRifle.shells.some(x => x.kind === 'rifle') && kRifle.shots > 0, kinds(kRifle));
  ok('S6 狙击抛 magnum 壳', kSniper.shells.some(x => x.kind === 'magnum') && kSniper.shots > 0, kinds(kSniper));
  ok('S6 壳的大小随口径递增', hOf(kPistol) < hOf(kRifle) && hOf(kRifle) < hOf(kSniper),
    `手枪=${hOf(kPistol)} 步枪=${hOf(kRifle)} 狙击=${hOf(kSniper)}`);
  ok('S6 霰弹枪抛壳且是红色塑料壳', kShot.shells.some(x => x.kind === 'shotgun' && x.red) && kShot.shots > 0, kinds(kShot));
  ok('S6 左轮开枪但不抛壳（弹壳留在弹巢里）', kRev.shells.length === 0 && kRev.shots > 0, kinds(kRev));
  ws.replaceSlot(0, { id: 'm4', att: {}, camo: 'none' }, 30, 150);
  frames(60);
  cur = vm.groups[ws.cur];

  // S3 开火要照得亮自己的枪模（世界那盏点光源在 game.scene，照不到 vmScene）
  frames(4);
  ok('S3 平时火光灯是灭的', vm.flashLamp.intensity === 0, 'intensity=' + vm.flashLamp.intensity);
  frames(2, () => { g.input.buttons = 1; });
  const lit = vm.flashLamp.intensity;
  ok('S3 开火时 vmScene 里有灯在照枪模', lit > 0 && vm.flashLamp.parent === g.vmScene, `intensity=${lit.toFixed(2)}`);
  ok('S3 灯位贴着枪口', vm.flashLamp.position.distanceTo(vm.muzzleWorld(v())) < 0.02, `${vm.flashLamp.position.distanceTo(vm.muzzleWorld(v())).toFixed(4)} m`);
  g.input.buttons = 0; frames(3);

  // S5 消焰器名实相符：贴片比裸枪小、闪光比裸枪短。2026-09-30 强化后钉得更紧：
  // 旧档（0.5×）装了照样一大团火，现在缩到三成、透明度也砍近半。
  const mk = (att) => vm.build({ id: 'm4', att, camo: 'none', stats: computeStats('m4', att) });
  const bare = mk({}), flashHider = mk({ muzzle: 'flash' }), sup = mk({ muzzle: 'suppressor' });
  ok('S5 消焰器的火光贴片比裸枪小', flashHider.flash.scale.x < bare.flash.scale.x * 0.5,
    `裸=${bare.flash.scale.x.toFixed(3)} 消焰=${flashHider.flash.scale.x.toFixed(3)}`);
  ok('S5 消焰器的火光比裸枪淡', flashHider.flash.material.opacity < bare.flash.material.opacity * 0.6,
    `裸=${bare.flash.material.opacity} 消焰=${flashHider.flash.material.opacity}`);
  ok('S5 消焰器的闪光比裸枪短', flashHider.flashDur < bare.flashDur * 0.8, `裸=${bare.flashDur} 消焰=${flashHider.flashDur}`);
  ok('S5⁻ 反证：消音器比消焰器还小', sup.flash.scale.x <= flashHider.flash.scale.x, `消焰=${flashHider.flash.scale.x.toFixed(3)} 消音=${sup.flash.scale.x.toFixed(3)}`);

  // S5b 开镜收火光：贴片挂在枪口上，开镜时枪口正贴准星下方，不收就糊住瞄点。
  // 先开镜到位再开火 —— 边开镜边开火的话 adsT 还没起来，量出来的是"没收到"。
  ws.cool = 0; ws.cycleT = 0;
  const builtScale = cur.flash.scale.x;
  frames(70, () => { g.input.buttons = 4; });
  const mag0 = ws.w.mag;
  frames(2, () => { g.input.buttons = 5; });   // 1|4：边瞄边打
  g.input.buttons = 0;
  const adsScale = cur.flash.scale.x;
  ok('S5b 开镜时火光贴片收小（不糊准星）', mag0 - ws.w.mag > 0 && adsScale < builtScale * 0.7 && adsScale > 0,
    `腰射=${builtScale.toFixed(3)} 开镜=${adsScale.toFixed(3)} 开了${mag0 - ws.w.mag}枪`);
  frames(5);

  // S8 火光按枪型分级 + 枪口烟。烟只数**枪口 0.6m 内**的粒子，而且抬头打天 ——
  // 否则弹着点的尘土也算进"枪口烟"，那把尺子会把没烟的枪也量成有烟。
  const flashOf = (id) => vm.build({ id, att: {}, camo: 'none', stats: computeStats(id, {}) }).flash.scale.x;
  ok('S8 火光随枪型递增：手枪 < 步枪 < 霰弹枪', flashOf('m1911') < flashOf('m4') && flashOf('m4') < flashOf('m870'),
    `手枪=${flashOf('m1911').toFixed(3)} 步枪=${flashOf('m4').toFixed(3)} 霰弹=${flashOf('m870').toFixed(3)}`);
  const muzzleSmoke = (att) => {
    ws.replaceSlot(0, { id: 'm4', att, camo: 'none' }, 30, 200);
    frames(60); ws.cool = 0; ws.cycleT = 0;
    g.player.pitch = 1.3;                   // 抬头打天（pitch>0 才是抬头）：不许有弹着点尘土混进来
    frames(2);
    g.effects.smoke.clear();                // 清池：烟寿命 0.8s，前面几轮的射击还挂在那儿
    frames(1, () => { g.input.buttons = 1; });
    g.input.buttons = 0; frames(1);
    const mw = vm.muzzleWorld(v());
    const n = g.effects.smoke.list.filter(p => Math.hypot(p.x - mw.x, p.y - mw.y, p.z - mw.z) < 0.6).length;
    g.player.pitch = 0;
    return n;
  };
  const smokeBare = muzzleSmoke({}), smokeSup = muzzleSmoke({ muzzle: 'suppressor' });
  ok('S8 开火出枪口烟', smokeBare > 0, `枪口 0.6m 内 ${smokeBare} 粒`);
  ok('S8⁻ 反证：消音器不出烟', smokeSup === 0, `枪口 0.6m 内 ${smokeSup} 粒`);
  ws.replaceSlot(0, { id: 'm4', att: {}, camo: 'none' }, 30, 150);
  frames(60);
  cur = vm.groups[ws.cur];

  // S9 分件动作：套筒/拉机柄/泵动护木/弹巢要**自己**动。以前它们是死几何，
  // 栓动=整枪滚 0.2 rad、泵动=整枪推 4cm，动的是整把枪。判据读的是分件自己的位移。
  const partZ = (part) => {
    const p = vm.groups[ws.cur].info[part];
    return p && p.userData.base ? +(p.position.z - p.userData.base.z).toFixed(4) : null;
  };
  const withGun = (id, fn) => {
    ws.replaceSlot(0, { id, att: {}, camo: 'none' }, 30, 200);
    frames(60); ws.cool = 0; ws.cycleT = 0;
    const r = fn();
    ws.replaceSlot(0, { id: 'm4', att: {}, camo: 'none' }, 30, 150);
    frames(60);
    return r;
  };
  const shot = () => { frames(1, () => { g.input.buttons = 1; }); g.input.buttons = 0; };
  const slideBack = withGun('m1911', () => { shot(); frames(1); return partZ('slide'); });
  ok('S9 手枪击发时套筒后坐', slideBack !== null && slideBack > 0.01, `套筒后移 ${slideBack} m`);
  const slideEmpty = withGun('m1911', () => { ws.w.mag = 1; shot(); frames(20); return partZ('slide'); });
  ok('S9 打空后套筒停在后方（空仓挂机）', slideEmpty !== null && slideEmpty > 0.02, `套筒偏移 ${slideEmpty} m`);
  const boltBack = withGun('l115', () => { shot(); frames(10); return partZ('bolt'); });
  ok('S9 栓动上膛时拉机柄后拉', boltBack !== null && boltBack > 0.01, `拉机柄后移 ${boltBack} m`);
  const pumpBack = withGun('m870', () => { shot(); frames(10); return partZ('pump'); });
  ok('S9 泵动上膛时护木后推', pumpBack !== null && pumpBack > 0.01, `护木后移 ${pumpBack} m`);
  const cyl = withGun('revolver', () => {
    const b = vm.groups[ws.cur].info.cylinder.rotation.z;
    shot(); frames(2);
    return +(vm.groups[ws.cur].info.cylinder.rotation.z - b).toFixed(3);
  });
  ok('S9 左轮弹巢每发转一格', cyl > 0.5, `转过 ${cyl} rad`);

  // H1 换弹时副手要动（原来手臂是枪组刚性子件，弹匣在手里下坠又回来，手纹丝不动）
  ws.w.mag = Math.min(ws.w.mag, 3);
  ws.startReload();
  frames(1);
  cur = vm.groups[ws.cur];   // S9 里换过枪，旧的 cur 已经被 syncLoadout 摘下 holder
  const arm = cur.arms;
  const mag = cur.info.mag;
  let away = 0, grab = 0, n = 0;
  for (let i = 0; i < 300 && ws.state === 'reload'; i++) {
    frames(1); n++;
    const hand = arm.handMesh.position;
    if (hand.distanceTo(arm.leftHome) > 0.06) away++;
    if (mag && hand.distanceTo(mag.position) < 0.09) grab++;
  }
  frames(30);
  ok('H1 换弹时副手离开护木', away > 15, `离位 ${away}/${n} 帧`);
  ok('H1 副手抓到过弹匣', grab > 5, `贴住弹匣 ${grab}/${n} 帧`);
  ok('H1 换弹结束副手回到护木', arm.handMesh.position.distanceTo(arm.leftHome) < 1e-3,
    `Δ=${arm.handMesh.position.distanceTo(arm.leftHome).toFixed(4)}`);
  ok('H1 换弹结算弹药', ws.state === 'idle' && ws.w.mag === ws.w.stats.mag, `state=${ws.state} mag=${ws.w.mag}`);

  g.composer.render = realRender;
  g.clock = realClock; realClock.getDelta();
  return { out, shots: { bare: bare.flash.scale.x, hider: flashHider.flash.scale.x } };
});

// ---------- 阶段 C：截图（多角度给眼睛验收） ----------
// 每块 evaluate 之间页面会收到 pointerlockchange → game.pause(true)（js/main.js:528），
// 于是 g.frame() 整个不推进 —— 截图会拍到"冻结的最后一帧"，症状像功能没生效。
// 所以每块第一件事都是把 paused 放倒。
// 截图期间把玩家设成打不死：bot 会把人打死，而死了之后 ws.update/vm.update 都不再跑
// （js/main.js:770 只给活人跑）—— 症状是"火光贴片不亮、枪模不见了、换弹停在半路"，
// 看着像功能坏了，其实只是这一帧的人已经死了。判据问的不是生死，别让它混进来。
const WAKE = `function wake(){
  const g = window.game; g.paused = false;
  const el = document.getElementById('clickToPlay'); if (el) el.classList.add('hidden');
  if (g.player) { g.player.maxHp = 1e9; g.player.hp = 1e9; }
}`;
// 驱动帧的时候把 composer.render 打桩：frame() 每帧都会真渲染，而 swiftshader 下
// 1280×720 + 泛光一帧就要好几秒 —— 60 帧堆在合成器队列里，紧接着的 page.screenshot 会超时。
// 截图前才真渲染一帧。
// 驱动帧的时候把 composer.render 打桩：frame() 每帧都会真渲染，而 swiftshader 下
// 1280×720 + 泛光一帧就要好几秒。**必须 try/finally 还原**：驱动块里有 `return {...}`，
// 那会直接跳出箭头函数 —— 第一版没兜住，于是 composer.render 从此一直是空操作，
// 症状是"判据全绿、截图永远是加载那一帧、readPixels 全零、动画循环跑出 230fps"。
const drive = (js) => page.evaluate(`(() => {
  ${WAKE} wake();
  const _g = window.game;
  const real = _g.composer.render.bind(_g.composer);
  _g.composer.render = () => {};
  _g.clock = { getDelta: () => 1 / 60 };   // 固定步长：真时钟连打 60 帧几乎不走时间
  try { ${js} } finally { _g.composer.render = real; }
})()`);
// 截图走"游戏自己的动画循环把帧呈现出来 → page.screenshot"（跟 test/viewmodel.mjs 一样）。
// 踩过的两个坑：①手动调 composer.render 之后直接截图 —— 页面不在前台时合成器不呈现新帧，
//   抓到的是**上一次**的旧画面；②为了冻住动画把 clock 换成 dt=0 —— 那样帧同样不被呈现。
// 所以让真时钟跑、循环照常渲染，要拍哪个瞬间就把那个状态**每帧写回去**。
const shoot = async (name, pin = '', opts = {}) => {
  await page.evaluate(`(() => {
    ${WAKE} wake();
    const g = window.game, ws = g.player && g.player.ws, vm = ws && ws.vm;
    g.renderer.setAnimationLoop(() => { g.frame(); ${pin} });
  })()`);
  // 先点一下页面再截（test/optic.mjs 的做法）：不点的话合成器不给新帧，截到的是**上一次**
  // 呈现的旧画面 —— 判据全绿而截图对不上，这种红只能靠眼睛发现。
  try { await page.mouse.click(640, 400); } catch { /* 指针锁恢复不了不影响截图 */ }
  await page.waitForTimeout(1500);
  const path = `test/gunv-${name}.png`;
  await page.evaluate(`(() => {
    document.getElementById('clickToPlay').classList.add('hidden');
    ${opts.noHud ? "document.getElementById('hud').style.display = 'none';" : ''}
    window.game.renderer.setAnimationLoop(null);
    window.game.input.buttons = 0;
  })()`);
  await page.screenshot({ path, timeout: 120000 });
  const probe = await page.evaluate(`(() => {
    const g = window.game, gl = g.renderer.getContext();
    g.composer.render();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
    return {
      renderMean: +(s / (px.length / 4) / 3).toFixed(1),   // 0 = 渲染链路又空转了（截图会是旧帧）
      ctxLost: gl.isContextLost(), state: g.state, vmPass: g.vmPass.enabled,
      hud: document.getElementById('hud').style.display || '(unset)',
    };
  })()`);
  if (opts.noHud) await page.evaluate(() => { document.getElementById('hud').style.display = ''; });
  console.log(`  [${name}] -> ${path}  ${JSON.stringify(probe)}`);
};
const FRAMES = `const frames = (n, inp) => { for (let i = 0; i < n; i++) { if (inp) inp(); window.game.frame(); } };`;
const shotInfo = [];
const r1 = await drive(`${FRAMES}
  const g = window.game, ws = g.player.ws;
  const t0 = g.tick;
  ws.replaceSlot(0, { id: 'm4', att: {}, camo: 'none' }, 30, 150);
  frames(60);                 // 过掉切枪，站定在持枪位
  return { ticks: g.tick - t0, kids: ws.vm.holder.children.length, state: ws.state, y: +ws.vm.holder.position.y.toFixed(3) };
`);
shotInfo.push(['C1 持枪位截图前：模拟在推进、枪模挂上了 holder', r1.ticks > 30 && r1.kids > 0 && r1.state === 'idle', JSON.stringify(r1)]);
await shoot('hip');
const r2 = await drive(`${FRAMES}
  const g = window.game, ws = g.player.ws;
  frames(70, () => { g.input.buttons = 4; });   // 机械瞄具 ADS
  g.input.buttons = 0;
  return { ads: +ws.adsT.toFixed(2), visible: ws.vm.holder.visible };
`);
shotInfo.push(['C2 ADS 截图前：真的拉到满镜', r2.ads > 0.99 && r2.visible, JSON.stringify(r2)]);
await shoot('iron-ads', `window.game.input.buttons = 4;`);
const r3 = await drive(`${FRAMES}
  const g = window.game, ws = g.player.ws, vm = ws.vm;
  frames(20);
  ws.w.mag = 3; ws.startReload();
  frames(Math.round(ws.stateDur * 60 * 0.30));            // 弹匣已拔出、副手还抱着它
  const arm = vm.groups[ws.cur].arms, mag = vm.groups[ws.cur].info.mag;
  return { state: ws.state, k: +(ws.stateT / ws.stateDur).toFixed(2), handMag: +arm.handMesh.position.distanceTo(mag.position).toFixed(3) };
`);
shotInfo.push(['C3 换弹截图前：卡在换弹中段、副手贴着弹匣', r3.state === 'reload' && r3.handMag < 0.12, JSON.stringify(r3)]);
await shoot('reload', `
  const ws2 = window.game.player.ws;
  // 钉死在 k=0.31：弹匣已拔出、副手正抱着它。写死 state/stateDur/stateT 三件套，
  // 比"等它自己走到那一拍"稳（模拟每帧推 1/60，会把 k 越过那个窗口）。
  ws2.state = 'reload'; ws2.stateDur = 2.1; ws2.stateT = 0.65;
`);
const r4 = await drive(`${FRAMES}
  const g = window.game, ws = g.player.ws, vm = ws.vm;
  for (let i = 0; i < 200 && ws.state !== 'idle'; i++) frames(5);
  // 确定性地打一发：C3 把枪留在换弹里，而 cool/cycleT 是跨枪共用的（上一把栓动的话
  // 枪机还没复位）—— 不清这几件，"没打上枪"会被量成"火光不亮"。
  ws.state = 'idle'; ws.stateT = 0; ws.cool = 0; ws.cycleT = 0;
  ws.w.mag = Math.max(ws.w.mag, 1);
  frames(6);
  frames(1, () => { g.input.buttons = 1; });    // 打一发，火光还在
  g.input.buttons = 0;
  return {
    flash: +vm.flashT.toFixed(4), lamp: +vm.flashLamp.intensity.toFixed(2), visible: vm.groups[ws.cur].flash.visible,
    alive: g.player.alive, state: ws.state, mag: ws.w.mag,
  };
`);
shotInfo.push(['C4 开火截图前：火光贴片与火光灯都还亮着', r4.flash > 0 && r4.lamp > 0 && r4.visible && r4.alive, JSON.stringify(r4)]);
await shoot('flash', `window.game.input.buttons = 1;`);   // 压住扳机：火光每帧都在
// C5 给"截图"这把尺子自己上保险：同一套机制连拍两张（开着/关掉视图模型），两张必须不一样。
// 以前出过"判据全绿、截图里却没有枪"（截图抓的是上一次呈现的旧帧），那种红只能靠眼睛发现。
// 注意①vmPass.enabled 每帧都会被 frame() 写回来（js/main.js:771），要在**每帧之后**关掉；
// ②两张都关掉 HUD —— 否则计时器/击杀播报的差异会冒充"画面变了"，这把尺子就永远绿。
await shoot('vm', `window.game.input.buttons = 4;`, { noHud: true });
await shoot('novm', `window.game.input.buttons = 4; window.game.vmPass.enabled = false;`, { noHud: true });
const same = (() => {
  const a = readFileSync(`test/gunv-vm.png`), b = readFileSync(`test/gunv-novm.png`);
  return a.length === b.length && Buffer.compare(a, b) === 0;
})();
shotInfo.push(['C5 关掉视图模型后截图真的变了（截图链路能分辨枪）', !same, same ? '两张图逐字节相同' : '两张图不同']);
await browser.close();

let green = errs.length === 0;
for (const [flag, label] of geo) { green &&= flag; console.log(`  ${flag ? '✅' : '❌'} ${label}`); }
for (const [flag, label] of play.out) { green &&= flag; console.log(`  ${flag ? '✅' : '❌'} ${label}`); }
for (const [label, flag, extra] of shotInfo) { green &&= flag; console.log(`  ${flag ? '✅' : '❌'} ${label}  ${extra}`); }
if (errs.length) console.log('  页面异常:\n    ' + errs.slice(0, 8).join('\n    '));
console.log(`\n  结论：${green ? '绿' : '红'}`);
srv.kill(); process.exit(green ? 0 : 1);
