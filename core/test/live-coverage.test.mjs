import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildCoverageLedger } from '../src/live/coverage.mjs';
import { liveSnapshotPath } from '../src/live/live-path.mjs';
import { sanitizeStaticHtml } from '../src/static-html-safety.mjs';
import { evidenceSha256, measurementIdentity, resultSha256 } from '../src/verify/resume-cache.mjs';
import { verifierSha256 } from '../src/verify/verifier-fingerprint.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'fixture.test';
const ORIGIN = 'https://' + HOST;

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function clone(base, bundle, name, target, live = true) {
  put(join(base, 'pages', name, 'manifest.json'), JSON.stringify({ target }));
  put(join(base, 'pages', name, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  put(join(bundle, 'site', 'static', HOST, 'pages', name, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  if (live) {
    const url = new URL(target);
    put(join(bundle, 'site', 'live', liveSnapshotPath(url.pathname, url.search)), '<!doctype html><title>live</title>');
  }
}

let verifier;
function writeVerification(base, name, result) {
  const out = join(base, 'verify', name);
  result.viewports = result.viewports.map(viewport => ({ ...viewport, captureMode: 'full',
    settleTimedOut: false, additionalVisibleBrokenImages: 0 }));
  const options = { viewports: result.viewports.map(viewport => viewport.name), interactions: false,
    keepScreenshots: false, allowBounded: false, settleTimeout: 5000, jobs: 1 };
  for (const viewport of result.viewports) put(join(out, `diff-${viewport.name}.png`), 'fixture evidence');
  verifier ??= verifierSha256();
  const identity = measurementIdentity(join(base, 'pages', name), options, verifier);
  result.measurementProof = { ...identity, evidence: evidenceSha256(result, out, false), resultSha256: resultSha256(result) };
  put(join(out, 'verify.json'), JSON.stringify(result));
}

function run(script, args, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('command hung: ' + output)); }, 60_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('real verification and export stop counting a clone after its stylesheet changes', { timeout: 120_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-real-'));
  const base = join(dataDir, 'workspace', HOST);
  const page = join(base, 'pages', 'home');
  const html = sanitizeStaticHtml('<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body></body></html>');
  const red = 'body { margin: 0; background: red; }';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': req.url === '/style.css' ? 'text/css' : 'text/html' });
    res.end(req.url === '/style.css' ? red : html);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    put(join(page, 'manifest.json'), JSON.stringify({ target: origin + '/' }));
    put(join(page, 'clone', 'index.html'), html);
    put(join(page, 'clone', 'style.css'), red);
    put(join(base, 'live', 'index.html'), html);
    const verification = await run(fileURLToPath(new URL('../src/verify/verify.mjs', import.meta.url)),
      [HOST, '--all', '--no-interactions', '--viewports', '100x100'], dataDir);
    assert.equal(verification.code, 0, verification.output);
    const firstOut = join(dataDir, 'deliverable', 'first');
    const first = await run(EXPORT, [HOST, '--offline', '--out', firstOut], dataDir);
    assert.equal(first.code, 0, first.output);
    assert.equal(JSON.parse(readFileSync(join(firstOut, 'health.json'), 'utf8')).coverage.verifiedV2, 1);

    const ledger = () => buildCoverageLedger({ baseDir: base, bundleDir: firstOut, host: HOST, origin, pageNames: ['home'] });
    const index = join(page, 'clone', 'index.html');
    const future = new Date(Date.now() + 60_000);
    utimesSync(index, future, future);
    assert.equal(ledger().verifiedV2, 1, 'mtime alone does not change the verified content');
    const bundledCss = join(firstOut, 'site', 'static', HOST, 'pages', 'home', 'clone', 'style.css');
    writeFileSync(bundledCss, 'body { background: blue; }');
    assert.equal(ledger().verifiedV2, 0, 'the delivered clone must match the verified files');
    writeFileSync(bundledCss, red);
    const diff = join(base, 'verify', 'home', 'diff-100x100.png');
    const evidence = readFileSync(diff);
    writeFileSync(diff, 'modified');
    assert.equal(ledger().verifiedV2, 0, 'changed measurement evidence is not verified');
    rmSync(diff);
    assert.equal(ledger().verifiedV2, 0, 'missing measurement evidence is not verified');
    writeFileSync(diff, evidence);
    const resultFile = join(base, 'verify', 'home', 'verify.json');
    const result = readFileSync(resultFile);
    const legacy = JSON.parse(result);
    delete legacy.measurementProof;
    writeFileSync(resultFile, JSON.stringify(legacy));
    assert.equal(ledger().verifiedV2, 0, 'older records cannot prove input identity');
    const wrongVerifier = JSON.parse(result);
    wrongVerifier.measurementProof.verifier = 'outdated';
    writeFileSync(resultFile, JSON.stringify(wrongVerifier));
    assert.equal(ledger().verifiedV2, 0, 'a different verifier cannot certify the current result');
    const changedScore = JSON.parse(result);
    changedScore.overall = 0.5;
    writeFileSync(resultFile, JSON.stringify(changedScore));
    assert.equal(ledger().verifiedV2, 0, 'a changed measurement result is not verified');
    writeFileSync(resultFile, result);
    assert.equal(ledger().verifiedV2, 1);

    const css = join(page, 'clone', 'style.css');
    const old = statSync(css);
    writeFileSync(css, 'body { margin: 0; background: blue; }');
    utimesSync(css, old.atime, old.mtime);
    const secondOut = join(dataDir, 'deliverable', 'second');
    const second = await run(EXPORT, [HOST, '--offline', '--out', secondOut], dataDir);
    assert.equal(second.code, 0, second.output);
    assert.equal(JSON.parse(readFileSync(join(secondOut, 'health.json'), 'utf8')).coverage.verifiedV2, 0);

    const single = await run(fileURLToPath(new URL('../src/verify/verify.mjs', import.meta.url)),
      [HOST, 'home', '--viewports', '100x100'], dataDir);
    assert.equal(single.code, 0, single.output);
    assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).measurementProof.options.interactions, true);
    assert.equal(buildCoverageLedger({ baseDir: base, bundleDir: secondOut, host: HOST, origin, pageNames: ['home'] }).verifiedV2, 1,
      'single-page verification can establish new proof');

    writeFileSync(index, html.replace('</body>', '<script>globalThis.fixture = true;</script></body>'));
    const withScript = await run(fileURLToPath(new URL('../src/verify/verify.mjs', import.meta.url)),
      [HOST, 'home', '--viewports', '100x100'], dataDir);
    assert.equal(withScript.code, 0, withScript.output);
    assert.ok(JSON.parse(readFileSync(resultFile, 'utf8')).measurementProof);
    writeFileSync(join(secondOut, 'site', 'static', HOST, 'pages', 'home', 'clone', 'index.html'), readFileSync(index));
    assert.equal(buildCoverageLedger({ baseDir: base, bundleDir: secondOut, host: HOST, origin, pageNames: ['home'] }).verifiedV2, 1,
      'the unsanitized copy still matches the measurement');
    const sanitizedOut = join(dataDir, 'deliverable', 'sanitized');
    const sanitized = await run(EXPORT, [HOST, '--offline', '--out', sanitizedOut], dataDir);
    assert.equal(sanitized.code, 0, sanitized.output);
    const sanitizedHtml = readFileSync(join(sanitizedOut, 'site', 'static', HOST, 'pages', 'home', 'clone', 'index.html'), 'utf8');
    assert.doesNotMatch(sanitizedHtml, /globalThis\.fixture/);
    assert.equal(JSON.parse(readFileSync(join(sanitizedOut, 'health.json'), 'utf8')).coverage.verifiedV2, 0,
      'export sanitization changes the verified clone');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('coverage matches origin and query-specific routes, reporting undistributed paths without query secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    clone(base, bundle, 'list', ORIGIN + '/list?page=1', false);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({
      origin: ORIGIN, nodes: [
        { url: ORIGIN + '/' },
        { url: ORIGIN + '/list?page=1' },
        { url: ORIGIN + '/users/alice@example.com?token=secret' },
        { url: ORIGIN + '/reset/short-secret?token=hidden' },
      ], meta: { maxPages: 40, maxDepth: 2 },
    }));
    const ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home', 'list'] });
    assert.equal(ledger.scope, 'recon-discovered');
    assert.equal(ledger.denominator, 4);
    assert.equal(ledger.capturedClones, 2);
    assert.equal(ledger.cloned, 2);
    assert.equal(ledger.delivered, 1);
    assert.equal(ledger.missingClone, 2);
    assert.equal(ledger.missingLive, 1);
    assert.deepEqual(ledger.missingPaths, [
      { sourceIndex: 1, path: '/[redacted]?[redacted]', reason: 'no-live-route' },
      { sourceIndex: 2, path: '/[redacted]/[redacted]?[redacted]', reason: 'not-cloned' },
      { sourceIndex: 3, path: '/[redacted]/[redacted]?[redacted]', reason: 'not-cloned' },
    ]);
    assert.doesNotMatch(JSON.stringify(ledger), /alice|secret|page=1|short-secret|hidden/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coverage explicitly limits no-atlas claims and rejects a foreign atlas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-source-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    let ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.scope, 'captured-only');
    assert.equal(ledger.denominator, 1);
    assert.equal(ledger.delivered, 1);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://other.test', nodes: [{ url: 'https://other.test/' }] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.scope, 'untrusted-recon');
    assert.equal(ledger.sourceStatus, 'invalid');
    assert.equal(ledger.sourceIssue, 'origin-mismatch');
    assert.equal(ledger.denominator, null);
    assert.equal(ledger.missingClone, 0);
    assert.equal(ledger.extraClones, null);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ nodes: [{ url: ORIGIN + '/' }, { url: 'https://other.test/' }] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.sourceIssue, 'foreign-nodes');
    assert.equal(ledger.foreignNodes, 1);
    assert.equal(ledger.denominator, null);
    assert.equal(ledger.observedTargets, 1);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ nodes: [{ url: ORIGIN + '/' }] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.sourceStatus, 'ok', 'single-origin legacy atlas remains usable');
    assert.equal(ledger.denominator, 1);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: ORIGIN, status: 'ok', nodes: [] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.sourceIssue, 'empty-atlas');
    assert.equal(ledger.denominator, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coverage uses one discovered denominator for default queue, actual queue, fresh v2 verification and delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-stages-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    clone(base, bundle, 'docs', ORIGIN + '/docs', false);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({
      origin: ORIGIN,
      nodes: [
        { url: ORIGIN + '/', type: 'home' },
        { url: ORIGIN + '/docs', type: 'docs' },
        { url: ORIGIN + '/login', type: 'auth' },
      ], meta: { maxPages: 3, maxDepth: 2, depthLimitReached: true, depthLimitUrls: 2,
        sitemap: { truncated: ['url-limit'], declaredSitemapFailures: 1, offOriginSitemaps: 2, offOriginPages: 3 } },
    }));
    put(join(base, 'queue.json'), JSON.stringify([
      { url: ORIGIN + '/', status: 'done' },
      { url: ORIGIN + '/docs', status: 'pending' },
    ]));
    const verification = {
      target: ORIGIN + '/', generatedAt: new Date(Date.now() + 1000).toISOString(),
      scoreVersion: 2, measured: true, overall: 0.98,
      viewports: ['375x812', '768x1024', '1440x900'].map(name => ({ name, score: 0.98 })),
    };
    writeVerification(base, 'home', verification);
    let ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home', 'docs'] });
    assert.equal(ledger.version, 2);
    assert.equal(ledger.denominator, 3);
    assert.equal(ledger.discovery.scopeLimited, true);
    assert.equal(ledger.discovery.depthLimitReached, true);
    assert.equal(ledger.discovery.depthLimitUrls, 2);
    assert.deepEqual(ledger.discovery.sitemapTruncated, ['url-limit']);
    assert.equal(ledger.discovery.declaredSitemapFailures, 1);
    assert.equal(ledger.discovery.offOriginSitemaps, 2);
    assert.equal(ledger.discovery.offOriginPages, 3);
    assert.deepEqual(ledger.defaultQueue, {
      eligible: 2, excluded: 1, excludedByType: 1, excludedByPageLimit: 0,
    });
    assert.deepEqual(ledger.queue, { status: 'ok', queued: 2, notQueued: 1, outsideScope: 0 });
    assert.equal(ledger.cloned, 2);
    assert.equal(ledger.verifiedV2, 1);
    assert.equal(ledger.verifiedStandardViewports, 1);
    assert.equal(ledger.unverifiedV2, 2);
    assert.equal(ledger.delivered, 1);

    put(join(base, 'verify', 'verify-summary.json'), JSON.stringify({
      mode: 'all', generatedAt: new Date(Date.now() + 2000).toISOString(),
      pages: [{ page: 'home', measured: false }],
    }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home', 'docs'] });
    assert.equal(ledger.verifiedV2, 0, 'a later site summary invalidates an old per-page success');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('off-origin sitemap pages are visible without enlarging the same-origin denominator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-foreign-pages-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({
      origin: ORIGIN, status: 'ok', nodes: [{ url: ORIGIN + '/' }],
      meta: { maxPages: 3, maxDepth: 2, sitemap: { coverage: 'complete', offOriginPages: 2, truncated: [] } },
    }));
    const ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.denominator, 1);
    assert.equal(ledger.discovery.offOriginPages, 2);
    assert.equal(ledger.discovery.scopeLimited, false, 'foreign pages are outside the declared same-origin scope');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete and older unknown sitemap coverage limit the discovered scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-sitemap-state-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    const file = join(base, 'recon', 'atlas.json');
    const atlas = { origin: ORIGIN, status: 'ok', nodes: [{ url: ORIGIN + '/' }],
      meta: { maxPages: 3, sitemap: { coverage: 'unavailable', reasons: ['robots-unavailable'], truncated: [] } } };
    put(file, JSON.stringify(atlas));
    let ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.discovery.scopeLimited, true);
    assert.equal(ledger.discovery.sitemapCoverage, 'unavailable');
    assert.deepEqual(ledger.discovery.sitemapReasons, ['robots-unavailable']);
    delete atlas.meta.sitemap.coverage;
    put(file, JSON.stringify(atlas));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.discovery.sitemapCoverage, 'unknown');
    assert.equal(ledger.discovery.scopeLimited, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coverage does not count copied stale or one-viewport verification as standard multiview proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-verify-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: ORIGIN, nodes: [{ url: ORIGIN + '/' }] }));
    const verifyPath = join(base, 'verify', 'home', 'verify.json');
    put(verifyPath, JSON.stringify({
      target: ORIGIN + '/', generatedAt: '2020-01-01T00:00:00.000Z', scoreVersion: 2,
      measured: true, viewports: [{ name: '375x812', score: 0.99 }],
    }));
    let ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.verifiedV2, 0, 'copying an old verify file after the clone must not make it fresh');

    writeVerification(base, 'home', {
      target: ORIGIN + '/', generatedAt: new Date(Date.now() + 1000).toISOString(), scoreVersion: 2,
      measured: true, overall: 0.99, viewports: [{ name: '375x812', score: 0.99 }],
    });
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.verifiedV2, 1);
    assert.equal(ledger.verifiedStandardViewports, 0);

    put(join(base, 'queue.json'), JSON.stringify([{ url: 'https://foreign.test/', status: 'done' }]));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.deepEqual(ledger.queue, { status: 'invalid', queued: null, notQueued: null, outsideScope: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict export blocks every discovered but un-cloned URL, including nodes beyond page 40', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-export-'));
  const base = join(dir, 'workspace', HOST);
  const out = join(dir, 'deliverable', 'accepted');
  try {
    put(join(base, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: ORIGIN + '/' }));
    put(join(base, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    put(join(base, 'live', 'index.html'), '<!doctype html><title>live</title>');
    const nodes = [{ url: ORIGIN + '/' }, ...Array.from({ length: 44 }, (_, i) => ({ url: ORIGIN + '/page-' + (i + 1) }))];
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: ORIGIN, status: 'ok', nodes, meta: { maxPages: 100, maxDepth: 3 } }));
    put(join(out, 'keep.txt'), 'last accepted');
    const result = spawnSync(process.execPath, [EXPORT, HOST, '--offline', '--strict', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'last accepted');
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(health.coverage.denominator, 45);
    assert.equal(health.coverage.delivered, 1);
    assert.equal(health.coverage.missingClone, 44);
    assert.equal(health.coverage.missingPaths.length, 44);
    assert.equal(health.strictBlockers.discoveredUncloned, 44);
    assert.equal(health.browserProbe.untested, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict export refuses a foreign recon despite a matching site ownership marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-origin-'));
  const base = join(dir, 'workspace', HOST);
  const out = join(dir, 'deliverable', 'accepted');
  try {
    put(join(base, 'site-origin.json'), JSON.stringify({ origin: ORIGIN }));
    put(join(base, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: ORIGIN + '/' }));
    put(join(base, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    put(join(base, 'live', 'index.html'), '<!doctype html><title>live</title>');
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://other.test', nodes: [{ url: 'https://other.test/private' }] }));
    put(join(out, 'keep.txt'), 'last accepted');
    const result = spawnSync(process.execPath, [EXPORT, HOST, '--offline', '--strict', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'last accepted');
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(health.coverage.denominator, null);
    assert.equal(health.coverage.sourceIssue, 'origin-mismatch');
    assert.equal(health.strictBlockers.coverageInvalid, 1);
    assert.equal(health.strictBlockers.discoveredUncloned, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
