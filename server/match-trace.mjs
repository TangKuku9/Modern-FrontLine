// 整场对局级的轨迹 —— 这才是专用服务器真正要跑的东西：
// 一个 Player + 一堆 Bot + MPMatch 的比分/重生/掉落/连杀，全部在同一进程里推进。
//
// 它同时充当"服务端要提供哪些 game 成员"的实测清单：任何一处缺失都会在这里
// 以 TypeError 的形式暴露，而不是等到线上第 3 小时才炸。
import { HeadlessGame, preloadMaterials } from './headless-game.mjs';
import { seedGameplayRng, resetGameplayRng, rng } from './prng.mjs';
import { DT, fnv1a32 } from './sim-twin.mjs';

const F = (v, p = 4) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(p) : 'NaN') : String(v));

// 摘要必须覆盖"会分叉的"字段。注意 Bot 与 Player 的状态不同形：
//   Player 的账本在 pl.stats.*，武器状态在 pl.ws.*
//   Bot 的账本在 b.kills/b.score/b.streak，b.stats 反而是"武器属性表"
//   （见 mp.js:149 与 ai.js:39），弹道相关计时在 b.mag/fireT/burstLeft/reloadT
function entityLine(e) {
  const isPl = !!e.isPlayer && !!e.ws;
  const ledger = isPl
    ? `${e.stats.kills}/${e.stats.deaths}/${e.stats.score}/${e.stats.streak}`
    : `${e.kills ?? 0}/${e.deaths ?? 0}/${e.score ?? 0}/${e.streak ?? 0}`;
  const wep = isPl
    ? `${e.ws.state}|${e.ws.w ? e.ws.w.mag : -1}|${F(e.ws.adsT)}|${F(e.ws.rp)}|${e.ws.shotsInRow}`
    : `${F(e.fireT, 3)}|${e.mag ?? -1}|${F(e.reloadT, 3)}|${e.burstLeft ?? -1}|${e.grenades ?? -1}`;
  const mind = isPl ? '' : [
    e.target ? 'T' : '-', e.targetVisible ? 'V' : '-', e.alerted ? 'A' : '-',
    F(e.susp ?? 0), e.stunT ? 'S' : '-',
    e.path ? 'P' + e.path.length : 'P0',
    e.goal ? `${F(e.goal.x, 1)},${F(e.goal.z, 1)}` : 'g-',
    e.lastSeenPos ? `${F(e.lastSeenPos.x, 1)},${F(e.lastSeenPos.z, 1)}` : 'ls-',
    F(e.yaw), e.crouching ?? e.wantCrouch ? 'C' : '-', String(e.role ?? '-'),
  ].join('|');
  return [
    e.name, e.team, F(e.pos.x), F(e.pos.y), F(e.pos.z),
    F(e.vel.x), F(e.vel.y), F(e.vel.z), F(e.pitch),
    e.alive ? 1 : 0, F(e.hp, 2), ledger, wep, mind,
  ].join('|');
}

