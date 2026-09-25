// 量一件事：同一份输入脚本，在不同帧率下推进，轨迹差多少。
//
// 现在 main.js:345 是 dt = min(0.05, clock.getDelta())，直接把真实帧时长喂给全部
// 积分；player.js/weapons.js 里到处是 damp(...,k,dt) 与 vel.y -= 18*dt。
// 也就是说 30fps 与 144fps 的玩家"物理上不是同一个人"。
// 联网后这必须消失：服务端只按固定步长跑，客户端预测必须走同一条离散化。
//
// 先量幅度再决定怎么改。node server/fps-independence.mjs
import './browser-shim.mjs';
import { HeadlessGame, preloadMaterials } from './headless-game.mjs';
import { seedGameplayRng, rng } from './prng.mjs';
import { sample, fnv1a32 } from './sim-twin.mjs';

const SIM_SECONDS = 6;             // 固定这段"游戏内时长"
const MAP = 'yard';

// 只用"按住/松开"型输入，不用逐 tick 取模 —— 后者会把帧率写进输入流本身
// （第一版就犯了这个错：Math.floor(t*60)%4 在 15Hz 下每个 tick 都为真，
//  于是"弹匣剩 20 vs 16"是量具假象，不是模拟差异）。
// edges=true 时加入蹲伏与跳跃两个边沿事件，用来把"边沿的离散化"单独隔离出来。
function inputAt(t, DT, edges) {
  const s = {
    fwd: 0, back: 0, left: 0, right: 0, sprint: false, jumpPressed: false, crouchPressed: false,
    fire: false, ads: false, reloadPressed: false, swapPressed: false, slot1: false, slot2: false,
    meleePressed: false, lethalPressed: false, lethal: false, tacticalPressed: false, tactical: false,
    interact: false, interactPressed: false, nvgPressed: false, streak: -1,
    firePressed: false, adsPressed: false, mdx: 0, mdy: 0,
  };
  if (t >= 0.2 && t < 4.5) s.fwd = 1;
  if (t >= 0.6 && t < 1.4) s.sprint = true;
  if (t >= 1.6 && t < 3.4) { s.ads = true; s.fire = true; }
  if (t >= 4.6) s.back = 1;
  if (t >= 5.0) s.right = 1;
  if (edges) {
    if (t >= 1.0 && t < 1.0 + DT) s.crouchPressed = true;
    if (t >= 3.6 && t < 3.6 + DT) s.jumpPressed = true;
    if (t >= 4.0 && t < 4.0 + DT) s.crouchPressed = true;
  }
  return s;
}

const DT60 = 1 / 60;   // 目标设计的固定步长

async function runAt(hz, seed, edges, mode) {
  const DT = 1 / hz;
  const frames = Math.round(SIM_SECONDS / DT);
  seedGameplayRng(seed);
  await preloadMaterials();
  const game = new HeadlessGame();
  await game.loadMap(MAP);
  const THREE = await import('three');
  const { Player } = await import('../js/player.js');
  const gy = game.world.groundHeight(0, 0, 50, 0.35);
  const pl = new Player(game, { pos: new THREE.Vector3(0, 0, 0), yaw: 0 });
  pl.pos.set(0, (Number.isFinite(gy) ? gy : 0) + 0.02, 0);
  pl.eyeSmooth = pl.pos.y + 1.62;
  pl.equip({
    primary: { id: 'ak', att: { optic: 'holo', under: 'vgrip', muzzle: 'brake' } },
    secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: ['doubletime'],
  });
  game.player = pl;

  let simT = 0;                     // 已经模拟到的游戏内时刻
  let steps = 0;
  for (let f = 0; f < frames; f++) {
    const wallT = (f + 1) * DT;     // 这一帧结束时的真实时刻
    if (mode === 'variable') {
      game.step(DT, inputAt((f + 1) * DT, DT, edges)); steps++; simT = wallT;
    } else {
      // 固定步长累加器：渲染率只决定"什么时候有机会多跑几步"，不决定物理步长
      while (simT + DT60 <= wallT + 1e-9) {
        simT += DT60; steps++;
        game.step(DT60, inputAt(simT, DT60, edges));
      }
    }
  }
  return { hz, mode, frames, steps, draws: rng.draws, pos: pl.pos.clone(), yaw: pl.yaw, hp: pl.hp, mag: pl.ws.w.mag, state: pl.ws.state, shot: sample(pl) };
}

function table(title, rows) {
  const ref = rows.find(r => r.hz === 60);
  console.log('\n' + title);
  console.log('  基准 60Hz 落点 ' + ref.pos.x.toFixed(3) + ', ' + ref.pos.z.toFixed(3) + '   弹匣 ' + ref.mag + '   抽数 ' + ref.draws);
  console.log('   fps   渲染帧  实际步数   落点偏差(m)     Δ(x,z)          弹匣  抽数');
  let worst = 0;
  for (const r of rows) {
    const d = r.pos.distanceTo(ref.pos); worst = Math.max(worst, d);
    console.log('  ' + String(r.hz).padStart(5) + String(r.frames).padStart(9) + String(r.steps).padStart(10)
      + d.toFixed(4).padStart(13)
      + ('  ' + (r.pos.x - ref.pos.x).toFixed(3) + ', ' + (r.pos.z - ref.pos.z).toFixed(3)).padEnd(18)
      + String(r.mag).padStart(5) + String(r.draws).padStart(7));
  }
  return worst;
}

await (async () => {
  const SEED = 4242;
  const HZ = [15, 30, 60, 75, 100, 120, 144, 240];
  // 必须串行：8 条轨迹共享同一个全局玩法随机流，并发会在 await 处交错重播种
  // （上一版用 Promise.all，同一固定步长下 360 步竟抽出 48/144/336 次 —— 自证其伪）
  const run = async (mode, edges) => {
    const rows = [];
    for (const hz of HZ) rows.push(await runAt(hz, SEED, edges, mode));
    return rows;
  };

  const w1 = table('【现状】变步长 dt=真实帧时长，输入只含"按住"（隔离出纯模拟离散化）', await run('variable', false));
  const w2 = table('【现状】同上，但加入蹲伏/跳跃两个边沿输入', await run('variable', true));
  const w3 = table('【固定 60Hz 步长 + 累加器】输入只含"按住"', await run('fixed', false));
  const w4 = table('【固定 60Hz 步长 + 累加器】含边沿输入', await run('fixed', true));

  console.log('\n' + '─'.repeat(70));
  console.log('  最大落点偏差汇总（米）      变步长        固定步长');
  console.log('    仅按住输入            ' + w1.toFixed(4).padStart(9) + '   ' + w3.toFixed(4).padStart(9));
  console.log('    含边沿输入            ' + w2.toFixed(4).padStart(9) + '   ' + w4.toFixed(4).padStart(9));
  console.log('  参照：玩家碰撞半径 0.35m；门口约 1m 宽；一整个身位约 0.6m。');
  console.log('  ' + '─'.repeat(66));
})();
