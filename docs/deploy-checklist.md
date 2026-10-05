# 上真机：一条一条对着做的清单

这份清单回答的是一个问题：**"这台服务器上现在跑着的那一份，到底能不能让人进来玩？"**
每一条都写成「命令 → 期望 → 红了怎么看」。红了照着最后一列走，不用回头读源码。

它的边界写在最前面，因为**一份替真机背书的假绿灯比没有这份清单更糟**：

- **本机没有 docker。** `docker build` / `docker run` / `docker stop` 那三步在本机**没有跑过**，
  所以它们在这里是**待做项**，不是"已验证的读数"。第 4 步整节都是这个状态。
- 本机能验、而且**已经验过**的：进程级的东西（配置闸的退出码、优雅下线的退出码、
  开发模式仍发源码）、以及"对着一台**已经在跑**的实例从外面看"的那些（第 2、3 步）。
- 两份探针的分工是**能力边界**，不是新老两版：
  | | 起进程吗 | 能验什么 |
  |---|---|---|
  | `server/deploy-probe.mjs` | 会（自己 spawn） | 退出码、优雅下线的 1001、dev 模式仍发 `server/` 源码、空房回收的日志行 |
  | `server/remote-probe.mjs` | 不会 | **部署面留在公网上的形状**：生产白名单、来源检查、邀请码闸、一个人能不能真的打起来 |
  远程判不了的，`remote-probe` 一律印 `⚠ 未测` 并写清用什么补，**不折算成绿**。

---

## 0. 先把自己关在门外看一遍（改代码之后必跑）

```bash
npm test          # 主体档：gate / docs-guard / rollback / reconcile-chain / world-equiv / worker-core / preload-graph / net-journal / codec / lagcomp / mp-rules / accounts / progress / hardening / service-guards / room-flow / room-bots / room-dir / image / net-probe / deploy-probe / xenv / fps / viewmodel / gunvisual / net-feel / net-audit / heli-armor / optic / state-leak
                  # 其中要一个真浏览器的那几份，名单见 README《验收》（从源码推的，别在这儿抄第二份）
npm run test:all  # 再加四个真浏览器测试（net-play 对打、net-drop 掉线、tab-session 同源双标签页、worker-live 离线实跑 Worker 双路）
```

期望：两条都 `EXIT=0`，末行是 `GREEN n/n`。

红了怎么看：**看退出码和 `RED n/m` 那一行**，不要 grep 正文里的关键词 ——
这个仓库里有判据的文案和被测行为是分开的，grep 正文会把"反证臂印出来的偏差量"当成失败。
某一条具体红了，README 的《验收》一节逐条写了它守的是什么、以及历轮它抓到过什么。

---

## 1. 起一台**生产模式**的实例（本机也可以）

```bash
NODE_ENV=production \
JOIN_CODE=<只有你知道的码> \
ACCOUNTS_DB=/tmp/acc.db \
ALLOW_ORIGIN=http://127.0.0.1:8123 \
COOKIE_SECURE=0 \
HOST=127.0.0.1 \
  node server/net-server.mjs 8123
```

期望（启动日志里应当逐条出现）：

- `生产模式`（不是 `开发模式`）
- 邀请码那一行写着**值来自环境变量**，不是"在用源码里的默认值"
- `/healthz` 的 `auth.store` 是 `SqliteStore`（不是 `MemoryStore`）
- `/healthz` 的 `auth.inviteRequired` 是 `true`
- `启动完成` 那一行（哨兵：它之后不再有启动日志，所以"日志到这儿就是全部配置了"）
- 忘了设 `ALLOW_ORIGIN` 时，这里会多一块 `⚠ 生产模式未设 ALLOW_ORIGIN`。**它不掐服务**
  （确实有不需要来源检查的部署），但那块警告说的是真话：不检查来源 = 任何网站都能借访客的
  浏览器连上这台机。判据在 `test/hardening.mjs` 的 H7（未设要打）/ H8（设了不许打）。

### 多实例：口径只有一句

**一个进程 = 一个权威端 = 最多 `MAX_ROOMS` 间对局（等待态另给 2× 额度）+ `MAX_CLIENTS` 条连接。**
所以 README《带宽与容量》那张表是**每进程**的数（16 → 256 人都在一台里压出来的），
不是集群的数。sim 永远只在它出生的那个进程里跑 —— 目录只搬"哪台有什么房"这张名单，不搬运行状态。

