// 聊天的纯逻辑：命令解析、屏蔽过滤、时间戳。菜单屏（大厅/房间）与对局 HUD 共用这一份 ——
// 两边各写一套 "/mute 到底认哪个词" 的症状是"在大厅屏蔽了、进对局又开始收他刷屏"，
// 不报错，只是同一个人在两个界面上有两种待遇。
//
// 这里只做**判定**，不做 IO：发什么帧归上层（js/net/client.mjs / js/net/lobby.mjs），
// 画成什么样归各屏自己的渲染。判定和接线分开，才测得起"哪一条会被屏蔽"这件事本身。

// 转义器只有一份（js/escape.js，M10）。这一份原来是全仓最全的那一份，另外两处
// （js/main.js / js/menu.js）各是它的一个**缺斤少两的副本** —— 收成一份之后这里
// 只留一个别名，行的形状与内容一个字节都不变。
import { escHtml as esc } from '../escape.js';

// 输入法保护（差距 44）：中文/日文选词时的回车是"上屏"，不是"发送"。isComposing 是
// 标准信号，keyCode 229 是部分旧 IME/浏览器唯一的回退信号。少这一句就会把半成品发出去 ——
// 而"打一句中文发出去变成一串拼音"这种问题，玩家只会怪自己手快。
// 曾经只长在 js/menu.js 里；对局内的聊天输入也要同一把尺子（两个定义迟早会分叉）。
export const isImeKey = (e) => !!(e && (e.isComposing || e.keyCode === 229));

// 表情动作（差距 45 的"无表情"）：**白名单**，两端共读这一份 —— 服务端按它校验、
// 客户端按它认别名。抄两份的症状是"客户端认、服务端拒"（按了没反应）。
// 为什么不放开自由文本动作（IRC /me 那种）：动作行是"某某做了什么"的陈述句，
// 自由文本等于允许替别人造句；白名单内的动作都是自己对自己说的。
export const EMOTES = [
  { id: 'salute', words: ['敬礼', 'salute'], text: '敬了个礼' },
  { id: 'lol', words: ['笑', 'lol'], text: '笑了出来' },
  { id: 'cry', words: ['哭', 'cry'], text: '哭了出来' },
  { id: 'thumbs', words: ['赞', 'thumbs'], text: '竖了个大拇指' },
  { id: 'clap', words: ['鼓掌', 'clap'], text: '鼓起了掌' },
  { id: 'shrug', words: ['无奈', 'shrug'], text: '摊了摊手' },
];
export const emoteByWord = (w) => EMOTES.find(e => e.id === w || e.words.includes(w)) || null;

// 聊天行的 HTML。菜单屏（大厅/房间）与对局 HUD 共用这一份 —— 各画各的会出现
// "大厅里有时间戳、对局里没有"这种只在两个界面之间才看得见的差异。
// muted 时返回**空串**：屏蔽是渲染侧的事（名单不上行，见 toggleMute 的注释），
// 所以"看不见"只有这一个实施点，漏一处就是"屏蔽了还能看见他说话"。
export function chatRowHtml(x, opts = {}) {
  if (!x) return '';
  if (!x.sys && isMuted(x.from || x.name, opts.muted)) return '';
  const t = `<i class="ct-time">${chatTime(x.at)}</i>`;
  if (x.sys) return `<div class="chat-line sys">${t}${esc(x.text)}</div>`;
  const mine = opts.mine ? ' me' : '';
  if (x.ch === 'emote') return `<div class="chat-line emote">${t}* ${esc(x.from || x.name || '')}${esc(x.text || '')}</div>`;
  if (x.ch === 'whisper') {
    // 私聊行只到两个人手上（发送者 + 目标，服务端只发这两条），所以这里不用再筛"给谁看"
    return `<div class="chat-line whisper">${t}<b class="${mine.trim()}">${esc(x.from || x.name || '')}</b><i class="cw">悄悄 › ${esc(x.to || '')}</i><span>${esc(x.text || '')}</span></div>`;
  }
  const team = x.ch === 'team' ? ' team' : '';
  return `<div class="chat-line${team}">${t}<b class="${mine.trim()}">${esc(x.from || x.name || '')}</b><span>${esc(x.text || '')}</span></div>`;
}

