/**
 * 控制台里"交互镜像"入口必须指向**引擎**，不是控制台自己。
 *
 * 这条守卫来自一次实测：dev 下控制台跑在 Vite（:5173），镜像由引擎（:8900）提供。
 * 按 `location` 拼出的 `<host>.localhost:5173` 会打到 Vite，返回控制台自己的 SPA 首页。
 * 引擎地址在 api.js 里已经是唯一事实来源（含用户在设置里改过的地址），
 * 镜像入口复用它 —— 这一条钉住"用的是 API 而不是 location"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// pages.js → api.js 在**模块顶层**读 localStorage 与 location，必须先铺好再 import
let savedToken = '';
globalThis.localStorage = { getItem: key => key === 'heimdall-token' ? savedToken : null };
globalThis.location = { port: '5173', protocol: 'http:', origin: 'http://127.0.0.1:5173', hostname: '127.0.0.1' };

const { liveUrl, mirrorBridgeNeeded, openMirrorWithTicket, pageNameOf, pagePathOf, normalizeSiteUrl, normalizePageUrl, workspaceHostOf } = await import('../../console/src/pages.js');

test('liveUrl 指向引擎端口，不是控制台端口', () => {
  const u = liveUrl({ url: 'https://apify.com/store' });
  assert.equal(new URL(u).origin, 'http://127.0.0.1:8900');
  assert.equal(new URL(u).pathname, '/api/mirror-launch');
  assert.equal(new URL(u).searchParams.get('url'), 'https://apify.com/store/');
  assert.doesNotMatch(u, /:5173/, 'dev 下按控制台端口拼出来的地址会打到 Vite 上（拿到 SPA 首页）');
});

test('Token 模式主入口通过引擎授权，目标路径与查询仍供独立子域使用', () => {
  savedToken = 'test-token';
  try {
    assert.equal(mirrorBridgeNeeded(), true, '控制台与引擎同主机不同端口时仍需带请求头领票');
    const page = { url: 'https://apify.com/store?page=2' };
    const launch = new URL(liveUrl(page));
    assert.equal(launch.origin, 'http://127.0.0.1:8900');
    assert.equal(launch.pathname, '/api/mirror-launch');
    assert.equal(launch.searchParams.get('url'), 'https://apify.com/store/?page=2');
    assert.doesNotMatch(launch.href, /test-token/);
  } finally { savedToken = ''; }
  const launch = new URL(liveUrl({ url: 'https://apify.com/store?page=2' }));
  assert.equal(launch.searchParams.get('url'), 'https://apify.com/store/?page=2');
});

test('openMirrorWithTicket 使用服务端 siteId，并校验来源与票据地址', async () => {
  savedToken = 'test-token';
  const replaced = [];
  const closed = [];
  globalThis.window = {
    open() {
      const popup = { closed: false, opener: null, location: { replace(url) { replaced.push(url); } } };
      popup.close = () => { popup.closed = true; closed.push(true); };
      return popup;
    },
    location: { assign() {} },
  };
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      url: 'http://fixture.test--origin-abcdef0123456789.localhost:8900/.heimdall/session?ticket=ticket-1',
      siteId: 'fixture.test--origin-abcdef0123456789',
      origin: 'https://fixture.test:8443',
    }) });
    await openMirrorWithTicket({ url: 'https://fixture.test:8443/docs?page=2' });
    assert.equal(replaced[0], 'http://fixture.test--origin-abcdef0123456789.localhost:8900/.heimdall/session?ticket=ticket-1');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      url: 'http://fixture.test.localhost:8900/.heimdall/session?ticket=ticket-2',
      siteId: 'fixture.test',
      origin: 'https://other.test',
    }) });
    await assert.rejects(
      () => openMirrorWithTicket({ url: 'https://fixture.test/docs' }),
      /来源与目标不一致/,
    );
    assert.ok(closed.length >= 1, '无效响应应关闭已打开的窗口');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      url: 'http://fixture.test.localhost:8900/.heimdall/session?ticket=ticket-3',
      siteId: '../fixture.test',
      origin: 'https://fixture.test',
    }) });
    await assert.rejects(
      () => openMirrorWithTicket({ url: 'https://fixture.test/docs' }),
      /无效的站点标识/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.window;
    savedToken = '';
  }
});

test('目录型路径补尾斜杠（URL 的"基目录"是最后一个 / 之前的部分）', () => {
  assert.equal(new URL(liveUrl({ url: 'https://vitest.dev/' })).searchParams.get('url'), 'https://vitest.dev/');
  assert.equal(new URL(liveUrl({ url: 'https://x.test/docs' })).searchParams.get('url'), 'https://x.test/docs/');
  assert.equal(new URL(liveUrl({ url: 'https://x.test/a.html' })).searchParams.get('url'), 'https://x.test/a.html', '文件型路径不加');
});

test('非法 URL 返回 #，不抛', () => {
  assert.equal(liveUrl({ url: 'nonsense' }), '#');
});

test('已有产物总是使用引擎返回的目录名', () => {
  assert.equal(pageNameOf({ url: 'https://x.test/customers/anthropic' }), 'customers-anthropic');
  assert.equal(pageNameOf({ url: 'https://x.test/' }), 'home');
  assert.equal(pageNameOf({ url: 'https://x.test/a/b', pageName: 'a-b--1234' }), 'a-b--1234');
});

/**
 * 站点级 vs 页面级的地址归一 —— 这两件事必须分开，它们曾经是同一个函数。
 *
 * 实测的事故：`normalizeUrl` 返回 `new URL(s).origin`，而「只克隆此页」也复用了它。
 * 于是输入框里填 `apify.com/store`，点下去克隆的是 `apify.com/`（首页）——
 * 标签写着"这一个页面"，代码却拿走整站根，而且不报错：直到你在「进行中」轨道上
 * 看到目标写着 `apify.com/home` 才发现。侦察该用站点级（路径无意义），克隆该用页面级。
 */
