// 镜像与容器那条路的**静态**判据。
//
// 起因：README 里那两条 docker 命令旁边写着"本机未构建验证（开发机没装 docker）"——
// 那句话本身是诚实的，但它盖住了一整块可以量、却一直没量的东西：Dockerfile 与
// `.dockerignore` 是**源码**，HEALTHCHECK 那句是**能跑的代码**，`PUBLIC` 白名单与运行时
// 导入闭包也是源码。开发机上没有 docker 守护进程，不等于这些只能靠散文。
//
// 这里分三段：
//   A 镜像清单：COPY 的源、CMD 指向的文件、`NODE_ENV=production`、非 root —— 都在源码里
//   B 上下文与白名单：运行时导入闭包（从 `server/net-server.mjs` 递归推）与 `PUBLIC` 白名单
//                    里的每一条，都不许被 `.dockerignore` 排除 —— 这一条的死法是静默的：
//                    镜像构建成功、容器起得来、游戏却 404（或服务端 import 失败）
//   C HEALTHCHECK：把那句 CMD 从 Dockerfile 里**抠出来**对一台真服跑（必须 0），
//                    再对一个没人听的端口跑（必须 1）—— 否则它是"永远 0"的装饰
//
// 仍然没验的（本文件也管不了，README 继续写着）：真的 `docker build` / `docker run`、
// 镜像层体积、`SIGTERM` 在 Linux 上的行为（那由 `server/deploy-probe.mjs` 在部署面上验）。
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withServer, freePort } from './with-server.mjs';

// `dirname` 走本机路径语义（Windows 上是反斜杠），`posix` 只用于闭包内部的仓库相对路径 ——
// 两者混用会把 ROOT 算到上一级去（实测踩过：fileURLToPath 给的是 `D:\…\repo\test\image.mjs`，
// 而 posix.dirname 看不见反斜杠，返回 `.`）。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = resolve(ROOT, 'Dockerfile');
const IGNORE = resolve(ROOT, '.dockerignore');

let checks = 0, fails = 0;
function ok(name, pass, detail) {
  checks++;
  if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : '  |  ' + detail}`);
}

// ---------- 纯函数（下面用合成夹具走一遍，证明它们真的会红） ----------

// 从一份源码里推它 import 了什么（相对路径 .js/.mjs 与裸包名都要）。
// 先把注释挖掉再扫：散文里写一句 `import 'playwright'`（本仓库的注释里真的会提它）不该被算成
// 运行时依赖 —— 那会让 B4 变成"谁在注释里提一句就红"。不锚行首：`import A from 'x'; import B
// from 'y';` 写在一行上是合法的，锚了行首就会**静默漏掉**后半个（闭包漏文件正是 B1 最该死的那种漏）。
export function importsOf(src) {
  const code = String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  const out = new Set();
  for (const m of code.matchAll(/\b(?:import|export)\s+(?:[^'"\n]*?from\s*)?['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out].sort();
}

// 运行时导入闭包：从入口出发只跟相对路径（裸包名在 node_modules 里，由 `npm ci` 负责）。
// 返回仓库相对路径（POSIX 斜杠）与裸依赖两份。`has` 可注入 —— 反证臂要拿夹具走同一条路，
// 而夹具里的文件并不在磁盘上（注入不了的话，那段臂量的是 existsSync 而不是解析器）。
export function closureOf(entry, readSrc, has = rel => existsSync(resolve(ROOT, rel))) {
  const files = new Set(), ext = new Set();
  const walk = (rel) => {
    if (files.has(rel)) return;
    let src;
    try { src = readSrc(rel); } catch { return; }
    files.add(rel);
    const dir = posix.dirname(rel);
    for (const spec of importsOf(src)) {
      if (!spec.startsWith('.')) { ext.add(spec); continue; }
      const base = posix.normalize(posix.join(dir === '.' ? '' : dir, spec)).replace(/^\.\//, '');
      for (const cand of [base, base + '.mjs', base + '.js', base + '/index.mjs']) {
        if (has(cand)) { walk(cand); break; }
      }
    }
  };
  walk(entry);
  return { files: [...files].sort(), ext: [...ext].sort() };
}

// `.dockerignore` 只按这份仓库里真实出现的那几种写法判：整名、目录前缀、`*.后缀`。
// 不追求与 moby 的 patternmatcher 逐位一致 —— 追求的是"这个仓库里写错就红"，
// 所以下面 A 段还有一条"上下文里到底有什么"的对照，防止这把尺子太宽松而恒绿。
export function ignoredBy(path, patterns) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
  return patterns.some((raw) => {
    const line = String(raw).split('#')[0].trim();
    if (!line) return false;
    const pat = line.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!pat) return false;
    if (pat.includes('*')) {
      const body = pat.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
      return new RegExp(`(^|/)${body}($|/)`).test(p);
    }
    return p === pat || p.startsWith(pat + '/') || p.split('/').includes(pat);
  });
}

// `PUBLIC` 白名单（服务端真正会通过 HTTP 发出去的那几个前缀）从源码里推，不从文档抄。
export function publicList(src) {
  const m = /const PUBLIC = \[([^\]]*)\]/.exec(String(src));
  return m ? [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]) : [];
}

