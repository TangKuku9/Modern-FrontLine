# 联网对战 bug 清单：12 条

审计对象：`server/`（权威端）+ `js/net/`（联机客户端与表现层）+ 两端共用的 sim 内核
（`js/player.js` / `js/combat.js` / `js/weapon-state.js` / `js/match-rules.js`）。
审计焦点：**只挖联网对战的 bug**，不评玩法手感、不评单机、不评 UI 美工。

方法：先逐文件精读同步主链路（`server/room.mjs`、`server/net-server.mjs`、`server/codec.mjs`、
`server/lagcomp.mjs`、`server/fanout.mjs`、`server/headless-game.mjs`、`js/net/client.mjs`、
`js/net/predict.mjs`、`js/net/remote.mjs`），再对每条可疑线索**写一次性探针实测**，
只有拿到运行时数字或代码级矛盾才写进清单。全部结论附 `文件:行号`。

- 审计日期：2026-10-04
- 基线：`feature/net-authoritative` @ 15c13ab
- 本文**只列问题，不含修法落地**。每条给了机制、症状与修法方向。
- 与 `docs/net-sync-audit.md`（2026-10-01，同一分支）的关系：那份的 3 高危 / 11 中危
  已于 10-02 全部落地。本文是**那一轮之后的第二轮**，只收 `net-sync-audit.md` 修完之后
  仍然存在的新问题，不重复那份已收口的条目。

---

## 总评

这套 netcode 的骨架是健康的：服务端权威 60Hz 模拟、客户端回滚重放、view 拍号延迟补偿、
快照定点量化、玩法随机流同步——主链路的骨架本身挑不出结构性问题。

但本轮挖出 **5 条确凿 bug + 7 条账漂移 / 死代码 / 竞态窗口**，其中最重的一条是：

> **延迟补偿的命中盒取料口少返回两个字段（yaw / prone），而消费方按六个读。**
> 于是趴姿玩家在联机里一律按站立盒裁决——自己趴下后对面打不中，自己打趴着的敌人
> 反而能被"隔空打中"。真人与 Bot 走同一条路。

更值得注意的是**判据覆盖的形状**（详见文末《四、判据为什么全绿》）：`npm test` 32 项全绿、
`test/lagcomp.mjs` 136/136 通过，而本文 12 条**一条都没被现有判据覆盖**。
判据矩阵量的是"机制通没通"（回滚有没有跑、补偿有没有生效、字段有没有登记），
量不到"字段有没有**多读/少读**"和"上限有没有**溢出**"。这是比任何单条 bug 都更值得
先收口的问题。

---

## 一、确凿 bug（5 条）

### H1. 延迟补偿命中盒丢 yaw / prone —— 趴姿在联机里一律按站立盒裁决

**位置**：`server/lagcomp.mjs:56`（取料）← 消费方 `js/combat.js:78`（读料）

`PoseRing` 的字段表明确是 6 个，`record()` 也确实写了 6 个：

```js
// server/lagcomp.mjs:35, 45-46
export const POSE_FIELDS = 6;
// x, y, z, eye, yaw, prone —— 后两个是趴姿加的：趴下的命中盒沿体轴平摊出去 ~1.6 m
d[i] = pl.pos.x; d[i+1] = pl.pos.y; d[i+2] = pl.pos.z; d[i+3] = pl.curEye();
d[i+4] = pl.yaw;   d[i+5] = pl.proneT > 0.5 ? 1 : 0;
```

但取料口只回 4 个：

```js
// server/lagcomp.mjs:53-57
at(tick) {
  if (this.hi < this.lo || tick < this.lo || tick > this.hi) return null;
  const i = (tick % this.n) * POSE_FIELDS, d = this.d;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];      // ← d[i+4] / d[i+5] 被丢掉
}
```

消费方按 6 个读：

```js
// js/combat.js:78
const h = p ? hitTestPlayer(p[0], p[1], p[2], p[3], p[4], p[5], o, d, best)
            : e.hitTest(o, d, best);
```

