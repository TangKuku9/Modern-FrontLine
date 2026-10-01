// 文档守卫。README《验收》/ README《已知缺口》/ docs/deploy-checklist.md §0 与
// package.json 的脚本之间，过去**没有任何判据** —— 于是漂移是静默的：
// 新增一份 test/*.mjs 忘了写进文档，两份清单就一起变旧（`test/gunvisual.mjs` 就是这样漏的：
// 它一直在 `npm test` 里跑，README 上一个字都没有）；而文档漂移的下一站更贵 ——
// "README 写着还没收口的缺口，其实上一轮就收了"（本文件 D 段钉的就是这一类）。
//
// 七段判据，各配反证臂。只写"坏的要红"那一半的话，把这几份文档整个删掉也能全绿，
// 而那正是本仓库最怕的那种绿（见 README《验收》开头那句）。
//   A 覆盖（正向）：脚本里跑到的每个 .mjs，必须在 README《验收》里被点名。
//   B 覆盖（反向）：README《验收》里点名的每个 .mjs，不能是"仓库里已经没有这个文件"
//                    —— 指着一个被删掉/改名的测试文件，与漏写是同一类漂移。
//                    文件还在、只是不作为三档脚本里的一站（说明性引用，例如
//                    `server/fps-independence.mjs` 那种一次性测量脚本）不报红，只打印。
//   C 清单（第二层）：`docs/deploy-checklist.md` §0 是"改代码之后必跑"那一节，
//                    它逐档点名要跑什么（写的是不带扩展名的 stem），同样按脚本核对。
//   D 已推翻的断言：正文里那些"当时是真的、后来收口了"的话，一张
//                    (不能再出现的话 × 必须还在的话) 表：
//                    gone 命中 ⇒ 红；must 不命中 ⇒ 红（有人把整段删了来让 gone 变绿）。
//   D″ 两份文档同一句话：D 段只盯 README，于是"README 改了、部署清单没改"这种漂移
//                    两处都不报。这一段的判据是**同一句话必须在两份里都成立**
//                    （README《已知缺口》与 deploy-checklist 对同一件事说同一口径），
//                    谁也不许留着旧口径 —— 它不是"重复检查"，而是"对账"。
//   E 浏览器分档：README 里"要真浏览器"那一行的名单，必须**等于**源码里要浏览器的那几份
//                    —— 手抄的名单会漏（原来漏掉 `server/xenv.mjs`：它是靠
//                    `net-trace.html` 起真浏览器的那个跨环境比对）。名单从源码推，不从文档抄。
//   G 浏览器回落档：README 告诉"没有 Chrome 的机器先 `npx playwright install chromium`"，
//                    那么每份浏览器判据的 `launch` 链里就必须有一档**交给 Playwright 自己解析**
//                    （不带 `channel` / `executablePath`）—— 装的正是那一份。8 份源码原来只有
//                    "系统 Chrome + 这台开发机上的绝对路径"两档，于是那句安装提示在别人机器上是假的。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 判据本体（纯函数：下面用合成夹具走一遍，证明它们真的会红） ----------

export const SCRIPT_KEYS = ['test', 'test:browser', 'test:all'];
const MJS = /[\w./-]+\.mjs/g;

export function mjsIn(text) {
  return [...new Set(String(text || '').match(MJS) || [])];
}

// 三档脚本合起来"这份仓库会跑哪些文件"。用并集而不是只看 `test`：
// 文档的承诺是"这些判据都在"，不是"它们在哪一档里"。
export function filesRunBy(pkg) {
  const out = new Set();
  for (const k of SCRIPT_KEYS) for (const f of mjsIn(pkg && pkg.scripts && pkg.scripts[k])) out.add(f);
  return out;
}

// 取一节（`## <title 片段>` 或 `### <title 片段>` 到下一个二/三级标题）。
// 找不到返回 null，由调用方判红 —— 静默返回空串的话，改个标题就能让整段判据
// 变成"遍历空集合"而永远绿。
export function sectionOf(md, title) {
  const lines = String(md).split(/\r?\n/);
  const isHead = l => /^#{2,3}\s/.test(l);
  const start = lines.findIndex(l => isHead(l) && l.includes(title));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (isHead(lines[i])) { end = i; break; }
  return { text: lines.slice(start, end).join('\n'), from: start + 1, to: end };
}

// 文档按 basename 认人：README 里写的是 `server/gate.mjs` / `codec.mjs` 这种并列写法，
// 严格匹配整条路径会把"写了但省了目录"误判成漏写。
export function basenamesIn(text) {
  return new Set(mjsIn(text).map(p => basename(p)));
}

export function covered(files, names) {
  return [...files].filter(f => !names.has(basename(f))).sort();
}

