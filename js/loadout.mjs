// 进场装备闸门：客户端递交的只是"选了什么"，服务端按同一份表把它重建一遍。
//
// 这份文件放在 js/ 而不是 server/，因为两端都要用它（js/quant.js 是同一个先例）：
// 服务端拿它裁决进场（server/room.mjs），浏览器拿它修存档里读出来的职业卡
// （js/main.js 的 Game 构造函数）。两端各写一份"什么算合法"，迟早会变成两套答案。
//
// 拦之前这三件事都是一条 join 帧就能做到的：
//   1) 投掷物数量 —— js/player.js 的 equip 用 loadout.extraLethal / extraTac 直接加弹药，
//      客户端填 1e9 就是无限手雷；填 'x' 则把 count 变成字符串，之后每次消耗都在做 NaN。
//   2) 武器本身 —— 不查表的话任何 WEAPONS 里的枪都能当主武器带，配装规则（比如"火力过载"
//      才允许第二把主武器）只存在于菜单里，等于没规则。
//   3) 崩溃半径 —— WEAPONS[未知 id] 会让 computeStats 抛 TypeError。join 那一层有 try/catch
//      兜得住，但"一个人的坏数据打死一屋子人"正是部署前必须堵的同一类洞（见 deploy-probe 里
//      那个 200 KB 帧打死全服的先例）。
//
// 做法是白名单重建，不是校验：字段一个个挑出来组装，未知字段（含 extraLethal/extraTac）天生
// 进不去。黑名单要跟着客户端每次加字段更新，白名单不用。
//
// 客户端的合法选择必须原样通过 —— 判据在 server/deploy-probe.mjs 的"闸门不能砍到正门"那几条：
// 五套预设职业逐一等值，任何被改动的地方都会让服务端和客户端算出两套 stats，那是要以
// "预测偏差"的形式浮出来的（本地按自己那套打，权威按另一套裁决）。
import {
  WEAPONS, PRIMARY_ORDER, SECONDARY_ORDER, ATTACHMENTS, CAMOS, PERKS, LETHALS, TACTICALS,
  DEFAULT_CLASSES, attachmentAllowed, findAttachment,
} from './data.js';

const PERK_IDS = new Set(PERKS.flat().map(p => p.id));
const CAMO_IDS = new Set(CAMOS.map(c => c.id));
const LETHAL_IDS = new Set(LETHALS.map(l => l.id));
const TACTICAL_IDS = new Set(TACTICALS.map(t => t.id));
const ATT_SLOTS = Object.keys(ATTACHMENTS);       // 只有这些槽位有配件表
const MAX_PERKS = 3;                              // 配装菜单是一列一个，共三列

const pick = (v, allowed, fallback) => (typeof v === 'string' && allowed.has(v)) ? v : fallback;

function gun(raw, allowedIds, fallbackId) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = pick(r.id, allowedIds, fallbackId);
  const w = WEAPONS[id];
  const src = r.att && typeof r.att === 'object' && !Array.isArray(r.att) ? r.att : {};
  const att = {};
  for (const slot of ATT_SLOTS) {
    if (!w.slots.includes(slot)) continue;         // 这支枪没有这个槽
    const a = findAttachment(slot, src[slot]);      // 配件 id 必须在那一槽的表里
    if (a && attachmentAllowed(id, slot, a)) att[slot] = a.id;
  }
  return { id, att, camo: pick(r.camo, CAMO_IDS, 'none') };
}

// 职业卡（profile.classes 的元素）用的是扁形状：primary/patt/pcamo + secondary/satt/scamo。
// 转成网络形状过一遍闸门再转回去；非 id 的字段（name、extraLethal 这类单人玩法里的量）
// 原样留着 —— 这里要挡的是"一个不存在的枪 id 把菜单打死"，不是单人玩法的数值。
export function repairClass(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return JSON.parse(JSON.stringify(DEFAULT_CLASSES[0]));
  const s = sanitizeLoadout({
    primary: { id: c.primary, att: c.patt || {}, camo: c.pcamo || 'none' },
    secondary: c.secondary ? { id: c.secondary, att: c.satt || {}, camo: c.scamo || 'none' } : null,
    lethal: c.lethal, tactical: c.tactical, perks: c.perks || [],
  });
  const out = { ...c, primary: s.primary.id, patt: s.primary.att, pcamo: s.primary.camo,
    lethal: s.lethal, tactical: s.tactical, perks: s.perks,
    // 修完的卡一定带一把副武器：菜单里五处以上直接读 WEAPONS[k.secondary].name，而配装界面
    // 本来就没法把副武器去掉 —— 没有副武器的卡只可能来自手改的存档，给它补一把默认手枪，
    // 比在五个地方各加一次可选链更便宜，也不会漏。
    secondary: s.secondary.id, satt: s.secondary.att, scamo: s.secondary.camo };
  return out;
}

export function sanitizeLoadout(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const perks = [];
  if (Array.isArray(r.perks)) {
    for (const p of r.perks) {
      if (typeof p === 'string' && PERK_IDS.has(p) && !perks.includes(p)) perks.push(p);
      if (perks.length >= MAX_PERKS) break;
    }
  }
  const primary = gun(r.primary, new Set(PRIMARY_ORDER), 'm4');
  // 副武器的可选范围和菜单规则一致（js/menu.js:378）：带"火力过载"才能拿第二把主武器
  const secIds = new Set(perks.includes('overkill')
    ? [...SECONDARY_ORDER, ...PRIMARY_ORDER.filter(x => x !== primary.id)] : SECONDARY_ORDER);
  let secondary = gun(r.secondary, secIds, 'm1911');
  if (secondary.id === primary.id) secondary = gun({}, secIds, 'm1911');
  return {
    primary, secondary,
    lethal: pick(r.lethal, LETHAL_IDS, 'frag'),
    tactical: pick(r.tactical, TACTICAL_IDS, 'flash'),
    perks,
  };
}

// 这个人手上那两把枪各自的配件与迷彩 —— 远端玩家的模型按它建（差距清单 29）。
// 真相在装备表里（服务端净化后的那份 loadout），所以它跟着 welcome/join/respawn
// 那三条**已经带着 loadout** 的接缝走，不另开一条协议字段：技能表（perks）就是
// 同一个做法。两端共用这一个函数算同一张表，客户端就不可能算出第二份答案。
// 按武器 id 索引（不是"当前那把"）：快照里换枪只有 1 字节的武器号，模型要能随时
// 按手上的枪查到它自己的配件 —— 只同步"当前那把"的话，切一下手枪就丢。
export function kitsOf(lo) {
  const out = {};
  if (!lo) return out;
  for (const g of [lo.primary, lo.secondary]) {
    if (g && g.id) out[g.id] = { att: { ...(g.att || {}) }, camo: g.camo || 'none' };
  }
  return out;
}
