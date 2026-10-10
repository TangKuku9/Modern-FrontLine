// 占点（dom）出生位审计。用户实测报了两件事：
//   ① 开局就有敌方 Bot 站在 B 点附近开始占点；
//   ② 有时重生落在一个既不是基地也不是据点的位置。
// 这一项不去猜，直接把**被测的那两个函数**（js/mp.js:MPMatch.spawnPoint 与
// server/room.mjs:NetRoom.spawnPoint）大量抽样，给每个落点归类。
//
//   node test/spawn-audit.mjs
//
// 分类口径（按用户报的两件事定，不是按代码内部结构定）：
//   base-declared   —— 命中的是本队声明的出生点（w.spawns[team] 里那几格）
//   flag-own        —— 落在本队已占据点的弱圈内（"在已占点重生"，规格里允许）
//   flag-neutral    —— 落在**中立**据点弱圈内 ⇒ 出生即为占领出力（症状①）
//   flag-enemy      —— 落在敌方已占据点弱圈内
//   base-terrace    —— 没命中声明点，但落在本队出生台地上（随机撒点恰好撒回家）
//   field           —— 既不是基地也不是据点（症状②）
// 另有两个附水量具：中立期随机落点撞进据点圆的面积占比；randomWalkable 60 次
// 全失败时退回图心 (0,0) 的命中次数（那也是一个"既非基地也非据点"的落点）。
import * as THREE from 'three';
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { NetRoom } from '../server/room.mjs';
import { MPMatch } from '../js/mp.js';
import { rng } from '../js/rng.js';
import { DOM_RADIUS_WEAK, flagsTick } from '../js/match-rules.js';
import { SITE } from '../js/maps/ridges.js';

const MAP = 'ridges';
const N = +process.env.N || 4000;
const pctl = (a, b) => (100 * a / b).toFixed(2) + '%';

async function makeGame() {
  await preloadMaterials();
  const game = new HeadlessGame();
  await game.loadMap(MAP);
  return game;
}

// 落点归类。flags 是**当时**的归属状态（开局全 null），所以调用方按场景传。
function classify(pos, team, w, flags) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  let dec = 1e9;
  for (const s of (w.spawns[team] || [])) dec = Math.min(dec, d(pos, s));
  let near = null, nd = 1e9;
  for (const f of flags) { const dd = d(pos, f.pos); if (dd < nd) { nd = dd; near = f; } }
  const terr = team === 'A' ? SITE.spawnA : SITE.spawnB;
  const dTerr = d(pos, terr);
  const tag = (b) => ({ bucket: b, dec, nd, flag: near && near.name });
  if (dec <= 2) return tag('base-declared');
  if (near && nd < DOM_RADIUS_WEAK) {
    return tag(near.owner === team ? 'flag-own' : near.owner ? 'flag-enemy' : 'flag-neutral');
  }
  if (dTerr <= terr.r) return tag('base-terrace');
  return tag('field');
}

const tally = () => ({ 'base-declared': 0, 'flag-own': 0, 'flag-neutral': 0, 'flag-enemy': 0, 'base-terrace': 0, 'field': 0, center00: 0 });
function report(title, t, n) {
  console.log('\n' + title);
  for (const k of ['base-declared', 'base-terrace', 'flag-own', 'flag-neutral', 'flag-enemy', 'field']) {
    if (t[k]) console.log(`   ${k.padEnd(15)} ${String(t[k]).padStart(5)}  ${pctl(t[k], n)}`);
  }
  const symptom1 = t['flag-neutral'] + t['flag-enemy'];
  const symptom2 = t['field'];
  console.log(`   → 症状①（出生即在他人未占/敌方圈内，开局就出力占点）: ${pctl(symptom1, n)}`);
  console.log(`   → 症状②（既不是基地也不是据点的野地）        : ${pctl(symptom2, n)}`);
  if (t.center00) console.log(`   → randomWalkable 退回图心 (0,0) 的次数        : ${t.center00}`);
}

