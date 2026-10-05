# 客户端性能审查 · 第一轮（C1 落地，其余立账）

- 审查日期：2026-10-05。范围：**浏览器客户端本体** —— 主循环与每拍/每帧热路径、HUD、
  碰撞与 raycast、渲染管线、以及"能不能上多核"（Worker / OffscreenCanvas / SAB）。
  服务端与前两轮网络路径（`net-server-performance-audit{-round2}.md`、
  `net-performance-audit-round3.md`）已立的账不重复。
- 方式：源码走读。全仓 grep 过 `new Worker` / `OffscreenCanvas` / `SharedArrayBuffer` /
  `WebAssembly`：客户端目前**零多核**——唯一一份 `WorkerPool.js` 在 vendored 的 three
  addons 里且未被引用。本轮无 profile 取证——需要数据的项（C2）按服务端审计立的门槛
  **先测量再动**。
- **实施状态（2026-10-05）**：C1、C2、C3 已当日落地，其余按文末《建议的实施批次》。
  本文证据段的行号按**改动前**的代码写，落地后的偏移见文末《实施记录》。

## 清单（按收益/风险比排）

### C1 · HUD 挂在 60Hz 模拟拍上，每拍付渲染级的钱 —— 已落地

**状态**：已落地（`js/hud.js` 敌名 15Hz / 小地图 30Hz / marker 内容签名门 / equipRow
签名门 / 弹药三格同值门）。

**证据**（改动前行号）

- `hud.update` 挂在 `Game.update`（main.js:973），固定步长下每秒跑 60 次。
- **敌名扫描**（hud.js:327-343）：每拍一次 `world.raycast`（全盒线性扫，见 C2）+
  全场实体 `hitTest` 扫描 —— 为了一格 `#enemyName` 的 textContent。
- **drawMinimap**（hud.js:374-429）：每拍 `clearRect` + topDown 整图缩放 blit +
  逐实体圆点 + 旗标文字，HUD 里最重的一格。
- **updateMarkers**（hud.js:350-372）：每个标记**每拍重写一次 innerHTML**（:369，含
  距离读数）—— client.mjs 的 `_mSig` 门只门了"列表数据"这一半，DOM 写那一半没门。
- **equipRow**（hud.js:306-313）：innerHTML **每拍全量重建**一个几乎从不变的小字符串
  —— 与 W4 的 streak 同一家族，本轮走读新发现（W4 只收了 streak 那一格）。
- **弹药三格**（hud.js:294-304）：weaponName/ammoMag/ammoRes 的 textContent 每拍
  同值重写 —— textContent 同值赋值也会替换文本节点触发失效，不是免费操作。
- 同文件已有的门（比分条 6Hz、streaks 签名门、markers 数据签名门）说明这一族问题
  作者本来就在收 —— C1 是把剩下的口子一次收齐。

**落地要点**

- 累加器 `+= dt` + `%= 周期`（余数进位），固定步长下整周期对齐，单机变步长也不漂；
  初值给满，进对局第一拍就画，不等第一个周期。
- marker 只门"内容"（className/innerHTML），投影与 left/top **仍每拍照写** —— 省的是
  DOM 重建，不是贴镜头的跟踪；距离读数取整米，站着不动一次都不写。
- reset() 归位 `_eqSig` 与两个累加器：重开局若装备串恰好与上局相同，没有这一步会
  跳写、装备行空白。

**验收**：test/net-play.mjs 新增 HUD 节流段（暂停本地模拟 → **同步**手动驱动
`hud.update(1/60)×60` 计数 —— 同步块内没有快照/事件能插进来，计数是确定的）：
小地图 30Hz 频带、敌名 15Hz 频带、equipRow 静止 0 次 + 数据变更当拍 1 次、
marker 内容 0 次。net-feel 不受影响（它 mock 了整个 HUD，不经此路径）。

### C2 · 碰撞与 raycast 无宽相：全盒线性扫 —— 已落地（逐位等价宽相）

**状态**：已落地（`js/world.js` 的 `buildBroad`/`_query` + 五条查询改造；
判据 `test/world-equiv.mjs`，已登记 `npm test` 主体档）。

