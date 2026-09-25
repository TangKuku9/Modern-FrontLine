// 浏览器环境垫片：让 js/ 下的同一份代码在 Node 里原样跑起来。
// 必须在任何 js/ 模块之前 import（ESM 按 import 顺序求值）。
//
// 设计原则：这里只补"代码真正会碰到的"最小面，不做通用 DOM 模拟。
// 依据是实测的调用点：textures.js:45/238/277、world.js:694 各建一个 canvas，
// materials.js:119 读 window.__matMiss，除此之外 sim 路径不碰任何浏览器 API。

class ShimCanvas {
  constructor(w = 0, h = 0) { this.width = w; this.height = h; }
  getContext(kind) {
    if (kind !== '2d') throw new Error('browser-shim: 只实现了 2d context，被请求 ' + kind);
    return shimCtx;
  }
  toDataURL() { return 'data:,'; }
}

// 2D context 的全部被调用成员（服务端不关心画出来的是什么，只要不抛）
const gradient = { addColorStop() {} };
const shimCtx = {
  canvas: null,
  fillStyle: '#000', strokeStyle: '#000', font: '10px sans-serif',
  textAlign: 'left', textBaseline: 'alphabetic', lineWidth: 1, globalAlpha: 1,
  globalCompositeOperation: 'source-over', filter: 'none',
  fillRect() {}, strokeRect() {}, clearRect() {},
  beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {},
  bezierCurveTo() {}, quadraticCurveTo() {}, rect() {},
  fill() {}, stroke() {}, clip() {},
  save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {},
  drawImage() {},
  fillText() {}, strokeText() {},
  measureText: (t) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
  createLinearGradient: () => gradient,
  createRadialGradient: () => gradient,
  createPattern: () => null,
  putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
};

export function installBrowserShim() {
  const g = globalThis;
  // 真浏览器里不装。这个垫片补的是"Node 缺的那半套环境"，浏览器本来就有 ——
  // 而 Window.document 是只读访问器，一句 g.document = doc 直接把模块求值抛掉。
  // net-trace.html 在浏览器里 import sim-twin.mjs 时正是撞在这上面（xenv 曾因此长红）。
  // 跳过而不是改写：跨环境一致性这一测要的就是浏览器**原样**跑这份代码。
  if (typeof g.document !== 'undefined' && typeof g.window !== 'undefined' && g.window === g && g.document.createElement) return null;
  if (g.__browserShimInstalled) return g.__browserShimStats();
  const counts = { createElement: 0, getContext: 0 };

  const doc = {
    createElement: (tag) => {
      counts.createElement++;
      if (tag === 'canvas') {
        const c = new ShimCanvas();
        const orig = c.getContext.bind(c);
        c.getContext = (k) => { counts.getContext++; const x = orig(k); x.canvas = c; return x; };
        return c;
      }
      return { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, appendChild() {}, addEventListener() {}, remove() {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, textContent: '', innerHTML: '' };
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    documentElement: { clientWidth: 1920, clientHeight: 1080, style: {} },
    body: { appendChild() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } },
  };

  g.document = doc;
  g.window = g;
  g.self = g;
  if (!g.ImageData) g.ImageData = class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  if (!g.OffscreenCanvas) g.OffscreenCanvas = ShimCanvas;
  if (!g.navigator) g.navigator = { userAgent: 'node-headless', hardwareConcurrency: 8, language: 'zh-CN' };
  if (!g.localStorage) {
    const store = new Map();
    g.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };
  }
  g.__browserShimInstalled = true;      // 上面那个空判据靠这一行才成立
  g.__browserShimStats = () => counts;
  return counts;
}

export { ShimCanvas };
installBrowserShim();
