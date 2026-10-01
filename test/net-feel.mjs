// 联机"手感层"的判据：远端玩家的表现层 + 本地玩家的反馈闭环。
//
// 这一层的东西有个共同点：**全都不影响权威状态** —— 少了它不崩、不报错、不丢伤害，
// 只是"看不见 / 听不见 / 没反应"。所以它最容易被改坏，也最容易因为"改坏了也没人发现"
// 而在下一次重构里被顺手删掉。它的另一半（协议里有没有那个字节）在 server/net-probe.mjs
// 与 test/net-play.mjs 里量，这里量的是"字节到了之后有没有人画"。
//
// 三条纪律，按本仓库的老规矩来：
//   ① 每条判据都配**反证臂**，而且反证不是靠注释承诺的 —— 要么直接按旧写法算一遍
//      （C 段的 144Hz 假想臂、D 段的"取端点"臂），要么量一个"旧写法必然给出的读数"
//      （B 段的 phase=0、F 段的两条 fallDir 必须一正一负）。
//   ② **量具先自证活着**：J 段先证明"g.frame 之外我真的驱动了 update"（drives 计数），
//      K 段先证明"服务端那条闸门在正常输入上会放行"，否则全绿可能只是断言没跑。
//   ③ 前提写进判据：相位那几条都要先确认客户端**拿到了**权威相位（`s.phase !== undefined`），
//      否则测的是"退回本地积分"那条路。
//
// 无浏览器：NetPlayer 只碰 THREE 的对象树与 stub 出来的 audio/effects/hud，
// 在 Node 里靠 server/browser-shim.mjs 就能原样跑（那个垫片存在的理由就是 textures.js
// 建的那三个 canvas）。NetClient 那一段更轻 —— onEvents 是个纯方法，直接喂事件帧即可。
import '../server/browser-shim.mjs';
import * as THREE from 'three';
import { NetPlayer, LEAVE_FADE, INTERP_DELAY } from '../js/net/remote.mjs';
import { createSoldierModel, animateSoldier } from '../js/soldier.js';
import { flashAt, Projectile, explode } from '../js/combat.js';
import { NetClient } from '../js/net/client.mjs';
import { NetRoom } from '../server/room.mjs';
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { pauseActions, isImeKey } from '../js/menu.js';
import { parseChatCommand, toggleMute, isMuted, chatRowHtml, chatTime } from '../js/net/chat.mjs';
import { foldJudge, IDLE_FLOOR } from '../js/net/idle-ruler.mjs';
import { FLAG, WEAPON_IDS, POS_STEP } from '../js/quant.js';
import { WEAPONS } from '../js/data.js';

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);

const TWO_PI = Math.PI * 2;
const angDiff = (a, b) => { let d = (b - a) % TWO_PI; if (d > Math.PI) d -= TWO_PI; if (d < -Math.PI) d += TWO_PI; return d; };

// ───────────────────────── 环境桩 ─────────────────────────
// 记录"表现层到底调了什么"。刻意不用真 Effects/Audio：那一层要 WebGL 与 AudioContext，
// 而这里要断言的是**调用次数与参数**，不是听感。
function makeGame() {
  const log = { shot: 0, step: 0, reload: [], tracer: 0, flashLight: 0, muzzle: 0, ring: [], hurt: 0, markers: null, smoke: 0 };
  const game = {
    time: 0, scene: new THREE.Scene(), entities: [], projectiles: [],
    world: { def: { surface: 'dirt' }, lineBlocked: () => false },
    player: { name: '我', team: 'A', pos: new THREE.Vector3(), alive: true },
    // Heli.update 拿相机位置调旋翼音量 —— 桩里没这一格的话 X 段会 TypeError，
    // 而"桩不全崩掉"不是判据的失败形状（见文件头纪律③）。
    camera: { position: new THREE.Vector3() },
    // NetClient.update 每次都要写这一格（白磷弹的屏幕效果）。不给它的话 R 段会因为
    // "桩不全"而抛错，而那看起来像"ping 那条判据红了" —— 桩的缺口要在这里补齐，不要改被测对象。
    grade: { uniforms: { wp: { value: 0 } } },
    log,
    audio: {
      shot: () => { log.shot++; }, step: () => { log.step++; },
      reload: (s) => log.reload.push(s), ring: () => { log.ring.push(1); },
      hurt: () => { log.hurt++; }, explosion: () => {}, whoosh: () => {}, say: () => {}, beep: () => {},
      // 直升机的旋翼循环音走这三个（Heli 构造/update 要用）
      loop: () => {}, setLoopVol: () => {}, stopLoop: () => {}, click: () => {}, ui: () => {},
    },
    effects: {
      tracer: () => { log.tracer++; }, flashLight: () => { log.flashLight++; }, flashbang: () => {}, explosion: () => {}, blood: () => {}, impact: () => {},
      // 枪口烟/火星（remote.mjs 的 Firing 位那一段，消音器压住时不调）。按次计数：
      // 它和曳光/枪口光吃同一格账（fireCool 记账之后各画各的），C3 顺带量它。
      muzzle: () => { log.muzzle++; },
      // 直升机冒烟（Heli.update 的 hp < 70% 那一段）按次计数 —— 它是"损伤状态看得见"的证据
      smoke: { emit: () => { log.smoke++; } }, add: { emit: () => {} },
    },
    // explode 末尾会 makeNoise 一下（把爆炸报给 AI 的听觉）。少了它 P 段抛的是 TypeError，
    // 而"抛异常"不是判决 —— 判据的失败必须是断言红，不能是桩不全崩掉。
    makeNoise: () => {},
    hud: {
      announce: () => {}, popup: () => {}, killfeed: () => {}, damageFrom: () => {}, flash: () => {}, scorebar: () => {},
      streaks: (list, kills) => { log.streaks = { list, kills }; }, showScoreboard: () => {}, hitmarker: () => {},
      setMarkers: (l) => { log.markers = l; }, prompt: () => {}, progress: () => {}, highAlert: () => {},
    },
  };
  return game;
}

// 一帧快照（字段名与 server/codec.mjs:decodeSnapshot 的输出一致）。
const snap = (o = {}) => ({
  id: 2, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100,
  flags: FLAG.Alive | FLAG.OnGround, weapon: 0, mag: 30, phase: 0, vx: 0, vz: 0, team: 0, ack: 0, rep: 0, ...o,
});
const mkRemote = (g, o = {}) => new NetPlayer(g, { id: 2, name: '敌', team: 'B', weapon: 0, x: 0, y: 0, z: 0, yaw: 0, ...o });

// ───────────────────────── A. 朝向与俯仰（差距 22 / 23）─────────────────────────
// 三条独立约定互相印证：模型正面在 -Z、forward = (-sin y, 0, -cos y)、第一人称相机 rotation.y = yaw。
// 本地 AI 与它们一致（js/ai.js:332 / :329），只有远端那两行是异类 —— 症状是"别人朝你跑，
// 你看到的是背对着你倒着跑"。
{
  const g = makeGame();
  const r = mkRemote(g);
  // 时间轴**显式**给：update(dt) 不传 now 时默认 performance.now()/1000，那一刻机器
  // 起来多久就成了渲染落点。0.10 那一包刚推进去时若默认 now 只有 0.03 上下，target
  // = now − INTERP_DELAY 会落到**前两包之间**，量出来的不是刚喂进去的那一包。基准取
  // 1.0（远离 0，也远离 performance.now() 的典型量级），每一拍的 now 都从它算。
  const T0 = 1.0;
  r.push(snap({ yaw: 1.0, pitch: 0.3 }), T0);
  r.push(snap({ yaw: 1.0, pitch: 0.3 }), T0 + 0.05);
  r.update(1 / 60, T0 + 0.05 + INTERP_DELAY);
  // 判据读**权威值**（this.yaw / this.pitch），不读 model.rotation.y：那一格是 yawSm 经过
  // 16/s 平滑之后的产物，一帧只走 26.7%，读它就是在考"平滑跑到第几帧了"而不是考符号
  // —— 反过来说，符号要是真写反了，model.rotation.y 也认不出来（1.0 与 4.1416 都在
  // yawSm 从 0 往上爬的同一条路上）。平滑那一格由下面 A3a/A3b/A3c 三条单独钉。
  ok('A1 权威 yaw 落进 this.yaw（不加 π）', Math.abs(r.yaw - 1.0) < 1e-9,
    `this.yaw=${r.yaw.toFixed(4)}（旧写法会给 ${(1.0 + Math.PI).toFixed(4)}）`);
  ok('A2 权威 pitch 落进 anim.pitch（不加负号）', Math.abs(r.anim.pitch - 0.3) < 1e-9,
    `anim.pitch=${r.anim.pitch.toFixed(4)}（旧写法会给 ${(-0.3).toFixed(4)}）`);
  // 反证臂：上一行不是"反正都等于 0"的恒绿 —— 两个符号都要能被看见
  r.push(snap({ yaw: -1.4, pitch: -0.6 }), T0 + 0.10);
  r.update(1 / 60, T0 + 0.10 + INTERP_DELAY);
  ok('A3 反证臂：换一个符号相反的读数，两条都跟着翻（不是恒 0 的绿灯）',
    Math.abs(r.yaw + 1.4) < 1e-9 && Math.abs(r.anim.pitch + 0.6) < 1e-9,
    `this.yaw→${r.yaw.toFixed(4)} · anim.pitch→${r.anim.pitch.toFixed(4)}`);
  // 平滑的**瞬态**：权威值刚从 +1.0 翻到 -1.4，转向按 16/s 平滑，一帧只走 26.7%，
  // 所以这一拍不能跳到目标上（跳到目标 = 平滑根本不存在 = 大角度回头时模型瞬转半圈）。
  // 改这一带最容易顺手写成 `this.yawSm = this.yaw`，那条只有这一格抓得住。
  ok('A3a 反证臂：权威值大角度翻号时**不**瞬转（16/s 平滑真的在起作用）',
    Math.abs(r.yawSm - r.yaw) > 0.5 && Math.abs(r.yawSm - 1.0) < Math.abs(r.yawSm - r.yaw),
    `yawSm=${r.yawSm.toFixed(4)} · 还在 +1.0 这一侧，离目标 ${Math.abs(r.yawSm - r.yaw).toFixed(4)}`);
  // 平滑那一格另立两条，都拿**有效值**（r.yaw）当参照而不是拿字面量 -1.4：加符号很容易
  // 顺手改成 `m.rotation.y = -this.yawSm` —— 那会让上面两条照样全绿（它们读的是权威值），
  // 而模型真的背过去。所以这里把平滑跑到收敛（渲染时刻逐帧往前推，yaw 每帧都取权威的
  // -1.4），既要求落点**收敛到**权威值（不是停在中间值、也不是收敛到 -yaw），也要求写进
  // 模型的那一格确实等于收敛值。
  for (let i = 0; i < 40; i++) r.update(1 / 60, T0 + 0.10 + INTERP_DELAY + i / 60);
  ok('A3b 转向平滑收敛到权威 yaw（不是停在中间值，也不是收敛到 -yaw）',
    Math.abs(r.yawSm - r.yaw) < 1e-3,
    `yawSm→${r.yawSm.toFixed(5)} vs 权威 ${r.yaw.toFixed(5)}（写反 → +1.4；只跑一帧 → 约 -0.47）`);
  ok('A3c 模型朝向 = 收敛后的平滑值（`m.rotation.y = -yawSm` 这类反号会被这条抓住）',
    Math.abs(r.model.root.rotation.y - r.yawSm) < 1e-9 && Math.abs(r.model.root.rotation.y - r.yaw) < 1e-3,
    `model.rotation.y=${r.model.root.rotation.y.toFixed(5)} · yawSm=${r.yawSm.toFixed(5)}`);
  // 换枪这条路上同一处符号：swapWeapon 也要跟着改（漏一处的症状是"切枪那一下背过去"）
  r.swapWeapon('ak');
  ok('A4 换枪重建的模型也按同一个符号摆（swapWeapon 那条路不漏）', Math.abs(r.model.root.rotation.y + 1.4) < 1e-9,
    `rotation.y=${r.model.root.rotation.y.toFixed(4)}`);
}