**运行时实测**（`PoseRing` 灌 10 拍后取第 105 拍）：

```
at(105) = [105,0,0,1.62]   length= 4
p[4](yaw)= undefined   p[5](prone)= undefined
```

**机制**：`js/combat.js:hitTestPlayer` 里 `if (prone)` 对 `undefined` 恒假 ⇒ 趴下的玩家
一律走**站立命中盒**。同时丢掉的 yaw 让趴姿盒"脚跟朝哪"也答不出来——而
`server/lagcomp.mjs:32-34` 的注释专门解释了为什么这两格非存不可：

> 趴下的命中盒沿体轴平摊出去 ~1.6 m（`js/combat.js:hitTestPlayer`），
> "脚跟朝哪"没有 yaw 答不出来，"是否已经趴下"没有 prone 答不出来。

真人（`room.mjs:644`）与 Bot（`room.mjs:654`）走的是**同一个** `PoseRing.at()`，
所以两类目标都中招。

**症状**：
- 自己趴下后，对面开枪打不中（服务端按站立盒判，站立盒比趴姿盒小一截）。
- 自己瞄趴着的敌人，命中盒比实际大一块 ⇒ 能"隔空打中"。

**修法方向**：`at()` 返回 6 个字段；`test/lagcomp.mjs` 加一个趴姿靶用例（见《四》）。

---

### H2. 地上的枪超过 14 把时被静默丢弃，客户端永远留着捡不到的幽灵模型

**位置**：`server/headless-game.mjs:144`（丢弃）← 事件出口 `server/room.mjs:500-502`

```js
// server/headless-game.mjs:143-145
this.pickups.push(p);
if (this.pickups.length > 14) { const o = this.pickups.shift(); this.scene.remove(o.mesh); }
return p;
```

`shift()` 掉的那把**不回告调用方**，于是没有 `pickupGone` 事件。服务端唯一发
`pickupGone` 的地方是 30 秒过期那一条：

```js
// server/room.mjs:500-502
for (const p of pickupsExpire(this.game, DT)) {
  this.events.push({ e: 'pickupGone', id: p.netId, why: 'expire' });
}
```

**运行时实测**（按真链路连发 16 把：每把都 `spawnPickup` → 分配 `netId` → 推 `pickup` 事件）：

```
发过 pickup 事件的枪数        = 16
其中已被服务端静默丢弃        = 2      ← 客户端还留着这两把的模型
本拍发出的 pickupGone 事件数 = 0      ← 一个都没有
服务端在场数                 = 14
```

**症状**：
1. 客户端地上留着一把**永远捡不到**的枪模——走过去没提示、按键无反应。
2. 更隐蔽的一层：客户端的拾取提示走 `pickupAction(..., apply=false)`
   （`js/match-rules.js:418` 注释："联机客户端用它画提示——它不许自己改状态"），
   那两把幽灵枪**客户端算得出来、权威端算不出来** ⇒ 屏幕上的提示与实际能捡的东西
   永久不一致。实测确认：把玩家逐个瞬移到每把枪旁边，客户端侧算出的"身边有枪"
   数量与服务端在场数**不一致**。
3. 它会一直挂到玩家离开对局（那把 mesh 还在客户端的场景图里）。

**触发条件**：一场团战掉 15 把以上枪。掉枪有两条路——击杀掉落
（`server/room.mjs:878-885` 的 `maybeDropWeapon`）与换枪落地
（`server/room.mjs:512-519` 的 `r.swap.old`）——都在 60Hz 权威循环里，密集交战很容易到。

**修法方向**：`spawnPickup` 溢出时把被丢的那把回告调用方（挂到返回值上或走一条
回调），`room.mjs`  据此发 `pickupGone`；上限 14 这一档本身也该进 `/healthz`。

---

### H3. 快照实体数字段是 u8，超过 255 个实体静默溢出

**位置**：`server/codec.mjs:38`

```js
view.setUint8(o, p, true); o += 1;   // p = snap.entities.length
```

