// P0-2 拆分接缝的功能回归：枪模要跟着瞄准走、换弹要动弹匣、切枪要换模型、
// 高倍镜要遮罩、拾取要重建。这些正是"把视图模型拆出去"最容易弄断的东西，
// 而帧率测试（test/fps.mjs）和确定性闸门（server/gate.mjs）都盖不住它们。
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
async function launch() {
  for (const [label, opts] of [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }]]) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('没有可用浏览器');
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console.error] ' + m.text()); });
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
const srv = await withServer();
await page.goto(srv.base + '/index.html');
await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 180000 });

const res = await page.evaluate(async () => {
  const g = window.game;
  const out = [];
  const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
  g.renderer.setAnimationLoop(null);
  const realRender = g.composer.render.bind(g.composer);
  g.composer.render = () => {};
  const realClock = g.clock;
  g.clock = { getDelta: () => 1 / 60 };
  const frames = (n, inp) => {
    for (let i = 0; i < n; i++) {
      if (inp) inp();
      g.frame();
    }
  };
  await g.startGame('mp', { mode: 'tdm', map: 'yard', diff: 1, allies: 4, enemies: 4, scoreLimit: 50, timeLimit: 10 });
  const ws = g.player.ws, vm = ws.vm;

  ok('客户端构造了 Viewmodel', !!vm);
  // 枪模是"下一渲染帧"由 syncLoadout 建的；frame() 里 updateRender 在 composer.render
  // 之前，所以玩家永远不会看到空手 —— 这里要先跑一帧再查
  frames(1);
  ok('首帧渲染前枪模已挂上 holder', vm.holder.children.length > 0, 'children=' + vm.holder.children.length);
  ok('权威对象上没有渲染字段', ws.vmKick === undefined && ws.flashT === undefined);
  ok('弹匣数据在权威侧', ws.w.mag === 30 && typeof ws.w.reserve === 'number');

  // 1) 瞄准：枪要贴到瞄具锚点（-info.sight），hip 与 ADS 的位置必须不同
  const hipPos = vm.holder.position.clone();
  frames(40, () => { g.input.buttons = 4; });
  const adsPos = vm.holder.position.clone();
  const sight = vm.groups[ws.cur].info.sight;
  ok('ADS 让枪位移改变', hipPos.distanceTo(adsPos) > 0.05, '|Δ|=' + hipPos.distanceTo(adsPos).toFixed(3));
  ok('ADS 贴到瞄具锚点', Math.abs(adsPos.z - (-sight.z)) < 0.08 && Math.abs(adsPos.x - (-sight.x)) < 0.08,
    `z=${adsPos.z.toFixed(3)} 期望≈${(-sight.z).toFixed(3)}`);
  ok('scopeState 在非高倍镜下为 null', g.scopeState === null);
  g.input.buttons = 0; frames(20);

  // 2) 开火：事件经 sink 到达，枪口火光可见，顶枪量作用在枪模而不是权威对象
  let got = 0;
  const origSink = ws.sink;
  ws.sink = (e) => { got++; origSink(e); };
  const mag0 = ws.w.mag;
  frames(6, () => { g.input.buttons = 1; });
  ws.sink = origSink;
  g.input.buttons = 0;
  frames(1);
  ok('开火扣弹', ws.w.mag < mag0, mag0 + '→' + ws.w.mag);
  ok('视图模型收到开火事件', got > 0, 'events=' + got);
  ok('枪口火光可见', vm.flashT > 0 || vm.groups[ws.cur].flash.visible, 'flashT=' + vm.flashT.toFixed(4));
  ok('顶枪只动枪模', vm.vmKick > 0 && ws.vmKick === undefined, 'vmKick=' + vm.vmKick.toFixed(4));

  // 3) 换弹：弹匣网格要掉下来再装回去
  ws.startReload();
  let magDipped = false, magBack = false;
  const m = vm.groups[ws.cur].info.mag;
  for (let i = 0; i < 240 && ws.state === 'reload'; i++) {
    frames(1);
    const base = m && m.userData.base;          // base 是动画第一帧才记下的，不能提前捕获
    if (base && m.position.y < base.y - 0.05) magDipped = true;
  }
  frames(6);
  if (m && m.userData.base) magBack = Math.abs(m.position.y - m.userData.base.y) < 1e-6;
  ok('换弹完成并结算弹药', ws.state === 'idle' && ws.w.mag === ws.w.stats.mag, `state=${ws.state} mag=${ws.w.mag}`);
  ok('弹匣网格在换弹中掉过', magDipped);
  ok('弹匣网格换弹后归位', magBack);

  // 4) 切枪：模型要换，状态机要进 switch
  ws.switchTo(1);
  frames(2);
  ok('切枪后显示第二把', vm.holder.children.length === 1 && vm.holder.children[0] === vm.groups[1].group);
  frames(60);
  ok('切枪动画走完回到 idle', ws.state === 'idle', 'state=' + ws.state);

  // 5) 高倍镜：遮罩要藏模型，且 scopeState 由模拟侧给出
  ws.replaceSlot(0, { id: 'l115', att: {}, camo: 'none' }, 5, 30);
  frames(2);
  ok('拾取/替换后视图模型重建', vm.groups.length === ws.slots.length && vm.holder.children.length === 1);
  frames(90, () => { g.input.buttons = 4; });
  g.input.buttons = 0;
  ok('狙击镜 adsT 拉满', ws.adsT > 0.9, 'adsT=' + ws.adsT.toFixed(3));
  ok('scopeState = sniper（模拟侧产出）', g.scopeState === 'sniper', String(g.scopeState));
  ok('高倍镜下枪模隐藏', vm.holder.visible === false);
  frames(40);
  ok('收镜后 scopeState 归 null 且枪模重现', g.scopeState === null && vm.holder.visible === true);

  g.composer.render = realRender;
  g.clock = realClock; realClock.getDelta();
  g.renderer.setAnimationLoop(() => g.frame());
  return out;
});

await page.waitForTimeout(1200);
await page.screenshot({ path: 'test/viewmodel.png' });
await browser.close();

let green = errs.length === 0;
for (const [okFlag, label] of res) { green &&= okFlag; console.log(`  ${okFlag ? '✅' : '❌'} ${label}`); }
if (errs.length) console.log('  页面异常:\n    ' + errs.slice(0, 8).join('\n    '));
console.log(`\n  结论：${green ? '绿' : '红'}`);
srv.kill(); process.exit(green ? 0 : 1);
