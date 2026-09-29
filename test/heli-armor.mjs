// 武装直升机的判据：命中体（打不打得着 / 打在哪儿）+ 装甲表（子弹轻微 / RPG 大量 / 要害一发即毁）。
//
//   node test/heli-armor.mjs
//
// 为什么单独立一份判据：它超模的根源是"场上唯一一个没有体积的东西" —— 42 秒里它
// 100% 输出、0% 挨打。而缺这三件事的东西恰恰是最安静的那类 bug：不崩、不报错，
// 屏幕上只是"打上去没反应"。所以这一份量的是两件事能不能同时成立：**打得到**（hitTest）
// 与**打多少**（takeDamage）。
//
// 三条纪律，照本仓库的老规矩：
//   ① 每条判据配反证臂，反证是"读数必须变"，不是注释里承诺会红。
//   ② 量具先自证活着：A 段先证明"这条射线确实打在那串球上"（入射点与几何自洽），
//      否则后面每条"打要害"都可能在一张空表上绕圈子。
//   ③ 区间的两边都要写：大残那一条同时排除"一发即毁"与"只掉一层皮"，
//      只写一半的话把伤害调成 0 也能绿。
import '../server/browser-shim.mjs';
import * as THREE from 'three';
import { makeStubs } from '../server/stubs.mjs';
import { Heli, HELI_ARMOR, HELI_HITBOXES } from '../js/mp.js';
import { fireHitscan, explode, Projectile } from '../js/combat.js';
import { NetRoom, HELI_HP_EVERY } from '../server/room.mjs';
import { WEAPONS } from '../js/data.js';

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label + (extra ? '  ' + extra : '')]); return !!cond; };
const sec = (t) => { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)); };

// ───────────────────────── 环境桩 ─────────────────────────
// Heli 只用到 game 的这几处形状：scene（挂模型）、audio（旋翼循环音）、entities（会被谁遍历）、
// world.half（航线半径）。开花那一层走 effects / hud，用服务端那套记录型替身接住 ——
// 于是"冒火星还是冒血"这种事也能被量到（log 里留着调用名）。
function stubGame() {
  const st = makeStubs();
  return {
    stubs: st, entities: [], scene: { add() { }, remove() { } }, time: 0,
    effects: st.effects, audio: st.audio, hud: st.hud, menu: st.menu,
    player: { team: 'A', alive: true, pos: new THREE.Vector3(), shake() { } },
    world: { half: 60, raycast: () => null, lineBlocked: () => false, groundHeight: () => 0, randomWalkable: () => new THREE.Vector3() },
    projectiles: [], makeNoise() { },
  };
}
// 直升机摆在世界原点正上方 20 m、机头朝 -Z（yaw = 0）—— 下面所有射线都按这个姿势算。
// 20 m 挨着它 24 m 的巡航高度，这个高度上没有屋顶，射线不会被建筑抢走。
function spawn(game, team = 'A', opts = {}) {
  const h = new Heli(game, team, { team, isPlayer: false, name: 'owner' }, opts);
  h.pos.set(0, 20, 0); h.yaw = 0; h.enter = 0;
  return h;
}
const P = (x, y, z) => new THREE.Vector3(x, y, z);
const D = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const M4 = WEAPONS.m4;
const m4 = { dmgNear: M4.dmg[0], dmgFar: M4.dmg[1], rangeNear: M4.range[0], rangeFar: M4.range[1], headMul: M4.headMul, name: M4.name };
const FOE = { team: 'B', isPlayer: true, name: '敌', alive: true, pos: P(0, 1.6, 0) };

