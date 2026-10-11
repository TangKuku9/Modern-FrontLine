// ── 键位：物理按键 → 语义动作的唯一一份表（HU-37）──
//
// 为什么值得单独一个模块：这张表以前住在两个地方 —— `js/main.js:snapshotInput` 里那串
// `K.KeyW / P.Digit4 / P.Mouse3` 的字面量，和设置屏/主菜单那两张**静态文字**键位表
// （写着"WASD 移动"，改不了也核对不了）。玩家能改的那一半与程序实际读的那一半分开住，
// 就是 HU-01 那一族（一份键位事实，四种写法）的复发条件。
// 现在绑定是数据：输入层查这张表，键位表也查这张表，重绑改的是表本身。
//
// 一条刻意留在表外的：`sprint` 与 `crouch` 各有两个默认键（左右 Shift、C 与左 Ctrl），
// 因为"按住任一个"是同一个动作；`Mouse3`（近战侧键）与滚轮（切枪）不是 KeyboardEvent.code，
// 留在 main.js 里按鼠标事件读，不许进这张表 —— 进了就会有人以为侧键也能在设置里改。
// 还有 `classChange`（阵亡时换配装）默认与 `crouch` 同为 KeyC：一个是活着时按住、
// 一个是死了之后按一下，两者不会同拍生效，所以这个重叠是设计而不是冲突。

// 不可重绑的那一个：Esc。它是"离开这一屏"的唯一出路 —— 菜单、暂停、设置、重绑捕获态
// 全靠它兜底。允许玩家把 Esc 绑走，最坏情况是打不开暂停菜单也退不出捕获态（人被锁在界面里）。
export const FIXED_KEYS = { Escape: '暂停 / 返回上一层（不可重绑）' };

// def = 默认的物理键码数组（任一按下即触发）。label = 设置屏上那一行的名字。
export const BIND_ACTIONS = [
  { k: 'fwd', g: '移动', label: '前进', def: ['KeyW'] },
  { k: 'back', g: '移动', label: '后退', def: ['KeyS'] },
  { k: 'left', g: '移动', label: '左移', def: ['KeyA'] },
  { k: 'right', g: '移动', label: '右移', def: ['KeyD'] },
  { k: 'sprint', g: '移动', label: '战术冲刺', def: ['ShiftLeft', 'ShiftRight'] },
  { k: 'jump', g: '移动', label: '跳跃', def: ['Space'] },
  { k: 'crouch', g: '移动', label: '蹲伏', def: ['KeyC', 'ControlLeft'] },
  { k: 'prone', g: '移动', label: '趴下 / 起身', def: ['KeyZ'] },
  { k: 'leanL', g: '移动', label: '左探头', def: ['KeyQ'] },
  { k: 'leanR', g: '移动', label: '右探头', def: ['KeyE'] },
  { k: 'reload', g: '战斗', label: '换弹', def: ['KeyR'] },
  { k: 'slot1', g: '战斗', label: '主武器（1）', def: ['Digit1'] },
  { k: 'slot2', g: '战斗', label: '副武器（2）', def: ['Digit2'] },
  { k: 'grenade', g: '战斗', label: '切出投掷物', def: ['Digit4'] },
  { k: 'melee', g: '战斗', label: '近战', def: ['KeyV'] },
  { k: 'interact', g: '交互', label: '互动 / 拾取', def: ['KeyF'] },
  { k: 'nvg', g: '交互', label: '夜视仪', def: ['KeyN'] },
  { k: 'scoreboard', g: '界面', label: '记分板（按住）', def: ['Tab'] },
  { k: 'chatAll', g: '界面', label: '全体聊天', def: ['Enter', 'NumpadEnter'] },
  { k: 'chatTeam', g: '界面', label: '队伍聊天', def: ['KeyY'] },
  { k: 'classChange', g: '界面', label: '阵亡换配装', def: ['KeyC'] },
  // 连杀槽位。这三行是 HU-01 的那一盏灯：播报里的数字、槽位自绘的数字、实际生效的键
  // 必须同源，所以它们进同一张表，而不是留在 js/data.js 里当常量。
  { k: 'streak1', g: '连杀奖励', label: '连杀奖励 1 号槽', def: ['Digit5'] },
  { k: 'streak2', g: '连杀奖励', label: '连杀奖励 2 号槽', def: ['Digit6'] },
  { k: 'streak3', g: '连杀奖励', label: '连杀奖励 3 号槽', def: ['Digit7'] },
];

export const STREAK_SLOTS = ['streak1', 'streak2', 'streak3'];

const BY_ACTION = new Map(BIND_ACTIONS.map(a => [a.k, a]));
export const bindAction = k => BY_ACTION.get(k) || null;

// 默认表：action → 键码数组（复制一份，调用方改不动这张常量表）
export const DEFAULT_BINDS = Object.fromEntries(BIND_ACTIONS.map(a => [a.k, [...a.def]]));
// 连杀槽位的默认键码（HUD 与判据都从这里取，不再各写一份 'Digit5'）
export const STREAK_KEYS = STREAK_SLOTS.map(k => DEFAULT_BINDS[k][0]);
export const STREAK_KEY_LABELS = STREAK_KEYS.map(code => keyLabel(code));

