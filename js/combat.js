// 战斗系统：弹道判定、伤害、爆炸、投掷物
import * as THREE from 'three';
import { mat } from './materials.js';
// crand 在这里必须是**画面流**（crandRange）：下面唯一的用处是手雷尾烟的粒子速度。
// 走了玩法流的话，"这颗雷在飞"就会消耗权威随机数 —— 而有没有渲染器、渲染器这一帧跑不跑
// 这段，两端本来就不一样，于是服务端和浏览器从流的不同位置取值，机器人下一秒的散布就分叉。
// 实测：Node 比 Chrome 多抽 3 次，正好是这一行一次的量。
// rand 是**玩法流**，只有连杀奖励的落点抖动用它 —— 那件事在权威端要可复现（见
// clusterStrike 上方），所以在两端都跑得到的那条流上。
import { crandRange as crand, rand, clamp, raySphere, rayAABB } from './util.js';

const _p = new THREE.Vector3(), _q = new THREE.Vector3();
// 金属命中要用的法线。不与 _p/_q 共用：那两个在爆炸/弹道那一段里跨调用带着值，
// 这里要是蹭用了别人的临时向量，症状会是"偶发的火星喷向奇怪的方向"而没人查得到。
const _n = new THREE.Vector3();

// 玩家命中盒的解析定义（头球 + 躯干 AABB）。**一处定义，四处用**：
// 本机玩家的当下裁决（js/player.js:hitTest）、远端玩家的即时反馈（js/net/remote.mjs:hitTest）、
// 服务端按历史姿态的回溯裁决（延迟补偿，server/room.mjs:shotRewind → traceBullet 的 rewind 回调）、
// 以及判据里"这一枪该不该中"的预测（test/lagcomp.mjs 调的就是它）。
// 参数抽成 (x,y,z,eye) 四个标量而不是整个 Player，是因为延迟补偿每拍要存的就只是这四个量
// （见 server/lagcomp.mjs:PoseRing）—— 命中盒依赖什么，缓冲里就该存什么，多存是浪费，
// 少存就是"回溯过去的盒子"和"当时的盒子"不是同一个，而那种错只会表现为偶尔打不中。
export function hitTestPlayer(x, y, z, eye, o, d, maxT) {
  // 与外观贴合:头球 0.145 ≈ 盔体 0.135 + 1cm 容差(旧 0.16 比盔大一圈,贴着盔边擦过也算爆头);
  // 躯干半宽 0.30 盖住肩球 0.285(旧 0.28,打肩球边缘不判中)。改这里同时影响本机/远端/
  // 服务端回溯三路裁决与 test/lagcomp.mjs 的判据线。
  const hy = y + eye + 0.02;
  let t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, x, hy, z, 0.145);
  if (t >= 0 && t < maxT) return { t, part: 'head' };
  const b = { x0: x - 0.30, x1: x + 0.30, y0: y, y1: y + eye - 0.12, z0: z - 0.30, z1: z + 0.30 };
  t = rayAABB(o.x, o.y, o.z, d.x, d.y, d.z, b, maxT);
  if (t >= 0) { const hy2 = o.y + d.y * t; return { t, part: hy2 < y + eye * 0.5 ? 'legs' : 'body' }; }
  return null;
}

export function damageAt(stats, dist, part) {
  let d;
  if (dist <= stats.rangeNear) d = stats.dmgNear;
  else if (dist >= stats.rangeFar) d = stats.dmgFar;
  else d = stats.dmgNear + (stats.dmgFar - stats.dmgNear) * (dist - stats.rangeNear) / (stats.rangeFar - stats.rangeNear);
  if (part === 'head') d *= stats.headMul;
  else if (part === 'legs') d *= 0.85;
  return d;
}

// rewind：可选的取姿态函数 (entity) => [x, y, z, eye] | null —— 延迟补偿用。
// 它返回非 null 的实体按**历史上的那个盒子**判，返回 null 的（不是玩家、缓冲里没有那一拍、
// 就是开枪者本人）照旧按当下判。所以"没接补偿"的那条路走的是同一份 hitTest，不是复制品。
export function traceBullet(game, shooter, o, d, maxDist = 400, rewind = null) {
  const wh = game.world.raycast(o, d, maxDist);
  let best = wh ? wh.t : maxDist, ent = null, part = null;
  for (const e of game.entities) {
    if (e === shooter || !e.alive) continue;
    if (shooter && e.team === shooter.team) continue;
    const p = rewind ? rewind(e) : null;
    const h = p ? hitTestPlayer(p[0], p[1], p[2], p[3], o, d, best) : e.hitTest(o, d, best);
    if (h && h.t < best) { best = h.t; ent = e; part = h.part; }
  }
  const point = new THREE.Vector3().copy(o).addScaledVector(d, best);
  return { t: best, point, ent, part, world: ent ? null : wh };
}

