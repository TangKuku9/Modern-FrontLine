// HeadlessGame：没有渲染器、没有 DOM 的一份 game。
//
// 它复刻 main.js 里 Game 提供给 sim 模块的那一面（player.js / weapons.js /
// combat.js / ai.js 只通过 constructor(game) 注入的这个对象访问世界），
// 并刻意复刻 main.js:359-394 的 update() 主循环，去掉表现层三行
// （world.update 的灯光动画、effects.update 的粒子、hud.update 的 DOM）。
//
// 于是同一份 js/player.js + js/weapons.js + js/combat.js 既跑在浏览器里做预测，
// 也跑在这里做权威裁决 —— 一致性来自"同一份代码"，不是来自"两边小心对齐"。
import * as THREE from 'three';
import { makeStubs, deepRecorder } from './stubs.mjs';

// 吸收型 renderer。
//
// 为什么必须是 Proxy 而不是手写几个空方法：world.js:444 会
//   new THREE.PMREMGenerator(this.renderer).fromScene(...)
// 那是建图路径上唯一真正需要 GPU 的一步（烘焙环境光照 IBL）。手写类会在
// getRenderTarget() 上抛错，实测已经踩过。Proxy 吸收一切调用后，PMREM 拿到的
// 返回值全是空壳，烘焙结果无人读取 —— 对局物理只依赖 boxes/colliders，不读 IBL。
// 所以这一步在服务端可以安全地"什么都没做"，而 callCount 让我们能断言它确实没被依赖。
function makeAbsorbingRenderer(log) {
  const inner = deepRecorder('renderer', log, {
    'renderer.getRenderTarget': () => null,
    'renderer.getPixelRatio': () => 1,
    'renderer.getActiveCubeFace': () => 0,
    'renderer.getActiveMipmapLevel': () => 0,
    'renderer.capabilities.getMaxAnisotropy': () => 8,
    'renderer.properties.get': () => ({}),
    'renderer.state': {},
  });
  return inner;
}

export class HeadlessGame {
  constructor(opts = {}) {
    this.settings = Object.assign({ sens: 1.0, adsSens: 0.9, fov: 78, invertY: false }, opts.settings);
    this.scene = new THREE.Scene();
    this.vmScene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.05, 2500);
    this.vmCamera = new THREE.PerspectiveCamera(56, 16 / 9, 0.01, 10);
    const s = makeStubs();
    Object.assign(this, s, { stubLog: s.log });
    this.renderer = makeAbsorbingRenderer(s.log);
    this.effects.texFlash = {};
    this.time = 0;
    this.tick = 0;
    this.state = 'play';
    this.paused = false;
    this.godMode = false;
    this.nvg = false;
    this.thermalOn = false;
    this.scopeState = null;
    this.entities = [];
    this.bots = [];
    this.projectiles = [];
    this.pickups = [];
    this.noises = [];
    this.pathBudget = 3;
    this.playerSleeve = 'fab_ally';
    this.world = null;
    this.player = null;
    this.mode = null;
    this.events = [];
    const { mat } = requireMaterials();
    this.mat = mat;
  }

  // ---------- main.js:307-311 的同形实现 ----------
  makeNoise(pos, r, team, footstep = false) { this.noises.push({ pos: pos.clone(), r, team, t: this.time, footstep }); }
  onKill(killer, victim, weapon, head, info) {
    this.events.push({ e: 'kill', tick: this.tick, killer: killer && killer.name, victim: victim && victim.name, weapon, head: !!head });
    if (this.mode && this.mode.onKill) this.mode.onKill(killer, victim, weapon, head, info || {});
  }
  alertGroup(g, pos) { if (this.mode && this.mode.alertGroup) this.mode.alertGroup(g, pos); }
  addBot(bot) { this.bots.push(bot); this.entities.push(bot); return bot; }
  removeBot(bot) {
    if (bot.dispose) bot.dispose();
    this.bots = this.bots.filter(b => b !== bot);
    this.entities = this.entities.filter(b => b !== bot);
  }
  setThermal() {}

  // ---------- main.js:253-259 的同形实现（去天气、去音频环境音）----------
  async loadMap(id) {
    const { World } = await import('../js/world.js');
    const { MAPS } = await import('../js/maps.js');
    const def = MAPS[id];
    const w = new World(this, def);
    this.world = w;
    w.setupEnvironment(def.env);
    def.build(w, this);
    w.finalize();
    return w;
  }

  // ---------- main.js:359-394 主循环，去掉表现层 ----------
  step(dt, inp) {
    this.time += dt;
    this.tick++;
    this.pathBudget = 3;
    if (this.noises.length) this.noises = this.noises.filter(n => this.time - n.t < 0.6);
    const pl = this.player;
    if (pl) { if (pl.alive) pl.update(dt, inp); }
    for (const b of this.bots) b.update(dt);
    for (const p of this.projectiles) p.update(dt);
    if (this.projectiles.some(p => !p.alive)) this.projectiles = this.projectiles.filter(p => p.alive);
    if (this.mode && this.mode.update) this.mode.update(dt, inp);
    return this;
  }
}

let _materials = null;
function requireMaterials() {
  if (!_materials) throw new Error('HeadlessGame: 请先 await preloadMaterials()');
  return _materials;
}
export async function preloadMaterials() {
  _materials = await import('../js/materials.js');
  const t0 = Date.now();
  await _materials.initTextures();
  return { ms: Date.now() - t0, mat: _materials.mat };
}
export { deepRecorder };
