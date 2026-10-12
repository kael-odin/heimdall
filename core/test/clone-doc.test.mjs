/**
 * clone-doc — 克隆页的"真正的文档"是哪个文件
 *
 * 这条守卫来自一个真实读数：apify.com/store 被算成 41.8%（C 级），而页面上一切正常。
 * 原因是多视口克隆之后 `clone/index.html` 只剩 372 字节的视口选择器
 * （一行 location.replace）。浏览器会跳走，读文件的人不会 ——
 * parse5 拿到一个空文档，DOM 分与数据分双双归零。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { cloneDocFile, readCloneDoc, DESKTOP_VARIANT } = await import('../src/clone-doc.mjs');

const tmp = () => mkdtempSync(join(tmpdir(), 'heimdall-clonedoc-'));
const CHOPPER = '<!doctype html><html><head><script>location.replace(innerWidth<=600?"index-375.html":"index-1440.html");</script></head><body></body></html>';

test('多视口克隆：读到的是 index-1440.html，不是那个选择器', () => {
  const d = tmp();
  writeFileSync(join(d, 'index.html'), CHOPPER);
  writeFileSync(join(d, 'index-375.html'), '<html><body>mobile</body></html>');
  writeFileSync(join(d, DESKTOP_VARIANT), '<html><body>desktop</body></html>');
  const doc = readCloneDoc(d);
  assert.equal(doc.variant, true);
  assert.match(doc.html, /desktop/);
  assert.equal(cloneDocFile(d), join(d, DESKTOP_VARIANT));
});

test('普通克隆：没有变体时就是 index.html', () => {
  const d = tmp();
  writeFileSync(join(d, 'index.html'), '<html><body>only</body></html>');
  const doc = readCloneDoc(d);
  assert.equal(doc.variant, false);
  assert.match(doc.html, /only/);
});

test('目录不存在也不抛（调用方自己决定怎么报）', () => {
  const d = tmp();
  assert.equal(cloneDocFile(join(d, 'nope')), join(d, 'nope', 'index.html'));
});

test('index-1440.html 是目录（不是文件）时不采信 —— 读它会 EISDIR', () => {
  const d = tmp();
  writeFileSync(join(d, 'index.html'), '<html><body>real</body></html>');
  mkdirSync(join(d, DESKTOP_VARIANT));
  assert.equal(readCloneDoc(d).html.includes('real'), true);
});
