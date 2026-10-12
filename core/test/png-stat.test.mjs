/**
 * png-stat — "这张图真的画了东西吗"
 *
 * 这条守卫来自 moonshot.cn 首页：整条 hero 动画带是一块 WebGL 画布，
 * `drawImage` 读回来全透明（没有 preserveDrawingBuffer），它被静默跳过，
 * 首屏 7.8% 的像素就此消失，而所有缺口清单里一个字都没写。
 * 所以截图兜底之后必须能自证不是空图 —— 这个函数就是那个自证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

const { countOpaquePng, ALPHA_MIN } = await import('../src/png-stat.mjs');

/** 造一张 w×h 的图，前 fill 个像素不透明 */
const make = (w, h, fill) => {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    png.data[o] = 255; png.data[o + 1] = 0; png.data[o + 2] = 0;
    png.data[o + 3] = i < fill ? 255 : 0;
  }
  return PNG.sync.write(png);
};

test('数得清不透明像素', () => {
  assert.equal(countOpaquePng(make(10, 10, 0)), 0, '全透明');
  assert.equal(countOpaquePng(make(10, 10, 100)), 100);
  assert.equal(countOpaquePng(make(4, 3, 12)), 12, '全不透明');
});

test('半透明但看得见（alpha > 阈值）也算', () => {
  const png = new PNG({ width: 2, height: 1 });
  png.data[3] = ALPHA_MIN + 1;
  png.data[7] = ALPHA_MIN;          // 正好等于阈值不算 —— 边界必须是"大于"
  assert.equal(countOpaquePng(PNG.sync.write(png)), 1);
});

test('**解不出来返回 -1**，而不是假装 0', () => {
  // 0 是"这张图确实全透明"，-1 是"我根本读不懂它" —— 两者对调用方的含义完全不同：
  // 前者可以放过（真的没画东西），后者必须拒绝（可能是截断/格式错的破图）
  assert.equal(countOpaquePng(Buffer.from('not a png')), -1);
  assert.equal(countOpaquePng(Buffer.alloc(0)), -1);
  assert.equal(countOpaquePng(make(10, 10, 5).subarray(0, 30)), -1, '截断的 PNG');
});