现在能起的多实例形状是"**一个大厅、多台执行**"（2026-10-01 起）：多台共用一个 `ROOMS_DB`
目录文件，每台把自己的房间行自报进去（心跳 + TTL，一台崩了它的行在 TTL 内自然消失）；
任何一台上打开的大厅都列全部台的房（带"另一台"标记与那台的地址），点击就跨台加入；
要账号的部署凭**一次性入场票**跨台（玩家登录的那台发票、目标台握手时消费 —— 账号账本仍各台私有）。
残余风险（有意不改，记档于 `docs/net-sync-audit.md`）：这张票走 ws 握手 URL 的 `?ticket=` query —— 跨台握手没有别的可信可用通道，代价是必然落反向代理 access log 与浏览器历史，泄露面比 HttpOnly cookie 大一截（反代侧可把 access log 的 query 脱敏收窄这块面）。

```bash
ROOMS_DB=/data/rooms.db PUBLIC_URL=http://游戏域:8091 MAP=yard  SEED=20260925 … node server/net-server.mjs 8091
ROOMS_DB=/data/rooms.db PUBLIC_URL=http://游戏域:8092 MAP=depot SEED=7         … node server/net-server.mjs 8092
# ALLOW_ORIGIN 要把所有实例的页面来源都列上（跨台握手时 Origin 是玩家所在那台的）
```

自检三件事：`/healthz` 的 `roomDir` 格（开着没开、对外 url 对不对 —— 地址错了的症状是
"列表里有别台的房、点进去连不上"）；`node test/room-dir.mjs`（三层判据：单元 / 访客双机 /
账号票，含"不开 `ROOMS_DB` 行为不变"的反证臂）。`?room=` 深链的语义不变：它指向的地址就是它要连的那台。

两件要分清的话。**多台进程共用同一个 `ACCOUNTS_DB` 文件**有探针（2026-10-01）：
`node server/multi-account-probe.mjs` 起两台服务共一个库文件，五个场景、退出码判"实测与账一致" ——
活进程账本互不可见（P1 注册的人 P2 重启前登录 401）、同名并发注册与两张码两台并发重设都是
"两边都成功"、重启后那格绿。成因是 `SqliteStore` 的**账本进程私有**（开库载入一次 + 读全走内存 +
写攒批刷盘），读数与成因见 `docs/net-vs-local-gaps.md` 附十五；进程内的并发双花已修
（`test/accounts.mjs` 的 L 段）。红的那几格是**立了账的已知缺口**，不是已验过 —— 跨台的房间目录
不碰它：跨台加入的身份是**票**桥过去的，账号本身仍各台一本账。

红了怎么看：

| 症状 | 成因 | 怎么办 |
|---|---|---|
| 打印两条出路之后**退出码 1** | 配置闸拦住了：没设 `JOIN_CODE`，或要账号却没设 `ACCOUNTS_DB` | 这是**设计行为**。缺哪项日志会点名；见 README《生产模式的配置闸》 |
| `MemoryStore` | `ACCOUNTS_DB` 没设或为空 | 生产上这意味着**进程一重启所有人的账号一起消失**。要么设路径，要么显式 `REQUIRE_ACCOUNT=0` 认下这件事 |
| 日志说"在用源码里的默认邀请码" | `JOIN_CODE` 没进环境 | 源码里那个码是公开的 —— 门是开的，而日志会告诉你 |

> `COOKIE_SECURE=0` 只在**明文 HTTP** 下是对的。前置了 HTTPS 却设 0，cookie 会在 http 上被发出去；
> 反过来，明文部署用默认的 1，浏览器会**静默丢掉**这个 cookie，症状是"登录成功但一刷新又没登"。

---

## 2. 从外面看这台机（`remote-probe`）

只读跑法（一个字节都不写）：

```bash
node server/remote-probe.mjs --url=http://127.0.0.1:8123
```

要连"注册 → 带会话进对局"一起验（**这是探针唯一会改目标机的东西**，它会明说建了谁）：

```bash
node server/remote-probe.mjs --url=http://127.0.0.1:8123 \
  --invite=<邀请码> --register --name=探针甲
```

期望：`GREEN n/n 通过 · k 项未测`，退出码 0。**未测那几项不是失败**，它们本机做不了（见第 4 步）。

本机已验读数（2026-09-26 第二次，对 `127.0.0.1:8125` 那个生产模式实例；探针现在 34 项 ——
新增"来源检查自报与实测一致""生产模式必须开来源检查"两条，见下面红了怎么看的表）：

