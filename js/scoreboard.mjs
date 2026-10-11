// 记分板的**表形状**（HU-16）。列序、表头、单元格口径、行样式只有这一份：
// 单机 `MPMatch.scoreboardHTML` 与联机 `NetClient.scoreboardHTML` 各自把数据源
// 映射成 entries 交进来，两端不再各拼一遍 `<tr>`。
//
// ── 为什么值得单独一个模块 ──
// 收成一份之前，同一个"这局谁打得好吗"的问题在两台机器上有两套答案：单机把名次塞在
// 名字格里（`1. 张三`）、别人的助攻恒 `'-'`、没有网络行；联机有独立的 `#` 列、真助攻、
// 底部一行 ping。玩家换一端玩就得重学一次表怎么读，而"两端逐字同形"是本仓库的既有纪律
// （`js/match-rules.js` 是规则内核的同一份，这里就是表形状的同一份）。
//
// 更要紧的是**列一多就会漏**：K/D 与占领这两列补进来的时候，两份拼接代码意味着
// 一次改动要记得改两个地方，而忘了的那个不会报错 —— 症状只是"单机好像少一列"。
//
// ── `'-'` 与 `0` 是两件事 ──
// `0` 是"这一局他确实没抓过点"，`'-'` 是"这一端根本没有这本账"。把没有测量源的那一格
// 写成 0 就是 HU-08 那一族病（界面上印一个量不出来的数）。所以调用方交 `null`/`undefined`
// 就落 `'-'`，判据 S3 钉的就是这条。
// 眼下真没有账本的两处：**单机的 Bot 助攻**（`js/ai.js:57` 建了 captures 却没建 assists，
// 补它要在 `js/mp.js:330` 那条伤害记账上加分支 = 规则侧），以及**联机的占领数**
// （`server/room.mjs:662` 只给 `score += 200`，没有计数；补它 = 账本 + 协议字段，同样越界）。
//
// 列**不按数据源增减**：两端各画几列就是 HU-16 的病根本身（换一端玩要重学一次表怎么读），
// 而"这一列在这一端没账"这件事由那一格的 `'-'` 说，不由整列消失说 —— 列突然少了，
// 读起来像数据没了。判据 S1 量的就是两端表头逐格相等。
//
// ── 判据 ──
// test/hud-ux.mjs S 段：两端的 entries 喂进同一个函数、表头与每行列数逐格相等、
// `null` 落 `'-'` 不落 `0`、呼号里的标签进 DOM 之前转义（联机那一条本来是 M10 的判据，
// 这里收进共用处）、榜首那一枚标写"榜首"不写"MVP"（V3）。
import { escHtml } from './escape.js';

// 列的顺序就是屏幕上从左到右的顺序。`cell` 拿到的是行对象，返回**已经可以拼进去的字符串**。
export const SB_COLS = [
  { k: 'rank', h: '#', cell: e => (e.rank > 0 ? e.rank : '') },
  { k: 'name', h: '名字', cell: e => escHtml(e.name) + (e.mvp ? '<i class="sb-mvp">榜首</i>' : '') },
  { k: 'score', h: '得分', cell: e => sbNum(e.s) },
  { k: 'kills', h: '击杀', cell: e => sbNum(e.k) },
  { k: 'deaths', h: '死亡', cell: e => sbNum(e.d) },
  // K/D 与结算面板同一把尺（`js/mp.js:end` / `js/net/client.mjs:showResults` 都是
  // `(k / Math.max(1, d)).toFixed(2)`）：同一屏里记分板与结算各说一个数就是 HU-38 那个病。
  { k: 'kd', h: 'K/D', cell: e => (Number.isFinite(e.k) && Number.isFinite(e.d) ? (e.k / Math.max(1, e.d)).toFixed(2) : '-') },
  { k: 'assists', h: '助攻', cell: e => sbNum(e.a) },
  { k: 'captures', h: '占领', cell: e => sbNum(e.c) },
];

// 没这本账 ⇒ `'-'`；有 ⇒ 整数。NaN/undefined/null 三条都落 `'-'`，不靠调用方记得传对。
export function sbNum(v) {
  return Number.isFinite(v) ? Math.round(v) : '-';
}

// 一组 = 一张表。`label` 写进"名字"那一列的表头（队伍名 + 比分，或"自由混战"）。
export function scoreboardTable({ label = '', cls = 'A', entries = [] } = {}) {
  const head = '<tr>' + SB_COLS.map(c => `<th${c.k === 'name' ? ' class="sb-lb"' : ''}>${c.k === 'name' ? escHtml(label) : c.h}</th>`).join('') + '</tr>';
  const rows = entries.map((e, i) => `<tr class="${e.me ? 'me ' : ''}${e.alive === false ? 'dead' : ''}">`
    + SB_COLS.map(c => `<td>${c.cell(e, i)}</td>`).join('') + '</tr>').join('');
  return `<table class="sbt ${cls}">${head}${rows}</table>`;
}

// 多组 + 两端各自的前后脚注（联机的网络状态行与大房点名在后；单机两头都空）。
// 脚注留在调用方：那是**各端独有的数据源**，不是表形状。
export function scoreboardTables(groups, { pre = '', post = '' } = {}) {
  return pre + (groups || []).map(g => scoreboardTable(g)).join('') + post;
}
