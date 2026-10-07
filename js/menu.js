// 菜单系统：主菜单、战役简报、多人大厅、配装、枪匠、设置、暂停、结算
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WEAPONS, PRIMARY_ORDER, SECONDARY_ORDER, SLOT_NAMES, ATTACHMENTS, CAMOS, computeStats, statBars, PERKS, LETHALS, TACTICALS, KILLSTREAKS, MP_MAPS, MP_MODES, MP_MINUTES, MP_SCORES, DOM_SCORES, scoreOptions, mapAllowed, mapsForMode, BOT_SKILLS, BOT_SKILL_NAMES, attachmentAllowed, findAttachment } from './data.js';
// DEFAULT_SCORE_LIMIT：切模式时旧的目标偏好不在新模式的档位表里，就落回那个模式的默认。
// 默认只此一份（规则内核的家），界面不要自己再写一个 200/50。
import { DEFAULT_SCORE_LIMIT } from './match-rules.js';
import { buildGun } from './gunmodel.js';
import { createSoldierModel, animateSoldier } from './soldier.js';
import { mat, camoSwatch } from './materials.js';
import { damp, fmtTime } from './util.js';
import { escHtml } from './escape.js';
// 经验 → 等级这一条公式现在住在 js/progress.mjs（与"账号那一半 / 本地那一半"同一处：
// 等级按两半之和算，档案卡那一行文案也在那儿）。在存档卡、结算面板、房间座位栏里
// 各画一份的话，换算法就要改三处，而漏掉那处只会显示出一个偏低的等级，没人会报错。
import { levelOf, totalXp, xpText, applyAccountXp } from './progress.mjs';

const DIFF_NAMES = ['新兵', '正规军', '老兵'];
const MAX_ATT = 5;
// 目标档位两张表（tdm/ffa 的 MP_SCORES 与 dom 独有的 DOM_SCORES）的**并集**。渲染一次的
// 选择器用它把全部候选先画出来，再按 js/data.js:scoreOptions 藏掉当前模式不收的值 ——
// 监听器直接挂在 div 上，重建 innerHTML 会把它们一起丢掉，所以"画全集 + 藏"而不是"重画"。
const SCORES_ALL = [...MP_SCORES, ...DOM_SCORES.filter(v => !MP_SCORES.includes(v))];

// 联机能选的模式 = js/data.js 那张表上 net 为真的那几个（服务端判得出它们的胜负）。
// 与 server/lobby.mjs:MODE_IDS 同源，两侧各筛各的话症状就是"界面上给了一格，点下去被拒"
// —— 而房间列表上那一格模式正是别人挑房的依据。
const ONLINE_MODES = MP_MODES.filter(m => m.net);

// 地图缩略插画（内联SVG）
const MAP_ART = {
  dune: `<svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="gd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2c98a"/><stop offset="1" stop-color="#b3773d"/></linearGradient></defs><rect width="300" height="150" fill="url(#gd)"/><circle cx="230" cy="40" r="18" fill="#fff4d6" opacity=".9"/><path d="M0 110 L20 110 20 80 60 80 60 95 75 95 75 70 95 70 95 60 105 60 105 70 120 70 120 100 150 100 150 75 190 75 190 90 210 90 210 65 235 65 235 90 260 90 260 78 300 78 300 150 0 150Z" fill="#6b4520"/><path d="M85 60 Q100 40 115 60Z" fill="#6b4520"/><rect x="98" y="30" width="4" height="30" fill="#6b4520"/></svg>`,
  frost: `<svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="gf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe7ee"/><stop offset="1" stop-color="#8395a6"/></linearGradient></defs><rect width="300" height="150" fill="url(#gf)"/><path d="M0 70 L50 40 90 65 140 30 200 70 250 45 300 65 300 150 0 150Z" fill="#b8c5d2"/><rect x="30" y="80" width="40" height="45" fill="#46566a"/><ellipse cx="50" cy="80" rx="20" ry="5" fill="#56677b"/><rect x="90" y="70" width="50" height="55" fill="#3b4a5c"/><ellipse cx="115" cy="70" rx="25" ry="6" fill="#4d5d70"/><rect x="170" y="45" width="6" height="80" fill="#3b4a5c"/><rect x="190" y="90" width="100" height="35" fill="#34414f"/><rect x="0" y="125" width="300" height="25" fill="#eef3f7"/></svg>`,
  neon: `<svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid slice"><rect width="300" height="150" fill="#0d0f2a"/><rect x="10" y="30" width="50" height="120" fill="#16183a"/><rect x="70" y="10" width="45" height="140" fill="#1b1d45"/><rect x="125" y="50" width="60" height="100" fill="#15173a"/><rect x="195" y="20" width="40" height="130" fill="#1d2050"/><rect x="245" y="45" width="55" height="105" fill="#14163a"/><rect x="20" y="60" width="30" height="6" fill="#ff3fa4"/><rect x="80" y="40" width="25" height="5" fill="#3ff4ff"/><rect x="135" y="70" width="40" height="6" fill="#ffdd3f"/><rect x="205" y="55" width="20" height="30" fill="none" stroke="#ff3fa4" stroke-width="2"/><rect x="255" y="80" width="35" height="5" fill="#3ff4ff"/><rect x="0" y="130" width="300" height="20" fill="#20234f" opacity=".8"/><g stroke="#8fa0ff" stroke-width=".6" opacity=".35"><line x1="30" y1="0" x2="25" y2="20"/><line x1="120" y1="10" x2="115" y2="30"/><line x1="220" y1="0" x2="215" y2="20"/><line x1="270" y1="30" x2="265" y2="50"/><line x1="160" y1="20" x2="155" y2="40"/></g></svg>`,
  yard: `<svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="gy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb05a"/><stop offset=".6" stop-color="#c8554a"/><stop offset="1" stop-color="#4a2437"/></linearGradient></defs><rect width="300" height="150" fill="url(#gy)"/><circle cx="80" cy="85" r="26" fill="#ffe0a0" opacity=".8"/><path d="M180 20 L185 20 185 125 180 125Z M150 22 L280 22 280 27 150 27Z M240 27 L242 60 238 60Z" fill="#2c1824"/><rect x="0" y="95" width="70" height="30" fill="#6a2a24"/><rect x="75" y="100" width="70" height="25" fill="#24425e"/><rect x="20" y="70" width="70" height="25" fill="#2d4a2d"/><rect x="150" y="90" width="80" height="35" fill="#8a4a1e"/><rect x="235" y="98" width="65" height="27" fill="#3a3e44"/><rect x="0" y="125" width="300" height="25" fill="#2a1a22"/></svg>`,
  // 双丘战区：正午的丘陵战场。别的卡片一眼认出的是"沙漠城镇 / 炼油厂 / 霓虹街区 /
  // 集装箱堆场"这种**物**，而这张图的地标是**地形**—— 所以画法反过来：
  // 不画建筑剪影，画两座高地。
  //
  // 按真实布局从左到右排：左=北岭、右=南丘、中间=鞍部、前景=营区。
  // 画进去的四个符号（都是这张图真正的辨识点）：
  //   · 两座瞭望塔（高地上各一座，最强的剪影符号）—— 一座在左丘顶，一座在右丘
  //   · 鞍部（两丘之间压低的那道口，必经的交战区）
  //   · 前景的营区围墙 + 大门（横穿画面下沿的灰线与两根门柱）
  //   · 盘山路的之字折线（从营区门口爬向左丘，两处高地的连接）
  //   · 正东的太阳（地图 sunDir 拍板成正东，+x=东 → 画在右侧）
  //
  // **下沿要留给文字**：.mapc 高 150px，而 .mapinfo 压着一层
  // transparent→rgba(0,0,0,.85) 的渐变（style.css:79）。所以地平线定在 y≈104，
  // 营区围墙压在 y≈118 而不是画面最底 —— 否则围墙和大门会被渐变吃掉半个。
  ridges: `<svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe3ee"/><stop offset=".5" stop-color="#a3c47e"/><stop offset="1" stop-color="#5d7a3c"/></linearGradient></defs><rect width="300" height="150" fill="url(#gr)"/><circle cx="252" cy="24" r="14" fill="#fffbe4" opacity=".95"/><path d="M0 104 Q34 92 58 96 Q82 70 108 62 L142 58 Q164 74 178 88 Q200 78 226 60 Q256 48 300 62 L300 118 L0 118Z" fill="#6b8a46"/><path d="M58 96 Q82 70 108 62 L142 58 Q164 74 178 88 Q152 78 116 80 Q86 84 58 96Z" fill="#4c6634" opacity=".6"/><path d="M226 60 Q256 48 300 62 L300 82 Q262 66 226 60Z" fill="#87a55c" opacity=".7"/><path d="M104 64 L142 58 L148 62 L110 68Z" fill="#d6d0ae"/><g stroke="#33482a" stroke-width="1.5" fill="none"><path d="M110 66 L108 42 M140 58 L142 36 M108 42 L142 36 M113 48 L137 41"/><path d="M234 56 L232 32 M264 58 L266 34 M232 32 L266 34 M237 38 L261 44"/></g><rect x="104" y="30" width="42" height="4" fill="#33482a"/><rect x="228" y="20" width="42" height="4" fill="#33482a"/><path d="M0 118 L48 112 L104 116 L158 110 L214 116 L268 110 L300 114 L300 150 L0 150Z" fill="#838d5c"/><path d="M30 132 L58 116 L88 130 L118 114 L148 128" stroke="#c6c3a6" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M176 130 L204 116 L232 128" stroke="#c6c3a6" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="0" y="116" width="300" height="2.6" fill="#5f5f4e"/><rect x="76" y="110" width="4" height="8" fill="#4a4a40"/><rect x="82" y="110" width="4" height="8" fill="#4a4a40"/><g fill="#c8323a"><path d="M126 108 l7-4 v6Z"/><path d="M180 112 l7-4 v6Z"/><path d="M248 104 l7-4 v6Z"/></g><g stroke="#e6e2cc" stroke-width="1.3"><path d="M126 108 V96 M180 112 V100 M248 104 V92"/></g><path d="M186 122 l6-5 6 5Z" fill="#e8e4d0"/><path d="M262 124 l6-5 6 5Z" fill="#e8e4d0"/></svg>`,
};

const FX_LABEL = {
  recoilV: ['垂直后坐力', -1], recoilH: ['水平后坐力', -1], ads: ['开镜时间', -1], range: ['有效射程', 1], mobility: ['移动速度', 1],
  mag: ['弹匣容量', 1], reload: ['换弹时间', -1], hip: ['腰射扩散', -1], sprintFire: ['冲刺后射击延迟', -1],
};
function fxList(fx) {
  const out = [];
  for (const k in fx) {
    const v = fx[k];
    if (FX_LABEL[k]) {
      const [n, dir] = FX_LABEL[k];
      const pct = Math.round((v - 1) * 100);
      const good = pct * dir > 0;
      out.push(`<span style="color:${good ? '#8fe06a' : '#ff6a5a'}">${good ? '▲' : '▼'} ${n} ${pct > 0 ? '+' : ''}${pct}%</span>`);
    } else if (k === 'suppressed') out.push('<span style="color:#8fe06a">▲ 雷达隐身</span>');
    else if (k === 'flashHide') out.push('<span style="color:#8fe06a">▲ 隐藏枪口火光</span>');
    else if (k === 'zoom') out.push(`<span style="color:#ccc">● 放大倍率 ${v}x</span>`);
    else if (k === 'laser') out.push('<span style="color:#ccc">● 可见激光</span>');
  }
  return out.join('');
}
// 转义器只有一份（js/escape.js，M10）：本地这版**不转单引号** —— 用 '...' 包属性值的
// 那一格就漏了，而"哪一处用的是哪一份"没人说得清。名字仍叫 esc，调用点一个都不用改。
const esc = escHtml;

// 输入法保护：中文/日文选词时的回车是"**上屏**"，不是"提交 / 发送"。
// `isComposing` 是标准信号，`keyCode === 229` 是部分旧 IME / 浏览器唯一给得出来的回退信号
// （两者都要，只认一个会在某类输入法上漏掉）。抽成纯函数不是为了好看 —— 那两处都在 DOM
// 事件回调里，node 侧够不到，而"少写这一句"的症状（把半成品拼音当成密码提交 / 当成消息发出去）
// 只会表现为"玩家手快"，所以它必须能被判据直接走一遍。
// 定义搬到 js/net/chat.mjs（对局内的聊天输入也要同一把尺子，两个定义迟早分叉）；
// 这里留再导出，老的判据入口（test/net-feel.mjs 从 menu 认它）不用跟着动。
import { isImeKey, parseChatCommand, toggleMute, chatRowHtml } from './net/chat.mjs';
export { isImeKey };

// 暂停屏上"这一屏该说什么、该给哪些动作"。抽成纯函数有两个理由：
//   ① 联机这条路上"暂停"这个词是**假**的（本地 sim 停了、服务端照跑，你的人还在场上挨打）——
//      §附三 说得很清楚，服务端不暂停不是缺陷，缺的是**客户端的提示与降级**；
//   ② "联机时不许再出现'重新开始对局'"这条必须能被判据钉住。钉文案是错的（这个仓库为此
//      红过一整轮），所以这里量的是**结构**：哪个动作在不在。
// 返回的字段名就是判据要读的东西，文案只是它们的呈现。
export function pauseActions({ camp, online }) {
  return {
    title: online ? '菜单' : '已暂停',
    sub: camp ? '战役 · 午夜清道夫' : online ? '多人对战 · 对局仍在进行' : '多人对战',
    changeClass: !camp,
    // 联机时"重新开始对局"会 ws.close() 静默断开、然后在本地开一局带 AI 的对战 ——
    // 玩家以为还在打原来那局。替代它的是"退出本局"（有大厅座位就回房间，那条 socket
    // 是房间的座位，关掉等于被踢出房间）。
    restart: !online,
    leaveMatch: online,
    note: online ? '按 Esc 继续 · 对局不会因此停下' : '按 Esc 继续',
  };
}

