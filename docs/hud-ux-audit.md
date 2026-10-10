# HUD 与 UI/UX 审计（对局内 HUD + 对局外界面）

一轮**只读**走查的产物，用来当 `feat/hud-ui-ux` 分支的工作清单。
每条给：症状（玩家/用户那一侧看得见的事实）、证据（`file:line`）、收法方向、判据（改完拿什么证明它真的不谎了）。

- 审计日期：2026-10-10
- 读过：`js/hud.js` 全文、`index.html`、`style.css` 全文、`js/menu.js`（1538 行分块读完）、
  `js/main.js`（输入/死亡/暂停/断线段）、`js/mp.js` 与 `js/net/client.mjs` 的 HUD 驱动段、
  `js/audio.js`、`js/effects.js`、`js/combat.js`、`js/weapon-state.js`、`docs/net-vs-local-gaps.md`
- **grep 快照**（当日事实，代码一动就可能变味，用前先重跑）：
  - `grep -c "@media" style.css` → **0**
  - `grep -rn "tabindex\|aria-\|role=\|autofocus\|:focus" js/ style.css index.html` → 审计当时 **0 命中**（仅 `hud.js:115` 的 `inp.focus()`）。第一批之后：`:focus-visible` 有了一条、`tabindex` 由 `keyify()` 在运行时设（源码里查不到），`aria-/role=` 仍是 0 → 拆成 HU-40
  - `grep -rn "mmLabel" js/` → **0**（DOM 里有，JS 从不写）

## 编号约定

`HU-01 …` 按优先级排（P0 = 界面在说谎，P1 = 对局内读数缺口，P2 = 记分板与结算，
P3 = 对局外流程，P4 = 适配性）。标题那行的状态只有四种写法：
`待修` / `部分已修(哪一半)` / `已修(哪一段判据)` / `不修(证据)` ——
**不许用勾选框**：一条 `[x]` 只盖得住它自己那一行，剩下的条目会消失在散文里（这一份一开始就数过：38 条）。
状态改了要重跑《进度》那一节的四条 grep，四个数相加必须等于总条数。

---

## 进度（这三个数由 grep 数出来，改条目就改标题那行的状态，别动这里的散文）

```bash
grep -c '^### HU-.*· 已修' docs/hud-ux-audit.md     # 7
grep -c '^### HU-.*· 部分已修' docs/hud-ux-audit.md  # 0
grep -c '^### HU-.*· 待修' docs/hud-ux-audit.md     # 33
grep -c '^### HU-.*· 不修' docs/hud-ux-audit.md     # 1
grep -c '^### HU-' docs/hud-ux-audit.md             # 41   ← 上面四个相加必须等于它
```

**第一批已收口**（2026-10-10）：HU-01 · HU-02 · HU-03 · HU-04 · HU-06 · HU-21 · HU-38（HU-38 原本挂在 P4）。
**但 P0 六条里没有 HU-05** —— 那条是我审计时只读了客户端那一半就下的判断，症状站不住
（服务端 `server/lobby.mjs:480` 拒收"正在对局中"的房间，中途根本进不来人），已改判**不修**，
真实的那一半降级成 HU-41；过程与教训写在 HU-05 那一节。
判据两份：`test/hud-ux.mjs`（47 条，进程内）与 `test/hud-keys.mjs`（24 条，真浏览器），都已进脚本档位 ——
README《验收》与 `docs/deploy-checklist.md` §0 都点了名，由 `test/docs-guard.mjs` 对账。
ARIA 那半从 HU-06 拆出去单立了 **HU-40**（与键盘可达是两件事，混一条会两条都收不干净）。

---

## P0 界面在说谎 / 自相矛盾（成本低，玩家一定撞上）

### HU-01 连杀就绪播报的键位是错的 · 已修（`test/hud-ux.mjs` B 段）

- **症状**：屏幕大字说「按 [3] 呼叫」，按 3 什么都没发生；按 4 会切出投掷物；真正的键是 5/6/7。
- **证据**：播报 `js/mp.js:402` 与 `js/net/client.mjs:1017` 都写 `按 [${i + 3}]`；
  实际键位 `js/main.js:791`（`Digit5/6/7`，注释明写"4 让给了投掷物，连杀顺延到 5/6/7"）；
  HUD 自绘槽位用的是 `[${i + 5}]`（`js/hud.js:249`）；设置屏键位表也写 5/6/7（`js/menu.js:1425`）。
  一份键位事实，四种写法。
- **收法**：把槽位→键码的映射收成一处（照 `SAY`/`ANNOUNCE` 那张表的形状：语义进、文本出），
  `mp.js`/`client.mjs`/`hud.js` 三处都从它取。
