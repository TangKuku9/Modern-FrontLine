// 地形 splat 着色器 —— 把"一张草贴图 × 逐顶点色"换成"按掩膜在 草/裸土/碎石/裸岩 四张
// 贴图之间混合 albedo + normal + 粗糙度"。
//
// 为什么必须是着色器而不是逐顶点色：three 的 `color_fragment` 是**乘**在
// `map_fragment` 取到的颜色上的，它改不了"用哪张法线、多粗糙"。所以把崖壁乘成灰色
// 只会得到"灰色的草纹" —— 眼睛判"这是岩壁"读的是高频明暗与裂隙走向，不是色相。
// 逐顶点色那一路（js/maps/ridges.js 的 color()）继续负责色调与磨损语义，掩膜由它一并
// 产出、走 `aBlend` 顶点属性（见 js/terrain.js 的 render()）。
//
// **确定性边界（这个仓库最要紧的一条线）**：本文件是**纯渲染侧**。它不改几何、不改
// height()/ray()/slope()，也不参与任何模拟输入。GLSL 里那个 sin 哈希随 GPU 精度变化，
// 而这里可以不在乎 —— 因为它画的每个像素都不回灌给模拟。写在这里是为了防止后来的人
// 顺手把它当"两端的共同事实"来读：把它接进模拟，就是分叉的开始。
//
// 打的是 MeshStandardMaterial 的补丁（onBeforeCompile），不是自造 ShaderMaterial：
// 这样阴影、雾、ACES 色调映射、环境光照、后处理全部照常走，只换掉"取贴图"那三段。
// 锚点是 three r169 的 chunk：map_fragment → color_fragment → roughnessmap_fragment →
// normal_fragment_begin → normal_fragment_maps（顺序在 ShaderLib/meshphysical.glsl.js，
// 后三段要复用第一段算出来的权重，所以**共享量一律声明在 map_fragment 那一段的函数作用域**）。
import * as THREE from 'three';

// 每层在世界尺度上多少米铺一张图。口径与 js/materials.js 的 texScale 同源
// （grass 6m / dirt 5m / rock 5m），但这里把 grass 放宽到 8m、rock 收到 4m：
// 360m 的图上 6m 一格会密到只剩刷子纹（maps.js 的 terrainStride 注释记过这一脚），
// 而崖面总共才几十米宽，5m 一格的岩图等于一面只有一两个裂隙周期，读不出"岩"。
export const SPLAT_STRIDE = { grass: 8, dirt: 6, scree: 4.5, rock: 4, micro: 2.2 };

// 各层粗糙度。差值要有 0.1 以上才读得出来，否则高光照一平，四层就退化成四层颜色。
const ROUGHNESS = { grass: 0.95, dirt: 0.92, scree: 0.88, rock: 0.72 };