```
GREEN  34/34 通过 · 4 项未测（未测不计入通过，退出码里也不折算）
```

红了怎么看：

| 症状 | 成因 | 怎么办 |
|---|---|---|
| `/server/net-server.mjs` 能取到（200） | 那台是**开发模式** | 生产模式才有白名单。开发机这样是预期的 —— 但公网上等于把权威端源码发出去 |
| `反证：js/main.js 是 200` 红了 | 整台服都在 404 | **下面那些"取不到"的绿全是假的**。先修静态服务，再谈白名单 |
| `来源检查：自报与实测一致` 红了 | `/healthz` 的 `gate.originCheck` 与"陌生来源被 403"对不上 —— 有一边在撒谎（配置没接上线，或反代把来源剥了） | 先看 healthz 自报，再手工用陌生 Origin 握手一次；不一致就查 `ALLOW_ORIGIN` 是不是真的进了环境 |
| `生产模式下来源检查必须开` 红了 | `ALLOW_ORIGIN` 没设（`gate.originCheck=false`） | WS 不吃 CORS，不检查等于对所有网站开放这台服（别人可以嵌进自己页面当免费炮台）。填上域名、重启，探针复跑转绿 |
| 坏邀请码注册**成功**了 | `JOIN_CODE` 为空 = 开放注册 | 公开运营才这么配。私有服必须给值 |
| 同名再注册**成功**了（反证臂红） | 上一条的绿是"注册永远成功"造出来的 | 先看账号库是不是内存的、`store` 那一格是什么 |
| 进不了对局 / `ack` 不前进 | 会话没带上，或那台要账号而本次没 `--register` | 加上 `--invite=… --register`；再看 `/healthz` 的 `auth.rejected` |
| 房间没被回收（印 `⚠ 未测`） | `ROOM_IDLE_MS` 可能被设得更长 | 这不是失败。把 `ROOM_IDLE_MS` 报出来即可 |

---

## 3. 压一压：这台机扛得住几个人（`soak --url`）

```bash
node server/soak.mjs --url=http://127.0.0.1:8123 --ladder=1,2,4
```

期望：每档 `GREEN`，末行 `GREEN 12/12 通过`；报告里那一行就是**这台机单进程的容量**。

本机已验读数（2026-09-26，对 `127.0.0.1:8124` 那个生产模式实例）：

```
      人数    间数   每间Hz(服务端自报)      每拍ms     落后ms    快照Hz/人(下界)   最大在途   heapMB
      16     1         60.3      0.190          0           20.2          11   17.1
      32     2         60.1      0.185          0           20.0           3   19.1
      64     4         59.7      0.278          0           20.1           3   24.8
  最高一档：64 人 / 4 间（每间 59.7Hz · 每拍 0.28ms · 下行 20.1Hz/人 · 峰值堆 24.8 MB）
```

**两个"真机上必然踩到"的坑，先看这两条再看红：**

1. **来源白名单**：生产部署一般设了 `ALLOW_ORIGIN`，而 `ws` 库默认**不**发 `Origin` 头 ⇒
   这台服会把压测当成陌生来源**全部 403**，看起来像"压不动"。
   `soak` 对外部目标**默认带上"目标自己"这个来源**（浏览器同源访问时发的就是它）；
   跨源部署用 `--origin=https://你的页面域` 显式给。
2. **每 IP 连接数**：`CONNS_PER_IP` 默认 6，本机压测 = 所有连接同一个 IP ⇒ **第 7 个就被拒**。
   容量测试要么把那一档调大，要么从多台机器压。⚠ 这不是"服务器扛不住"，是闸门在按设计工作 ——
   本机那次读数就是这么跑出来的（`CONNS_PER_IP=256`，见下面那行命令）。

红了怎么看：

| 症状 | 成因 | 怎么办 |
|---|---|---|
| 大量 `异常 N 条` / 连不上 | 上面那个坑 1 或 2 | 带上 `--origin=`；调大 `CONNS_PER_IP` 或换多机压 |
| `每间Hz` 掉到 57 以下 / `落后ms` 涨 | 真的到容量天花板了 | 看 `per[]` 里**哪一间先吃紧**；`stepMs` 一档比一档涨说明是单核打满 |
| `快照Hz/人` 掉而 `每间Hz` 不低 | 出站带宽或客户端侧下界 | 这一列是**下界参考**（假客户端跑在压测进程里，自己也会被事件循环拖慢） |
| `压完之后我开的房间能被收干净` 红了 | 空房回收没生效 | 判据只数**自己开的那些间**（前缀 `soak-<pid>`），真机上别人的房间不会让它假红 |

