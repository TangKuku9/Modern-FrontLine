// HUD / UI「界面不许说谎」判据。对应 docs/hud-ux-audit.md 三批：
//   第一批（P0）HU-01（连杀键位三处口径）· HU-02（联机死亡画面写着不存在的键）·
//     HU-04 + HU-21（reset 漏归位签名门与选点卡片）· HU-38（同一格文案三处各拼一遍）·
//     HU-03（掉线文案被 nowrap 裁掉）· HU-06 第一半（菜单键盘可达）。
//   第二批（P1）H=HU-07 血量数字 · I=HU-11 空仓 · J=HU-14 受击方向 · K=HU-09 越界指示 ·
//     L=HU-15 我方存活 · M=HU-08 常驻网络读数 · N=HU-12 连杀拒收回执 · O=HU-41 走人提示进聊天框 ·
//     Q=HU-13 连杀命中音。（**HU-10 曾在 K/P 两段有判据，2026-10-11 整条回退** —— 弹窗预警与
//     小地图记号实测效果不好，判据随之删除；P 段那个字母空着是有意的，别再往里塞别的东西。）
//   第三批（P2）S=HU-16 记分板两端同形 · T=HU-17 按住 Tab 的活刷 · U=HU-18 大房点名 ·
//     V=HU-19 冻结期间的读数 + HU-20 结算屏按钮说实话。
//     HU-17 那一半里"浏览器到底保不保活"不在这里 —— 进程内量不到，见 test/hud-keys.mjs 的 G 段。
//
// 这一层和 js/net/remote.mjs 那一族是同一个病：**全都不影响权威状态**，不崩不报错，
// 症状只有玩家看得出来 —— 照屏幕提示按键、叫出来的是别的连杀；某一格整局空白；
// 死亡画面让你按一个从不被读的键。所以量具必须量**到 DOM 的那根线**，
// 光量"源码里有没有那句话"证明的是文案，不是界面。
//
// 四条纪律（照 test/net-feel.mjs 的写法）：
//   ① 每条源码形状的判据都配**同文件反证臂**：把改掉的那一处按旧写法代回去，检查器必须
//      当场认出来（B5b / B6b / D3b / E5 / H4b / M2c / O4 / Q2b）。只在合成夹具上演的反证不算 ——
//      夹具能红不代表真文件里那把尺子在读真文件。
//   ② 量具先自证活着：A 段先证明假 DOM 的 innerHTML / textContent 计数器真的在数、class 集合
//      真的是集合、签名门在不 reset 时真的会跳过写。少了这一条，后面每一段"要写"的判据
//      都可能只是桩根本没接到 DOM。
//   ③ 前提写进判据：E 段先证服务端那道闸还在（requestRespawn 只在 respawnT ≤ 0.12s 认），
//      N 段先证 callStreak / onEvents 是本体，K 段先证 translate 真的记到了点上。
//   ④ 第二批优先**驱动真函数**：NetRoom.callStreak、NetClient.useStreak/onEvents/scoreboardHTML/
//      netStatusText、MPMatch.useStreak、Sentry.update 都是原方法（.call 在夹具上），不是抄一份
//      判断。形状判据（M8 / N6b / Q2）留给了驱动不起来的那几条，并在标签里写明。
//
// 无浏览器：js/hud.js 的 `$` 是**调用时**才读 document 的（`const $ = id => document.getElementById(id)`），
// 所以动态 import + import 之前换上按 id 记账的假元素表就够，不必起页面。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STREAK_KEYS, STREAK_KEY_LABELS, streakKeyLabel, streakSlotOf, streakKeyLabels, KILLSTREAKS } from '../js/data.js';
import { NetRoom } from '../server/room.mjs';

const R = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = p => readFileSync(resolve(R, p), 'utf8');

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  |  ' + extra : '')]);

// ───────────────────────── 假 DOM：innerHTML / textContent / classList 都记账 ─────────────────────────
// 第二批（P1）量的多数是 textContent 与 class —— 只数 innerHTML 的话，"读数没写上去"和
// "写上去但看不见"在这把尺子下长得一样。三类写都计数，A 段的自证才盖得住这一层。
const CTX = new Proxy({}, { get: () => () => { } });
function makeDom() {
  const els = new Map();
  const mk = id => {
    const rec = { writes: 0, texts: 0, html: '', text: '', cls: new Set(), kids: [], removed: 0, sets: 0 };
    const el = {
      id, __rec: rec, style: {}, dataset: {}, scrollTop: 0, scrollHeight: 0, value: '',
      classList: {
        add: (...n) => n.forEach(x => rec.cls.add(x)),
        remove: (...n) => n.forEach(x => rec.cls.delete(x)),
        contains: n => rec.cls.has(n),
        toggle: (n, on) => { const v = on === undefined ? !rec.cls.has(n) : !!on; if (v) rec.cls.add(n); else rec.cls.delete(n); return v; },
      },
      appendChild(c) { rec.kids.push(c); return c; },
      remove() { rec.removed++; },
      addEventListener() { }, setAttribute() { },
      querySelector: () => null, querySelectorAll: () => [], getContext: () => CTX,
      get children() { return rec.kids; },
      get firstChild() { return rec.kids[0] || null; },
      get lastChild() { return rec.kids[rec.kids.length - 1] || null; },
      get innerHTML() { return rec.html; },
      set innerHTML(v) { rec.writes++; rec.html = String(v); if (!v) rec.kids.length = 0; },
      get textContent() { return rec.text; },
      set textContent(v) { rec.texts++; rec.text = String(v); },
    };
    return el;
  };
  const get = id => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  return {
    rec: id => get(id).__rec,
    mk,
    doc: {
      getElementById: get, createElement: t => mk('dyn:' + t),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() { },
      documentElement: { clientWidth: 1920, clientHeight: 1080, style: {} }, body: mk('body'),
    },
  };
}
const { doc: DOM, rec, mk } = makeDom();
globalThis.document = DOM;
// js/mp.js 这一族在模块加载期就要 window/localStorage（第二批要直接驱动 MPMatch.useStreak
// 与 Sentry.update，不能只 grep 源码形状）。桩给最小的一份，与 test/net-feel.mjs 同一套做法。
globalThis.window = { addEventListener() { }, devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080, localStorage: { getItem: () => null, setItem() { } } };
globalThis.localStorage = globalThis.window.localStorage;

const { HUD } = await import('../js/hud.js');
const gameStub = () => ({
  player: null, mode: null, entities: [], camera: null, net: null, lock: null,
  audio: { say() { }, beep() { }, init() { } }, profile: { muted: [] }, saveProfile() { },
});

// ───────────────────────── A 段：量具自证 ─────────────────────────
const hud = new HUD(gameStub());
const SLOTS = [{ id: 'uav', ready: true, cost: 3 }, { id: 'cluster', ready: false, cost: 5 },
  { id: 'sentry', ready: false, cost: 6 }];

const w0 = rec('streaks').writes;
hud.streaks(SLOTS, 0);
const w1 = rec('streaks').writes;
hud.streaks(SLOTS, 0);
const w2 = rec('streaks').writes;
ok('A1【先决】计数器接得上：第一次调 streaks 真的写了一次 DOM', w1 === w0 + 1, `writes ${w0}→${w1}`);
ok('A2【先决】签名门真的在跳写：同一份内容第二次调**不写**（否则 C1 的"要写"永远绿）',
  w2 === w1, `writes=${w2}·期望仍是 ${w1}`);
ok('A3【自证】同一个 id 连写两次会计到 2（读数不是恒 0 或恒 1）',
  (() => { const e = DOM.getElementById('probe'); const a = e.__rec.writes; e.innerHTML = 'x'; e.innerHTML = 'y'; return e.__rec.writes - a === 2; })());
ok('A4【自证·第二批】textContent 同样在记账（血量数字、存活数这类读数走的是它）',
  (() => { const e = DOM.getElementById('probe2'); const a = e.__rec.texts; e.textContent = 'x'; e.textContent = 'y'; return e.__rec.texts - a === 2 && e.textContent === 'y'; })());
ok('A5【自证·第二批】classList 是真的：toggle 同名两次必须回到原状（否则 low/dry/warn 的判据恒绿）',
  (() => { const e = DOM.getElementById('probe3'); e.classList.toggle('low', true); const on = e.classList.contains('low'); e.classList.toggle('low', false); return on && !e.classList.contains('low'); })());

// ───────────────────────── B 段：HU-01 键位闭环 ─────────────────────────
ok('B0【先决】键位表非空、且不少于连杀槽位（把表清空不能换绿）',
  STREAK_KEYS.length >= 3 && STREAK_KEY_LABELS.length === STREAK_KEYS.length,
  `STREAK_KEYS=${JSON.stringify(STREAK_KEYS)}`);
for (let i = 0; i < 3; i++) {
  const p = { ['Digit' + streakKeyLabel(i)]: true };
  ok(`B1 槽位 ${i}：屏幕上写的键码按下去，叫出来的就是这个槽（闭环，不是抄两遍数字）`,
    streakSlotOf(p) === i, `label=${streakKeyLabel(i)}→slot=${streakSlotOf(p)}`);
  const q = { ['Digit' + (i + 3)]: true };                 // 旧播报的字面量 i + 3
  ok(`B2【反证臂·旧写法实算】照旧文案按 Digit${i + 3}，得到的**不是**槽 ${i}`,
    streakSlotOf(q) !== i, `Digit${i + 3}→slot ${streakSlotOf(q)}`);
}
ok('B3 投掷键 4 不落在任何连杀槽上（4 是切雷，HU-01 当年按下去丢出去一颗雷）',
  streakSlotOf({ Digit4: true }) === -1);
ok('B4 越界下标给空串而不是 "undefined" 字样', streakKeyLabel(99) === '' && streakKeyLabel(-1) === '');

const MENU_SRC = src('js/menu.js');
const hardcodedStreak = t => /<span class="kbd">5\/6\/7<\/span>连杀奖励|<b>5 \/ 6 \/ 7<\/b>连杀奖励/.test(t);
ok('B5 主菜单与设置那两份键位表都改从同一处派生（字面量 5/6/7 已不存在）',
  MENU_SRC.includes('streakKeyLabels(binds)') && MENU_SRC.includes('BIND_ACTIONS') && !hardcodedStreak(MENU_SRC));
ok('B5b【反证臂】把派生代回旧字面量，同一把尺子当场认出来',
  hardcodedStreak(MENU_SRC.replace("${streakKeyLabels(binds).join('/')}", '5/6/7')));
// HU-37 之后"派生"必须是从**当前绑定**派生，而不是从那份默认常量：留着默认表的抄本，
// 症状就是玩家改了键、屏上那张表还在写旧键（HU-01 那一族的换皮复发）。
ok('B5c 菜单层里不再留着一份默认键位表的抄本', !MENU_SRC.includes('STREAK_KEY_LABELS'));

const MP_SRC = src('js/mp.js'), NET_SRC = src('js/net/client.mjs');
const oldAnnounce = t => t.includes('按 [${i + 3}]');
// HU-37 把连杀键位做成可重绑之后，播报那一句必须吃**这一台当前的绑定**，
// 否则重绑的键在屏幕上仍写着旧数字 —— 那正是 HU-01 的原症状，换了个触发条件复发。
const ANN = '按 [${streakKeyLabel(i, bindsOf(this.game))}]';
ok('B6 单机与联机的就绪播报都走 streakKeyLabel，且吃的是当前绑定（`i + 3` 不许回潮）',
  MP_SRC.includes(ANN) && NET_SRC.includes(ANN) && !oldAnnounce(MP_SRC) && !oldAnnounce(NET_SRC));
ok('B6b【反证臂】把 mp.js 那一处代回 i + 3，检查器必须认得出',
  oldAnnounce(MP_SRC.replace(ANN, '按 [${i + 3}]')));
ok('B7 绑定侧也收成一处（snapshotInput 不再各写一份 Digit5/6/7 三元）',
  src('js/main.js').includes('streak: streakSlotOf(P, this.settings.binds)') && !src('js/main.js').includes('P.Digit5 ? 0 :'));
// HU-01 的闭环在重绑之后仍然成立：屏上写的数字喂回 streakSlotOf，回来的还是同一个槽。
ok('B8【HU-37×HU-01 闭环】1 号槽改绑 Digit8 ⇒ 数字跟着变 8，喂回去仍是 0 号槽，旧键 Digit5 不再算按下',
  (() => {
    const b = { streak1: ['Digit8'] };
    const l = streakKeyLabel(0, b);
    return l === '8' && streakSlotOf({ Digit8: true }, b) === 0 && streakSlotOf({ Digit5: true }, b) === -1
      && streakKeyLabels(b).join('/') === '8/6/7';
  })(), `label0=${streakKeyLabel(0, { streak1: ['Digit8'] })}`);
ok('B8b【反证臂】把 streakCodes 退回硬编码 Digit5/6/7（不读绑定），闭环当场断',
  (() => {
    const hard = i => String(i + 5);            // HU-01 修之前的那份"抄本"
    const b = { streak1: ['Digit8'] };
    return !(hard(0) === streakKeyLabel(0, b) && streakSlotOf({ Digit8: true }, b) === 0);
  })());

// ───────────────────────── C 段：HU-04 / HU-21 reset 归位 ─────────────────────────
hud.reset();
const w3 = rec('streaks').writes;
hud.streaks(SLOTS, 0);
const w4 = rec('streaks').writes;
ok('C1 上一局末次签名与新一局相同也要重画：reset 之后连杀槽写得回去（旧写法整局空白）',
  w4 === w3 + 1 && rec('streaks').html.includes('侦察无人机'), `writes ${w3}→${w4}`);
ok('C2 顺手钉住 HUD 那一格的键码 = 实际生效的键（槽位自绘同走 streakKeyLabel）',
  rec('streaks').html.includes(`[${streakKeyLabel(0)}]`), rec('streaks').html.slice(0, 44));

