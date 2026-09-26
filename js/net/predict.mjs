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
//   而 rep 只报**末尾连拍**，空跑落在"首次消费之前"的那几拍它报不出来（服务端一步二选一：
//   有货就消费、没货就拿上一份空跑，所以一窗之内空跑可以出现在消费的**前面**）。这一类由
//   opts.carry 负责：把基态整个往前挪 dAck 拍，再按 lead → dAck 条真输入 → rep 的顺序重演。
//   两者的分工是"两包之间服务端真跑过的那 dTick 步"，加起来拍数必须恰好等于 dTick。
import { rng } from '../rng.js';
import { FLAG } from '../quant.js';       // 位掩码只在协议定义里有一份

const DT = 1 / 60;

// win：从 startTick 那一拍起（含）、按 tick 升序的历史，每条 { tick, inp, j }。
// opts.hard：状态被服务端整体重置（重生、传送、回合重开）。这时 journal 里那一份
// 是"上一个位置"的，退回去重演只会把人在纠正之后又拽回出生点前 —— 所以直接吃权威值，
// 并且**不把这次位移记进预测偏差**：那是合法的传送，不是预测失败。
// 返回 { replayed, reps, led, corrected, baseState, landed, journalMiss }：replayed/reps/led/corrected
// 只是给上层印的，不参与裁决；**baseState 与 landed 例外** ——
//   · baseState 是"这一窗服务端跑过的 dTick 步重演完之后"那几个权威不下发的姿态量，
//     client 侧拿它跟权威旗标比（位置/视线/血马上要被覆盖，比了没信息）。
//   · landed 是**同一时刻的完整状态**，client 侧必须存成下一窗的基态（理由见下面那一段）。
export function rollback(game, pl, win, startTick, e, rngState, opts = {}) {
  const hard = !!opts.hard;
  if (!pl) return { replayed: 0, reps: 0, led: 0, corrected: 0, baseState: null, journalMiss: false };
  const before = { x: pl.pos.x, y: pl.pos.y, z: pl.pos.z };
  const hit = !hard && win.length > 0 && win[0].tick === startTick;
  // ── 基态整段往前挪 dAck 拍（opts.carry）─────────────────────────────────────
  // 上面那段"rep = 末尾连拍"只对**纯饥饿**成立。服务端每步是二选一：队列有货就消费一条、
  // 没有就拿上一份空跑（server/room.mjs:step）。两包之间它跑 dTick 步、消费 dAck 条，
  // 剩下的 deficit = dTick - dAck 步是空跑 —— 但随包的 rep 只报"末尾的那一撮"，
  // 落在**首次消费之前**的几拍它报不出来。而客户端过去的基态 journal[ack+1] 已经把
  // 那 dAck 条消费算进去了，只把 rep 补在末尾，等于把这几拍排到了消费之后。输入不交换，
  // 位置就差整整 deficit 拍：真浏览器实测 0.1539 m ÷ 2 拍 = 0.0770 ≈ 4.46 m/s ÷ 60，
  // 且 Δpos 的方向与相邻两拍的位移同向 —— 是"少走了两拍"，不是物理分叉。
  // 正确的形状是把基线整个挪到 start - dAck（= 上一包的 ack+1），然后**按服务端实际顺序**
  // 重演一遍：先 lead 拍空跑（都用 I_{ack_prev}），再那 dAck 条真输入，最后 rep 拍空跑
  // （都用 I_ack）。总拍数 = lead + dAck + rep = dTick，一步不多一步不少。
  // lead 不需要协议加字段：上一包随快照下来的 rep 就是"进这一窗之前已经欠下的空跑数"，
  // 而本窗落在首次消费之前的那几拍 = deficit - rep（本窗的总空跑减去末尾连拍）——
  // 两项客户端都量得到（前者来自上一包，后者由 Δtick、Δack 自己算）。
  // 这里保留"没有 carry 就走旧通路"：纯饥饿窗（dAck=0）本来就只有末尾连拍，两者等价；
  // test/rollback.mjs 的 C4/C7 走的也是旧通路，它们断言的是同一件事的另一种形状。
  const carry = hit ? opts.carry : null;
  const base = carry && carry.j ? carry.j : (hit ? win[0].j : null);
  const predictedHp = hit ? base.hp : pl.hp;
  if (hit) pl.applyJournal(base);          // 退到"和快照同一时刻"的本地状态
  // 首段空跑：服务端在消费到任何新输入之前，拿手里那份继续按住不放。
  let led = 0;
  if (hit && carry) {
    const prev = carry.prevInp;
    for (let i = 0; i < (opts.lead | 0) && prev; i++) { game.time += DT; pl.update(DT, prev, { replay: true }); led++; }
    // 这一窗被服务端消费掉的那几条真输入。它们必须重演 —— 不是"补"，是这 dAck 步本身
    // 就在基态之后发生，缺了它们重建出来的就是上一包那一刻的状态。
    for (let i = 0; i < carry.inp.length; i++) { game.time += DT; pl.update(DT, carry.inp[i], { replay: true }); led++; }
  }
  // rep：服务端在**这一窗最后一次消费之后**又拿同一份输入空跑了几拍（我供不上输入，它按
  // "按住不放"继续算）。这几拍它算了而我这边没有，所以基态后面根本不是同一时刻的状态 ——
  // 差的就是 rep 拍的位移。实测过：不补这几拍，权威读数恰好落在本地日记本的第 start+rep 拍
  // 上（差 4 mm），稳态里近一成样本被这个假偏差污染，撞墙时放大到 0.9 m。
  // 用的输入就是它手里那份 = 我发到 ack 那一拍的 opts.hold，所以补出来是同一台机器上的
  // 同一次确定性演算，不是"猜"。**这一段只覆盖末尾连拍**；落在首次消费之前的那几拍由上面的
  // carry/lead 负责，两者加起来才是"两包之间服务端实际跑的那 dTick 步"。
  // 上限跟服务端那个 255（wire 上是 u8）对齐，不自作主张收得更紧：任何比它小的数都等于
  // "我知道服务端多算了 N 拍，但我拒绝补" —— 少补的每一拍都会原样变成一次校正位移。
  // 代价算过：最坏 255 拍 × 单人 update ≈ 十几毫秒，一个偶发卡顿；换来的是不用拽一次位置。
  const rep = Math.max(0, Math.min(255, opts.rep | 0));
  let reps = 0;
  // 只在真的退回到日记本时才补演：没退回去的话 pl 是我"当前"的状态，再叠几拍就把
  // 未来又演了一遍。opts.hold 拿不到（那一拍的输入已被历史窗口挤掉）时也只能作罢 ——
  // 这两种情况都会体现在 corrected 上，不会被悄悄抹平。
  if (hit) for (let i = 0; i < rep && opts.hold; i++) { game.time += DT; pl.update(DT, opts.hold, { replay: true }); reps++; }
  // corrected = **同一时刻**两个读数的差：把这一窗服务端跑过的 dTick 步（lead + dAck + rep）
  // 重演完之后，我这边重建出的状态 vs 服务端裁决的读数。刻意不用"回滚前的位置"去比 ——
  // 那是 localTick 的位置，和服务器的 ack 差着一整个 RTT 的真实位移，量出来的数是
  // "我走了多远"，不是"两边差多少"。
  const mine = hit ? [pl.pos.x, pl.pos.y, pl.pos.z] : (hard ? [e.x, e.y, e.z] : [before.x, before.y, before.z]);
  // 重建出来的"同一时刻"里**不下发**的那几个姿态量。判据端要拿它跟权威端的旗标比 ——
  // 位置/视线/血马上要被权威值覆盖，拿覆盖之后的去比是恒真绿灯。这几个量只有 client 那侧
  // 的编码方式知道怎么折成旗标，所以这里只交出原始字段。
  // 为什么要新加：过去判据端比的是 `win[0].j`（= journal[start]），它的前提是"rep=0 ⇒ 基态
  // 与快照同一时刻"。那个前提在 deficit>0 的空跑窗里**不成立**（基态比权威端早 deficit 拍），
  // 于是这条断言在那些窗里量的是两件不同的事。现在重建已经把 deficit 补掉，基态真的落在
  // 权威那一刻上，前提失而复得。
  const baseState = hit ? { alive: pl.alive, crouchT: pl.crouchT, sprinting: pl.sprinting, onGround: pl.onGround, sliding: pl.sliding } : null;
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
  // ★ **这一窗重建出来的那一刻的完整状态** —— 它必须是下一窗的基态（client 侧存成
  // lastLanding 交回来）。为什么不再从日记本里取 journal[start−dAck]：
  //   日记本那几格是**逐代推出来**的（win[i+1].j = pl.journal()，而 pl 的起点是上一包
  //   那次重建的落点），所以"这一格落在哪一拍上"取决于几代之前那些包的记账。
  //   实测的形状就是累积漂移：一条链上 carry 基态 Δpos 从 −0.59 → −0.95 → −1.22 m
  //   一路长下去（net-play 现场），偏差跟着 0.45 → 0.75 → 1.12 m。
  //   漂移量可以推出来（err_k = err_{k−2} − ownLead_{k−1} 那种递推），但每代长多少取决于
  //   历史，**没有一项能补**：试过的两项只是把漂移换个方向 —— 去掉 lastRep 时每代漂 −deficit
  //   （实测更差：6 次取样红 5 次、最大 1.12 m），留着它每代漂 −ownLead（小一些，但仍非零）。
  //   而"上一包重建出来的那一刻"按定义就是"和上一份快照同一时刻"，也就是下一窗的基态；
  //   它是**同一时刻的直接传递**，不经过日记本那条逐代推的路径，因此不累积。
  // 取在权威覆盖**之后**：位置/速度/朝向/血这几维此刻就是权威读数，比重建值更准；
  // 姿态类布尔（crouch/slide/sprint/onGround）与武器时间轴则由重演决定（上面刻意不覆盖）。
  // 取在重演循环**之前**：循环会把 pl 推到 localTick，那不是"和快照同一时刻"了。
  const landed = hit ? pl.journal() : null;
  // ── 这一拍（win[0] / tick=start）的账本**不能**在这里写回 ─────────────────────────
  // 这里原先有一行 `if (hit) win[0].j = pl.journal();`。它是错的，而且是那一族"权威端
  // 常数超前我一段"的直接来源：
  //   走到这一行时，pl 已经不是"tick=start 那一刻"的状态了 —— 上面刚补演过 rep 拍折叠、
  //   又被权威读数整体覆盖过，所以 pl 此刻是**快照那一拍（= start + rep）**的状态。
  //   把它记进标着 start 的那一格，等于每次回滚都把账本整体往前挪 rep 拍；下一次回滚
  //   从这一格出发再补 rep 拍，就又超一遍。实测的形状正是"误差 ≈ (rep − 3) 拍位移"
  //   （3 = 一份快照的拍数），且只在饥饿窗口出现（rep=0 时两者同一时刻，写回是恒等变换）。
  //   证据是 net-play 打印的现场：traj[0]（= 这一格的位置）**恒等于** auth（权威读数），
  //   而两者按定义本该差 rep 拍 —— 那个恒等不是巧合，是这一行造出来的。
  // 正确的写法就是**不写**：tick=start 的状态已经在上面 `applyJournal(base)` 里恢复过了，
  // 就是它本身；权威读数对"start 那一刻"没有任何新信息可给（它给的是 start+rep 那一刻的）。
  // 下面那个循环写的 win[i+1] 都是**在窗口内逐拍推出来的**，标号与状态同源，没有问题。
  // test/rollback.mjs 的 C7 就是这条的守卫：同一拍上连做三次回滚必须幂等（饥饿窗口里
  // ack 不动、start 不动，真浏览器里 71 包都是这个形状），并且这一格的账本对象不许被替换。
  for (let i = 0; i < win.length; i++) {
    const h = win[i];
    game.time += DT; pl.update(DT, h.inp, { replay: true });
    if (win[i + 1]) win[i + 1].j = pl.journal();
  }
  return { hard, noBase: win.length === 0, replayed: win.length, reps, led, baseState, landed, corrected: Math.hypot(mine[0] - e.x, mine[1] - e.y, mine[2] - e.z), journalMiss: !hard && win.length > 0 && !hit };
}
