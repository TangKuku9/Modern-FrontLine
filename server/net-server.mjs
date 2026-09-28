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
//               | 对局内：{t:'loadout'|'respawn'}（死亡画面里换配装 / 按空格提前部署）
//               | 大厅与房间：{t:'lobby'|'say'|'createRoom'|'joinRoom'|'quickRoom'|
//                 'leaveRoom'|'ready'|'team'|'roomCfg'|'start'}（判据在 server/lobby.mjs）
//   下行 二进制 = 快照（server/codec.mjs 的定长格式）
//        文本   = {t:'welcome'|'ev'|'err'|'pong'|'note'}
//               | 大厅与房间：{t:'lobby'|'room'|'chat'}
// 一条连接可以从大厅一路走到对局（'start' 之后服务端在同一条连接上发 welcome），
// 也可以一上来就 'join' 直连对局 —— 后者是所有探针与 ?online=1 深链走的路，
// 它的形状在这轮改造里刻意一个字没动。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { NetRoom, DT, SNAP_EVERY, RESPAWN_DELAY } from './room.mjs';
import { Lobby, MAX_SEATS } from './lobby.mjs';
import { encodeSnapshot, ENTITY_SIZE, HEADER_SIZE, decodeInput, INPUT_SIZE } from './codec.mjs';
import { createAuth, sessionOf, clientIp, apiCounters } from './http-api.mjs';
import { normalizeName, validName, NAME_RULE_TEXT } from './accounts.mjs';

// ── 进房时那个呼号从哪来：一个来源，但分两种情况，而且判据只有这一处 ──
//   · 要账号的服（默认）：来自**握手那一刻验过的会话**，join 里的 name 一格都不看。
//   · 访客可玩的服（REQUIRE_ACCOUNT=0）：没有会话可依，自报呼号是唯一的来源 ——
//     但它仍然要过注册用的**同一个白名单**。两套规则各写一份的症状是
//     "注册时不让叫的名字，访客模式能叫得出来"，而这两种名字进的是同一个记分板。
//
// 不合法的名字**不静默替换成"访客"**：那样玩家看到的是"我明明填了名字，进去却叫访客"，
// 而"被改掉了"和"没生效"是同一副长相 —— 这一轮要消灭的正是这个形状。说清楚比改掉他好。
// 没带名字（手写 ?online=1 的、或是老客户端）不算错，按"访客"进：那不是有人在攻击，
// 只是有人没填。这条区分是有意的，"名字不合法"和"没给名字"不该得到同一个结果。
function joinName(user, raw) {
  if (user) return user.name;
  if (raw == null || raw === '') return '访客';
  const n = normalizeName(raw);
  if (!validName(n)) { const e = new Error(NAME_RULE_TEXT); e.refusal = true; throw e; }
  return n;
}

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
  // 一局打完到"自动回到房间"之间留几秒（设 0 = 当场回）。记分板要给人看一眼，
  // 但也不能让人站在一个还在空跑的 sim 里出不去 —— 见 returnRoom。
  matchReturnMs: (() => { const n = Number(process.env.MATCH_RETURN_MS); return Number.isFinite(n) && n >= 0 ? n : 8000; })(),
  // 强制把一局压到 N 秒（0 = 不覆盖，用房里选的分钟数）。这是**调试与判据用的闸门**：
  // 没有它，"打完一局 → 自动回房间"那一段要验就得真等十分钟。
  matchSeconds: (() => { const n = Number(process.env.MATCH_SECONDS); return Number.isFinite(n) && n > 0 ? n : 0; })(),
  staticMaxAge: int(process.env.STATIC_MAX_AGE, 86400),
  shutdownGraceMs: int(process.env.SHUTDOWN_GRACE_MS, 4000),
  // 逗号分隔的允许来源。留空 = 不检查（开发方便，生产务必设）：WS 不吃 CORS，
  // 不检查 origin 的话任何网站都能拿你的对局服务当免费炮台、或替它的访客占你名额。
  origins: (process.env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  // --prod 与 NODE_ENV=production 等价：前者在 Windows 的 cmd/PowerShell 里也能写进
  // npm script（"NODE_ENV=production node ..." 那种形式只在 POSIX shell 里成立）。
  prod: process.env.NODE_ENV === 'production' || process.argv.includes('--prod'),

  // ── 账号 ──
  // 邀请码留空 = 开放注册。默认值刻意**不**是空：让一个还没配好的部署默认带上门槛，
  // 比默认敞开、等人自己想起来要配要好。真要开放时显式设 JOIN_CODE=''。
  inviteCode: process.env.JOIN_CODE != null ? process.env.JOIN_CODE : 'mf2026',
  // 上面那句默认值现在还留着一个"漂移的来源"：它到底是**环境变量给的**还是**源码里的**，
  // 必须能被日志和判据分开 —— 见下面的 assertDeployConfig() 与启动日志里那一格。
  inviteCodeFromEnv: process.env.JOIN_CODE != null,
  accountsDb: process.env.ACCOUNTS_DB || '',            // 留空 = 内存（能玩，重启就没）
  accountsDbFromEnv: process.env.ACCOUNTS_DB != null,  // 与上面同理："" 是"我故意要内存库"，未设是"我忘了"
  cookieSecure: process.env.COOKIE_SECURE != null ? process.env.COOKIE_SECURE !== '0' : null,   // null = 跟随 prod
  // **代理层数**，不是布尔。设 0（默认）时完全忽略 X-Forwarded-For ——
  // 认了的话任何人都能随手写这个头，于是"按 IP 限流"变成"按攻击者自己填的字符串限流"。
  trustProxy: Number(process.env.TRUST_PROXY) > 0 ? Number(process.env.TRUST_PROXY) : 0,
  // 进对局要不要账号。默认要 —— 部署目标就是"有身份"。设 REQUIRE_ACCOUNT=0 可以放开成访客可玩，
  // 但那样账号之后的所有东西（战绩、封人、配额）都跟着失效，所以只在本地调试时用。
  requireAccount: process.env.REQUIRE_ACCOUNT !== '0',
  // 两个限流窗口。按部署可调：私有服把上限压到"每小时 3 次注册"就够挡脚本，
  // 公开服调大就等于把这条防线拆掉 —— 所以它得是一个能看见、能改的数，不是一个藏在代码里的常数。
  regPerHour: int(process.env.REG_PER_HOUR, 8),
  loginPer5Min: int(process.env.LOGIN_PER_5MIN, 12),

  // ── 长连接的三个闸门（这是真正会被打的那一面）──
  // ① 每连接每秒消息数。HTTP 洪水打的是静态文件（有 etag/gzip/缓存，很便宜），
  //    而 WS 洪水打的是**每拍推进整个 sim**。正常客户端 60 帧/秒，一帧一个包，
  //    留 4 倍余量给"卡一下之后攒着发"。超了就拆连接：一个正常客户端永远到不了这个数，
  //    而留着一个正在灌的 socket 比拆掉它贵得多。
  wsMsgPerSec: int(process.env.WS_MSG_PER_SEC, 240),
  // ② 每 IP 连接数。maxClients 是进程级的，一个人开满 128 条就没人进得来 ——
  //    这不是"负载问题"，是"他一个人就能把你关门"。
  connsPerIp: int(process.env.CONNS_PER_IP, 6),
  // ③ 每个账号能同时拥有的房间数。房间 id 由客户端随便写 ⇒ 换着 id 建房就能把
  //    MAX_ROOMS 占满。房间是有主人的（谁第一个建的算谁的）。
  roomsPerUser: int(process.env.ROOMS_PER_USER, 2),
};

