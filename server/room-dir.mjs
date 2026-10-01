// 跨进程房间目录：一个共享的 SQLite 文件，每台权威端把自己的房间行"自报"进去。
//
// ── 这是什么、不是什么 ──
// README 的口径仍然是"一个进程 = 一个权威端"：房间在哪台建，sim 就只在那台的进程里跑，
// 目录**不搬运行状态**，只搬"哪台有什么房"这一张名单。它解决的是多实例部署的第 5 条已知缺口：
// 进程内的房间列表是真的，跨进程谁也看不见谁的 —— 玩家只能靠"记住哪个端口开哪张图"选服。
// 有了目录，任何一台上打开的大厅都能看到全部台的房（带各自的 url），点谁的房就连谁的台。
//
// ── 为什么是"自报 + 心跳 + TTL"，不是"谁管账" ──
// 多台进程之间没有任何协调者（没有 redis、没有主进程），最合理的账本形状是每台只写自己的行、
// 靠心跳证明自己活着、超时没心跳的行由**任何一台**顺手扫掉 —— 一台崩溃，它的行在 TTL 内
// 自然消失，不需要谁去"接管"。这和容器编排里的租约是同一个形状，只是账本落在一个
// 共享的 SQLite 文件上（node:sqlite，零依赖；WAL 模式下多进程读写是 SQLite 自己的强项）。
//
// ── 写入为什么**直写**、不走账号那套攒批 ──
// server/store.mjs 的"载入一次 + 读全走内存 + 攒批刷盘"是给 60Hz tick 让路的（见它的文件头），
// 而它的代价在探针里被量得很清楚：**活进程看不见别人写的行**（server/multi-account-probe.mjs S1）。
// 目录的每一笔都小（一行几十字节）、频率被心跳压着（每台每 beat 一次事务），
// 而且它的全部意义就在于"别台要马上看见" —— 所以直写 + busy_timeout，
// 并发写撞上时由 SQLite 自己排队，不进任何内存账本。
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists rooms (
  dkey   text primary key,   -- boot + ':' + id：同进程内 id 唯一，跨进程允许重号（各行并存，local 优先）
  id     text not null,
  title  text not null,
  map    text not null,
  mode   text not null,
  players integer not null,
  max    integer not null,
  ready  integer not null,
  time   integer not null,
  score  integer not null,
  state  text not null,
  host   text not null,
  url    text not null,      -- 房主那台的对外基地址（http(s)://host:port），客户端拿它换 ws 地址
  boot   text not null,
  beat   integer not null    -- 最后一次心跳的时刻；超过 TTL 没跳，任何一台都可以扫掉它
);
create table if not exists tickets (
  tok  text primary key,     -- 128 位随机，只在 /api/dispatch 的响应里出现一次
  uk   text not null,
  name text not null,
  xp   integer not null,
  exp  integer not null      -- 绝对时刻；消费与过期都以它为准
);
`;

export class RoomDirectory {
  constructor({ file, url, boot, ttlMs = 8000, ticketTtlMs = 30000, now = Date.now, DatabaseSync = NodeDatabaseSync } = {}) {
    if (!file) throw new Error('RoomDirectory 需要 file');
    this.url = url;
    this.boot = boot || randomBytes(8).toString('hex');
    this.ttlMs = ttlMs;
    this.ticketTtlMs = ticketTtlMs;
    this.now = now;
    this.db = new DatabaseSync(file);
    this.db.exec('pragma journal_mode = wal; pragma synchronous = normal;');
    // 多进程并发写同一文件：WAL 下写者串行，撞上时等而不是抛 —— 目录的每笔都小，等得起。
    this.db.exec('pragma busy_timeout = 2000;');
    this.db.exec(SCHEMA);
    this._insRoom = this.db.prepare(`insert into rooms (dkey,id,title,map,mode,players,max,ready,time,score,state,host,url,boot,beat)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(dkey) do update set title=excluded.title, map=excluded.map, mode=excluded.mode,
        players=excluded.players, max=excluded.max, ready=excluded.ready, time=excluded.time,
        score=excluded.score, state=excluded.state, host=excluded.host, url=excluded.url, beat=excluded.beat`);
    this._delRoom = this.db.prepare('delete from rooms where dkey = ?');
    this._insTicket = this.db.prepare('insert into tickets (tok,uk,name,xp,exp) values (?,?,?,?,?)');
    this._delTicket = this.db.prepare('delete from tickets where tok = ?');
  }

  // 本台的行 → 目录。返回"有没有增删改"——调用方拿它决定要不要把新名单推给自己大厅里的人。
  // diff 是刻意的：心跳每 beat 跑一次，不 diff 的话每台每两秒就给全大厅推一帧"看起来没变"的清单。
  publishAll(rows) {
    const t = this.now();
    const want = new Map();
    for (const r of rows) want.set(this.boot + ':' + r.id, r);
    let changed = false;
    const mine = this.db.prepare('select dkey, players, state from rooms where boot = ?').all(this.boot);
    const have = new Map(mine.map(m => [m.dkey, m]));
    this.db.exec('begin');
    try {
      for (const [dkey, r] of want) {
        const h = have.get(dkey);
        if (!h || h.players !== r.players || h.state !== r.state) {
          this._insRoom.run(dkey, r.id, String(r.title || r.id), String(r.map || ''), String(r.mode || ''),
            r.players | 0, r.max | 0, r.ready | 0, r.time | 0, r.score | 0, String(r.state || 'waiting'),
            String(r.host || ''), this.url, this.boot, t);
          changed = true;
        } else {
          // 没变的行也要续心跳：beat 是"这台还活着"的唯一证据。
          this.db.prepare('update rooms set beat = ? where dkey = ?').run(t, dkey);
        }
      }
      for (const [dkey] of have) if (!want.has(dkey)) { this._delRoom.run(dkey); changed = true; }
      this.db.exec('commit');
    } catch (e) { try { this.db.exec('rollback'); } catch { /* 已经回滚了 */ } throw e; }
    return changed;
  }

  // 别台的行（自己的除外）。sweep 负责新鲜度，这里只读。
  list() {
    this.sweep();
    return this.db.prepare('select * from rooms where boot != ? order by beat desc').all(this.boot)
      .map(r => ({
        id: r.id, title: r.title, map: r.map, mode: r.mode, players: r.players, max: r.max,
        ready: r.ready, time: r.time, score: r.score, state: r.state, host: r.host,
        remote: true, url: r.url,
      }));
  }

  ownCount() { return this.db.prepare('select count(*) as n from rooms where boot = ?').get(this.boot).n; }

  // 超时没心跳的行，谁路过谁扫 —— 一台崩溃，它的行在任何一台的下一次心跳里消失。
  sweep() {
    const dead = this.now() - this.ttlMs;
    this.db.prepare('delete from rooms where beat < ?').run(dead);
    this.db.prepare('delete from tickets where exp < ?').run(this.now());
  }

  // ── 一次性跨台入场券 ──
  // 账号账本是**进程私有**的（探针钉着的那条账）：目标进程不认识别台发的会话 cookie。
  // 玩家要跨台加入时，由**他连着的、验过他身份的那台**发一张票进目录，目标进程在 ws 握手时
  // 消费它。票只带 key/呼号/XP（与一次成功登录能建立的身份等价），单次有效、短 TTL ——
  // 偷到票的窗口与偷到会话 cookie 同阶，没有引入新的信任级。
  mintTicket({ uk, name, xp }) {
    const tok = randomBytes(16).toString('hex');
    this._insTicket.run(tok, String(uk || ''), String(name || ''), xp | 0, this.now() + this.ticketTtlMs);
    return tok;
  }

  // 消费 = 先读后删，原子性由**删掉那一句的 changes** 给出：两台同时消费同一张票时，
  // SQLite 把两个 delete 串行化，只有一个能看到 changes=1。没有 await 插在读与删之间
  // （node:sqlite 是同步 API，这两句在同一个事件循环拍里），本进程内不存在交错窗口。
  consumeTicket(tok) {
    if (!tok) return null;
    const t = String(tok);
    const row = this.db.prepare('select uk, name, xp, exp from tickets where tok = ?').get(t);
    if (!row) return null;
    if (row.exp <= this.now()) { this._delTicket.run(t); return null; }
    const r = this._delTicket.run(t);
    if (!r.changes) return null;    // 别台在同一瞬消费掉了 ⇒ 票已经被用，拒
    return { key: row.uk, name: row.name, xp: row.xp | 0 };
  }

  // /api/dispatch 的那一步：目标 url 必须是目录里**登记着的另一台**、room 必须是它名下的行。
  // 不做这一步的话，"发票"等于把本台的登录身份转发到任意地址 —— 那是一个免费的身份代理。
  // user 为 null（访客）时发票没有意义（访客在目标台上本来就不设闸），返回 null 让调用方走免票路。
  mintFor({ room, url, user }) {
    if (!user) return null;
    const hit = this.list().find(r => r.url === url && r.id === room);
    if (!hit) return null;
    return this.mintTicket({ uk: user.key, name: user.name, xp: user.xp | 0 });
  }

  // 正常下线：把自己的行拔掉（不是等 TTL）。崩溃才走 TTL 那条路。
  unpublishAll() {
    this.db.prepare('delete from rooms where boot = ?').run(this.boot);
    this.db.prepare('delete from tickets where exp < ?').run(this.now());
  }

  close() {
    try { this.unpublishAll(); } catch { /* 尽力而为 */ }
    try { this.db.close(); } catch { /* 已经关了 */ }
  }
}