// 反向臂。两种"文档提了但脚本里没有"要分开：
//   ghosts —— 磁盘上根本没有这个文件：文档指着一个被删掉/改名的东西，红。
//   unrun  —— 文件在，只是不是三档脚本里的一站（比如 `server/fps-independence.mjs`
//             这种一次性测量脚本，正文提它是为了讲清分工）：不是漂移，打印出来给人看。
export function reverseFindings(names, files, known, exempt) {
  const have = new Set([...files].map(f => basename(f)));
  const ghosts = [], unrun = [];
  for (const n of [...names].sort()) {
    if (have.has(n) || exempt.has(n)) continue;
    (known.has(n) ? unrun : ghosts).push(n);
  }
  return { ghosts, unrun };
}

// 仓库里所有文件名（不跟扩展名、不管在哪个目录）——"这个名字还在不在"的底账。
// 目录名以 `.` 开头的整棵跳过（.git / .dsh 之类），外加几个重目录。
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.playwright']);
export function walkNames(dir) {
  const out = new Set();
  const walk = d => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(resolve(d, e.name)); }
      else out.add(e.name);
    }
  };
  walk(dir);
  return out;
}

// §0 那份清单写的是 stem（`rollback / codec / …`，没有扩展名也没有目录）。
// 边界用 `[^\w-]`：否则 `fps` 会在 `fps-guard` 这种词里假绿。
export function stemsMissing(sectionText, files) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...files].filter(f => {
    const stem = basename(f).replace(/\.mjs$/, '');
    return !new RegExp(`(^|[^\\w-])${esc(stem)}([^\\w-]|$)`).test(sectionText);
  }).sort();
}

export function staleFindings(md, table) {
  const out = [];
  for (const e of table) {
    for (const re of e.gone || []) if (re.test(md)) out.push({ id: e.id, kind: 'gone', re: String(re) });
    for (const re of e.must || []) if (!re.test(md)) out.push({ id: e.id, kind: 'must', re: String(re) });
  }
  return out;
}

// 浏览器分档。"哪些判据真的要一个浏览器"是**从源码推的**（谁 import 了 playwright），
// 不是从文档里抄的 —— 手抄就会漏：README 原来写"七份"，把 `server/xenv.mjs` 漏了，
// 而它正是靠 `net-trace.html` 起真浏览器做跨环境比对的。这里两个方向都钉：
// 漏点名的红，"把不碰浏览器的判据说成要浏览器"同样红（都会把读者带去错的地方）。
export function classifyBrowser(files, readText) {
  const out = new Map();
  for (const f of files) {
    let src = '';
    try { src = readText(f); } catch { src = ''; }
    out.set(basename(f).replace(/\.mjs$/, ''), /from\s+'playwright'/.test(src));
  }
  return out;
}

// ---------- G 段那台机器：浏览器回落档 ----------
// 起因：8 份要浏览器的判据，`launch()` 里都只有两档 —— 系统 Chrome、以及**这台开发机上**
// 那个绝对路径（`C:/Users/pyc/.../chromium-1234/...`）。而 README 写的是"没有 Chrome 的机器
// 先 `npx playwright install chromium`"：装出来的那一份，两档都不看它 ⇒ 那句提示在别人的
// 机器上是假的。这里量的是"launch 链里有没有一档交给 Playwright 自己解析"。
// 量的是 `launch()` 函数体里那张"依次试"的表。取函数体而不是全文：`newPage({ viewport })`
// 那种地方也有对象字面量，混进来会让"有没有回落档"变成看别处的脸色。
// 函数体以行首的 `}` 结束（这 8 份里 `launch` 内部没有嵌套函数声明）。
// ⚠ 一档 = 一个**带 `args:` 的**对象字面量。这条过滤不是洁癖：`console.log(\`  浏览器: ${label}\`)`
// 和 `try { ... }` 那种块里也有关键字冒号与一对花括号，不排掉的话"有没有回落档"会被它们骗成
// 恒绿 —— 反证臂 G⁻ 的夹具就是照着这个假绿写的（改动前那 8 份源码里这种片段到处都是）。
export function launchRungs(src) {
  const s = String(src);
  const i = s.indexOf('async function launch(');
  if (i < 0) return [];
  const j = s.indexOf('\n}', i);
  const body = j < 0 ? s.slice(i) : s.slice(i, j);
  return [...body.matchAll(/\{[^}\n]*\}/g)].map(m => m[0]).filter(o => /\bargs\s*:/.test(o));
}
export function selfResolvedRung(src) {
  const rungs = launchRungs(src);
  const self = rungs.filter(o => !/channel\s*:/.test(o) && !/executablePath\s*:/.test(o));
  return { rungs, self, ok: self.length > 0 };
}

