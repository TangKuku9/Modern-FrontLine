# 联机对局 与 本地对局 的体验差距清单

调研对象：`js/`（客户端与共用的 sim）+ `server/`（权威端）+ `js/net/`（联机表现层）。
方法：只读走查，全部结论附 `文件:行号`；高影响项逐条回读源码复核（见《附一 · 证据等级》）。
本文只列差距，不含修法。

---

## 结论

联机和本地**不是同一套玩法少收了几处**，而是**三条不同的缺失链**同时存在，且互相放大：

1. **内容/规则层**被砍到只剩一小半 —— 3 种模式剩 1 种、连杀奖励不能自选、局内不能换职业、不能捡枪、助攻没有、没有结算页。
2. **世界实体层根本不在协议里** —— 别人的手雷/燃烧瓶/闪光/烟雾/RPG 弹既不存在于快照，也没有对应事件。玩家看到的是"血条突然掉一截"，不是"我被炸了"。
3. **远端玩家的表现层几乎是空的** —— 位置插值在跑，但开火没枪声没曳光、脚步没声音、受击没反馈、死亡没提示。数据到客户端了，没人画。
4. **本地玩家自己的反馈闭环断了** —— 击杀播报、死亡画面、受伤方向、痛感音，四处都没接线（`onNetKill`/`onNetDeath` 在 `js/main.js` 里不存在）。

按玩家感知排序，最刺眼的三条是：**听不见别人（第 20 + 21 条）**、**打死了没有任何提示（第 31 + 32 条）**、**手雷看不到（第 12 条）**。
（原文这里引的条号是更早一稿的编号，已按下面各表的编号校正。）

> **收口进度见《附四 · 收口记录》**（文末）。上面五张表是**建立当时的原貌**，它们仍是"还差什么"的清单；
> 本轮收掉了哪几条、每条用什么判据钉住、以及还剩下什么，全部记在附四。

---

## 一、内容与规则：被砍到只剩一小半

| # | 差距 | 本地 | 联机 | 证据 |
|---|---|---|---|---|
| 1 | 可选模式 | `tdm` / `dom` / `ffa` 三种 | **只有 `tdm`**。`dom`/`ffa` 的 `net` 标记是 `false`，服务端按同一标记拒绝 | `js/data.js:276-280`、`server/lobby.mjs:43,47,233` |
| 2 | 地图 | 4 张任选 | 走大厅建房 4 张；**直连 / 快速加入落到新建房时被 `MAP` 环境变量写死（默认 yard）** | `server/net-server.mjs:56,466-479`、`js/menu.js:295,444` |
| 3 | 人数 | 固定满员（TDM 12 人 / FFA 7 人） | 2~16 人，**房间不自动放 AI** ⇒ 常见 1v1 空场 | `js/menu.js:59`、`js/mp.js:66-69`、`server/room.mjs:99,348-350` |
| 4 | 连杀奖励选择权 | 玩家自选 3 项（5 选 3，`pickStreaks`） | **锁死 UAV / 集束空袭 / 武装直升机**；`resolveStreaks(opts.streaks)` 的入参没有任何调用方传过 | `js/data.js:260`、`server/room.mjs:41-44,87`、`js/menu.js:922-931` |
| 5 | 局内换配装 | 死亡时可换职业，重生生效 | **不存在**：`NetClient` 没有 `applyClass`，暂停菜单那句"将在下次部署时生效"是假反馈 | `js/mp.js:107-110,321`、`js/menu.js:1095-1097` |
| 6 | 捡枪 | 击杀掉落 + 走近拾取 | **没有**：服务端 `onKill` 不掉落，快照也不编 `pickups` | `js/mp.js:174`、`js/main.js:700-737`、`server/room.mjs:375-400` |
| 7 | Perk 有效项 | 12 项全可感 | 约 8 项。**拾荒者 / 速愈(击杀回血) / 幽灵 / 高度警觉 联机无效**；冷血只剩"不怕哨戒机枪与直升机" | `js/mp.js:218,219,384`、`js/ai.js:164,270` vs `server/room.mjs:375-400` |
| 8 | 助攻 | 有：`+25` 分 + 连杀充 0.5 + 记分板一列 | **没有**：服务端无伤害账，记分板助攻列硬编码 `-` | `js/mp.js:165-168` vs `server/room.mjs:375-400,442`、`js/net/client.mjs:842` |
| 9 | 胜负奖励与 xp | 结算给 `score + 500/150`，写本地档案 | 只有当局 score；**访客 0 xp**（`if (!c.account) continue`） | `js/mp.js:476-477` vs `server/room.mjs:413,416` |
| 10 | 结算页 | 胜/负/平 + K/D + 命中率 + 经验值 + 等级条 + 再来一局 | **没有**：`matchOver` 只播一句"胜利"并把记分板钉在屏幕上，然后弹回房间 | `js/mp.js:458-489`、`js/menu.js:1110` vs `js/net/client.mjs:746-752` |
| 11 | 集束空袭的选点 | 准星 + 落点环，左键确认 / 右键取消，取消不扣槽 | 服务端直接取呼叫者视线前方 22 m，**按下即消耗** | `js/mp.js:269-273,406-424` vs `server/room.mjs:46-49,478-487` |