// C3~C5 是一条**泛化**的闸：不点名 _stkSig，而是"全文用过的签名门，reset 必须逐个归位"。
// 下次新加一条 `_xxSig` 忘了归位，量具直接点出是哪条 —— 规范立在失效模式那一层，不是语法那一层。
function bodyOf(text, headRe) {
  const m = headRe.exec(text);
  if (!m) return null;
  const from = text.indexOf('{', m.index);
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}
function missingSigs(hudSrc, resetBody) {
  const used = new Set([...hudSrc.matchAll(/this\._([A-Za-z0-9]*Sig)\b/g)].map(m => '_' + m[1]));
  const home = new Set([...String(resetBody || '').matchAll(/this\._([A-Za-z0-9]*Sig)\s*=/g)].map(m => '_' + m[1]));
  return [...used].filter(k => !home.has(k)).sort();
}
const HUD_SRC = src('js/hud.js');
const RESET_BODY = bodyOf(HUD_SRC, /\n {2}reset\(\) *\{/);
ok('C3【先决】函数体切分器框住了整个 reset（切早了会让对账变成"两边都空"的恒绿）',
  !!RESET_BODY && RESET_BODY.includes('_eqSig') && RESET_BODY.includes('chatLog'),
  `len=${RESET_BODY ? RESET_BODY.length : 'null'}`);
ok('C3b【先决】签名门集合非空（正则失灵不许当成通过）',
  new Set([...HUD_SRC.matchAll(/this\._([A-Za-z0-9]*Sig)\b/g)].map(m => m[1])).size >= 2);
ok('C4 每一条签名门都在 reset() 里归位（HU-04 的复发闸）',
  missingSigs(HUD_SRC, RESET_BODY).length === 0, `缺：${JSON.stringify(missingSigs(HUD_SRC, RESET_BODY))}`);
ok('C4b【反证臂·合成夹具】用两条只归位一条 ⇒ 必须点出漏的那条',
  (() => {
    const fake = 'x(){ this._aSig=1; }\n  reset() { this._aSig = undefined; }\n  y(){ this._bSig=2; }';
    return JSON.stringify(missingSigs(fake, bodyOf(fake, /\n {2}reset\(\) *\{/))) === '["_bSig"]';
  })());

hud.spawnSelect([{ name: 'A', mine: true, cd: 7 }], 0, 12);
const spHtml = rec('spawnSelect').html;
hud.reset();
ok('C5 复活点卡片跟着归位：上一局的卡片不许留在新局死亡画面上（HU-21，过去靠每拍覆盖兜住）',
  spHtml.includes('A') && rec('spawnSelect').html === '', `reset 后="${rec('spawnSelect').html}"`);

// ───────────────────────── D 段：HU-38 killerInfo 收成一处 ─────────────────────────
hud.killerInfo('<img src=x onerror=alert(1)>', 'm4', true);
const kHtml = rec('killerInfo').html;
ok('D1 呼号里的标签进 DOM 之前已转义，爆头那一格也在同一处拼',
  !kHtml.includes('<img') && kHtml.includes('&lt;img') && kHtml.includes('爆头'), kHtml.slice(0, 56));
hud.killerInfo(null, '', false, '你阵亡了');
ok('D2 自己了断那一支照旧用调用方给的文案（战役不说"自我击杀"）',
  rec('killerInfo').html === '你阵亡了', rec('killerInfo').html);
const CALLERS = ['js/main.js', 'js/mp.js', 'js/campaign.js'];
const bareRe = /getElementById\('killerInfo'\)\s*\.\s*innerHTML/;
const bare = CALLERS.filter(f => bareRe.test(src(f)));
ok('D3 三个调用点都不再自己拼 innerHTML（转义的责任只有一处）',
  bare.length === 0 && CALLERS.every(f => src(f).includes('hud.killerInfo(')), `还裸着的：${JSON.stringify(bare)}`);
ok('D3b【反证臂·同文件代回】mp.js 塞回旧的裸拼写法，检查器必须点名 js/mp.js',
  (() => {
    const patched = MP_SRC.replace("game.hud.killerInfo(killer && killer !== victim ? killer.name : null, weapon, head);",
      "document.getElementById('killerInfo').innerHTML = `被 <b>${killer.name}</b>`;");
    return bareRe.test(patched);
  })());

// ───────────────────────── E 段：HU-02 那句"按空格"到底能不能兑现 ─────────────────────────
// 客户端那句 requestRespawn 不是玩家的按钮，是"我这边倒计时走完了"的去抖确认：
// 服务端只在最后 0.12 秒认（提前部署是实打实的收益，闸门长在服务端，不靠客户端自觉）。
const req = NetRoom.prototype.requestRespawn;
ok('E0【先决】量的是服务端那道真闸门，不是这里抄的一份判断',
  typeof req === 'function' && req.length === 1, `fn=${typeof req}/${req && req.length}`);
const roomWith = (c, flags = null) => ({ clients: new Map([[7, c]]), matchOverSent: false, flags });
const deadC = t => ({ cid: 7, pl: { alive: false }, spawnFlag: null, respawnT: t });
ok('E1 还剩 2 秒时请求部署 ⇒ 服务端拒（"按空格提前部署"在联机里根本给不了，所以那句是谎）',
  req.call(roomWith(deadC(2)), 7) === false);
const c2 = deadC(2);
ok('E1b【先决】拒收不吞倒计时：respawnT 原样留着（清零就等于把人锁死在地上）',
  req.call(roomWith(c2), 7) === false && c2.respawnT === 2, `respawnT=${c2.respawnT}`);
ok('E2 到点前 0.05 秒请求 ⇒ 放行（这道闸的用途是去抖，不是拒人）',
  req.call(roomWith(deadC(0.05)), 7) === true);
ok('E3 占领模式全程等波 ⇒ 一律拒（个人倒计时那条路在 dom 里不存在）',
  req.call(roomWith(deadC(0), [{ name: 'A' }]), 7) === false);
const MAIN_SRC = src('js/main.js');
// 尺子量的是**赋给 respawnText 的那个字面量**，不是"文件里有没有这串字" ——
// HU-02 的修复注释本身就要引用旧文案来说明改了什么，按子串查会被自己的注释误伤。
const falseKeyPromise = t => /=\s*'按 \[空格\] 重新部署'/.test(t);
ok('E4 联机死亡画面不再把"按 [空格] 重新部署"赋给文案（这一条路从不读空格）',
  !falseKeyPromise(MAIN_SRC) && MAIN_SRC.includes("text = '正在部署…'"));
ok('E4b【先决】单机那份**仍然**真读空格（别把唯一兑现得了的那一处也改没了）',
  MP_SRC.includes('game.input.keys.Space'));
ok('E5【反证臂】把旧的那句赋值代回 main.js，同一把尺子必须认出来',
  falseKeyPromise(MAIN_SRC.replace("text = '正在部署…'", "text = '按 [空格] 重新部署'")));
ok('E6 改文案没顺手改时序：那一句去抖确认还在', MAIN_SRC.includes('this.net.requestRespawn()'));

// ───────────────────────── F 段：HU-03 掉线文案被裁 · HU-06 菜单键盘可达 ─────────────────────────
// 这一段是**源码形状**的判据，钉的是"接线在不在"，不是"键盘真的走得到每一项"。
// 后者要真浏览器（量 rect 与 focus 序列），已记在 docs/hud-ux-audit.md 的 HU-06 剩余里 ——
// 拿源码形状当"能用"的证据，正是本仓库反复写的那条：形状判据只兜底，不当证明。
const CSS_SRC = src('style.css');
const announceRule = (cssText) => {
  const m = /#announce\s*\{([^}]*)\}/.exec(cssText);
  return m ? m[1] : null;
};
const A_RULE = announceRule(CSS_SRC);
ok('F0【先决】认得出 #announce 那一条规则（切不到就别装"查过了"）', !!A_RULE, `len=${A_RULE ? A_RULE.length : 'null'}`);
ok('F1 掉线那一句不再被 nowrap 裁掉两端（改的是 max-width + 允许折行）',
  !/white-space:\s*nowrap/.test(A_RULE) && /max-width/.test(A_RULE), A_RULE.trim().slice(-46));
ok('F1b【反证臂】把 nowrap 代回同一条规则，尺子当场认出来',
  /white-space:\s*nowrap/.test(A_RULE.replace('max-width', 'white-space: nowrap; max-width')));
ok('F2 菜单里有可见焦点环（Tab 放开了却没有落点，等于没放）',
  /:focus-visible/.test(CSS_SRC) && /\.mbtn:focus-visible/.test(CSS_SRC));

const tabGuarded = t => /if \(e\.code === 'Tab' && this\.state === 'play' && !this\.paused\) e\.preventDefault\(\);/.test(t);
const tabBlocked = t => /if \(e\.code === 'Tab'\) e\.preventDefault\(\);/.test(t);
ok('F3 Tab 只在**打得正热**时拦（记分板用的就是它）；菜单与暂停屏交还给键盘导航',
  tabGuarded(MAIN_SRC) && !tabBlocked(MAIN_SRC));
ok('F3b【反证臂】代回"无条件拦 Tab"，同一把尺子必须认出来',
  (() => {
    const back = MAIN_SRC.replace("e.code === 'Tab' && this.state === 'play' && !this.paused", "e.code === 'Tab'");
    return tabBlocked(back) && !tabGuarded(back);
  })());
ok('F4 键盘名单与鼠标委托名单是同一份 KEYPICK（两份名单各长各的正是 HU-06 的病根）',
  /const KEYPICK = '[^']*\.mbtn[^']*'/.test(MENU_SRC)
  && MENU_SRC.includes("e.target.closest(KEYPICK)") && MENU_SRC.includes('this.keyify(root)')
  && MENU_SRC.includes('root.querySelectorAll(KEYPICK)'));
// picker 是覆盖层：自己 appendChild、不走 render()，所以 keyify 必须落在**它自己体内**。
const PICKER_BODY = bodyOf(MENU_SRC, /\n {2}picker\(/);
ok('F4b 覆盖层（选枪 / 选连杀那种 picker）也补了同一刀，就在挂载之后',
  !!PICKER_BODY && PICKER_BODY.includes('scr.appendChild(d);')
  && PICKER_BODY.indexOf('this.keyify(d);') > PICKER_BODY.indexOf('scr.appendChild(d);'),
  PICKER_BODY ? `append@${PICKER_BODY.indexOf('scr.appendChild(d);')} keyify@${PICKER_BODY.indexOf('this.keyify(d);')}` : 'picker 体没切到');
ok('F4b【反证臂·合成夹具】picker 里没补 keyify ⇒ 同一把尺子必须认出来',
  (() => {
    const fake = '\n  picker() { scr.appendChild(d); return d; }';
    const b = bodyOf(fake, /\n {2}picker\(/) || '';
    return !(b.includes('scr.appendChild(d);') && b.indexOf('this.keyify(d);') > b.indexOf('scr.appendChild(d);'));
  })());
ok('F5 Enter/空格 只给 <div> 那类合成 click：原生可激活元素与正在打字的表单字段都跳过',
  MENU_SRC.includes('/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(t.tagName)')
  && MENU_SRC.includes("/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)")
  && MENU_SRC.includes('e.preventDefault(); t.click();'));

// ═════════════════════════ 第二批：P1 对局内读数（HU-07/08/09/10/11/12/14/15/13/41）═════════════════════════
// 这一批的病全是"读数缺席或读数说谎"：不崩、不报错，只有玩家看得出来。所以判据一律量到
// DOM 那根线，或直接驱动**真函数**（服务端那道拒收闸、NetClient.onEvents、Sentry.update、
// MPMatch.useStreak 都是本体，不是抄一份判断）。
const HTML_SRC = src('index.html');
const SERVER_SRC = src('server/room.mjs');
const { NetClient } = await import('../js/net/client.mjs');
const { MPMatch, Sentry } = await import('../js/mp.js');
const { streakRejectText, streakNotReadyText } = await import('../js/data.js');

// 能跑完整 hud.update(dt) 的活体夹具。dt 取 1ms 且不归位那两个节流累加器 ⇒ 15Hz 的敌名扫
// 与 30Hz 的小地图都落在门外（那两格由 K 段直接驱动 drawMinimap）。
const mkPlayer = (o = {}) => Object.assign({
  alive: true, hp: 100, maxHp: 100, yaw: 0, sprinting: false, team: 'A', name: '我',
  pos: { x: 0, y: 0, z: 0 }, lethal: null, tactical: null,
  ws: {
    adsT: 1, nadeMode: null, cur: 0, slots: [{ id: 'm4' }, { id: 'm1911' }], currentSpread: () => 0,
    w: { mag: 30, reserve: 120, stats: { name: 'M4', mag: 30, type: 'rifle' } },
  },
}, o);
const mkHud = (pl = mkPlayer(), extra = {}) => {
  const game = Object.assign({
    player: pl, mode: null, entities: [], projectiles: [], net: null,
    camera: { quaternion: { x: 0, y: 0, z: 0, w: 1 } },   // 单位四元数：相机基向量 = 世界轴
    world: null, audio: { say() { }, beep() { }, init() { }, hit() { } },
    profile: { muted: [] }, saveProfile() { },
  }, extra);
  game.player.pos = Object.assign({ clone() { return { x: this.x, y: this.y, z: this.z }; } }, game.player.pos);
  const h = new HUD(game);
  h.reset();
  // reset() 把两个节流累加器给满（进对局第一拍就画小地图/敌名 —— 那是 C 段钉住的行为）。
  // 这里要让 update(0.001) 只跑弹药/血量那几格，所以手动清掉；小地图另有 K 段直接驱动。
  h.sweepT = 0; h.mmT = 0;
  h._game = game;
  const pops = [];
  h.popup = t => pops.push(t);
  return [h, game, pops];
};
const hudSpy = calls => ({
  popup: (...a) => calls.push(['popup', a]),
  announce: (...a) => calls.push(['announce', a]),
  chatLocal: (...a) => calls.push(['chatLocal', a]),
});
const el = id => DOM.getElementById(id);       // rec() 给的是账本，style 这类活字段在元素上

// ───────────────────────── H 段：HU-07 血量数字 ─────────────────────────
{
  const [h] = mkHud();
  h.setHealth(90, 100);
  ok('H1 血条上有数字了：90 就写 90，条也同步在 90%（HU-07 的症状是"只剩一根 5px 的条"）',
    rec('hpNum').text === '90' && el('healthFill').style.width === '90%',
    `数字="${rec('hpNum').text}"·条=${el('healthFill').style.width}`);
  const t1 = rec('hpNum').texts;
  h.setHealth(90, 100); h.setHealth(90, 100);
  ok('H2 同值不重写（这一格跑在 60Hz 模拟拍上，每拍写就是白掉帧）', rec('hpNum').texts === t1, `写次=${rec('hpNum').texts}`);
  h.setHealth(34.9, 100);
  const bothLow = rec('hpNum').cls.has('low') && rec('healthFill').cls.has('low');
  h.setHealth(35, 100);
  const noneLow = !rec('hpNum').cls.has('low') && !rec('healthFill').cls.has('low');
  ok('H3 条与数字同一个阈值判：34.9 一起红、35 一起不红（两套口径就会出"红条配白字"那种谎）',
    bothLow && noneLow, `34.9→${bothLow}·35→${noneLow}`);
  ok('H4 阈值只有一处：写死的 0.35 已从判定行里消失，条与数字共用 HP_LOW',
    /const HP_LOW = 0\.35/.test(HUD_SRC) && !/hpk < 0\.35/.test(HUD_SRC));
  ok('H4b【反证臂·同文件代回】把 low 的判定代回旧的字面量写法，尺子当场认出来',
    /hpk < 0\.35/.test(HUD_SRC.replace('k < HP_LOW', 'hpk < 0.35')));
  ok('H5 新的签名门都在 reset() 里归位（_hpSig 漏归位 = 新局第一拍不重画，正是 HU-04 那一族）',
    missingSigs(HUD_SRC, RESET_BODY).length === 0 && /_hpSig/.test(RESET_BODY),
    `缺：${JSON.stringify(missingSigs(HUD_SRC, RESET_BODY))}`);
}

// ───────────────────────── I 段：HU-11 空仓与"打光了" ─────────────────────────
{
  const [h, g, pops] = mkHud();
  g.player.ws.w.mag = 0; g.player.ws.w.reserve = 0;
  h.update(0.001);
  ok('I1 打光时 "/ 0" 有自己的颜色（HU-11：过去与 "/ 240" 同色同字号）',
    rec('ammoRes').text === '/ 0' && rec('ammoRes').cls.has('dry'),
    `"${rec('ammoRes').text}"·dry=${rec('ammoRes').cls.has('dry')}`);
  ok('I2 进入打光那一刻喊一次', pops.length === 1 && pops[0].includes('弹药用尽'), JSON.stringify(pops));
  h.update(0.001); h.update(0.001);
  ok('I2b 只喊一次：还打光时第二、三拍不再弹（每拍弹的话 2.2 秒的 popup 会连成常亮）', pops.length === 1);
  g.player.ws.w.reserve = 120; h.update(0.001);
  ok('I3 补上弹 dry 就撤（判据不许是"一旦红就永远红"）', !rec('ammoRes').cls.has('dry') && pops.length === 1);
  g.player.ws.w.reserve = 0; h.update(0.001);
  ok('I4 再打光还要再喊：边沿触发，不是整局一次', pops.length === 2, JSON.stringify(pops));
  ok('I4b 喊出来的键码是真的那把：[2] = slot2 = ws.switchTo(1)（HU-01 同一族病）',
    pops[1].includes('[2]') && src('js/player.js').includes('if (input.slot2) ws.switchTo(1)'), pops[1]);
  const [h2, g2, pops2] = mkHud();
  g2.player.ws.slots = [{ id: 'm4' }];
  g2.player.ws.w.mag = 0; g2.player.ws.w.reserve = 0;
  h2.update(0.001);
  ok('I5 配装里没有副武器时不写"按 [2] 换副武器"（按不动的键不许印在屏幕上）',
    pops2.length === 1 && !pops2[0].includes('按 [2]'), JSON.stringify(pops2));
  const [h3, g3, pops3] = mkHud();
  g3.player.lethal = { name: '破片手雷', count: 2 };
  g3.player.ws.nadeMode = { kind: 'lethal', id: 'frag' };
  h3.update(0.001);
  ok('I6 切出雷时那一格留空、也不打光（雷没有备弹，把空读数染红是说谎）',
    rec('ammoRes').text === '' && !rec('ammoRes').cls.has('dry') && pops3.length === 0,
    `"${rec('ammoRes').text}"`);
}

// ───────────────────────── J 段：HU-14 受击方向指示器 ─────────────────────────
{
  const [h] = mkHud();
  const src3 = (x, y, z) => {
    const p = { x, y, z };
    p.clone = () => src3(x, y, z);            // 真世界线上传的是 THREE.Vector3，这里要的是同一组方法
    p.copy = v => { p.x = v.x; p.y = v.y; p.z = v.z; return p; };
    return p;
  };
  h.damageFrom(src3(0, 0, -10));
  h.damageFrom(src3(0.5, 0, -10));            // 与上一条差约 2.9°：同一个方向
  ok('J1 同方向的两次受击合成一条（HU-14：过去每跳血新增一条弧，点射糊成一片白雾）',
    h.dmgDirs.length === 1, `条数=${h.dmgDirs.length}`);
  h.damageFrom(src3(10, 0, 0));               // 正东：差 90°，另起一条
  ok('J1b 不同方向照旧各算一条（去重不许把全部来向并成一条 —— 那等于把这格关掉）',
    h.dmgDirs.length === 2, `条数=${h.dmgDirs.length}`);
  h.dmgDirs[0].t = 0.5;
  h.damageFrom(src3(0, 0, -10));
  ok('J1c 合成是"把那条续满"，不是新画一条', h.dmgDirs.length === 2 && h.dmgDirs[0].t === 1.6, `t=${h.dmgDirs[0].t}`);
  for (let i = 0; i < 12; i++) h.damageFrom(src3(Math.sin(i * 1.7) * 20, 0, -Math.cos(i * 1.7) * 20));
  ok('J2 条数封顶（旧写法没有上限：能画多少画多少）', h.dmgDirs.length <= 4, `条数=${h.dmgDirs.length}`);
  h.dmgDirs.length = 0;
  const below = src3(0, -10, -10);            // 脚下、正前方 10 米来的那一枪
  h.damageFrom(below);
  h.update(0.001);
  const tr = h.dmgDirs[0].el.style.transform || '';
  ok('J3 屏幕角走相机基向量：脚下那一枪画在屏幕**下方**（π rad）',
    /rotate\(3\.1\d+rad\)/.test(tr), tr);
  ok('J3b【反证臂·旧算法实算】照旧式 atan2(dx,-dz)+yaw 算同一个点，得到的是 rotate(0rad) —— 屏幕正上方',
    Math.abs(Math.atan2(below.x - 0, -(below.z - 0)) + 0) < 0.01);
}

// ───────────────────────── K 段：HU-09 越界指示 ─────────────────────────
{
  const tr = [], sets = [];
  const ctx = new Proxy({}, {
    get: (t, k) => (...a) => { if (k === 'translate') tr.push(a); },
    set: (t, k, v) => { if (k === 'fillStyle') sets.push(v); return true; },
  });
  DOM.getElementById('minimap').getContext = () => ctx;
  const pl = mkPlayer();
  const ally = { alive: true, team: 'A', yaw: 0, pos: { x: 0, y: 0, z: -20 } };
  const [h, g] = mkHud(pl, { entities: [ally], world: { topK: 1, def: { size: 200 }, topDown: {} } });
  const S = 220, scale = S / 90, EDGE = S / 2 - 7;
  tr.length = 0; h.drawMinimap();
  const p1 = tr[1];
  ok('K1【先决】translate 记到了点上：中心一次 + 队友一次', tr.length === 2 && !!p1, JSON.stringify(tr));
  ok('K1b 45m 圈内的点照原样画（clamp 不许把所有人吸到圈沿）',
    Math.abs(Math.hypot(p1[0], p1[1]) - 20 * scale) < 0.01,
    `r=${Math.hypot(p1[0], p1[1]).toFixed(2)}·期望 ${(20 * scale).toFixed(2)}`);
  ally.pos.z = -100;
  tr.length = 0; h.drawMinimap();
  const p2 = tr[1];
  ok('K2 100m 外的队友收进圈沿（旧写法不 clamp：canvas 把点裁掉，"没人"和"人在北边 100 米"同形）',
    Math.abs(Math.hypot(p2[0], p2[1]) - EDGE) < 0.01, `r=${Math.hypot(p2[0], p2[1]).toFixed(2)}·圈沿=${EDGE}`);
  ok('K2b 收拢不改方向：仍在正北（px≈0、pz<0）', Math.abs(p2[0]) < 0.01 && p2[1] < 0, JSON.stringify(p2));
  ally.pos.z = -20;
  ok('K5 #mmLabel 有读数了（过去是死 DOM：HTML 里留了格子，JS 从不写）',
    rec('mmLabel').text === '半径 45m', rec('mmLabel').text);
  // HU-37 把 MM_SIZE 从 hud.js 搬进 js/settings.mjs：它现在是设置项的默认值、能在屏上调，
  // 而 index.html 那两个 canvas 属性必须仍然与它是同一个数 —— 对账的两边换了，钉的事没换。
  const SET_SRC = src('js/settings.mjs');
  const mmSize = +(SET_SRC.match(/export const MM_SIZE = (\d+)/) || [])[1];
  const canvasAttr = /<canvas id="minimap" width="(\d+)" height="(\d+)"/.exec(HTML_SRC);
  ok('K6 绘制尺寸与 <canvas> 的 width/height 是同一个数（抄两份的话一边画 220、一边裁 200）',
    !!canvasAttr && +canvasAttr[1] === mmSize && +canvasAttr[2] === mmSize, `settings.mjs=${mmSize}·html=${canvasAttr && canvasAttr[1]}`);
  ok('K6c【HU-36】hud.js 不许再自己抄一份尺寸：默认从 settings.mjs 取，绘制吃 this.mmSize（syncDisplay 落 canvas）',
    /import \{[^}]*\bMM_SIZE\b[^}]*\} from '\.\/settings\.mjs'/.test(HUD_SRC)
    && /const ctx = this\.mm, S = this\.mmSize/.test(HUD_SRC)
    && !/const MM_SIZE = \d+;/.test(HUD_SRC));
  const mmR = +(HUD_SRC.match(/const MM_RADIUS = (\d+)/) || [])[1];
  ok('K6b 标签上写的半径就是绘制用的那个数（"半径 45m"配一张 60m 的图是新的一种谎）',
    rec('mmLabel').text === `半径 ${mmR}m` && mmR === 45, `MM_RADIUS=${mmR}`);
}

// ───────────────────────── L 段：HU-15 我方存活读数 ─────────────────────────
{
  const ents = [
    { team: 'A', alive: true, pos: {} }, { team: 'A', alive: false, pos: {} }, { team: 'A', alive: true, pos: {} },
    { team: 'B', alive: true, pos: {} },
    { team: 'A', alive: true, pos: {}, isTurret: true },     // 哨戒机枪不是"人"
    { team: 'A', alive: true, pos: {}, targetable: false },  // 不可瞄准的物件也不算
  ];
  const [h] = mkHud(mkPlayer({ team: 'A' }), { entities: ents, mode: {} });
  h.teamReadout();
  ok('L1 我方存活读数写出来了（HU-15：过去"我方还剩几个人"只能在小地图上数点）',
    rec('teamAlive').text === '我方 2/3', rec('teamAlive').text);
  const t1 = rec('teamAlive').texts;
  h.teamReadout();
  ok('L2 同值不重写', rec('teamAlive').texts === t1);
  const [h2] = mkHud(mkPlayer({ team: 'A' }), { entities: ents, mode: { ffa: true } });
  h2.teamReadout();
  ok('L3 自由混战留空而不是写一个骗人的数（ffa 每人一支队，"我方还剩几个"这个问题不成立）',
    rec('teamAlive').text === '', rec('teamAlive').text);
  const [h3] = mkHud(mkPlayer({ team: 'A' }), { entities: [{ team: 'A', alive: true, pos: {} }], mode: {} });
  h3.teamReadout();
  ok('L3b 一个人的队不配叫"存活名单"（写 我方 1/1 是把玩家当新手）', rec('teamAlive').text === '');
  const squad = [{ team: 'A', alive: true, pos: {} }, { team: 'A', alive: true, pos: {} }];
  const [h4] = mkHud(mkPlayer({ team: 'A' }), { entities: squad, mode: {} });
  h4.teamReadout();
  const n4 = rec('teamAlive').text;
  squad[0].alive = false;                      // 阵亡一个
  h4.teamReadout();
  ok('L4 有人阵亡时数会变（写死一个数的话这一格就是装饰）',
    n4 === '我方 2/2' && rec('teamAlive').text === '我方 1/2', `${n4} → ${rec('teamAlive').text}`);
}

// ───────────────────────── M 段：HU-08 常驻网络读数 ─────────────────────────
{
  const cli = {
    cid: 1, rtt: 42.4, snaps: 812, pulls: 3, snapGap: 0.1, lost: null, team: 'A', ffa: false,
    scores: { A: 10, B: 5 }, board: { total: 1, rows: [{ cid: 1, name: '我', s: 10, k: 2, d: 1, a: 0, rank: 1 }] },
    // 脚注与常驻那一格必须调**同一个方法**，所以夹具里也给它同一个真函数（不是抄一份返回值）
    netStatusText() { return NetClient.prototype.netStatusText.call(this); },
    // 大房那一句（HU-18）同样是本体：夹具里抄一份文案的话 M2 量的就不是那张真表了。
    bigRoomCutText(rows) { return NetClient.prototype.bigRoomCutText.call(this, rows); },
    roster: new Map(), _sbNames: new Map(),
  };
  const line = NetClient.prototype.netStatusText.call(cli);
  ok('M1 常驻读数四件都有：ping / 抖动 / 快照份数 / 被拽回次数（HU-08 的病是"只有按住 Tab 才看得见"）',
    line === 'ping 42 ms · 抖动 0 ms · 快照 812 份 · 拽回 3 次', line);
  ok('M1b 抖动取的是既有的那份下行测量（_jitEma，单位秒）换算成 ms，不是这里新造的测量',
    NetClient.prototype.netStatusText.call({ rtt: 40, snaps: 1, pulls: 0, _jitEma: 0.0084 }) === 'ping 40 ms · 抖动 8 ms · 快照 1 份 · 拽回 0 次',
    NetClient.prototype.netStatusText.call({ rtt: 40, snaps: 1, pulls: 0, _jitEma: 0.0084 }));
  ok('M1c【命门·NaN 守卫】头几包 _jitEma 还不存在、一次拽回都没发生时不许印 "NaN"（与 net-feel AB 段同一族病）',
    NetClient.prototype.netStatusText.call({ rtt: 40, snaps: 1, _jitEma: undefined }) === 'ping 40 ms · 抖动 0 ms · 快照 1 份 · 拽回 0 次'
    && !/NaN/.test(NetClient.prototype.netStatusText.call({ rtt: 40, snaps: 1 })),
    NetClient.prototype.netStatusText.call({ rtt: 40, snaps: 1 }));
  const html = NetClient.prototype.scoreboardHTML.call(cli);
  ok('M2 记分板脚注与常驻那一格是**同一句**（两处各拼一遍正是 HU-38 的病根）',
    html.includes(`<div class="sbnet">${line}</div>`), html.slice(0, 64));
  const sbFooter = t => { const m = /<div class="sbnet">\$\{([^}]*)\}/.exec(t); return m ? m[1] : null; };
  ok('M2b 脚注取自 netStatusText()，不再自己拼一份', /netStatusText\(\)/.test(sbFooter(NET_SRC) || ''), sbFooter(NET_SRC));
  ok('M2c【反证臂·同文件代回】把"脚注自己拼 ping"代回去，同一把尺子当场认出来',
    !/netStatusText\(\)/.test(sbFooter(NET_SRC.replace('sbnet">${this.netStatusText()', 'sbnet">${`ping ${Math.round(this.rtt)} ms · 快照 ${this.snaps}') || '')));
  const warnGet = Object.getOwnPropertyDescriptor(NetClient.prototype, 'netStatusWarn').get;
  ok('M3 warn 态只说一件确定无疑的事：下行断了（lost 或超过 1 秒没快照）',
    warnGet.call({ lost: null, snapGap: 0.1 }) === false
    && warnGet.call({ lost: null, snapGap: 1.5 }) === true
    && warnGet.call({ lost: 'stale', snapGap: 0.1 }) === true);
  const [h] = mkHud();
  h._game.net = { netStatusText: () => line, netStatusWarn: false };
  h.netReadout();
  ok('M4 那一格真的写进 DOM 了（不是加了个方法没人调）', rec('netStat').text === line, rec('netStat').text);
  const n1 = rec('netStat').texts;
  h.netReadout();
  ok('M4b 同值不重写（rtt 一秒才测一次，每拍写就是每拍换一次文本节点）', rec('netStat').texts === n1);
  h._game.net = { netStatusText: () => 'ping 900 ms · 快照 812 份 · 拽回 9 次', netStatusWarn: true };
  h.netReadout();
  ok('M5 断线时那一格变色（有读数没有颜色，玩家还是不知道现在是好是坏）', rec('netStat').cls.has('warn'));
  const [h6] = mkHud();
  h6.netReadout();
  ok('M6 单机与战役那一格留空（那边没有 net，写 "ping 0 ms" 是新的一种谎）', rec('netStat').text === '');
  ok('M7 两格都挂在 update() 上（每拍驱动的是它们自己，不是只在记分板里才刷）',
    /this\.teamReadout\(\); this\.netReadout\(\);/.test(HUD_SRC));
  ok('M7b【反证臂】把这一行删掉 ⇒ 两个方法都成了死代码，尺子认得出',
    !/this\.teamReadout\(\); this\.netReadout\(\);/.test(HUD_SRC.replace('this.teamReadout(); this.netReadout();', '')));
  ok('M8 拽回次数只在纠正超过半个身位时才计（每包都涨的话这一格常亮成噪音）',
    /if \(r\.corrected > PULL_METRES\) this\.pulls = \(this\.pulls \|\| 0\) \+ 1;/.test(NET_SRC));
}

// ───────────────────────── N 段：HU-12 连杀被拒时的回执 ─────────────────────────
{
  ok('N0【先决】量的是服务端那条真拒收分支', typeof NetRoom.prototype.callStreak === 'function');
  const room = () => ({ streak: { calls: 0, accepted: 0, rejected: 0, byId: {}, why: [] }, matchOverSent: false, events: [] });
  const seat = slots => ({ cid: 7, pl: { pos: { x: 0, y: 0, z: 0 } }, book: { slots, progress: 0, take() { return null; } } });
  const r1 = room(), c1 = seat([{ id: 'cluster' }]);
  const o1 = NetRoom.prototype.callStreak.call(r1, c1, 0, { x: 900, z: 0 });
  ok('N1 集束落点超出上限 ⇒ 拒收、槽不消耗，而且回执**发给了本人**（过去只加读数，屏幕上一个字都不说）',
    o1 === null && r1.events.some(e => e.e === 'streakNope' && e.cid === 7 && e.why === 'target'), JSON.stringify(r1.events));
  const r2 = room(), c2 = seat([{ id: 'cluster' }]);
  NetRoom.prototype.callStreak.call(r2, c2, 0, { x: 100, z: 0 });
  ok('N2【反证臂】落点在 200m 之内不许报"太远"（判据不能是"按了就说远"）',
    r2.events.every(e => e.why !== 'target'), JSON.stringify(r2.events));
  ok('N2b 那一次是 take() 拿不到槽 ⇒ 报的是 slot 那一档', r2.events.some(e => e.why === 'slot'), JSON.stringify(r2.events));
  const r3 = room(), c3 = seat([{ id: 'uav' }]);
  NetRoom.prototype.callStreak.call(r3, c3, 0, null);
  ok('N3 非集束槽没有落点这一说 ⇒ 不许冒"太远"那句话', r3.events.every(e => e.why !== 'target'), JSON.stringify(r3.events));

  const p4 = [], cli4 = {
    streakState: [{ id: 'uav', ready: false, cost: 5 }], streakDefs: [{ name: '侦察无人机' }], streakProgress: 2,
    game: { hud: { popup: t => p4.push(t), announce: t => p4.push('ANNOUNCE:' + t) } },
  };
  ok('N4 联机按了没就绪的槽：屏幕上说得出"还差几杀"，且仍返回 false（上行照旧，服务端的 rejected 读数仍诚实）',
    NetClient.prototype.useStreak.call(cli4, 0) === false && p4.length === 1 && p4[0] === '侦察无人机 还差 3 杀', JSON.stringify(p4));
  ok('N4a 那句话走 popup 不走 announce（p4 里没有 ANNOUNCE: 前缀的那一条）',
    p4.every(t => !t.startsWith('ANNOUNCE:')));
  const p5 = [], cli5 = {
    streakState: [{ id: 'uav', ready: true, cost: 5 }], streakDefs: [{ name: '侦察无人机' }], streakProgress: 9,
    game: { hud: { popup: t => p5.push(t), announce: () => { } } },
  };
  ok('N4b 就绪的非集束槽不喊（它走服务端那条路，本地闭嘴是对的）',
    NetClient.prototype.useStreak.call(cli5, 0) === false && p5.length === 0);
  const p6 = [], cli6 = {
    streakState: [{ id: 'cluster', ready: true, cost: 5 }], streakDefs: [{ name: '集束空袭' }], streakProgress: 9,
    game: { hud: { popup: t => p6.push(t), announce: () => { } } }, confirmShot: false,
  };
  ok('N4c 就绪的集束槽进选点、不喊（返回 true = 这一拍的上行不带呼叫）',
    NetClient.prototype.useStreak.call(cli6, 0) === true && p6.length === 0);
  const p7 = [];
  MPMatch.prototype.useStreak.call({
    streakState: [{ id: 'uav', ready: false, cost: 5 }], streakBook: { progress: 1 },
    game: { hud: { popup: t => p7.push(t) } },
  }, 0);
  ok('N5 单机那一条路说的是同一句话（文案共查 js/data.js 那张表，两端不各写一份）',
    p7.length === 1 && p7[0] === '侦察无人机 还差 4 杀', JSON.stringify(p7));
  ok('N5b need ≤ 0 时换成"还没就绪"（负数与 0 都不该印在屏幕上）',
    streakNotReadyText('侦察无人机', 0) === '侦察无人机 还没就绪'
    && streakNotReadyText('侦察无人机', -3) === '侦察无人机 还没就绪');
  ok('N6 语义码在客户端有对应文案（发了没人认的码 = 又是一条"按了没反应"）',
    streakRejectText('target') === '空袭落点太远 · 请重新选点'
    && streakRejectText('slot') === '槽位状态已变 · 再按一次'
    && streakRejectText('no-such-code') === '呼叫未被接受');
  ok('N6b【先决】服务端只发**语义码**，不发成品文案（与 room.mjs 里那句"语义下发"同一条约定）',
    !/streakNope[^}]*text:/.test(SERVER_SRC) && /why: 'target'/.test(SERVER_SRC) && /why: 'slot'/.test(SERVER_SRC));

  const c7 = [], cli7 = { cid: 7, team: 'A', events: [], game: { hud: hudSpy(c7) } };
  NetClient.prototype.onEvents.call(cli7, { ev: [{ e: 'streakNope', cid: 7, why: 'target' }] });
  ok('N7 拒收回执走 popup 那一档，不走 30px 居中的 announce（弹窗是战场上的事）',
    c7.length === 1 && c7[0][0] === 'popup' && c7[0][1][0] === '空袭落点太远 · 请重新选点', JSON.stringify(c7));
  const c8 = [], cli8 = { cid: 7, team: 'A', events: [], game: { hud: hudSpy(c8) } };
  NetClient.prototype.onEvents.call(cli8, { ev: [{ e: 'streakNope', cid: 8, why: 'target' }] });
  ok('N7b 别人那一次拒收不许出现在我屏幕上（槽位表是每人一份的）', c8.length === 0, JSON.stringify(c8));
}

