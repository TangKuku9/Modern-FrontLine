// 预载清单守卫（性能审查 C8，docs/client-performance-audit.md）。
//
// index.html 里的 `<link rel="modulepreload">` 清单必须等于**源码模块图的闭包**：
//   · 两个根 —— js/main.js（页面入口）与 js/worker.mjs（C4/C5 的常驻 Worker，
//     new Worker(new URL(...)) 不在静态 import 图里，手动作根）；
//   · 裸说明符按 index.html 自己的 import map 解析（单一事实源，不在测试里抄第二份）；
//   · 相对说明符按引入方目录解析；net-trace.html 是开发页，不入图。
// 为什么要有这份清单：ESM 按需发现是瀑布 —— main.js 解析完才知道下一层 import，
// 冷加载白付五六轮 RTT；modulepreload 把它拉平成并行取+预解析。
// **语义红线**：预载不改缓存语义 —— 服务端仍然 no-cache + 304 回源，
// "发版本即同步"（云部署更新时旧缓存卡加载屏的那条账）一行不动。
// 清单过期的症状是判据红：缺的照"补这些行"打出来贴回 index.html，多了的删掉。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 纯函数（反证臂直接喂夹具） ----------

// 从一段 JS 源码里抠静态 import/export 的说明符。先剥行注释 —— 本仓的注释里满是
// "'three' 裸说明符"这类字样，不剥会把注释当 import。
export function specsOf(src) {
  const bare = src.split('\n').map(l => l.replace(/(^|[^:'"])\/\/.*$/, '$1')).join('\n');
  const out = new Set();
  for (const m of bare.matchAll(/from\s+['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of bare.matchAll(/import\s+['"]([^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
}

// import map 解析（{ exact: value, 'prefix/': value }），返回 resolver
export function resolverOf(map) {
  const exact = new Map(), prefixes = [];
  for (const [k, v] of Object.entries(map)) {
    if (k.endsWith('/')) prefixes.push([k, v]); else exact.set(k, v);
  }
  prefixes.sort((a, b) => b[0].length - a[0].length);
  return (spec) => {
    if (exact.has(spec)) return exact.get(spec);
    for (const [k, v] of prefixes) if (spec.startsWith(k)) return v + spec.slice(k.length);
    throw new Error('import map 解析不了说明符: ' + spec);
  };
}

// 从根集合出发走静态 import 图，返回相对仓库根的路径集合
export function graphOf(roots, readFile, resolve, dirOf) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const dir = dirOf(rel);
    for (const spec of specsOf(readFile(rel))) {
      if (spec.startsWith('.')) {
        const p = posix.normalize(posix.join(dir, spec));
        queue.push(p.startsWith('./') ? p.slice(2) : p);
      } else {
        const v = resolve(spec);
        queue.push(v.startsWith('./') ? v.slice(2) : v);
      }
    }
  }
  return seen;
}

// 差分（缺的 / 多的）——反证臂直接调它证明"会红"
export function diffLists(expected, actual) {
  const miss = [...expected].filter(x => !actual.has(x));
  const extra = [...actual].filter(x => !expected.has(x));
  return { miss, extra };
}

// ---------- 对真实仓库跑 ----------

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mapMatch = html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/);
const IMPORTS = JSON.parse(mapMatch[1]).imports;
const resolve = resolverOf(IMPORTS);
const readFile = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const dirOf = (rel) => dirname(rel);

// 服务器的 PUBLIC 白名单从源码抠（image.mjs 同款手法，不在测试里抄第二份），
// 再镜像 publiclyServable 的裁决，逐个核对预载文件生产模式下真的发得出去。
const NSSRC = readFileSync(join(ROOT, 'server/net-server.mjs'), 'utf8');
const pubMatch = /const PUBLIC = \[([^\]]*)\]/.exec(NSSRC);
const PUBLIC = JSON.parse('[' + pubMatch[1].replace(/'/g, '"') + ']');
const servable = (rel) => !rel.split('/').some(seg => seg.startsWith('.'))
  && PUBLIC.some(x => rel === x || rel.startsWith(x));

const ROOTS = ['js/main.js', 'js/worker.mjs'];
const graph = graphOf(ROOTS, readFile, resolve, dirOf);
for (const f of graph) if (!existsSync(join(ROOT, f))) throw new Error('图里出现不存在的文件: ' + f);

const listed = new Set([...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]));
const { miss, extra } = diffLists(graph, listed);

const out = [];
const ok = (label, cond, extra2 = '') => out.push([!!cond, label + (extra2 ? '  ' + extra2 : '')]);

ok(`P1 模块图规模合理（${graph.size} 个文件，roots=${ROOTS.join(' + ')}）`, graph.size >= 30 && graph.size <= 120, [...graph].sort().slice(0, 3).join(' / ') + ' …');
ok('P2 预载清单 == 源码模块图闭包', miss.length === 0 && extra.length === 0,
  (miss.length ? '\n    缺（把这些行贴进 index.html）：\n' + miss.sort().map(f => `    <link rel="modulepreload" href="${f}">`).join('\n') : '')
  + (extra.length ? '\n    多（这些行已不在图里，从 index.html 删掉）：\n' + extra.sort().map(f => `    <link rel="modulepreload" href="${f}">`).join('\n') : ''));
ok('P3 预载的都是真文件且生产白名单放行（PUBLIC 从 net-server.mjs 源码抠）',
  [...listed].every(f => existsSync(join(ROOT, f)) && servable(f)),
  [...listed].filter(f => !servable(f)).join(','));
ok('P4 图里没有白名单外的文件（server/codec.mjs 是唯一特例，整条 server/ 源码不许泄）',
  [...graph].every(f => servable(f)), [...graph].filter(f => !servable(f)).join(','));

// 反证臂：差分器必须会红 —— 抽掉一个真模块、塞进一个假模块，各报一条
{
  const real = new Set(['js/main.js', 'js/util.js']);
  const broken = new Set(['js/main.js']);
  const d1 = diffLists(real, broken);
  const d2 = diffLists(real, new Set(['js/main.js', 'js/util.js', 'js/ghost.js']));
ok('P5【反证臂】差分器会红：漏一个/多一个都当场点名', d1.miss.length === 1 && d1.miss[0] === 'js/util.js'
  && d2.extra.length === 1 && d2.extra[0] === 'js/ghost.js');
}

const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);