export function worldDigest(game) {
  const lines = [];
  for (const e of [...game.entities].sort((a, b) => String(a.name).localeCompare(String(b.name)))) lines.push(entityLine(e));
  const m = game.mode;
  lines.push(`#scores ${JSON.stringify(m?.scores ?? null)} streakKills ${F(m?.streakKills ?? 0, 2)} respawnQ ${(m?.respawns || []).length}`);
  lines.push(`#time ${F(m?.timeLeft ?? -1, 2)} flags ${(m?.flags || []).map(f => f.name + ':' + (f.owner ?? '-') + ':' + F(f.prog, 3)).join(',')}`);
  lines.push(`#pickups ${game.pickups.map(p => p.weaponId).join(',')} proj ${game.projectiles.length} noises ${game.noises.length} t=${F(game.time, 3)}`);
  // 把玩法随机流的消耗量也放进摘要：一旦两边走了不同分支，这里会先于状态分歧暴露出来。
  // 拆成"公共/人物"两份是 2026-09-25 加的：人物弹道改走私有流之后，光看总数分不清
  // "某个人的开火次数不一致"和"公共流被只在一侧存在的代码抽走"（后者是特效偷玩法流那类），
  // 而这两件事的修法完全相反。
  const entDraws = game.entities.reduce((s, e) => s + (e.rng ? e.rng.draws : 0), 0);
  lines.push(`#draws ${rng.draws} 公共 ${rng.draws - entDraws} 人物 ${entDraws}`);
  // 世界几何签名：命中判定拿的是 world.raycast，服务端（headless）和浏览器（真渲染，会做
  // LOD）如果碰到的碰撞体集合不一样，"这一发打中墙还是打人"就会分环境 —— 那种分叉不报错，
  // 只表现为"某一拍之后两端人物状态开始漂"。所以把碰撞体数量和位置校验和放进摘要。
  const bx = game.world.boxes || [];
  let hash = 0;
  for (const b of bx) hash = (Math.imul(hash + (Math.round(b.x0 * 64) | 0), 0x01000193) + (Math.round(b.z1 * 64) | 0) + (Math.round(b.y1 * 64) | 0)) | 0;
  lines.push(`#world ${bx.length}/${hash >>> 0}`);
  return lines.join('\n');
}

function inputAt(i) {
  const s = {
    fwd: 0, back: 0, left: 0, right: 0, sprint: false, jumpPressed: false, crouchPressed: false,
    fire: false, ads: false, reloadPressed: false, swapPressed: false, slot1: false, slot2: false,
    meleePressed: false, lethalPressed: false, lethal: false, tacticalPressed: false, tactical: false,
    interact: false, interactPressed: false, nvgPressed: false, streak: -1,
    firePressed: false, adsPressed: false, mdx: 0, mdy: 0,
  };
  if (i % 90 < 45) s.fwd = 1; else s.right = 1;
  if (i % 120 === 0) s.crouchPressed = true;
  if (i > 60) { s.ads = true; if (i % 3 === 0) s.fire = true; }
  if (i % 200 === 150) s.reloadPressed = true;
  if (i % 300 === 250) s.mdx = 200;
  return s;
}

export async function runMatchTrace(opts = {}) {
  const { seed = 777, mapId = 'yard', ticks = 900, mode = 'tdm', allies = 4, enemies = 4, perturb = null } = opts;
  seedGameplayRng(seed);
  const pre = await preloadMaterials();
  const game = new HeadlessGame();
  game.mode = null;
  await game.loadMap(mapId);
  const { MPMatch } = await import('../js/mp.js');
  game.playerSleeve = 'fab_ally';
  const cfg = { mode, map: mapId, diff: 1, allies, enemies, scoreLimit: 50, timeLimit: 10 };
  game.mode = new MPMatch(game, cfg);
  game.mode.start();
  game.state = 'play';

  const samples = [], drawsPerTick = [];
  const t0 = Date.now();
  for (let i = 0; i < ticks; i++) {
    if (perturb) perturb(i);
    const before = rng.draws;
    game.step(DT, inputAt(i));
    drawsPerTick.push(rng.draws - before);
    if (i % 10 === 0 || i === ticks - 1) samples.push(i + ':' + worldDigest(game));
  }
  const ms = Date.now() - t0;
  const gameplayDraws = rng.draws;
  resetGameplayRng();

  const joined = samples.join('\n');
  return {
    meta: { seed, mapId, mode, ticks, entities: game.entities.length, msPerTick: +(ms / ticks).toFixed(4), materialMs: pre.ms, gameplayDraws },
    samples, drawsPerTick,
    digest: fnv1a32(joined),
    final: { scores: game.mode.scores, timeLeft: +game.mode.timeLeft.toFixed(1), pickups: game.pickups.length, aliveBots: game.bots.filter(b => b.alive).length },
    last: samples[samples.length - 1],
  };
}
