// 联机客户端：连接权威服务、按 tick 上行输入、收快照、把自己摆回权威轨道。
//
// 本机玩家不是"等服务器发位置"——那会有 RTT 的黏手延迟。本机玩家照常跑
// js/player.js + js/weapon-state.js 的完整模拟（预测），收到快照后做**回滚重放**：
// 把状态恢复到快照那一 tick，再把那之后已经产生的输入逐个重跑一遍。
// 之所以重放得起，是因为 P0 那几件事：固定步长、玩法随机流可播种、
// 权威侧不碰渲染。重放时把世界侧副作用（命中、特效、噪声）关掉，只重跑自身状态。
import * as THREE from 'three';
import { NetPlayer, INTERP_DELAY } from './remote.mjs';import { decodeSnapshot, encodeInput, INPUT_SIZE } from '../../server/codec.mjs';
import { packInput, teamId, weaponId, FLAG, WORLD, uavBit } from '../quant.js';
import { uavFromFlags } from '../match-rules.js';
import { rollback } from './predict.mjs';
import { clamp } from '../util.js';
import { Sentry, Heli } from '../mp.js';

const HISTORY = 240;                                 // 回滚窗口，4 秒
// 日记本里存得下、且和快照同一时刻可比的那几位旗标（见下面 jFlags 的注释）。
const FLAG_BASE_MASK = FLAG.Alive | FLAG.Crouch | FLAG.Sprint | FLAG.OnGround | FLAG.Sliding;
export class NetClient {
  constructor(game, opts = {}) {
    this.game = game;
    this.url = opts.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.name = opts.name || '士兵';
    this.team = opts.team === 'B' ? 'B' : 'A';
    this.loadout = opts.loadout || null;
    this.cid = null;
    this.connected = false;
    this.remotes = new Map();
    this.roster = new Map();        // cid -> {name, team}，只用来贴名牌和分敌我
    this.pending = [];                                // 攒一渲染帧一起发的输入包
    this.localTick = 0;
    this.history = [];                                // {tick, inp}
    this.snaps = 0; this.snapGap = 0; this.rtt = 0; this.serverTick = 0;
    // 快照的（到达时刻 → 服务端拍号）流水。它不是给插值用的（插值在 remote.mjs 里各人一份），
    // 只为了回答一个问题：**我这一帧渲染的是服务端的哪一拍**。延迟补偿要用它（见 renderTick）。
    this.snapLog = [];
    this.viewTick = 0;
    this.events = [];                                 // 交给上层做 HUD/音效
    this.type = 'online'; this.ffa = false;
    this.scores = { A: 0, B: 0 };
    this.timeLeft = 600;
    this.cfg = { map: 'yard', mode: 'tdm' };
    this.streakState = [];
    this.over = false;
    // —— 对局规则（连杀奖励 / UAV / 记分板）——
    // 规则的真相全在权威端（server/room.mjs + js/match-rules.js），客户端这边只做两件事：
    //   ① 把"我按了 3/4/5"编进上行输入（streak 那一个字节）；
    //   ② 把服务端下发的规则事件翻译成 HUD/音效/本地实体。
    // 以前这里连槽位表都没有（streakState = []），而 main.js 的 snapshotInput 照样在报
    // 3/4/5 —— 报了也没人收（那一位根本不在协议里）。症状是"按了没反应"，不报错。
    this.streakDefs = [];
    this.streakProgress = 0;
    this.worldFlags = 0;
    this.board = null;                                // 最近一份记分板（每 2 秒一条事件）
    this.turrets = new Map();                         // netId -> 本地表现副本（哨戒机枪 / 直升机）
  }

