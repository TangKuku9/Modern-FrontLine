// 常驻游戏 Worker（性能审查 C4/C5）——两份差事，一条线程：
//   ① textures：加载期把逐像素贴图生成整体搬过来（25 份工单 + 6 份涂装），主线程
//      只做"包 canvas/建纹理"的薄壳 —— 加载屏不再被几百毫秒一档的纯计算顿住；
//   ② path：之后兼跑离线 bot 的 A*（世界格子由主线程在每次建图后送一份拷贝）。
//
// 硬约束：本文件以及它 import 的 modules（textures-core / pathfind / rng / noise）
// **一个 THREE 都不能碰** —— module worker 的模块解析不走页面的 import map，
// 'three' 裸说明符当场解析失败。判据：test/worker-core.mjs（同工单逐位一致）、
// test/worker-live.mjs（真浏览器离线局端到端）。

import { genTextureData, genCamoData, setTextureSize } from './textures-core.js';
import { astarPath } from './pathfind.js';

let GRID = null, GN = 0, CS = 1, HALF = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'textures') {
    // 逐份回传（主线程按同节奏刷加载进度条）。任一份炸了就整体报败 —— 主线程
    // 会退回同步路整份重生成（同一份核心，结果逐位一致），不许带着缺材质继续。
    try {
      setTextureSize(m.size);
      for (let i = 0; i < m.jobs.length; i++) {
        const j = m.jobs[i];
        const data = j.camo ? genCamoData(j.camo) : genTextureData(j.kind, j.opts);
        const transfers = [data.color.buffer, data.normal.buffer];
        if (data.rough) transfers.push(data.rough.buffer);
        postMessage({ type: 'texOne', key: j.key, camo: !!j.camo, i, total: m.jobs.length, data }, transfers);
      }
    } catch (err) {
      postMessage({ type: 'texFail', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'grid') {
    // 每次建图（含战役闸门那种运行时 rebuild）主线程都会重发一份拷贝；不带
    // transfer —— 主线程自己的 world.grid 还要用。
    GRID = m.grid; GN = m.gn; CS = m.cs; HALF = m.half;
  } else if (m.type === 'path') {
    let pts = null;
    try { if (GRID) pts = astarPath(GRID, GN, CS, HALF, m.fx, m.fz, m.tx, m.tz); } catch (err) { pts = null; }
    postMessage({ type: 'pathResult', id: m.id, pts });
  }
};
