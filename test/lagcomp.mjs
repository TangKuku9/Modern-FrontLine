// 延迟补偿的机制证明（不需要浏览器；走的是真房间、真武器、真逐拍物理）。
//
// 命题：**服务端裁决一枪时，要用"开枪者当时看到的那一拍"的姿态，而不是当下的姿态。**
// 症状（README「还没做完的部分」第 2 条）：高延迟下"我明明打中了"。
//
// ── 判据为什么必须是二维的（瞄哪一点 × 报哪一拍）──
//   · 只断言"瞄过去 + 报过去 ⇒ 中"是假绿高发区：万一回溯根本没生效、而瞄准点又恰好
//     也在身体上，它就绿了；
//   · 只断言"瞄过去 + 不报 ⇒ 不中"更没用 —— 那是改动**之前**的行为，它本来就该不中；
//   · 两维一起量，`view=off` 那两格就是天然的反证臂：它走的是**改动之前那条路**
//     （rewindTick 拒掉 0 ⇒ shotRewind 交回 null ⇒ traceBullet 按当下姿态判），
//     于是"补偿生效"和"没有补偿"在同一套几何上被并排量出来。
//
// ── 为什么"该中/该不中"不是我说的，是算出来的 ──
// 每一枪在开之前，先按**生产函数**算出这一枪会落在哪一个盒子上：
//   · 这一枪实际会回溯到哪一拍 —— 调 server/lagcomp.mjs:rewindTick（生产函数，不是重写一遍）；
//   · 那一个盒子在不在射线上 —— 调 js/combat.js:hitTestPlayer（就是服务端裁决用的那一个）。
// 然后拿这个预测和实测的血量变化比。测试里不抄第二份命中盒：抄了的话，命中盒哪天改了常数，
// 被判据在同步跟着改，而真正被量的是服务端那一次裁决。
//
// 判据线只有一条，而且是规格给的：命中盒半宽 0.28 m。所以
//   · 该中的那一枪，瞄点误差必须 < 0.20 m（1/1.4 个半宽，散布在这个距离上只有 ~1 cm）；
//   · 该不中的那一枪，目标离射线必须 > 1.0 m（3.6 个半宽）——
//     那才是"不中"能说明问题的前提：不是墙挡住了、不是擦边、不是散布蒙的。
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { NetRoom, DT, SNAP_EVERY, decodeInputBits } from '../server/room.mjs';
import { rewindTick, LAG_MAX_TICKS, LAG_HIST } from '../server/lagcomp.mjs';
import { encodeInput, decodeInput } from '../server/codec.mjs';
import { hitTestPlayer } from '../js/combat.js';
import { KEY, BTN } from '../js/quant.js';
// 客户端那一半（报拍号）也要在这里量：它和裁决端必须口径一致，而**不一致的表现是静默的**
// （服务端一律拒绝 ⇒ 这个玩家永远没有补偿，不报错、不崩，只是打不中）。
// 必须在 headless-game 之后 import —— 它带进来的 browser-shim 要先给 canvas/document 打桩。
import { NetClient } from '../js/net/client.mjs';
import { INTERP_DELAY } from '../js/net/remote.mjs';
import * as THREE from 'three';

let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  | ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  | ' + detail : ''}`);
}

await preloadMaterials();
const room = new NetRoom({ id: 'lagcomp', mapId: 'yard', seed: 20260925 });
await room.start();
const ca = room.addClient({ name: '甲', team: 'A' });    // 开枪者
const cb = room.addClient({ name: '乙', team: 'B' });    // 目标
const S = ca.pl, T = cb.pl;
const W0 = room.game.world;

