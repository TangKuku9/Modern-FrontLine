// 回滚重放的机制证明（不需要浏览器，也不需要服务端在场）。
//
// 命题很小但很硬：**把自身状态退回服务端已消费那一拍的下一格，再把之后的输入重演一遍，
// 结果必须和"从头顺跑到末态"逐位相同。** 不相同就说明预测会被每一份快照往错误的方向
// 拽一次 —— 那种错不会崩，只会手感怪，而且没人报错。
//
// 四条反证臂，为了让主命题不是空断言：
//   C1 不恢复武器时间轴（简易回滚的样子）      → 必须偏
//   C2 起点配错一格（journal[k] 配 S_{k+1}）    → 必须偏，并把偏多少米印出来
//   C3 不重置回血计时（让 dmgT 留在打之前）      → 血量必须被演回满，从而暴露缺陷
//   C4 权威端在我供不上输入时"按住上一份不放"多算了几拍 → 补演 rep 拍必须重建得逐位相同，
//      不补则必须偏（这一臂的另一半同时是正证：参照是一次独立顺跑，不共享被测代码的错）
// 外加量具自身的先决断言：重放期间静音替身必须真的被调用过（n>0），否则
// "重放没碰到 audio/hud" 只是什么都没测。
//
// 判据调的就是生产函数 js/net/predict.mjs:rollback —— 不在测试里抄第二份公式。
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { Player, J_PL, J_WS, muteCounts } from '../js/player.js';
import { rollback } from '../js/net/predict.mjs';
import { FLAG } from '../js/quant.js';
import { rng } from '../js/rng.js';
import * as THREE from 'three';

const DT = 1 / 60;
const N = 300;
const SEED = 4242;

let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  | ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  | ' + detail : ''}`);
}

// 一段覆盖所有被重演路径的输入脚本：走、冲刺、蹲→滑、跳、开镜、长短连发、换弹、切枪、近战
function script(i) {
  const inp = {
    fwd: false, back: false, left: false, right: false, jump: false, crouch: false, sprint: false,
    ads: false, fire: false, reload: false, swap: false, melee: false, nvg: false,
    jumpPressed: false, crouchPressed: false, reloadPressed: false, swapPressed: false,
    meleePressed: false, slot1: false, slot2: false, lethalPressed: false, tacticalPressed: false,
    lethal: false, tactical: false, interactPressed: false, mdx: 0, mdy: 0,
  };
  inp.fwd = i % 97 < 70;
  inp.sprint = i > 20 && i < 60 && inp.fwd;
  if (i === 40) inp.crouchPressed = true;             // 冲刺中按下蹲 → 滑行
  if (i === 58) inp.crouchPressed = true;
  inp.jumpPressed = (i === 90 || i === 180);
  inp.ads = i > 100 && i < 190;
  inp.mdx = (i % 7 === 0 ? 1 : 0) * 0.6;              // 一直有人在转视角
  inp.mdy = (i % 11 === 0 ? -1 : 0) * 0.35;
  const burst = (i > 110 && i < 175) || (i > 200 && i < 299);
  inp.fire = burst && (i % 3 !== 2);                  // 连发里故意留空拍
  if (i === 190) inp.reloadPressed = true;
  if (i === 230) inp.swapPressed = true;              // 切到手枪继续打
  if (i === 260) inp.meleePressed = true;
  return inp;
}

function extCalls(g) {
  return g.stubLog.filter(e => e.t === 'call' && (String(e.k).startsWith('audio.') || String(e.k).startsWith('hud.'))).length;
}

// 客户端要断言的完整自身状态
function stateVec(pl, g) {
  const ws = pl.ws, v = { time: g.time, rng: rng.state(), cur: ws.cur };
  for (const k of J_PL) v['pl.' + k] = pl[k];
  for (const k of J_WS) v['ws.' + k] = ws[k];
  v.pos = [pl.pos.x, pl.pos.y, pl.pos.z].join(',');
  v.vel = [pl.vel.x, pl.vel.y, pl.vel.z].join(',');
  v.ammo = ws.slots.map(s => s.mag + '/' + s.reserve).join(' ');
  v.cam = [pl.camPos.x, pl.camPos.y, pl.camPos.z, pl.aimYaw, pl.aimPitch].join(',');
  return v;
}
function diff(a, b) {
  const out = [];
  for (const k of Object.keys(a)) if (a[k] !== b[k]) out.push(`${k}: ${a[k]} vs ${b[k]}`);
  return out;
}
// "服务端快照里我这个实体"的样子：只有 authority 侧会写、且下行里真带着的那几维
function entityOf(pl) {
  return {
    x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, yaw: pl.yaw, pitch: pl.pitch,
    hp: pl.hp, vx: pl.vel.x, vz: pl.vel.z, flags: pl.alive ? FLAG.Alive : 0,
  };
}