- **判据**：i=0/1/2 三个槽各一条，断言播报里的数字 ∈ {5,6,7} 且**等于**同一时刻槽位自绘的数字；
  反证臂：把 `i + 3` 改回去必须红。
- **收口（2026-10-10）**：键位收成 `js/data.js` 的 `STREAK_KEYS` / `STREAK_KEY_LABELS` / `streakKeyLabel(i)` / `streakSlotOf(pressed)`，
  绑定（`js/main.js` 的 `streak: streakSlotOf(P)`）、槽位自绘（`js/hud.js`）、两份就绪播报（`js/mp.js`、`js/net/client.mjs`）、
  主菜单与设置那两张键位表（`js/menu.js`）全部从这一处取。判据不比对两处数字相不相等，而是走**闭环**：
  拿屏幕上那个键码构造一份按键表喂进 `streakSlotOf`，回来的必须正是那个槽（B1）；
  B2 按旧写法 `i + 3` 实算一遍（当年按 5 叫出的是 0 号槽）；B5b/B6b 把派生代回字面量，同一把尺子当场认出来。

### HU-02 联机死亡画面的「按 [空格] 重新部署」是假的 · 已修（E 段）

- **症状**：联机里打出这句话的同一拍就已经自动请求部署了，空格从来不被读；玩家等着按键，人已经重生。
- **证据**：`js/main.js:603-605`（文案与 `requestRespawn()` 在同一 else 分支里）；
  单机那份才真吃空格 `js/mp.js:503`（`keys.Space || r.t < -4`）。
- **收法**：二选一并对齐两端 —— 要么联机也真读空格（把"何时部署"的选择权还给玩家，dom 波次制下不成立），
  要么文案改成「即将重新部署…」。**注意** dom 是波次制，tdm/ffa 才谈得上"按键即部署"。
- **判据**：按模式分支各量一次：tdm 联机里"文案说按空格"必须与"空格真能提前部署"同时成立或同时不成立。
- **收口（2026-10-10）**：先查了服务端 —— `server/room.mjs` 的 `requestRespawn` 只在 `respawnT ≤ 0.12s` 时认，
  dom 更是**全拒**（`if (this.flags) return false`）。那句话不是"玩家的按钮"，是"我这边倒计时走完了"的
  **去抖确认**，注释自己写着"早重生是实打实的收益，这条闸门把它挡在服务端，而不是靠客户端自觉"。
  所以"真读空格"这一支在联机里兑现不了，改的是文案：`js/main.js` 那一句现在是 `text = '正在部署…'`，
  函数头那句"tdm/ffa 照旧个人倒计时 + 空格提前部署"的旧注释一并改掉。
  **剩下的行为差**（没修，要修得动权威时序）：单机到点后给 4 秒宽限（`js/mp.js` 的 `keys.Space || r.t < -4`），
  联机到点就走。判据 E 段量的就是这道闸：哪天闸开了或口径变了，E1/E2 会红着提醒回来改文案。

### HU-03 掉线提示的关键半截会被裁掉 · 已修（F 段，形状）

- **症状**：断线后那行唯一出路（「按 Enter 重新连接」）在超宽文案下看不见，玩家只看到"连接已断开"。
- **证据**：文案 `js/main.js:765`（原因 + `serverNote` + "服务器可能在更新" + 按键指引，进 `announce`）；
  样式 `style.css:394`（`font-size:30px` + `letter-spacing:6px` + `white-space:nowrap`），
  且 `#hud{overflow:hidden}`（`style.css:4`）。
- **收法**：`#announce` 允许折行 + `max-width`；或把"按键指引"单独一行小字（`#announce small` 已是 block，`style.css:395`）。
- **判据**：浏览器判据 —— 塞一份 80 字的 `serverNote`，断言按键指引那一段的 `getBoundingClientRect()` 仍在视口内。
- **收口（2026-10-10）**：`#announce` 去掉 `white-space:nowrap`，改 `max-width: min(80vw, 900px)` ——
  nowrap 是从父级传到 `#announce small` 那一行的，所以裁掉的正是那句唯一出路。
  **判据只到形状**（F1/F1b 量的是那条规则里还有没有 nowrap），F 段开头写明了这一点；
  真正"落在视口内"的那一条浏览器判据仍欠着，长文案有没有把 22% 那个位置顶出画面没人量过。

### HU-04 `hud.reset()` 清了 `_eqSig` 却漏了 `_stkSig` · 已修（C 段，泛化闸）

