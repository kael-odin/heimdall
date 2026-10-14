import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'clicked-data.invalid';
const DATA_PATH = '/api/items?page=1';

function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function runExport(dataDir, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT, HOST, '--compare-source', '--include-readonly-data',
      '--offline', '--strict', '--root', 'mirror', '--out', out], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-20_000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-20_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, output }); });
  });
}

function candidate(dataDir, before) {
  const root = join(dataDir, 'deliverable');
  const name = readdirSync(root).find(item => item.startsWith('.candidate-') && !before.has(item));
  assert.ok(name, 'a rejected export keeps its candidate for diagnosis');
  return join(root, name);
}

function startBundle(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs', '--port', '0', '--host', '127.0.0.1'], {
      cwd: dir, env: { ...process.env, HEIMDALL_DATA_DIR: join(dir, 'absent-source') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const timer = setTimeout(() => fail(new Error('bundle startup timed out')), 10_000);
    function fail(error) { clearTimeout(timer); child.kill(); reject(error); }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`bundle exited (${code})`)));
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      resolve({ child, base: `http://127.0.0.1:${message.port}` });
    });
  });
}

test('source-only clicked GET is captured once, guarded, and replayed after relocation', { timeout: 180_000 }, async t => {
  let mode = 'public';
  let dataRequests = 0;
  const source = createServer((request, response) => {
    if (request.url === DATA_PATH) {
      dataRequests++;
      response.setHeader('content-type', 'application/json');
      return response.end('{"items":["Public item"]}');
    }
    response.setHeader('content-type', 'text/html');
    const action = mode === 'missing'
      ? `result.textContent = 'No request'; result.hidden = false;`
      : `fetch('${DATA_PATH}'${mode === 'authenticated' ? ", { headers: { Authorization: 'Bearer private-source-token' } }" : ''})
          .then(response => response.json()).then(data => {
            result.textContent = data.items[0]; result.hidden = false;
          });`;
    response.end(`<!doctype html><button id="load" type="button">Load</button>
      <output id="result" hidden></output><script>
      document.querySelector('#load').onclick = () => { const result = document.querySelector('#result'); ${action} };
      </script>`);
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  t.after(async () => {
    if (source.listening) {
      source.close();
      source.closeAllConnections?.();
      await once(source, 'close');
    }
  });

  const root = mkdtempSync(join(tmpdir(), 'heimdall-clicked-get-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'source');
  const site = join(dataDir, 'workspace', HOST);
  const out = join(dataDir, 'deliverable', 'accepted');
  const deployed = join(root, 'deployed');
  const origin = `http://127.0.0.1:${source.address().port}`;
  put(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  put(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: origin + '/' }));
  put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><h1>Clone</h1>');
  const liveHtml = `<!doctype html><button id="load" type="button">Load</button>
    <output id="result" hidden></output><script>
    document.querySelector('#load').onclick = () => fetch('${DATA_PATH}')
      .then(response => response.json()).then(data => {
        const result = document.querySelector('#result');
        result.textContent = data.items[0]; result.hidden = false;
      });</script>`;
  put(join(site, 'live', 'index.html'), liveHtml);
  put(join(site, 'operation-plan.json'), JSON.stringify({ version: 1, flows: [{
    path: '/', actions: [{ type: 'click', selector: '#load' }],
    expect: [{ type: 'visible', selector: '#result' }],
  }] }));
  put(join(site, 'read-data-plan.json'), JSON.stringify({ version: 1, paths: [DATA_PATH] }));

  const good = await runExport(dataDir, out);
  assert.equal(good.status, 0, good.output);
  assert.equal(dataRequests, 1, 'the source operation executes once');
  const acceptedHealth = readFileSync(join(out, 'health.json'));
  const health = JSON.parse(acceptedHealth);
  assert.equal(health.readOnlyData.included, 1);
  assert.equal(health.readOnlyData.missing, 0);
  assert.equal(health.readOnlyData.sourceCapture.accepted, 1);
  assert.equal(health.readOnlyData.sourceCurrentAccepted, 1);
  assert.equal(health.readOnlyData.sourceCurrentMissing, 0);
  assert.equal(health.readOnlyData.offlineRequested, 1);
  assert.equal(health.readOnlyData.offlineMissing, 0);
  assert.equal(health.operationProbe.failed, 0);
  assert.equal(health.sourceOperationProbe.failed, 0);
  assert.doesNotMatch(acceptedHealth.toString(), /api\/items\?page=1/,
    'the health report contains counts, not the allowlisted query URL');
  const acceptedHar = readFileSync(join(out, 'har.json'));
  const entry = JSON.parse(acceptedHar).entries.find(item => item.url === origin + DATA_PATH);
  assert.equal(entry.kind, 'public-read-only-data');
  assert.deepEqual(JSON.parse(Buffer.from(entry.body, 'base64').toString()), { items: ['Public item'] });

  const failure = async () => {
    const before = new Set(readdirSync(join(dataDir, 'deliverable')));
    const result = await runExport(dataDir, out);
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);
    assert.deepEqual(readFileSync(join(out, 'har.json')), acceptedHar);
    return candidate(dataDir, before);
  };

  mode = 'authenticated';
  const authCandidate = await failure();
  const authHealth = JSON.parse(readFileSync(join(authCandidate, 'health.json'), 'utf8'));
  assert.ok(authHealth.strictBlockers.sourceReadOnlyCaptureFailed > 0);
  assert.equal(authHealth.strictBlockers.readOnlyDataMissing, 1);
  assert.doesNotMatch(readFileSync(join(authCandidate, 'health.json'), 'utf8'), /private-source-token|Authorization|#load|#result/);
  assert.doesNotMatch(readFileSync(join(authCandidate, 'har.json'), 'utf8'), /private-source-token/);

  mode = 'missing';
  const missingCandidate = await failure();
  const missingHealth = JSON.parse(readFileSync(join(missingCandidate, 'health.json'), 'utf8'));
  assert.equal(missingHealth.strictBlockers.readOnlyDataMissing, 1);
  assert.equal(missingHealth.readOnlyData.sourceCapture.observed, 0);

  put(join(site, 'pages', 'home', 'network.har'), JSON.stringify({ log: { entries: [{
    request: { method: 'GET', url: origin + DATA_PATH, headers: [] },
    response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }],
      content: { mimeType: 'application/json', text: '{"items":["Public item"]}' } },
  }] } }));
  const staleCandidate = await failure();
  const staleHealth = JSON.parse(readFileSync(join(staleCandidate, 'health.json'), 'utf8'));
  assert.equal(staleHealth.strictBlockers.readOnlyDataMissing, 0, 'the old HAR still fills the bundle');
  assert.equal(staleHealth.readOnlyData.sourceCurrentMissing, 1);
  assert.equal(staleHealth.strictBlockers.sourceReadOnlyCurrentMissing, 1);
  assert.doesNotMatch(readFileSync(join(staleCandidate, 'health.json'), 'utf8'), /api\/items\?page=1/);

  mode = 'public';
  put(join(site, 'live', 'index.html'), `<!doctype html><button id="load" type="button">Load</button>
    <output id="result" hidden></output><script>
    document.querySelector('#load').onclick = () => {
      const result = document.querySelector('#result'); result.textContent = 'No request'; result.hidden = false;
    };</script>`);
  const unrequestedCandidate = await failure();
  const unrequestedHealth = JSON.parse(readFileSync(join(unrequestedCandidate, 'health.json'), 'utf8'));
  assert.equal(unrequestedHealth.readOnlyData.sourceCurrentMissing, 0);
  assert.equal(unrequestedHealth.operationProbe.failed, 0, 'the broad DOM assertion still passes');
  assert.equal(unrequestedHealth.readOnlyData.offlineMissing, 1);
  assert.equal(unrequestedHealth.strictBlockers.offlineReadOnlyRequestMissing, 1);
  assert.doesNotMatch(readFileSync(join(unrequestedCandidate, 'health.json'), 'utf8'), /api\/items\?page=1/);
  put(join(site, 'live', 'index.html'), liveHtml);

  put(join(site, 'pages', 'home', 'network.har'), JSON.stringify({ log: { entries: [{
    request: { method: 'GET', url: origin + DATA_PATH, headers: [] },
    response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }],
      content: { mimeType: 'application/json', text: '{"items":["Older item"]}' } },
  }] } }));
  const conflictCandidate = await failure();
  const conflictHealth = JSON.parse(readFileSync(join(conflictCandidate, 'health.json'), 'utf8'));
  assert.ok(conflictHealth.strictBlockers.readOnlyDataConflicts > 0);
  assert.ok(conflictHealth.strictBlockers.sourceReadOnlyCaptureFailed > 0);

  cpSync(out, deployed, { recursive: true });
  rmSync(dataDir, { recursive: true, force: true });
  assert.equal(existsSync(dataDir), false);
  const server = await startBundle(deployed);
  let browser;
  try {
    const replay = await fetch(server.base + DATA_PATH);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-heimdall-replay'), '1');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const outside = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === server.base) return route.continue();
      outside.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.goto(server.base + '/');
    await page.locator('#load').click();
    await page.locator('#result').getByText('Public item').waitFor();
    assert.deepEqual(outside, []);
    await context.close();
  } finally {
    await browser?.close();
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill();
      await new Promise(resolve => server.child.once('exit', resolve));
    }
  }
});