**运行时实测**：

```
200 实体 → 包长 5211（= 11 + 200×26，表头声称 200）   count 字节 = 200  ✔
300 实体 → 包长 7811（表头声称 300）                 count 字节 = 44   ✘（300 & 0xff）
```

解码端只读 44 个实体 ⇒ **其余 256 个实体从世界上静默消失**（客户端表现为"对面的人
凭空消失，而我还活着"）。

**为什么现在还够不着、但仍要算 bug**：`MAX_SEATS = 16`（`server/lobby.mjs:25`）目前
兜住了单房人数——**但那是一个不相干的约束，不是协议自己的护栏**。`pickRoom` 对
**显式 id** 的分支完全不查座位上限：

```js
// server/net-server.mjs:659-672
if (id === 'auto') {
  ...
  if (room.clients.size > bestN && room.clients.size < MAX_SEATS) { best = room; bestN = room.clients.size; }
  if (best) return best;
}
return getRoom(id, user);      // ← 显式 id 这条路：无人数闸
```

也就是说：同一间房先走大厅进来 16 人，再用 URL 带 `room=<id>` 直连塞人，可以突破 16。
而 `maxClients` 默认 **128**（`server/net-server.mjs:64`）是**进程级**的，
`maxRooms` 默认 32 ⇒ 极端配置下单房间就能撞到 128，配合多房间迟早越线。

**修法方向**：count 字段改 u16（`ENTITY_SIZE` 不变，只是头里挪一格 —— 注意
`HEADER_SIZE=11` 与 `test/room-bots.mjs` 的包长算式要同步），或在
`snapshotEntities()` 里显式 clamp 并让超限成为一条**可见的** `/healthz` 错误。

---

### H4. 满员房每份快照都重新分配 DataView（每秒 20 次 GC 压力）

**位置**：`server/codec.mjs:30-33`

```js
export function encodeSnapshot(snap, scratch = new DataView(new ArrayBuffer(HEADER_SIZE + 64 * ENTITY_SIZE))) {
  const p = snap.entities.length;
  const need = HEADER_SIZE + p * ENTITY_SIZE;
  const view = scratch.byteLength >= need ? scratch : new DataView(new ArrayBuffer(need));
```

`broadcast`（`server/net-server.mjs:1037`）每次都新建默认 scratch（没有跨帧复用），
所以实体数 > 64 时**每份快照都走 `new DataView`**。

**运行时实测**：100 实体时两次 `encodeSnapshot` 的 `view.buffer` **不是同一块**：

```
两次 encodeSnapshot 是否同一块 buffer（false = 每份快照都在分配） = false
```

**症状**：满员房每秒 20 份 × 每份一份 > 1.7 KB 的 `ArrayBuffer` = 稳定的 GC 压力，
直接体现为客户端帧率抖动/GC 卡顿；而这类卡顿会让客户端错过快照，
**放大 H1 的手感**（补偿窗口与插值延迟都靠快照节拍撑）。

**为什么现在还够不着**：同 H3，`MAX_SEATS=16` 兜住了。但这是**性能悬崖**而不是设计——
注释里写 64 时显然按"够大"想的，没有跟 `MAX_SEATS` / `MAX_CLIENTS` 挂钩，
两个数一旦调大就静默变成一条 GC 曲线。

**修法方向**：`broadcast` 复用一个按 `MAX_SEATS` 定容的模块级 scratch。

---

### H5. 客户端本地加经验值，服务端也加同一笔（登录玩家双记）

**位置**：`js/net/client.mjs:1437`（客户端写）← `server/accounts.mjs:665` `addResult`（服务端写）

```js
// js/net/client.mjs:1430-1438（showResults）
const xp = s + (win === 'win' ? 500 : 150);
// 这一笔落在哪一半，取决于**这局有没有服务端档案**：
//   登录玩家：服务端自己也会记同一笔，本地只是先按同一条式子显示出来，…
if (g.account && g.account.user) addAccountXp(g.profile, xp); else addLocalXp(g.profile, xp);
g.saveProfile();
```