// ═══════════════════════════════════════════════════════════════════════════
sec('A. 量具自证：这条射线真的打在那串球上');
// ═══════════════════════════════════════════════════════════════════════════
{
  const g = stubGame();
  const h = spawn(g);
  ok('A1 权威那一个（非 dumb）进了实体表：实体表就是"谁会被子弹遍历到"的名单', g.entities.includes(h) && h.alive);
  ok('A2 满血起手，maxHp 来自装甲表', h.hp === HELI_ARMOR.hp && h.maxHp === HELI_ARMOR.hp, `hp=${h.hp}/${h.maxHp}`);
  // 从正下方垂直往上打机身：前机身那颗球（r = 1.3，中心 (0,20,-0.8)）离射线轴的横向距离是
  // 0.8 ⇒ 入射点在 y = 20 - √(1.3² - 0.8²) ≈ 18.975，t = 8.975。
  const up = h.hitTest(P(0, 10, 0), D(0, 1, 0), 400);
  const wantA3 = 20 - Math.sqrt(1.3 * 1.3 - 0.8 * 0.8) - 10;
  ok('A3 自下而上打机身要中，且入射点与几何自洽（t = 20 - √(r²-0.8²) - 10）',
    !!up && Math.abs(up.t - wantA3) < 0.02 && up.part === 'body', up ? `t=${up.t.toFixed(3)} part=${up.part}` : 'null');
  // 反证臂：这条红了 = 命中体空了 / 射线压根没判 —— 后面每一条都失去意义。
  const away = h.hitTest(P(0, 10, 0), D(0, -1, 0), 400);
  ok('A4【反证】背向那条射线打不到（不是"随便一发都中"）', away === null, String(away));
  const miss = h.hitTest(P(0, 34, -20), D(0, 0, 1), 400);
  ok('A5【反证】从头顶 14 m 高处平着飞过去的那一条不中（体积不是无限大）', miss === null, String(miss));
  ok('A6 命中体是八颗球，其中两颗是要害', HELI_HITBOXES.length === 8 && HELI_HITBOXES.filter(v => v.part === 'vital').length === 2);
}

// ═══════════════════════════════════════════════════════════════════════════
sec('B. 打得着的地方要分得出部位：要害 / 机身 / 尾部');
// ═══════════════════════════════════════════════════════════════════════════
{
  const g = stubGame();
  const h = spawn(g);
  const nose = h.hitTest(P(0, 20, -20), D(0, 0, 1), 400);            // 机头方向（-Z）来的那一枪
  ok('B1 正面来的那一枪打在座舱上（vital）', !!nose && nose.part === 'vital', nose ? nose.part : 'null');
  const mast = h.hitTest(P(0, 30, 0), D(0, -1, 0), 400);             // 正上方直插
  ok('B2 正上方直插打在旋翼主轴上（vital）', !!mast && mast.part === 'vital', mast ? mast.part : 'null');
  const side = h.hitTest(P(20, 20.1, 1.6), D(-1, 0, 0), 400);        // 侧后方平打机身
  ok('B3 侧面平打机身 = body', !!side && side.part === 'body', side ? side.part : 'null');
  // 尾梁：模型上有那一根 5.5 m 的梁，命中体里就必须有它
  const tail = h.hitTest(P(20, 20.45, 4.6), D(-1, 0, 0), 400);
  ok('B4 打尾梁要中（少那一颗球的症状是"机尾那一截打上去没反应"）', !!tail && tail.part === 'body', tail ? tail.part : 'null');
  // 命中体是否跟着机头转
  const h2 = spawn(g); h2.yaw = Math.PI / 2;                          // 机头转到 -X
  const turned = h2.hitTest(P(-20, 20, 0), D(1, 0, 0), 400);
  const before = h.hitTest(P(-20, 20, 0), D(1, 0, 0), 400);
  ok('B5 机头转过去之后，座舱跟着转到迎着射线的那一侧', !!turned && turned.part === 'vital', turned ? turned.part : 'null');
  // 反证臂：这两条一起看 —— 命中体要是没跟着 yaw 转，两条会同时给出 body，此处即红。
  ok('B6【反证】同一条射线在 yaw=0 时是机身、在 yaw=π/2 时变成要害（不是"永远同一处"）',
    !!before && before.part === 'body' && !!turned && turned.part === 'vital',
    `yaw0=${before && before.part} yaw90=${turned && turned.part}`);
  // 上面两条量的是"旋转算得对"，这一条量的是"每拍真的有人把它写进去"。
  // 这两件事必须分开量：写 yaw 的那一行一旦不再被调用（比如重构时把它挪到了某个分支里），
  // 旋计算式一条都不错，而命中体会永远停在起飞那一刻的朝向上 —— 画面上架着一架
  // "朝着东飞、却能被从北边一枪打穿座舱"的直升机。这是本仓库反复抓到的那一类 bug
  // （"写那个字段的那行代码在出问题的那一刻之后就再也不跑了"）。
  const g4 = stubGame();
  g4.camera = { position: new THREE.Vector3() };
  const h4 = spawn(g4);
  h4.update(1 / 60);
  ok('B7 飞起来之后朝向真的落到了 yaw 上（无目标时 = 航线切线）',
    Math.abs(h4.yaw - (h4.ang + Math.PI)) < 1e-9, `yaw=${h4.yaw.toFixed(4)} ang+π=${(h4.ang + Math.PI).toFixed(4)}`);
  // 顺着机头正前方往回打 —— 命中体跟着转的话，这一枪必定落在座舱上。
  // 站位按**画面上那个模型**（mesh.rotation.y）算，不按命中体那份 yaw 算：这两个朝向是
  // 两行代码各自写的，判据必须把它们对着量 —— 都用同一份 yaw 的话，两边错得一模一样，
  // 判据反而成立（本仓库第六类判据形状：边界不许由嫌疑对象自己构成）。
  const seen = h4.mesh.rotation.y;
  const heading = new THREE.Vector3(-Math.sin(seen), 0, -Math.cos(seen));       // 机头此刻朝向
  const from = h4.pos.clone().addScaledVector(heading, 20);                     // 站到机头正前方
  const got = h4.hitTest(from, heading.clone().negate(), 400);                  // 迎面打回去
  ok('B8【反证】站在"画面上它朝着的那一边"迎面打回去，中的是座舱（命中体跟得上模型）',
    !!got && got.part === 'vital', got ? got.part : 'null');
}

