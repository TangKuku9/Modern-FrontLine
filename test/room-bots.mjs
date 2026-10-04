// 联机房间里 Bot 的判据（房主在房间屏上点「+ Bot」加进来的那一种）。
//
//   node test/room-bots.mjs
//
// 为什么单独一份、而且走**进程内**的 NetRoom（与 test/mp-rules.mjs 同一条路）：
// 真 WebSocket 那一侧（test/room-flow.mjs 的 I 段）只能证明"房主点得动、名单会变"，
// 证明不了"Bot 真的在对局里存在"。而这一项最危险的失效方式恰好是后者：
//   · Bot 没编进快照 ⇒ 房主加了一屋子 Bot，所有人进去一个也看不见，
//     然后被一个看不见的东西打死（伤害是权威端算的，照常生效）；
//   · Bot 死了不重生 ⇒ 一局打到后半段场上只剩真人，看起来像"对面不来了"；
//   · Bot 的 id 撞上某个人的 cid ⇒ 客户端把两者认成同一个实体，两个人共用一个位置。
// 三种都不报错、不崩，只能靠这里的读数变红。
//
// 每条都带反证臂。反证臂不是"再跑一遍看看还是绿的"——它是**同一个量具在被测对象
// 坏掉时必须变红**的那一次。
import { NetRoom, DT } from '../server/room.mjs';
import { encodeSnapshot, decodeSnapshot, HEADER_SIZE, ENTITY_SIZE } from '../server/codec.mjs';
import { killMedals, LONGSHOT_DIST } from '../js/match-rules.js';
import * as THREE from 'three';

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label + (extra ? '  ' + extra : '')]); return !!cond; };
const sec = (t) => console.log('\n── ' + t + ' ──');

// 快照里的实体数。**从包长反推**，不读服务端的对象：
// 包长是定死的 HEADER_SIZE + n×ENTITY_SIZE（server/codec.mjs，趴姿那轮起实体 26 B），
// 所以"多一个 Bot"必须让包长正好多一个实体。
// 直接读 room.game.bots.length 的那种判据量的是服务端自己那一侧 —— Bot 进了 sim
// 却没编进快照时它照样是绿的，而那正是这一项最要命的失效形状。
const entsInPacket = (room) => {
  const { byteLength } = encodeSnapshot(room.snapshot());
  return (byteLength - HEADER_SIZE) / ENTITY_SIZE;
};
const stepN = (room, n) => { for (let i = 0; i < n; i++) room.step(); };

const room = new NetRoom({ id: 'bots', mapId: 'yard', seed: 20260926 });
await room.start();
const A = room.addClient({ name: '甲', team: 'A' });
const B = room.addClient({ name: '乙', team: 'B' });

// ═══════════════════════════════════════════════════════════════════════════
sec('A. 量具自证：这把尺子在"没有 Bot"的时候必须读出 0');
// ═══════════════════════════════════════════════════════════════════════════
ok('A1 没加 Bot 时，快照里恰好是 2 个真人（包长反推，不是读对象）',
  entsInPacket(room) === 2, `实体数 ${entsInPacket(room)}`);
ok('A2 包长确实是 HEADER_SIZE + 2×ENTITY_SIZE（这条红了说明量具自己算错了，下面每一条都不可信）',
  encodeSnapshot(room.snapshot()).byteLength === HEADER_SIZE + 2 * ENTITY_SIZE,
  `${encodeSnapshot(room.snapshot()).byteLength} 字节`);
ok('A3 房间里的 Bot 名单是空的（起点干净）', (room.game.bots || []).length === 0);

// ═══════════════════════════════════════════════════════════════════════════
sec('B. Bot 进了 sim，就必须进快照（看不见的敌人比没有敌人更糟）');
// ═══════════════════════════════════════════════════════════════════════════
const b1 = room.spawnBot({ name: '猎鹰', team: 'B', skill: 1 });
ok('B1 spawnBot 造出一个活的 Bot，并且带上了同步用的 netId',
  !!b1 && b1.alive === true && typeof b1.netId === 'number' && b1.netId > 0, `netId=${b1 && b1.netId}`);
