// 账号内核：注册 / 登录 / 会话 / 限流。纯逻辑，唯一的依赖是 node:crypto，
// 存储从外面注入（server/store.mjs 是 SQLite，test/accounts.mjs 用内存那一份）。
//
// 为什么把存储抽出来：一份逻辑配两个后端，比"测试里再抄一遍规则"可靠得多。
// 抄一份的症状是**规则改了、判据跟着改**，而被判的那段代码从来没跑过 —— 那种绿是假的。
//
// ── 这个模块里每一条防护都对应一个具体攻击，而且**失效时全是静默的** ──
// 哈希弱一点、错误信息细一点、限流松一点，都不会报错、不会崩、不会变慢到有人发现。
// 只有被人打的那一天才知道。所以每条都写着成因，而不是写着"安全最佳实践"。
//
// ── 为什么不做验证码 / 邮箱 / 2FA ──
// 这一版的注册门槛是**邀请码**（环境变量 JOIN_CODE）。脚本刷号的动机是卖号和占名，
// 而邀请码把"刷"这件事的单位成本从"一次 HTTP 请求"抬到了"搞到一个邀请码"。
// 验证码的边际收益不如它，还会挡住你真正想让人进来的朋友；邮箱验证要接 SMTP，
// 多一个外部依赖 + 一批投递失败要处理。这三样在有公开运营需求之前都不值得做。
//
// ── 威胁模型（写清楚，免得防护做歪）──
// 真会被打的不是注册接口（刷一万个号的代价是几 MB 磁盘），是**每拍在跑的权威 sim**。
// 所以本模块最要紧的一条设计不是"密码哈希用什么"，而是**密码哈希不许阻塞事件循环**，
// 详见下面 scrypt 那一段。

import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto';

// ── scrypt 参数 ──
// 为什么是 scrypt 而不是 sha256：sha256 是**快**哈希（每秒几十亿次），
// 它做的正好是撞库的人想做的事。密码哈希要**故意慢**、**故意吃内存**，
// 把"猜一次"的代价从纳秒抬到几十毫秒；scrypt 的 N 就是这个旋钮，
// 而它的内存开销会把 GPU/ASIC 集群对 CPU 的优势从三个数量级压到个位数倍。
//
// N = 2^15 ⇒ 128 * N * r = 32 MiB/次。这是"每次验证都要吃掉 32 MB 内存"的意思，
// 也是它抗并行的来源。
//
// maxmem 必须显式给：默认上限是 32 MiB，而 128*N*r 正好等于 32 MiB —— 贴着边界，
// 换一个 Node 小版本就可能开始抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
export const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 });

// ── 为什么用异步 scrypt，不用 scryptSync ──
// 这是整个模块里最要紧的一行注释。
//
// scryptSync 把事件循环**停住** ~100ms。而同一个进程里跑着 60 拍/秒的权威 sim。
// 100 个人同时登录 ⇒ 主线程停 10 秒 ⇒ **所有房间一起掉拍**。
// 这比"一个客户端狂发输入帧"狠得多，而且它长得完全不像攻击 —— 就是一次登录高峰。
// 异步版走 libuv 线程池，主线程照常推进 sim。
//
// 代价是它把线程池也吃掉了，而线程池**同时还要服务静态文件读取**。
// 所以下面还要一个并发闸门（不设的话表现是"静态资源莫名变慢"，和登录看不出关系）。
function scryptAsync(password, salt, params = SCRYPT) {
  return new Promise((res, rej) => {
    _scrypt(password, salt, params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (e, k) => (e ? rej(e) : res(k)));
  });
}

// 并发闸门：libuv 线程池默认 4 条。宁可**拒绝**（给一句明确的"服务器忙，稍后再试"），
// 也不要无上限排队 —— 排队的表现是"所有人的登录都变得很慢"，
// 而慢和攻击之间没有可见的联系，运维会先去查数据库。
const MAX_INFLIGHT = 8;
let inflight = 0;

// ── 呼号白名单 ──
// 以前是 String(msg.name).slice(0, 24)：那允许零宽字符（U+200B）和换行，
// 于是"张三"可以冒充"张三"（后者夹了一个看不见的字符），记分板上**长得一模一样**。
// 零宽字符是看不见的，所以这种冒充在截图和记分板上都无法人工发现 ——
// 只能靠白名单从源头挡掉。
//
// 先 NFKC 归一：全角 'Ａ' 会变成 'A'，否则"用同形字冒充"又多一个来源。
const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,16}$/;

