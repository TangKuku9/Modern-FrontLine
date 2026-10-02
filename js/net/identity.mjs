// 「这一杀里谁是谁」——**cid 优先、名字兜底**这一条纪律的唯一一份实现。
//
// 为什么单独一份：它有两个调用点（击杀播报、死亡镜头），而两处各写一遍的症状不同、
// 却都不报错：
//   · 播报写错 ⇒ 别人的击杀被画成"我拿的"（弹窗 + 音效 + 记分），而真正的击杀者
//     那一台什么都不显示；
//   · 死亡镜头写错 ⇒ 镜头转向另一个**同名**的人，指一个假方向。
// 更基础的一条：访客服上重名是允许的（不填呼号都叫"访客"，自报呼号也没有唯一性约束），
// 所以**名字根本不是身份**。权威端在 server/room.mjs:onKill 里把 cid 补在 kill 事件上
// （它手上正好有那两个对象），下游一律先认 cid。
//
// 为什么抽得出来：这两个函数只读事件 + 一张远端表，不碰任何 DOM 与 WebGL ——
// 而 js/main.js 的 Game 构造要 WebGL、也不导出，判据伸不进去。抽出来之后
// test/net-audit.mjs 的 F 段能直接喂合成事件把"同名不串"量出来。
//
// ctx = { myCid, myName, myTeam, remotes }（remotes 是 cid → 远端玩家的 Map）。

// 击杀播报要的那两个"实体"：hud.killfeed 只读 .name / .isPlayer / .team 三格，
// 所以这里造同形的轻量对象，而不是把 NetPlayer 塞回去（改 HUD 的签名会让单机那条路一起动）。
export function killfeedIdent(ev, ctx) {
  const { myCid = null, myName = null, myTeam = null, remotes = null } = ctx || {};
  const mk = (name, cid) => {
    // 是不是我：cid 拿得到就只认 cid（同名不串）；拿不到（Bot 击杀 / 老服务端）才认名字。
    const isPlayer = cid != null ? cid === myCid : (name != null && name === myName);
    // 队伍：**cid 拿得到时不许退回名字**。退回名字就是"同名者互相冒充"那个形状本身，
    // 而这条纪律的全部意义就是不许它出现 —— 刚进来还没有快照的人（remotes 里查不到）
    // 宁可留空(null，渲染成敌色)，也不能拿同名的另一个人顶上。
    // 我自己一律用自己的队伍：同名的那个"访客"完全可能在对面（这正是要防的场面）。
    const other = isPlayer ? null
      : (cid != null
        ? ((remotes && remotes.get) ? remotes.get(cid) : null)
        : findByName(remotes, name));
    return { name, isPlayer, team: isPlayer ? myTeam : (other ? other.team : null) };
  };
  return { killer: mk(ev.killer, ev.killerCid ?? null), victim: mk(ev.victim, ev.victimCid ?? null) };
}

// 死亡镜头要转过去的那个远端玩家。找不到（哨戒机枪 / 直升机 / 人已经走了）返回 null ——
// 那条路只有沉镜头，**指一个假方向比不指更糟**。
export function killerRemote(ev, ctx) {
  const { remotes = null } = ctx || {};
  if (!remotes) return null;
  if (ev.killerCid != null && remotes.get) return remotes.get(ev.killerCid) || null;
  return findByName(remotes, ev.killer);
}

function findByName(remotes, name) {
  if (!name || !remotes || !remotes.values) return null;
  for (const r of remotes.values()) if (r.name === name) return r;
  return null;
}
