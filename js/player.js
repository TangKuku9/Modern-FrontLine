// 玩家控制器
import * as THREE from 'three';
import { WeaponSystem } from './weapons.js';
import { hitTestPlayer, LEAN_DIST } from './combat.js';
import { clamp, damp, lerp, DEG, entStream } from './util.js';
import { WEAPONS, LETHALS, TACTICALS } from './data.js';

// 回滚重放的状态日记本字段清单。
// 漏一个字段 = 那一维带着两边不同的初值继续分叉，而且没人会报错，只有手感怪。
// test/net-journal.mjs 遍历 Player / WeaponState 的 own keys 检查覆盖率，新增字段
// 要么登记进来，要么进 J_EXCLUDE 并写清理由。
export const J_PL = ['yaw', 'pitch', 'hp', 'crouchT', 'proneT', 'leanT', 'slideT', 'eyeSmooth', 'dmgT', 'shakeT', 'shakeAmt',
  'punchV', 'landDip', 'stepDist', 'revealT', 'sprintLock', 'stunT', 'interactHold',
  'alive', 'crouching', 'proning', 'sprinting', 'sliding', 'onGround'];
export const J_WS = ['state', 'stateT', 'stateDur', 'adsT', 'cool', 'cycleT', 'triggerHeld', 'rp', 'lastShot',
  'shotsInRow', 'bobPhase', 'sprintT', 'equipT', 'cooking', 'cookT', 'reloadStage', 'meleeHit'];
export const J_EXCLUDE = {
  // —— Player ——
  game: '环境引用', ws: '由 J_WS + ammo + cur 覆盖', isPlayer: '常量', name: '常量', team: '常量',
  // 视角设置（每人一份，见下面 sanitizeViewSettings）。**不进日记本**：它是进场时定的
  // 常量，回滚重放跑的是同一个 pl 对象、读的是同一份 sens，重演出来的 yaw 增量逐位相同。
  // 把它记进 J_PL 反而有害 —— applyJournal 会在每次回滚时把它拨回"那一拍的旧值"，
  // 而它在对局中根本不该变（中途改设置会走另一条路重发 join，不是靠日记本）。
  sens: '进场时定（每人一份），对局中不变',
  adsSens: '同上',
  invertY: '同上',
  maxHp: '常量', perks: '装备时定，对局中不变', stats: '服务端裁决，客户端只显示计数',
  lastAttacker: '对象引用，只用于 HUD', radius: '常量',
  rng: '私有流实例（对象本身不可复制），要存的是游标 —— 走 j.rngState',
  rngSeed: '常量（进场时定）', rngTag: '常量（cid）', rng0: '常量（流的起点，重生时拨回这里）',
  // 下面三个是 test/net-journal.mjs 那道覆盖率守卫第一次跑就点出来的历史漏登记：
  // 那时没有任何东西为"新字段没进 J_PL / 没进 J_EXCLUDE"变红，所以它们一路躲过了审查。
  dmgMul: 'spawn 时定，对局中不变（联机恒为 1，战役里给机器人加权）',
  loadout: '装备这份由服务端按表重建并经 welcome 回声（见 js/loadout.mjs），对局中不变；stats/弹药从它派生后各自进日记本',
  // —— WeaponState ——
  vm: '视图模型（第一人称枪模），只在有 vmScene 的一侧存在（js/weapons.js:14），不参与裁决 —— P0-2 拆它的本意就是这个',
  lethal: 'count 走 journal（id/max 是装备）', tactical: 'count 走 journal',
  camPos: 'updateCamera 每拍重算', aimYaw: 'updateCamera 每拍重算', aimPitch: 'updateCamera 每拍重算',
  eyeH: '常量',
  // —— WeaponState（game 与 Player 同名条目共用）——
  owner: '环境引用', cur: 'journal 单独登记（j.cur）',
  slots: 'journal 单独登记（j.ammo），stats 由 id+att 派生',
  loadoutVersion: '视图模型的重建计数，不参与裁决', sink: '表现出口',
  aimAccum: '只喂视图模型摆动', vmKick: '视图模型', vmRot: '视图模型', fx: '视图模型',
  replay: '每次 update 开头按 opts 重设，不跨拍存活', grenade: 'journal 单独登记（j.grenade）',
  nadeMode: 'journal 单独登记（j.nadeMode）—— CS 制投掷手上切出的雷种',
};