test('normalizeSiteUrl：只留 origin（侦察按站点跑）', () => {
  assert.equal(normalizeSiteUrl('apify.com/store'), 'https://apify.com');
  assert.equal(normalizeSiteUrl('https://www.apify.com/a/b?c=1#d'), 'https://www.apify.com');
  assert.equal(normalizeSiteUrl('  apify.com  '), 'https://apify.com');
  assert.equal(normalizeSiteUrl(''), '');
  assert.equal(normalizeSiteUrl('http://'), '');
});

test('normalizePageUrl：保留路径（「只克隆此页」按整条地址走）', () => {
  assert.equal(normalizePageUrl('apify.com/store'), 'https://apify.com/store');
  assert.equal(normalizePageUrl('https://linear.app/build/ai'), 'https://linear.app/build/ai');
  assert.equal(normalizePageUrl('apify.com/#x'), 'https://apify.com/', '只去 hash，保路径');
  assert.equal(normalizePageUrl(''), '');
});

test('工作区主机名与引擎一致：去 www 和非默认端口', () => {
  assert.equal(workspaceHostOf('http://127.0.0.1:54893/'), '127.0.0.1');
  assert.equal(workspaceHostOf('https://www.apify.com/store'), 'apify.com');
  assert.equal(workspaceHostOf('invalid'), '');
});

test('页面主标签保留 query，避免分页行同名', () => {
  assert.equal(pagePathOf({ url: 'https://x.test/list?page=1', path: '/list' }), '/list?page=1');
  assert.equal(pagePathOf({ url: 'https://x.test/list?page=2', path: '/list' }), '/list?page=2');
  assert.equal(pagePathOf({ path: '/fallback' }), '/fallback');
});

test('两个归一器的差别就是"路径留不留" —— 别再合并成一个', () => {
  assert.equal(normalizeSiteUrl('apify.com/store') + '/store', normalizePageUrl('apify.com/store'));
  assert.equal(normalizeSiteUrl('https://example.com/a/b'), 'https://example.com');
  assert.equal(normalizePageUrl('https://example.com/a/b'), 'https://example.com/a/b');
});
