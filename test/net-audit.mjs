// 联网同步审计（docs/net-sync-audit.md）里**高危**与同步面几条中危的判据。
//
//   node test/net-audit.mjs
//
// 这一份为什么存在：审计里那几条的共同形状是"两端各自对着默认值自洽" ——
// 所有既有测试的两端都用同一份硬编码设置、同一个包长上限、同一个队列长度，
// 于是坏掉的那一半在任何读数上都不显形。H1 尤其典型：判据要能说清
// "甲的 sens=3.0 与乙的 sens=0.5 在同一拍里转向速率相差 6 倍"，
// 而不是"join 帧里有没有 view 这个字段"（那是源码里有没有那个字，不是行为）。
//
// 纪律按本仓库的老规矩：
//   ① 每条判据配**反证臂**，而且反证是当场算出来的另一个读数（不是"再跑一遍还是绿的"）。
//   ② **量具先自证活着**：D 段先证明那个假 ws 真的收到了东西，否则"没收到快照"可以
//      只是采集器坏了 —— 那正是本仓库翻过车的那一类（恒红/恒绿长得一样）。
//   ③ 前提写进判据：B 段要先确认两个人的 sens 真的不同，否则"转向速率不同"量的是空气。
import '../server/browser-shim.mjs';
import * as THREE from 'three';
import { NetRoom, INPUT_QUEUE } from '../server/room.mjs';
import { fanout, nadeCounts } from '../server/fanout.mjs';
import { sanitizeViewSettings, viewSettingsOf, VIEW_LIMITS } from '../js/player.js';
import { NetClient } from '../js/net/client.mjs';
import { encodeInput, decodeInput } from '../server/codec.mjs';
import { roundLook, LOOK_STEP, LOOK_MAX, LOOK_CODE_MAX } from '../js/quant.js';
import { killfeedIdent, killerRemote } from '../js/net/identity.mjs';
import { LobbyClient } from '../js/net/lobby.mjs';
import { escHtml } from '../js/escape.js';
import { chatRowHtml } from '../js/net/chat.mjs';
import { readFileSync } from 'node:fs';

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label + (extra ? '  ' + extra : '')]); return !!cond; };
const sec = (t) => console.log('\n── ' + t + ' ──');
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ═══════════════════════════════════════════════════════════════════════════
sec('A. H1 单位：视角设置那份的范围清洗（服务端只认这一份）');
// ═══════════════════════════════════════════════════════════════════════════
ok('A1 空/畸形输入退到默认值（老客户端与探针那个方向：不带这一格时行为与改动前逐位相同）',
  (() => { const v = sanitizeViewSettings(null); return v.sens === 1.0 && v.adsSens === 0.9 && v.invertY === false; })(),
  JSON.stringify(sanitizeViewSettings(undefined)));
// 反证臂①：这条红了 = 清洗是个"什么都放行"的恒等函数（那正是这一格最危险的失效形状）
ok('A2【反证臂】1e9 被夹进上限（不夹的话 NaN/Inf 会顺着快照传给所有渲染它的人）',
  sanitizeViewSettings({ sens: 1e9 }).sens === VIEW_LIMITS.sens[1]
  && sanitizeViewSettings({ adsSens: -5 }).adsSens === VIEW_LIMITS.adsSens[0],
  `${sanitizeViewSettings({ sens: 1e9 }).sens} / ${sanitizeViewSettings({ adsSens: -5 }).adsSens}`);
// 反证臂②：这条红了 = 非法值被"整个丢掉"退成默认（那是另一个方向的错：玩家填错一位数就丢手感）
ok('A3【反证臂】不在范围里的数被**夹**而不是丢：2.9 原样、3.7 → 3.0（不是退回 1.0）',
  sanitizeViewSettings({ sens: 2.9 }).sens === 2.9 && sanitizeViewSettings({ sens: 3.7 }).sens === 3.0);
ok('A4 NaN / 字符串 / 缺失三种都退默认（Number.isFinite 那一关，不是 typeof）',
  sanitizeViewSettings({ sens: NaN }).sens === 1.0
  && sanitizeViewSettings({ sens: 'x' }).sens === 1.0
  && sanitizeViewSettings({}).sens === 1.0);
ok('A5 invertY 只认 true（0 / "1" / undefined 一律 false —— 它是个开关，不是真值搬运）',
  sanitizeViewSettings({ invertY: 1 }).invertY === false
  && sanitizeViewSettings({ invertY: 'true' }).invertY === false
  && sanitizeViewSettings({ invertY: true }).invertY === true);
ok('A6 客户端那一半（viewSettingsOf）照抄 game.settings 的三个字段，不做判断',
  (() => { const s = { sens: 2.4, adsSens: 1.2, invertY: true };
    const v = viewSettingsOf({ settings: s });
    return v.sens === 2.4 && v.adsSens === 1.2 && v.invertY === true; })());
// 反证臂③：两处**成对**——客户端交的、服务端收的必须指同一组名字。改一处名字的症状是
// "这个设置项在服务端永远是默认值"，而那看起来像"这个功能没做"。
ok('A7【反证臂】客户端交出去的那份能被服务端原样吃下（字段名对不上就会在这里红）',
  (() => { const v = viewSettingsOf({ settings: { sens: 2.4, adsSens: 1.2, invertY: true } });
    const r = sanitizeViewSettings(v);
    return r.sens === 2.4 && r.adsSens === 1.2 && r.invertY === true; })());

// ═══════════════════════════════════════════════════════════════════════════
sec('B. H1 权威端：一个房间里两个人各自的手感（这是审计里那句"每人一份"）');
// ═══════════════════════════════════════════════════════════════════════════
const room = new NetRoom({ id: 'audit-h1', mapId: 'yard', seed: 20261001 });
await room.start();
const A = room.addClient({ name: '甲', team: 'A', view: { sens: 3.0, adsSens: 1.5, invertY: false } });
const B = room.addClient({ name: '乙', team: 'B', view: { sens: 0.5, adsSens: 0.9, invertY: false } });
const C = room.addClient({ name: '丙', team: 'A' });      // 第 3 人：**不带 view**（老客户端那条路）

ok('B1【先决】两个人的 sens 真的不同（相同的話下面"转向速率不同"量的是空气）',
  A.pl.sens === 3.0 && B.pl.sens === 0.5, `甲 ${A.pl.sens} / 乙 ${B.pl.sens}`);
ok('B2【先决】房间唯一的那份 game.settings 没被任何人改掉（改它就是"先来的人动后来者的手感"）',
  room.game.settings.sens === 1.0, `game.settings.sens=${room.game.settings.sens}`);
ok('B3 没带 view 的那个人：pl.sens 保持 null（走 fallback，不是被写成 1.0）',
  C.pl.sens === null && C.pl.adsSens === null && C.pl.invertY === null);

// 同一拍、同一条输入发给三个人。mdx 是"这一拍的鼠标位移"。
let tick = 0;
const push = (cid, mdx, mdy = 0) => {
  tick = (tick + 1) & 0xffff;
  room.applyInput(cid, { keys: 0, buttons: 0, mdx, mdy, tick, view: 0, streak: 255 });
};
const MDX = 10;
const y0 = { A: A.pl.yaw, B: B.pl.yaw, C: C.pl.yaw };
push(A.cid, MDX); push(B.cid, MDX); push(C.cid, MDX);
room.step();

const dA = A.pl.yaw - y0.A, dB = B.pl.yaw - y0.B, dC = C.pl.yaw - y0.C;
const k = 0.0022;                                     // _sim 里那个常数（js/player.js:267）
ok('B4 甲（sens 3.0）这一拍转过的角度 = mdx × 3.0 × 0.0022 —— 权威端用的是**他自己**的 sens',
  near(dA, -MDX * 3.0 * k, 1e-12), `Δyaw=${dA.toFixed(9)} 期望 ${(-MDX * 3.0 * k).toFixed(9)}`);
ok('B5 乙（sens 0.5）同一拍只转 1/6 那么多 —— 两个人的手感在**同一个房间**里互不影响',
  near(dB, -MDX * 0.5 * k, 1e-12) && near(dA / dB, 6, 1e-9),
  `Δ甲/Δ乙 = ${(dA / dB).toFixed(6)}`);
ok('B6 丙（没带 view）落回 game.settings.sens = 1.0（与改动前的读数逐位相同）',
  near(dC, -MDX * 1.0 * k, 1e-12), `Δyaw=${dC.toFixed(9)}`);