// 交火场地：货柜场南侧的开阔带。货柜场本体是 |x|,|z| ≤ 21（见 js/maps.js:yard 的 grid），
// 这两个点是从**实测**里挑的（把玩家摆上去、跑一遍 collide、看有没有被挤走；见提交说明）：
// 站在 (0,21) 位移 0、朝 +z 通视 7 m（那正好是 z=28 的边界墙），所以目标在 z=25.5 那条线上
// 一定在墙**前面**。"不中"因此只可能是"身体不在那儿"，不是"墙在那儿"。
const SP = new THREE.Vector3(0, 0, 21);          // 开枪者站定，视线朝 +z
const TP0 = new THREE.Vector3(-3.5, 0, 25.5);    // 目标起点，沿 +x 走（几乎垂直于甲的视线）
const groundAt = (v) => { v.y = W0.groundHeight(v.x, v.z, 1, 0.35); return v; };
groundAt(SP); groundAt(TP0);

let tickA = 0, tickB = 0;
// 一拍的骨架：两人的输入都排进队，再推房间一步，然后按服务端的节拍下发快照。
// 快照这一步**必须**在：延迟补偿的窗右端钉在"真的发出去过的那一拍"上（server/room.mjs
// 的 lastSnapSent），跳过它，rewindTick 会把每一枪都判成出窗 —— 那时判据红的是探针自己。
function step(over = {}) {
  room.applyInput(ca.cid, { tick: ++tickA, keys: 0, buttons: BTN.Ads, mdx: 0, mdy: 0, view: 0, ...over.a });
  room.applyInput(cb.cid, { tick: ++tickB, keys: KEY.Fwd, buttons: 0, mdx: 0, mdy: 0, view: 0, ...over.b });
  room.step();
  if (room.tick % SNAP_EVERY === 0) room.snapshot();
}

function reset() {
  S.respawn(SP.clone(), 0);
  T.respawn(TP0.clone(), -Math.PI / 2);          // forward = (-sin(-π/2), -cos(-π/2)) = (+1, 0) ⇒ 沿 +x
  S.hp = S.maxHp; T.hp = T.maxHp;                // 目标每试一次都从满血开始，血量才是"中没中"的读数
  ca.q.length = 0; cb.q.length = 0;              // 上一轮没消费完的输入不许漏进这一轮
  ca.lastInput = decodeInputBits(0, 0); cb.lastInput = decodeInputBits(0, 0);
}

// 把甲的视线拨到某个点。**直接写 yaw/pitch** —— 本判据量的是回溯，不是鼠标灵敏度链路
// （那条链路由 codec 的往返自测和 net-probe 覆盖）。aimYaw/aimPitch 由 updateCamera 在
// 这一拍末尾算出来，所以写完必须再走一拍才生效（shoot() 里那一拍就是它）。
function aimAt(tx, ty, tz) {
  const c = S.camPos, dx = tx - c.x, dz = tz - c.z;
  S.yaw = Math.atan2(-dx, -dz);
  S.pitch = Math.atan2(ty - c.y, Math.hypot(dx, dz));
}

// 射线到某点的垂距（水平面内）。它就是"身体离射线多远"，也就是该中/该不中的唯一依据。
function perpTo(rayO, rayD, px, pz) {
  const rx = px - rayO.x, rz = pz - rayO.z;
  const dl = Math.hypot(rayD.x, rayD.z);
  return Math.abs((rx * rayD.z - rz * rayD.x)) / (dl || 1);
}

