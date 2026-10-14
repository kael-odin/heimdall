import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAuditArgs } from '../src/seo/cli-args.mjs';

const AUDIT = fileURLToPath(new URL('../src/seo/audit.mjs', import.meta.url));

test('seo cli: option values are not mistaken for the target', () => {
  assert.throws(() => parseAuditArgs(['--max', '2']), /必须提供且只能提供一个目标站点/);
  assert.throws(() => parseAuditArgs(['--threshold', 'nope', 'example.com']), /--threshold 必须/);
  assert.throws(() => parseAuditArgs(['example.com', '--tolerance']), /--tolerance 缺少值/);
});

test('seo cli: parses one target and rejects unknown or duplicate options', () => {
  assert.deepEqual(parseAuditArgs([
    'https://example.com/path?x=1', '--max=3', '--threshold', '70',
    '--baseline', 'config/base.json', '--tolerance', '2.5',
    '--update-baseline', '--fail-on-regression', '--require-baseline',
  ]), {
    target: 'https://example.com/path?x=1', max: 3, threshold: 70, tolerance: 2.5,
    baseline: 'config/base.json', updateBaseline: true, failOnRegression: true, requireBaseline: true,
  });
  assert.throws(() => parseAuditArgs(['example.com', '--wat']), /未知选项/);
  assert.throws(() => parseAuditArgs(['example.com', '--max', '2', '--max', '3']), /只能指定一次/);
  assert.throws(() => parseAuditArgs(['example.com', 'other.example']), /实际 2 个/);
});

test('seo cli: missing target exits before filesystem or network work', () => {
  const result = spawnSync(process.execPath, [AUDIT, '--max', '2'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /必须提供且只能提供一个目标站点/);
  assert.doesNotMatch(result.stderr, /fetching robots|no pages discovered/);

  const unsupported = spawnSync(process.execPath, [AUDIT, 'ftp://example.com'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(unsupported.status, 2, unsupported.stderr);
  assert.match(unsupported.stderr, /invalid HTTP\(S\) target/);
});
