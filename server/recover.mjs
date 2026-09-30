// 服主给"忘了密码、也把恢复码弄丢了"的人发一叠新恢复码。
//
// 用法（在**服务器上**对着账号库跑）：
//
//   node server/recover.mjs --db=/data/accounts.db --name=Sneak
//   node server/recover.mjs --name=Sneak            # ACCOUNTS_DB 设了的话可以省 --db
//
// 它做三件事，只做这三件：
//   1. 给这个呼号发一叠新的恢复码（旧的那一叠随之作废），把**原文**打到你的终端上；
//   2. 往 audit 表写一行 `recover:cli_issued`（谁在什么时候给谁发过码）；
//   3. 退出。
//
// ── 它**不改密码**，这是有意的 ──
// 服主能做的因此是"给他一串只能用一次的码"，而不是"把密码改成我知道的那个"。
// 后者没有记录，而且让服主成为唯一知道密码的人 —— 那和"账号是本人的"这件事直接冲突。
//
// ── 为什么这是**留痕**而不是权限控制 ──
// 服主本来就能打开库直接改。所以这个脚本的价值不在"拦住服主"，而在把"给谁发过码"
// 变成一条查询得到的事实（`node server/audit-dump.mjs --db=... --ev=recover:cli_issued`）。
// 真出了纠纷，"谁在什么时候把码给了谁"就是全部证据。
//
// ── 代码从哪儿来、到哪儿去 ──
// 一堆新码的哈希写进 meta 抽屉（见 accounts.mjs 的 recoveryMetaKey），原文只出现在
// 下面这几行 stdout 里，本脚本**不写任何日志文件**。念给本人之后就没了 ——
// 所以别把它贴进公开频道、别留在聊天记录里，也别忘了它只能用一次。
import { DatabaseSync } from 'node:sqlite';
import { Accounts, SCRYPT } from './accounts.mjs';
import { SqliteStore } from './store.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const dbPath = arg('db', process.env.ACCOUNTS_DB || '');
const name = arg('name', '');

if (!dbPath || !name) {
  console.log('用法：node server/recover.mjs --db=<账号库路径> --name=<呼号>');
  console.log('      （ACCOUNTS_DB 环境变量设了的话可以省 --db）');
  process.exit(2);
}

// 这里是**可写**打开（audit-dump 是只读）：要写 meta 和 audit 两张表。
// 服务正在跑也可以执行 —— meta 与 audit 都是直写，运行中的那个进程下一次读就能看到
//（会话/档案走批刷，而恢复码刻意不走那条路，理由见 accounts.mjs）。
// 代价是同一时刻只允许一个写者：撞上 SQLITE_BUSY 就重跑一次。
let store;
try { store = new SqliteStore({ file: dbPath, DatabaseSync }); }
catch (e) { console.log(`打不开 ${dbPath}：${e.message}`); process.exit(1); }

let out;
try {
  // 用**生产参数**（SCRYPT），不是测试那套低配：这几张码要在真正跑着的那个进程里被验证，
  // 而验证用的是码自己带着的参数 —— 两边必须同源（见 accounts.mjs 的 verifyPassword）。
  const accounts = new Accounts({ store, scrypt: SCRYPT });
  out = await accounts.issueRecovery({ name, ip: 'cli:' + (process.env.USERNAME || process.env.USER || '?') });
} finally {
  // 一定要收干净：SqliteStore 有定时器和 WAL 文件，进程走人时留个半截库是最糟的结局。
  try { store.close(); } catch { /* close 里的失败不该盖住上面的结果 */ }
}

if (!out || !out.ok) {
  const why = out && out.error === 'no_user'
    ? `这个库里没有呼号「${name}」（呼号是唯一的，注意大小写不敏感但别抄错字）—— 让他先注册。`
    : '发码失败（服务端线程池忙）。过一会儿重跑一次。';
  console.log(why);
  process.exit(1);
}

console.log(`呼号 ${out.name} 的一次性恢复码（旧的那一叠已经作废）：\n`);
for (const c of out.recovery) console.log('    ' + c);
console.log(`
怎么用（把下面这段一起念给本人）：
  1. 打开游戏 → 联网对战 → 登录/注册 那一屏 → 点「忘了密码？」；
  2. 填呼号，把上面**任意一张**码填进恢复码那一栏，再填一个新密码；
  3. 提交。用掉的那一张立刻失效，其余的一起作废，同时会发一叠新的（只显示那一次，记得抄）。

别贴进公开频道，也别留在聊天记录里 —— 它就是密码。`);
