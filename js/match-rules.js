// 对局规则内核：与"谁在这台机器上渲染"无关的那一半规则。
//
// 为什么要有这个文件：联机改造之前，计分、连杀充能、UAV 计时、空袭排程全都长在
// js/mp.js:MPMatch 里，而那个类把 game.player 当成"这台机器上的我"、把 HUD/DOM
// 当成规则的输出端。于是联机侧只能**不接** —— 症状是规则静默失效（按 3 呼叫 UAV
// 没有任何反应，不报错、不崩），而不是当场炸掉。
//
// 拆法照 js/combat.js:hitTestPlayer / js/quant.js / server/codec.mjs 的同一套：
// **一处定义，两边共用**。抄第二份的症状是"单机能呼叫、联机里没反应"，这种错不会
// 报错，只会让人觉得"这游戏联机是个残废版"。
//
// 这一份里**只有规则，没有表现**：需要播报什么、需要生成什么，一律交回上层
// （单机 MPMatch 播 HUD/音效，权威端 NetRoom 编成事件下发）。所以它不 import
// THREE、不 import hud/audio/effects，也不碰 document。
import { WORLD, uavBit } from './quant.js';
import { rng } from './rng.js';

// 上行协议里 streak 那一个字节的编码定义在 js/quant.js（和 KEY/BTN 同性质：它属于
// "协议怎么摆位"，不属于"规则怎么判"）。这里只用一句约定：拿到的值不是合法槽位下标
// 就一律不认（StreakBook.take 的边界检查），-1 与 0xff 都走那条路。
export const UAV_SECONDS = 30;
export const WP_SECONDS = 10;
export const HELI_SECONDS = 45;
export const SENTRY_SECONDS = 60;

// ---------- 按拍排程 ----------
//
// 替代权威端的 setTimeout。三个理由，一个都不能省：
//  ① 可验收。room.step() 是能被测试直接调 N 次的（test/net-probe.mjs 就是这么干的），
//     所以"呼叫空袭后第 84 拍开始投弹"是一条**确定性**判据；换成墙钟定时器，判据就只能
//     等 1.4 秒真实时间，还会因为机器忙而飘。
//  ② 单机也会错。MPMatch 的 setTimeout 在**暂停**期间照跑 —— 暂停菜单里按了呼叫，
//     空袭会在暂停的几十秒里自己落完地。按拍排程随 update 停。
//  ③ 房间回收后不再有回调打进来。
export class TickClock {
  constructor(t = 0) { this.t = t; this.jobs = []; this.seq = 0; this.fired = 0; }
  // n 是**拍**。上限 1 拍：0 拍的 after 就是"这一拍立刻"，那种写法在两端的顺序
  // 取决于调用点，是"同一份代码两种时序"的来源，不如显式写 1。
  after(n, fn, tag = '') {
    const id = ++this.seq;
    this.jobs.push({ id, at: this.t + Math.max(1, Math.round(n)), fn, tag });
    return id;
  }
  clear(tag) { this.jobs = this.jobs.filter(j => j.tag !== tag); }
  // 返回到期的个数（判据用它证明排程真的推进过，而不是靠回调里的副作用）
  step(n = 1, ctx) {
    this.t += n;
    const due = [], keep = [];
    for (const j of this.jobs) (j.at <= this.t ? due : keep).push(j);
    this.jobs = keep;
    // 先摘掉再执行：回调里再 after 时不会污染这一轮的遍历顺序
    for (const j of due) { this.fired++; j.fn(this.t, ctx); }
    return due.length;
  }
  get pending() { return this.jobs.length; }
}

// ---------- 连杀槽 ----------
//
// 一个人一份。规则：击杀/助攻/占点往里充能，充到 cost 就绪；就绪后**一直留着**，
// 死亡只清进度不清槽位（COD 的规矩：已就绪的奖励不会因为死一次就没了）。
export class StreakBook {
  // defs：KILLSTREAKS 里被这个人选中的那几项（任意顺序，内部按 kills 升序）
  // discount：强硬路线减 1（下限 2，与 js/mp.js 原式一致）
  constructor(defs, discount = 0) {
    this.defs = defs.slice().sort((a, b) => a.kills - b.kills);
    this.slots = this.defs.map(d => ({
      id: d.id, name: d.name, icon: d.icon,
      cost: Math.max(2, d.kills - discount), ready: false, used: false,
    }));
    this.progress = 0;
  }
  get length() { return this.slots.length; }
  get ids() { return this.slots.map(s => s.id); }
  // 换职业时重算成本。**不再就绪的槽位要退回未就绪**：强硬路线在这里是"降成本"，
  // 摘掉之后原来的 cost 会变大，一个已经充到 4 的槽如果 cost 从 4 变回 5 却仍标着
  // ready，那就是凭空多送一个奖励。
  setDiscount(discount) {
    const d = Math.max(0, discount | 0);
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      s.cost = Math.max(2, this.defs[i].kills - d);
      if (s.ready && !s.used && this.progress < s.cost) s.ready = false;
    }
  }
  // 返回到**这一下刚就绪**的槽位下标（供上层播报）。没就绪返回空数组 ——
  // 上层不该自己去比 progress/cost，那种比较抄两份就会一边对一边错。
  charge(v) {
    this.progress += v;
    const fired = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.ready && !s.used && this.progress >= s.cost) { s.ready = true; fired.push(i); }
    }
    return fired;
  }
  // 呼叫一个槽（协议侧入口：客户端报的是**下标**）。没就绪/越界返回 null。
  // 权威裁决的唯一入口 —— 上层不许绕开它去改 s.ready。
  take(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.slots.length) return null;
    return this.consume(this.slots[i]);
  }
  // 按对象消耗。"呼叫即生效"的那几项走 take；而集束空袭是"先选目标、确认了才算用掉"，
  // 请求那一刻只能记住槽位对象，确认时才消耗 —— 那条路走这里。
  consume(s) {
    if (!s || !s.ready) return null;
    s.ready = false; s.used = true;
    return s;
  }
  onDeath() { this.progress = 0; }
  // 退还未真正生效的一次消耗。权威端有这样一个场景：呼叫哨戒机枪时消耗已经发生，
  // 然后才发现"这个位置放不下"。单机那条路是"先检查后消耗"（两条路都能保证账对），
  // 但让消耗点保持唯一更稳 —— 不然某天有人加了一条新的消耗路径却忘了先检查，
  // 症状就是"呼叫失败也扣掉了"，而且只在那一条新路径上出现。
  refund(s) {
    if (!s || !s.used || s.ready) return false;
    s.used = false; s.ready = true;
    return true;
  }
}

