// 玩家控制器
import * as THREE from 'three';
import { WeaponSystem } from './weapons.js';
import { hitTestPlayer } from './combat.js';
import { clamp, damp, lerp, DEG, entStream } from './util.js';
import { WEAPONS, LETHALS, TACTICALS } from './data.js';

// 回滚重放的状态日记本字段清单。
// 漏一个字段 = 那一维带着两边不同的初值继续分叉，而且没人会报错，只有手感怪。
// test/net-journal.mjs 遍历 Player / WeaponState 的 own keys 检查覆盖率，新增字段
// 要么登记进来，要么进 J_EXCLUDE 并写清理由。
export const J_PL = ['yaw', 'pitch', 'hp', 'crouchT', 'slideT', 'eyeSmooth', 'dmgT', 'shakeT', 'shakeAmt',
  'punchV', 'landDip', 'stepDist', 'revealT', 'sprintLock', 'stunT', 'interactHold',
  'alive', 'crouching', 'sprinting', 'sliding', 'onGround'];
export const J_WS = ['state', 'stateT', 'stateDur', 'adsT', 'cool', 'cycleT', 'triggerHeld', 'rp', 'lastShot',
  'shotsInRow', 'bobPhase', 'sprintT', 'equipT', 'cooking', 'cookT', 'reloadStage', 'meleeHit'];
export const J_EXCLUDE = {
  // —— Player ——
  game: '环境引用', ws: '由 J_WS + ammo + cur 覆盖', isPlayer: '常量', name: '常量', team: '常量',
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

export class Player {
  constructor(game, opts) {
    this.game = game;
    this.isPlayer = true;
    this.name = opts.name || '你';
    this.team = opts.team || 'A';
    this.pos = opts.pos.clone();
    this.vel = new THREE.Vector3();
    this.yaw = opts.yaw || 0; this.pitch = 0;
    this.maxHp = 100; this.hp = 100; this.alive = true;
    this.crouchT = 0; this.crouching = false; this.sprinting = false; this.sliding = false; this.slideT = 0;
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
    this.hp = this.maxHp; this.alive = true; this.dmgT = 99; this.crouchT = 0; this.crouching = false; this.sliding = false;
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
  eyePos(out) { return out.set(this.pos.x, this.pos.y + this.curEye(), this.pos.z); }
  chestPos(out) { return out.set(this.pos.x, this.pos.y + this.curEye() - 0.4, this.pos.z); }
  curEye() { return lerp(1.62, 1.05, this.crouchT); }
  forward(out) { return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); }
  // 命中盒在这里只剩"把当下姿态喂给公共定义"这一件事 —— 延迟补偿要拿历史姿态调同一个
  // 函数（js/combat.js:hitTestPlayer），所以它必须是纯函数而不是这个类的方法。
  hitTest(o, d, maxT) {
    return hitTestPlayer(this.pos.x, this.pos.y, this.pos.z, this.curEye(), o, d, maxT);
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

  // —— 回滚重放：把"我自己"完整拨回某一拍 ——
  // 在 update 之前取，记的就是"这一拍开始时的我"，重放时才和当初逐字段同起点。
  journal() {
    const ws = this.ws, j = { time: this.game.time, cur: ws.cur, grenade: ws.grenade ? ws.grenade.type : null };
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
    const sens = game.settings.sens * 0.0022 * (ws.adsT > 0.5 ? game.settings.adsSens / Math.pow(zoom, 0.85) : 1);
    this.yaw -= input.mdx * sens;
    this.pitch -= input.mdy * sens * (game.settings.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.5, 1.5);
    // 姿态
    if (input.crouchPressed) {
      if (this.sprinting && this.onGround && !this.sliding) {
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
    // 移动输入
    const fx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const fz = (input.fwd ? 1 : 0) - (input.back ? 1 : 0);
    this.sprintLock = (this.sprintLock || 0) - dt;
    const wantSprint = input.sprint && fz > 0 && this.sprintLock <= 0 && ws.adsT < 0.3 && !this.sliding;
    if (wantSprint && !this.sprinting) { this.sprinting = true; this.crouching = false; if (ws.state === 'reload' && !this.hasPerk('sleight')) ws.state = 'idle'; }
    if (!wantSprint) this.sprinting = false;
    // 头顶空间检查（蹲伏时不能站起）
    if (!this.crouching && this.crouchT > 0.1) {
      const c = world.ceilingHeight(this.pos.x, this.pos.z, this.pos.y, this.radius);
      if (c < this.pos.y + 1.85) this.crouching = true;
    }
    this.crouchT = damp(this.crouchT, this.crouching ? 1 : 0, 12, dt);
    const mob = ws.w ? ws.w.stats.mobility : 1;
    let speed = 4.7 * mob;
    if (this.sprinting) speed = 7.1 * mob * (this.hasPerk('doubletime') ? 1.08 : 1);
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
      if (this.crouching) this.crouching = false;
      else { this.vel.y = 5.6; this.onGround = false; this.sliding = false; }
    }
    this.vel.y -= 18 * dt;
    // 积分与碰撞
    const px = this.pos.x, pz = this.pos.z;
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    const h = lerp(1.8, 1.25, this.crouchT);
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
        const vol = quiet ? 0.04 : this.crouchT > 0.5 ? 0.07 : this.sprinting ? 0.22 : 0.14;
        game.audio.step(null, game.world.def.surface || 'dirt', vol);
        const r = quiet ? 2 : this.crouchT > 0.5 ? 3 : this.sprinting ? 16 : 9;
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
    if (input.lethalPressed && this.lethal) ws.beginThrow('lethal', this.lethal.id);
    if (input.tacticalPressed && this.tactical) ws.beginThrow('tactical', this.tactical.id);
    if (ws.state === 'cook' && !input.lethal && !input.tactical) ws.endThrow();
    ws.update(dt, input, opts);
    // 相机
    this.updateCamera(dt);
  }
  updateCamera(dt) {
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
    // 自己的枪口射线；只有本机玩家才去写那块真相机。
    this.camPos.set(this.pos.x, this.eyeSmooth - this.landDip + bob, this.pos.z);
    this.aimYaw = this.yaw + sx;
    this.aimPitch = this.pitch + ws.rp + this.punchV + sy;
    if (this.game.player !== this) return;
    const cam = this.game.camera;
    cam.position.copy(this.camPos);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.aimYaw;
    cam.rotation.x = this.aimPitch;
    cam.rotation.z = this.sliding ? -0.06 : (ws.sprintT * Math.sin(ws.bobPhase) * 0.01);
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