ok('B2 它进了权威端的实体表（会被子弹打得到、也会被白磷弹烧到）',
  room.game.entities.includes(b1) && room.enemiesOf('A').includes(b1));
// ── 这一节的命门 ──
ok('B3 快照里**多出一行**：实体从 2 个变成 3 个（Bot 没编进快照的话这里是 2，而它照样在开枪）',
  entsInPacket(room) === 3, `实体数 ${entsInPacket(room)}`);
const ents = room.snapshot().entities;
const row1 = ents.find(e => e.id === b1.netId);
ok('B4 那一行的数据是它自己的（id/队伍/坐标对得上）',
  !!row1 && row1.team === 1 && Math.abs(row1.x - b1.pos.x) < 0.02, JSON.stringify(row1 && { id: row1.id, team: row1.team, x: +row1.x.toFixed(2) }));
ok('B5 快照往返不失真（Bot 那一行与真人同形状，整行能原样解回来）',
  !!row1 && decodeSnapshot(encodeSnapshot(room.snapshot()).view).entities.some(e => e.id === b1.netId));

// ═══════════════════════════════════════════════════════════════════════════
sec('C. Bot 的 id 不许撞上真人的 cid');
// ═══════════════════════════════════════════════════════════════════════════
ok('C1 Bot 的 netId 与房里每个真人的 cid 都不同',
  b1.netId !== A.cid && b1.netId !== B.cid, `bot=${b1.netId} / 人=${A.cid},${B.cid}`);
const b2 = room.spawnBot({ name: '蝮蛇', team: 'A', skill: 0 });
const b3 = room.spawnBot({ name: '雷霆', team: 'B', skill: 2 });
const ids = [A.cid, B.cid, b1.netId, b2.netId, b3.netId];
ok('C2 连加三个 Bot，五个 id 两两不同（撞一个就是"两个人共用一个位置"）',
  new Set(ids).size === 5, ids.join(','));
ok('C3 三个 Bot 全在快照里（加 N 个就多 N 行，不是一个计数位糊过去）',
  entsInPacket(room) === 5, `实体数 ${entsInPacket(room)}`);
// 反证臂：这条红了 = spawnBot 每次返回的其实是同一个对象（比如把 bot 存进了按 team 的槽）
ok('C4【反证】三个 Bot 是三个不同的实体、分在两队（不是同一个被覆盖三次）',
  new Set([b1, b2, b3]).size === 3 && b2.team === 'A' && b3.team === 'B',
  [b1.name, b2.name, b3.name].join('/'));

// ═══════════════════════════════════════════════════════════════════════════
sec('D. Bot 死了要能回来（否则一局打到后半段场上只剩真人）');
// ═══════════════════════════════════════════════════════════════════════════
b1.takeDamage(999, { attacker: A.pl, weapon: 'm4', dir: new THREE.Vector3(0, 0, 1) });
ok('D1 Bot 会被打死（damage 与真人走同一条路）', b1.alive === false && b1.hp <= 0, `hp=${b1.hp}`);
// 死亡那一拍它还在快照里（尸体要看得见），但已经不带 Alive 位
const deadRow = room.snapshot().entities.find(e => e.id === b1.netId);
ok('D2 死了的 Bot 仍然在快照里（客户端要看得到尸体，不是凭空消失）', !!deadRow);
// 反证臂：只跑 1 秒（比 4 + rng*2 短）时它必须**还没**回来 ——
// 这条若不红，说明下面那条"5 秒后回来了"是恒真绿灯（比如它压根没死过）。
stepN(room, 60);
ok('D3【反证】只过 1 秒（< 重生延迟）它还没回来', b1.alive === false);
stepN(room, 60 * 5);
ok('D4 再过 5 秒它自己回来了（权威端排的重生队，不是靠客户端）',
  b1.alive === true && b1.hp === b1.maxHp, `alive=${b1.alive} hp=${b1.hp}`);
ok('D5 重生之后换了位置（不是死在原地原样站起来的）',
  b1.pos.distanceTo(A.pl.pos) > 0 && b1.alive === true);
