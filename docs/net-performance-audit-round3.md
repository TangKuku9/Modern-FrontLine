# 联网端网络优化审查 · 第三轮（只挖不改）

- 审查日期：2026-10-04
- 范围：**两端网络路径本身** —— 下行快照/事件的形状与寻址、上行输入的发送与编码、
  客户端网络层（js/net/client.mjs · remote.mjs · predict.mjs）与它驱动的每帧路径。
  前两轮（`net-server-performance-audit.md`、`-round2.md`）已落地的项一律不重复；
  本文**只立账，不动代码**。
- 方式：源码走读 + 带宽量纲推算。本轮没有 profile 取证 —— 涉及协议的项（W2）按第一轮
  立的门槛，动手前必须先有版本化协议设计与基线数据。

## 清单（按收益/风险比排）

### W1 · 定向事件全房广播：每客户端付全量事件的带宽与解析，九成是自己丢掉的

**证据**

- `server/net-server.mjs:broadcast` 把一整份 `evMsg = JSON.stringify({t:'ev',tick,ev})`
  发给房间里的**每一条**连接（经 `server/fanout.mjs`）；`js/net/client.mjs:onEvents`
  开头注释明说："定向事件（to）在服务端是一起下发的……'这句话该给谁看'只能在客户端筛"。
- 逐事件核对客户端消费方式（client.mjs:930-1104）：
  - **只有 `ev.cid === this.cid` 才有人消费**：`hurt`、`flash`、`popup`、`firstBlood`、
    `assist`、`matchStats`、`highAlert`、`streakCharge`（最后一格有判据钉着——
    test/net-feel X 段：别人的 streakCharge 不得改自己的进度）；
  - **`to: 'self' / 'own' / 'foes'` 的 `announce`**：客户端按自己的 cid/team 筛；
  - 真正需要全房广播的只有：`kill`（击杀播报）、`join`/`leave`、`board`、
    `proj`/`turret`/`gone`（表现副本人人要建）、`pickup*`（地上枪人人要画/收）、
    `flagCap`、`wpFires`、别人的 `respawn`（要刷新他的 kits）。
- 事件量纲：`hurt` 被 `HURT_EVERY=12` 拍（0.2s）限流 ⇒ 每个挨打的人最多 5 条/s，
  每条约 95B（含 `from` 三个全精度浮点，见 W5）；`streakCharge` 每次击杀/死亡各一条；
  交火中的满房稳态 evMsg ≈ 1.5~2.5 KB/s，扇出到 16 人 = **24~40 KB/s 房间下行**，
  其中 ~90% 被大多数接收者原地丢弃 —— 而且每个客户端还要为整份 evMsg 付一次
  `JSON.parse`（20Hz × 全量事件 ≈ 每秒几十 KB 的解析，丢掉的事件也在里面）。

**建议**

事件出厂时带寻址（cid / team / to 都已在字段里），`fanout` 按**连接**拆两层：
全房层 + 每连接的定向附件。纪律不破——"事件不可再生"指的是**不许丢**，把只属于
一个人的事件只发给这个人不是丢；旧客户端本来就在客户端筛，少收到它不需要的事件
**向后兼容**。`hurt`/`streakCharge` 这两个高频项先做，announce 的 own/foes 第二步。

**验收**：两端判据全绿（net-feel 的 streakCharge 门、room-flow 的聊天/事件序）；
抓包对比满房交火时每客户端的事件字节数（预期 −70~85%）。

### W2 · 下行大头的天花板：20Hz 全量快照，无增量、无兴趣管理（立账不动手）

**量纲**

- 快照 = 12B 头 + 26B × 实体数，20Hz，**每客户端**：8v8（16 实体）≈ 8.5 KB/s ≈
  68 kbps；16 人满房 + 16 Bot（32 实体）≈ 16.9 KB/s ≈ 135 kbps；16 客户端合计
  ≈ 270 KB/s 服务器出口。这是下行带宽的**单项大头**（事件/聊天/ping 都是零头）。
- 结构性减法只有两条，都要动协议：**增量编码**（多数实体多数拍没变，delta 可省
  50~80%）与**兴趣管理**（按距离/可见性裁实体表）。第一轮已把"快照字段与实体顺序"
  立为红线：动它必须同时有版本化协议 + 客户端兼容策略 + 确定性对照判据。
