// 联机规则的判据：连杀奖励（充能 → 就绪 → 呼叫 → 生效）、按拍排程、群体警戒、
// 记分与结束，以及"战役检查点/存档不许出现在联机侧"这条隔离。
//
//   node test/mp-rules.mjs
//
// 为什么用**进程内**的房间而不是真 WebSocket（server/net-probe.mjs 那条路）：
// 这一项要量的是"第几拍生效"，而网络与定时器会把拍数搅糊。room.step() 是能直接调
// N 次的 —— 于是"呼叫之后第 84 拍出现第一颗弹"是一条确定性判据，而不是"等 1.4 秒
// 看看有没有"。net-probe 负责证明它在真连接下也活着，这里负责证明它的**时序**是对的。
//
// 每一节都带反证臂。反证臂不是"再跑一遍看看还是绿的"——它是**同一个量具在被测对象
// 坏掉时必须变红**的那一次。下面每条的措辞写的就是"这条红了说明什么坏了"。
import { NetRoom, DT, STREAK_DEFS, resolveStreaks } from '../server/room.mjs';
import { StreakBook, TickClock, MatchRules, killScore, killMedals, KILL_POINTS, UAV_SECONDS, uavFromFlags, onKillPerks } from '../js/match-rules.js';
import { encodeSnapshot, decodeSnapshot } from '../server/codec.mjs';
import { STREAK_NONE, STREAK_MAX, packStreak, unpackStreak, WORLD } from '../js/quant.js';
import { Bot } from '../js/ai.js';
import { KILLSTREAKS } from '../js/data.js';
import * as THREE from 'three';

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label + (extra ? '  ' + extra : '')]); return !!cond; };
const sec = (t) => { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)); };

// ═══════════════════════════════════════════════════════════════════════════
sec('A. 规则内核自证（StreakBook / TickClock / killScore）');
// ═══════════════════════════════════════════════════════════════════════════
// 量具本身先被量一遍：下面所有"联机里生效了"的判据都建立在"槽位簿记是对的"之上，
// 而一块错的量具会让后面每一条都变成恒真绿灯。

{
  const defs = KILLSTREAKS.filter(k => ['uav', 'cluster', 'wp'].includes(k.id));
  const b = new StreakBook(defs, 0);
  ok('A1 槽位按 kills 升序（与按 3/4/5 的顺序一致）', b.ids.join(',') === 'uav,cluster,wp', b.ids.join(','));
  ok('A2 成本 = kills（没有强硬路线时）', b.slots.map(s => s.cost).join(',') === '3,5,10', b.slots.map(s => s.cost).join(','));

  ok('A3 充到 2 时 uav（cost 3）不就绪', b.charge(1).length === 0 && b.charge(1).length === 0 && !b.slots[0].ready, `progress=${b.progress}`);
  ok('A4 第 3 点充能返回"刚就绪的是 0 号槽"', JSON.stringify(b.charge(1)) === '[0]', JSON.stringify(b.charge(0)));
  ok('A5 再充能不能让同一个槽重复就绪', b.charge(1).length === 0 && b.slots[0].ready === true);
  // 反证臂：这条红了 = "就绪"与"成本"脱钩了（比如把 >= 写成了 >，或者成本被算成 1）
  ok('A6【反证】只充 3 时 cluster（cost 5）与 wp（cost 10）都不就绪',
    !b.slots[1].ready && !b.slots[2].ready, `ready=${b.slots.map(s => s.ready).join(',')}`);

  const pBefore = b.progress;
  const took = b.take(0);
  ok('A7 呼叫 0 号槽成功，并把它标成已用', !!took && took.id === 'uav' && b.slots[0].used === true && b.slots[0].ready === false);
  ok('A8 已用的槽再呼叫返回 null', b.take(0) === null);
  ok('A9 越界下标返回 null（不是撞到别的槽）', b.take(99) === null && b.take(-1) === null && b.take(1.5) === null);
  // 进度是**累计量**：只有死亡清它（A11）。呼叫一个槽不该动它 —— 动了的话，
  // "再杀一个人就能凑够下一个槽"这条线会被呼叫本身推走（越用越难拿）。
  ok('A10 呼叫不会清掉进度', b.progress === pBefore, `${pBefore} → ${b.progress}`);

  b.onDeath();
  ok('A11 死亡只清进度、不清槽位（已用的还是已用）', b.progress === 0 && b.slots[0].used === true);

  // 强硬路线：换职业时成本要重算，而且**已经不算数的那一个要退回未就绪**。
  const b2 = new StreakBook(KILLSTREAKS.filter(k => k.id === 'cluster'), 0);
  b2.charge(5);
  ok('A12 充到 5 时 cluster 就绪', b2.slots[0].ready === true);
  b2.setDiscount(1);
  ok('A13 打上强硬路线后成本 5→4，仍然就绪（进度 5 ≥ 4）', b2.slots[0].cost === 4 && b2.slots[0].ready === true, `cost=${b2.slots[0].cost}`);
  const b3 = new StreakBook(KILLSTREAKS.filter(k => k.id === 'cluster'), 1);
  b3.charge(4);
  b3.setDiscount(0);
  // 反证臂：这条红了 = 摘掉强硬路线之后白送了一个奖励（进度 4 < 新成本 5，却还标着就绪）
  ok('A14【反证】摘掉强硬路线后成本 4→5，进度只有 4 ⇒ 必须退回未就绪', b3.slots[0].cost === 5 && b3.slots[0].ready === false, `cost=${b3.slots[0].cost} ready=${b3.slots[0].ready}`);

  const b4 = new StreakBook(KILLSTREAKS.filter(k => k.id === 'uav'), 0);
  b4.charge(3);
  b4.take(0);
  ok('A15 退还未生效的一次消耗（部署点被挡那条路）', b4.refund(b4.slots[0]) === true && b4.slots[0].ready === true && b4.slots[0].used === false);
  ok('A16 退还一个本来就没消耗的槽是空操作（幂等）', b4.refund(b4.slots[0]) === false);

  // TickClock：按拍，而不是按墙钟。
  const cl = new TickClock();
  let hit = 0, at = -1;
  cl.after(5, () => { hit++; at = cl.t; });
  for (let i = 0; i < 4; i++) cl.step(1);
  ok('A17 排在第 5 拍的任务，第 4 拍不触发', hit === 0, `hit=${hit}`);
  cl.step(1);
  ok('A18 第 5 拍触发，且触发时刻就是它该在的那一拍', hit === 1 && at === 5, `hit=${hit} at=${at}`);
  cl.step(10);
  ok('A19 只触发一次（不是每拍都触发）', hit === 1);
  // 反证臂：这条红了 = "暂停期间照样落弹"（setTimeout 那版的病；单机暂停时也会中）
  const cl2 = new TickClock();
  let h2 = 0;
  cl2.after(60, () => h2++);
  for (let i = 0; i < 300; i++) { /* 不 step：模拟暂停的 5 秒 */ }
  ok('A20【反证】不 step 就永远不触发（墙钟走再多也不落弹）', h2 === 0 && cl2.pending === 1, `hit=${h2}`);

  const s = killScore({ head: true, dist: 10, chain: 1 });
  ok('A21 爆头击杀 = 100+50', s.points === 150 && s.tags.join(',') === 'head', `${s.points} [${s.tags}]`);
  const s2 = killScore({ dist: 41, explosive: true });
  // 反证臂：这条红了 = 爆炸击杀被算成远距离（40 m 那条线只对枪械有效）
  ok('A22【反证】爆炸击杀不算远距离（哪怕打了 41 m）', s2.points === 100 && !s2.tags.includes('longshot'), `${s2.points} [${s2.tags}]`);
  const s3 = killScore({ dist: 41, chain: 3 });
  ok('A23 三连杀 + 远距离 = 100 + 50 + 3×50，且带 chain3 标记', s3.points === 300 && s3.tags.includes('chain3'), `${s3.points} [${s3.tags}]`);

  // ── 奖章表：两端画的必须是同一份（单机 js/mp.js:playerKill / 联机 js/main.js:onNetKill）──
  // 这一组量的是"逐条弹窗"这一件事：标签 → 一行字 + 这一条值多少分。判据不能只看
  // "有文案"——那是恒真的（把分值改成 1 也照样有文案）。
  const sc4 = killScore({ head: true, dist: 10, chain: 3, revenge: true });
  ok('A24【先决】这一杀真的攒下了多条奖章（空表的"逐条都对"是句空话）',
    sc4.tags.length === 3 && sc4.tags.includes('head') && sc4.tags.includes('revenge') && sc4.tags.includes('chain3'),
    `[${sc4.tags}]`);
  const md = killMedals(sc4.tags);
  ok('A25 tags → 逐条奖章（顺序与 tags 一致，每条都有文案）',
    md.length === 3 && md[0].label === '爆头' && md[1].label === '复仇' && md[2].label === '三杀', JSON.stringify(md));
  // 命门：弹窗上那个数就是账上加的那个数。抄一份数字的症状是弹窗 "+50"、账上 +25，
  // 两边都觉得自己对 —— 所以这里把"逐条加起来"和 killScore 的总分对死。
  const sum = md.reduce((n, m) => n + m.points, 0) + KILL_POINTS.kill;
  ok('A26 每条奖章的分值 = 账上真加的分（逐条加起来必须等于 killScore 的总分）',
    md.find(m => m.tag === 'head').points === KILL_POINTS.head
    && md.find(m => m.tag === 'revenge').points === KILL_POINTS.revenge
    && md.find(m => m.tag === 'chain3').points === 3 * KILL_POINTS.chain
    && sum === sc4.points, `逐条 ${sum} vs 账上 ${sc4.points}`);
  // 反证臂：这条红了 = 不认识的标签被硬套成了某一行字（"以后加个新标签"就弹出莫名其妙的话），
  // 或者空表/undefined 会把循环跑成抛异常（联机事件里 tags 缺一格就是这种情况）。
  ok('A27【反证】不认识的标签丢掉、空表不出一行也不抛',
    killMedals(['head', 'nuke', 'chain9']).map(m => m.tag).join(',') === 'head'
    && killMedals([]).length === 0 && killMedals(undefined).length === 0,
    JSON.stringify(killMedals(['nuke', 'chain9'])));
}