// ---------- 对局规则 ----------
//
// 全对局一份：队伍分数、UAV/白磷弹的剩余拍、按拍排程器、结束判定、世界标志。
// 连杀槽不在这里 —— 那是每人一份的（见 StreakBook），谁持有它由上层决定。

// 各模式的**默认**胜利目标。房间层（server/lobby.mjs）在房主没选/选了不认的值时也问
// 这一句 —— 默认只此一份，抄一份的话"没选目标的开房"与"选了目标的开房"会打出两种胜负。
export const DEFAULT_SCORE_LIMIT = (mode) => mode === 'dom' ? 200 : mode === 'ffa' ? 25 : 50;

// 占领模式的积分节奏，三格一起定（单机 MPMatch 与联机 NetRoom 跑同一份账，
// 别处不许再出现这三个数的字面量）：
//   DOM_SCORE_PER_SEC —— 每个据点每秒的基础涨速（flagsTick 里那条）。从 0.6 整体调低
//      一半：胜利目标改成 100/200/500 的档位（js/data.js:DOM_SCORES）之后，0.6/秒 配
//      500 分的局三旗全占也要十几分钟纯占点才到线，涨速不降档位就没有意义。
//   DOM_START_SCORE   —— 开局双方各拿的底分。占点的分是"攒"出来的，从 0 起步的话
//      前几分钟记分板上一片空白，复活扣分（下一条）也无处可扣。
//   DOM_RESPAWN_COST  —— 阵营每复活一人扣掉的分（onRespawn）。死人也要记账：白给
//      的复活在把队伍的分往回送，"占着点就稳赢"的滚雪球被这条压住。
//   DOM_SCORE_ROSTER_NORM —— 涨速的**基准人数**。复活税按人头走（人越多、每秒的
//      复活扣分越多），产出若还是定速，大房（30v30/50v50）的净涨速就被吃穿 ——
//      实测 60 人房比分在底分附近爬不动。所以每据点的实际涨速由 MatchRules.
//      domScoreRate() 给出：DOM_SCORE_PER_SEC × max(1, roster/基准) —— ≤基准夹在
//      原速（小房的调参一格不动、旧对局逐位复现），超出随总人数线性放大（60 人房
//      1.5/秒/点、100 人房 2.5/秒/点），净涨速回到基准房的调参值。基准取本地默认
//      6v6 = 12。rosterSize 由调用方上报：单机在 MPMatch.start（名单开场即定），
//      联机在 NetRoom.step（逐拍对账真人 + Bot；对局中途进出也跟着走）。
export const DOM_SCORE_PER_SEC = 0.3;
export const DOM_START_SCORE = 50;
export const DOM_RESPAWN_COST = 1;
export const DOM_SCORE_ROSTER_NORM = 12;

// 占领圈是**同心两层**，占领力按人算、不封顶（单机 MPMatch 与联机 NetRoom 跑同一份账，
// 半径/力度不许在别处再写字面量）：
//   DOM_RADIUS_STRONG —— 内圈（强占领圈）。世界里有实体环画着它（js/mp.js:flagMesh 的
//      RingGeometry），进圈即为"站在点上"。
//   DOM_RADIUS_WEAK   —— 外圈（弱占领圈），比内圈大得多。它**刻意不在世界里画**：
//      满地都是圈等于没有圈 —— 唯一的视觉在小地图上（js/hud.js:drawMinimap 的虚线圆）。
//      两件事吃这个半径：弱占领力、以及"在已占点重生"的散布范围。
//   DOM_POWER_*       —— 每人的占领力：内圈 2、仅在外圈 1。旧模型的"3 人封顶"已删：
//      圈里的每个人都出力，人数就是硬道理。
//   DOM_CAP_RATE      —— 每 1 点占领力的进度/秒。整体大幅放缓：旧式子独占内圈 0.18/秒
//      （约 5.6 秒占完），现在独占内圈 0.06/秒、蹲外圈只有 0.03/秒 —— 想快速拿下就
//      得往里圈堆人。没人时按 DOM_CAP_DECAY 回退（也随涨速一起放慢）。
//   DOM_WAVE_BY_FLAGS —— 占领的**波次复活**档位：CD 按阵营**占有的据点个数**取（秒），
//      占得越少补员越快（落后补偿，压住滚雪球）：0 个点只剩基地 ⇒ 5s/波、1 个点 ⇒ 10s、
//      2 个点 ⇒ 20s、3 个点 ⇒ 30s。基地与名下每个据点都是复活点、共用同一档 CD、
//      各自独立循环 —— 一批一批，不管有没有人排，CD 都照转（spawnWavesTick）。
//      基地不再是"个人倒计时"：dom 里人人都等波（tdm/ffa 才走老倒计时）。
export const DOM_RADIUS_STRONG = 4.5;
export const DOM_RADIUS_WEAK = 30;
export const DOM_POWER_STRONG = 2;
export const DOM_POWER_WEAK = 1;
export const DOM_CAP_RATE = 0.03;
export const DOM_CAP_DECAY = 0.03;
export const DOM_WAVE_BY_FLAGS = [5, 10, 20, 30];
// 下属标即"占有几个据点"。超出档位表（未来加到 4 面旗）按末档收口 —— 不许出 undefined。
export const domWaveCd = (owned) => DOM_WAVE_BY_FLAGS[Math.max(0, Math.min(DOM_WAVE_BY_FLAGS.length - 1, owned | 0))];

