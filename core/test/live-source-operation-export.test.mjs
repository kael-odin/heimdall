import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveSnapshotPath } from '../src/live/live-path.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function runExport(host, out, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT, host, '--compare-source', '--offline', '--strict',
      '--root', 'mirror', '--out', out], {
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
    if (path === '/api/items') {
      response.setHeader('content-type', 'application/json');
      return response.end('{"ok":true}');
    }
    response.setHeader('content-type', 'text/html');
    const action = sourceMode === 'ok'
      ? `fetch('/api/items?access_token=source-only-secret').then(r => r.json())
          .then(() => { document.querySelector('#result').hidden = false; });`
      : `throw Error('source-only-error-secret');`;
    return response.end(`<!doctype html><input id="query"><button id="load" type="button">Load</button>
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
  put(join(site, 'live', 'index.html'), `<!doctype html><input id="query"><button id="load" type="button">Load</button>
    <p id="result" hidden>Loaded</p><script>
    document.querySelector('#load').onclick = () => fetch('/api/items?page=1').then(r => r.json())
      .then(() => { document.querySelector('#result').hidden = false; });
    </script>`);
  put(join(site, 'live', liveSnapshotPath('/api/items', '?page=1')), '{"ok":true}');
  put(join(site, 'operation-plan.json'), JSON.stringify({
    version: 1, flows: [{
      path: '/', actions: [
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
  assert.equal(good.sourceOperationProbe.flows[0].sourceDynamicData, 1);
  assert.equal(good.sourceOperationProbe.flows[0].bundleDynamicData, 1);
  assert.equal(good.strictBlockers.sourceOperationFailed, 0);
  assert.equal(good.strictBlockers.sourceOperationUntested, 0);
  assert.equal(existsSync(join(out, 'operation-plan.json')), false);
  assert.doesNotMatch(goodHealth.toString(), /typed-only-secret|source-only-secret|access_token|#query|#load|#result/);

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

  source.close();
  source.closeAllConnections?.();
  await once(source, 'close');
  const unavailable = await failedCandidate();
  assert.equal(unavailable.sourceOperationProbe.failed, 1);
  assert.equal(unavailable.strictBlockers.sourceOperationFailed, 1);
  assert.equal(unavailable.operationProbe.failed, 0);
  assert.doesNotMatch(JSON.stringify(unavailable), /typed-only-secret|#query|#load|#result/);
});
