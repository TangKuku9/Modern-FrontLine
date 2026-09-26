// 客户端预测的回滚重放 —— 单一实现，浏览器和 test/rollback.mjs 跑的是同一份。
//
// 为什么单独成文件而不是留在 NetClient.reconcile 里：那段逻辑是这套网络模型最贵的
// 一处（错一格、少恢复一个字段都不会报错，只会手感怪），必须能在没有 WebSocket、
// 没有 DOM 的地方被逐位断言。放进 client.mjs 就只能靠"开两个浏览器窗口看像不像"
// 来验，那等于没有判据。
//
// tick 配对（这里最容易错，且错了不会崩）：
//   journal[k] 记的是**输入 I_k 生效之前**的状态 S_k；
//   服务端的 ack=k 表示"I_k 已经消费完"，所以它那份快照是 S_{k+1} 时刻的 T_{k+1}；
//   ⇒ 和本地 journal 同一时刻的是 journal[k+1]，重演也要从 I_{k+1} 开始。
//   若恢复 journal[k] 却用 S_{k+1} 的权威值覆盖，就等于把 I_k 的位移演了两遍 ——
//   每收一份快照就超前一拍（冲刺时 ~8cm），20Hz 抖回来，手感就是"踩到橡皮筋"。
//   这条契约还有一个容易被忽略的前提：服务端折叠的序列**不一定**就等于"我发到 k 的那几拍"。
//   我的输入供不上时它会拿最后一份重复几拍（人不会站住），那几拍不在任何 ack 里，
//   只能靠快照带下来的 rep 字段补演 —— 少补一拍，重建出的"同一时刻"就差一拍位移。
import { rng } from '../rng.js';
import { FLAG } from '../quant.js';       // 位掩码只在协议定义里有一份

const DT = 1 / 60;

