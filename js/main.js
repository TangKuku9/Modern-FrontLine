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
import { setFlashTexture, setSoldierEye } from './soldier.js';
import { World } from './world.js';
import { MAPS } from './maps.js';
import { Effects } from './effects.js';
import { Audio } from './audio.js';
import { HUD } from './hud.js';
import { Menu } from './menu.js';
import { MPMatch } from './mp.js';
import { Campaign } from './campaign.js';
import { Player } from './player.js';
import { onKillPerks, killMedals, pickupsExpire, pickupAction } from './match-rules.js';
import { NetClient } from './net/client.mjs';
import { LobbyClient } from './net/lobby.mjs';
import { buildGun } from './gunmodel.js';
import { DEFAULT_CLASSES, DEFAULT_STREAKS, MP_MODES } from './data.js';
import { repairClass } from './loadout.mjs';
import { applyAccountXp } from './progress.mjs';
import { damp } from './util.js';
import { Account } from './account.js';
import { unpackInput } from './quant.js';

// 拼进 innerHTML 的**服务端字符串**（呼号、离开提示）一律先剥掉角括号。
// 被攻破的服务器不该能往这台页面上塞脚本，而 HUD 那几处（announce/killfeed）走的就是 innerHTML。
const escHtml = (s) => String(s == null ? '' : s).replace(/[<>]/g, '');