// 一枪。aim: 'past'|'now'  ·  view: 'past'|'now'|'off'|'ancient'
// 返回实测结果 + 本枪的几何读数（供断言用）。
function shoot(L, aim, view) {
  const base = L + 42;                 // 走的拍数：W−L 固定 ⇒ 回溯目标永远落在走了 44 拍那一格上，
                                       // 于是三档 L 量的是同一支枪在不同"延迟"下的行为，几何是同一套。
  // 再补几拍，让走完之后 room.tick 是 3 的倍数 —— 这样"我发出去过的最新快照"正好是 room.tick
  // 本身，闸门的边界就落在能算出来的地方（见文件末尾那条边界判据），而不是随累计拍数漂。
  const W = base + ((SNAP_EVERY - ((room.tick + base) % SNAP_EVERY)) % SNAP_EVERY);
  reset();
  for (let i = 0; i < W; i++) step();
  const past = room.tick + 2 - L;      // 开枪那一拍（cur = room.tick+2）会回溯到的绝对拍号
  if (past <= 0) return { err: `回溯目标拍号 ${past} 不合理` };
  const posePast = cb.pose.at(past);
  if (!posePast) return { err: `第 ${past} 拍不在姿态缓冲里（窗口 ${LAG_HIST}）` };

  // 瞄点。'now' 提前一拍：开枪那一拍甲先于乙被 update（clients 顺序），所以乙在开枪
  // 那一瞬间停在"上一步末尾"的位置。
  const tp = aim === 'past'
    ? { x: posePast[0], y: posePast[1], z: posePast[2] }
    : { x: T.pos.x + T.vel.x * DT, y: T.pos.y, z: T.pos.z + T.vel.z * DT };
  const aimY = tp.y + 1.1;             // 躯干中部：命中盒 y ∈ [y, y+eye−0.12]，1.1 落在正中
  aimAt(tp.x, aimY, tp.z);
  step();                              // 瞄准那一拍：aimYaw/aimPitch 在这一拍末尾写好

  // 这一枪的**真实**射线。fire() 里 origin/aimDir 取的就是这两个量，而它们在这一拍里
  // 不会再变（mdx/mdy 为 0，且 updateCamera 在开火之后才跑）—— 所以能在开枪前量准。
  const ro = S.eyePoint(new THREE.Vector3());
  const rd = S.aimDir(new THREE.Vector3());
  // 目标此刻的位置 = 服务端在开枪那一瞬间看到的那个（甲先于乙被 update，见上面那条注释）。
  // **必须在这里读**：再往后走一步，读数就晚了一拍（4.465 m/s ÷ 60 = 0.074 m），
  // 那 0.07 会被记成"瞄准不准"——它其实只是我读晚了。第一版就是这么把自己骗过去的。
  const tnx = T.pos.x, tnz = T.pos.z;

  // 报给服务端的拍号。'off' 报 0（改动之前的客户端就是不发这个字段）；
  // 'ancient' 报一个超上限的旧拍，用来验闸门真的在（它必须退化成 off 的行为）。
  const cur = room.tick + 1;           // 开枪那一拍服务端正在产出的状态号
  const v = view === 'past' ? past
    : view === 'now' ? cur
      : view === 'ancient' ? cur - (LAG_MAX_TICKS + 40) : 0;

  // ① 预测：服务端会按哪一拍的盒子判？
  const eff = rewindTick(v, cur, ca.lastSnapSent);
  const usePast = eff >= 0;
  const pose = usePast ? posePast : cb.pose.at(room.tick) || [T.pos.x, T.pos.y, T.pos.z, T.curEye()];
  // ② 世界那个盒子会不会先被墙挡下 —— 和 traceBullet 同一套语义（best 从墙距起算）
  const wh = W0.raycast(ro, rd, 400);
  const box = hitTestPlayer(pose[0], pose[1], pose[2], pose[3], ro, rd, wh ? wh.t : 1e9);
  const predicted = !!box;

  // ③ 实测
  const hp0 = T.hp;
  step({ a: { buttons: BTN.Ads | BTN.Fire, view: v } });
  const actual = T.hp < hp0;

  return {
    predicted, actual, usePast, eff, v, past, cur, lastSnapSent: ca.lastSnapSent,
    wall: wh ? +wh.t.toFixed(2) : null,
    perpNow: +perpTo(ro, rd, tnx, tnz).toFixed(3),
    perpPast: +perpTo(ro, rd, posePast[0], posePast[2]).toFixed(3),
    dist: +Math.hypot(tp.x - ro.x, tp.z - ro.z).toFixed(2),
    speed: +Math.hypot(T.vel.x, T.vel.z).toFixed(2),
    dmg: hp0 - T.hp,
  };
}