// 统一的射击：返回命中信息
export function fireHitscan(game, shooter, o, d, stats, weaponName, opts = {}) {
  const r = traceBullet(game, shooter, o, d, opts.maxDist || 400, opts.rewind || null);
  if (r.ent) {
    const dmg = damageAt(stats, r.t, r.part) * (opts.dmgMul || 1);
    // part 要带过去：装甲表按"打在哪儿"分档（js/mp.js:Heli.takeDamage 的 vital/body）。
    // 人身上它就是 'head'/'body'/'legs'，那份 takeDamage 不看这一格，所以加它是免费的。
    const killed = r.ent.takeDamage(dmg, { attacker: shooter, head: r.part === 'head', dir: d, weapon: weaponName, point: r.point, part: r.part });
    // 金属该冒火星，不打 fake 血 —— 打在直升机上喷一蓬血的错不会被报出来，只会让人以为
    // "我把驾驶员打下来了"（真被打下来的也是那台机体，它不是一个人）。
    if (r.ent.metal) game.effects.impact(r.point, _n.copy(d).negate(), 'metal');
    else game.effects.blood(r.point, d, r.part === 'head');
    r.killed = killed; r.dmg = dmg;
  } else if (r.world) {
    game.effects.impact(r.point, r.world.normal, r.world.box.mat || 'concrete');
  }
  return r;
}

// opts.noDamage：**表现副本专用**（联机里"别人扔的那颗雷"在客户端只负责被看见）。
// 少了它就只有两种选择：要么别人的雷在客户端隐形，要么客户端自己也算一次伤害 ——
// 后者不会报错，只会让"这一局死得特别快"，而且两边各扣一次血在报表上完全看不出来。
export function explode(game, pos, radius, maxDmg, attacker, weapon, opts = {}) {
  game.effects.explosion(pos, opts.scale || 1);
  game.audio.explosion(pos, opts.scale || 1);
  // 冲击反馈（震屏 / 耳鸣）**先于**伤害跑，而且不看 noDamage：这一段的语义是
  // "我附近炸了"，不是"我被裁决了伤害"。联机里"别人打来的爆炸不震屏"这条差距就卡在这儿 ——
  // 客户端手上只有表现副本，它不裁伤害，但它知道爆炸在哪儿、离我多远。
  const pl = game.player;
  if (pl && pl.alive) {
    const d = pl.pos.distanceTo(pos);
    if (d < radius * 4) pl.shake(clamp(1.2 - d / (radius * 4), 0, 1) * 1.2);
    if (d < radius * 1.2) game.audio.ring(1.5, 0.05);
  }
  if (opts.noDamage) return;
  // opts.direct：**这一颗火箭是自己撞上去的**（它在 Projectile.update 里对着实体表做过一次
  // 射线，撞到谁记的就是谁）。溅射按距离连续衰减，而"弹体撞在它身上"不是一个随距离
  // 变化的量 —— 装甲那一套（js/mp.js:Heli.takeDamage）就靠这一位分辨"一发入魂"与
  // "在旁边炸开"。少了它的症状：打中座舱与在它脚底下炸开是同一个数，于是"要害"没有凭据。
  const direct = opts.direct || null;
  const src = _p.copy(pos); src.y += 0.4;
  for (const e of game.entities) {
    if (!e.alive || !e.chestPos) continue;
    const c = e.chestPos(_q);
    const dist = c.distanceTo(src);
    if (dist > radius) continue;
    if (attacker && e !== attacker && e.team === attacker.team && !opts.ff) continue;
    if (!direct || direct.ent !== e) { if (game.world.lineBlocked(src, c)) continue; }
    let dmg = maxDmg * Math.pow(1 - dist / radius, 0.8);
    if (e.isPlayer && e.hasPerk && e.hasPerk('eod')) dmg *= 0.5;
    if (e === attacker && e.isPlayer) dmg *= 0.6;
    const dir = new THREE.Vector3().subVectors(c, src).normalize();
    e.takeDamage(dmg, {
      attacker, dir, weapon, explosive: true, point: c.clone(),
      direct: !!direct && direct.ent === e, part: direct && direct.ent === e ? direct.part : undefined,
    });
  }
  game.makeNoise(pos, 80, attacker ? attacker.team : null);
}

