// 账号：注册 / 登录 / 登出 / 我是谁。
//
// ── 令牌放在 HttpOnly cookie 里，这个模块看不到它，也不需要看到 ──
// 那正是把它放 cookie 的目的：任何一次 XSS 都拿不走会话。
// 代价是每个请求都要带 cookie —— 同源 fetch 默认就带，所以这里什么都不用做
// （不要为了"显式一点"去写 credentials:'include'：那是跨源才需要的，
// 而同源场景下写它只会让人以为这里有跨源问题）。
//
// ── 这个模块不判断密码强度、不判断呼号合法性 ──
// 那些规则的真相在服务端（server/accounts.mjs 的白名单与长度限制）。
// 客户端再写一份的症状是"前端说可以、服务端说不行"，而玩家看到的是**点了没反应** ——
// 所以这里的策略是：**只把服务端那句中文错误原样显示出来**。
// 服务端已经把每一条拒绝写成人话了，客户端抄一遍只会抄出新旧不一致。
//
// ── 状态是缓存的，但缓存不是真相 ──
// `user` 只用来决定菜单上显示什么。真正的判定在服务端每一次请求里重做 ——
// 客户端把自己的状态改成"已登录"改不动任何东西，这一点是设计，不是遗漏。
//
// ── 这个模块里有两个"问服务端才知道"的策略，不要猜 ──
//   · inviteRequired：注册要不要邀请码（决定显不显示那一栏）；
//   · requireAccount：这个服要不要账号（决定大厅是"登录表单"还是"一个呼号框"）。
// 两个都是**部署时定的**（JOIN_CODE / REQUIRE_ACCOUNT）。客户端猜错的方向不对称：
// 多显示一个框只是啰嗦，少显示一个框会把人挡在门外 —— 所以两者默认都往严的那边倒，
// 等 /api/status 回来再说。

const TIMEOUT_MS = 8000;

export class Account {
  constructor() {
    this.user = null;             // null = 没登录；否则是 publicProfile 那个形状
    this.inviteRequired = true;   // 保守默认：在问清楚之前先显示邀请码那一栏
    // 保守默认是"要账号"。两个方向的代价不对称：多显示一个密码框只是啰嗦一句，
    // 而**少**显示它会让这个服变成没人进得去 —— 所以默认值往严的那边倒。
    this.requireAccount = true;
    this.statusKnown = false;
    this.busy = false;
    this.lastError = '';
  }

  get loggedIn() { return !!this.user; }

  // 超时是必须的：服务端可能正在被限流（429 里写着还要等 3600 秒），
  // 没有超时的话登录按钮会永远停在"登录中…"，而那看起来像卡死。
  async _req(path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      let j = null;
      try { j = JSON.parse(await r.text()); } catch { /* 非 JSON 的错页 */ }
      if (r.ok && j && j.ok) return { ok: true, data: j };
      // 服务端说了什么就显示什么。拿不到就说状态码 —— 不要自己编一句
      // "网络错误"，那会把"邀请码不对"和"服务器挂了"混成同一句话。
      return { ok: false, message: (j && j.message) || `服务器返回了 ${r.status}`, status: r.status, retryAfterMs: (j && j.retryAfterMs) | 0 };
    } catch (e) {
      return { ok: false, message: e && e.name === 'AbortError' ? '服务器无响应（请求超时）' : '无法连接服务器', status: 0 };
    } finally { clearTimeout(t); }
  }

  async status() {
    const r = await this._req('/api/status');
    if (r.ok) {
      this.inviteRequired = !!r.data.inviteRequired;
      // "这个服要不要账号"是部署时定的（REQUIRE_ACCOUNT），只有服务端知道。
      // 客户端猜错的方向很具体：访客可玩的服上会摆出一个玩家填不出来的登录框，
      // 而错误信息还是"呼号或密码不对" —— 把"这里不需要密码"说成了"你密码打错了"。
      this.requireAccount = r.data.requireAccount !== false;
      this.statusKnown = true;
    }
    return r;
  }

  async me() {
    const r = await this._req('/api/me');
    // ── "我是谁"的答案在 loggedIn 那一格，不在状态码上 ──
    // /api/me 对没登录的人也返回 200（原因写在 server/http-api.mjs 里那段注释里：
    // 401 会让每一次页面加载都多一条必然出现的控制台错误，而那会废掉最灵敏的一条判据）。
    // 所以这里**不能**按 r.ok 判断 —— 那样每个访客都会被显示成"已登录"。
    // 这一格是安全属性所在处：它由服务端根据会话决定，客户端改不动它。
    this.user = (r.ok && r.data.loggedIn && r.data.profile) ? r.data.profile : null;
    return r;
  }

  // 联机大厅的房间清单。要账号的服上没登录会被 401 —— 那是**服务端**在说
  // "未完成注册前联网对战不开放"，和 WS 握手那道 401 是同一条规则的两半。
  // 客户端只负责把拒绝显示出来（见 js/menu.js 的 renderRoomList），自己不发明权限。
  async rooms() {
    return this._req('/api/rooms');
  }

  async register({ name, password, code }) {
    this.busy = true; this.lastError = '';
    try {
      const r = await this._req('/api/register', { name, password, code });
      this.user = (r.ok && r.data.loggedIn && r.data.profile) ? r.data.profile : null;
      if (!r.ok) this.lastError = r.message;
      return r;
    } finally { this.busy = false; }
  }

  async login({ name, password }) {
    this.busy = true; this.lastError = '';
    try {
      const r = await this._req('/api/login', { name, password });
      this.user = (r.ok && r.data.loggedIn && r.data.profile) ? r.data.profile : null;
      if (!r.ok) this.lastError = r.message;
      return r;
    } finally { this.busy = false; }
  }

  async logout() {
    this.busy = true;
    try { await this._req('/api/logout', {}); } finally { this.user = null; this.busy = false; }
  }

  // 忘了密码：呼号 + 一张一次性恢复码 + 新密码。
  // 它**不接受旧密码**（要旧密码就不叫找回了），也不吃邀请码（那是给新账号的闸）。
  // 成功之后服务端会当场作废这个账号的所有旧会话 —— 所以这里拿回来的新身份是**唯一**的
  // 那一份，别的地方若还开着这个账号，那边下一次请求就会变成"没登录"。
  async recover({ name, code, password }) {
    this.busy = true; this.lastError = '';
    try {
      const r = await this._req('/api/recover', { name, code, password });
      this.user = (r.ok && r.data.loggedIn && r.data.profile) ? r.data.profile : null;
      if (!r.ok) this.lastError = r.message;
      return r;
    } finally { this.busy = false; }
  }
}