// ── 先决：这套装置确实能打出命中 ──
// 没有这一条，下面每一个"该中"红了都可能是"这台机器上从来就中不了"（枪的射速状态、
// 弹药、切枪动画、目标根本没在走……）。
{
  const r = shoot(36, 'now', 'now');
  chk(!r.err && r.actual, '先决：不补偿、瞄当下 ⇒ 命中（装置本身打得中）', JSON.stringify(r));
  chk(!r.err && r.speed > 4.0, '先决：目标真的在走（不然"过去"和"当下"是同一个点）', `速度 ${r.speed} m/s`);
  chk(!r.err && r.lastSnapSent > 0, '先决：探针真的按服务端节拍下发过快照', `lastSnapSent=${r.lastSnapSent}`);
  chk(!r.err && (r.wall === null || r.wall > r.dist), '先决：目标在墙前面（"不中"必须是身体不在那儿，不是墙挡了）',
    `墙距 ${r.wall} / 目标距 ${r.dist}`);
}

// ── 二维矩阵 ──
// 六格 = 瞄过去/瞄当下 × 报过去/报当下/不报。每一格跑三档延迟（L = 24/36/48 拍）。
const cells = [
  { aim: 'past', view: 'past', want: true, why: '补偿生效：瞄我看到的那个位置，服务端按那一拍判' },
  { aim: 'past', view: 'off', want: false, why: '反证臂（改动之前的写法）：同一枪不报拍号 ⇒ 打不中' },
  { aim: 'past', view: 'now', want: false, why: '报"我就在当下" ⇒ 服务端照当下判 ⇒ 打不中' },
  { aim: 'past', view: 'ancient', want: false, why: '报一个超上限的旧拍 ⇒ 被闸掉，退化成不报' },
  { aim: 'now', view: 'past', want: false, why: '瞄当下却报过去 ⇒ 服务端把目标拨走了 ⇒ 打不中' },
  { aim: 'now', view: 'off', want: true, why: '反证臂的另一半：不补偿、瞄当下 ⇒ 照样中（说明"不中"另有原因时会暴露）' },
  { aim: 'now', view: 'now', want: true, why: '两个都在当下 ⇒ 中' },
];
for (const c of cells) {
  for (const L of [24, 36, 48]) {
    const tag = `L=${L} 瞄${c.aim} 报${c.view}`;
    const r = shoot(L, c.aim, c.view);
    if (r.err) { chk(false, `${tag}`, r.err); continue; }
    // 闸门本身要先对：报过去必须被接受，其余三种必须被拒
    chk(r.eff === (c.view === 'past' ? r.past : -1), `${tag} · 闸门判定符合预期`,
      `rewindTick→${r.eff}（view=${r.v} cur=${r.cur} lastSnapSent=${r.lastSnapSent}）`);
    chk(r.predicted === c.want, `${tag} · 生产函数预测 = 本格应有的结论`,
      `预测中=${r.predicted} 期望=${c.want}`);
    chk(r.actual === c.want, `${tag} · ${c.why}`,
      `实测中=${r.actual}（掉血 ${r.dmg}） 垂距 现在${r.perpNow}m/过去${r.perpPast}m 目标距${r.dist}m 墙距${r.wall}`);
    // 判据线：该中的不许靠擦边，该不中的不许是小偏差
    if (c.want) chk(Math.min(r.perpNow, r.perpPast) < 0.20, `${tag} · 该中的一枪瞄点误差 < 0.20 m`,
      `垂距 现在${r.perpNow} / 过去${r.perpPast}`);
    else chk(Math.max(r.perpNow, r.perpPast) > 1.0, `${tag} · 该不中的一枪目标离射线 > 1.0 m`,
      `垂距 现在${r.perpNow} / 过去${r.perpPast}`);
    chk(r.wall === null || r.wall > r.dist, `${tag} · 目标在墙前面（不中不是被墙挡的）`, `墙距 ${r.wall} / 目标距 ${r.dist}`);
  }
}