- **症状**：新一局右下角连杀槽整局空白（DOM 被清空了，签名门却认为"没变"，不写回去）。
- **证据**：`js/hud.js:53-68` reset 只归位 `_eqSig/sweepT/mmT`；签名门在 `js/hud.js:244`（`sig === this._stkSig` ⇒ return）。
  同族 bug 在装备行已修过，注释就写在 `js/hud.js:59-61`。
- **收法**：reset 里一并清 `_stkSig`（顺手把 `_spSel`/`_fwEl`/`_fwNodes` 这些缓存 DOM 引用一并核一遍归位口径）。
- **判据**：两局连开，第一局末次槽位签名与第二局首次相同 ⇒ 第二局 `#streaks` 必须非空。反证臂：签名不同时必须重写。
- **收口（2026-10-10）**：`reset()` 里补齐 `_stkSig`，并把水圈的 DOM 缓存（`_fwEl/_fwNodes/_fwSig`）一并归位
  —— 它们指向的是刚被清掉的那批节点，留着既吊着 detached 元素又让"元素换了人"那条重建判据失真。
  判据没点名 `_stkSig`：**把"全文用过的 `this._*Sig`"与"reset 里归位的"两个集合对账**，缺哪条报哪条（C4/C4b），
  下次新加一条签名门忘了归位，这把尺子本来就认得它。C1 走的是真行为：假 DOM 上数 `innerHTML` 的写次数，
  A2 先自证"不 reset 时门真的会跳写"，否则 C1 的"写得回去"可以是恒绿。

### HU-05 中途进人无声、离开全屏大字 · 不修（原判据的症状不成立），真实的那一半降级到 HU-41

- **症状（审计时写的）**：有人加进对局你完全不知道（场上凭空多个人）；有人走掉则 `announce` 糊满屏幕。
- **证据**：`js/net/client.mjs:999`（`join` 只更新 roster，无任何 HUD 提示）vs `js/net/client.mjs:1102-1106`（`leave` 走 `announce`）。
- **更正（2026-10-10，被"完成 P0"这句逼着去查服务端）**：**中途进人这件事在设计上不存在** ——
  `server/lobby.mjs:480` 对 `stage !== 'waiting'` 的房间直接拒收（"那间房正在对局中，等它打完或在列表里另找一间"），
  README《已知缺口》也写着"对局中途进人、中途加 Bot 不做"。而 `join` 事件只由 `server/room.mjs:458`
  的 `addClient` 推 —— 也就是**名单成型那一批**，给它们逐个加 HUD 提示，症状会变成"开局每人刷一行大字"，
  比原来更坏。所以"进人无声"不是缺陷，是这一条路的输入本身不会在局中出现。
- **留下来的真实一半**：`leave` 用 `announce`（30px 居中大字）**呈现强度过重** ——
  16 人房里连着走人就是连着几条大字盖住战场。那是 P1 的打磨题，不是 P0 的"界面说谎"，
  另立 **HU-41**。
- **教训（写给下一轮，包括写给我自己）**：一条缺口如果写成"界面上少了 X"，先问**X 的输入在这条路上可达吗**；
  读一遍服务端那道闸再落笔。我当时只读了客户端那一半就下了"P0"。

### HU-06 菜单层不可键盘操作，且 Tab 被全局禁掉 · 已修（F 段形状 + `test/hud-keys.mjs` 真判据）

- **症状**：
  - `main.js:656` 的 `Tab preventDefault` 是无条件的，菜单屏里也被拦 ⇒ 焦点在输入框之间都跳不动。
  - 交互元素几乎全是带 click 委托的 `<div>`：`.mbtn/.mode/.mapc/.seg div/.pick/.gs-att/.cls/.slotc/.seat`（`js/menu.js:271` 一处委托）。
  - 反向的坑：`C` 换配装（`js/main.js:662`）、局内 `Enter/Y` 聊天（`js/main.js:666-670`）、断线 `Enter` 重连
    （`js/main.js:768`）这三条**只有键盘能触发**，界面上没有任何一处写出来。
  - Esc 只在 pause 与 classSelect 生效（`js/menu.js:131-134`）；大厅/房间/配装/枪匠/设置按 Esc 全无反应，
    枪匠想回主菜单必须「完成 → 返回」两跳（`js/menu.js:1361`）。
- **收法**：先立规范再改样式 —— 交互元素改真 `<button>`（或补 `tabindex` + keydown），
  加 `:focus-visible` 可见焦点环，Tab 拦截改成只在 `state === 'play'` 内生效，
  并给菜单层一条统一的 Esc 语义（回上一层）。
- **判据**：`grep` 类判据只能证明"写了"，不能证明"能用"。用浏览器判据：Tab N 次能走到全部主菜单入口、
  Enter 能激活当前焦点项、Esc 在每一屏都有定义的出路。
