// CF 式开房间的服务端那一半：等待态房间、座位、准备、房主开局、聊天频道。
//
// ── 为什么这一层和 server/room.mjs 分开 ──
// room.mjs 是一份 60Hz 的权威模拟：一张地图的 world + 若干 Player + 每拍推进。
// 而"一间等着开房的房间"里什么都没在跑 —— 它只是一张名单：谁在、哪队、准备好没有、
// 说过什么话。把两件事做成一个类，代价就是"人一进房间就开始模拟"（今天的症状：
// 加入即进对局，没有准备这一说），而且等着人的房间要养着一份完整 sim 直到回收。
// 所以：名单归这里，模拟归 room.mjs，两边只在"房主按下开始"那一刻交接一次。
//
// ── 座位为什么按连接（sid）而不是按账号 ──
// 一条连接从进大厅到打完这局全程不换（见 net-server 的 begins 那一步），所以
// "这个人"和"这条连接"在房间存续期间是一回事。按账号做键看着更正统，实际会引入
// 两个新问题：访客服上呼号是自报的（两个人可以都叫 abc，那就撞进同一个座位），
// 以及"断线重连要能把人找回原来的座位"（那是一整套租约与恢复逻辑，而现在没这需求）。
// 断开就是离开 —— 这既是对的 UX，也就不需要租约。
//
// ── 权限在这里，不在界面上 ──
// 谁能开局、开局要满足什么条件、聊天能发多快，全部在服务端判一遍。客户端把"开始"
// 按钮置灰只是体验；改得动的东西不算权限（和 /api/rooms 的 401、WS 握手的 401 同源）。
import { MP_MAPS, MP_MODES, MP_MINUTES } from '../js/data.js';

// 一间的上限。和 net-server:pickRoom 里那个"人最多且没满"的 16 是同一个数 ——
// 两处各写一份的话，改一处的症状是"列表说还能进、进去说满了"。
export const MAX_SEATS = 16;
export const MAX_PER_TEAM = MAX_SEATS / 2;
// 一条聊天多少字。上限的理由不是"防刷长文"，是它会被广播给一屋子人：
// 没有上限的话一条 64 KB 的"消息"就是 16 份 64 KB 下行（maxPayload 只管单帧，不管扇出）。
export const CHAT_LEN = 120;
export const LOBBY_CHAT_HIST = 50;                  // 全服频道留多少条历史
export const ROOM_CHAT_HIST = 40;
// 聊天速率：稳态每 600 ms 一条，另给 10 秒窗口内 6 条的突发余量。
// 正常打字快的人一秒也就两三条；不限的话"进对局"就变成"谁的刷屏赢"。
export const SAY_MIN_MS = 600, SAY_BURST = 6, SAY_BURST_MS = 10000;
// 空的等待房间留多久。比 live 那份的 ROOM_IDLE_MS(60s) 长得多是有意的：
// 大厅里"刚建好、还差一个人"的房，是会被别人过几分钟才点进来的。
export const WAIT_IDLE_MS = 5 * 60 * 1000;

const MAP_IDS = new Set(MP_MAPS.map(m => m.id));
// 模式按 js/data.js 上那个 net 标记筛：房间能选的模式 = 服务端判得出胜负的那些。
// 名字表用来把拒绝的话说得具体（"占领"而不是"该模式"），它不是第二份真相 ——
// 少/多一个模式时改的是那张表，这里跟着变。
const MODE_NAMES = Object.fromEntries(MP_MODES.map(m => [m.id, m.name]));
const MODE_IDS = new Set(MP_MODES.filter(m => m.net).map(m => m.id));
const MODE_LIST = [...MODE_IDS].map(id => MODE_NAMES[id]).join(' / ');
// 认不出的模式一律当场拒绝。静默退回默认那一种的症状是"房主选了占领、列表里写着
// 团队死斗，谁也不知道那一格被改了" —— 而房间标题正是别人挑房的依据。
const modeGate = (v) => (v == null || v === '' || MODE_IDS.has(v))
  ? null : `「${MODE_NAMES[v] || v}」的胜负判定还没接进服务器，这里只能开 ${MODE_LIST}`;