export class MatchRules {
  constructor(cfg = {}) {
    const mode = cfg.mode || 'tdm';
    this.ffa = mode === 'ffa';
    this.mode = mode;
    this.scoreLimit = cfg.scoreLimit || DEFAULT_SCORE_LIMIT(mode);
    this.timeLimit = cfg.timeLimit || 10;         // 分钟
    // dom 从底分起步（DOM_START_SCORE）；tdm/ffa 的分是"挣"出来的，照旧从 0 起步。
    this.scores = mode === 'dom'
      ? { A: DOM_START_SCORE, B: DOM_START_SCORE }
      : { A: 0, B: 0 };
    this.uav = new Map();                          // team -> 剩余拍
    this.wpTicks = 0;
    this.clock = new TickClock();
    this.tick = 0;
    this.over = null;                              // { winner, tick }
    this.firstBlood = false;
    this.chainBy = new Map();                      // 连杀奖章（双杀/三杀…）的窗口，**按击杀者分账**（键 = 击杀者实体）
    // 判据要能区分"规则没接上"与"规则接上了但没触发"：这两个计数就是那个分界。
    this.kills = 0; this.charged = 0; this.calls = 0;
    // 当场总人数（涨速用，见 DOM_SCORE_ROSTER_NORM）。0 = 调用方没上报 —— 按基准算，
    // 裸 MatchRules 的判据与旧版逐位一致。
    this.rosterSize = cfg.rosterSize || 0;
  }

  // 每拍调一次（必须与权威端的 tick 同一个节拍 —— 差一拍不会报错，只会让 UAV
  // 比屏幕上的计时器早/晚一秒消失）。
  step() {
    this.tick++;
    this.clock.step(1);
    if (this.wpTicks > 0) this.wpTicks--;
    // 直接迭代并删/改：Map 的迭代器对"删当前项、改当前项的值"都是安全的，
    // 复制一份 [...this.uav]（每拍一次，绝大多数拍里 UAV 表是空的）是纯白工。
    if (this.uav.size) {
      for (const [t, n] of this.uav) {
        if (n - 1 > 0) this.uav.set(t, n - 1); else this.uav.delete(t);
      }
    }
  }

  uavStart(team, ticks = UAV_SECONDS * 60) { this.uav.set(team, Math.max(1, Math.round(ticks))); }
  uavActive(team) { return (this.uav.get(team) || 0) > 0; }
  uavLeft(team) { return this.uav.get(team) || 0; }

  // 连杀奖章窗口（双杀/三杀…）。窗口按**拍**而不是秒：秒基的窗口在权威端要读
  // game.time，而 game.time 与 tick 在权威端是同一件事的两种写法，多一个就多一处漂移。
  // 账按**击杀者**分开记（键 = 击杀者实体）。这条链曾经是实例上一条全局滚动表：
  // 单机只有本地玩家的击杀会调它，"碰巧"只装一个人的账；联机权威端**每一杀**都过
  // 这里，全房 4 秒内谁杀的都算进"你这一杀"的 chain —— 症状是热闹的房里每杀必念
  // "暴走/无人可挡"，分值跟着 chain×50 一起虚高（2026-10-04 实网报的 bug）。
  // 键的生命周期归调用方：死亡与离场时调 resetChain 删账。
  killChain(key, ticks = 4 * 60) {
    let arr = this.chainBy.get(key);
    if (!arr) this.chainBy.set(key, arr = []);
    // arr 恒按拍号升序，过期修剪从头数：多数拍里第一条就没过期，循环空转
    let i = 0;
    while (i < arr.length && this.tick - arr[i] >= ticks) i++;
    if (i) arr.splice(0, i);
    arr.push(this.tick);
    return arr.length;
  }

  // 清掉一个击杀者的链。两处语义共用：死亡（隔着一次重生的两杀不该算双杀 —— 复活
  // 只要 3 秒，比 4 秒窗口短，光靠时间过期盖不住）与离场（删账防泄漏）。
  resetChain(key) { this.chainBy.delete(key); }

  // 清整张表。**测试钩子**：问"这一杀的 tags 里有什么"的场景不想要上一场景的账。
  resetChains() { this.chainBy.clear(); }

  addScore(team, v) { this.scores[team] = (this.scores[team] || 0) + v; }

  // dom 每据点每秒的**实际**涨速（flagsTick 每拍读一次）。产出与当场总人数正相关：
  // DOM_RESPAWN_COST 按"每复活一人 -1"记账，人数翻倍、每秒的死亡回吐也近似翻倍，
  // 涨速若是定速，大房的净涨速就被复活税吃穿。≤基准（12）夹在原速 —— 小房调参与
  // 旧对局逐位不动；超出按 roster/12 线性放大（60 人房 1.5/秒/点、100 人房 2.5/秒/点），
  // 净涨速回到基准房的调参值。rosterSize 的上报点见 DOM_SCORE_ROSTER_NORM 那条注释。
  domScoreRate() {
    const n = this.rosterSize | 0;
    return n > DOM_SCORE_ROSTER_NORM ? DOM_SCORE_PER_SEC * n / DOM_SCORE_ROSTER_NORM : DOM_SCORE_PER_SEC;
  }

  // 复活扣分（只在 dom 生效，tdm/ffa 里死亡的代价已经由对面的击杀数结算过了）。
  // 下限钳在 0：负分在记分板上没有意义，而且离"到线获胜"只远不近的队不需要再罚。
  // 返回扣完之后的分值，调用方的判据好断言。调用点：单机 js/mp.js 的 respawns 队列、
  // 联机 server/room.mjs 的真人/Bot 两条复活路 —— 四个字：复活必扣。
  onRespawn(team) {
    if (this.mode !== 'dom') return this.scores[team] || 0;
    this.scores[team] = Math.max(0, (this.scores[team] || 0) - DOM_RESPAWN_COST);
    return this.scores[team];
  }

  // 结束判定。返回 winner（'A'/'B'/'draw'/null）。调用方负责播报与收尾 ——
  // 规则只说"谁赢了"，不说"怎么显示"。
  checkEnd() {
    if (this.over) return this.over.winner;
    if (!this.ffa) {
      if (this.scores.A >= this.scoreLimit) return this._end('A');
      if (this.scores.B >= this.scoreLimit) return this._end('B');
    }
    if (this.timeUp) {
      // 自由混战的赢家是**名次第一的那个人**，而"人"这种东西规则不认（它只认队伍）。
      // 这条一开始写成了返回 'draw'，于是单机 FFA 一到时间就变成平局。
      // 现在改成把"已经结束、没有赢家"这件事**记进 over**：只 return null 的话，
      // 权威端每秒那次 checkEnd 读不到任何状态，FFA 一到时间就永远不结束
      // （房间也永远回不来 —— 见 server/room.mjs 的每秒判终点）。
      if (this.ffa) return this._end(null);
      const { A, B } = this.scores;
      return this._end(A > B ? 'A' : B > A ? 'B' : 'draw');
    }
    return null;
  }
  get timeUp() { return this.tick >= this.timeLimit * 60 * 60; }
  _end(winner) { if (!this.over) this.over = { winner, tick: this.tick }; return this.over.winner; }
  forceEnd(winner) { return this._end(winner); }

