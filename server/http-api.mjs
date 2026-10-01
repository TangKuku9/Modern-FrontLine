// 账号的 HTTP 接口：注册 / 登录 / 登出 / 我是谁。
//
// ── 会话令牌放 HttpOnly Cookie，不放 Bearer + 前端存储 ──
// 两条路都能用，差的是**被打中之后对方能拿走什么**：
//   · Bearer + 前端存储：任何一次 XSS 都能把令牌读出来发走。而这是个游戏 ——
//     呼号会进记分板、进 HTML、进聊天，XSS 面比一个纯 API 服务大得多。
//   · HttpOnly Cookie：JS 读不到，XSS 拿不走。代价是要自己挡 CSRF。
//
// 挡 CSRF 这一侧是**结构性**的，不靠"记得加 token"：
//   · SameSite=Lax —— 跨站发起的 POST 不带这个 cookie；
//   · 只收 content-type: application/json —— 它属于"非简单请求"，
//     浏览器会先发 OPTIONS 预检，而我们不给任何 CORS 头，预检就过不去；
//   · 方法只认 POST —— GET 改不了任何东西。
// 于是"从别的网站点一个链接就把你账号里的东西改了"在协议层不成立。
//
// 还有一个附带好处，对本项目很关键：**WebSocket 握手会自动带上这个 cookie**，
// 所以服务端能在 upgrade 那一刻就把身份钉死，而不是等 join 帧里自报一个呼号。
//
// 同一浏览器两个标签页各登一个账号是支持的场景：登录响应在老名字之外多写一枚
// 按"标签页选择器"命名的 cookie，之后带选择器的请求各用各的会话 —— 机理与
// 信任边界写在下面 tabOf 那段（判据：hardening K 段 + test/tab-session.mjs）。
//
// ── 限流的 key 是 IP，而 X-Forwarded-For 默认**不认** ──
// 认了的话任何人都能随便写这个头，于是"按 IP 限流"变成"按攻击者自己填的字符串限流"，
// 整套限流直接变装饰品。只有在确实放在反向代理后面时才把 TRUST_PROXY 设成代理层数，
// 并且只取从右往左第 N+1 段（代理自己追加的那几跳是可信的，左边全是客户端可伪造的）。
import { Accounts, RateLimiter, NAME_RULE_TEXT } from './accounts.mjs';
import { SqliteStore, MemoryStore } from './store.mjs';

export const SESSION_COOKIE = 'mf_sid';

// 4 KB 够放一个呼号加一个密码，多出来的只可能是打错或者打人。
// 这个数不是"宽容度"，是闸门 —— 见下面 readBody 的说明。
const BODY_LIMIT = 4 * 1024;

// 错误码 → HTTP 状态 + 给人看的一句话。
//
// 注意 `bad_credentials` 那一句：它**必须**同时覆盖"这个呼号不存在"和"密码不对"，
// 不能写成两句。写了的话这张嘴就把账号表送出去了 —— 攻击者先枚举出存在的呼号，
// 再把撞库火力集中到那几个账号上。（accounts.mjs 那边也做了一样的处理，
// 两边是同一道防线：那边管返回值，这边管文案。）
const ERRORS = {
  // 文案来自 accounts.mjs 的 NAME_RULE_TEXT —— 见那边的注释：这句话有两个出口（这里是注册，
  // 那边是访客进房），而它们必须是同一句。
  bad_name: [400, NAME_RULE_TEXT],
  bad_password: [400, '密码长度要在 8~128 个字符之间'],
  bad_invite: [403, '邀请码不对'],
  name_taken: [409, '这个呼号已经有人用了'],
  bad_credentials: [401, '呼号或密码不对'],
  // 与 bad_credentials 同一个理由，而且是同一个坑的第二个出口：这句话必须同时覆盖
  // "这个呼号不存在"、"他没有恢复码"、"码抄错了"三种情况。分开写的话，恢复接口会变成
  // 一个**比登录更好用的账号枚举器**（它连密码都不需要）。
  bad_recovery: [401, '呼号或恢复码不对'],
  too_many: [429, '操作太频繁了，等一下再试'],
  busy: [503, '服务器忙，稍后再试'],
  hashing_failed: [500, '服务端出了点问题'],
};

let apiStat = null;
export function apiCounters() { return apiStat; }

