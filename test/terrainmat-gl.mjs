// 地表材质判据（test/terrainmat-gl.mjs）—— 浏览器那一半：真编译、真像素。
//
// 离线那一半（test/terrainmat.mjs 的 M1..M5，31 条）已经钉住了：掩膜契约 / 字节序 / 崖平分辨 /
// 边界侵蚀 / 确定性 / 补丁六个锚点命中 / 对照开关真的翻 uniform。**它没法钉的只有真 GL**：
//   G1 程序是否真的编译过 —— 尤其"渲染器有没有调用过 onBeforeCompile"。离线那份是**手工调**
//      一遍才拿到 hits 的，那是"补丁写了但从没接上"这类失效唯一的现场证据。
//   G2 渲染链路是否真的在出图。本仓库的真事故：驱动里给 composer.render 打桩后忘了还原，之后
//      所有渲染都是 no-op，而动画循环照样跑出 230fps、readPixels 全零 —— "两张全黑"也能差出
//      9.1 万个噪声像素。所以这条闸必须排在所有像素判据之前，而且每条像素判据的**条件里**都
//      带着亮度闸（不是"先跑一次就完事"，结构上挡住那种假绿）。
//   G3 对照臂：同一机位、同一帧间隔，setOn(true) 与 setOn(false) 各渲一帧、各读一次像素，必须显著不同。
//   G4 崖面高频能量：splat on 必须高于 off —— 量的是"岩贴图 + 三向投影确实在起作用"，不是颜色变了。
//   G5 细节法线按视距退场：近景必须显著改变像素，俯瞰的同一对差值必须明显更小。
//   G6 落盘截图（俯瞰 / 崖面成对 / 平地成对）。
//
// 截图通路：`composer.render()` 之后**紧接 `gl.readPixels`**，node 侧自写 PNG（不走 canvas→drawImage /
// toDataURL，也不依赖合成器呈现 —— 那两条在本仓库都抓过旧帧）。为什么它抓的就是我刚画的那一帧，
// 三条证据都编进了判据：
//   ① 同状态重复帧差分 ≈0（抓到缓存旧帧的话它不会跟着 uniform 翻）；
//   ② 翻一次 uSplatOn 读数立刻跟着变（G3b）；
//   ③ 写盘后的 PNG 由**页面里的独立解码器**（createImageBitmap + 2D canvas getImageData）读回来，
//      尺寸与逐通道校验和必须等于我刚量过的那一帧（G6a）—— 编码器写错、或抓的是别的帧，当场红。
//
// 纪律照 test/terrain.mjs / test/terrainmat.mjs：正向断言必配反证臂或先决臂；丢了 WebGL 上下文
// 一律判红（丢了之后所有像素判据都是 no-op）；退出码就是判据。
// swiftshader 很慢：视口 960×540、quality:'low'（贴图 256）、全程约 20 帧手动渲染，实测 11 秒跑完。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { withServer } from './with-server.mjs';

// GL 参数照 test/optic.mjs:30-40 —— `--use-gl=swiftshader` 那一套会**在页面启动阶段就丢上下文**，
// 而丢了以后一切像素判据都是 no-op（本仓库真的因此误判过）。必须是 angle + swiftshader。
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
async function launch() {
  const tries = [
    ['chrome', { channel: 'chrome', args: ARGS }],
    ['playwright-chromium', { args: ARGS }],
    ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }],
  ];
  for (const [label, opts] of tries) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('没有可用浏览器');
}

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
const T0 = Date.now();
const lap = (s) => console.log(`  [${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`);
const NUM = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

// ── 门槛（写死在这里，实测读数随每条一起打进报告）──
const MIN_BRIGHT = 20;   // 平均亮度下限（0..255）：全黑=0，"链路空转"就是这个症状
const MIN_CALLS = 50;    // draw call 下限：整张丘陵 + 阴影是几百个；空转时后处理那几个全屏 quad 才个位数
const MAD_ABS = 2.0;     // "显著不同"的绝对下限：逐像素 RGB 绝对差均值 ≥2/255 每通道（960×540 上读得出）
const NOISE_K = 20;      // 并且至少是同状态重复帧噪声地板的 20 倍（分母由 G2c 现量，不是抄来的数）
const MAD_MIN_RATIO = 0.25;  // G5b：远景差值必须收到近景的 1/4 以下才算"淡出在起作用"

