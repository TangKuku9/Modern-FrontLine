// 地表材质判据（test/terrainmat.mjs）—— 离线那一半。
//
// 盯的是「双丘战区」地表从"一张草贴图 × 逐顶点色"换成"splat 四层混合"这条链路上，
// **每个接缝会不会静默失效**。这类改动最坏的失效不是崩，是"画出来照样像样"：
//   · 掩膜通道错位（第 4 项当成了第 3 项）→ 碎石贴在崖顶、岩贴在平地上；
//   · terrainBlend 与 color() 的返回长度各改各的 → 多出来的那一层永远不出现；
//   · 着色器补丁的字符串锚点没命中（three 升级改了 chunk）→ 画面与改动前逐字相同；
//   · 阈值侵蚀其实没侵蚀 → 崖面边界仍是一圈等高线。
// 上面这些**全都不会让任何既有判据变红**，所以每一条都得有自己的闸 + 自己的反证臂。
//
// 浏览器那一半（真编译、真像素）在 test/terrainmat-gl.mjs —— 这里只做到"补丁被调过、
// 六个锚点命中"，因为 onBeforeCompile 是纯字符串活，不碰 GL 也能跑。
//
// 纪律沿用 test/terrain.mjs：正向断言必须配反证臂，且先给"这一批样本非空"的先决臂。
import { installBrowserShim } from '../server/browser-shim.mjs';
installBrowserShim();
const { createHash } = await import('node:crypto');
const { spawnSync } = await import('node:child_process');
const THREE = (await import('three')).default ?? (await import('three'));
const { World } = await import('../js/world.js');
const { MAPS } = await import('../js/maps.js');
const { Terrain, SLOPE } = await import('../js/terrain.js');
const { initTextures, terrainSplatSet, mat } = await import('../js/materials.js');
const { color, CORRIDOR, RAMPS, SITE, FLAG_POS } = await import('../js/maps/ridges.js');
const { applyTerrainSplat, SPLAT_STRIDE } = await import('../js/terrain-splat.js');
await initTextures();

