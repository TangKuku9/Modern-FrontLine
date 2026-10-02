// 房间广播的最后一段：**一条连接在这一拍究竟该收到什么**。
//
// 为什么单独一份（与 server/lagcomp.mjs 同一手法）：这一段的失效全是静默的 ——
// 丢一帧事件在玩家侧只表现为"世界不对"，没有任何一处会报错：
//   · 漏 respawn ⇒ 客户端不做整体重置（hardSnap 不置、日记本不清），
//     重生传送被当成一次普通校正 —— 一次硬拉回死点；
//   · 漏 proj ⇒ "被看不见的雷炸死"；
//   · 漏 pickup/pickupTake ⇒ 地上的枪与权威端各说各话。
// 而 server/net-server.mjs 是**一整份起在模块顶层**的（import 它就等于起一台服务器，
// 它会 bind 端口、起定时器），判据没法在进程内调那里的 broadcast。抽出来之后
// test/net-audit.mjs 的 D 段能用假 ws 把这条纪律逐条量出来。
//
// ── 两条纪律，按重要程度排 ────────────────────────────────────────────────
// ① **事件不可再生，快照可再生**。events 是 `splice(0, len)` 一次排干、没有任何重传，
//    丢一条就是永久丢；快照下一拍还有一份。所以背压闸**只能挡快照**，不许挡事件：
//    事件很小（一条几十字节，一次广播几十条也就几 KB），把这几 KB 排进一条已经积压了
//    256 KB 的缓冲里，对"它什么时候能排空"没有任何影响，但丢掉就是整条因果链断掉。
// ② **事件必须先于快照**。重生事件会让客户端把这次位置跳变当"服务端整体重置"处理；
//    反过来的话，那一包快照会先被当成一次普通校正，量出 29 m 的"预测偏差"，
//    还会拿死亡前的日记本去回滚 —— 重生后被拽回死点一下。
// 这两条的相对顺序不能互换，也不能把事件挪到闸后（改动前的形状就是后者，
// 注释写着"照发"而 `continue` 在发事件之前）。
//
// 返回 { drops, stalls }：drops = 这一拍被跳过几份快照（按房间累计进 /healthz 的
// netDrops）；stalls = 这一拍**首次**开始积压的那几条连接（边沿，不刷屏），
// 交给调用方去打日志 —— 这里不做 I/O，判据才不会往屏幕上喷东西。
//
// 边沿旗挂在**连接**上（c.__stall）而不是房间上：挂在房间上时多人同时积压只有第一条
// 能带 cid，日志读起来像"只有那一个人卡了"，而实际是"这一屋子人都在卡"
// （房间级旗 + 印 cid 是两种口径混在一起）。
export function fanout(room, evMsg, buf, backlogBytes) {
  let drops = 0;
  const stalls = [];
  // 按 room.clients 发，不能遍历 wss.clients —— 一台服务上跑多个房间时，遍历全部套接字
  // 会把别的房间（包括已经空掉的房间，实体表是 0 个）的快照塞给所有人。客户端拿到的就是
  // "随机变成没有人的世界 + 陌生 ack"，症状是弹匣数字乱跳、别人凭空消失。
  for (const c of room.clients.values()) {
    const ws = c.ws;
    if (!ws || ws.readyState !== 1) continue;
    // ① 事件在前、闸在后：见文件头那两条纪律。
    if (evMsg) ws.send(evMsg);
    if (ws.bufferedAmount > backlogBytes) {
      if (!c.__stall) { c.__stall = true; stalls.push({ cid: c.cid, backlog: ws.bufferedAmount }); }
      drops++;
      continue;
    }
    c.__stall = false;
    ws.send(buf, { binary: true });
  }
  if (drops) room.__netDrops = (room.__netDrops | 0) + drops;
  return { drops, stalls };
}

// ── 这个 cid 手里还剩几颗雷（搭 pong 那一趟下行给**他自己**，低危账最后一格）──
//
// 为什么必须有一个"服务端主动告知"的口子：这一格两端各按同一份代码自己算（js/weapon-state.js
// 的 beginThrow 里 count--），而它**没有任何自愈机制**。分歧的成因是"有一拍输入没被服务端
// 模拟到"（server/room.mjs:applyInput 的队列溢出）—— 那一拍上的 beginThrow 在客户端本地照扣
// 不误，服务端却从没见过。于是客户端 HUD 显示 0 颗、按 4 没反应，权威端那里其实还有；这份
// 分歧要一直带到重生（respawn 的 fullAmmo 才把它按 max 重置）。它不报错、不崩，只是
// "我少了一颗雷"，正是这一类最难归因的形状。
//
// 为什么搭 pong 而不是进快照：快照是全房共享的**同一块 buffer**（broadcast 一个字节不多地发
// 给所有人），而"还剩几颗"是每人一份 —— 为它把快照改成 per-client 就得动 codec 那几条钉着
// 包长的判据（test/room-bots.mjs 是按 `(len-11)/25` 反推实体数的）。pong 本来就是每连接一份、
// 而且每秒都有一次，自愈窗口 ≤ 一秒，对这个症状够用。
//
// 这两个值按"可能不是数字"交给客户端：同一趟 pong 上的 `c` 就是这么处理的，理由也一样 ——
// 这条通道上的字段来自网络（老服务端没有这一格、中间设备改写过），客户端必须自己校验。
export function nadeCounts(room, cid) {
  if (!room || cid == null) return null;
  const c = room.clients.get(cid);
  const pl = c && c.pl;
  if (!pl || (!pl.lethal && !pl.tactical)) return null;   // 没带投掷物时不带这一格
  return {
    lethal: pl.lethal ? pl.lethal.count : null,
    tactical: pl.tactical ? pl.tactical.count : null,
  };
}