// ── 生产模式的"配置闸"：**"忘了设"不许长得和"设好了"一模一样** ──
//
// 这一段是判据逼出来的，不是"防御性编程"。上一版 `JOIN_CODE` 不设时取源码里的 `mf2026`，
// 而启动日志只判断真值 ⇒ 打印 **"邀请码 已设"**。于是：
//   · 忘了设环境变量的操作员，看到的是"已配好"；
//   · 而那个码就写在仓库源码里 —— 读过 README 的人都进得来。
// 这个形状（不报错、不崩、看起来对）正是这个仓库一路在抓的那一类，只不过这次落在部署配置上。
//
// 两类东西在**生产模式**下必须显式给值，否则拒绝启动：
//   ① 邀请码：默认值是公开的字符串。要么给一个只有你知道的，要么显式设空表示"我就是要开放注册"。
//   ② 账号库：留空 = 内存库，`REQUIRE_ACCOUNT=1` 时意味着**进程一重启所有人的账号一起消失** ——
//      而这件事只在重启之后才看得出来，那时已经有真玩家了。要么给一个持久路径，要么显式声明访客可玩。
// 开发模式（不设 NODE_ENV / 不带 --prod）不卡这两条：本机起服务不该被部署配置拦住，
// 但启动日志必须**明说**"用的是源码里的默认值"/"内存库"。
//
// 之所以是"拒绝启动"而不是"打个 warnings 接着跑"：警告在 `docker logs` 里活不过三秒，
// 而这两条配错的代价要么是"公开的门"要么是"某天早上所有人的账号没了"。
// 与延迟补偿那一条同一个原则 —— 拒绝，而不是接受一个被伪造过的值。
function assertDeployConfig() {
  if (!CFG.prod) return;
  const bad = [];
  if (!CFG.inviteCodeFromEnv) {
    bad.push([
      '生产模式下必须显式设置 JOIN_CODE，拒绝启动。',
      `  原因：不设时用的是源码里的默认邀请码，而它在仓库里谁都能读到 —— 日志却只会说"已设"，`,
      `        于是"忘了设"和"设好了"长得一模一样。`,
      `  两条出路（选一条）：`,
      `    JOIN_CODE=<只有你知道的码>`,
      `    JOIN_CODE=                 （显式设空 = 我就是要开放注册）`,
    ]);
  }
  if (!CFG.accountsDbFromEnv && CFG.requireAccount) {
    bad.push([
      '生产模式下 REQUIRE_ACCOUNT=1（默认）却没有设 ACCOUNTS_DB，拒绝启动。',
      `  原因：账号库留空 = 内存库。注册、登录、邀请码都照常工作，但进程一重启，`,
      `        所有人的账号一起消失、会话失效 —— 而这件事只在重启之后才看得出来。`,
      `  两条出路（选一条）：`,
      `    ACCOUNTS_DB=/data/accounts.db   （给一个持久路径；容器里记得挂卷）`,
      `    REQUIRE_ACCOUNT=0               （显式声明"这是个不存档案的访客服"）`,
    ]);
  }
  if (!bad.length) return;
  for (const lines of bad) console.error('[配置] ' + lines.join('\n'));
  console.error('[配置] 这两格都是"忘了设不会报错、只会静默走错"的那种，所以在此停住。');
  process.exit(1);
}
assertDeployConfig();


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
// 账号层。放在这里而不是内联进来，是为了让"规则"和"接线"分开：
// 注册/登录/限流的规则在 server/accounts.mjs，存储语义在 server/store.mjs，
// 这一层只管 HTTP 的形状（状态码、cookie、content-type）。
const auth = await createAuth({ cfg: CFG });

// 大厅与房间的控制帧。列成一张表而不是写成一串 else-if 的条件：
// 下面那个分支要按这张表判断"这帧归大厅管"，而漏一条的症状不是报错，是**这帧被静默丢掉**
// —— 房主按开始没反应、聊天发不出去，都属于这一类。
const LOBBY_FRAMES = new Set(['lobby', 'say', 'createRoom', 'joinRoom', 'quickRoom', 'leaveRoom',
  'ready', 'team', 'roomCfg', 'start']);

// 房间的显示名（联机大厅"创建房间"带来的那一格）。它**不是房号** ——
// 房号另有白名单（pickRoom 的 [A-Za-z0-9_.-]），中文房名直接当房号会被清洗成空串、
// 退化成 auto（悄悄塞进别人的房间）。所以房名只做显示，且：
//   · 拍平控制字符（换行能伪造清单行/日志行）、压缩空白、截 24 字；
//   · 空串不写（"没起名"和"起了个空名字"不是一回事）。
function cleanTitle(raw) {
  return String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
}