const out = [];
const ok = (label, cond, extra = '') => out.push([!!cond, label + (extra ? '  ' + extra : '')]);
const mkGame = () => ({
  scene: new THREE.Scene(), settings: { quality: 'low', maxLights: 4 },
  renderer: { toneMappingExposure: 1 }, effects: { addFireSource: () => {} }, time: 0,
});
const build = () => {
  const w = new World(mkGame(), MAPS.ridges);
  // 顺手记下路床板的调用：M2e 要用它说明"盘山路上的掩膜为什么允许不为 0"。
  const roads = [];
  const rb0 = w.roadbed.bind(w);
  w.roadbed = (path, hw, mn) => { roads.push({ hw, mn, n: path.length }); return rb0(path, hw, mn); };
  MAPS.ridges.build(w, w.game); w.finalize();
  w.__roads = roads;
  return w;
};
const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// ══════════════ M1 段：掩膜契约（通道数与字节序） ══════════════
{
  // 漂移闸：color() 给几项，terrainBlend 就得写几。两边各改各的一边时，render() 会
  // 把多出来的通道**静默丢掉**（那比抛错贵：画面上看不出来，那一层材质永远不出现）。
  const n = color(0, 0, 10, 0.5).length - 3;
  ok('M1 color() 的权重项数 == maps.js 的 terrainBlend（两边不许各改各的）',
    n === MAPS.ridges.terrainBlend, `color 给 ${n} 项 / terrainBlend=${MAPS.ridges.terrainBlend}`);
  const c = color(30, -20, 12, 0.7);
  ok('M1b 权重全部落在 0..1 且三者之和 ≤1（草是余量，不能为负）',
    c.slice(3).every(v => v >= 0 && v <= 1) && c[3] + c[4] + c[5] <= 1 + 1e-6,
    `(${c[3].toFixed(3)},${c[4].toFixed(3)},${c[5].toFixed(3)}) 和=${(c[3] + c[4] + c[5]).toFixed(3)}`);

  // 字节序闸（结构性，不复制 terrain.js 的算法）：给一个"每个通道一个可辨值"的假
  // colorFn，检查 aBlend 里第 0/1/2 通道确实是第 4/5/6 项、且没被行列转置搞反。
  const T2 = new Terrain(20, (x, z) => 4 + (x + z) * 0.01, { cell: 2 });
  const got = T2.render(6, (x, z, y, slope) => {
    const u = (x + 20) / 40, v = (z + 20) / 40;
    return [0, 0, 0, 0.1 + u * 0.5, 0.2 + v * 0.5, 0.3];
  }, 3);
  let orderBad = 0;
  for (let k = 0; k < got.blend.length / 3; k++) {
    const x = -20 + (k % (T2.n + 1)) * 2, z = -20 + Math.floor(k / (T2.n + 1)) * 2;
    if (Math.abs(got.blend[k * 3] - (0.1 + (x + 20) / 40 * 0.5)) > 1e-6) orderBad++;
    if (Math.abs(got.blend[k * 3 + 1] - (0.2 + (z + 20) / 40 * 0.5)) > 1e-6) orderBad++;
    if (Math.abs(got.blend[k * 3 + 2] - 0.3) > 1e-6) orderBad++;
  }
  ok('M1c 掩膜字节序：通道 0/1/2 = color 的第 4/5/6 项，且 x/y 不转置（错了就是"碎石贴在崖顶"）',
    orderBad === 0, `${orderBad} 处对不上`);

  // 【反证臂】长度对不上的两种情形都必须当场抛：少一项=错位，多一项=静默丢弃
  const T3 = new Terrain(10, () => 5, { cell: 2 });
  let threw4 = false, threw7 = false;
  try { T3.render(6, () => [0, 0, 0, 0.5], 3); } catch { threw4 = true; }
  try { T3.render(6, () => [0, 0, 0, 0.5, 0.5, 0.5, 0.5], 3); } catch { threw7 = true; }
  ok('M1d【反证臂】colorFn 给 4 项（错位）或 7 项（丢通道）时 render 必须抛', threw4 && threw7,
    `4项抛=${threw4} 7项抛=${threw7}`);
  // 只给 3 项 = 这张图没有掩膜这一说：不许抛，且权重全 0（既有五张图的口径）
  let threw3 = false, b3 = null;
  try { b3 = T3.render(6, () => [0.4, 0.5, 0.6], 3).blend; } catch { threw3 = true; }
  ok('M1e 只给 3 项时不抛、掩膜全 0（老行为：单层底图，其余地图零影响）',
    !threw3 && b3 && b3.every(v => v === 0));
}