// ───────────────────────── O 段：HU-41 走人提示改进左下角聊天框 ─────────────────────────
{
  const mk = (cid, calls, roster) => ({
    cid, team: 'A', events: [], roster: roster || new Map(), remotes: new Map(), leaving: [],
    beginLeave() { }, game: { hud: hudSpy(calls) },
  });
  const c1 = [], cli1 = mk(7, c1, new Map([[8, { name: '张三' }]]));
  NetClient.prototype.onEvents.call(cli1, { ev: [{ e: 'leave', cid: 8 }] });
  ok('O1 走人那条落在左下角聊天框里（HU-41，用户指定：这类提示与聊天同档）',
    c1.some(c => c[0] === 'chatLocal' && c[1][0] === '张三 离开了对局'), JSON.stringify(c1));
  ok('O1b 屏幕中心那一格没被叫到（连着走人 = 连着几条 30px 大字盖住战场，正是原症状）',
    !c1.some(c => c[0] === 'announce'), JSON.stringify(c1));
  const c2 = [], cli2 = mk(7, c2, new Map([[7, { name: '我' }]]));
  NetClient.prototype.onEvents.call(cli2, { ev: [{ e: 'leave', cid: 7 }] });
  ok('O2 自己退局不算（名单都没了，不该给自己发一条"我离开了对局"）', c2.length === 0, JSON.stringify(c2));
  const c3 = [], cli3 = mk(7, c3);
  NetClient.prototype.onEvents.call(cli3, { ev: [{ e: 'leave', cid: 9 }] });
  ok('O2b 名单里查无此人 ⇒ 什么都不说（这条本来就该静默，别顺手补出一句"一名玩家"）', c3.length === 0);
  const [h] = mkHud();
  const a0 = rec('announce').writes;
  h.chatLocal('张三 离开了对局');
  ok('O3 聊天条那一档确实写进 #chatLog，并把收起的框亮起来（喊个没人接的方法不算修好）',
    rec('chatLog').html.includes('张三 离开了对局') && !rec('chatBox').cls.has('hidden'), rec('chatLog').html.slice(0, 60));
  ok('O3b 同一路径没碰 #announce（大字与聊天条是两格，判据要分开量）', rec('announce').writes === a0);
  ok('O4【反证臂·同文件代回】把 announce 那一档代回 leave 分支，尺子当场认出来',
    /hud\.announce\(\(who\.name \|\| '一名玩家'\)/.test(NET_SRC.replace("hud.chatLocal((who.name || '一名玩家')", "hud.announce((who.name || '一名玩家')")));
  const cj = [], cliJ = mk(7, cj, new Map([[8, { name: '张三' }]]));
  cliJ.setStreakSlot = () => { };
  NetClient.prototype.onEvents.call(cliJ, { ev: [{ e: 'join', cid: 8, name: '张三', team: 'B', perks: [] }] });
  ok('O5 join 那侧仍然什么都不说（HU-05 的更正：join 只在名单成型那批到，加了就是开局刷屏）',
    cj.length === 0, JSON.stringify(cj));
}

// ───────────────────────── Q 段：HU-13 连杀击杀的命中音 ─────────────────────────
{
  const seen = [];
  const stub = () => ({
    headless: true,
    scene: { add() { }, remove() { } },
    world: { raycast: () => null, groundHeight: () => 0, lineBlocked: () => false },
    entities: [],
    effects: { muzzle() { }, tracer() { }, blood() { }, impact() { }, explosion() { } },
    audio: { shot() { }, explosion() { }, hit: (...a) => seen.push(['hit', a]) },
    hud: { popup() { }, hitmarker: (...a) => seen.push(['marker', a]) },
  });
  const victim = {
    alive: true, team: 'B', pos: { x: 0, y: 0.8, z: -5 },
    chestPos(o) { return o.set(0, 0.8, -5); },
    hitTest() { return { t: 5, part: 'body' }; },
    takeDamage() { return true; },                  // 这一梭子里的那一发打死人了
  };
  const gunPos = { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } };
  const owner = { team: 'A', isPlayer: true, yaw: 0 };
  const g = stub(); g.entities.push(victim);
  new Sentry(g, gunPos, owner).update(0.016);
  const marker = seen.find(v => v[0] === 'marker'), hit = seen.find(v => v[0] === 'hit');
  ok('Q1【真驱动】哨戒机枪打死人：准星上有叉，耳朵里也要有一声（跑的是 Sentry.update 本体）',
    !!marker && !!hit && marker[1][0] === true && hit[1][0] === true, JSON.stringify(seen));
  const before = seen.length;
  const gm = stub(); gm.entities.push(Object.assign({}, victim, { takeDamage() { return false; } }));
  new Sentry(gm, gunPos, owner).update(0.016);
  ok('Q1b 没打死也要有命中音（漏掉的那一类是"打中了但不死"，玩家同样以为枪哑了）',
    seen.slice(before).some(v => v[0] === 'hit' && v[1][0] === false), JSON.stringify(seen.slice(before)));
  const markerLines = [...MP_SRC.matchAll(/game\.hud\.hitmarker\([^)]*\);/g)];
  const unpaired = markerLines.filter(m => !/game\.audio\.hit\(/.test(MP_SRC.slice(m.index, m.index + 120)));
  ok('Q2c【先决】配对检查真的认得出那两处（正则失灵就等于这条恒绿）',
    markerLines.length === 2, `处数=${markerLines.length}`);
  ok('Q2 mp.js 里每一处 hitmarker 都紧跟着 audio.hit（直升机那一处与哨戒机枪同族，形状闸兜住"以后又漏一条"）',
    unpaired.length === 0, `未配对：${unpaired.length}`);
  ok('Q2b【反证臂·同文件代回】把直升机那一处的 audio.hit 摘掉，同一把尺子当场认出来',
    (() => {
      const back = MP_SRC.replace("game.hud.hitmarker(res.killed); game.audio.hit(res.killed, res.part === 'head');", 'game.hud.hitmarker(res.killed);');
      return [...back.matchAll(/game\.hud\.hitmarker\([^)]*\);/g)].some(m => !/game\.audio\.hit\(/.test(back.slice(m.index, m.index + 120)));
    })());
}