// 拒绝时给人看的**那一句话，只有这一份**。
// 两处会用到它：注册被拒（HTTP 层，见 http-api.mjs 的 ERRORS.bad_name）与
// 访客可玩的服上"自报呼号不合法"被拒（WS 层，见 net-server.mjs 的 joinName）。
// 各抄一份的症状不是崩，是慢慢分叉 —— 而玩家看到的会是"同一个规则、两句不一样的话"，
// 于是他会以为其中有哪一句在说别的事。判据在 test/hardening.mjs 的 G 段（比两个来源的实际文案）。
export const NAME_RULE_TEXT = '呼号只能用 2~16 个汉字、字母、数字、下划线或连字符';

export function normalizeName(raw) {
  return String(raw == null ? '' : raw).normalize('NFKC').trim();
}

export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// 呼号**保留大小写**，但唯一性与查找按小写 —— 否则 'Pyc' 和 'pyc' 是两个账号，
// 而玩家看起来是同一个人，冒充就是顺手的事。（这和"记分板上显示什么"是两件事。）
export function nameKey(name) {
  return name.normalize('NFKC').toLowerCase();
}

// ── 密码长度 ──
// 下限 8 是常识；上限 128 不是常识，它是个 DoS 闸门：
// 不设上限的话，一个 10 MB 的"密码"会让服务端为它分配和哈希一大段内存。
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= PASSWORD_MIN && pw.length <= PASSWORD_MAX;
}

// ── 密码的存储形状 ──
// 存的是 { algo, N, r, p, salt, hash }。把参数一起存进去，是为了以后调高 N 时
// **老账号还能登录** —— 否则提高强度就等于把所有人锁在门外。
// 这是"参数是可升级的"这条设计的具体形式，不是把常数写死在代码里。
export async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, params);
  return {
    algo: 'scrypt', N: params.N, r: params.r, p: params.p, keylen: params.keylen,
    salt: salt.toString('base64'), hash: key.toString('base64'),
  };
}

