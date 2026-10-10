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
