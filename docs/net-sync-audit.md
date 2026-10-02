# 联网对战同步审计：漏洞与不足清单

审计对象：`js/`（客户端与两端共用的 sim）+ `server/`（权威端）+ `js/net/`（联机表现层）。
审计焦点：**服务器与客户端之间的同步**，兼看联机服务面的漏洞。
方法：只读走查。同步主链路（`server/room.mjs`、`server/net-server.mjs`、`server/codec.mjs`、
`server/lagcomp.mjs`、`js/net/client.mjs`、`js/net/predict.mjs`、`js/net/remote.mjs`、`js/mp.js`
及 `js/main.js`/`js/player.js` 的接线段）逐文件精读；外围（`http-api`、`accounts`、`lobby`、
`room-dir`、`store`、`chat`、`idle-ruler`）逐文件核对。全部结论附 `文件:行号`。

- 审计日期：2026-10-01
- 基线：`feature/net-authoritative` @ b18b705（附十八之后）
- 本文只列问题，不含修法落地；每条高危/中危给了修法方向。
- **2026-10-02 补记：清单里的条目已全部落地**（3 高危 / 11 中危 / 低危一组），
  逐条的落点与钉它的判据见文末《六、修复落点与判据》。唯一一条**刻意不改**的是
  "跨台票证放 URL query"（设计上讨论过的取舍，作为残余风险记档）。

---

## 总评

这套 netcode 的**骨架是健康的**：服务端权威 60Hz 模拟、客户端回滚重放、view 拍号延迟补偿、
快照定点量化、玩法随机流同步——这条主链路的每一环都有判据钉着（详见文末《查过且干净的部分》）。
本轮找到 **3 个高危、11 个中危、若干低危** 的新问题，全部是既有十八轮收口之外的新发现。

最重的一条：**玩家的鼠标灵敏度设置在联机里根本不生效**——服务端拿硬编码默认值积分视角、
再按快照覆盖客户端，调过滑条的玩家全程橡皮筋。

---

## 一、高危

### H1. 灵敏度 / 反转Y 不进协议——联机里视角被服务端的默认值接管

**证据链**：

- 客户端灵敏度是用户可调的：`js/menu.js:1262`（滑条 0.2–3.0）、`js/menu.js:1265`（`invertY` 开关），
  从 localStorage 读入（`js/main.js:77`）。
- 视角积分在**两端同一份代码**里做：`this.yaw -= input.mdx * sens`（`js/player.js:220`）、
  `this.pitch -= input.mdy * sens * invertY...`（`js/player.js:221`），而 `sens` 读的是
  `game.settings.sens`（`js/player.js:219`）。
- 服务端的 `game.settings` 是**硬编码默认值** `{sens: 1.0, adsSens: 0.9, invertY: false}`
  （`server/headless-game.mjs:40`）；`NetRoom` 建 `HeadlessGame()` 时不传任何设置
  （`server/room.mjs:146`）；join 帧也不带设置（`js/net/client.mjs:102`）。
- yaw/pitch 由服务端权威：`js/net/predict.mjs:108` 每份快照无条件覆盖 `pl.yaw/pl.pitch`。

**症状**：任何 sens ≠ 1.0 的玩家，联机里的实际转向速率被钉死在 1.0——本地预测按自己的 sens
转快了/转慢了，20Hz 被快照拽回来，表现为持续的"甩枪被弹回"橡皮筋；`invertY` 用户更糟：
本地上下反转预测、权威端不反转，垂直瞄准直接打架。设置滑条越偏离 1.0，抖得越凶。

**为什么现有判据量不出**：所有测试两端都用默认 sens 1.0，天然对齐。

**修法方向**：join 帧带上 `sens/adsSens/invertY`，在 `addClient` 里挂到 **Player 身上**
（注意 sens 是**每人一份**，不能挂在房间唯一的 `game.settings` 上——一个房间两个人的
灵敏度不同），`player._sim` 读 `this.sens ?? game.settings.sens`。回滚重放不受影响
（journal 不含视角灵敏度，重演时用同一份即可）。

### H2. 广播背压闸把"不可再生"的事件连同快照一起丢了——与自己的设计注释相反

