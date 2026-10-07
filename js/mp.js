// 多人模式：团队死斗 / 占领 / 自由混战 + 连杀奖励
import * as THREE from 'three';
import { Player } from './player.js';
import { Bot } from './ai.js';
import { MAPS } from './maps.js';
import { KILLSTREAKS, BOT_NAMES, WEAPONS, ATTACHMENTS, attachmentAllowed, computeStats } from './data.js';
import { fireHitscan, clusterStrike as spawnCluster, phosphorusSweep } from './combat.js';
import { mat } from './materials.js';
import { rand, pick, fmtTime, spreadDir, DEG, clamp, rayAABB, raySphere, rng, shuffle } from './util.js';
import { StreakBook, MatchRules, WP_SECONDS, killScore, killMedals, medalSay, KILL_POINTS, onKillPerks, uavHints, maybeDropWeapon, flagsTick, domBotGoal, spawnWavesTick, SAY, SAY_START, ANNOUNCE, DOM_RADIUS_WEAK } from './match-rules.js';
import { addLocalXp } from './progress.mjs';

// Bot 拿什么枪、装哪些配件。**导出**给联机权威端（server/room.mjs:spawnBot）共用：
// 这是"联机的 Bot 和单机的 Bot 手感一样"唯一的一处定义。抄一份的话，两边的 Bot
// 会从某次改动起拿不同的枪，而那种差异没人会去查（不报错、不崩，只是"对面变强了"）。
export const BOT_WEAPONS = ['m4', 'm4', 'ak', 'ak', 'scar', 'mp5', 'mp5', 'vector', 'pkm', 'm870', 'sks', 'l115'];

export function randomAtt(wid) {
  const att = {};
  const slots = shuffle(WEAPONS[wid].slots.slice()).slice(0, 3);
  for (const s of slots) {
    const opts = ATTACHMENTS[s].filter(a => attachmentAllowed(wid, s, a));
    if (opts.length && rng.next() < 0.7) att[s] = pick(opts).id;
  }
  return att;
}

// 据点的3D 旗（环 + 杆 + 布）。抽成模块函数是因为**联机客户端也要建同一种旗**：
// 位置来自两端共读的地图（w.flagPos），只有归属状态靠事件/记分板同步。
export function flagMesh(game, p) {
  const g = new THREE.Group();
  // 这里画的是**强占领圈**（4.5m，DOM_RADIUS_STRONG 的实体视觉）。弱占领圈（15m）
  // 刻意不画实体 —— 满地都是圈等于没有圈，它唯一的视觉在小地图上（hud.drawMinimap）。
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.3, 4.6, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; g.add(ring);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3.2, 8), mat('steel')); pole.position.y = 1.6; g.add(pole);
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, emissive: 0xffffff, emissiveIntensity: 0.2 }));
  cloth.position.set(0.56, 2.8, 0); g.add(cloth);
  g.position.set(p.x, game.world.groundHeight(p.x, p.z, 1, 0.3), p.z);
  game.world.root.add(g);
  g.userData = { ring, cloth };
  return g;
}

