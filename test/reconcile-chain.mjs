// 一条**快照链**上的回滚记账 —— 单包判据（test/rollback.mjs 的 C1~C7）看不到的那一类。
//
// 为什么必须另立一条，而不能靠 C6/C7 或 net-play 的稳态红线：
//   · C6 只喂**一个孤立的窗**，`lead` 是手工传进去的，基态是干净顺跑写下的那一格 ——
//     它没有"上一包"这个概念，所以"上一包那一刻有没有被正确传下来"这件事它量不到。
//   · C7 断言的是"对**固定基态**幂等"，三个基态都不变。它守的是"win[0].j 不许写回"，
//     不是"基态从哪来"。
//   · net-play 的稳态红线是**概率性**的：6 次取样里 0~3 次红，每次都得起两个浏览器、
//     跑 30 秒、还受软渲染帧率影响。拿它当"改对了"的证据要跑十几次。
//   真浏览器里剩下那条偶发红，形状是"基态那一格自己会偏"（carry 基态 Δpos 读到过
//   −0.19 / −0.22 / −0.59 m 这种量级）。这件事只能在链上量，所以判据也建在链上。
//
// 被测对象是**生产代码**：js/net/client.mjs 的 reconcile（用 detached 实例喂，绕开
// DOM/WebSocket 而**不**绕开逻辑），以及 js/net/predict.mjs 的 rollback。
// 测试自己只负责铺服务端那条轨迹与参考跑。
//
// 服务端那一侧用一张**显式排班表**（每步：消费一条 / 拿手里那份空跑），不是靠"包什么时候
// 到"涌现出来的 —— 后者会掺进乱序、抖动、事件循环这些与被测对象无关的变量。
// （tmp-carry-probe.mjs 第一版就这么翻过车：到达抖动让后一组的包先到，ack 倒退，
//   dAck 读出 65533，那一版量出来的红全是量具自己造的。）
//
// ── 判据为什么要**按窗口形状分开** ──
// predict.mjs 的 carry 通路只重演两种形状：`lead` 拍首段空跑 → dAck 条真输入 → `rep` 拍
// 末尾空跑。而服务端实际可能把空跑夹在**两次消费中间**（队列先空、再收到一批），那几拍
// 只能被排到前面 —— 差别是"那一点上施加的相邻两拍输入"，对按住不放的走位是零，对正在转
// 视角的一拍是亚厘米级。这是 c99f51f 就立过账的已知残差，**不是**一条能靠调阈值绕开的
// 东西。所以：
//   · 「空跑全在首段或末尾」的窗（= 代码的假设成立）⇒ 判据是**逐位重合**（< 1e-6）。
//   · 「空跑夹在中间」的窗（= 已知残差）    ⇒ 判据是 < 一拍位移（判据线由日记本自己量）。
// 两类都不许靠"总体最大偏差"含糊过去：混在一起时，前者的小残差会被后者掩盖，
// 而后者一旦变成"每窗都错"就再也不会有干净样本了（那才是要报的事故）。
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { Player } from '../js/player.js';
import { NetClient } from '../js/net/client.mjs';
import { rollback } from '../js/net/predict.mjs';
import { FLAG } from '../js/quant.js';
import { rng } from '../js/rng.js';
import * as THREE from 'three';

