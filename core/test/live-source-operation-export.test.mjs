import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function runExport(host, out, dataDir, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT, host, '--compare-source', '--offline', '--strict',
      '--root', 'mirror', '--out', out, ...flags], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-20_000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-20_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

test('strict export compares source operations, redacts private data and preserves accepted bundle on source failure', { timeout: 120_000 }, async t => {
  let sourceMode = 'ok';
  const source = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    if (path === '/api/items.json') {
      response.setHeader('content-type', 'application/json');
      return response.end('{"ok":true}');
    }
    if (path === '/theme.css' || path === '/theme-v2.css') {
      response.setHeader('content-type', 'text/css');
      return response.end('body { color: #333; }');
    }
    response.setHeader('content-type', 'text/html');
    const action = sourceMode !== 'broken'
      ? `fetch('${sourceMode === 'diverged' ? '/api/items.json?access_token=source-only-secret' : '/api/items.json'}').then(r => r.json())
          .then(() => { document.querySelector('#result').hidden = false; });`
      : `throw Error('source-only-error-secret');`;
    return response.end(`<!doctype html><link rel="stylesheet" href="${sourceMode === 'asset-drift' ? '/theme-v2.css' : '/theme.css'}"><input id="query"><button id="load" type="button">Load</button>
      <p id="result" hidden>Loaded</p><script>document.querySelector('#load').onclick = () => { ${action} };</script>`);
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

  const dir = mkdtempSync(join(tmpdir(), 'heimdall-source-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${source.address().port}`;
  const host = 'source-fixture.test';
  const site = join(dir, 'workspace', host);
  const out = join(dir, 'deliverable', 'accepted');
  put(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  put(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: origin + '/' }));
  put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  put(join(site, 'live', 'index.html'), `<!doctype html><link rel="stylesheet" href="/theme.css"><input id="query"><button id="load" type="button">Load</button>
    <p id="result" hidden>Loaded</p><script>
    document.querySelector('#load').onclick = () => fetch('/api/items.json').then(r => r.json())
      .then(() => { document.querySelector('#result').hidden = false; });
    </script>`);
  put(join(site, 'live', 'api', 'items.json'), '{"ok":true}');
  put(join(site, 'live', 'theme.css'), 'body { color: #333; }');
  put(join(site, 'session.admin.json'), JSON.stringify({
    cookies: [{ name: 'auth', value: 'admin-session-secret', domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
  put(join(site, 'operation-plan.json'), JSON.stringify({
    version: 1, flows: [{
      path: '/', sessionName: 'admin', actions: [
        { type: 'fill', selector: '#query', value: 'typed-only-secret' },
        { type: 'click', selector: '#load' },
      ], expect: [{ type: 'visible', selector: '#result' }],
    }],
  }));

  const success = await runExport(host, out, dir);
  assert.equal(success.status, 0, success.stderr + success.stdout);
  const goodHealth = readFileSync(join(out, 'health.json'));
  const good = JSON.parse(goodHealth);
  assert.equal(good.operationProbe.checked, 1);
  assert.equal(good.operationProbe.failed, 0);
  assert.equal(good.sourceOperationProbe.status, 'checked');
  assert.equal(good.sourceOperationProbe.checked, 1);
  assert.equal(good.sourceOperationProbe.failed, 0);
  assert.equal(good.sourceOperationProbe.flows[0].passed, true);
  assert.equal(good.sourceOperationProbe.flows[0].sessionName, 'admin');
  assert.equal(good.sourceOperationProbe.flows[0].sessionUsed, true);
  assert.equal(good.sourceOperationProbe.flows[0].sourceDynamicData, 1);
  assert.equal(good.sourceOperationProbe.flows[0].bundleDynamicData, 1);
  assert.equal(good.dependencyParity.status, 'checked');
  assert.equal(good.dependencyParity.mismatchedFlows, 0);
  assert.equal(good.dependencyParity.flows[0].classes.api.source, 1);
  assert.equal(good.dependencyParity.flows[0].classes.stylesheet.source, 1);
  assert.equal(good.strictBlockers.sourceOperationFailed, 0);
  assert.equal(good.strictBlockers.sourceOperationUntested, 0);
  assert.equal(existsSync(join(out, 'operation-plan.json')), false);
  assert.doesNotMatch(goodHealth.toString(), /typed-only-secret|source-only-secret|admin-session-secret|access_token|#query|#load|#result/);

  const failedCandidate = async () => {
    const before = new Set(readdirSync(join(dir, 'deliverable')));
    const run = await runExport(host, out, dir);
    assert.equal(run.status, 1, run.stderr + run.stdout);
    assert.deepEqual(readFileSync(join(out, 'health.json')), goodHealth);
    const candidate = readdirSync(join(dir, 'deliverable'))
      .find(name => name.startsWith('.candidate-') && !before.has(name));
    assert.ok(candidate, 'failed candidate retained for diagnosis');
    return JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
  };

  sourceMode = 'broken';
  const broken = await failedCandidate();
  assert.equal(broken.operationProbe.failed, 0, 'the offline bundle still passes');
  assert.equal(broken.sourceOperationProbe.status, 'checked');
  assert.equal(broken.sourceOperationProbe.failed, 1);
  assert.equal(broken.strictBlockers.sourceOperationFailed, 1);
  assert.ok(broken.sourceOperationProbe.flows[0].issueKinds.includes('pageError'));
  assert.doesNotMatch(JSON.stringify(broken), /source-only-error-secret|typed-only-secret|#query|#load|#result/);

  sourceMode = 'diverged';
  const diverged = await failedCandidate();
  assert.equal(diverged.operationProbe.failed, 0, 'the offline assertion still passes');
  assert.equal(diverged.sourceOperationProbe.failed, 0, 'the source assertion still passes');
  assert.equal(diverged.dependencyParity.mismatchedFlows, 1);
  assert.equal(diverged.dependencyParity.missing, 1);
  assert.equal(diverged.dependencyParity.unexpected, 1);
  assert.equal(diverged.strictBlockers.dependencyParityMismatch, 1);
  assert.doesNotMatch(JSON.stringify(diverged), /access_token|source-only-secret|typed-only-secret|#query|#load|#result/);

  sourceMode = 'asset-drift';
  const assetDrift = await failedCandidate();
  assert.equal(assetDrift.operationProbe.failed, 0);
  assert.equal(assetDrift.sourceOperationProbe.failed, 0);
  assert.equal(assetDrift.dependencyParity.flows[0].classes.stylesheet.missing, 1);
  assert.equal(assetDrift.dependencyParity.flows[0].classes.stylesheet.unexpected, 1);
  assert.equal(assetDrift.strictBlockers.dependencyParityMismatch, 1);

  source.close();
  source.closeAllConnections?.();
  await once(source, 'close');
  const unavailable = await failedCandidate();
  assert.equal(unavailable.sourceOperationProbe.failed, 1);
  assert.equal(unavailable.strictBlockers.sourceOperationFailed, 1);
  assert.equal(unavailable.operationProbe.failed, 0);
  assert.doesNotMatch(JSON.stringify(unavailable), /typed-only-secret|#query|#load|#result/);
});

test('strict export accepts captured CDN script only when materialized in the candidate', { timeout: 120_000 }, async t => {
  const script = 'document.querySelector("#load").onclick = () => { document.querySelector("#result").hidden = false; };';
  const cdn = createServer((request, response) => {
    response.setHeader('content-type', 'text/javascript');
    response.end(script);
  });
  cdn.listen(0, '127.0.0.1');
  await once(cdn, 'listening');
  const cdnOrigin = `http://127.0.0.1:${cdn.address().port}`;
  const page = `<!doctype html><html><head><script defer src="${cdnOrigin}/app.js"></script></head>
    <body><button id="load">Load</button><p id="result" hidden>Loaded</p></body></html>`;
  const source = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(page);
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  for (const server of [source, cdn]) {
    t.after(async () => {
      if (server.listening) {
        server.close();
        server.closeAllConnections?.();
        await once(server, 'close');
      }
    });
  }

  const dir = mkdtempSync(join(tmpdir(), 'heimdall-source-cdn-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${source.address().port}`;
  const host = 'source-cdn-fixture.test';
  const site = join(dir, 'workspace', host);
  const out = join(dir, 'deliverable', 'accepted');
  const harFile = join(site, 'pages', 'home', 'network.har');
  const harEntry = url => ({
    request: { method: 'GET', url, headers: [], cookies: [] },
    response: { status: 200, headers: [{ name: 'content-type', value: 'text/javascript' }],
      content: { mimeType: 'text/javascript', text: script } },
  });
  put(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  put(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: origin + '/' }));
  put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  put(join(site, 'live', 'index.html'), page);
  put(harFile, JSON.stringify({ log: { entries: [harEntry(cdnOrigin + '/app.js')] } }));
  put(join(site, 'operation-plan.json'), JSON.stringify({
    version: 1, flows: [{ path: '/', actions: [{ type: 'click', selector: '#load' }],
      expect: [{ type: 'visible', selector: '#result' }] }],
  }));

  const success = await runExport(host, out, dir, ['--materialize-har']);
  assert.equal(success.status, 0, success.stderr + success.stdout);
  const acceptedHealth = readFileSync(join(out, 'health.json'));
  const health = JSON.parse(acceptedHealth);
  assert.equal(health.dependencyParity.mismatchedFlows, 0);
  assert.equal(health.dependencyParity.sourceExternal, 1);
  assert.equal(health.dependencyParity.localizedExternal, 1);
  assert.equal(health.dependencyParity.unmappedExternal, 0);
  assert.equal(health.operationProbe.failed, 0);
  assert.equal(health.sourceOperationProbe.failed, 0);
  assert.doesNotMatch(acceptedHealth.toString(), /127\.0\.0\.1:\d+\/app\.js/);

  put(harFile, JSON.stringify({ log: { entries: [harEntry(cdnOrigin + '/unrelated.js')] } }));
  const failed = await runExport(host, out, dir, ['--materialize-har']);
  assert.equal(failed.status, 1, failed.stderr + failed.stdout);
  assert.deepEqual(readFileSync(join(out, 'health.json')), acceptedHealth);
});
