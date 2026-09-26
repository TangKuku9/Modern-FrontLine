// 账号与防护的判据。不需要浏览器、不需要网络、不需要真的监听端口。
//
// 命题：**账号系统本身不提供反作弊**，它只是让"封人"第一次有可能。
// 所以这份判据量的一半不是"功能对不对"，而是"说防的那几样是不是真的防住了"。
//
// ── 为什么每条防护都得有一条会变红的判据 ──
// 这个模块里的防护**失效时全是静默的**：哈希弱一点、错误信息细一点、限流松一点，
// 都不报错、不崩、不变慢到有人察觉。只有被人打的那一天才知道。
// 所以每一条都得先被量出来，而且要有**反证臂** —— 证明这不是一条恒真绿灯。
//
// ── 一条与本题无关但很要命的元规则 ──
// 判"这批测试有没有红"**看退出码与结论行**，不要 grep 正文关键词。
// 通过项的名字里就带着"拒绝""失败""拒"这些字，grep 会把它们全标成红
// （lagcomp / mp-rules / deploy-probe 三个文件都中过这个招）。
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import {
  Accounts, RateLimiter,
  SCRYPT, hashPassword, verifyPassword, tokenHash,
  validName, normalizeName, nameKey, validPassword, PASSWORD_MAX,
} from '../server/accounts.mjs';
import { MemoryStore, SqliteStore } from '../server/store.mjs';

let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  | ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  | ' + detail : ''}`);
}
const sec = n => `\n── ${n} ──`;

// 逻辑时钟。**注入真时钟会让限流判据变成"看机器快慢"** —— 一个需要等 15 分钟
// 才能跑完的退避判据没人会跑，而它一旦变成"重试三次"就等于没在量退避。
let clock = 1_700_000_000_000;
const now = () => clock;
const tick = (ms = 400_000) => { clock += ms; };      // 400s 一次跨过登录窗口（300s）与常见退避

// 判据用的低配 scrypt。生产参数一次 ~100ms，每条判据都等的话整套测试慢到没人跑。
// 生产参数本身仍然被钉着 —— 见 A9/A10，那两条量的是"真的慢"，不是"慢被配过"。
const TEST_SCRYPT = Object.freeze({ N: 1 << 10, r: 8, p: 1, keylen: 64, maxmem: 32 * 1024 * 1024 });

function mk({ invite = 'SESAME', regMax = 500, loginMax = 500, scrypt = TEST_SCRYPT } = {}) {
  const store = new MemoryStore({ now });
  const acc = new Accounts({
    store, inviteCode: invite, now, scrypt,
    limiter: new RateLimiter({ windowMs: 3600_000, max: regMax, baseMs: 5000, maxBackoffMs: 3600_000 }),
    loginLimiter: new RateLimiter({ windowMs: 300_000, max: loginMax, baseMs: 1000, maxBackoffMs: 900_000 }),
  });
  return { store, acc };
}
const PW = 'a-long-enough-password';

// 有几条判据量不了耗时，只能审计源码里的做法（见 D5~D7 的说明）。
// 这是有意为之：量不出差的判据写成"看起来在量"，就是恒真绿灯。
const ACC_SRC = readFileSync(new URL('../server/accounts.mjs', import.meta.url), 'utf8');

// ══════════ A 密码哈希 ══════════
console.log(sec('A 密码哈希'));
{
  const { store, acc } = mk();
  const r1 = await acc.register({ name: 'Pyc', password: PW, code: 'SESAME', ip: '10.0.0.1' });
  const r2 = await acc.register({ name: 'Pyc2', password: PW, code: 'SESAME', ip: '10.0.0.2' });
  const u1 = store.getUser('pyc'), u2 = store.getUser('pyc2');
  chk(r1.ok && r2.ok, 'A1 注册成功（后面几条比的是它落库的形状）', `${r1.error || 'ok'} / ${r2.error || 'ok'}`);
  chk(u1 && u2, 'A2 两条记录都在库里');
  // 反证臂：salt 若写成常量，这里立刻相等 —— 那就是"彩虹表一次算好打穿所有人"
  chk(u1.salt !== u2.salt, 'A3 同一个密码两次注册，salt 不同（salt 不是常量）');
  chk(u1.hash !== u2.hash, 'A4 同一个密码两次注册，hash 也不同（这说明 salt 真的进了哈希）');
  chk(!JSON.stringify(u1).includes(PW), 'A5 库里没有任何地方出现明文密码');
  chk(u1.algo === 'scrypt' && u1.N === TEST_SCRYPT.N && u1.r === TEST_SCRYPT.r,
    'A6 参数随记录一起存（以后提高强度时老账号还登得进来）', `${u1.algo} N=${u1.N} r=${u1.r}`);
  chk(await verifyPassword(PW, u1), 'A7 正确密码通过');
  chk(!(await verifyPassword(PW + 'z', u1)), 'A8 错一个字符就不通过（反证臂：不是"随便什么都过"）');
  chk(!(await verifyPassword('', u1)), 'A9 空密码不通过');
  chk(u1.keylen >= 32, 'A10 输出长度 ≥ 32 字节', `${u1.keylen}`);
}