export function flashAt(game, pos, owner, opts = {}) {
  game.effects.flashbang(pos);
  game.audio.explosion(pos, 0.4);
  if (opts.noDamage) return;                   // 表现副本：只有那团白光，不裁"谁被闪了"
  const eye = new THREE.Vector3();
  for (const e of game.entities) {
    if (!e.alive || !e.eyePos) continue;
    e.eyePos(eye);
    const d = eye.distanceTo(pos);
    if (d > 18) continue;
    if (owner && e.team === owner.team && e !== owner) continue;
    if (game.world.lineBlocked(pos.clone().setY(pos.y + 0.2), eye)) continue;
    const dir = new THREE.Vector3().subVectors(pos, eye).normalize();
    const facing = e.forward ? Math.max(0, e.forward(new THREE.Vector3()).dot(dir)) : 1;
    let t = (1 - d / 18) * (0.5 + facing * 0.7) * 5;
    if (e.isPlayer) {
      if (e.hasPerk('eod')) t *= 0.5;
      // 真人在权威端是**另一台机器上的浏览器**：hud.flash/audio.ring 在那台机器上够不着
      // （服务端的 game.hud 是桩）。所以这里不是"调一下表现"，而是把"你被闪了多久"
      // 编成一条事件发出去 —— game.flashPlayer 由 NetRoom 提供，浏览器侧没有它就照旧本地放。
      const dur = Math.min(4.5, t);
      if (game.flashPlayer) game.flashPlayer(e, dur);
      else { game.hud.flash(dur); game.audio.ring(Math.min(4, dur), 0.15); }
    } else if (e.stun) e.stun(Math.min(4.5, t + 0.5));
  }
}

