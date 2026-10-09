// 联机里的"别人的玩家"。
//
// 它只要满足 combat.js / ai.js 对实体的那套接口（pos / yaw / hp / alive / team /
// hitTest / takeDamage / chestPos / eyePos），就能直接插进 game.entities，
// 被本机玩家的子弹认到、被 HUD 认到。刻意不复用 ai.js 的 Bot —— 那个类带大脑，
// 而这里的人由另一台机器驱动，任何本地"决策"都会和权威端打架。
//
// 快照 20Hz、渲染 144Hz：不插值就只能看见 20Hz 的顿挫，所以渲染时刻统一往回退
// INTERP_DELAY，用两个相邻快照做插值，超出最新快照就用速度外推（有上限，防止
// 断线时人飞出去）。
//
// 表现层（枪声 / 曳光 / 脚步 / 换弹 / 受击 / 倒地 / 名牌）全部由**快照的状态位与读数**
// 推出来，而且必须**逐件记账**：update() 是按渲染帧跑的（144Hz），而一个持续 80ms 的
// Firing 位会被渲染十几帧 —— 不记账就变成"开一枪响十几声"。每件表现各占一格
// "上次做到哪"（fireCool / stepDist / reloading），它们与裁决无关，纯本地。
import * as THREE from 'three';
import { createSoldierModel, animateSoldier, makeNameTag, applyFlashTex } from '../soldier.js';
import { WEAPONS } from '../data.js';
import { angleDiff, clamp, lerp } from '../util.js';
import { hitTestPlayer, LEAN_DIST } from '../combat.js';
import { FLAG, WEAPON_IDS } from '../quant.js';

// 插值回退量（秒）。它不再是一个写死的常数而是**可收放的**：NetClient 每收一份快照
// 按"到达间隔的 EMA + 抖动的 EMA + 余量"重设（js/net/client.mjs:onSnapshot），夹在
// 上下限之间。为什么要收：回退每多 10ms，屏幕上的别人就旧 10ms，开枪要提前的量随之
// 变大（50ms 链路上固定 100ms 意味着瞄准一个 ~150ms 前的世界）。为什么有下限：回退
// 必须盖住"最新一班快照还没到"的那段时间，压得太低插值窗会追上缓冲末端、退化成外推。
// renderTick（报给服务端的拍号）与 NetPlayer.update 读的是**同一个活绑定**，两条口径
// 天然一致 —— 改一处忘一处的症状（"报的拍号和渲染的不是同一拍"）在这条结构下不存在。
export const INTERP_MIN = 0.055;
export const INTERP_MAX = 0.12;
export let INTERP_DELAY = 0.10;                     // 渲染回退量，秒（初值 = 旧固定值，保守起点）
export function setInterpDelay(v) { INTERP_DELAY = clamp(v, INTERP_MIN, INTERP_MAX); }
export const MAX_EXTRAPOLATION = 0.15;              // 速度外推上限，秒
export const LEAVE_FADE = 0.8;                      // 离房淡出时长，秒
const TRACER_LEN = 60;                              // 曳光画多长，米
// 骨骼求解的最小间隔（性能审查 C3）：update 按渲染帧跑，144Hz 屏上两骨 IK + 落骨
// 会跑 144 次/s/人 —— 钉回 60Hz，动画速度不吃亏（dt 用累进的真实帧时）。
const ANIM_MIN_DT = 1 / 60;

const _v = new THREE.Vector3(), _m = new THREE.Vector3(), _e = new THREE.Vector3();

