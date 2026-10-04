// AI 士兵
import * as THREE from 'three';
import { createSoldierModel, animateSoldier, makeNameTag, applyFlashTex } from './soldier.js';
import { computeStats, WEAPONS } from './data.js';
import { fireHitscan, Projectile, hitTestPlayer } from './combat.js';
import { clamp, damp, rand, angleDiff, spreadDir, DEG, pick, rng } from './util.js';

const DIFF = [
  { react: 0.8, spread: 3.4, burst: [2, 4], pause: [0.6, 1.2], dmg: 0.55, view: 50, turn: 4 },
  { react: 0.5, spread: 2.2, burst: [3, 6], pause: [0.35, 0.8], dmg: 0.8, view: 65, turn: 6 },
  { react: 0.3, spread: 1.4, burst: [4, 8], pause: [0.2, 0.5], dmg: 1.0, view: 80, turn: 9 },
];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
let botId = 0;

export class Bot {
  constructor(game, o) {
    this.game = game;
    this.id = ++botId;
    this.name = o.name || '士兵';
    this.team = o.team;
    this.role = o.role || 'mp';
    this.diff = DIFF[o.difficulty ?? 1];
    this.difficulty = o.difficulty ?? 1;
    this.weaponId = o.weaponId || 'ak';
    this.att = o.att || {};
    this.camo = o.camo || 'none';   // 挂在人身上：联机的套件同步（welcome.others 的 kits）要读它
    this.stats = computeStats(this.weaponId, this.att);
    this.maxHp = o.hp || 100; this.hp = this.maxHp;
    this.pos = o.pos.clone(); this.vel = new THREE.Vector3();
    this.yaw = o.yaw || 0; this.pitch = 0;
    this.alive = true;
    this.model = createSoldierModel(o.style || 'enemy', this.weaponId, this.att, o.camo || 'none');
    applyFlashTex(this.model);
    this.model.root.position.copy(this.pos);
    game.scene.add(this.model.root);
    if (o.tag) { this.tag = makeNameTag(this.name, o.tagColor || '#6cf'); this.model.root.add(this.tag); }
    this.anim = { speed: 0, phase: Math.random() * 6, crouch: 0, pitch: 0, dead: false, deadT: 0, fallDir: 1, fallRoll: 0, recoil: 0, slide: 0, sprint: 0 };
    this.mag = this.stats.mag;
    this.target = null; this.targetVisible = false; this.lastSeenPos = null; this.lastSeenT = -99; this.acquireT = 0;
    this.__hearAt = -99;   // 听觉扫描的降频戳（性能审查 N1，见 update 里的听觉块）
    this.perceiveT = rng.next() * 0.2; this.fireT = 0; this.burstLeft = 0; this.reloadT = 0;
    this.path = null; this.pathT = -99; this.pathGoal = null; this.goal = null; this.goalT = 0;
    this.strafeDir = rng.next() < 0.5 ? -1 : 1; this.strafeT = 0; this.wantCrouch = false; this.crouchT = 0;
    // 滑铲:战斗中换拍时概率触发,方向/时长/冷却三件套(移动接管在 update 里)
    this.slideT = 0; this.slideCD = rand(3, 7); this.slideDir = new THREE.Vector3();
    this.goalDist = 0; this.sprinting = false;
    this.stunT = 0; this.flashT = 0; this.revealT = 0; this.grenades = o.grenades ?? 1; this.grenadeCD = rand(4, 10);
    this.home = o.home ? o.home.clone() : this.pos.clone();
    this.leash = o.leash || 0;
    this.group = o.group || null;
    this.alerted = o.alerted || false;
    this.isHVT = !!o.isHVT;
    this.stuckT = 0; this.lastProgPos = this.pos.clone();
    this.kills = 0; this.deaths = 0; this.score = 0; this.streak = 0; this.captures = 0;
    this.scanBase = this.yaw; this.scanT = rng.next() * 10;
    this.static = !!o.static;
    this.accuracyMul = o.accuracyMul || 1;
    this.patrol = o.patrol || null; this.patrolI = 0;
    this.assaultTarget = o.assaultTarget || null;
    this.radius = 0.35;
    this.dmgTaken = new Map();
  }
  get crouch() { return this.anim.crouch; }
  // 命中盒的入参（js/combat.js:hitTestPlayer）。延迟补偿的 pose 环存的就是
  // (x, y, z, curEye(), yaw, prone) 这六个量 —— 盒子依赖什么，缓冲里就得存什么。
  // Bot 不趴（prone 恒 0），但它有 yaw：参数列齐全是为了与真人/远端走同一个入口。
  curEye() { return 1.6 - this.anim.crouch * 0.5; }
  eyePos(out) { return out.set(this.pos.x, this.pos.y + this.curEye(), this.pos.z); }
  chestPos(out) { return out.set(this.pos.x, this.pos.y + 1.2 - this.anim.crouch * 0.4, this.pos.z); }
  forward(out) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  // 命中盒收编进共用定义（js/combat.js:hitTestPlayer）。旧的私盒（半宽 0.27、头心
  // 1.68−0.5c、r 0.15）与共用的那张（0.30 / eye+0.02 / 0.145）各窄 3cm、高 6cm——
  // 服务端裁 Bot 用私盒、客户端本地反馈用公盒，边缘弹就是第三层"本地中、权威不中"。
  // 收编的副作用是 Bot 的腿也算腿（0.85 倍）而旧私盒那段只算身体——与真人/远端同一套，
  // 单机联机从此一个手感。改盒子的同时必须记得 test/lagcomp.mjs 的规格注释。
  hitTest(o, d, maxT) {
    if (!this.alive) return null;
    return hitTestPlayer(this.pos.x, this.pos.y, this.pos.z, this.curEye(), this.yaw, 0, 0, o, d, maxT);
  }
  takeDamage(dmg, info) {
    if (!this.alive) return false;
    this.hp -= dmg;
    const a = info.attacker;
    if (a) this.dmgTaken.set(a, (this.dmgTaken.get(a) || 0) + dmg);
    this.anim.recoil = 0.5;
    // 被攻击时立即察觉
    if (a && a.alive && a.pos) {
      this.lastSeenPos = a.pos.clone(); this.lastSeenT = this.game.time;
      this.alerted = true;
      if (!this.target) { this.target = a; this.acquireT = this.game.time - this.diff.react * 0.5; }
      if (this.group) this.game.alertGroup && this.game.alertGroup(this.group, a.pos);
    }
    if (this.hp <= 0) {
      this.die(info);
      return true;
    }
    return false;
  }
  die(info) {
    this.alive = false; this.hp = 0; this.deaths++;
    this.anim.dead = true; this.anim.deadT = 0;
    const d = info.dir || new THREE.Vector3(0, 0, 1);
    const f = this.forward(_a);
    this.anim.fallDir = f.dot(d) > 0 ? -1 : 1;
    this.anim.fallRoll = rand(-0.3, 0.3);
    this.model.flash.visible = false;
    if (this.tag) this.tag.visible = false;
    this.deadTime = this.game.time;
    this.game.onKill(info.attacker, this, info.weapon, info.head, info);
  }
  respawn(pos, yaw) {
    this.pos.copy(pos); this.vel.set(0, 0, 0); this.yaw = yaw; this.hp = this.maxHp; this.alive = true;
    this.anim.dead = false; this.anim.deadT = 0; this.model.root.rotation.set(0, yaw, 0);
    this.mag = this.stats.mag; this.target = null; this.lastSeenPos = null; this.path = null; this.goal = null;
    this.stunT = 0; this.grenades = 1; this.reloadT = 0; this.streak = 0;
    if (this.tag) this.tag.visible = true;
    this.model.root.visible = true;
    this.dmgTaken.clear();
  }
  stun(t) { this.stunT = Math.max(this.stunT, t); }
  hint(pos) { if (!this.target || !this.targetVisible) { this.lastSeenPos = pos.clone(); this.lastSeenT = this.game.time - 2; this.alerted = true; } }

