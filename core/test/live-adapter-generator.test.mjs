import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildObservedReplayAdapter } from '../src/live/adapter-generator.mjs';
import { scrubPublicJsonValue } from '../src/live/har.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'bin', 'heimdall.mjs');

const jsonEntry = (method, url, status, value) => ({
  method, url, status, mimeType: 'application/json',
  body: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), bodyEncoding: 'base64',
});

test('live/adapter-generator: preserves large numeric tokens through privacy filtering and replay', async () => {
  const raw = '{"id":9007199254740993,"nested":[-9223372036854775808,9007199254740993.0,9.007199254740993e15,1e400],"text":"9007199254740993","email":"private@example.com","rawJSON":"ordinary data"}';
  const entry = { ...jsonEntry('GET', 'https://x.test/api/items', 200, {}), body: Buffer.from(raw).toString('base64') };
  const adapter = buildObservedReplayAdapter([entry], { origin: 'https://x.test' });
  const root = mkdtempSync(join(tmpdir(), 'heimdall-numeric-replay-'));
  try {
    writeFileSync(join(root, 'index.mjs'), adapter.moduleSource);
    const module = await import(pathToFileURL(join(root, 'index.mjs')).href);
    const response = await module.handle(new Request('http://adapter.local/api/items'));
    assert.equal(await response.text(), raw.replace(',"email":"private@example.com"', ''));
    assert.doesNotMatch(adapter.moduleSource, /private@example\.com/);
    assert.equal(adapter.report.redactedBodies, 1);
    assert.doesNotMatch(JSON.stringify(scrubPublicJsonValue(JSON.rawJSON('"Bearer abcdefghijkl"'))), /abcdefghijkl/);
    assert.deepEqual(scrubPublicJsonValue({ rawJSON: 'ordinary data' }), { rawJSON: 'ordinary data' });
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const gaps = [];
    assert.equal((await module.handle(new Request('http://adapter.local/api/items?page=2&token=secret-value'), {
      recordGap: gap => gaps.push(gap), method: 'GET',
    })).status, 404);
    assert.deepEqual(gaps[0], {
      method: 'GET', path: '/api/items', queryParams: ['page', 'token'], category: 'uncovered-query-parameter',
      knownQueryParams: ['page'],
    });
    assert.doesNotMatch(JSON.stringify(gaps), /secret-value/);
    assert.doesNotMatch(readFileSync(join(root, 'index.mjs'), 'utf8'), /private@example\.com|secret-value|user_id/);
    assert.equal(adapter.report.tier, 'B1-replay');
    assert.equal(adapter.report.routes, 2);
    assert.equal(adapter.report.redactedBodies, 2);
    assert.equal(adapter.report.gapLedger.summary.unverifiedWrites, 1);
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
    assert.equal(existsSync(join(root, 'adapter-report.json')), true);
    assert.equal(JSON.parse(readFileSync(join(root, 'adapter-report.json'), 'utf8')).results.status, 'not-validated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('API probes use explicit public GET approvals without widening default or authenticated capture', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-probe-approved-'));
  const site = join(root, 'workspace', 'x.test');
  const page = join(site, 'pages', 'home');
  const paths = [1, 2, 3, 4, 5].map(page => `/api/items?page=${page}`);
  const planFile = join(site, 'read-data-plan.json');
  const run = (command, approved = true) => {
    const result = spawnSync(process.execPath, [BIN, 'probe', command, '--site', 'x.test', '--json',
      ...(command === 'adapter' ? ['--include-api-bodies', '--out', join(root, 'adapter-output', 'adapter')] : []),
      ...(approved ? ['--include-readonly-data'] : [])], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, ...JSON.parse(result.stdout.trim()) };
  };
  try {
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://x.test/' }));
    const entries = [...paths, '/api/items?page=6', '/api/items?page=99'].map(path => ({
      request: { method: 'GET', url: 'https://x.test' + path,
        headers: path.endsWith('=6') ? [{ name: 'Authorization', value: 'Bearer private-secret' }] : [] },
      response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ items: [path.endsWith('=6') ? 'session-only' : 'public-item'] }) } },
    }));
    entries.push({ ...entries[0], request: { method: 'GET', url: 'https://other.test' + paths[0] } });
    writeFileSync(join(page, 'network.har'), JSON.stringify({ log: { entries: entries.slice(0, 4) } }));
    const next = join(site, 'pages', 'next');
    mkdirSync(next);
    writeFileSync(join(next, 'manifest.json'), JSON.stringify({ target: 'https://x.test/next' }));
    writeFileSync(join(next, 'network.har'), JSON.stringify({ log: { entries: entries.slice(4) } }));
    for (const command of ['contract', 'adapter']) {
      const missing = run(command);
      assert.equal(missing.status, 2);
      assert.equal(missing.error.code, 'invalid_args');
      assert.match(missing.error.hint, /read-data-plan.json/);
    }
    writeFileSync(planFile, JSON.stringify({ version: 1, paths: [...paths, '/api/items?page=6'] }));
    assert.equal(run('contract', false).result.rows[0].tier, 'B0');
    assert.equal(run('adapter', false).status, 2);
    const contract = run('contract');
    assert.equal(contract.status, 0);
    assert.equal(contract.result.rows[0].tier, 'B1');
    assert.equal(contract.result.rows[0].observations[0].samples, 5);
    assert.doesNotMatch(JSON.stringify(contract), /session-only|private-secret|public-item/);
    const adapter = run('adapter');
    assert.equal(adapter.status, 0);
    assert.equal(adapter.result.observedEntries, 5);
    assert.equal(adapter.result.trainEntries, 4);
    assert.equal(adapter.result.heldoutEntries, 1);
    assert.equal(adapter.result.validation.status, 'failed');
    assert.match(adapter.summary, /留出验证 failed/);
    const outputFile = join(root, 'adapter-output', 'adapter', 'index.mjs');
    const output = readFileSync(outputFile, 'utf8');
    assert.doesNotMatch(output, /session-only|private-secret|page=99|other.test/);
    for (const invalid of [{ version: 0, paths }, { version: 1, paths: ['//other.test/api/items'] }, { version: 1, paths: ['/api/items?token=private-secret'] }]) {
      writeFileSync(planFile, JSON.stringify(invalid));
      for (const command of ['contract', 'adapter']) assert.equal(run(command).error.code, 'invalid_args');
    }
    writeFileSync(planFile, JSON.stringify({ version: 1, paths }));
    const other = join(site, 'pages', 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'manifest.json'), JSON.stringify({ target: 'https://other.test/' }));
    for (const command of ['contract', 'adapter']) assert.equal(run(command).error.code, 'origin_conflict');
    assert.equal(readFileSync(outputFile, 'utf8'), output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
