// 两条随机流，分得很干净：
//
//   rng  —— 玩法流。影响任何会被复制/裁决的状态：后坐横向、弹道散布、AI 决策、
//            出生点、掉落、重生计时。服务端要复现客户端的预测，就必须可播种。
//   crand—— 画面流。粒子、贴花旋转、枪口焰翻滚、镜头震、音频噪声、灯光闪烁。
//            两边天生不必一致，也不该进玩法流。
//
// 为什么不能像以前那样全用 Math.random：three.js 的 generateUUID（three.module.js:317）
// 每次 new Material/BufferGeometry/Texture 都要抽 4 次 Math.random。客户端会做 LOD、
// 视锥剔除、拾取物用 {low:true}、geoCache 命中与否随构建顺序变化，服务端则什么都不渲；
// 两边"造了多少个 three 对象"永远不可能相等，于是共用一条流必然错位。
// 实测过一次这种错位：同种子两次跑，仅因 gunmodel.js:6 的 geoCache 第二次命中，
// 就少抽了 120 次随机，第一发子弹的 yaw 就对不上。
// 可复现随机数（逐字符从 util.js 迁入 —— 改动它会改变 world.js/maps.js 的
// mulberry32 播种结果，进而改变关卡几何，所以这里必须与原实现完全一致）
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

let gen = mulberry32(1);
export const rng = {
  draws: 0,
  next() { rng.draws++; return gen(); },
  seed(s) { gen = mulberry32(s >>> 0); rng.draws = 0; },
};

// 画面流：始终用宿主 Math.random，不参与播种，不进快照
export const crand = {
  next: () => Math.random(),
};

export const rand = (a = 0, b = 1) => a + rng.next() * (b - a);
export const randInt = (a, b) => Math.floor(a + rng.next() * (b - a + 1));
export const pick = arr => arr[Math.floor(rng.next() * arr.length)];

// 就地洗牌，消耗恰好 n-1 次随机 —— 与引擎无关。
// 不要用 arr.sort(() => rng.next() - 0.5)：那样"调用了几次比较器"由 V8 的排序
// 实现决定，不同版本的 Node 与 Chrome 会对同一数组抽出不同次数的随机数，
// 客户端与服务端的玩法流当场错位（实测过：tick 0 就差 4 次）。
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

export const crandRange = (a = 0, b = 1) => a + crand.next() * (b - a);
