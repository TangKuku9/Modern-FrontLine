// HeadlessGame：没有渲染器、没有 DOM 的一份 game。
//
// 它复刻 main.js 里 Game 提供给 sim 模块的那一面（player.js / weapons.js /
// combat.js / ai.js 只通过 constructor(game) 注入的这个对象访问世界），
// 并刻意复刻 main.js:359-394 的 update() 主循环，去掉表现层三行
// （world.update 的灯光动画、effects.update 的粒子、hud.update 的 DOM）。
//
// 于是同一份 js/player.js + js/weapons.js + js/combat.js 既跑在浏览器里做预测，
// 也跑在这里做权威裁决 —— 一致性来自"同一份代码"，不是来自"两边小心对齐"。
import './browser-shim.mjs';            // js/textures.js 与 js/materials.js 要 document/canvas 才能 import
import * as THREE from 'three';
import { makeStubs, deepRecorder } from './stubs.mjs';
import { DEFAULT_CLASSES, DEFAULT_STREAKS } from '../js/data.js';

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
    // 权威端旗标（性能审查 N2）：共享代码（js/mp.js 的 Sentry/Heli）拿它区分"要不要建
    // 看得见的那一半"。判据用的 stubGame（test/heli-armor.mjs）不带这一格 ⇒ 照旧全量建模，
    // 那些读 .mesh 的判据不受影响。只有真的跑在这份 HeadlessGame 上的对局才走哑态。
    this.headless = true;
    this.scene = new THREE.Scene();
    // 故意不建 vmScene/vmCamera：WeaponSystem 没有 vmScene 就不构造 Viewmodel
    // （js/weapons.js:11）。于是"权威服务端偷偷跑了画面代码"会变成当场抛错，
    // 而不是安静地多算一份枪模。闸门里断言 game.player.ws.vm === null。
    this.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.05, 2500);
    // —— 两处"必须是真行为、不能是桩"的权威侧状态 ——
    // ① 火源列表。effects.addFireSource 的伤害是写在**第四个参数**（每拍回调）里的，
    //    桩不会去调它 ⇒ 燃烧瓶在联机里零伤害，而且不报错。浏览器侧那份实现挂在
    //    Effects.update 里（渲染帧驱动），服务端没有 Effects，只能在 step 里自己推。
    //    列表**挂在实例上**（不是模块级）：一个进程跑多间房时，模块级会让火跨房间烧人。
    // ② 伤害流水账：助攻要用"谁对谁打了多少"，而这件事只有权威端有（客户端那份是预测）。
    const fires = this.fires = [];
    const s = makeStubs({
      'effects.addFireSource': (pos, r = 0.5, dur = Infinity, dmg = null) => {
        const f = { pos: pos && pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z), r, t: 0, dur, dmg, acc: 0 };
        fires.push(f);
        return f;
      },
    });
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
    // mp.js / ai.js 要求的其余权威状态（实测枚举得出，见 spawnPickup 上方注释）
    this.profile = { xp: 0, classes: JSON.parse(JSON.stringify(DEFAULT_CLASSES)), streaks: [...DEFAULT_STREAKS], selClass: 0, campaignBest: null };
    this.grade = { uniforms: { nvg: { value: 0 }, thermal: { value: 0 }, hurt: { value: 0 }, wp: { value: 0 }, vig: { value: 0.35 } } };
    this.input = { keys: {}, pressed: {}, mdx: 0, mdy: 0, buttons: 0, wheel: 0 };
    this.dead = false;
    this.deathKiller = null;
    this.ending = false;
    this.botDmgMul = 1;
    this.nightVisionForBots = false;
    this.world = null;
    this.player = null;
    this.mode = null;
    this.events = [];
    this.dmgBy = new Map();          // 受害者 → Map(攻击者 → 累计伤害)。助攻的唯一原料。
    const { mat } = requireMaterials();
    this.mat = mat;
  }

  // ---------- main.js:307-311 的同形实现 ----------
  makeNoise(pos, r, team, footstep = false) { this.noises.push({ pos: pos.clone(), r, team, t: this.time, footstep }); }
  // 权威端的伤害账本（受害者 → 攻击者 → 累计伤害）。**只在服务端这一份 game 上存在**：
  // Player.takeDamage 里那句 `if (this.game.onDamage)` 在浏览器侧取到 undefined，
  // 于是单机与客户端预测都不受影响；回滚重放也走不到它（weapon-state 的 fire 在 replay
  // 时直接 continue —— 那一发的伤害服务端早就裁过）。这一条是助攻的**唯一**原料：
  // 没有它，助攻只能靠猜（记分板那一列会永远空着，而没人会当 bug 报）。
  // 与单机的关系：单机是把这个 Map 挂在 Bot 身上（js/ai.js:dmgTaken），真人不适用。
  onDamage(victim, dmg, info) {
    const a = (info && info.attacker) || null;
    if (!a || a === victim || !(dmg > 0)) return;
    let m = this.dmgBy.get(victim);
    if (!m) this.dmgBy.set(victim, m = new Map());
    m.set(a, (m.get(a) || 0) + dmg);
    if (this.dmgBy.size > 64) this.dmgBy.delete(this.dmgBy.keys().next().value);
  }
  onKill(killer, victim, weapon, head, info) {
    this.events.push({ e: 'kill', tick: this.tick, killer: killer && killer.name, victim: victim && victim.name, weapon, head: !!head });
    if (this.mode && this.mode.onKill) this.mode.onKill(killer, victim, weapon, head, info || {});
  }
  // ai.js 不看返回值，但**判据要看**：它是"这一跳真的接通了、扩散了几个人"的唯一读数。
  // 一个不返回值的转发会让 test/mp-rules.mjs 只能去数副作用，而那正是"量空气"的形状。
  alertGroup(g, pos) { return this.mode && this.mode.alertGroup ? this.mode.alertGroup(g, pos) : undefined; }
  addBot(bot) { this.bots.push(bot); this.entities.push(bot); return bot; }
  removeBot(bot) {
    if (bot.dispose) bot.dispose();
    this.bots = this.bots.filter(b => b !== bot);
    this.entities = this.entities.filter(b => b !== bot);
  }
  setThermal() {}
  lock() {}

  // 下面这几项是 mp.js / ai.js 额外要求 game 具备的形状（实测枚举
  // grep -ohE "game\.[a-zA-Z_]+" js/mp.js js/ai.js 得出）：
  //   grade.input.lock.dead.deathKiller.ending.profile.saveProfile.spawnPickup
  //   botDmgMul.nightVisionForBots.pathBudget
  // 服务端专用对局里它们全都是权威状态的一部分，不能省。
  saveProfile() { this.profileSaved = (this.profileSaved || 0) + 1; }

  // 与 main.js:317-327 同形：掉落武器是真实体，拾取属权威裁决，不能只留在客户端。
  // 模型不建（性能审查 N2）：权威端只读 p.pos —— 拾取距离（x/z）与事件坐标；地上枪的
  // 哑模型由客户端按 'pickup' 事件自己建。buildGun 是仓库里最重的建模函数（几十个
  // mesh/geometry/material），掉落规则 60% 概率 × 14 把上限反复建/丢，server 上全是白工。
  // y 仍按地面吸附（与旧版同一句 groundHeight + 0.06）：事件坐标就是客户端摆模型的唯一
  // 依据，少这一步的话枪会埋进地/悬在半空。旧版还顺手抽了一次 crand 转枪身 —— 那是
  // 画面流（js/rng.js 文件头的分工），权威端不转它了。
  spawnPickup(weaponId, att, pos, mag, reserve) {
    const p = {
      weaponId, att: att || {}, mesh: null,
      pos: new THREE.Vector3(pos.x, (this.world ? this.world.groundHeight(pos.x, pos.z, pos.y + 1, 0.2) : 0) + 0.06, pos.z),
      mag, reserve, t: 0,
    };
    this.pickups.push(p);
    if (this.pickups.length > 14) {
      const o = this.pickups.shift();
      // 溢出回收**必须回告**：客户端地上那把枪是照 'pickup' 事件建的哑模型，收掉却不发
      // pickupGone 的话它就永远留在地上 —— 走过去没提示、按键无反应；而且它还参与
      // pickupAction 的"身边有枪"提示计算，屏上的提示与实际能捡的东西从此对不上。
      // 服务端在这里只编事件，转发与下发在 server/room.mjs 的 drainKillFeed（与 30 秒
      // 过期是同一条出口、同一个事件型）。单机（main.js:798）不需要这一步：它自己是权威。
      this.events.push({ e: 'pickupGone', id: o.netId, why: 'overflow' });
    }
    return p;
  }

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
  // pairs = [{ pl, inp }]：联机时每个真人吃自己那份输入。
  // 不传就是单机老用法（只有 game.player 一个人）—— 单人形式正是"这台机器上
  // 只有一个玩家"的假设，服务端必须由调用方把列表交进来。
  step(dt, inp, pairs) {
    this.time += dt;
    this.tick++;
    this.pathBudget = 3;
    // 噪声表原地压实（性能审查 N1）：曾经每拍 filter 一个新数组 —— 只要场上有枪声/脚步
    // （常态成立）这就是 60 次/秒的稳定分配。谓词与幸存次序逐字不变。
    if (this.noises.length) {
      let w = 0;
      for (let i = 0; i < this.noises.length; i++) {
        const n = this.noises[i];
        if (this.time - n.t < 0.6) this.noises[w++] = n;
      }
      this.noises.length = w;
    }
    for (const p of (pairs || (this.player ? [{ pl: this.player, inp }] : []))) {
      if (p.pl.alive) p.pl.update(dt, p.inp);
    }
    for (const b of this.bots) b.update(dt);
    for (const p of this.projectiles) p.update(dt);
    if (this.projectiles.some(p => !p.alive)) this.projectiles = this.projectiles.filter(p => p.alive);
    // 火源：与浏览器侧 Effects.update 的那一段同构（判据是"掉落伤害总额一样"而不是"逐拍一样"：
    // 伤害式是 `35 * dt` 的累加，两端各自的 dt 之和相同 ⇒ 总额相同）。
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t += dt; f.acc += dt;
      if (f.t > f.dur) { this.fires.splice(i, 1); continue; }
      if (f.dmg) f.dmg(dt, f);
    }
    if (this.mode && this.mode.update) this.mode.update(dt, inp);
    return this;
  }
}

let _materials = null;
function requireMaterials() {
  if (!_materials) throw new Error('HeadlessGame: 请先 await preloadMaterials()');
  return _materials;
}
let _materialsPromise = null;
export function preloadMaterials() {
  // 只烘一次：材质字典 MATS/TEX 是 materials.js 的模块级单例，同一进程里跑第二场
  // 对局不该重造一遍 —— 游戏自己（main.js:94）也是按单例用的
  if (!_materialsPromise) {
    _materialsPromise = (async () => {
      const mod = await import('../js/materials.js');
      _materials = mod;
      const t0 = Date.now();
      await mod.initTextures();
      return { ms: Date.now() - t0, mat: mod.mat };
    })();
  }
  return _materialsPromise;
}
export { deepRecorder };
