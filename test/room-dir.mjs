// 跨进程房间目录的判据（README《已知缺口》第 5 条，附十五下半场收口的那条）。
//
// 量什么：目录开着时，"一个大厅、多台执行"的最小闭环真的成立 ——
//   本台的房在别台的清单里（带 url）、玩家能拿着 url 连过去打、
//   要账号的服上凭一张**一次性**门票过去、台崩了它的行从列表里消失；
// 目录关着时（缺省部署），一切与从前逐字节相同 —— 不多一行远端房，没有票可发。
//
// 三层各量各的（与 hardening/net-play 的分工同一条老规矩）：
//   U 单元：RoomDirectory 直接对着一个临时文件跑 —— diff 语义、TTL 扫除、门票的
//           一次性与过期，都用注入的时钟钉死，不等真实时间。
//   G 集成（访客服）：两台真服务共享一个目录文件 + 第三台不开目录 —— 发行的可见性、
//           跨台加入、人数传播、崩溃后 TTL 消失、反证（不开目录的台谁也看不见）。
//   D 集成（要账号的服）：门票的完整信任链 —— 本台验会话才发票、票只对目录里登记的
//           目标有效、消费一次即死、过期即死。
//
//   node test/room-dir.mjs
import { WebSocket } from 'ws';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer } from './with-server.mjs';
import { RoomDirectory } from '../server/room-dir.mjs';