// HEALTHCHECK 的那句 payload：Dockerfile 里的 `CMD node -e "…"`，连同它依赖的 PORT 表达式。
export function healthPayload(src) {
  const m = /HEALTHCHECK[\s\S]*?CMD\s+node -e\s+"([^"]+)"/.exec(String(src));
  return m ? m[1] : '';
}

// ---------- 读源码 ----------
const readText = p => readFileSync(p, 'utf8');
const docker = existsSync(DOCKERFILE) ? readText(DOCKERFILE) : '';
const ignore = existsSync(IGNORE) ? readText(IGNORE) : '';
const serverSrc = readText(resolve(ROOT, 'server/net-server.mjs'));
const pkg = JSON.parse(readText(resolve(ROOT, 'package.json')));
const ioLines = ignore.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
const readRel = rel => readText(resolve(ROOT, rel));
const closure = closureOf('server/net-server.mjs', readRel);

// 先决：这几样读不到就别往下走 —— 否则下面每一段都在遍历空集合，全绿而什么都没量。
ok('先决：Dockerfile / .dockerignore / server 源码 / package.json 都读到了',
  !!docker && !!ignore && !!serverSrc && !!pkg.scripts,
  `Dockerfile ${docker.length} B · .dockerignore ${ioLines.length} 条 · 服务端 ${serverSrc.length} B`);
ok('先决：从 server/net-server.mjs 推出的运行时闭包足够大（解析器坏了会让 B 段恒绿）',
  closure.files.length >= 20 && closure.ext.length >= 3,
  `闭包 ${closure.files.length} 个文件 · 裸依赖 ${closure.ext.join(', ')}`);
const payload = healthPayload(docker);
ok('先决：Dockerfile 里抠得出 HEALTHCHECK 那句 `node -e`（抠不到就没有 C 段）',
  payload.length > 20 && payload.includes('healthz'), payload.slice(0, 60) + '…');

// 只想跑某一段的时候：node test/image.mjs A（或 B / C / D）。默认全跑。
// D 是"反证臂：纯函数走合成夹具"那段（照 test/net-drop.mjs 的 argv 惯例）。
// 先决那四条永远执行 —— 它们是"这段判据活着"的前提，不属于任何一段。
const ONLY = (process.argv[2] || '').toUpperCase();
const skip = t => !!ONLY && !ONLY.includes(t);

