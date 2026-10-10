// HUD / UI「界面不许说谎」判据。对应 docs/hud-ux-audit.md 的第一批：
// HU-01（连杀键位三处口径）· HU-02（联机死亡画面写着不存在的键）·
// HU-04 + HU-21（reset 漏归位签名门与选点卡片）· HU-38（同一格文案三处各拼一遍）·
// HU-03（掉线文案被 nowrap 裁掉）· HU-06 第一半（菜单键盘可达）。
//
// 这一层和 js/net/remote.mjs 那一族是同一个病：**全都不影响权威状态**，不崩不报错，
// 症状只有玩家看得出来 —— 照屏幕提示按键、叫出来的是别的连杀；某一格整局空白；
// 死亡画面让你按一个从不被读的键。所以量具必须量**到 DOM 的那根线**，
// 光量"源码里有没有那句话"证明的是文案，不是界面。
//
// 三条纪律（照 test/net-feel.mjs 的写法）：
//   ① 每条源码形状的判据都配**同文件反证臂**：把改掉的那一处按旧写法代回去，检查器必须
//      当场认出来（B5b / B6b / D3b / E5）。只在合成夹具上演的反证不算 —— 夹具能红不代表
//      真文件里那把尺子在读真文件。
//   ② 量具先自证活着：A 段先证明假 DOM 的 innerHTML 计数器真的在数、签名门在不 reset 时
//      真的会跳过写。少了这一条，C1 的"reset 之后写得回去"可能只是桩根本没接到 DOM。
//   ③ 前提写进判据：E 段先证服务端那道闸还在（requestRespawn 只在 respawnT ≤ 0.12s 认），
//      因为 HU-02 改成的"到点自动部署"这句话**靠它才成立**；哪天闸开了，这一条要红着提醒。
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

// ───────────────────────── 假 DOM：innerHTML 的写次数就是读数 ─────────────────────────
const CTX = new Proxy({}, { get: () => () => { } });
function makeDom() {
  const els = new Map();
  const mk = id => {
    const rec = { writes: 0, html: '' };
    return {
      id, __rec: rec, style: {}, dataset: {}, textContent: '', scrollTop: 0, scrollHeight: 0, children: [],
      classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
      appendChild() { }, remove() { }, addEventListener() { }, setAttribute() { },
      querySelector: () => null, querySelectorAll: () => [], getContext: () => CTX,
      get innerHTML() { return rec.html; },
      set innerHTML(v) { rec.writes++; rec.html = String(v); },
    };
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

// ───────────────────────── 收口 ─────────────────────────
const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);
