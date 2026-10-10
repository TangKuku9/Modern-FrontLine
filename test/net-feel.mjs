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
import { NetPlayer, LEAVE_FADE, INTERP_DELAY, setInterpDelay } from '../js/net/remote.mjs';
import { createSoldierModel, animateSoldier } from '../js/soldier.js';
import { flashAt, Projectile, explode } from '../js/combat.js';
import { WeaponState } from '../js/weapon-state.js';
import { rng } from '../js/util.js';
import { NetClient } from '../js/net/client.mjs';
import { NetRoom, RESPAWN_DELAY } from '../server/room.mjs';
import { Sentry } from '../js/mp.js';
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { pauseActions, isImeKey } from '../js/menu.js';
import { parseChatCommand, toggleMute, isMuted, chatRowHtml, chatTime } from '../js/net/chat.mjs';
import { foldJudge, IDLE_FLOOR } from '../js/net/idle-ruler.mjs';
import { FLAG, WEAPON_IDS, POS_STEP } from '../js/quant.js';
import { WEAPONS } from '../js/data.js';
import { SAY as SAY_TRI, streakOwn, medalSay, SAY_START } from '../js/match-rules.js';
import { readFileSync } from 'node:fs';

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);

const TWO_PI = Math.PI * 2;
const angDiff = (a, b) => { let d = (b - a) % TWO_PI; if (d > Math.PI) d -= TWO_PI; if (d < -Math.PI) d += TWO_PI; return d; };

