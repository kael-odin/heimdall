import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));
const HEADERS = { 'x-heimdall-token': 'test-token', 'content-type': 'application/json' };

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startEngine(dataRoot) {
  const port = await freePort();
  const proc = spawn(process.execPath, [ENGINE, String(port)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_TOKEN: 'test-token', HEIMDALL_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/api/status', { headers: HEADERS })).ok) return { proc, base };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  proc.kill();
  throw new Error('engine did not start on isolated port');
}

async function runExport(base) {
  const response = await fetch(base + '/api/live-export', {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ host: 'fixture.test', root: 'mirror' }),
  });
  assert.equal(response.status, 200);
  const { taskId } = await response.json();
  const stream = await fetch(base + `/api/events?task=${encodeURIComponent(taskId)}`, {
    headers: HEADERS, signal: AbortSignal.timeout(30_000),
  });
  assert.equal(stream.status, 200);
  const events = (await stream.text()).split('\n').filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
  return events.findLast(event => event.kind === 'exit');
}

test('console live export enforces offline strict gate and preserves last accepted bundle', { timeout: 90_000 }, async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-live-console-'));
  const site = join(dataRoot, 'workspace', 'fixture.test');
  const livePage = join(site, 'live', 'index.html');
  let engine;
  try {
    mkdirSync(join(site, 'pages', 'home', 'clone'), { recursive: true });
    mkdirSync(join(site, 'live'), { recursive: true });
    writeFileSync(join(site, 'pages', 'home', 'clone', 'index.html'), '<html>clone</html>');
    writeFileSync(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(livePage, '<html><body><a href="/not-captured/">missing</a></body></html>');
    engine = await startEngine(dataRoot);

    const blocked = await runExport(engine.base);
    assert.equal(blocked?.status, 'failed');
    const deliverable = join(dataRoot, 'deliverable');
    const candidate = readdirSync(deliverable).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate, 'strict failure leaves a diagnostic candidate');
    const blockedHealth = JSON.parse(readFileSync(join(deliverable, candidate, 'health.json'), 'utf8'));
    assert.equal(blockedHealth.strict, true);
    assert.ok(blockedHealth.strictBlockers.missingLinks > 0);
    assert.equal((await fetch(engine.base + '/api/live-health/fixture.test', { headers: HEADERS })).status, 404);

    writeFileSync(livePage, '<html><body><h1>Local page</h1></body></html>');
    const accepted = await runExport(engine.base);
    assert.equal(accepted?.status, 'done');
    const healthResponse = await fetch(engine.base + '/api/live-health/fixture.test', { headers: HEADERS });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.strict, true);
    assert.ok(Object.values(health.strictBlockers).every(count => count === 0));
    assert.ok(health.runtimeProbe.checked > 0);
    assert.ok(existsSync(health.bundlePath));
    const acceptedBytes = readFileSync(join(health.bundlePath, 'health.json'));

    writeFileSync(livePage, '<html><body><a href="/not-captured/">missing</a></body></html>');
    assert.equal((await runExport(engine.base))?.status, 'failed');
    assert.deepEqual(readFileSync(join(health.bundlePath, 'health.json')), acceptedBytes,
      'a failed re-export must not replace the previously accepted bundle');
  } finally {
    if (engine?.proc.exitCode === null && engine.proc.signalCode === null) {
      engine.proc.kill();
      await new Promise(resolve => engine.proc.once('exit', resolve));
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