// 恒定时间比较。用 `===` 比 hash 字符串会在第一个不同的字节上返回，
// 于是"猜得越接近返回得越快"——把一次性的对错判断变成了可逐字节搜索的接口。
// 对 64 字节的 hash 来说这在实际网络里很难利用，但代价只有一个函数调用。
function safeEqual(a, b) {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// 用户不存在时，也要跑一次**真哈希**再返回失败。
//
// 不跑的话："这个呼号不存在"立刻返回，而"密码不对"要 100ms ——
// **响应时间本身就是一个账号枚举器**。它比错误信息更难发现：错误信息还能 grep，
// 计时差只能量。下面这个常量密码就是喂给它跑的那一份垃圾输入。
const DUMMY_PW = 'stub-password-for-timing-equalization';

// 验证时**优先用这条记录自己带的参数**，其次才是调用方的默认值。
// 顺序反过来的话，params 会盖掉记录里的 N —— 于是"提高强度"这个动作等于
// 把所有老账号锁在门外（他们的 hash 是用旧 N 算的，用新 N 去验必然不通过），
// 而症状只是"老用户全部登录失败"，没有任何一条日志会指向 scrypt 参数。
export async function verifyPassword(password, rec, params) {
  const p = (rec && rec.N)
    ? { N: rec.N, r: rec.r, p: rec.p, keylen: rec.keylen || 64, maxmem: Math.max(SCRYPT.maxmem, 128 * rec.N * rec.r * 2) }
    : (params || SCRYPT);
  if (!rec || !rec.salt || !rec.hash) {
    // 拿一个固定 salt 跑一次，把耗时补到和真验证同量级
    await scryptAsync(DUMMY_PW, Buffer.from('0000000000000000', 'base64'), p).catch(() => {});
    return false;
  }
  const key = await scryptAsync(password, Buffer.from(rec.salt, 'base64'), p);
  return safeEqual(key.toString('base64'), rec.hash);
}

// ── 会话令牌 ──
// 发出去的原文是 32 字节随机（base64url 43 字符），**库里只存它的 sha256**。
// 泄库了也不能直接拿去登录 —— 和密码一样的道理，但这里可以用快哈希：
// 令牌是 256 位均匀随机，**没有"弱口令空间"可枚举**，快哈希足够。
// 密码不行，因为密码是人选的，熵低。这个区别就是"为什么两个地方用不同的哈希"。
export function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// ── 限流 ──
// 两种限法叠在一起，因为它们挡的不是同一件事：
//   · 窗口计数（hit）挡**量**：脚本在一秒里发 1000 次注册请求；
//   · 失败退避（fail）挡**试**：慢慢来、每 10 秒试一个密码，永远不触发窗口。
// 只做窗口的话，攻击者把速率降到窗口以下就永远不被拦（撞库是慢活，它不急）；
// 只做退避的话，一堆不同呼号的请求就能把这张表吃光 —— 所以表要有上限。
//
// 退避的底数不写"每失败一次等 1 秒"：那是线性的，试 1000 次也就等 1000 秒，
// 脚本完全等得起。指数退避让第 20 次失败要等 12 天 —— 撞库的时间预算直接爆炸。
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 10, baseMs = 1000, maxBackoffMs = 900_000, maxKeys = 10_000 } = {}) {
    this.windowMs = windowMs; this.max = max;
    this.baseMs = baseMs; this.maxBackoffMs = maxBackoffMs; this.maxKeys = maxKeys;
    this.hits = new Map();     // key -> number[]（窗口内的时间戳）
    this.fails = new Map();    // key -> { n, until }
  }

  // 表要有上限：否则限流器本身变成内存放大器 ——
  // "每个不同呼号试一次"就能往这张表里塞任意多条记录。
  prune(now) {
    const w = this.windowMs;
    for (const [k, arr] of this.hits) {
      const keep = arr.filter(t => now - t < w);
      if (keep.length) this.hits.set(k, keep); else this.hits.delete(k);
    }
    for (const [k, f] of this.fails) if (f.until <= now && f.n === 0) this.fails.delete(k);
    if (this.hits.size + this.fails.size > this.maxKeys) {
      // 超上限时清掉最早的窗口记录（不是清退避 —— 退避是安全属性，窗口是成本属性）
      const it = this.hits.keys();
      let n = this.hits.size;
      while (n-- > this.maxKeys / 2) { const k = it.next().value; if (k === undefined) break; this.hits.delete(k); }
    }
  }

  // 返回 { ok, retryAfterMs }。ok=false 时调用方**不许**继续做事（这里不退化成放行）。
  hit(key, now = Date.now()) {
    this.prune(now);
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterMs: this.windowMs - (now - arr[0]) };
    }
    arr.push(now); this.hits.set(key, arr);
    return { ok: true, retryAfterMs: 0, left: this.max - arr.length };
  }

  // 当前是否处于退避中（在**做事之前**问，命中就不做）
  blocked(key, now = Date.now()) {
    const f = this.fails.get(key);
    if (!f) return { ok: true, retryAfterMs: 0 };
    if (now >= f.until) return { ok: true, retryAfterMs: 0, fails: f.n };
    return { ok: false, retryAfterMs: f.until - now, fails: f.n };
  }

  fail(key, now = Date.now()) {
    const f = this.fails.get(key) || { n: 0, until: 0 };
    f.n += 1;
    // 前 3 次不惩罚：正常的自己人也会打错密码，第 4 次才开始等。
    const steps = Math.max(0, f.n - 3);
    const delay = steps === 0 ? 0 : Math.min(this.maxBackoffMs, this.baseMs * 2 ** (steps - 1));
    f.until = now + delay;
    this.fails.set(key, f);
    return { n: f.n, retryAfterMs: delay };
  }

  succeed(key) { this.fails.delete(key); }

  get size() { return this.hits.size + this.fails.size; }
}