// ── 场景表 ──
// start  —— 开局：对面全队站在**他们自己**的台地上（离任何据点 >130m ⇒ 距离分全部饱和）
// mid    —— 中期：敌方 3 人压在中央 B 点、2 人还在自己台地
// camped —— 被压家：敌方 3 人站在**我方**台地上。这一档量的是"躲敌人"失效时退到哪儿
function foes(scenario, team) {
  const foeTeam = team === 'A' ? 'B' : 'A';
  const enemy = team === 'A' ? SITE.spawnB : SITE.spawnA;   // 对面老家
  const own = team === 'A' ? SITE.spawnA : SITE.spawnB;     // 我方老家
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  if (scenario === 'start') {
    return [{ alive: true, team: foeTeam, pos: V(enemy.x, 8, enemy.z) }];
  }
  if (scenario === 'camped') {
    return [0, 1, 2].map(i => ({ alive: true, team: foeTeam, pos: V(own.x + i * 3, 8, own.z + i * 4) }));
  }
  const out = [];
  for (let i = 0; i < 3; i++) out.push({ alive: true, team: foeTeam, pos: V(20 + i * 3, 10, 18 - i * 4) });
  for (let i = 0; i < 2; i++) out.push({ alive: true, team: foeTeam, pos: V(enemy.x, 8, enemy.z + i * 6) });
  return out;
}

const game = await makeGame();
const w = game.world;
// 据点用世界算好的旗位（ridges 的 flagPos 已经 setY 过真实高程）—— flagsTick 有一道
// |Δy| < 3 的高度闸，用 y=0 的假旗位会把"生在圈里"量成"没占下"，那是量具错不是行为对。
const flagsAt = (owned) => w.flagPos.map((p, i) => ({
  name: 'ABC'[i], pos: p.clone(),
  owner: (owned === 'A' && i === 0) || (owned === 'mid' && i === 1) ? 'A'
    : (owned === 'B' && i === 2) ? 'B' : null,
}));

console.log(`地图 ${MAP} size=${w.def.size} half=${w.half}  声明出生点 A=${w.spawns.A.length} B=${w.spawns.B.length}  弱圈半径=${DOM_RADIUS_WEAK}m  抽样=${N}`);

// ═══ 1. 单机 js/mp.js:MPMatch.spawnPoint ═══
for (const scenario of ['start', 'mid', 'camped']) {
  for (const team of ['A', 'B']) {
    rng.seed(20261009);
    const m = Object.create(MPMatch.prototype);
    m.game = game; m.ffa = false; m.type = 'dom';
    const owned = scenario === 'mid' ? (team === 'A' ? 'A' : 'B') : null;
    m.flags = flagsAt(owned);
    m.game.entities = foes(scenario, team);
    const t = tally();
    for (let i = 0; i < N; i++) {
      const sp = m.spawnPoint(team);
      const c = classify(sp.pos, team, w, m.flags);
      t[c.bucket]++;
      if (Math.abs(sp.pos.x) < 1e-9 && Math.abs(sp.pos.z) < 1e-9) t.center00++;
    }
    report(`[单机 MPMatch] 场景=${scenario} 队伍=${team}  最近据点距离中位数见下`, t, N);
  }
}

// ═══ 2. 联机 server/room.mjs:NetRoom.spawnPoint ═══
{
  const room = new NetRoom({ id: 'audit', mapId: MAP, seed: 20261009, mode: 'dom' });
  await room.start();
  for (const scenario of ['start', 'mid', 'camped']) {
    for (const team of ['A', 'B']) {
      const owned = scenario === 'mid' ? (team === 'A' ? 'A' : 'B') : null;
      const flags = flagsAt(owned);
      room.flags = flags;
      room.game.bots = foes(scenario, team);
      rng.seed(20261009 + 7);
      const t = tally();
      for (let i = 0; i < N; i++) {
        const sp = room.spawnPoint(team);
        const c = classify(sp.pos, team, room.game.world, flags);
        t[c.bucket]++;
        if (Math.abs(sp.pos.x) < 1e-9 && Math.abs(sp.pos.z) < 1e-9) t.center00++;
      }
      report(`[联机 NetRoom] 场景=${scenario} 队伍=${team}`, t, N);
    }
  }
}

