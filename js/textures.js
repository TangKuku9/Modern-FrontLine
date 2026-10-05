// 程序化PBR纹理生成（颜色/法线/粗糙度）—— 主线程侧：把 textures-core 算出的
// 裸像素数组包成 CanvasTexture。
//
// 性能审查 C4：逐像素循环本体搬进了 textures-core.js（纯计算，零 THREE/DOM），由
// js/worker.mjs 在加载期整体跑在 Worker 里；本文件只留"包 canvas/建 THREE 纹理"
// 这层薄壳（CPU 占用是 memcpy 量级）与运行时小贴图（particleTex/textTexture，
// 事件驱动、很小，不值一条消息往返）。Worker 起不来时 materials.initTextures 会
// 退回主线程同步调 genTexture/genCamo —— 两条路同一份核心，输出逐位一致。
import * as THREE from 'three';
import { mulberry32 } from './util.js';
import { genTextureData, genCamoData, setTextureSize as coreSetSize, getTextureSize } from './textures-core.js';

export function setTextureSize(s) { coreSetSize(s); }
export { getTextureSize };

function toTex(data, N, srgb) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  ctx.putImageData(new ImageData(data, N, N), 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Worker 递回来的裸数组 → 与旧 build() 同形状的 {map, normalMap, roughnessMap?}
export function textureFromData(d) {
  const res = { map: toTex(d.color, d.N, true), normalMap: toTex(d.normal, d.N, false) };
  if (d.rough) res.roughnessMap = toTex(d.rough, d.N, false);
  return res;
}

export function genTexture(kind, opts = {}) {
  return textureFromData(genTextureData(kind, opts));
}

export function genCamo(kind) {
  return textureFromData(genCamoData(kind));
}

// 软粒子贴图
export function particleTex(type = 'soft') {
  const N = 64, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  if (type === 'soft') {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  } else if (type === 'smoke') {
    const r = mulberry32(5);
    for (let i = 0; i < 18; i++) {
      const x = 16 + r() * 32, y = 16 + r() * 32, rad = 8 + r() * 16;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
    }
  } else if (type === 'flash') {
    ctx.translate(32, 32);
    for (let i = 0; i < 5; i++) {
      ctx.rotate(Math.PI * 2 / 5 + 0.3);
      const g = ctx.createLinearGradient(0, 0, 30, 0);
      g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(1, 'rgba(255,160,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(30, 0); ctx.lineTo(0, 4); ctx.fill();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
    g.addColorStop(0, 'rgba(255,255,230,1)'); g.addColorStop(1, 'rgba(255,180,60,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 14, 0, 7); ctx.fill();
  } else if (type === 'decal') {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, 'rgba(10,10,10,1)'); g.addColorStop(0.25, 'rgba(20,18,15,0.9)'); g.addColorStop(0.5, 'rgba(40,35,30,0.4)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  } else if (type === 'scorch') {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.95)'); g.addColorStop(0.6, 'rgba(10,8,5,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function textTexture(text, opts = {}) {
  const cv = document.createElement('canvas');
  const w = opts.w || 512, h = opts.h || 128;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (opts.bg) { ctx.fillStyle = opts.bg; ctx.fillRect(0, 0, w, h); }
  ctx.font = `bold ${opts.size || 72}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.color || '#fff';
  ctx.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