export class NetPlayer {
  constructor(game, o = {}) {
    this.game = game;
    this.id = o.id;
    this.name = o.name || '玩家';
    this.team = o.team || 'A';
    this.isPlayer = false;
    this.targetable = true;
    this.pos = new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0);
    this.vel = new THREE.Vector3();
    this.yaw = o.yaw || 0; this.pitch = 0;
    this.hp = 100; this.maxHp = 100; this.alive = true;
    // 技能表（服务端同步：welcome.others / join / respawn 的 loadout 三处喂）。
    // 小地图的幽灵过滤靠它（hud.drawMinimap 里的 hasPerk('ghost')）—— 协议里没有逐人
    // 技能字段，也不该有：技能跟着装备走，装备的真相在服务端，跟着那三处事件走就够。
    this.perks = Array.isArray(o.perks) ? o.perks.slice() : [];
    this.crouchT = 0; this.proneT = 0; this.leanT = 0; this.onGround = true; this.sprinting = false; this.sliding = false;
    this.revealT = 0; this.dmgT = 99; this.stealthy = false;
    this.radius = 0.35;
    this.lastAttacker = null;
    this.stats = { kills: 0, deaths: 0 };
    this.buf = [];                                  // 到达时间 → 快照，插值的原料
    this.renderT = performance.now() / 1000 - INTERP_DELAY;
    this.weaponId = WEAPON_IDS[o.weapon ?? 0] || 'm4';
    // 套件（配件与迷彩）按**武器 id** 索引，跟着 welcome/join/respawn/pickupTake 四条
    // 接缝走（js/loadout.mjs:kitsOf 是两端共用的那张表）。以前这里恒 {} / 'none' ——
    // 远端人人一把素枪，与单机（随机配件 + 随机迷彩）对不上，而协议里根本没有这两个字段。
    this.kits = {};
    if (o.kits) for (const id of Object.keys(o.kits)) {
      const k = o.kits[id] || {};
      this.kits[id] = { att: k.att || {}, camo: k.camo || 'none' };
    }
    this.modelStyle = o.style || null;
    this.model = this.buildModel();
    applyFlashTex(this.model);
    this.model.root.position.copy(this.pos);
    game.scene.add(this.model.root);
    this.tag = null; this.buildTag();
    this.anim = { speed: 0, phase: 0, crouch: 0, prone: 0, lean: 0, pitch: 0, dead: false, deadT: 0, fallDir: 1, fallRoll: 0, recoil: 0, ads: 0, slide: 0, sprint: 0, air: 0, rocket: true };
    // —— 表现层账本（见文件头）——
    this.fireCool = 0;                              // 下一发枪声还要等多久
    this.stepDist = 0;                              // 从上一声脚步起走了多少米
    this.reloading = false;                         // 上一帧的 Reloading 位
    this.hurtT = 0;                                 // 受击抖动剩余时间
    this.hitDir = new THREE.Vector3(0, 0, 1);       // 受击方向（水平），定倒地方向用
    this.leaving = false; this.leaveT = 0;          // 离房淡出
    this._fadeMats = null;
  }
  // 与 Player.hasPerk 同签名（hud 的小地图过滤对两端的实体一视同仁）
  hasPerk(id) { return this.perks.includes(id); }
  kitOf(wid) { return this.kits[wid] || { att: {}, camo: 'none' }; }
  buildModel() {
    const kit = this.kitOf(this.weaponId);
    return createSoldierModel(this.modelStyle || (this.team === 'A' ? 'ally' : 'enemy'), this.weaponId, kit.att, kit.camo);
  }
  // 装备回声里的套件表（join / respawn / pickupTake 三条路都走它）。手上那把枪的套件
  // 变了就重建模型 —— 不重建的话换装之后要等到下一次换枪才看得出来，而"换了职业没生效"
  // 正是玩家最会报的那种假象。
  setKits(kits) {
    if (!kits) return;
    // 比**表项身份**而不是内容：表里每格都是新对象，所以"当前这把在不在这一批里"
    // 就是 before !== after。按 kitOf 的返回值比会永远为真（它每次交回一个新字面量），
    // 于是别人的换枪也会把我手上的模型重建一遍。
    const before = this.kits[this.weaponId];
    for (const id of Object.keys(kits)) {
      const k = kits[id] || {};
      this.kits[id] = { att: k.att || {}, camo: k.camo || 'none' };
    }
    if (!this.leaving && before !== this.kits[this.weaponId]) this.swapWeapon(this.weaponId);
  }
  dispose() {
    // 淡出用的材质是 beginLeave 里换上去的**私有 clone**（见那里的注释）：全局共享材质
    // 从头到尾没被碰过，所以这里不存在"恢复 opacity"这一步 —— 旧实现那句
    // `m.opacity = 1` 一刀切，正是"别人一退出、我的瞄准镜片永久变不透明"的出处
    // （MATS.lens 的玻璃基线是 0.25）。clone 释放掉即可，纹理是共享引用、不动。
    if (this._fadeMats) { for (const m of this._fadeMats) m.dispose(); this._fadeMats = null; }
    this.game.scene.remove(this.model.root);
    this.buf.length = 0;
  }

  // 名牌只给**队友**（单机是 `tag: team === 'A' && !this.ffa`，见 js/mp.js:95）。
  // 以前这里无差别地人人挂一块，而 makeNameTag 的材质是 depthTest:false + renderOrder 10 ——
  // 于是敌人隔着墙也能被点名，成了"联机比单机知道得更多"的唯一一处。
  buildTag() {
    if (this.tag) {
      this.model.root.remove(this.tag);
      if (this.tag.material && this.tag.material.map) this.tag.material.map.dispose();
      if (this.tag.material) this.tag.material.dispose();
      this.tag = null;
    }
    const me = this.game.player;
    if (!me) return;
    // FFA 要**显式**排除，不能靠"队键每人一支所以永远不相等"这个巧合：单机那半写的是
    // `team === 'A' && !this.ffa`（js/mp.js:95），那里有明写的 ffa 位。联机这边没有它的
    // 话，"FFA 没有名牌"这件事完全寄生在队键的形状上 —— 哪天给 FFA 引入临时结盟、
    // 或队键改成共用一支队，这里会静默翻转成"组内互挂名牌"，正是上面注释挡的那一半。
    if (this.game.net && this.game.net.ffa) return;
    if (me.team !== this.team) return;
    this.tag = makeNameTag(this.name, '#6cf');
    this.model.root.add(this.tag);
  }

  setName(name, team) {
    this.name = name;
    if (team) this.team = team;
    this.buildTag();
  }

  // 人走了 / 掉线：不瞬时从世界上抹掉，先淡出。瞬时消失没有办法从画面上与"我自己卡了"
  // 分辨 —— 而那正是联机里最容易误判的一类现象。
  // 淡出**不许直接写共享材质**：士兵和手上的枪的材料多半来自 materials.js 的全局 MATS
  // （镜片 lens、分划 reticle、军服 fab_*、枪身 gunMetal……第一人称视图模型用的是**同一批
  // 实例**）。旧实现把收集到的材质 transparent=true、逐帧写 opacity、dispose 再恢复
  // opacity=1 —— 于是"别人退出对局"的那 0.8 秒里，我的瞄准镜片跟着他一起变透明
  // （0.25 → 0），淡完还被一刀切恢复成不透明玻璃（0.25 → 1），军服那批 opaque 材质则
  // 从此永远走透明渲染管线（transparent 没人恢复）。修法：把淡出模型的每块 mesh 换成
  // **私有 clone**（同一原材质只 clone 一份，mesh 间仍共享、渲染批次不变），淡出只写
  // clone，dispose 丢弃 clone —— 全局材质没人动过，也就无所谓恢复。
  beginLeave() {
    if (this.leaving) return;
    this.leaving = true; this.leaveT = 0;
    // AOI 藏着的人也要走淡出：先解除隐藏 —— 淡出要看得见，root.visible=false 的模型
    // 淡完了也没人看见，症状是"他退出对局了，画面上那个残影直接瞬消"。
    if (this.far) this.setFar(false);
    this.targetable = false;                   // 已经不在权威世界里了：不许再被打
    this.alive = false;
    const clones = new Map();                  // 原材质 → 私有 clone（同一次淡出内共享）
    this.model.root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      let c = clones.get(o.material);
      if (!c) { c = o.material.clone(); clones.set(o.material, c); }
      o.material = c;
    });
    this._fadeMats = [...clones.values()];
    // opaque 材质参与淡出必须开 transparent —— 只开在 clone 上，原材质不知道这件事
    for (const m of this._fadeMats) m.transparent = true;
  }
  get fadedOut() { return this.leaving && this.leaveT >= LEAVE_FADE; }

  // ── AOI 的"远了"（dom 大房规模化阶段 1）──
  // 服务端按距离裁快照（200m 进 / 220m 退出滞回），他缺席的这段时间里：
  //   · 模型与名牌藏起 —— 但**不是** beginLeave：他没走，只是走出了 200m；
  //   · 插值缓冲截短到 2 —— 回来时插值直接从最新两包起步，不重演 0.75s 的旧轨迹；
  //   · update() 整个短路（见那里）—— 插值/骨骼/枪声/脚步对一个看不见的人全是白烧。
  setFar(v) {
    if (this.far === v) return;
    this.far = v;
    this.model.root.visible = !v;
    if (v) { this.revealT = 0; if (this.buf.length > 2) this.buf.length = 2; }
  }

  push(s, now) {
    this.buf.push({ t: now, s });
    if (this.buf.length > 24) this.buf.shift();
  }

  curEye() { return lerp(lerp(1.62, 1.05, this.crouchT), 0.45, this.proneT); }
  // 探头侧移与 Player 同一份几何（LEAN_DIST、右向 (cos yaw, 0, -sin yaw)）：eyePos 是
  // "他的眼睛"、chestPos 是躯干盒中心（半量），Bot/HUD 对两类实体一视同仁。
  eyePos(out) {
    const l = this.leanT * LEAN_DIST;
    return out.set(this.pos.x + Math.cos(this.yaw) * l, this.pos.y + this.curEye(), this.pos.z - Math.sin(this.yaw) * l);
  }
  chestPos(out) {
    const l = this.leanT * LEAN_DIST * 0.5;
    return out.set(this.pos.x + Math.cos(this.yaw) * l, this.pos.y + this.curEye() - 0.4, this.pos.z - Math.sin(this.yaw) * l);
  }
  forward(out) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  // 命中盒与权威裁决**共用一处定义**（js/combat.js:hitTestPlayer）。本机这份只影响"打到了"
  // 的即时反馈（真值在服务端），但盒子必须是同一个：抄一份的症状是"改了常数之后本地反馈说中、
  // 权威说没中"，而两边都不报错。延迟补偿的缓冲里存的也正是这个函数的七个入参。
  // yaw/lean 用权威值不用平滑值：裁决不迟于权威，平滑只是给观众看的。
  hitTest(o, d, maxT) {
    return hitTestPlayer(this.pos.x, this.pos.y, this.pos.z, this.curEye(), this.yaw, this.proneT > 0.5 ? 1 : 0, this.leanT, o, d, maxT);
  }
  // 客户端不裁决伤害：只记下"我这一枪大概打掉多少"用于反馈，真值等服务器快照。
  // 返回值是**本地预测**的"这一枪会不会打死他"：它只驱动红叉与击杀音
  // （weapon-state.js:216-219 读 r.killed），不会让任何人真死 —— alive 只由快照写。
  // 以前这里恒 return false ⇒ 打死对方也没有击杀型红叉与击杀音，于是"打中了但不知道
  // 打死没有"，要等一条事件回来才知道。
  takeDamage(dmg, info) {
    this.hp = Math.max(0, this.hp - dmg);
    this.dmgT = 0;
    this.hurtT = 0.18;
    if (info && info.dir) {
      this.hitDir.set(info.dir.x, 0, info.dir.z);
      if (this.hitDir.lengthSq() > 1e-6) this.hitDir.normalize();
    }
    if (info && info.attacker) this.lastAttacker = info.attacker;
    // 倒地方向按**受击方向**定（与 ai.js:101-104 同一套）：从背后打中的向前扑、
    // 从正面打中的向后倒。以前这里是构造函数里那个恒定的 1，于是所有人朝同一边倒。
    const f = this.forward(_v);
    this.anim.fallDir = f.dot(this.hitDir) > 0 ? -1 : 1;
    this.anim.fallRoll = (Math.random() - 0.5) * 0.6;
    return this.hp <= 0;
  }

  applyState(s) {
    this.hp = s.hp;
    this.alive = !!(s.flags & FLAG.Alive);
  }

  // 骨骼求解钉 60Hz（性能审查 C3）：pos/yaw/姿态通道的插值与平滑仍按渲染帧走
  // （144Hz 下移动依旧丝滑），只有两骨 IK + 落骨这一坨按 ≥1/60 的节拍跑，dt 用
  // 累进的真实帧时 —— 动画速度与 60Hz 驱动同速。按 60Hz 驱动（net-feel、锁 60 的
  // 渲染）时每拍必发，行为与旧代码一致。animRuns 给判据数（net-feel 的 C3 段）。
  // 距离 LOD（阶段 1）：快照本来就是 20Hz，30m 外的人腿上那点 60Hz 细节根本看不出来
  // —— 30m 内 60Hz（原值），80m 内 15Hz，更远 5Hz。100 人同屏的房间里骨骼 IK 是
  // 按人头计费的，这一档把"远处的多数"从每帧最贵的那一项里摘出去。
  _anim(dt) {
    this._animT = (this._animT || 0) + dt;
    const me = this.game.player;
    const d = me ? Math.hypot(this.pos.x - me.pos.x, this.pos.z - me.pos.z) : 0;
    const min = d < 30 ? ANIM_MIN_DT : d < 80 ? (1 / 15) : (1 / 5);
    if (this._animT < min) return;
    this.animRuns = (this.animRuns || 0) + 1;
    animateSoldier(this.model, this.anim, this._animT);
    this._animT %= min;
  }

  update(dt, now = performance.now() / 1000) {
    // 正在淡出的人不再接快照、不再做表现，只把倒地动画走完 + 把不透明度推下去。
    if (this.leaving) {
      this.leaveT += dt;
      this.anim.speed = 0;
      this._anim(dt);
      const k = clamp(1 - this.leaveT / LEAVE_FADE, 0, 1);
      for (const m of this._fadeMats || []) m.opacity = k;
      if (this.tag) this.tag.visible = false;
      return;
    }
    // AOI 藏着的人（setFar(true)，快照里暂时缺席）：模型已藏，插值/骨骼/枪声/脚步
    // 对一个看不见的人全是白烧 —— 整个短路。他回到 200m 内时 onSnapshot 会先
    // setFar(false) 再 push，下一帧从这里继续。
    if (this.far) return;
    this.drives = (this.drives || 0) + 1;     // 插值有没有真的被驱动：没跑起来时 pos 会一直停在构造点
    const target = now - INTERP_DELAY;
    const buf = this.buf;
    let s;
    if (!buf.length) s = null;
    else if (target <= buf[0].t) s = buf[0].s;
    else if (target >= buf[buf.length - 1].t) {
      const last = buf[buf.length - 1];
      const dt2 = clamp(target - last.t, 0, MAX_EXTRAPOLATION);
      // 外推写进这块复用的 scratch（性能审查 W3，与下面插值分支共用一份）：先把上一份快照
      // 整份搬进来（与 `{...last.s}` 同义），再只改位置两格。搬的是快照的**值**，buf 里那份
      // 原件不许动 —— 它是跨帧持有的插值原料。
      s = this._s || (this._s = {});
      Object.assign(s, last.s);
      s.x = last.s.x + last.s.vx * dt2;
      s.z = last.s.z + last.s.vz * dt2;
    } else {
      let i = 0;
      while (i < buf.length - 1 && buf[i + 1].t < target) i++;
      const a = buf[i], b = buf[i + 1];
      const k = clamp((target - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
      // 逐字段写进同一块 scratch（性能审查 W3）：插值结果只活到本次 update 结束、消费全在
      // 这一帧内，复用是安全的。**字段一个都不能少**（mag 那次的教训：抄漏一格它就静默变成
      // undefined，而两端点分支拿到的是原快照，于是"有的包有、有的包没有"）。
      s = this._s || (this._s = {});
      s.x = lerp(a.s.x, b.s.x, k); s.y = lerp(a.s.y, b.s.y, k); s.z = lerp(a.s.z, b.s.z, k);
      s.yaw = a.s.yaw + angleDiff(a.s.yaw, b.s.yaw) * k;
      s.pitch = lerp(a.s.pitch, b.s.pitch, k);
      s.hp = lerp(a.s.hp, b.s.hp, k); s.flags = k < 0.5 ? a.s.flags : b.s.flags;
      // 步态相位是**角度**量（服务端那边一直往上加、编解码折进 [0,2π)），所以按**角差**插值。
      // 这里原来写成"就近取 a 或 b" —— 那正是"腿部每包跳一次整数"的另一半成因：
      // 20Hz 相邻两包差 0.5 rad 左右，取整就是每 50 ms 跳一格。按角差 lerp 之后渲染帧上
      // 是连续的，而幅值仍然完全来自权威端（客户端不自己积分）。
      s.phase = a.s.phase === undefined ? undefined : a.s.phase + angleDiff(a.s.phase, b.s.phase) * k;
      s.vx = lerp(a.s.vx, b.s.vx, k); s.vz = lerp(a.s.vz, b.s.vz, k);
      s.weapon = b.s.weapon;
      // mag 要跟着一起搬：这个分支是**新拼出来的**对象，抄漏任何一格它就静默变成 undefined
      // （两端点分支拿到的是原快照，于是"有的包有、有的包没有"）。以前 mag 就这么丢的 ——
      // 它是"到了没人消费"那一半的真正成因。
      s.mag = b.s.mag;
    }
    if (!s) return;
    this.hp = s.hp; this.alive = !!(s.flags & FLAG.Alive);
    this.crouchT = (s.flags & FLAG.Crouch) ? 1 : 0;
    this.proneT = (s.flags & FLAG.Prone) ? 1 : 0;
    // 探头：权威只给方向两位（LeanL/LeanR），本机的 hitTest/eyePos 吃**瞬时**的 ±1/0，
    // 动画通道（a.lean）另做平滑 —— 与 yaw 同一套分工。
    this.leanT = ((s.flags & FLAG.LeanR) ? 1 : 0) + ((s.flags & FLAG.LeanL) ? -1 : 0);
    this.sprinting = !!(s.flags & FLAG.Sprint);
    this.onGround = !!(s.flags & FLAG.OnGround);
    this.sliding = !!(s.flags & FLAG.Sliding);
    this.yaw = s.yaw; this.pitch = s.pitch;
    const px = this.pos.x, pz = this.pos.z;
    this.pos.set(s.x, s.y, s.z);
    this.vel.set(dt > 0 ? (this.pos.x - px) / dt : 0, 0, dt > 0 ? (this.pos.z - pz) / dt : 0);

    const wid = WEAPON_IDS[s.weapon ?? 0];
    if (wid && wid !== this.weaponId) this.swapWeapon(wid);
    const st = WEAPONS[this.weaponId] || WEAPONS.m4;
    // RPG 弹头的 _rpgHold 兜底倒计时（见下面 Reloading 块）：快照断流时旗位不动，
    // 按装填时长把弹头放回筒口，宁可猜错也别永久空膛
    if (this._rpgHold > 0 && (this._rpgHold -= dt) <= 0) this.anim.rocket = true;

    const m = this.model.root;
    m.position.copy(this.pos);
    // 模型正面在 -Z（眼睛 z=-0.161、枪 z=-0.3、背包 z=+0.2），而 forward = (-sin yaw, 0, -cos yaw)
    // 与第一人称相机 rotation.y = yaw 是同一套 —— 所以这里**不能**再 +π：三个约定里只有这一处
    // 是异类，症状是"别人朝你跑，你看到的是背对着你倒着跑"。
    // 转向按最短弧平滑（angleDiff 走短边，16/s）：快照 20Hz，大角度回头是阶跃，
    // 直接赋值模型会瞬转半圈。只平滑**模型**；开火弹道方向（下面 tracer/dir）仍用权威
    // this.yaw，不吃平滑延迟 —— 裁决在服务端，这里只是让观众看得自然。
    if (this.yawSm === undefined) this.yawSm = this.yaw;
    this.yawSm += angleDiff(this.yawSm, this.yaw) * Math.min(1, dt * 16);
    m.rotation.y = this.yawSm;
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const a = this.anim;
    a.crouch = this.crouchT;
    // 趴姿通道与冲刺/滞空同一套：位来自快照，按帧平滑（10/s）交给 animateSoldier。
    // 直接跳变会让模型"啪"地拍在地上 —— 这人趴下时尤其明显，整个身位都在转。
    a.prone = lerp(a.prone, this.proneT, Math.min(1, dt * 10));
    // 探头通道：位是 ±1 的阶跃（20Hz），模型按帧平滑 —— 直接跳变会把躯干甩过去。
    a.lean = lerp(a.lean, this.leanT, Math.min(1, dt * 10));
    // 同理：俯仰不加负号（本地 AI 是 `A.pitch = this.pitch`，ai.js:329）。
    a.pitch = this.pitch;
    a.speed = spd;
    // 步态：优先用权威相位（跑动时脚不打滑），老服务端不发这一格时退回本地积分。
    // 这里**不许**再按速度把相位归零 —— animateSoldier 里的摆幅本来就由 `moving` 门住，
    // 而归零会在低速起步时把腿拽回中位，那正是"低速时直接归零"这条症状。
    if (s.phase !== undefined) a.phase = s.phase;
    else a.phase += dt * spd * 2.2;
    a.dead = !this.alive;
    if (!this.alive) { a.deadT += dt; } else a.deadT = 0;
    a.recoil = (s.flags & FLAG.Firing) ? 1 : 0;
    // 举枪 / 滑铲两个姿态通道：权威位是 0/1，按帧平滑（12/s）再交给 animateSoldier ——
    // 直接跳变会让模型"啪"地弹进姿态。位本身来自快照（FLAG.Ads / FLAG.Sliding），
    // 以前只存不用：对方据枪瞄你和腰射在画面上一模一样，滑铲的人立着滑。
    a.ads = lerp(a.ads, (s.flags & FLAG.Ads) ? 1 : 0, Math.min(1, dt * 12));
    a.slide = lerp(a.slide, this.sliding ? 1 : 0, Math.min(1, dt * 12));
    // 冲刺 / 滞空同理：位在快照里存了很久（this.sprinting / this.onGround），模型端一直没消费。
    a.sprint = lerp(a.sprint, this.sprinting ? 1 : 0, Math.min(1, dt * 10));
    a.air = lerp(a.air, this.onGround ? 0 : 1, Math.min(1, dt * 10));
    this._anim(dt);

    // 受击抖动：模型沿弹道方向被推一下，幅度线性衰减。纯表现，不改 pos（pos 是权威的）。
    if (this.hurtT > 0) {
      this.hurtT = this.alive ? Math.max(0, this.hurtT - dt) : 0;
      if (this.hurtT > 0) m.position.addScaledVector(this.hitDir, (this.hurtT / 0.18) * 0.10);
    }
    this.revealT = Math.max(0, this.revealT - dt);

    if (this.tag) this.tag.visible = this.alive;

    // —— 开火 ——
    // 快照只给一个**状态位**（Firing = 距上次开火 < 0.08 s），人却在 144Hz 渲染：
    // 要把它还原成"每发一次"，只能按武器射速自己记账。少了这格账，一开火会连响十几声。
    // 已知边界（不修，记下来）：快照断流时 s 走外推分支、flags 原样沿用最新那一包，
    // 于是"最后那一包里 Firing 亮着"会一直响到看门狗判定失联（2.5 s）。那一段里对方
    // 大概率真的还在开火，所以宁可让它响 —— 而"人在世界上一动不动却持续开枪"正是
    // markLost 要报的那个状态。
    this.fireCool = Math.max(0, this.fireCool - dt);
    if (this.alive && (s.flags & FLAG.Firing) && this.fireCool <= 0) {
      this.fireCool = Math.max(0.055, 60 / (st.rpm || 600));
      // 发射器击发：弹头离膛（不再坐在筒口），装填位/兜底倒计时负责放回
      if (st.type === 'launcher') { this.anim.rocket = false; this._rpgHold = (st.reload || 3) + 0.5; }
      const muzzle = this.model.muzzle ? this.model.muzzle.getWorldPosition(_m) : _m.copy(this.pos);
      const cp = Math.cos(this.pitch);
      const dir = _v.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
      // 曳光画到枪口前方 TRACER_LEN 米。**不**在这里 raycast：命中是权威端的活，
      // 本地 raycast 出来的终点（不带回溯）只会多画一条假弹道。观感上够用。
      // 发射器不画曳光：那颗火箭本体（proj 事件的 dumb 副本）就飞在同伴位置，
      // 再叠一条曳光就是一根直棍穿过弹头。
      if (st.type !== 'launcher') this.game.effects.tracer(muzzle, _e.copy(muzzle).addScaledVector(dir, TRACER_LEN), [1.5, 1.0, 0.5]);
      this.game.audio.shot(st.sound, this.pos, st.suppressed);
      if (Math.random() < 0.25) this.game.effects.flashLight(muzzle, 0xffb060, 2.5, 0.05, 7);
      if (!st.suppressed) this.game.effects.muzzle(muzzle, dir, 1, false);   // 枪口烟/火星（与单机同一套）
      if (!st.suppressed) this.revealT = 1.5;    // 小地图亮点（hud.js 读它，和单机同一条）
      const fl = this.model.flash;
      if (fl) { fl.visible = true; fl.material.rotation = Math.random() * 6; this._flashT = 0.04; }
    }
    const fl2 = this.model.flash;
    if (fl2 && !(s.flags & FLAG.Firing)) {
      this._flashT = (this._flashT || 0) - dt;
      if (this._flashT <= 0) fl2.visible = false;
    }

    // —— 脚步声 ——
    // 和本机玩家一样按**走过的距离**记（js/player.js），不是按时间：按时间的话慢走和
    // 冲刺一样密。走同一条 audio.step(pos, surface, vol)。vol 比本机脚步高整档：
    // 本机的脚步自己听是"背景"，别人的脚步是**敌情** —— 它要穿过空间衰减（audio.step
    // 里 reach 0.55 那一档）之后仍然可闻，逼近的人才藏不住。
    if (this.alive && this.onGround && !this.sliding && spd > 0.3) {
      this.stepDist += Math.hypot(this.pos.x - px, this.pos.z - pz);
      if (this.stepDist > (this.sprinting ? 2.0 : 1.6)) {
        this.stepDist = 0;
        const surf = (this.game.world && this.game.world.def && this.game.world.def.surface) || 'dirt';
        this.game.audio.step(this.pos, surf, this.proneT > 0.5 ? 0.07 : this.crouchT > 0.5 ? 0.1 : this.sprinting ? 0.38 : 0.24);
      }
    } else if (!this.alive) this.stepDist = 0;

    // —— 换弹 ——
    // 快照给的是**过程位**（Reloading 是一个持续状态，不是边缘），所以取两个跳变点各响一声，
    // 正好对上本机那条链的三段音（weapon-state.js 的 out / in）。带 this.pos：别人的
    // 换弹要有距离与声像 —— 不带的话那串"咔哒"会以满音量从正中来，分不清是谁在换。
    const rl = this.alive && !!(s.flags & FLAG.Reloading);
    if (rl !== this.reloading) {
      this.game.audio.reload(rl ? 'out' : 'in', this.pos);
      this.reloading = rl;
      // RPG 弹头随装填位离手/回膛：战术换弹（没打空就装）没有击发沿可用，靠这段
      // 让"装填整段=膛空"；收回的精确时机就是装填位落下的那一拍。
      if (this.model.warhead && st.type === 'launcher') this.anim.rocket = !rl;
    }
    // mag 的消费点：霰弹枪是**一发一发**装的，单机那边每入膛一发响一声（weapon-state.js
    // 的 audio.reload('shell')），而 Reloading 位只有"开始/结束"两个跳变 —— m870 的装弹声
    // 在联机里因此整段只剩两声。mag 每 +1 就是一发入膛，正好把中间那几声补回来。
    const prevMag = this.lastMag;
    this.lastMag = s.mag;
    if (rl && st.shellReload && prevMag !== undefined && s.mag > prevMag) this.game.audio.reload('shell', this.pos);
  }
  swapWeapon(wid) {
    this.weaponId = wid;
    // 上一把枪的弹匣读数不许跨枪比较：新枪第一包 mag 若恰好比旧枪的最后一包大 1，
    // 会替霰弹枪多响一声装填。置空让它从"没有上一格"重新开始。
    this.lastMag = undefined;
    this.anim.rocket = true;                   // 新枪新弹膛，RPG 弹头位作废重来
    this.game.scene.remove(this.model.root);
    this.model = this.buildModel();          // 配件/迷彩按 kits 表走（差距 29）
    applyFlashTex(this.model);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;      // 同 update：不加 π
    this.yawSm = this.yaw;                      // 换枪重建了模型,平滑值从当前朝向重新起步
    this.game.scene.add(this.model.root);
    this.tag = null; this.buildTag();
    this._fadeMats = null;
  }
}