// 一个键码长什么样才配写进表里。鼠标与滚轮不在内（见文件头那条注释）。
const CODE_RE = /^(Key[A-Z0-9]|Digit[0-9]|Numpad([0-9]|Enter|Add|Subtract|Decimal|Multiply|Divide)|F([1-9]|1[0-2])|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|CapsLock|NumLock|ScrollLock|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|IntlBackslash|Semicolon|Quote|Comma|Period|Slash)$/;
export const isBindableCode = c => typeof c === 'string' && CODE_RE.test(c) && c !== 'Escape';

// 屏幕上的短名字（键帽与键位表用的都是它，别再拼第二份 switch）
export function keyLabel(code) {
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code); if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code); if (m) return '小键盘' + m[1];
  m = /^F(\d{1,2})$/.exec(code); if (m) return 'F' + m[1];
  const names = {
    Space: '空格', Tab: 'Tab', Enter: '回车', NumpadEnter: '小键盘回车', Backspace: '退格',
    Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl', ControlRight: '右Ctrl',
    AltLeft: '左Alt', AltRight: '右Alt', MetaLeft: '左Win', MetaRight: '右Win',
    CapsLock: 'Caps', NumLock: 'Num', ScrollLock: 'Scroll',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', IntlBackslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return names[code] || code;
}

// 设置屏那一行的文案：'W' / '左Shift + 右Shift'
export function bindLabel(codes) {
  return (codes || []).map(keyLabel).join(' / ');
}

// 存档里的 binds 段归位：只认表里有的动作、只认合法的键码，每组最多 3 个键、去重；
// 与默认一致的条目直接不存（省得以后改默认值时被旧存档钉死）。
export function sanitizeBinds(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const a of BIND_ACTIONS) {
    const v = src[a.k];
    if (!Array.isArray(v)) continue;
    const codes = [...new Set(v.filter(isBindableCode))].slice(0, 3);
    if (!codes.length) continue;                        // 全被过滤掉 = 这一格等于没写，不许留一份空表
    if (codes.join('|') !== a.def.join('|')) out[a.k] = codes;
  }
  return out;
}

// 完整表 = 默认 + 存档覆盖（每次读都新建，返回的表随便改）
export function resolveBinds(overrides) {
  const out = {};
  for (const a of BIND_ACTIONS) {
    const v = overrides && overrides[a.k];
    out[a.k] = Array.isArray(v) && v.length ? [...v] : [...a.def];
  }
  return out;
}

// 把 action 绑到 code。**别的动作已经占着这个键就拒绝**，并说出是谁占着。
// 不做"悄悄把对方顶回默认"那一套：对方的默认键往往正好是被抢的那个，顶回默认等于没顶，
// 表上两个动作同一个键、按下却只有一个会动 —— 那种谎玩家只会当成游戏吞了他的键。
// 返回 { binds, tookFrom, rejected }：rejected 为真时 binds 原样返回（一个字节都没改）。
export function applyBind(overrides, action, code) {
  const cur = sanitizeBinds(overrides || {});
  const a = bindAction(action);
  if (!a || !isBindableCode(code)) return { binds: cur, tookFrom: '', rejected: true };
  const B = resolveBinds(cur);
  const owner = BIND_ACTIONS.find(o => o.k !== action && B[o.k].includes(code));
  if (owner) return { binds: cur, tookFrom: owner.label, rejected: true };
  cur[action] = [code];
  return { binds: sanitizeBinds(cur), tookFrom: '', rejected: false };
}

// 按键表 → 这个动作此刻按住了没有。K/P 是 main.js 那份原始 e.code 表。
export const anyHeld = (table, codes) => !!table && !!codes && codes.some(c => table[c]);

// 从 game 上取"这一台现在这份绑定"。四个读取点（HUD 槽位、单机播报、联机播报、输入层）
// 都要它，各写一份 `game && game.settings && game.settings.binds` 就是四种写法 ——
// 少写一层的那个的症状是重绑之后只有某一处跟着变，另一处还在念旧键。
// 取不到（夹具、没进过对局）就返回 null，resolveBinds(null) 给默认表。
export const bindsOf = game => (game && game.settings && game.settings.binds) || null;

// ── 连杀槽位（HU-01 的那两把尺子从这里出）──
export const streakCodes = binds => STREAK_SLOTS.map(k => resolveBinds(binds)[k][0]);
export const streakKeyLabels = binds => streakCodes(binds).map(keyLabel);
export const streakKeyLabel = (i, binds) => keyLabel(streakCodes(binds)[i]) || '';
// 按下的是哪个槽（-1 = 没按）。判据可以直接喂一份按键表进来量，不必 grep 某个调用点。
export function streakSlotOf(pressed, binds) {
  const codes = streakCodes(binds);
  for (let i = 0; i < codes.length; i++) if (pressed && pressed[codes[i]]) return i;
  return -1;
}
