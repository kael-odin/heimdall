/**
 * differ/shape — 差异形态判定
 *
 * 这组测试钉的是**判据的方向性**：一处内容缺失必须判成 concentrated，
 * 几千个碎点必须判成 diffuse。判反了比没有更糟 —— 用户会去追根本没坏的区域。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiffShape, shapeNote } from '../src/differ/shape.mjs';

const W = 200, H = 200;
/** 造一张全白的图，然后把指定矩形涂成 pixelmatch 的"差异红" */
function canvas(paint) {
  const buf = Buffer.alloc(W * H * 4, 255);
  buf.fill(255);
  paint((x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
  });
  return buf;
}
const rect = (fn, x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fn(x, y); };

test('shape: 无差异 → identical', () => {
  const r = analyzeDiffShape(canvas(() => {}), W, H);
  assert.equal(r.shape, 'identical');
  assert.equal(r.pixels, 0);
  assert.match(shapeNote('identical'), /一致/);
});

test('shape: 一整块大区域 → concentrated（这是"内容缺失"的形态）', () => {
  const r = analyzeDiffShape(canvas(f => rect(f, 20, 20, 80, 60)), W, H);
  assert.equal(r.shape, 'concentrated');
  assert.equal(r.blobs, 1);
  assert.ok(r.top5Share > 0.99);
  assert.match(shapeNote(r.shape), /内容缺失|错位/);
});

test('shape: 少数几块大面积 → concentrated', () => {
  const r = analyzeDiffShape(canvas(f => { rect(f, 10, 10, 40, 40); rect(f, 120, 120, 40, 40); }), W, H);
  assert.equal(r.shape, 'concentrated');
  assert.equal(r.blobs, 2);
});

test('shape: 上千个孤立像素 → diffuse（这是"抗锯齿差异"的形态）', () => {
  // 棋盘格上的孤立点，彼此不相邻
  const r = analyzeDiffShape(canvas(f => { for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) f(x, y); }), W, H);
  assert.equal(r.shape, 'diffuse');
  assert.ok(r.blobs > 1000, `应碎成很多块，实际 ${r.blobs}`);
  assert.ok(r.largest <= 1, '单块面积应为 1');
  assert.match(shapeNote(r.shape), /抗锯齿|渲染差异/);
});

test('shape: 中等分布 → mixed', () => {
  // 一块中等大小 + 一批碎点
  const r = analyzeDiffShape(canvas(f => {
    rect(f, 10, 10, 20, 20);                       // 400px 一块
    for (let y = 60; y < H; y += 6) for (let x = 0; x < W; x += 6) f(x, y);   // 碎点
  }), W, H);
  assert.equal(r.shape, 'mixed');
  assert.match(shapeNote(r.shape), /都看/);
});

test('shape: 判据方向不能反 —— 同样的像素数，形态不同则判定不同', () => {
  const total = 900;
  const oneBlock = analyzeDiffShape(canvas(f => rect(f, 0, 0, 30, 30)), W, H);          // 900px 一块
  const scattered = analyzeDiffShape(canvas(f => {                                       // 900px 散点
    let n = 0;
    for (let y = 0; y < H && n < total; y += 3) for (let x = 0; x < W && n < total; x += 3) { f(x, y); n++; }
  }), W, H);
  assert.equal(oneBlock.pixels, scattered.pixels, '两者差异像素数相同');
  assert.equal(oneBlock.shape, 'concentrated');
  assert.equal(scattered.shape, 'diffuse');
});

test('shape: 只认"差异红"，普通红色内容不算', () => {
  // 一块暗红（g 偏高）不该被当成差异像素
  const buf = Buffer.alloc(W * H * 4, 255);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = 180; buf[i * 4 + 1] = 60; buf[i * 4 + 2] = 60; }
  const r = analyzeDiffShape(buf, W, H);
  assert.equal(r.pixels, 0, '阈值以下/绿色通道偏高的红不应计入');
});

test('shape: 大图不炸（1MP 全差异）', () => {
  const w = 1000, h = 1000;
  const buf = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = 255; buf[i * 4 + 1] = 0; buf[i * 4 + 2] = 0; }
  const r = analyzeDiffShape(buf, w, h);
  assert.equal(r.shape, 'concentrated');
  assert.equal(r.largest, w * h);
});

test('shapeNote: 四种形态都有话说', () => {
  for (const s of ['identical', 'concentrated', 'diffuse', 'mixed']) {
    const note = shapeNote(s);
    assert.ok(note && note.length > 6, `${s} 应有解释`);
  }
});

test('shape: 差异不足画面千分之一 → negligible（此时"集中"没有信息量）', () => {
  // 562px / 1440×900 是 vitest.dev 修好字体后的真实量级：只有 6 块、最大 164px，
  // 若照常判就会报"集中"，把人支使去查几十像素的噪声。
  const w = 1440, h = 900;
  const buf = Buffer.alloc(w * h * 4, 255);
  const paint = (x, y) => { const i = (y * w + x) * 4; buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0; };
  let n = 0;
  for (let y = 100; y < 120 && n < 562; y += 4) for (let x = 100; x < 200 && n < 562; x++) { paint(x, y); n++; }
  const r = analyzeDiffShape(buf, w, h);
  assert.equal(r.shape, 'negligible');
  assert.match(shapeNote('negligible'), /极小|一致/);
});

test('shape: 差异跨过千分之一就恢复判定（别把真缺失也当成 negligible）', () => {
  const w = 1440, h = 900;
  const buf = Buffer.alloc(w * h * 4, 255);
  for (let y = 100; y < 140; y++) for (let x = 100; x < 160; x++) {   // 2400px ≈ 0.19%
    const i = (y * w + x) * 4; buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0;
  }
  assert.equal(analyzeDiffShape(buf, w, h).shape, 'concentrated');
});
