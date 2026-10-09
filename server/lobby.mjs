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
import { MP_MAPS, MP_MODES, MP_MINUTES, minutesOptions, DEFAULT_MINUTES, scoreOptions, mapAllowed, mapsForMode, BOT_NAMES, BOT_SKILLS } from '../js/data.js';
import { DEFAULT_SCORE_LIMIT } from '../js/match-rules.js';

// 一间的上限。和 net-server:pickRoom 里那个"人最多且没满"是同一个数 ——
// 两处各写一份的话，改一处的症状是"列表说还能进、进去说满了"。
// 64 = dom 30v30 的落点（docs/dom-large-scale-plan.md 阶段 0）：真正的护栏不是这个数，
// 而是广播/记分板那几条 O(N²) 的路径（board Top-N 裁剪与快照 AOI 是同一批落地的配套）。
// Bot 也占这一格：坐几个人、放几个 Bot 都从这里出（net-server:pickRoom import 同一常量）。
export const MAX_SEATS = 64;
export const MAX_PER_TEAM = MAX_SEATS / 2;
// Bot 与真人**共用一个上限**：一间房里 64 个位置，坐几个人、放几个 Bot 都从这一格里出。
// 给 Bot 另设一个上限的话，"列表说还能进、进去说满了"那种错位又回来了（这就是 seats
// 那一条注释里已经数过的同一个形状）。
// 难度三档的**名字表**在 js/data.js（房间屏也要画它）；这里只认下标。
// 难度本身的定义在 js/ai.js 的 DIFF —— 这里抄一份的话，
// 改难度表的症状是"联机的 Bot 和单机不一样"。
// 一条聊天多少字。上限的理由不是"防刷长文"，是它会被广播给一屋子人：
// 没有上限的话一条 64 KB 的"消息"就是 16 份 64 KB 下行（maxPayload 只管单帧，不管扇出）。
export const CHAT_LEN = 120;
export const LOBBY_CHAT_HIST = 50;                  // 全服频道留多少条历史
export const ROOM_CHAT_HIST = 40;
// 聊天速率：稳态每 600 ms 一条，另给 10 秒窗口内 6 条的突发余量。
// 正常打字快的人一秒也就两三条；不限的话"进对局"就变成"谁的刷屏赢"。
export const SAY_MIN_MS = 600, SAY_BURST = 6, SAY_BURST_MS = 10000;
// ── "重帧"的按连接限额（M7）──
// 与聊天那一套同一个形状，但管的是另一件事：createRoom / joinRoom / leaveRoom / botAdd…
// 每一种都要付真金白银 —— 一次全大厅广播，开着目录的部署还多一次跨进程写。
// 总闸（net-server 的 wsMsgPerSec=240/s）是**不分帧型**的，所以一条连接 240 帧/秒地
// 建房→退房就能把所有人的大厅拖慢，而玩家侧看到的只是"刷新很慢"。
// 哪几条帧要**付钱**（一次全大厅广播；开着目录的部署还多一次跨进程写）。
// 放在 lobby 而不是 net-server：付钱的是这一层，也只有这一层分得清"改设置"和"发一句话"。
// ready/team 也在这里（性能审查 P1）：ready 每次都是 pushRoom（每座位一份 JSON）+
// pushLobby（全厅广播），team 是一次全座位重建 —— 只占**突发**档（它们不在
// HEAVY_MIN_FRAMES 里，连点准备/换队是正常操作，不吃 250ms 最小间隔）。
export const HEAVY_FRAMES = new Set(['createRoom', 'joinRoom', 'quickRoom', 'leaveRoom', 'botAdd', 'botDel', 'roomCfg', 'ready', 'team']);
// 分**两档**（这是判据逼出来的，不是先验的）：
//   · 最小间隔只套在"房间生命周期"那一档 —— 每次成功都要建/删座位、广播、写目录，
//     而人一分钟也做不了几次；
//   · 突发额度套在所有重帧上。
// 起初我把最小间隔套在全部七条帧上，`test/room-flow.mjs` 当场红了两段：房主连点
// "+ Bot"（20 连发）与连着改设置（两句 roomCfg 挨着发）都是**正常操作**，套上 250 ms
// 之后它们全被回"操作太快了，缓一下" —— 那是把正常操作当攻击。
// 但配置帧的洪水照样要挡（一次 roomCfg 也是一次全大厅广播），所以那一档的额度不动。
export const HEAVY_MIN_MS = 250, HEAVY_BURST = 40, HEAVY_BURST_MS = 10000;
export const HEAVY_MIN_FRAMES = new Set(['createRoom', 'joinRoom', 'quickRoom', 'leaveRoom']);
// 空的等待房间留多久。比 live 那份的 ROOM_IDLE_MS(60s) 长得多是有意的：
// 大厅里"刚建好、还差一个人"的房，是会被别人过几分钟才点进来的。
export const WAIT_IDLE_MS = 5 * 60 * 1000;
// 全厅广播的合帧窗口（性能审查 P1）。50ms：人手操作的间隔远大于它（感觉不到合帧），
// 而风暴形状（断线、批量进退房、刷重帧）在这一窗内全部并成一次。
const LOBBY_COALESCE_MS = 50;

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
// 时长档位**按模式换表**（js/data.js:minutesOptions）：dom 是 15/25/35 那一档
// （占点涨分慢，3/5 分钟的局刚进入状态就到点），一张 Set 打天下会把 dom 房里的
// 3 分当合法时长收下 —— 与下面 cleanScore 的教训同一句。
const cleanMinutes = (v, mode) => { const n = Number(v); return minutesOptions(mode).includes(n) ? n : DEFAULT_MINUTES(mode); };
// 胜利目标那格与时长同一套规矩：不认的值**退回该模式的默认**（DEFAULT_SCORE_LIMIT），
// 而不是退回一个写死的数 —— 三种模式的目标语义不同（击杀数 / 占领分数）。
// 静默换值的症状与时长那条一样：房间标题上写的数从此是假的。
// 档位本身也**按模式换表**（js/data.js:scoreOptions）：dom 是 100/200/500 那一档
// （它从 50 起步、涨速与击杀数不同量纲），一张 Set 打天下会把 dom 房里的 50 分
// 当成合法目标收下。
const cleanScore = (v, mode) => { const n = Number(v); return scoreOptions(mode).includes(n) ? n : DEFAULT_SCORE_LIMIT(mode); };