export class MPMatch {
  constructor(game, cfg) {
    this.game = game; this.cfg = cfg;
    this.type = cfg.mode; this.ffa = cfg.mode === 'ffa';
    // 分数/时限/连杀槽/按拍排程都来自规则内核（js/match-rules.js）——权威端 NetRoom
    // 用的是同一个类。这里刻意让 this.scores 指到 rules.scores 那一个对象上，而不是
    // 各自留一份副本：两份分数不会报错，只会在"谁先更新"上分叉。
    this.rules = new MatchRules(cfg);
    this.scoreLimit = this.rules.scoreLimit;
    this.scores = this.rules.scores;
    this.respawns = [];
    this.flags = null;
    // 占领的"在已占点重生"：死了之后按 1/2/3 选旗（下标），部署那拍兑现；点丢了由
    // flagSpawn 退回默认出生点。死亡时清零 —— 上一次命的选择不跟到下一次。
    this.spawnFlag = null;
    this.active = [];
    this.canChangeClass = true;
    this.nextLoadout = null;
    this.targeting = null;
    this.over = false;
    this.streakKills = 0;             // 只给 HUD 读的镜像（真值在 streakBook.progress）
  }
  // 剩下多少秒。改成取值而不是每拍自减：以前它和 rules.tick 是同一件事的两种写法，
  // 差一拍不会报错，只会让记分板上的时间比 HUD 上的计时器早一格。
  get timeLeft() { return this.rules.timeLeft(); }
  start() {
    const game = this.game, w = game.world, def = MAPS[this.cfg.map];
    const pteam = this.ffa ? 'P' : 'A';
    // 玩家
    const lo = this.buildLoadout(game.profile.classes[game.profile.selClass]);
    game.playerSleeve = def.styles[0] === 'snowA' ? 'fab_snowA' : 'fab_ally';
    const sp = this.spawnPoint(pteam);
    const pl = game.player = new Player(game, { team: pteam, pos: sp.pos, yaw: sp.yaw, name: '你' });
    pl.equip(lo);
    game.entities.push(pl);
    // 连杀：簿记在 StreakBook 里（js/match-rules.js），联机的权威端用的是同一个类。
    // streakState 留一个别名给 HUD —— hud.streaks() 读的就是 slots 的那几个字段，
    // 于是表现层一行都不用改，而"什么时候算就绪"这件事只剩一份实现。
    this.streakDefs = game.profile.streaks.map(id => KILLSTREAKS.find(k => k.id === id));
    this.streakBook = new StreakBook(this.streakDefs, pl.hasPerk('hardline') ? 1 : 0);
    this.streakState = this.streakBook.slots;
    this.streakKills = 0;
    // 机器人
    const names = shuffle(BOT_NAMES.slice());
    let ni = 0;
    const allyCount = this.ffa ? 0 : this.cfg.allies ?? 5;
    const enemyCount = this.ffa ? (this.cfg.enemies ?? 7) : this.cfg.enemies ?? 6;
    for (let i = 0; i < allyCount; i++) this.addBot('A', names[ni++ % names.length], def.styles[0]);
    for (let i = 0; i < enemyCount; i++) this.addBot(this.ffa ? 'F' + i : 'B', names[ni++ % names.length], this.ffa ? pick([def.styles[1], 'enemy', 'insurgent']) : def.styles[1]);
    const mname = { tdm: '团队死斗', dom: '占领', ffa: '自由混战' }[this.type];
    if (this.type === 'dom') {
      this.flags = w.flagPos.map((p, i) => ({ name: 'ABC'[i], pos: p.clone(), owner: null, prog: 0, capTeam: null, mesh: flagMesh(game, p) }));
      // 每队基地的波次倒计时（spawnWavesTick 独占、懒初始化）。dom 里基地也是复活点：
      // 档位跟该队占有的据点个数走（0 点只有基地 ⇒ 5s/波…）。
      this.baseCd = { A: null, B: null };
    }
    game.hud.reset();
    game.hud.announce(mname, `${def.name} · ${this.ffa ? '率先达到 ' + this.scoreLimit + ' 次击杀' : '目标分数 ' + this.scoreLimit}`, 4);
    game.audio.say(SAY_START(mname));
    this.updateStreakHUD();
  }
  addBot(team, name, style) {
    const game = this.game;
    const wid = pick(BOT_WEAPONS);
    const sp = this.spawnPoint(team);
    const bot = new Bot(game, { team, name, style, weaponId: wid, att: randomAtt(wid), difficulty: this.cfg.diff, pos: sp.pos, yaw: sp.yaw, role: 'mp', tag: team === 'A' && !this.ffa, tagColor: '#6cf', camo: pick(['none', 'none', 'desert', 'woodland', 'digital']) });
    game.addBot(bot);
    return bot;
  }
  buildLoadout(cls) {
    const pl = this.game.player;
    return {
      primary: { id: cls.primary, att: cls.patt || {}, camo: cls.pcamo },
      secondary: { id: cls.secondary, att: cls.satt || {}, camo: cls.scamo },
      lethal: cls.lethal, tactical: cls.tactical, perks: cls.perks,
    };
  }
  applyClass(idx) {
    this.nextLoadout = this.buildLoadout(this.game.profile.classes[idx]);
    this.game.profile.selClass = idx; this.game.saveProfile();
  }
  // 这张表是**地面上的敌对目标**：喂它的是"往哪儿投"与"往哪儿报"那几件事（集束空袭落点、
  // 白磷弹的目标集合、敌方 UAV 给 bot 的报点），它们全部假设目标站在地上。直升机照样在
  // game.entities 里（所以子弹打得到它），只是不参与这几处。
  enemiesOf(team) { return this.game.entities.filter(e => e.alive && e.team !== team && e.pos && e.targetable !== false && !e.isHeli); }
  spawnPoint(team) {
    const w = this.game.world;
    let cands;
    if (this.ffa) cands = [...w.spawns.A, ...w.spawns.B];
    else cands = team === 'A' ? w.spawns.A : w.spawns.B;
    // 出生点只躲地面的敌人：直升机每 45 秒绕场一圈，把它算进"离敌人多远"会让出生点
    // 躲一条它在天上留下的轨迹。
    const enemies = this.game.entities.filter(e => e.alive && e.team !== team && e.pos && !e.isHeli);
    // 加入随机点提升多样性（占领/自由模式）
    if (this.ffa || rng.next() < 0.25) for (let i = 0; i < 6; i++) cands = cands.concat([w.randomWalkable()]);
    let best = cands[0], bs = -1;
    for (const c of cands) {
      let md = 1e9;
      for (const e of enemies) md = Math.min(md, e.pos.distanceTo(c));
      const s = Math.min(md, 60) + rng.next() * 8;
      if (s > bs) { bs = s; best = c; }
    }
    const pos = best.clone();
    const yaw = Math.atan2(pos.x, pos.z); // 面向中心
    return { pos, yaw };
  }
  // 在已占领的旗子的**弱占领圈**内挑一个重生点（js/world.js:flagSpawnSpot）。
  // 旗子索引无效 / 不归该队所有（部署前被抢走了）→ 返回 null，调用方退回默认出生点。
  // 朝向沿用 spawnPoint 的"面向中心"同一条式子。
  flagSpawn(team, idx) {
    const f = this.flags && this.flags[idx];
    if (!f || f.owner !== team) return null;
    const w = this.game.world;
    const pos = w.flagSpawnSpot(f.pos.x, f.pos.z, DOM_RADIUS_WEAK);
    return { pos, yaw: Math.atan2(pos.x, pos.z) };
  }
  // Bot 的选点与真人同一规矩，只是"选哪个点"替它拿主意：优先离它当前目标最近的
  // 已占点（前沿压力 —— Bot 的目标就是占点内核给的旗子），没有目标就随机一个。
  // 返回旗子下标；队里没有已占点时返回 null。**死这一刻就定下**，之后排进那面旗的
  // 波次等批（respawns 队列里的 r.flag），不再走即时的倒计时部署。
  botFlagSpawn(bot) {
    if (!this.flags) return null;
    const owned = [];
    for (let i = 0; i < this.flags.length; i++) if (this.flags[i].owner === bot.team) owned.push(i);
    if (!owned.length) return null;
    if (bot.goal) {
      let best = owned[0], bd = 1e9;
      for (const i of owned) {
        const d = Math.hypot(this.flags[i].pos.x - bot.goal.x, this.flags[i].pos.z - bot.goal.z);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    return owned[(rng.next() * owned.length) | 0];
  }
  // 玩家部署的收尾：默认倒计时到点（空格）与波次到点（随批）两条路共用同一份簿记 ——
  // 换装/清选点/收死亡画面哪一步都不能只长在一条路上。
  deployPlayer(sp) {
    const game = this.game, pl = game.player;
    if (this.nextLoadout) { pl.equip(this.nextLoadout); this.nextLoadout = null; this.streakBook.setDiscount(pl.hasPerk('hardline') ? 1 : 0); }
    // 没换职业也要把装备拨回自己那一套：对局中从地上捡来的枪是**临时**的，
    // 重生握住的应该是 class 里配置好的那把。player.js 那条注释说的
    // "loadout 对局中不变"指的是"以 class 为准"，不是"死了还攥着刚捡的那把" ——
    // 老代码没有换职业时根本不 equip，于是捡来的枪一路带到下一次死亡。
    else if (pl.loadout) pl.equip(pl.loadout);
    pl.respawn(sp.pos, sp.yaw);
    this.rules.onRespawn(pl.team);   // dom：阵营每复活一人 -1（tdm/ffa 是空操作）
    this.spawnFlag = null;           // 选择兑现即清（下一次死再重选）
    this._spKeys = null;
    game.dead = false;
    document.getElementById('deathScreen').classList.add('hidden');
    game.menu.hideClassSelect();
    game.hud.spawnSelect(null);
    game.lock();
  }
  // 波次到点：把排在这面旗上的死者（玩家 + Bot）整体放行 —— 同一批走，等的本来就是
  // 同一趟车。点在等着的时候被抢走的，随同一批退到默认出生点，不落敌占圈。
  deployFlagWave(fi) {
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      const want = r.e.isPlayer ? this.spawnFlag : r.flag;
      if (want !== fi || r.e.alive) continue;
      const sp = this.flagSpawn(r.e.team, fi) || this.spawnPoint(r.e.team);
      if (r.e.isPlayer) this.deployPlayer(sp);
      else {
        r.e.respawn(sp.pos, sp.yaw);
        this.rules.onRespawn(r.e.team);   // dom：Bot 的复活同样记账（与真人同一条规则）
      }
      this.respawns.splice(i, 1);
    }
  }
  // 基地波到点：把"没排据点"的死者（玩家 spawnFlag==null / Bot r.flag==null）整体放行。
  deployBase(team) {
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      if (r.e.team !== team || r.e.alive) continue;
      const want = r.e.isPlayer ? this.spawnFlag : r.flag;
      if (want != null) continue;                 // 排了据点的走据点波
      const sp = this.spawnPoint(team);
      if (r.e.isPlayer) this.deployPlayer(sp);
      else {
        r.e.respawn(sp.pos, sp.yaw);
        this.rules.onRespawn(r.e.team);
      }
      this.respawns.splice(i, 1);
    }
  }
  // 死亡画面每帧的一小段（单机）：选点键（1/2/3 的**边沿**，再按一次取消）、主文案、
  // 选点卡片。边沿自记 keys 的上一帧状态 —— pressed 在 snapshotInput 末尾就清了，
  // update 里读不到。联机那一份同形状的东西长在 main.js:netRespawnTick。
  deathUiTick(r) {
    const game = this.game, pl = game.player;
    const el = document.getElementById('respawnText');
    if (!this.flags) {
      if (el) el.textContent = r.t > 0 ? `${Math.ceil(r.t)} 秒后重新部署…` : '按 [空格] 重新部署';
      return;
    }
    // dom：复活全程走波次（基地与据点同档 CD）。选点键的边沿自记 keys 的上一帧；
    // 主文案给"当前等的那一趟"读数，卡片给全部复活点（含基地）。
    const prev = this._spKeys || {};
    for (let k = 0; k < this.flags.length; k++) {
      const down = !!game.input.keys['Digit' + (k + 1)];
      if (down && !prev[k] && this.flags[k].owner === pl.team) this.spawnSelectPick(k);
    }
    this._spKeys = this.flags.map((f, k) => !!game.input.keys['Digit' + (k + 1)]);
    if (this.spawnFlag != null && this.flags[this.spawnFlag].owner !== pl.team) this.spawnFlag = null;
    const cd = f => Math.max(0, Math.ceil(f.spawnCd == null ? 0 : f.spawnCd));
    const baseLeft = Math.max(0, Math.ceil(this.baseCd[pl.team] == null ? 0 : this.baseCd[pl.team]));
    const sel = this.spawnFlag != null ? this.flags[this.spawnFlag] : null;
    if (el) el.textContent = sel
      ? `已选 ${sel.name} 点 · 下波 ${cd(sel)} 秒集体部署`
      : `基地 · 下波 ${baseLeft} 秒`;
    game.hud.spawnSelect(this.flags.map(f => ({
      name: f.name, mine: f.owner === pl.team, cd: cd(f),
      label: f.owner == null ? '未占领' : '敌方',
    })), this.spawnFlag, baseLeft);
  }
  // 单机选点的唯一入口（键与卡片点击都走它）：再选同一面旗 = 取消，回默认倒计时。
  // 联机那份在 main.js:spawnSelectPick —— 服务端把"再选同一面旗"当取消（requestSpawnSel）。
  spawnSelectPick(i) {
    if (!this.game.dead) return;
    if (i === -1) { this.spawnFlag = null; return; }
    if (!this.flags || !this.flags[i] || this.flags[i].owner !== this.game.player.team) return;
    this.spawnFlag = this.spawnFlag === i ? null : i;
  }
  uavActive(team) { return this.rules.uavActive(team); }