  connect() {
    return new Promise((res, rej) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      // res/rej/timer 挂在实例上而不是只留在闭包里：进场失败有四个来源，其中"服务端拒绝"
      // 发生在 onControl 里 —— 那是个类方法，看不见 Promise 执行函数的作用域。曾经直接在
      // 里面写 rej()，于是服务端每拒一次进场就抛一次 ReferenceError，而它本该报出的原因
      // （房间满了、正在维护）正好就是主菜单要显示的那句话。
      // 拨号超时给 15 秒，进场应答超时给 8 秒，而且后者从 onopen 起算：实测后台标签页里
      // 光 WebSocket 握手就能吃掉 3 秒多，两个都从 new 起算会把"房间已满"盖成"连接超时"。
      this._join = { res, rej, timer: setTimeout(() => this.settleJoin(new Error('连不上对局服务 ' + this.url)), 15000) };
      ws.onopen = () => {
        this._opened = true;
        const j = this._join;
        if (j) { clearTimeout(j.timer); j.timer = setTimeout(() => this.settleJoin(new Error('连接超时：8 秒没等到进场应答')), 8000); }
        ws.send(JSON.stringify({ t: 'join', room: this.room || 'ffa-1', name: this.name, team: this.team, loadout: this.loadout }));
      };
      ws.onmessage = (m) => {
        if (typeof m.data === 'string') { this.onControl(JSON.parse(m.data)); return; }
        this.onSnapshot(decodeSnapshot(m.data), performance.now() / 1000);
      };
      ws.onerror = (e) => { this.settleJoin(new Error('WebSocket 错误')); };
      // 断开要能被"看见"。以前只是往 events 里塞一条 disconnected，而没人读 events ——
      // 症状是"服务器重启后所有人站在一个静止的世界里"，这是上线后第一条客服工单。
      ws.onclose = (ev) => {
        this.connected = false;
        // 把"哪一种关"留在身上：1006 + opened=false 是握手就没完成（地址错、端口没开、
        // 反代没转发 Upgrade），1006 + opened=true 才是连上之后断的。上线后排障全靠这一句。
        this.closedInfo = { code: ev && ev.code, reason: (ev && ev.reason) || '', wasClean: !!(ev && ev.wasClean), opened: !!this._opened };
        if (this._closing) return;      // 我们自己拆的：原因已经在 reject 里说过了，别再报一次"断开"
        // 握手期就被关掉（来源检查 403、进程已死）：不结算的话 connect() 要空等到超时，
        // 玩家对着"正在连接"的转圈多等一整轮。welcome 之后这里是正常下场/断线，不该 reject。
        if (!this.welcome) this.settleJoin(new Error(
          !this._opened ? '没能连上对局服务（握手未完成）'
            : (ev && ev.wasClean) ? '连接被服务器关闭' : '连接中断（服务器或中间的网关把这条连接拆了）'));
        this.markLost(ev && ev.code === 1001 ? 'lost' : 'closed', (ev && ev.reason) || this.serverNote || '');
      };
      this.connected = true;
    });
  }

  // 进场握手的一次性结算：拨号超时 / 应答超时 / WebSocket 错误 / 服务端拒绝 / welcome，
  // 谁先到算谁，第二次调用是无操作（"还挂着吗"这件事本身就是 onControl 的分支判据）。
  settleJoin(err, payload) {
    const j = this._join; if (!j) return;
    clearTimeout(j.timer); this._join = null;
    if (!err) return j.res(payload);
    // 失败就把 socket 拆掉。不拆的话迟到的 welcome 会造出一个僵尸局：主菜单已经退回去了、
    // 地图从没加载，而 onmessage 还在按拍喂快照 —— 界面上写着"连接失败"，逻辑却在打对局。
    this._closing = true;
    try { this.ws.close(1000, 'join failed'); } catch (e) { /* 已经关了 */ }
    j.rej(err);
  }

  // 控制帧单独成方法：既让 onmessage 收起来，也让 test/net-drop.mjs 能直接喂一条
  // 假的服务端消息进来验收 UI（服务器优雅下线在那台机器上测不了，见 README）。
  onControl(j) {
    if (j.t === 'welcome') {
      this.cid = j.cid; this.serverTick = j.tick; this.mapId = j.map;
      this.welcome = j;
      // 连杀奖励的槽位表由服务端给：**按 3/4/5 各是什么、每个要几杀**，这两件事的真相
      // 在权威端（js/match-rules.js 的账本里）。客户端自己按 data.js 那份渲染的话，
      // 服务端换一项、客户端还显示旧的 —— 症状是"按了没反应"，正是这一轮要消灭的东西。
      // 成本里含"强硬路线"的减 1：净化后的 loadout 在 j.loadout 里（服务端重建的那一份，
      // 客户端按它配枪，所以也按它算成本）。
      const disc = (((j.loadout || {}).perks) || []).includes('hardline') ? 1 : 0;
      this.streakDefs = Array.isArray(j.streaks) ? j.streaks : [];
      this.streakState = this.streakDefs.map(d => ({ id: d.id, ready: false, used: false, cost: Math.max(2, d.kills - disc) }));
      // 名字不在二进制快照里（变长字段会毁掉定长包），靠 welcome + join 事件带
      for (const o of j.others || []) this.roster.set(o.id, { name: o.name, team: o.team });
      this.snapGap = 0;         // 看门狗的基线：从进场这一刻开始数"多久没收到快照"
      this.settleJoin(null, j);
    } else if (j.t === 'ev') {
      this.onEvents(j);
    } else if (j.t === 'err') {
      // 进场被拒（房间满、正在维护）只让 connect() 失败，不标 lost：这时玩家还没进过世界，
      // 该由 startOnline 的 catch 在加载页上说明原因，而不是往对局 HUD 上刷一条横幅。
      // 已经进场之后收到的 err 只是这一条连接的事，更不该把一局打停。
      if (!this.welcome) this.settleJoin(new Error('服务端：' + j.msg));
      else this.events.push({ e: 'serverError', msg: j.msg });
    } else if (j.t === 'pong') {
      this.rtt = performance.now() - j.c;
    } else if (j.t === 'note') {
      // 服务端优雅下线时给的那句话 —— 比"连接断了"有用得多，玩家知道是维护不是自己网卡
      this.serverNote = String(j.msg || '');
      this.events.push({ e: 'note', msg: this.serverNote });
      this.game.onNetNote && this.game.onNetNote(this.serverNote);
    }
  }

  markLost(kind, reason) {
    if (this.lost) return;
    this.lost = kind; this.lostReason = reason || ''; this.lostAt = performance.now() / 1000;
    this.events.push({ e: 'disconnected', kind, reason });
  }

  sendPing() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); }

  // 我这一帧渲染的是服务端的哪一拍 —— 这正是延迟补偿要的量。
  //
  // 它是"渲染时刻往回退 INTERP_DELAY 之后落在哪两包之间"插出来的。之所以让客户端报这个
  // 拍号而不是让服务端按 ping 估，是因为"我比服务端晚多少"里有 INTERP_DELAY（本文件的常数）
  // 和本机帧率两部分，写在服务端就成了两份会各自漂移的真相；而拍号是客户端手上现成的，
  // 且服务端能用"我确实发过这一拍"把它卡死（server/lagcomp.mjs:rewindTick）。
  //
  // 落在最新一包之后（本机卡了一帧）就报最新那一拍：服务端会当成"你看的就是当下"，不回溯。
  // 那是对的 —— 那种时刻客户端屏幕上就是最后一包的状态外推出来的，没有更旧的真相可用。
  renderTick(now = performance.now() / 1000) {
    const b = this.snapLog;
    if (!b.length) return 0;
    const last = b[b.length - 1];
    const target = now - INTERP_DELAY;
    if (target >= last.t) return last.tick;
    if (target <= b[0].t) return b[0].tick;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > target) i--;
    const a = b[i - 1], z = b[i];
    const k = clamp((target - a.t) / Math.max(1e-4, z.t - a.t), 0, 1);
    return a.tick + (z.tick - a.tick) * k;
  }

  // 每个模拟 tick 调一次：记历史 + 排队上行
  recordInput(tick, inp) {
    this.localTick = tick;
    const t16 = tick & 0xffff;
    // 报给服务端的"我看到哪一拍"。时钟口径是**服务端拍号**，不是本机 tick —— 两者差着一个
    // 任意的起点偏移，把它混进延迟补偿会让回溯量整体偏掉一个常数（而那个常数随每个人
    // 进场时刻不同），症状是"有的人打得中、有的人永远差半步"。
    this.viewTick = Math.round(this.renderTick()) & 0xffff;
    // 恒等式：一拍一份输入。同一拍记两次 ⇒ 回滚时多演一步，而服务端把第二份当重复包丢掉
    // （server/room.mjs 的 d===0 判据），于是权威端永远比我的重建"少走一拍" —— 这类错
    // 不会崩，只会在偏差表上伪装成网络抖，所以要计数而不是靠人去看。
    const tail = this.history[this.history.length - 1];
    if (tail && tail.tick === t16) this.dupTicks = (this.dupTicks || 0) + 1;
    // debt = 写这一条时"服务端已经多算而我这边永远补不回来"的拍数。
    // 为什么要挂在日记本上：某一段重复在"又来了一份真输入"那一刻从末尾计数上消失，
    // 而这一拍之后、下一次拽回之前写下的日记本条目**不含**那几拍 —— 它的基态天生就是旧的。
    // 有了这个戳，后面每一次"错拍"都能判定成"基态写早了"，而不是靠窗口大小猜。
    this.history.push({ tick: t16, inp, j: this.game.player ? this.game.player.journal() : null, debt: this.repForgotten | 0 });
    if (this.history.length > HISTORY) this.history.shift();
    const packed = packInput(inp);
    // streak = "这一拍我按了 3/4/5 里的哪一个"（没按是 -1，编码后 0xff）。
    // 它必须是**按下沿**：Digit3 只进 main.js 的 pressed 表，只在一拍为真，所以上行的
    // 每一条里最多有一条带请求 —— 服务端不需要自己再做边沿检测。不在这里过滤
    // "我这边觉得就绪了吗"：唯一的裁决者是服务端，客户端自己拦会把
    // /healthz 的 streak.rejected 读数搞脏（那个数存在的意义正是"客户端与服务端的账对不上"）。
    this.pending.push({ tick: t16, mdx: inp.mdx, mdy: inp.mdy, keys: packed.keys, buttons: packed.buttons, view: this.viewTick, seq: t16 & 0xff, streak: inp.streak });
  }
  flush() {
    if (!this.ws || this.ws.readyState !== 1 || !this.pending.length) return;
    const v = new DataView(new ArrayBuffer(this.pending.length * INPUT_SIZE));
    for (let i = 0; i < this.pending.length; i++) {
      const b = encodeInput(this.pending[i]);
      new Uint8Array(v.buffer).set(new Uint8Array(b.buffer), i * INPUT_SIZE);
    }
    this.ws.send(v.buffer);
    this.pending.length = 0;
  }

  onSnapshot(snap, now) {
    this.snaps++; this.snapGap = 0; this.serverTick = snap.tick;
    // 到达时刻是渲染时刻的坐标原点（remote.mjs 的插值也用它），所以流水在这里记。
    this.snapLog.push({ t: now, tick: snap.tick });
    if (this.snapLog.length > 24) this.snapLog.shift();
    this.lastSnap = snap;                               // 测试与 netdebug 要看原始下行
    this.lastRngState = snap.rngState >>> 0;
    // 世界标志位：UAV（按队两位）、白磷弹、对局结束。**一个字节**，不按接收者过滤，
    // 所以"哪一队有 UAV"要用两位分开表达（js/quant.js:WORLD 的注释）。
    // 小地图读的就是它（hud.drawMinimap → mode.uavActive → 这里）。
    this.worldFlags = snap.worldFlags | 0;
    const seen = new Set();
    for (const e of snap.entities) {
      seen.add(e.id);
      if (e.id === this.cid) { this.reconcile(e, snap.tick, now); continue; }
      let r = this.remotes.get(e.id);
      if (!r) {
        const who = this.roster.get(e.id) || {};
        r = new NetPlayer(this.game, {
          id: e.id, name: who.name || ('玩家 ' + e.id),
          team: teamId(e.team) || (this.team === 'A' ? 'B' : 'A'),
          weapon: e.weapon,
          // 起点用这一包的坐标：留 (0,0,0) 会让第一帧把别人摆在地图原点。
          // （插值本身没跑起来时，那个原点读数会一直挂着 —— 见 test/net-play.mjs 的 rendered 差值）
          x: e.x, y: e.y, z: e.z, yaw: e.yaw,
        });
        this.remotes.set(e.id, r);
        this.game.entities.push(r);
        this.game.remotePlayers = [...this.remotes.values()];
      }
      if (r.weaponId === undefined) r.weaponId = 'm4';
      r.push(e, now);
    }
    for (const [id, r] of this.remotes) {
      if (!seen.has(id)) {
        r.dispose(); this.remotes.delete(id);
        const i = this.game.entities.indexOf(r);
        if (i >= 0) this.game.entities.splice(i, 1);
        this.game.remotePlayers = [...this.remotes.values()];
      }
    }
  }

  // 回滚重放本体在 js/net/predict.mjs（那边同时被 test/rollback.mjs 逐位断言）。
  // 这里只负责"从历史里切出该重演的那段"。
  reconcile(e, snapTick, now) {
    const pl = this.game.player;
    if (!pl) return;
    this.mySnapshot = e;
    // 权威侧见过的最低血。瞬时 hp 会被"打死又重生"洗回 100，用它当判据等于把
    // 一次真实的命中读成没发生 —— 跨窗口命中那条断言第一版就是这么假红的。
    if (this.hpMin === undefined || e.hp < this.hpMin) this.hpMin = e.hp;
    // 权威侧认为我手里是哪把枪：和本地对不上就说明装备没交出去（服务端只能按默认发枪）
    this.srvWeapon = weaponId(e.weapon);
    // ack = 服务端"已经消费完"的那一拍，快照对应的是它的下一拍起点 ⇒ 本地起点是 ack+1
    const start = ((e.ack >>> 0) + 1) & 0xffff;
    const ahead = (t) => ((t - start) & 0xffff);
    const win = this.history.filter(h => h.j && ahead(h.tick) < 2000);
    // 这两条**必须**在调 rollback 之前算出来：它是"这一窗服务端到底跑了什么"的全部信息 ——
    // 服务端从上一包到这包推进了 dTick 步，其中 dAck 步消费了我的输入，剩下的 deficit 步
    // 是拿手里那份空跑（见 server/room.mjs:step）。随包的 rep 只报末尾连拍，落在首次消费
    // 之前的那几拍它报不出来 ⇒ 客户端得靠这三个量自己补（机制与实测见 js/net/predict.mjs
    // opts.carry 那一段）。放在这里算而不是下面记账的位置，就是因为 rollback 要用。
    const dTick = this.lastSnapTick === undefined ? 0 : ((this.serverTick - this.lastSnapTick) >>> 0);
    const dAck = this.lastStart === undefined ? 1 : ((start - this.lastStart) & 0xffff);
    // 缺口（空跑拍数）与"落在首次消费之前的那几拍"。上一包随快照下来的 rep（this.lastRep）
    // 就是进这一窗之前已经欠下的空跑数，而本窗的 lead 部分 = 本窗总空跑 − 末尾连拍。
    // 两个方向都夹住：deficit 为负说明 ack 跑得比拍号快（服务端跳过我的输入），
    // lead 为负说明 rep 比"总空跑 + 上一包欠下的"还大 —— 两种都只可能是拍号接错线。
    const deficit = Math.max(0, dTick - dAck);
    const lead = Math.max(0, (this.lastRep | 0) + deficit - (e.rep | 0));
    // 基态那一格：start 往前 dAck 拍（= 上一包的 ack+1）。dAck 为 0 时它是 start 本身，
    // 也就是旧通路用的那一格，两条路在这里自然重合。
    // 死亡边沿：服务端把我定成死了，而我还按"活着"预测着往前走了几拍。
    // 这和重生是同一类事 —— 一次我这边不可能预测到的状态机跳转，所以同样按"整体重置"
    // 处理：退掉日记本、直接吃权威读数。以前只把重生当重置，死亡那几包就被留在
    // 预测统计里，稳态最大偏差在 0.07~0.67 m 之间来回跳（同一份代码两种读数 = 判据在
    // 量一件没定下来的事，而不是量预测器）。
    const nowAlive = !!(e.flags & FLAG.Alive);
    if (this.lastMyAlive === true && !nowAlive) this.hardSnap = true;
    this.lastMyAlive = nowAlive;
    // 服务端在我供不上输入的那几拍是"按住上一份不放"继续算的，rep 就是这几拍的个数。
    // 补演用的必须是它手里那一份（=我发到 ack 这一拍的输入），不是我的最新一份 ——
    // 后者可能已经不一样了，拿它补就是在猜。找不到（被历史窗口挤掉）时只能不补，
    // 那次校正会被记成偏差而不是被抹平。
    const holdE = this.history.find(h => h.tick === (e.ack & 0xffff));
    // 基态往前那一段的料：journal[start-dAck]、那 dAck 条真输入、以及它们前面那一份
    // （首段空跑用的就是它）。任何一件凑不齐就把**成因**交回去 —— 上层会把它记成一次命名
    // 的未补偿并印出来，而不是悄悄按旧通路走完（旧通路少算的那几拍会原样变成一次校正
    // 位移，在报表上和"预测错了"完全同形）。
    // 注意 j: je.j —— je 是 history 里那条记录（{tick, inp, j, debt}），日记本是它的 .j。
    // 交错了不会报错，只会在 applyJournal 里读 undefined[0] 炸掉整个 reconcile。
    const carryOf = () => {
      if (this.hardSnap) return 'hard';              // 整体重置：日记本本来就要重建
      if (dAck < 1) return 'noAck';                  // 纯饥饿窗：ack 不动，dTick 步全是末尾连拍，rep 就是全部
      if (dAck > 8) return 'tickJump';               // 我的拍号跳了（客户端跑得比服务端快），两边的"第 k 拍"对不上
      const b = (start - dAck) & 0xffff;
      const je = this.history.find(h => h.tick === b && h.j);
      if (!je) return 'basePruned';
      const inp = [];
      for (let i = 0; i < dAck; i++) {
        const en = this.history.find(h => h.tick === ((b + i) & 0xffff));
        if (!en) return 'inputPruned';
        inp.push(en.inp);
      }
      const pe = lead > 0 ? this.history.find(h => h.tick === ((b - 1) & 0xffff)) : null;
      if (lead > 0 && !pe) return 'prevPruned';
      return { j: je.j, inp, prevInp: pe ? pe.inp : null, lead, n: dAck };
    };
    // 该不该用 carry：只在"这一窗真有消费"时才谈得上 —— dAck=0 的纯饥饿窗整段都是末尾连拍，
    // 那条旧通路本来就对，进这条路反而多一处可能接错线。dAck≥1 时只要服务端跑了空跑
    // （本窗空跑 deficit>0，或上一包还欠着 lastRep 拍）就必须走它。
    const needCarry = dAck >= 1 && (deficit > 0 || (this.lastRep | 0) > 0);
    const got = needCarry ? carryOf() : null;
    const carry = got && typeof got === 'object' ? got : null;
    // 该补而没补上的，一律留下**名字**。这一条以前没有：旧写法在同样的窗里照样把
    // corrected 记成一个数，于是"少补了几拍"与"预测器算错了"在报表上完全同形 ——
    // 那一族 0.15~0.44 m 的假偏差就是这么被误判成物理分叉的。
    if (needCarry && !carry) {
      this.carryMiss = (this.carryMiss || 0) + 1;
      this.carryWhy = this.carryWhy || [];
      if (this.carryWhy.length < 12) this.carryWhy.push({ why: got, dAck, dTick, deficit, lead, rep: e.rep | 0, lastRep: this.lastRep | 0, have: this.history.length });
    }
    const r = rollback(this.game, pl, win, start, e, this.lastRngState,
      { hard: !!this.hardSnap, rep: e.rep | 0, hold: holdE && holdE.inp, carry, lead });
    if (carry) { this.carryN = (this.carryN || 0) + 1; this.carryLead = (this.carryLead || 0) + r.led; }
    this.hardSnap = false;
    this.reconciles = (this.reconciles || 0) + 1;
    // rep 通路读数 + 它的一个已知缺口。
    // rep 计的是"末尾连着几拍没新输入"，所以上一段重复一旦被一份真输入接走，这一包就
    // 再也报不出那几拍（客户端每次的基态是从自己日记本重建的，日记本里没有重复拍）。
    // 缺口大小 = 上一包报过的末尾连续数。实测这一口不小：一把 12 秒的窗口里累计
    // 漏计 209 拍（一次页面卡住就是几十拍，卡完接上真输入 ⇒ 末尾计数归零）。
    // 为什么不改成累计计数：卡住那几十拍的位移其实**留在**了之后的日记本里 —— 饥饿期间
    // 每一包都把人拽到权威位，等客户端恢复产拍时写下的 journal[k] 已经是拽回之后的状态。
    // 所以真正没进日记本的只有"上一次拽回之后新产生的那几拍"，而那正是末尾计数报的东西。
    // 改成累计反而会把几百拍旧输入叠在新输入后面。
    // 但实测有一次"权威端比我基态多走 ~16 拍"的样本（Δpos 1.19 m、Δack1<Δtick3），
    // 单靠末尾归零解释不完 —— 已把每包的 rep/实际补演数记进 steadyWorst 现场。
    // 两种候选都归到 P1-b（输入总线）：补演被 120 拍上限截断，或 acked 那份输入已被
    // 历史窗口挤掉（hold 取不到，见 repSkipped）。
    this.repN = (this.repN || 0) + ((e.rep | 0) > 0 ? 1 : 0);
    this.repMax = Math.max(this.repMax || 0, e.rep | 0);
    this.repsApplied = (this.repsApplied || 0) + r.reps;
    if (!(e.rep | 0) && this.lastRep) this.repForgotten = (this.repForgotten || 0) + this.lastRep;
    this.lastRep = e.rep | 0;
    this.replayed = r.replayed;
    this.corrected = r.corrected;
    this.correctedMax = Math.max(this.correctedMax || 0, r.corrected);
    this.recIdx = (this.recIdx || 0) + 1;
    // 输入饥饿的**准确**签名：服务端从上一包到这包跑了 dTick 拍，而我的 ack 只前进 dAck 拍。
    // 差的那些拍是它拿我上一份输入替我空跑的 —— 每空跑一拍，它的位置就比我那个基态多走一步
    // （实测 0.0770 m = 4.46 m/s ÷ 60），和"预测错了"在报表上完全同形。
    // 只看"ack 动不动"抓不到它：三格里消费两拍、空跑一拍，ack 照样在动 —— 第一版就这么漏过。
    // 这条**不再是**"只能记下来排除"的读数了：dTick/dAck 上面已经算过，deficit 与 lead 都
    // 交给 predict 去重演（这一窗服务端真跑过的 dTick 步一步不落），所以它现在的角色是
    // **形状判据** —— 稳态里残留的偏差是否还等于 deficit 拍的位移，直接看这里的计数与
    // net-play 的"单窗缺口 ≤ 一份快照"那条。
    const prevStart = this.lastStart;                  // 覆盖前先留一份，探针要用
    this.lastSnapTick = this.serverTick >>> 0;
    this.lastStart = start;
    const starved = dTick > dAck;
    if (starved) this.starved = (this.starved || 0) + 1;
    // 另一头的同一枚硬币：ack 前进的拍数**超过**服务端推进的拍数 ⇒ 它跳过了我发出去的
    // 某一拍（服务端队列满了丢最新，server/room.mjs:INPUT_QUEUE）。这条判据是恒等式而不是
    // 经验值：一次消费一步，正常情况下 dAck 只可能 ≤ dTick。
    // 被跳过的拍让我这边的基态比权威端"多走一步"，所以错拍样本里那些 offset 是负的。
    const qDrop = dAck > dTick;
    if (qDrop) this.qDrops = (this.qDrops || 0) + 1;
    if (r.hard) this.grace = 2;                       // 重生之类整体重置之后两包：日记本在重建
    const inGrace = ((this.grace = Math.max(0, (this.grace || 0) - 1)) > 0);
    const hit = win.length > 0 && win[0].tick === start;
    // 这一包处不处在"输入总线出过事"的窗口里：饥饿、跳过、上一包报过重复拍，
    // 或者**基态那条日记本写于一次漏计之前**（debt 戳，机制见 recordInput）。
    const staleDebt = hit && win[0].debt !== undefined && win[0].debt < (this.repForgotten | 0);
    const queueEvent = starved || qDrop || (e.rep | 0) > 0 || !!this.lastRep || staleDebt;
    // 生死翻转那一包也不算预测误差：服务端在我"还活着"的那几拍里已经把我定成死了
    // （位置从那一刻冻住，而我还在按输入往前走），所以 journal 与权威读数是两个不同
    // 状态机分支的读数，差多少拍都补不上 —— 这是"死亡瞬间会不会滑一步"的问题，另立账。
    const aliveFlip = hit && !!(win[0].j.alive) !== !!(e.flags & FLAG.Alive);
    if (aliveFlip) this.aliveFlips = (this.aliveFlips || 0) + 1;
    // 饥饿那一包本来就没有可退的日记本（服务端的 ack 已经跑到我还没发出去的那一拍），
    // 那是同一个现象的另一种表现，不能又算成"回滚窗口不够长"。
    // 同理，重生瞬间还在路上的那几份输入，服务端稍后会拿它们升 ack，而那个拍号的
    // 日记本是我自己清掉的 —— 也是可预期空窗（this.floor 记的就是"我从这一拍起才有新日记本"）。
    if (r.hard) this.rebuilding = true;                 // 整体重置之后：日记本要从这一拍重新攒
    const rebuilding = !!this.rebuilding;
    if (hit) this.rebuilding = false;                   // 第一次能对上拍号，说明窗口已经接上了
    const behind = this.floor === undefined ? 0 : (this.floor - start) & 0xffff;
    const staleBase = behind > 0 && behind < 2000;
    // 服务端的 ack 追平到我**最新**那一拍：base 拍号 = localTick+1，我这边还没开始跑那一拍，
    // 日记本当然没有 —— 这不是"回滚窗口不够长"（窗口再长也变不出没产生的拍），
    // 而是"我供输入供得刚好不够快"的另一个表现。归到饥饿那一类单独立账。
    const caughtUp = !hit && start === ((this.localTick + 1) & 0xffff);
    if (caughtUp) this.caughtUp = (this.caughtUp || 0) + 1;
    if (!hit && !r.hard && !rebuilding && !starved && !staleBase && !caughtUp) {
      this.journalMisses = (this.journalMisses || 0) + 1;
      // 空窗的原因在报表上是同形的，只有把"那一拍的日记本在不在"读出来才分得开：
      //  · pruned   —— 窗口太短（ HISTORY 不够 / 服务端 ack 落后太多）
      //  · nullJ    —— 那一拍记了输入但 journal() 返回 null（本地玩家还没建好）
      //  · noEntry  —— 那一拍压根没进过 history：客户端供不上，或拍号被 history.shift 抢掉
      // 三种的修法完全不同（加窗口 / 补建玩家 / 输入总线），靠猜会修错地方。
      const exact = this.history.find(x => x.tick === start);
      const oldest = win.length ? win[0].tick : null;
      this.missWhy = this.missWhy || [];
      if (this.missWhy.length < 40) this.missWhy.push({
        why: exact ? (exact.j ? 'jButNotOldest' : 'nullJ') : (this.history.length ? (oldest !== null && ((oldest - start) & 0xffff) < 2000 ? 'pruned' : 'noEntry') : 'emptyHist'),
        start, oldest, have: this.history.length, ack: e.ack, snapTick: this.serverTick,
        localTick: this.localTick, floor: this.floor, respawn: this.respawnSnaps || 0,
        gap: oldest === null ? null : ((oldest - start) & 0xffff),
      });
    }
    // 入场前 100 拍（5 秒）也不算：服务端从 addClient 起就在拿全零输入空跑这个人，
    // 而本地第 0 拍才刚开始，两边的"同一拍"根本不是同一件事。
    // 饥饿那一拍**不再自动排除**：rep 补全之后那一拍的重建是完整的，它和别的包一样可比，
    // 以前排除它是因为"那一拍我根本重建不出来"，现在这个理由没了。补不全（rep 对不上、
    // 或那份被补演的输入已经被历史窗口挤掉）才继续排除 —— 排除项跟着机制一起收窄。
    const repOk = (e.rep | 0) === r.reps;
    // 入场那 100 拍之前不算漏：页面还在加载材质，服务端已经拿全零输入空跑了一分多钟
    // 的量（实测 rep 到 160 拍），补演上限 120 必然撞。这一段本来就在稳态判据的
    // 排除窗里，把它记成"补不全"只是把同一个事实数两遍。
    if (!repOk && (e.rep | 0) > 0 && hit && this.recIdx > 100) {
      this.repSkipped = (this.repSkipped || 0) + 1;
      this.repSkipWhy = this.repSkipWhy || [];
      if (this.repSkipWhy.length < 12) this.repSkipWhy.push({
        rep: e.rep | 0, reps: r.reps, ack: e.ack & 0xffff, start, have: this.history.length,
        oldest: this.history.length ? this.history[0].tick : null, newest: this.localTick,
        hold: !!(holdE && holdE.inp), hard: !!r.hard, hit,
      });
    }
    const steady = this.recIdx > 100 && (!starved || repOk) && !r.hard && !inGrace && !aliveFlip && hit;
    if (steady) {
      this.steadyN = (this.steadyN || 0) + 1; this.steadyMax = Math.max(this.steadyMax || 0, r.corrected);
      // 结构性判据，不依赖位置读数：这一窗服务端推进的拍数比它从我这儿消费的输入数多
      // （Δtick > Δack ⇒ 中间有空跑拍），而随包的 rep 字节是 0 ⇒ 权威状态里含着 rep
      // **报不出来**的那几拍（空跑落在首次消费之前）。旧定义把 rep 记成"末尾连拍"，
      // 于是 [空跑,空跑,新输入] 这种窗报 0，残差恰好沿行进方向摊成 2 拍位移 ——
      // 稳态尾部那两个样本就是这个形状。现在这几拍由 carry 重演掉了，所以这条从
      // "已知缺口"变成了**形状判据**：缺口仍然必须是一次性的、不许随快照累积。
      if (!(e.rep | 0) && dTick > dAck) {
        this.repUnder = (this.repUnder || 0) + 1;
        // 缺口最多能有多大：这一窗服务端替我多走、而我这边得自己补的拍数。它必须始终是
        // "一次性"的量（≤ 一份快照 SNAP_EVERY 拍）—— 一旦看到它随快照数往上涨，就说明
        // 折叠拍的记账又变成"每份快照重新欠一遍"那种会永久累积的错（b3e25b6 就犯过这个）。
        const def = dTick - dAck;
        this.repUnderMax = Math.max(this.repUnderMax || 0, def);
        this.repUnderWhy = this.repUnderWhy || [];
        if (this.repUnderWhy.length < 8) this.repUnderWhy.push({ dTick, dAck, deficit: def, lead, carry: !!carry, led: r.led, d: +r.corrected.toFixed(4) });
      }
      // 空跑窗的残差判据 —— 这一轮的**红线**就是它。
      // 补偿没做到位时，残差会**恰好等于 deficit 拍的位移**（0.1539 m = 2 拍 × 4.46/60，
      // 且 Δpos 与相邻两拍差分同向）。所以这里要一个能自己量出来的尺子，而不是"小于某个
      // 米数"：尺子就是我日记本里相邻两拍的距离（我自己走的，和判据无关）。
      // 判据形状：空跑窗的残差必须**小于一拍位移**。补偿漏了则残差 ≥ deficit 拍 ≥ 1 拍。
      if (dTick > dAck || (this.lastRep | 0) > 0) {
        // 相邻两拍的位移：取基态那一格和它后一拍。取不到（窗口太短）就退回速度换算。
        const a = this.history.find(h => h.j && h.tick === start);
        const b2 = this.history.find(h => h.j && h.tick === ((start + 1) & 0xffff));
        const stepMeasured = a && b2 ? Math.hypot(b2.j.pos[0] - a.j.pos[0], b2.j.pos[2] - a.j.pos[2]) : null;
        const step = stepMeasured !== null ? stepMeasured : Math.hypot(pl.vel.x, pl.vel.z) / 60;
        this.foldN = (this.foldN || 0) + 1;
        this.foldMax = Math.max(this.foldMax || 0, r.corrected);
        if (r.corrected > step) {
          this.foldBad = (this.foldBad || 0) + 1;
          this.foldWhy = this.foldWhy || [];
          if (this.foldWhy.length < 8) this.foldWhy.push({ d: +r.corrected.toFixed(4), step: +step.toFixed(4), stepMeasured: stepMeasured !== null, deficit, lead, dTick, dAck, rep: e.rep | 0, carry: carry ? 'yes' : got, led: r.led, have: this.history.length });
        }
      }
      // 厘米级读数已经稳定在 0.08 附近，剩下那几个 0.15~0.22 的要能解释。
      // 光有 max 一个数不行：把"当时在做什么"记下来才分得开"多跑了一拍"和"预测器算错了"。
      if (r.corrected > 0.08) {
        // 光有大小不够：0.8 m 的校正到底是"沿地面被推了一下"（dy≈0）、"落地/台阶的高度差"
        // （dz 或 dy 主导）、还是"两边 yaw 已经不同所以走的不是同一条线"，只有分量能分开。
        const jb = win.length ? win[0].j : null;      // 基态那一格的账本（诊断用）
        // 旗标两边必须用**同一张编码表**。这条以前是本地自己拼的位序（alive*1、onGround*2、
        // sliding*4…），而 e.flags 走的是 js/quant.js 的 FLAG —— 第 2 位在表里是 Crouch 不是
        // OnGround。于是打印出的"日记本 3 / 权威 81"看着像两边状态打架，其实是同一个
        // "活着、踩在地面上"被两套编码各写了一遍。判据为此红过一整轮才被抓到。
        // 光有"同一张编码表"还不够，还得是**同一个取值方式**。服务端那一位 Crouch 不是
        // pl.crouching，而是 pl.crouchT > 0.5（见 server/room.mjs 的打包），Ads 是 ws.adsT > 0.5、
        // Firing 是 time - lastShot < 0.08。日记本里那几个同名布尔读出来直接对，就会在每一次
        // 蹲下/起身的过渡里（0 < crouchT ≤ 0.5）稳定报"两边打架"——那是量具在量自己的阈值差，
        // 不是失步。所以这里镜像服务端的表达式，而不是抄同名字段。
        // 第三个坑（这一轮才踩到）：比的对象得是**重建出来那一刻**的姿态，不是账本那一格。
        // 两者在 deficit>0 的空跑窗里差着一整个空跑段（账本比权威端早 deficit 拍），拿它比
        // 就是在量两件不同的事。重建值由 predict 交回来（rollback 的 baseState）—— 它是
        // "这一窗服务端跑过的 dTick 步重演完之后"的姿态，才是真正和权威同一时刻的那一份。
        const bs = r.baseState;
        const jf = bs ? ((bs.alive ? FLAG.Alive : 0) | (bs.crouchT > 0.5 ? FLAG.Crouch : 0) | (bs.sprinting ? FLAG.Sprint : 0)
          | (bs.onGround ? FLAG.OnGround : 0) | (bs.sliding ? FLAG.Sliding : 0)) : null;
        // 只在"基态和快照是同一时刻"时才计数：rep>0 时基态本就早 rep 拍，不等是对的。
        if (steady && !(e.rep | 0) && hit && jf !== null && jf !== (e.flags & FLAG_BASE_MASK)) {
          this.flagMismatch = (this.flagMismatch || 0) + 1;
          if (!this.flagMismatchWhy) this.flagMismatchWhy = { jf, auth: e.flags & FLAG_BASE_MASK, dp: jb.pos && [+e.x.toFixed(2), +e.z.toFixed(2)] };
        }
        this.steadyWorst = this.steadyWorst || [];
        if (this.steadyWorst.length < 40) this.steadyWorst.push({
          d: +r.corrected.toFixed(4), start, snapTick: this.serverTick, replayed: r.replayed,
          win: win.length, dTick, dAck, inflight: ((this.localTick - e.ack) & 0xffff),
          spd: +Math.hypot(pl.vel.x, pl.vel.y, pl.vel.z).toFixed(2), vy: +pl.vel.y.toFixed(2),
          rep: e.rep | 0, reps: r.reps, qDrop, onG: !!pl.onGround, fire: !!(e.flags & FLAG.Firing),
          // 这一窗服务端真跑过的那 dTick 步被拆成了哪几段：deficit 是空跑总拍数（= Δtick−Δack），
          // lead 是其中落在"首次消费之前"的那几段（rep 报不出来的就是它），led 是实际重演了几拍。
          // 三个数必须自洽：led = lead + Δack，且 lead + Δack + reps = Δtick。不自洽就说明
          // carry 那条线的料接错了 —— 这是它唯一的内部一致性检查，比位置读数先红。
          deficit, lead, led: r.led,
          dp: jb ? [+((e.x - jb.pos[0]).toFixed(3)), +(e.y - jb.pos[1]).toFixed(3), +((e.z - jb.pos[2]).toFixed(3))] : null,
          dYaw: jb ? +((e.yaw - jb.yaw + Math.PI * 3) % (Math.PI * 2) - Math.PI).toFixed(4) : null,
          dHp: jb ? +(e.hp - jb.hp).toFixed(1) : null,
          jFlags: jf,
          eFlags: e.flags & FLAG_BASE_MASK,
          // 轨迹形状分开两种完全不同的事：
          //  · 逐拍等距爬升  ⇒ 权威端比我多跑了几拍（配对/吞吐）
          //  · 某两拍之间突然断 0.9 m ⇒ 本地自己瞬移了一次（撞墙解算、上一次校正的硬拉）
          traj: win.map(h => [+((h.tick - start) & 0xffff), +h.j.pos[0].toFixed(2), +h.j.pos[2].toFixed(2)]),
          auth: [+e.x.toFixed(2), +e.z.toFixed(2)],
          // 基态那一拍我正对着墙吗？撞墙解算的时序差是这里唯一会比"错几拍"更大的东西。
          wallAhead: jb ? +(() => {
            const w = this.game.world.raycast(
              { x: jb.pos[0], y: jb.pos[1] + 1.62, z: jb.pos[2] },
              { x: -Math.sin(jb.yaw), y: 0, z: -Math.cos(jb.yaw) }, 6);
            return w ? w.t : -1;
          })().toFixed(2) : null,
        });
      }
    } else this.otherMax = Math.max(this.otherMax || 0, r.corrected);
    // 自我诊断：**每一包稳态**都把"权威读数最接近我日记本的第几拍"量出来。
    // 为什么不只量 >5cm 的那几次（上一版那样）：如果配对整体错了一格，每次校正就恰好是
    // "满速一拍 ≈ 0.078 m"这种小到跨不过 5cm 门的量，系统性偏差会在报表上伪装成噪声。
    // sum0（假设 offset=0 时的残差）和 sumBest（每包最优 offset 的残差）一比就知道。
    if (steady) {
      const p = this.pairProbe = this.pairProbe || { n: 0, hist: {}, worst: 0, bad: [], sum0: 0, sumBest: 0, sumD: 0, nZero: 0, nOne: 0, nOther: 0, nMis: 0, attributed: 0, unexplained: [] };
      const distAt = (o) => {
        const want = (start + o) & 0xffff;
        const h = this.history.find(x => x.j && x.tick === want);
        return h ? Math.hypot(h.j.pos[0] - e.x, h.j.pos[1] - e.y, h.j.pos[2] - e.z) : Infinity;
      };
      let best = Infinity, bo = 99;
      // 按 |offset| 从小到大扫 + 严格小于：站着不动时各拍的日记本位置全都等距，
      // 扫描顺序决定 argmin 落在哪个格子上。上一版从 -2 开始扫，于是"原地站着"
      // 被记成"最优 offset=-2"（325 个假样本），把直方图读成了配错拍。
      for (const o of [0, 1, -1, 2, 3, 4, 5, 6, 7, 8, -2, -3, -4]) {
        const d = distAt(o); if (d < best) { best = d; bo = o; }
      }
      const d0 = distAt(0);
      p.n++; p.hist[bo] = (p.hist[bo] || 0) + 1;
      p.sum0 += d0; p.sumBest += (best === Infinity ? 0 : best); p.sumD += r.corrected;
      if (bo === 0) p.nZero++; else if (bo === 1) p.nOne++; else p.nOther++;
      // "配错拍"要能被证据支撑，不是看 argmin 落在哪儿：站着不动时相邻几拍的日记本
      // 位置只差量化噪声（实测均值 4.7 mm、量化步长 0.23 cm），argmin 在它们之间随机跳，
      // 那种样本记成"错拍"是在给噪声定罪。判据改成"另一拍的解释力至少强一倍"。
      // 定罪要同时过两关：相对上"另一拍的解释力强一倍"，绝对上"多解释的距离量得过尺子
      // 自己的分辨率"。位置量化步长实测最大 0.23 cm，站着不动时相邻几拍的日记本只差
      // 一两个量化格 —— 只看相对比值会把 1.7mm vs 0.9mm 这种纯噪声判成"配错 4 拍"。
      if (bo !== 0 && best * 2 < d0 && d0 - best > 0.02) {
        p.nMis++;
        // 归因：错拍样本必须落在"输入总线出过事"的那一包上（饥饿 / 跳过 / 重复拍刚结束）。
        // 契约断言因此是因果的而不是量级的 —— 真出现一个不落在队列事件上的错拍样本，
        // 那才是配对规则本身有洞，也正是这种最难找的错。
        if (!queueEvent) p.unexplained.push({
          start, bo, best: +best.toFixed(4), d0: +d0.toFixed(4), corrected: r.corrected,
          snapTick: this.serverTick, localTick: this.localTick, dTick, dAck, rep: e.rep | 0,
          dup: this.dupTicks | 0, inflight: ((this.localTick - e.ack) & 0xffff), prevStart: this.lastStart,
          // 附近几拍的拍号 + 位置：一次就能看出是不是"同一拍记了两遍"或"某一拍没记"
          near: this.history.filter(x => x.j && (((x.tick - start) & 0xffff) < 6 || ((x.tick - start) & 0xffff) > 65530))
            .map(x => [x.tick, +x.j.pos[0].toFixed(2), +x.j.pos[2].toFixed(2)]),
        });
        else p.attributed++;
      }
      if (r.corrected > 0.05) {
        // 只有"偏移假设能把误差解释掉一个量级"才算配对错，否则 6cm 这种普通小校正
        // 在任何 offset 上都差不多，硬要它落在 0 只是在给噪声定罪。
        if (bo !== 0 && r.corrected > 0.2 && best * 3 < r.corrected) p.bad.push({ start, corrected: r.corrected, at: bo, dist: best });
        p.worst = Math.max(p.worst, r.corrected);
        p.last = { start, snapTick: this.serverTick, localTick: this.localTick, win: win.length, corrected: r.corrected, bestOffset: bo, bestDist: best };
      }
    }
  }

  onEvents(j) {
    for (const ev of j.ev) {
      this.events.push(ev);
      if (ev.e === 'kill') {
        const g = this.game;
        if (ev.victim === (g.player && g.player.name)) { g.onNetDeath && g.onNetDeath(ev); }
        g.onNetKill && g.onNetKill(ev);
      } else if (ev.e === 'respawn' && ev.cid === this.cid) {
        // 重生是服务端发起的整体重置：本地那一拍之前的 journal/待重放输入全部作废，
        // 拿旧位置的日记本去"回滚"会把人拽回死点；同时也不该把这次传送算成预测偏差。
        this.hardSnap = true;
        // 记下"从这一拍起我才有新日记本"：重生瞬间还在路上的那几份输入，服务端稍后会
        // 拿它们升 ack，而那个拍号的日记本已经被我清了 —— 那是可预期的空窗，不是窗口不够长。
        this.floor = (this.localTick + 1) & 0xffff;
        this.history.length = 0;
        this.respawnSnaps = (this.respawnSnaps || 0) + 1;
        this.game.onNetRespawn && this.game.onNetRespawn(ev);
      } else if (ev.e === 'join') {
        this.roster.set(ev.cid, { name: ev.name, team: ev.team });
        const r = this.remotes.get(ev.cid);
        if (r) r.setName && r.setName(ev.name, ev.team);
      } else if (ev.e === 'streakReady') {
        // 充能到线。槽位状态**由服务端推**，客户端不自己比 progress >= cost ——
        // 那会让"什么时候算就绪"有两个真相，而两者对不上时玩家按下去没反应。
        this.setStreakSlot(ev.id, { ready: true });
        if (ev.cid === this.cid) {
          const i = this.streakState.findIndex(s => s.id === ev.id);
          this.game.hud.announce(`${ev.name} 就绪`, `按 [${i + 3}] 呼叫`, 2.5);
          this.game.audio.say(ev.name + '已就绪'); this.game.audio.beep(3);
        }
      } else if (ev.e === 'streak') {
        this.setStreakSlot(ev.id, { ready: false, used: true });
        if (ev.cid === this.cid) this.game.audio.say(ev.name + '已呼叫');
      } else if (ev.e === 'turret') {
        this.spawnTurret(ev);
      } else if (ev.e === 'gone') {
        this.removeTurret(ev.netId);
      } else if (ev.e === 'announce') {
        // team 是**呼叫者的队**，是按接收者过滤不了的那种广播 —— 所以"敌方"这个词
        // 在这里加，而不是让服务端给每个人各编一份文案。
        const mine = ev.team === this.team;
        this.game.hud.announce(ev.text, mine ? '' : '敌方', 2.5);
        this.game.audio.say((mine ? '' : '敌方') + ev.text);
      } else if (ev.e === 'firstBlood') {
        if (ev.cid === this.cid) this.game.hud.popup('首杀', '', true);
      } else if (ev.e === 'board') {
        this.board = ev;
        this.scores.A = ev.scores.A; this.scores.B = ev.scores.B;
        this.timeLeft = ev.timeLeft;
        const me = (ev.rows || []).find(r => r.cid === this.cid);
        this.streakProgress = me ? (me.sk | 0) : 0;
      } else if (ev.e === 'matchOver') {
        this.over = true; this.matchWinner = ev.winner;
        const mine = ev.winner === this.team;
        this.game.hud.announce(mine ? '胜利' : ev.winner === 'draw' ? '平局' : '失败', '', 4);
        this.game.audio.say(mine ? '胜利' : '失败');
        this.game.hud.showScoreboard(true);
      }
    }
    if (this.events.length > 64) this.events.splice(0, this.events.length - 64);
  }

  // 作为 game.mode 的接口：对局推进在服务端，本地按拍没有额外要算的东西 ——
  // 但**规则侧读数要刷到屏幕上**：连杀槽、比分/时间条、白磷弹的屏幕效果。
  // 它们全都来自服务端的推送（事件 + 世界标志位），这里一行判断都不做。
  // 判断留在这边的话，"什么时候算就绪"就有了两个真相。
  update(dt, inp) {
    const hud = this.game.hud;
    hud.streaks(this.streakDefs.length ? this.streakState : null, Math.floor(this.streakProgress));
    // 比分条按 6Hz 刷（每 10 拍）而不是每拍：它是 innerHTML 赋值，60Hz 刷会白掉帧。
    // 时间条走到秒都看得见，6Hz 足够。
    if ((this.localTick % 10) === 0) {
      const t = Math.max(0, this.timeLeft | 0);
      const mm = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      hud.scorebar(`<div class="sb-team a">${Math.floor(this.scores.A)}</div><div class="sb-time">${mm}</div><div class="sb-team b">${Math.floor(this.scores.B)}</div>`);
    }
    // 白磷弹的屏幕效果：权威端在放它时把 WhitePhosphorus 位置 10 秒，快照每拍带过来。
    // 这一位以前从来没被写过（server/room.mjs 的 worldFlags 硬编码 0），于是联机里
    // 白磷弹除了扣血什么表现都没有。
    this.game.grade.uniforms.wp.value = (this.worldFlags & WORLD.WhitePhosphorus) ? 0.6 : 0;
  }

  // ---------- 连杀奖励在本地的表现 ----------
  setStreakSlot(id, patch) {
    const s = this.streakState.find(x => x.id === id);
    if (s) Object.assign(s, patch);
  }

  // 权威端放的哨戒机枪 / 武装直升机，在客户端建一个**不开火**的同形副本（dumb）。
  // 位置/相位/寿命都来自事件 —— 客户端各抽一份的话，两边的直升机不在同一条航线上；
  // 而"谁被它打中"这件事只有权威端说了算（副本开火会打出第二份伤害，快到没人能察觉
  // 是它错了，只会觉得"这一局死得特别快"）。
  spawnTurret(ev) {
    const g = this.game;
    if (!g.world) return;                              // 地图还没加载完的窗口里收到一条迟到的事件
    const mine = ev.team === (g.player && g.player.team);
    const owner = { team: ev.team, isPlayer: mine, alive: true, yaw: ev.yaw || 0 };
    let ent;
    if (ev.kind === 'sentry') {
      ent = new Sentry(g, new THREE.Vector3(ev.x, ev.y, ev.z), owner, { dumb: true, duration: ev.dur });
    } else {
      ent = new Heli(g, ev.team, owner, { dumb: true, duration: ev.dur, ang: ev.ang, height: ev.height, radius: ev.radius });
    }
    ent.netId = ev.netId;
    this.turrets.set(ev.netId, ent);
  }

  removeTurret(netId) {
    const t = this.turrets.get(netId);
    if (!t) return;
    if (t.dispose) t.dispose();
    if (t.mesh && t.mesh.parent) t.mesh.parent.remove(t.mesh);
    const i = this.game.entities.indexOf(t);
    if (i >= 0) this.game.entities.splice(i, 1);
    this.turrets.delete(netId);
  }

  // 每渲染帧一次：驱动远端实体的插值
  frameUpdate(dt) {
    const now = performance.now() / 1000;
    // 半开连接：TCP 还在、对端已经不发包了（换网络、进程被 OOM 杀掉、LB 空闲回收）。
    // 浏览器不会为这种情况触发 onclose，只能自己数"多久没收到快照"：
    // 正常 20Hz 下行，2.5 秒 = 连丢 50 包，那不是抖，那是没了。
    // 计时只用"确实在跑帧"的那段时间：整页冻结、切后台、加载地图那种几秒长任务里，帧间隔
    // 一次就跨过阈值，可那段时间事件循环根本没转 —— 快照没被*处理*不等于服务器没在*发*。
    // 最早的症状就是基线写死 0：进场本身要 6 秒，于是人人一进对局就报"失联"。
    const since = now - (this._lastFrameAt || now); this._lastFrameAt = now;
    if (this.connected && this.welcome && !this.lost) {
      this.snapGap += since < 0.25 ? since : 0;
      if (this.snapGap > 2.5) this.markLost('stale', '已经 2.5 秒没收到服务器状态');
    }
    for (const r of this.remotes.values()) r.update(dt, now);
    // 连杀奖励的表现副本按渲染帧走（它们只做动画与朝向，没有要裁决的东西）。
    // 寿命到点由权威端的 gone 事件说了算，这里的 this.t 只是兜底。
    for (const t of this.turrets.values()) t.update(dt);
  }

  spawnPoint() { return { pos: this.game.player ? this.game.player.pos.clone() : null, yaw: 0 }; }

  // 小地图的 UAV 效果。hud.drawMinimap 拿它决定"要不要把敌人画出来"，
  // 而敌人位置本来就在客户端手上（remotes 的插值结果）—— 所以这里只需要回答
  // 一个问题：**我的队现在有没有 UAV**。答案在世界标志位里（两位，按队查）。
  uavActive(team) { return uavFromFlags(this.worldFlags, team || this.team); }

  minimapMarkers() { return []; }

  scoreboardHTML() {
    const row = (r) => `<tr class="${r.cid === this.cid ? 'me' : ''}"><td>${r.name}</td><td>${r.s}</td><td>${r.k}</td><td>${r.d}</td><td>-</td></tr>`;
    const head = (t, cls) => `<table class="sbt ${cls}"><tr><th>${t}</th><th>得分</th><th>击杀</th><th>死亡</th><th>助攻</th></tr>`;
    const rows = (this.board && this.board.rows) || [];
    const A = rows.filter(r => r.team === this.team), B = rows.filter(r => r.team !== this.team);
    return head(`我方 · ${Math.floor(this.scores.A)}`, 'A') + A.map(row).join('') + '</table>'
      + head(`敌方 · ${Math.floor(this.scores.B)}`, 'B') + B.map(row).join('') + '</table>';
  }

  dispose() {
    for (const t of [...this.turrets.values()]) this.removeTurret(t.netId);
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    if (this.ws) this.ws.close();
  }
}