  timeLeft() { return Math.max(0, this.timeLimit * 60 - this.tick / 60); }

  // 快照头里的那个字节。它是**全局**的（一份 buffer 发给一屋子人，不按接收者编），
  // 所以 UAV 必须按队分开表达 —— 客户端拿到同一个字节，按自己 team 查对应的那一位
  // （js/quant.js:uavBit）。以前这里硬编码 0：位定义在 quant.js 里躺了很久，
  // 但从来没人往里写过东西，于是"UAV 上线了"这件事在客户端根本无从得知。
  worldFlags() {
    let f = 0;
    // FFA 的 UAV 账按"每人一支队"记（键是 'P'+cid），'A'/'B' 两格永远查不到它 ——
    // 没有这一句，联机 FFA 呼叫 UAV 后这个字节里的 UAV 位根本不亮，小地图一个点不给。
    // 位只有两个、人却人人一支，FFA 下只能折成"任何人开着 UAV 就亮"：人人为敌，
    // 一张透视图对全场等价（对没开的人相当于吃了别人 UAV 的亏，与团队模式里被对面
    // UAV 透是同一件事），单机 FFA 的表现也是这一种。
    if (this.ffa ? this.uav.size > 0 : this.uavActive('A')) f |= WORLD.UAV;
    if (this.uavActive('B')) f |= WORLD.UAV_B;
    if (this.wpTicks > 0) f |= WORLD.WhitePhosphorus;
    if (this.over) f |= WORLD.MatchOver;
    return f;
  }
}

// 位 → 该队是否有 UAV。两端共用这一句，免得服务端按 'A' 置位、客户端按 'A' 查位
// 这种"两边都觉得自己对"的错位。
export function uavFromFlags(flags, team) { return !!(flags & uavBit(team)); }

// ---------- 一次击杀值多少分 ----------
//
// **一处定义**：单机 js/mp.js:playerKill 与联机 server/room.mjs:onKill 都问这一句。
// 分值以前是散在 playerKill 里的字面量（100 / 50 / 50 / 50 …），联机侧如果抄一份，
// 症状不是报错，而是"联机挣的经验值和单机不是一套算法"—— 这种账在对不上之前没人查。
export const KILL_POINTS = {
  kill: 100, head: 50, melee: 50, longshot: 50, revenge: 50,
  chain: 50, assist: 25, capture: 200, firstBlood: 50,
};
export const LONGSHOT_DIST = 40;

// tags 是**语义**（'head' / 'melee' / 'longshot' / 'revenge' / 'chain4'），不是文案：
// 两端各自画成什么字是表现层的差别，不是规则的差别。**两边都画**（单机 mp.js:playerKill、
// 联机 main.js:onNetKill）—— 这条曾经写的是"联机不发奖章弹窗"，那不是设计而是缺口：
// 同样是爆头，单机屏幕上多一行、联机什么都不说。
export function killScore(o) {
  let points = KILL_POINTS.kill;
  const tags = [];
  if (o.head) { points += KILL_POINTS.head; tags.push('head'); }
  if (o.melee) { points += KILL_POINTS.melee; tags.push('melee'); }
  if (!o.explosive && o.dist > LONGSHOT_DIST) { points += KILL_POINTS.longshot; tags.push('longshot'); }
  if (o.revenge) { points += KILL_POINTS.revenge; tags.push('revenge'); }
  if ((o.chain | 0) >= 2) { points += o.chain * KILL_POINTS.chain; tags.push('chain' + Math.min(o.chain, 6)); }
  return { points, tags };
}

// 奖章的**文案与分值**：语义标签 → 一行字 + 这一条值多少分。
// 放在规则内核里是因为它要被画**两次**：单机 js/mp.js:playerKill 画它，联机
// js/main.js:onNetKill 画同一批（服务端把 killScore 算出的 tags 随 kill 事件发下去）。
// 分值从 KILL_POINTS 现取，不另抄一份数字 —— 抄一份的症状是弹窗写着 "+50"、账上加的是
// 25，而两边都觉得自己对（文案归表现层，但"这一条值多少"是规则）。
export const MEDAL_LABEL = {
  head: '爆头', melee: '近战击杀', longshot: '远距离击杀', revenge: '复仇',
  chain2: '双杀', chain3: '三杀', chain4: '四杀', chain5: '暴走', chain6: '无人可挡',
};

// tags → 逐条奖章 [{tag, label, points}]。**不认识的标签直接丢掉**，不拿"击杀"糊过去：
// 以后 killScore 加了新标签而这个表没跟上时，症状是"少一条弹窗"，不是"弹出一句莫名其妙的话"。
export function killMedals(tags) {
  const out = [];
  for (const t of tags || []) {
    const label = MEDAL_LABEL[t];
    if (!label) continue;
    // 连杀的第 n 条按 n × 单条分算（与 killScore 里 `o.chain * KILL_POINTS.chain` 同一句）。
    const n = t.startsWith('chain') ? (parseInt(t.slice(5), 10) || 0) : 0;
    out.push({ tag: t, label, points: n ? n * KILL_POINTS.chain : (KILL_POINTS[t] | 0) });
  }
  return out;
}

