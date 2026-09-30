// 档案里的经验值分两半（缺口原文：「战役的经验值被账号覆盖」）。
//
// 这个缺口的形状与其他缺口不同，值得先说清楚，因为它决定这份判据量什么：
// **它不报错、不崩、也不变慢**。玩家打完一整场战役（1500 + 击杀 ×50），回主菜单，
// 经验条原封不动 —— 甚至看不出"少了"，因为那个数本来就不该出现在账号里。
// 唯一的症状是"我明明打过一整场战役"。所以：
//
//   1. 一半的判据量**两半各写各的**：账号同步只许动 xp，本地那一笔只许动 xpLocal。
//      判别臂是"同步之后本地那一笔还在，且等级按两半之和算" —— 把两半折回一个字段的
//      实现会当场红（那种实现下 xpLocal 要么恒 0，要么被服务端那个数盖掉）。
//   2. 另一半**只能审计源码**：写档案的四条路径（战役 / 单机 / 联机 / 账号同步）分布在
//      四个文件里，跑一遍真游戏才能碰到其中两条，而"哪天有人又写一句 profile.xp +="
//      这种回归没有任何运行时症状。所以这里把 js/ 扫一遍：除了 js/progress.mjs，
//      不许再有任何一处直接写 .xp。这条审计自己也有一条反证臂（喂一行假的，必须点名）。
//
// 判"这份测试有没有红"看退出码与结论行，不要 grep 正文里的关键词。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  levelOf, xpOf, localXpOf, totalXp, addLocalXp, addAccountXp, applyAccountXp, xpText, MAX_LEVEL,
} from '../js/progress.mjs';

let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  |  ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  |  ' + detail : ''}`);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 源码审计：js/ 下谁在写 .xp ──
// 命中形如 `profile.xp =` / `.xp +=`；`xpLocal` 不在其中（`.xp` 后面跟的是 L，不是等号）。
// 只跳过**整行都是注释**的那种（注释写不动档案），带尾注释的代码行照扫。
const XP_WRITE = /\.xp\s*[+\-*/]?=/;
export function xpWriters(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (XP_WRITE.test(line)) out.push(i + 1);
  });
  return out;
}
function jsFiles(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) jsFiles(p, acc);
    else if (/\.(js|mjs)$/.test(e)) acc.push(p);
  }
  return acc;
}

// ── 1. 先决：老存档（根本没有 xpLocal 这个字段）也不能算出 NaN ──
// 这一条是下面全部判据的底座：浏览器里现存的每一份 mf_profile 都是老存档。
{
  const old = { xp: 1200 };
  chk(xpOf(old) === 1200 && totalXp(old) === 1200 && levelOf(totalXp(old)) === 3,
    'A1【先决】老存档（只有 xp 那一格）读出来仍是它自己：总数 1200、等级 3',
    `total=${totalXp(old)} lv=${levelOf(totalXp(old))}`);
  chk(totalXp({}) === 0 && levelOf(totalXp({})) === 1,
    'A2【先决】空档案 = 0 经验、1 级（不是 NaN 级）', `lv=${levelOf(totalXp({}))}`);
  const junk = { xp: 'abc', xpLocal: NaN };
  chk(totalXp(junk) === 0 && levelOf(totalXp(junk)) === 1 && levelOf(NaN) === 1 && levelOf(-5) === 1,
    'A3【反证】被手改坏的存档（字符串、NaN、负数）都当 0 —— 不能让一个 NaN 飘到档案卡上',
    `total=${totalXp(junk)} lv=${levelOf(totalXp(junk))}`);
  chk(levelOf(1e12) === MAX_LEVEL,
    `A4【边界】等级封顶 ${MAX_LEVEL}（一个手改的天文数字不会画出第 9 万级）`, `lv=${levelOf(1e12)}`);
}

// ── 2. 判别臂：账号同步只写账号那一半 ──
// 这就是缺口的形状本身：同步（登录 / 进主菜单问一次 /api/me）之后，本地那一笔必须**还在**。
{
  const p = { xp: 0, xpLocal: 3600 };
  applyAccountXp(p, 1200);
  chk(p.xp === 1200 && p.xpLocal === 3600 && totalXp(p) === 4800,
    'B1【判别臂】账号同步之后：账号那一半 = 服务端的数，本地那一半原封不动',
    `xp=${p.xp} xpLocal=${p.xpLocal} total=${totalXp(p)}`);
  // 反证的方向：如果哪天又把两半折回一个字段，上面那条会红成 xpLocal=0 / total=1200。
  const folded = { xp: 0 }; applyAccountXp(folded, 1200);
  addLocalXp(folded, 3600); applyAccountXp(folded, 1200);
  chk(totalXp(folded) === 4800 && folded.xp === 1200,
    'B2【反证臂】同一串操作换成"先本地后同步"的**顺序**也一样：同步不吞本地那一笔',
    `xp=${folded.xp} xpLocal=${folded.xpLocal}`);
  const q = { xp: 900 };
  applyAccountXp(q, 500);
  chk(q.xp === 500,
    'B3 服务端的数往下走时照写（同步是同步，不是"取大值"）', `xp=${q.xp}`);
  const r = { xp: 900, xpLocal: 300 };
  applyAccountXp(r, NaN);
  chk(r.xp === 0 && r.xpLocal === 300,
    'B4【反证】服务端给不出数（NaN）时不清本地那一笔 —— 也不能留一个 NaN 在档案里',
    `xp=${r.xp} xpLocal=${r.xpLocal}`);
}