async function main() {
  await preloadMaterials();
  const g = new HeadlessGame();
  await g.loadMap('yard');
  rng.seed(SEED);
  const pl = new Player(g, { team: 'A', pos: new THREE.Vector3(0, 0, 0), yaw: 0.7, name: '甲' });
  g.player = pl; g.entities.push(pl);
  pl.equip({ primary: { id: 'm4', att: { optic: 'holo', under: 'vgrip' } }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: [] });
  pl.pos.y = g.world.groundHeight(pl.pos.x, pl.pos.z, pl.pos.y + 1, pl.radius);

  // ---------- 顺跑一遍：逐拍留日记本 + 逐拍留"服务端会发的那个实体" ----------
  const J = [], RNG0 = [], RNG1 = [], ENT = [], inputs = [];
  for (let i = 0; i < N; i++) {
    inputs.push(script(i));
    J.push(pl.journal());
    RNG0.push(rng.state());
    g.time += DT;
    pl.update(DT, inputs[i]);
    RNG1.push(rng.state());
    ENT.push(entityOf(pl));                            // = 服务端消费完 I_i 之后那一拍的状态
  }
  const live = stateVec(pl, g);
  const extLive = extCalls(g);
  chk(extLive > 0, '先决：顺跑期间确实调用过 audio/hud 出口', `n=${extLive}`);
  chk(pl.stats.shots >= 12, '先决：脚本真的打出去足够多的枪（覆盖开火分支）', `shots=${pl.stats.shots}`);
  chk(live.cur === 1, '先决：切枪分支也被走过（末态握着手枪）', `cur=${live.cur}`);
  chk(g.projectiles.length === 0, '先决：这段没有投掷物干扰');

  const histFrom = (k) => {
    const out = [];
    for (let i = k; i < N; i++) out.push({ tick: i, inp: inputs[i], j: J[i] });
    return out;
  };

  // ---------- 主命题 ----------
  const Ks = [0, 1, 7, 40, 58, 91, 111, 150, 190, 231, 260, 298];
  let mutedTotal = 0;
  for (const ack of Ks) {
    const base = extCalls(g);
    muteCounts.audio.n = 0; muteCounts.hud.n = 0;
    const start = (ack + 1) & 0xffff;
    const r = rollback(g, pl, ack + 1 < N ? histFrom(start) : [], start, ENT[ack], RNG1[ack]);
    const d = diff(live, stateVec(pl, g));
    chk(d.length === 0, `ack=${ack} 回滚重演 ${r.replayed} 拍后与顺跑逐位相同`, d.length ? d.slice(0, 3).join(' | ') : `${Object.keys(live).length} 字段全等`);
    chk(r.corrected === 0, `ack=${ack} 预测与权威端零偏差（不需要拽）`, `corrected=${r.corrected}`);
    chk(!r.journalMiss, `ack=${ack} 回滚窗口够用，没退化成硬拉`);
    chk(extCalls(g) - base === 0, `ack=${ack} 重演期间没碰真 audio/hud`, `新增=${extCalls(g) - base}`);
    mutedTotal += muteCounts.audio.n + muteCounts.hud.n;
  }
  chk(mutedTotal > 20, '先决：重演确实大量撞过静音替身（否则"没碰真出口"是空断言）', `累计命中=${mutedTotal}`);

  // ---------- C1：恢复位置但不清空武器时间轴（= 没有 journal 的简易回滚） ----------
  {
    const ack = 111, start = ack + 1;
    const endTL = {}; for (const key of J_WS) endTL[key] = pl.ws[key];
    const endAmmo = pl.ws.slots.map(s => [s.mag, s.reserve]);
    const endCur = pl.ws.cur;
    pl.applyJournal(J[start]);
    for (const key of J_WS) pl.ws[key] = endTL[key];
    pl.ws.cur = endCur;
    for (let i = 0; i < endAmmo.length; i++) { pl.ws.slots[i].mag = endAmmo[i][0]; pl.ws.slots[i].reserve = endAmmo[i][1]; }
    rng.setState(RNG1[ack]);
    for (let i = start; i < N; i++) { g.time += DT; pl.update(DT, inputs[i], { replay: true }); }
    const d = diff(live, stateVec(pl, g));
    chk(d.length > 0, '反证 C1：不恢复武器时间轴 ⇒ 必须偏离顺跑', `偏 ${d.length} 个字段：${d.slice(0, 2).join(' | ')}`);
    chk(d.some(x => /^(ws\.cool|ws\.rp|ws\.state|ammo)/.test(x)), '反证 C1 偏的正是时间轴/弹药那几维', d.slice(0, 4).join(' | '));
  }

  // ---------- C2：起点配错一格（journal[ack] 去配 S_{ack+1} 的权威值） ----------
  {
    const ack = 111;
    rollback(g, pl, histFrom(ack), ack, ENT[ack], RNG1[ack]);   // 少退一格 = I_ack 演了两遍
    const d = diff(live, stateVec(pl, g));
    const pos = d.find(x => x.startsWith('pos:'));
    chk(d.length > 0, '反证 C2：起点配错一格 ⇒ 必须偏离顺跑', `偏 ${d.length} 个字段`);
    let metres = 0;
    if (pos) { const a = pos.split(' ')[1].split(',').map(Number), b = pos.split(' vs ')[1].split(',').map(Number); metres = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
    chk(metres > 0.01, '反证 C2 的偏差量级够大（不是浮点噪声）', `差 ${metres.toFixed(3)} m`);
    console.log(`      （C2 详情：配错一格会让末态位置差 ${metres.toFixed(3)} m，也就是每份快照超前一拍）`);
  }

  // ---------- C3：权威端掉血后，回血计时必须跟着归零 ----------
  {
    const ack = 150, start = ack + 1;
    const hurt = Object.assign({}, ENT[ack], { hp: 37 });
    rollback(g, pl, histFrom(start), start, hurt, RNG1[ack]);
    chk(pl.hp === 37, '权威端那一口伤害不会被重演回血抹掉', `hp=${pl.hp.toFixed(2)}｜dmgT=${pl.dmgT.toFixed(2)}`);
    // 重演了 149 拍 ⇒ dmgT 从 0 涨到 ~2.5；不重置的话它是从 journal 里那个 ~101 往上涨
    chk(pl.dmgT < 5, '回血计时被归零（这正是上一条成立的原因）', `dmgT=${pl.dmgT.toFixed(3)}`);
    // 反证臂：故意不归零 dmgT，同样的重演必须把血回满 —— 证明上一条不是白给的
    pl.applyJournal(J[start]); pl.hp = 37; rng.setState(RNG1[ack]);
    for (let i = start; i < N; i++) { g.time += DT; pl.update(DT, inputs[i], { replay: true }); }
    chk(pl.hp > 90, '反证 C3：不归零 dmgT 时同样的重演会把血回满（说明这条判据有牙齿）', `hp=${pl.hp.toFixed(2)}`);
  }

  // ---------- C4：服务端"按住上一份不放"的那几拍，客户端必须能把它补回来 ----------
  // 队列空时服务端拿 lastInput 再算一拍（人不会站住）。这一拍不在任何 ack 里，
  // 于是"我发到 ack 的那几拍"就不再等于"服务端折叠的序列"—— 真浏览器里实测过：
  // 权威读数恰好落在本地日记本的第 start+rep 拍上（差 4 mm），撞墙时被放大成 0.9 m 硬拉。
  // 判据写成"能重建"而不是"偏差不大"：参照是一次**独立的顺跑**（多折叠 r 拍），
  // 不用日记本、不用 replay，所以它不会和被测代码共享同一个错。
  {
    const ack = 91, extra = 3, start = ack + 1;
    pl.applyJournal(J[0]); rng.setState(RNG0[0]);
    let ENT4 = null, RNG4 = null;
    for (let i = 0; i < N; i++) {
      g.time += DT; pl.update(DT, inputs[i]);
      if (i === ack) {
        for (let k = 0; k < extra; k++) { g.time += DT; pl.update(DT, inputs[ack]); }
        ENT4 = entityOf(pl); RNG4 = rng.state();     // = 服务端带着 rep=3 发下的那一份快照
      }
    }
    const ref4 = stateVec(pl, g);
    const rr = rollback(g, pl, histFrom(start), start, ENT4, RNG4, { rep: extra, hold: inputs[ack] });
    chk(rr.reps === extra, `回滚真的补演了 rep=${extra} 拍`, `reps=${rr.reps}`);
    const d4 = diff(ref4, stateVec(pl, g));
    chk(d4.length === 0, `补演之后与"多折叠 ${extra} 拍"的权威顺跑逐位相同`, d4.length ? d4.slice(0, 3).join(' | ') : `${Object.keys(ref4).length} 字段全等`);
    chk(rr.corrected < 1e-9, `补演后的基态与权威读数零偏差`, `corrected=${rr.corrected}`);
    // 反证：把 rep 抹成 0（=这条线没接上时的行为），同一份快照必须重建不出参照状态
    const rr2 = rollback(g, pl, histFrom(start), start, ENT4, RNG4, { rep: 0, hold: inputs[ack] });
    const d42 = diff(ref4, stateVec(pl, g));
    chk(d42.length > 0 || rr2.corrected > 0.01, '反证 C4：不补 rep 拍时同一份快照重建不出权威状态',
      `偏 ${d42.length} 个字段 · corrected=${rr2.corrected.toFixed(4)} m`);
    console.log(`      （C4 详情：少补 ${extra} 拍 ⇒ 基态差 ${(rr2.corrected * 100).toFixed(1)} cm，正是 ${extra} 拍的位移）`);
  }

  console.log(`\n${fails ? 'RED' : 'GREEN'}  ${checks - fails}/${checks} 通过`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.log('CRASH', e && (e.stack || e.message)); process.exit(2); });
