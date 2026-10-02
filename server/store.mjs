// 账号存储：SQLite 落地（node:sqlite，零依赖）+ 同接口的内存版（判据用）。
//
// ── 这个模块的核心设计不是"用什么数据库"，是"写盘绝不许挡住 tick 循环" ──
//
// 同一个进程里跑着 60 拍/秒的权威 sim，一拍的预算是 16.7ms。
// node:sqlite 是**同步** API，一次写盘哪怕只有 1ms，也是把那一拍吃掉 6%；
// 赶上一次 checkpoint 就是几十毫秒 —— 直接掉拍，而且是所有房间一起掉。
//
// 所以走**写穿 + 攒批刷盘**：
//   · 读：全部走内存里的 Map（开库时一次性载入）。表很小（几百到几万行），
//     载入几十毫秒，换来的是一次 tick 里**零次磁盘访问**。
//   · 写：先改内存、标脏，然后由 setInterval 每 250ms 刷一批。
//   · 于是不管谁在什么时候写账号，**权威循环那一边都看不到任何磁盘延迟**。
//
// 代价是明确的，要立账不要假装没有：**进程被杀时，最多丢最近 250ms 的写入。**
// 对账号来说这是可接受的（人不会在 250ms 里注册两次），对"这一局的 xp"更可接受 ——
// 丢一局经验值可以接受，卡住一整间房不行。这就是"存档不是交易"的具体含义。
//
// ── 每次刷盘的条数要有上限 ──
// "攒批"这件事如果只按时间触发，就有一个反直觉的坑：一次雪崩之后
// 队列里堆了 5000 条，下一次刷盘**一次写完** —— 那一刷自己就把主线程停了几百毫秒。
// 所以按**条数与时间双触发**，且单批不超过 MAX_BATCH 条。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
create table if not exists users (
  key      text primary key,
  name     text not null,
  algo     text not null,
  N        integer not null,
  r        integer not null,
  p        integer not null,
  keylen   integer not null,
  salt     text not null,
  hash     text not null,
  created  integer not null,
  xp       integer not null default 0,
  kills    integer not null default 0,
  deaths   integer not null default 0,
  matches  integer not null default 0,
  wins     integer not null default 0
);
create table if not exists sessions (
  token text primary key,
  uk    text not null,
  exp   integer not null
);
create index if not exists sessions_uk on sessions (uk);
create table if not exists meta (k text primary key, v text not null);
create table if not exists audit (
  id   integer primary key autoincrement,
  t    integer not null,
  ev   text not null,
  name text not null,
  ip   text not null
);
`;


// ── 审计（audit）为什么是**直写**而账号是攒批 ──
// 审计记的是"谁在什么时候从哪个 IP 注册/登录/被拒" —— 真有纠纷时这是唯一的证据，
// 它的优先级和 xp 相反：**宁可多花一次磁盘写，也不能和"进程被杀"一起消失**。
// 而它的频率天然被限流器压着（注册 8/时/IP、登录 12/5分/IP），单条 insert 走的是
// 已经打开的连接，不在 tick 路径上（注册/登录都发生在 HTTP handler 里）——
// 所以这里不走脏集合、不走 250ms 批刷，一次 insert 落定。

const MAX_BATCH = 200;          // 单批最多这么多行，见上面"雪崩"那段
// 审计表在**磁盘上**留多少条（M8）。内存版是 5000（那一份只管内存），落盘那份要管 WAL 与文件大小：
// 20000 条已经够任何一次纠纷的回溯（一次登录一行，一天几十行是常态），而它是个常数上界。
const AUDIT_CAP = 20000;
const AUDIT_PRUNE_EVERY = 500;  // 攒多少条裁一次（每次裁剪 = 一次 delete，见 audit()）

// 把一条 users 记录拆成 SQL 参数。列名固定，所以这里也是白名单重建 ——
// 不是把 rec 的所有字段塞进去。以后往 user 上加字段（比如解禁时间），
// 忘了加到这张列表里的表现是"字段静静地没落库"，所以下面有一处断言管这件事。
const USER_COLS = ['name', 'algo', 'N', 'r', 'p', 'keylen', 'salt', 'hash', 'created', 'xp', 'kills', 'deaths', 'matches', 'wins'];
export { USER_COLS };

function userRow(key, u) { return [key, ...USER_COLS.map(c => u[c])]; }
function rowUser(r) {
  const u = { key: r.key };
  for (const c of USER_COLS) u[c] = r[c];
  return u;
}

// ── 内存版：判据用 ──
// 它和 SQLite 版共用同一份"上层看到什么"的契约。判据跑内存版，
// 于是判据量的是 accounts.mjs 的逻辑，不是 SQLite 的可用性。
export class MemoryStore {
  constructor({ now = Date.now } = {}) {
    this.users = new Map();
    this.sessions = new Map();
    this.meta = new Map();
    this.auditLog = [];
    this.now = now;
    this.flushes = 0;
  }
  getUser(key) { const u = this.users.get(key); return u ? { ...u } : null; }
  putUser(key, rec) { this.users.set(key, { ...rec, key }); }
  patchUser(key, fields) {
    const u = this.users.get(key);
    if (!u) return false;
    Object.assign(u, fields);
    return true;
  }
  createSession(token, key, exp) { this.sessions.set(token, { key, exp }); }
  getSession(token) { return this.sessions.get(token) || null; }
  deleteSession(token) { this.sessions.delete(token); }
  deleteUserSessions(key) { for (const [t, s] of this.sessions) if (s.key === key) this.sessions.delete(t); }
  countUsers() { return this.users.size; }
  countSessions() { return this.sessions.size; }
  // meta 是"小 JSON 片段"的杂项抽屉（聊天历史就在里面）。内存版只保证形状与 SQLite 版一致。
  getMeta(k) { return this.meta.get(k) ?? null; }
  setMeta(k, v) { this.meta.set(k, String(v)); }
  // 审计的**契约与 SQLite 版一致**：不许往调用方抛（审计失败不许挡住注册/登录），
  // 内存上限只影响留多少条 —— 判据里量的是形状，不是容量。
  audit(ev, name, ip) {
    this.auditLog.push({ t: this.now(), ev: String(ev), name: String(name || ''), ip: String(ip || '') });
    if (this.auditLog.length > 5000) this.auditLog.shift();
  }
  getAudit(limit = 50) { return this.auditLog.slice(-limit).reverse(); }
  flush() { this.flushes++; return 0; }
  close() {}
}

export class SqliteStore {
  constructor({ file, idleMs = 250, now = Date.now, DatabaseSync, SessionClass } = {}) {
    // 从 node:sqlite 拿 DatabaseSync。允许注入，是为了让判据能在不支持的 Node 上
    // 跳过这一段而不是整个测试挂掉。
    const S = DatabaseSync ? { DatabaseSync } : (SessionClass || null);
    if (!S) throw new Error('SqliteStore 需要 DatabaseSync');
    this.now = now;
    this.file = file;
    this.idleMs = idleMs;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new S.DatabaseSync(file);
    // WAL：读写不互相阻塞，且崩溃后不会留下半写的库。
    // 对一个"随时可能被 kill -9"的服务（容器重启、部署）来说，这是必须的。
    this.db.exec('pragma journal_mode = wal; pragma synchronous = normal;');
    this.db.exec(SCHEMA);

    this.users = new Map();      // key -> rec（内存真身）
    this.sessions = new Map();   // tokenHash -> { key, exp }
    this.dirtyUsers = new Set();
    this.dirtySessions = new Set();
    this.goneSessions = new Set();
    this.stat = { loaded: 0, sessions: 0, flushMs: 0, flushes: 0, written: 0, errors: 0, dropped: 0, pendingMax: 0 };

    this._load();

    this._insUser = this.db.prepare(
      `insert into users (key,${USER_COLS.join(',')}) values (${['?', ...USER_COLS.map(() => '?')].join(',')})
       on conflict(key) do update set ${USER_COLS.map(c => `${c}=excluded.${c}`).join(',')}`);
    this._insSess = this.db.prepare('insert into sessions (token,uk,exp) values (?,?,?) on conflict(token) do update set uk=excluded.uk, exp=excluded.exp');
    this._delSess = this.db.prepare('delete from sessions where token = ?');
    this._delExp = this.db.prepare('delete from sessions where exp <= ?');
    this._insAudit = this.db.prepare('insert into audit (t,ev,name,ip) values (?,?,?,?)');
    // 裁剪语句：删掉"除了最近 AUDIT_CAP 条之外"的所有行。
    // 写成 `id <= max(id) - cap` 而不是 `limit/offset` —— 后者要先扫一遍再删，
    // 而且 offset 版没有可用的索引；主键范围删是 O(删掉的行数)。
    this._delAudit = this.db.prepare('delete from audit where id <= (select max(id) from audit) - ?');
    this._auditN = 0;              // 距上次裁剪又插了几条（见 audit()）
    this._insMeta = this.db.prepare('insert into meta (k,v) values (?,?) on conflict(k) do update set v=excluded.v');

    this.timer = setInterval(() => { try { this.flush(); } catch { /* 由 stat.errors 记账 */ } }, this.idleMs);
    // unref：这个定时器不该让进程活着。忘了它的话服务停不下来，
    // 而表现只是"ctrl-c 之后要等一会儿"，很难联想到是这里。
    if (this.timer.unref) this.timer.unref();
  }

  _load() {
    const t = this.now();
    for (const r of this.db.prepare('select * from users').all()) this.users.set(r.key, rowUser(r));
    for (const r of this.db.prepare('select * from sessions where exp > ?').all(t)) this.sessions.set(r.token, { key: r.uk, exp: r.exp });
    // 过期的会话顺手清掉：不清的话表会随"每次登录"单调增长，而没人会去注意它。
    this.db.prepare('delete from sessions where exp <= ?').run(t);
    this.stat.loaded = this.users.size;
    this.stat.sessions = this.sessions.size;
  }

  getUser(key) { const u = this.users.get(key); return u ? { ...u } : null; }
  putUser(key, rec) { this.users.set(key, { ...rec, key }); this.dirtyUsers.add(key); }
  patchUser(key, fields) {
    const u = this.users.get(key);
    if (!u) return false;
    Object.assign(u, fields); this.dirtyUsers.add(key);
    return true;
  }
  createSession(token, key, exp) { this.sessions.set(token, { key, exp }); this.dirtySessions.add(token); }
  getSession(token) { return this.sessions.get(token) || null; }
  deleteSession(token) { if (this.sessions.delete(token)) this.goneSessions.add(token); this.dirtySessions.delete(token); }
  deleteUserSessions(key) { for (const [t, s] of this.sessions) if (s.key === key) this.deleteSession(t); }
  countUsers() { return this.users.size; }
  countSessions() { return this.sessions.size; }
  // 审计**直写**（理由见文件头 audit 表那一段），且不许往调用方抛：
  // 磁盘出问题时注册/登录该怎么样还怎么样，代价只在 stat.errors 上可见 ——
  // 静默丢审计当然不理想，但"审计失败挡住玩家进游戏"更不理想，两害取轻要留下字据。
  audit(ev, name, ip) {
    try {
      this._insAudit.run(this.now(), String(ev), String(name || ''), String(ip || ''));
      // ── 上限（M8）──
      // 内存版有 5000 条上限，SQLite 版原先**一条都不删**：文件头那句"频率天然被限流器压着"
      // 站不住 —— 限流键是 IP，多 IP 慢速灌注册/登录照样能把这张表写成无限长，
      // 而且它和账号库共用一个文件（WAL 一起长）。
      // 裁剪不每次做（那会把一次 insert 变成两次写），攒够 AUDIT_PRUNE_EVERY 条再一刀 ——
      // 于是表的规模上界是 AUDIT_CAP + AUDIT_PRUNE_EVERY，是个常数。
      if (++this._auditN >= AUDIT_PRUNE_EVERY) { this._auditN = 0; this.pruneAudit(); }
    } catch { this.stat.errors++; }
  }
  // 只留最近的 AUDIT_CAP 条。**不给调用方抛出**（与 audit 同一条契约：磁盘有问题不该挡住登录）。
  pruneAudit() {
    try { this._delAudit.run(AUDIT_CAP); } catch { this.stat.errors++; }
  }
  countAudit() {
    try { return this.db.prepare('select count(*) as n from audit').get().n; } catch { this.stat.errors++; return -1; }
  }
  getAudit(limit = 50) {
    return this.db.prepare('select t, ev, name, ip from audit order by id desc limit ?').all(limit | 0);
  }
  // meta 直写，与 audit 同一条理由：一次一句小 upsert，量级与登录时的审计写相同，
  // 且**不许**往调用方抛 —— 聊天历史写不进去不该挡住聊天本身（stat.errors 留字据）。
  getMeta(k) {
    try { const r = this.db.prepare('select v from meta where k = ?').get(String(k)); return r ? r.v : null; }
    catch { this.stat.errors++; return null; }
  }
  setMeta(k, v) {
    try { this._insMeta.run(String(k), String(v)); } catch { this.stat.errors++; }
  }
  get pending() { return this.dirtyUsers.size + this.dirtySessions.size + this.goneSessions.size; }

  // 一批一事务。批内条数有上限，见文件头"雪崩"那段。
  flush() {
    const pending = this.pending;
    if (pending > this.stat.pendingMax) this.stat.pendingMax = pending;
    if (!pending) return 0;
    const t0 = this.now();
    const uk = [...this.dirtyUsers].slice(0, MAX_BATCH);
    const sk = [...this.dirtySessions].slice(0, MAX_BATCH);
    const dk = [...this.goneSessions].slice(0, MAX_BATCH);
    let n = 0;
    try {
      this.db.exec('begin');
      for (const k of uk) { const u = this.users.get(k); if (u) { this._insUser.run(...userRow(k, u)); n++; } this.dirtyUsers.delete(k); }
      for (const t of sk) { const s = this.sessions.get(t); if (s) { this._insSess.run(t, s.key, s.exp); n++; } this.dirtySessions.delete(t); }
      for (const t of dk) { this._delSess.run(t); n++; this.goneSessions.delete(t); }
      // 顺手清过期会话，但只在这一次刷盘真的动了 sessions 的时候做 ——
      // 每 250ms 全表 scan 一次 sessions 是纯浪费，而 sessions 的增长本来就很慢。
      if (sk.length || dk.length) this._delExp.run(this.now());
      this.db.exec('commit');
    } catch (e) {
      try { this.db.exec('rollback'); } catch { /* 已经回滚了 */ }
      this.stat.errors++;
      // 刷盘失败**不丢数据**：把键放回脏集合，下一轮再试。
      // 直接丢弃的话表现是"注册成功了，重启之后登不进去"，而且没有任何日志线索。
      for (const k of uk) this.dirtyUsers.add(k);
      for (const t of sk) this.dirtySessions.add(t);
      for (const t of dk) this.goneSessions.add(t);
      return -1;
    }
    this.stat.flushes++; this.stat.written += n;
    this.stat.flushMs = this.now() - t0;
    return n;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 退出前必须把脏数据推下去，否则"正常关服"和"被 kill -9"一样丢数据 ——
    // 那会让上面那段"最多丢 250ms"的立账变成一句空话。
    let guard = 0;
    while (this.pending && guard++ < 1000) if (this.flush() < 0) break;
    try { this.db.exec('pragma wal_checkpoint(truncate)'); } catch { /* 无所谓 */ }
    this.db.close();
  }
}
