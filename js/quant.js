// 量化与位标志：服务端与客户端共用的唯一一份定义。
//
// 这些常数一旦两边不一致，症状是"对面的人在抖"而不是报错，所以放一个文件里，
// 并且 server/codec.mjs 的自测会把每个 pack/unpack 的最大误差印出来。
export const POS_STEP = 0.01;                       // 1 cm；i16 量程 ±327 m，地图 80 m 见方
export const YAW_SCALE = 65536 / (Math.PI * 2);     // yaw 折叠到 [0,2π) 后用满 u16
export const PITCH_STEP = 1e-4;                     // i16 ⇒ ±3.27 rad，够用（clamp 在 ±1.5）
export const LOOK_STEP = 0.01;                      // 上行鼠标位移，单位是"像素计数"的原值
export const VEL_STEP = 0.01;                       // 速度 1 cm/s，客户端用来推步态与外插

export const Q = {
  packPos: (v) => clampQ(Math.round(v / POS_STEP), 32767),
  unpackPos: (n) => n * POS_STEP,
  packYaw: (v) => { let a = v % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return Math.round(a * YAW_SCALE) & 0xffff; },
  unpackYaw: (n) => n / YAW_SCALE,
  packPitch: (v) => clampQ(Math.round(v / PITCH_STEP), 32767),
  unpackPitch: (n) => n * PITCH_STEP,
  packHp: (v) => Math.max(0, Math.min(255, Math.round(v))),
  unpackHp: (n) => n,
  packLook: (v) => clampQ(Math.round(v / LOOK_STEP), 32767),
  unpackLook: (n) => n * LOOK_STEP,
  packVel: (v) => clampQ(Math.round(v / VEL_STEP), 32767),
  unpackVel: (n) => n * VEL_STEP,
  packPhase: (v) => { let a = v % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return Math.round(a / (Math.PI * 2) * 255) & 0xff; },
  unpackPhase: (n) => n / 255 * Math.PI * 2,
};

function clampQ(n, m) { return n > m ? m : n < -m ? -m : n; }

// 实体姿态位
export const FLAG = {
  Alive: 1, Crouch: 2, Sprint: 4, Ads: 8, OnGround: 16, Sliding: 32, Firing: 64, Reloading: 128,
};
// 上行按键位（与 js/main.js 的 input 字段一一对应）
export const KEY = {
  Fwd: 1, Back: 2, Left: 4, Right: 8, Sprint: 16, Jump: 32, Crouch: 64,
  Reload: 128, Interact: 256, NVG: 512, Melee: 1024, InteractPressed: 2048,
};
export const BTN = {
  Fire: 1, Ads: 2, FirePressed: 4, AdsPressed: 8, SwapNext: 16, SwapPrev: 32,
  // 投掷物要"按住引信 / 松手投出"两段，所以按下与按住各占一位。
  // 早先服务端把 lethal 错接成了 buttons&1（= 开火位），按住右键会掏手雷。
  LethalPressed: 64, LethalHeld: 128, TacticalPressed: 256, TacticalHeld: 512,
};

// 世界级位标志（快照头里的一个字节）
export const WORLD = { Night: 1, UAV: 2, WhitePhosphorus: 4, MatchOver: 8 };

// sim 的 input 对象 ⇄ 位包。客户端打包、服务端解包必须用这里的同一对函数：
// 两边各写一份 switch 的结局是"按键含义悄悄错位"，而这种错位不会报错，只会手感怪。
const KEYMAP = [
  ['Fwd', 'fwd'], ['Back', 'back'], ['Left', 'left'], ['Right', 'right'],
  ['Sprint', 'sprint'], ['Jump', 'jumpPressed'], ['Crouch', 'crouchPressed'],
  ['Reload', 'reloadPressed'], ['Interact', 'interact'], ['InteractPressed', 'interactPressed'],
  ['NVG', 'nvgPressed'], ['Melee', 'meleePressed'],
];
// 投掷物的"按下/按住"两位都在 buttons 里：keys 只剩 16 位且已排到 1024，
// 再往里塞会把按住位和按下位重到同一个掩码上（写过一次，症状是手雷自己掏出来）。
const BTNMAP = [
  ['Fire', 'fire'], ['Ads', 'ads'], ['FirePressed', 'firePressed'], ['AdsPressed', 'adsPressed'],
  ['SwapNext', 'swapPressed'],
  ['LethalPressed', 'lethalPressed'], ['LethalHeld', 'lethal'],
  ['TacticalPressed', 'tacticalPressed'], ['TacticalHeld', 'tactical'],
];

export function packInput(inp) {
  let keys = 0, buttons = 0;
  for (const [bit, field] of KEYMAP) if (inp[field]) keys |= KEY[bit];
  for (const [bit, field] of BTNMAP) if (inp[field]) buttons |= BTN[bit];
  return { keys: keys & 0xffff, buttons: buttons & 0xffff };
}

export function unpackInput(keys, buttons) {
  const inp = {
    fwd: false, back: false, left: false, right: false, sprint: false, jumpPressed: false, crouchPressed: false,
    fire: false, ads: false, reloadPressed: false, swapPressed: false, slot1: false, slot2: false,
    meleePressed: false, lethalPressed: false, lethal: false, tacticalPressed: false, tactical: false,
    interact: false, interactPressed: false, nvgPressed: false, streak: -1,
    firePressed: false, adsPressed: false, mdx: 0, mdy: 0,
  };
  for (const [bit, field] of KEYMAP) inp[field] = !!(keys & KEY[bit]);
  for (const [bit, field] of BTNMAP) inp[field] = !!(buttons & BTN[bit]);
  return inp;
}

// 武器索引：快照里只发 1 字节，两端用同一张表
export const WEAPON_IDS = ['m4', 'ak', 'scar', 'mp5', 'vector', 'pkm', 'm870', 'sks', 'l115', 'm1911', 'revolver', 'rpg'];
export const weaponIndex = (id) => Math.max(0, WEAPON_IDS.indexOf(id));
export const weaponId = (n) => WEAPON_IDS[n] || 'm4';

export const TEAM_IDS = ['A', 'B', 'P'];
export const teamIndex = (t) => Math.max(0, TEAM_IDS.indexOf(t));
export const teamId = (n) => TEAM_IDS[n] || 'A';