// 联机大厅要的房间清单（/api/rooms 的清单本体；谁有资格看由 http-api 决定）。
// 只给**玩法**字段 —— /healthz 里那些运维读数（每拍耗时、延迟补偿计数、堆内存）
// 不进这里：那是给扩容和排障用的，发给玩家等于把内部健康度当情报发出去。
// 注意 rooms 里存的是"启动完成"的 promise：还没启动完（p.__room 未挂）的房间
// **不在清单里**。这是诚实的 —— 那种房间连第一个人都还没进去，
// 列出来也只会让人点一个还没建好的空壳。
function roomList() {
  const out = [];
  const seen = new Set();
  for (const p of rooms.values()) {
    const r = p.__room;
    if (!r || r.__stop) continue;
    // 一个人都没有的 live 房不上清单：它正在等回收（roomIdleMs），而谁都进不去它 ——
    // 列出来的那一格 state 恰好还是 'waiting'（人数是判据），症状就是"清单上有一间
    // 永远点不进去的空房"。在跑的那局的真实人数由下面 lobby 那份补上（等待态那张名单）。
    if (!r.clients.size) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      title: r.title || r.id,
      map: r.mapId,
      mode: (r.rules && r.rules.mode) || 'tdm',
      players: r.clients.size,
      max: MAX_SEATS,
      ready: 0,
      state: 'playing',        // 上面已经把"没人在里面的 live 房"筛掉了，走到这里必然是有局的
    });
  }
  // 等待态的那些也在这张清单里 —— "大厅列表"和"/api/rooms"必须是同一份东西，
  // 分两处各列一遍的症状就是 net-drop E 段一直盯着的那件事（画一张假列表也能"看起来有房间"）。
  // 已经开始的以 live 那一份为准（人数是活的），所以放在后面且按 id 去重。
  for (const w of lobby.list()) if (!seen.has(w.id)) out.push(w);
  return out;
}
auth.ctx.listRooms = roomList;

// 每 IP 的连接数，和四个"拒绝"计数。
// 计数要落在生产面上（/healthz 的 gate{}）：限流生效的样子和"服务挂了"在玩家侧完全一样，
// 都是"进不去" —— 没有计数就只能靠猜。
const connsByIp = new Map();
const gate = { connIp: 0, msgFlood: 0, roomQuota: 0, noAuth: 0 };

// ── 这个 try/catch 是必须的，不是"防御性编程" ──
// 下面第一句 `decodeURIComponent('%')` 会抛 URIError。而 createServer(handler) **不理会**
// handler 返回的 promise —— 一次 reject 就是一次 unhandledRejection，
// 而 Node 15+ 的默认行为是**整个进程退出**。
// 也就是说 `curl 'http://这台服务器/%'` 一行就能把对局服务打死（实测见 test/hardening.mjs）。
// 这条和"狂发输入帧"是同一类洞：**一个人的坏输入不该有能力影响其他所有人**。
async function handleRequest(req, res) {
  try { await serveStatic(req, res); }
  catch (e) {
    console.error('[http] ' + (e && e.stack || e));
    try {
      if (!res.headersSent) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('bad request'); }
      else res.end();
    } catch { /* 连接已经没了 */ }
  }
}

