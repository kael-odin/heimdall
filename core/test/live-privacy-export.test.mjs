import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

function assertHealthChecksum(bundleDir) {
  const bytes = readFileSync(join(bundleDir, 'health.json'));
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'checksums.json'), 'utf8'));
  const entry = manifest.files.find(file => file.p === 'health.json');
  assert.ok(entry, 'final health.json must be in checksums.json');
  assert.equal(entry.s, bytes.length);
  assert.equal(entry.h, createHash('sha256').update(bytes).digest('hex'));
  return JSON.parse(bytes.toString('utf8'));
}

test('strict export blocks leaked metadata and incomplete privacy scans while preserving the accepted bundle', { timeout: 240_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-privacy-export-'));
  const host = 'privacy-fixture.test';
  const site = join(dir, 'workspace', host);
  const out = join(dir, 'deliverable', 'accepted');
  try {
    mkdirSync(join(site, 'pages', 'home', 'clone'), { recursive: true });
    mkdirSync(join(site, 'live'), { recursive: true });
    mkdirSync(join(site, 'intel'), { recursive: true });
    writeFileSync(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: `https://${host}/` }));
    writeFileSync(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title><main>clone</main>');
    writeFileSync(join(site, 'live', 'index.html'), '<!doctype html><title>live</title><main>ready</main>');

    const run = () => spawnSync(process.execPath, [EXPORT, host, '--offline', '--strict', '--root', 'mirror', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 90_000,
    });
    const runFailure = () => {
      const before = new Set(readdirSync(join(dir, 'deliverable')));
      const result = run();
      assert.equal(result.status, 1, result.stderr + result.stdout);
      const candidateName = readdirSync(join(dir, 'deliverable'))
        .find(name => name.startsWith('.candidate-') && !before.has(name));
      assert.ok(candidateName, 'failed candidate remains for diagnosis');
      const candidate = join(dir, 'deliverable', candidateName);
      return { candidate, health: assertHealthChecksum(candidate) };
    };

    const initial = run();
    assert.equal(initial.status, 0, initial.stderr + initial.stdout);
    const acceptedHealth = readFileSync(join(out, 'health.json'));
    const acceptedChecksums = readFileSync(join(out, 'checksums.json'));
    assert.equal(assertHealthChecksum(out).privacyAudit.status, 'clean');

    const privateFile = join(site, 'intel', 'alice@example.com.json');
    writeFileSync(privateFile, JSON.stringify({
      target: `https://${host}/private?access_token=privateQuery12345&page=1`,
      Authorization: 'Bearer privateBearer12345',
      Cookie: 'session=privateCookie12345',
    }));
    const leaked = runFailure();
    assert.equal(leaked.health.privacyAudit.status, 'issues');
    assert.equal(leaked.health.strictBlockers.privacyIssues, 3);
    assert.equal(leaked.health.strictBlockers.privacyIncomplete, 0);
    assert.deepEqual(leaked.health.privacyAudit.counts, {
      'credential-query': 1, 'bearer-value': 1, 'cookie-value': 1,
    });
    assert.ok(leaked.health.privacyAudit.findings.every(item => item.path.startsWith('site/static/')));
    assert.doesNotMatch(JSON.stringify(leaked.health.privacyAudit), /privateQuery|privateBearer|privateCookie|alice@/);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);
    assert.deepEqual(readFileSync(join(out, 'checksums.json')), acceptedChecksums);

    rmSync(privateFile);
    writeFileSync(join(site, 'intel', 'oversized.txt'), 'x'.repeat(16 * 1024 * 1024 + 1));
    const incomplete = runFailure();
    assert.equal(incomplete.health.privacyAudit.status, 'incomplete');
    assert.ok(incomplete.health.privacyAudit.failures.some(item => item.reason === 'file-byte-limit'));
    assert.ok(incomplete.health.strictBlockers.privacyIncomplete > 0);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);
    assert.deepEqual(readFileSync(join(out, 'checksums.json')), acceptedChecksums);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