**证据**：

- `server/net-server.mjs:66-71` 的注释明确说：积压超限**跳过二进制快照**——
  "事件很小且不可再生，**照发**"。
- 但实现里 `continue` 在发事件**之前**（`server/net-server.mjs:896-907`）：
  背压连接连 `evMsg` 一起跳过。

**症状**：手机切后台 / TCP 零窗几秒后恢复的玩家，窗口里发生的
`respawn / kill / proj / turret / pickup / flash / hurt` 事件**永久丢失**
（events 是 splice 排干、无重传）。具体到玩法：

- 漏了 `respawn` 事件 ⇒ 客户端不做整体重置（`hardSnap` 不置、日记本不清），
  重生传送被当成普通校正——一次硬拉回死点；
- 漏了 `proj` ⇒ "被看不见的雷炸死"（这恰是第十八轮刚收口过的那类症状，从背压这条缝又漏回来了）；
- 漏了 `pickup/pickupTake` ⇒ 地上的枪与权威端各说各话。

**修法方向**：把 `evMsg` 的发送挪到背压判定之前（事件本就很小）；或给每连接留一个
有限长的待发事件队列，恢复后补发。

### H3. 一条连接可以"身在 A 局、再开 B 局"——旧局留下永久幽灵玩家，房间永不回收

**证据**：

- 直连 join 有守卫：`server/net-server.mjs:1027`（`ws.__cid != null` 拒绝，"一条连接只许进一个房间"）。
- 但大厅链路**没有**：`createRoom/joinRoom/start`（`server/lobby.mjs:333,362,576`）和
  `beginLive → enterMatch`（`server/net-server.mjs:584-588`）都不检查这条 ws 是否已在
  live 对局里；`enterMatch` 直接覆盖 `ws.__cid/ws.__room`。
- close 处理只认当前 `ws.__room`（`server/net-server.mjs:1126-1127`）——旧房的 client 条目
  从此没有任何路径会再调 `removeClient`。

**症状**：恶意/异常客户端先 join 一间活房，再 `createRoom + start`：旧房里他的 client 条目
还在 `clients` 表和 `game.entities` 里，但 `ws.__cid` 已指向新房。于是：

- 幽灵永远占着 `clients.size ≥ 1` ⇒ 空房回收永远不触发（`server/net-server.mjs:915-924`）；
- 一份 60Hz sim + 一个打不死的记分板实体（死了自动重生，`server/room.mjs:384-416`）永久空转；
- 访客服（REQUIRE_ACCOUNT=0）下建房不占配额（`server/net-server.mjs:543` 只查登录用户），
  **32 间 MAX_ROOMS 可被幽灵全部占死，直到重启进程**——房间里还能塞满真人时新客进不来。

**修法方向**：`createRoom/joinRoom/start`（或收口到 `enterMatch` 一处）拒绝 `ws.__cid != null`
的连接，与 join 同一条纪律。反向同理：等待房座位若已在 live 局里，开局前应先把座位摘掉。

---

## 二、中危

### 同步面

#### M1. 上行鼠标位移被 i16 钳制在 ±327.67 px/拍，快速甩枪必被削

- `Q.packLook` 按 `LOOK_STEP=0.01` 打进 i16（`js/quant.js:8,20`）；客户端上行在
  `encodeInput` 处就已钳制（`server/codec.mjs:116`）。
- 每拍 16ms、原始 movementX 累加（`js/main.js:544`）。高 DPI（1600+）下一次用力甩枪
  轻松超过 327/拍。
- 本地预测用全量、服务端用钳后值，快照再拽回——症状是"高 DPI 下快速甩枪视角弹回"。
  与 H1 叠加时更明显。
- 顺带记档：`packPos` ±327m 的钳制在现役地图内无害。

#### M2. 输入队列满后静默丢拍；后台恢复时整窗陈旧输入被慢放一秒

- `INPUT_QUEUE=60` 满，新输入直接丢（`server/room.mjs:346`），**无 `/healthz` 计数**
  （lagcomp/streak 都有读数，队列溢出没有——恰好是"我明明在走他却站着"这类静默失效）。