// ---------- 播报文案（语音 + 屏幕大字）：两端共用这一份 ----------
//
// 为什么它该在规则内核里：这一格以前是**三份**字面量 —— 单机 js/mp.js 的 say('…')、
// 服务端 server/room.mjs 的 announce text、以及联机客户端 client.mjs 自己拼的
// '敌方' + ev.text。三份各自长出来的症状不是报错，而是玩家侧的"出入"：
//单机说"敌方无人机已上线"、联机念"UAV 已上线"（英文缩写，念法不可控）；
//单机"敌方武装直升机进入战区"、联机"敌方武装直升机来袭"。
// 更糟的一类是**缺**的：联机开局没有"行动开始"、连杀奖章一句都不念 ——
// 而这层整类差异此前在判据里是隐形的，因为 test/net-feel.mjs 把 audio.say 打了空桩。
//
// 形状照 MEDAL_LABEL / killMedals：**语义进、文本出**，调用方不写死任何一句成品话。
// `say` 为空串 = 这一格不念（不是念一个空字符串）。
export const SAY = {
  // —— 连杀奖励被呼叫：按 id 走，不按名字 ——
  uavOwn: '无人机已上线',
  clusterOwn: '集束空袭已确认',
  sentryOwn: '哨戒机枪已部署',
  heliOwn: '武装直升机已就位',
  wpOwn: '白磷弹投放',
  // —— 敌方来袭（对面那一队听见的）——
  uavFoe: '敌方无人机已上线',
  clusterFoe: '敌方空袭来袭，寻找掩护',
  heliFoe: '敌方武装直升机进入战区',
  wpFoe: '白磷弹来袭，离开火区',
  // —— 槽位充能到线 ——
  ready: name => name + '已就绪',
  // —— 击杀奖章：只有连杀类念得出来（与单机 mp.js 的 startsWith('chain') 同一条件）——
  medalChain: label => label,
  // —— 对局结束 ——
  win: '胜利', draw: '平局', lose: '失败',
  // —— 占点 ——
  // 语音这一侧**不给空格**：TTS 念"已占领 A 点"会在字母名上顿一下。
  capOwn: f => `已占领${f}点`,
  capFoe: f => `${f}点已失守`,
  // —— 部署失败（只说给呼叫者自己）——
  sentryBlocked: '无法在此部署，位置被挡住',
};

// 屏幕大字（hud.announce 的 title）同样一份：它与语音常常**不是同一句话**
// （单机的 '敌方 UAV 已上线' 带副标题 '幽灵技能可规避'），所以分开两张表而不是硬凑。
export const ANNOUNCE = {
  uav: 'UAV 已上线', uavFoe: '敌方 UAV 已上线',
  cluster: '集束空袭已呼叫', clusterFoe: '敌方空袭来袭！',
  wp: '白磷弹投放', wpFoe: '白磷弹来袭',
  heli: '武装直升机已就位', heliFoe: '敌方武装直升机',
  sentry: '哨戒机枪已部署', sentryBlocked: '无法在此部署',
  turretLost: kind => kind + '被摧毁',
  // 占点那两句**保留**"已占领 A 点"的空格 —— 屏幕大字是给人看的，字母名之间留白
  // 更好读，而语音那一侧不给空格（SAY.capOwn）。两句话形状不同是故意的。
  capTitle: f => `已占领 ${f} 点`,
  capLostTitle: f => `敌方${f}点已失守`,
};

// 按槽位 id 取"我自己呼叫了它"该念的那一句。**这是给联机客户端用的** ——
// 服务端那条 announce 已经带 say 了，但 streak 事件（"我按了 3"）只带 id 与 name，
// 客户端要自己查这一份。查不到（老服务端 / 以后加了新槽位）返回空串，由调用方退回
// SAY.ready(name) —— 宁可念一句不完全对味的，也不要静默。
export const streakOwn = (id) => ({
  uav: SAY.uavOwn, cluster: SAY.clusterOwn, sentry: SAY.sentryOwn,
  heli: SAY.heliOwn, wp: SAY.wpOwn,
}[id] || '');

// 开局那一句：模式名由调用方给（MP_MODES 在两端共读），这里只拼形状。
export const SAY_START = name => name + '，行动开始';

// 击杀奖章里**只有连杀类要念**。判据是 tag 形状，与单机 mp.js:playerKill 的
// `m.tag.startsWith('chain')` 同一句 —— 两端跑这一份，不再各写一遍。
export function medalSay(tag, label) {
  return String(tag || '').startsWith('chain') ? SAY.medalChain(label) : '';
}


// 两端共用这一份：单机 MPMatch.playerKill 与联机权威端 NetRoom.onKill 都调它；联机的
// 客户端在**自己的**击杀事件上再跑一遍它自己那份状态机（服务端管权威血量/弹药，客户端
// 管屏幕上的计数，各应用一次、互不覆盖）。返回的 texts 是弹窗文案 —— 文案归表现层，
// 这里只报告"发生了什么"，谁爱画谁画。
export function onKillPerks(pl) {
  const out = { refill: 0, texts: [] };
  if (!pl || !pl.hasPerk) return out;
  if (pl.hasPerk('scavenger')) {
    if (pl.ws && pl.ws.refill) pl.ws.refill(0.35);
    if (pl.lethal && pl.lethal.count < pl.lethal.max) pl.lethal.count++;
    out.refill = 0.35;
    out.texts.push('拾荒者：弹药补给');
  }
  if (pl.hasPerk('quickfix')) { pl.dmgT = 99; pl.hp = Math.min(pl.maxHp, pl.hp + 40); }
  return out;
}

// ---------- UAV 给持有方的 Bot 报点（幽灵除外） ----------
// 语义与单机 MPMatch.update 里那段一致：谁的 UAV 在天上，谁的 Bot 就每 2.5 秒拿到一次
// "敌人在哪"的提示（hint → 搜索走向），带幽灵的玩家从名单里剔掉。两端各调一遍：
// 单机传 pl.team 当 skipTeam（"我方 UAV 走小地图、不喂 Bot"是从那**一个**玩家的视角
// 写的），联机服务端传 null —— 那边没有"我"，每队的 UAV 都该喂自己的 Bot。
// 计时器在队伍循环**外面**走一次：两个队同时开着 UAV 时按循环里各减一次会把节奏减半。
// 返回被报点的次数（判据读数）。
// 报点的目标表**每队建一次**，且用"最近者一次线性扫描"替代"每个 Bot 各 sort 一遍"
// （性能审查 N1/N3）：旧写法把 enemiesOf(t).filter(...) 放在 Bot 循环里，同队 8 个 Bot
// 就是 8 次相同的 filter + 8 次 sort，而排序只为取 tg[0] = 最近的一个。
// 最近者与稳定排序的首个最小值同序（严格 < 保留迭代序里的第一个最小），行为逐位一致。
export function uavHints(game, rules, state, dt, skipTeam, enemiesOf) {
  state.uavPing = (state.uavPing || 0) - dt;
  if (state.uavPing > 0) return 0;
  state.uavPing = 2.5;
  let hinted = 0;
  for (const t of ['A', 'B']) {
    if (t === skipTeam || !rules.uavActive(t)) continue;
    let tg = null;
    for (const b of game.bots) {
      if (b.team !== t || !b.alive) continue;
      if (!tg) {
        tg = [];
        for (const e of enemiesOf(t)) if (!(e.isPlayer && e.hasPerk && e.hasPerk('ghost'))) tg.push(e);
      }
      let best = null, bd = Infinity;
      for (const e of tg) {
        const d = e.pos.distanceTo(b.pos);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) continue;
      b.hint(best.pos);
      hinted++;
    }
  }
  return hinted;
}

