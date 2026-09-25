// 端到端探针：起一台权威服务，用两个真 WebSocket 客户端跑通"加入 → 上行输入 →
// 收快照 → 看到对方动"。这是 P1 最小竖切片唯一的验收装置 —— 浏览器还没接之前，
// 它就得能证明服务端裁决、包格式、节拍、路径穿越防护都是活的。
//
//   node server/net-probe.mjs
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { decodeSnapshot, encodeInput, INPUT_SIZE, HEADER_SIZE, ENTITY_SIZE } from './codec.mjs';
import { KEY } from '../js/quant.js';

// 端口不能写死：这台机器上别的进程随时占着某个固定端口，写死会让探针"红得没有信息量"。
// 先向内核要一个空出来的端口。
const PORT = await new Promise((res, rej) => {
  const s = netServer();
  s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const srv = spawn(process.execPath, ['server/net-server.mjs', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MAP: 'yard' } });
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 120 && !srvLog.includes('权威对局服务'); i++) await sleep(50);
if (!srvLog.includes('权威对局服务')) { console.log('服务端没起来:\n' + srvLog); srv.kill(); process.exit(1); }

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label + (extra ? '  ' + extra : '')]); return !!cond; };

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.binaryType = 'arraybuffer';
  const c = { ws, name, cid: null, snaps: [], evs: [], bytes: 0, err: null };
  ws.onmessage = (m) => {
    if (typeof m.data === 'string') {
      const j = JSON.parse(m.data);
      if (j.t === 'welcome') c.cid = j.cid, c.welcome = j;
      else if (j.t === 'ev') c.evs.push(...j.ev);
      else if (j.t === 'err') c.err = j.msg;
      else if (j.t === 'pong') c.pong = j;
    } else {
      const s = decodeSnapshot(m.data);
      c.bytes += m.data.byteLength;
      c.snaps.push(s);
      (c.idsets || (c.idsets = [])).push(s.entities.map(e => e.id).join(','));
      c.last = s;
    }
  };
  return c;
}
const send = (c, buf) => c.ws.send(buf, { binary: true });

const A = client('A'), B = client('B');
await new Promise(r => setTimeout(r, 300));
A.ws.send(JSON.stringify({ t: 'join', room: 'probe', name: '甲', team: 'A' }));
await sleep(200);
B.ws.send(JSON.stringify({ t: 'join', room: 'probe', name: '乙', team: 'B' }));
for (let i = 0; i < 60 && !(A.cid && B.cid); i++) await sleep(50);
ok('两个客户端都拿到 cid', A.cid === 1 && B.cid === 2, `A=${A.cid} B=${B.cid}`);
ok('welcome 里带出生点', Array.isArray(A.welcome?.pos) && A.welcome.pos.length === 3);
// 只有第二个人加入时对手才存在：A 先进来，A 的 welcome 里 others 必须是空
ok('A 的 welcome 里还没有别人（它先加入）', (A.welcome?.others || []).length === 0);
ok('B 的 welcome 里列出了 A', (B.welcome?.others || []).some(o => o.id === A.cid),
  JSON.stringify(B.welcome?.others));
ok('加入过程服务端没报错', !A.err && !B.err, (A.err || B.err || ''));
// 先决断言：一个快照都没收到时后面全是空指针，那种红没有信息量 —— 直接报名字并倒日志
// 必须等一个明确的采样窗口：连接握手刚结束时 B 甚至可能还没轮到一次下行，
// 拿"握手返回的那一刻"当判据窗口，测到的就是竞态而不是节拍（这条曾经以 1 包/0 包红过一次）。
for (let i = 0; i < 40 && !(A.snaps.length >= 3 && B.snaps.length >= 3); i++) await sleep(50);
if (!A.last || !B.last) {
  ok('收到了快照', false, `A ${A.snaps.length} 包 / B ${B.snaps.length} 包`);
  for (const [f, label] of checks) console.log(`  ${f ? '✅' : '❌'} ${label}`);
  console.log('\n  服务端日志:\n    ' + srvLog.trim().split('\n').slice(-20).join('\n    '));
  srv.kill(); process.exit(1);
}