- **收口（2026-10-10）· 只落了可达性那一半**：
  - `js/main.js` 的 Tab 拦截收到 `state === 'play' && !paused`（暂停也算菜单，F3/F3b）；
  - `js/menu.js` 新增模块级 `KEYPICK`，**同一份名单**既给委托点击音效、又给 `keyify()` 设 `tabIndex = 0`（F4），
    `render()` 是唯一的渲染点所以每屏都过它，覆盖层 `picker()` 自己 `appendChild` 的那条路单独补一刀（F4b）；
  - `this.el` 上加一条委托 keydown：Enter/空格 给 `<div>` 那类合成一次 `click()`，激活逻辑仍走既有委托，
    不新增第二套语义；原生 `BUTTON/INPUT/SELECT/TEXTAREA/A` 与**正在打字的表单字段**一律跳过
    （否则回车提交建房名那种格会顺带激活包着它的可点元素，F5）；
  - `style.css` 加 `:focus-visible` 描边环（深色底上浏览器默认焦点环几乎看不见，能导航却没落点等于没放，F2）。
- **补上的第二半（同一天）**：统一的 Esc 走 `js/menu.js` 的 `ESC_EXIT` 表 —— **每屏指向它本来就有的那个出口**
  （房间屏那一个叫"离开房间"、枪匠那一个叫"完成"，各屏的去处早就在它自己的按钮里按 `loadoutFrom`/`inGame`
  分好了，Esc 再算一遍就是第二个真相）。`main`/`loading`/`results` 刻意不进表：宁可 Esc 没反应，
  也不能一按把人从结算或对话里踢出去。开着 picker 时先合覆盖层，退一层是一层。
- **`test/hud-keys.mjs`（真浏览器 24 条）**把 F 段证不了的那半证了：Tab 走遍主菜单五个入口 · 焦点环取
  `getComputedStyle` 算出来的 outline（不读我们自己写的标记）· Enter 换屏且**一次 Enter 只激活一次**
  （数 `audio.ui('click')`，委托若没跳过原生 `BUTTON` 这里就变 2）· 选枪覆盖层里 Tab 走到的那张卡
  就是落进 `profile` 的那一把 · **反方向臂** E1/E1b：打得正热时按 Tab 焦点一步都不许动，
  而按住出记分板、松开就收 —— 只量"菜单能用"的话，把对局里的 Tab 一起放开照样全绿。
- **仍欠**：ARIA / 语义标签（屏幕阅读器读到的仍是一堆 div）另立 **HU-40**；联网大厅与房间屏的键盘路径
  **没进** `hud-keys`（那两屏要真服务端状态，随 HU-22~HU-26 一起做；这份的文件头写明了边界）。

---

## P1 对局内 HUD 读数缺口

### HU-07 血量只有一根 5px 的条，无数字 · 待修

- **证据**：`index.html:112`（`#healthBox` 里只有 `#healthFill`）、`style.css:372`（`height:5px`）、`js/hud.js:296`。
  剩 30 与剩 90 只差一点点长度，且没有护甲/回血读数。
- **收法**：血条上加数字（或做 HUD 缩放/布局时一并考虑），并统一 `#healthFill.low` 的触发口径（现在 35%，`js/hud.js:296`）。

### HU-08 无常驻网络状态 · 待修

- **证据**：ping/快照份数只在按住 Tab 的记分板脚注里（`js/net/client.mjs:1564`，`style.css:426` 12px）；
  `rtt` 每秒才测一次（`js/net/client.mjs:1161`）；`js/net/predict.mjs` 的 rollback 不写 HUD ⇒
  被拉回时只看到位置瞬移，没有任何解释。
- **备注**：`docs/net-vs-local-gaps.md` 第 37 条只收了"看得见"那一半，抖动/丢包/回滚可见性仍是账。

### HU-09 小地图 45m 硬半径 + 无越界方向指示 · 待修

- **证据**：`js/hud.js:480`（`S=220, R=45`）、`js/hud.js:492`（`dot()` 不做 clamp，圈外直接被 canvas 裁掉）。
  旗子有 3D 标记兜底（`js/hud.js:406-410` 会 clamp 到屏幕边），**队友和敌人没有**。
- **附带**：`#mmLabel` 是死 DOM（`index.html:98`，JS 从不写）；小地图尺寸/半径不可调。

### HU-10 手雷与爆炸物没有任何来袭提示 · 待修