// ═══ 3. 整局开局复刻：按 MPMatch.start() 的建人顺序跑一遍 ═══
// start() 是"玩家 → 5 队友 → 6 敌人"，每个人出生时看到的人都比上一个多。
// 这里照抄那个顺序（人是假实体，spawnPoint 只读 team/alive/pos/isHeli 四格），
// 量的问题是：**这一局的开局名单里，有没有敌方 Bot 一出生就站在无人据点的圈里**。
{
  const MATCHES = +process.env.MATCHES || 800;
  const ALLIES = 5, ENEMIES = 6;
  let withEnemyOnFlag = 0, withAnyOnFlag = 0, fieldBots = 0, totalBots = 0;
  const worst = [];
  for (let k = 0; k < MATCHES; k++) {
    rng.seed(20261009 * (k + 1));
    const m = Object.create(MPMatch.prototype);
    m.game = game; m.ffa = false; m.type = 'dom';
    m.flags = flagsAt(null);
    m.game.entities = [];
    const bornOnFlag = { A: 0, B: 0 };
    const bornField = { A: 0, B: 0 };
    const seedOne = (team) => {
      const sp = m.spawnPoint(team);
      const c = classify(sp.pos, team, w, m.flags);
      m.game.entities.push({ alive: true, team, pos: sp.pos });
      if (c.bucket === 'flag-neutral' || c.bucket === 'flag-enemy') bornOnFlag[team]++;
      if (c.bucket === 'field') bornField[team]++;
    };
    seedOne('A');                                   // 玩家本人也是 spawnPoint('A')
    for (let i = 0; i < ALLIES; i++) seedOne('A');
    for (let i = 0; i < ENEMIES; i++) seedOne('B');
    totalBots += ALLIES + ENEMIES + 1;
    fieldBots += bornField.A + bornField.B;
    if (bornOnFlag.B) { withEnemyOnFlag++; worst.push(bornOnFlag.B); }
    if (bornOnFlag.A + bornOnFlag.B) withAnyOnFlag++;
  }
  console.log(`\n[开局复刻 ${MATCHES} 局 · 每局 12 人]`);
  console.log(`   至少 1 名**敌方** Bot 出生即站在无人据点圈内（开局直接占点）: ${pctl(withEnemyOnFlag, MATCHES)}`);
  console.log(`   任一队出生即站在据点圈内                                    : ${pctl(withAnyOnFlag, MATCHES)}`);
  console.log(`   出生落在野地（非基地非据点）的人次占比                      : ${pctl(fieldBots, totalBots)}`);
  console.log(`   最坏一局有几个敌方 Bot 生在圈里                             : ${Math.max(0, ...worst)}`);
}

// ═══ 4. 对照：随机撒点本身撞进据点圆的面积占比（量具自证：这条不依赖选点逻辑）═══
{
  rng.seed(20261009 + 11);
  const flags = flagsAt(null);
  let inCircle = 0, center = 0;
  for (let i = 0; i < N; i++) {
    const p = w.randomWalkable();
    if (flags.some(f => Math.hypot(p.x - f.pos.x, p.z - f.pos.z) < DOM_RADIUS_WEAK)) inCircle++;
    if (Math.abs(p.x) < 1e-9 && Math.abs(p.z) < 1e-9) center++;
  }
  console.log(`\n[对照] 单颗全图随机可走落点落在某个据点弱圆内的概率: ${pctl(inCircle, N)}（randomWalkable 退回图心 ${center} 次）`);
}

