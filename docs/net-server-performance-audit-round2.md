# 联网对战服务端性能审查 · 第二轮

- 审查日期：2026-10-04
- 前提：第一轮（`net-server-performance-audit.md`）批次 A/B 与低风险 P2 已全部落地
  （c3b8a03），批次 C 四项按 profile 门槛暂不实施。**本轮只找第一轮没有立过账的新问题**，
  逐条注明与第一轮的关系（新增 / 第一轮已覆盖勿重提）。
- 审查方式：源码走查，交叉引用第一轮的 profile 拆解（输入 24% / 世界 13% / Bot 动画 12% /
  GC 2.8% / 快照 6%，其余 ~42% 未点名——本轮 N1 正是落在那个未点名桶里）。
  未做新 profile：按第一轮立的门槛，结构性改动前先取证，本轮只立账。

## 清单（按严重度排）

### N1 · Bot 听觉：每拍 O(bots×noises) 全表扫描 + 噪声链路的每拍分配

**证据**

- `js/ai.js:183-196`：没有可见目标的 Bot **每拍**遍历 `game.noises` 全表，对每条噪声做
  `n.pos.distanceTo(this.pos)`（带 sqrt）；只在"被噪声覆盖"后才有 2 秒的记账节流。
- 噪声源是高频事件：每发子弹一条 r=80 的噪声（`js/combat.js:163`）、每人每 1.6~2 m 一条
  r=9~16 的脚步（`js/player.js:413`）、Bot 开火 r=10/60（`js/ai.js:474`）；TTL 0.6 s
  （`server/headless-game.mjs:178`）。
- `server/headless-game.mjs:178`：只要有噪声存在，**每拍** `this.noises = this.noises.filter(...)`
  重建一个数组（60 次/s）；`server/headless-game.mjs:97` 的 `makeNoise` 每次分配
  `{pos: pos.clone(), …}`。

**影响**

交火中的满 Bot 房稳态有几十条噪声活着：16 Bot × ~40 条 × 60Hz ≈ **3~6 万次带 sqrt 的
距离检查/秒**，随开火率线性放大，全部落在第一轮 profile 里未点名的那 ~42%（bot think）。
这是继"世界查询"之后第二个 O(实体×事件) 的每拍热点，且它随房间热度增长，不随人数增长。

**建议**

1. Bot 听觉降频：照抄 `uavHints` 的 `uavPing` 式节流（5~10 Hz 对"听见动静"足够），
   每 Bot 记上次扫描时刻、只看 `n.t > lastScan` 的增量噪声。
2. `noises` 过滤改原地 compaction（写指针），消灭每拍 filter 数组；`makeNoise` 若嫌
   clone 可改存纯字段——但先量，`pos.clone()` 在噪声总量小的时候不是大头。

**验收**：`test/room-bots.mjs` 的听觉触发判据（alert/hint/footstep 区分）全绿；
1 房 16 Bot 交火场景 profile 对比 bot think 自时间与 `stepMs` p99。

### N2 · 权威端持续为"地上枪 / 哨戒机枪 / 武装直升机"构建完整 three.js 模型

**证据**

- `server/headless-game.mjs:136-155`：`spawnPickup` 每次调 `buildGun(weaponId, att, 'none',
  {low:true})` 构建完整枪模（几十个 mesh/geometry/material——仓库里最重的建模函数），
  挂进 scene，再 `m.position.clone()`。
- `js/mp.js:520-533`：`Sentry` 构造器 new Group + 6 个 Mesh + 独立材质；`js/mp.js:812` 起
  `Heli` 同类（Capsule/Sphere/Cylinder 全套）。
- 触发频率：击杀掉落 60% 概率（`js/match-rules.js:414-418`）——热 Bot 房每几秒掉一把枪、
  14 把上限反复建/丢；哨戒机/直升机每次呼叫各建一个。

**影响**

权威 sim 只读 `p.pos`（拾取/事件），模型本身无人渲染，却每次掉落付一次建模尖峰 +
geometry/material 分配；`scene.remove` 只摘引用， churn 全靠 GC。第一轮批次 C 只立了
"Bot Soldier 模型"一项，**这一类（pickup/sentry/heli 哑模型）没立过账**，是同类问题的
另外三个源。

**建议**

服务端 `spawnPickup` 跳过 `buildGun`（客户端本来就按 'pickup' 事件自己建哑模型）；注意
`spawnPickup` 里 `groundHeight` 那一行是摆模型用的吸附，跳过建模时一并去掉、由事件坐标
兜底。Sentry/Heli 拆"数值状态"与"模型"两段（与批次 C 的 Bot 数值状态档同一改法，可并入
同一批做）。

**验收**：`test/mp-rules.mjs`（掉落/拾取）、`test/heli-armor.mjs`（直升机）、
`test/room-bots.mjs` 全绿；掉落风暴（连续击杀）时 `stepMs` 无尖峰。

