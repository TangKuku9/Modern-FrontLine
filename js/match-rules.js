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
export class MatchRules {
  constructor(cfg = {}) {
    const mode = cfg.mode || 'tdm';
    this.ffa = mode === 'ffa';
    this.mode = mode;
    this.scoreLimit = cfg.scoreLimit || (mode === 'dom' ? 200 : mode === 'ffa' ? 25 : 50);
    this.timeLimit = cfg.timeLimit || 10;         // 分钟
    this.scores = { A: 0, B: 0 };
    this.uav = new Map();                          // team -> 剩余拍
    this.wpTicks = 0;
    this.clock = new TickClock();
    this.tick = 0;
    this.over = null;                              // { winner, tick }
    this.firstBlood = false;
    this.lastKillTicks = [];                       // 连杀奖章（双杀/三杀…）用的最近击杀拍号
    // 判据要能区分"规则没接上"与"规则接上了但没触发"：这两个计数就是那个分界。
    this.kills = 0; this.charged = 0; this.calls = 0;
  }

  // 每拍调一次（必须与权威端的 tick 同一个节拍 —— 差一拍不会报错，只会让 UAV
  // 比屏幕上的计时器早/晚一秒消失）。
  step() {
    this.tick++;
    this.clock.step(1);
    if (this.wpTicks > 0) this.wpTicks--;
    for (const [t, n] of [...this.uav]) {
      if (n - 1 > 0) this.uav.set(t, n - 1); else this.uav.delete(t);
    }
  }

  uavStart(team, ticks = UAV_SECONDS * 60) { this.uav.set(team, Math.max(1, Math.round(ticks))); }
  uavActive(team) { return (this.uav.get(team) || 0) > 0; }
  uavLeft(team) { return this.uav.get(team) || 0; }

  // 连杀奖章窗口（双杀/三杀…）。窗口按**拍**而不是秒：秒基的窗口在权威端要读
  // game.time，而 game.time 与 tick 在权威端是同一件事的两种写法，多一个就多一处漂移。
  killChain(ticks = 4 * 60) {
    this.lastKillTicks = this.lastKillTicks.filter(t => this.tick - t < ticks);
    this.lastKillTicks.push(this.tick);
    return this.lastKillTicks.length;
  }

  addScore(team, v) { this.scores[team] = (this.scores[team] || 0) + v; }

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
      if (this.ffa) return null;
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
    if (this.uavActive('A')) f |= WORLD.UAV;
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
// 联机不发奖章弹窗、单机发，那是表现层的差别，不是规则的差别。
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

export { WORLD };