// A11/A12 用**生产参数**量"故意慢"这件事。这是唯一一条不能注入低配的判据 ——
// 它要钉的就是"生产参数没被偷偷调小"。反证臂：把 SCRYPT 的 N 改成 1<<10，
// A11 立刻红（同时上面所有用低配的判据仍然全绿 —— 这正是它们该有的样子）。
{
  const t0 = performance.now();
  const rec = await hashPassword('some password here');
  const ms = performance.now() - t0;
  const mib = 128 * rec.N * rec.r / 1048576;
  chk(ms > 20, 'A11 生产参数下一次哈希真的慢（不是 sha256 那种快哈希）',
    `${ms.toFixed(1)} ms · N=2^${Math.log2(rec.N)} · 每次吃 ${mib.toFixed(0)} MiB`);
  chk(mib >= 16, 'A12 每次验证都吃掉几十 MiB 内存（这是它抗 GPU/ASIC 并行的来源，不是副产品）', `${mib.toFixed(0)} MiB`);
  const t1 = performance.now();
  await verifyPassword('some password here', rec);
  chk(performance.now() - t1 > 20, 'A13 验证也慢（不然"猜"这一侧就免费了）');
}

// ══════════ B 会话令牌 ══════════
console.log(sec('B 会话令牌'));
{
  const { store, acc } = mk();
  const r = await acc.register({ name: 'Tok', password: PW, code: 'SESAME', ip: '10.1.0.1' });
  chk(r.ok && typeof r.token === 'string' && r.token.length >= 40, 'B1 令牌是长随机串', `${(r.token || '').length} 字符`);
  chk(r.token !== (await acc.register({ name: 'Tok2', password: PW, code: 'SESAME', ip: '10.1.0.2' })).token,
    'B2 两次发的令牌不同（不是固定串）');
  // 这条是整个 B 段的核心：库里存的是 sha256，不是原文。
  const dump = JSON.stringify([...store.sessions.entries()]);
  chk(!dump.includes(r.token), 'B3 库里不存令牌原文（存的是它的 sha256）—— 泄库了也不能直接拿去登录');
  chk(dump.includes(tokenHash(r.token)), 'B4 store 里那一格确实是这个令牌的 sha256（反证臂：证明 B3 不是因为"压根没存"）');
  const me = await acc.whoami(r.token);
  chk(me && me.name === 'Tok', 'B5 令牌能换回用户');
  chk((await acc.whoami('x'.repeat(43))) === null, 'B6 伪造的令牌换不回（反证臂：不是"任何令牌都通过"）');
  chk((await acc.whoami('')) === null && (await acc.whoami(null)) === null, 'B7 空令牌／没有令牌换不回');
  const r2 = await acc.register({ name: 'Tok3', password: PW, code: 'SESAME', ip: '10.1.0.3' });
  await acc.logout(r2.token);
  chk((await acc.whoami(r2.token)) === null, 'B8 登出之后那个令牌立刻作废');
  chk((await acc.whoami(r.token)) !== null, 'B9 反证臂：登出只作废自己的令牌，别人的还在（不是"一登出清全场"）');
  const r3 = await acc.register({ name: 'Tok4', password: PW, code: 'SESAME', ip: '10.1.0.4' });
  tick(31 * 24 * 3600_000);
  chk((await acc.whoami(r3.token)) === null, 'B10 过期令牌换不回', 'TTL 30 天，推进 31 天');
  clock = 1_700_000_000_000;
  chk(tokenHash('abc').length === 64 && tokenHash('abc') === tokenHash('abc'), 'B11 tokenHash 稳定且是 64 位 hex');
}