let bad = 0, n = 0;
const ok = (label, cond, info = '') => {
  n++;
  if (cond) console.log(`  ✅ ${label}${info ? '  ' + info : ''}`);
  else { bad++; console.log(`  ❌ ${label}${info ? '  ' + info : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanups = [];
process.on('exit', () => { for (const f of cleanups) { try { rmSync(f, { force: true }); } catch { /* 尽力而为 */ } } });
const tmpDb = tag => { const f = join(tmpdir(), `room-dir-test-${process.pid}-${tag}.db`); cleanups.push(f, f + '-wal', f + '-shm'); return f; };

// 与 room-flow.mjs 同一把钳子：一条连接 + 按类型取帧的队列。
function client(wsUrl, tag, opts = {}) {
  const got = [];
  const ws = new WebSocket(wsUrl, opts);
  const c = {
    tag, ws, frames: got,
    opened: new Promise(res => ws.on('open', res)),
    // 握手被拒（401 等）：ws 库发 'unexpected-response'。拿回状态码，判据好写。
    rejected: new Promise(res => ws.on('unexpected-response', (_req, res2) => res(res2.statusCode)).on('error', () => res(0))),
    async until(p, ms = 6000) {
      const t0 = Date.now();
      for (;;) {
        const hit = got.find(p);
        if (hit) { got.splice(got.indexOf(hit), 1); return hit; }
        if (Date.now() - t0 > ms) return null;
        await sleep(30);
      }
    },
    send(o) { ws.send(JSON.stringify(o)); },
    close() { try { ws.close(); } catch { /* 已经在断了 */ } },
  };
  ws.on('message', d => { try { got.push(JSON.parse(String(d))); } catch { /* 非 JSON 下行不在本协议里 */ } });
  return c;
}

const api = async (base, path, body, cookie) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { /* 非 JSON 也当读数 */ }
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, json: json || {}, setCookie: setCookie ? setCookie.split(';')[0] : '' };
};

// ───────────────────────── U. 单元：对着一个临时文件钉死纯行为 ─────────────────────────
console.log('\n── U. 单元：RoomDirectory（注入时钟，不等真实时间）──');
{
  let clock = 1_000_000;
  const file = tmpDb('unit');
  const a = new RoomDirectory({ file, url: 'http://a:1', boot: 'boot-a', ttlMs: 1000, ticketTtlMs: 500, now: () => clock });
  const b = new RoomDirectory({ file, url: 'http://b:2', boot: 'boot-b', ttlMs: 1000, ticketTtlMs: 500, now: () => clock });

  a.publishAll([{ id: 'r1', title: '房一', map: 'yard', mode: 'tdm', players: 1, max: 16, ready: 0, time: 10, score: 75, state: 'waiting', host: '甲' }]);
  const seen = b.list();
  ok('U1 别台看见本台的行，带 remote:true 与那台的 url',
    seen.length === 1 && seen[0].remote === true && seen[0].url === 'http://a:1' && seen[0].id === 'r1' && seen[0].players === 1,
    JSON.stringify(seen[0] || {}));
  ok('U2 自己的行不在自己的 list 里（自己那份走本地路径，不回环）', a.list().length === 0);

  ok('U3 内容没变的重发不算"变了"（心跳不推屏）', a.publishAll([{ id: 'r1', players: 1, state: 'waiting', title: '房一', map: 'yard', mode: 'tdm', max: 16, ready: 0, time: 10, score: 75, host: '甲' }]) === false);
  ok('U4 人数变了算"变了"（这就是跨台人数传播的机制）', a.publishAll([{ id: 'r1', players: 2, state: 'waiting', title: '房一', map: 'yard', mode: 'tdm', max: 16, ready: 0, time: 10, score: 75, host: '甲' }]) === true);
  ok('U5 人数的变对别台可见', b.list()[0].players === 2);

  ok('U6 同 id 的两行并存（dkey = boot:id），各带各的 url',
    (b.publishAll([{ id: 'r1', players: 1, state: 'waiting', title: 'B 台的', map: 'yard', mode: 'tdm', max: 16, ready: 0, time: 10, score: 75, host: '乙' }]), true)
    && a.list().length === 1 && b.list().length === 1
    && a.list()[0].url === 'http://b:2' && b.list()[0].url === 'http://a:1');

  clock += 1500;   // 越过 TTL：两台的行都成死行，谁路过谁扫
  a.sweep();
  ok('U7 TTL 过了，死行被路过的人扫掉（一台崩溃，行在 TTL 内自然消失）',
    b.list().length === 0 && a.list().length === 0);

  const tok = a.mintTicket({ uk: 'k1', name: '甲', xp: 120 });
  ok('U8 门票消费一次给出身份', JSON.stringify(b.consumeTicket(tok)) === JSON.stringify({ key: 'k1', name: '甲', xp: 120 }));
  ok('U8【反证】同一张票第二台再消费必须拿不到（单次有效是消费的语义，不是约定）', b.consumeTicket(tok) === null);
  const tok2 = a.mintTicket({ uk: 'k2', name: '乙', xp: 0 });
  clock += 600;    // 越过 ticketTtl
  ok('U9 过期的票消费即拒', b.consumeTicket(tok2) === null);

  a.close(); b.close();
}

// ───────────────────────── G. 集成（访客服）：两台真服务 + 一台不开目录 ─────────────────────────
console.log('\n── G. 集成（访客可玩的服）：发布 / 跨台加入 / 人数传播 / TTL / 反证 ──');
{
  const dbFile = tmpDb('guest');
  const env = { JOIN_CODE: 'DIRTEST', REQUIRE_ACCOUNT: '0', ROOMS_DB: dbFile, ROOMS_BEAT_MS: '300', ROOMS_TTL_MS: '1200', HOST: '127.0.0.1' };
  const p1 = await withServer(env);
  const p2 = await withServer(env);
  const p3 = await withServer({ JOIN_CODE: 'DIRTEST', REQUIRE_ACCOUNT: '0', HOST: '127.0.0.1' });   // 反证臂：不开目录
  cleanups.push();  // withServer 的进程由各段自己收

  // 先决：两台都活着、目录开着
  const h1 = await api(p1.base, '/healthz');
  const h2 = await api(p2.base, '/healthz');
  ok('G0 先决：两台的 healthz 都自报目录开着，url 各指向自己',
    h1.json.roomDir && h2.json.roomDir && h1.json.roomDir.url === p1.base && h2.json.roomDir.url === p2.base,
    JSON.stringify(h1.json.roomDir));

  // G1 在 P1 上建一间等待房
  const c1 = client(p1.ws, 'P1房主');
  await c1.opened;
  c1.send({ t: 'createRoom', name: '房主甲', room: 'cross1', title: '跨台一', map: 'yard', mode: 'tdm', minutes: 10, scoreLimit: 75 });
  const room1 = await c1.until(j => j.t === 'room');
  ok('G1 先决：P1 上房间建起来了', !!room1 && room1.room && room1.room.id === 'cross1', room1 ? room1.room.id : '没等到 room 帧');

  // G2 P2 的 /api/rooms 与大厅帧都看得见它，带 P1 的 url
  const r2 = await api(p2.base, '/api/rooms');
  const row = (r2.json.rooms || []).find(x => x.id === 'cross1');
  ok('G2 别台的 /api/rooms 看得见这间房：remote:true + url 指向 P1',
    !!row && row.remote === true && row.url === p1.base && row.players === 1, JSON.stringify(row || {}));
  const c2 = client(p2.ws, 'P2看客');
  await c2.opened;
  c2.send({ t: 'lobby' });   // 进大厅频道（浏览器端 LobbyClient.onopen 发的就是这一句）
  const lb2 = await c2.until(j => j.t === 'lobby');
  const lbRow = ((lb2 && lb2.rooms) || []).find(x => x.id === 'cross1');
  ok('G3 ws 大厅帧与 /api/rooms 是同一份名单（远端行也在帧里）', !!lbRow && lbRow.remote === true && lbRow.url === p1.base);
  const r1 = await api(p1.base, '/api/rooms');
  const ownRow = (r1.json.rooms || []).find(x => x.id === 'cross1');
  ok('G4【反证】本台自己的行不带 remote 标记（客户端凭这一格分"本地直进"与"跨台"）',
    !!ownRow && ownRow.remote === undefined, JSON.stringify(ownRow || {}));

  // G5 跨台加入：P2 上的访客直接连 P1 的 ws（访客服不设闸、不需要票），进同一间房
  const c2b = client(p1.ws, 'P2来的访客');
  await c2b.opened;
  c2b.send({ t: 'joinRoom', name: '访客乙', room: 'cross1' });
  const joined = await c2b.until(j => j.t === 'room' && j.me);
  ok('G5 访客从 P2 的清单出发，真的进了 P1 上那间房', !!joined && joined.me && joined.me.name === '访客乙',
    joined ? `me=${joined.me && joined.me.name}` : '没等到 room 帧');

  // G6 人数的变传回 P2 的清单（发布是即时的：pushLobby 钩子）
  const r2b = await api(p2.base, '/api/rooms');
  const row2 = (r2b.json.rooms || []).find(x => x.id === 'cross1');
  ok('G6 进人之后 P2 清单里这一行的人数跟着涨（不用等心跳）', !!row2 && row2.players === 2, JSON.stringify(row2 || {}));

  // G7【反证】不开目录的台：它的房谁也看不见，它自己也发不出票
  const c3 = client(p3.ws, 'P3孤岛');
  await c3.opened;
  c3.send({ t: 'createRoom', name: '孤岛丙', room: 'island', title: '孤岛', map: 'yard', mode: 'tdm', minutes: 10, scoreLimit: 75 });
  await c3.until(j => j.t === 'room');
  const r1c = await api(p1.base, '/api/rooms');
  ok('G7【反证】没设 ROOMS_DB 的台，它的房不进别台的清单（缺省部署行为不变）',
    !(r1c.json.rooms || []).some(x => x.id === 'island'),
    `P1 清单：${(r1c.json.rooms || []).map(x => x.id).join(',') || '空'}`);
  const disp3 = await api(p3.base, '/api/dispatch', { room: 'x', url: p1.base });
  ok('G8 没开目录的台上 /api/dispatch 是 404（没有票可发，也没有"另一台"可言）', disp3.status === 404, `status=${disp3.status}`);

  // G9 TTL：P1 整台被杀（模拟崩溃），它的行在 TTL 内从 P2 的清单里消失
  const r2d = await api(p2.base, '/api/rooms');
  ok('G9 先决：P1 的房此刻还在 P2 的清单里', (r2d.json.rooms || []).some(x => x.id === 'cross1'));
  p1.kill();
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {   // TTL 1.2s + beat 0.3s，给 4 秒窗口（机器慢时也不假红）
    await sleep(100);
    const rr = await api(p2.base, '/api/rooms').catch(() => ({ json: { rooms: [] } }));
    gone = !(rr.json.rooms || []).some(x => x.id === 'cross1');
  }
  ok('G9 整台崩了，它的行在 TTL 内从别台的清单里消失（不需要谁去接管）', gone);
  c2.close(); c2b.close(); c3.close();
  p2.kill(); p3.kill();
  await sleep(100);
}

// ───────────────────────── D. 集成（要账号的服）：门票的完整信任链 ─────────────────────────
console.log('\n── D. 门票（要账号的服）：验会话才发票 / 目标必须在目录里 / 一次即死 / 过期即死 ──');
{
  const dbFile = tmpDb('auth');
  const env = { JOIN_CODE: 'DIRTEST', ROOMS_DB: dbFile, ROOMS_BEAT_MS: '300', ROOMS_TTL_MS: '1500', ROOMS_TICKET_TTL_MS: '600', HOST: '127.0.0.1' };
  const pa = await withServer(env);   // A 台：玩家登录在这里
  const pb = await withServer(env);   // B 台：房间在这里

  // 先决：甲在 A 台注册登录，乙在 B 台注册登录并建房
  const regA = await api(pa.base, '/api/register', { name: '甲台A', password: 'a-long-enough-password', code: 'DIRTEST' });
  ok('D0 先决：甲在 A 台注册拿到会话', regA.status === 200 && !!regA.setCookie, regA.json.error || '');
  const regB = await api(pb.base, '/api/register', { name: '乙台B', password: 'a-long-enough-password', code: 'DIRTEST' });
  ok('D0 先决：乙在 B 台注册拿到会话', regB.status === 200 && !!regB.setCookie, regB.json.error || '');

  const cb = client(pb.ws, 'B房主', { headers: { cookie: regB.setCookie } });
  await cb.opened;
  cb.send({ t: 'createRoom', room: 'broom', title: 'B台的房', map: 'yard', mode: 'tdm', minutes: 10, scoreLimit: 75 });
  const broom = await cb.until(j => j.t === 'room');
  ok('D1 先决：B 台上那间房建起来了（建房的 ws 握手认了 B 台自己的会话）', !!broom && broom.room && broom.room.id === 'broom');

  // A 台的清单看得见 B 台的房（账号服的目录回路与访客那半共用，这里只当先决看一眼）
  const listA = await api(pa.base, '/api/rooms', undefined, regA.setCookie);
  const rowA = (listA.json.rooms || []).find(x => x.id === 'broom');
  ok('D2 先决：A 台登录玩家的清单里有 B 台的房（remote + url）', !!rowA && rowA.remote === true && rowA.url === pb.base, JSON.stringify(rowA || {}));

  // D3 未登录拿不到票
  const noSess = await api(pa.base, '/api/dispatch', { room: 'broom', url: pb.base });
  ok('D3【反证】没会话的 dispatch 是 401（票只发给验过身份的人）', noSess.status === 401, `status=${noSess.status}`);
  // D4 目标不在目录里拿不到票（否则发票 = 把登录身份转发到任意地址）
  const bogus = await api(pa.base, '/api/dispatch', { room: 'broom', url: 'http://evil.example:1' }, regA.setCookie);
  ok('D4【反证】url 不在目录里的 dispatch 是 400（票不发去任意地址）', bogus.status === 400, `status=${bogus.status}`);
  // D5 正常拿票、凭票跨台握手、身份是票上那个人
  const tick = await api(pa.base, '/api/dispatch', { room: 'broom', url: pb.base }, regA.setCookie);
  ok('D5 A 台给登录玩家发了票', tick.status === 200 && !!tick.json.ticket, `status=${tick.status}`);
  const cCross = client(pb.ws + '?ticket=' + encodeURIComponent(tick.json.ticket || ''), 'A台的甲');
  await cCross.opened;
  cCross.send({ t: 'joinRoom', room: 'broom' });
  const crossed = await cCross.until(j => j.t === 'room' && j.me);
  ok('D6 凭票握手被放行，B 台上他的身份就是票上的呼号（join 不看自报的 name）',
    !!crossed && crossed.me && crossed.me.name === '甲台A', crossed ? `me=${crossed.me && crossed.me.name}` : '没等到 room 帧');

  // D7【反证】同一张票再用一次：握手 401（消费即死是原子的，不是"尽量别重复"）
  const again = client(pb.ws + '?ticket=' + encodeURIComponent(tick.json.ticket || ''), '重放票');
  const code = await Promise.race([again.rejected, sleep(3000).then(() => 0)]);
  ok('D7【反证】用过的票第二次握手被 401 拒（单次有效）', code === 401, `status=${code}`);
  // D8【反证】过期票：TTL 600ms，等过去再试
  const tick2 = await api(pa.base, '/api/dispatch', { room: 'broom', url: pb.base }, regA.setCookie);
  await sleep(900);
  const late = client(pb.ws + '?ticket=' + encodeURIComponent(tick2.json.ticket || ''), '过期票');
  const code2 = await Promise.race([late.rejected, sleep(3000).then(() => 0)]);
  ok('D8【反证】过了 TTL 的票握手被 401 拒（短有效期）', code2 === 401, `status=${code2}`);

  cCross.close(); cb.close();
  pa.kill(); pb.kill();
  await sleep(100);
}

console.log('');
if (bad) { console.log(`RED  ${n - bad}/${n} 通过，${bad} 条失败`); process.exit(1); }
console.log(`GREEN  跨进程房间目录：${n}/${n} 通过`);