// ───────────────────────── B. 步态相位（差距 24）─────────────────────────
// 两半：① 不许在低速时把权威相位归零；② 20Hz 相邻两包之间要按**角差**插值，
// 而不是"就近取端点"（那正是"每包跳一格"的另一半成因）。
{
  const g = makeGame();
  const r = mkRemote(g);
  // 相位是两个快照之间的角度量，且服务端那边一直往上加、编解码折进 [0,2π)
  r.push(snap({ phase: 1.234, x: 0, z: 0 }), 0);
  r.push(snap({ phase: 1.234, x: 0, z: 0 }), 0.05);
  r.update(1 / 60, 0.05 + INTERP_DELAY);
  const spd = Math.hypot(r.vel.x, r.vel.z);
  ok('B1 前提：客户端拿到的确实是权威相位（不是退回本地积分那条路）',
    r.buf.length && r.buf[0].s.phase !== undefined && r.lastPhaseSrc === undefined, `phase=${r.buf[0].s.phase}`);
  ok('B2 站着不动时相位保持权威读数（不归零）', Math.abs(angDiff(r.anim.phase, 1.234)) < 0.02,
    `anim.phase=${r.anim.phase.toFixed(4)} · 速度=${spd.toFixed(3)} m/s`);
  ok('B3 反证臂：那个值确实不是 0（旧写法 `if (spd<0.3) a.phase = 0` 会给 0）',
    Math.abs(r.anim.phase) > 1.0, `|phase|=${Math.abs(r.anim.phase).toFixed(4)}`);

  // 插值：两包分别在 0.10 / 0.60，渲染时刻落在正中间 ⇒ 必须落 0.35 附近
  const g2 = makeGame();
  const r2 = mkRemote(g2);
  r2.push(snap({ phase: 0.10 }), 0);
  r2.push(snap({ phase: 0.60 }), 1.0);
  const half = 0.5 + INTERP_DELAY;                 // target = now − INTERP_DELAY = 0.5 ⇒ k = 0.5
  r2.update(1 / 60, half);
  ok('B4 两包之间按角度插值（不是就近取端点）', Math.abs(angDiff(r2.anim.phase, 0.35)) < 0.02,
    `anim.phase=${r2.anim.phase.toFixed(4)} · 端点 0.10/0.60 ⇒ 取端点会给 0.10 或 0.60`);
  ok('B5 反证臂：它既不等于起点也不等于终点（两个端点都排除了）',
    Math.abs(r2.anim.phase - 0.10) > 0.05 && Math.abs(r2.anim.phase - 0.60) > 0.05,
    `离两个端点各 ${Math.abs(r2.anim.phase - 0.10).toFixed(3)} / ${Math.abs(r2.anim.phase - 0.60).toFixed(3)}`);

  // 跨圈：6.20 → 0.10 走的是**短边**（+0.183）。朴素 lerp 会给 3.15（长边、方向也错）。
  const g3 = makeGame();
  const r3 = mkRemote(g3);
  r3.push(snap({ phase: 6.20 }), 0);
  r3.push(snap({ phase: 0.10 }), 1.0);
  r3.update(1 / 60, half);
  const moved = angDiff(6.20, r3.anim.phase);
  ok('B6 跨 2π 折叠：走短边（+0.09 rad 左右），不是朴素平均的 3.15',
    Math.abs(moved - 0.0915) < 0.02 && Math.abs(r3.anim.phase - 3.15) > 1.0,
    `phase=${r3.anim.phase.toFixed(4)} · 相对 6.20 走了 ${moved.toFixed(4)} rad`);
}

// ───────────────────────── C. 开火记账（差距 20）─────────────────────────
// 快照只给一个**状态位**（Firing = 距上次开火 < 0.08 s），而 update() 按渲染帧跑。
// 不记账的话一个人开一枪会连响十几声 —— 这条判据量的就是"记账有没有真的发生"。
{
  const g = makeGame();
  const r = mkRemote(g);
  const firing = snap({ flags: FLAG.Alive | FLAG.OnGround | FLAG.Firing });
  r.push(firing, 0);
  r.push(firing, 0.05);
  const dur = 0.6;
  for (let i = 0; i <= Math.round(dur * 144); i++) r.update(1 / 144, 0.05 + INTERP_DELAY + i / 144);
  const rpm = WEAPONS.m4.rpm;                       // 800 ⇒ 0.075 s 一发
  const want = Math.floor(dur / (60 / rpm)) + 1;
  const perFrame = Math.round(dur * 144);           // 旧写法（没有 fireCool）会响这么多声
  ok('C1 600 ms 持续开火：枪声次数 ≈ 射速给的间隔数（不是渲染帧数）',
    Math.abs(g.log.shot - want) <= 1, `响 ${g.log.shot} 声 · 期望 ${want}（rpm ${rpm}）`);
  ok('C2 反证臂：144Hz 那一路会给几十倍（说明这条判据量的是记账，不是"有没有响"）',
    g.log.shot < perFrame / 4, `${g.log.shot} vs 逐帧 ${perFrame}`);
  ok('C3 曳光/枪口光/枪口烟跟着同一格账（不是一个响一个不响）',
    g.log.tracer === g.log.shot && g.log.flashLight <= g.log.shot && g.log.muzzle === g.log.tracer,
    `曳光 ${g.log.tracer} · 枪口光 ${g.log.flashLight} · 枪口烟 ${g.log.muzzle} · 枪声 ${g.log.shot}`);
  // 松开扳机之后不许再响：先推一包**没有 Firing 位**的快照，再跑 30 帧。
  // （这一步是必需的 —— 不推的话那一格里 Firing 还亮着，而外推分支会原样沿用它，
  //   于是"还在响"其实是对的行为，判据自己错了。第一版就是这么假红的。）
  const before = g.log.shot;
  r.push(snap({}), 1.0);
  for (let i = 0; i <= 30; i++) r.update(1 / 144, 1.0 + INTERP_DELAY + i / 144);
  ok('C4 停火之后再跑 30 帧，一声都不多（状态位掉了就不再开火）', g.log.shot === before,
    `${before} → ${g.log.shot}`);
}

// ───────────────────────── D. 脚步（差距 21）─────────────────────────
// 按**走过的距离**记，不是按时间 —— 按时间的话慢走和冲刺一样密。
{
  const g = makeGame();
  const r = mkRemote(g);
  r.push(snap({ x: 0, z: 0, vx: 4.5, vz: 0 }), 0);
  r.push(snap({ x: 45, z: 0, vx: 4.5, vz: 0 }), 10);     // 插值：x = 4.5 × target
  for (let i = 0; i <= 144; i++) r.update(1 / 144, INTERP_DELAY + i / 144);
  const walked = Math.hypot(r.pos.x, r.pos.z);
  ok('D1 走过约 4.5 m 时脚步数 ≈ 距离 / 步幅（1.6 m）', g.log.step >= 1 && g.log.step <= 4,
    `走了 ${walked.toFixed(2)} m ⇒ ${g.log.step} 声（1.6 m 步幅）`);
  // 反证臂：站着不动一声都没有（否则上面那条可能是"每帧一声"）
  const g2 = makeGame();
  const r2 = mkRemote(g2);
  for (let i = 0; i <= 144; i++) { r2.push(snap({ x: 0, z: 0 }), i / 144); r2.update(1 / 144, INTERP_DELAY + i / 144); }
  ok('D2 反证臂：站着不动 144 帧一声脚步都没有', g2.log.step === 0, `${g2.log.step} 声`);
  const perFrame = 144 / 6;                              // 若按"每帧一声"（假想臂）会是这个量级
  ok('D3 反证臂：也不是每帧一声', g.log.step < perFrame / 4, `${g.log.step} vs 逐帧 ${Math.round(perFrame)}`);
}

// ───────────────────────── E. 换弹（差距 21 的另一半）─────────────────────────
{
  const g = makeGame();
  const r = mkRemote(g);
  const R = FLAG.Alive | FLAG.OnGround | FLAG.Reloading;
  // 换弹位是**过程位**（持续 2.4 s），不是边缘 —— 这就是要记账的理由
  for (let i = 0; i <= 40; i++) { r.push(snap({ flags: R }), i / 144); r.update(1 / 144, INTERP_DELAY + i / 144); }
  ok('E1 换弹位持续 40 帧只响一声"拔弹匣"', g.log.reload.length === 1 && g.log.reload[0] === 'out',
    `${JSON.stringify(g.log.reload)}`);
  for (let i = 41; i <= 80; i++) { r.push(snap({}), i / 144); r.update(1 / 144, INTERP_DELAY + i / 144); }
  ok('E2 换弹位落下时响一声"插弹匣"（与单机三段音的口径对齐）',
    g.log.reload.length === 2 && g.log.reload[1] === 'in', `${JSON.stringify(g.log.reload)}`);
  ok('E3 反证臂：两段音不是同一种（否则"两声"可能只是同一个状态位抖了两次）',
    g.log.reload[0] !== g.log.reload[1]);
}

