# 联网端网络优化审查 · 第三轮（立账 + W-A/W-B 落地）

- 审查日期：2026-10-04（审查时只读不改）；落地日期：2026-10-05
- 范围：**两端网络路径本身** —— 下行快照/事件的形状与寻址、上行输入的发送与编码、
  客户端网络层（js/net/client.mjs · remote.mjs · predict.mjs）与它驱动的每帧路径。
  前两轮（`net-server-performance-audit.md`、`-round2.md`）已落地的项一律不重复；
  本文主体是**立账**，W-A/W-B 的落地见文末《实施记录》。
- 方式：源码走读 + 带宽量纲推算。本轮没有 profile 取证 —— 涉及协议的项（W2）按第一轮
  立的门槛，动手前必须先有版本化协议设计与基线数据。
- **实施状态（2026-10-05）**：W-A / W-B 已落地 —— W1、W3、W4、W5、W6、W7、W8 全部改完，
  W2 按下方《决定》保持不动。改动清单、纪律与判据见文末《实施记录》。
  本文证据段的**行号与计数已按落地后的代码校正**（原稿是按改动前写的，且当时有若干处
  行号/归属抄错，逐条列在《实施记录》里）。

## 清单（按收益/风险比排）

### W1 · 定向事件全房广播：每客户端付全量事件的带宽与解析，九成是自己丢掉的

**状态**：已落地（`server/fanout.mjs` 的 `splitEvents` / `directedFor` + `net-server.mjs:broadcast`）。

**证据**

- `server/net-server.mjs:broadcast` 把一整份 `evMsg = JSON.stringify({t:'ev',tick,ev})`
  发给房间里的**每一条**连接（经 `server/fanout.mjs`）；`js/net/client.mjs:onEvents`
  开头注释明说："定向事件（to）在服务端是一起下发的……'这句话该给谁看'只能在客户端筛"。
- 逐事件核对客户端消费方式（client.mjs:942-1114），**只有下面这一组**是真正的"只有本人消费"
  （`ev.cid === this.cid` 是唯一入口）：`hurt`、`flash`、`popup`、`firstBlood`、`assist`、
  `matchStats`、`highAlert`、`streakCharge`，以及**同一个坑里的** `streakReady`/`streak`
  （原稿把它们漏在名单外 —— 它们本来就是按 cid 寻址的，只是客户端漏了门，见 W8）。
  `streakCharge` 那一格有判据钉着（test/net-feel X 段：别人的 streakCharge 不得改自己的进度）。
- **`to: 'self' / 'own' / 'foes'` 的 `announce`**：客户端按自己的 cid/team 筛（client.mjs:949-951）。
- 真正需要全房广播的：`kill`（击杀播报）、`join`/`leave`、`board`、`matchOver`、
  `proj`/`turret`/`gone`/`heliHp`（表现副本人人要建/要更新；`heliHp` 原稿漏了 ——
  它无收件人字段却是全房都要的血量读数，room.mjs:574 → client.mjs:1086）、
  `pickup*`（地上枪人人要画/收）、`flagCap`、`wpFires`、别人的 `respawn`（要刷新他的 kits）。
- ⚠ **有两类事件是"混合"的，按 cid 定向会当场出错**（原稿没提，是实现时最容易踩的一脚）：
  `pickupAmmo`/`pickupTake` 的**前半段是全体动作**（`removeGroundPickup(ev.id)`，
  client.mjs:1061/1071 —— 地上那把枪对所有人都得消失），**后半段才分人**（扣弹药/换枪/换套件）；
  `respawn` 同理（自己的整体重置 + 别人的 kits 刷新）。`proj` 也带 `cid`，但消费方
  `spawnProjectile` 对所有人跑 —— **带 cid 字段 ≠ 只能发给这个人**。这几条必须留在全房层。
- 事件量纲：`hurt` 被 `HURT_EVERY=12`（room.mjs:31，判定在 :626）拍限流 ⇒ 每个挨打的人最多
  5 条/s，每条约 95B —— 那是**限精度前**的数字（含 `from` 三个全精度浮点，见 W5），
  W5 落地后每条 ≈ 55B；`streakCharge` 每次击杀/死亡各一条；
  交火中的满房稳态 evMsg ≈ 1.5~2.5 KB/s，扇出到 16 人 = **24~40 KB/s 房间下行**，
  其中 ~90% 被大多数接收者原地丢弃 —— 而且每个客户端还要为整份 evMsg 付一次
  `JSON.parse`（20Hz × 全量事件 ≈ 每秒几十 KB 的解析，丢掉的事件也在里面）。

**建议**