// 时长那张表在 js/data.js（两端都要读它，抄两份的话界面会给出服务端不认的值）。
export const MINUTES = MP_MINUTES;
const MIN_SET = new Set(MINUTES);
const cleanMinutes = (v) => { const n = Number(v); return MIN_SET.has(n) ? n : 10; };

let NEXT_SID = 1;
// 一条连接的座位号在**进大厅那一刻**就发下去，不等它进哪间房。座位的键是它，
// 房主配额的键也要是它（访客服上没有账号可依，见 _hostKey）—— 两处各自 lazily
// 分配的话，"同一条连接"在两张表里会是两个号，配额就数错了。
const sidOf = (ws) => ws.__sid == null ? (ws.__sid = NEXT_SID++) : ws.__sid;

// 面向广播的用户文本一律先拍平再用。控制字符能伪造聊天行（换行），零宽字符能让
// "甲"和"甲"看起来是两个人 —— 而这两种都只会在别人的界面上显形。少洗一处的症状
// 是"某人发一条消息，别人那儿的界面跟着乱"。
function flat(s, n) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, n);
}
// 房号沿用 live 那一份的白名单（net-server:pickRoom）。中文房名当房号会被洗成空串，
// 症状是"建了个房，人却进了别人的房间" —— 所以房名与房号是两格，各洗各的。
const roomId = (raw) => String(raw == null ? '' : raw).slice(0, 32).replace(/[^A-Za-z0-9_.-]/g, '');

// 一张等待态房间。刻意不做成类：它没有行为，行为全在下面的 Lobby 里 ——
// 分两处放的话"改一处的规则"会在另一处漏掉，而这类漏掉都不会报错。
//   stage: 'waiting' 只有一张名单，没有 sim；'playing' 已经有对应的 live 房间在跑
//   seat:  {sid, name, team, ready, xp, account, ws, loadout}
// ready 是**每个人自己的声明**，isHost 只有一个真（房主离开时要能移交给下一个活着的人）。

export class Lobby {
  constructor(opts = {}) {
    this.send = opts.send || (() => {});            // (ws, obj) => void，由 net-server 注入
    this.nameOf = opts.nameOf || (raw => flat(raw, 16) || '士兵');
    // "这个房号是不是已经被一间**对局中**的房占了"只有 net-server 知道（它的 rooms 表）。
    // 不问一句的话，建房与开局会各自往同一个 id 上挂一份 sim —— 那正是 room.mjs 头注释
    // 里数过的串门形状。
    this.liveBusy = opts.liveBusy || (() => false);
    // 等待态房间虽轻（一张名单，没有 sim），但"一个人把表填满"这条口是一样的，
    // 所以配额照 live 那一份的规矩来：总数一个顶，每人名下再一个顶。
    // 漏掉这一条的症状是"大厅里 200 间空房，真想找人的那间翻五页"。
    this.maxWaiting = opts.maxWaiting > 0 ? opts.maxWaiting : 64;
    this.maxPerUser = opts.maxPerUser > 0 ? opts.maxPerUser : 2;
    this.log = opts.log || (() => {});
    this.rooms = new Map();                         // id -> 等待态房间
    this.seatOf = new Map();                        // sid -> { room, seat }
    this.conns = new Set();                         // 挂在大厅频道上的连接
    this.chat = [];                                 // 全服频道（进大厅就能看到最近几句）
    this.rate = new WeakMap();                      // ws -> 聊天速率窗口
    // 每一种拒绝都要数得出来。理由和 lag / streak 那两组计数一模一样：
    // **这些失效全是静默的** —— "开始游戏点了没反应""聊天发不出去"在玩家侧都只是"这游戏坏了"，
    // 而原因（不是房主 / 有人没准备 / 刷屏被限流 / 房间号撞了）完全不同，只能从这里分辨。
    this.stat = {
      say: 0, sayRate: 0, sayEmpty: 0, sayNoRoom: 0,
      join: 0, full: 0, playing: 0, dupId: 0, badId: 0, quota: 0, badMode: 0,
      badMode: 0,
      starts: 0, notHost: 0, tooFew: 0, notReady: 0,
      seats: 0, leaves: 0, swept: 0,
    };
  }

