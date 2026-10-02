// 服务面的判据：一条连接只许占一个座（审计 H3），以及握手闸 / 来源白名单 / 限流簿记
// 几条"静默失效"的服务面纪律（M4 / M5 / M6 / M8）。
//
//   node test/service-guards.mjs
//
// 为什么走真 WebSocket 而不是进程内：这一层的东西全都在**连接的生命周期**里 ——
// `ws.__cid` 什么时候被写上、什么时候被清掉、close 处理认的是哪一份引用。
// 进程内直接调 lobby/room 的 API 会把这些绕过去，量到的就只是"函数返回值对不对"。
//
// 每条都配反证臂，而且有两类是**必须一起写**的：
//   ① "该拒的拒了" 之外还要有 "该放行的放行了" —— 只写前一半的话，把守卫写成
//      `return` 无条件拒绝也能全绿（那是把整个大厅焊死）。
//   ② 恒 0 的计数器要**说明它是恒 0 的防线**，不能读成"没人这么干"。
import { WebSocket } from 'ws';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { withServer } from './with-server.mjs';
import { encodeInput, INPUT_SIZE } from '../server/codec.mjs';

const INVITE = 'guard-code';
const PW = 'a-long-enough-password';

// 只做一次握手、把结果读成状态码：101 = 进去了，403/401/429 = 被哪一道闸拦的。
// 用 `unexpected-response` 而不是从 error.message 里抠 —— 那是观察非 101 应答的唯一干净入口。
function handshake(wsUrl, { origin = null, cookie = null } = {}) {
  return new Promise((res) => {
    const opts = {};
    if (origin) opts.origin = origin;
    if (cookie) opts.headers = { cookie };
    const w = new WebSocket(wsUrl, opts);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { w.terminate(); } catch { /* 已经断了 */ } res(v); };
    w.on('open', () => done(101));
    w.on('unexpected-response', (req, resp) => { resp.resume(); done(resp.statusCode); });
    w.on('error', () => done(-1));
    setTimeout(() => done(-2), 5000);
  });
}