// win：从 startTick 那一拍起（含）、按 tick 升序的历史，每条 { tick, inp, j }。
// opts.hard：状态被服务端整体重置（重生、传送、回合重开）。这时 journal 里那一份
// 是"上一个位置"的，退回去重演只会把人在纠正之后又拽回出生点前 —— 所以直接吃权威值，
// 并且**不把这次位移记进预测偏差**：那是合法的传送，不是预测失败。
// 返回 { replayed, corrected, journalMiss }，只是给上层印的，不参与裁决。
export function rollback(game, pl, win, startTick, e, rngState, opts = {}) {
  const hard = !!opts.hard;
  if (!pl) return { replayed: 0, corrected: 0, journalMiss: false };
  const before = { x: pl.pos.x, y: pl.pos.y, z: pl.pos.z };
  const hit = !hard && win.length > 0 && win[0].tick === startTick;
  const predictedHp = hit ? win[0].j.hp : pl.hp;
  if (hit) pl.applyJournal(win[0].j);      // 退到"和快照同一时刻"的本地状态
  // rep：服务端在 ack 那一拍之后又拿同一份输入折叠了几拍（我那几拍没供上输入，它按
  // "按住不放"继续算）。这几拍它算了而我这边没有，所以 journal[ack+1] 根本不是同一时刻
  // 的状态 —— 差的就是 rep 拍的位移。实测过：不补这几拍，权威读数恰好落在本地日记本的
  // 第 start+rep 拍上（差 4 mm），稳态里近一成样本被这个假偏差污染，撞墙时放大到 0.9 m。
  // 用的输入就是它手里那份 = 我发到 ack 那一拍的 opts.hold，所以补出来是同一台机器上的
  // 同一次确定性演算，不是"猜"。
  // 上限跟服务端那个 255（wire 上是 u8）对齐，不自作主张收得更紧：任何比它小的数都等于
  // "我知道服务端多算了 N 拍，但我拒绝补" —— 少补的每一拍都会原样变成一次校正位移。
  // 代价算过：最坏 255 拍 × 单人 update ≈ 十几毫秒，一个偶发卡顿；换来的是不用拽一次位置。
  const rep = Math.max(0, Math.min(255, opts.rep | 0));
  let reps = 0;
  // 只在真的退回到日记本时才补演：没退回去的话 pl 是我"当前"的状态，再叠几拍就把
  // 未来又演了一遍。opts.hold 拿不到（那一拍的输入已被历史窗口挤掉）时也只能作罢 ——
  // 这两种情况都会体现在 corrected 上，不会被悄悄抹平。
  if (hit) for (let i = 0; i < rep && opts.hold; i++) { game.time += DT; pl.update(DT, opts.hold, { replay: true }); reps++; }
  // corrected = **同一时刻**两个读数的差：补演完 rep 拍之后我这边重建出的状态
  // vs 服务端裁决的读数。刻意不用"回滚前的位置"去比 —— 那是 localTick 的位置，
  // 和服务器的 ack 差着一整个 RTT 的真实位移，量出来的数是"我走了多远"，不是"两边差多少"。
  const mine = hit ? [pl.pos.x, pl.pos.y, pl.pos.z] : (hard ? [e.x, e.y, e.z] : [before.x, before.y, before.z]);
  // 只有服务端**有权改动**的那几维用权威值覆盖：位置（碰撞纠正）、视线（它裁决的后坐）、
  // 生命与存活（别人打的）。
  // 姿态类布尔（crouch/slide/sprint/onGround）刻意**不**覆盖 —— 它们完全由我自己的输入
  // 推出来，服务端那边只是一份 1 bit 的量化影子（>0.5 才为真）；拿信息量更少的版本去
  // 覆盖信息量更多的那份，是在往预测里灌误差：蹲伏过渡中 crouchT=0.6 被硬拉成 1，
  // 视线高度就从 lerp(1.62,1.05,0.6) 跳到 1.05，而 journal 里本来是对的。
  // 例外要留在这里说清楚：将来若服务端会强制改变姿态（反作弊拽正、载具、脚本动画），
  // 那几维就必须回到权威侧，并同时把下面的 test/rollback.mjs 补上对应判据。
  pl.pos.set(e.x, e.y, e.z);
  pl.vel.x = e.vx; pl.vel.z = e.vz;
  pl.yaw = e.yaw; pl.pitch = e.pitch;
  pl.hp = e.hp;
  pl.alive = !!(e.flags & FLAG.Alive);
  // 回血计时：服务端在快照里给了更低的血，说明这一拍之后我挨了打，而本地 journal 里
  // 那个"很久没受伤"的 dmgT 是打之前的假数据。不归零，本地会立刻开始回血而权威端还在
  // 4 秒延迟里 —— 血条每收一份快照抖一格。
  if (e.hp < predictedHp - 1e-6) pl.dmgT = 0;
  if (rngState !== undefined) rng.setState(rngState);
  // 重放不能只把人算回来：**被重放的那些拍的日记本要换成纠正之后的那份**。
  // 漏了这一步是这里最隐蔽的一个洞：win[i].j 还留着"纠正之前的预测值"，下一次回滚只要
  // 落回这些拍，就会把上一次的纠正整个丢掉 —— 于是权威端读数永远比我的基态超前若干拍，
  // 而且超前的方向沿着同一条路径、长度每次一样（实测重复出现 Δpos≈[-1.187,0,-0.62] 这种
  // 等长常量），看上去像物理分叉，其实是我自己拿旧草稿当成了账本。
  if (hit) win[0].j = pl.journal();       // 权威值覆盖之后，这一拍才算有真相
  for (let i = 0; i < win.length; i++) {
    const h = win[i];
    game.time += DT; pl.update(DT, h.inp, { replay: true });
    if (win[i + 1]) win[i + 1].j = pl.journal();
  }
  return { hard, noBase: win.length === 0, replayed: win.length, reps, corrected: Math.hypot(mine[0] - e.x, mine[1] - e.y, mine[2] - e.z), journalMiss: !hard && win.length > 0 && !hit };
}