  // ── 小工具 ──
  seat(ws) { return ws && ws.__sid != null ? this.seatOf.get(ws.__sid) : null; }
  touch(room) { room.lastActive = Date.now(); }

  // 一间的对外摘要。列表和"对局中不能进"这两件事都读它，所以只有一份。
  brief(room) {
    let ready = 0;
    for (const s of room.seats.values()) if (s.ready) ready++;
    return {
      id: room.id, title: room.title || room.id, map: room.mapId, mode: room.mode,
      players: room.seats.size, max: MAX_SEATS, ready, time: room.minutes,
      state: room.stage === 'playing' ? 'playing' : 'waiting',
      host: (room.seats.get(room.hostSid) || {}).name || '',
    };
  }
  list() { return [...this.rooms.values()].map(r => this.brief(r)); }

  lobbyState() { return { t: 'lobby', online: this.conns.size, rooms: this.list() }; }
  pushLobby() {
    const m = JSON.stringify(this.lobbyState());
    for (const ws of this.conns) this.send(ws, m);
  }

  // 一间的完整状态。**每个接收者一份**：me 那一格是各人不同的（我是不是房主、我准备了没）。
  // canStart/why 也在这里算：置灰按钮的判据和放行开局的判据必须是同一个函数，
  // 分两处写的症状是"按钮能点但服务端说不能开"（或者反过来，永远点不动）。
  roomState(room, forSeat = null) {
    const seats = [...room.seats.values()].map(s => ({
      sid: s.sid, name: s.name, team: s.team, ready: !!s.ready,
      isHost: s.sid === room.hostSid, xp: s.xp | 0,
    }));
    const me = forSeat ? { sid: forSeat.sid, name: forSeat.name, team: forSeat.team, ready: !!forSeat.ready, isHost: forSeat.sid === room.hostSid } : null;
    const g = this.startGate(room, forSeat);
    return { t: 'room', room: this.brief(room), me, seats, canStart: g.ok, why: g.why, chat: room.chat.slice() };
  }
  pushRoom(room) {
    for (const s of room.seats.values()) {
      if (s.ws) this.send(s.ws, JSON.stringify(this.roomState(room, s)));
    }
  }

  // ── 进 / 出大厅频道 ──
  // 直连对局那条路（?online=1 的 join 帧）要先问这一句：一间还在等人的房子里没有 sim，
  // 绕过大厅直接进的话症状是"进了个空世界，谁也不在，也没有开始"。
  waitingRoom(rawId) {
    const id = roomId(rawId);
    const r = id ? this.rooms.get(id) : null;
    return r && r.stage === 'waiting' ? r : null;
  }
  attach(ws) {
    sidOf(ws);
    this.conns.add(ws);
    this.send(ws, JSON.stringify(this.lobbyState()));
    if (this.chat.length) this.send(ws, JSON.stringify({ t: 'chat', ch: 'lobby', hist: this.chat.slice() }));
    this.pushLobby();          // 在线人数变了，别人那份列表也要跟着变（不重推就永远少一个人）
  }
  detach(ws) {
    this.leaveRoom(ws);
    if (this.conns.delete(ws)) this.pushLobby();
  }

