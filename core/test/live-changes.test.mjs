/**
 * 交付包差异清单
 *
 * 这条测试钉住的是**语义**：我们做的是"与上一次导出的文件级差异"，不是补丁。
 * 最容易被写错的两处：内容变了但大小没变（必须按哈希判）、
 * 以及"上一次有的这次没了"（删除，靠反向遍历才找得到）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffChecksums, changesLine } from '../src/live/changes.mjs';

const f = (p, s, h) => ({ p, s, h });
const prevOf = (files) => ({ host: 'h.test', generatedAt: '2026-01-01T00:00:00.000Z', files });

test('首次导出：没有上一次可比，要说清是首次而不是"全都新增了"', () => {
  const ch = diffChecksums(null, [f('a', 1, 'x'), f('b', 1, 'y')]);
  assert.equal(ch.firstExport, true);
  assert.equal(ch.counts.added, 2);
  assert.equal(ch.prev, null);
  assert.match(changesLine(ch), /首次导出/);
});

test('按哈希判变化：大小相同但内容不同也算变化', () => {
  const ch = diffChecksums(prevOf([f('a', 10, 'old')]), [f('a', 10, 'new')]);
  assert.deepEqual(ch.changed, ['a']);
  assert.equal(ch.counts.added, 0);
});

test('新增 / 删除 / 不变 三类同时出现时各自归位', () => {
  const ch = diffChecksums(
    prevOf([f('keep', 1, 'h1'), f('gone', 1, 'h2'), f('edit', 1, 'h3')]),
    [f('keep', 1, 'h1'), f('edit', 2, 'h3b'), f('new', 1, 'h4')],
  );
  assert.deepEqual(ch.added, ['new']);
  assert.deepEqual(ch.changed, ['edit']);
  assert.deepEqual(ch.removed, ['gone']);
  assert.equal(ch.counts.same, 1);
  assert.equal(ch.counts.total, 3);
  assert.match(changesLine(ch), /新增 1 · 变化 1 · 删除 1 · 不变 1/);
});

test('上一次的元信息带出来（时间与文件数）——接收方要能对上"跟哪一版比"', () => {
  const ch = diffChecksums(prevOf([f('a', 1, 'x')]), [f('a', 1, 'x')]);
  assert.equal(ch.prev.at, '2026-01-01T00:00:00.000Z');
  assert.equal(ch.prev.files, 1);
  assert.equal(ch.firstExport, false);
});

test('清单有上限：上千文件时不把 JSON 撑爆，并且明确标出被截断', () => {
  const many = Array.from({ length: 260 }, (_, i) => f('p' + i, 1, 'h' + i));
  const ch = diffChecksums(prevOf([]), many);
  assert.equal(ch.counts.added, 260, '计数要准');
  assert.equal(ch.added.length, 200, '列表要有上限');
  assert.equal(ch.truncated, true);
});

test('元数据文件不参与比较：它们带时间戳，每次必然不同，算了就成了噪声', () => {
  const prev = prevOf([f('health.json', 100, 'old'), f('index.html', 10, 'h1')]);
  const now = [f('health.json', 120, 'new'), f('index.html', 10, 'h1')];
  const ch = diffChecksums(prev, now);
  assert.equal(ch.counts.changed, 0, 'health.json 变了但不算内容变化');
  assert.equal(ch.counts.same, 1);
  assert.equal(ch.counts.meta, 1, '但要报出"有几个元数据文件没参与比较"');
  assert.match(ch.note, /不计入差异/);
});

test('只忽略**根目录**下的元数据文件：页面产物里同名的不算', () => {
  const ch = diffChecksums(prevOf([f('site/static/x/health.json', 1, 'a')]), [f('site/static/x/health.json', 2, 'b')]);
  assert.equal(ch.counts.changed, 1, '站点自己的 health.json 是内容，必须照常比较');
  assert.equal(ch.counts.meta, 0);
});

test('空对空不该报"删除"', () => {
  const ch = diffChecksums(prevOf([]), []);
  assert.deepEqual(ch.removed, []);
  assert.equal(ch.counts.total, 0);
});
