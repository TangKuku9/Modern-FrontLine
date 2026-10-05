// 纯噪声与标量小件（性能审查 C4 抽核）。
//
// textures-core（贴图生成核心）与寻路 Worker 都要在**没有 import map 的环境**里跑：
// ES module worker 的模块解析不走页面的 import map，`'three'` 裸说明符当场解析失败。
// 所以这一份（以及 textures-core.js / pathfind.js）一个 THREE 都不能 import ——
// util.js 顶层 import 'three'，worker 同样 import 不得，只能走"小件下沉 + util.js
// 转出保持既有 import 不变"这条路（rng.js 同款先例）。
import { mulberry32 } from './rng.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export class TileNoise {
  constructor(seed = 1, period = 64) {
    const r = mulberry32(seed);
    this.p = period;
    this.v = new Float32Array(period * period);
    for (let i = 0; i < this.v.length; i++) this.v[i] = r();
  }
  get(x, y, freq) {
    // x,y in [0,1)
    const p = Math.min(this.p, freq);
    const fx = x * p, fy = y * p;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const P = this.p;
    const x0 = ((ix % p) + p) % p, x1 = (x0 + 1) % p;
    const y0 = ((iy % p) + p) % p, y1 = (y0 + 1) % p;
    const v = this.v;
    const a = v[y0 * P + x0], b = v[y0 * P + x1], c = v[y1 * P + x0], d = v[y1 * P + x1];
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  }
  fbm(x, y, base = 4, oct = 5, gain = 0.5) {
    let amp = 1, sum = 0, norm = 0, f = base;
    for (let i = 0; i < oct; i++) {
      sum += this.get(x, y, f) * amp; norm += amp; amp *= gain; f *= 2;
    }
    return sum / norm;
  }
}