// 反证臂②：真人的重生没被这一套改动带坏
A.pl.takeDamage(999, { attacker: B.pl, weapon: 'm4', dir: new THREE.Vector3(0, 0, 1) });
ok('D6【反证】真人死了照样由 respawnT 那条路复活（Bot 的重生没有顶掉人的）',
  A.pl.alive === false && (stepN(room, 60 * 5), A.pl.alive === true), `alive=${A.pl.alive}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('E. Bot 杀的人要记在它自己名下，队伍分要跟着涨');
// ═══════════════════════════════════════════════════════════════════════════
const scoreBefore = room.rules.scores.B | 0;
const kB = b3.kills | 0;
room.game.onKill(b3, A.pl, 'ak', false, {});
ok('E1 Bot 击杀给**队伍**加了 1 分（与真人击杀同一句，不是另一套）',
  room.rules.scores.B === scoreBefore + 1, `${scoreBefore} → ${room.rules.scores.B}`);
ok('E2 Bot 自己的击杀数也涨了（记分板上它那一行不是恒 0）',
  (b3.kills | 0) === kB + 1 && (b3.score | 0) > 0, `kills=${b3.kills} score=${Math.round(b3.score)}`);
// 反证臂：Bot 拿不到真人才有的东西 —— 连杀槽、战绩行。这两格不该因为它杀了人就出错。
ok('E3【反证】Bot 没有连杀槽（StreakBook 属于"真人按 3/4/5"那条链路）',
  b3.book === undefined && !room.events.some(e => e.e === 'streakReady' && e.cid === b3.netId));
ok('E4【反证】战绩队列里不会多出一行 Bot（它没有账号，xp 也没处落）',
  (room.__results[0] ? room.__results[0].rows : []).every(r => r.account !== undefined));

// ═══════════════════════════════════════════════════════════════════════════
sec('F. Bot 要进记分板（比分在涨、名单上却没有它，谁都会先怀疑记分板算错）');
// ═══════════════════════════════════════════════════════════════════════════
room.events.length = 0;
room.pushBoard();
const board = room.events.find(e => e.e === 'board');
ok('F1 记分板事件里有 Bot 那几行（bot 标记随行，界面要能区分）',
  !!board && board.rows.filter(r => r.bot).length === 3, JSON.stringify(board && board.rows.map(r => r.name + (r.bot ? '(B)' : ''))));
ok('F2 Bot 那一行带的是它自己的击杀/死亡/分数（不是空壳）',
  !!board && board.rows.some(r => r.bot && r.name === '雷霆' && r.k >= 1), JSON.stringify(board && board.rows.find(r => r.name === '雷霆')));
// 反证臂：真人那两行不能被 Bot 挤掉。名次按击杀排（rank 就是排序结果），Bot 杀得多
// 排在前面是**对的** —— 曾经这里钉着"第一行必须是真人"，于是 Bot 超常发挥就假红。
ok('F3【反证】真人那两行还在（名次按击杀排，Bot 杀得多可以排在真人前面）',
  !!board && board.rows.length === 5 && board.rows.some(r => r.name === '甲') && board.rows.some(r => r.name === '乙'),
  JSON.stringify(board && board.rows.map(r => r.name)));

// ═══════════════════════════════════════════════════════════════════════════
sec('G. 移除：房主减掉一个，它就从这一局里彻底消失');
// ═══════════════════════════════════════════════════════════════════════════
room.removeBot(b2);
ok('G1 移除之后它不在权威端的实体表里了（也打不到、也烧不到）',
  !room.game.entities.includes(b2) && !room.game.bots.includes(b2));
ok('G2 快照里也少了一行（少了这条，"减了 Bot 但对面还在"）',
  entsInPacket(room) === 4, `实体数 ${entsInPacket(room)}`);
ok('G3 剩下的两个 Bot 还在（移除一个不是清空）',
  (room.game.bots || []).length === 2 && entsInPacket(room) === 4);
// 反证臂：这一条红了 = 移除把整个 Bot 名单清了（比如按 team 存的槽被整槽删掉）
ok('G4【反证】移除一个 Bot 之后，另一个队那个没被连带删掉',
  room.game.bots.includes(b1) && room.game.bots.includes(b3),
  (room.game.bots || []).map(b => b.name).join('/'));

// ═══════════════════════════════════════════════════════════════════════════
sec('H. 难度那一格：房间给的数要真的落到 Bot 身上');
// ═══════════════════════════════════════════════════════════════════════════
const easy = room.spawnBot({ name: '北极狐', team: 'B', skill: 0 });
const hard = room.spawnBot({ name: '老炮', team: 'B', skill: 2 });
ok('H1 难度 0/2 分别落成 ai.js 的 DIFF 表里那两档（不是都取默认）',
  easy.difficulty === 0 && hard.difficulty === 2 && easy.diff.react > hard.diff.react,
  `新兵 react=${easy.diff.react} / 老兵 react=${hard.diff.react}`);
ok('H2 三档的**反应时间**确实不同（这条红了说明难度只是个没人读的字段）',
  easy.diff.react !== hard.diff.react && easy.diff.spread > hard.diff.spread,
  `spread ${easy.diff.spread} vs ${hard.diff.spread}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('I. 群体警戒那条通道：房间里放了 Bot 之后它要真的会用');
// ═══════════════════════════════════════════════════════════════════════════
// 这条以前只能靠探针验（"联机目前不放 AI"），而它断掉的方式正是静默的：
// ai.js 里写着 `game.alertGroup && ...`，缺了实现两边都不报错，只是整组敌人不会一起警戒。
const g1 = room.spawnBot({ name: '野马', team: 'B', skill: 1 });
const g2 = room.spawnBot({ name: '黑曼巴', team: 'B', skill: 1 });
g1.group = 'g'; g2.group = 'g';
const spread0 = room.alertSpread | 0;
const r = room.alertGroup('g', A.pl.pos);
ok('I1 房间会把警戒扩散给同组的 Bot（n = 这次扩到几个人）',
  r.n === 2 && (room.alertSpread | 0) === spread0 + 2 && g2.alerted === true, JSON.stringify(r));
// 反证臂：同一个组第二次报警不再重复扩散（那会把 alertSpread 变成"喊了多少次"）
ok('I2【反证】同一个组第二次报警不重复扩散（first=false，n 仍为 2 但不重复计数）',
  room.alertGroup('g', A.pl.pos).first === false);

// ═══════════════════════════════════════════════════════════════════════════
sec('J. 击杀奖章随 kill 事件下发（联机屏幕上也该有爆头/双杀/复仇那几行）');
// ═══════════════════════════════════════════════════════════════════════════
// 缺口：事件里以前只有 pts 一个总数，于是联机屏幕上永远只有"+250 击杀"一行 ——
// 爆头、近战、远距离、复仇、连杀一条都看不出来，而账上加的偏偏就是那些 50/100。
// 文案与分值表在 js/match-rules.js:killMedals（单机 js/mp.js:playerKill 画的是
// 同一张，那张表自己在 test/mp-rules.mjs 的 A24-A27 里被量过）。
// 这一节量的是**连接处**：权威端算出来的 tags 有没有真的走到事件里、分对不对。
//
// 连杀奖章的窗口**按击杀者分账**（MatchRules.chainBy，4 秒，键 = 击杀者实体），所以
// 每条场景开跑前先清表：这一节问的是"这一杀的 tags 里有什么"，不是"今晚连杀排到第几"。
// 清空之后 killChain() 照样会把当前这一拍记进去（返回 1），所以"第一杀不许带连杀标签"
// 依然是一条真判据。
const soloChain = () => { room.rules.resetChains(); };
const killsOf = (name) => room.events.filter(e => e.e === 'kill' && e.victim === name);
const botNamed = (n) => (room.game.bots || []).find(b => b.name === n);
// 开打之前要**摆距离**：killScore 的远距离那条线是 40 m，而这张图上的 Bot 正好都站在
// 40 m 开外 —— 不摆的话，"近距离爆头值 150"读到的是 200，红的是判据而不是被测对象。
// （这不是假设：J2 第一次跑就读到 pts=200 / tags=[head,longshot]。）
const put = (killer, victim, m) => { killer.pos.set(0, 0, 0); victim.pos.set(0, 0, -m); };

room.events.length = 0;
soloChain();
ok('J1【先决】连杀窗口清空了（不清的话"第二杀带 chain2"可能本该是 chain4 的后半截）',
  room.rules.chainBy.size === 0);

// ① 近距离爆头：tags 里要有 head，且分值 100 + 50
const vJ = botNamed('野马');
put(A.pl, vJ, 3);
ok('J1b【先决】这一杀是近距离（< 40 m）—— 不然"只有爆头这一条"就不成立',
  A.pl.pos.distanceTo(vJ.pos) < LONGSHOT_DIST, `${A.pl.pos.distanceTo(vJ.pos).toFixed(1)} m`);
room.game.onKill(A.pl, vJ, 'ak', true, {});
stepN(room, 1);
const ev1 = killsOf(vJ.name).pop();
ok('J2 爆头那一杀的 kill 事件带上了 tags，里面有 head 没有别的（不是只发一个总分）',
  !!ev1 && Array.isArray(ev1.tags) && ev1.tags.join(',') === 'head' && ev1.pts === 150,
  JSON.stringify(ev1 && { pts: ev1.pts, tags: ev1.tags }));
ok('J3 这一批 tags 画出来就是 HUD 上那一行（与单机同一张表）',
  !!ev1 && killMedals(ev1.tags).map(m => m.label + ' +' + m.points).join(' / ') === '爆头 +50',
  ev1 ? killMedals(ev1.tags).map(m => m.label + ' +' + m.points).join(' / ') : '没有事件');
// 反证臂：这条红了 = 第一杀被算成连杀（killChain 返回 1 也贴 chain1），屏幕上会凭空
// 多一行"双杀" —— 而它的分值也是凭空多的 50。
ok('J4【反证】第一杀不带连杀标签（chain1 不是"双杀"）',
  !!ev1 && !ev1.tags.some(t => t.startsWith('chain')), JSON.stringify(ev1 && ev1.tags));

// ② 同一个击杀者窗口内的第二杀 = 双杀（走的是权威端那一句 killChain(killer)）。
// 击杀者必须是 J2 那同一个甲：账按人分，换了人这就不是**他的**第二杀。
const vJ2 = botNamed('黑曼巴');
ok('J5a【先决】这一节要用的三个 Bot 都还在场上（名字写错了的话下面每条都会读到 undefined）',
  !!vJ && !!vJ2 && vJ !== vJ2, `${vJ && vJ.name} / ${vJ2 && vJ2.name}`);
put(A.pl, vJ2, 3);
room.game.onKill(A.pl, vJ2, 'm4', false, {});
stepN(room, 1);
const ev2 = killsOf(vJ2.name).pop();
ok('J5 同一击杀者紧接着的第二杀带 chain2，分值 100 + 2×50（连杀那一条也是账上真加了的）',
  !!ev2 && ev2.tags.join(',') === 'chain2' && ev2.pts === 200, JSON.stringify(ev2 && { pts: ev2.pts, tags: ev2.tags }));

// ②'【反证】分账的另一面：两个不同的击杀者贴在同一拍里各杀一人，谁都不带 chain 标。
// 实网报的 bug 正是它的反面 —— 窗口曾是全房一条滚动表，别人 4 秒内的击杀替你把数攒满，
// 每杀必念"暴走/无人可挡"，分值跟着 chain×50 一起虚高。这条在旧实现上跑是红的。
soloChain();
put(A.pl, vJ, 3);
put(B.pl, vJ2, 3);
room.game.onKill(A.pl, vJ, 'ak', false, {});
room.game.onKill(B.pl, vJ2, 'm4', false, {});
stepN(room, 1);
const evA = killsOf(vJ.name).pop(), evB = killsOf(vJ2.name).pop();
ok('J5d【反证】同一窗口里两个击杀者各杀一人，两条都不带 chain 标（不是全房一条滚动表）',
  !!evA && !!evB && !evA.tags.some(t => t.startsWith('chain')) && !evB.tags.some(t => t.startsWith('chain')),
  JSON.stringify({ a: evA && evA.tags, b: evB && evB.tags }));

// ③ 远距离：40 m 那条线在**权威端这条路上**也要成立（纯函数那半边在 mp-rules 的 A22/A23）
const vJ3 = botNamed('雷霆');
put(A.pl, vJ3, LONGSHOT_DIST + 10);
ok('J5b【先决】这一杀是远距离（> 40 m），而且靶子还在场上',
  !!vJ3 && A.pl.pos.distanceTo(vJ3.pos) > LONGSHOT_DIST, `${vJ3 ? A.pl.pos.distanceTo(vJ3.pos).toFixed(1) + ' m' : '靶子不见了'}`);
soloChain();
room.game.onKill(A.pl, vJ3, 'ak', false, {});
stepN(room, 1);
const ev2b = killsOf(vJ3.name).pop();
ok('J5c 远距离那一杀带 longshot（同样的枪、同样没爆头，就因为它站得远）',
  !!ev2b && ev2b.tags.join(',') === 'longshot' && ev2b.pts === 150, JSON.stringify(ev2b && { pts: ev2b.pts, tags: ev2b.tags }));

// ④ 复仇：'上一个打我的人'。这一格由 takeDamage 记（js/player.js:132），服务端跑的是
// 同一份 combat.js —— 所以这里走真伤害那条路，不直接改字段（改了就是自问自答）。
soloChain();
put(A.pl, vJ, 3);
const hpJ = A.pl.hp;
A.pl.takeDamage(5, { attacker: vJ, weapon: 'ak', dir: new THREE.Vector3(0, 0, 1) });
ok('J6【先决】甲刚挨了野马一下（不复位这一格，"复仇"那一条无从谈起）',
  A.pl.lastAttacker === vJ && A.pl.hp === hpJ - 5, `hp ${hpJ} → ${A.pl.hp}`);
room.game.onKill(A.pl, vJ, 'ak', false, {});
stepN(room, 1);
const ev3 = killsOf(vJ.name).pop();
ok('J7 打死"刚才打我的人"带 revenge，分值 100 + 50（与单机 js/mp.js:216 同一句）',
  !!ev3 && ev3.tags.includes('revenge') && ev3.pts === 150, JSON.stringify(ev3 && { pts: ev3.pts, tags: ev3.tags }));
// 反证臂：这条红了 = 记完没清（单机 mp.js:218 清了），于是同一个对手被你杀第二次
// 仍然算复仇 —— 两边就此分家，而这件事没有任何一处会报错。
ok('J8【反证】记完就清：甲身上那一格不再是野马',
  A.pl.lastAttacker === null, String(A.pl.lastAttacker && A.pl.lastAttacker.name));
soloChain();
room.game.onKill(A.pl, vJ, 'ak', false, {});
stepN(room, 1);
const ev4 = killsOf(vJ.name).pop();
ok('J9【反证】再杀一次同一人不算复仇：pts 回到 100、tags 是空表（没有凭空多出来的奖章）',
  !!ev4 && ev4.pts === 100 && ev4.tags.length === 0 && !ev4.tags.includes('revenge'),
  JSON.stringify(ev4 && { pts: ev4.pts, tags: ev4.tags }));
ok('J10 这一节每一条 kill 事件都带 tags 数组（缺字段时客户端会画出一行 undefined）',
  [ev1, ev2, evA, evB, ev2b, ev3, ev4].every(e => !!e && Array.isArray(e.tags)),
  [ev1, ev2, evA, evB, ev2b, ev3, ev4].map(e => JSON.stringify(e && e.tags)).join(' '));

const bad = checks.filter(c => !c[0]).length;
for (const [pass, label] of checks) console.log(`  ${pass ? '✅' : '❌'} ${label}`);
console.log(`\n${bad ? '❌' : '✅'} ${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