- 后台标签页恢复时客户端一次性 flush 几百拍，队列只收最旧 60 拍并被慢速消费，
  期间人物按一秒前的输入走（`server/room.mjs:363-382`）。重生时有清队逻辑
  （`server/room.mjs:404`），普通恢复没有。

#### M3. 名字寻址在重名时串人

- 访客服允许重名：不填名字都叫"访客"（`server/net-server.mjs:47`）。
- 服务端认尸已用 `!alive` 消歧（`server/room.mjs:1047`），但 `killExtra` 的 pts/tags
  按名字配对（`server/room.mjs:1052`）仍会串。
- 客户端 `ev.victim === player.name` 判自己死亡（`js/net/client.mjs:832`）——
  **同名者死亡，两台机器同时弹死亡画面**。
- `remoteByName`（`js/net/client.mjs:367`）、私聊/举报/屏蔽目标全按名字找人，同样串。

### 服务面（探查代理逐文件核实，均附行号）

#### M4. verifyClient 的每 IP 连接闸有异步窗口（TOCTOU）

`connsByIp` 只在 `connection` 事件 +1（`server/net-server.mjs:986`），而账号鉴权
`sessionOf().then` 异步放行（`server/net-server.mjs:426-440`）——同 IP 并发握手全在计数前
读旧值，`connsPerIp=6` 可被并发握手绕过，占满 `maxClients` 关门。

#### M5. WS Origin 白名单 `endsWith` 无点边界

`server/net-server.mjs:409`：`ALLOW_ORIGIN=example.com` 会放行 `https://evilexample.com`
（`origin.endsWith('example.com')` 为真）。正确写法应以 `.example.com` 为界。

#### M6. RateLimiter 的 `fails` 表条目永不回收；登录/恢复额度实际翻倍

- 容量裁剪只删 `hits`（`server/accounts.mjs:238-244`），一次失败登录的条目（n≥1）永驻内存
  （只有 `succeed()` 会删），且 `prune()` 每次全表遍历——多 IP 慢速灌登录可无限涨内存
  叠加渐进 CPU。
- "登录/恢复共用限流表"的注释与实现不符：key 前缀分开（`recov-*` vs `login-*`）⇒
  `hit()` 的上限是 per-key 的，同一 IP 实际 24 次/5 分钟而非 12 次
  （`server/accounts.mjs:519-528`）。

#### M7. `/api/rooms`、`/api/dispatch` 与 WS 大厅帧无帧型限速，直写共享 SQLite

- 访客服下 `/api/rooms` 匿名可达（`server/http-api.mjs:296-318`），每次调用对**跨进程共享**
  的房间目录 SQLite 跑两条无条件 DELETE（`room-dir.mjs` 的 `list→sweep`，`server/room-dir.mjs:106-123`）。
- `/api/dispatch` 登录后无限速（`server/http-api.mjs:407-439`），每次再叠一条 ticket INSERT。
- 一条 WS 连接 240 帧/秒的 createRoom/leaveRoom 循环（总闸 `wsMsgPerSec` 不分帧型，
  `server/net-server.mjs:233-234,1096-1098`），每次成功触发全大厅广播 + 目录写放大。
- 共享库的写锁/busy 排队会拖慢所有参与进程的心跳。

#### M8. SQLite `audit` 表只写不删，且被限流的请求也落一行

`server/store.mjs:51-57,190-193`：内存版有 5000 条上限，SQLite 版没有——注释称
"频率天然被限流器压着"，但限流键是 IP，多 IP 下照旧 unlimited；每种结局（含 429 本身）
都直写一行。磁盘与 WAL 无限增长。

#### M9. 大厅层断线零反馈；"正在进房…"可永久卡死

- `lobby.mjs` 的 `onclose` 不触发任何回调（`js/net/lobby.mjs:59-63`）：房表不再刷、
  按钮静默失灵、"正在进入大厅…"文案在已断线时撒谎（`js/menu.js:689`）。
  对局层有完整的 `netLostUi` + Enter 重连（`js/main.js:589-607`），大厅层没有。
