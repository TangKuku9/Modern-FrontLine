# 联网对战服务端性能审查

- 审查日期：2026-10-04
- 审查范围：`server/` 权威服务端、`js/` 两端共用的模拟代码，以及大厅、目录、账号和持久化路径
- 审查方式：源码走查，结合现有 `/healthz`、`soak` 和回归判据确认热路径与可观测性
- 本文性质：性能审查与重构建议。**2026-10-04 批次 A/B 与低风险 P2 已全部落地**，
  批次 C 按本文自己的门槛经 profile 取证后暂不实施 —— 逐条的落点与判据见文末《落地记录》。

## 结论

当前服务端的快照广播骨架已经比较合理，真正值得优先处理的是**同步 I/O 进入主事件循环**、**60Hz 模拟和上行输入的短命对象分配**，以及**大厅事件造成的全量广播和目录写放大**。

按风险和收益排序：

1. 把房间目录和聊天等同步 SQLite 写从高频路径移走或合并，先消除能够让所有房间一起掉拍的长尾停顿。
2. 收紧大厅帧的幂等/合帧/限速语义，避免一个连接把全大厅广播和目录事务放大到连接数倍。
3. 优化 `room.step()`、输入解码和拾取扫描的分配与重复遍历，降低 GC 和 60Hz 拍间抖动。
4. 在有基准数据后再做世界碰撞候选索引、Bot 哑模型和快照直接编码等结构性重构。

不要直接把所有房间合并到一个调度器，或立刻重写世界碰撞系统。前者会扩大错误隔离和追赶语义的改动面，后者会改变碰撞顺序、命中结果和玩家手感；这两项应放在测量之后。

## 现有基线与验收口径

### 可用观测

`GET /healthz` 已经逐房报告 `hz`、`stepMs`、`behindMs`、`fails`、`netDrops`、`qDrop` 以及延迟补偿计数（`server/net-server.mjs:360-382`）。这些字段应作为所有优化前后的共同基线：

- `hz`：房间实际推进频率，稳定态应接近 `tickHz`。
- `stepMs`：房间一次模拟的 EMA 耗时；不要只看平均 CPU 使用率。
- `behindMs`：房间相对墙钟的落后量，最能暴露同步 I/O 或 GC 停顿。
- `qDrop` / `netDrops`：分别表示上行输入队列丢拍和下行快照背压丢弃。

每次基准至少记录：房间数、真人数、Bot 数、地图/模式、Node 版本、堆使用、`hz` p50/p95、`stepMs` p95/p99、`behindMs` 最大值和恢复时间。只比较“服务端自报”的数值，不用压测客户端自己的收包频率代替服务端指标。

### 既有基线的限制

README 中的 `soak` 读数是旧基线，不应当据此断言当前所有场景都没有瓶颈。尤其要补测：

- `REQUIRE_ACCOUNT=0` 的本地 WS 阶梯压测，否则默认鉴权会让假客户端在握手阶段全部得到 401（`server/soak.mjs:109-147`，默认值见 `server/net-server.mjs:102`）。
- 开启 `ROOMS_DB` 的双进程目录争用。
- 登录/恢复码 scrypt 与满载对局同时发生。
- 大厅聊天、`lobby` 帧洪水、建房/进房风暴。

## 优先级清单

### P0：同步 SQLite 写可能冻结所有房间

**证据**

- `server/room-dir.mjs:71-75` 使用同步 `DatabaseSync`，并设置 `busy_timeout = 2000`。
- `server/room-dir.mjs:88-112` 的 `publishAll()` 在事件循环线程上执行查询、事务、逐行 upsert/续租和提交。
- `server/net-server.mjs:572` 的目录变更回调会把大厅变化带入目录发布路径；`server/net-server.mjs:594-601` 的心跳还会周期性 sweep、发布和读取目录。
- `server/store.mjs:227-229` 的 `setMeta()` 也是同步写。

**影响**

跨进程目录写锁竞争时，单次同步等待可能达到 2 秒。因为房间模拟、WebSocket 消息、HTTP 和 SQLite 都共享 Node 事件循环，某一台目录写阻塞会让这台的全部房间一起出现 `behindMs` 峰值。大厅每条聊天消息还会同步重写最多 50 条历史，进一步增加尾延迟。

