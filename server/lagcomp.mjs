// 延迟补偿（lag compensation）的服务端那一半：把"开枪者当时看到的世界"还回来。
//
// 症状（README「还没做完的部分」第 2 条）：服务端拿**当下**的位置裁决 hitTest，于是
// 高延迟下"我明明打中了" —— 客户端瞄的是它屏幕上的那个人，而那个人是 RTT/2 + 插值回退
// 之前的姿态；服务端却在按现在的姿态算，差的正是这段时间里目标走掉的位移。
//
// 这一层只做两件事，都不碰模拟：
//   1) 每拍给每个玩家存一份**命中盒参数**（位置 + 眼高）。命中盒只由这四个量决定
//      （见 js/combat.js:hitTestPlayer），所以一个 Float64Array 就够，不用存整个玩家；
//   2) 裁决时按开枪者报的"我当时在渲染哪一拍"把**别人**拨回那一拍。
//
// ── 为什么由客户端报拍号，而不是服务端按 ping 估 ──
// 服务端要的这个量是"开枪那一刻，我的屏幕上显示的是服务端的哪一拍"。按 ping 估出来的
// 形式是 RTT/2 + 插值回退，而插值回退是**客户端**的常数（js/net/remote.mjs:INTERP_DELAY）、
// 而且客户端的实际渲染点还受它自己的帧率影响。服务端复刻一份就成了两个真相：改一个忘
// 一个的症状是"高延迟下总是差一点点"，不报错，只是打不中。
// 而客户端手上本来就有那个拍号：它把快照按到达时刻排队，渲染时刻往回退 INTERP_DELAY，
// 落在哪两包之间、那两包的头里写着服务端拍号 —— 插一下就是答案（js/net/client.mjs:renderTick）。
//
// ── 代价与它的闸 ──
// 它因此是一个**可以撒谎的字段**：报一个更旧的拍号 = 让服务端把别人拨得更靠前 = 打"影
// 子"。所以 rewindTick() 把可接受的窗口钉死在**服务端真的发出去过的那些快照**上：
// 只能报"我发给你的最新快照往前 LAG_MAX_TICKS 拍之内"，出窗一律拒绝（不是夹 —— 夹和拒绝
// 的上限都是 1 秒，但拒绝不会让一个乱报的客户端白白拿到一秒回溯）。
// 另一道兜底在 room.shotRewind：环形缓冲里查不到那一拍就退回当下姿态。

// 回溯上限：1 秒 @60Hz。再久就不是延迟了，是作弊面。
export const LAG_MAX_TICKS = 60;
// 环形缓冲长度：1.6 s。要比上限多出余量 —— 判据端能查到的最旧拍号是
// lastSent − LAG_MAX_TICKS，而 lastSent 最旧可以落后当前拍 SNAP_EVERY−1 拍。
export const LAG_HIST = 96;
// x, y, z, eye, yaw, prone —— 后两个是趴姿加的：趴下的命中盒沿体轴平摊出去 ~1.6 m
// （js/combat.js:hitTestPlayer），"脚跟朝哪"没有 yaw 答不出来，"是否已经趴下"没有
// prone 答不出来。盒子依赖什么，缓冲里就得存什么。
export const POSE_FIELDS = 6;

// 一个玩家的姿态环形缓冲。拍号单调递增，按下标取模写入；lo/hi 记窗口，
// 于是"这一拍还在不在缓冲里"是个可判定的问题，而不是靠调用方自己算。
export class PoseRing {
  constructor(n = LAG_HIST) { this.n = n; this.d = new Float64Array(n * POSE_FIELDS); this.lo = 0; this.hi = -1; }
  // pl 要有 pos / curEye() / yaw / proneT —— Player 与 NetPlayer 都有这四个（命中盒的定义在
  // js/combat.js）。Bot 没有 proneT（它们不趴），读出来是 undefined，与 0 同义。
  record(tick, pl) {
    const i = (tick % this.n) * POSE_FIELDS, d = this.d;
    d[i] = pl.pos.x; d[i + 1] = pl.pos.y; d[i + 2] = pl.pos.z; d[i + 3] = pl.curEye();
    d[i + 4] = pl.yaw; d[i + 5] = pl.proneT > 0.5 ? 1 : 0;
    if (this.hi < this.lo) { this.lo = this.hi = tick; }        // 第一笔
    else { this.hi = tick; this.lo = Math.max(this.lo, tick - this.n + 1); }
  }
  // 把 tick 那一拍的 [x,y,z,eye,yaw,prone] 交出来；不在窗口里返回 null。
  // 返回**新数组**而不是复用一个 scratch：核弹级的坑是"交错对象静默毒化下游"——
  // 这里每次裁决也就几次分配，不值得为它冒那个险。
  // 必须交满 POSE_FIELDS 个：消费方（js/combat.js:traceBullet）按 p[4]/p[5] 读 yaw/prone，
  // 少交一个就是"趴姿一律按站立盒裁决"的静默失真 —— 自测里有一条按长度钉死它。
  at(tick) {
    if (this.hi < this.lo || tick < this.lo || tick > this.hi) return null;
    const i = (tick % this.n) * POSE_FIELDS, d = this.d;
    return [d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5]];
  }
}

