/**
 * seo/history — 分数走势
 *
 * 用临时 HEIMDALL_DATA_DIR 隔离，绝不碰真实 workspace。
 * 重点：历史是增强项 —— 读坏了要退化成空数组，不能把审计整条带崩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'hd-history-'));
process.env.HEIMDALL_DATA_DIR = dataDir;

const { appendHistory, readHistory, series, trendNote, historyPath } = await import('../src/seo/history.mjs');

test.after(() => { rmSync(dataDir, { recursive: true, force: true }); });

test('history: 追加后能读回来，字段只留认识的', () => {
  appendHistory('a.test', { kind: 'audit', score: 88.5, grade: 'B', pages: 12, issues: 30, garbage: 'x' });
  const h = readHistory('a.test');
  assert.equal(h.length, 1);
  assert.equal(h[0].score, 88.5);
  assert.equal(h[0].grade, 'B');
  assert.ok(h[0].at, '每条都带时间戳');
  assert.equal(h[0].garbage, undefined, '不认识的字段不落盘');
});

test('history: 多次追加按时间顺序累积', () => {
  for (const s of [80, 82, 85]) appendHistory('b.test', { kind: 'audit', score: s });
  assert.deepEqual(readHistory('b.test').map(x => x.score), [80, 82, 85]);
});

test('history: 文件不存在返回空数组（不是抛错）', () => {
  assert.deepEqual(readHistory('never.test'), []);
});

test('history: 文件被写坏也退化成空数组，不把调用方带崩', () => {
  mkdirSync(join(dataDir, 'workspace', 'broken.test'), { recursive: true });
  writeFileSync(historyPath('broken.test'), '{ 这不是 JSON');
  assert.deepEqual(readHistory('broken.test'), []);
  // 坏文件还能继续追加（重新开始一段历史）
  assert.ok(appendHistory('broken.test', { kind: 'audit', score: 70 }));
  assert.equal(readHistory('broken.test').length, 1);
});

test('history: JSON 不是数组也当空', () => {
  mkdirSync(join(dataDir, 'workspace', 'obj.test'), { recursive: true });
  writeFileSync(historyPath('obj.test'), '{"a":1}');
  assert.deepEqual(readHistory('obj.test'), []);
});

test('history: 写法是"临时文件 + rename"，不会留下 .tmp', () => {
  appendHistory('c.test', { kind: 'clone', avgPixel: 99.1, pages: 61 });
  const raw = readFileSync(historyPath('c.test'), 'utf8');
  assert.ok(JSON.parse(raw).length === 1);
  assert.throws(() => readFileSync(historyPath('c.test') + '.tmp', 'utf8'), '临时文件应已改名，不残留');
});

test('history: 缺 kind 的记录直接拒绝（避免半截数据混进来）', () => {
  assert.equal(appendHistory('d.test', { score: 1 }), null);
  assert.equal(appendHistory('', { kind: 'audit' }), null);
  assert.deepEqual(readHistory('d.test'), []);
});

test('series: 按 kind 与字段取序列', () => {
  appendHistory('e.test', { kind: 'audit', score: 90 });
  appendHistory('e.test', { kind: 'clone', avgPixel: 98.2, pages: 10 });
  appendHistory('e.test', { kind: 'audit', score: 93 });
  const h = readHistory('e.test');
  assert.deepEqual(series(h, 'audit', 'score').map(x => x.v), [90, 93]);
  assert.deepEqual(series(h, 'clone', 'avgPixel').map(x => x.v), [98.2]);
});

test('series: 缺字段的点被跳过（半截记录不该在曲线上戳一个洞）', () => {
  const h = [{ kind: 'audit', score: 90 }, { kind: 'audit' }, { kind: 'audit', score: 92 }];
  assert.deepEqual(series(h, 'audit', 'score').map(x => x.v), [90, 92]);
});

test('trendNote: 只比首尾，且小波动算持平', () => {
  assert.match(trendNote([]), /还没有数据/);
  assert.match(trendNote([{ v: 90 }]), /只有一个数据点/);
  assert.match(trendNote([{ v: 90 }, { v: 99 }]), /上升 9 分/);
  assert.match(trendNote([{ v: 99 }, { v: 90 }]), /下降 9 分/);
  assert.match(trendNote([{ v: 90 }, { v: 90.2 }]), /持平/);
});
