// 浏览器测试自带的临时权威服务。
//
// 为什么不能"事先手动在 8080 起一个"：那是给判据加了一个没人检查的外部条件。
// 实际踩过两次 —— 一次是 8080 上跑着**改动前**的旧代码，红得完全没有信息量；
// 一次是端口被别的进程占着。测试跑的是哪个版本的代码，必须由测试自己保证。
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// 让内核挑一个空闲端口再把它放掉（然后拿去 bind）。这里有一个理论上的竞态窗口，
// 但比"写死 8090"强得多 —— 后者在第二个测试同时跑时必然撞。
// 导出是因为 test/hardening.mjs 也要起进程（那一段要量**拒绝启动**，用不了 withServer）。
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

export async function withServer(env = {}) {
  const PORT = await freePort();
  const srv = spawn(process.execPath, ['server/net-server.mjs', String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 240 && !log.includes('权威对局服务'); i++) await new Promise(r => setTimeout(r, 50));
  if (!log.includes('权威对局服务')) { srv.kill(); throw new Error('临时服务没起来：\n' + log); }
  return {
    port: PORT,
    proc: srv,
    // 下线测试要等进程真的退了才能断言退出码，所以把"退出"这件事本身交出去
    exited: new Promise(res => srv.on('exit', (code, signal) => res({ code, signal }))),
    base: `http://127.0.0.1:${PORT}`,
    ws: `ws://127.0.0.1:${PORT}/ws`,
    log: () => log,
    kill: () => { try { srv.kill(); } catch { /* 已经自己退了 */ } },
  };
}
