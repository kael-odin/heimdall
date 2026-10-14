import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for ' + label);
}

test('deliver API binds execution to preview and restores quarantined bundle', { timeout: 30_000 }, async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-deliver-api-'));
  const deliverable = join(dataRoot, 'deliverable');
  for (const name of ['fixture.test-2026-10-01', 'fixture.test-2026-10-02', 'fixture.test-2026-10-03']) {
    const dir = join(deliverable, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), name);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [ENGINE, String(port)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-heimdall-token': 'test-token', 'content-type': 'application/json' };
  const json = async (path, init = {}) => {
    const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
    return { status: response.status, body: await response.json() };
  };
  try {
    await waitFor(async () => {
      try { return (await json('/api/status')).status === 200; } catch { return false; }
    }, 'engine: ' + logs.slice(-300));
    assert.equal((await fetch(base + '/api/deliver/trash')).status, 401);
    const preview = await waitFor(async () => {
      const response = await json('/api/deliver/plan');
      return response.body?.revision && !response.body.scanning ? response.body : null;
    }, 'deliver preview');
    assert.equal(preview.candidates.length, 1);
    assert.match(preview.revision, /^[0-9a-f]{64}$/);

    const post = body => json('/api/deliver/prune', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post({ apply: true, confirm: 'HEIMDALL_DELIVER_PRUNE' })).status, 400);
    assert.equal((await post({ apply: true, confirm: 'HEIMDALL_DELIVER_PRUNE', revision: '0'.repeat(64) })).status, 409);
    const accepted = await post({ apply: true, confirm: 'HEIMDALL_DELIVER_PRUNE', revision: preview.revision });
    assert.equal(accepted.status, 202);
    assert.ok(accepted.body.taskId);
    const quarantined = await waitFor(async () => {
      const response = await json('/api/deliver/trash');
      return response.body.entries?.find(row => row.state === 'ready') ?? null;
    }, 'quarantine result');
    const id = quarantined.id;
    assert.equal(existsSync(join(deliverable, 'fixture.test-2026-10-01')), false);
    const nextPreview = await waitFor(async () => {
      const response = await json('/api/deliver/plan');
      return response.body?.revision && !response.body.scanning && response.body.runId !== preview.runId
        ? response.body : null;
    }, 'fresh preview after quarantine');
    assert.equal(nextPreview.candidates.length, 0);
    const listed = await json('/api/deliver/trash');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.entries.find(row => row.id === id)?.state, 'ready');
    const restored = await json(`/api/deliver/trash/${id}/restore`, { method: 'POST', body: '{}' });
    assert.equal(restored.status, 200);
    assert.equal(readFileSync(join(deliverable, restored.body.name, 'index.html'), 'utf8'), restored.body.name);
    assert.equal((await json('/api/deliver/trash')).body.entries.find(row => row.id === id)?.state, 'restored');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
});