async function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  // 账号接口走前面 —— 不然 /api/login 会被当成一个文件路径去找。
  if (await auth.handle(req, res, url)) return;
  if (url === '/healthz' || url === '/health') {
    // 逐房间健康度：扩容要的是"哪一间开始吃紧"，只看一个总数会藏住坏孩子。
    const per = [];
    for (const p of rooms.values()) {
      const r = p.__room;
      // fails 是"这一间这一秒有多少拍在抛异常"：一个客户端的坏数据打死一屋子人之前，
      // 这个数字会先动。运维要能一眼看见坏孩子，而不是等玩家发帖。
      if (r) per.push({ id: r.id, clients: r.clients.size, hz: +(r.__hz || 0).toFixed(1), stepMs: +(r.__stepMs || 0).toFixed(3), behindMs: Math.round(r.__behindMs || 0), fails: r.__fails | 0,
        // 延迟补偿的四项计数（定义见 server/room.mjs 的 this.lag）。带上它的理由和 hz/fails 一样：
        // 这个玩家"永远没有补偿"在玩家侧的表现只是打不中，运维必须能在这里先看见。
        lag: r.lag ? { shots: r.lag.shots, ok: r.lag.ok, noView: r.lag.noView, stale: r.lag.stale, poseMiss: r.lag.poseMiss, depth: [r.lag.dMin, r.lag.dMax, r.lag.ok ? +(r.lag.dSum / r.lag.ok).toFixed(1) : 0] } : null,
        // 连杀奖励的三项计数（定义见 server/room.mjs 的 this.streak）。它和 lag 是同一类
        // 东西：**失效是全静默的** —— 玩家按 3 没反应，既不报错也不崩，运维只能从这里看见。
        // calls=0 尤其要留意：那说明上行那一位根本没接通（客户端旧版本、或按了没发出去）。
        // 恒等式 accepted + rejected === calls 必须永远成立；不成立说明有条分支没记账。
        streak: r.streak ? { calls: r.streak.calls, accepted: r.streak.accepted, rejected: r.streak.rejected, byId: r.streak.byId } : null,
        // 快照头里那一个字节的当前值：UAV 是哪一队、白磷弹在不在、对局结束没有。
        worldFlags: r.rules ? r.rules.worldFlags() : 0 });
    }
    const body = JSON.stringify({
      ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size,
      clients: wss ? wss.clients.size : 0, map: CFG.map, tickHz: Math.round(1 / DT), draining,
      heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1), per,
      // 账号与外围防护的计数。挂在运维面上的理由和前两组（lag / streak）一样：
      // 这些失效**全是静默的** —— 限流把所有人挡在外面、连接被拆、房间建不出来，
      // 玩家侧看到的都是"进不去"，而原因各不相同，只能从这里分辨。
      auth: { ...apiCounters(), users: auth.store.countUsers(), sessions: auth.store.countSessions(),
        // 库是"内存版"还是落盘的，直接写出来：没落盘的部署重启就丢账号，
        // 而这件事不写在页面上，运维会在第一次重启之后才发现。
        store: auth.store.constructor.name, inviteRequired: !!CFG.inviteCode },
      gate: { connsPerIp: CFG.connsPerIp, ips: connsByIp.size, wsMsgPerSec: CFG.wsMsgPerSec,
        roomsPerUser: CFG.roomsPerUser, requireAccount: CFG.requireAccount,
        // 来源检查开没开，自报在这里：ALLOW_ORIGIN 留空 = 不检查。这件事**不做成拒绝启动的闸**
        // （确实有不需要它的部署，理由见 README《还没做完的部分》），但"忘了设"必须能被机器看见 ——
        // 启动日志那行只有人盯着看，remote-probe 拿这一格和"陌生来源握手的实测结果"互相印证，
        // 两处不一致说明有一边在撒谎。
        originCheck: CFG.origins.length > 0,
        refusedConn: gate.connIp, refusedMsg: gate.msgFlood, refusedRoom: gate.roomQuota, refusedAuth: gate.noAuth },
      // 大厅与房间那一层的计数。同一类理由：那五种"开始游戏点了没反应"和"聊天发不出去"
      // 在玩家侧都只是"这游戏坏了"，而原因（不是房主 / 有人没准备 / 刷屏被限流 / 房号撞了）
      // 各不相同，不数出来就只能靠猜。
      lobby: lobby.stats(),
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

const httpServer = createServer(handleRequest);
// 慢速攻击（slowloris）：一个连接每次只发几个字节、永远不发完。不设上限的话每个这样的连接
// 都占着一个 socket，几百个就能把文件描述符吃光。Node 的默认值是 300s/60s，太宽。
httpServer.requestTimeout = 30000;
httpServer.headersTimeout = 15000;
httpServer.keepAliveTimeout = 10000;
// maxPayload 是"单个帧"的上限：没设的话默认 100 MiB，一个乱发的客户端就能把进程内存吃掉。
// 注意它**不是**每连接速率上限 —— 那个是下面 message 处理里的 wsMsgPerSec。
const wss = new WebSocketServer({
  server: httpServer, path: '/ws', maxPayload: CFG.maxPayload,
  verifyClient: ({ req, origin }, done) => {
    // ── 顺序有讲究：先挡最便宜的，再挡要查会话的 ──
    // 把要 await 的鉴权放在最前面的话，一个洪水源可以让每个连接都触发一次会话查找。
    if (CFG.origins.length && origin) {
      // 浏览器必带 Origin；不带（curl、同级进程、健康探针）放行，脚本伪造 Origin 本来也容易，
      // 这一层拦的是"别的网站的访客"，不是"攻击者"。
      if (!CFG.origins.some(o => o === origin || origin.endsWith(o.replace(/^\*\.?/, '.')))) {
        return done(false, 403, 'origin not allowed');
      }
    }
    const ip = clientIp(req, CFG.trustProxy);
    if ((connsByIp.get(ip) | 0) >= CFG.connsPerIp) {
      gate.connIp++;
      // 429 而不是 403：这是一个**配额**问题，客户端可以等一下再来。
      return done(false, 429, 'too many connections from this address');
    }
    // ── 身份在**握手那一刻**定下来，不听 join 帧里自报的呼号 ──
    // 这是本轮最要紧的一处接线：以前 name 是客户端随便写的字符串，服务端只是截到 24 字。
    // 现在它来自会话，join 里的 name 字段直接不看。
    if (!CFG.requireAccount) { req.__user = null; return done(true); }
    // verifyClient 支持异步 done —— 会话查找要走内存表，但仍是 async 的，不能同步完成。
    // 这里**不能**把 done(true) 提前（"先放进来，join 时再验"）：那等于让未登录的连接
    // 先占住名额、先进房间，而"拒绝"就退化成了一句服务端自己听的广播。
    sessionOf(req, auth.accounts)
      .then(u => {
        if (!u) { gate.noAuth++; return done(false, 401, 'login required'); }
        req.__user = u;
        done(true);
      })
      .catch(() => { gate.noAuth++; done(false, 500, 'auth error'); });
  },
});
const rooms = new Map();
// 房间归谁 —— 房间 id 由客户端随便写，所以"换着 id 建房就能把 MAX_ROOMS 占满"这条口
// 只能靠配额堵，而配额要有个"归谁"才能算。谁第一个把这一间建起来就算谁的。
// 刻意**不做** userKey -> Set 的簿记：那样每多一条增删路径就多一处会漏的账
// （房间被回收、连接断了、服务重启……），而按 maxRooms 的规模现算一遍是常数级的。
const roomOwner = new Map();
let draining = false;

// ── 大厅 / 等待态房间（CF 式开房间的那一层，规则本体在 server/lobby.mjs）──
// 注入两件事而不是让它自己去摸这张表：send 是"往这条连接写一帧，且不许因为连接
// 正在断而抛"；liveBusy 是"这个房号已经被一间在跑的 sim 占了吗"。不问一句的话，
// 建房与开局会各自往同一个 id 上挂一份 sim —— 那正是 room.mjs 头注释里数过的串门形状。
const lobby = new Lobby({
  send: (ws, m) => { try { if (ws && ws.readyState === 1) ws.send(m); } catch { /* 已经在断了 */ } },
  liveBusy: (id) => rooms.has(id),
  maxWaiting: CFG.maxRooms * 2,        // 等待态一份 sim 都不建，给两倍额度；上限仍是一道闸
  maxPerUser: CFG.roomsPerUser,        // 和 live 那一份共用 ROOMS_PER_USER：一个人能开的房就这么多
});

function ownedRooms(userKey) {
  let n = 0;
  for (const id of rooms.keys()) if (roomOwner.get(id) === userKey) n++;
  return n;
}

// map 里存的是"启动完成"这个 promise，而不是房间对象本身。
// 之前先 set 再 await start()，第二个加入者会在材质预加载那 ~0.8s 窗口里
// 看到一个 game 还没建好的房间，直接 TypeError（实测：cid 1 被烧掉、B 拿不到身份）。
async function createRoom(id, opts = {}) {
  const room = new NetRoom({ id, mapId: opts.mapId || CFG.map, seed: CFG.seed, mode: opts.mode, cfg: opts.cfg });
  // 这间是"从房间大厅开出来的"（房主按下开始），还是"有人直接 join 一个房号"开出来的。
  // 这个标记决定两件事：打完要不要把这条连接送回房间（见 resultDrain 那一轮），
  // 以及半路上能不能被人用网址挤进来（下面那个 __closed）。
  room.__fromLobby = !!opts.fromLobby;
  await room.start();
  room.__lastBusy = Date.now();
  startRoomLoop(room, id);
  console.log(`[room ${id}] 权威模拟启动，${(1 / DT).toFixed(0)}Hz，每 ${SNAP_EVERY} tick 下一次快照`);
  return room;
}
async function getRoom(id, user = null, opts = {}) {
  let p = rooms.get(id);
  if (!p) {
    // 这三种是"业务上就该拒绝"，不是故障：标一下，让下面的 catch 按拒绝记账而不是甩栈。
    // 例行拒绝也甩堆栈的话，运维很快就学会无视所有堆栈 —— 那时真故障也跟着被无视。
    if (draining) { const e = new Error('服务器正在下线，请重连'); e.refusal = true; throw e; }
    if (rooms.size >= CFG.maxRooms) { const e = new Error(`这台服务器已经有 ${rooms.size} 个房间，不再新建（MAX_ROOMS）`); e.refusal = true; throw e; }
    // 建房配额只在**新建**时检查：已经在用的房间不占新额度，
    // 否则"每进一次房就扣一次"会把老玩家在第三局时挡在门外。
    if (user && ownedRooms(user.key) >= CFG.roomsPerUser) {
      gate.roomQuota++;
      const e = new Error(`你已经有 ${CFG.roomsPerUser} 个房间了，先进其中一个玩，或者等它空出来被回收`);
      e.refusal = true; throw e;
    }
    p = createRoom(id, opts);
    // 健康页要逐房间读数，而表里存的是 promise —— 把解析出来的对象顺手挂在 promise 上，
    // 观测这条路径就不必每拍 await（await 会把读数耦合到建房的那次异步启动上）。
    p.then(r => { p.__room = r; }).catch(() => {});
    rooms.set(id, p);
    if (user) roomOwner.set(id, user.key);
    p.catch(() => rooms.delete(id));            // 起不来的房间不许留在表里反复失败
  }
  return p;
}

// 建房间：房间 id 由客户端随便写 ⇒ 任何人都能用不同的 id 把 MAX_ROOMS 填满，
// 更常见的是"每个人一个私有房"其实根本不想玩同一局。所以显式 id 照旧支持，
// 另给一条自动分配的通路（这就是联机大厅缺的那半，见任务 P1 余下部分）。
// 自动分配按**人最多且没满**的那间塞（fill-first）：对局类服务要的是把人凑一起，
// 而不是负载均衡 —— 按最少人数分会让每个访客都开一间新房，永远碰不到人。
async function pickRoom(requested, user = null) {
  const id = String(requested == null ? 'auto' : requested).slice(0, 48).replace(/[^A-Za-z0-9_.-]/g, '') || 'auto';
  if (id === 'auto') {
    let best = null, bestN = -1;
    for (const p of rooms.values()) {
      const room = await p.catch(() => null);
      // __closed = 从房间大厅开出来的私人局：快速加入不许把人往里塞
      // （列表上那间房的门已经关了，硬塞进去等于把"房主开局"那道闸绕过去）。
      if (!room || room.__stop || room.__closed) continue;
      if (room.clients.size > bestN && room.clients.size < 16) { best = room; bestN = room.clients.size; }
    }
    if (best) return best;
  }
  return getRoom(id, user);
}

// ── 把一条连接接进一间 live 房间 ──
// 两个调用点：直连对局的 join 帧，和房主按下开始（beginLive）。之所以只留一份：
// welcome 那一格里装着槽位表、装备回声、种子与 cid —— 每一格的失效都是静默的
// （少一格槽位表就是"那条路上按 3 没反应"），而两份副本必然会在某次改动后少一格。
function enterMatch(room, ws, { name, team, loadout, account }) {
  const c = room.addClient({ name, team, loadout, account });
  ws.__cid = c.cid; ws.__room = room; c.ws = ws;
  return c;
}
function welcomeFrame(room, c) {
  return {
    t: 'welcome', cid: c.cid, room: room.id, tick: room.tick, map: room.mapId, seed: room.seed,
    // 你的呼号由**服务端**告诉你，而不是你告诉服务端。客户端拿到之后把它盖到本地那份上 ——
    // 不盖的话 HUD 上会一直显示 URL 里那个名字，而记分板上是另一个，玩家会以为串号了。
    name: c.name,
    // 阵营同样由服务端说。房间那条路上它是"房里站的那一队"，不是网址里的 team= ——
    // 少了这一格，客户端会拿自己那份旧值去摆 HUD 与名牌，症状是"我在 B 队，屏幕上我是 A 队"。
    team: c.team,
    pos: [c.pl.pos.x, c.pl.pos.y, c.pl.pos.z], yaw: c.pl.yaw, loadout: c.loadout,
    // 重生等待时长由服务端说：客户端要据此画"3 秒后重新部署"的倒计时，而那个数字的真相
    // 在权威端（server/room.mjs:RESPAWN_DELAY）。客户端自己写一个常数的话，两边一旦不同步，
    // 倒计时数到 0 还会再等一会儿 —— 玩家只会以为"卡住了"。
    respawnDelay: RESPAWN_DELAY,
    // 连杀奖励的槽位表。**必须由服务端给**：按 3/4/5 各是什么、每个要几杀，
    // 这两件事的真相在权威端（规则内核里）；客户端自己按 data.js 那份渲染的话，
    // 服务端换一项客户端还显示旧的，症状是"按了没反应"。
    streaks: room.streakDefs.map(d => ({ id: d.id, name: d.name, icon: d.icon, kills: d.kills })),
    others: [...room.clients.values()].filter(x => x.cid !== c.cid).map(x => ({ id: x.cid, name: x.name, team: x.team })),
  };
}

// 房主按下开始。这里只负责"把名单变成一局"，判据全在 server/lobby.mjs:startGate。
// 顺序有讲究：先把所有人安放进 sim，再逐个发 welcome —— others 是"我进这一间时房里有谁"，
// 边放边发的话第一个进的人看不见后面那几个，症状是房主的世界一开始是空的。
async function beginLive(wroom) {
  if (rooms.has(wroom.id)) return { ok: false, message: '已经有一间同名的房在打了，改个房号再开' };
  if (draining) return { ok: false, message: '服务器正在下线，开不了新局' };
  if (rooms.size >= CFG.maxRooms) return { ok: false, message: `这台服务器已经有 ${rooms.size} 个房间，不再新建（MAX_ROOMS）` };
  const host = wroom.seats.get(wroom.hostSid);
  let live;
  try {
    live = await getRoom(wroom.id, host && host.account ? { key: host.account } : null, {
    mapId: wroom.mapId, mode: wroom.mode, fromLobby: true,
    // 时长是房里选的那一格（分钟）。CFG.matchSeconds 是本地/判据用的强制覆盖，见它那条注释。
    cfg: { mode: wroom.mode, timeLimit: CFG.matchSeconds ? CFG.matchSeconds / 60 : wroom.minutes },
  });
  } catch (e) { return { ok: false, message: String(e && e.message || e) }; }
  live.title = wroom.title;
  // 这间是私人房：只接纳房里那些人。不立这一条的话，任何人都能照着列表里那个房号
  // 手打一个网址挤进别人的对局（"房主要求人人准备"这道闸就白做了 —— 他从没准备过）。
  live.__closed = true;
  const put = [];
  for (const s of wroom.seats.values()) {
    if (!s.ws || s.ws.readyState !== 1) continue;         // 掉线的人不进对局：他在名单上已经不在了
    put.push({ s, c: enterMatch(live, s.ws, { name: s.name, team: s.team, loadout: s.loadout, account: s.account }) });
  }
  for (const { s, c } of put) lobby.send(s.ws, JSON.stringify(welcomeFrame(live, c)));
  console.log(`[room ${wroom.id}] 房主 ${host ? host.name : '?'} 开局：${put.length} 人进 ${wroom.mapId}/${wroom.mode}`);
  return { ok: true, live, n: put.length };
}

function startRoomLoop(room, id) {
  let next = Date.now();
  let since = 0;
  room.__fails = 0;              // 不显式初始化：首拍就抛时 ++undefined = NaN，
  // 于是 "×1 || %60" 两个条件都不成立，一个静默死掉的房间正是最难查的那种红。
  // 自我观测：一台机器上到底能跑几间，只能问"这一拍实际花了多久、循环比墙钟慢了多少"。
  // 客户端侧数不出这个数 —— 它自己被事件循环拖慢时，看到的是同一个症状。
  room.__hz = 0; room.__stepMs = 0; room.__behindMs = 0; room.__hzWin = 0; room.__hzT0 = Date.now();
  const tick = () => {
    if (room.__stop) return;
    // 一个坏 tick 不许静默杀掉整个房间：那症状是"所有人卡住但连接都在"，最难查。
    // 连续失败到阈值就报名字，而不是假装还在跑。
    const t0 = performance.now();
    try {
      room.step();
      room.__fails = 0;
    } catch (e) {
      if (++room.__fails === 1 || room.__fails % 60 === 0) console.error(`[room ${id}] step 失败 ×${room.__fails}: ` + (e && e.stack || e));
      if (room.__fails >= 600) {
        // 到这一步这间已经没救了，但里面的人还不知道 —— 停循环前先给他们一句话，
        // 否则症状又是"站在一个静止的世界里"（客户端看门狗 2.5 秒后也会报，但那句话
        // 说的是"服务器说它死了"，比"我猜它死了"有用）。
        console.error(`[room ${id}] 连续 600 tick 失败，停循环`);
        for (const c of room.clients.values()) {
          try { c.ws.send(JSON.stringify({ t: 'note', msg: `对局 ${id} 服务端异常中止（第 ${room.tick} 拍）。请联系运维或稍后重进` })); c.ws.close(1011, 'room aborted'); } catch (e) { /* 已经在断了 */ }
        }
        return;
      }
    }
    const cost = performance.now() - t0;
    // EMA：单拍的抖动没意义，"这一秒平均花掉预算的几成"才是扩容要看的那个数
    room.__stepMs = room.__stepMs * 0.98 + cost * 0.02;
    if (room.tick % SNAP_EVERY === 0) {
      try { broadcast(room); }
      catch (e) { console.error(`[room ${id}] broadcast 失败: ` + (e && e.stack || e)); }
    }
    since++; room.__hzWin++;
    const now = Date.now();
    if (now - room.__hzT0 >= 1000) {
      room.__hz = room.__hzWin * 1000 / (now - room.__hzT0);
      room.__hzWin = 0; room.__hzT0 = now;
    }
    if (since % 600 === 0 && room.clients.size) console.log(`[room ${id}] tick ${room.tick}  在线 ${room.clients.size}  ${room.__hz.toFixed(1)}Hz 每拍 ${room.__stepMs.toFixed(2)}ms 落后 ${room.__behindMs.toFixed(0)}ms`);
    next += DT * 1000;
    const late = Date.now() - next;
    room.__behindMs = Math.max(0, late);       // 落后墙钟多少：60Hz 承诺唯一能被外部看到的症状
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
  lobby.sweep(now);          // 等待态那些也要收（一张名单而已，但它一样会攒出几百间空房）
  for (const [id, p] of rooms) {
    p.then(room => {
      if (room.__stop || rooms.get(id) !== p) return;
      if (room.clients.size) room.__lastBusy = now;
      else if (now - (room.__lastBusy || now) > CFG.roomIdleMs) {
        room.__stop = true;
        rooms.delete(id);
        roomOwner.delete(id);          // 不删的话配额会永久占着，而房间早就没了
        console.log(`[room ${id}] 空了 ${Math.round((now - room.__lastBusy) / 1000)}s，回收（剩 ${rooms.size} 间）`);
      }
    }).catch(() => {});
  }
}, 5000);
sweeper.unref?.();

// ── 对局结果落库 ──
// 跑在 tick 循环**外面**（1 秒一轮），所以它花多久都不影响任何一间的拍。
// 为什么不在 endMatch 里直接写：见 server/room.mjs:endMatch 上面那一段 ——
// 简单说就是"60 拍/秒的循环里只做 O(1) 内存记账"。
// 丢一局的代价有上限（那一局的经验值），而卡住一整间房没有上限。
function drainResults(room) {
  for (const batch of room.takeResults()) {
    for (const row of batch.rows) {
      const p2 = auth.accounts.addResult(row.account, row);
      if (p2) console.log(`[result] ${row.account} +${row.xp} xp（${row.kills}/${row.deaths}${row.win ? ' 胜' : ''}）→ 累计 ${p2.xp}`);
    }
  }
}

// 打完这一间：先把结果落库，再把 sim 收掉，最后把每条连接从"对局态"退回"房间态"。
// 顺序不能换：takeResults 之后这间就不在 rooms 表里了，晚一步那批经验值就没人取了。
// 为什么必须回：不回的话症状是"胜利之后还能继续杀人"（endMatch 只是发一条事件，
// sim 照跑），而房里的人既看不到房间也开不了下一局。
function returnRoom(id, room) {
  drainResults(room);
  for (const c of room.clients.values()) {
    const ws = c.ws;
    if (!ws) continue;
    // 清这两个字段 = 这条连接不再是某个对局里的玩家。之后它发上来的二进制会被
    // message 处理里那道现成的 `ws.__cid == null` 闸门丢掉，不用另加判断。
    ws.__cid = null; ws.__room = null;
  }
  room.__stop = true;
  rooms.delete(id);
  roomOwner.delete(id);
  lobby.liveEnded(lobby.rooms.get(id));
  console.log(`[room ${id}] 打完收工，回房间（等房主再开）`);
}

const resultDrain = setInterval(() => {
  for (const [id, p] of rooms) {
    const room = p.__room;
    if (!room || !room.takeResults) continue;
    drainResults(room);
    // 只管从房间大厅开出来的局。直连对局那条路（?online=1 与所有探针）打完还是打完 ——
    // 它们没有"房间"可回，而把回收加在那条路上会改掉一批已经在用的判据的量法。
    if (!room.__fromLobby || !room.matchOverSent) continue;
    if (!room.__overAt) room.__overAt = Date.now();
    else if (Date.now() - room.__overAt >= CFG.matchReturnMs) returnRoom(id, room);
  }
}, 1000);
resultDrain.unref?.();

wss.on('connection', (ws, req) => {
  // 身份来自**握手时验过的会话**，不是 join 帧里的自报字段。二者差一个数量级：
  // 前者是一条会被封的实名记录，后者只是一个字符串。
  ws.__user = (req && req.__user) || null;
  // 大厅里还没进任何一间房的人也要能说话（全服频道）。这一格此刻就定下来，
  // 不等到 createRoom —— 因为 say 只认座位上/这一格的名字，谁后填的都不算。
  if (ws.__user) ws.__name = ws.__user.name;
  ws.__ip = clientIp(req || { socket: {} }, CFG.trustProxy);
  connsByIp.set(ws.__ip, (connsByIp.get(ws.__ip) | 0) + 1);
  ws.__msgWin = { t: Date.now(), n: 0 };
  // "还活着"记成时间戳，不记成"这一轮扫描时标志位是不是 true"——见下面 heartbeats 的注释。
  ws.__pongAt = Date.now();
  ws.on('pong', () => { ws.__pongAt = Date.now(); });
  // 必须挂 error：ws 在超帧/协议错/写失败时是在这条连接上 emit 'error' 的，
  // 一个都没人接的 'error' 事件 = 未捕获异常 = 整个进程死掉。
  // 实测：以前只发一个 200 KB 的帧就能把对局服务连带所有人的房间一起打死。
  // 单个访客的坏包不该有能力影响其他房间 —— 这正是部署前必须堵的那个洞。
  ws.on('error', e => { console.error(`[ws error] ${(req && req.socket && req.socket.remoteAddress) || '?'}: ` + (e && e.message || e)); try { ws.terminate(); } catch { /* 已经断了 */ } });
  ws.on('message', async (data, isBinary) => {
    // ── 每连接消息速率闸门 ──
    // 放在最前面，在**任何解析之前**：这一层要挡的正是解析要花的那些 CPU。
    // 一个 64 KB 的帧 = 4096 个输入包，每个都要解一遍位域 —— 而队列本身是有上限的
    // （INPUT_QUEUE=60，多出来的直接丢），所以"狂发"真正烧的是解码，不是内存。
    // 超限就拆连接：正常客户端是 60 帧/秒，永远到不了这个数，
    // 而留着一个正在灌的 socket 比拆掉它贵得多。
    const nowMs = Date.now();
    const w = ws.__msgWin;
    if (nowMs - w.t >= 1000) { w.t = nowMs; w.n = 0; }
    if (++w.n > CFG.wsMsgPerSec) {
      gate.msgFlood++;
      try { ws.close(1008, 'rate limited'); } catch { /* 已经断了 */ }
      return;
    }
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
        const user = ws.__user;
        if (CFG.requireAccount && !user) { ws.send(JSON.stringify({ t: 'err', msg: '需要先登录' })); return; }
        // 呼号的来源见文件头 joinName 的注释。不合法时它会抛一个 refusal，
        // 由下面那个 catch 变成一条 {t:'err'} —— 客户端在加载页上原样显示这一句。
        // 所以访客不会"填了名字却变成访客"：他会当场看到规则，回去改。
        const name = joinName(user, msg.name);
        // 一间还在等人准备的房子里没有 sim。绕过大厅直接进的症状是"进了个空世界，
        // 谁也不在，也没有开始" —— 而这个人本来只需要在房间界面里等房主按一下。
        if (lobby.waitingRoom(msg.room)) { ws.send(JSON.stringify({ t: 'err', msg: '那间房还在等房主开始，请在房间界面里等' })); return; }
        const room = await pickRoom(msg.room, user);
        if (room.__closed) { ws.send(JSON.stringify({ t: 'err', msg: '那间房是房间大厅开出来的私人局，只接纳房里那些人' })); return; }
        // 房间的显示名：**只有建房那一次说了算**（room.title 还空着的时候）。
        // 后来的人改不掉房间名 —— 否则"挂个钓鱼名等别人点进来"就成了一个功能。
        // 不带 title 的老客户端/探针完全不受影响：这一格是可选的。
        if (!room.title && msg.title != null && cleanTitle(msg.title)) room.title = cleanTitle(msg.title);
        // 进座与那一格应答都在 enterMatch / welcomeFrame 里 —— 它们现在有两个调用点
        // （这里，和房主按下开始的 beginLive），一份形状才不会被改漏。
        const c = enterMatch(room, ws, {
          // 要账号的服上这一格来自会话；访客可玩的服上是自报呼号（已过白名单）。
          // 两条路都**不用再 slice(0,24)**：白名单本身限了 2~16 个字。
          name, team: msg.team === 'B' ? 'B' : 'A', loadout: msg.loadout || null, account: user ? user.key : null,
        });
        ws.send(JSON.stringify(welcomeFrame(room, c)));
        console.log(`[join] ${c.name} → cid ${c.cid} @ ${room.id}（在线 ${room.clients.size}，本机 ${wss.clients.size} 连接 / ${rooms.size} 间）`);
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now(), tick: ws.__room?.tick ?? 0 }));
      } else if (msg.t === 'loadout' || msg.t === 'respawn') {
        // 对局内的两条**窄**控制帧。它们都只认"这条连接当前在哪个房间的哪个座位"，
        // 而那个座位是握手时定下的 ⇒ 客户端报不了别人的 cid，也没有越权的余地。
        const room = ws.__room;
        if (!room || ws.__cid == null) return;
        if (msg.t === 'loadout') room.applyLoadout(ws.__cid, msg.loadout || null);
        else room.requestRespawn(ws.__cid);
      } else if (LOBBY_FRAMES.has(msg.t)) {
        // ── 大厅与房间：这一层只接线，判据全在 server/lobby.mjs ──
        // 身份和 join 同源（joinName）：要账号的服上呼号来自会话，访客可玩的服上才看自报那格。
        // 在这里另起一套"聊天用的名字"是最容易出事的地方 —— 那等于给冒充留了一条路。
        if (CFG.requireAccount && !ws.__user) { ws.send(JSON.stringify({ t: 'err', msg: '需要先登录' })); return; }
        const id = () => {
          const n = joinName(ws.__user, msg.name);
          ws.__name = n;
          return { name: n, account: ws.__user ? ws.__user.key : null, xp: ws.__user ? (ws.__user.xp | 0) : 0, loadout: msg.loadout || null };
        };
        if (msg.t === 'lobby') lobby.attach(ws);
        else if (msg.t === 'say') lobby.say(ws, msg);
        else if (msg.t === 'leaveRoom') lobby.leaveRoom(ws);
        else if (msg.t === 'ready') lobby.setReady(ws, msg);
        else if (msg.t === 'team') lobby.setTeam(ws, msg.team);
        else if (msg.t === 'roomCfg') lobby.setCfg(ws, msg);
        else if (msg.t === 'joinRoom') { const r = lobby.joinRoom(ws, { ...msg, ...id() }); if (!r.ok) ws.send(JSON.stringify({ t: 'err', msg: r.message })); }
        else if (msg.t === 'createRoom') { const r = lobby.createRoom(ws, { ...msg, ...id() }); if (!r.ok) ws.send(JSON.stringify({ t: 'err', msg: r.message })); }
        else if (msg.t === 'quickRoom') { const r = lobby.quickRoom(ws, { ...msg, ...id() }); if (!r.ok) ws.send(JSON.stringify({ t: 'err', msg: r.message })); }
        else if (msg.t === 'start') {
          const g = lobby.start(ws);
          if (!g.ok) { ws.send(JSON.stringify({ t: 'err', msg: g.message })); return; }
          const begun = await beginLive(g.room);
          if (!begun.ok) {
            // 开不了局要把房间还回去，并且当场说清楚为什么 —— 否则这间会永远停在
            // "对局中"却没有对局，而房里的人看到的是四个人的静止界面。
            lobby.startFailed(g.room, begun.message);
            ws.send(JSON.stringify({ t: 'err', msg: begun.message }));
            return;
          }
          lobby.pushRoom(g.room);
        }
      }
    } catch (e) {
      // 只把 message 发给客户端、把 stack 留在服务端日志：客户端不该看到栈，
      // 但没有栈的服务端日志在这种时候等于没写
      if (e && e.refusal) console.log(`[ws] 拒绝：${e.message}`);
      else console.error('[ws] ' + (e && e.stack || e));
      ws.send(JSON.stringify({ t: 'err', msg: String(e && e.message || e) }));
    }
  });
  ws.on('close', () => {
    // 连接计数必须**在这里**减：放在别处（比如房间移除那一步）的话，
    // 一个"连上但不 join"的连接就永远占着配额 —— 而那种连接恰好是最便宜的攻击形状。
    const n = (connsByIp.get(ws.__ip) | 0) - 1;
    if (n > 0) connsByIp.set(ws.__ip, n); else connsByIp.delete(ws.__ip);
    const room = ws.__room;
    if (room && ws.__cid != null) { room.removeClient(ws.__cid); console.log(`[leave] cid ${ws.__cid} 断开（在线 ${room.clients.size}）`); }
    // 座位也要跟着退：一个人都没了的房间要被回收，而房主跑掉的那间要移交（见 lobby.mjs）。
    lobby.detach(ws);
  });
});