if (!skip('A')) {
  console.log('── A 镜像清单 ──');
  // COPY 的源都得在仓库里：`COPY . .` 的来源是构建上下文，两行的源分开看。
  const copies = [...docker.matchAll(/^COPY\s+(.+)$/gm)].map(m => m[1].trim().split(/\s+/).slice(0, -1)).flat();
  const missCopy = copies.filter(c => c !== '.' && !existsSync(resolve(ROOT, c)));
  ok('A1 每条 COPY 的源在仓库里都存在（多写了不存在的文件，镜像构建时才炸）',
    copies.length >= 2 && missCopy.length === 0, `COPY ${copies.length} 条${missCopy.length ? '，缺：' + missCopy.join(', ') : ''}`);

  const cmdM = /^CMD\s+\[(.*)\]$/m.exec(docker);
  const cmdArgv = cmdM ? [...cmdM[1].matchAll(/"([^"]*)"/g)].map(m => m[1]) : [];
  const cmdFile = cmdArgv[1] || '';
  ok('A2 CMD 指向的那个文件存在（镜像里最后一行命令指向空气是最贵的死法）',
    cmdArgv[0] === 'node' && !!cmdFile && existsSync(resolve(ROOT, cmdFile)), cmdArgv.join(' '));

  ok('A3 镜像里默认 NODE_ENV=production（否则配置闸在容器里失效：不设 JOIN_CODE 也能带着公开默认码起来）',
    /NODE_ENV\s*=\s*production/.test(docker), (docker.match(/ENV[\s\S]*?(?=\r?\n\r?\n)/) || [''])[0].replace(/\s+/g, ' ').slice(0, 120));

  const userLine = (/^USER\s+(\S+)\s*$/m.exec(docker) || [])[1] || '';
  ok('A4 镜像里不是 root 跑服务（这个进程会被喂任意客户端输入）',
    !!userLine && userLine !== 'root' && userLine !== '0', `USER ${userLine || '(没写，即 root)'}`);

  // `npm ci --omit=dev` 装的就是 dependencies 那一份：两处必须以同一种方式理解"运行时依赖"。
  ok('A5 运行时依赖只有 dependencies 那几个（playwright 必须在 devDependencies，否则镜像白白胖几百 MB）',
    /npm ci --omit=dev/.test(docker) && !!pkg.devDependencies && !!pkg.devDependencies.playwright
      && !(pkg.dependencies || {}).playwright,
    `dependencies=${Object.keys(pkg.dependencies || {}).join(', ')} · devDependencies=${Object.keys(pkg.devDependencies || {}).join(', ')}`);
}

if (!skip('B')) {
  console.log('── B 上下文与白名单 ──');
  const mustShip = [...closure.files, ...publicList(serverSrc)];
  const blocked = mustShip.filter(p => ignoredBy(p, ioLines));
  ok('B1 `.dockerignore` 没有排除运行时导入闭包里的任何一个文件',
    closure.files.every(p => !ignoredBy(p, ioLines)),
    blocked.filter(p => closure.files.includes(p)).length ? `被挡：${blocked.filter(p => closure.files.includes(p)).join(', ')}`
      : `${closure.files.length} 个文件逐个过了一遍 .dockerignore`);

  const pub = publicList(serverSrc);
  ok('B2 `.dockerignore` 没有排除 `PUBLIC` 白名单里的任何一项（构建成功、起来却 404 是最贵的那种静默）',
    pub.length >= 4 && pub.every(p => !ignoredBy(p, ioLines)),
    pub.length ? `PUBLIC ${pub.length} 项：${pub.join(' ')}` : '服务端源码里找不到 PUBLIC 白名单');

  // 假绿防线：`.dockerignore` 若被清空，上面两条会自动全绿。上下文里真正存在的目录必须
  // 至少有一个被挡住的"该挡的东西"（node_modules / .git / test 这种），否则说明这份 ignore 表
  // 已经不是"挡东西"的表了。
  const ctxDirs = ['node_modules', '.git', 'test', 'server'];
  const blockedDirs = ctxDirs.filter(d => existsSync(resolve(ROOT, d)) && ignoredBy(d, ioLines));
  ok('B3 反过来：上下文里"该挡的那几个"确实被挡住了（表被清空 ⇒ 这里红，而不是 B1/B2 悄悄全绿）',
    blockedDirs.length >= 3, `挡住 ${blockedDirs.join(', ')}`);

  const pwInClosure = closure.files.filter(p => importsOf(readRel(p)).includes('playwright'));
  ok('B4 运行时闭包一个都不 import playwright（`--omit=dev` 之后镜像里没有它，import 到就是启动即崩）',
    pwInClosure.length === 0, pwInClosure.length ? `这些文件 import 了它：${pwInClosure.join(', ')}` : `${closure.files.length} 个文件里没有一处`);
}