// 结算停摆时替换用的输入：unpackInput(0,0) 就是"什么都没按"的那一份（与服务端解包
// 空输入是同一个构造器，逐字段同形）。共享一个对象而不是每拍 new：消费方只读。
const ENDING_INPUT = unpackInput(0, 0);

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
    this.settings = Object.assign({ sens: 1.0, adsSens: 0.9, fov: 78, quality: 'high', volume: 0.8, voice: true, invertY: false, showFps: true, fixedStep: true, fpsCap: 0 }, JSON.parse(localStorage.getItem('mf_settings') || '{}'));
    this.profile = Object.assign({ xp: 0, xpLocal: 0, classes: JSON.parse(JSON.stringify(DEFAULT_CLASSES)), streaks: [...DEFAULT_STREAKS], selClass: 0, campaignBest: null, muted: [] }, JSON.parse(localStorage.getItem('mf_profile') || '{}'));
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
    // 帧计数:frames = 进了 frame() 的次数(墙钟节拍),renders = 真正画了的次数,
    // skipped = 帧率上限挡掉的次数。三个数分开记,是因为锁帧只该改 renders ——
    // frames 和模拟都照旧。
    this.frames = 0; this.renders = 0; this.skipped = 0;
    this.netDebug = /[?&]netdebug=1/.test(location.search);
    this.online = /[?&]online=1/.test(location.search);
    // 账号：只用来决定菜单显示什么。**它不是权限** —— 判定在服务端每一次请求里重做，
    // 客户端把自己标成"已登录"改不动任何东西。这一点是设计，不是遗漏。
    this.account = new Account();
    this.entities = []; this.bots = []; this.projectiles = []; this.pickups = []; this.noises = [];
    this.mat = mat;
    this.input = { keys: {}, pressed: {}, mdx: 0, mdy: 0, buttons: 0, wheel: 0 };
  }
  updateNetDebug(raw, wall) {
    let el = document.getElementById('netDebug');
    if (!el) {
      el = document.createElement('div');
      el.id = 'netDebug';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:12px/1.5 ui-monospace,Consolas,monospace;color:#d4f24a;background:rgba(0,0,0,.55);padding:6px 8px;white-space:pre;pointer-events:none';
      document.body.appendChild(el);
    }
    // 两个平均都要取**墙钟差**。改造前这里吃的是 raw:锁帧把 raw 掺进了攒下的
    // _capPend,而这一行只在放行帧上跑,平均出来的就是"放行帧的间隔" ——
    // 锁 30 时会报 30,但它量不出"显示器给的节拍到底多快、被挡掉多少"。
    this._ndAcc = (this._ndAcc || 0) * 0.9 + raw * 0.1;
    this._ndWall = (this._ndWall || 0) * 0.9 + (wall ?? raw) * 0.1;
    el.textContent =
      `${this.settings.fixedStep ? 'FIXED 1/60' : 'VARIABLE'}  tick ${this.tick}  simT ${this.time.toFixed(2)}s\n` +
      `fps ${(1 / Math.max(1e-4, this._ndWall)).toFixed(0).padStart(4)}   ticks/frame ${this.frameTicks}   leftover ${(this.acc * 1000).toFixed(1)}ms` +
      (this.skipped ? `\ncap ${this.settings.fpsCap}   skipped ${this.skipped}` : '');
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

  // 按需拉一次账号状态。**只缓存"问成功"的那一次** —— 这一条是量出来的：
  // 无论成败都缓存的那一版，在一次超时之后就把结果钉死了。实测形状是两个软件渲染的
  // 页签同时加载（页面忙到 /api/status 的 8 秒闸门跳开），于是那个人之后每一次点
  // "联网对战"都落在注册页上 —— 而在访客服上那一屏根本没有他能填的东西。
  // 判据是 statusKnown（"服务端亲口说过策略"），不是"我发过一次请求"。
  accountSync() {
    if (!this.account) return Promise.resolve();
    if (this._acctSync && this.account.statusKnown) return this._acctSync;
    this._acctSync = this.account.status().then(() => this.account.me()).then(() => {
      // 登录之后把服务端那份经验值同步到本地档案上（显示用）。
      // **只写账号那一半**：本地那份（战役 / 单机 / 访客联机）不参与，谁都盖不掉 ——
      // 这条以前是 `profile.xp = user.xp`，把两半挤在一个字段里，于是玩家打完一整场战役
      // 再回主菜单，那一笔就没了（见 js/progress.mjs 开头）。
      if (this.account.user) { applyAccountXp(this.profile, this.account.user.xp); this.saveProfile(); }
    }).catch(() => { /* 连不上服务器不是启动错误：单机照玩，下一次进联网还会再问 */ });
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
    const net = this.net = new NetClient(this, { name: q.get('name') || '士兵', team: q.get('team') || 'A', loadout, streaks: this.profile.streaks, title: q.get('title') || '' });
    // 不带 ?room= 时交给服务端自动分配（fill-first，见 server/net-server.mjs:pickRoom）。
    // 默认写死一个房号会让每台新实例都从"互相看不见"开始。
    net.room = q.get('room') || 'auto';
    let welcome;
    try { welcome = await net.connect(); }
    catch (e) { this.menu.showLoadingOverlay('连接失败：' + e.message); return null; }
    return this.beginNetMatch(welcome, net);
  }

  // 从"拿到进场应答"到"这一局在本机跑起来"。**两个调用点**：上面那条 ?online=1 的
  // 直连老路，和大厅里房主按下开始（js/net/lobby.mjs 对 welcome 那一帧的分流）。
  // 两条路共用这一段是刻意的：换世界 → 建本机玩家 → 装配 → 起 HUD 的顺序只要有一处不同，
  // 另一条路就会带上没人复现过的边界症状（第 0 拍对不齐那一族就是这种形状）。
  async beginNetMatch(welcome, net) {
    this.net = net;
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
    // 开局播报（与单机 MPMatch.start 那一句同形状）：模式与胜利目标。房里选的设置
    // 只活在房间屏上的话，进了局谁也不记得这一局打到多少算赢 —— 目标数由服务端
    // 在 welcome 里说（room.rules.scoreLimit），这里不自己另算一份默认。
    const md = MP_MODES.find(m => m.id === welcome.mode) || { name: welcome.mode || '对局' };
    const lim = welcome.scoreLimit || (welcome.mode === 'dom' ? 200 : welcome.mode === 'ffa' ? 25 : 50);
    this.hud.announce(md.name, `率先达到 ${lim}${welcome.mode === 'dom' ? ' 分' : ' 次击杀'}`, 4);
    this.renderer.compile(this.scene, this.camera);
    this.menu.hide();
    document.getElementById('clickToPlay').classList.remove('hidden');
    this.lock();
    return welcome;
  }

  // ---------- 联机大厅：一条 WebSocket 从列表一路走到对局 ----------
  // 连接归 game 而不是归 menu：menu 会因为换屏反复重画，而这条连接身上的身份
  // （我在哪间房的哪个座位）必须跨过"大厅 → 房间 → 对局 → 回房间"整段活着。
  // url 可带（跨台加入时是另一台的 ws 地址，见 menu.remoteJoin）：同台已连就复用这条连接；
  // 换台就拆掉旧的 —— "一条连接走到底"的前提是同一台，旧连接上的座位/房间状态随之作废。
  onlineLobby(url) {
    if (this.lobby && this.lobby.connected && (!url || this.lobby.url === url)) return Promise.resolve(this.lobby);
    if (this.lobby) { this.lobby.close(); this.lobby = null; }
    const lb = this.lobby = new LobbyClient(this, {
      url,
      name: this.menu.lobby.name,
      onRooms: () => { if (this.menu.screen === 'online') this.menu.renderRooms(); },
      onRoom: (j) => this.onRoomFrame(j),
      onChat: (j) => this.onChatFrame(j),
      onError: (m) => this.menu.onlineError(m),
      onNote: (m) => this.onLobbyNote(m),
      onBegin: (j) => this.startMatchFromLobby(j),
    });
    return lb.connect().catch(e => { this.lobby = null; throw e; });
  }

  // room 那一帧有三个去处，按"我现在在哪一屏"分：
  //   对局中、而服务端说这局结束了 → 退回房间屏（returnRoom 的唯一触发点）；
  //   正要进房而应答到了 → 换到房间屏；
  //   已经在房间屏 → 只重画数据，不重建界面（重建会把聊天输入框里打到一半的字抹掉）。
  onRoomFrame(j) {
    if (this.state === 'play') {
      if (j.room && j.room.state !== 'playing') this.returnToRoom();
      return;
    }
    if (this._wantRoom && j.me) { this._wantRoom = false; this.menu.showOnlineRoom(); return; }
    if (this.menu.screen !== 'onlineRoom') return;
    if (!j.me) { this.menu.showOnlineLobby(); return; }        // 座位没了（房间散了 / 最后一人走了）
    this.menu.renderRoom();
  }
  onChatFrame(j) {
    // 两种 chat 帧长得不一样：一条新消息，和"刚进大厅时补给你的最近几句"。
    // 后者只重画整块列表 —— 拿它走追加路径会画出一条没有 text 的空行，
    // 而"新进来的人看不到之前说过什么"这种缺陷没人会当 bug 报，只会以为频道本来就是空的。
    if (Array.isArray(j.hist)) { if (j.ch === 'lobby' && this.menu.screen === 'online') this.menu.renderChat(this.menu.el, 'lobby'); return; }
    // 对局里的话（match/team 频道 + 举报回执那类 sys 行）上 HUD 的聊天条（差距 43）。
    // 分流判据是**频道**，不是"在不在对局里"：回执在房间屏上也是要看见的。
    if (this.state === 'play' && j.ch !== 'lobby' && j.ch !== 'room') { this.hud.chatPush(j); return; }
    if (j.ch === 'lobby') { if (this.menu.screen === 'online') this.menu.pushChat(this.menu.el, 'lobby', j); return; }
    // 剩下的是房间行与 sys 回执：按当前那一屏画进对应面板
    if (this.menu.screen === 'onlineRoom') this.menu.pushChat(this.menu.el, 'room', j);
    else if (j.ch === 'sys' && this.menu.screen === 'online') this.menu.pushChat(this.menu.el, 'lobby', j);
  }
  onLobbyNote(msg) {
    // 服务端下线时那一句：在对局里就报在 HUD 上，在菜单里就写在当前那一屏上。
    // 只塞进 net.events 的话没人读它 —— 那正是"服务器重启后所有人站在一个静止的世界里"。
    if (this.state === 'play' && this.hud) this.hud.announce(msg, '', 6);
    else this.menu.onlineError(msg);
  }
  // 建房 / 加入之后先占住这一屏：座位应答到达之前不画房间（画了会是一屏空座位）。
  // 应答失败时 onlineError 会清掉这个标记并退回大厅，人不会被卡在"正在进房…"上。
  showRoomSoon() {
    this._wantRoom = true;
    this.menu.showLoadingOverlay('正在进房…');
  }
  // 房主按下开始：服务端在**同一条连接**上发来进场应答，这里把世界换过来。
  // 交还 socket 的时机在 beginNetMatch 之后 —— 加载地图那几百毫秒里到的快照直接丢掉，
  // 否则那几个远端玩家会被塞进菜单那个场景（症状是主菜单背景上飘过几个士兵）。
  async startMatchFromLobby(welcome) {
    if (this.state === 'play' || !this.lobby) return;          // 已经在这局里了（重复的应答）
    const lb = this.lobby;
    const net = new NetClient(this, { name: welcome.name, team: welcome.team });
    this.menu.showLoadingOverlay('正在进入对局…');
    await this.beginNetMatch(welcome, net);
    net.attach(lb.ws, welcome);
    lb.match = net;
  }
  // 一局结束、回到房间：拆掉对局层的东西，但**那条连接不能关**（它是房间的座位）。
  // this.mode 要先摘干净：clearWorld 会顺手 dispose 当前 mode，而 NetClient.dispose
  // 的默认动作就是关 socket —— 顺序反过来的话"回房间"就变成"被踢出房间"。
  returnToRoom() {
    const net = this.net;
    if (this.lobby) this.lobby.match = null;
    this.mode = null;
    if (net) net.dispose(true);
    this.net = null;
    this.clearWorld();
    this.state = 'menu'; this.paused = false; this.dead = false;
    this.hud.show(false); this.hud.showScoreboard(false);
    document.getElementById('deathScreen').classList.add('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.lobby && this.lobby.state && this.lobby.state.me) this.menu.showOnlineRoom();
    else this.menu.showOnlineLobby();
  }
  buildNetLoadout(cls) {
    return {
      primary: { id: cls.primary, att: cls.patt || {}, camo: cls.pcamo || 'none' },
      secondary: cls.secondary ? { id: cls.secondary, att: cls.satt || {}, camo: cls.scamo || 'none' } : null,
      lethal: cls.lethal, tactical: cls.tactical, perks: cls.perks || [],
    };
  }
  // ---------- 联机：本地玩家的反馈闭环 ----------
  // 这一组四个回调（kill / death / hurt / respawn）在 `js/net/client.mjs` 里各有一个
  // 明确的调用点。以前一个都不存在 —— 于是联机里"打死了没有任何提示、死了没有画面、
  // 挨打没有方向"这三条同时成立，而服务端**早就把这些事件发出来了**（`g.onNetKill &&`
  // 那一句恒为空过，不报错）。
  onNetKill(ev) {
    const me = this.player;
    const myName = me && me.name;
    // hud.killfeed 收的是**实体**（它只读 .name / .isPlayer / .team 三格），而事件里
    // 只有名字，所以这里造两个同形的轻量对象 —— 改 HUD 的签名会让单机那条路一起动。
    const mk = (name) => {
      const r = this.net && this.net.remoteByName ? this.net.remoteByName(name) : null;
      return { name, isPlayer: name === myName, team: r ? r.team : (name === myName && me ? me.team : null) };
    };
    const killer = mk(ev.killer), victim = mk(ev.victim);
    this.hud.killfeed(killer, victim, escHtml(ev.weapon), ev.head);
    if (killer.isPlayer) {
      this.hud.popup(`${ev.pts ? '+' + ev.pts + '  ' : ''}击杀 ${escHtml(ev.victim)}`, '#d4f24a');
      // 逐条奖章：事件里的 tags 就是服务端 killScore 算出来的那几条，文案与分值问
      // js/match-rules.js:killMedals —— 与单机 js/mp.js:playerKill 共用同一张表。
      // 以前联机只有上面那一行总分，爆头/近战/远距离/复仇/连杀在屏幕上一条都没有。
      for (const m of killMedals(ev.tags)) this.hud.popup(`${m.label} +${m.points}`, '', true);
      this.audio.hit(true, !!ev.head);
      // 拾荒者 / 速愈在**我这台机器的**状态机上再跑一遍同一份规则（js/match-rules.js:
      // onKillPerks）：服务端那份管权威血量与弹药，这份管屏幕上的计数 —— 缺了它的症状是
      // "拾荒者一点反应没有"（弹药数永远是旧的，要等到下一次重生才对上）。
      for (const t of onKillPerks(me).texts) this.hud.popup(t, '#9cf');
    }
  }
  onNetDeath(ev) {
    const pl = this.player; if (!pl) return;
    this.dead = true;
    this.deathAt = performance.now() / 1000;
    this._respawnAsked = false;
    // 死亡镜头要转向击杀者。本机手上没有"是谁在打我"这件事（快照只给位置），事件给的
    // 是名字 ⇒ 按名字去远端表里找那一个人。找不到的（哨戒机枪 / 直升机 / 已经走了的人）
    // 留 null，那条路只有沉镜头 —— 指一个假方向比不指更糟。
    this.deathKiller = this.net && this.net.remoteByName ? this.net.remoteByName(ev.killer) : null;
    const el = document.getElementById('deathScreen');
    el.classList.remove('hidden');
    document.getElementById('killerInfo').innerHTML = ev.killer && ev.killer !== ev.victim
      ? `被 <b>${escHtml(ev.killer)}</b> 使用 ${escHtml(ev.weapon || '')} ${ev.head ? '爆头' : ''}击杀`
      : '自我击杀';
    if (document.pointerLockElement) document.exitPointerLock();
  }
  // 挨打的三件套。本地玩家在联机里的血量是**快照直接覆盖**的（js/net/predict.mjs 写 pl.hp），
  // 全程不走 takeDamage ⇒ 单机那份 takeDamage 里的三件（方向指示 / 痛感音 / 镜头冲击）
  // 一处都不会响。服务端把"这一拍掉了血"编成事件发过来（含限流），这里补上，只做表现。
  onNetHurt(ev) {
    const pl = this.player;
    if (!pl || !pl.alive || this.dead) return;
    this.audio.hurt();
    pl.punch(0.02);
    if (ev.from) this.hud.damageFrom(new THREE.Vector3(ev.from[0], ev.from[1], ev.from[2]));
  }
  onNetRespawn(ev) {
    const pl = this.player;
    if (!pl) return;
    // 装备回声：服务端在重生那一拍把**它手里那份**配装发回来。按它配枪是必需的 ——
    // 局内换了职业时，这一格才是"换装生效"的证据；没换时它保证"对局中捡来的枪不跟到
    // 重生"这条规矩在联机侧同样成立（单机是 js/mp.js:326 那句 else）。
    // **必须在 respawn 之前**：respawn 会 fullAmmo()，反过来的话新枪拿在手上、弹匣是照旧枪补的。
    if (ev.loadout) pl.equip(ev.loadout);
    pl.respawn(new THREE.Vector3(ev.pos[0], ev.pos[1], ev.pos[2]), ev.yaw);
    this.dead = false; this.deathKiller = null; this._respawnAsked = false;
    document.getElementById('deathScreen').classList.add('hidden');
    document.getElementById('respawnText').textContent = '';
    this.menu.hideClassSelect();
    document.getElementById('clickToPlay').classList.remove('hidden');
    this.lock();
  }
  // 死亡画面的倒计时与"提前部署"。
  // 重生这件事的主人是服务端（server/room.mjs 的 RESPAWN_DELAY）—— 这里只做两件客户端
  // 能做的事：把那个数字画出来，以及把"时间到了"转成一条上行请求。
  // 倒计时走完之前**不发**：服务端那条闸门会把它丢掉（server/room.mjs:requestRespawn），
  // 而"发了却没生效"在客户端是完全看不见的 —— 那正是这个仓库最讨厌的一类失效。
  netRespawnTick() {
    const el = document.getElementById('respawnText');
    if (!el) return;
    // 结算停摆之后不再请求重生：这一局的名单已经封盘，服务端（matchOverSent 闸）也不会认。
    let text = '';
    if (this.dead && !this.ending) {
      const delay = (this.net && this.net.welcome && this.net.welcome.respawnDelay) || 3;
      const left = delay - (performance.now() / 1000 - (this.deathAt || 0));
      if (left > 0) { text = `${Math.ceil(left)} 秒后重新部署…`; this._respawnAsked = false; }
      else {
        text = '按 [空格] 重新部署';
        if (!this._respawnAsked) { this._respawnAsked = true; if (this.net && this.net.requestRespawn) this.net.requestRespawn(); }
      }
    }
    // 只在**文字变了**的时候写 DOM：这条按渲染帧走，144Hz 上每帧赋一次 textContent
    // 是白掉帧的（记分板那条 6Hz 限流是同一个理由）。
    if (el.textContent !== text) el.textContent = text;
  }
  // 被闪光弹闪到。**一处定义**：单机的 js/combat.js:flashAt 在真人分支里先问 game.flashPlayer，
  // 联机的 flash 事件（js/net/client.mjs）也调它。两边各写一遍的话，联机与单机被闪的时长
  // 会各自漂移，而"感觉这次闪得短"是没人会去查的差异。
  flashPlayer(e, dur) {
    this.hud.flash(dur);
    this.audio.ring(Math.min(4, dur), 0.15);
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
        // 对局内聊天（差距 43）：Enter 全体、Y 队伍。**只在联机局里**开 ——
        // 单机没有第二个说话的人，开了就是个发不出去的输入框。断线后也不开：
        // 那时 Enter 归"按 Enter 重新连接"（netLostUi），抢过来会让重连这条路消失。
        if (this.net && !this.net.lost && !this.paused && !this.menu.overlayOpen && !this.hud.chatActive
          && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyY')) {
          this.hud.chatOpen(e.code === 'KeyY' ? 'team' : 'match');
          e.preventDefault();
        }
      }
    });
    window.addEventListener('keyup', e => { I.keys[e.code] = false; if (e.code === 'Tab' && this.state === 'play') this.hud.showScoreboard(false); });
    // 鼠标位移过滤：浏览器（尤其 Windows 版 Chrome/Edge）在指针锁定下偶尔会给出
    // 巨大的错误 movementX/Y（光标被拉回中心时的跳变、锁定刚生效时的第一帧等），
    // 表现为视角"闪现"。这里丢弃锁定后最初的事件，并剔除相对近期平均值异常巨大的单次跳变。
    const MF = this.mouseFilter = { since: 0, avg: 0, strikes: 0, lastT: 0 };
    window.addEventListener('mousemove', e => {
      if (document.pointerLockElement !== cv) return;
      // 打字时视角不动：鼠标还在指针锁里，不拦的话每敲一个字视角跟着甩（聊天输入
      // 是键盘优先的，鼠标这时归"别碰"，见 setupInput 里 chatActive 的另外两处）。
      if (this.hud && this.hud.chatActive) return;
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
      // 打字时点鼠标什么都不会发生（不重新锁、不开火）：瞄准那一枪打在聊天框上
      // 是这类叠加 UI 最容易被否掉的形状（键盘优先，鼠标这时是"别碰"）。
      if (this.hud && this.hud.chatActive) return;
      if (this.state === 'play' && !this.paused && document.pointerLockElement !== cv && !this.menu.overlayOpen && e.target === cv) { this.lock(); return; }
      if (document.pointerLockElement === cv) { I.buttons |= (1 << e.button); I.pressed['Mouse' + e.button] = true; }
    });
    window.addEventListener('mouseup', e => { I.buttons &= ~(1 << e.button); });
    window.addEventListener('wheel', e => { if (document.pointerLockElement === cv && !(this.hud && this.hud.chatActive)) I.wheel += Math.sign(e.deltaY); }, { passive: true });
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
      // hud.announce 走 innerHTML（HUD 别处要放标签），而这里拼进来的两串都来自**服务端**，
      // 所以一律过 escHtml（定义在文件头，别的 innerHTML 拼接点也用它）。
      const detail = (n.serverNote ? escHtml(n.serverNote) + ' · ' : '') + escHtml(n.lostReason) + '（服务器可能在更新）';
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
    // 打字时（对局内聊天开着）人要站住：W 是开聊天之前按下的，不清掉的话输入框里
    // 每敲一个字母人都往前挪一格，而服务端照单全收这些移动 —— 不报错、没人拦。
    // 清的是**本地这份**：服务端那边靠同一份空输入对齐（预测与权威一起站住）。
    if (this.hud && this.hud.chatActive) {
      for (const k in K) K[k] = false;
      for (const k in P) delete P[k];
      I.mdx = 0; I.mdy = 0; I.wheel = 0; I.buttons = 0;
    }
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
      // 遍历**所有**实体，而不是只遍历 this.bots —— 联机里真人都在 game.entities 里，
      // 而 bots 在联机里永远是空的 ⇒ 热成像对场上每一个人都不起作用（开镜一片漆黑，
      // 而"夜视/热成像坏了"没人报得清楚）。bots 本来就是 entities 的子集，不会漏也不会重。
      // 哨戒机枪 / 直升机只有 .mesh 没有 .model，被下面那句守卫跳过（它们是金属，不是热源）。
      for (const e of this.entities) {
        if (!e || !e.model || !e.model.root) continue;
        e.model.root.traverse(o => {
          if (!o.isMesh || !o.material || !o.material.emissive) return;
          if (!mats.has(o.material)) mats.set(o.material, [o.material.emissive.getHex(), o.material.emissiveIntensity]);
          // 活人比尸体亮一点：这一半只能按 mesh 写（共享材质时最后一个遍历到的赢 —— 那是
          // 既有的近似，不是这次要修的东西）；能不能恢复得回来不看它，看上面那份材质表。
          o.material.emissive.setHex(0xffffff);
          o.material.emissiveIntensity = e.alive ? 3 : 0.8;
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
    let raw = Math.min(0.25, this.clock.getDelta());   // 0.25 上限防"死亡螺旋"
    // 这一帧的**真实墙钟差**。raw 马上要被加法和 cap 改写，而 FPS 要报的是墙钟 ——
    // rdt 那份被截到 0.05，低帧率时会谎报成 20 FPS 封顶，所以两者都不能拿。
    const wall = raw;
    this.frames++;
    // 帧率上限(设置里 0=不锁):只跳帧不 sleep。锁出来的上限对**模拟**零影响 ——
    // 模拟是 60Hz 固定步长,与渲染解耦;但 getDelta 已经把跳过帧的 dt 消费掉了,
    // 不攒着补给放行帧的话,锁 60 会把模拟的墙钟预算也一起砍掉(整局变慢动作)。
    // 节拍锚(_capNext)只在**放行**时推进:跳过的帧不动它 —— 每帧都加的话,帧间隔
    // 比节拍长(本机卡)时锚点永远跑在前面,一帧都放不出去。容差 1.5ms 吸收 rAF
    // 抖动,锁 60 时差 0.1ms 的那拍也放行,否则节奏抖成 30/120 交替。
    const cap = this.settings.fpsCap | 0;
    if (cap > 0) {
      const now = performance.now();
      if (!this._capNext) this._capNext = now;
      // 跳过帧**不消费输入**:攒下的鼠标位移会整份交给下一个放行帧,与"两次 tick
      // 之间攒下的位移整份交给下一个 tick"是同一条规矩(mouseDelta 是累积量,不是
      // 每帧速率)。暂停期的排空也照旧成立 —— 解除暂停前必然至少放行过一帧,
      // 那一帧走的就是下面 paused 分支里的 snapshotInput()。
      if (now + 1.5 < this._capNext) { this._capPend = (this._capPend || 0) + raw; this.skipped++; return; }
      this._capNext = Math.max(this._capNext, now - 50) + 1000 / cap;
      raw = Math.min(0.25, raw + (this._capPend || 0)); this._capPend = 0;
    } else { this._capNext = 0; this._capPend = 0; }
    this.renders++;
    // FPS 计量在**放行帧**上(跳帧不进来),所以这个读数就是锁出来的实际帧率本身;
    // 喂的是 wall 而不是上面的 raw:raw 在放行帧上带着攒下的 _capPend,两者之和
    // 平均下来同样是墙钟,但走 wall 时"锁 30 的读数"不依赖累加期的边界。
    this.hud.meterFrame(wall);
    // 渲染侧仍拿改造前那份取值（原来整个循环就用 min(0.05, delta)），
    // 不让模拟步长偷偷改掉 composer/菜单动画的时间基准
    const rdt = Math.min(0.05, raw);
    setSoldierEye(this.camera.position);   // 士兵距离细节档的观察点(每帧一次,soldier 内部自己裁)
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
    // 死亡画面的倒计时**按渲染帧**走而不是按 sim 拍：它量的是墙钟（服务端那个
    // RESPAWN_DELAY 也是墙钟），而暂停时 sim 是停的、服务端的秒表却不停。
    if (this.net && this.state === 'play') this.netRespawnTick();
    this.netLostUi();
    if (this.netDebug) this.updateNetDebug(raw, wall);
    this.grade.uniforms.time.value = performance.now() * 0.001;
    this.composer.render(rdt);
  }
  update(dt, inp) {
    // ── 结算停摆 ── 胜负已出（game.ending 由单机 MPMatch.end 与联机的 matchOver 事件置上）
    // 之后，本局不该再有战斗：这一拍的输入整份换成"什么都没按"（人站住、枪停火、雷与
    // 连杀都叫不动），Bot 与投掷物也不再推进 —— 结算画面背后是一个冻住的世界，而不是
    // 一局没人管得住的混战。单机与联机共用这一个闸：联机的权威端在 matchOverSent 之后
    // 同样停摆（server/room.mjs:step），两边说的是同一件事。
    if (this.ending) inp = ENDING_INPUT;
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
    // 结算停摆的后半句：Bot/投掷物/拾取不再推进（世界冻住），但 mode.update 照走 ——
    // 联机的 NetClient.update 要靠它把服务端推送的规则读数（连杀槽/比分条）刷在屏幕上。
    if (!this.ending) {
      for (const b of this.bots) b.update(dt);
      for (const p of this.projectiles) p.update(dt);
      if (this.projectiles.some(p => !p.alive)) this.projectiles = this.projectiles.filter(p => p.alive);
      // 拾取
      this.updatePickups(dt, inp);
    }
    if (this.mode) this.mode.update(dt, inp);
    this.world.update(dt, this.time, this.camera.position);
    this.effects.update(dt, this.camera.position);
    this.hud.update(dt);
  }
  updatePickups(dt, inp) {
    const pl = this.player;
    // 过期与拾取的规则在 js/match-rules.js（单机 / 联机权威端共用同一份，距离与秒数
    // 只有那一处定义）。联机这边只**算**不**裁**：换没换成由权威端说了算，等
    // pickupTake / pickupAmmo 事件回来再改自己那份枪 —— 两头都裁的话，换枪留下的
    // 那把旧枪会被地上建出两个模型（本地一个、事件一个）。
    if (this.net) {
      const rn = pickupAction(this, pl, null, false);
      this.nearPickup = rn.near;
      if (this.mode && this.mode.interactPrompt) return;
      if (rn.near && pl && pl.alive) this.hud.prompt(`<b>F</b>拾取 ${buildName(rn.near.weaponId)}`);
      else if (!this.mode || !this.mode.interactPrompt) this.hud.prompt(null);
      return;
    }
    for (const p of pickupsExpire(this, dt)) this.scene.remove(p.mesh);
    const r = pickupAction(this, pl, inp);
    this.nearPickup = r.near;
    for (const a of r.ammo) {
      this.scene.remove(a.p.mesh);
      this.hud.popup('+弹药 ' + a.add, '#ccc');
      this.audio.click(2200, 0.05, 0.3);
    }
    if (r.swap) {
      const s = r.swap;
      if (s.old) this.spawnPickup(s.old.id, s.old.att, pl.pos, s.old.mag, s.old.reserve);
      this.scene.remove(s.p.mesh);
      this.audio.ui('equip');
    }
    if (this.mode && this.mode.interactPrompt) return;
    if (r.near && pl && pl.alive) this.hud.prompt(`<b>F</b>拾取 ${buildName(r.near.weaponId)}`);
    else if (!this.mode || !this.mode.interactPrompt) this.hud.prompt(null);
  }
}

import { WEAPONS } from './data.js';
function buildName(id) { return WEAPONS[id] ? WEAPONS[id].name : id; }

const game = new Game();
window.game = game;
game.init().catch(e => { console.error(e); document.getElementById('loadText').textContent = '初始化失败：' + e.message; });