  // ── 座位 ──
  // 房间归谁：有账号的按账号 key（换台机器也认得），访客服上没有 key 可依，
  // 退回"按连接"记 —— 那时这条配额只能挡住一个人开一堆房，挡不住他多开几条连接，
  // 而后者已经被 connsPerIp 那道闸管住了（见 net-server 的 verifyClient）。
  _hostKey(ws, msg = {}) { return msg.account || ('conn:' + sidOf(ws)); }
  _owned(key) { let n = 0; for (const r of this.rooms.values()) if (r.hostKey === key) n++; return n; }
  _mkRoom(id, title, mapId, mode, minutes) {
    const room = { id, title, hostSid: null, mapId, mode, minutes, stage: 'waiting',
      seats: new Map(), chat: [], lastActive: Date.now() };
    this.rooms.set(id, room);
    return room;
  }
  _seat(ws, name, loadout, xp, account) {
    return { sid: sidOf(ws), name, team: 'A', ready: false, xp: xp | 0, account: account || null, ws, loadout: loadout || null };
  }
  // 新来的人塞进人少的那一队。按"谁点得快谁选队"分的话，一屋子人全挤在 A 队，
  // 而房主按开始时的判据里如果要求两队都有人，那就是"人够了却开不了局"。
  _freeTeam(room) {
    let a = 0, b = 0;
    for (const s of room.seats.values()) (s.team === 'B' ? b++ : a++);
    if (a >= MAX_PER_TEAM && b >= MAX_PER_TEAM) return null;
    return a <= b ? 'A' : 'B';
  }
  _place(room, seat) {
    const t = this._freeTeam(room);
    if (!t) return null;
    seat.team = t;
    room.seats.set(seat.sid, seat);
    this.seatOf.set(seat.sid, { room, seat });
    this.stat.seats++;
    return seat;
  }
  // 房主离开时必须有个接手的人，否则这间就再也开不了了（而"没人能开局"在界面上
  // 的表现只是"开始按钮是灰的"，谁都不会想到是房主跑了）。
  _handover(room) {
    if (room.seats.has(room.hostSid)) return;
    const next = room.seats.values().next().value;
    if (!next) { room.hostSid = null; return; }
    room.hostSid = next.sid;
    next.ready = true;
    this._sys(room, next.name + ' 成为新房主');
  }
  _sys(room, text) {
    room.chat.push({ ch: 'room', from: '', name: '系统', text, at: Date.now(), sys: true });
    if (room.chat.length > ROOM_CHAT_HIST) room.chat.splice(0, room.chat.length - ROOM_CHAT_HIST);
  }

  createRoom(ws, msg = {}) {
    if (this.rooms.size >= this.maxWaiting) {
      this.stat.full++;
      return { ok: false, message: '这间服务器上的房间已经够多了，先进一间现成的玩' };
    }
    const id = roomId(msg.room) || ('r' + Date.now().toString(36).slice(-6));
    const hostKey = this._hostKey(ws, msg);
    if (this._owned(hostKey) >= this.maxPerUser) {
      this.stat.quota++;
      return { ok: false, message: `你名下已经有 ${this.maxPerUser} 间房了，先进其中一间玩，或者等它空出来被回收` };
    }
    if (this.rooms.has(id) || this.liveBusy(id)) {
      // 撞号不静默改名：悄悄建出"我的房 2"会让人以为进的是原来那间。
      this.stat.dupId++;
      return { ok: false, message: '这个房间号已经有人在了，换一个或直接用自动生成' };
    }
    const bad = modeGate(msg.mode);
    if (bad) { this.stat.badMode++; return { ok: false, message: bad }; }
    const room = this._mkRoom(id, flat(msg.title, 24), MAP_IDS.has(msg.map) ? msg.map : 'yard',
      MODE_IDS.has(msg.mode) ? msg.mode : 'tdm', cleanMinutes(msg.minutes));
    room.hostKey = hostKey;
    const seat = this._seat(ws, msg.name, msg.loadout, msg.xp, msg.account);
    seat.ready = true;                      // 房主不用点准备：他按下开始就是他的准备
    room.hostSid = seat.sid;
    if (!this._place(room, seat)) { this.rooms.delete(id); this.stat.full++; return { ok: false, message: '房间已满' }; }
    this.stat.join++;
    this._sys(room, seat.name + ' 创建了房间');
    this.pushRoom(room); this.pushLobby();
    return { ok: true, room, seat };
  }

