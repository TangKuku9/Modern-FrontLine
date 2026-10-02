// 量化与位标志：服务端与客户端共用的唯一一份定义。
//
// 这些常数一旦两边不一致，症状是"对面的人在抖"而不是报错，所以放一个文件里，
// 并且 server/codec.mjs 的自测会把每个 pack/unpack 的最大误差印出来。
export const POS_STEP = 0.01;                       // 1 cm；i16 量程 ±327 m，地图 80 m 见方
export const YAW_SCALE = 65536 / (Math.PI * 2);     // yaw 折叠到 [0,2π) 后用满 u16
export const PITCH_STEP = 1e-4;                     // i16 ⇒ ±3.27 rad，够用（clamp 在 ±1.5）
// 上行鼠标位移（mdx/mdy），单位是"像素计数"的原值。
//
// LOOK_STEP 与 LOOK_MAX 是**一对**，两个数必须一起看：i16 只有 ±32767 格，而
// 一格代表多少计数同时决定精度（越小越准）和量程（32767 × LOOK_STEP = 每拍最多报多少计数）。
// 改动前是 0.01 ⇒ 量程 ±327.67 计数/拍，高 DPI 鼠标一次用力甩枪轻松超过，而客户端本地
// 预测用的是**没被钳过**的那份 mdx（服务端拿钳后的值积分）—— 快甩时本地转到位、
// 20Hz 快照再拽回来，表现为持续的"甩枪弹回"橡皮筋，且灵敏度越低越明显（乘出来更小）。
//
// 量程按"每拍最大角速度"折算：最慢一档灵敏度 0.2（js/player.js:VIEW_LIMITS）× 0.0022
// （player._sim 里那个常数）= 4.4e-4 rad/计数。取 1000 计数/拍 ⇒ 0.44 rad/拍 = 26.4 rad/s
// ≈ 1513°/s —— 比任何真人甩枪都快一个量级，正常操作一辈子碰不到这个上限。
// 精度那一半：1/32 计数恰好是二进制可精确表示的数（0.03125），乘灵敏度之后远小于
// 一像素对应的角位移；而且 `unpackLook(packLook(v))` 因此是**逐位精确**的，
// 客户端本地用它的读数与服务端解出来的读数不会差半个 ULP。
export const LOOK_STEP = 1 / 32;                    // 计数/格（i16 ⇒ ±1023.97 计数）
export const LOOK_MAX = 1000;                       // 每拍最多上报多少计数（±），见上面那段折算
// i16 那一格的上限（LOOK_MAX / LOOK_STEP = 32000 ≤ 32767）。单独写出来是因为
// "在哪个单位上夹"这件事错过一次：把计数钳制写成对**格数**钳制，量程会塌成
// LOOK_MAX × LOOK_STEP = 31.25 计数/拍 —— 比改动前的 327.67 还小十倍，而它不报错。
export const LOOK_CODE_MAX = Math.floor(LOOK_MAX / LOOK_STEP);
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
  packLook: (v) => Math.round(clampQ(v, LOOK_MAX) / LOOK_STEP),
  unpackLook: (n) => n * LOOK_STEP,
  packVel: (v) => clampQ(Math.round(v / VEL_STEP), 32767),
  unpackVel: (n) => n * VEL_STEP,
  packPhase: (v) => { let a = v % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return Math.round(a / (Math.PI * 2) * 255) & 0xff; },
  unpackPhase: (n) => n / 255 * Math.PI * 2,
};

function clampQ(n, m) { return n > m ? m : n < -m ? -m : n; }

// 客户端本地预测要用的**就是上线的那一个数**。
//
// 为什么必须共用这一句：本地用全量、线上用钳后值，两边的 yaw 就会在每一次大位移上分家，
// 而快照每 20Hz 把权威 yaw 覆盖回来 —— 症状是"快甩弹回"，不报错、不崩，只是手感坏。
// 判据在 test/net-audit.mjs 的 E 段（往返等于本地读值，且大位移被夹到同一个上限）。
// 只对有限数做（输入对象可能是 `unpackInput` 出来的整份，也可能是别处手工拼的）。
export const roundLook = (v) => (Number.isFinite(v) ? Q.unpackLook(Q.packLook(v)) : v);

