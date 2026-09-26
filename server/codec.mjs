// 快照编解码：权威服务端下行状态 + 客户端上行输入。
//
// 定死小端 + 定点量化，不用 JSON：联网的第一原则是"包大小可预测"。
// 量化定义在 js/quant.js，两端 import 同一份 —— 两边各抄一份的症状是"对面的人在抖"，
// 而不是报错。每个 pack/unpack 的最大误差由本文件的自测实测印出，不写猜的数。
import { Q, FLAG, packInput, unpackInput } from '../js/quant.js';

export { Q, FLAG };

// 每个实体固定 25 字节：id2 + xyz6 + yaw2 + pitch2 + hp1 + flags1 + weapon1 + mag1
//                              + phase1 + vel4 + team1 + ack2 + rep1
// rep = 服务端在 ack 那一拍之后又拿同一份输入折叠了几拍（队列空时的人肉按住）。
// 少了它，客户端重建的输入序列就比权威端少 rep 拍 —— 见 server/room.mjs:step 的注释。
export const ENTITY_SIZE = 25;
// 头部 11 字节：tick4 + seq1 + count1 + worldFlags1 + rngState4
// rngState 是权威端玩法随机流的当前内部状态：客户端回滚重放必须把流也拨回同一拍，
// 否则重放多抽的那几次会让两边永久错开（js/rng.js 的 state/setState 就是为它准备的）。
// ack 是这个玩家最近一份被服务端真正消费的输入序号 —— 客户端拿它才知道"我哪些输入还没被吃"。
export const HEADER_SIZE = 11;

export function encodeSnapshot(snap, scratch = new DataView(new ArrayBuffer(HEADER_SIZE + 64 * ENTITY_SIZE))) {
  const p = snap.entities.length;
  const need = HEADER_SIZE + p * ENTITY_SIZE;
  const view = scratch.byteLength >= need ? scratch : new DataView(new ArrayBuffer(need));
  let o = 0;
  view.setUint32(o, snap.tick >>> 0, true); o += 4;
  view.setUint8(o, snap.seq & 0xff, true); o += 1;
  view.setUint8(o, p, true); o += 1;
  view.setUint8(o, snap.worldFlags, true); o += 1;
  view.setUint32(o, (snap.rngState ?? 0) >>> 0, true); o += 4;
  for (const e of snap.entities) {
    view.setUint16(o, e.id, true); o += 2;
    view.setInt16(o, Q.packPos(e.x), true); o += 2;
    view.setInt16(o, Q.packPos(e.y), true); o += 2;
    view.setInt16(o, Q.packPos(e.z), true); o += 2;
    view.setUint16(o, Q.packYaw(e.yaw), true); o += 2;
    view.setInt16(o, Q.packPitch(e.pitch), true); o += 2;
    view.setUint8(o, Q.packHp(e.hp), true); o += 1;
    view.setUint8(o, e.flags & 0xff, true); o += 1;
    view.setUint8(o, e.weapon & 0xff, true); o += 1;
    view.setUint8(o, e.mag & 0xff, true); o += 1;
    view.setUint8(o, e.phase & 0xff, true); o += 1;
    view.setInt16(o, Q.packVel(e.vx), true); o += 2;
    view.setInt16(o, Q.packVel(e.vz), true); o += 2;
    view.setUint8(o, e.team ?? 0, true); o += 1;
    view.setUint16(o, e.ack ?? 0, true); o += 2;
    view.setUint8(o, e.rep ?? 0, true); o += 1;
  }
  return { view, byteLength: o };
}