- `send()` 在 readyState≠1 时静默丢帧（`js/net/lobby.mjs:82`）；`onlineCreate/onlineQuick/
  onlineJoin` 发帧前不查 `lb.connected`（`js/menu.js:618-642`）——大厅未连上（或已断）时
  点"创建房间"，帧没了、`onRoomFrame`/`onlineError` 都不会来，全屏无按钮加载层
  （`js/main.js:327` + `js/menu.js:257`）**永久卡死，唯一出路 F5**。

#### M10. 来自其他玩家的字符串有三处不过 `escHtml` 就进 innerHTML（纵深防御缺口）

- 记分板 `r.name`（`js/net/client.mjs:1334`）；
- 击杀提示 `victim.name`（`js/hud.js:81-82`；weapon 过了 escHtml，名字没过）；
- 服务端 note 帧 `msg`（`js/main.js:322`——同文件 `:601` 的同类内容却转义了）。

当前被呼号白名单（`NAME_RE`）压死，属 defense-in-depth：白名单一放宽、换服、或接入跨服
目录就是存储型 XSS。另外仓库里有**三套口径不一的转义器**
（`js/main.js:34` 只删 `<>`、`js/menu.js:50` 不转单引号、`js/net/chat.mjs:33` 最全）——
分叉本身就是下一个洞的温床。

#### M11. per-tab 会话 cookie 副本堆积；登出不清其他标签页

- 每个标签页登录都把**同一份完整令牌**复制进可预测名字的 cookie（`server/http-api.mjs:225-226`，
  名字规则 `:151`，Path=/、无 `__Host-` 前缀，同站子域可投掷遮蔽）。
- 登出只清当前 tab 那枚（`server/http-api.mjs:460-462`）——其余标签页的**仍有效令牌**
  留到 TTL；每条 /api 请求把全部副本背在 Cookie 头上，多标签页重度使用会逼近
  per-domain cookie 上限、可能挤掉主 cookie。
- `?tab=` 明文进 WS URL（`js/net/client.mjs:31`，与 `?ticket=` 同一先例），
  落代理/访问日志，可把"哪枚 cookie 是活跃身份"关联出来。

---

## 三、低危

### 同步/表现面

- **哑副本不对称**：`Sentry` 构造函数无条件进 `game.entities`（`js/mp.js:532`，不看 `dumb`），
  客户端哑机枪会被本地子弹"假打死"（本地爆炸 + popup），而权威机枪还活着，且与 `gone`
  事件带回的 popup 重复；`Heli` 哑副本刻意不进表（`js/mp.js:673`）。两类实体两种口径。
- **`fixedStep=false` 时联机必坏且无声**：变步长分支不 `tick++`（`js/main.js:808-821`），
  `this.tick` 恒 0，所有上行输入被服务端当重复包丢弃（`server/room.mjs:341-342` 的 d===0）。
  该开关虽不在菜单暴露，但 localStorage 里残留旧值即中招；联机路径应强制固定步长。
- **idle-ruler 对 deficit=1 结构性漏报**：残差恰好等于一拍位移时 `corrected > ruler` 用严格大于
  判不出（`js/net/idle-ruler.mjs:36`；`js/net/client.mjs:674` 注释自认"残差恰好等于 deficit
  拍的位移"）。这把尺子只能抓 ≥2 拍的漏补，最单薄的单拍漏补恒绿——**假绿方向**。
  下限臂同理：慢速区间（<1.2 m/s）单拍缺口 <2cm 同样判不出。
- **退路尺子硬编码 /60**：`js/net/idle-ruler.mjs:34` 假定 60Hz 拍频；welcome 明明带了
  `serverTick` 却没用它校验。拍频一变量具静默失准。
- **`view=0` 入场窗口**：设计好的退化（noView 计数），不算缺陷，记档备查。
- **投掷物计数无快照字段**：投掷物数量（lethal/tactical）两端各记各的，输入丢失
  （M2 的队列满）后会分歧且当局不自愈，要等重生 `fullAmmo` 重置才对齐。

### 服务/协议面

