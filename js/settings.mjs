// ── 设置的一张表：默认值、合法区间、屏幕上的那一行、以及改完往哪儿落（HU-37）──
//
// 为什么值得单独一个模块：改动前这一份事实住在三处 —— `js/main.js` 构造函数里那个
// 裸的 `Object.assign({...默认}, JSON.parse(localStorage))`、设置屏里每行**手写的**
// min/max/step、以及各读取点自带的假设（`world.js` 甚至给一个谁都没设过的 `maxLights`
// 留了兜底）。三处的口径一旦分叉，症状就是这一族的老毛病：屏上能选出一个引擎不接受的值
// （FOV 选到 0 就是除零），或者存了却没生效的那一格。
// 现在这张表是唯一的真相：屏从它行长，存档过它归位，`applyDisplaySettings` 是它落到
// 画面上的那唯一一处。
import { sanitizeBinds } from './keybinds.mjs';

// 罗盘每度多少像素。窗口宽度、刻度位置、屏幕中心那一格的偏移全都由它算出来
// （以前是三份硬编码：style.css 的 460、hud.js 的 230、和 `* 4`）。
export const COMPASS_PXD = 4;
// 小地图默认边长 —— 与 index.html 里 <canvas id="minimap" width height> 同一个数（K6 钉的就是它）。
export const MM_SIZE = 220;

export const CROSS_COLORS = {
  白: '#f2f2f2', 绿: '#7fe07f', 黄: '#ffd23f', 红: '#ff5a4a', 青: '#4fe3ff',
};

// type: num（滑杆）/ bool（开关系）/ enum（一排选项）/ binds（键位表，屏上另有专门一块）
export const SET_SPEC = {
  quality: { type: 'enum', g: '画面', label: '画面质量', def: 'high', opts: [['low', '低'], ['medium', '中'], ['high', '高']] },
  fpsCap: { type: 'enum', g: '画面', label: '帧率上限', def: 0, opts: [[0, '不锁'], [144, '144'], [120, '120'], [60, '60'], [30, '30']] },
  fov: { type: 'num', g: '画面', label: '视野 (FOV)', min: 65, max: 100, step: 1, def: 78 },
  shadowsNote: { type: 'note', g: '画面', text: '阴影与纹理质量将在下次载入地图后生效。' },

  hudScale: { type: 'num', g: 'HUD', label: 'HUD 缩放', min: 0.8, max: 1.25, step: 0.05, def: 1, fmt: 'pct' },
  hudOpacity: { type: 'num', g: 'HUD', label: 'HUD 不透明度', min: 0.5, max: 1, step: 0.05, def: 1, fmt: 'pct' },
  mmSize: { type: 'num', g: 'HUD', label: '小地图尺寸', min: 160, max: 280, step: 4, def: MM_SIZE, fmt: 'px' },
  crossColor: { type: 'enum', g: 'HUD', label: '准星颜色', def: '白', opts: Object.keys(CROSS_COLORS).map(k => [k, k]) },
  crossSize: { type: 'num', g: 'HUD', label: '准星臂长', min: 4, max: 16, step: 1, def: 9, fmt: 'px' },
  crossGap: { type: 'num', g: 'HUD', label: '准星间距', min: 0, max: 14, step: 1, def: 4, fmt: 'px' },
  subtitles: { type: 'bool', g: 'HUD', label: '字幕', def: true },
  showFps: { type: 'bool', g: 'HUD', label: '显示帧数', def: true },

  volume: { type: 'num', g: '音频', label: '主音量', min: 0, max: 1, step: 0.01, def: 0.8, fmt: 'pct' },
  volSfx: { type: 'num', g: '音频', label: '音效', min: 0, max: 1, step: 0.01, def: 1, fmt: 'pct' },
  volAmbient: { type: 'num', g: '音频', label: '环境声', min: 0, max: 1, step: 0.01, def: 1, fmt: 'pct' },
  volVoice: { type: 'num', g: '音频', label: '语音播报', min: 0, max: 1, step: 0.01, def: 1, fmt: 'pct' },
  voice: { type: 'bool', g: '音频', label: '语音播报开关', def: true },

  sens: { type: 'num', g: '操作', label: '鼠标灵敏度', min: 0.2, max: 3, step: 0.05, def: 1.0, fmt: 'x2' },
  adsSens: { type: 'num', g: '操作', label: '开镜灵敏度倍率', min: 0.3, max: 1.5, step: 0.05, def: 0.9, fmt: 'x2' },
  mouseAccel: { type: 'bool', g: '操作', label: '鼠标加速', def: false },
  invertY: { type: 'bool', g: '操作', label: '反转 Y 轴', def: false },
  binds: { type: 'binds', g: '操作', label: '按键重绑定', def: {} },
};

