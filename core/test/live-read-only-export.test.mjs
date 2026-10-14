import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'read-data-source.invalid';
const ORIGIN = `https://${HOST}`;
const PUBLIC_PATH = '/api/catalog?page=2';
const SUMMARY_PATH = '/api/summary';

function harEntry(path, body, { requestHeaders = [] } = {}) {
  return {
    request: { method: 'GET', url: ORIGIN + path, headers: requestHeaders },
    response: { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }],
      content: { mimeType: 'application/json', text: body } },
  };
}

function runExport(source, out) {
  return spawnSync(process.execPath, [EXPORT, HOST, '--offline', '--strict', '--root', 'mirror',
    '--include-readonly-data', '--materialize-har', '--out', out], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: source }, encoding: 'utf8', timeout: 90_000,
  });
}

function failedCandidate(source, before) {
  const root = join(source, 'deliverable');
  const name = readdirSync(root).find(item => item.startsWith('.candidate-') && !before.has(item));
  assert.ok(name, 'strict failure must retain a candidate report');
  return join(root, name);
}

async function startBundle(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs', '--port', '0', '--host', '127.0.0.1'], {
      cwd: dir, env: { ...process.env, HEIMDALL_DATA_DIR: join(dir, 'no-source-workspace') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    const timer = setTimeout(() => fail(new Error('bundle startup timed out: ' + stderr)), 10_000);
    function fail(error) {
      clearTimeout(timer);
      child.kill();
      reject(error);
    }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`bundle exited (${code}): ${stderr}`)));
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      resolve({ child, base: `http://127.0.0.1:${message.port}` });
    });
  });
}