// 服务级的 error 同样不能没人接（握手阶段的错就发在这里）。
wss.on('error', e => console.error('[wss] ' + (e && e.stack || e)));

// 掉线的连接要收掉，否则半开连接会一直占着房间名额。
// 判据用"上一次收到 pong 的时刻"，不用"这轮扫描时标志位是不是 false"：扫描本身跑在事件循环上，
// 新建一间房（程序化材质 + 地图构建）或一次长 GC 就能让整轮推迟好几秒，那种时刻按标志位判死
// 会把健康玩家踢出去 —— 症状是"人越多越容易莫名其妙掉线"，而这正是浏览器侧观察到过的那次
// 1006 不干净关闭（那边只看到连接被单方面拆掉）。放宽到 3 个周期：真死的连接照样 15 秒内清掉。
const HEARTBEAT_MS = 5000, PONG_STALE_MS = 15000;
const heartbeats = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const quiet = now - (ws.__pongAt || now);
    if (quiet > PONG_STALE_MS) {
      // 报出来：运维看见"谁被踢、沉默了多久"，比只看见玩家消失有用得多
      console.warn(`[hb] 拆掉 ${quiet}ms 没回 pong 的连接（cid ${ws.__cid ?? '-'}，房间 ${ws.__room ? ws.__room.id : '-'}）`);
      try { ws.terminate(); } catch (e) { /* 已经断了 */ }
      continue;
    }
    try { ws.ping(); } catch (e) { /* 已经断了 */ }
  }
}, HEARTBEAT_MS);
heartbeats.unref?.();