// ── 闸门的边界：正好在上限上要接受，超一拍要拒绝 ──
// 这一条量的是 rewindTick 那道窗的两端：右端是 lastSnapSent（服务端真发出去过的最新一拍），
// 左端是它往前 LAG_MAX_TICKS 拍。探针把 W 取成 3 的倍数 ⇒ lastSnapSent = W，而回溯目标恒为
// 第 44 拍，于是边界正好落在 L = 62/63 这两档上 —— 不是猜的，是 44 ≥ (L+42) − 60 的解。
// 只在上限单侧下断言是不够的：那样"窗被整个删掉"（永远回溯）也会绿。
{
  const edge = shoot(62, 'past', 'past');
  chk(!edge.err && edge.usePast && edge.actual, '边界：正好在上限上 ⇒ 接受并命中',
    `L=62 eff=${edge.err ? '-' : edge.eff} past=${edge.err ? '-' : edge.past} lastSnapSent=${edge.err ? '-' : edge.lastSnapSent} 实测中=${edge.err ? '-' : edge.actual}`);
  const over = shoot(63, 'past', 'past');
  chk(!over.err && !over.usePast && !over.actual, '边界：超上限一拍 ⇒ 拒绝，退化成按当下判（打不中）',
    `L=63 eff=${over.err ? '-' : over.eff} past=${over.err ? '-' : over.past} lastSnapSent=${over.err ? '-' : over.lastSnapSent} 实测中=${over.err ? '-' : over.actual}`);
  // 静态不变式：允许回溯的最深那一格必须**还在环形缓冲里**。否则闸门放行的那些拍里，
  // 有一部分会在 pose.at() 上查不到，于是 shotRewind 静默交回 null —— 表现为"延迟越大
  // 越打不中"，而报表上只会看见一串 miss，看不出是缓冲太短。
  chk(LAG_MAX_TICKS + SNAP_EVERY + 1 <= LAG_HIST, '不变式：回溯上限 + 一个快照节拍 + 1 必须落在缓冲长度之内',
    `${LAG_MAX_TICKS} + ${SNAP_EVERY} + 1 = ${LAG_MAX_TICKS + SNAP_EVERY + 1} ≤ ${LAG_HIST}`);
}