export class Projectile {
  // opts.dumb：**表现副本**。联机里"别人扔出来的那一颗"在客户端由这条通路重建 ——
  // 它照样飞、照样磕墙、照样到点炸（视觉与声音都在本机跑），但**一次伤害都不裁决**。
  // 为什么不让权威端直接广播"炸了"然后客户端放个特效：那样落地位置是权威的、
  // 可按点播的事件只有 20Hz，弹道在客户端就会"先到后爆"或者干脆不出现；
  // 让副本自己按同一套物理飞，起手位置/速度来自权威事件，就同时有"看得见"和"落得准"。
  // 代价是副本的爆炸时刻由本地物理决定（与服务端差一两个量化格），但那不是伤害。
  constructor(game, type, pos, vel, owner, fuse, opts = {}) {
    this.game = game; this.type = type; this.pos = pos.clone(); this.vel = vel.clone(); this.owner = owner;
    this.fuse = fuse; this.alive = true; this.stuck = false; this.age = 0; this.bounces = 0;
    this.dumb = !!opts.dumb;
    // mirror：这颗是**玩家自己武器状态机**扔出来的（手雷松手 / RPG 击发）。权威端据此在
    // proj 事件上带 self 标记 —— 投掷者的客户端对那一颗**不再建表现副本**，因为它的本地
    // 预测已经有一颗真的在飞（同一份 weapon-state 代码）。没有这个标记就没法区分"自己
    // 预测过的"与"服务端替我生成的"（连杀排程的集束弹：呼叫者本地没有预测，必须照常
    // 建副本，否则呼叫者自己反而看不见自己的空袭）。必须在 onProjectile 钩子**之前**落字段。
    this.mirror = !!opts.mirror;
    let geo, m;
    if (type === 'frag') { geo = new THREE.SphereGeometry(0.05, 10, 8); m = mat('gunGreen'); }
    else if (type === 'semtex') { geo = new THREE.BoxGeometry(0.08, 0.05, 0.05); m = mat('yellowPaint'); }
    else if (type === 'molotov') { geo = new THREE.CylinderGeometry(0.03, 0.035, 0.2, 8); m = mat('glass'); }
    else if (type === 'flash') { geo = new THREE.CylinderGeometry(0.03, 0.03, 0.11, 8); m = mat('darkMetal'); }
    else if (type === 'smoke') { geo = new THREE.CylinderGeometry(0.035, 0.035, 0.13, 8); m = mat('metal'); }
    else if (type === 'rocket') { geo = new THREE.ConeGeometry(0.06, 0.4, 10).rotateX(-Math.PI / 2); m = mat('gunGreen'); }
    else if (type === 'bomb') { geo = new THREE.CapsuleGeometry(0.12, 0.6, 4, 8).rotateX(Math.PI / 2); m = mat('darkMetal'); }
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.castShadow = true;
    this.mesh.position.copy(this.pos);
    game.scene.add(this.mesh);
    if (type === 'semtex') { this.light = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.3, 0.3) })); this.light.position.y = 0.05; this.mesh.add(this.light); }
    // 权威端挂钩：**这一颗现在存在于世界里了**，把它编成一条事件发出去（NetRoom 收到后
    // 分配 netId 并广播）。做在构造函数里而不是每一个 new 的调用点，是因为调用点有五处
    // （手雷/粘性/燃烧瓶/闪光/烟雾/RPG/集束炸弹），漏一处就是"某种投掷物在联机里隐形"。
    // 浏览器一侧没有这个钩子（game.onProjectile 未定义），所以单机的行为一个字都不变。
    if (game.onProjectile) game.onProjectile(this);
  }
  update(dt) {
    if (!this.alive) return;
    const g = this.game;
    this.age += dt;
    this.fuse -= dt;
    if (this.type === 'rocket') {
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const sd = dt / steps;
        const next = _p.copy(this.pos).addScaledVector(this.vel, sd);
        const dir = _q.copy(this.vel).normalize();
        const len = this.vel.length() * sd;
        const hit = g.world.raycast(this.pos, dir, len + 0.1);
        // 实体那一侧取**最近**的一个，并把"打在哪儿"一并记下来。原来这里写的是
        // `if (h) entHit = e`（最后一个说了算），于是火箭对着站在别人前面的那个人飞过去时，
        // 账会记到后面那个人的头上，而弹道看上去是先擦到了前面那个。
        let entHit = null, entPart = null, entT = Infinity;
        for (const e of g.entities) {
          if (e === this.owner || !e.alive || !e.hitTest || (this.owner && e.team === this.owner.team)) continue;
          const h = e.hitTest(this.pos, dir, len + 0.3);
          if (h && h.t < entT) { entT = h.t; entHit = e; entPart = h.part; }
        }
        if (hit || entHit || this.pos.y < 0.05 || this.age > 6) {
          // 弹体撞上去的那一个要跟着这一炸走下去：有装甲的东西（直升机）就靠它分辨
          // "直击"与"在旁边炸开"。以前这里只传"炸了"，于是火箭从机身中间穿过去，
          // 落在击者身上的也只是"附近有一次爆炸"。
          this.direct = entHit ? { ent: entHit, part: entPart } : null;
          if (hit) this.pos.copy(hit.point).addScaledVector(hit.normal, 0.2);
          return this.detonate();
        }
        this.pos.copy(next);
      }
      this.vel.y -= 1.5 * dt;
      g.effects.smoke.emit({ x: this.pos.x, y: this.pos.y, z: this.pos.z, vx: crand(-0.3, 0.3), vy: crand(0, 0.4), vz: crand(-0.3, 0.3), drag: 1, life: 1.6, s0: 0.2, s1: 1.2, c0: [0.7, 0.7, 0.7], a0: 0.4 });
      g.effects.add.emit({ x: this.pos.x, y: this.pos.y, z: this.pos.z, vx: 0, vy: 0, vz: 0, life: 0.06, s0: 0.4, s1: 0.2, c0: [5, 3, 1], a0: 1 });
      this.mesh.position.copy(this.pos);
      this.mesh.lookAt(_p.copy(this.pos).add(this.vel));
      return;
    }
    if (this.type === 'bomb') {
      this.vel.y -= 12 * dt;
      this.pos.addScaledVector(this.vel, dt);
      this.mesh.position.copy(this.pos);
      this.mesh.lookAt(_p.copy(this.pos).add(this.vel));
      const gh = g.world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.5, 0.1);
      if (this.pos.y <= gh + 0.2) { this.pos.y = gh + 0.1; return this.detonate(); }
      return;
    }
    if (!this.stuck) {
      this.vel.y -= 16 * dt;
      const sub = 3;
      for (let i = 0; i < sub; i++) {
        const sd = dt / sub;
        const sp = this.vel.length();
        if (sp < 0.01) break;
        const dir = _q.copy(this.vel).divideScalar(sp);
        const hit = g.world.raycast(this.pos, dir, sp * sd + 0.06);
        if (hit) {
          this.pos.copy(hit.point).addScaledVector(hit.normal, 0.06);
          if (this.type === 'semtex') { this.stuck = true; this.vel.set(0, 0, 0); g.audio.click(900, 0.05, 0.3, this.pos); break; }
          if (this.type === 'molotov') { return this.detonate(); }
          const vn = this.vel.dot(hit.normal);
          this.vel.addScaledVector(hit.normal, -vn * 1.4);
          this.vel.multiplyScalar(0.55);
          if (Math.abs(vn) > 1.5) g.audio.bounce(this.pos);
          this.bounces++;
        } else this.pos.addScaledVector(this.vel, sd);
      }
      if (this.pos.y < 0.06) {
        this.pos.y = 0.06;
        if (this.type === 'molotov') return this.detonate();
        if (this.type === 'semtex') { this.stuck = true; this.vel.set(0, 0, 0); }
        else { if (this.vel.y < -2) g.audio.bounce(this.pos); this.vel.y = Math.abs(this.vel.y) * 0.35; this.vel.x *= 0.6; this.vel.z *= 0.6; }
      }
      this.mesh.rotation.x += dt * this.vel.length() * 3;
      this.mesh.rotation.z += dt * this.vel.length() * 2;
    }
    this.mesh.position.copy(this.pos);
    if (this.light) this.light.visible = Math.sin(this.age * 20) > 0;
    if (this.type === 'smoke' && this.fuse <= 0 && !this.smoking) {
      this.smoking = true; g.effects.smokeGrenade(this.pos); g.audio.click(600, 0.6, 0.3, this.pos);
      this.fuse = 16;
      return;
    }
    if (this.smoking) { if (this.fuse <= 0) this.remove(); return; }
    if (this.fuse <= 0) this.detonate();
  }
  detonate() {
    const g = this.game;
    this.alive = false;
    g.scene.remove(this.mesh);
    // 表现副本：伤害一律不走（noDamage），但视觉/声音/冲击照旧 ——
    // "我附近炸了"这件事必须由这一台机器自己算，因为那一台只会告诉别人它炸了。
    const nd = this.dumb ? { noDamage: true } : {};
    const wn = { frag: '破片手雷', semtex: '粘性炸弹', molotov: '燃烧瓶', rocket: 'RPG-7', bomb: '集束空袭' }[this.type];
    if (this.type === 'frag' || this.type === 'semtex') explode(g, this.pos, 7, 160, this.owner, wn, nd);
    else if (this.type === 'rocket') explode(g, this.pos, 6, 170, this.owner, wn, { scale: 1.2, ...nd, direct: this.direct });
    else if (this.type === 'bomb') explode(g, this.pos, 8, 180, this.owner, wn, { scale: 1.3, ...nd });
    else if (this.type === 'flash') flashAt(g, this.pos, this.owner, nd);
    else if (this.type === 'molotov') {
      const owner = this.owner;
      const center = this.pos.clone(); center.y = g.world.groundHeight(center.x, center.z, center.y + 0.2, 0.1) + 0.05;
      g.audio.explosion(center, 0.35);
      g.audio.click(2500, 0.3, 0.4, center);
      g.effects.addFireSource(center, 3, 7, this.dumb ? null : (dt, f) => {
        for (const e of g.entities) {
          if (!e.alive) continue;
          if (owner && e.team === owner.team && e !== owner) continue;
          const dx = e.pos.x - f.pos.x, dz = e.pos.z - f.pos.z;
          if (dx * dx + dz * dz < 9 && Math.abs(e.pos.y - f.pos.y) < 1.5) {
            let d = 35 * dt; if (e.isPlayer && e.hasPerk('eod')) d *= 0.5;
            e.takeDamage(d, { attacker: owner, weapon: '燃烧瓶', explosive: true, burn: true, dir: new THREE.Vector3(0, 1, 0) });
          }
        }
      });
      g.effects.flashLight(center.clone().setY(1), 0xff7020, 20, 7, 14);
    }
  }
  remove() { this.alive = false; this.game.scene.remove(this.mesh); }
}

