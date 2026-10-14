import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertExportTarget, promoteCandidate } from '../src/live/export-path.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

test('export target rejects root, siblings, escapes and symlinks without touching files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-export-path-'));
  try {
    const root = join(dir, 'deliverable');
    const sibling = join(dir, 'deliverable-old');
    mkdirSync(root);
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'keep.txt'), 'original');
    assert.throws(() => assertExportTarget(root, root), /inside deliverable/);
    assert.throws(() => assertExportTarget(root, sibling), /inside deliverable/);
    assert.throws(() => assertExportTarget(root, join(root, '..', 'deliverable-old')), /inside deliverable/);
    const link = join(root, 'linked');
    try {
      symlinkSync(sibling, link, 'dir');
      assert.throws(() => assertExportTarget(root, join(link, 'bundle')), /symlink/);
    } catch (e) {
      if (e.code !== 'EPERM') throw e;
    }
    assert.equal(readFileSync(join(sibling, 'keep.txt'), 'utf8'), 'original');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline strict rejects dynamic, external and missing pages while preserving previous bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-export-strict-'));
  try {
    const host = 'fixture.test';
    const site = join(dir, 'workspace', host);
    const out = join(dir, 'deliverable', 'fixture-live');
    mkdirSync(join(site, 'pages', 'home', 'clone'), { recursive: true });
    mkdirSync(join(site, 'live'), { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'last-good');
    writeFileSync(join(site, 'pages', 'home', 'clone', 'index.html'), '<html>clone</html>');
    writeFileSync(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(join(site, 'pages', 'home', 'network.har'), JSON.stringify({ log: { entries: [{
      request: { method: 'GET', url: 'https://fixture.test/users/alice@example.com/avatar.webp' },
      response: { status: 200, content: { mimeType: 'image/webp', text: 'private-image' } },
    }] } }));
    writeFileSync(join(site, 'live', 'index.html'), '<img src="/_next/image?url=/a.png&w=64"><script src="https://cdn.test/app.js"></script><a href="/missing/">missing</a>');
    const run = (...args) => spawnSync(process.execPath, [EXPORT, host, ...args], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 30_000,
    });
    const result = run('--offline', '--strict', '--out', out);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'last-good');
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate, 'failed candidate remains for diagnosis');
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.ok(health.strictBlockers.dynamic > 0);
    assert.ok(health.strictBlockers.externalAssets > 0);
    assert.ok(health.strictBlockers.missingLinks > 0);
    assert.equal(run('--out', join(dir, 'deliverable')).status, 2);
    assert.equal(run('--out', join(dir, 'deliverable-old')).status, 2);
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'last-good');
    const promoted = run('--out', out);
    assert.equal(promoted.status, 0, promoted.stderr + promoted.stdout);
    assert.ok(existsSync(join(out, 'health.json')));
    assert.doesNotMatch(readFileSync(join(out, 'har.json'), 'utf8'), /alice|private-image|cHJpdmF0ZS1pbWFnZQ==/);
    const privacy = JSON.parse(readFileSync(join(out, 'har-privacy.json'), 'utf8'));
    assert.equal(privacy.excluded.privateUrl, 1);
    assert.deepEqual(privacy.examples[0], { reason: 'privateUrl', path: 'https://fixture.test/[redacted]' });
    const backup = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.backup-fixture-live-'));
    assert.equal(readFileSync(join(dir, 'deliverable', backup, 'keep.txt'), 'utf8'), 'last-good');
    writeFileSync(join(site, 'live', 'index.html'), '<script src="/app.js"></script>');
    writeFileSync(join(site, 'live', 'app.js'), 'console.log(1)');
    const strictSuccess = run('--offline', '--strict', '--out', out);
    assert.equal(strictSuccess.status, 0, strictSuccess.stderr + strictSuccess.stdout);
    const goodHealth = JSON.parse(readFileSync(join(out, 'health.json'), 'utf8'));
    assert.equal(goodHealth.runtimeProbe.failed, 0);
    assert.ok(goodHealth.runtimeProbe.checked >= 2);
    const acceptedHealth = readFileSync(join(out, 'health.json'));
    writeFileSync(join(site, 'live', 'index.html'), '<style>body{background:url(/missing-bg.webp)}</style>');
    const inlineFailure = run('--offline', '--strict', '--out', out);
    assert.equal(inlineFailure.status, 1, inlineFailure.stderr + inlineFailure.stdout);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth,
      'inline CSS failure must preserve the previously accepted bundle');
    writeFileSync(join(site, 'live', 'index.html'), '<script src="/app.js"></script>');
    writeFileSync(join(site, 'session.json'), '{"cookies":[{"name":"sid","value":"private-secret"}]}');
    assert.equal(run('--out', out).status, 2, 'saved sessions require explicit private release');
    assert.equal(run('--allow-private-export', '--out', out).status, 0);
    assert.equal(existsSync(join(out, 'site', 'static', host, 'session.json')), false);
    assert.equal(JSON.parse(readFileSync(join(out, 'har-privacy.json'), 'utf8')).privateExportApproved, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export promotion swaps candidate and retains the previous bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-export-promote-'));
  try {
    const root = join(dir, 'deliverable');
    const out = join(root, 'site');
    const candidate = join(root, '.candidate-site');
    mkdirSync(out, { recursive: true });
    mkdirSync(candidate);
    writeFileSync(join(out, 'version.txt'), 'old');
    writeFileSync(join(candidate, 'version.txt'), 'new');
    const result = promoteCandidate(root, out, candidate);
    assert.equal(readFileSync(join(out, 'version.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(join(result.backup, 'version.txt'), 'utf8'), 'old');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