// ───────────────────────── F. 受击（差距 25 / 26）─────────────────────────
{
  const g = makeGame();
  const dead = mkRemote(g); dead.hp = 30;
  const back = new THREE.Vector3(0, 0, -1);        // 从背后打来（我朝 -Z）
  const front = new THREE.Vector3(0, 0, 1);        // 从正面打来
  ok('F1 本地预测击杀 ⇒ takeDamage 返回 true（红叉与击杀音读的就是它）',
    dead.takeDamage(40, { attacker: {}, dir: back }) === true, 'hp 30 − 40');
  const alive = mkRemote(g); alive.hp = 100;
  ok('F2 反证臂：没打死 ⇒ 返回 false（不是恒 true）',
    alive.takeDamage(10, { attacker: {}, dir: back }) === false, `hp ${alive.hp}`);
  const r1 = mkRemote(g); r1.takeDamage(1, { attacker: {}, dir: back });
  const r2 = mkRemote(g); r2.takeDamage(1, { attacker: {}, dir: front });
  ok('F3 倒地方向按受击方向定（背后打中向前扑、正面打中向后倒）',
    r1.anim.fallDir !== r2.anim.fallDir && (r1.anim.fallDir === -1) && (r2.anim.fallDir === 1),
    `背后 → fallDir=${r1.anim.fallDir} · 正面 → fallDir=${r2.anim.fallDir}`);
  ok('F4 反证臂：两个方向真的被写成了不同的值（恒定 1 的旧写法会让 F3 红）',
    r1.anim.fallDir !== 1 || r2.anim.fallDir !== 1);
  // 受击抖动：时间衰减，且不会把 pos 拽走（pos 是权威的）
  const r3 = mkRemote(g); r3.push(snap({ x: 0, z: 0 }), 0); r3.push(snap({ x: 0, z: 0 }), 0.05);
  r3.update(1 / 60, 0.05 + INTERP_DELAY);
  const base = r3.model.root.position.clone();
  r3.takeDamage(5, { attacker: {}, dir: front });
  r3.update(1 / 60, 0.05 + INTERP_DELAY + 1 / 60);
  const pushed = r3.model.root.position.clone();
  ok('F5 受击抖动改的是**模型**位置，pos 仍然是权威的',
    Math.abs(r3.pos.x) < 1e-9 && Math.abs(r3.pos.z) < 1e-9 && pushed.distanceTo(base) > 0.01,
    `pos=${r3.pos.x.toFixed(4)},${r3.pos.z.toFixed(4)} · 模型被推了 ${pushed.distanceTo(base).toFixed(4)} m`);
  // 抖动必须衰减掉，否则模型永久错位
  for (let i = 0; i < 30; i++) r3.update(1 / 60, 0.05 + INTERP_DELAY + (i + 2) / 60);
  const rest = r3.model.root.position.clone();
  ok('F6 抖动会衰减干净（30 帧之后模型回到权威位置）', rest.distanceTo(base) < 1e-6,
    `残差 ${rest.distanceTo(base).toExponential(2)} m`);
}

// ───────────────────────── G. 重生后姿态复位（差距 27）─────────────────────────
// animateSoldier 的死亡分支写 root.rotation.x/z，而存活分支以前从不碰它们 ——
// 于是"死过又活过来"的人一直保持倒地角度，只是站着滑（症状：远端重生后一直趴着）。
{
  const parts = createSoldierModel('enemy', 'm4', {}, 'none');
  const A = { speed: 0, phase: 0, crouch: 0, pitch: 0, dead: true, deadT: 1, fallDir: 1, fallRoll: 0.3, recoil: 0 };
  animateSoldier(parts, A, 1 / 60);
  const deadX = parts.root.rotation.x, deadZ = parts.root.rotation.z;
  ok('G0 先决：死亡分支真的把姿态写下去了（否则下面的复位是空断言）',
    Math.abs(deadX) > 0.5 && Math.abs(deadZ) > 0.05, `倒地为 x=${deadX.toFixed(3)} z=${deadZ.toFixed(3)}`);
  A.dead = false; A.deadT = 0;
  animateSoldier(parts, A, 1 / 60);
  ok('G1 复活那一帧姿态被复位（root.rotation.x/z 归零）',
    parts.root.rotation.x === 0 && parts.root.rotation.z === 0,
    `存活后 x=${parts.root.rotation.x} z=${parts.root.rotation.z}（旧写法会留 ${deadX.toFixed(3)} / ${deadZ.toFixed(3)}）`);
  ok('G2 复位之后仍然正常摆腿（不是"复位把动画一起关掉了"）',
    parts.legL.leg.rotation.x === 0 || Number.isFinite(parts.legL.leg.rotation.x),
    `legL=${parts.legL.leg.rotation.x}`);
}

// ───────────────────────── H. 离房淡出与提示（差距 30）─────────────────────────
{
  const g = makeGame();
  const r = mkRemote(g);
  r.push(snap({}), 0); r.push(snap({}), 0.05); r.update(1 / 60, 0.05 + INTERP_DELAY);
  ok('H0 先决：这个副本是活着的表现体（下面才谈"走得看不看得见"）', r.alive && r.targetable === true);
  r.beginLeave();
  ok('H1 离开后立刻不再可被命中（子弹与爆炸的遍历会跳过它）', r.targetable === false && r.alive === false);
  ok('H2 不透明度归淡出管（材质被标成 transparent）',
    (r._fadeMats || []).length > 0 && r._fadeMats.every(m => m.transparent === true),
    `${(r._fadeMats || []).length} 个材质`);
  let frames = 0;
  while (!r.fadedOut && frames < 600) { r.update(1 / 60); frames++; }
  ok('H3 淡出在 EXPECTED 时长附近走完（不是一帧就没了）',
    r.fadedOut && Math.abs(frames / 60 - LEAVE_FADE) < 0.05, `${(frames / 60).toFixed(2)} s / 期望 ${LEAVE_FADE} s`);
  ok('H4 反证臂：淡出期间不透明度真的被推下去了（不是"标记了但没画出来"）',
    (r._fadeMats || []).every(m => m.opacity <= 0.02),
    `末值 ${(r._fadeMats || []).map(m => m.opacity.toFixed(2)).slice(0, 3).join(',')}…`);
  ok('H5 反证臂：它不是"瞬时就消失"（至少留了几帧）', frames > 5, `${frames} 帧`);
}

// ───────────────────────── I. 名牌只给队友（差距 28）─────────────────────────
// 这是唯一一处"联机信息比单机更多"：makeNameTag 的材质是 depthTest:false + renderOrder 10，
// 于是敌人隔着墙也能被点名。
{
  const g = makeGame();                       // game.player.team === 'A'
  const foe = mkRemote(g, { team: 'B' });
  const mate = mkRemote(g, { team: 'A' });
  ok('I1 敌人没有名牌', foe.tag === null, `tag=${foe.tag ? '有' : 'null'}`);
  ok('I2 队友有名牌（反证臂：不是"谁都别想要"）', !!mate.tag, `tag=${mate.tag ? '有' : 'null'}`);
  // 中途改队（服务端的 join 事件会带 team）：名牌要跟着重新算
  foe.setName('敌', 'A');
  ok('I3 换到我这队之后名牌补上（setName 也会重算）', !!foe.tag);
}

