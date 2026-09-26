// 日记本覆盖率守卫。js/player.js 的 J_PL 注释里一直写着"新增字段要么登记进来，要么进
// J_EXCLUDE 并写清理由"，但那份 test/net-journal.mjs 从来没存在过 —— 也就是说这条防线
// 一直是靠人自觉，漏登记不会变红，只会在线上表现成"回滚之后某个状态没复原"。
// 这次给 Player 加了私有随机流（rng / rngSeed / rngTag / rng0 + j.rngState），正好是
// 会被漏掉的那类字段，所以把这条守卫真的写出来。
//
// 判据只问一件事：**实例上每一个 own 可枚举字段都必须有归属** ——
//   进 J_PL / J_WS（逐拍存取）｜进 journal() 手写的几个（pos/vel/ammo/cur/grenade/time/rngState）｜
//   进 J_EXCLUDE 且写了理由。三者都不沾 ⇒ 红，并点名是哪几个。
// 外加一条判别臂：临时挂一个没登记的字段上去，守卫必须只报出它 —— 否则这条守卫
// 可能只是因为"遍历到一个空集合"而永远绿。
import { HeadlessGame, preloadMaterials } from '../server/headless-game.mjs';
import { Player, J_PL, J_WS, J_EXCLUDE } from '../js/player.js';
import * as THREE from 'three';

let fails = 0, checks = 0;
function chk(ok, name, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`FAIL  ${name}${detail ? '  | ' + detail : ''}`); }
  else console.log(`ok    ${name}${detail ? '  | ' + detail : ''}`);
}

// journal() 里手写的那几个，不靠 J_* 列表覆盖
const HAND = new Set(['time', 'cur', 'grenade', 'pos', 'vel', 'ammo', 'lethal', 'tactical', 'rngState']);

function uncovered(obj, list, tag) {
  const have = new Set(list);
  return Object.keys(obj).filter(k => !have.has(k) && !(k in J_EXCLUDE) && !(HAND.has(k) && tag === 'pl'))
    // WeaponState 的 journal() 手写项只有 cur/ammo/grenade，其余字段一律要走 J_WS
    .filter(k => !(tag === 'ws' && (k === 'cur' || k === 'ammo')));
}

async function main() {
  await preloadMaterials();
  const g = new HeadlessGame();
  await g.loadMap('yard');
  const pl = new Player(g, { team: 'A', pos: new THREE.Vector3(0, 0, 0), yaw: 0.7, name: '甲', rngSeed: 11, rngTag: 1 });
  pl.equip({ primary: { id: 'm4', att: {} }, secondary: { id: 'm1911', att: {} }, lethal: 'frag', tactical: 'flash', perks: [] });
  g.player = pl; g.entities.push(pl);

  // 先决：这套判据要真的看得见东西 —— 字段数太少说明遍历读的是空对象
  const nPl = Object.keys(pl).length, nWs = Object.keys(pl.ws).length;
  chk(nPl > 20 && nWs > 10, '先决：own 字段遍历真的读到了状态（不是空集合）', `Player ${nPl} 个 · WeaponState ${nWs} 个`);

  const missPl = uncovered(pl, J_PL, 'pl'), missWs = uncovered(pl.ws, J_WS, 'ws');
  chk(missPl.length === 0, 'Player 每个 own 字段都有归属（进 J_PL / journal 手写 / J_EXCLUDE）',
    missPl.length ? `漏登记：${missPl.join(', ')}` : `${nPl} 个字段，J_PL ${J_PL.length} 项 + 手写 ${HAND.size} 项 + J_EXCLUDE 兜其余`);
  chk(missWs.length === 0, 'WeaponState 每个 own 字段都有归属（进 J_WS / J_EXCLUDE）',
    missWs.length ? `漏登记：${missWs.join(', ')}` : `${nWs} 个字段，J_WS ${J_WS.length} 项`);

  // 这次新加的私有流必须"有归属且真的被存取"：登记成排除不够，游标要进日记本
  const j = pl.journal();
  chk('rngState' in j, '日记本里带着私有流的游标（j.rngState）', `值 ${j.rngState}`);
  const before = pl.rng.state();
  pl.rng.setState(12345); pl.applyJournal(j);
  chk(pl.rng.state() === j.rngState && j.rngState === before, 'applyJournal 把流拨回日记本那一拍',
    `${before} → 打乱成 12345 → 复原 ${pl.rng.state()}`);

  // 判别臂：守卫必须能变红。挂一个没登记的字段，它要点名报出来。
  const probe = new Player(g, { team: 'B', pos: new THREE.Vector3(2, 0, 2), yaw: 0, name: '乙', rngSeed: 11, rngTag: 2 });
  probe.__忘了登记 = 1;
  const caught = uncovered(probe, J_PL, 'pl');
  chk(caught.length === 1 && caught[0] === '__忘了登记', '判别臂：漏登记的字段会被点名（这条守卫能红）',
    JSON.stringify(caught));

  console.log(`\n${fails ? 'RED' : 'GREEN'}  ${checks - fails}/${checks} 通过`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.log('CRASH', e && (e.stack || e.message)); process.exit(2); });