  // ---------- 机器人目标 ----------
  botGoal(bot) {
    const w = this.game.world;
    if (this.type === 'dom' && this.flags) {
      // 占点优先：选点内核在 match-rules.js（与联机 NetRoom.botGoal 共用同一份）——
      // 圈内钉住 / 85% 就近未占点 / 全占下回防。这里只负责"怎么走到那儿"：
      // 钉住时 ±1.2m 微调站位，赶路时 ±2.5m 散位（不挤成一个点）。
      const r = domBotGoal(this.flags, bot.pos.x, bot.pos.y, bot.pos.z, bot.team, () => rng.next());
      if (r) {
        const j = r.hold ? 1.2 : 2.5;
        return r.f.pos.clone().add(new THREE.Vector3(rand(-j, j), 0, rand(-j, j)));
      }
    }
    const enemies = this.enemiesOf(bot.team);
    if (enemies.length && rng.next() < 0.55) {
      const e = pick(enemies);
      return w.randomWalkable(e.pos.x, e.pos.z, 12);
    }
    return w.randomWalkable();
  }

  // ---------- 击杀 ----------
  onKill(killer, victim, weapon, head, info) {
    const game = this.game, pl = game.player;
    game.hud.killfeed(killer, victim, weapon, head);
    const kTeam = killer ? killer.team : null;
    if (killer && killer !== victim) {
      if (killer.isPlayer) this.playerKill(victim, weapon, head, info);
      else if (killer.kills !== undefined) {
        killer.kills++; killer.score += 100; killer.streak = (killer.streak || 0) + 1;
        if (!this.ffa) this.botStreak(killer);
      }
      if (!this.ffa && this.type === 'tdm') this.scores[kTeam === pl.team ? 'A' : 'B'] = (this.scores[kTeam === pl.team ? 'A' : 'B'] || 0) + 1;
    }
    // 助攻
    if (victim.dmgTaken && pl.alive !== undefined) {
      const d = victim.dmgTaken.get(pl);
      if (d && killer !== pl) { pl.stats.assists++; pl.stats.score += 25; game.hud.popup('+25 助攻', '#ddd'); this.chargeStreak(0.5); }
    }
    if (!this.rules.firstBlood && killer && killer !== victim) {
      this.rules.firstBlood = true;
      if (killer.isPlayer) { game.hud.popup('首杀', '', true); pl.stats.score += 50; }
    }
    // 掉落武器：规则在 js/match-rules.js:maybeDropWeapon（联机权威端跑的是同一份）
    maybeDropWeapon(game, victim);
    // 复活安排
    if (victim.isPlayer) {
      game.dead = true; game.deathKiller = killer;
      this.spawnFlag = null;          // 上一条命的选点不跟到这一次
      this.respawns.push({ e: victim, t: 4.5 });
      const el = document.getElementById('deathScreen');
      el.classList.remove('hidden');
      document.getElementById('killerInfo').innerHTML = killer && killer !== victim ? `被 <b>${killer.name}</b> 使用 ${weapon || ''} ${head ? '爆头' : ''}击杀` : '自我击杀';
      pl.stats.streak = 0;
      this.streakKills = 0;
      this.streakBook.onDeath();
      this.rules.resetChain(pl);      // 奖章窗口跟着死：复活只要 4.5 秒，比 4 秒窗口长不了多少
      this.updateStreakHUD();
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      victim.streak = 0;
      // Bot 的去向死这一刻就定下：队里有已占点 → 排进那面旗的波次（r.flag），与真人
      // 同一趟车；没有 → null，走默认的倒计时。
      this.respawns.push({ e: victim, t: 4 + rng.next() * 2, flag: this.botFlagSpawn(victim) });
    }
    // FFA 分数
    if (this.ffa && killer && killer !== victim) {
      const k = killer.isPlayer ? pl.stats.kills : killer.kills;
      if (k >= this.scoreLimit) this.end(killer);
    }
  }
  playerKill(victim, weapon, head, info) {
    const game = this.game, pl = game.player;
    pl.stats.kills++; pl.stats.streak++;
    // 键 = 本地玩家实体。单机里只有玩家的击杀走这条（Bot 击杀在 onKill 里不调它），
    // 所以 Bot 不需要账；联机权威端每一杀都调，那份分账在 server/room.mjs:onKill。
    const n = this.rules.killChain(pl);
    // 分值来自 js/match-rules.js:killScore（联机权威端问的是同一句）。
    // 逐条奖章那几行问 killMedals（**联机画的是同一张表**，见 js/main.js:onNetKill）。
    const sc = killScore({
      head: !!head, melee: !!(info && info.melee), explosive: !!(info && info.explosive),
      dist: victim.pos.distanceTo(pl.pos), chain: n, revenge: pl.lastAttacker === victim,
    });
    if (pl.lastAttacker === victim) pl.lastAttacker = null;
    if (head) pl.stats.headshots++;
    game.hud.popup(`+${KILL_POINTS.kill} 击杀`, '#fff');
    // 一条奖章一行字。以前这里是五条手写 if，近战那条还漏了分值 —— 于是"同样一条奖章
    // 在单机写着 +50、在联机什么都没有"这种差别没人看得出来。表只有一份之后，
    // 两端同一批 tags 出来的就是同一行字。
    for (const m of killMedals(sc.tags)) {
      game.hud.popup(`${m.label} +${m.points}`, '', true);
      const v = medalSay(m.tag, m.label);
      if (v) game.audio.say(v);
    }
    if (pl.stats.streak % 5 === 0) game.hud.popup(`连杀 ×${pl.stats.streak}`, '', true);
    pl.stats.score += sc.points;
    // 拾荒者 / 速愈：规则在 js/match-rules.js:onKillPerks —— 联机权威端与客户端镜像
    // 用的是同一份；这里只负责把返回的文案画成弹窗。
    for (const t of onKillPerks(pl).texts) game.hud.popup(t, '#9cf');
    if (this.type === 'ffa') { }
    this.chargeStreak(1);
  }
  chargeStreak(v) {
    // 就绪判定在 StreakBook 里（联机权威端用的是同一份）。这里只负责**播报** ——
    // 规则说"第 i 个槽刚就绪"，表现层说"屏幕左上角弹一行字、播一声"。分开之后
    // 联机侧就不必再抄一遍 cost/progress 的比较。
    this.streakKills = this.streakBook.progress;
    for (const i of this.streakBook.charge(v)) {
      const def = KILLSTREAKS.find(k => k.id === this.streakState[i].id);
      this.game.hud.announce(def.name + ' 就绪', `按 [${i + 3}] 呼叫`, 2.5);
      this.game.audio.say(SAY.ready(def.name));
      this.game.audio.beep(3);
    }
    this.updateStreakHUD();
  }
  updateStreakHUD() {
    this.game.hud.streaks(this.streakState, Math.floor(this.streakBook.progress));
  }
  botStreak(bot) {
    const game = this.game;
    const team = bot.team;
    if (bot.streak === 3) {
      this.rules.uavStart(team, 25 * 60);
      if (team !== game.player.team) { game.hud.announce(ANNOUNCE.uavFoe, '幽灵技能可规避', 3); game.audio.say(SAY.uavFoe); }
      else game.hud.announce('友方 UAV 已上线', '', 2);
    } else if (bot.streak === 5) {
      const targets = this.enemiesOf(team).filter(e => !(e.isPlayer && e.hasPerk('coldblooded')));
      if (targets.length) {
        const t = pick(targets);
        this.clusterStrike(t.pos.clone(), bot, rand(0, Math.PI * 2));
        if (team !== game.player.team) { game.hud.announce(ANNOUNCE.clusterFoe, '立即寻找掩护', 3); game.audio.say(SAY.clusterFoe); }
      }
    } else if (bot.streak === 7) {
      this.spawnHeli(team, bot);
      if (team !== game.player.team) { game.hud.announce(ANNOUNCE.heliFoe, '', 3); game.audio.say(SAY.heliFoe); }
    }
  }