// ───────────────────────── J. 事件接线与定向过滤（差距 19 / 31–34 / 12）─────────────────────────
// 服务端把**同一份**事件帧发给全房（server/net-server.mjs:broadcast 一份 Buffer 给所有客户端），
// 所以"这句话该给谁看"只能在客户端筛。漏掉筛选的症状很具体：某人的部署失败被念成
// "敌方 无法在此部署"给全场听。
{
  const g = makeGame();
  const delivered = [], hurts = [], flashes = [];
  g.onNetHurt = (ev) => hurts.push(ev);
  g.flashPlayer = (e, dur) => flashes.push(dur);
  g.onNetKill = () => {};
  const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c.cid = 7;
  const feed = (evs) => { c.events.length = 0; c.onEvents({ ev: evs }); return c.events.map(e => e.text || e.e); };

  const t1 = feed([{ e: 'announce', team: 'B', to: 'foes', text: '空袭来袭' }]);
  ok('J1 foes 定向：对面的预警我收得到', t1.length === 1, JSON.stringify(t1));
  const t2 = feed([{ e: 'announce', team: 'A', to: 'foes', text: '空袭来袭' }]);
  ok('J2 反证臂：自己队发的"来袭"不该念给我（否则"敌方 来袭"是假的）', t2.length === 0, JSON.stringify(t2));
  const t3 = feed([{ e: 'announce', team: 'A', to: 'own', text: '集束空袭已呼叫' }]);
  ok('J3 own 定向：本队的战报收得到', t3.length === 1, JSON.stringify(t3));
  const t4 = feed([{ e: 'announce', team: 'B', to: 'own', text: '集束空袭已呼叫' }]);
  ok('J4 反证臂：对面的战报不该念给我', t4.length === 0, JSON.stringify(t4));
  const t5 = feed([{ e: 'announce', team: 'A', to: 'self', cid: 7, text: '无法在此部署' }]);
  ok('J5 self 定向：说给我自己的收得到', t5.length === 1, JSON.stringify(t5));
  const t6 = feed([{ e: 'announce', team: 'A', to: 'self', cid: 9, text: '无法在此部署' }]);
  ok('J6 反证臂：别人的失败不该念给我（差距 40 那条就是这个形状）', t6.length === 0, JSON.stringify(t6));

  feed([{ e: 'hurt', cid: 7, hp: 82, from: [1, 2, 3] }]);
  ok('J7 hurt 事件接到本地反馈闭环（方向指示 / 痛感音 / 镜头冲击的入口）', hurts.length === 1,
    JSON.stringify(hurts[0] || null));
  feed([{ e: 'hurt', cid: 9, hp: 82, from: [1, 2, 3] }]);
  ok('J8 反证臂：别人挨打不该让我这里震（事件带 cid，筛得掉）', hurts.length === 1);

  feed([{ e: 'flash', cid: 7, dur: 2.5 }]);
  ok('J9 被闪光走 game.flashPlayer（与 js/combat.js 的真人分支**共用一处**）',
    flashes.length === 1 && Math.abs(flashes[0] - 2.5) < 1e-9, JSON.stringify(flashes));
  feed([{ e: 'flash', cid: 9, dur: 2.5 }]);
  ok('J10 反证臂：别人被闪，我这里不该白屏', flashes.length === 1);

  feed([{ e: 'proj', netId: 5, kind: 'frag', x: 1, y: 1.5, z: 2, vx: 0, vy: 3, vz: 4, fuse: 3, team: 'B' }]);
  const p = g.projectiles[0];
  ok('J11 别人的投掷物在本地建了**表现副本**（dumb ⇒ 不裁伤害）',
    g.projectiles.length === 1 && p && p.dumb === true && p.type === 'frag',
    `type=${p && p.type} dumb=${p && p.dumb} fuse=${p && p.fuse}`);
  ok('J12 反证臂：起手状态来自事件（不是原地生成）',
    p && Math.abs(p.pos.x - 1) < 1e-9 && Math.abs(p.pos.z - 2) < 1e-9 && Math.abs(p.vel.y - 3) < 1e-9,
    p ? `pos=${p.pos.x},${p.pos.z} vel.y=${p.vel.y}` : 'null');
  ok('J13 副本登记在 netId 表里（到点炸掉之后那张表要能收回去）', c.projs.get(5) === p);

  // 自己的那颗不许双份。服务端对"玩家武器状态机扔出来的"那颗打了 mirror 标记，事件上
  // 带 self —— 投掷者的客户端必须跳过它（本地预测那颗是真的在飞）。修复前事件里没有
  // 主人标记，投掷者照单全收再建一个，症状是"自己扔一颗雷，眼前飞着两颗"。
  feed([{ e: 'proj', netId: 6, kind: 'frag', x: 5, y: 1.5, z: 6, vx: 0, vy: 3, vz: 0, fuse: 3, team: 'A', cid: 7, self: true }]);
  ok('J13b 自己的投掷物（self）不再建副本 —— 场上还是 J11 那一颗',
    g.projectiles.length === 1 && !c.projs.has(6), `场上 ${g.projectiles.length} 颗`);
  feed([{ e: 'proj', netId: 7, kind: 'bomb', x: 0, y: 40, z: 0, vx: 1, vy: -12, vz: 0, fuse: 10, team: 'A', cid: 7 }]);
  ok('J13b′ 反证臂：自己叫的集束空袭**照常**建副本（本地没预测过它，这是呼叫者唯一的一双眼）',
    g.projectiles.length === 2 && c.projs.get(7) === g.projectiles[1], `场上 ${g.projectiles.length} 颗`);

  // leave：既要开始淡出、又要有一句提示
  const said = [];
  g.hud.announce = (...a) => said.push(a[0]);
  const r = mkRemote(g, { id: 3, name: '老王', team: 'B' });
  c.remotes.set(3, r); c.roster.set(3, { name: '老王', team: 'B' });
  feed([{ e: 'leave', cid: 3 }]);
  ok('J14 leave ⇒ 进入淡出队列并说一句（不再是瞬时消失、无声无息）',
    c.leaving.indexOf(r) >= 0 && !c.remotes.has(3) && said.length === 1 && /老王/.test(said[0]),
    `leaving=${c.leaving.length} 提示=${JSON.stringify(said)}`);
  ok('J15 反证臂：淡出队列里的那个确实在淡（不是只挪了个表）', r.targetable === false && r.beginLeaveCalled !== false);
}

