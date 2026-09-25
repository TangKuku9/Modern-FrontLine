// 部署层的验收：这一台进程能不能直接扔在公网上。
//
// 判据不是"代码里写了这个开关"，而是**每条防线都要在它该拦的时候拦住、
// 在不该拦的时候放行**（A/B 两个方向都测）。只测反方向的风险是：
// 一个恒断开的守卫（比如把 origin 比对写成了永真）会让整个部署段看起来全绿。
//
//   node server/deploy-probe.mjs
import { WebSocket } from 'ws';
import { gunzipSync } from 'node:zlib';
import { get as httpGet } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { withServer } = await import('../test/with-server.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, bad = 0;
const ok = (label, cond, extra = '') => { n++; if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); };

const srv = await withServer({
  NODE_ENV: 'production',
  MAX_ROOMS: '4', MAX_CLIENTS: '8', ROOM_IDLE_MS: '1500', MAX_PAYLOAD: '16384',
  ALLOW_ORIGIN: 'http://127.0.0.1', STATIC_MAX_AGE: '60',
});
const base = srv.base;
// 不用 fetch：undici 会自动解压并把 content-encoding 头抹掉，那正好是要断言的东西。
// node:http 给的是原始响应头与原始字节，压缩协商对不对只能在这种尺度上看。
const get = (path, headers = {}) => new Promise((res, rej) => {
  const req = httpGet(base + path, { headers }, r => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(chunks) }));
  });
  req.on('error', rej);
});
// 一个能收到控制帧的客户端。room 传 'auto' 走自动分配，传真 id 走私有房。
// 只收文本帧：二进制快照每 50ms 一份，混进控制帧里会把断言淹掉。
const joiner = async (room, name, origin = 'http://127.0.0.1') => {
  const ws = new WebSocket(srv.ws, { headers: { origin } });
  const msgs = []; const closed = []; let nAll = 0;
  ws.on('message', (m, isBinary) => { nAll++; if (!isBinary) msgs.push(String(m)); });
  ws.on('close', (code, reason) => closed.push([code, String(reason)]));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', e => rej(new Error('握手失败：' + e.message))); });
  ws.send(JSON.stringify({ t: 'join', room, name, team: 'A' }));
  for (let i = 0; i < 200 && !msgs.length; i++) await sleep(50);
  // all() 数的是**所有**下行：快照是二进制帧，只数文本的话"还在收包"这件事根本看不出来
  // （上一版就是这样，观察者一条都没漏，断言却报红了）。
  return { ws, msgs, closed, all: () => nAll, json: () => msgs.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) };
};