// ── 客户端那一半：报出去的那个拍号 ──
// 为什么这一环必须自己立判据：它错了**不报错**。服务端 rewindTick 把出窗的报值一律拒掉，
// 于是那个玩家永远没有补偿 —— 表现是"这个人在这个服上就是打不中"，而不是任何一条日志。
// 三种失效形状，各自都有一条反证臂：
//   ① 报的是"当下"（INTERP_DELAY 被改成 0、或直接报最新那一包）⇒ 回溯深度 0 拍，补偿等于没开；
//   ② 报的是本机 tick（口径接错）⇒ 与服务端拍号差着一个任意常数 ⇒ 必然撞上闸门的某一端；
//   ③ 报值没有真的进待发包 / 过不了 codec ⇒ 服务端看到的一直是 0（也等于没开）。
// ①的判据写成**恒等式**而不是区间：流水规整时"现在−INTERP_DELAY 落在哪两包之间"是算得准的，
// 区间会让"深度从 6 拍漂到 3 拍"这种系统性变浅蒙混过关（而那正是 INTERP_DELAY 被改小的形状）。
{
  const GRID = 0.05;                       // 下行 20Hz
  const mk = () => {
    const nc = Object.create(NetClient.prototype);
    nc.game = { player: null };            // recordInput 会问一句 player 才决定记不记日记本
    nc.snapLog = []; nc.history = []; nc.pending = [];
    return nc;
  };
  // 规整到达流水：每 GRID 秒一包，拍号每包 +SNAP_EVERY —— 于是时间与拍号是同一个线性关系，
  // 恒等式里的两边可以精确对上（拍号步长 3 = 60 × 0.05，这是它成立的前提，不是巧合）。
  const feed = (nc, n, t0, tick0) => {
    for (let i = 0; i < n; i++) nc.snapLog.push({ t: t0 + i * GRID, tick: tick0 + i * SNAP_EVERY });
    return nc.snapLog[n - 1];
  };

  // ── ① 正常流水：报的是"现在往回退 INTERP_DELAY 之后服务端的那一拍" ──
  const nc = mk();
  const last = feed(nc, 24, 1000, 600);
  const now = last.t + 0.01;               // 刚收完最新一包 10ms：最常见的那一帧
  const v = nc.renderTick(now);
  const spec = last.tick - 60 * (INTERP_DELAY + (last.t - now));
  chk(Math.abs(v - spec) < 1e-6, '① 报的就是"现在−INTERP_DELAY 那一刻的服务端拍号"（恒等式，不是区间）',
    `实测 ${v} / 规格 ${spec}`);
  chk(last.tick - v > SNAP_EVERY, '① 报的是过去：比手上最新那一包至少旧一个快照节拍',
    `旧 ${(last.tick - v).toFixed(2)} 拍（一个快照节拍 = ${SNAP_EVERY}）`);
  // 反证臂：同一个函数在"目标时刻已经晚于最新一包"（本机卡了一帧）时报的是**最新那一拍**，
  // 深度正好 0。所以上面那条不是这个函数白给的 —— 深度是 INTERP_DELAY 挣来的。
  chk(nc.renderTick(last.t + 5) === last.tick, '① 反证臂：目标时刻晚于最新一包 ⇒ 报最新那一拍（深度 0）',
    `${nc.renderTick(last.t + 5)} vs ${last.tick}`);
  // 另一头：目标时刻早于手上最旧一包时报最旧那一拍（不凭空造出比手上还旧的真相）。
  // 这一条是 ④ 的成因所在：规整流水里它不会被走到，攒着处理时它一定会被走到。
  chk(nc.renderTick(1000 - 5) === 600, '① 目标时刻早于最旧一包 ⇒ 报最旧那一拍', `${nc.renderTick(1000 - 5)} vs 600`);

  // ── ③ 接线：报值必须真的进待发包、并且过 codec 往返之后还在 ──
  // 这一段不能用合成时钟：recordInput 内部的 renderTick() 取的是真时钟。所以把流水锚在
  // 真实"现在"上（最后一包到达于 nowR−17ms，使 nowR−INTERP_DELAY 落在两包之间而不是边界上）。
  const nc2 = mk();
  const nowR = performance.now() / 1000;
  for (let i = 0; i < 24; i++) nc2.snapLog.push({ t: nowR - 0.017 - (23 - i) * GRID, tick: 600 + i * SNAP_EVERY });
  const lastR = nc2.snapLog[23];
  nc2.recordInput(300, { mdx: 0, mdy: 0 });
  const pk = nc2.pending[nc2.pending.length - 1];
  // 深度用"我锚的那一对时刻"算：cur 取最新那一包 +1（服务端正产出的那一拍的口径）。
  const depth = (lastR.tick + 1) - (pk ? pk.view : NaN);
  const want = 1 + 60 * (INTERP_DELAY + (lastR.t - nowR));
  chk(pk && Math.abs(depth - want) < 0.75, '③ recordInput 报出去的 view 深度 = 规格算出来的那一拍（±0.75 拍）',
    `深度 ${depth} / 期望 ${want.toFixed(2)}（差 ${(depth - want).toFixed(3)} 拍，含 Math.round 的 0.5）`);
  chk(pk && pk.view === nc2.viewTick, '③ viewTick 就是进包的那个值（没有第二份口径）', `viewTick=${nc2.viewTick} 包内=${pk && pk.view}`);
  const back = pk ? decodeInput(encodeInput(pk)).view : -1;
  chk(back === (pk && pk.view), '③ 过 codec 往返之后还在（服务端真的收得到它）', `${pk && pk.view} → ${back}`);
  chk(rewindTick(back, lastR.tick + 1, lastR.tick) === back, '③ 它算出来的拍号过得了闸门（否则这个玩家永远没有补偿）',
    `rewindTick(${back}, ${lastR.tick + 1}, ${lastR.tick}) → ${rewindTick(back, lastR.tick + 1, lastR.tick)}`);

  // ── ⑤ u16 回绕：报值被 & 0xffff 截断，服务端用 (cur & ~0xffff) 拼回绝对拍号 ──
  // 这条链每 65536 拍（18 分钟）必走一次；接错线的症状是"服务开满 18 分钟之后所有人都打不中"。
  const nc4 = mk();
  const lastW = feed(nc4, 24, 1000, 0x10000 + 600);
  const vw = nc4.renderTick(lastW.t + 0.01);
  const masked = Math.round(vw) & 0xffff;
  chk(rewindTick(masked, lastW.tick + 1, lastW.tick) === Math.round(vw),
    '⑤ 回绕圈里：截断成 u16 再被服务端拼回来，必须回到同一个绝对拍号',
    `绝对 ${Math.round(vw)} → 截断 ${masked} → 拼回 ${rewindTick(masked, lastW.tick + 1, lastW.tick)}`);
  chk(masked !== Math.round(vw), '⑤ 反证臂：这一格确实跨过了 65536（不然上面那条量的不是回绕）', `绝对 ${Math.round(vw)} vs 截断 ${masked}`);

  // ── ④ 消息攒着一起处理：报值会出窗，这是**已知行为**，不是要掩盖的事故 ──
  // 主线程卡过一帧、或刚加载完地图把排队的包一次读完 —— 那时手上最旧那一包的**到达时刻**就是
  // 现在，可它的**拍号**却在一秒多之前。"到达时刻 ≈ 状态产生的时刻"这个前提在这条流水上不成立，
  // 于是目标时刻落到最旧那一格之前，报出去的就是最旧那一格的拍号，比闸门的窗还旧。
  // 服务端一律拒绝（等价于报 0）⇒ 这一小段没有补偿。判据钉的是它的**形状**：
  // 必须出窗、必须被拒，于是它在 /healthz 的 lag.stale 上是可数的 —— 不会静默。
  // （不改：夹到窗沿能换成"错得少一点的补偿"，但那是把"我看到的其实是 1.2 秒前"这个事实
  //   抹成一个假的深度，而服务的对策是拒绝而不是接受一个被伪造过的报值。）
  const nc3 = mk();
  for (let i = 0; i < 24; i++) nc3.snapLog.push({ t: 1000 + 1.15 + i * 0.001, tick: 600 + i * SNAP_EVERY });
  const lastB = nc3.snapLog[23];
  const vb = nc3.renderTick(1000 + 1.16);
  chk(vb === 600, '④ 攒着一起处理 ⇒ 报的是最旧那一格的拍号（不是"最新那一拍"，也不是 0）', `${vb} vs 600`);
  const rej = rewindTick(vb, lastB.tick + 1, lastB.tick);
  chk(rej === -1, '④ 它比闸门的窗还旧 ⇒ 被拒（这一小段退化成"没有补偿"，不是"夹到某个值继续用"）',
    `rewindTick(${vb}, ${lastB.tick + 1}, ${lastB.tick}) = ${rej}（窗左端 ${lastB.tick - LAG_MAX_TICKS}）`);
  chk(rewindTick(vb, lastB.tick + 1, lastB.tick) === rewindTick(0, lastB.tick + 1, lastB.tick),
    '④ 报一个被拒的拍号 ≡ 报 0（所以这条路的代价上限就是"这一小段没有补偿"）',
    `报 ${vb} → ${rej} · 报 0 → ${rewindTick(0, lastB.tick + 1, lastB.tick)}`);
  // 反证臂：同一份流水、同一个函数，只要到达时刻跟着拍号走（正常链路），报值就过闸门。
  // 没有这一条，上面两条可能只是"renderTick 算出来的东西本来就过不了闸门"。
  chk(rewindTick(Math.round(spec), last.tick + 1, last.tick) === Math.round(spec),
    '④ 反证臂：同一函数在正常流水上算出来的报值过得了闸门（不是它天生过不了）',
    `rewindTick(${Math.round(spec)}, ${last.tick + 1}, ${last.tick}) = ${rewindTick(Math.round(spec), last.tick + 1, last.tick)}`);
}

console.log(`\n  ${fails ? '❌' : '✅'} lagcomp：${checks - fails}/${checks} 项通过（${checks} 项断言，${cells.length} 格 × 3 档延迟 + 先决 + 客户端报值）`);
process.exit(fails ? 1 : 0);
