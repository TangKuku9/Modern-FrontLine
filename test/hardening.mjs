// 外围防护的判据：走**真服务**（真 HTTP、真 WebSocket 握手），不打桩。
//
// 这一份和 test/accounts.mjs 分工不同，要一起看：
//   · accounts.mjs 量的是**规则**（哈希、令牌、限流、邀请码）—— 纯逻辑，快，能跑到边界；
//   · 这一份量的是**接线**（这些规则有没有真的挂到接口和长连接上）。
// 只做前者的话，会出现"规则全对、但接口根本没调它"这种绿 —— 那正是这一轮要消灭的形状。
//
// ── 这一份每一条都对应一个具体的攻击 ──
// 它们的共同点是：**打中了也不报错**。限流生效和"服务挂了"在玩家侧长得一模一样（都是进不去），
// 畸形 URL 打死进程和"被人重启了"长得一模一样。所以每一条都必须从**外面**量，
// 并且尽量落到 /healthz 的计数上 —— 那是运维唯一能看见它们的地方。
import { withServer, freePort } from './with-server.mjs';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';

let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  | ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  | ' + detail : ''}`);
}
const sec = n => `\n── ${n} ──`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const INVITE = 'HARD-CODE';
const PW = 'a-long-enough-password';

// 用原生 http.request 而不是 fetch：**这一份要能发畸形和未经归一化的路径**。
// fetch 会在客户端先把 URL 规范化掉，于是"服务端收到 /%"、"服务端收到 /..%2f.." 这些
// 事情根本发生不了 —— 那就成了一条量不到东西的判据（在客户端被拦住了，看起来却像服务端很安全）。
// 第一版就踩了同一个坑：`new URL(base + '/api/../../package.json')` 在**客户端**把 `..` 折掉了，
// 服务端收到的是 `/package.json`，于是那条判据量的是"能不能读 package.json"而不是目录穿越。
function raw(url, { method = 'GET', headers = {}, body = null, path = null } = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = httpRequest({ host: u.hostname, port: u.port, path: path != null ? path : u.pathname + u.search, method, headers }, r => {
      let t = '';
      r.on('data', c => { t += c; });
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, text: t }));
      r.on('aborted', () => res({ status: r.statusCode, headers: r.headers, text: t, aborted: true }));
      r.on('error', () => res({ status: r.statusCode, headers: r.headers, text: t, aborted: true }));
    });
    req.on('error', rej);
    if (body) req.write(body);
    req.end();
  });
}
// 原样发一个路径，不做任何归一化。
const rawPath = (base, p, opts = {}) => raw(base, { ...opts, path: p });
const json = (url, obj, headers = {}) =>
  raw(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });
const cookieOf = r => {
  const sc = r.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : String(sc || '');
  return first.split(';')[0];
};

function openWs(url, cookie) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    const msgs = [];
    ws.on('message', d => { try { const m = JSON.parse(String(d)); msgs.push(m); } catch { /* 二进制快照，不要 */ } });
    ws.on('open', () => res({ ws, msgs }));
    ws.on('error', e => rej(Object.assign(e, { ws, msgs })));
    // ws 对非 101 的响应会 emit 这个事件 —— 这是观察 401/429 的**唯一干净入口**，
    // 比从 error.message 里正则抠状态码可靠。
    ws.on('unexpected-response', (req, resp) => {
      resp.resume();
      rej(Object.assign(new Error('handshake ' + resp.statusCode), { status: resp.statusCode, ws, msgs }));
    });
  });
}
async function waitFor(msgs, pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = msgs.find(pred); if (hit) return hit; await sleep(40); }
  return null;
}

// 起一个进程，把"它自己退了"和"它起来了"两件事都交出来 —— 这两条不能都用 with-server.mjs 量：
// 那个在服务没起来时会抛"临时服务没起来"，退出码就丢了，而这里要量的**正是**退出码。
// 端口给随机高位值：该拒绝启动的用例本该在 bind 之前就停住，端口没被占用才说明它死在配置闸上。
//
// spawn 的 env 里 `undefined` 到底是"删掉这个变量"还是"字符串 undefined"，跨 Node 版本不该由我们猜
// —— 想要"这个变量不存在"就在这里显式 delete（这一段的 H1/H6 量的就是"没设"）。
function childEnv(env) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return e;
}
async function bootRaw(env, { ms = 20000 } = {}) {
  const { spawn } = await import('node:child_process');
  // 端口用 with-server.mjs 那个"问内核要一个空闲端口"的办法，不自己随机：随机撞上别人占用的端口时，
  // 进程会因为**别的**原因起不来，而 H5/H6 量的是"它该起来" —— 那种红查起来完全不讲道理。
  // 20 秒这个数是**量具的耐心上限，不是判据线**：判据是"起来了 + 日志写了什么"，而绿色路径
  // 在看到启动行的那一拍就早退，所以这个上限只在机器被拖慢时才起作用 —— 单跑一两秒、
  // 全套件跑热后 spawn 偶发超过 8 秒，把 H6 抹成过一次红（实测 2026-09-26），才把窗口补上。
  const port = await freePort();
  const s = spawn(process.execPath, ['server/net-server.mjs', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env) });
  let log = '', exitCode = null;
  s.stdout.on('data', d => { log += d; });
  s.stderr.on('data', d => { log += d; });
  s.on('exit', c => { exitCode = c; });
  const t0 = Date.now();
  // 等两件事之一：它报出启动行（起来了），或者它自己退了（被配置闸拦住了）
  while (Date.now() - t0 < ms && exitCode === null && !log.includes('权威对局服务')) await sleep(50);
  const up = log.includes('权威对局服务');
  if (!up) { const t = Date.now(); while (exitCode === null && Date.now() - t < 3000) await sleep(50); }
  return { up, code: exitCode, port, base: `http://127.0.0.1:${port}`, log, kill: () => { try { s.kill(); } catch { /* 已经退了 */ } } };
}

