/**
 * 动效驱动分类
 *
 * 这套分类的价值在于**把"抓不到的东西"说清楚**：此前报告里只有一句
 * `dynamicShare: 0.68`，容易被读成"页面 68% 是垃圾"，其实它说的是
 * "我们冻结/采样的这套动作，没能覆盖掉 68% 的像素差异"。
 * 分类之后才能回答"是时间循环、滚动揭示，还是画布"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMotion, motionLine, DRIVERS } from '../src/crawler/motion.mjs';

const rawOf = (over = {}) => ({ anims: [], reveal: {}, libs: {}, canvas: [], video: [], smooth: 'auto', ...over });

test('时间驱动：CSS 动画（含无限循环）', () => {
  const m = classifyMotion(rawOf({
    anims: [
      { kind: 'CSSAnimation', name: 'spin', target: 'div.logo', iterations: 'infinite', scrollTimeline: false },
      { kind: 'CSSAnimation', name: 'fade-in', target: 'section.hero', iterations: 1, scrollTimeline: false },
    ],
  }));
  assert.equal(m.counts.time, 2);
  assert.match(m.summary, /时间驱动 2/);
  assert.match(m.drivers.time.examples[0], /无限循环/);
});

test('累计观测优先于瞬时快照（静置之后瞬时快照采不到东西，实测 svelte.dev 采出零动效）', () => {
  const m = classifyMotion(rawOf({
    observed: {
      animations: { 'spin @ div.logo': { count: 3, looped: true }, 'fade-in @ section.hero': { count: 1, looped: false } },
      transitions: { 'opacity @ a.btn': { count: 2 } },
    },
    // 瞬时快照是空的：这正是真实采集里的常态
    anims: [],
  }));
  assert.equal(m.counts.time, 2, '曾经跑过的动画要算进来');
  assert.equal(m.counts.stateChange, 1);
  assert.match(m.drivers.time.examples[0], /循环播放/);
  assert.match(m.drivers.time.examples[1], /fade-in/);
});

test('没有观测数据时退回瞬时快照（老产物 / 单元测试路径）', () => {
  const m = classifyMotion(rawOf({ anims: [{ kind: 'CSSAnimation', name: 'x', target: 'div.a' }] }));
  assert.equal(m.counts.time, 1);
});

test('滚动时间线优先归到连续滚动，而不是时间驱动', () => {
  const m = classifyMotion(rawOf({
    observed: { animations: { 'grow @ div.bar': { count: 1, looped: false } }, transitions: {} },
    anims: [{ kind: 'CSSAnimation', name: 'grow', target: 'div.bar', scrollTimeline: true }],
  }));
  assert.equal(m.counts.scrollContinuous, 1);
  assert.equal(m.counts.time, 1, '累计观测里它也是一条记录 —— 两条证据并存是对的');
});

test('状态变化：CSS 过渡（悬停/展开这类由交互触发的）', () => {
  const m = classifyMotion(rawOf({ anims: [{ kind: 'CSSTransition', name: 'opacity', target: 'a.btn' }] }));
  assert.equal(m.counts.stateChange, 1);
  assert.equal(m.counts.time, 0, '过渡不该被算进时间驱动');
});

test('连续滚动：滚动时间线 + 平滑滚动库都算', () => {
  const timeline = classifyMotion(rawOf({ anims: [{ kind: 'CSSAnimation', name: 'grow', target: 'div.bar', scrollTimeline: true }] }));
  assert.equal(timeline.counts.scrollContinuous, 1);

  const lenis = classifyMotion(rawOf({ libs: { lenis: true } }));
  assert.equal(lenis.counts.scrollContinuous, 1);
  assert.match(lenis.drivers.scrollContinuous.examples[0], /Lenis/);

  const smooth = classifyMotion(rawOf({ smooth: 'smooth' }));
  assert.equal(smooth.counts.scrollContinuous, 1, 'scroll-behavior: smooth 同样会改变滚动行为');
});

test('滚动揭示：按类名标记计数（这些动画滚动时才创建，抓不到"正在跑"）', () => {
  const m = classifyMotion(rawOf({ reveal: { '[data-aos]': 12, '[class*="reveal"]': 3 } }));
  assert.equal(m.counts.scrollReveal, 2, '两种标记算两项，数字在示例里');
  assert.match(m.drivers.scrollReveal.examples[0], /12/);
});

test('指针 / 画布：canvas 与自动播放视频', () => {
  const m = classifyMotion(rawOf({
    canvas: [{ px: '800x600', css: '800x600', engine: 'three.js r150' }],
    video: [{ autoplay: true, loop: true, muted: true }],
  }));
  assert.equal(m.counts.pointerCanvas, 2);
  assert.match(m.drivers.pointerCanvas.examples[0], /three\.js/);
});

test('静态页面：说"未检出动效"，而不是给一张全 0 的表', () => {
  const m = classifyMotion(rawOf());
  assert.equal(m.total, 0);
  assert.equal(m.summary, '未检出动效（页面是静态的）');
  assert.equal(motionLine(m), '未检出动效');
  assert.deepEqual(DRIVERS.filter(d => m.counts[d]), []);
});

test('每一类都带"我们怎么处置"——分类不落到处置上就没有意义', () => {
  const m = classifyMotion(rawOf({ anims: [{ kind: 'CSSAnimation', name: 'x', target: 'div' }] }));
  for (const d of DRIVERS) assert.ok(m.drivers[d].handling, `${d} 缺处置说明`);
});

test('口径必须随结果一起给出（这是启发式，不是事实）', () => {
  const m = classifyMotion(rawOf({ reveal: { '[data-aos]': 1 } }));
  assert.match(m.why, /类名标记|启发式|偏保守/);
});
