/**
 * watch 单测：快照 / 差异（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFromPages, diffSnapshots, normalizeUrl } from '../src/watch/diff.mjs';

const page = (over = {}) => ({
  url: 'https://x.test/a', finalUrl: 'https://x.test/a', status: 200,
  title: 'A', description: 'desc', canonical: 'https://x.test/a', robotsMeta: '', lang: 'en',
  h1: ['H'], jsonld: [{ ok: true, types: ['Product'] }], wordCount: 100, textHash: 'aaaa1111', textSample: 'hello',
  ...over,
});

test('watch: snapshot keyed by normalized url (trailing slash/hash)', () => {
  const s = snapshotFromPages('x.test', [page(), page({ url: 'https://x.test/b#frag', finalUrl: 'https://x.test/b' })]);
  assert.equal(Object.keys(s.pages).length, 2);
  assert.ok(s.pages['https://x.test/a']);
  assert.ok(s.pages['https://x.test/b']);
  assert.equal(normalizeUrl('https://x.test/a/#x'), 'https://x.test/a');
});

test('watch: diff detects title/status/text changes and page add/remove', () => {
  const base = snapshotFromPages('x.test', [page(), page({ url: 'https://x.test/gone', finalUrl: 'https://x.test/gone' })]);
  const cur = snapshotFromPages('x.test', [
    page({ title: 'A2', status: 200, textHash: 'bbbb2222' }),
    page({ url: 'https://x.test/new', finalUrl: 'https://x.test/new' }),
  ]);
  const d = diffSnapshots(base, cur);
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
  assert.equal(d.changed.length, 1);
  const fields = d.changed[0].fields.map(f => f.field);
  assert.ok(fields.includes('title'));
  assert.ok(fields.includes('textHash'));
  assert.ok(d.bySeverity.medium >= 1, 'title change is medium');
  const th = d.changed[0].fields.find(f => f.field === 'textHash');
  assert.equal(th.severity, 'info', 'small word delta downgrades textHash to info');
  assert.equal(d.hasChanges, true);
});

test('watch: unstable fields and small word deltas are noise, not changes', () => {
  const base = snapshotFromPages('x.test', [page()]);
  const cur = snapshotFromPages('x.test', [page({ textHash: 'cccc3333', wordCount: 102, h1: ['H'] })], undefined, { 'https://x.test/a': ['textHash', 'wordCount'] });
  const d = diffSnapshots(base, cur);
  assert.equal(d.changed.length, 0);
  assert.equal(d.dynamic.length, 1);
  assert.equal(d.hasChanges, false);

  // 未标记 unstable 时：title 变化仍上报；textHash 因字数差 <5% 降级 info
  const cur2 = snapshotFromPages('x.test', [page({ title: 'A3', textHash: 'dddd4444', wordCount: 103 })]);
  const d2 = diffSnapshots(base, cur2);
  assert.equal(d2.changed.length, 1);
  const th = d2.changed[0].fields.find(f => f.field === 'textHash');
  assert.equal(th.severity, 'info');
});

test('watch: identical snapshots report no changes', () => {
  const s = snapshotFromPages('x.test', [page()]);
  const d = diffSnapshots(s, s);
  assert.equal(d.hasChanges, false);
  assert.equal(d.changed.length, 0);
  assert.equal(d.unchanged, 1);
});