// 客户端报的 u16 拍号 → 服务端的绝对拍号；不该回溯时返回 -1。
//   view     上行输入包里的 u16（客户端渲染时刻对应的服务端拍号，低 16 位）
//   cur      服务端"正在产出的那一拍"的拍号（= room.tick + 1，见 room.shotRewind）
//   lastSent 这个客户端最近一次收到快照时的拍号（服务端自己记的，不可伪造）
// 四条拒绝的理由各不相同，注释里逐条写明 —— 它们以前是一条，读的人分不出"客户端在偷懒"
// 和"客户端在撒谎"。
export function rewindTick(view, cur, lastSent, max = LAG_MAX_TICKS) {
  if (lastSent <= 0) return -1;                     // 一份快照都还没发出去过：它不可能渲染过任何东西
  // 拿当前半圈把低 16 位拼回来。必须用纯算术而不是 `cur & ~0xffff`：那按 32 位**有符号**
  // 折叠，cur 超过 2^31（60Hz 下约 414 天）之后结果变负，回溯从此永久拒绝、全部计入
  // stale —— 房间有人在线就一直跑，不会自愈。`cur - cur % 0x10000` 对任何正数都等于
  // "抹掉低 16 位"，语义同、没有位宽。
  let v = cur - (cur % 0x10000) + (view & 0xffff);
  if (v > cur) v -= 0x10000;                        // 拍号翻过一圈：它其实在 cur 前面一点点
  if (v >= cur) return -1;                          // 看的就是当下（或已按速度外推）：没有可回溯的东西
  if (v > lastSent) return -1;                      // 报了一个我还没发出去的拍 —— 那不是"它看到了过去"
  if (v < lastSent - max) return -1;                // 比我发过的最新快照再往前 max 拍还旧：不是延迟，是瞎报
  return v;
}

