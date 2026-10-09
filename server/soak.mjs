// 容量实测：一台进程能扛多少间、多少人，这个问题只能压出来，不能算出来。
//
//   node server/soak.mjs                  起一台临时服，默认阶梯 16 / 32 / 64 / 128 人
//   node server/soak.mjs 8                只压某一档（8 间 × 16 人）
//   node server/soak.mjs --ladder=1 --per=60     单间 60 人（dom 30v30 取证：docs/dom-large-scale-plan.md）
//   node server/soak.mjs --ladder=1 --per=60 --map=ridges --proto=2   // AOI 带宽取证（ridges 360m 两队隔山）
//   node server/soak.mjs --url=http://1.2.3.4:8090              压**已经在跑**的那一台
//   node server/soak.mjs --url=https://fps.example.com --cookie=mf_sid=xxx --ladder=1,2,4
//
// 两个"真机上必然踩到"的坑，写在这里省得下一次再量一遍：
//   · 来源白名单：生产部署一般会设 ALLOW_ORIGIN，而 ws 库默认**不**发 Origin 头 ⇒ 这台服
//     会把压测当成陌生来源全部 403。所以对外部目标默认带上"目标自己"这个来源（浏览器
//     同源访问时发的就是它），要压跨源部署时用 --origin= 显式给。
//   · 每 IP 连接数：CONNS_PER_IP 默认 6，本机压测 = 所有连接同一个 IP ⇒ 第 7 个就被拒。
//     容量测试要么把那一档调大，要么从多台机器压 —— 这不是"服务器扛不住"，是闸门在拦。
//
// 为什么要有 --url：真机闭环里"容器跑起来了"和"这台机器能扛多少人"是两件事，
// 而后者只有在**那一台**上压才算数（本机没有 docker 时，docker build 那一步做不了，
// 但这一压可以对着任何一台跑着的服务做 —— 包括本机以生产模式直接起的那个进程）。
// 外部目标不会被 kill，日志行那条判据会自动跳过；房间回收只对**自己开的那些间**判。
//
// 读数以**服务端自报**为主（/healthz 里的每间 hz / 每拍耗时 / 落后墙钟多少毫秒）：
// 假客户端跑在这个进程里，它自己也会被事件循环拖慢，从对面数出来的"帧率"分不清
// 是服务器慢还是我这里慢。所以客户端侧只作为下界参考，并且这里注明。
import { WebSocket } from 'ws';
import { withServer } from '../test/with-server.mjs';
import { encodeInput, INPUT_SIZE, HEADER_SIZE, ENTITY_SIZE } from './codec.mjs';
import { packInput } from '../js/quant.js';

const argv = process.argv.slice(2);
const flagArg = (k, d = null) => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
// 位置参数只认纯数字那一档（老用法），其余一律按 --k=v 解析
const positional = argv.find(x => !x.startsWith('--'));

// 一间压多少人。默认 16 是全模式共用的满员数；--per= 抬到 dom 大房那一档
// （docs/dom-large-scale-plan.md：20/40/60 的阶梯取证）。上限钳在 MAX_SEATS=64 ——
// 大厅不会发第 65 个座位，压它只会把读数变成"第 65 条连接进不来"。
import { MAX_SEATS } from './lobby.mjs';
const PER_ROOM = Math.max(1, Math.min(MAX_SEATS, Number(flagArg('per')) || 16));
const LADDER = flagArg('ladder') ? flagArg('ladder').split(',').map(Number)
  : positional ? [Number(positional)] : [1, 2, 4, 8];
