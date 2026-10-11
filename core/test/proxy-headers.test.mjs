/**
 * 代理响应头：往客户端回上游头
 *
 * 为什么值得单独盯一条测试：这里踩过一次**静默**的坑 —— `res.writeHead(200, headers)`
 * 传 WHATWG Headers 不报错、状态码也对，只是所有头被丢掉。表现是"个别图挂了"
 * （PNG 靠魔数嗅探还能渲染），真因却是 Content-Type 全没 → 模块脚本被浏览器以
 * `MIME type of ""` 拒绝 → 交互镜像的 JS 从来没跑起来过。这种事只有断言才拦得住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeProxyHead, mirrorHostOf } from '../src/proxy-headers.mjs';

/** 起一个只吐一次响应的服务，返回 {url, upstreamHeaders} */
async function serveOnce(build) {
  const server = createServer((req, res) => build(res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

const fromUpstream = (pairs) => {
  const h = new Headers();
  for (const [k, v] of pairs) h.append(k, v);
  return h;
};

test('writeProxyHead：Content-Type 必须活下来（丢它就是 JS 全不执行的那个坑）', async () => {
  const s = await serveOnce((res) => {
    writeProxyHead(res, 200, fromUpstream([['content-type', 'text/javascript; charset=utf-8']]));
    res.end('export default 1');
  });
  try {
    const r = await fetch(s.url);
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
  } finally { s.close(); }
});

test('writeProxyHead：其余自定义头一并透传，状态码不被改写', async () => {
  const s = await serveOnce((res) => {
    writeProxyHead(res, 404, fromUpstream([
      ['content-type', 'text/html'], ['etag', '"abc"'], ['cache-control', 'public,max-age=0,must-revalidate'],
    ]));
    res.end('nope');
  });
  try {
    const r = await fetch(s.url);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('etag'), '"abc"');
    assert.equal(r.headers.get('cache-control'), 'public,max-age=0,must-revalidate');
  } finally { s.close(); }
});

test('writeProxyHead：多条 set-cookie 保持为多条（拼成一条会让登录态失效）', async () => {
  const s = await serveOnce((res) => {
    writeProxyHead(res, 200, fromUpstream([
      ['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2; Path=/'],
    ]));
    res.end('ok');
  });
  try {
    const cookies = (await fetch(s.url)).headers.getSetCookie();
    assert.deepEqual(cookies, ['a=1; Path=/', 'b=2; Path=/']);
  } finally { s.close(); }
});

test('前提断言：writeHead 直接收 Headers 就是会全丢（Node 的既有行为，不是我们的 bug）', async () => {
  const s = await serveOnce((res) => {
    const h = new Headers();
    h.set('content-type', 'text/plain');
    res.writeHead(200, h);           // 故意的：这是反面写法
    res.end('ok');
  });
  try {
    const r = await fetch(s.url);
    assert.equal(r.status, 200, '状态码照样是对的 —— 所以它才安静');
    assert.equal(r.headers.get('content-type'), null, 'Node 哪天支持了 Headers，这条会红，提醒改注释与实现');
  } finally { s.close(); }
});

test('mirrorHostOf：完整域名当子域，能无损还原原站 host', () => {
  assert.equal(mirrorHostOf('vitest.dev.localhost'), 'vitest.dev');
  assert.equal(mirrorHostOf('vitest.dev.localhost:8900'), 'vitest.dev');
  assert.equal(mirrorHostOf('WWW.Example.COM.localhost'), 'www.example.com');
});

test('mirrorHostOf：控制台自己的地址不能被当成镜像站', () => {
  for (const h of ['127.0.0.1:8900', 'localhost:8900', 'localhost', '[::1]:8900', '']) {
    assert.equal(mirrorHostOf(h), null, `${h} 不该被解析成镜像站`);
  }
});