本机那次用的完整命令（把闸门调到能压）：

```bash
NODE_ENV=production JOIN_CODE=<码> REQUIRE_ACCOUNT=0 \
ALLOW_ORIGIN=http://127.0.0.1:8124 CONNS_PER_IP=256 \
MAX_CLIENTS=400 MAX_ROOMS=16 ROOM_IDLE_MS=3000 HOST=127.0.0.1 \
  node server/net-server.mjs 8124
node server/soak.mjs --url=http://127.0.0.1:8124 --ladder=1,2,4
```

---

## 4. 容器那三步（⚠ **三条命令本机没跑过；配方本身已经量了**）

本机没装 docker，所以下面这三步**没有在本机跑过**。谁在有 docker 的机器上跑完它，
把两段输出贴进这一节，这一节才算闭。

不过"没有 docker 守护进程"不等于这一节整块只能靠散文 —— **不需要 docker 的那一半在
`test/image.mjs` 里**（在 `npm test` 里跑，段号 A/B/C）：每条 `COPY` 的源都在仓库里、`CMD`
指着真文件、镜像默认 `NODE_ENV=production`、`USER` 不是 root、`npm ci --omit=dev` 与
`dependencies` 是同一份理解、运行时导入闭包（从 `server/net-server.mjs` 递归推的 32 个文件）
与 `PUBLIC` 白名单一条都没被 `.dockerignore` 挡住、闭包里没有一处 import playwright，以及
Dockerfile 里那句 HEALTHCHECK 的 payload 被抠出来**对一台真服跑**（退出码 0）**再对一个
空端口跑**（退出码必须 1）。所以 4.1 红了，先看 `test/image.mjs` 是绿还是红 —— 它绿的话
"配方"这一半已经排除掉了，红在构建多半是基础镜像/依赖层。
**仍然只有真机读数才能知道的事**（别拿上面那段当它们已经验过）：镜像真的构建得出来、
真的跑得起来、层体积、以及 4.4 那条 `SIGTERM`（Windows 上测不了，libuv 的 `child.kill()`
是直接 TerminateProcess）。

```bash
cp .env.example .env        # 改掉 JOIN_CODE 与域名；.env 不进镜像（.dockerignore 已挡）
docker build -t mw-room .
docker run -d --name mw-room -p 8090:8090 --env-file .env -v mw-accounts:/data mw-room
```

逐条期望：

| # | 命令 | 期望 | 红了怎么看 |
|---|---|---|---|
| 4.1 | `docker build -t mw-room .` | 构建成功 | 先跑 `node test/image.mjs`：它绿 ⇒ `COPY`/`CMD`/运行时闭包/白名单/HEALTHCHECK 这些"配方事实"都还在，红在构建多半是基础镜像或依赖层（网络、registry、`npm ci` 的锁文件），不是业务代码 |
| 4.2 | `docker run … --env-file .env` | 日志里是**生产模式**、`SqliteStore`、邀请码来自环境变量 | **别省 `--env-file`**。省了就是走配置闸 → 直接退出码 1（这正是那个闸存在的意义） |
| 4.3 | 不挂 `--env-file` 再 run 一次 | **退出码 1** + 两条出路 | 这是**期望的红**。真正的坑是"忘了设却启动成功了" |
| 4.4 | `docker inspect -f '{{.State.ExitCode}}' mw-room`（先 `docker stop -t 10 mw-room`） | `0`，且 10 秒内退净 | 非 0 ⇒ `SIGTERM` 那段没走完。**`docker stop` 会送 SIGTERM 给 PID 1**，`Dockerfile` 的 `CMD` 是直接 `node …`（没有 shell 包一层），信号才送得到 |
| 4.5 | 账号持久性：`docker rm -f mw-room` → 用**同一个卷**再 run → 登录老账号 | 登录成功 | 失败 ⇒ 卷没挂上（`-v mw-accounts:/data`，且 `.env` 里 `ACCOUNTS_DB=/data/accounts.db`）。⚠ **`docker stop` ≠ `docker rm`** —— 只 stop 的话容器还在，卷还是它的，验不出这件事 |
| 4.6 | 对容器跑一遍第 2、3 步 | `GREEN` | 容器里的路径口径与宿主机不同，这一步是把 2、3 的结论搬到容器上 |