const EXT = flagArg('url');                        // 外部目标 = 已经在跑的那一台
// 假客户端报的快照协议版本（阶段 1）：1 = 收全量（旧客户端，O(N²) 基线），2 = 服务端
// 按距离 AOI 裁剪后发。同一档人数跑两遍（--proto=1 / --proto=2）就是 AOI 前后的
// 带宽对照 —— 判据两遍都吃同一套（hz / 下行 / 落后），AOI 只该降下行、不该降 hz。
const PROTO = Math.max(1, Math.min(2, Number(flagArg('proto')) || 1));
// 压哪张图。默认 yard（与旧行为一致）：它是 ~120m 的小图，AOI 的 200m 圈罩着全场
// —— 在它上面量 AOI 永远是"裁不掉"，读数等于全量基线（这也正是"AOI 无增益时
// 没有额外开销"的最坏情形取证）。AOI 的真实收益要在 ridges（dom 专属图，360m，
// 两队营地相距 >200m）上量：--map=ridges。
const MAP = flagArg('map', 'yard');
const COOKIE = flagArg('cookie');                  // 外部目标要账号时带上门（mf_sid=...）
const EXT_BASE = EXT ? EXT.replace(/\/$/, '') : '';
// 外部目标默认带上"目标自己"这个来源：生产部署通常设了 ALLOW_ORIGIN，而 ws 不发 Origin
// 就会被当成陌生来源全部 403 —— 那看起来像"压不动"，其实是闸门在按设计工作。
const ORIGIN = flagArg('origin', EXT_BASE || null);
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
    this.bytes = 0;   // 下行字节（含文本帧）：采样窗口两端相减 = 这个人的下行带宽
    this.keys = packInput({ fwd: true, right: true, sprint: true, fire: true });
    const hd = {};
    if (COOKIE) hd.cookie = COOKIE;
    if (ORIGIN) hd.origin = ORIGIN;
    this.ws = new WebSocket(url, Object.keys(hd).length ? { headers: hd } : {});
    this.open = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', (m, isBinary) => {
      this.bytes += m.length;
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
    this.ws.send(JSON.stringify({ t: 'join', proto: PROTO, room: this.room, name: 's' + Math.random().toString(36).slice(2, 6), team: this.cid % 2 ? 'A' : 'B' }));
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

const srv = EXT
  // 外部目标：只借它一个 base/ws，kill 与日志都不是我们的事（那台机器不归这个进程管）
  ? { base: EXT_BASE, ws: EXT_BASE.replace(/^http/, 'ws') + '/ws', kill: () => {}, log: () => '(外部目标：本机没有它的日志)' }
  // REQUIRE_ACCOUNT 必须显式关掉：默认要登录（net-server 的 REQUIRE_ACCOUNT !== '0'），
  // 而假客户端没有会话 ⇒ 每一条都在握手阶段 401，`await c.open.catch(() => {})` 把它吞掉后
  // 全按 dead 算 —— 整个阶梯压的其实是"鉴权拒绝所有人"。net-probe 早就为同一件事写过
  // 同一条 env（并注明了漏写它每条都会红在"连不上"上），本地临时服这里必须带上；
  // --url 外部目标不受影响（要不要登录由那一台自己的配置决定，走 --cookie）。
  // CONNS_PER_IP 同理：本机压测所有连接同一 IP，默认 6 ⇒ 第 7 条起全被拆（文件头注释
  // 写明的第二个坑），读数就成了"闸门工作正常"。README 记载的本机读数就是按 256 跑的。
  : await withServer({
      MAX_ROOMS: '16', ROOM_IDLE_MS: '3000', REQUIRE_ACCOUNT: '0',
      MAP,   // --map=：AOI 的带宽收益要在 360m 的 ridges 上量，yard 上它罩着全场
      // 连接类闸门按**这次阶梯的总人数**抬（旧值 400/256 是按 16 人 × 8 间写的）。
      // --per=60 --ladder=8 = 480 人：闸门不抬的话读数就成了"闸门工作正常"（文件头
      // 写明的第二个坑），而不是"服务器扛不扛得住"。余量 +32 给握手期在途的连接。
      MAX_CLIENTS: String(LADDER.reduce((a, r) => a + r * PER_ROOM, 0) + 32),
      CONNS_PER_IP: String(LADDER.reduce((a, r) => a + r * PER_ROOM, 0) + 32),
    });