// ══════════ C 不泄露"这个呼号存不存在" ══════════
// 这一段的每一条都在挡同一个东西：把登录接口变成**账号枚举器**。
// 先用它把"哪些呼号存在"问出来，再把撞库火力集中到那几个账号上。
console.log(sec('C 不泄露账号是否存在'));
{
  // 这一段必须用生产参数：计时差只有在哈希真的慢的时候才量得清楚。
  const { acc } = mk({ scrypt: SCRYPT });
  await acc.register({ name: 'Real', password: PW, code: 'SESAME', ip: '10.2.0.1' });
  const e1 = await acc.login({ name: 'Real', password: 'wrong-password-x', ip: '10.2.0.9' });
  const e2 = await acc.login({ name: 'NoSuchUser', password: 'wrong-password-x', ip: '10.2.0.9' });
  chk(e1.error === e2.error, 'C1 "密码错"与"这呼号不存在"返回**同一句话**', `${e1.error} / ${e2.error}`);
  chk(e1.error === 'bad_credentials', 'C2 那句话本身不含任何方向（不是"用户不存在"也不是"密码错误"）', e1.error);
  chk(!/salt|hash|algo/.test(JSON.stringify(e1)), 'C3 响应里不含 salt/hash/algo', JSON.stringify(e1));

  const med = async (fn, n = 3) => {
    const s = [];
    for (let i = 0; i < n; i++) { tick(); const a = performance.now(); await fn(); s.push(performance.now() - a); }
    s.sort((x, y) => x - y); return s[(n / 2) | 0];
  };
  const tExist = await med(() => acc.login({ name: 'Real', password: 'wrong-password-x', ip: '10.2.1.1' }));
  const tGhost = await med(() => acc.login({ name: 'Ghost', password: 'wrong-password-x', ip: '10.2.1.2' }));
  const ratio = Math.max(tExist, tGhost) / Math.max(0.05, Math.min(tExist, tGhost));
  // 反证臂：verifyPassword 里那段"用户不存在也要跑一次真哈希"删掉，比值会跳到 50 倍以上。
  chk(ratio < 2.5, 'C4 两个分支耗时同量级 —— 用户不存在时也真跑了一次哈希',
    `存在 ${tExist.toFixed(1)} ms · 不存在 ${tGhost.toFixed(1)} ms · 比 ${ratio.toFixed(2)}×`);
  clock = 1_700_000_000_000;
}

