// 快照编解码：权威服务端下行状态 + 客户端上行输入。
//
// 定死小端 + 定点量化，不用 JSON：联网的第一原则是"包大小可预测"。
// 量化定义在 js/quant.js，两端 import 同一份 —— 两边各抄一份的症状是"对面的人在抖"，
// 而不是报错。每个 pack/unpack 的最大误差由本文件的自测实测印出，不写猜的数。
import { Q, FLAG } from '../js/quant.js';

export { Q, FLAG };

// 每个实体固定 21 字节：id2 + xyz6 + yaw2 + pitch2 + hp1 + flags1 + weapon1 + mag1 + phase1 + vel4
export const ENTITY_SIZE = 21;
export const HEADER_SIZE = 7;                        // tick4 + seq1 + count1 + worldFlags1

export function encodeSnapshot(snap, scratch = new DataView(new ArrayBuffer(HEADER_SIZE + 64 * ENTITY_SIZE))) {
  const p = snap.entities.length;
  const need = HEADER_SIZE + p * ENTITY_SIZE;
  const view = scratch.byteLength >= need ? scratch : new DataView(new ArrayBuffer(need));
  let o = 0;
  view.setUint32(o, snap.tick >>> 0, true); o += 4;
  view.setUint8(o, snap.seq & 0xff, true); o += 1;
  view.setUint8(o, p, true); o += 1;
  view.setUint8(o, snap.worldFlags, true); o += 1;
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
    });
    o += ENTITY_SIZE;
  }
  return { tick, seq, worldFlags, entities, byteLength: o };
}

// 上行输入：一个 tick 一份，12 字节定长
export const INPUT_SIZE = 12;
export function encodeInput(inp) {
  const v = new DataView(new ArrayBuffer(INPUT_SIZE));
  v.setUint32(0, inp.tick >>> 0, true);
  v.setInt16(4, Q.packLook(inp.mdx), true);
  v.setInt16(6, Q.packLook(inp.mdy), true);
  v.setUint16(8, inp.keys & 0xffff, true);
  v.setUint8(10, inp.buttons & 0xff, true);
  v.setUint8(11, inp.seq & 0xff, true);
  return v;
}
export function decodeInput(buf) {
  const v = asDataView(buf);
  return {
    tick: v.getUint32(0, true),
    mdx: Q.unpackLook(v.getInt16(4, true)),
    mdy: Q.unpackLook(v.getInt16(6, true)),
    keys: v.getUint16(8, true),
    buttons: v.getUint8(10),
    seq: v.getUint8(11),
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
    });
  }
  const { view, byteLength } = encodeSnapshot({ tick: 123456, seq: 9, worldFlags: 1, entities: ents });
  if (byteLength !== HEADER_SIZE + 16 * ENTITY_SIZE) throw new Error(`包长 ${byteLength} 与 ${HEADER_SIZE}+16×${ENTITY_SIZE} 不符`);
  const back = decodeSnapshot(view);
  let maxPos = 0, maxYaw = 0, maxPitch = 0, maxVel = 0;
  for (let i = 0; i < ents.length; i++) {
    const a = ents[i], b = back.entities[i];
    maxPos = Math.max(maxPos, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    maxYaw = Math.max(maxYaw, Math.abs(a.yaw - b.yaw));
    maxPitch = Math.max(maxPitch, Math.abs(a.pitch - b.pitch));
    maxVel = Math.max(maxVel, Math.abs(a.vx - b.vx), Math.abs(a.vz - b.vz));
    if (a.id !== b.id || a.hp !== b.hp || a.flags !== b.flags || a.weapon !== b.weapon || a.mag !== b.mag || a.phase !== b.phase) {
      throw new Error('整数字段没原样回来');
    }
  }
  if (back.tick !== 123456 || back.seq !== 9 || back.worldFlags !== 1) throw new Error('头部失真');
  console.log(`  快照：16 人 ${byteLength} 字节 = ${(byteLength / 16).toFixed(1)} B/人（含头 ${HEADER_SIZE} B）`);
  console.log(`        @20Hz 下行 ${(byteLength * 20 * 8 / 1000).toFixed(1)} kbps，@30Hz ${(byteLength * 30 * 8 / 1000).toFixed(1)} kbps`);
  console.log(`  最大量化误差：位置 ${(maxPos * 100).toFixed(2)} cm · yaw ${maxYaw.toExponential(1)} rad · pitch ${maxPitch.toExponential(1)} rad · 速度 ${maxVel.toFixed(3)} m/s`);
  const inp = { tick: 4294967295, mdx: 3.7, mdy: -1.25, keys: 0b1011, buttons: 5, seq: 200 };
  const ib = decodeInput(encodeInput(inp));
  const lossless = ib.tick === inp.tick && ib.keys === inp.keys && ib.buttons === inp.buttons && ib.seq === inp.seq;
  console.log(`  输入包 ${INPUT_SIZE} B：整数字段${lossless ? '原样' : '失真'}，视线位移 ${inp.mdx}→${ib.mdx.toFixed(4)} / ${inp.mdy}→${ib.mdy.toFixed(4)}（步长 0.01）`);
  if (!lossless) process.exit(1);
  console.log('  ✅ codec 自测通过');
}