  // ---------- 连杀奖励 ----------
  useStreak(i) {
    const s = this.streakState[i];
    if (!s || !s.ready) return;
    const game = this.game, pl = game.player;
    // 两种"不能呼叫即消耗"的：
    //  · 集束空袭要先选目标，改主意（右键）就不该扣掉；
    //  · 哨戒机枪要先确认站位放得下（不然是白扣一个槽）。
    // 它们各自在确认为真的那一刻才 consume —— 规则内核提供的两个入口之一，
    // 谁都不许直接改 s.ready（改了不会报错，只会让联机与单机的账对不上）。
    if (s.id === 'cluster') {
      this.targeting = { s, type: 'cluster' };
      game.hud.announce('选择空袭目标', '左键确认 · 右键取消', 2.5);
      return;
    }
    if (s.id === 'sentry') {
      const f = pl.forward(new THREE.Vector3()); f.y = 0; f.normalize();
      const p = pl.pos.clone().addScaledVector(f, 2);
      if (game.world.lineBlocked(pl.pos.clone().setY(pl.pos.y + 0.5), p.clone().setY(p.y + 0.5))) { game.hud.popup(ANNOUNCE.sentryBlocked, '#f66'); game.audio.say(SAY.sentryBlocked); return; }
      if (!this.streakBook.consume(s)) return;
      this.active.push(new Sentry(game, p, pl));
      game.audio.say(SAY.sentryOwn);
      this.updateStreakHUD();
      return;
    }
    if (!this.streakBook.take(i)) return;
    if (s.id === 'uav') { this.rules.uavStart(pl.team); game.hud.announce(ANNOUNCE.uav, '', 2); game.audio.say(SAY.uavOwn); }
    else if (s.id === 'heli') { this.spawnHeli(pl.team, pl); game.audio.say(SAY.heliOwn); }
    else if (s.id === 'wp') this.whitePhosphorus(pl);
    this.updateStreakHUD();
  }
  spawnHeli(team, owner) { this.active.push(new Heli(this.game, team, owner)); }
  // 弹幕中心与方向由调用方给（单机是玩家在地图上点的那一点，联机是呼叫者视线前方
  // 一段距离）——那是**输入**；"呼叫之后会发生什么"两边共用 js/combat.js 那一份。
  clusterStrike(pos, owner, ang) { spawnCluster(this.game, this.rules.clock, pos, owner, ang); }
  whitePhosphorus(owner) {
    const game = this.game;
    game.hud.announce(ANNOUNCE.wp, '', 3); game.audio.say(SAY.wpFoe);
    // 计时器归规则内核（联机权威端读的是同一个字段），落火与即时灼烧归共用那一段
    this.rules.wpTicks = WP_SECONDS * 60;
    phosphorusSweep(game, this.rules.clock, owner, this.enemiesOf(owner.team));
  }

