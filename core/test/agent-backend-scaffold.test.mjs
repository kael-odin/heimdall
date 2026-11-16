import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
      'let calls = 0;',
      "export async function handle() { const headers = new Headers(); headers.set('x-fixture-calls', String(++calls)); headers.append('Set-Cookie', 'sid=fixture-session; Path=/; HttpOnly'); headers.append('Set-Cookie', 'sid.sig=fixture-signature; Path=/; HttpOnly; Expires=Fri, 01 Jan 2100 00:00:00 GMT'); return Response.json({ ok: true }, { headers }); }",
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
    for (const file of ['package.json', 'server.mjs', 'checks.mjs', 'api-contract.json', 'state-rules.json', 'backend-task.json', 'Dockerfile', 'README.md', 'runtime-adapter/index.mjs', 'runtime-adapter/manifest.json']) {
      assert.equal(existsSync(join(out, file)), true, file);
    }
    const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /\bHOST=0\.0\.0\.0\b/);
    assert.match(dockerfile, /\bHEIMDALL_RUNTIME_DATA_DIR=\/data\b/);
    assert.match(dockerfile, /^VOLUME \["\/data"\]$/m);
    const projected = JSON.parse(readFileSync(join(out, 'api-contract.json'), 'utf8'));
    assert.equal(projected.secret, undefined);
    assert.doesNotMatch(readFileSync(join(out, 'README.md'), 'utf8'), /super-secret/);
    const task = JSON.parse(readFileSync(join(out, 'backend-task.json'), 'utf8'));
    assert.equal(task.schema, 'heimdall.backend-ai-task/1');
    assert.equal(task.status, 'ready_for_ai_draft');
    assert.equal(task.observedEndpoints[0].path, '/api/items');
    assert.equal(task.observedEndpoints[0].basis, 'observed');
    assert.equal(task.provenance.invented.length, 0);
    assert.match(task.prompt, /不要从 unknowns 推断/);
    assert.doesNotMatch(readFileSync(join(out, 'backend-task.json'), 'utf8'), /super-secret/);

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
    assert.equal(response.headers.get('x-fixture-calls'), '1');
    assert.deepEqual(response.headers.getSetCookie(), [
      'sid=fixture-session; Path=/; HttpOnly',
      'sid.sig=fixture-signature; Path=/; HttpOnly; Expires=Fri, 01 Jan 2100 00:00:00 GMT',
    ], 'generated backends must preserve individual cookies, including commas in Expires');
    assert.deepEqual(await response.json(), { ok: true });

    const checks = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(checks.status, 1, checks.stderr + checks.stdout);
    assert.match(checks.stdout, /"overall": "incomplete"/);
    const checkReport = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(checkReport.schema, 'heimdall.backend-check/1');
    assert.equal(checkReport.overall, 'incomplete');
    assert.equal(checkReport.results.find(item => item.id === 'adapter-coverage').status, 'passed');
    assert.equal(checkReport.results.find(item => item.id === 'GET /api/items').status, 'skipped');
    assert.deepEqual(checkReport.results.find(item => item.id === 'GET /api/items').authSchemes, ['bearer']);
    assert.equal(checkReport.results.find(item => item.id === 'adapter-gap-ledger').status, 'passed');
    assert.equal(checkReport.repairTasks.length, 1);
    assert.equal(checkReport.repairTasks[0].kind, 'authentication-verification');
    assert.match(checkReport.repairTasks[0].instruction, /不要.*放宽认证/);
    assert.equal((await fetch(base + '/api/items')).headers.get('x-fixture-calls'), '2', 'default checks do not probe observed authentication anonymously');
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
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>fixture</body>');
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
    assert.equal(envelope.result.task.status, 'blocked_on_observation');

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
      "export async function handle(request, context = {}) { const url = new URL(request.url); if (url.pathname !== '/api/items') { await context.recordGap?.({ method: request.method, path: url.pathname, queryParams: ['token'], category: 'unobserved-path' }); return Response.json({ error: 'unobserved-route' }, { status: 404 }); } if (url.search) await context.recordGap?.({ method: request.method, path: url.pathname, queryParams: ['page'], category: 'unobserved-query-variant' }); return new Response(JSON.stringify({ ok: 'wrong-type' }), { status: 200, headers: { 'content-type': 'text/plain' } }); }",
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
    await fetch(base + '/api/items?page=2');

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
    assert.equal(report.results.find(item => item.id === 'adapter-gap-ledger').uniqueGaps, 2);
    assert.equal(report.results.find(item => item.id === 'adapter-gap-ledger').unobservedQueryVariants, 1);
    assert.equal(report.results.find(item => item.id === 'GET /api/items').repairTask.kind, 'response-contract');
    assert.equal(report.results.find(item => item.id === 'GET /api/items').repairTask.target, 'GET /api/items');
    assert.equal(report.results.find(item => item.id === 'adapter-gap-ledger').repairTask.kind, 'query-variant-gap');
    assert.equal(report.repairTasks.length, 2);
    assert.doesNotMatch(readFileSync(join(out, 'backend-check.json'), 'utf8'), /private-value/);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend scaffold executes reviewed business rules without leaking test data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-business-rules-'));
  const site = join(root, 'workspace', 'business-rules.test');
  let child;
  let hangingServer;
  try {
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1', siteId: 'business-rules.test', openapi: { paths: {
        '/api/items': {
          get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } } } } } },
          post: { responses: { 201: { content: { 'application/json': { schema: { type: 'object', required: ['created', 'id'], properties: { created: { type: 'boolean' }, id: { type: 'string' } } } } } } } },
        },
        '/api/items/{id}': {
          get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['found', 'id'], properties: { found: { type: 'boolean' }, id: { type: 'string' } } } } } } } },
        },
        '/api/private': {
          get: { responses: { 200: {}, 401: {}, 403: {} } },
        },
        '/api/login': {
          post: { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } },
        },
        '/api/private-cookie': {
          get: { responses: { 200: {}, 401: {} } },
        },
        '/api/rotate': {
          post: { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } },
        },
        '/api/logout': {
          post: { responses: { 204: {} } },
        },
        '/api/redirect-login': {
          post: { responses: { 302: {} } },
        },
      } },
    });
    put(join(site, 'runtime-adapter', 'manifest.json'), { version: 1, routes: [
      { method: 'GET', path: '/api/items' }, { method: 'POST', path: '/api/items' }, { method: 'GET', path: '/api/items/{id}' }, { method: 'GET', path: '/api/private' },
      { method: 'POST', path: '/api/login' }, { method: 'GET', path: '/api/private-cookie' }, { method: 'POST', path: '/api/rotate' }, { method: 'POST', path: '/api/logout' },
      { method: 'POST', path: '/api/redirect-login' },
    ] });
    put(join(site, 'runtime-adapter', 'index.mjs'), [
      "export const __heimdallAdapter = { routes: [{ method: 'GET', path: '/api/items', queryParams: [], responseBody: 'observed', writeVerification: 'unverified' }, { method: 'POST', path: '/api/items', queryParams: [], responseBody: 'observed', writeVerification: 'unverified' }, { method: 'GET', path: '/api/items/{id}', queryParams: [], responseBody: 'observed', writeVerification: 'unverified' }, { method: 'GET', path: '/api/private', queryParams: [], responseBody: 'observed', writeVerification: 'unverified' }] };",
      "let items = [];",
      "function cookieResponse(value, status, cookie) { const response = Response.json(value, { status }); if (cookie) response.headers.append('Set-Cookie', cookie); return response; }",
      "export async function handle(request) { const url = new URL(request.url); const cookies = request.headers.get('cookie') || ''; if (url.pathname === '/api/login' && request.method === 'POST') return cookieResponse({ loggedIn: true }, 200, 'sid=fixture-session-one; Path=/; HttpOnly'); if (url.pathname === '/api/redirect-login' && request.method === 'POST') { const response = new Response(null, { status: 302, headers: { Location: '/api/private-cookie' } }); response.headers.append('Set-Cookie', 'sid=fixture-session-one; Path=/; HttpOnly'); return response; } if (url.pathname === '/api/private-cookie') return cookies.includes('sid=fixture-session-one') || cookies.includes('sid=fixture-session-two') ? Response.json({ allowed: true }, { headers: { 'X-Content-Type-Options': 'nosniff' } }) : Response.json({ allowed: false, error: 'unauthorized' }, { status: 401 }); if (url.pathname === '/api/rotate' && request.method === 'POST') return cookies.includes('sid=fixture-session-one') ? cookieResponse({ rotated: true }, 200, 'sid=fixture-session-two; Path=/; HttpOnly') : Response.json({ rotated: false, error: 'unauthorized' }, { status: 401 }); if (url.pathname === '/api/logout' && request.method === 'POST') return new Response(null, { status: 204, headers: { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' } }); if (request.method === 'POST') { const body = await request.json(); items.push(body); return Response.json({ created: true, id: body.id }, { status: 201 }); } if (url.pathname === '/api/private') { const auth = request.headers.get('authorization'); if (auth === 'Bearer owner-secret') return Response.json({ allowed: true, actor: 'owner' }); if (auth === 'Bearer guest-secret') return Response.json({ allowed: false, error: 'forbidden' }, { status: 403 }); return Response.json({ allowed: false, error: 'unauthorized' }, { status: 401 }); } if (url.pathname.startsWith('/api/items/')) return Response.json({ found: true, id: decodeURIComponent(url.pathname.split('/').at(-1)) }); return Response.json({ items }); }",
    ].join('\n'));

    const generated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'business-rules.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const out = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1)).result.outDir;
    const rules = {
      schema: 'heimdall.backend-state-rules/1', siteId: 'business-rules.test', status: 'inferred-draft',
      provenance: { invented: [] }, rules: [
        { id: 'read-items', steps: [{ method: 'GET', path: '/api/items', expect: { status: 200, json: [{ pointer: '/items', type: 'array' }] } }] },
        { id: 'create-item', steps: [{ method: 'POST', path: '/api/items', bodyEnv: 'HEIMDALL_TEST_BODY_JSON', expect: { status: 201, json: [{ pointer: '/created', equals: true }, { pointer: '/id', type: 'string' }] } }] },
        { id: 'read-created-item', steps: [
          { method: 'POST', path: '/api/items', bodyEnv: 'HEIMDALL_TEST_BODY_JSON', expect: { status: 201, json: [{ pointer: '/created', equals: true }, { pointer: '/id', type: 'string' }] } },
          { method: 'GET', path: '/api/items/{id}', pathParams: { id: { response: 0, path: ['id'] } }, expect: { status: 200, json: [{ pointer: '/found', equals: true }, { pointer: '/id', equalsFrom: { response: 0, path: ['id'] } }] } },
        ] },
        { id: 'owner-private-read', actor: 'owner', steps: [{ method: 'GET', path: '/api/private', headers: { Authorization: { env: 'HEIMDALL_FIXTURE_OWNER_AUTH' } }, expect: { status: 200, json: [{ pointer: '/allowed', equals: true }, { pointer: '/actor', equals: 'owner' }] } }] },
        { id: 'guest-private-denied', actor: 'guest', steps: [{ method: 'GET', path: '/api/private', headers: { Authorization: { env: 'HEIMDALL_FIXTURE_GUEST_AUTH' } }, expect: { status: 403, json: [{ pointer: '/allowed', equals: false }, { pointer: '/error', equals: 'forbidden' }] } }] },
        { id: 'anonymous-private-denied', actor: 'anonymous', steps: [{ method: 'GET', path: '/api/private', expect: { status: 401, json: [{ pointer: '/allowed', equals: false }, { pointer: '/error', equals: 'unauthorized' }] } }] },
        { id: 'invalid-private-denied', actor: 'invalid-token', steps: [{ method: 'GET', path: '/api/private', headers: { Authorization: { env: 'HEIMDALL_FIXTURE_INVALID_AUTH' } }, expect: { status: 401, json: [{ pointer: '/allowed', equals: false }, { pointer: '/error', equals: 'unauthorized' }] } }] },
        { id: 'cookie-session-lifecycle', actor: 'owner', steps: [
          { method: 'POST', path: '/api/login', expect: { status: 200, json: [{ pointer: '/loggedIn', equals: true }] } },
          { method: 'GET', path: '/api/private-cookie', expect: { status: 200, headers: [{ name: 'x-content-type-options', equals: 'nosniff' }, { name: 'x-powered-by', exists: false }], json: [{ pointer: '/allowed', equals: true }] } },
          { method: 'POST', path: '/api/rotate', expect: { status: 200, json: [{ pointer: '/rotated', equals: true }] } },
          { method: 'GET', path: '/api/private-cookie', expect: { status: 200, json: [{ pointer: '/allowed', equals: true }] } },
          { method: 'POST', path: '/api/logout', expect: { status: 204 } },
          { method: 'GET', path: '/api/private-cookie', expect: { status: 401, json: [{ pointer: '/allowed', equals: false }] } },
        ] },
        { id: 'cookie-manual-redirect', actor: 'owner', steps: [
          { method: 'POST', path: '/api/redirect-login', redirect: 'manual', expect: { status: 302, location: '/api/private-cookie' } },
          { method: 'GET', path: '/api/private-cookie', expect: { status: 200, json: [{ pointer: '/allowed', equals: true }] } },
        ] },
      ],
    };
    put(join(out, 'state-rules.json'), rules);
    child = spawn(process.execPath, [join(out, 'server.mjs'), '--port', '0'], { cwd: out, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await ready(child);

    const draft = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: { ...process.env }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(draft.status, 1, draft.stderr + draft.stdout);
    let report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rules').status, 'skipped');
    assert.equal(report.results.find(item => item.id === 'business-rules').reason, 'rules_require_human_review');

    rules.status = 'reviewed';
    put(join(out, 'state-rules.json'), rules);
    const held = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: { ...process.env }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(held.status, 1, held.stderr + held.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:read-items').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:create-item').status, 'skipped');
    assert.equal(report.results.find(item => item.id === 'business-rule:create-item').reason, 'write_requires_explicit_local_authorization');
    assert.equal(report.results.find(item => item.id === 'business-rule:owner-private-read').status, 'incomplete');
    assert.equal(report.results.find(item => item.id === 'business-rule:owner-private-read').actor, 'owner');
    assert.equal(report.results.find(item => item.id === 'business-rule:anonymous-private-denied').status, 'passed');
    assert.match(report.repairTasks.find(item => item.kind === 'business-rule').target, /state-rules\.json/);

    const invalidActorRules = JSON.parse(JSON.stringify(rules));
    invalidActorRules.rules[0].actor = 'owner secret';
    put(join(out, 'state-rules.json'), invalidActorRules);
    const invalidActor = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: process.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(invalidActor.status, 1, invalidActor.stderr + invalidActor.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:read-items').reason, 'invalid_actor');
    assert.equal(report.results.find(item => item.id === 'business-rule:read-items').actor, undefined);
    put(join(out, 'state-rules.json'), rules);

    const invalidPathRules = JSON.parse(JSON.stringify(rules));
    invalidPathRules.rules[0].steps[0].path = '/api/items/' + '\\' + String.fromCharCode(0);
    put(join(out, 'state-rules.json'), invalidPathRules);
    const invalidPath = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: process.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(invalidPath.status, 1, invalidPath.stderr + invalidPath.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:read-items').reason, 'invalid_step');
    put(join(out, 'state-rules.json'), rules);

    const externalPathRules = JSON.parse(JSON.stringify(rules));
    externalPathRules.rules[0].steps[0].path = '//outside.example/secret';
    put(join(out, 'state-rules.json'), externalPathRules);
    const externalPath = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: process.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(externalPath.status, 1, externalPath.stderr + externalPath.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:read-items').reason, 'invalid_step');
    put(join(out, 'state-rules.json'), rules);

    const invalidLocationRules = JSON.parse(JSON.stringify(rules));
    invalidLocationRules.rules.find(item => item.id === 'cookie-manual-redirect').steps[0].expect.location = 'https://outside.example/after-login';
    put(join(out, 'state-rules.json'), invalidLocationRules);
    const invalidLocation = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: { ...process.env, HEIMDALL_ALLOW_WRITES: '1', HEIMDALL_TEST_BODY_JSON: '{"id":"fixture-secret"}', HEIMDALL_FIXTURE_OWNER_AUTH: 'Bearer owner-secret', HEIMDALL_FIXTURE_GUEST_AUTH: 'Bearer guest-secret', HEIMDALL_FIXTURE_INVALID_AUTH: 'Bearer invalid-secret' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(invalidLocation.status, 1, invalidLocation.stderr + invalidLocation.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-manual-redirect').reason, 'invalid_expected_location');
    put(join(out, 'state-rules.json'), rules);

    const networkLocationRules = JSON.parse(JSON.stringify(rules));
    networkLocationRules.rules.find(item => item.id === 'cookie-manual-redirect').steps[0].expect.location = '//outside.example/after-login';
    put(join(out, 'state-rules.json'), networkLocationRules);
    const networkLocation = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: { ...process.env, HEIMDALL_ALLOW_WRITES: '1' }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(networkLocation.status, 1, networkLocation.stderr + networkLocation.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-manual-redirect').reason, 'invalid_expected_location');
    put(join(out, 'state-rules.json'), rules);

    const invalidHeaderRules = JSON.parse(JSON.stringify(rules));
    invalidHeaderRules.rules.find(item => item.id === 'cookie-session-lifecycle').steps[1].expect.headers[0].equals = 'unsafe';
    put(join(out, 'state-rules.json'), invalidHeaderRules);
    const invalidHeader = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: { ...process.env, HEIMDALL_ALLOW_WRITES: '1', HEIMDALL_TEST_BODY_JSON: '{"id":"fixture-secret"}', HEIMDALL_FIXTURE_OWNER_AUTH: 'Bearer owner-secret', HEIMDALL_FIXTURE_GUEST_AUTH: 'Bearer guest-secret', HEIMDALL_FIXTURE_INVALID_AUTH: 'Bearer invalid-secret' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(invalidHeader.status, 1, invalidHeader.stderr + invalidHeader.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-session-lifecycle').reason, 'unexpected_header');
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-session-lifecycle').header, 'x-content-type-options');
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-session-lifecycle').repairTask.evidence.header, 'x-content-type-options');
    put(join(out, 'state-rules.json'), rules);

    const sensitiveHeaderRules = JSON.parse(JSON.stringify(rules));
    sensitiveHeaderRules.rules.find(item => item.id === 'cookie-session-lifecycle').steps[1].expect.headers[0] = { name: 'set-cookie', exists: true };
    put(join(out, 'state-rules.json'), sensitiveHeaderRules);
    const sensitiveHeader = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out, env: { ...process.env, HEIMDALL_ALLOW_WRITES: '1', HEIMDALL_TEST_BODY_JSON: '{"id":"fixture-secret"}', HEIMDALL_FIXTURE_OWNER_AUTH: 'Bearer owner-secret', HEIMDALL_FIXTURE_GUEST_AUTH: 'Bearer guest-secret', HEIMDALL_FIXTURE_INVALID_AUTH: 'Bearer invalid-secret' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(sensitiveHeader.status, 1, sensitiveHeader.stderr + sensitiveHeader.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-session-lifecycle').reason, 'invalid_header_assertion');
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-session-lifecycle').header, undefined);
    put(join(out, 'state-rules.json'), rules);

    const allowed = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out,
      env: { ...process.env, HEIMDALL_ALLOW_WRITES: '1', HEIMDALL_TEST_BODY_JSON: '{"id":"fixture-secret"}', HEIMDALL_FIXTURE_OWNER_AUTH: 'Bearer owner-secret', HEIMDALL_FIXTURE_GUEST_AUTH: 'Bearer guest-secret', HEIMDALL_FIXTURE_INVALID_AUTH: 'Bearer invalid-secret' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(allowed.status, 1, allowed.stderr + allowed.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.results.find(item => item.id === 'business-rule:create-item').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:read-created-item').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:owner-private-read').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:owner-private-read').actor, 'owner');
    assert.equal(report.results.find(item => item.id === 'business-rule:guest-private-denied').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:guest-private-denied').actor, 'guest');
    assert.equal(report.results.find(item => item.id === 'business-rule:anonymous-private-denied').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:invalid-private-denied').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-session-lifecycle').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-session-lifecycle').stateConsistency, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:cookie-manual-redirect').status, 'passed');
    assert.equal(report.results.find(item => item.id === 'business-rule:create-item').stateConsistency, 'incomplete');
    assert.equal(report.results.find(item => item.id === 'business-rule:read-created-item').stateConsistency, 'passed');
    assert.equal(report.stateConsistency.status, 'incomplete');
    assert.equal(report.stateConsistency.passed, 3);
    assert.equal(report.stateConsistency.incomplete, 1);
    assert.doesNotMatch(readFileSync(join(out, 'backend-check.json'), 'utf8'), /fixture-secret/);
    assert.doesNotMatch(readFileSync(join(out, 'backend-check.json'), 'utf8'), /owner-secret|guest-secret|invalid-secret/);
    assert.doesNotMatch(readFileSync(join(out, 'backend-check.json'), 'utf8'), /fixture-session-one|fixture-session-two/);

    const sourceStyle = spawnSync(process.execPath, [join(out, 'checks.mjs'), base, '--business-rules-only'], {
      cwd: out,
      env: { ...process.env, HEIMDALL_ALLOW_WRITES: '1', HEIMDALL_TEST_BODY_JSON: '{"id":"fixture-secret"}', HEIMDALL_FIXTURE_OWNER_AUTH: 'Bearer owner-secret', HEIMDALL_FIXTURE_GUEST_AUTH: 'Bearer guest-secret', HEIMDALL_FIXTURE_INVALID_AUTH: 'Bearer invalid-secret' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(sourceStyle.status, 0, sourceStyle.stderr + sourceStyle.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.mode, 'business-rules-only');
    assert.equal(report.results.some(item => item.id === 'health' || item.id === 'adapter-gap-ledger'), false);
    assert.equal(report.results.filter(item => item.id.startsWith('business-rule:')).length, 9);
    assert.equal(report.stateConsistency.status, 'incomplete');

    hangingServer = createServer((request, response) => {
      if (request.url === '/headers-then-hang') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"id":');
      }
    });
    await new Promise((resolve, reject) => {
      hangingServer.once('error', reject);
      hangingServer.listen(0, '127.0.0.1', resolve);
    });
    const hangingPort = hangingServer.address().port;
    put(join(out, 'state-rules.json'), { ...rules, rules: [
      { id: 'hanging-request', steps: [{ method: 'GET', path: '/hang', expect: { status: 200 } }] },
      { id: 'hanging-response-body', steps: [{ method: 'GET', path: '/headers-then-hang', expect: { status: 200, type: 'object' } }] },
    ] });
    const timedOut = spawnSync(process.execPath, [join(out, 'checks.mjs'), `http://127.0.0.1:${hangingPort}`, '--business-rules-only'], {
      cwd: out, env: process.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(timedOut.status, 1, timedOut.stderr + timedOut.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    const timeoutRules = report.results.filter(item => item.id.startsWith('business-rule:hanging-'));
    assert.equal(timeoutRules.length, 2);
    for (const timeoutRule of timeoutRules) {
      assert.equal(timeoutRule.status, 'incomplete');
      assert.equal(timeoutRule.reason, 'request_timeout');
      assert.equal(timeoutRule.repairTask.evidence.reason, 'request_timeout');
    }
    put(join(out, 'state-rules.json'), rules);
    await new Promise(resolve => hangingServer.close(resolve));
    hangingServer = undefined;

    put(join(out, 'state-rules.json'), { ...rules, rules: [] });
    const noRules = spawnSync(process.execPath, [join(out, 'checks.mjs'), base, '--business-rules-only'], {
      cwd: out, env: process.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(noRules.status, 1, noRules.stderr + noRules.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    assert.equal(report.overall, 'incomplete');
    assert.equal(report.results[0].reason, 'no_business_rules_declared');
    assert.equal(report.stateConsistency.status, 'not-tested');

    rules.rules[1].steps[0].expect.json[0].equals = false;
    put(join(out, 'state-rules.json'), rules);
    const failed = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out,
      env: { ...process.env, HEIMDALL_ALLOW_WRITES: '1', HEIMDALL_TEST_BODY_JSON: '{"id":"fixture-secret"}' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    report = JSON.parse(readFileSync(join(out, 'backend-check.json'), 'utf8'));
    const businessFailure = report.results.find(item => item.id === 'business-rule:create-item');
    assert.equal(businessFailure.status, 'failed');
    assert.equal(businessFailure.pointer, '/created');
    assert.equal(businessFailure.repairTask.kind, 'business-rule');
    assert.doesNotMatch(readFileSync(join(out, 'backend-check.json'), 'utf8'), /fixture-secret/);
  } finally {
    if (hangingServer) await new Promise(resolve => hangingServer.close(resolve));
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend compare aligns source and candidate business-rule reports without leaking reasons', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-compare-'));
  try {
    const source = join(root, 'source-check.json');
    const candidate = join(root, 'candidate-check.json');
    const out = join(root, 'backend-compare.json');
    put(source, {
      schema: 'heimdall.backend-check/1', mode: 'business-rules-only', overall: 'passed', results: [
        { id: 'business-rule:read-item', actor: 'owner', status: 'passed', stateConsistency: 'passed' },
        { id: 'business-rule:stateful-item', status: 'passed', stateConsistency: 'passed' },
        { id: 'business-rule:update-item', status: 'passed' },
        { id: 'business-rule:delete-item', status: 'passed' },
      ],
    });
    put(candidate, {
      schema: 'heimdall.backend-check/1', mode: 'business-rules-only', overall: 'failed', results: [
        { id: 'business-rule:read-item', actor: 'guest', status: 'passed', stateConsistency: 'passed' },
        { id: 'business-rule:stateful-item', status: 'passed', stateConsistency: 'incomplete' },
        { id: 'business-rule:update-item', status: 'failed', step: 2, pointer: '/title', reason: 'private-value' },
      ],
    });
    const result = spawnSync(process.execPath, [CLI, 'backend', 'compare', source, candidate, '--out', out, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const envelope = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(envelope.ok, true);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.overall, 'failed');
    assert.deepEqual(report.summary, { compared: 4, passed: 0, failed: 2, incomplete: 2 });
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:update-item').pointer, '/title');
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:delete-item').reason, 'rule_missing_from_candidate');
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:read-item').sourceActor, 'owner');
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:read-item').candidateActor, 'guest');
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:read-item').reason, 'actor_context_mismatch');
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:stateful-item').status, 'incomplete');
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:stateful-item').reason, 'candidate_state_consistency_incomplete');
    assert.equal(report.comparisons.find(item => item.id === 'business-rule:stateful-item').candidateStateConsistency, 'incomplete');
    assert.equal(new Set(report.repairTasks.map(item => item.id)).size, 3);
    assert.equal(report.repairTasks.find(item => item.kind === 'business-rule-context').requiresHumanApproval, true);
    assert.doesNotMatch(readFileSync(out, 'utf8'), /private-value/);

    const scaffold = join(root, 'scaffold-check.json');
    put(scaffold, { schema: 'heimdall.backend-check/1', mode: 'scaffold', overall: 'passed', results: [] });
    const invalid = spawnSync(process.execPath, [CLI, 'backend', 'compare', scaffold, candidate, '--out', join(root, 'invalid.json'), '--json'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2, invalid.stderr + invalid.stdout);
    assert.doesNotMatch(invalid.stdout, /private-value/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
