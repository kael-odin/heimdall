import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { comparePngBuffers, overallScore, gradeOf } from '../src/verify/compare.mjs';

const make = (w, h, mutate) => {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255; }
  if (mutate) mutate(png);
  return PNG.sync.write(png);
};

test('verify: identical images score 1', () => {
  const img = make(20, 10);
  const r = comparePngBuffers(img, img);
  assert.equal(r.score, 1);
  assert.equal(r.mismatched, 0);
  assert.equal(r.heightDelta, 0);
});

test('verify: changed pixels lower the score and produce a diff image', () => {
  const a = make(20, 10);
  const b = make(20, 10, png => { for (let x = 0; x < 20; x++) { png.data[x * 4] = 0; png.data[x * 4 + 1] = 0; png.data[x * 4 + 2] = 0; } });
  const r = comparePngBuffers(a, b);
  assert.ok(r.mismatched >= 20, 'mismatched=' + r.mismatched);
  assert.ok(r.score < 1);
  assert.ok(PNG.sync.read(r.diffPng).width === 20);
});

test('verify: different heights are reported as delta', () => {
  const r = comparePngBuffers(make(10, 10), make(10, 20));
  assert.equal(r.heightDelta, 10);
  assert.equal(r.height, 10);
});

test('verify: overall score weights desktop at 0.5', () => {
  // 桌面权重 0.5，移动/平板各 0.25：只有桌面满分时为 0.5
  const s = overallScore([{ name: '375x812', score: 0 }, { name: '768x1024', score: 0 }, { name: '1440x900', score: 1 }]);
  assert.equal(s, 0.5);
  assert.equal(gradeOf(0.96), 'A');
  assert.equal(gradeOf(0.8), 'C');
});