  joinRoom(ws, msg = {}) {
    const id = roomId(msg.room);
    const room = this.rooms.get(id);
    if (!room) { this.stat.badId++; return { ok: false, message: '那间房已经不在了' }; }
    if (room.stage !== 'waiting') { this.stat.playing++; return { ok: false, message: '那间房正在对局中，等它打完或在列表里另找一间' }; }
    const seat = this._seat(ws, msg.name, msg.loadout, msg.xp, msg.account);
    if (!this._place(room, seat)) { this.stat.full++; return { ok: false, message: '那间房已经满了（上限 ' + MAX_SEATS + ' 人）' }; }
    this.stat.join++;
    this._sys(room, seat.name + ' 进来了');
    this.pushRoom(room); this.pushLobby();
    return { ok: true, room, seat };
  }

  // 快速加入：塞进人最多的那间还开着门的房。刻意不是"随便找一间"——
  // 这一条存在的意义就是别让人各自开一间空房。
  quickRoom(ws, msg = {}) {
    let best = null;
    for (const r of this.rooms.values()) {
      if (r.stage !== 'waiting' || r.seats.size >= MAX_SEATS) continue;
      if (this._freeTeam(r) === null) continue;
      if (!best || r.seats.size > best.seats.size) best = r;
    }
    return best ? this.joinRoom(ws, { ...msg, room: best.id }) : this.createRoom(ws, msg);
  }

  leaveRoom(ws) {
    const at = this.seat(ws);
    if (!at) return;
    const { room, seat } = at;
    room.seats.delete(seat.sid);
    this.seatOf.delete(seat.sid);
    if (ws && ws.__sid === seat.sid) ws.__sid = null;
    this.stat.leaves++;
    if (!room.seats.size) { this.rooms.delete(room.id); this.pushLobby(); return; }
    this._handover(room);
    this._sys(room, seat.name + ' 离开了');
    this.touch(room);
    this.pushRoom(room); this.pushLobby();
  }

  // ── 房间里能做的三件小事：准备、换队、改设置 ──
  setReady(ws, msg = {}) {
    const at = this.seat(ws); if (!at) return;
    const { room, seat } = at;
    const on = msg.on !== false && msg.on !== 'false';
    // 顺手把这一帧带来的配装存进座位。为什么搭在"准备"这一句上而不是另开一帧：
    // 玩家从"编辑装备"回房间屏时一定会重发这一句，于是"改了枪但没把新枪带进对局"
    // 那种错位没有机会发生 —— 少这一条的症状是"我明明换了枪，进局还是 m4"。
    // 装备的**清洗**不在这里做：开局那一刻 room.addClient 会按表重建（js/loadout.mjs）。
    if (msg.loadout && typeof msg.loadout === 'object') seat.loadout = msg.loadout;
    if (room.stage !== 'waiting') return;         // 开局之后这一格没有意义
    // 房主恒为已准备（见 createRoom）。让他"取消准备"会造出一个自相矛盾的状态：
    // 判据要求人人准备，而唯一能让它不成立的那个人正是能按开始的那个人。
    seat.ready = on || seat.sid === room.hostSid;
    this.touch(room);
    this.pushRoom(room);
  }
  setTeam(ws, team) {
    const at = this.seat(ws); if (!at) return;
    const { room, seat } = at;
    if (room.stage !== 'waiting') return;
    const t = team === 'B' ? 'B' : 'A';
    let n = 0;
    for (const s of room.seats.values()) if (s.team === t && s.sid !== seat.sid) n++;
    if (n >= MAX_PER_TEAM) { this.send(ws, JSON.stringify({ t: 'err', msg: '那一队已经站满了' })); return; }
    seat.team = t;
    this.touch(room);
    this.pushRoom(room);
  }
  // 房主可以在等着的时候改地图/模式/房名。开局之后就改不动了 ——
  // 那需要把"已经在跑的 sim"换掉，症状是别人正打着仗，地图凭空没了。
  setCfg(ws, msg = {}) {
    const at = this.seat(ws); if (!at) return;
    const { room, seat } = at;
    if (room.stage !== 'waiting') return;
    if (seat.sid !== room.hostSid) { this.stat.notHost++; this.send(ws, JSON.stringify({ t: 'err', msg: '只有房主能改房间设置' })); return; }
    const bad = modeGate(msg.mode);
    if (bad) { this.stat.badMode++; this.send(ws, JSON.stringify({ t: 'err', msg: bad })); return; }
    if (msg.title != null) room.title = flat(msg.title, 24);
    if (MAP_IDS.has(msg.map)) room.mapId = msg.map;
    if (MODE_IDS.has(msg.mode)) room.mode = msg.mode;
    if (MIN_SET.has(Number(msg.minutes))) room.minutes = Number(msg.minutes);
    this.touch(room);
    this.pushRoom(room); this.pushLobby();
  }

