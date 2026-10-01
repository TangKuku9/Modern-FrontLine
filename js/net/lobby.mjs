// 联机大厅与房间的客户端那一半：一条 WebSocket 从"看列表"一路走到"打这一局"。
//
// ── 为什么不刷新页面 ──
// 旧版进对局靠 `location.href = '?online=1&room=…'` 换页。做成"房间"之后这条路就不通了：
// 房间里的名单、谁准备了、聊过什么，全在这条连接身上，换一次页就把它们全扔了。
// 所以这里改成：这条连接一路用到底 —— 大厅 → 房间 → （房主按下开始）对局 → 回房间。
// 服务端也在同一条连接上切换身份（见 net-server 的 beginLive / returnRoom）。
//
// ── 帧的分流规则（只有一条）──
// 大厅层的帧（lobby / room / chat / welcome / err / note）**永远归这里处理**；
// 对局层的（二进制快照 / ev / pong）在开局之后转交 NetClient。
// 反过来定（"开局之后一切都交给对局层"）会漏掉局末那一条 room —— 而那是
// "打完回到房间"唯一的触发点，漏掉的症状是玩家站在一个静止的世界里出不去。
//
// ── 这里不判任何规则 ──
// 谁能开局、准备够不够、聊天能不能发，判据全在服务端（server/lobby.mjs）。
// 这一层只把服务端报回来的 canStart/why 画出来 —— 客户端自己再算一遍的话，
// 就会出现"按钮能点但服务端说不能开"，而那是这一轮要消灭的那类静默失效。
import { decodeSnapshot } from '../../server/codec.mjs';
import { tabNonce } from '../account.js';

const TIMEOUT_MS = 12000;

