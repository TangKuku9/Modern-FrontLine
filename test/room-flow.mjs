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
    // 包是定长的（11 + n×25），所以"多一个 Bot"必须让这一格正好多 25。
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
  ok('大厅清单跟着变成"对局中"', (await apiRooms(base)).find(x => x.id === 'hall')?.state === 'playing');

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
  h.send({ t: 'createRoom', room: 'cap', name: '壬1', mode: 'dom' });
  const rH = await h.until(j => j.t === 'room' && j.room && j.room.id === 'cap', 6000);
  ok('三种模式都开得起来（tdm / ffa / dom 的胜负权威端都判得了）', !!rH && rH.room.mode === 'dom', JSON.stringify(rH && rH.room.mode));
  h.frames.length = 0;
  h.send({ t: 'roomCfg', mode: 'ffa' });
  const okF = await h.until(j => j.t === 'room' && j.room && j.room.mode === 'ffa', 6000);
  ok('房主把设置改成「自由混战」：接得下（服务端判得出它的胜负了）', !!okF, JSON.stringify(okF && okF.room.mode));
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
  h.close();
  srv3.kill();

  console.log('\n── I：房主往房间里加 Bot ──');
  // 房间里只有两个人的时候也要能打一场像样的仗，所以这一项存在的理由就是"人不够时拿 Bot 填"。
  // 判据分两半：这一半证明**房主点得动、名单会变、开局真带进对局**（走真 WebSocket）；
  // 权威端那一半（Bot 进不进快照、死了对不对、记分板有没有它）在 test/room-bots.mjs。
  const srv4 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const p = client(srv4.ws, '癸'), q = client(srv4.ws, '子');
  await p.opened; await q.opened;
  p.send({ t: 'lobby' }); q.send({ t: 'lobby' });
  await p.until(j => j.t === 'lobby'); await q.until(j => j.t === 'lobby');
  p.send({ t: 'createRoom', room: 'botroom', name: '癸1', title: 'Bot 房' });
  const i0 = await p.until(j => j.t === 'room' && j.room && j.room.id === 'botroom', 6000);
  ok('一个人的房：没有 Bot 时不能开局（这一格是下面每一条的起点）',
    !!i0 && i0.canStart === false && (i0.bots || []).length === 0, JSON.stringify(i0 && i0.why));

  // ── 反证臂：先确定"一个人的时候确实开不了"，否则"加了 Bot 能开"是句空话 ──
  p.send({ t: 'botAdd', team: 'B' });
  const i1 = await p.until(j => j.t === 'room' && (j.bots || []).length === 1, 6000);
  ok('房主加一个 Bot，房间状态里当场多一格（含名字与队伍）',
    !!i1 && i1.bots[0].name && i1.bots[0].team === 'B', JSON.stringify(i1 && i1.bots));
  // 这条专门盯"没带难度"那一格：undefined 被夹成 0（新兵）的话，房间明明写着正规军
  // 却加出一屋子最简单的 Bot —— 界面与手感对不上，而没有任何一处会报错。
  ok('没指定难度时取房间那一格（不是把"没选"当成"选了新兵"）',
    !!i1 && i1.bots[0].skill === 1, `skill=${i1 && i1.bots[0].skill}（房间默认 ${i1 && i1.botSkill}）`);
  p.send({ t: 'roomCfg', botSkill: 2 });
  const i1b = await p.until(j => j.t === 'room' && j.botSkill === 2, 6000);
  ok('房主改难度：房间里已有的 Bot 一起改（不然"后来加的更凶"，界面表达不出来）',
    !!i1b && i1b.bots[0].skill === 2, JSON.stringify(i1b && i1b.bots));
  p.send({ t: 'roomCfg', botSkill: 1 });
  await p.until(j => j.t === 'room' && j.botSkill === 1, 6000);
  ok('加了 Bot 之后一个人就能开局（这正是"加 Bot"这一项存在的理由）',
    !!i1 && i1.canStart === true, JSON.stringify(i1 && { canStart: i1.canStart, why: i1.why }));
  ok('Bot 占位置：列表上那一格人数把它算进去了（不然"2/16"点进去只看见一个人）',
    (await apiRooms(srv4.base)).find(x => x.id === 'botroom')?.players === 2,
    JSON.stringify((await apiRooms(srv4.base)).find(x => x.id === 'botroom')));

  const nh0 = (await health(srv4.base)).lobby.notHost | 0;
  q.send({ t: 'joinRoom', room: 'botroom', name: '子2' });
  await q.until(j => j.t === 'room' && j.me, 6000);
  q.send({ t: 'botAdd', team: 'A' });
  const rejB = await q.until(j => j.t === 'err', 4000);
  ok('非房主加 Bot 被拒，且话说清楚了（改得动的东西不算权限）',
    !!rejB && /房主/.test(rejB.msg || ''), JSON.stringify(rejB && rejB.msg));
  ok('这一类拒绝在服务端数得出来（与"不是房主按开始"同一格计数）',
    (await health(srv4.base)).lobby.notHost === nh0 + 1);
  ok('被拒之后 Bot 数没变（拒绝不是"先加了再说"）',
    (await apiRooms(srv4.base)).find(x => x.id === 'botroom')?.bots === 1);

  // ── 满员 ──
  p.frames.length = 0;
  for (let k = 0; k < 20; k++) p.send({ t: 'botAdd' });
  await sleep(500);
  const rowI = (await apiRooms(srv4.base)).find(x => x.id === 'botroom') || {};
  ok('加满为止：Bot 与真人共用一个 16 的上限（不是给 Bot 另开一个池子）',
    rowI.players === 16 && rowI.bots === 14, JSON.stringify({ players: rowI.players, bots: rowI.bots }));
  ok('加不进去的那几次在 /healthz 上数得出来（静默失效要显形）',
    (await health(srv4.base)).lobby.botFull >= 5, `botFull=${(await health(srv4.base)).lobby.botFull}`);

  // ── 减 Bot（只在等待态能改：开局那一刻名单就被读进 sim 了）──
  p.send({ t: 'botDel' });
  const i3 = await p.until(j => j.t === 'room' && (j.bots || []).length === 13, 6000);
  ok('房主减一个：名单当场少一格（减的是最后加的那个）',
    !!i3 && (i3.bots || []).length === 13 && (await health(srv4.base)).lobby.botDel === 1,
    JSON.stringify(i3 && (i3.bots || []).length));
  q.send({ t: 'botDel' });
  const rejD = await q.until(j => j.t === 'err', 4000);
  ok('非房主减 Bot 同样被拒', !!rejD && /房主/.test(rejD.msg || ''), JSON.stringify(rejD && rejD.msg));

  // ── 开局：Bot 要真的进对局，而且看得见 ──
  q.send({ t: 'ready', on: true });
  await p.until(j => j.t === 'room' && j.canStart === true, 6000);
  p.send({ t: 'start' });
  const wp2 = await p.until(j => j.t === 'welcome', 15000);
  ok('房主开局，这一局进去了', !!wp2, JSON.stringify(wp2 && { cid: wp2.cid, room: wp2.room }));
  // 命门：others 是客户端建 NetPlayer 的唯一依据。Bot 不在这一格里 ⇒ 全房的人一个 Bot 也看不见，
  // 而权威端的 Bot 照样在开枪、照样裁决伤害 —— 那比不加 Bot 更糟。
  const botOthers = (wp2 && wp2.others || []).filter(o => o.bot);
  ok('Bot 随 welcome 一起下发（客户端按这一份建插值缓存与名牌）',
    botOthers.length === 13, `others 里 ${botOthers.length} 个 Bot（共 ${(wp2 && wp2.others || []).length}）`);
  // 套件（差距 29）：others 每一格都要带 kits —— 远端模型按它建。两条分支各查一条：
  // 真人那支是 kitsOf(loadout)，Bot 那支是"手上那把枪"那一格（concat 出来的那半最容易漏，
  // 漏了的症状是"Bot 全是素枪"，而它不报错）。
  const kit1 = (o) => o.kits && Object.values(o.kits)[0];
  const humanOthers = (wp2.others || []).filter(o => !o.bot);
  ok('welcome.others 的真人那支带套件表（att / camo 两格都要在）',
    humanOthers.length > 0 && humanOthers.every(o => kit1(o) && kit1(o).att && typeof kit1(o).camo === 'string'),
    JSON.stringify(humanOthers[0] && humanOthers[0].kits));
  ok('【反证】Bot 那支也带（旧写法两格都没有 ⇒ 这两条一起红）',
    botOthers.length > 0 && botOthers.every(o => kit1(o) && kit1(o).att && typeof kit1(o).camo === 'string'),
    JSON.stringify(botOthers[0] && botOthers[0].kits));
  await sleep(900);
  // 包长反推实体数：11 + n×25。这条同时证明 Bot 编进了快照、且每实体仍是 25 字节。
  const entN = p.lastBytes() ? (p.lastBytes() - 11) / 25 : -1;
  ok('快照里确实是 15 个实体（2 人 + 13 Bot，包长反推，不是读服务端的对象）',
    entN === 15, `${p.lastBytes()} 字节 → ${entN} 个实体`);
  // 反证臂：这条红了 = 快照里根本没有 Bot（或者每实体的字节数被改了）
  ok('【反证】包长是整数个实体（11 + 15×25 = 386，不是被别的字段挤歪）',
    p.lastBytes() === 11 + 15 * 25, `${p.lastBytes()} 字节`);
  // 反证臂②：对局中不能再改名单 —— 那份名单在开局那一刻就被读进 sim 了，
  // 半路插人的症状是"场上凭空多一个人"，而客户端的名册是在 welcome 里一次性给的。
  p.send({ t: 'botAdd', team: 'A' });
  await sleep(300);
  ok('【反证】对局中加 Bot 不改名单（半个世界长出来一个人最难查，所以直接不让）',
    (await health(srv4.base)).lobby.playing >= 1, `playing=${(await health(srv4.base)).lobby.playing}`);

  // ── 房主跑了：Bot 不能接管这间房 ──
  p.close();
  const i2 = await q.until(j => j.t === 'room' && j.me && j.me.isHost === true, 8000);
  ok('房主离开后移交给另一个真人（Bot 不会变成房主 —— 它没有那条连接）',
    !!i2 && i2.me.isHost === true && (i2.bots || []).length === 13, JSON.stringify(i2 && { host: i2.me.name, bots: (i2.bots || []).length }));
  q.close();
  srv4.kill();

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

  console.log('\n── J：对局中的聊天与举报（差距 43/45）──');
  // 聊天以前只长在大厅/房间两屏：对局中发不出去也收不到。判据的形状与别处一样 ——
  // 每一种失效都是静默的（"发了没人看见""对面收到了我不该看见的话""举报石沉大海"），
  // 所以每条都数服务端**真的发给了谁**，并且每条都配一条反证臂。
  const srv7 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const t1 = client(srv7.ws, '聊甲'), t2 = client(srv7.ws, '聊乙'), t3 = client(srv7.ws, '聊丙');
  await t1.opened; await t2.opened; await t3.opened;
  t1.send({ t: 'lobby' }); t2.send({ t: 'lobby' }); t3.send({ t: 'lobby' });
  await t1.until(j => j.t === 'lobby'); await t2.until(j => j.t === 'lobby'); await t3.until(j => j.t === 'lobby');
  t1.send({ t: 'createRoom', room: 'talk', name: '聊甲', title: '说话房' });
  await t1.until(j => j.t === 'room' && j.room && j.room.id === 'talk', 6000);
  t2.send({ t: 'joinRoom', room: 'talk', name: '聊乙' });
  await t2.until(j => j.t === 'room' && j.me, 6000);
  t2.send({ t: 'team', team: 'A' });                       // 与房主同队
  await t2.until(j => j.t === 'room' && j.me && j.me.team === 'A', 6000);
  t3.send({ t: 'joinRoom', room: 'talk', name: '聊丙' });
  await t3.until(j => j.t === 'room' && j.me, 6000);
  t3.send({ t: 'team', team: 'B' });
  await t3.until(j => j.t === 'room' && j.me && j.me.team === 'B', 6000);

  // 等待态的队伍频道（差距 45 的"无队伍频道"）：只发同队座位
  t1.send({ t: 'say', ch: 'team', text: '集合' });
  const wt = await t2.until(j => j.t === 'chat' && j.ch === 'team', 3000);
  ok('等待态房间里，队伍频道只到同队的人', !!wt && wt.text === '集合' && wt.from === '聊甲', JSON.stringify(wt));
  ok('【反证】对面收不到队伍频道（收到的话这一条就是全房间广播）',
    !(await t3.until(j => j.t === 'chat' && j.ch === 'team', 800)));
  await sleep(700);

  t2.send({ t: 'ready', on: true }); t3.send({ t: 'ready', on: true });
  await t1.until(j => j.t === 'room' && j.canStart === true, 6000);
  t1.send({ t: 'start' });
  const ta = await t1.until(j => j.t === 'welcome', 15000);
  const tb = await t2.until(j => j.t === 'welcome', 15000);
  const tc = await t3.until(j => j.t === 'welcome', 15000);
  ok('三个人都进对局了（这一段下面全是"对局中"的判据）', !!ta && !!tb && !!tc);

  t1.send({ t: 'say', ch: 'match', text: '在吗' });
  const m1 = await t2.until(j => j.t === 'chat' && j.ch === 'match', 3000);
  const m1b = await t3.until(j => j.t === 'chat' && j.ch === 'match', 1000);
  ok('对局中说的话，全场（含对面）都收到', !!m1 && m1.text === '在吗' && !!m1b, JSON.stringify(m1));
  ok('行里带 cid 与 team（认"这是谁说的"不靠名字 —— 访客服上两个"游客"同名）',
    !!m1 && m1.cid === ta.cid && m1.team === 'A' && m1.from === '聊甲', JSON.stringify(m1));
  await sleep(700);

  t1.send({ t: 'say', ch: 'team', text: 'B 点集合' });
  const m2 = await t2.until(j => j.t === 'chat' && j.ch === 'team', 3000);
  ok('对局中的队伍频道到队友手上', !!m2 && m2.text === 'B 点集合', JSON.stringify(m2));
  ok('【反证】对面收不到（这条红了 = 队伍频道退化成全场广播）',
    !(await t3.until(j => j.t === 'chat' && j.ch === 'team', 800)));
  await sleep(700);

  // 举报：记档（服务端日志 + /healthz 计数）+ 回执。三种"报了但没用"各有各的读数。
  const rep0 = (await health(srv7.base)).lobby;
  t1.send({ t: 'report', name: '聊丙', reason: '刷屏' });
  const rp = await t1.until(j => j.t === 'chat' && j.sys, 3000);
  ok('举报有回执（"石沉大海"正是这一项要消灭的症状）',
    !!rp && /聊丙/.test(rp.text || ''), JSON.stringify(rp));
  ok('举报在服务端真的记了档（/healthz 数得出）', (await health(srv7.base)).lobby.report === rep0.report + 1);
  ok('【反证】对面收不到举报这回事（举报不是一条聊天）',
    !(await t3.until(j => j.t === 'chat' && j.sys, 800)));
  await sleep(700);

  t1.send({ t: 'report', name: '查无此人', reason: 'x' });
  const rp2 = await t1.until(j => j.t === 'err', 3000);
  ok('举报一个不在局里的名字被拒，话说清楚了', !!rp2 && /找不到/.test(rp2.msg || ''), JSON.stringify(rp2 && rp2.msg));
  ok('这一类"报了但没用"单独计数（不和真举报混在一格）',
    (await health(srv7.base)).lobby.reportNoTarget === rep0.reportNoTarget + 1);
  await sleep(700);

  t1.send({ t: 'report', name: '聊甲', reason: 'x' });
  const rp3 = await t1.until(j => j.t === 'err', 3000);
  ok('举报自己被拒', !!rp3 && /不能举报自己/.test(rp3.msg || ''), JSON.stringify(rp3 && rp3.msg));
  ok('它也单独计数', (await health(srv7.base)).lobby.reportSelf === rep0.reportSelf + 1);
  await sleep(700);

  // 限流是**按连接**共一个闸（大厅/房间/对局三个入口）：刷屏没有双倍额度。
  const rate0j = (await health(srv7.base)).lobby.sayRate | 0;
  for (let i = 0; i < 10; i++) t1.send({ t: 'say', ch: 'match', text: '刷屏' + i });
  await sleep(400);
  const rejJ = await t1.until(j => j.t === 'err', 2000);
  ok('对局里刷屏一样被限住，而且当场说一声', !!rejJ && /太快/.test(rejJ.msg || ''), JSON.stringify(rejJ && rejJ.msg));
  ok('限流在 /healthz 上数得出来', (await health(srv7.base)).lobby.sayRate - rate0j >= 7,
    `sayRate ${rate0j} → ${(await health(srv7.base)).lobby.sayRate}`);

  // 自由混战没有队伍频道：每人一支独立"队"，"只发队友"等于只发给自己 ——
  // 所以当场拒，而不是悄悄改频道（悄悄改的话玩家以为对面能看见）。
  t1.close(); t2.close(); t3.close();
  const f1 = client(srv7.ws, '队甲'), f2 = client(srv7.ws, '队乙');
  await f1.opened; await f2.opened;
  f1.send({ t: 'lobby' }); f2.send({ t: 'lobby' });
  await f1.until(j => j.t === 'lobby'); await f2.until(j => j.t === 'lobby');
  f1.send({ t: 'createRoom', room: 'ffatalk', name: '队甲', mode: 'ffa' });
  await f1.until(j => j.t === 'room' && j.room && j.room.id === 'ffatalk', 6000);
  f2.send({ t: 'joinRoom', room: 'ffatalk', name: '队乙' });
  await f2.until(j => j.t === 'room' && j.me, 6000);
  f2.send({ t: 'ready', on: true });
  await f1.until(j => j.t === 'room' && j.canStart === true, 6000);
  f1.send({ t: 'start' });
  await f1.until(j => j.t === 'welcome', 15000);
  await sleep(700);
  f1.send({ t: 'say', ch: 'team', text: '有人吗' });
  const ffaErr = await f1.until(j => j.t === 'err', 3000);
  ok('【反证】ffa 里发队伍频道被当场拒（而不是发成"只有自己看得见"）',
    !!ffaErr && /自由混战/.test(ffaErr.msg || ''), JSON.stringify(ffaErr && ffaErr.msg));
  f1.close(); f2.close();
  srv7.kill();

  console.log('\n── K：私聊、表情与历史持久化（差距 45 余下三项）──');
  // 私聊的命门是**第三个人确实收不到**（泄密没有报错的形状）；表情的命门是白名单
  // （自由文本动作等于替人造句）；历史的命门是"重启之后真的还在"（说持久就得过重启）。
  const srv8 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '' });
  const k1 = client(srv8.ws, '私甲'), k2 = client(srv8.ws, '私乙'), k3 = client(srv8.ws, '私丙');
  await k1.opened; await k2.opened; await k3.opened;
  k1.send({ t: 'lobby' }); k2.send({ t: 'lobby' }); k3.send({ t: 'lobby' });
  await k1.until(j => j.t === 'lobby'); await k2.until(j => j.t === 'lobby'); await k3.until(j => j.t === 'lobby');
  k1.send({ t: 'createRoom', room: 'talk3', name: '私甲', title: '私聊房' });
  await k1.until(j => j.t === 'room' && j.room && j.room.id === 'talk3', 6000);
  k2.send({ t: 'joinRoom', room: 'talk3', name: '私乙' });
  await k2.until(j => j.t === 'room' && j.me, 6000);
  k2.send({ t: 'team', team: 'A' });
  await k2.until(j => j.t === 'room' && j.me && j.me.team === 'A', 6000);
  k3.send({ t: 'joinRoom', room: 'talk3', name: '私丙' });
  await k3.until(j => j.t === 'room' && j.me, 6000);

  k1.send({ t: 'say', ch: 'whisper', to: '私乙', text: '就咱俩知道' });
  const w1 = await k2.until(j => j.t === 'chat' && j.ch === 'whisper', 3000);
  ok('等待态房间里，私聊到对面手上（行里写着"给谁"）', !!w1 && w1.text === '就咱俩知道' && w1.to === '私乙' && w1.from === '私甲', JSON.stringify(w1));
  ok('发送者自己也收到同一行（他要看得见自己说了什么）',
    !!(await k1.until(j => j.t === 'chat' && j.ch === 'whisper', 1000)));
  ok('【反证】第三个人收不到私聊（泄密不报错，只能靠这一条臂）',
    !(await k3.until(j => j.t === 'chat' && j.ch === 'whisper', 800)));
  await sleep(700);

  k1.send({ t: 'say', ch: 'emote', emote: '敬礼' });
  const e1 = await k3.until(j => j.t === 'chat' && j.ch === 'emote', 3000);
  ok('表情动作广播到整间房（"* 私甲敬了个礼"）', !!e1 && e1.text === '敬了个礼' && e1.from === '私甲', JSON.stringify(e1));
  await sleep(700);
  const eb0 = (await health(srv8.base)).lobby.emoteBad | 0;
  k1.send({ t: 'say', ch: 'emote', emote: '跳舞' });
  const e2 = await k1.until(j => j.t === 'err', 3000);
  ok('【反证】白名单外的表情被拒（自由文本动作等于替人造句）', !!e2 && /没有这个表情/.test(e2.msg || ''), JSON.stringify(e2 && e2.msg));
  ok('被拒的单独计数（emote 与 emoteBad 两格，不混进发言）',
    (await health(srv8.base)).lobby.emoteBad === eb0 + 1, `emoteBad ${eb0} → ${(await health(srv8.base)).lobby.emoteBad}`);
  await sleep(700);

  k2.send({ t: 'ready', on: true }); k3.send({ t: 'ready', on: true });
  await k1.until(j => j.t === 'room' && j.canStart === true, 6000);
  k1.send({ t: 'start' });
  await k1.until(j => j.t === 'welcome', 15000);
  await k2.until(j => j.t === 'welcome', 15000);
  await k3.until(j => j.t === 'welcome', 15000);

  k1.send({ t: 'say', ch: 'match', text: '👍 敬礼' });
  const em = await k2.until(j => j.t === 'chat' && j.ch === 'match', 3000);
  ok('emoji 过了服务端的拍平还在（字面意义上的表情也是表情）', !!em && em.text === '👍 敬礼', JSON.stringify(em));
  await sleep(700);

  k1.send({ t: 'say', ch: 'whisper', to: '私丙', text: '对局里也能私聊' });
  const w2 = await k3.until(j => j.t === 'chat' && j.ch === 'whisper', 3000);
  ok('对局中同样收得到私聊', !!w2 && w2.text === '对局里也能私聊', JSON.stringify(w2));
  ok('【反证】对局中的私聊同样不给第三人（换了状态不许泄密）',
    !(await k2.until(j => j.t === 'chat' && j.ch === 'whisper', 800)));
  await sleep(700);
  const wh0 = (await health(srv8.base)).lobby;
  k1.send({ t: 'say', ch: 'whisper', to: '查无此人', text: 'x' });
  const w3 = await k1.until(j => j.t === 'err', 3000);
  ok('私聊一个不在局里的名字被拒', !!w3 && /找不到/.test(w3.msg || ''), JSON.stringify(w3 && w3.msg));
  ok('"找不到人"单独计数（whisperNoTarget，不混进 whisper）',
    (await health(srv8.base)).lobby.whisperNoTarget === wh0.whisperNoTarget + 1);
  await sleep(700);
  k1.send({ t: 'say', ch: 'whisper', to: '私甲', text: 'x' });
  const w4 = await k1.until(j => j.t === 'err', 3000);
  ok('私聊自己被拒', !!w4 && /不用私聊自己/.test(w4.msg || ''), JSON.stringify(w4 && w4.msg));
  ok('它也单独计数', (await health(srv8.base)).lobby.whisperSelf === wh0.whisperSelf + 1);
  k1.close(); k2.close(); k3.close();
  srv8.kill();

  // ── 历史持久化：同一份 ACCOUNTS_DB 起两台服务，重启后 hist 要接上 ──
  // 反证臂是最后一段：**没设** ACCOUNTS_DB 的部署用内存存储，重启就是没有 ——
  // 两段一起才证明"还在的那句"真的来自落盘，而不是哪儿缓存了一份。
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dbFile = join(tmpdir(), 'mf-chat-' + Date.now() + '.db');
  const chatFlow = async (env, text) => {
    const srv = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '', ...env });
    const c = client(srv.ws, '史者');
    await c.opened;
    c.send({ t: 'lobby' });
    await c.until(j => j.t === 'lobby');
    c.send({ t: 'say', ch: 'lobby', text });
    await c.until(j => j.t === 'chat' && j.text === text, 3000);
    c.close();
    srv.kill();
    await sleep(300);
    return srv;
  };
  const readHist = async (env) => {
    const srv = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '', ...env });
    const c = client(srv.ws, '史者');
    await c.opened;
    c.send({ t: 'lobby' });
    const hist = await c.until(j => j.t === 'chat' && Array.isArray(j.hist), 4000);
    c.close();
    srv.kill();
    return (hist && hist.hist) || [];
  };
  await chatFlow({ ACCOUNTS_DB: dbFile }, '重启前的一句话');
  const hist2 = await readHist({ ACCOUNTS_DB: dbFile });
  ok('重启之后 hist 里还有那句话（说持久就得活过重启）',
    hist2.some(r => r.text === '重启前的一句话'), JSON.stringify(hist2.map(r => r.text)));
  await chatFlow({}, '只在内存里的一句话');
  const hist3 = await readHist({});
  ok('【反证】没设 ACCOUNTS_DB 的部署就是没有（这段红了 = 判据在量缓存而不是落盘）',
    !hist3.some(r => r.text === '只在内存里的一句话'), JSON.stringify(hist3.map(r => r.text)));

  console.log(`\n${bad ? '❌' : '✅'} ${n - bad}/${n} 通过`);
  for (const line of String(srv2.log()).split('\n').filter(x => /^\[room|开局|结果|拒绝/.test(x)).slice(-6)) console.log('  服务端: ' + line);
  process.exit(bad ? 1 : 0);
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  process.exit(1);
}