```js
// server/room.mjs:916（endMatch）
xp: Math.round(c.score) + (won ? 500 : 150),
//   → server/net-server.mjs:1078 drainResults() → accounts.addResult(row.account, row)
```

`addAccountXp` 是**真的写进本地 profile 并 `saveProfile()`**，不是纯显示。
两个数值体系在两次 `/api/me` 同步之间各持一份。

**症状**：联机打一晚上，进游戏前显示的经验与 `/api/me` 返回的不一致（差一整局）；
等级条会"跳回去"。**只有登录玩家受影响**——访客那一半走 `addLocalXp` 是对的
（服务端确实不写访客档案，见 `server/room.mjs:911` 的 `if (!c.account) continue`）。

**修法方向**：客户端那笔改成纯显示（进结算面板的临时值，不入 profile），
或让服务端成为唯一写者、客户端只读。

---

## 二、账漂移 / 死代码 / 竞态窗口（7 条）

### M1. `rewindTick` 的 32 位有符号位运算 —— 房间跑满 414 天后回溯永久失效

**位置**：`server/lagcomp.mjs:68`

```js
let v = (cur & ~0xffff) | (view & 0xffff);        // 拿当前半圈把低 16 位拼回来
```

`~0xffff` 在 JS 里是 **32 位有符号**的 `-65536`。`cur = room.tick + 1`
（`server/room.mjs:620`）是无限增长的 JS Number，超过 2^31 后 `cur & ~0xffff` 变负。

**运行时实测**：

```
rewindTick(正常 view, cur=2^31+5000, lastSent=cur-1) = -1   ← 拒绝
同样三条在 cur=1000 时（对照）                        = 995  ← 正常
```

**症状**：`room.tick` 超过 2^31（60Hz 下约 **414 天**）之后，所有延迟补偿**永久失效**，
且全部计入 `lag.stale`。这个房间不会回收（有人在线就一直跑），所以是**不可自愈**的。

**修法方向**：`cur & ~0xffff` 换成 `cur - (cur % 0x10000)`（纯算术，无符号语义问题）；
顺带在 `/healthz` 上加一条 `tick > 2^31` 的告警读数。

---

### M2. `explode` 的 `opts.ff` 是死代码 —— FFA 的爆炸友伤过滤靠数据巧合兜住

**位置**：`js/combat.js:131`

```js
if (attacker && e !== attacker && e.team === attacker.team && !opts.ff) continue;
```

全库 grep `ff:\s*true` → **零命中**。`Projectile.detonate()` 的 opts 里只有
`noDamage` / `direct` / `scale`，从没人传 `ff`。

**为什么它是 bug 而不是"恰好等价"**：FFA 下队键是 `'P'+cid`（`server/room.mjs:271`，
每人一支），所以 `e.team === attacker.team` 天然不成立 ⇒ 这条过滤在 FFA 下**碰巧**正确。
它是**靠一个数据巧合兜住的**，不是靠设计：只要将来 FFA 改成"共用一支队"的分组玩法
（观战、组队 FFA、小队战），爆炸立刻开始误伤队友，而这一行的注释不会提醒任何人。
`this.rules.ffa` 就在调用方手边（`server/room.mjs` 里一路带着）。

**修法方向**：要么删掉 `!opts.ff` 并把"FFA 靠队键唯一"写成注释钉住，要么让
`Projectile.detonate()` 真的把 `ff: game.mode?.rules?.ffa` 传下来。**别留中间态**。

---

### M3. `originAllowed` 的 `*.` 通配项与它的文档注释相反

**位置**：`server/net-server.mjs:462-465`