// ══════════════ M2 段：掩膜画在地形上的语义 ══════════════
{
  const w = build();
  const T = w.terrain;
  const attr = w.terrainMesh.geometry.attributes.aBlend;
  ok('M2 地形网格挂了 aBlend（itemSize 必须等于 terrainBlend，挂错就是着色器读越界）',
    !!attr && attr.itemSize === MAPS.ridges.terrainBlend && attr.count === w.terrainMesh.geometry.attributes.position.count,
    attr ? `itemSize=${attr.itemSize} count=${attr.count}` : '没有 aBlend');

  const bn = MAPS.ridges.terrainBlend, h = attr.array;
  let nan = 0, oob = 0, over = 0, nCliff = 0, nFlat = 0, rockCliff = 0, rockFlat = 0;
  let nMid = 0, screeMid = 0, nCell = 0, covR = 0, covS = 0, covD = 0;
  for (let j = 0; j <= T.n; j++) {
    for (let i = 0; i <= T.n; i++) {
      const k = j * (T.n + 1) + i;
      const x = -T.half + i * T.cell, z = -T.half + j * T.cell;
      const wr = h[k * bn], ws = h[k * bn + 1], wd = h[k * bn + 2];
      if (!Number.isFinite(wr) || !Number.isFinite(ws) || !Number.isFinite(wd)) { nan++; continue; }
      if (wr < -1e-6 || ws < -1e-6 || wd < -1e-6 || wr > 1 + 1e-6 || ws > 1 + 1e-6 || wd > 1 + 1e-6) oob++;
      if (wr + ws + wd > 1 + 1e-4) over++;
      const s = T.slope(x, z);
      nCell++;
      if (wr > 0.5) covR++;
      if (ws > 0.5) covS++;
      if (wd > 0.5) covD++;
      if (s > 0.85) { nCliff++; rockCliff += wr; }
      else if (s < 0.10) { nFlat++; rockFlat += wr; }
      else if (s > 0.28 && s < 0.62) { nMid++; screeMid += ws; }
    }
  }
  // 先决臂：样本非空。"崖面均值 1.0、平地均值 0"在一个 0 个崖点的扫格上是恒绿的。
  ok('M2a【先决】扫格真的覆盖了崖面与平地（否则下面两条是空集假绿）',
    nCliff > 800 && nFlat > 3000 && nMid > 1000, `崖 ${nCliff} / 平 ${nFlat} / 中带 ${nMid}`);
  ok('M2b 数值健康：无 NaN、无越界、三通道之和 ≤1', nan === 0 && oob === 0 && over === 0,
    `NaN ${nan} 越界 ${oob} 超和 ${over}`);
  const rc = rockCliff / nCliff, rf = rockFlat / nFlat;
  ok('M2c 裸岩真的长在崖上：slope>0.85 的裸岩权重均值 ≥0.9，slope<0.10 的 ≤0.02',
    rc >= 0.9 && rf <= 0.02, `崖 ${rc.toFixed(3)} vs 平 ${rf.toFixed(3)}`);
  ok('M2d 碎石真的长在中带（0.28..0.62 的均值 > 0.15，不是到处一点也不是到处全有）',
    screeMid / nMid > 0.15, `中带碎石均值 ${(screeMid / nMid).toFixed(3)}`);

  // 净空：硬化路面上不许长石头和碎石（用户原话级问题；B21 管几何，这里管材质）。
  // **这张图上有两套路，口径不一样，混起来断言就是我第一版犯的错：**
  //   · CORRIDOR 只有**顶点色**画出来的水泥带（color() 里的 onRoad）→ 没有几何盖它，
  //     掩膜不为 0 就会真把碎石画在路上。这一条必须咬死。
  //   · RAMPS 是 w.roadbed 的**混凝土几何板**（半宽 3.4m）压在地上 → 板底下的掩膜看不见，
  //     而板外侧本来就该是碎石坡（山路边上长松石是对的）。这里不断言，只在下面钉住
  //     "板真的铺了、宽度真的够"，因为那才是让这件事成立的前提；板一旦撤掉，上面那
  //     93 个点会立刻变成"碎石铺在马路中间"。
  const sampleLine = (LIST) => {
    let bad = 0, worst = 0;
    for (const path of LIST) for (let i = 0; i + 1 < path.length; i++) for (let u = 0; u <= 1; u += 0.02) {
      const x = path[i][0] + (path[i + 1][0] - path[i][0]) * u;
      const z = path[i][1] + (path[i + 1][1] - path[i][1]) * u;
      if (Math.abs(x) > T.half - 4 || Math.abs(z) > T.half - 4) continue;
      const ii = Math.round((x + T.half) / T.cell), jj = Math.round((z + T.half) / T.cell);
      const k = jj * (T.n + 1) + ii;
      const v = h[k * bn] + h[k * bn + 1];
      if (v > 0.05) { bad++; if (v > worst) worst = v; }
    }
    return [bad, worst];
  };
  const [corrBad, corrWorst] = sampleLine(CORRIDOR);
  const [rampBad, rampWorst] = sampleLine(RAMPS);
  ok('M2e 着色路面（CORRIDOR）中心线上裸岩+碎石权重 ≈0（没有几何盖它，超限就直接画在路上）',
    corrBad === 0, `${corrBad} 个点超限，最高 ${corrWorst.toFixed(3)}`);
  const plateOk = w.__roads.length === RAMPS.length && w.__roads.every(r => r.hw >= 3.4);
  ok('M2e2 盘山路的混凝土**几何板**每条都在、半宽 ≥3.4m（M2e 对 RAMPS 放宽的前提；板一撤，路面上就会长出碎石）',
    plateOk, w.__roads.map(r => `${r.hw}m/${r.mn}`).join(' '));
  ok('M2e3 RAMPS 中心线上的掩膜读数保持可见（它靠上面那条板遮，不是靠掩膜归零 —— 别把它当"已经净空"）',
    true, `${rampBad} 点有权重，最高 ${rampWorst.toFixed(3)}（在板下）`);

  // 营区/出生台是压平的地：不长岩与碎石（夯土走裸土通道，合法）
  let platBad = 0;
  for (const p of [SITE.camp, SITE.spawnA, SITE.spawnB]) {
    for (let dx = -p.r * 0.6; dx <= p.r * 0.6; dx += 4) for (let dz = -p.r * 0.6; dz <= p.r * 0.6; dz += 4) {
      if (Math.hypot(dx, dz) > p.r * 0.6) continue;
      const x = p.x + dx, z = p.z + dz;
      const ii = Math.round((x + T.half) / T.cell), jj = Math.round((z + T.half) / T.cell);
      const k = jj * (T.n + 1) + ii;
      if (h[k * bn] > 0.05 || h[k * bn + 1] > 0.05) platBad++;
    }
  }
  ok('M2f 营区/出生平台台内不长岩与碎石（那是压过的地，材质要和语义一致）', platBad === 0, `${platBad} 处超限`);

  // 磨损环中心要有裸土（据点可读性：地上看得出"这里被踩秃了"）
  const wk = FLAG_POS.map(([fx, fz]) => {
    const ii = Math.round((fx + T.half) / T.cell), jj = Math.round((fz + T.half) / T.cell);
    return h[(jj * (T.n + 1) + ii) * bn + 2];
  });
  ok('M2g 三个据点旗心都是裸土（磨损环从"色"升级成"材质"）', wk.every(v => v > 0.6), wk.map(v => v.toFixed(2)).join('/'));

  // 出生平台那一圈同款：颜色行给它夯土黄，掩膜就必须给裸土。这两个来源以前是分家的
  // —— 出生台只进了 hardFlat（用来压掉岩/碎石），没进权重，于是站在那儿是"草地上
  // 凭空一块压平的黄地"。M2g 红了以后才发现旗环那条是同一个毛病的另一半。
  const spk = [SITE.spawnA, SITE.spawnB].map(p => {
    const ii = Math.round((p.x + T.half) / T.cell), jj = Math.round((p.z + T.half) / T.cell);
    return h[(jj * (T.n + 1) + ii) * bn + 2];
  });
  ok('M2h 两个出生平台中心是裸土（色与材质必须同源，否则那块平黄地没有材质支撑）',
    spk.every(v => v > 0.6), spk.map(v => v.toFixed(2)).join('/'));

  // ── 覆盖率预算 ──
  // 这一条是**用眼睛付了学费之后补的**：第一版掩膜把非草合计推到 42%，俯瞰图里两座
  // 丘陵整片发白 —— 用户最初那句"不该通体绿"被做成了"通体灰"，同一句话的两个方向都算失败。
  // 上界 35% 来自那张被否掉的 42%，下界 12% 来自"什么都没有 = 回到通体绿"。
  // **它不是美学真理，是已付过学费的预算**：谁要动这几个阈值（ridges.js 里那两个数），
  // 必须重出一遍俯瞰图自己看，别只看这条变绿了就收工 —— 这条拦得住"跑过头"，
  // 拦不住"跑到位但难看"。
  const covAll = (covR + covS + covD) / nCell;
  ok('M2i 覆盖率在预算内：非草合计 12%~35%，且裸岩 ≤20%、碎石 ≤15%（42% 那张已被肉眼否掉）',
    covAll >= 0.12 && covAll <= 0.35 && covR / nCell <= 0.20 && covS / nCell <= 0.15,
    `合计 ${(covAll * 100).toFixed(1)}%（岩 ${(covR / nCell * 100).toFixed(1)}% / 碎石 ${(covS / nCell * 100).toFixed(1)}% / 土 ${(covD / nCell * 100).toFixed(1)}%）`);

  const maskOld = (i, j) => {
    const x = -T.half + i * T.cell, z = -T.half + j * T.cell;
    return sstep(0.60, 0.66, T.slope(x, z));          // "warp 关掉"那一版：阈值只抖 ±0.05
  };
  // ── 边界到底像不像"等高线" ──
  //
  // 这里换过三次尺子，前两次都是错的，错法值得留在文件里：
  //  ① "岩区周长/面积密度比无 warp 的对照高 15%" —— 对照组自己就不光滑（纯坡度等值线
  //    在这张带中频噪声的丘陵上本来就弯弯曲曲），实测 0.519 vs 0.462 只差 12%，
  //    而且碎石带一收紧、挂在带上的岩斑就没了，它当场红 —— 可"像不像等高线"没变。
  //  ② "边界跨越处的坡度散布" —— 听着更对，实测**对照组反而更宽**（0.503 vs 0.449）。
  //    根因：掩膜是坡度的函数，而坡度场在 2m 尺度上自己就是粗的，相邻两格差 0.2 很常见，
  //    于是量到的永远是地形的毛糙，不是 warp。
  //  ⇒ 代理指标这条路走不通，改问定义本身。**"等高线"的数学含义就是"掩膜只由坡度决定"**，
  //    所以要证伪它，只要找到**坡度几乎相同、掩膜却差很多**的两个点。这个读数对地形
  //    毛糙免疫（毛糙只会让坡度不同的点分开，不会伪造出"同坡度不同掩膜"），
  //    而且对照组天然给出≈0 —— 纯坡度阈值的掩膜在同一坡度上必然同值。
  const cells = [];
  for (let j = 0; j <= T.n; j++) for (let i = 0; i <= T.n; i++) {
    const x = -T.half + i * T.cell, z = -T.half + j * T.cell;
    cells.push([T.slope(x, z), h[(j * (T.n + 1) + i) * bn], maskOld(i, j)]);
  }
  cells.sort((a, b) => a[0] - b[0]);
  // 按坡度排序后配对。**容差 0.005 必须是远小于 smoothstep 过渡带 0.06 的**：过渡带里
  // 掩膜对坡度的导数最大 1.5/0.06 = 25 每单位，容差给到 0.02 时对照组自己就能差出
  // 0.161（第一版就这么误红了一次，那是对照臂是对的、我的容差太松）。0.005 之下
  // 纯坡度阈值的残差应当 ≈0.04，而真掩膜仍然差到 1.0 —— 那才是"warp 在起作用"。
  let pairs = 0, disagree = 0, worstNew = 0, worstCtl = 0;
  for (let i = 0; i < cells.length; i++) {
    for (let k = i + 1; k < Math.min(cells.length, i + 60); k++) {
      if (cells[k][0] - cells[i][0] > 0.005) break;
      pairs++;
      const dNew = Math.abs(cells[i][1] - cells[k][1]);
      const dCtl = Math.abs(cells[i][2] - cells[k][2]);
      if (dNew > 0.5) disagree++;
      if (dNew > worstNew) worstNew = dNew;
      if (dCtl > worstCtl) worstCtl = dCtl;
    }
  }
  const rate = disagree / Math.max(1, pairs);
  ok('M3a【先决】量到了足够多"坡度几乎相同"的点对（否则 M3 比的是空集合）',
    pairs > 20000, `${pairs} 对（坡度差 <0.005）`);
  ok('M3 掩膜不是坡度的单值函数 = 边界不是等高线：同坡度点对里掩膜差 >0.5 的占 ≥2%，最大差 ≥0.8',
    rate >= 0.02 && worstNew >= 0.8, `占比 ${(rate * 100).toFixed(2)}%（${disagree} 对）最大差 ${worstNew.toFixed(3)}`);
  // 【反证臂】"warp 关掉"那一版必须**读不出**这种点对（同坡度 ⇒ 同掩膜）。它要也高，
  // 说明这条尺子量的还是别的东西。
  // 门槛不手填：纯坡度阈值那一版在同一坡度上的**残差有解析上限** —— smoothstep 的导数
  // 最大 1.5/(0.66-0.60) = 25 每单位坡度，乘配对容差就是它的天花板（实测 0.124，
  // 与 25×0.005 = 0.125 吻合到第三位小数）。真掩膜在这里读到 1.000，是那个上限的 8 倍。
  const CTL_CEIL = (1.5 / 0.06) * 0.005 * 1.2;
  ok('M3b【反证臂】纯坡度阈值那一版的同坡度点对最大差不超过"过渡带导数×容差"的解析上限（尺子只读单值性）',
    worstCtl <= CTL_CEIL, `对照最大差 ${worstCtl.toFixed(3)} vs 解析上限 ${CTL_CEIL.toFixed(3)}；真掩膜 ${worstNew.toFixed(3)}（${(worstNew / CTL_CEIL).toFixed(1)}×）`);

  // ── 确定性：两个独立 World 的掩膜缓冲逐位相同；再跨进程问一次 color() ──
  const w2 = build();
  const A = new Float32Array(h), B2 = new Float32Array(w2.terrainMesh.geometry.attributes.aBlend.array);
  const sha = (ta) => createHash('sha256').update(Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength)).digest('hex');
  ok('M4 两个独立 World 的掩膜缓冲逐位相同（着色器读到的是同一份事实）', sha(A) === sha(B2), sha(A).slice(0, 12));
  // 跨进程那一条问的是另一个问题：**换一个 node 进程**（= 换一批模块实例、换一个
  // TileNoise 的构建时序）还同不同。源码保持纯 ASCII —— 这台机器上中文走 argv 出过
  // 静默变味的事故，判据自己不该再踩一次。
  const ROOTURL = 'file:///' + process.cwd().replace(/\\/g, '/') + '/';
  const SAMPLE = 'const pts=[];for(let k=0;k<4000;k++)pts.push([(k*13.7)%340-170,(k*7.1)%340-170,k%30,(k*0.11)%1.2]);';
  const CROSS_PROC_SRC = `import { installBrowserShim } from ${JSON.stringify(ROOTURL + 'server/browser-shim.mjs')};
installBrowserShim();
const { createHash } = await import('node:crypto');
const { color } = await import(${JSON.stringify(ROOTURL + 'js/maps/ridges.js')});
${SAMPLE}
const f = new Float32Array(pts.flatMap(([x,z,y,s]) => color(x,z,y,s).slice(3)));
console.log(createHash('sha256').update(Buffer.from(f.buffer)).digest('hex'));`;
  const local = (() => {
    const pts = []; for (let k = 0; k < 4000; k++) pts.push([(k * 13.7) % 340 - 170, (k * 7.1) % 340 - 170, (k % 30), ((k * 0.11) % 1.2)]);
    const f = new Float32Array(pts.flatMap(([x, z, y, s]) => color(x, z, y, s).slice(3)));
    return createHash('sha256').update(Buffer.from(f.buffer)).digest('hex');
  })();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CROSS_PROC_SRC], { encoding: 'utf8' });
  const remote = String(child.stdout || '').trim().split('\n').pop() || '';
  ok('M4b 跨进程 color() 权重逐位相同（权威端与客户端各烘一次，必须同一份）',
    remote.length === 64 && remote === local, `子进程 ${remote.slice(0, 12)} vs 本地 ${local.slice(0, 12)}`);
}

