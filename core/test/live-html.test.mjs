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
import { prefixRootRelative, unmirroredBanner, UNMIRRORED_MARK } from '../src/live/live-html.mjs';

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

// ---------- 未镜像页的提示条 ----------
// 镜像路由是融合的：本地没快照就反代回原站。于是一个**从没导出过**交互镜像的站点，
// <host>.localhost:8900 打开的就是原站本身，而界面上写着「交互镜像」——
// 实测 vercel.com 就是这样（没有 live/ 产物），用户以为镜像坏了/跳回官网了。
test('unmirroredBanner: 插在 </body> 前，并写明这是原站实时内容', () => {
  const out = unmirroredBanner('<html><body><h1>hi</h1></body></html>', 'vercel.com', { to: '/' });
  assert.ok(out.indexOf(UNMIRRORED_MARK) < out.lastIndexOf('</body>'), '要在 </body> 之前');
  assert.match(out, /此页未镜像/);
  assert.match(out, /vercel\.com/);
  assert.match(out, /<h1>hi<\/h1>/, '原内容不能动');
});

test('unmirroredBanner: 没有 </body> 时追加到末尾（片段/畸形 HTML 也不能让提示消失）', () => {
  const out = unmirroredBanner('<div>fragment</div>', 'x.test');
  assert.match(out, /^<div>fragment<\/div>/);
  assert.match(out, /data-heimdall-unmirrored/);
});

test('unmirroredBanner: 幂等 —— 已经有标记就不再插一条', () => {
  const once = unmirroredBanner('<body></body>', 'x.test');
  assert.equal(unmirroredBanner(once, 'x.test'), once);
});

test('unmirroredBanner: host 与首页地址都做转义（它们在 URL 里，是外部输入）', () => {
  const out = unmirroredBanner('<body></body>', '"><script>alert(1)</script>', { to: '/lm/a"b/' });
  assert.doesNotMatch(out, /<script>alert/);
  assert.match(out, /&quot;&gt;&lt;script&gt;/);
  assert.match(out, /href="\/lm\/a&quot;b\/"/);
});

test('unmirroredBanner: 前缀入口下的"回镜像首页"指向该站前缀', () => {
  const out = unmirroredBanner('<body></body>', 'x.test', { to: '/lm/x.test' });
  assert.match(out, /href="\/lm\/x\.test"/);
});