// ───────────────────────── S 段：HU-16 记分板两端同形 ─────────────────────────
// 两端各自的**真** scoreboardHTML 喂两套夹具：单机的行对象形状来自 MPMatch.ranking()
// （player 走 stats.*、Bot 走扁字段），联机的来自服务端 pushBoard 的行。判据量的是
// "同一份表形状"，不是"两份代码看起来差不多"。
const SB_SRC = src('js/scoreboard.mjs');
{
  const ths = t => [...t.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
  // 按表拆：队名写在"名字"那一格的表头里，那是**各端各自的文案**（联合特遣队 / 我方），
  // 同形要量的是列，不是队名。
  const tablesOf = t => t.split('</table>').filter(x => x.includes('<table'));
  const shapeOf = t => JSON.stringify(tablesOf(t).map(x => ths(x).map((c, i) => (i === 1 ? '' : c))));
  const plain = s => s.replace(/<[^>]*>/g, '');
  const cells = t => [...t.matchAll(/<tr class="[^"]*">([\s\S]*?)<\/tr>/g)]
    .map(m => [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map(x => x[1]));
  const pl = { name: '我', team: 'A', isPlayer: true, alive: true, stats: { kills: 7, deaths: 2, score: 900, assists: 3, captures: 2 } };
  const b1 = { name: '甲', team: 'A', alive: false, kills: 5, deaths: 4, score: 600, captures: 1 };
  const b2 = { name: '乙', team: 'B', alive: true, kills: 3, deaths: 6, score: 400, captures: 0 };
  const b3 = { name: '丙', team: 'B', alive: true, kills: 1, deaths: 0, score: 100, captures: 0 };
  const mkMp = (who) => {
    const m = Object.create(MPMatch.prototype);
    m.game = { player: pl, bots: who || [b1, b2, b3] }; m.ffa = false; m.scores = { A: 900, B: 400 };
    return m.scoreboardHTML();
  };
  const mkNet = (rows, total) => {
    const c = Object.create(NetClient.prototype);
    Object.assign(c, {
      cid: 1, team: 'A', ffa: false, scores: { A: 900, B: 400 }, roster: new Map(), _sbNames: new Map(),
      netStatusText: () => 'ping 40 ms', board: { total: total == null ? rows.length : total, rows },
    });
    return c.scoreboardHTML();
  };
  const NET_ROWS = [
    { cid: 1, name: '我', team: 'A', s: 900, k: 7, d: 2, a: 3, rank: 1, alive: true },
    { cid: 2, name: '甲', team: 'A', s: 600, k: 5, d: 4, a: 1, rank: 2, alive: false },
    { cid: 3, name: '乙', team: 'B', s: 400, k: 3, d: 6, a: 0, rank: 3, alive: true },
  ];
  const mpHtml = mkMp([b1, b2]);
  const netHtml = mkNet(NET_ROWS);
  const COLS = ['#', '名字', '得分', '击杀', '死亡', 'K/D', '助攻', '占领'];
  const SHAPE = JSON.stringify([COLS.map((c, i) => (i === 1 ? '' : c)), COLS.map((c, i) => (i === 1 ? '' : c))]);
  ok('S1 两端的表形状逐格相等：两张表、八列、列名同序（HU-16 的病根就是两份拼接代码）',
    shapeOf(mpHtml) === SHAPE && shapeOf(netHtml) === SHAPE,
    `单机=${shapeOf(mpHtml)}·联机=${shapeOf(netHtml)}`);
  ok('S2 名次是独立的一列：单机过去把它塞在名字格里（`1. 张三`），现在第一格只有数、名字格里没有编号前缀',
    cells(mpHtml)[0][0] === '1' && cells(mpHtml)[0][1].startsWith('我') && !/^\s*\d+[.、]/.test(cells(mpHtml)[0][1]),
    JSON.stringify(cells(mpHtml)[0]));
  ok('S2c 分队那两张表的名次是**全榜**位次（联机那侧的 rank 由服务端按全房排；旧写法每张表各从 1 数起）',
    (() => {
      const r = cells(mkMp([b1, b2, { ...b2, name: '丁', team: 'B', kills: 6 }])).map(x => x[0]);
      return JSON.stringify([...r].sort()) === JSON.stringify(['1', '2', '3', '4']);
    })(), JSON.stringify(cells(mkMp([b1, b2, { ...b2, name: '丁', team: 'B', kills: 6 }])).map(x => x[0])));
  ok('S2b 每一行的格数与表头一样多（少一格 = 整行读错位，而它不会报错）',
    [...cells(mpHtml), ...cells(netHtml)].every(r => r.length === COLS.length),
    `行=${JSON.stringify(cells(mpHtml).map(r => r.length))}/${JSON.stringify(cells(netHtml).map(r => r.length))}`);
  // 助攻=6、占领=7：这两列在两端各缺一本账，缺的那一格必须是 '-'。
  ok('S3 单机 Bot 的助攻**没有账本** ⇒ 落 \'-\' 而不是 0（ai.js 只建了 captures；补那本账要动伤害记账=规则侧）',
    cells(mpHtml)[1][6] === '-' && cells(mpHtml)[0][6] === '3', JSON.stringify(cells(mpHtml)[1]));
  ok('S3b 联机的占领**没有账本** ⇒ 同一列落 \'-\'（服务端占点只加 200 分、不计数，补它=账本+协议字段，越界）',
    cells(netHtml)[0][7] === '-' && cells(mpHtml)[0][7] === '2', JSON.stringify(cells(netHtml)[0]));
  ok('S3c【自证】0 与"量不出来"确实长得不一样：有账且为零 ⇒ 写 0',
    cells(mpHtml)[2][7] === '0' && cells(mpHtml)[1][7] === '1', JSON.stringify(cells(mpHtml)[2]));
  ok('S4 K/D 与结算面板同一把尺（`k / Math.max(1, d)`），同一屏不许两处各算一份',
    cells(mpHtml)[0][5] === (7 / Math.max(1, 2)).toFixed(2) && cells(netHtml)[0][5] === cells(mpHtml)[0][5],
    `${cells(mpHtml)[0][5]} vs ${cells(netHtml)[0][5]}`);
  const zeroDeath = mkMp([b1, b2, { ...b3 }]);
  ok('S4b 一场没死 ⇒ K/D 是 1.00 那种数，不是 Infinity/NaN（结算面板那条式子的行为，界面上不许漏出除零）',
    cells(zeroDeath).some(r => r[5] === '1.00') && !/Infinity|NaN/.test(zeroDeath),
    JSON.stringify(cells(zeroDeath).map(r => r[5])));
  const EVIL = '<img src=x onerror=alert(1)>';
  const evilMp = mkMp([{ ...b1, name: EVIL }]);
  const evilNet = mkNet([{ ...NET_ROWS[1], name: EVIL }]);
  ok('S5 呼号进 DOM 之前转义，而且两端过的是**同一处** escHtml（联机那条 M10 判据现在由共用处兜住）',
    !evilMp.includes('<img') && evilMp.includes('&lt;img') && !evilNet.includes('<img') && evilNet.includes('&lt;img'),
    evilMp.slice(0, 60));
  ok('S6 榜首那一枚只落在名次第一那一行：单机取 ranking() 的第一、联机取服务端排好的 rank',
    cells(mpHtml).filter(r => r[1].includes('sb-mvp')).length === 1 && cells(mpHtml)[0][1].includes('sb-mvp')
    && cells(netHtml)[0][1].includes('sb-mvp') && !cells(netHtml)[1][1].includes('sb-mvp'),
    JSON.stringify(cells(netHtml).map(r => r[1])));
  ok('S6b 那一枚写的是"榜首"，渲染出来的串里不许出现 MVP：这一仓库里没有发奖的裁决（HU-01 同族）',
    mpHtml.includes('榜首') && !/MVP/.test(mpHtml + netHtml), mpHtml.match(/<i[^>]*>[^<]*<\/i>/)?.[0]);
  const thBuilder = t => /<th/.test(t);
  const dup = ['js/mp.js', 'js/net/client.mjs'].filter(f => thBuilder(src(f)));
  ok('S7 玩家榜单的表头只有一处在拼：js/mp.js 与 js/net/client.mjs 里再出现 `<th` 就是 HU-16 复发',
    dup.length === 0, JSON.stringify(dup));
  ok('S7b【先决·合成夹具】把单机旧那份表头拼法塞回尺子，同一个判据当场命中（正则失灵=上面那条恒绿）',
    thBuilder('<table class="sbt A"><tr><th>联合特遣队</th><th>得分</th></tr></table>') && SB_SRC.includes('<th'),
    '合成串里有 <th ⇒ 必须判成"有人在拼第二份"');
}

// ───────────────────────── T 段：HU-17 按住 Tab 期间榜单自己活着 ─────────────────────────
// 手动排程的假定时器：这一份量的是"过了 500 ms 之后重画没重画"，等真时间会把整套判据
// 变成秒级抖动。被测对象仍是 HUD 本体的 showScoreboard（不是抄的一份判断）。
{
  const timers = new Map(); const alarms = new Map(); let nid = 1;
  const REAL = { si: globalThis.setInterval, ci: globalThis.clearInterval, st: globalThis.setTimeout, ct: globalThis.clearTimeout };
  const fire = (n = 1) => { for (let i = 0; i < n; i++) for (const t of [...timers.values()]) t.f(); };
  try {
    globalThis.setInterval = (f) => { const k = nid++; timers.set(k, { f }); return k; };
    globalThis.clearInterval = k => timers.delete(k);
    globalThis.setTimeout = (f, ms) => { const k = nid++; alarms.set(k, { f, ms }); return k; };
    globalThis.clearTimeout = k => alarms.delete(k);
    const [h, g] = mkHud();
    let v = 0;
    g.mode = { scoreboardHTML: () => `<table class="sbt A"><tr class="me"><td>${++v}</td></tr></table>` };
    const w0 = rec('scoreboard').writes;
    h.showScoreboard(true);
    ok('T1【先决】按下那一下画了一次，并且**留下了一条重画路径**（旧写法画完就不管了）',
      rec('scoreboard').writes === w0 + 1 && timers.size === 1, `writes=${rec('scoreboard').writes}·timers=${timers.size}`);
    fire(2);
    ok('T2 数据变了、时间到了 ⇒ 不必重新按键，榜自己跟上（HU-17 的症状是"冻在按下那一刻的数据上"）',
      rec('scoreboard').writes === w0 + 3 && rec('scoreboard').html.includes('<td>3</td>'),
      `writes=${rec('scoreboard').writes}·html=${rec('scoreboard').html}`);
    h.showScoreboard(false);
    ok('T3 松开就拆表：定时器清零，之后数据再怎么变都不写（漏掉这句就是隐藏面板每 0.5 s 白烧一次）',
      timers.size === 0, `残留 timers=${timers.size}`);
    const wOff = rec('scoreboard').writes;
    fire(3);
    ok('T3b 松开之后那一屏真的停了（writes 一条不涨）', rec('scoreboard').writes === wOff, `+${rec('scoreboard').writes - wOff}`);
    const [h2, g2] = mkHud();
    g2.mode = { scoreboardHTML: () => '<table class="sbt A"><tr class="me"><td>固定</td></tr></table>' };
    h2.showScoreboard(true);
    const wFix = rec('scoreboard').writes;
    fire(5);
    ok('T4 签名门在：内容没变 ⇒ 一行 DOM 都不写（这条重画路径挂在按住不放上，没门就是每 0.5 s 白拆一次表）',
      rec('scoreboard').writes === wFix, `写次=${rec('scoreboard').writes - wFix}`);
    h2.showScoreboard(false);
    const [h3, g3] = mkHud();
    g3.mode = { scoreboardHTML: () => '<table class="sbt A"><tr class="me"><td>x</td></tr></table>' };
    h3.showScoreboard(true); h3.showScoreboard(true); h3.showScoreboard(true);
    ok('T5 反复按下不许叠出多条重画路径（keydown 沿抖三抖就是三个定时器同时往同一格写）',
      timers.size === 1, `timers=${timers.size}`);
    h3.reset();
    ok('T5b reset() 把这条定时器一并归位（上一局的榜单不许在新局里继续刷 —— 与 HU-21 同一族）',
      timers.size === 0, `残留 timers=${timers.size}`);
    const SB_BODY = bodyOf(HUD_SRC, /\n {2}showScoreboard\(/);
    ok('T6 装定时器之前先拆旧的（形状闸：漏了 clearInterval 的话 T5 只在"新建实例"上才绿）',
      /clearInterval\(this\._sbT\)/.test(SB_BODY || '') && SB_BODY.indexOf('clearInterval') < SB_BODY.indexOf('setInterval'),
    SB_BODY ? SB_BODY.slice(0, 60).replace(/\n/g, ' ') : '找不到 showScoreboard 的函数体');
    ok('T6b【反证臂·同文件代回】把那句 clearInterval 摘掉，同一把尺子当场认出来',
      !/clearInterval\(this\._sbT\)/.test(SB_BODY.replace('clearInterval(this._sbT); this._sbT = 0;', '')));
  } finally {
    Object.assign(globalThis, { setInterval: REAL.si, clearInterval: REAL.ci, setTimeout: REAL.st, clearTimeout: REAL.ct });
  }
}

// ───────────────────────── U 段：HU-18 大房点名 ─────────────────────────
// 驱动的是 NetClient.prototype.bigRoomCutText 本体：分母、点名的次序、上限、静默条件
// 都是它自己的判断，不是这里替它算一遍。
{
  const mk = ({ total, inFrame, roster = [], seen = [] }) => {
    const c = Object.create(NetClient.prototype);
    c.cid = 1; c.team = 'A';
    c.board = { total, rows: inFrame };
    c.roster = new Map(roster);
    c._sbNames = new Map(seen);
    return c.bigRoomCutText(inFrame);
  };
  const rows16 = Array.from({ length: 16 }, (_, i) => ({ cid: i + 1, name: 'R' + (i + 1), team: i % 2 ? 'A' : 'B', rank: i + 1, s: 100 - i, k: 9, d: 3, a: 1, alive: true }));
  const t = mk({
    total: 40, inFrame: rows16,
    roster: [[30, { name: '张三', team: 'A' }], [31, { name: '李四', team: 'A' }], [32, { name: '王五', team: 'B' }]],
    seen: [[77, { name: '哨戒Bot', team: 'A' }]],
  });
  ok('U1 分母是全房人数、不是裁剪后的行数（旧那句"榜上 N 人"读起来像房就这么点人）',
    t.includes('全房 40 人') && t.includes('榜上 16 行'), t);
  ok('U2 看不见的到底是谁：本队那两个点得出名，而且排在敌队前面（HU-18 的症状是"队友死活看不见又不知道是谁"）',
    t.indexOf('张三') < t.indexOf('王五') && t.includes('李四'), t);
  ok('U2b 只在前一班出现过的那一行（Bot 的名字本地只能从行表里认）也点得到',
    t.includes('哨戒Bot'), t);
  ok('U3 名字有上限：超过五个收成"等 N 人"，不许把整间房的小字铺满一屏',
    (() => {
      const many = mk({ total: 60, inFrame: rows16, roster: Array.from({ length: 20 }, (_, i) => [200 + i, { name: 'N' + i, team: 'A' }]) });
      return /等 20 人/.test(many) && (many.match(/N\d+/g) || []).length <= 5;
    })(), mk({ total: 60, inFrame: rows16, roster: Array.from({ length: 20 }, (_, i) => [200 + i, { name: 'N' + i, team: 'A' }]) }).slice(-46));
  ok('U4 榜上齐了 ⇒ 这一句整个不给（凭空多一行"没上榜的："是噪音，不是读数）',
    mk({ total: 16, inFrame: rows16, roster: [[30, { name: '张三', team: 'A' }]] }) === '', JSON.stringify(mk({ total: 16, inFrame: rows16 })));
  ok('U5 那一行只点名、不编数：死活/ping/毫秒一个都不许出现（服务端这一班根本没推那些人）',
    !/ping|毫秒|ms\b|延迟|掉了/.test(t), t);
  ok('U5b 自己那一行不许被点成"没上榜"（定向事件里总带着自己，漏掉这一条就是把自己写没了）',
    !t.includes('R1、') && !t.includes('我'), t.slice(0, 90));
  const BODY = bodyOf(NET_SRC, /\n {2}bigRoomCutText\(/);
  ok('U6【反证臂·同文件代回】把分母抄回裁剪后的行数，同一把尺子当场认出来（那就是 HU-18 原来那条症状）',
    /this\.board && this\.board\.total/.test(BODY || '') && !/this\.board && this\.board\.total/.test(BODY.replace('this.board.total', 'rows.length')));
  const evilNet = mk({ total: 40, inFrame: rows16, roster: [[30, { name: '<img src=x onerror=alert(1)>', team: 'A' }]] });
  ok('U6b 点名的时候也转义：别的玩家的呼号是字符串，不是标记',
    !evilNet.includes('<img') && evilNet.includes('&lt;img'), evilNet.slice(0, 80));
}

// ───────────────────────── V 段：HU-19 冻结期间的读数 + HU-20 按钮说实话 ─────────────────────────
{
  const timers = new Map(); let nid = 1;
  const REAL = { si: globalThis.setInterval, ci: globalThis.clearInterval, st: globalThis.setTimeout, ct: globalThis.clearTimeout };
  const fireTimeouts = () => { for (const t of [...timers.values()]) t.f(); };
  try {
    globalThis.setInterval = (f) => { const k = nid++; timers.set(k, { f }); return k; };
    globalThis.clearInterval = k => timers.delete(k);
    globalThis.setTimeout = (f) => { const k = nid++; timers.set(k, { f }); return k; };
    globalThis.clearTimeout = k => timers.delete(k);
    const pl = { name: '我', team: 'A', isPlayer: true, alive: true, stats: { kills: 9, deaths: 2, score: 1200, assists: 1, captures: 0, shots: 40, hits: 20, headshots: 3 } };
    const bot = { name: '甲', team: 'B', alive: true, kills: 4, deaths: 5, score: 400, captures: 0 };
    const log = []; let shown = null;
    const game = {
      player: pl, bots: [bot], ending: false, profile: { xp: 0, xpLocal: 0 }, saveProfile() { },
      audio: { say() { }, beep() { } }, cfg: { map: 'yard', mode: 'tdm' },
      hud: { announce: (...a) => log.push(['announce', a]), showScoreboard: v => log.push(['sb', v]), popup() { }, scorebar() { }, progress() { } },
      menu: { showResults: r => { shown = r; } },
    };
    const m = Object.create(MPMatch.prototype);
    Object.assign(m, { game, ffa: false, over: false, type: 'tdm', cfg: game.cfg, scores: { A: 1200, B: 400 }, rules: { forceEnd() { } } });
    m.end('A');
    ok('V1 单机终局那一下就立刻把榜拉起来（HU-19 的症状是"这 2.5 秒只剩一行大字"）',
      log.some(x => x[0] === 'sb' && x[1] === true), JSON.stringify(log.map(x => x[0])));
    ok('V1b 而且是**同步**给的，不在那 2.5 s 的定时里（放里面就等于没改）',
      shown === null && timers.size === 1, `面板=${shown ? '已画' : '未画'}·待触发定时器=${timers.size}`);
    fireTimeouts();
    ok('V2 结算面板上那张榜带榜首那一枚（HU-19 欠的是"这局谁打得好"那一格）',
      !!shown && shown.board.includes('sb-mvp') && shown.board.includes('榜首'), shown ? shown.board.slice(0, 40) : '面板没画');
    ok('V2b 单机那一格的文案照旧是"再来一局"：按下真的会重开（startGame 在 again 里）',
      !!shown && shown.againLabel === undefined && typeof shown.again === 'function');
    // HU-20：联机那一路。按钮写的必须就是按下它发生的事。
    const mkNet = (lobby) => {
      const cli = Object.create(NetClient.prototype);
      let cap = null;
      const g = {
        player: pl, profile: { xp: 0, xpLocal: 0 }, account: null, saveProfile() { },
        menu: { showResults: r => { cap = r; } }, net: null, lobby,
      };
      cli.game = g; g.net = cli;
      cli.cid = 1; cli.team = 'A'; cli.ffa = false; cli.scores = { A: 12, B: 5 };
      cli.myStats = { k: 9, d: 2, a: 1, s: 1200 };
      cli.board = { total: 2, rows: [{ cid: 1, name: '我', team: 'A', s: 1200, k: 9, d: 2, a: 1, rank: 1, alive: true }] };
      cli.roster = new Map(); cli._sbNames = new Map();
      timers.clear();
      cli.showResults('win', '胜利');
      fireTimeouts();
      return cap;
    };
    const host = mkNet({ connected: true, state: { me: { isHost: true } } });
    const guest = mkNet({ connected: true, state: { me: { isHost: false } } });
    const direct = mkNet(null);
    ok('V3 有房间的联机结算屏：那一格写「回房间」，不写「再来一局」（按下去等的是房主，不是下一局）',
      !!host && host.againLabel === '回房间' && guest.againLabel === '回房间', `host=${host && host.againLabel}·guest=${guest && guest.againLabel}`);
    ok('V3b 房主看到的是下一步在哪（房间屏那份表单：改地图/模式、再按开始游戏）',
      !!host && /开始游戏/.test(host.againNote || ''), host && host.againNote);
    ok('V3c 访客看到的是"等房主"，而不是一句做不到的承诺',
      !!guest && /等房主/.test(guest.againNote || ''), guest && guest.againNote);
    ok('V3d 直连对局没有房间可回 ⇒ 那一格就是「返回主菜单」，而且不再画第二格同名按钮',
      !!direct && direct.againLabel === '返回主菜单' && direct.againMenu === true, JSON.stringify(direct && { l: direct.againLabel, m: direct.againMenu }));
    ok('V4 面板上那行字取的是调用方给的 label，"再来一局"只当缺省（写死就是 HU-01 那一族病）',
      /esc\(res\.againLabel \|\| '再来一局'\)/.test(MENU_SRC), (MENU_SRC.match(/data-a="again"[^>]*/) || [''])[0]);
    ok('V4b【反证臂·同文件代回】把按钮写死成"再来一局"，同一把尺子当场认出来',
      !/esc\(res\.againLabel \|\| '再来一局'\)/.test(MENU_SRC.replace("esc(res.againLabel || '再来一局')", '再来一局')));
  } finally {
    Object.assign(globalThis, { setInterval: REAL.si, clearInterval: REAL.ci, setTimeout: REAL.st, clearTimeout: REAL.ct });
  }
}

// ═════════════════════════ 第四批：P3 对局外流程（HU-22 … HU-31）═════════════════════════
// 这一批的病全在"点了没反应"与"屏幕上写的那条出路并不存在"这两族：不崩、不报错、权威状态
// 一切正常，只有玩家看得出来。所以判据一律**驱动 js/menu.js 的本体** —— onlineCreate / onlineJoin /
// onlineJoinById / roomStart / renderRoom / roomWhyText / botSeatRow / roomRowJoin / onlineError /
// paintErr / carryAtt / miniBars / playerCard 都是原方法 .call 在夹具上，不是这里替它算一遍。
// 量不到的那几条（要真光标、真滚轮、真焦点序列的那些）退回形状闸并在标签里写明；
// 那半边的真判据在 test/hud-keys.mjs 的 H~K 段（那两屏要真服务端状态，所以只能在那边量）。
const { Menu, cleanClassName } = await import('../js/menu.js');
const { BOOT_STEPS, bootPct } = await import('../js/util.js');
const LOBBY_SRC = src('server/lobby.mjs');

// 按**选择器**记账的一份小 DOM。第一批的 makeDom 只按 id 找（那时不需要"某一格里写了什么字"），
// 这一批量的正是"那一格亮不亮、那一格写的是什么"，所以给一层选择器 → 假元素的映射。
// 元素本体是同一个 makeDom 里的 mk —— 记账口径与 A 段自证过的那份是同一把尺子，不另起一台。
// `slots` 给成数组时就是"这一屏到底有哪些格子"的名单：不在名单里的选择器返回 null，
// 与浏览器在别的屏上 querySelector 找不到那个 id 是同一件事。**没有这一层的话**，
// "这一屏根本没有画错误的格子"那种现场就造不出来（夹具会什么都答一个元素，判据恒绿）。
function elMap(slots) {
  const map = new Map();
  const have = Array.isArray(slots) ? slots : null;
  const q = sel => { if (have && !have.includes(sel)) return null; if (!map.has(sel)) map.set(sel, mk('q:' + sel)); return map.get(sel); };
  return {
    map, q, slots: have,
    el: { querySelector: q, querySelectorAll: () => [] },
    txt: sel => (map.get(sel) || { textContent: '' }).textContent,
    html: sel => (map.get(sel) || { innerHTML: '' }).innerHTML,
    disp: sel => { const e = map.get(sel); return e ? String(e.style.display) : '(没这一格)'; },
  };
}
// "这一帧发出去了吗"记在本子上的一份 LobbyClient 替身。**不替换任何判断**：菜单那一路的闸、
// 路由、文案全是本体，这里只把 socket 那一层换成计数器（send 的返回值语义与本体一致）。
function lbStub(rooms = [], opts = {}) {
  const sent = [];
  return {
    sent, connected: opts.connected !== false, lost: opts.lost || null, rooms, online: 1, chat: [],
    state: opts.state || null, name: '士兵',
    createRoom: o => { sent.push(['create', o.room]); return !opts.dropSend; },
    joinRoom: r => { sent.push(['join', r]); return !opts.dropSend; },
    quickRoom: () => { sent.push(['quick']); return !opts.dropSend; },
    start: () => { sent.push(['start']); return !opts.dropSend; },
    ready: () => true, setTeam: () => true, addBot: () => true, removeBot: () => true, setCfg: () => true,
    close() { this.connected = false; },
  };
}
// 菜单屏的夹具：整屏渲染器（render / showOnlineLobby / showOnlineRoom / showLoadingOverlay）换成
// 计数器 —— 它们要真 DOM 才能跑，而"换了哪一屏"从来不是这一段的被测对象；
// **闸门、路由判据、那一格写什么**全都留的是本体。renderRoom 也留本体（它只碰按选择器给的格子）。
function menuStub(opts = {}) {
  const lb = opts.lb || null;
  const game = {
    lobby: lb, _wantRoom: false, roomSoon: 0, showRoomSoon() { this._wantRoom = true; this.roomSoon++; },
    profile: opts.profile || { classes: [], streaks: [], muted: [], xp: 0, xpLocal: 0 },
    account: opts.account || { statusKnown: true, requireAccount: false, loggedIn: false, user: null },
    saveProfile() { }, saveSettings() { }, audio: { ui() { }, init() { }, say() { } },
    onlineLobby: () => Promise.resolve(lb),
  };
  const m = Object.create(Menu.prototype);
  m.game = game; m._lobby = 0; m._room = 0; m._overlay = 0;
  m.el = opts.el || { querySelector: () => null, querySelectorAll: () => [] };
  m.lobby = { mode: 'tdm', map: 'dune', diff: 1, allies: 5, enemies: 6, time: 10, minutes: 10, score: 50, name: '士兵', team: 'A', room: '', title: '' };
  m._lastErr = ''; m._enterRoom = null; m._enterT = null; m._startSent = false;
  m.screen = opts.screen || 'online';
  m.showOnlineLobby = () => { m._lobby++; };
  m.showOnlineRoom = () => { m._room++; };
  m.showLoadingOverlay = () => { m._overlay++; };
  m.renderRooms = () => { m._rooms++; };
  if (opts.remote) m.remoteJoin = row => { m._remote = (m._remote || []).concat(row.id); return Promise.resolve(); };
  return { m, game, lb };
}
const ROOM_ST = ({ host = true, ready = true, canStart = true, why = '', playing = false, bots = [], seats = null } = {}) => ({
  room: { id: 'r-7', title: '深夜', state: playing ? 'playing' : 'waiting', map: 'dune', mode: 'tdm', time: 10, score: 50, players: 1, max: 16, host: '房主甲' },
  me: { sid: 1, name: '我', isHost: host, ready, team: 'A' },
  seats: seats || [{ sid: 1, name: '房主甲', team: 'A', ready: true, isHost: host }],
  bots, canStart, why, botSkill: 1, fill: 0, chat: [],
});

// ───────────────────────── W 段：HU-22 进房那一路的本地闸门 ─────────────────────────
{
  const timers = new Map(); let nid = 1;
  const REAL = { st: globalThis.setTimeout, ct: globalThis.clearTimeout };
  const fireAll = () => { for (const t of [...timers.values()]) t.f(); };
  try {
    globalThis.setTimeout = (f) => { const k = nid++; timers.set(k, { f }); return k; };
    globalThis.clearTimeout = k => timers.delete(k);

    const lb = lbStub();
    const { m, game } = menuStub({ lb });
    m.onlineCreate(); m.onlineCreate(); m.onlineCreate();
    ok('W1【驱动 onlineCreate】连点三下「创建房间」只发一帧：第二帧服务端回的是「这个房间号已经有人在了」，而那句拒绝会把刚建好的那间房从屏幕上抹掉（HU-22）',
      lb.sent.filter(x => x[0] === 'create').length === 1 && game.roomSoon === 1, JSON.stringify(lb.sent));
    ok('W1b【命门·闸门会松】一句拒绝之后必须再发得出去：挡成永久锁就是把"点了没反应"换成更难查的那一种',
      (() => { const n = lb.sent.length; m.onlineError('那间房已经不在了'); m.onlineCreate(); return lb.sent.length === n + 1; })(),
      JSON.stringify(lb.sent));

    const s2 = menuStub({ lb: lbStub([], { connected: false }) });
    s2.m.onlineCreate();
    ok('W2 没连上时点创建：一帧都不发、**也不盖那层"正在进房…"**（盖了就没人在收它），并且留下一句读得到的原因',
      s2.lb.sent.length === 0 && s2.game._wantRoom === false && s2.m._lastErr.length > 0, JSON.stringify({ sent: s2.lb.sent, err: s2.m._lastErr }));

    const s3 = menuStub({ lb: lbStub() });
    s3.m.onlineCreate();
    const midErr = s3.m._lastErr, midLobby = s3.m._lobby;
    fireAll();
    ok('W3【驱动超时·HU-31】发出去之后服务端一直不回话：到点要收回那层全屏加载、说清是哪一步没回、并把闸门松开（原来这一屏唯一出路是 F5）',
      midErr === '' && /没回这一句/.test(s3.m._lastErr) && s3.m._enterRoom === null && s3.game._wantRoom === false && s3.m._lobby === midLobby + 1,
      JSON.stringify({ mid: midErr, after: s3.m._lastErr, want: s3.game._wantRoom }));
    ok('W3b 超时之后人还能再点一次（这一句是出路，不是一句悼词）',
      (() => { const n = s3.lb.sent.length; s3.m.onlineCreate(); return s3.lb.sent.length === n + 1; })());

    // 「开始游戏」那一格：它是房间屏上唯一一个"发了帧却不换屏"的动作，所以它是"点了没反应"
    // 最常被撞到的那一个。这里驱动的是 renderRoom 本体，量的是落到 DOM 的那一句。
    const fx = elMap();
    const s4 = menuStub({ lb: lbStub([], { state: ROOM_ST() }), el: fx.el, screen: 'onlineRoom' });
    s4.m.renderRoom();
    ok('W4 没按之前那一格写的是「开始游戏」且可按（W5 的"变成正在开局"必须是**变出来的**，不是一开始就写着）',
      fx.txt('[data-a=start]') === '开始游戏' && fx.map.get('[data-a=start]').disabled === false, fx.txt('[data-a=start]'));
    s4.m.roomStart();
    ok('W5【驱动 roomStart + renderRoom】按下之后：一帧发出、那一格改成「正在开局…」并灰掉（这是本地唯一的"我这一下收到了"）',
      s4.lb.sent.filter(x => x[0] === 'start').length === 1 && fx.txt('[data-a=start]') === '正在开局…'
      && fx.map.get('[data-a=start]').disabled === true, JSON.stringify({ sent: s4.lb.sent, label: fx.txt('[data-a=start]') }));
    s4.m.roomStart();
    ok('W5b 再按一次不发第二帧（第二帧换来的是「这间已经在对局中了。」糊在一个正要进对局的屏幕上）',
      s4.lb.sent.filter(x => x[0] === 'start').length === 1, JSON.stringify(s4.lb.sent));
    s4.m.onlineError('这间已经在对局中了。');
    ok('W5c【命门·不许哑】被拒之后那一格**自己**回到「开始游戏」并可再按（这里一次重画都没补 —— 停在原地的"正在开局…"就是换了个形式的"点了没反应"）',
      fx.txt('[data-a=start]') === '开始游戏' && fx.map.get('[data-a=start]').disabled === false, fx.txt('[data-a=start]'));
    ok('W5c2【形状·同文件代回】onlineError 里那一次"顺手重画房间屏"是这条链的唯一环节：删掉它，W5c 那种自动就没了',
      /if \(this\.screen === 'onlineRoom'\) this\.renderRoom\(\);/.test(MENU_SRC)
      && !/if \(this\.screen === 'onlineRoom'\) this\.renderRoom\(\);/.test(MENU_SRC.replace("if (this.screen === 'onlineRoom') this.renderRoom();", '')));
    ok('W5d 那一格的文案与"能不能按"是同一次算出来的（roomStartState 一处，不是两处各写一遍）',
      (() => {
        const st = ROOM_ST();
        const a = s4.m.roomStartState(st.me, { canStart: true }, false);
        s4.m._startSent = true;
        const b = s4.m.roomStartState(st.me, { canStart: true }, false);
        s4.m._startSent = false;
        return a.disabled === false && a.label === '开始游戏' && b.disabled === true && b.label === '正在开局…';
      })());
    ok('W5e【反证臂·合成夹具】旧那条 `!canStart || playing` 在"已发出"这一格上会说还能按 —— 同一把尺子当场认出来',
      (() => {
        const st = ROOM_ST(); s4.m._startSent = true;
        const old = { disabled: !st.canStart || false, label: '开始游戏' };
        const now = s4.m.roomStartState(st.me, { canStart: true }, false);
        s4.m._startSent = false;
        return old.disabled === false && now.disabled === true;
      })());
    ok('W6【跨屏·驱动 onlineJoinById】按房号加入也要过同一道闸：连点两下只发一帧 joinRoom',
      (() => {
        const f = elMap(); f.q('#joinRoomId').value = 'hall-2';
        const s = menuStub({ lb: lbStub(), el: f.el });
        s.m.onlineJoinById(); s.m.onlineJoinById();
        return s.lb.sent.filter(x => x[0] === 'join').length === 1 && s.lb.sent[0][1] === 'hall-2';
      })(), JSON.stringify(menuStub({ lb: lbStub() }).lb.sent));

    // ── HU-31 的另外半：进房那层 overlay 之外，启动那一根条不许再写死台阶 ──
    ok('W7【HU-31·驱动 bootPct】剩下的那一段按**数得清的台阶**分：两步各自一格，最后一步做完才是 100%',
      BOOT_STEPS.length === 2 && bootPct(0) === 90 && bootPct(1) === 100 && bootPct(1) > bootPct(0),
      JSON.stringify({ n: BOOT_STEPS.length, a: bootPct(0), b: bootPct(1) }));
    ok('W7b bootPct 不许跑出 80~100 那一段（frac 给 0、给 5 都不许把条子推出边框）',
      bootPct(0, 0) === 80 && bootPct(1, 5) === 100 && bootPct(-1) <= 100);
    ok('W8 贴图那一段仍然是**量出来的**真实比例（占 0~80%，那是加载期 CPU 的大头，不能被台阶表冒充掉）',
      /initTextures\(p => \{ fill\.style\.width = \(p \* 80\)/.test(MAIN_SRC));
    ok('W8b【反证臂·同文件代回】把那两个写死的 90% / 100% 代回 js/main.js，同一把尺子当场认出来',
      !/fill\.style\.width = '\d+%';/.test(MAIN_SRC)
      && /fill\.style\.width = '90%';/.test(MAIN_SRC.replace("bootPct(0) + '%'", "'90%'")));
    ok('W9 启动失败那一屏有一个可点的「重试」，而且**只在失败时亮**（原来只留一行字，屏幕上没告诉人还能 F5）',
      /<button id="loadRetry"[^>]*style="display:none"/.test(HTML_SRC)
      && /if \(loadRetry\) loadRetry\.style\.display = '';/.test(MAIN_SRC)
      && MAIN_SRC.includes("getElementById('loadRetry')"));
    ok('W9b【反证臂·同文件代回】把失败时亮起来那一句删掉，尺子当场认出来（按钮从此永远藏着的假修法是量不出来的）',
      !/if \(loadRetry\) loadRetry\.style\.display = '';/.test(MAIN_SRC.replace("if (loadRetry) loadRetry.style.display = '';", '')));
  } finally {
    Object.assign(globalThis, { setTimeout: REAL.st, clearTimeout: REAL.ct });
  }
}

// ───────────────────────── X 段：HU-23 远端死按钮 · HU-24 按房号加入 ─────────────────────────
{
  const { m } = menuStub();
  ok('X0【先决】roomRowJoin 是本体（不是这里替它判一遍）', typeof Menu.prototype.roomRowJoin === 'function');
  ok('X1 等待中、没满 ⇒ 可加入', (() => { const j = m.roomRowJoin({ state: 'waiting', players: 3, max: 16, ready: 1 }); return j.can === true && j.label === '加入'; })());
  ok('X2 对局中 ⇒ 不画成能点（这一仓库没有观战，那一格说的是"观战不了"而不是"加入"）',
    (() => { const j = m.roomRowJoin({ state: 'playing', players: 3, max: 16 }); return j.can === false && j.label === '观战不了'; })());
  ok('X3【命门·HU-23】另一台的行**没有 url** ⇒ 不画成一枚亮着的「加入」（旧写法只算 !playing && !full，点下去发的是**本台**的 joinRoom）',
    (() => { const j = m.roomRowJoin({ state: 'waiting', players: 1, max: 16, remote: true, url: '' }); return j.can === false; })(),
    JSON.stringify(m.roomRowJoin({ state: 'waiting', players: 1, max: 16, remote: true, url: '' })));
  ok('X3b 有 url 的远端行照旧可进（"别画死按钮"不等于"把跨台这一条整个禁掉"）',
    m.roomRowJoin({ state: 'waiting', players: 1, max: 16, remote: true, url: 'http://b:8080' }).can === true);
  ok('X3c 满员 ⇒ 不可点，但那一格仍写「加入」（灰着的一枚比一句"满了"更省地方，人数那一列已经说了原因）',
    (() => { const j = m.roomRowJoin({ state: 'waiting', players: 16, max: 16 }); return j.can === false && j.state === '已满'; })());
  const evil = m.roomRowJoin({ state: 'waiting', players: 1, max: 16, title: '<img src=x>', id: 'a<b' });
  ok('X3d 列表那一格仍然转义（这一条与 roomRowJoin 无关，钉的是"重画那一段时别顺手把 esc 丢了"）',
    !evil.label.includes('<') && evil.state !== undefined);

  const s = menuStub({ lb: lbStub([{ id: 'far', remote: true, url: '' }]), remote: true });
  s.m.onlineJoin('far');
  ok('X4【驱动 onlineJoin】远端且没有地址 ⇒ **本台 joinRoom 一帧都不发**（一间存在过的房被服务端查成"那间房已经不在了"是一句谎；更糟的是本台恰好有同号房时他会安安静静进错房）',
    s.lb.sent.length === 0 && s.m._lastErr.includes('地址'), JSON.stringify({ sent: s.lb.sent, err: s.m._lastErr }));
  const s2 = menuStub({ lb: lbStub([{ id: 'far2', remote: true, url: 'http://b:1/ws' }]), remote: true });
  s2.m.onlineJoin('far2');
  ok('X4b 远端有地址 ⇒ 走换台那条路（而**不是**发一帧本地 joinRoom）',
    s2.lb.sent.length === 0 && JSON.stringify(s2.m._remote) === '["far2"]', JSON.stringify({ r: s2.m._remote, sent: s2.lb.sent }));
  ok('X4c 列表那一格与点下去那一路用的是同一个判据（remote 要有 url 才算进得去 —— 两处不一致就会画出一枚点得动的死按钮）',
    /x\.remote && x\.url/.test(MENU_SRC));

  const box = v => { const f = elMap(); f.q('#joinRoomId').value = v; const s = menuStub({ lb: lbStub(), el: f.el }); return { f, s }; };
  const a1 = box('   ');
  a1.s.m.onlineJoinById();
  ok('X5 空房号 ⇒ 不发帧，并说出"要先填房号"（静默不处理就是 HU-22 那一族）',
    a1.s.lb.sent.length === 0 && /房号/.test(a1.s.m._lastErr), a1.s.m._lastErr);
  const a2 = box('深夜大院');
  a2.s.m.onlineJoinById();
  ok('X6 中文房名当房号 ⇒ **当场**说白名单，不许发出去让服务端洗成空串再回一句「那间房已经不在了」（那会把"你打错了"说成"它不存在"）',
    a2.s.lb.sent.length === 0 && /A-Z/.test(a2.s.m._lastErr), a2.s.m._lastErr);
  const a3 = box('hall-2_x.9');
  a3.s.m.onlineJoinById();
  ok('X6b 合法房号 ⇒ 一帧 joinRoom、用的就是填进去那个串，并且记回偏好（下一次进大厅还看得见）',
    a3.s.lb.sent.length === 1 && a3.s.lb.sent[0][0] === 'join' && a3.s.lb.sent[0][1] === 'hall-2_x.9' && a3.s.m.lobby.room === 'hall-2_x.9',
    JSON.stringify(a3.s.lb.sent));
  const a4 = box('x'.repeat(40));
  a4.s.m.onlineJoinById();
  ok('X6c 超过上限 ⇒ 不发（服务端会截，截完查到的可能是**另一间**房）',
    a4.s.lb.sent.length === 0 && /最长/.test(a4.s.m._lastErr), a4.s.m._lastErr);

  // 跨文件对账：房号白名单的正本在 server/lobby.mjs，客户端这一份只校验不清洗。
  const srvBad = /export const ROOM_ID_BAD = (\/[^/]+\/[a-z]*);/.exec(LOBBY_SRC);
  const cliBad = /const ROOM_ID_BAD = (\/[^/]+\/[a-z]*);/.exec(MENU_SRC);
  const srvMax = /export const ROOM_ID_MAX = (\d+)/.exec(LOBBY_SRC);
  const cliMax = /const ROOM_ID_MAX = (\d+)/.exec(MENU_SRC);
  ok('X7【先决】两份房号规则都认得出（切不到就别装"查过了"）',
    !!srvBad && !!cliBad && !!srvMax && !!cliMax, JSON.stringify({ srvBad: srvBad && srvBad[1], cliBad: cliBad && cliBad[1] }));
  ok('X7a【跨文件对账】客户端那份与 server/lobby.mjs 那份逐字相同（字符类与长度上限）',
    cliBad[1] === srvBad[1] && cliMax[1] === srvMax[1], `菜单 ${cliBad[1]}/${cliMax[1]} vs 服务端 ${srvBad[1]}/${srvMax[1]}`);
  ok('X7b【反证臂·同文件代回】把菜单那份的字符类改宽（放行中文）、或把上限改成 48，同一把对账尺子当场认出来',
    (() => {
      const rb = /const ROOM_ID_BAD = (\/[^/]+\/[a-z]*);/, rm = /const ROOM_ID_MAX = (\d+)/;
      const wide = MENU_SRC.replace('const ROOM_ID_BAD = /[^A-Za-z0-9_.-]/g;', 'const ROOM_ID_BAD = /[^A-Za-z0-9_.-\\u4e00-\\u9fa5]/g;');
      const long = MENU_SRC.replace('const ROOM_ID_MAX = 32;', 'const ROOM_ID_MAX = 48;');
      return wide !== MENU_SRC && long !== MENU_SRC && rb.exec(wide)[1] !== srvBad[1] && rm.exec(long)[1] !== srvMax[1];
    })());
  ok('X7c 输入框那个 maxlength 抄的是同一份上限（写死一个别的数 = 界面放行、服务端截断）',
    MENU_SRC.includes('id="joinRoomId" maxlength="${ROOM_ID_MAX}"'), (MENU_SRC.match(/id="joinRoomId"[^>]*/) || [''])[0]);
  const metaLine = (MENU_SRC.match(/ · 房主[^\n]*/) || [''])[0];
  ok('X8 房间屏把**房号**写在标题那一行（按房号加入要有号可抄：起了中文房名的房，房号原来从屏幕上消失）',
    /房号 \$\{room\.id\}/.test(MENU_SRC), metaLine.slice(0, 60));
  ok('X8b【反证臂·同文件代回】把那一格抄回旧的"只写房主"，尺子当场认出来',
    !/房号 \$\{room\.id\}/.test(MENU_SRC.replace(' · 房主 ${room.host || \'—\'} · 房号 ${room.id}', " · 房主 ${room.host || '—'}")));
}

// ───────────────────────── Y 段：HU-25 错误不蒸发 · 那两格说实话 ─────────────────────────
{
  const timers = new Map(); let nid = 1;
  const REAL = { st: globalThis.setTimeout, ct: globalThis.clearTimeout };
  const fireAll = () => { for (const t of [...timers.values()]) t.f(); };
  try {
    globalThis.setTimeout = (f) => { const k = nid++; timers.set(k, { f }); return k; };
    globalThis.clearTimeout = k => timers.delete(k);
    const f = elMap();
    const s = menuStub({ lb: lbStub(), el: f.el, screen: 'online' });
    s.m.onlineError('那间房正在对局中，等它打完或在列表里另找一间');
    ok('Y1【驱动 onlineError·命门】错误**不会被时间擦掉**：把所有待触发定时器都跑一遍，那一格还写着原话（旧写法是 6 秒后 textContent 清空）',
      f.html('#lbErr').includes('那间房正在对局中') && (fireAll(), f.html('#lbErr').includes('那间房正在对局中')),
      JSON.stringify({ timers: timers.size, now: f.html('#lbErr').slice(0, 30) }));
    ok('Y1b 但它也不是永久的：按「知道了」之后那一格必须清空（改成永远挂着是另一种噪音）',
      (() => { s.m._lastErr = ''; s.m.paintErr(); return f.html('#lbErr') === ''; })(), f.html('#lbErr'));
    const ERR_BODY = bodyOf(MENU_SRC, /\n {2}onlineError\(/) || '';
    ok('Y1c【先决】onlineError 的体切得到（切不到下面那条就是遍历空集合的恒绿）', ERR_BODY.includes('paintErr'), `${ERR_BODY.length} 字符`);
    ok('Y1d【反证臂·同文件代回】把那个 6 秒定时器代回 onlineError 体内，同一把尺子（"这一格里不许有定时器"）当场认出来',
      !/setTimeout/.test(ERR_BODY)
      && /setTimeout/.test(ERR_BODY.replace("this._lastErr = msg || '';", "setTimeout(() => { el.textContent = ''; }, 6000); this._lastErr = msg || '';")));
    const f2 = elMap();
    const s2 = menuStub({ lb: lbStub(), el: f2.el, screen: 'onlineRoom' });
    s2.m.onlineError('那间房已经满了');
    ok('Y2 落在哪一屏就画在哪一屏的格子里（在大厅画 #lbErr、在房间屏画 #rmErr，两处不是同一格）',
      f2.html('#rmErr').includes('那间房已经满了') && f2.html('#lbErr') === '', JSON.stringify({ rm: f2.html('#rmErr'), lb: f2.html('#lbErr') }));
    ok('Y2b 挂着的那一句自带一个「知道了」的落点（不蒸发 = 得有一条看得见的路把它收掉）',
      f2.html('#rmErr').includes('data-a="errack"'), f2.html('#rmErr').slice(-60));
    const f3 = elMap();
    const s3 = menuStub({ lb: lbStub(), el: f3.el, screen: 'online' });
    s3.m.onlineError('服务端说：<img src=x onerror=alert(1)>');
    ok('Y3 服务端原话照说，但**转义点在拼 innerHTML 的这一处**（这一格是 innerHTML，不是 textContent）',
      !f3.html('#lbErr').includes('<img') && f3.html('#lbErr').includes('&lt;img'), f3.html('#lbErr').slice(0, 60));
    const f4 = elMap([]);                     // 配装屏上两块错误格子（#lbErr / #rmErr）都不存在
    const s4 = menuStub({ lb: lbStub(), el: f4.el, screen: 'loadout' });
    s4.m.onlineError('这句这一屏没地方画');
    ok('Y4 这一屏没有画它的格子时**不丢**：留在 _lastErr 里，下一屏渲染时补画（在大厅之外失败原本等于没说过）',
      s4.m._lastErr === '这句这一屏没地方画' && f4.map.size === 0, JSON.stringify({ kept: s4.m._lastErr, wrote: f4.map.size }));
    f4.slots.push('#lbErr'); s4.screen = 'online'; s4.m.paintErr();
    ok('Y4b 回到有格子的那一屏时补画得出来（"留着"不是"永远看不见"）',
      f4.html('#lbErr').includes('这句这一屏没地方画'), f4.html('#lbErr').slice(0, 40));
    ok('Y4c 大厅那一屏渲染结尾会补画一次（形状闸：跨屏那一条路的另一半）',
      /this\.paintErr\(\);/.test(bodyOf(MENU_SRC, /\n {2}showOnlineLobby\(/) || ''));
    ok('Y4d【反证臂·同文件代回】把补画那一句从 showOnlineLobby 里删掉，尺子当场认出来',
      !/this\.paintErr\(\);/.test((bodyOf(MENU_SRC, /\n {2}showOnlineLobby\(/) || '').replace('this.paintErr();', '')));

    // #rmWhy 那一行：房主念服务端那句 why，非房主**不许**听到"只有房主能开始游戏"。
    ok('Y5【驱动 roomWhyText】房主 + 可以开始 ⇒ 说"可以开始"',
      /可以开始/.test(s.m.roomWhyText({ canStart: true, why: '' }, { isHost: true, ready: true }, false)));
    ok('Y5b 房主 + 不能开 ⇒ 念服务端那句原因（那是他的问题，那句正是答他的）',
      s.m.roomWhyText({ canStart: false, why: '至少还要再来一个人或一个 Bot。' }, { isHost: true, ready: true }, false) === '至少还要再来一个人或一个 Bot。');
    ok('Y5c【命门】非房主、还没准备 ⇒ 屏幕上**不许**出现那句"只有房主"（旧写法把 st.why 直接念给他，而他没打算开局，只是还没点准备）',
      (() => {
        const t = s.m.roomWhyText({ canStart: false, why: '只有房主能开始游戏。' }, { isHost: false, ready: false }, false);
        return !/只有房主/.test(t) && /准备/.test(t);
      })(), s.m.roomWhyText({ canStart: false, why: '只有房主能开始游戏。' }, { isHost: false, ready: false }, false));
    ok('Y5d 非房主、已准备 ⇒ 等房主（这一句原来是对的，改判序不许把它改丢）',
      /等房主/.test(s.m.roomWhyText({ canStart: false, why: '还在等：张三' }, { isHost: false, ready: true }, false)));
    ok('Y5e【反证臂·合成夹具】把旧的三元式代回来（非房主念 st.why），同一把尺子当场认出来',
      (() => {
        const me = { isHost: false, ready: false }, st = { canStart: false, why: '只有房主能开始游戏。' };
        const old = st.why || '还没准备。';
        return /只有房主/.test(old) && !/只有房主/.test(s.m.roomWhyText(st, me, false));
      })());
    ok('Y5f 对局中那一句照旧（这一条钉的是"补哪一格都不许把别的格子改黄"）',
      s.m.roomWhyText({ canStart: false, why: '' }, { isHost: true, ready: true }, true) === '所有人已进入对局。');

    // Bot 那一行：能不能点由 data-bid 说，而 CSS 的 hover/cursor 也按它设门。
    ok('Y6【驱动 botSeatRow】房主 + 等待态 ⇒ 带 data-bid，且那一格写明"点击移除"',
      (() => { const h = s.m.botSeatRow({ bid: 3, name: '哨戒', skill: 1 }, true); return h.includes('data-bid="3"') && /点击移除/.test(h); })());
    ok('Y6b【命门】非房主 ⇒ **不发** data-bid（旧写法照发，然后在 roomDelBot 开头静默 return：那一行一样亮、一样 hover，点了什么也不发生）',
      (() => { const h = s.m.botSeatRow({ bid: 3, name: '哨戒', skill: 1 }, false); return !h.includes('data-bid') && !/点击移除/.test(h); })(),
      s.m.botSeatRow({ bid: 3, name: '哨戒', skill: 1 }, false).replace(/\s+/g, ' '));
    ok('Y6c【跨文件对账】CSS 的 cursor 与 hover 确实都按 [data-bid] 设门（否则"不发这个属性"根本不等于"不高亮"）',
      /\.seat\.bot\[data-bid\] \{ cursor: pointer; \}/.test(CSS_SRC) && /\.seat\.bot\[data-bid\]:hover/.test(CSS_SRC));
    ok('Y6d 名字那一格转义（Bot 名是服务端起的，但这一屏所有行都走同一条拼接）',
      !s.m.botSeatRow({ bid: 1, name: '<b>x</b>', skill: 0 }, true).includes('<b>x</b>'));
    ok('Y7【HU-25·形状】底部那一行不再是 12px 的 #999（整个房间屏唯一说"接下来按哪个"的地方，小到要凑近才读得见）',
      /\.rm-foot #rmWhy \{ margin-left: auto; font-size:0\.8125rem; color: var\(--txt-2\); \}/.test(CSS_SRC),
      (CSS_SRC.match(/\.rm-foot #rmWhy[^\n]*\n?/) || [''])[0].trim());
    // P4 之后字号单位是 rem、颜色是令牌（HU-33/34）；这一条盯的还是 HU-25 那件事：
    // 不许退回"12px 的一行灰字"。反证臂把两处一起代回旧写法。
    ok('Y7b【反证臂·同文件代回】把它抄回 12px #999，尺子当场认出来',
      !/\.rm-foot #rmWhy \{ margin-left: auto; font-size:0\.8125rem; color: var\(--txt-2\); \}/.test(
        CSS_SRC.replace('font-size:0.8125rem; color: var(--txt-2)', 'font-size: 12px; color: #999')));
  } finally {
    Object.assign(globalThis, { setTimeout: REAL.st, clearTimeout: REAL.ct });
  }
}

// ───────────────────────── Z 段：HU-26 房间屏的那条出路 ─────────────────────────
{
  const askCount = (MENU_SRC.match(/还没连上大厅，稍等一下（或点「重新连接」）/g) || []).length;
  ok('Z0【先决】"还没连上大厅"那一句在原处出现两次（大厅与房间屏共用一份文案），而且都指向「重新连接」',
    askCount === 2, String(askCount));
  ok('Z1【跨文件对账·命门】文案指的那条出路在**两张屏上都真有一个入口**：大厅 data-a=relobby、房间屏 data-a=reconnect（HU-26 的病就是房间屏只有一句"点重新连接"，而那一屏根本没有那一格）',
    MENU_SRC.includes('data-a="relobby"') && MENU_SRC.includes('data-a="reconnect"')
    && MENU_SRC.includes("this.on(r, '[data-a=relobby]'") && MENU_SRC.includes("this.on(r, '[data-a=reconnect]'"));
  const f = elMap();
  const up = menuStub({ lb: lbStub([], { state: ROOM_ST({ host: false }) }), el: f.el, screen: 'onlineRoom' });
  up.m.renderRoom();
  ok('Z2【驱动 renderRoom】连接在手上时那一格是**收着的**（常亮的重连按钮是在宣称"连接是断的"，与大厅那一格同一条判据）',
      f.disp('#rmRe') === 'none' && f.disp('#rmReNote') === 'none', f.disp('#rmRe'));
  up.game.lobby.connected = false;
  up.m.renderRoom();
  ok('Z2b 断了之后它亮出来（两个方向都要，只量"断时亮"的那一版可以是恒亮）',
    f.disp('#rmRe') === '' && f.disp('#rmReNote') === '', f.disp('#rmRe'));
  ok('Z2c 重连那一格上写着"连上之后回大厅"（座位是那条连接身上的，连接一断服务端就收了它 —— 说"回到房间"是另一句谎）',
    /连上之后回大厅/.test(MENU_SRC));
  ok('Z3 断线通知会**主动重画房间屏**（服务端那一班推送再也到不了，不补这一下玩家站的就是一屏"看起来还在房间里"）',
    /else if \(this\.menu\.screen === 'onlineRoom'\) this\.menu\.renderRoom\(\);/.test(MAIN_SRC));
  ok('Z3b【反证臂·同文件代回】把这一句删掉，尺子当场认出来',
    !/else if \(this\.menu\.screen === 'onlineRoom'\) this\.menu\.renderRoom\(\);/.test(MAIN_SRC.replace("else if (this.menu.screen === 'onlineRoom') this.menu.renderRoom();", '')));
  ok('Z4【驱动 onlineRelobby】重连第一步是**关掉断了的那条**再重建（不换的话旧连接上的座位/房间状态还挂在 game.lobby 上）',
    (() => {
      let closed = 0;
      const lb = lbStub(); lb.close = () => { closed++; };
      const s = menuStub({ lb });
      s.m.onlineRelobby();
      return closed === 1 && s.m._overlay === 1;
    })());
  ok('Z5 房间屏与大厅屏的错误格各自带「知道了」的落点（同一份 paintErr，两屏共用一个口径）',
    (MENU_SRC.match(/id="lbErr"|id="rmErr"/g) || []).length === 2 && /class="note-wide err"/.test(MENU_SRC));
}

// ───────────────────────── AA 段：HU-27 数值条 · HU-28 滚轮 ─────────────────────────
{
  const { computeStats, statBars, WEAPONS, ATTACHMENTS, attachmentAllowed, findAttachment } = await import('../js/data.js');
  const { m } = menuStub();
  ok('AA0【先决】carryAtt 是本体、且配件表不是空的', typeof Menu.prototype.carryAtt === 'function' && Object.keys(ATTACHMENTS).length > 3);
  // 夹具里的配件不是抄的：每把枪都按 data.js 那两张表**装满**（每个槽位取第一个该枪收的配件）。
  // 抄一份 { muzzle:'supp' } 的话，哪天表里改了 id，这条判据会静默变成"什么都滤不掉"的恒绿。
  const fullPatt = id => { const p = {}; for (const s of (WEAPONS[id].slots || [])) { const a = (ATTACHMENTS[s] || []).find(x => attachmentAllowed(id, s, x)); if (a) p[s] = a.id; } return p; };
  const clsFor = id => ({ primary: id, patt: fullPatt(id), secondary: 'm1911', satt: {} });
  const cls = clsFor('m4');
  ok('AA0b【先决】m4 那份配件不是空的（空了的话 AA1~AA3 全是空断言）', Object.keys(cls.patt).length >= 2, JSON.stringify(cls.patt));
  const keptM4 = m.carryAtt(cls, 'primary', 'm4');
  ok('AA1b 同一把枪上兼容的那些**一个都不掉**（这条钉的是"滤完不是清空"）',
    Object.keys(keptM4).length === Object.keys(cls.patt).length, JSON.stringify(keptM4));
  const poor = Object.keys(WEAPONS).find(id => id !== 'm4' && Object.keys(m.carryAtt(cls, 'primary', id)).length < Object.keys(cls.patt).length);
  ok('AA1【驱动 carryAtt】换到一支不兼容的枪时，留下的只有那些在这把枪上还存在的配件（这份筛选原来只在 pickWeapon 的点击分支里，而数值条拿的是另一份 = 一把空枪）',
    !!poor && Object.keys(m.carryAtt(cls, 'primary', poor)).length < Object.keys(cls.patt).length, String(poor));
  ok('AA1c 留下的每一个都必须真的被那把枪收（不兼容的那几个不许留在条子上冒充"我这把"）',
    !!poor && Object.entries(m.carryAtt(cls, 'primary', poor)).every(([s, a]) => attachmentAllowed(poor, s, findAttachment(s, a))),
    poor ? JSON.stringify(m.carryAtt(cls, 'primary', poor)) : '没有一支不兼容的枪');
  const BAR = ['伤害', '射速', '射程', '精准度', '机动性'];
  const barsId = Object.keys(WEAPONS).find(id => {
    const k = m.carryAtt(clsFor(id), 'primary', id);
    const a = statBars(computeStats(id, k)), b0 = statBars(computeStats(id, {}));
    return BAR.some(x => Math.round(a[x]) !== Math.round(b0[x]));
  });
  ok('AA2【先决】存在一把枪，它的"带配件"与"空配件"那五根条**确实不同**（都没有的话 AA3 就是空断言，得退回形状闸）', !!barsId, String(barsId));
  const k2 = m.carryAtt(clsFor(barsId), 'primary', barsId);
  const withA = statBars(computeStats(barsId, k2)), bare = statBars(computeStats(barsId, {}));
  const widths = h => [...h.matchAll(/width:([\d.]+)%/g)].map(x => Math.round(+x[1]));
  ok('AA3【驱动 miniBars】选枪屏那几根条画的就是"我这把带配件的"那些数（HU-27：原来画的是空配件基准条，与实际带进对局的枪无关）',
    JSON.stringify(widths(m.miniBars(barsId, k2))) === JSON.stringify(BAR.map(x => Math.round(withA[x])))
    && m.miniBars(barsId, k2) !== m.miniBars(barsId), JSON.stringify({ att: widths(m.miniBars(barsId, k2)), bare: widths(m.miniBars(barsId)) }));
  ok('AA3b 不给第二参时照旧可用，且那就是空枪那一组数（旧调用点不许炸、也不许悄悄变成"猜一份配件"）',
    JSON.stringify(widths(m.miniBars(barsId))) === JSON.stringify(BAR.map(x => Math.round(bare[x]))));
  ok('AA3c【反证臂·同文件代回】把 miniBars 抄回 computeStats(id, {})，AA3 那把尺子当场认出来',
    (() => {
      const back = MENU_SRC.replace('statBars(computeStats(id, att || {}))', 'statBars(computeStats(id, {}))');
      const g = /computeStats\(id, att \|\| \{\}\)/;
      return g.test(MENU_SRC) && !g.test(back);
    })());
  ok('AA4 选枪屏与"装上"那一路共用同一份 carryAtt（两处各写一遍筛选，条子就会说谎而没人报错）',
    (MENU_SRC.match(/this\.carryAtt\(/g) || []).length >= 2 && !/const old = c\[k\] \|\| \{\}; const nw = \{\};/.test(MENU_SRC));
  ok('AA5 枪匠的 delta 预览同时挂在 focus 上（键盘用户 Tab 到那一行时原来只能盲按回车**直接装上**）',
    /el\.addEventListener\('mouseenter', preview\);\s*\n\s*el\.addEventListener\('focus', preview\);/.test(MENU_SRC),
    (MENU_SRC.match(/addEventListener\('mouseenter'[^\n]*/) || [''])[0].slice(0, 50));
  ok('A5b【反证臂·同文件代回】把 focus 那一刀删掉（回到只有鼠标能预览），尺子当场认出来',
    !/addEventListener\('focus', preview\)/.test(MENU_SRC.replace("el.addEventListener('focus', preview);", '')));
  const WHEEL = bodyOf(MENU_SRC, /this\.el\.addEventListener\('wheel'/) || '';
  const wheelGate = /e\.target\.closest\('\.gs-left,\.gs-right,\.gs-stats,\.gs-foot,\.picker'\)/;
  ok('AA6【HU-28·形状】滚轮缩放只归"看枪"那块区域：指针落到会滚的面板上时不许抢那个手势（真判据在 hud-keys 的 K 段）',
    !!WHEEL && WHEEL.includes("this.screen !== 'gunsmith'") && wheelGate.test(WHEEL), WHEEL.replace(/\s+/g, ' ').slice(0, 70));
  ok('AA6b【反证臂·同文件代回】把 .gs-right 从那份排除名单里拿掉（就是 HU-28 那个现场：列表在滚、镜头也在缩放），同一把尺子当场认出来',
    (() => { const back = WHEEL.replace('.gs-left,.gs-right,', '.gs-left,'); return back !== WHEEL && !wheelGate.test(back); })());
  ok('AA6c 排除名单里那两个"会滚"的容器确实是 CSS 里带 overflow-y 的那两个（名单不是抄来的，是对账出来的）',
    /\.gs-right \{[^}]*overflow-y: auto/.test(CSS_SRC) && /\.pick-grid \{[^}]*overflow-y: auto/.test(CSS_SRC));
}

// ───────────────────────── AB 段：HU-29 原生弹窗 · HU-30 战绩 ─────────────────────────
{
  const { m } = menuStub();
  // 原生弹窗那道全仓闸：把**行注释**与**方法定义行**摘掉之后再找裸 prompt/confirm/alert。
  // 两处都要摘：这一层的注释里会引用旧写法（`confirm('…')` 那种历史说明），而 js/hud.js 自己
  // 就有一个方法叫 prompt(text) —— 它长得不像调用，但它就是会被"裸 prompt(" 那个形状认进去。
  const codeOnly = t => t.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).map(l => l.replace(/\s+\/\/.*$/, '')).join('\n');
  const nativeHits = t => {
    // `window.confirm(` 也算：先把这个前缀摘掉，让"裸调用"那一条形状去认它（前缀那个点会被
    // [^\w.$] 挡在门外 —— 而 hud.prompt()/this.prompt() 靠的正是同一个点被排除，两类要分开）。
    const c = codeOnly(t).replace(/\bwindow\.(prompt|confirm|alert)\b/g, ' $1')
      .replace(/^\s*(prompt|confirm|alert)\s*\([^)]*\)\s*\{/gm, '    DEF_HEAD');
    return [...c.matchAll(/(?:^|[^\w.$])\b(prompt|confirm|alert)\s*\(/g)].map(x => x[1]);
  };
  const UI_FILES = ['js/menu.js', 'js/main.js', 'js/hud.js', 'js/mp.js', 'js/campaign.js', 'js/net/client.mjs', 'js/account.js'];
  const natives = UI_FILES.flatMap(p => nativeHits(src(p)).map(k => p + ':' + k));
  ok('AB0【自证·量具先活着】这道闸认得出裸调用、藏得住方法定义与行注释（摘掉这两类之后还找得到，才是真在数调用点）',
    nativeHits("  const n = prompt('x');\n").join() === 'prompt'
    && nativeHits("  prompt(text) {\n    el.textContent = t;\n  }\n").length === 0
    && nativeHits("  // 原来：confirm('确定要重置吗？') 一版\n").length === 0
    && nativeHits("  hud.prompt('a'); this.prompt('b');\n").length === 0, JSON.stringify(natives));
  ok('AB1【全仓闸·HU-29】表现层里一处原生弹窗都不剩（那几条灰框与这一层的排版断层，而且读不出"会丢什么"）',
    natives.length === 0, natives.join(' | '));
  ok('AB1b【反证臂·同文件代回】把改名那一句抄回 window.prompt，同一把尺子当场认出来',
    nativeHits(MENU_SRC.replace('this.renameClass(ci)', "window.prompt('配装名称', c.name)")).join() === 'prompt'
    && nativeHits(MENU_SRC).length === 0);
  ok('AB2【驱动 cleanClassName】12 字上限 / 两端空白 / 控制字符都在这一处清洗（页内那一格与判据用的是同一份规矩）',
    cleanClassName('  侦察兵  ') === '侦察兵' && cleanClassName('一二三四五六七八九十甲乙丙') === '一二三四五六七八九十甲乙' && cleanClassName('a\u0007b') === 'a b',
    JSON.stringify([cleanClassName('  侦察兵  '), cleanClassName('一二三四五六七八九十甲乙丙'), cleanClassName('a\u0007b')]));
  ok('AB2b 全空白 ⇒ 空串（调用方据此**不改名**，而不是把配装改成一个空格）', cleanClassName('   ') === '');
  const cardFor = (account, profile) => Object.assign(Object.create(Menu.prototype), {
    game: { account, profile: Object.assign({ xp: 0, xpLocal: 0, muted: [] }, profile) },
    level: () => ({ lv: 1, frac: 0 }),
  }).playerCard();
  const ON = cardFor({ loggedIn: true, user: { name: '甲', xp: 900, matches: 12, wins: 7 } }, { xp: 900 });
  const OFF = cardFor({ loggedIn: false, user: null }, { xpLocal: 40 });
  ok('AB3【驱动 playerCard·命门】主菜单那张卡上从此有一行战绩：登录态取服务端那本账（场次/胜），单机与访客走的是"没这本账"那一支（HU-30 的症状是这些只写在联网大厅那块面板里）',
    /场次 12 · 胜 7/.test(ON) && /场次 — · 胜 —/.test(OFF), OFF.replace(/<[^>]+>/g, ' ').trim().slice(-40));
  ok('AB3b 没账本的那两格写 —、**不写 0**（0 是一句陈述，而"从来没打过"与"打过但本地没有这本账"是两回事 —— 照 HU-16 那条纪律）',
    !/场次 0/.test(OFF) && !/胜 0/.test(OFF), OFF.replace(/<[^>]+>/g, ' ').trim().slice(-30));
  ok('AB4【HU-29·形状】重置那一层把会丢的几样列出来了，并且「先导出为文件」排在「确认重置」前面（不可逆的操作先给一次退路）',
    /会在你这台机器上清掉的/.test(MENU_SRC) && MENU_SRC.indexOf('data-a="dump"') < MENU_SRC.indexOf('data-a="doprofile"'));
  ok('AB4b 导出的是**会被这次重置清掉的那一份**（mf_profile），不是"全部"：设置那一格根本不在清除范围内（settings 是另一个键）',
    /localStorage\.getItem\('mf_profile'\)/.test(MENU_SRC) && /removeItem\('mf_profile'\)/.test(MENU_SRC)
    && !/removeItem\('mf_settings'\)/.test(MENU_SRC));
  const SET_BODY = bodyOf(MENU_SRC, /\n {2}showSettings\(/) || '';
  const nativeShape = /(?:^|[^\w.$])\bconfirm\s*\(/;
  ok('AB4c【反证臂·同文件代回】把旧的 confirm 那一条代回 showSettings，同一把尺子当场认出来（正向不脏、代回必脏）',
    SET_BODY.includes('resetSaveDialog') && !nativeShape.test(SET_BODY)
    && nativeShape.test(SET_BODY.replace('this.resetSaveDialog()', " confirm('确定要重置所有配装与经验值吗？')")));
  ok('AB4d 改名那一格自带焦点（原生 prompt 本来就有这件事，换成层内那一格就得自己补 —— 不然点开之后还得先点一下才能打字）',
    /f\.focus\(\)/.test(bodyOf(MENU_SRC, /\n {2}renameClass\(/) || ''));
}

// ───────────────────────── AC–AG 段：第五批（P4 适配性 HU-32~HU-37 / HU-39 / HU-40）─────────────────────────
// 这一批的判据分两层：**这一份**钉的是"单位、令牌、区间、接线在不在"（源码形状 + 直接驱动纯函数），
// 真几何、真颜色、真视口那一半在 test/hud-keys.mjs（AC/AD/AE 三段，三档视口各量一次）。
// 分这么两层的原因与本仓库反复写的那条一致：形状判据只兜底，不当证明。
const cssBody = sel => {
  // 选择器前面不许再有一层限定（`.bind-key` 不能被 `button.bind-key { … }` 那条复位规则冒充）
  const m = new RegExp('(?<![.\\w#-])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(CSS_SRC);
  return m ? m[1] : null;
};
const CSS_ONLY = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里提到旧色号是历史，不是现役声明
// WCAG 的相对亮度与对比度，判据自己算（"看着挺亮"不是量具）
const lum = hex => {
  const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

// ───────────────────────── AC 段：HU-33 字号单位 ─────────────────────────
{
  const JS_FILES = ['js/menu.js', 'js/mp.js', 'js/net/client.mjs', 'js/hud.js', 'js/main.js', 'js/campaign.js'];
  const pxIn = t => t.match(/font-size:\s*[\d.]+px/g) || [];
  const cssPx = pxIn(CSS_SRC), jsPx = JS_FILES.flatMap(f => pxIn(src(f)).map(x => f + ' ' + x));
  ok('AC0【量具自证】这把尺子认得出"固定字号"这个形状（先证明它数得出来，再拿它说 0）',
    pxIn('a { font-size: 13px; }').length === 1 && pxIn('a { font-size:.8rem; }').length === 0);
  ok('AC1 style.css 里 font-size 全是相对单位（HU-33：浏览器"字号"设置过去完全不跟随）',
    cssPx.length === 0, cssPx.slice(0, 3).join(' '));
  ok('AC2 JS 模板串里的内联 font-size 同样清零（审计点名的 menu.js 配件描述 11px 就在这一份里）',
    jsPx.length === 0, jsPx.slice(0, 3).join(' '));
  ok('AC3【反证臂】把一条 rem 代回 12px，同一把尺子当场认出来',
    pxIn(CSS_SRC.replace('.mbtn .md { font-size:0.75rem;', '.mbtn .md { font-size:12px;')).length === 1);
  ok('AC4 --hu = 1rem × HUD 缩放：两个自由度都在（浏览器字号 × 游戏内 HUD 缩放），不是其中之一',
    /--hu:\s*calc\(1rem \* var\(--hud-scale\)\)/.test(CSS_ONLY));
  const hudN = (CSS_SRC.match(/font-size:calc\(var\(--hu\)/g) || []).length;
  const remN = (CSS_SRC.match(/font-size:[\d.]+rem/g) || []).length;
  ok('AC5 两套单位各就各位：HUD 区吃 --hu（随缩放），菜单区吃 rem（不随缩放）',
    hudN >= 25 && remN >= 35, `hu=${hudN} rem=${remN}`);
  ok('AC6 HUD 里不许用 em 定字号（em 会连乘：.marker 12px 里再写 12px 会变成 9px，而这两处本来同大）',
    !/font-size:\s*[\d.]+em/.test(CSS_ONLY));
  ok('AC7 内联样式的字色也走了令牌（HU-34 的那一份抄本住在 JS 模板里，CSS 达标不等于界面达标）',
    !/(menu|mp|client)\.(js|mjs)/.test(jsPx.join('')) && !/color:#(555|666|777|888|999)\b/.test(
      ['js/menu.js', 'js/mp.js', 'js/net/client.mjs'].map(src).join('\n').replace(/\/\/.*$/gm, '')));
}

// ───────────────────────── AD 段：HU-34 对比度（源码侧那一半）─────────────────────────
{
  const BAD = ['#555', '#666', '#777', '#5a5a5a', '#8a8a8a', '#9ab', '#9a9a9a'];
  const uses = BAD.filter(c => new RegExp('color:\\s*' + c + '\\b', 'i').test(CSS_ONLY));
  ok('AD0【量具自证】灰字写进**声明**里这把尺子就认得，只写在注释里不算（注释里提旧色号是历史）',
    new RegExp('color:\\s*#666\\b').test('x{color:#666}')
    && !new RegExp('color:\\s*#666\\b').test('/* color:#666 */ x{color:#8d8d8d}'.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('AD1 那批灰字面量不再当文字色用（真比值在 hud-keys 的 AC 段逐格量）', uses.length === 0, uses.join(' '));
  ok('AD2【反证臂】把 .menu-foot 代回 #666，同一把尺子当场认出来',
    BAD.includes('#666') && new RegExp('color:\\s*#666\\b').test(
      CSS_ONLY.replace('.menu-foot { margin-top: auto; padding-bottom: clamp(12px, 4vh, 30px); font-size:0.75rem; color: var(--txt-4);', '.menu-foot { color: #666;')));
  const TOKENS = ['--txt', '--txt-2', '--txt-3', '--txt-4', '--hud-txt', '--hud-txt-2', '--hud-txt-3'];
  const missTok = TOKENS.filter(k => !new RegExp('(?:^|\\s)' + k + ':\\s*#[0-9a-fA-F]{6}').test(CSS_ONLY));
  ok('AD3 文字令牌全部定义了（缺一档就是某一处还在吃硬编码）', missTok.length === 0, missTok.join(' '));
  const t4 = /(?:^|\s)--txt-4:\s*(#[0-9a-fA-F]{6})/.exec(CSS_ONLY);
  ok('AD4 最暗的一档对最暗的底色 #060809 仍然 ≥4.5:1（这里现算相对亮度，不引用谁的说法）',
    !!t4 && contrast(t4[1], '#060809') >= 4.5, t4 ? `${t4[1]} = ${contrast(t4[1], '#060809').toFixed(2)}:1` : '读不到 --txt-4');
  ok('AD4b【尺子会红】同一把算法判旧的那档 #666 不达标（4.5 这条线不是摆设）',
    contrast('#666666', '#060809') < 4.5 && contrast('#8d8d8d', '#060809') >= 4.5,
    `#666=${contrast('#666666', '#060809').toFixed(2)} #8d8d8d=${contrast('#8d8d8d', '#060809').toFixed(2)}`);
  // 可达性暗示不许只长在 :hover 上（HU-34 的第二半）：菜单层每一个"看起来能点"的选择器
  // 都得有一个键盘可见落点。跨文件对账 menu.js 的 KEYPICK 与 style.css 的焦点名单。
  const kp = /const KEYPICK = '([^']+)'/.exec(MENU_SRC)[1].split(',').map(s => s.trim()).filter(Boolean);
  const noFocus = kp.filter(sel => !new RegExp(
    sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?::hover|:focus-visible)?[^{}]*:focus-visible').test(CSS_ONLY)
    && !new RegExp('button\\.' + sel.replace(/^\./, '') + '[\\s,{]').test(CSS_ONLY));
  ok('AD5 KEYPICK 里每一类可点元素都有 :focus-visible 落点（触屏与键盘用户看不到"这行能点"就是没有）',
    noFocus.length === 0, `缺:${noFocus.join(',') || '无'}（名单 ${kp.length} 项）`);
  ok('AD5b【先决】这条对账不是遍历空集合：KEYPICK 至少 10 项', kp.length >= 10, `KEYPICK=${kp.length}`);
}

// ───────────────────────── AE 段：HU-32 响应式 / HU-35 目标 / HU-36 HUD 几何 ─────────────────────────
{
  const med = CSS_ONLY.match(/@media[^{]+/g) || [];
  ok('AE1 有媒体查询且两条轴都覆盖（窄 / 矮 / 超宽；审计点名的是 1024×768 与 2560×1080）',
    med.length >= 4 && med.some(m => /max-width/.test(m)) && med.some(m => /max-height/.test(m)) && med.some(m => /min-width/.test(m)),
    med.length + ' 条');
  ok('AE1b 审计那条 grep 快照已经翻案（当年 grep -c "@media" style.css → 0，就是这一条把 HU-32 立成结构性欠账）',
    (src('style.css').match(/@media/g) || []).length >= 4, `现在 ${(src('style.css').match(/@media/g) || []).length} 处`);
  const WIDE = ['.menu-left', '.settings', '.results', '#scoreboard', '.brief', '.gate-card', '.lb-right', '.gs-stats', '.gs-right', '.classes', '#chatBox', '#killfeed', '.mbtn', '#equipRow'];
  const bare = WIDE.filter(sel => {
    const b = cssBody(sel);
    return b && /(?:^|[;{]\s*)(?:max-)?width:\s*\d{3,}px/.test(b) && !/(?:^|[;{]\s*)(?:max-)?width:\s*(?:min|max|clamp)\(/.test(b);
  });
  ok('AE2 那些固定宽度都改成了 min()/clamp() 包裹（HU-32：窄窗里它们把内容推出视口）',
    bare.length === 0, `还是裸 px:${bare.join(',') || '无'}`);
  ok('AE2b【反证臂】把 .settings 的宽度代回 620px，尺子当场认出来',
    (() => {
      const back = CSS_SRC.replace('.settings { margin: auto; width: min(680px, 94vw);', '.settings { margin: auto; width: 620px;');
      const b = /\.settings\s*\{([^}]*)\}/.exec(back)[1];
      return /(?:^|[;{]\s*)width:\s*\d{3,}px/.test(b) && !/width:\s*(?:min|max|clamp)\(/.test(b);
    })());
  const SCROLL = ['.settings', '.results', '.gate-card', '.brief', '#scoreboard', '.lobby-body', '.gs-right', '.pick-grid', '.cls-detail', '.chat-lines'];
  const noScroll = SCROLL.filter(sel => { const b = cssBody(sel); return !b || !/overflow[^:]*:\s*[^;]*auto/.test(b); });
  ok('AE3 会长的每一屏自己就能滚（HU-32 实测：1280×720 下设置屏最后一行落在视口外，鼠标点不到它）',
    noScroll.length === 0, `缺:${noScroll.join(',') || '无'}`);
  const CENTERED = ['.settings', '.results', '.brief', '.gate-card'];
  const noCap = CENTERED.filter(sel => { const b = cssBody(sel); return !b || !/max-height/.test(b); });
  ok('AE3b 靠 margin:auto 居中的那几屏都封了 max-height：不封顶的话 auto 边距会把多出来的部分推到视口**上方**，那里连滚动都到不了',
    noCap.length === 0, `缺:${noCap.join(',') || '无'}`);
  ok('AE3b 菜单层自己可滚（html,body 是 overflow:hidden，这一层是唯一出路）',
    /#menu > \.screen \{ overflow: hidden auto/.test(CSS_ONLY));
  const TAP = ['.mbtn', '.btn', '.btn.small', '.seg div', '.cfg-row .seg div', '.seat', '.room-row', '.sp-flag', '.cls', '.pick', '.gs-slot', '.gs-att', '.chat-in input', '.bind-key'];
  const small = TAP.filter(sel => { const b = cssBody(sel); return !b || !/min-height:\s*3[2-9]px|min-height:\s*[4-9]\dpx/.test(b); });
  ok('AE4 每一类可点元素都有 ≥32px 的高度下限（HU-35：房间设置那 6 档挤在 ~30px 里，触屏按不准）',
    small.length === 0, `缺:${small.join(',') || '无'}`);
  ok('AE4b【反证臂】把 .seg div 的 min-height 摘掉，尺子当场认出来',
    !/min-height:\s*\d+px/.test((cssBody('.seg div') || '').replace('min-height: 34px;', '')));
  // HU-36 罗盘：460 / 230 / ×4 那三份抄本收成一处
  const compassRule = cssBody('#compass') || '';
  ok('AE5 罗盘的三个魔数不再各写各的（#compass 里那条 460 与 hud.js 里那句 style.left 都没了，改读 --cp-pxd / this.cpPxd）',
    compassRule.includes('calc(var(--cp-pxd)') && !/width:\s*460px/.test(compassRule)
    && !/margin-left:\s*-230px/.test(compassRule) && !/style\.left = \(230 - deg \* 4/.test(HUD_SRC)
    && /style\.transform = `translateX\(\$\{-deg \* this\.cpPxd\}px\)`/.test(HUD_SRC)
    && /export const COMPASS_PXD = 4/.test(src('js/settings.mjs')), compassRule.slice(0, 56));
  ok('AE5b【反证臂】把 left = 230 − deg×4 代回 hud.js 那一行，同一把尺子认出来',
    /230 - deg \* 4/.test(HUD_SRC.replace("style.transform = `translateX(${-deg * this.cpPxd}px)`", "style.left = (230 - deg * 4) + 'px'")));
  ok('AE6 准星的臂长在两处同源：CSS 读 var(--cross-size)，hud.js 读设置里的 crossSize（那个手抄的 −9 不许留）',
    /height: var\(--cross-size\)/.test(CSS_ONLY) && /width: var\(--cross-size\)/.test(CSS_ONLY)
    && /st\.crossSize/.test(HUD_SRC) && !/\(-px - 9\)/.test(HUD_SRC));
  ok('AE6b 扩散→像素按短边定标（HU-36 反向那半：只用 innerHeight 时 21:9 上同一把枪的腰射看起来更小）',
    /Math\.min\(window\.innerWidth/.test(HUD_SRC) && !/spread \* \(window\.innerHeight/.test(HUD_SRC));
  ok('AE7 瞄具遮罩用 vmin 不用 vh（超宽屏上圆孔按高度定径 ⇒ 左右大片可见，21:9 那一档的症状）',
    !/width:\s*88vh/.test(CSS_ONLY) && /width:\s*88vmin/.test(CSS_ONLY) && /width:\s*70vmin/.test(CSS_ONLY));
  ok('AE7b 小地图尺寸是设置项：CSS 读 var(--mm-size)，HUD 画的是 this.mmSize，画布属性由 syncDisplay 落',
    /width: var\(--mm-size\)/.test(CSS_ONLY) && /const ctx = this\.mm, S = this\.mmSize/.test(HUD_SRC)
    && /cv\.width = size/.test(HUD_SRC));
  ok('AE8 killfeed 与装备行都有了上限/换行（1024 宽时呼号最长 16 字，居中比分条就在它左边）',
    /#killfeed \{[^}]*max-width/.test(CSS_ONLY) && /#equipRow \{[^}]*flex-wrap: wrap/.test(CSS_ONLY));
  ok('AE8b 中文逐字硬折换掉了（word-break:break-all 会把拉丁词也劈开）',
    !/word-break:\s*break-all/.test(CSS_ONLY) && /overflow-wrap: anywhere/.test(CSS_ONLY));
}

// ───────────────────────── AF 段：HU-37 设置那张表（驱动真函数）─────────────────────────
{
  const M = await import('../js/settings.mjs');
  const { SET_SPEC, SET_GROUPS, SETTINGS_DEFAULTS, sanitizeSettings, formatValue, applyDisplaySettings, compassPxd, CROSS_COLORS } = M;
  const specKeys = Object.keys(SET_SPEC).filter(k => SET_SPEC[k].type !== 'note');
  ok('AF0【表自证】每个设置项都有默认值，num 的默认落在自己的区间里（区间写反的话 AF2 会红）',
    specKeys.every(k => k in SETTINGS_DEFAULTS)
    && specKeys.every(k => SET_SPEC[k].type !== 'num' || (SETTINGS_DEFAULTS[k] >= SET_SPEC[k].min && SETTINGS_DEFAULTS[k] <= SET_SPEC[k].max)));
  ok('AF1 设置屏的分组把表里的每一项都排上了（漏一项 = 那一格在界面上根本不存在）',
    SET_GROUPS.flatMap(g => g.rows).sort().join() === Object.keys(SET_SPEC).sort().join(),
    SET_GROUPS.map(g => g.t + ':' + g.rows.length).join(' '));
  ok('AF2 P4 新增的那几项真的在表上（HUD 缩放/透明度/小地图/准星三件/字幕/三条声道/加速/绑定）',
    ['hudScale', 'hudOpacity', 'mmSize', 'crossColor', 'crossSize', 'crossGap', 'subtitles', 'volSfx', 'volAmbient', 'volVoice', 'mouseAccel', 'binds']
      .every(k => k in SET_SPEC), Object.keys(SET_SPEC).length + ' 项');
  const dirty = sanitizeSettings({ fov: 'abc', sens: 99, adsSens: -3, quality: 'ultra', fpsCap: '144', volume: '0.5', mmSize: 10, hudScale: 5, crossColor: '紫色', voice: 'false', showFps: 1, subtitles: 'nope', nonsense: 7, binds: { fwd: ['KeyW', 'Bogus'], nope: ['KeyZ'] } });
  ok('AF3 脏存档过闸：区间外夹回区间内、非法枚举回默认、未知键丢掉、非数字不但不 NaN 还回默认',
    dirty.fov === 78 && dirty.sens === 3 && dirty.adsSens === 0.3 && dirty.quality === 'high' && dirty.fpsCap === 144
    && dirty.volume === 0.5 && dirty.mmSize === SET_SPEC.mmSize.min && dirty.hudScale === SET_SPEC.hudScale.max
    && dirty.crossColor === '白' && dirty.voice === false && dirty.showFps === true && dirty.subtitles === true
    && !('nonsense' in dirty) && JSON.stringify(dirty.binds) === '{}', JSON.stringify(dirty).slice(0, 90));
  ok('AF3b 与默认一致的绑定**不写进存档**（改了默认值时旧存档不许把它钉死），真改了才留',
    JSON.stringify(sanitizeSettings({ binds: { fwd: ['KeyG'] } }).binds) === '{"fwd":["KeyG"]}'
    && JSON.stringify(sanitizeSettings({ binds: { fwd: ['KeyW'] } }).binds) === '{}');
  ok('AF3b【反证臂·A/B 两方向】旧的 Object.assign 直读那份脏值会原样放行（这才是"当年为什么会炸"）',
    Object.assign({ fov: 78 }, JSON.parse('{"fov":"abc","sens":99}')).fov === 'abc' && sanitizeSettings({ fov: 'abc', sens: 99 }).fov === 78);
  ok('AF4 formatValue 对每一种 fmt 都给得出屏上那个数（滑杆读数与值是同一份设置的两张脸）',
    formatValue('sens', 1.5) === '1.50' && formatValue('hudScale', 1.2) === '120' && formatValue('mmSize', 200) === '200px'
    && formatValue('quality', 'high') === 'high' && formatValue('fpsCap', 0) === '0');
  const root = { style: { p: {}, setProperty(k, v) { this.p[k] = v; } } };
  applyDisplaySettings({ hudScale: 1.2, hudOpacity: 0.8, mmSize: 200, crossColor: '青', crossSize: 12, crossGap: 6 }, root);
  const written = root.style.p;
  ok('AF5 落地那一处把六格全写进了 CSS 变量，值都对（applyDisplaySettings 是画面这半边唯一的写点）',
    written['--hud-scale'] === '1.2' && written['--hud-op'] === '0.8' && written['--mm-size'] === '200px'
    && written['--cross-size'] === '12px' && written['--cross-col'] === CROSS_COLORS['青']
    && Object.keys(written).length === 6 && written['--cp-pxd'] === String(compassPxd({ hudScale: 1.2 })), JSON.stringify(written));
  const written2 = (() => { const r2 = { style: { p: {}, setProperty(k, v) { this.p[k] = v; } } }; applyDisplaySettings({ mmSize: 'abc', hudScale: 99 }, r2); return r2.style.p; })();
  ok('AF6 没过闸的值写不进画面：脏设置先归位再落 CSS（滑杆后面那条路也挡一次）',
    written2['--mm-size'] === '220px' && Number(written2['--hud-scale']) <= SET_SPEC.hudScale.max, JSON.stringify(written2));
  // 写了没人读 = 改了没生效；读了没人写 = 永远默认。两个方向都数。
  const SET = src('js/settings.mjs');
  const writeSet = [...SET.matchAll(/set\('(--[a-z-]+)'/g)].map(m => m[1]);
  const orphanWrite = writeSet.filter(v => !CSS_ONLY.includes('var(' + v));
  const P4VARS = ['--hud-scale', '--hud-op', '--mm-size', '--cp-pxd', '--cross-col', '--cross-size'];
  const orphanRead = P4VARS.filter(v => !writeSet.includes(v));
  ok('AF7 跨文件对账：settings.mjs 写的变量 CSS 全都读，P4 这六个变量全都由它写（漏一头就是某一格永远不动或永远默认）',
    orphanWrite.length === 0 && orphanRead.length === 0 && writeSet.length === 6,
    `写了没人读:${orphanWrite.join(',') || '无'} 读了没人写:${orphanRead.join(',') || '无'}`);
  ok('AF7b【量具自证】这条对账两个方向都会红：造一个没人读的变量、和一个没人写的变量，它都点名',
    orphanWrite.length === 0
    && ['--nope'].filter(v => !'a{b:var(--real)}'.includes('var(' + v)).length === 1
    && P4VARS.filter(v => !['--hud-scale'].includes(v)).length === P4VARS.length - 1);
  ok('AF8 compassPxd 与 HUD 缩放同向（窗口变宽的同时刻度变密，罗盘读的仍是角度而不是长度）',
    compassPxd({ hudScale: 1 }) === M.COMPASS_PXD && compassPxd({ hudScale: 1.25 }) > compassPxd({ hudScale: 0.8 })
    && compassPxd({}) === M.COMPASS_PXD);
  ok('AF9 MM_SIZE 的默认就是 index.html 画布那两个属性（K6 钉过；这一条钉"设置项的默认"与它同一处）',
    M.MM_SIZE === 220 && M.SETTINGS_DEFAULTS.mmSize === M.MM_SIZE);
}

// ───────────────────────── AG 段：HU-37 键位表与重绑（驱动真函数）─────────────────────────
{
  const K = await import('../js/keybinds.mjs');
  const { BIND_ACTIONS, DEFAULT_BINDS, resolveBinds, sanitizeBinds, applyBind, isBindableCode, anyHeld, keyLabel, bindLabel, bindsOf } = K;
  ok('AG0【表自证】每个动作都有默认键、都有中文名与分组，且默认键全过合法性闸',
    BIND_ACTIONS.every(a => Array.isArray(DEFAULT_BINDS[a.k]) && DEFAULT_BINDS[a.k].length && a.label && a.g)
    && BIND_ACTIONS.every(a => a.def.every(isBindableCode)), `${BIND_ACTIONS.length} 个动作`);
  ok('AG1 Esc 进不了这张表（离开这一屏的唯一出路不许被绑走；绑走的症状是人被锁在界面里）',
    !isBindableCode('Escape') && !BIND_ACTIONS.some(a => a.def.includes('Escape')) && !sanitizeBinds({ scoreboard: ['Escape'] }).scoreboard);
  ok('AG2 非法码与未知动作都进不了存档；与默认一致的条目不存（改了默认值时旧存档不许把它钉死）',
    JSON.stringify(sanitizeBinds({ fwd: ['Bogus', 'KeyG', 'KeyG'], nope: ['KeyZ'], sprint: ['ShiftLeft', 'ShiftRight'] })) === JSON.stringify({ fwd: ['KeyG'] }));
  ok('AG3 resolveBinds(null) 就是默认表的副本，改返回的表不会污染常量表',
    (() => { const B = resolveBinds(null); B.fwd.push('KeyZ'); return DEFAULT_BINDS.fwd.length === 1 && resolveBinds(null).fwd.join() === 'KeyW'; })());
  ok('AG4 重绑闭环：绑到 G 之后 G 才算"前进"，W 不再算（anyHeld 读的就是这一台当前那份）',
    (() => { const B = resolveBinds({ fwd: ['KeyG'] }); return anyHeld({ KeyG: true }, B.fwd) === true && anyHeld({ KeyW: true }, B.fwd) === false; })());
  ok('AG5 一个键只能属于一个动作：已被别人占着就**拒绝**，并说出是谁占着（悄悄顶回默认的话，两个动作同键、按下去只有一个会动）',
    (() => {
      const r = applyBind({}, 'jump', 'KeyA');
      return r.rejected === true && r.tookFrom === '左移' && JSON.stringify(r.binds) === '{}';
    })());
  ok('AG5b 没被占的键正常绑上；改绑自己已经占着的键不算冲突；换键之后旧键立刻失效',
    (() => {
      const a = applyBind({}, 'jump', 'KeyK');
      const self = applyBind({ left: ['KeyK'] }, 'left', 'KeyK');
      const moved = applyBind({ fwd: ['KeyG'] }, 'fwd', 'KeyH');
      return a.rejected === false && a.binds.jump.join() === 'KeyK' && self.rejected === false
        && !moved.binds.fwd.includes('KeyG') && resolveBinds(moved.binds).fwd.join() === 'KeyH';
    })());
  ok('AG5c【反证臂】把 applyBind 换成"直接覆盖不查重"，表上就多出一对抢同一个键的动作（屏上看不出来）',
    (() => {
      const pairs = o => {
        const B = resolveBinds(o), seen = new Map(); let n = 0;
        for (const k of Object.keys(B)) for (const c of B[k]) {
          if (seen.has(c) && seen.get(c) !== k) n++; else seen.set(c, k);
        }
        return n;
      };
      const base = pairs(sanitizeBinds({}));
      return applyBind({}, 'jump', 'KeyA').rejected === true && base === 1 && pairs({ jump: ['KeyA'] }) === base + 1;
    })(), '默认表里那 1 对是 KeyC：蹲伏（按住）与阵亡换配装（按放），不会同拍生效');
  ok('AG6 keyLabel 给得出人话（空格 / 回车 / 左右 Shift 那种，不是把 KeySpace 念给玩家）',
    keyLabel('Space') === '空格' && keyLabel('Enter') === '回车' && keyLabel('ShiftLeft') === '左Shift'
    && keyLabel('Digit5') === '5' && bindLabel(DEFAULT_BINDS.sprint) === '左Shift / 右Shift');
  ok('AG7 bindsOf 三层都兜住（夹具里没有 settings 的场合给 null → 默认表），不是某一层漏了就抛',
    bindsOf(null) === null && bindsOf({}) === null && bindsOf({ settings: {} }) === null && bindsOf({ settings: { binds: { fwd: ['KeyG'] } } }).fwd.join() === 'KeyG');
  // 表上每一个动作都必须**有人读**：漏一个的症状就是玩家在设置里改了它，屏幕上什么也不发生
  // （这正是"那张键位表是静态文字"的反面：静态的可点，但没人接）。
  const SNAP = bodyOf(MAIN_SRC, /\n {2}snapshotInput\(/) || '';
  const SETUP = bodyOf(MAIN_SRC, /\n {2}setupInput\(/) || '';
  const MOVEMENT = ['fwd', 'back', 'left', 'right', 'sprint', 'jump', 'crouch', 'prone', 'leanL', 'leanR', 'reload', 'slot1', 'slot2', 'grenade', 'melee', 'interact', 'nvg'];
  const SCREEN_KEYS = ['scoreboard', 'chatAll', 'chatTeam', 'classChange'];
  const unread = BIND_ACTIONS.map(a => a.k).filter(k => ![...MOVEMENT, ...SCREEN_KEYS, 'streak1', 'streak2', 'streak3'].includes(k));
  const notRead = [
    ...MOVEMENT.filter(k => !new RegExp('anyHeld\\((K|P), B\\.' + k + '\\)').test(SNAP)),
    ...SCREEN_KEYS.filter(k => !new RegExp('B\\.' + k + '\\.includes\\(e\\.code\\)').test(SETUP)),
  ];
  ok('AG8 表里 24 个动作全有读者：17 个在 snapshotInput、4 个在 setupInput、3 个走 streakSlotOf',
    notRead.length === 0 && unread.length === 0, `没人读:${notRead.concat(unread).join(',') || '无'}`);
  ok('AG8b【反证臂】把某一行输入读键代回硬编码 e.code，尺子当场说"这一格没人读了"',
    (() => {
      const back = SNAP.replace('reloadPressed: anyHeld(P, B.reload)', 'reloadPressed: P.KeyR');
      return /reload/.test(SNAP) && !new RegExp('anyHeld\\(P, B\\.reload\\)').test(back);
    })());
  ok('AG9 鼠标与滚轮不进这张表（它们不是 KeyboardEvent.code；进了就会出现"设置里能改侧键，改了没人接"）',
    !BIND_ACTIONS.some(a => a.def.some(c => /Mouse|Wheel/.test(c))) && /firePressed: P\.Mouse0/.test(SNAP));
  ok('AG10 HUD 槽位那一格跟着绑定走（把 1 号槽改绑 Digit8，屏幕上写的就是 [8]）',
    (() => {
      const [h] = mkHud(mkPlayer(), { settings: { binds: { streak1: ['Digit8'] } } });
      h.streaks([{ id: KILLSTREAKS[0].id, ready: true, cost: 3 }], 3);
      const html = rec('streaks').html;
      return html.includes('[8]') && !html.includes('[5]');
    })(), (rec('streaks').html || '').slice(0, 40));
  ok('AG11 syncDisplay 把小地图与罗盘两个数一起落地：canvas 位图、this.mmSize、this.cpPxd、刻度 innerHTML 四处同源',
    (() => {
      const [h] = mkHud(mkPlayer(), { settings: { mmSize: 180, hudScale: 1.25 } });
      const canvas = DOM.getElementById('minimap');
      const strip = rec('compassStrip').html;
      return h.mmSize === 180 && canvas.width === 180 && canvas.height === 180
        && Math.abs(h.cpPxd - 5) < 0.001 && strip.includes('left:75px') && !strip.includes('left:60px');
    })(), '期望 canvas=180·pxd=5·15°=75px');
  ok('AG11b【反证臂】hud.js 里留一份自己的 mmSize 字面量（不与设置同源）就是当年 K6 抓的那种抄本',
    !/this\.mmSize = 220;?\s*$/.test(HUD_SRC.replace(/this\.mmSize = MM_SIZE;/g, 'this.mmSize = 220;')));
  ok('AG12 字幕关掉只停"写进屏幕"那一步，语音播报那条通道不受它管（两个开关各管一件事）',
    (() => {
      const spoken = [];
      const [h, g] = mkHud(mkPlayer(), { settings: { subtitles: false, voice: true } });
      g.audio.say = (t) => spoken.push(t);
      h.subtitle('指挥部', '测试字幕');
      h.subT = 0; h.update(0.001); h.update(0.001);
      return rec('subtitles').html === '' && spoken.includes('测试字幕');
    })(), `html=${JSON.stringify(rec('subtitles').html)}`);
  ok('AG12b 字幕开着时同一拍既写屏幕也念（反方向：AG12 那条不许是"永远不写"）',
    (() => {
      const spoken = [];
      const [h, g] = mkHud(mkPlayer(), { settings: { subtitles: true } });
      g.audio.say = (t) => spoken.push(t);
      h.subtitle('指挥部', '另一句');
      h.subT = 0; h.update(0.001); h.update(0.001);
      return /另一句/.test(rec('subtitles').html) && spoken.includes('另一句');
    })(), rec('subtitles').html.slice(0, 30));
  // 重画 innerHTML 会把旧节点连带它们的监听一起扔掉 —— 这一族在进程内量不到真点击
  // （那是 hud-keys 的 M4b），但"repaint 之后有没有重新绑"这个形状查得到，而查得到就有用：
  // 以后谁把 repaintBinds 改回"只写 HTML"，这里当场红，而不是等到浏览器里发现 23 格是死的。
  const repaintArm = t => {
    const m = /repaintBinds\(\)\s*\{[\s\S]*?\n  \}/.exec(t);
    return !!m && /this\.armBinds\(host\)/.test(m[0]);
  };
  ok('AG13 重画键位表之后重新绑一次监听（innerHTML 一换，旧节点上那些 click 就跟着没了）', repaintArm(MENU_SRC));
  ok('AG13b【反证臂】把那一刀从 repaintBinds 里摘掉，同一把尺子当场认出来',
    !repaintArm(MENU_SRC.replace('this.armBinds(host);', '')));
}

// ───────────────────────── AH 段：HU-39 暂停屏 + HU-37 设置屏的模板（驱动导出函数）─────────────────────────
{
  const MENU = await import('../js/menu.js');
  const { keyHintLines, pauseKeySummary, pauseActions } = MENU;
  ok('AH0【先决】三个导出都是函数（切不到本体下面几条就是遍历空集合的恒绿）',
    [keyHintLines, pauseKeySummary, pauseActions].every(f => typeof f === 'function'));
  const lines = keyHintLines(null).join(' | ');
  ok('AH1 主菜单那三行键位提示是从绑定表算出来的（默认表下每个键各自成名，手写的 "WASD" 那种成组字面量没了）',
    ['W', 'A', 'S', 'D', 'Shift', 'Z', 'Tab', 'F', 'R'].every(t => lines.includes(t)) && /连杀奖励/.test(lines)
    && !lines.includes('>WASD<'), lines.slice(0, 60));
  ok('AH2 改了键，那一行跟着改（当年它是静态文字：玩家把前进绑到 G，屏上还写 W —— HU-01 的换皮）',
    (() => { const back = keyHintLines({ fwd: ['KeyG'] }).join(' '); return back.includes('G') && !/>\s*W\s+</.test(back); })());
  ok('AH2b【反证臂】把这一行退回手写的 WASD 文案，正向尺子当场认出来',
    !keyHintLines({ fwd: ['KeyG'] }).join(' ').includes('G'.repeat(0) + 'WASD') && /WASD<\/span>移动/.test('<span class="kbd">WASD</span>移动'));
  ok('AH3 暂停屏那一小段键位摘要与设置屏同一张表（12 行以内、每行是"键名+动作名"）',
    (() => { const s = pauseKeySummary(null); return s.includes('<b>W</b>前进') && s.includes('Esc') && (s.match(/<div>/g) || []).length >= 8; })(),
    (pauseKeySummary(null) || '').slice(0, 46));
  ok('AH4 暂停屏换了半透的那层底（HU-39：联机的"暂停"是假的，不透明底把比分条、水圈、击杀条全糊掉了）',
    /showPause\(\)[\s\S]{0,6000}'scrim', 'pause'/.test(MENU_SRC)
    && /\.screen\.scrim \{[^}]*rgba\(0,0,0,\.42\)/.test(CSS_ONLY)
    && /\.screen\.solid \{ background: rgba\(6, 8, 9, \.9\)/.test(CSS_ONLY));
  ok('AH4b 暂停屏右侧那一栏读的是**同一份**数据源（mode.scoreboardHTML / net.netStatusText），不抄第二份比分格式',
    /mode && mode\.scoreboardHTML \? mode\.scoreboardHTML\(\)/.test(MENU_SRC) && /g\.net\.netStatusText \? g\.net\.netStatusText\(\)/.test(MENU_SRC));
  ok('AH4c 那一栏自己活着：500ms 一拍，而且**暂停那一支真的在喂这一拍**（paused 时 state 仍是 play，menu.update 不会被调）',
    /pauseTick\(dt\)\s*\{/.test(MENU_SRC) && /_pauseAcc >= 0\.5/.test(MENU_SRC)
    && /this\._pauseSig = undefined/.test(MENU_SRC)
    && /if \(this\.paused\) this\.menu\.pauseTick\(rdt\)/.test(MAIN_SRC));
  ok('AH4c2【反证臂·跨文件】写了 pauseTick 却没人调 = 那一栏照样冻在按下 Esc 那一刻，同一把尺子当场认出来',
    !/pauseTick\(rdt\)/.test(MAIN_SRC.replace('this.menu.pauseTick(rdt)', '')));
  ok('AH4d【反证臂】把进屏时的签名作废那一刀摘掉，就是"右侧那一栏空着"那一族（render 换了节点、门却认为没变）',
    !/_pauseSig = undefined/.test(MENU_SRC.replace('this._pauseSig = undefined;', '')));
  ok('AH5 设置屏的行由表出（menu.js 里不再有手写的 min/max/step 那三件套）',
    !/rng\('fov'|tog\('invertY'|data-q="1"|data-cap="1"/.test(MENU_SRC) && MENU_SRC.includes('SET_GROUPS.map'));
  ok('AH6 键位恢复默认那一格存在，且走的是同一条落地路径（不是"清掉存档再刷新"那种）',
    /data-a="breset"/.test(MENU_SRC) && /settings\.binds = \{\}/.test(MENU_SRC) && /commit\('binds'\)/.test(MENU_SRC));
  ok('AH7 bindsPanel 的按钮带 aria-label（按钮的字面内容只是一个键名，读屏念不出它是什么动作）',
    /aria-label="\$\{a\.label\}，当前 \$\{cur\}/.test(MENU_SRC) && MENU_SRC.includes('data-bind="${a.k}"'));
  ok('AH8 捕获态优先于 escBack（否则改键那一秒按 Esc 想取消，却被退出设置屏）',
    /if \(this\.capturing\) \{ this\.captureKey\(e\); return; \}/.test(MENU_SRC)
    && MENU_SRC.indexOf('this.capturing') < MENU_SRC.indexOf("e.code === 'Escape' && game.paused"));
  ok('AH8b【反证臂】把那条优先分支挪到 Esc 之后，顺序尺子当场认出来',
    (() => { const t = MENU_SRC.replace('if (this.capturing) { this.captureKey(e); return; }', ''); return t.indexOf('this.capturing') > t.indexOf("e.code === 'Escape' && game.paused"); })());
}

// ───────────────────────── AI 段：用户实测报的两条（大厅 .opts 错位 · 全服频道不清理）─────────────────────────
// 这两条不在原审计那 41 条里，是**用户拿截图报的**，所以从症状倒推：
//   ① 联网大厅左栏"大乱"：地图/模式/时长/目标四行选项挤成一根竖条、标签浮到右边、那一栏被撑到 ~1000px；
//   ② 全服频道消息永远不清理：前一晚那几条刷屏第二天进大厅还在聊天框里。
// ①的**几何**那一半在 test/hud-keys.mjs（真浏览器，量 left/height）—— 这里量的是它的成因：
//   .opts 是「标签列 + 控件列」逐格交替的自动排版，任何**没有标签的控件**必须自己声明
//   grid-column:2；少这一句它落进第 1 列，后面每一对 (标签, 控件) 就整体错开一格。
// ②分两半：服务端那份（回填/说一句/发历史三处）在 test/room-flow.mjs 的 F 段，驱动的是 Lobby 本体；
//   这里量客户端这一半 —— 画上去的那一份，以及"开着不动的那一屏怎么自己老化"。
{
  const MENU = await import('../js/menu.js');
  const { freshChat, CHAT_TTL_MS, chatRowHtml } = await import('../js/net/chat.mjs');
  const LB_SRC = src('js/net/lobby.mjs'), SRV_LOBBY_SRC = src('server/lobby.mjs');

  // ── ① .opts 的自动排版契约 ──
  // 读法（不抄 markup）：从真源码里抠出「#joinRoomId 那一行的开标签属性」。抠不到就红 ——
  // 静默给空串的话，这条会变成"检查一段不存在的 markup"而永远绿。
  const joinRowAttrs = (t) => {
    const m = /<(div|section)([^>]*)>\s*<input id="joinRoomId"/.exec(t);
    return m ? m[2] : null;
  };
  const declaresCol2 = (attrs) => !!attrs && (/class="[^"]*\bopt-ctl\b/.test(attrs) || /grid-column\s*:\s*2/.test(attrs));
  const attrs = joinRowAttrs(MENU_SRC);
  const segsWanted = ['segMap', 'segMode', 'segMin', 'segScore'].filter(id => MENU_SRC.includes(`seg('${id}'`));
  ok('AI1【先决】抠得到"按房号加入"那一行的开标签、且大厅那一栏真是「四行 标签 + 选择器」的形状（抠不到 / 形状变了，下面那条就该红，而不是恒绿）',
    !!attrs && segsWanted.length === 4 && ['地图', '模式', '时长', '目标'].every(t => MENU_SRC.includes(`<div>${t}</div>`)),
    `attrs=${String(attrs).slice(0, 40)}·segs=${segsWanted.length}/4`);
  ok('AI2 那一行自己声明了 grid-column:2（它是"只有控件、没有标签"的行；少了这一句它占掉第 1 列，后面四对标签/选择器全部错开一格 —— 屏幕上的样子就是选项挤成一根竖条、标签浮到右边、那栏高到 998px）',
    declaresCol2(attrs), String(attrs).slice(0, 60));
  ok('AI2b【反证臂】把那一格退回错位前的写法（裸 div + style=display:flex，不带 opt-ctl）→ 同一把尺子当场认出来',
    !declaresCol2('<div style="display:flex;gap:8px">') && declaresCol2('<div class="opt-ctl">')
    && !declaresCol2(null));
  ok('AI2c 那条 CSS 规则真在（.opts .opt-ctl 定 grid-column:2）—— markup 上写了类而样式里没有这一条，等于没写',
    /\.opts\s+\.opt-ctl\s*\{[^}]*grid-column\s*:\s*2/.test(CSS_ONLY));
  ok('AI2d【反证臂】把那条规则从 CSS 里摘掉，同一把尺子当场认出来',
    !/\.opts\s+\.opt-ctl\s*\{[^}]*grid-column\s*:\s*2/.test(CSS_ONLY.replace(/\.opts \.opt-ctl \{[^}]*\}/, '')));

  // ── ② 全服频道的时间窗：一份定义、三处读者 ──
  const readsFresh = (t) => /from '[^']*chat\.mjs'/.test(t) && /\bfreshChat\b/.test(t);
  const CALLERS = [['js/menu.js', MENU_SRC], ['js/net/lobby.mjs', LB_SRC], ['server/lobby.mjs', SRV_LOBBY_SRC]];
  const missing = CALLERS.filter(([, t]) => !readsFresh(t)).map(([f]) => f);
  ok('AI3【先决】时间窗只有一份定义，三处读者都从 js/net/chat.mjs 取它（屏幕这一份、大厅客户端那一份、服务端那一份）—— 三处各写一个数就会出现"服务端清掉了、屏幕上还留着"',
    Number.isFinite(CHAT_TTL_MS) && CHAT_TTL_MS > 0 && typeof freshChat === 'function' && missing.length === 0,
    `TTL=${CHAT_TTL_MS}ms·没读到的是 ${JSON.stringify(missing)}`);
  const brokenMenu = [['js/menu.js', MENU_SRC.replace("from './net/chat.mjs'", "from './nowhere.mjs'")],
    ['js/net/lobby.mjs', LB_SRC], ['server/lobby.mjs', SRV_LOBBY_SRC]];
  ok('AI3b【反证臂·跨文件】把菜单那一处换成别的模块：同一把尺子当场点名是 js/menu.js（不是只说"有东西不对"）',
    !readsFresh(brokenMenu[0][1]) && brokenMenu.filter(([, t]) => !readsFresh(t)).map(([f]) => f).join() === 'js/menu.js');

  const T = Date.now();
  const R = (text, ageMs) => ({ ch: 'lobby', from: '甲', name: '甲', text, at: T - ageMs });
  const buf = [R('八小时前', 8 * 3600e3), R('三小时前', 3 * 3600e3), R('一分钟前', 60e3)];
  ok('AI4 窗外丢掉、窗内留着：8 小时前与 3 小时前那两条走，一分钟前那条在（条数上限只管"最多几行"，管不住"多旧的行"—— 用户报的就是后者）',
    freshChat(buf, T).map(x => x.text).join() === '一分钟前', JSON.stringify(freshChat(buf, T).map(x => x.text)));
  ok('AI4b【判别臂·旧写法】同一份缓冲走"只按条数裁"的旧管线（slice(-40)）会画出 3 条 —— AI4 的绿来自时间窗，不是条数顺手裁掉的',
    buf.slice(-40).length === 3 && freshChat(buf, T).length === 1);
  ok('AI4c 边界与 fail-open：正好卡在窗口上那一条算过期、窗口内 1ms 算活着；**定不了日期的行保留**（丢别人的话是不可见的失效）；非数组给空数组',
    freshChat([R('卡线', CHAT_TTL_MS)], T).length === 0
    && freshChat([R('差1ms', CHAT_TTL_MS - 1)], T).length === 1
    && freshChat([{ text: '没有 at' }, { text: 'at 是 NaN', at: NaN }], T).length === 2
    && freshChat(null, T).length === 0 && freshChat(undefined, T).length === 0);

  // ── ③ 画上去的那一份 + 开着不动的那一屏 ──
  const box = mk('lbChat');
  const lb = lbStub();
  lb.chat = buf.slice();
  const { m } = menuStub({ lb, el: { querySelector: s => (s === '#lbChat' ? box : null), querySelectorAll: () => [] } });
  const drawn = () => (String(box.__rec.html).match(/class="chat-line/g) || []).length;
  m.renderChat(m.el, 'lobby');
  ok('AI5 进屏画的那一份也不含窗外的行：#lbChat 里只有 1 条（老写法会把 3 条全画上去 —— 用户截图里那几条"跨了 8 小时还在最上面"就是这么来的）',
    drawn() === 1, `画出 ${drawn()} 条`);
  ok('AI5b【反证臂·同一把尺子量旧管线】把这一份缓冲交给旧管线（rows.slice(-40) 逐条渲染），同一把尺子数出 3 条 —— 归因到时间窗',
    buf.slice(-40).filter(x => chatRowHtml(x, { muted: [] })).length === 3);

  // chatTick：开着的这一屏自己老化。先是"喂了没有"（写了不喂 = 这一屏永远不老化），再是三档行为。
  ok('AI6【命门·跨方法】Menu.update() 里真的喂了 chatTick（与 pauseTick 同一个位置）—— 写了不喂的话这一屏永远不老化；反证臂把那一行摘掉，同一把尺子当场认出来',
    /this\.chatTick\(dt\)/.test(MENU_SRC) && /this\.pauseTick\(dt\);\s*\n\s*this\.chatTick\(dt\);/.test(MENU_SRC)
    && !/this\.chatTick\(dt\)/.test(MENU_SRC.replace('this.chatTick(dt);', '')));
  const live = R('刚好过期', 0);
  lb.chat = [live];
  m.renderChat(m.el, 'lobby');
  const w0 = box.__rec.writes;
  m.chatTick(0.5);
  const wHalf = box.__rec.writes;
  m.chatTick(0.6);
  const wSame = box.__rec.writes;
  live.at = T - 11 * 60e3;                       // 推出窗外
  m.chatTick(1.1);
  const wAged = box.__rec.writes;
  ok('AI7 三档行为一次量齐：不到 1 秒不跑（0.5s 无写）· 满 1 秒但这一屏没老（签名没变，不重画）· 真老掉了就重画一次且那一行从 DOM 掉出去',
    wHalf === w0 && wSame === w0 && wAged === w0 + 1 && drawn() === 0,
    `writes ${w0}→${wHalf}→${wSame}→${wAged}·剩 ${drawn()} 条`);
  m._chatSig = '错的签名';                        // 人为把门弄拧：证明"没重画"是门挡住的，不是 tick 没跑
  m.chatTick(1.2);
  ok('AI7b 签名门真的在起作用：把它人为拧错，同一拍立刻重画（少了这一条，AI7 的"没重画"分不清是门挡住的还是那一拍根本没跑）',
    box.__rec.writes === wAged + 1, `writes ${wAged}→${box.__rec.writes}`);
  ok('AI7c 离开这一屏就归零（`_chatAcc`/`_chatSig` 都清）—— 不回零的话下一次进大厅会凭上一屏的签名判定"这一屏没变过"，那一屏就停在旧内容上',
    (() => { m.screen = 'main'; m.chatTick(2); return m._chatAcc === 0 && m._chatSig === '' && box.__rec.writes === wAged + 1; })());
}

// ───────────────────────── AJ 段：联网里选得到「占领」（HU-44 · 用户报"是不是还没有占点模式"）─────────────────────────
// 服务端与规则内核一直是支持占点的（room-flow 的 dom 那几段、mp-rules 的 O 段都在量它），
// 战役/单机屏也一直选得到。缺的是**界面**：大厅与房间屏各多了一句"模式按当前地图藏"，
// 而「占领」只在「双丘战区」、双丘战区只在占领（js/data.js 两侧互为专属）——
// 两边互相设门就是死锁：dune 上 dom 被藏、tdm 下 ridges 被藏，玩家点遍屏幕上所有看得见的格子
// 也到不了这一对。所以这一段的被测对象不是"某个字符串在不在"，而是**可达性**：
// 从默认态出发、只许点屏幕上看得见的格子，枚举报到得了哪些 (模式, 图)。
{
  const { mapAllowed, mapsForMode, MP_MAPS, MP_MODES } = await import('../js/data.js');
  const ONLINE = MP_MODES.filter(m => m.net).map(m => m.id);
  ok('AJ0【先决·跨文件对账】线上模式表就是 MP_MODES 里 net 的那几个，而且**每个模式至少有一张图**（两个屏的"落回该模式第一张图"都靠这条不变量；dom↔ridges 互为专属是这一条的现场）',
    /const ONLINE_MODES = MP_MODES\.filter\(m => m\.net\);/.test(MENU_SRC)
    && ONLINE.length === MP_MODES.length
    && MP_MODES.every(m => mapsForMode(m.id).length > 0)
    && !mapAllowed('dune', 'dom') && !mapAllowed('ridges', 'tdm') && mapAllowed('ridges', 'dom'),
    `线上模式 ${JSON.stringify(ONLINE)}·每模式的图 ${JSON.stringify(MP_MODES.map(m => m.id + ':' + mapsForMode(m.id).length))}`);

  // 可达性枚举。两个规则只差一处：**模式那一行按不按当前图藏**。
  // 「点一格模式之后图会不会跟着迁」在两个规则里是同一句（syncSegs 里那一句没动过），
  // 所以枚举里也共用同一句 —— 差的就只有"这一格看得见吗"。
  const reachable = (modesFilteredByMap) => {
    const start = ['tdm', 'dune'];
    const seen = new Set([start.join('|')]);
    const q = [start];
    while (q.length) {
      const [mode, map] = q.shift();
      const modes = modesFilteredByMap ? ONLINE.filter(m => mapAllowed(map, m)) : ONLINE;
      for (const m of modes) {
        const ms = mapsForMode(m);
        const nm = (mapAllowed(map, m) || !ms.length) ? map : ms[0].id;   // syncSegs 的迁移那一句
        const k = m + '|' + nm;
        if (!seen.has(k)) { seen.add(k); q.push([m, nm]); }
      }
      for (const mp of MP_MAPS) {
        if (!mapAllowed(mp.id, mode)) continue;
        const k = mode + '|' + mp.id;
        if (!seen.has(k)) { seen.add(k); q.push([mode, mp.id]); }
      }
    }
    return seen;
  };
  const oldReach = reachable(true), newReach = reachable(false);
  const hasMode = (set, m) => [...set].some(k => k.split('|')[0] === m);
  const hasMap = (set, m) => [...set].some(k => k.split('|')[1] === m);
  ok('AJ1【复现用户报的那一条】按**旧规则**（模式也跟着当前图藏）从默认的 (团队死斗, 沙丘镇) 出发：占领与双丘战区**一个都到不了** —— 玩家把屏幕上所有看得见的格子点遍也不行（这句话就是"联网里没有占点"的成因）',
    !hasMode(oldReach, 'dom') && !hasMap(oldReach, 'ridges'),
    `可达 ${[...oldReach].join(' ')}`);
  ok('AJ1b【修复的定义】同一把尺子、同一出发点，把模式那一行的过滤摘掉（只按模式藏图）：占领与双丘战区**都到得了**（这一条与 AJ1 是同一条判据的两个方向，缺一个就分不清"修好了"与"量具没接上"）',
    hasMode(newReach, 'dom') && hasMap(newReach, 'ridges') && newReach.has('dom|ridges'),
    `可达 ${[...newReach].join(' ')}`);

  // 两个屏各自的那一句（进程内驱动不了这几格的点击：夹具的 innerHTML 不解析，见 test/hud-ux.mjs 头注；
  // **真点击那一半在 test/hud-keys.mjs 的 L11**）。
  const hidesModeByMap = t => /for \(const m of ONLINE_MODES\) togg\('segMode'/.test(t);
  ok('AJ2 大厅那一屏不再"按当前图藏模式"（只按模式藏图）—— 那多出来的一句正是死锁的另一半',
    !hidesModeByMap(MENU_SRC)
    && /for \(const m of MP_MAPS\) togg\('segMap', m\.id, mapAllowed\(m\.id, L\.mode\)\);/.test(MENU_SRC));
  ok('AJ2b【反证臂】把那一句代回大厅的 syncSegs，同一把尺子当场认出来',
    hidesModeByMap(MENU_SRC.replace("for (const m of MP_MAPS) togg('segMap', m.id, mapAllowed(m.id, L.mode));",
      "for (const m of MP_MAPS) togg('segMap', m.id, mapAllowed(m.id, L.mode));\n      for (const m of ONLINE_MODES) togg('segMode', m.id, mapAllowed(L.map, m.id));")));
  ok('AJ3 房间屏的模式那一行也不再按当前图滤（`roomModes` 就是三张常驻卡；按图滤的话 dune/tdm 房里只剩 tdm，还会退化成 cfg-one 那句陈述，房主换不到占领）',
    /const roomModes = ONLINE_MODES;/.test(MENU_SRC) && !/const roomModes = ONLINE_MODES\.filter/.test(MENU_SRC));
  ok('AJ3b【反证臂】把按图滤那一版代回去，同一把尺子当场认出来',
    /const roomModes = ONLINE_MODES\.filter/.test(MENU_SRC.replace('const roomModes = ONLINE_MODES;',
      "const roomModes = ONLINE_MODES.filter(m => mapAllowed(room.map, m.id));")));

  const modeClick = (/if \(key === 'mode'\) \{[\s\S]*?\n        \}/.exec(MENU_SRC) || [''])[0];
  ok('AJ4 房间内换模式那一支把"这一帧过后的组合"一起发出去：mode + map + minutes + scoreLimit（只发 mode 的话，互为专属那一对里另一头还停在旧值上，服务端按并起来的组合当场拒 —— 玩家看到的只是"点了没反应"；minutes/scoreLimit 不归位的话，房间标题上那两个数字从此是假的）',
    /setCfg\(\{ mode: v, map, minutes, scoreLimit \}\)/.test(modeClick)
    && /mapsForMode\(v\)/.test(modeClick) && /DEFAULT_MINUTES\(v\)/.test(modeClick) && /DEFAULT_SCORE_LIMIT\(v\)/.test(modeClick),
    modeClick.slice(0, 40).replace(/\s+/g, ' '));
  ok('AJ4b【反证臂】把那一支退回"只发单格"的老写法，同一把尺子当场认出来',
    !/setCfg\(\{ mode: v, map, minutes, scoreLimit \}\)/.test(
      modeClick.replace('setCfg({ mode: v, map, minutes, scoreLimit })', 'setCfg({ [key]: v })')));
}

// ───────────────────────── 收口 ─────────────────────────
const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
if (bad.length) for (const [, label] of bad) console.log(`     ↳ ${label}`);
process.exit(bad.length ? 1 : 0);