---

## 二、世界实体与事件：协议里根本没有

下行包只有两种：20Hz 定长二进制快照（**11 B 头 + N×25 B，没有任何变长尾巴**）与 20Hz 的 JSON 事件帧。实体表**只装真人玩家**；世界级状态总共只有 1 字节 `worldFlags`。

| # | 差距 | 证据 | 归类 |
|---|---|---|---|
| 12 | **别人的投掷物完全隐形** —— 手雷 / 粘性 / 燃烧瓶 / 闪光 / 烟雾 / RPG 弹都不存在于快照，事件表里也没有 `projectile` / `explosion` | `server/codec.mjs:14,19,32-47,88`、`server/room.mjs:547-567`、`js/quant.js:53` | 协议没字段 |
| 13 | **燃烧瓶在联机零伤害** —— 服务端的 `effects.addFireSource` 是一个返回假对象的桩，伤害回调永不执行；服务端 step 里也没有 `effects.update` | `server/stubs.mjs:41-44`、`js/combat.js:228`、`js/main.js:697` vs `server/headless-game.mjs:137-150` | 服务端没跑 |
| 14 | **闪光弹对真人零效果** —— `flashAt` 里 `e.isPlayer` 分支只调 `hud.flash` / `audio.ring`，而服务端这两个都是桩；也不写任何状态位（`stun()` 只对 Bot 存在） | `js/combat.js:107-117`、`js/ai.js:119` | 服务端没跑 |
| 15 | **集束空袭只是屏幕上一行字** —— 服务端真投 9 颗真炸，客户端只有一条 announce，没有落点环、没有落弹、没有爆炸、没有震屏 | `server/room.mjs:486`、`js/net/client.mjs:725-737` vs `js/mp.js:406-424` | 协议 + 表现层 |
| 16 | **白磷弹只有一次 55 点 + 一层屏幕橙** —— 持续灼烧那段（每拍 6 点）写在 `mp.js` 的 `MPMatch.update` 里，服务端 `NetRoom` 里没有；`wpTicks` 在服务端只被写不被读 | `server/room.mjs:489-490` and `.search('wpTicks')` 无消费点、`js/mp.js:389` | 服务端没跑 |
| 17 | **别人打来的爆炸不震屏、不耳鸣** —— 冲击反馈只对自己生成的爆炸有 | `js/combat.js:78-79`、`js/audio.js:155` | 协议没字段 |
| 18 | 哨戒机枪 / 武装直升机是**哑副本** —— 有模型、会转向、有枪声，但 `dumb` 分支直接 `return`（不发子弹不裁决）；直升机的航线相位只在生成时同步一次，之后两端各自 `ang += dt*0.18` 会缓慢漂移 | `js/mp.js:573-579,636-647`、`js/net/client.mjs:787-800`、`server/room.mjs:506-517` | 表现层（有意简化） |
| 19 | 敌方 UAV / 空袭 / 直升机**来袭播报缺失** —— 本地有 `announce('敌方空袭来袭！')`，联机只广播呼叫类 | `js/mp.js:244-255` vs `server/room.mjs:477,487,491,500` | 表现层没接线 |