// ═══ 5. 为什么随机点会赢 —— "离敌人远"这把尺在开局是饱和的 ═══
// 打分式是 `Math.min(md, 60) + rng.next()*8`。开局双方各在图缘台地（相距 ~314m），
// 于是**所有**声明点的 md 都被夹成 60，随机点也一样是 60 —— 13 个候选只差那 0~8 的
// 噪声，等于抽签。这里把两个数直接读出来，免得这条结论停在推理层面。
{
  const enemy = SITE.spawnB;
  const mdOf = (p) => Math.hypot(p.x - enemy.x, p.z - enemy.z);
  const dec = w.spawns.A.map(mdOf);
  rng.seed(20261009);
  const rnd = [];
  for (let i = 0; i < 200; i++) rnd.push(mdOf(w.randomWalkable()));
  const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)];
  console.log(`\n[饱和] 打分上限=60m。开局敌人在对面台地时：`);
  console.log(`   A 队 7 个声明点到最近敌人的距离  min=${dec.map(Math.round).join(',')}  全部 >60 ⇒ 分值恒等于 60+噪声`);
  console.log(`   全图随机点到"敌人"的距离分位数  p10=${Math.round(q(rnd, .1))} p50=${Math.round(q(rnd, .5))} p90=${Math.round(q(rnd, .9))} ⇒ 绝大多数也被夹成 60`);
  console.log(`   ⇒ 随机候选与声明候选同分，胜负只由 0~8 噪声决定（单机 6 个随机 vs 7 个声明；联机每拍都放 6 个随机）`);
}

// ═══ 6. 后果实测：一个"生在圈里"的 Bot 真的能把点占下来吗（跑真的 flagsTick）═══
{
  rng.seed(20261009);
  const m = Object.create(MPMatch.prototype);
  m.game = game; m.ffa = false; m.type = 'dom';
  m.flags = flagsAt(null);
  m.game.entities = foes('start', 'B');
  const inCircle = [];
  for (let i = 0; i < 4000; i++) {
    const sp = m.spawnPoint('B');
    if (classify(sp.pos, 'B', w, m.flags).bucket === 'flag-neutral') inCircle.push(sp.pos);
  }
  // flagsTick 那道 |Δy|<3 的高度闸会不会替我们兜住一部分？逐个数一遍才知道。
  let gatePass = 0;
  for (const p of inCircle) {
    const f = m.flags.find(x => Math.hypot(p.x - x.pos.x, p.z - x.pos.z) < DOM_RADIUS_WEAK);
    if (f && Math.abs(p.y - f.pos.y) < 3) gatePass++;
  }
  console.log(`\n[后果] 生在中立圈里 ${inCircle.length} 次，其中通过 flagsTick 高度闸（|Δy|<3）的 ${gatePass} 次`);
  if (!inCircle.length) { console.log('   4000 次抽样没抽到生在圈里的落点，本节目跳过'); }
  else {
    const runs = inCircle.slice(0, 12).map((p) => {
      const bot = { alive: true, team: 'B', pos: p, targetable: true };
      const flags = flagsAt(null);
      let t = 0, cappedAt = -1, scored = 0;
      const rules = { addScore: (tm, v) => { if (tm === 'B') scored += v; }, domScoreRate: () => 0.3 };
      while (t < 120 && cappedAt < 0) {
        t += 1 / 60;
        if (flagsTick(flags, rules, [bot], 1 / 60).caps.length) cappedAt = t;
      }
      const f = flags.find(x => x.owner === 'B');
      const nd = f ? Math.hypot(p.x - f.pos.x, p.z - f.pos.z) : -1;
      return { cappedAt, name: f && f.name, nd, dy: f ? p.y - f.pos.y : 0 };
    });
    const capped = runs.filter(r => r.cappedAt > 0);
    console.log(`   单挑一个点占下来用了 ${capped.map(r => r.cappedAt.toFixed(1)).join('s / ')} 秒（共跑 ${runs.length} 个落点，占下 ${capped.length} 个）`);
    console.log(`   理论值：弱圈占领力 1 × DOM_CAP_RATE 0.03 ⇒ 33.3 秒；内圈力 2 ⇒ 16.7 秒`);
    if (capped.length < runs.length) console.log(`   未占下的 ${runs.length - capped.length} 个都是距旗心 ${Math.max(...runs.filter(r => r.cappedAt < 0).map(r => r.nd)).toFixed(1)}m / 高差 ${runs.filter(r => r.cappedAt < 0).map(r => r.dy.toFixed(1)).join(', ')}m —— 高度闸挡掉的，不是逻辑挡掉的`);
  }
}

