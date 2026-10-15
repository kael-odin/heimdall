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

test('offline export preserves external pixels unless explicitly omitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-export-pixel-'));
  try {
    const host = 'fixture.test';
    const live = join(dir, 'workspace', host, 'live');
    const preserved = join(dir, 'deliverable', 'preserved');
    const omitted = join(dir, 'deliverable', 'omitted');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'index.html'), '<!doctype html><html><body>'
      + '<img src="https://tracker.test/hit" width="1" height="1" style="display:none">'
      + '<script src="https://cdn.test/app.js"></script>'
      + '</body></html>');
    const run = (...args) => spawnSync(process.execPath, [EXPORT, host, ...args], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 30_000,
    });

    const defaultResult = run('--offline', '--out', preserved);
    assert.equal(defaultResult.status, 0, defaultResult.stderr + defaultResult.stdout);
    const defaultHealth = JSON.parse(readFileSync(join(preserved, 'health.json'), 'utf8'));
    assert.deepEqual(defaultHealth.nonvisualExternalPixels, { policy: 'preserve', files: 0, removed: 0 });
    assert.match(readFileSync(join(preserved, 'site', 'live', 'index.html'), 'utf8'), /tracker\.test\/hit/);

    const omitResult = run('--offline', '--omit-nonvisual-pixels', '--out', omitted);
    assert.equal(omitResult.status, 0, omitResult.stderr + omitResult.stdout);
    const omitHealth = JSON.parse(readFileSync(join(omitted, 'health.json'), 'utf8'));
    assert.deepEqual(omitHealth.nonvisualExternalPixels, { policy: 'omit', files: 1, removed: 1 });
    const omittedHtml = readFileSync(join(omitted, 'site', 'live', 'index.html'), 'utf8');
    assert.doesNotMatch(omittedHtml, /tracker\.test\/hit/);
    assert.match(omittedHtml, /cdn\.test\/app\.js/, 'external scripts cannot be omitted as pixels');
    assert.equal(omitHealth.strictBlockers.externalAssets, 1, 'the external script remains a blocker');

    const onlineResult = run('--omit-nonvisual-pixels', '--out', join(dir, 'deliverable', 'online'));
    assert.equal(onlineResult.status, 2);
    assert.match(onlineResult.stderr, /requires --offline/);
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
    mkdirSync(join(site, 'recon'), { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'last-good');
    writeFileSync(join(site, 'pages', 'home', 'clone', 'index.html'), '<html>clone</html>');
    writeFileSync(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({
      origin: 'https://fixture.test', status: 'ok',
      nodes: [{ url: 'https://fixture.test/', title: 'atlas-secret-title' }],
      note: 'atlas-secret-token', meta: { maxPages: 40 },
    }));
    writeFileSync(join(site, 'pages', 'home', 'network.har'), JSON.stringify({ log: { entries: [{
      request: { method: 'GET', url: 'https://fixture.test/users/alice@example.com/avatar.webp' },
      response: { status: 200, content: { mimeType: 'image/webp', text: 'private-image' } },
    }] } }));
    writeFileSync(join(site, 'live', 'index.html'), '<img src="/_next/image?url=/a.png&w=64"><script src="https://cdn.test/app.js"></script><a href="/missing/">missing</a>');
    const run = (...args) => spawnSync(process.execPath, [EXPORT, host, ...args], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 90_000,
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
    assert.equal(run('--strict', '--out', out).status, 2, 'strict must not publish an online fallback bundle');
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
    assert.equal(goodHealth.browserProbe.checked, 1);
    assert.equal(goodHealth.browserProbe.failed, 0);
    assert.equal(goodHealth.browserProbe.untested, 0);
    assert.equal(goodHealth.browserProbe.observation.minimumMs, 3_000);
    assert.equal(goodHealth.browserProbe.observation.observedPages, 1);
    assert.equal(goodHealth.coverage.delivered, 1);
    assert.equal(existsSync(join(out, 'site', 'static', host, 'recon', 'atlas.json')), false);
    assert.doesNotMatch(readFileSync(join(out, 'health.json'), 'utf8'), /atlas-secret-title|atlas-secret-token/);
    const configured = run('--offline', '--strict', '--browser-observe-ms', '3500', '--out', out);
    assert.equal(configured.status, 0, configured.stderr + configured.stdout);
    const configuredHealth = JSON.parse(readFileSync(join(out, 'health.json'), 'utf8'));
    assert.equal(configuredHealth.browserProbe.observation.minimumMs, 3_500);
    assert.ok(configuredHealth.browserProbe.observation.pages[0].elapsedMs >= 3_500);
    const acceptedHealth = readFileSync(join(out, 'health.json'));
    assert.equal(run('--offline', '--strict', '--browser-observe-ms', '--out', out).status, 2,
      'an incomplete observation option must not silently shorten the configured window');
    const failedStrictHealth = () => {
      const before = new Set(readdirSync(join(dir, 'deliverable')));
      const failed = run('--offline', '--strict', '--out', out);
      assert.equal(failed.status, 1, failed.stderr + failed.stdout);
      const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-') && !before.has(name));
      assert.ok(candidate, 'failed candidate remains for diagnosis');
      assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth,
        'failed strict export must preserve the accepted bundle');
      return JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    };

    writeFileSync(join(site, 'live', 'app.js'), "fetch('/api/missing?token=local-secret').catch(() => {});");
    const dynamicFailure = failedStrictHealth();
    assert.equal(dynamicFailure.strictBlockers.browserFailed, 1);
    assert.ok(dynamicFailure.browserProbe.failures.some(f => f.kind === 'http' && f.status === 404 && f.target === '/api/missing'));
    assert.doesNotMatch(JSON.stringify(dynamicFailure), /local-secret/);

    writeFileSync(join(site, 'live', 'app.js'), "setTimeout(() => fetch('/api/late?token=late-secret').catch(() => {}), 2000);");
    const delayedFailure = failedStrictHealth();
    assert.equal(delayedFailure.strictBlockers.browserFailed, 1);
    assert.ok(delayedFailure.browserProbe.failures.some(f => f.kind === 'http' && f.status === 404 && f.target === '/api/late'));
    assert.doesNotMatch(JSON.stringify(delayedFailure), /late-secret/);

    writeFileSync(join(site, 'live', 'app.js'), "fetch('https://example.invalid/data?token=external-secret').catch(() => {});");
    const externalFailure = failedStrictHealth();
    assert.equal(externalFailure.strictBlockers.browserFailed, 1);
    assert.ok(externalFailure.browserProbe.failures.some(f => f.kind === 'externalRequest' && f.target === 'https://example.invalid'));
    assert.doesNotMatch(JSON.stringify(externalFailure), /external-secret/);

    writeFileSync(join(site, 'live', 'index.html'), '<style>body{background:url(/missing-bg.webp)}</style>');
    const inlineFailure = run('--offline', '--strict', '--out', out);
    assert.equal(inlineFailure.status, 1, inlineFailure.stderr + inlineFailure.stdout);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth,
      'inline CSS failure must preserve the previously accepted bundle');
    writeFileSync(join(site, 'live', 'index.html'), '<script src="/app.js"></script>');
    writeFileSync(join(site, 'live', 'app.js'), 'console.log(1)');
    for (let i = 0; i < 40; i++) {
      const pageDir = join(site, 'live', 'extra-' + i);
      mkdirSync(pageDir);
      writeFileSync(join(pageDir, 'index.html'), '<!doctype html><title>extra</title>');
    }
    const fullSite = run('--offline', '--strict', '--out', out);
    assert.equal(fullSite.status, 0, fullSite.stderr + fullSite.stdout);
    const fullHealth = JSON.parse(readFileSync(join(out, 'health.json'), 'utf8'));
    assert.equal(fullHealth.browserProbe.totalPages, 41);
    assert.equal(fullHealth.browserProbe.checked, 41);
    assert.equal(fullHealth.browserProbe.untested, 0);
    assert.equal(fullHealth.browserProbe.failed, 0);
    assert.equal(fullHealth.strictBlockers.browserUntested, 0);

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
