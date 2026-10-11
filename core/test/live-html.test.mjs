/**
 * 交互镜像 HTML 的根相对改写
 *
 * 这里锁的是一个通用形态：**协议相对 URL**（`//cdn.example/x`）以 `/` 开头，
 * 但语义是"用当前协议拼这个绝对地址"，不是根相对。此前它被改写成
 * `/lm/<host>//at.alicdn.com/…`，指向本机根目录下一个不存在的路径 ——
 * 只在真站点上显形（ant.design 的图标字体 8 个引用全坏，体检报 8 个 unresolved）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixRootRelative } from '../src/live/live-html.mjs';

const HOST = 'site.test';
const P = `/lm/${HOST}`;
const f = (html) => prefixRootRelative(html, P, ['src/', '_next/', 'assets/']);

test('根相对引用会被加上前缀', () => {
  assert.equal(f('<link href="/assets/app.css">'), `<link href="${P}/assets/app.css">`);
  assert.equal(f('<img src="/logo.svg">'), `<img src="${P}/logo.svg">`);
  assert.equal(f('<div style="background:url(/img/hero.png)">'), `<div style="background:url("${P}/img/hero.png)">`);
});

test('协议相对 URL 原样保留（这条是这次的回归点）', () => {
  assert.equal(f('<img src="//at.alicdn.com/t/x.woff2">'), '<img src="//at.alicdn.com/t/x.woff2">');
  assert.equal(f('<link href="//cdn.test/a.css">'), '<link href="//cdn.test/a.css">');
  assert.equal(f('<style>@font-face{src:url(//at.alicdn.com/t/x.woff)}</style>'),
    '<style>@font-face{src:url(//at.alicdn.com/t/x.woff)}</style>');
  assert.equal(f('<script>import("//cdn.test/m.js")</script>'), '<script>import("//cdn.test/m.js")</script>');
});

test('我们的两个命名空间不会被二次加前缀（/lm 与 /static）', () => {
  assert.equal(f(`<script src="${P}/app.js">`), `<script src="${P}/app.js">`);
  assert.equal(f('<link href="/static/site.test/pages/home/clone/styles/cssom.css">'),
    '<link href="/static/site.test/pages/home/clone/styles/cssom.css">');
});

test('JS 里的动态 import 与已知根目录字符串也会归位', () => {
  assert.equal(f('<script>const m = import("/src/chunk.js")</script>'),
    `<script>const m = import("${P}/src/chunk.js")</script>`);
  assert.equal(f('<script>{"paths":{"a":"/_next/static/x.js"}}</script>'),
    `<script>{"paths":{"a":"${P}/_next/static/x.js"}}</script>`);
});

test('无引号的属性写法与 srcset 也覆盖到', () => {
  assert.equal(f('<img src=/icons/a.svg>'), `<img src=${P}/icons/a.svg>`);
  assert.equal(f('<img srcset="/a.png 1x, //cdn.test/b.png 2x">'),
    `<img srcset="${P}/a.png 1x, //cdn.test/b.png 2x">`);
});

test('绝对地址不受影响（不是以 / 开头）', () => {
  const html = '<a href="https://other.test/x">x</a>';
  assert.equal(f(html), html);
});