// ---------- 击杀掉落武器 ----------
// 两端共用这一份（单机 MPMatch.onKill 与联机权威端 NetRoom.onKill 都调）：掉不掉（60%）、
// 掉多少弹药（半匣 + 一匣储备）全在这里。真人不掉枪（他自己的配装跟着重生走）——
// 与改造前 mp.js 里那句逐字同义。返回掉落物（调用方拿它编事件 / 挂模型），没掉返回 null。
export function maybeDropWeapon(game, victim) {
  if (!victim || victim.isPlayer || !victim.weaponId || !game || !game.spawnPickup) return null;
  if (rng.next() >= 0.6) return null;
  return game.spawnPickup(victim.weaponId, victim.att, victim.pos, Math.ceil(victim.stats.mag * 0.5), victim.stats.mag);
}

// ---------- 地上的枪：过期与拾取 ----------
// 这两条规则两端共用（单机在 Game.updatePickups、联机权威端在 NetRoom.step 都调），
// 常数只在这一处（1.3 m 自动补弹、1.8 m 换枪、30 秒过期）—— 抄两份的症状是
// "单机弯腰就能捡、联机要踩上去"，而没人会去量那两个距离。

// 时间走一格：到 30 秒的枪从场上收掉。返回被收掉的那些（调用方拆模型 / 编事件）。
// 每拍**只由一个人调**（联机是房间调，不是每个客户端各调）—— 否则 p.t 一拍走好几格。
// 返回值是**模块级复用**的同一个数组（性能审查 N3）：两个调用方（main.js:989 的
// updatePickups 与 server/room.mjs 的 pickupTick）都在同一次调用里同步消费它，
// 没有人把它留到下一拍 —— 曾经每拍无条件 new 一个空数组，没枪的时候也在分配。
const PICKUPS_GONE = [];
export function pickupsExpire(game, dt) {
  const out = PICKUPS_GONE;
  out.length = 0;
  for (let i = game.pickups.length - 1; i >= 0; i--) {
    const p = game.pickups[i];
    p.t += dt;
    if (p.t > 30) { out.push(p); game.pickups.splice(i, 1); }
  }
  return out;
}

// 一个人的拾取判定：同款走近自动补弹药，异款走近按 F 换枪（旧枪落地）。
// apply=false 时只算"身边有什么"（联机客户端用它画提示 —— 它不许自己改状态，
// 换没换成由权威端的事件说了算），为真时把弹药/换枪的变更当场做完。
// 返回 { near, ammo: [{p, add, reserve}], swap: {p, idx, st, old, reserve} | null }。
// 距离先行（性能审查 B3）：两档半径（补弹 1.3m、换枪 1.8m）都用**平方距离**比，
// 1.8m 之外的枪在查槽位（slots.find）之前就跳过 —— 满地是枪、人是空手时，
// 曾经每次调用都对每把枪白查一遍槽位。判定结果与逐字版本完全一致。
export function pickupAction(game, pl, inp, apply = true) {
  const out = { near: null, ammo: [], swap: null };
  if (!pl || !pl.alive) return out;
  let nd2 = 1.8 * 1.8;
  for (let i = game.pickups.length - 1; i >= 0; i--) {
    const p = game.pickups[i];
    const dx = p.pos.x - pl.pos.x, dz = p.pos.z - pl.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= 1.8 * 1.8) continue;         // 两档距离之外：两个分支都不可能命中
    const slot = pl.ws.slots.find(s => s.id === p.weaponId);
    if (slot) {
      if (d2 >= 1.3 * 1.3) continue;
      if (slot.reserve >= slot.stats.reserve * 2) continue;
      if (apply) {
        const add = Math.max(5, Math.floor((p.reserve ?? slot.stats.mag) * 0.5 + (p.mag || 0)));
        slot.reserve = Math.min(slot.stats.reserve * 2, slot.reserve + add);
        game.pickups.splice(i, 1);
        out.ammo.push({ p, add, reserve: slot.reserve });
      }
    } else if (d2 < nd2) { out.near = p; nd2 = d2; }
  }
  if (out.near && apply && inp && inp.interactPressed) {
    const p = out.near, ws = pl.ws, def = p.weaponId;
    const isSecondary = ['m1911', 'revolver', 'rpg'].includes(def);
    let idx = ws.cur;
    if (ws.slots.length > 1) idx = isSecondary ? 1 : 0;
    if (ws.slots[idx] && ws.slots[idx].stats.type === 'pistol' && !isSecondary && ws.cur === 0) idx = 0;
    const old = ws.slots[idx];
    const st = { id: def, att: p.att, camo: 'none' };
    ws.replaceSlot(idx, st, p.mag ?? undefined, p.reserve ?? undefined);
    const j = game.pickups.indexOf(p);
    if (j >= 0) game.pickups.splice(j, 1);
    out.swap = { p, idx, st, old, reserve: (ws.slots[idx] && ws.slots[idx].reserve) | 0 };
  }
  return out;
}

