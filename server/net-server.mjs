// 权威对局服务：一个进程、一个端口，同时发静态资源和跑 WebSocket。
//
//   node server/net-server.mjs [端口]        开发
//   PORT=8090 NODE_ENV=production node server/net-server.mjs     部署
//
// 所有可调项都只从环境读（下表见 README），代码里不给"必须改源码才能换端口"的东西留位置。
//
// 协议：
//   上行 二进制 = 若干个 13 字节输入包（按 tick 打时间戳，攒一帧一起发）
//        文本   = {t:'join'|'ping'} 控制帧
//   下行 二进制 = 快照（server/codec.mjs 的定长格式）
//        文本   = {t:'welcome'|'ev'|'err'|'pong'|'note'}
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { NetRoom, DT, SNAP_EVERY } from './room.mjs';
import { encodeSnapshot, ENTITY_SIZE, HEADER_SIZE, decodeInput, INPUT_SIZE } from './codec.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

// 配置表。每一项都要在 README 里有一行说明 —— 部署时"这个数从哪来"不该靠读源码回答。
export const CFG = {
  port: int(process.argv[2] || process.env.PORT, 8090),
  host: process.env.HOST || '0.0.0.0',
  map: process.env.MAP || 'yard',
  seed: int(process.env.SEED, 20260925),
  maxRooms: int(process.env.MAX_ROOMS, 32),            // 每进程房间数上限（每房间一份完整 sim）
  maxClients: int(process.env.MAX_CLIENTS, 128),       // 每进程真人连接上限
  maxPayload: int(process.env.MAX_PAYLOAD, 64 * 1024), // 单帧字节上限：正常一帧 ≤ 13×60 = 780 B
  roomIdleMs: int(process.env.ROOM_IDLE_MS, 60000),    // 空房间多久收掉
  staticMaxAge: int(process.env.STATIC_MAX_AGE, 86400),
  shutdownGraceMs: int(process.env.SHUTDOWN_GRACE_MS, 4000),
  // 逗号分隔的允许来源。留空 = 不检查（开发方便，生产务必设）：WS 不吃 CORS，
  // 不检查 origin 的话任何网站都能拿你的对局服务当免费炮台、或替它的访客占你名额。
  origins: (process.env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  // --prod 与 NODE_ENV=production 等价：前者在 Windows 的 cmd/PowerShell 里也能写进
  // npm script（"NODE_ENV=production node ..." 那种形式只在 POSIX shell 里成立）。
  prod: process.env.NODE_ENV === 'production' || process.argv.includes('--prod'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const GZIPPABLE = /^(text\/|application\/(javascript|json|wasm))/;

// 生产模式只发这些前缀。"仓库根 = 静态根"在开发机上无害，放到公网上等于
// 把 server/（权威端源码、协议细节）和 .git/ 一起发给任何人 —— 实测 dev 模式下
// GET /server/net-server.mjs 会返回 15 KB 源码。判据用白名单而不是黑名单：
// 黑名单要每次都想全（test/、node_modules/、*.log、.env…），白名单一次写完。
const PUBLIC = ['index.html', 'style.css', 'js/', 'lib/', 'assets/', 'public/', 'favicon.ico'];
function publiclyServable(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p.split('/').some(seg => seg.startsWith('.'))) return false;         // .git / .vscode / .env
  if (!CFG.prod) return true;                                              // 开发机保持能拿 net-trace.html 与 server/sim-twin.mjs
  return PUBLIC.some(x => p === x || p.startsWith(x));
}

// 静态资源指纹缓存：lib/three.module.js 有 1.2 MB，"每次请求都 stat+read+gzip 一遍"
// 会把对局服务的 CPU 花在发文件上。键 = 路径，值 = {etag, mtimeMs, size, buf?, gz?}。
// 失效靠 mtime —— 改了文件下一个请求就重新读，不需要重启进程，也不需要构建步骤。
const fileCache = new Map();
const MAX_CACHED = 128;

async function cachedFile(file) {
  let e = fileCache.get(file);
  const st = await stat(file);
  if (st.isDirectory()) throw new Error('dir');
  if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return e;
  const buf = await readFile(file);
  e = { mtimeMs: st.mtimeMs, size: st.size, buf, gz: null, etag: `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"` };
  fileCache.set(file, e);
  if (fileCache.size > MAX_CACHED) fileCache.delete(fileCache.keys().next().value);
  return e;
}

// 缓存策略只有一种"必须每次回源"：入口文档。其余走 ETag 再验证 ——
// 命中就是 304 且不带 body，所以"发文件"不再和对局抢 CPU。
// 上一版全部 no-store：16 人 20Hz 才 66 kbps，而每个访客要重新拉 1.2 MB 的 three。
async function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz' || url === '/health') {
    const body = JSON.stringify({
      ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size,
      clients: wss ? wss.clients.size : 0, map: CFG.map, tickHz: Math.round(1 / DT), draining,
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^([\\/])+/, '');
  const file = resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden'); return; }
  if (!publiclyServable(rel)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
  let e;
  try { e = await cachedFile(file); }
  catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const base = { 'content-type': type, etag: e.etag, 'last-modified': new Date(e.mtimeMs).toUTCString(), 'x-content-type-options': 'nosniff' };
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, base).end(); return; }   // 不发包体
  const html = extname(file).toLowerCase() === '.html';
  base['cache-control'] = html ? 'no-cache' : `public, max-age=${CFG.staticMaxAge}, must-revalidate`;
  // 压缩只对文本生效，且只压一次（结果挂在 fileCache 上）。小文件压了反而多几字节。
  if (GZIPPABLE.test(type) && e.size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    if (!e.gz) e.gz = gzipSync(e.buf, { level: 6 });
    base['content-encoding'] = 'gzip'; base['content-length'] = e.gz.length; base['vary'] = 'accept-encoding';
    res.writeHead(200, base).end(e.gz);
    return;
  }
  base['content-length'] = e.size;
  res.writeHead(200, base).end(e.buf);
}

const httpServer = createServer(serveStatic);
// maxPayload 是"单个帧"的上限：没设的话默认 100 MiB，一个乱发的客户端就能把进程内存吃掉。
const wss = new WebSocketServer({
  server: httpServer, path: '/ws', maxPayload: CFG.maxPayload,
  verifyClient: ({ origin }, done) => {
    if (!CFG.origins.length) return done(true);
    // 浏览器必带 Origin；不带（curl、同级进程、健康探针）放行，脚本伪造 Origin 本来也容易，
    // 这一层拦的是"别的网站的访客"，不是"攻击者"。真正的配额与鉴权见 README 的未完成段。
    if (!origin) return done(true);
    const ok = CFG.origins.some(o => o === origin || origin.endsWith(o.replace(/^\*\.?/, '.')));
    done(ok, 403, 'origin not allowed');
  },
});
const rooms = new Map();
let draining = false;

// map 里存的是"启动完成"这个 promise，而不是房间对象本身。
// 之前先 set 再 await start()，第二个加入者会在材质预加载那 ~0.8s 窗口里
// 看到一个 game 还没建好的房间，直接 TypeError（实测：cid 1 被烧掉、B 拿不到身份）。
async function createRoom(id) {
  const room = new NetRoom({ id, mapId: CFG.map, seed: CFG.seed });
  await room.start();
  room.__lastBusy = Date.now();
  startRoomLoop(room, id);
  console.log(`[room ${id}] 权威模拟启动，${(1 / DT).toFixed(0)}Hz，每 ${SNAP_EVERY} tick 下一次快照`);
  return room;
}
async function getRoom(id) {
  let p = rooms.get(id);
  if (!p) {
    if (draining) throw new Error('服务器正在下线，请重连');
    if (rooms.size >= CFG.maxRooms) throw new Error(`这台服务器已经有 ${rooms.size} 个房间，不再新建（MAX_ROOMS）`);
    p = createRoom(id);
    rooms.set(id, p);
    p.catch(() => rooms.delete(id));            // 起不来的房间不许留在表里反复失败
  }
  return p;
}

// 建房间：房间 id 由客户端随便写 ⇒ 任何人都能用不同的 id 把 MAX_ROOMS 填满，
// 更常见的是"每个人一个私有房"其实根本不想玩同一局。所以显式 id 照旧支持，
// 另给一条自动分配的通路（这就是联机大厅缺的那半，见任务 P1 余下部分）。
// 自动分配按**人最多且没满**的那间塞（fill-first）：对局类服务要的是把人凑一起，
// 而不是负载均衡 —— 按最少人数分会让每个访客都开一间新房，永远碰不到人。
async function pickRoom(requested) {
  const id = String(requested == null ? 'auto' : requested).slice(0, 48).replace(/[^A-Za-z0-9_.-]/g, '') || 'auto';
  if (id === 'auto') {
    let best = null, bestN = -1;
    for (const p of rooms.values()) {
      const room = await p.catch(() => null);
      if (!room || room.__stop) continue;
      if (room.clients.size > bestN && room.clients.size < 16) { best = room; bestN = room.clients.size; }
    }
    if (best) return best;
  }
  return getRoom(id);
}

function startRoomLoop(room, id) {
  let next = Date.now();
  let since = 0;
  room.__fails = 0;              // 不显式初始化：首拍就抛时 ++undefined = NaN，
  // 于是 "×1 || %60" 两个条件都不成立，一个静默死掉的房间正是最难查的那种红。
  const tick = () => {
    if (room.__stop) return;
    // 一个坏 tick 不许静默杀掉整个房间：那症状是"所有人卡住但连接都在"，最难查。
    // 连续失败到阈值就报名字，而不是假装还在跑。
    try {
      room.step();
      room.__fails = 0;
    } catch (e) {
      if (++room.__fails === 1 || room.__fails % 60 === 0) console.error(`[room ${id}] step 失败 ×${room.__fails}: ` + (e && e.stack || e));
      if (room.__fails >= 600) { console.error(`[room ${id}] 连续 600 tick 失败，停循环`); return; }
    }
    if (room.tick % SNAP_EVERY === 0) {
      try { broadcast(room); }
      catch (e) { console.error(`[room ${id}] broadcast 失败: ` + (e && e.stack || e)); }
    }
    since++;
    if (since % 60 === 0 && room.clients.size) console.log(`[room ${id}] tick ${room.tick}  在线 ${room.clients.size}  事件队列 ${room.events.length}`);
    next += DT * 1000;
    const late = Date.now() - next;
    // 刻意不 unref：这一拍定时器是"房间还活着"的凭据。unref 它会让进程在
    // 监听句柄关掉后悄悄退出，而那时下线广播还没发完 —— 访客看到的是集体卡死而不是"请重连"。
    setTimeout(tick, late > 200 ? (next = Date.now(), 0) : Math.max(0, -late));
  };
  tick();
}

function broadcast(room) {
  const { view, byteLength } = encodeSnapshot({ ...room.snapshot(), seq: (room.seq = (room.seq || 0) + 1) });
  // 一份 Buffer 发给这个房间的所有人：ws.send 不会改写传入的 Buffer，没必要每人再拷一次。
  // 必须按 room.clients 发，不能遍历 wss.clients —— 一台服务上跑多个房间时，
  // 遍历全部套接字会把别的房间（包括已经空掉的房间，实体表是 0 个）的快照塞给所有人。
  // 客户端拿到的就是"随机变成没有人的世界 + 陌生 ack"，症状是弹匣数字乱跳、别人凭空消失。
  const buf = Buffer.from(view.buffer, 0, byteLength);
  const ev = room.events.splice(0, room.events.length);
  const evMsg = ev.length ? JSON.stringify({ t: 'ev', tick: room.tick, ev }) : null;
  for (const c of room.clients.values()) {
    const ws = c.ws;
    if (!ws || ws.readyState !== 1) continue;
    // 事件先于快照发：重生事件会让客户端把这次位置跳变当"服务端整体重置"处理。
    // 反过来的话，那一包快照会先被当成一次普通校正，量出 29 m 的"预测偏差"，
    // 还会拿死亡前的日记本去回滚 —— 表现就是重生后被拽回死点一下。
    if (evMsg) ws.send(evMsg);
    ws.send(buf, { binary: true });
  }
}

// 空房间回收：一份 sim = 一张地图的 world + 若干玩家 + 事件表，放着不回收就是
// "跑得越久越慢"的那种事故。客户端自选 id 的场景下必然产生一次性房间。
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, p] of rooms) {
    p.then(room => {
      if (room.__stop || rooms.get(id) !== p) return;
      if (room.clients.size) room.__lastBusy = now;
      else if (now - (room.__lastBusy || now) > CFG.roomIdleMs) {
        room.__stop = true;
        rooms.delete(id);
        console.log(`[room ${id}] 空了 ${Math.round((now - room.__lastBusy) / 1000)}s，回收（剩 ${rooms.size} 间）`);
      }
    }).catch(() => {});
  }
}, 5000);
sweeper.unref?.();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // 必须挂 error：ws 在超帧/协议错/写失败时是在这条连接上 emit 'error' 的，
  // 一个都没人接的 'error' 事件 = 未捕获异常 = 整个进程死掉。
  // 实测：以前只发一个 200 KB 的帧就能把对局服务连带所有人的房间一起打死。
  // 单个访客的坏包不该有能力影响其他房间 —— 这正是部署前必须堵的那个洞。
  ws.on('error', e => { console.error(`[ws error] ${(req && req.socket && req.socket.remoteAddress) || '?'}: ` + (e && e.message || e)); try { ws.terminate(); } catch { /* 已经断了 */ } });
  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        if (ws.__cid == null) return;
        const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const room = ws.__room;
        if (!room) return;
        // 一帧可以攒多个 tick 的输入包，按顺序落地，最后一条生效
        for (let o = 0; o + INPUT_SIZE <= ab.byteLength; o += INPUT_SIZE) {
          room.applyInput(ws.__cid, decodeInput(new DataView(ab, o, INPUT_SIZE)));
        }
        return;
      }
      const msg = JSON.parse(String(data));
      if (msg.t === 'join') {
        // 一条连接只许进一个房间：反复 join 会往房间里塞出一串没人退出的玩家
        //（removeClient 只认最后那一份 ws.__cid），表现是"幽灵玩家"占着出生点。
        if (ws.__cid != null) { ws.send(JSON.stringify({ t: 'err', msg: '这条连接已经进过房间了' })); return; }
        if (draining) { ws.send(JSON.stringify({ t: 'err', msg: '服务器正在下线，请稍后重连' })); return; }
        if (wss.clients.size > CFG.maxClients) { ws.send(JSON.stringify({ t: 'err', msg: `这台服务器已满（${CFG.maxClients} 人）` })); return; }
        const room = await pickRoom(msg.room);
        const c = room.addClient({ name: String(msg.name || '士兵').slice(0, 24), team: msg.team === 'B' ? 'B' : 'A', loadout: msg.loadout || null });
        ws.__cid = c.cid; ws.__room = room;      // 存对象本身：rooms 里存的是 promise
        c.ws = ws;                                // 反向也要有：广播按 room.clients 走
        ws.send(JSON.stringify({
          t: 'welcome', cid: c.cid, room: room.id, tick: room.tick, map: room.mapId,
          pos: [c.pl.pos.x, c.pl.pos.y, c.pl.pos.z], yaw: c.pl.yaw,
          others: [...room.clients.values()].filter(x => x.cid !== c.cid).map(x => ({ id: x.cid, name: x.name, team: x.team })),
        }));
        console.log(`[join] ${c.name} → cid ${c.cid} @ ${room.id}（在线 ${room.clients.size}，本机 ${wss.clients.size} 连接 / ${rooms.size} 间）`);
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now(), tick: ws.__room?.tick ?? 0 }));
      }
    } catch (e) {
      // 只把 message 发给客户端、把 stack 留在服务端日志：客户端不该看到栈，
      // 但没有栈的服务端日志在这种时候等于没写
      console.error('[ws] ' + (e && e.stack || e));
      ws.send(JSON.stringify({ t: 'err', msg: String(e && e.message || e) }));
    }
  });
  ws.on('close', () => {
    const room = ws.__room;
    if (room && ws.__cid != null) { room.removeClient(ws.__cid); console.log(`[leave] cid ${ws.__cid} 断开（在线 ${room.clients.size}）`); }
  });
});