// ══════════ D 邀请码 ══════════
console.log(sec('D 邀请码'));
{
  const { acc } = mk({ invite: 'OPEN-SESAME' });
  chk((await acc.register({ name: 'D1', password: PW, code: 'OPEN-SESAME', ip: '10.3.0.1' })).ok,
    'D1 邀请码对就放行');
  const bad = await acc.register({ name: 'D2', password: PW, code: 'open-sesame', ip: '10.3.0.2' });
  const none = await acc.register({ name: 'D3', password: PW, code: '', ip: '10.3.0.3' });
  const short = await acc.register({ name: 'D4', password: PW, code: 'OPEN-SESAM', ip: '10.3.0.4' });
  chk(bad.error === 'bad_invite', 'D2 邀请码错就拒（大小写敏感）', bad.error);
  // 这三条返回**同一句话**：分开的话这个接口就成了"这个邀请码对不对"的在线验证器，
  // 可以离线爆破到对为止 —— 而邀请码通常是短字符串，熵本来就低。
  chk(none.error === bad.error && short.error === bad.error,
    'D3 空邀请码 / 长度不同的邀请码，都返回和"错"完全相同的一句话（长度也不泄露）',
    `${none.error} / ${short.error}`);
  const { acc: open } = mk({ invite: '' });
  chk((await open.register({ name: 'D5', password: PW, code: '', ip: '10.3.0.5' })).ok,
    'D4 邀请码留空 = 开放注册（公开运营时才这么配）');
  // ── D5 恒定时间比较：这一条**不能靠计时量** ──
  // 试过了：错在第一个字符和错在最后一个字符，两条路径都在 0.01 ms 量级 ——
  // 11 字节的字符串比较本身就在测量噪声以下，比值在 0.5~2 之间乱跳，量不出任何东西。
  // 写成"比值 < 3"是一条**恒真绿灯**：它永远不会红，于是什么都没保证。
  // 所以改成审计源码里的**做法**，而不是量它的**耗时**。审计是有牙齿的 ——
  // 谁把它"简化"成 `code === this.inviteCode`，下面第一条立刻红。
  chk(!/this\.inviteCode\s*===/.test(ACC_SRC) && !/inviteCode\s*===\s*/.test(ACC_SRC),
    'D5 邀请码没有拿 === 去比（=== 在第一个不同的字符上就返回，那是逐字符可搜的）');
  chk(/timingSafeEqual\(/.test(ACC_SRC),
    'D6 用的是恒定时间比较（审计源码，不是量耗时 —— 量耗时的那个版本是恒真绿灯）');
  // ── D7 这是整个模块最要紧的一条 ──
  // scryptSync 会把事件循环**停住** ~100ms，而同一个进程里跑着 60 拍/秒的权威 sim。
  // 100 个人同时登录 ⇒ 主线程停 10 秒 ⇒ 所有房间一起掉拍。
  // 这条判据的红**不会以任何别的形式出现**：不崩、不报错、功能全对，只是所有房间一起卡。
  // 所以它必须在源码这一层钉住，而不是等哪天真被人打出来。
  // （`(?<![\w.])` 是为了不误伤注释里那个词 —— 注释里写的是 `scryptSync：`，没有左括号。）
  chk(!/(?<![\w.])scryptSync\s*\(/.test(ACC_SRC),
    'D7 全模块没有一处用 scryptSync（同步哈希会把 60 拍/秒的 tick 循环停住）');
  clock = 1_700_000_000_000;
}

// ══════════ E 限流与退避 ══════════
console.log(sec('E 限流与退避'));
{
  const { acc } = mk({ regMax: 3 });
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await acc.register({ name: 'R' + i, password: PW, code: 'SESAME', ip: '10.4.0.1' }));
  chk(res.filter(r => r.ok).length === 3, 'E1 注册窗口：前 3 次过', String(res.filter(r => r.ok).length));
  chk(res[3].error === 'too_many' && res[4].error === 'too_many', 'E2 第 4、5 次被拒', res.map(r => r.error || 'ok').join(','));
  chk(res[3].retryAfterMs > 0, 'E3 拒绝时给出还要等多久（不是干拒）', `${res[3].retryAfterMs} ms`);
  const other = await acc.register({ name: 'R9', password: PW, code: 'SESAME', ip: '10.4.0.2' });
  // 反证臂：如果限的是全局而不是 IP，这一条会红 —— 那等于"一个人把所有人挡在门外"。
  chk(other.ok, 'E4 反证臂：换一个 IP 就能过 —— 限的是 IP 维度，不是"一个人拖垮所有人"');
  // 窗口是用滑动时间，不是计数到天亮
  tick(3600_001);
  chk((await acc.register({ name: 'R10', password: PW, code: 'SESAME', ip: '10.4.0.1' })).ok,
    'E5 窗口滑过去之后自己恢复（不是"被拒一次就永久拉黑"）');
  clock = 1_700_000_000_000;
}

{
  // 退避必须**指数**增长：线性的"每失败一次等 1 秒"，试 1000 次也就等 1000 秒，脚本等得起。
  const { acc } = mk({ loginMax: 1000 });
  await acc.register({ name: 'Victim', password: PW, code: 'SESAME', ip: '10.5.0.1' });
  const delays = [];
  for (let i = 0; i < 8; i++) {
    const r = await acc.login({ name: 'Victim', password: 'wrong-password-x', ip: '10.5.9.9' });
    delays.push(r.retryAfterMs | 0);
    tick(Math.max(1, r.retryAfterMs | 0) + 1);        // 等过这一段再来，才看得到下一次的退避
  }
  chk(delays[0] === 0 && delays[1] === 0 && delays[2] === 0,
    'E6 前三次打错密码不惩罚（自己人也会打错）', JSON.stringify(delays));
  chk(delays[3] > 0, 'E7 第四次开始要等', `${delays[3]} ms`);
  chk(delays[4] >= delays[3] * 2 && delays[5] >= delays[4] * 2 && delays[6] >= delays[5] * 2,
    'E8 退避是**指数**的，不是线性的', JSON.stringify(delays));
  clock = 1_700_000_000_000;
}

{
  // 上限：单独的限流器，免得把上一条的读数搅进来
  const rl = new RateLimiter({ baseMs: 1000, maxBackoffMs: 4000 });
  const ds = [];
  for (let i = 0; i < 9; i++) ds.push(rl.fail('k', i).retryAfterMs);
  chk(ds[6] === 4000 && ds[8] === 4000, 'E9 退避有上限（否则一次误伤能把玩家关到明年）', JSON.stringify(ds));
}

{
  // ── E10 退避时长**不会因为对方继续打而变长** ──
  // 这是个很具体的洞，值得单独一条：如果实现把 fail() 放在 blocked() 检查**之前**，
  // 攻击者只要持续发请求，就能一路把 until 往后推 —— 于是**他可以把受害者的账号永久锁死**，
  // 而受害者自己连登都登不进来（"我密码没错啊"）。这叫 account lockout DoS。
  // 反证臂：把这一行提到检查之前，E10 立刻红。
  const { acc } = mk({ loginMax: 1000 });
  await acc.register({ name: 'Lock', password: PW, code: 'SESAME', ip: '10.6.0.1' });
  for (let i = 0; i < 5; i++) await acc.login({ name: 'Lock', password: 'wrong-password-x', ip: '10.6.9.9' });
  const first = (await acc.login({ name: 'Lock', password: 'wrong-password-x', ip: '10.6.9.9' })).retryAfterMs | 0;
  let grew = 0, leaked = 0;
  for (let i = 0; i < 60; i++) {
    const r = await acc.login({ name: 'Lock', password: 'wrong-password-x', ip: '10.6.9.9' });
    if ((r.retryAfterMs | 0) > first) grew++;
    if (r.error !== 'too_many') leaked++;
  }
  chk(grew === 0, 'E10 退避期间继续打 60 次，退避时长一次都没变长（否则攻击者能把受害者账号永久锁死）',
    `first=${first} ms · 变长 ${grew} 次`);
  chk(leaked === 0, 'E11 退避期间 60 次请求没有一次被放行去做真验证（没有"洗白"的窗口）', `放行 ${leaked} 次`);
  clock = 1_700_000_000_000;
}

{
  // ── E12 限流表自己有上限 ──
  // 否则限流器本身就是一个内存放大器："每个不同的呼号试一次"就能往表里塞任意多条记录。
  const rl = new RateLimiter({ windowMs: 60_000, max: 5, maxKeys: 200 });
  for (let i = 0; i < 5000; i++) rl.hit('name-' + i, i * 10);
  chk(rl.size <= 400, 'E12 限流表有上限（5000 个不同 key 之后没有无限长大）', `size=${rl.size}`);
}

{
  // ── E13 并发闸门 ──
  // 密码哈希吃 libuv 线程池，而线程池同时还要服务静态文件。不设上限的话，
  // 一场登录高峰会把线程池占满 —— 表现是"静态资源莫名变慢"，跟登录看不出关系。
  // 这里用生产参数（哈希真的慢），32 个并发注册应当恰好放行 8 个、其余的当场拒绝。
  const { acc } = mk({ scrypt: SCRYPT, regMax: 1000 });
  const rs = await Promise.all(Array.from({ length: 32 }, (_, i) =>
    acc.register({ name: 'C' + i, password: PW, code: 'SESAME', ip: '10.7.0.' + i })));
  const busy = rs.filter(r => r.error === 'busy').length;
  const okn = rs.filter(r => r.ok).length;
  chk(busy === 24 && okn === 8, 'E13 32 个并发注册：恰好 8 个拿到哈希名额，24 个被当场拒（不排队）',
    `ok=${okn} busy=${busy}`);
  chk(acc.stat.busy === 24, 'E14 busy 有计数（"服务器忙"是静默的，运维只能从这里看见）', String(acc.stat.busy));
  const after = await acc.register({ name: 'C99', password: PW, code: 'SESAME', ip: '10.7.9.9' });
  chk(after.ok, 'E15 高峰过去之后闸门自己恢复（名额没漏掉——漏了的话并发数会永远比 8 少）');
}

// ══════════ F 呼号 ══════════
console.log(sec('F 呼号'));
{
  chk(validName('Pyc') && validName('玩家一号') && validName('a_b-c') && validName('x'.repeat(16)),
    'F1 合法呼号：字母数字、汉字、下划线连字符、长度上限 16');
  chk(!validName('a') && !validName('') && !validName('x'.repeat(17)),
    'F2 长度边界：1 拒 / 2 收 / 16 收 / 17 拒');
  // 这三条是"视觉冒充"的来源。零宽字符**看不见**，所以它在截图和记分板上都无法人工发现。
  chk(!validName('张三\u200b'), 'F3 零宽字符被拒 —— 不然"张三"可以冒充"张三"（记分板上长得一模一样）');
  chk(!validName('张\n三'), 'F4 换行被拒 —— 不然一个呼号能把记分板排版撑坏');
  chk(!validName('\u0000abc') && !validName('a\u202eb'), 'F5 控制字符与双向覆写符被拒');
  chk(!validName('<script>x'), 'F6 尖括号被拒（呼号会进记分板 HTML）');
  chk(normalizeName('ＡＢＣ') === 'ABC', 'F7 NFKC 归一：全角字母变半角（同形冒充的另一个来源）', normalizeName('ＡＢＣ'));
  chk(nameKey('Pyc') === nameKey('pyc'), 'F8 唯一性与查找按小写');

  const { acc } = mk();
  await acc.register({ name: 'Pyc', password: PW, code: 'SESAME', ip: '10.8.0.1' });
  const dup = await acc.register({ name: 'pyc', password: PW, code: 'SESAME', ip: '10.8.0.2' });
  chk(dup.error === 'name_taken', 'F9 大小写不同但看起来一样的呼号不能重复注册', dup.error);
  const dup2 = await acc.register({ name: 'Ｐｙｃ', password: PW, code: 'SESAME', ip: '10.8.0.3' });
  chk(dup2.error === 'name_taken', 'F10 全角写法也拦得住（NFKC 之后是同一个 key）', dup2.error);
  const li = await acc.login({ name: 'PYC', password: PW, ip: '10.8.0.9' });
  chk(li.ok && li.name === 'Pyc', 'F11 用任意大小写都能登录，但返回的是注册时那一个（显示形状不由输入决定）',
    `${li.error || li.name}`);
  chk(validPassword('x'.repeat(8)) && !validPassword('x'.repeat(7)), 'F12 密码长度下限 8');
  chk(!validPassword('x'.repeat(PASSWORD_MAX + 1)), 'F13 密码长度上限（不设的话一个 10 MB 的"密码"就是一次内存放大）');
}

// ══════════ G 战绩（只由服务端加） ══════════
console.log(sec('G 战绩'));
{
  const { acc } = mk();
  await acc.register({ name: 'Hero', password: PW, code: 'SESAME', ip: '10.9.0.1' });
  const p1 = acc.addResult('hero', { xp: 1200, kills: 12, deaths: 3, win: true });
  chk(p1.xp === 1200 && p1.kills === 12 && p1.matches === 1 && p1.wins === 1 && p1.deaths === 3,
    'G1 一局结算累加', JSON.stringify(p1));
  const p2 = acc.addResult('hero', { xp: 1e9, kills: 1e9 });
  chk(p2.xp === 1200 + 20000, 'G2 单局经验有上限（"一局一亿"那种上报不兑现）', `${p2.xp}`);
  chk(p2.kills === 12 + 500, 'G3 单局击杀也有上限', `${p2.kills}`);
  chk(acc.addResult('hero', { deaths: -5 }).deaths === 3, 'G4 负数被夹住而不是倒扣（clamp，不是累加）');
  chk(acc.addResult('nobody', { xp: 100 }) === null, 'G5 不存在的账号不会凭空建出来');
  chk(!('salt' in p2) && !('hash' in p2) && !('key' in p2) && !('algo' in p2),
    'G6 publicProfile 不含 salt/hash/key/algo —— 少发一个字段不会出错，多发一个收不回来');
  const p3 = acc.addResult('hero', { win: true });
  // 到这里 addResult 一共被调过 3 次（G1、G2/G3 合起来一次、G4），所以这是第 4 场。
  // 第一版这里写的是 3/3 —— 我把 G2 和 G3 当成两次调用了。**错的是量具**。
  chk(p3.matches === 4 && p3.wins === 2, 'G7 空结算也算一场（matches 会涨），且不产生 xp', JSON.stringify(p3));
}

// ══════════ H SQLite 落地 ══════════
console.log(sec('H SQLite 落地'));
{
  let DatabaseSync = null;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 下面会说明为什么跳过 */ }
  if (!DatabaseSync) {
    console.log('  (这个 Node 没有 node:sqlite，H 段跳过 —— 上面 A~G 量的是同一个 accounts.mjs)');
  } else {
    const dir = join(tmpdir(), `mf-acc-${process.pid}-${Date.now()}`);
    const file = join(dir, 'acc.db');
    const cleanup = () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(file + s); } catch {} } try { rmSync(dir, { recursive: true }); } catch {} };
    // ⚠ SqliteStore 也要注入同一个假时钟。
    // 不给的话它用真的 Date.now()（2026 年），而这里 Accounts 用的是假时钟（1.7e12）——
    // 差着大半年，于是**刚建出来的会话在 _load / 刷盘时被判成"已过期"当场删掉**。
    // 症状是"登录成功了，下一次请求就说不认识你"，而两边代码单独看都没毛病。
    // 生产里两者都默认 Date.now，天然一致；这个坑只在注入时钟的时候露头。
    // H10 第一次就是这么红的 —— **量具的错**，不是被测对象的错。
    try {
      const s1 = new SqliteStore({ file, idleMs: 3600_000, DatabaseSync, now });
      s1.putUser('a', { key: 'a', name: 'A', algo: 'scrypt', N: 1024, r: 8, p: 1, keylen: 64, salt: 'st', hash: 'h', created: 1, xp: 7, kills: 0, deaths: 0, matches: 0, wins: 0 });
      const probe = new DatabaseSync(file);
      const rowsBefore = probe.prepare('select count(*) c from users').get().c;
      probe.close();
      chk(rowsBefore === 0, 'H1 只写内存、还没刷盘时磁盘上确实没有（证明"攒批"不是假的）', `rows=${rowsBefore}`);
      chk(s1.pending > 0, 'H2 待刷计数会涨（不然 H1 可能是因为压根没记下来）', `pending=${s1.pending}`);
      const n = s1.flush();
      chk(n >= 1, 'H3 刷盘写下去至少一条', `n=${n}`);
      const probe2 = new DatabaseSync(file);
      const rowsAfter = probe2.prepare('select count(*) c from users').get().c;
      probe2.close();
      chk(rowsAfter === 1, 'H4 刷盘之后磁盘上有了', `rows=${rowsAfter}`);

      // ── H5 单批上限 ──
      // "攒批"如果只按时间触发，会有个反直觉的坑：一次雪崩之后队列里堆了 500 条，
      // 下一次刷盘**一次写完** —— 那一刷自己就把主线程停了几百毫秒。
      for (let i = 0; i < 500; i++) s1.putUser('b' + i, { key: 'b' + i, name: 'B' + i, algo: 'scrypt', N: 1024, r: 8, p: 1, keylen: 64, salt: 's', hash: 'h', created: 1, xp: 0, kills: 0, deaths: 0, matches: 0, wins: 0 });
      const first = s1.flush();
      chk(first === 200, 'H5 单批刷盘有上限：500 条待写，第一次只写 200', `n=${first}`);
      chk(s1.pending === 300, 'H6 剩下的 300 条留在队列里等下一轮（不是丢了）', `pending=${s1.pending}`);
      // 循环只在拼 300 这个数。注意第 351 行那次 flush 已经把 200 条写掉了，
      // 所以循环里再写的只能是剩下的 300 —— 第一版我写成"循环共写 500"，
      // 把进循环前那一批也算进去了。**错的是量具**。
      let guard = 0, total = 0, r;
      while (s1.pending && guard++ < 100) { r = s1.flush(); if (r < 0) break; total += r; }
      chk(s1.pending === 0, 'H7 循环刷完之后队列空（一条不剩）', `刷了 ${guard} 轮`);
      chk(total === 300, 'H8 剩下的 300 条全刷下去了（不是被丢掉）', `循环内共写 ${total} 条`);
      // ── H8 关服要把脏数据推下去 ──
      // 不做的话"正常关服"和"被 kill -9"一样丢数据 —— 那"最多丢 250ms"的立账就是空话。
      s1.putUser('c', { key: 'c', name: 'C', algo: 'scrypt', N: 1024, r: 8, p: 1, keylen: 64, salt: 's', hash: 'h', created: 1, xp: 42, kills: 0, deaths: 0, matches: 0, wins: 0 });
      s1.close();
      const s2 = new SqliteStore({ file, idleMs: 3600_000, DatabaseSync, now });
      chk(s2.getUser('c') && s2.getUser('c').xp === 42, 'H8b close() 把未刷盘的写入推下去了（重启读得到）', `xp=${s2.getUser('c') && s2.getUser('c').xp}`);
      chk(s2.countUsers() === 502, 'H9 重开库载入的行数对得上', `loaded=${s2.countUsers()}`);

      // ── H10 过期会话不载入、且顺手删掉 ──
      s2.createSession('tok-live', 'a', now() + 1000);
      s2.createSession('tok-dead', 'a', now() - 1000);
      s2.flush();
      s2.close();
      const s3 = new SqliteStore({ file, idleMs: 3600_000, DatabaseSync, now });
      chk(s3.getSession('tok-live') !== null, 'H10 未过期会话载得回来');
      chk(s3.getSession('tok-dead') === null, 'H11 过期会话不载入（清了，不然这张表随每次登录单调长大）');
      s3.deleteSession('tok-live'); s3.flush();
      chk(s3.getSession('tok-live') === null, 'H12 删会话之后读不到');
      s3.close();

      // ── H13 账号内核跑在 SQLite 后端上也是同一套行为 ──
      const acc = new Accounts({
        store: new SqliteStore({ file, idleMs: 3600_000, DatabaseSync, now }),
        inviteCode: 'SESAME', now, scrypt: TEST_SCRYPT,
      });
      const rg = await acc.register({ name: 'DbUser', password: PW, code: 'SESAME', ip: '10.10.0.1' });
      chk(rg.ok && (await acc.whoami(rg.token)) !== null,
        'H13 accounts.mjs 换到 SQLite 后端上行为一致（一份逻辑配两个后端，不是测试里抄了一份）');
      await acc.logout(rg.token);
      chk((await acc.whoami(rg.token)) === null, 'H14 SQLite 后端上的登出也立刻生效');
    } finally { cleanup(); }
  }
}