---

## 三、远端玩家的表现层：数据到了，没人画

`js/net/remote.mjs` 里**没有任何一处** `audio.*` / `tracer` / `effects.*` 调用（已 grep 确认）。位置插值本身是对的（100 ms 回退 + 150 ms 外推上限、24 包缓存），缺的是表现。

| # | 差距 | 证据 |
|---|---|---|
| 20 | 远端开火**只有一朵枪口精灵** —— 没有枪声、没有曳光、没有动态点光、没有枪口烟 | `js/net/remote.mjs:153-161` vs `js/ai.js:414-422` |
| 21 | 远端**脚步 / 落地 / 换弹全无声** ⇒ 听声辨位在联机里完全失效 | `js/net/client.mjs` 对 audio 的调用只有语音播报（`:723,727,737,750`）vs `js/ai.js:334` |
| 22 | 远端**模型朝向 180° 反**：`rotation.y = this.yaw + Math.PI`，而本地 AI 是 `rotation.y = this.yaw`。推导：`forward = (-sin y, 0, -cos y)`，模型正面在 -Z（眼睛 z=-0.161、枪 z=-0.3、背包 z=+0.2），相机也用 `rotation.y = aimYaw` —— 三者只有 `yaw+π` 是异类 | `js/net/remote.mjs:139,170` vs `js/ai.js:332`、`js/player.js:122,350`、`js/soldier.js:41,52,66,84` |
| 23 | 远端**俯仰符号相反**（`a.pitch = -this.pitch`）。与第 22 条是同一套推导的两个症状，改要一起改 | `js/net/remote.mjs:143` vs `js/ai.js:329` |
| 24 | **步态相位通道断了**：服务端把弧度值原样塞进 u8（`phase & 0xff`），客户端按裸整数读回当弧度用；`Q.packPhase/unpackPhase` 定义了但**全仓无人调用** ⇒ 腿部每包跳一次整数，低速时直接归零 | `server/room.mjs:563`、`server/codec.mjs:42,79`、`js/net/remote.mjs:146`、`js/quant.js:24-25`（无调用点） |
| 25 | 远端**受击没有抖动**；`NetPlayer.takeDamage` 恒 `return false` ⇒ `r.killed` 永远为假 ⇒ **击杀型红叉与击杀音效打不出来** | `js/net/remote.mjs:85-90`、`js/weapon-state.js:216-219`、`js/hud.js:41-46` |
| 26 | 远端**倒地方向恒定**（`fallDir: 1` 后再无写入），本地 AI 按受击方向决定 | `js/net/remote.mjs:49` vs `js/ai.js:101-104` |
| 27 | 远端**重生后一直趴着**：`animateSoldier` 的死亡分支写 `root.rotation.x/z`，存活分支从不复位；`remote.mjs` 每帧只写 `position` 与 `rotation.y`（本地 `ai.js:112` 有 `rotation.set(0, yaw, 0)`） | `js/soldier.js:128-151`、`js/net/remote.mjs:137-139`、`js/ai.js:112` |
| 28 | 远端**人人有穿墙名牌（含敌人）** —— 本地只有队友有。这是唯一一处"联机信息比本地更多" | `js/net/remote.mjs:47-48`、`js/soldier.js:120`（`depthTest:false` + `renderOrder=10`）vs `js/mp.js:95` |
| 29 | 远端**套件与迷彩不体现**（恒 `{}` / `'none'`），本地 AI 是随机配件 + 随机迷彩；且协议里没有 att/camo 字段 | `js/net/remote.mjs:43,167` vs `js/mp.js:95`、`server/codec.mjs:32-47` |
| 30 | 远端**离房 / 消失是瞬时的**（无淡出、无提示）；尸体不移除不淡出 | `js/net/client.mjs:269-275`、`js/net/remote.mjs:51-54` |
| — | 已同步但**客户端不消费**的三个字段：`FLAG.Ads`、`FLAG.Reloading`、`mag`；`FLAG.Sprint/Sliding/OnGround` 只存不用（滑铲没有姿态） | `js/net/remote.mjs` 无 `Ads`/`Reload`/`.mag` 命中；`server/room.mjs:553-562` |

