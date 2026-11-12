import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'bin', 'heimdall.mjs');

function put(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function ready(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('backend scaffold server did not start')), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/HEIMDALL_BACKEND_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('close', resolve));
}

test('backend scaffold generates and starts a B3 service from sanitized contract and adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-scaffold-'));
  const site = join(root, 'workspace', 'example.test');
  const adapter = join(site, 'runtime-adapter');
  let child;
  try {
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      siteId: 'example.test',
      openapi: {
        servers: [{ url: 'https://example.test', 'x-heimdall-provenance': 'observed' }],
        paths: {
          '/api/items': {
            get: {
              'x-heimdall-observations': { samples: 2, queryParams: [], authSchemes: ['bearer'] },
              responses: { 200: { 'x-heimdall-samples': 2, content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
            },
          },
        },
      },
      observations: [{ op: 'GET /api/items', samples: 2, statusCodes: [200], withResponseSchema: true, withRequestSchema: false, authSchemes: ['bearer'], errorSamples: 0 }],
      unknowns: [{ kind: 'auth-unknown', detail: 'super-secret must not be copied' }],
      secret: 'super-secret',
    });
    put(join(adapter, 'manifest.json'), { version: 1, routes: [{ method: 'GET', path: '/api/items' }] });
    put(join(adapter, 'index.mjs'), [
      "export const __heimdallAdapter = { routes: [{ method: 'GET', path: '/api/items', queryParams: [], responseBody: 'observed', writeVerification: 'not_applicable' }] };",
      "export async function handle() { return Response.json({ ok: true }); }",
      '',
    ].join('\n'));

    const generated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'example.test', '--json'], {
      cwd: root,
      env: { ...process.env, HEIMDALL_DATA_DIR: root },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const envelope = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.level, 'B3-scaffold');
    assert.equal(envelope.result.contract.observedRoutes, 1);
    assert.equal(envelope.result.adapter.present, true);

    const out = envelope.result.outDir;
    for (const file of ['package.json', 'server.mjs', 'checks.mjs', 'api-contract.json', 'state-rules.json', 'Dockerfile', 'README.md', 'runtime-adapter/index.mjs', 'runtime-adapter/manifest.json']) {
      assert.equal(existsSync(join(out, file)), true, file);
    }
    const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /\bHOST=0\.0\.0\.0\b/);
    assert.match(dockerfile, /\bHEIMDALL_RUNTIME_DATA_DIR=\/data\b/);
    assert.match(dockerfile, /^VOLUME \["\/data"\]$/m);
    const projected = JSON.parse(readFileSync(join(out, 'api-contract.json'), 'utf8'));
    assert.equal(projected.secret, undefined);
    assert.doesNotMatch(readFileSync(join(out, 'README.md'), 'utf8'), /super-secret/);

    child = spawn(process.execPath, [join(out, 'server.mjs'), '--port', '0'], {
      cwd: out,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = await ready(child);
    const health = await fetch(base + '/__heimdall/health');
    const healthJson = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthJson.level, 'B3-scaffold');
    assert.equal(healthJson.adapter.present, true);
    const response = await fetch(base + '/api/items');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const checks = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(checks.status, 0, checks.stderr + checks.stdout);
    assert.match(checks.stdout, /"overall": "passed"/);
    const checkReport = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(checkReport.schema, 'heimdall.backend-check/1');
    assert.equal(checkReport.overall, 'passed');
    assert.equal(checkReport.results.find(item => item.id === 'adapter-coverage').status, 'passed');
    assert.equal(checkReport.results.find(item => item.id === 'GET /api/items').status, 'implemented');
    assert.equal(checkReport.results.find(item => item.id === 'adapter-gap-ledger').status, 'passed');
    assert.deepEqual(checkReport.repairTasks, []);
    await stop(child);
    const item = projected.openapi.paths['/api/items'];
    projected.openapi.paths['/api/items/{itemId}'] = item;
    projected.openapi.paths['/api/items/42'] = item;
    put(join(site, 'api-contract.json'), projected);
    put(join(adapter, 'manifest.json'), { version: 1, routes: [
      { method: 'GET', path: '/api/items' }, { method: 'GET', path: '/api/items/{itemId}' },
    ] });
    const templated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'example.test', '--out', join(root, 'templated'), '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(templated.status, 0, templated.stderr + templated.stdout);
    const next = JSON.parse(templated.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(next.result.contract.observedRoutes, 3, 'parameterized observed paths must not disappear');
    child = spawn(process.execPath, [join(next.result.outDir, 'server.mjs'), '--port', '0'], {
      cwd: next.result.outDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const nextBase = await ready(child);
    assert.deepEqual((await (await fetch(nextBase + '/__heimdall/health')).json()).missingObservedRoutes, []);
    assert.equal((await fetch(nextBase + '/api/items/42')).status, 200);
    const nextChecks = spawnSync(process.execPath, [join(next.result.outDir, 'checks.mjs'), nextBase], {
      cwd: next.result.outDir, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(nextChecks.status, 1, 'a parameterized check without test data stays incomplete');
    assert.equal(JSON.parse(nextChecks.stdout).results.find(result => result.id === 'GET /api/items/{itemId}').status, 'skipped');
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend scaffold does not copy a missing runtime adapter into Docker', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-scaffold-no-adapter-'));
  const site = join(root, 'workspace', 'example-no-adapter.test');
  try {
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      siteId: 'example-no-adapter.test',
      openapi: {
        paths: {
          '/api/items': {
            get: {
              responses: { 200: {} },
            },
          },
        },
      },
    });

    const generated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'example-no-adapter.test', '--json'], {
      cwd: root,
      env: { ...process.env, HEIMDALL_DATA_DIR: root },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const envelope = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.adapter.present, false);

    const out = envelope.result.outDir;
    const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8');
    assert.doesNotMatch(dockerfile, /^COPY runtime-adapter /m);
    assert.equal(existsSync(join(out, 'runtime-adapter')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend scaffold validates literal names, numeric and composite response schemas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-json-schema-'));
  const site = join(root, 'workspace', 'schema.test');
  const fields = { unitPrice: { type: 'number' }, '显示名称': { type: 'string' }, 'display name': { type: 'string' }, '': { type: 'boolean' } };
  const healthy = { unitPrice: 12.5, '显示名称': 'Product', 'display name': 'Product', '': true };
  Object.assign(fields, {
    nullable: { type: ['object', 'null'], required: ['count'], properties: { count: { type: 'number' } } },
    variant: { oneOf: [{ type: 'number' }, { type: 'string' }] },
    exclusive: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
    combined: { allOf: [{ type: 'object' }, { required: ['count'], properties: { count: { type: 'number' } } }] },
    either: { anyOf: [false, { type: 'boolean' }] },
    empty: {},
    list: { type: 'array', items: false },
  });
  Object.assign(healthy, { nullable: null, variant: 'free', exclusive: 1.5, combined: { count: 2.5 }, either: true, empty: null, list: [] });
  Object.defineProperty(fields, '__proto__', { value: { type: 'boolean' }, enumerable: true });
  Object.defineProperty(healthy, '__proto__', { value: true, enumerable: true });
  let child;
  try {
    put(join(site, 'api-contract.json'), { openapi: { paths: { '/api/product': { get: {
      responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: fields, required: Object.keys(fields) } } } } },
    } } } } });
    put(join(site, 'runtime-adapter', 'manifest.json'), { version: 1, routes: [{ method: 'GET', path: '/api/product' }] });
    put(join(site, 'runtime-adapter', 'index.mjs'), [
      "import { readFileSync } from 'node:fs';",
      "export async function handle() { return Response.json(JSON.parse(readFileSync(new URL('../response.json', import.meta.url), 'utf8'))); }",
    ].join('\n'));
    const generated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'schema.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const out = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1)).result.outDir;
    const projected = JSON.parse(readFileSync(join(out, 'api-contract.json'), 'utf8'));
    assert.deepEqual(projected.openapi.paths['/api/product'].get.responses[200].content['application/json'].schema.required, Object.keys(fields));
    put(join(out, 'response.json'), healthy);
    child = spawn(process.execPath, [join(out, 'server.mjs'), '--port', '0'], { cwd: out, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await ready(child);
    const check = value => {
      put(join(out, 'response.json'), value);
      const run = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], { cwd: out, encoding: 'utf8', timeout: 30_000 });
      assert.equal(run.error, undefined);
      return JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    };
    assert.equal(check(healthy).overall, 'passed');
    assert.equal(check({ ...healthy, unitPrice: 12 }).overall, 'passed', 'JSON number includes integers');
    for (const nullable of [null, { count: 1 }, { count: 2.5 }]) assert.equal(check({ ...healthy, nullable }).overall, 'passed');
    assert.equal(check({ ...healthy, variant: 1 }).overall, 'passed');
    for (const patch of [{ nullable: {} }, { nullable: { count: '1' } }, { variant: true }, { exclusive: 1 },
      { combined: { count: '1' } }, { either: 1 }, { list: [1] }, JSON.parse('{"__proto__":"wrong"}')]) {
      assert.equal(check({ ...healthy, ...patch }).overall, 'failed', JSON.stringify(patch));
    }
    for (const value of ['12.5', true, {}, []]) {
      const result = check({ ...healthy, unitPrice: value });
      assert.equal(result.overall, 'failed', JSON.stringify(value));
      assert.equal(result.results.find(item => item.id === 'GET /api/product').schemaError.path, '$.unitPrice');
      assert.equal(result.repairTasks[0].kind, 'response-contract');
    }
    for (const name of Object.keys(fields)) {
      const broken = { ...healthy };
      delete broken[name];
      assert.equal(check(broken).overall, 'failed', 'required: ' + name);
    }
    assert.equal(check(healthy).overall, 'passed', 'restored response must pass');
    const source = JSON.parse(readFileSync(join(site, 'api-contract.json'), 'utf8'));
    let deep = { type: 'string' };
    for (let i = 0; i < 9; i++) deep = { type: 'array', items: deep };
    for (const invalid of [{ type: [] }, { oneOf: Array(21).fill({ type: 'string' }) }, { anyOf: [null] }, deep]) {
      source.openapi.paths['/api/product'].get.responses[200].content['application/json'].schema = invalid;
      put(join(site, 'api-contract.json'), source);
      const refused = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'schema.test', '--out', join(root, 'refused'), '--json'], {
        cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(JSON.parse(refused.stdout.trim().split(/\r?\n/).at(-1)).error.code, 'invalid_args');
    }
    source.openapi.paths['/api/product'].get.responses[200].content['application/json'].schema = false;
    put(join(site, 'api-contract.json'), source);
    const falseRoot = join(root, 'false-schema');
    const generatedFalse = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'schema.test', '--out', falseRoot, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(generatedFalse.status, 0, generatedFalse.stderr + generatedFalse.stdout);
    const checkedFalse = spawnSync(process.execPath, [join(falseRoot, 'checks.mjs'), base], { cwd: falseRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(checkedFalse.status, 1, checkedFalse.stderr + checkedFalse.stdout);
    const falseReport = JSON.parse(readFileSync(join(falseRoot, 'backend-check.json'), 'utf8'));
    assert.equal(falseReport.results.find(item => item.id === 'GET /api/product').schemaError.expected, 'false schema');
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend scaffold check catches observed response mismatches and runtime gaps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-scaffold-check-failure-'));
  const site = join(root, 'workspace', 'example-check.test');
  const adapter = join(site, 'runtime-adapter');
  let child;
  try {
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      siteId: 'example-check.test',
      openapi: {
        paths: {
          '/api/items': {
            get: {
              responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } } } } },
            },
          },
        },
      },
    });
    put(join(adapter, 'manifest.json'), { version: 1, routes: [{ method: 'GET', path: '/api/items' }] });
    put(join(adapter, 'index.mjs'), [
      "export const __heimdallAdapter = { routes: [{ method: 'GET', path: '/api/items', queryParams: [], responseBody: 'observed', writeVerification: 'not_applicable' }] };",
      "export async function handle(request, context = {}) { const url = new URL(request.url); if (url.pathname !== '/api/items') { await context.recordGap?.({ method: request.method, path: url.pathname, queryParams: ['token'], category: 'unobserved-path' }); return Response.json({ error: 'unobserved-route' }, { status: 404 }); } return new Response(JSON.stringify({ ok: 'wrong-type' }), { status: 200, headers: { 'content-type': 'text/plain' } }); }",
      '',
    ].join('\n'));

    const generated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'example-check.test', '--json'], {
      cwd: root,
      env: { ...process.env, HEIMDALL_DATA_DIR: root },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const envelope = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1));
    const out = envelope.result.outDir;
    child = spawn(process.execPath, [join(out, 'server.mjs'), '--port', '0'], {
      cwd: out,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = await ready(child);
    await fetch(base + '/api/missing?token=private-value');

    const checks = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(checks.status, 1);
    const report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.overall, 'failed');
    assert.equal(report.results.find(item => item.id === 'GET /api/items').status, 'failed');
    assert.match(report.results.find(item => item.id === 'GET /api/items').reason, /MIME/, JSON.stringify(report));
    assert.equal(report.results.find(item => item.id === 'adapter-gap-ledger').uniqueGaps, 1);
    assert.equal(report.results.find(item => item.id === 'GET /api/items').repairTask.kind, 'response-contract');
    assert.equal(report.results.find(item => item.id === 'GET /api/items').repairTask.target, 'GET /api/items');
    assert.equal(report.results.find(item => item.id === 'adapter-gap-ledger').repairTask.kind, 'runtime-gap');
    assert.equal(report.repairTasks.length, 2);
    assert.doesNotMatch(readFileSync(join(out, 'backend-check.json'), 'utf8'), /private-value/);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});