// 有上限地读 body。**不要写 JSON.parse(await readAll(req))** ——
// 那样一个 2 GB 的请求体能在解析之前就把进程内存吃掉。
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) {
        // 这里**不 destroy**：destroy 会连 socket 一起拆掉，于是我们想发出去的那句 413
        // 根本发不出去，客户端只看到一个连接被重置 —— 那正是"打人"和"拒绝"长得一样的形状，
        // 而这一层存在的意义恰恰是让拒绝**可辨认**。
        // 先 pause（别继续读），让上层把 413 写出去，再靠 connection: close 收尾。
        req.pause();
        rej(Object.assign(new Error('body too large'), { code: 'too_large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 见文件头：TRUST_PROXY 是**代理层数**，不是布尔。
// 设 0（默认）＝ 谁都别想用 XFF 影响限流的 key。
export function clientIp(req, trustProxy = 0) {
  const peer = (req.socket && req.socket.remoteAddress) || '-';
  if (!trustProxy) return peer;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  // 从右往左数：最右边是直接连上来的那一跳（我们的代理），是可信的。
  const idx = xff.length - trustProxy;
  return (idx >= 0 && xff[idx]) || peer;
}

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

export function makeSessionCookie(token, { maxAge, secure, name = SESSION_COOKIE }) {
  const bits = [`${name}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  // Secure 只在 HTTPS 下加：加在明文 HTTP 上，浏览器会静默丢掉这个 cookie，
  // 症状是"登录说成功了，下一次请求就说不认识你"，而服务端日志一切正常。
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

// ── 标签页选择器 ──
// 会话 cookie 的作用域是"源"不是"标签页"：同一个浏览器开两个标签页各登一个账号，
// 后登录的那份 Set-Cookie 会把先登录的顶掉（服务端那两行会话都还活着，只是浏览器
// 只剩最后一枚同名 cookie）。先登录的标签页从此带着**别人**的令牌说话 —— 症状是
// "A 在大厅说话，显示成 B 发的言"。修法不是把令牌搬进 sessionStorage（那要推翻
// 文件头"令牌不进 JS 够得着的地方"这条决策），而是给每个标签页一个**公开的**随机
// 选择器：登录响应把"这个标签页自己的"令牌多写进一枚按选择器命名的 cookie
// （mf_sid_<tab>），此后带选择器的请求优先读它。
// 选择器不是秘密：JS 可读、可伪造。伪造它的上限是"选到本浏览器自己登录过的某份
// 会话"，拿不到任何新东西 —— 真正的凭证仍然只有 HttpOnly cookie 那一份。
// 白名单（字符集/长度）挡的是把它塞进 cookie 名里那种注入，不是保密。
const TAB_RE = /^[a-z0-9]{6,16}$/;

// HTTP 请求从头里带（x-tab）；WebSocket 握手带不了自定义头，走 URL 参数（?tab=）——
// 与跨台入场券 ?ticket= 同一个先例（net-server 的 ticketOf）。两处都收、字符集一样，
// 一处定义两边共用 —— 抄第二份的症状是"HTTP 认得这个标签页、WS 不认得"。
export function tabOf(req) {
  const h = String((req.headers && req.headers['x-tab']) || '');
  if (TAB_RE.test(h)) return h;
  try {
    const q = new URL(req.url, 'http://local').searchParams.get('tab') || '';
    return TAB_RE.test(q) ? q : '';
  } catch { return ''; }
}

export function tabCookieName(tab) { return `${SESSION_COOKIE}_${tab}`; }

// 从请求里取会话（HTTP 与 WebSocket 握手共用同一个入口）。
// 一处定义两边共用 —— 抄第二份的症状是"HTTP 认得你、WS 不认得你"，
// 而表现只是"进去了但一直掉线"。
export async function sessionOf(req, accounts) {
  const jar = parseCookies(req.headers && req.headers.cookie);
  // 带了选择器就先查它那份 —— 那是"这个标签页自己登录"的会话。
  // 查不到（这个标签页还没登录过）再退回老名字。这条退路保住两条旧性质：
  // 没带选择器的请求（老探针、手工 curl）照常工作；新开一个标签页
  // 仍然"打开即上次登录的账号"。判据在 test/hardening.mjs K 段与 test/tab-session.mjs。
  const tab = tabOf(req);
  if (tab) {
    const t = jar[tabCookieName(tab)];
    if (t) return accounts.whoami(t);
  }
  const token = jar[SESSION_COOKIE];
  if (!token) return null;
  return accounts.whoami(token);
}

export async function createAuth({ cfg = {}, store } = {}) {
  if (!store) {
    const file = cfg.accountsDb || process.env.ACCOUNTS_DB || '';
    if (file && file !== 'memory') {
      let DatabaseSync = null;
      try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 下面报清楚 */ }
      if (!DatabaseSync) throw new Error('ACCOUNTS_DB 设了但这个 Node 没有 node:sqlite');
      store = new SqliteStore({ file, idleMs: 250, DatabaseSync });
    } else {
      // 没有落盘库时用内存版：**能玩，但重启就没**。
      // 明着说出来，比"配了个 ACCOUNTS_DB 路径但其实写不进去"好。
      store = new MemoryStore();
      console.warn('[auth] 没设 ACCOUNTS_DB，账号只存在内存里 —— 重启就没了');
    }
  }
  const accounts = new Accounts({
    store,
    inviteCode: cfg.inviteCode != null ? cfg.inviteCode : (process.env.JOIN_CODE || ''),
    // 两个限流器的窗口和上限都从配置来 —— 它们**必须**可以按部署调：
    // 一台给几十个人玩的私有服，用"每小时 8 次注册"这种公开运营的默认值会把朋友挡在门外；
    // 反过来，公开服把上限调大就等于把这条防线拆了。写死在代码里的话，两头都会出问题。
    limiter: new RateLimiter({ windowMs: 3600_000, max: (cfg.regPerHour | 0) || 8, baseMs: 5000, maxBackoffMs: 3600_000 }),
    loginLimiter: new RateLimiter({ windowMs: 300_000, max: (cfg.loginPer5Min | 0) || 12, baseMs: 1000, maxBackoffMs: 900_000 }),
  });
  apiStat = {
    reg: 0, login: 0, recover: 0, logout: 0, me: 0, rejected: 0, tooLarge: 0, badMethod: 0,
    tooMany: 0, busy: 0, notFound: 0,
  };
  const secure = cfg.cookieSecure != null ? cfg.cookieSecure : !!cfg.prod;
  const trustProxy = cfg.trustProxy | 0;
  const ttlSec = Math.floor(accounts.sessionTtlMs / 1000);

  const ctx = {
    accounts, store, stat: apiStat, secure, trustProxy, ttlSec, inviteRequired: !!accounts.inviteCode,
    // "这个服要不要账号"也是**部署时定的策略**（REQUIRE_ACCOUNT），客户端不该自己猜。
    // 猜错的方向很具体：访客可玩的服上，大厅会摆出一个玩家填不出来的登录框，
    // 而错误信息还会是"呼号或密码不对" —— 把一个"这里不需要密码"说成了"你密码打错了"。
    // 所以它必须从服务端透出来，让大厅按它决定渲染登录表单还是只渲染一个呼号框。
    requireAccount: cfg.requireAccount !== false,
  };

  // 返回 true 表示"这个请求我处理了"，false 表示交回给静态服务。
  async function handle(req, res, url) {
    if (!url.startsWith('/api/')) return false;
    const path = url.split('?')[0];
    const ip = clientIp(req, trustProxy);
    const { stat } = ctx;
    // 本请求的标签页选择器（没有就是空串 = 一切照旧，只用老名字那一枚）。
    const tab = tabOf(req);
    // 登录成功要写的 set-cookie：老名字一枚（新开标签页"打开即上次登录"的兜底），
    // 带选择器时再加一枚**这个标签页私有的**。两枚名字不同，浏览器各存各的、
    // 谁也不顶谁 —— 先登录的标签页不再被后登录的改身份。
    const sessionCookies = (token) => {
      const sc = [makeSessionCookie(token, { maxAge: ttlSec, secure })];
      if (tab) sc.push(makeSessionCookie(token, { maxAge: ttlSec, secure, name: tabCookieName(tab) }));
      return sc;
    };

    if (path === '/api/status') {
      // 这个接口刻意**不需要登录也不需要 POST**：客户端在渲染登录框之前就得知道
      // "这个服要不要邀请码""这个服要不要账号"，否则它会显示一个用户填不出来的空框。
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        stat.badMethod++;
        send(res, 405, { ok: false, error: 'bad_method', message: '请求方式不支持' }, { allow: 'GET' });
        return true;
      }
      send(res, 200, {
        ok: true, inviteRequired: ctx.inviteRequired, requireAccount: ctx.requireAccount,
        accounts: store.countUsers(),
      });
      return true;
    }

    // ── 路由表：路径 → 它接受的唯一方法 ──
    // 先查"有没有这个路由"，再查"方法对不对"。反过来写的话，一个不存在的路径会得到 405，
    // 而 405 会让人去改方法、404 才会让人去改路径 —— 报错要指向真正的错处。
    const ROUTES = {
      '/api/status': 'GET',      // 只读：这个服要不要邀请码
      '/api/me': 'GET',          // 只读：我是谁
      '/api/rooms': 'GET',       // 只读：联机大厅的房间列表（要账号的服上未注册不开放）
      '/api/register': 'POST',
      '/api/login': 'POST',
      '/api/recover': 'POST',    // 忘了密码：呼号 + 一次性恢复码 + 新密码
      '/api/dispatch': 'POST',   // 跨台入场券（房间目录开着才有；要账号的服必须带会话）
      '/api/logout': 'POST',
    };
    const want = ROUTES[path];
    if (!want) {
      stat.notFound++;
      // 不在路由表里的 /api/* 一律 404，**不许落到静态服务那条路上去** ——
      // 落过去的话它会被当成一个文件路径去找，于是 /api/../server 这类形状就有了意义。
      send(res, 404, { ok: false, error: 'no_route', message: '接口不存在' });
      return true;
    }
    const m = req.method === 'HEAD' ? 'GET' : req.method;
    if (m !== want) {
      stat.badMethod++;
      send(res, 405, { ok: false, error: 'bad_method', message: `请求方式不支持（仅支持 ${want}）` }, { allow: want });
      return true;
    }

    // ── 只读接口止步于此 ──
    // 它们没有请求体要读，也没有状态要改。**没有 CSRF 面**：跨站 GET 拿不到响应体
    //（我们不给任何 CORS 头，浏览器不会把响应给发起方），所以"读"是安全的。
    // 曾经这里写过"一律 POST"，于是 GET /api/me 得到 405 —— 那是个真 bug，
    // 不是"更安全的选择"：让每个客户端都用 POST 去问"我是谁"，只是多一行代码，
    // 却把"可缓存、可重放、可以贴在浏览器地址栏里"这些 GET 该有的性质全丢了。
    if (path === '/api/me') {
      const u = await sessionOf(req, accounts);
      stat.me++;
      // ── 没登录时返回 200 + loggedIn:false，而不是 401 ──
      // 这不是把状态码用松了，是因为 **HttpOnly cookie 对 JS 不可见**：
      // 客户端没有任何办法"先看看自己有没有会话"，它唯一的做法就是问一次。
      // 而"没登录"是一次**正常的问答**，不是一个错误。
      // 返回 401 的代价很具体：浏览器会把每一条 401 当错误写进控制台 ——
      // 于是**每一次页面加载**都会多一条红色的 "Failed to load resource: 401"。
      // 而"控制台没有真错误"是这个项目里最灵敏的一条判据（它比任何数值判据都先发现问题）。
      // 拿一条必然出现的假警去废掉那条判据，是在用最灵敏的量具换一个状态码的语义正确性，不划算。
      // 真正的安全属性（没会话就读不到别人的档案）由 `u` 决定，跟状态码无关。
      if (!u) { send(res, 200, { ok: true, loggedIn: false, name: null, profile: null }); return true; }
      send(res, 200, { ok: true, loggedIn: true, name: u.name, profile: accounts.publicProfile(u) });
      return true;
    }

    if (path === '/api/rooms') {
      // 联机大厅的房间清单。清单本体从 net-server 注入的 `ctx.listRooms` 取 ——
      // 房间的真相在那边（rooms 表），这里只决定**谁有资格看**。
      //
      // ── 未完成注册前，联网对战不开放 ── 这一格是那条需求在服务端的落点：
      // 客户端把列表藏起来只是显示（改得动），而这里对没会话的请求直接 401，
      // 和 WS 握手那道 401 是同一条规则的两半。**只藏 UI 不算数** —— 那是权限，
      // 不是排版。访客可玩的服（REQUIRE_ACCOUNT=0）不要会话：那是部署时明说的策略，
      // 不是漏检（和 join 时那句 `CFG.requireAccount && !user` 同源）。
      //
      // 与 /api/me 的 200+loggedIn:false **不矛盾**：那是"每次页面加载都会问一次"的
      // 例行问答，401 会给每一次加载配一条必然出现的控制台红字；而这个接口只有
      // 大厅里"已经获准进场的人"才会拉，未注册的人根本走不到这个调用 —— 拒了就是拒了。
      if (ctx.requireAccount) {
        const u = await sessionOf(req, accounts);
        if (!u) {
          stat.rejected++;
          send(res, 401, { ok: false, error: 'login_required', message: '注册或登录后才能查看房间列表' });
          return true;
        }
      }
      send(res, 200, { ok: true, rooms: ctx.listRooms ? ctx.listRooms() : [] });
      return true;
    }

    // CSRF 的第二道闸：只收 application/json。它是"非简单请求"，
    // 跨站发它必然先走 OPTIONS 预检，而 OPTIONS 不在路由表里 ⇒ 405 ⇒ 预检过不去。
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') {
      stat.badMethod++;
      send(res, 415, { ok: false, error: 'bad_content_type', message: 'content-type 必须是 application/json' });
      return true;
    }

    let raw;
    try { raw = await readBody(req); }
    catch (e) {
      if (e.code === 'too_large') {
        stat.tooLarge++;
        // connection: close —— 请求体还在对方手里没发完，我们不会再去读它。
        // 声明关连接比"读到一半就走人"干净：客户端知道自己该重新握手，而不是等一个永远不来的响应。
        send(res, 413, { ok: false, error: 'too_large', message: '请求过大' }, { connection: 'close' });
        return true;
      }
      send(res, 400, { ok: false, error: 'bad_body', message: '请求无效' });
      return true;
    }
    let body;
    try { body = JSON.parse(raw || '{}'); }
    catch { send(res, 400, { ok: false, error: 'bad_json', message: '请求格式无效' }); return true; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { ok: false, error: 'bad_json', message: '请求格式无效' });
      return true;
    }

    const fail = (r) => {
      const [status, message] = ERRORS[r.error] || [400, '请求不对'];
      stat.rejected++;
      if (r.error === 'too_many') {
        stat.tooMany++;
        // Retry-After 让守规矩的客户端自己退避，而不是原地重试把窗口撞得更满
        send(res, status, { ok: false, error: r.error, message, retryAfterMs: r.retryAfterMs | 0 },
          { 'retry-after': String(Math.max(1, Math.ceil((r.retryAfterMs | 0) / 1000))) });
      } else if (r.error === 'busy') {
        stat.busy++;
        send(res, status, { ok: false, error: r.error, message }, { 'retry-after': '2' });
      } else {
        send(res, status, { ok: false, error: r.error, message });
      }
    };
    // extra 只用来带**一次性**的东西（恢复码原文）。它故意不塞进 profile 那个形状里：
    // profile 会被客户端存进 localStorage、会进截图、会进日志，
    // 而恢复码的整个设计前提是"原文只在发出去的那一刻存在"。
    const pass = (r, extraHeaders = {}, extra = null) => {
      // loggedIn 与 /api/me 保持同一个形状：客户端只需要认这一格，不必为三条路径各写一套判断。
      send(res, 200, { ok: true, loggedIn: true, name: r.name, profile: r.profile, ...(extra || {}) }, extraHeaders);
    };

    if (path === '/api/register') {
      const r = await accounts.register({ name: body.name, password: body.password, code: body.code, ip });
      if (!r.ok) return fail(r), true;
      stat.reg++;
      // 恢复码**就在这一条响应里**，之后再也要不回来（服务端只有哈希）。
      pass(r, { 'set-cookie': sessionCookies(r.token) },
        r.recovery ? { recovery: r.recovery } : null);
      return true;
    }

    if (path === '/api/login') {
      const r = await accounts.login({ name: body.name, password: body.password, ip });
      if (!r.ok) return fail(r), true;
      stat.login++;
      pass(r, { 'set-cookie': sessionCookies(r.token) });
      return true;
    }

    if (path === '/api/recover') {
      // 忘了密码那条路：呼号 + 一张一次性恢复码 + 新密码。
      // 它**不要邀请码**（邀请码是给"新账号"的闸，而这里是已经存在的账号），
      // 也不要旧密码 —— 要旧密码就不叫找回了。
      // 反过来说，这条路只能靠"恢复码"这一个秘密把住门：
      // 所以它在 accounts.mjs 那边共用登录的限流表、共用同一句错误文案。
      const r = await accounts.recover({ name: body.name, code: body.code, password: body.password, ip });
      if (!r.ok) return fail(r), true;
      stat.recover++;
      // 成功 = 登录成功（顺带把旧会话全部作废、并换一整叠新码，理由见 accounts.mjs）。
      pass(r, { 'set-cookie': sessionCookies(r.token) },
        r.recovery ? { recovery: r.recovery } : null);
      return true;
    }

    if (path === '/api/dispatch') {
      // ── 跨台入场券（房间目录开着才有；信任模型写在 server/room-dir.mjs 文件头）──
      // 玩家在 A 台的页面上点 B 台的房：A 台验过他是谁（会话），B 台却不认识 A 台发的
      // 会话 cookie —— 账号账本是**进程私有**的（server/multi-account-probe.mjs 钉着的那条账）。
      // 这张票是中间的桥：A 台验明身份后把票写进目录，B 台在 ws 握手那一刻消费它。
      // 票只带 key/呼号/XP（与一次成功登录能建立的身份等价）、单次有效、短 TTL ——
      // 偷到票的窗口与偷到会话 cookie 同阶，没有引入新的信任级。
      // 目录没开的服：404。客户端不会画出"另一台"的行，手工打它也拿不到票。
      if (!ctx.dir) {
        stat.rejected++;
        send(res, 404, { ok: false, error: 'no_directory', message: '这台服务器未开启跨进程房间目录' });
        return true;
      }
      let me = null;
      if (ctx.requireAccount) {
        me = await sessionOf(req, accounts);
        if (!me) {
          stat.rejected++;
          send(res, 401, { ok: false, error: 'login_required', message: '注册或登录后才能获取跨台入场券' });
          return true;
        }
      }
      // 目标必须是**目录里登记着的另一台**、room 必须是它名下的行（mintFor 里验）：
      // 不做这一步，"发票"就成了把本台的登录身份转发到任意地址的免费代理。
      const tok = ctx.dir.mintFor({ room: String(body.room || ''), url: String(body.url || ''), user: me });
      if (!tok) {
        stat.rejected++;
        send(res, 400, { ok: false, error: 'bad_target', message: '目标不在房间目录里（url 必须是目录中登记的另一台，room 必须是它名下的房）' });
        return true;
      }
      send(res, 200, { ok: true, ticket: tok });
      return true;
    }

    if (path === '/api/logout') {
      // cookie 两枚都清：只清标签页那枚的话，这个标签页下一次请求会退回到仍旧活着的
      // 兜底 —— 症状是"登出说成功了，刷新一下又是登录态"；只清兜底那枚同理反过来。
      // 服务端的**行**只杀本标签页自己的那份。兜底那枚的行不跟着杀 —— 它永远指向
      // "最后一次登录"，那很可能正是**另一个标签页**此刻用着的同一行（同一个令牌写了两枚
      // cookie）；杀了它，"每个标签页一份身份"就在登出这条路上漏气。它的 cookie 清掉之后
      // 本标签页与新标签页都退不回它了，留下的只是别标签页自己那份还活着的凭据。
      // 没带选择器的老形状（整浏览器一份）保持原语义：登出 = 杀行 + 清 cookie。
      const jar = parseCookies(req.headers.cookie);
      const tabTok = tab ? jar[tabCookieName(tab)] : undefined;
      const legacyTok = jar[SESSION_COOKIE];
      if (tab) {
        if (tabTok) await accounts.logout(tabTok);
      } else if (legacyTok) {
        await accounts.logout(legacyTok);
      }
      stat.logout++;
      // Max-Age=0 清掉它。只删服务端那一份是不够的：浏览器手里那个还在，
      // 下次访问还会带上，而服务端已经不认识它了 —— 表现是"登出之后一直说自己没登录"。
      const clear = (name) => makeSessionCookie('', { maxAge: 0, secure, name });
      const sc = [clear(SESSION_COOKIE)];
      if (tab) sc.push(clear(tabCookieName(tab)));
      send(res, 200, { ok: true }, { 'set-cookie': sc });
      return true;
    }

    // 走到这里说明路由表里有这条路径、方法也对 —— 而它们已经全部在上面处理掉了。
    // 留一个显式的兜底而不是静默 return true：以后往 ROUTES 里加一条却忘了写分支时，
    // 症状会是"接口存在但什么都不发生"（客户端一直等），而这里会当场说清楚。
    stat.notFound++;
    send(res, 501, { ok: false, error: 'not_implemented', message: '功能未开放' });
    return true;
  }

  return { handle, ctx, accounts, store, close: () => store.close && store.close() };
}