---

## 四、本地玩家自己的反馈闭环：四处断线

| # | 差距 | 本地 | 联机 | 证据 |
|---|---|---|---|---|
| 31 | **击杀播报 killfeed 完全没有** | 右上角带武器名与爆头标记的播报 | 服务端**已经发了** `kill` 事件（killer/victim/weapon/head），客户端也收到了，但 `js/main.js` 里没有 `onNetKill` 这个函数 | `js/mp.js:154`、`js/hud.js:59-68` vs `server/room.mjs:529`、`js/net/client.mjs:701`（`g.onNetKill &&` 空过） |
| 32 | **死亡画面完全没有** | `#deathScreen`：被谁用什么杀的 + 4.5 s 倒计时 + 换装备窗口；死亡镜头会转向击杀者 | `onNetDeath` 同样不存在 ⇒ 面板从不显示、`deathKiller` 恒 null ⇒ 不转向；只有相机沉到地面 + 手上枪消失 | `js/mp.js:176-186,318-319`、`js/main.js:671-678` vs `js/net/client.mjs:700` |
| 33 | **挨打没有方向指示 / 没有痛感音 / 没有镜头冲击** | `takeDamage` 里三件一起做 | 本地玩家血量由快照直接覆盖（`pl.hp = e.hp`），**联机全程不走 `takeDamage`** | `js/player.js:128-150` vs `js/net/predict.mjs:109-110` |
| 34 | **重生节奏与操作** | 4.5 s + 按空格可提前，等待期能换配装 | 服务端 3.0 s 静默传送，无倒计时、无按键、不能换配装 | `js/mp.js:178,318-326` vs `server/room.mjs:24,239-253`、`js/net/client.mjs:702-711` |
| 35 | **命中判定是两套** | 当场裁决 | 客户端本地 hitscan **不带回溯**、打的是插值后（100 ms 前）的位置；服务端带回溯裁决 ⇒ 白叉与真实结果可能不一致（假阳性/假阴性都可能） | `js/weapon-state.js:211`（`game.mode.shotRewind`；`NetClient` 无此方法）、`server/room.mjs:297` |
| 36 | **敌人显示在过去** | 对 AI 是当场精确 | 插值回退 100 ms + 网络往返 ⇒ 看到的敌人位置比权威端旧 | `js/net/remote.mjs:18` |
| 37 | **没有任何网络状态 UI** | — | `rtt` 字段永远是 0（`sendPing()` 定义了但从无调用点）；无 ping / 丢包 / 抖动显示；延迟补偿被拒绝（四种成因）客户端零反馈 | `js/net/client.mjs:36,158,173`、`server/lagcomp.mjs`、`index.html`（HUD 里只有 `#fps`） |
| 38 | **Esc 暂停语义坏了** | 真暂停（update 全停） | 本地停、服务端照跑、**远端还在你屏幕上继续插值移动**；"更换配装"是假反馈；"重新开始对局"会 `ws.close()` 静默断开并开一局本地 bot 对局 | `js/main.js:435-440,622-646,654`、`js/menu.js:1071,1095-1097`、`js/net/client.mjs:857` |
| 39 | **Tab 记分板降级** | 名次 / 助攻 / 死亡灰行 / 实时刷新 | 无名次、助攻恒 `-`、无死亡态、**2 秒才刷新一次** | `js/mp.js:448-456` vs `js/net/client.mjs:841-848`、`server/room.mjs:278` |
| 40 | 连杀槽进度**只有 0.5 Hz**（本地是每次击杀即时）；哨戒机枪"无法在此部署"会被广播成 **"敌方 无法在此部署"给所有人** | `js/mp.js:236-238,277` vs `js/net/client.mjs:732-737,745` |
| 41 | 地图上**没有可拾取的枪**（同第 6 条的表现侧）；`#markers` 3D 标记层在联机路径下永远为空 | `js/mp.js:400`（唯二调用点） |
| 42 | **热成像不把远端涂成热源**（遍历的是 `this.bots`）；开火**不置 `revealT`** ⇒ 敌人开火在小地图上不亮点（本地会亮 1.5 s） | `js/main.js:594`、`js/net/remote.mjs:36`（唯一写入点）、`js/hud.js:262` |