// ══════════ I 计数都落在可观测面上 ══════════
console.log(sec('I 计数'));
{
  const { acc } = mk();
  await acc.register({ name: 'ok-name', password: 'short', code: 'SESAME', ip: '10.11.0.1' });
  await acc.register({ name: 'ok-name2', password: PW, code: 'WRONG', ip: '10.11.0.2' });
  await acc.register({ name: '张三\u200b', password: PW, code: 'SESAME', ip: '10.11.0.3' });
  chk(acc.stat.rejects.bad_password === 1 && acc.stat.rejects.bad_invite === 1 && acc.stat.rejects.bad_name === 1,
    'I1 拒绝是有分类计数的（每一类对应一种成因，修法各不相同）', JSON.stringify(acc.stat.rejects));
  chk(acc.stat.regs === 0, 'I2 全被拒的时候 regs 保持 0（它红了说明有一条路径拿走了请求却没记账）');
  chk(acc.stat.scryptN >= 0 && acc.stat.scryptMs >= 0, 'I3 哈希耗时与次数有累计（运维要能看出"是不是有人在刷哈希"）',
    `${acc.stat.scryptN} 次 / ${acc.stat.scryptMs} ms`);
}

console.log('');
if (fails) { console.log(`RED  ${checks - fails}/${checks} 通过，${fails} 条失败`); process.exit(1); }
console.log(`GREEN  账号与防护：${checks}/${checks} 通过`);