事件出厂时带寻址（cid / team / to 都已在字段里），`fanout` 按**连接**拆两层：
全房层 + 每连接的定向附件。纪律不破——"事件不可再生"指的是**不许丢**，把只属于
一个人的事件只发给这个人不是丢；旧客户端本来就在客户端筛，少收到它不需要的事件
**向后兼容**。**不可寻址的事件必须 fail-open 落回全房层**（宁可多发，绝不静默丢）。
`hurt`/`streakCharge` 这两个高频项先做，announce 的 own/foes 第二步。

**验收**：两端判据全绿（net-feel 的 streakCharge 门、room-flow 的聊天/事件序）；
抓包对比满房交火时每客户端的事件字节数（预期 −70~85%）。

### W2 · 下行大头的天花板：20Hz 全量快照，无增量、无兴趣管理（立账不动手）

**状态**：**不动**（2026-10-05 落地批次刻意不含此项；量纲与重开条件如下）。

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

**状态**：已落地（`js/net/remote.mjs` 每个 NetPlayer 一块 `_s` scratch）。

**证据**：`js/net/remote.mjs:245-254` 外推分支 `{...last.s, x, z}`、`:255-278` 插值分支
每次拼一个 **12 个字段**（x/y/z/yaw/pitch/hp/flags/phase/vx/vz/weapon/mag —— 原稿写"~15"，
逐字段数是 12）的新对象。`NetPlayer.update` 按渲染帧跑（client.mjs:1376 / 1381）：
144Hz 屏 × 15 个远端 ≈ **2160 个对象/s**（60Hz 屏 ≈ 900/s），每个几百字节 ——
netcode 主循环里最稳的一条 young-gen 分配曲线，低配机上直接变 GC 抖动。

**建议**：每个 NetPlayer 一块可复用的 scratch（或模块级逐字段写入）——插值结果只活
到本次 update 结束、消费全在同一帧内，复用是安全的；注意 `buf` 里的**原始快照不许
动**（跨帧持有），只复用"插值输出"这一份。字段一个都不能少（mag 那次的教训写在
注释里）。

**验收**：test/net-play.mjs 的插值/外推判据逐位不变；`performance.memory` 或
`--trace-gc` 对比稳态分配速率。

### W4 · streak HUD 每模拟拍（60Hz）无条件重建 innerHTML——同文件的门它没抄

**状态**：已落地（`js/hud.js:streaks` 的内容签名门 `_stkSig`）。

**证据**：`js/hud.js:218-237` `streaks()` 直接 `el.innerHTML = list.map(...)`，无任何
变更门；调用点 `js/net/client.mjs:1133` 在 `NetClient.update`（60Hz 模拟拍）里**每拍**
调。同文件自己写过先例：比分条"按 6Hz 刷而不是每拍：它是 innerHTML 赋值，60Hz 刷会
白掉帧"（门在 client.mjs:1138-1139，原稿把这个文件名写成了 `client.m`），标记层也有
`_mSig` 字符串比对门（client.mjs:1202）—— 唯独 streak 这格 60Hz 全量重建，包括
"没有连杀槽"时每拍写一次 `innerHTML = ''`。

**建议**：照 `_mSig` 的样子加一个字符串签名门（槽位 id/ready/cost + progress 拼一起），
变了才写。纯客户端渲染改动，两端无协议面。

**验收**：net-feel 的 streak HUD 判据（X2"一到立刻刷"）不变；DevTools Performance
里 60Hz 的 recalc/style 计时消失。

### W5 · 事件 JSON 坐标精度不一致：高频的 `hurt.from` 是全精度浮点

**状态**：已落地（`server/room.mjs:632` 的 `hurt.from` 限 1 位小数）。

**证据**：`server/room.mjs` 的事件坐标只有**两种**精度（原稿写"三种并存 / 集束确认
`toFixed(2)`"，那一条不在 room.mjs 里）：`wpFires` 的 12 处火点 `toFixed(2)`
（:1131）、`highAlert` 的 `toFixed(1)`（:182）；而**频率最高**的 `hurt` 的
`from: [a.pos.x, a.pos.y, a.pos.z]`（:632，原稿写":621 附近"）是裸 float64 —— JSON 里每个
~17-19 字符，三个 ≈ 55B 的纯数字。
（`.toFixed()` 在 room.mjs 里还出现在 :176 `flash.dur`、:1091 `progress`、
:1082 诊断用的 `why.dist` —— 那几个都不是事件坐标，别混进来。）
原稿把"集束确认 `toFixed(2)`"记在 room.mjs：实际是**上行**窄帧
`js/net/client.mjs:1245` 的 `{t:'streak', slot, x, z}`（玩家在屏幕上点落点那一发），
方向与服务端相反，也不该在这条账里。
`from` 的唯一消费方是方向指示器 —— 但**不是** client.mjs 直接读：client.mjs:1034 只把它
转交给 `game.onNetHurt`，真正读 `ev.from` 画受击方向的是 `js/main.js:477`
（`hud.damageFrom`）。差 0.1m 不可感知。