export function asDataView(buf) {
  if (buf instanceof DataView) return buf;
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function decodeSnapshot(buf) {
  const view = asDataView(buf);
  let o = 0;
  const tick = view.getUint32(o, true); o += 4;
  const seq = view.getUint8(o); o += 1;
  const n = view.getUint8(o); o += 1;
  const worldFlags = view.getUint8(o); o += 1;
  const rngState = view.getUint32(o, true); o += 4;
  const entities = [];
  for (let i = 0; i < n; i++) {
    entities.push({
      id: view.getUint16(o, true),
      x: Q.unpackPos(view.getInt16(o + 2, true)),
      y: Q.unpackPos(view.getInt16(o + 4, true)),
      z: Q.unpackPos(view.getInt16(o + 6, true)),
      yaw: Q.unpackYaw(view.getUint16(o + 8, true)),
      pitch: Q.unpackPitch(view.getInt16(o + 10, true)),
      hp: Q.unpackHp(view.getUint8(o + 12)),
      flags: view.getUint8(o + 13),
      weapon: view.getUint8(o + 14),
      mag: view.getUint8(o + 15),
      phase: view.getUint8(o + 16),
      vx: Q.unpackVel(view.getInt16(o + 17, true)),
      vz: Q.unpackVel(view.getInt16(o + 19, true)),
      team: view.getUint8(o + 21),
      ack: view.getUint16(o + 22, true),
      rep: view.getUint8(o + 24),
    });
    o += ENTITY_SIZE;
  }
  if (o !== HEADER_SIZE + n * ENTITY_SIZE) throw new Error(`读到的长度 ${o} 与 ${HEADER_SIZE}+${n}×${ENTITY_SIZE} 不符`);
  return { tick, seq, worldFlags, rngState, entities, byteLength: o };
}

// 上行输入：一个 tick 一份，15 字节定长。
// buttons 从 8 位加宽到 16 位：投掷物要同时表达"按下"和"按住"，8 位装不下
// （原来把 lethal 的按住位接到开火位上，按住右键就会掏手雷）。
// view（u16）：发出这一拍时，客户端屏幕上渲染的是服务端的哪一拍（低 16 位）。
// 那是延迟补偿要的全部输入 —— 服务端据此把别人拨回开枪者当时看到的位置。
// 为什么不是 u8 的"延迟多少拍"：那个量得由客户端把 INTERP_DELAY 和自己的帧时序折进去算，
// 于是服务端和客户端各有一份"延迟模型"，改一个忘一个的症状是"高延迟下总是差一点"；
// 直接报拍号则不需要任何模型，而且能被 lastSnapSent 卡住上限（服务端真发过的那些拍）。
// 顺带一个好处：它让"客户端到底看的是哪一拍"这件事在排障时是可读的，而不是一个差值。
export const INPUT_SIZE = 15;
export function encodeInput(inp) {
  const v = new DataView(new ArrayBuffer(INPUT_SIZE));
  v.setUint32(0, inp.tick >>> 0, true);
  v.setInt16(4, Q.packLook(inp.mdx), true);
  v.setInt16(6, Q.packLook(inp.mdy), true);
  v.setUint16(8, inp.keys & 0xffff, true);
  v.setUint16(10, inp.buttons & 0xffff, true);
  v.setUint16(12, inp.view & 0xffff, true);
  v.setUint8(14, inp.seq & 0xff, true);
  return v;
}
export function decodeInput(buf) {
  const v = asDataView(buf);
  return {
    tick: v.getUint32(0, true),
    mdx: Q.unpackLook(v.getInt16(4, true)),
    mdy: Q.unpackLook(v.getInt16(6, true)),
    keys: v.getUint16(8, true),
    buttons: v.getUint16(10, true),
    view: v.getUint16(12, true),
    seq: v.getUint8(14),
  };
}

// 自测：node server/codec.mjs —— 误差和包大小都必须是量出来的数。
// 只比文件名：Windows 下 argv[1] 是 D:\... 而 import.meta.url 是 file:///D:/...；
// 用 path 模块正规化就要 import 'node:url'，那会让浏览器侧 import 这个文件直接失败。
const __base = (s) => String(s).split(/[\\/]/).pop();
if (typeof process !== 'undefined' && __base(process.argv[1] || '') === __base(import.meta.url)) {
  const ents = [];
  for (let i = 0; i < 16; i++) {
    ents.push({
      id: i + 1, x: -37.4123, y: 1.6184, z: 22.7719, yaw: 2.71828, pitch: -0.6,
      hp: 87, flags: FLAG.Alive | FLAG.OnGround, weapon: 3, mag: 21, phase: 77, vx: 3.2, vz: -1.7,
      team: i % 2, ack: i === 0 ? 65000 : i, rep: i === 0 ? 200 : i % 4,
    });
  }
  const { view, byteLength } = encodeSnapshot({ tick: 123456, seq: 9, worldFlags: 1, rngState: 3735928559, entities: ents });
  if (byteLength !== HEADER_SIZE + 16 * ENTITY_SIZE) throw new Error(`包长 ${byteLength} 与 ${HEADER_SIZE}+16×${ENTITY_SIZE} 不符`);
  const back = decodeSnapshot(view);
  if (back.rngState !== 3735928559) throw new Error(`玩法流状态没原样回来：${back.rngState}`);
  if (back.entities[0].ack !== 65000 || back.entities[1].ack !== 1) throw new Error(`ack 往返失真：${back.entities[0].ack}/${back.entities[1].ack}`);
  let maxPos = 0, maxYaw = 0, maxPitch = 0, maxVel = 0;
  for (let i = 0; i < ents.length; i++) {
    const a = ents[i], b = back.entities[i];
    maxPos = Math.max(maxPos, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    maxYaw = Math.max(maxYaw, Math.abs(a.yaw - b.yaw));
    maxPitch = Math.max(maxPitch, Math.abs(a.pitch - b.pitch));
    maxVel = Math.max(maxVel, Math.abs(a.vx - b.vx), Math.abs(a.vz - b.vz));
    if (a.id !== b.id || a.hp !== b.hp || a.flags !== b.flags || a.weapon !== b.weapon || a.mag !== b.mag || a.phase !== b.phase || a.rep !== b.rep) {
      throw new Error(`整数字段没原样回来（rep ${a.rep}→${b.rep}）`);
    }
  }
  if (back.tick !== 123456 || back.seq !== 9 || back.worldFlags !== 1) throw new Error('头部失真');
  console.log(`  快照：16 人 ${byteLength} 字节 = ${(byteLength / 16).toFixed(1)} B/人（含头 ${HEADER_SIZE} B）`);
  console.log(`        @20Hz 下行 ${(byteLength * 20 * 8 / 1000).toFixed(1)} kbps，@30Hz ${(byteLength * 30 * 8 / 1000).toFixed(1)} kbps`);
  console.log(`  最大量化误差：位置 ${(maxPos * 100).toFixed(2)} cm · yaw ${maxYaw.toExponential(1)} rad · pitch ${maxPitch.toExponential(1)} rad · 速度 ${maxVel.toFixed(3)} m/s`);
  const inp = { tick: 4294967295, mdx: 3.7, mdy: -1.25, keys: 0b1011, buttons: 5, seq: 200, view: 65437 };
  const ib = decodeInput(encodeInput(inp));
  const lossless = ib.tick === inp.tick && ib.keys === inp.keys && ib.buttons === inp.buttons && ib.seq === inp.seq && ib.view === inp.view;
  console.log(`  输入包 ${INPUT_SIZE} B：整数字段${lossless ? '原样' : '失真'}（含延迟补偿的 view ${inp.view}→${ib.view}），视线位移 ${inp.mdx}→${ib.mdx.toFixed(4)} / ${inp.mdy}→${ib.mdy.toFixed(4)}（步长 0.01）`);
  if (!lossless) process.exit(1);
  // view 是 u16 全量程的：延迟补偿要拿它跟服务端拍号对齐，所以它不是"小数字"，
  // 两个端点必须原样回来（曾经有字段在这里被当成有符号数，回绕值直接变负）。
  for (const v of [0, 1, 32767, 32768, 65535]) {
    const got = decodeInput(encodeInput({ tick: 0, mdx: 0, mdy: 0, keys: 0, buttons: 0, seq: 0, view: v })).view;
    if (got !== v) { console.log(`    ❌ view ${v} → ${got}（u16 全量程必须原样）`); process.exit(1); }
  }
  console.log('  view u16 全量程往返：0/1/32767/32768/65535 全部原样');

  // 按键映射往返：sim 的 input 有 21 个布尔字段，打包再解包必须逐个原样回来。
  // 这条是"按住右键掏手雷"那类错位的唯一防线 —— 位掩码写重了不会报错，只会手感怪。
  const fields = ['fwd', 'back', 'left', 'right', 'sprint', 'jumpPressed', 'crouchPressed', 'reloadPressed',
    'interact', 'interactPressed', 'nvgPressed', 'meleePressed', 'fire', 'ads', 'firePressed', 'adsPressed',
    'swapPressed', 'lethalPressed', 'lethal', 'tacticalPressed', 'tactical'];
  const bad = [];
  for (const f of fields) {
    const src = {}; src[f] = true;
    const { keys, buttons } = packInput(src);
    const back2 = unpackInput(keys, buttons);
    const lit = fields.filter(x => back2[x]);
    if (lit.length !== 1 || lit[0] !== f) bad.push(`${f} → [${lit.join(',')}]  keys=${keys} buttons=${buttons}`);
  }
  const all = {}; for (const f of fields) all[f] = true;
  const ak = packInput(all);
  const allBack = unpackInput(ak.keys, ak.buttons);
  const missing = fields.filter(f => !allBack[f]);
  console.log(`  按键映射往返：单字段${bad.length ? ` ${bad.length} 个错位` : ` ${fields.length} 个全部原样`}；全按下缺 ${missing.length ? missing.join(',') : '无'}（keys ${ak.keys} / buttons ${ak.buttons}）`);
  for (const b of bad.slice(0, 8)) console.log('    ❌ ' + b);
  if (bad.length || missing.length) process.exit(1);
  console.log('  ✅ codec 自测通过');
}
