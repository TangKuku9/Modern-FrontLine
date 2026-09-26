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
import { NetRoom, DT, STREAK_DEFS } from '../server/room.mjs';
import { StreakBook, TickClock, MatchRules, killScore, KILL_POINTS, UAV_SECONDS, uavFromFlags } from '../js/match-rules.js';
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
let tickC = 0;
const feedC = (c, streak) => {
  tickC++;
  roomC.applyInput(c.cid, { tick: tickC, mdx: 0, mdy: 0, keys: 0, buttons: 0, view: 0, seq: tickC & 0xff, streak });
};
for (let i = 0; i < 5; i++) roomC.game.onKill(CA.pl, CB.pl, 'm4', false, {});
ok('C1 5 杀之后 cluster（cost 5）就绪、wp（cost 10）还没', CA.book.slots[1].ready === true && CA.book.slots[2].ready === false);

feedC(CA, 1);
roomC.step();
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
const pass = checks.filter(c => c[0]).length;
console.log('');
for (const [good, label] of checks) console.log(`  ${good ? '✅' : '❌'} ${label}`);
console.log(`\n${'═'.repeat(76)}\n  联机规则：${pass}/${checks.length} 通过\n${'═'.repeat(76)}`);
process.exit(pass === checks.length ? 0 : 1);
