// 两个真浏览器窗口打一把 —— 客户端联机层的验收。
//
// 判据不是"页面没报错"，而是**跨窗口读到的同一个物理量必须一致**：
//   · 甲自己看到的权威位置 == 乙眼里甲的位置（插值延迟内）
//   · 乙开火之后，甲的血真的掉了（服务端裁决的命中，不是本地特效）
//   · 回滚窗口在真浏览器里够用（journalMiss == 0）、预测偏差在厘米级
// 这三条在 server/net-probe.mjs 里只有前半个（裸 WebSocket 版本），这里补上
// "浏览器里那份 sim + 那套输入总线 + 那个插值渲染"确实接上了的实证。
//
//   node test/net-play.mjs          自己起临时服务，不需要事先手起 8080
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

let BASE = '';                      // 由 withServer() 填：测试自己起的服务才是被测代码的那一份
const ROOM = 'play-' + Date.now().toString(36);
// 三个 disable 不是可选的：第一次跑这个测试时，后台那个窗口 0.5 秒只推进了 8 拍
// （≈16Hz 模拟），于是"预测偏差"那条量的其实是渲染器产能而不是预测。
// 客户端一慢，服务端就得替它空跑几拍，那种红是假红。
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

const checks = [];
const ok = (label, cond, extra = '') => { checks.push([!!cond, label, extra]); console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  | ' + extra : ''}`); return !!cond; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function launch() {
  for (const [label, opts] of [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }]]) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ` + e.message.split('\n')[0]); }
  }
  throw new Error('没有可用浏览器');
}

async function openPage(browser, name, team) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  // 软渲染跑不动高画质，而这里要测的是网络不是 GPU：低画质关掉 bloom，把帧率还给判据
  await page.addInitScript(() => {
    localStorage.setItem('mf_settings', JSON.stringify({ sens: 1.0, adsSens: 0.9, fov: 78, quality: 'low', volume: 0, voice: false, invertY: false, showFps: false, fixedStep: true }));
    window.addEventListener('error', e => { (window.__bootErr = window.__bootErr || []).push(String(e.message)); });
  });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => logs.push('pageerror: ' + (e.stack || e.message)));
  page.on('response', r => { if (r.status() >= 400) logs.push(`HTTP ${r.status()} ${r.url()}`); });
  // ── name 走 URL，它必须是**一个合法的呼号**（白名单 2~16 个字）──
  // 这一份跑在访客可玩的服上（GUEST），那条路上呼号没有会话可依、只能用自报的这个，
  // 于是服务端会拿注册用的同一个白名单去验它，不合法就**拒绝进场**（不是悄悄改成"访客"）。
  // 所以这里不能再写 '甲'：单字会被拒，而症状是"两个窗口都拿不到 cid" —— 看起来像网络坏了。
  // 第一版就是这么红的，红的是量具不是被测对象。
  await page.goto(`${BASE}?online=1&room=${ROOM}&name=${encodeURIComponent(name)}&team=${team}`, { waitUntil: 'domcontentloaded' });
  return { page, logs };
}
// 每个交互前把窗口带到前台：后台标签页的 rAF 会被降频，而降频会直接改变下面的读数
const focus = async (p) => { await p.page.bringToFront(); await sleep(150); };

// 这些用例量的是**游戏层**（预测回滚、命中裁决、联机规则），所以刻意用访客身份跑
// （REQUIRE_ACCOUNT=0）。账号与两道闸门由 test/hardening.mjs 专门量，两边不重复 ——
// 而在这里再登一次录只会让每个用例都多一个和被测对象无关的失败面。
// 不显式写这一条的话，服务端默认要求登录，下面全都会在"连不上"上红，看起来像网络问题。
const GUEST = { REQUIRE_ACCOUNT: '0' };
const srv = await withServer(GUEST);
BASE = srv.base + '/index.html';
const browser = await launch();
let code = 0;
try {
  const A = await openPage(browser, '甲兵', 'A');
  const B = await openPage(browser, '乙兵', 'B');

  // ---- 先决断言：两边都真的进了对局并拿到 cid。做不到就把控制台倒出来直接红 ----
  const boot = async (p) => {
    for (let i = 0; i < 120; i++) {
      const s = await p.page.evaluate(() => {
        const g = window.game;
        return g ? { state: g.state, hasNet: !!g.net, cid: g.net && g.net.cid, snaps: g.net && g.net.snaps, pl: !!g.player, err: window.__bootErr || null } : null;
      }).catch(e => ({ evalErr: String(e).slice(0, 120) }));
      if (s && s.state === 'play' && s.cid) return s;
      await sleep(250);
    }
    return await p.page.evaluate(() => ({ timeout: true, state: window.game && window.game.state, hasNet: !!(window.game && window.game.net), snaps: window.game && window.game.net && window.game.net.snaps }));
  };
  const [sa, sb] = [await boot(A), await boot(B)];
  console.log('\n── 入场 ──');
  ok('甲进入对局并拿到 cid', sa && sa.state === 'play' && sa.cid, JSON.stringify(sa));
  ok('乙进入对局并拿到 cid', sb && sb.state === 'play' && sb.cid, JSON.stringify(sb));
  if (!(sa && sa.cid && sb && sb.cid)) {
    console.log('\n甲控制台:\n' + A.logs.slice(-12).join('\n'));
    console.log('\n乙控制台:\n' + B.logs.slice(-12).join('\n'));
    ok('两窗口都起得来（后面的判据全依赖这一条）', false);
    throw new Error('入场失败');
  }
  // 入场那一瞬可能还没轮到第一包下行，等一个窗口再读 —— 拿握手那一刻的计数当判据是竞态
  await sleep(500);
  const snaps = async (p) => p.page.evaluate(() => window.game.net.snaps);
  const [nsa, nsb] = [await snaps(A), await snaps(B)];
  ok('双方都收到了下行快照', nsa > 2 && nsb > 2, `甲 ${nsa} 包 / 乙 ${nsb} 包`);
  // 量具自身的先决断言：客户端节拍不够 55Hz 时，服务端就得替它空跑几拍，
  // 下面"预测偏差在厘米级"那条量的就不再是预测而是渲染器产能 —— 那种红是假红。
  const rate = async (p, tag) => {
    await focus(p);
    const t0 = await p.page.evaluate(() => window.game.tick);
    await sleep(1000);
    const t1 = await p.page.evaluate(() => window.game.tick);
    const hz = t1 - t0;
    console.log(`  ${tag} 模拟节拍 ${hz} Hz · 快照 ${(await p.page.evaluate(() => window.game.net.snaps))} 包`);
    return hz;
  };
  const hzA = await rate(A, '甲'), hzB = await rate(B, '乙');
  ok('两个窗口的模拟节拍够快（≥50Hz），后面的厘米级容差才有意义', hzA >= 50 && hzB >= 50, `甲 ${hzA}Hz / 乙 ${hzB}Hz`);
  const seenOther = await B.page.evaluate(cid => !!(window.game.net.roster.get(cid) || window.game.net.remotes.get(cid)), sa.cid);
  ok('乙的 roster 里认得甲', seenOther);

  // ---- 移动：甲按住 W 一秒，乙必须看到同一个人走到同一个位置 ----
  console.log('\n── 移动复制 ──');
  await focus(A);
  const walk = await A.page.evaluate(async () => {
    const g = window.game, me = () => g.net.mySnapshot;
    while (!me()) await new Promise(r => setTimeout(r, 50));            // 先决：等到第一份权威读数
    const p0 = me();
    g.input.keys.KeyW = true;
    await new Promise(r => setTimeout(r, 1000));
    g.input.keys.KeyW = false;
    await new Promise(r => setTimeout(r, 300));
    const p1 = me();
    return { x0: p0.x, z0: p0.z, x1: p1.x, z1: p1.z, dist: Math.hypot(p1.x - p0.x, p1.z - p0.z), ack: p1.ack, snaps: g.net.snaps };
  });
  ok('服务端把甲按输入推动了', walk.dist > 2.0, `1 秒位移 ${walk.dist.toFixed(2)} m（满速 4.7 m/s）`);
  const viewed = await B.page.evaluate(() => {
    const g = window.game, cid = [...g.net.remotes.keys()][0], r = g.net.remotes.get(cid);
    const raw = g.net.lastSnap && g.net.lastSnap.entities.find(e => e.id === cid);
    return r ? {
      rendered: [r.pos.x, r.pos.z], raw: raw ? [raw.x, raw.z] : null, snaps: g.net.snaps,
      tick: g.net.lastSnap && g.net.lastSnap.tick,
      // 直接把插值原料倒出来：分不清"没数据"还是"算错了"的时候，看 buf
      buf: r.buf.map(s => [+(s.t - performance.now() / 1000).toFixed(3), +s.s.x.toFixed(2), +s.s.z.toFixed(2)]),
      now: +performance.now().toFixed(0), frameUpdate: typeof g.net.frameUpdate, drives: r.drives || 0,
    } : null;
  });
  const aTick = await A.page.evaluate(() => ({ snapTick: window.game.net.serverTick, ticks: window.game.tick }));
  const why = viewed ? '' : await B.page.evaluate(() => {
    const n = window.game.net;
    return `remotes=[${[...n.remotes.keys()]}] roster=[${[...n.roster.keys()]}] 最新包实体=[${(n.lastSnap || { entities: [] }).entities.map(e => e.id)}] cid=${n.cid}`;
  });
  ok('乙那边给甲建了远端实体', !!viewed, why);
  if (viewed) {
    const dRaw = Math.hypot(viewed.raw[0] - walk.x1, viewed.raw[1] - walk.z1);
    const dRen = Math.hypot(viewed.rendered[0] - walk.x1, viewed.rendered[1] - walk.z1);
    ok('两份下行对同一个人的读数一致（同一次广播）', dRaw < 0.15, `原始记录差 ${dRaw.toFixed(3)} m`);
    ok('乙眼里甲的渲染位置落在插值延迟内', dRen < 0.8, `渲染位置差 ${dRen.toFixed(3)} m（延迟 0.10s × 4.7 m/s ≈ 0.47 m）`);
  }

  // ---- 命中：乙追着甲打，甲的血必须由服务端掉下来 ----
  // 转向必须走 mdx（鼠标位移那条真路）：服务端不吃"我这边算好的 yaw"，它只把自己收到的
  // mdx 累到自己的 yaw 上。直接写 pl.yaw 的话，浏览器里瞄上了、服务端那边还朝着别处，
  // 测的就不是命中判定而是"我改了自己的状态" —— 那是一条永远不会红的假判据。
  console.log('\n── 跨窗口命中 ──');
  // 两边都去追打对方：出生点相距 50 多米、中间有房子，单向追人时射手会走进墙里，
  // 于是"视线被挡"占满所有帧、一发都没开出去（第一版就是这么红的）。
  const HUNT = async () => {
    const g = window.game;
    const sens = g.settings.sens * 0.0022;                     // player.js 里非开镜时的换算
    const _a = g.player.pos.clone(), _b = g.player.pos.clone(), _f = g.player.pos.clone();
    const deadline = performance.now() + 25000;
    const H = g.__hunt = { frames: 0, firing: 0, dist: 99, blocked: 0, stuck: 0, hp0: null, converged: 0, minDist: 99, hitEnt: 0, wallBlock: 0, flewPast: 0, lastWallT: null, lastEntT: null, lastEntId: null };
    while (performance.now() < deadline) {
      const r = [...g.net.remotes.values()][0], me = g.player;
      if (!r || !me.alive) { await new Promise(x => setTimeout(x, 16)); continue; }
      const dx = r.pos.x - me.pos.x, dz = r.pos.z - me.pos.z, d = Math.hypot(dx, dz);
      H.dist = d; H.minDist = Math.min(H.minDist, d); H.frames++;
      let err = Math.atan2(-dx, -dz) - me.yaw;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const wantPitch = Math.atan2((r.pos.y + 1.3) - (me.pos.y + 1.5), d);
      g.input.mdx = -err / sens * 0.6;                          // yaw -= mdx*sens ⇒ 喂 -err 才是收敛
      // pitch -= mdy*sens，符号和 yaw 相反：写成 -(...) 会正反馈顶到 ±1.5 的钳位，
      // 第一版就是栽在这里 —— 弹道 dir.y = 1.0，61 发全朝天，而报表只说"没打中"。
      g.input.mdy = (me.pitch - wantPitch) / sens * 0.6;
      _a.set(me.pos.x, me.pos.y + 1.5, me.pos.z);
      _b.set(r.pos.x, r.pos.y + 1.15, r.pos.z);
      const clear = !g.world.lineBlocked(_a, _b);
      if (!clear) H.blocked++;
      if (Math.abs(err) < 0.03) H.converged++;
      me.forward(_f);                                           // 正前方有没有墙：有就侧移，别把自己顶进几何体
      const ahead = g.world.raycast(_a, _f, 1.0);
      if (ahead) H.stuck++;
      g.input.keys.KeyW = d > 5 && !ahead;
      g.input.keys.KeyD = !!ahead;
      g.input.buttons = (d <= 10 && clear && Math.abs(err) < 0.06) ? 1 : 0;
      if (g.input.buttons) {
        H.firing++;
        // 这一帧的射线到底撞上了什么：把"打不中"拆成三种，否则报表上它们同形
        const o = me.eyePoint(me.pos.clone()), dir = me.aimDir(me.pos.clone());
        let best = { t: 400, id: null };
        for (const e of g.entities) {
          if (e === me || !e.alive || e.team === me.team) continue;
          const h = e.hitTest(o, dir, best.t);
          if (h && h.t < best.t) best = { t: h.t, id: e.id ?? e.name, part: h.part };
        }
        const wh = g.world.raycast(o, dir, 400);
        if (best.id != null && (!wh || best.t < wh.t)) H.hitEnt++;
        else if (wh) { H.wallBlock++; H.lastWallT = +wh.t.toFixed(2); }
        else { H.flewPast++; H.lastEntT = +best.t.toFixed(2); H.lastEntId = best.id; }
        // 最后一发的现场：射线本身 + 场上所有实体的位置/阵营/存活
        H.trace = {
          o: [+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2)],
          dir: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)],
          ents: g.entities.map(e => ({ id: e.id ?? 'me', team: e.team, alive: e.alive, p: [+e.pos.x.toFixed(2), +e.pos.y.toFixed(2), +e.pos.z.toFixed(2)] })),
        };
      }
      if (H.hp0 === null) H.hp0 = (g.net.mySnapshot || {}).hp;
      if (H.firing > 60) break;                                 // 稳定命中窗口打够 60 帧
      await new Promise(x => setTimeout(x, 16));
    }
    g.input.buttons = 0; g.input.keys.KeyW = false; g.input.keys.KeyD = false;
    g.input.mdx = 0; g.input.mdy = 0;
    H.hits = g.player.stats.hits;
    return H;
  };
  const [hA, hB] = await Promise.all([A.page.evaluate(HUNT), B.page.evaluate(HUNT)]);
  const hpA = await A.page.evaluate(() => {
    const g = window.game, s = g.net.mySnapshot;
    return {
      hp: s.hp, hpMin: g.net.hpMin, localHp: g.player.hp, name: g.net.name, cid: g.net.cid,
      // 三个数把"没打中"分成三类：本地根本没开火 / 服务端没收到开火 / 收到了但射线没撞上人
      shots: g.player.stats.shots, magLocal: g.player.ws.w ? g.player.ws.w.mag : -1,
      magSrv: s.mag, remotes: [...g.net.remotes.keys()], entInSnap: (g.net.lastSnap || { entities: [] }).entities.map(e => e.id),
    };
  });
  const hpB = await B.page.evaluate(() => {
    const g = window.game, s = g.net.mySnapshot;
    return { hp: s.hp, hpMin: g.net.hpMin, localHp: g.player.hp, name: g.net.name, cid: g.net.cid, shots: g.player.stats.shots, magLocal: g.player.ws.w ? g.player.ws.w.mag : -1, magSrv: s.mag, remotes: [...g.net.remotes.keys()], entInSnap: (g.net.lastSnap || { entities: [] }).entities.map(e => e.id) };
  });
  const evs = await A.page.evaluate(() => window.game.net.events.filter(e => e.e === 'kill').map(e => `${e.killer}→${e.victim}(${e.weapon}${e.head ? ',爆头' : ''})`));
  const fmt = (t, H) => `${t}：最近 ${H.minDist.toFixed(1)} m · 对准 ${H.converged}/${H.frames} · 被挡 ${H.blocked} · 顶墙 ${H.stuck} · 开火 ${H.firing}`
    + `\n      这一枪撞上了什么：人 ${H.hitEnt} · 墙 ${H.wallBlock}(最近墙距 ${H.lastWallT}) · 飞过去 ${H.flewPast}(靶距 ${H.lastEntT} 靶=${H.lastEntId}) · 本地命中计数 ${H.hits}`;
  console.log('  ' + fmt('甲', hA));
  console.log('  ' + fmt('乙', hB));
  console.log('      甲最后一发：' + JSON.stringify(hA.trace));
  console.log('      乙最后一发：' + JSON.stringify(hB.trace));
  const dbg = (t, x) => `${t}：本地 shots=${x.shots} 弹匣 本地${x.magLocal}/权威${x.magSrv} hp 本地${x.localHp.toFixed(0)}/权威${x.hp.toFixed(0)} 远端=[${x.remotes}] 快照里的实体=[${x.entInSnap}]`;
  console.log('  ' + dbg('甲', hpA));
  console.log('  ' + dbg('乙', hpB));
  const fired = Math.max(hA.firing, hB.firing);
  const hurt = Math.min(hpA.hpMin, hpB.hpMin);   // 用“权威侧见过的最低血”：瞬时读数会被重生洗回 100
  ok('有人真的把对面的血打掉了（服务端裁决的跨窗口命中）', fired > 10 && hurt < 100,
    `开火最多的一边 ${fired} 帧 · 甲权威最低 hp=${hpA.hpMin} · 乙权威最低 hp=${hpB.hpMin} · 播报 ${JSON.stringify(evs)}`);
  ok('掉血的人自己也看到掉血（预测被权威校正拉回）', Math.min(hpA.hpMin, hpB.hpMin) < 100,
    `甲权威最低 ${hpA.hpMin} · 乙权威最低 ${hpB.hpMin}`);

  // ---- 死亡与重生：服务端 3 秒后把人放回出生点，客户端必须真的回到"活着"这个读数 ----
  // 判据要的是正面读数（化身在 + 权威 hp 回到 100 + 重生事件计数），不是"没报错"：
  // 人提前消失时这些数同样看着正常，只有事件计数不会骗人。
  console.log('\n── 死亡与重生 ──');
  const died = hpA.hp === 0 || hpB.hp === 0 || evs.length > 0;
  ok('这一把里真的有人被服务端判死', died, `播报 ${JSON.stringify(evs)}`);

  // ---- 差距 31 / 32 的另一半：面板真的画出来了吗 ----
  // test/net-feel.mjs 的 Q 段只量得到"kill 事件转给了上层"（NetClient 那一跳）——
  // 它量不到面板，因为 js/main.js 既不导出 Game、构造它又要 WebGL。玩家真正看得见的
  // 那一半（killfeed 那一行、死亡画面、"被 X 使用 Y 击杀"）只能在这里量。
  // 反证臂：`git stash push -- js/main.js` 退掉那一组回调再跑，下面三条必须变红
  // （没有 onNetKill/onNetDeath ⇒ killfeed 永远空、死亡画面永远不显示）。
  const uiOf = (p) => p.page.evaluate(() => {
    const kf = document.getElementById('killfeed');
    const ds = document.getElementById('deathScreen');
    return {
      rows: kf ? kf.children.length : -1,
      feed: kf ? kf.textContent.replace(/\s+/g, ' ').trim() : '',
      dead: !!(ds && !ds.classList.contains('hidden')),
      info: (document.getElementById('killerInfo') || {}).textContent || '',
    };
  });
  // killfeed 那一条 6 秒后自己删、死亡画面在 3 秒重生时收起来 ⇒ 这里**轮询采样**而不是读一次：
  // 单点读数有可能正好落在两者之间，那会做成一条时红时绿的判据（而这个仓库里"偶发红"
  // 的下场是被当成噪声忽略掉）。
  let uiA = await uiOf(A), uiB = await uiOf(B), sawScreen = false;
  for (let i = 0; i < 25; i++) {
    if (uiA.dead || uiB.dead) sawScreen = true;
    if ((uiA.rows >= 1 || uiB.rows >= 1) && sawScreen) break;
    await sleep(100);
    uiA = await uiOf(A); uiB = await uiOf(B);
  }
  console.log(`  甲面板：killfeed ${uiA.rows} 行「${uiA.feed}」· 死亡画面 ${uiA.dead} · killerInfo「${uiA.info}」`);
  console.log(`  乙面板：killfeed ${uiB.rows} 行「${uiB.feed}」· 死亡画面 ${uiB.dead} · killerInfo「${uiB.info}」`);
  // 判据钉**结构**不钉措辞：只要那一行里出现了这两个呼号之一，就说明画的是这一把的那次击杀
  // （钉"→"或"击杀"这类字眼会在下次改文案时假红）。
  const feedText = (uiA.feed + ' ' + uiB.feed).trim();
  ok('killfeed 画出了那一行、且写着这两个人（差距 31）',
    (uiA.rows >= 1 || uiB.rows >= 1) && [hpA.name, hpB.name].some(n => n && feedText.includes(n)),
    `「${feedText}」`);
  // killerInfo 在重生时**不会**被清（只清 respawnText），所以这一条不受 3 秒窗口影响。
  const infoText = (uiA.info + ' ' + uiB.info).trim();
  ok('死亡画面把击杀者填上了（差距 32）',
    infoText.length > 0 && [hpA.name, hpB.name].some(n => n && infoText.includes(n)),
    `「${infoText}」`);
  ok('死亡画面在被打死的当下真的显示过（3 秒重生时才收起来）', sawScreen,
    `采样末值 甲 dead=${uiA.dead} · 乙 dead=${uiB.dead}`);

  await sleep(4500);
  const after = async (p) => p.page.evaluate(() => {
    const g = window.game, s = g.net.mySnapshot;
    return { respawnSnaps: g.net.respawnSnaps || 0, hp: s.hp, alive: !!(s.flags & 1), localAlive: g.player.alive, localHp: g.player.hp };
  });
  const [ra, rb] = [await after(A), await after(B)];
  console.log(`  甲：重生事件 ${ra.respawnSnaps} · 权威 hp=${ra.hp} alive=${ra.alive} · 本地 hp=${ra.localHp.toFixed(0)} alive=${ra.localAlive}`);
  console.log(`  乙：重生事件 ${rb.respawnSnaps} · 权威 hp=${rb.hp} alive=${rb.alive} · 本地 hp=${rb.localHp.toFixed(0)} alive=${rb.localAlive}`);
  ok('被打死的人由服务端放回出生点并恢复满血', (ra.respawnSnaps + rb.respawnSnaps) > 0,
    `重生事件 甲${ra.respawnSnaps} / 乙${rb.respawnSnaps}`);
  ok('重生的人自己这边也回到"活着"（本地与权威同时成立）',
    (ra.respawnSnaps > 0 ? (ra.alive && ra.localAlive && ra.localHp === 100) : true) && (rb.respawnSnaps > 0 ? (rb.alive && rb.localAlive && rb.localHp === 100) : true),
    `甲 ${JSON.stringify(ra)} 乙 ${JSON.stringify(rb)}`);

  // ---- 回滚机制在真浏览器里的读数 ----
  console.log('\n── 本地预测质量 ──');
  const q = await A.page.evaluate(() => {
    const n = window.game.net;
    return { reconciles: n.reconciles || 0, replayed: n.replayed || 0, correctedMax: n.correctedMax || 0, steadyMax: n.steadyMax || 0, otherMax: n.otherMax || 0, starved: n.starved || 0, steadyN: n.steadyN || 0, aliveFlips: n.aliveFlips || 0, journalMisses: n.journalMisses || 0, caughtUp: n.caughtUp || 0, repN: n.repN || 0, repMax: n.repMax || 0, repsApplied: n.repsApplied || 0, repSkipped: n.repSkipped || 0, repForgotten: n.repForgotten || 0, qDrops: n.qDrops || 0, dupTicks: n.dupTicks || 0, repSkipWhy: n.repSkipWhy || [], missWhy: n.missWhy || [], snaps: n.snaps, ticks: window.game.tick, pair: n.pairProbe || null, worst: n.steadyWorst || [], flagMismatch: n.flagMismatch || 0, flagMismatchWhy: n.flagMismatchWhy || null, repUnder: n.repUnder || 0, repUnderMax: n.repUnderMax || 0, repUnderWhy: n.repUnderWhy || [],
      // 首段空跑（rep 报不出来的那几拍）的补偿读数：补了几包、共几拍、以及残差超尺子的现场
      carryN: n.carryN || 0, carryLead: n.carryLead || 0, carryMiss: n.carryMiss || 0, carryWhy: n.carryWhy || [],
      foldN: n.foldN || 0, foldMax: n.foldMax || 0, foldBad: n.foldBad || 0, foldWhy: n.foldWhy || [] };
  });
  ok('每一拍快照都做了回滚重放', q.reconciles > 20, `${q.reconciles} 次 / ${q.snaps} 包快照`);
  // rep 通路的"有牙齿"断言：这一包报了重复拍 ⇔ 服务端比我供得快（饥饿）。
  // 两边同真同假是构造出来的：最后一步从队列取到东西 ⇒ rep 归零且 ack 也前进；
  // 最后一步取不到 ⇒ rep+1 且 ack 不动 ⇒ Δtick > Δack。所以这不是经验阈值而是恒等式，
  // 哪一头接错线（服务端没记账、解码错位、饥饿判据写歪）都会立刻不等。
  // 刻意不写成"repN > 0"：机器够快时真可以一次都不饿，那会在好机器上报假红。
  ok('rep 与饥饿同真同假（重复拍记账接到了线）', (q.starved > 0) === (q.repN > 0),
    `饥饿 ${q.starved} 包 · 报重复拍 ${q.repN} 包（单次最多 ${q.repMax} 拍）· 客户端补演 ${q.repsApplied} 拍 · 补不全的包 ${q.repSkipped}`);
  // 每一次"服务端报了 N 拍而我没补满 N 拍"都必须落在两种说得出的情形上：
  // 这一包是生死硬拉（不回滚，rep 无处可补）、或那份 hold 输入已被历史窗口挤掉。
  // 客户端自己设的成本上限以前是 120，撞上限就是一种**静默少补** —— 少补的每一拍都会
  // 原样变成一次校正位移，而它在这个名单上不留痕迹（现在上限跟服务端的 255 对齐了）。
  ok('没有"静默少补"：每次没补满都归得因（硬拉 / hold 已被窗口挤掉）',
    (q.repSkipWhy || []).every(s => s.hard || !s.hold), JSON.stringify((q.repSkipWhy || []).slice(0, 2)));
  ok('回滚窗口够用（journalMiss == 0）', q.journalMisses === 0, `退化硬拉 ${q.journalMisses} 次 · 末次回演 ${q.replayed} 拍`);
  if (q.missWhy.length) {
    const by = {};
    for (const m of q.missWhy) by[m.why] = (by[m.why] || 0) + 1;
    console.log(`  空窗成因：${JSON.stringify(by)}  末次 ${JSON.stringify(q.missWhy[q.missWhy.length - 1])}`);
  }
  const wA = await A.page.evaluate(() => ({ local: window.game.player.ws.w.id, srv: window.game.net.srvWeapon, mag: [window.game.player.ws.w.mag, window.game.net.mySnapshot.mag] }));
  ok('服务端用的就是我这套装备（武器一致）', wA.local === wA.srv, `本地 ${wA.local} · 权威 ${wA.srv}`);
  // 先决：被计入稳态的样本数必须够多。排除项（饥饿/重生/生死翻转/入场）一旦把样本
  // 吃光，下面那条就变成永远绿的空断言 —— 所以population本身要断言。
  ok('稳态样本够多（排除项没把总体吃光）', q.steadyN > 300, `稳态 ${q.steadyN} 包 / 共 ${q.reconciles} 包；饥饿 ${q.starved} · 生死翻转 ${q.aliveFlips}`);
  ok('稳态预测与权威端同刻偏差在厘米级', q.steadyMax < 0.12,
    `稳态最大 ${q.steadyMax.toFixed(4)} m（样本 ${q.steadyN}）· 排除项最大 ${q.otherMax.toFixed(3)} m · 饥饿 ${q.starved} · 生死翻转 ${q.aliveFlips}`);
  ok('基态旗标与权威端一致（rep=0 的稳态包：同一时刻两端状态同源）', q.flagMismatch === 0,
    `失步 ${q.flagMismatch} 次 / 稳态 ${q.steadyN} 包${q.flagMismatchWhy ? ` · 首次 ${JSON.stringify(q.flagMismatchWhy)}` : ''}（编码表与取值方式两边已对齐：Crouch 取 crouchT>0.5，不是同名布尔）`);
  // 折叠拍记账的**形状**判据，不是"有没有"判据。Δtick>Δack 而 rep=0 的窗确实存在：
  // 服务端是"先折叠几拍、再消费新输入"，而 rep 按定义只能报"ack 之后的末尾连拍"，
  // 所以那几拍折叠的位置我这边补不回来（客户端现在靠 Δtick/Δack 自己算 deficit 并重演，
  // 机制见 js/net/predict.mjs 的 opts.carry；下面还有一条专门量它的残差）。
  // 这里要拦的不是它，而是它**变成每份快照都欠一遍**那种会永久累积的错 —— 那是把 rep
  // 改成"自上次广播累计"时真发生过的事故（偏差按 0.2236 m = 一份快照的位移一路涨到 1.56 m）。
  // 判据：单窗缺口不得超过一份快照的拍数（SNAP_EVERY=3）；超了就是在累积，必须红。
  ok('折叠拍缺口是一次性的（单窗 ≤ 一份快照 3 拍），不许随快照累积', q.repUnderMax <= 3,
    `违例 ${q.repUnder} 包 · 单窗最大缺口 ${q.repUnderMax} 拍 · 明细 ${JSON.stringify(q.repUnderWhy)}`);
  // 空跑窗的**量**判据 —— 这一轮的红线就是它。尺子是客户端自己量的（日记本里相邻两拍的距离，
  // 见 client.mjs 的 foldMax/foldWhy），不是"小于某个米数"这种可以随机器抖的阈值。
  // 牙齿在哪：补偿漏掉时残差恰好等于 deficit 拍的位移，deficit ≥ 1 就跨过这把尺子；
  // 而 deficit ≥ 2（实测那一包）是 2 倍尺子，怎么抖都跨得过去。反过来，补偿做到位时
  // 残差只剩量化误差（位置量化 0.23 cm），离尺子差一个量级。
  ok('空跑窗的残差小于"我自己走一拍"（首段空跑被重演掉了，不是丢掉）', (q.foldBad || 0) === 0,
    `空跑窗 ${q.foldN || 0} 个 · 最大残差 ${(q.foldMax || 0).toFixed(4)} m · 超尺子 ${q.foldBad || 0} 个`
    + `${(q.foldWhy || []).length ? ' · 明细 ' + JSON.stringify(q.foldWhy) : ''}`);
  // 该补而没补的，必须留下名字（旧写法在同样的窗里照样记一个 corrected，于是"少补了几拍"
  // 和"预测器算错了"在报表上完全同形）。这条只印不裁：真正裁的是上面那条量判据。
  if (q.carryMiss) console.log(`  ⚠ 未补偿的空跑窗 ${q.carryMiss} 个（用 carry 补了 ${q.carryN || 0} 包 / 共 ${q.carryLead || 0} 拍）· 成因 ${JSON.stringify((q.carryWhy || []).slice(0, 4))}`);
  if (q.worst.length) {
    const top = [...q.worst].sort((a, b) => b.d - a.d).slice(0, 5);
    console.log(`  >8cm 的稳态校正 ${q.worst.length} 次，最大 5 次现场：`);
    for (const w of top) console.log(`    ${w.d} m · 回演${w.replayed}拍/窗${w.win} · Δtick${w.dTick} Δack${w.dAck} · 报重复${w.rep}拍/实补${w.reps}拍${w.qDrop ? ' · 服务端跳拍' : ''} · 在途${w.inflight}拍 · 速度${w.spd}(vy${w.vy},${w.onG ? '地' : '空'}) · 开火${w.fire ? '是' : '否'}\n      基态差分量 Δpos=${JSON.stringify(w.dp)} Δyaw=${w.dYaw}rad Δhp=${w.dHp} 日记本旗标=${w.jFlags} 权威旗标=${w.eFlags}\n      空跑拆分：本窗首段${w.ownLead} 上一窗首段${w.lastOwnLead} · carry 基态(t${w.baseTick}) Δpos=${JSON.stringify(w.dpBase)}
      重演步数：applySteps=${w.applySteps} vs dTick=${w.dTick}（差 ${w.applySteps - w.dTick}，其中上一包 rep=${w.lastRep}）\n      权威端 ${JSON.stringify(w.auth)} · 本地各拍 ${JSON.stringify(w.traj)} · 基态正前方墙距 ${w.wallAhead} m`);
  }
  // 尾部那几个样本要么归因给"服务端在这一包附近对我做了不规则处理"（跳拍、ack 比拍号跑得快），
  // 要么就是物理真的分叉了 —— 这两件事的修法完全相反，所以先把归因比例打出来再决定动哪里。
  // 判据线本身不动：排除项必须由独立测到的服务端事件定义，不能为了让它绿而挪阈值。
  {
    const big = q.worst.filter(w => w.d > 0.12);
    // 归因谓词以前写的是 `w.qDrop || w.dAck > w.dTick` —— 两个项是同一个条件（qDrop 的定义
    // 就是 dAck > dTick），所以它只能抓到"服务端跳过了我的输入"那一头，而**抓不到**它在注释里
    // 点名的另一头：空跑（Δtick > Δack）。于是那一族样本永远显示"不可归因"，看着像物理分叉 ——
    // 这一轮拆掉的那族 0.15 m 就是这么被误判了一轮。正确判据是"服务端这一窗不是一拍一条输入"：
    // Δtick ≠ Δack。两个方向都是**独立测到的**（serverTick 差与 ack 差都直接来自 wire），
    // 不是为了让谁变绿而挪的阈值。
    const attr = big.filter(w => w.dTick !== w.dAck).length;
    if (big.length) console.log(`  >0.12 m（判据线）的归因：${attr}/${big.length} 落在服务端不规则事件（Δtick ≠ Δack：跳拍或空跑）上` +
      ` · 明细 ${JSON.stringify(big.map(w => ({ d: w.d, dTick: w.dTick, dAck: w.dAck, deficit: w.deficit, lead: w.lead, inflight: w.inflight, reps: w.reps })))}`);
  }
  if (q.pair && q.pair.n) {
    const p = q.pair, n = p.n;
    // 这三行是判据的判据：offset 直方图整体偏向 +1 ⇒ 配对错拍（该修 ack 语义），
    // 而 sum0 与 sumBest 接近 ⇒ 每包的最优拍号就是 0，剩下的残差与"错拍"无关。
    console.log(`  拍号探针（全部稳态 ${n} 包）：最优 offset 分布 ${JSON.stringify(p.hist)}`);
    console.log(`    均值：假设 offset=0 的残差 ${(p.sum0 / n).toFixed(4)} m · 每包最优 offset 的残差 ${(p.sumBest / n).toFixed(4)} m · 实际校正 ${(p.sumD / n).toFixed(4)} m`);
    console.log(`    落在 0 / +1 / 其他：${p.nZero} / ${p.nOne} / ${p.nOther}`);
    // 补演 rep 之后，权威读数应该就落在我日记本的第 start 拍上。错拍样本占比是这条
    // 契约的直接读数：修好之前实测 42/434 ≈ 9.7% 落在 +1/+2，且每一格都恰好是一拍的位移。
    // 契约断言是**因果**的，不是量级的：错拍样本必须落在"输入总线出过事"的那一包上
    // （饥饿 / 服务端跳过我的输入 / 重复拍刚归零）。这几个都由 Δtick 与 Δack 的关系直接
    // 判定，所以一旦有一个错拍样本不落在任何队列事件上，那就是配对规则本身有洞 ——
    // 那才是这套机制最难查的错。拿"小于百分之几"当判据只会随机器快慢抖。
    console.log(`    定罪条件"另一拍解释力强一倍"：错拍 ${p.nMis} 包（argmin 非 0 的裸数 ${n - p.nZero}，多数只是量化噪声），其中可归因队列事件 ${p.attributed}，不可归因 ${p.unexplained.length}`);
    ok('配对契约：每一个错拍样本都落在输入总线事件上（否则就是配对规则本身有洞）', p.unexplained.length === 0,
      `不可归因 ${JSON.stringify(p.unexplained.slice(0, 2))}`);
    console.log(`  输入总线读数：饥饿 ${q.starved} 包 · 服务端跳过我的输入 ${q.qDrops} 包 · 漏计重复拍 ${q.repForgotten} · 补不全 ${q.repSkipped} 包 · 首段空跑用 carry 补了 ${q.carryN || 0} 包/${q.carryLead || 0} 拍`);
    // 这一条以前只打印不断言（立过账的缺口）：applySteps = led + reps 必须 == dTick 是
    // predict.mjs 一直声称的恒等式 —— 上一轮就是因为它从没被比过，lastRep 的重复计数
    // 躲过一整轮。单窗链上的版本在 test/reconcile-chain.mjs 的 A2；这里是真浏览器那一半。
    // hit 为假的窗（客户端落后、win 为空）不在此账上 —— 那是 caughtUp 类，client.mjs 的
    // carryStepsBad 已按口径把这两类分开。
    ok('carry 步数一致性：重演步数恰好等于这一窗服务端真跑的拍数（applySteps == dTick）',
      (q.carryStepsBad || 0) === 0,
      `违例 ${q.carryStepsBad || 0} 包 · 现场 ${JSON.stringify((q.carryStepsWhy || []).slice(0, 3))}`);
    // 恒等式：一拍一份输入。同一拍记两遍 ⇒ 回滚多演一步而服务端把第二份当重复包丢掉，
    // 表现出来就是"权威端比我的重建少走一拍"，且 rep 看不出（它没重复）。
    ok('输入总线没把同一拍记两遍（回滚窗口逐拍唯一）', q.dupTicks === 0, `重复记录 ${q.dupTicks} 拍 · 不可归因样本现场 ${JSON.stringify((p.unexplained || [])[0] || null)}`);
    if (q.repSkipWhy.length) console.log(`  补不全的包现场（rep 报了但没补上，看 hold 是否已被窗口挤掉 / 是否撞上限）：${JSON.stringify(q.repSkipWhy.slice(0, 4))}`);
  }
  if (q.pair) {
    // 探针的牙齿：这一条必须在"真配错一拍"时报红。上一版只在 >5cm 时才采样，
    // 于是"每次都错一拍、每次只差 0.078 m"这种系统性偏差正好从门缝里漏掉。
    ok('没有"配错一拍"能解释的大偏差（偏移假设须能解释掉一个量级）', (q.pair.bad || []).length === 0,
      `命中 ${JSON.stringify((q.pair.bad || []).slice(0, 2))}`);
  } else {
    ok('没有"配错一拍"能解释的大偏差（探针未触发，说明没有 >5cm 的稳态校正）', true);
  }
  // ---- 延迟补偿在真浏览器里的读数 ----
  // 这是唯一一处"真 renderTick（受本机帧时序与 INTERP_DELAY 影响）→ 真 codec → 真闸门"的串联。
  // 它错了是**静默**的：服务端把出窗的报值一律拒掉 ⇒ 这个玩家永远没有补偿，不报错、不崩、
  // 只是打不中；而服务端那一侧看上去完全正常。读数从生产那个口子（/healthz）取，
  // 不另外去戳房间对象 —— 要验的就该是上线的那条路。
  console.log('\n── 延迟补偿 ──');
  const hzj = await (await fetch(srv.base + '/healthz')).json();
  const lag = (((hzj.per || []).find(r => r.id === ROOM) || {}).lag) || {};
  const vs = await A.page.evaluate(() => ({ view: window.game.net.viewTick, log: window.game.net.snapLog.length, srvTick: window.game.net.serverTick }));
  console.log(`  服务端记账：裁决 ${lag.shots} 发 · 接受 ${lag.ok}（回溯深度 ${JSON.stringify(lag.depth)} 拍 min/max/avg）`
    + ` · 没报 ${lag.noView} · 出窗被拒 ${lag.stale} · 缓冲查不到 ${lag.poseMiss}`);
  console.log(`  甲这一侧：viewTick=${vs.view} · 快照流水 ${vs.log} 条 · 服务端最新拍号 ${vs.srvTick}`);
  // 阈值取得低（≥8）是有意的：这一臂要证明的是"链路被走过、且报值全部被接受"，
  // 而发数由射速 × 弹匣 × 这一把的交战时长决定（实测两轮 33 / 22 发），拿它当判据线会在
  // 一次短促的交火里报假红。真正有牙齿的是下面那条 stale（它必须恰好为 0）。
  ok('真浏览器里这条链路真的被走过（裁决过，而且真的按历史姿态判的）', (lag.shots || 0) >= 8 && (lag.ok || 0) === (lag.shots || 0) && (lag.ok || 0) > 0, JSON.stringify(lag));
  ok('客户端报的拍号一次都没被闸门拒过（真 renderTick 与服务端拍号同口径）', (lag.stale || 0) === 0,
    `stale=${lag.stale}（唯一合法成因是客户端卡住 >1.2s，那条路在 test/lagcomp.mjs 的 ④ 里量过）`);
  ok('回溯深度是"INTERP_DELAY + 在途"那个量级（不是 0 —— 报当下的症状正是深度为 0）',
    lag.depth && lag.depth[0] >= 1 && lag.depth[1] <= 60 && lag.depth[2] > 3, JSON.stringify(lag.depth));
  ok('姿态缓冲里每一拍都查得到（缓冲不比回溯窗短）', (lag.poseMiss || 0) === 0, `查不到 ${lag.poseMiss} 次`);

  // ---- 联机规则：连杀呼叫那一位真的进了上行协议 ----
  // 这里验的是**协议那一段**（客户端按 3 → 那一个字节 → 服务端裁决），
  // 而不是"生效了没有"：生效的全链路（充能→就绪→呼叫→UAV/空袭/白磷弹/哨戒机枪/
  // 直升机）由 test/mp-rules.mjs 用确定性拍数验 —— 那边能精确控制击杀与拍号，
  // 这里做不到（真对局里攒几杀要看运气）。两处合起来才是完整的一条线。
  console.log('\n── 联机规则 ──');
  const hzr = await (await fetch(srv.base + '/healthz')).json();
  const roomR = (hzr.per || []).find(r => r.id === ROOM) || {};
  const s0 = roomR.streak || {};
  ok('先决：这一节之前还没有人呼叫过连杀奖励（下面的计数不是在空转）', (s0.calls || 0) === 0, JSON.stringify(s0));

  // 客户端拿到的槽位表必须来自服务端。它是"按 3/4/5 各是什么、每个要几杀"的真相 ——
  // 客户端自己按 data.js 那份渲染的话，服务端换一项、HUD 还显示旧的。
  const ss = await A.page.evaluate(() => ({
    defs: (window.game.net.streakDefs || []).map(d => d.id),
    slots: (window.game.net.streakState || []).map(s => ({ id: s.id, cost: s.cost })),
    flags: window.game.net.worldFlags | 0,
  }));
  ok('客户端从 welcome 里拿到了本房的槽位表（HUD 才知道按 3/4/5 是什么）',
    ss.defs.length > 0 && ss.slots.length === ss.defs.length, JSON.stringify(ss.defs));
  ok('成本与服务端一致（uav=3），不是客户端自己猜的', ss.slots[0] && ss.slots[0].id === 'uav' && ss.slots[0].cost === 3, JSON.stringify(ss.slots));
  ok('客户端读到了快照头里的世界标志位（这一格以前在服务端是硬编码 0）',
    Number.isInteger(ss.flags), `flags=${ss.flags}`);

  await focus(A);
  // 按 6 次 3：每一次都是一个**按下沿**（Digit3 只进 pressed 表，只在一拍为真）。
  // 按住不放不会连发 —— 那正是"每拍都看一次 inp.streak"会犯的错，服务端那边
  // 用 fresh（这一拍真的消费到新输入）挡住了。
  for (let i = 0; i < 6; i++) { await A.page.keyboard.press('Digit3'); await sleep(200); }
  await sleep(400);
  const hzr2 = await (await fetch(srv.base + '/healthz')).json();
  const roomR2 = (hzr2.per || []).find(r => r.id === ROOM) || {};
  const s1 = roomR2.streak || {};
  console.log(`  服务端记账：收到呼叫 ${s1.calls} · 接受 ${s1.accepted} · 被拒 ${s1.rejected} ${JSON.stringify(s1.byId || {})}`);
  // 这一条是这一节的核心：按 3 这件事**以前在联机里什么都不做** ——
  // main.js 把 streak 字段填进了输入对象，但那个字段根本不在协议里（codec 只搬
  // keys/buttons），服务端连"有人按了 3"都不知道。calls > 0 就是它接通的凭证。
  ok('按 3 真的走到了服务端（这一位以前根本不在协议里）', (s1.calls || 0) > 0, JSON.stringify(s1));
  // 恒等式而不是阈值：每一次呼叫都必须落在"接受"或"拒绝"里，没有第三种。
  // 它红了说明 callStreak 里有一条分支拿走了请求却没记账（那种洞只会让读数偏低，
  // 而偏低的读数看起来和"没人按"一模一样）。
  ok('每一次呼叫都被裁决过（accepted + rejected == calls，没有"收了不处理"的第三种）',
    (s1.accepted | 0) + (s1.rejected | 0) === (s1.calls | 0), `${s1.accepted} + ${s1.rejected} vs ${s1.calls}`);
  // 反证臂：就绪那一路没有白送。若 accepted > 0，则它必须真的让世界标志位亮起来。
  const uavBits = (roomR2.worldFlags | 0) & 0x12;
  ok('反证：接受了 N 次就必须有 N 次对应的世界变化（没就绪时两位都不亮，就绪了才亮）',
    (s1.accepted | 0) === 0 ? uavBits === 0 : uavBits !== 0,
    `accepted=${s1.accepted} worldFlags=${roomR2.worldFlags}`);

  const frozen = await A.page.evaluate(() => window.game.tick);
  await sleep(500);
  const ticks2 = await A.page.evaluate(() => window.game.tick);
  ok('甲的模拟节拍没停', ticks2 - frozen > 20, `0.5 秒推进 ${ticks2 - frozen} 拍（≈${((ticks2 - frozen) * 2).toFixed(0)}Hz）`);

  await A.page.screenshot({ path: 'test/net-play-A.png' });
  await B.page.screenshot({ path: 'test/net-play-B.png' });
  console.log('\n  截图：test/net-play-A.png  test/net-play-B.png');

  const badLogs = [...A.logs, ...B.logs].filter(l => !/WebGL|AudioContext|pointer lock|autoplay|GPU stall|SwiftShader/i.test(l));
  ok(`控制台没有真错误（渲染/音频告警已忽略，共 ${badLogs.length} 条）`, badLogs.length === 0, badLogs.slice(0, 6).join(' ⏐ '));
} catch (e) {
  console.log('CRASH ' + (e && (e.stack || e.message)));
  code = 2;
} finally {
  await browser.close();
  srv.kill();
}
const fails = checks.filter(c => !c[0]).length;
console.log(`\n${fails ? 'RED' : 'GREEN'}  ${checks.length - fails}/${checks.length} 通过`);
process.exit(code || (fails ? 1 : 0));