- 同一层还有一个**架构天花板**：WebSocket over TCP —— 丢包时队头阻塞所有后续快照
  （客户端 2.5s 看门狗 + `INTERP_DELAY` 自适应已经在兜它的症状）。真正的出口是
  WebTransport/WebRTC 不可靠通道，那是换地基，不属于"优化"。

**决定**：不动。本文只把量纲与重开条件立账——移动端/弱网投诉成为常态、或服务器
出口带宽成为扩容成本项时，按第一轮批次 C 的同款流程先取证再设计。

### W3 · 客户端插值：每渲染帧 × 每远端玩家分配一个插值结果对象

**证据**：`js/net/remote.mjs:248` 外推分支 `{...last.s, x, z}`、`:254-270` 插值分支
每次拼一个 ~15 字段的新对象。`NetPlayer.update` 按渲染帧跑（client.mjs:1357）：
144Hz 屏 × 15 个远端 ≈ **2160 个对象/s**（60Hz 屏 ≈ 900/s），每个几百字节 ——
netcode 主循环里最稳的一条 young-gen 分配曲线，低配机上直接变 GC 抖动。

**建议**：每个 NetPlayer 一块可复用的 scratch（或模块级逐字段写入）——插值结果只活
到本次 update 结束、消费全在同一帧内，复用是安全的；注意 `buf` 里的**原始快照不许
动**（跨帧持有），只复用"插值输出"这一份。字段一个都不能少（mag 那次的教训写在
注释里）。

**验收**：test/net-play.mjs 的插值/外推判据逐位不变；`performance.memory` 或
`--trace-gc` 对比稳态分配速率。

### W4 · streak HUD 每模拟拍（60Hz）无条件重建 innerHTML——同文件的门它没抄

**证据**：`js/hud.js:218-226` `streaks()` 直接 `el.innerHTML = list.map(...)`，无任何
变更门；调用点 `js/net/client.mjs:1114` 在 `NetClient.update`（60Hz 模拟拍）里**每拍**
调。同文件自己写过先例：比分条"按 6Hz 刷而不是每拍：它是 innerHTML 赋值，60Hz 刷会
白掉帧"（client.m:1119-1121 的门），标记层也有 `_mSig` 字符串比对门（:1182）——
唯独 streak 这格 60Hz 全量重建，包括"没有连杀槽"时每拍写一次 `innerHTML = ''`。

**建议**：照 `_mSig` 的样子加一个字符串签名门（槽位 id/ready/cost + progress 拼一起），
变了才写。纯客户端渲染改动，两端无协议面。

**验收**：net-feel 的 streak HUD 判据（X2"一到立刻刷"）不变；DevTools Performance
里 60Hz 的 recalc/style 计时消失。

### W5 · 事件 JSON 坐标精度不一致：高频的 `hurt.from` 是全精度浮点

**证据**：`server/room.mjs` 的事件坐标三种精度并存——`wpFires` `toFixed(2)`、
`highAlert` `toFixed(1)`、集束确认 `toFixed(2)`，而**频率最高**的 `hurt` 的
`from: [a.pos.x, a.pos.y, a.pos.z]`（:621 附近）是裸 float64 —— JSON 里每个
~17-19 字符，三个 ≈ 55B 的纯数字。`from` 的唯一消费方是方向指示器（client.mjs:1011
只读它画受击方向），差 0.1m 不可感知。

**建议**：`hurt.from` 限到 1 位小数（每条省 ~40B，满房交火 ≈ 0.6KB/s 房间级——
绝对值小，价值在一致性）。**不要**顺手把 `proj`/`turret`/`respawn` 的坐标也限了：
proj 起手状态喂客户端哑副本的同一套物理，0.01m 的起点差能改变磕墙判定，弹道落点
肉眼可见地分叉——那几位保持全精是隐含契约，动前要立判据。

**验收**：net-feel / net-play 受击方向判据不变；proj 落点对照（同种子）逐位不变。

### W6 · 上行编码的每包/每帧分配

**证据**：`server/codec.mjs:120` `encodeInput` 每次调用 `new DataView(new
ArrayBuffer(INPUT_SIZE))` —— 客户端 60 包/s 各分配一次；`js/net/client.mjs:flush`
（:372-381）每帧再 `new ArrayBuffer(pending.length × 16)` 并把每包 `Uint8Array.set`
拷进去。decodeInput 在第一轮 B1 已经有了 `out/byteOffset` 复用形，encodeInput 是
它的镜像缺口。