  // 开局的判据。**唯一的真**：按钮置灰和放行开局都问它（见 roomState 里的 canStart）。
  startGate(room, seat) {
    if (!seat) return { ok: false, why: '你不在任何房间里。' };
    if (room.stage !== 'waiting') return { ok: false, why: '这间已经在对局中了。' };
    if (seat.sid !== room.hostSid) return { ok: false, why: '只有房主能开始游戏。' };
    if (room.seats.size < 2) return { ok: false, why: '至少还要再来一个人。' };
    const wait = [...room.seats.values()].filter(s => s.sid !== room.hostSid && !s.ready).map(s => s.name);
    if (wait.length) return { ok: false, why: '还在等：' + wait.slice(0, 4).join('、') + (wait.length > 4 ? '…' : '') };
    return { ok: true, why: '' };
  }

  // 房主按下开始。这里只**判定与翻状态**，建 sim 是 net-server 的活（它才有 rooms 表和
  // 那份 60Hz 循环）。失败时把原因按种类记进 stat —— 五种拒绝在玩家侧都是"点了没反应"。
  start(ws) {
    const at = this.seat(ws);
    if (!at) return { ok: false, message: '你不在任何房间里。' };
    const { room, seat } = at;
    const g = this.startGate(room, seat);
    if (!g.ok) {
      if (room.stage !== 'waiting') this.stat.playing++;
      else if (seat.sid !== room.hostSid) this.stat.notHost++;
      else if (room.seats.size < 2) this.stat.tooFew++;
      else this.stat.notReady++;
      return { ok: false, message: g.why };
    }
    room.stage = 'playing';
    this.stat.starts++;
    this.touch(room);
    return { ok: true, room, seats: [...room.seats.values()] };
  }
  // sim 没建起来（地图加载失败之类）：把状态还回去，别让一间房卡在"对局中"却没有对局。
  startFailed(room, why) {
    room.stage = 'waiting';
    for (const s of room.seats.values()) s.ready = s.sid === room.hostSid;
    this._sys(room, '开局失败：' + (why || '服务端没能建起这一间'));
    this.pushRoom(room); this.pushLobby();
  }
  // 一打完就回房间：清掉准备状态（下一局要重新点准备，这是 CF 的规矩 ——
  // 自动继承上一份准备状态的话，房主再按开始时会把还没回来的人一起拖进对局）。
  liveEnded(room) {
    if (!room) return;
    room.stage = 'waiting';
    for (const s of room.seats.values()) s.ready = s.sid === room.hostSid;
    this._sys(room, '对局结束，回到房间');
    this.touch(room);
    this.pushRoom(room); this.pushLobby();
  }