// ═══════════════════════════════════════════════════════════════════════════
sec('B. 权威端：击杀 → 充能 → 就绪 → 呼叫 → 生效（全链路）');
// ═══════════════════════════════════════════════════════════════════════════

const room = new NetRoom({ id: 'rules', mapId: 'yard', seed: 20260926 });
await room.start();
const A = room.addClient({ name: '甲', team: 'A' });
const B = room.addClient({ name: '乙', team: 'B' });

// 输入喂料器。tick 必须递增 —— applyInput 会把重复包和旧包丢掉（d===0 那条判据）。
let tick = 0;
const feed = (c, streak) => {
  tick++;
  room.applyInput(c.cid, { tick, mdx: 0, mdy: 0, keys: 0, buttons: 0, view: 0, seq: tick & 0xff, streak });
};
const kill = (k, v) => room.game.onKill(k, v, 'm4', false, {});

ok('B1 房间挂上了规则内核，槽位表来自房间配置（默认就是 data.js 的那三项）',
  !!room.rules && room.streakDefs.map(d => d.id).join(',') === 'uav,cluster,heli',
  room.streakDefs.map(d => d.id).join(','));
ok('B2 开局：没有任何连杀奖励在生效，世界标志位是 0',
  room.rules.worldFlags() === 0 && !room.rules.uavActive('A') && !room.rules.uavActive('B'),
  `flags=${room.rules.worldFlags()}`);

// —— 反证臂 ①：不报那一位 ⇒ 永远不就绪、永远不生效 ——
// 先把"只靠击杀"这一段单独量完：3 次击杀只让槽位就绪，不会自己发生效。
kill(A.pl, B.pl); kill(A.pl, B.pl);
ok('B3 2 次击杀时 uav（cost 3）还没就绪', A.book.slots[0].ready === false && A.book.progress === 2, `progress=${A.book.progress}`);

const eventsBefore = room.events.length;
kill(A.pl, B.pl);
const readyEv = room.events.find(e => e.e === 'streakReady');
ok('B4 第 3 次击杀让 uav 就绪，并且下发了一条 streakReady 事件',
  A.book.slots[0].ready === true && !!readyEv && readyEv.cid === A.cid && readyEv.slot === 0,
  readyEv ? `slot=${readyEv.slot} id=${readyEv.id}` : '没有事件');
ok('B5【反证】就绪不等于生效：此时 UAV 还没上线（生效必须经由呼叫那一位）',
  room.rules.uavActive('A') === false && room.rules.worldFlags() === 0 && room.streak.calls === 0,
  `calls=${room.streak.calls} flags=${room.rules.worldFlags()}`);

// —— 反证臂 ②：报一个没就绪的槽 ⇒ 不生效，且记成 rejected ——
feed(A, STREAK_NONE);
room.step();
feed(A, 1);                       // 1 号槽是 cluster（cost 5），此刻只有 3 杀
room.step();
ok('B6【反证】呼叫一个没就绪的槽：服务端不接受，且这一条是可归因的读数（rejected）',
  room.streak.calls === 1 && room.streak.accepted === 0 && room.streak.rejected === 1 && !room.rules.uavActive('A'),
  `calls=${room.streak.calls} acc=${room.streak.accepted} rej=${room.streak.rejected}`);

feed(A, STREAK_MAX - 1);          // 7 号槽：协议内合法、但这局根本没有这个槽
room.step();
ok('B7【反证】呼叫一个不存在的槽下标：同样被拒（报了个数字 ≠ 生效）',
  room.streak.calls === 2 && room.streak.rejected === 2, `rej=${room.streak.rejected}`);

// —— 正臂：报对了那一位，真的生效 ——
feed(A, 0);
room.step();
ok('B8 呼叫 0 号槽（uav）被接受', room.streak.calls === 3 && room.streak.accepted === 1, `acc=${room.streak.accepted}`);
ok('B9 UAV 真的上线了，且世界标志位带上了 A 队那一位',
  room.rules.uavActive('A') === true && (room.rules.worldFlags() & WORLD.UAV) !== 0,
  `flags=${room.rules.worldFlags()}`);
ok('B10 队伍划分没串：A 队的 UAV 不会让 B 队也看见',
  uavFromFlags(room.rules.worldFlags(), 'A') === true && uavFromFlags(room.rules.worldFlags(), 'B') === false);
// 反证臂：这条红了 = 同一个槽被连点了（"同一份输入被多跑几拍"那个坑的形状）
feed(A, 0);
room.step();
ok('B11【反证】同一个槽再呼叫一次：被拒（已用），UAV 的剩余时间不叠加',
  room.streak.rejected === 3 && room.rules.uavLeft('A') < UAV_SECONDS * 60,
  `left=${room.rules.uavLeft('A')}/${UAV_SECONDS * 60} rej=${room.streak.rejected}`);

// —— 事件下发：客户端靠它做表现 ——
const evs = room.events;
ok('B12 呼叫之后下发了给客户端看的 streak 事件（含 id 与队）',
  evs.some(e => e.e === 'streak' && e.cid === A.cid && e.id === 'uav' && e.team === 'A'),
  JSON.stringify(evs.filter(e => e.e === 'streak').slice(0, 2)));
ok('B13 空呼叫（streak 位 = 0xff）不会产生任何呼叫读数',
  (() => { const n = room.streak.calls; feed(A, STREAK_NONE); room.step(); feed(A, STREAK_NONE); room.step(); return room.streak.calls === n; })(),
  `calls=${room.streak.calls}`);

// —— 反证臂：这一局没带的那一项，报它一定被拒 ——
// 默认的槽位表是 uav/cluster/heli（三个），所以下标 3 在本房里**不存在**。
// 这条红了 = 服务端按"全局的 KILLSTREAKS 表"而不是"本房的槽位表"裁决，
// 那会让玩家按出一个这一局根本没配的奖励。
feed(A, 3);
room.step();
ok('B11b【反证】报一个本房没配的槽位下标：被拒（裁决用的是本房的槽位表）',
  room.streak.calls === 5 && room.streak.rejected === 4,
  `calls=${room.streak.calls} rej=${room.streak.rejected}`);

