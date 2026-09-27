// 入口：渲染器、后处理、主循环、状态管理
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { initTextures, mat } from './materials.js';
import { setTextureSize } from './textures.js';
import { setFlashTexture } from './soldier.js';
import { World } from './world.js';
import { MAPS } from './maps.js';
import { Effects } from './effects.js';
import { Audio } from './audio.js';
import { HUD } from './hud.js';
import { Menu } from './menu.js';
import { MPMatch } from './mp.js';
import { Campaign } from './campaign.js';
import { Player } from './player.js';
import { NetClient } from './net/client.mjs';
import { buildGun } from './gunmodel.js';
import { DEFAULT_CLASSES, DEFAULT_STREAKS } from './data.js';
import { repairClass } from './loadout.mjs';
import { damp } from './util.js';
import { Account } from './account.js';

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, nvg: { value: 0 }, thermal: { value: 0 }, hurt: { value: 0 }, vig: { value: 0.35 }, wp: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time, nvg, thermal, hurt, vig, wp; uniform vec2 res; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      if (hurt > 0.01) { vec2 o = (uv - 0.5) * 0.008 * hurt; c.r = texture2D(tDiffuse, uv + o).r; c.b = texture2D(tDiffuse, uv - o).b; }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, vec3(l), hurt * 0.55);
      float n = hash(uv * res + fract(time) * 100.0);
      if (nvg > 0.5) {
        float a = l * 7.0 + 0.015;
        a = a / (1.0 + a * 0.35);
        c = vec3(0.32, 1.0, 0.42) * a * 1.4 + (n - 0.5) * 0.09;
        float scan = sin(uv.y * res.y * 1.5) * 0.02; c += scan;
      }
      if (thermal > 0.5) {
        float t = clamp(l * 1.5, 0.0, 1.0);
        c = vec3(t * 0.45);
        if (l > 2.0) c = vec3(1.4);
        c += (n - 0.5) * 0.04;
      }
      if (wp > 0.01) { c = mix(c, c * vec3(1.6, 0.9, 0.5) + vec3(0.25, 0.08, 0.0), wp); }
      float d = length(uv - 0.5);
      c *= 1.0 - vig * smoothstep(0.35, 0.85, d);
      c += (n - 0.5) * 0.012;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

const FIXED_DT = 1 / 60;           // 模拟步长，同时是服务端的权威步长
const MAX_STEPS_PER_FRAME = 8;     // 单帧最多补几步，超出就丢时间

class Game {
  constructor() {
    this.settings = Object.assign({ sens: 1.0, adsSens: 0.9, fov: 78, quality: 'high', volume: 0.8, voice: true, invertY: false, showFps: true, fixedStep: true }, JSON.parse(localStorage.getItem('mf_settings') || '{}'));
    this.profile = Object.assign({ xp: 0, classes: JSON.parse(JSON.stringify(DEFAULT_CLASSES)), streaks: [...DEFAULT_STREAKS], selClass: 0, campaignBest: null }, JSON.parse(localStorage.getItem('mf_profile') || '{}'));
    if (!this.profile.classes || this.profile.classes.length < 5) this.profile.classes = JSON.parse(JSON.stringify(DEFAULT_CLASSES));
    // 存档里读出来的东西要过一遍表：mf_profile 是玩家能自己编辑的文件，一个不存在的枪 id
    // 会让菜单在 new Menu → buildScene → buildGun 里抛，整个页面停在"初始化失败"。
    // 同一张表也用在服务端进场（server/room.mjs），两边对"什么算合法"的答案必须同一个来源。
    this.profile.classes = this.profile.classes.map(repairClass);
    this.state = 'loading';
    this.paused = false;
    this.time = 0;
    this.tick = 0;
    this.acc = 0;
    this.frameTicks = 0;
    this.netDebug = /[?&]netdebug=1/.test(location.search);
    this.online = /[?&]online=1/.test(location.search);
    // 账号：只用来决定菜单显示什么。**它不是权限** —— 判定在服务端每一次请求里重做，
    // 客户端把自己标成"已登录"改不动任何东西。这一点是设计，不是遗漏。
    this.account = new Account();
    this.entities = []; this.bots = []; this.projectiles = []; this.pickups = []; this.noises = [];
    this.mat = mat;
    this.input = { keys: {}, pressed: {}, mdx: 0, mdy: 0, buttons: 0, wheel: 0 };
  }
  updateNetDebug(raw) {
    let el = document.getElementById('netDebug');
    if (!el) {
      el = document.createElement('div');
      el.id = 'netDebug';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:12px/1.5 ui-monospace,Consolas,monospace;color:#d4f24a;background:rgba(0,0,0,.55);padding:6px 8px;white-space:pre;pointer-events:none';
      document.body.appendChild(el);
    }
    this._ndAcc = (this._ndAcc || 0) * 0.9 + raw * 0.1;
    el.textContent =
      `${this.settings.fixedStep ? 'FIXED 1/60' : 'VARIABLE'}  tick ${this.tick}  simT ${this.time.toFixed(2)}s\n` +
      `fps ${(1 / Math.max(1e-4, this._ndFps)).toFixed(0).padStart(4)}   ticks/frame ${this.frameTicks}   leftover ${(this.acc * 1000).toFixed(1)}ms`;
    this._ndFps = (this._ndFps || 0) * 0.9 + raw * 0.1;
  }
  saveProfile() { localStorage.setItem('mf_profile', JSON.stringify(this.profile)); }
  saveSettings() { localStorage.setItem('mf_settings', JSON.stringify(this.settings)); }