// ---------- 占领点（dom） ----------
// 同心双圈的占领力模型（半径/力度/涨速在 DOM_* 那组常量上）：内圈强圈每人 2 点力、
// 外圈弱圈每人 1 点力、不封顶（人数就是硬道理）；进度 = DOM_CAP_RATE × 占领力，
// 整体比旧式子（0.18+0.07×人数、3 人封顶）大幅放缓。两层共用同一道高度差 3m 的门槛
// （塔上/坡下不算进圈），两支队伍都有人在圈里就是僵持 —— 谁也不涨。空点的回退按
// DOM_CAP_DECAY/秒。每个据点 domScoreRate()/秒 的得分（挂归属不挂人；基础 0.3，
// 大房随当场总人数正相关）。
// 两端共用：
// 单机在 MPMatch.update、联机在 NetRoom.step 都调它。**只有状态与分数** —— 网格、
// 颜色、进度条、播报全归调用方（返回值告诉它们发生了什么、点里站着谁）。
// 返回 { caps: [{f, team, inRange}], flags: [{f, teams, cnt, inRange, capped}] }。
//
// 返回值是**模块级复用**的（性能审查 N3）：dom 房每拍调一次，曾经每拍分配
// out/cnt/inRange/teams/结果对象共十几个 —— 全在 60Hz 的 young-gen 里。两个调用方
// （js/mp.js:362 的进度条与 server/room.mjs:506 的换旗事件）都在同一次调用里同步消费，
// 没有人把返回值留到下一拍，所以按旗下标复用槽位是安全的；caps 条目罕见（只在换旗
// 那一拍出现），保持每次新分配。字段与旧版逐一同名同序，消费方一行不用改。
const FLAGS_OUT = { caps: [], flags: [] };
const FLAGS_POOL = [];
export function flagsTick(flags, rules, entities, dt) {
  const out = FLAGS_OUT;
  out.caps.length = 0;
  // 涨速整局每拍问一次规则内核（domScoreRate：基础 0.3，大房随当场总人数线性放大）。
  // 带一道形状守卫：flagsTick 是导出的，判据端可能拿裸对象当 rules —— 那种调用按
  // 基准速算，与旧版逐位一致。
  const rate = rules.domScoreRate ? rules.domScoreRate() : DOM_SCORE_PER_SEC;
  let fi = 0;
  for (const f of flags) {
    const slot = FLAGS_POOL[fi] || (FLAGS_POOL[fi] = { f: null, teams: [], cnt: {}, inRange: [], capped: null });
    slot.f = f; slot.capped = null;
    slot.teams.length = 0; slot.inRange.length = 0;
    const cnt = slot.cnt;
    for (const k in cnt) delete cnt[k];
    for (const e of entities) {
      if (!e.alive || !e.pos || e.targetable === false || e.isTurret) continue;
      // 两层同心圆共用一道高度门槛；cnt[team] 累的是**占领力**（内圈 2 / 外圈 1），
      // 不再是人数 —— 消费方只拿它判"有没有人在占"，别拿它数人头。
      const d = Math.hypot(e.pos.x - f.pos.x, e.pos.z - f.pos.z);
      if (Math.abs(e.pos.y - f.pos.y) >= 3) continue;
      if (d < DOM_RADIUS_STRONG) {
        cnt[e.team] = (cnt[e.team] || 0) + DOM_POWER_STRONG;
        slot.inRange.push(e);
      } else if (d < DOM_RADIUS_WEAK) {
        cnt[e.team] = (cnt[e.team] || 0) + DOM_POWER_WEAK;
        slot.inRange.push(e);
      }
    }
    const teams = slot.teams;
    for (const k in cnt) teams.push(k);
    let capped = null;
    if (teams.length === 1 && teams[0] !== f.owner) {
      const t = teams[0];
      if (f.capTeam !== t) { f.capTeam = t; f.prog = 0; }
      f.prog += dt * DOM_CAP_RATE * cnt[t];
      if (f.prog >= 1) {
        f.owner = t; f.prog = 0; f.capTeam = null;
        capped = t;
        out.caps.push({ f, team: t, inRange: slot.inRange });
      }
    } else if (teams.length !== 1) {
      if (f.capTeam && teams.length === 0) f.prog = Math.max(0, f.prog - dt * DOM_CAP_DECAY);
    }
    slot.capped = capped;
    // 得分挂在**旗**上不挂在人上：谁占着谁涨，涨速 = 上面问过的 rate（基础
    // DOM_SCORE_PER_SEC/秒/点，大房随当场总人数正相关 —— domScoreRate 那条注释）。
    // 单机联机同一条式子。
    if (f.owner) rules.addScore(f.owner, dt * rate);
    out.flags[fi++] = slot;
  }
  out.flags.length = fi;
  return out;
}

// ---------- 占领的波次复活（dom） ----------
// CD 按**阵营占有的据点个数**分档（domWaveCd / DOM_WAVE_BY_FLAGS）：占得越少补员越快。
// 基地与名下每个据点都是复活点、共用同一档 CD、各自独立循环 —— **不管有没有人排都照转**；
// 归零的那一拍把"排在该复活点的死者"整体交还给调用方部署 —— 一批一批。旗挂在
// f.spawnCd、每队基地挂在调用方给的 baseCd 对象（两者都由本函数独占、懒初始化；
// 档位变短时把剩余量**夹到新档** —— 丢了点的人不该空等旧的长 CD）。谁排在哪面旗是
// 调用方的账（服务端 = clients 的 spawnFlag + Bot 的 __spawnFlag；单机 = respawns 队列）。
// 返回值是**模块级复用**的（与 flagsTick 同款：dom 房每拍一次、60Hz，别留下分配）；
// 消费方同步读完即弃，不许留到下一拍。
const WAVE_OUT = { flags: [], bases: [] };
const WAVE_OWNED = {};
export function spawnWavesTick(flags, baseCd, dt) {
  const out = WAVE_OUT;
  out.flags.length = 0; out.bases.length = 0;
  const owned = WAVE_OWNED;
  for (const k in owned) delete owned[k];
  for (const f of flags) if (f.owner) owned[f.owner] = (owned[f.owner] || 0) + 1;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const cd = domWaveCd(f.owner ? owned[f.owner] : 0);
    f.spawnCd = (f.spawnCd == null ? cd : f.spawnCd) - dt;
    if (f.spawnCd > cd) f.spawnCd = cd;
    if (f.spawnCd <= 0) { f.spawnCd = cd; out.flags.push(i); }
  }
  if (baseCd) for (const team in baseCd) {
    const cd = domWaveCd(owned[team] || 0);
    baseCd[team] = (baseCd[team] == null ? cd : baseCd[team]) - dt;
    if (baseCd[team] > cd) baseCd[team] = cd;
    if (baseCd[team] <= 0) { baseCd[team] = cd; out.bases.push(team); }
  }
  return out;
}