const STDNAME = `soak-${process.pid.toString(36)}`;      // 自己开的房间都带这个前缀，回收只认它们
const clients = [];
const myRooms = new Set();
let code = 0;
try {
  console.log(`\n  目标：${EXT ? `外部 ${srv.base}` : '本机临时服'}${COOKIE ? ' · 带会话 cookie' : ''}${ORIGIN ? ` · 来源 ${ORIGIN}` : ''}`);
  console.log(`  ${'人数'.padStart(6)}  ${'间数'.padStart(4)}   每间Hz(服务端自报)      每拍ms     落后ms    快照Hz/人(下界)   下行kbps/人   出口Mbps   最大在途   heapMB`);
  const rows = [];
  for (const rooms of LADDER) {
    clients.length = 0;
    for (let r = 0; r < rooms; r++) {
      const roomId = `${STDNAME}-${r}`;
      myRooms.add(roomId);
      for (let i = 0; i < PER_ROOM; i++) {
        const c = new FakeClient(srv.ws, roomId, r * PER_ROOM + i);
        c.room = roomId;
        await c.open.catch(() => {});
        clients.push(c);
      }
    }
    clients.forEach(c => c.start());
    await sleep(WARM_MS);
    const s0 = clients.reduce((a, c) => a + c.snaps, 0);
    const b0 = clients.reduce((a, c) => a + c.bytes, 0);
    const hBefore = await getJSON(srv.base);
    const t0 = Date.now();
    await sleep(SAMPLE_MS);
    const secs = (Date.now() - t0) / 1000;
    const h = await getJSON(srv.base);
    const snaps = (clients.reduce((a, c) => a + c.snaps, 0) - s0) / clients.length / secs;
    // 下行带宽：窗口字节差 ÷ 人数 ÷ 秒 → kbps/人；×总人数 = 这一间（这几间）的出口
    const kbPer = (clients.reduce((a, c) => a + c.bytes, 0) - b0) / clients.length / secs * 8 / 1000;
    const egress = kbPer * clients.length / 1000;
    const per = h.per || [];
    const hz = per.length ? Math.min(...per.map(p => p.hz)) : 0;
    const step = per.length ? Math.max(...per.map(p => p.stepMs)) : 0;
    const behind = per.length ? Math.max(...per.map(p => p.behindMs)) : 0;
    const infl = Math.max(...clients.map(c => c.maxInflight));
    const dead = clients.filter(c => c.err).length;
    rows.push({ clients: clients.length, rooms, hz, step, behind, snaps, kb: kbPer, eg: egress, infl, heap: h.heapMB, dead });
    console.log(`  ${String(clients.length).padStart(6)}  ${String(rooms).padStart(4)}   ${hz.toFixed(1).padStart(10)}   ${step.toFixed(3).padStart(8)}   ${String(behind).padStart(8)}   ${snaps.toFixed(1).padStart(12)}   ${kbPer.toFixed(0).padStart(9)}   ${egress.toFixed(2).padStart(8)}   ${String(infl).padStart(9)}   ${h.heapMB}`);
    ok(`这一档没有客户端被踢/报错`, dead === 0, `异常 ${dead} 条`);
    ok(`这一档服务端仍然贴着 60Hz 跑（≥57）`, hz >= 57, `${hz.toFixed(1)}Hz · 每拍 ${step.toFixed(2)}ms · 落后 ${behind}ms`);
    ok(`这一档每个人的下行仍然接近 20Hz（≥15，客户端侧下界）`, snaps >= 15, `${snaps.toFixed(1)}Hz`);
    clients.forEach(c => c.stop());
    await sleep(1200);
  }
  const healthy = rows.filter(r => r.hz >= 57 && r.snaps >= 15 && r.behind < 150);
  const top = healthy.length ? healthy[healthy.length - 1] : null;
  console.log(`\n  这台机器上，单进程实测能扛到的最高一档：${top ? `${top.clients} 人 / ${top.rooms} 间（每间 ${top.hz.toFixed(1)}Hz · 每拍 ${top.step.toFixed(2)}ms · 下行 ${top.snaps.toFixed(1)}Hz/人 · ${top.kb.toFixed(0)} kbps/人 · 出口 ${top.eg.toFixed(2)} Mbps · 峰值堆 ${top.heap} MB）` : '连最低一档都没过 —— 见上面的红'}`);
  ok('至少一档是健康的（否则这台机器不该上线）', !!top);
  ok(`一间满员(${PER_ROOM} 人)必须在预算内 —— 这是"能不能开一局"的底线`, rows[0].hz >= 59 && rows[0].behind < 60, `${rows[0].hz.toFixed(1)}Hz · 落后 ${rows[0].behind}ms · 每拍 ${rows[0].step.toFixed(2)}ms`);
  const hEnd = await getJSON(srv.base);
  // 回收只看**自己开的那些间**：外部目标上可能还有别人的房间，"rooms 归零"在真机上
  // 是个会假红的判据（它量的是"整台机器空不空"，不是"我开的房间收不收得掉"）。
  const mineLeft = (h) => ((h.per || []).filter(p => String(p.id).startsWith(STDNAME)).length);
  for (let i = 0; i < 40 && mineLeft(await getJSON(srv.base)) > 0; i++) await sleep(500);
  const hReaped = await getJSON(srv.base);
  ok('压完之后我开的房间能被收干净（长跑不会只涨不落）', mineLeft(hReaped) === 0,
    `我剩 ${mineLeft(hReaped)} 间 / 全机 ${hReaped.rooms} 间 · 堆 ${hReaped.heapMB} MB（回收前 ${hEnd.heapMB} MB）`);
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
