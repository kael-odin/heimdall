/**
 * HTML 转义
 *
 * 这个函数原本在 9 个文件里各写了一份，并且**分成两种**：6 份转义 `& < "`，
 * 3 份还多转义 `>`。两种都能用，但同一个项目里两套转义规则本身就是隐患 ——
 * 下次有人只改了一套，行为就悄悄变了。
 * 现在只保留一处，取更严格的那一套；这里把它的行为钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../src/html.mjs';

test('四个字符都转义', () => {
  assert.equal(esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('& 先转 —— 否则会把后面的转义再转一遍（双转义）', () => {
  assert.equal(esc('&lt;'), '&amp;lt;');
  assert.equal(esc('a & <b>'), 'a &amp; &lt;b&gt;');
});

test('null / undefined / 数字都不抛，按字符串处理', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(12.5), '12.5');
});

test('单引号不转 —— 我们的模板只用双引号包属性', () => {
  assert.equal(esc("it's"), "it's");
});