// 时间戳：只画 时:分。聊天行是"刚才那句话"的语境，秒数是噪声；日期更没必要 ——
// 一局最多打十几分钟，跨天的行不存在（历史不落盘，见差距 45 仍未收的那几项）。
export function chatTime(at) {
  const d = new Date(at || Date.now());
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 屏蔽判定：按**名字**。理由与服务端"身份只认座位上那份"同源 —— 聊天行里能拿来
// 标识对方的只有名字（快照是定长的，名字进不去二进制）。名字是服务端白名单洗过的，
// 所以精确匹配就够，不需要再做归一化（大小写/全半角都出不了白名单那一层）。
export function isMuted(from, muted) {
  return !!from && Array.isArray(muted) && muted.includes(from);
}

// 切换屏蔽名单（不重复、不留空）。返回新数组 —— 直接改 profile 里那个再 saveProfile
// 也行，但返回新值让调用方决定什么时候落盘，判定本身可测。
export function toggleMute(muted, name, on) {
  const out = (Array.isArray(muted) ? muted : []).filter(n => n !== name);
  if (on) out.push(name);
  return out;
}

// 聊天框里的斜杠命令。返回形状：
//   {op:'say', text}                   普通发言（含空串 = 什么都没说，上层别发帧）
//   {op:'mute'|'unmute', name}         屏蔽 / 解除（**纯客户端**：过滤发生在渲染侧，
//                                      不上行 —— 服务端不该知道"谁不想看谁"，
//                                      那是一份会把人际纠纷变成服务端状态的名单）
//   {op:'muted'}                       列一遍当前屏蔽着谁
//   {op:'report', name, reason}        举报（要上行，服务端记档，见 net-server 的 doReport）
//   {op:'whisper', name, text}         私聊：/w 名字 内容、/私聊、或 @名字 内容（只到对面手上）
//   {op:'emote', name}                 表情动作（name 是白名单里的 id，见 EMOTES）
//   {op:'unknown', text}               以 / 开头但认不出 —— 回一句提示，别当发言发出去
//                                      （发出去的话房间里会看到一行 "/mut 甲"，没人知道发生了什么）
const COMMANDS = {
  mute: 'mute', 屏蔽: 'mute',
  unmute: 'unmute', 解除屏蔽: 'unmute',
  muted: 'muted', 屏蔽列表: 'muted',
  report: 'report', 举报: 'report',
  w: 'whisper', whisper: 'whisper', 私聊: 'whisper',
  emote: 'emote', 表情: 'emote',
};
export function parseChatCommand(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { op: 'say', text: '' };
  // @名字 内容 = 私聊（与 /w 同一条路）。只有 @名字 没有内容不算 ——
  // 发一条空私聊出去，对面看到的是一行没有字的"悄悄"，不如当场说清楚。
  if (text[0] === '@') {
    const m = /^@(\S+)\s*(.+)$/.exec(text);
    return m ? { op: 'whisper', name: m[1], text: m[2].trim().slice(0, 120) } : { op: 'unknown', text };
  }
  if (text[0] !== '/') return { op: 'say', text };
  const m = /^\/(\S+)\s*(.*)$/.exec(text);
  const head = m ? m[1].toLowerCase() : '';
  const rest = (m[2] || '').trim();
  const op = COMMANDS[head];
  if (op === 'whisper') {
    const nm = /^(\S+)\s+(.+)$/.exec(rest);
    return nm ? { op, name: nm[1], text: nm[2].trim().slice(0, 120) } : { op: 'unknown', text };
  }
  if (op === 'emote') {
    const e = emoteByWord(rest.split(/\s+/)[0] || '');
    return e ? { op, name: e.id } : { op: 'unknown', text };
  }
  if (!op) {
    // 裸表情别名：/敬礼（第一词本身就是表情词，后面没有别的字）
    const e = emoteByWord(head);
    if (e && !rest) return { op: 'emote', name: e.id };
    return { op: 'unknown', text };
  }
  if (op === 'muted') return { op };
  // 名字到下一个空格为止：呼号白名单不放行空白（服务端 flat 会把连续空白拍平），
  // 所以"第一个词就是名字"这句话成立 —— 空出来的 reason 允许为 0 个词。
  const nm = /^(\S+)\s*(.*)$/.exec(rest);
  const name = nm ? nm[1] : '';
  const reason = op === 'report' ? String(nm ? nm[2] || '' : '').trim().slice(0, 60) : '';
  if (!name) return { op: 'unknown', text };
  return { op, name, reason };
}