**建议顺序**

1. 先把高频变更的 `publishAll()` 改成脏标记，在一个 1--2 秒心跳窗口内合并发布；保留每行 `beat` 的续租语义。
2. 将 `room-dir.mjs:93`、`:106`、`:118`、`:126`、`:176` 等重复 `prepare()` 提升到构造函数缓存，减少不必要的 SQL 编译。
3. 聊天历史改为 250ms 左右防抖或并入现有 store 批刷，接受文档中已经存在的“最多丢一个批刷窗口”的崩溃损失，并在 `stat` 中记录待写/失败。
4. 只有在双进程压测仍显示同步写造成明显长尾时，才考虑 worker 化；worker 化前先固定事务、错误回填和关闭时 flush 的契约。

**风险与验收**

目录行的 `beat`、diff/changed 语义、跨台 ticket 的原子消费不可改变。用两个进程共用同一个 `ROOMS_DB`，让一方持有写锁，同时在另一方满载房间中创建/进入房间；比较 `behindMs`、`hz` 和目录可见延迟。聊天改造需回归 `test/room-flow.mjs` 的历史语义。

### P0：恢复码路径未经过 scrypt 并发闸

**证据**

- `server/accounts.mjs:601-606` 对恢复码最多执行 5 次 `verifyPassword()`，没有经过 `_throttled`。
- 登录、注册和换码路径使用了 `_throttled`，并发上限在 `server/accounts.mjs:47-60`。

**影响**

恢复接口可以无界地占用 libuv 线程池。线程池同时承担静态文件和其他异步工作，恢复码洪水会把静态资源和账号请求延迟传导到对局服务。

**建议**

把每次恢复尝试包进同一个 scrypt 并发闸；遇到 `busy` 时中止本次恢复并返回既有的统一错误语义。不要减少错误输入的固定 5 次验证，否则会重新引入时序侧信道。

**验收**

并发发送 30 个错误恢复请求，同时请求大静态文件，比较静态请求延迟、`auth.stat` 的 scrypt/busy 读数和满载房间 `behindMs`。补充一个并发恢复的判据。

### P1：大厅消息可放大全大厅广播和目录写

**证据**

- `server/lobby.mjs:198-203` 每次 `pushLobby()` 都重建并 stringify 全量大厅状态，再发送给所有连接，并触发 `onChange()`。
- `server/lobby.mjs:236-242` 的 `attach()` 即使连接已经在大厅，也会再次广播一次全厅状态。
- `server/net-server.mjs:48` 的 `HEAVY_FRAMES` 不包含 `lobby`；总闸 `server/net-server.mjs:1151-1165` 只按连接统计消息数，未按帧型限制纯读大厅帧。
- `server/lobby.mjs:208-225` 对每个座位重建 `roomState()` 并单独 stringify；`seats`、Bot、聊天历史等公共部分重复构造。

**影响**

一个连接高频发送大厅帧会触发连接数倍的 JSON 构建和发送；在目录模式下还可能触发重复的目录发布。`ready`、`team` 等房间帧则会放大为“每座位一份完整房间 JSON”。断线风暴、批量进房和进房按钮重试会把这类成本集中到同一时间片。

**建议**

- `attach()` 做幂等：已在 `conns` 的连接只回发自己的状态，不再触发全厅广播。
- 给大厅变更加脏标记和 50--100ms 合帧窗口；对外仍保持 `{t:'lobby', online, rooms}` 形状。
- 先构造一次房间公共状态，再为每个座位补 `me`、`canStart` 和 `why`；不要把 per-seat 字段错误地合并成共享帧。
- 给 `ready`/`team` 等改变房间状态的帧设最小间隔和明确回音，保留现有 HEAVY 帧的拒绝语义。

**红线**

WS 大厅帧与 `/api/rooms` 必须继续来自同一份名单；`me` 必须保持按座位区分；房间控制帧不得因为合帧而改变确认顺序。

### P1：`room.step()` 每拍分配两套玩家包装对象

**证据**