**建议**：`encodeInput(inp, out, byteOffset)`（不传时行为不变，与 decodeInput 同款
收口），flush 预-size 一块帧缓冲直接往里编——每包一次拷贝消失。量级小（~60-120
次小分配/s/客户端），但它是上行热路径上最后一处成建分配。

**验收**：codec 自测 + net-audit 字节级判据不变。

### W7 · reconcile 每快照的 `history.filter` 与常开的配对诊断

**证据**：`js/net/client.mjs:497` 每份快照 `this.history.filter(...)` 新建最多 240 项
的数组（20Hz）；`:881-927` 的 pairProbe 在**每个稳态包**上做 12 个 offset ×
`history.find`（各 O(240)）≈ 每秒 5-8 万次迭代——注释明说这是"自我诊断"，但它
常开在生产路径上，量的是恒真/恒假的形状。

**建议**：filter 改复用数组；pairProbe 挂调试开关（`?netdebug` 或 localStorage），
生产稳态不付这笔钱。判据路径（rollback 那些结构断言）不动。

**验收**：test/rollback.mjs、reconcile-chain 全绿；开调试开关时报表读数与现在逐位一致。

### W8 · 顺带观察（非网络，判据未钉、未证实先立账）：`streakReady`/`streak` 漏了 cid 门

**证据**：`js/net/client.mjs:979/986` 对全房广播的 `streakReady`/`streak` 事件
**无条件** `setStreakSlot(ev.id, …)`——写的是**每个客户端自己的**槽位表；同函数上一行
`announce` 却有 `ev.cid === this.cid` 门，隔壁的 `streakCharge` 也有门且有判据钉住
（net-feel X 段）。hud.streaks 直接渲染 `s.ready` ⇒ **别人集齐连杀会点亮我自己的同名槽
（显示"就绪 [i+5]"），他一呼叫又把我的槽灰掉**——窗口期内我按键会被权威端 rejected
（hud 无反馈，正好落进"按了没反应"家族）。

**为什么只立账**：room-bots/net-feel 的现有判据都没有反向钉死"别人的 ready 不得写
我的槽"，所以这是**读码推出来的疑点**而非实测实锤。修法一行（两个调用点加
`ev.cid === this.cid` 门——但 'streak' 的 used 位是否也该只对本人，需要先想清楚
"used" 在 HUD 里有没有对别人的语义），修之前先补一条双向判据。

## 查过并排除的（本轮的"不是问题"）

- **高刷屏灌空帧**：`flush()` 有 `!this.pending.length` 早退（client.mjs:373），
  main.js:912 每渲染帧调一次也只在有货时发包——144Hz 显示器不会把上行消息率抬上去，
  消息率天然 ≈ 60 拍/s。
- **ping 节奏**：1Hz JSON 往返（`localTick % 60`），量纲可忽略；`snapLog`/`buf` 都有
  24 项上限、`history` 240 项上限，客户端内存有界。
- **上行 TCP 零窗积压**：客户端 WS 发送缓冲积压的输入帧是 16B/拍量级，10s 断流
  ≈ 14KB，且服务端 `INPUT_QUEUE` + 拍号判重会正确丢弃——无放大、无泄漏。
- **HTTP 静态 no-cache 每页 ~50 次再验证**：304 无包体 + keep-alive，且"发版本即同步"
  是立过账的取舍（net-server.mjs:226-232 那段）；哈希文件名是构建线的事，不在这轮。
- **permessage-deflate 关闭**：快照是量化字节（高熵），压缩率差、CPU 真花——保持关。
- **大厅/房间帧风暴**：第一轮 A5 已收口（合帧 + roomShared + attach 幂等）。
- **welcome 开局扇出 O(n²)**：只在房主按开始那一刻发生一次（16 × ~4KB ≈ 64KB 突发），
  不值得为它动协议。
- **matchOver 冻结期仍发 20Hz 快照**：给客户端看门狗留命的设计（room.mjs:388-394
  那段长注释），有意保留。

## 建议的实施批次（待批）

- **批次 W-A（向后兼容、判据现成）**：W1（先 hurt/streakCharge 两类）、W4、W6、W7。
- **批次 W-B（要小心判据）**：W3（复用 scratch 的字段完整性）、W5（只动 hurt.from，
  proj/turret 保持全精并补一条"落点逐位不变"判据）。
- **批次 W-C（协议线，先取证再设计）**：W2 增量/兴趣管理 + WebTransport 出口——
  重开条件已写明。
- 另：W8 是一行门 + 一条双向判据的小修，若实锤可与 W-A 同车，但它不是性能项。