export class Menu {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('menu');
    this.overlayOpen = false;
    this.camTarget = { pos: new THREE.Vector3(-0.3, 1.45, 4.2), look: new THREE.Vector3(0.6, 1.15, 0) };
    this.camLook = this.camTarget.look.clone();
    this.gunRotY = -Math.PI / 2; this.gunRotX = 0; this.gunSpin = true;
    // score 是胜利目标那格（js/data.js:scoreOptions(mode) 里的一个值），单人对战与联机建房共用这一份偏好。
    // 默认 50：与 js/match-rules.js 的 DEFAULT_SCORE_LIMIT('tdm') 同值 —— 但它只是
    // "上次选了什么"的记忆，真正的默认/清洗在服务端（lobby.cleanScore）。
    this.lobby = { mode: 'tdm', map: 'dune', diff: 1, allies: 5, enemies: 6, time: 10, minutes: 10, score: 50, name: '士兵', team: 'A', room: '', title: '' };
    this.campDiff = 1;
    this.gateRecover = false;      // 闸的形态：false = 登录/注册，true = 用恢复码重设密码
    this.selClass = game.profile.selClass || 0;
    this.buildScene();
    this.el.addEventListener('pointerdown', () => game.audio.init());
    this.el.addEventListener('mouseover', e => { const t = e.target.closest('.mbtn,.btn,.pick,.cls,.slotc,.gs-att,.gs-slot,.mode,.mapc,.diff'); if (t && t !== this._hov) { this._hov = t; game.audio.ui('hover'); } });
    this.el.addEventListener('click', e => { if (e.target.closest('.mbtn,.btn,.pick,.cls,.slotc,.gs-att,.gs-slot,.mode,.mapc,.diff,.seg div,.camo')) game.audio.ui('click'); });
    window.addEventListener('keydown', e => {
      if (e.code === 'Escape' && game.paused && this.screen === 'pause' && performance.now() - this.pauseAt > 300) this.resume();
      else if (e.code === 'Escape' && this.screen === 'classSelect') this.hideClassSelect();
    });
    // 枪匠拖拽旋转
    let drag = null;
    this.el.addEventListener('pointerdown', e => { if (this.screen === 'gunsmith' && !e.target.closest('.gs-left,.gs-right,.gs-stats,.gs-foot')) { drag = { x: e.clientX, y: e.clientY }; this.gunSpin = false; } });
    window.addEventListener('pointermove', e => { if (drag) { this.gunRotY += (e.clientX - drag.x) * 0.01; this.gunRotX = Math.max(-0.6, Math.min(0.6, this.gunRotX + (e.clientY - drag.y) * 0.006)); drag.x = e.clientX; drag.y = e.clientY; } });
    window.addEventListener('pointerup', () => { drag = null; });
    this.el.addEventListener('wheel', e => { if (this.screen === 'gunsmith') { this.gsZoom = Math.max(0.8, Math.min(2.2, (this.gsZoom || 1.45) + Math.sign(e.deltaY) * 0.1)); this.camTarget.pos.z = this.gsZoom; } }, { passive: true });
  }

  // ---------------- 3D 场景 ----------------
  buildScene() {
    const game = this.game;
    const s = this.scene3d = new THREE.Scene();
    s.background = new THREE.Color(0x06080a);
    s.fog = new THREE.FogExp2(0x06080a, 0.07);
    const pm = new THREE.PMREMGenerator(game.renderer);
    s.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.3;
    pm.dispose();
    const cam = this.camera3d = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 100);
    cam.position.copy(this.camTarget.pos);
    const plane = (w, h, m, sc) => {
      const g = new THREE.PlaneGeometry(w, h);
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / sc, uv.getY(i) * h / sc);
      const me = new THREE.Mesh(g, m); me.receiveShadow = true; return me;
    };
    const floor = plane(40, 40, mat('concreteDark'), 3); floor.rotation.x = -Math.PI / 2; s.add(floor);
    const wall = plane(40, 12, mat('concreteDark'), 3); wall.position.set(0, 6, -5); s.add(wall);
    // 道具：箱子、沙袋、油桶
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat('crate')); crate.position.set(-1.4, 0.5, -1.6); crate.rotation.y = 0.3; crate.castShadow = crate.receiveShadow = true; s.add(crate);
    const crate2 = crate.clone(); crate2.scale.setScalar(0.7); crate2.position.set(-1.35, 1.35, -1.6); crate2.rotation.y = 0.7; s.add(crate2);
    const case1 = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.35, 0.5), mat('darkMetal')); case1.position.set(2.4, 0.175, -1.2); case1.rotation.y = -0.4; case1.castShadow = true; s.add(case1);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 20), mat('containerGreen')); barrel.position.set(2.9, 0.45, -2.4); barrel.castShadow = true; s.add(barrel);
    const sb = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.5, 4, 8).rotateZ(Math.PI / 2), mat('sandbag'));
    for (let i = 0; i < 5; i++) { const b = sb.clone(); b.position.set(-3 + (i % 3) * 0.75 + (i > 2 ? 0.37 : 0), 0.18 + (i > 2 ? 0.32 : 0), -2.6); b.castShadow = true; s.add(b); }
    // 灯光
    const key = new THREE.SpotLight(0xffe2c0, 60, 20, 0.55, 0.6, 1.4);
    key.position.set(3, 5, 4); key.target.position.set(0.6, 1, 0); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0005;
    s.add(key, key.target);
    const rim = new THREE.SpotLight(0x6aa8ff, 70, 20, 0.6, 0.7, 1.3);
    rim.position.set(-3, 4, -3); rim.target.position.set(0.6, 1.2, 0); s.add(rim, rim.target);
    const rim2 = new THREE.PointLight(0xffa040, 6, 8, 1.5); rim2.position.set(3.5, 1.2, -1.5); s.add(rim2);
    this.fireLight = rim2;
    s.add(new THREE.HemisphereLight(0x8090a0, 0x201810, 0.25));
    // 浮尘
    const N = 400, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 10; pos[i * 3 + 1] = Math.random() * 4; pos[i * 3 + 2] = (Math.random() - 0.5) * 8; }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dot = document.createElement('canvas'); dot.width = dot.height = 32; const dc = dot.getContext('2d'); const gr = dc.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); dc.fillStyle = gr; dc.fillRect(0, 0, 32, 32);
    this.dust = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.025, map: new THREE.CanvasTexture(dot), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe0c0 }));
    s.add(this.dust);
    // 枪械展示
    this.gunHolder = new THREE.Group(); this.gunHolder.position.set(0, 1.25, 0); s.add(this.gunHolder);
    const gl = new THREE.SpotLight(0xffffff, 45, 6, 0.6, 0.5, 1.2); gl.position.set(0.6, 2.8, 1.6); gl.target = this.gunHolder; s.add(gl);
    const gl2 = new THREE.PointLight(0x9fc4ff, 4, 5, 1.5); gl2.position.set(-1, 1.6, 1.2); s.add(gl2);
    this.gunLight = gl; gl.visible = false; this.gunLight2 = gl2; gl2.visible = false;
    this.soldierAnim = { speed: 0, phase: 0, crouch: 0, pitch: -0.12, dead: false, recoil: 0 };
    this.setSoldier(this.game.profile.classes[this.selClass]);
  }
  setSoldier(cls) {
    const key = cls.primary + JSON.stringify(cls.patt) + cls.pcamo;
    if (this.soldierKey === key) return;
    this.soldierKey = key;
    if (this.soldier) this.scene3d.remove(this.soldier.root);
    const p = this.soldier = createSoldierModel('ally', cls.primary, cls.patt, cls.pcamo);
    p.root.position.set(0.95, 0, 0.2);
    p.root.rotation.y = Math.PI - 0.95;
    this.scene3d.add(p.root);
  }
  showGun(id, att, camo) {
    const key = id + JSON.stringify(att) + camo;
    if (this.gunKey === key) return;
    this.gunKey = key;
    if (this.gun) { this.gunHolder.remove(this.gun); this.gun.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    const info = buildGun(id, att, camo);
    const g = new THREE.Group(); g.add(info.group);
    const box = new THREE.Box3().setFromObject(info.group);
    const c = box.getCenter(new THREE.Vector3());
    info.group.position.sub(c);
    const size = box.getSize(new THREE.Vector3());
    const sc = 1.25 / Math.max(size.x, size.y, size.z);
    g.scale.setScalar(Math.min(2.2, sc));
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    this.gun = g; this.gunHolder.add(g);
  }
  setCam(kind) {
    this.camKind = kind;
    const T = this.camTarget;
    if (kind === 'gunsmith') { T.pos.set(0, 1.3, this.gsZoom || 1.45); T.look.set(0, 1.22, 0); }
    else if (kind === 'loadout') { T.pos.set(-1.1, 1.35, 3.5); T.look.set(-0.55, 1.1, 0); }
    else if (kind === 'lobby') { T.pos.set(-1.2, 1.2, 3.8); T.look.set(-0.3, 1.2, 0); }
    else { T.pos.set(-0.3, 1.45, 4.2); T.look.set(0.6, 1.15, 0); }
    const gs = kind === 'gunsmith';
    this.gunHolder.visible = gs; this.gunLight.visible = gs; this.gunLight2.visible = gs;
    if (this.soldier) this.soldier.root.visible = !gs;
    if (gs) { this.gunSpin = true; this.gunRotX = 0.05; }
  }
  update(dt) {
    const t = performance.now() * 0.001;
    const cam = this.camera3d, T = this.camTarget;
    cam.position.x = damp(cam.position.x, T.pos.x + Math.sin(t * 0.3) * 0.04, 4, dt);
    cam.position.y = damp(cam.position.y, T.pos.y + Math.sin(t * 0.4) * 0.02, 4, dt);
    cam.position.z = damp(cam.position.z, T.pos.z, 4, dt);
    this.camLook.x = damp(this.camLook.x, T.look.x, 4, dt); this.camLook.y = damp(this.camLook.y, T.look.y, 4, dt); this.camLook.z = damp(this.camLook.z, T.look.z, 4, dt);
    cam.lookAt(this.camLook);
    if (this.soldier && this.soldier.root.visible) {
      const a = this.soldierAnim;
      a.pitch = -0.1 + Math.sin(t * 1.3) * 0.015;
      animateSoldier(this.soldier, a, dt);
      this.soldier.torso.rotation.z = Math.sin(t * 0.9) * 0.015;
      this.soldier.hips.position.y = 0.95 + Math.sin(t * 2.6) * 0.004;
    }
    if (this.gunHolder.visible) {
      if (this.gunSpin) this.gunRotY += dt * 0.35;
      this.gunHolder.rotation.y = damp(this.gunHolder.rotation.y, this.gunRotY, 8, dt);
      this.gunHolder.rotation.x = damp(this.gunHolder.rotation.x, this.gunRotX, 8, dt);
      this.gunHolder.position.y = 1.25 + Math.sin(t * 1.2) * 0.01;
    }
    const p = this.dust.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + dt * 0.03; if (y > 4) y = 0;
      p.setXYZ(i, p.getX(i) + Math.sin(t * 0.5 + i) * dt * 0.02, y, p.getZ(i));
    }
    p.needsUpdate = true;
    this.fireLight.intensity = 5 + Math.sin(t * 13) * 0.8 + Math.sin(t * 7.3) * 0.8;
  }
  onResize() {
    this.camera3d.aspect = window.innerWidth / window.innerHeight;
    this.camera3d.updateProjectionMatrix();
  }

  // ---------------- 工具 ----------------
  render(html, cls = 'dim', screen = '') {
    this.screen = screen;
    this.el.innerHTML = `<div class="screen ${cls}">${html}</div>`;
    return this.el.firstChild;
  }
  on(root, sel, fn) { root.querySelectorAll(sel).forEach((el, i) => el.addEventListener('click', e => fn(el, e, i))); }
  hide() { this.el.innerHTML = ''; this.screen = ''; this.overlayOpen = false; }
  level() {
    // **两半都算**：账号那份（服务端记的联机战绩）+ 本地那份（战役 / 单机 / 访客联机）。
    // 只按账号那份算的话，本地挣的经验在界面上等于不存在 —— 那正是缺口的样子。
    const xp = totalXp(this.game.profile);
    const lv = levelOf(xp);
    const a = Math.pow(lv - 1, 2) * 300, b = Math.pow(lv, 2) * 300;
    return { lv, frac: lv >= 55 ? 1 : (xp - a) / (b - a), xp };
  }
  playerCard() {
    const L = this.level();
    // 两半分开写在卡上：玩家看得见"本地这些没进账号"，而不是只看见一个总数。
    const line = xpText(this.game.profile, !!(this.game.account && this.game.account.user));
    return `<div class="player-card"><div class="lvl">${L.lv}</div><div><div style="font-weight:700;letter-spacing:2px">指挥官</div><div style="font-size:11px;color:#999">${line}</div><div class="xpbar"><div style="width:${Math.round(L.frac * 100)}%"></div></div></div></div>`;
  }
  showLoadingOverlay(text) {
    this.render(`<div style="margin:auto;text-align:center"><div class="logo"><div class="l1">现代战线</div><div class="l2">MODERN FRONTLINE</div></div><div class="load-bar" style="width:420px;margin:0 auto"><div style="height:100%;width:100%;background:var(--acc);animation:ldpulse 1s infinite"></div></div><div style="margin-top:14px;color:#999;letter-spacing:3px;font-size:13px">${esc(text)}</div></div><style>@keyframes ldpulse{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}}</style>`, 'solid', 'loading');
  }

  // ---------------- 主菜单 ----------------
  showMain() {
    // 档案卡要显示服务端那份经验值，所以进主菜单时**按需**拉一次账号状态。
    // 刻意不放在 main.js 的构造函数里：那会让 ?online=1 这条路（直接进对局、根本不画主菜单）
    // 也在页面加载时多发两次请求，而那两次请求会把客户端第 0 拍相对权威端的相位挪掉 ——
    // 实测代价见 js/main.js 里那段（net-play 的稳态偏差 5 次里红 4 次）。
    // 这里不 await：拉不到就显示本地那份，单机照玩。
    // 回来之后刷一次"联网对战"那一项的锁标（未完成注册前不开放）—— 它取决于
    // "这个服要不要账号、我登没登录"，而这两格都要问服务端才知道（accountSync 是幂等的）。
    this.game.accountSync && this.game.accountSync().then(() => this.updateOnlineEntry());
    this.setCam('main');
    this.setSoldier(this.game.profile.classes[this.game.profile.selClass || 0]);
    const best = this.game.profile.campaignBest;
    const r = this.render(`
      <div class="menu-left">
        <div class="menu-title">现代战线</div>
        <div class="menu-sub">MODERN FRONTLINE</div>
        <div class="mbtn" data-a="campaign"><div class="ico">◈</div><div><div class="mt">战役</div><div class="md">行动代号：午夜清道夫 ${best ? '· 最佳 ' + fmtTime(best) : ''}</div></div></div>
        <div class="mbtn" data-a="mp"><div class="ico">⚔</div><div><div class="mt">多人对战</div><div class="md">团队死斗 · 占领 · 自由混战</div></div></div>
        <div class="mbtn" data-a="online"><div class="ico">🌐</div><div><div class="mt">联网对战</div><div class="md">真人在线对局</div></div></div>
        <div class="mbtn" data-a="loadout"><div class="ico">⚙</div><div><div class="mt">武器装备</div><div class="md">自定义配装 · 枪匠 · 技能 · 连杀奖励</div></div></div>
        <div class="mbtn" data-a="settings"><div class="ico">☰</div><div><div class="mt">设置</div><div class="md">画面 · 操作 · 音频</div></div></div>
      </div>
      ${this.playerCard()}
      <div style="position:absolute;right:40px;bottom:30px;text-align:right;font-size:12px;color:#777;line-height:1.9">
        <div><span class="kbd">WASD</span>移动 <span class="kbd">Shift</span>冲刺 <span class="kbd">C</span>蹲/滑铲 <span class="kbd">Z</span>趴 <span class="kbd">Q/E</span>探头 <span class="kbd">空格</span>跳跃 <span class="kbd">R</span>换弹 <span class="kbd">V</span>近战</div>
        <div><span class="kbd">4</span>投掷物（左键烹饪/投出） <span class="kbd">F</span>互动 <span class="kbd">N</span>夜视仪 <span class="kbd">5/6/7</span>连杀奖励 <span class="kbd">Tab</span>记分板</div>
        <div style="color:#555;margin-top:6px">v1.0</div>
      </div>`, 'dim', 'main');
    this.on(r, '[data-a]', el => {
      const a = el.dataset.a;
      if (a === 'campaign') this.showCampaign();
      else if (a === 'mp') this.showLobby();
      else if (a === 'online') this.showOnlineEntry();   // 层级路由：先过闸还是直接进大厅
      else if (a === 'loadout') this.showLoadouts('main');
      else if (a === 'settings') this.showSettings('main');
    });
  }

  // ---------------- 战役简报 ----------------
  showCampaign() {
    this.setCam('lobby');
    const best = this.game.profile.campaignBest;
    const diffDesc = ['敌人反应迟缓，你能承受更多伤害。适合初次体验。', '标准的战斗体验，需要合理利用掩体。', '敌人致命而精准，每一次暴露都可能是最后一次。'];
    const r = this.render(`
      <div class="brief">
        <div class="op">行动代号</div>
        <h1>午夜清道夫</h1>
        <p>卡尔达什边境，当地时间凌晨 02:40。情报确认，军火走私网络头目 <b style="color:#fff">「铁蝎」萨米尔</b> 今夜藏身于边境村落深处的一座武装大院中。他掌握着一批失踪的便携式防空导弹的下落。</p>
        <p>你将与 <b style="color:#fff">布雷克上尉</b> 和狙击手 <b style="color:#fff">渡鸦</b> 一同夜间渗透：拔除外围前哨，穿越村庄，突入大院，击毙目标并夺取情报，随后在敌人的反扑中坚守直至撤离。</p>
        <div class="meta"><div>地点<b>卡尔达什边境</b></div><div>时间<b>02:40 夜间</b></div><div>小队<b>3 人</b></div><div>最佳用时<b>${best ? fmtTime(best) : '—'}</b></div></div>
        <div class="diffs">${DIFF_NAMES.map((n, i) => `<div class="diff ${i === this.campDiff ? 'sel' : ''}" data-d="${i}"><b>${n}</b><span>${diffDesc[i]}</span></div>`).join('')}</div>
        <div style="display:flex;gap:12px"><button class="btn" data-a="go">开始任务</button><button class="btn ghost" data-a="back">返回</button></div>
      </div>`, 'dim', 'campaign');
    this.on(r, '.diff', el => { this.campDiff = +el.dataset.d; r.querySelectorAll('.diff').forEach(d => d.classList.toggle('sel', d === el)); });
    this.on(r, '[data-a=go]', () => this.game.startGame('campaign', { diff: this.campDiff }));
    this.on(r, '[data-a=back]', () => this.showMain());
  }

  // ---------------- 多人大厅 ----------------
  showLobby() {
    this.setCam('lobby');
    const L = this.lobby, P = this.game.profile;
    const cls = P.classes[P.selClass || 0];
    const seg = (key, vals, labels) => `<div class="seg" data-k="${key}">${vals.map((v, i) => `<div data-v="${v}" class="${L[key] == v ? 'sel' : ''}">${labels ? labels[i] : v}</div>`).join('')}</div>`;
    const r = this.render(`
      <div class="lobby">
        <div class="hdr">多人对战<small>对战 AI · 本地对局</small></div>
        <div class="lobby-body">
          <div class="lobby-col">
            <div style="font-size:12px;color:#888;letter-spacing:3px">游戏模式</div>
            <div class="modes">${MP_MODES.map(m => `<div class="mode ${m.id === L.mode ? 'sel' : ''}" data-m="${m.id}"><b>${m.name}</b><span>${m.desc}</span></div>`).join('')}</div>
            <div style="font-size:12px;color:#888;letter-spacing:3px;margin-top:10px">地图</div>
            <div class="maps">${MP_MAPS.map(m => `<div class="mapc ${m.id === L.map ? 'sel' : ''}" data-map="${m.id}"><div class="mapart">${MAP_ART[m.id] || ''}</div><div class="mapinfo"><b>${m.name}</b><span>${m.style} — ${m.desc}</span></div></div>`).join('')}</div>
          </div>
          <div class="lobby-col" style="flex:1;max-width:460px">
            <div class="panel"><div class="opts">
              <div>AI 难度</div>${seg('diff', [0, 1, 2], DIFF_NAMES)}
              <div class="tm-only">队友数量</div><div class="tm-only">${seg('allies', [3, 5], ['3', '5'])}</div>
              <div>敌人数量</div>${seg('enemies', [4, 6, 8], ['4', '6', '8'])}
              <div>时间限制</div>${seg('time', [5, 10, 15], ['5 分钟', '10 分钟', '15 分钟'])}
              <div>胜利目标</div>${seg('score', SCORES_ALL, SCORES_ALL.map(String), L.score)}
              <div id="limitTxt" class="note-wide" style="color:#777"></div>
            </div></div>
            <div class="panel">
              <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:8px">当前配装</div>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div><div style="font-size:20px;font-weight:800">${esc(cls.name)}</div><div style="font-size:12px;color:#aaa;margin-top:4px">${WEAPONS[cls.primary].name} · ${WEAPONS[cls.secondary].name} · ${cls.perks.map(id => this.perk(id).name).join(' / ')}</div></div>
                <button class="btn small ghost" data-a="loadout">编辑</button>
              </div>
              <div style="font-size:12px;color:#888;margin-top:10px">连杀奖励：${P.streaks.map(id => KILLSTREAKS.find(k => k.id === id)).sort((a, b) => a.kills - b.kills).map(k => `${k.icon} ${k.name}(${k.kills})`).join('　')}</div>
            </div>
            <div class="lobby-foot" style="margin-top:auto"><button class="btn ghost" data-a="back">返回</button><button class="btn" data-a="go">开始对局</button></div>
          </div>
        </div>
      </div>`, 'solid', 'lobby');
    const upd = () => {
      // 目标那格只写数字（"150 杀"这种双字后缀 ×6 会把它顶出 460 px 的面板 —— 量过，
      // 需要 ~380 px、只有 ~300 px）；"是杀还是分"的语义由下面那行说明文字说，
      // 换模式时它跟着重写。档位按模式换表：不属于当前模式的值藏掉；旧偏好不在新表里
      // 就落回该模式的默认（dom 200 分 / tdm 50 杀）—— 默认只问规则内核那一份。
      if (!scoreOptions(L.mode).includes(L.score)) L.score = DEFAULT_SCORE_LIMIT(L.mode);
      // 地图卡片同理按模式收放：专属图（ridges 只在占领）**藏掉**而不是置灰 ——
      // 置灰会让人以为换个模式它就换图生效，藏掉才是"这个模式没有这张图"。
      // 当前图不被新模式收 → 落回该模式第一张可用的图（dune 全模式可开，兜底恒存在）。
      if (!mapAllowed(L.map, L.mode)) L.map = mapsForMode(L.mode)[0].id;
      r.querySelectorAll('.mapc').forEach(c => {
        c.style.display = mapAllowed(c.dataset.map, L.mode) ? '' : 'none';
        c.classList.toggle('sel', c.dataset.map === L.map);
      });
      const segEl = r.querySelector('.seg[data-k=score]');
      if (segEl) segEl.querySelectorAll('div').forEach(d => {
        const v = +d.dataset.v;
        d.style.display = scoreOptions(L.mode).includes(v) ? '' : 'none';
        d.classList.toggle('sel', v === L.score);
      });
      r.querySelector('#limitTxt').textContent = `先达到 ${L.score}${L.mode === 'dom' ? ' 分' : ' 击杀'}获胜，或时间结束时领先`;
      r.querySelectorAll('.tm-only').forEach(e => e.style.opacity = L.mode === 'ffa' ? 0.3 : 1);
    };
    upd();
    this.on(r, '.mode', el => { L.mode = el.dataset.m; r.querySelectorAll('.mode').forEach(d => d.classList.toggle('sel', d === el)); upd(); });
    this.on(r, '.mapc', el => { L.map = el.dataset.map; r.querySelectorAll('.mapc').forEach(d => d.classList.toggle('sel', d === el)); });
    r.querySelectorAll('.seg').forEach(sg => sg.querySelectorAll('div').forEach(d => d.addEventListener('click', () => { L[sg.dataset.k] = +d.dataset.v; sg.querySelectorAll('div').forEach(x => x.classList.toggle('sel', x === d)); })));
    this.on(r, '[data-a=back]', () => this.showMain());
    this.on(r, '[data-a=loadout]', () => this.showLoadouts('lobby'));
    this.on(r, '[data-a=go]', () => {
      this.showLoadingOverlay('正在匹配对局…');
      setTimeout(() => this.game.startGame('mp', { mode: L.mode, map: L.map, diff: L.diff, allies: L.mode === 'ffa' ? 0 : L.allies, enemies: L.enemies, scoreLimit: L.score, timeLimit: L.time }), 600);
    });
  }
  // 胜利目标那格的标签（**只有联机建房屏在用** —— 它那一行独占约 660 px 面板宽，
  // 带后缀放得下；房间屏与单机屏是窄栏，只写数字，语义由行标签与说明文字说）。
  // tdm/ffa 的目标是"率先达到的击杀数"（一杀一分），dom 是占领分数。
  scoreLabel(v, mode) { return v + (mode === 'dom' ? ' 分' : ' 杀'); }
  // ── 联机的层级：主菜单 →（闸：注册/登录）→ 房间列表大厅 → 对局 ──
  // 层级是**屏与屏的先后**，不是同一屏上锁几个按钮：注册是前置条件，房间列表是正事，
  // 摆在同一屏上两个焦点互相稀释（"一堆按钮 + 三个输入框"，不知道该先干什么），
  // 而"锁着的列表"是一块看得见点不动的东西，比不给看更招人烦。
  // 于是拆成三屏，每屏只干一件事；这一段是唯一入口（主菜单点"联网对战"）：
  //   策略未知      —— 先不猜（猜错的两种都不好：给访客服摆注册页 / 把该注册的人放进大厅）；
  //   要账号·未登录 —— 注册/登录（闸，独占一屏）；
  //   其余          —— 房间列表大厅（已登录，或服主明说的访客可玩服）。
  showOnlineEntry() {
    const A = this.game.account;
    if (!A.statusKnown && !this._policyWait) {
      this._policyWait = true;
      this.showLoadingOverlay('正在进入联网对战…');
      Promise.resolve(this.game.accountSync ? this.game.accountSync() : A.status()).then(() => {
        this._policyWait = false;
        if (this.screen !== 'loading') return;        // 等待期间人已经去了别处，别把他拽回来
        // 连不上服务器时 statusKnown 仍是 false：往严的那边倒（当"要账号"处理、落在闸上），
        // 而不是回到这里空转 —— accountSync 已经定住，再进一次立刻 then，会成死循环。
        if (A.statusKnown) this.showOnlineEntry(); else this.showOnlineGate();
      });
      return;
    }
    if (A.requireAccount && !A.loggedIn) this.showOnlineGate();
    else this.showOnlineLobby();
  }

  // ── 联机第二层：注册 / 登录（闸）───────────────────────────────────────
  // 这一屏只干一件事：把身份办了。办完**自动前进**到房间列表大厅 —— 下一步不该让玩家自己找。
  // 访客可玩的服（REQUIRE_ACCOUNT=0）没有这一层，showOnlineEntry 直接路由到大厅。
  // 真正的权限不在这里：服务端 /api/rooms 的 401 与 WS 握手的 401 一样拒（改客户端绕不过去）。
  showOnlineGate() {
    const A = this.game.account;
    // 已有身份的人不该停在闸上（刷新、从大厅登出前的旧页签等路径都可能走到这里）—— 直接前进。
    if (A.statusKnown && (!A.requireAccount || A.loggedIn)) { this.showOnlineLobby(); return; }
    this.setCam('lobby');
    const L = this.lobby;
    // 闸有两种形态：登录/注册（默认）与"用恢复码重设密码"（点「忘了密码？」切过来）。
    // 形态存在 this 上而不是 DOM 上 —— 它的每一次切换都是重渲染（见下面 keepName）。
    const rec = !!this.gateRecover;
    const inp = 'width:100%;box-sizing:border-box;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.18);color:#eee;padding:7px 10px;font:inherit;letter-spacing:1px';
    // 错误信息一律**原样显示服务端那一句**：这个模块不翻译、不复述。翻译的那一版会把
    // "邀请码不对"和"服务器忙"揉成同一句"登录失败"，服主永远收不到"我邀请码是多少"这个真问题。
    const note = `进对局需要账号${A.inviteRequired ? '，注册需邀请码（向服主索取）' : ''}。`;
    // 这一段只说"我现在要做什么 / 做完会发生什么"。原先那一版还写了为什么要账号
    // （封禁依据、服务端看着有人作弊无处记录、换台机器还在也改不动）—— 那是设计文档的
    // 内容，写在闸上只会让人读两段才知道该点哪个按钮。
    const r = this.render(`
      <div class="gate-card">
        <div class="op">联网对战 · 账号</div>
        <h1>${rec ? '用恢复码重设密码' : '登录 / 注册'}</h1>
        <p>${rec
          ? '填呼号、一张注册时抄下的恢复码、以及新密码。<br>成功之后旧会话全部失效，并会发一叠新的恢复码。'
          : '呼号全服唯一，战绩与经验保存在服务器。<br>登录后自动进入房间列表。'}</p>
        <div class="opts">
          <div>呼号</div><input id="onName" maxlength="16" placeholder="2-16 个字符" value="${esc(L.name || '')}" style="${inp}">
          <div>${rec ? '新密码' : '密码'}</div><input id="acctPw" type="password" maxlength="128" placeholder="至少 8 位" style="${inp}">
          ${rec
            ? `<div>恢复码</div><input id="acctRecov" placeholder="XXXX-XXXX-XXXX" autocomplete="off" style="${inp}">`
            : (A.inviteRequired ? `<div>邀请码</div><input id="acctCode" placeholder="由服主提供" style="${inp}">` : '')}
          <div></div><div style="display:flex;gap:8px">${rec
            ? `<button class="btn" data-a="docover">重设密码</button><button class="btn ghost" data-a="tologin">返回登录</button>`
            : `<button class="btn" data-a="login">登录</button><button class="btn ghost" data-a="reg">注册</button>`}</div>
          <div class="note-wide" id="acctMsg">${esc(A.lastError || '')}</div>
          ${rec ? '' : `<div class="note-wide"><button class="btn ghost small" data-a="forgot">忘了密码？</button> 用注册时抄下的恢复码重设</div>`}
          <div class="note-wide">${note}</div>
        </div>
        <div class="lobby-foot"><button class="btn ghost" data-a="back">返回主菜单</button></div>
      </div>`, 'solid', 'onlineGate');
    this.on(r, '[data-a=back]', () => this.showMain());
    // 两种形态共用一个 render，所以"切形态"就是重渲染一次 —— 名字要先捞进 L.name，
    // 否则点一下"忘了密码？"就把已经打好的呼号擦掉了（那看起来像页面抽风）。
    const keepName = () => { const el = r.querySelector('#onName'); if (el && el.value.trim()) L.name = el.value.trim(); };
    this.on(r, '[data-a=forgot]', () => { keepName(); this.gateRecover = true; this.showOnlineGate(); });
    this.on(r, '[data-a=tologin]', () => { keepName(); this.gateRecover = false; this.showOnlineGate(); });
    const grab = () => ({
      name: String((r.querySelector('#onName') || {}).value || '').trim(),
      password: String((r.querySelector('#acctPw') || {}).value || ''),
      invite: String((r.querySelector('#acctCode') || {}).value || ''),
      rc: String((r.querySelector('#acctRecov') || {}).value || ''),
    });
    const submit = async (kind) => {
      const f = grab();
      L.name = f.name || L.name;
      this.acctMsg(r, kind === 'reg' ? '正在注册…' : (kind === 'recover' ? '正在重设…' : '正在登录…'));
      const r2 = kind === 'reg'
        ? await A.register({ name: f.name, password: f.password, code: f.invite })
        : (kind === 'recover'
          ? await A.recover({ name: f.name, code: f.rc, password: f.password })
          : await A.login({ name: f.name, password: f.password }));
      if (!r2.ok) { this.acctMsg(r, r2.message || '失败了'); return; }
      // 登录之后把服务端那份经验值同步到本地档案上（显示用）—— **只写账号那一半**，
      // 本地那份（战役 / 单机 / 访客联机）在这儿绝不参与（见 js/progress.mjs 开头）。
      if (A.user) { applyAccountXp(this.game.profile, A.user.xp); this.game.saveProfile(); }
      // 恢复码在这一条响应里，**之后再也要不回来**（服务端只留哈希），
      // 所以进了大厅就把它们摆在最上面让人抄 —— 少这一步的症状是"码从来没被人看见过"。
      const codes = r2.data && r2.data.recovery;
      if (Array.isArray(codes) && codes.length) { this.showRecoveryCodes(codes, kind === 'recover'); return; }
      this.showOnlineLobby();        // 层级前进：闸过了就进大厅
    };
    this.on(r, '[data-a=login]', () => submit('login'));
    this.on(r, '[data-a=reg]', () => submit('reg'));
    this.on(r, '[data-a=docover]', () => submit('recover'));
    const pw = r.querySelector('#acctPw');
    const rcEl = r.querySelector('#acctRecov');
    if (rcEl) rcEl.addEventListener('keydown', e => { if (!isImeKey(e) && e.key === 'Enter') submit('recover'); });
    if (pw) pw.addEventListener('keydown', e => {
      // 输入法保护（中文/日文）：选词时的回车是"上屏"，不是"提交"。少这一句的后果是
      // 密码框里那一串还没上屏的候选被当成密码提交，报一句"密码错误"而玩家完全不知道为什么。
      if (isImeKey(e)) return;
      if (e.key === 'Enter') submit(rec ? 'recover' : 'login');
    });
  }

  // 注册成功 / 用恢复码重设成功之后：**把恢复码摆出来让人抄**。
  // 为什么值得单独占一块而不是弹一条提示：这几张码是"忘了密码"的唯一出路，
  // 而它们只在这一个响应里存在（服务端只留哈希，自己也还原不出来）。
  // 一步放过去的话，绝大多数人会直接点掉 —— 然后在忘记密码的那一天才发现无处可去。
  //
  // 但它**不是另开一屏**，而是大厅顶端的一条横幅，理由是两个都立着的判据在这里会撞车：
  // 「码只在这一条响应里，必须让人看见」（test/net-drop.mjs 的 I 段）与
  // 「过闸就自动进大厅，下一步不该让玩家自己找」（同一份的层级②/③）。
  // 另开一屏的实测症状：`注册之后**自动进大厅**` 当场红（screen 停在 recoveryCodes、
  // 房表与建房按钮都不在），紧接着 `[data-a=logout]` 点不到 → 整段 CRASH。
  // 放在**流内**（不是浮层）也是有意的：浮层会盖住大厅的按钮，
  // 而"码摆在这儿"不该以"别的都点不动"为代价。
  showRecoveryCodes(codes, afterRecover = false) {
    this.showOnlineLobby();                        // 层级前进：闸过了就进大厅
    this._recovPending = { codes, afterRecover };  // 大厅重渲染（进房再回来）也还在，直到点掉
    this.mountRecoveryPanel();
  }
  // 把待抄的那一叠码挂到大厅顶端。单独一个方法是为了 `showOnlineLobby()` 每次渲染后
  // 都能补挂一次 —— 进房再回大厅是重新渲染，横幅不该因此消失（那就是"码又没了"）。
  mountRecoveryPanel() {
    const p = this._recovPending;
    if (!p) return;
    const body = this.el.querySelector('.lobby-body');
    if (!body || !body.parentElement) return;
    const old = this.el.querySelector('.recov-banner');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'panel recov-banner';
    box.innerHTML = `
      <div style="font-size:13px;color:var(--acc);letter-spacing:6px">${p.afterRecover ? '密码已重设' : '注册成功'} · 恢复码</div>
      <div class="note-wide" style="margin:6px 0 10px">忘了密码时，在登录那一屏点「忘了密码？」，填呼号 + 其中<b>任意一张</b> + 新密码就能重设。<br>
         它们<b>只显示这一次</b>，用掉任何一张，其余的一起作废（同时会发一叠新的）。</div>
      <div id="recovList" style="user-select:text;font:14px/2 ui-monospace,Consolas,monospace;letter-spacing:2px">${p.codes.map(c => esc(c)).join('<br>')}</div>
      <div class="note-wide" style="margin-top:8px">别截图发群里 —— 它和密码等价；忘了密码也丢了它，只能找服主。</div>
      <div class="lobby-foot"><button class="btn" data-a="done">抄好了</button></div>`;
    box.querySelector('[data-a=done]').addEventListener('click', () => { this._recovPending = null; box.remove(); });
    body.parentElement.insertBefore(box, body);
  }

  // ── 联机第三层：大厅（一张实时的房间列表 + 全服频道）──
  // 这一屏只干两件事：挑一间房进去，以及和还没进房的人说句话。
  // 列表不再靠"点一下刷新去拉 /api/rooms"：连接一建立服务端就把清单推过来，之后
  // 每有变动再推一次（有人建房 / 进人 / 开局）。轮询那一版的症状是"列表比现实慢半拍"，
  // 而玩家据此点下去的那一行可能已经开打了。
  showOnlineLobby() {
    // 守卫：未注册的人根本到不了这里（路由先拦，这行是第二道 —— 谁直接调它都回闸）。
    const A0 = this.game.account;
    if (A0.requireAccount && !A0.loggedIn) { this.showOnlineGate(); return; }
    this.setCam('lobby');
    const L = this.lobby, P = this.game.profile;
    const LB = this.game.lobby;          // 断线时它身上有 lost / lostReason（M9）
    const cls = P.classes[P.selClass || 0];
    const inp = 'width:100%;box-sizing:border-box;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.18);color:#eee;padding:7px 10px;font:inherit;letter-spacing:1px';
    const seg = (id, vals, labels, cur) => `<div class="seg" id="${id}">${vals.map((v, i) => `<div data-v="${v}" class="${cur == v ? 'sel' : ''}">${labels ? labels[i] : v}</div>`).join('')}</div>`;
    const r = this.render(`
      <div class="lobby">
        <div class="hdr">联网对战<small>服务器 ${esc(location.host)} · 在线 <span id="lbOnline">…</span></small></div>
        <div class="lobby-body">
          <div class="lobby-col lb-left">
            <div class="panel lb-rooms">
              <div class="lb-hd"><span>房间</span><span id="lbNote">正在进入大厅…</span><button class="btn small" id="lbRe" data-a="relobby" style="display:none">重新连接</button></div>
              <div id="lbRows" class="lb-rows"></div>
            </div>
            <div class="panel"><div class="opts">
              <div>建房 / 加入</div>
              <div style="display:flex;gap:8px"><input id="roomTitle" maxlength="24" placeholder="房间名（可留空）" value="${esc(L.title || '')}" style="${inp};flex:1;min-width:0"><button class="btn small" data-a="create">创建房间</button><button class="btn small ghost" data-a="quick">快速加入</button></div>
              <div>地图</div>${seg('segMap', MP_MAPS.map(m => m.id), MP_MAPS.map(m => m.name), L.map)}
              <div>模式</div>${seg('segMode', ONLINE_MODES.map(m => m.id), ONLINE_MODES.map(m => m.name), this.onlineMode())}
              <div>时长</div>${seg('segMin', MP_MINUTES, MP_MINUTES.map(v => v + ' 分'), L.minutes)}
              <div>目标</div>${seg('segScore', SCORES_ALL, SCORES_ALL.map(v => this.scoreLabel(v, this.onlineMode())), L.score)}
              <div class="note-wide" id="lbErr"></div>
            </div></div>
          </div>
          <div class="lobby-col lb-right">
            <div class="panel" id="idPanel"></div>
            <div class="panel">
              <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:8px">进场装备</div>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div><div style="font-size:18px;font-weight:800">${esc(cls.name)}</div><div style="font-size:12px;color:#aaa;margin-top:4px">${WEAPONS[cls.primary].name} · ${WEAPONS[cls.secondary].name}</div></div>
                <button class="btn small ghost" data-a="loadout">编辑</button>
              </div>
            </div>
            ${this.chatPanel('lobby', '全服频道')}
            <div class="lobby-foot"><button class="btn ghost" data-a="back">返回主菜单</button></div>
          </div>
        </div>
      </div>`, 'solid', 'online');
    // 模式与地图互相牵制（ridges 只在占领）：三行候选是渲染-once 的，这里按当前组合
    // 藏掉不收的项、迁移落选的偏好（图 / 目标），再把 sel 与目标行的"杀/分"后缀拨回
    // 真相 —— 与单机屏同一套"画全集 + 藏"的手法。点击任何一格后都要跑一遍。
    const syncSegs = () => {
      if (!mapAllowed(L.map, L.mode)) L.map = mapsForMode(L.mode)[0].id;
      if (!scoreOptions(L.mode).includes(L.score)) L.score = DEFAULT_SCORE_LIMIT(L.mode);
      const togg = (id, val, allow) => {
        const el = r.querySelector(`#${id} div[data-v="${val}"]`);
        if (el) el.style.display = allow ? '' : 'none';
      };
      for (const m of MP_MAPS) togg('segMap', m.id, mapAllowed(m.id, L.mode));
      for (const m of ONLINE_MODES) togg('segMode', m.id, mapAllowed(L.map, m.id));
      for (const v of SCORES_ALL) togg('segScore', v, scoreOptions(L.mode).includes(v));
      r.querySelectorAll('#segScore div').forEach(x => { x.textContent = this.scoreLabel(+x.dataset.v, L.mode); });
      for (const [id, val] of [['segMap', L.map], ['segMode', L.mode], ['segScore', L.score]])
        r.querySelectorAll(`#${id} div`).forEach(x => x.classList.toggle('sel', x.dataset.v === String(val)));
    };
    syncSegs();
    r.querySelectorAll('.seg').forEach(sg => sg.querySelectorAll('div').forEach(d => d.addEventListener('click', () => {
      const key = sg.id === 'segMap' ? 'map' : sg.id === 'segMode' ? 'mode' : sg.id === 'segScore' ? 'score' : 'minutes';
      L[key] = isNaN(+d.dataset.v) ? d.dataset.v : +d.dataset.v;
      sg.querySelectorAll('div').forEach(x => x.classList.toggle('sel', x === d));
      syncSegs();
    })));
    this.on(r, '[data-a=back]', () => this.leaveOnline());
    this.on(r, '[data-a=loadout]', () => this.showLoadouts('online'));
    this.on(r, '[data-a=quick]', () => this.onlineQuick());
    this.on(r, '[data-a=create]', () => this.onlineCreate());
    this.on(r, '[data-a=relobby]', () => this.onlineRelobby());
    this.bindChat(r, 'lobby');
    this.renderIdentity(r, L);
    this.renderRooms();
    this.renderChat(r, 'lobby');
    // 断线那一格（M9）：把「重新连接」摆出来。它是"零反馈"那件事的最后一环 ——
    // 只看得到"连接已断开"而没有任何出路的话，玩家能做的还是只有 F5。
    if (!LB || LB.lost) {
      const re = r.querySelector('#lbRe'); if (re) re.style.display = '';
      this.lobbyNote(r, LB ? '大厅连接已断开' : '还没连上大厅');
    }
    this.mountRecoveryPanel();   // 刚注册/刚重设的人：那一叠码补挂在这一屏顶端
    // 连接是这条路的入口：进不来就把原因写在这一屏上（而不是把人踢回主菜单 ——
    // 他什么都不知道，只会以为"这按钮点了没用"）。
    this.game.onlineLobby().then(() => { this.syncLobbyName(); }).catch(e => this.lobbyNote(r, '连不上大厅：' + (e && e.message || e)));
  }

  // 建房 / 快速加入：两条都是"进一间等待中的房"，区别只在于房号与设置归谁定。
  // 房名与房号是两格（中文房名当房号会被服务端洗成空串 → 悄悄进别人的房），
  // 所以房名安全字符时才拿它当房号，否则另生成一个。
  // 建房帧里的模式：夹到服务端兑现得了的那几个。this.lobby 那一格是单人对战与联机共用的
  // （map 也是），在单人里选了「占领」再过来建房，不夹这一句就会把「占领」发出去、
  // 换回一条玩家在联机界面上无从解释的拒绝。这里刻意不改 L.mode —— 那是别人的偏好，
  // 玩家回到单人对战时理应当看见他上次选的那个。
  onlineMode() { const m = this.lobby.mode; return ONLINE_MODES.some(x => x.id === m) ? m : ONLINE_MODES[0].id; }
  // 进房三件套共用的一道闸（M9）。三处各写一遍 `if (!lb.connected) return;` 的话，
  // 漏一处就是一条静默的"点了没反应"（更糟：那条路上还会盖上"正在进房…"的加载层，
  // 而它的唯一出路是 F5）—— 所以收成一个函数，并且**返回值**就是"这一帧发出去了吗"。
  lobbyAsk(fn) {
    const lb = this.game.lobby;
    if (!lb || !lb.connected) { this.onlineError('还没连上大厅，稍等一下（或点「重新连接」）'); return false; }
    if (fn && !fn(lb)) { this.onlineError('大厅连接刚刚断了，这一句没发出去'); return false; }
    return true;
  }
  // 房间屏上行的闸（与进房三件套的 lobbyAsk 同一族）：连接不在手上时，加 / 减 Bot、
  // 换队、准备、改设置、开始这些按钮原来全是静默丢帧 —— "点了没反应"那一族里最后
  // 几个没设闸的入口。LobbyClient 那几条上行现在都把"真的发出去了吗"交回来，这里统一问。
  roomAsk(fn) {
    const lb = this.game.lobby;
    if (!lb || !lb.connected) { this.onlineError('还没连上大厅，稍等一下（或点「重新连接」）'); return; }
    if (!fn(lb)) this.onlineError('大厅连接刚刚断了，这一下没发出去');
  }
  // 重连大厅：扔掉断了的那条连接，重新走一遍 onlineLobby()。**不刷新页面** ——
  // 这一页上还有房名、地图、装备选择与聊天框里没发完的字，F5 会把它们全丢掉。
  onlineRelobby() {
    const g = this.game;
    if (g.lobby) { g.lobby.close(); g.lobby = null; }   // close() 会立 _closing ⇒ 不再报一次"断开"
    this.showLoadingOverlay('正在重新进入大厅…');
    Promise.resolve(g.onlineLobby())
      .then(() => this.showOnlineLobby())
      .catch(e => { this.showOnlineLobby(); this.onlineError('还是连不上：' + ((e && e.message) || e)); });
  }
  onlineCreate() {
    const L = this.lobby;
    const title = String((this.el.querySelector('#roomTitle') || {}).value || '').trim().slice(0, 24);
    L.title = title;
    this.syncLobbyName();
    const safe = title.replace(/[^A-Za-z0-9_.-]/g, '');
    const room = (safe && safe === title) ? title.slice(0, 32) : ('r' + Date.now().toString(36).slice(-6));
    // 发帧前先过闸：没连上**不许**盖那一层"正在进房…"（盖了就没人再把它收掉了）。
    if (!this.lobbyAsk(lb => lb.createRoom({ room, title, map: L.map, mode: this.onlineMode(), minutes: L.minutes, scoreLimit: L.score }))) return;
    this.game.showRoomSoon();
  }
  onlineQuick() {
    const lb = this.game.lobby; if (!lb) return;
    this.syncLobbyName();
    // 没连上时**先拦在这里**：`lb.rooms` 这时候是空的，下面那段"本台有没有可进的房"
    // 会一路判到 quickRoom —— 而那一帧发不出去，症状与点「创建房间」一模一样。
    if (!this.lobbyAsk()) return;
    // 快速加入的偏好顺序：本台有可进的等待房 → 交给服务端的 quick（它挑本台的）；
    // 本台没有而目录里登记了别台的房 → 跨台加入；都没有 → 本台新建（原行为）。
    // 让服务端先挑本台是刻意的：少一次换台的连接抖动，玩家对"我在哪台"也少一次困惑。
    const localJoinable = (lb.rooms || []).some(x => !x.remote && x.state === 'waiting' && x.players < x.max);
    if (!localJoinable) {
      const row = (lb.rooms || []).find(x => x.remote && x.url && x.state === 'waiting' && x.players < x.max);
      if (row) { this.remoteJoin(row); return; }
    }
    if (!this.lobbyAsk(x => x.quickRoom({ title: '', map: this.lobby.map, mode: this.onlineMode(), minutes: this.lobby.minutes, scoreLimit: this.lobby.score }))) return;
    this.game.showRoomSoon();
  }
  onlineJoin(room, title) {
    const lb = this.game.lobby; if (!lb) return;
    this.syncLobbyName();
    // 远端行（房间目录里别台的房）：走跨台那条路 —— row.url 告诉我们该连哪台。
    const row = (lb.rooms || []).find(x => x.id === room);
    if (row && row.remote && row.url) { this.remoteJoin(row); return; }
    if (!this.lobbyAsk(x => x.joinRoom(room))) return;
    this.game.showRoomSoon();
  }
  // 跨台加入：换台 = 换一条连接（大厅 → 房间 → 对局 都在同一条 ws 上，这是
  // js/net/lobby.mjs 写定的前提，换台就必须换连接，旧连接上的座位/房间状态随之作废）。
  // 要账号的服先向**本台**要一张跨台入场票（本台验过会话，目标台不认识本台的 cookie ——
  // 账号账本进程私有）；访客服不设闸，直接连。
  async remoteJoin(row) {
    const A = this.game.account;
    let q = '';
    if (A.requireAccount) {
      let j = null;
      try {
        const r = await fetch('/api/dispatch', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room: row.id, url: row.url }) });
        j = await r.json();
      } catch { /* 落到下面的统一报错 */ }
      if (!j || !j.ok) { this.onlineError((j && j.message) || '拿不到跨台入场券'); return; }
      if (j.ticket) q = '?ticket=' + encodeURIComponent(j.ticket);
    }
    const wsUrl = String(row.url).replace(/^http/, 'ws') + '/ws' + q;
    try { await this.game.onlineLobby(wsUrl); }
    catch (e) { this.onlineError('连不上另一台：' + (e && e.message || e)); return; }
    this.game.lobby.joinRoom(row.id);
    this.game.showRoomSoon();
  }
  // 呼号：要账号的服上它是服务端给的（renderIdentity 那一格只显示、不填），
  // 访客可玩的服上它是这一局的显示名。两种情况都盖到 LobbyClient 身上，
  // 因为"我叫什么"只有服务端说了算的那一份 —— 客户端这里只是个副本。
  syncLobbyName() {
    const lb = this.game.lobby; if (!lb) return;
    const el = this.el.querySelector('#onName');
    if (el) this.lobby.name = String(el.value || '').trim().slice(0, 16) || this.lobby.name;
    lb.name = this.game.account.loggedIn ? (this.game.account.user || {}).name || lb.name : this.lobby.name;
  }
  lobbyNote(root, msg) {
    const n = root && root.querySelector('#lbNote');
    if (n) n.textContent = msg;
  }
  // 列表画的是**服务端推来的那一份**（game.lobby.rooms）。空表有两种完全不同的意思
  // —— "还没连上"和"连上了但没人建房"，所以文案分开写，别都写成"暂无房间"。
  renderRooms() {
    const rows = this.el.querySelector('#lbRows');
    if (!rows || this.screen !== 'online') return;
    const lb = this.game.lobby;
    const note = this.el.querySelector('#lbNote'), on = this.el.querySelector('#lbOnline');
    if (on) on.textContent = lb ? String(lb.online) : '—';
    // 「重新连接」跟着连接的**真相**走，不跟着"进这一屏的那一瞬间"走：首次进大厅时
    // 连接还没建起来，showOnlineLobby 把它亮出来，此后连上了没有任何一处收回去 ——
    // 一个常亮的重连按钮是在宣称"连接是断的"。这里是这一屏唯一每次推送都过的地方。
    const re = this.el.querySelector('#lbRe');
    if (re) re.style.display = (lb && lb.connected && !lb.lost) ? 'none' : '';
    if (!lb || !lb.connected) {
      // 三种状态三句话（M9）：「断线了」说成「正在进入大厅…」是一句会一直说下去的谎，
      // 而这一行是玩家唯一能看到"发生了什么、接下来该干嘛"的地方。lost 由 LobbyClient 的
      // onclose 立起来（改动前那一格根本不存在，所以这里只能一直画"正在进入大厅…"）。
      rows.innerHTML = (lb && lb.lost)
        ? `<div class="note-wide">大厅连接已断开${lb.lostReason ? '：' + esc(lb.lostReason) : ''} · 点右上角「重新连接」</div>`
        : '<div class="note-wide">正在进入大厅…</div>';
      return;
    }
    const list = lb.rooms || [];
    if (note) note.textContent = list.length + ' 间';
    if (!list.length) { rows.innerHTML = '<div class="note-wide">还没有房间 · 起一间，或点快速加入</div>'; return; }
    rows.innerHTML = list.map(x => {
      const map = MP_MAPS.find(m => m.id === x.map) || { name: x.map };
      const mode = MP_MODES.find(m => m.id === x.mode) || { name: x.mode };
      const playing = x.state === 'playing';
      const full = x.players >= x.max;
      const can = !playing && !full;
      return `<div class="room-row ${can ? '' : 'off'}">
        <div class="rr-name">${esc(x.title)}</div>
        <div class="rr-meta">${esc(map.name)} · ${esc(mode.name)} · ${x.time || 10} 分${x.remote ? ' · 另一台' : ''}</div>
        <div class="rr-n">${x.players | 0}/${x.max | 0}</div>
        <div class="rr-state">${playing ? '对局中' : (full ? '已满' : (x.ready | 0) + ' 已准备')}</div>
        <button class="btn small ${can ? '' : 'ghost'}" data-a="joinRow" data-room="${esc(x.id)}" ${can ? '' : 'disabled'}>${playing ? '观战不了' : '加入'}</button>
      </div>`;
    }).join('');
    this.on(rows, '[data-a=joinRow]', el => { if (!el.disabled) this.onlineJoin(el.dataset.room); });
  }
  // 离开联机这一层：连接是这一层唯一的真相来源，回主菜单就把它拆掉。
  // 不拆的症状是"人已经在主菜单了，聊天还在往里灌、房间里还占着一个座位"。
  leaveOnline() {
    const lb = this.game.lobby;
    if (lb) { lb.close(); this.game.lobby = null; }
    this._recovPending = null;   // 离开这一层就丢弃：留着的话下次进大厅会摆出一叠早就作废的码
    this.showMain();
  }

  // ── 聊天框（大厅与房间共用一份外壳，只是频道不同）──
  chatPanel(ch, label) {
    const id = ch === 'lobby' ? 'lbChat' : 'rmChat';
    const inp = ch === 'lobby' ? 'lbSay' : 'rmSay';
    return `<div class="panel chat-box">
      <div class="lb-hd"><span>${esc(label)}</span></div>
      <div id="${id}" class="chat-lines"></div>
      <div class="chat-in"><input id="${inp}" maxlength="120" placeholder="说点什么…（/w 私聊 · /emote 表情 · /mute 屏蔽 · /report 举报）" autocomplete="off"><button class="btn small ghost" data-a="say">发送</button></div>
    </div>`;
  }
  bindChat(root, ch) {
    const box = root.querySelector(ch === 'lobby' ? '#lbChat' : '#rmChat');
    if (!box) return;
    const inp = root.querySelector(ch === 'lobby' ? '#lbSay' : '#rmSay');
    const btn = box.parentElement.querySelector('[data-a=say]');
    const fire = () => {
      const lb = this.game.lobby; if (!lb) return;
      // 命令与发言走同一个框（差距 45）：/mute /unmute /muted 是本地的屏蔽名单，
      // /report 要上行记档。判定在 js/net/chat.mjs —— 对局内的聊天框认的是同一套词。
      const cmd = parseChatCommand(String(inp.value || ''));
      inp.value = '';
      const g = this.game;
      if (cmd.op === 'say') { if (cmd.text) lb.say(ch, cmd.text); return; }
      if (cmd.op === 'mute' || cmd.op === 'unmute') {
        g.profile.muted = toggleMute(g.profile.muted, cmd.name, cmd.op === 'mute');
        if (g.saveProfile) g.saveProfile();
        this.localChat(ch, cmd.op === 'mute'
          ? `已屏蔽「${cmd.name}」，他的话不再显示（/unmute ${cmd.name} 可恢复）`
          : `已解除对「${cmd.name}」的屏蔽`);
      } else if (cmd.op === 'muted') {
        const list = (g.profile && g.profile.muted) || [];
        this.localChat(ch, list.length ? '当前屏蔽：' + list.join('、') : '当前没有屏蔽任何人');
      } else if (cmd.op === 'report') {
        if (cmd.name === lb.name) this.localChat(ch, '不能举报自己');
        else { lb.send({ t: 'report', name: cmd.name, reason: cmd.reason }); this.localChat(ch, `正在举报「${cmd.name}」…`); }
      } else if (cmd.op === 'whisper') {
        // 私聊与表情的裁决全在服务端（找不找得到人、表情是不是白名单里的），这里只转交
        if (cmd.text) lb.send({ t: 'say', ch: 'whisper', to: cmd.name, text: cmd.text.slice(0, 120) });
      } else if (cmd.op === 'emote') {
        lb.send({ t: 'say', ch: 'emote', emote: cmd.name });
      } else {
        this.localChat(ch, `不认得命令「${cmd.text}」——可用：/w 私聊 · /emote 表情 · /mute /unmute /muted · /report`);
      }
    };
    if (btn) btn.addEventListener('click', fire);
    // 回车发送、Esc 只关这个输入框 —— 菜单屏上的输入框拿到焦点时，那些按键
    // 不该再被游戏那套快捷键接走（Tab 的 preventDefault 在 main.js 里，见它那段）。
    if (inp) inp.addEventListener('keydown', e => {
      e.stopPropagation();
      // 输入法保护：中文/日文选词时的回车是"上屏"，不是"发送"。isComposing 是标准信号，
      // keyCode 229 是部分旧 IME/浏览器唯一的回退信号。少这一句就会把半成品发出去 ——
      // 而"打一句中文发出去变成一串拼音"这种问题，玩家只会怪自己手快。
      if (isImeKey(e)) return;
      if (e.key === 'Enter') { e.preventDefault(); fire(); }
    });
  }
  // 聊天行**只往容器里追加**，不整块重画：重画会把人正打到一半的输入框和滚动位置一起抹掉。
  renderChat(root, ch) {
    const box = root.querySelector(ch === 'lobby' ? '#lbChat' : '#rmChat');
    if (!box) return;
    const lb = this.game.lobby;
    const rows = ch === 'lobby' ? (lb ? lb.chat : []) : ((lb && lb.state && lb.state.chat) || []);
    box.innerHTML = rows.slice(-40).map(x => this.chatLine(x)).join('');
    box.scrollTop = box.scrollHeight;
  }
  chatLine(x) {
    // 渲染（含时间戳与屏蔽过滤）在 js/net/chat.mjs:chatRowHtml —— 与对局 HUD 共用一份，
    // 免得"大厅里有时间戳、对局里没有"这种只在两个界面之间才看得见的差异又长出来。
    const lb = this.game.lobby;
    const me = lb && lb.state && lb.state.me;
    // "我这行"认 **sid**（服务端在房间频道那一行特意带的），名字只做没有 sid 那些行
    // （全服频道 / 私聊回执）的退路：访客服上两条"士兵"同名，按名字认会把别人的行
    // 高亮成我的 —— 服务端留 sid 这一格正是为了这个。
    const mine = !!(me && (x.sid != null ? x.sid === me.sid : x.from && x.from === me.name));
    return chatRowHtml(x, { mine, muted: (this.game.profile && this.game.profile.muted) || [] });
  }
  pushChat(root, ch, row) {
    const box = root.querySelector(ch === 'lobby' ? '#lbChat' : '#rmChat');
    if (!box) return;
    const html = this.chatLine(row);
    if (!html) return;                      // 被屏蔽的人：一行都不画（过滤点在 chatRowHtml）
    box.insertAdjacentHTML('beforeend', html);
    while (box.children.length > 40) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  // 本地回执（/mute /report 的结果）：只进自己这台机器的聊天条，不是发言、不上行。
  // 进**缓冲**而不只是 DOM：hist 一到就整块重画（renderChat），只画 DOM 的话回执会被抹掉。
  localChat(ch, text) {
    const lb = this.game.lobby;
    const row = { ch, sys: true, text, at: Date.now() };
    const buf = ch === 'lobby' ? (lb && lb.chat) : (lb && lb.state && lb.state.chat);
    if (buf) { buf.push(row); if (buf.length > 60) buf.shift(); }
    this.pushChat(this.el, ch, row);
  }
  // 服务端那句拒绝画在**当前那一屏**上。它不翻译、不复述（和注册闸同一个规矩）：
  // "邀请码不对"和"服务器忙"如果被揉成同一句"失败了"，服主永远收不到真问题。
  onlineError(msg) {
    // 正在进房的那一层是"加载"屏，它没有地方画这句话 —— 不先退回大厅，人就会被
    // 永久卡在"正在进房…"上（拒绝恰恰是最需要让人看见的一种结果）。
    if (this.game._wantRoom) { this.game._wantRoom = false; this.showOnlineLobby(); }
    const el = this.el.querySelector(this.screen === 'onlineRoom' ? '#rmErr' : '#lbErr');
    if (el) { el.textContent = msg || ''; clearTimeout(this._errT); this._errT = setTimeout(() => { el.textContent = ''; }, 6000); }
  }
  // ── 联机第四层：房间 ──
  // 这一屏只干一件事：凑人、准备、由房主按下开始。
  // 界面**不自己判**"能不能开始" —— canStart/why 是服务端算好随状态一起推过来的那一格。
  // 两边各判一次的版本必然会对不上（按钮能点而服务端说不能开，或反过来永远点不动），
  // 而对不上的症状又是一句不报错的"点了没反应"。
  showOnlineRoom() {
    const lb = this.game.lobby, st = lb && lb.state;
    if (!st || !st.me) { this.showOnlineLobby(); return; }      // 不在任何房里就别画房间
    this.setCam('lobby');
    const r = this.render(`
      <div class="lobby rm">
        <div class="hdr"><span id="rmTitle">房间</span><small id="rmMeta"></small></div>
        <div class="lobby-body">
          <div class="lobby-col team-col">
            <div class="team-hd">A 队<span id="nA" class="th-n"></span></div>
            <div id="seatA" class="seats"></div>
            <div class="team-btns">
              <button class="btn small ghost" data-a="toA">换到 A 队</button>
              <button class="btn small ghost" data-a="addA">+ Bot</button>
            </div>
          </div>
          <div class="lobby-col rm-mid">
            <div class="panel" id="rmCfg"></div>
            ${this.chatPanel('room', '房间频道')}
            <div class="note-wide" id="rmErr"></div>
          </div>
          <div class="lobby-col team-col">
            <div class="team-hd b">B 队<span id="nB" class="th-n"></span></div>
            <div id="seatB" class="seats"></div>
            <div class="team-btns">
              <button class="btn small ghost" data-a="toB">换到 B 队</button>
              <button class="btn small ghost" data-a="addB">+ Bot</button>
            </div>
          </div>
        </div>
        <div class="rm-foot">
          <button class="btn ghost" data-a="leave">离开房间</button>
          <button class="btn ghost" data-a="loadout">编辑配装</button>
          <button class="btn" data-a="ready">准备</button>
          <button class="btn go" data-a="start">开始游戏</button>
          <span id="rmWhy"></span>
        </div>
      </div>`, 'solid', 'onlineRoom');
    this.on(r, '[data-a=leave]', () => this.roomLeave());
    this.on(r, '[data-a=loadout]', () => this.showLoadouts('onlineRoom'));
    this.on(r, '[data-a=ready]', () => this.roomReady());
    this.on(r, '[data-a=start]', () => this.roomAsk(l => l.start()));
    this.on(r, '[data-a=toA]', () => this.roomTeam('A'));
    this.on(r, '[data-a=toB]', () => this.roomTeam('B'));
    this.on(r, '[data-a=addA]', () => this.roomAddBot('A'));
    this.on(r, '[data-a=addB]', () => this.roomAddBot('B'));
    // Bot 那一行点一下就移除。**必须委托**而不能用 on()：名单是 renderRoom 每次推送
    // 都整块重画的，而 on() 是绑定时一次性查询 —— 绑这一行的时候座位栏还是空壳，
    // 监听器一个都落不到后来才长出来的 Bot 行上，症状就是"点了没反应"（服务端判据
    // 与计数全是通的，room-flow/room-bots 走协议，也盖不到这根 DOM 线）。
    // 只对房主、且只在等待态放行：对局中服务端拒得静默，按钮文案也已经收了。
    r.addEventListener('click', (e) => {
      const el = e.target.closest('.seat[data-bid]');
      if (el) this.roomDelBot(+el.dataset.bid);
    });
    this.bindChat(r, 'room');
    this.renderRoom();
    this.renderChat(r, 'room');
    // 回到这一屏时把当前配装再交一次：很可能是刚从"编辑装备"回来的，而服务端只在
    // 开局那一刻读座位上的那一份（少这一句的症状就是"改了枪没带上"）。
    if (lb && lb.state && lb.state.me) lb.ready(!!lb.state.me.ready);
  }
  // 服务端一推新状态就重画这一屏。**只改文字与按钮**，不重建整棵子树 ——
  // 重建会把聊天输入框里打到一半的字和滚动位置一起抹掉（那正是"打字时被顶回去"）。
  renderRoom() {
    const lb = this.game.lobby, st = lb && lb.state;
    if (!st || this.screen !== 'onlineRoom') return;
    const room = st.room || {}, me = st.me || {}, seats = st.seats || [], bots = st.bots || [];
    const map = MP_MAPS.find(m => m.id === room.map) || { name: room.map };
    const mode = MP_MODES.find(m => m.id === room.mode) || { name: room.mode };
    const playing = room.state === 'playing';
    const t = this.el.querySelector('#rmTitle'); if (t) t.textContent = room.title || room.id;
    const mt = this.el.querySelector('#rmMeta');
    // Bot 占位置，所以人数那一格要把它们算进去；另写一个"N Bot"，否则一间 1 人 + 7 Bot
    // 的房在标题上写着 8 人，点进去只看见一个人 —— 那看起来像列表算错了。
    if (mt) mt.textContent = `${map.name} · ${mode.name} · ${room.score || 50}${room.mode === 'dom' ? ' 分' : ' 杀'} · ${room.time || 10} 分 · ${room.players || seats.length}/${room.max || 16} 人`
      + (bots.length ? `（${bots.length} Bot）` : '') + ` · 房主 ${room.host || '—'}`;
    const per = Math.max(2, Math.floor((room.max || 16) / 2));
    // 座位栏上的等级读的是**服务端发来**的 `s.xp`（账号那一半），不混本地那份：
    // 这一屏看的是别人，别人机器上的战役经验我这儿不可能有，同一张表里两个来源就乱了。
    // 所以这里的等级与档案卡（两半之和）在"本地也挣过"的人身上会差一级，这是有意的。
    const row = (s) => `<div class="seat ${s.ready ? 'rd' : ''} ${s.isHost ? 'host' : ''}">
      <span class="s-tag">${s.isHost ? '房主' : (s.ready ? '✔' : '·')}</span>
      <span class="s-name">${esc(s.name)}</span>
      <span class="s-lv">${s.xp ? 'Lv ' + (levelOf(s.xp)) : ''}</span>
      <span class="s-st">${s.isHost ? '随时可开' : (s.ready ? '已准备' : '等待中')}</span>
    </div>`;
    // Bot 那一行：房主点一下移除，所以它是可点的（data-bid），并且写明"点击移除" ——
    // 一行看着和真人一模一样的名单，玩家没有任何办法知道哪个能点。
    const botRow = (b) => `<div class="seat bot" data-bid="${b.bid}">
      <span class="s-tag">Bot</span>
      <span class="s-name">${esc(b.name)}</span>
      <span class="s-lv">${BOT_SKILL_NAMES[b.skill | 0] || ''}</span>
      <span class="s-st">${me.isHost && !playing ? '点击移除' : ''}</span>
    </div>`;
    const blank = () => '<div class="seat empty"><span class="s-tag">·</span><span class="s-name">空位</span><span class="s-st"></span></div>';
    for (const team of ['A', 'B']) {
      const box = this.el.querySelector(team === 'A' ? '#seatA' : '#seatB');
      const list = seats.filter(s => s.team === team).map(row);
      const bl = bots.filter(b => b.team === team).map(botRow);
      const all = list.concat(bl);
      const n = this.el.querySelector(team === 'A' ? '#nA' : '#nB');
      if (n) n.textContent = `${all.length}/${per}`;
      if (box) box.innerHTML = all.join('') + blank().repeat(Math.max(0, Math.min(per, Math.max(3, all.length + 1)) - all.length));
      // 加 Bot 那个按钮只画给房主，且对局开始之后不能再加（服务端也会拒，
      // 但把按钮留在那儿就是"能点但没反应"）。
      const ab = this.el.querySelector(team === 'A' ? '[data-a=addA]' : '[data-a=addB]');
      if (ab) ab.style.display = (me.isHost && !playing) ? '' : 'none';
    }
    const rb = this.el.querySelector('[data-a=ready]');
    if (rb) {
      const hide = me.isHost || playing;
      rb.style.display = hide ? 'none' : '';
      rb.textContent = me.ready ? '取消准备' : '准备';
    }
    const sb = this.el.querySelector('[data-a=start]');
    if (sb) {
      sb.style.display = me.isHost ? '' : 'none';
      sb.disabled = !st.canStart || playing;
      sb.style.opacity = sb.disabled ? .45 : 1;
      sb.textContent = playing ? '对局进行中…' : '开始游戏';
    }
    const why = this.el.querySelector('#rmWhy');
    if (why) why.textContent = playing ? '所有人已进入对局。' : (me.isHost ? (st.canStart ? '人都准备好了，可以开始。' : st.why || '') : (me.ready ? '已准备，等房主开始。' : st.why || '还没准备。'));
    // 房主改设置那一格：非房主只读（改了也不会生效，摆成能编辑的样子就是骗人）。
    const cfg = this.el.querySelector('#rmCfg');
    if (cfg) {
      const seg = (id, vals, labels, cur, dis) => `<div class="seg ${dis ? 'dis' : ''}" id="${id}">${vals.map((v, i) => `<div data-v="${v}" class="${cur == v ? 'sel' : ''}" data-dis="${dis ? 1 : 0}">${labels ? labels[i] : v}</div>`).join('')}</div>`;
      // 三行"标签 + 选择器"，不用 .opts 那个 110px 标签列的两列网格：那一列是给
      // 大厅那种宽栏设计的，塞进房间中间这一栏（约 300 px）之后四张地图名被挤成竖排单字。
      const row = (label, id, vals, labels, cur) => `<div class="cfg-row"><span>${label}</span>${seg(id, vals, labels, cur, !me.isHost || playing)}</div>`;
      // 模式牵制地图、地图也牵制模式（ridges 只在占领）：候选都按当前组合滤过。这一整块
      // innerHTML 随每次房间状态推着重画（监听器跟着重挂），直接滤候选表就行，不需要
      // 别处那套"画全集 + 藏"。服务端（server/lobby.mjs:mapGate）是后盾：绕过界面
      // 发帧的组合会被当场拒掉，而不是悄悄换掉一边。
      const roomMaps = MP_MAPS.filter(m => mapAllowed(m.id, room.mode));
      const roomModes = ONLINE_MODES.filter(m => mapAllowed(room.map, m.id));
      cfg.innerHTML = `<div class="lb-hd"><span>${me.isHost ? '房间设置' : '本局设置'}</span><span>${me.isHost ? '改动立刻随列表广播' : '由房主决定'}</span></div>`
        + row('地图', 'rmMap', roomMaps.map(m => m.id), roomMaps.map(m => m.name), room.map)
        // 只有一种玩法可选时不画选择器：一个撑满整行的亮块看着像"还能点出别的"，
        // 而它其实是一句陈述。id 两边同名，判据不必跟着形状改。
        + (roomModes.length > 1
          ? row('模式', 'rmMode', roomModes.map(m => m.id), roomModes.map(m => m.name), room.mode)
          : `<div class="cfg-row"><span>模式</span><div class="cfg-one" id="rmMode">${esc((roomModes[0] || mode).name)}</div></div>`)
        + row('时长', 'rmMin', MP_MINUTES, MP_MINUTES.map(v => v + ' 分'), room.time || 10)
        // 胜利目标，档位按模式换表（js/data.js:scoreOptions）。候选值的这一行是 300 px
        // 窄栏里最挤的一行 —— "150 杀"这种双字后缀会把它顶出面板边框（nowrap 不许折行，
        // flex 也不许缩过内容宽）。所以这一行只写数字："是击杀还是占领分"由行标签与
        // 上面那行 meta（"150 杀 · …"）说。
        + row('目标', 'rmScore', scoreOptions(room.mode), scoreOptions(room.mode).map(String), room.score || 50)
        // Bot 难度。改一格**全体 Bot 一起变**（服务端那条注释写了为什么不做成逐个改），
        // 所以这一行只在房里真有 Bot 时才画 —— 空房子里摆一个 Bot 难度选择器，
        // 玩家会以为"选了就会自动加 Bot"。
        + (bots.length ? row('Bot', 'rmBot', BOT_SKILLS, BOT_SKILL_NAMES, st.botSkill | 0) : '')
        // 补人（房主的开关）：开着的时候这一间永远是满的，人走了补 Bot、人来了 Bot 让位。
        // 这一行**不管房里有没有 Bot 都要画** —— 难度那一行要等有 Bot 才画，补人这一行要是
        // 也等，就没人能在这个房里造出第一个 Bot 来了（自己把自己锁在门外）。
        + row('补人', 'rmFill', [0, 1], ['手动', '补满'], st.fill ? 1 : 0);
      cfg.querySelectorAll('.seg div[data-dis="0"]').forEach(d => d.addEventListener('click', () => {
        const sg = d.parentElement, v = isNaN(+d.dataset.v) ? d.dataset.v : +d.dataset.v;
        const key = sg.id === 'rmMap' ? 'map' : sg.id === 'rmMode' ? 'mode' : sg.id === 'rmScore' ? 'scoreLimit' : sg.id === 'rmBot' ? 'botSkill' : sg.id === 'rmFill' ? 'fill' : 'minutes';
        this.roomAsk(l => l.setCfg({ [key]: v }));
      }));
    }
  }
  roomReady() {
    const lb = this.game.lobby, st = lb && lb.state; if (!st || !st.me) return;
    this.roomAsk(l => l.ready(!st.me.ready));
  }
  roomTeam(team) {
    this.roomAsk(l => l.setTeam(team));
  }
  roomAddBot(team) {
    this.roomAsk(l => l.addBot(team));
  }
  roomDelBot(bid) {
    const lb = this.game.lobby, st = lb && lb.state;
    if (!lb || !st || !st.me || !st.me.isHost) return;
    if (st.room && st.room.state === 'playing') return;   // 对局中封盘：服务端同判，且拒得静默
    this.roomAsk(l => l.removeBot(bid));
  }
  roomLeave() {
    const lb = this.game.lobby; if (lb) lb.leaveRoom();
    this.game._wantRoom = false;
    this.showOnlineLobby();
  }

  // 主菜单上"联网对战"那一项的锁标。规则：**未完成注册前联网对战不开放** ——
  // 但"不开放"不等于"藏起来"：入口照旧在、点得进（落在注册页），只是写明 🔒 需注册。
  // 判定跟服务端策略走（/api/status 的 requireAccount）：显式配了 REQUIRE_ACCOUNT=0 的
  // 访客可玩服是服主明说的"这台不用注册"，那不是漏检。改这里改不动权限 ——
  // 真正的闸在服务端（/api/rooms 的 401 与 WS 握手的 401），这里只是把同一件事显示出来。
  updateOnlineEntry() {
    const btn = this.el.querySelector('[data-a=online]');
    if (!btn) return;
    const A = this.game.account;
    const locked = !!(A && A.statusKnown && A.requireAccount && !A.loggedIn);
    btn.classList.toggle('locked', locked);
    const md = btn.querySelector('.md');
    // 锁态与开放态的差别只在"多一道前置"，后半句保持不变 —— 一眼能看出锁的是注册这件事。
    if (md) md.textContent = locked ? '🔒 需注册 · 真人在线对局' : '真人在线对局';
  }

  acctMsg(root, text) {
    const el = root.querySelector('#acctMsg');
    if (el) el.textContent = text || '';
  }

  // 大厅里的"我是谁"。**它是状态卡，不是表单** —— 注册/登录在上一层（闸）办完，
  // 大厅里再摆一整块登录表单，层级就又平了：玩家会以为"进了大厅还要再登一次录"，
  // 而两个焦点同屏时谁也不是重点（这正是本轮要拆掉的东西）。
  // 两种形态，都由**服务端说的策略**决定（/api/status 的 requireAccount）：
  //   · 已登录   —— 账号卡（呼号 / 经验 / 场次 / 胜 / 登出）；登出 = 退回闸那一屏。
  //   · 访客可玩 —— 一个呼号框（REQUIRE_ACCOUNT=0）。这不是"偷懒的降级"，而是必须的：
  //     那种服上玩家**根本没有账号可填**，摆个登录框等于把"这里不需要密码"说成
  //     "你密码打错了"（错误信息还是"呼号或密码不对"，他会去怀疑自己密码打错了）。
  // 登录之后呼号输入框就消失了 —— 那时呼号由服务端说（welcome.name 覆盖本地那份）。
  // 留一个改不动的框在那儿，等于骗玩家说"这里能改名字"。
  renderIdentity(root, L) {
    const box = root.querySelector('#idPanel');
    if (!box) return;
    const A = this.game.account;
    const inp = 'width:100%;box-sizing:border-box;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.18);color:#eee;padding:7px 10px;font:inherit;letter-spacing:1px';

    if (A.loggedIn) {
      const p = A.user;
      box.innerHTML = `<div class="opts"><div>身份</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div><b style="letter-spacing:2px">${esc(p.name)}</b>
            <span style="color:#999;font-size:12px;margin-left:8px">经验 ${p.xp | 0} · 场次 ${p.matches | 0} · 胜 ${p.wins | 0}</span></div>
          <button class="btn small ghost" data-a="logout">登出</button>
        </div>
        <div class="note-wide">数据保存在服务器。</div>
      </div>`;
      this.on(box, '[data-a=logout]', async () => {
        // 连接要跟着身份一起断：它是**握手那一刻验过会话**才建立的，登出之后还留着，
        // 这人就一边"已经登出"一边继续收全服聊天、继续在房间里占一个座位。
        // 关掉的代价只是回大厅时重连一次（onlineLobby 自己会重建）。
        if (this.game.lobby) { this.game.lobby.close(); this.game.lobby = null; }
        this.game._wantRoom = false;
        this._recovPending = null;   // 登出即作废：那一叠码属于刚才那个身份
        await A.logout();
        this.showOnlineGate();   // 层级：身份没了就回闸 —— 大厅不给没身份的人看
      });
      return;
    }

    if (!A.requireAccount) {
      // 访客可玩：一个呼号框（这一局的显示名），没有密码、没有邀请码。
      box.innerHTML = `<div class="opts"><div>呼号</div>
        <input id="onName" maxlength="16" placeholder="2-16 个字符" value="${esc(L.name || '士兵')}" style="${inp}">
        <div class="note-wide">免注册服务器：呼号仅用于本局显示，战绩不保存。</div>
      </div>`;
      return;
    }

    // 走到这里 = "要账号却没登录"：按层级他不该在大厅（守卫早该把人送进闸）。
    // 别装作没事 —— 给一个明确的去处，而不是一块空白面板。
    box.innerHTML = `<div class="opts"><div>身份</div>
      <div style="font-size:12px;color:#e6a8c8">需要账号才能查看房间列表。</div>
      <div class="note-wide"><button class="btn small" data-a="toGate">去注册 / 登录</button></div>
    </div>`;
    this.on(box, '[data-a=toGate]', () => this.showOnlineGate());
  }

  perk(id) { for (const col of PERKS) for (const p of col) if (p.id === id) return p; return { name: id, desc: '', icon: '' }; }

  // ---------------- 配装 ----------------
  showLoadouts(from) {
    this.loadoutFrom = from || this.loadoutFrom || 'main';
    this.setCam('loadout');
    const P = this.game.profile;
    const ci = this.selClass;
    const c = P.classes[ci];
    this.setSoldier(c);
    const attNames = (id, att) => Object.entries(att || {}).map(([s, a]) => (findAttachment(s, a) || {}).name).filter(Boolean).join(' · ') || '无配件';
    const L = LETHALS.find(x => x.id === c.lethal), T = TACTICALS.find(x => x.id === c.tactical);
    const streaks = P.streaks.map(id => KILLSTREAKS.find(k => k.id === id)).sort((a, b) => a.kills - b.kills);
    const r = this.render(`
      <div class="loadout">
        <div class="hdr">武器装备<small>自定义配装 · ${P.selClass === ci ? '当前使用中' : '未装备'}</small></div>
        <div style="display:flex;gap:24px;margin-top:26px;flex:1;min-height:0">
          <div class="classes">${P.classes.map((k, i) => `<div class="cls ${i === ci ? 'sel' : ''}" data-i="${i}">${esc(k.name)}${i === P.selClass ? ' <span style="color:var(--acc)">●</span>' : ''}<small>${WEAPONS[k.primary].name} · ${WEAPONS[k.secondary].name}</small></div>`).join('')}
            <div style="margin-top:14px;display:flex;flex-direction:column;gap:8px">
              <button class="btn small" data-a="equip" ${P.selClass === ci ? 'disabled style="opacity:.5"' : ''}>设为当前配装</button>
              <button class="btn small ghost" data-a="rename">重命名</button>
            </div>
          </div>
          <div class="cls-detail" style="max-width:640px">
            <div class="slotc" data-s="primary"><div class="sl">主武器 · ${WEAPONS[c.primary].cls}</div><div class="sv">${WEAPONS[c.primary].name}</div><div class="ss">${attNames(c.primary, c.patt)}</div><div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" data-g="primary">枪匠</button><button class="btn small ghost" data-w="primary">更换武器</button></div></div>
            <div class="slotc" data-s="secondary"><div class="sl">副武器 · ${WEAPONS[c.secondary].cls}</div><div class="sv">${WEAPONS[c.secondary].name}</div><div class="ss">${attNames(c.secondary, c.satt)}</div><div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" data-g="secondary">枪匠</button><button class="btn small ghost" data-w="secondary">更换武器</button></div></div>
            <div class="slotc" data-p="lethal"><div class="sl">致命装备</div><div class="sv">${L ? L.name : '无'}</div><div class="ss">${L ? L.desc : ''}</div></div>
            <div class="slotc" data-p="tactical"><div class="sl">战术装备</div><div class="sv">${T ? T.name : '无'}</div><div class="ss">${T ? T.desc : ''}</div></div>
            <div class="slotc wide" data-p="perks"><div class="sl">技能 PERK</div><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${c.perks.map(id => { const p = this.perk(id); return `<div class="perkpill">${p.icon} ${p.name}</div>`; }).join('')}</div></div>
            <div class="slotc wide" data-p="streaks"><div class="sl">连杀奖励（全配装通用）</div><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${streaks.map(k => `<div class="perkpill" style="background:rgba(255,180,0,.12);border-color:rgba(255,180,0,.4)">${k.icon} ${k.name} · ${k.kills}杀</div>`).join('')}</div></div>
          </div>
        </div>
        <button class="btn ghost back" data-a="back">返回</button>
      </div>`, 'dim', 'loadout');
    this.on(r, '.cls', el => { this.selClass = +el.dataset.i; this.showLoadouts(); });
    this.on(r, '[data-a=equip]', () => { P.selClass = ci; this.game.saveProfile(); this.showLoadouts(); });
    this.on(r, '[data-a=rename]', () => { const n = prompt('配装名称', c.name); if (n && n.trim()) { c.name = n.trim().slice(0, 12); this.game.saveProfile(); this.showLoadouts(); } });
    this.on(r, '[data-g]', (el, e) => { e.stopPropagation(); this.showGunsmith(ci, el.dataset.g); });
    this.on(r, '[data-w]', (el, e) => { e.stopPropagation(); this.pickWeapon(ci, el.dataset.w); });
    this.on(r, '.slotc[data-s]', el => this.pickWeapon(ci, el.dataset.s));
    this.on(r, '[data-p=lethal]', () => this.pickSimple(ci, 'lethal'));
    this.on(r, '[data-p=tactical]', () => this.pickSimple(ci, 'tactical'));
    this.on(r, '[data-p=perks]', () => this.pickPerks(ci));
    this.on(r, '[data-p=streaks]', () => this.pickStreaks());
    // 从房间屏进来的就**回房间屏**：人还占着座位，落回大厅列表等于把一个在册的人
    // 丢在大厅 —— 房间帧只在房间屏上被收（onRoomFrame 按屏分流），他从此看不见那间房，
    // 也再没有路走回去（而"从大厅点加入"会被当成重新进房，整出一串多余的副作用）。
    // 座位要是散了，showOnlineRoom 自己的守卫会把他送回大厅，这条路两头都站得住。
    this.on(r, '[data-a=back]', () => { if (this.loadoutFrom === 'lobby') this.showLobby(); else if (this.loadoutFrom === 'onlineRoom') this.showOnlineRoom(); else if (this.loadoutFrom === 'online') this.showOnlineLobby(); else if (this.loadoutFrom === 'pause') this.showPause(); else this.showMain(); });
  }
  picker(title, sub, inner, onBack) {
    const scr = this.el.firstChild;
    const d = document.createElement('div');
    d.className = 'picker';
    d.innerHTML = `<div class="hdr">${title}<small>${sub}</small></div>${inner}<button class="btn ghost back" data-a="pback">返回</button>`;
    scr.appendChild(d);
    d.querySelector('[data-a=pback]').addEventListener('click', () => { d.remove(); onBack && onBack(); });
    return d;
  }
  miniBars(id) {
    const b = statBars(computeStats(id, {}));
    return ['伤害', '射速', '射程', '精准度', '机动性'].map(k => `<div class="stat" style="margin-top:6px">${k}<div class="bar"><div class="b0" style="width:${b[k]}%"></div></div></div>`).join('');
  }
  pickWeapon(ci, slot) {
    const c = this.game.profile.classes[ci];
    const overkill = c.perks.includes('overkill');
    const list = slot === 'primary' ? PRIMARY_ORDER : overkill ? [...SECONDARY_ORDER, ...PRIMARY_ORDER.filter(x => x !== c.primary)] : SECONDARY_ORDER;
    const cur = slot === 'primary' ? c.primary : c.secondary;
    const d = this.picker(slot === 'primary' ? '选择主武器' : '选择副武器', overkill && slot === 'secondary' ? '火力过载：可携带第二把主武器' : '选择后可进入枪匠改装', `<div class="pick-grid">${list.map(id => { const w = WEAPONS[id]; return `<div class="pick ${id === cur ? 'sel' : ''}" data-id="${id}"><div class="cat">${w.cls}</div><b>${w.name}</b><span>伤害 ${w.dmg[0]} · 射速 ${w.rpm} · 弹匣 ${w.mag}</span>${this.miniBars(id)}</div>`; }).join('')}</div>`);
    this.on(d, '.pick', el => {
      const id = el.dataset.id;
      const k = slot === 'primary' ? 'patt' : 'satt';
      if (slot === 'primary') c.primary = id; else c.secondary = id;
      // 保留兼容配件
      const old = c[k] || {}; const nw = {};
      for (const s in old) { const a = findAttachment(s, old[s]); if (a && attachmentAllowed(id, s, a)) nw[s] = old[s]; }
      c[k] = nw;
      this.game.saveProfile();
      this.showLoadouts();
    });
  }
  pickSimple(ci, kind) {
    const c = this.game.profile.classes[ci];
    const list = kind === 'lethal' ? LETHALS : TACTICALS;
    const d = this.picker(kind === 'lethal' ? '致命装备' : '战术装备', '按 4 切出 · 左键按住烹饪/松手投出', `<div class="pick-grid">${list.map(x => `<div class="pick ${c[kind] === x.id ? 'sel' : ''}" data-id="${x.id}"><b>${x.name}</b><span>${x.desc}</span><span style="color:var(--acc)">携带数量 ×${x.count}</span></div>`).join('')}</div>`);
    this.on(d, '.pick', el => { c[kind] = el.dataset.id; this.game.saveProfile(); this.showLoadouts(); });
  }
  pickPerks(ci) {
    const c = this.game.profile.classes[ci];
    const sel = [...c.perks];
    const d = this.picker('技能选择', '每个栏位选择一项技能', `<div class="perk-cols">${PERKS.map((col, i) => `<div class="perk-col"><div style="font-size:12px;color:var(--acc);letter-spacing:4px">技能 ${i + 1}</div>${col.map(p => `<div class="pick ${sel[i] === p.id ? 'sel' : ''}" data-c="${i}" data-id="${p.id}"><b>${p.icon} ${p.name}</b><span>${p.desc}</span></div>`).join('')}</div>`).join('')}</div><div style="margin-top:20px"><button class="btn" data-a="ok">确认</button></div>`);
    this.on(d, '.pick', el => { const i = +el.dataset.c; sel[i] = el.dataset.id; d.querySelectorAll(`.pick[data-c="${i}"]`).forEach(x => x.classList.toggle('sel', x === el)); });
    this.on(d, '[data-a=ok]', () => {
      c.perks = sel;
      if (!sel.includes('overkill') && !SECONDARY_ORDER.includes(c.secondary)) { c.secondary = 'm1911'; c.satt = {}; }
      this.game.saveProfile(); this.showLoadouts();
    });
  }
  pickStreaks() {
    const P = this.game.profile;
    const sel = new Set(P.streaks);
    const d = this.picker('连杀奖励', '选择 3 项 · 连续击杀敌人而不阵亡即可获得', `<div class="pick-grid">${KILLSTREAKS.map(k => `<div class="pick ${sel.has(k.id) ? 'sel' : ''}" data-id="${k.id}"><div class="cat">${k.kills} 连杀</div><b>${k.icon} ${k.name}</b><span>${k.desc}</span></div>`).join('')}</div><div style="margin-top:20px;display:flex;gap:14px;align-items:center"><button class="btn" data-a="ok">确认</button><span id="skc" style="color:#aaa;font-size:13px"></span></div>`);
    const upd = () => { d.querySelector('#skc').textContent = `已选择 ${sel.size}/3`; };
    upd();
    this.on(d, '.pick', el => {
      const id = el.dataset.id;
      if (sel.has(id)) sel.delete(id); else if (sel.size < 3) sel.add(id);
      el.classList.toggle('sel', sel.has(id)); upd();
    });
    this.on(d, '[data-a=ok]', () => { if (sel.size !== 3) { d.querySelector('#skc').innerHTML = '<span style="color:#ff6a5a">需选择 3 项</span>'; return; } P.streaks = [...sel]; this.game.saveProfile(); this.showLoadouts(); });
  }

  // ---------------- 枪匠 ----------------
  showGunsmith(ci, which) {
    this.gsCtx = { ci, which };
    this.gsSlot = this.gsSlot && this.gsCtx.which === which ? this.gsSlot : null;
    this.setCam('gunsmith');
    const c = this.game.profile.classes[ci];
    const id = which === 'primary' ? c.primary : c.secondary;
    const w = WEAPONS[id];
    const attKey = which === 'primary' ? 'patt' : 'satt', camoKey = which === 'primary' ? 'pcamo' : 'scamo';
    const att = c[attKey] = c[attKey] || {};
    c[camoKey] = c[camoKey] || 'none';
    if (!this.gsSlot) this.gsSlot = w.slots[0] || 'camo';
    this.showGun(id, att, c[camoKey]);
    const count = Object.keys(att).length;
    const slotHtml = [...w.slots, 'camo'].map(s => {
      const cur = s === 'camo' ? (CAMOS.find(x => x.id === c[camoKey]) || CAMOS[0]).name : att[s] ? (findAttachment(s, att[s]) || {}).name : null;
      const anyAllowed = s === 'camo' || (ATTACHMENTS[s] || []).some(a => attachmentAllowed(id, s, a));
      return `<div class="gs-slot ${s === this.gsSlot ? 'sel' : ''} ${anyAllowed ? '' : 'dis'}" data-s="${s}"><div class="k">${s === 'camo' ? '迷彩' : SLOT_NAMES[s]}</div><div class="v ${cur ? '' : 'none'}">${cur || '无'}</div></div>`;
    }).join('');
    let right = '';
    if (this.gsSlot === 'camo') {
      right = `<div class="gs-att" style="cursor:default"><b>迷彩涂装</b><div class="gs-camos">${CAMOS.map(cm => { const sw = cm.id === 'none' ? null : camoSwatch(cm.id); return `<div class="camo ${c[camoKey] === cm.id ? 'sel' : ''}" data-c="${cm.id}" title="${cm.name}" style="background:${sw ? `url(${sw}) center/cover` : '#26282a'}"></div>`; }).join('')}</div><div style="font-size:12px;color:#999;margin-top:8px">${(CAMOS.find(x => x.id === c[camoKey]) || CAMOS[0]).name}</div></div>`;
    } else {
      const list = (ATTACHMENTS[this.gsSlot] || []).filter(a => attachmentAllowed(id, this.gsSlot, a));
      right = `<div class="gs-att ${!att[this.gsSlot] ? 'sel' : ''}" data-id=""><b>无</b><div class="fx"><span style="color:#999">移除该栏位配件</span></div></div>` +
        list.map(a => `<div class="gs-att ${att[this.gsSlot] === a.id ? 'sel' : ''}" data-id="${a.id}"><b>${a.name}</b><div class="fx">${fxList(a.fx)}</div>${a.desc ? `<div style="font-size:11px;color:#888;margin-top:4px">${a.desc}</div>` : ''}</div>`).join('');
    }
    const r = this.render(`
      <div class="gunsmith">
        <div class="gs-left">${slotHtml}</div>
        <div class="gs-title"><div class="c">枪匠 · ${w.cls}</div><div class="n">${w.name}</div><div class="cnt">配件 ${count}/${MAX_ATT}　·　拖拽旋转 / 滚轮缩放</div></div>
        <div class="gs-right">${right}<div id="gsMsg" style="color:#ff6a5a;font-size:13px;min-height:18px"></div></div>
        <div class="gs-stats" id="gsStats"></div>
        <div class="gs-foot"><button class="btn ghost small" data-a="reset">清空配件</button><button class="btn" data-a="done">完成</button></div>
      </div>`, '', 'gunsmith');
    r.style.background = 'radial-gradient(ellipse at 50% 45%, transparent 30%, rgba(0,0,0,.55) 100%)';
    const statsFor = a => statBars(computeStats(id, a));
    const drawStats = (preview) => {
      const base = statsFor(att), pv = preview ? statsFor(preview) : base;
      const st = computeStats(id, preview || att);
      r.querySelector('#gsStats').innerHTML = ['精准度', '伤害', '射程', '射速', '机动性', '操控性'].map(k => {
        const b = base[k], p = pv[k], lo = Math.min(b, p), dlt = p - b;
        return `<div class="stat">${k}<span style="float:right;color:${dlt > 0.5 ? '#8fe06a' : dlt < -0.5 ? '#ff6a5a' : '#888'}">${Math.round(p)}${Math.abs(dlt) > 0.5 ? ` (${dlt > 0 ? '+' : ''}${Math.round(dlt)})` : ''}</span><div class="bar"><div class="b0" style="width:${lo}%"></div>${Math.abs(dlt) > 0.5 ? `<div class="bd" style="left:${lo}%;width:${Math.abs(dlt)}%;background:${dlt > 0 ? '#8fe06a' : '#ff6a5a'}"></div>` : ''}</div></div>`;
      }).join('') + `<div class="stat" style="grid-column:span 2;color:#999;display:flex;justify-content:space-between"><span>弹匣 <b style="color:#fff">${st.mag}</b></span><span>射速 <b style="color:#fff">${st.rpm}</b> RPM</span><span>换弹 <b style="color:#fff">${st.reload.toFixed(2)}</b>s</span><span>开镜 <b style="color:#fff">${Math.round(st.ads * 1000)}</b>ms</span><span>射程 <b style="color:#fff">${Math.round(st.rangeFar)}</b>m</span></div>`;
    };
    drawStats(null);
    this.on(r, '.gs-slot', el => { this.gsSlot = el.dataset.s; this.showGunsmith(ci, which); });
    r.querySelectorAll('.gs-att[data-id]').forEach(el => {
      el.addEventListener('mouseenter', () => { const p = Object.assign({}, att); if (el.dataset.id) p[this.gsSlot] = el.dataset.id; else delete p[this.gsSlot]; drawStats(p); });
      el.addEventListener('mouseleave', () => drawStats(null));
      el.addEventListener('click', () => {
        const aid = el.dataset.id;
        if (!aid) delete att[this.gsSlot];
        else {
          if (!att[this.gsSlot] && Object.keys(att).length >= MAX_ATT) { r.querySelector('#gsMsg').textContent = `配件已装满，请先移除一个`; return; }
          att[this.gsSlot] = aid;
        }
        this.game.saveProfile();
        this.showGunsmith(ci, which);
      });
    });
    this.on(r, '.camo', el => { c[camoKey] = el.dataset.c; this.game.saveProfile(); this.showGunsmith(ci, which); });
    this.on(r, '[data-a=reset]', () => { c[attKey] = {}; this.game.saveProfile(); this.showGunsmith(ci, which); });
    this.on(r, '[data-a=done]', () => { this.gsSlot = null; this.showLoadouts(); });
  }

  // ---------------- 设置 ----------------
  showSettings(from) {
    this.settingsFrom = from;
    const S = this.game.settings;
    const inGame = from === 'pause';
    if (!inGame) this.setCam('lobby');
    const rng = (k, label, min, max, step, fmt = v => v) => `<div class="set-row"><span>${label}</span><div style="display:flex;align-items:center;gap:12px"><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${S[k]}"><span class="val" data-v="${k}">${fmt(S[k])}</span></div></div>`;
    const tog = (k, label) => `<div class="set-row"><span>${label}</span><div class="seg" data-t="${k}"><div data-v="1" class="${S[k] ? 'sel' : ''}">开</div><div data-v="0" class="${!S[k] ? 'sel' : ''}">关</div></div></div>`;
    const fmts = { sens: v => (+v).toFixed(2), adsSens: v => (+v).toFixed(2), fov: v => v, volume: v => Math.round(v * 100) };
    const r = this.render(`
      <div class="settings">
        <div class="hdr" style="margin-bottom:20px">设置<small>画面 · 操作 · 音频</small></div>
        <div class="set-row"><span>画面质量</span><div class="seg" data-q="1">${['low', 'medium', 'high'].map((q, i) => `<div data-v="${q}" class="${S.quality === q ? 'sel' : ''}">${['低', '中', '高'][i]}</div>`).join('')}</div></div>
        <div class="set-row"><span>帧率上限</span><div class="seg" data-cap="1">${[['0', '不锁'], ['144', '144'], ['120', '120'], ['60', '60'], ['30', '30']].map(([v, n]) => `<div data-v="${v}" class="${(S.fpsCap | 0) === +v ? 'sel' : ''}">${n}</div>`).join('')}</div></div>
        ${rng('fov', '视野 (FOV)', 65, 100, 1, fmts.fov)}
        ${rng('sens', '鼠标灵敏度', 0.2, 3, 0.05, fmts.sens)}
        ${rng('adsSens', '开镜灵敏度倍率', 0.3, 1.5, 0.05, fmts.adsSens)}
        ${rng('volume', '主音量', 0, 1, 0.01, fmts.volume)}
        ${tog('invertY', '反转 Y 轴')}
        ${tog('voice', '语音播报')}
        ${tog('showFps', '显示帧数')}
        <div style="font-size:11px;color:#777;margin-top:8px">阴影与纹理质量将在下次载入地图后生效。</div>
        <div class="keys">
          <div><b>WASD</b>移动</div><div><b>鼠标左/右键</b>射击 / 瞄准</div>
          <div><b>Shift</b>战术冲刺</div><div><b>C / Ctrl</b>蹲伏 · 冲刺中滑铲</div>
          <div><b>Z</b>趴下 / 起身（天花板低时起到蹲）</div><div><b>Q / E</b>探头（左 / 右）</div>
          <div><b>空格</b>跳跃</div><div><b>R</b>换弹</div>
          <div><b>1 / 2 / 滚轮</b>切换武器</div>
          <div><b>V / 鼠标侧键</b>近战</div><div><b>4</b>切出投掷物（再按 4 换种）</div>
          <div><b>左键</b>按住烹饪 / 松手投出</div><div><b>F</b>互动 / 拾取武器</div>
          <div><b>N</b>夜视仪（战役）</div><div><b>5 / 6 / 7</b>连杀奖励</div>
          <div><b>Tab</b>记分板</div>
        </div>
        <div style="margin-top:24px;display:flex;gap:12px"><button class="btn" data-a="back">返回</button><button class="btn ghost small" data-a="resetp">重置存档</button></div>
      </div>`, inGame ? 'solid' : 'dim', 'settings');
    r.querySelectorAll('input[type=range]').forEach(inp => inp.addEventListener('input', () => {
      const k = inp.dataset.k; S[k] = +inp.value;
      r.querySelector(`[data-v="${k}"]`).textContent = fmts[k](S[k]);
      if (k === 'volume') this.game.audio.setVolume(S[k]);
      this.game.saveSettings();
    }));
    r.querySelectorAll('.seg[data-t]').forEach(sg => sg.querySelectorAll('div').forEach(d => d.addEventListener('click', () => {
      const k = sg.dataset.t; S[k] = d.dataset.v === '1';
      sg.querySelectorAll('div').forEach(x => x.classList.toggle('sel', x === d));
      if (k === 'voice') this.game.audio.voice = S[k];
      if (k === 'showFps') { const f = document.getElementById('fps'); if (f) f.classList.toggle('hidden', !S[k]); }
      this.game.saveSettings();
    })));
    r.querySelectorAll('.seg[data-q] div').forEach(d => d.addEventListener('click', () => {
      S.quality = d.dataset.v; r.querySelectorAll('.seg[data-q] div').forEach(x => x.classList.toggle('sel', x === d));
      this.game.saveSettings(); this.game.applyQuality();
    }));
    // 帧率上限:即时生效(frame() 每帧读设置),0=不锁。只跳帧不 sleep —— 跳掉的帧
    // 其 dt 会攒着补给下一个放行帧,所以模拟仍按真实墙钟推进,锁帧不改变对局结果。
    r.querySelectorAll('.seg[data-cap] div').forEach(d => d.addEventListener('click', () => {
      S.fpsCap = +d.dataset.v; r.querySelectorAll('.seg[data-cap] div').forEach(x => x.classList.toggle('sel', x === d));
      this.game.saveSettings();
    }));
    this.on(r, '[data-a=back]', () => { if (inGame) this.showPause(); else this.showMain(); });
    this.on(r, '[data-a=resetp]', () => { if (confirm('确定要重置所有配装与经验值吗？')) { localStorage.removeItem('mf_profile'); location.reload(); } });
  }

  // ---------------- 暂停 ----------------
  showPause() {
    this.pauseAt = performance.now();
    const g = this.game;
    const camp = g.mode && g.mode.constructor.name === 'Campaign';
    // 三种语义的差别（联机的"暂停"是假的、以及为什么)全在 pauseActions 里，见它的注释。
    const online = !!(g.net && g.state === 'play');
    const P = pauseActions({ camp, online });
    const r = this.render(`
      <div class="pause">
        <div class="hdr" style="margin-bottom:30px">${P.title}<small>${P.sub}</small></div>
        <div class="mbtn" data-a="resume"><div class="ico">▶</div><div class="mt">继续游戏</div></div>
        ${camp ? '<div class="mbtn" data-a="cp"><div class="ico">↺</div><div class="mt">读取检查点</div></div>' : ''}
        ${P.changeClass ? '<div class="mbtn" data-a="class"><div class="ico">⚙</div><div class="mt">更换配装</div></div>' : ''}
        ${P.restart ? `<div class="mbtn" data-a="restart"><div class="ico">⟲</div><div class="mt">${camp ? '重新开始任务' : '重新开始对局'}</div></div>` : ''}
        ${P.leaveMatch ? '<div class="mbtn" data-a="leaveMatch"><div class="ico">✕</div><div class="mt">退出本局</div></div>' : ''}
        <div class="mbtn" data-a="settings"><div class="ico">☰</div><div class="mt">设置</div></div>
        <div class="mbtn" data-a="quit"><div class="ico">✕</div><div class="mt">退出到主菜单</div></div>
        <div style="margin-top:20px;font-size:12px;color:#777">${P.note}</div>
      </div>`, 'solid', 'pause');
    this.on(r, '[data-a=resume]', () => this.resume());
    this.on(r, '[data-a=cp]', () => { g.paused = false; this.hide(); if (g.player.alive) { g.player.alive = false; g.dead = true; } g.mode.respawn(); });
    this.on(r, '[data-a=class]', () => this.showClassSelect(true));
    this.on(r, '[data-a=restart]', () => { const cfg = g.mode.cfg; const kind = camp ? 'campaign' : 'mp'; g.paused = false; g.startGame(kind, cfg); });
    // 联机的"退出本局"：有大厅座位就**回房间**（那条 socket 是房间的座位，关掉等于被踢出房间，
    // 见 js/main.js:returnToRoom 的注释）；?online=1 那种没有房间的直连才真的回主菜单。
    this.on(r, '[data-a=leaveMatch]', () => { g.paused = false; if (g.lobby && g.lobby.connected) g.returnToRoom(); else g.exitToMenu(); });
    this.on(r, '[data-a=settings]', () => this.showSettings('pause'));
    this.on(r, '[data-a=quit]', () => g.exitToMenu());
  }
  resume() {
    const g = this.game;
    g.pause(false);
    setTimeout(() => { if (g.state === 'play' && !g.paused && document.pointerLockElement !== g.canvas) document.getElementById('clickToPlay').classList.remove('hidden'); }, 400);
  }

  // ---------------- 局内更换配装 ----------------
  showClassSelect(fromPause) {
    const g = this.game, P = g.profile;
    this.overlayOpen = true;
    if (document.pointerLockElement) document.exitPointerLock();
    const r = this.render(`
      <div style="margin:auto;width:760px">
        <div class="hdr" style="margin-bottom:18px">选择配装<small>将在下次部署时生效</small></div>
        <div class="pick-grid" style="grid-template-columns:1fr">${P.classes.map((c, i) => `<div class="pick ${i === P.selClass ? 'sel' : ''}" data-i="${i}" style="display:flex;justify-content:space-between;align-items:center"><div><b>${esc(c.name)}</b><span>${WEAPONS[c.primary].name}${Object.keys(c.patt || {}).length ? ' (' + Object.keys(c.patt).length + '配件)' : ''} · ${WEAPONS[c.secondary].name} · ${(LETHALS.find(x => x.id === c.lethal) || {}).name || ''} · ${(TACTICALS.find(x => x.id === c.tactical) || {}).name || ''}</span></div><div style="font-size:12px;color:#aaa;text-align:right">${c.perks.map(id => this.perk(id).icon + ' ' + this.perk(id).name).join('<br>')}</div></div>`).join('')}</div>
        <div style="margin-top:16px"><button class="btn ghost" data-a="close">取消</button></div>
      </div>`, 'solid', 'classSelect');
    this.classFromPause = !!fromPause;
    this.on(r, '.pick', el => {
      const i = +el.dataset.i;
      if (g.mode && g.mode.applyClass) g.mode.applyClass(i);
      this.selClass = i;
      g.hud.popup(`配装「${P.classes[i].name}」将在下次部署时生效`, '#d4f24a');
      this.hideClassSelect();
    });
    this.on(r, '[data-a=close]', () => this.hideClassSelect());
  }
  hideClassSelect() {
    if (this.screen !== 'classSelect') return;
    this.overlayOpen = false;
    if (this.classFromPause && this.game.paused) { this.showPause(); return; }
    this.hide();
  }

  // ---------------- 结算 ----------------
  showResults(res) {
    this.overlayOpen = true;
    const g = this.game;
    g.hud.showScoreboard(false);
    const L = this.level();
    const r = this.render(`
      <div class="results">
        <div class="big ${res.win === 'win' ? 'win' : res.win === 'lose' ? 'lose' : ''}">${esc(res.title)}</div>
        <div style="font-size:18px;color:#ccc;letter-spacing:4px">${esc(res.sub || '')}</div>
        <div class="res-stats">${res.stats.map(([k, v]) => `<div><b>${v}</b>${k}</div>`).join('')}</div>
        ${res.board ? `<div id="sbCopy" style="max-height:38vh;overflow-y:auto;text-align:left;margin-bottom:20px">${res.board}</div>` : ''}
        <div style="font-size:13px;color:#999;margin-bottom:20px">等级 ${L.lv} · <div style="display:inline-block;width:200px;height:4px;background:#333;vertical-align:middle"><div style="height:100%;width:${Math.round(L.frac * 100)}%;background:var(--acc)"></div></div></div>
        <div style="display:flex;gap:12px;justify-content:center"><button class="btn" data-a="again">再来一局</button><button class="btn ghost" data-a="menu">返回主菜单</button></div>
      </div>`, 'solid', 'results');
    this.on(r, '[data-a=again]', () => { this.overlayOpen = false; res.again(); });
    this.on(r, '[data-a=menu]', () => { this.overlayOpen = false; g.exitToMenu(); });
  }
}