---

## 五、聊天（联机新增层，本身也不完整）

| # | 差距 | 证据 |
|---|---|---|
| 43 | **对局中完全没有聊天** —— 面板只挂在 `online` / `onlineRoom` 两屏 | `js/main.js:278-280`、`js/menu.js:530,676` |
| 44 | **中文输入法没保护** —— `keydown` 里没有 `isComposing` 判断，回车上屏候选词会把半成品发出去（密码框同样） | `js/menu.js:587-590,415` |
| 45 | 无屏蔽 / 静音 / 举报、无表情、无私聊 / @、无时间戳、无队伍频道、历史不持久化 | 全仓无相关实现；`js/net/lobby.mjs:84,107-110` |

---

## 附一 · 证据等级

以下 16 条我在本轮**逐条回读源码/亲手 grep 复核**过（不是只看走查笔记）：

`1`（部分）、`4`（`resolveStreaks` 无调用方）、`7`（服务端无 scavenger/quickfix 分支）、`8`、`12`、`13`、`14`、`16`、`20`、`21`、`22`+`23`（按三处约定交叉推导）、`24`、`25`、`27`、`31`+`32`、`33`、`37`、`38`、`42`。

其中第 22 / 23 条（朝向 180° 反 + 俯仰符号反）是**推导**而非目视：三条独立约定互相印证（模型正面在 -Z、`forward` 公式、第一人称相机 `rotation.y = aimYaw`），本地 AI 与它们一致，只有远端那两行是异类。**动手前建议按 §附二 的方法做一次目视确认** —— 这个仓库里"形状自洽但归因错"有过先例。

## 附二 · 本仓库标准的验法（负对照）

- 朝向 / 重生后姿态：开两个窗口，对面**朝你跑并停在正前方**、再**死一次重生**，看是否背对 / 是否一直躺着。
- 投掷物隐形：对面扔一颗手雷到你脚边。若只有血条掉、没有飞行物与爆炸 ⇒ 成立。
- killfeed / 死亡画面：`js/main.js` 里搜 `onNetKill` / `onNetDeath` 无定义即可判定，无需实机。
- 燃烧瓶零伤害：`server/stubs.mjs` 的 `EFFECT_OVERRIDES` 里 `effects.addFireSource` 返回假对象、且服务端 step 无 `effects.update` ⇒ 回调不可能被跑到。
- 退到改动前的源码再跑一遍（`git stash push -- <源码文件>`，留判据）—— 判"这条差距是不是本轮引入的"。

## 附三 · 不是差距（别当 bug 修）

- 服务端不暂停、权威端 60Hz 照跑 —— 这是权威模拟的定义，不是缺陷；缺的是**客户端的提示与降级**（第 38 条）。
- 没有重生保护、没有卧倒、没有 killcam、没有伤害数字、没有爆头 hitmarker —— **两边都没有**，是共同缺口而非差异。
- 可开启的门、弹药补给箱 —— 单机也没有（`ammoCrate` 只被战役用）。
- 天气与灯光动画走渲染帧、从不进 sim —— 两端一致，不产生时间分叉。

## 附四 · 收口记录（第 1 轮 · 2026-09-28）

这一轮按上面五张表收口。每一行都附**守卫**（它坏掉时会变红的判据）与**反证臂**（证明这条判据不是恒真绿灯的那一条）。
新增判据文件 `test/net-feel.mjs`（93 条，纯 node、无浏览器），已并入 `npm test`；
面板那一半（killfeed / 死亡画面）在 `test/net-play.mjs` 里量，因为 `js/main.js` 既不导出 `Game`、构造它又要 WebGL。

### 已收