try {
  console.log('\n── 健康与观测 ──');
  const h0 = await get('/healthz');
  const hj = JSON.parse(String(h0.buf));
  ok('/healthz 返回 200 且是可解析的 JSON', h0.status === 200 && hj.ok === true, JSON.stringify(hj));
  ok('/healthz 报出的房间数与连接数在真实值上（新服务：0 间 0 人）', hj.rooms === 0 && hj.clients === 0, `rooms=${hj.rooms} clients=${hj.clients}`);
  ok('/healthz 不许被缓存（探针拿到过期数据比没有更糟）', /no-store/.test(h0.headers['cache-control'] || ''), h0.headers['cache-control']);

  console.log('\n── 静态资源：指纹缓存 + 压缩 + 入口回源 ──');
  const raw = readFileSync(ROOT + 'js/main.js');
  const a = await get('/js/main.js');
  ok('js 文件按字节原样送达（压缩/缓存不能改内容）', a.status === 200 && a.buf.equals(raw), `${a.buf.length} B vs 磁盘 ${raw.length} B`);
  ok('非 html 资源带 max-age（不再 no-store 让访客每次重拉 1.2 MB 的 three）', /public, max-age=60/.test(a.headers['cache-control'] || ''), a.headers['cache-control']);
  const etag = a.headers.etag;
  const b304 = await get('/js/main.js', { 'if-none-match': etag });
  ok('带 ETag 再验证命中 304 且不带包体', b304.status === 304 && b304.buf.length === 0, `status=${b304.status} body=${b304.buf.length} B`);
  const g = await get('/js/main.js', { 'accept-encoding': 'gzip' });
  const gzb = g.headers['content-encoding'] === 'gzip';
  ok('文本资源会压（且 gzip 后确实更小）', gzb && g.buf.length < a.buf.length, `原 ${a.buf.length} B → gzip ${g.buf.length} B = ${(g.buf.length / a.buf.length * 100).toFixed(0)}%`);
  ok('gzip 的解压结果 == 磁盘原文（压的不是别的东西）', gzb && gunzipSync(g.buf).equals(raw));
  ok('客户端不声明 gzip 时给的是未压内容（协商不能反向坏掉）', !a.headers['content-encoding'] && a.buf.equals(raw), `a: ${a.headers['content-encoding'] || '(无 content-encoding)'}`);
  const plain = await get('/js/main.js', { 'accept-encoding': 'identity' });
  ok('identity 请求拿到未压包体', !plain.headers['content-encoding'] && plain.buf.equals(raw));
  const idx = await get('/index.html');
  ok('入口 html 每次回源（改了要能立刻看到），但仍走 ETag', /no-cache/.test(idx.headers['cache-control'] || ''), idx.headers['cache-control']);
  ok('静态响应带 nosniff', idx.headers['x-content-type-options'] === 'nosniff');
  const lib = await get('/lib/three.module.js');
  ok('three 本体能取到（这是最大的那份静态资源）', lib.status === 200 && lib.buf.length > 500000, `${lib.buf.length} B`);

  console.log('\n── 路径穿越与 404（必须走裸 socket） ──');
  // 用 http.get 测不出来：WHATWG 的 URL 解析把 "%2e%2e" 也算作 ".."（是规范里明确的
  // "double dot path segment"），**客户端**就已经把路径收好了，服务器收到的是干净的
  // /windows/win.ini ⇒ 得到一个毫无意义的 404。要测的是服务端那道 resolve 判断，
  // 所以请求行必须原样写出去。
  const rawReq = (line) => new Promise((res, rej) => {
    const s = netConnect(new URL(base).port, '127.0.0.1');
    let buf = '';
    s.on('data', d => { buf += d; if (/\r\n\r\n/.test(buf) || buf.length > 4000) { s.destroy(); res(buf); } });
    s.on('error', rej);
    s.on('close', () => res(buf));
    s.setTimeout(4000, () => { s.destroy(); res(buf || 'timeout'); });
    s.write(`${line} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
  const t1 = await rawReq('GET /js/../../server/net-server.mjs');
  ok('normalize 后仍在仓库内的路径也不发（/server/ 是权威端源码，公网不该拿得到）',
    !/^HTTP\/1.1 200/m.test(t1) && !/WebSocketServer/.test(t1), t1.split('\r\n')[0]);
  const tgit = await rawReq('GET /.git/config');
  ok('.git 拿不到（仓库根 = 静态根时这是最贵的一条）', !/^HTTP\/1.1 200/m.test(tgit) && !/\[core\]/.test(tgit), tgit.split('\r\n')[0]);
  const t2 = await rawReq('GET /%2e%2e%2f%2e%2e%2f%2e%2e%2fwindows%2fwin.ini');
  ok('编码过的穿越同样被拒（解码后仍要过 ROOT 这道判据）', /^HTTP\/1.1 40[34]/m.test(t2), t2.split('\r\n')[0]);
  const t3 = await rawReq('GET /js/../../../Windows/win.ini');
  ok('真的穿出仓库外时拿不到文件内容', !/\[fonts\]|\[extensions\]/i.test(t3) && /^HTTP\/1.1 40[34]/m.test(t3), t3.split('\r\n')[0]);
  const miss = await get('/nope/nope.js');
  ok('不存在的路径 404 而不是 500', miss.status === 404);
  ok('被拒的路径一律 404，不用 403 区分（403 等于告诉对方"这东西存在"）',
    /^HTTP\/1.1 404/m.test(t1) && /^HTTP\/1.1 404/m.test(tgit), `${t1.split('\r\n')[0]} / ${tgit.split('\r\n')[0]}`);
  // 反方向：白名单必须是"白名单"而不是"全关"。开发模式（不设 NODE_ENV）仍然能取到
  // server/ 与 net-trace.html —— xenv 那一套跨环境实证就靠这两个活着。
  const dev = await withServer();
  try {
    const dSrc = await new Promise((res, rej) => {
      const r = httpGet(dev.base + '/server/net-server.mjs', rr => { rr.resume(); res(rr.statusCode); });
      r.on('error', rej);
    });
    const dTrace = await new Promise((res, rej) => {
      const r = httpGet(dev.base + '/net-trace.html', rr => { rr.resume(); res(rr.statusCode); });
      r.on('error', rej);
    });
    ok('开发模式仍然发 server/ 与 net-trace.html（拦网只关生产，不顺手焊死自己的量具）', dSrc === 200 && dTrace === 200, `dev: /server/net-server.mjs=${dSrc} /net-trace.html=${dTrace}`);
  } finally { dev.kill(); }

  console.log('\n── WebSocket 握手：来源检查（两个方向都要过） ──');
  let rejected = null;
  try {
    const evil = await joiner('sec-bad', '闯入者', 'http://evil.example');
    rejected = 'connected'; evil.ws.close();
  } catch (e) { rejected = String(e.message); }
  ok('陌生来源的握手被拒（WS 不吃 CORS，不拦就等于替别人开放炮台）', /403|握手失败/.test(rejected), rejected);
  const good = await joiner('sec-ok', '正主');
  const hello = good.json().find(m => m.t === 'welcome');
  ok('放行的来源照样进得来（拦网不能把正门也焊死）', !!hello, JSON.stringify(hello || good.json()));
  ok('welcome 带的字段齐全（cid/room/map/出生点）', !!(hello && hello.cid && hello.map && Array.isArray(hello.pos)), JSON.stringify(hello && { cid: hello.cid, room: hello.room, map: hello.map }));

  console.log('\n── 一条连接只进一次房（幽灵玩家） ──');
  good.ws.send(JSON.stringify({ t: 'join', room: 'sec-ok', name: '影子' }));
  await sleep(400);
  const second = good.json().filter(m => m.t === 'err');
  ok('第二次 join 被拒而不是多造一个玩家', second.length > 0, JSON.stringify(second.slice(-1)));
  const hAfter = JSON.parse(String((await get('/healthz')).buf));
  ok('健康页的连接数没被第二次 join 灌水（幽灵玩家会占名额）', hAfter.clients === 1, `clients=${hAfter.clients}，此刻只该有 sec-ok 这一条连接`);
  good.ws.close();                // 不留活连接：留着的话后面"空房回收"永远等不到空房
  await sleep(200);

  console.log('\n── 帧大小上限，以及一个坏包能伤到谁 ──');
  // 现场先放一个无辜的观察者：这条断言要证的不是"服务器会拒大帧"，
  // 而是"有人发大帧时，别人那一局还在跑"。上一版这里就是漏网的：ws 在超帧时
  // 往那条连接上 emit 'error'，没人接 ⇒ 未捕获异常 ⇒ 整个进程连同所有房间一起死。
  const watch = await joiner('watch-1', '旁观者');
  const frames = () => watch.all();
  await sleep(400);
  const f0 = frames();
  const big = new WebSocket(srv.ws, { headers: { origin: 'http://127.0.0.1' } });
  const bigClosed = new Promise(res => big.on('close', (c) => res(c)));
  await new Promise(r => big.on('open', r));
  big.send(Buffer.alloc(200 * 1024, 7));
  const code = await Promise.race([bigClosed, sleep(1500).then(() => 'timeout')]);
  ok('超限单帧被断开（默认 100 MiB 等于请人来吃你内存）', code !== 'timeout', `close code=${code}（1009 = 消息过大）`);
  await sleep(600);
  ok('发坏包的那个人死了，别人的那一局没陪葬', watch.ws.readyState === 1 && frames() > f0, `观察者收到 ${f0} → ${frames()} 帧`);
  const hAlive = JSON.parse(String((await get('/healthz')).buf));
  ok('进程还活着并且还在报健康（/healthz 可查）', hAlive.ok === true, JSON.stringify(hAlive));
  const small = await joiner('sec-ok', '正常人');
  await sleep(300);
  ok('正常大小的输入帧不受影响（上限不能砍到功能）', small.json().some(m => m.t === 'welcome'), `帧上限 16 KB`);
  small.ws.close(); watch.ws.close();

  console.log('\n── 房间配额与自动分配 ──');
  const r1 = await joiner('quota-1', '甲');
  const r2 = await joiner('quota-2', '乙');
  const r3 = await joiner('quota-3', '丙');
  await sleep(300);
  const denied = r3.json().find(m => m.t === 'err');
  ok('超过 MAX_ROOMS 的新房被拒（客户端可以随便编房间号）', !!denied, JSON.stringify(denied || r3.json()));
  const hQ = JSON.parse(String((await get('/healthz')).buf));
  ok('被拒的那一次没有把房间表撑破', hQ.rooms === 4, `rooms=${hQ.rooms}（MAX_ROOMS=4：sec-ok + watch-1 + quota-1 + quota-2）`);
  r1.ws.close(); r2.ws.close();
  await sleep(300);
  const autoA = await joiner('auto', '甲');
  const autoB = await joiner('auto', '乙');
  const wa = autoA.json().find(m => m.t === 'welcome'), wb = autoB.json().find(m => m.t === 'welcome');
  ok('room=auto 时第二个人被分到同一个房间（否则大厅形同虚设）', !!wa && !!wb && wa.room === wb.room, `${wa && wa.room} vs ${wb && wb.room}`);
  ok('同一个房间里的两个人拿到不同 cid', !!wa && !!wb && wa.cid !== wb.cid, `${wa && wa.cid}/${wb && wb.cid}`);
  autoA.ws.close(); autoB.ws.close();
  await sleep(300);

  console.log('\n── 空房回收 ──');
  let hR = JSON.parse(String((await get('/healthz')).buf));
  const high = hR.rooms;                       // 先确认"确有东西可收"，否则这条会空转成永远绿
  for (let i = 0; i < 90 && (hR = JSON.parse(String((await get('/healthz')).buf))).rooms > 0; i++) await sleep(500);
  ok('人都走光的房间会被收掉（不回收就是"跑得越久越慢"的那种事故）', high > 0 && hR.rooms === 0, `高水位 ${high} 间 → 现在 ${hR.rooms} 间（ROOM_IDLE_MS=1500）`);
  ok('回收动作记进了日志（现场能查）', /\[room .*\] 空了 .*s，回收/.test(srv.log()), '');

  console.log('\n── 优雅下线 ──');
  const rider = await joiner('bye-1', '乘客');
  const notes = [];
  rider.ws.on('message', m => { try { const j = JSON.parse(String(m)); if (j.t) notes.push(j); } catch { /* 二进制快照 */ } });
  rider.ws.on('close', (code, reason) => notes.push({ t: '__close', code, reason: String(reason) }));
  await sleep(200);
  const t0 = Date.now();
  // Windows 上发不了 SIGTERM：libuv 的 kill 直接 TerminateProcess，进程没有机会跑 handler。
  // 所以这里先试 SIGINT（同一份 shutdown 逻辑，两个信号都注册了），Linux/macOS 上试 SIGTERM。
  if (process.platform === 'win32') srv.proc.kill('SIGINT'); else srv.kill();
  const ex = await Promise.race([srv.exited, sleep(8000).then(() => null)]);
  const bye = notes.find(x => x.t === 'note'), cls = notes.find(x => x.t === '__close');
  const graceful = ex && ex.code === 0;
  if (!graceful && process.platform === 'win32') {
    console.log(`  ⚠ 未测（不是通过）：这台 Windows 机器无法把信号送进子进程 —— 观测到 code=${ex && ex.code} signal=${ex && ex.signal} close=${cls && cls.code}。`);
    console.log('    同一份 shutdown() 在 Linux 上由 SIGTERM 触发并被下面三条断言验收；此处不折算成绿灯。');
  } else {
    ok('下线前给在册连接发了可读的原因', !!bye, JSON.stringify(bye || notes.slice(-2)));
    ok('连接带 1001(要去哪儿) 关闭，而不是 RST（客户端据此重连）', !!cls && cls.code === 1001, JSON.stringify(cls));
    ok('进程在宽限期内自己退干净（退出码 0）', !!ex && ex.code === 0, ex ? `code=${ex.code} 用时 ${Date.now() - t0}ms` : '8 秒没退');
  }
  ok('下线后不再接新连接', (await get('/healthz').catch(() => ({ status: 'closed' }))).status !== 200);

  const errLines = srv.log().split('\n').filter(l => /^\[room .*step 失败| broadcast 失败/.test(l));
  ok('全程没有房间抛错', errLines.length === 0, errLines.slice(0, 2).join(' ⏐ '));
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  // 被测的是另一个进程：不把它的尾部日志倒出来，一次崩溃就只剩"红了，为什么不知道"。
  console.log('── 服务端日志（尾 30 行）──\n' + srv.log().split('\n').slice(-30).join('\n'));
  bad++;
  srv.kill();
  process.exit(2);
} finally {
  srv.kill();
}
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过`);
process.exit(bad ? 1 : 0);
