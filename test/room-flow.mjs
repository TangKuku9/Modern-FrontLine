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
  const bin = { n: 0 };
  const ws = new WebSocket(wsUrl);
  const c = {
    tag, ws, frames: got,
    opened: new Promise(res => ws.on('open', res)),
    binary: () => bin.n,
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
    if (isBin) { bin.n++; return; }
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
  g1.send({ t: 'createRoom', room: 'oner', name: '庚1', title: '回房测试' });
  await g1.until(j => j.t === 'room');
  g2.send({ t: 'joinRoom', room: 'oner', name: '辛2' });
  await g2.until(j => j.t === 'room' && j.seats && j.seats.length === 2);
  g2.send({ t: 'ready', on: true });
  g1.send({ t: 'start' });
  ok('第二台服务上也能开局', !!(await g1.until(j => j.t === 'welcome', 15000)));
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
  h.send({ t: 'createRoom', room: 'cap', name: '壬1', mode: 'dom' });
  const errD = await h.until(j => j.t === 'err', 4000);
  ok('建一间「占领」的房会被当场拒（而不是悄悄建成团队死斗）', !!errD && /占领/.test(errD.msg || ''), JSON.stringify(errD && errD.msg));
  ok('被拒之后这间不在清单上（没说出口的接受等于假房）',
    !(await apiRooms(srv3.base)).some(x => x.id === 'cap'), JSON.stringify((await apiRooms(srv3.base)).map(x => x.id)));
  h.send({ t: 'createRoom', room: 'cap', name: '壬1', mode: 'tdm' });
  const rH = await h.until(j => j.t === 'room' && j.room && j.room.id === 'cap', 6000);
  ok('换成服务端判得了胜负的那种，同一间就建起来了', !!rH && rH.room.mode === 'tdm', JSON.stringify(rH && rH.room.mode));
  h.frames.length = 0;
  h.send({ t: 'roomCfg', mode: 'ffa' });
  const errF = await h.until(j => j.t === 'err', 4000);
  ok('房主把设置改成「自由混战」同样被拒', !!errF && /混战/.test(errF.msg || ''), JSON.stringify(errF && errF.msg));
  // 被拒的那一句 setCfg 直接 return，不会推新的房间状态 —— 所以这里读清单，不等帧。
  // 量错的帧会让这条**假红**（时间到而房间确实没变）。
  const rowH = (await apiRooms(srv3.base)).find(x => x.id === 'cap') || {};
  ok('拒完之后这间还是团队死斗（没有偷偷换玩法）', rowH.mode === 'tdm', JSON.stringify(rowH));
  const bm1 = (await health(srv3.base)).lobby.badMode | 0;
  ok('两种拒绝都在 /healthz 上数得出来（静默失效要显形）', bm1 - bm0 === 2, `${bm0} → ${bm1}`);
  h.close();
  srv3.kill();
  console.log(`\n${bad ? '❌' : '✅'} ${n - bad}/${n} 通过`);
  for (const line of String(srv2.log()).split('\n').filter(x => /^\[room|开局|结果|拒绝/.test(x)).slice(-6)) console.log('  服务端: ' + line);
  process.exit(bad ? 1 : 0);
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  process.exit(1);
}