export function linesWith(text, marker) {
  return String(text).split(/\r?\n/).filter(l => l.includes(marker)).join('\n');
}

// 只认"已知文件名 stem 的整词"——散文里的字不会被当成文件名。
export function stemsOnLine(line, stems) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...stems].filter(s => new RegExp(`(^|[^\\w-])${esc(s)}([^\\w-]|$)`).test(line));
}

export function tierFindings(sectionText, marker, classes) {
  const line = linesWith(sectionText, marker);
  const named = new Set(stemsOnLine(line, [...classes.keys()]));
  const want = new Set([...classes].filter(([, b]) => b).map(([s]) => s));
  return {
    line,
    missing: [...want].filter(s => !named.has(s)).sort(),
    extra: [...named].filter(s => !want.has(s)).sort(),
  };
}

// 反向臂的豁免名单。**空的是有意的**：README《验收》眼下点名的每一个 .mjs 都真的在脚本里。
// 将来若要在这里点一个"不该由 npm test 跑、但值得在验收一节里说明"的文件，
// 往这里加一行并写清理由 —— 而不是把反向臂删掉。
export const DOC_EXEMPT = new Map();

// ---------- D 段那张表 ----------
// 每一条 = 一次"已经收口、但正文还留着旧说法"的漂移。三个字段都是判据的一部分：
//   gone 不能再出现（旧话）、must 必须还在（收口记录本身，防"删段落换绿"）、
//   why/closed 是给红了的人看的（去哪一节核）。
// 表不许为空：只剩 0 条时，D 段就成了恒真绿灯 —— 自证臂会红。
export const STALE_CLAIMS = [
  {
    id: '联机只剩团队死斗',
    why: '三种模式的 net 标记都已打开（js/data.js 的 MP_MODES 三行都是 net: true），服务端按同一标记放行',
    closed: 'docs/net-vs-local-gaps.md 附五 · 第 1 条',
    gone: [/模式当前只有「团队死斗」/, /只有「团队死斗」/],
    must: [/三种模式都可联机/],
  },
  {
    id: '集束空袭联机不能选点',
    why: '联机落点同样由玩家在屏幕上选（左键确认 / 右键取消），权威端只验半径与地面高度',
    closed: 'docs/net-vs-local-gaps.md 附五 · 第 11 条',
    gone: [/联机改用呼叫者视线前方/, /集束空袭联机省掉手动标记/],
    must: [/集束空袭的选点两端是同一套/],
  },
  {
    id: '联机没有结算页',
    why: '联机结算面板与单机逐格对齐（js/net/client.mjs 的 matchOver 那一段），不再是"播一句胜利就弹回房间"',
    closed: 'docs/net-vs-local-gaps.md 附五 · 第 9/10 条',
    gone: [/联机侧没有结算页/],
    must: [/联机结算页/, /net-vs-local-gaps\.md` 附五/],
  },
  {
    id: '主体档不含浏览器',
    why: '`npm test` 里有五份 playwright 判据（fps / viewmodel / gunvisual / optic / state-leak），都要一个真 Chrome',
    closed: '到处都在跑：npm test 的链尾那五份',
    gone: [/不含浏览器/],
    // 这条没有"必须还在"的正向话：A 段已经要求那一档里每个文件都被点名，
    // 把那一行删掉会让 A 红，所以不需要再钉一句文案。
    must: [],
    mustWhy: '正向那一半由 A 段承担：删掉点名那一行 ⇒ A 红',
  },
  {
    id: '联机不发击杀奖章',
    why: '`killScore` 算出来的 `tags` 现在随 `kill` 事件逐条下发（server/room.mjs 的 onKill → killExtra → drainKillFeed），客户端按与单机同一张表（js/match-rules.js 的 killMedals）逐条弹',
    closed: 'docs/net-vs-local-gaps.md 附十 · 击杀奖章',
    gone: [/没有逐条奖章事件/, /联机不发奖章/],
    must: [/逐条/, /附十/],
  },
  {
    id: 'Bot 不自动补人',
    why: '房间设置里多了"补人"这一档（roomCfg {fill}）：补满到 16、有人走就补、真人进来 Bot 让位、手动减一个自动关掉',
    closed: 'docs/net-vs-local-gaps.md 附十 · Bot 自动补人',
    gone: [/不会自动补人/, /不能在对局中途加。/],
    must: [/自动补人/, /补满/],
  },
  {
    id: '登录只有密码，没有找回',
    why: '注册与每次重设各发一叠 5 张一次性恢复码（server/accounts.mjs 的 _mintRecovery / _recoverImpl），库里只有哈希；服主侧另有补发口 server/recover.mjs（只能发码，不能设密码）',
    closed: 'README《账号与安全的设计约束》那一条 + docs/net-vs-local-gaps.md 附十二',
    gone: [/登录只有密码，没有找回/, /忘了密码只能由服主改库/],
    must: [/恢复码/, /server\/recover\.mjs/],
  },
  {
    id: '容器那两条命令一律"未验证"',
    why: '不需要 docker 守护进程的那一半现在有判据了（test/image.mjs：COPY 源 / CMD 指真文件 / NODE_ENV=production / 非 root / 运行时导入闭包与 PUBLIC 白名单不被 .dockerignore 挡住 / 闭包里没有 playwright / HEALTHCHECK 的 payload 对真服跑 0、对空端口跑 1）；剩下没跑的只有 build、run、层体积与 Linux 上的 SIGTERM —— 一句话盖住整块会让人以为连配方都没量',
    closed: '第 9 轮 · 容器配方静态判据 + 浏览器回落档（README《容器与下线》/《真机部署》两段 + docs/deploy-checklist.md §6）',
    gone: [/在本机\*\*未构建验证\*\*（开发机没装 docker）/, /已验的是 `CMD`\/`HEALTHCHECK` 依赖的运行时事实/],
    must: [/test\/image\.mjs/, /真的 `docker build`/],
  },
];

const STALE_SYNTHETIC = [{
  id: '夹具', why: 'x', closed: 'y',
  gone: [/这句话已经过期/], must: [/而这一句必须还在/],
}];

// ---------- D″ 段那张表：两份文档必须说同一句口径 ----------
// 每条被同时架在 README 与 deploy-checklist 两份正文上：gone 在两份里都不许出现，
// must 在**两份里都要成立**。起因是一次真实的漂移：进程模型在 README《已知缺口》里写的是
// "一进程 N 间"，而在部署清单里写的是"一间一进程" —— 两份都被读过、都"看着对"，
// 谁也没红。D 段只盯 README，看不见这种错；这一段把它变成可判的。
export const DOC_PAIR_CLAIMS = [
  {
    id: '多实例进程模型',
    why: '一个进程就是一个权威端（最多 MAX_ROOMS 间房 + MAX_CLIENTS 条连接），单进程内的房间列表已做、跨进程的房间目录与实例分派没做 —— 两份文档对这件事只能是同一句话',
    closed: 'README《已知缺口》第 5 条 + docs/deploy-checklist.md 第 1 节末尾"多实例：口径只有一句"',
    gone: [/一间一进程/],
    must: [/一个进程 = 一个权威端/],
  },
];

// 反证臂不用合成表，而是拿**真表**去过两段夹具正文：一段是历史原话（必须报 gone+must 各一条）、
// 一段是收口之后的话（必须一条都不报）。这样"表里那两条正则到底认不认得这句话"也是量过的 ——
// 写错一个字，前一段就报不出来，反证臂当场红。

// ---------- D′ 段那张表：已推翻的**量具**（不是文案）----------
// 与 D 段同一台机器（同一个 staleFindings），只是把尺子架在**测试源码**上。
// 这几条都是"同一份代码又绿又红、红了不知道该查哪"那一类：错不在被测对象，在判决本身。
// 换掉之后不许有人再换回去，也不许把新写法连它的先决/判别臂一起删掉换成恒绿。
//   file = 架在哪份源码上 · gone = 旧写法（不许回来）· must = 新写法与两条臂（不许没了）
// must 里为什么要点先决臂和判别臂：把新尺子的容差放开、或者把"真的在动"那条臂删掉，
// 都能让这份表全绿而判决重新变成恒真 —— 那正是这张表要拦的第二种作弊法。
export const RETIRED_RULERS = [
  {
    id: '两份下行各自停在"自己最后收到的那一包"上（net-probe）',
    file: 'server/net-probe.mjs',
    why: '两根时间轴不对齐：4.7 m/s 下错一包就 0.12 m，而容差是 0.06 m ⇒ 谁先被调度到决定红绿（test:all 里红过一次，实测 0.120 m）',
    closed: 'server/net-probe.mjs 的"共同 tick"段：只认两边都在的那一拍，容差 1e-6',
    gone: [/B 也看到 A 动了同一个位置/, /seenA\.x - nowA\.x/],
    must: [/dSame < 1e-6/, /共同 tick=/, /判别臂：这一拍 A 真的在动/],
  },
  {
    id: '两份下行各自停在"自己最后收到的那一包"上（net-play）',
    file: 'test/net-play.mjs',
    why: '同一件事的浏览器那半：`viewed.raw` 与 `walk.x1` 是两个不同时刻的读数，错两包 0.24 m 就红（test:all 里红过一次，单独跑是绿的）',
    closed: 'test/net-play.mjs 的"按 tick 对齐"段：两个页面同时取样，只认共同的那一拍，容差 1e-6',
    gone: [/dRaw < 0\.15/],
    must: [/dRaw < 1e-6/, /共同 tick=/, /判别臂：甲在动/],
  },
  {
    id: '"模拟节拍 ≥50Hz"这种绝对门槛（net-play 的量具先决）',
    file: 'test/net-play.mjs',
    why: '同一台机器上本机节拍随负载在 49~66Hz 之间晃，门槛卡在分布边缘 ⇒ 自己成了假红（红的那一轮 838 个稳态样本、Δ=0、空跑残差全绿）',
    closed: 'test/net-play.mjs：改比"消费比"（我这边的拍 ÷ 服务端推进的拍）≥0.5，分母单独断言',
    gone: [/模拟节拍够快/, /hzA >= 50/],
    must: [/消费比/, /rA\.ratio >= 0\.5/, /先决：服务端那一秒真的在推进/],
  },
  {
    id: '关掉一条连接后"睡 300 ms 再重连"（hardening 连接配额那一格的量具）',
    file: 'test/hardening.mjs',
    why: '拿**客户端的钟**去等服务端把 ws 的 close 事件跑完：机器被拖热时 300 ms 不够 ⇒ 当场红成"关掉一条名额没还回来"，而 connsByIp 只是还没减到（test:all 的最后一段红过一次，紧接着同一份代码单跑两次 111/111）',
    closed: 'test/hardening.mjs C10a/C10b/C11：尺子换成服务端自报的 /healthz clients（它与 connsByIp 的减一写在同一个 ws.on(\'close\') 里），轮询到"在线数真的降了"再重连',
    gone: [/c3\.ws\.close\(\);\s*\n\s*await sleep\(300\)/],
    must: [/Number\.isFinite\(hz0\.clients\) && hz0\.clients >= 3/, /clients <= hz0\.clients - 1/,
      /C10a【先决】/, /C10b【先决】/, /C11 \*\*反证臂\*\*：关掉一条之后名额回来了/],
  },
  {
    id: '空跑窗尺子在静止时退到"我这一步"本身（0.4 mm 余颤）',
    file: 'js/net/client.mjs',
    why: '静止时 stepMeasured 掉到物理余颤（实测 ~0.0004 m），权威位置 ±1 cm 的量化噪声（2~4 mm）就够超尺子 ⇒ net-play 的 foldBad===0 假红（附十四立账，三轮没敢碰）',
    closed: 'js/net/idle-ruler.mjs foldJudge：尺子 = max(实测步长, 2×位置量化步长)；族群臂在 test/net-feel.mjs AA 段（AA2 下限不吃真信号 / AA3、AA4 走动窗仍按自己步长量），foldFloor 记"哪几格靠下限"',
    gone: [/const step = stepMeasured !== null \? stepMeasured : Math\.hypot\(pl\.vel/],
    must: [/foldJudge\(\{ corrected: r\.corrected/, /foldFloor/],
  },
];

// 尺子架在源码上：文件读不到也算一条红，不是静默跳过（跳过就等于这张表恒绿）。
export function rulersFindings(table, readText) {
  const out = [];
  for (const r of table) {
    let txt = null;
    try { txt = readText(r.file); } catch { txt = null; }
    if (txt == null) { out.push({ id: r.id, kind: 'gone', re: `读不到 ${r.file}` }); continue; }
    out.push(...staleFindings(txt, [r]));
  }
  return out;
}

// ---------- 跑真文件 ----------
let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  | ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  | ' + detail : ''}`);
}

const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const checklist = readFileSync(resolve(ROOT, 'docs/deploy-checklist.md'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const files = filesRunBy(pkg);
const acc = sectionOf(readme, '验收');
const dep = sectionOf(checklist, '先把自己关在门外');
const accNames = acc ? basenamesIn(acc.text) : new Set();
const gapSec = sectionOf(readme, '已知缺口');

// 先决臂：这三条红了，下面每一条的绿都没有意义（遍历到空集合也能绿）
chk(files.size >= 18, '先决：package.json 的三档脚本里读到了测试文件（不是空集合）',
  `${files.size} 个：${SCRIPT_KEYS.map(k => `${k}=${mjsIn(pkg.scripts[k]).length}`).join(' ')}`);
chk(!!acc, '先决：README 里有《验收》一节（改名会让下面几条全绿）', acc ? `第 ${acc.from}-${acc.to} 行` : '找不到 ## 验收');
chk(accNames.size >= 15, '先决：README《验收》真的点名了一批文件（不是"写了一句空话"）',
  `${accNames.size} 个 .mjs`);
chk(!!dep, '先决：deploy-checklist 里有 §0 那一节', dep ? `第 ${dep.from}-${dep.to} 行` : '找不到 ## 0. …');
chk(!!gapSec, '先决：README 里有《已知缺口》一节', gapSec ? `第 ${gapSec.from}-${gapSec.to} 行` : '找不到');

// A 段：脚本跑到的，文档必须点名
const missA = covered(files, accNames);
chk(missA.length === 0, 'A 覆盖：脚本里跑的每个判据都在 README《验收》里被点名',
  missA.length ? `漏写：${missA.join(', ')}` : `${files.size} 个文件全部点到`);

// B 段：文档点名的，不能是"已经没人跑、也不存在"的东西
const known = walkNames(ROOT);
const rev = reverseFindings(accNames, files, known, DOC_EXEMPT);
chk(rev.ghosts.length === 0, 'B 覆盖：README《验收》点名的判据没有"文件都不在了"的幽灵',
  rev.ghosts.length ? `文档提到了但仓库里没有：${rev.ghosts.join(', ')}`
    : `反向对齐（豁免 ${DOC_EXEMPT.size} 条；其中 ${rev.unrun.length} 条是说明性引用：${rev.unrun.join(', ') || '无'}）`);

// C 段：部署清单那一节同样对齐
const missC = stemsMissing(dep ? dep.text : '', files);
chk(missC.length === 0, 'C 清单：deploy-checklist §0 逐档点名了脚本里跑的每个判据',
  missC.length ? `§0 漏写：${missC.join(', ')}` : `${files.size} 个文件全部点到`);

// D 段：已推翻的断言
const stale = staleFindings(readme, STALE_CLAIMS);
chk(stale.length === 0, 'D 断言：README 里没有"已收口却还留着旧说法"的句子',
  stale.length ? stale.map(s => `[${s.id}·${s.kind}] ${s.re}`).join('  ')
    : `${STALE_CLAIMS.length} 条已收口断言逐个核过`);

// D′ 段：已推翻的**量具**（同一台机器，尺子架在测试源码上）
const rul = rulersFindings(RETIRED_RULERS, f => readFileSync(resolve(ROOT, f), 'utf8'));
chk(rul.length === 0, 'D′ 量具：源码里没有"已经换掉的旧尺子"，新尺子连它的先决臂/判别臂都还在',
  rul.length ? rul.map(s => `[${s.id}·${s.kind}] ${s.re}`).join('  ')
    : `${RETIRED_RULERS.length} 条已换掉的尺子逐个核过`);

// D″ 段：两份文档必须说同一句口径（D 段只看 README，看不见"清单那半边没跟着改"）
const pairDocs = [['README.md', readme], ['docs/deploy-checklist.md', checklist]];
const pair = pairDocs.flatMap(([where, txt]) => staleFindings(txt, DOC_PAIR_CLAIMS).map(f => ({ ...f, where })));
chk(pair.length === 0, 'D″ 口径：README 与 deploy-checklist 对同一件事说的是同一句话',
  pair.length ? pair.map(s => `[${s.where}·${s.id}·${s.kind}] ${s.re}`).join('  ')
    : `${DOC_PAIR_CLAIMS.length} 条口径在两份文档里逐个对上（${pairDocs.length} 份）`);

// E 段：浏览器分档（名单从源码推，不从文档抄）
const classes = classifyBrowser(files, f => readFileSync(resolve(ROOT, f), 'utf8'));
const tier = tierFindings(acc ? acc.text : '', '要真浏览器', classes);
const wantBrowser = [...classes.values()].filter(Boolean).length;
chk(!!tier.line && tier.missing.length === 0 && tier.extra.length === 0,
  'E 分档：README 里"要真浏览器"那一行的名单 = 源码里 import playwright 的那几份',
  !tier.line ? 'README《验收》里找不到含"要真浏览器"的那一行'
    : (tier.missing.length || tier.extra.length)
      ? `漏点名：${tier.missing.join(', ') || '无'}；多点名：${tier.extra.join(', ') || '无'}`
      : `源码 ${wantBrowser} 份浏览器判据，名单逐个对上`);

// G 段：浏览器回落档 —— README 那句 `npx playwright install chromium` 必须真的有用。
// 先决：分档结果里至少 5 份"要浏览器"（少了就说明 E 段那份名单塌了，这一格会变成恒绿）。
const rungFails = [...classes].filter(([stem, isBrowser]) => {
  if (!isBrowser) return false;
  const f = [...files].find(x => basename(x).replace(/\.mjs$/, '') === stem);
  let src = '';
  try { src = readFileSync(resolve(ROOT, f), 'utf8'); } catch { src = ''; }
  return !selfResolvedRung(src).ok;
}).map(([stem]) => stem).sort();
chk(wantBrowser >= 5 && rungFails.length === 0,
  'G 回落：每份浏览器判据的 launch 链里都有一档交给 Playwright 自己解析（装出来的那份真的会被用到）',
  wantBrowser < 5 ? `先决不成立：只认出 ${wantBrowser} 份要浏览器的判据`
    : rungFails.length ? `这些判据只有"系统 Chrome / 本机绝对路径"两档：${rungFails.join(', ')}`
      : `${wantBrowser} 份浏览器判据，每一份都有一档不带 channel/executablePath`);

// 自证臂：那张表不许被清空、每条都得说得出理由与去处
const badRows = STALE_CLAIMS.filter(e => !e.id || !e.why || !e.closed
  || !(e.gone && e.gone.length) || !((e.must && e.must.length) || e.mustWhy));
chk(STALE_CLAIMS.length >= 3 && badRows.length === 0,
  'D 自证：断言表非空，且每条都写了 gone / 理由 / 收口去处（清空表格不能换绿）',
  `表 ${STALE_CLAIMS.length} 条${badRows.length ? '，缺字段：' + badRows.map(r => r.id).join(', ') : ''}`);

// D′ 自证：量具表同样不许被清空；每条必须点名文件、旧写法、新写法（含理由与去处）
const badRul = RETIRED_RULERS.filter(r => !r.id || !r.file || !r.why || !r.closed
  || !(r.gone && r.gone.length) || !(r.must && r.must.length));
chk(RETIRED_RULERS.length >= 3 && badRul.length === 0,
  'D′ 自证：量具表非空，且每条都写了 file / 旧写法 / 新写法 / 理由 / 收口去处',
  `表 ${RETIRED_RULERS.length} 条${badRul.length ? '，缺字段：' + badRul.map(r => r.id).join(', ') : ''}`);

// D″ 自证：口径表同样不许为空、每条必须写清 gone / must / 理由 / 去处
const badPair = DOC_PAIR_CLAIMS.filter(e => !e.id || !e.why || !e.closed
  || !(e.gone && e.gone.length) || !(e.must && e.must.length));
chk(DOC_PAIR_CLAIMS.length >= 1 && badPair.length === 0,
  'D″ 自证：口径表非空，且每条都写了 gone / must / 理由 / 收口去处',
  `表 ${DOC_PAIR_CLAIMS.length} 条${badPair.length ? '，缺字段：' + badPair.map(r => r.id).join(', ') : ''}`);

// ---------- 反证臂：合成夹具走同一个纯函数，必须报得出来 ----------
const armA = covered(new Set(['test/甲.mjs', 'test/乙.mjs']), new Set(['甲.mjs']));
chk(armA.length === 1 && armA[0] === 'test/乙.mjs',
  '反证臂 A：漏写的那一个会被点名（这条守卫能红）', JSON.stringify(armA));

const armB = reverseFindings(new Set(['甲.mjs', '幽灵.mjs']), new Set(['test/甲.mjs']), new Set(), new Map());
chk(armB.ghosts.length === 1 && armB.ghosts[0] === '幽灵.mjs',
  '反证臂 B：文档点到"文件都没了"的那一个会被点名（能红）', JSON.stringify(armB.ghosts));

const armB2 = reverseFindings(new Set(['甲.mjs', '一次性的.mjs']), new Set(['test/甲.mjs']),
  new Set(['一次性的.mjs']), new Map());
chk(armB2.ghosts.length === 0 && armB2.unrun.length === 1,
  '反证臂 B⁻：文件还在、只是不在脚本里 ⇒ 不报红（这把尺子不会误伤说明性引用）',
  `ghosts=${JSON.stringify(armB2.ghosts)} unrun=${JSON.stringify(armB2.unrun)}`);

const armC = stemsMissing('这里只有 rollback 一个', new Set(['test/rollback.mjs', 'test/幽灵.mjs']));
chk(armC.length === 1 && armC[0] === 'test/幽灵.mjs',
  '反证臂 C：§0 漏写的那一个会被点名（能红）', JSON.stringify(armC));

const armD = staleFindings('这句话已经过期，后面什么都没有。', STALE_SYNTHETIC);
chk(armD.length === 2 && armD.some(f => f.kind === 'gone') && armD.some(f => f.kind === 'must'),
  '反证臂 D：旧话与"该在的话没了"两个方向各报一条（两个方向都能红）',
  JSON.stringify(armD.map(f => f.kind)));

// 反证臂 D″：拿**真表**过两段夹具正文 —— 一段是这句口径收口前的历史原话，
// 一段是收口之后的话。只要表里那两条正则写歪一个字，第一段就报不出两条（这条臂当场红）；
// 而第二段必须一条都不报（否则这把尺子会误伤已经改好的文档）。
const armDqOld = staleFindings('多实例编排：现在是一间一进程、外层大厅还没有。', DOC_PAIR_CLAIMS);
const armDqNew = staleFindings('一个进程 = 一个权威端 = 最多 MAX_ROOMS 间对局。', DOC_PAIR_CLAIMS);
chk(armDqOld.filter(f => f.kind === 'gone').length === 1
  && armDqOld.filter(f => f.kind === 'must').length === 1 && armDqNew.length === 0,
  '反证臂 D″：旧口径那段报出 gone+must 各一条、收口后那段一条不报（认得出、也不误伤）',
  `旧=${JSON.stringify(armDqOld.map(f => f.kind))} 新=${JSON.stringify(armDqNew.map(f => f.kind))}`);

const armE = tierFindings('**要真浏览器**：`甲` / `丙`\n', '要真浏览器', new Map([['甲', true], ['乙', true], ['丙', false]]));
chk(armE.missing.length === 1 && armE.missing[0] === '乙'
  && armE.extra.length === 1 && armE.extra[0] === '丙',
  '反证臂 E：名单里漏点的与多点名的各报一条（两个方向都能红）',
  `漏=${JSON.stringify(armE.missing)} 多=${JSON.stringify(armE.extra)}`);

// 反证臂 G：三段合成源码 —— ①只有"系统 Chrome + 本机绝对路径"两档（改动前 8 份的形状）⇒ 红；
// ②中间多一档交给 Playwright 自己解析 ⇒ 绿；③两档之外只有一句带 `${label}` 的模板串
// （它长得像一对花括号，若被当成一档，①就会误判成绿 ）⇒ 仍然红。
const armG1 = selfResolvedRung([
  'async function launch() {',
  "  const tries = [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/pyc/chrome.exe', args: ARGS }]];",
  '  for (const [label, opts] of tries) {',
  '    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }',
  '    catch (e) { console.log(`  ${label} 起不来: ` + e.message.split("\\n")[0]); }',
  '  }',
  "  throw new Error('没有可用浏览器');",
  '}'].join('\n'));
const armG2 = selfResolvedRung([
  'async function launch() {',
  "  const tries = [['chrome', { channel: 'chrome', args: ARGS }], ['playwright-chromium', { args: ARGS }]];",
  '  for (const [label, opts] of tries) {',
  '    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }',
  '    catch (e) { console.log(`  ${label} 起不来: ` + e.message.split("\\n")[0]); }',
  '  }',
  "  throw new Error('没有可用浏览器');",
  '}'].join('\n'));
chk(armG1.rungs.length === 2 && !armG1.ok && armG2.rungs.length === 2 && armG2.ok,
  '反证臂 G：只有系统 Chrome/本机路径 ⇒ 红；多一档交给 Playwright 自己解析 ⇒ 绿',
  `无回落：解析到 ${armG1.rungs.length} 档 ok=${armG1.ok}；有回落：解析到 ${armG2.rungs.length} 档 ok=${armG2.ok}`);
chk(armG1.rungs.every(o => /channel|executablePath/.test(o)),
  '反证臂 G⁻：模板串里的 `${label}` 不算一档（否则"有没有回落"会被它骗成恒绿）',
  `解析出来的 ${armG1.rungs.length} 档：${armG1.rungs.join(' / ')}`);

const armE2 = tierFindings('这一节里没有那一行。', '要真浏览器', new Map([['甲', true]]));
chk(armE2.line === '' && armE2.missing.length === 1,
  '反证臂 E⁻：整行被删掉 ⇒ 红，不是静默跳过', `line=${JSON.stringify(armE2.line)} 漏=${JSON.stringify(armE2.missing)}`);

const armF = rulersFindings([
  { id: '甲', file: '有.mjs', gone: [/这句话已经过期/], must: [/而这一句必须还在/] },
  { id: '乙', file: '没有这份.mjs', gone: [/x/], must: [/y/] },
], f => { if (f !== '有.mjs') throw new Error('读不到'); return '这句话已经过期，后面什么都没有。'; });
chk(armF.length === 3 && armF.filter(f => f.kind === 'gone').length === 2 && armF.some(f => f.kind === 'must'),
  '反证臂 F：旧写法命中 / 该在的新写法没了 / 源码读不到，三个方向各报一条（这条守卫能红）',
  JSON.stringify(armF.map(f => `${f.id}:${f.kind}`)));

console.log(`\n${fails ? 'RED' : 'GREEN'}  ${checks - fails}/${checks} 通过`);
process.exit(fails ? 1 : 0);
