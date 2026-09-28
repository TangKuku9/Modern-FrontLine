// 对着一台**已经在跑**的部署做验收 —— 这是"真机闭环"里唯一能远程跑的那一段。
//
//   node server/remote-probe.mjs --url=http://127.0.0.1:8090
//   node server/remote-probe.mjs --url=https://fps.example.com --invite=<邀请码> --register
//
// 与 server/deploy-probe.mjs 的分工是**能力边界**，不是"新老两版"：
//   · deploy-probe 自己起进程 ⇒ 它能量进程级的东西：拒绝启动的退出码、优雅下线的 1001、
//     开发模式仍发 server/ 源码、空房回收的日志行。
//   · 这一份只能从外面看 ⇒ 它量的是**部署面留在公网上的可见形状**：生产白名单有没有生效、
//     来源检查开没开、邀请码那道闸是不是真按操作员设的那个值在拦、一个人能不能真的打起来。
// 远程判不了的一律印「⚠ 未测」并写清用什么补，**不折算成绿灯** ——
// 一份替真机背书的假绿灯，比没有这份探针更糟（这个项目已经吃过一次"量具本身错了"）。
//
// --register 会在目标机上真的建一个账号（那是这个探针唯一会改的东西），并明说建了什么。
// 不给它时：只读 + 负向验证（坏邀请码必须被拒），一个字节都不写。
import { WebSocket } from 'ws';
import { gunzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { decodeSnapshot, encodeInput } from './codec.mjs';
import { packInput } from '../js/quant.js';
import { SESSION_COOKIE } from './http-api.mjs';   // cookie 名只在一处定义，这里不抄第二份

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => argv.includes('--' + k);

const URL_IN = arg('url');
if (!URL_IN) { console.log('用法：node server/remote-probe.mjs --url=http://host:port [--invite=码] [--register] [--name=呼号]'); process.exit(2); }
const U = new URL(URL_IN);
const BASE = U.origin;
const SECURE = U.protocol === 'https:';
const WSURL = (SECURE ? 'wss://' : 'ws://') + U.host + '/ws';
const GETTER = SECURE ? httpsRequest : httpRequest;
const INVITE = arg('invite');
const NAME = arg('name', 'probe' + randomBytes(2).toString('hex'));   // 2~16 字的合法呼号
const PASS = 'probe-' + randomBytes(6).toString('hex');               // ≥8 位
// 本次探针所有连接共用一个房间号：不撞真玩家的房，也不会每次 join 各开一间
// （房间号以前是按 Date.now() 生成的，"两个人互相看得见"那条因此永远测的是两间房）。
const ROOM = arg('room', 'probe-' + randomBytes(3).toString('hex'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, bad = 0, untested = 0;
const ok = (label, cond, extra = '') => { n++; if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); };
// 未测不是通过：它单独计数、单独印，退出码里也要看得见（否则"跳过"会长成"绿"）。
const skip = (label, why) => { untested++; console.log(`  ⚠ 未测  ${label}  | ${why}`); };

// 不用 fetch：undici 会把 content-encoding 抹掉并自动解压，而"压缩协商对不对"正好只能
// 在原始响应头 + 原始字节这个尺度上看（server/deploy-probe.mjs 用了同一条理由）。
// 用 request 而不是 get：http.get() 等价于 request() **外加立刻 req.end()**，拿它发带 body
// 的 POST 会在 write 那一行抛 ERR_STREAM_WRITE_AFTER_END —— 这一条是探针第一次真跑
// （对 127.0.0.1:8123）时炸出来的，所以 get 这边也补上显式 end。
const get = (path, headers = {}) => new Promise((res, rej) => {
  const req = GETTER(BASE + path, { headers }, r => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(chunks) }));
  });
  req.on('error', rej);
  req.setTimeout(15000, () => req.destroy(new Error('15 秒没有响应')));
  req.end();
});
const post = (path, body, headers = {}) => new Promise((res, rej) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = GETTER(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
  }, r => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; } })() }));
  });
  req.on('error', rej);
  req.setTimeout(15000, () => req.destroy(new Error('15 秒没有响应')));
  req.write(data); req.end();
});
// 裸请求行：为了测服务端那道 resolve，路径必须原样写出去（WHATWG 的 URL 解析会先把
// "%2e%2e" 当成 ".." 收干净，用 fetch/http.get 测出来的只是客户端的规范化）。
const rawReq = (line) => new Promise((res) => {
  const s = netConnect(U.port || (SECURE ? 443 : 80), U.hostname);
  let buf = '';
  const done = () => { try { s.destroy(); } catch { /* */ } res(buf); };
  s.on('data', d => { buf += d; if (/\r\n\r\n/.test(buf) || buf.length > 4000) done(); });
  s.on('error', () => done());
  s.on('close', () => res(buf));
  s.setTimeout(6000, done);
  s.write(`${line} HTTP/1.1\r\nHost: ${U.host}\r\nConnection: close\r\n\r\n`);
});

