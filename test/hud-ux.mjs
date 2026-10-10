// HUD / UI「界面不许说谎」判据。对应 docs/hud-ux-audit.md 两批：
//   第一批（P0）HU-01（连杀键位三处口径）· HU-02（联机死亡画面写着不存在的键）·
//     HU-04 + HU-21（reset 漏归位签名门与选点卡片）· HU-38（同一格文案三处各拼一遍）·
//     HU-03（掉线文案被 nowrap 裁掉）· HU-06 第一半（菜单键盘可达）。
//   第二批（P1）H=HU-07 血量数字 · I=HU-11 空仓 · J=HU-14 受击方向 · K=HU-09 越界指示 + HU-10 地图记号 ·
//     L=HU-15 我方存活 · M=HU-08 常驻网络读数 · N=HU-12 连杀拒收回执 · O=HU-41 走人提示进聊天框 ·
//     P=HU-10 来袭记账 · Q=HU-13 连杀命中音。
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
import { STREAK_KEYS, STREAK_KEY_LABELS, streakKeyLabel, streakSlotOf } from '../js/data.js';
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
    doc: {
      getElementById: get, createElement: t => mk('dyn:' + t),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() { },
      documentElement: { clientWidth: 1920, clientHeight: 1080, style: {} }, body: mk('body'),
    },
  };
}
const { doc: DOM, rec } = makeDom();
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
  MENU_SRC.includes('STREAK_KEY_LABELS') && !hardcodedStreak(MENU_SRC));
ok('B5b【反证臂】把派生代回旧字面量，同一把尺子当场认出来',
  hardcodedStreak(MENU_SRC.replace("${STREAK_KEY_LABELS.join('/')}", '5/6/7')));

const MP_SRC = src('js/mp.js'), NET_SRC = src('js/net/client.mjs');
const oldAnnounce = t => t.includes('按 [${i + 3}]');
ok('B6 单机与联机的就绪播报都走 streakKeyLabel（`i + 3` 不许回潮）',
  MP_SRC.includes('按 [${streakKeyLabel(i)}]') && NET_SRC.includes('按 [${streakKeyLabel(i)}]')
  && !oldAnnounce(MP_SRC) && !oldAnnounce(NET_SRC));
ok('B6b【反证臂】把 mp.js 那一处代回 i + 3，检查器必须认得出',
  oldAnnounce(MP_SRC.replace('按 [${streakKeyLabel(i)}]', '按 [${i + 3}]')));
ok('B7 绑定侧也收成一处（snapshotInput 不再各写一份 Digit5/6/7 三元）',
  src('js/main.js').includes('streak: streakSlotOf(P)') && !src('js/main.js').includes('P.Digit5 ? 0 :'));

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

// ───────────────────────── K 段：HU-09 越界指示 / HU-10 地图上的雷 ─────────────────────────
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
  g.projectiles = [{ alive: true, type: 'frag', owner: { team: 'B' }, pos: { x: 5, y: 1, z: -5 } }];
  tr.length = 0; sets.length = 0; h.drawMinimap();
  ok('K3 来袭爆炸物在地图上有自己的记号（HU-10：这张图以前只有人）', tr.length === 3, `记号数=${tr.length - 1}`);
  ok('K3b 记号的颜色与敌我两点都不同款（同色就读不出"那是颗雷"）',
    sets.includes('#ff9a2a'), JSON.stringify(sets.slice(0, 6)));
  g.projectiles = [{ alive: true, type: 'frag', owner: pl, pos: { x: 5, y: 1, z: -5 } }];
  tr.length = 0; h.drawMinimap();
  ok('K4 自己扔的那一颗不画（你知道自己往哪儿扔的，多一个记号只是噪音）', tr.length === 2);
  g.projectiles = [{ alive: true, type: 'smoke', owner: { team: 'B' }, pos: { x: 5, y: 1, z: -5 } }];
  tr.length = 0; h.drawMinimap();
  ok('K4b 非致命弹（烟雾）不算来袭记号（把致盲弹报成"快跑"是狼来了）', tr.length === 2);
  ok('K5 #mmLabel 有读数了（过去是死 DOM：HTML 里留了格子，JS 从不写）',
    rec('mmLabel').text === '半径 45m', rec('mmLabel').text);
  const mmSize = +(HUD_SRC.match(/const MM_SIZE = (\d+)/) || [])[1];
  const canvasAttr = /<canvas id="minimap" width="(\d+)" height="(\d+)"/.exec(HTML_SRC);
  ok('K6 绘制尺寸与 <canvas> 的 width/height 是同一个数（抄两份的话一边画 220、一边裁 200）',
    !!canvasAttr && +canvasAttr[1] === mmSize && +canvasAttr[2] === mmSize, `hud.js=${mmSize}·html=${canvasAttr && canvasAttr[1]}`);
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
  ok('M7 三格都挂在 update() 上（每拍驱动的是它们自己，不是只在记分板里才刷）',
    /this\.teamReadout\(\); this\.netReadout\(\); this\.nadeWatch\(\);/.test(HUD_SRC));
  ok('M7b【反证臂】把这一行删掉 ⇒ 三个方法都成了死代码，尺子认得出',
    !/this\.teamReadout\(\); this\.netReadout\(\); this\.nadeWatch\(\);/.test(HUD_SRC.replace('this.teamReadout(); this.netReadout(); this.nadeWatch();', '')));
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

