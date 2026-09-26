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

// 玩法流的状态放在模块变量里而不是闭包里，因为联机回滚要把流状态一起存/取：
// 重放一个 tick 会再抽一次随机，不恢复到服务端那一拍的流位置，客户端和服务端
// 就会永久错开（快照头里带 rngState 就是这个用途）。序列与 mulberry32(seed) 逐位相同。
let gstate = 1;
function gnext() {
  gstate |= 0; gstate = gstate + 0x6D2B79F5 | 0;
  let t = Math.imul(gstate ^ gstate >>> 15, 1 | gstate);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

export const rng = {
  draws: 0,
  next() { rng.draws++; return gnext(); },
  seed(s) { gstate = s >>> 0; rng.draws = 0; },
  state() { return gstate >>> 0; },
  setState(s) { gstate = s >>> 0; },
};

// 每个"两端各自演算的人物"一条私有流。为什么必须私有：
// 后坐横向直接写 pl.yaw（weapon-state.js:211）、散布决定弹道（spreadDir）、震屏进视线
// （player.js:311）—— 这三处都影响命中裁决。它们若走公共流，服务端在同一拍里还要替
// 别人抽数，而客户端回滚时只重放自己那一份 ⇒ 同一个"我这一拍的后坐"两端会从流的不同
// 位置取值，症状就是"本地打中了、权威说没有"，且没人报错。
// 私有流的进度只由这个人自己演算过的拍数决定，所以回滚时能随日记本一起存取复原
// （见 js/player.js 的 j.rngState），两端必然重算出同一个数。
// 抽数仍并进 rng.draws：工具量的是"这一拍玩法抽了几次随机"，不该因为换了哪条流而少算。
export function entStream(seed, tag) {
  // 播种混合：两个 32 位常数把 (seed, tag) 打散，避免 1 号玩家和 2 号玩家从相邻状态起步
  // （mulberry32 的步长是加常数，相邻种子会产出高度相似的序列）。
  let s = (Math.imul((seed >>> 0) ^ 0x9E3779B9, 0x85EBCA6B) + Math.imul((tag >>> 0) + 0x1000193, 0xC2B2AE35)) | 0;
  return {
    draws: 0,
    next() {
      rng.draws++; this.draws++;
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    },
    state() { return s >>> 0; },
    setState(v) { s = v >>> 0; },
  };
}

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