export class LobbyClient {
  constructor(game, opts = {}) {
    this.game = game;
    // 同 NetClient：本台默认连接带 ?tab=（握手带不了自定义头）；跨台的 url 由调用方给，
    // 身份由那张票钉死，不需要也不该再带本台的选择器。
    const tab = tabNonce();
    this.url = opts.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${tab ? '?tab=' + encodeURIComponent(tab) : ''}`;
    this.name = opts.name || '士兵';
    this.onRooms = opts.onRooms || (() => {});       // 列表 / 在线人数变了
    this.onRoom = opts.onRoom || (() => {});         // 房间状态变了（含局末回房）
    this.onChat = opts.onChat || (() => {});
    this.onError = opts.onError || (() => {});
    this.onBegin = opts.onBegin || (() => {});       // (welcome) => 起这一局
    this.onNote = opts.onNote || (() => {});
    this.connected = false;
    this.rooms = [];
    this.online = 0;
    this.chat = [];                                   // 全服频道（服务端给的最近几句）
    this.state = null;                                // 当前所在那一间的完整状态
    this.match = null;                                // 开局之后非空：对局层的帧转给它
    this._closing = false;
  }

  // 连上并且拿到第一份清单才算数。握手期被拒（没登录、来源不对、端口没开）
  // 当场 reject —— 让调用方能在加载页上说明原因，而不是停在一个空列表前。
  connect() {
    return new Promise((res, rej) => {
      if (this.ws && this.ws.readyState <= 1) { res(this); return; }
      const ws = this.ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      let done = false;
      const finish = (err) => { if (done) return; done = true; clearTimeout(timer); err ? rej(err) : res(this); };
      const timer = setTimeout(() => finish(new Error('连不上对局服务 ' + this.url)), TIMEOUT_MS);
      ws.onopen = () => { try { ws.send(JSON.stringify({ t: 'lobby' })); } catch { /* 立刻断了 */ } };
      ws.onerror = () => finish(new Error('连接出错（服务是否在跑、地址对不对）'));
      ws.onclose = (ev) => {
        this.connected = false;
        this.closedInfo = { code: ev && ev.code, reason: (ev && ev.reason) || '', wasClean: !!(ev && ev.wasClean) };
        finish(this._closing ? new Error('已关闭') : new Error('大厅连接被断开' + (ev && ev.reason ? '：' + ev.reason : '')));
      };
      ws.onmessage = (m) => {
        this._onMessage(m);
        if (!done && this._sawLobby) finish(null);
      };
    });
  }

  // 身份那一格：每次进房 / 建房都要带上，服务端拿它决定"这个人叫什么、带哪把枪进对局"。
  // streaks 是配装屏里 5 选 3 的那一份（profile.streaks）：槽位表以服务端解析回显为准，
  // 这里只负责把**选择**交上去。
  _id() {
    const g = this.game;
    return {
      name: this.name,
      loadout: g.buildNetLoadout ? g.buildNetLoadout(g.profile.classes[g.profile.selClass || 0]) : null,
      streaks: Array.isArray(g.profile.streaks) ? [...g.profile.streaks] : null,
    };
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  createRoom(o = {}) { this.send({ t: 'createRoom', ...this._id(), ...o }); }
  joinRoom(room) { this.send({ t: 'joinRoom', ...this._id(), room }); }
  quickRoom(o = {}) { this.send({ t: 'quickRoom', ...this._id(), ...o }); }
  leaveRoom() { this.send({ t: 'leaveRoom' }); }
  // 准备那一格顺手把**当前的配装**一起交出去：从"编辑装备"回房间屏的时候这一句会重发，
  // 于是"改了枪但没把新枪带进对局"那种错位没有机会发生（服务端只在开局那一刻读它）。
  ready(on) { this.send({ t: 'ready', on: !!on, ...this._id() }); }
  setTeam(team) { this.send({ t: 'team', team }); }
  setCfg(o = {}) { this.send({ t: 'roomCfg', ...o }); }
  // 加 / 减 Bot。判据全在服务端（只有房主能改、位置满了就拒）—— 这里连"我是不是房主"
  // 都不判：客户端自己再判一遍的话，界面上的按钮灰不灰和服务端放不放行就成了两个真相。
  addBot(team) { this.send({ t: 'botAdd', team }); }
  removeBot(bid) { this.send({ t: 'botDel', bid }); }
  start() { this.send({ t: 'start' }); }
  say(ch, text) { const t = String(text || '').trim().slice(0, 120); if (t) this.send({ t: 'say', ch, text: t }); }

  close() {
    this._closing = true;
    try { this.ws && this.ws.close(); } catch { /* 已经断了 */ }
    this.connected = false;
  }

  _onMessage(m) {
    if (typeof m.data !== 'string') { if (this.match) this.match.onSnapshot(decodeSnapshot(m.data), performance.now() / 1000); return; }
    let j; try { j = JSON.parse(m.data); } catch { return; }
    if (this.match && (j.t === 'ev' || j.t === 'pong')) { this.match.onControl(j); return; }
    if (j.t === 'lobby') {
      this._sawLobby = true;
      // '连上了'按**清单真到手**才算，不按 socket 打开算：界面拿这一格决定
      // 是画'正在进入大厅…'还是画一张空表 —— 后者会把'还没连上'说成'没有房间'。
      this.connected = true;
      this.rooms = j.rooms || []; this.online = j.online | 0;
      this.onRooms();
    } else if (j.t === 'room') {
      this.state = j;
      this.onRoom(j);
    } else if (j.t === 'chat') {
      if (Array.isArray(j.hist)) { if (j.ch === 'lobby') this.chat = j.hist.slice(); }
      else {
        if (j.ch === 'lobby') { this.chat.push(j); if (this.chat.length > 60) this.chat.shift(); }
        // 只有**房间频道**进房间历史。match/team（对局里的话）与 sys（举报回执）不进 ——
        // 混进来的症状是"打完回到房间，聊天框里翻出上一局对战中的闲聊"，而且删不掉。
        else if (j.ch === 'room' && this.state && this.state.chat) { this.state.chat.push(j); if (this.state.chat.length > 60) this.state.chat.shift(); }
      }
      this.onChat(j);
    } else if (j.t === 'welcome') {
      // 开局：同一条连接交给对局层。这里不 await —— 加载地图那几秒里
      // 界面还停在房间屏，由 main.js 自己决定什么时候把它换掉（见 beginNetMatch）。
      this.onBegin(j, this);
    } else if (j.t === 'err') {
      this.onError(j.msg || '服务端拒了这个请求');
    } else if (j.t === 'note') {
      this.onNote(j.msg || '');
    }
  }
}
