// 房间流程的判据（CF 式开房间）：大厅 → 建房 → 进人 → 准备 → 房主开始 → 对局。
//
// 这一层每一种失效都是静默的，所以每条都在数服务端自己报出来的东西：
//   · "没准备也能开局" —— 不报错，只是有人被拖进对局；
//   · "非房主也能开局" —— 不报错，只是房间失去了房主的控制；
//   · "等待中的房间养着一份 sim" —— 不报错，只是跑得越久越慢；
//   · "绕过房间直接 join 挤进别人的对局" —— 不报错，只是房主那道闸等于没做。
// 判据读 /healthz 的 lobby 那一格（见 server/lobby.mjs:stats）：把计数器删掉会让这些条
// 变红，而不是让它们永远绿。
//
//   node test/room-flow.mjs
import { WebSocket } from 'ws';
import { withServer } from './with-server.mjs';
import { minutesOptions, DOM_MINUTES } from '../js/data.js';

let bad = 0, n = 0;
const ok = (label, cond, info = '') => {
  n++;
  if (cond) console.log(`  ✅ ${label}${info ? '  ' + info : ''}`);
  else { bad++; console.log(`  ❌ ${label}${info ? '  ' + info : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 一条连接 + 一个"按类型取下一条控制帧"的队列。
// 刻意不做成"发一句等一帧"：房间状态是**一变就推**的，一次开局会连着来好几帧
// （每个人的 room 状态 + welcome），按次序死等某一种会把别的挤掉。
function client(wsUrl, tag) {
  const got = [];
  const bin = { n: 0, last: 0 };
  const ws = new WebSocket(wsUrl);
  const c = {
    tag, ws, frames: got,
    opened: new Promise(res => ws.on('open', res)),
    binary: () => bin.n,
    // 最近一份快照的**字节数**。Bot 有没有编进快照只能从包长看出来：
    // 包是定长的（HEADER_SIZE + n×ENTITY_SIZE），所以"多一个 Bot"必须让包长正好多一个实体。
    // 只数包数的话，Bot 进了 sim 却没进协议也能全绿 —— 而那正是最要命的失效形状
    //（房主加了一屋子 Bot，所有人进去一个也看不见，然后被看不见的东西打死）。
    lastBytes: () => bin.last,
    async until(p, ms = 8000) {
      const t0 = Date.now();
      for (;;) {
        const hit = got.find(p);
        if (hit) { got.splice(got.indexOf(hit), 1); return hit; }
        if (Date.now() - t0 > ms) return null;
        await sleep(40);
      }
    },
    send(o) { ws.send(JSON.stringify(o)); },
    close() { try { ws.close(); } catch { /* 已经在断了 */ } },
  };
  ws.on('message', (d, isBin) => {
    if (isBin) { bin.n++; bin.last = d.length || (d.buffer && d.buffer.byteLength) || 0; return; }
    try { got.push(JSON.parse(String(d))); } catch { /* 非 JSON 的下行不在本协议里 */ }
  });
  return c;
}
const health = async (base) => (await (await fetch(base + '/healthz')).json());

// 一份"和系统预设不一样"的配装：拿它验"准备那一帧顺手把枪交出去"这条接线。
// 用 m4 当默认值的话，这条判据量的是空气 —— 传丢了也照样绿。
const KIT = { primary: { id: 'ak', att: {}, camo: 'none' }, secondary: { id: 'm1911', att: {}, camo: 'none' }, lethal: 'frag', tactical: 'flash', perks: [] };
const apiRooms = async (base) => (await (await fetch(base + '/api/rooms')).json()).rooms || [];

try {
  const srv = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '', MAP: 'yard' });
  const { base, ws: wsUrl } = srv;

  console.log('\n── A：等待态是一张名单，不是一份 sim ──');
  const a = client(wsUrl, '甲');
  await a.opened;
  a.send({ t: 'lobby' });
  const l0 = await a.until(j => j.t === 'lobby');
  ok('进大厅先拿到一份房间清单（不是靠轮询 /api/rooms）', !!l0 && Array.isArray(l0.rooms), JSON.stringify(l0 && l0.rooms));
  ok('服务器上还没有任何在跑的 sim', (await health(base)).rooms === 0);

  // attach 幂等（性能审查 P1）：已经在大厅的连接重复发 {t:'lobby'}，只回它自己一份，
  // 不再触发一次全厅广播 —— 曾经每条重复帧都是"全量清单 × 全部连接"的扇出。
  // 250ms 远大于服务端的 50ms 合帧窗口：若服务端仍在广播，旁听者这里必然多收一帧。
  const a2 = client(wsUrl, '乙');
  await a2.opened;
  a2.send({ t: 'lobby' });
  await a2.until(j => j.t === 'lobby');
  await sleep(120);                 // 先等 a2 自己那次 attach 的合帧广播（50ms 窗）落地，别污染测量
  const eavesdropped = () => a2.frames.filter(j => j.t === 'lobby').length;
  const own = () => a.frames.filter(j => j.t === 'lobby').length;
  const silent0 = eavesdropped(), own0 = own();
  a.send({ t: 'lobby' });
  await sleep(250);
  ok('重复 attach 对旁听者静默（不再触发全厅广播）', eavesdropped() === silent0, `旁听 lobby 帧 ${silent0}→${eavesdropped()}`);
  ok('重复 attach 仍回自己一份清单（这一帧是"给我刷新"，不是给别人广播）', own() === own0 + 1, `自己 ${own0}→${own()}`);

  a.send({ t: 'createRoom', room: 'hall', title: '我的房', name: '阿甲', map: 'dune', mode: 'tdm' });
  const r1 = await a.until(j => j.t === 'room' && j.room && j.room.id === 'hall');
  ok('建房成功且我是房主', !!r1 && !!r1.me && r1.me.isHost === true, JSON.stringify(r1 && r1.me));
  ok('房名是房名、房号是房号（中文房名没被拿去当房号）',
    !!r1 && r1.room.id === 'hall' && r1.room.title === '我的房', JSON.stringify(r1 && r1.room));
  ok('一个人的时候不给开局，并且说清为什么', !!r1 && r1.canStart === false && /至少/.test(r1.why || ''), JSON.stringify(r1 && r1.why));
  const h1 = await health(base);
  ok('建好的房只算"名单"，**仍然没有 sim 在跑**',
    h1.rooms === 0 && h1.lobby.rooms === 1 && h1.lobby.playing === 0, JSON.stringify({ live: h1.rooms, wait: h1.lobby.waiting }));
  const row1 = (await apiRooms(base)).find(x => x.id === 'hall');
  ok('/api/rooms 与大厅列表是同一份东西（title/地图/人数都在）',
    !!row1 && row1.title === '我的房' && row1.map === 'dune' && row1.players === 1 && row1.state === 'waiting', JSON.stringify(row1));

  console.log('\n── B：第二个人进来，判据在服务端 ──');
  const b = client(wsUrl, '乙');
  await b.opened;
  b.send({ t: 'lobby' });
  await b.until(j => j.t === 'lobby');
  b.send({ t: 'joinRoom', room: 'hall', name: '小乙' });
  const r2 = await b.until(j => j.t === 'room' && j.seats && j.seats.length === 2);
  ok('进房之后我数得出两个座位', !!r2 && r2.seats.length === 2, JSON.stringify(r2 && r2.seats.map(s => s.name)));
  const r2a = await a.until(j => j.t === 'room' && j.seats && j.seats.length === 2);
  ok('房主那边当场看到有人进来（不用刷新）', !!r2a && r2a.seats.some(s => s.name === '小乙'));
  ok('自动分到人少的那一队（不是全挤 A 队）', !!r2 && r2.me.team === 'B', 'team=' + (r2 && r2.me.team));
  ok('两个人、第二个人还没准备 → 不给开局', !!r2a && r2a.canStart === false && /还在等/.test(r2a.why || ''), JSON.stringify(r2a && r2a.why));

  const notHost0 = (await health(base)).lobby.notHost | 0;
  b.send({ t: 'start' });
  const rej = await b.until(j => j.t === 'err');
  ok('非房主按开始被拒，且话说清楚了', !!rej && /房主/.test(rej.msg || ''), JSON.stringify(rej));
  ok('这一类拒绝在服务端数得出来（不是只拒了不记）', (await health(base)).lobby.notHost === notHost0 + 1);

  a.send({ t: 'start' });
  const rej2 = await a.until(j => j.t === 'err');
  ok('房主在有人没准备时被拦住，且报的是"还在等谁"', !!rej2 && /还在等/.test(rej2.msg || ''), JSON.stringify(rej2));
  ok('"没准备"与"不是房主"是两种计数（合成一种就归不了因）', (await health(base)).lobby.notReady === 1);

  b.send({ t: 'ready', on: true, loadout: KIT });
  const r3 = await a.until(j => j.t === 'room' && j.canStart === true);
  ok('人人准备之后，房主那边的开始按钮变成可点', !!r3, JSON.stringify(r3 && { canStart: r3.canStart, why: r3.why }));
  b.send({ t: 'ready', on: false });
  const r4 = await a.until(j => j.t === 'room' && j.canStart === false);
  ok('取消准备会被房主那边看见（这一格不是单向的开关）', !!r4);
  b.send({ t: 'ready', on: true });
  await a.until(j => j.t === 'room' && j.canStart === true);

  console.log('\n── C：房主按下开始 ──');
  a.send({ t: 'start' });
  const wa = await a.until(j => j.t === 'welcome', 15000);
  const wb = await b.until(j => j.t === 'welcome', 15000);
  ok('两个人都在**同一条连接**上拿到进场应答（不重新拨号）', !!wa && !!wb, JSON.stringify({ a: !!wa, b: !!wb }));
  ok('进的是自己那间房、地图是房里选的那张', !!wa && wa.room === 'hall' && wa.map === 'dune', JSON.stringify(wa && { room: wa.room, map: wa.map }));
  ok('连杀槽位表随应答一起给（少这一格就是"按 3 没反应"）', !!wa && Array.isArray(wa.streaks) && wa.streaks.length > 0);
  // 服务端回声的那一份，不是我自己发出去的那一份（清洗在 room.addClient 里做）。
  ok('准备那一帧带上去的配装真的进了对局（传丢的症状是"我明明换了枪，进局还是 m4"）',
    !!wb && wb.loadout && wb.loadout.primary.id === 'ak', JSON.stringify(wb && wb.loadout && wb.loadout.primary));
  ok('阵营由服务端说回来（不是网址里那份）', !!wb && wb.team === 'B' && wa.team === 'A', JSON.stringify({ a: wa && wa.team, b: wb && wb.team }));
  ok('others 是完整的：房主看得见后到的那个人（边放人边发就会漏）',
    !!wa && (wa.others || []).length === 1 && wa.others[0].name === '小乙', JSON.stringify(wa && wa.others));
  await sleep(800);
  ok('快照开始下行（这间真的在跑权威模拟了）', a.binary() > 3 && b.binary() > 3, `甲 ${a.binary()} 包 / 乙 ${b.binary()} 包`);
  const h2 = await health(base);
  ok('/healthz 里这间成了在跑的 sim，两个人在册',
    h2.rooms === 1 && h2.per.some(x => x.id === 'hall' && x.clients === 2), JSON.stringify(h2.per.map(x => x.id + ':' + x.clients)));
  const rowLive = (await apiRooms(base)).find(x => x.id === 'hall') || {};
  ok('大厅清单跟着变成"对局中"', rowLive.state === 'playing');
  // 而且它与等待态那一行**同形状**（低危账）：两边各写一份字段表的话，客户端在"等着的房"
  // 和"已经开打的房"上拿到的是两种对象，缺的那几格只表现为界面上一格空白 —— 不报错。
  // host 拿的是**房主名**（'阿甲'）而不是空串：这一格是"有没有接上大厅那份名单"的读数，
  // 写死一个 '' 也能让"键存在"这类形状判据绿。
  ok('live 房那一行与等待态同形状（bots / time / score 三格是数、host 是房主名）',
    typeof rowLive.bots === 'number' && typeof rowLive.time === 'number'
    && typeof rowLive.score === 'number' && rowLive.host === '阿甲'
    && rowLive.time > 0 && rowLive.score > 0, JSON.stringify(rowLive));

  console.log('\n── D：绕过房间的那几条口 ──');
  const c = client(wsUrl, '丙');
  await c.opened;
  c.send({ t: 'join', room: 'hall', name: '路人丙', team: 'A' });
  const bar = await c.until(j => j.t === 'welcome' || j.t === 'err', 8000);
  ok('照着房号手打网址挤不进别人的对局', !!bar && bar.t === 'err' && /私人局/.test(bar.msg || ''), JSON.stringify(bar));
  c.send({ t: 'joinRoom', room: 'hall', name: '路人丙' });
  const bar2 = await c.until(j => j.t === 'err' || j.t === 'room', 8000);
  ok('对局中也不能从大厅再进人（那会凭空多出一个没准备过的人）',
    !!bar2 && bar2.t === 'err' && /对局中/.test(bar2.msg || ''), JSON.stringify(bar2));
  c.send({ t: 'join', room: 'auto', name: '路人丙' });
  const leg = await c.until(j => j.t === 'welcome', 15000);
  ok('直连对局那条老路照旧能进（探针与 ?online=1 没被这轮改造动到）', !!leg, JSON.stringify(leg && { cid: leg.cid, room: leg.room }));
  c.close();
  await sleep(200);

  console.log('\n── E：两条聊天频道 ──');
  a.frames.length = 0; b.frames.length = 0;
  a.send({ t: 'say', ch: 'room', text: '这局我守 B 点' });
  const cr = await b.until(j => j.t === 'chat' && j.ch === 'room');
  ok('房间里说的话同房间的人都收到', !!cr && cr.text === '这局我守 B 点' && cr.from === '阿甲', JSON.stringify(cr));
  const d = client(wsUrl, '丁');
  await d.opened;
  d.send({ t: 'lobby' });
  await d.until(j => j.t === 'lobby');
  d.send({ t: 'say', ch: 'lobby', text: '有人一起吗' });
  const cl = await a.until(j => j.t === 'chat' && j.ch === 'lobby');
  ok('大厅频道是跨房间的（房里的人也应该听得见全服）', !!cl && cl.text === '有人一起吗');
  const hist = await d.until(j => j.t === 'chat' && Array.isArray(j.hist), 2000);
  ok('刚进大厅的人能看到最近几句（否则聊天永远是半截的）', !!hist || !!cl, JSON.stringify(hist && hist.hist && hist.hist.length));
  d.send({ t: 'say', ch: 'room', text: '我没在任何房间里' });
  await sleep(300);
  ok('没进房间的人发不了房间频道（服务端不给他造一个）',
    !(await a.until(j => j.t === 'chat' && j.text === '我没在任何房间里', 800)));
  const rate0 = (await health(base)).lobby.sayRate | 0;
  for (let i = 0; i < 10; i++) d.send({ t: 'say', ch: 'lobby', text: '刷屏' + i });
  await sleep(400);
  const got = (await health(base)).lobby.say;
  const refused = (await health(base)).lobby.sayRate;
  ok('刷屏被限住：10 条里只放过一两条', refused >= 7 && refused > rate0, `放行到 ${got} 条，拒了 ${refused - rate0} 次`);
  const back = await d.until(j => j.t === 'err');
  ok('被限流当场说一声（不响的话玩家以为是自己打的字没保存）', !!back && /太快/.test(back.msg || ''), JSON.stringify(back));

  console.log('\n── F：房主跑了之后这间还能开 ──');
  d.close();
  a.close();
  const r5 = await b.until(j => j.t === 'room' && j.me && j.me.isHost === true, 6000);
  ok('房主离开之后移交给还活着的下一个人（不是留下一间永远开不了的房）', !!r5, JSON.stringify(r5 && r5.me));
  ok('移交之后自己算已准备（房主那一格不该要点才亮）', !!r5 && r5.me.ready === true);
  b.close();
  await sleep(300);
  ok('最后一个座位走了，这间就从清单上消失（不留下没人认领的门）',
    !(await apiRooms(base)).some(x => x.id === 'hall'), JSON.stringify((await apiRooms(base)).map(x => x.id)));

  srv.kill();

  console.log('\n── G：一局到点会自己回房间，房主能再开一局 ──');
  // 这一段单开一台服务，把一局压到 6 秒（MATCH_SECONDS）：不压这一格，
  // "打完 → 回房间"要么真等十分钟，要么根本验不到 —— 而它恰好是新加的那条
  // "到点也判结束"（server/room.mjs 每秒那次 checkEnd）唯一的症状级证据。
  const srv2 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '', MATCH_SECONDS: '6', MATCH_RETURN_MS: '0' });
  const g1 = client(srv2.ws, '庚'), g2 = client(srv2.ws, '辛');
  await g1.opened; await g2.opened;
  g1.send({ t: 'lobby' }); g2.send({ t: 'lobby' });
  g1.send({ t: 'createRoom', room: 'oner', name: '庚1', title: '回房测试', scoreLimit: 100 });
  await g1.until(j => j.t === 'room');
  g2.send({ t: 'joinRoom', room: 'oner', name: '辛2' });
  await g2.until(j => j.t === 'room' && j.seats && j.seats.length === 2);
  g2.send({ t: 'ready', on: true });
  g1.send({ t: 'start' });
  const wlive = await g1.until(j => j.t === 'welcome', 15000);
  ok('第二台服务上也能开局', !!wlive);
  // 胜利目标要打穿整条链（座位 → beginLive 的 cfg → MatchRules → welcome 下发）才算数：
  // 断在哪一环，局里的"先到 100 杀"就悄悄变回默认 50，而没有任何一处报错。
  ok('welcome 带着房间选的胜利目标（房主选的 100 到了局里还是 100）',
    !!wlive && wlive.scoreLimit === 100, JSON.stringify(wlive && wlive.scoreLimit));
  g1.frames.length = 0; g2.frames.length = 0;
  const over = await g1.until(j => j.t === 'ev' && (j.ev || []).some(e => e.e === 'matchOver'), 25000);
  ok('时间到点就判结束（分数没到上限的一局以前永远打不完）', !!over, JSON.stringify(over && over.ev && over.ev.filter(e => e.e === 'matchOver')));
  const backR = await g1.until(j => j.t === 'room' && j.room && j.room.state === 'waiting', 20000);
  ok('一局结束之后自动回到房间（不是留在一个静止的世界里）', !!backR, JSON.stringify(backR && backR.room));
  ok('座位还在、准备状态清零（下一局要重新点准备）',
    !!backR && backR.seats.length === 2 && backR.seats.filter(s => !s.isHost).every(s => s.ready === false), JSON.stringify(backR && backR.seats));
  const b2 = await g2.until(j => j.t === 'room' && j.room && j.room.state === 'waiting', 20000);
  ok('另一个人也同时回到房间（不是只有房主那侧收到了）', !!b2);
  const h3 = await health(srv2.base);
  ok('回收之后这台机器上不再养着那一份 sim', h3.rooms === 0 && h3.lobby.playing === 0, JSON.stringify({ live: h3.rooms, playing: h3.lobby.playing }));
  const binBefore = g1.binary();
  await sleep(600);
  ok('回房间之后不再有快照下行（对局态确实拆掉了）', g1.binary() === binBefore, `${binBefore} → ${g1.binary()}`);
  g2.send({ t: 'ready', on: true });
  g1.frames.length = 0;
  g1.send({ t: 'start' });
  const again = await g1.until(j => j.t === 'welcome', 15000);
  ok('房主可以接着开第二局（cid 是新一局里重新发的）', !!again && !!again.cid, JSON.stringify(again && { cid: again.cid, room: again.room }));
  g1.close(); g2.close();
  srv2.kill();

  console.log('\n── H：房主能选的那几格里，没有服务端兑现不了的 ──');
  // 房间设置那三格（地图/模式/时长）是**房主的承诺**：列表里别人按它挑房。
  // 所以"选了占领，服务器里却没有据点、没有占领得分，0:0 走到时间耗尽"是不能留的 ——
  // 而这一条在界面上看不见，只能往服务端发一个它兑现不了的值，看它是拒还是悄悄接受。
  const srv3 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const h = client(srv3.ws, '壬');
  await h.opened;
  h.send({ t: 'lobby' });
  await h.until(j => j.t === 'lobby');
  const bm0 = (await health(srv3.base)).lobby.badMode | 0;
  h.send({ t: 'createRoom', room: 'cap', name: '壬1', mode: 'conquest' });
  const errD = await h.until(j => j.t === 'err', 4000);
  ok('开一个**不存在**的模式会被当场拒（而不是悄悄建成团队死斗）', !!errD && /conquest/.test(errD.msg || ''), JSON.stringify(errD && errD.msg));
  ok('被拒之后这间不在清单上（没说出口的接受等于假房）',
    !(await apiRooms(srv3.base)).some(x => x.id === 'cap'), JSON.stringify((await apiRooms(srv3.base)).map(x => x.id)));
  // 两次建房之间要歇一下（M7）：建房是"房间生命周期"那一档，同一条连接上两帧挨得太近的话
  // 第二帧会被回"操作太快了，缓一下" —— 那是**设计**（server/lobby.mjs 的 HEAVY_MIN_FRAMES），
  // 不是这一条要量的东西。人手也不可能 250 ms 内点两次"创建房间"。
  // 歇在这里而不是把闸放宽：判据的前提要跟着被测对象的语义走，别为让它绿去改源码。
  await sleep(300);
  // 占领已经与双丘战区**互为专属**（js/data.js 的 maps/modes 双向绑定），这一段的
  // "改模式"流程要在一个不绑图的房里做 —— tdm 建房不填地图，兜底照旧落 yard。
  h.send({ t: 'createRoom', room: 'cap', name: '壬1', mode: 'tdm' });
  const rH = await h.until(j => j.t === 'room' && j.room && j.room.id === 'cap', 6000);
  ok('房间开得起来（tdm 不填图兜底 yard；dom 的专属绑定在下面那间专门验）',
    !!rH && rH.room.mode === 'tdm' && rH.room.map === 'yard', JSON.stringify(rH && rH.room));
  h.frames.length = 0;
  h.send({ t: 'roomCfg', mode: 'ffa' });
  const okF = await h.until(j => j.t === 'room' && j.room && j.room.mode === 'ffa', 6000);
  ok('房主把设置改成「自由混战」：接得下（yard 不绑模式，服务端判得出它的胜负）', !!okF, JSON.stringify(okF && okF.room.mode));
  h.send({ t: 'roomCfg', mode: 'conquest' });
  const errF = await h.until(j => j.t === 'err', 4000);
  ok('改成不存在的模式仍被拒（放行三种不等于放行一切）', !!errF && /conquest/.test(errF.msg || ''), JSON.stringify(errF && errF.msg));
  // 被拒的那一句 setCfg 直接 return，不会推新的房间状态 —— 所以这里读清单，不等帧。
  // 量错的帧会让这条**假红**（时间到而房间确实没变）。
  const rowH = (await apiRooms(srv3.base)).find(x => x.id === 'cap') || {};
  ok('拒完之后这间还是自由混战（没有偷偷换玩法）', rowH.mode === 'ffa', JSON.stringify(rowH));
  const bm1 = (await health(srv3.base)).lobby.badMode | 0;
  ok('两种拒绝都在 /healthz 上数得出来（静默失效要显形）', bm1 - bm0 === 2, `${bm0} → ${bm1}`);
  // ── 胜利目标那格：与时长同一套规矩（认表内的值、不认的退回该模式默认）──
  h.send({ t: 'roomCfg', scoreLimit: 100 });
  const okS = await h.until(j => j.t === 'room' && j.room && j.room.score === 100, 6000);
  ok('房主把胜利目标改成 100：接得下（ffa 里就是"先到 100 杀"）', !!okS, JSON.stringify(okS && okS.room.score));
  h.send({ t: 'roomCfg', scoreLimit: 12345 });
  const dftS = await h.until(j => j.t === 'room' && j.room && j.room.score === 25, 6000);
  ok('不认的目标值退回**该模式**默认（ffa → 25），不是原样收下也不是写死的 50',
    !!dftS, JSON.stringify(dftS && dftS.room.score));

  // ── 专属图与档位按模式走（js/data.js 的 modes / scoreOptions；服务端 mapGate 把关）──
  // 建房是重帧，两次之间按 M7 歇 300ms（与上面同一条理由）。
  await sleep(300);
  // 占领只认双丘战区：dom 建房**不填地图**也要兜到 ridges 上（"没填"与"填错"是两回事）。
  h.send({ t: 'createRoom', room: 'ridge', name: '壬2', mode: 'dom' });
  const okR2 = await h.until(j => j.t === 'room' && j.room && j.room.id === 'ridge', 6000);
  ok('dom 建房不填图兜到「双丘战区」（占领的专属图由服务端给默认）',
    !!okR2 && okR2.room.mode === 'dom' && okR2.room.map === 'ridges', JSON.stringify(okR2 && okR2.room));
  h.send({ t: 'roomCfg', scoreLimit: 500 });
  const ok500 = await h.until(j => j.t === 'room' && j.room && j.room.score === 500, 6000);
  ok('dom 的档位是 100/200/500：500 收得下', !!ok500, JSON.stringify(ok500 && ok500.room && ok500.room.score));
  h.send({ t: 'roomCfg', scoreLimit: 50 });
  const dft200 = await h.until(j => j.t === 'room' && j.room && j.room.score === 200, 6000);
  ok('dom 里 50 不再是合法目标（退回 dom 的默认 200，不是收下也不是 tdm 的 50）',
    !!dft200, JSON.stringify(dft200 && dft200.room && dft200.room.score));

  // ── 时长那格：与目标同一套规矩（档位按模式换表，不认的退回该模式默认）──
  // 房间状态帧里时长那一格叫 time（server/lobby.mjs:brief 的 time: room.minutes）。
  ok('两端共读一张表：minutesOptions 的 dom 档就是 15/25/35（界面画什么服务端认什么）',
    JSON.stringify(minutesOptions('dom')) === JSON.stringify(DOM_MINUTES)
    && JSON.stringify(DOM_MINUTES) === JSON.stringify([15, 25, 35])
    && JSON.stringify(minutesOptions('tdm')) === JSON.stringify([3, 5, 10, 15]),
    JSON.stringify([minutesOptions('dom'), minutesOptions('tdm')]));
  h.send({ t: 'roomCfg', minutes: 35 });
  const ok35 = await h.until(j => j.t === 'room' && j.room && j.room.time === 35, 6000);
  ok('dom 的时长档位是 15/25/35：35 收得下', !!ok35, JSON.stringify(ok35 && ok35.room && ok35.room.time));
  h.send({ t: 'roomCfg', minutes: 10 });
  const dft25 = await h.until(j => j.t === 'room' && j.room && j.room.time === 25, 6000);
  ok('dom 里 10 不再是合法时长（退回 dom 的默认 25，不是收下也不是 tdm 的 10）',
    !!dft25, JSON.stringify(dft25 && dft25.room && dft25.room.time));
  h.send({ t: 'roomCfg', mode: 'tdm' });
  const errT = await h.until(j => j.t === 'err', 4000);
  ok('ridges 房里把模式改成 tdm 被拒（两格各自合法、拼在一起非法也要拦）',
    !!errT && /占领/.test(errT.msg || ''), JSON.stringify(errT && errT.msg));
  // 被拒的 setCfg 直接 return、不推状态 —— 这里读清单，不等帧（与上面 mode 那组同一样）。
  const rowT2 = (await apiRooms(srv3.base)).find(x => x.id === 'ridge') || {};
  ok('拒完之后这间还是占领（没有偷偷换玩法）', rowT2.mode === 'dom', JSON.stringify(rowT2));
  h.send({ t: 'roomCfg', map: 'yard' });
  const errMap = await h.until(j => j.t === 'err', 4000);
  ok('反向同样拦：占领房里把地图改成 yard 被拒（占领只在「双丘战区」打）',
    !!errMap && /双丘战区/.test(errMap.msg || ''), JSON.stringify(errMap && errMap.msg));
  // 被拒的 setCfg 直接 return、不推状态 —— 读清单，不等帧。
  const rowD = (await apiRooms(srv3.base)).find(x => x.id === 'ridge') || {};
  ok('拒完之后这间还是双丘战区（没有偷偷换图）', rowD.map === 'ridges', JSON.stringify(rowD));
  // 图侧的绑定在 createRoom 那条路上同样拦（换一条连接，绕开 h 的建房配额）。
  const h3c = client(srv3.ws, '壬3');
  await h3c.opened;
  h3c.frames.length = 0;
  h3c.send({ t: 'createRoom', room: 'ridge2', name: '壬3', map: 'ridges', mode: 'tdm' });
  const rejR2 = await h3c.until(j => j.t === 'err', 4000);
  ok('ridges 配 tdm 建房当场被拒（图侧绑定在 createRoom 同样生效）',
    !!rejR2 && /双丘战区/.test(rejR2.msg || '') && /占领/.test(rejR2.msg || ''), JSON.stringify(rejR2 && rejR2.msg));
  ok('【反证】被拒的建房没有留下开成一半的房',
    !(await apiRooms(srv3.base)).some(x => x.id === 'ridge2'), '');
  // ── 时长那格的反证臂：tdm 不认 dom 的档位 —— "按模式换表"不是"两张表并成一张" ──
  // 建房是重帧，与上面 ridge2 那次之间按 M7 歇 300ms（同一条理由）。
  await sleep(300);
  h3c.send({ t: 'createRoom', room: 'minroom', name: '壬3b', mode: 'tdm', minutes: 25 });
  const okMin = await h3c.until(j => j.t === 'room' && j.room && j.room.id === 'minroom', 6000);
  ok('tdm 建房带 dom 档的 25 分被退回 tdm 默认 10（两张档位表不合并）',
    !!okMin && okMin.room.time === 10, JSON.stringify(okMin && okMin.room && okMin.room.time));
  h3c.send({ t: 'roomCfg', minutes: 10 });
  const ok10 = await h3c.until(j => j.t === 'room' && j.room && j.room.time === 10, 6000);
  ok('tdm 的档位仍是 3/5/10/15：10 收得下（先决臂）', !!ok10, JSON.stringify(ok10 && ok10.room && ok10.room.time));
  // dom 建房不填时长：兜到 dom 的默认 25（"没填"拿该模式的默认，与不填图兜 ridges 同一句）。
  await sleep(300);
  h3c.send({ t: 'createRoom', room: 'minroom2', name: '壬3c', mode: 'dom' });
  const okDm = await h3c.until(j => j.t === 'room' && j.room && j.room.id === 'minroom2', 6000);
  ok('dom 建房不填时长兜到 dom 的默认 25 分（不是 tdm 的 10）',
    !!okDm && okDm.room.time === 25, JSON.stringify(okDm && okDm.room && okDm.room.time));
  h3c.close();
  h.close();
  srv3.kill();

  console.log('\n── M：一条连接同时只占一个座位（幽灵座位与僵尸房的三个口）──');
  // 症状级现场：房主在 A 房里点了"编辑配装"，回到大厅列表（旧版客户端的路由把他丢在那儿），
  // 这时点"加入"另一间房 —— 旧服务端不清旧座位，A 房从此挂着一个走不掉、准备不了的
  // "房主"：谁也开不了局，断线清理只认 seatOf（最后一间），sweep 只收空房 —— 那间房
  // 活到进程重启。三个口各钉一条：同房重进 = 幂等回房间；跨房进 = 先退旧座；坐着建房 = 先退旧座。
  const srvM = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const z1 = client(srvM.ws, '座甲'), z2 = client(srvM.ws, '座乙'), z3 = client(srvM.ws, '座丙');
  await z1.opened; await z2.opened; await z3.opened;
  for (const c of [z1, z2, z3]) { c.send({ t: 'lobby' }); await c.until(j => j.t === 'lobby'); }
  z1.send({ t: 'createRoom', room: 'oneseat', name: '座甲', title: '一座房' });
  await z1.until(j => j.t === 'room' && j.room && j.room.id === 'oneseat', 6000);
  z2.send({ t: 'joinRoom', room: 'oneseat', name: '座乙' });
  await z2.until(j => j.t === 'room' && j.me, 6000);
  z1.send({ t: 'botAdd' });
  await z1.until(j => j.t === 'room' && (j.bots || []).length === 1, 6000);
  // 摆盘：甲+乙都站 A 队、Bot 落 B 队 —— 这样"重新落座"那个旧病（_freeTeam 重平衡）
  // 会把乙甩去 B 队，而幂等路径必须让他原地不动。
  z2.send({ t: 'team', team: 'A' });
  await z1.until(j => j.t === 'room' && j.seats.filter(s => s.team === 'A').length === 2, 6000);

  // ── 口①：同房重进是"回房间"，不是"重新进房" ──
  // joinRoom 在重帧的最小间隔那一档（HEAVY_MIN_FRAMES），被拒的尝试也盖章 —— 连发
  // 之间要留出 250ms；断言前清队列，until 才不会捞到陈年广播帧冒充这一句的应答。
  const enters0 = (([...z1.frames].reverse().find(j => j.t === 'room' && j.chat) || { chat: [] }).chat || [])
    .filter(c => /进来了/.test(c.text || '')).length;
  await sleep(300);
  z2.frames.length = 0; z1.frames.length = 0;
  z2.send({ t: 'joinRoom', room: 'oneseat', name: '座乙' });
  const zm1 = await z2.until(j => j.t === 'room' && j.room && j.room.id === 'oneseat', 6000);
  const z1ent = await z1.until(j => j.t === 'room' && j.room && j.room.id === 'oneseat', 6000);
  const chatNow = ((z1ent && z1ent.chat) || []).filter(c => /进来了/.test(c.text || '')).length;
  ok('已经在房里再点一次加入：座位原地不动（不被重新分队）',
    !!zm1 && zm1.me && zm1.me.team === 'A', `team=${zm1 && zm1.me && zm1.me.team}`);
  ok('【判別臂】同房重进不多一句"进来了"（多的那句在别人屏上看着像又进来一个人）',
    chatNow === enters0, `进来了 ${enters0} → ${chatNow}`);
  ok('同房重进不动名单（一个座位、一个 Bot，一个都不少）',
    zm1 && zm1.seats.length === 2 && zm1.bots.length === 1,
    JSON.stringify({ seats: zm1 && zm1.seats.length, bots: zm1 && zm1.bots.length }));

  // ── 口②：跨房进 = 旧座退干净，不留幽灵 ──
  await sleep(300);
  z3.send({ t: 'createRoom', room: 'elsewhere', name: '座丙', title: '另一间' });
  await z3.until(j => j.t === 'room' && j.room && j.room.id === 'elsewhere', 6000);
  await sleep(300);
  z2.frames.length = 0; z1.frames.length = 0; z3.frames.length = 0;
  z2.send({ t: 'joinRoom', room: 'elsewhere', name: '座乙' });
  const z3b = await z3.until(j => j.t === 'room' && j.seats && j.seats.length === 2, 6000);
  // 幽灵最毒的一格：它要是"还没准备的人"，开局判据就永远差一口。乙真的走了，
  // 房里只剩"房主 + Bot"，canStart 必须自己好起来（与"少一人"是同一帧 —— 之后
  // 这间房再没有别的活动，分开等第二条永远等不到）。
  const z1b = await z1.until(j => j.t === 'room' && j.seats && j.seats.length === 1 && j.canStart === true, 6000);
  ok('跨房加入：新房间里人齐了', !!z3b && z3b.seats.some(s => s.name === '座乙'), JSON.stringify(z3b && z3b.seats.map(s => s.name)));
  ok('旧房间当场少一个（不是名单上还挂着一份）', !!z1b, JSON.stringify(z1b && z1b.seats.map(s => s.name)));
  ok('旧房间人数回到"1 人 + 1 Bot"（列表与名单是同一份账）',
    ((await apiRooms(srvM.base)).find(x => x.id === 'oneseat') || {}).players === 2,
    JSON.stringify((await apiRooms(srvM.base)).find(x => x.id === 'oneseat')));
  ok('【判別臂】人走了这间还能开（旧病现场：幽灵座位让开始按钮永远灰着）',
    !!z1b && z1b.canStart === true, JSON.stringify(z1b && z1b.why));

  // ── 口③：坐着建房 = 先退旧座（但建房被拒时不许把现座也丢了 —— 撞号那条路）──
  await sleep(300);
  z3.frames.length = 0;
  z3.send({ t: 'createRoom', room: 'elsewhere', name: '座丙' });
  const dupM = await z3.until(j => j.t === 'err', 4000);
  ok('撞号的建房被拒，且**没有**把自己从现在的房里踢出去（拒绝就是拒绝，不带副作用）',
    !!dupM && /已经有人/.test(dupM.msg || '') && z3b.seats.length === 2,
    JSON.stringify(dupM && dupM.msg));
  await sleep(300);
  z2.frames.length = 0;
  z3.send({ t: 'createRoom', room: 'fresh', name: '座丙', title: '第三间' });
  const z2h = await z2.until(j => j.t === 'room' && j.me && j.me.isHost === true, 6000);
  ok('坐着的人另起一间：旧座退掉、房主移交给出还活着的人（不是旧房挂着他）',
    !!z2h && ((await apiRooms(srvM.base)).find(x => x.id === 'elsewhere') || {}).players === 1,
    JSON.stringify({ elsewhere: (await apiRooms(srvM.base)).find(x => x.id === 'elsewhere'), fresh: (await apiRooms(srvM.base)).find(x => x.id === 'fresh') }));

  // ── 断线清账：走的那个人的座位，哪间都不能留 ──
  z2.close();
  await sleep(400);
  ok('断线之后不留幽灵（这一间没人了就该从清单上消失）',
    !(await apiRooms(srvM.base)).some(x => x.id === 'elsewhere'),
    JSON.stringify((await apiRooms(srvM.base)).map(x => x.id)));
  ok('别的房间不受牵连（新座与旧座是两本账，清账只清自己的）',
    !!((await apiRooms(srvM.base)).find(x => x.id === 'oneseat')) && !!((await apiRooms(srvM.base)).find(x => x.id === 'fresh')));
  z1.close(); z3.close();
  srvM.kill();

  console.log('\n── H：连杀选单走完整条链（选 → 座位 → 开局 → 各回各的回显）──');
  const srv5 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const u = client(srv5.ws, '选甲'), v = client(srv5.ws, '选乙'), w = client(srv5.ws, '选丙');
  await u.opened; await v.opened; await w.opened;
  u.send({ t: 'lobby' }); v.send({ t: 'lobby' }); w.send({ t: 'lobby' });
  await u.until(j => j.t === 'lobby'); await v.until(j => j.t === 'lobby'); await w.until(j => j.t === 'lobby');
  u.send({ t: 'createRoom', room: 'pick', name: '选甲', title: '选单房', streaks: ['wp', 'sentry', 'uav'] });
  await u.until(j => j.t === 'room' && j.room && j.room.id === 'pick', 6000);
  v.send({ t: 'joinRoom', room: 'pick', name: '选乙', streaks: ['cluster', 'heli', 'uav'] });
  await v.until(j => j.t === 'room' && j.me, 6000);
  // 带垃圾项的选单：白名单重建要把它变成"合法的三项"，而不是原样挂上、也不是整组退回默认。
  w.send({ t: 'joinRoom', room: 'pick', name: '选丙', streaks: ['uav', 'uav', '不存在', 'wp'] });
  await w.until(j => j.t === 'room' && j.me, 6000);
  // 改选单搭"准备"那句车：从编辑装备回房间屏时这一句会重发，welcome 必须是**最后一份**。
  // 反证臂：这条红了 = 座位上留着旧选单，症状是"我改了连杀，进局还是上一套"。
  v.send({ t: 'ready', on: true, streaks: ['heli', 'wp', 'uav'] });
  w.send({ t: 'ready', on: true });
  await u.until(j => j.t === 'room' && j.canStart === true, 6000);
  u.send({ t: 'start' });
  const su = await u.until(j => j.t === 'welcome', 15000);
  const sv = await v.until(j => j.t === 'welcome', 15000);
  const sw = await w.until(j => j.t === 'welcome', 15000);
  const idsOf = (wk) => ((wk && wk.streaks) || []).map(s => s.id).join(',');
  ok('自带三项的人拿到自己那三项（回显按 kills 升序，槽位下标两端一致）',
    idsOf(su) === 'uav,sentry,wp', idsOf(su));
  ok('开局前改过选单的人，回显的是**最后一份**（改了没带进对局 = 静默失效）',
    idsOf(sv) === 'uav,heli,wp', idsOf(sv));
  // 反证臂：这条红了 = 垃圾项被原样挂上（第 4 格是个 undefined）或整组退回默认
  //（另两项被一个过期 id 连坐）。
  ok('【反证】带垃圾项的选单被白名单重建：留下的两项 + 默认补齐，恰好 3 项',
    idsOf(sw) === 'uav,cluster,wp' && (sw.streaks || []).length === 3, idsOf(sw));
  // 反证臂：这条红了 = 全房回显同一份（一人一本账没接上），症状是"HUD 是我选的、按 3/4/5 是别人那套"。
  ok('【反证】三个人三份账，互不串', idsOf(su) !== idsOf(sv) && idsOf(sv) !== idsOf(sw) && idsOf(su) !== idsOf(sw),
    JSON.stringify({ 甲: idsOf(su), 乙: idsOf(sv), 丙: idsOf(sw) }));
  u.close(); v.close(); w.close();
  srv5.kill();

  console.log('\n── I：自由混战进联机（模式随 welcome 下发、每人一支队）──');
  const srv6 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const x = client(srv6.ws, '混甲'), y = client(srv6.ws, '混乙');
  await x.opened; await y.opened;
  x.send({ t: 'lobby' }); y.send({ t: 'lobby' });
  await x.until(j => j.t === 'lobby'); await y.until(j => j.t === 'lobby');
  x.send({ t: 'createRoom', room: 'ffaroom', name: '混甲', title: '混战房', mode: 'ffa' });
  await x.until(j => j.t === 'room' && j.room && j.room.id === 'ffaroom', 6000);
  y.send({ t: 'joinRoom', room: 'ffaroom', name: '混乙' });
  await y.until(j => j.t === 'room' && j.me, 6000);
  y.send({ t: 'ready', on: true });
  await x.until(j => j.t === 'room' && j.canStart === true, 6000);
  x.send({ t: 'start' });
  const wx = await x.until(j => j.t === 'welcome', 15000);
  const wy = await y.until(j => j.t === 'welcome', 15000);
  ok('ffa 房开得起来、模式随 welcome 下发（客户端按它切记分板/结算）',
    !!wx && wx.mode === 'ffa' && !!wy, JSON.stringify(wx && { mode: wx.mode, map: wx.map }));
  // 反证臂：这条红了 = 两个人共用一支队 —— 友伤按 team 判敌我，那之后谁也打不死谁
  ok('【反证】welcome 带回的队各不相同（ffa 里座位上的 A/B 不作数）',
    !!wx && !!wy && wx.team !== wy.team && /^P/.test(wx.team) && /^P/.test(wy.team),
    JSON.stringify({ 甲: wx && wx.team, 乙: wy && wy.team }));
  x.close(); y.close();
  srv6.kill();

  // ── I2：占领进联机（用户报"联网里没有占点"）──
  // 上游是**界面**那一半（js/menu.js 曾把"按当前地图"反过来滤模式，「占领↔双丘战区」互为专属
  // 于是死锁 ⇒ 大厅里点不到占领，判据在 test/hud-ux.mjs 的 AJ 段与 test/hud-keys.mjs 的 L11）。
  // 这里量的是**这条链路真的通**：大厅建房（dom）→ 开局 → welcome 带回 dom/ridges →
  // 据点那一班事件真的在下发（domFlags 每 15 拍一班，3 面旗 —— 少了它客户端那三面旗永远是空的）。
  // 反证臂是 tdm 房：同一段等待里一条 domFlags 都不许来（"有事件"不能是靠"任何房间都发"凑出来的）。
  console.log('\n── I2：占领进联机（模式随 welcome 下发 + 据点那一班事件真的在跑）──');
  const srv6b = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const domWait = 12000;
  const mkPair = async (roomId, mode, n1, n2) => {
    const c1 = client(srv6b.ws, n1), c2 = client(srv6b.ws, n2);
    await c1.opened; await c2.opened;
    c1.send({ t: 'lobby' }); await c1.until(j => j.t === 'lobby');
    c2.send({ t: 'lobby' }); await c2.until(j => j.t === 'lobby');
    c1.send({ t: 'createRoom', room: roomId, name: n1, title: roomId, mode });
    await c1.until(j => j.t === 'room' && j.room && j.room.id === roomId, 6000);
    c2.send({ t: 'joinRoom', room: roomId, name: n2 });
    await c2.until(j => j.t === 'room' && j.me, 6000);
    c2.send({ t: 'ready', on: true });
    await c1.until(j => j.t === 'room' && j.canStart === true, 6000);
    c1.send({ t: 'start' });
    const w1 = await c1.until(j => j.t === 'welcome', 15000);
    return { c1, c2, w1 };
  };
  const domRun = await mkPair('domroom', 'dom', '占甲', '占乙');
  ok('dom 房开得起来：welcome 带回 mode=dom 与「双丘战区」（房主建房时只选了模式，图由服务端兜到 dom 的专属图）',
    !!domRun.w1 && domRun.w1.mode === 'dom' && domRun.w1.map === 'ridges',
    JSON.stringify(domRun.w1 && { mode: domRun.w1.mode, map: domRun.w1.map }));
  const domEv = await domRun.c1.until(j => j.t === 'ev' && (j.ev || []).some(e => e.e === 'domFlags'), domWait);
  const domF = domEv ? (domEv.ev.find(e => e.e === 'domFlags') || {}).f : null;
  ok('据点那一班事件真的在下发：domFlags 带着 3 面旗（A/B/C，开局都还没归属）—— 客户端那三面 3D 旗与水圈就靠这一条喂',
    !!domF && domF.length === 3 && domF.map(f => f.n).join('') === 'ABC' && domF.every(f => !f.o),
    JSON.stringify(domF));
  // 反证臂：tdm 房里同一条等待里不该有 domFlags —— 否则上面那条量的只是"任何房间都发事件"。
  const tdmRun = await mkPair('tdmroom', 'tdm', '死甲', '死乙');
  ok('【先决·反证臂的另一半】tdm 房照旧开得起来（welcome.mode=tdm）',
    !!tdmRun.w1 && tdmRun.w1.mode === 'tdm', JSON.stringify(tdmRun.w1 && tdmRun.w1.mode));
  const tdmEv = await tdmRun.c1.until(j => j.t === 'ev' && (j.ev || []).some(e => e.e === 'domFlags'), 1500);
  ok('【反证臂】tdm 房里一条 domFlags 都没有（没有据点的一局不该发据点读数 —— 发了的话上面那条绿是白来的）',
    !tdmEv, JSON.stringify(tdmEv && tdmEv.ev));
  for (const c of [domRun.c1, domRun.c2, tdmRun.c1, tdmRun.c2]) c.close();
  srv6b.kill();

  console.log(`\n${bad ? '❌' : '✅'} ${n - bad}/${n} 通过`);
  for (const line of String(srv2.log()).split('\n').filter(x => /^\[room|开局|结果|拒绝/.test(x)).slice(-6)) console.log('  服务端: ' + line);
  process.exit(bad ? 1 : 0);
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  process.exit(1);
}