| 条 | 收法 | 守卫 / 反证臂 |
|---|---|---|
| 5 | `NetClient.applyClass()` 发 `{t:'loadout'}`，**不本地 equip**；`NetRoom.applyLoadout` 复用入场那条闸门（白名单重建，非法项被换掉而不是原样挂上）；暂停屏保留"更换配装" | net-feel K5–K8（含"合法选择原样通过"臂）、S3 |
| 8 | 权威端伤害流水账（`js/player.js` 里按 `game.onDamage` 挂钩 → `HeadlessGame.onDamage` → `NetRoom.onKill` 结算助攻）→ `assist` 事件 → HUD 弹窗 + 记分板助攻列 | net-feel 记分板/事件段；`test/net-journal.mjs` 字段覆盖守卫 |
| 12 / 15 | 协议加 `proj` 事件（起手 pos/vel/fuse/kind/team/netId）。客户端用 `Projectile(..., {dumb:true})` 按**同一套物理**自己飞、自己磕墙、自己炸，一次伤害都不裁。集束空袭那 9 颗本来就是真 `Projectile` ⇒ 自动跟着走这条通路 | net-feel J11–J13（J12 是"起手状态来自事件"臂）；`server/net-probe.mjs` |
| 13 | `makeStubs(extra)` 支持按 game 实例注入覆盖；`HeadlessGame` 注入真 `addFireSource`（火源表挂**实例**上，不跨房）并在 `step` 里每拍推进 | net-feel O1–O3（O3 是"火按半径裁"臂：12 m 外一滴血不掉） |
| 14 | `flashAt` 的真人分支先问 `game.flashPlayer`；服务端把它编成 `flash` 事件，浏览器侧 `Game.flashPlayer` 与单机**共用一处**算法 | net-feel L1–L3、J9/J10（L2 是"不两处都做"臂） |
| 16 | 白磷的持续灼烧从 `mp.js` 挪到服务端能跑的位置；客户端按 `worldFlags` 的 `WhitePhosphorus` 位刷屏幕效果（那一格以前在服务端硬编码 0） | net-play「客户端读到了快照头里的世界标志位」；`server/net-probe.mjs` |
| 17 | `explode` 里把冲击反馈（震屏 / 耳鸣）提到 `if (opts.noDamage) return` **之前** —— 它的语义是"我附近炸了"，不是"我被裁决了伤害" | net-feel P1–P3 |
| 19 / 40（定向那半） | 空袭 / 白磷 / 直升机各补一条 `to:'foes'` 的来袭播报；哨戒机枪"无法在此部署"改 `to:'self'`。定向在**客户端**筛（服务端一份 Buffer 发全房） | net-feel J1–J6（每个 `to` 各配一条"不该念给我"臂） |
| 20 | 远端开火补齐曳光 + 枪声（按射速记账，防"一枪响十几声"）+ 25% 概率的动态点光；非消音开火置 `revealT`（小地图亮点） | net-feel C 段（反证臂按 144Hz 逐帧算一遍，会给 86 声而不是 8 声） |
| 21 | 脚步按**走过的距离**记账（1.6 / 2.0 m 步幅，不是按帧）；换弹按 `Reloading` 位的**两个跳变**各响一声 `out` / `in` | net-feel D / E 段（站着不动 0 声） |
| 22 / 23 | 去掉 `rotation.y` 的 `+Math.PI` 与 `pitch` 的负号（`swapWeapon` 那条路一起改） | net-feel A1–A4 |
| 24 | 相位在**编解码层**就折成角度（`Q.packPhase/unpackPhase`），插值按**角差**取短边；删掉 `spd < 0.3 ⇒ phase = 0` | net-feel B 段（含跨 2π 短边臂；"离两端点各 0.25"那种写法给不出恒 0 的假绿）、`server/codec.mjs` 自测 |
| 25 | 受击抖动改**模型**位置（不动 `pos`，否则会污染插值）；`takeDamage` 返回 `hp <= 0` ⇒ 本地预测也能打出红叉与击杀音 | net-feel F 段 |
| 26 | `anim.fallDir` 按受击方向与朝向的点积定号（以前恒 1） | net-feel F 段（要求两条样本一正一负） |
| 27 | `animateSoldier` 的**存活**分支补 `root.rotation.x/z` 复位（死亡分支写过、存活分支从没复位过） | net-feel G 段（旧写法会留 1.571 / 0.300） |
| 28 | 名牌只给队友（`me.team === this.team`），`setName` 会重算 | net-feel I1–I3（I2 是"队友必须还有"臂） |
| 30 | `beginLeave()` + 0.8 s 淡出，走完才 `dispose`；快照缺人与 `leave` 事件两条路都进同一个队列 | net-feel H 段、J14/J15、N3–N5 |
| 31 / 32 | `Game.onNetKill` / `onNetDeath`。killfeed 真的画出那一行；死亡画面显示、"被 X 使用 Y 击杀"、死亡镜头按**名字**去远端表里找击杀者 | net-feel Q1–Q3 + **net-play 的面板判据三条**。反证臂已实跑：`git show HEAD:js/main.js > js/main.js` 后这三条全红（killfeed 0 行、killerInfo 空、死亡画面 false） |
| 33 | `hurt` 事件（服务端限流）→ `Game.onNetHurt`：方向指示 + 痛感音 + `pl.punch`，只做表现、绝不写 hp | net-feel J7/J8 |
| 34 | welcome 带 `respawnDelay`（服务端说，客户端不自己写常数）；客户端画倒计时、到点发 `{t:'respawn'}`；`NetRoom.requestRespawn` 自带闸门（`respawnT > 0.12` 才放行） | net-feel K1–K4（含"闸门在服务端、不许靠客户端自觉"） |
| 37 | `update()` 里 1 Hz `sendPing`（以前 `sendPing` 定义了但**从无调用点** ⇒ rtt 恒 0）；记分板脚注 `ping … ms · 快照 … 份` | net-feel R1–R3（R2 是"不是每拍都发"臂） |
| 38 | `pauseActions({camp, online})` 纯函数：联机隐藏"重新开始对局"（那一项会 `ws.close()` 静默断开并开一局带 AI 的对战）、加"退出本局"、标题不再自称"已暂停" | net-feel S1–S5（S5 是"单机那份一个字没变"臂） |
| 39 | 记分板补名次列、助攻列、死亡灰行；A/B 比分按**自己队**算 | net-feel 记分板段 |
| 42 | `setThermal` 改成遍历 `game.entities`（远端副本就在那张表里）；远端开火置 `revealT = 1.5` | net-feel N1（副本进表那条）+ `js/net/remote.mjs:revealT` 的写入点 |
| 44 | `isImeKey(e)`（`isComposing` **或** `keyCode === 229`）用在密码框与聊天框；抽成纯函数就是为了它能被判据走一遍（两处都在 DOM 回调里） | net-feel T1–T5（T3/T4 是"真回车必须放行"臂） |