// ---------- 连杀奖励：呼叫之后要发生什么 ----------
//
// 这一对函数是"呼叫 → 生效"这条链路的**后半段**；前半段（谁有资格呼叫、什么时候就绪）
// 在 js/match-rules.js:StreakBook。单机 js/mp.js 与联机 server/room.mjs 共用这一对。
//
// 为什么后半段也要共用：只共用一半等于没共用。联机里的空袭晚到一秒、白磷弹少烧一个人，
// 这种差异不会报错，只会让"联机是不是个残废版"这个疑问一直挂着 —— 而这正是这一轮
// 要收掉的那类**静默失效**。
//
// 两个函数都只依赖 game / clock / owner 这三样，所以权威端（HeadlessGame + NetRoom）
// 拿来就能跑：game.effects / game.audio 在那边是桩，投弹是真的（进 game.projectiles，
// 由 HeadlessGame.step 每拍推进并爆炸）。

// 集束空袭的一串常数：它们互相咬合（落点间隔 × 9 颗 ≈ 弹幕宽度），改一个要连着看。
const CLUSTER_N = 9;             // 九颗
const CLUSTER_SPACING = 3.2;     // 落点沿弹道方向间隔（m）
const CLUSTER_ALT = 45;          // 投放高度（m）
const CLUSTER_FALL = 1.6;        // 从投放高度落到地面要几秒
const CLUSTER_LEAD = 84;         // 呼叫到开始投弹：1.4 s @60Hz
const CLUSTER_STAGGER = 110 / 1000 * 60;   // 每颗之间 110 ms = 6.6 拍

