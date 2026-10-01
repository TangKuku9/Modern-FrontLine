// 两台进程共用同一个 ACCOUNTS_DB：探针（不进 npm test —— 它按设计就是红的）。
//
// 附十四立账的原话："现有账号判据全是单进程的；同一个库文件只在'杀一台再起一台'这个
// 顺序里用过。SQLite 自己怎么处理并发写 ≠ 我们这套读改写并发下是对的。" 这一轮把探针
// 写出来跑了，结论比猜的更根本 —— 红不在"并发写竞态"那一层，在**账本本身**：
//
//   SqliteStore 是"开库载入一次 + 读全走内存 Map + 写攒批 250ms 刷盘"的**进程私有账本**
//   （server/store.mjs 文件头写了为什么：60Hz 的 tick 里一次磁盘访问都不许有）。
//   于是两个进程共用一个库文件时：库文件是共享的，**活进程的读数不是** ——
//   P1 注册的人，P2 在重启之前根本看不见；同名并发注册两边都查不到人、两边都成功。
//
// 五个场景。"账上"指 docs/net-vs-local-gaps.md 附十五记下的现状；探针判的是"实测与账一致"：
//   S1  跨进程可见性（活进程）：P1 注册 → P2 登录     应该成立；账上记红，实测就是红
//   S1b 跨进程可见性（重启后）：P2 重启 → P2 登录     对照臂：库本身共享；账上记绿
//   S2  同名并发注册（两台同时）                      应该恰好一个成功；账上记红
//   S3  两张不同的码并发重设（两台同时）              应该恰好一张成功；账上记红
//   S4  两张不同的码并发重设（同一台）                对照臂：进程内 TOCTOU 第 10 轮已修
//                                                     （判据 test/accounts.mjs L 段）；账上记绿
//
// 退出码：实测与账全部一致 ⇒ 0（账没变）；任何一格与账不符 ⇒ 1 ——
// 那说明账过期了（比如哪一轮真把跨进程架构收了，S1/S2/S3 转绿），先改
// docs/net-vs-local-gaps.md 附十五、把这份探针升格成判据，再谈别的。
//
// 用法：node server/multi-account-probe.mjs
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const INVITE = 'PROBE-INVITE';
const PW = 'probe-password-1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 与 test/with-server.mjs 同一面（0.0.0.0）的端口探测 —— 那边踩过的坑不重踩。
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function boot(port, dbFile) {
  const proc = spawn(process.execPath, ['server/net-server.mjs', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, JOIN_CODE: INVITE, ACCOUNTS_DB: dbFile, HOST: '127.0.0.1' },
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 240 && !log.includes('权威对局服务'); i++) await sleep(50);
  if (!log.includes('权威对局服务')) { proc.kill(); throw new Error('临时服务没起来：\n' + log); }
  return {
    port, proc, base: `http://127.0.0.1:${port}`, log: () => log,
    exited: new Promise(res => proc.on('exit', () => res())),
    kill: () => { try { proc.kill(); } catch { /* 已经自己退了 */ } },
  };
}

async function api(base, path, body) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON 的失败也当读数 */ }
  return { status: r.status, json: json || {} };
}

let mismatches = 0;
// ledgerPass = 附十五里记下的"这一格现在该是什么样"——红就是红，不粉饰。
// 实测与账一致 ⇒ 打勾；不一致 ⇒ 记一笔（退出码 1）：说明账过期了，先改附十五再谈别的。
function judge(name, ledgerPass, actualPass, detail) {
  const agree = ledgerPass === actualPass;
  if (!agree) mismatches++;
  console.log(`  ${name}`);
  console.log(`    账上：${ledgerPass ? '绿' : '红（立账在案）'}   实测：${actualPass ? '绿' : '红'}   ⇒ ${agree ? '与账一致' : '与账不符!'}`);
  if (detail) console.log(`    ${detail}`);
}
const cnt = rs => `${rs.filter(r => r.json.ok).length}/${rs.length} 成功（${rs.map(r => r.json.ok ? 'ok' : r.json.error || r.status).join(' / ')}）`;