**建议**：`hurt.from` 限到 1 位小数（每条省 ~40B，满房交火 ≈ 0.6KB/s 房间级——
绝对值小，价值在一致性）。**不要**顺手把 `proj`/`turret`/`respawn` 的坐标也限了：
proj 起手状态喂客户端哑副本的同一套物理，0.01m 的起点差能改变磕墙判定，弹道落点
肉眼可见地分叉——那几位保持全精是隐含契约，动前要立判据。

**验收**：net-feel / net-play 受击方向判据不变；proj 落点对照（同种子）逐位不变。

### W6 · 上行编码的每包/每帧分配

**状态**：已落地（`encodeInput(inp, out, byteOffset)` + `flush()` 按偏移直编）。

**证据**：`server/codec.mjs:123` `encodeInput` 每次调用 `new DataView(new
ArrayBuffer(INPUT_SIZE))`（默认参数在 :124）—— 客户端 60 包/s 各分配一次；
`js/net/client.mjs:flush`（:372-383）每帧再 `new ArrayBuffer(pending.length × 16)`
并把每包 `Uint8Array.set` 拷进去。decodeInput 在第一轮 B1 已经有了 `out/byteOffset`
复用形（codec.mjs:141），encodeInput 是它的镜像缺口。

**建议**：`encodeInput(inp, out, byteOffset)`（不传时行为不变，与 decodeInput 同款
收口），flush 预-size 一块帧缓冲直接往里编——每包一次拷贝消失。量级小（~60-120
次小分配/s/客户端），但它是上行热路径上最后一处成建分配。

**验收**：codec 自测 + net-audit 字节级判据不变。

### W7 · reconcile 每快照的 `history.filter` 与常开的配对诊断

**状态**：已落地（`_win` 复用数组 + pairProbe 挂到 `netDebug`）。

**证据**：`js/net/client.mjs:503` 每份快照 `this.history.filter(...)` 新建最多 240 项
的数组（20Hz）；`:892-938` 的 pairProbe 在**每个稳态包**上做 **13 个 offset**
（:903 那张表）+ **一次重取的 `distAt(0)`**（:906）= 14 次 `history.find`（各 O(240)）
≈ 每秒 **6~7 万**次迭代（原稿写"12 个 offset / 5-8 万"，逐个数是 13+1）——
注释明说这是"自我诊断"，但它常开在生产路径上，量的是恒真/恒假的形状。

**建议**：filter 改复用数组；pairProbe 挂调试开关（`?netdebug` 或 localStorage），
生产稳态不付这笔钱。判据路径（rollback 那些结构断言）不动。

**验收**：test/rollback.mjs、reconcile-chain 全绿；开调试开关时报表读数与现在逐位一致。

### W8 · 顺带观察（非网络，判据未钉、未证实先立账）：`streakReady`/`streak` 漏了 cid 门

**状态**：已落地（两个调用点补 cid 门 + test/net-feel V9b–V9e 双向判据）。

**证据**：`js/net/client.mjs:979/986`（落地后行号 `:995` / `:1006`）对全房广播的
`streakReady`/`streak` 事件**无条件** `setStreakSlot(ev.id, …)`——写的是**每个客户端
自己的**槽位表；**紧跟着的下一行**（原稿写"上一行"，方向抄反了）那个
`if (ev.cid === this.cid) {` 只圈住了 `announce` 播报，**没圈住它上面那句
`setStreakSlot`** —— 形状恰恰是"门就在隔壁、但没罩住该罩的那一句"。
隔壁的 `streakCharge` 也有门且有判据钉住（net-feel X 段）。hud.streaks 直接渲染
`s.ready` ⇒ **别人集齐连杀会点亮我自己的同名槽（显示"就绪 [i+5]"），他一呼叫又把我
的槽灰掉**——窗口期内我按键会被权威端 rejected（hud 无反馈，正好落进"按了没反应"家族）。