// 实体姿态位
export const FLAG = {
  Alive: 1, Crouch: 2, Sprint: 4, Ads: 8, OnGround: 16, Sliding: 32, Firing: 64, Reloading: 128,
};
// 上行按键位（与 js/main.js 的 input 字段一一对应）
export const KEY = {
  Fwd: 1, Back: 2, Left: 4, Right: 8, Sprint: 16, Jump: 32, Crouch: 64,
  Reload: 128, Interact: 256, NVG: 512, Melee: 1024, InteractPressed: 2048,
  // 数字键直选武器（1/2）。这两个位曾经不存在 —— main.js:snapshotInput 一直报着
  // slot1/slot2，打包表里却没有它们，于是联机下按数字键切枪**服务端永远不知道**：
  // 权威端停在主武器上连发步枪，客户端自己演的是手枪，快照再把权威的后坐喂回来。
  // keys 是 u16，排到 InteractPressed(2048) 后还剩 4096/8192 两格，恰好放下。
  Slot1: 4096, Slot2: 8192,
};
export const BTN = {
  Fire: 1, Ads: 2, FirePressed: 4, AdsPressed: 8, SwapNext: 16, SwapPrev: 32,
  // 投掷物要"按住引信 / 松手投出"两段，所以按下与按住各占一位。
  // 早先服务端把 lethal 错接成了 buttons&1（= 开火位），按住右键会掏手雷。
  LethalPressed: 64, LethalHeld: 128, TacticalPressed: 256, TacticalHeld: 512,
};

// 世界级位标志（快照头里的一个字节）。
//
// 它是**全局**的：一份快照编一次、发给一屋子人（server/net-server.mjs:broadcast），
// 不按接收者过滤。所以"敌我"要靠两位分开表达 —— UAV 的效果只对放它的那一队有用，
// 而所有客户端拿到的是同一个字节。位 2 归 A 队、位 16 归 B 队，客户端按自己 team 查。
// 曾经想过按人各编一份（encodeSnapshot 的 scratch 参数就是为那种用法准备的），但那是
// 每人 20Hz 一次全表编码，256 人的房间里纯属浪费 —— 而两个位就够表达这件事。
export const WORLD = { Night: 1, UAV: 2, WhitePhosphorus: 4, MatchOver: 8, UAV_B: 16 };

// 队伍 → UAV 那一位。两端必须用**同一句**：服务端按 'A' 置位、客户端按 'A' 查位，
// 各写一遍的症状是"UAV 该亮的时候不亮"，不会报错。
export const uavBit = (team) => (team === 'B' ? WORLD.UAV_B : WORLD.UAV);

// 连杀呼叫（上行输入包里那一个字节）。
//   0 ... n-1 = 呼叫第几个槽（与 js/main.js 的 Digit3/4/5 对应）
//   0xff      = 这一拍没有请求
// 为什么不是 u8 的 -1：装不下负数。为什么不是 3/4/5 直接当值：槽位下标是 0 起的，
// 且服务端要能一眼区分"下标 0"与"没请求"这两件事。上限 8 是挡乱报用的 ——
// KILLSTREAKS 一共 5 项，越界值走 StreakBook.take 的边界检查，不会变成第 n 个槽。
export const STREAK_NONE = 0xff;
export const STREAK_MAX = 8;
export const packStreak = (v) => (Number.isInteger(v) && v >= 0 && v < STREAK_MAX ? v : STREAK_NONE);
export const unpackStreak = (n) => (n === STREAK_NONE ? -1 : n);

// sim 的 input 对象 ⇄ 位包。客户端打包、服务端解包必须用这里的同一对函数：
// 两边各写一份 switch 的结局是"按键含义悄悄错位"，而这种错位不会报错，只会手感怪。
const KEYMAP = [
  ['Fwd', 'fwd'], ['Back', 'back'], ['Left', 'left'], ['Right', 'right'],
  ['Sprint', 'sprint'], ['Jump', 'jumpPressed'], ['Crouch', 'crouchPressed'],
  ['Reload', 'reloadPressed'], ['Interact', 'interact'], ['InteractPressed', 'interactPressed'],
  ['NVG', 'nvgPressed'], ['Melee', 'meleePressed'],
  // 数字键直选武器。漏掉它们的症状见 KEY.Slot1 的注释 —— codec 自测的按键往返表
  // （server/codec.mjs）把这两个字段也列了，谁再把它们从这张表里删掉当场就红。
  ['Slot1', 'slot1'], ['Slot2', 'slot2'],
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
// 'P'+cid（自由混战每人一支的独立队）不在表里 —— 没有 'P' 前缀这一句，它的索引是 -1
// 被钳成 0，全场（连"自己"在内）都在快照里变成 'A' 队。快照的 1 字节表达不了每人的
// 序号，所以这里只负责把它送进 'P' 通道（索引 2）：解码端在 FFA 下**不消费这个字节判
// 敌我**，队伍键以 roster / 事件里带的原始串为准（js/net/client.mjs 的三处失真口）。
export const teamIndex = (t) => (t && t[0] === 'P' ? 2 : Math.max(0, TEAM_IDS.indexOf(t)));
export const teamId = (n) => TEAM_IDS[n] || 'A';
