// 档案里的经验值为什么必须分成两半（缺口原文：「战役的经验值被账号覆盖」）
//
// 账号那份是**服务端算的**：联机的每一局由权威 sim 自己结算，`server/room.mjs` 把
// `score + 胜负分`交给 `accounts.addResult`，`/api/me` 再把它发回来。
// 本地那份是**玩家自己机器上算的**：战役结算（1500 + 击杀 ×50）、单机对局（score + 胜负分）、
// 以及访客在联机里打完的那一局（他没有服务端档案可写）。
//
// 两半曾经挤在同一个 `xp` 字段里，于是每一次账号同步（登录、进主菜单按需问一次 /api/me）
// 都会把本地算出来的那部分**盖成服务端那个数** —— 打完一整场战役、回主菜单，经验条原封不动，
// 而且不报错、不崩，所以没人发现。所以这里不是"调一下同步顺序"，而是把两个来源分开存：
//
//   服务端那份：`applyAccountXp`（同步就是同步，只写 xp，不碰本地那份）
//                `addAccountXp`（登录玩家在联机里的那一局：先按本地那条式子记上，
//                                下一次 /api/me 拿服务端的数确认 —— 服务端也会记同一笔）
//   本地那份：  `addLocalXp`（战役 / 单机 / 访客联机，只写 xpLocal，谁都盖不掉）
//
// 等级按**两半之和**算（菜单档案卡与结算面板）。联机记分板上那一列等级是服务端自报的 xp，
// 只有一个来源、不混 —— 在"本地也挣过"的档案上两个数会不一样，这是有意的：
// 那份经验确实存在，只是没进账号。判据与反证臂见 `test/progress.mjs`。

export const MAX_LEVEL = 55;

// 存档（mf_profile）是玩家能自己编辑的文件：里面可能是一个字符串、NaN、Infinity、小数，
// 或者整个字段都不在（老存档，那时候还没有 xpLocal）。三样都得算成一个**非负整数**，
// 不能让一个 NaN 一路飘到 innerHTML 上（症状是档案卡写着"等级 NaN · NaN XP"）。
// 这里**不用 `| 0`**：它对超过 2^31 的数是回绕的（1e12 会变成负数，于是被当成 0），
// 而"手改过一个天文数字"正是这一格要挡住的输入之一 —— 该封顶的是等级，不是经验本身。
const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
export const xpOf = (p) => num(p && p.xp);
export const localXpOf = (p) => num(p && p.xpLocal);
export const totalXp = (p) => xpOf(p) + localXpOf(p);

export const levelOf = (xp) => Math.min(MAX_LEVEL, Math.floor(Math.sqrt(num(xp) / 300)) + 1);

// 两格都过一遍这道清洗。放在三个写入口里，是为了让"跑过任何一个写入口的档案"都是
// 良构的（两格都在、都是非负整数）—— 不然 `{xp: 900}` 这种档案在写入口跑过之后
// 仍然没有 xpLocal 这一格，而读的地方到处都要自己防一次 undefined。
const normalize = (p) => { p.xp = xpOf(p); p.xpLocal = localXpOf(p); return p; };

// 本地那一半：只增不减（负数当 0 —— "扣经验"这个功能不存在，别让一次手滑把档案变成负数）。
export function addLocalXp(p, n) { normalize(p); p.xpLocal = Math.max(0, p.xpLocal + num(n)); return p.xpLocal; }
export function addAccountXp(p, n) { normalize(p); p.xp = Math.max(0, p.xp + num(n)); return p.xp; }

// 服务端那份的**唯一**落地口。它只写 xp：本地那一半在这儿是绝不参与的
// —— 之前那条覆盖路径正是"两半共用一个字段"的下场。
export function applyAccountXp(p, serverXp) { normalize(p); p.xp = num(serverXp); return p.xp; }

// 档案卡上那一行。两半分开写出来，是为了让"本地这些为什么不进账号"在界面上就有答案；
// 访客没有账号那一半，就别画一个恒 0 的"账号 0 XP"。
export function xpText(p, hasAccount) {
  const a = xpOf(p), l = localXpOf(p), lv = levelOf(a + l);
  return hasAccount
    ? `等级 ${lv} · 账号 ${a} XP · 本地 ${l} XP（本地不计入账号）`
    : `等级 ${lv} · 本地 ${l} XP`;
}