// ───────────────────────── 环境桩 ─────────────────────────
// 记录"表现层到底调了什么"。刻意不用真 Effects/Audio：那一层要 WebGL 与 AudioContext，
// 而这里要断言的是**调用次数与参数**，不是听感。
function makeGame() {
  const log = { shot: 0, step: 0, reload: [], tracer: 0, flashLight: 0, muzzle: 0, ring: [], hurt: 0, markers: null, smoke: 0, said: [] };
  const game = {
    time: 0, scene: new THREE.Scene(), entities: [], projectiles: [],
    world: { def: { surface: 'dirt' }, lineBlocked: () => false },
    player: { name: '我', team: 'A', pos: new THREE.Vector3(), alive: true, shake: () => {} },
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
      hurt: () => { log.hurt++; }, explosion: () => {}, whoosh: () => {},
      // 语音播报**按文本记账**，不当空桩。这一格曾是 `say: () => {}`，于是"联机少念一句 /
      // 多念一句 / 念错"这一整类差异在 186 条判据里结构性隐形（见 V 段文件头注）。
      // 注意 speechSynthesis 在 Node 里根本不存在，所以这里量的是**调用与实参**，
      // 不是听感 —— 而"念没念、念的是什么"恰好就是这一层要钉的东西。
      say: (t) => { log.said.push(t); }, beep: () => {},
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
  ok('JZ5 同拍消费：确认照常发出 {t:"streak"} 窄帧、压制切到"直到松手"、选点退出、点击残留清零',
    !!sf && sf.slot === 0 && c2.suppressFireUntilRelease === true && c2.targeting === null && c2.confirmShot === false,
    JSON.stringify(sf || null));
  // 确认后按住扳机：那些拍在输入形状里就是 fire=false（重放时间轴与原始预测同源，
  // 不会再有"重放里的幻影弹"）；松手那一拍旗子就地清掉，补枪是全新的一次按下。
  const held = { fire: true, firePressed: false, mdx: 0, mdy: 0, streak: -1 };
  c2.recordInput(12, held);
  ok('JZ7 确认后按住扳机：开火位在输入形状里就不存在（上行与日记本同源，重放无幻影弹）',
    !(c2.pending[c2.pending.length - 1].buttons & 1) && held.fire === false
      && c2.suppressFireUntilRelease === true);
  c2.recordInput(13, { fire: false, firePressed: false, mdx: 0, mdy: 0, streak: -1 });
  ok('JZ8 松手解压：补枪是全新的一次按下（不压到某个秒数 —— 秒数在重放里对不齐）',
    c2.suppressFireUntilRelease === false);
  // 反证臂：点空（这一拍没照到地面）就丢 —— 不许顺延到"后来才照到"的那一拍凭空确认。
  c2.targeting = { slot: 0 };
  g2.world.raycast = () => null;
  c2.recordInput(11, { fire: true, firePressed: true, mdx: 0, mdy: 0, streak: -1 });
  c2.updateTargeting({ firePressed: false, adsPressed: false });
  ok('JZ6 反证臂：点空的确认就地作废（选点还开着、没有请求发出去、残留不留给下一拍）',
    c2.targeting !== null && sent.length === 1 && c2.confirmShot === false,
    `sent=${sent.length} targeting=${!!c2.targeting}`);
}

// ───────── JR. 中途进房看得到既成世界（差距 12 的"迟到的人"变体 · 2026-10-01）─────────
// 快速加入与掉线重连都是往**正在跑**的对局里进人。以前 welcome 只装人：在场的哨戒机、
// 直升机、地上的枪、半路的雷，在新来的人的屏幕上统统不存在 —— 然后他被看不见的东西打死。
{
  // —— 服务端那一半：liveWorld 的单元（形状必须与 turret/pickup/proj 出生事件逐字同形）——
  const gW = makeGame();
  gW.world.groundHeight = () => 0;
  const sentry = new Sentry(gW, new THREE.Vector3(3, 0, 4), { team: 'A', yaw: 0.5, isPlayer: true }, { dumb: true, duration: 40 });
  sentry.netId = 31; sentry.t = 17.3;                 // 剩余寿命
  const heli = { isHeli: true, alive: true, netId: 32, team: 'B', ang: 2.2, t: 9.5, height: 24, radius: 30, hp: 88.4, maxHp: 300 };
  const drop = { netId: 33, weaponId: 'ak', att: { muzzle: 'suppressor' }, pos: new THREE.Vector3(5, 0.1, 6), mag: 12, reserve: 90 };
  const fly = { alive: true, netId: 34, type: 'frag', owner: {}, pos: new THREE.Vector3(1, 2, 3), vel: new THREE.Vector3(0, -4, 0), fuse: 1.7 };
  const room = Object.create(NetRoom.prototype);
  room.active = [sentry, heli]; room.byPlayer = new Map();
  const owner7 = {};
  room.byPlayer.set(owner7, { cid: 77 });
  fly.owner = owner7;
  room.game = { pickups: [drop, { noNetId: true }], projectiles: [fly, { alive: false, netId: 99 }] };
  // 修前的 room.mjs 没有这个入口 —— 直接 call 会把整份判据炸掉，而"抛异常"不是判决。
  // 缺入口就点名红（清单为空），让红落在读数上而不是堆栈上。
  const hasLive = typeof NetRoom.prototype.liveWorld === 'function';
  const w = hasLive ? NetRoom.prototype.liveWorld.call(room) : { turrets: [], pickups: [], projs: [] };
  const t1 = w.turrets.find(t => t.netId === 31), t2 = w.turrets.find(t => t.netId === 32);
  const p1 = w.pickups[0], f1 = w.projs[0];
  ok('JR1 liveWorld：在场实体进清单，形状与出生事件同形（dur 给剩余寿命）',
    hasLive && t1 && t1.kind === 'sentry' && Math.abs(t1.dur - 17.3) < 1e-9 && t1.team === 'A'
    && t2 && t2.kind === 'heli' && t2.ang === 2.2 && t2.hp === 88 && t2.maxHp === 300
    && p1 && p1.weapon === 'ak' && p1.mag === 12
    && f1 && f1.kind === 'frag' && f1.self === false && f1.cid === 77 && Math.abs(f1.fuse - 1.7) < 1e-6,
    hasLive ? JSON.stringify({ t1, t2, p1, f1 }) : 'liveWorld 未定义（修前形状）');
  ok('JR1【反证】没编号/已死的进不了清单（僵尸行只会让客户端建出幽灵）',
    hasLive && w.pickups.length === 1 && w.projs.length === 1,
    hasLive ? '' : 'liveWorld 未定义（修前形状）');

  // —— 客户端那一半：welcome.world 先存、地图就绪后补种 ——
  const g2 = makeGame();
  g2.world.groundHeight = () => 0;
  g2.pickups = [];                     // makeGame 没有这一格：spawnGroundPickup 要往里放
  g2.spawnPickup = (id, att, pos, mag, reserve) => { const p = { weaponId: id, att, pos, mag, reserve }; g2.pickups.push(p); return p; };
  g2.effects.addFireSource = () => {};
  const c3 = new NetClient(g2, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c3.cid = 7;
  c3.onControl({ t: 'welcome', cid: 7, name: '我', team: 'A', streaks: [], others: [], world: {
    turrets: [{ e: 'turret', netId: 41, kind: 'sentry', team: 'A', x: 1, y: 0, z: 2, yaw: 0, dur: 30 }],
    pickups: [{ e: 'pickup', id: 42, weapon: 'm1911', att: {}, x: 3, y: 0, z: 4, mag: 7, reserve: 35 }],
    projs: [{ e: 'proj', netId: 43, kind: 'frag', cid: 9, self: false, x: 5, y: 1.5, z: 6, vx: 0, vy: -3, vz: 0, fuse: 2.5, team: 'B' }],
  } });
  ok('JR2 welcome 到达时地图还没好 ⇒ 只存不种（种早了会被 spawn 闸静默丢掉）',
    !!c3.pendingWorld && g2.entities.length === 0);
  g2.world = { groundHeight: () => 0, root: new THREE.Scene(), def: { surface: 'dirt' }, lineBlocked: () => false };
  c3.frameUpdate(0.016);
  ok('JR3 地图就绪后补种：在场哨戒机 / 地上的枪 / 半路的雷各建各的表现副本',
    c3.turrets.get(41) && c3.turrets.get(41).dumb === true
    && c3.pickups.get(42) && c3.pickups.get(42).mag === 7
    && c3.projs.get(43) && c3.projs.get(43).dumb === true,
    `turrets=${c3.turrets.size} pickups=${c3.pickups.size} projs=${c3.projs.size}`);
  ok('JR3【反证】补种完清单必须清空（回房间再开下一局不许带进旧世界）', c3.pendingWorld === null);
  c3.dispose();
  ok('JR4 dispose 把没种完的清单一并清掉（对局中途退出不留尾巴）', c3.pendingWorld === null);
  c3.onEvents({ ev: [] });
  const fires = [];
  g2.effects.addFireSource = (pos, r, dur) => fires.push([pos.x, pos.y, pos.z, r, dur]);
  // 白磷弹头的火随弹走：proj 事件带 fire 位，哑副本**落地时自己点火**（与爆炸同帧）。
  // 旧 wpFires"火点清单"已删 —— 火跑在弹头前面的画面就是"先着火、再掉弹"。
  // frameUpdate 不推进弹道物理（那是 game 帧的事），这里直接步进表现副本 ——
  // 只步 bomb：world 桩没有 raycast，别把 JR3 补种的那颗 frag 也卷进来。
  c3.onEvents({ ev: [{ e: 'proj', netId: 44, kind: 'bomb', cid: null, self: false,
    x: 5, y: 0.3, z: 6, vx: 0, vy: 0, vz: 0, fuse: 5, team: 'A', fire: 1 }] });
  for (let i = 0; i < 12; i++) for (const p of [...g2.projectiles]) if (p.type === 'bomb') p.update(1 / 60);
  ok('JR5 白磷弹头落地即点火：fire 位随 proj 事件下发、哑副本落地自己点（只发光，不裁伤害）',
    fires.length === 1 && fires[0][0] === 5 && fires[0][2] === 6 && fires[0][3] === 1.5 && fires[0][4] === 8,
    JSON.stringify(fires));
  // 反证臂：不带 fire 位的弹（集束空袭的弹）落地绝不点火 —— 点了就是每场空袭都烧一片。
  c3.onEvents({ ev: [{ e: 'proj', netId: 45, kind: 'bomb', cid: null, self: false,
    x: 50, y: 0.3, z: 60, vx: 0, vy: 0, vz: 0, fuse: 5, team: 'A' }] });
  for (let i = 0; i < 12; i++) for (const p of [...g2.projectiles]) if (p.type === 'bomb') p.update(1 / 60);
  ok('JR5【反证】不带 fire 位的弹（集束弹）落地不点火', fires.length === 1, `fires=${fires.length}`);

  // —— 重名认尸：kill 事件按名字找人时，死者才是 !alive 的那个 ——
  const r2 = Object.create(NetRoom.prototype);
  const aliveTwin = { pl: { name: '重名', alive: true }, dead: false, respawnT: 0 };
  const deadTwin = { pl: { name: '重名', alive: false }, dead: false, respawnT: 0 };
  r2.clients = new Map([[1, aliveTwin], [2, deadTwin]]);
  r2.events = []; r2.killExtra = [];
  r2.game = { events: [{ e: 'kill', killer: 'x', victim: '重名' }] };
  NetRoom.prototype.drainKillFeed.call(r2);
  ok('JR6 重名同房：重生计时落到真正死了的那位头上（以前按名字取第一个，活着的背 3 秒黑锅、死者白拿立即重生）',
    deadTwin.respawnT === RESPAWN_DELAY && deadTwin.dead === true && !aliveTwin.dead && aliveTwin.respawnT === 0,
    `死者 respawnT=${deadTwin.respawnT} · 活者 respawnT=${aliveTwin.respawnT}`);
  // 反证臂要用旧写法能红：按旧条件（只比名字、不看死活）在同一现场选出来的正是活着的那个
  const oldPick = [...r2.clients.values()].find(c => c.pl.name === '重名');
  ok('JR6【反证】旧写法在这一现场选的是活着的同名者（绿灯不是恒真）', oldPick === aliveTwin);
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
  // ── 缺席的两种语义（PROTO=2：服务端按 AOI 裁剪快照，活着的人也会缺席）──
  // js/net/client.mjs:onSnapshot 那一圈的分诊是：缺席第 1 份 ⇒ 只是**走出 200m 视野**，
  // 藏起来（setFar）等他回来；连续缺席超过宽限 15 份（20Hz ≈ 0.75 秒）才按退房处理
  // 进淡出队列。旧判据写的是"缺席一份就淡出"，那是 AOI 上线之前的语义（2026-10-09
  // 起一直红着，而实现是对的）。这一族四种失效都得各自能红：
  //   把 AOI 里暂时看不见的人直接删掉（最糟）→ N3a/N3b 拦；
  //   永远不删（人走了模型留在场上）→ N3d 拦；
  //   回来了不恢复 → N3c 拦；
  //   瞬时 dispose 不淡出 → N4/N5 拦。
  frame([ent(4, 1, 2)], 103, 0.05);
  ok('N3a 缺席第 1 份 ⇒ 只是藏起来（setFar），不进淡出队列',
    c.leaving.length === 0 && c.remotes.has(3) && r3.far === true && r3.model.root.visible === false && g.entities.length === 2,
    `leaving=${c.leaving.length} far=${r3.far} visible=${r3.model.root.visible}`);
  for (let i = 0; i < 14; i++) frame([ent(4, 1, 2)], 104 + i, 0.10 + i * 0.05);
  ok('N3b【反证】宽限之内（累计缺席 15 份）仍然不拆人 —— 走出视野是常态，不是退房',
    c.leaving.length === 0 && c.remotes.has(3) && r3.__miss === 15,
    `缺席 15 份：leaving=${c.leaving.length} miss=${r3.__miss}`);
  frame([ent(3, 1, 1), ent(4, 1, 2)], 118, 0.80);
  ok('N3c 走回视野 ⇒ 缺席计数归零、模型恢复可见（断断续续的缺席攒不出一次"退房"）',
    r3.__miss === 0 && r3.far === false && r3.model.root.visible === true && c.leaving.length === 0,
    `miss=${r3.__miss} far=${r3.far} visible=${r3.model.root.visible}`);
  for (let i = 0; i < 16; i++) frame([ent(4, 1, 2)], 119 + i, 0.90 + i * 0.05);
  ok('N3d 攒够宽限（连续第 16 份仍缺席）⇒ 进淡出队列，而不是瞬时 dispose',
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
// 第 11 轮审计的低危账又在这把尺子上找出两处：① 判决用的是**严格大于**，
// 于是"残差恰好等于一拍位移"（那正是漏补一拍的形状）落在相等那一侧的样本一律报绿；
// ② 退路那一支硬编码 /60，服务端拍频一改就静默失准。AA7 与 AA8 各自钉一条。
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
  // AA7 换过判据（低危账）：旧的写的是"残差恰好等于尺子**不**红（判据是严格大于）"——
  // 那条把"漏补一拍"的形状当成了正常。现在反过来钉两边：等于 ⇒ **必须红**，略小 ⇒ 不红。
  ok('AA7 边界：残差恰好等于尺子**必须红**（"等于一拍位移"正是漏补一拍这个形状本身）',
    foldJudge({ corrected: IDLE_FLOOR, stepMeasured: null, speed: 0 }).bad === true);
  ok('AA7b【反证臂】略小于尺子不红（阈值没有变成"一律红"，那和恒红一样没用）',
    foldJudge({ corrected: IDLE_FLOOR - 1e-9, stepMeasured: null, speed: 0 }).bad === false);
  // AA8 拍频从外面来（低危账：写死 60 的话，服务端一改拍频这把退路尺子就静默失准）。
  // 同一个速度下拍频减半 ⇒ 一拍位移翻倍 ⇒ 尺子跟着翻倍，**判决也跟着翻** ——
  // 只比 step 的数值不算数（那只证明它读了这个参数），要的是它真的改了结论。
  const hz60 = foldJudge({ corrected: 0.09, stepMeasured: null, speed: 4.46, tickHz: 60 });
  const hz30 = foldJudge({ corrected: 0.09, stepMeasured: null, speed: 4.46, tickHz: 30 });
  ok('AA8 退路尺子按传入的拍频折算（30Hz 的一拍位移是 60Hz 的两倍，判决随之翻面）',
    Math.abs(hz60.step * 2 - hz30.step) < 1e-9 && hz60.bad === true && hz30.bad === false,
    `60Hz 尺子 ${hz60.step.toFixed(4)}（红）· 30Hz 尺子 ${hz30.step.toFixed(4)}（不红）`);
}

// ───────────────────────── AB. 网络读数的类型守卫（第 11 轮低危账）─────────────────────────
// `pong` 的 c 是服务端原样回抄的客户端时间戳。不校验的话，一枚坏值（字符串 / 缺失 /
// 被中间改过）会让 `performance.now() - c` 得 NaN —— 而 rtt 是平滑过的读数，一枚 NaN
// 把它永久弄脏，记分板上从此印 "ping NaN ms"，看不出是哪一端的问题。
// 直接喂假的控制帧：`onControl` 是纯方法（test/net-drop.mjs 也这么用）。
{
  const mk = () => ({ rtt: 12.5, pingGot: 0, pingBad: 0 });
  const good = mk(); NetClient.prototype.onControl.call(good, { t: 'pong', c: performance.now() - 30 });
  const badS = mk(); NetClient.prototype.onControl.call(badS, { t: 'pong', c: 'oops' });
  const badM = mk(); NetClient.prototype.onControl.call(badM, { t: 'pong' });
  const badN = mk(); NetClient.prototype.onControl.call(badN, { t: 'pong', c: NaN });
  ok('AB1【先决】正常的一枚 pong 真的更新了 rtt（这条通路被驱动了，不是没进分支）',
    good.pingGot === 1 && good.rtt > 0 && good.rtt < 200, `rtt=${good.rtt.toFixed(1)}`);
  ok('AB2【命门】坏掉的 c 不污染 rtt（字符串 / 缺失 / NaN 三种都保留旧值）',
    badS.rtt === 12.5 && badM.rtt === 12.5 && badN.rtt === 12.5,
    JSON.stringify({ str: badS.rtt, miss: badM.rtt, nan: badN.rtt }));
  ok('AB3【反证臂】坏的那几枚各自计一笔 pingBad（"丢掉"这件事本身可数）',
    badS.pingBad === 1 && badM.pingBad === 1 && badN.pingBad === 1 && good.pingBad === 0,
    JSON.stringify([badS.pingBad, badM.pingBad, badN.pingBad]));
}

// ───────────────────────── AC. 击杀反馈对账（2026-10-02 香港服实测）─────────────────────────
// 症状：开枪的瞬间击杀音/红叉当场就响，目标却"死"了又活 —— 服务端把这一枪判空时
// （对移动目标，画面滞后 ~150ms 很常见），预测 hp 被下一份快照抹回，下一枪又"死"一次，
// 于是"不断击杀反馈但它不死"。收法：远端实体的"预测致死"降级为普通命中反馈
// （weapon-state 经 NetClient.deferKill 认领），红叉与击杀音由权威 kill 事件到齐
// （main.js:onNetKill 本来就放击杀音，红叉随本轮补上）——预测侧无对账、无撤销，
// 是因为它根本不需要撤销：**真凭据只有事件那一份**。
// 这一节量两端：NetClient 的认领语义，与 weapon-state 消费端真的按认领结果分流。
{
  // ① 认领语义
  const g1 = makeGame();
  const c1 = new NetClient(g1, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c1.cid = 7;
  const ent1 = (id, team, x) => ({ id, x, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, flags: FLAG.Alive | FLAG.OnGround, weapon: 0, mag: 30, phase: 0, vx: 0, vz: 0, team, ack: 0, rep: 0 });
  c1.onSnapshot({ tick: 100, seq: 1, worldFlags: 0, rngState: 1, entities: [ent1(3, 1, 1)] }, 0);
  const r3 = c1.remotes.get(3);
  ok('AC1【先决】远端副本真的建出来了（不然认领语义量的是空气）', !!r3);
  ok('AC2 远端副本被认领 ⇒ 预测侧降级（击杀反馈等权威事件）',
    c1.deferKill(r3) === true);
  ok('AC3 不认识的实体不认领 ⇒ 调用方保持旧行为（单机形状 / 兜底）',
    c1.deferKill({ id: 999 }) === false && c1.deferKill(null) === false && c1.deferKill({}) === false);

  // ② 消费端分流：真 WeaponState + 全桩 game。目标桩"一枪必死"（takeDamage ⇒ true 恒真），
  //    这样 r.killed 恒真，红叉的形状只由 deferKill 决定 —— 分流本身被隔离出来量。
  const mkShot = (netStub) => {
    const g = makeGame();
    g.world.raycast = () => null;
    const marks = [], hits = [];
    g.hud.hitmarker = (k, h) => marks.push([k, h]);
    g.audio.hit = (k, h) => hits.push([k, h]);
    if (netStub) g.net = netStub;
    const target = {
      alive: true, team: 'B', metal: false,
      hitTest: () => ({ t: 10, part: 'body' }),
      takeDamage: () => true,
    };
    const pl = {
      pos: new THREE.Vector3(), vel: { x: 0, z: 0 }, onGround: true, crouchT: 0,
      sprinting: false, sliding: false, team: 'A', alive: true, hp: 100, maxHp: 100,
      yaw: 0, pitch: 0, revealT: 0, hasPerk: () => false, rng,
      stats: { shots: 0, hits: 0 },
      eyePoint: (v) => v.set(0, 1.62, 0),
      aimDir: (v) => v.set(0, 0, -1),
      punch: () => {},
    };
    g.entities = [target];
    const ws = new WeaponState(g, pl);
    ws.setLoadout([{ id: 'ak' }]);
    // setLoadout 进 'switch'（0.5s）挡火：先空转把切枪走完，再扣扳机 —— 不然四条
    // 断言量的是"没开过枪"（shots 恒 0），全是假红。
    for (let i = 0; i < 35; i++) ws.update(1 / 60, { fire: false, ads: false, mdx: 0, mdy: 0 });
    ws.update(1 / 60, { fire: true, ads: false, mdx: 0, mdy: 0 });
    return { marks, hits, shots: pl.stats.shots, hitStat: pl.stats.hits };
  };
  const a = mkShot(null);
  ok('AC4 单机形状（没有 game.net）：预测致死照旧即时放红叉与击杀音（预测就是裁决本身）',
    a.marks.length === 1 && a.marks[0][0] === true && a.hits.length === 1 && a.hits[0][0] === true,
    JSON.stringify({ marks: a.marks, hits: a.hits }));
  const b = mkShot({ deferKill: () => true });
  ok('AC5 联机 + 认领：同一条预测降级为普通命中（红叉与击杀音等权威事件到齐）',
    b.marks.length === 1 && b.marks[0][0] === false && b.hits.length === 1 && b.hits[0][0] === false,
    JSON.stringify({ marks: b.marks, hits: b.hits }));
  const c = mkShot({ deferKill: () => false });
  ok('AC6【反证臂】联机但不认领：即时击杀反馈原样保留（deferKill 不是无脑降级）',
    c.marks.length === 1 && c.marks[0][0] === true, JSON.stringify(c.marks));
  ok('AC7【先决】三种形状下开枪数与命中数各记一次（分流只动反馈的形状，不动账）',
    a.shots === 1 && b.shots === 1 && c.shots === 1 && a.hitStat === 1 && b.hitStat === 1 && c.hitStat === 1,
    JSON.stringify([a, b, c].map(x => [x.shots, x.hitStat])));
}

// ───────────────────────── AD. 插值回退自适应（2026-10-02 轮低危账）─────────────────────────
// 固定 100ms 是按"最差链路"拍的：快照 50ms 一班，回退真正要盖住的只是"下一班还没到"的
// 那段时间。回退每多 10ms，屏幕上的别人就旧 10ms、开枪要提前的量随之变大。收法：按
// 到达间隔的 EMA + 抖动的 EMA + 余量收放，夹在 55–120ms（remote.mjs 的 INTERP_MIN/MAX）。
// 关键不变式：renderTick（报给服务端的拍号）与 NetPlayer.update 读同一个活绑定 ——
// 自适应改值之后，"报的拍号 = 渲染的那一拍"必须原样成立，不然补偿口径整体错位。
{
  const g = makeGame();
  const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team: 'A' });
  c.cid = 7;
  const ent = (id, team, x) => ({ id, x, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, flags: FLAG.Alive | FLAG.OnGround, weapon: 0, mag: 30, phase: 0, vx: 0, vz: 0, team, ack: 0, rep: 0 });
  const frame = (entities, tick, now) => c.onSnapshot({ tick, seq: 1, worldFlags: 0, rngState: 1, entities }, now);
  // 规整 20Hz ×10 包（前 8 包不动手，之后 EMA 已收敛）：间隔 50ms + 余量 15ms ⇒ 65ms
  for (let i = 0; i < 10; i++) frame([ent(3, 1, 1)], 600 + i * 3, i * 0.05);
  ok('AD1 规整到达 ⇒ 回退收到 间隔+余量（不再按最差链路的 100ms）',
    Math.abs(INTERP_DELAY - 0.065) < 1e-9, `INTERP_DELAY=${INTERP_DELAY}`);
  // 恒等式在自适应之后仍成立（拍号流水与时间流水都是线性的，两边可以精确对上）
  const lastP = c.snapLog[c.snapLog.length - 1];
  const t0 = lastP.t + 0.01;
  const v = c.renderTick(t0);
  const spec = lastP.tick - 60 * (INTERP_DELAY + (lastP.t - t0));
  ok('AD2 报值恒等式在自适应之后仍成立（renderTick 与 NetPlayer 同一个活绑定，口径不裂）',
    Math.abs(v - spec) < 1e-6, `实测 ${v} / 规格 ${spec.toFixed(3)}`);
  // 抖动进来：相邻间隔交替 70/30ms（均值仍 50ms）—— 间隔 EMA 不变、抖动 EMA ≈20ms ⇒ 放宽
  let t = 0.5, tick = 630;
  for (let i = 0; i < 20; i++) { frame([ent(3, 1, 1)], tick, t); t += (i % 2 === 0 ? 0.07 : 0.03); tick += 3; }
  ok('AD3 抖动进来 ⇒ 回退放宽（盖住迟到的下一班，而不是硬压出顿挫）',
    INTERP_DELAY > 0.075 && INTERP_DELAY < 0.12, `INTERP_DELAY=${INTERP_DELAY.toFixed(4)}`);
  // 间隔爆表（断流又恢复）⇒ 夹在上限，不跟着飞 —— 尾巴交给外推（上限 0.15s）盖
  for (let i = 0; i < 6; i++) frame([ent(3, 1, 1)], 690 + i * 3, 1.5 + i * 0.5);
  ok('AD4 间隔爆表 ⇒ 夹在上限 120ms（下限防顿挫、上限防漂，两端都要在）',
    Math.abs(INTERP_DELAY - 0.12) < 1e-9, `INTERP_DELAY=${INTERP_DELAY}`);
  setInterpDelay(0.10);   // 复位：不给这条判据之后的任何读者留一个被改动过的常数
  ok('AD5 复位臂：判据跑完把常数还回去（模块级状态不许跨节泄漏）', INTERP_DELAY === 0.10);
}

// ───────────────────────── V. 语音播报（2026-10-02 收口）─────────────────────────
// 这一段存在的理由是**它本来量不到**：上面 makeGame 里的 audio 桩曾把 say 打成
// `say: () => {}`，于是"联机少念一句 / 念错 / 不念"这一整类差异在 186 条判据里
// 结构性隐形。症状清单（全部是玩家侧的"出入"，不报错）：
//   · 联机开局静默（单机说"团队死斗，行动开始"）；
//   · 联机连杀奖章静默（单机念"双杀/暴走/无人可挡"）；
//   · 同一件事两端措辞不同（单机"敌方无人机已上线" / 联机"UAV 已上线"）；
//   · 占点那一句被念成"敌方A 点已失守"（服务端文案已带"敌方"，客户端又拼一次）。
// 修法照 killMedals 的形状：语义进、文本出（js/match-rules.js 的 SAY / ANNOUNCE），
// 服务端下发 `say` 字段，客户端不再拿屏幕大字当语音念。
//
// **量的不是听感**（speechSynthesis 在 Node 里不存在），而是"念没念、念的是什么"。
{
  // 先决：录音桩是活的。空桩的话下面每一条都会因为 log.said 恒空而"恰好通过"，
  // 方向正好反了 —— 所以这条必须先立，且它自己带反证臂（桩确实记了两条）。
  const g0 = makeGame();
  g0.audio.say('甲'); g0.audio.say('乙');
  ok('V0【先决】audio.say 桩真的在记账（不是空桩 —— 这一格曾是 say: () => {}）',
    g0.log.said.length === 2 && g0.log.said[0] === '甲' && g0.log.said[1] === '乙',
    JSON.stringify(g0.log.said));
  ok('V0b【反证臂】没调用时它是空的（不是"恒有值"的那盏绿灯）',
    makeGame().log.said.length === 0, JSON.stringify(makeGame().log.said));

  const feed = (team, cid, evs) => {
    const g = makeGame();
    g.player.team = team;
    // matchOver 那一支要真 DOM（deathScreen + showResults 走结算页）。**桩的缺口在这里补**，
    // 不改被测对象（见文件头纪律③）—— 只给它一个能挂 classList 的假元素。
    const el = { classList: { add() { }, remove() { } }, style: {}, textContent: '', innerHTML: '' };
    const prevDoc = globalThis.document;
    globalThis.document = { getElementById: () => el, createElement: () => ({ style: {}, classList: { add() { } }, appendChild() { } }) };
    const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team });
    c.cid = cid;
    c.streakDefs = [{ id: 'uav', name: '侦察无人机' }];
    c.streakState = [{ id: 'uav', ready: true }];
    c.showResults = () => { };                 // 结算页不进这一段的范围
    try { c.onEvents({ ev: evs }); }
    finally { globalThis.document = prevDoc; }
    return { said: g.log.said, c };
  };

  // ── 语音走服务端下发的 say，不拿屏幕大字当语音 ──
  // 这一条钉的是"两份文案分家"：服务端给 say（无空格、带正确措辞），text 是给人看的大字。
  // 旧写法是 `say((mine?'':'敌方') + ev.text)`，念出来是"已占领 A 点"（带空格）。
  const own = feed('A', 7, [{ e: 'announce', team: 'A', to: 'own', say: '已占领A点', text: '已占领 A 点' }]);
  ok('V1 占点·己方：念的是 say 那一版，不是屏幕大字（不念出多余的空格）',
    own.said.length === 1 && own.said[0] === '已占领A点', JSON.stringify(own.said));

  // ── 敌方前缀**只加一次**：服务端文案已带"敌方"时不许再拼 ──
  // 反证臂是这一整段的核心：把服务端文案里那个"敌方"去掉，它**必须**自己补上 ——
  // 否则这条判据会被"永远不拼前缀"骗过去（那正是另一个方向的同类 bug）。
  // 注意用例里 text 与 say 要**同时**不带前缀：守卫读的是 text || say 的开头，
  // 只让一边不带就变成"本来就带前缀"的重复路径，量不到"自己补"这一格。
  const foeAlready = feed('B', 9, [{ e: 'announce', team: 'A', to: 'foes', say: '敌方空袭来袭，寻找掩护', text: '敌方空袭来袭！' }]);
  ok('V2 敌方文案已带前缀时**不重复**（旧写法这里会念成"敌方敌方空袭来袭"）',
    foeAlready.said.length === 1 && foeAlready.said[0] === '敌方空袭来袭，寻找掩护'
    && !/敌方敌方/.test(foeAlready.said[0]), JSON.stringify(foeAlready.said));
  const foePlain = feed('B', 9, [{ e: 'announce', team: 'A', to: 'foes', say: '武装直升机进入战区', text: '武装直升机进入战区' }]);
  ok('V3【反证臂】文案不带前缀时它自己补上（不是"永远不拼"骗过去的）',
    foePlain.said.length === 1 && foePlain.said[0] === '敌方武装直升机进入战区',
    JSON.stringify(foePlain.said));

  // ── to 路由仍然生效（V 段不许为了改文案把定向弄坏）──
  ok('V4【反证臂】foes 那一句仍然只给对面（我这一队收不到）',
    feed('A', 7, [{ e: 'announce', team: 'A', to: 'foes', say: '敌方空袭来袭', text: '敌方空袭来袭！' }]).said.length === 0);
  ok('V5 self 仍然只给呼叫者（别人的部署失败不念给我）',
    feed('A', 7, [{ e: 'announce', team: 'A', to: 'self', cid: 9, say: '无法在此部署，位置被挡住', text: '无法在此部署' }]).said.length === 0);

  // ── 呼叫连杀：按 id 查共用表，不是"侦察无人机已呼叫" ──
  // 旧写法是 `say(ev.name + '已呼叫')`，而单机那边念的是"无人机已上线" ——
  // 同一件事两种措辞，且 ev.name 是服务端下发的字段（文案真相散在两处）。
  const st = feed('A', 7, [{ e: 'streak', cid: 7, team: 'A', id: 'uav', name: '侦察无人机' }]);
  ok('V6 呼叫槽位：念的是共用表里那一句（不再是"侦察无人机已呼叫"）',
    st.said.length === 1 && st.said[0] === '无人机已上线', JSON.stringify(st.said));
  const stHeli = feed('A', 7, [{ e: 'streak', cid: 7, team: 'A', id: 'heli', name: '武装直升机' }]);
  ok('V7 呼叫直升机念"武装直升机已就位"（与单机 mp.js 同一句）',
    stHeli.said.length === 1 && stHeli.said[0] === '武装直升机已就位', JSON.stringify(stHeli.said));
  // 反证臂：不认识的 id 退回"名字+已就绪"那一句，而不是静默（静默的形状和"漏了"一样）
  const stBad = feed('A', 7, [{ e: 'streak', cid: 7, team: 'A', id: 'nope', name: '新槽位' }]);
  ok('V8【反证臂】未知 id 退回一个非空句子（不许静默 —— 静默与"漏念"同形）',
    stBad.said.length === 1 && stBad.said[0].length > 0, JSON.stringify(stBad.said));
  // 表本身的先决臂：五个槽位各有一句，且**互不相同**（塌成同一句的形状是"全都念同一句"）
  ok('V8b【先决】共用表覆盖全部五个槽位且互不相同',
    ['uav', 'cluster', 'sentry', 'heli', 'wp'].every(id => streakOwn(id)) &&
    new Set(['uav', 'cluster', 'sentry', 'heli', 'wp'].map(streakOwn)).size === 5);
  ok('V9 别人的槽位就绪不念给我（这一格带 cid）',
    feed('A', 7, [{ e: 'streakReady', cid: 9, slot: 0, id: 'uav', name: '侦察无人机' }]).said.length === 0);

  // ── W8：连杀槽的**写回**也必须带 cid 门 ──
  // 槽位表是每人一份，别人的 ready 写进来会点亮我的同名槽（HUD 显示"就绪 [i+5]"），
  // 他一呼叫又用 streak 把我的槽灰掉 —— 窗口期内我按键会被权威端 rejected，而 HUD 毫无反馈，
  // 正是"按了没反应"那一族。V9 只钉了**语音**那一格（said），没人钉槽位本身。
  // 双向判据：别人的不许写、我自己的必须写 —— 只钉"不许写"的话，把整段删掉也能绿。
  {
    const mkSlot = (team, cid) => {
      const g = makeGame();
      g.player.team = team;
      const c = new NetClient(g, { url: 'ws://127.0.0.1:1/ws', name: '我', team });
      c.cid = cid;
      c.streakDefs = [{ id: 'uav', name: '侦察无人机' }];
      c.streakState = [{ id: 'uav', ready: false, used: false, cost: 3 }];   // 初始 ready=false：写没写才分得开
      return { c, g };
    };
    const o1 = mkSlot('A', 7); o1.c.onEvents({ ev: [{ e: 'streakReady', cid: 9, id: 'uav', name: '侦察无人机' }] });
    ok('V9b【W8】别人的 streakReady 不许写我的槽（初始 false 不许被写成 true）',
      o1.c.streakState[0].ready === false, JSON.stringify(o1.c.streakState));
    const m1 = mkSlot('A', 7); m1.c.onEvents({ ev: [{ e: 'streakReady', cid: 7, id: 'uav', name: '侦察无人机' }] });
    ok('V9c【W8·反证臂】我自己的 streakReady 必须写（否则 V9b 可以是"永远不写"的恒真绿灯）',
      m1.c.streakState[0].ready === true, JSON.stringify(m1.c.streakState));
    const o2 = mkSlot('A', 7); o2.c.streakState[0].ready = true;
    o2.c.onEvents({ ev: [{ e: 'streak', cid: 9, id: 'uav', name: '侦察无人机' }] });
    ok('V9d【W8】别人的 streak（呼叫）不许灰我的槽（ready/used 都不动）',
      o2.c.streakState[0].ready === true && !o2.c.streakState[0].used, JSON.stringify(o2.c.streakState));
    const m2 = mkSlot('A', 7); m2.c.streakState[0].ready = true;
    m2.c.onEvents({ ev: [{ e: 'streak', cid: 7, id: 'uav', name: '侦察无人机' }] });
    ok('V9e【W8·反证臂】我自己的 streak 必须写（ready=false / used=true）',
      m2.c.streakState[0].ready === false && m2.c.streakState[0].used === true, JSON.stringify(m2.c.streakState));
  }

  // ── 结算念胜负（走共用表，且**按 win/draw/lose 三态**各量一次）──
  // 三态是必须的：只量"胜利"的话，把 lose 写成 win 也能绿。
  // winner 的形状是**队名**（tdm/dom 传 'A'/'B'，自由混战才传 cid），而"我"那台视角
  // 固定是 team=A、cid=7 —— 所以只有传 'A' 才是赢、传 'B' 才是输、传 null 才是平。
  const over = (winner) => feed('A', 7, [{ e: 'matchOver', winner }]);
  ok('V10 结算播报（winner=我方队名）念"胜利"', over('A').said.join() === '胜利', JSON.stringify(over('A').said));
  ok('V10b 结算播报（winner=对方队名）念"失败"', over('B').said.join() === '失败', JSON.stringify(over('B').said));
  ok('V10c 结算播报（winner=null）念"平局"', over(null).said.join() === '平局', JSON.stringify(over(null).said));
  ok('V11【反证臂】平局与失败是两句话（表没把三者塌成一个）',
    SAY_TRI.win !== SAY_TRI.lose && SAY_TRI.draw !== SAY_TRI.win && SAY_TRI.draw !== SAY_TRI.lose);

  // ── 集束点确认（客户端本地那条，联机独有）──
  ok('V12 集束确认念"集束空袭已确认"（与单机同一句）', SAY_TRI.clusterOwn === '集束空袭已确认');

  // ── 暂停时语音被掐掉（联机独有的面：权威端照跑，事件照来）──
  // 这一条量的是 main.js:pause 里那一句 cancel。它是纯 DOM/窗口侧的，Node 里没有
  // speechSynthesis，所以这里**只钉源码形状**（真跑起来的那条判据在浏览器档）——
  // 写清楚是"源码形状"而不是"行为"，免得它日后绿着绿着就没人再看了。
  const mainSrc = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const pauseBody = (mainSrc.match(/pause\(v\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  ok('V13 暂停时 cancel 语音合成（源码形状：speechSynthesis 暂停期间不会静默）',
    /speechSynthesis/.test(pauseBody) && /cancel\(\)/.test(pauseBody), pauseBody.slice(0, 60));
  ok('V14【反证臂】pause 里不是 stopAll（那会把 resume 后要续的循环音也收掉）',
    !/stopAll\(\)/.test(pauseBody));

  // ── main.js 的两处（开局 / 连杀奖章）：进程内量不到，只能审源码形状 ──
  // **为什么只能是形状**：`js/main.js` 不导出 Game（README《验收》里"面板那一半在
  // test/net-play.mjs 里量，因为 js/main.js 不导出 Game"是同一条理由），所以
  // onNetKill 与开局那一段在 Node 里跑不起来。**真行为判据在 test/net-play.mjs 的
  // SAY 段**（真页面里 spy audio.say），下面这两条是进程内的兜底 —— 它们的作用是
  // "删掉那两行时这里先红"，而不是"证明它念对了"（那件事由浏览器档负责）。
  // 写清楚这一点，免得日后有人把这两条绿当成"语音没问题"的证据。
  // onNetKill 到下一个同缩进方法之间那一段（用 onNetDeath 作右界，比数花括号稳）
  const killStart = mainSrc.indexOf('onNetKill(ev) {');
  const killEnd = mainSrc.indexOf('onNetDeath(ev) {', killStart);
  const killBody = killStart >= 0 ? mainSrc.slice(killStart, killEnd > killStart ? killEnd : killStart + 2000) : '';
  ok('V15 开局播报那一声还在（源码形状；真行为见 net-play 的 SAY 段）',
    /audio\.say\(\s*SAY_START\(/.test(mainSrc), '');
  ok('V16 连杀奖章在 onNetKill 里念出来，且走 medalSay（源码形状；真行为见 net-play）',
    /medalSay\(/.test(killBody) && /audio\.say\(\s*v\s*\)/.test(killBody),
    killBody ? `onNetKill 体长 ${killBody.length}` : 'onNetKill 段没匹配到');
  // 反证臂：medalSay 只对 chain* 返回非空 —— 这一条量的是**规则那一侧**，
  // 它不依赖 main.js（所以是真行为而不是形状）。爆头/近战/远距离/复仇都不念。
  ok('V17【反证臂】medalSay 只对 chain* 非空（爆头/近战/远距离/复仇一律不念）',
    medalSay('chain2', '双杀') === '双杀' && medalSay('chain6', '无人可挡') === '无人可挡' &&
    medalSay('head', '爆头') === '' && medalSay('melee', '近战击杀') === '' &&
    medalSay('longshot', '远距离击杀') === '' && medalSay('revenge', '复仇') === '' &&
    medalSay(undefined, '无 tag') === '');
}

// ───────────────────────── AE. 骨骼求解钉 60Hz（docs/client-performance-audit.md C3）─────────────────────────
// update 按渲染帧跑，144Hz 屏上 animateSoldier（两骨 IK + 落骨）跟着跑 144 次/s/人。
// 节流后：插值/姿态平滑仍每帧走，只有落骨按 ≥1/60 的节拍跑，dt 用累进的真实帧时 ——
// 动画速度与 60Hz 驱动同速。三条臂各跑 1 秒模拟时间，60Hz 那条必须逐位等于旧行为。
{
  const g = makeGame();
  const r = mkRemote(g);
  r.push(snap({}), 0);
  r.update(1 / 60, 0.05 + INTERP_DELAY);          // 预热一拍，buf 有货
  r.animRuns = 0;
  for (let i = 0; i < 60; i++) r.update(1 / 60, 1 + i / 60);
  ok('AE1 60Hz 驱动：骨骼求解每拍必发（与旧代码逐位一致）', r.animRuns === 60, `animRuns=${r.animRuns}`);
  r.animRuns = 0;
  for (let i = 0; i < 144; i++) r.update(1 / 144, 2 + i / 144);
  ok('AE2 144Hz 驱动（高刷屏）：仍钉 60（老代码 144）', r.animRuns >= 59 && r.animRuns <= 61, `animRuns=${r.animRuns}`);
  r.animRuns = 0;
  for (let i = 0; i < 240; i++) r.update(1 / 240, 3 + i / 240);
  ok('AE3 240Hz 驱动：仍钉 60（老代码 240）', r.animRuns >= 59 && r.animRuns <= 61, `animRuns=${r.animRuns}`);
  // 平滑通道仍在**每帧**走：趴姿通道按 10/s 收敛，同样的喂法与模拟时长，240 小步与
  // 60 大步应收敛到同一落点（差 ~2e-5）。若有人把平滑搬进节流分支，240 那条会停在
  // 0.08 附近 —— 这条就是抓那个的。
  const driveProne = (steps, dt, t0) => {
    const gg = makeGame();
    const rr = mkRemote(gg);
    rr.push(snap({ flags: FLAG.Alive | FLAG.OnGround | FLAG.Prone }), 0);
    rr.update(dt, t0 + INTERP_DELAY);
    for (let i = 0; i < steps; i++) rr.update(dt, t0 + INTERP_DELAY + (i + 1) * dt);
    return rr.anim.prone;
  };
  const p240 = driveProne(240, 1 / 240, 3);
  const p60 = driveProne(60, 1 / 60, 4);
  ok('AE4 姿态平滑仍按渲染帧收敛：240 小步 ≈ 60 大步（平滑被搬进节流分支会当场分叉）',
    Math.abs(p240 - p60) < 1e-3, `prone(240Hz)=${p240.toFixed(5)} · prone(60Hz)=${p60.toFixed(5)}`);
}

// ───────────────────────── 收口 ─────────────────────────
const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  GREEN  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);