  // ---------- 更新 ----------
  update(dt, inp) {
    const game = this.game, pl = game.player;
    if (this.over) { return; }
    // 规则时钟每拍走一格：UAV/白磷弹的剩余时间、以及按拍排程的空袭投弹都在这里推进。
    // 放在 update 的最前面（而不是末尾）：排程回调会往 game.projectiles 里塞炸弹，
    // 而 projectiles 的 update 在 **game.update 里、mode.update 之前**跑过 —— 所以
    // 这一拍排出来的弹要等下一拍才飞。这和 setTimeout 版的时序是同一件事（那时它更是
    // 完全脱拍的），但"早一拍照样是晚一拍"这件事值得写下来，免得以后有人拿
    // "投弹数对不对"去查时序。
    this.rules.step();
    // 复活。占领全程走波次：基地与每面旗各按**该队占有据点个数**的档位（0点5s/1点10s/
    // 2点20s/3点30s）循环，到点把排在该复活点的死者（玩家 + Bot，同一趟车）整体放行 ——
    // CD 不管有没有人排都照转。tdm/ffa 不碰这条，照旧走个人倒计时。
    if (this.flags) {
      const w = spawnWavesTick(this.flags, this.baseCd, dt);
      for (const fi of w.flags) this.deployFlagWave(fi);
      for (const t of w.bases) this.deployBase(t);
    }
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      if (this.flags) {                    // dom：放行权全在波次，这里只画死亡画面
        if (r.e.isPlayer) this.deathUiTick(r);
        continue;
      }
      r.t -= dt;
      if (r.e.isPlayer) {
        this.deathUiTick(r);               // 内部按模式分支：dom 波次文案 / tdm 倒计时
        if (r.t <= 0 && (game.input.keys.Space || r.t < -4)) {
          this.deployPlayer(this.spawnPoint(pl.team));
          this.respawns.splice(i, 1);
        }
      } else if (r.t <= 0) {
        const sp = this.spawnPoint(r.e.team);
        r.e.respawn(sp.pos, sp.yaw);
        this.rules.onRespawn(r.e.team);   // dom：Bot 的复活同样记账（与真人同一条规则）
        this.respawns.splice(i, 1);
      }
    }
    // 占领
    if (this.flags) {
      // 占领的规则（半径/速度/回退/得分）在 js/match-rules.js:flagsTick —— 联机权威端
      // 跑的是同一份。这一段只剩表现：进度条、旗帜颜色、+200 弹窗与播报。
      const ft = flagsTick(this.flags, this.rules, game.entities, dt);
      for (const { f, teams, inRange, capped } of ft.flags) {
        // "我在圈里"的口径跟弱圈走（两层圈里都出力，都该看见进度条）；高度差由
        // flagsTick 那侧裁，这里只管水平距离。
        const pd = pl.alive && Math.hypot(pl.pos.x - f.pos.x, pl.pos.z - f.pos.z) < DOM_RADIUS_WEAK;
        if (capped) {
          const mine = capped === pl.team;
          game.hud.announce(`${mine ? '已占领' : '失去'} ${f.name} 点`, '', 2);
          game.audio.say(mine ? SAY.capOwn(f.name) : SAY.capFoe(f.name));
          for (const e of inRange) {
            if (!e.alive || e.team !== capped) continue;
            if (e.isPlayer) { e.stats.score += 200; e.stats.captures++; game.hud.popup('+200 占领', '', true); }
            else if (e.isBot) { e.score += 200; e.captures++; }
          }
          game.hud.progress(null);
        } else if (teams.length === 1 && teams[0] !== f.owner) {
          if (pd && teams[0] === pl.team) game.hud.progress(f.prog);
        } else if (teams.length !== 1) {
          if (pd && teams.length > 1) game.hud.progress(f.prog);
        } else if (f.owner === teams[0] && pd) game.hud.progress(null);
        if (!pd && this.nearFlag === f) game.hud.progress(null);
        if (pd) this.nearFlag = f; else if (this.nearFlag === f) this.nearFlag = null;
        const col = f.owner === pl.team ? 0x4fb4ff : f.owner ? 0xff4a3d : 0xffffff;
        f.mesh.userData.ring.material.color.setHex(col);
        f.mesh.userData.cloth.material.color.setHex(col); f.mesh.userData.cloth.material.emissive.setHex(col);
        f.mesh.userData.cloth.rotation.y = Math.sin(game.time * 2 + f.pos.x) * 0.3;
      }
    }
    // 敌方 UAV 给我的敌人报点（我方 UAV 的效果走小地图，见 hud.drawMinimap）。
    // 计时本身在 rules.step() 里 —— 以前它在这里自减，于是"还剩多久"有两个来源。
    // 报点的规则在 js/match-rules.js:uavHints，联机权威端跑的是同一份（幽灵的过滤也在
    // 里面）；skipTeam 只有单机才传 —— "我方 UAV 不喂 Bot"是单人视角的语义。
    uavHints(game, this.rules, this, dt, pl.team, (team) => this.enemiesOf(team));
    if (this.rules.wpTicks > 0) { game.grade.uniforms.wp.value = Math.min(1, this.rules.wpTicks / (3 * 60)) * 0.6; for (const e of this.enemiesOf(pl.team)) if (rng.next() < dt * 2) e.takeDamage(6, { attacker: pl, weapon: '白磷弹', explosive: true, dir: new THREE.Vector3(0, -1, 0) }); }
    else game.grade.uniforms.wp.value = 0;
    // 连杀奖励
    for (const a of this.active) a.update(dt);
    this.active = this.active.filter(a => a.alive);
    if (pl.alive && inp.streak >= 0) this.useStreak(inp.streak);
    this.updateTargeting(inp);
    // HUD
    this.hudScore();
    const markers = [];
    if (this.flags) for (const f of this.flags) markers.push({ id: 'f' + f.name, pos: f.pos.clone().setY(f.mesh.position.y + 3.6), label: f.name, cls: 'flag ' + (f.owner === pl.team ? 'ally' : f.owner ? 'enemy' : 'neutral') });
    // 敌方直升机：血量写在它头顶。"还剩多少"必须看得见 —— 它在 24 m 高空，一梭子下去
    // 掉的血你看不见，没有这个读数的话玩家没法判断自己在不在输出。这一份血量是**本机
    // 权威**的（单机这一侧的 Heli.takeDamage 就在本机），所以这条标记只长在单机这条路上。
    for (const a of this.active) {
      if (a.isHeli && a.alive && a.team !== pl.team)
        markers.push({ id: 'heli' + a.uid, pos: a.pos.clone().setY(a.pos.y + 2.4), label: a.name, cls: 'enemy', text: `${Math.max(1, Math.ceil(a.hp / a.maxHp * 100))}%`, hideDist: true });
    }
    game.hud.setMarkers(markers);
    // 结束判定。团队模式走规则内核（分数到线 / 时间到，都是"谁赢了"这件事的定义），
    // 自由混战的"谁赢了"取决于名次而名次里有人 —— 那不是规则能判的，留在上层。
    if (!this.ffa) { const w = this.rules.checkEnd(); if (w) this.end(w); }
    else if (this.rules.timeUp) { const all = this.ranking(); this.end(all[0].e); }
  }
  updateTargeting(inp) {
    const game = this.game, t = this.targeting;
    if (!t) { if (this.tgtMesh) this.tgtMesh.visible = false; return; }
    if (!this.tgtMesh) {
      this.tgtMesh = new THREE.Mesh(new THREE.RingGeometry(3, 3.5, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.4, 0.2), transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false }));
      this.tgtMesh.rotation.x = -Math.PI / 2; game.world.root.add(this.tgtMesh);
    }
    const cam = game.camera, d = cam.getWorldDirection(new THREE.Vector3());
    const hit = game.world.raycast(cam.position, d, 200);
    this.tgtMesh.visible = !!hit;
    if (hit) this.tgtMesh.position.copy(hit.point).setY(hit.point.y + 0.1);
    game.hud.prompt('<b>左键</b>确认空袭目标 · <b>右键</b>取消');
    if (inp.firePressed && hit) {
      this.clusterStrike(hit.point.clone(), game.player, game.player.yaw + Math.PI / 2);
      this.streakBook.consume(t.s); this.targeting = null; game.hud.prompt(null);
      game.audio.say(SAY.clusterOwn); this.updateStreakHUD();
      game.player.ws.cool = 0.3;
    } else if (inp.adsPressed) { this.targeting = null; game.hud.prompt(null); }
  }
  get interactPrompt() { return !!this.targeting; }
  hudScore() {
    const game = this.game, pl = game.player;
    const t = fmtTime(this.timeLeft);
    let html;
    if (this.ffa) {
      const r = this.ranking();
      const me = r.findIndex(x => x.e.isPlayer);
      const lead = r[0];
      // 左右两格加"我/榜首"小字：红蓝格子本来就是团队模式的壳，不标的话领跑者两格
      // 同数（自己超自己时右格显第二名），看起来像比分出了问题（联机同款，client.mjs）。
      html = `<div class="sb-team a"><small style="font-size:10px;color:#9cf">我</small> ${pl.stats.kills}</div><div class="sb-time">${t}<br><small style="font-size:11px;color:#aaa">第 ${me + 1} 名</small></div><div class="sb-team b"><small style="font-size:10px;color:#f96">榜首</small> ${lead.e.isPlayer ? (r[1] ? r[1].k : 0) : lead.k}</div>`;
    } else {
      let flags = '';
      if (this.flags) flags = `<div class="sb-flags">${this.flags.map(f => `<div class="sb-flag ${f.owner === pl.team ? 'A' : f.owner ? 'B' : ''}">${f.name}</div>`).join('')}</div>`;
      html = `<div class="sb-team a">${Math.floor(this.scores.A)}</div>${flags}<div class="sb-time">${t}</div><div class="sb-team b">${Math.floor(this.scores.B)}</div>`;
    }
    game.hud.scorebar(html);
  }
  ranking() {
    const game = this.game, pl = game.player;
    const list = [{ e: pl, k: pl.stats.kills, d: pl.stats.deaths, s: pl.stats.score }];
    for (const b of game.bots) list.push({ e: b, k: b.kills, d: b.deaths, s: b.score });
    return list.sort((a, b) => b.k - a.k || b.s - a.s);
  }
  scoreboardHTML() {
    const game = this.game, pl = game.player;
    const row = (x, i) => `<tr class="${x.e.isPlayer ? 'me' : ''} ${x.e.alive ? '' : 'dead'}"><td>${i + 1}. ${x.e.name}</td><td>${x.s}</td><td>${x.k}</td><td>${x.d}</td><td>${x.e.isPlayer ? pl.stats.assists : '-'}</td></tr>`;
    const head = (t, cls) => `<table class="sbt ${cls}"><tr><th>${t}</th><th>得分</th><th>击杀</th><th>死亡</th><th>助攻</th></tr>`;
    const all = this.ranking();
    if (this.ffa) return head('自由混战', 'A') + all.map(row).join('') + '</table>';
    const A = all.filter(x => x.e.team === pl.team), B = all.filter(x => x.e.team !== pl.team);
    return head(`联合特遣队 · ${Math.floor(this.scores.A)}`, 'A') + A.map(row).join('') + '</table>' + head(`敌方部队 · ${Math.floor(this.scores.B)}`, 'B') + B.map(row).join('') + '</table>';
  }
  minimapMarkers() { return []; }
  end(winner) {
    if (this.over) return;
    this.over = true;
    // 规则侧那份"这局结束了"也要置上：快照头的 MatchOver 位读的是它，联机侧靠那一位
    // 知道该收工。自由混战传进来的是**实体**（名次第一的那个人），换算成队伍只是为了让
    // 规则侧有一个值 —— 它不用这个值做什么。
    this.rules.forceEnd(typeof winner === 'string' ? winner : ((winner && winner.team) || 'draw'));
    const game = this.game, pl = game.player;
    game.ending = true;
    // 死着迎来终局的情形：deathScreen 之前只在"重生"与"退回菜单"两条路上收过，
    // 于是排行榜/结算界面会被一张"被 xx 击杀 · N 秒后重新部署"盖在下面，
    // 而且那张牌会一直活到下一局（见 main.js:startGame 的兜底，两边都留着）。
    document.getElementById('deathScreen').classList.add('hidden');
    let win;
    if (this.ffa) win = winner === pl ? 'win' : 'lose';
    else win = winner === 'draw' ? 'draw' : winner === pl.team ? 'win' : 'lose';
    const r = this.ranking();
    const place = r.findIndex(x => x.e.isPlayer) + 1;
    const xp = pl.stats.score + (win === 'win' ? 500 : 150);
    // 单机对局这一笔同样是**本地经验**：它没有服务端裁决可依，所以不进账号（js/progress.mjs）。
    // 同一件事的另一半在 js/net/client.mjs：联机那一局登录玩家记账号那份、访客记本地那份。
    addLocalXp(game.profile, xp); game.saveProfile();
    game.audio.say(win === 'win' ? SAY.win : win === 'draw' ? SAY.draw : SAY.lose);
    game.hud.announce(win === 'win' ? '胜利' : win === 'draw' ? '平局' : '失败', '', 3);
    setTimeout(() => {
      if (document.pointerLockElement) document.exitPointerLock();
      game.menu.showResults({
        win, title: win === 'win' ? '胜利' : win === 'draw' ? '平局' : '失败',
        sub: this.ffa ? `第 ${place} 名` : `${Math.floor(this.scores.A)} : ${Math.floor(this.scores.B)}`,
        stats: [['得分', pl.stats.score], ['击杀', pl.stats.kills], ['死亡', pl.stats.deaths], ['K/D', (pl.stats.kills / Math.max(1, pl.stats.deaths)).toFixed(2)], ['命中率', Math.round(pl.stats.hits / Math.max(1, pl.stats.shots) * 100) + '%'], ['经验值', '+' + xp]],
        board: this.scoreboardHTML(), again: () => game.startGame('mp', this.cfg),
      });
    }, 2500);
  }
  dispose() {
    // 排掉的定时任务要清掉：新的 MPMatch 会带一份新的 MatchRules，但旧实例上的回调
    // 闭包里抓着的 game/world 可能已经被 clearWorld 换过了 —— 那种回调跑起来就是往
    // 新一局里投上一局的弹。
    this.rules.clock.jobs.length = 0;
    for (const a of this.active) a.dispose && a.dispose();
    this.game.hud.progress(null);
  }
}