const srv = await withServer({ JOIN_CODE: INVITE, CONNS_PER_IP: '3', WS_MSG_PER_SEC: '20', ROOMS_PER_USER: '1' });
const health = async () => JSON.parse((await raw(srv.base + '/healthz')).text);

try {

  // ══════════ A 账号接口的正确路径 ══════════
  console.log(sec('A 账号接口'));
  {
    const st = await raw(srv.base + '/api/status');
    const j = JSON.parse(st.text);
    chk(st.status === 200 && j.inviteRequired === true, 'A1 /api/status 起得来，并说出这个服要不要邀请码', st.text);
    // 这一条和 G 段的 G1 是一对：这里量默认（要账号），那边量 REQUIRE_ACCOUNT=0（不要账号）。
    // 只量一边的话，一个把 requireAccount 写死成常数的实现也会绿。
    chk(j.requireAccount === true, 'A1b /api/status 还说得出"这个服要不要账号"（大厅按它决定画登录表单还是呼号框）', st.text);

    const r = await json(srv.base + '/api/register', { name: '甲方', password: PW, code: INVITE });
    chk(r.status === 200 && JSON.parse(r.text).ok === true, 'A2 注册成功', `${r.status} ${r.text}`);

    // ── 令牌必须带 HttpOnly ──
    // 少了它，任何一次 XSS 都能把令牌读走 —— 而这是个游戏，呼号会进记分板、进 HTML。
    const sc = String(r.headers['set-cookie'] || '');
    chk(/HttpOnly/i.test(sc), 'A3 会话 cookie 带 HttpOnly（XSS 读不到它）', sc.replace(/=[^;]+/, '=<令牌>'));
    chk(/SameSite=Lax/i.test(sc), 'A4 会话 cookie 带 SameSite=Lax（跨站的 POST 不带它，CSRF 的第一道闸）');
    chk(/max-age=\d+/i.test(sc), 'A5 cookie 有有效期（没有的话关掉浏览器就没了）');

    // ── 令牌原文不许出现在响应体里 ──
    // 出现在 body 里的话，它就会进浏览器历史、进各种前端日志、进错误上报。
    const body = JSON.parse(r.text);
    const token = /mf_sid=([^;]+)/.exec(sc);
    chk(!token || !r.text.includes(decodeURIComponent(token[1])),
      'A6 令牌只在 cookie 里，响应体里没有第二份（body 会被缓存、被日志、被截图）');
    chk(body.profile && !('salt' in body.profile) && !('hash' in body.profile) && !('key' in body.profile),
      'A7 响应里的档案不含 salt/hash/key', JSON.stringify(body.profile));

    const cookie = cookieOf(r);
    const me = await raw(srv.base + '/api/me', { headers: { cookie } });
    chk(me.status === 200 && JSON.parse(me.text).name === '甲方', 'A8 带着 cookie 问"我是谁"能答上来', me.text);

    // ── A9/A11 "我是谁"问不到东西时的形状 ──
    // **它返回 200，不是 401。** 这不是把状态码用松了，原因写在 server/http-api.mjs 里：
    // HttpOnly cookie 对 JS 不可见，客户端只能问一次"我有没有登录"，而"没登录"是一次
    // 正常的问答、不是一个错误。返回 401 的代价是每一次页面加载都多一条必然出现的控制台
    // 错误，而"控制台没有真错误"是本项目最灵敏的一条判据（test/net-play.mjs 在量它）。
    // 所以这里量的是**那一格的内容**：安全属性在 `loggedIn` 上，跟状态码无关。
    const noCookie = await raw(srv.base + '/api/me');
    const nc = JSON.parse(noCookie.text);
    chk(noCookie.status === 200 && nc.ok === true && nc.loggedIn === false && nc.profile === null && nc.name === null,
      'A9 不带 cookie 问"我是谁"：200 + loggedIn:false、profile 为空（反证臂：不是"谁来都说是甲方"）',
      `${noCookie.status} ${noCookie.text}`);

    const out = await json(srv.base + '/api/logout', {}, { cookie });
    chk(out.status === 200 && /max-age=0/i.test(String(out.headers['set-cookie'])),
      'A10 登出会把浏览器那份 cookie 也清掉（只删服务端那份的话，客户端会一直带着一个没人认的令牌）');
    const me2 = await raw(srv.base + '/api/me', { headers: { cookie } });
    const m2 = JSON.parse(me2.text);
    chk(m2.loggedIn === false && m2.profile === null, 'A11 登出之后那个 cookie 立刻作废（同一个 cookie，答案翻面了）',
      `${me2.status} ${me2.text}`);
  }

  // ══════════ B 把接口当攻击面 ══════════
  console.log(sec('B 接口本身当攻击面'));
  {
    // ── B1 方法白名单 ──
    const g = await raw(srv.base + '/api/login', { method: 'GET' });
    chk(g.status === 405 && String(g.headers.allow || '').includes('POST'),
      'B1 GET /api/login 是 405（GET 改不了任何东西，这一条是 CSRF 的第三道闸）', `${g.status} allow=${g.headers.allow}`);

    // ── B2 content-type ──
    // 只收 application/json：它是"非简单请求"，跨站发它必然先走 OPTIONS 预检，
    // 而我们不给任何 CORS 头 ⇒ 预检过不去 ⇒ 跨站表单 POST 到不了这里。
    const ct = await raw(srv.base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: '甲方', password: PW }),
    });
    chk(ct.status === 415, 'B2 content-type 不是 application/json 就 415（挡住跨站表单那条路）', String(ct.status));

    const form = await raw(srv.base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=甲方&password=x',
    });
    chk(form.status === 415, 'B3 跨站表单那种 content-type 同样被拒（这就是 CSRF 的原形）', String(form.status));

    // ── B4 错邀请码 / 重名 / 短密码 ──
    // 名字都用两个字：单字（'乙'、'丙'）会先撞上 bad_name，于是下面这两条量的是
    // "名字不合法"而不是"邀请码对不对"、"密码短不短"。第一版就是这么写的。
    const bad = await json(srv.base + '/api/register', { name: '乙方', password: PW, code: 'WRONG' });
    chk(bad.status === 403 && JSON.parse(bad.text).error === 'bad_invite', 'B4 邀请码错 → 403', bad.text);
    const dup = await json(srv.base + '/api/register', { name: '甲方', password: PW, code: INVITE });
    chk(dup.status === 409 && JSON.parse(dup.text).error === 'name_taken', 'B5 呼号重名 → 409', dup.text);
    const short = await json(srv.base + '/api/register', { name: '丙方', password: 'x', code: INVITE });
    chk(short.status === 400 && JSON.parse(short.text).error === 'bad_password', 'B6 密码太短 → 400', short.text);
    const zw = await json(srv.base + '/api/register', { name: '甲\u200b方', password: PW, code: INVITE });
    chk(zw.status === 400 && JSON.parse(zw.text).error === 'bad_name',
      'B7 带零宽字符的呼号 → 400（否则"甲方"可以冒充"甲方"，而记分板上长得一模一样）', zw.text);

    // ── B8 登录失败不区分方向 ──
    const e1 = await json(srv.base + '/api/login', { name: '甲方', password: 'wrong-password' });
    const e2 = await json(srv.base + '/api/login', { name: '查无此人', password: 'wrong-password' });
    chk(e1.status === e2.status && JSON.parse(e1.text).message === JSON.parse(e2.text).message,
      'B8 "密码错"和"没这个呼号"在 HTTP 层也是同一句话、同一个状态码（不然这个接口就是账号枚举器）',
      `${e1.status} ${JSON.parse(e1.text).message} / ${e2.status} ${JSON.parse(e2.text).message}`);

    // ── B9 畸形 URL 不能打死服务 ──
    // 这一条是有来历的：`decodeURIComponent('%')` 会抛 URIError，
    // 而 createServer(handler) 不理会 handler 返回的 promise ⇒ unhandledRejection
    // ⇒ Node 15+ 默认**整个进程退出**。也就是 `curl 'http://host/%'` 一行打死对局服务。
    // 这里量的是"它还活着"，而不是"它返回了什么码" —— 后者是细节，前者是命。
    const bad1 = await raw(srv.base + '/%');
    chk(bad1.status === 400, 'B9 畸形 URL /% 得到 400 而不是把进程带走', String(bad1.status));
    const bad2 = await raw(srv.base + '/%zz');
    chk(bad2.status === 400, 'B10 另一个畸形 URL /%zz 也是 400', String(bad2.status));
    const alive = await raw(srv.base + '/api/status');
    chk(alive.status === 200, 'B11 **反证臂**：连发两个畸形 URL 之后服务还活着（它红了就说明前面两条只是在读一个已经死掉的服务）',
      String(alive.status));

    // ── B12 body 上限 ──
    const huge = 'x'.repeat(100 * 1024);
    const big = await json(srv.base + '/api/login', { name: '甲', password: huge }).catch(() => ({ status: 0 }));
    const hz1 = await health();
    chk(hz1.auth.tooLarge >= 1, 'B12 超大 body 被计到 tooLarge 上（服务端**确定**地拒了它）', `tooLarge=${hz1.auth.tooLarge}`);
    chk(big.status === 413 || big.status === 0, 'B13 客户端看到的是 413 或者一个明确的断开（不是"什么也没发生"）',
      `status=${big.status}`);
    const alive2 = await raw(srv.base + '/api/status');
    chk(alive2.status === 200, 'B14 **反证臂**：发了 100 KB 的 body 之后服务还活着', String(alive2.status));

    // ── B15 不存在的接口 ──
    const nf = await json(srv.base + '/api/nope', {});
    chk(nf.status === 404, 'B15 不存在的 /api/* 是 404，而不是被当成静态文件路径去找（那会顺手暴露目录结构）', String(nf.status));
    // ── B16 /api 下的路径不许落到静态服务 ──
    // 用**真实存在**的静态文件去试：如果 /api 这个前缀漏到静态服务那条路上，
    // 这里就会拿到 200 加真内容。拿一个不存在的路径试是量不到的 —— 两边都 404。
    const leak = await rawPath(srv.base, '/api/index.html');
    const leak2 = await rawPath(srv.base, '/api/../index.html');
    chk(leak.status === 404 && leak2.status === 404,
      'B16 /api 前缀下的请求全部由账号层处理，一个都不许漏到静态服务（拿真实存在的 index.html 去试）',
      `${leak.status} / ${leak2.status}`);

    const hz2 = await health();
    chk(hz2.auth.rejected >= 4, 'B17 例行拒绝是有计数的（例行拒绝不甩堆栈，但必须记得账）', JSON.stringify(hz2.auth.rejected));

    // ── B18 目录穿越 ──
    // 路径**原样**发出去，不经客户端归一化。要量的性质是"出不了 ROOT"，
    // 不是"读不到某个具体文件" —— 后者在 dev 模式下本来就能读，那是设计。
    const trav = [
      '/%2e%2e/%2e%2e/%2e%2e/windows/win.ini',
      '/..%2f..%2f..%2f..%2fwindows/win.ini',
      '/js/..%2f..%2f..%2fwindows/win.ini',
      '/%2e%2e%5c%2e%2e%5cwindows%5cwin.ini',
    ];
    const tr = [];
    for (const p of trav) tr.push(await rawPath(srv.base, p));
    chk(tr.every(r => r.status === 404 || r.status === 403 || r.status === 400),
      'B18 四种写法的目录穿越都出不了站点根目录', JSON.stringify(tr.map(r => r.status)));
    // 更硬的一条：不许出现 ROOT 外面的内容。只看状态码的话，
    // "穿越成功但那个文件恰好不存在" 也会绿 —— 那和拦住了长得一样。
    chk(tr.every(r => !/for 16-bit app support|\[fonts\]|root:x:0:0/i.test(r.text)),
      'B19 **反证臂**：响应体里没有出现任何站点根目录之外的内容（win.ini 的特征串、/etc/passwd 的首行）');
  }

  // ══════════ C 长连接（真正会被打的那一面） ══════════
  console.log(sec('C 长连接'));
  {
    // ── C1 没登录连不上 ──
    let denied = null;
    try { const r = await openWs(srv.ws); r.ws.close(); } catch (e) { denied = e; }
    chk(denied && denied.status === 401, 'C1 没登录连 WebSocket 直接被握手拒（401），连房间都进不去',
      `status=${denied && denied.status}`);

    const hz = await health();
    chk(hz.gate.refusedAuth >= 1, 'C2 拒绝的连接有计数（玩家侧只看到"进不去"，原因只能从这里分辨）', `refusedAuth=${hz.gate.refusedAuth}`);

    // ── C3 登录之后的身份来自会话，不是 join 里的自报 ──
    // 这是本轮最要紧的一条端到端判据。
    const rg = await json(srv.base + '/api/register', { name: 'Pyc', password: PW, code: INVITE });
    chk(rg.status === 200, 'C3 登录用的账号建好了', `${rg.status}`);
    const ck = cookieOf(rg);

    const a = await openWs(srv.ws, ck);
    // **故意在 join 里报一个假名字**。服务端必须用会话里的"Pyc"，不是这个"冒充者"。
    a.ws.send(JSON.stringify({ t: 'join', room: 'auth', name: '冒充者', team: 'A' }));
    const wa = await waitFor(a.msgs, m => m.t === 'welcome');
    chk(!!wa, 'C4 带着会话的连接进得了房间', JSON.stringify(a.msgs.map(m => m.t)));

    const b = await openWs(srv.ws, ck);
    b.ws.send(JSON.stringify({ t: 'join', room: 'auth', name: '另一个冒充者', team: 'B' }));
    const wb = await waitFor(b.msgs, m => m.t === 'welcome');
    chk(!!wb, 'C5 第二个连接也进得去（同一个账号，房间配额还没用完）');
    const seen = (wb && wb.others || []).map(o => o.name);
    chk(seen.includes('Pyc'), 'C6 **别人看到的是会话里的呼号 Pyc**', JSON.stringify(seen));
    chk(!seen.includes('冒充者') && !seen.includes('另一个冒充者'),
      'C7 **反证臂**：join 里自报的名字一次都没生效（这一条红了就意味着"客户端说自己叫谁就是谁"又回来了）',
      JSON.stringify(seen));

    // ── C8 每 IP 连接数上限 ──
    // CONNS_PER_IP=3：上面已经占了 2 条（a、b），第 3 条能开，第 4 条必须被拒。
    let c3 = null, c4 = null;
    try { c3 = await openWs(srv.ws, ck); } catch (e) { c3 = e; }
    try { c4 = await openWs(srv.ws, ck); } catch (e) { c4 = e; }
    chk(c3 && c3.status === undefined, 'C8 第 3 条连接还能开（上限本身不能把自己人挡在外面）');
    chk(c4 && c4.status === 429, 'C9 第 4 条被拒（429）—— 一个人开满连接就没人进得来，那是"他一个人能把你关门"',
      `status=${c4 && c4.status}`);
    if (c3 && c3.ws) c3.ws.close();
    await sleep(300);
    const hzq = await health();
    chk(hzq.gate.refusedConn >= 1, 'C10 连接配额被拒有计数', `refusedConn=${hzq.gate.refusedConn}`);

    // 反证臂：关掉一条之后应该又能开一条（名额是**减回去**的，不是一次性烧掉的）
    let c5 = null;
    try { c5 = await openWs(srv.ws, ck); } catch (e) { c5 = e; }
    chk(c5 && c5.status === undefined, 'C11 **反证臂**：关掉一条之后名额回来了（不然连接数是单调上涨的，越用越少）');
    if (c5 && c5.ws) c5.ws.close();

    // ── C12 消息洪水 ──
    // WS_MSG_PER_SEC=20。正常客户端 60 帧/秒，远到不了；灌 200 条必须被拆。
    const flood = await openWs(srv.ws, ck);
    flood.ws.send(JSON.stringify({ t: 'join', room: 'auth', team: 'A' }));
    await waitFor(flood.msgs, m => m.t === 'welcome');
    const closed = new Promise(res => flood.ws.on('close', (code, reason) => res({ code, reason: String(reason) })));
    for (let i = 0; i < 200; i++) { try { flood.ws.send(JSON.stringify({ t: 'ping', c: i })); } catch { break; } }
    const cl = await Promise.race([closed, sleep(3000).then(() => null)]);
    chk(cl && cl.code === 1008, 'C12 灌消息之后连接被拆（1008 = 策略原因），不是任它灌',
      cl ? `code=${cl.code} reason=${cl.reason}` : '3 秒内没被拆');
    await sleep(200);
    const hzf = await health();
    chk(hzf.gate.refusedMsg >= 1, 'C13 洪水被拆有计数', `refusedMsg=${hzf.gate.refusedMsg}`);

    a.ws.close(); b.ws.close();
    await sleep(300);

    // ── C14 建房配额 ──
    // ROOMS_PER_USER=1。上面已经用这个账号建了 'auth' 这一间，再建一间必须被拒。
    // 这条堵的是"房间 id 由客户端随便写 ⇒ 换着 id 建房就能把 MAX_ROOMS 占满"。
    const q = await openWs(srv.ws, ck);
    q.ws.send(JSON.stringify({ t: 'join', room: 'another-room', team: 'A' }));
    const err = await waitFor(q.msgs, m => m.t === 'err');
    chk(!!err && /房间/.test(err.msg), 'C14 同一个账号建第 2 间房被拒（配额），而且说的话能看懂',
      err ? err.msg : '没收到拒绝');
    const hzr = await health();
    chk(hzr.gate.refusedRoom >= 1, 'C15 建房配额被拒有计数', `refusedRoom=${hzr.gate.refusedRoom}`);
    // 反证臂：同一个账号**进已有房间**不该被拦 —— 配额管的是"建"，不是"进"。
    // 反了的话，玩家第二局就进不去自己刚建的那间房，而表现只是"进不去"。
    const q2 = await openWs(srv.ws, ck);
    q2.ws.send(JSON.stringify({ t: 'join', room: 'auth', team: 'A' }));
    const wq2 = await waitFor(q2.msgs, m => m.t === 'welcome');
    chk(!!wq2, 'C16 **反证臂**：进已有的那一间房不受配额影响（配额管的是"建"，不是"进"）');
    q.ws.close(); q2.ws.close();
    await sleep(200);
  }

  // ══════════ D 限流窗口（单独一个服，免得把上面的读数搅进来） ══════════
  console.log(sec('D 限流'));
  {
    const s2 = await withServer({ JOIN_CODE: INVITE, REG_PER_HOUR: '3' });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) {
        const r = await json(s2.base + '/api/register', { name: '刷' + i, password: PW, code: INVITE });
        codes.push(r.status);
        if (r.status === 429) {
          chk(Number(r.headers['retry-after']) > 0, 'D1 429 带 Retry-After（守规矩的客户端该自己退避，而不是原地重试把窗口撞得更满）',
            `retry-after=${r.headers['retry-after']}`);
          chk(JSON.parse(r.text).retryAfterMs > 0, 'D2 响应体里也有还要等多久');
        }
      }
      chk(codes.filter(c => c === 200).length === 3, 'D3 前 3 次注册成功', JSON.stringify(codes));
      chk(codes[3] === 429 && codes[4] === 429, 'D4 第 4、5 次被限流', JSON.stringify(codes));
      const hz = JSON.parse((await raw(s2.base + '/healthz')).text);
      chk(hz.auth.tooMany >= 2, 'D5 限流被拒有计数（"+ 429 里有几次是限流"这件事只能从这里看出来）', `tooMany=${hz.auth.tooMany}`);
      // 反证臂：被限流的是**注册**，登录不该跟着一起被罚 —— 合用一个窗口的话，
      // 一次注册风暴会把所有同 IP 的正常登录也一起挡掉。
      const lg = await json(s2.base + '/api/login', { name: '刷0', password: PW });
      chk(lg.status === 200, 'D6 **反证臂**：注册被限流时，同一 IP 的正常登录不受影响（两个窗口是分开的）', `${lg.status} ${lg.text}`);
    } finally { s2.kill(); }
  }

  // ══════════ E 对局结果批次（不落库的那一段形状） ══════════
  // 判据：endMatch **不在 tick 里写账号**，只把名单挂到队列上，由循环外面去落。
  // 这一条不跑服务，直接造一个权威房间 —— 因为要量的是"那一行有没有多做事"。
  console.log(sec('E 对局结果批次'));
  {
    const { preloadMaterials } = await import('../server/headless-game.mjs');
    const { NetRoom } = await import('../server/room.mjs');
    await preloadMaterials();
    const room = new NetRoom({ id: 'res', mapId: 'yard', seed: 4242 });
    await room.start();
    room.addClient({ name: '有账号的', team: 'A', account: 'key-a' });
    room.addClient({ name: '访客', team: 'B', account: null });
    const r0 = room.clients.get(1);
    r0.score = 1370; r0.kills = 9; r0.deaths = 2;
    chk(room.takeResults().length === 0, 'E1 还没结束的时候队列是空的（反证臂：不是"一进房就记一笔"）');
    room.endMatch('A');
    const batch = room.takeResults();
    chk(batch.length === 1 && batch[0].winner === 'A', 'E2 结束之后恰好推了一批', JSON.stringify(batch.map(b => b.winner)));
    chk(batch[0].rows.length === 1 && batch[0].rows[0].account === 'key-a',
      'E3 **访客不产生档案记录**（account 为 null 的人被筛掉了，否则会往库里塞一个不存在的 key）',
      JSON.stringify(batch[0].rows));
    chk(batch[0].rows[0].xp === 1370 && batch[0].rows[0].kills === 9 && batch[0].rows[0].win === true,
      'E4 批次里带的是权威 sim 自己算出来的数（XP 来自 score，不是客户端上报的）', JSON.stringify(batch[0].rows[0]));
    chk(room.takeResults().length === 0, 'E5 排干语义：取过一次就空了（不然同一局会被反复落库，经验值一直涨）');
    room.endMatch('B');
    chk(room.takeResults().length === 0, 'E6 matchOverSent 守卫还在：第二次 endMatch 不产生第二批');
    // ── E7 队列有上限 ──
    // 万一那个守卫哪天失效，结果数组不许变成无界内存泄漏 —— 而它泄漏得很安静。
    for (let i = 0; i < 50; i++) { room.matchOverSent = false; room.endMatch('A'); }
    chk(room.__results.length <= 8, 'E7 结果队列有上限（守卫失效时它不会长成一个安静的内存泄漏）', `len=${room.__results.length}`);
    void room;
  }

  // ══════════ G 访客可玩的服（REQUIRE_ACCOUNT=0） ══════════
  // 这个模式在项目里的位置很具体：本地调试、以及对战层的测试（net-play / net-drop）走它，
  // 于是"账号"这一整套在这条路上是**不存在**的 —— 呼号没有会话可依，只能自报。
  // 那正是它危险的地方：自报呼号曾经是唯一的呼号来源，这一轮把它封进了账号；
  // 这条分支是那个封口的**边角**，所以必须单独量，不能靠"默认那条量过了"来推断。
  //
  // 它同时是 A1b 的反证臂：那边量 requireAccount===true，这边量它 ===false ——
  // 一条写死成常数的实现过不了这两条的合取。
  console.log(sec('G 访客可玩'));
  {
    const s4 = await withServer({ JOIN_CODE: INVITE, REQUIRE_ACCOUNT: '0' });
    try {
      const st = JSON.parse((await raw(s4.base + '/api/status')).text);
      chk(st.requireAccount === false, 'G1 REQUIRE_ACCOUNT=0 时 /api/status 说"这个服不要账号"（A1b 的反证臂）', JSON.stringify(st));

      // ── G2 没有 cookie 也能连、能进房 ──
      const g = await openWs(s4.ws);
      g.ws.send(JSON.stringify({ t: 'join', room: 'guest', name: '访客甲', team: 'A' }));
      const w = await waitFor(g.msgs, m => m.t === 'welcome');
      chk(!!w, 'G2 访客可玩的服上，没有会话的连接进得了房间', JSON.stringify(g.msgs.map(m => m.t)));
      chk(!!w && w.name === '访客甲', 'G3 自报呼号成了这一局的显示名（这条路上没有会话可用，它是唯一来源）', w && w.name);

      // ── G4 但同一个白名单仍然管着它 ──
      // 这一条是"一处定义两处共用"的判据：注册被拒时说的话，和这里被拒时说的话，
      // **必须是同一句**。两边各写一份文案的症状不是崩，是慢慢分叉 ——
      // 而玩家看到的是"同一个规则、两句不一样的话"，然后会以为其中一句在说别的事。
      const rg = await json(s4.base + '/api/register', { name: '带\u200b零宽', password: PW, code: INVITE });
      const httpMsg = JSON.parse(rg.text).message;
      chk(rg.status === 400, 'G4 先取到注册那条路上"呼号不合法"的原话', `${rg.status} ${httpMsg}`);

      const g2 = await openWs(s4.ws);
      g2.ws.send(JSON.stringify({ t: 'join', room: 'guest', name: '带\u200b零宽', team: 'A' }));
      const err = await waitFor(g2.msgs, m => m.t === 'err');
      chk(!!err && err.msg === httpMsg,
        'G5 **反证臂**：访客自报的呼号也过同一条白名单，而且拒绝文案与注册那条**逐字相同**（各写一份必然分叉）',
        `ws="${err && err.msg}" http="${httpMsg}"`);
      // 这一条量的是"拒绝是可辨认的"，不是"它被悄悄换成了别的"：
      // 静默替换的症状是玩家填了名字、进去却叫"访客"，而"被改掉了"和"没生效"长得一模一样。
      const g3 = await openWs(s4.ws);
      g3.ws.send(JSON.stringify({ t: 'join', room: 'guest', name: '带\u200b零宽', team: 'A' }));
      const ew = await waitFor(g3.msgs, m => m.t === 'welcome');
      chk(!ew, 'G6 不合法的呼号**进不去**（不是被静默改成"访客"放进来 —— 那会让玩家以为名字生效了）',
        JSON.stringify(g3.msgs.map(m => m.t)));

      // ── G7 没带名字不算错 ──
      // 手写 ?online=1 的人、和没传 name 的老客户端走的是这里。那不是攻击，是没填。
      // 两者得到同一个结果（拒掉）的话，"忘填"和"填错"在玩家侧无法分辨。
      const g4 = await openWs(s4.ws);
      g4.ws.send(JSON.stringify({ t: 'join', room: 'guest', team: 'B' }));
      const w4 = await waitFor(g4.msgs, m => m.t === 'welcome');
      chk(!!w4 && w4.name === '访客', 'G7 完全没带名字时按"访客"进（"忘填"和"填错"不该是同一个结果）', w4 && w4.name);

      // ── G8 建房配额在访客模式下对谁生效 ──
      // 没有账号就**没有 key**，于是配额这一层在这里是空转的。
      // 这不是 bug，是"访客模式放弃了什么"的清单上的一项，得让它可见：写下来，别让它以后
      // 被人当成"配额明明配了却不生效"的 bug 去查。
      const g5 = await openWs(s4.ws);
      g5.ws.send(JSON.stringify({ t: 'join', room: 'guest-2', team: 'A' }));
      const w5 = await waitFor(g5.msgs, m => m.t === 'welcome');
      chk(!!w5, 'G8 访客可以随意开新房（配额按账号算、这里没有账号）—— 这是访客模式已知被放弃的一项', JSON.stringify(g5.msgs.map(m => m.t)));

      g.ws.close(); g2.ws.close(); g3.ws.close(); g4.ws.close(); g5.ws.close();
      await sleep(200);
    } finally { s4.kill(); }
  }

  // ══════════ F 生产模式：源码不下发 ══════════
  // 静态白名单只在 prod 生效（dev 下刻意放开，方便拿 net-trace.html 和 sim-twin.mjs）。
  // 这条要单独起一个 prod 服 —— 它量的是一个**只在部署配置下才成立**的性质，
  // 在 dev 服上量它永远是绿的，而那条绿是假的。
  console.log(sec('F 生产模式'));
  {
    // ACCOUNTS_DB 显式给空串：这一段只量静态白名单，账号库与它无关，而**不设**的话
    // 生产模式的配置闸会拒绝启动（那正是 H 段要量的东西，不该在这里撞上）。
    const s3 = await withServer({ JOIN_CODE: INVITE, NODE_ENV: 'production', ACCOUNTS_DB: '' });
    try {
      const pkg = await rawPath(s3.base, '/package.json');
      chk(pkg.status === 404, 'F1 生产模式下 package.json 拿不到（依赖清单也是一份情报）', String(pkg.status));
      const src = await rawPath(s3.base, '/server/room.mjs');
      chk(src.status === 404, 'F2 生产模式下 server/ 下的权威端源码拿不到（里面有协议格式和全部规则）', String(src.status));
      const git = await rawPath(s3.base, '/.git/config');
      chk(git.status === 404, 'F3 .git 拿不到（拿到它等于拿到整份提交历史）', String(git.status));
      const tst = await rawPath(s3.base, '/test/hardening.mjs');
      chk(tst.status === 404, 'F4 test/ 拿不到（判据里写着整套攻击面清单）', String(tst.status));
      // 反证臂：白名单不能把正门一起关掉。这一条红了就说明所谓"安全"其实是"整个站都挂了"。
      const main = await rawPath(s3.base, '/js/main.js');
      const root = await rawPath(s3.base, '/');
      chk(main.status === 200 && root.status === 200, 'F5 **反证臂**：js/ 与首页照常能拿（白名单没把正门也关掉）',
        `js=${main.status} /=${root.status}`);
      const hz = JSON.parse((await rawPath(s3.base, '/healthz')).text);
      chk(hz.ok === true && hz.gate && hz.gate.requireAccount === true,
        'F6 /healthz 在生产模式下也把闸门配置都说出来（运维要能一眼看见自己在跑什么配置）', JSON.stringify(hz.gate));
    } finally { s3.kill(); }
  }

  // ══════════ H 生产模式的"配置闸"：忘了设不许长得和设好了一样 ══════════
  //
  // 这一段的起因是一个**只有部署时才发作**的静默失效：`JOIN_CODE` 不设时取源码里的默认值
  // （`mf2026`，在仓库里谁都能读到），而启动日志只判断真值 ⇒ 打印"邀请码 已设"。
  // 于是忘了设环境变量的操作员看到的是"已配好"，而门是公开的。
  // 同类还有 `ACCOUNTS_DB`：留空 = 内存库，而默认要求登录 ⇒ 重启一次所有人的账号一起消失。
  //
  // 判据的形状：**每一条"拒绝启动"都要配一条"该放行的必须放行"**（反证臂）。
  // 只写前一半的话，把 prod 写成无条件 `process.exit(1)` 也能全绿 —— 那是把服务整个焊死。
  // 这四条对照正好把"未设"与"显式设"分开：
  //   未设 JOIN_CODE → 退；设了 → 起；显式设空（我就要开放注册）→ 起，且门槛计数是 0。
  console.log(sec('H 生产模式的配置闸'));
  {
    // H1：生产 + 未设 JOIN_CODE ⇒ 拒绝启动，而且是**它自己退**（不是挂在那儿）
    const a = await bootRaw({ NODE_ENV: 'production', JOIN_CODE: undefined, ACCOUNTS_DB: '' });
    chk(a.code === 1 && /必须显式设置 JOIN_CODE/.test(a.log),
      'H1 生产模式下没设 JOIN_CODE ⇒ 拒绝启动（退出码 1，并说清两条出路）',
      `code=${a.code} up=${a.up}`);
    // H2：**反证臂** —— 设了就起得来（不能因为"未设"的守卫把设了的也拒掉）
    {
      const s = await withServer({ NODE_ENV: 'production', JOIN_CODE: INVITE, ACCOUNTS_DB: '' });
      try {
        const hz = JSON.parse((await raw(s.base + '/healthz')).text);
        chk(hz.ok === true && hz.auth.inviteRequired === true,
          'H2 **反证臂**：生产模式下设了 JOIN_CODE 就照常起（守卫不能把设好的也拒掉）',
          `inviteRequired=${hz.auth.inviteRequired}`);
      } finally { s.kill(); }
    }
    // H3：**反证臂** —— 显式设空 = "我就是要开放注册"，那是被允许的一条出路
    {
      const s = await withServer({ NODE_ENV: 'production', JOIN_CODE: '', ACCOUNTS_DB: '' });
      try {
        const hz = JSON.parse((await raw(s.base + '/healthz')).text);
        chk(hz.ok === true && hz.auth.inviteRequired === false,
          'H3 **反证臂**：显式 JOIN_CODE=（空）在生产模式下起得来，且真的成了开放注册',
          `inviteRequired=${hz.auth.inviteRequired}`);
      } finally { s.kill(); }
    }
    // H4：生产 + 要账号 + 未设 ACCOUNTS_DB ⇒ 拒绝启动（"重启就丢"写在日志里，而重启之前没人看）
    const b = await bootRaw({ NODE_ENV: 'production', JOIN_CODE: INVITE, ACCOUNTS_DB: undefined });
    chk(b.code === 1 && /没有设 ACCOUNTS_DB/.test(b.log),
      'H4 生产模式下要账号却没设 ACCOUNTS_DB ⇒ 拒绝启动（"重启就丢"不该以警告的形式出现）',
      `code=${b.code} up=${b.up}`);
    // H5：**反证臂** —— 明确说"这是个不存档案的访客服"就放行（访客可玩的服本来就不需要档案）。
    // 这一条与 H4 是同一格的两个方向：ACCOUNTS_DB 都**没设**，差别只在 REQUIRE_ACCOUNT。
    const c = await bootRaw({ NODE_ENV: 'production', JOIN_CODE: INVITE, ACCOUNTS_DB: undefined, REQUIRE_ACCOUNT: '0' });
    try {
      const hz = c.up ? JSON.parse((await raw(c.base + '/healthz')).text) : {};
      chk(c.up && hz.auth && hz.auth.store === 'MemoryStore' && hz.gate.requireAccount === false,
        'H5 **反证臂**：显式 REQUIRE_ACCOUNT=0 时，没设账号库也起得来（访客可玩的服不需要档案）',
        `up=${c.up} ${hz.auth && hz.auth.store} requireAccount=${hz.gate && hz.gate.requireAccount}`);
    } finally { c.kill(); }
    // H6：开发模式不该被部署配置拦住 —— 但**日志必须自己说出来**用的是源码里的默认值。
    // 这一条是整段的"被测对象"：以前它打印的是"已设"，和真的设好了的一模一样。
    const d = await bootRaw({ JOIN_CODE: undefined });
    try {
      chk(d.up && /源码里的默认值/.test(d.log),
        'H6 开发模式下没设 JOIN_CODE 也照常起，但日志必须写出"在用源码里的默认值"（以前这一格骗人）',
        (d.log.split('\n').find(l => /邀请码/.test(l)) || '').trim().slice(0, 130));
    } finally { d.kill(); }
  }

  // ══════════ I 联机大厅的房间列表与注册闸 ══════════
  // 两条需求：① 联网对战改成"房间列表"；② 未完成注册前联网对战不开放。
  // ② 的判据必须落在**服务端**：客户端把列表藏起来只是显示（改得动），这里量的是
  // "没会话连房间清单都拿不到"（与 WS 握手那道 401 是同一条规则的两半）。
  // ① 的判据是"建的房真的出现在清单里，字段是玩法字段，且显示名不是房号"。
  // 这一段**自己起一个服**：主服那台被前面几段用过，CONNS_PER_IP / ROOMS_PER_USER
  // 的配额是 C/D 段的判据材料 —— 在它上面接着跑会撞配额，那种红和本段要量的东西无关。
  console.log(sec('I 房间列表与注册闸'));
  {
    const s5 = await withServer({ JOIN_CODE: INVITE });
    try {
      const anon = await raw(s5.base + '/api/rooms');
      let aj = null; try { aj = JSON.parse(anon.text); } catch { /* 不是 JSON 就是别的错法 */ }
      chk(anon.status === 401 && aj && !('rooms' in aj),
        'I1 没注册（没有会话）连房间清单都拿不到：401，且响应里没有 rooms 字段',
        `${anon.status} ${anon.text.slice(0, 80)}`);

      const rg = await json(s5.base + '/api/register', { name: '房管甲', password: PW, code: INVITE });
      const ck = cookieOf(rg);
      const w1 = await raw(s5.base + '/api/rooms', { headers: { cookie: ck } });
      const wj = JSON.parse(w1.text);
      chk(w1.status === 200 && wj.ok === true && Array.isArray(wj.rooms),
        'I2 注册之后拿得到房间清单（主菜单那把锁的另一半）', `${w1.status} rooms=${(wj.rooms || []).length}`);

      // 建一间带显示名的房：title 是显示名，房号仍是 join 里的那个 id
      const a = await openWs(s5.ws, ck);
      a.ws.send(JSON.stringify({ t: 'join', room: 'hall-1', title: '午夜小队', team: 'A' }));
      const wa = await waitFor(a.msgs, m => m.t === 'welcome');
      chk(!!wa, 'I3 先决：带 title 的 join 进得去', JSON.stringify(a.msgs.map(m => m.t)));
      await sleep(150);
      const list = JSON.parse((await raw(s5.base + '/api/rooms', { headers: { cookie: ck } })).text);
      const row = (list.rooms || []).find(x => x.id === 'hall-1');
      chk(!!row && row.title === '午夜小队' && row.players >= 1 && row.map === 'yard' && row.mode === 'tdm' && row.state === 'playing',
        'I4 建的房出现在清单里：title 是显示名、人数是活的、地图/模式/状态来自服务端',
        JSON.stringify(row || null));
      // 反证臂：title 与 id 是两格。谁把"显示名"当成房号写回去，这条就红 ——
      // 而那个错法在客户端的症状是"中文房名被 pickRoom 清成 auto，人进了别人的房间"。
      chk(!!row && row.id === 'hall-1' && row.title !== row.id,
        'I5 **反证臂**：显示名与房号是两格（改 title 不许改掉 join 用的 id）',
        JSON.stringify({ id: row && row.id, title: row && row.title }));

      // 显示名的清洗：控制字符拍平、超长截断。不洗的话一行"房名"里带个换行就能伪造清单行。
      const b = await openWs(s5.ws, ck);
      b.ws.send(JSON.stringify({ t: 'join', room: 'hall-2', title: '带\n换行的房名带\n换行的房名带\n换行的房名', team: 'B' }));
      await waitFor(b.msgs, m => m.t === 'welcome');
      await sleep(150);
      const list2 = JSON.parse((await raw(s5.base + '/api/rooms', { headers: { cookie: ck } })).text);
      const row2 = (list2.rooms || []).find(x => x.id === 'hall-2');
      chk(!!row2 && !/[\u0000-\u001f]/.test(row2.title) && row2.title.length <= 24,
        'I6 房名里的控制字符被拍平、长度截到 24（换行能伪造清单行）', JSON.stringify(row2 && row2.title));

      // 反证臂：这道闸跟着 REQUIRE_ACCOUNT 走，不是写死的 401。
      // 访客可玩的服（服主显式配的）上没会话照样拿得到清单 —— 反过来这条红了，
      // 说明闸被写成无条件拒绝，那会把访客服整个焊死（net-drop 的 A~E 段就跑在访客服上）。
      const s6 = await withServer({ JOIN_CODE: INVITE, REQUIRE_ACCOUNT: '0' });
      try {
        const guest = await raw(s6.base + '/api/rooms');
        const gj = JSON.parse(guest.text);
        chk(guest.status === 200 && gj.ok === true && Array.isArray(gj.rooms),
          'I7 **反证臂**：REQUIRE_ACCOUNT=0 的访客服上，没会话也拿得到房间清单（闸跟策略走）',
          `${guest.status} ${guest.text.slice(0, 60)}`);
      } finally { s6.kill(); }
    } finally { s5.kill(); }
  }

} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  fails++;
} finally {
  srv.kill();
}

console.log('');
if (fails) { console.log(`RED  ${checks - fails}/${checks} 通过，${fails} 条失败`); process.exit(1); }
console.log(`GREEN  外围防护：${checks}/${checks} 通过`);