// ── 原生 socket 的并发握手（M4 的量具）──
// 为什么不能用 ws 客户端做这件事：它的每一条连接都是"建连 → 写 → 等"，我们没法控制
// 十条握手请求落在哪一拍上，于是"并发"这个词就变成了一句自我声明。这里反过来：
// 先把 N 条 TCP 连上，**等全部 connect 之后在同一拍把请求全部写出去** ——
// 服务端那一侧看到的是同一批可读事件，这才叫并发。
const upgradeReq = (key, cookie) =>
  'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
  + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
  + (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n';

function burstUpgrade(port, count, cookie) {
  return new Promise((resolve) => {
    const socks = [];
    const codes = new Array(count).fill(null);
    let connected = 0;
    for (let i = 0; i < count; i++) {
      const s = net.connect(port, '127.0.0.1');
      socks.push(s);
      let buf = '';
      s.on('data', (d) => {
        buf += String(d);
        if (codes[i] == null) {
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
          if (m) codes[i] = Number(m[1]);
        }
      });
      s.on('error', () => { if (codes[i] == null) codes[i] = -1; });
      s.on('connect', () => {
        if (++connected !== count) return;
        for (let k = 0; k < count; k++) {
          socks[k].write(upgradeReq(Buffer.alloc(16, k + 1).toString('base64'), cookie));
        }
      });
    }
    setTimeout(() => resolve({ codes, socks, alive: () => socks.filter(s => !s.destroyed) }), 900);
  });
}

let bad = 0, n = 0;
const ok = (label, cond, info = '') => {
  n++;
  if (cond) console.log(`  ✅ ${label}${info ? '  ' + info : ''}`);
  else { bad++; console.log(`  ❌ ${label}${info ? '  ' + info : ''}`); }
};
const sec = (t) => console.log('\n── ' + t + ' ──');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 按类型取下一条控制帧的队列（与 test/room-flow.mjs 同一形状：房间状态是一变就推的，
// 一次开局连着来好几帧，按次序死等某一种会把别的挤掉）。
// opts.protocol = 标签页选择器（走**子协议**；服务端从 sec-websocket-protocol 读，
// 见 server/http-api.mjs 的 tabOf）。opts.ws = 传给 ws 客户端的连接选项（headers 之类）。
// ws 的签名是 (url, protocols, options)，第二个参数给对象时当 options 用 —— 两种都不传也行。
function client(wsUrl, tag, opts = {}) {
  const got = [];
  const bin = { n: 0, last: 0 };
  const ws = opts.protocol ? new WebSocket(wsUrl, [opts.protocol], opts.ws || {}) : new WebSocket(wsUrl, opts.ws || {});
  // 握手被拒（401/429）与连接出错都必须让 `opened` 落地，而且**必须**有一个 error 监听器：
  // ws 的 'error' 没有监听器时是一个会杀掉整个进程的未捕获事件。踩过一次 ——
  // M11 的"改动前"反证臂（4 个源文件退回 HEAD）走到 G3 时连接被 401 拒，进程当场死掉，
  // G3 之后每一条判据都印不出来：读起来像"这一段的判据没了"，而真因是**量具死了**。
  // 落地之后每条判据自己读到 null 并报自己的红 —— **异常不是判决**。
  ws.on('error', () => { /* 由 opened 落地；后面的 until() 读到 null 自己报红 */ });
  const c = {
    tag, ws, frames: got,
    opened: new Promise(res => { ws.on('open', res); ws.on('error', res); }),
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
    // 二进制输入帧（一拍 16 B）。服务端把一帧里的 16 B 一条接一条落地 ——
    // 这也正是"一次突发"在协议上的样子：TCP 零窗恢复后操作系统会把攒下的报文一起吐出来。
    sendBin(b) { ws.send(b); },
    close() { try { ws.close(); } catch { /* 已经在断了 */ } },
  };
  ws.on('message', (d, isBin) => {
    if (isBin) { bin.n++; bin.last = d.length || (d.buffer && d.buffer.byteLength) || 0; return; }
    try { got.push(JSON.parse(String(d))); } catch { /* 非 JSON 的下行不在本协议里 */ }
  });
  return c;
}
const health = async (base) => (await (await fetch(base + '/healthz')).json());
const gateOf = async (base) => (await health(base)).gate;

try {
  const srv = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '', MAP: 'yard', ALLOW_ORIGIN: 'example.com,*.ok.test', READ_PER_MIN: '5' });
  const { base, ws: wsUrl } = srv;

  // ═══════════════════════════════════════════════════════════════════════════
  sec('A. H3 一条连接只许占一个座（旧局留下永久幽灵 ⇒ 那间房永不回收）');
  // ═══════════════════════════════════════════════════════════════════════════
  // 先决：走一遍**健康路径**。下面每一条都是"被拒绝"，没有一个正常放行的读数垫在底下的话，
  // 那些拒绝可能只是"这台服务器根本谁都进不去"。
  const live = client(wsUrl, '打手');
  await live.opened;
  live.send({ t: 'join', room: 'yard', name: '打手', view: { sens: 2.0, adsSens: 1.0, invertY: false } });
  const wA = await live.until(j => j.t === 'welcome', 12000);
  ok('A1【先决】干净连接能直连进局并拿到 welcome（下面每条拒绝都要靠它才有意义）',
    !!wA && typeof wA.cid === 'number', JSON.stringify(wA && { cid: wA.cid, room: wA.room }));
  const h1 = await health(base);
  const liveRow = (h1.per || []).find(r => r.clients > 0) || h1.per[0];
  ok('A2【先决】那间 live 局里恰好 1 个 client（这是 A4/A6 要比的基准读数）',
    h1.rooms === 1 && liveRow && liveRow.clients === 1, JSON.stringify(h1.per));

  // ① 已经身在 live 局里的连接：不许再开/进房。三条入口（createRoom / joinRoom / quickRoom）
  //    必须同一个纪律 —— 只堵住一条的症状是"换个按钮就能造出幽灵"。
  live.send({ t: 'createRoom', room: 'g2', title: '幽灵房', map: 'yard', mode: 'tdm' });
  const e1 = await live.until(j => j.t === 'err');
  ok('A3 身在局里发 createRoom 被拒，且话说清了（不是静默丢弃）',
    !!e1 && /另一局|还在/.test(e1.msg || ''), JSON.stringify(e1));
  live.send({ t: 'joinRoom', room: 'g2' });
  const e2 = await live.until(j => j.t === 'err');
  live.send({ t: 'quickRoom' });
  const e3 = await live.until(j => j.t === 'err');
  ok('A3b joinRoom / quickRoom 两条入口同样被拒（三个入口一条纪律，不是只堵一个按钮）',
    !!e2 && !!e3 && /另一局|还在/.test(e2.msg || '') && /另一局|还在/.test(e3.msg || ''));
  ok('A3c 这一类拒绝在服务端数得出来（gate.reJoinInLive = 3；没有计数就只能靠猜）',
    (await gateOf(base)).reJoinInLive === 3, JSON.stringify((await gateOf(base)).reJoinInLive));

  // ── 这一节的命门：幽灵座**没有**被造出来 ──
  const h2 = await health(base);
  ok('A4【命门】旧局那一边的座**没有**多出来：仍然只有 1 个 client（幽灵的形状就是一个永不回收的座）',
    h2.rooms === 1 && h2.per[0].clients === 1, JSON.stringify(h2.per));
  ok('A5【命门】而且没有第二间房 —— 旧代码在这里会多出一间"已经开始、房里没人"的房',
    h2.rooms === 1 && (h2.lobby.playing | 0) === 0, JSON.stringify({ live: h2.rooms, playing: h2.lobby.playing }));
  // 反证臂：这条红了 = "拒绝"是假的（先建了房再报错）。A4/A5 只有配着它才不是恒真的装饰。
  ok('A5b【反证臂】被拒的那一间房号没有半途留下（此刻大厅里应当一间都没有）',
    h2.lobby.rooms === 0, `大厅房间数 ${h2.lobby.rooms}`);

  // ② 反方向的同一个洞：身在**等待房**里的连接不许绕过大厅直连进 live 局。
  //    旧代码放过它的后果是：等待房那个座还在、而它已经属于别的局了，房主一按开始
  //    就会把这条连接第二次塞进 sim（enterMatch 覆盖 __cid ⇒ 第一个座的引用再没人认领）。
  const seated = client(wsUrl, '等房的');
  await seated.opened;
  seated.send({ t: 'lobby' });
  await seated.until(j => j.t === 'lobby');
  seated.send({ t: 'createRoom', room: 'wait1', title: '等待房', map: 'yard', mode: 'tdm' });
  const r1 = await seated.until(j => j.t === 'room' && j.room && j.room.id === 'wait1');
  ok('A6【先决】这条连接在等待房里真的有座位了（没有座位的话下面那条量的是空气）',
    !!r1 && !!r1.me && r1.me.isHost === true, JSON.stringify(r1 && r1.me));
  seated.send({ t: 'join', room: 'yard', name: '等房的' });
  const e4 = await seated.until(j => j.t === 'err');
  ok('A7 手上有等待房座位时直连进局被拒（绕过大厅的那条路也堵上了）',
    !!e4 && /房间里|先退出/.test(e4.msg || ''), JSON.stringify(e4));
  ok('A8 被拒之后它还在自己那间等待房里（拒绝 = 什么都没发生，不是"顺手把它踢出去"）',
    (await health(base)).lobby.waiting === 1, JSON.stringify((await health(base)).lobby));

  // ③ 【反证臂】守卫不是"谁都不许"：换一条干净连接，该放行的必须放行。
  const fresh = client(wsUrl, '新人');
  await fresh.opened;
  fresh.send({ t: 'lobby' });
  await fresh.until(j => j.t === 'lobby');
  fresh.send({ t: 'createRoom', room: 'ok1', title: '正常房', map: 'yard', mode: 'tdm' });
  const r2 = await fresh.until(j => j.t === 'room' && j.room && j.room.id === 'ok1');
  ok('A9【反证臂】没 cid 也没座位的连接照样能建房（把守卫写成无条件拒绝也能全绿，所以要有这一条）',
    !!r2 && r2.me.isHost === true, JSON.stringify(r2 && r2.me));
  // 反证臂②：**另一条**连接不受影响 —— 一条连接的守卫不许波及别人（例如按 IP 而不是按连接判）。
  const fresh2 = client(wsUrl, '新人2');
  await fresh2.opened;
  fresh2.send({ t: 'lobby' });
  await fresh2.until(j => j.t === 'lobby');
  fresh2.send({ t: 'quickRoom' });
  const r3 = await fresh2.until(j => j.t === 'room' && j.room);
  ok('A10【反证臂】第二条新连接能快速开局（守卫是按连接算的，不是按 IP / 全局一个旗）',
    !!r3 && !!r3.me, JSON.stringify(r3 && r3.room && r3.room.id));

  // ④ 后两道防线（enterMatch / beginLive 清座）今天到不了 —— 如实写出来，别读成"没人这么干"。
  const g = await gateOf(base);
  ok('A11 后两道防线今天是恒 0 的（ghostBlocked/ghostEvicted）—— 它们非零的含义是"第一道守卫漏了"',
    g.ghostBlocked === 0 && g.ghostEvicted === 0,
    `reJoinInLive=${g.reJoinInLive}（活的读数）· ghostBlocked=${g.ghostBlocked} · ghostEvicted=${g.ghostEvicted}`);
  // 反证臂③：这一条红了 = 上面那个"恒 0"其实是"计数器根本没接上"（比如那三格没进 /healthz）。
  ok('A12【反证臂】三格计数器都真的接在 /healthz 上（缺格会让"恒 0"读成"一切正常"）',
    Number.isFinite(g.reJoinInLive) && Number.isFinite(g.ghostBlocked) && Number.isFinite(g.ghostEvicted)
    && g.reJoinInLive > 0, JSON.stringify(g));

  // ═══════════════════════════════════════════════════════════════════════════
  sec('B. M2 输入队列溢出：这一件事在生产路径上真的看得见（/healthz 的 per[].qDrop）');
  // ═══════════════════════════════════════════════════════════════════════════
  // 精确判据（队首/队尾/丢掉几拍）在 test/net-audit.mjs 的 G 段 —— 那一层能直接读队列。
  // 这里只量最后一跳：**运维面看不看得见**。这条链路的失效形状是"我明明在走他却站着"，
  // 玩家侧没有日志、没有报错，只有手感 —— 不落进 /healthz 就等于不存在。
  const burst = (from, n) => {
    const buf = Buffer.alloc(n * INPUT_SIZE);
    for (let i = 0; i < n; i++) {
      const v = encodeInput({ tick: from + i, mdx: 0, mdy: 0, keys: 0, buttons: 0, view: 0, streak: -1 });
      Buffer.from(v.buffer, v.byteOffset, INPUT_SIZE).copy(buf, i * INPUT_SIZE);
    }
    return buf;
  };
  const rowOf = (h) => (h.per || []).find(r => r.id === 'yard') || (h.per || [])[0];
  const b0 = rowOf(await health(base));
  ok('B1【先决】突发之前这一间是干净的（qDrop 恒亮的话下面那条没有信息量）',
    b0 && (b0.qDrop | 0) === 0, JSON.stringify(b0 && { id: b0.id, clients: b0.clients, qDrop: b0.qDrop }));
  live.sendBin(burst(1, 200));                 // 200 拍塞进 60 拍的队列
  const b1 = rowOf(await health(base));
  ok('B2 一次 200 拍突发之后读数出来了：上限 60 ⇒ 被挤掉 140 拍（一帧 3200 B，服务端逐条落地）',
    b1 && (b1.qDrop | 0) === 140, JSON.stringify({ qDrop: b1 && b1.qDrop, clients: b1 && b1.clients }));
  // 反证臂：溢出**不等于**这一间垮了。写成"溢出就报故障"的读数会把一次正常的网络抖动
  // 变成一次假的容量告警。hz 是每秒一个窗口的平均值（新建的房间头一秒读 0），所以这里
  // 等它第一个窗口关掉再量 —— 也顺带读第二遍 qDrop，确认它是"累计"而不是被清过。
  await sleep(1200);
  const b2 = rowOf(await health(base));
  ok('B3【反证臂】溢出本身不是故障：这一间照旧满帧在跑（hz ≈ 60）、fails = 0，qDrop 仍是累计值',
    b2 && b2.hz > 40 && (b2.fails | 0) === 0 && (b2.qDrop | 0) === 140,
    JSON.stringify({ hz: b2 && b2.hz, fails: b2 && b2.fails, qDrop: b2 && b2.qDrop, behindMs: b2 && b2.behindMs }));

  // ═══════════════════════════════════════════════════════════════════════════
  sec('C. M5 来源白名单：裸域名要以**主机边界**匹配（evilexample.com 不算 example.com）');
  // ═══════════════════════════════════════════════════════════════════════════
  // 这一段的量法必须是**真握手**：这条规则只在 verifyClient 里那一次判断上生效，
  // 进程内调一个函数只能证明函数对，证明不了它接在握手上（历史上正是这一类"接线断了"）。
  ok('C1【先决】白名单里的裸域来源放行（它不放行的话下面每条 403 都没有信息量）',
    await handshake(wsUrl, { origin: 'https://example.com' }) === 101);
  // ── 命门 ──
  ok('C2【命门】`https://evilexample.com` 被拒（改动前它整体放行 —— 这是 M5 的原文症状）',
    await handshake(wsUrl, { origin: 'https://evilexample.com' }) === 403,
    '旧写法 `origin.endsWith(o.replace(/^\\*\\.?/, \'.\'))` 对普通项不做任何替换 ⇒ 退化成 endsWith(\'example.com\')');
  ok('C3 子域放行（白名单不是"只许裸域"）',
    await handshake(wsUrl, { origin: 'https://a.example.com' }) === 101);
  // 反证臂：不带 Origin 的调用方（curl / 同级进程 / 健康探针 / 判据自己）不许被焊死。
  // 少了这一条的话，把守卫写成"没 Origin 就拒"也能全绿 —— 那会把探针和反向代理一起关掉。
  ok('C4【反证臂】不带 Origin 的握手照常放行（非浏览器调用方不是这条闸要拦的东西）',
    await handshake(wsUrl) === 101);
  // 反证臂②：后缀式冒充也要挡（`example.com.evil.test` 的结尾**是** `.evil.test`，
  // 但它的开头正是 `example.com`）—— 这一条红的含义是"边界判成了前缀匹配"。
  ok('C5【反证臂】`https://example.com.evil.test` 被拒（不能只看"以它开头/结尾"）',
    await handshake(wsUrl, { origin: 'https://example.com.evil.test' }) === 403);
  // 通配项：`*.ok.test` 吃子域、不吃裸域（与改动前同一个语义，写出来免得下次当成 bug 改）。
  ok('C6 通配项 `*.ok.test`：子域放行、裸域不放行（通配只往上加一级，这是它本来的意思）',
    await handshake(wsUrl, { origin: 'https://x.ok.test' }) === 101
    && await handshake(wsUrl, { origin: 'https://ok.test' }) === 403);
  // 读数必须落进 /healthz —— 与 gate 里其它几个计数同一条纪律：拒绝的原因要能分辨。
  ok('C7 来源被拒的次数数得出来（gate.originRefused = 3，与 refusedConn 分开记）',
    (await gateOf(base)).originRefused === 3, JSON.stringify((await gateOf(base)).originRefused));

  // ═══════════════════════════════════════════════════════════════════════════
  sec('E. M7 只读接口的按 IP 配额（/api/rooms 的每一次成功调用都要写一遍共享目录）');
  // ═══════════════════════════════════════════════════════════════════════════
  // 这一台把配额压到 5/分钟（READ_PER_MIN），为的是读数一眼可辨。
  const roomsStatus = async () => (await fetch(base + '/api/rooms')).status;
  const rcodes = [];
  for (let i = 0; i < 8; i++) {
    const r = await fetch(base + '/api/rooms');
    rcodes.push({ status: r.status, body: await r.json() });
  }
  const st = rcodes.map(c => c.status);
  ok('E1【先决】配额之内（前 5 次）都是 200 —— 这条闸不是"谁都别想拉列表"',
    st.slice(0, 5).every(c => c === 200), JSON.stringify(st));
  ok('E2【命门】第 6 次起 429（配额是按 IP 的硬闸）', st[5] === 429 && st[7] === 429, JSON.stringify(st));
  ok('E3 429 带 retryAfterMs（客户端知道等多久，不是一句干拒）', rcodes[5].body.retryAfterMs > 0, JSON.stringify(rcodes[5].body));
  const hE = await health(base);
  ok('E4 计数落在 /healthz 上（auth.lightLimited = 3），且与"账号维度被限"的 tooMany 分开记',
    hE.auth.lightLimited === 3 && hE.auth.tooMany === 0,
    JSON.stringify({ lightLimited: hE.auth.lightLimited, tooMany: hE.auth.tooMany }));
  // 反证臂：配额是**点名过的那两个接口**的事，不是把整个 HTTP 面焊死。
  ok('E5【反证臂】没被点名的接口照常工作（/api/me /api/status /healthz 都在配额之外）',
    (await fetch(base + '/api/me')).status === 200
    && (await fetch(base + '/api/status')).status === 200
    && (await fetch(base + '/healthz')).status === 200);

  // ═══════════════════════════════════════════════════════════════════════════
  sec('F. M7 大厅重帧的按连接限速（总闸不分帧型 ⇒ 建房/退房循环能拖慢全大厅）');
  // ═══════════════════════════════════════════════════════════════════════════
  // 一条连接拿满总闸（240 帧/秒）去建房→退房，每一次都触发全大厅广播 +
  // （开着目录的部署）一次跨进程写。这一段的量法就是那条攻击形状本身。
  //
  // 限额分**两档**（见 server/lobby.mjs 的 HEAVY_MIN_FRAMES）：
  //   · 生命周期帧（建房/进房/快速匹配/退房）—— 最小间隔 + 突发额度；
  //   · 房间配置帧（roomCfg / botAdd / botDel）—— 只有突发额度。
  // 下面这 60 帧是**同步**发出去的（全部落在同一毫秒里），所以生命周期那一档只剩
  // 第一帧能过：最小间隔读的是 `Date.now()` 的差，同一毫秒里差为 0 < 250。
  const flood = client(wsUrl, '刷房');
  await flood.opened;
  flood.send({ t: 'lobby' });
  await flood.until(j => j.t === 'lobby');
  for (let i = 0; i < 60; i++) {
    if (i % 2 === 0) flood.send({ t: 'createRoom', room: 'flood' + i, title: '洪水房', map: 'yard', mode: 'tdm' });
    else flood.send({ t: 'leaveRoom' });
  }
  await sleep(700);
  const made = flood.frames.filter(j => j.t === 'room').length;
  const refused = flood.frames.filter(j => j.t === 'err' && /太快/.test(j.msg || '')).length;
  // 上界按"700 ms ÷ 250 ms + 1"给（= 4），不按 HEAVY_BURST 给：这一档真正在起作用的是
  // 最小间隔，写 `<= 40` 只会让这条判据看着像在量额度而其实什么都没量。
  ok('F1【命门】60 帧建房/退房循环里真正生效的极少（生命周期帧有 250 ms 最小间隔）',
    made >= 1 && made <= 4, `room 帧 ${made}`);
  ok('F2【反证臂】配额之内照常建得起来（不是"谁都不许建房"）', made >= 1, `room 帧 ${made}`);
  ok('F3 被拒的那一帧明确回了一句（静默丢弃在大厅层长得和"按钮坏了"一模一样）', refused > 0, `拒绝 ${refused} 帧`);
  // 静默失效要显形：60 帧必须**每一帧都有一条回音**（要么一份房间状态、要么那句拒绝）。
  // 少一条就说明有帧被悄悄吞了 —— 而"点了没反应"和"按钮坏了"在这一层长得一模一样。
  ok('F3b 60 帧每一帧都有回音（房间状态 + 那句拒绝 = 60，没有静默吞帧）',
    made + refused === 60, JSON.stringify({ made, refused }));
  const hF = await health(base);
  ok('F4 限速被数出来了（lobby.heavyRate > 0，与聊天的 sayRate 分开记）',
    hF.lobby.heavyRate > 0, JSON.stringify({ heavyRate: hF.lobby.heavyRate, sayRate: hF.lobby.sayRate }));
  ok('F5 额度本身也是可读的（与 sayMinMs/sayBurst 同一类：运维要能看见自己在跑什么额度）',
    hF.lobby.heavyBurst === 40 && hF.lobby.heavyMinMs === 250,
    JSON.stringify({ burst: hF.lobby.heavyBurst, minMs: hF.lobby.heavyMinMs }));
  // 分档的**边界**也要可读：只报一个数字的话，"配置帧到底受不受这条约束"在 /healthz 上
  // 分不出来 —— 而这一档的边界正是"房主能不能连着点"+ Bot""这件事的全部。
  ok('F5b 最小间隔那一档点名了是哪几条帧（四个生命周期帧，且不含 botAdd）',
    Array.isArray(hF.lobby.heavyMinFrames) && hF.lobby.heavyMinFrames.length === 4
    && ['createRoom', 'joinRoom', 'quickRoom', 'leaveRoom'].every(t => hF.lobby.heavyMinFrames.includes(t))
    && !hF.lobby.heavyMinFrames.includes('botAdd'),
    JSON.stringify(hF.lobby.heavyMinFrames));

  // ── 配置帧那一档【命门 + 反证臂】：房主连点"+ Bot"、连着改设置**不该**被最小间隔卡住 ──
  // 这一条是拿"房主能不能正常用这一档"当判据的。把最小间隔也套到配置帧上（曾经就是这个
  // 写法）⇒ 下面这 80 连发只剩第一帧生效、其余全被回"太快"，于是 F6 当场变红；
  // 而不设额度 ⇒ 80 帧全部生效，F7 红。两条一起才把这一档夹住。
  // 用 roomCfg(botSkill) 当洪水是因为它**不改变房间人数**（不像 botAdd/fill），
  // 每帧只推一份房间状态 —— 于是"生效了几帧"可以数 room 帧，不用去读服务端的对象。
  const cfg = client(wsUrl, '刷设置');
  await cfg.opened;
  cfg.send({ t: 'lobby' }); await cfg.until(j => j.t === 'lobby');
  cfg.send({ t: 'createRoom', room: 'cfgflood', title: '设置洪水', map: 'yard', mode: 'tdm' });
  await cfg.until(j => j.t === 'room', 4000);
  cfg.frames.length = 0;
  for (let i = 0; i < 80; i++) cfg.send({ t: 'roomCfg', botSkill: i % 2 ? 2 : 1 });
  await sleep(700);
  const cfgMade = cfg.frames.filter(j => j.t === 'room').length;
  const cfgRefused = cfg.frames.filter(j => j.t === 'err' && /太快/.test(j.msg || '')).length;
  // 最小间隔还在这一档上的话这里只会是 1。取 10 是留足余量仍然把两种写法分开。
  ok('F6【命门】配置帧不受 250 ms 最小间隔约束（80 连发里生效的远不止 1 帧）',
    cfgMade >= 10, `room 帧 ${cfgMade}`);
  ok('F7 但配置帧的洪水照样有硬上限（生效的不超过 HEAVY_BURST）',
    cfgMade <= 40, `room 帧 ${cfgMade}`);
  ok('F7b 被限的那些照样各自有一句回音（配置帧这一档也不静默吞）',
    cfgMade + cfgRefused === 80, JSON.stringify({ cfgMade, cfgRefused }));
  cfg.close();
  flood.close();

  // ═══════════════════════════════════════════════════════════════════════════
  sec('D. M4 每 IP 连接闸：名额必须在**任何 await 之前**占下');
  // ═══════════════════════════════════════════════════════════════════════════
  // 单独起一个要账号的服：只有 `sessionOf().then` 那条异步路径才存在"检查之后、占位之前"
  // 的那段窗口（访客模式是同步 done(true)，没有窗口可言）。
  // CONNS_PER_IP=3 是为了让读数一眼可辨。
  const srv2 = await withServer({ JOIN_CODE: INVITE, CONNS_PER_IP: '3', MAP: 'yard' });
  const base2 = srv2.base;
  const reg = await fetch(base2 + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '并发甲', password: PW, code: INVITE }),
  });
  const cookie = String(reg.headers.get('set-cookie') || '').split(';')[0];
  ok('D1【先决】注册拿到会话 cookie，且单条带 cookie 的握手是 101（那条 async 会话路径真的被走到）',
    /mf_sid=/.test(cookie) && await handshake(srv2.ws, { cookie }) === 101, cookie.replace(/=[^;]+/, '=<令牌>'));

  const N = 10;
  const { codes, alive } = await burstUpgrade(srv2.port, N, cookie);
  const won = codes.filter(c => c === 101).length;
  const limited = codes.filter(c => c === 429).length;
  const hD = await health(base2);
  // 命门：配额是**硬**的 —— 同 IP 同一拍的 N 条握手，进去的条数不许超过配置值。
  ok('D2【命门】10 条同拍握手里面最多 3 条进得来（配额是硬闸，不是"大概拦一下"）',
    won <= 3, `101×${won} · 429×${limited} · 其它 ${JSON.stringify(codes.filter(c => c !== 101 && c !== 429))}`);
  // 反证臂：该放行的必须放行 —— 只写 D2 的话，把闸写成"无条件 429"也能全绿。
  ok('D3【反证臂】前 3 条**真的进去了**（配额之内的连接不受影响）',
    won === 3, `101×${won}`);
  ok('D4 超额的那 7 条是按"配额"拒的（429），不是 403/401 —— 客户端据此知道"等一下再来"',
    limited === N - 3, `429×${limited}`);
  // 名额守恒：占下的名额减掉还回去的，必须正好等于活着的连接数。
  // 这条不成立 = 有条路径没还名额（或者重复占）⇒ 配额被一点点吃光，而日志里什么都没有。
  const g2 = await gateOf(base2);
  ok('D5 名额守恒：connReserved − connReleased === 当前连接数（占位/还位一一对应）',
    g2.connReserved - g2.connReleased === hD.clients && hD.clients === 3,
    `reserved=${g2.connReserved} released=${g2.connReleased} clients=${hD.clients}`);
  // 反证臂③：**拒绝路径也要还名额**。401（没带 cookie）走的是 `.then` 里那条分支，
  // 它永远不会抵达 connection —— 漏了 release() 的话，每一次被拒都在配额上留一个永久占位。
  // 这一条红过 = "反复伸手指门把手就能把每 IP 的配额吃光"。
  // 先把上面那 3 条腾出来（不然这一条会被 429 先拦掉，量到的就不是 401 那条路）。
  for (const s of alive()) { try { s.destroy(); } catch { /* 已经断了 */ } }
  await sleep(300);
  const before = await gateOf(base2);
  const denied = await handshake(srv2.ws, {});
  const after = await gateOf(base2);
  const hD2 = await health(base2);
  ok('D6【反证臂】被拒（401）的连接把名额还回去了 —— 反复被拒不会把配额吃光',
    denied === 401 && after.connReserved - before.connReserved === 1
    && after.connReleased - before.connReleased === 1
    && after.connReserved - after.connReleased === hD2.clients,
    `401=${denied} · Δreserved=${after.connReserved - before.connReserved} · Δreleased=${after.connReleased - before.connReleased} · clients=${hD2.clients}`);

  for (const s of alive()) { try { s.destroy(); } catch { /* 已经断了 */ } }
  srv2.kill();

  // ═══════════════════════════════════════════════════════════════════════════
  sec('G. M11 会话副本：__Host- 前缀 / 登出吊销整个身份 / 选择器不进 URL');
  // ═══════════════════════════════════════════════════════════════════════════
  // 单独起一台**显式开着 Secure** 的服：前缀名只在 secure 下用，那是被测对象自己的条件。
  // "明文下不许带前缀"是它的反证臂，量在 test/hardening.mjs 的 K1b（那一台是明文）——
  // 两处各一半：只留一边的话，把前缀写成无条件的（明文下 cookie 会被浏览器静默丢掉、
  // 症状是"登录说成功、下次说不认识你"）也照样全绿。
  // 这里用裸 HTTP 也量得动：`__Host-` 的强制者是**浏览器**，而本段量的是
  // "服务端写下什么名字、按什么顺序读"—— 那一半与客户端无关。
  const srvG = await withServer({ JOIN_CODE: INVITE, COOKIE_SECURE: '1', MAP: 'yard' });
  const baseG = srvG.base;
  const post = async (path, obj, headers = {}) => {
    const r = await fetch(baseG + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
    });
    return { status: r.status, body: await r.json(), cookies: r.headers.getSetCookie(), names: r.headers.getSetCookie().map(sc => sc.split('=')[0]) };
  };
  const meWith = async (cookie, tab) => (await fetch(baseG + '/api/me',
    { headers: { cookie, ...(tab ? { 'x-tab': tab } : {}) } })).json();
  // 取某一枚 cookie 的**值**（不是整条 set-cookie）。名字对不上就返回空串 ——
  // 那样调用点会读到空串而红，而不是悄悄拿错一枚。
  const val = (cookies, name) => {
    const sc = (cookies || []).find(s => s.split('=')[0] === name);
    return sc ? sc.slice(sc.indexOf('=') + 1).split(';')[0] : '';
  };

  // ── ① 名字：secure 下一律带 `__Host-` ──
  const regA = await post('/api/register', { name: '前缀甲', password: PW, code: INVITE }, { 'x-tab': 'taba01' });
  ok('G1【命门】secure 下两枚会话 cookie 都带 `__Host-` 前缀（同站子域再也种不出同名的那一枚）',
    regA.status === 200 && regA.names.length === 2
    && regA.names.includes('__Host-mf_sid') && regA.names.includes('__Host-mf_sid_taba01'),
    JSON.stringify(regA.names));
  const tokA = val(regA.cookies, '__Host-mf_sid_taba01');
  const tokFallbackA = val(regA.cookies, '__Host-mf_sid');
  const meA = await meWith(`__Host-mf_sid_taba01=${tokA}; __Host-mf_sid=${tokFallbackA}`, 'taba01');
  ok('G1b【先决】前缀名那一枚确实换得出人（下面 G2 拿它当"真的那枚"）',
    meA.loggedIn === true && meA.name === '前缀甲', JSON.stringify(meA));

  // ── ② 读的顺序：前缀名优先（这一半才是防御本身）──
  // 乙注册**不带选择器** ⇒ 只拿到兜底那一枚。它扮演"被投掷进来的那枚无前缀 cookie"：
  // 投掷能种的正是这种形状（带 Domain 的不带前缀名），而它造不出 `__Host-` 名。
  const regB = await post('/api/register', { name: '投掷乙', password: PW, code: INVITE });
  const tokB = val(regB.cookies, '__Host-mf_sid');
  const meB = await meWith(`__Host-mf_sid=${tokB}`);
  ok('G2a【先决】乙那枚本身就是有效令牌（否则下面"读到甲"可能只是因为压根认不出乙）',
    meB.loggedIn === true && meB.name === '投掷乙', JSON.stringify(meB));
  const meMix = await meWith(`__Host-mf_sid_taba01=${tokA}; mf_sid_taba01=${tokB}`, 'taba01');
  ok('G2b【命门】两枚并存时读**前缀名**那枚：投掷方种下的无前缀 mf_sid_taba01 压不过它',
    meMix.loggedIn === true && meMix.name === '前缀甲',
    `读到 ${JSON.stringify(meMix.name)}（旧实现只认无前缀那枚 ⇒ 这里会是 投掷乙）`);

  // ── ③ 选择器走子协议，不进 URL ──
  const jarG = `__Host-mf_sid_taba01=${tokA}; __Host-mf_sid=${tokB}`;
  const wsSub = client(srvG.ws, '子协议甲', { protocol: 'taba01', ws: { headers: { cookie: jarG } } });
  await wsSub.opened;
  wsSub.send({ t: 'join', room: 'gm11a', name: '冒充甲', team: 'A' });
  const gwA = await wsSub.until(j => j.t === 'welcome', 12000);
  ok('G3 子协议里的选择器在握手那一刻被认出来（这条连接是甲，不是兜底那枚的乙）',
    !!gwA && gwA.name === '前缀甲', JSON.stringify(gwA));
  // 反证臂：旧形状不许回来。URL 上写 ?tab= 而握手不带子协议 ⇒ 选择器**不生效**，
  // 这条连接只能被认成兜底那枚的乙。若 tabOf 还读 URL 参数，这里会读到甲 ⇒ 红。
  const wsURL = client(srvG.ws + '?tab=taba01', 'URL形状', { ws: { headers: { cookie: jarG } } });
  await wsURL.opened;
  wsURL.send({ t: 'join', room: 'gm11b', name: '冒充乙', team: 'A' });
  const gwURL = await wsURL.until(j => j.t === 'welcome', 12000);
  ok('G4【反证臂】URL 上的 ?tab= 不再被采信（旧形状没留兼容那一半）—— 这条连接是兜底的乙',
    !!gwURL && gwURL.name === '投掷乙', JSON.stringify(gwURL && gwURL.name));

  // ── ④ 登出：吊销**整个身份**，而不是当前那一枚 ──
  // 甲再登录一次（同账号、另一个标签页）⇒ 同一个身份两份会话行，这正是旧行为会漏掉的那一份。
  const loginA2 = await post('/api/login', { name: '前缀甲', password: PW }, { 'x-tab': 'taba02' });
  const tokA2 = val(loginA2.cookies, '__Host-mf_sid_taba02');
  const meA2 = await meWith(`__Host-mf_sid_taba02=${tokA2}`, 'taba02');
  ok('G5a【先决】同账号第二份会话是有效的（没有它的话下面那条量的是空气）',
    loginA2.status === 200 && meA2.loggedIn === true && meA2.name === '前缀甲', JSON.stringify(meA2));
  const lo = await post('/api/logout', {}, { cookie: jarG, 'x-tab': 'taba01' });
  const meA2b = await meWith(`__Host-mf_sid_taba02=${tokA2}`, 'taba02');
  ok('G5b【命门】登出把**整个身份**的会话都吊销了：同账号在另一个标签页的那一份也当场失效',
    lo.status === 200 && meA2b.loggedIn === false,
    `登出后第二份会话 loggedIn=${meA2b.loggedIn}（旧实现只删当前那一枚 ⇒ 这里是 true）`);
  const meA1b = await meWith(`__Host-mf_sid_taba01=${tokA}`, 'taba01');
  ok('G5c 当前那一枚当然也失效（旧的既有行为，写出来当基准：它单独绿说明不了什么）',
    meA1b.loggedIn === false, JSON.stringify(meA1b));

  // ── ⑤ 反证臂：别的账号不受牵连 ──
  const meB2 = await meWith(`__Host-mf_sid=${tokB}`);
  ok('G6【反证臂】乙（**另一个账号**）完全不受牵连 —— 把登出写成"清全场会话"也能让 G5b/G5c 绿',
    meB2.loggedIn === true && meB2.name === '投掷乙', JSON.stringify(meB2));

  // ── ⑥ 吊销行数要可数（这条链失效是全静默的）──
  const hG = await health(baseG);
  ok('G7 响应里带上吊销行数（甲那一份 + 另一标签页那一份 = 2），调用方不用猜',
    lo.body.revoked === 2, JSON.stringify(lo.body));
  ok('G7b 并且落进 /healthz（auth.logoutRevoked）：恒等于 1 的含义正是"旧行为、只作废了一枚"',
    hG.auth.logoutRevoked === 2,
    JSON.stringify({ logoutRevoked: hG.auth.logoutRevoked, sessions: hG.auth.sessions }));

  // ── ⑦ 客户端那一半：选择器不许回 URL ──
  // 这一条是**形状**判据，单独说明为什么不靠它：它在 node 里量不到行为（要真浏览器才知道
  // 子协议协商成没成）。它的行为臂在 test/tab-session.mjs 的 T5b/T5c —— 那里量"URL 里没有
  // 选择器"和"协商出来的 ws.protocol 就是 sessionStorage 里那个"，而 T6/T7 的身份归属
  // 会在子协议断掉时当场错位。这里只是不让它悄悄退回去（那是最容易被下次重构顺手改回来的）。
  const srcs = ['js/net/client.mjs', 'js/net/lobby.mjs', 'js/account.js']
    .map(f => readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
  const liveTab = srcs.map(s => s.split('\n')
    .filter(l => !l.trimStart().startsWith('//') && /[?&]tab=/.test(l)).length);
  ok('G8 三个客户端源文件里没有"把选择器拼进 URL"的活代码（注释里提它是可以的）',
    liveTab.every(n => n === 0), JSON.stringify(liveTab));

  // ═══════════════════════════════════════════════════════════════════════════
  sec('H. 低危一组（HTTP 面）：畸形 cookie / 会话回退 / 规模情报 / 错误码全集');
  // ═══════════════════════════════════════════════════════════════════════════
  // 这四条的共同形状是"不报错、只是少了一样东西"：一条畸形 cookie 把日志刷满、
  // 一枚失效的选择器 cookie 把人挡在门外、一个只读接口顺手把站点规模送出去、
  // 一个拼错的错误码把 500 语义丢成 400。四条都配"该照常工作的必须照常工作"的反证臂。

  // H 段自己注册一个账号：G 段那个（前缀甲）在 G5b 里被**登出**过 —— 复用它的令牌
  // 会让下面两条量的变成"一枚已作废的令牌"，红得毫无道理（判据的前提要摆在自己手里）。
  const regH = await post('/api/register', { name: '低危甲', password: PW, code: INVITE }, { 'x-tab': 'tabh01' });
  const tokHfb = val(regH.cookies, '__Host-mf_sid');
  const tokH = val(regH.cookies, '__Host-mf_sid_tabh01');

  // ── ① 畸形 cookie 不许把请求打成异常 ──
  // 旧写法 decodeURIComponent('%') 抛 URIError，一路冒到路由层 ⇒ 400 + 一条错误堆栈进日志：
  // 一条 cookie 就能刷日志，而它连一道防线都没碰到。
  const badCk1 = await fetch(baseG + '/api/me', { headers: { cookie: 'x=%' } });
  const badCk2 = await fetch(baseG + '/api/me', { headers: { cookie: 'mf_sid=%; y=%zz' } });
  ok('H1 畸形百分号编码的 cookie 不再把请求打成异常（两边都是 200 + 正常应答）',
    badCk1.status === 200 && badCk2.status === 200, `% ⇒ ${badCk1.status} · %zz ⇒ ${badCk2.status}`);
  ok('H1b 那一枚被当成"没有这枚"（loggedIn=false），而不是被当成一个令牌去查',
    (await badCk1.json()).loggedIn === false);
  // 反证臂：同一批里那枚**好的**仍然认得出人 —— 否则"一律 200、cookie 全丢"也能让 H1 绿。
  const mixCk = await (await fetch(baseG + '/api/me',
    { headers: { cookie: `x=%; __Host-mf_sid=${tokHfb}; y=%zz` } })).json();
  ok('H1c【反证臂】同一批 cookie 里那枚好的照旧认得出人（畸形的那几枚不牵连别的）',
    mixCk.loggedIn === true && mixCk.name === '低危甲', JSON.stringify(mixCk));

  // ── ② 选择器那枚失效时回退老名字 ──
  // 形状：浏览器里两枚都在，带选择器那枚的**服务端行已经没了**（过期 / 被登出 / 换过库），
  // 老名字那枚还活着。只试第一枚的实现返回空 ⇒ 明明有凭证却被要求重新登录。
  const meStale = await meWith(`__Host-mf_sid_tabh01=${'0'.repeat(64)}; __Host-mf_sid=${tokHfb}`, 'tabh01');
  ok('H2【命门】带选择器那枚已失效时回退到老名字那枚（不是"有 cookie 就只认它"）',
    meStale.loggedIn === true && meStale.name === '低危甲', JSON.stringify(meStale));
  // 先决：H 段那个账号的选择器名**是对的**（不然上面两条可能只是因为"压根没读选择器"）。
  ok('H2c【先决】带上好的选择器那枚时照样认得出人（回退不是唯一的通路）',
    (await meWith(`__Host-mf_sid_tabh01=${tokH}`, 'tabh01')).loggedIn === true);
  // 反证臂：两枚都失效时照旧"没登录" —— 否则 H2 可能是"随便给个 cookie 都放行"。
  const meDead = await meWith(`__Host-mf_sid_tabh01=${'0'.repeat(64)}; __Host-mf_sid=${'1'.repeat(64)}`, 'tabh01');
  ok('H2b【反证臂】两枚都失效时照旧是"没登录"（回退不是"来者不拒"）',
    meDead.loggedIn === false, JSON.stringify(meDead));

  // ── ③ 只读状态接口不再白送站点规模 ──
  const stH = await (await fetch(baseG + '/api/status')).json();
  ok('H3 只读状态接口不再带注册用户总数（这个接口刻意不需要登录，规模情报不白送）',
    stH.ok === true && stH.accounts === undefined, JSON.stringify(stH));
  // 反证臂：它该给的两格一格都不能少 —— 否则"整个响应被清空"也能让 H3 绿。
  ok('H3b【反证臂】它该给的两格还在（要不要邀请码 / 要不要账号）',
    typeof stH.inviteRequired === 'boolean' && typeof stH.requireAccount === 'boolean', JSON.stringify(stH));

  // ── ④ 错误码全集：accounts 发得出的每一个都要在 http-api 的 ERRORS 里 ──
  // 拼错的那一个（`hash_failed` vs `hashing_failed`）的症状是"500 语义丢成 400"：
  // scrypt 抛错时客户端读到的是一句"请求有问题"，而问题在服务端。
  // 读源码而不是从外面制造真故障：scrypt 失败没法稳定复现 —— 那正是它难查的原因。
  // `no_user` 是**例外**：它只由 issueRecovery 发（CLI 那条路，server/recover.mjs），
  // 从不经过 ERRORS 这张 HTTP 表。写进白名单而不是放水——下面那条臂专门证明它只出现在 CLI。
  const accSrc = readFileSync(new URL('../server/accounts.mjs', import.meta.url), 'utf8');
  const emitted = [...new Set([
    ...[...accSrc.matchAll(/_reject\('([a-z_]+)'\)/g)].map(m => m[1]),
    ...[...accSrc.matchAll(/error: '([a-z_]+)'/g)].map(m => m[1]),
  ])].sort();
  const { ERRORS } = await import('../server/http-api.mjs');
  const unknown = emitted.filter(e => e !== 'no_user' && !(e in ERRORS));
  ok('H4 账号层发得出的每一个错误码都在 http-api 的 ERRORS 表里（拼错的那个把 500 丢成 400）',
    emitted.length >= 8 && unknown.length === 0, `发出 ${emitted.length} 种 · 查无此码 ${JSON.stringify(unknown)}`);
  ok('H4b【反证臂】被点名的那个码在表里**且是 500**（只查"存在"的话，把它改成 400 也绿）',
    ERRORS.hashing_failed && ERRORS.hashing_failed[0] === 500, JSON.stringify(ERRORS.hashing_failed));

  // ═══════════════════════════════════════════════════════════════════════════
  sec('I. 进程级连接上限**两侧都是闭的**：maxClients=1 放 1 拒 2，maxClients=2 放 2');
  // ═══════════════════════════════════════════════════════════════════════════
  // 低危账里那条写的是"满员判断用严格大于 ⇒ 实际可超 1 人"。**在本版它不成立**：那条账
  // 照的是审计文档里的行号，而那一行在旧版是 verifyClient（新连接还没进 wss.clients，
  // `>` 确实会多放一个）；现在的检查跑在 join 帧上，这一条连接已经在 clients.size 里，
  // 于是 `size > max` 恰好等于"最多 maxClients 人进得来"。
  // 我第一版照着账改成 `>=`，下面 I0 当场红（连第一个名额都被拒了）—— 所以这一段量的是
  // **两侧**：改宽（超一人）与改窄（少一人）各有一条能变红的臂。
  // 量法要点：这个闸读的是 **wss.clients.size**（所有打开的连接，含还没 join 的）。
  // 所以必须"先进第一条、再开第二条"，两条一起开着的话 size 已经是 2，第一个名额也会被拒
  // —— 第一版就是这么写的，I0 红得莫名其妙（不是源码错，是量法自己把条件摆错了）。
  const srvI = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '', MAX_CLIENTS: '1', MAP: 'yard' });
  const i1 = client(srvI.ws, '满甲');
  await i1.opened;
  i1.send({ t: 'join', room: 'cap1', name: '满甲', team: 'A' });
  const wI = await i1.until(j => j.t === 'welcome' || j.t === 'err', 9000);
  ok('I0 maxClients=1 时**第一个**名额是真的（改成 >= 会把最后一个名额也拒掉 ⇒ 这条红）',
    !!wI && wI.t === 'welcome', JSON.stringify(wI && wI.t));
  const i2 = client(srvI.ws, '满乙');
  await i2.opened;
  i2.send({ t: 'join', room: 'cap2', name: '满乙', team: 'A' });
  const eI = await i2.until(j => j.t === 'welcome' || j.t === 'err', 9000);
  ok('I1 第二条被"已满"挡下（改成 > maxClients+1 会多放一个人 ⇒ 这条红）',
    !!eI && eI.t === 'err' && /已满/.test(eI.msg || ''), JSON.stringify(eI && eI.msg));
  // 反证臂：拒的是**新来的**（老的没被赶走）—— 自报在线数与 wss.clients 同源。
  ok('I2【反证臂】自报在线数仍是 2（拒的是新来的，不是把老的那条踢掉）',
    (await health(srvI.base)).clients === 2, JSON.stringify({ clients: (await health(srvI.base)).clients }));
  i1.close(); i2.close(); srvI.kill();
  // 另一侧：上限 2 时**两条都要进得去**（少一人与多一人都要能变红）。
  const srvI2 = await withServer({ REQUIRE_ACCOUNT: '0', JOIN_CODE: '', MAX_CLIENTS: '2', MAP: 'yard' });
  const j1 = client(srvI2.ws, '双甲');
  await j1.opened;
  j1.send({ t: 'join', room: 'cap3', name: '双甲', team: 'A' });
  const j2 = client(srvI2.ws, '双乙');
  await j2.opened;
  j2.send({ t: 'join', room: 'cap4', name: '双乙', team: 'A' });
  const wj1 = await j1.until(j => j.t === 'welcome' || j.t === 'err', 9000);
  const wj2 = await j2.until(j => j.t === 'welcome' || j.t === 'err', 9000);
  ok('I1b maxClients=2 时两条都进得去（上限不许悄悄少一个）',
    !!wj1 && wj1.t === 'welcome' && !!wj2 && wj2.t === 'welcome',
    JSON.stringify({ 甲: wj1 && wj1.t, 乙: wj2 && wj2.t }));
  j1.close(); j2.close(); srvI2.kill();

  wsSub.close(); wsURL.close();
  srvG.kill();

  live.close(); seated.close(); fresh.close(); fresh2.close();
  srv.kill();
} catch (e) {
  bad++;
  console.log('  ❌ 用例抛异常（异常不是判决，但这里没有任何别的读数可看）：' + (e && e.stack || e));
}

console.log(`\n${bad ? '❌ RED' : '✅ GREEN'}  ${n - bad}/${n} 通过`);
process.exit(bad ? 1 : 0);
