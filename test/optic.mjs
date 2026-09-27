// MRS 红点（以及同类开放式瞄具）的几何判据。
//
// 症状：**ADS 时看到的是一个实心圆柱**，镜片和红点全被挡在后面。
// 成因写在 js/gunmodel.js 的 tgeo 注释里 —— 镜筒用过 cgeo（CylinderGeometry 默认封盖），
// 端盖正好落在"射手眼底 → 镜片"这一段的中间。
//
// 这里每条判据都自带反证臂：只写"通透"那一半的话，把整个瞄具删掉也能全绿。
// O1⁺ 抓"多了东西"（早年那个封盖），O2⁺ 抓"少了东西"（只有 FrontSide 的管壁从膛内整圈被剔除，
// 那比实心更假 —— 看起来像一段不存在的筒）。O5 不看模型看像素，认的是玩家真正看到的东西。
import { chromium } from 'playwright';
import { withServer } from './with-server.mjs';

// GL 参数用 net-drop/net-play 那套（angle + swiftshader 软件渲染）：`--use-gl=swiftshader` 那套
// 在这台机器上会**在页面启动阶段就丢 WebGL 上下文**（2026-09-27 打点：进菜单时 isContextLost
// =true，丢上下文后一切像素判据都是 no-op）。其余测试没暴露这一点，是因为它们把渲染 stub 掉了。
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
async function launch() {
  for (const [label, opts] of [['chrome', { channel: 'chrome', args: ARGS }], ['chromium-1234', { executablePath: 'C:/Users/pyc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', args: ARGS }]]) {
    try { const b = await chromium.launch(opts); console.log(`  浏览器: ${label}`); return b; }
    catch (e) { console.log(`  ${label} 起不来: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('没有可用浏览器');
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console.error] ' + m.text()); });
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.resolve(); }; });
const srv = await withServer();
await page.goto(srv.base + '/index.html');
await page.waitForFunction(() => window.game && window.game.state === 'menu', null, { timeout: 180000 });
// **立刻停掉菜单的渲染循环**：这一页根本不需要看菜单画面，而它每帧都在真渲染（士兵、
// 粒子、枪展 + 后处理）。阶段 A 要在页面里造 50 多把枪模，够它渲几十秒 —— 实测
// swiftshader 的 GPU 进程会在这段时间里丢上下文（2026-09-27 打点：阶段 B 起始 isContextLost
// =true），而丢了之后一切像素判据都是 no-op、症状像"被测对象坏了"。先断电，再干活。
await page.evaluate(() => { window.game.renderer.setAnimationLoop(null); });
const cl = async (tag) => page.evaluate((t) => { (window.__cl ||= []).push(t + '=' + window.game.renderer.getContext().isContextLost()); return window.game.renderer.getContext().isContextLost(); }, tag);
console.log('  ctx 进菜单后 lost=' + await cl('进菜单后'));

// ---------- 阶段 A：几何（不起局，只用材质就绪后的枪模） ----------
const geo = await page.evaluate(async () => {
  const out = [];
  const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
  const THREE = await import('three');
  const { buildGun } = await import('/js/gunmodel.js');
  const mats = await import('/js/materials.js');

  // 镜筒 = 压在瞄具轴线上那个圆柱。默认**不要求** openEnded —— 负对照（把改动前的实心筒
  // 放回源码）的时候它正好是个实心圆柱，判据要能把它捡起来然后报红；要求了就只剩 TypeError，
  // 而异常不是判决，看日志才分得清哪条坏了。O4ᵃ 会用 requireOpen 单独问"它是开口的吗"。
  const findTube = (info, requireOpen) => {
    let t = null;
    info.group.traverse(o => {
      if (!o.isMesh || o.geometry.type !== 'CylinderGeometry') return;
      if (requireOpen && o.geometry.parameters.openEnded !== true) return;
      if (Math.abs(o.position.y - info.sight.y) < 1e-6) t = o;
    });
    return t;
  };

  // 瞄具的**结构件**范围（只收 Box/Cylinder，不含镜片）：这样给下面的射线定射程、
  // 以及给 O7 定"筒口"都不会自指 —— 若把被检查的那块镜片也算进边界，
  // 把它挪出去就等于把边界一起挪宽了，判据会笑着放行（O7⁻ 第一版就是这么绿的）。
  // 取 y 靠近瞄具轴线来分辨它是不是瞄具的零件：枪管在 0.035、AK 导气管在 0.07，
  // 而各瞄具的镜片/筒都在 sight.y ±0.03 里。
  const opticBox = (info) => {
    info.group.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    const b = new THREE.Box3();
    info.group.traverse(o => {
      if (!o.isMesh) return;
      if (o.geometry.type !== 'BoxGeometry' && o.geometry.type !== 'CylinderGeometry') return;
      // 0.02 这个门是从实测倒推出来的：放到 0.03 时 AK 的导气管（y=0.070，离瞄具轴线 0.0275）
      // 会被算成"瞄具零件"，bb 于是涨到 -0.439，导气管自己也落在里面 —— 边界由嫌疑对象
      // 参与构成，判据就变成自证。瞄具自己的零件离轴线最多 0.018（狙击镜的分划 elevation 旋钮
      // 已另行抬到筒顶），0.02 卡在这儿。
      if (Math.abs(o.position.y - info.sight.y) > 0.02) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      bb.union(b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
    });
    return bb;
  };

  // 沿枪管轴线（-z）从 info.sight（ADS 时这里就是相机原点）出发的一组平行射线。
  // 这些射线跟管壁平行，所以**任何** CylinderGeometry 命中都只能是垂直于视线的端盖
  // —— 开放管的侧壁打不到，这就是"通透"的可判形状。
  // 射程 = 眼底到瞄具自身最前端（由上面那个包围盒给出）：枪管、导气管那些实心件在
  // 更前面，挡住偏心视线是它们的本分，不算瞄具的账（AK 的导气管就在镜筒前方一掌宽，
  // 第一版把 far 设成 0.4 时正是它把判据点名的）。
  // 于是判定还得**同时**看命中点落没落在结构件那一段 z 里 —— 只看"有没有命中圆柱"的话，
  // 第二版（far 放到整个瞄具包围盒）又把导气管数了一遍，三条一起才算看明白了。
  // 返回第一个被挡住的偏心半径（-1 = 通透）。
  const eyeIsCapped = (info) => {
    const bb = opticBox(info);
    if (bb.isEmpty()) return 0;    // 连瞄具都没有也按"被挡"算 —— 失效要落在红的一侧
    const rc = new THREE.Raycaster();
    for (const r of [0, 0.004, 0.008, 0.012, 0.016]) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const eye = info.sight.clone().add(new THREE.Vector3(Math.cos(yaw) * r, Math.sin(yaw) * r, 0));
        rc.far = eye.z - bb.min.z + 0.005;
        rc.set(eye, new THREE.Vector3(0, 0, -1));
        const hitted = rc.intersectObject(info.group, true).filter(h =>
          h.object.geometry.type === 'CylinderGeometry' && h.point.z >= bb.min.z - 1e-6 && h.point.z <= bb.max.z + 1e-6);
        if (hitted.length) {
          const h = hitted[0];
          return { r, why: `${h.object.geometry.parameters.openEnded ? 'open' : 'SOLID'} cyl r=${h.object.geometry.parameters.radiusTop} y=${h.object.position.y.toFixed(3)} z=${h.object.position.z.toFixed(3)} hit.z=${h.point.z.toFixed(4)} bbz=[${bb.min.z.toFixed(3)},${bb.max.z.toFixed(3)}]` };
        }
      }
    }
    return { r: -1, why: '' };
  };

  // 所有要拿出来看图纸的瞄具 —— 不只有红点：acog / thermal / sniper 原先也是实心 cgeo，
  // 它们在 ADS 时会被 whole-holder 遮罩藏掉（viewmodel.js），所以只有腰射、收镜那零点几秒、
  // 别人眼里的第三人称模型、以及地上那把掉落物看得到 —— "吸附在枪上的三根金属柱"。
  const OPTICS = ['reddot', 'holo', 'acog', 'thermal', 'sniper'];
  const longGuns = ['m4', 'ak', 'scar', 'mp5', 'vector', 'pkm', 'm870', 'sks', 'l115'];
  const combos = [];
  for (const optic of OPTICS) {
    let worst = -1, worstId = '', worstWhy = '', built = [], missing = [];
    for (const id of longGuns) {
      let info;
      try { info = buildGun(id, { optic }, 'none', {}); } catch (e) { continue; }
      if (!info || info.optic !== optic) { missing.push(id); continue; }
      built.push(id);
      const got = eyeIsCapped(info);
      const r = got.r;
      if (r > worst) { worst = r; worstId = id; worstWhy = got.why; }
    }
    combos.push({ optic, built, missing, worst, worstId, worstWhy });
  }
  {
    const bad = combos.filter(c => c.worst >= 0);
    ok('O1⁺ 五种瞄具的镜筒都不再有实心端盖', bad.length === 0,
      bad.length ? bad.map(c => `${c.optic}/${c.worstId}@r=${c.worst} ← ${c.worstWhy}`).join('\n        ')
        : combos.map(c => `${c.optic}:${c.built.length}把`).join(' '));
    const noneAtAll = combos.filter(c => c.built.length === 0);
    ok('O1ᵃ 五种瞄具都真的装上了枪（不是"没装所以没得红"）', noneAtAll.length === 0,
      noneAtAll.length ? '一枪都没装上: ' + noneAtAll.map(c => c.optic).join(',') : combos.map(c => c.optic).join(','));
    const uncounted = combos.filter(c => c.built.length !== longGuns.length);
    ok('O1ᵇ 每把常驻长枪都覆盖了', uncounted.length === 0,
      uncounted.length ? uncounted.map(c => `${c.optic} 缺 ${c.missing.join('/')}`).join(' , ') : longGuns.join(','));
  }

  // O1⁻ 反证臂：按改动前的写法**原样**补一个实心筒，同一条判据必须能闻到它。
  // 只写前一半的话，把整个瞄具删掉也能全绿 —— 那条判据就没有资格叫判据。
  {
    const info = buildGun('m4', { optic: 'reddot' }, 'none', {});
    const tube = findTube(info, true);
    ok('O4ᵃ 镜筒是开口管', !!tube, tube ? `r=${tube.geometry.parameters.radiusTop} len=${tube.geometry.parameters.height}` : '没找到 openEnded 的筒');
    const before = eyeIsCapped(info).r;
    if (!tube) { ok('O1⁻ 反证：照老写法补上实心筒要报红', false, '没有镜筒可补'); }
    else {
      const solid = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 16).rotateX(Math.PI / 2), mats.mat('gunMetal'));
      solid.position.copy(tube.position);
      info.group.add(solid);
      const after = eyeIsCapped(info).r;
      info.group.remove(solid);
      ok('O1⁻ 反证：照老写法补上实心筒要报红', before < 0 && after >= 0, `补之前=${before} 补之后=${after}`);
    }
  }

  // O7：镜片/物镜不许飘在镜筒外面。这条盯着的是另一个方向 —— 把"从枪口方向看过去
  // 以为看见了一块突出的盖片"。 Acids: 改动前 acog 的物镜片在物镜锥口外 1mm 处。
  {
    const lensOutside = (info) => {
      const bb = opticBox(info);
      const out = [];
      info.group.traverse(o => {
        if (!o.isMesh) return;
        if (o.geometry.type !== 'CircleGeometry' && o.geometry.type !== 'PlaneGeometry') return;
        if (Math.abs(o.position.y - info.sight.y) > 0.03) return;
        if (o.position.z < bb.min.z || o.position.z > bb.max.z) out.push(o.geometry.type + '@' + o.position.z.toFixed(4));
      });
      return out;
    };
    let bad = [];
    for (const optic of OPTICS) {
      let info;
      try { info = buildGun('m4', { optic }, 'none', {}); } catch (e) { continue; }
      if (!info || info.optic !== optic) continue;
      const o = lensOutside(info);
      if (o.length) bad.push(`${optic}: ${o.join(',')}`);
    }
    ok('O7⁺ 每种瞄具的镜片都收在自己筒里', bad.length === 0, bad.join(' | ') || OPTICS.join(','));
    // O7⁻ 反证臂：把一片镜片刻意挪到筒外，判据要能闻到
    {
      const info = buildGun('m4', { optic: 'acog' }, 'none', {});
      const clean = lensOutside(info).length;
      let glass = null;
      info.group.traverse(o => { if (o.isMesh && o.geometry.type === 'CircleGeometry' && Math.abs(o.position.y - info.sight.y) < 0.03) glass = o; });
      const z0 = glass.position.z;
      const bbz = opticBox(info).max.z;
      glass.position.z = bbz + 0.01;
      const moved = lensOutside(info).length;
      glass.position.z = z0;
      ok('O7⁻ 反证：把镜片挪出筒口要报红', clean === 0 && moved > 0, `原位=${clean} 挪出=${moved}`);
    }
  }

  // O2⁺ 管壁内侧要看得见（side=DoubleSide）：从膛轴斜打一条射线到侧壁，
  // 命中面一定是内壁 = 背面，只有 DoubleSide 材质才收得到。
  const wallHits = (tube) => {
    if (!tube) return 0;    // 同 eyeIsCapped：失效落在红的一侧
    tube.parent.updateMatrixWorld(true);
    const rc = new THREE.Raycaster();
    rc.far = 0.4;
    rc.set(tube.position.clone().add(new THREE.Vector3(0, 0, 0.1)), new THREE.Vector3(0.2, 0, -1).normalize());
    return rc.intersectObject(tube.parent, true).filter(h => h.object.geometry.type === 'CylinderGeometry').length;
  };
  {
    const info = buildGun('m4', { optic: 'reddot' }, 'none', {});
    const tube = findTube(info);
    ok('O2⁺ 镜筒壁是双面的', mats.mat('gunTube').side === THREE.DoubleSide, 'side=' + mats.mat('gunTube').side);
    const yes = wallHits(tube);
    ok('O2⁺ 斜看能命中镜筒内壁', yes > 0, 'hits=' + yes);
    // O2⁻ 反证臂：同一个开口筒换成 FrontSide，内壁就整圈没了 —— 判据要能看出这个差别
    const oldSide = tube.material.side;
    tube.material.side = THREE.FrontSide;
    const nope = wallHits(tube);
    tube.material.side = oldSide;
    ok('O2⁻ 反证：FrontSide 的筒，内壁打不中', nope === 0 && yes > 0, `双面=${yes} 单面=${nope}`);
  }

  // O4：镜片与红点必须留在筒里（它们曾飘在筒口外面，从侧面看像粘上去的一块盖片）
  {
    const info = buildGun('m4', { optic: 'reddot' }, 'none', {});
    const tube = findTube(info);
    if (!tube) {
      ok('O4ᵇ 镜片收在筒内', false, '连镜筒都没有');
      ok('O4ᶜ 红点收在筒内', false, '连镜筒都没有');
      ok('O4ᵈ 红点还在瞄具轴线上', false, '连镜筒都没有');
    } else {
      const L = tube.geometry.parameters.height, z = tube.position.z;
      const inside = (o) => !!o && o.position.z > z - L / 2 && o.position.z < z + L / 2;
      const lens = [];
      info.group.traverse(o => { if (o.isMesh && o.geometry.type === 'CircleGeometry' && o.geometry.parameters.radius > 0.005) lens.push(o); });
      ok('O4ᵇ 镜片收在筒内', lens.length === 1 && inside(lens[0]), 'z=' + lens.map(o => o.position.z.toFixed(4)).join(','));
      ok('O4ᶜ 红点收在筒内', inside(info.reticle), info.reticle ? 'z=' + info.reticle.position.z.toFixed(4) : 'null');
      ok('O4ᵈ 红点还在瞄具轴线上', !!info.reticle && Math.abs(info.reticle.position.x) < 1e-9 && Math.abs(info.reticle.position.y - info.sight.y) < 1e-9);
    }
  }

  // O6：分划在屏幕上多大，用**角直径**说 —— 像素数随视口变，角度不随。
  // 2026-09-27 用户嫌 ADS 下的圆点太大（实测旧值 ø0.893°，1080p ADS 下直径约 24 px），
  // 缩到 20% 之后 ø0.179°。这条就是那份口味的可回归版本，上下两个方向都判：
  // 只写"不许太大"的话，有人把它调到 0（红点整个消失）也照样全绿。
  const angDegOf = (info) => {
    const d = Math.abs(info.reticle.position.z - info.sight.z);
    return 2 * Math.atan(info.reticle.geometry.parameters.radius / d) * 180 / Math.PI;
  };
  const LO = 0.08, HI = 0.30;
  {
    const rifle = buildGun('m4', { optic: 'reddot' }, 'none', {});
    const pistol = buildGun('m1911', { optic: 'reddot' }, 'none', {});
    if (!rifle.reticle || !pistol.reticle) {
      ok('O6ᵃ 长枪红点的角直径', false, '少了一把瞄具');
      window.__reticleAng = 0;
    } else {
      const a = angDegOf(rifle), b = angDegOf(pistol);
      const px = (deg) => (deg * 27).toFixed(1);   // 1080p、ADS 竖直 FOV 40° ≈ 27 px/°
      window.__reticleAng = a;                     // 阶段 B 用真相机复核下面那条前提
      ok('O6ᵃ 长枪红点角直径在范围内', a >= LO && a <= HI, `${a.toFixed(3)}° 1080p≈${px(a)} px（旧 0.893° / ${px(0.893)} px）`);
      ok('O6ᵇ 手枪红点角直径在范围内', b >= LO && b <= HI, `${b.toFixed(3)}° 1080p≈${px(b)} px`);
      // O6ᶜ：同一个 MRS 配件，装在两个枪型上要一样大。这两处分划离眼的距离不一样
      // （手枪 0.076 m / 长枪 0.1155 m），照抄同一个米数常数就会大一倍半 —— 这条正是为此立的
      ok('O6ᶜ 同一配件两枪型角直径一致（±15%）', Math.abs(a - b) / Math.min(a, b) <= 0.15, `长枪=${a.toFixed(3)}° 手枪=${b.toFixed(3)}°`);
    }
  }

  // O6ᵉ：全息的中心点。它的分划离眼 0.151 m（红点 0.1155 m），所以同样只能比角直径 ——
  // 米数照抄会分叉（红点那两条已经栽过一次）
  {
    const info = buildGun('m4', { optic: 'holo' }, 'none', {});
    const grp = info.reticle;
    const dot = grp && grp.children.find(o => o.geometry && o.geometry.type === 'CircleGeometry');
    if (!dot) ok('O6ᵉ 全息中心点角直径在范围内', false, '没找到中心点');
    else {
      const d = Math.abs(grp.position.z - info.sight.z);
      const deg = 2 * Math.atan(dot.geometry.parameters.radius / d) * 180 / Math.PI;
      const px = (x) => (x * 27).toFixed(1);
      ok('O6ᵉ 全息中心点角直径在范围内', deg >= LO && deg <= HI, `${deg.toFixed(3)}° 1080p≈${px(deg)} px（旧 0.531° / ${px(0.531)} px）`);
    }
  }

  // O8：全息瞄具应当**加快**开镜（ads 是乘数，小于 1 才是快 —— 别写反了）
  {
    const { computeStats } = await import('/js/data.js');
    const ads = (att) => computeStats('m4', att).ads;
    const iron = ads({}), rd = ads({ optic: 'reddot' }), holo = ads({ optic: 'holo' });
    const acog = ads({ optic: 'acog' }), therm = ads({ optic: 'thermal' });
    ok('O8⁺ 全息开镜比裸枪和红点都快', holo < iron && holo < rd, `裸=${iron.toFixed(3)} 红点=${rd.toFixed(3)} 全息=${holo.toFixed(3)}`);
    ok('O8ᵃ 这个"快"得快得出来（至少 5%）', holo <= rd * 0.95, `全息=${holo.toFixed(3)} 红点=${rd.toFixed(3)}`);
    // O8⁻ 反证臂：只写"全息要快"那一半的话，把五种瞄具一律调快也照样全绿 ——
    // 高倍镜那一串必须仍然比裸枪慢
    ok('O8⁻ 反证：高倍镜仍然比裸枪慢', acog > iron && therm > iron, `acog=${acog.toFixed(3)} thermal=${therm.toFixed(3)} 裸=${iron.toFixed(3)}`);
  }
  return out;
});

console.log('  ctx 阶段A后 lost=' + await cl('阶段A后'));

// ---------- 阶段 B：真起局，ADS，看画面中央有没有那个红点 ----------
const px = await page.evaluate(async () => {
  const out = [];
  const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
  const g = window.game;
  g.renderer.setAnimationLoop(null);
  // 时钟钉死在 1/60：手写的 frame() 两次调用之间只有微秒，而主循环是**固定步长** ——
  // 不钉住的话 200 帧连一拍都推不动，adsT 恒 0，O3⁺/O6ᵈ/O5 四条一起红，而红的没有一条是它
  // 们的命题（viewmodel.mjs / state-leak.mjs 早就这么钉了，这一段漏了它）。
  // 2026-09-27 负对照确认过：这组红在改大厅那轮**之前**就在（退掉源码照样红），成因是量具。
  // 渲染**不** stub —— O5 的像素差分要真出图（那一段另有规矩：走 composer.render() 不走 frame()）。
  const realClock = g.clock;
  g.clock = { getDelta: () => 1 / 60 };
  // 驱动阶段**不渲染**：开镜只需要模拟推进（adsT 是模拟量）。每帧都真渲染会让 swiftshader
  // 的 GPU 进程在同步循环里被 watchdog 掐掉 —— 上下文一丢，之后所有像素判据全是 no-op，
  // 症状是"分划差分恒 0、连隐藏整个 vmScene 的对照臂都不动"，看起来像分划没画，
  // 其实是量具死了（2026-09-27 实测：isContextLost()=true 时整帧读回全黑）。真渲染
  // 只留给最后采样那几帧。（viewmodel/state-leak 一直是这么 stub 的，这一段也该。）
  const realRender = g.composer.render.bind(g.composer);
  g.composer.render = () => {};
  // 上下文丢失的打点：丢了之后一切都变 no-op，"哪一步丢的"决定修哪一段。
  const mark = (tag) => { (window.__cl ||= []).push(tag + '=' + g.renderer.getContext().isContextLost()); };
  mark('起始');
  await g.startGame('mp', { mode: 'tdm', map: 'yard', diff: 1, allies: 4, enemies: 4, scoreLimit: 50, timeLimit: 10 });
  mark('startGame后');
  const ws = g.player.ws, vm = ws.vm;
  ws.replaceSlot(0, { id: 'm4', att: { optic: 'reddot' }, camo: 'none' }, 30, 150);
  for (let i = 0; i < 120 && vm.groups.length === 0; i++) g.frame();
  ws.switchTo(0);
  for (let i = 0; i < 120 && ws.cur !== 0; i++) g.frame();
  for (let i = 0; i < 200 && ws.adsT < 0.995; i++) { g.input.buttons = 4; g.frame(); }
  mark('开镜后');
  g.composer.render = realRender;               // 采样开始才真渲染（见上面 stub 那段的成因）
  const cur = vm.groups[ws.cur];
  ok('O3⁺ ADS 拉满', ws.adsT > 0.99, 'adsT=' + ws.adsT.toFixed(3));
  ok('O3⁺ 红点 ADS 时枪模是可见的（不像高倍镜那样被遮罩藏掉）', vm.holder.visible === true && cur.info.optic === 'reddot',
    `visible=${vm.holder.visible} optic=${cur.info.optic}`);

  // O6ᵈ：阶段 A 的角直径是按"ADS 时 sight 点就是相机原点"算的 —— 那是推断出来的距离。
  // 这里用真相机复核：前提不成立的话，O6ᵃᵇᶜ 就在量一段不存在的距离。
  {
    const THREE3 = await import('three');
    const p = new THREE3.Vector3(), e = new THREE3.Vector3();
    g.vmCamera.updateMatrixWorld(true);
    cur.info.reticle.getWorldPosition(p);
    g.vmCamera.getWorldPosition(e);
    const deg = 2 * Math.atan(cur.info.reticle.geometry.parameters.radius / e.distanceTo(p)) * 180 / Math.PI;
    const local = window.__reticleAng || 0;
    ok('O6ᵈ 真相机量出的角直径与几何值一致（前提成立）', local > 0 && Math.abs(deg - local) / local < 0.1,
      `相机=${deg.toFixed(3)}° 几何=${local.toFixed(3)}° 眼距=${e.distanceTo(p).toFixed(4)} m`);
  }

  // 像素差分，不是"数红像素"：
  // 1) 渲染用 g.composer.render() 直接出图——不推进世界。g.frame() 会走一整个模拟 tick，
  //    两次采样之间敌人和光影都在动，差分就被污染了。
  // 2) "红不红"交给差分自己说话：第一版按阈值数红像素，被地图的红色集装箱淹没
  //    （中心 1015 个"红"像素里分划只贡献 23 个）；收紧阈值后又因为分划颜色乘了 4、
  //    tone map 后偏亮偏粉而清零。颜色阈值两头都不是人 —— 差分才是硬的。
  const snap = (show) => {
    ret.visible = show;
    g.composer.render();
    // 像素**从默认帧缓冲 readPixels 读回**，不走 canvas→drawImage：后者要经过合成器拷贝，
    // 那条路在 swiftshader 下时序不稳 —— 实测同一份代码有时拷到**上一帧**（于是开关分划的
    // 差分恒 0，连"隐藏整个 vmScene"的对照臂都一动不动），有时又是新帧（26/26 绿）。
    // 判据不能赌合成器的心情：readPixels 是同步 GPU 读回，读到的一定是刚渲染的那一帧。
    // （Y 轴在这里翻正，行序与 drawImage 一致，下面的窗口切法不用改。）
    const gl = g.renderer.getContext();
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const raw = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const full = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) full.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    const w = Math.round(W * 0.12), h = Math.round(H * 0.12);
    const crop = (x0, y0, cw, ch) => {
      const out = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) out.set(full.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + cw) * 4), y * cw * 4);
      return out;
    };
    return {
      // 全帧也留一份：中心窗差分为 0 有三种成因（没画出来 / 画在窗外面 / 画了但小于阈值），
      // 只看中心窗分不出是哪种 —— 全帧差分 + NDC 投影把前两种当场分开。
      full,
      center: crop(Math.round((W - w) / 2), Math.round((H - h) / 2), w, h),
      corner: crop(Math.round(W * 0.04), Math.round(H * 0.72), w, h),
    };
  };
  const diffPx = (A, B) => {
    let n = 0, dR = 0, dG = 0, dB = 0;
    for (let i = 0; i < A.length; i += 4) {
      const d0 = Math.abs(A[i] - B[i]), d1 = Math.abs(A[i + 1] - B[i + 1]), d2 = Math.abs(A[i + 2] - B[i + 2]);
      if (d0 + d1 + d2 > 30) { n++; dR += A[i] - B[i]; dG += A[i + 1] - B[i + 1]; dB += A[i + 2] - B[i + 2]; }
    }
    return { n, dR, dG, dB };
  };
  const ret = cur.info.reticle;
  // ── 对照实验：把整个 vmScene 隐藏再出一帧 ── 它把"截帧这条路是通的"和"分划自己没画"
  // 分开：对照臂差分也是 0 ⇒ 截帧/vmPass 这条路根本没出图（这时改瞄具是白改）；
  // 对照臂差分很大 ⇒ 出图是好的，坏的就在这块分划片自己。
  const ctlA = snap(true);
  g.vmScene.visible = false;
  const ctlB = snap(true);
  g.vmScene.visible = true;
  const ctlD = diffPx(ctlA.full, ctlB.full);
  // 上下文丢没丢必须先问：丢了之后所有 gl 调用都是 no-op —— 渲染不出图、readPixels 读回全零、
  // drawImage 拷到旧帧，三种症状长得跟"分划没画"一模一样（swiftshader 重载下偶发）。
  const ctxLost = g.renderer.getContext().isContextLost();
  mark('采样时');
  const on = snap(true), offf = snap(false);
  const c = diffPx(on.center, offf.center);
  const k = diffPx(on.corner, offf.corner);
  const fullD = diffPx(on.full, offf.full);
  // 阈值以上差几像素说不清"没画"和"画得太淡"的区别，所以把**无阈值**的原始能量也量出来：
  // ΣΔ=0 ⇒ 真没画；ΣΔ>0 而阈值计数=0 ⇒ 画了但被阈值/抗锯齿吃掉（那是判据线的问题）。
  let rawMax = 0, rawSum = 0, rawN = 0, nonZero = 0;
  for (let i = 0; i < on.full.length; i += 4) {
    if (on.full[i] | on.full[i + 1] | on.full[i + 2]) nonZero++;
    const d = Math.abs(on.full[i] - offf.full[i]) + Math.abs(on.full[i + 1] - offf.full[i + 1]) + Math.abs(on.full[i + 2] - offf.full[i + 2]);
    if (d > 0) { rawN++; rawSum += d; if (d > rawMax) rawMax = d; }
  }
  // 分划在真相机里的投影位置（NDC，屏幕正中是 0,0）：它说得出"画了但在取景窗外面"这一种成因
  const ndcOf = await (async () => {
    const T = await import('three');
    const v = new T.Vector3();
    ret.getWorldPosition(v); v.project(g.vmCamera);
    // 顺带量法线朝向：CircleGeometry 只有正面（FrontSide），如果枪模/瞄具的朝向让分划
    // 背对着相机，它会**整个被背面剔除** —— 位置对、投影在正中，但一个像素都不画。
    const n = new T.Vector3(0, 0, 1).applyQuaternion(ret.getWorldQuaternion(new T.Quaternion()));
    const fwd = new T.Vector3(); g.vmCamera.getWorldDirection(fwd);
    return `${v.x.toFixed(2)},${v.y.toFixed(2)} 法线·视线=${n.dot(fwd).toFixed(2)} side=${(ret.material && ret.material.side) ?? '-'}`;
  })();
  ret.visible = true;
  // 阈值只求"确实动了几个像素"：缩到 20% 之后红点在 1280×720 下只剩 5 个差分像素，
  // 再抬高门槛就是在跟抗锯齿掰手腕。"多大才合适"由 O6 的角直径管，不在这里用像素数卡。
  ok('O5⁺ ADS 中心出现红点（开关分划的差分显著）', c.n >= 2,
    `diffPx=${c.n} 全帧diff=${fullD.n} 原始:${rawN}px ΣΔ=${rawSum} 对照臂=${ctlD.n}px 非零=${nonZero} 丢失打点[${(window.__cl || []).join(' ')}] NDC=${ndcOf}`);
  ok('O5ᵇ 差分像素确实是"变红"', c.dR > 0 && c.dR > c.dG * 2 && c.dR > c.dB * 2, `ΔR=${c.dR} ΔG=${c.dG} ΔB=${c.dB}`);
  // O5⁻ 反证臂：同一对渲染之间，画面角落的同尺寸窗口必须几乎无差。
  // 角落也有差分的话，说明"世界静止"这个前提没成立，O5⁺ 量到的是噪声不是红点。
  ok('O5⁻ 反证：远离中心的同尺寸窗口几乎无差分', k.n <= 2, `cornerDiffPx=${k.n}`);

  g.clock = realClock; realClock.getDelta();      // 还原真时钟再恢复主循环（截图要按真实节奏跑）
  g.renderer.setAnimationLoop(() => g.frame());
  // 注意 buttons 别清零：恢复 loop 后玩家要保持 ADS，下面的截图才是"瞄着的时候"的画面
  return out;
});

try { await page.mouse.click(320, 180); } catch { /* pointer lock 恢复不了也不影响判据 */ }
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test/optic.png' });
await browser.close();

const res = [...geo, ...px];
let green = errs.length === 0;
for (const [okFlag, label] of res) { green &&= okFlag; console.log(`  ${okFlag ? '✅' : '❌'} ${label}`); }
if (errs.length) console.log('  页面异常:\n    ' + errs.slice(0, 8).join('\n    '));
console.log(`\n  结论：${green ? '绿' : '红'}  ${res.filter(r => r[0]).length}/${res.length}`);
srv.kill();
process.exit(green ? 0 : 1);