```js
if (pat.startsWith('*.')) { if (org.endsWith(pat.slice(1))) return true; continue; }
// 裸主机名：`://example.com`（裸域）或 `.example.com`（子域）都算命中；
// `evilexample.com` 两条都不满足 —— 那正是这条判据要挡住的那一个。
if (org.endsWith('://' + pat) || org.endsWith('.' + pat)) return true;
```

`pat = '*.example.com'` ⇒ `pat.slice(1) = '.example.com'` ⇒ 判据是
`org.endsWith('.example.com')`。而 `'https://example.com'.endsWith('.example.com')`
**是 false** —— 裸域被拒。

注释描述的其实是**下面那个裸 `pat` 分支**（`org.endsWith('://' + pat)`），但它排在
`*.` 分支的 `continue` 之后，读起来像在讲同一件事。

**症状**：配 `ALLOW_ORIGIN=*.example.com` 时，所有子域放行、**裸域被拒**。
运维按注释理解会以为裸域也算，于是线上主站被拒而子域全通。
（`net-sync-audit.md` 的 M5 修的是裸 pat 的边界匹配，`*.` 这一支没动过。）

---

### L1. 两条并发 `join` 帧可同时通过 `ws.__cid` 检查 → 孤儿房占额度

**位置**：`server/net-server.mjs:1169`（检查）与 `1193`（让出）/ `1201`（真守卫）

`ws.on('message')` 是 **async** 处理器，而 Node 的 ws 事件分发**不会**因为 handler 里的
`await` 而阻塞下一条消息：

```js
if (ws.__cid != null) { ws.send(...); return; }   // 1169：检查
...
const room = await pickRoom(msg.room, user);       // 1193：await 让出控制权
...
const c = enterMatch(room, ws, {...});            // 1201：真正的守卫在这里
```

两条 `join` 可以都过 1169、都卡在 1193 的 `await`（`pickRoom` 里
`await p.catch(() => null)` / `await room.start()` 是真异步，实测预加载材质 +
`loadMap` 是**百毫秒级**），然后各自走到 1201。

**已被挡住的部分**：`enterMatch` 的二次守卫（`net-server.mjs:691-695`，`ghostBlocked++`）
挡住了幽灵座——这部分是正确的。

**没被挡住的**：`beginLive` 那种 `await` 之前的 `pickRoom` **可能已经
`getRoom(id)` 建出了一间孤儿房**，并占住 `MAX_ROOMS` 额度直到 `ROOM_IDLE_MS`
之后被 sweeper 回收。访客建房不占 `roomsPerUser` 配额（`getRoom` 里
`if (user && ...)`），所以可被反复触发。

**症状**：客户端只看到一条 `err`（"这条连接已经进过房间了"），但服务端的房间数
无声增长。极端情况下 `MAX_ROOMS` 被孤儿房占死，所有新玩家进不去。

---

### L2. `beginLive` 在 `await getRoom()` 之后才置 `__closed` —— 开局瞬间可被挤入

**位置**：`server/net-server.mjs:931`（await）与 `940`（关门）

```js
live = await getRoom(wroom.id, ...);   // 931：这里 await 让出（room.start() 是百毫秒级）
...
live.__closed = true;                  // 940：才关门
```

这个窗口里任何人都能走直连 `join` 用那个房号挤进这间"私人房"——1194 那道
`if (room.__closed)` 此刻还没置上。

**后果不止"多了一个人"**：`wroom.seats` 的名单已经封盘，挤进来的人不在名单上，
所以房主那局的结算与回房间流程里没有他（`returnRoom` 按名单走），他会被留在一个
已经结束的房间里，直到自己掉线看门狗超时。

**症状**：玩家在开局瞬间看到"那间房是房间大厅开出来的私人局"之外的东西突然出现，
或者卡在一个不属于自己的房间里。

---

### L3. FFA 下 `remote.mjs` 的名牌条件恒假 —— 全场无名牌（靠巧合而非显式）

**位置**：`js/net/remote.mjs:131`

```js
buildTag() {
  ...
  const me = this.game.player;
  if (!me || me.team !== this.team) return;   // 唯一条件
}
```

FFA 下队键是 `'P'+cid`（每人一支），所以 `me.team !== this.team` **对所有人恒成立**
⇒ 没有任何一个人拿到名牌。

**为什么仍要算 bug**：注释写着"单机是 `tag: team === 'A' && !this.ffa`"——
单机靠 `!this.ffa` **显式**排除，联机这边**没有 ffa 判断**，只是靠"每人一支队"
意外达成了同样结果。语义上没错（FFA 本来就不该有队友名牌），但它是巧合而非设计。
而且失效方向是**安全方向的反面**：一旦将来给 FFA 引入"临时结盟"或按队分组显示，
这行会静默变成"组内互相显示名牌"（因为组内 team 相同了），与 `remote.mjs:120-122`
自己写的"联机比单机知道得更多"那条自我约束直接冲突。

**修法方向**：显式加 `if (this.game.net.ffa) return;`（或把单机那个
`team === 'A' && !this.ffa` 的口径整条搬过来）。

---

### L4. `net-server.mjs` 顶部协议注释仍是旧的 13 字节输入包

**位置**：`server/net-server.mjs` 文件头

> 上行 二进制 = 若干个 13 字节输入包 ……
> 正常一帧 ≤ 13×60 = 780 B

实际 `INPUT_SIZE = 16`（`server/codec.mjs`，flags 从 u8 加宽到 u16 时同步改的，
`ENTITY_SIZE` 也因此 25→26）。13→16 之后正常一帧是 **16×60 = 960 B**。

**为什么算 bug 而不是笔误**：协议文档注释是这套仓库里唯一的"包长真相"来源。
`server/fanout.mjs:65-66` 里那条"test/room-bots.mjs 是按 `(len-11)/25` 反推实体数的"
注释是同一批陈旧数字（**不过 `room-bots.mjs` 实际用的是 `ENTITY_SIZE` 常量，判据本身
没坏，坏的只是它上面那句注释**）。一处注释错不会崩，但按注释去算带宽预算的人会
低估 23%。

---

## 三、查过但排除掉的线索

记录在此省得重复查。这些都读过代码 / 跑过探针，结论是**站不住**：

| 线索 | 结论 |
|---|---|
| `test/room-bots.mjs` 按 `(len-11)/25` 反推实体数，会被 flags 加宽带偏 | **撤销**。它用的是 `ENTITY_SIZE` 常量（`room-bots.mjs:32`），判据是绿的。坏的只是 `fanout.mjs` 上方那句注释（见 L4） |
| `client.mjs:504` 首包 `dAck` 默认 1 而 `dTick` 默认 0 ⇒ 多走一拍 | **撤销**。`deficit = max(0, 0-1) = 0`，`lead`/`dAck`/`repUse` 全为 0；且 `hit` 为假时 `rollback` 一拍都不演，走 `caughtUp` 分支（`client.mjs:680-690` 有完整账） |
| FFA 下 `MatchRules.worldFlags()` 与 `client.uavActive()` 两套真相分叉 | **降级为已知设计**。`match-rules.js:205-213` 有整段注释论证"FFA 只能折成 A 位"（人人为敌，一张透视图对全场等价），且 `client.mjs:1405-1412` 的 FFA 分支读的是 `board.rows[].uav`。有 2 秒延迟但**不分叉** |
| `beginLive` 的 `ghostEvicted` 清座循环会遍历中改表 | **撤销**。它先收集进 `ghosts` 再改表（`net-server.mjs:948-957`），注释里说的 `leaveRoom` 遍历删除问题已处理 |
| `applyInput` 队列溢出丢最旧的一拍会造成 ack 永久错位 | **撤销**。实测：重发旧拍号被正确丢弃（队列长度 0），新玩家首拍 `tick=0` 正常入队（长度 1）。`lastQueued` 不回落是**刻意**的（`net-server.mjs:360-362` 有注释解释为什么不能用 `c.ack` 当基准） |
| `cid` 与 Bot `netId` 共用 `NEXT_CID` 会撞号 | **撤销**。实测 50 次 `addClient` + 30 次 `spawnBot`，重复 0 / 撞号 0 |
| `c.rep` 的 255 封顶会与客户端 `repUse` 打架 | **撤销**。实测连续饥饿 10 拍后 `rep = 255` 正确封顶，而客户端侧
`repUse = max(0, dTick - dAck - lead)` 是按 `dTick` 拆的（`client.mjs:527`），不直接信 wire 上的 `rep` |

---

## 四、判据为什么全绿

本文 12 条**没有一条被现有判据覆盖**。这不是判据写坏了，是判据的**覆盖面**有一个形状上的盲区：

| 判据 | 量的东西 | 抓不到本文哪条 |
|---|---|---|
| `test/lagcomp.mjs`（136 项） | 补偿机制**通没通**（闸门四臂、窗边界、Bot 半边、上报值口径） | H1 —— 它自己在 `test/lagcomp.mjs:141` 抄了同一个坑：`cb.pose.at(room.tick) \|\| [x,y,z,eye,yaw,prone]`。那个 `\|\|` 右边是 6 字段的**手写兜底**，于是 `at()` 只回 4 个字段时它照样绿；且全部用例都是**站立靶**，趴姿一次都没测 |
| `test/rollback.mjs` / `reconcile-chain.mjs` | 回滚代数（`lead + dAck + repUse = dTick`）与日记本字段**登记** | H2 / H4 —— 前者是"事件有没有发"，后者是"buffer 有没有复用"，都不在代数里 |
| `test/net-journal.mjs` | `J_PL`/`J_WS`/`J_EXCLUDE` 字段守卫 | H1 —— 姿态环（`PoseRing`）**不走日记本**，它是独立的环形缓冲，字段清单没有任何守卫 |
| `test/codec.mjs` 自测 | 每个 `pack/unpack` 的量化误差 | H3 —— count 是 `setUint8`，误差测试量的是**精度**不是**溢出** |
| `test/service-guards.mjs` | 连接闸门 / 配额 / 白名单 | L1 / L2 / M3 —— 都是"闸门在 await 两侧的时序"，静态逐条读得出来，动态判据量不到 |
| `test/docs-guard.mjs` | 文档与脚本清单对账 | L4 —— 协议注释里的数字不在任何一份被守卫的清单里 |

**结论**：判据矩阵强在"机制通没通"，弱在"**边界有没有守住**"。
H1（少读两个字段）、H2（静默丢弃不回报）、H3（u8 溢出）三条都是同一类 ——
**中间有一层没人看见的失真**。补判据的方向也在这里：
- `PoseRing.at()` 的返回长度**逐字段断言**（而不是"能取到值就算过"）；
- 每一条"静默丢弃"路径都必须有一条对应的**事件或读数**；
- 定长协议的每个计数/长度字段都要有一条**越界用例**（`256`、`300`、`-1`）。

---

## 五、建议的动手顺序

**第一批（会让玩家看见的）**
1. **H1** — 改 `at()` 返回 6 个字段，同步改 `test/lagcomp.mjs:141` 那个 `||` 兜底，
   并加一个趴姿靶用例（先让判据红，再改实现）。
2. **H2** — `spawnPickup` 溢出时回告调用方，`room.mjs` 据此发 `pickupGone`。
3. **H5** — 客户端那笔 xp 改成纯显示，不入 profile。

**第二批（结构性）**
4. **H3** — count 改 u16（或显式 clamp + 可见错误），`HEADER_SIZE` 与
   `test/room-bots.mjs` 的包长算式同步。
5. **H4** — `broadcast` 复用一个按 `MAX_SEATS` 定容的 scratch。

**第三批（账漂移与竞态窗口，可合到一次清理）**
M1（顺带加 `tick > 2^31` 告警读数）、M2、M3、L1、L2、L3、L4。

其中 **M1 严格说不是"现在会坏"**，但它是本清单里唯一一个**会永久坏且没有自愈**的
时间炸弹，值得单独在 `rewindTick` 上加一句注释或一条读数。