// A 按住前进 1 秒，B 应该看到 A 的坐标变了
const baseA = A.last?.entities?.find(e => e.id === A.cid);
let tick = baseA ? 0 : 0;
for (let i = 0; i < 60; i++) {
  send(A, encodeInput({ tick: ++tick, mdx: 0, mdy: 0, keys: KEY.Fwd, buttons: 0, seq: i }));
  send(B, encodeInput({ tick, mdx: 0, mdy: 0, keys: 0, buttons: 0, seq: i }));
  await sleep(16);
}
await sleep(200);
const nowA = A.last.entities.find(e => e.id === A.cid);
const seenA = B.last.entities.find(e => e.id === A.cid);
const moved = Math.hypot(nowA.x - baseA.x, nowA.z - baseA.z);
ok('服务端按输入推进了 A（自己看到）', moved > 1.0, `位移 ${moved.toFixed(2)} m`);
ok('B 也看到 A 动了同一个位置', Math.hypot(seenA.x - nowA.x, seenA.z - nowA.z) < 0.06,
  `A=${nowA.x.toFixed(2)},${nowA.z.toFixed(2)} B眼里=${seenA.x.toFixed(2)},${seenA.z.toFixed(2)}`);
const b0 = B.snaps[1].entities.find(e => e.id === B.cid);
const b1 = B.last.entities.find(e => e.id === B.cid);
ok('没发按键的 B 留在原地', Math.hypot(b1.x - b0.x, b1.z - b0.z) < 0.02,
  `B 位移 ${Math.hypot(b1.x - b0.x, b1.z - b0.z).toFixed(4)} m`);

// 突发一帧塞 20 拍输入：服务端必须一拍不丢地全消费。丢拍不会报错，只会让客户端的
// 预测比权威端多走几步，下一次校正就是橡皮筋 —— 所以这条要按 ack 精确断言，不是"大概动了"。
{
  const me0 = A.last.entities.find(e => e.id === A.cid);
  const ack0 = me0.ack, p0 = { x: me0.x, z: me0.z };
  for (let i = 0; i < 20; i++) send(A, encodeInput({ tick: ++tick, mdx: 0, mdy: 0, keys: KEY.Fwd, buttons: 0, seq: i }));
  await sleep(600);
  const me1 = A.last.entities.find(e => e.id === A.cid);
  const advanced = (me1.ack - ack0) & 0xffff;
  const d20 = Math.hypot(me1.x - p0.x, me1.z - p0.z);
  ok(`突发 20 拍输入一拍不丢地被消费`, advanced === 20, `ack ${ack0}→${me1.ack}（前进 ${advanced}）· 位移 ${d20.toFixed(2)} m`);
  ok(`这 20 拍真的推进了物理（不是被合成一步）`, d20 > 1.2, `位移 ${d20.toFixed(2)} m，20 拍满速 ≈ 1.5 m`);
}

// 快照节拍与包大小
const span = (A.snaps[A.snaps.length - 1].tick - A.snaps[1].tick) / 60;
ok(`快照节拍 ${(A.snaps.length / Math.max(0.2, span)).toFixed(1)} Hz（目标 20Hz）`, A.snaps.length > 10);
const per = A.bytes / A.snaps.length;
// 期望值从协议常量算，不在探针里再抄一份布局：上一次协议加宽（实体 21→24B、头部 7→11B）
// 之后这条就红了，而红的是我自己的抄本、不是包变大。
// 但"每人不超过 26 B"是**规格**，写死在这里 —— 它才是防包膨胀的那道闸，不能跟着常量漂。
const expect = HEADER_SIZE + 2 * ENTITY_SIZE;
ok(`2 人快照 ${per.toFixed(0)} B/包（协议算出 ${expect}）`, Math.abs(per - expect) < 1);
// 带宽闸要按**边际成本**算，不是按"这包摊到每人多少"：头部那 11 B 摊在 2 人头上是 5.5 B/人，
// 摊在 16 人头上是 0.7 B/人，所以"29.5 B/人"这种数会随人数变，拿它当阈值是挂错量具。
// 真正随人数线性增长的是 ENTITY_SIZE，规格就钉在它身上：一个人 24 B，16 人 20Hz ≤ 100 kbps。
const kbps16 = (HEADER_SIZE + 16 * ENTITY_SIZE) * 20 * 8 / 1000;
ok(`16 人 @20Hz 下行 ${kbps16.toFixed(1)} kbps ≤ 规格 100 kbps`, kbps16 <= 100);
ok(`每多一人的边际成本 ${ENTITY_SIZE} B ≤ 规格 28 B`, ENTITY_SIZE <= 28);

