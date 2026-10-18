// 测试跑法：所有判据**串行**执行，一份跑完再跑下一份。
//
// 为什么不做并发：每份浏览器判据自己会起临时服务和 Chrome，同一台机器上并排跑
// 只会把 CPU/内存吃满，然后让超时类的断言假红（实测过一轮，掉线与页面启动段最先塌）。
// 缩短时间靠的是清单里只留必要的判据，不是同时多跑几份。
//
//   node test/run.mjs test
//   node test/run.mjs test:fast
//   node test/run.mjs test:browser
//   node test/run.mjs test:all
//   node test/run.mjs test:smoke
//
// 选项：--bail --list --timeout=毫秒
//
// 判据清单在 test/manifest.mjs；这里只负责调度、计时和失败日志。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS } from './manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const valueOf = (name, def) => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
};
const has = name => argv.includes(`--${name}`);

const tierName = argv.find(a => !a.startsWith('-') && !/^\d+$/.test(a)) || 'test';
const tier = TIERS[tierName];
if (!tier) {
  console.error(`没有这一档：${tierName}\n可选：${Object.keys(TIERS).join(' / ')}`);
  process.exit(2);
}
const bail = has('bail');
const num = (v, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : def; };
const timeoutMs = num(valueOf('timeout', 15 * 60 * 1000), 15 * 60 * 1000);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = join(ROOT, 'test/.logs', runId);

const expand = e => ({
  label: e.args && e.args.length ? `${e.file}[${e.args.join(' ')}]` : e.file,
  file: e.file,
  nodeArgs: e.nodeArgs || [],
  args: e.args || [],
  needsGate: !!e.needsGate,
});

if (has('list')) {
  for (const [name, t] of Object.entries(TIERS)) {
    console.log(`\n[${name}]`);
    for (const e of [...t.node, ...t.browser]) console.log('  ' + expand(e).label);
  }
  process.exit(0);
}

const active = new Set();
let aborted = false;
const results = [];
const failures = [];

process.on('SIGINT', () => {
  aborted = true;
  console.log('\n收到中断，正在收掉子进程…');
  for (const c of active) killTree(c);
  process.exit(130);
});

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch { try { child.kill(); } catch { /* 已经退了 */ } }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }
  }
}

function runTask(task) {
  if (aborted) return Promise.resolve({ ...task, code: 130, ms: 0, skipped: true });
  if (task.needsGate && failures.some(f => f.file === 'server/gate.mjs')) {
    console.log(`SKIP  ${task.label}（gate 没绿，跨环境夹具不可信）`);
    return Promise.resolve({ ...task, code: 0, ms: 0, skipped: true });
  }
  const started = Date.now();
  console.log(`▶ ${task.label}`);
  return new Promise(done => {
    const child = spawn(process.execPath, [...task.nodeArgs, task.file, ...task.args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const chunks = [];
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => chunks.push(d));
    active.add(child);
    let timer = null;
    let timedOut = false;
    let settled = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        console.log(`TIMEOUT ${task.label}（${timeoutMs}ms）`);
        killTree(child);
      }, timeoutMs);
    }
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      active.delete(child);
      const ms = Date.now() - started;
      const out = Buffer.concat(chunks).toString('utf8');
      const r = { ...task, code: timedOut ? 124 : (code ?? (signal ? 1 : 1)), ms, out, timedOut };
      results.push(r);
      if (r.code !== 0) {
        failures.push(r);
        mkdirSync(logDir, { recursive: true });
        const safe = task.label.replace(/[\\/:*?"<>|[\]]/g, '_');
        const logFile = join(logDir, safe + '.log');
        writeFileSync(logFile, out);
        r.logFile = logFile;
        console.log(`✗ ${(ms / 1000).toFixed(1)}s ${task.label}${timedOut ? '（超时）' : ''}`);
      } else {
        console.log(`✓ ${(ms / 1000).toFixed(1)}s ${task.label}${r.skipped ? '（跳过）' : ''}`);
      }
      done(r);
    };
    child.on('error', e => {
      chunks.push(Buffer.from(`\n[runner] spawn 失败：${e.message}\n`));
      finish(1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

const nodeTasks = tier.node.map(expand);
const browserTasks = tier.browser.map(expand);
const prereqs = nodeTasks.filter(t => t.file === 'server/gate.mjs');
const rest = [...nodeTasks.filter(t => t.file !== 'server/gate.mjs'), ...browserTasks];

console.log(`\n${tierName} · 进程内 ${nodeTasks.length} 份 · 浏览器 ${browserTasks.length} 份 · 串行`);

const t0 = Date.now();
if (prereqs.length) {
  // gate 先跑：它落盘的 trace-node/match-node 是 xenv 的输入；而且它只要 1–2 秒。
  await runTask(prereqs[0]);
}
for (const task of rest) {
  if (aborted || (bail && failures.length)) break;
  await runTask(task);
}
const wall = Date.now() - t0;

const done = results.filter(r => !r.skipped);
const slow = [...done].sort((a, b) => b.ms - a.ms);
console.log(`\n${failures.length || aborted ? 'RED' : 'GREEN'}  ${done.length - failures.length}/${done.length} 份判据通过 · 墙钟 ${(wall / 1000).toFixed(1)}s（串行累计 ${(done.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s）`);
if (slow.length) {
  console.log('\n最慢的 8 份：');
  for (const r of slow.slice(0, 8)) console.log(`  ${(r.ms / 1000).toFixed(1)}s  ${r.label}`);
}
if (failures.length) {
  console.log(`\n失败 ${failures.length} 份（完整日志在 ${relative(ROOT, logDir)}）：`);
  for (const f of failures) {
    console.log(`\n===== ${f.label} · exit ${f.code} · ${(f.ms / 1000).toFixed(1)}s =====`);
    console.log(String(f.out || '').replace(/\s+$/, '').split('\n').slice(-120).join('\n'));
    if (f.logFile) console.log(`日志：${relative(ROOT, f.logFile)}`);
  }
}
process.exit(failures.length || aborted ? 1 : 0);