// ---------- 哨戒机枪 ----------
// 联机下它有两个身份，靠 opts.dumb 分：
//   · 权威端（server/room.mjs）建的是**真**的：自己找目标、自己开火，伤害在这一台机器上算。
//   · 客户端收到 spawnTurret 事件后建一个同形副本，dumb=true：只转向、只放枪口火光与音效，
//     **不开火**。少了这个开关，两边会各打一份伤害 —— 那不会报错，只会让所有东西都快一倍死。
export class Sentry {
  constructor(game, pos, owner, opts = {}) {
    this.game = game; this.owner = owner; this.team = owner.team; this.name = '哨戒机枪'; this.isTurret = true;
    this.dumb = !!opts.dumb;
    this.pos = pos.clone(); this.pos.y = game.world.groundHeight(pos.x, pos.z, pos.y + 0.5, 0.3);
    this.hp = 300; this.alive = true; this.t = opts.duration || 60; this.yaw = owner.yaw; this.fireT = 0; this.target = null; this.scanT = 0;
    this.stats = { dmgNear: 20, dmgFar: 16, rangeNear: 20, rangeFar: 50, headMul: 1.2, name: '哨戒机枪' };
    // ── 模型二态（性能审查 N2）──
    // 权威端（game.headless，见 server/headless-game.mjs）不渲染，却曾经为每台哨戒机建
    // 全套 mesh/geometry/material。**枪口这一层不能删**：update 里 muzzle.getWorldPosition()
    // 的矩阵链是表现坐标的唯一来源，head.rotation.y 的赋值节奏也是 —— 所以只删"看得见的
    // 那一半"：Group/head/muzzle 三个 Object3D 原样保留（零几何成本），update 与 dispose
    // 的相关代码逐字不动。判据用的 stubGame 不带 headless 旗 ⇒ 照旧全量建模。
    const g = new THREE.Group();
    const head = new THREE.Group(); head.position.y = 0.95; g.add(head);
    if (!game.headless) {
      for (let i = 0; i < 3; i++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6), mat('darkMetal')); const a = i / 3 * Math.PI * 2; l.position.set(Math.cos(a) * 0.3, 0.45, Math.sin(a) * 0.3); l.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); g.add(l); }
      head.add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 0.5), mat('gunGreen')));
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 8).rotateX(Math.PI / 2), mat('gunMetal')); b.position.set(0, 0.02, -0.55); head.add(b);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.25), mat('gunGreen')); box.position.set(0.25, -0.05, 0); head.add(box);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshBasicMaterial({ color: owner.isPlayer ? new THREE.Color(0.3, 1.5, 3) : new THREE.Color(3, 0.3, 0.3) })); lamp.position.set(0, 0.17, 0.1); head.add(lamp);
      g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    }
    this.muzzle = new THREE.Object3D(); this.muzzle.position.set(0, 0.02, -0.92); head.add(this.muzzle);
    g.position.copy(this.pos); game.scene.add(g);
    this.mesh = g; this.head = head;
    // 只有**权威的那一个**进实体表 —— 与下面 Heli 构造函数同一口径。
    // game.entities 是"谁会被子弹与爆炸遍历到"的名单（js/combat.js:traceBullet / explode），
    // 放进去就等于"这台机器上可以裁决它的血量"。客户端的哑副本（opts.dumb）不进 ⇒
    // 本地子弹从它身上穿过去，血量只由权威端说了算。
    // 旧写法无条件 push，两头的症状各一个，**都不报错**：本地子弹把别人的机枪
    // "假打死"（本地爆炸 + popup，而权威那台还活着，随后 gone 事件又带回一份 popup ⇒ 重复）；
    // 而且它会被 enemiesOf()（js/mp.js）算成敌人，Bot 会朝一台打不死的机枪开枪。
    // 它照样转、照样有枪口火光：那一路走的是 NetClient.turrets 那张表
    //（js/net/client.mjs 每帧 t.update(dt)），与 entities 无关。
    if (!this.dumb) game.entities.push(this);
  }
  eyePos(o) { return o.set(this.pos.x, this.pos.y + 1.0, this.pos.z); }
  chestPos(o) { return o.set(this.pos.x, this.pos.y + 0.8, this.pos.z); }
  hitTest(o, d, maxT) {
    if (!this.alive) return null;
    const b = { x0: this.pos.x - 0.3, x1: this.pos.x + 0.3, y0: this.pos.y, y1: this.pos.y + 1.15, z0: this.pos.z - 0.3, z1: this.pos.z + 0.3 };
    const t = rayAABB(o.x, o.y, o.z, d.x, d.y, d.z, b, maxT);
    return t >= 0 ? { t, part: 'body' } : null;
  }
  takeDamage(d, info) {
    if (!this.alive) return false;
    this.hp -= info.explosive ? d * 2 : d * 0.5;
    if (this.hp <= 0) { this.destroy(info); if (info.attacker && info.attacker.isPlayer) this.game.hud.popup('摧毁哨戒机枪 +100', '', true); return true; }
    return false;
  }
  destroy(info = {}) {
    this.alive = false;
    // 与 Heli 同一组字段：联机的"被摧毁"播报与"摧毁者"提示读的就是这两个（server/room.mjs
    // 的 gone 循环）。它们以前没有，于是联机里把机枪打掉是**悄无声息**的。
    this.downed = true; this.killer = info.attacker || null;
    this.game.effects.explosion(this.pos.clone().setY(this.pos.y + 0.8), 0.6); this.game.audio.explosion(this.pos, 0.5);
    this.dispose();
  }
  dispose() { this.game.scene.remove(this.mesh); this.game.entities = this.game.entities.filter(e => e !== this); }
  update(dt) {
    const game = this.game;
    this.t -= dt;
    if (this.t <= 0) { this.alive = false; this.dispose(); return; }
    this.fireT -= dt; this.scanT -= dt;
    const eye = this.eyePos(new THREE.Vector3());
    if (this.scanT <= 0) {
      this.scanT = 0.25; this.target = null;
      let bd = 45;
      for (const e of game.entities) {
        if (!e.alive || e.team === this.team || !e.chestPos || e.isTurret) continue;
        const c = e.chestPos(new THREE.Vector3());
        const d = c.distanceTo(eye);
        if (d > bd) continue;
        if (e.isPlayer && e.hasPerk('coldblooded')) continue;
        if (game.world.lineBlocked(eye, c)) continue;
        bd = d; this.target = e;
      }
    }
    if (this.target && this.target.alive) {
      const c = this.target.chestPos(new THREE.Vector3());
      const want = Math.atan2(-(c.x - eye.x), -(c.z - eye.z));
      let da = want - this.yaw; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
      this.yaw += clamp(da, -5 * dt, 5 * dt);
      if (Math.abs(da) < 0.15 && this.fireT <= 0) {
        this.fireT = 0.1;
        const dir = spreadDir(c.sub(eye).normalize(), 2.2 * DEG, new THREE.Vector3());
        const m = this.muzzle.getWorldPosition(new THREE.Vector3());
        game.effects.muzzle(m, dir, 0.7, false);
        game.audio.shot('turret', this.pos);
        // 客户端的表现副本到这里为止：它没有权力裁决伤害（见类头注释）
        if (this.dumb) return;
        const r = fireHitscan(game, this.owner.alive !== undefined ? this.owner : this, eye, dir, this.stats, '哨戒机枪');
        game.effects.tracer(m, r.point, [2, 1.4, 0.6]);
        if (r.ent && this.owner.isPlayer) { game.hud.hitmarker(r.killed); }
      }
    } else this.yaw += dt * 0.6;
    this.head.rotation.y = this.yaw;
  }
}

