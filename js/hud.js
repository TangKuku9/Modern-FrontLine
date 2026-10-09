// HUD 显示
import * as THREE from 'three';
import { KILLSTREAKS } from './data.js';
import { fmtTime, clamp } from './util.js';
import { parseChatCommand, toggleMute, chatRowHtml, isImeKey } from './net/chat.mjs';
import { escHtml } from './escape.js';
// 弱占领圈半径：小地图上那个虚线圆是它的**唯一**视觉（世界里刻意不画，见 flagMesh）。
import { DOM_RADIUS_WEAK } from './match-rules.js';

const $ = id => document.getElementById(id);
const _v = new THREE.Vector3();

export class HUD {
  constructor(game) {
    this.game = game;
    this.el = $('hud');
    this.mm = $('minimap').getContext('2d');
    this.hitT = 0; this.flashT = 0; this.flashMax = 1; this.alertT = 0;
    this.dmgDirs = [];
    this.subQueue = []; this.subT = 0;
    this.announceT = 0;
    this.buildCompass();
    this.fpsAcc = 0; this.fpsN = 0;
    // 节流累加器（客户端性能审查 C1）：初值给满 —— 进对局第一拍就把小地图/敌名画出来，
    // 不等第一个周期。
    this.sweepT = 1; this.mmT = 1;
    // 对局内聊天（差距 43）：行的缓冲、开合状态与频道都归 HUD —— 它是唯一画这块的层。
    // 命令（/w 私聊 · /emote 表情 · /mute /report）的判定在 js/net/chat.mjs（与菜单屏共用），这里只做分发。
    this.chatRows = []; this.chatActive = false; this.chatChannel = 'match';
    const ci = $('chatSay');
    if (ci) ci.addEventListener('keydown', e => {
      // stopPropagation：开着聊天时，游戏那套快捷键一个都不许再接走（Esc 的暂停、
      // Tab 的记分板、WASD 的移动都会从这个输入框抢按键）。
      e.stopPropagation();
      if (isImeKey(e)) return;                    // 选词中的回车是"上屏"，不是"发送"（差距 44）
      if (e.key === 'Enter') { e.preventDefault(); this.chatSubmit(); }
      else if (e.key === 'Escape') { e.preventDefault(); ci.value = ''; this.chatClose(); }
    });
  }
  show(v) { this.el.classList.toggle('hidden', !v); }
  buildCompass() {
    const strip = $('compassStrip');
    const names = { 0: '北', 45: '东北', 90: '东', 135: '东南', 180: '南', 225: '西南', 270: '西', 315: '西北' };
    let html = '';
    for (let rep = -1; rep <= 1; rep++) {
      for (let a = 0; a < 360; a += 15) {
        const x = (a + rep * 360) * 4;
        html += names[a] !== undefined ? `<span style="left:${x}px">${names[a]}</span>` : `<span class="minor" style="left:${x}px">${a}</span>`;
      }
    }
    strip.innerHTML = html;
  }
  reset() {
    $('killfeed').innerHTML = ''; $('popups').innerHTML = ''; $('subtitles').innerHTML = ''; $('objective').innerHTML = '';
    $('markers').innerHTML = ''; $('dmgDirs').innerHTML = ''; this.dmgDirs = []; this.subQueue = []; this.subT = 0;
    $('fade').style.opacity = 0; $('flashOverlay').style.opacity = 0; this.flashT = 0;
    $('announce').style.opacity = 0; $('scorebar').innerHTML = ''; $('streaks').innerHTML = '';
    this.markerEls = {};
    // 节流状态一并归位（C1）：_eqSig 不清的话，重开局装备串恰好与上局相同会跳写、
    // 装备行空白；累加器给满让第一拍立刻重画。
    this._eqSig = undefined; this.sweepT = 1; this.mmT = 1;
    $('enemyName').textContent = '';
    // 聊天条也是上一局的残留：不清的话上一局的话会跟着新局一起开（与 deathScreen 同一类事）
    this.chatRows = []; this.chatActive = false; this.chatChannel = 'match'; clearTimeout(this.chatT);
    const cb = $('chatBox');
    if (cb) { cb.classList.add('hidden'); cb.classList.remove('open'); }
    $('chatLog').innerHTML = '';
  }
  hitmarker(kill, head) {
    const h = $('hitmarker');
    h.classList.toggle('kill', !!kill);
    h.style.opacity = 1; this.hitT = kill ? 0.35 : 0.18;
    h.style.transform = `scale(${kill ? 1.3 : 1})`;
  }
  flash(t) { this.flashT = t; this.flashMax = t; }
  damageFrom(pos) {
    const el = document.createElement('div'); el.className = 'dmgdir';
    $('dmgDirs').appendChild(el);
    this.dmgDirs.push({ el, pos: pos.clone(), t: 1.6 });
  }
  highAlert(pos) {
    const pl = this.game.player; if (!pl) return;
    const cam = this.game.camera;
    _v.copy(pos).project(cam);
    if (_v.z > 1 || Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1) this.alertT = 0.4;
  }
  killfeed(killer, victim, weapon, head) {
    const kf = $('killfeed');
    const cls = e => !e ? '' : e.isPlayer ? 'me' : this.game.mode && this.game.mode.ffa ? 'B' : (e.team === this.game.player.team ? 'A' : 'B');
    const d = document.createElement('div'); d.className = 'kf';
    // 三格都在这**一处**过 escHtml（M10）：两个呼号来自别的玩家，weapon 来自服务端事件，
    // 而这里是拼 innerHTML 的地方。改动前 weapon 由调用方转义、两个名字裸着 ——
    // 一半转一半不转看着像"已经处理过了"，实际上 victim.name 就是那条注入路（呼号白名单
    // 眼下把 `<` 压死了，所以属纵深防御：白名单一放宽就是存储型 XSS）。
    // 转义**放在拼 innerHTML 的那一处**是刻意的：放调用方的话，多一个调用点就多一次"忘了"。
    const kn = killer && killer !== victim ? `<span class="${cls(killer)}">${escHtml(killer.name)}</span>` : '';
    d.innerHTML = `${kn}<span class="w">${escHtml(weapon) || '击杀'}${head ? ' ✹' : ''}</span><span class="${cls(victim)}">${escHtml(victim.name)}</span>`;
    kf.prepend(d);
    while (kf.children.length > 6) kf.lastChild.remove();
    setTimeout(() => d.remove(), 6000);
  }
  // ── 对局内聊天（差距 43）──
  // 开合与发送都在这里，键位在 main.js（Enter 全体 / Y 队伍）。指针锁**不解**：
  // 解锁会顺带触发"失去指针锁 = 暂停"那条既有逻辑，而打字时对局在联机里照跑 ——
  // 鼠标改成在 main.js 里按 chatActive 静音（不动视角、不开火）。
  chatOpen(ch) {
    this.chatActive = true;
    this.chatChannel = ch === 'team' ? 'team' : 'match';
    const box = $('chatBox'), inp = $('chatSay');
    if (!box || !inp) return;
    box.classList.remove('hidden'); box.classList.add('open');
    $('chatCh').textContent = this.chatChannel === 'team' ? '队伍' : '全体';
    inp.value = '';
    inp.placeholder = this.chatChannel === 'team' ? '说给队友…（/w 私聊 · /emote 表情 · /mute /report）' : '说点什么…（/w 私聊 · /emote 表情 · /mute /report）';
    inp.focus();
    this.chatRender();
  }
  chatClose() {
    this.chatActive = false;
    const box = $('chatBox'); if (!box) return;
    box.classList.remove('open');
    const inp = $('chatSay'); if (inp) inp.blur();
    this.chatRender();
    if (this.game.lock) this.game.lock();      // 已经锁着就是无操作；为"解锁过"的旧路径兜底
  }
  chatSubmit() {
    const inp = $('chatSay');
    const raw = inp ? inp.value : '';
    if (inp) inp.value = '';
    const cmd = parseChatCommand(raw);
    const g = this.game;
    if (cmd.op === 'say') {
      if (cmd.text && g.net) g.net.say(this.chatChannel, cmd.text);
      this.chatClose();                          // 发完就收：回车 = 说一句，不是留在框里
      return;
    }
    if (cmd.op === 'whisper' || cmd.op === 'emote') {
      // 私聊与表情同样"发完就收"（与发言一致）：它们是要说给人听的话，不是设置项
      if (g.net) cmd.op === 'whisper' ? g.net.say('whisper', cmd.text, cmd.name) : g.net.emote(cmd.name);
      this.chatClose();
      return;
    }
    // 命令留在框上（可能连着 /mute、/unmute 用），反馈画进聊天条 —— 不弹 announce：
    // 弹窗是"战场上的事"，命令的回执是"聊天框里的事"。
    if (cmd.op === 'mute' || cmd.op === 'unmute') {
      g.profile.muted = toggleMute(g.profile.muted, cmd.name, cmd.op === 'mute');
      if (g.saveProfile) g.saveProfile();
      this.chatLocal(cmd.op === 'mute'
        ? `已屏蔽「${cmd.name}」，他的话不再显示（/unmute ${cmd.name} 可恢复）`
        : `已解除对「${cmd.name}」的屏蔽`);
    } else if (cmd.op === 'muted') {
      const list = (g.profile && g.profile.muted) || [];
      this.chatLocal(list.length ? '当前屏蔽：' + list.join('、') : '当前没有屏蔽任何人');
    } else if (cmd.op === 'report') {
      const self = g.net ? g.net.name : '';
      if (cmd.name === self) this.chatLocal('不能举报自己');
      else if (g.net) { g.net.report(cmd.name, cmd.reason); this.chatLocal(`正在举报「${cmd.name}」…`); }
    } else {
      this.chatLocal(`不认得命令「${cmd.text}」——可用：/w 私聊 · /emote 表情 · /mute /unmute /muted · /report`);
    }
    this.chatRender();
  }
  // 本地回执（命令结果）：只进自己这台机器的聊天条，不上行。
  chatLocal(text) {
    this.chatRows.push({ sys: true, text, at: Date.now() });
    if (this.chatRows.length > 30) this.chatRows.shift();
    this.chatRender();
    clearTimeout(this.chatT);
    this.chatT = setTimeout(() => this.chatRender(), 12000);
  }
  // 一行聊天进来（服务端下发，或本地回执经 chatLocal）。屏蔽过滤在渲染侧
  // （chatRowHtml 按 muted 名单返回空串）—— 名单是本地的，谁被屏蔽这件事不上行、
  // 也不告诉对方。
  chatPush(row) {
    if (!row || row.sys) { if (row) this.chatLocal(row.text); return; }
    this.chatRows.push(row);
    if (this.chatRows.length > 30) this.chatRows.shift();
    this.chatRender();
    clearTimeout(this.chatT);
    this.chatT = setTimeout(() => this.chatRender(), 12000);  // 12 秒没新话就淡出收起
  }
  chatRender() {
    const box = $('chatBox'), log = $('chatLog');
    if (!box || !log) return;
    const open = !!this.chatActive, now = Date.now();
    // 关着只留最近 12 秒的行（别把战场糊住）；开着翻最近 30 行
    const rows = (open ? this.chatRows : this.chatRows.filter(r => now - (r.at || now) < 12000)).slice(-30);
    const mine = this.game.net ? this.game.net.cid : null;
    const muted = (this.game.profile && this.game.profile.muted) || [];
    log.innerHTML = rows.map(r => chatRowHtml(r, { mine: r.cid != null && r.cid === mine, muted })).join('');
    box.classList.toggle('hidden', !rows.length && !open);
    log.scrollTop = log.scrollHeight;
  }
  popup(text, color = '#fff', medal = false) {
    const p = $('popups');
    const d = document.createElement('div'); d.className = 'pop' + (medal ? ' medal' : ''); d.style.color = medal ? '' : color; d.textContent = text;
    p.appendChild(d);
    while (p.children.length > 5) p.firstChild.remove();
    setTimeout(() => d.remove(), 2200);
  }
  announce(title, sub = '', dur = 3) {
    const a = $('announce');
    // 这里也是 innerHTML 的拼接点，所以两格都过 escHtml（M10）。`sub` 尤其重要：
    // 掉线说明与大厅 note 帧（都来自服务端）就是走这一格上来的 ——
    // 原来它们裸着进 innerHTML，而同一个页面另一处（打开背包那种）却是转义的。
    a.innerHTML = escHtml(title) + (sub ? `<small>${escHtml(sub)}</small>` : '');
    a.style.opacity = 1; this.announceT = dur;
  }
  subtitle(speaker, text, dur) {
    this.subQueue.push({ speaker, text, dur: dur || Math.max(2.5, text.length * 0.16) });
  }
  objective(title, desc, sub = '') {
    $('objective').innerHTML = title ? `<div class="obj-t">${title}</div><div class="obj-d">${desc}</div>${sub ? `<div class="obj-s">${sub}</div>` : ''}` : '';
  }
  prompt(text) {
    const p = $('prompt');
    if (!text) { p.style.display = 'none'; return; }
    p.style.display = 'block'; p.innerHTML = text;
  }
  // v = 0..1；side = 'ally' | 'enemy'（可选）。混战时进度条会**停在原地不动** ——
  // 颜色是唯一能回答"这是谁的动作"的东西：我方在占 = 蓝，敌方在夺 = 红。不传 side
  // 走默认强调色（campaign 的下载/解密条共用这个元素）。
  progress(v, side) {
    const p = $('progress');
    if (v === null || v === undefined) { p.style.display = 'none'; return; }
    p.style.display = 'block';
    const f = $('progressFill');
    f.style.width = (v * 100) + '%';
    const cls = side === 'ally' ? 'ally' : side === 'enemy' ? 'enemy' : '';
    if (f._side !== cls) { f._side = cls; f.className = cls; }
  }
  fade(v, dur = 1) { const f = $('fade'); f.style.transition = `opacity ${dur}s`; f.style.opacity = v; }
  scorebar(html) { $('scorebar').innerHTML = html; }
  streaks(list, kills) {
    const el = $('streaks');
    // 内容签名门（与 client.mjs 标记层的 `_mSig` 同款；性能审查 W4）：这一格由 NetClient.update
    // 在 **60Hz 模拟拍**上每拍调一次，而它是整块 innerHTML 赋值 —— 60Hz 全量重建会白掉帧
    // （比分条那格早就按 6Hz 刷，理由就是这个）。签名只含**真正参与渲染**的几个量：槽位
    // id/ready/cost + 连杀数；变了才写。也包括"没有连杀槽"那一格 —— 以前每拍写一次
    // innerHTML = ''，现在只在从有到无时写。
    const sig = list
      ? list.map(s => `${s.id}:${s.ready ? 1 : 0}:${s.cost}`).join('|') + '#' + kills
      : 'none';
    if (sig === this._stkSig) return;
    this._stkSig = sig;
    if (!list) { el.innerHTML = ''; return; }
    el.innerHTML = list.map((s, i) => {
      const def = KILLSTREAKS.find(k => k.id === s.id);
      return `<div class="stk ${s.ready ? 'ready' : ''}"><span>${s.ready ? `[${i + 5}] ` : ''}${def.name}</span><span class="k">${s.ready ? '就绪' : s.cost}</span><span class="ic">${def.icon}</span></div>`;
    }).join('') + `<div class="stk"><span>连杀</span><span class="k">${kills}</span></div>`;
  }

