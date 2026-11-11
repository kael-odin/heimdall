import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildObservedReplayAdapter } from '../src/live/adapter-generator.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'bin', 'heimdall.mjs');

const jsonEntry = (method, url, status, value) => ({
  method, url, status, mimeType: 'application/json',
  body: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), bodyEncoding: 'base64',
});

test('live/adapter-generator: creates a privacy-filtered observed replay module', async () => {
  const adapter = buildObservedReplayAdapter([
    jsonEntry('GET', 'https://x.test/api/items?page=1', 200, { items: [{ name: 'public', email: 'private@example.com', user_id: 7 }] }),
    jsonEntry('POST', 'https://x.test/api/items', 201, { ok: true, token: 'secret-value' }),
    { method: 'GET', url: 'https://x.test/assets/app.js', status: 200, mimeType: 'text/javascript', body: null, bodyEncoding: null },
  ], { siteId: 'x.test', origin: 'https://x.test' });
  const root = mkdtempSync(join(tmpdir(), 'heimdall-observed-adapter-'));
  try {
    writeFileSync(join(root, 'index.mjs'), adapter.moduleSource);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(adapter.manifest));
    const module = await import(pathToFileURL(join(root, 'index.mjs')).href + `?t=${Date.now()}`);
    const get = await module.handle(new Request('http://adapter.local/api/items?page=1'));
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { items: [{ name: 'public' }] });
    const post = await module.handle(new Request('http://adapter.local/api/items', { method: 'POST', body: '{}' }));
    assert.equal(post.status, 201);
    assert.deepEqual(await post.json(), { ok: true });
    assert.equal((await module.handle(new Request('http://adapter.local/api/items?page=2'))).status, 404);
    assert.doesNotMatch(readFileSync(join(root, 'index.mjs'), 'utf8'), /private@example\.com|secret-value|user_id/);
    assert.equal(adapter.report.tier, 'B1-replay');
    assert.equal(adapter.report.routes, 2);
    assert.equal(adapter.report.redactedBodies, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('probe adapter: writes a deployable two-file adapter from a sanitized workspace HAR', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-probe-adapter-'));
  const page = join(root, 'workspace', 'x.test', 'pages', 'home');
  const out = 'generated-adapter';
  const outDir = join(root, out);
  try {
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://x.test/' }));
    writeFileSync(join(page, 'network.har'), JSON.stringify({ log: { entries: [{
      request: { method: 'GET', url: 'https://x.test/api/items' },
      response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: {
        mimeType: 'application/json', text: Buffer.from(JSON.stringify({ items: [{ name: 'public', email: 'private@example.com' }] })).toString('base64'), encoding: 'base64',
      } },
    }] } }));
    const run = spawnSync(process.execPath, [BIN, 'probe', 'adapter', '--site', 'x.test', '--include-api-bodies', '--out', out], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')).routes, [{ method: 'GET', path: '/api/items' }]);
    assert.doesNotMatch(readFileSync(join(outDir, 'index.mjs'), 'utf8'), /private@example\.com/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