// 自测：node server/lagcomp.mjs —— 环形缓冲的窗口与 rewindTick 的四条拒绝臂。
// 这里量的是**判据本身会不会恒真**：每一条拒绝都配一个"刚刚合法"的邻居，邻居必须通过。
//
// ⚠ 判"是不是被直接运行"**不能只比文件名**（server/codec.mjs 那种写法）：test/lagcomp.mjs
// 与 server/lagcomp.mjs 同名，于是 test/ 那份一 import 本模块，自测就会先跑一遍，
// 输出混进判据里、还多花两秒。所以这里比的是去掉协议与分隔符差异之后的完整路径。
// （不改用 node:url：这个文件虽然只在服务端 import，但保持与 codec.mjs 同一套"不引
//   Node 专有模块"的写法，以后谁在浏览器侧用到它都不会当场炸。）
function isDirectRun(argv1, url) {
  const norm = (s) => { try { s = decodeURIComponent(String(s)); } catch (e) { /* 不是转义过的 */ } return s.replace(/^file:\/\/\//, '').replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/g, '/').toLowerCase(); };
  return !!argv1 && norm(argv1) === norm(url);
}
if (typeof process !== 'undefined' && isDirectRun(process.argv[1], import.meta.url)) {
  let bad = 0;
  const eq = (got, want, label) => {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✅' : '❌'} ${label}  ${JSON.stringify(got)}${ok ? '' : ' ≠ ' + JSON.stringify(want)}`);
  };
  const fake = (x) => ({ pos: { x, y: 0, z: 0 }, curEye: () => 1.62, yaw: 0.5, proneT: 0 });
  const r = new PoseRing(8);
  eq(r.at(3), null, '空缓冲取任何一拍都是 null');
  for (let t = 100; t < 108; t++) r.record(t, fake(t));
  eq(r.at(100)[0], 100, '窗口内的老一拍取得到');
  eq(r.at(107)[0], 107, '窗口内最新一拍取得到');
  eq(r.at(99), null, '窗口外（更旧）返回 null');
  eq(r.at(108), null, '窗口外（将来）返回 null');
  r.record(108, fake(108));
  eq(r.at(100), null, '写满一圈：被顶掉的那一拍确实取不到了');
  eq(r.at(101)[0], 101, '写满一圈：还留在窗口里的仍然取得到');
  // 中间漏记（比如那一拍没人动）不改变 lo/hi 的语义：拍号是稀疏键，不是下标
  const r2 = new PoseRing(4);
  r2.record(10, fake(1)); r2.record(40, fake(2));
  eq(r2.at(10), null, '稀疏拍号：隔了 30 拍，老的那笔已被窗口挤掉');
  eq(r2.at(40)[0], 2, '稀疏拍号：新的那笔在');

  // at() 必须交满 POSE_FIELDS 个字段：消费方（js/combat.js:traceBullet → hitTestPlayer）
  // 按 p[4]/p[5] 读 yaw/prone。这里曾经只回 4 个 —— "能取到值"的判据照样全绿，而
  // 趴姿在联机里一律按站立盒裁决（趴姿盒沿体轴平摊 ~1.6 m，yaw 答脚跟朝哪、prone 答
  // 是否趴下）。所以长度要逐条断言，不能只比 [0]。
  const prone = { pos: { x: 12, y: 0, z: 34 }, curEye: () => 0.6, yaw: 2.25, proneT: 1 };
  const stand = { pos: { x: 56, y: 0, z: 78 }, curEye: () => 1.62, yaw: -1.5, proneT: 0 };
  r2.record(50, prone); r2.record(51, stand);
  const gotP = r2.at(50), gotS = r2.at(51);
  eq(gotP.length, POSE_FIELDS, 'at() 交回来的字段数必须等于 POSE_FIELDS');
  eq(JSON.stringify(gotP), JSON.stringify([12, 0, 34, 0.6, 2.25, 1]), '趴姿靶：位置/眼高/yaw/prone 逐字段原样（eq 比的是引用，数组要走 JSON）');
  eq(JSON.stringify(gotS), JSON.stringify([56, 0, 78, 1.62, -1.5, 0]), '站姿靶：yaw 原样、prone 是 0');

  eq(rewindTick(990, 1000, 998), 990, '正常：报 10 拍前 → 回溯到 990');
  eq(rewindTick(995, 1000, 998), 995, '正常：报 5 拍前 → 回溯到 995');
  eq(rewindTick(999, 1000, 998), -1, '拒绝：报的比"我发过的最新快照"还新（= 它还没收到过）');
  eq(rewindTick(1000, 1000, 998), -1, '拒绝：报的就是当下');
  eq(rewindTick(1010, 1000, 998), -1, '拒绝：报了一个将来的拍');
  eq(rewindTick(938, 1000, 998), 938, '邻居：正好在上限上（998−60）→ 仍然接受');
  eq(rewindTick(937, 1000, 998), -1, '拒绝：超上限一拍');
  eq(rewindTick(0, 1000, 998), -1, '拒绝：报 0（一个从没报过这个字段的客户端）');
  eq(rewindTick(65535, 65540, 65538), 65535, 'u16 回绕：跨过 65536 那一步还算得对');
  eq(rewindTick(65534, 131075, 131073), 131070, 'u16 回绕：第二圈同样算得对');
  eq(rewindTick(1234, 1000, 998), -1, '拒绝：低 16 位拼回来是"上一圈的 1234"（落后 6.5 万拍）而不是"将来的 1234"');
  eq(rewindTick(990, 1000, 0), -1, '拒绝：这个客户端一份快照都还没发出去过');
  // 2^31 之后位运算会变负（32 位有符号折叠）：60Hz 跑 414 天就到。这里曾经把
  // `cur & ~0xffff` 用在无限增长的 JS Number 上 —— 结果是回溯永久拒绝、全部计入 stale，
  // 且房间有人在线就一直跑，不会自愈。纯算术版对任何正数都对。
  {
    const cur = 2 ** 31 + 5000, lastSent = cur - 1;
    eq(rewindTick((cur - 5) & 0xffff, cur, lastSent), cur - 5, '2^31 之后：回溯照样算得对（414 天炸弹的邻居）');
    eq(rewindTick((cur - LAG_MAX_TICKS) & 0xffff, cur, lastSent), cur - LAG_MAX_TICKS, '2^31 之后：正好在上限上的那一拍仍然接受');
    eq(rewindTick((cur - LAG_MAX_TICKS - 2) & 0xffff, cur, lastSent), -1, '2^31 之后：超上限的照样拒（闸门不因改写法而松）');
  }
  console.log(bad ? `\n  ❌ lagcomp 自测 ${bad} 条红\n` : '\n  ✅ lagcomp 自测通过\n');
  process.exit(bad ? 1 : 0);
}