// 重放期间挂到 game 上的静音替身：把这一拍会碰的所有外部出口变成空操作。
// 逐个调用点加 if 是守不住的 —— 以后谁再加一句 game.audio.xxx() 就会漏掉。
// 计数是为了让"重放没出声"这条断言不空转：test/rollback.mjs 先看 n>0，
// 确认重放确实撞过这些出口，再断言真出口一次都没被调用。
function muteSink(counter) {
  const noop = () => {};
  return new Proxy({}, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k === 'calls') return counter;
      counter.n++;
      return noop;
    },
  });
}
const _mute = { audio: { n: 0 }, hud: { n: 0 } };
const _muteProxy = { audio: muteSink(_mute.audio), hud: muteSink(_mute.hud) };
export const muteCounts = _mute;

// ── 视角设置：**每人一份**，而且必须进协议 ──────────────────────────────────
// 视角积分在两端跑的是同一份代码（下面 _sim 里那两行），而它乘的是 `sens`。
// 以前这份 sens 只有一个来源：`game.settings`，而服务端的 HeadlessGame 用的是硬编码
// 默认值 `{sens:1.0, adsSens:0.9, invertY:false}` —— NetRoom 建它时不传设置、join 帧
// 也不带设置。于是调过滑条的玩家在联机里被钉死在 1.0：本地按自己的 sens 预测、
// 服务端按 1.0 积分、快照每 20Hz 把 yaw/pitch 覆盖回来（js/net/predict.mjs），
// 表现为持续的"甩枪被弹回"；invertY 用户更糟 —— 本地上下反转、权威端不反转，垂直瞄准打架。
//
// 为什么不能把 sens 挂到 game.settings 上：那是**房间**级别的一份（一个进程一份
// HeadlessGame），而一个房间里两个人的灵敏度可以不同 —— 挂上去就是"先来的人改掉了
// 后来者的手感"，而且这种改动不会报错，只会让某个人莫名其妙打不准。
//
// 范围与 js/menu.js 的两个滑条逐字一致（sens 0.2~3.0、adsSens 0.3~1.5）。服务端只认
// 这一份清洗结果（客户端报什么就信什么的话，一个 sens=1e9 的客户端能把视角积分炸成 NaN，
// 而 NaN 会顺着快照传回给所有渲染它的人）。这里不拒绝非法值 —— 夹进合法区间比
// "因为一个人填了怪数值就把他的设置整个丢掉"更接近玩家的意图，且代价有上界。
export const VIEW_LIMITS = { sens: [0.2, 3.0], adsSens: [0.3, 1.5] };
export function sanitizeViewSettings(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    sens: num(src.sens, 1.0, VIEW_LIMITS.sens[0], VIEW_LIMITS.sens[1]),
    adsSens: num(src.adsSens, 0.9, VIEW_LIMITS.adsSens[0], VIEW_LIMITS.adsSens[1]),
    invertY: src.invertY === true,
  };
}

// 客户端那一侧：从 game.settings 取一份要交给服务端的视角设置。
// 与 sanitizeViewSettings 成对 —— 客户端交、服务端收并重建。两处各写一遍形状的话，
// 改一处的症状是"新设置项在服务端永远是默认值"，而那看起来像"这个功能没做"。
export function viewSettingsOf(game) {
  const s = (game && game.settings) || {};
  return { sens: s.sens, adsSens: s.adsSens, invertY: !!s.invertY };
}