  // FPS 的**计量**在渲染帧上(main.js 每个放行帧调一次 meterFrame,帧率上限挡掉的
  // 帧不进来);update() 跑在 60Hz 模拟拍上,在这里计量量到的是拍频 —— 固定步长下
  // 恒 60,显示器 144Hz 也显示 60。拍频与帧率是两个数,右下角要报的是后者。
  // dt 取的是那一帧的**墙钟差**,所以锁 60 时读数就是 60,而不是被 raw 的截断带偏。
  meterFrame(dt) { this.fpsAcc += dt; this.fpsN++; }

  update(dt) {
    const game = this.game, pl = game.player;
    if (!pl) return;
    // FPS:计量见 meterFrame,这里只每 0.5s 刷一次读数
    if (this.fpsAcc > 0.5) { $('fps').textContent = game.settings.showFps ? Math.round(this.fpsN / this.fpsAcc) + ' FPS' : ''; this.fpsAcc = 0; this.fpsN = 0; }
    const ws = pl.ws, w = ws.w;
    // 准星
    const ch = $('crosshair');
    // 死了就不许再挂瞄具遮罩（scoped 加 alive 防护的原因见下面 scope 那一段）。
    // 注意这里**不能**再拿 `!!` 压成布尔：下面 scope 那段拿它跟 'sniper' 比对、并
    // 原样赋给 #scope 的 className —— 压平之后 .scope.acog/.scope.thermal 的 CSS
    // 永远挂不上（optic.mjs C 组全红的出处，2026-10-03）。
    const scoped = pl.alive && game.scopeState;
    const hideCross = ws.adsT > 0.4 || pl.sprinting || !pl.alive || (w && w.stats.type === 'sniper');
    ch.style.display = hideCross ? 'none' : 'block';
    if (w && !hideCross) {
      const spread = ws.currentSpread();
      const px = 4 + spread * (window.innerHeight / game.camera.fov) * 0.5;
      const cs = ch.children;
      cs[0].style.top = (-px - 9) + 'px'; cs[1].style.top = px + 'px';
      cs[2].style.left = (-px - 9) + 'px'; cs[3].style.left = px + 'px';
    }
    // 瞄准镜
    // pl.alive 的防护与 main.js 里 NVG/thermal 同一条（读取侧兜底）：联机死亡期间
    // 对账重放会拿死前的输入重演 ws.update，把 scopeState 写回 scoped —— 清场本体
    // 在 main.js:onNetDeath（调 ws.onDeath），这里挡的是"死后又被重放写回"的那一路。
    const sc = $('scope');
    if (scoped) { sc.classList.remove('hidden'); sc.className = scoped === 'sniper' ? '' : scoped; }
    else sc.classList.add('hidden');
    // 命中
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0) $('hitmarker').style.opacity = 0; }
    // 闪光
    if (this.flashT > 0) { this.flashT -= dt; $('flashOverlay').style.opacity = clamp(this.flashT / Math.min(1.5, this.flashMax), 0, 1); }
    else $('flashOverlay').style.opacity = 0;
    // 受伤
    const hpk = pl.hp / pl.maxHp;
    $('vignette').style.opacity = clamp((1 - hpk) * 1.3, 0, 1);
    const hf = $('healthFill'); hf.style.width = (hpk * 100) + '%'; hf.classList.toggle('low', hpk < 0.35);
    // 伤害方向
    for (let i = this.dmgDirs.length - 1; i >= 0; i--) {
      const d = this.dmgDirs[i];
      d.t -= dt;
      if (d.t <= 0) { d.el.remove(); this.dmgDirs.splice(i, 1); continue; }
      const dx = d.pos.x - pl.pos.x, dz = d.pos.z - pl.pos.z;
      const ang = Math.atan2(dx, -dz) + pl.yaw; // 屏幕角
      d.el.style.transform = `rotate(${ang}rad)`;
      d.el.style.opacity = Math.min(1, d.t);
    }
    // 警觉
    this.alertT -= dt;
    $('alertEdge').style.opacity = this.alertT > 0 ? 1 : 0;
    // 弹药。切出雷时弹面板换成雷种与余数（CS 同款：武器名位置报雷名）。
    // 三格走同值门（C1）：textContent 同值赋值也会替换文本节点触发失效，而这四样
    // 99% 的拍里没变 —— mag 只在开枪/换弹/拾取时动。low 类只随 mag 值变，跟着进门。
    const wnEl = $('weaponName'), magEl = $('ammoMag'), resEl = $('ammoRes');
    if (w && ws.nadeMode) {
      const inv = ws.nadeMode.kind === 'lethal' ? pl.lethal : pl.tactical;
      const wnTxt = (inv && inv.name) || ws.nadeMode.id;
      if (wnEl.textContent !== wnTxt) wnEl.textContent = wnTxt;
      const magTxt = inv ? String(inv.count) : '0';
      if (magEl.textContent !== magTxt) { magEl.textContent = magTxt; magEl.classList.toggle('low', !inv || inv.count <= 1); }
      if (resEl.textContent !== '') resEl.textContent = '';
    } else if (w) {
      const wnTxt = w.stats.name + (w.stats.suppressed ? ' · 消音' : '');
      if (wnEl.textContent !== wnTxt) wnEl.textContent = wnTxt;
      const magTxt = String(w.mag);
      if (magEl.textContent !== magTxt) { magEl.textContent = magTxt; magEl.classList.toggle('low', w.mag <= Math.ceil(w.stats.mag * 0.25)); }
      const resTxt = '/ ' + w.reserve;
      if (resEl.textContent !== resTxt) resEl.textContent = resTxt;
    }
    // 装备行：两种雷都挂在 4 上（按 4 在其间循环），切出中的那种点亮。
    {
      let eq = '';
      const on = ws.nadeMode && ws.nadeMode.kind;
      if (pl.lethal) eq += `<span${on === 'lethal' ? ' style="color:var(--acc)"' : ''}>[4] ${pl.lethal.name}<b>×${pl.lethal.count}</b></span>`;
      if (pl.tactical) eq += `<span${on === 'tactical' ? ' style="color:var(--acc)"' : ''}>[4] ${pl.tactical.name}<b>×${pl.tactical.count}</b></span>`;
      if (game.mode && game.mode.nvgAvailable) eq += `<span>[N] 夜视仪</span>`;
      // 签名门（C1，W4 streak 同族）：这段 innerHTML 此前每拍全量重建 —— 60Hz 写一个
      // 几乎从不变的字符串。变了才写。
      if (eq !== this._eqSig) { this._eqSig = eq; $('equipRow').innerHTML = eq; }
    }
    // 罗盘
    const deg = ((-pl.yaw * 180 / Math.PI) % 360 + 360) % 360;
    $('compassStrip').style.left = (230 - deg * 4 - 0) + 'px';
    // 字幕
    if (this.subT > 0) { this.subT -= dt; if (this.subT <= 0) $('subtitles').innerHTML = ''; }
    if (this.subT <= 0 && this.subQueue.length) {
      const s = this.subQueue.shift();
      $('subtitles').innerHTML = `<span class="sp">${s.speaker}：</span>${s.text}`;
      this.subT = s.dur;
      game.audio.say(s.text, 1.15, s.speaker.includes('指挥部') ? 0.7 : 0.9);
      if (s.speaker) game.audio.beep(1);
    }
    if (this.announceT > 0) { this.announceT -= dt; if (this.announceT <= 0) $('announce').style.opacity = 0; }
    // 瞄准敌人名称（C1）：一次 = world.raycast 全盒线性扫 + 全场实体 hitTest，
    // 60Hz 跑它就是烧钱；名字读数 15Hz 足够 —— 上名/清名最坏延迟 66ms，肉眼不可分。
    this.sweepT += dt;
    if (this.sweepT >= 1 / 15) {
      this.sweepT %= 1 / 15;
      const en = $('enemyName');
      let name = '';
      if (pl.alive) {
        const cam = game.camera;
        const d = cam.getWorldDirection(_v);
        let best = 60;
        const wh = game.world.raycast(cam.position, d, 60);
        if (wh) best = wh.t;
        for (const e of game.entities) {
          // FFA 下 team 是每人一支的独立键，拿"同队"排除会把全场跳过 —— 瞄谁都不出名字。
          if (e === pl || !e.alive || (e.team === pl.team && !(game.mode && game.mode.ffa)) || !e.hitTest) continue;
          const h = e.hitTest(cam.position, d, best);
          if (h) { name = e.name; best = h.t; }
        }
      }
      en.textContent = name;
    }
    // 小地图（C1）：clearRect + topDown 整图缩放 blit + 逐实体圆点，HUD 里最重的一格。
    // 30Hz —— 2.4px/m 的比例下跑动者每拍挪不到半像素，转身时 12°/拍的旋转也无顿挫感。
    this.mmT += dt;
    if (this.mmT >= 1 / 30) { this.mmT %= 1 / 30; this.drawMinimap(); }
    this.updateMarkers();
  }

  // 3D标记
  setMarkers(list) { this.markerList = list; }
  updateMarkers() {
    const list = this.markerList || [];
    const box = $('markers');
    if (!this.markerEls) this.markerEls = {};
    const seen = new Set();
    const cam = this.game.camera, pl = this.game.player;
    const W = window.innerWidth, H = window.innerHeight;
    for (const m of list) {
      seen.add(m.id);
      let el = this.markerEls[m.id];
      if (!el) { el = document.createElement('div'); box.appendChild(el); this.markerEls[m.id] = el; }
      // 内容签名门（C1，streaks/_mSig 同族）：innerHTML 此前每标记每拍重写（含距离读数）
      // —— 距离取整米，跑动时每秒也就变几次，站着不动一次都不写。投影与 left/top 仍
      // 每拍照写（贴镜头的活不省），只把 className/innerHTML 按签名刷。
      const dist = Math.round(m.pos.distanceTo(pl.pos));
      const sig = (m.cls || '') + '|' + (m.label || '') + '|' + (m.text || '') + '|' + (m.hideDist ? '' : dist);
      if (el._sig !== sig) {
        el._sig = sig;
        el.className = 'marker ' + (m.cls || '');
        el.innerHTML = `<div class="dia"><span>${m.label || ''}</span></div>${m.text ? m.text + ' ' : ''}${m.hideDist ? '' : dist + 'm'}`;
      }
      _v.copy(m.pos).project(cam);
      const behind = _v.z > 1;
      let x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
      if (behind) { x = W - x; y = H - 40; }
      x = clamp(x, 40, W - 40); y = clamp(y, 60, H - 40);
      el.style.left = x + 'px'; el.style.top = y + 'px';
    }
    for (const id in this.markerEls) if (!seen.has(id)) { this.markerEls[id].remove(); delete this.markerEls[id]; }
  }

  // 死亡画面·复活点卡片（占领）。单一渲染点：签名没变就不写 DOM（respawnText 同一招）。
  // flagsView = [{name, mine, cd, label}]，sel = 当前选中的旗下标（null = 基地），
  // baseCd = 我方基地下一波还有几秒（dom 里基地也是复活点，占位永远可选）。
  // flagsView 为 null 清空容器（非 dom 模式与重生之后都落在这条路上 —— :empty 的容器
  // 整块塌掉，不留空框）。
  spawnSelect(flagsView, sel, baseCd) {
    const el = this._spSel || (this._spSel = document.getElementById('spawnSelect'));
    if (!el) return;
    let html = '';
    if (flagsView && flagsView.length) {
      // 基地（-1）与据点同规矩：**亲手选了才亮**（sel === i）。没有"默认选中"——
      // 不选不部署，等待画面里换装备不会被下一波拽走。
      const card = (name, mine, sub, i) => {
        const on = sel === i;
        return `<div class="sp-flag${on ? ' sel' : ''}${mine ? '' : ' dis'}" data-i="${i}"><b>${name}</b><span>${sub}</span></div>`;
      };
      html = `<div class="sp-hint">选择复活点（不选不部署）· 点击卡片或按 1/2/3 选据点 · 4 = 基地 · 再选一次取消</div>`
        + `<div class="sp-row">`
        + (baseCd != null ? card('基地', true, `下波 ${baseCd}s`, -1) : '')
        + flagsView.map((f, i) => card(f.name, f.mine, f.mine ? `下波 ${f.cd}s` : (f.label || '未占领'), i)).join('')
        + `</div>`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }

  // ── 顶部记分板的据点水圈（占领）──
  // 一次调用做两件事：**结构**变了（归属/争夺态/数量）才重建 DOM；水位与水色每拍
  // 直写 style。分开的原因：水位是"水"，靠 CSS transition 流动 —— 整条 scorebar 的
  // innerHTML 一重建（约 1Hz）元素就换了人，过渡断成跳变。所以 scorebar 的 html 里
  // 只放一个空的 #sbFlags 容器，水圈由这里养：scorebar 重建后元素身份变了（el !==
  // _fwEl）当场重建并立刻写回水位，肉眼看不出接缝。
  // view = [{ name, owner, cap, prog, contested, myT }]；view 为空清空容器。
  //   owner  —— 归属方：整圈的"底色水"（己方蓝 / 敌方红，未占领透明），边框与字母沿用旧色。
  //   cap    —— 正在占的队：从底部涨起来的"活水"，水位 = 占领进度。
  //   contested —— 两队同圈（僵持，进度冻结）：白圈脉冲 + 波浪加速，一眼看出"正在争"。
  flagWaters(view) {
    const el = document.getElementById('sbFlags');
    if (!el) { this._fwEl = null; return; }
    if (!view || !view.length) {
      if (this._fwEl) { el.innerHTML = ''; this._fwEl = null; this._fwSig = ''; this._fwNodes = null; }
      return;
    }
    const sig = view.map(v => `${v.name}:${v.owner || ''}:${v.contested ? 1 : 0}`).join('|');
    if (el !== this._fwEl || sig !== this._fwSig) {
      this._fwEl = el; this._fwSig = sig;
      el.innerHTML = view.map(v => {
        const own = v.owner === v.myT ? 'A' : v.owner ? 'B' : '';
        return `<div class="sb-flag ${own}${v.contested ? ' contested' : ''}">`
          + `<div class="sf-owner" style="height:${v.owner ? 100 : 0}%"></div>`
          + `<div class="sf-cap"></div><b>${escHtml(v.name)}</b></div>`;
      }).join('');
      this._fwNodes = [...el.querySelectorAll('.sf-cap')];
    }
    for (let i = 0; i < view.length; i++) {
      const n = this._fwNodes && this._fwNodes[i];
      if (!n) continue;
      const v = view[i];
      n.style.height = Math.round(clamp(v.prog || 0, 0, 1) * 100) + '%';
      const col = v.cap === v.myT ? 'var(--ally)' : v.cap ? 'var(--enemy)' : 'transparent';
      if (n._col !== col) { n._col = col; n.style.background = col; }
    }
  }

  drawMinimap() {
    const game = this.game, pl = game.player, world = game.world;
    const ctx = this.mm, S = 220, R = 45; // 显示半径（米）
    const scale = S / (R * 2);
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(20,24,20,.6)'; ctx.fillRect(0, 0, S, S);
    ctx.translate(S / 2, S / 2);
    ctx.rotate(pl.yaw);
    const k = world.topK;
    const sz = world.def.size * scale;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(world.topDown, (-pl.pos.x - world.half) * scale, (-pl.pos.z - world.half) * scale, sz, sz);
    ctx.globalAlpha = 1;
    const dot = (x, z, color, r = 4, tri = false, yaw = 0) => {
      const px = (x - pl.pos.x) * scale, pz = (z - pl.pos.z) * scale;
      ctx.save(); ctx.translate(px, pz);
      ctx.fillStyle = color;
      if (tri) { ctx.rotate(-yaw); ctx.beginPath(); ctx.moveTo(0, -r * 1.4); ctx.lineTo(r, r); ctx.lineTo(-r, r); ctx.closePath(); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); }
      ctx.restore();
    };
    // 目标点
    const mode = game.mode;
    if (mode && mode.flags) for (const f of mode.flags) {
      const px = (f.pos.x - pl.pos.x) * scale, pz = (f.pos.z - pl.pos.z) * scale;
      ctx.save(); ctx.translate(px, pz); ctx.rotate(-pl.yaw);
      ctx.fillStyle = f.owner === pl.team ? '#4fb4ff' : f.owner ? '#ff4a3d' : '#fff';
      // 弱占领圈（DOM_RADIUS_WEAK）：世界里刻意不画，这里的小地图虚线圆是它唯一的视觉。
      // 颜色跟着归属走，半径用与地图同一把 米→px 的换算（15m ≈ 37px）。
      ctx.setLineDash([3, 3]);
      ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, DOM_RADIUS_WEAK * scale, 0, 7); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, 7); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillText(f.name, 0, 1);
      ctx.restore();
    }
    if (mode && mode.minimapMarkers) for (const m of mode.minimapMarkers()) dot(m.x, m.z, m.color || '#ffb400', 5);
    const uav = mode && mode.uavActive && mode.uavActive(pl.team);
    for (const e of game.entities) {
      if (e === pl || !e.alive || !e.pos) continue;
      if (e.team === pl.team && !(mode && mode.ffa)) dot(e.pos.x, e.pos.z, '#4fb4ff', 3.5, true, e.yaw || 0);
      else {
        // 幽灵：敌方 UAV 照不见他（本地敌人是 Bot、没有技能，所以这一条只在联机里
        // 真正生效 —— 但过滤必须长在这里：小地图是两端共用的一张图）。开火亮点
        // （revealT）不受幽灵影响：那是他自己暴露的，不是 UAV 给的。
        const blind = uav && e.hasPerk && e.hasPerk('ghost');
        const show = (uav && !blind) || (e.revealT > 0);
        if (show) dot(e.pos.x, e.pos.z, '#ff3b30', 4);
      }
    }
    ctx.restore();
    // 玩家
    ctx.fillStyle = '#d4f24a';
    ctx.beginPath(); ctx.moveTo(S / 2, S / 2 - 8); ctx.lineTo(S / 2 + 6, S / 2 + 6); ctx.lineTo(S / 2 - 6, S / 2 + 6); ctx.closePath(); ctx.fill();
    // 视野锥
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.beginPath(); ctx.moveTo(S / 2, S / 2); ctx.lineTo(S / 2 - 70, 0); ctx.lineTo(S / 2 + 70, 0); ctx.closePath(); ctx.fill();
    if (uav) { ctx.strokeStyle = 'rgba(212,242,74,.6)'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, S - 2, S - 2); }
  }

  showScoreboard(v) {
    const el = $('scoreboard');
    if (!v) { el.classList.add('hidden'); return; }
    const mode = this.game.mode;
    if (!mode || !mode.scoreboardHTML) return;
    el.innerHTML = mode.scoreboardHTML();
    el.classList.remove('hidden');
  }
}