// ── 这一节的命门 ──
// 改动前（服务端拿硬编码 1.0）三个人的 Δyaw 会**完全相等**，因为 sens 只有 game.settings 一个来源。
// 所以这条断言的就是"三份读数不该相等"。
ok('B7【反证臂】三个人的 Δyaw 两两不同（改动前这里三个人会一模一样 = 灵敏度根本没进协议）',
  !near(dA, dB, 1e-6) && !near(dA, dC, 1e-6) && !near(dB, dC, 1e-6),
  [dA, dB, dC].map(v => v.toFixed(6)).join(' / '));

// ADS：开镜时乘 adsSens —— 每人一份要连这一条一起换（只换 sens 会让开镜手感错位）。
//
// 比法：**把两个人的腰射灵敏度先摆平**（都设成 1.0），于是开镜那一拍转向量的差别
// 只可能来自各自那份 adsSens。不直接去算 `adsSens / zoom^0.85` 的期望值 ——
// zoom 是枪自己的一格、在 sim 里随 adsT² 插值，判据这边重算一遍就是"拿一个我自己
// 也说不准的中间量去对答案"（本仓库吃过这个亏：量具的错被读成被测对象的错）。
A.pl.sens = 1.0; B.pl.sens = 1.0;
ok('B8a【先决】甲乙用的是同一把起始武器（不同枪的 zoom 不同，比 adsSens 就没意义）',
  !!A.pl.ws.w && !!B.pl.ws.w && A.pl.ws.w.id === B.pl.ws.w.id,
  `${A.pl.ws.w && A.pl.ws.w.id} / ${B.pl.ws.w && B.pl.ws.w.id}`);
A.pl.ws.adsT = 1; B.pl.ws.adsT = 1;
const yA1 = A.pl.yaw, yB1 = B.pl.yaw;
push(A.cid, MDX); push(B.cid, MDX);
room.step();
const adsA = A.pl.yaw - yA1, adsB = B.pl.yaw - yB1;
ok('B8 腰射摆平之后，开镜转向的差别只来自各自那份 adsSens：|Δ甲/Δ乙| = 1.5/0.9',
  near(Math.abs(adsA / adsB), 1.5 / 0.9, 1e-6), `${(adsA / adsB).toFixed(9)}（期望 ${(1.5 / 0.9).toFixed(9)}）`);
ok('B9【反证臂】这个比值不为 1（恒为 1 就说明开镜那一支根本没读 adsSens，甲乙用的是同一份）',
  Math.abs(Math.abs(adsA / adsB) - 1) > 1e-6, `|比值| = ${Math.abs(adsA / adsB).toFixed(9)}`);
// 反证臂②：把甲那份 adsSens 就地改成与乙相同再量一次，比值必须退到 1 ——
// 这条红了 = B8 量的是"某个恰好等于 1.5 的常量"，而不是这个人身上那一格。
{
  const keep = A.pl.adsSens;
  A.pl.adsSens = 0.9;
  const yA2 = A.pl.yaw, yB2 = B.pl.yaw;
  push(A.cid, MDX); push(B.cid, MDX);
  room.step();
  const r2 = Math.abs((A.pl.yaw - yA2) / (B.pl.yaw - yB2));
  A.pl.adsSens = keep;
  ok('B9b【反证臂】把甲那份 adsSens 改成与乙相同，比值当场退到 1（它读的是那一格，不是常量）',
    near(r2, 1, 1e-6), `${r2.toFixed(9)}`);
}
A.pl.ws.adsT = 0; B.pl.ws.adsT = 0;

// invertY：每人一份。这里比的是**符号**（同一条 mdy 在两个人身上方向相反）。
const inv = room.addClient({ name: '丁', team: 'B', view: { sens: 1.0, adsSens: 0.9, invertY: true } });
const pA = A.pl.pitch, pD = inv.pl.pitch;
push(A.cid, 0, 10); push(inv.cid, 0, 10);
room.step();
ok('B10 invertY 每人一份：同一条 mdy 在甲身上向上、在丁身上向下（方向相反）',
  Math.sign(A.pl.pitch - pA) === -Math.sign(inv.pl.pitch - pD)
  && Math.abs(inv.pl.pitch - pD) > 1e-9,
  `甲 ${(A.pl.pitch - pA).toFixed(9)} / 丁 ${(inv.pl.pitch - pD).toFixed(9)}`);
