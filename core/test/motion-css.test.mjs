/**
 * CSS 动效抽取
 *
 * 这块解决的是一句含糊的边界："动效不逐帧复刻"。真实情况分三层：
 * CSS 关键帧在静态镜像里**是活的**（脚本剥了，但样式表还在），JS 动效在交互镜像里是活的，
 * 真正缺的是**把动效说清楚并把代码交出去** —— cssom.css 已经在磁盘上了，离线就能抽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripComments, matchBrace, scanRules, extractKeyframes,
  parseShorthand, collectCssMotion, renderMotionCss,
} from '../src/crawler/motion-css.mjs';

const CSS = `
  /* 注释里可以有 { 花括号 }，剥不干净会把配对算错 */
  @keyframes fade-in { 0% { opacity: 0 } 100% { opacity: 1 } }
  .hero { animation: fade-in 1s ease-out .1s; color: red }
  @media (min-width: 900px) {
    .card { animation-name: pop; }
  }
  @keyframes pop { from { transform: scale(.8) } to { transform: scale(1) } }
  @keyframes nobody-uses-this { to { opacity: 0 } }
  .swiper { animation: spin 2s linear infinite; }
`;

test('配对与注释：注释里的花括号不算数', () => {
  assert.equal(matchBrace('{a{b}c}', 0), 6);
  assert.equal(matchBrace('a{b', 1), -1, '括号不配对返回 -1');
  assert.equal(stripComments('a{/* } */}'), 'a{}');
});

test('裸声明（`animation-name`）与简写（`animation`）都要认', () => {
  const m = collectCssMotion(CSS);
  const byName = Object.fromEntries(m.animations.map(a => [a.name, a]));
  assert.ok(byName['fade-in'], '简写形式的动画名');
  assert.equal(byName['fade-in'].selector, '.hero');
  assert.equal(byName['fade-in'].duration, '1s');
  assert.equal(byName['fade-in'].delay, '.1s');
  assert.equal(byName['fade-in'].timing, 'ease-out');
  assert.ok(byName.pop, 'animation-name 形式');
  assert.equal(byName.pop.defined, true, '关键帧在同一份样式表里');
  assert.equal(byName.spin.iterations, 'infinite');
});

test('@media 里的规则带上外层语境，方便定位', () => {
  const m = collectCssMotion(CSS);
  const pop = m.animations.find(a => a.name === 'pop');
  assert.match(pop.at, /@media \(min-width: 900px\)/);
});

test('关键帧内部的分段不会被当成规则扫进来', () => {
  const m = collectCssMotion(CSS);
  assert.equal(m.animations.some(a => /^\d+%$|^from$|^to$/.test(a.selector)), false);
});

test('定义但没被引用的关键帧要单独列出来（通常是脚本按需挂上去的入场动效）', () => {
  const m = collectCssMotion(CSS);
  assert.deepEqual(m.stats.unusedKeyframes, ['nobody-uses-this']);
  assert.equal(m.stats.definedKeyframes, 3);
});

test('内联 style 里的动画也算用到 —— 实测 thordata 首页 18 组关键帧有 15 组是这么挂的', () => {
  const dom = '<div style="animation: nobody-uses-this .5s ease both" class="x">hi</div>';
  const m = collectCssMotion(CSS, { dom });
  assert.equal(m.stats.inline, 1);
  assert.deepEqual(m.stats.unusedKeyframes, [], '被内联样式引用了，就不再是"没人用"');
  const a = m.animations.find(x => x.inline);
  assert.equal(a.selector, 'inline:div');
  assert.equal(a.name, 'nobody-uses-this');
});

test('简写解析：两个时间值分别是时长与延迟，顺序无关', () => {
  assert.deepEqual(
    { ...parseShorthand('3s cubic-bezier(.4,0,.2,1) 1s 2 alternate both running grow'), raw: undefined },
    { name: 'grow', duration: '3s', delay: '1s', timing: 'cubic-bezier(.4,0,.2,1)', iterations: '2', direction: 'alternate', fill: 'both', playState: 'running', unknown: [], raw: undefined },
  );
  const t = parseShorthand('.2s linear fade');
  assert.equal(t.duration, '.2s');
  assert.equal(t.delay, null);
  assert.equal(t.timing, 'linear');
});

test('CSSOM 规范化后的简写也要认 —— 我们抽的就是 cssom.css，它永远是这种形态', () => {
  // 原站写的是 `animation: heimdall-pulse 1.6s ease-in-out infinite`，
  // 经 CSSOM 序列化后动画名被挪到最后，且补上了缺省位。
  const t = parseShorthand('1.6s ease-in-out 0s infinite normal none running heimdall-pulse');
  assert.equal(t.name, 'heimdall-pulse');
  assert.equal(t.duration, '1.6s');
  assert.equal(t.delay, '0s');
  assert.equal(t.timing, 'ease-in-out');
  assert.equal(t.iterations, 'infinite');
  assert.equal(t.direction, 'normal');
  assert.equal(t.fill, 'none');
  assert.equal(t.playState, 'running');
});

test('确定性：同一条命令跑两次结果一致（顺序不能取决于扫描顺序之外的东西）', () => {
  const a = JSON.stringify(collectCssMotion(CSS));
  const b = JSON.stringify(collectCssMotion(CSS));
  assert.equal(a, b);
});

test('导出可直接粘贴：A 段在用的 / B 段定义了但没被引用的，两段都带 `@keyframes 名字` 头', () => {
  const css = renderMotionCss(collectCssMotion(CSS), { host: 'a.test', page: 'home' });
  assert.match(css, /@keyframes fade-in \{/);
  assert.match(css, /@keyframes pop \{/);
  // B 段不是"垃圾"：入场/揭示类动效的关键帧常驻，而引用它的类只在过渡那几百毫秒里存在，
  // 静止采样必然看不到引用。代码已经在手上，就该交出去。
  assert.match(css, /B · 定义了但捕获时没被引用/);
  assert.match(css, /@keyframes nobody-uses-this \{/);
  assert.match(css, /a\.test · home/);
});

test('扫不到动效的样式表返回空账，不抛异常', () => {
  const m = collectCssMotion('.a{color:red}', { dom: '<p>hi</p>' });
  assert.deepEqual(m.animations, []);
  assert.deepEqual(m.keyframes, []);
  assert.equal(m.stats.rules, 0);
  assert.deepEqual(scanRules('/* 只有注释 */'), []);
  assert.deepEqual([...extractKeyframes('').keys()], []);
});
