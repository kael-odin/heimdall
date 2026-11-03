import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTestCoreArgs } from '../scripts/test-core.mjs';

test('test runner strips the pnpm argument separator before forwarding shards', () => {
  assert.deepEqual(normalizeTestCoreArgs(['--', '--test-shard=1/2']), ['--test-shard=1/2']);
  assert.deepEqual(normalizeTestCoreArgs(['--test-shard=2/2']), ['--test-shard=2/2']);
  assert.deepEqual(normalizeTestCoreArgs(['--fast', '--test-concurrency=2']), ['--fast', '--test-concurrency=2']);
  assert.deepEqual(normalizeTestCoreArgs([]), []);
});