// 输入包必须定长被服务端正确切开：一次发 3 个包，服务端应收到 3 次
const before = A.last.tick;
const batch = new Uint8Array(INPUT_SIZE * 3);
for (let i = 0; i < 3; i++) new Uint8Array(encodeInput({ tick: ++tick, mdx: 0, mdy: 0, keys: KEY.Jump, buttons: 0, seq: i }).buffer).forEach((b, k) => batch[i * INPUT_SIZE + k] = b);
send(A, batch);
await sleep(300);
ok('一帧多个输入包能切开', A.last.tick > before);

// 路径穿越：静态服务不许把仓库外的文件发出去
const trav = await new Promise((res) => {
  const rq = request({ port: PORT, path: '/..%2f..%2f..%2fWindows%2fwin.ini' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, body: b.slice(0, 40) })); });
  rq.on('error', e => res({ code: 'ERR', body: String(e.message) }));
  rq.end();
});
ok(`路径穿越被拦（HTTP ${trav.code}）`, trav.code === 403 || trav.code === 404, trav.body);
// 要验的性质是"静态服务把带 importmap 的 index.html 原样发出来了"，不是"importmap 出现在
// 前 400 字节里" —— 后者会被任何一行正常的头部改动（比如加个 favicon）撞红。
const idx = await new Promise((res) => { const rq = request({ port: PORT, path: '/index.html' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, len: b.length, hasMap: b.includes('"importmap"') })); }); rq.end(); });
ok(`正常文件能拿到（${idx.len} 字节，含 importmap = ${idx.hasMap}）`, idx.code === 200 && idx.hasMap);
const js = await new Promise((res) => { const rq = request({ port: PORT, path: '/js/weapon-state.js' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, ct: r.headers['content-type'] })); }); rq.end(); });
ok(`模块按 text/javascript 发出（${js.ct}）`, js.code === 200 && /^text\/javascript/.test(js.ct || ''));

// 房间隔离：一台服务上开第二个房间，不许往这两个人的下行里塞别人，也不许把他们的
// 包变得没有实体。这是修掉"broadcast 遍历 wss.clients"之后钉的那道闸 —— 那种错在
// 单房间探针里永远看不出来，只会在浏览器里表现为"弹匣数字乱跳、队友凭空消失"。
{
  const markA = A.idsets.length, markB = B.idsets.length;
  const C = client('丙');
  await sleep(150);
  const markC = (C.idsets || []).length;
  C.ws.send(JSON.stringify({ t: 'join', room: 'other-' + PORT, name: '丙', team: 'A' }));
  for (let i = 0; i < 60 && !(C.cid && A.idsets.length > markA + 4 && B.idsets.length > markB + 4); i++) await sleep(50);
  await sleep(250);
  const aTail = A.idsets.slice(markA), bTail = B.idsets.slice(markB), cTail = C.idsets.slice(markC);
  const mine = [A.cid, B.cid].sort((x, y) => x - y).join(',');
  // cid 现在是全进程唯一的，所以"包里的 id 集合"就是判据本身：
  // 我的每一包里必须恰好是我 + 队友，多一个少一个都算串门/漏人。
  const wrong = aTail.concat(bTail).filter(s => s.split(',').sort((x, y) => x - y).join(',') !== mine);
  // 反证臂：第二个房间必须真的在跑，否则上面那条可能只是"没开成第二个房间"的假绿
  ok(`第二个房间确实在独立广播（丙收到 ${cTail.length} 包，且只含自己）`,
    cTail.length > 4 && cTail.every(s => s === String(C.cid)), `丙的实体表样本 ${JSON.stringify(cTail.slice(0, 3))}`);
  ok('另一个房间的人不会串进甲乙的下行', wrong.length === 0,
    `不符 ${wrong.length} / ${aTail.length + bTail.length} 包，样本 ${JSON.stringify(wrong.slice(0, 3))}（应为 ${mine}）`);
  C.ws.close();
  await sleep(200);
}

// 断开要腾出名额
const n0 = A.last.entities.length;
B.ws.close();
await sleep(400);
ok('离开后快照里少一个人', A.last.entities.length === n0 - 1, `${n0} → ${A.last.entities.length}`);

ok('没有服务端错误帧', !A.err && !B.err, (A.err || B.err || ''));
A.ws.close();
await sleep(200);
srv.kill();

let green = true;
for (const [f, label] of checks) { green &&= f; console.log(`  ${f ? '✅' : '❌'} ${label}`); }
console.log('\n  服务端日志尾部:\n    ' + srvLog.trim().split('\n').slice(-24).join('\n    '));
console.log(`\n  结论：${green ? '绿' : '红'}`);
process.exit(green ? 0 : 1);
