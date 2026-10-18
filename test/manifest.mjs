// 测试清单：一套判据只在这里登记一次，各档脚本与 runner 都从它取。
// 浏览器的判断仍从源码推（docs-guard E/G 段），不在这份清单里手抄。
const t = (file, opts = {}) => ({ file, ...opts });

export const NODE = [
  t('server/gate.mjs', { prereq: true }),
  t('test/docs-guard.mjs'),
  t('test/rollback.mjs'),
  t('test/reconcile-chain.mjs'),
  t('test/world-equiv.mjs'),
  t('test/terrain.mjs'),
  t('test/props.mjs'),
  t('test/terrainmat.mjs'),
  t('test/worker-core.mjs'),
  t('test/preload-graph.mjs'),
  t('test/net-journal.mjs'),
  t('test/stance-recoil.mjs'),
  t('server/codec.mjs'),
  t('server/lagcomp.mjs'),
  t('test/lagcomp.mjs'),
  t('test/mp-rules.mjs'),
  t('test/accounts.mjs', { nodeArgs: ['--disable-warning=ExperimentalWarning'] }),
  t('test/progress.mjs'),
  t('test/hardening.mjs'),
  t('test/service-guards.mjs'),
  t('test/room-flow.mjs'),
  t('test/room-bots.mjs'),
  t('test/room-dir.mjs'),
  t('test/image.mjs'),
  t('server/net-probe.mjs'),
  t('server/deploy-probe.mjs'),
  t('test/net-feel.mjs'),
  t('test/net-audit.mjs'),
  t('test/heli-armor.mjs'),
  t('test/hud-ux.mjs'),
];

const BROWSER = [
  t('server/xenv.mjs', { needsGate: true }),
];

// 视觉判据只在浏览器档跑：它们要真 Chrome，且在默认主体档里占了八成浏览器时间。
// net-drop 自带 A–D/J 分段开关；E/F/G/H/I 已在测试瘦身中移除，
// 房间流程、账号闸、补人 UI 与恢复码 UI 的对应覆盖见 README《验收》的分工说明。
const BROWSER_EXTRA = [
  t('test/fps.mjs'),
  t('test/viewmodel.mjs'),
  t('test/optic.mjs'),
  t('test/state-leak.mjs'),
  t('test/net-drop.mjs'),
  t('test/net-play.mjs'),
  t('test/tab-session.mjs'),
  t('test/worker-live.mjs'),
  t('test/hud-keys.mjs'),
  t('test/terrainmat-gl.mjs'),
];

const SMOKE = [
  'server/gate.mjs',
  'test/docs-guard.mjs',
  'server/codec.mjs',
  'test/rollback.mjs',
  'test/mp-rules.mjs',
  'test/hud-ux.mjs',
];

export const TIERS = {
  test: { node: NODE, browser: BROWSER },
  'test:fast': { node: NODE, browser: [] },
  'test:browser': { node: [], browser: BROWSER_EXTRA },
  'test:all': { node: NODE, browser: [...BROWSER, ...BROWSER_EXTRA] },
  'test:smoke': { node: SMOKE.map(f => NODE.find(x => x.file === f)), browser: [] },
};

export function tierFiles(tier) {
  const t = TIERS[tier];
  if (!t) throw new Error(`没有这一档：${tier}`);
  return [...t.node, ...t.browser];
}