- **词汇/常数漂移一组**（两文件对同一约定各写一份的实例）：
  - 房号白名单两处实现，截断 32 vs 48（`server/lobby.mjs:84` vs `server/net-server.mjs:565`）；
  - `pickRoom` 硬编码 16 而不用导出的 `MAX_SEATS`（`server/net-server.mjs:573`）——
    正是 `server/lobby.mjs:24-25` 注释预言的漂移形状；
  - accounts 发 `hash_failed`、http-api 只认 `hashing_failed`（`server/accounts.mjs:394`
    vs `server/http-api.mjs:56`）——scrypt 抛错时 500 语义丢失；
  - live 房的 `/api/rooms` 行缺 `time/score/host/bots` 字段（`server/net-server.mjs:262-271`），
    与大厅 `brief()`（`server/lobby.mjs:155-166`）和目录行形状不一致。
- **pong 的 `c` 无类型校验**：`js/net/client.mjs:192` `performance.now() - j.c`，非 number 得
  NaN，记分板网络行印 "ping NaN ms"（`:1345`）。
- **`lobby.connect()` 在 CONNECTING 时也 resolve**（`js/net/lobby.mjs:51`，`readyState <= 1`）：
  调用方拿到 resolve 立刻发帧，部分浏览器抛 InvalidStateError，用户看到原始异常文案。
- **畸形 cookie 的 URIError**：`parseCookies` 的 `decodeURIComponent('%')` 抛错
  （`server/http-api.mjs:85-94`），HTTP 侧落通用 400 + 每次一条错误堆栈进日志，可刷日志噪音。
- **`/api/status` 公开注册用户总数**（`server/http-api.mjs:238-242`）：站点规模情报免费送。
- **tab 会话失效不回退 legacy cookie**（`server/http-api.mjs:158-165`）：注释说"查不到再退回
  老名字"，实现是"cookie 在但服务端行没了"直接 null——保守方向的偏差，无安全后果。
- **跨台票证放 URL query**（`server/net-server.mjs:288-291`；`server/room-dir.mjs:130-134`）：
  bearer 凭证必然落反代 access log / 浏览器历史，泄露面比 HttpOnly cookie 大一截。
  设计已知取舍，记档为残余风险。
- **`wss.clients.size > CFG.maxClients` 差一**（`server/net-server.mjs:1029`）：满员判断用
  严格大于，实际可超 1 人。
- **`room.__netStall` 是房间级边沿旗、日志却印 cid**（`server/net-server.mjs:897`）：
  多人同时积压时只有第一条带 cid，排障读数有歧义（与 H2 一起改）。

---

## 四、查过且干净的部分（不必重审）

- **延迟补偿防作弊面**：`rewindTick` 四道拒绝臂全部有"刚刚合法"的邻居用例
  （`server/lagcomp.mjs:61-69` + 自测）；view 拍号被 `lastSnapSent` 钉死，乱报一秒回溯拿不到；
  环形缓冲查不到该拍退回当下而非拒绝整枪。
- **回滚重放的记账**：rep/lead/carry/landed 那条链的每一类失真都有命名账
  （carryMiss/qDrop/repSkipped/foldBad/caughtUp…），基态漂移问题已用 landed 直接传递解决
  （`js/net/predict.mjs:116-129`）；"写回 win[0].j"那个历史坑有 C7 守卫钉着。
- **玩法随机流**：快照头带 `rngState`（`server/codec.mjs:36`）、journal 带私有流游标
  （`js/player.js:160-171`），重放不会永久错开。
- **传输健壮性**：maxPayload 64KB、慢速攻击超时（requestTimeout/headersTimeout）、
  ws error 必接（否则单访客坏包杀进程）、心跳 15s 拆半开连接、逐房广播不串房
  （broadcast 按 `room.clients` 发而非遍历全部连接）、优雅下线 1001、坏 tick 计数到阈值
  先通知再停循环。
- **账号安全**：scrypt（N=2^15 异步 + 显式 maxmem）+ 恒时比较（含长度差掩蔽）+ 256 位令牌
  只存 sha256、恢复码 60 位无偏采样一次一用、SQL 全参数化、静态服务路径遍历白名单、
  recover 固定跑满防计时侧信道、注册/登录/恢复按呼号串行覆盖了进程内 TOCTOU。
