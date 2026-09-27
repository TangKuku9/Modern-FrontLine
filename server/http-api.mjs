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

export function makeSessionCookie(token, { maxAge, secure }) {
  const bits = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  // Secure 只在 HTTPS 下加：加在明文 HTTP 上，浏览器会静默丢掉这个 cookie，
  // 症状是"登录说成功了，下一次请求就说不认识你"，而服务端日志一切正常。
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

// 从请求里取会话（HTTP 与 WebSocket 握手共用同一个入口）。
// 一处定义两边共用 —— 抄第二份的症状是"HTTP 认得你、WS 不认得你"，
// 而表现只是"进去了但一直掉线"。
export async function sessionOf(req, accounts) {
  const token = parseCookies(req.headers && req.headers.cookie)[SESSION_COOKIE];
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
    reg: 0, login: 0, logout: 0, me: 0, rejected: 0, tooLarge: 0, badMethod: 0,
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
    const pass = (r, extraHeaders = {}) => {
      // loggedIn 与 /api/me 保持同一个形状：客户端只需要认这一格，不必为三条路径各写一套判断。
      send(res, 200, { ok: true, loggedIn: true, name: r.name, profile: r.profile }, extraHeaders);
    };

    if (path === '/api/register') {
      const r = await accounts.register({ name: body.name, password: body.password, code: body.code, ip });
      if (!r.ok) return fail(r), true;
      stat.reg++;
      pass(r, { 'set-cookie': makeSessionCookie(r.token, { maxAge: ttlSec, secure }) });
      return true;
    }

    if (path === '/api/login') {
      const r = await accounts.login({ name: body.name, password: body.password, ip });
      if (!r.ok) return fail(r), true;
      stat.login++;
      pass(r, { 'set-cookie': makeSessionCookie(r.token, { maxAge: ttlSec, secure }) });
      return true;
    }

    if (path === '/api/logout') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      await accounts.logout(token);
      stat.logout++;
      // Max-Age=0 清掉它。只删服务端那一份是不够的：浏览器手里那个还在，
      // 下次访问还会带上，而服务端已经不认识它了 —— 表现是"登出之后一直说自己没登录"。
      send(res, 200, { ok: true }, { 'set-cookie': makeSessionCookie('', { maxAge: 0, secure }) });
      return true;
    }

    // 走到这里说明路由表里有这条路径、方法也对 —— 而那四条已经全部在上面处理掉了。
    // 留一个显式的兜底而不是静默 return true：以后往 ROUTES 里加一条却忘了写分支时，
    // 症状会是"接口存在但什么都不发生"（客户端一直等），而这里会当场说清楚。
    stat.notFound++;
    send(res, 501, { ok: false, error: 'not_implemented', message: '功能未开放' });
    return true;
  }

  return { handle, ctx, accounts, store, close: () => store.close && store.close() };
}
