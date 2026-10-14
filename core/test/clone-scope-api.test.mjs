import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCloneScope } from '../src/clone-scope.mjs';
import { createPageNameResolver } from '../src/url-canon.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('clone scope separates the default page limit, excluded types and actual queue', () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-clone-scope-'));
  const site = join(root, 'workspace', 'x.test');
  mkdirSync(join(site, 'recon'), { recursive: true });
  try {
    assert.equal(readCloneScope(join(root, 'workspace', 'missing.test')).status, 'missing');
    const nodes = [
      ...Array.from({ length: 22 }, (_, index) => ({ url: `https://x.test/page-${index + 1}`, type: 'generic' })),
      { url: 'https://x.test/login', type: 'auth' },
      { url: 'https://x.test/terms', type: 'legal' },
      { url: 'https://x.test/page-1#fragment', type: 'generic' },
      { url: 'https://foreign.test/page', type: 'generic' },
      { url: 'not-a-url', type: 'generic' },
    ];
    writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({
      origin: 'https://x.test', nodes, meta: { maxPages: 24, maxDepth: 2 }, failures: [{}],
    }));
    writeFileSync(join(site, 'queue.json'), JSON.stringify([
      { url: 'https://x.test/page-1', status: 'done' },
      { url: 'https://x.test/login', status: 'pending' },
      { url: 'https://x.test/extra', status: 'pending' },
    ]));
    assert.deepEqual(readCloneScope(site), {
      status: 'ok', discovered: 24, eligible: 20, excludedByDefault: 4,
      excludedByType: 2, excludedByPageLimit: 2,
      inQueue: 2, notQueued: 22, outsideAtlas: 1, invalidNodes: 1, foreignNodes: 1,
      reconFailures: 1, maxPages: 24, maxDepth: 2, limitReached: true,
    });
    writeFileSync(join(site, 'queue.json'), JSON.stringify([{ url: 'https://foreign.test/page', status: 'pending' }]));
    assert.equal(readCloneScope(site).issue, 'foreign-queue-url');
    writeFileSync(join(site, 'queue.json'), '[null]');
    assert.equal(readCloneScope(site).issue, 'invalid-queue-row');
    writeFileSync(join(site, 'queue.json'), JSON.stringify([{ url: 'https://x.test/page-1' }]));
    assert.equal(readCloneScope(site).issue, 'invalid-queue-row');
    writeFileSync(join(site, 'queue.json'), '{bad');
    assert.equal(readCloneScope(site).issue, 'invalid-queue');
    writeFileSync(join(site, 'queue.json'), '[]');
    writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin: 'http://x.test' }));
    assert.equal(readCloneScope(site).issue, 'origin-mismatch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clone-site API accepts all discovered URLs beyond the default cap and rejects ambiguous requests', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-clone-api-'));
  const site = join(root, 'workspace', 'x.test');
  mkdirSync(join(site, 'recon'), { recursive: true });
  const nodes = [
    ...Array.from({ length: 22 }, (_, index) => ({ url: `https://x.test/page-${index + 1}`, type: 'generic' })),
    { url: 'https://x.test/login', type: 'auth' },
    { url: 'https://x.test/terms', type: 'legal' },
  ];
  writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://x.test', nodes }));
  const pageName = createPageNameResolver(site);
  for (const node of nodes) {
    const page = join(site, 'pages', pageName(node.url));
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><title>fixture</title>');
    writeFileSync(join(page, 'score.json'), '{"pixel":1}');
  }

  const port = await freePort();
  const engine = spawn(process.execPath, [ENGINE, String(port)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_TOKEN: 'scope-test', HEIMDALL_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'content-type': 'application/json', 'x-heimdall-token': 'scope-test' };
  const post = body => fetch(base + '/api/clone-site', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(base + '/api/status', { headers })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'engine did not start');

    const scope = (await (await fetch(base + '/api/queue/x.test', { headers })).json()).scope;
    assert.equal(scope.discovered, 24);
    assert.equal(scope.eligible, 20);
    assert.equal(scope.notQueued, 24);
    assert.equal((await post({ host: 'x.test', allDiscovered: true, max: 1 })).status, 400);
    assert.equal((await post({ host: 'x.test', allDiscovered: 'true' })).status, 400);
    const started = await post({ host: 'x.test', allDiscovered: true });
    const startedBody = await started.json();
    assert.equal(started.status, 200, JSON.stringify(startedBody));
    const { taskId } = startedBody;

    const queuePath = join(site, 'queue.json');
    let queue = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(queuePath)) {
        try { queue = JSON.parse(readFileSync(queuePath, 'utf8')); } catch {}
        if (queue?.length === 24) break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(queue?.length, 24, 'API must pass --all-discovered instead of the default --max 20');
    assert.ok(queue.some(row => row.type === 'auth'));
    assert.ok(queue.some(row => row.type === 'legal'));
    const after = (await (await fetch(base + '/api/queue/x.test', { headers })).json()).scope;
    assert.equal(after.inQueue, 24);
    assert.equal(after.notQueued, 0);
    await fetch(base + `/api/jobs/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', headers });
  } finally {
    if (engine.exitCode === null && engine.signalCode === null) {
      engine.kill();
      await new Promise(resolve => engine.once('exit', resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