const DT = 1 / 60;
const SNAP = 3;                    // 与 server/room.mjs 的 SNAP_EVERY 同步
const SPEED = 4.7;                 // 满速 m/s（js/player.js 的行走上限）—— 判据线的来源
let checks = 0, fails = 0;
const chk = (label, cond, extra = '') => {
  checks++; if (!cond) fails++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`);
};

// 每一拍的输入都不一样（转向 + 时走时停）：把某几拍挪到别处/漏掉就不再等价。
// 输入恒定的话"步骤可交换"，误差最容易消失（这个项目里量过：STILL 那个对照臂全绿）。
function inputAt(i) {
  return {
    fwd: (i % 13) < 9, back: false, left: (i % 29) < 12, right: (i % 37) < 15,
    jump: false, crouch: false, sprint: false, ads: false, fire: false, reload: false,
    swap: false, melee: false, nvg: false,
    jumpPressed: false, crouchPressed: false, pronePressed: false, reloadPressed: false, swapPressed: false,
    meleePressed: false, slot1: false, slot2: false, lethalPressed: false, tacticalPressed: false,
    lethal: false, tactical: false, grenadePressed: false, interactPressed: false,
    mdx: ((i % 7) - 3) * 0.31, mdy: ((i % 5) - 2) * 0.17,
  };
}
// 服务端手里那份"还没收到任何输入"时的空输入：**没有 tick 字段** —— room.mjs 里
// `if (inp.tick !== undefined) c.ack = inp.tick` 就是靠这一点让"还没有输入"不动 ack。
const ZERO = inputAt(-1);

async function mkPlayer(g, name) {
  const pl = new Player(g, { team: 'A', pos: new THREE.Vector3(0, 0, 0), yaw: 0.7, name });
  pl.equip({ primary: { id: 'm4', att: { optic: 'holo', under: 'vgrip' } }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: [] });
  pl.pos.y = g.world.groundHeight(pl.pos.x, pl.pos.z, pl.pos.y + 1, pl.radius);
  g.player = pl; g.entities.push(pl);
  return pl;
}
const entityOf = (pl, ack, rep) => ({
  id: 1, x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, yaw: pl.yaw, pitch: pl.pitch,
  hp: pl.hp, flags: (pl.alive ? FLAG.Alive : 0) | (pl.crouchT > 0.5 ? FLAG.Crouch : 0) | (pl.onGround ? FLAG.OnGround : 0),
  weapon: 0, mag: 30, vx: pl.vel.x, vz: pl.vel.z, team: 0, ack, rep,
});

// 排班表：与 server/room.mjs:step 的记账逐字同构（每步二选一 + rep 的末尾连拍定义）。
// RATE < 1 ⇒ 客户端产拍比服务端步进慢 ⇒ 服务端会饿，空跑与 rep 由此而来。
function buildSchedule(K, RATE, T, stallEvery, stallLen) {
  // 客户端第 k 拍"发生在服务端第几步"：节拍比 + 停顿（每隔 stallEvery 拍卡 stallLen 步）。
  // 卡顿是必须的：均匀的节拍比只会把空跑**散开**（每窗一两拍、且总有消费），造不出
  // dAck=0 且 rep>dTick 的窗 —— 而真浏览器那条红正是"页面卡一下"造出来的
  // （卡顿时 ack 几拍不动、rep 涨过 dTick）。顺延之后所有输入都晚 stallLen 步到，
  // 队列会真的空掉，于是出现连续空跑。
  const produceAt = [];
  let delay = 0;
  for (let k = 0; k < K; k++) {
    if (k > 0 && k % stallEvery === 0) delay += stallLen;
    produceAt.push(Math.floor(k / RATE) + delay);
  }
  const steps = [];                       // 每步 { inp: 输入序号 | null(=手中那份仍是全零), fromQ }
  const snaps = [];
  let k = 0, ack = -1, rep = 0, got = false, last = null;
  const q = [];
  for (let t = 0; t < T; t++) {
    while (k < K && produceAt[k] <= t) { q.push(k); got = true; k++; }
    const fromQ = q.length > 0;
    const inp = fromQ ? q.shift() : last;
    if (inp !== null) ack = inp;
    rep = fromQ ? 0 : (got ? Math.min(255, rep + 1) : 0);
    last = inp;
    steps.push({ inp, fromQ });
    if ((t + 1) % SNAP === 0) snaps.push({ si: t, tick: t + 1, ack, rep });
  }
  // produceAt 一并交出去：run() 里"客户端第 k 拍什么时候产"必须读同一张表，
  // 而不是自己再推一遍 —— 推第二遍的话两处口径漂了，判据量的就不是被测对象了。
  return { steps, snaps, produceAt };
}

// 一个窗（两份快照之间那 3 步）的形状：真消费几条、空跑几条、空跑落在哪几段。
// 这是**独立从排班表读出来的**，不是从被测代码的 dAck/deficit/rep 反推的 ——
// 反推的话，"代码把空跑排错了位置"这件事会被算法本身抹平，判据就成了恒真。
function windowShape(steps, t0, t1) {
  let consume = 0, hold = 0, firstConsume = -1, lastConsume = -1;
  for (let t = t0; t < t1; t++) {
    if (steps[t].fromQ) { consume++; if (firstConsume < 0) firstConsume = t; lastConsume = t; }
    else hold++;
  }
  const leadActual = firstConsume < 0 ? hold : firstConsume - t0;
  const repActual = lastConsume < 0 ? 0 : (t1 - 1 - lastConsume);
  return { consume, hold, leadActual, repActual, middleHolds: hold - leadActual - repActual };
}

async function main() {
  await preloadMaterials();
  const T = 1200;                          // 服务端步数
  const RATE = 0.8;                        // 客户端产拍 / 服务端步进 —— <1 才会饿
  const DOWN = 2;                          // 快照延迟几拍送到（客户端得跑在 ack 前面才有可比样本）
  const K = Math.floor(T * RATE);
  // 停顿参数：每 40 拍卡 5 步 —— 真浏览器一次软渲染卡顿就是这个量级
  // 停顿参数：每 40 拍卡 5 步 —— 真浏览器一次软渲染卡顿就是这个量级
  const { steps, snaps, produceAt } = buildSchedule(K, RATE, T, 40, 5);
  const STEP_M = SPEED / 60;               // 满速一拍位移 —— 那条"尺子"的换算

  // ── 先验量具自己 ──
  {
    const consumed = steps.filter(s => s.fromQ).length;
    const held = steps.length - consumed;
    const lastSnap = snaps[snaps.length - 1];
    chk('先决 H1：排班表自己的算术成立 —— 消费步数 == 最后一个快照的 ack+1',
      consumed === lastSnap.ack + 1, `消费 ${consumed} 步 · 末包 ack=${lastSnap.ack}`);
    chk('先决 H2：空跑步数 == 末拍 − (ack+1)，且空跑真的发生了（否则 rep 恒为 0，整条链空转）',
      held === T - (lastSnap.ack + 1) && held > 0, `空跑 ${held} 步 / 共 ${T} 步`);
    // 这张表还得真的产出"空跑夹在中间"和"空跑全在首段/末尾"两种形状，
    // 否则下面按形状分开的两条判据里有一条永远没有样本（"没有样本"和"全绿"要分得开）。
    let clean = 0, dirty = 0;
    for (let i = 1; i < snaps.length; i++) {
      const sh = windowShape(steps, snaps[i - 1].si + 1, snaps[i].si + 1);
      if (sh.middleHolds > 0) dirty++; else clean++;
    }
    chk('先决 H3：两种窗口形状都有样本（假设成立的窗 / 空跑夹中间的窗）', clean > 10 && dirty > 10,
      `干净窗 ${clean} 个 · 夹中间 ${dirty} 个`);
  }

  const inputs = []; for (let i = 0; i < K; i++) inputs.push(inputAt(i));
  const at = (i) => (i === null || i === undefined ? ZERO : inputs[i]);

  // ── 服务端参考跑：按服务端真正施加的顺序展开（不用日记本、不用 replay） ──
  const srv = new HeadlessGame(); await srv.loadMap('yard');
  const spl = await mkPlayer(srv, 'srv');
  const draws0 = rng.draws;
  const ref = new Map();
  {
    let si = 0;
    for (let t = 0; t < T; t++) {
      const s = steps[t];
      srv.step(DT, at(s.inp), [{ pl: spl, inp: at(s.inp) }]);
      if (((t + 1) % SNAP) === 0) { const sn = snaps[si++]; ref.set(sn.tick, entityOf(spl, sn.ack, sn.rep)); }
    }
  }
  chk('先决 H4：参考跑与服务端同源（这一跑一个随机数都没抽 —— 否则两端不是同一台机器）',
    rng.draws - draws0 === 0, `抽数 ${rng.draws - draws0}`);
  {
    let moved = 0, prev = null;
    for (const [, e] of ref) { if (prev) moved = Math.max(moved, Math.hypot(e.x - prev.x, e.z - prev.z)); prev = e; }
    // 判据线 = 半速三拍（SNAP 拍 × 满速 / 2）—— 不是拍的脑袋：满速三拍是 SNAP × 4.7/60 ≈ 0.235 m，
    // 第一版我写了 0.3，比理论上限还高，于是"人在动"这条先决自己被判红。
    const need = SNAP * SPEED / 60 / 2;
    chk('先决 H5：参考跑的轨迹真的在动（否则"偏差为 0"是站着不动的恒真绿灯）',
      moved > need, `相邻快照最大位移 ${moved.toFixed(3)} m（线 ${need.toFixed(3)} = 半速三拍）`);
  }

  // ── 驱动生产代码 ──
  // ── 纯饥饿窗的**步数反证探针** ──
  // A7 钉的是"补演步数 == dTick（不是 wire 上的 rep）"。反证臂要换的变量因此是**步数**，
  // 不是基态来源（那个由 B1~B3 承担）：同一基态（landed）、同一窗、同一权威读数，只把
  // 补演拍数从 repUse 换回 wire 的 rep（= 改动前旧通路对这一窗的行为），必须偏。
  // 在**全新实例**里做（applyJournal(landed) 退回去、按 lead → rep 演完再比 corrected），
  // 不碰被测世界一个字节 —— 跨实例逐位重合这件事 A1 已经证过（同样的代码、不同的实例）。
  const cfProbe = async (e, start, landed, holdInp, lead, prevInp) => {
    const g2 = new HeadlessGame(); await g2.loadMap('yard');
    const pl2 = await mkPlayer(g2, 'cf');
    const win2 = [{ tick: start, inp: ZERO, j: landed }];
    const carry2 = { j: landed, inp: [], prevInp, lead, n: 0, src: 'landed' };
    const r2 = rollback(g2, pl2, win2, start, e, 0, { rep: e.rep | 0, hold: holdInp, carry: carry2, lead });
    return r2.corrected;
  };

  const run = async (keepLanded) => {
    const g = new HeadlessGame(); await g.loadMap('yard');
    const cl = await mkPlayer(g, 'cli');
    const net = Object.create(NetClient.prototype);
    Object.assign(net, {
      game: g, history: [], localTick: 0, snaps: 0, serverTick: 0, lastSnapTick: undefined,
      lastStart: undefined, lastRep: 0, lastRngState: 0, hardSnap: false, lastMyAlive: true,
      recIdx: 0, grace: 0, events: [], cid: 1, name: 'cli', team: 'A', remotes: new Map(), roster: new Map(),
      carryN: 0, carryLead: 0, carryMiss: 0, carryWhy: [], repsApplied: 0, steadyN: 0, reconciles: 0,
      carryStepsBad: 0, carryStepsWhy: [], baseLanded: 0, baseFellBack: 0, baseFallWhy: [],
      lastLanding: null, lastLandingTick: null,
      snapLog: [], worldFlags: 0, mySnapshot: null, hpMin: undefined, srvWeapon: undefined,
      remotePlayers: [], ids: new Map(),
    });
    const rows = []; const traces = [];
    let k = 0, di = 0, prevSi = null;
    const due = snaps.map(sn => ({ at: sn.si + DOWN, sn }));
    for (let t = 0; t < T; t++) {
      while (di < due.length && due[di].at <= t) {
        const { sn } = due[di++];
        const e = ref.get(sn.tick);
        if (!e) continue;
        const start = ((e.ack >>> 0) + 1) & 0xffff;
        const dTick = net.lastSnapTick === undefined ? 0 : ((sn.tick - net.lastSnapTick) >>> 0);
        const dAck = net.lastStart === undefined ? 1 : ((start - net.lastStart) & 0xffff);
        const l0 = net.carryLead | 0, r0 = net.repsApplied | 0;
        const cN0 = net.carryN | 0, sN0 = net.steadyN | 0;
        const bL0 = net.baseLanded | 0, bF0 = net.baseFellBack | 0;
        const m0 = net.carryMiss | 0;
        // "客户端产拍到哪了"：k 是下一拍才产，所以此刻最新产出是 k−1。缺料归因要用 ——
        // 排班表量得出"基态那一拍还没被产出"，不依赖被测代码自己的账。
        const produced = k - 1;
        const landedBefore = net.lastLanding;
        // 两份快照之间服务端跑的步是 (prevSi, sn.si] —— **左开右闭**：
        // 快照 i 是跑完第 si 步（0 基）之后拍的，所以它那一拍算在**这一窗**里。
        // 第一版写成 [prevSi, sn.si)（左闭右开），整条链的窗都错了一格，于是
        // A0b 立刻红：排班表读到"消费 2 空跑 1"，而代码的记账是 dAck=3 deficit=0。
        const shape = prevSi === null ? null : windowShape(steps, prevSi + 1, sn.si + 1);
        const tr = { tick: sn.tick, ack: e.ack, start, dAck, lastStartBefore: net.lastStart, landedTickBefore: net.lastLandingTick, produced };
        if (!keepLanded) net.lastLanding = null;          // ★ 反证臂唯一注入点
        net.serverTick = sn.tick; net.lastRngState = 0;
        net.reconcile(e, sn.tick, 0);
        tr.miss = (net.carryMiss | 0) > m0;
        tr.missWhy = tr.miss ? (net.carryWhy || [])[(net.carryWhy || []).length - 1]?.why ?? null : null;
        // 步数反证探针：只探生产臂里真走了 carry 的纯饥饿窗（B 臂基态已被注入清掉，没有
        // "同一基态"可言）。基态要镜像 carryOf 的选择（landed 可用就用、否则日记本那一格）
        // —— 必须在 reconcile **之前**取：rollback 的重演循环会改写日记本，取晚了就不是
        // 被测代码当时用的那一份了。lead/repUse 在测试侧按与 client.mjs 相同的代数重算。
        let cf = null, repUse = null;
        if (keepLanded && dAck === 0) {
          const deficit = Math.max(0, dTick - dAck);
          const lead = Math.max(0, deficit - (e.rep | 0));
          repUse = Math.max(0, deficit - lead);
          const b = (start - dAck) & 0xffff;
          const useLanded = !!(landedBefore && net.lastLandingTick === b);
          const baseJ = useLanded ? landedBefore
            : net.history.find(h => h.tick === b && h.j)?.j ?? null;
          if ((net.carryN | 0) > cN0 && baseJ) {
            const holdInp = net.history.find(h => h.tick === (e.ack & 0xffff))?.inp ?? null;
            const prevInp = lead > 0 ? net.history.find(h => h.tick === ((b - 1) & 0xffff))?.inp ?? null : null;
            cf = await cfProbe(e, start, baseJ, holdInp, lead, prevInp);
          }
        }
        rows.push({
          tick: sn.tick, dTick, dAck, deficit: Math.max(0, dTick - dAck), rep: e.rep,
          corrected: net.corrected, carry: (net.carryN | 0) > cN0, steady: (net.steadyN | 0) > sN0,
          applySteps: ((net.carryLead | 0) - l0) + ((net.repsApplied | 0) - r0),
          baseLanded: (net.baseLanded | 0) > bL0, baseFellBack: (net.baseFellBack | 0) > bF0,
          cf, repUse, produced, miss: tr.miss, missWhy: tr.missWhy,
          shape,
        });
        tr.baseLanded = (net.baseLanded | 0) > bL0; tr.baseFellBack = (net.baseFellBack | 0) > bF0;
        traces.push(tr);
        prevSi = sn.si;
      }
      while (k < K && produceAt[k] === t) {
        net.history.push({ tick: k & 0xffff, inp: inputs[k], j: cl.journal(), debt: 0 });
        if (net.history.length > 240) net.history.shift();
        net.localTick = k;
        g.time += DT; cl.update(DT, inputs[k]);
        k++;
      }
    }
    return { rows, net, traces };
  };

  const stat = (rows) => {
    const steady = rows.filter(r => r.steady && r.carry && r.shape);
    const clean = steady.filter(r => r.shape.middleHolds === 0);
    const dirty = steady.filter(r => r.shape.middleHolds > 0);
    const starv = steady.filter(r => r.dAck === 0);
    const mx = (a) => Math.max(...a.map(r => r.corrected), 0);
    const avg = (a) => (a.length ? a.reduce((s, r) => s + r.corrected, 0) / a.length : 0);
    return { steady, clean, dirty, starv, mxClean: mx(clean), mxDirty: mx(dirty), avgClean: avg(clean), avgDirty: avg(dirty), mxStarv: mx(starv), avgStarv: avg(starv) };
  };

  // ── A：生产路径（基态取 landed） ──
  console.log('\n── A：基态 = 上一包重建出来的那一刻（生产路径）──');
  const A = await run(true);
  const sa = stat(A.rows);
  chk('先决 A0：这条链真的走到了 carry 那条路，且两种形状都有样本',
    sa.steady.length > 20 && sa.clean.length > 10 && sa.dirty.length > 10,
    `稳态 carry ${sa.steady.length} 包（干净窗 ${sa.clean.length} · 夹中间 ${sa.dirty.length}）`);
  // 量具自己：测试读出来的窗口形状必须和被测代码的记账对得上。对不上的话，
  // 下面"按形状分类"那两条判据就是在拿两把不同的尺子量同一件事。
  // rep 那一项的前提要先写出来：wire 上 rep 的"末尾连拍"定义只在这一窗**有过消费**时
  // 才落在本窗内（有消费 ⇒ rep 清零重计 = 本窗末尾的空跑数）。dAck=0 的纯饥饿窗里
  // rep 是**跨窗累计**的（ack 不动它一直涨，可以比这一窗的步数还大），比 repActual
  // 必然失配 —— 那一子集换比法：只比 consume/hold（整窗皆空跑），rep 的跨窗累计
  // 由 A7a 的前提（rep > dTick）钉住。第一版无前提地比三项，A7a 一加样本就红。
  chk('先决 A0b：从排班表读出的窗口形状 == 代码的记账（consume/hold 全体对齐；rep 在"本窗有过消费"的子集上对齐）',
    sa.steady.every(r => r.shape.consume === r.dAck && r.shape.hold === r.deficit
      && (r.dAck === 0 || r.shape.repActual === r.rep)),
    (() => { const b = sa.steady.find(r => !(r.shape.consume === r.dAck && r.shape.hold === r.deficit && (r.dAck === 0 || r.shape.repActual === r.rep))); return b ? `首例 ${JSON.stringify({ shape: b.shape, dAck: b.dAck, deficit: b.deficit, rep: b.rep })}` : `${sa.steady.length} 包全部一致`; })());
  {
    chk('A1：**空跑全在首段/末尾**的窗里，重建与权威逐位重合（< 1e-6 m）—— 代码的假设成立的那一半',
      sa.mxClean < 1e-6, `最大 ${sa.mxClean.toExponential(2)} m · ${sa.clean.length} 包 · 均值 ${sa.avgClean.toExponential(2)}`);
    chk('A2：每一包 carry 重演的步数恰好等于 Δtick（predict.mjs 声称的恒等式，此前没有任何地方比过）',
      sa.steady.every(r => r.applySteps === r.dTick),
      (() => { const b = sa.steady.find(r => r.applySteps !== r.dTick); return b ? `违例 首例 ${JSON.stringify(b)}` : `${sa.steady.length} 包全部 applySteps == dTick`; })());
    // 已知残差（c99f51f 立过账）：空跑夹在两次消费中间时，carry 只能把它排到前面，
    // 差别是"那一点上施加的相邻两拍输入"。判据线用日记本自己量出来的"一拍位移"，
    // 不是拍脑袋的米数；而且它必须**小于**一拍 —— 大于一拍就说明不是这个残差了。
    chk('A3：**空跑夹在中间**的窗里，残差 < 一拍位移（已知残差，量级不许涨成一整拍）',
      sa.mxDirty < STEP_M, `最大 ${sa.mxDirty.toFixed(4)} m < ${STEP_M.toFixed(4)} m（满速一拍）· ${sa.dirty.length} 包`);
    // 退回日记本那一格**允许发生，但每一笔都要归得因**：只有"上一包产不出合法基态"时才
    // 谈得上退回 —— 而"产不出"只有一个由来：hit === false（客户端还没产出 start 那一拍，
    // 也就是 caughtUp 那一类）。判据就写在这个由来上，而不是"允许 N 次"。
    // 为什么必须这样写：写"允许 ≤N 次"的话，接错线时（比如 landed 被某处清掉）
    // 退回会**变成常态**，而"次数"这类判据只会慢一拍地变红；钉在成因上则第一次就红。
    {
      const falls = A.traces.filter(t => t.baseFellBack);
      const bad = falls.filter((t, i) => !(t.lastStartBefore === undefined || t.landedTickBefore === null));
      chk('A4：每一笔"基态退回日记本"都归得因（上一包产不出合法基态 = 它 hit 为假）',
        bad.length === 0,
        `退回 ${falls.length} 笔 · 不可归因 ${bad.length}${bad.length ? ' 首例 ' + JSON.stringify(bad[0]) : ''} · carry 总包数 ${A.net.carryN | 0} · caughtUp ${A.net.caughtUp | 0} · journalMiss ${A.net.journalMisses | 0}`);
      // 更要紧的一条：**退回本身不是错误来源**。本链里这些窗的偏差也必须是 0 ——
      // 说明日记本那一格错只错在"被连续用"（B 那一臂），而不是错在被用了一次。
      // 这条把 A 与 B 的差别钉在"连续"两个字上，而不是含糊的"landed 比 journal 好"。
      const fRows = A.rows.filter((r, i) => A.traces[i] && A.traces[i].baseFellBack && r.steady && r.carry);
      const fMax = Math.max(...fRows.map(r => r.corrected), 0);
      chk('A5：退回日记本的那几窗本身也逐位重合（错不在"用了日记本"，而在"连续用它"）',
        fRows.length === 0 || fMax < 1e-6,
        `${fRows.length} 窗 · 最大 ${fMax.toExponential(2)} m`);
    }
    // 每一笔"该补而没补"都要**归得因**（与 A4 同一写法，不写"允许 N 次"）。本链上合法
    // 缺料只有一个成因：**客户端还没产出基态那一拍** —— 饥饿本身就是客户端没供货
    // （输入零延迟，队列空 = 还没产出来），快照又只晚 2 拍到，基态 start−dAck 或
    // start 自己就还在路上。这在排班表里量得到：快照处理那一刻，客户端最新产出拍号
    // produced < 基态拍号 b。why 不是 basePruned、或缺料时客户端其实已经产出（produced ≥ b）
    // 的，就是 carry 通路真缺料 —— 第一次就要红。步数违例同理：hit 为假的窗一拍都没有
    // 可演的（caughtUp 类，client.mjs 已把它从 carryStepsBad 的口径里摘出去），这里
    // 计数必须为 0。
    {
      const misses = A.traces.filter(tr => tr.miss);
      const unattr = misses.filter(tr => !(tr.missWhy === 'basePruned'
        && tr.produced < ((tr.start - tr.dAck) & 0xffff)));
      chk('A6：每一笔"该补而没补"都归得因（客户端还没产出基态那一拍 = 唯一合法成因），步数违例为 0',
        unattr.length === 0 && (A.net.carryStepsBad | 0) === 0,
        `缺料 ${misses.length} 笔 · 不可归因 ${unattr.length}${unattr.length ? ' 首例 ' + JSON.stringify(unattr[0]) : ''}` +
        ` · 步数违例 ${A.net.carryStepsBad | 0}${(A.net.carryStepsBad | 0) ? ' 现场 ' + JSON.stringify((A.net.carryStepsWhy || []).slice(0, 3)) : ''}`);
    }
  }

  // 纯饥饿窗（dAck = 0）：ack 不动 ⇒ rep 跨窗累计 ⇒ **这一窗**的空跑步数不是 rep 而是
  // dTick。真浏览器实测过的那条红就是它（dTick3 dAck0 reps5 ⇒ 多走 2 拍 ⇒ 0.1521 m）。
  // 判据两头都钉：步数必须是 dTick（不是 rep），重建必须逐位重合。
  // 前提先验：这一链里必须有这种窗（没有的话这条判据是空断言，"没样本"和"全绿"要分得开）。
  {
    chk('先决 A7a：这一链里有 dAck=0 的纯饥饿窗（否则下面这条是空断言）',
      sa.starv.length > 5, `${sa.starv.length} 窗（rep 最大 ${Math.max(...sa.starv.map(r => r.rep), 0)} · 都大于 dTick=${SNAP} 才说明"跨窗累计"真的发生了）`);
    const badSteps = sa.starv.filter(r => r.applySteps !== r.dTick);
    chk('A7：纯饥饿窗重演的步数 == dTick（**不是** wire 上的 rep）', badSteps.length === 0,
      `${sa.starv.length} 窗${badSteps.length ? ` · 违例 首例 ${JSON.stringify(badSteps[0])}` : ' 全部 applySteps == dTick'} · 最大重建偏差 ${sa.mxStarv.toExponential(2)} m`);
  }

  // ── B：反证臂（同一张排班表，只把 lastLanding 清掉 = 退回改动前那条路） ──
  console.log('\n── B：反证臂 —— 基态退回日记本那一格（改动前的样子）──');
  const B = await run(false);
  const sb = stat(B.rows);
  chk('B0：反证臂真的走到了"退回日记本"那条路（否则 B 只是 A 的复制品）',
    (B.net.baseFellBack | 0) > 10, `退回日记本 ${B.net.baseFellBack | 0} 包`);
  chk('B1：在 **A1 逐位重合的那些窗**里，退回日记本那一格 ⇒ 必须偏（否则 A1 是"反正都对"的恒绿）',
    sb.mxClean > 0.01, `最大 ${sb.mxClean.toFixed(4)} m · 均值 ${sb.avgClean.toFixed(4)} m · ${sb.clean.length} 包`);
  chk('B2：同一张排班表、同一段代码，只有基态来源不同 ⇒ 结论相反',
    sa.mxClean < 1e-6 && sb.mxClean > 0.01,
    `A 干净窗 ${sa.mxClean.toExponential(2)} m vs B 干净窗 ${sb.mxClean.toFixed(4)} m`);
  // 形状：日记本那一格"落在哪一拍上"是逐代推出来的，所以它的偏差是**会漂的**，
  // 而不是一个固定偏移。漂移要用"后半程 vs 前半程"量，不能只看 max（固定偏差的 max 也很大）。
  {
    const half = Math.floor(sb.clean.length / 2);
    const late = sb.clean.slice(half).reduce((s, r) => s + r.corrected, 0) / Math.max(1, sb.clean.length - half);
    const early = sb.clean.slice(0, half).reduce((s, r) => s + r.corrected, 0) / Math.max(1, half);
    const aLate = sa.clean.slice(half).reduce((s, r) => s + r.corrected, 0) / Math.max(1, sa.clean.length - half);
    const aEarly = sa.clean.slice(0, half).reduce((s, r) => s + r.corrected, 0) / Math.max(1, half);
    chk('B3：B 的偏差不是固定偏移而是随链变化（后半程 ≠ 前半程），而 A 两边都钉在 0',
      Math.abs(late - early) > 0.005 && aEarly < 1e-6 && aLate < 1e-6,
      `B 前半程 ${early.toFixed(4)} → 后半程 ${late.toFixed(4)} m · A 前半程 ${aEarly.toExponential(2)} → 后半程 ${aLate.toExponential(2)}`);
  }

  // 纯饥饿窗的反证臂 —— 反证的**对象要立准**。第一版写的是"退回日记本那一格 ⇒ 必须偏"，
  // 实测 6 窗全 0.0000：纯饥饿窗的红来自"按 wire 的 rep 多补拍"（改动前旧通路的行为），
  // 而 B 臂保留的 repUse 步数拆分与基态来源**无关** —— 就算退回日记本，步数也是对的，
  // 偏差自然为 0。所以这里换的变量是**步数**（探针见 run 里的 cfProbe）：同一基态、
  // 同一窗、同一权威读数，只把补演拍数从 repUse 换回 wire 的 rep，必须偏。
  // 偏的量级有**上界方程**：多走的每一拍都是按住 I_ack 的位移，≤ 满速一拍 —— 所以
  // corrected ≤ (rep − repUse) × 一拍位移，不是拍的脑袋，也不许放宽。
  {
    const probed = sa.starv.filter(r => r.cf !== null);
    chk('先决 B4a：每个稳态纯饥饿窗都被步数探针探过（一枚不缺，否则下面是抽样的恒绿）',
      probed.length === sa.starv.length && probed.length > 0,
      `探了 ${probed.length}/${sa.starv.length} 窗`);
    const maxCf = Math.max(...probed.map(r => r.cf), 0);
    const overMax = Math.max(...probed.map(r => r.rep - r.repUse), 0);
    chk('B4：同一基态、同一窗，补演拍数换回 wire 的 rep ⇒ 必须偏，且 ≤ 多走拍数 × 满速一拍',
      probed.every(r => r.cf <= (r.rep - r.repUse) * STEP_M + 1e-6) && maxCf > 0.01,
      `${probed.length} 窗 · 反证最大 ${maxCf.toFixed(4)} m（现行为同窗最大 ${sa.mxStarv.toExponential(2)}）` +
      ` · 多走拍数最多 ${overMax}（上界 ${(overMax * STEP_M).toFixed(4)} m）`);
  }

  // ── 武器错位兜底（2026-10-01）：权威武器字节持久错位 ⇒ 1 秒后硬纠正 ──
  // 触发条件在真实对局里是"切枪输入被上行队列溢出丢掉"（WebSocket 是 TCP，在途不丢，
  // 这是唯一丢法），链上涌现不出来，所以直接喂：本地从没切过枪，权威端却一直说 m1911
  // （weapon 字节 9）。修复前 srvWeapon 只被存进诊断读数没人消费，错位活满一整条命 ——
  // 症状是"手里明明切成了手枪，按住左键却吃步枪的连续伤害、枪口还按步枪的上扬"。
  {
    const mk = async () => {
      const g = new HeadlessGame(); await g.loadMap('yard');
      const pl = await mkPlayer(g, 'wd');
      const net = Object.create(NetClient.prototype);
      Object.assign(net, {
        game: g, history: [], localTick: 0, snaps: 0, serverTick: 0, lastSnapTick: undefined,
        lastStart: undefined, lastRep: 0, lastRngState: undefined, hardSnap: false, lastMyAlive: true,
        recIdx: 0, grace: 0, events: [], cid: 1, name: 'wd', team: 'A', remotes: new Map(), roster: new Map(),
        lastLanding: null, lastLandingTick: null, snapLog: [], worldFlags: 0, mySnapshot: null,
        hpMin: undefined, srvWeapon: undefined, remotePlayers: [],
      });
      return { g, pl, net };
    };
    // 喂 n **份快照**（每份 = SNAP 拍）：客户端原样站桩产拍，权威武器字节恒为 weaponByte。
    // 第一版按拍数喂，25 拍只产出 8 份快照 —— 够不到 20 份的阈值，W1 假红（量具的错）。
    const feedN = async ({ g, pl, net }, n, weaponByte) => {
      for (let s = 0; s < n; s++) {
        for (let k = 0; k < SNAP; k++) {
          const inp = ZERO;
          g.step(DT, inp, [{ pl, inp }]);
          net.history.push({ tick: net.localTick & 0xffff, inp, j: pl.journal(), debt: 0 });
          net.localTick++;
        }
        const e = entityOf(pl, net.localTick - 1, 0);
        e.weapon = weaponByte;
        net.serverTick = net.localTick;
        net.reconcile(e, net.localTick, 0);
      }
    };
    const w1 = await mk();
    await feedN(w1, 25, 9);                    // WEAPON_IDS[9] = 'm1911'：20 份（1 秒）后必须纠正
    chk('W1 持久错位（权威说是 m1911 而本地从没切过）⇒ 20 份快照后硬切到权威那把并记账',
      w1.pl.ws.w.id === 'm1911' && (w1.net.wpnFixed | 0) === 1 && (w1.net.wpnMiss | 0) === 0,
      `本地 ${w1.pl.ws.w.id} · wpnFixed=${w1.net.wpnFixed}`);
    const w2 = await mk();
    await feedN(w2, 12, 9);                    // 0.6 秒的错位 = 换枪输入在途的正常窗口
    await feedN(w2, 12, 0);                    // 权威端又翻回 m4（输入被消费了）
    chk('W2 反证臂：瞬时差（≤1 秒）不许触发纠正 —— 正常换枪的在途窗口不是故障',
      w2.pl.ws.w.id === 'm4' && (w2.net.wpnFixed | 0) === 0 && (w2.net.wpnMiss | 0) === 0,
      `本地 ${w2.pl.ws.w.id} · wpnFixed=${w2.net.wpnFixed}`);
  }

  console.log(`\n${fails ? 'RED' : 'GREEN'}  ${checks - fails}/${checks} 通过`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.log('CRASH', e && (e.stack || e.message)); process.exit(2); });