  async init() {
    const q = this.settings.quality;
    setTextureSize(q === 'low' ? 256 : 512);
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 1.5 : 1));
    r.setSize(window.innerWidth, window.innerHeight, false);
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1;
    r.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById('app').appendChild(r.domElement);
    this.canvas = r.domElement;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 2500);
    this.scene.add(this.camera);
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.01, 10);
    this.vmHemi = new THREE.HemisphereLight(0xcfd8ff, 0x3a3020, 0.8);
    this.vmSun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.vmFill = new THREE.DirectionalLight(0xdde6ff, 0.9); this.vmFill.position.set(-0.5, 0.6, 1);
    this.vmScene.add(this.vmHemi, this.vmSun, this.vmSun.target, this.vmFill);
    this.audio = new Audio();
    this.audio.setVolume(this.settings.volume); this.audio.voice = this.settings.voice;
    const fill = document.getElementById('loadFill'), txt = document.getElementById('loadText');
    await initTextures(p => { fill.style.width = (p * 80) + '%'; });
    txt.textContent = '正在初始化渲染管线…';
    await new Promise(r => setTimeout(r, 10));
    this.effects = new Effects(this);
    setFlashTexture(this.effects.texFlash);
    this.hud = new HUD(this);
    this.setupComposer();
    this.setupInput();
    fill.style.width = '90%';
    txt.textContent = '正在构建菜单场景…';
    await new Promise(r => setTimeout(r, 10));
    this.menu = new Menu(this);
    // ── 账号状态**不在启动时问**。这一条是量出来的，不是审美 ──
    // 原先这里在构造函数里就连着问一次 /api/status 和 /api/me。代价是：
    // **每一次进入对战页（?online=1，包括 test/net-play.mjs）都在页面加载里多挤两次 HTTP 请求**，
    // 而那正好是权威端 addClient 与客户端第 0 拍对齐的那一瞬间。
    // 实测（同一台机器，同一份代码）：
    //   · 带着这两次请求：net-play 的"稳态预测与权威端同刻偏差" 5 次里红 4 次（0.144 ~ 0.223 m）；
    //   · 把这两次请求摘掉：2 次全绿（0.0108 / 0.0742 m）；
    //   · HEAD（b79aeb6，根本没有账号层）：3 次全绿（0.0110 / 0.0763 / 0.0120 m）。
    // 红的那一条是**已知形状**：残差 0.1484 m ÷ 4.46 m/s × 60Hz = 2.00 拍，方向沿行进方向 ——
    // 就是 c99f51f 修掉的那条"空跑落在首次消费之前"的 2 拍残差（见 js/net/predict.mjs 的 opts.carry）。
    // 也就是说这两次请求本身没算错任何东西，它改的是**客户端第 0 拍相对权威端的相位**，
    // 让那几拍的补演顺序落回了会露出 2 拍残差的排布上。
    //
    // 成因只追到这一层：**"摘掉它就好了"是实测**，我**没有**把它追进 predict 的账本，
    // 所以这里不写"因为相位所以账本如何如何"那种话 —— 那是没量过的归因。
    // （要接着追的话，判据是 net-play 的 `稳态最大` 与 `客户端补演` 两栏一起看。）
    //
    // 而账号状态本来就**只在画菜单时才需要**：联网的层级路由要按"这个服要不要账号、我登没登录"
    // 决定先过闸还是进大厅，主菜单的档案卡要显示服务端那份经验值 —— 都发生在菜单上。
    // 所以改成**按需拉**（showMain / showOnlineEntry）。顺带两个好处：
    // ?online=1 直接进对局那条路上一次 /api/* 都不发；单机玩家不来问这件事。
    // 预编译着色器
    fill.style.width = '100%';
    window.addEventListener('resize', () => this.onResize());
    document.getElementById('loading').style.display = 'none';
    this.state = 'menu';
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());
    if (this.online) await this.startOnline();
    else this.menu.showMain();
  }

  // 按需拉一次账号状态（幂等）。**刻意不在构造函数里调** —— 成因与实测见上面那段。
  // 两个调用点：menu.showMain()（主菜单的档案卡要服务端那份经验值）、
  // menu.showOnlineEntry()（联机的层级路由要按策略决定先过闸还是进大厅）。返回 promise 只为让调用方能等；
  // 调用方都**不该**阻塞在它上面：连不上服务器不是错误，单机照玩。
  accountSync() {
    if (!this.account) return Promise.resolve();
    if (this._acctSync) return this._acctSync;
    this._acctSync = this.account.status().then(() => this.account.me()).then(() => {
      // 登录之后把服务端那份经验值同步到本地档案上（显示用）。本地那份仍然可以被玩家改，
      // 但它现在只是**一个显示用的副本** —— 真正的数在服务端，下一次 me() 会把它盖回去。
      if (this.account.user) { this.profile.xp = this.account.user.xp | 0; this.saveProfile(); }
    }).catch(() => { /* 连不上服务器不是启动错误：单机照玩 */ });
    return this._acctSync;
  }

  // ---------- 联机：?online=1 ----------
  // 本机玩家照常跑完整模拟（预测），远端玩家由 NetClient 喂插值，权威裁决在服务端。
  async startOnline() {
    const q = new URLSearchParams(location.search);
    this.menu.showLoadingOverlay('正在连接对局服务…');
    // 装备必须在 connect 之前就算好：join 那一句要把 loadout 交给服务端。
    // 不交的话服务端按默认配置给你发枪 —— 于是"权威那侧的速度/射速/伤害"和你本地
    // 预测用的根本不是同一把枪，位置每收一份快照被拽一下，弹匣数字也对不上。
    const loadout = this.buildNetLoadout(this.profile.classes[this.profile.selClass] || DEFAULT_CLASSES[0]);
    // name 仍然从 URL 读，但它在**要账号的服上不是身份** —— 服务端从握手时验过的会话里取呼号，
    // join 帧里这一格不会被看（server/net-server.mjs 的 joinName）。
    // 留着它有两个用处：访客可玩的服上它**就是**这一局的显示名（那条路上没有会话可依），
    // 以及"连接中"那一屏能显示一个名字而不是"士兵"。
    // 两种情况下真正的呼号都在连上之后由 welcome 覆盖（见 NetClient 的 onControl('welcome')）。
    // title 同理是可选的显示名（大厅"创建房间"带上来），不带就是没起名。
    const net = this.net = new NetClient(this, { name: q.get('name') || '士兵', team: q.get('team') || 'A', loadout, title: q.get('title') || '' });
    // 不带 ?room= 时交给服务端自动分配（fill-first，见 server/net-server.mjs:pickRoom）。
    // 默认写死一个房号会让每台新实例都从"互相看不见"开始。
    net.room = q.get('room') || 'auto';
    let welcome;
    try { welcome = await net.connect(); }
    catch (e) { this.menu.showLoadingOverlay('连接失败：' + e.message); return null; }
    this.audio.init();
    this.clearWorld();
    this.renderPass.scene = this.scene; this.renderPass.camera = this.camera;
    this.vmPass.enabled = true;
    this.loadMap(welcome.map || 'yard');
    this.mode = net;
    const sp = new THREE.Vector3(welcome.pos[0], welcome.pos[1], welcome.pos[2]);
    const pl = this.player = new Player(this, { team: net.team, pos: sp, yaw: welcome.yaw, name: net.name, perks: welcome.loadout.perks, rngSeed: welcome.seed, rngTag: welcome.cid });
    // 用服务端回声的那份，不是我自己发出去的那份：进场闸门（server/loadout.mjs）会按表
    // 重建装备，两边各拿一份副本就意味着两套 stats —— 那是要以"预测偏差"形式浮出来的。
    pl.equip(welcome.loadout);
    this.entities = [pl];
    this.state = 'play'; this.paused = false; this.dead = false; this.ending = false;
    this.time = 0; this.tick = 0; this.acc = 0; this.frameTicks = 0;
    this.deathKiller = null; this.scopeState = null;
    document.getElementById('deathScreen').classList.add('hidden');   // 见 startGame 里的注释
    this.hud.show(true);
    this.renderer.compile(this.scene, this.camera);
    this.menu.hide();
    document.getElementById('clickToPlay').classList.remove('hidden');
    this.lock();
    return welcome;
  }
  buildNetLoadout(cls) {
    return {
      primary: { id: cls.primary, att: cls.patt || {}, camo: cls.pcamo || 'none' },
      secondary: cls.secondary ? { id: cls.secondary, att: cls.satt || {}, camo: cls.scamo || 'none' } : null,
      lethal: cls.lethal, tactical: cls.tactical, perks: cls.perks || [],
    };
  }
  onNetRespawn(ev) {
    const pl = this.player;
    if (!pl) return;
    pl.respawn(new THREE.Vector3(ev.pos[0], ev.pos[1], ev.pos[2]), ev.yaw);
    this.dead = false;
    document.getElementById('clickToPlay').classList.remove('hidden');
    this.lock();
  }

  setupComposer() {
    const r = this.renderer;
    const comp = this.composer = new EffectComposer(r);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.vmPass = new RenderPass(this.vmScene, this.vmCamera);
    this.vmPass.clear = false; this.vmPass.clearDepth = true;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.5, 0.92);
    this.grade = new ShaderPass(GradeShader);
    this.output = new OutputPass();
    this.fxaa = new ShaderPass(FXAAShader);
    comp.addPass(this.renderPass); comp.addPass(this.vmPass); comp.addPass(this.bloom); comp.addPass(this.grade); comp.addPass(this.output); comp.addPass(this.fxaa);
    this.bloom.enabled = this.settings.quality !== 'low';
    this.onResize();
  }
  onResize() {
    const w = document.documentElement.clientWidth || window.innerWidth, h = document.documentElement.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer && this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h; this.vmCamera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    if (this.fxaa) this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    if (this.grade) this.grade.uniforms.res.value.set(w, h);
    if (this.menu) this.menu.onResize();
  }
  applyQuality() {
    const q = this.settings.quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 1.5 : 1));
    this.bloom.enabled = q !== 'low';
    this.onResize();
  }

  setupInput() {
    const I = this.input;
    const cv = this.canvas;
    window.addEventListener('keydown', e => {
      if (e.code === 'Tab') e.preventDefault();
      if (!I.keys[e.code]) I.pressed[e.code] = true;
      I.keys[e.code] = true;
      if (this.state === 'play') {
        if (e.code === 'Tab') this.hud.showScoreboard(true);
        if (e.code === 'Escape' && !document.pointerLockElement && !this.paused && !this.menu.overlayOpen) this.pause(true);
        if (this.dead && e.code === 'KeyC' && this.mode && this.mode.canChangeClass) this.menu.showClassSelect();
      }
    });
    window.addEventListener('keyup', e => { I.keys[e.code] = false; if (e.code === 'Tab' && this.state === 'play') this.hud.showScoreboard(false); });
    // 鼠标位移过滤：浏览器（尤其 Windows 版 Chrome/Edge）在指针锁定下偶尔会给出
    // 巨大的错误 movementX/Y（光标被拉回中心时的跳变、锁定刚生效时的第一帧等），
    // 表现为视角"闪现"。这里丢弃锁定后最初的事件，并剔除相对近期平均值异常巨大的单次跳变。
    const MF = this.mouseFilter = { since: 0, avg: 0, strikes: 0, lastT: 0 };
    window.addEventListener('mousemove', e => {
      if (document.pointerLockElement !== cv) return;
      const now = performance.now();
      if (now - MF.since < 120) return;                       // 锁定刚生效：丢弃
      const dx = e.movementX || 0, dy = e.movementY || 0;
      const mag = Math.hypot(dx, dy);
      if (now - MF.lastT > 250) MF.avg = Math.min(MF.avg, 30); // 静止一段后重新起算
      MF.lastT = now;
      const limit = Math.max(160, MF.avg * 7);
      if (mag > limit) {
        // 连续多次大位移说明是真实的快速甩枪，放行；孤立的跳变视为噪声丢弃
        if (++MF.strikes < 3) return;
      } else MF.strikes = 0;
      MF.avg = MF.avg * 0.8 + Math.min(mag, limit) * 0.2;
      I.mdx += dx; I.mdy += dy;
    });
    window.addEventListener('mousedown', e => {
      if (this.state === 'play' && !this.paused && document.pointerLockElement !== cv && !this.menu.overlayOpen && e.target === cv) { this.lock(); return; }
      if (document.pointerLockElement === cv) { I.buttons |= (1 << e.button); I.pressed['Mouse' + e.button] = true; }
    });
    window.addEventListener('mouseup', e => { I.buttons &= ~(1 << e.button); });
    window.addEventListener('wheel', e => { if (document.pointerLockElement === cv) I.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === cv;
      MF.since = performance.now(); MF.avg = 0; MF.strikes = 0; I.mdx = 0; I.mdy = 0;
      document.getElementById('clickToPlay').classList.add('hidden');
      if (!locked && this.state === 'play' && !this.paused && !this.dead && !this.menu.overlayOpen && !this.ending) this.pause(true);
      if (!locked) { I.buttons = 0; }
    });
    document.getElementById('clickToPlay').addEventListener('click', () => this.lock());
    document.getElementById('btnChangeClass').addEventListener('click', () => this.menu.showClassSelect());
  }
  lock() {
    this.audio.init();
    if (document.pointerLockElement === this.canvas) return;
    // 优先请求原始输入（unadjustedMovement）：绕过系统鼠标加速，也能避开 Chrome 的位移跳变 bug；
    // 不支持时回退到普通指针锁定
    const cv = this.canvas;
    const plain = () => { try { const q = cv.requestPointerLock(); if (q && q.catch) q.catch(() => { }); } catch (e) { } };
    try {
      const p = cv.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(err => { if (!err || err.name === 'NotSupportedError' || err.name === 'NotAllowedError' && document.pointerLockElement !== cv) plain(); });
      else if (!p) { /* 旧浏览器不返回 Promise：已按普通方式处理 */ }
    } catch (e) { plain(); }
  }
  pause(v) {
    if (this.state !== 'play') return;
    this.paused = v;
    if (v) { this.menu.showPause(); if (document.pointerLockElement) document.exitPointerLock(); }
    else { this.menu.hide(); this.lock(); }
  }

  // 掉线可见性。症状原来是这样的：服务器重启 / 网络断 → 世界静止，但屏幕上没有任何
  // 解释，玩家以为是自己卡了 —— 上线后这会是第一条工单，而"能重连"这件事必须先让人
  // 知道发生了什么。刻意不走 pause()：暂停菜单里有"继续"，而断开之后继续没有意义。
  netLostUi() {
    const n = this.net;
    if (!n || !n.lost) return;
    if (!this._lostUi) {
      this._lostUi = true;
      if (this.state === 'play') { this.paused = true; if (document.pointerLockElement) document.exitPointerLock(); }
      // 只管 lost 的三种成因（closed=对端关了，lost=服务端优雅下线，stale=半开连接）。
      // "进不去这局"不在这里：那种失败发生在 welcome 之前，startOnline 的 catch 会在加载页
      // 上说明原因，而此刻还没有对局 HUD 可言。
      const why = n.lost === 'stale' ? '与服务器失联' : '连接已断开';
      // hud.announce 走 innerHTML（HUD 别处要放标签），而这里拼进来的是**服务端给的字符串**：
      // 被攻破的服务器不该能往这台页面上塞脚本。角括号一律先剥掉。
      const esc = (s) => String(s || '').replace(/[<>]/g, '');
      const detail = (n.serverNote ? esc(n.serverNote) + ' · ' : '') + esc(n.lostReason) + '（服务器可能在更新）';
      this.hud.announce(why, detail + ' 按 Enter 重新连接', Infinity);      // Infinity = 不自动消失
      return;
    }
    // 键盘优先：断线时指针已解锁，但游戏里"点一下按钮"这套 UI 我不打算为它新增鼠标依赖
    const K = this.input && this.input.pressed;
    if (K && (K.Enter || K.NumpadEnter)) location.reload();
  }

  // 帧输入快照
  snapshotInput() {
    const I = this.input, K = I.keys, P = I.pressed;
    const s = {
      fwd: K.KeyW, back: K.KeyS, left: K.KeyA, right: K.KeyD,
      sprint: K.ShiftLeft || K.ShiftRight, jumpPressed: P.Space, crouchPressed: P.KeyC || P.ControlLeft,
      fire: !!(I.buttons & 1), ads: !!(I.buttons & 4),
      reloadPressed: P.KeyR, swapPressed: I.wheel !== 0, slot1: P.Digit1, slot2: P.Digit2,
      meleePressed: P.KeyV || P.Mouse3, lethalPressed: P.KeyG, lethal: K.KeyG, tacticalPressed: P.KeyQ, tactical: K.KeyQ,
      interact: K.KeyF, interactPressed: P.KeyF, nvgPressed: P.KeyN,
      streak: P.Digit3 ? 0 : P.Digit4 ? 1 : P.Digit5 ? 2 : -1,
      firePressed: P.Mouse0, adsPressed: P.Mouse2,
      mdx: I.mdx, mdy: I.mdy,
    };
    I.mdx = 0; I.mdy = 0; I.wheel = 0;
    for (const k in P) delete P[k];
    return s;
  }

  // ---------- 世界管理 ----------
  clearWorld() {
    for (const b of this.bots) b.dispose();
    for (const p of this.projectiles) if (p.mesh) this.scene.remove(p.mesh);
    for (const p of this.pickups) this.scene.remove(p.mesh);
    if (this.mode && this.mode.dispose) this.mode.dispose();
    if (this.player) this.player.ws.dispose();
    if (this.world) this.world.dispose();
    this.effects.clear();
    this.audio.stopAll();
    this.bots = []; this.entities = []; this.projectiles = []; this.pickups = []; this.noises = [];
    this.world = null; this.player = null; this.mode = null;
    this.grade.uniforms.nvg.value = 0; this.grade.uniforms.thermal.value = 0; this.grade.uniforms.wp.value = 0;
    this.nvg = false;
  }
  loadMap(id) {
    const def = MAPS[id];
    const w = new World(this, def);
    this.world = w;
    w.setupEnvironment(def.env);
    def.build(w, this);
    w.finalize();
    this.effects.setWeather(def.env.weather);
    // 视图模型灯光
    this.vmSun.color.set(def.env.sunColor); this.vmSun.intensity = Math.max(1.1, def.env.sun * 0.6);
    this.vmSun.position.set(...def.env.sunDir).multiplyScalar(10);
    this.vmHemi.intensity = Math.max(0.9, def.env.hemi);
    this.vmScene.environment = this.scene.environment;
    this.vmScene.environmentIntensity = Math.max(0.4, def.env.envIntensity);
    if (def.env.ambient) this.audio.loop('amb', def.env.ambient, def.env.ambient === 'rain' ? 0.12 : 0.08);
    return w;
  }
  async startGame(kind, cfg) {
    this.menu.showLoadingOverlay('正在部署…');
    await new Promise(r => setTimeout(r, 30));
    this.audio.init();
    this.clearWorld();
    this.renderPass.scene = this.scene; this.renderPass.camera = this.camera;
    this.vmPass.enabled = true;
    if (kind === 'mp') {
      this.loadMap(cfg.map);
      this.mode = new MPMatch(this, cfg);
    } else {
      this.loadMap('kaldash');
      this.mode = new Campaign(this, cfg);
    }
    this.mode.start();
    this.state = 'play'; this.paused = false; this.dead = false; this.ending = false;
    this.time = 0; this.tick = 0; this.acc = 0; this.frameTicks = 0;
    this.deathKiller = null; this.scopeState = null;
    // 开局这件事本身就是"一切都从头算"，所以这里有权把上一局剩下的界面收干净：
    // deathScreen 原先只在"重生"和"退回菜单"两处收过，死着退出上一局（或直接从结算
    // 界面再开一局）的时候，那张"被 xx 击杀 · N 秒后重新部署"就跟着进了新局。
    document.getElementById('deathScreen').classList.add('hidden');
    this.hud.show(true);
    // 预热编译
    this.renderer.compile(this.scene, this.camera);
    this.menu.hide();
    document.getElementById('clickToPlay').classList.remove('hidden');
    this.lock();
  }
  exitToMenu() {
    this.clearWorld();
    this.state = 'menu'; this.paused = false; this.dead = false;
    this.hud.show(false); this.hud.showScoreboard(false);
    document.getElementById('deathScreen').classList.add('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    this.menu.showMain();
  }

  // ---------- 事件 ----------
  onKill(killer, victim, weapon, head, info) {
    if (this.mode && this.mode.onKill) this.mode.onKill(killer, victim, weapon, head, info || {});
  }
  makeNoise(pos, r, team, footstep = false) {
    if (this.replaying) return;      // 回滚重放出来的那几拍不该在噪声史上留第二份记录
    this.noises.push({ pos: pos.clone(), r, team, t: this.time, footstep });
  }
  alertGroup(g, pos) { if (this.mode && this.mode.alertGroup) this.mode.alertGroup(g, pos); }
  addBot(bot) { this.bots.push(bot); this.entities.push(bot); return bot; }
  removeBot(bot) {
    bot.dispose();
    this.bots = this.bots.filter(b => b !== bot);
    this.entities = this.entities.filter(b => b !== bot);
  }
  spawnPickup(weaponId, att, pos, mag, reserve) {
    const info = buildGun(weaponId, att || {}, 'none', { low: true });
    const m = info.group;
    m.position.set(pos.x, (this.world ? this.world.groundHeight(pos.x, pos.z, pos.y + 1, 0.2) : 0) + 0.06, pos.z);
    m.rotation.set(0, Math.random() * 6, Math.PI / 2);
    this.scene.add(m);
    const p = { weaponId, att: att || {}, mesh: m, pos: m.position.clone(), mag, reserve, t: 0 };
    this.pickups.push(p);
    if (this.pickups.length > 14) { const o = this.pickups.shift(); this.scene.remove(o.mesh); }
    return p;
  }

  // 热成像：把人物整体换成"发光"，好让 grade 那个热成像滤镜认得出热源。
  // 记账必须**按材质**而不是按 mesh —— 一个材质被身上好几块 mesh 共用（制服、靴子、背心
  // 常常共一份 MATS），按 mesh 记的话，遍历到第二块时它存下的快照已经是被上一块刚改成白的
  // 那个值（实测 em=[16777215,3]），关镜时沿着同一个顺序恢复，最后一块又把它涂回白色：
  // 352 个 mesh 一个都没回来 —— 这就是"夜视瞄具关镜后人物还是刺眼亮光"的成因。
  setThermal(on) {
    if (this.thermalOn === on) return;
    this.thermalOn = on;
    this.grade.uniforms.thermal.value = on ? 1 : 0;
    const mats = this.thermalMats || (this.thermalMats = new Map());
    if (on) {
      for (const b of this.bots) {
        b.model.root.traverse(o => {
          if (!o.isMesh || !o.material || !o.material.emissive) return;
          if (!mats.has(o.material)) mats.set(o.material, [o.material.emissive.getHex(), o.material.emissiveIntensity]);
          // 活人比尸体亮一点：这一半只能按 mesh 写（共享材质时最后一个遍历到的赢 —— 那是
          // 既有的近似，不是这次要修的东西）；能不能恢复得回来不看它，看上面那份材质表。
          o.material.emissive.setHex(0xffffff);
          o.material.emissiveIntensity = b.alive ? 3 : 0.8;
        });
      }
    } else {
      // 一律照快照还原，不论这些 mesh 还在不在 —— 中途重生的模型用的是同一批共享材质，
      // 只盘点"现在树上的 mesh"会漏掉它们。
      for (const [m, em] of mats) { m.emissive.setHex(em[0]); m.emissiveIntensity = em[1]; }
      mats.clear();
    }
  }

  // ---------- 主循环 ----------
  // 固定步长：真实帧时长只决定"这一帧有机会跑几步"，不决定物理步长。
  // 依据实测：变步长下同一份输入在 15/240Hz 之间落点最大差 1.79m（含蹲跳边沿），
  // 且余弹数随帧率变（DPS 随帧率变）；固定 1/60 后所有帧率逐位相同。
  // 服务端只按固定步长跑，客户端预测要走同一条离散化，否则两边永远对不上。
  frame() {
    const raw = Math.min(0.25, this.clock.getDelta());   // 0.25 上限防"死亡螺旋"
    // 渲染侧仍拿改造前那份取值（原来整个循环就用 min(0.05, delta)），
    // 不让模拟步长偷偷改掉 composer/菜单动画的时间基准
    const rdt = Math.min(0.05, raw);
    if (this.state === 'play') {
      if (!this.paused) {
        if (this.settings.fixedStep === false) {
          this.update(rdt, this.snapshotInput());         // 旧行为原样保留，供 A/B 对比
        } else {
          this.acc += raw;
          let n = 0;
          // 只在真的要推进一 tick 时才取走输入快照 —— 这样两次 tick 之间攒下的
          // 鼠标位移会整份交给下一个 tick，总转向量与帧率无关
          while (this.acc >= FIXED_DT && n < MAX_STEPS_PER_FRAME) {
            this.update(FIXED_DT, this.snapshotInput());
            this.acc -= FIXED_DT; this.tick++; n++;
          }
          if (n === MAX_STEPS_PER_FRAME) this.acc = 0;    // 落后太多就丢时间，不追帧
          this.frameTicks = n;
        }
      } else {
        // 暂停时也要排空：否则这几十秒的鼠标位移会攒着，解除暂停的瞬间甩飞视角
        // （改造前每帧无条件 snapshotInput，这个不变量必须保住）
        this.snapshotInput();
        this.acc = 0;
      }
      // 视图模型按渲染帧走，与 tick 解耦：144Hz 屏上枪的手感不再被 60Hz 绑住，
      // 而弹道、后坐、相机仍然只在 tick 上变，服务端能逐位复现
      if (!this.paused && this.player && this.player.alive && this.player.ws) this.player.ws.updateRender(rdt);
      this.renderPass.scene = this.scene; this.renderPass.camera = this.camera; this.vmPass.enabled = !!(this.player && this.player.alive);
    } else if (this.state === 'menu') {
      this.snapshotInput();
      this.menu.update(rdt);
      this.renderPass.scene = this.menu.scene3d; this.renderPass.camera = this.menu.camera3d; this.vmPass.enabled = false;
      this.grade.uniforms.nvg.value = 0; this.grade.uniforms.hurt.value = 0; this.grade.uniforms.thermal.value = 0; this.grade.uniforms.wp.value = 0;
    }
    if (this.net) { this.net.flush(); this.net.frameUpdate(rdt); }
    this.netLostUi();
    if (this.netDebug) this.updateNetDebug(raw);
    this.grade.uniforms.time.value = performance.now() * 0.001;
    this.composer.render(rdt);
  }
  update(dt, inp) {
    // 联机：每一拍的输入都要连同"这一拍开始前的自身状态"记进日记本，
    // 服务端回多少 tick 回来，客户端就能退回去重放多少拍。见 net/client.mjs:reconcile
    if (this.net && this.player) this.net.recordInput(this.tick, inp);
    this.time += dt;
    this.pathBudget = 3;
    if (this.noises.length) this.noises = this.noises.filter(n => this.time - n.t < 0.6);
    const pl = this.player;
    if (pl) {
      if (pl.alive) {
        pl.update(dt, inp);
      } else {
        // 死亡视角
        const cam = this.camera;
        cam.position.y = damp(cam.position.y, pl.pos.y + 0.4, 3, dt);
        const k = this.deathKiller;
        if (k && k.pos) { const tgt = k.pos.clone(); tgt.y += 1.2; const m = new THREE.Matrix4().lookAt(cam.position, tgt, new THREE.Vector3(0, 1, 0)); const q = new THREE.Quaternion().setFromRotationMatrix(m); cam.quaternion.slerp(q, 1 - Math.exp(-2 * dt)); }
        this.audio.setListener(cam.position, pl.yaw);
      }
      // NVG
      if (inp.nvgPressed && this.mode && this.mode.nvgAvailable) {
        this.nvg = !this.nvg;
        this.audio.tone(this.nvg ? 2400 : 1600, 0.15, 0.1, 'sine', null, this.nvg ? 1.5 : 0.6);
      }
      this.grade.uniforms.nvg.value = this.nvg && pl.alive && !this.scopeState ? 1 : 0;
      document.getElementById('nvgFrame').classList.toggle('hidden', !(this.nvg && pl.alive && !this.scopeState));
      this.renderer.toneMappingExposure = (this.world.env.exposure ?? 1) * (this.nvg ? 1.0 : 1);
      this.setThermal(this.scopeState === 'thermal');
      this.grade.uniforms.hurt.value = pl.alive ? Math.max(0, 1 - pl.hp / pl.maxHp - 0.2) : 0.8;
    }
    for (const b of this.bots) b.update(dt);
    for (const p of this.projectiles) p.update(dt);
    if (this.projectiles.some(p => !p.alive)) this.projectiles = this.projectiles.filter(p => p.alive);
    // 拾取
    this.updatePickups(dt, inp);
    if (this.mode) this.mode.update(dt, inp);
    this.world.update(dt, this.time, this.camera.position);
    this.effects.update(dt, this.camera.position);
    this.hud.update(dt);
  }
  updatePickups(dt, inp) {
    const pl = this.player;
    let near = null, nd = 1.8;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.t += dt;
      if (p.t > 30) { this.scene.remove(p.mesh); this.pickups.splice(i, 1); continue; }
      if (!pl || !pl.alive) continue;
      const d = Math.hypot(p.pos.x - pl.pos.x, p.pos.z - pl.pos.z);
      // 相同武器自动拾取弹药
      const slot = pl.ws.slots.find(s => s.id === p.weaponId);
      if (slot && d < 1.3) {
        const add = Math.max(5, Math.floor((p.reserve ?? slot.stats.mag) * 0.5 + (p.mag || 0)));
        if (slot.reserve < slot.stats.reserve * 2) { slot.reserve = Math.min(slot.stats.reserve * 2, slot.reserve + add); this.hud.popup('+弹药 ' + add, '#ccc'); this.audio.click(2200, 0.05, 0.3); this.scene.remove(p.mesh); this.pickups.splice(i, 1); continue; }
      }
      if (!slot && d < nd) { near = p; nd = d; }
    }
    this.nearPickup = near;
    if (this.mode && this.mode.interactPrompt) return;
    if (near && pl && pl.alive) {
      const def = near.weaponId;
      this.hud.prompt(`<b>F</b>拾取 ${buildName(def)}`);
      if (inp.interactPressed) {
        const ws = pl.ws;
        const cur = ws.w;
        const isSecondary = ['m1911', 'revolver', 'rpg'].includes(def);
        let idx = ws.cur;
        if (ws.slots.length > 1) idx = isSecondary ? 1 : 0;
        if (ws.slots[idx] && ws.slots[idx].stats.type === 'pistol' && !isSecondary && ws.cur === 0) idx = 0;
        const old = ws.slots[idx];
        if (old) this.spawnPickup(old.id, old.att, pl.pos, old.mag, old.reserve);
        const st = { id: def, att: near.att, camo: 'none' };
        ws.replaceSlot(idx, st, near.mag ?? undefined, near.reserve ?? undefined);
        this.scene.remove(near.mesh); this.pickups = this.pickups.filter(p => p !== near);
        this.audio.ui('equip');
      }
    } else if (!this.mode || !this.mode.interactPrompt) this.hud.prompt(null);
  }
}

import { WEAPONS } from './data.js';
function buildName(id) { return WEAPONS[id] ? WEAPONS[id].name : id; }

const game = new Game();
window.game = game;
game.init().catch(e => { console.error(e); document.getElementById('loadText').textContent = '初始化失败：' + e.message; });
