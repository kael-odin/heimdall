import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'fixture.test';
const ORIGIN = `https://${HOST}`;
const SCRIPT = 'https://cdn.example.org/app.js';
const CARBON = 'https://cdn.carbonads.com/carbon.js?serve=public-test';
const UNAPPROVED = 'https://images.example.org/banner.png';

test('external static approvals are opt-in and strict export preserves the last good bundle', { timeout: 90_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-external-export-'));
  const site = join(root, 'workspace', HOST);
  const live = join(site, 'live');
  const page = join(site, 'pages', 'home');
  const out = join(root, 'deliverable', 'bundle');
  const approvalsFile = join(root, 'approvals.json');
  const fetchLog = join(root, 'fetch.log');
  const fetchStub = join(root, 'fetch-stub.mjs');
  let breakFetch = false;
  try {
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(join(site, 'recon'), { recursive: true });
    mkdirSync(live, { recursive: true });
    mkdirSync(join(root, 'deliverable'), { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: ORIGIN + '/' }));
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><title>Clone</title>');
    writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({
      origin: ORIGIN, status: 'ok', nodes: [{ url: ORIGIN + '/', title: 'Home' }],
    }));
    writeFileSync(join(live, 'index.html'), `<!doctype html><title>Home</title><script src="${SCRIPT}"></script><h1>Home</h1>`);
    writeFileSync(fetchStub, `import { appendFileSync } from 'node:fs';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https:')) {
    appendFileSync(process.env.HEIMDALL_FETCH_LOG, url + '\\n');
    if (url === ${JSON.stringify(SCRIPT)}) {
      if (process.env.HEIMDALL_FETCH_BREAK === '1') {
        return Promise.resolve({ status: 200, headers: { get() { throw new Error('fixture failure'); } } });
      }
      return Promise.resolve(new Response('window.externalStaticLoaded = true;', {
        headers: { 'content-type': 'text/javascript' },
      }));
    }
    throw new Error('unexpected external fetch');
  }
  return nativeFetch(input, options);
};
`);
    const run = (...flags) => spawnSync(process.execPath, ['--import', pathToFileURL(fetchStub).href, EXPORT, HOST,
      '--out', out, ...flags], {
      cwd: CORE, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_FETCH_LOG: fetchLog,
        HEIMDALL_FETCH_BREAK: breakFetch ? '1' : '0' },
    });
    const newestCandidate = (before, result) => {
      const name = readdirSync(join(root, 'deliverable'))
        .find(item => item.startsWith('.candidate-') && !before.has(item));
      assert.ok(name, 'failed strict export leaves a candidate: ' + result.stderr + result.stdout);
      return join(root, 'deliverable', name);
    };

    const beforeDefault = new Set(readdirSync(join(root, 'deliverable')));
    const defaultRun = run('--offline', '--strict');
    assert.equal(defaultRun.status, 1, defaultRun.stderr + defaultRun.stdout);
    const defaultHealth = JSON.parse(readFileSync(join(newestCandidate(beforeDefault, defaultRun), 'health.json'), 'utf8'));
    assert.equal(defaultHealth.strictBlockers.externalAssets, 1);
    assert.equal(defaultHealth.externalStatic, undefined);
    assert.equal(existsSync(fetchLog), false, 'default export must not fetch an external asset');

    writeFileSync(approvalsFile, JSON.stringify([SCRIPT]));
    const unsafeMode = run('--external-static-approvals', approvalsFile);
    assert.equal(unsafeMode.status, 2);
    assert.match(unsafeMode.stderr, /requires a JSON file and --offline --strict/);
    writeFileSync(approvalsFile, JSON.stringify(['http://cdn.example.org/app.js']));
    const invalidList = run('--offline', '--strict', '--external-static-approvals', approvalsFile);
    assert.equal(invalidList.status, 2);
    writeFileSync(approvalsFile, JSON.stringify([SCRIPT]));
    const approvedRun = run('--offline', '--strict', '--materialize-har', '--external-static-approvals', approvalsFile);
    assert.equal(approvedRun.status, 0, approvedRun.stderr + approvedRun.stdout);
    const acceptedHealth = readFileSync(join(out, 'health.json'));
    const health = JSON.parse(acceptedHealth);
    assert.equal(health.externalStatic.requested, 1);
    assert.equal(health.externalStatic.fetched, 1);
    assert.equal(health.externalStatic.failed, 0);
    assert.equal(health.strictBlockers.externalAssets, 0);
    assert.equal(health.strictBlockers.externalStaticFailed, 0);
    assert.equal(health.browserProbe.failed, 0);
    assert.match(readFileSync(join(out, 'site', 'live', 'index.html'), 'utf8'),
      /\/lm\/fixture\.test\/_ext\/cdn\.example\.org\/app\.js/);
    assert.equal(readFileSync(fetchLog, 'utf8').trim(), SCRIPT);
    assert.doesNotMatch(JSON.stringify(health.externalStatic), /cdn\.example\.org|app\.js/);

    writeFileSync(join(live, 'index.html'), `<!doctype html><title>Home</title>`
      + `<script src="${SCRIPT}"></script><script src="${SCRIPT}?v=2"></script>`
      + `<script src="${SCRIPT}-next"></script><a href="${SCRIPT}">Source</a>`);
    const beforeVariants = new Set(readdirSync(join(root, 'deliverable')));
    const variantsRun = run('--offline', '--strict', '--external-static-approvals', approvalsFile);
    assert.equal(variantsRun.status, 1, variantsRun.stderr + variantsRun.stdout);
    const variantsCandidate = newestCandidate(beforeVariants, variantsRun);
    const variantsHtml = readFileSync(join(variantsCandidate, 'site', 'live', 'index.html'), 'utf8');
    assert.match(variantsHtml, /src="\/lm\/fixture\.test\/_ext\/cdn\.example\.org\/app\.js"/);
    assert.ok(variantsHtml.includes(`src="${SCRIPT}?v=2"`));
    assert.ok(variantsHtml.includes(`src="${SCRIPT}-next"`));
    assert.ok(variantsHtml.includes(`href="${SCRIPT}"`));
    const variantsHealth = JSON.parse(readFileSync(join(variantsCandidate, 'health.json'), 'utf8'));
    assert.equal(variantsHealth.externalStatic.remainingExternal, 2);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);

    writeFileSync(join(live, 'index.html'), `<!doctype html><title>Home</title>`
      + `<script src="${SCRIPT}"></script>`
      + `<script>setTimeout(() => import("${SCRIPT}"), 30000)</script>`);
    const beforeRuntime = new Set(readdirSync(join(root, 'deliverable')));
    const runtimeRun = run('--offline', '--strict', '--external-static-approvals', approvalsFile);
    assert.equal(runtimeRun.status, 1, runtimeRun.stderr + runtimeRun.stdout);
    const runtimeHealth = JSON.parse(readFileSync(join(newestCandidate(beforeRuntime, runtimeRun), 'health.json'), 'utf8'));
    assert.deepEqual(runtimeHealth.externalStatic.failures,
      [{ index: 0, reason: 'unrewritten-runtime-reference' }]);
    assert.equal(runtimeHealth.strictBlockers.externalStaticFailed, 1);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);

    writeFileSync(join(live, 'index.html'), `<!doctype html><title>Home</title><script src="${SCRIPT}"></script><h1>Home</h1>`);

    breakFetch = true;
    const beforeCaptureError = new Set(readdirSync(join(root, 'deliverable')));
    const captureError = run('--offline', '--strict', '--external-static-approvals', approvalsFile);
    assert.equal(captureError.status, 1, captureError.stderr + captureError.stdout);
    const errorHealth = JSON.parse(readFileSync(join(newestCandidate(beforeCaptureError, captureError), 'health.json'), 'utf8'));
    assert.equal(errorHealth.externalStatic.error, 'capture-error');
    assert.equal(errorHealth.strictBlockers.externalStaticFailed, 1);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);
    breakFetch = false;

    writeFileSync(join(live, 'index.html'), `<!doctype html><title>Home</title><script src="${SCRIPT}"></script>`
      + `<script src="${CARBON}"></script><img src="${UNAPPROVED}"><h1>Home</h1>`);
    writeFileSync(approvalsFile, JSON.stringify([SCRIPT, CARBON]));
    const beforeFailure = new Set(readdirSync(join(root, 'deliverable')));
    const rejectedRun = run('--offline', '--strict', '--external-static-approvals', approvalsFile);
    assert.equal(rejectedRun.status, 1, rejectedRun.stderr + rejectedRun.stdout);
    const rejected = JSON.parse(readFileSync(join(newestCandidate(beforeFailure, rejectedRun), 'health.json'), 'utf8'));
    assert.deepEqual(rejected.externalStatic.failures, [{ index: 1, reason: 'prohibited-service' }]);
    assert.ok(rejected.strictBlockers.externalAssets >= 2);
    assert.equal(rejected.strictBlockers.externalStaticFailed, 1);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);
    assert.deepEqual(readFileSync(fetchLog, 'utf8').trim().split('\n'), [SCRIPT, SCRIPT, SCRIPT, SCRIPT, SCRIPT]);
    assert.doesNotMatch(JSON.stringify(rejected.externalStatic), /carbonads|public-test/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
