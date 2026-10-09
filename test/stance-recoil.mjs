// 姿态后坐力档位 + 高倍镜 sway / 连射 bloom 的机制证明（不需要浏览器，不需要服务端在场）。
//
// 被钉住的契约（2026-10"收益与惩罚"轮）：
//   A 段  fire() 的姿态后坐力表 —— 相对武器标称后坐：站 ×1.15（惩罚最大）、
//         蹲 ×1.05（轻微增大，不再是免费折扣）、趴 ×0.5（大幅降低）。旧表 0.85/0.75 不许回来。
//   B 段  高倍镜悬停漂移 —— zoom ≥ 2 满镜后视线缓慢漂移：写进 yaw/pitch（弹道所见即所打）、
//         出镜净位移为零、姿态减档（趴减半）、移动加重、低倍镜一格不漂（反证）。
//   C 段  高倍镜连射扩散 —— adsSpread 按 (zoom-1) 逐发上浮、10 发封顶；低倍镜不浮（反证）；
//         栓动/半自动因 0.12s 清零 shotsInRow 天然不吃这条（先决：机制前提真的成立）。
//   D 段  回滚重放 —— sway 三个字段进 J_WS 后，"退回去重演"与顺跑逐位相同；
//         反证臂：把 swayX 从 J_WS 里抽掉，重放必须当场分叉。
//
// 量具纪律：A/C 用"真 WeaponState + 桩 game"把变量隔离到只差姿态/倍率一格；
// B/D 用 HeadlessGame 走真 Player 的完整路径（sway 写的 yaw/pitch 要过 journal）。
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { Player, J_PL, J_WS } from '../js/player.js';
import { WeaponState } from '../js/weapon-state.js';
import { computeStats } from '../js/data.js';
import { DEG } from '../js/util.js';
import * as THREE from 'three';

const DT = 1 / 60;
let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  | ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  | ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// ───────────────────── 桩 game：只给 fire()/currentSpread() 会碰的出口 ─────────────────────
function mkDirect(id, att = {}) {
  const g = {
    audio: { shot() {}, empty() {}, reload() {}, ui() {}, click() {} },
    hud: {}, entities: [], projectiles: [], noises: [],
    makeNoise() {}, time: 0, mode: null, net: null,
    world: { raycast: () => null },
  };
  const pl = {
    pos: new THREE.Vector3(), vel: { x: 0, z: 0 }, onGround: true,
    crouchT: 0, proneT: 0, sprinting: false, sliding: false,
    team: 'A', alive: true, hp: 100, maxHp: 100,
    yaw: 0, pitch: 0, revealT: 0, hasPerk: () => false,
    stats: { shots: 0, hits: 0 },
    eyePoint: (v) => v.set(0, 1.62, 0), aimDir: (v) => v.set(0, 0, -1), punch() {},
    rng: { next: () => 0.5, state: () => 1, setState() {} },
  };
  const ws = new WeaponState(g, pl);
  ws.setLoadout([{ id, att }]);
  return { g, pl, ws };
}
function tick(d, inp) { d.g.time += DT; d.ws.update(DT, inp); }
const IN = (over = {}) => Object.assign({
  fwd: false, back: false, left: false, right: false, sprint: false,
  jumpPressed: false, crouchPressed: false, pronePressed: false,
  reloadPressed: false, swapPressed: false, meleePressed: false,
  slot1: false, slot2: false, lethalPressed: false, tacticalPressed: false,
  lethal: false, tactical: false, interact: false, interactPressed: false,
  nvgPressed: false, fire: false, firePressed: false, ads: false, adsPressed: false,
  mdx: 0, mdy: 0, leanL: false, leanR: false,
}, over);

// 走完 equip 的 'switch'（0.5s），否则量的是"没开过枪"
function settle(d, n = 40) { for (let i = 0; i < n; i++) tick(d, IN()); }

// 打一发并量这一发的后坐：Δpitch + Δrp 恰好等于 kick 全量（0.55 + 0.45）。
// ads 臂要先把镜**拉满**再击发 —— 只按住两拍的话 adsT 才爬到零点几，量的是半开镜。
function shotKick(d, { ads = false, crouchT = 0, proneT = 0 } = {}) {
  d.pl.crouchT = crouchT; d.pl.proneT = proneT;
  d.ws.cool = 0; d.ws.cycleT = 0; d.ws.state = 'idle';
  if (ads) { for (let i = 0; i < 120 && d.ws.adsT < 0.999; i++) tick(d, IN({ ads })); }
  else tick(d, IN());
  d.g.time += 0.3;                                 // 越过 0.12s：shotsInRow 清零
  const p0 = d.pl.pitch, r0 = d.ws.rp, y0 = d.pl.yaw;
  tick(d, IN({ fire: true, ads }));
  return { kick: (d.pl.pitch - p0) + (d.ws.rp - r0), dyaw: d.pl.yaw - y0 };
}