// —— 死亡清进度但不清已就绪的槽（COD 的规矩）——
kill(B.pl, A.pl);
ok('B14 被杀之后连杀进度清零，但 UAV 还在天上（已就绪/已用不因死亡消失）',
  A.book.progress === 0 && room.rules.uavActive('A') === true, `progress=${A.book.progress}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('C. 按拍排程：集束空袭（把"1.4 秒"钉成"第 84 拍"）');
// ═══════════════════════════════════════════════════════════════════════════
// 这一节的量具是**弹数**与**拍号**，两个都是整数 —— 所以它可以写成恒等式，
// 而不是"大概到了一定程度"。

const roomC = new NetRoom({ id: 'rules-c', mapId: 'yard', seed: 20260926 });
await roomC.start();
const CA = roomC.addClient({ name: '甲', team: 'A' });
const CB = roomC.addClient({ name: '乙', team: 'B' });
for (let i = 0; i < 5; i++) roomC.game.onKill(CA.pl, CB.pl, 'm4', false, {});
ok('C1 5 杀之后 cluster（cost 5）就绪、wp（cost 10）还没', CA.book.slots[1].ready === true && CA.book.slots[2].ready === false);

// 集束空袭走**选点确认**那条窄帧（{t:'streak'} 带落点，见 NetRoom.requestStreak），
// 排程时序从确认那一刻起算 —— 与单机"点下左键那一刻"同一起点。
roomC.requestStreak(CA.cid, 1, { x: CA.pl.pos.x, z: CA.pl.pos.z - 12 });
const t0 = roomC.tick;
ok('C2 呼叫被接受', roomC.streak.accepted === 1 && roomC.streak.byId.cluster === 1, JSON.stringify(roomC.streak.byId));
ok('C3 呼叫那一刻还没有弹（落点算好了，但投放时刻还没到）', roomC.game.projectiles.length === 0, `n=${roomC.game.projectiles.length}`);

for (let i = 0; i < 83; i++) roomC.step();
ok('C4 第 83 拍仍然没有弹（第 84 拍才投第一颗）', roomC.game.projectiles.length === 0, `Δtick=${roomC.tick - t0} n=${roomC.game.projectiles.length}`);

roomC.step();
ok('C5 第 84 拍第一颗弹出现', roomC.game.projectiles.length === 1, `Δtick=${roomC.tick - t0} n=${roomC.game.projectiles.length}`);

// 九颗的投放时刻：84 + round(i×6.6) ⇒ 最后一颗在第 84+53 = 137 拍
while (roomC.tick - t0 < 137) roomC.step();
ok('C6 第 137 拍九颗投完（84 + round(8×6.6)）', roomC.game.projectiles.length === 9, `Δtick=${roomC.tick - t0} n=${roomC.game.projectiles.length}`);
// 反证臂：这条红了 = 排程变成了嵌套（或者被 setTimeout 那种墙钟接管了），
// 形状是"第 138 拍才齐"或"某一次 step 一下子冒出好几颗"
roomC.step();
ok('C7【反证】第 138 拍不会再冒出第 10 颗（排的就是 9 颗）', roomC.game.projectiles.length === 9, `n=${roomC.game.projectiles.length}`);

// —— 反证臂：没呼叫就永远不会有弹 ——
const roomD = new NetRoom({ id: 'rules-d', mapId: 'yard', seed: 20260926 });
await roomD.start();
const DA = roomD.addClient({ name: '甲', team: 'A' });
const DB = roomD.addClient({ name: '乙', team: 'B' });
for (let i = 0; i < 5; i++) roomD.game.onKill(DA.pl, DB.pl, 'm4', false, {});
for (let i = 0; i < 200; i++) roomD.step();
// 这条红了 = 规则被"充能"直接触发（没有经由呼叫那一位），联机里就是"人人自动挨炸"
ok('C8【反证】充到就绪但从不呼叫 ⇒ 200 拍里一颗弹都没有', roomD.game.projectiles.length === 0 && roomD.rules.clock.fired === 0, `n=${roomD.game.projectiles.length} fired=${roomD.rules.clock.fired}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('D. 白磷弹：计时器归规则、即时灼烧与落火归共用那段');
// ═══════════════════════════════════════════════════════════════════════════

const roomE = new NetRoom({ id: 'rules-e', mapId: 'yard', seed: 20260926, streaks: ['uav', 'cluster', 'wp'] });
await roomE.start();
const EA = roomE.addClient({ name: '甲', team: 'A' });
const EB = roomE.addClient({ name: '乙', team: 'B' });
let tickE = 0;
for (let i = 0; i < 10; i++) roomE.game.onKill(EA.pl, EB.pl, 'm4', false, {});
ok('D1 10 杀之后 wp 就绪', EA.book.slots.find(s => s.id === 'wp').ready === true);
tickE++;
roomE.applyInput(EA.cid, { tick: tickE, mdx: 0, mdy: 0, keys: 0, buttons: 0, view: 0, seq: 1, streak: 2 });
roomE.step();
ok('D2 呼叫白磷弹被接受', roomE.streak.byId.wp === 1, JSON.stringify(roomE.streak.byId));
ok('D3 白磷弹的计时器被规则内核点上（世界标志位置位）',
  roomE.rules.wpTicks > 0 && (roomE.rules.worldFlags() & WORLD.WhitePhosphorus) !== 0,
  `wpTicks=${roomE.rules.wpTicks} flags=${roomE.rules.worldFlags()}`);
ok('D4 白磷弹的落火排了 12 个任务（spread 默认值）', roomE.rules.clock.pending >= 12, `pending=${roomE.rules.clock.pending}`);
const flags0 = roomE.rules.worldFlags();
for (let i = 0; i < 10 * 60 + 2; i++) roomE.step();
// 反证臂：这条红了 = 计时器没人推进（标志位永远亮着，屏幕效果永远不消）
ok('D5【反证】10 秒之后标志位自己熄掉（计时是按拍推进的，不是一次性的）',
  roomE.rules.wpTicks === 0 && (roomE.rules.worldFlags() & WORLD.WhitePhosphorus) === 0,
  `flags 前=${flags0} 后=${roomE.rules.worldFlags()}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('E. 群体警戒（alertGroup）：把"静默失效"接回来');
// ═══════════════════════════════════════════════════════════════════════════

const roomF = new NetRoom({ id: 'rules-f', mapId: 'yard', seed: 20260926 });
await roomF.start();
const FA = roomF.addClient({ name: '甲', team: 'A' });
const w = roomF.game.world;
const spFoe = w.spawns.B[0] || w.randomWalkable();
const mkBot = (group, i) => new Bot(roomF.game, {
  team: 'B', name: '哨兵' + i, style: 'enemy', weaponId: 'ak', att: {}, difficulty: 1,
  pos: spFoe.clone().add(new THREE.Vector3(i * 0.9, 0, 0)), yaw: 0, role: 'guard', group,
});
const b1 = roomF.addBot(mkBot('outpost', 0));
const b2 = roomF.addBot(mkBot('outpost', 1));
const b3 = roomF.addBot(mkBot('village', 2));
ok('E1 机器人都挂上了 game.bots（联机侧以前根本不放 AI，这条通道是空的）',
  roomF.game.bots.length === 3 && roomF.bots.size === 3, `game.bots=${roomF.game.bots.length}`);
ok('E2 先决：还没警戒过', b1.alerted === false && b2.alerted === false && roomF.alertSpread === 0);

// 走**真链路**：game.alertGroup（HeadlessGame 转发）→ mode.alertGroup（NetRoom）。
// 这条正是以前断掉的那一跳 —— 调用点被 `game.alertGroup &&` 守卫挡着，缺了实现在
// 两边都不报错，只是"整组敌人不会一起警戒"。
const r1 = roomF.game.alertGroup('outpost', FA.pl.pos);
ok('E3 走 game.alertGroup 这一跳：整组（2 人）一起警戒了',
  r1.n === 2 && b1.alerted === true && b2.alerted === true && roomF.alertSpread === 2,
  `n=${r1.n} spread=${roomF.alertSpread}`);
// 反证臂：这条红了 = 扩散是"给所有人打招呼"（漏了按 group 过滤），
// 症状是"打前哨站的时候全村人都知道你来了"，而潜行玩法的整条设计就废了。
ok('E4【反证】另一个分组的人没有被惊动（扩散是按 group 的，不是给所有人）',
  b3.alerted === false && r1.first === true);
const r2 = roomF.game.alertGroup('outpost', FA.pl.pos);
ok('E5 同一组再来一次：还是扩散 2 人，但 first 已经是 false（上层据此决定要不要播报）',
  r2.n === 2 && r2.first === false && roomF.alertSpread === 4, `first=${r2.first} spread=${roomF.alertSpread}`);
// 反证臂：这条红了 = alertGroup 被某种理由整体关掉了（比如 mode 上没有这个方法），
// 那会退回"静默失效"：n 恒为 0，而没有任何一条别的判据会红。
ok('E6【反证】空分组 / 空坐标是空操作，不会把整局人一次惊动',
  roomF.game.alertGroup(null, FA.pl.pos) === undefined || roomF.alertSpread === 4,
  `spread=${roomF.alertSpread}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('F. 世界标志位：协议往返 + 不复用（一个字节要装下四件事）');
// ═══════════════════════════════════════════════════════════════════════════

const roomG = new NetRoom({ id: 'rules-g', mapId: 'yard', seed: 20260926 });
await roomG.start();
const GA = roomG.addClient({ name: '甲', team: 'A' });
const GB = roomG.addClient({ name: '乙', team: 'B' });

const snapOf = () => roomG.snapshot();
const flagsAt = () => snapOf().worldFlags;
ok('F1 开局标志位 0', flagsAt() === 0);
roomG.rules.uavStart('A');
ok('F2 A 队 UAV ⇒ 位 2', (flagsAt() & WORLD.UAV) !== 0 && (flagsAt() & WORLD.UAV_B) === 0, `flags=${flagsAt()}`);
roomG.rules.uavStart('B');
ok('F3 A+B 都有 UAV ⇒ 两个位都在（不是互相顶掉）',
  (flagsAt() & WORLD.UAV) !== 0 && (flagsAt() & WORLD.UAV_B) !== 0, `flags=${flagsAt()}`);
roomG.rules.wpTicks = 60;
ok('F4 白磷弹位与 UAV 位互不干扰（同一拍里能同时亮）',
  (flagsAt() & WORLD.WhitePhosphorus) !== 0 && (flagsAt() & WORLD.UAV) !== 0, `flags=${flagsAt()}`);
roomG.rules.forceEnd('A');
ok('F5 对局结束位置上', (flagsAt() & WORLD.MatchOver) !== 0, `flags=${flagsAt()}`);

// 协议往返：这一个字节要真的能到客户端，而不是只在服务端对象里对。
const snap = snapOf();
const enc = encodeSnapshot({ ...snap, seq: 1 });
const back = decodeSnapshot(enc.view);
ok('F6 worldFlags 走完整编解码后原样（u8 的每一位都活着）',
  back.worldFlags === snap.worldFlags && back.worldFlags === flagsAt(),
  `前=${snap.worldFlags} 后=${back.worldFlags}`);
// 反证臂：这条红了 = 那一个字节在链路上被别的东西挤掉了（比如某次加字段时按位或写错）
for (const v of [0, WORLD.UAV, WORLD.UAV_B, WORLD.WhitePhosphorus, WORLD.MatchOver, 0xff]) {
  const rt = decodeSnapshot(encodeSnapshot({ ...snap, worldFlags: v, seq: 1 }).view).worldFlags;
  if (rt !== v) { ok(`F7【反证】flags ${v} 往返失真（读到 ${rt}）`, false); break; }
}
ok('F7【反证】六个边界值（含 0xff 全亮）往返全部原样', true);

// ═══════════════════════════════════════════════════════════════════════════
sec('G. 隔离：战役检查点与存档不许出现在联机侧');
// ═══════════════════════════════════════════════════════════════════════════
// 检查点属于单机战役（js/campaign.js）。联机这一侧要证明的是"它进不来"——
// 权威端一旦能回档/能写玩家的档，就是"服务端可以被玩家改写进度"的漏洞形状。

ok('G1 NetRoom 上没有检查点路径', !('setCheckpoint' in roomG) && !('checkpoint' in roomG));
ok('G2 HeadlessGame（权威 game）上没有检查点路径',
  !('setCheckpoint' in roomG.game) && !('checkpoint' in roomG.game) && !('checkpoint' in roomG.game.profile));
// 反证臂：这条红了 = 权威端跑了 N 拍之后自己动了玩家的经验值（联机里玩家能刷档）
const xp0 = roomG.game.profile.xp;
for (let i = 0; i < 120; i++) roomG.step();
ok('G3【反证】跑 120 拍之后玩家存档里的经验值一个数都没动', roomG.game.profile.xp === xp0, `xp=${roomG.game.profile.xp}`);
const saved0 = roomG.game.profileSaved | 0;
roomG.game.saveProfile();
ok('G4 saveProfile 在权威端只是计数，不落盘', (roomG.game.profileSaved | 0) === saved0 + 1);

// ═══════════════════════════════════════════════════════════════════════════
sec('H. 上行那一位：代码表两端一致 + 全量程');
// ═══════════════════════════════════════════════════════════════════════════

ok('H1 packStreak(-1) = 0xff（"没按"的编码）', packStreak(-1) === STREAK_NONE, `0x${packStreak(-1).toString(16)}`);
ok('H2 合法下标原样', [0, 1, 2, 7].every(i => packStreak(i) === i && unpackStreak(packStreak(i)) === i));
// 反证臂：这条红了 = 乱报的客户端能碰到槽位（比如 8 被当成下标 0 之外的东西）
// 或者 -1 与 0 混成一个值（那样"没按"会变成"呼叫第 0 个槽"，按住不放就会不停叫 UAV）
ok('H3【反证】越界值与 0xff 一律落到"没请求"，不会与下标 0 混起来',
  packStreak(8) === STREAK_NONE && packStreak(99) === STREAK_NONE && packStreak(1.5) === STREAK_NONE && unpackStreak(STREAK_NONE) === -1 && packStreak(0) === 0);
ok('H4 "没请求"与"呼叫 0 号槽"是两个不同的字节', packStreak(-1) !== packStreak(0));

// ═══════════════════════════════════════════════════════════════════════════
sec('I. 连杀选单：每人自带三项（白名单重建 + 一人一本账）');
// ═══════════════════════════════════════════════════════════════════════════

{
  const ids = (list) => resolveStreaks(list).map(d => d.id).join(',');
  ok('I1 没带选单 = 默认三项（按 kills 升序）', ids(null) === 'uav,cluster,heli', ids(null));
  ok('I2 自带的三项都在，且按 kills 升序排（槽位下标靠同一个顺序两端对齐）',
    ids(['wp', 'sentry', 'uav']) === 'uav,sentry,wp', ids(['wp', 'sentry', 'uav']));
  // 反证臂：这条红了 = 闸门只查了"每个 id 合不合法"、没限 3 项 —— 报 5 项的人
  // 会拿到 5 个槽，而按 3/4/5 的上行只有 3 个下标，第 4、5 项能带进局却永远叫不出来。
  ok('I3【反证】报 5 项只认 3 个', ids(['uav', 'cluster', 'sentry', 'heli', 'wp']) === 'uav,cluster,sentry',
    ids(['uav', 'cluster', 'sentry', 'heli', 'wp']));
  // 反证臂：这条红了 = 非法项被原样挂上（账上出现 undefined 槽），
  // 或者整组退回默认（玩家精心选的另两项被一个过期 id 连坐）。
  ok('I4【反证】非法项与重复项被换掉而不是挂上/连坐（补进来的默认项也一起升序）', ids(['uav', 'uav', '不存在', 'wp']) === 'uav,cluster,wp',
    ids(['uav', 'uav', '不存在', 'wp']));
}

{
  const roomI = new NetRoom({ id: 'pick', mapId: 'yard', seed: 20260926 });
  await roomI.start();
  const C = roomI.addClient({ name: '丙', team: 'A', streaks: ['wp', 'sentry', 'uav'] });
  const D = roomI.addClient({ name: '丁', team: 'B' });
  ok('I5 带了选单的人，账本上的槽就是他选的那三项（升序）',
    C.streakDefs.map(d => d.id).join(',') === 'uav,sentry,wp' && C.book.ids.join(',') === 'uav,sentry,wp',
    `defs=${C.streakDefs.map(d => d.id).join(',')} book=${C.book.ids.join(',')}`);
  ok('I6 没带的人用房间默认表兜底（不是空账）',
    D.streakDefs.map(d => d.id).join(',') === 'uav,cluster,heli', D.streakDefs.map(d => d.id).join(','));
  // 反证臂：这条红了 = 一本账被全房共享（甲选的槽出现在乙的账上），症状是
  // "HUD 画的是我选的三项，按 3/4/5 出来的却是别人那一套"。
  ok('I7【反证】一人一本账：两本槽位表互不串，且账本与回显同一顺序',
    C.book.ids.join(',') !== D.book.ids.join(',') && C.book.ids.join(',') === C.streakDefs.map(d => d.id).join(','),
    `C=${C.book.ids.join(',')} D=${D.book.ids.join(',')}`);
  // 反证臂：这条红了 = 账本建在"解析之前"（比如直接拿上报的数组建账），
  // 越权的第 4 项会真的变成一个能叫的槽。
  const E = roomI.addClient({ name: '戊', team: 'A', streaks: ['wp', 'sentry', 'uav', 'cluster', 'heli'] });
  ok('I8【反证】报了 5 项的人进局也只有 3 个槽', E.book.length === 3, `len=${E.book.length}`);
  roomI.step();
}

// ═══════════════════════════════════════════════════════════════════════════
sec('J. 集束空袭选点：取消不扣槽、落点跟上报的点走');
// ═══════════════════════════════════════════════════════════════════════════
// 量具是**投放起点**（弹出生那一拍的位置，9 颗都看得到）。不用"弹落点"是因为落点
// 依赖地形与私有常数，而投放起点的**垂线分量**是常数无关的：投放点在"落点后方 25 m"
// 只挪沿轴线的分量，垂线分量恒等于落点的垂线分量。

const roomJ = new NetRoom({ id: 'rules-j', mapId: 'yard', seed: 20260926 });
await roomJ.start();
const JA = roomJ.addClient({ name: '甲', team: 'A' });
const JB = roomJ.addClient({ name: '乙', team: 'B' });
for (let i = 0; i < 5; i++) roomJ.game.onKill(JA.pl, JB.pl, 'm4', false, {});
ok('J1 先决：5 杀之后 cluster 就绪、还没被用过', JA.book.slots[1].ready === true && JA.book.slots[1].used === false);

// —— 反证臂①：按键上行那条路不再触发集束，而且**槽不消耗** ——
let tickJ = 0;
const feedJ = (streak) => {
  tickJ++;
  roomJ.applyInput(JA.cid, { tick: tickJ, mdx: 0, mdy: 0, keys: 0, buttons: 0, view: 0, seq: tickJ & 0xff, streak });
};
feedJ(1); roomJ.step();
ok('J2【反证】按键那一位报到集束槽：被拒且槽没被扣掉（"取消/乱按不扣槽"，旧的"按下即消耗"）',
  roomJ.streak.rejected === 1 && JA.book.slots[1].ready === true && JA.book.slots[1].used === false,
  `rej=${roomJ.streak.rejected} ready=${JA.book.slots[1].ready} used=${JA.book.slots[1].used}`);

// —— 反证臂②：确认帧不带落点 / 落点超界 ⇒ 同样拒、同样不扣槽 ——
roomJ.requestStreak(JA.cid, 1, null);
ok('J3【反证】确认帧没带落点：被拒不扣槽', roomJ.streak.rejected === 2 && JA.book.slots[1].ready === true && JA.book.slots[1].used === false);
roomJ.requestStreak(JA.cid, 1, { x: JA.pl.pos.x + 500, z: JA.pl.pos.z });
ok('J4【反证】落点超出射程上限（500 m > 200 m）：被拒不扣槽',
  roomJ.streak.rejected === 3 && JA.book.slots[1].ready === true && JA.book.slots[1].used === false);

// —— 正臂：带落点确认 → 生效、槽被扣、弹幕围着上报的那一点 ——
// yaw=1 是挑过的：这个角度下"旧的固定落点（面前 22 m）"与上报点的垂线分量差 5 m、
// 而旧轴线与新轴线（单机的 yaw+π/2）差 65° —— 两种回归形态各有一条判据能红。
const yaw = 1.0;
JA.pl.yaw = yaw;
const dirX = Math.cos(yaw + Math.PI / 2), dirZ = Math.sin(yaw + Math.PI / 2);
const px = -dirZ, pz = dirX;                                   // 轴线的垂线
const perp = (x, z) => x * px + z * pz;
// 垂线方向挪 35 m：与"旧的固定落点（面前 22 m，垂线分量偏 20 m）"拉开 15 m —— 
// 两条判据各自的容错（1.5 / 3）都远小于这个间距。
const TJ = { x: JA.pl.pos.x + px * 35, z: JA.pl.pos.z + pz * 35 };
roomJ.requestStreak(JA.cid, 1, TJ);
ok('J5 带落点的确认被接受，槽被消耗', roomJ.streak.accepted === 1 && roomJ.streak.byId.cluster === 1 && JA.book.slots[1].used === true,
  `acc=${roomJ.streak.accepted} rej=${roomJ.streak.rejected}`);

const seen = new Map();
for (let i = 0; i < 200 && seen.size < 9; i++) {
  roomJ.step();
  for (const p of roomJ.game.projectiles) if (!seen.has(p)) seen.set(p, { x: p.pos.x, z: p.pos.z });
}
const list = [...seen.values()];
const mean = list.reduce((a, v) => ({ x: a.x + v.x / list.length, z: a.z + v.z / list.length }), { x: 0, z: 0 });
ok('J6 九颗弹的投放点垂线分量 ≈ 上报落点（抖动 ±1.5 的余量）',
  seen.size === 9 && Math.abs(perp(mean.x, mean.z) - perp(TJ.x, TJ.z)) < 1.5,
  `n=${seen.size} Δ=${(perp(mean.x, mean.z) - perp(TJ.x, TJ.z)).toFixed(2)}`);
// 反证臂：这条红了 = 落点退回"呼叫者视线前方 22 m"那个固定点（垂线分量挪回20 m 附近）
const oldPerp = perp(JA.pl.pos.x - Math.sin(yaw) * 22, JA.pl.pos.z - Math.cos(yaw) * 22);
ok('J7【反证】投放点不在旧的固定落点上（红了 = 回退成视线前方固定落点）',
  Math.abs(perp(mean.x, mean.z) - oldPerp) > 3, `Δ=${(perp(mean.x, mean.z) - oldPerp).toFixed(2)}`);
// 反证臂②：投放轴线的方向必须与单机同式（yaw+π/2）。红了 = 有人把角度又改回 atan2
// （与单机差一个镜像，弹从反方向飞来 —— 没人会去量它）。
const v0 = list[0], v8 = list[8];
const ax = v8.x - v0.x, az = v8.z - v0.z, al = Math.hypot(ax, az) || 1;
ok('J8【反证】投放轴线 = 单机那条（yaw + π/2）', Math.abs((ax / al) * dirZ - (az / al) * dirX) < 0.3,
  `cross=${((ax / al) * dirZ - (az / al) * dirX).toFixed(3)}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('K. 终局结算：胜负分 + 逐人战绩（结算面板的数从哪儿来）');
// ═══════════════════════════════════════════════════════════════════════════

const roomK = new NetRoom({ id: 'rules-k', mapId: 'yard', seed: 20260926 });
await roomK.start();
const KA = roomK.addClient({ name: '甲', team: 'A', account: 'hero' });
const KB = roomK.addClient({ name: '乙', team: 'B', account: 'rival' });
const KG = roomK.addClient({ name: '丙', team: 'B' });            // 访客（没有 account）
for (let i = 0; i < 3; i++) roomK.game.onKill(KA.pl, KB.pl, 'm4', false, {});
roomK.game.onKill(KB.pl, KA.pl, 'm4', true, {});
ok('K1 先决：甲 3 杀 1 死、乙 1 杀 3 死、访客没有档案',
  KA.kills === 3 && KA.deaths === 1 && KB.kills === 1 && KB.deaths === 3 && KG.account == null,
  `A=${KA.kills}/${KA.deaths} B=${KB.kills}/${KB.deaths}`);

roomK.endMatch('A');
const KK = roomK.takeResults()[0];
const hero = KK.rows.find(r => r.account === 'hero');
const rival = KK.rows.find(r => r.account === 'rival');
ok('K2 赢家的档案经验 = 得分 + 500（与单机 js/mp.js:end 同一条式子）',
  !!hero && hero.win === true && hero.xp === Math.round(KA.score) + 500, JSON.stringify(hero));
// 反证臂：这条红了 = 平/负没拿那 150 —— "打一晚上比单机慢一大截"就是这一格丢了
ok('K3【反证】平/负那 150 在（不是只有赢家有胜负分）',
  !!rival && rival.win === false && rival.xp === Math.round(KB.score) + 150, JSON.stringify(rival));
ok('K4 访客不进档案队列（没有档案可写），但也不该报错',
  KK.rows.length === 2 && KK.rows.every(r => r.account), JSON.stringify(KK.rows.map(r => r.account)));

const kEvs = roomK.events;
const kStats = kEvs.filter(e => e.e === 'matchStats');
const iOver = kEvs.findIndex(e => e.e === 'matchOver');
ok('K5 终局个人战绩每人一条，且先于 matchOver（面板在终局那一刻就有数可画）',
  kStats.length === 3 && kStats.every(e => Number.isFinite(e.k) && Number.isFinite(e.d) && Number.isFinite(e.s))
  && kStats.findIndex(e => e.cid === KA.cid) < iOver && iOver >= 0,
  JSON.stringify(kStats));
// 反证臂：这条红了 = 面板上那一行 k/d 只能拿本地预测的 pl.stats.kills 画 ——
// 联机里那个数恒 0（击杀是服务端裁的），结算画出来是"0/0 的赢家"。
const kaS = kStats.find(e => e.cid === KA.cid);
ok('K6【反证】matchStats 里的数就是权威端的账（3/1/得分）',
  !!kaS && kaS.k === 3 && kaS.d === 1 && kaS.s === Math.round(KA.score), JSON.stringify(kaS));

// 平局：winner=null 时两队都记"没赢"，各自拿 150 —— 不许拿进球的队去猜赢家。
const roomK2 = new NetRoom({ id: 'rules-k2', mapId: 'yard', seed: 20260926 });
await roomK2.start();
const K2A = roomK2.addClient({ name: '甲', team: 'A', account: 'hero2' });
roomK2.game.onKill(K2A.pl, K2A.pl, 'm4', false, {});   // 自杀：谁都不赢
roomK2.endMatch(null);
const K2R = roomK2.takeResults()[0].rows[0];
ok('K7【反证】winner=null 的那局：win=false、经验 = 得分 + 150（平局不许记成胜场）',
  K2R.win === false && K2R.xp === Math.round(K2A.score) + 150, JSON.stringify(K2R));

// ═══════════════════════════════════════════════════════════════════════════
sec('L. Perk 在权威端生效：拾荒者 / 速愈 / 幽灵 / 高度警觉');
// ═══════════════════════════════════════════════════════════════════════════
// 以前这四项在联机里全是空转（规则长在 MPMatch / ai.js 的 hud 调用里，权威端够不着）。
// 这一节量的是**权威端那份状态**：弹药/血量在服务端真的变了、报点真的跳过了幽灵、
// 瞄准真的发出了事件。客户端屏幕上的那份镜像（弹药计数、弹窗）由 net-play 的真浏览器验。

const KITP = (perks) => ({ primary: { id: 'm4', att: {}, camo: 'none' }, secondary: { id: 'm1911', att: {}, camo: 'none' }, lethal: 'frag', tactical: 'flash', perks });

const KL = new NetRoom({ id: 'rules-l', mapId: 'yard', seed: 20260926 });
await KL.start();
const LP = KL.addClient({ name: '拾荒者', team: 'A', loadout: KITP(['scavenger', 'quickfix']) });
const EN = KL.addClient({ name: '敌人', team: 'B' });
LP.pl.hp = 50; LP.pl.dmgT = 0;
KL.game.onKill(LP.pl, EN.pl, 'm4', false, {});
ok('L1 速愈：击杀回 40 血、回血计时归位（权威端的血）', LP.pl.hp === 90 && LP.pl.dmgT === 99, `hp=${LP.pl.hp} dmgT=${LP.pl.dmgT}`);

const reserve = (pl) => pl.ws.slots.reduce((s, w) => s + w.reserve, 0);
// 先把致命装备用掉再杀：开局就是满的（2/2），满着不动才是对的行为（不许溢出）。
LP.pl.lethal.count = 0;
const rBefore = reserve(LP.pl), lBefore = (LP.pl.lethal && LP.pl.lethal.count) | 0;
KL.game.onKill(LP.pl, EN.pl, 'm4', false, {});
ok('L2 拾荒者：击杀补储备弹药（权威端的弹药）', reserve(LP.pl) > rBefore, `${rBefore} → ${reserve(LP.pl)}`);
ok('L3 拾荒者：致命装备 +1（用掉之后补一枚，不许溢出上限）', !!LP.pl.lethal && LP.pl.lethal.count === lBefore + 1, `${lBefore} → ${LP.pl.lethal && LP.pl.lethal.count}`);

// 返回值的契约：文案归表现层（客户端镜像靠 texts 画弹窗），机制归这里。
const stub = { hasPerk: (id) => id === 'scavenger', ws: { refill: () => { stub.refilled = true; } }, lethal: { count: 0, max: 2 }, maxHp: 100, hp: 100, dmgT: 0 };
const pkOut = onKillPerks(stub);
ok('L4 onKillPerks 的返回契约：文案给表现层、refill 记在返回里',
  pkOut.texts.length === 1 && pkOut.refill === 0.35 && stub.refilled === true, JSON.stringify(pkOut));

// —— 幽灵：UAV 报点跳过带幽灵的敌人 ——
const KGH = new NetRoom({ id: 'rules-l2', mapId: 'yard', seed: 20260926 });
await KGH.start();
const GhostP = KGH.addClient({ name: '幽灵', team: 'B', loadout: KITP(['ghost']) });
const CivP = KGH.addClient({ name: '平民', team: 'B', loadout: KITP(['eod']) });
const botG = KGH.spawnBot({ name: '哨兵', team: 'A', skill: 1 });
botG.perceiveT = 1e9;                       // 感知冻住：这一条量的是报点本身，不是它找人的本事
GhostP.pl.pos.copy(botG.pos.clone().add(new THREE.Vector3(3, 0, 0)));
CivP.pl.pos.copy(botG.pos.clone().add(new THREE.Vector3(8, 0, 0)));
KGH.rules.uavStart('A');
KGH.step();
ok('L5 幽灵：UAV 报点跳过带幽灵的敌人（报给更远的那个）',
  !!botG.lastSeenPos && botG.lastSeenPos.distanceTo(CivP.pl.pos) < 1,
  botG.lastSeenPos ? `→ ${botG.lastSeenPos.distanceTo(CivP.pl.pos).toFixed(1)}m@平民` : '没有报点');
// 反证臂：这条红了 = 报点这一路整个没接（或者过滤写成了"全跳过"）
GhostP.pl.perks.delete('ghost');
KGH.uavPing = -1;
KGH.step();
ok('L6【反证】没有幽灵时报的是更近的那个（报点本身没坏）',
  !!botG.lastSeenPos && botG.lastSeenPos.distanceTo(GhostP.pl.pos) < 1,
  botG.lastSeenPos ? `→ ${botG.lastSeenPos.distanceTo(GhostP.pl.pos).toFixed(1)}m@幽灵` : '没有报点');

// —— 高度警觉：Bot 瞄上带技能的真人 → 事件发到那台机器 ——
const KH = new NetRoom({ id: 'rules-l3', mapId: 'yard', seed: 20260926 });
await KH.start();
const HP = KH.addClient({ name: '警觉', team: 'A', loadout: KITP(['highalert']) });
const HP2 = KH.addClient({ name: '路人', team: 'A', loadout: KITP(['eod']) });
const botH = KH.spawnBot({ name: '猎手', team: 'B', skill: 1 });
botH.perceiveT = 1e9;
botH.pos.copy(HP.pl.pos.clone().add(new THREE.Vector3(4, 0, 0)));
botH.target = HP.pl; botH.targetVisible = true;
botH.update(0.016);
ok('L7 高度警觉：Bot 瞄上带技能的真人 → highAlert 事件（cid 定向）',
  KH.events.some(e => e.e === 'highAlert' && e.cid === HP.cid),
  JSON.stringify(KH.events.filter(e => e.e === 'highAlert')));
// 反证臂：这条红了 = 事件滥发（谁被瞄都发，那这条就不再是指路的提示而是噪声）
botH.target = HP2.pl; botH.targetVisible = true;
botH.update(0.016);
ok('L8【反证】没技能的真人被瞄：没有事件',
  !KH.events.some(e => e.e === 'highAlert' && e.cid === HP2.cid),
  JSON.stringify(KH.events.filter(e => e.e === 'highAlert')));

// ═══════════════════════════════════════════════════════════════════════════
sec('M. 地上的枪：掉落 / 过期 / 补弹 / 换枪（权威端那条链）');
// ═══════════════════════════════════════════════════════════════════════════

const roomM = new NetRoom({ id: 'rules-m', mapId: 'yard', seed: 20260926 });
await roomM.start();
const MA = roomM.addClient({ name: '甲', team: 'A', loadout: KITP([]) });
const MB = roomM.addClient({ name: '乙', team: 'B' });

// —— 掉落规则：真人不掉、Bot 六成掉 ——
for (let i = 0; i < 10; i++) roomM.game.onKill(MA.pl, MB.pl, 'm4', false, {});
ok('M1 真人不掉枪（他的配装跟着重生走）',
  roomM.game.pickups.length === 0 && !roomM.events.some(e => e.e === 'pickup'),
  `地上 ${roomM.game.pickups.length} 把`);
const botM = roomM.spawnBot({ name: '掉枪', team: 'B', skill: 1 });
for (let i = 0; i < 20 && !roomM.game.pickups.length; i++) roomM.game.onKill(MA.pl, botM, 'm4', false, {});
const dropEv = roomM.events.find(e => e.e === 'pickup');
const dropP = roomM.game.pickups[0];
ok('M2 Bot 掉枪：地上有实体、事件带得起手状态（武器/弹药/位置）',
  !!dropP && !!dropEv && dropEv.weapon === dropP.weaponId && dropEv.id === dropP.netId
  && dropEv.mag === dropP.mag && dropEv.reserve === dropP.reserve,
  dropEv ? JSON.stringify({ w: dropEv.weapon, mag: dropEv.mag, rsv: dropEv.reserve }) : '没有事件');

// —— 过期 ——
dropP.t = 31;
roomM.step();
ok('M3 30 秒到点收掉：实体没了、gone 事件带着同一个 id',
  roomM.game.pickups.length === 0 && roomM.events.some(e => e.e === 'pickupGone' && e.id === dropEv.id));

// —— 同款走近自动补弹药 ——
let tickM = 0;
const feedM = (keys) => {
  tickM++;
  roomM.applyInput(MA.cid, { tick: tickM, mdx: 0, mdy: 0, keys, buttons: 0, view: 0, seq: tickM & 0xff, streak: -1 });
};
const rsv0 = MA.pl.ws.slots.find(s => s.id === 'm4').reserve;
const pA = roomM.game.spawnPickup('m4', {}, MA.pl.pos.clone(), 10, 30);
pA.netId = ++roomM.netIds;
feedM(0);
roomM.step();
const rsv1 = MA.pl.ws.slots.find(s => s.id === 'm4').reserve;
const ammoEv = roomM.events.find(e => e.e === 'pickupAmmo');
ok('M4 同款走近自动补弹药：包里多了、事件带最终值、地上那把没了',
  rsv1 > rsv0 && !!ammoEv && ammoEv.reserve === rsv1 && ammoEv.id === pA.netId && roomM.game.pickups.length === 0,
  `弹药 ${rsv0} → ${rsv1} ${JSON.stringify(ammoEv)}`);

// —— 异款按 F 换枪（旧枪落地）——
const pB2 = roomM.game.spawnPickup('ak', {}, MA.pl.pos.clone(), 15, 60);
pB2.netId = ++roomM.netIds;
feedM(0);                       // 没按 F：只算靠近，不换
roomM.step();
ok('M5【反证】没按 F 不换枪（"靠近"与"捡起"是两件事）',
  MA.pl.ws.slots[0].id === 'm4' && roomM.game.pickups.includes(pB2), `手上 ${MA.pl.ws.slots[0].id}`);
feedM(2048);                    // KEY.InteractPressed
roomM.step();
const takeEv = roomM.events.find(e => e.e === 'pickupTake');
const oldEv = roomM.events.filter(e => e.e === 'pickup').pop();
ok('M6 按 F 换枪：手上换成了 ak、take 事件带槽位与弹药、旧枪落地',
  MA.pl.ws.slots[0].id === 'ak' && !!takeEv && takeEv.weapon === 'ak' && takeEv.idx === 0
  && !!oldEv && oldEv.weapon === 'm4' && roomM.game.pickups.some(p => p.weaponId === 'm4'),
  `手上 ${MA.pl.ws.slots[0].id} ${JSON.stringify(takeEv)}`);
ok('M7 换走的那把从场上消失（gone 由 take 语义覆盖：同一个 id 不再出现在地上）',
  !roomM.game.pickups.includes(pB2), `地上 ${roomM.game.pickups.map(p => p.weaponId).join(',')}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('N. 自由混战进联机：独立队伍 / 杀到目标 / 名次判赢家');
// ═══════════════════════════════════════════════════════════════════════════

const roomN = new NetRoom({ id: 'rules-n', mapId: 'yard', seed: 20260926, mode: 'ffa' });
await roomN.start();
const NA = roomN.addClient({ name: '甲', team: 'A', account: 'alpha' });
const NB = roomN.addClient({ name: '乙', team: 'A' });        // 座位同队 —— ffa 里这不作数
ok('N1 每人一支独立"队"（同队打不掉血的坑就在这）',
  NA.pl.team !== 'A' && NB.pl.team !== 'A' && NA.pl.team !== NB.pl.team, `${NA.pl.team} / ${NB.pl.team}`);
// 反证臂：这条红了 = 两个人共用一支队 —— 友伤/闪光全按 team 判敌我，那之后谁也打不死谁
ok('N2【反证】敌我判定把两个人算成敌人',
  roomN.enemiesOf(NA.pl.team).some(e => e === NB.pl) && roomN.enemiesOf(NB.pl.team).some(e => e === NA.pl));

// —— 杀到目标数就收（与单机 js/mp.js 的 `k >= scoreLimit → end(killer)` 同一条）——
NA.kills = roomN.rules.scoreLimit - 1;
roomN.game.onKill(NA.pl, NB.pl, 'm4', false, {});
const nOver = roomN.events.find(e => e.e === 'matchOver');
ok('N3 杀到目标数：对局收，winner 是**那个人的 cid**（不是队名）',
  roomN.matchOverSent && !!nOver && nOver.winner === NA.cid, JSON.stringify(nOver));
const nRes = roomN.takeResults()[0];
ok('N4 档案按"我赢没赢"记：cid 口径下赢家 win=true',
  !!nRes && nRes.rows.length === 1 && nRes.rows[0].account === 'alpha' && nRes.rows[0].win === true,
  JSON.stringify(nRes && nRes.rows));

// —— 时间到：名次第一的那个人赢 ——
const roomN2 = new NetRoom({ id: 'rules-n2', mapId: 'yard', seed: 20260926, mode: 'ffa' });
await roomN2.start();
const N2A = roomN2.addClient({ name: '甲', team: 'A', account: 'alpha2' });
const N2B = roomN2.addClient({ name: '乙', team: 'B', account: 'beta2' });
for (let i = 0; i < 3; i++) roomN2.game.onKill(N2A.pl, N2B.pl, 'm4', false, {});
roomN2.rules.tick = roomN2.rules.timeLimit * 3600 + 1;       // 时间到（规则内核只说"结束了"）
for (let i = 0; i < 60 && !roomN2.matchOverSent; i++) roomN2.step();
const n2Over = roomN2.events.find(e => e.e === 'matchOver');
ok('N5 时间到：名次第一的那个人赢（名次在房间侧排 —— 规则内核不认人）',
  roomN2.matchOverSent && !!n2Over && n2Over.winner === N2A.cid, JSON.stringify(n2Over));
const n2Res = roomN2.takeResults()[0];
// 反证臂：这条红了 = 赢家判定把"队"当成了唯一口径，输家会被记成胜场
ok('N6【反证】输家不记胜场（cid 口径只给赢家 win=true）',
  !!n2Res && n2Res.rows.find(r => r.account === 'alpha2').win === true
  && n2Res.rows.find(r => r.account === 'beta2').win === false, JSON.stringify(n2Res && n2Res.rows));

// —— 记分板行带每人 UAV 剩余秒（快照头那一位在 ffa 里表达不了）——
roomN2.rules.uavStart(N2A.pl.team);
roomN2.pushBoard();
const n2Board = roomN2.events.filter(e => e.e === 'board').pop();
const uavA = (n2Board.rows.find(r => r.cid === N2A.cid) || {}).uav | 0;
const uavB = (n2Board.rows.find(r => r.cid === N2B.cid) || {}).uav | 0;
ok('N7 记分板行带每人 UAV 剩余秒（甲有、乙是 0）', uavA > 0 && uavB === 0, `甲 ${uavA}s 乙 ${uavB}s`);

// ═══════════════════════════════════════════════════════════════════════════
sec('O. 占领进联机：据点归属、占领得分、换旗事件');
// ═══════════════════════════════════════════════════════════════════════════

const roomO = new NetRoom({ id: 'rules-o', mapId: 'yard', seed: 20260926, mode: 'dom' });
await roomO.start();
const OA = roomO.addClient({ name: '甲', team: 'A' });
const OB = roomO.addClient({ name: '乙', team: 'B' });
ok('O1 先决：dom 房里有据点（地图给的 A/B/C）', !!roomO.flags && roomO.flags.length === 3, `flags=${roomO.flags && roomO.flags.length}`);

const fA = roomO.flags[0];
OA.pl.pos.copy(fA.pos);
roomO.step();
ok('O2 独占开始涨进度（0.18+0.07×1/秒那条式子）', fA.prog > 0 && fA.capTeam === OA.pl.team, `prog=${fA.prog.toFixed(4)} capTeam=${fA.capTeam}`);
OB.pl.pos.copy(fA.pos);
const prog0 = fA.prog;
roomO.step();
// 反证臂：这条红了 = 两边都站在点里也在涨 —— 混战的点被"抢穿"，谁人多谁永远占得住
ok('O3【反证】两边都站在点里：进度一格不动', fA.prog === prog0, `prog=${fA.prog.toFixed(4)}`);
OB.pl.pos.copy(fA.pos.clone().add(new THREE.Vector3(20, 0, 0)));
for (let i = 0; i < 300 && !fA.owner; i++) roomO.step();   // 0.25/秒 ⇒ ~240 拍到线
const capEv = roomO.events.find(e => e.e === 'flagCap');
ok('O4 独占到线：换旗 + flagCap 事件（客户端旗子的颜色靠它立刻翻）',
  fA.owner === OA.pl.team && !!capEv && capEv.name === fA.name && capEv.owner === OA.pl.team,
  JSON.stringify({ owner: fA.owner, capEv }));
ok('O5 换旗那两句定向播报（own=已占领 / foes=已失守）',
  roomO.events.some(e => e.e === 'announce' && e.to === 'own' && /已占领/.test(e.text))
  && roomO.events.some(e => e.e === 'announce' && e.to === 'foes' && /已失守/.test(e.text)));

const s0 = roomO.rules.scores[OA.pl.team];
roomO.step(); roomO.step();
ok('O6 占领得分挂在旗上（0.6/秒/点，两拍之后 A 队涨了）',
  roomO.rules.scores[OA.pl.team] > s0, `${s0.toFixed(3)} → ${roomO.rules.scores[OA.pl.team].toFixed(3)}`);

roomO.pushBoard();
const oBoard = roomO.events.filter(e => e.e === 'board').pop();
// 反证臂：这条红了 = 归属只活在服务端内存里 —— 客户端的旗子永远是白的
ok('O7【反证】记分板带据点归属/进度（大部队那条同步线）',
  !!oBoard.flags && oBoard.flags.length === 3 && oBoard.flags.find(f => f.name === fA.name).owner === OA.pl.team,
  JSON.stringify(oBoard.flags));

// ═══════════════════════════════════════════════════════════════════════════
sec('P. 结算停摆：matchOver 之后这一局不再有战斗');
// ═══════════════════════════════════════════════════════════════════════════
// 症状：结算画面都出来了，对局里还在对战和开火击杀。房间要等 MATCH_RETURN_MS 才收，
// 那段窗口里 sim 若照旧推进，比分/击杀/击杀播报全都还在动 —— 而玩家什么都改变不了。
// 判据分三半：击杀闸（蜂鸣后的杀不认）、世界闸（输入还在收、人不再动）、快照闸
// （下行不断流 —— 结算期间断流会被客户端当成"连接丢失"盖在结算面板上）。
{
  const roomP = new NetRoom({ id: 'rules-p', mapId: 'yard', seed: 20260926 });
  await roomP.start();
  const PA = roomP.addClient({ name: '甲', team: 'A' });
  const PB = roomP.addClient({ name: '乙', team: 'B' });
  roomP.endMatch('A');
  ok('P1 先决：endMatch 已置 matchOverSent，matchOver 已入队',
    roomP.matchOverSent && roomP.events.some(e => e.e === 'matchOver'));

  // ① 击杀闸。撞线的那一杀在 endMatch 之前已记完账，这里拦的是**蜂鸣之后**的：
  // 同一拍里跟着死掉的第二个人、以及 settle 窗口里任何一条还活着的伤害路径。
  const killsA = PA.kills, deathsB = PB.deaths, scoreA = roomP.rules.scores.A;
  const evCount = roomP.events.length;
  roomP.onKill(PA.pl, PB.pl, 'm4', true, {});
  ok('P2 结算后 onKill 一律不认（击杀/死亡/比分都不动 —— 结算画面后面不再涨杀）',
    PA.kills === killsA && PB.deaths === deathsB && roomP.rules.scores.A === scoreA,
    `A=${PA.kills}/${roomP.rules.scores.A} B死=${PB.deaths}`);
  ok('P3 结算后 onKill 不再编任何事件（连杀充能/掉落/播报全都不该有）',
    roomP.events.length === evCount, `${evCount} → ${roomP.events.length}`);

  // ② 世界闸。给甲一份"什么都按住"的输入，几十拍之后人必须还在原地 ——
  // 不然就是 sim 还在跑，Bot/投掷物/伤害全都在走。
  // 反证臂：这条红了 = 停摆只停了计分，没停世界。
  roomP.applyInput(PA.cid, { tick: 1, mdx: 0, mdy: 0, keys: 0xffff, buttons: 0xffff, view: 0, seq: 1, streak: -1 });
  const p0 = PA.pl.pos.clone();
  for (let i = 0; i < 30; i++) roomP.step();
  ok('P4 世界停摆：输入还在收、人却一步没动（开火/换弹/跳跃也全都不生效）',
    PA.pl.pos.distanceTo(p0) < 1e-9, `moved=${PA.pl.pos.distanceTo(p0).toFixed(4)}`);

  // ③ 快照闸。tick 一拍一拍地涨 —— net-server 的广播按它排班，停了就是 2.5 秒断流。
  const t0 = roomP.tick;
  roomP.step(); roomP.step(); roomP.step();
  ok('P5 快照拍号继续走（结算期间下行不断流，看门狗不会把结算盖成"连接丢失"）',
    roomP.tick === t0 + 3, `${t0} → ${roomP.tick}`);

  // ④ 窄帧闸。死亡画面那两条窄路在结算后都必须是死的：重生没有"下一条件"，
  // 连杀呼叫收下了也只是让槽凭空消耗掉。P6 把乙摆成"躺着"再验 —— 不然活着的人
  // 本来就会被拒，这条分不清是哪道闸在挡。
  PB.pl.alive = false; PB.respawnT = 0;
  ok('P6 结算后 requestRespawn 被拒（躺着也不许重生 —— 这一局的名单已经封盘）',
    roomP.requestRespawn(PB.cid) === false);
  ok('P7 结算后 requestStreak 被拒（槽不被凭空消耗，呼叫计数也不涨）',
    roomP.requestStreak(PA.cid, 0) === null && PA.book.slots.every(s => !s.used) && roomP.streak.calls === 0);

  // ⑤ 终局记分板随 matchOver 补发。平时它 120 拍一班，撞线那一杀常落在两班之间 ——
  // 不补的话，结算面板上记分板的击杀列会比 matchStats 少最后一杀。
  const pBoard = roomP.events.filter(e => e.e === 'board').pop();
  ok('P8 终局记分板随 matchOver 补发（面板上的击杀列不少最后一杀）',
    !!pBoard && pBoard.rows.length === 2, JSON.stringify(pBoard && pBoard.rows.map(r => `${r.name}:${r.k}`)));
  void PB;
}

// ═══════════════════════════════════════════════════════════════════════════
const pass = checks.filter(c => c[0]).length;
console.log('');
for (const [good, label] of checks) console.log(`  ${good ? '✅' : '❌'} ${label}`);
console.log(`\n${'═'.repeat(76)}\n  联机规则：${pass}/${checks.length} 通过\n${'═'.repeat(76)}`);
process.exit(pass === checks.length ? 0 : 1);