// ── 最小 PNG 编码器（只用 node 内置：无新依赖）──
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
// rgba：自上而下、alpha 已归一 255 的 Buffer（页面里翻好行序再传，这里只做编码）。
// 走 color type 6（RGBA）而不是 2（RGB）：后者要逐像素拆通道，第一版图省事按行整段 copy，
// 于是每行只搬了 W*3 字节 = 前 80% 的像素，行与行之间累积错位 —— 解出来是一幅竖条纹的
// 假图，而"独立解码器校验和"那条判据正好把它捡回来了（它红得有理：编码器写错了）。
function writePng(path, W, H, rgba) {
  const stride = 1 + W * 4, raw = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * W * 4, y * W * 4 + W * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

let browser, srv, page;
const errs = [];
const ctx = [];           // 各阶段上下文丢失打点（丢了就必须让判据变红而不是变绿）
try {
  browser = await launch();
  page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console.error] ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('mf_settings', JSON.stringify({ quality: 'low' }));
    HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.resolve(); };
  });
  srv = await withServer();
  await page.goto(srv.base + '/index.html');
  await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 180000 });
  lap('菜单就绪');

  // state 仍是 'menu'：菜单那支循环会把 renderPass.scene/camera 指回 menu 的 3D 场景，
  // 所以①先停掉动画循环（不停它在两帧之间自己重画并推进世界，对照臂量到的就不是我翻的那个开关），
  // ②手动渲染的每一次都自己把 renderPass 指回 game.scene / game.camera（见 S.render）。
  await page.evaluate(() => { window.game.renderer.setAnimationLoop(null); });

  // ── 页面侧工装 ──
  await page.evaluate(() => {
    const g = window.game, gl = g.renderer.getContext();
    const S = {
      frames: {}, stats: {},
      lost: () => gl.isContextLost(),
      splat: () => g.world.terrainMesh.material.userData.splat,
      render() {
        g.renderPass.scene = g.scene; g.renderPass.camera = g.camera; g.vmPass.enabled = false;
        // renderer.info 的自重置发生在**每次 renderer.render() 开头**，而 composer 一帧要调它
        // 四五次（阴影 + 主场景 + 后处理全屏 quad）。不关 autoReset 的话，手动渲染完读到的
        // calls 只是最后那个 quad 的 1 —— 实测 calls=1、三角=1，那条"calls > 50"的闸就成了
        // 量具读错了量。这里关掉自重置、每帧自己 reset 一次，读到的才是"整帧"的 draw call。
        g.renderer.info.autoReset = false;
        g.renderer.info.reset();
        g.composer.render(0.016);
      },
      place(x, z, eye, yawDeg, pitchDeg) {
        g.camera.rotation.order = 'YXZ';
        g.camera.position.set(x, g.world.groundHeight(x, z, 40, 0.4) + eye, z);
        g.camera.rotation.set((pitchDeg || 0) * Math.PI / 180, (yawDeg || 0) * Math.PI / 180, 0);
        g.camera.updateMatrixWorld(true);
      },
      placeLook(x, z, eye, t) {
        g.camera.rotation.order = 'YXZ';
        g.camera.position.set(x, g.world.groundHeight(x, z, 40, 0.4) + eye, z);
        g.camera.lookAt(t[0], t[1], t[2]); g.camera.updateMatrixWorld(true);
      },
      cam(name) {
        const SP = window.__SPOTS[name];
        if (!SP) return false;
        // 俯瞰那张要换视场角：360m 整张图必须在框内，而 78° 竖直视场下这点高度装不下
        // （雾会把远距离的色带冲成一片白）。fov 只影响取景，不影响任何判据的量纲，出框后还原。
        g.camera.fov = SP.fov || g.settings.fov; g.camera.updateProjectionMatrix();
        if (SP.sky) {   // 俯瞰：正俯 —— 360m 整张图进框，且**每一块可见地面的视距都在相机高度以上**
          g.camera.rotation.order = 'YXZ';
          g.camera.position.set(0, SP.h, 0);
          g.camera.rotation.set(-Math.PI / 2, 0, 0);
          g.camera.updateMatrixWorld(true);
        } else if (SP.tgt) S.placeLook(SP.cam[0], SP.cam[1], SP.eye, SP.tgt);
        else S.place(SP.cam[0], SP.cam[1], SP.eye, SP.yaw, SP.pitch);
        return true;
      },
      // 一帧：渲染 + 同一个 JS task 里立刻 readPixels（不经合成器）+ 现算指标
      shot(tag) {
        S.render();
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const raw = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const lum = new Float32Array(W * H);
        let sum = 0;
        for (let p = 0, i = 0; p < lum.length; p++, i += 4) { const L = 0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2]; lum[p] = L; sum += L; }
        // 高频能量 = 亮度两向差分绝对值的均值。GL 行序自下而上 ⇒ [0, kH) 这几行是**屏幕下 k 分带**。
        // 三条带一起量，是因为掠射角会把 off 那侧的草贴图打出锯齿（那是在**给反方加分**）：
        // 越靠画面底部地面越近、草图被放大成糊块而岩图仍带裂隙 → 比值才不被掠射锯齿稀释。
        const BANDS = [0.2, 0.45, 0.6];
        const hf = {}, hfn = {};
        for (const b of BANDS) { hf[b] = 0; hfn[b] = 0; }
        let tot = 0, tn = 0, gsum = 0, gn = 0;
        const lim = Math.floor(H * BANDS[BANDS.length - 1]);
        for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
          const p = y * W + x, d = Math.abs(lum[p] - lum[p + 1]) + Math.abs(lum[p] - lum[p + W]);
          tot += d; tn++;
          for (const b of BANDS) if (y < Math.floor(H * b) - 1) { hf[b] += d; hfn[b]++; }
          if (y < lim - 1) { gsum += lum[p]; gn++; }
        }
        const u = S.splat().uniforms;
        const st = { W, H, mean: sum / (W * H), meanGround: gsum / Math.max(1, gn), hf: tot / tn,
          hf20: hf[0.2] / Math.max(1, hfn[0.2]), hf45: hf[0.45] / Math.max(1, hfn[0.45]), hf60: hf[0.6] / Math.max(1, hfn[0.6]),
          calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles, lost: gl.isContextLost(),
          // 出帧时的开关状态：每张落盘图都要能自证"是哪一对 uniform 画出来的"
          on: u.uSplatOn.value, micro: u.uMicroK.value, fade: u.uMicroFade.value };
        S.frames[tag] = { raw, lum, W, H };
        S.stats[tag] = st;
        return st;
      },
      // 两帧之差：mad = 逐像素 RGB 绝对差均值（每通道，0..255）；mad45 = 屏幕最下 45% 带（地面段）的同款读数
      diff(a, b) {
        const A = S.frames[a], B = S.frames[b];
        if (!A || !B) return { mad: -1, mad45: -1, changedPct: -1, max: -1, npx: 0 };
        const gend = Math.floor(A.H * 0.45) * A.W * 4;
        let s = 0, sg = 0, ng = 0, changed = 0, max = 0;
        for (let i = 0; i < A.raw.length; i += 4) {
          const d = Math.abs(A.raw[i] - B.raw[i]) + Math.abs(A.raw[i + 1] - B.raw[i + 1]) + Math.abs(A.raw[i + 2] - B.raw[i + 2]);
          s += d / 3;
          if (i < gend) { sg += d / 3; ng++; }
          if (d > 12) changed++;
          if (d > max) max = d;
        }
        const npx = A.raw.length / 4;
        return { mad: s / npx, mad45: sg / Math.max(1, ng), changedPct: 100 * changed / npx, max, npx };
      },
      // 翻正行序 + alpha 归一（非 1 的 alpha 会走预乘，2D 解码回来就不是那个数了）
      pixels(tag) {
        const f = S.frames[tag]; if (!f) return null;
        const { W, H } = f, o = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) o.set(f.raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
        for (let i = 3; i < o.length; i += 4) o[i] = 255;
        let s = 0; for (let i = 0; i < o.length; i += 4) s = (s + o[i] * 3 + o[i + 1] * 5 + o[i + 2] * 7) % 2147483647;
        let str = ''; for (let i = 0; i < o.length; i += 32768) str += String.fromCharCode.apply(null, o.subarray(i, i + 32768));
        return { W, H, sum: s, b64: btoa(str) };
      },
      // 独立解码器回读：PNG 由 createImageBitmap 解开、画进 2D canvas、再 getImageData 取回
      async verify(pngB64, W, H, sum) {
        const bin = Uint8Array.from(atob(pngB64), c => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }), { colorSpaceConversion: 'none' });
        const oc = new OffscreenCanvas(bmp.width, bmp.height), cx = oc.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
        let s = 0; for (let i = 0; i < d.length; i += 4) s = (s + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 2147483647;
        return { W: bmp.width, H: bmp.height, sum: s, ok: bmp.width === W && bmp.height === H && s === sum };
      },
    };
    window.__S = S;
  });

  // ── 进图：直接 loadMap('ridges')（startGame 只会加载 kaldash，联机要房间）──
  // 【G1 现场证据】在**第一次渲染之前**给 onBeforeCompile 装一个计数器：
  // 渲染前必须是 0，渲染后必须 ≥1 —— 这才叫"渲染器调用过它"，而不是"我替它调用过"。
  const loaded = await page.evaluate(() => {
    const g = window.game;
    g.loadMap('ridges');
    const m = g.world.terrainMesh.material;
    let calls = 0;
    const orig = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => { calls++; return orig(sh, r); };
    Object.defineProperty(window.__OBC = {}, 'calls', { get: () => calls });
    return { hasSplat: !!m.userData.splat, hitsBefore: String(m.userData.splat.hits),
      blend: g.world.def.terrainBlend, itemSize: g.world.terrainMesh.geometry.attributes.aBlend.itemSize,
      size: g.world.half * 2, relief: +(g.world.terrain.max - g.world.terrain.min).toFixed(1) };
  });
  lap('ridges 已载入 ' + JSON.stringify(loaded));

  // ── 机位：掩膜是确定性函数，直接在页面里读 aBlend + terrain 现算（不硬编一个我碰巧试出来的坐标）──
  const spots = await page.evaluate(() => {
    const w = window.game.world, T = w.terrain, bn = w.def.terrainBlend;
    const ab = w.terrainMesh.geometry.attributes.aBlend.array, n1 = T.n + 1;
    const wt = (i, j, c) => ab[(j * n1 + i) * bn + c];
    const X = (i) => -T.half + i * T.cell, Z = (j) => -T.half + j * T.cell;
    // 成片性：邻域内该层权重达标的比例。孤点不能当机位 —— 那样崖在画面里只占十几个像素，
    // G4 的高频能量就变成"少数像素 + 天空"的比大小的游戏。
    const frac = (i, j, R, test) => { let n = 0, k = 0; for (let b = -R; b <= R; b += 2) for (let a = -R; a <= R; a += 2) { const ii = i + a, jj = j + b; if (ii < 2 || jj < 2 || ii > T.n - 2 || jj > T.n - 2) continue; n++; if (test(ii, jj)) k++; } return n ? k / n : 0; };
    const RES = { aerial: { sky: true, h: 165, fov: 100 } };
    // ① 崖面机位：wRock（掩膜第 0 通道 [裸岩,碎石,裸土]）≈1 的**成片**区域，相机退到下坡 7m、
    //    1.7m 眼高，lookAt 崖面中心。逐级放宽（每级都记下来，报告里说得出用的是哪一级）。
    const LADDER = [
      { rk: 0.985, fr: 0.75, los: true }, { rk: 0.97, fr: 0.6, los: true },
      { rk: 0.95, fr: 0.5, los: true }, { rk: 0.9, fr: 0.4, los: false },
    ];
    for (const L of LADDER) {
      let best = null;
      for (let j = 24; j <= T.n - 24; j += 2) for (let i = 24; i <= T.n - 24; i += 2) {
        const x = X(i), z = Z(j), s = T.slope(x, z);
        if (wt(i, j, 0) < L.rk || s < 0.85) continue;
        const f = frac(i, j, 6, (a, b) => wt(a, b, 0) > 0.95);
        if (f < L.fr) continue;
        const gr = T.grad(x, z), gl2 = Math.hypot(gr.x, gr.z) || 1;
        // 退 7m（不是 9m）：眼高 1.7m 平视时崖面要**铺满画面下半幅**，退远了坡顶与天空就吃掉
        // 一大半，而高频能量按整带求平均 —— 那会把比值往 1 拉，量具自己先钝掉。
        const cx = x - gr.x / gl2 * 7, cz = z - gr.z / gl2 * 7;
        if (Math.abs(cx) > T.half - 12 || Math.abs(cz) > T.half - 12) continue;
        if (T.slope(cx, cz) > 0.9) continue;                     // 相机自己不能站在另一面崖上
        const tgt = [x, T.height(x, z) + 0.8, z];
        const eye = { x: cx, y: T.height(cx, cz) + 1.7, z: cz };
        if (L.los && w.lineBlocked(eye, { x: tgt[0], y: tgt[1], z: tgt[2] })) continue;  // 视线要真落在崖面上
        const sc = f * 100 + Math.min(20, T.height(x, z) - T.height(cx, cz));
        if (!best || sc > best.sc) best = { sc, f, cx, cz, tgt, s, wRock: wt(i, j, 0) };
      }
      if (!best) continue;
      // 眼高固定 1.7m（"离地面 1.7m"），由 placeLook 现取 groundHeight —— 这里只交坐标与目标。
      RES.cliff = { cam: [best.cx, best.cz], eye: 1.7, tgt: best.tgt, frac: best.f, level: LADDER.indexOf(L), slope: best.s, wRock: best.wRock };
      break;
    }
    // ② 平地机位：三层权重全 ≈0 的成片草（G6 的成对图 + 一个"掩膜本来就该是 0"的参照面）
    {
      let best = null;
      for (let j = 24; j <= T.n - 24; j += 4) for (let i = 24; i <= T.n - 24; i += 4) {
        const x = X(i), z = Z(j);
        if (T.slope(x, z) > 0.06) continue;
        const f = frac(i, j, 8, (a, b) => wt(a, b, 0) + wt(a, b, 1) + wt(a, b, 2) < 0.02);
        if (f < 0.9) continue;
        const sc = f * 100 + (Math.abs(x) + Math.abs(z));
        if (!best || sc > best.sc) best = { sc, f, cx: x, cz: z };
      }
      // 朝向取定值（不是"梯度反方向"：平地梯度是噪声，方向随机）；俯角 8° 让画面下半幅确实是脚下地面
      if (best) RES.grass = { cam: [best.cx, best.cz], eye: 1.7, yaw: 0, pitch: -8, frac: best.f };
    }
    // ③ 碎石带近景机位（G5 的近景）：细节法线只在 tBlend 为真时进得来，纯草地面**量不到它**，
    //    所以这一档必须挑掩膜非 0 的地方；1.7m 平视朝上坡，画面下半幅就是脚下几米的坡面。
    {
      let best = null;
      for (let j = 24; j <= T.n - 24; j += 2) for (let i = 24; i <= T.n - 24; i += 2) {
        const x = X(i), z = Z(j), s = T.slope(x, z);
        if (wt(i, j, 1) < 0.6 || s < 0.25 || s > 0.55) continue;
        const f = frac(i, j, 5, (a, b) => wt(a, b, 1) > 0.5 || wt(a, b, 0) > 0.5);
        if (f < 0.7) continue;
        const gr = T.grad(x, z);
        const sc = f * 100 + s;
        // three 的相机默认看 -Z，rotation.order 'YXZ' 下朝向 (dx,dz) 的 yaw = atan2(-dx,-dz)。
        // 这里要**朝上坡**看：坡面才会铺满画面（朝下坡看的话画面大半是天空与远处地面，
        // 而远处地面已被 uMicroFade 淡出 —— 第一版就是这么把 G5a 量成"1.5% 像素变化"的）。
        if (!best || sc > best.sc) best = { sc, f, cx: x, cz: z, yaw: Math.atan2(-gr.x, -gr.z) * 180 / Math.PI, s, wr: wt(i, j, 0), ws: wt(i, j, 1) };
      }
      if (best) RES.scree = { cam: [best.cx, best.cz], eye: 1.7, yaw: best.yaw, pitch: 0, frac: best.f, slope: best.s, wRock: best.wr, wScree: best.ws };
    }
    window.__SPOTS = RES;
    return RES;
  });
  console.log('  机位: ' + JSON.stringify(spots));

  const cl = async (tag) => { const v = await page.evaluate(() => window.__S.lost()); ctx.push(`${tag}=${v}`); return v; };
  const cam = (n) => page.evaluate((v) => window.__S.cam(v), n);
  const shot = (tag) => page.evaluate((v) => window.__S.shot(v), tag);
  const diff = (a, b) => page.evaluate(([x, y]) => window.__S.diff(x, y), [a, b]);
  const setSpl = (v) => page.evaluate((x) => window.__S.splat().setOn(x), v);
  const setMic = (v) => page.evaluate((x) => window.__S.splat().setMicro(x), v);

  // ══════════════ G1 编译（进图 + 渲染若干帧）══════════════
  await cl('渲染前');
  const obcBefore = await page.evaluate(() => window.__OBC.calls);
  await cam('aerial');
  const stAerial = await shot('aerial');       // 第一帧：程序在这里编译
  await shot('aerialB');                        // 再渲染若干帧（第二次走的是 program 缓存 + 阴影）
  await shot('aerialC');
  const obcAfter = await page.evaluate(() => window.__OBC.calls);
  await cl('渲染后');
  const g1 = await page.evaluate(() => ({ hits: window.__S.splat().hits }));
  const glErrs = errs.filter(e => /shader|program|WebGL|GL_INVALID|context loss/i.test(e));
  const HK = ['vsAttr', 'vsMain', 'fsPars', 'fsMap', 'fsNormal', 'fsRough'];
  ok('G1 渲染器真的调用过 onBeforeCompile（渲染前计数 0、若干帧后 ≥1 —— 离线那份是手工调的，这条才是现场证据）',
    obcBefore === 0 && obcAfter >= 1 && !stAerial.lost, `onBeforeCompile 调用 ${obcBefore}→${obcAfter} 次`);
  ok('G1b 真编译路径下六个锚点命中全为 true',
    !!g1.hits && HK.every(k => g1.hits[k] === true) && Object.keys(g1.hits).length === 6,
    `渲染前 hits=${loaded.hitsBefore} → 渲染后 ${JSON.stringify(g1.hits)}`);
  ok('G1c 进图渲染若干帧后无 WebGL 程序/着色器类错误（pageerror + console.error 全量都扫）',
    glErrs.length === 0, `错误 ${errs.length} 条，GL 相关 ${glErrs.length}${errs.length ? '：' + errs.slice(0, 2).join(' | ') : ''}`);

  // ══════════════ G2 链路没空转（先决臂，排在所有像素判据之前）══════════════
  ok('G2【先决】渲染链路真的在出图：readPixels 平均亮度 > 20 且 renderer.info.render.calls > 50',
    !stAerial.lost && stAerial.mean > MIN_BRIGHT && stAerial.calls > MIN_CALLS,
    `亮度 ${NUM(stAerial.mean, 2)}/255（闸 ${MIN_BRIGHT}）calls=${stAerial.calls}（闸 ${MIN_CALLS}）三角=${stAerial.tris}`);
  // 【反证臂】把 composer.render 打桩成空操作：亮度闸与 calls 闸必须当场塌下去，还原后必须回得来。
  // 这正是"动画循环照样 230fps、readPixels 全零"那次事故的形状：桩还在、循环照跑、fps 照刷，
  // 但一帧都没画。因为 S.render 每帧自己 reset 过 info，打桩后 calls 也诚实地变成 0。
  const stubArm = await page.evaluate(() => {
    const g = window.game, S = window.__S;
    const real = g.composer.render.bind(g.composer);
    g.composer.render = () => {};
    let stub;
    try { stub = S.shot('__stub'); } finally { g.composer.render = real; }
    const back = S.shot('__back');
    delete S.frames.__stub; delete S.frames.__back;
    return { stub: stub.mean, stubCalls: stub.calls, back: back.mean, backCalls: back.calls, lost: stub.lost || back.lost };
  });
  ok('G2b【反证臂】打桩 composer.render 为空操作后亮度与 draw call 当场塌到闸下、还原后回到闸上（这两条尺子都读得到"链路空转"）',
    !stubArm.lost && stubArm.stub < MIN_BRIGHT && stubArm.stubCalls < MIN_CALLS &&
    stubArm.back > MIN_BRIGHT && stubArm.backCalls > MIN_CALLS,
    `打桩 亮度 ${NUM(stubArm.stub, 2)} / calls ${stubArm.stubCalls} → 还原 ${NUM(stubArm.back, 2)} / calls ${stubArm.backCalls}`);

  // ── 噪声地板：同状态连渲两帧的差分（G3/G5 门槛的分母，现量而不是抄来的数）──
  const noise = await page.evaluate(() => {
    const S = window.__S;
    S.shot('nA'); S.shot('nB');
    const d = S.diff('nA', 'nB');
    delete S.frames.nA; delete S.frames.nB;
    return d;
  });
  const MAD_MIN = Math.max(MAD_ABS, noise.mad * NOISE_K);
  ok('G2c【先决】同状态重复帧的差分给出噪声地板（不推进世界，地板应当≈0；门槛随之定在这上面）',
    noise.mad >= 0 && noise.mad < 0.5, `重复帧 mad=${NUM(noise.mad, 5)} → 显著门槛 ${NUM(MAD_MIN, 3)}/通道（max(${MAD_ABS}, ${NOISE_K}×地板））`);

  // ══════════════ G3 对照臂 + G4 崖面高频 ══════════════
  let dCliff = null, dRepeat = null, cOn = null, cOff = null;
  if (spots.cliff) {
    await cam('cliff');
    await setSpl(true); cOn = await shot('cliffOn');
    await setSpl(false); cOff = await shot('cliffOff');
    await setSpl(true); await shot('cliffOn2');          // 翻回 on：readback 必须立刻跟着开关走
    dCliff = await diff('cliffOn', 'cliffOff');
    dRepeat = await diff('cliffOn', 'cliffOn2');
    await cl('崖面采样后');
    ok('G3 对照臂：同机位同帧间隔，setOn(true) vs setOn(false) 两幅显著不同（两幅各自先过亮度闸）',
      !cOn.lost && !cOff.lost && cOn.mean > MIN_BRIGHT && cOff.mean > MIN_BRIGHT &&
      dCliff.mad > MAD_MIN && dCliff.changedPct > 20,
      `mad=${NUM(dCliff.mad)}（门槛 ${NUM(MAD_MIN)}）下 45% 带 mad=${NUM(dCliff.mad45)} 变化像素 ${NUM(dCliff.changedPct, 1)}% 最大 ${dCliff.max} | 亮度 on=${NUM(cOn.mean, 1)} off=${NUM(cOff.mean, 1)} | on=${cOn.on} off=${cOff.on}`);
    ok('G3b【反证臂】同一状态重复帧（on→on）差分 ≈0，而翻一次开关的差分大一个量级（readback 抓的是刚画的那帧，不是旧帧/噪声）',
      dRepeat.mad < Math.max(0.02, dCliff.mad * 0.02) && dCliff.mad > dRepeat.mad * 10,
      `重复帧 mad=${NUM(dRepeat.mad, 5)} vs 开关帧 mad=${NUM(dCliff.mad, 4)}（${NUM(dCliff.mad / Math.max(1e-9, dRepeat.mad), 0)}×）`);
    // 【反证臂】把 setOn 换成空操作（= 对照开关失效、uniform 从没被翻，正是离线那份 M5h 盯的失效）：
    // G3 那同一把尺子必须当场读不出差别。少了这一臂，"两张图不同"也可能来自别的漂移而不是这个开关。
    const dead = await page.evaluate(() => {
      const S = window.__S, u = S.splat(), real = u.setOn;
      u.setOn = () => {};
      let got, onA, onB;
      try { u.setOn(false); onA = S.shot('dA').on; u.setOn(true); onB = S.shot('dB').on; got = S.diff('dA', 'dB'); }
      finally { u.setOn = real; u.setOn(true); delete S.frames.dA; delete S.frames.dB; }
      return { mad: got.mad, onA, onB };
    });
    ok('G3c【反证臂】把 setOn 换成空操作后同一把尺子读不出差别（对照臂要是假的，G3 立刻失效而不是恒绿）',
      dead.mad < 0.02 && dead.onA === 1 && dead.onB === 1,
      `空操作时 mad=${NUM(dead.mad, 6)}（uSplatOn 全程 =${dead.onA}/${dead.onB}，翻不动）vs 真开关 mad=${NUM(dCliff.mad, 4)}`);
    ok('G4【先决】崖面机位看的确实是 wRock≈1 的成片裸岩（否则下面量的是天空或草地）',
      spots.cliff.wRock > 0.98 && spots.cliff.frac > 0.7 && spots.cliff.level === 0,
      `wRock=${NUM(spots.cliff.wRock, 4)} 成片率 ${NUM(spots.cliff.frac, 2)} 坡度 ${NUM(spots.cliff.slope, 2)} 放宽档=${spots.cliff.level} 机位=${JSON.stringify(spots.cliff.cam.map(v => +v.toFixed(1)))}`);
    ok('G4 崖面细节真的上来了：splat on 的亮度两向差分均值 > splat off（岩贴图 + 三向投影在起作用，不是颜色变了）',
      !cOn.lost && !cOff.lost && cOn.mean > MIN_BRIGHT && cOff.mean > MIN_BRIGHT &&
      // off 那侧也必须是一幅**有内容的图**（hf20 > 1）：否则"on 的高频是 off 的 N 倍"
      // 只说明 off 塌成了纯色 —— 分母接近 0 的比值不是证据。
      cOff.hf20 > 1 && cOn.hf20 > cOff.hf20 * 1.05,
      // 口径 = **屏幕最下 20% 带**（离相机 1.5..3m 的崖面）：那里 off 是被放大成糊块的草底图
      // （8m 一格），on 是岩图 + 三向 + 细节法线（2.2m 一格）—— "细节上来了"这句话本来就归这一段管。
      // 带越往上放得越宽，掠射角会把 off 那侧的草图打出锯齿（给反方加分），比值一路被稀释到 1.08；
      // 四条带一起打出来，读者看得见"是哪一段在起作用"，而不是我挑了一条最宽的。
      `下 20% 带高频 on=${NUM(cOn.hf20)} vs off=${NUM(cOff.hf20)}（×${NUM(cOn.hf20 / Math.max(1e-6, cOff.hf20), 2)}，门槛 ×1.05）｜下 45% 带 ${NUM(cOn.hf45)}/${NUM(cOff.hf45)} ×${NUM(cOn.hf45 / Math.max(1e-6, cOff.hf45), 2)}｜下 60% 带 ×${NUM(cOn.hf60 / Math.max(1e-6, cOff.hf60), 2)}｜全帧 ×${NUM(cOn.hf / Math.max(1e-6, cOff.hf), 2)}`);
  } else {
    ok('G3 对照臂：崖面机位没找到，整段没量到', false, '放宽四级仍没有 wRock≈1 的成片崖 —— 说明机位搜索或掩膜本身有问题');
    ok('G4 崖面高频：同上，没量到', false);
  }

  // ══════════════ G5 细节法线按视距退场 ══════════════
  let dNear = null, dFar = null;
  if (spots.scree) {
    await setSpl(true);
    await cam('scree'); await setMic(0); const near0 = await shot('nearMic0');
    await setMic(0.32); const near1 = await shot('nearMic1');
    dNear = await diff('nearMic0', 'nearMic1');
    await cam('aerial'); await setMic(0); const far0 = await shot('farMic0');
    await setMic(0.32); const far1 = await shot('farMic1');
    dFar = await diff('farMic0', 'farMic1');
    // 【先决臂】俯瞰那幅里 **splat 本身必须在起作用**（同机位 on/off 差得开）。少了这一条，
    // "远景 micro 差为 0"就还有另一种成因：俯瞰画面里压根没有掩膜在混 —— 那淡出结论无从归因。
    await setSpl(true); const farOn = await shot('farSplatOn');
    await setSpl(false); await shot('farSplatOff');
    await setSpl(true);
    const dFarSplat = await diff('farSplatOn', 'farSplatOff');
    await cl('微法线采样后');
    ok('G5b0【先决】俯瞰那幅里 splat 确实在起作用（同机位 on/off 差得开）—— 远景 micro 差为 0 才能归因于视距淡出',
      !farOn.lost && farOn.mean > MIN_BRIGHT && dFarSplat.mad > MAD_MIN,
      `俯瞰 on/off mad=${NUM(dFarSplat.mad)}（门槛 ${NUM(MAD_MIN)}）变化像素 ${NUM(dFarSplat.changedPct, 1)}% 亮度 ${NUM(farOn.mean, 1)}`);
    ok('G5a【先决】近景量得动：1.7m 平视脚下碎石带（掩膜非 0，tNear≈1）时 setMicro(0) vs setMicro(0.32) 显著改变像素',
      !near0.lost && !near1.lost && near0.mean > MIN_BRIGHT && near1.mean > MIN_BRIGHT &&
      spots.scree.wScree > 0.5 && dNear.mad45 > MAD_MIN,
      // 口径用**屏幕最下 45% 带**而不是全帧：细节法线只进地面像素（天空、道具、其它材质的像素
      // 结构上不可能动），拿全帧均值会被那些注定为 0 的像素稀释 —— 那是量具钝掉，不是没效果。
      `近景下 45% 带 mad=${NUM(dNear.mad45)}（门槛 ${NUM(MAD_MIN)}）全帧 mad=${NUM(dNear.mad)} 变化像素 ${NUM(dNear.changedPct, 1)}% | 机位碎石权重 ${NUM(spots.scree.wScree, 2)} 坡度 ${NUM(spots.scree.slope, 2)} 成片率 ${NUM(spots.scree.frac, 2)}`);
    ok('G5b 远景淡出在起作用：俯瞰机位（可见地面的最近视距也在相机高度以上，远超 uMicroFade×2.2）的同一对差值明显小于近景',
      !far0.lost && !far1.lost && far0.mean > MIN_BRIGHT && dNear.mad45 > 0 &&
      spots.aerial.h > far0.fade * 2.2 &&
      dFar.mad45 < dNear.mad45 * MAD_MIN_RATIO && dFar.mad45 < MAD_MIN,
      `远景下 45% 带 mad=${NUM(dFar.mad45)} vs 近景下 45% 带 mad=${NUM(dNear.mad45)}（比值 ${NUM(dFar.mad45 / Math.max(1e-9, dNear.mad45), 4)}，要求 <${MAD_MIN_RATIO}）| 俯瞰高度 ${spots.aerial.h}m vs 淡出终点 ${NUM(far0.fade * 2.2, 1)}m（uMicroFade=${NUM(far0.fade, 1)}）`);
  } else {
    ok('G5a 近景细节法线：没找到碎石带机位，量不出来', false, '掩膜里 0.25..0.55 坡度带没有成片碎石 —— 这是机位问题还是掩膜问题要分开查');
    ok('G5b 远景淡出：同上，没量到', false);
  }

  // ══════════════ G6 落盘截图（readPixels → 自写 PNG）══════════════
  // 状态归位：splat on、micro 回到默认 0.32（G5 用过 setMicro(0)）
  await setSpl(true); await setMic(0.32);
  // 平地成对的两帧（其余三张复用上面测过的帧：aerial 来自 G1、cliffOn/Off 来自 G3；
  // 出帧时的 on/micro/亮度/calls 都记在 stats 里，G6a 的读数把每张图的状态打出来）
  if (spots.grass) {
    await cam('grass');
    await setSpl(true); await shot('grassOn');
    await setSpl(false); await shot('grassOff');
    await setSpl(true);
    await cl('平地采样后');
  }
  const PAIRS = { cliff: spots.cliff ? dCliff : null, grass: spots.grass ? await diff('grassOn', 'grassOff') : null };
  const SAVE = [['aerial', 'test/_probe_splat_aerial.png']];
  if (spots.cliff) SAVE.push(['cliffOn', 'test/_probe_splat_cliff_on.png'], ['cliffOff', 'test/_probe_splat_cliff_off.png']);
  if (spots.grass) SAVE.push(['grassOn', 'test/_probe_splat_grass_on.png'], ['grassOff', 'test/_probe_splat_grass_off.png']);
  const saved = [];
  for (const [tag, path] of SAVE) {
    const p = await page.evaluate((v) => window.__S.pixels(v), tag);
    const st = await page.evaluate((v) => window.__S.stats[v], tag);
    const buf = Buffer.from(p.b64, 'base64');
    writePng(path, p.W, p.H, buf);
    const decoded = await page.evaluate(([b, W, H, sum]) => window.__S.verify(b, W, H, sum),
      [readFileSync(path).toString('base64'), p.W, p.H, p.sum]);
    saved.push({ tag, path, W: p.W, H: p.H, mean: st.mean, calls: st.calls, on: st.on, micro: st.micro, lost: st.lost, decoded });
    lap(`截图 ${path}`);
  }
  ok('G6a 五张截图落盘，且每张的 PNG 被页面里的独立解码器读回同一帧（尺寸 + 逐通道校验和一致，且记下出帧时的 on/micro）',
    saved.length === 5 && saved.every(s => s.decoded.ok),
    saved.map(s => `${s.path.split('/').pop()}:${s.W}×${s.H} 校验和${s.decoded.ok ? '一致' : '不一致'} on=${s.on} micro=${s.micro} 亮度${NUM(s.mean, 1)} calls=${s.calls}`).join(' | '));
  // 【反证臂】三个不同机位的帧必须互不相同：抓的是缓存旧帧或全黑的话，这里会塌成 0。
  const cross = await page.evaluate(() => {
    const S = window.__S;
    return { ac: S.diff('aerial', 'cliffOn').mad, cg: S.diff('cliffOn', 'grassOn').mad, ag: S.diff('aerial', 'grassOn').mad };
  });
  const crossOk = !!(spots.cliff && spots.grass) && cross.ac > MAD_MIN && cross.cg > MAD_MIN && cross.ag > MAD_MIN;
  ok('G6b【反证臂】俯瞰/崖面/平地三机的帧两两互不相同（旧帧缓存或全黑会塌成 0）',
    crossOk, `俯瞰↔崖 ${NUM(cross.ac)} 崖↔平地 ${NUM(cross.cg)} 俯瞰↔平地 ${NUM(cross.ag)}`);
  ok('G6c 成对截图两对都过闸：崖面成对与平地成对的差值显著，且五帧各自亮度 > 20、calls > 50、未丢上下文',
    !!PAIRS.cliff && !!PAIRS.grass && PAIRS.cliff.mad > MAD_MIN && PAIRS.grass.mad > MAD_MIN &&
    saved.length === 5 && saved.every(s => !s.lost && s.mean > MIN_BRIGHT && s.calls > MIN_CALLS),
    `崖 mad=${PAIRS.cliff ? NUM(PAIRS.cliff.mad) : 'n/a'}（变化 ${PAIRS.cliff ? NUM(PAIRS.cliff.changedPct, 1) : '-'}%）平地 mad=${PAIRS.grass ? NUM(PAIRS.grass.mad) : 'n/a'}（变化 ${PAIRS.grass ? NUM(PAIRS.grass.changedPct, 1) : '-'}%）`);

  const lostAny = ctx.filter(s => s.endsWith('=true')).length;
  // 错误扫描做**两遍**：G1c 只覆盖"进图渲染若干帧"那一段，而真编译错误也可能晚到（第一次用到
  // 某个 program 变体、或上下文恢复后）—— 收尾再全量扫一次，别让"后面才炸"混成绿。
  const glErrsEnd = errs.filter(e => /shader|program|WebGL|GL_INVALID|context loss/i.test(e));
  ok('G7 全程（含所有像素采样与落盘之后）无 GL 类错误、且未丢上下文',
    lostAny === 0 && glErrsEnd.length === 0,
    `GL 类错误 ${glErrsEnd.length} / 全部错误 ${errs.length}${errs.length ? '：' + errs.slice(0, 2).join(' | ') : ''} | 上下文打点 ${ctx.join(' ')}`);
  lap('判据跑完');
} catch (e) {
  out.push([false, '脚本异常：' + (e && e.message ? e.message : String(e))]);
} finally {
  try { if (browser) await browser.close(); } catch { /* 已经退了 */ }
  try { if (srv) srv.kill(); } catch { /* 已经退了 */ }
}

const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);