test('strict export packages only declared public GET data and replays it after relocation', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-read-data-export-'));
  const source = join(root, 'source');
  const site = join(source, 'workspace', HOST);
  const page = join(site, 'pages', 'home');
  const goodOut = join(source, 'deliverable', 'public-bundle');
  const deployed = join(root, 'deployed');
  let child;
  let browser;
  try {
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(join(site, 'live'), { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: ORIGIN + '/' }));
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><h1>Clone home</h1>');
    writeFileSync(join(site, 'live', 'index.html'), `<!doctype html><title>Catalog</title><h1>Catalog</h1><output id="result">Loading</output><script>
      fetch('${PUBLIC_PATH}').then(response => response.json()).then(data => {
        document.querySelector('#result').textContent = data.items.join(',');
      });
    </script>`);
    writeFileSync(join(page, 'network.har'), JSON.stringify({ log: { entries: [
      harEntry(PUBLIC_PATH, '{"items":["Public item"]}'),
      harEntry(SUMMARY_PATH, '{"count":1}'),
      harEntry('/api/private', '{"email":"private@example.invalid"}'),
      harEntry('/api/authenticated', '{"items":["session-only"]}', {
        requestHeaders: [{ name: 'Cookie', value: 'sid=private-secret' }],
      }),
    ] } }));

    const planPath = join(site, 'read-data-plan.json');
    const plan = paths => writeFileSync(planPath, JSON.stringify({ version: 1, paths }));
    plan([PUBLIC_PATH, SUMMARY_PATH]);
    const good = runExport(source, goodOut);
    assert.equal(good.status, 0, good.stderr + good.stdout);
    const goodHealth = JSON.parse(readFileSync(join(goodOut, 'health.json'), 'utf8'));
    assert.deepEqual(goodHealth.readOnlyData, { status: 'ok', declared: 2, included: 2, missing: 0 });
    assert.equal(goodHealth.strictBlockers.readOnlyDataMissing, 0);
    assert.equal(goodHealth.browserProbe.failed, 0);
    const bundledHar = JSON.parse(readFileSync(join(goodOut, 'har.json'), 'utf8'));
    const publicEntry = bundledHar.entries.find(item => item.url === ORIGIN + PUBLIC_PATH);
    assert.equal(publicEntry?.kind, 'public-read-only-data');
    assert.equal(Buffer.from(publicEntry.body, 'base64').toString(), '{"items":["Public item"]}',
      '--materialize-har must retain the exact query response body');
    const summaryEntry = bundledHar.entries.find(item => item.url === ORIGIN + SUMMARY_PATH);
    assert.equal(summaryEntry?.kind, 'public-read-only-data');
    assert.equal(Buffer.from(summaryEntry.body, 'base64').toString(), '{"count":1}',
      '--materialize-har must retain the no-query response body');
    assert.equal(existsSync(join(goodOut, 'site', 'live', 'api', 'catalog')), false);
    assert.equal(existsSync(join(goodOut, 'site', 'live', 'api', 'summary')), false);
    assert.doesNotMatch(JSON.stringify(bundledHar), /private@example.invalid|session-only|private-secret/);

    plan([PUBLIC_PATH, SUMMARY_PATH, '/api/missing']);
    let before = new Set(readdirSync(join(source, 'deliverable')));
    const missing = runExport(source, join(source, 'deliverable', 'missing-bundle'));
    assert.equal(missing.status, 1, missing.stderr + missing.stdout);
    const missingHealth = JSON.parse(readFileSync(join(failedCandidate(source, before), 'health.json'), 'utf8'));
    assert.deepEqual(missingHealth.readOnlyData, { status: 'ok', declared: 3, included: 2, missing: 1 });
    assert.equal(missingHealth.strictBlockers.readOnlyDataMissing, 1);
    assert.equal(existsSync(join(source, 'deliverable', 'missing-bundle')), false);

    plan([PUBLIC_PATH, SUMMARY_PATH, '/api/private', '/api/authenticated']);
    before = new Set(readdirSync(join(source, 'deliverable')));
    const privateResult = runExport(source, join(source, 'deliverable', 'private-bundle'));
    assert.equal(privateResult.status, 1, privateResult.stderr + privateResult.stdout);
    const privateCandidate = failedCandidate(source, before);
    const privateHealth = JSON.parse(readFileSync(join(privateCandidate, 'health.json'), 'utf8'));
    assert.equal(privateHealth.readOnlyData.included, 2);
    assert.equal(privateHealth.readOnlyData.missing, 2);
    assert.equal(privateHealth.strictBlockers.readOnlyDataMissing, 2);
    const privacy = JSON.parse(readFileSync(join(privateCandidate, 'har-privacy.json'), 'utf8'));
    assert.ok(privacy.excluded.privateBody >= 1);
    assert.ok(privacy.excluded.authenticated >= 1);
    assert.doesNotMatch(readFileSync(join(privateCandidate, 'har.json'), 'utf8'), /private@example.invalid|session-only|private-secret/);
    assert.equal(existsSync(join(source, 'deliverable', 'private-bundle')), false);

    cpSync(goodOut, deployed, { recursive: true });
    rmSync(source, { recursive: true, force: true });
    assert.equal(existsSync(source), false);
    const server = await startBundle(deployed);
    child = server.child;
    const response = await fetch(server.base + PUBLIC_PATH);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-heimdall-replay'), '1');
    assert.deepEqual(await response.json(), { items: ['Public item'] });
    const summaryResponse = await fetch(server.base + SUMMARY_PATH);
    assert.equal(summaryResponse.status, 200);
    assert.equal(summaryResponse.headers.get('x-heimdall-replay'), '1');
    assert.deepEqual(await summaryResponse.json(), { count: 1 });
    assert.equal((await fetch(server.base + '/api/missing')).status, 404);
    assert.equal((await fetch(server.base + '/api/private')).status, 404);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const outside = [];
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === server.base) return route.continue();
      outside.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    const rendered = await context.newPage();
    await rendered.goto(server.base + '/');
    await rendered.locator('#result').getByText('Public item').waitFor();
    assert.deepEqual(outside, []);
    await context.close();
  } finally {
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