  // bot 不打天上的东西：它的队列里不该出现武装直升机（哨戒机枪会打，那是另一份名单）。
  // 能不能打中它在这里不算数 —— 那件事由射线答（js/combat.js:traceBullet）。
  isEnemy(e) { return e.team !== this.team && e.alive && e.targetable !== false && !e.isHeli; }

  perceive() {
    const game = this.game;
    const eye = this.eyePos(_a);
    const fwd = this.forward(_b);
    let best = null, bestD = 1e9;
    const view = game.world.def.night && !game.nightVisionForBots ? this.diff.view * 0.7 : this.diff.view;
    for (const e of game.entities) {
      if (!this.isEnemy(e)) continue;
      const tc = e.chestPos(_c);
      const dx = tc.x - eye.x, dy = tc.y - eye.y, dz = tc.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > view) continue;
      const cos = (dx * fwd.x + dz * fwd.z) / Math.max(0.01, Math.hypot(dx, dz));
      const tracking = e === this.target && game.time - this.lastSeenT < 1.5;
      const fovOK = cos > 0.35 || dist < 4 || tracking;
      if (!fovOK) continue;
      // 蹲伏或远距离降低发现概率
      const stealthCheck = !tracking && !this.alerted && this.role === 'guard';
      if (stealthCheck && dist > view * 0.75) continue;
      if (game.world.lineBlocked(eye, tc) && game.world.lineBlocked(eye, e.eyePos(_d))) continue;
      if (game.effects.smokeBlocks(eye, tc)) continue;
      if (stealthCheck) {
        // 警戒值累积：距离越近、越显眼，发现越快
        let detect = dist < 7 ? 1 : Math.pow(7 / dist, 2);
        // 蹲伏减半；趴伏更贴地、轮廓更扁，再压一档（与消音同级的隐匿收益）。
        if (e.proneT > 0.5) detect *= 0.35;
        else if (e.crouchT > 0.5 || e.crouch > 0.5) detect *= 0.5;
        if (e.stealthy) detect *= 0.5;
        if (game.world.def.night) detect *= 0.6;
        if (e.revealT > 0) detect = Math.max(detect, 0.5);
        if (cos < 0.7) detect *= 0.5;
        this.susp = (this.susp || 0) + detect * 0.3;
        this.suspSeen = game.time;
        if (this.susp < 1) continue;
      }
      const score = dist * (e === this.target ? 0.7 : 1);
      if (score < bestD) { bestD = score; best = e; }
    }
    if (this.susp && game.time - (this.suspSeen || 0) > 0.5) this.susp = Math.max(0, this.susp - 0.04);
    if (best) {
      if (best !== this.target || !this.targetVisible) {
        let react = this.diff.react * rand(0.8, 1.3);
        if (best.isPlayer && best.hasPerk('coldblooded')) react *= 1.8;
        if (!this.alerted) react *= 1.5;
        this.acquireT = game.time + react;
        this.aimSettle = 1;
      }
      this.target = best; this.targetVisible = true;
      this.lastSeenPos = best.pos.clone(); this.lastSeenT = game.time;
      if (!this.alerted) { this.alerted = true; if (this.group && game.alertGroup) game.alertGroup(this.group, best.pos); }
    } else {
      this.targetVisible = false;
      if (this.target && (!this.target.alive || game.time - this.lastSeenT > 6)) this.target = null;
    }
    // 听觉（性能审查 N1）：这段曾经每拍对每个无目标的 Bot 全表扫 noises —— O(bots×noises)，
    // 交火中的满 Bot 房 ≈ 每秒几万次带 sqrt 的距离检查，全部花在"看不见东西的 Bot"上。
    // 三刀，前两刀行为逐位一致：
    //   ① 动作闸前置 —— 循环体内的副作用只在"lastSeenPos 空 / 已过期 2s"时发生（循环自己
    //      会把 lastSeenT 改成 time-1，闸随即关上），闸关着时整个循环是纯白工，先问一次就够；
    //   ② 平方距离替代 distanceTo —— 去掉 sqrt，比较结果同序；
    //   ③ 每 Bot 降到 10Hz（__hearAt）—— 唯一的行为让步：听觉最多晚 0.1s。噪声 0.5s 就
    //      过期，交火时下一发子弹立刻补上；换来的是把 O(60Hz×bots×noises) 钉成 O(10Hz)。
    if ((!this.targetVisible && (!this.lastSeenPos || game.time - this.lastSeenT > 2)) && game.time - this.__hearAt >= 0.1) {
      this.__hearAt = game.time;
      for (const n of game.noises) {
        if (n.team === this.team || game.time - n.t > 0.5) continue;
        const dx = n.pos.x - this.pos.x, dy = n.pos.y - this.pos.y, dz = n.pos.z - this.pos.z;
        if (dx * dx + dy * dy + dz * dz < n.r * n.r) {
          if (!this.lastSeenPos || game.time - this.lastSeenT > 2) {
            this.lastSeenPos = n.pos.clone(); this.lastSeenT = game.time - 1;
            if (!this.alerted && this.group && game.alertGroup && !n.footstep) game.alertGroup(this.group, n.pos);
            this.alerted = true;
          }
        }
      }
    }
  }

  requestPath(goal) {
    const game = this.game;
    if (game.pathBudget <= 0) return;
    game.pathBudget--;
    this.path = game.world.findPath(this.pos, goal);
    this.pathT = game.time; this.pathGoal = goal.clone();
  }
  // 沿路径移动，返回期望速度方向
  steer(goal, speed, out) {
    const game = this.game;
    if (!goal) return out.set(0, 0, 0);
    const dGoal = Math.hypot(goal.x - this.pos.x, goal.z - this.pos.z);
    this.goalDist = dGoal;   // 冲刺判据读这一格:要去的地方还远不远
    if (dGoal < 0.8) { this.path = null; return out.set(0, 0, 0); }
    // 直线可达直接走
    if (!this.path || !this.pathGoal || this.pathGoal.distanceTo(goal) > 2.5 || game.time - this.pathT > 4) this.requestPath(goal);
    let next = goal;
    if (this.path && this.path.length) {
      while (this.path.length > 1 && Math.hypot(this.path[0].x - this.pos.x, this.path[0].z - this.pos.z) < 0.8) this.path.shift();
      next = this.path[0];
    }
    const dx = next.x - this.pos.x, dz = next.z - this.pos.z, l = Math.hypot(dx, dz);
    if (l < 0.01) return out.set(0, 0, 0);
    return out.set(dx / l * speed, 0, dz / l * speed);
  }

  update(dt) {
    const game = this.game;
    const A = this.anim;
    if (!this.alive) {
      A.deadT += dt;
      animateSoldier(this.model, A, dt);
      this.model.root.position.copy(this.pos);
      return;
    }
    this.perceiveT -= dt;
    if (this.perceiveT <= 0) { this.perceiveT = 0.15 + rng.next() * 0.08; this.perceive(); }
    this.stunT -= dt; this.flashT -= dt; this.revealT -= dt; this.grenadeCD -= dt; this.reloadT -= dt; this.slideCD -= dt;
    this.model.flash.visible = this.flashT > 0;
    A.recoil = damp(A.recoil, 0, 10, dt);

    const desired = _d.set(0, 0, 0);
    let lookYaw = null, lookPitch = 0;
    let speed = 4.6 * this.stats.mobility;
    const t = this.target;
    const stunned = this.stunT > 0;
    let wantCrouch = false;
    // 冲刺:没在交火、不是站桩/被闪、要去的地方还远(>10m)—— 就跑起来(玩家 7.1×mob)。
    // 交火中永远不跑,侧移/蹲才是战斗步态;alerted 前的哨兵巡逻也不跑。goalDist 由
    // steer() 顺路记下;冲刺姿态(A.sprint)与快照位(this.sprinting)在函数尾部喂出。
    const sprinting = !this.targetVisible && !stunned && !this.static && this.slideT <= 0
      && this.goalDist > 10 && !(this.role === 'guard' && !this.alerted);
    if (sprinting) speed = 7.0 * this.stats.mobility;

    if (stunned) {
      desired.set(Math.sin(game.time * 2 + this.id) * 1.2, 0, Math.cos(game.time * 1.7 + this.id) * 1.2);
      lookYaw = this.yaw + Math.sin(game.time * 3) * 0.05;
    } else if (t && this.targetVisible && t.alive) {
      // 战斗
      const eye = this.eyePos(_a);
      const tc = t.chestPos(_b);
      const dx = tc.x - eye.x, dy = tc.y - eye.y, dz = tc.z - eye.z;
      const dist = Math.hypot(dx, dz);
      lookYaw = Math.atan2(-dx, -dz);
      lookPitch = Math.atan2(dy, dist);
      // 移动：侧移 + 距离调整
      this.strafeT -= dt;
      const rerolled = this.strafeT <= 0;
      if (rerolled) { this.strafeT = rand(0.8, 2.2); this.strafeDir = rng.next() < 0.5 ? -1 : 1; this.wantCrouch = rng.next() < (this.stats.type === 'sniper' || this.stats.type === 'lmg' ? 0.6 : 0.3); }
      wantCrouch = this.wantCrouch;
      if (!this.static) {
        const sx = Math.cos(lookYaw), sz = -Math.sin(lookYaw);
        const pref = this.stats.type === 'shotgun' ? 6 : this.stats.type === 'smg' ? 12 : this.stats.type === 'sniper' ? 35 : 20;
        const fx = -Math.sin(lookYaw), fz = -Math.cos(lookYaw);
        let adv = dist > pref * 1.4 ? 1 : dist < pref * 0.4 ? -0.6 : 0;
        const ss = wantCrouch ? 0 : 2.2;
        desired.set(sx * this.strafeDir * ss + fx * adv * 3, 0, sz * this.strafeDir * ss + fz * adv * 3);
        // 撞墙检测：若侧移方向被阻挡则反向
        const probe = _c.copy(this.pos).addScaledVector(desired, 0.4);
        const [ix, iz] = game.world.cellOf(probe.x, probe.z);
        if (!game.world.walkable(ix, iz)) { this.strafeDir *= -1; desired.set(0, 0, 0); }
        // 滑铲：换拍瞬间概率朝当前移动方向"扑"一段(玩家的滑铲在这里的低配版)——
        // 方向锁进 slideDir、初速 8、指数衰减 1.8/s(与玩家同一档),贴地(本职:pos.y 恒 damp 到地面)。
        // 只在战斗里、中近距离、且真的在移动时才扑;冷却防连环滑。蹲姿位顺带压低命中盒。
        if (rerolled && this.slideT <= 0 && this.slideCD <= 0 && !stunned
            && dist > 6 && dist < 25 && Math.hypot(this.vel.x, this.vel.z) > 1 && rng.next() < 0.35) {
          this.slideT = 0.7; this.slideCD = rand(5, 9);
          this.slideDir.copy(desired); this.slideDir.y = 0;
          if (this.slideDir.lengthSq() < 0.01) this.slideDir.set(sx * this.strafeDir, 0, sz * this.strafeDir);
          this.slideDir.normalize();
          this.vel.x = this.slideDir.x * 8; this.vel.z = this.slideDir.z * 8;
          this.wantCrouch = true; wantCrouch = true;
        }
      }
      // 射击
      const facing = Math.abs(angleDiff(this.yaw, lookYaw)) < 0.25;
      if (game.time > this.acquireT && facing && this.reloadT <= 0 && this.slideT <= 0) this.tryFire(dt, t, dist);
      // 高度警觉提示。真人在权威端是**另一台机器上的浏览器**（与 combat.js:flashAt 同一个
      // 理由）：game.hud 在那台机器上够不着，所以 game.highAlert 由 NetRoom 提供、把
      // "谁在瞄你"编成事件发过去；浏览器侧没有这个钩子就照旧本地提示。
      if (t.isPlayer && t.hasPerk('highalert')) {
        if (game.highAlert) game.highAlert(t, this.pos);
        else game.hud.highAlert(this.pos);
      }
    } else if (this.lastSeenPos && game.time - this.lastSeenT < 12 && (this.alerted) && !this.static) {
      // 搜索
      const lp = this.lastSeenPos;
      let goal = lp;
      if (this.leash && goal.distanceTo(this.home) > this.leash) goal = this.home;
      this.steer(goal, speed, desired);
      if (desired.lengthSq() < 0.01 && game.time - this.lastSeenT > 3) this.lastSeenPos = null;
      // 投掷手雷
      if (this.grenades > 0 && this.grenadeCD <= 0 && game.time - this.lastSeenT < 3 && this.difficulty > 0) {
        const d = lp.distanceTo(this.pos);
        if (d > 8 && d < 26 && rng.next() < 0.35) this.throwGrenade(lp);
        this.grenadeCD = rand(8, 16);
      }
      if (this.mag < this.stats.mag * 0.5 && this.reloadT <= 0) this.reload();
    } else {
      // 常规行为
      if (this.mag < this.stats.mag && this.reloadT <= 0 && this.mag < this.stats.mag * 0.6) this.reload();
      this.behave(dt, desired);
      if (this.role === 'guard' && !this.alerted) speed = 1.6;
    }
    if (this.static) desired.set(0, 0, 0);
    // 限速
    const dl = Math.hypot(desired.x, desired.z);
    // 冲刺补速:behave()/搜索里的字面速度(巡逻 1.6、跟随 5、冲锋 4.5)不随 sprinting 变,
    // 这里沿原方向补到冲刺速度 —— 交火分支的 desired 不补(战斗不跑)
    if (sprinting && dl > 0.01) desired.multiplyScalar(speed / dl);
    const maxS = (wantCrouch ? 2.0 : speed) * (stunned ? 0.4 : 1);
    if (dl > maxS) desired.multiplyScalar(maxS / dl);
    // 分离
    for (const o of game.bots) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.7 && d2 > 0.0001) { const d = Math.sqrt(d2); desired.x += dx / d * 1.5; desired.z += dz / d * 1.5; }
    }
    const k = 1 - Math.exp(-10 * dt);
    if (this.slideT > 0) {
      // 滑铲接管移动:期望速度一律不生效,方向锁死、只衰减 —— 否则 10/s 的转向阻尼
      // 会把这一"扑"在两帧内拽回普通侧移,滑铲就只剩个姿势
      this.slideT -= dt;
      const dec = Math.exp(-1.8 * dt);
      this.vel.x *= dec; this.vel.z *= dec;
    } else {
      this.vel.x += (desired.x - this.vel.x) * k;
      this.vel.z += (desired.z - this.vel.z) * k;
    }
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    game.world.collide(this.pos, this.vel, this.radius, 1.7);
    const gh = game.world.groundHeight(this.pos.x, this.pos.z, this.pos.y, this.radius);
    if (this.static) { /* 固定位置（塔楼） */ }
    else this.pos.y = damp(this.pos.y, gh, 15, dt);
    // 卡住检测
    this.stuckT += dt;
    if (this.stuckT > 1.5) {
      if (this.lastProgPos.distanceTo(this.pos) < 0.4 && dl > 0.5) { this.path = null; this.pathT = -99; this.goal = null; this.strafeDir *= -1; }
      this.lastProgPos.copy(this.pos); this.stuckT = 0;
    }
    // 朝向
    const spd = Math.hypot(this.vel.x, this.vel.z);
    if (lookYaw === null) {
      if (spd > 0.5) lookYaw = Math.atan2(-this.vel.x, -this.vel.z);
      else if (this.role === 'guard' && !this.alerted) { this.scanT += dt; lookYaw = this.scanBase + Math.sin(this.scanT * 0.4) * 0.8; }
      else lookYaw = this.yaw;
    }
    const turn = this.diff.turn * (this.targetVisible ? 1 : 0.7);
    const ad = angleDiff(this.yaw, lookYaw);
    this.yaw += clamp(ad, -turn * dt, turn * dt);
    this.pitch = damp(this.pitch, lookPitch, 8, dt);
    this.crouchT = damp(this.crouchT, wantCrouch ? 1 : 0, 8, dt);
    // 动画
    A.speed = spd; A.phase += dt * spd * 2.2; A.crouch = this.crouchT; A.pitch = this.pitch;
    A.slide = damp(A.slide, this.slideT > 0 ? 1 : 0, 12, dt);     // 与 NetPlayer 的滑铲平滑同一档
    this.sprinting = sprinting;
    A.sprint = damp(A.sprint, sprinting ? 1 : 0, 10, dt);         // 冲刺姿态:前倾+枪口上抬(soldier.js 通道)
    // RPG 弹头位（soldier.js 通道）：膛里有货才坐在筒口。目前 BOT_WEAPONS 不含
    // 发射器，这行是给契约留的座 —— 哪天 bot 拿上 RPG，第三人称不会回到
    // "弹头永远挂着"的旧病。
    A.rocket = this.mag > 0 && this.reloadT <= 0;
    animateSoldier(this.model, A, dt);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    // 脚步声。与远端真人同一档（0.35 + audio.step 的传远衰减）：Bot 的逼近也是敌情，
    // 通用曲线下 20 m 外那 0.25 等于不存在。
    if (spd > 3 && Math.random() < dt * 3) game.audio.step(this.pos, game.world.def.surface || 'dirt', 0.35);
  }

  behave(dt, desired) {
    const game = this.game;
    const role = this.role;
    if (role === 'guard') {
      if (this.patrol && !this.alerted) {
        const p = this.patrol[this.patrolI];
        this.steer(p, 1.6, desired);
        if (Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < 1) this.patrolI = (this.patrolI + 1) % this.patrol.length;
      } else if (this.pos.distanceTo(this.home) > 1.5) this.steer(this.home, 3, desired);
      return;
    }
    if (role === 'ally') {
      const pl = game.player;
      if (!pl) return;
      const off = this.followOffset || (this.followOffset = new THREE.Vector3(rand(-3, 3), 0, rand(2, 4)));
      const goal = _c.set(pl.pos.x + Math.cos(pl.yaw) * off.x + Math.sin(pl.yaw) * off.z, 0, pl.pos.z - Math.sin(pl.yaw) * off.x + Math.cos(pl.yaw) * off.z);
      if (this.leadTarget) goal.copy(this.leadTarget);
      const d = Math.hypot(goal.x - this.pos.x, goal.z - this.pos.z);
      if (d > 2.5) this.steer(goal.clone(), d > 8 ? 5 : 3.5, desired);
      return;
    }
    if (role === 'assault') {
      if (this.assaultTarget) {
        this.steer(this.assaultTarget, 4.5, desired);
        if (this.pos.distanceTo(this.assaultTarget) < 3) {
          this.assaultTarget = null;
          if (game.player) this.hint(game.player.pos);
        }
      } else if (game.player && game.player.alive) this.hint(game.player.pos);
      return;
    }
    // 多人：由模式决定目标
    this.goalT -= dt;
    if (!this.goal || this.goalT <= 0 || Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 1.5) {
      this.goal = game.mode && game.mode.botGoal ? game.mode.botGoal(this) : game.world.randomWalkable();
      this.goalT = rand(6, 14);
    }
    this.steer(this.goal, 4.6 * this.stats.mobility, desired);
  }

  reload() {
    this.reloadT = this.stats.reload * 1.1;
    this.mag = this.stats.mag;
    // 带 this.pos：Bot 换弹也是"旁边有人没子弹了"的情报，声像与距离都要有。
    this.game.audio.reload('out', this.pos);
  }

  tryFire(dt, target, dist) {
    const game = this.game, st = this.stats;
    this.fireT -= dt;
    if (this.fireT > 0) return;
    if (this.holdFire && this.holdFire()) return;
    if (this.mag <= 0) { this.reload(); return; }
    if (this.burstLeft <= 0) {
      this.burstLeft = st.fire === 'auto' ? Math.floor(rand(this.diff.burst[0], this.diff.burst[1] + 1)) : 1;
      this.fireT = rand(this.diff.pause[0], this.diff.pause[1]) * (st.fire === 'auto' ? 1 : 0.6);
      if (st.fire === 'bolt') this.fireT = rand(1.2, 2.0);
      return;
    }
    this.burstLeft--;
    this.fireT = Math.max(60 / st.rpm, st.fire === 'auto' ? 0.07 : 0.25);
    this.mag--;
    // 瞄准
    const eye = this.eyePos(new THREE.Vector3());
    const aim = target.chestPos(new THREE.Vector3());
    if (rng.next() < 0.18 + this.difficulty * 0.06) aim.y += 0.42; // 爆头尝试
    const tv = target.vel ? Math.hypot(target.vel.x, target.vel.z) : 0;
    this.aimSettle = Math.max(0, (this.aimSettle || 0) - 0.18);
    let spread = this.diff.spread * (1 + tv / 6 * 0.8) * (1 + Math.hypot(this.vel.x, this.vel.z) / 5 * 0.4) * (1 + this.aimSettle * 1.2) * this.accuracyMul;
    if (dist > 35) spread *= 0.8;
    if (st.type === 'sniper') spread *= 0.5;
    const dir = aim.sub(eye).normalize();
    const pellets = st.pellets;
    const muzzle = this.model.muzzle.getWorldPosition(new THREE.Vector3());
    let r;
    for (let i = 0; i < pellets; i++) {
      const d = spreadDir(dir, (spread + (pellets > 1 ? st.hip * 0.5 : 0)) * DEG * 0.5, new THREE.Vector3());
      r = fireHitscan(game, this, eye, d, st, st.name, { dmgMul: this.diff.dmg * (game.botDmgMul || 1) });
      if (i === 0 && Math.random() < 0.5) game.effects.tracer(muzzle, r.point, [1.5, 1.0, 0.5]);
    }
    this.flashT = 0.05;
    this.model.flash.material.rotation = Math.random() * 6;
    this.anim.recoil = 1;
    if (Math.random() < 0.25) game.effects.flashLight(muzzle, 0xffb060, 2.5, 0.05, 7);
    // 枪口烟/火星：第三人称以前也只有火光精灵，打起来一闪而过
    if (!st.suppressed) game.effects.muzzle(muzzle, dir, pellets > 1 ? 1.2 : 1, false);
    game.audio.shot(st.sound, this.pos, st.suppressed);
    game.makeNoise(this.pos, st.suppressed ? 10 : 60, this.team);
    if (!st.suppressed) this.revealT = 1.6;
    // 子弹掠过音效
    if (game.player && game.player.alive && !r.ent?.isPlayer) {
      const pe = game.player.eyePos(_c);
      const toP = pe.clone().sub(eye); const proj = toP.dot(dir);
      if (proj > 0 && proj < r.t) { const perp = toP.clone().addScaledVector(dir, -proj).length(); if (perp < 1.2) game.audio.click(5000 + Math.random() * 2000, 0.06, 0.25); }
    }
  }
  throwGrenade(target) {
    const game = this.game;
    this.grenades--;
    const from = this.eyePos(new THREE.Vector3());
    const T = 1.1, g = 16;
    const v = new THREE.Vector3((target.x - from.x) / T, (target.y - from.y) / T + 0.5 * g * T, (target.z - from.z) / T);
    game.projectiles.push(new Projectile(game, 'frag', from, v, this, 2.6));
    this.anim.recoil = 1;
  }
  dispose() { this.game.scene.remove(this.model.root); }
}