- `server/room.mjs:395-414` 每拍展开 `clients.values()`，创建数组和 `{c, inp, fresh}` 对象。
- `server/room.mjs:450` 再次 `map()` 创建 `{pl, inp}` 对象，并在空房间时每拍调用 `decodeInputBits(0, 0)`。
- `server/room.mjs:503-505` 无条件对每个玩家执行 `pickupAction()`。
- `js/match-rules.js:421-427` 的拾取动作在距离筛选前就为每次调用创建结果对象，并对槽位做查找。

**影响**

这是稳定的 60Hz young-generation 分配源。单项对象很小，但多房间、满员和 Bot 补人时会持续制造 GC 压力，表现为 `stepMs` 抖动和偶发 `behindMs` 峰值。

**建议**

- 用房间级 scratch 数组原地写入输入对，或改成两次 `for...of`，避免中间包装对象。
- 把零输入做成共享的不可变 `EMPTY_INPUT`，不要每拍重新解码。
- 仅在有地上枪时进入拾取判定；拾取规则先比较距离平方，再查槽位和构造结果。
- `active.filter()`、`enemiesOf()`、UAV Map 展开等空集合路径按需执行，避免为了空结果分配数组。

**风险与验收**

输入消费顺序、`ack/rep`、真人实体顺序和丢旧输入语义必须不变。回归 `test/room-flow.mjs`、`test/room-bots.mjs`、`test/mp-rules.mjs`、`test/lagcomp.mjs`；在固定人数和房间数下使用 `--trace-gc` 对比 GC 次数、暂停时间和 `stepMs` p99。

### P1：世界查询对全部碰撞盒做线性扫描

**证据**

- `js/world.js:507-585` 的 `raycast`、`lineBlocked`、`collide`、`groundHeight` 和 `ceilingHeight` 都直接遍历世界盒集合。
- `js/player.js:365-382`、`js/ai.js:147`、`:348-349`、`js/combat.js:226`、`:270`、`js/mp.js:584`、`:762` 等高频路径反复调用这些查询。
- 地图构建包含数百个分段墙体、建筑和障碍盒，候选数会随地图复杂度增长。

**影响**

多人、Bot 感知、投掷物子步和载具扫描叠加后，单拍会重复测试大量与查询位置无关的盒子。这是规模增长后最可能成为 CPU 主项的算法级热点。

**建议**

在 `World.finalize()` 建立保守的空间桶索引，查询时先取当前位置周边桶，再按原有盒顺序做精确测试。桶边界需扩大一圈；`raycast` 仍返回最近命中，`collide` 的推离顺序也必须保持。

**风险与验收**

这是高风险重构，不应只用平均位置误差验收。用同一随机种子对比旧/新世界的碰撞、地面高度、射线最近命中和投掷物轨迹；回归 `server/fps-independence.mjs`、`test/lagcomp.mjs`、`test/mp-rules.mjs`，再做满 Bot 压测。只有在 profile 证明世界查询占用显著 CPU 时才实施。

### P1：无头服务端仍运行完整 Bot 3D 动画和矩阵链

**证据**

- `js/ai.js:34-37` 为 Bot 构造完整 Soldier 模型。
- `js/ai.js:229`、`:379-381` 每拍调用 `animateSoldier()` 并更新模型属性。
- `js/soldier.js:247-398` 写入多组骨骼属性并执行双臂 IK；`js/ai.js:452` 开火时还通过 `getWorldPosition()` 触发世界矩阵更新。

**影响**

权威端不渲染这些网格，却承担了表现层动画、IK 和矩阵更新。Bot 数量增加时，这部分 CPU 与 GC 成本随人数线性增加。

**建议**

增加服务端 Bot 的数值状态档：只保留快照需要的姿态、冲刺、弹匣、闪光和动画相位字段，跳过网格、骨骼和 IK。枪口起点改用位置 + yaw/pitch 的纯数值解析，或先缓存一次结果。

**风险与验收**

枪口起点是玩法数值，不可把“看起来一样”当作等价。先记录完整模型路径与解析路径的最大偏差，再用命中率、弹道落点和 `test/heli-armor.mjs`、`test/room-bots.mjs` 验收。若偏差不可接受，保留一个只计算枪口的轻量模型，而不是直接删除所有姿态状态。