// 服务级的 error 同样不能没人接（握手阶段的错就发在这里）。
wss.on('error', e => console.error('[wss] ' + (e && e.stack || e)));

// 掉线的连接要收掉，否则半开连接会一直占着房间名额
const heartbeats = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 5000);
heartbeats.unref?.();

// 优雅下线：云平台发 SIGTERM 后只有几秒，直接死的话访客看到的是"突然全冻住"。
// 顺序是：挂下线标志（不再收新 join、/healthz 里 draining=true，让 LB 先摘掉这个实例）
// → 通知在册连接并带 1001(要离开) 关闭 → 停房间循环 → 等已发出的帧发完或到宽限期上限。
async function shutdown(sig) {
  if (draining) return;
  draining = true;
  console.log(`[server] ${sig}：开始下线（宽限 ${CFG.shutdownGraceMs}ms）`);
  httpServer.close();
  clearInterval(sweeper); clearInterval(heartbeats);
  for (const ws of wss.clients) {
    try { ws.send(JSON.stringify({ t: 'note', msg: '服务器维护中，请刷新重连' })); ws.close(1001, 'bye'); } catch { /* 已经在关了 */ }
  }
  for (const p of rooms.values()) p.then(r => { r.__stop = true; }).catch(() => {});
  rooms.clear();
  const hard = setTimeout(() => { console.log('[server] 宽限期到，强制退出'); process.exit(0); }, CFG.shutdownGraceMs);
  hard.unref?.();
  const timer = setInterval(() => {
    if (!wss.clients.size) { clearInterval(timer); console.log('[server] 全部连接已收尾，退出'); process.exit(0); }
  }, 50);
  timer.unref?.();
  setTimeout(() => process.exit(0), CFG.shutdownGraceMs + 200).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

httpServer.listen(CFG.port, CFG.host, () => {
  console.log(`现代战线 · 权威对局服务  http://${CFG.host}:${CFG.port}/  (ws: /ws)`);
  console.log(`  静态根目录 ${ROOT}`);
  console.log(`  地图 ${CFG.map}  种子 ${CFG.seed}  端口 ${CFG.port}  绑 ${CFG.host}  ${CFG.prod ? '生产' : '开发'}模式`);
  console.log(`  上限 房间 ${CFG.maxRooms} · 连接 ${CFG.maxClients} · 单帧 ${CFG.maxPayload} B · 空房回收 ${CFG.roomIdleMs / 1000}s · 允许来源 ${CFG.origins.join(',') || '(不检查)'}`);
});