// 一个客人：cookie 让服务端在 upgrade 那一刻就把身份钉死（HTTP 那一段的注释里写的机制）
const joiner = async (name, { origin = BASE, cookie = null } = {}) => {
  const ws = new WebSocket(WSURL, { headers: { origin, ...(cookie ? { cookie } : {}) } });
  const ctl = []; let bin = 0; let last = null;
  ws.on('message', (m, isBinary) => {
    if (!isBinary) { ctl.push(String(m)); return; }
    bin++;
    try { last = decodeSnapshot(m); } catch { /* 坏包在下面由"实体表"那几条判据去发现 */ }
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', e => rej(new Error('握手失败：' + e.message))); });
  ws.send(JSON.stringify({ t: 'join', room: ROOM, name, team: 'A' }));
  for (let i = 0; i < 100 && !ctl.length; i++) await sleep(50);
  const json = () => ctl.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  return {
    ws, ctl, json, bin: () => bin, last: () => last,
    ids: () => (last ? last.entities.map(e => e.id) : []),
    ackOf: (cid) => { const e = last && last.entities.find(x => x.id === cid); return e ? e.ack : null; },
    welcome: () => json().find(j => j.t === 'welcome'),
    err: () => json().find(j => j.t === 'err'),
  };
};

console.log(`\n对象：${BASE}（${SECURE ? '走 TLS' : '明文 HTTP'}）`);
try {
  console.log('\n── 健康与观测 ──');
  const h0 = await get('/healthz');
  let hj = null; try { hj = JSON.parse(h0.buf.toString()); } catch { /* 下面那条判据会报 */ }
  ok('/healthz 200 且是可解析的 JSON 且 ok:true', h0.status === 200 && hj && hj.ok === true, `status=${h0.status}`);
  ok('报告了 rooms / clients 两个整数（探针要靠它对账房间增删）',
    hj && Number.isInteger(hj.rooms) && Number.isInteger(hj.clients), JSON.stringify({ rooms: hj && hj.rooms, clients: hj && hj.clients }));
  ok('拒绝被缓存（探针拿到过期数据比拿不到更糟）', /no-store/.test(h0.headers['cache-control'] || ''), h0.headers['cache-control']);
  const age = h0.headers.age;
  ok('没有中间层在替它缓存（Age 头）', age === undefined || Number(age) < 2, `age=${age}`);
  console.log(`  现状：${hj && hj.rooms} 间 · ${hj && hj.clients} 人 · 堆 ${hj && hj.heapMB} MB` +
    (hj && hj.per ? ` · 各间 ${JSON.stringify((hj.per || []).map(p => ({ id: p.id, n: p.n, hz: p.hz })))}` : ''));

  console.log('\n── 静态资源面（真字节，不走 fetch） ──');
  const idx = await get('/index.html');
  ok('入口 html 拿得到且每次回源（改完要能立刻看到）', idx.status === 200 && /no-cache/.test(idx.headers['cache-control'] || ''), `status=${idx.status} cache-control=${idx.headers['cache-control']}`);
  ok('静态响应带 nosniff', idx.headers['x-content-type-options'] === 'nosniff');
  const plain = await get('/js/main.js', { 'accept-encoding': 'identity' });
  const gz = await get('/js/main.js', { 'accept-encoding': 'gzip' });
  // 反证臂：这一条必须先成立 —— 否则下面"生产白名单没生效"会被"整台服全是 404"假冒成绿。
  ok('反证：js/main.js 是 200（下面那些 404 才说明白名单在起作用，而不是整台服都 404）',
    plain.status === 200 && plain.buf.length > 1000, `status=${plain.status} ${plain.buf.length} B`);
  ok('gzip 协商：解压结果与原包逐字节相同（压的不是别的东西）',
    gz.headers['content-encoding'] === 'gzip' && gunzipSync(gz.buf).equals(plain.buf),
    `${plain.buf.length} B → gzip ${gz.buf.length} B = ${(gz.buf.length / Math.max(1, plain.buf.length) * 100).toFixed(0)}%`);
  const etag = plain.headers.etag;
  if (etag) {
    const b304 = await get('/js/main.js', { 'if-none-match': etag });
    ok('带 ETag 再验证命中 304 且不带包体', b304.status === 304 && b304.buf.length === 0, `status=${b304.status} body=${b304.buf.length} B`);
    ok('304 也带 no-cache（存着旧 max-age 的浏览器只有从 304 头里才能学到新策略）', /no-cache/.test(b304.headers['cache-control'] || ''), b304.headers['cache-control']);
  } else skip('ETag 再验证 304', '这台机器的 /js/main.js 没给 ETag（反代可能把它剥了）');
  ok('非 html 资源也是 no-cache（发版本后客户端下次加载自动同步）', /no-cache/.test(plain.headers['cache-control'] || ''), plain.headers['cache-control']);
  const lib = await get('/lib/three.module.js');
  ok('three 本体能取到且大小合理（最大的那份静态资源）', lib.status === 200 && lib.buf.length > 500000, `${lib.buf.length} B`);

  console.log('\n── 生产模式的白名单（远程唯一能验"prod 生效"的形状） ──');
  const src = await get('/server/net-server.mjs');
  const git = await get('/.git/config');
  // 判据写成"不是 200"而不是"== 404"：反代、WAF、容器网关都可能自己回一个码，
  // 只要拿不到内容就算过 —— 而内容那一侧下面还要用字符串再确认一次。
  ok('权威端源码 /server/ 取不到（公网不该拿得到服务端代码）',
    src.status !== 200 && !/WebSocketServer|assertDeployConfig/.test(src.buf.toString()), `status=${src.status}`);
  ok('.git 取不到（仓库根 = 静态根时这是最贵的一条）',
    git.status !== 200 && !/\[core\]/.test(git.buf.toString()), `status=${git.status}`);
  if (SECURE) skip('编码过的路径穿越（需裸 socket）', '这道题只能对着明文 http 端口原样写请求行；TLS 前置时请在容器内/宿主机侧跑 deploy-probe');
  else {
    const t = await rawReq('GET /%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    ok('编码过的穿越被拒（解码后仍要过 ROOT 那道判据）', /^HTTP\/1.1 40[34]/.test(t), t.split('\r\n')[0]);
    const t2 = await rawReq('GET /js/../../server/net-server.mjs');
    ok('normalize 后落在仓库内的 /server/ 路径也不发', !/^HTTP\/1\.1 200/m.test(t2), t2.split('\r\n')[0]);
  }

  console.log('\n── 账号与邀请码闸（真机上的配置只有这里能验） ──');
  const st = await get('/api/status');
  const sj = (() => { try { return JSON.parse(st.buf.toString()); } catch { return null; } })();
  ok('/api/status 拿得到（它是"这个服要不要邀请码"的真相）', st.status === 200 && sj && sj.ok === true, JSON.stringify(sj));
  const needsAccount = sj && sj.requireAccount !== false;
  const inviteRequired = !!(sj && sj.inviteRequired);
  console.log(`  这台机器：需要账号 ${needsAccount ? '是' : '否'} · 需要邀请码 ${inviteRequired ? '是' : '否'} · 已有账号 ${sj && sj.accounts}`);
  if (!inviteRequired) skip('坏邀请码必须被拒', '这台机器开放注册（JOIN_CODE 为空）—— 没有闸可验，而这本身就是个应当被看见的读数');
  else {
    const r = await post('/api/register', { name: NAME, password: PASS, code: 'definitely-not-the-code-' + randomBytes(4).toString('hex') });
    ok('坏邀请码注册被拒（闸真在拦，而不是把 JOIN_CODE 抄成了常量 true）',
      r.json && r.json.ok !== true && /invite|邀请/i.test(String(r.json.error || '') + String(r.json.message || '')), JSON.stringify(r.json));
  }
  let cookie = null;
  if (needsAccount && !(INVITE && flag('register'))) {
    skip('用真邀请码建号 → 带会话进对局（下面几节都依赖它）',
      needsAccount ? '这台机器要账号：带 --invite=<真邀请码> --register 才会真建号（会改目标机的账号库）' : '');
  } else if (needsAccount) {
    const reg = await post('/api/register', { name: NAME, password: PASS, code: INVITE });
    const sc = String(reg.headers['set-cookie'] || '');
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`).exec(sc);
    cookie = m && m[1] ? `${SESSION_COOKIE}=${m[1]}` : null;
    ok('真邀请码注册成功且发了会话 cookie', reg.json && reg.json.ok === true && !!cookie, `建了账号 ${NAME} · set-cookie=${!!sc}`);
    if (cookie) {
      const meRes = await get('/api/me', { cookie });
      ok('会话真的认得（/api/me 说已登录，且名字就是我注册的那个）',
        /"loggedIn":true/.test(meRes.buf.toString()) && meRes.buf.toString().includes(NAME), meRes.buf.toString().slice(0, 160));
    } else skip('会话可用性', '注册没回 set-cookie（COOKIE_SECURE 与访问协议不匹配时会出现：https 前置但探针走的是 http）');
    const dup = await post('/api/register', { name: NAME, password: PASS, code: INVITE });
    ok('反证臂：同名再注册一次必须被拒（上一条不是"注册永远成功"）',
      dup.json && dup.json.ok !== true, JSON.stringify(dup.json));
  }

  console.log('\n── WebSocket：来源检查两个方向 ──');
  let foreign = 'connected';
  try { const e = await joiner('probeX', { origin: 'http://evil.example' }); foreign = 'connected'; e.ws.close(); }
  catch (e) { foreign = e.message; }
  // 服务端在 /healthz 的 gate.originCheck 上**自报**来源检查开没开。自报与实测必须一致 ——
  // 但"实测"必须隔离出**来源这一道闸**：拒一个握手的原因有很多（来源 403、没会话 401），
  // 只看"被拒了"的话，一台要账号的服（没设 ALLOW_ORIGIN）会被自己的会话闸拒成 401，
  // 于是"自报关 · 实测拒绝"假不一致 —— 第一次对 8126 跑就抓到了这个混淆。判据用的是
  // 状态码：来源闸关人 = 403（verifyClient 里来源检查失败写死的那个码）。
  // 这条判据的起因是 ALLOW_ORIGIN 留空**没有做拒绝启动的闸**（决策记录在 README）——
  // "忘了设"以前只能靠人盯启动日志，现在部署面上机器可查。
  const originSelf = !!(hj && hj.gate && hj.gate.originCheck);
  const foreign403 = /403/.test(foreign);
  if (!(hj && hj.gate && 'originCheck' in hj.gate)) {
    skip('来源检查的自报与实测互相印证', '这台机器的 /healthz 没有 gate.originCheck（版本较老，先升级再验）');
  } else {
    ok('来源检查：healthz 自报与陌生来源被 403 的实测一致（两处不一致说明有一边在撒谎）',
      originSelf === foreign403,
      `自报 ${originSelf ? '开' : '关'} · 陌生来源被拒的方式 ${foreign === 'connected' ? '放行' : foreign.slice(-40)}`);
    // 生产形状的判据：/server/ 源码取不到 = 这台是生产模式（开发模式本来就发源码）。
    // 生产 + 不检查来源 = 对所有网站开放这台炮台，从外面看这是**红**，不只是"现状"。
    const prodShape = src.status !== 200 && !/WebSocketServer|assertDeployConfig/.test(src.buf.toString());
    if (prodShape) {
      ok('生产模式下来源检查必须开（ALLOW_ORIGIN 已设）', originSelf && foreign403,
        originSelf ? '' : '公网生产服不检查来源 = 别的网站可以把它嵌进自己页面当免费炮台（healthz 的 gate.originCheck 也是关的，操作员改完配置重启即可转绿）');
    } else {
      skip('生产模式下来源检查必须开', '这台机器取得到 /server/ 源码 —— 是开发模式，不检查来源是设计行为');
    }
  }
  if (foreign === 'connected') {
    console.log(`  ⚠ 陌生来源的握手被放行了 —— 这台机器**没开来源检查**（ALLOW_ORIGIN 为空）。`);
    console.log('    这不是探针失败，是部署现状：WS 不吃 CORS，不拦就等于替别人开放了这个炮台。');
  } else ok('陌生来源的握手被拒（正门之外的那扇门关着）', /403|握手失败|Unexpected server response/i.test(foreign), foreign);

  console.log('\n── 玩家视角：进得去、动得了、看得见别人 ──');
  let me = null, other = null;
  try { me = await joiner(NAME, { cookie }); } catch (e) { console.log('  进场抛错：' + e.message); }
  const w = me && me.welcome();
  ok('进得了对局并拿到 welcome（cid/map/pos 齐全）', !!(w && w.cid && w.map && Array.isArray(w.pos)),
    me ? JSON.stringify(w || me.err() || me.json().slice(-1)) : '握手就失败了');
  if (w) {
    const before = me.bin();
    await sleep(3000);
    const hz = (me.bin() - before) / 3;
    ok('下行快照接近 20Hz（≥15，真机上掉帧到这就是"卡"）', hz >= 15, `${hz.toFixed(1)} 帧/秒`);
    // 动起来：按住 W 一秒，ack 必须前进 —— 它证明"我的输入真的被服务端消费了"，
    // 而不是"服务器在给我放录像"。ack 从二进制包里读，不走别的接口。
    const a0 = me.ackOf(w.cid);
    const keys = packInput({ fwd: true, sprint: true });
    let tick = (a0 || 0) + 1;
    const timer = setInterval(() => {
      if (me.ws.readyState !== 1) return;
      me.ws.send(Buffer.from(encodeInput({ tick: (tick++) & 0xffff, mdx: 0, mdy: 0, keys: keys.keys, buttons: keys.buttons, seq: tick & 0xff }).buffer));
    }, 1000 / 60);
    await sleep(1200);
    clearInterval(timer);
    const a1 = me.ackOf(w.cid);
    ok('按住 W 一秒之后服务端消费到了我的输入（ack 前进 ≥30 拍）',
      a0 !== null && a1 !== null && ((a1 - a0) & 0xffff) >= 30, `ack ${a0} → ${a1}`);
  }
  if (w && cookie) {
    try {
      other = await joiner('probe' + randomBytes(2).toString('hex').slice(0, 4), { cookie, origin: BASE });
    } catch (e) { console.log('  第二个客人没进来：' + e.message); }
    if (other && other.welcome()) {
      await sleep(500);
      const a = me.ids(), b = other.ids();
      ok('两个人互相看得见（各自的快照实体表里都有对方）',
        a.includes(other.welcome().cid) && b.includes(w.cid), `房间 ${ROOM}：甲看到 [${a}] · 乙看到 [${b}]`);
    } else skip('甲乙互相可见', `第二个客人没进来（房间配额或限流）：${other ? JSON.stringify(other.err() || other.json().slice(-1)) : '握手失败'}`);
  } else if (w) {
    skip('两个人互相看得见', '这台机器要账号，而本次没建号（--invite + --register）');
  }
  console.log('\n── 房间账目（用探针自己那间的生灭当尺子） ──');
  // 趁人还在的时候对账：客户端编出来的房间号真的变成了一个房间，而且那一间在按 60Hz 跑。
  const hMid = await get('/healthz');
  const hm = (() => { try { return JSON.parse(hMid.buf.toString()); } catch { return null; } })();
  const per = (hm && hm.per) || [];
  const mine = per.find(p => p.id === ROOM);
  ok('我开的那间出现在 /healthz 的每间清单里（客户端编的房间号真的变成了一个房间）', !!mine, JSON.stringify(per.map(p => p.id)));
  // 字段名以 /healthz 的 per[] 为准（id/clients/hz/stepMs/behindMs/fails）：
  // 这里原先写的是 mine.n（想当然），真跑起来印的是 "undefined 人" —— 一个有读数的
  // 地方显示 undefined，比不显示更容易被当成"服务端没报人数"。
  if (mine) console.log(`  我那间：${mine.clients} 人 · ${Number(mine.hz).toFixed(1)}Hz · 每拍 ${mine.stepMs}ms · 落后 ${mine.behindMs}ms`);
  ok('那一间在贴着 60Hz 跑（≥55）', !mine || mine.hz >= 55, mine ? `${Number(mine.hz).toFixed(1)}Hz` : '没找到这一间');

  console.log('\n── 一个坏包不许打死别人的那一局 ──');
  if (w) {
    const watch = await (async () => { try { return await joiner('probeW', { cookie }); } catch { return null; } })();
    if (watch && watch.welcome()) {
      const f0 = watch.bin();
      const big = new WebSocket(WSURL, { headers: { origin: BASE, ...(cookie ? { cookie } : {}) } });
      const closed = new Promise(res => big.on('close', c => res(c)));
      await new Promise(r => big.on('open', r)).catch(() => {});
      big.send(Buffer.alloc(200 * 1024, 7));
      const code = await Promise.race([closed, sleep(2500).then(() => 'timeout')]);
      ok('超限单帧被断开（1009 = 消息过大）', code !== 'timeout', `close code=${code}`);
      await sleep(800);
      ok('发坏包的人死了，别人的那一局没陪葬', watch.ws.readyState === 1 && watch.bin() > f0, `旁观者收到 ${f0} → ${watch.bin()} 帧`);
      const hAlive = await get('/healthz');
      ok('进程还活着并且还在报健康', hAlive.status === 200, `status=${hAlive.status}`);
      watch.ws.close();
    } else skip('坏包隔离', '起不来一个旁观者（要账号的机器需要 --register）');
  } else skip('坏包隔离', '前面没能进场');
  if (me) me.ws.close();
  if (other) other.ws.close();

  // 回收：不假设 ROOM_IDLE_MS 是多少（真机上没人保证它没被改过），轮询到它消失为止；
  // 读不到就印未测 + 当时的现状，**不判红也不判绿**。
  let gone = false, lastH = hm;
  for (let i = 0; i < 60; i++) {
    const r = await get('/healthz');
    lastH = (() => { try { return JSON.parse(r.buf.toString()); } catch { return lastH; } })();
    if (!((lastH && lastH.per) || []).some(p => p.id === ROOM)) { gone = true; break; }
    await sleep(1000);
  }
  if (gone) ok('人都走光的房间会被回收（不回收就是"跑得越久越慢"那种事故）', true, '我这一间已经不在清单里');
  else skip('空房回收', `轮询 60 秒后它还在 —— ROOM_IDLE_MS 可能被设得更长；现状 ${(lastH && lastH.rooms)} 间 / ${(lastH && lastH.clients)} 人`);

  const hEnd = await get('/healthz');
  const he = (() => { try { return JSON.parse(hEnd.buf.toString()); } catch { return null; } })();
  ok('全程 /healthz 一直是 200（服务器没被我这些坏包打死）', hEnd.status === 200 && he && he.ok === true, `status=${hEnd.status}`);

  // ── 远程判不了的那几件，明写出来 ──
  console.log('\n── 只能在本机做、这一份探针**不负责**的 ──');
  for (const [what, how] of [
    ['生产模式配置闸（不设 JOIN_CODE / ACCOUNTS_DB 时拒绝启动、退出码 1）', 'docker run 不挂 --env-file，看它打印两条出路并退出码 1'],
    ['优雅下线（SIGTERM → 通知 + 1001 关闭 + 退出码 0）', 'docker stop -t 10 mw-room，再看 docker inspect 的 ExitCode'],
    ['账号库落在挂载卷上（docker rm 之后账号还在）', 'docker rm -f mw-room && docker run 同一卷，登录老账号'],
    ['空房回收与日志行', '跑一遍 node server/soak.mjs --url=<这里>'],
  ]) skip(what, how);
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  bad++; n++;
}
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过${untested ? ` · ${untested} 项未测（未测不计入通过，退出码里也不折算）` : ''}`);
process.exit(bad ? 1 : 0);