// ---------- Bot 占点目标（dom，单机 MPMatch 与联机 NetRoom 共用） ----------
//
// 用户实测"bot 明明就在点旁边都不占点跑去打人"。两个病因：
//   ① 联机 NetRoom **根本没有 botGoal** —— js/ai.js:behave 问 game.mode.botGoal，
//      问不到就退回 world.randomWalkable() 乱逛，单机那一套占点目标只活在浏览器里；
//   ② 交战分支无条件压过一切 —— 目标一可见就走战斗走位，人被拉出圈，占领进度
//      永远攒不满（4.5m 圈、独占 4 秒才能占完，来回跑等于白站）。
// 修法分两层：选点内核在这里（本函数），"进了圈就不被远敌拉走"的驻守在
// js/ai.js（每帧问 domBotHoldFlag）。判圈口径与 flagsTick 一致再放宽 1.5m：
// 真正攒进度要站在 4.5m 内，4.5~6m 的圈边也算占点态 —— bot 会被驻守分支朝旗心
// 推进圈，而不是停在圈外装样子。高度差沿用 flagsTick 的 3m（塔上/坡下不算进圈）。
export function domBotHoldFlag(flags, x, y, z, team) {
  let best = null, bestD = 6;
  for (const f of flags) {
    if (f.owner === team) continue;
    const d = Math.hypot(x - f.pos.x, z - f.pos.z);
    if (d < bestD && Math.abs(y - f.pos.y) < 3) { best = f; bestD = d; }
  }
  return best;
}
export function domBotGoal(flags, x, y, z, team, rand) {
  // ① 已在圈内：钉住（hold=true，调用方只微调站位，不许换目标）。
  // ② 否则 85% 就近挑一个"本队还没占下"的点，15% 随机挑一个（错开人流）。
  // ③ 全占下了：回防最近的本队点（list 退回全旗）。
  const hold = domBotHoldFlag(flags, x, y, z, team);
  if (hold) return { f: hold, hold: true };
  let near = null, nearD = 1e9, owned = null, ownedD = 1e9;
  const open = [];
  for (const f of flags) {
    const d = Math.hypot(x - f.pos.x, z - f.pos.z);
    if (f.owner !== team) { open.push(f); if (d < nearD) { near = f; nearD = d; } }
    else if (d < ownedD) { owned = f; ownedD = d; }
  }
  if (near && rand() < 0.85) return { f: near, hold: false };
  const list = open.length ? open : flags;
  return { f: list[(rand() * list.length) | 0] || owned, hold: false };
}

// ---------- 出生位（dom/tdm 收口。单机 MPMatch 与联机 NetRoom 共用这一份选择） ----------
//
// 用户实测两条症状的根因都在这里：两端各自的 spawnPoint 往候选里掺全图随机可走点
// （js/mp.js 25% 概率掺 6 个、server/room.mjs 每拍掺 6 个），而"离敌人远"那把尺带
// 60m 饱和上限 —— 双丘 360m 的图上两队老家相距 ~314m，声明点与随机点**全部**夹成
// 60 分，胜负只剩噪声，于是随机点按个数比例胜出（6/13）。实测落点：单机每次出生
// 10.1% 落在既非基地也非据点的野地、0.9% 直接生在中立据点圈里；联机 40.9% / 3.1%
// （量具 test/spawn-audit.mjs）。
// 闸立在失效模式那一层，不立在语法那一层：
//   ① 落在"不归本队所有"的据点弱圈内 ⇒ 不合格。中立那半边等于白送一个点（flagsTick
//      弱圈占领力 1 × DOM_CAP_RATE 0.03 ⇒ 单人 33.3 秒占完，实测过），敌方那半边是把
//      人直接投进对面的驻守圈里 —— 而死亡画面的选点卡片只给了"基地 + 三面旗"，
//      这两种落点都不在该选项里。
//   ② 候选集本身由调用方收口（dom/tdm 只交声明点，ffa 才允许全图随机）—— 这一条
//      不在这里判，因为"有没有基地概念"是模式的事，不是几何的事。
// 全部候选都被 ① 闸掉时（小图把基地修在点旁边，例如 yard 三旗间距才 18m）退回
// 全体取最不坏的那一个 —— 宁可生在点旁边，也不许返回 undefined 把出生那一跳崩掉。
// 散位项是补"删掉随机点之后 7 个声明点全同分"的：不分开的话全队挤在同一格，一条
// 枪线/一发迫击炮带走一片，而旧写法正是靠那 6 个随机点歪打正着地把人摊开的。
export const SPAWN_AVOID_R = 60;    // 离敌人多远算"够远"。再远不加，免得出生点被推到地图对角
export const SPAWN_SPREAD_R = 20;   // 离同队最近的人多远算"散开"。超过不再加分
export const SPAWN_JITTER = 2;      // 噪声必须盖不过散位项，否则又变成抽签
export function spawnEligible(pos, team, flags) {
  if (!flags) return true;
  for (const f of flags) {
    if (f.owner === team) continue;
    if (Math.hypot(pos.x - f.pos.x, pos.z - f.pos.z) < DOM_RADIUS_WEAK) return false;
  }
  return true;
}
// foes/mates 由调用方筛好（活着的、有 pos 的、按队分开的），这里不再判形状。
export function spawnScore(pos, foes, mates) {
  let md = 1e9, ms = 1e9;
  for (const e of foes) { const d = Math.hypot(pos.x - e.pos.x, pos.z - e.pos.z); if (d < md) md = d; }
  for (const e of mates) { const d = Math.hypot(pos.x - e.pos.x, pos.z - e.pos.z); if (d < ms) ms = d; }
  return Math.min(md, SPAWN_AVOID_R) + Math.min(ms, SPAWN_SPREAD_R);
}
export function chooseSpawn(cands, team, foes, mates, flags, rand) {
  const passed = cands.filter(c => spawnEligible(c, team, flags));
  const pool = passed.length ? passed : cands;
  let best = pool[0], bs = -Infinity;
  for (const c of pool) {
    const s = spawnScore(c, foes, mates) + rand() * SPAWN_JITTER;
    if (s > bs) { bs = s; best = c; }
  }
  return best;
}

export { WORLD };