  // ── 聊天 ──
  // 两条频道：'lobby'（所有挂在大厅上的连接）与 'room'（同一间的座位）。
  // 速率与长度都在这里判，一条都不交给客户端 —— 客户端那些只是回车键的体验。
  _allow(ws, now) {
    let r = this.rate.get(ws);
    if (!r) { r = { last: 0, burst: [] }; this.rate.set(ws, r); }
    if (now - r.last < SAY_MIN_MS) return false;
    r.burst = r.burst.filter(t => now - t < SAY_BURST_MS);
    if (r.burst.length >= SAY_BURST) return false;
    r.burst.push(now); r.last = now;
    return true;
  }
  say(ws, msg = {}) {
    const now = Date.now();
    const text = flat(msg.text, CHAT_LEN);
    if (!text) { this.stat.sayEmpty++; return; }
    if (!this._allow(ws, now)) {
      this.stat.sayRate++;
      // 被限流要当场说一声。不响的话玩家只会以为自己打的字没保存，于是一条"防线"
      // 在人的经验里就变成了"这游戏连聊天都做不好"。
      this.send(ws, JSON.stringify({ t: 'err', msg: '说得太快了，歇半秒再说' }));
      return;
    }
    const ch = msg.ch === 'room' ? 'room' : 'lobby';
    const at = this.seat(ws);
    if (ch === 'room' && (!at || !at.room)) { this.stat.sayNoRoom++; return; }
    this.stat.say++;
    // 名字取**座位上那份**（座位上的名字来自会话或访客白名单），不是这一帧带来的：
    // 聊天是最容易被拿来冒充别人的地方，而"服务端不用客户端给的身份"这一条
    // 在 join 那里已经立过一次（见 net-server:joinName），这里不能开个反例。
    const from = ch === 'room' ? at.seat.name : (ws.__name || flat(msg.name, 16) || '路人');
    const row = { ch, from, name: from, text, at: now };
    if (ch === 'room') {
      const room = at.room;
      room.chat.push(row);
      if (room.chat.length > ROOM_CHAT_HIST) room.chat.splice(0, room.chat.length - ROOM_CHAT_HIST);
      const m = JSON.stringify({ t: 'chat', ch, ...row });
      for (const s of room.seats.values()) if (s.ws) this.send(s.ws, m);
      this.touch(room);
    } else {
      this.chat.push(row);
      if (this.chat.length > LOBBY_CHAT_HIST) this.chat.splice(0, this.chat.length - LOBBY_CHAT_HIST);
      const m = JSON.stringify({ t: 'chat', ch, ...row });
      for (const c of this.conns) this.send(c, m);
    }
  }

  // 空房回收：只有"一个人都没有"的才收（有人在等就一直在）。
  // 走 net-server 那个 5 秒一轮的 sweeper，不自己再开一个定时器。
  sweep(now = Date.now()) {
    for (const [id, room] of this.rooms) {
      if (room.seats.size) continue;
      if (now - room.lastActive > WAIT_IDLE_MS) { this.rooms.delete(id); this.stat.swept++; }
    }
  }

  // /healthz 带出去的那一格。刻意把每一项都列出来而不是直接甩 this.stat：
  // 运维页上"有个数在涨"要能一眼对上"哪种拒绝在发生"。
  stats() {
    let waiting = 0, playing = 0;
    for (const r of this.rooms.values()) (r.stage === 'playing' ? playing++ : waiting++);
    return { ...this.stat, conns: this.conns.size, rooms: this.rooms.size, waiting, playing,
      maxSeats: MAX_SEATS, sayMinMs: SAY_MIN_MS, sayBurst: SAY_BURST };
  }
}



