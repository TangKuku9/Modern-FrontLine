// 服务端用的 headless game 对象 + 记录型替身。
//
// 为什么可行：js/ 下的 sim 类一律通过 constructor(game) 拿依赖（player.js:8、
// weapons.js:12、ai.js 同理），从不自建全局单例，所以只要注入一个形状匹配的
// game，整条 sim 就能在没有渲染器的进程里跑。
//
// 替身用 Proxy 而不是逐个手写方法名：漏掉一个方法就是运行时崩溃，
// 而 Proxy 保证"任何被调用的东西都不抛"，同时把调用记下来供测试断言。

export function deepRecorder(name = '', log = [], overrides = {}) {
  const fn = function () {};
  const cache = new Map();
  return new Proxy(fn, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return () => name;
      if (prop === 'then') return undefined;                 // 别被误认成 Promise
      if (prop === '__log') return log;
      if (prop === '__name') return name;
      const path = name ? name + '.' + String(prop) : String(prop);
      if (Object.prototype.hasOwnProperty.call(overrides, path)) {
        const v = overrides[path];
        return typeof v === 'function' ? v : v;
      }
      if (prop === 'value' || typeof prop === 'symbol') return undefined;
      if (!cache.has(path)) cache.set(path, deepRecorder(path, log, overrides));
      return cache.get(path);
    },
    set(_, prop, value) {
      log.push({ t: 'set', k: name + '.' + String(prop) });
      return true;
    },
    apply(_, __, args) {
      log.push({ t: 'call', k: name, n: args.length });
      return overrides[name] && typeof overrides[name] === 'function' ? overrides[name](...args) : undefined;
    },
  });
}

// sim 真正依赖其返回值的那几个，必须给真实行为而不是 undefined
const EFFECT_OVERRIDES = {
  'effects.smokeBlocks': () => false,
  'effects.texFlash': {},
  'effects.addFireSource': () => ({ pos: { x: 0, y: 0, z: 0 }, r: 0.5, t: 0, dur: 0 }),
  'effects.lights': [],
};

// extra：**每局一份**的覆盖项。默认那份 addFireSource 是个返回假对象的桩，而它一旦是桩，
// 燃烧瓶在权威端就一点伤害都没有（伤害回调写在那个函数的第四个参数里，桩不会去调它）。
// 想让火真的烧起来，就得把"这一局的火源列表"注入进来 —— 所以覆盖必须能按 game 实例给，
// 不能用模块级的表：一个进程跑多间房时，模块级的火源表会让 A 房的火烧到 B 房的人身上。
export function makeStubs(extra = {}) {
  const log = [];
  return {
    log,
    effects: deepRecorder('effects', log, { ...EFFECT_OVERRIDES, ...extra }),
    audio: deepRecorder('audio', log),
    hud: deepRecorder('hud', log),
    menu: deepRecorder('menu', log),
  };
}