// ── 账户主体 ──
// 存储接口（store）必须提供：
//   getUser(key) -> rec | null          key 是 nameKey()（小写归一）
//   putUser(key, rec)                   新建或整体覆盖
//   createSession(tokenHash, key, expMs)
//   getSession(tokenHash) -> { key, exp } | null
//   deleteSession(tokenHash)
//   deleteUserSessions(key)
//   patchUser(key, fields)              局部更新（xp/战绩走这条，避免读改写竞争）
export class Accounts {
  constructor({ store, inviteCode = '', limiter, loginLimiter, now = Date.now, sessionTtlMs = 30 * 24 * 3600_000, scrypt = SCRYPT } = {}) {
    this.store = store;
    this.inviteCode = String(inviteCode || '');
    this.now = now;
    // scrypt 参数可注入，是为了让判据能跑低配版本（生产值一次 ~100ms，
    // 每条判据都等的话整套测试慢到没人愿意跑）。生产参数本身仍然有判据钉着 ——
    // 见 test/accounts.mjs 的 A4，它量的是"一次哈希真的慢"，不是"慢这件事被配过"。
    this.scrypt = scrypt;
    // 两套限流器分开：注册按 IP（挡批量），登录既按 IP 又按呼号（挡撞库）。
    // 合成一个的话，"一个 IP 注册太多"会把同 IP 的正常登录也一起罚掉。
    this.regLimit = limiter || new RateLimiter({ windowMs: 3600_000, max: 8, baseMs: 5000, maxBackoffMs: 3600_000 });
    this.loginLimit = loginLimiter || new RateLimiter({ windowMs: 300_000, max: 12, baseMs: 1000, maxBackoffMs: 900_000 });
    this.sessionTtlMs = sessionTtlMs;
    // 可见的计数：和 lag / streak 那两组一样，这些失效**全是静默的**，
    // 运维只能从 /healthz 上看见。regs=0 尤其要留意：那说明注册这条路根本没人走通。
    this.stat = { regs: 0, logins: 0, rejects: {}, rateLimited: 0, busy: 0, scryptMs: 0, scryptN: 0 };
  }

  _reject(why) { this.stat.rejects[why] = (this.stat.rejects[why] | 0) + 1; return { ok: false, error: why }; }

  async _throttled(fn) {
    if (inflight >= MAX_INFLIGHT) { this.stat.busy++; return 'busy'; }
    inflight++;
    try { return await fn(); } finally { inflight--; }
  }

  // 邀请码比较用恒定时间 —— 和密码同理：`===` 会在第一个不同的字符上返回，
  // 于是邀请码可以被逐字符猜出来。邀请码通常是短字符串（熵低），这个泄露是实打实的。
  _checkInvite(code) {
    if (!this.inviteCode) return true;                       // 留空 = 开放注册（公开运营时才这么配）
    const a = Buffer.from(String(code == null ? '' : code), 'utf8');
    const b = Buffer.from(this.inviteCode, 'utf8');
    if (a.length !== b.length) { timingSafeEqual(b, b); return false; }   // 长度差也要走一次，抹掉长度泄露
    return timingSafeEqual(a, b);
  }

  async register({ name, password, code, ip = '-' } = {}) {
    const now = this.now();
    const rl = this.regLimit.hit(`reg:${ip}`, now);
    if (!rl.ok) { this.stat.rateLimited++; return { ok: false, error: 'too_many', retryAfterMs: rl.retryAfterMs }; }

    const n = normalizeName(name);
    if (!validName(n)) return this._reject('bad_name');
    if (!validPassword(password)) return this._reject('bad_password');
    // 邀请码错和邀请码空**返回同一句话**：分开的话这个接口就成了"邀请码是不是这个"的
    // 在线验证器，可以离线爆破到对为止。
    if (!this._checkInvite(code)) return this._reject('bad_invite');

    const key = nameKey(n);
    if (this.store.getUser(key)) return this._reject('name_taken');

    let rec;
    const t0 = now;
    try {
      const r = await this._throttled(() => hashPassword(password, this.scrypt));
      if (r === 'busy') return this._reject('busy');
      rec = r;
    } catch (e) { return this._reject('hash_failed'); }
    this.stat.scryptMs += this.now() - t0; this.stat.scryptN++;

    const user = {
      key, name: n, ...rec,
      created: now, xp: 0, kills: 0, deaths: 0, matches: 0, wins: 0,
    };
    this.store.putUser(key, user);
    this.stat.regs++;
    // 注册成功直接给会话：多一步登录只是多一次打错密码的机会，不增加任何安全性
    const { token, hash } = newToken();
    this.store.createSession(hash, key, now + this.sessionTtlMs);
    return { ok: true, token, name: n, profile: this.publicProfile(user) };
  }