console.log('── 两台进程共用同一个 ACCOUNTS_DB（探针 · 附十四/附十五那条账）──\n');
const dbFile = join(tmpdir(), `multi-account-probe-${process.pid}-${Date.now()}.db`);
let p1 = null, p2 = null;
try {
  p1 = await boot(await freePort(), dbFile);
  p2 = await boot(await freePort(), dbFile);

  // 先决：注册这条路在单进程上得先走通，否则下面每一格都在量空气。
  const reg1 = await api(p1.base, '/api/register', { name: '探针甲', password: PW, code: INVITE });
  if (!reg1.json.ok || !(reg1.json.recovery || []).length) {
    throw new Error(`先决不成立：P1 注册失败 ${JSON.stringify(reg1)}`);
  }

  // S1 活进程的账本不共享：P2 是在"探针甲"存在之前载入的内存，之后也不会再载入。
  const s1 = await api(p2.base, '/api/login', { name: '探针甲', password: PW });
  judge('S1 跨进程可见性（活进程）：P1 注册 → P2 直接登录（应该成立，账上记红）', false, s1.status === 200,
    `P2 回了 ${s1.status} ${s1.json.error || ''} —— 读的是 P2 自己载入时的内存，不是库`);

  // S1b 对照臂：重启 P2，它从库里载入一次 —— 这之后就能看见了。证明库是共享的，
  // 缺口只在"活进程的读数"，不是 SQLite 本身。等一轮刷盘（250ms 批）再重启。
  await sleep(700);
  p2.kill(); await p2.exited;
  p2 = await boot(await freePort(), dbFile);
  const s1b = await api(p2.base, '/api/login', { name: '探针甲', password: PW });
  judge('S1b 跨进程可见性（重启后）：P2 重启 → 登录（账上记绿）', true, s1b.status === 200,
    `P2 回了 ${s1b.status} —— 库文件里的账是对的，活进程的账本才是缺口`);

  // S2 同名并发注册：两边各自查各自的内存，都查不到人，两边都发"注册成功"。
  // 落库是 upsert 同一个 key，后刷的哈希悄悄顶掉先刷的 —— 两个人里有一个拿着登不进的号。
  const s2 = await Promise.all([
    api(p1.base, '/api/register', { name: '探针同', password: PW, code: INVITE }),
    api(p2.base, '/api/register', { name: '探针同', password: 'probe-password-2', code: INVITE }),
  ]);
  judge('S2 同名并发注册（两台同时）：恰好一个成功（应该如此，账上记红）', false, s2.filter(r => r.json.ok).length === 1,
    cnt(s2));

  // S3 两张不同的码并发重设（两台）：meta 抽屉是直写的，两边都读得到同一叠码、
  // 各验各的（都命中）、各换各的一叠（后写的顶掉先写的）。附带一笔：P2 那边的
  // patchUser 是内存 Map 上的 no-op（它内存里没有这个人），改密码只落在 P1 的账本上。
  const reg3 = await api(p1.base, '/api/register', { name: '探针乙', password: PW, code: INVITE });
  if (!(reg3.json.recovery || []).length) throw new Error(`先决不成立：探针乙注册 ${JSON.stringify(reg3)}`);
  await sleep(700);   // 恢复码走 meta 直写，但注册行本身要等 P1 的批刷，别让 S1b 的巧合混进来
  const s3 = await Promise.all([
    api(p1.base, '/api/recover', { name: '探针乙', code: reg3.json.recovery[0], password: 'probe-new-pw-1' }),
    api(p2.base, '/api/recover', { name: '探针乙', code: reg3.json.recovery[1], password: 'probe-new-pw-2' }),
  ]);
  judge('S3 两张不同的码并发重设（两台同时）：恰好一张成功（应该如此，账上记红）', false, s3.filter(r => r.json.ok).length === 1,
    cnt(s3));

  // S4 对照臂（同一台）：进程内 TOCTOU 第 10 轮已经修掉（_keyChain 每呼号串行，
  // 判据 test/accounts.mjs L 段）—— 第二张码在换发之后才开读，读到的就是新账。
  const reg4 = await api(p1.base, '/api/register', { name: '探针丙', password: PW, code: INVITE });
  if (!(reg4.json.recovery || []).length) throw new Error(`先决不成立：探针丙注册 ${JSON.stringify(reg4)}`);
  await sleep(700);
  const s4 = await Promise.all([
    api(p1.base, '/api/recover', { name: '探针丙', code: reg4.json.recovery[0], password: 'probe-new-pw-3' }),
    api(p1.base, '/api/recover', { name: '探针丙', code: reg4.json.recovery[1], password: 'probe-new-pw-4' }),
  ]);
  judge('S4 两张不同的码并发重设（同一台）：恰好一张成功（账上记绿：进程内已修）', true, s4.filter(r => r.json.ok).length === 1,
    cnt(s4));

  console.log(`
  结论：S1/S2/S3 的红是同一个成因 —— SqliteStore 的账本是**进程私有**的
  （开库载入一次 + 读全走内存 + 写攒批刷盘，server/store.mjs 文件头写了为什么：
  60Hz 的 tick 里不许有磁盘访问）。库文件本身共享（S1b 绿），修法是架构题
  （跨进程共享读数 / 房间目录式的进程外存放），见 docs/net-vs-local-gaps.md 附十五。
  哪天这一格转绿了，把这份探针升格成判据；S4 转红则说明进程内的锁又破了。`);
} finally {
  if (p1) p1.kill();
  if (p2) p2.kill();
  await sleep(150);
  for (const suf of ['', '-wal', '-shm']) { try { rmSync(dbFile + suf, { force: true }); } catch { /* 尽力而为 */ } }
}
process.exit(mismatches ? 1 : 0);
