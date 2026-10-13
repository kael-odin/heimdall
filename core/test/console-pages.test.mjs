/**
 * 控制台里"交互镜像"两个入口必须指向**引擎**，不是控制台自己。
 *
 * 这条守卫来自一次实测：dev 下控制台跑在 Vite（:5173），镜像由引擎（:8900）提供。
 * 按 `location` 拼出来的入口会打到 Vite 上 ——
 *
 *     GET http://127.0.0.1:5199/lm/apify.com/   →   200 text/html
 *     <title>Heimdall · Site Atlas</title>       ← 控制台自己的 SPA 首页
 *
 * 也就是"点交互镜像毫无反应"。而 `<host>.localhost:5173` 同理。
 * 引擎地址在 api.js 里已经是唯一事实来源（含用户在设置里改过的地址），
 * 两个入口复用它 —— 这一条钉住"用的是 API 而不是 location"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// pages.js → api.js 在**模块顶层**读 localStorage 与 location，必须先铺好再 import
globalThis.localStorage = { getItem: () => null };
globalThis.location = { port: '5173', protocol: 'http:', origin: 'http://127.0.0.1:5173', hostname: '127.0.0.1' };

const { liveUrl, liveAltUrl, pageNameOf } = await import('../../console/src/pages.js');

test('liveUrl 指向引擎端口，不是控制台端口', () => {
  const u = liveUrl({ url: 'https://apify.com/store' });
  assert.equal(u, 'http://apify.com.localhost:8900/store/');
  assert.doesNotMatch(u, /:5173/, 'dev 下按控制台端口拼出来的地址会打到 Vite 上（拿到 SPA 首页）');
});

test('liveAltUrl 是引擎的绝对地址 —— dev 下 Vite 没有 /lm 代理，相对路径会命中 SPA 回退', () => {
  const u = liveAltUrl({ url: 'https://apify.com/store' });
  assert.equal(u, 'http://127.0.0.1:8900/lm/apify.com/store/');
});

test('目录型路径补尾斜杠（URL 的"基目录"是最后一个 / 之前的部分）', () => {
  assert.equal(liveUrl({ url: 'https://vitest.dev/' }), 'http://vitest.dev.localhost:8900/');
  assert.equal(liveUrl({ url: 'https://x.test/docs' }), 'http://x.test.localhost:8900/docs/');
  assert.equal(liveUrl({ url: 'https://x.test/a.html' }), 'http://x.test.localhost:8900/a.html', '文件型路径不加');
});

test('非法 URL 返回 #，不抛', () => {
  assert.equal(liveUrl({ url: 'nonsense' }), '#');
  assert.equal(liveAltUrl({}), '#');
});

test('页名规则仍在（这条规则被 core 侧的防漂移断言盯着，别动它的写法）', () => {
  assert.equal(pageNameOf({ url: 'https://x.test/customers/anthropic' }), 'customers-anthropic');
  assert.equal(pageNameOf({ url: 'https://x.test/' }), 'home');
});
