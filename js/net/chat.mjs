// 聊天的纯逻辑：命令解析、屏蔽过滤、时间戳。菜单屏（大厅/房间）与对局 HUD 共用这一份 ——
// 两边各写一套 "/mute 到底认哪个词" 的症状是"在大厅屏蔽了、进对局又开始收他刷屏"，
// 不报错，只是同一个人在两个界面上有两种待遇。
//
// 这里只做**判定**，不做 IO：发什么帧归上层（js/net/client.mjs / js/net/lobby.mjs），
// 画成什么样归各屏自己的渲染。判定和接线分开，才测得起"哪一条会被屏蔽"这件事本身。

// 输入法保护（差距 44）：中文/日文选词时的回车是"上屏"，不是"发送"。isComposing 是
// 标准信号，keyCode 229 是部分旧 IME/浏览器唯一的回退信号。少这一句就会把半成品发出去 ——
// 而"打一句中文发出去变成一串拼音"这种问题，玩家只会怪自己手快。
// 曾经只长在 js/menu.js 里；对局内的聊天输入也要同一把尺子（两个定义迟早会分叉）。
export const isImeKey = (e) => !!(e && (e.isComposing || e.keyCode === 229));

// 聊天行的 HTML。菜单屏（大厅/房间）与对局 HUD 共用这一份 —— 各画各的会出现
// "大厅里有时间戳、对局里没有"这种只在两个界面之间才看得见的差异。
// muted 时返回**空串**：屏蔽是渲染侧的事（名单不上行，见 toggleMute 的注释），
// 所以"看不见"只有这一个实施点，漏一处就是"屏蔽了还能看见他说话"。
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function chatRowHtml(x, opts = {}) {
  if (!x) return '';
  if (!x.sys && isMuted(x.from || x.name, opts.muted)) return '';
  const t = `<i class="ct-time">${chatTime(x.at)}</i>`;
  if (x.sys) return `<div class="chat-line sys">${t}${esc(x.text)}</div>`;
  const mine = opts.mine ? ' me' : '';
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
//   {op:'unknown', text}               以 / 开头但认不出 —— 回一句提示，别当发言发出去
//                                      （发出去的话房间里会看到一行 "/mut 甲"，没人知道发生了什么）
const COMMANDS = {
  mute: 'mute', 屏蔽: 'mute',
  unmute: 'unmute', 解除屏蔽: 'unmute',
  muted: 'muted', 屏蔽列表: 'muted',
  report: 'report', 举报: 'report',
};
export function parseChatCommand(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { op: 'say', text: '' };
  if (text[0] !== '/') return { op: 'say', text };
  const m = /^\/(\S+)\s*(.*)$/.exec(text);
  const op = m ? COMMANDS[m[1].toLowerCase()] : null;
  if (!op) return { op: 'unknown', text };
  const rest = (m[2] || '').trim();
  if (op === 'muted') return { op };
  // 名字到下一个空格为止：呼号白名单不放行空白（服务端 flat 会把连续空白拍平），
  // 所以"第一个词就是名字"这句话成立 —— 空出来的 reason 允许为 0 个词。
  const nm = /^(\S+)\s*(.*)$/.exec(rest);
  const name = nm ? nm[1] : '';
  const reason = op === 'report' ? String(nm ? nm[2] || '' : '').trim().slice(0, 60) : '';
  if (!name) return { op: 'unknown', text };
  return { op, name, reason };
}
