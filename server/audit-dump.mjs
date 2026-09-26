// 审计表的读取口 —— 注册/登录/被拒的"谁、何时、从哪个 IP"都记在账号库的 audit 表里
// （写入侧见 server/accounts.mjs 的 _audit，写入契约见 server/store.mjs 文件头）。
//
// 用法（在**服务器上**对着账号库跑，不需要停服 —— WAL 模式下只读连接不影响写入）：
//
//   node server/audit-dump.mjs --db=/data/accounts.db            # 最近 50 条（默认）
//   node server/audit-dump.mjs --db=... --limit=500              # 最近 500 条
//   node server/audit-dump.mjs --db=... --name=Sneak             # 只看某个呼号
//   node server/audit-dump.mjs --db=... --ev=login:bad_credentials  # 只看某类事件（撞库现场）
//
// 为什么是**只读打开**：纠纷排查时最忌讳"看一眼现场把现场改了"。
// node:sqlite 的 open 选项里给 readonly，写坏了库比查不到记录更糟。
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const dbPath = arg('db', process.env.ACCOUNTS_DB || '');
if (!dbPath) {
  console.log('用法：node server/audit-dump.mjs --db=<账号库路径> [--limit=N] [--name=呼号] [--ev=事件]');
  console.log('      （ACCOUNTS_DB 环境变量设了的话可以省 --db）');
  process.exit(2);
}
const limit = arg('limit') ? (arg('limit') | 0) : 50;
const name = arg('name');
const ev = arg('ev');

let db;
try { db = new DatabaseSync(dbPath, { readOnly: true }); }
catch (e) { console.log(`打不开 ${dbPath}：${e.message}`); process.exit(1); }

let rows;
try {
  rows = db.prepare(
    `select t, ev, name, ip from audit
     where (${name ? 'name = ?' : '1'}) and (${ev ? 'ev = ?' : '1'})
     order by id desc limit ?`
  ).all(...(name ? [name] : []), ...(ev ? [ev] : []), limit);
} catch (e) {
  console.log(`audit 表读不出来（老库没有这张表？建表语句见 server/store.mjs）：${e.message}`);
  process.exit(1);
}

if (!rows.length) { console.log('（没有匹配的记录）'); process.exit(0); }
// 时间直接转成本地可读格式：排查纠纷的人不该再手搓一次 epoch 换算。
for (const r of rows) {
  const t = new Date(r.t).toISOString().replace('T', ' ').replace(/\..*/, '');
  console.log(`${t}  ${r.ev.padEnd(24)} ${r.ip.padEnd(16)} ${r.name}`);
}
console.log(`\n共 ${rows.length} 条（上限 ${limit}，新→旧）`);