- **证据**：`js/effects.js` 无落点/来袭标记 API；`js/net/client.mjs:1066` 的 `proj` 事件只建表现副本；
  唯一橙边 `#alertEdge` 挂在 perk「高度警觉」上（`js/ai.js:327`、`js/net/client.mjs:1006`）。

### HU-11 空仓与"打光了"缺反馈 · 待修

- **证据**：`reserve===0` 时 `#ammoRes` 与正常值同色同字号（`js/hud.js:326`、`style.css:369`），不自动切副武器；
  空仓干响只在**新按扳机**时响（`js/weapon-state.js:201`），扣着不放时既无提示也不换弹。
- **收法**：`/ 0` 给独立色 + 空仓时给一次"按 R"提示（只给一次，别每拍写 DOM）。

### HU-12 连杀被权威端拒收时屏幕上什么都没有 · 待修

- **证据**：`js/net/client.mjs:1012` 的注释自己写着"HUD 毫无反馈"。玩家只会反复按同一个键。
- **收法**：拒收原因（未就绪 / 已被占 / 不可在此部署）走 `hud.popup`，且**不要**走 `announce`（弹窗是战场上的事）。

### HU-13 部分击杀有准星无声音 · 待修

- **证据**：哨戒机枪与直升机造成的命中只 `hitmarker`，不调 `audio.hit`（`js/mp.js:788`、`js/mp.js:970`）。
- **判据**：拿连杀奖励打死人，`audio.hit` 的记账桩必须被调到（照 `net-feel` V 段的记账桩形状）。

### HU-14 伤害方向指示器只有平面角 · 待修

- **证据**：`js/hud.js:303`（`Math.atan2(dx, -dz) + pl.yaw`，忽略俯仰与探头侧倾）；
  每跳血新增一个弧、无去重无上限（`js/hud.js:76-80`，`t=1.6s`）；半径固定 ~90px（`style.css:293-295`）。
  联机 hurt 由服务端按拍限流（`server/room.mjs:771`）⇒ 被点射时弧叠弧，且指向的是开火瞬间的旧位置。
- **收法**：同方向去重（角差 < ~20° 合一条）+ 条数上限 + 俯仰折算。

### HU-15 无队伍存活名单/人数读数 · 待修

- **证据**：dom 里「我方还剩几个人」只能靠小地图数点；`#popups` 上限 5 条 2.2s（`js/hud.js:198-199`），
  奖章/助攻/补弹全挤同一列。

### HU-41 玩家离开对局用 30px 居中大字播报 · 待修（从 HU-05 降级来的）

- **症状**：16 人房里连着走人，就是连着几条 `announce` 大字盖住战场 —— 而"某人退了"既不值得打断瞄准，
  也不值得占住屏幕中心。
- **证据**：`js/net/client.mjs:1102-1106`；`#announce` 的字号与位置见 `style.css:394`（30px、top 22%、居中）。
- **收法方向**：降到 `hud.popup` 那一档（或 killfeed 位的小字），与"谁上线了"这类非战斗信息同级。
  **注意** HU-05 那条更正：`join` 不能跟着加提示 —— 它只在名单成型那批到，加了就是开局刷屏。
- **判据**：跨窗口真浏览器 —— 乙退局，甲侧出现的是 popup 那一档、且 `#announce` 那一格没被写。

---

## P2 记分板与结算

### HU-16 两端记分板长得不一样 · 待修

- **证据**：单机 `js/mp.js:635-643`（无名次列、别人助攻恒 `'-'`）vs 联机 `js/net/client.mjs:1543-1568`
  （有 `#` 名次列、助攻、`me` 高亮、`dead` 灰行）。两边都缺 K/D 列、占领数（`js/mp.js:531` 记了账却不上榜）、职业/武器/奖章列。
- **收法**：照本仓库既有纪律 —— 表形状收成一份函数（`scoreboardRows()`），两端各自只管数据源。

### HU-17 按住 Tab 时榜单是否活刷不确定（无主动刷新路径）· 待修（先实测）

- **证据**：渲染只挂在 keydown 沿（`js/main.js:660` → `js/hud.js:541-548` 一次 `innerHTML`），
  代码里**没有** while-held 的定时刷新。是否靠 OS 键重复保活取决于浏览器 —— 这条要真机复验再定性。

### HU-18 大房只列前 16 + 自己 · 待修

- **证据**：`js/net/client.mjs:1555` 的裁剪提示只有一行小字；名单外队友的死活/ping 完全看不见。

### HU-19 结算要等 2.5s，期间屏幕只有一行 announce · 待修

- **证据**：`js/mp.js:669` / `js/net/client.mjs:1540` 的 `setTimeout(2500)`，战役 3.5s（`js/campaign.js:346`）；
  世界已冻（`js/main.js:1044`）。无 MVP 高亮、无回合/目标历史、无本局奖章回顾。