async function main() {
  await preloadMaterials();

  // ═══════════════ A 段：fire() 的姿态后坐力表 ═══════════════
  {
    const d = mkDirect('m4');                       // 机瞄（zoom 1.2）：sway 一格不参与
    settle(d);
    const st = computeStats('m4', {});
    const nom = st.recoilV * 0.55 * DEG;            // 标称满量（无姿态、无 ADS）
    const ks = shotKick(d);                          // 站
    const kc = shotKick(d, { crouchT: 1 });          // 蹲
    const kp = shotKick(d, { crouchT: 1, proneT: 1 }); // 趴（趴时 crouching 同真：证明先判趴层）
    const ka = shotKick(d, { ads: true });          // 站 + 满镜
    chk(d.pl.stats.shots === 4, 'A0 先决：四枪都真的击发了', `shots=${d.pl.stats.shots}`);
    chk(near(ks.kick, nom * 1.15, 1e-6), 'A1 站立 = 标称 ×1.15（惩罚最大）', `${(ks.kick / nom).toFixed(4)}`);
    chk(near(kc.kick, nom * 1.05, 1e-6), 'A2 蹲姿 = 标称 ×1.05（轻微增大）', `${(kc.kick / nom).toFixed(4)}`);
    chk(near(kp.kick, nom * 0.5, 1e-6), 'A3 趴姿 = 标称 ×0.5（大幅降低）', `${(kp.kick / nom).toFixed(4)}`);
    chk(near(ka.kick, nom * 0.75 * 1.15, 1e-6), 'A4 站立满镜 = ×0.75×1.15（ADS 折扣与姿态档位相乘）', `${(ka.kick / nom).toFixed(4)}`);
    chk(ka.kick > nom * 0.75, 'A5 反证：满镜站立不再是旧的 0.75 净折扣（激光被砍）', `${(ka.kick / (nom * 0.75)).toFixed(3)}×`);
    chk(kc.kick > nom && ks.kick > kc.kick && kp.kick < nom * 0.6,
      'A6 排序：站 > 蹲 > 标称 > 趴（收益与惩罚各归各位）',
      `站${(ks.kick / nom).toFixed(2)} 蹲${(kc.kick / nom).toFixed(2)} 趴${(kp.kick / nom).toFixed(2)}`);
    const sideCap = 0.61 * st.recoilH * 0.5 * DEG * 1.15;   // (rng-0.4) ∈ (-0.4,0.6)
    chk(Math.abs(ks.dyaw) > 0 && Math.abs(ks.dyaw) < sideCap,
      'A7 横向后坐同吃姿态档位（上界按 ×1.15 封顶）', `dyaw=${ks.dyaw.toExponential(2)}`);
  }

  // ═══════════════ B 段：高倍镜悬停漂移（HeadlessGame 真路径） ═══════════════
  {
    const g = new HeadlessGame();
    await g.loadMap('yard');
    const mkPl = (att, x) => {
      const p = new Player(g, { team: 'A', pos: new THREE.Vector3(x, 0, 0), yaw: 0.7, name: 'p' + x });
      g.entities.push(p);
      p.equip({ primary: { id: 'm4', att }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: [] });
      p.pos.y = g.world.groundHeight(p.pos.x, p.pos.z, p.pos.y + 1, p.radius);
      return p;
    };
    const stand = mkPl({ optic: 'acog' }, 0);       // 4 倍：sway 全额
    const holo = mkPl({ optic: 'holo' }, 6);        // 1.4 倍：一格不漂（反证）
    const y0s = stand.yaw, p0s = stand.pitch, y0h = holo.yaw;

    // 两人同钟开镜：同一 t 相位下，量到的是同一支信号 —— 比值即档位系数
    const ads = IN({ ads: true });
    let maxS = 0, maxH = 0;
    for (let i = 0; i < 480; i++) {                 // 8 秒
      g.step(DT, ads, [{ pl: stand, inp: ads }, { pl: holo, inp: ads }]);
      maxS = Math.max(maxS, Math.abs(stand.ws.swayX), Math.abs(stand.ws.swayY));
      maxH = Math.max(maxH, Math.abs(holo.ws.swayX), Math.abs(holo.ws.swayY));
    }
    chk(stand.ws.adsT > 0.99 && holo.ws.adsT > 0.99, 'B0 先决：两人都满镜到位', `acog adsT=${stand.ws.adsT.toFixed(3)} holo=${holo.ws.adsT.toFixed(3)}`);
    const ampA = 0.5 * DEG;                          // ACOG(zoom4)：基准幅 (zoom-1)/3 = 1
    chk(maxS > ampA * 0.4 && maxS < ampA * 1.001,
      'B1 ACOG 满镜漂移真实存在且被基准幅封顶（0.5°）', `max=${(maxS / DEG).toFixed(3)}°`);
    chk(maxH === 0 && holo.ws.swayT === 0 && holo.ws.swayX === 0 && holo.ws.swayY === 0 && holo.yaw === y0h,
      'B2⁻ 反证：低倍镜（全息 1.4×）满镜一格不漂、视线纹丝不动', `max=${maxH.toExponential(2)}`);

    // 私有流：sway 期间一枪不开 ⇒ 流的游标不许动（漂移是 time 驱动，不是 rng 驱动）
    const rng0 = stand.rng.state();
    for (let i = 0; i < 120; i++) g.step(DT, ads, [{ pl: stand, inp: ads }]);
    chk(stand.rng.state() === rng0 && Math.abs(stand.ws.swayX) > 0,
      'B3 sway 不消耗私有随机流（且先决：漂移确实在动）', `swayX=${stand.ws.swayX.toExponential(2)}`);

    // 趴姿减档：先回站立基线（同相位窗口没法复用了，直接比两人——趴者另起一位）
    const pronePl = mkPl({ optic: 'acog' }, 12);
    pronePl.pos.y = g.world.groundHeight(pronePl.pos.x, pronePl.pos.z, pronePl.pos.y + 1, pronePl.radius);
    const pr = IN({ ads: true, pronePressed: true });
    const ads2 = IN({ ads: true });
    let maxP = 0, maxS2 = 0, proneSet = false;
    for (let i = 0; i < 480; i++) {
      const pi = i === 0 ? pr : ads2;                // 第一拍按 Z，之后只按住开镜
      g.step(DT, ads2, [{ pl: stand, inp: ads2 }, { pl: pronePl, inp: pi }]);
      if (pronePl.proneT > 0.5) proneSet = true;
      if (proneSet) {
        maxP = Math.max(maxP, Math.abs(pronePl.ws.swayX), Math.abs(pronePl.ws.swayY));
        maxS2 = Math.max(maxS2, Math.abs(stand.ws.swayX), Math.abs(stand.ws.swayY));
      }
    }
    chk(proneSet, 'B4 先决：趴层真的成立了', `proneT=${pronePl.proneT.toFixed(2)}`);
    chk(maxP < maxS2 * 0.55 && maxP > 0,
      'B5 趴姿漂移 ≈ 站立的一半（架在地上最稳）', `趴${(maxP / DEG).toFixed(3)}° vs 站${(maxS2 / DEG).toFixed(3)}°`);

    // 出镜收回：净位移为零（swayX/Y 精确归零，视线回到进镜前的原位）
    const none = IN();
    let settled = false;
    for (let i = 0; i < 300 && !settled; i++) { g.step(DT, none, [{ pl: stand, inp: none }]); settled = stand.ws.swayT === 0; }
    chk(settled && stand.ws.swayX === 0 && stand.ws.swayY === 0,
      'B6 出镜后漂移精确归零（snap 通道真的走到 0）', `swayT=${stand.ws.swayT} X=${stand.ws.swayX} Y=${stand.ws.swayY}`);
    chk(Math.abs(stand.yaw - y0s) < 1e-9 && Math.abs(stand.pitch - p0s) < 1e-9,
      'B7 出镜后视线净位移为零（delta 通道收回，不留永久偏移）',
      `Δyaw=${(stand.yaw - y0s).toExponential(2)} Δpitch=${(stand.pitch - p0s).toExponential(2)}`);
  }

  // ═══════════════ C 段：高倍镜连射扩散（bloom） ═══════════════
  {
    const spreadAt = (att, shotsInRow) => {
      const d = mkDirect('m4', att);
      settle(d);
      d.ws.adsT = 1; d.ws.shotsInRow = shotsInRow;
      return d.ws.currentSpread();
    };
    const s0 = spreadAt({ optic: 'acog' }, 0), s10 = spreadAt({ optic: 'acog' }, 10);
    chk(near(s10 / s0, 2.5, 1e-6), 'C1 ACOG 连射第 10 发扩散 2.5×（每发 +5%×(zoom−1)，封顶 10 发）', `${(s10 / s0).toFixed(3)}`);
    const t0 = spreadAt({ optic: 'thermal' }, 0), t10 = spreadAt({ optic: 'thermal' }, 10);
    chk(near(t10 / t0, 1.75, 1e-6), 'C2 热成像（2.5×）也在征敛内：10 发 1.75×（阈值是 zoom≥2，不是 ≥4）', `${(t10 / t0).toFixed(3)}`);
    chk(near(spreadAt({ optic: 'holo' }, 10) / spreadAt({ optic: 'holo' }, 0), 1, 1e-9),
      'C3⁻ 反证：低倍镜连射不扩散（惩罚只属于高倍镜）', '');
    // 栓动不吃 bloom 的机制前提：0.12s 一过 shotsInRow 必清零（L115 射速 44rpm = 1.36s/发）
    const b = mkDirect('l115');
    settle(b);
    tick(b, IN({ fire: true }));
    chk(b.pl.stats.shots === 1 && b.ws.shotsInRow === 1, 'C4 先决：狙真的开了一枪且连射计数在涨', `shots=${b.pl.stats.shots} row=${b.ws.shotsInRow}`);
    for (let i = 0; i < 15; i++) tick(b, IN());      // 0.25s > 0.12s
    chk(b.ws.shotsInRow === 0, 'C5 栓动的两发之间连射计数必然清零 ⇒ 狙击镜永远不吃 bloom', `row=${b.ws.shotsInRow}`);
  }

  // ═══════════════ D 段：sway 状态进日记本，回滚重放逐位相同 ═══════════════
  {
    const g = new HeadlessGame();
    await g.loadMap('yard');
    const pl = new Player(g, { team: 'A', pos: new THREE.Vector3(0, 0, 0), yaw: 0.7, name: '甲' });
    g.player = pl; g.entities.push(pl);
    pl.equip({ primary: { id: 'm4', att: { optic: 'acog' } }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: [] });
    pl.pos.y = g.world.groundHeight(pl.pos.x, pl.pos.z, pl.pos.y + 1, pl.radius);

    // 脚本：满镜 + sway 全程在线，长短点射交错，中途趴一次（sway 减档也要重演一致）
    const script = (i) => {
      const inp = IN({ ads: i > 45, fire: i > 80 && i < 200 && (i % 5 !== 4), mdx: i % 9 === 0 ? 0.5 : 0 });
      if (i === 240) inp.pronePressed = true;
      if (i === 300) inp.pronePressed = true;        // 起身
      return inp;
    };
    const keysWs = [...J_WS];                        // stateVec 的键在反证臂splice前定死
    const stateVec = (p, gm) => {
      const v = { time: gm.time, rng: p.rng.state(), cur: p.ws.cur };
      for (const k of J_PL) v['pl.' + k] = p[k];
      for (const k of keysWs) v['ws.' + k] = p.ws[k];
      v.pos = [p.pos.x, p.pos.y, p.pos.z].join(',');
      v.vel = [p.vel.x, p.vel.y, p.vel.z].join(',');
      v.ammo = p.ws.slots.map(s => s.mag + '/' + s.reserve).join(' ');
      return v;
    };
    const diff = (a, b) => Object.keys(a).filter(k => a[k] !== b[k]).map(k => `${k}: ${a[k]} vs ${b[k]}`);

    const N = 360, J = [], INL = [];
    for (let i = 0; i < N; i++) {
      J.push(pl.journal());
      INL.push(script(i));
      g.time += DT;
      pl.update(DT, INL[i]);
    }
    const live = stateVec(pl, g);
    chk(pl.stats.shots >= 15, 'D0 先决：脚本真的打出去足够多的枪', `shots=${pl.stats.shots}`);
    const swayIdx = J.findIndex((j, i) => i > 60 && Math.abs(j['ws.swayX'] || 0) > 1e-4);
    chk(swayIdx > 60, 'D1 先决：回滚点选在漂移真实在线的拍上（不是量空气）', `tick=${swayIdx} swayX=${J[swayIdx] && J[swayIdx]['ws.swayX'].toExponential(2)}`);

    const replayFrom = (k) => {
      pl.applyJournal(J[k]);
      for (let i = k; i < N; i++) { g.time += DT; pl.update(DT, INL[i], { replay: true }); }
      return stateVec(pl, g);
    };
    chk(diff(live, replayFrom(swayIdx)).length === 0, 'D2 退回漂移在线的那一拍重演 300 拍：与顺跑逐位相同', '');

    // 反证：把 swayX 抽出 J_WS ⇒ journal/applyJournal 都不再带它 ⇒ 重放必然分叉
    const ix = J_WS.indexOf('swayX');
    J_WS.splice(ix, 1);
    let d3;
    try { d3 = diff(live, replayFrom(swayIdx)); } finally { J_WS.splice(ix, 0, 'swayX'); }
    chk(d3.length > 0, 'D3⁻ 反证：swayX 不进日记本 ⇒ 重放当场分叉（这条登记不是装饰）', d3.slice(0, 3).join(' · '));
  }

  console.log(fails ? `\n${fails} FAIL / ${checks}` : `\nALL GREEN ${checks}`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
