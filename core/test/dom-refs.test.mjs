/**
 * dom-refs — HTML 资产引用的识别与清理
 *
 * 两个坑都是实测踩出来的，所以每个都单独钉一个用例：
 *   · rel 是**空格分隔的 token 列表**，整串比较会漏掉 rel="preload stylesheet"
 *   · **根相对路径（/foo.css）也是残留** —— 克隆挂在 /static/<host>/pages/<page>/clone/
 *     下，/foo.css 会打到引擎根，一样 404
 *
 * 真实来源：vitest.dev 首页克隆后有两个 <link> 指向原站根路径、本地 404，
 * 而当时的自检报的是 "leftover: 0"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { relTokens, stripAssetLinkTags, findStrayRefs, isStrayRef, DROP_RELS, ASSET_RELS } =
  await import('../src/dom-refs.mjs');

const ORIGIN = 'https://vitest.dev';

// ---------- rel token 解析 ----------
test('relTokens: rel 是空格分隔的 token 列表', () => {
  assert.deepEqual(relTokens('<link rel="preload stylesheet" href="/a.css">'), ['preload', 'stylesheet']);
  assert.deepEqual(relTokens('<link rel="stylesheet">'), ['stylesheet']);
  assert.deepEqual(relTokens('<link rel=Stylesheet>'), [], '无引号属性不支持，但不能崩');
  assert.deepEqual(relTokens('<link href="x">'), []);
  assert.deepEqual(relTokens('<link rel="  PRELOAD   stylesheet  ">'), ['preload', 'stylesheet']);
});

test('relTokens: 大小写不敏感、多余的空白被吃掉', () => {
  assert.deepEqual(relTokens('<LINK REL="Preload Stylesheet">'), ['preload', 'stylesheet']);
});

// ---------- 摘除 ----------
test('stripAssetLinkTags: 摘掉样式表与资源提示', () => {
  const html = [
    '<link rel="stylesheet" href="/a.css">',
    '<link rel="preload" href="/b.woff2" as="font">',
    '<link rel="preconnect" href="https://cdn.example">',
    '<link rel="modulepreload" href="/c.js">',
  ].join('\n');
  const out = stripAssetLinkTags(html);
  assert.equal(out.replace(/\s+/g, ''), '', '全部应被摘除');
});

test('stripAssetLinkTags: **多 token rel 也要摘**（这是真实缺陷的那一条）', () => {
  const html = '<link rel="preload stylesheet" href="/assets/style.C-kOEMgT.css" as="style">';
  assert.equal(stripAssetLinkTags(html).trim(), '', 'rel="preload stylesheet" 此前被整串比较漏掉');
});

test('stripAssetLinkTags: canonical / alternate 必须保留（指向原站是正确的 SEO 归属）', () => {
  const html = '<link rel="canonical" href="https://vitest.dev/">\n<link rel="alternate" type="application/rss+xml" href="/feed.xml">';
  assert.equal(stripAssetLinkTags(html), html);
});

test('stripAssetLinkTags: 不影响非 link 标签', () => {
  const html = '<img src="/a.png"><a href="/b">x</a><script src="/c.js"></script>';
  assert.equal(stripAssetLinkTags(html), html);
});

// ---------- 残留识别 ----------
test('isStrayRef: 原站绝对地址算残留', () => {
  assert.equal(isStrayRef('https://vitest.dev/a.css', ORIGIN), true);
  assert.equal(isStrayRef('https://vitest.dev', ORIGIN), true);
});

test('isStrayRef: **根相对路径也算残留**（克隆不在站点根上服务）', () => {
  assert.equal(isStrayRef('/assets/style.css', ORIGIN), true, '根相对 → 打到引擎根 → 404');
  assert.equal(isStrayRef('/vp-icons.css', ORIGIN), true);
});

test('isStrayRef: 相对路径与站外地址不算', () => {
  assert.equal(isStrayRef('assets/a.png', ORIGIN), false, '相对路径在克隆目录内，是对的');
  assert.equal(isStrayRef('./a.png', ORIGIN), false);
  assert.equal(isStrayRef('https://cdn.jsdelivr.net/x.js', ORIGIN), false, '站外是作者的选择');
  assert.equal(isStrayRef('//cdn.example.com/x.js', ORIGIN), false, '协议相对是站外');
  assert.equal(isStrayRef('#frag', ORIGIN), false);
  assert.equal(isStrayRef('data:image/png;base64,AAA', ORIGIN), false);
  assert.equal(isStrayRef('', ORIGIN), false);
});

test('isStrayRef: 同域名不同路径前缀不能误判', () => {
  // https://vitest.dev.evil.com 不应被当成同域
  assert.equal(isStrayRef('https://vitest.dev.evil.com/a.css', ORIGIN), false);
});

test('findStrayRefs: 找出真实场景里那两条（vitest.dev 首页）', () => {
  const html = [
    '<link rel="preload stylesheet" href="/assets/style.C-kOEMgT.css" as="style">',
    '<link rel="preload stylesheet" href="/vp-icons.css" as="style">',
    '<link rel="preload" href="/assets/Inter.woff2" as="font" crossorigin>',
    '<link rel="canonical" href="https://vitest.dev/">',
    '<img src="assets/logo.svg">',
  ].join('\n');
  const refs = findStrayRefs(html, ORIGIN);
  assert.deepEqual(refs.map(r => r.ref).sort(), ['/assets/Inter.woff2', '/assets/style.C-kOEMgT.css', '/vp-icons.css']);
});

test('findStrayRefs: srcset 逐个判（第一段是 URL，后面是描述符）', () => {
  const html = '<img srcset="/a.png 1x, assets/b.png 2x, https://vitest.dev/c.png 3x">';
  const refs = findStrayRefs(html, ORIGIN);
  assert.deepEqual(refs.map(r => r.ref).sort(), ['/a.png', 'https://vitest.dev/c.png']);
});

test('findStrayRefs: canonical 不算残留，但 icon/manifest 算', () => {
  const html = '<link rel="canonical" href="https://vitest.dev/">\n<link rel="icon" href="/favicon.ico">';
  const refs = findStrayRefs(html, ORIGIN);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, '/favicon.ico');
});

test('findStrayRefs: 指向未克隆页的 <a href> 不算（linker 负责接线）', () => {
  const html = '<a href="/guide/">Guide</a><a href="https://vitest.dev/api/">API</a>';
  assert.deepEqual(findStrayRefs(html, ORIGIN), []);
});

test('findStrayRefs: poster 与 src 都覆盖', () => {
  const html = '<video src="/v.mp4" poster="/p.jpg"></video>';
  assert.deepEqual(findStrayRefs(html, ORIGIN).map(r => r.kind).sort(), ['poster', 'src']);
});

test('findStrayRefs: 干净页面返回空', () => {
  const html = '<link rel="stylesheet" href="styles/cssom.css"><img src="assets/a.png"><a href="/x">x</a>';
  assert.deepEqual(findStrayRefs(html, ORIGIN), []);
});

test('findStrayRefs: origin 里的正则元字符被正确转义', () => {
  const weird = 'https://a.b.co';
  assert.equal(findStrayRefs('<img src="https://aXb.co/x.png">', weird).length, 0, 'a.b.co 的点不应作为通配');
  assert.equal(findStrayRefs('<img src="https://a.b.co/x.png">', weird).length, 1);
});

test('集合内容自洽', () => {
  assert.ok(DROP_RELS.has('stylesheet') && DROP_RELS.has('preload'));
  assert.ok(!DROP_RELS.has('canonical'));
  assert.ok(ASSET_RELS.has('icon') && ASSET_RELS.has('manifest'));
  assert.ok(!ASSET_RELS.has('canonical') && !ASSET_RELS.has('alternate'));
});