### P1：上行输入每帧拷贝并分配多次

**证据**

- `server/net-server.mjs:1167-1175` 对 Node `Buffer` 使用 `data.buffer.slice()`，随后为每个 16B 包创建 `DataView`。
- `server/codec.mjs:131-143` 的 `decodeInput()` 返回中间对象，之后 `server/room.mjs:348` 的 `unpackInput()` 又建立另一份输入状态对象。

**影响**

正常客户端是每秒约 60 帧；多人同时在线时，整帧拷贝和两套对象会形成持续的上行分配压力。大帧虽然受消息速率闸保护，但解析之前的拷贝仍是无效工作。

**建议**

先用 `new DataView(data.buffer, data.byteOffset, data.byteLength)` 消除同步消费场景中的整帧拷贝；再把 `decodeInput` 与 `unpackInput` 合并为一次结构化输入对象。不要对入队输入做对象池，队列和 `lastInput` 会跨函数持有对象，池化容易产生数据覆盖。

**验收**

保持多包帧的顺序、16 位 tick 回绕判定、队列满时丢最旧输入和 `qDrop` 计数不变。用 `test/net-audit.mjs`、`test/service-guards.mjs` 和多包输入探针验证字节及消费顺序。

## P2：中低优先级优化候选

### 快照实体中间对象

`server/room.mjs:1168-1192` 先为每个真人和 Bot 构造实体对象，`server/net-server.mjs:1050` 再交给 `encodeSnapshot()`。编码 scratch 已按房间复用，剩下的实体对象图在 20Hz 下仍会制造稳定分配。可将编码器改成从房间实体直接读，或按房间复用实体数组；先以堆 profile 证明它值得增加编码耦合。

必须保留 `HEADER_SIZE=12`、`ENTITY_SIZE=26`、`count` 为 `u16`、真人在前 Bot 在后的顺序，以及每房间独占 scratch。

### 每房间递归 `setTimeout`

`server/net-server.mjs:985-1035` 每个房间维护一条 60Hz 定时器链。房间很多时会增加 timer 唤醒数；但当前实现有每房间异常隔离、迟到追赶、连续失败熔断和 `__behindMs` 语义。只有在房间数量成为主要调度开销时，才考虑共享调度器，并逐项复制这些语义。

### 目录和 store 的小型分配

- `server/room-dir.mjs:93`、`:106`、`:118`、`:126`、`:176` 重复 `prepare()`，收益低风险，适合与 P0 一起处理。
- `server/store.mjs:238-240` 先把整个 dirty `Set` 展开再截取 200 条；积压大时应改为迭代器计数早停。
- `server/accounts.mjs:263` 的限流器每次 `hit()` 都可能全表 prune；可按时间节流清理，避免高 key 数时每个只读请求付 O(n) 成本。

### HTTP 静态资源首击

`server/net-server.mjs:435-437` 的首次 gzip 使用 `gzipSync`，会在主线程同步压缩大文本资源；`cachedFile()` 路径还会对每次请求做 `stat()`（`server/net-server.mjs:210-228`）。可改异步 gzip 并做 in-flight 去重，或给 `stat` 加短 TTL，但必须保留文件变更后的失效语义。该项应以“满载房间同时首击静态资源”的实测为准。

### headless stub 日志

`server/stubs.mjs:19-35` 的 Proxy 对属性访问、设置和调用都记录对象；`server/headless-game.mjs:52-61` 把日志挂在 `game.stubLog`。如果该路径用于生产权威房间，日志会无限增长并增加 GC；生产应关闭或使用有上限的环形缓冲，同时确认 `test/heli-armor.mjs` 和 `test/rollback.mjs` 需要的观察窗口不会被截断。

## 不需要优化或不应破坏的部分

以下结构当前是正确的，应把它们当作重构红线：

