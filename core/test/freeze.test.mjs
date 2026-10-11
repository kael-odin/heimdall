/**
 * 截图冻结样式
 *
 * 这组测试盯的是一个**已经发生过的真实故障**：冻结样式是用来让截图可复现的，
 * 但 capture 是在注入它之后才抓 dom.html 的，而交互镜像正是从 dom.html 生成的 ——
 * 于是整整一批"能跑起来看动效"的产物被我们自己的截图工具冻住了
 * （实测 apify 61/61 页带 `animation-duration:0s !important`，每一处 hover 过渡都是瞬移）。
 *
 * 所以这里有两个断言方向：拼出来的样式**必须**冻得住；写进产物的 HTML **必须**被洗干净。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeCss, stripFreeze, FREEZE_MARK } from '../src/freeze.mjs';

test('freezeCss：默认只冻动画与过渡，不带站点专属的重置规则', () => {
  const css = freezeCss();
  assert.ok(css.startsWith(FREEZE_MARK), '必须带标记，stripFreeze 靠它精确剥离');
  assert.match(css, /animation-duration:0s!important/);
  assert.match(css, /transition-duration:0s!important/);
  assert.match(css, /caret-color:transparent!important/);
  assert.doesNotMatch(css, /swiper-wrapper/, '轮播归位是可选叠加项');
  assert.doesNotMatch(css, /cookie/i, '同意弹层隐藏是可选叠加项');
});

test('freezeCss：可选叠加项按名字点名，不再靠复制粘贴时顺手带不带', () => {
  assert.match(freezeCss({ swiper: true }), /swiper-wrapper/);
  assert.match(freezeCss({ consent: true }), /\[class\*="consent" i\]/);
  const both = freezeCss({ swiper: true, consent: true });
  assert.match(both, /swiper-wrapper/);
  assert.match(both, /consent/);
});

test('stripFreeze：带标记的注入样式被剥掉', () => {
  const html = `<html><head>${'<style type="text/css">' + freezeCss() + '</style>'}<style>.a{color:red}</style></head><body>x</body></html>`;
  const out = stripFreeze(html);
  assert.doesNotMatch(out, /animation-duration/);
  assert.match(out, /\.a\{color:red\}/, '站点自己的样式不能误伤');
  assert.match(out, /<body>x<\/body>/);
});

test('stripFreeze：旧产物没有标记，按"两个特征同时命中"识别', () => {
  const legacy = '<style type="text/css">\n  *, *::before, *::after {\n    animation-duration: 0s !important;\n    animation-delay: 0s !important;\n    transition-duration: 0s !important;\n    transition-delay: 0s !important;\n    caret-color: transparent !important;\n  }\n  .swiper-wrapper { transform: none !important; transition: none !important; }\n</style>';
  const out = stripFreeze(`<head>${legacy}</head>`);
  assert.doesNotMatch(out, /animation-duration/);
  assert.doesNotMatch(out, /swiper-wrapper/, '同一块里的附加规则跟着一起走');
});

test('stripFreeze：站点自己的 prefers-reduced-motion 不能被当成我们的冻结剥掉', () => {
  // 只命中一个特征（有 animation-duration:0s，但没有 caret-color）→ 不属于我们
  const siteOwn = '<style>@media (prefers-reduced-motion: reduce){*{animation-duration:0s !important}}</style>';
  assert.equal(stripFreeze(`<head>${siteOwn}</head>`), `<head>${siteOwn}</head>`);
});

test('stripFreeze：没有冻结样式时原样返回', () => {
  const html = '<html><head><style>.a{color:red}</style></head></html>';
  assert.equal(stripFreeze(html), html);
  assert.equal(stripFreeze(''), '');
  assert.equal(stripFreeze(undefined), '');
});