// 专属图的门，与 modeGate 同一形状：认得出的组合放行，不认识的**当场拒绝**（拒绝要
// 说得具体 —— "「双丘战区」只在占领开放"，而不是一句"地图不对"）。绑定是**双向**的
// （js/data.js:mapAllowed）：图绑模式（ridges 只在占领）与模式绑图（占领只在 ridges）
// 各说各的话。选择器（js/menu.js）已经按 mapAllowed 藏了卡片，这里是后盾：绕过
// 界面直接发帧的组合走不到房间里。
const MAP_NAMES = Object.fromEntries(MP_MAPS.map(m => [m.id, m.name]));
const mapGate = (mapId, mode) => {
  if (mapAllowed(mapId, mode)) return null;
  const m = MP_MAPS.find(x => x.id === mapId);
  if (m && m.modes) return `「${m.name}」只在${m.modes.map(id => MODE_NAMES[id] || id).join('、')}模式开放`;
  const md = MP_MODES.find(x => x.id === mode);
  const names = ((md && md.maps) || []).map(id => MAP_NAMES[id] || id).join('、');
  return `「${(md && md.name) || mode}」只在「${names}」这张图上打`;
};

let NEXT_SID = 1;
// 一条连接的座位号在**进大厅那一刻**就发下去，不等它进哪间房。座位的键是它，
// 房主配额的键也要是它（访客服上没有账号可依，见 _hostKey）—— 两处各自 lazily
// 分配的话，"同一条连接"在两张表里会是两个号，配额就数错了。
const sidOf = (ws) => ws.__sid == null ? (ws.__sid = NEXT_SID++) : ws.__sid;

// 面向广播的用户文本一律先拍平再用。控制字符能伪造聊天行（换行），零宽字符能让
// "甲"和"甲"看起来是两个人 —— 而这两种都只会在别人的界面上显形。少洗一处的症状
// 是"某人发一条消息，别人那儿的界面跟着乱"。
// 导出给 net-server 的对局内聊天（matchSay / doReport）用同一把拍子 —— 各洗各的
// 会出现"大厅里发不出来、对局里发得出去"的第二种规则。
export function flat(s, n) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, n);
}
// 房号沿用 live 那一份的白名单（net-server:pickRoom）。中文房名当房号会被洗成空串，
// 症状是"建了个房，人却进了别人的房间" —— 所以房名与房号是两格，各洗各的。
// 房号的白名单与长度上限**只有这一处**（低危账：net-server 的 pickRoom 曾经自己写了一份
// 48 —— 两处各截各的，于是同一个房号在两处会截成两个键）。
export const ROOM_ID_MAX = 32;
export const ROOM_ID_BAD = /[^A-Za-z0-9_.-]/g;
export const roomId = (raw) => String(raw == null ? '' : raw).slice(0, ROOM_ID_MAX).replace(ROOM_ID_BAD, '');