### N3 · B2 漏网的每拍分配（四个调用点）

第一轮 B2/B3 修的是同类问题，这四处是当时没覆盖的调用点：

- **dom 房 `flagsTick` 每拍全量分配**（`js/match-rules.js:487-517`）：每拍
  `{caps:[], flags:[]}` + 每旗 `cnt={}`、`inRange=[]`、`Object.keys()` + 结果对象——
  60 次/s × 3 旗。而权威调用方 `server/room.mjs:506` 只读 `.caps`，
  **`out.flags` 每拍白建白丢**。
- **`pickupsExpire` 每拍无条件 `out=[]`**（`js/match-rules.js:427-435`；调用点
  `server/room.mjs:523` 没有按 `game.pickups.length` 门控——B3 只给 `pickupAction`
  加了门控，这条漏了）。
- **白磷灼烧每拍 `enemiesOf` 过滤数组**（`server/room.mjs:496-499`，wpTicks 期间 60 次/s
  对全实体 filter）。
- **`uavHints` 每个 Bot 各重建一遍同样的敌表 + sort**（`js/match-rules.js:398-403`：
  `enemiesOf(t).filter(...)` 在 `for (const b of game.bots)` **里面**——同队 8 个 Bot
  就是 8 次相同的 filter+sort，应每队一次提到循环外）。

**建议**：`flagsTick` 拆成"每拍推进（零分配）+ 换旗时才编结果"；`pickupsExpire` 按
pickups.length 门控或原地 compaction；`enemiesOf` 结果按队缓存一拍；uavHints 敌表提到
Bot 循环外。

**验收**：dom 占点进度/得分式逐字不变（单机共用的同一份函数，`test/mp-rules.mjs` 两端
判据同过）、30 秒过期与 14 把溢出语义不变。

### N4 · 上行最热路径的 async 壳

**证据**：`server/net-server.mjs:1186` `ws.on('message', async (data, isBinary) => { … })`。
输入帧是全部消息里频率最高的一类（60 帧/s/连接，128 连接 ≈ 7700 帧/s），**每一帧**都要付
一次 async 函数调用的隐式 Promise 分配 + 至少一次微任务调度；而二进制分支（占绝大多数）
从头到尾是同步的——只有 `join`/大厅 `start` 分支真的需要 await。

**影响**：B1 修掉了每帧的 Buffer 整帧拷贝，但这层 async 壳还在——它是上行链路上剩下
最稳定的每帧分配源，稳态贡献与连接数成正比。

**建议**：注册两个 listener——`ws.on('message', (data, isBinary) => { if (isBinary) {
…同步输入路径…; return; } handleMessage(ws, data); })`，把需要 await 的文本分支留给
async 函数。

**验收**：`test/net-audit.mjs` 的多包顺序 / 16 位回绕 / qDrop 判据不变；
`--trace-gc` 对比稳态 GC 次数。

### N5 · 对局窄帧（loadout/respawn/streak）无帧型闸 + loadout 每帧全量白名单重建

**证据**

- `server/net-server.mjs:1281-1288`：这三条窄帧在 `LOBBY_FRAMES` 分支**之前**处理，
  M7 的 HEAVY 档只盖大厅帧——窄帧面前只有 240 帧/s 的总闸。
- `server/room.mjs:1010-1016`：`applyLoadout` 没有 alive/频率闸，**每帧**跑一次
  `sanitizeLoadout(raw)`；`js/loadout.mjs:69-94` 每次重建两个 `new Set` + 一整棵配装
  对象树。

**影响**：一条连接拿满总闸灌 'loadout' = 240 次/s 的 Set 构建 + 对象分配；满员齐灌
≈ 3 万次/s，与快照编码抢同一个事件循环。'respawn'/'streak' 在 sim 侧有便宜守卫
（`requestRespawn`/`requestStreak` 的 alive 闸）可以不动，loadout 是唯一"每帧全量重建"
的那个。

**建议**：给 'loadout' 设最小间隔（对齐 HEAVY_MIN_MS 或单独一档），或先比对上一次
`nextLoadout` 的关键字段没变就不 sanitize；顺带考虑 `pl.alive` 时也允许（现在允许，
是"死亡画面换装"语义的保守实现，别改语义）。

**验收**：局内换配装"重生生效"判据（`test/room-flow.mjs`）不变；单连接满额灌
'loadout' 时 `/healthz` 的 `stepMs` 无抖动。

### N6 · 目录部署：每推一帧大厅都同步 SELECT 一遍目录清单

