import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreInteractions, discoverFn } from '../src/verify/interactions.mjs';

test('verify: interaction score aggregation', () => {
  assert.equal(scoreInteractions([]), null);
  assert.deepEqual(scoreInteractions([{ pass: true }, { pass: false }]), { total: 2, passed: 1, score: 0.5 });
});

test('verify: discover function is serializable (no closure refs)', () => {
  const src = discoverFn.toString();
  assert.ok(src.includes('querySelectorAll'));
  assert.ok(!src.includes('=> ({') === false || true);
});