- **协议自测**：`server/codec.mjs` 的量化误差、u16 全量程、按键往返表、相位折叠判据，
  以及 `server/lagcomp.mjs` 的邻居臂——这些量具本身是健康的（idle-ruler 的两个盲区除外，见低危）。

---

## 五、建议的修复顺序

| 序 | 条目 | 一句话改法 | 影响面 |
|----|------|-----------|--------|
| 1 | H1 | join 帧带 `sens/adsSens/invertY`，`addClient` 挂到 Player，`_sim` 读每人一份 | 每个调过灵敏度的玩家 |
| 2 | H2 | `evMsg` 挪出背压闸（或每连接补发队列） | 断网恢复的玩家 |
| 3 | H3 | `enterMatch` 一条守卫拒绝已在局的连接 | 服务器的长期存活 |
| 4 | M1 | LOOK_STEP 不动、把 packLook 的钳制上限放宽到按"每拍最大角速度"折算 | 高 DPI 甩枪 |
| 5 | M2 | 队列满计数进 `/healthz`；恢复时按"最新 60 拍"入队而非"最旧 60 拍" | 卡顿恢复体验 |
| 6 | M4/M5 | verifyClient 计数挪到 done(true) 前；endsWith 加点边界 | 公网部署 |

其余中危按"静默失效优先"排：M6（内存泄漏）→ M7（共享库写放大）→ M9（大厅断线 UX）→
M3（重名串人）→ M8 → M10/M11。低危攒一批一轮收。

---

## 六、修复落点与判据（2026-10-02 补）

按上面的顺序逐条落地。**每条都配了判据**，且判据本身各有反证臂 —— 做法是把源码注入回审计
点名的旧写法（`if (v <= inv.count)` 改成 `===`、把 `!this.net` 摘掉、把事件挪回闸后……），
跑一遍必须变红才写进表里。这一轮一共做了 7 条这样的负对照，全部复绿后才收工。