**做完 4.1–4.6 之后**，`npm test` 里的 `deploy-probe` 那一段里的三条（配置闸退出码、
优雅下线退出码、dev 模式仍发源码）就都有真机读数了 —— 它们目前只有本机 spawn 出来的读数。

---

## 5. 上线之后要盯的三个数

`GET /healthz` 里这三组是"玩家侧看不出来、只有这里有"的那一类：

- `auth{rejected, tooMany, refusedAuth, refusedConn, refusedMsg}` —— 限流和闸门在生效的样子，
  在玩家侧和"服务挂了"完全一样。**它们动了是好事**（说明闸门在拦），
  但 `refusedConn` 一直涨而 `ips` 很少 ⇒ 有人在单 IP 刷连接。
- `lag{shots, ok, noView, stale, poseMiss, depth[]}` —— 延迟补偿的四项计数。
  **"这个玩家永远没有补偿"在玩家侧只表现为打不中**：`noView`/`stale` 涨说明他报的拍号出窗了。
- `per[]{hz, stepMs, behindMs, fails}` —— 扩容看的是"哪一间先吃紧"；
  `fails` 在"一个客户端的坏数据打死一屋子人"之前就会先动。

另外几件与运维有关的事：

- `gate.originCheck` —— 来源检查开没开的**自报**。remote-probe 会拿它和"陌生来源被 403"的
  实测互相印证；单独看它也行：生产上它是 `false` 就是"忘了设 ALLOW_ORIGIN"。
- **审计日志**：谁在什么时候从哪个 IP 注册/登录/被拒，记在账号库的 `audit` 表里
  （注册成功/被拒、登录成功/被拒，事件名即结局）。真有纠纷时在服务器上跑：

  ```bash
  node server/audit-dump.mjs --db=/data/accounts.db --limit=200        # 最近 200 条
  node server/audit-dump.mjs --db=/data/accounts.db --ev=login:bad_credentials   # 撞库现场
  node server/audit-dump.mjs --db=/data/accounts.db --name=某呼号       # 只看某个人
  ```

  只读打开，不停服。审计是**直写**的（不走 250ms 批刷），进程被杀也不丢 —— 判据在
  `test/accounts.mjs` 的 J 段（J8：users 还在脏集合里时另一个连接已经读得到 audit 行）。
- **账号找回**（玩家说"密码忘了、恢复码也丢了"）：给他补发一叠新码，念给本人。

  ```bash
  node server/recover.mjs --db=/data/accounts.db --name=某呼号          # 印出 5 张新码
  node server/audit-dump.mjs --db=/data/accounts.db --ev=recover:cli_issued   # 谁什么时候补发过
  ```

  补发即作废他手里旧的那一叠；这个脚本**不能设密码、不能改呼号**（对得上人才能补发，
  改密码仍然是本人的事）。它和 service 同时跑没问题（写 meta 抽屉，走同一套攒批刷盘）。
  另外 `/healthz` 的 `auth.recover` 是"成功重设过几次" —— 它涨，说明这条路上真的有人在走；
  它突然涨而你不知道是谁，就去翻上面的审计。判据在 `test/hardening.mjs` 的 J 段
  （真 HTTP + 真库文件 + 真 CLI 三段闭环），另一条说明见 `docs/net-vs-local-gaps.md` 附十二。

---

## 6. 这份清单**不管**的事（都立着账，别当成已经做完）

- 多实例编排：**一个进程 = 一个权威端**（第 1 节末尾写了口径与容量表是每进程的数）。
  **跨进程房间目录已收**（`ROOMS_DB`：自报 + 心跳 + TTL，一个大厅、多台执行；跨台加入凭一次性
  入场票；判据 `test/room-dir.mjs`，用法与自检见第 1 节末尾）。多台共用同一个 `ACCOUNTS_DB`：
  进程内的并发双花已修（`test/accounts.mjs` 的 L 段）；跨进程"账本进程私有"是立账的已知缺口，
  探针 `node server/multi-account-probe.mjs` 五格读数钉着现状
  （读数见 `docs/net-vs-local-gaps.md` 附十五）—— 目录不碰它，跨台身份是票桥过去的。