const GLSL_PARS = /* glsl */ `
  uniform vec3 uSplatScale;      // 1/stride：x=grass, y=dirt, z=scree
  uniform float uRockStride;
  uniform float uMicroStride;
  uniform float uMicroK;         // 细节法线强度（0 = 关掉；判据的对照臂用它）
  uniform float uMicroFade;      // 细节开始淡出的视距（米）
  uniform float uWarpK;          // 高频域翘曲幅度（把等高线边界撕成犬牙）
  uniform float uSplatOn;        // 0 = 退回单层草贴图（同一 program 内的 A/B 开关）
  uniform float uRghGrass;
  uniform float uRghDirt;
  uniform float uRghScree;
  uniform float uRghRock;
  uniform sampler2D uTexDirt;  uniform sampler2D uNrmDirt;
  uniform sampler2D uTexScree; uniform sampler2D uNrmScree;
  uniform sampler2D uTexRock;  uniform sampler2D uNrmRock;
  uniform sampler2D uNrmMicro;
  varying vec3 vBlend;
  varying vec3 vTerrPos;
  float tshHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float tshNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(tshHash(i), tshHash(i + vec2(1.0, 0.0)), f.x),
               mix(tshHash(i + vec2(0.0, 1.0)), tshHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

// 共享量：权重、世界平面坐标、三向投影的轴权重。全部声明在 main() 的函数作用域里，
// 后面的 roughnessmap_fragment / normal_fragment_maps 直接复用 —— 不要再各自重算一遍，
// 那样三层之间会出现"色用翘曲后的权重、法线用没翘曲的权重"这种肉眼难查的错位。
const FRAG_MAP = /* glsl */ `
  vec3 tW = clamp(vBlend, 0.0, 1.0);
  // 高频域翘曲：JS 那侧的掩膜只有 2m 分辨率（CELL=2），边界在贴图上仍读得出"一圈"。
  // 这里按世界坐标再抖一次（波长 ~6m）把边界打碎。两层叠加是有意的：
  // 大形状归地图作者（可判据、两端一致），细碎边归着色器（纯视觉、不进模拟）。
  float tWarp = (tshNoise(vTerrPos.xz * 0.17) - 0.5) * uWarpK;
  tW.x = clamp(tW.x + tWarp, 0.0, 1.0);
  tW.y = clamp(tW.y - tWarp * 0.6, 0.0, 1.0);
  float tGrass = max(0.0, 1.0 - tW.x - tW.y - tW.z);
  vec2 tPlanar = vTerrPos.xz;
  // 三向投影的轴权重。**不是 pow(|n|, 8) 那种"选主导轴"** —— 实拍证明那会在两个轴
  // 等强的地方留下一道硬折线：俯瞰图上那条横贯鞍部的条纹就是它，沿 |nx|=|nz| 那条线
  // 贴图整面跳一次。改成"先收窄、再平方、再归一"，两个投影在过渡带里**叠**过去，
  // 代价是带内有轻微重影（岩贴图本来就碎，看不出），换来的是没有缝。
  vec3 tAbsN = abs(normalize(vNormal));
  vec3 tAxis = max(tAbsN - 0.3, vec3(0.0));
  tAxis = tAxis * tAxis;
  float tAxisSum = max(tAxis.x + tAxis.y + tAxis.z, 1e-4);

  vec4 sampledDiffuseColor = vec4(texture2D(map, tPlanar * uSplatScale.x).rgb, 1.0);
  // 对照臂 + 单层快路径：开关关掉，或者这一格本来就没掩膜（大片平地的多数像素走这里），
  // 就退化成"一张草贴图" —— 与改动前逐字同一件事。
  bool tBlend = uSplatOn > 0.5 && (tW.x + tW.y + tW.z) > 0.002;
  if (tBlend) {
    if (tW.z > 0.002) sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb,
      texture2D(uTexDirt, tPlanar * uSplatScale.y).rgb, tW.z);
    if (tW.y > 0.002) sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb,
      texture2D(uTexScree, tPlanar * uSplatScale.z).rgb, tW.y);
    if (tW.x > 0.002) {
      // 裸岩走三向投影：陡面上用 XZ 铺贴图等于把纹理沿坡拉长成面条，那正是"塑料崖"的成因。
      vec2 rZy = vec2(vTerrPos.z, vTerrPos.y) / uRockStride;   // 法线沿 X 的面
      vec2 rXy = vec2(vTerrPos.x, vTerrPos.y) / uRockStride;   // 法线沿 Z 的面
      vec4 tRock =
        texture2D(uTexRock, tPlanar / uRockStride) * (tAxis.y / tAxisSum) +
        texture2D(uTexRock, rZy) * (tAxis.x / tAxisSum) +
        texture2D(uTexRock, rXy) * (tAxis.z / tAxisSum);
      sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, tRock.rgb, tW.x);
    }
  }
  diffuseColor *= sampledDiffuseColor;
`;

const FRAG_NORMAL = /* glsl */ `
  #if defined( USE_NORMALMAP_TANGENTSPACE )
    vec3 tMapN = texture2D(normalMap, tPlanar * uSplatScale.x).xyz * 2.0 - 1.0;
    if (tBlend) {
      if (tW.z > 0.002) tMapN = mix(tMapN, texture2D(uNrmDirt, tPlanar * uSplatScale.y).xyz * 2.0 - 1.0, tW.z);
      if (tW.y > 0.002) tMapN = mix(tMapN, texture2D(uNrmScree, tPlanar * uSplatScale.z).xyz * 2.0 - 1.0, tW.y);
      if (tW.x > 0.002) {
        // 三向法线在这里**不做轴换系**，直接在同一套切线空间里加权平均。理由：换系要引入
        // 与视图相关的基变换，一旦和 tbn 的来源（normal_fragment_begin 按 vNormalMapUv 的
        // 屏幕导数构造）不一致，斜面上就会出现"高光在爬"的错 —— 那比细节略糊难看得多。
        // pow(8) 的锐化已经让主导项占掉绝大部分权重，代价只落在两个轴等强的棱上。
        vec3 tRockN =
          (texture2D(uNrmRock, tPlanar / uRockStride).xyz * 2.0 - 1.0) * (tAxis.y / tAxisSum) +
          (texture2D(uNrmRock, vec2(vTerrPos.z, vTerrPos.y) / uRockStride).xyz * 2.0 - 1.0) * (tAxis.x / tAxisSum) +
          (texture2D(uNrmRock, vec2(vTerrPos.x, vTerrPos.y) / uRockStride).xyz * 2.0 - 1.0) * (tAxis.z / tAxisSum);
        tMapN = normalize(mix(tMapN, tRockN, tW.x));
      }
      // 细节法线：高频颗粒只在近处给满，超过 uMicroFade 视距线性退场。
      // 不退场的话，2.2m 一格的高频图在远处会抖成一层随镜头游走的雪花（mipmap 救不了
      // 这种"每米采样数远高于底图"的层）。
      float tNear = 1.0 - smoothstep(uMicroFade, uMicroFade * 2.2, length(vViewPosition));
      if (uMicroK > 0.0 && tNear > 0.001) {
        vec3 tMic = texture2D(uNrmMicro, tPlanar / uMicroStride).xyz * 2.0 - 1.0;
        tMapN = normalize(tMapN + vec3(tMic.xy, 0.0) * (uMicroK * tNear));
      }
    }
    tMapN.xy *= normalScale;
    // 地形材质是 FrontSide，所以这里不复现 DOUBLE_SIDED/FLIP_SIDED 的翻法线。
    // 哪天要把它用在双面网格上，得补回来。
    normal = normalize(tbn * tMapN);
  #endif