// ═══════════════════════════════════════════════════════════════════════════
sec('C. 子弹：有手感地磨，不是一梭子放倒');
// ═══════════════════════════════════════════════════════════════════════════
{
  const g = stubGame();
  const h = spawn(g);
  const before = h.hp;
  const r = fireHitscan(g, FOE, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  const drop = before - h.hp;
  const want = M4.dmg[0] * HELI_ARMOR.bullet;
  ok('C1 一发 28 伤害的步枪弹只掉 9.8 点（不是 28）', Math.abs(drop - want) < 0.01 && drop < M4.dmg[0] * 0.5,
    `drop=${drop.toFixed(2)} 期望=${want.toFixed(2)}`);
  // 反证臂：删掉 bullet 那一档就是直接吃满 28，上面这条立即红。
  ok('C2【反证】伤害系数真的被用上了：与完整伤害相差一大截', Math.abs(drop - M4.dmg[0]) > 10,
    `|${drop.toFixed(2)} - ${M4.dmg[0]}| = ${Math.abs(drop - M4.dmg[0]).toFixed(2)}`);
  ok('C3 打中的是金属：记录里有 effects.impact，没有 effects.blood',
    r.ent === h && g.stubs.log.some(x => x.k === 'effects.impact') && !g.stubs.log.some(x => x.k === 'effects.blood'));

  const g2 = stubGame();
  const h2 = spawn(g2);
  const before2 = h2.hp;
  fireHitscan(g2, FOE, P(0, 30, 0), D(0, -1, 0), m4, M4.name);       // 打旋翼主轴：要害
  const drop2 = before2 - h2.hp;
  const want2 = M4.dmg[0] * HELI_ARMOR.bullet * HELI_ARMOR.vital;
  ok('C4 打要害比打机身疼（同一把枪分成两档）', Math.abs(drop2 - want2) < 0.01 && drop2 > drop,
    `vital=${drop2.toFixed(2)} body=${drop.toFixed(2)}`);

  // 一个弹匣 30 发全中机身：得还剩一大半 —— 这才是"轻微伤害"读得出来的形状
  const g3 = stubGame();
  const h3 = spawn(g3);
  for (let i = 0; i < 30; i++) fireHitscan(g3, FOE, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  const frac = h3.hp / h3.maxHp;
  ok('C5 一个弹匣（30 发）全中机身还剩四到六成：它不是一梭子能放倒的东西',
    h3.alive && frac > 0.4 && frac < 0.6, `剩余 ${(frac * 100).toFixed(1)}%`);
  // 反证臂：删掉 bullet 那一档，打死它所需的机身命中数会从 62 掉回 22 —— C5 那个"还剩一半"
  // 的形状就不存在了（同一个量具看得见的差别，不必再 compares or old code）。
  const shotsNoArmor = Math.ceil(h3.maxHp / M4.dmg[0]);                        // 22：一匣多一点
  const shotsWithArmor = Math.ceil(h3.maxHp / (M4.dmg[0] * HELI_ARMOR.bullet)); // 62：两个多弹匣
  ok('C6【反证】这张表把"打死它所需的机身命中数"从 22 发推到 62 发',
    shotsNoArmor === 22 && shotsWithArmor === 62 && h3.alive, `无系数=${shotsNoArmor} 有系数=${shotsWithArmor}`);
}

// ═══════════════════════════════════════════════════════════════════════════
sec('D. RPG：直击要害一发即毁，直击非要害大残');
// ═══════════════════════════════════════════════════════════════════════════
{
  const g = stubGame();
  const h = spawn(g);
  const killed = h.takeDamage(170, { attacker: FOE, weapon: 'RPG-7', explosive: true, direct: true, part: 'vital', point: P(0, 20, 0) });
  ok('D1 满血被打中要害：一发即毁', killed === true && h.alive === false && h.hp === 0);
  ok('D2 它是"被击落"而不是"到点离场"（downed）—— 联机那句播报靠这一位区分',
    h.downed === true && h.killer === FOE);
  ok('D3 死了就从实体表里摘掉（实体表是每发子弹都要遍历的表）', !g.entities.includes(h));

  const g2 = stubGame();
  const h2 = spawn(g2);
  h2.takeDamage(170, { attacker: FOE, weapon: 'RPG-7', explosive: true, direct: true, part: 'body', point: P(0, 20, 0) });
  const frac = h2.hp / h2.maxHp;
  // 区间的两边都要写：大残 = 离掉下来还早（>10%），但已经是一只脚踩空的状态（<30%）
  ok('D4 满血被打中非要害：大残（剩一到三成，还活着）',
    h2.alive && frac > 0.1 && frac < 0.3, `剩余 ${(frac * 100).toFixed(1)}%`);
  // 反证之一：把"一发即毁"推广到非要害 ⇒ 这条红。反证之二：直击分支没接上（退化成溅射）
  // ⇒ 读数会落在"剩四成以上"，这条也红。
  ok('D5【反证】既不是"怎么打都一发入魂"，也不是"只被溅了一下"',
    h2.alive && Math.abs(h2.hp - h2.maxHp * (1 - HELI_ARMOR.rpgBody)) < 0.01, `hp=${h2.hp}`);
  const again = h2.takeDamage(170, { attacker: FOE, weapon: 'RPG-7', explosive: true, direct: true, part: 'body', point: P(0, 20, 0) });
  ok('D6 再补一发就下来了（大残 = 补得起刀，不是磨不动）', again === true && !h2.alive);

  // 没撞上、只是炸在边上：走溅射那一档
  const g3 = stubGame();
  const h3 = spawn(g3);
  explode(g3, P(0, 17, 0), 6, 170, FOE, 'RPG-7', {});
  const d3 = HELI_ARMOR.hp - h3.hp;
  const want3 = 170 * Math.pow(1 - 2.6 / 6, 0.8) * HELI_ARMOR.splash;   // src 抬高 0.4 ⇒ 距离 2.6 m
  ok('D7 在它边上炸开：伤害走溅射那一档',
    Math.abs(d3 - want3) < 0.5 && d3 > 0, `drop=${d3.toFixed(1)} 期望=${want3.toFixed(1)}`);
  // 反证臂：splash 被当成 1 ⇒ 读数 = want3 / 1.6 ≈ 108，这条红。
  ok('D8【反证】溅射乘数真的在场（去掉它读数只剩六成）', d3 > 170 * Math.pow(1 - 2.6 / 6, 0.8) * 1.4,
    `drop=${d3.toFixed(1)} vs 无乘数=${(170 * Math.pow(1 - 2.6 / 6, 0.8)).toFixed(1)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
sec('E. 敌我与"谁有权裁决"');
// ═══════════════════════════════════════════════════════════════════════════
{
  const g = stubGame();
  const mine = spawn(g, 'A');                      // 我自己这一队的直升机
  const friend = { team: 'A', isPlayer: true, name: '我', alive: true };
  fireHitscan(g, friend, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  ok('E1 自己这一队的枪打不到自己的直升机', mine.hp === mine.maxHp, `hp=${mine.hp}`);
  explode(g, P(0, 17, 0), 6, 170, friend, 'RPG-7', {});
  ok('E2 自己这一队的爆炸也不扣血', mine.hp === mine.maxHp, `hp=${mine.hp}`);
  // 反证臂：换成敌对方，同一枪必须掉血 —— 否则上面两条可能是"根本没打中"的假绿。
  fireHitscan(g, FOE, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  ok('E3【反证】换成敌方射手，同一条射线即刻掉血', mine.hp < mine.maxHp, `hp=${mine.hp.toFixed(2)}`);

  // 客户端的哑副本：它没有资格被人 locally 裁决血量
  const gc = stubGame();
  const dumb = spawn(gc, 'B', { dumb: true });
  ok('E4 哑副本不进实体表 —— 本地那把枪没权裁决它的血', !gc.entities.includes(dumb));
  const rd = fireHitscan(gc, { team: 'A', isPlayer: true }, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  ok('E5 本地子弹从哑副本身上穿过去（画面上中了，血在服务端扣）', rd.ent === null && dumb.hp === dumb.maxHp);
  // 反证臂：权威那一个在同一姿势下打得中（A3 已证明），两者必须不一样。
  ok('E6【反证】权威那一个在同一姿势下打得中（E5 的绿不是"直升机本来就打不中"）',
    spawn(gc).hitTest(P(0, 10, 0), D(0, 1, 0), 400) !== null);
}

// ═══════════════════════════════════════════════════════════════════════════
sec('F. 权威端（联机）：同一张装甲表 + 打下来的那句话要发得出去');
// ═══════════════════════════════════════════════════════════════════════════
const room = new NetRoom({ id: 'heli', mapId: 'yard', seed: 20260926 });
await room.start();
const CA = room.addClient({ name: '甲', team: 'A' });
const CB = room.addClient({ name: '乙', team: 'B' });
{
  for (let i = 0; i < 7; i++) room.game.onKill(CA.pl, CB.pl, 'm4', false, {});
  ok('F1 七连杀之后 heli 那一槽就绪', CA.book.slots[2].ready === true && CA.book.slots[2].id === 'heli');
  const n = room.callStreak(CA, 2);
  const h = room.active.find(a => a.isHeli);
  ok('F2 服务端放的那一架被放进了实体表（"谁会被打到"那份名单）',
    n === 'heli' && !!h && room.game.entities.includes(h));
  h.pos.set(0, 20, 0); h.yaw = 0; h.enter = 0;
  const before = h.hp;
  const r = fireHitscan(room.game, CB.pl, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  ok('F3 敌方这一枪在服务端掉血，数额与单机那一模一样（两端共用同一张表）',
    r.ent === h && Math.abs((before - h.hp) - M4.dmg[0] * HELI_ARMOR.bullet) < 0.01,
    `drop=${(before - h.hp).toFixed(2)}`);
  ok('F4 服务端打出来的不是血（记录里有 impact，没有 blood）',
    room.game.stubLog.some(x => x.k === 'effects.impact') && !room.game.stubLog.some(x => x.k === 'effects.blood'));

  // RPG 从正上方落下 —— 直击旋翼主轴
  const p = new Projectile(room.game, 'rocket', P(0, 30, 0), P(0, -55, 0), CB.pl, 10);
  room.game.projectiles.push(p);
  let f = 0;
  while (p.alive && f < 60) { p.update(1 / 60); f++; }
  ok('F5 RPG 砸在旋翼主轴上：服务端判一发即毁',
    !h.alive && h.downed === true && h.killer === CB.pl, `alive=${h.alive} downed=${h.downed}`);
  ok('F6【反证】它确实是飞到机体里才炸的（弹飞了若干帧，不是一出手就没）', f > 1 && f < 60, `用了 ${f} 帧`);

  room.step();
  const ev = room.events;
  ok('F7 下来的那一条 gone 事件在下行队列里', ev.some(e => e.e === 'gone' && e.kind === 'heli'));
  ok('F8 同时要有一句"被摧毁"播报（全场那份，前缀由客户端按敌我加）',
    ev.some(e => e.e === 'announce' && e.team === 'A' && e.text === '武装直升机被摧毁'));
  ok('F9 摧毁者收到属于自己的那一条提示（伤害在服务端算，提示只能靠事件回传）',
    ev.some(e => e.e === 'popup' && e.cid === CB.cid && e.text === '摧毁武装直升机'));

  // 反证臂：45 秒自然离场不许被念成"被击落"
  const room2 = new NetRoom({ id: 'heli2', mapId: 'yard', seed: 20260926 });
  await room2.start();
  const CA2 = room2.addClient({ name: '甲二', team: 'A' });
  room2.addClient({ name: '乙二', team: 'B' });
  for (let i = 0; i < 7; i++) room2.game.onKill(CA2.pl, CB.pl, 'm4', false, {});
  room2.callStreak(CA2, 2);
  const h2 = room2.active.find(a => a.isHeli);
  h2.t = 0.001;
  room2.step();
  ok('F10【反证】到点离场只是"没了"：没有摧毁播报、没有 popup',
    !h2.alive && room2.events.some(e => e.e === 'gone' && e.kind === 'heli')
    && !room2.events.some(e => e.e === 'announce' && e.text === '武装直升机被摧毁')
    && !room2.events.some(e => e.e === 'popup'), `events=${room2.events.map(e => e.e).join(',')}`);
}

// ═══════════════════════════════════════════════════════════════════════════
sec('G. 损伤状态要发得出去：头顶血量标记与冒烟的那路读数（差距清单"新产生"那条）');
// ═══════════════════════════════════════════════════════════════════════════
// 伤害与被击落在联机里是完整的（F 段已钉），缺的只是"还剩多少"：哑副本没有血量可显示，
// 而协议里没有 hp 字段。这里量的是权威端那条下发链 —— turret 出生事件带初值、之后每一跳
// 走 heliHp（按变化、限流）。客户端那一半（喂进 hp 就冒烟、头顶百分比跟着变）在
// test/net-feel.mjs 的 X 段。
{
  const room3 = new NetRoom({ id: 'heli3', mapId: 'yard', seed: 20260927 });
  await room3.start();
  const C3 = room3.addClient({ name: '甲三', team: 'A' });
  const D3 = room3.addClient({ name: '乙三', team: 'B' });
  for (let i = 0; i < 7; i++) room3.game.onKill(C3.pl, D3.pl, 'm4', false, {});
  room3.callStreak(C3, 2);
  const h3 = room3.active.find(a => a.isHeli);
  const tEv = room3.events.find(e => e.e === 'turret' && e.kind === 'heli');
  ok('G1 turret 出生事件带着 hp / maxHp（刚进场的人不该看到一架"满血"的残骸）',
    !!tEv && tEv.hp === Math.round(h3.hp) && tEv.maxHp === Math.round(h3.maxHp) && tEv.maxHp === HELI_ARMOR.hp,
    tEv ? `hp=${tEv.hp}/${tEv.maxHp}` : '没有 turret 事件');

  h3.pos.set(0, 20, 0); h3.yaw = 0; h3.enter = 0;
  const before = h3.hp;
  fireHitscan(room3.game, D3.pl, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  room3.step();
  const hpEv = room3.events.filter(e => e.e === 'heliHp');
  const last = hpEv[hpEv.length - 1];
  ok('G2 打掉血之后 0.2 s 内有一跳 heliHp，报的数就是权威端那架的血',
    !!last && last.netId === h3.netId && last.hp === Math.round(h3.hp) && h3.hp < before,
    `hp=${last && last.hp}  actual=${Math.round(h3.hp)}`);
  ok('G3【反证】报出来的不是"永远满血"那一格 —— 旧写法没有这条事件，这一条必红',
    !!last && last.hp < last.maxHp, `hp=${last && last.hp}/${last && last.maxHp}`);

  // 限流：同一窗口里的第二枪不许再发一跳（按变化、每 HELI_HP_EVERY 拍最多一条）。
  // 每次开火前都要把机**重新钉回射线下**：Heli.update 会把它推回航线圆上（radius 那一圈），
  // 隔着一步再沿原方向打就是打空气 —— 判据错一次的样子就是 G4/G5 一起红。
  room3.events.length = 0;
  h3.pos.set(0, 20, 0); h3.enter = 0;
  const before2 = h3.hp;
  fireHitscan(room3.game, D3.pl, P(0, 10, 0), D(0, 1, 0), m4, M4.name);
  room3.step();
  const n1 = room3.events.filter(e => e.e === 'heliHp').length;
  for (let i = 0; i < HELI_HP_EVERY + 2; i++) room3.step();
  const n2 = room3.events.filter(e => e.e === 'heliHp').length;
  ok('G4 限流在服务端：同一窗口里不刷屏，过了窗口该补的那一跳一定到',
    n1 === 0 && n2 === 1, `窗口内 ${n1} 条，过窗 ${n2} 条`);
  ok('G5【反证】这条限流判据不是恒真的：血确实又掉了一截（第二枪打中了）',
    h3.hp < before2, `第二枪后 ${Math.round(h3.hp)}（打前 ${Math.round(before2)}）`);
}

// ═══════════════════════════════════════════════════════════════════════════
const pass = checks.filter(c => c[0]).length;
console.log('');
for (const [good, label] of checks) console.log(`  ${good ? '✅' : '❌'} ${label}`);
console.log(`\n${'═'.repeat(76)}\n  武装直升机装甲：${pass}/${checks.length} 通过\n${'═'.repeat(76)}`);
process.exit(pass === checks.length ? 0 : 1);
