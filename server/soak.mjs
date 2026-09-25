// 容量实测：一台进程能扛多少间、多少人，这个问题只能压出来，不能算出来。
//
//   node server/soak.mjs            默认阶梯 16 / 32 / 64 / 128 人
//   node server/soak.mjs 8          只压某一档（8 间 × 16 人）
//
// 读数以**服务端自报**为主（/healthz 里的每间 hz / 每拍耗时 / 落后墙钟多少毫秒）：
// 假客户端跑在这个进程里，它自己也会被事件循环拖慢，从对面数出来的"帧率"分不清
// 是服务器慢还是我这里慢。所以客户端侧只作为下界参考，并且这里注明。
import { WebSocket } from 'ws';
import { withServer } from '../test/with-server.mjs';
import { encodeInput, INPUT_SIZE, HEADER_SIZE, ENTITY_SIZE } from './codec.mjs';
import { packInput } from '../js/quant.js';

const PER_ROOM = 16;                               // 一张图满员 16 人
const LADDER = process.argv[2] ? [Number(process.argv[2])] : [1, 2, 4, 8];
const WARM_MS = 4000, SAMPLE_MS = 12000;
const DT = 1000 / 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = (base) => fetch(base + '/healthz').then(r => r.json());

// 定长格式里 ack 就在每个实体的固定偏移上 —— 从字节里挑自己要的那一格，
// 不用把整包 decodeSnapshot 成对象（那会在压测进程里造出成千上万个临时对象，
// 让"我这里慢"看起来像"服务器慢"）。
function findAckAndTick(buf, cid) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tick = v.getUint32(0, true);
  const n = v.getUint8(5);
  for (let i = 0; i < n; i++) {
    const o = HEADER_SIZE + i * ENTITY_SIZE;
    if (v.getUint16(o, true) === cid) return { tick, ack: v.getUint16(o + 22, true) };
  }
  return null;
}

class FakeClient {
  constructor(url, room, cid) {
    this.tick = 0; this.local = 0; this.snaps = 0; this.maxInflight = 0; this.cid = cid;
    this.lastAck = -1; this.lastTick = 0; this.err = null;
    this.keys = packInput({ fwd: true, right: true, sprint: true, fire: true });
    this.ws = new WebSocket(url);
    this.open = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', (m, isBinary) => {
      if (isBinary) {
        const r = findAckAndTick(m, this.cid);
        if (r) {
          this.snaps++; this.lastAck = r.ack; this.lastTick = r.tick;
          const inflight = ((this.tick - r.ack) & 0xffff);
          if (inflight < 32768) this.maxInflight = Math.max(this.maxInflight, inflight);
        }
        return;
      }
      try {
        const j = JSON.parse(String(m));
        if (j.t === 'welcome') this.cid = j.cid;
        if (j.t === 'err') this.err = j.msg;
      } catch { /* 忽略 */ }
    });
    this.ws.on('error', e => { this.err = String(e.message || e); });
    this.ws.on('close', c => { if (c !== 1005 && c !== 1000 && c !== 1001) this.err = this.err || ('close ' + c); });
  }
  start() {
    this.ws.send(JSON.stringify({ t: 'join', room: this.room, name: 's' + Math.random().toString(36).slice(2, 6), team: this.cid % 2 ? 'A' : 'B' }));
    // 一帧一份输入包，和浏览器那边的攒包方式一致（test/net-play 里 60Hz = 每帧一拍）
    this.timer = setInterval(() => {
      const mdx = Math.sin(this.tick / 20) * 3;
      const b = encodeInput({ tick: this.tick & 0xffff, mdx, mdy: Math.cos(this.tick / 17) * 1.5, keys: this.keys.keys, buttons: this.keys.buttons, seq: this.tick & 0xff });
      this.ws.send(Buffer.from(b.buffer), { binary: true });
      this.tick++;
    }, DT);
  }
  stop() { clearInterval(this.timer); try { this.ws.close(); } catch { /* */ } }
}

let n = 0, bad = 0;
const ok = (label, cond, extra = '') => { n++; if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); }