// ───────────────────────── P 段：HU-10 来袭警告的记账 ─────────────────────────
{
  const nade = (owner, dist = 5, type = 'frag') => ({
    alive: true, type, owner,
    pos: { x: dist, y: 1, z: dist, distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); } },
  });
  const [h1, g1, p1] = mkHud();
  g1.projectiles = [nade({ team: 'B' })];
  h1.nadeWatch();
  ok('P1 别人扔的雷进了杀伤距离 ⇒ 屏幕上有一次警告（HU-10：过去只有炸的那一刻才知道）',
    p1.length === 1 && p1[0] === '手雷！', JSON.stringify(p1));
  h1.nadeWatch(); h1.nadeWatch();
  ok('P2 一颗只喊一次（每拍喊的话 popup 连成常亮，读数和噪音一个样）', p1.length === 1);
  const [h2, g2, p2] = mkHud();
  g2.projectiles = [nade({ team: 'B' }, 60)];
  h2.nadeWatch();
  ok('P2b NADE_NEAR 之外不喊：远处那颗与我无关', p2.length === 0);
  const [h3, g3, p3] = mkHud();
  g3.projectiles = [nade(g3.player)];
  h3.nadeWatch();
  ok('P3 自己扔的那一颗不喊', p3.length === 0);
  const [h4, g4, p4] = mkHud();
  g4.projectiles = [nade({ team: 'B' }, 5, 'semtex'), nade({ team: 'B' }, 4, 'rocket')];
  h4.nadeWatch();
  ok('P4 弹种各有各的话（粘性炸弹与 RPG 不该都叫"手雷"）',
    p4.length === 2 && p4[0] === '粘性炸弹！' && p4[1] === 'RPG 来袭！', JSON.stringify(p4));
  const [h5, g5, p5] = mkHud();
  g5.projectiles = [nade({ team: 'B' }, 5, 'smoke'), nade({ team: 'B' }, 5, 'flash')];
  h5.nadeWatch();
  ok('P4b 非致命弹不报警（闪光/烟雾喊"快跑"喊两次就没人信了）', p5.length === 0);
  const [h6, g6, p6] = mkHud();
  const same = nade({ team: 'B' }, 5);
  g6.projectiles = [same];
  h6.nadeWatch();
  h6.reset();
  g6.projectiles = [same];
  h6.nadeWatch();
  ok('P5 新局开局后同一颗还在飞的雷要重新喊（reset 漏归位那本账 = 症状与 HU-04 同族）',
    p6.length === 2, `喊过 ${p6.length} 次`);
  ok('P5b【复发闸】reset 里确实归位了"已喊过哪几颗"那本账（C4 那条泛化闸只盯 *Sig，这本要单独钉）',
    /_nadeWarned = new Set\(\)/.test(RESET_BODY));
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

// ───────────────────────── 收口 ─────────────────────────
const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
if (bad.length) for (const [, label] of bad) console.log(`     ↳ ${label}`);
process.exit(bad.length ? 1 : 0);