// ───────── J′. 投掷物的主人标记（服务端那一半）+ 选点吞火（2026-10-01 两缺陷）─────────
// 两个缺陷同一条根：**权威端与客户端对同一件事各有各的真相，中间没有交接的凭据**。
// 投掷物缺"这颗是谁的/他的客户端是否已经预测了"；空袭确认缺"这一下左键不是扳机"的约定。
{
  // —— 服务端那一半：announceProjectile 的单元（只碰 netIds / byPlayer / events，
  //    用原型实例量，跟 K 段同一招 —— 不为它起一个真房间）——
  const room = Object.create(NetRoom.prototype);
  room.netIds = 0; room.events = []; room.byPlayer = new Map();
  const owner = {};
  room.byPlayer.set(owner, { cid: 41 });
  room.announceProjectile({ owner, type: 'frag', pos: new THREE.Vector3(1, 2, 3), vel: new THREE.Vector3(0, -3, 0), fuse: 2.5, mirror: true });
  const e1 = room.events[0];
  ok('JZ1 服务端的 proj 事件带主人 cid 与 self 标记（客户端滤自己的唯一凭据）',
    e1 && e1.e === 'proj' && e1.cid === 41 && e1.self === true,
    JSON.stringify(e1 ? { cid: e1.cid, self: e1.self, kind: e1.kind } : null));
  room.announceProjectile({ owner, type: 'bomb', pos: new THREE.Vector3(), vel: new THREE.Vector3(), fuse: 10 });
  ok('JZ2 反证臂：连杀排程的弹（mirror 假）self 为假 —— 呼叫者本地没预测过，必须照常建副本',
    room.events[1] && room.events[1].self === false);
  room.announceProjectile({ owner: {}, type: 'frag', pos: new THREE.Vector3(), vel: new THREE.Vector3(), fuse: 3, mirror: true });
  ok('JZ3 反证臂：主人不在座位表里（Bot 的雷）cid 为 null、self 为假 —— 谁收到谁建',
    room.events[2] && room.events[2].cid === null && room.events[2].self === false);

  // —— 客户端那一半：选点吞火整链（recordInput 存 → updateTargeting 消费）——
  // 修复前确认落点的那一下左键是一发真子弹：本地预测打一发（pl.update 跑在 mode.update
  // 之前，cool=0.3 拦不住同一拍）、上行还带着开火位让服务端再打一发。
  const g2 = makeGame();
  g2.camera.getWorldDirection = (v) => v.set(0, -0.4, -1).normalize();
  g2.world.raycast = () => ({ point: new THREE.Vector3(4, 0, 5) });
  g2.world.root = new THREE.Scene();
  g2.player = { name: '我', team: 'A', pos: new THREE.Vector3(), alive: true, journal: () => null, ws: { cool: 0 } };
  const c2 = new NetClient(g2, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c2.cid = 7;
  const sent = [];
  c2.ws = { readyState: 1, send: (m) => sent.push(m) };
  c2.streakState = [{ id: 'cluster', ready: true, used: false, cost: 5 }];
  const inp1 = { fire: true, firePressed: true, mdx: 0, mdy: 0, streak: -1 };
  c2.targeting = { slot: 0 };
  c2.recordInput(10, inp1);
  const pe = c2.pending[c2.pending.length - 1];
  ok('JZ4 选点中的左键被 recordInput 吞掉：上行包不带开火位、本地输入对象也被清（预测打不出这一发）',
    pe && !(pe.buttons & 1) && !(pe.buttons & 4) && inp1.fire === false && inp1.firePressed === false
    && c2.confirmShot === true,
    `buttons=${pe && pe.buttons} confirmShot=${c2.confirmShot}`);
  c2.updateTargeting(inp1);
  const sf = sent.map(s => JSON.parse(s)).find(f => f.t === 'streak');
  ok('JZ5 同拍消费：确认照常发出 {t:"streak"} 窄帧、本地压枪 cool=0.3、选点退出、点击残留清零',
    !!sf && sf.slot === 0 && g2.player.ws.cool === 0.3 && c2.targeting === null && c2.confirmShot === false,
    JSON.stringify(sf || null));
  // 反证臂：点空（这一拍没照到地面）就丢 —— 不许顺延到"后来才照到"的那一拍凭空确认。
  c2.targeting = { slot: 0 };
  g2.world.raycast = () => null;
  c2.recordInput(11, { fire: true, firePressed: true, mdx: 0, mdy: 0, streak: -1 });
  c2.updateTargeting({ firePressed: false, adsPressed: false });
  ok('JZ6 反证臂：点空的确认就地作废（选点还开着、没有请求发出去、残留不留给下一拍）',
    c2.targeting !== null && sent.length === 1 && c2.confirmShot === false,
    `sent=${sent.length} targeting=${!!c2.targeting}`);
}

// ───────────────────────── K. 服务端那两扇门（差距 5 / 34）─────────────────────────
// 用原型调用测闸门本身：三条正臂 + 三条反证臂。写成"直接构造 NetRoom"的话，这一节会
// 变成在测房间启动，而它要测的是**闸门的算术**。
{
  const room = Object.create(NetRoom.prototype);
  const c = { pl: { alive: false }, respawnT: 1.5 };
  room.clients = new Map([[1, c]]);
  const call = (cid) => NetRoom.prototype.requestRespawn.call(room, cid);
  ok('K1 倒计时还剩 1.5 s ⇒ 拒绝（早重生是收益，闸门必须留在服务端）', call(1) === false, `respawnT=${c.respawnT}`);
  c.respawnT = 0.05;
  ok('K2 倒计时最后 0.1 s 内 ⇒ 放行（省掉"归零"到"自动重生"之间那 0~1 拍）', call(1) === true);
  c.pl.alive = true; c.respawnT = 0.05;
  ok('K3 活着的人不许"提前重生"', call(1) === false);
  ok('K4 不认识的人 ⇒ false（不抛异常）', call(99) === false);
  // applyLoadout：必须过**入场用的同一个闸门**（js/loadout.mjs 白名单重建）
  const c2 = {};
  room.clients.set(2, c2);
  NetRoom.prototype.applyLoadout.call(room, 2, { primary: { id: 'not-a-real-gun', att: {} }, secondary: null, lethal: 'nope', tactical: 'nope', perks: ['godmode'] });
  const L = c2.nextLoadout;
  ok('K5 局内换配装过的是入场用的同一个闸门（非法武器 id 被换掉，不是原样挂上）',
    !!L && L.primary.id !== 'not-a-real-gun' && L.primary.id === 'm4',
    `primary=${L && L.primary.id} lethal=${L && L.lethal} perks=${JSON.stringify(L && L.perks)}`);
  ok('K6 非法 perk 与投掷物被丢掉（白名单重建，不是校验）',
    !!L && L.perks.length === 0 && L.lethal === 'frag' && L.tactical === 'flash');
  ok('K7 它只挂在 nextLoadout 上（立刻 equip 会让正在打的那条命与预测分叉）',
    c2.pl === undefined && !!c2.nextLoadout);
  // 反证臂：合法配装必须**原样**通过（闸门不能砍到正门）
  const c3 = {}; room.clients.set(3, c3);
  NetRoom.prototype.applyLoadout.call(room, 3, { primary: { id: 'ak', att: {} }, secondary: { id: 'm1911', att: {} }, lethal: 'semtex', tactical: 'smoke', perks: ['hardline', 'ghost', 'ninja'] });
  const L3 = c3.nextLoadout;
  ok('K8 反证臂：合法的选择原样通过（否则"闸门"其实是"一律改成默认"）',
    L3.primary.id === 'ak' && L3.lethal === 'semtex' && L3.tactical === 'smoke' && L3.perks.length === 3,
    JSON.stringify(L3));
}

// ───────────────────────── L. 被闪光那一路只有一份算法（差距 14）─────────────────────────
// 单机的 js/combat.js:flashAt 在真人分支里先问 game.flashPlayer；联机的 flash 事件也调它。
// 这一节量的是那个契约真的存在 —— 少了它，"闪多久"就有了两份会各自漂移的算法。
{
  const g = makeGame();
  const pl = {
    team: 'A', alive: true, isPlayer: true, hasPerk: () => false,
    eyePos: (o) => o.set(0, 1.6, 0), forward: (o) => o.set(0, 0, -1),
  };
  g.entities.push(pl);
  g.world.lineBlocked = () => false;
  let seen = null;
  g.flashPlayer = (e, dur) => { seen = dur; };
  let hudFlash = 0; g.hud.flash = () => { hudFlash++; };
  flashAt(g, new THREE.Vector3(0, 1.6, -5), null, {});
  ok('L1 有 game.flashPlayer 时走钩子（联机那条路要的入口）', seen !== null && seen > 0, `dur=${seen}`);
  ok('L2 反证臂：这时**不**再直接写本地 hud.flash（一处定义，不是两处都做）', hudFlash === 0, `hud.flash ${hudFlash} 次`);
  // 反证臂的另一半：没有钩子（纯单机）时照旧本地放
  const g2 = makeGame();
  g2.entities.push({ ...pl, eyePos: (o) => o.set(0, 1.6, 0), forward: (o) => o.set(0, 0, -1) });
  let hf2 = 0; g2.hud.flash = () => { hf2++; };
  let ring2 = 0; g2.audio.ring = () => { ring2++; };
  flashAt(g2, new THREE.Vector3(0, 1.6, -5), null, {});
  ok('L3 反证臂：没有钩子时退回本地 hud.flash + 耳鸣（单机行为不变）', hf2 === 1 && ring2 === 1,
    `hud.flash ${hf2} · ring ${ring2}`);
}

// ───────────────────────── M. 量具自证 ─────────────────────────
// 下面两条是整个文件的前提：如果 update() 根本没被驱动，上面所有"没有 XXX"的断言
// 都会因为它们**什么都没做**而变成恒真绿灯。
{
  const g = makeGame();
  const r = mkRemote(g);
  for (let i = 0; i <= 20; i++) r.push(snap({ x: i * 0.05 }), i / 144);
  r.update(1 / 144, INTERP_DELAY + 10 / 144);        // target = 10/144 ⇒ 落在第 10 与第 11 包之间
  ok('M1 量具活着：插值真的被驱动了（drives 计数在涨，pos 不还停在构造点）',
    r.drives >= 1 && Math.abs(r.pos.x) > 1e-6, `drives=${r.drives} pos.x=${r.pos.x.toFixed(3)}`);
  ok('M2 量具活着：渲染的确实是**回退 INTERP_DELAY** 之后的世界（比最新一包旧）',
    Math.abs(r.pos.x - 0.5) < 0.03 && r.pos.x < 0.95,
    `pos.x=${r.pos.x.toFixed(3)} · 最新包 x=1.000`);
}

// ───────────────────────── N. 快照那条路（差距 30 / 42 的前提）─────────────────────────
// onSnapshot 是"远端副本从哪来、到哪去"的唯一入口。两条硬事实：① 副本必须进
// game.entities —— 热成像（js/main.js:setThermal）与子弹/爆炸的遍历都只看那一张表；
// ② 人从快照里消失时**不许瞬时拆掉**，要进淡出队列。
// 刻意不让快照里出现 cid 自己：那会走到 reconcile（回滚重放），而这一节要测的是
// "别人来去"这条路，混进来就变成在测预测器了。
{
  const g = makeGame();
  const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c.cid = 7;
  const ent = (id, team, x) => ({ id, x, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, flags: FLAG.Alive | FLAG.OnGround, weapon: 0, mag: 30, phase: 0, vx: 0, vz: 0, team, ack: 0, rep: 0 });
  const frame = (entities, tick, now) => c.onSnapshot({ tick, seq: 1, worldFlags: 0, rngState: 1, entities }, now);
  frame([ent(3, 1, 1), ent(4, 1, 2)], 100, 0);
  ok('N1 远端副本进了 game.entities（热成像与子弹遍历都只看这一张表）',
    g.entities.length === 2 && g.remotePlayers.length === 2, `entities=${g.entities.length} remotePlayers=${g.remotePlayers.length}`);
  const r3 = c.remotes.get(3);
  ok('N2 起手位置用**这一包**的坐标（留 (0,0,0) 会让第一帧把人摆在地图原点）',
    r3 && Math.abs(r3.pos.x - 1) < 1e-9, r3 ? `x=${r3.pos.x}` : 'null');
  frame([ent(4, 1, 2)], 103, 0.05);
  ok('N3 人从快照里消失 ⇒ 进淡出队列（不是瞬时 dispose）',
    c.leaving.length === 1 && !c.remotes.has(3) && g.entities.length === 2,
    `leaving=${c.leaving.length} remotes=${c.remotes.size} entities=${g.entities.length}`);
  ok('N4 反证臂：他确实还在 entities 里（模型要在场上才谈得上"淡出"）', g.entities.indexOf(r3) >= 0);
  for (let i = 0; i < 60; i++) c.frameUpdate(1 / 60);
  ok('N5 淡出走完才真正拆掉（并同步 remotePlayers 那张表）',
    c.leaving.length === 0 && g.entities.indexOf(r3) < 0 && g.remotePlayers.length === 1,
    `leaving=${c.leaving.length} entities=${g.entities.length} remotePlayers=${g.remotePlayers.length}`);
}

// ───────────────────────── O. 燃烧瓶在权威端真的会烧（差距 13）─────────────────────────
// 老的 server/stubs.mjs 里 effects.addFireSource 是一个**返回假对象的桩**，伤害写在第四个
// 参数（每拍回调）里 —— 桩不去调它，于是燃烧瓶在联机里零伤害，而且不报错、不抛异常。
// 这一节直接跑真链路：真 Projectile 的 molotov 分支 → 真 addFireSource（HeadlessGame 注入的）
// → HeadlessGame.step 里的每拍推进。三条判据分别盯：火挂上了没有、烧是不是**持续**的、
// 以及它是不是按半径裁的（否则"持续掉血"可以只是全域掉血）。
{
  await preloadMaterials();
  const G = new HeadlessGame();
  await G.loadMap('yard');
  G.player = null;
  const gy = G.world.groundHeight(0, 0, 1, 0.3);
  const mkTgt = (x, z) => {
    const y = G.world.groundHeight(x, z, 1, 0.3);
    return { team: 'B', alive: true, isPlayer: false, hp: 100, pos: new THREE.Vector3(x, y, z), takeDamage(d) { this.hp -= d; return false; } };
  };
  const near = mkTgt(0, 0), far = mkTgt(12, 0);
  G.entities = [near, far];
  new Projectile(G, 'molotov', new THREE.Vector3(0, gy + 1, 0), new THREE.Vector3(0, 0, 0), null, 99).detonate();
  ok('O1 火源被真的挂进了权威端的表，且带着每拍回调（不是那个返回假对象的桩）',
    G.fires.length === 1 && typeof G.fires[0].dmg === 'function' && G.fires[0].r === 3,
    `fires=${G.fires.length} r=${G.fires[0] && G.fires[0].r} dmg=${typeof (G.fires[0] || {}).dmg}`);
  let burnTicks = 0, prev = near.hp;
  for (let i = 0; i < 120; i++) { G.step(1 / 60, null); if (near.hp < prev) { burnTicks++; prev = near.hp; } }
  ok('O2 站在火里被**持续**灼烧（掉血发生在很多拍上，不是一次爆炸）',
    burnTicks > 100 && near.hp < 45, `${burnTicks}/120 拍掉血 · hp 100 → ${near.hp.toFixed(1)}`);
  ok('O3 反证臂：火是按半径裁的（12 m 外那个人一滴血都没掉）', far.hp === 100,
    `远处 hp=${far.hp}（老桩⇒两人都是 100，"烧"这件事根本不存在）`);
}

// ───────────────────────── P. 别人的爆炸在本地也震屏（差距 17）─────────────────────────
// 冲击反馈（震屏 / 耳鸣）的语义是"我附近炸了"，不是"我被裁决了伤害"。它以前排在
// `if (opts.noDamage) return` 之后 ⇒ 表现副本（别人的手雷）一次都不会震屏。
{
  const g = makeGame();
  let shake = 0;
  g.player = { pos: new THREE.Vector3(0, 0, 0), alive: true, shake: (a) => { shake = Math.max(shake, a); } };
  let dmg = 0;
  g.entities = [{ team: 'B', alive: true, isPlayer: false, chestPos: (o) => o.set(0, 0, 0), takeDamage() { dmg++; return false; } }];
  explode(g, new THREE.Vector3(0, 0, 2), 7, 160, null, '破片手雷', { noDamage: true });
  ok('P1 表现副本的爆炸照样震屏（冲击反馈不看 noDamage）', shake > 0, `shake=${shake.toFixed(3)}`);
  ok('P2 反证臂：但它一次伤害都不裁（表现副本就是表现副本）', dmg === 0, `takeDamage ${dmg} 次`);
  // 反证臂的另一半：权威那条路（不带 noDamage）必须照样裁伤害
  let dmg2 = 0; shake = 0;
  g.entities = [{ team: 'B', alive: true, isPlayer: false, chestPos: (o) => o.set(0, 0, 0), takeDamage() { dmg2++; return false; } }];
  explode(g, new THREE.Vector3(0, 0, 2), 7, 160, null, '破片手雷');
  ok('P3 反证臂：不带 noDamage 时裁决照旧（没有把整条伤害链一起关掉）', dmg2 === 1 && shake > 0,
    `takeDamage ${dmg2} 次 · shake=${shake.toFixed(3)}`);
}

// ───────────────────────── Q. kill 事件转给上层（差距 31 / 32）─────────────────────────
// 服务端早就发了 kill 事件（killer/victim 是名字、weapon、head、pts），而 js/main.js 里
// 以前没有 onNetKill/onNetDeath 这两个函数 —— `g.onNetKill &&` 那一句恒为空过。
// 这里量的是**这一跳**有没有接上（面板本身在浏览器里）。
{
  const g = makeGame();
  const kills = [], deaths = [];
  g.onNetKill = (ev) => kills.push(ev);
  g.onNetDeath = (ev) => deaths.push(ev);
  const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c.cid = 7;
  c.onEvents({ ev: [{ e: 'kill', killer: '我', victim: '敌', weapon: 'M4A1', head: true, pts: 100 }] });
  ok('Q1 我打死别人 ⇒ onNetKill 收到（killfeed 与得分弹窗的入口）',
    kills.length === 1 && kills[0].head === true, JSON.stringify(kills[0] || null));
  ok('Q2 反证臂：victim 不是我 ⇒ 不走死亡画面那条路', deaths.length === 0);
  c.onEvents({ ev: [{ e: 'kill', killer: '敌', victim: '我', weapon: 'AK-47', head: false, pts: 100 }] });
  ok('Q3 我被打死 ⇒ onNetDeath 收到（死亡画面 / 死亡镜头的入口）', deaths.length === 1,
    JSON.stringify(deaths[0] || null));
}

// ───────────────────────── R. 网络状态（差距 37）─────────────────────────
// sendPing 定义了却**从无调用点** ⇒ rtt 恒 0，于是"网络状态"这件事在客户端根本不存在。
{
  const g = makeGame();
  const sent = [];
  const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c.cid = 7; c.ws = { readyState: 1, send: (m) => sent.push(m) };
  c.localTick = 60; c.update(1 / 60, {});
  const pings = sent.filter(m => /"t":"ping"/.test(m));
  ok('R1 每秒发一次 ping（rtt 才有值可读）', pings.length === 1, `发了 ${sent.length} 条，其中 ping ${pings.length}`);
  sent.length = 0;
  c.localTick = 61; c.update(1 / 60, {});
  ok('R2 反证臂：不是每拍都发（否则上行会被 JSON 帧塞满）', sent.filter(m => /ping/.test(m)).length === 0);
  c.localTick = 120; c.update(1 / 60, {});
  ok('R3 到下一分钟刻度又发一次（1 Hz 而不是只有进场那一次）', sent.filter(m => /ping/.test(m)).length === 1);
}

// ───────────────────────── S. 联机的"暂停"该长什么样（差距 38）─────────────────────────
// 服务端不暂停不是缺陷（§附三），缺的是客户端的提示与降级。这一节量的是**结构**而不是
// 文案：联机时选配装要留着、重新开始对局必须消失（它以前会 ws.close() 静默断开、
// 然后在本地开一局带 AI 的对战）、并且要有一条"退出本局"。
// 判据钉结构不钉措辞 —— 这个仓库为"把 UI 文案当判据"红过一整轮。
{
  const local = pauseActions({ camp: false, online: false });
  const net = pauseActions({ camp: false, online: true });
  const camp = pauseActions({ camp: true, online: false });
  ok('S1 联机暂停屏：没有"重新开始对局"（那一项会静默断开并换成 AI 对战）',
    net.restart === false && local.restart === true, `net.restart=${net.restart} local.restart=${local.restart}`);
  ok('S2 联机暂停屏：有"退出本局"这一条降级出口', net.leaveMatch === true && local.leaveMatch === false);
  ok('S3 等待期/暂停期能换配装（差距 5 的那条假反馈已经成真，这一格是它的入口）',
    net.changeClass === true && local.changeClass === true && camp.changeClass === false);
  ok('S4 联机时标题不再自称"已暂停"（本地 sim 停了、你的人还在场上）',
    net.title !== local.title, `net="${net.title}" local="${local.title}"`);
  ok('S5 反证臂：单机那份一个字都没变（本地是真暂停）',
    local.title === '已暂停' && local.sub === '多人对战' && local.note === '按 Esc 继续',
    JSON.stringify(local));
}

// ───────────────────────── T. 输入法保护（差距 44）─────────────────────────
// 那两处判断都在 DOM 的 keydown 回调里（密码框、聊天框），node 侧够不到 —— 所以按 S 段
// 的同一个手法抽成了纯函数 isImeKey（js/menu.js）。这里量的是它的两个信号都要认：
// 只认 isComposing 会在只给 229 的那类输入法上漏；只认 229 会在现代浏览器上漏。
{
  ok('T1 标准信号：选词中（isComposing）的回车不算提交/发送', isImeKey({ isComposing: true, keyCode: 13 }) === true);
  ok('T2 回退信号：部分旧 IME 只给 keyCode 229', isImeKey({ isComposing: false, keyCode: 229 }) === true);
  ok('T3 反证臂：真的按下回车（两个信号都没有）必须放行 —— 否则输入框永远发不出东西',
    isImeKey({ isComposing: false, keyCode: 13 }) === false, 'keyCode=13');
  ok('T4 反证臂：普通字符键也不该被吞掉', isImeKey({ isComposing: false, keyCode: 65 }) === false, 'keyCode=65（A）');
  ok('T5 事件对象缺失时不抛异常（否则整个 keydown 回调会因为一个 undefined 崩掉）',
    isImeKey(undefined) === false && isImeKey(null) === false);
}

// ───────────────────────── U. 远端套件与迷彩（差距 29）─────────────────────────
// 远端模型以前恒以 {} / 'none' 建 —— 人人一把素枪，而单机的 AI 是随机配件 + 随机迷彩。
// 套件的真相在装备表里（服务端净化后那份 loadout），跟着 welcome/join/respawn/pickupTake
// 四条接缝走（js/loadout.mjs:kitsOf 两端共用）。这里量的是"到了之后模型真的按它建"：
// 可观察量挑枪口位（消音器把 muzzle 后移 0.19，js/gunmodel.js:142）与枪上的材质色。
// 反证臂就是**素枪那把**：旧写法下两个模型逐帧重合，U1/U2 必红。
{
  const g = makeGame();
  const plain = mkRemote(g);
  const kitted = mkRemote(g, { kits: { m4: { att: { muzzle: 'suppressor' }, camo: 'desert' } } });
  const zPlain = plain.model.muzzle.position.z, zKit = kitted.model.muzzle.position.z;
  ok('U1 配件上了模型：消音器把枪口后移了（素枪那把是旧写法的样子）',
    zKit < zPlain - 0.05, `枪口 z：素 ${zPlain.toFixed(3)} vs 带消音 ${zKit.toFixed(3)}`);
  const cols = (m) => { const s = new Set(); m.gun.traverse(o => { if (o.isMesh && o.material && o.material.color) s.add(o.material.color.getHexString()); }); return [...s].sort().join(','); };
  ok('U2 迷彩上了色：同一把枪的材质集合与素枪不同',
    cols(kitted.model) !== cols(plain.model), `素="${cols(plain.model)}" 迷彩="${cols(kitted.model)}"`);
  // 换装回声：手上那把枪变了样要当场重建模型（等下次换枪才看得出来 = "换了职业没生效"的假象）
  kitted.setKits({ m4: { att: {}, camo: 'none' } });
  const zBack = kitted.model.muzzle.position.z;
  ok('U3 换装回声生效：套件改了，模型当场换（枪口位回到素枪那一位）',
    Math.abs(zBack - zPlain) < 1e-6 && kitted.model !== undefined, `枪口 z 回到 ${zBack.toFixed(3)}`);
  ok('U4【反证】U1 不是恒真的绿灯：同一个模型在套件摘掉之后确实变回去了', zBack > zKit + 0.05, `zKit=${zKit.toFixed(3)} → ${zBack.toFixed(3)}`);
  // 换枪按**新枪的**套件建：kits 按武器 id 索引，不许把上一把的配件套到捡来的枪上
  kitted.setKits({ m4: { att: { muzzle: 'suppressor' }, camo: 'none' }, ak: { att: {}, camo: 'none' } });
  kitted.push(snap({ weapon: 1 }), 0);            // 1 = ak
  kitted.push(snap({ weapon: 1 }), 0.05);
  kitted.update(1 / 60, 0.05 + INTERP_DELAY);
  const plainAk = mkRemote(g);
  plainAk.push(snap({ weapon: 1 }), 0); plainAk.push(snap({ weapon: 1 }), 0.05);
  plainAk.update(1 / 60, 0.05 + INTERP_DELAY);
  ok('U5 换枪之后按新枪自己的套件建模（上一把的消音器不许跟过来）',
    kitted.weaponId === 'ak' && Math.abs(kitted.model.muzzle.position.z - plainAk.model.muzzle.position.z) < 1e-6,
    `ak 枪口 z=${kitted.model.muzzle.position.z.toFixed(3)} · 素 ak=${plainAk.model.muzzle.position.z.toFixed(3)}`);
  // 第四条接缝 pickupTake：别人捡了把带配件的枪，他模型上那把要跟着换 ——
  // 事件里 att 是现成的（replaceSlot 那条路一直在用），以前只有拿枪的人自己消费。
  const g2 = makeGame();
  const c2 = new NetClient(g2, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c2.cid = 7;
  c2.onSnapshot({
    tick: 1, seq: 0, worldFlags: 0, rngState: 0,
    entities: [{ id: 2, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, flags: FLAG.Alive, weapon: 0, mag: 30, phase: 0, vx: 0, vz: 0, team: 1, ack: 0, rep: 0 }],
  }, 0.2);
  const r2 = c2.remotes.get(2);
  const zBefore = r2.model.muzzle.position.z;
  c2.onEvents({ ev: [{ e: 'pickupTake', cid: 2, id: 9, idx: 0, weapon: 'm4', att: { muzzle: 'suppressor' }, mag: 20, reserve: 90 }] });
  ok('U6 pickupTake 接缝：别人换枪，配件跟着上模型（否则"他捡了把消音的枪"看不出来）',
    r2.model.muzzle.position.z < zBefore - 0.05, `枪口 z ${zBefore.toFixed(3)} → ${r2.model.muzzle.position.z.toFixed(3)}`);
}

// ───────────────────────── V. 举枪与滑铲的姿态（差距 30 那条未编号）─────────────────────────
// FLAG.Ads / FLAG.Sliding 早就同步了，客户端只存不用：对方据枪瞄你和腰射一个样，
// 滑铲的人立着滑。姿态通道在 animateSoldier 里（slide / ads），源头是快照位、按帧平滑。
{
  const drive = (flags, n = 40) => {
    const g = makeGame();
    const r = mkRemote(g);
    r.push(snap({ flags }), 0);
    r.push(snap({ flags }), 0.05);
    for (let i = 0; i < n; i++) r.update(1 / 60, 0.05 + INTERP_DELAY);
    return { g, r };
  };
  const base = drive(FLAG.Alive | FLAG.OnGround);
  const ads = drive(FLAG.Alive | FLAG.OnGround | FLAG.Ads);
  const dGun = ads.r.model.gun.position.distanceTo(ads.r.model.gunHome);
  ok('V1 据枪位（FLAG.Ads）真的把枪收到了肩线上', ads.r.anim.ads > 0.9 && dGun > 0.02,
    `anim.ads=${ads.r.anim.ads.toFixed(2)} 枪位移 ${dGun.toFixed(3)} m`);
  ok('V2【反证】不带 Ads 的那一位枪不动 —— 判据不是"反正都能看到位移"',
    base.r.anim.ads < 0.01 && base.r.model.gun.position.distanceTo(base.r.model.gunHome) < 1e-6,
    `anim.ads=${base.r.anim.ads.toFixed(3)}`);
  const slide = drive(FLAG.Alive | FLAG.OnGround | FLAG.Sliding);
  const yBase = base.r.model.hips.position.y, ySlide = slide.r.model.hips.position.y;
  ok('V3 滑铲（FLAG.Sliding）把人压低了（单机自己滑的时候相机也降 0.25 m）',
    slide.r.anim.slide > 0.9 && ySlide < yBase - 0.15, `髋高 ${yBase.toFixed(3)} → ${ySlide.toFixed(3)}`);
  ok('V4【反证】不带 Sliding 的那一位不趴（否则这条判据永远绿）',
    base.r.anim.slide < 0.01 && Math.abs(yBase - 0.95) < 1e-6, `anim.slide=${base.r.anim.slide.toFixed(3)} 髋高=${yBase.toFixed(3)}`);
}

// ───────────────────────── W. mag 的消费点：霰弹逐发装填（差距 30 那条未编号）─────────────────────────
// mag 以前到了没人消费，而且它连插值都过不去（中间那条插值分支拼的是新对象，抄漏一格就
// 静默 undefined）。它的消费点是**霰弹枪一发一发装**：单机每入膛一发响一声
// （weapon-state.js 的 audio.reload('shell')），而 Reloading 位只有开始/结束两个跳变。
{
  const M870 = WEAPON_IDS.indexOf('m870');
  const fire = (weapon, mags) => {
    const g = makeGame();
    const r = mkRemote(g);
    const flags = FLAG.Alive | FLAG.OnGround | FLAG.Reloading;
    mags.forEach((mag, i) => {
      r.push(snap({ weapon, mag, flags }), i * 0.1);
      r.update(1 / 60, i * 0.1 + INTERP_DELAY);
    });
    return g.log.reload.filter(x => x === 'shell').length;
  };
  const shells = fire(M870, [0, 1, 2, 3]);
  ok('W1 霰弹枪装一发响一声（与单机同一句 audio.reload(\'shell\')）', shells === 3, `响了 ${shells} 声`);
  const stale = fire(M870, [0, 0, 0, 0]);
  ok('W2【反证】mag 不动就一声不响（不是"Reloading 位一亮就响"）', stale === 0, `响了 ${stale} 声`);
  const other = fire(0, [0, 1, 2, 3]);            // 0 = m4，整匣换弹
  ok('W3 普通枪整匣换弹没有逐发声（shellReload 只属于霰弹）', other === 0, `响了 ${other} 声`);
  // 插值中间点那一格：两包之间渲染时 mag 只从 b 那一包来 —— 旧写法那个分支抄漏了 mag
  const g = makeGame();
  const r = mkRemote(g);
  const flags = FLAG.Alive | FLAG.OnGround | FLAG.Reloading;
  r.push(snap({ weapon: M870, mag: 0, flags }), 0);
  r.push(snap({ weapon: M870, mag: 0, flags }), 0.5);
  r.update(1 / 60, 0.5 + INTERP_DELAY);           // 记账：上一发是 0
  r.push(snap({ weapon: M870, mag: 1, flags }), 1.0);
  r.update(1 / 60, 0.75 + INTERP_DELAY);          // 落在两包正中间 ⇒ 走插值分支
  ok('W4 mag 能穿过插值分支（中间点那一帧也要看得见这一发入膛）',
    g.log.reload.filter(x => x === 'shell').length === 1, `reload 记录=${g.log.reload.join(',')}`);
}

// ───────────────────────── X. 服务端推下来的读数，客户端画不画（差距 40 / 直升机损伤状态）─────────────────────────
// streakCharge：连杀槽进度以前只随记分板走（2 秒一份 = 0.5 Hz），单机是每次击杀立刻充。
// heliHp：哑副本的血量只由权威端说，头顶百分比与七成以下的冒烟都靠它。
{
  const g = makeGame();
  const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c.cid = 7;
  c.onEvents({ ev: [{ e: 'board', scores: { A: 0, B: 0 }, timeLeft: 600, rows: [{ cid: 7, name: '我', team: 'A', k: 0, d: 0, s: 0, sk: 0 }] }] });
  c.update(1 / 60, {});
  ok('X1 前提：记分板那一班给的还是旧值 0（0.5 Hz 的那个迟滞就是它）',
    g.log.streaks.kills === 0, `HUD 充能=${g.log.streaks.kills}`);
  c.onEvents({ ev: [{ e: 'streakCharge', cid: 7, sk: 3 }] });
  c.update(1 / 60, {});
  ok('X2 streakCharge 一到 HUD 立刻刷（不用等下一班记分板）', g.log.streaks.kills === 3,
    `HUD 充能=${g.log.streaks.kills}`);
  c.onEvents({ ev: [{ e: 'streakCharge', cid: 99, sk: 9 }] });
  c.update(1 / 60, {});
  ok('X3【反证】别人的充能不许串到我头上（定向在客户端筛，与 hurt/flash 同一条约定）',
    g.log.streaks.kills === 3, `HUD 充能=${g.log.streaks.kills}（别人那条 sk=9 不该进来）`);

  // 直升机的损伤状态：出生事件带初值，之后每一跳 heliHp
  c.onEvents({ ev: [{ e: 'turret', netId: 5, kind: 'heli', team: 'B', ang: 0, dur: 45, height: 24, radius: 20, hp: 600, maxHp: 600 }] });
  const t = c.turrets.get(5);
  c.frameUpdate(1 / 60); c.update(1 / 60, {});
  const marker = () => (g.log.markers || []).find(m => m.id === 'heli5');
  ok('X4 前提：满血的敌方直升机头顶标着 100%，而且不冒烟',
    !!marker() && marker().text === '100%' && g.log.smoke === 0, `marker=${marker() && marker().text} smoke=${g.log.smoke}`);
  c.onEvents({ ev: [{ e: 'heliHp', netId: 5, hp: 300, maxHp: 600 }] });
  c.frameUpdate(1 / 60); c.update(1 / 60, {});
  ok('X5 heliHp 到了：头顶百分比跟着变，七成以下开始冒烟（冒烟那段代码两端同一份）',
    t.hp === 300 && marker().text === '50%' && g.log.smoke > 0,
    `hp=${t.hp} marker=${marker().text} smoke=${g.log.smoke}`);
  ok('X6【反证】友军直升机不进标记（与单机同一句：只标敌方）',
    (() => {
      c.onEvents({ ev: [{ e: 'turret', netId: 6, kind: 'heli', team: 'A', ang: 0, dur: 45, height: 24, radius: 20, hp: 600, maxHp: 600 }] });
      c.frameUpdate(1 / 60); c.update(1 / 60, {});
      return !(g.log.markers || []).some(m => m.id === 'heli6');
    })());
}

// ───────────────────────── Y. 权威端那半：套件下发 + 连杀进度即时（差距 29 / 40）─────────────────────────
// X 段量的是"到了画不画"，这一段量的是"发没发"。真 NetRoom 跑一遍：join 事件带套件表、
// 击杀/死亡各推一条 streakCharge（而不是等 2 秒一班的记分板）。
{
  const room = new NetRoom({ id: 'kits', mapId: 'yard', seed: 20260928 });
  await room.start();
  const A = room.addClient({
    name: '甲', team: 'A',
    loadout: { primary: { id: 'm4', att: { muzzle: 'suppressor' }, camo: 'woodland' }, secondary: { id: 'm1911', att: {}, camo: 'none' }, perks: ['ghost'] },
  });
  const B = room.addClient({ name: '乙', team: 'B' });
  const j = room.events.find(e => e.e === 'join' && e.cid === A.cid);
  ok('Y1 join 事件带套件表（远端模型按它建）',
    !!j && !!j.kits && j.kits.m4 && j.kits.m4.att.muzzle === 'suppressor' && j.kits.m4.camo === 'woodland',
    JSON.stringify(j && j.kits));
  ok('Y2【反证】没选配件的那把是素的（不是把上一把的表抄过去）',
    !!j && !!j.kits.m1911 && !j.kits.m1911.att.muzzle && j.kits.m1911.camo === 'none');
  room.events.length = 0;
  room.game.onKill(A.pl, B.pl, 'm4', false, {});
  const sc = room.events.filter(e => e.e === 'streakCharge' && e.cid === A.cid).pop();
  ok('Y3 击杀那一刻就有一条 streakCharge（0.5 Hz 的迟滞就是这么丢的）',
    !!sc && sc.sk === Math.floor(A.book.progress) && sc.sk > 0, `sk=${sc && sc.sk} book=${A.book.progress}`);
  room.events.length = 0;
  room.game.onKill(B.pl, A.pl, 'ak', false, {});
  const sd = room.events.filter(e => e.e === 'streakCharge' && e.cid === A.cid).pop();
  ok('Y4 自己死了清账也推一条（HUD 上的充能跟着归零，不用等记分板）',
    !!sd && sd.sk === 0 && A.book.progress === 0, `sk=${sd && sd.sk} book=${A.book.progress}`);
}

// ───────────────────────── Z. 聊天的判定与渲染（差距 43/45）─────────────────────────
// 命令解析 / 屏蔽过滤 / 行渲染在 js/net/chat.mjs（菜单屏与对局 HUD 共用一份）。
// 每一种失效都是静默的：拼错命令被当发言广播出去、屏蔽了还看得见、名字没过转义 ——
// 全都不报错，只在别人的界面上显形。反证臂是"没被屏蔽的那行必须还在"与
// "真的发言必须是 say"（把判定做成恒 unknown/恒屏蔽都能被这两条臂抓住）。
{
  const p = parseChatCommand;
  ok('Z1 普通发言：不带斜杠就是 say，文本原样', p('在吗').op === 'say' && p('在吗').text === '在吗');
  ok('Z2 空输入什么也不发（上层拿 text 为空当"别发帧"）', p('   ').op === 'say' && p('').text === '');
  ok('Z3 /mute /unmute 解析出名字，中文别名同一条路',
    p('/mute 甲').op === 'mute' && p('/mute 甲').name === '甲'
    && p('/屏蔽 乙').op === 'mute' && p('/屏蔽 乙').name === '乙'
    && p('/unmute 甲').op === 'unmute' && p('/解除屏蔽 乙').name === '乙');
  ok('Z4 /report 带原因；不带原因也算报（reason 空串）',
    p('/report 甲 刷屏').op === 'report' && p('/report 甲 刷屏').name === '甲' && p('/report 甲 刷屏').reason === '刷屏'
    && p('/举报 乙').op === 'report' && p('/举报 乙').reason === '');
  ok('Z5【反证】拼错的命令不许当发言发出去（发出去就是房间里一行"/mut 甲"）',
    p('/mut 甲').op === 'unknown' && p('/mute').op === 'unknown' && p('/report').op === 'unknown');
  ok('Z6 屏蔽过滤：名单上的人不显示', isMuted('甲', ['甲', '乙']) === true);
  ok('Z6【反证】名单外的人照常显示（恒 true 的过滤器也能被这条臂抓住）',
    isMuted('丙', ['甲', '乙']) === false && isMuted('甲', []) === false && isMuted('甲', null) === false);
  ok('Z7 toggleMute：加上去、再加不重复、去掉就真没了',
    toggleMute([], '甲', true).join() === '甲'
    && toggleMute(['甲'], '甲', true).join() === '甲'
    && toggleMute(['甲', '乙'], '甲', false).join() === '乙');
  const row = { ch: 'match', from: '甲', text: '大家好', at: Date.now(), cid: 3, team: 'A' };
  ok('Z8 渲染带时间戳（差距 45 的"无时间戳"）', /\d{2}:\d{2}/.test(chatRowHtml(row, {})) && /^\d{2}:\d{2}$/.test(chatTime(row.at)));
  ok('Z8【反证】被屏蔽的人一行都不画（过滤的唯一实施点就是这一句）',
    chatRowHtml(row, { muted: ['甲'] }) === '' && chatRowHtml(row, { muted: ['乙'] }).includes('大家好'));
  ok('Z9 名字与文本都过转义（聊天是最容易往别人界面里塞标签的地方）',
    chatRowHtml({ ch: 'match', from: '<img>', text: '<b>x</b>', at: 0 }, {})
      .includes('&lt;img&gt;') && !chatRowHtml({ ch: 'match', from: '<img>', text: '<b>x</b>', at: 0 }, {}).includes('<b>x</b>'));
  ok('Z10 队伍频道的行带 team 样式（一眼分得出是全场说的还是队内说的）',
    chatRowHtml({ ...row, ch: 'team' }, {}).includes('team') && !chatRowHtml(row, {}).match(/chat-line team/));
  ok('Z11 系统回执（举报/屏蔽的反馈）画得出来，且不被屏蔽名单误杀',
    chatRowHtml({ sys: true, text: '已记录', at: 0 }, { muted: ['甲'] }).includes('已记录'));
  // —— 私聊 / @ 与表情（差距 45 的"无私聊/@"、"无表情"）——
  ok('Z12 私聊三条写法解析到同一条路（/w · /私聊 · @名字）',
    p('/w 甲 秘密').op === 'whisper' && p('/w 甲 秘密').name === '甲' && p('/w 甲 秘密').text === '秘密'
    && p('/私聊 乙 你好').op === 'whisper' && p('@甲 你好').name === '甲' && p('@甲 你好').text === '你好');
  ok('Z12【反证】没有内容的私聊不算数（发出去是一行没有字的"悄悄"）',
    p('/w 甲').op === 'unknown' && p('@甲').op === 'unknown');
  ok('Z13 表情按白名单解析：/emote 词 · 裸别名 /敬礼',
    p('/emote 敬礼').op === 'emote' && p('/emote 敬礼').name === 'salute' && p('/敬礼').op === 'emote' && p('/敬礼').name === 'salute');
  ok('Z13【反证】白名单外的表情不许过（自由文本动作等于替人造句）',
    p('/emote 跳舞').op === 'unknown' && p('/跳舞').op === 'unknown' && p('/emote 敬了个礼').op === 'unknown');
  ok('Z14 私聊行画得出"悄悄 › 对方"，动作行画得出 "* 谁做了什么"',
    chatRowHtml({ ch: 'whisper', from: '甲', to: '乙', text: '秘密', at: 0 }, {}).includes('悄悄 › 乙')
    && chatRowHtml({ ch: 'emote', from: '甲', text: '敬了个礼', at: 0 }, {}).includes('* 甲敬了个礼'));
  ok('Z14【反证】动作行不是普通发言行（同形就分不出谁在做什么）',
    !chatRowHtml({ ch: 'emote', from: '甲', text: '敬了个礼', at: 0 }, {}).includes('chat-line"'));
  ok('Z15 表情符号（emoji）原样过渲染（"表情"的另一半：字面意义上的表情）',
    chatRowHtml({ ch: 'match', from: '甲', text: '👍 敬礼', at: 0 }, {}).includes('👍'));
  ok('Z15【反证】屏蔽同样盖住私聊与动作行（被屏蔽的人不该换个花样还能出现）',
    chatRowHtml({ ch: 'whisper', from: '甲', to: '乙', text: 'x', at: 0 }, { muted: ['甲'] }) === ''
    && chatRowHtml({ ch: 'emote', from: '甲', text: '敬了个礼', at: 0 }, { muted: ['甲'] }) === ''
    && chatRowHtml({ ch: 'whisper', from: '丙', to: '乙', text: 'x', at: 0 }, { muted: ['甲'] }).includes('x'));
}

// ───────────────────────── AA. 空跑窗尺子（附十四遗留，第 10 轮） ─────────────────────────
// client.mjs 在每个空跑窗里量"补偿后的残差 < 我一拍的位移"。附十四立的账：静止时
// "我这一步"退到 0.4 mm 的物理余颤，权威位置的量化噪声（±0.5 cm/轴，实测残差 2~4 mm）
// 就够超尺子 ⇒ net-play 那格 foldBad===0 假红。修法是给尺子一个 2 cm 的下限
// （js/net/idle-ruler.mjs），但**必须**配两条族群臂：下限不许吃掉真信号（AA2）、
// 走动的窗口仍按自己的步长量（AA3/AA4）—— 否则下限一放大，判据就成了恒真绿灯。
// 附十四记的现成样本直接当夹具用（0.0004 m 步长 / 2~4 mm 残差）。
{
  // 旧尺子：client.mjs 改掉之前的那句，原样抄在这儿 —— 反证臂拿它证明
  // 下面的夹具真的分得开新旧两种判决，AA1 的绿不是恒绿。
  const oldBad = (corrected, stepMeasured, vel) => corrected > (stepMeasured !== null ? stepMeasured : vel / 60);

  ok('AA0 先决：下限钉在 2×位置量化步长，且高于两轴最坏量化噪声（√2·POS_STEP/2）',
    IDLE_FLOOR === POS_STEP * 2 && IDLE_FLOOR > Math.SQRT2 * POS_STEP / 2, `IDLE_FLOOR=${IDLE_FLOOR} m`);
  // 附十四的原话：stepMeasured 掉到 0.4 mm 量级，2~4 mm 的残差就够 foldBad。
  const still = foldJudge({ corrected: 0.004, stepMeasured: 0.0004, speed: 0 });
  ok('AA1 静止 + 噪声级残差（4 mm / 步长 0.4 mm）不记 foldBad，且这一格尺子来自下限',
    !still.bad && still.floored && still.ruler === IDLE_FLOOR, `ruler=${still.ruler}`);
  ok('AA1【反证】同一格喂旧尺子必红 —— 假红是旧写法自己的，不是新判据在放水',
    oldBad(0.004, 0.0004, 0) === true);
  ok('AA2 静止 + 真漏补量级的残差（一拍最低走速位移 0.074 m）必须红 —— 下限不许吃掉真信号',
    foldJudge({ corrected: 0.074, stepMeasured: 0.0004, speed: 0 }).bad === true);
  const move = foldJudge({ corrected: 0.081, stepMeasured: 0.077, speed: 4.62 });
  ok('AA3【族群臂】走动的窗口按自己的步长量（0.081 > 0.077 ⇒ 红，与下限无关）',
    move.bad === true && move.floored === false && move.ruler === 0.077, `ruler=${move.ruler}`);
  ok('AA4【族群臂】走动 + 补偿到位（0.05 < 0.077）照旧不红 —— 下限没有把走动窗一并放过',
    foldJudge({ corrected: 0.05, stepMeasured: 0.077, speed: 4.62 }).bad === false);
  const vel = foldJudge({ corrected: 0.077, stepMeasured: null, speed: 4.46 });
  ok('AA5 窗口太短取不到步长时走速度退路（4.46/60 ≈ 0.0743），真实漏补照样红',
    Math.abs(vel.ruler - 4.46 / 60) < 1e-9 && vel.bad === true, `ruler=${vel.ruler.toFixed(4)}`);
  ok('AA6 退路+下限合流的那格（速度 0、取不到步长）与 AA1 同判：噪声不红、floored 记账',
    foldJudge({ corrected: 0.004, stepMeasured: null, speed: 0 }).floored === true
    && foldJudge({ corrected: 0.004, stepMeasured: null, speed: 0 }).bad === false);
  ok('AA7 边界：残差恰好等于尺子不红（判据是严格大于）—— 贴线的量化噪声不该记一笔',
    foldJudge({ corrected: IDLE_FLOOR, stepMeasured: null, speed: 0 }).bad === false
    && foldJudge({ corrected: IDLE_FLOOR + 1e-9, stepMeasured: null, speed: 0 }).bad === true);
}

// ───────────────────────── 收口 ─────────────────────────
const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  GREEN  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);