// ---------- 武装直升机 ----------
// dumb 的含义与 Sentry 相同：权威端那一个真的开火，客户端那一个只飞、只放曳光。
//
// 它是**可以打下来的**。这一件事有三个零件，全在这一个类里；单机跑的就是这个类，
// 联机权威端 server/room.mjs 建的也是同一个类，而客户端的哑副本压根不在
// game.entities 里（打不到、也扣不了血 ⇒ 伤害只有一台机器在裁），所以下面这张表一改，
// 两端同时生效 —— 这正是"两端各改一处、改完还对不上"那种分歧的唯一解药。
//
//  ① 装甲表 HELI_ARMOR：子弹轻微、溅射翻倍、RPG 直击按要害分档。
//  ② 命中体 HELI_HITBOXES：射线落到实处还要回答"打在哪儿"（body 还是 vital）。
//  ③ 血量 hp 与它的唯一入口 takeDamage。

// 装甲表（一处定义）。改这里的数之前先读一遍 test/heli-armor.mjs 那几条判据的措辞 ——
// 每一条写的都是"这条红了说明哪个设计意图坏了"。
export const HELI_ARMOR = {
  hp: 600,        // 机体总血量
  bullet: 0.35,   // 轻武器：只有 35% 的伤害落到机体上 —— 打它是"磨"，不是"秒"
  vital: 1.8,     // 要害：座舱与旋翼主轴，在 bullet 的基础上再翻一倍多 —— 瞄准的意义就在这里
  splash: 1.6,    // 没直接命中的爆炸（冲击波）：远处的当量对机体比对人管用
  rpgBody: 0.8,   // RPG 直击非要害：一次性打掉八成血（大残，再补一匣就下来）
};

// 命中体：一串局部坐标的球（机头朝 -Z，y 向上），判定时随 yaw 绕 Y 轴旋到世界。
// 为什么是球串而不是一个包围盒：包围盒会把"从机头斜前方擦过去的那一枪"判成命中，
// 而那一枪在画面上是**穿过去了** —— 打空气掉血比打不中难受得多。
// 旋翼桨叶**不**在表里：那一片是高速旋转的糊影，给它一片 7.5 m 的"命中板"会让
// 瞄准变成看运气。相邻两颗在 Z 上是叠住的，逐颗排下来是一条连续的机体 —— 中间断开一段
// 的症状是"那一截打上去没反应"，而模型看上去还好端端在那儿。
export const HELI_HITBOXES = [
  { x: 0, y: 0.15, z: -2.2, r: 1.00, part: 'vital' },  // 座舱：正前方那个玻璃罩
  { x: 0, y: 1.45, z: 0.0, r: 0.85, part: 'vital' },   // 旋翼主轴 / 主减速器
  { x: 0, y: 0.00, z: -0.8, r: 1.30, part: 'body' },   // 机身前段
  { x: 0, y: 0.10, z: 1.60, r: 1.25, part: 'body' },   // 机身后段
  { x: 0, y: 0.45, z: 3.20, r: 0.50, part: 'body' },   // 尾梁（三颗把它接成一条）
  { x: 0, y: 0.45, z: 4.60, r: 0.50, part: 'body' },
  { x: 0, y: 0.45, z: 6.00, r: 0.55, part: 'body' },
  { x: 0.2, y: 1.10, z: 7.00, r: 0.80, part: 'body' }, // 垂尾 + 尾桨
];

let HELI_UID = 0;