### 仍未收（下一轮）

内容与规则那一层基本没动：`1`（模式只剩 tdm）、`4`（连杀奖励不能自选）、`6`+`41`（不能捡枪 / `#markers` 在联机路径下永远为空）、`7`（Perk 有效项少）、`9`（访客 0 xp）、`10`（没有结算页）、`11`（集束空袭不能选点、按下即消耗）、`29`（套件与迷彩不体现，协议里没有这两个字段）、`40`（连杀槽进度仍 0.5 Hz —— 定向那半已收）、`43`（对局中无聊天）、`45`（无屏蔽/静音/举报）。

两条**不是本轮能收的**、也不该当 bug 修：

- `35`（客户端本地命中打的是插值位置）：服务端按客户端上报的 `view` 拍回溯，**两者时刻是一致的**，剩下的差只有"插值出的位置 vs 逐拍姿态"那一格。要再压下去得让客户端也留一份逐拍姿态环，收益是厘米级。
- `36`（敌人显示在过去）：插值的固有代价，`INTERP_DELAY` 就是它的价码。

`18`（哨戒机枪 / 直升机是哑副本）、`3`（房间不自动放 AI）、`2`（直连落新建房时地图写死）仍按原样保留 —— 前两条是有意的简化，第三条属于部署配置。