| 条目 | 落地位置 | 钉它的判据 |
|------|----------|-----------|
| H1 灵敏度 / 反转Y | join 帧与 createRoom/joinRoom/quickRoom 三帧带 `view` → `addClient` 用 `sanitizeViewSettings` 重建后挂**每人一份** `pl.sens/adsSens/invertY` → `js/player.js:_sim` 读时 `??` 兜回 `game.settings` | `test/net-audit.mjs` A/B/C |
| H2 背压闸丢事件 | 抽出 `server/fanout.mjs`：事件排在闸**之前**（快照在闸之后）；边沿旗挂在**连接**上（`c.__stall`），日志才带得对人的 cid | `test/net-audit.mjs` D |
| H3 一条连接一个座 | `enterMatch` 一处收口（join 帧 / 房主开局都过它）+ 大厅三帧拒绝 `ws.__cid != null` + `beginLive` 开局前清座；`reJoinInLive/ghostBlocked/ghostEvicted` 三个计数进 `/healthz` | `test/service-guards.mjs` A |
| M1 鼠标位移量程 | `LOOK_STEP = 1/32`、`LOOK_MAX = 1000`（按"每拍最大角速度"折算 ≈1513°/s），并导出 `roundLook` —— **本地预测用上行那一个量化后的数**，两端再不会在甩枪上分家 | `test/net-audit.mjs` E |
| M2 输入队列溢出 | 溢出时 `shift()` 丢**最旧**的一拍（不再是丢刚收到的），`qDrop` 计数进 `/healthz` 的 `per[]` | `test/net-audit.mjs` G + `test/service-guards.mjs` B |
| M3 重名串人 | `onKill` 往队尾那条 kill 事件回填 `killerCid/victimCid`；认尸、奖章配对、死亡画面、播报、镜头一律**先认 cid**，名字退成"老服务端 / Bot / 自杀"的兜底；私聊与举报在重名时**拒绝而不是挑第一个** | `test/net-audit.mjs` F |
| M4 每 IP 名额 TOCTOU | 占位挪到 `verifyClient` 的 `await` **之前**，每条拒绝出口都 `release()`；`connReserved/connReleased` 与在线数守恒 | `test/service-guards.mjs` D |
| M5 来源白名单边界 | `originAllowed()`：裸域名按 `://` 或 `.` 边界匹配，`evilexample.com` 不再命中 `example.com`；`originRefused` 计数 | `test/service-guards.mjs` C |
| M6 限流表寿命 / 额度翻倍 | `fails` 条目按**最后一次失败**算 24h 寿命（`lastAt`）；登录与恢复共用同一副键（`auth-ip/auth-name`）⇒ 额度不再是两份 | `test/accounts.mjs` M 段 |
| M7 帧型闸门 | `/api/rooms`、`/api/dispatch` 加按 IP 的 `readPerMin`；`HEAVY_FRAMES`（建房/进房/退房…）按**连接**走最小间隔且被限的有回音；目录 `list→sweep` 解耦 | `test/service-guards.mjs` E/F |
| M8 审计表无限增长 | SQLite 版补 `AUDIT_CAP`(20000) + 每 500 条裁一次；**被限流的结局不落库**，改记 `stat.auditSkipped` | `test/accounts.mjs` N 段 |
| M9 大厅断线零反馈 | `LobbyClient` 补 `onclose/onerror → onClose(lost, reason)`（掉线是**边沿**不是电平；自己 close 的不报错）；`send()` 返回布尔；三处进房入口在不是 OPEN 时返回 false；握手期就断让 `connect()` reject | `test/net-audit.mjs` H |
| M10 转义分叉 | 全仓只留 `js/escape.js` 一份，五个持有者改为 import；形状守卫钉住"谁都不许再抄一份" | `test/net-audit.mjs` I |
| M11 会话副本 | HTTPS 下一律 `__Host-` 前缀（明文下不许带）；登出吊销**整个身份**（另一个标签页一起下线是**有意的**代价）；标签页选择器改走 WS **子协议**，`?tab=` 不再被采信；`logoutRevoked` 进 `/healthz` | `test/service-guards.mjs` G + `test/hardening.mjs` K + `test/tab-session.mjs` |
| 低危 · 哑副本不对称 | `Sentry` 构造函数与 `Heli` 同一口径：`dumb` 副本不进 `game.entities`（权威端独占"这台机器上能裁决它血量"的名单） | `test/heli-armor.mjs` + `test/net-feel.mjs` |
| 低危 · `fixedStep=false` 联机必坏 | 变步长那一支加了 `&& !this.net`：联机入口强制固定步长（`tick` 恒 0 = 每包被当重复包丢弃） | `test/net-audit.mjs` J16 |
| 低危 · idle-ruler 两个盲区 | 判决改**非严格大于**（残差恰好等于一拍位移正是"漏补一拍"的形状）；退路那一支按协议里的 `tickHz` 折算，不再写死 60 | `test/net-feel.mjs` AA 段 |
| 低危 · 投掷物计数不自愈 | 服务端把权威端那一份**每人一份**的数目搭 pong 下行（`server/fanout.mjs:nadeCounts`）；客户端**只补不扣**（服务端那格是滞后读数，双向覆盖会让 HUD 自己闪），且出手途中不许改，`nadeResync` 计数 | `test/net-audit.mjs` J |
| 低危 · 常数漂移一组 | `pickRoom` 改用 `lobby.roomId` 与导出的 `MAX_SEATS`（不再写字面 16 / 48）；live 房的 `/api/rooms` 行补 `bots/time/score/host`；accounts 发 `hashing_failed` 与 http-api 的 ERRORS 表对齐 | `test/net-audit.mjs` J17 + `test/service-guards.mjs` H4 |
| 低危 · pong 的 `c` / 畸形 cookie / `/api/status` / 连接上限差一 / `__netStall` 印 cid | `c` 的类型校验（`pingBad` 计数）、`parseCookies` 不再抛 URIError、public 接口不再带注册用户总数、上限两侧都是闭的、边沿旗挂连接 | `test/net-feel.mjs` + `test/service-guards.mjs` H/I + `test/net-audit.mjs` D7 |
| 跨台票证放 URL query | **不改**：跨台握手没有别的可信可用通道（与 `?ticket=` 同一个先例），落到反代访问日志与浏览器历史是**已知取舍**。留在《三、低危》里继续挂着 | 残余风险，见 README《已知缺口》 |