export class Heli {
  constructor(game, team, owner, opts = {}) {
    this.game = game; this.team = team; this.owner = owner; this.alive = true;
    this.dumb = !!opts.dumb;
    this.uid = ++HELI_UID;              // 给 HUD 标记当稳定的 key（Heli 没有 netId）
    this.name = '武装直升机';
    this.isHeli = true;                 // 空中目标：不进"地面目标集合"（见 enemiesOf 那条注释）
    this.metal = true;                  // 打中是冒火星不是冒血（js/combat.js:fireHitscan）
    this.t = opts.duration || 45;
    this.maxHp = opts.hp || HELI_ARMOR.hp;
    this.hp = this.maxHp;
    this.smokeT = 0;
    // 是被打下来的还是到点离场 —— 联机的"被击落"播报读这一位（server/room.mjs 的 gone 循环）。
    // 少了它的话，45 秒自然离场也会被念成"敌方武装直升机被击落"。
    this.downed = false;
    this.killer = null;
    // ang 是航线的相位。它是**每个实例各自的随机起点**，所以联机下必须由创造它的那一端
    // 决定并广播出去（事件里带 ang）—— 客户端各抽一次的话，两边的直升机不在同一条航线上。
    this.ang = opts.ang !== undefined ? opts.ang : rng.next() * 6;
    this.fireT = 0; this.target = null; this.scanT = 0;
    this.radius = opts.radius || Math.min(28, game.world.half * 0.55);
    this.height = opts.height || 24;
    this.stats = { dmgNear: 26, dmgFar: 22, rangeNear: 30, rangeFar: 80, headMul: 1.2, name: '武装直升机' };
    // 模型二态（性能审查 N2）：权威端只要数值状态（pos/ang/yaw/hp），不建那 40 多个
    // mesh 的机体。update/dispose 对 mesh 的三处引用按 null 门控；客户端的哑副本与单机
    // （game 无 headless 旗）照旧全量建模 —— 画面那一半一行没动。heli 的开火起点本来就是
    // 纯数值（pos.clone().add(...)），不需要 Sentry 那种"留一层 Object3D"的处置。
    if (!game.headless) {
      this.mesh = buildHeli(team === game.player.team ? 0x3a4a3a : 0x2a2a2a);
      this.rotor = this.mesh.userData.rotor; this.tail = this.mesh.userData.tail;
      game.scene.add(this.mesh);
    } else { this.mesh = null; this.rotor = null; this.tail = null; }
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.enter = 1;
    game.audio.loop('heli' + this.ang, 'rotor', 0.0);
    this.loopName = 'heli' + this.ang;
    // 只有**权威的那一个**进实体表：game.entities 是"谁会被子弹与爆炸遍历到"的名单
    // （js/combat.js:traceBullet / explode），放进去即意味着"这一台机器上可以裁决它的血量"。
    // 客户端的哑副本不进 ⇒ 本地子弹从它身上穿过去，血量只由权威端说了算。
    if (!this.dumb) game.entities.push(this);
  }
  // 受击点 / 炸点距离取机身中心：爆炸的溅射算式（js/combat.js:explode）与哨戒机枪的瞄准
  // 读的都是它 —— 直升机没有"胸"这个概念，这里给的就是机体那一点。
  chestPos(o) { return o.copy(this.pos); }
  hitTest(o, d, maxT) {
    if (!this.alive) return null;
    // 只按 yaw 旋。mesh 还有 -0.1 的俯仰和一点点横滚，而命中体不跟着走：那两个量在
    // 7 m 长的机体上偏不到 40 cm，换来的是"命中体不必再依赖 Euler 的叠加顺序"。
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let bt = maxT, bp = null;
    for (const v of HELI_HITBOXES) {
      const wx = this.pos.x + v.x * c + v.z * s;
      const wy = this.pos.y + v.y;
      const wz = this.pos.z - v.x * s + v.z * c;
      const t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, wx, wy, wz, v.r);
      if (t >= 0 && t < bt) { bt = t; bp = v.part; }
    }
    return bp ? { t: bt, part: bp } : null;
  }
  // 唯一的裁决入口。info.part 来自 hitTest（'vital' / 'body'），info.direct 来自 Projectile
  // —— 火箭的**弹体自己撞上了**它，而不是在附近炸开（js/combat.js:explode 转发那一位）。
  takeDamage(d, info = {}) {
    if (!this.alive) return false;
    let dmg;
    if (info.direct) {
      // RPG-7 直击。从这里才谈得上"PVP 有解"：一个 7 连杀的空中炮台不该被一发乱扔的手雷
      // 掀掉，但它该怕一发打准的火箭 —— 要害一发即毁，非要害一次打掉八成。
      if (info.part === 'vital') { this.hp = 0; return this.destroy(info); }
      dmg = this.maxHp * HELI_ARMOR.rpgBody;
    } else if (info.explosive) dmg = d * HELI_ARMOR.splash;
    else dmg = d * HELI_ARMOR.bullet * (info.part === 'vital' ? HELI_ARMOR.vital : 1);
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; return this.destroy(info); }
    return false;
  }
  destroy(info = {}) {
    if (!this.alive) return true;
    this.alive = false;
    this.downed = true;
    this.killer = info.attacker || null;
    const p = this.pos.clone();
    this.game.effects.explosion(p, 2);
    this.game.audio.explosion(p, 1);
    if (info.attacker && info.attacker.isPlayer) this.game.hud.popup('摧毁武装直升机', '', true);
    this.dispose();
    return true;
  }
  dispose() {
    if (this.mesh) this.game.scene.remove(this.mesh);   // 权威端无模型（性能审查 N2）
    this.game.audio.stopLoop(this.loopName);
    // 从实体表里摘掉：game.entities 是被每发子弹与每次爆炸遍历的表，留着一个已经死了的
    // 直升机不报错（takeDamage 第一行就 return false），只是让这张表每局多攒几架。
    const es = this.game.entities;
    const i = es.indexOf(this);
    if (i >= 0) es.splice(i, 1);
  }
  update(dt) {
    const game = this.game;
    this.t -= dt;
    if (this.t <= 0) { this.alive = false; this.dispose(); return; }
    this.ang += dt * 0.18;
    this.enter = Math.max(0, this.enter - dt * 0.3);
    const r = this.radius + this.enter * 120;
    this.pos.set(Math.cos(this.ang) * r, this.height + this.enter * 20, Math.sin(this.ang) * r);
    if (this.mesh) { this.mesh.position.copy(this.pos); this.rotor.rotation.y += dt * 30; this.tail.rotation.x += dt * 40; }   // 权威端无模型（性能审查 N2）
    const d = game.player ? this.pos.distanceTo(game.camera.position) : 100;
    game.audio.setLoopVol(this.loopName, clamp(0.5 - d / 150, 0.02, 0.5));
    this.scanT -= dt; this.fireT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.5; this.target = null; let bd = 90;
      for (const e of game.entities) {
        if (!e.alive || e.team === this.team || !e.chestPos || e.isHeli) continue;
        if (e.isPlayer && e.hasPerk('coldblooded')) continue;
        const c = e.chestPos(new THREE.Vector3());
        const dd = c.distanceTo(this.pos);
        if (dd > bd || game.world.lineBlocked(this.pos, c)) continue;
        bd = dd; this.target = e;
      }
    }
    let look = this.ang + Math.PI;
    if (this.target && this.target.alive) {
      const c = this.target.chestPos(new THREE.Vector3());
      look = Math.atan2(-(c.x - this.pos.x), -(c.z - this.pos.z));
      if (this.fireT <= 0 && this.enter <= 0) {
        this.fireT = 0.09;
        const dir = spreadDir(c.clone().sub(this.pos).normalize(), 2.6 * DEG, new THREE.Vector3());
        const muzzle = this.pos.clone().add(new THREE.Vector3(0, -1, 0));
        game.audio.shot('turret', this.pos);
        // 客户端的表现副本：曳光打到"我本地看到的那个人"身上就够，不裁决伤害
        if (this.dumb) { game.effects.tracer(muzzle, c.clone(), [2, 1.3, 0.5]); return; }
        const shooter = { team: this.team, isPlayer: false, name: '武装直升机', kills: undefined, alive: true };
        const res = fireHitscan(game, this.owner && this.owner.isPlayer ? this.owner : shooter, muzzle, dir, this.stats, '武装直升机');
        game.effects.tracer(muzzle, res.point, [2, 1.3, 0.5]);
        if (res.ent && this.owner && this.owner.isPlayer) game.hud.hitmarker(res.killed);
      }
    } else look = this.ang + Math.PI;
    if (this.mesh) {           // 权威端无模型（性能审查 N2）；yaw 那一行在门外面，永不被跳过
      this.mesh.rotation.y = look;
      this.mesh.rotation.z = Math.sin(this.ang * 3) * 0.05;
      this.mesh.rotation.x = -0.1;
    }
    // 命中体跟着机头转（HELI_HITBOXES 是局部坐标），所以 yaw 必须在这儿落地 ——
    // 漏了这一行的话，命中体永远停在 yaw=0，直升机看上去朝着东、实际能被从北边打穿。
    this.yaw = look;
    // 冒烟 / 起火：血量越低越凶。它是场上**唯一**的"它快掉了"信号 —— 直升机在 24 m 高空、
    // 每发子弹只掉几点血，没有这一缕烟的话没人知道自己在不在有效输出。（单机侧血量就是
    // 本机算的；联机的哑副本不掉血 ⇒ 这条警告目前只在单机看得到，见 docs/net-vs-local-gaps.md。）
    if (this.hp < this.maxHp * 0.7) {
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        const frac = this.hp / this.maxHp;
        this.smokeT = 0.03 + 0.05 * frac;
        game.effects.smoke.emit({
          x: this.pos.x, y: this.pos.y, z: this.pos.z,
          vx: -Math.cos(this.yaw) * 2, vy: -1.5, vz: -Math.sin(this.yaw) * 2,
          drag: 1, life: 1.4, s0: 0.6, s1: 2.4, c0: [0.22, 0.22, 0.22], a0: 0.5,
        });
        if (frac < 0.3) game.effects.add.emit({ x: this.pos.x, y: this.pos.y - 0.6, z: this.pos.z, vx: 0, vy: 0.5, vz: 0, life: 0.4, s0: 0.6, s1: 2.2, c0: [6, 2.4, 0.4], a0: 1 });
      }
    }
  }
}

export function buildHeli(color = 0x3a4a3a) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.4 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.2, 3.2, 6, 12).rotateX(Math.PI / 2), paint); g.add(body);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 10), mat('windowDark')); nose.position.set(0, 0.2, -2.2); nose.scale.set(0.9, 0.8, 0.8); g.add(nose);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 5.5, 8).rotateX(Math.PI / 2), paint); boom.position.set(0, 0.4, 4.6); g.add(boom);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.6, 1), paint); fin.position.set(0, 1.1, 7.1); g.add(fin);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 8), mat('darkMetal')); mast.position.y = 1.5; g.add(mast);
  const rotor = new THREE.Group(); rotor.position.y = 1.8; g.add(rotor);
  for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 7.5), mat('darkMetal')); b.rotation.y = i * Math.PI / 4 * 2 / 2 + i * Math.PI / 4; b.position.z = 0; rotor.add(b); }
  const tail = new THREE.Group(); tail.position.set(0.2, 1.2, 7.1); g.add(tail);
  for (let i = 0; i < 2; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.15), mat('darkMetal')); b.rotation.x = i * Math.PI / 2; tail.add(b); }
  for (const x of [-0.9, 0.9]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 3), mat('darkMetal')); s.position.set(x, -1.35, 0); g.add(s); const st = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.06), mat('darkMetal')); st.position.set(x, -1.15, 0); g.add(st); }
  for (const x of [-1.3, 1.3]) { const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.2, 8).rotateX(Math.PI / 2), mat('darkMetal')); pod.position.set(x, -0.3, -0.3); g.add(pod); }
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.3, 0.3) })); light.position.set(0, -1.2, 0); g.add(light);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.userData = { rotor, tail };
  return g;
}