// 不在屏上、但仍要认的键：模拟步长的开关（测试与 netdebug 用），存档里有就认。
const HIDDEN = { fixedStep: { type: 'bool', def: true } };

export const SET_GROUPS = (() => {
  const order = ['画面', 'HUD', '音频', '操作'];
  const g = {};
  for (const [k, s] of Object.entries(SET_SPEC)) {
    if (!s.g) continue;
    (g[s.g] = g[s.g] || { t: s.g, rows: [] }).rows.push(k);
  }
  return order.filter(t => g[t]).map(t => g[t]);
})();

export const SETTINGS_DEFAULTS = Object.fromEntries(
  [...Object.entries(SET_SPEC), ...Object.entries(HIDDEN)]
    .filter(([, s]) => s.def !== undefined)
    .map(([k, s]) => [k, s.type === 'binds' ? {} : s.def]));

const num = (v, d, min, max) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

// 一份可能来自玩家自己编辑过的 localStorage 的对象 → 只认表里的键、只给合法值。
// 与 `repairClass`（存档里的枪 id）同一条理由：不合法的设置不该走到引擎里，
// 也不该因为"屏上写着 65–100"就假定存档里的 fov 在 65–100。
export function sanitizeSettings(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const [k, s] of Object.entries({ ...SET_SPEC, ...HIDDEN })) {
    const v = src[k];
    if (s.type === 'num') out[k] = num(v, s.def, s.min, s.max);
    else if (s.type === 'bool') {
      if (typeof v === 'boolean') out[k] = v;
      else if (v === 'true' || v === 1 || v === '1') out[k] = true;
      else if (v === 'false' || v === 0 || v === '0') out[k] = false;
      else out[k] = s.def;
    } else if (s.type === 'enum') {
      // 认手改过的存档里那个 "144"（我们自己写盘只写数字，但 mf_settings 是玩家能编辑的文件）：
      // 按字符串比对，**发出去的是表里那一个值**，所以 fpsCap 落回数字 144 而不是字符串。
      const hit = s.opts.map(([ov]) => ov).find(ov => ov === v || String(ov) === String(v));
      out[k] = hit === undefined ? s.def : hit;
    } else if (s.type === 'binds') out[k] = sanitizeBinds(v);
  }
  return out;
}

// 读存档：解析失败（手改坏的文件、被截断的 JSON）不能把整页停在"初始化失败"，
// 那种症状以前是拿 try/catch 在调用方兜的，现在收在这里。
export function loadSettings(storage) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem('mf_settings') || '{}'); } catch { raw = null; }
  return sanitizeSettings(raw);
}

// 表里那些 fmt 码 → 屏上怎么写。滑杆的 value 与读数是同一份设置的两张脸，
// 所以格式化也只能有一处（以前 menu.js 里有个只有 4 个键的 fmts 表，新增一行就少一个）。
export function formatValue(k, v) {
  const s = SET_SPEC[k];
  if (!s) return String(v);
  if (s.fmt === 'pct') return String(Math.round(v * 100));
  if (s.fmt === 'x2') return (+v).toFixed(2);
  if (s.fmt === 'px') return Math.round(v) + 'px';
  return String(v);
}

// 罗盘的每度像素数跟着 HUD 缩放走：窗口变宽的同时刻度必须变密，否则"115° 的窗口"
// 这个数会被拉成"看起来每度更宽"，而罗盘读数是角度不是长度。
export const compassPxd = s => COMPASS_PXD * num(s && s.hudScale, 1, SET_SPEC.hudScale.min, SET_SPEC.hudScale.max);

// 画面上那几格落地的唯一一处：只写 CSS 自定义属性，不碰任何权威状态。
// 谁改了设置就调它一次（设置屏、进对局、初始化），DOM 里没有第二处写这些变量的地方。
export function applyDisplaySettings(s, root = (typeof document !== 'undefined' ? document.documentElement : null)) {
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return s;
  const s2 = sanitizeSettings(s);
  const set = (k, v) => root.style.setProperty(k, v);
  set('--hud-scale', String(s2.hudScale));
  set('--hud-op', String(s2.hudOpacity));
  set('--mm-size', Math.round(s2.mmSize) + 'px');
  set('--cp-pxd', String(compassPxd(s2)));
  set('--cross-col', CROSS_COLORS[s2.crossColor] || CROSS_COLORS['白']);
  set('--cross-size', s2.crossSize + 'px');
  // 没有 --cross-gap：准星的**间距**是四根臂的位移，由 hud.js 每帧按扩散算（读的是
  // 同一份 settings.crossGap），CSS 里没有谁读它。写一个没人读的变量就是"改了没生效"的另一种形态。
  return s2;
}
