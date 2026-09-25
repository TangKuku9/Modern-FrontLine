// 服务端/测试用的玩法随机流播种。
//
// 这里刻意不碰 Math.random。three.js 的 generateUUID 会抽 Math.random，而
// "造了多少个 three 对象"在客户端与服务端之间天然不等（LOD、视锥剔除、
// gunmodel.js:6 的 geoCache 命中与否）。可复现性只能建立在 js/rng.js 的玩法流上。
import { rng } from '../js/rng.js';

export function seedGameplayRng(seed) { rng.seed(seed >>> 0); return rng; }
export function resetGameplayRng() { rng.seed(1); }
export { rng };
