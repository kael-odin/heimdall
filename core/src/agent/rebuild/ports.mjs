/**
 * rebuild/ports — 给重建工作区挑一个真正能监听的 dev server 端口。
 *
 * `rebuild init` 过去固定 5199；同一台机器上已经有一个演示项目时，新工作区
 * 会拿到一个被占用的端口，直到 `node serve.mjs` 启动才报错。这里只做两件事：
 *   portAvailable(port)        当前端口能否在本机回环上监听
 *   findFreePort(start, limit) 从 start 起找第一个能监听的端口
 * 显式传 --port 时不偷偷换端口：占用就报错，让调用者决定。
 */
import { createServer } from 'node:net';

export function portAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    const done = (ok) => { try { server.close(); } catch {} resolve(ok); };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try { server.listen(port, '127.0.0.1'); } catch { done(false); }
  });
}

export async function findFreePort(start = 5199, limit = 50) {
  for (let port = start; port < start + limit; port++) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`从 ${start} 起连续 ${limit} 个端口都被占用`);
}