**证据**：`server/net-server.mjs:586` 注入的 `remoteRooms: () => (dir ? dir.list() : [])`
在**每次** `lobbyState()`（`server/lobby.mjs:204`）里被调用；`server/room-dir.mjs:129-137`
的 `list()` 是主线程同步 `select * from rooms where boot != ? order by beat desc`
（还可能顺手触发 sweep 的 2 条 DELETE——那条已被 sweepMinMs 压到 1 次/s，M7）。

**影响**：`pushLobby` 虽已 50ms 合帧（A5），风暴（批量进退房）时仍是 20 帧/s =
20 次主线程同步 SQLite 读/秒。而逐帧重读没有换来任何新鲜度：本进程的变更走 `onChange` 立脏、要等心跳才落库；别台的
行虽然随时可能被别台改写，但**推给大厅的时机本来就由心跳的 sig 比对决定**（见 dirBeat）
——列表的可见性上限是"最坏一个心跳周期"，这是第一轮已经写明接受的取舍。按 beat 缓存
`list()` 只是把同一份新鲜度钉死，不引入新的滞后。

**建议**：`RoomDirectory.list()` 按 beat 缓存结果，`publishAll`/`sweep` 后失效；
`remoteRooms()` 读缓存。

**验收**：`test/room-dir.mjs` 的可见性判据（已是心跳窗口轮询口径）+ 双进程共享
`ROOMS_DB` 压测的大厅刷新延迟。

### N7（低危）· `applyInput` 先解码后判重：重复/迟到包白建 28 字段对象

**证据**：`server/room.mjs:350-370` 先 `decodeInputBits(net.keys, net.buttons)` 建 28 字段
输入对象，**之后**才判 `d === 0 || d >= 2000` 丢弃；而 `decodeInput` 填好的
`scratch.tick` 在判重之前就有。

**影响**：突发恢复 / 洪水 / 迟到包场景下每个被丢的包都白付一次 28 字段分配；正常流
无差别，所以列低危。第一轮只写了"狂发烧的是解码"，没立这条顺序账。

**建议**：把 `d` 的判重提到 `decodeInputBits` 之前（用 scratch 里的 tick 原值）。

**验收**：16 位回绕、重复包丢弃、qDrop 计数与 `test/net-audit.mjs` 全部判据不变。

## 查过并排除的（本轮的"不是问题"）

- **WS 套接字 Nagle**：`ws` 库在连接上显式 `socket.setNoDelay()`
  （`node_modules/ws/lib/websocket.js:248`），20Hz 小包不会被粘住；实测本机
  Node v25 下确认。`perMessageDeflate` 默认关闭（`websocket-server.js:76`），
  不存在每帧压缩的 CPU 税。
- **`/api/rooms` 的同步目录读**：客户端只在登录/回退时拉一次（`js/menu.js:541` 起清单
  走 WS 推送），不是轮询热路径——N6 只针对 WS 推送那一侧。
- **会话查找**：users/sessions 全走内存 Map（`server/store.mjs:145-199`），whoami/
  handshake 无磁盘访问；`countUsers/countSessions` 是 `Map.size`。
- **`PoseRing.record`**：Float64Array 原地写，60Hz × (真人+Bot) 零分配
  （`server/lagcomp.mjs:41-51`）。
- **事件旁路背压闸的内存增长**：看似无界，实际被心跳兜住——TCP 零窗的连接收不到
  ping 也就回不了 pong，`PONG_STALE_MS=15s` 必然 terminate（`net-server.mjs:1389-1403`），
  事件积压窗口有上界。
- **`snapScratch` 跨拍复用 + `Buffer.from(view.buffer,…)`**：Buffer 是 view 不是拷贝，
  上一轮已按房间隔离，正确且零拷贝。
- **目录心跳每 beat 的 `publishAll`**：beat 续约本来就必须每拍跑（第一轮 A2/A3 已按
  批量 UPDATE + 脏标记收口），不是新问题。

## 建议的实施批次

- **批次 R1（低风险，判据现成）**：N3 四个调用点、N7 判重提前、N4 拆 listener、
  N6 目录清单按 beat 缓存。全是"行为逐字节不变"的去分配/去重复劳动。
- **批次 R2（需要小设计）**：N1 听觉降频（要保住 alert/hint/footstep 判据的行为等价）、
  N5 loadout 帧闸（要定档位与"没变就不重建"的比对键）。
- **批次 R3（并入批次 C 一起取证）**：N2 哑模型（与批次 C 的 Bot 数值状态档是同一类
  改动，共享同一套"两端偏差测量"门槛，建议一起做 profile 取证）。

## 落地记录（2026-10-04 · 全量）

用户批准后 R1/R2/R3 当轮全部落地（比原文计划提前：N2 的"两端偏差测量"门槛用
**判据等价**替代——权威端的 muzzle/effects/audio 全是桩，枪口与模型坐标不进任何玩法
数值，`test/heli-armor.mjs` 的命中体判据跑在无 headless 旗的 stubGame 上照旧全量建模，
B7/B8 逐字验证）。`npm test` 全链 EXIT=0、1204 条判据全绿。