// 反证臂：丙（没带 view，落回 game.settings.invertY=false）必须与甲同向 ——
// 这条红了 = fallback 被写成了常量 true/false 而不是读房间那份。
const pC = C.pl.pitch;
push(C.cid, 0, 10);
room.step();
ok('B11【反证臂】没带 view 的人跟着房间默认走（与甲同向），不是被硬写成反向',
  Math.sign(C.pl.pitch - pC) === Math.sign(A.pl.pitch - pA),
  `丙 ${(C.pl.pitch - pC).toFixed(9)}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('C. H1 客户端：join 帧真的把这一份交出去了（行为，不是"源码里有没有那个字段"）');
// ═══════════════════════════════════════════════════════════════════════════
// NetClient 在 Node 里能原样跑（server/browser-shim.mjs 补了它碰的那半套环境）。
// 这里把全局 WebSocket 换成一个**只记 send** 的桩：connect() 的握手体是同步的，
// 所以拿到实例之后手工触发 onopen 就能读到它发出的第一帧 —— 不发真包，也不起服务器。
const sent = [];
class FakeWS {
  constructor(url) { this.url = url; FakeWS.last = this; }
  send(s) { sent.push(typeof s === 'string' ? s : '[binary]'); }
}
const RealWS = globalThis.WebSocket;
globalThis.WebSocket = FakeWS;
const cgame = { settings: { sens: 2.4, adsSens: 1.2, invertY: true } };
const nc = new NetClient(cgame, { url: 'ws://audit/ws', name: '甲' });
nc.connect();
FakeWS.last.onopen();
const joinFrame = (() => { try { return JSON.parse(sent[0] || ''); } catch { return null; } })();
ok('C1【先决】客户端真的发了 join 帧，而且它带上了 view（不带的话下面两条无从谈起）',
  !!joinFrame && joinFrame.t === 'join' && !!joinFrame.view, JSON.stringify(sent[0] || '').slice(0, 120));
// ⚠ 这一条必须**报红**而不是抛：`joinFrame.view` 不存在时 "Cannot read properties of
// undefined" 会让整个判据崩掉，而崩掉不是判决（本仓库把这一类叫"异常不是判决"）。
ok('C2 join 帧里的 view 就是 game.settings 那三个数（不是硬编码、不是另一份默认值）',
  !!joinFrame?.view && joinFrame.view.sens === 2.4 && joinFrame.view.adsSens === 1.2 && joinFrame.view.invertY === true,
  JSON.stringify(joinFrame && joinFrame.view));
// 反证臂：改一下设置再连一次，帧里的数必须跟着变 —— 这条红了 = 那一格是从别处抄的常量
sent.length = 0;
const cgame2 = { settings: { sens: 0.6, adsSens: 0.3, invertY: false } };
const nc2 = new NetClient(cgame2, { url: 'ws://audit/ws', name: '乙' });
nc2.connect(); FakeWS.last.onopen();
const jf2 = (() => { try { return JSON.parse(sent[0] || ''); } catch { return null; } })();
ok('C3【反证臂】换一份设置再连，帧里的数跟着换（证明它读的是设置，不是抄的常量）',
  !!jf2?.view && jf2.view.sens === 0.6 && jf2.view.adsSens === 0.3 && jf2.view.invertY === false,
  JSON.stringify(jf2 && jf2.view));
globalThis.WebSocket = RealWS;

// ═══════════════════════════════════════════════════════════════════════════
sec('D. H2 fanout：事件必须穿过背压闸（它不可再生，快照可再生）');
// ═══════════════════════════════════════════════════════════════════════════
// 假 ws：记下收到的每一帧以及它的类型。bufferedAmount 由测试直接摆 ——
// 真实积压要靠把内核缓冲灌满（上百 KB × 每秒 1 KB），既慢又不稳；这条纪律的形状
// （发什么、按什么次序、跳什么）与"这个数从哪来"无关，所以直接摆。
const LIMIT = 262144;
const mkConn = (cid, buffered, readyState = 1) => {
  const got = [];
  return {
    cid, __stall: false, got,
    ws: { readyState, bufferedAmount: buffered, send: (d, o) => got.push({ d, bin: !!(o && o.binary) }) },
  };
};
const buf = Buffer.from([1, 2, 3]);
const EV = JSON.stringify({ t: 'ev', tick: 7, ev: [{ e: 'respawn', cid: 1 }] });
const mkRoom = (...cs) => ({ id: 'D', clients: new Map(cs.map(c => [c.cid, c])) });

// ① 量具自证：一条正常连接必须两样都收到（否则下面"没收到快照"可能只是采集器坏了）
{
  const h = mkConn(1, 0);
  const r = mkRoom(h);
  const out = fanout(r, EV, buf, LIMIT);
  ok('D1【量具自证】健康连接两样都收到：事件在前、快照在后',
    h.got.length === 2 && h.got[0].d === EV && h.got[0].bin === false
    && h.got[1].d === buf && h.got[1].bin === true,
    `收到 ${h.got.length} 帧：${h.got.map(g => g.bin ? '快照' : '事件').join('→')}`);
  ok('D2【量具自证】没积压就不该记 netDrops（计数非零会让 /healthz 长红）',
    (out.drops | 0) === 0 && (r.__netDrops | 0) === 0, `drops=${out.drops}`);
}
// ② 这一节的命门：积压的连接**仍然**要收到事件
{
  const s = mkConn(1, LIMIT + 1);
  const h = mkConn(2, 0);
  const r = mkRoom(s, h);
  const out = fanout(r, EV, buf, LIMIT);
  ok('D3【命门】积压超限的连接仍然收到 `ev` 帧（改动前这里 0 帧 —— 窗口里的事件永久丢）',
    s.got.some(g => g.d === EV && g.bin === false),
    `收到 ${s.got.length} 帧：${s.got.map(g => g.bin ? '快照' : '事件').join('→') || '（空）'}`);
  ok('D4 但它**跳过**快照（闸门本身没被拆掉：卡死的连接照样不许把进程内存吃穿）',
    !s.got.some(g => g.bin === true), `积压 ${LIMIT + 1} B`);
  ok('D5 同一拍里健康的邻居照旧两样都收 —— 一条卡死的连接不许影响别人',
    h.got.length === 2 && h.got[0].d === EV && h.got[1].d === buf);
  ok('D6 这次跳过被数出来了，落在房间身上（进 /healthz 的 netDrops，运维要能先看见）',
    out.drops === 1 && r.__netDrops === 1, `drops=${out.drops} __netDrops=${r.__netDrops}`);
  ok('D7 边沿旗挂在**这一条连接**上（c.__stall），不是房间上：日志才不会把"一屋子人都在卡"印成一个人',
    s.__stall === true && h.__stall === false && out.stalls.length === 1 && out.stalls[0].cid === 1,
    JSON.stringify(out.stalls));
}
// ③ 反证臂：没有事件的那一拍，积压的连接必须一帧都收不到。
// 这条红了 = D3 是恒真绿灯（比如 fanout 无条件发了一份东西给所有人）。
{
  const s = mkConn(1, LIMIT + 1);
  const r = mkRoom(s);
  const out = fanout(r, null, buf, LIMIT);
  ok('D8【反证臂】这一拍没有事件（evMsg=null）时，积压的连接收到 0 帧 —— D3 不是"见谁都发"',
    s.got.length === 0 && out.drops === 1, `收到 ${s.got.length} 帧`);
}
// ④ 恢复：积压排空之后快照要回来，边沿旗也要复位（否则下一次积压不再留痕）
{
  const s = mkConn(1, LIMIT + 1);
  const r = mkRoom(s);
  fanout(r, EV, buf, LIMIT);                      // 第一拍：首次积压，stall 立起
  const first = fanout(r, EV, buf, LIMIT);        // 第二拍：仍在积压，但**不该再报一次**
  s.ws.bufferedAmount = 0;
  const third = fanout(r, EV, buf, LIMIT);        // 第三拍：排空了
  ok('D9 持续积压只留一次痕迹（边沿记，不刷屏）：第二拍的 stalls 是空的，drops 照旧累加',
    first.stalls.length === 0 && first.drops === 1 && r.__netDrops === 2,
    `第二拍 stalls=${first.stalls.length} drops=${first.drops} __netDrops=${r.__netDrops}`);
  ok('D10 排空之后快照回来了，边沿旗复位（再一次积压会重新留痕）',
    third.drops === 0 && s.__stall === false && s.got.filter(g => g.bin).length === 1,
    `收到快照 ${s.got.filter(g => g.bin).length} 份`);
}
// ⑤ 关掉的连接整条跳过（连事件也不发 —— 它的 readyState 已经不是 1）
{
  const dead = mkConn(1, 0, 3);
  const r = mkRoom(dead);
  const out = fanout(r, EV, buf, LIMIT);
  ok('D11 readyState ≠ 1 的连接整条跳过（发过去会抛，而抛在广播循环里会打断后面的人）',
    dead.got.length === 0 && out.drops === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
sec('E. M1 上行鼠标位移：量程按角速度折算，且本地预测用**上行的那一个数**');
// ═══════════════════════════════════════════════════════════════════════════
// 两个错必须分别量：①量程太窄（327.67 计数/拍，高 DPI 甩枪必被削）；
// ②本地拿全量积分、线上拿钳后值积分（哪怕量程够宽，只要本地用的不是那个数，
//   快照 20Hz 覆盖回来就是橡皮筋）。②的判据在 E4/E5。
const wire = (v) => decodeInput(encodeInput({ tick: 1, mdx: v, mdy: 0, keys: 0, buttons: 0, seq: 0, view: 0, streak: -1 })).mdx;
ok('E1【先决】i16 放得下这个上限（放不下的话下面"5000 被夹到 1000"读到的是溢出后的怪值）',
  LOOK_CODE_MAX <= 32767 && LOOK_CODE_MAX === 32000, `LOOK_CODE_MAX=${LOOK_CODE_MAX}`);
// ── 命门①：量程 ──
ok('E2 一次大甩枪（900 计数/拍）能原样上去 —— 改动前它会被削到 327.67',
  wire(900) === 900 && wire(-900) === -900, `900 → ${wire(900)}（改动前 327.67）`);
ok('E3 超上限的值被夹到 LOOK_MAX **计数**，不是夹到格数（夹错单位会塌成 31.25，比改动前还小十倍）',
  wire(5000) === 1000 && wire(-1e6) === -1000, `5000 → ${wire(5000)} · -1e6 → ${wire(-1e6)}`);
// ── 命门②：本地预测用的必须是上行那一个数 ──
// 注意这里**不能**写成 `roundLook(v) === wire(v)`：roundLook 的定义就是 unpack(pack(v))，
// 而 wire 是同一个东西走一趟编码解码 —— 那是同义反复（本仓库点名要防的形状）。
// 真正会分家的两处是：①格子上的值是不是逐位回来（步长漂一点就会出现 ULP 级差异，
// 而 ULP 级差异在这里已经制造过两次假红）；②客户端 recordInput 有没有真的动那一份输入。
ok('E4 格子上的值逐位原样回来（步长必须是二进制可精确表示的那种数：1/32 是，0.01 不是）',
  [0, 0.03125, 1, 12.5, -0.40625, 1000].every(v => roundLook(v) === v)
  && roundLook(roundLook(3.7)) === roundLook(3.7),
  `0.03125 → ${roundLook(0.03125)}（换成 0.01 的步长这里会读到 0.03）`);
ok('E5【反证臂】量化真的发生了：3.7 不在格子上，它必须被挪到最近那一格（位移 ≤ 半格）',
  roundLook(3.7) !== 3.7 && Math.abs(roundLook(3.7) - 3.7) <= LOOK_STEP / 2,
  `3.7 → ${roundLook(3.7)}（误差 ${Math.abs(roundLook(3.7) - 3.7).toFixed(6)} ≤ ${LOOK_STEP / 2}）`);
ok('E6 量化误差不超过半格（这是"精度那一半"的上界；超了说明步长写错了）',
  [0.13, -7.77, 481.03, 1000].every(v => Math.abs(roundLook(v) - Math.min(LOOK_MAX, Math.max(-LOOK_MAX, v))) <= LOOK_STEP / 2 + 1e-12));
// NetClient.recordInput 就地改那一份 input（main.js 的顺序是 recordInput → pl.update(同一个对象)，
// 所以本地预测与日记本里存的都跟着变）。这一条量的是"它真的改了"，不是"源码里有那一行"。
{
  const c = new NetClient({ settings: { sens: 1, adsSens: 1, invertY: false } }, { url: 'ws://audit/ws' });
  const inp = { fire: false, firePressed: false, mdx: 3.7, mdy: -0.13, streak: -1 };
  c.recordInput(1, inp);
  ok('E7 客户端本地预测用的就是上行那个数（recordInput 就地量化了 mdx/mdy）',
    inp.mdx === roundLook(3.7) && inp.mdy === roundLook(-0.13) && inp.mdx === wire(3.7),
    `mdx ${inp.mdx}（原始 3.7）· mdy ${inp.mdy}`);
  // 反证臂：非数不许被改成 NaN（调用方可能手工拼一份输入；NaN 进 sim 会污染 yaw）
  const inp2 = { fire: false, firePressed: false, mdx: undefined, mdy: NaN, streak: -1 };
  c.recordInput(2, inp2);
  ok('E8【反证臂】没带 mdx/mdy 的输入不被改成 NaN（手工拼的输入与 ENDING_INPUT 那条路）',
    inp2.mdx === undefined && Number.isNaN(inp2.mdy), JSON.stringify({ mdx: inp2.mdx, mdy: String(inp2.mdy) }));
}

// ═══════════════════════════════════════════════════════════════════════════
sec('F. M3 名字不是身份：kill 事件与"谁是谁"一律先认 cid');
// ═══════════════════════════════════════════════════════════════════════════
// 访客服上重名是常态（不填呼号都叫"访客"，自报呼号也没有唯一性约束）。
// 下游有两处把这事件当身份用：pts/tags 的配对、客户端判"死的是不是我"。
// 只按名字配的形状不是"提示错行"这么轻 —— 两台机器会同时弹死亡画面。
const r3 = new NetRoom({ id: 'audit-m3', mapId: 'yard', seed: 99 });
const stepN = (rm, n) => { for (let i = 0; i < n; i++) rm.step(); };
await r3.start();
const X1 = r3.addClient({ name: '访客', team: 'A' });
const X2 = r3.addClient({ name: '访客', team: 'B' });
const K1 = r3.addClient({ name: '刺客', team: 'A' });
ok('F1【先决】两个同名的人在同一个房间里（不同名的话下面每一条都在量空气）',
  X1.pl.name === X2.pl.name && X1.cid !== X2.cid,
  `${X1.pl.name} ×2 · cid ${X1.cid}/${X2.cid}`);

// 同拍两杀：一个爆头、一个不爆头，受害者恰好同名 —— 配对错就会交叉。
r3.events.length = 0;
r3.rules.resetChains();
r3.game.onKill(K1.pl, X1.pl, 'ak', true, {});
r3.game.onKill(K1.pl, X2.pl, 'ak', false, {});
stepN(r3, 1);
const kills = r3.events.filter(e => e.e === 'kill');
const evOf = (cid) => kills.find(e => e.victimCid === cid);
// 取不到那条事件时交回空表 / null，**不许抛**：判决是"报红"，不是"异常"。
// （第一版这里直接 evOf(...).tags ---- 负对照一跑就 TypeError，那条输出不是判决。）
const tagsOf = (cid) => { const e = evOf(cid); return e && Array.isArray(e.tags) ? e.tags : []; };
const ptsOf = (cid) => { const e = evOf(cid); return e ? e.pts : null; };
ok('F2 kill 事件带上了双方 cid（权威端在 onKill 里补的 —— 它手上正好有那两个对象）',
  kills.length === 2 && !!evOf(X1.cid) && !!evOf(X2.cid) && evOf(X1.cid).killerCid === K1.cid,
  JSON.stringify(kills.map(e => `${e.killer}(${e.killerCid})→${e.victim}(${e.victimCid})`)));
// ── 这一节的命门 ──
ok('F3 奖章按 cid 配对：爆头那一条落在 X1 头上、X2 那一条不带 head（同名不串）',
  tagsOf(X1.cid).includes('head') && !tagsOf(X2.cid).includes('head') && ptsOf(X1.cid) !== 0,
  JSON.stringify(kills.map(e => `${e.victimCid}:${e.pts}:${(e.tags || []).join('+') || '-'}`)));
// ⚠ 关于 F3 的反证臂，实跑过的结论要写在这儿（不然下一个人会以为它有臂）：
// 把配对退回"只按名字"（负对照 namepair）时，F3 **仍然是绿的** —— 因为今天两条队列
// （game.events 与 killExtra）是同步推进的，`findIndex` 按名字找在同名同序时正好命中同一条。
// 也就是说 F3 在正常路径上量不出 byCid 与按名字的差别。它真正声称的性质是**配对不靠顺序**，
// 那就得造出"顺序不一致"来量它 —— 见紧跟其后的 F3b（那一臂实跑是红的）。
// F3 本身留着当"正常路径没坏"的哨兵：它红的时候是事件没带 cid（回填丢了 / 下发抹了）。
ok('F4 死的是 X1 与 X2，K1 没被排重生队（只有被杀的两个人 respawnT > 0）',
  X1.dead === true && X2.dead === true && X1.respawnT > 0 && X2.respawnT > 0 && !K1.dead,
  JSON.stringify({ x1: X1.respawnT, x2: X2.respawnT, k: K1.respawnT }));
// 两个人的死亡数各记一次（账本身是按**对象**记的：vc.deaths++，与名字无关 ——
// 所以这一条不是反证臂，是顺手量的哨兵；真正会红的是上面 F4）。
ok('F5 双方的死亡数各记一次、击杀者 0 次',
  X1.deaths === 1 && X2.deaths === 1 && K1.deaths === 0,
  JSON.stringify({ x1: X1.deaths, x2: X2.deaths, k: K1.deaths }));

// ── F3b：配对的**反证臂**（构造错位）──
// 真实成因是"两条队列迟早不同步"：唯一已知的错位口在 onKill 顶部那句
// `if (this.matchOverSent) return` —— 蜂鸣之后的那一杀 sim 照样把事件推出来，
// 而 killExtra 不再追加，从那一刻起两条队列差一格。今天这条路径上量不到差别（见 F3 的注），
// 所以这里把这份差异**直接摆出来**：把 killExtra 的两条对调再走一次 drainKillFeed。
// 按 cid 配 ⇒ 各归各；按名字配 ⇒ 甲的爆头记到乙头上。这一条实跑会红（负对照见文件末尾注释）。
const r4 = new NetRoom({ id: 'audit-m3b', mapId: 'yard', seed: 77 });
await r4.start();
const Y1 = r4.addClient({ name: '访客', team: 'A' });
const Y2 = r4.addClient({ name: '访客', team: 'B' });
const K2 = r4.addClient({ name: '刺客', team: 'A' });
r4.events.length = 0;
r4.killExtra.length = 0;
r4.game.onKill(K2.pl, Y1.pl, 'ak', true, {});       // Y1：爆头（pts 高、带 head）
r4.game.onKill(K2.pl, Y2.pl, 'ak', false, {});      // Y2：不爆头
const e4 = (cid) => r4.events.find(e => e.e === 'kill' && e.victimCid === cid);
r4.killExtra.reverse();                             // ← 构造的对调
r4.step();
const t4 = (cid) => { const e = e4(cid); return e && Array.isArray(e.tags) ? e.tags : []; };
// 判别量只取"爆头那一枚落在谁头上"：pts 在这里不是好读数 —— 两条击杀的分值取决于
// 距离与连杀，恰好可以相等（我第一版拿 `pts 甲 > pts 乙` 当判据，实跑读到 200/200 假红）。
ok('F3b【反证臂】两条队列错位时奖章仍各归各（配对认 cid，不认顺序也不认名字）',
  !!e4(Y1.cid) && !!e4(Y2.cid) && t4(Y1.cid).includes('head') && !t4(Y2.cid).includes('head'),
  JSON.stringify(r4.events.filter(e => e.e === 'kill').map(e => `${e.victimCid}:${(e.tags || []).join('+') || '-'}`)));

// 反证臂②：**没有 cid 的时候名字兜底那条路还活着**。Bot 没有 cid（也不在 byPlayer 里），
// 所以 Bot 杀 Bot 走的就是名字那一支 —— 那条路要是死了，bot 之间的击杀会丢奖章。
const bA = r3.spawnBot({ name: '同名', team: 'A', skill: 1 });
const bB = r3.spawnBot({ name: '同名', team: 'B', skill: 1 });
r3.events.length = 0;
r3.rules.resetChains();
r3.game.onKill(bA, bB, 'ak', true, {});
stepN(r3, 1);
const botKill = r3.events.find(e => e.e === 'kill');
ok('F6【反证臂】双方都没有 cid（Bot 杀 Bot）时退回名字，奖章照旧配得上（兜底那一支没死）',
  !!botKill && botKill.victimCid === null && botKill.killerCid === null
  && Array.isArray(botKill.tags) && botKill.tags.includes('head') && botKill.pts > 0,
  JSON.stringify(botKill && { vc: botKill.victimCid, pts: botKill.pts, tags: botKill.tags }));

// ── 客户端那半边：判"死的是不是我" ──
const cEvents = [];
const cgameF = {
  player: { name: '访客', team: 'A' },
  hud: { popup() {}, announce() {}, killfeed() {}, highAlert() {} },
  audio: { say() {}, beep() {}, hit() {} },
  onNetDeath: () => cEvents.push('death'),
  onNetKill: () => cEvents.push('kill'),
};
const ncF = new NetClient(cgameF, { url: 'ws://audit/ws' });
ncF.cid = 7;
// ① 同名的**别人**死了（victimCid 不是我）⇒ 不许弹死亡画面
ncF.onEvents({ ev: [{ e: 'kill', killer: '刺客', killerCid: 9, victim: '访客', victimCid: 8, weapon: 'ak', head: false, tags: [] }] });
ok('F7 同名的别人死了：victimCid 不是我就**不弹**死亡画面（按名字判会两台机器一起弹）',
  !cEvents.includes('death') && cEvents.includes('kill'),
  JSON.stringify(cEvents));
// ② 我自己死了（victimCid === 我的 cid）⇒ 必须弹
cEvents.length = 0;
ncF.onEvents({ ev: [{ e: 'kill', killer: '刺客', killerCid: 9, victim: '访客', victimCid: 7, weapon: 'ak', head: false, tags: [] }] });
ok('F8 我死了（victimCid === 我的 cid）：死亡画面照常弹', cEvents.includes('death'), JSON.stringify(cEvents));
// 反证臂③：事件里**没有** cid（老服务端）时名字兜底仍然要判出"是我" ——
// 这条红了 = 兜底被删掉了，老客户端会永远不弹死亡画面（比串人更糟）。
cEvents.length = 0;
ncF.onEvents({ ev: [{ e: 'kill', killer: '刺客', victim: '访客', weapon: 'ak', head: false, tags: [] }] });
ok('F9【反证臂】事件没带 cid 时退回名字判"是我"（老服务端那条路不许被删掉）',
  cEvents.includes('death'), JSON.stringify(cEvents));

// ── 表现侧（killfeed / 死亡镜头）那一半：js/net/identity.mjs ──
const remotes = new Map([[8, { name: '访客', team: 'B' }], [9, { name: '刺客', team: 'B' }]]);
const ctx = { myCid: 7, myName: '访客', myTeam: 'A', remotes };
const evSame = { killer: '刺客', killerCid: 9, victim: '访客', victimCid: 8 };
const idSame = killfeedIdent(evSame, ctx);
ok('F10 同名者在场时：`isPlayer` 只对 cid 命中的那个为真（按名字判会把我自己认成死者）',
  idSame.victim.isPlayer === false && idSame.killer.isPlayer === false && idSame.victim.team === 'B',
  JSON.stringify({ v: idSame.victim, k: idSame.killer }));
const idMine = killfeedIdent({ killer: '刺客', killerCid: 9, victim: '访客', victimCid: 7 }, ctx);
ok('F11 victimCid 指向我时才是"我死了"，队伍也按我的队算（A，不是同名那个 B）',
  idMine.victim.isPlayer === true && idMine.victim.team === 'A', JSON.stringify(idMine.victim));
// 反证臂：cid 拿得到、但 remotes 里暂时查不到这个人（刚进来、快照还没到）时**不许退回名字** ——
// 退回名字就会把同名的另一个人当成他（队伍颜色错、死亡镜头指错方向），那正是这条纪律要防的形状。
// 第一版实现就是错的（`r || findByName(...)`），这一条是当场抓它的那一条。
ok('F11b【反证臂】cid 拿得到却查不到人时队伍留空，不退回同名那个（退回 = 同名者互相冒充）',
  killfeedIdent({ killer: '刺客', killerCid: 9, victim: '访客', victimCid: 99 }, ctx).victim.team === null
  && killfeedIdent({ killer: '刺客', killerCid: 9, victim: '访客', victimCid: 99 }, ctx).victim.isPlayer === false,
  JSON.stringify(killfeedIdent({ killer: '刺客', killerCid: 9, victim: '访客', victimCid: 99 }, ctx).victim));
ok('F12 击杀播报的"这一杀是我拿的吗"同样认 cid（按名字会把同名的别人的击杀算成我的）',
  killfeedIdent({ killer: '访客', killerCid: 8, victim: '某人', victimCid: 9 }, ctx).killer.isPlayer === false
  && killfeedIdent({ killer: '访客', killerCid: 7, victim: '某人', victimCid: 9 }, ctx).killer.isPlayer === true);
ok('F13 死亡镜头按 cid 找到正确的那个人（不转向同名的另一个）',
  killerRemote(evSame, ctx) === remotes.get(9) && killerRemote(evSame, ctx).name === '刺客');
// 反证臂④：没有 cid 时按名字找（老服务端）；找不到就交回 null —— 那条路只有沉镜头，
// **指一个假方向比不指更糟**，所以这一条也要有一个会红的臂。
ok('F14【反证臂】没有 cid 时按名字找；查无此人交回 null（不猜一个假方向）',
  killerRemote({ killer: '刺客', victim: '访客' }, ctx) === remotes.get(9)
  && killerRemote({ killer: '哨戒机枪', victim: '访客' }, ctx) === null);

// ═══════════════════════════════════════════════════════════════════════════
sec('G. M2 输入队列溢出：溢出时丢**最旧**的那一拍，且丢了多少要数得出来');
// ═══════════════════════════════════════════════════════════════════════════
// 症状是"我松了手他还在走"：一次突发（后台标签页恢复 / TCP 零窗恢复后操作系统把攒下的
// 报文一起吐出来）能一次塞进几百条，而服务端一步只消费一条。改动前的形状是
// `if (q.length < 60) push` —— 留在队里的是这次突发的**最旧** 60 拍，接下来整整一秒里
// 屏幕上的人还在按好几秒前的输入走。丢最旧则相反：队里始终是**最新**的 60 拍。
// 两边都要付出"中间几拍从没被模拟过"的代价，但代价落在哪一边有对错。
const r5 = new NetRoom({ id: 'audit-m2', mapId: 'yard', seed: 5 });
await r5.start();
const Q = r5.addClient({ name: '甲', team: 'A' });
const feed = (from, count) => {
  for (let i = 0; i < count; i++) {
    r5.applyInput(Q.cid, { tick: from + i, mdx: 0, mdy: 0, keys: 0, buttons: 0, view: 0, streak: 0xff });
  }
};
// 先决：健康路径（10 拍，远不到上限）不许丢 —— 否则 qDrop 是个恒亮的灯，没人会再看它。
feed(1, 10);
ok('G1【先决】10 拍进队一条没丢（qDrop 只在真的溢出时才动）',
  Q.q.length === 10 && r5.qDrop === 0, `队列 ${Q.q.length} · qDrop ${r5.qDrop}`);
// ── 命门：留下来的是**最新**的那一批 ──
feed(11, 90);                                  // 累计 100 拍，上限 60 ⇒ 必须挤掉 40 拍
const ticks = Q.q.map(x => x.tick);
ok('G2【命门】溢出丢的是**最旧**的拍：队里留下第 41…100 拍（改动前留下的是第 1…60 拍）',
  Q.q.length === INPUT_QUEUE && ticks[0] === 41 && ticks[ticks.length - 1] === 100,
  `队首 ${ticks[0]} · 队尾 ${ticks[ticks.length - 1]} · 长度 ${Q.q.length}（上限 ${INPUT_QUEUE}）`);
ok('G3 丢了多少拍被数出来了（这个数进 /healthz 的 per[].qDrop；玩家侧那条"手感怪"的投诉只能靠它定位）',
  r5.qDrop === 40, `qDrop=${r5.qDrop}`);
// 反证臂的对照臂：**继续塞**时旧读数不许被重置、也不许停止累加（一步一挤 = 一步一条）。
feed(101, 5);
ok('G4 继续溢出时计数继续累加、窗口仍然是**滑动**的（老读数不清零）',
  r5.qDrop === 45 && Q.q[0].tick === 46 && Q.q[Q.q.length - 1].tick === 105 && Q.q.length === INPUT_QUEUE,
  `qDrop=${r5.qDrop} · ${Q.q[0].tick}…${Q.q[Q.q.length - 1].tick}`);
ok('G5 队列长度永远不超上限（内存闸门没被这次改动拆掉）',
  Q.q.length === INPUT_QUEUE && INPUT_QUEUE === 60, `长度 ${Q.q.length}`);

// ═══════════════════════════════════════════════════════════════════════════
sec('H. M9 大厅层：断线出口与"这一帧到底发出去了吗"');
// ═══════════════════════════════════════════════════════════════════════════
// 这一层原先的失效形状全是"不报错、只是没反应"：`onclose` 一个回调都不发（房表不再刷、
// 按钮静默失灵、"正在进入大厅…"在已经断线时继续撒谎），`send()` 在 readyState≠1 时静默丢帧
// （"创建房间"那一帧没了 ⇒ onRoomFrame 与 onlineError 都不会来 ⇒ 全屏加载层永久卡死，
// 唯一出路 F5）。所以这里的判据都要回答"谁被通知了 / 这一帧到底发出去没有"。
//
// 用一个**假 WebSocket** 驱动，不碰真网络：这一段量的是 LobbyClient 的语义，不是传输。
// 假的那只在非 OPEN 时 `send` 会**抛 InvalidStateError**（浏览器就是这么做的）——
// 于是"静默丢帧"与"把异常原文糊到玩家脸上"两种坏法都会在这里露馅。
// 真的那条路上的可见行为（房表文案、点按钮会不会卡在加载层、重新连接）在
// test/net-drop.mjs 的 J 段用真浏览器量 —— 那半边 node 够不到。
{
  class FakeWS {
    constructor() {
      this.readyState = 0; this.sent = []; this.closeCalls = 0;
      this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;
    }
    send(s) { if (this.readyState !== 1) throw new Error('InvalidStateError'); this.sent.push(JSON.parse(s)); }
    close() { this.closeCalls++; this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: '', wasClean: true }); }
    frame(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
  }
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  try {
    const game = {
      buildNetLoadout: () => null,
      profile: { classes: [{}], selClass: 0, streaks: null },
      settings: { sens: 1, adsSens: 0.9, invertY: false },
    };
    const mkLb = () => {
      const seen = { rooms: 0, room: 0, err: [], close: [], begin: 0 };
      const st = { settled: null };
      const lb = new LobbyClient(game, {
        url: 'ws://fake/ws',
        onRooms: () => seen.rooms++, onRoom: () => seen.room++,
        onError: (m) => seen.err.push(m), onClose: (i) => seen.close.push(i), onBegin: () => seen.begin++,
      });
      lb.connect().then(() => { st.settled = 'ok'; }, (e) => { st.settled = 'err:' + e.message; });
      return { lb, seen, st, ws: lb.ws };
    };

    // ── H1/H2 握手期 ──
    const A = mkLb();
    await Promise.resolve(); await Promise.resolve();
    ok('H1【先决】刚 connect() 时 socket 还在 CONNECTING、promise 也**没有**结算（这一格同时钉住"CONNECTING 也算已连上"那个低危项：算的话下面立刻就会 resolve）',
      A.ws.readyState === 0 && A.st.settled === null, `readyState=${A.ws.readyState} settled=${A.st.settled}`);
    let threw = null, r1, r2, r3;
    try { r1 = A.lb.createRoom({ room: 'x' }); r2 = A.lb.joinRoom('x'); r3 = A.lb.quickRoom({}); }
    catch (e) { threw = e.message; }
    ok('H2 还没 OPEN 时三处进房入口都**返回 false 而不是抛**（返回值才是调用方能判的东西；抛出去的 InvalidStateError 会被浏览器原文递给玩家），且一条帧都没发出去',
      threw === null && r1 === false && r2 === false && r3 === false && A.ws.sent.length === 0,
      `返回 ${r1}/${r2}/${r3} · sent=${A.ws.sent.length} · threw=${threw}`);

    // ── H3 反证臂：OPEN 之后同样三句必须发得出去（"返回 false"不许是恒返回 false）──
    A.ws.readyState = 1; A.ws.onopen();
    const base = A.ws.sent.length;
    const s1 = A.lb.createRoom({ room: 'x', title: 't' }), s2 = A.lb.joinRoom('x'), s3 = A.lb.quickRoom({});
    ok('H3【反证臂】OPEN 之后同样三句都返回 true 且真的上线了（否则 H2 那三条可以是"永远返回 false"的恒真绿灯）',
      s1 === true && s2 === true && s3 === true
      && A.ws.sent.slice(base).map(f => f.t).join(',') === 'createRoom,joinRoom,quickRoom',
      `返回 ${s1}/${s2}/${s3} · 发出的帧 ${A.ws.sent.slice(base).map(f => f.t).join(',')}`);

    A.ws.frame({ t: 'lobby', rooms: [], online: 0 });
    await Promise.resolve(); await Promise.resolve();
    ok('H4【先决】第一份清单到手才算"连上了"（下面 H5 起量的是"连上之后掉了"，前提得先成立）',
      A.lb.connected === true && A.st.settled === 'ok' && A.seen.rooms === 1,
      `connected=${A.lb.connected} settled=${A.st.settled} onRooms=${A.seen.rooms}`);

    // ── H5 命门：连上之后断线要有人知道 ──
    const nClose = A.seen.close.length;
    A.ws.readyState = 3; A.ws.onclose({ code: 1006, reason: 'boom', wasClean: false });
    ok('H5【命门】连上之后断开：onClose 恰好被调一次、lost/lostReason/connected 三格都落到位（改动前 onClose 一次都不会被调，房表就此静止）',
      A.seen.close.length === nClose + 1 && A.lb.lost === 'closed'
      && A.lb.connected === false && A.lb.lostReason === 'boom',
      `onClose=${A.seen.close.length} · lost=${A.lb.lost} · reason=${A.lb.lostReason}`);
    ok('H6 断线之后同一个 send() 变成 false（而不是抛）：大厅掉了的时候点按钮不该把异常糊到玩家脸上',
      A.lb.send({ t: 'ready', on: true }) === false, `sent=${A.ws.sent.length}`);
    ok('H7 而且 promise 的结局仍是"成功"（早就结算过的不许被一个不存在的错误再改一次 —— 那会变成一条没人接的 unhandled rejection）',
      A.st.settled === 'ok', String(A.st.settled));
    const nClose2 = A.seen.close.length;
    A.ws.onclose({ code: 1006, reason: 'again', wasClean: false });
    ok('H8 掉线是**边沿**不是电平：同一条连接再关一次不再通知（重复通知会把"重新连接"按两遍、把错误行刷两遍）',
      A.seen.close.length === nClose2 && A.lb.lostReason === 'boom', `onClose=${A.seen.close.length}`);

    // ── H9/H10 反证臂：另外两种"没连上"不许被说成"掉线" ──
    // 这两种各自对应屏幕上的一句不同的话。混成一句的症状：加载页上写着"连接已断开"，
    // 而真正的成因是 401/403（来源被拒、没登录）或服务没起 —— 玩家会去查网络。
    const B = mkLb();
    B.ws.readyState = 3; B.ws.onclose({ code: 1006, reason: 'never opened', wasClean: false });
    await Promise.resolve(); await Promise.resolve();
    ok('H9【反证臂】握手期就断（从没拿到过清单）：onClose **不许**被调，lost 保持 null —— "压根没连上"与"连上之后掉了"是两件事',
      B.seen.close.length === 0 && B.lb.lost === null, `onClose=${B.seen.close.length} lost=${B.lb.lost}`);
    ok('H10【反证臂】同一件事的另一半：那条路必须让 connect() 的 promise **reject**（原因由调用方写在加载页上，这是它唯一的出口）',
      typeof B.st.settled === 'string' && B.st.settled.startsWith('err:'), String(B.st.settled));

    // ── H11 反证臂：自己拆的不算掉线 ──
    const C = mkLb();
    C.ws.readyState = 1; C.ws.onopen(); C.ws.frame({ t: 'lobby', rooms: [], online: 0 });
    await Promise.resolve(); await Promise.resolve();
    C.lb.close();                                  // = leaveOnline() / 换台（onlineLobby 里拆旧连接）
    ok('H11【反证臂】自己 close() 的（返回主菜单、换到另一台）不许报"大厅连接已断开" —— 那是把正常操作说成故障',
      C.seen.close.length === 0 && C.lb.lost === null, `onClose=${C.seen.close.length} lost=${C.lb.lost}`);
  } finally { globalThis.WebSocket = realWS; }
}

// ═══════════════════════════════════════════════════════════════════════════
sec('I. M10 转义：全仓只留一份，以及三处命门');
// ═══════════════════════════════════════════════════════════════════════════
// 这一条的性质与别处不同：**眼下它在任何一次真机上都触发不了** —— 服务端的呼号白名单
// （NAME_RE）把 `<` 压死了，所以它是纵深防御。而"永远触发不了"的东西最容易被下一次重构
// 悄悄删掉（看起来没人用），所以它更需要判据。
//
// 更要紧的是**分叉**：改动前仓库里住着三套口径不一的转义器（js/main.js 只删 `<>`、
// js/menu.js 不转单引号、js/net/chat.mjs 最全）。同一个字符串走聊天是安全的、走记分板
// 就不安全，而"哪一处用的是哪一份"没人说得清 —— 所以这一段有一半在钉"只留一份"。
{
  const XSS = '<img src=x onerror="window.__x=1">';
  const ENT = '&lt;script&gt;alert(1)&lt;/script&gt;';
  ok('I1 五个字符（&amp; &lt; &gt; " \'）全都转 —— 少任何一个都是某一种拼接方式下的洞',
    escHtml('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;', escHtml('&<>"\''));
  ok('I2【反证臂】"已经长得像实体"的输入会被**再转一次** —— 只删角括号的那版会把它原样留下，而浏览器会把它当成真标签再解析一次 ⇒ 等于绕开这道防线',
    escHtml(ENT) === '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;', escHtml(ENT));
  ok('I3 非字符串一律不抛；null/undefined 给空串（三处调用点传的都可能是空的字段）',
    escHtml(null) === '' && escHtml(undefined) === '' && escHtml(0) === '0' && escHtml(false) === 'false',
    JSON.stringify([escHtml(null), escHtml(undefined), escHtml(0), escHtml(false)]));
  ok('I4 不转义过头：普通中文/空格/常用标点一个字节都不动（防"把正常呼号转坏"那一类）',
    escHtml('士兵 甲·01_-') === '士兵 甲·01_-', escHtml('士兵 甲·01_-'));

  // ── I5「只留一份」：形状守卫 ──
  // 这一段量的是**源码形状**而不是行为，理由写在这里：第二份实现的危害是"有人用它"
  // （或有人对着它改），而"有没有第二份"本身就是结构性质 —— 行为判据看不见它：
  // 把 chat.mjs 换回它自己那一份，聊天行的输出在常见输入上**一模一样**，判据全绿。
  // 这是本仓库第二次用形状守卫（第一次是 test/docs-guard.mjs 的 D′ 段），所以同样给它
  // 配反证臂：把"又抄了一份"的源码喂进去，必须报得出来；别名与无关的 replace 必须放过。
  const looksLikeLocalEscaper = (src) => {
    const s = String(src);
    if (/(?:^|\n)\s*(?:export\s+)?function\s+(?:esc|escHtml)\s*\(/.test(s)) return true;
    return /\.replace\(\/\[[^\]]*[&<>][^\]]*\]/.test(s);      // 字符类里带 & < > 的 replace
  };
  const ESC_FILES = ['js/hud.js', 'js/main.js', 'js/menu.js', 'js/net/chat.mjs', 'js/net/client.mjs'];
  const srcOf = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const offenders = ESC_FILES.filter(f => looksLikeLocalEscaper(srcOf(f)));
  ok('I5 这五份里只有一份转义实现（js/escape.js），谁都不许再抄一份出来',
    offenders.length === 0,
    offenders.length ? '又抄了一份：' + offenders.join(', ') : `${ESC_FILES.length} 份逐个核过`);
  const notUsing = ESC_FILES.filter(f => !/from '\.\.?\/(?:net\/)?escape\.js'/.test(srcOf(f)));
  ok('I6 而且它们**真的在用**那一份（不只是把本地实现删掉了事）',
    notUsing.length === 0, notUsing.length ? '没接上：' + notUsing.join(', ') : `${ESC_FILES.length} 份都 import 了`);
  ok('I7【反证臂】"又抄了一份"（改动前 js/main.js 那一版的形状）会被这条守卫报出来',
    looksLikeLocalEscaper("const escHtml = (s) => String(s).replace(/[<>]/g, '');"),
    '守卫认不出旧写法的话，I5 的绿就没有意义');
  ok('I7b【反证臂】别名（收口之后的形状）与无关的 replace 都要放过 —— 否则这条守卫会逼着人去删注释里的示例',
    !looksLikeLocalEscaper('const esc = escHtml;')
    && !looksLikeLocalEscaper("title.replace(/[^A-Za-z0-9_.-]/g, '')")
    && looksLikeLocalEscaper('function esc(s) { return escHtml(s); }'),
    '注意最后一项：哪怕函数体里只是转发，叫 esc 的这一份仍然算"第二份"（下一个人对着它改的可能性就在这里）');

  // ── I8 聊天行：走的是**行为**判据（chatRowHtml 是导出的，node 里够得到）──
  const rowHtml = chatRowHtml({ ch: 'lobby', from: '<b>甲</b>', text: XSS, at: 1_700_000_000_000 });
  ok('I8 聊天行里的昵称与正文都转过（这份原来是全仓最全的一份，现在它就是唯一那一份）',
    rowHtml.includes('&lt;b&gt;甲&lt;/b&gt;') && rowHtml.includes('&lt;img') && !rowHtml.includes('<img'),
    rowHtml.slice(0, 130));

  // ── I9 记分板：审计点名的第一处（r.name）──
  const fake = {
    cid: 7, team: 'A', ffa: false, rtt: 12, snaps: 30, scores: { A: 1, B: 2 },
    board: { rows: [{ cid: 1, team: 'B', name: XSS, s: 0, k: 0, d: 0, a: 0, rank: 1 },
      { cid: 7, team: 'A', name: '我', s: 1, k: 2, d: 3, a: 4, rank: 2 }] },
  };
  const sb = NetClient.prototype.scoreboardHTML.call(fake);
  ok('I9【命门】联机记分板里别人的呼号过转义（审计点名的第一处；呼号是**别的玩家**给的）',
    sb.includes('&lt;img') && !sb.includes('<img') && sb.includes('<td>我</td>'), sb.replace(/\n/g, '').slice(0, 170));
  const sbFfa = NetClient.prototype.scoreboardHTML.call({ ...fake, ffa: true });
  ok('I9b【反证臂】自由混战那张表走的是**另一条 return**，它也得转（只补一条分支是这一处最容易漏的形状）',
    sbFfa.includes('&lt;img') && !sbFfa.includes('<img'), sbFfa.slice(0, 130));
  ok('I10 反证臂的另一半：正常呼号不许被转坏（"我" 原样出现，不是 `&#25105;`）',
    sb.includes('<td>我</td>') && !/&#\d+;/.test(sb), '');
}