### HU-20 联机「再来一局」= 回房间等房主 · 待修（与 HU-19 同屏）

- **证据**：`js/net/client.mjs:1538`；单机是 `game.startGame('mp', cfg)`（`js/mp.js:675`）。
  联机侧无本地换图/换模式/重开入口。

### HU-21 `spawnSelect` 未在 reset 里清（目前被每拍覆盖兜住）· 已修（C5）

- **证据**：`js/hud.js:53-68` 无 `spawnSelect`；靠 `js/main.js:518` / `js/main.js:591` 每拍 `spawnSelect(null)` 兜。
  属侥幸不是设计 —— 与 HU-04 一起收。
- **收口（2026-10-10）**：`reset()` 里加 `this.spawnSelect(null)`，不再依赖死亡画面每拍覆盖。
  判据 C5 先摆一张上局的卡片、再 `reset()`，量的就是那一格有没有清空。

---

## P3 对局外流程（大厅 / 房间 / 配装 / 枪匠 / 设置）

### HU-22 关键按钮点了没反应（无 disable、无 spinner、无乐观更新）· 待修

- **证据**：房主「开始游戏」`js/menu.js:992` 只发一帧，本地零反馈，仅文案变「对局进行中…」（`js/menu.js:1071`），
  靠服务端 welcome 才换屏；创建/快速加入直接盖全屏 loading（`js/main.js:380-383`）不 disable ⇒ 连点会发两帧 `createRoom`。

### HU-23 远端房间无 `url` 时「加入」是死按钮 · 待修

- **证据**：按钮渲染只判 `can`（`js/menu.js:829`），而 `remoteJoin` 依赖 `row.url`（`js/menu.js:752`）。观战格同理。

### HU-24 没有按房号加入的输入格 · 待修

- **证据**：`js/menu.js:612` 只有「房名 + 创建 + 快速加入」。想进朋友的房只能指望它出现在列表里且房名是 ASCII。

### HU-25 错误提示 6 秒自动蒸发；非房主在房间屏无路可走 · 待修

- **证据**：`js/menu.js:944`（`onlineError` 定时清空）、`js/menu.js:1074`（`#rmWhy` 12px `#999` 一行灰字）、
  `js/menu.js:1128`（`roomDelBot` 对非房主直接 `return`，而 Bot 行 hover 仍高亮，`style.css:164`）。
  无 kick / ban / 倒计时 UI，房主移不掉挂机者。

### HU-26 大厅的重连按钮只在进屏那一瞬亮 · 待修

- **证据**：`js/menu.js:607` + `js/menu.js:804-805`（按真相收回）；房间屏（`showOnlineRoom`）没有重连入口，
  `roomAsk` 失败只写一句"还没连上大厅"（`js/menu.js:706`）。

### HU-27 配装的数值条是"空配件基准条" · 待修

- **证据**：`js/menu.js:1276` `miniBars` 用 `computeStats(id, {})` —— 与你实际带进对局的枪无关；
  枪匠的 delta 条只在 `mouseenter` 时出现（`js/menu.js:1376-1377`），鼠标一移开就回落 ⇒ 键盘/触屏看不到任何预览。
- **收法**：`miniBars` 拿当前职业的配件算；delta 改成可点/可聚焦地钉住。

### HU-28 枪匠滚轮吃掉整个界面 · 待修

- **证据**：`js/menu.js:140` 的 wheel 监听只判 `screen === 'gunsmith'` 不判 target ⇒
  鼠标在右侧配件列表（`style.css:218` `overflow-y:auto`）上滚动时，列表滚动与镜头缩放同时发生。

### HU-29 与整体界面断层的原生交互 · 待修

- **证据**：改名用 `window.prompt`（`js/menu.js:1252`）；「重置存档」用 `confirm` + `localStorage.removeItem` + `location.reload()`
  （`js/menu.js:1453`），无二次确认、无导出。

### HU-30 主菜单看不到自己的战绩；等级是纯装饰 · 待修

- **证据**：`playerCard()` 只出现在联机大厅右栏（`js/menu.js:621`、`js/menu.js:1169-1214`）；
  等级 1-55（`js/progress.mjs:36`）没有任何解锁/门槛读它（`grep -n unlock js/data.js js/menu.js js/progress.mjs` → 空）。

### HU-31 加载进度是硬编码台阶 · 待修

- **证据**：`js/main.js:165`（0→80% 由贴图回调）、`js/main.js:185`（跳 90%）、`js/main.js:211`（100%）；
  进对局/进房的 overlay 只有 `ldpulse` 呼吸动画（`js/menu.js:288`），无百分比、无失败重试。