- `server/net-server.mjs:1045-1052` 的快照 scratch 按房间复用，并只生成一份 Buffer 给同房连接；不能改成全进程共享 scratch。
- `server/net-server.mjs:1053-1060` / `server/fanout.mjs` 的事件先于背压闸发送，背压只跳过快照；不可为了合帧把不可再生事件延后或丢弃。
- `server/net-server.mjs:1151-1165` 的消息速率闸在解析前；不能把 JSON/输入解析移到闸门之前。
- `server/room.mjs:363-378` 的输入队列上限、拍号去重和丢最旧策略；`ack/rep` 的末尾连续折叠定义也不能因去分配而改变。
- `server/net-server.mjs:1083-1128` 的战绩落库在 tick 循环外；不要把同步存档写回 60Hz 模拟。
- 快照字段和实体顺序是协议契约，不要用“减少字段”解决 CPU 或带宽问题，除非同时设计版本化协议和客户端兼容策略。

## 推荐实施批次

### 批次 A：低风险、先消除主线程写放大

1. 修正 `soak` 本地服环境，使基准确实进入对局。
2. 缓存 `room-dir` prepared statements。
3. 对 `publishAll()` 和聊天持久化做防抖/批合并。
4. 给恢复码验证加 scrypt 并发闸。
5. `attach()` 幂等，补大厅帧型最小间隔和重复变更抑制。

每项都用双进程目录场景、聊天洪水和满载房间的 `behindMs` 对比验收。

### 批次 B：60Hz 与上行热路径

1. 去掉输入 Buffer 整帧拷贝，合并输入解码分配。
2. 重构 `room.step()` 的 scratch 输入数组和空路径。
3. 优化拾取距离筛选和空拾取路径。
4. 用 `--trace-gc` 和 `stepMs` p99 验收，确保行为判据全绿。

### 批次 C：需要基准驱动的结构性重构

1. 世界空间桶索引。
2. 服务端 Bot 数值状态档。
3. 快照直接编码或实体对象复用。
4. 共享 tick 调度器。

批次 C 的每一项都必须先有旧实现与新实现的确定性对照；没有 profile 证据时不做。

## 最小验证矩阵

| 场景 | 主要读数 | 重点判据 |
| --- | --- | --- |
| 1 房满员、无目录 | `hz/stepMs/behindMs`、GC | `test/room-flow.mjs`、`test/room-bots.mjs` |
| 多房满员 | 每房 `hz` p99、堆和 GC | `server/soak.mjs`，修正鉴权环境后运行 |
| 双进程共享 `ROOMS_DB` | `behindMs` 峰值、目录延迟、WAL | `test/room-dir.mjs` + 双进程压测 |
| 大厅帧/聊天洪水 | JSON 次数、写次数、断开数 | `test/service-guards.mjs`、`test/room-flow.mjs` |
| 输入突发与多包帧 | `qDrop`、ack/rep、消费顺序 | `test/net-audit.mjs`、`test/net-journal.mjs` |
| Bot/投掷物/碰撞密集 | `stepMs`、CPU profile、命中轨迹 | `test/mp-rules.mjs`、`test/lagcomp.mjs`、`server/fps-independence.mjs` |
| 满载房间 + 首次静态资源请求 | `behindMs`、首请求延迟 | HTTP 压测与 `/healthz` 对照 |

## 审查结论

最先应该处理的是会阻塞事件循环的同步目录/聊天写入和可放大的大厅广播；它们的尾延迟风险高于当前快照编码。之后处理输入与 `room.step()` 的分配，收益更容易通过现有判据确认。世界索引、Bot 哑模型和共享调度器属于后续重构，必须以 CPU profile、确定性对照和协议回归为前置条件。

## 落地记录（2026-10-04）

批次 A、B 与低风险 P2 全部落地；每条都注明落点与钉它的判据。判据全绿后才收工
（`npm test` 全链 + 本文件所列新增判据）。

### 批次 A