// ══════════════ M5 段：着色器接线（不碰 GL 也能验的那一半） ══════════════
{
  const w = build();
  const m = w.terrainMesh.material;
  ok('M5 地形材质装了 splat（userData.splat 在 = 安装函数真的被调过，不是写了没接）', !!m.userData.splat);
  const set = terrainSplatSet();
  const layers = ['grass', 'dirt', 'rock', 'scree', 'micro'];
  ok('M5b terrainSplatSet() 五层齐且每层都有 map+normalMap（缺层会静默少一层材质）',
    layers.every(k => set[k] && set[k].map && set[k].normalMap),
    layers.map(k => `${k}:${set[k] ? (set[k].map ? 'c' : '-') + (set[k].normalMap ? 'n' : '-') : 'none'}`).join(' '));
  ok('M5c 五层 stride 全在 1..32m 这个量级（stride 写错=贴图要么糊成一团要么密成刷子纹）',
    layers.every(k => SPLAT_STRIDE[k] > 1 && SPLAT_STRIDE[k] < 32), JSON.stringify(SPLAT_STRIDE));

  // onBeforeCompile 是纯字符串活：手工喂 three 的 meshphysical 源码就能验"六个锚点命中"。
  // three 升级改了 chunk 名/内容 → replace 静默不命中 → 画面与改动前逐字相同，
  // 而那正是"加了 splat 却没有任何东西变"的失效样子。hits 就是为这一条存在的。
  const sh = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} };
  m.onBeforeCompile(sh, {});
  const hits = m.userData.splat.hits || {};
  const miss = Object.entries(hits).filter(([, v]) => !v).map(([k]) => k);
  ok('M5d【先决】六个替换锚点全命中（补丁真的改了 GLSL，不是静默 no-op）',
    Object.keys(hits).length === 6 && miss.length === 0, miss.length ? `未命中 ${miss.join(',')}` : JSON.stringify(hits));
  ok('M5e 补丁后的 GLSL 里 aBlend 有声明也有赋值，且三个 chunk 没有残留 include',
    sh.vertexShader.includes('attribute vec3 aBlend') && sh.vertexShader.includes('vBlend = aBlend') &&
    !sh.fragmentShader.includes('#include <map_fragment>') && !sh.fragmentShader.includes('#include <normal_fragment_maps>'),
    `vFrag残留=${sh.fragmentShader.includes('#include <map_fragment>')}`);
  // 【反证臂】把材质换成一个没 map 的 —— 必须抛，不能安静地装上去然后画成全黑
  let threw = false;
  try { applyTerrainSplat(new THREE.MeshStandardMaterial(), set); } catch { threw = true; }
  ok('M5f【反证臂】缺 map/normalMap 时 applyTerrainSplat 当场抛（静默装上去就是全黑地面）', threw);
  let threw2 = false;
  try { applyTerrainSplat(new THREE.MeshStandardMaterial({ map: tx(), normalMap: tx() }), { grass: set.grass }); } catch { threw2 = true; }
  ok('M5g【反证臂】贴图集合缺层时当场抛（缺哪层报哪层，不许退成"少一层也没事"）', threw2);
  function tx() { return new THREE.Texture(); }

  // 对照臂开关必须真的接在 uniform 上：判据靠它在同一帧里 A/B。
  const on = m.userData.splat.uniforms.uSplatOn;
  m.userData.splat.setOn(false); const v0 = on.value;
  m.userData.splat.setOn(true); const v1 = on.value;
  ok('M5h setOn() 真的翻 uniform（对照臂要是假的，"两张图不同"就证明不了任何事）', v0 === 0 && v1 === 1);
  const mk = m.userData.splat.uniforms.uMicroK;
  m.userData.splat.setMicro(0); const m0 = mk.value;
  m.userData.splat.setMicro(0.32); const m1 = mk.value;
  ok('M5i setMicro() 真的翻细节强度（细节法线的判据要用它做对照）', m0 === 0 && m1 > 0);

  // 其余地图不许被拖进来：它们没有地形 → 没有掩膜 → 材质保持单层
  const wd = new World(mkGame(), MAPS.dune);
  MAPS.dune.build(wd, wd.game); wd.finalize();
  // 无地形的图压根不建这个网格（buildTerrainMesh 在 !T 时就 return 了）—— 所以这一条
  // 问的是"老图有没有被拖进新链路"，而不是"老图的地面还在不在"（那是 B 段管的事）。
  ok('M5j 既有地图（沙丘镇）根本没走地形网格这条路（改动是 opt-in，老图零暴露）',
    wd.terrain === null && wd.terrainMesh === undefined);
}

const bad = out.filter(([g]) => !g);
for (const [g, label] of out) console.log(`  ${g ? '✅' : '❌'} ${label}`);
console.log(`\n  ${bad.length ? 'RED' : 'GREEN'}  ${out.length - bad.length}/${out.length} 通过`);
process.exit(bad.length ? 1 : 0);