---

## P4 适配性：响应式 / 字号 / 对比度 / 视口

### HU-32 全仓零响应式 + 一堆固定宽度 · 待修（结构性欠账）

- **证据**：`style.css` 全文 `@media` 出现 **0** 次，`html,body{overflow:hidden}`（`style.css:2`）。
  固定宽度：`.menu-left 520`（`style.css:26`）、`.maps repeat(2,300px)`（75）、3 个 `.mode` 各 200（71）、
  枪匠 `.gs-left 300 / .gs-right 360 / .gs-stats 640` 且绝对居中（211/218/229 ⇒ 窄窗中列与数值板重叠）、
  `.settings 620`（240）、`.results 900`（252）、`#scoreboard 820` 且无 `max-width`（419 ⇒ 1024 宽时左右各剩 102px）。
  唯一自适应是 `.gate-card{max-width:92vw}`（177）。

### HU-33 字号全为固定 px，无 rem · 待修

- **证据**：10px（`style.css:121` `.ct-time`）、11px（`style.css:154/157`、`js/menu.js:1353` 配件描述）、
  12px（`style.css:89`、`style.css:46`）⇒ 浏览器放大字号不跟随。

### HU-34 对比度不达 WCAG AA · 待修

- **证据**：`.menu-foot #666` ≈3.7:1（`style.css:34`）、主菜单版本行 `#555` ≈2.8:1（`js/menu.js:318`）、
  说明文字 `#777`。可达性暗示全靠 `:hover`（`.mbtn`/`.room-row`/`.gs-att`/`.pick`/Bot 行）⇒
  触屏与键盘用户看不到"这行能点"。全站只有 2 处 `title`（迷彩名，`js/menu.js:1349`），无 tooltip 组件，无「怎么玩」屏。

### HU-35 点击目标偏小 · 待修

- **证据**：`.cfg-row .seg div` padding 6px 4px（`style.css:141`）实测高约 26px、`.seg div`（`style.css:92`）约 30px、
  `.btn.small`（`style.css:43`）约 31px —— 房间设置 6 档目标挤在 ~300px 中栏里。

### HU-36 HUD 固定像素件在窄屏与宽屏两头都出问题 · 待修

- **证据**：罗盘 460px 写死 + `230 - deg*4`（`style.css:305` + `js/hud.js:342`）、方位名硬编码中文
  （`js/hud.js:43` 北/东北… ⇒ 换语言只剩 15° 数字格）；`killfeed` 无 `max-width`（`style.css:356`）与居中
  `scorebar top:52px`（`style.css:313`）在 1024×768 会撞（呼号允许 2-16 字，`server/accounts.mjs:70`）；
  `#streaks bottom:150` 与 `#ammoBox bottom:36`（375/364）在 768 高几乎无余量；`#equipRow` 是 `flex` 不换行（370）；
  `#chatBox` 360px + `word-break:break-all`（343/351）中文逐字硬折。
  反向（超宽）：瞄具遮罩全用 `vh` 定径（`style.css:277-291`）⇒ 21:9 下圆孔按高度定、左右大片可见；
  准星间距按 `innerHeight` 定标（`js/hud.js:276`）⇒ 同一把枪在 768 高的腰射扩散观感明显更小。

### HU-37 设置只有 9 项，手感相关的一概不给调 · 待修

- **证据**：`js/menu.js:1406-1414`（质量 / 帧率上限 / FOV / 灵敏度 / 开镜倍率 / 主音量 / 反转 Y / 语音播报 / 显示帧数）。
  缺：准星颜色·大小·间距（`style.css:265-268` 写死）、HUD 缩放与透明度、小地图尺寸（`style.css:310-311` 写死 220）、
  字幕开关、分声道音量（`js/audio.js` 只有 master，`js/audio.js:80`）、鼠标加速开关、**按键重绑定**
  （`js/menu.js:1416-1426` 那张键位表是静态文字）。

### HU-38 同一格文案三处口径 · 已修（D 段）

- **证据**：`killerInfo` —— 联机走 `escHtml`（`js/main.js:493`），单机与战役裸拼名字（`js/mp.js:345`、`js/campaign.js:314`）。
  当前不可利用（呼号白名单压死了 `<`），属纵深防御 + "同一个页面同一句话只有一份"的纪律问题。