// ── 3. 判别臂：战役 / 单机 / 访客联机走本地那一半，且等级按两半之和 ──
// 这三个数是各自的真实式子：战役 = 1500 + 击杀 ×50（12 杀 ⇒ 2100）、
// 单机 = score + (胜 ? 500 : 150)、访客联机 = 同一条式的联机版。
{
  const p = { xp: 1200 };
  addLocalXp(p, 1500 + 12 * 50);                    // 战役 12 杀
  chk(p.xpLocal === 2100 && p.xp === 1200,
    'C1 战役结算（1500 + 12 杀 ×50 = 2100）进本地那一半，账号那一半不动',
    `xp=${p.xp} xpLocal=${p.xpLocal}`);
  const before = levelOf(p.xp);
  applyAccountXp(p, 1200);                          // 紧接着回主菜单同步一次
  chk(p.xpLocal === 2100 && totalXp(p) === 3300 && levelOf(totalXp(p)) === before + 1,
    'C2【判别臂】同步之后那一笔还在，且等级按两半之和升了一级（只按账号算的话这一步不动）',
    `xp=${p.xp} xpLocal=${p.xpLocal} lv ${before}→${levelOf(totalXp(p))}`);
  addLocalXp(p, -99999);
  chk(p.xpLocal === 2100,
    'C3【反证】负的奖励当 0（只增不减："扣经验"这个功能不存在，一次手滑不该把档案减掉）', `xpLocal=${p.xpLocal}`);
  const g = { xp: 0 };
  addAccountXp(g, 300);
  chk(g.xp === 300 && g.xpLocal === 0,
    'C4 登录玩家在联机里那一局记在账号那一半（服务端也会记同一笔，同步时确认）',
    `xp=${g.xp} xpLocal=${g.xpLocal}`);
  addLocalXp(g, 300);
  chk(g.xp === 300 && g.xpLocal === 300 && totalXp(g) === 600,
    'C5【判别臂】访客走的是另一条路：同一笔记在本地那一半 —— 他哪天注册了也不会被盖掉',
    `xp=${g.xp} xpLocal=${g.xpLocal}`);
}

// ── 4. 档案卡那一行：两半都写出来，访客不画一个恒 0 的"账号" ──
{
  const p = { xp: 1200, xpLocal: 2100 };
  const a = xpText(p, true), b = xpText(p, false);
  chk(/等级 4/.test(a) && /账号 1200 XP/.test(a) && /本地 2100 XP/.test(a) && /不计入账号/.test(a),
    'D1 登录玩家的档案卡：等级 4（两半之和）· 账号 1200 · 本地 2100，并写明本地不计入账号', a);
  chk(!/账号/.test(b) && /等级 4/.test(b) && /本地 2100 XP/.test(b),
    'D2 访客的档案卡不出现"账号"那一格（恒 0 的一格只会让人以为数据丢了）', b);
  chk(/等级 1 /.test(xpText({}, true)),
    'D3【反证】空档案那一行也画得出来（两半都没有时是 1 级）', xpText({}, true));
}

// ── 5. 源码审计：写档案的四条路径必须各走各的入口 ──
// 这一段量的是"运行时看不见的回归"：谁再写一句 profile.xp +=，没有任何测试会红。
{
  const files = jsFiles(join(ROOT, 'js'));
  const allowed = 'js/progress.mjs';   // 这一份就是那四个入口自己（见上面的 normalize / add*）
  const hits = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (rel === allowed) continue;
    for (const ln of xpWriters(readFileSync(f, 'utf8'))) hits.push(`${rel}:${ln}`);
  }
  const own = xpWriters(readFileSync(join(ROOT, allowed), 'utf8'));
  chk(files.length > 30, 'E1【先决】真的扫到了 js/ 那一棵树（不然下面那条是空过）', `${files.length} 个文件`);
  chk(own.length >= 3,
    'E2【先决】被豁免的那一份里**确实**在写这两格（豁免的不是一个空文件）', `${allowed} 命中 ${own.length} 处`);
  chk(hits.length === 0,
    'E3 js/ 下除 js/progress.mjs 外没有任何一处直接写 .xp（四条路径各走各的入口）', hits.join(' ') || '无');
  const want = { 'js/campaign.js': 'addLocalXp', 'js/mp.js': 'addLocalXp', 'js/net/client.mjs': 'addLocalXp', 'js/main.js': 'applyAccountXp', 'js/menu.js': 'applyAccountXp' };
  const missing = Object.entries(want).filter(([f, fn]) => !readFileSync(join(ROOT, f), 'utf8').includes(fn)).map(([f]) => f);
  chk(missing.length === 0,
    'E4 每一处都接着那个入口（战役 / 单机 / 联机读 addLocalXp，账号同步读 applyAccountXp）', missing.join(' ') || '齐');
  // 审计自身的反证臂：喂一行假写法，必须点名 —— 不然 E3 只是一条恒绿的 grep。
  chk(JSON.stringify(xpWriters('let a = 1;\ngame.profile.xp += 2000;  // 顺手加一笔\n')) === '[2]'
    && JSON.stringify(xpWriters('// game.profile.xp += 2000;\n')) === '[]'
    && JSON.stringify(xpWriters('addLocalXp(game.profile, 2100);\n')) === '[]'
    && JSON.stringify(xpWriters('p.xpLocal = 5;\n')) === '[]',
    'E5【反证臂 E⁻】假写法点名、注释行与 addLocalXp / xpLocal 不误报（这条审计能红）',
    JSON.stringify(xpWriters('let a = 1;\ngame.profile.xp += 2000;\n')));
}

console.log('');
if (fails) { console.log(`RED  ${checks - fails}/${checks} 通过，${fails} 条失败`); process.exit(1); }
console.log(`GREEN  档案经验值（账号 / 本地两半）：${checks}/${checks} 通过`);