if (!skip('C')) {
  console.log('── C HEALTHCHECK 那句本身 ──');
  const srv = await withServer({});
  try {
    const code = await new Promise((res) => {
      const p = spawn(process.execPath, ['-e', payload], { env: { ...process.env, PORT: String(srv.port) } });
      p.on('exit', c => res(c));
    });
    ok('C1 把 Dockerfile 里那句 PROBE 抠出来对一台真服跑：退出码 0（健康）',
      code === 0, `PORT=${srv.port} 退出码 ${code}`);
  } finally { srv.kill(); }

  const deadPort = await freePort();
  const deadCode = await new Promise((res) => {
    const p = spawn(process.execPath, ['-e', payload], { env: { ...process.env, PORT: String(deadPort) } });
    p.on('exit', c => res(c));
  });
  ok('C2 **判别臂**：同一个端口没人听的时候退出码必须是 1（否则这句 HEALTHCHECK 是"永远健康"的装饰）',
    deadCode === 1, `PORT=${deadPort}（空着）退出码 ${deadCode}`);
}

if (!skip('D')) {
  console.log('── 反证臂：纯函数走合成夹具 ──');
  const ioOld = ['node_modules', '.git', 'test'];
  ok('反证臂 A：把 `js/` 写进 .dockerignore ⇒ B1/B2 那把尺子当场报红',
    ignoredBy('js/main.js', [...ioOld, 'js']) && ignoredBy('js/', [...ioOld, 'js']) && !ignoredBy('js/main.js', ioOld),
    `加了 js ⇒ ${ignoredBy('js/main.js', [...ioOld, 'js'])}；没加 ⇒ ${ignoredBy('js/main.js', ioOld)}`);

  const fj1 = closureOf('a.mjs', r => { const m = { 'a.mjs': "import './b.mjs'; import 'ws';", 'b.mjs': "export * from './c.mjs';", 'c.mjs': "import './a.mjs';" }; if (!(r in m)) throw new Error('no'); return m[r]; }, r => ['a.mjs', 'b.mjs', 'c.mjs'].includes(r));
  ok('反证臂 B：闭包会跟着相对 import / re-export 走到底、把裸包名单列（少跟一层就漏掉该进镜像的文件；c.mjs 还指回 a.mjs，绕圈不能死循环）',
    fj1.files.join(',') === 'a.mjs,b.mjs,c.mjs' && fj1.ext.join(',') === 'ws',
    `files=${fj1.files.join(',')} ext=${fj1.ext.join(',')}`);

  ok('反证臂 C：`PUBLIC` 白名单抠不出来时返回空数组（B2 的先决臂据此报红，不是静默放过）',
    publicList('const PUBLIC = [];').length === 0 && publicList('没有这一行').length === 0
      && publicList("const PUBLIC = ['index.html'];").length === 1,
    '空表/缺行 ⇒ 0 项；真表 ⇒ 1 项');

  ok('反证臂 D：HEALTHCHECK 那句抠不出来时返回空串（C 段的先决臂据此报红）',
    healthPayload('没有这一行') === '' && healthPayload('HEALTHCHECK CMD node -e "x"') === 'x',
    `缺行='' · 有行='${healthPayload('HEALTHCHECK CMD node -e "x"')}'`);
}

console.log(`\n${fails ? 'RED' : 'GREEN'}  ${checks - fails}/${checks} 通过`);
process.exit(fails ? 1 : 0);
