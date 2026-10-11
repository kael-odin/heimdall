/**
 * css-refs — CSS url() 扫描与单遍重建
 *
 * 回归背景（2026-10-09 实测于 vitest.dev）：旧实现用全局正则 `/url\(([^)]+)\)/` 扫 CSS，
 * 把 **data URI 内嵌 SVG 里的 `mask='url(%23f)'`** 也当成顶层引用 → 去原站抓
 * `https://host/%23f`（SPA 兜底 200 HTML）→ 落盘成 refNNN.html → 再把内嵌 mask 引用改写掉，
 * 静默破坏内联 SVG 图标（实测 34 处）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanCssRefs, collectCssRefs, rewriteCssRefs, extractFontRules } from '../src/css-refs.mjs';

test('scanCssRefs: 基本形态（带/不带引号、空白）', () => {
  assert.deepEqual(scanCssRefs('a{background:url(/a.png)}').map(t => t.raw), ['/a.png']);
  assert.deepEqual(scanCssRefs('a{background:url("/a.png")}').map(t => t.raw), ['/a.png']);
  assert.deepEqual(scanCssRefs("a{background:url( '/a.png' )}").map(t => t.raw), ['/a.png']);
  assert.deepEqual(scanCssRefs('@font-face{src:url(../fonts/A.woff2) format("woff2")}').map(t => t.raw), ['../fonts/A.woff2']);
  assert.deepEqual(scanCssRefs('a{b:url(/1.png);c:url(/2.png)}').map(t => t.raw), ['/1.png', '/2.png']);
});

test('scanCssRefs: data URI 内嵌的 url(...) 不算引用（本次回归的核心）', () => {
  const css = `.i{background:url("data:image/svg+xml,%3Csvg%3E%3Cg mask='url(%23f)'/%3E%3C/svg%3E")}`;
  const refs = scanCssRefs(css);
  assert.equal(refs.length, 1, '整段 data URI 只应产生 1 个引用，内嵌的 url(%23f) 不得被单独扫出');
  assert.ok(refs[0].raw.startsWith('data:image/svg+xml'), '唯一引用应是那个完整的 data URI');
  assert.equal(refs[0].raw.includes("mask='url(%23f)'"), true, '内嵌内容应原封不动留在 data URI 里');
});

test('scanCssRefs: 未加引号的 data URI 里若出现 ) 也不会截断错位（务实取舍：不产生伪引用）', () => {
  // 未加引号的 url(...) 以第一个 ) 结束 —— 这是 CSS 规范允许的写法，浏览器同样如此解析。
  // 但 CSSOM 序列化 data URI 时一定会加引号，因此真实产物不走这条分支。
  const refs = scanCssRefs('.i{background:url(data:image/svg+xml,x) url(/after.png)}').map(t => t.raw);
  assert.ok(refs.includes('/after.png'), '后续的正常引用仍应被扫到');
});

test('scanCssRefs: start/end 精确指向 URL 文本区间（不含引号）', () => {
  const css = 'a{background:url("/a.png")}';
  const [t] = scanCssRefs(css);
  assert.equal(css.slice(t.start, t.end), '/a.png');
});

test('collectCssRefs: 基准是样式表自身 URL，而不是页面 origin', () => {
  const sheets = [
    { href: 'https://x.test/_next/static/css/main.css', css: '@font-face{src:url(../media/A.woff2)}' },
    { href: null, css: '.a{background:url(/img/b.png)}' },
  ];
  const { refs, refMap } = collectCssRefs(sheets, 'https://x.test/some/page');
  assert.deepEqual(refMap['../media/A.woff2'], ['https://x.test/_next/static/media/A.woff2'],
    '样式表基准必须把 ../media 归到 /_next/static/media');
  assert.deepEqual(refMap['/img/b.png'], ['https://x.test/img/b.png'],
    '内联 <style> 回退到文档 baseURI');
  assert.deepEqual(refs.sort(), ['/img/b.png', '../media/A.woff2'].sort());
});

test('collectCssRefs: 同一引用出现在多张样式表时保留多个候选', () => {
  const { refMap } = collectCssRefs([
    { href: 'https://x.test/a/main.css', css: '.a{background:url(img/p.png)}' },
    { href: 'https://x.test/b/main.css', css: '.b{background:url(img/p.png)}' },
  ], 'https://x.test/');
  assert.deepEqual(refMap['img/p.png'].sort(), ['https://x.test/a/img/p.png', 'https://x.test/b/img/p.png'].sort());
});

test('collectCssRefs: data:/# 引用不入表', () => {
  const { refs } = collectCssRefs([{ href: 'https://x.test/a.css', css: '.a{background:url(#f);mask:url("data:image/svg+xml,x")}' }], 'https://x.test/');
  assert.deepEqual(refs, ['#f'], 'data: 被跳过，#f 作为文档内引用保留（由 build_clone 判定为不可本地化）');
});

test('rewriteCssRefs: 只替换 URL 片段，保留引号与其余文本；data URI 内的同名字符串不动', () => {
  const css = `.a{background:url(img/p.png)}.b{background:url("data:image/svg+xml,%3Cg mask='url(img/p.png)'/%3E")}`;
  const out = rewriteCssRefs(css, new Map([['img/p.png', '../assets/ref000.png']]));
  assert.match(out, /\.a\{background:url\(\.\.\/assets\/ref000\.png\)\}/, '顶层引用应被替换且引号风格保留');
  assert.match(out, /mask='url\(img\/p\.png\)'/, 'data URI 内的同名文本不得被替换');
});

test('rewriteCssRefs: 值为 null/未命中时原样保留', () => {
  const css = 'a{background:url(/keep.png)}';
  assert.equal(rewriteCssRefs(css, new Map()), css);
  assert.equal(rewriteCssRefs(css, new Map([['/keep.png', null]])), css);
});

// ---------- 跨域样式表的最小规则抽取（同源策略下读不到 cssRules，只能服务端取回再抽）----------

const GF = `@font-face { font-family: 'Material Symbols Outlined'; src: url(./v1/ms.woff2) format('woff2'); }
.material-symbols-outlined { font-family: 'Material Symbols Outlined'; font-weight: normal; font-style: normal; }
body { margin: 0; color: red; }
.btn { font-family: 'Other Font'; }`;

test('font-rules: 抽 @font-face，并把相对 url() 解析成绝对地址', () => {
  const out = extractFontRules(GF, 'https://fonts.gstatic.com/s/ms/css2');
  assert.match(out, /https:\/\/fonts\.gstatic\.com\/s\/ms\/v1\/ms\.woff2/);
});

test('font-rules: 必须带上指向该字体族的辅助类（只搬 @font-face 图标不显示）', () => {
  const out = extractFontRules(GF, 'https://fonts.gstatic.com/s/ms/css2');
  assert.match(out, /\.material-symbols-outlined\s*\{[^}]*Material Symbols Outlined/, '这是第一次漏掉的那条');
});

test('font-rules: 不相关规则不带进来（第三方 reset / 别的字体）', () => {
  const out = extractFontRules(GF, 'https://fonts.gstatic.com/s/ms/css2');
  assert.ok(!/margin:\s*0/.test(out), 'body{margin:0} 属于第三方 reset，不该进镜像');
  assert.ok(!/Other Font/.test(out), '指向别的字体族的规则不该带');
  assert.ok(!/\bbody\b/.test(out));
});

test('font-rules: 已绝对化的 url() 原样保留；data: 保留', () => {
  const css = `@font-face{font-family:I;src:url("https://cdn.test/a.woff2")}@font-face{font-family:J;src:url(data:font/woff2;base64,AAA)}`;
  const out = extractFontRules(css, 'https://x.test/css/');
  assert.match(out, /url\("https:\/\/cdn\.test\/a\.woff2"\)/);
  assert.match(out, /data:font\/woff2;base64,AAA/);
});

test('font-rules: 没有 @font-face 就整段不返回（别把普通 CSS 当字体搬运）', () => {
  assert.equal(extractFontRules('body{color:red}', 'https://x.test/'), '');
  assert.equal(extractFontRules('', 'https://x.test/'), '');
});
