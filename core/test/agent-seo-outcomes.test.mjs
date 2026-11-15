import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

test('seo-outcomes: validates, normalizes and safely writes an origin-bound sidecar', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-seo-outcomes-'));
  const site = join(root, 'workspace', 'example.test');
  const input = join(root, 'input.json');
  try {
    writeJson(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    writeJson(input, {
      schema: 'heimdall.seo-geo-outcome-evidence/1', origin: 'https://example.test', generatedAt: '2026-11-15T00:00:00.000Z',
      search: { status: 'observed', source: 'manual-search', samples: 10, hits: 4, averagePosition: 3.5 },
      modelCitation: { status: 'unavailable' },
      extra: 'must be dropped',
    });
    const run = args => spawnSync(process.execPath, [CLI, ...args, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    const okRun = run(['seo-outcomes', 'example.test', 'https://example.test/', '--file', input]);
    assert.equal(okRun.status, 0, okRun.stderr + okRun.stdout);
    const result = JSON.parse(okRun.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(result.outcomeEvidence.search.status, 'observed');
    assert.equal(result.outcomeEvidence.modelCitation.status, 'unavailable');
    const written = JSON.parse(readFileSync(join(site, 'seo', 'outcome-evidence.json'), 'utf8'));
    assert.equal(written.extra, undefined);
    assert.equal(written.search.hitRate, 0.4);
    assert.equal(written.search.averagePosition, 3.5);

    const conflict = run(['seo-outcomes', 'example.test', 'https://example.test/', '--file', input]);
    assert.equal(conflict.status, 2);
    assert.equal(JSON.parse(conflict.stdout.trim().split(/\r?\n/).at(-1)).error.code, 'invalid_args');

    const mismatch = run(['seo-outcomes', 'example.test', 'https://other.test/', '--file', input, '--force']);
    assert.equal(mismatch.status, 2);
    assert.equal(JSON.parse(mismatch.stdout.trim().split(/\r?\n/).at(-1)).error.code, 'origin_conflict');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
