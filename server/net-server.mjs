// 权威对局服务：一个进程、一个端口，同时发静态资源和跑 WebSocket。
//
//   node server/net-server.mjs [端口]
//
// 这就是"适合部署在云服务器上"的形状：没有构建步骤、没有外部服务，
// 一张地图一个进程（多进程编排见 README 的部署段）。
//
// 协议：
//   上行 二进制 = 若干个 12 字节输入包（按 tick 打时间戳，攒一帧一起发）
//        文本   = {t:'join'|'ping'|'input'} 控制帧
//   下行 二进制 = 快照（server/codec.mjs 的定长格式）
//        文本   = {t:'welcome'|'ev'|'err'|'pong'}
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { NetRoom, DT, SNAP_EVERY } from './room.mjs';
import { encodeSnapshot, ENTITY_SIZE, HEADER_SIZE, decodeInput, INPUT_SIZE } from './codec.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = +(process.argv[2] || process.env.PORT || 8090);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// 静态服务：路径必须规范化后仍落在 ROOT 内，否则一律 404。
// 不做这一步的话 "../../etc/passwd" 就能从对局服务器上读走任意文件。
async function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^([\\/])+/, '');
  const file = resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const st = await stat(file);
    if (st.isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const httpServer = createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const rooms = new Map();

// map 里存的是"启动完成"这个 promise，而不是房间对象本身。
// 之前先 set 再 await start()，第二个加入者会在材质预加载那 ~0.8s 窗口里
// 看到一个 game 还没建好的房间，直接 TypeError（实测：cid 1 被烧掉、B 拿不到身份）。
async function getRoom(id) {
  let p = rooms.get(id);
  if (!p) {
    p = (async () => {
      const room = new NetRoom({ id, mapId: process.env.MAP || 'yard', seed: +(process.env.SEED || 20260925) });
      await room.start();
      startRoomLoop(room, id);
      console.log(`[room ${id}] 权威模拟启动，${(1 / DT).toFixed(0)}Hz，每 ${SNAP_EVERY} tick 下一次快照`);
      return room;
    })();
    rooms.set(id, p);
    p.catch(() => rooms.delete(id));            // 起不来的房间不许留在表里反复失败
  }
  return p;
}

function startRoomLoop(room, id) {
  let next = Date.now();
  let since = 0;
  const tick = () => {
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
    if (since % 60 === 0) console.log(`[room ${id}] tick ${room.tick}  在线 ${room.clients.size}  事件队列 ${room.events.length}`);
    next += DT * 1000;
    const late = Date.now() - next;
    setTimeout(tick, late > 200 ? (next = Date.now(), 0) : Math.max(0, -late));
  };
  tick();
}

function broadcast(room) {
  const { view, byteLength } = encodeSnapshot({ tick: room.tick, seq: (room.seq = (room.seq || 0) + 1), worldFlags: 0, entities: room.snapshotEntities() });
  // 一份 Buffer 发给所有人：ws.send 不会改写传入的 Buffer，没必要每客户端再拷一次
  const buf = Buffer.from(view.buffer, 0, byteLength);
  const ev = room.events.splice(0, room.events.length);
  const evMsg = ev.length ? JSON.stringify({ t: 'ev', tick: room.tick, ev }) : null;
  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || ws.__cid == null) continue;
    ws.send(buf, { binary: true });
    if (evMsg) ws.send(evMsg);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
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
        const room = await getRoom(msg.room || 'ffa-1');
        const c = room.addClient({ name: String(msg.name || '士兵').slice(0, 24), team: msg.team === 'B' ? 'B' : 'A', loadout: msg.loadout || null });
        ws.__cid = c.cid; ws.__room = room;      // 存对象本身：rooms 里存的是 promise
        ws.send(JSON.stringify({
          t: 'welcome', cid: c.cid, room: room.id, tick: room.tick, map: room.mapId,
          pos: [c.pl.pos.x, c.pl.pos.y, c.pl.pos.z], yaw: c.pl.yaw,
          others: room.snapshotEntities().filter(e => e.id !== c.cid).map(e => ({ id: e.id, name: [...room.clients.values()].find(x => x.cid === e.id)?.name || '' })),
        }));
        console.log(`[join] ${c.name} → cid ${c.cid} @ ${room.id}（在线 ${room.clients.size}）`);
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

// 掉线的连接要收掉，否则半开连接会一直占着房间名额
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 5000).unref?.();

httpServer.listen(PORT, () => {
  console.log(`现代战线 · 权威对局服务  http://127.0.0.1:${PORT}/  (ws: /ws)`);
  console.log(`  静态根目录 ${ROOT}`);
  console.log(`  地图 ${process.env.MAP || 'yard'}  种子 ${process.env.SEED || 20260925}  端口 ${PORT}`);
});
