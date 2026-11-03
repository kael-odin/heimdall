import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));
const CORE = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(fn, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('timed out waiting for ' + label);
}

test('cancelling a whole-site clone cancels its active page forge tasks', { timeout: 40_000 }, async () => {
  const fixture = createServer((req, res) => {
    if (req.url !== '/slow') {
      res.writeHead(404).end('missing');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('<html><body><h1>slow</h1>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-clone-cancel-'));
  const site = join(dir, 'workspace', 'fixture.test');
  mkdirSync(join(site, 'recon'), { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }) + '\n');
  writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({
    origin,
    nodes: [{ id: 'slow', url: origin + '/slow', type: 'page' }],
    edges: [],
  }) + '\n');
  const port = await freePort();
  const engine = spawn(process.execPath, [ENGINE, String(port)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dir, HEIMDALL_TOKEN: 'cancel-token', HEIMDALL_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, {
      ...options,
      headers: { 'x-heimdall-token': 'cancel-token', 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
    return { response, body: await response.json() };
  };
  try {
    await waitFor(async () => {
      try { return (await fetch(base + '/api/status', { headers: { 'x-heimdall-token': 'cancel-token' } })).ok; }
      catch { return false; }
    }, 'engine');
    const started = await request('/api/clone-site', { method: 'POST', body: JSON.stringify({ host: 'fixture.test', max: 1 }) });
    assert.equal(started.response.status, 200, JSON.stringify(started.body));
    const active = await waitFor(async () => {
      const jobs = (await request('/api/jobs')).body.jobs ?? [];
      const forge = jobs.find(job => job.kind === 'forge' && job.status === 'running');
      const clone = jobs.find(job => job.kind === 'clone' && job.status === 'running');
      return forge && clone ? { forge, clone } : null;
    }, 'running clone and forge');
    const cancelled = await request('/api/jobs/' + encodeURIComponent(active.clone.id) + '/cancel', { method: 'POST', body: '{}' });
    assert.equal(cancelled.response.status, 200);
    assert.ok(cancelled.body.cancelledTaskIds.includes(active.forge.id), JSON.stringify(cancelled.body));
    await waitFor(async () => {
      const jobs = (await request('/api/jobs')).body.jobs ?? [];
      return jobs.some(job => job.id === active.forge.id && job.status === 'cancelled');
    }, 'forge cancellation');
  } finally {
    engine.kill();
    await new Promise(resolve => engine.once('exit', resolve));
    fixture.closeAllConnections?.();
    await new Promise(resolve => fixture.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