- **收口（2026-10-10）**：那一格收成 `js/hud.js` 的 `killerInfo(killerName, weapon, head, selfText)`，
  三个调用点各剩一行；转义的责任回到**拼 innerHTML 的那一处**（与 `killfeed` 同一条 M10 纪律）。
  战役不说"自我击杀"，走 `selfText` 传参 —— 三份文案的字面差异保住了，拼接只剩一份。
  判据 D1 量到 DOM：呼号里的标签必须已转义；D3 数"还有几个调用点在裸拼"，D3b 把旧的裸拼写法代回 `js/mp.js` 必须点名。

### HU-39 暂停菜单糊掉战场信息，且没有键位表/比分/音量 · 待修

- **证据**：`js/menu.js:1457-1485`（仅 继续/读检查点/更换配装/重新开始/退出本局/设置/回主菜单）；
  `solid` 背景是 `rgba(6,8,9,.9)`+blur（`style.css:25`）⇒ 联机暂停时服务端照跑，比分条、水圈、击杀条全被盖住，
  只剩一行小字「对局不会因此停下」（`js/menu.js:108`）。

### HU-40 界面没有 ARIA / 语义标签，屏幕阅读器读到的是一堆 div · 待修

- **来源**：从 HU-06 拆出来的。键盘可达与"辅助技术读不读得到"是两件事，混在一条里只会让两条都收不干净。
- **证据**（2026-10-10 第二批之后的 grep 快照，用前先重跑）：`aria-` / `role=` 命中仍是 **0**；
  交互元素仍多为 `<div>`（`.mbtn/.pick/.mode/.mapc/.seg div`）。`tabindex` 不在源码里 —— 它由
  `js/menu.js` 的 `keyify()` 在运行时设；`:focus-visible` 已经有一条（`style.css`）。
- **症状**：屏幕阅读器念不出"这是设置按钮"；记分板、`#announce`、killfeed、占领进度那种**动态区**
  没有 `aria-live`，变了也不会被播报 —— 对局里那些"只写在屏幕上"的事（谁进了、哪点掉了）对他们是静默的。
- **收法方向**：先给动态区补 `aria-live`（便宜、收益直接），再把 `<div>` 换成真 `<button>`
  （语义顺带就有）；**别**用 `role="button"` 糊在 div 上 —— 那样键盘事件还得自己接一遍。
- **判据**：用 Playwright 的 accessibility snapshot 量"读得到名字"，不是量源码里有几个 `aria-`。

---

## 需要真浏览器复验才能定性的（别先写代码）

1. **HU-17** 按住 Tab 时记分板的刷新率（OS 键重复是否保活）。
2. **HU-06 之外的一条指针锁问题**：`js/main.js:724` 把 `requestPointerLock` 的 reject 空 catch 吞了，
   `js/main.js:710` 无条件 `clickToPlay.classList.add('hidden')`，`js/menu.js:1489` 只有 400ms 兜底 ⇒
   Chrome 退锁后的重锁冷却窗口里点「点击屏幕继续」完全无反馈。**冷却实际时长要实测**，代码侧证据是吞错 + 无条件隐藏。
3. **HU-32 / HU-36** 在 1024×768 与 2560×1080 两档下的实际重叠位置（截图 + 元素 rect，别靠算）。

## 落地顺序建议

- **第一批（纯文案/纯映射，风险最低）· 已收口 2026-10-10**：HU-01、HU-02、HU-03、HU-04、HU-06、HU-21、HU-38 —— 都只动表现层，权威状态一律不碰。
- **第二批（HUD 读数补齐）**：HU-07、HU-09、HU-11、HU-12、HU-13、HU-05、HU-08。
- **第三批（记分板/结算形状统一）**：HU-16、HU-18、HU-19、HU-20。
- **第四批（对局外流程反馈）**：HU-22 ~ HU-27、HU-29 ~ HU-31。
- **立项级（单独 PR，别混进手感改动）**：HU-32~HU-37（响应式 + 设置面板扩容）、HU-40（ARIA / 语义标签，用 accessibility snapshot 量）。
  HU-06（键盘可达）已在这一批里收掉，不再挂这一档。

## 本分支的边界

- **只动表现层**：不改权威状态、不改 `js/match-rules.js` 的规则内核、不动快照/协议字段。
  需要新事实（例如 HU-08 的丢包/回滚可见性、HU-12 的拒收原因）时，**先谈上行形状再画 UI**。
- **改 README《验收》或《已知缺口》之前**：先跑 `node test/docs-guard.mjs` 看退出码
  （README 是被机器读的清单，不是散文）。
- **一条改动配一条判据**，且必须写反证臂（改回旧写法要能红）。
  本仓库反复栽在"量具永远绿"上 —— 详见 `docs/net-vs-local-gaps.md` 各段的「能不能红」实测读数。
