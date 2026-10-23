/**
 * asset-ext — 扩展名判定（magic > content-type > URL 后缀 > bin）
 *
 * 回归背景：build_clone 旧实现只靠 URL 后缀猜扩展名，带查询串的 CDN 图
 * （`?w=1000&q=80`）一律落成 `.bin`。这里锁死"按响应体真实类型判定"的行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extFrom } from '../src/asset-ext.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const woff2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const avif = Buffer.from('....ftypavif', 'latin1');
const mp4 = Buffer.from('....ftypisom', 'latin1');

test('extFrom: magic bytes win even when URL has no extension', () => {
  const cdn = 'https://images.example.com/photo-1554629947-334ff61d85dc?w=1000&q=80';
  assert.equal(extFrom(cdn, '', jpeg), 'jpg');
  assert.equal(extFrom(cdn, '', png), 'png');
  assert.equal(extFrom(cdn, 'application/octet-stream', jpeg), 'jpg', 'octet-stream 不得掩盖 magic');
  assert.equal(extFrom(cdn, '', webp), 'webp');
  assert.equal(extFrom(cdn, '', avif), 'avif');
  assert.equal(extFrom(cdn, '', mp4), 'mp4');
});

test('extFrom: fonts keep their real container type', () => {
  assert.equal(extFrom('https://x/_next/static/media/Inter.abc', 'font/woff2', woff2), 'woff2');
  assert.equal(extFrom('https://x/f', '', Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00])), 'ttf');
  assert.equal(extFrom('https://x/f', '', Buffer.from('OTTO....', 'latin1')), 'otf');
  assert.equal(extFrom('https://x/f', '', Buffer.from('wOFF....', 'latin1')), 'woff');
});

test('extFrom: falls back to content-type when body is unavailable', () => {
  assert.equal(extFrom('https://x/img?id=1', 'image/jpeg', null), 'jpg');
  assert.equal(extFrom('https://x/img?id=1', 'image/webp; charset=binary', null), 'webp');
  assert.equal(extFrom('https://x/img?id=1', 'image/svg+xml', null), 'svg');
  assert.equal(extFrom('https://x/img?id=1', 'font/woff2', null), 'woff2');
});

test('extFrom: falls back to URL extension, then bin', () => {
  assert.equal(extFrom('https://x/a/b/logo.PNG', '', null), 'png');
  assert.equal(extFrom('https://x/a/b/photo.jpeg', '', null), 'jpg');
  assert.equal(extFrom('https://x/a/b/site.webmanifest', '', null), 'webmanifest');
  assert.equal(extFrom('https://x/track?id=42', '', null), 'bin');
  assert.equal(extFrom('not a url', '', null), 'bin');
});

test('extFrom: text bodies are only sniffed when the type is not image/font', () => {
  const svg = Buffer.from('<svg viewBox="0 0 1 1"></svg>');
  assert.equal(extFrom('https://x/i?id=9', 'image/svg+xml', svg), 'svg');
  // 声明是图片、magic 又不认识时，不能因为正文以 '<' 开头就误判成 svg
  assert.equal(extFrom('https://x/i?id=9', 'image/avif', Buffer.from('<not-image>')), 'avif');
});

/**
 * isNonAssetRef —— "这不是要去抓的外部资产"
 *
 * 回归背景：链接器处理的是**序列化后的 HTML 文本**，属性里的引号是 `&quot;`、
 * 内联 SVG 的尖括号是 `&lt;`。于是 `url(&quot;data:image/svg+xml,&lt;svg…&gt;&quot;)`
 * 解码后以 `"` 开头 → `data:` 不在开头 → 被判成外部资产 →
 * 去抓 `https://站点/%22data:…` → 必然 404。
 * 实测 framer.com 一页 55 处、整站 233 处，全部记成"资源本地化失败"，
 * 而它们本来就是内联 data URI，一个字节都不用抓。
 */
test('isNonAssetRef: 实体编码 + 引号包裹的 data URI 必须认出来', async () => {
  const { isNonAssetRef } = await import('../src/asset-ext.mjs');
  assert.equal(isNonAssetRef('&quot;data:image/svg+xml,&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot;&gt;&lt;/svg&gt;&quot;'), true);
  assert.equal(isNonAssetRef('"data:image/png;base64,AAA"'), true);
  assert.equal(isNonAssetRef("'data:image/gif;base64,AAA'"), true);
  assert.equal(isNonAssetRef('data:image/svg+xml,<svg/>'), true);
});

test('isNonAssetRef: 页内锚点与伪协议仍然照旧；普通地址不受影响', async () => {
  const { isNonAssetRef } = await import('../src/asset-ext.mjs');
  assert.equal(isNonAssetRef('#gradient'), true);
  assert.equal(isNonAssetRef('%23gradient'), true);
  assert.equal(isNonAssetRef('javascript:void(0)'), true);
  assert.equal(isNonAssetRef('&quot;#gradient&quot;'), true);
  assert.equal(isNonAssetRef(''), true);
  assert.equal(isNonAssetRef(null), true);
  // 真的外部资产不能被误判
  assert.equal(isNonAssetRef('https://cdn.example.com/a.png'), false);
  assert.equal(isNonAssetRef('&quot;https://cdn.example.com/a.png&quot;'), false);
  assert.equal(isNonAssetRef('/assets/a.png'), false);
});

test('extFrom: Content-Type 优先于文本 sniff（[data-x]{color:red} 不是 json）', () => {
  // 复现：文本 sniff 排在 CT 之前 → 属性选择器开头的 CSS 被抢判成 json，
  // 浏览器拿 strict MIME 的 json 当样式表加载会被拒绝。
  const css = Buffer.from('[data-x]{color:red}');
  assert.equal(extFrom('https://x.test/s.css', 'text/css', css), 'css');
  const css2 = Buffer.from('[data-x] { color: red; }');
  assert.equal(extFrom('https://x.test/theme', 'text/css; charset=utf-8', css2), 'css');
  assert.equal(extFrom('https://x.test/a.css', 'text/css', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'css',
    'CT 明确时文本 sniff 不得抢答（连 svg 也不行）');
});

test('extFrom: 无 Content-Type 时文本 sniff 兜底，且只认真正的 JSON 结构前缀', () => {
  assert.equal(extFrom('https://x.test/data', '', Buffer.from('{"a":1}')), 'json');
  assert.equal(extFrom('https://x.test/data', '', Buffer.from('[{"a":1}]')), 'json');
  assert.equal(extFrom('https://x.test/data', '', Buffer.from('[1,2,3]')), 'json');
  assert.equal(extFrom('https://x.test/data', '', Buffer.from('[]')), 'json');
  assert.equal(extFrom('https://x.test/s.css', '', Buffer.from('[data-x]{color:red}')), 'css',
    '未命中文本 sniff 后按 URL 后缀走');
  assert.equal(extFrom('https://x.test/x', '', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg');
});