// pos 是弹幕中心，ang 是弹幕铺开的方向（弧度，世界 XZ 平面）。
// 九颗的落点与初速**在这一刻全部算好**，clock 只负责"什么时候投" —— 抽数与投弹绑在
// 一起的话，随机流的位置就跟"第几拍投"挂钩，而那条时序以前是墙钟的。
export function clusterStrike(game, clock, pos, owner, ang) {
  const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
  game.audio.whoosh(pos);
  const drops = [];
  for (let i = 0; i < CLUSTER_N; i++) {
    const p = pos.clone().addScaledVector(dir, (i - (CLUSTER_N - 1) / 2) * CLUSTER_SPACING)
      .add(new THREE.Vector3(rand(-1.5, 1.5), 0, rand(-1.5, 1.5)));
    const start = p.clone().addScaledVector(dir, -25); start.y = CLUSTER_ALT;
    const v = p.clone().sub(start); const T = CLUSTER_FALL;
    drops.push({ start, vel: new THREE.Vector3(v.x / T, (v.y + 0.5 * 12 * T * T) / T, v.z / T) });
  }
  // 九颗的投放时刻**一次排完**（第 84 拍起，每颗隔 6.6 拍），而不是"第 84 拍的回调里
  // 再排剩下八颗"：排程器的到期队列是在这一轮走完之后才收新任务的，嵌套排程会让
  // 第二颗起整体多等一拍 —— 而"弹幕的节奏"是手感的一部分，不是可以晚一拍的东西。
  for (let i = 0; i < CLUSTER_N; i++) {
    const d = drops[i];
    clock.after(CLUSTER_LEAD + Math.round(i * CLUSTER_STAGGER), () => {
      if (game.world) game.projectiles.push(new Projectile(game, 'bomb', d.start, d.vel, owner, 10));
    });
  }
}

// 白磷弹：立刻给 targets 每人 55 点（无视掩体的灼烧），再按拍点着 12 处火。
// 火的**位置**也在这里抽好，理由同上。
// 注意伤害是在**这一拍**结清的，而"持续灼烧"由调用方按 wpTicks 在 update 里每拍结算 ——
// 后者读的是规则内核里的那个计时器，不是这里。
export function phosphorusSweep(game, clock, owner, targets, spread = 12, staggerTicks = 15) {
  for (const e of targets) {
    e.takeDamage(55, { attacker: owner, weapon: '白磷弹', explosive: true, dir: new THREE.Vector3(0, -1, 0) });
  }
  const spots = [];
  for (let i = 0; i < spread; i++) spots.push(game.world.randomWalkable());
  for (let i = 0; i < spread; i++) {
    const p = spots[i];
    // 第一处火排在**下一拍**而不是"这一拍立刻"：排程器的到期队列是在这一轮走完之后
    // 才收新任务的，所以 0 拍就是"下一次 step"。写 Math.max(1, …) 是为了让这个语义
    // 显式可见 —— 它和 0 的结果一样，但读的人不必去推排程器内部。
    clock.after(Math.max(1, i * staggerTicks), () => {
      if (!game.world) return;
      game.effects.explosion(p, 0.8);
      game.audio.explosion(p, 0.5);
      game.effects.addFireSource(p.clone().setY(0.1), 1.5, 8);
    });
  }
}