| 条目 | 落地位置 | 判据 |
| --- | --- | --- |
| A1 soak 本地服环境 | `server/soak.mjs`（withServer env 加 `REQUIRE_ACCOUNT: '0'` 与 `CONNS_PER_IP: '256'` —— 前者挡"握手 401 全灭"，后者挡"本机同 IP 第 7 条起被拆"，正是文件头写明的两个坑） | 本地裸跑 `npm run soak` 四档全绿（读数见下文基线） |
| A2 目录 SQL 现场编译 + 逐行续约 | `server/room-dir.mjs`：8 条 prepared 全部进构造函数；未变行的续约改**一条按 boot 的批量 UPDATE**（beat 只被本台写、`list()` 只看别台，批量续约不构成可见 changed） | `test/room-dir.mjs` 36/36 |
| A3 目录发布写放大 | `server/net-server.mjs`：`onChange` 不再同步 `publishAll`，只立 `dirDirty`；发布合并进 dirBeat 心跳窗口（每 `ROOMS_BEAT_MS` 一次），跨台可见性从"即时"变为"最坏一个心跳周期"（本文写明接受的取舍）。**整段心跳回调包 try/catch**：发布全部集中到 interval 里之后，一次 `SQLITE_BUSY` 抛错 = uncaughtException = 整台进程死，必须降到"下一拍重试"。判据侧：`test/room-dir.mjs` 的 G2/G6/G9/D2/D5 改为**心跳窗口内轮询**（新增 `pollApi`，注释写明取舍），并给凭票握手加有界等待（曾经 D5 红了之后 `await opened` 会把整份测试挂死） | `test/room-dir.mjs` 36/36 |
| A3b 聊天直写 → 攒批 | `server/store.mjs` 新增 `setMetaLazy`（脏 Map + `getMeta` 先读未落盘值，读回一致），聊天历史并入既有 250ms 批刷事务；恢复码哈希**仍走直写** `setMeta`（安全键不许有丢失窗口，accounts.mjs 的契约注释不变） | `test/room-flow.mjs` 聊天持久化判据（杀进程前给 400ms 刷盘窗，判据注释写明理由） |
| A4 恢复码裸跑 scrypt | `server/accounts.mjs` `_recoverImpl`：5 连验证每次过 `_throttled`，busy 当场干净拒绝（与登录同款结局；不泄露"第几张"，固定跑满 5 次的时序纪律只对"码对不对"成立） | `test/accounts.mjs` O1（8 个并发名额占满 ⇒ recover 必得 `busy`）+ O2（名额释放后照旧跑满验证，拒忙不是永久的） |
| A5 大厅广播放大 | `server/lobby.mjs`：`attach` 幂等（已在 `conns` 的连接只回自己一份，不再触发全厅广播）；`pushLobby` 走 50ms 合帧（对外形状不变）；`roomShared` 把 seats/bots/brief/chat 只建一次，`pushRoom` 每座位只补 `me/canStart/why`；`ready`/`team` 进 HEAVY_FRAMES 的**突发**档（不进最小间隔档，连点是正常操作） | `test/room-flow.mjs` 新增两条：重复 attach 对旁听者静默 / 仍回自己一份清单 |

### 批次 B

| 条目 | 落地位置 | 判据 |
| --- | --- | --- |
| B1 上行输入零拷贝 + 中转对象 | `server/codec.mjs` `decodeInput(buf, out, byteOffset)`（不传时行为逐字节不变）；`server/net-server.mjs` 二进制路径对 ws 的池化 Buffer 直接架 view（同步用完即弃）、每连接一个 scratch 对象 | `server/codec.mjs` 自测 + `test/net-audit.mjs`（105/105）+ `test/lagcomp.mjs` |
| B2 step 每拍分配 | `server/room.mjs`：`{c,inp,fresh}` 与 `{pl,inp}` 两组包装按人数复用槽位（人数回落清引用/截断，churn 只发生在人数变化那一拍）；`EMPTY_INPUT` 模块级一份（sim 对 input 只读——队列空时同一份 lastInput 被连续折叠就是既有证据），空房与新 client 共用；`active.filter` 只在真有实体死亡时重建；`uavHints` 的 `[...this.uav]` 改按 size 判空后迭代 | `test/room-flow.mjs` 147/147 + `test/room-bots.mjs` 47/47 + `test/mp-rules.mjs` 158/158 |
| B3 拾取距离先行 | `js/match-rules.js` `pickupAction`：平方距离比较，1.8m 外在查槽位前跳过；`!pl || !pl.alive` 提到循环外早退；调用侧按 `game.pickups.length` 门控 | `test/mp-rules.mjs`（两端共用代码，单机与联机判据同过） |

### 低风险 P2

