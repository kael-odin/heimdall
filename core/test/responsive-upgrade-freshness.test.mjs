import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../src/crawler/responsive-upgrade.mjs', import.meta.url));

test('responsive upgrade refuses a verification summary without current proof', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-upgrade-stale-'));
  const base = join(dataDir, 'workspace', 'fixture.test');
  const page = join(base, 'pages', 'home');
  const original = '<html>new clone</html>';
  try {
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(join(base, 'verify'), { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(join(page, 'clone', 'index.html'), original);
    writeFileSync(join(base, 'verify', 'verify-summary.json'), JSON.stringify({
      generatedAt: '2020-01-01T00:00:00.000Z', scoreVersion: 2, mode: 'all',
      targetTotal: 1, measured: 1, untested: 0,
      pages: [{ page: 'home', measured: true, overall: 0.5, minViewport: { score: 0.5 } }],
    }));
    const run = spawnSync(process.execPath, [SCRIPT, 'fixture.test'], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /summary or evidence is stale/);
    assert.equal(readFileSync(join(page, 'clone', 'index.html'), 'utf8'), original);

    const secondPage = join(base, 'pages', 'other');
    mkdirSync(join(secondPage, 'clone'), { recursive: true });
    writeFileSync(join(secondPage, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/other' }));
    writeFileSync(join(secondPage, 'clone', 'index.html'), '<html>other</html>');
    const summaryPath = join(base, 'verify', 'verify-summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    summary.generatedAt = new Date(Date.now() + 1000).toISOString();
    writeFileSync(summaryPath, JSON.stringify(summary));
    const missing = spawnSync(process.execPath, [SCRIPT, 'fixture.test'], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /summary does not cover the current page set/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
