// 空跑窗残差判据的那把尺子（附十四立过账的那条，第 10 轮收口）。
//
// 背景：`js/net/client.mjs` 在每个空跑窗（服务端跑了我没供上输入的拍）里量
// "补偿做完之后还剩多少残差"，判据形状是"残差必须小于一拍位移" —— 补偿漏了，
// 残差恰好等于 deficit 拍的位移，怎么抖都跨得过尺子；补偿到位，残差只剩量化噪声。
// 尺子取"日记本里相邻两拍的距离"（我自己走的，和判据无关），取不到（窗口太短）
// 就退回速度换算。
//
// 为什么裸尺子不行：**站着不动的时候它退到噪声上**。静止时相邻两拍的距离只剩
// 物理余颤（实测 ~0.0004 m），而权威位置本身带 ±POS_STEP/2 的量化（两轴最坏
// ≈ 0.7 mm，实测残差 2~4 mm）—— 于是 2~4 mm 的纯量化噪声就够"超尺子"，
// net-play 那格 `foldBad === 0` 表现为假红。附十四立账时定的修法就是两条：
// 给静止格一个**下限**，同时配"走动的窗口仍按自己的步长量"的族群臂
// （test/net-feel.mjs AA 段），否则下限一放大，尺子就成了恒真。
//
// 下限取 2×POS_STEP，两头都有约束：
//   · 必须高于量化噪声 —— 两轴最坏 √2×0.5 ≈ 0.71 mm，观测 2~4 mm，2 cm 有 5 倍余量；
//   · 必须远低于任何一次真实漏补 —— 漏 1 拍 ≥ 最低走速一拍 ≈ 7.4 cm，2 cm 在它下面 3.7 倍。
// 静止时"漏补一拍"的位移本来就是零 —— 没有可被下限漏掉的真信号，这是它不亏的根据。
import { POS_STEP } from '../quant.js';

export const IDLE_FLOOR = POS_STEP * 2;

// 判一格空跑窗。corrected = 这一窗补偿后的残差；stepMeasured = 日记本里相邻两拍的
// 距离（可能为 null：窗口太短）；speed = 我自己的水平速度（m/s），走退路用。
// 返回 { step, ruler, bad, floored }：
//   step    尺子的原始取值（实测步长，或 速度/60）
//   ruler   判决真用的尺子 = max(step, IDLE_FLOOR)
//   bad     残差超尺子 ⇒ 这一窗记一笔 foldBad
//   floored 尺子是被下限托起来的（静止/极慢）⇒ 客户端记 foldFloor，
//           报表分得开"哪几格是自己的步长在量、哪几格靠下限" —— 下限不许悄悄变成恒真
// tickHz = 服务端的**拍频**。不许写死 60 —— 它是协议里的一格（client 从快照流里量到，
// 见 js/net/client.mjs:onSnapshot 的 tickHz），写死的话服务端拍频一改这把退路尺子就静默失准；
// 而退路那一支只在"窗口太短、量不到实测步长"的少数样本上生效，失准连读数都看不出来。
export function foldJudge({ corrected, stepMeasured = null, speed = 0, tickHz = 60 } = {}) {
  const hasStep = stepMeasured !== null && stepMeasured !== undefined && Number.isFinite(stepMeasured);
  const hz = Number.isFinite(tickHz) && tickHz > 0 ? tickHz : 60;
  const step = hasStep ? stepMeasured : (Number.isFinite(speed) ? speed : 0) / hz;
  const ruler = Math.max(step, IDLE_FLOOR);
  // 判决用**非**严格大于：残差恰好等于一拍位移，正是"漏补一拍"这个形状本身。
  // 严格大于的话，残差与实测步长各自都带量化噪声，落在相等那一侧的样本一律报绿 ——
  // 而那正是**假绿**方向（这一条是附十九里低危账点名的那格）。
  //
  // 余量很薄，**不能**靠再收紧阈值来加强：实测残差（0.03~0.22 m）与一拍位移是同一个
  // 量级，阈值一往下挪就会把正常窗判红（恒红），而不是把漏补抓出来。要让"单拍漏补"
  // 变成稳健判据，得先把残差本身降下来 —— 记在 docs/net-vs-local-gaps.md 的低危账上。
  return { step, ruler, hz, bad: corrected >= ruler, floored: step < IDLE_FLOOR };
}