  async login({ name, password, ip = '-' } = {}) {
    const now = this.now();
    const n = normalizeName(name);
    const key = nameKey(n);
    // 三条限流，顺序有讲究：**先问退避，再记窗口**。
    // 反过来的话，一个处于退避中的对手只要继续发请求，就能靠撞窗口把自己"洗"成正常。
    const b1 = this.loginLimit.blocked(`login-ip:${ip}`, now);
    const b2 = this.loginLimit.blocked(`login-name:${key}`, now);
    const blocked = !b1.ok ? b1 : (!b2.ok ? b2 : null);
    if (blocked) { this.stat.rateLimited++; return { ok: false, error: 'too_many', retryAfterMs: blocked.retryAfterMs }; }
    const w1 = this.loginLimit.hit(`login-ip:${ip}`, now);
    const w2 = this.loginLimit.hit(`login-name:${key}`, now);
    const over = !w1.ok ? w1 : (!w2.ok ? w2 : null);
    if (over) { this.stat.rateLimited++; return { ok: false, error: 'too_many', retryAfterMs: over.retryAfterMs }; }

    const user = this.store.getUser(key);
    let okPw;
    try {
      const r = await this._throttled(() => verifyPassword(String(password == null ? '' : password), user, this.scrypt));
      if (r === 'busy') return this._reject('busy');
      okPw = r;
    } catch { okPw = false; }

    // 统一失败信息：**不区分"这个呼号不存在"和"密码不对"**。
    // 区分了的话，这张嘴就把账号表送出去了 —— 攻击者先枚举出所有存在的呼号，
    // 再把撞库火力集中到这些账号上。
    // （上面 verifyPassword 在 user 为 null 时也会跑一次真哈希，所以耗时也一样。）
    if (!user || !okPw) {
      this.loginLimit.fail(`login-ip:${ip}`, now);
      const f = this.loginLimit.fail(`login-name:${key}`, now);
      return { ok: false, error: 'bad_credentials', retryAfterMs: f.retryAfterMs };
    }

    this.loginLimit.succeed(`login-ip:${ip}`);
    this.loginLimit.succeed(`login-name:${key}`);
    this.stat.logins++;
    const { token, hash } = newToken();
    this.store.createSession(hash, key, now + this.sessionTtlMs);
    return { ok: true, token, name: user.name, profile: this.publicProfile(user) };
  }

  async logout(token) {
    if (token) this.store.deleteSession(tokenHash(token));
    return { ok: true };
  }

  // 令牌 → 用户。这是所有"我是谁"的唯一入口。
  async whoami(token) {
    if (!token) return null;
    const s = this.store.getSession(tokenHash(token));
    if (!s) return null;
    if (s.exp <= this.now()) { this.store.deleteSession(tokenHash(token)); return null; }
    const user = this.store.getUser(s.key);
    if (!user) { this.store.deleteSession(tokenHash(token)); return null; }
    return user;
  }

  // 给客户端的形状：**绝不包含 salt / hash / key**。
  // 少发一个字段不会出错，多发一个就再也收不回来（客户端会被缓存、被日志、被截图）。
  publicProfile(u) {
    if (!u) return null;
    return { name: u.name, xp: u.xp | 0, kills: u.kills | 0, deaths: u.deaths | 0, matches: u.matches | 0, wins: u.wins | 0, created: u.created };
  }

  // 战绩只由服务端加。这个函数**不在任何客户端可达的路径上** ——
  // 它只被 NetRoom 在对局结束时调用，参数是权威 sim 自己算出来的数。
  // 一旦有人在 HTTP 层把它挂出去，整套账号就退化成"给作弊者发了张身份证"。
  addResult(key, { xp = 0, kills = 0, deaths = 0, win = false } = {}) {
    const u = this.store.getUser(key);
    if (!u) return null;
    const xpGain = Math.max(0, Math.min(20000, Math.round(xp)));   // 单局上限，防"一局一亿"
    const next = {
      xp: (u.xp | 0) + xpGain,
      kills: (u.kills | 0) + Math.max(0, Math.min(500, kills | 0)),
      deaths: (u.deaths | 0) + Math.max(0, Math.min(500, deaths | 0)),
      matches: (u.matches | 0) + 1,
      wins: (u.wins | 0) + (win ? 1 : 0),
    };
    this.store.patchUser(key, next);
    return this.publicProfile(this.store.getUser(key));
  }
}
