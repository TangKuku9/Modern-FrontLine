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
import { sanitizeLoadout, repairClass } from '../js/loadout.mjs';
import { DEFAULT_CLASSES } from '../js/data.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { withServer } = await import('../test/with-server.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, bad = 0;
const ok = (label, cond, extra = '') => { n++; if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); };

const srv = await withServer({
  NODE_ENV: 'production',
  MAX_ROOMS: '4', MAX_CLIENTS: '8', ROOM_IDLE_MS: '1500', MAX_PAYLOAD: '16384',
  ALLOW_ORIGIN: 'http://127.0.0.1',
  // 邀请码要给：生产模式下**不设** JOIN_CODE 会被配置闸拒绝启动（那是有意的 ——
  // 源码里那个默认码是公开的，而日志以前会说"已设"）。这条探针量的不是那一格。
  JOIN_CODE: 'probe-invite-code',
  // 这个探针量的是**部署面**（静态白名单、压缩协商、来源检查、配额），用访客身份跑。
  // 账号与闸门那一层在 test/hardening.mjs 里专门量（那边还会单独起一个 prod 服）。
  REQUIRE_ACCOUNT: '0',
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
const joiner = async (room, name, origin = 'http://127.0.0.1', payload = null) => {
  const ws = new WebSocket(srv.ws, { headers: { origin } });
  const msgs = []; const closed = []; let nAll = 0;
  ws.on('message', (m, isBinary) => { nAll++; if (!isBinary) msgs.push(String(m)); });
  ws.on('close', (code, reason) => closed.push([code, String(reason)]));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', e => rej(new Error('握手失败：' + e.message))); });
  ws.send(JSON.stringify({ t: 'join', room, name, team: 'A', ...(payload || {}) }));
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

  console.log('\n── 静态资源：一律回源再验证 + 压缩 ──');
  const raw = readFileSync(ROOT + 'js/main.js');
  const a = await get('/js/main.js');
  ok('js 文件按字节原样送达（压缩/缓存不能改内容）', a.status === 200 && a.buf.equals(raw), `${a.buf.length} B vs 磁盘 ${raw.length} B`);
  ok('非 html 资源也是 no-cache（发版本后客户端下次加载自动同步，不用等 24 小时新鲜期过完）', /no-cache/.test(a.headers['cache-control'] || ''), a.headers['cache-control']);
  const etag = a.headers.etag;
  const b304 = await get('/js/main.js', { 'if-none-match': etag });
  ok('带 ETag 再验证命中 304 且不带包体', b304.status === 304 && b304.buf.length === 0, `status=${b304.status} body=${b304.buf.length} B`);
  ok('304 也带 no-cache（存着旧 max-age 的浏览器只有从 304 头里才能学到新策略）', /no-cache/.test(b304.headers['cache-control'] || ''), b304.headers['cache-control']);
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
  const dev = await withServer({ REQUIRE_ACCOUNT: '0' });
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
  // 名字要合法（白名单 2~16 字）：这一份跑在访客可玩的服上，呼号只能用自报的那个，
  // 而服务端会拿注册用的同一个白名单验它 —— 单字（原来写的 '甲'/'乙'/'丙'）会被拒绝进场，
  // 于是下面量到的不是"房间配额"而是"名字不合法"，而它看起来只是"进不去"。
  const r1 = await joiner('quota-1', '配额甲');
  const r2 = await joiner('quota-2', '配额乙');
  const r3 = await joiner('quota-3', '配额丙');
  await sleep(300);
  const denied = r3.json().find(m => m.t === 'err');
  ok('超过 MAX_ROOMS 的新房被拒（客户端可以随便编房间号）', !!denied, JSON.stringify(denied || r3.json()));
  const hQ = JSON.parse(String((await get('/healthz')).buf));
  ok('被拒的那一次没有把房间表撑破', hQ.rooms === 4, `rooms=${hQ.rooms}（MAX_ROOMS=4：sec-ok + watch-1 + quota-1 + quota-2）`);
  r1.ws.close(); r2.ws.close();
  await sleep(300);
  const autoA = await joiner('auto', '自动甲');
  const autoB = await joiner('auto', '自动乙');
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

  console.log('\n── 进场装备闸门：一个人的坏数据不许打死别人的房间 ──');
  {
    // 配装是客户端递交的（?online=1 的访客把它那份 loadout 放进 join 帧），服务端只是
    // pl.equip 一下。所以"闸门有没有砍到正门"和"闸门拦不拦得住"两件事都要量：
    // 前者错了会造出两套 stats（本地按自己那套打、权威按另一套裁决 = 没人报错的 desync），
    // 后者错了就是无限手雷 + 一条帧打死一屋子人。
    // 深排序比较：键的插入顺序不算差异（computeStats 逐项乘，谁先谁后不影响结果），
    // 内容差必须算差异。注意不能拿 Object.keys(顶层).sort() 当 JSON.stringify 的第二个参数 ——
    // 那是"白名单键表"，会在每一层递归生效，掉一个配件也能"等值"通过，尺子就永远绿了。
    const sorted = v => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val))
      ? Object.fromEntries(Object.keys(val).sort().map(x => [x, val[x]])) : val);
    ok('这把尺子分得开内容差（不是"任何两份都等值"的永远绿）',
      sorted({ id: 'm4', att: { optic: 'holo' }, camo: 'none' }) !== sorted({ id: 'm4', att: {}, camo: 'none' })
      && sorted({ id: 'm4', att: { optic: 'holo', muzzle: 'comp' } }) === sorted({ att: { muzzle: 'comp', optic: 'holo' }, id: 'm4' }), '');
    const build = c => ({
      primary: { id: c.primary, att: c.patt || {}, camo: c.pcamo || 'none' },
      secondary: c.secondary ? { id: c.secondary, att: c.satt || {}, camo: c.scamo || 'none' } : null,
      lethal: c.lethal, tactical: c.tactical, perks: c.perks || [],
    });
    const kept = DEFAULT_CLASSES.filter(c => {
      const raw = build(c), out = sanitizeLoadout(raw);
      return sorted(raw.primary) === sorted(out.primary) && sorted(raw.secondary) === sorted(out.secondary)
        && raw.lethal === out.lethal && raw.tactical === out.tactical && JSON.stringify(raw.perks) === JSON.stringify(out.perks);
    });
    ok('五套预设职业原样通过闸门（砍到正门的白名单会以预测偏差的形式浮出来）', kept.length === DEFAULT_CLASSES.length,
      `${kept.length}/${DEFAULT_CLASSES.length} 等值 · 不一致的：${DEFAULT_CLASSES.filter(c => !kept.includes(c)).map(c => c.name).join(',') || '无'}`);

    // 同一份表也管着浏览器侧读存档（js/main.js 的 Game 构造函数拿 repairClass 修职业卡）：
    // 一个不存在的枪 id 会让菜单在 new Menu → buildScene → buildGun 里抛，整个页面停在
    // "初始化失败"。这条量的是"修完还是那五套预设"，也就是修桥不能顺手把桥面削了。
    const repaired = DEFAULT_CLASSES.map(repairClass);
    ok('五套预设职业过一遍存档修复（repairClass）内容不变', DEFAULT_CLASSES.every((c, i) => sorted(c) === sorted(repaired[i])),
      DEFAULT_CLASSES.map((c, i) => (sorted(c) === sorted(repaired[i]) ? '' : c.name)).filter(Boolean).join(',') || '全部等值');
    ok('存档里不存在的枪 id 会被放回合法值（菜单不再为手改的存档白屏）',
      repairClass({ name: '坏', primary: 'desert_eagle', patt: {}, secondary: 'nope' }).primary === 'm4', JSON.stringify(repairClass({ name: '坏', primary: 'desert_eagle' })));
    ok('存档形状不对（null）也不抛，回到第一套预设', (() => { try { return repairClass(null).primary === 'm4'; } catch (e) { return '抛了：' + e.message; } })(), '');
    ok('修完的卡一定带副武器（菜单里五处直接读 WEAPONS[k.secondary].name，去掉它等于把崩溃留下）',
      repairClass({ name: 'n', primary: 'm4' }).secondary === 'm1911' && repairClass({ name: 'n', primary: 'm4', secondary: null }).secondary === 'm1911', '');
    ok('单人玩法才有的字段（extraLethal）留在职业卡里，但进不了网络形状',
      repairClass({ name: 'n', primary: 'm4', extraLethal: 3 }).extraLethal === 3 && sanitizeLoadout({ primary: { id: 'm4' }, extraLethal: 3 }).extraLethal === undefined, '');

    const junk = sanitizeLoadout({
      primary: { id: 'desert_eagle', att: { optic: 'sniper', muzzle: 12345, under: {evil: 1} } },
      secondary: { id: 'pkm', att: {} },           // 没带"火力过载"，第二把主武器不该成立
      lethal: 'nuke', tactical: 'airstrike', perks: ['ghost', 'ghost', 'ninja', 'not-a-perk', 'sleight', 'doubletime'],
      extraLethal: 1e9, extraTac: 1e9,
    });
    ok('未知武器被放回默认，而不是带着坏 id 进模拟（computeStats 会为未知 id 抛）', junk.primary.id === 'm4', junk.primary.id);
    ok('配件按"这支枪有没有这槽 + 表里有没有这个 id + 允许不允许"三重筛掉', Object.keys(junk.primary.att).length === 0, JSON.stringify(junk.primary.att));
    ok('副武器规则由服务端执行：没带 overkill 就不能拿第二把主武器', junk.secondary.id === 'm1911', junk.secondary.id);
    ok('perk 去重、剔未知、限三件', JSON.stringify(junk.perks) === JSON.stringify(['ghost', 'ninja', 'sleight']), JSON.stringify(junk.perks));
    ok('客户端塞的 extraLethal/extraTac 进不去（那是"一条帧换无限手雷"）', junk.extraLethal === undefined && junk.extraTac === undefined, JSON.stringify(Object.keys(junk)));
    for (const [label, bad] of [['null', null], ['字符串', 'gun'], ['数组', ['x']], ['数字', 42], ['undefined', undefined]]) {
      let r = null, threw = null;
      try { r = sanitizeLoadout(bad); } catch (e) { threw = e.message; }
      ok(`畸形 loadout（${label}）不抛、给出可玩的默认`, !threw && r && r.primary.id === 'm4' && r.secondary.id === 'm1911', threw || sorted(r.primary));
    }
    const once = sanitizeLoadout({ primary: { id: 'ak', att: { muzzle: 'comp' } } });
    ok('幂等：闸门输出再过一次闸门不变（否则"两边各算一套"的日子还在）', sorted(sanitizeLoadout(once)) === sorted(once), sorted(once));

    // 端到端：这些载荷真的走一遍网络。判据不是"有没有报错"，而是**别人那一局还在不在跑** ——
    // 一个能把房间打死的包，症状是所有人卡在静止世界里。
    const bystander = await joiner('gear-1', '正牌');
    const before = bystander.all();
    const hostile = [];
    for (const [i, p] of [
      { loadout: { primary: { id: 'nope' }, extraLethal: 1e9 } },
      { loadout: '不是对象' },
      { loadout: { primary: { id: 'm4', att: { optic: 1, muzzle: {} } }, perks: 'x' } },
      { loadout: { primary: { id: 'l115', att: { optic: 'thermal' } }, secondary: { id: 'rpg' }, lethal: 'molotov', tactical: 'stim', perks: ['overkill', 'ghost', 'ninja'] } },
    ].entries()) hostile.push(await joiner('gear-1', '恶意' + i, 'http://127.0.0.1', p));
    await sleep(1200);
    const hz = JSON.parse(String((await get('/healthz')).buf));
    const room = (hz.per || []).find(r => r.id === 'gear-1');
    ok('恶意载荷进来之后这间还在按 60Hz 跑（没被任何一条打死）', !!room && room.hz > 45 && room.fails === 0, JSON.stringify(room || hz.per));
    const got = bystander.all() - before;
    ok('旁观者的快照一秒都没停（20Hz × 1.2s ≈ 24 帧）', got > 18, `旁观者收到 ${got} 帧`);
    ok('畸形 join 不会把人挂在半路：每一条要么进场要么收到原因',
      hostile.every(c => c.json().some(m => m.t === 'welcome' || m.t === 'err')),
      JSON.stringify(hostile.map(c => c.json().map(m => m.t))));
    const l4 = hostile[3].json().find(m => m.t === 'welcome');
    ok('welcome 把服务端重建的那份装备发回去（两边只有一套 stats）', !!l4 && l4.loadout && l4.loadout.primary.id === 'l115'
      && JSON.stringify(l4.loadout.perks) === JSON.stringify(['overkill', 'ghost', 'ninja']), JSON.stringify(l4 && l4.loadout));
    for (const c of [bystander, ...hostile]) c.ws.close();
    await sleep(300);
  }

  console.log('\n── 半开连接：放宽到 15 秒，但不是不清（判据两头都要量） ──');
  {
    // 心跳的判据从"这轮扫描时标志位"改成"上一次收到 pong 的时刻"之后，两件事都成立才算对：
    //   方向 A：一个不回 pong 的连接最终还是要被拆掉 —— 否则半开连接会永久占着房间名额；
    //   方向 B：一个刚刚建立、还没说过话的连接不许在 15 秒以内被拆 —— 那是"人多就莫名掉线"
    //           那一类事故的形状，而浏览器侧真的观察到过一次单方面拆断（1006、wasClean=false）。
    // 用手写握手的裸 socket：ws 库会自动回 pong，用它就没法造出"不回 pong 的客户端"。
    const raw = () => new Promise((res, rej) => {
      const s = netConnect(srv.port, '127.0.0.1');
      // Sec-WebSocket-Key 必须是"16 字节随机数的 base64"，长度不对服务端直接 400（ws 会算给你看：
      // 它解码后再编码，不是 16 字节就拒握手）。上一版给了 22 个字符，于是这条测试连门都没进。
      const key = Buffer.from('0123456789abcdef').toString('base64');
      const chunks = [];
      let opened = 0;
      s.on('data', d => {
        chunks.push(d);
        if (!opened && Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) {
          const head = Buffer.concat(chunks).slice(0, 1024).toString('latin1');
          opened = Date.now();
          if (!/ 101 /.test(head)) { s.destroy(); rej(new Error('握手没到 101：' + head.split('\r\n')[0])); return; }
          res({ socket: s, opened });
        }
      });
      s.on('error', rej);
      s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1\r\n\r\n`);
    });
    const quiet = await raw();
    let closed = 0;
    const watch = new Promise(r => quiet.socket.on('close', () => { closed = Date.now() - quiet.opened; r(closed); }));
    const raced = await Promise.race([watch, sleep(26000).then(() => 'timeout')]);
    ok('方向 A：不回 pong 的连接会在 15~26 秒之间被拆掉（半开连接不能永久占名额）',
      typeof closed === 'number' && closed > 14000 && closed < 26000, `沉默 ${closed}ms 后被拆（${raced === 'timeout' ? '本次到 26 秒仍未拆' : '已拆'}）`);
    try { quiet.socket.destroy(); } catch (e) { /* 已经断了 */ }
    const fresh = await raw();
    await sleep(9000);
    ok('方向 B：刚建立、还没说过话的连接不会被心跳拆掉（15 秒的宽限不是 5 秒）',
      !fresh.socket.destroyed, `沉默 9 秒后这条连接还在（destroyed=${fresh.socket.destroyed}）`);
    fresh.socket.destroy();
    await sleep(200);
  }

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