export class Player {
  constructor(game, opts) {
    this.game = game;
    this.isPlayer = true;
    this.name = opts.name || '你';
    this.team = opts.team || 'A';
    this.pos = opts.pos.clone();
    this.vel = new THREE.Vector3();
    this.yaw = opts.yaw || 0; this.pitch = 0;
    // 视角设置：null = "没给过我一份，用房间默认那份"（单机与老客户端走这条）。
    // 联机进房时由 server/room.mjs:addClient 用 sanitizeViewSettings 从 join 帧重建后挂上。
    this.sens = null; this.adsSens = null; this.invertY = null;
    this.maxHp = 100; this.hp = 100; this.alive = true;
    this.crouchT = 0; this.crouching = false; this.proneT = 0; this.proning = false;
    this.leanT = 0;                                   // 探头倾量：-1 左 … +1 右（Q/E），damp 平滑
    this.sprinting = false; this.sliding = false; this.slideT = 0;
    this.onGround = true; this.eyeH = 1.62; this.eyeSmooth = this.pos.y + 1.62;
    // 视点与视线：updateCamera 每拍算一次，弹道从这里取。联机时每个玩家各有一份，
    // 所以它必须是玩家状态而不是"去看那块相机"。
    this.camPos = new THREE.Vector3(this.pos.x, this.eyeSmooth, this.pos.z);
    this.aimYaw = this.yaw; this.aimPitch = 0;
    this.dmgT = 99; this.shakeT = 0; this.shakeAmt = 0; this.punchV = 0; this.landDip = 0;
    this.stepDist = 0; this.revealT = 0;
    this.perks = new Set(opts.perks || []);
    this.stats = { kills: 0, deaths: 0, shots: 0, hits: 0, headshots: 0, score: 0, streak: 0, assists: 0, captures: 0 };
    this.dmgMul = opts.dmgMul || 1;
    // 私有玩法流：后坐横向（写 pl.yaw）、弹道散布、震屏（进视线）这三处随机数直接决定命中，
    // 不能跟公共流走 —— 服务端同一拍里还替别人抽数，客户端回滚只重放自己那份，两端就会从
    // 同一条流的不同位置取值。为什么要分开见 js/rng.js:entStream 的注释。
    // 两端用同一对播种值：服务端是 (room.seed, cid)，客户端从 welcome 里拿到的就是这两个。
    this.rng = entStream(opts.rngSeed >>> 0, opts.rngTag >>> 0);
    this.rngSeed = opts.rngSeed >>> 0; this.rngTag = opts.rngTag >>> 0;
    this.rng0 = this.rng.state();      // 重生要把流拨回这一点，见 respawn()
    this.ws = new WeaponSystem(game, this);
    this.lethal = null; this.tactical = null;
    this.lastAttacker = null;
    this.interactHold = 0;
    this.radius = 0.35;
  }
  hasPerk(id) { return this.perks.has(id); }
  equip(loadout) {
    // loadout: {primary:{id,att,camo}, secondary:{...}, lethal, tactical, perks}
    this.perks = new Set(loadout.perks || []);
    const list = [loadout.primary];
    if (loadout.secondary) list.push(loadout.secondary);
    this.ws.setLoadout(list);
    const L = LETHALS.find(l => l.id === loadout.lethal), T = TACTICALS.find(t => t.id === loadout.tactical);
    this.lethal = L ? { id: L.id, name: L.name, count: L.count + (loadout.extraLethal || 0), max: L.count + (loadout.extraLethal || 0) } : null;
    this.tactical = T ? { id: T.id, name: T.name, count: T.count + (loadout.extraTac || 0), max: T.count + (loadout.extraTac || 0) } : null;
    this.loadout = loadout;
  }
  respawn(pos, yaw) {
    this.pos.copy(pos); this.vel.set(0, 0, 0); this.yaw = yaw; this.pitch = 0;
    this.hp = this.maxHp; this.alive = true; this.dmgT = 99;
    this.crouchT = 0; this.crouching = false; this.proneT = 0; this.proning = false; this.sliding = false;
    this.leanT = 0;
    this.eyeSmooth = pos.y + 1.62; this.stats.streak = 0;
    this.ws.fullAmmo();
    if (this.lethal) this.lethal.count = this.lethal.max;
    if (this.tactical) this.tactical.count = this.tactical.max;
    this.ws.state = 'switch'; this.ws.stateT = 0; this.ws.stateDur = 0.5; this.ws.adsT = 0;
    // 私有流跟着一起归位：两端都是在"服务端播报重生"这同一个事件上调用本函数的，所以这里是
    // 唯一一处能把流的位置重新对齐的时刻 —— 死亡期间本机可能整拍不去演算这个人（见 main.js
    // 的死亡视角分支），抽数次数会和权威端错开，不归零就会让死后第一枪的后坐永久对不上。
    this.rng.setState(this.rng0);
  }
  eyePos(out) {
    const l = this.leanT * LEAN_DIST;
    return out.set(this.pos.x + Math.cos(this.yaw) * l, this.pos.y + this.curEye(), this.pos.z - Math.sin(this.yaw) * l);
  }
  // 胸口 = 躯干盒中心：探头时躯干盒按半量侧移（js/combat.js:hitTestPlayer），这里跟同一份 ——
  // Bot 瞄胸、近战够不够得着，量的都是"躯干当下在哪"。
  chestPos(out) {
    const l = this.leanT * LEAN_DIST * 0.5;
    return out.set(this.pos.x + Math.cos(this.yaw) * l, this.pos.y + this.curEye() - 0.4, this.pos.z - Math.sin(this.yaw) * l);
  }
  // 视线高度三层：站 1.62 → 蹲 1.05 → 趴 0.45。proneT 是外层 —— 趴下时 crouching 也为真
  // （两层同时过渡，视线走的是一条连续曲线而不是折线），所以趴这一层必须最后叠。
  curEye() { return lerp(lerp(1.62, 1.05, this.crouchT), 0.45, this.proneT); }
  forward(out) { return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); }
  // 命中盒在这里只剩"把当下姿态喂给公共定义"这一件事 —— 延迟补偿要拿历史姿态调同一个
  // 函数（js/combat.js:hitTestPlayer），所以它必须是纯函数而不是这个类的方法。
  hitTest(o, d, maxT) {
    return hitTestPlayer(this.pos.x, this.pos.y, this.pos.z, this.curEye(), this.yaw, this.proneT > 0.5 ? 1 : 0, this.leanT, o, d, maxT);
  }
  takeDamage(dmg, info) {
    if (!this.alive || this.game.godMode) return false;
    this.hp -= dmg * this.dmgMul;
    this.dmgT = 0;
    this.lastAttacker = info.attacker;
    // 权威端的伤害流水账（助攻的原料）。浏览器侧没有这个钩子 ⇒ 单机与客户端预测都不受影响；
    // 回滚重放也走不到这儿（weapon-state 的 fire 在 replay 时直接 continue）。
    if (this.game.onDamage) this.game.onDamage(this, dmg * this.dmgMul, info);
    if (info.attacker && info.attacker.pos) this.game.hud.damageFrom(info.attacker.pos);
    else if (info.point) this.game.hud.damageFrom(info.point);
    if (!info.burn || Math.random() < 0.1) this.game.audio.hurt();
    this.punch(0.02);
    if (this.hp <= 0) {
      this.hp = 0; this.alive = false; this.stats.deaths++;
      this.ws.onDeath();
      // 相机那一半：写 cam.fov 的只有 updateCamera（挂在 update 末尾），而死了就不会再 update
      // —— 这一行不写，死亡视角就一直停在 ADS 那个窄视野里。只有本机玩家有那块相机。
      if (this.game.player === this && this.game.camera) {
        this.game.camera.fov = this.game.settings.fov;
        this.game.camera.updateProjectionMatrix();
      }
      this.game.onKill(info.attacker, this, info.weapon, info.head);
      return true;
    }
    return false;
  }
  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a); this.shakeT = 0.6; }
  punch(a) { this.punchV += a; }
  cancelSprint() { this.sprinting = false; this.sprintLock = 0.25; }
  // 趴姿起身：天花板决定起到哪一层 —— 站得起来就站，只够蹲就退到蹲，再低就留在趴姿
  // （输入被礼貌地拒绝，不给反馈音）。阈值 = 目标姿态的碰撞高 + 5 cm 余量
  // （站 1.8/蹲 1.25），与下面"蹲着不能站起"的检查同一把尺（world.ceilingHeight）。
  tryRise() {
    const c = this.game.world.ceilingHeight(this.pos.x, this.pos.z, this.pos.y, this.radius);
    if (c >= this.pos.y + 1.85) { this.proning = false; this.crouching = false; }
    else if (c >= this.pos.y + 1.3) { this.proning = false; this.crouching = true; }
  }

  // —— 回滚重放：把"我自己"完整拨回某一拍 ——
  // 在 update 之前取，记的就是"这一拍开始时的我"，重放时才和当初逐字段同起点。
  journal() {
    const ws = this.ws, j = { time: this.game.time, cur: ws.cur, grenade: ws.grenade ? ws.grenade.type : null,
      nadeMode: ws.nadeMode ? { kind: ws.nadeMode.kind, id: ws.nadeMode.id } : null };
    // 私有流的游标必须跟着日记本走：回滚重放会把后坐/散布那几发重新抽一遍，流不退回
    // 同一位置就重算不出服务端那一拍的数（这才是"每实体一条流"能被回滚用上的前提）。
    j.rngState = this.rng.state();
    for (const k of J_PL) j[k] = this[k];
    for (const k of J_WS) j['ws.' + k] = ws[k];
    j.pos = [this.pos.x, this.pos.y, this.pos.z];
    j.vel = [this.vel.x, this.vel.y, this.vel.z];
    j.ammo = ws.slots.map(s => [s.mag, s.reserve]);
    j.lethal = this.lethal ? this.lethal.count : -1;
    j.tactical = this.tactical ? this.tactical.count : -1;
    return j;
  }
  applyJournal(j) {
    const ws = this.ws;
    this.game.time = j.time;
    this.rng.setState(j.rngState);            // 流跟着回滚走，见 journal() 里那行注释
    for (const k of J_PL) this[k] = j[k];
    for (const k of J_WS) ws[k] = j['ws.' + k];
    this.pos.set(j.pos[0], j.pos[1], j.pos[2]);
    this.vel.set(j.vel[0], j.vel[1], j.vel[2]);
    ws.cur = j.cur;
    for (let i = 0; i < j.ammo.length && i < ws.slots.length; i++) {
      ws.slots[i].mag = j.ammo[i][0]; ws.slots[i].reserve = j.ammo[i][1];
    }
    ws.grenade = j.grenade ? { type: j.grenade } : null;
    ws.nadeMode = j.nadeMode ? { kind: j.nadeMode.kind, id: j.nadeMode.id } : null;
    if (this.lethal) this.lethal.count = j.lethal;
    if (this.tactical) this.tactical.count = j.tactical;
  }

  update(dt, input, opts = {}) {
    // replay：把这一拍重新演一遍给"回滚后的我"看。自身状态与随机流照原样推进，
    // 但所有外部出口（伤害、弹道查询、特效、声音、HUD、抛射物、噪声）关掉 ——
    // 那些事服务端已经裁过一次，重演第二遍就是双倍伤害 + 双倍音效。
    const replay = !!opts.replay;
    if (replay) return this._updateReplay(dt, input);
    return this._sim(dt, input, false);
  }
  _updateReplay(dt, input) {
    const game = this.game;
    const a = game.audio, h = game.hud;
    game.audio = _muteProxy.audio; game.hud = _muteProxy.hud;
    game.replaying = true;                        // main.js:makeNoise 认这个旗
    try {
      this._sim(dt, input, true);
    } finally {
      game.audio = a; game.hud = h; game.replaying = false;
    }
  }
  _sim(dt, input, replay) {
    const opts = { replay };
    const game = this.game, world = game.world;
    if (!this.alive) return;
    // 视角
    const ws = this.ws;
    // 插值曲线必须跟 updateCamera 里的相机 zoom 一致（同用 adsT²）：不一致时开镜过程中
    // 视野还没收到位、灵敏度已经先降了，手感是"手比眼慢"。
    const zoom = lerp(1, ws.w ? ws.w.stats.zoom : 1, ws.adsT * ws.adsT);
    // 每人一份的视角设置，`??` 退回房间默认那份（单机 / 没带设置的客户端）。
    // 为什么 fallback 必须在**读的那一刻**发生而不是在构造时定死：单机与联机共用这一个类，
    // 联机那份设置是 addClient 从 join 帧重建后挂上来的（在那之前构造函数已经跑过了）。
    const sens = (this.sens ?? game.settings.sens) * 0.0022 * (ws.adsT > 0.5 ? (this.adsSens ?? game.settings.adsSens) / Math.pow(zoom, 0.85) : 1);
    this.yaw -= input.mdx * sens;
    this.pitch -= input.mdy * sens * ((this.invertY ?? game.settings.invertY) ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.5, 1.5);
    // 姿态
    // Z：趴/起。趴下永远允许（只会更低），起身走 tryRise 的天花板分层。
    // 趴下时 crouching 一并置真 —— 视线与碰撞高度是两层 lerp 叠出来的，趴这层
    // 建在蹲那层之上；起身时哪层退、哪层留全由 tryRise 一次性定好。
    if (input.pronePressed) {
      if (this.proning) this.tryRise();
      else {
        this.proning = true; this.crouching = true; this.sprinting = false;
        this.sliding = false; this.slideT = 0;
        game.audio.click(430, 0.25, 0.25);
      }
    }
    if (input.crouchPressed) {
      if (this.proning) {
        // 趴着按蹲：上一层到蹲。天花板不足蹲高（1.25 m + 余量）就留在趴姿 —— 同一处的
        // 蹲伏起身检查只挡"蹲→站"，趴这一层的起身处境更苛刻，必须自己把关。
        if (world.ceilingHeight(this.pos.x, this.pos.z, this.pos.y, this.radius) >= this.pos.y + 1.3) {
          this.proning = false; this.crouching = true;
        }
      } else if (this.sprinting && this.onGround && !this.sliding) {
        this.sliding = true; this.slideT = 0.75; this.crouching = true;
        const f = new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize();
        this.vel.x = f.x * 9.5; this.vel.z = f.z * 9.5;
        game.audio.click(500, 0.3, 0.3);
      } else this.crouching = !this.crouching;
    }
    if (this.sliding) {
      this.slideT -= dt;
      if (this.slideT <= 0) { this.sliding = false; }
    }
    // 探头（Q/E）：按住的侧倾，leanT ∈ [-1,1] 阻尼跟随。趴/滑铲/冲刺时不探 —— 前两个的
    // 姿态动画与侧倾打架，冲刺的相机已经在晃，再叠一个横滚读不出来。探头的表现全部
    // 派生自 leanT（camPos 侧移、相机横滚、命中盒侧移、快照 LeanL/R 位），这一维是唯一的源头。
    // 距离与碰撞的关系见 js/combat.js:LEAN_DIST —— 它必须留在碰撞半径之内，这里不改距离。
    const leanIn = (input.leanR ? 1 : 0) - (input.leanL ? 1 : 0);
    const canLean = leanIn !== 0 && !this.proning && this.proneT < 0.5 && !this.sliding && !this.sprinting;
    this.leanT = damp(this.leanT, canLean ? leanIn : 0, 14, dt);
    // 移动输入
    const fx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const fz = (input.fwd ? 1 : 0) - (input.back ? 1 : 0);
    this.sprintLock = (this.sprintLock || 0) - dt;
    // 趴着不冲刺：趴这层把冲刺整个关掉（匍匐是最低速的一档，Shift 在趴姿下没有意义）。
    const wantSprint = input.sprint && fz > 0 && this.sprintLock <= 0 && ws.adsT < 0.3 && !this.sliding && !this.proning;
    if (wantSprint && !this.sprinting) { this.sprinting = true; this.crouching = false; if (ws.state === 'reload' && !this.hasPerk('sleight')) ws.state = 'idle'; }
    if (!wantSprint) this.sprinting = false;
    // 头顶空间检查（蹲伏时不能站起）
    if (!this.crouching && this.crouchT > 0.1) {
      const c = world.ceilingHeight(this.pos.x, this.pos.z, this.pos.y, this.radius);
      if (c < this.pos.y + 1.85) this.crouching = true;
    }
    this.crouchT = damp(this.crouchT, this.crouching ? 1 : 0, 12, dt);
    this.proneT = damp(this.proneT, this.proning ? 1 : 0, 9, dt);
    const mob = ws.w ? ws.w.stats.mobility : 1;
    let speed = 4.7 * mob;
    if (this.sprinting) speed = 7.1 * mob * (this.hasPerk('doubletime') ? 1.08 : 1);
    // 趴这层先于蹲判：趴下时两层都在（proneT、crouchT 都 → 1），速度只能取更低的那档。
    else if (this.proneT > 0.5) speed = 1.4 * mob;
    else if (this.crouchT > 0.5) speed = 2.4 * (this.hasPerk('doubletime') ? 1.3 : 1);
    speed *= lerp(1, 0.55, ws.adsT);
    if (this.stunT > 0) { this.stunT -= dt; speed *= 0.5; }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = fx * cy - fz * sy, wz = -fx * sy - fz * cy;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    if (this.sliding) {
      const dec = Math.exp(-1.8 * dt);
      this.vel.x *= dec; this.vel.z *= dec;
    } else if (this.onGround) {
      const k = 1 - Math.exp(-14 * dt);
      this.vel.x += (wx * speed - this.vel.x) * k;
      this.vel.z += (wz * speed - this.vel.z) * k;
    } else {
      const k = 1 - Math.exp(-2 * dt);
      this.vel.x += (wx * speed - this.vel.x) * k;
      this.vel.z += (wz * speed - this.vel.z) * k;
    }
    if (input.jumpPressed && this.onGround) {
      if (this.proning) this.tryRise();
      else if (this.crouching) this.crouching = false;
      else { this.vel.y = 5.6; this.onGround = false; this.sliding = false; }
    }
    this.vel.y -= 18 * dt;
    // 积分与碰撞
    const px = this.pos.x, pz = this.pos.z;
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    const h = lerp(lerp(1.8, 1.25, this.crouchT), 0.55, this.proneT);
    world.collide(this.pos, this.vel, this.radius, h);
    this.pos.y += this.vel.y * dt;
    const g = world.groundHeight(this.pos.x, this.pos.z, this.pos.y - this.vel.y * dt, this.radius);
    const wasGround = this.onGround;
    if (this.pos.y <= g) {
      if (!wasGround && this.vel.y < -6) { this.landDip = Math.min(0.15, -this.vel.y * 0.012); game.audio.step(null, 'dirt', 0.35); }
      this.pos.y = g; this.vel.y = 0; this.onGround = true;
    } else if (this.pos.y > g + 0.05) {
      if (wasGround && this.vel.y <= 0 && this.pos.y - g < 0.5) { this.pos.y = g; this.vel.y = 0; }
      else this.onGround = false;
    }
    // 离地即断滑铲。滑铲起点虽查了 onGround,但 crouch 分支跑在物理之前(那一拍 onGround
    // 是上一帧的旧值),而且 slideT 只看时间不看脚下 —— 从檐口/陡坡滑出去就带着滑铲姿态
    // 飞在空中。贴地小落差走上面的 stair snap(onGround 保持 true),滑铲不受影响;
    // 只有真离地才断,断掉后落回普通空中操控。
    if (this.sliding && !this.onGround) this.sliding = false;
    // 天花板
    const ceil = world.ceilingHeight(this.pos.x, this.pos.z, this.pos.y, this.radius);
    if (this.pos.y + h > ceil && this.vel.y > 0) { this.vel.y = 0; this.pos.y = ceil - h; }
    // 脚步
    const moved = Math.hypot(this.pos.x - px, this.pos.z - pz);
    if (this.onGround && !this.sliding) {
      this.stepDist += moved;
      const stride = this.sprinting ? 2.0 : 1.6;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const quiet = this.hasPerk('ninja');
        // 匍匐的脚步比蹲伏再低一档：几乎贴着地面挪，也是噪声半径里最安静的一档（2 m）。
        const vol = quiet ? 0.04 : this.proneT > 0.5 ? 0.05 : this.crouchT > 0.5 ? 0.07 : this.sprinting ? 0.22 : 0.14;
        game.audio.step(null, game.world.def.surface || 'dirt', vol);
        const r = quiet ? 2 : this.proneT > 0.5 ? 2 : this.crouchT > 0.5 ? 3 : this.sprinting ? 16 : 9;
        game.makeNoise(this.pos, r, this.team, true);
      }
    }
    // 生命恢复
    this.dmgT += dt;
    const delay = this.hasPerk('quickfix') ? 2.2 : 4;
    if (this.dmgT > delay && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 40 * dt);
    this.revealT -= dt;
    // 武器输入
    // 武器命令边沿（换弹/切枪/近战/投掷）。回滚重放时**照原样再走一遍**：
    // journal 已经把这些分支改到的状态全部退回起点，所以重演不会双倍扣弹、
    // 也不会双倍起状态机。反过来，跳过它们才会错 —— 那之后的时间轴就对不上了。
    if (input.reloadPressed) ws.startReload();
    if (input.swapPressed) ws.switchTo((ws.cur + 1) % ws.slots.length);
    if (input.slot1) ws.switchTo(0);
    if (input.slot2) ws.switchTo(1);
    if (input.meleePressed) ws.melee();
    // CS 制投掷：4 = 在身上带着的雷种间循环切出；烹饪/松手投出走开火位，
    // 在 ws.update 里裁决（'nade' 收 firePressed 拔销，'cook' 收 fire 掉了出手）。
    if (input.grenadePressed) ws.cycleGrenade();
    ws.update(dt, input, opts);
    // 相机。replay（回滚重放，js/net/predict.mjs 调进来）只重建玩法状态、不表现视角：
    // updateCamera 前半段的 camPos/aimYaw/aimPitch 必须照算（弹道从它们取，重放要逐拍
    // 一致），但**真相机不能写** —— 重放拿的是退回旧拍的 adsT（比如死前的 1），
    // 写了就是把 FOV 拽回那一拍的窄视野；联机死亡尤其可见：onNetDeath 刚把 FOV 复位，
    // 下一次对账重放又把它写回 ADS。
    this.updateCamera(dt, !!(opts && opts.replay));
  }
  updateCamera(dt, replay) {
    const ws = this.ws;
    const eyeT = this.pos.y + this.curEye() - (this.sliding ? 0.25 : 0);
    this.eyeSmooth = damp(this.eyeSmooth, eyeT, 18, dt);
    if (Math.abs(this.eyeSmooth - eyeT) > 1) this.eyeSmooth = eyeT;
    this.landDip = damp(this.landDip, 0, 8, dt);
    this.punchV = damp(this.punchV, 0, 10, dt);
    let sx = 0, sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const a = this.shakeAmt * (this.shakeT / 0.6);
      // 震屏走这个人自己的玩法流：弹道就是从这条视线取的（weapon-state.js 的 aimDir），
      // 所以这个抖动会影响命中，不是纯画面效果 —— 影响命中的随机数一律不许走公共流。
      sx = (this.rng.next() - 0.5) * a * 0.05; sy = (this.rng.next() - 0.5) * a * 0.05;
    }
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const bob = this.onGround ? Math.sin(ws.bobPhase * 2) * 0.02 * Math.min(1, spd / 6) * (1 - ws.adsT) : 0;
    // 视点与视线是"每个玩家各一份"的状态：联机时服务端同时跑 N 份，谁都能算出
    // 自己的枪口射线；只有本机玩家才写那块真相机。
    // 探头把视点沿"此人右边"平移（右为正）—— camPos 是弹道起点（eyePoint），所以探头
    // 掩体后探出去的部分才是真的能打到人的位置；这也是它必须留在碰撞半径内的原因
    // （js/combat.js:LEAN_DIST）。
    const lo = this.leanT * LEAN_DIST;
    this.camPos.set(this.pos.x + Math.cos(this.yaw) * lo, this.eyeSmooth - this.landDip + bob, this.pos.z - Math.sin(this.yaw) * lo);
    this.aimYaw = this.yaw + sx;
    this.aimPitch = this.pitch + ws.rp + this.punchV + sy;
    // 真相机只属于"这台机器上的本机玩家，且不是在重放"：服务端同时跑 N 份 sim 时
    // 各算各的 camPos/aimYaw/aimPitch（上面那半段），只有本机玩家才写那块真相机；
    // replay 时连本机也不写（见 player.update 末尾的注释）。
    if (replay || this.game.player !== this) return;
    const cam = this.game.camera;
    cam.position.copy(this.camPos);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.aimYaw;
    cam.rotation.x = this.aimPitch;
    // 横滚：探头向倾的方向歪头（右倾 = 负 z），滑铲的定值侧倾与它互斥（滑铲时探头目标恒 0）；
    // 冲刺的呼吸摆是小量，照旧叠在后面。
    cam.rotation.z = this.sliding ? -0.06 : -this.leanT * 0.12 + (ws.sprintT * Math.sin(ws.bobPhase) * 0.01);
    const zoom = lerp(1, ws.w ? ws.w.stats.zoom : 1, ws.adsT * ws.adsT);
    const base = this.game.settings.fov;
    const f = 2 * Math.atan(Math.tan(base * DEG / 2) / zoom) / DEG;
    cam.fov = f + (this.sprinting ? 4 : 0) * (1 - ws.adsT);
    cam.updateProjectionMatrix();
    this.game.audio.setListener(cam.position, this.yaw);
  }
  // 权威弹道的唯一取射线入口。客户端预测与服务端裁决都必须走这两个函数，
  // 不许再直接读 game.camera —— 那是"这台机器上只有一个玩家"的假设。
  eyePoint(out) { return out.copy(this.camPos); }
  aimDir(out) {
    const cp = Math.cos(this.aimPitch);
    return out.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
  }
}