// ═══════════════════════════════════════════════════════════════════════════
sec('J. 低危：投掷物数量两端各记各的（分歧后当局不自愈）');
// ═══════════════════════════════════════════════════════════════════════════
// 这一格的性质是"没有出口"：数目在本地预测的 `beginThrow` 那一拍就扣了，服务端只在真的消费到
// 那一拍输入时才扣（server/room.mjs:applyInput）。队列溢出丢一拍 ⇒ 客户端认为没雷了、
// 权威端其实还有，而这份分歧要带到重生（fullAmmo）才对齐。它不报错、不崩，也没有任何计数。
//
// 自愈走 pong：那是唯一一条**每连接一份**的下行通道（快照是全房共享的同一块 buffer）。
// 这一段两头都量：服务端那一侧给出的是权威端的每人数值（J1–J5），客户端那一侧怎么用
// 它才是全部的风险所在（J6–J15）—— **补错方向比不分歧更像 bug**：HUD 上的雷数会自己闪。
{
  const nr = new NetRoom({ id: 'audit-nade', mapId: 'yard', seed: 20261001 });
  await nr.start();
  const P1 = nr.addClient({ name: '雷甲', team: 'A' });
  const P2 = nr.addClient({ name: '雷乙', team: 'B' });
  const P3 = nr.addClient({ name: '没带投掷物', team: 'A' });

  ok('J1【先决】默认装备里真的有雷可读（下面每一条都建立在这两个数不是 null 上）',
    P1.pl.lethal && P2.pl.lethal, `甲 ${JSON.stringify(P1.pl.lethal && P1.pl.lethal.count)} / 乙 ${P2.pl.lethal && P2.pl.lethal.count}`);
  const base = { p1: nadeCounts(nr, P1.cid).lethal, p2: nadeCounts(nr, P2.cid).lethal };
  P1.pl.lethal.count -= 1;                                   // 甲扔了一颗（权威端这一边）
  ok('J2【命门】读出的是**权威端当下**那一格：甲扔一颗之后读数跟着 -1（拿缓存/拿构造时的初值都会在这里红）',
    nadeCounts(nr, P1.cid).lethal === base.p1 - 1,
    `${base.p1} → ${nadeCounts(nr, P1.cid).lethal}`);
  ok('J3【命门】**每人一份**：同一时刻乙的读数没被甲的那一颗动过（挂在房间那一份上就不是这样）',
    nadeCounts(nr, P2.cid).lethal === base.p2, `乙 ${nadeCounts(nr, P2.cid).lethal} · 甲 ${nadeCounts(nr, P1.cid).lethal}`);
  // 反证臂：查无此人（陈旧 cid / 还没进房的连接）给 null，不抛也不给空对象 —— 客户端那一边
  // 自己分得清"这一格没给我"与"给我的是 0"（后者是手上一颗都没有，前者是服务端还不认识我）。
  ok('J4 查无此人（陈旧 cid / 还没进房的连接）与房间还不存在时都给 null，不抛也不给空对象',
    nadeCounts(nr, 99999) === null && nadeCounts(null, null) === null && nadeCounts(nr, null) === null,
    `${JSON.stringify(nadeCounts(nr, 99999))} / ${JSON.stringify(nadeCounts(null, null))}`);
  P3.pl.lethal = null; P3.pl.tactical = null;
  ok('J5【反证臂】没带投掷物的人不给 0，给 null —— 客户端不许把 null 当 0（那会让"从来没装备过"的人在 HUD 上白白多出一颗）',
    nadeCounts(nr, P3.cid) === null, JSON.stringify(nadeCounts(nr, P3.cid)));

  // ── 客户端那一侧：怎么用这一格才是风险本体 ──
  const mkFake = (lethal, tactical, ws = {}) => ({
    nadeResync: 0,
    game: {
      player: {
        lethal: { count: lethal, max: 2 },
        tactical: { count: tactical, max: 2 },
        ws: Object.assign({ state: 'idle', grenade: null, cooking: false }, ws),
      },
    },
  });
  const rec = (fake, nades) => { NetClient.prototype._reconcileNades.call(fake, nades); return fake; };

  const f1 = mkFake(0, 1);
  rec(f1, { lethal: 2, tactical: 2 });
  ok('J6【命门】本地偏少的那一侧被补到权威端的数（这就是"队列溢出丢了一拍"之后的自愈）',
    f1.game.player.lethal.count === 2 && f1.game.player.tactical.count === 2,
    `lethal ${f1.game.player.lethal.count} · tactical ${f1.game.player.tactical.count}`);
  ok('J7 校正过要有读数（nadeResync）—— 它自己会好起来，不计数的这条链第二次没人看得见',
    f1.nadeResync === 1, `nadeResync=${f1.nadeResync}`);
  ok('J7b 同一份再给一次不再计一次（幂等：.flush 那一秒钟给两次不该让读数翻倍）',
    (rec(f1, { lethal: 2, tactical: 2 }), f1.nadeResync === 1), `nadeResync=${f1.nadeResync}`);

  const f2 = mkFake(2, 2);
  rec(f2, { lethal: 1, tactical: 1 });
  ok('J8【命门】本地**偏多**时一个数都不动 —— 服务端那格是滞后读数（最坏相差一个 RTT），'
    + '双向覆盖的形状是"刚按 Q 扣到 1 ⇒ 滞后的 2 立刻把它拽回 2 ⇒ 下一份又回 1"，HUD 自己闪一下',
    f2.game.player.lethal.count === 2 && f2.game.player.tactical.count === 2 && f2.nadeResync === 0,
    `count=${f2.game.player.lethal.count} · nadeResync=${f2.nadeResync}`);

  // 出手途中：beginThrow 已经扣了、releaseGrenade 还没到 —— 此刻服务端的读数必然是旧值
  const busy = [
    ['捏在手上', mkFake(0, 1, { grenade: { type: 'frag' } })],
    ['正在拉环', mkFake(0, 1, { cooking: true })],
    ['正在投掷', mkFake(0, 1, { state: 'throw' })],
    ['正在扎针', mkFake(0, 1, { state: 'use' })],
  ];
  // 注意这里的写法：**先逐个喂一遍再判**。`every()` 在第一项为假时就短路了，后面那几份 fake
  // 从此没被 `_reconcileNades` 见过 —— 它们保持初始值，看起来"一样是 0"，于是这一条会变成
  // "只有一个状态在量、另外三个是恒绿"。这正是本仓库反复强调的那种"形似的两半"。
  for (const [, f] of busy) rec(f, { lethal: 2, tactical: 2 });
  ok('J9【反证臂】出手途中一律不许改（四种状态逐个量：这里补回去，玩家会看到雷数自己加回来、出手时又扣掉）',
    busy.every(([, f]) => f.game.player.lethal.count === 0 && f.nadeResync === 0),
    busy.map(([n, f]) => `${n}=${f.game.player.lethal.count}`).join(' · '));
  ok('J10 反证臂的另一半：这些状态挪开之后**照样补**（否则 J9 那条可以是"永远不改"的恒真绿灯）',
    (() => { const f = mkFake(0, 1, { state: 'reload' }); rec(f, { lethal: 2, tactical: 2 });
      return f.game.player.lethal.count === 2 && f.nadeResync === 1; })(),
    'reload 也算"手上没东西"：换弹中途补一颗不会闪，而政策的判据就是要有这么一格');

  const f3 = mkFake(0, 0);
  rec(f3, { lethal: 99, tactical: -3 });
  ok('J11 权威端那个数本身越界时被夹住（99 → max，负数 → 0）：HUD 上没有"第 99 颗雷"这回事',
    f3.game.player.lethal.count === 2 && f3.game.player.tactical.count === 0,
    `lethal ${f3.game.player.lethal.count} · tactical ${f3.game.player.tactical.count}`);
  const f4 = mkFake(0, 0);
  rec(f4, { lethal: null, tactical: 'x' }); rec(f4, { lethal: NaN, tactical: undefined });
  ok('J12 不是数字的三件（null / 字符串 / NaN）一律不动 —— 这条通道上的字段来自网络，'
    + '同一趟 pong 上的 `c` 就是这么被对待的',
    f4.game.player.lethal.count === 0 && f4.game.player.tactical.count === 0 && f4.nadeResync === 0,
    `count=${f4.game.player.lethal.count} · nadeResync=${f4.nadeResync}`);
  const f5 = mkFake(0, 0);
  rec(f5, { lethal: null, tactical: 2 });
  ok('J13 tactical 那一格同样走这条自愈（只补 lethal 的话，闪光弹那一路全程带着分歧）',
    f5.game.player.tactical.count === 2 && f5.game.player.lethal.count === 0,
    `lethal ${f5.game.player.lethal.count} · tactical ${f5.game.player.tactical.count}`);

  // ── J14 「不许悬空」：两侧都真的被接上了。上面每一条全绿也不能证明它被调过一次 ──
  const clientSrc = readFileSync(new URL('../js/net/client.mjs', import.meta.url), 'utf8');
  const serverSrc = readFileSync(new URL('../server/net-server.mjs', import.meta.url), 'utf8');
  ok('J14【命门】客户端在 pong 分支里真的取用了这一格（形状守卫：不看它的话上面 J6–J13 全是绿空气）',
    /j\.nades\s*\)\s*this\._reconcileNades\(/.test(clientSrc),
    '删掉这行的典型症状正是"判据全绿、真机上雷还是自己少一颗"');
  ok('J14b 服务端那一侧的 pong 回复里真的带上了 nades（另一半分支给的是 null，不是省略整份回复）',
    /,\s*nades:\s*nadeCounts\(/.test(serverSrc),
    '形状守卫，理由是 net-server.mjs 一 import 就起服务器 —— 这一格没法在进程内跑起来');
  ok('J15 带这一格的那份 pong 与老形状**同一条路径**（既有字段一个不少）：老客户端按它取 ping/tick 不受影响',
    /t:\s*'pong',\s*c:\s*msg\.c,\s*s:\s*Date\.now\(\),\s*tick:/.test(serverSrc), '');

  // ── J16 起：同一批低危里另外几格是**开关/常数漂移**，它们的失效形状是"有人重写那一行"，
  // 而 netserve 端的那两处（pickRoom）连进程都 import 不进来，所以这一小段照 I5 那样
  // 量源码形状，配反证臂说明它认得出旧写法。──
  const mainSrc = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  ok('J16【命门】fixedStep=false 只在**没有 net** 时才生效（残留旧设置的玩家一进联机就被拽回固定步长）',
    /fixedStep\s*===\s*false\s*&&\s*!this\.net/.test(mainSrc),
    '它的失效症状是"联机完全不跟手、不掉线、不报错"：tick 恒 0，每一包都被服务端当重复包丢掉');
  ok('J17【命门】pickRoom 里没人写字面 16，座位上限读导出的 MAX_SEATS、房号清洗读 lobby 那一份 roomId',
    /clients\.size\s*<\s*MAX_SEATS/.test(serverSrc) && /roomId\(requested\)/.test(serverSrc)
    && !/< 16\b/.test(serverSrc.slice(serverSrc.indexOf('async function pickRoom'), serverSrc.indexOf('async function pickRoom') + 1200)),
    '上一版正是那条注释预言的漂移形状：上限一改，快速加入把人塞进一间满房');
}

// ═══════════════════════════════════════════════════════════════════════════
const bad = checks.filter(c => !c[0]).length;
for (const [pass, label] of checks) console.log(`  ${pass ? '✅' : '❌'} ${label}`);
console.log(`\n${bad ? '❌ RED' : '✅ GREEN'}  ${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