// 优雅下线：云平台发 SIGTERM 后只有几秒，直接死的话访客看到的是"突然全冻住"。
// 顺序是：挂下线标志（不再收新 join、/healthz 里 draining=true，让 LB 先摘掉这个实例）
// → 通知在册连接并带 1001(要离开) 关闭 → 停房间循环 → 等已发出的帧发完或到宽限期上限。
async function shutdown(sig) {
  if (draining) return;
  draining = true;
  console.log(`[server] ${sig}：开始下线（宽限 ${CFG.shutdownGraceMs}ms）`);
  httpServer.close();
  clearInterval(sweeper); clearInterval(heartbeats); clearInterval(resultDrain);
  // 落库要在拆连接之前收尾：close() 会把脏数据推下去、并 checkpoint 一次 WAL。
  // 不做的话"正常关服"和"被 kill -9"一样丢最近那一批写入 —— 那"最多丢 250ms"就成了空话。
  try { auth.close(); } catch (e) { console.error('[auth] 关库出错：' + (e && e.message || e)); }
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
  // 邀请码这一格以前只有两态（非空 ⇒ "已设"），于是"忘了设（用的是源码里的默认值）"和
  // "设好了"打印出来一模一样。现在必须是三态，而且未设那一态要**把默认值本身印出来** ——
  // 它不印出来，操作员就没有任何线索知道自己正拿着一个人人皆知的门槛。
  const inviteDesc = !CFG.inviteCodeFromEnv
    ? `**未设（在用源码里的默认值 ${CFG.inviteCode}，生产模式会拒绝启动）**`
    : (CFG.inviteCode ? '已设（来自 JOIN_CODE）' : '已设为空串（开放注册）');
  console.log(`  账号 ${auth.store.constructor.name}${CFG.accountsDb ? ' @ ' + CFG.accountsDb : '（内存，重启就丢）'}` +
    `${CFG.accountsDbFromEnv ? '' : ' ← 未设 ACCOUNTS_DB'} · 邀请码 ${inviteDesc} · 进对局必须登录 ${CFG.requireAccount ? '是' : '否'}`);
  console.log(`  闸门 每 IP 连接 ${CFG.connsPerIp} · 每连接 ${CFG.wsMsgPerSec} 消息/秒 · 每人 ${CFG.roomsPerUser} 间房 · 代理层数 ${CFG.trustProxy}${CFG.trustProxy ? '' : '（忽略 X-Forwarded-For）'}`);
});