**证据**（改动前行号）：`world.raycast` / `lineBlocked` / `collide` / `groundHeight` /
`ceilingHeight`（world.js:507-585）全部 O(#boxes) 线性扫；开枪（combat 的
fireHitscan/traceBullet）、bot 感知与哨戒炮/直升机的 LOS（ai.js / mp.js）、移动碰撞
全走这一段。dune 图 444 盒、kaldash 248 盒。

**落地要点（每一条都是等价性的命根子）**

- 均匀哈希格子（8m），查询按"包围盒+2cm 裕量"取候选，**索引升序**返回——五条查询的
  逐盒判定一字不改、顺序与全量扫一致，tie 落同一盒。
- 格网范围取**全部盒子的联合包围盒**，不是 `def.size`：地面大平面横跨 size+80 米，
  范围窄了的话格外的查询一格都取不到而全量扫照样命中（第一版在这里翻的车）。
- `collide` 的推挤会在循环中途改 pos——固定候选框可能漏"被推出去之后才碰到的盒子"。
  推挤全程记包络（min/max），出包络就还原入参、包络翻倍整轮重来；正常几何零重试。
- **`rayAABB` 的 NaN 幽灵命中必须复刻而不是修**：d 某轴分量为 0（`1/0=∞`）且原点
  坐标与某盒面**精确相等**时，`(0)×(∞)=NaN` 毒化 `tmax`，之后所有比较恒 false——
  任何远处的盒子都会被判成 t=0 命中。这是两端逐位共有的既有行为；宽相为此带
  `_faceX/Y/Z` 精确贴面索引（只在对应分量为 0 时查），且轴零射线的 y 粗筛整段跳过
  （幽灵连 y 几何都不认）。
- 运行时增删盒子的两条路都盖住：`box()`/`collider()` 打脏标记；战役闸门直接
  `filter w.boxes`（campaign.js:openGate）——查询前校验盒子长度，变了就重建。
- scratch（候选数组/戳）挂在 **World 实例**上不挂模块级——服务端多房间各一个
  World，跨房互踩是立过账的教训。
- Int32 戳的回绕守卫（2^31 次查询后戳截断会假阳性）。

**验收**：`test/world-equiv.mjs`（1.6s）——宽相 vs 逐字拷贝的旧全量扫差分：真地图
（dune/kaldash）泛洪 + 原点贴盒面边缘用例 + 嵌套大盒逼包络重试 + 闸门删盒重建 +
"比对器会红"的反证臂。落地时一次性探针在五图上跑到 **526433/526433 逐位一致**
后收敛为此精简判据。剪枝读数：40m 射线平均候选 dune 11.3/444、kaldash 1.9/248。

### C3 · 远端玩家骨骼动画每渲染帧一次 —— 已落地（钉 60Hz）

**状态**：已落地（`js/net/remote.mjs` 的 `_anim(dt)` 节流；判据 net-feel AE 段）。

**证据**（改动前行号）：`NetPlayer.update` 由 `frameUpdate`（client.mjs:1348）**每渲染帧**
驱动，内含两次 `animateSoldier`（remote.mjs:233 离房淡出支、:340 主支）：144Hz 屏 ×
15 个远端 ≈ 2160 次/s 的两骨 IK + 姿态平滑（60Hz 屏也有 ~900 次/s），全部在主线程。

**落地要点**：pos/yaw/姿态通道（prone/lean/ads/slide/sprint/air）的插值与平滑**仍按
渲染帧走**（144Hz 下移动依旧丝滑），只有落骨这一坨按 ≥1/60 的节拍跑，dt 用累进的
真实帧时——动画速度与 60Hz 驱动同速。按 60Hz 驱动（net-feel、锁 60 的渲染）时每拍
必发，行为与旧代码一致。`animRuns` 计数给判据用（与既有的 `drives` 同一风格）。

**验收**：net-feel AE 段四条——60Hz 驱动逐位等于旧行为（60 次/秒）、144Hz/240Hz
驱动钉在 60、以及"姿态平滑仍按帧收敛"（240 小步 ≈ 60 大步收敛到同一落点；平滑被
搬进节流分支会当场分叉）。

### C4 · 过程化贴图生成占着主线程做启动（多核最高 ROI）—— 已落地

**状态**：已落地（`js/textures-core.js` 抽核 + `js/worker.mjs` + `materials.initTextures`
双路；判据 `test/worker-core.mjs` + `test/worker-live.mjs`）。

**证据**（改动前行号）：全部纹理都是启动时逐像素 JS 循环生成（textures.js）；`initTextures`
（materials.js:10-27）14 种材质 + 5 fabric + 6 camo 全同步，只在 kind 之间 `setTimeout(0)`
让出 —— 加载画面那段时间里的主线程大头。

**落地要点**

- 抽核分层：`textures-core.js` 是**纯计算**（GEN 表 + 逐像素循环 + 法线差分，零 THREE/
  零 DOM），`textures.js` 只剩"包 canvas/建 THREE 纹理"的薄壳（memcpy 量级）与运行时
  小贴图（particleTex/textTexture，事件驱动，不值一条消息往返）。
- **Worker 里没有 import map**：module worker 的模块解析不走页面的 import map，
  `'three'` 裸说明符当场解析失败，而 util.js 顶层 import 'three' —— noise.js/`BinaryHeap`
  等小件全部下沉到纯模块，util.js **转出保持既有 import 不变**（rng.js 同款先例）。
- 工单数据化：materials 的 `texJobs()` 是 Worker 路与同步回退路的唯一数据源，两条路
  不会漂；同工单同一份核心 ⇒ 输出**逐位一致**，回退路随时可换。
- 失败全兜底：Worker 起不来（file://、老浏览器、策略封锁）、脚本 404、生成抛错、
  30s 看门狗 —— 任何一路失败整条退回同步路重生成（纯函数，重生成安全）。

**验收**：worker-core（C4a-e：确定性/工单形状/同步路 19 种 TEX 全就位/Node 回退标记）；
worker-live A 臂（真浏览器：`__texViaWorker === true`）。gunvisual/optic/viewmodel 等
截图套件全绿 = Worker 生成的纹理与旧主线程产物像素级同貌。

### C5 · A* 寻路 Worker 化 —— 已落地（客户端离线路）

**状态**：已落地（`js/pathfind.js` 抽核 + `js/worker.mjs` 兼跑 + `ai.js requestPath`
异步接缝；判据同上两份）。

**证据**（改动前行号）：`world.findPath`（world.js:641）是静态 Uint8Array 网格上的
BFS/堆，已有每 tick 3 次的预算闸。全仓唯一调用点是 `ai.js Bot.requestPath`（ai.js:211）
—— 接缝单点。联机的 bot 在服务端跑，客户端这份只服务单机/离线。

**落地要点**

- 抽核：`pathfind.js` = BinaryHeap（自 util.js 迁来，util 转出）+ `astarPath`
  （world.js 原文逐字搬入，输出改裸 `{x,z}[]`）；`world.findPath` 变包装层。
  nearestWalkable/gridLOS 随本体迁移（全仓无其他调用点；cellOf/walkable 留守给
  ai.js 的侧向探针）。
- 双端同形接缝：`Bot.requestPath` 改走 `game.requestPath(from, to, cb)` ——
  **服务端/回退同步现算且回调当场执行（与旧代码逐位一致）**；客户端 Worker 路晚几拍
  送达（FIFO），在途时 bot 直奔目标（与"找不到路"同一行为）。`pathPending` 门防
  "在途连发"——同步路下回调当场清门，行为与旧代码完全一致。
- 网格同步：每次建图后 `grid.slice()` 一份送 Worker（40KB 量级，不 transfer）；
  战役东门的运行时 rebuild（campaign.js 两处 buildGrid）经 `game.onGridRebuilt()`
  重发 —— 闸门开了 Worker 的格子也要跟上。
- **fps.mjs 显式关掉 Worker 寻路**（`g.pathWorker = null`）：它的跨帧率逐位全等
  判据吃 bot 行为的确定性（hp/aliveBots 在比对行里），而 Worker 送达拍随墙钟抖。
  Worker 寻路的端到端判据归 worker-live。

**验收**：worker-core（C5a-f：金标路径可重复/包装层==直调==格子拷贝逐位一致/
heap 同一份）；worker-live A 臂（bot 路径经 Worker 送达 + 防洪臂）+ B 臂（封锁
Worker 后对局照常、bot 照常拿路径）；全矩阵里 room-bots/mp-rules 等 server 侧
寻路判据全绿 = 同步路与旧代码逐位一致。

### C6 · 快照解码 Worker 化（评估后不做）

**决定**：不做。decodeSnapshot 是 20Hz × 20-40 实体 × 26B 定长的 DataView 读，本来
就便宜；第三轮 W 批刚把这条路径刮过一遍。值不回工程成本，记一笔免得再提。

### C7 · 模拟/渲染搬进 Worker（否决，立账为"不做"）

**决定**：不做，理由立此存照。

- **模拟**：客户端预测是逐实体 RNG 流（entStream）+ journal 的位级确定性回放，
  直接改活对象（player.js 的 journal/静音 Proxy）。搬 Worker 意味着每 tick 状态
  序列化进出、整套确定性机制重造——结构级重写、高风险，而每 tick 本身是 O(玩家数)
  的便宜算术。瓶颈不在算术，在 C1/C2 那种每拍的固定开销。
- **渲染**：场景图被 sim/插值/AI 直接改（remote.mjs / ai.js / world.js），拆 worker
  要先加一层命令缓冲，等于重写客户端。OffscreenCanvas 只剩小地图（2D）可用——
  C1 节流之后连它都不需要。
- 备忘：若未来真要 SharedArrayBuffer 共享快照，部署侧要加 COOP/COEP 头（目前无此
  计划，届时先过 deploy-checklist）。

### C8 · 打包/压缩/HTTP 缓存（发布线，独立评估）

**证据**：无 bundler、无压缩；three 54k 行 vendored + jsm 全目录在盘上（ESM 按需
拉取，问题在请求数不在体积）。esbuild 压缩 + 静态缓存头属于**加载**优化，不属于
帧率；且第一轮立过"发版本即同步"的取舍（no-cache 是有意的），动它要先对齐那条账。

## 查过并排除的（本轮的"不是问题"）

- **渲染器底子已经收敛**：antialias off + FXAA、DPR 封顶 1.5（低画质 1）、bloom
  低画质关、ACES + sRGB、单盏方向光阴影跟拍（4m 格 snap）、开局 `renderer.compile`
  预热。没有"白给的渲染开关"剩下了。
- **几何侧已做**：静态世界几何按材质合并（world.js finalize）；士兵/枪模几何模块级
  缓存 + 手写距离 LOD；士兵细节件不投影。
- **粒子**：池化 Points（effects.js），`frustumCulled = false` 是刻意的（雨雪与全局
  特效不该被视锥裁）——单独做裁剪收益存疑，不动。
- **节流密度已经不低**：bot 感知 ~7Hz / 听觉 10Hz / 寻路预算 3 次/tick / 比分条 6Hz /
  streaks+markers 数据签名门 / respawn 文本变更门 / FPS 读数 0.5s。
- **上行/解码侧**第三轮刚收刮过（W3/W6/W7），本轮不重复。
- **纹理 100% 过程化** ⇒ 不存在二进制资产预载、压缩纹理（KTX2）、Draco 这一整类
  优化面；512/256 双档 + anisotropy 8 已设。

## 建议的实施批次

- **批次 C-A（表现层，判据现成）**：C1 —— ✅ 2026-10-05 已落地。
- **批次 C-B（表现层第二刀）**：C3 —— ✅ 2026-10-05 已落地（随 C2 同车）。
- **批次 C-C（两端同形状）**：C2 —— ✅ 2026-10-05 已落地（等价性先于一切，
  判据 `test/world-equiv.mjs` 进 `npm test` 主体档；原文"先测量再动"的门槛被
  逐位等价差分探针替代——探针本身就是测量）。
- **批次 C-D（多核线）**：C4 → C5 —— ✅ 2026-10-05 已落地（C6/C7 按上文决定不做）。
- **发布线**：C8 独立评估，与帧率无关。

## 实施记录（2026-10-05 · C1）

**改了什么**：`js/hud.js`（敌名 15Hz 累加器、小地图 30Hz、marker 内容签名门、
equipRow 签名门、弹药三格同值门、reset 归位节流状态）；`test/net-play.mjs`
（新增 HUD 节流段：暂停本地模拟 → 同步手动驱动 `hud.update(1/60)` × 60 → 计数
断言 + 数据变更臂）。

**纪律（落地时守住的四条）**

1. 累加器 `+= dt` / `%= 周期`，不是"倒计时到 0 重置"——余数进位，固定步长下整周期
   对齐，单机变步长（A/B 开关）也不漂。
2. marker 只门内容（className/innerHTML），投影与 left/top 每拍照写——否则镜头一转
   标记就"拖影"。
3. reset() 归位 `_eqSig` 与两个累加器——重开局装备串恰好相同时防"跳写导致空白"。
4. 敌名 textContent 写在门内：名字读数最坏 66ms 延迟（含死亡清名），肉眼不可分；
   换来每秒少 45 次全盒 raycast + 全场 hitTest，纯赚。

**判据**：net-play 新增 5 条（小地图 30Hz 频带 / 敌名 15Hz 频带 / equipRow 静止 0 次
与变更当拍 1 次 / marker 内容 0 次）；net-feel 全绿不受影响（mock HUD 不经此路径）；
未新增测试文件，docs-guard 与 README/部署清单无涉。

**行号校正**：本文证据按改动前行号写；`hud.js` 的 update() 各段因插入注释整体后移，
以 git blame 为准。

## 实施记录（2026-10-05 · C2 + C3）

**改了什么**：`js/world.js`（buildBroad/_query 宽相 + 五条查询改造 + 脏标记/长度校验/
回绕守卫 + `_faceX/Y/Z` 贴面索引）、`js/net/remote.mjs`（`_anim(dt)` 骨骼求解钉 60Hz +
`animRuns` 计数）；判据 `test/world-equiv.mjs`（新增，登记 `npm test` 主体档 +
README《验收》+ deploy-checklist §0）、`test/net-feel.mjs`（AE 段四条）。

**落地时抓出来的两个真坑**（一次性等价探针的贡献，探针用完已删、判据沉淀为
world-equiv）：

1. **格网范围不能按 `def.size` 取**：地面那张大平面横跨 `size+80` 米。第一版格网盖到
   ±(half+2)，格外（比如探针打在 x=−95 的地面上）的查询一格都取不到、返回 null，
   而全量扫照样命中。改成按全部盒子的联合包围盒取范围，x/z 各有原点。
2. **`rayAABB` 的 NaN 幽灵命中**：方向某轴分量为 0（`1/0=∞`）且原点坐标与某盒面
   **精确相等**时，`(0)×(∞)=NaN` 毒化 `tmax`，此后三个 slab 的 `tmin > tmax` 全是
   false——**任何远处的盒子都会被判成 t=0 命中**（探针实录：打在 x=−37.25 墙沿上的
   垂直射线"命中"了 z 轴 10 米外的一面墙，并把真墙 2.25m 外的命中顶掉）。它是两端
   逐位共有的既有行为，等价纪律要求**复刻而不是修**——修了就是两端同时悄悄改物理，
   回滚重放的判据一个都不会红，但弹道/LOS 在这些面上悄悄变了。宽相为此带精确贴面
   索引（平时零开销），并且**轴零射线整段跳过 y 粗筛**（幽灵不认任何 slab 几何）。

**纪律（落地时守住的）**

1. 候选**索引升序**返回：五条查询的逐盒判定一字不改、顺序与全量扫一致——tie 落
   同一盒、collide 的推挤顺序不变，结果逐位相同。
2. `collide` 的包络重试：推挤破坏性改 pos，重试前**还原入参**（x/y/z + vel 五个标量）；
   正常几何零重试，退化几何包络翻倍最终收敛到全量=旧行为。
3. scratch 挂 World 实例不挂模块级（服务端多房间互踩的既有教训）；Int32 戳带回绕守卫。
4. `test/world-equiv.mjs` 带反证臂 R1：brute 在原世界取样、只挪被测实现眼里的盒面
   1e-9，差分必须当场看见——防"恒绿比对器"。第一版反证臂挪的是两边共读的同一个盒，
   两边一起变、测不出东西，被判据自己抓住了。
5. C3 的节流只动 `animateSoldier` 调用点：插值/平滑每帧照旧（AE4 的 240 小步 ≈ 60 大步
   收敛判据专门防"顺手把平滑搬进节流分支"）。

**判据**：world-equiv 6/6（1.6s，含 R1/R1b 反证臂）；net-feel 217/217（AE 段 +4）；
全矩阵见当日提交说明。

## 实施记录（2026-10-05 · C4 + C5 多核线）

**改了什么**：新模块 `js/noise.js`（clamp/lerp/TileNoise 下沉）、`js/textures-core.js`
（贴图生成纯核）、`js/pathfind.js`（BinaryHeap + astarPath 纯核）、`js/worker.mjs`
（常驻 Worker：贴图工单 + 寻路服务）；`js/textures.js` 瘦身为包壳、`js/materials.js`
工单化双路（texJobs + worker 交换 + 同步回退 + 30s 看门狗 + `__texViaWorker` 读数）、
`js/world.js` findPath 改包装（nearestWalkable/gridLOS 迁出）、`js/util.js` 转出
（rng.js 同款先例）、`js/main.js`（spawnGameWorker/消息泵易主/syncPathGrid/
onGridRebuilt/requestPath）、`server/headless-game.mjs`（同名同步 requestPath）、
`js/ai.js`（requestPath 异步接缝 + pathPending 门）、`js/campaign.js`（东门两处
网格重发钩子）、`test/fps.mjs`（显式关 Worker 寻路保逐位全等）；判据
`test/worker-core.mjs`（node，20 条）+ `test/worker-live.mjs`（真浏览器离线实跑
双路，11 条），均已登记主体档/浏览器档 + README《验收》+ deploy-checklist §0。

**落地时守住的纪律**

1. **Worker 里零 THREE**：module worker 没有 import map，'three' 裸说明符解析失败。
   凡 worker 要 import 的模块（noise/textures-core/pathfind/rng）一个 THREE 都不能
   碰 —— 小件下沉 + util.js 转出是唯一通路，这也是 BinaryHeap/TileNoise 迁家的原因。
2. **两条路逐位一致才许并存**：Worker 路与同步回退路共用同一份核心（工单表同源、
   astarPath 同函数），worker-core 钉死"包装层 == 直调 == 格子拷贝"。差分探针法
   继续沿用：先一次性探针跑通，再收敛成常驻判据。
3. **异步接缝的最小行为差**：Bot.requestPath 的 pathT/pathGoal 在**请求时**就写
   （steer 的重寻路条件靠它自限），pathPending 门防在途连发；服务端同步路回调当场
   执行 —— room-bots 等全部服务端寻路判据全绿 = 与旧代码逐位一致。
4. **确定性判据与 Worker 判据分家**：fps.mjs 的跨帧率逐位全等吃 bot 确定性（hp/
   aliveBots 在比对行），Worker 送达拍随墙钟抖 —— 该套件 `g.pathWorker = null` 走
   同步路；Worker 端到端归 worker-live，不混在一起。
5. **失败全兜底**：Worker 构造失败/脚本 404/生成抛错/30s 看门狗/运行中 onerror，
   任何一路失败都整条退回主线程同步路（纯函数重生成安全）；worker-live B 臂把
   `window.Worker` 封锁死做了整条回退的真浏览器实证。
6. **手动喂帧的套件必须关 Worker 寻路**（viewmodel/optic/gunvisual/state-leak/fps
   五份，`g.pathWorker = null`）：它们在**一段同步 evaluate 里**驱动整局 —— 同步块内
   Worker 消息永远送不进来，bot 会卡死在 pathPending（pending 门反而不放行重试）、
   全体直奔目标，走位与旧代码不同步不说，真会把测试玩家打死（viewmodel 首跑就是这么
   红的：玩家死亡后 updateRender 停摆，adsT 恒 0、reload 永不推进）。这些套件要的
   也是确定性 —— 同步路与旧代码逐位一致，正合适。

**判据**：worker-core 20/20、worker-live 11/11（A 臂 6 + B 臂 5）、docs-guard 全绿
（三处登记对账）；全矩阵见当日提交说明。