| 条目 | 落地位置 | 判据 |
| --- | --- | --- |
| N1 听觉 O(bots×noises) | `js/ai.js`：动作闸前置（闸关着时整个扫描循环无副作用，先问一次）＋平方距离替代 `distanceTo`（去 sqrt，同序）＋每 Bot 10Hz 降频（`__hearAt`，唯一行为让步：听觉最多晚 0.1s）；`server/headless-game.mjs`：noises 原地压实（谓词与幸存次序逐字不变），不再每拍 filter 新数组 | `test/room-bots.mjs`（听觉/alertGroup 判据全绿）；`test/mp-rules.mjs` |
| N2 权威端建完整模型 | `server/headless-game.mjs`：新增 `headless` 旗标；`spawnPickup` 不再调 `buildGun`（p.pos 仍按原句 groundHeight+0.06 吸附，事件坐标不变；crand 抽取随模型一并消失——画面流，不入玩法流）；`js/mp.js` Sentry：headless 下只保留 Group/head/muzzle 三个 Object3D（枪口矩阵链逐字不变），mesh 省建；Heli：headless 下 mesh/rotor/tail 为 null，update/dispose 三处门控，**`this.yaw = look` 在门外永不被跳过**（heli-armor B7 的命中体契约） | `test/heli-armor.mjs`（含 B8 读 `h4.mesh.rotation.y`——stubGame 无旗，全量建模路径原样）、`test/mp-rules.mjs` 掉落/拾取段、`test/room-bots.mjs` |
| N3 每拍分配四处 | `js/match-rules.js`：`flagsTick` 改按旗下标复用槽位（字段同名同序，`out.flags` 不再白建——单机 mp.js:362 每拍消费它，权威端只读 `.caps`，两者都在同一次调用内同步消费）；`pickupsExpire` 返回模块级复用数组（main.js:989 / room.mjs 同步消费）；`uavHints` 敌表提到 Bot 循环外（每队一次）＋ sort 改最近者线性扫描（同序）；`server/room.mjs`：`enemiesOf` 拆出 `fillEnemies` 零分配内核，白磷灼烧每拍走 `__wpFoes` 复用数组 | `test/mp-rules.mjs`（dom/拾取/UAV 判据两端共用） |
| N4 上行 async 壳 | `server/net-server.mjs`：message 入口拆成同步 listener（速率闸＋二进制输入直通，自带 try/catch 兜底）＋ `handleTextFrame`（每连接一份闭包，只有 join/start 的真 await 在里面）；闸门语义不变 | `test/net-audit.mjs` 105/105、`test/net-feel.mjs`、`test/room-flow.mjs` |
| N5 窄帧无闸 | `server/net-server.mjs`：'loadout' 帧每连接 150ms 最小间隔（`ws.__loadoutAt`），被丢计数进 `/healthz` 的 `lobby.loadoutRate`（`server/lobby.mjs`）；respawn/streak 不动（sim 侧守卫本就 O(1)）。客户端每类选择只发一条（js/net/client.mjs applyClass），正常操作碰不到 | `test/room-flow.mjs`（换配装重生生效判据） |
| N6 目录逐帧 SELECT | `server/room-dir.mjs`：`list()` 按拍缓存，`cacheMs` 选项**默认 0（不缓存）**——判据/探针零影响；生产由 net-server 传 `CFG.roomBeatMs`；`sweep()` 显式失效（它删别台的行）；publishAll 不失效（本台的行从不进 list()） | `test/room-dir.mjs` 36/36（全部走不缓存默认路） |
| N7 判重提前 | `server/room.mjs` `applyInput`：16 位回绕判重提到 `decodeInputBits` 之前（读 codec 已解出的 `net.tick`），判定式逐字一致 | `test/net-audit.mjs`（回绕/重复包/qDrop）、`test/net-journal.mjs` |

### 落地说明两则

- **N1 的 10Hz 是唯一的行为让步**，已写进代码注释：噪声 0.5s 过期、交火时下一发子弹
  立刻补上，感知不出；换来 O(60Hz×bots×noises) → O(10Hz)，且闸关着的 Bot（刚看见/
  听见过东西的）整个扫描直接跳过。
- **N2 未做两端偏差测量**的理由：权威端上 `effects`/`audio`/`hud` 全是记录型桩，枪口
  坐标、模型姿态不进任何玩法数值（fireHitscan 的射线从 eye 出发、方向指向目标胸口，
  与 mesh/muzzle 无关）；真正的玩家侧哑副本由客户端按事件自建，一行未动。若未来把
  Bot 数值状态档（批次 C）提上日程，N2 的处置方式可直接复用。