`;

const FRAG_ROUGH = /* glsl */ `
  float roughnessFactor = roughness;
  #ifdef USE_ROUGHNESSMAP
    roughnessFactor *= texture2D(roughnessMap, vRoughnessMapUv).g;
  #endif
  // 权重按归一化后的占比混，所以 tW 被翘曲推过 1 也不会整体变暗/变亮。
  if (tBlend) {
    float tRgh = (uRghGrass * tGrass + uRghDirt * tW.z + uRghScree * tW.y + uRghRock * tW.x)
      / max(tGrass + tW.x + tW.y + tW.z, 1e-4);
    roughnessFactor *= tRgh;
  }
`;

/**
 * 给地形材质装 splat。只在几何带 aBlend 属性、且材质同时有 map 与 normalMap 时调用
 * （补丁替三段 chunk 取样，全都直接摸 `map` / `normalMap` / `tbn`，缺一个就是编译错误）。
 * @param {THREE.Material} material 会被就地打补丁；调用方负责 clone，别污染共用材质
 * @param {object} set  materials.js 的 terrainSplatSet()：{ grass, dirt, rock, scree, micro }
 * @param {object} opt  可覆盖 stride / microK / microFade / warpK
 */
export function applyTerrainSplat(material, set, opt = {}) {
  if (!material.map || !material.normalMap) throw new Error('applyTerrainSplat: 材质缺 map/normalMap');
  const stride = Object.assign({}, SPLAT_STRIDE, opt.stride || {});
  const miss = ['grass', 'dirt', 'rock', 'scree', 'micro'].filter(k => !set || !set[k] || !set[k].map || !set[k].normalMap);
  if (miss.length) throw new Error('applyTerrainSplat: 缺贴图 ' + miss.join(','));

  const u = {
    uSplatScale: { value: new THREE.Vector3(1 / stride.grass, 1 / stride.dirt, 1 / stride.scree) },
    uRockStride: { value: stride.rock },
    uMicroStride: { value: stride.micro },
    // micro 的法线本来就给到了最高强度（实测 x/y 通道标准差 ≈72/255，是 grass 的 2 倍多，
    // z 均值只到 199.7 —— 已经很不平）。这里再叠 0.5 以上就会把地面磨成毛毡，所以起点压低。
    uMicroK: { value: opt.microK ?? 0.32 },
    uMicroFade: { value: opt.microFade ?? 28 },
    uWarpK: { value: opt.warpK ?? 0.34 },
    uSplatOn: { value: 1 },
    uRghGrass: { value: ROUGHNESS.grass },
    uRghDirt: { value: ROUGHNESS.dirt },
    uRghScree: { value: ROUGHNESS.scree },
    uRghRock: { value: ROUGHNESS.rock },
    uTexDirt: { value: set.dirt.map }, uNrmDirt: { value: set.dirt.normalMap },
    uTexScree: { value: set.scree.map }, uNrmScree: { value: set.scree.normalMap },
    uTexRock: { value: set.rock.map }, uNrmRock: { value: set.rock.normalMap },
    uNrmMicro: { value: set.micro.normalMap },
  };
  // hits 是"补丁真的命中了吗"的读数，判据直接读它。onBeforeCompile 是字符串替换，
  // three 升级改了 chunk 名或内容，replace 会**静默不命中** —— 症状是"画面和改动前
  // 一模一样"，而这恰好就是对照臂失效的样子。所以命中与否必须可编程地知道。
  material.userData.splat = {
    setOn: (on) => { u.uSplatOn.value = on ? 1 : 0; },
    setMicro: (k) => { u.uMicroK.value = k; },
    uniforms: u,
    hits: null,
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    const vs = shader.vertexShader
      .replace('varying vec3 vViewPosition;', 'varying vec3 vViewPosition;\nattribute vec3 aBlend;\nvarying vec3 vBlend;\nvarying vec3 vTerrPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBlend = aBlend;\n  vTerrPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const fs = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_PARS)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH);
    material.userData.splat.hits = {
      vsAttr: vs.includes('attribute vec3 aBlend'),
      vsMain: vs.includes('vTerrPos = (modelMatrix'),
      fsPars: fs.includes('tshNoise'),
      fsMap: fs.includes('sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, tRock.rgb'),
      fsNormal: fs.includes('tMapN = normalize(mix(tMapN, tRockN'),
      fsRough: fs.includes('roughnessFactor *= tRgh'),
    };
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => 'mwTerrainSplat';
  material.needsUpdate = true;
  return material;
}