const srv = await withServer({ MAX_ROOMS: '16', MAX_CLIENTS: '400', ROOM_IDLE_MS: '3000' });
const clients = [];
let code = 0;
try {
  console.log(`\n  ${'人数'.padStart(6)}  ${'间数'.padStart(4)}   每间Hz(服务端自报)      每拍ms     落后ms    快照Hz/人(下界)   最大在途   heapMB`);
  const rows = [];
  for (const rooms of LADDER) {
    clients.length = 0;
    for (let r = 0; r < rooms; r++) {
      for (let i = 0; i < PER_ROOM; i++) {
        const c = new FakeClient(srv.ws, `soak-${r}-${process.pid.toString(36)}`, r * PER_ROOM + i);
        c.room = `soak-${r}`;
        await c.open.catch(() => {});
        clients.push(c);
      }
    }
    clients.forEach(c => c.start());
    await sleep(WARM_MS);
    const s0 = clients.reduce((a, c) => a + c.snaps, 0);
    const hBefore = await getJSON(srv.base);
    const t0 = Date.now();
    await sleep(SAMPLE_MS);
    const secs = (Date.now() - t0) / 1000;
    const h = await getJSON(srv.base);
    const snaps = (clients.reduce((a, c) => a + c.snaps, 0) - s0) / clients.length / secs;
    const per = h.per || [];
    const hz = per.length ? Math.min(...per.map(p => p.hz)) : 0;
    const step = per.length ? Math.max(...per.map(p => p.stepMs)) : 0;
    const behind = per.length ? Math.max(...per.map(p => p.behindMs)) : 0;
    const infl = Math.max(...clients.map(c => c.maxInflight));
    const dead = clients.filter(c => c.err).length;
    rows.push({ clients: clients.length, rooms, hz, step, behind, snaps, infl, heap: h.heapMB, dead });
    console.log(`  ${String(clients.length).padStart(6)}  ${String(rooms).padStart(4)}   ${hz.toFixed(1).padStart(10)}   ${step.toFixed(3).padStart(8)}   ${String(behind).padStart(8)}   ${snaps.toFixed(1).padStart(12)}   ${String(infl).padStart(9)}   ${h.heapMB}`);
    ok(`这一档没有客户端被踢/报错`, dead === 0, `异常 ${dead} 条`);
    ok(`这一档服务端仍然贴着 60Hz 跑（≥57）`, hz >= 57, `${hz.toFixed(1)}Hz · 每拍 ${step.toFixed(2)}ms · 落后 ${behind}ms`);
    ok(`这一档每个人的下行仍然接近 20Hz（≥15，客户端侧下界）`, snaps >= 15, `${snaps.toFixed(1)}Hz`);
    clients.forEach(c => c.stop());
    await sleep(1200);
  }
  const healthy = rows.filter(r => r.hz >= 57 && r.snaps >= 15 && r.behind < 150);
  const top = healthy.length ? healthy[healthy.length - 1] : null;
  console.log(`\n  这台机器上，单进程实测能扛到的最高一档：${top ? `${top.clients} 人 / ${top.rooms} 间（每间 ${top.hz.toFixed(1)}Hz · 每拍 ${top.step.toFixed(2)}ms · 下行 ${top.snaps.toFixed(1)}Hz/人 · 峰值堆 ${top.heap} MB）` : '连最低一档都没过 —— 见上面的红'}`);
  ok('至少一档是健康的（否则这台机器不该上线）', !!top);
  ok('一间满员(16 人)必须在预算内 —— 这是"能不能开一局"的底线', rows[0].hz >= 59 && rows[0].behind < 60, `${rows[0].hz.toFixed(1)}Hz · 落后 ${rows[0].behind}ms · 每拍 ${rows[0].step.toFixed(2)}ms`);
  const hEnd = await getJSON(srv.base);
  for (let i = 0; i < 40 && (await getJSON(srv.base)).rooms > 0; i++) await sleep(500);
  const hReaped = await getJSON(srv.base);
  ok('压完之后房间能被收干净（长跑不会只涨不落）', hReaped.rooms === 0, `剩 ${hReaped.rooms} 间 · 堆 ${hReaped.heapMB} MB（回收前 ${hEnd.heapMB} MB）`);
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  console.log('── 服务端日志（尾 20 行）──\n' + srv.log().split('\n').slice(-20).join('\n'));
  code = 2; bad++; n++;
} finally {
  clients.forEach(c => { try { c.stop(); } catch { /* */ } });
  srv.kill();
}
console.log(`\n${bad ? 'RED' : 'GREEN'}  ${n - bad}/${n} 通过`);
process.exit(code || (bad ? 1 : 0));