// 一张等待态房间。刻意不做成类：它没有行为，行为全在下面的 Lobby 里 ——
// 分两处放的话"改一处的规则"会在另一处漏掉，而这类漏掉都不会报错。
//   stage: 'waiting' 只有一张名单，没有 sim；'playing' 已经有对应的 live 房间在跑
//   seat:  {sid, name, team, ready, xp, account, ws, loadout, streaks}
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
    // 全服频道（进大厅就能看到最近几句）。**历史活得过服务重启**（差距 45 的"历史不持久化"）：
    // 开局时从存储回填（loadChat），每说一句回存一格（saveChat）。这两个钩子由 net-server
    // 接到 store.meta 上 —— 这一层不摸磁盘，判据就能用内存版换掉它。
    // 房间里的聊天**不**落盘：房间本身不活过重启（座位/准备/Bot 名单全在内存），
    // 只有"这间房在"才有这段对话的语境，为它存档只会留一堆没人认领的旧话。
    this.loadChat = opts.loadChat || (() => []);
    this.saveChat = opts.saveChat || (() => {});
    const hist = this.loadChat();
    this.chat = Array.isArray(hist) ? hist : [];
    // 跨进程房间目录（net-server 注入，没开目录就是空数组）：别台的行跟着本地的一起推进
    // 大厅帧 —— "ws 大厅帧"与"/api/rooms"必须是同一份名单，分两处各拼一遍就会漂移。
    this.remoteRooms = opts.remoteRooms || (() => []);
    // 本台名单变了（pushLobby 的每一个调用点）通知一声外面 —— 房间目录拿它自报行。
    // 不通知的话，"在 A 台建的房"要等下一个心跳才出现在 B 台的列表里。
    this.onChange = opts.onChange || null;
    this.rate = new WeakMap();                      // ws -> 聊天速率窗口
    // 每一种拒绝都要数得出来。理由和 lag / streak 那两组计数一模一样：
    // **这些失效全是静默的** —— "开始游戏点了没反应""聊天发不出去"在玩家侧都只是"这游戏坏了"，
    // 而原因（不是房主 / 有人没准备 / 刷屏被限流 / 房间号撞了）完全不同，只能从这里分辨。
    this.stat = {
      say: 0, sayRate: 0, sayEmpty: 0, sayNoRoom: 0,
      // 重帧被限速的次数（M7）。和 sayRate 一样：限速生效的样子在玩家侧只是
      // "点了没反应"，不数出来就只能靠猜。
      heavyRate: 0,
      // 局内换配装帧被最小间隔丢掉的次数（性能审查 N5）：正常玩家碰不到这条闸，
      // 非零即有人在拿窄帧灌 sanitizeLoadout。
      loadoutRate: 0,
      // 举报：来了多少条、多少条找不到人、多少条是自己举报自己。后两者都是"报了但没用"——
      // 与 streak.rejected 同一性质的读数：没生效的举报在玩家侧只表现为"石沉大海"。
      report: 0, reportNoTarget: 0, reportSelf: 0,
      // 重名导致的拒绝（M3）。它**不是**"找不到人"：人是有的，只是不止一个。
      // 合成一格的话，"玩家说举报了但没生效"就分不清是名字打错了还是重名 ——
      // 而这两件事的修法完全不同（一个是打字，一个是让重名的人改呼号）。
      reportAmbiguous: 0,
      // 私聊与表情：同样把"发了但没用"单列（找不到人 / 私聊自己 / 没有这个表情），
      // 否则它们和正常发言混在一格里，谁也归不了因。
      whisper: 0, whisperNoTarget: 0, whisperSelf: 0, whisperAmbiguous: 0,
      emote: 0, emoteBad: 0,
      join: 0, full: 0, playing: 0, dupId: 0, badId: 0, quota: 0, badMode: 0, badMap: 0,
      badMode: 0,
      starts: 0, notHost: 0, tooFew: 0, notReady: 0,
      seats: 0, leaves: 0, swept: 0,
      botAdd: 0, botDel: 0, botFull: 0,
      // 补人这一路也要数得出来：自动补上了几个、让位给真人几个。没有这两个数的话
      // "这间房怎么一直满的""我的 Bot 去哪了"都只能靠猜。
      botAuto: 0, botGive: 0,
    };
  }

  // ── 小工具 ──
  seat(ws) { return ws && ws.__sid != null ? this.seatOf.get(ws.__sid) : null; }
  touch(room) { room.lastActive = Date.now(); }

  // 一间的对外摘要。列表和"对局中不能进"这两件事都读它，所以只有一份。
  // Bot 也占位置，所以 players 是"真人 + Bot"，另把 Bot 数单独带出去 ——
  // 列表上写着"6/16"而进去只看见一个人的那种错觉，靠这一格拆开。
  brief(room) {
    let ready = 0;
    for (const s of room.seats.values()) if (s.ready) ready++;
    const bots = room.bots ? room.bots.size : 0;
    return {
      id: room.id, title: room.title || room.id, map: room.mapId, mode: room.mode,
      players: room.seats.size + bots, max: MAX_SEATS, bots, ready: ready + bots, time: room.minutes,
      score: room.scoreLimit,
      state: room.stage === 'playing' ? 'playing' : 'waiting',
      host: (room.seats.get(room.hostSid) || {}).name || '',
    };
  }
  list() { return [...this.rooms.values()].map(r => this.brief(r)); }

  lobbyState() { return { t: 'lobby', online: this.conns.size, rooms: [...this.list(), ...this.remoteRooms()] }; }
  // 全厅广播走 50ms 合帧（性能审查 P1）：断线风暴/批量进房时，每一次变动都是一次
  // "重建全量清单 + stringify + 发给所有连接"，n 条连接的 n 次进出就是 O(n²)。
  // 窗口内的多次变更只花最后一份的钱；对外形状 {t:'lobby', online, rooms} 不变，
  // 客户端本来就要把每帧清单当"全量替换"处理，少几帧中间态没有任何语义。
  pushLobby() {
    if (this.__lobbyTimer) return;
    this.__lobbyTimer = setTimeout(() => {
      this.__lobbyTimer = null;
      const m = JSON.stringify(this.lobbyState());
      for (const ws of this.conns) this.send(ws, m);
      if (this.onChange) this.onChange();
    }, LOBBY_COALESCE_MS);
  }

  // 一间的公共状态：seats/bots/brief/chat 这些**每个接收者都一样**的部分只建一次。
  // roomState（单人）与 pushRoom（全座位）都从这里出发 —— 曾经 pushRoom 对每个座位
  // 各建一遍公共部分再各自 stringify，16 座位 = 16 份几乎相同的数组与拷贝。
  roomShared(room) {
    return {
      brief: this.brief(room),
      seats: [...room.seats.values()].map(s => ({
        sid: s.sid, name: s.name, team: s.team, ready: !!s.ready,
        isHost: s.sid === room.hostSid, xp: s.xp | 0,
      })),
      // Bot 单独一列而不是混进 seats：seats 那一格的语义是"一条连接"（下游到处假设
      // seat.ws 存在、seat 能当房主），把 Bot 塞进去会让 _handover 有朝一日把房主交给一个 Bot，
      // 而那种房间的开始按钮永远点不动，且不报错。
      bots: room.bots ? [...room.bots.values()].map(b => ({ bid: b.bid, name: b.name, team: b.team, skill: b.skill })) : [],
      botSkill: room.botSkill | 0,
      fill: !!room.fill,
      chat: room.chat.slice(),
    };
  }
  // 一间的完整状态。**每个接收者一份**：me 那一格是各人不同的（我是不是房主、我准备了没）。
  // canStart/why 也在这里算：置灰按钮的判据和放行开局的判据必须是同一个函数，
  // 分两处写的症状是"按钮能点但服务端说不能开"（或者反过来，永远点不动）。
  roomState(room, forSeat = null) {
    const sh = this.roomShared(room);
    const me = forSeat ? { sid: forSeat.sid, name: forSeat.name, team: forSeat.team, ready: !!forSeat.ready, isHost: forSeat.sid === room.hostSid } : null;
    const g = this.startGate(room, forSeat);
    return { t: 'room', room: sh.brief, me, seats: sh.seats, bots: sh.bots, botSkill: sh.botSkill,
      fill: sh.fill, canStart: g.ok, why: g.why, chat: sh.chat };
  }
  pushRoom(room) {
    const sh = this.roomShared(room);
    for (const s of room.seats.values()) {
      if (!s.ws) continue;
      const me = { sid: s.sid, name: s.name, team: s.team, ready: !!s.ready, isHost: s.sid === room.hostSid };
      const g = this.startGate(room, s);
      this.send(s.ws, JSON.stringify({ t: 'room', room: sh.brief, me, seats: sh.seats, bots: sh.bots,
        botSkill: sh.botSkill, fill: sh.fill, canStart: g.ok, why: g.why, chat: sh.chat }));
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
    // 幂等（性能审查 P1）：只有**新**连接才改变"在线"这件事。重复 attach（对着同一条
    // 连接狂发 {t:'lobby'} 帧）曾经每次都触发一次全厅广播 —— 在开着目录的部署上还
    // 各带一次跨进程写。已挂上的连接只回它自己一份状态，别人的清单不受影响。
    const fresh = !this.conns.has(ws);
    this.conns.add(ws);
    this.send(ws, JSON.stringify(this.lobbyState()));
    if (this.chat.length) this.send(ws, JSON.stringify({ t: 'chat', ch: 'lobby', hist: this.chat.slice() }));
    if (fresh) this.pushLobby();          // 在线人数变了，别人那份列表也要跟着变（不重推就永远少一个人）
  }
  detach(ws) {
    // 按 **ws** 把每一间里的座位都退掉，不按 seatOf：seatOf 只指向最后一间，一旦哪条
    // 路漏清了旧座位（守卫生效前的旧连接、未来的新入口），幽灵座位就没人认领 ——
    // sweep 只收空房，那间房会带着一个走不掉的"房主"活到进程重启，谁也开不了局。
    // 正常的单座位路径与 leaveRoom 完全同一条（_dropSeat），推送次数不变。
    for (const room of [...this.rooms.values()]) {
      for (const s of [...room.seats.values()]) if (s.ws === ws) this._dropSeat(room, s, ws);
    }
    if (this.conns.delete(ws)) this.pushLobby();
  }

  // ── 座位 ──
  // 房间归谁：有账号的按账号 key（换台机器也认得），访客服上没有 key 可依，
  // 退回"按连接"记 —— 那时这条配额只能挡住一个人开一堆房，挡不住他多开几条连接，
  // 而后者已经被 connsPerIp 那道闸管住了（见 net-server 的 verifyClient）。
  _hostKey(ws, msg = {}) { return msg.account || ('conn:' + sidOf(ws)); }
  _owned(key) { let n = 0; for (const r of this.rooms.values()) if (r.hostKey === key) n++; return n; }
  _mkRoom(id, title, mapId, mode, minutes, scoreLimit) {
    const room = { id, title, hostSid: null, mapId, mode, minutes, scoreLimit, stage: 'waiting',
      seats: new Map(), chat: [], lastActive: Date.now(),
      // 房主加的 Bot。**只在等待态可改**：开局那一刻这份名单被读进 sim，之后再动它
      // 就要往一个正在跑的世界里插人（快照里的实体表会长出来一格，而客户端的名册
      // 是在 welcome 里一次性给的）—— 那种"半路冒出一个人"的错最难查，所以直接不让它发生。
      bots: new Map(), botSeq: 0, botSkill: 1,
      // 自动补人（房主开关，默认关）。开着的时候这一间**永远是满的**：人一走就补一个 Bot、
      // 人一来就让一个 Bot 站起来 —— 于是任何时刻按下开始都能打一场 16 人的仗，
      // 而不是"凑齐两个人先打 1v1"。
      // 为什么是开关而不是默认行为：一间房在列表上写着 16/16 时，别人会以为里面站满了人。
      // 补出来的位置必须能被房主看见、能被关掉，否则那条读数就成了一句谎话。
      // 只补 Bot 不给真人让位的话，这间房就是一间"看起来满、谁也进不来"的死房 ——
      // 所以真人进场时 Bot 必须让位（见 _makeRoomForHuman）。
      fill: false };
    this.rooms.set(id, room);
    return room;
  }
  _seat(ws, name, loadout, xp, account, streaks, view) {
    // view = 这个人的视角设置（sens/adsSens/invertY）。它**只是过一手**：这里不校验也不清洗
    // （清洗在 server/room.mjs:addClient，那是权威端唯一认这份数据的地方），
    // 开局时由 net-server:beginLive 原样交给 enterMatch。不存它的话，"从房间开出来的局"
    // 会拿服务端默认的 1.0 积分视角，而"直连的局"用的是客户端那份 —— 两个入口两种手感。
    return { sid: sidOf(ws), name, team: 'A', ready: false, xp: xp | 0, account: account || null, ws, loadout: loadout || null, streaks: Array.isArray(streaks) ? streaks : null, view: view || null };
  }
  _total(room) { return room.seats.size + (room.bots ? room.bots.size : 0); }
  _teamCount(room, t) {
    let n = 0;
    for (const s of room.seats.values()) if (s.team === t) n++;
    if (room.bots) for (const b of room.bots.values()) if (b.team === t) n++;
    return n;
  }
  // 新来的人塞进人少的那一队。按"谁点得快谁选队"分的话，一屋子人全挤在 A 队，
  // 而房主按开始时的判据里如果要求两队都有人，那就是"人够了却开不了局"。
  // Bot 也要算进两队的人数：不算的话，一间摆了 8 个 A 队 Bot 的房还能再塞 8 个人进 A 队，
  // 开局就是 16 打 0 —— 而列表上这间房只显示"8/16"，谁也看不出它已经歪了。
  _freeTeam(room) {
    if (this._total(room) >= MAX_SEATS) return null;
    const a = this._teamCount(room, 'A'), b = this._teamCount(room, 'B');
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
  // ── 自动补人（房主的开关） ──
  // 造一个 Bot。手动加与自动补走**同一个**函数：各写一份的症状是"补出来的 Bot 没有
  // 难度、或者名字和手动那个撞了"，而这两种都只会在对局里显形。
  _addBot(room, team, skill) {
    const bid = ++room.botSeq;
    const bot = { bid, name: this._botName(room), team, skill };
    room.bots.set(bid, bot);
    return bot;
  }
  // 把这一间补到满。**不 push**：调用方（改设置 / 有人离开 / 一局打完）手里那一次
  // 广播要连自己的改动一起发出去，多推一帧的症状是房间屏闪一下旧名单。
  _fillBots(room) {
    if (!room.fill || room.stage !== 'waiting') return 0;
    let n = 0;
    while (this._total(room) < MAX_SEATS) {
      const team = this._botTeam(room, null);
      if (!team) break;                       // 两队都满了（不可能，除非 MAX_SEATS 不是偶数）
      this._addBot(room, team, room.botSkill | 0);
      this.stat.botAuto++;
      n++;
    }
    return n;
  }
  // 这一间还能不能再收一个**真人**。扑满的时候只有"补人开着且有 Bot 可让位"这一条路。
  _canTakeHuman(room) {
    if (room.stage !== 'waiting') return false;
    if (this._freeTeam(room) !== null) return true;
    return !!room.fill && room.bots.size > 0;
  }
  // 真人优先：满了就从**人少的那一队**撤一个 Bot 腾位置，返回撤掉的那个。
  // 撤谁：**最后加的那个**（和手动"减一个"同一个直觉，也保证手动摆的那些先留下）。
  // 放在 _place 之前调用：之后调用的话 _place 先撞上"满"那一格，人还是进不来 ——
  // 而症状是"列表说还能进（补人的房永远显示满），点了却说满了"。
  _makeRoomForHuman(room) {
    if (!room.fill || room.stage !== 'waiting') return null;
    if (this._freeTeam(room) !== null) return null;      // 还有空位，不用惊动任何人
    const list = [...room.bots.values()];
    if (!list.length) return null;
    const a = this._teamCount(room, 'A'), b = this._teamCount(room, 'B');
    // 撤人多的那一队的最后一个：撤完之后那一队仍有位置给新人，另一队不受影响。
    const want = a > b ? 'A' : 'B';
    const bot = [...list].reverse().find(x => x.team === want) || list[list.length - 1];
    room.bots.delete(bot.bid);
    this.stat.botGive++;
    return bot;
  }
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
    // 地图×模式的组合也在落座前验完（拒绝项全过才动座位 —— 与上一条同一句）。
    const mode = MODE_IDS.has(msg.mode) ? msg.mode : 'tdm';
    // 没带地图（老客户端 / 直连）时的兜底跟着模式走：占领只认 ridges —— 别把"没填"
    // 兜到 yard 上再被 mapGate 拒掉，"没填"与"填错"是两回事，前者拿该模式的默认图。
    const allowed = mapsForMode(mode);
    const mapId = MAP_IDS.has(msg.map) ? msg.map
      : (allowed.some(m => m.id === 'yard') ? 'yard' : allowed[0].id);
    const badMap = mapGate(mapId, mode);
    if (badMap) { this.stat.badMap++; return { ok: false, message: badMap }; }
    // 落座前先退掉别处的座位（判据与 joinRoom 那条同一句）。放在**全部拒绝项之后**：
    // 建房被拒的人不该把现在坐着的位子也一并丢了。
    const at = this.seat(ws);
    if (at) this.leaveRoom(ws);
    const room = this._mkRoom(id, flat(msg.title, 24), mapId,
      mode, cleanMinutes(msg.minutes, mode), cleanScore(msg.scoreLimit, mode));
    room.hostKey = hostKey;
    const seat = this._seat(ws, msg.name, msg.loadout, msg.xp, msg.account, msg.streaks, msg.view);
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
    // 一条连接同时只占**一个**座位。已经在这一间里 = 这一句其实是"回房间"：原样推一份
    // 状态就完事 —— 放它走重新落座的话，_freeTeam 会重新分队、准备清零，还白送一句
    // "进来了"（客户端从"编辑装备"回来的路上就会重发这一句，那些副作用全是白送的）。
    // 在别的间里 = 先把那边退干净再落座：不清的话旧房间留下一张走不掉、准备不了的
    // 幽灵座位 —— 房主是它的话那间永远开不了局，断线清理又只认 seatOf（最后一间），
    // 而 sweep 只收空房：一间僵尸房就这么活到进程重启。
    const at = this.seat(ws);
    if (at && at.room === room) { this.pushRoom(room); return { ok: true, room, seat: at.seat }; }
    if (at) this.leaveRoom(ws);
    const seat = this._seat(ws, msg.name, msg.loadout, msg.xp, msg.account, msg.streaks, msg.view);
    // 满了而补人开着：先让一个 Bot 站起来（真人优先），再放座位。
    const yielded = this._makeRoomForHuman(room);
    if (!this._place(room, seat)) {
      // 腾了位置还放不进去（理论上到不了这里）：把让位的那个还回原位，别把名单改坏。
      if (yielded) room.bots.set(yielded.bid, yielded);
      this.stat.full++; return { ok: false, message: '那间房已经满了（上限 ' + MAX_SEATS + ' 个位置，Bot 也占位置）' };
    }
    this.stat.join++;
    this._sys(room, seat.name + ' 进来了' + (yielded ? `（${yielded.name} 让出位置）` : ''));
    this.pushRoom(room); this.pushLobby();
    return { ok: true, room, seat };
  }

  // 快速加入：塞进人最多的那间还开着门的房。刻意不是"随便找一间"——
  // 这一条存在的意义就是别让人各自开一间空房。
  // "还开着门"的判据要用 _canTakeHuman：补人的房在列表上永远是 16/16，
  // 按 _total < MAX_SEATS 筛的话，最需要人来（也最打得起）的那几间反而被跳过了。
  quickRoom(ws, msg = {}) {
    let best = null;
    for (const r of this.rooms.values()) {
      if (!this._canTakeHuman(r)) continue;
      if (!best || r.seats.size > best.seats.size) best = r;
    }
    return best ? this.joinRoom(ws, { ...msg, room: best.id }) : this.createRoom(ws, msg);
  }

  leaveRoom(ws) {
    const at = this.seat(ws);
    if (!at) return;
    this._dropSeat(at.room, at.seat, ws);
  }

  // 摘掉一个座位的**全部后续**：告别一句、移交房主、补人、广播、空房回收。从
  // leaveRoom 里拆出来是因为 detach 也要走这一份 —— seatOf 只指向这条连接的
  // **最后一间**，只按它清理的话，任何一处历史漏清留下的孤儿座位都永远无人认领。
  _dropSeat(room, seat, ws) {
    room.seats.delete(seat.sid);
    this.seatOf.delete(seat.sid);
    if (ws && ws.__sid === seat.sid) ws.__sid = null;
    this.stat.leaves++;
    if (!room.seats.size) { this.rooms.delete(room.id); this.pushLobby(); return; }
    this._handover(room);
    this._sys(room, seat.name + ' 离开了');
    // 补人开着：人走了就把位置补回来（不然房主回来一看是 15/16，还得手动加一个）。
    this._fillBots(room);
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
    // 连杀选单搭同一句车（同一条理由）：从"编辑装备"回房间屏时重发的这一句把它一起刷新。
    // 只存不洗：开局那一刻 room.addClient 的 resolveStreaks 会白名单重建，非法项在那一关被换掉。
    if (Array.isArray(msg.streaks)) seat.streaks = msg.streaks;
    // 视角设置同样搭这一句车（同一条理由）：玩家在设置里调完灵敏度之后回到房间屏，
    // ready 会重发一次，这一格跟着刷新 —— 不用退出房间再进来。
    if (msg.view && typeof msg.view === 'object') seat.view = msg.view;
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
    // 地图与模式**并出"这一帧改完之后"的组合**再验：两格各自合法、拼在一起非法的
    // 组合（ridges 房里把模式改成 tdm）必须当场拒，而不是悄悄换掉一边 —— 悄悄换的
    // 症状与 modeGate 那条一样：房间里写的东西从此是假的。
    const newMap = MAP_IDS.has(msg.map) ? msg.map : room.mapId;
    const newMode = MODE_IDS.has(msg.mode) ? msg.mode : room.mode;
    const badMap = mapGate(newMap, newMode);
    if (badMap) { this.stat.badMap++; this.send(ws, JSON.stringify({ t: 'err', msg: badMap })); return; }
    if (msg.title != null) room.title = flat(msg.title, 24);
    if (MAP_IDS.has(msg.map)) room.mapId = msg.map;
    if (MODE_IDS.has(msg.mode)) room.mode = msg.mode;
    // 时长那格与目标同一套规矩：档位按**这一帧要落成的模式**验（js/data.js:minutesOptions
    // —— dom 是 15/25/35，别把 tdm 房的 10 分当成 dom 的合法时长收下），不认的退回
    // 该模式的默认。没带这格（老客户端 / 只改别的设置）就保持原值 —— 与地图/模式那两格同一句。
    if (msg.minutes != null) room.minutes = cleanMinutes(msg.minutes, newMode);
    // 胜利目标。没带这格（老客户端 / 只改别的设置）就保持原值 —— 与地图/模式那两格同一句。
    // 档位按**这一帧要落成的模式**验：同帧同时改模式与目标的老客户端也要算对。
    if (msg.scoreLimit != null) room.scoreLimit = cleanScore(msg.scoreLimit, newMode);
    // Bot 难度改一个就**全体一起改**：房间屏上那一格只有一个选择器，而"后来加的 Bot 更凶"
    // 这种半新半旧的状态没有任何界面能表达出来，玩家只会觉得"这几个 Bot 手感不一样"。
    if (BOT_SKILLS.includes(Number(msg.botSkill))) {
      room.botSkill = Number(msg.botSkill);
      for (const b of room.bots.values()) b.skill = room.botSkill;
    }
    // 自动补人：开 = 立刻补满（房主按下去就该看见名单满了，而不是"等下一个人才生效"）；
    // 关 = 场上的 Bot 留着不动，只是不再补 —— "关掉"被理解成"把补出来的全删了"的话，
    // 房主手动摆的那几个也会跟着消失。
    if (msg.fill != null) {
      room.fill = msg.fill === true || msg.fill === 1 || msg.fill === '1';
      const n = this._fillBots(room);
      if (room.fill) this._sys(room, n ? `自动补人开启（补上 ${n} 个 Bot）` : '自动补人开启');
      else this._sys(room, '自动补人关闭');
    }
    this.touch(room);
    this.pushRoom(room); this.pushLobby();
  }

  // ── 房主往房间里加 / 减 Bot ──
  // 判据和别的房主操作同源：**只有房主能改**，改完立刻广播（房间屏与大厅列表一起推 ——
  // 列表上那一格"几个人"要把 Bot 算进去，否则别人看见的是一张与进去之后不符的表）。
  // 名字从 js/data.js 的 BOT_NAMES 里挑一个这一间还没用过的：两个 Bot 同名的话，
  // 击杀播报里"猎鹰 击杀 猎鹰"在玩家看来就是自己人打自己人。
  _botName(room) {
    const used = new Set();
    for (const s of room.seats.values()) used.add(s.name);
    for (const b of room.bots.values()) used.add(b.name);
    for (const n of BOT_NAMES) if (!used.has(n)) return n;
    return 'Bot ' + (room.botSeq + 1);
  }
  _botTeam(room, want) {
    if (this._total(room) >= MAX_SEATS) return null;
    if (want === 'A' || want === 'B') return this._teamCount(room, want) < MAX_PER_TEAM ? want : null;
    const a = this._teamCount(room, 'A'), b = this._teamCount(room, 'B');
    if (a >= MAX_PER_TEAM && b >= MAX_PER_TEAM) return null;
    return a <= b ? 'A' : 'B';
  }
  addBot(ws, msg = {}) {
    const at = this.seat(ws); if (!at) return;
    const { room, seat } = at;
    if (room.stage !== 'waiting') { this.stat.playing++; return; }
    if (seat.sid !== room.hostSid) {
      this.stat.notHost++;
      this.send(ws, JSON.stringify({ t: 'err', msg: '只有房主能添加 Bot' }));
      return;
    }
    // 指定了队但那一队站满：**当场拒绝**，不静默换到另一队。静默换队的症状是
    // 房主连点两下"A 队 +"，结果人全跑到 B 队去了，而他以为自己一直在加 A 队。
    const team = this._botTeam(room, msg.team);
    if (!team) {
      this.stat.botFull++;
      // 补人开着的时候"满了"是**设计**，不是意外 —— 不解释一句的话，房主会以为按钮坏了
      // （他每点一下都看到"这间房已经满了"，而满正是他自己开的那一档）。
      const tail = room.fill
        ? `这间房已经满了（上限 ${MAX_SEATS} 个位置）—— 自动补人正把它补满，先关掉补人或者减一个 Bot`
        : `这间房已经满了（上限 ${MAX_SEATS} 个位置）`;
      this.send(ws, JSON.stringify({ t: 'err', msg: (msg.team === 'A' || msg.team === 'B') && team === null && this._teamCount(room, msg.team) >= MAX_PER_TEAM
        ? `${msg.team} 队已经站满了（每队 ${MAX_PER_TEAM} 个）`
        : tail }));
      return;
    }
    // 难度：**没带就用房间那一格**。写成 `(msg.skill | 0)` 那种夹取值是错的 ——
    // undefined | 0 正好等于 0（新兵），于是"什么都没选"被当成"选了最简单的那一档"，
    // 而房间里那一格明明写着正规军。这条是被判据抓出来的（I 段第一条 Bot 的 skill 是 0）。
    const skill = BOT_SKILLS.includes(msg.skill) ? msg.skill : (room.botSkill | 0);
    const bot = this._addBot(room, team, skill);
    this.stat.botAdd++;
    this._sys(room, `${seat.name} 加了一个 Bot（${bot.name}）`);
    this.touch(room);
    this.pushRoom(room); this.pushLobby();
  }
  removeBot(ws, msg = {}) {
    const at = this.seat(ws); if (!at) return;
    const { room, seat } = at;
    if (room.stage !== 'waiting') { this.stat.playing++; return; }
    if (seat.sid !== room.hostSid) {
      this.stat.notHost++;
      this.send(ws, JSON.stringify({ t: 'err', msg: '只有房主能移除 Bot' }));
      return;
    }
    // 没带 bid 就移除最后加的那个：房主点"减一个"时他脑子里是"刚加的那个走"。
    // 反过来（移除最早那个）会让名单每次都跳到顶上，看不出自己减掉了谁。
    const list = [...room.bots.values()];
    const bot = msg.bid != null ? room.bots.get(msg.bid | 0) : list[list.length - 1];
    if (!bot) return;
    room.bots.delete(bot.bid);
    this.stat.botDel++;
    // 手动减一个 = 房主要自己调这张名单了，于是**顺手关掉补人**。不关的话减掉的那一个
    // 下一帧就被补回来：房主看到的是"点了减，名单纹丝不动"，而他会以为按钮坏了。
    if (room.fill) {
      room.fill = false;
      this._sys(room, '自动补人已关闭（房主手动减了一个 Bot）');
    }
    this._sys(room, `${seat.name} 移除了 Bot（${bot.name}）`);
    this.touch(room);
    this.pushRoom(room); this.pushLobby();
  }

  // 开局的判据。**唯一的真**：按钮置灰和放行开局都问它（见 roomState 里的 canStart）。
  startGate(room, seat) {
    if (!seat) return { ok: false, why: '你不在任何房间里。' };
    if (room.stage !== 'waiting') return { ok: false, why: '这间已经在对局中了。' };
    if (seat.sid !== room.hostSid) return { ok: false, why: '只有房主能开始游戏。' };
    // Bot 算人头：一个人加一个 Bot 就能开 —— 这正是"加 Bot"这一项存在的理由
    // （屋里只有两个人时也能打一场像样的仗）。不算的话，房主加了八个 Bot 还是
    // 被"至少还要再来一个人"挡着，而界面上那八个 Bot 明明就列在下面。
    if (this._total(room) < 2) return { ok: false, why: '至少还要再来一个人或一个 Bot。' };
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
    this._fillBots(room);            // 下一局也照样是满的（有人在这一局里退了的话）
    this.touch(room);
    this.pushRoom(room); this.pushLobby();
  }

  // ── 聊天 ──
  // 两条频道：'lobby'（所有挂在大厅上的连接）与 'room'（同一间的座位）。
  // 速率与长度都在这里判，一条都不交给客户端 —— 客户端那些只是回车键的体验。
  // 公开给 net-server 的对局内聊天用（matchSay）：限流是**按连接**的账，
  // 大厅一条、对局一条各数各的就等于给了刷屏双倍额度 —— 所以两个入口共这一个闸。
  // 重帧的闸（M7）。与 allowSay 同一张 WeakMap，但**两个桶各数各的** ——
  // 合成一个桶的话，一个在大厅聊天的人会顺手把自己的建房额度吃掉（反之亦然），
  // 而那两条限额挡的根本不是同一件事。
  // minGated = 这一帧是不是"房间生命周期"那一档（调用方按 HEAVY_MIN_FRAMES 判）。
  // 只有它会推 r.hLast：配置帧若也推，房主连点"+ Bot"就会把自己后面那句 leaveRoom
  // 一起挡掉 —— 两档各记各的账，混用一个时间戳等于让一档吃掉另一档的额度。
  // 默认 true 是**故意**的：漏传参数的那一档落回更严的那边，而不是落回不设防。
  allowHeavy(ws, now, minGated = true) {
    let r = this.rate.get(ws);
    if (!r) { r = { last: 0, burst: [], hLast: 0, hBurst: [] }; this.rate.set(ws, r); }
    if (!r.hBurst) { r.hLast = 0; r.hBurst = []; }
    if (minGated && now - r.hLast < HEAVY_MIN_MS) return false;
    r.hBurst = r.hBurst.filter(t => now - t < HEAVY_BURST_MS);
    if (r.hBurst.length >= HEAVY_BURST) return false;
    r.hBurst.push(now);
    if (minGated) r.hLast = now;
    return true;
  }

  allowSay(ws, now) {
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
    if (!this.allowSay(ws, now)) {
      this.stat.sayRate++;
      // 被限流要当场说一声。不响的话玩家只会以为自己打的字没保存，于是一条"防线"
      // 在人的经验里就变成了"这游戏连聊天都做不好"。
      this.send(ws, JSON.stringify({ t: 'err', msg: '说得太快了，歇半秒再说' }));
      return;
    }
    // 三个频道：lobby（全服）、room（这间房的全体）、team（这间房里自己的队）。
    // team 与 room 同样只认座位 —— 没进房就没有"队"可言（差距 45 的"无队伍频道"）。
    const ch = msg.ch === 'room' ? 'room' : msg.ch === 'team' ? 'team' : 'lobby';
    const at = this.seat(ws);
    if ((ch === 'room' || ch === 'team') && (!at || !at.room)) { this.stat.sayNoRoom++; return; }
    this.stat.say++;
    // 名字取**座位上那份**（座位上的名字来自会话或访客白名单），不是这一帧带来的：
    // 聊天是最容易被拿来冒充别人的地方，而"服务端不用客户端给的身份"这一条
    // 在 join 那里已经立过一次（见 net-server:joinName），这里不能开个反例。
    const from = ch === 'lobby' ? (ws.__name || flat(msg.name, 16) || '路人') : at.seat.name;
    // sid 与 team 是"哪一行是谁说的、该给谁看"的判据：客户端拿 sid 认自己那行
    // （访客服上两个"游客"同名时，按名字认会把别人的行标成我的），拿 team 上色。
    const row = ch === 'lobby'
      ? { ch, from, name: from, text, at: now }
      : { ch, from, name: from, text, at: now, sid: at.seat.sid, team: at.seat.team };
    if (ch === 'room' || ch === 'team') {
      const room = at.room;
      room.chat.push(row);
      if (room.chat.length > ROOM_CHAT_HIST) room.chat.splice(0, room.chat.length - ROOM_CHAT_HIST);
      const m = JSON.stringify({ t: 'chat', ...row });
      // team 频道只发同队的座位。判据是**座位上那份 team**（服务端自己发下去的），
      // 不是这一帧报上来的 —— 队友名单是可以被谎报的那种东西。
      for (const s of room.seats.values()) {
        if (!s.ws) continue;
        if (ch === 'team' && s.team !== at.seat.team) continue;
        this.send(s.ws, m);
      }
      this.touch(room);
    } else {
      this.chat.push(row);
      if (this.chat.length > LOBBY_CHAT_HIST) this.chat.splice(0, this.chat.length - LOBBY_CHAT_HIST);
      this.saveChat(this.chat);                     // 落盘（重启后 hist 要接得上，差距 45）
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
      maxSeats: MAX_SEATS, sayMinMs: SAY_MIN_MS, sayBurst: SAY_BURST,
      // 额度本身要可读（运维得看得见自己在跑什么档）。最小间隔那一档要**点名**是哪几条帧：
      // 只报数字的话，"配置帧到底受不受这条约束"在 /healthz 上根本分不出来。
      heavyMinMs: HEAVY_MIN_MS, heavyBurst: HEAVY_BURST, heavyMinFrames: [...HEAVY_MIN_FRAMES] };
  }
}