- 战役经验不进账号（本地那一半永不上报，只影响自己显示）；限流按 IP（可伪装）。
- ~~登录只有密码，没有找回~~ 已收口（2026-09-30）：注册与每次重设各发一叠 5 张一次性恢复码，
  用掉任意一张即整叠作废并换发新的；重设成功 = 登录 + 作废该账号全部旧会话；服主侧补发口
  `server/recover.mjs`（只能发码，不能设密码）+ 审计 `recover:cli_issued`。判据 `test/accounts.mjs`
  的 K 段、`test/hardening.mjs` 的 J 段、`test/net-drop.mjs` 的 I 段；设计理由与两次"能不能红"
  的实测见 `docs/net-vs-local-gaps.md` 附十二。没接邮箱/短信 —— 码丢了只能找服主，这是有意的一条。
- ~~没有审计日志~~ 已收口（2026-09-26）：`audit` 表 + `server/audit-dump.mjs` 读取口，
  判据在 `test/accounts.mjs` 的 J 段。上面第 5 节写了用法。
- ~~`ALLOW_ORIGIN` 留空没有闸~~ 半收口（2026-09-26）：**仍然不拒绝启动**（决策不变：
  确实有不需要来源检查的部署），但"忘了设"已经**机器可查** —— `/healthz` 的
  `gate.originCheck` 自报 + remote-probe 两条判据（自报与 403 实测一致；生产模式必须开）。
  开着来源检查的生产实例 34/34 绿；故意关掉的那台被当场点名红（两次实测都在）。
  2026-09-30 又收了一层：生产模式下未设 `ALLOW_ORIGIN` 会在启动日志里打一块**多行 + 带后果**
  的警告（`⚠ 生产模式未设 ALLOW_ORIGIN：本实例**不检查浏览器来源**。`），末尾用
  `启动完成（这一行之后不再有启动日志）` 当哨兵，"该打的块有没有打全"因此可等可判。
  判据 `test/hardening.mjs` 的 H7（未设 ⇒ 必须打）/ H8（设了 ⇒ 不许打），两条反证臂都实测过：
  把条件改成 `if (false)` ⇒ 只有 H7 红；改成 `if (true)` ⇒ 只有 H8 红（源码还原 byte-identical）。
- ~~容器那两条命令一律"未验证"~~ 半收口（2026-09-30）：不需要 docker 守护进程的那一半
  现在有判据了 —— `test/image.mjs`（`npm test` 的 A/B/C 三段）量 `COPY` 源、`CMD` 指真文件、
  镜像默认 `NODE_ENV=production`、非 root、`npm ci --omit=dev` 与 `dependencies` 一致、
  运行时导入闭包（32 个文件）与 `PUBLIC` 白名单不被 `.dockerignore` 挡住（反证臂：把 `js/`
  写进 ignore ⇒ B1/B2 当场红；把所有 ignore 清空 ⇒ B3 红）、闭包里没有 playwright，
  并把那句 HEALTHCHECK 的 payload 抠出来对真服跑（0）对空端口跑（必须 1；把它写死成
  `process.exit(0)` ⇒ C2 红，实测过）。**仍然只有真机读数才知道的**：真的 build、真的 run、
  层体积、4.4 那条 `SIGTERM`（Windows 上测不了）。
- ~~`carryMiss` 与"基态退回日记本"只打印不断言~~ 已收口（2026-09-26）：
  缺料逐笔归因 + 步数恒等式钉在 `test/reconcile-chain.mjs` 的 A2/A6，真浏览器那一半
  钉在 `test/net-play.mjs`（carry 步数一致性从打印升为判据）。

---

**遗留账**（"本机量不了"与"明说了没做"的那几条，含本清单 §4 那三条命令的读数还没补回来）
汇总在 `docs/net-vs-local-gaps.md` 附十四（第 9 轮末的原貌）与**附十五（第 10 轮更新）**：一张表写清每条
现在什么状态、为什么停在这、下一轮第一步、今天能不能被机器看见。第 10 轮（2026-10-01）收掉了空跑窗
那把尺子（`js/net/idle-ruler.mjs`：静止下限 + 族群臂，net-play 假红的源头拆了）与 `test/image.mjs` 的段过滤器，
量了"未补偿空跑窗"的分布（决定继续当读数），给共用账号库补了探针读数（`server/multi-account-probe.mjs`）
并把**进程内**那一半修掉（`test/accounts.mjs` L 段）；仍欠的是容器真机读数、8 份浏览器判据 `launch()`
中间档的本机实测、跨进程房间目录。同一节末尾另有一份"别把这些当成遗留"的清单（有意为之的那些）。
