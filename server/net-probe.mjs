// 端到端探针：起一台权威服务，用两个真 WebSocket 客户端跑通"加入 → 上行输入 →
// 收快照 → 看到对方动"。这是 P1 最小竖切片唯一的验收装置 —— 浏览器还没接之前，
// 它就得能证明服务端裁决、包格式、节拍、路径穿越防护都是活的。
//
//   node server/net-probe.mjs
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { decodeSnapshot, encodeInput, INPUT_SIZE } from './codec.mjs';
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

// 快照节拍与包大小
const span = (A.snaps[A.snaps.length - 1].tick - A.snaps[1].tick) / 60;
ok(`快照节拍 ${(A.snaps.length / Math.max(0.2, span)).toFixed(1)} Hz（目标 20Hz）`, A.snaps.length > 10);
const per = A.bytes / A.snaps.length;
ok(`2 人快照 ${per.toFixed(0)} B/包（期望 ${7 + 2 * 21}）`, Math.abs(per - (7 + 2 * 21)) < 1);

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
const idx = await new Promise((res) => { const rq = request({ port: PORT, path: '/index.html' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, len: b.length, head: b.slice(0, 400) })); }); rq.end(); });
ok(`正常文件能拿到（${idx.len} 字节，含 importmap = ${idx.head.includes('importmap')}）`, idx.code === 200 && idx.head.includes('importmap'));
const js = await new Promise((res) => { const rq = request({ port: PORT, path: '/js/weapon-state.js' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, ct: r.headers['content-type'] })); }); rq.end(); });
ok(`模块按 text/javascript 发出（${js.ct}）`, js.code === 200 && /^text\/javascript/.test(js.ct || ''));

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