**为什么当初只立账**：room-bots/net-feel 的现有判据都没有反向钉死"别人的 ready 不得写
我的槽"，所以这是**读码推出来的疑点**而非实测实锤。修法一行（两个调用点加
`ev.cid === this.cid` 门——但 'streak' 的 used 位是否也该只对本人，需要先想清楚
"used" 在 HUD 里有没有对别人的语义），修之前先补一条双向判据。
落地时按这条办：**先补判据再改门** —— net-feel V9b/V9d 是反证臂（别人的 ready/呼叫
不许动我的槽），V9c/V9e 是先决臂（我的必须动）；'used' 位的语义核清后确认 HUD 不渲染它
（语义在 js/match-rules.js 的账本里），所以整个 `setStreakSlot` 一起进 cid 门。

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
- **matchOver 冻结期仍发 20Hz 快照**：给客户端看门狗留命的设计（room.mjs:392-397
  那段长注释，原稿写":388-394"），有意保留。

## 建议的实施批次（2026-10-05 执行结果）

- **批次 W-A（向后兼容、判据现成）**：W1（先 hurt/streakCharge 两类）、W4、W6、W7 —— ✅ 已落地。
- **批次 W-B（要小心判据）**：W3（复用 scratch 的字段完整性）、W5（只动 hurt.from，
  proj/turret 保持全精并补一条"落点逐位不变"判据）—— ✅ 已落地。
- **批次 W-C（协议线，先取证再设计）**：W2 增量/兴趣管理 + WebTransport 出口——
  重开条件已写明。⏸ **未做**（本次刻意不含）。
- 另：W8 是一行门 + 一条双向判据的小修，若实锤可与 W-A 同车，但它不是性能项。
  ✅ 已随车落地（先补双向判据再改门）。

## 实施记录（2026-10-05）

**改了什么**（10 个文件，+217/−46）：
`js/hud.js`（W4）、`js/net/client.mjs`（W6/W7/W8）、`js/net/remote.mjs`（W3）、
`server/codec.mjs`（W6）、`server/fanout.mjs` + `server/net-server.mjs`（W1）、
`server/room.mjs`（W5）；判据 `test/net-audit.mjs`（W1 新增 D12–D17）、
`test/net-feel.mjs`（W8 新增 V9b–V9e）、`test/net-play.mjs`（W7：页面补 `&netdebug=1`）。

**纪律（落地时守住的三条）**

1. **两层都在背压门之前。** 定向帧（`directedFor`）在 `evMsg` 之后、背压门之前发；
   顺序仍是 `events → snapshot → gate`。不可寻址的事件 **fail-open** 落回共享层。
2. **`flush()` 的缓冲仍每帧新开。** 复用上一帧那块会在 ws 积压时覆写还没发出去的字节 ——
   W6 只省"每包一次分配与拷贝"，安全边界一步没动。
3. **W7 只把 pairProbe 的计算挂到 `netDebug` 之后**，诊断状态字段（`pairProbe`
   /`steadyWorst`/`missWhy`）一个没删，否则 `test/net-play.mjs` 会读到不同值；
   页面 URL 补了 `&netdebug=1`，不然那些断言会静默不跑。

**判据**：net-audit **111/111**、net-feel **212/212**、docs-guard 27/27；
全矩阵（codec / rollback 79 / reconcile-chain 23 / mp-rules 158 / room-bots 48 /
room-dir 36 / heli-armor 53 / lagcomp 144×2 / accounts 162 / image 18 /
net-play 真浏览器 93 / net-drop 94 / state-leak 48 / optic 35 …）全绿。

**已知非回归红**：`test/hardening.mjs` J12–J18（`server/recover.mjs` / `audit-dump.mjs`
的 `spawnSync` CLI 段）在本沙箱必然红 —— 干净树上重跑同为 RED 118/125，
独立 `spawnSync` 探针也返回 `status null, error EBUSY`。与本次改动无关。

**本次一并校正的原稿笔误**（逐条，备查）：W5 的"集束确认 `toFixed(2)` 在 room.mjs"
（实际是上行窄帧 `client.mjs:1245`，room.mjs 只有 `wpFires`/`highAlert` 两处事件坐标精度）；
W5 `hurt.from` 行号 `:621`→`:632`、消费方 `client.mjs:1011`→`main.js:477`；
W7 "12 个 offset / 5-8 万" → 13 个 + 一次重取 `distAt(0)`；
W3 "~15 字段" → 12 个；W4 文件名 `client.m` → `client.mjs`、`_mSig` 门 `:1182`→`:1202`；
W8 "同函数**上一行** announce 有门" → 门在**下一行**且没罩住 `setStreakSlot`；
W1 全房层名单漏了 `heliHp`（并补上 `matchOver` 与"混合事件"警示）；
排除清单 matchOver 注释 `:388-394`→`:392-397`。