| 条目 | 落地位置 |
| --- | --- |
| store 批刷 O(pending) 摊平 | `server/store.mjs` `flush()`：三个脏集合改迭代器早停取批，刷盘成本与积压解耦 |
| RateLimiter 全表 prune | `server/accounts.mjs` `hit()`：prune 按时间节流（每 250ms 最多一次），风暴形状的 prune 成本钉成常数 |
| stub 日志无限增长 | `server/stubs.mjs`：记录走 `record()`，`STUB_LOG_CAP=16384` 满则整段清空（判据读的都是最近一小段动作，远小于上界） |
| 首击同步 gzip | `server/net-server.mjs`：`gzipSync` → 异步 `zlib.gzip` + in-flight 去重（并发请求共享同一份 promise，压失败退回明文可重试）；mtime 失效语义不变（条目整个替换） |

### 批次 C：profile 取证后的决定——不实施

本文给批次 C 设的门槛是"必须有 profile 证据"。取证方式：进程内探针（1 房 = 4 真人
带上行输入 + 16 Bot，yard 图，60k 拍不按墙钟限速），inspector 只对 tick 循环采样
（100µs 间隔，排除启动期的贴图生成/建图噪声）：

- 单拍耗时：p50 ≈ 0.05ms、p95 ≈ 0.05ms、p99 ≈ 0.17ms，max ≈ 9ms（首拍 JIT）。
  预算 16.7ms —— 满配单房只花预算的 **1%**；不 sleep 折算单进程可推 7.7 万拍/s。
- 自时间分布（稳态）：输入解包链 ≈ 24%（`unpackInput`/`applyInput`/`decodeInputBits`，
  与真人数成正比，且大头是必须保留在队列里的 28 字段对象）、世界查询 ≈ 13%
  （`collide` 6.4%、`findPath` 3.6%、`rayAABB` 2.2%）、Bot 动画 + 矩阵 ≈ 12%
  （`animateSoldier` 3.3% + three.module.js 的欧拉/矩阵 ≈ 9%）、GC ≈ 2.8%、
  快照编码链 ≈ 6%。

逐项判定：

| 批次 C 项 | 判定 | 理由 |
| --- | --- | --- |
| 世界空间桶索引 | **不做** | 目标函数合计 ~13%，但那是"满 Bot 单房"占比，绝对值 p99 0.17ms；索引要保住 collide 推离顺序 / raycast 最近命中 / lineBlocked 语义，风险收益比当前不成立。重开条件：`/healthz` 的 `stepMs` p99 常态 > 5ms 且世界查询占大头 |
| Bot 数值状态档 | **不做** | 动画+矩阵 ~12%，绝对值同上；且枪口起点是玩法数值（弹道落点会变），必须先做两端偏差测量——在没有 CPU 压力证据时引入玩法偏差是负收益。重开条件同上，且以"只换枪口解析"为第一步 |
| 快照直接编码 | **不做** | `botEntity`+`snapshotEntities` ≈ 3.3%，编码耦合换不回可观测的收益 |
| 共享 tick 调度器 | **不做** | 每房一条 setTimeout 链在 32 房（上限）下远未成为开销；错误隔离与追赶语义的复制风险大于收益 |

### 落地后的基线读数

（本机 Windows，单进程，`npm run soak` 服务端自报；A1 修复后本地基准首次可直接运行。）

| 人数 | 间数 | 每间 hz | 每拍耗时 | 落后墙钟 | 峰值堆 |
| --- | --- | --- | --- | --- | --- |
| 16 | 1 | 60.6 | 0.162 ms | 0 ms | 18.6 MB |
| 32 | 2 | 59.7 | 0.103 ms | 0 ms | 21.1 MB |
| 64 | 4 | 59.3 | 0.090 ms | 0 ms | 25.9 MB |
| 128 | 8 | 59.5 | 0.092 ms | 0 ms | 32.1 MB |

与 README 记载的旧基线同量级（该表压的是纯对局、无 Bot）；落地项的收益主要在**尾延迟形状**
（目录/聊天不再在主线程上做同步写、大厅风暴被合帧削平）与 GC 压力，单看稳态 `stepMs` 分辨不出，
要按《最小验证矩阵》的场景对照着量。

