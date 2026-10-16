import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRuntimeAdapter } from '../src/live/adapter-runtime.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'session-adapter.invalid';
const SESSION_COOKIE = 'session=admin-local; Path=/; HttpOnly';
const SESSION_ROUTE = { method: 'POST', path: '/api/session/admin' };

function put(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function adapterModule(setCookie = true) {
  return `export async function handle(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/session/admin') {
      return new Response('not found', { status: 404 });
    }
    const headerName = ['Set', 'Cookie'].join('-');
    const name = ['ses', 'sion'].join('');
    const value = ['admin', '-local'].join('');
    const headers = ${setCookie ? '{ [headerName]: name + "=" + value + "; Path=/; HttpOnly" }' : '{}'};
    return new Response(null, { status: 204, headers });
  }`;
}

function fixture({
  origin = `https://${HOST}`,
  sessions = { admin: SESSION_ROUTE },
  setCookie = true,
  actions = [{ type: 'useSession', sessionName: null }, { type: 'useSession', sessionName: 'admin' }],
  html = `<!doctype html><title>Session adapter</title><p id="result"></p>
    <script>document.querySelector('#result').textContent = document.cookie;</script>`,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-adapter-session-'));
  const source = join(root, 'source');
  const site = join(source, 'workspace', HOST);
  const adapterDir = join(site, 'runtime-adapter');
  const out = join(source, 'deliverable', 'bundle');
  put(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  put(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: origin + '/' }));
  put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  put(join(site, 'live', 'index.html'), html);
  put(join(site, 'operation-plan.json'), JSON.stringify({
    version: 1,
    flows: [{
      path: '/',
      sessionName: 'admin',
      actions,
      expect: [{ type: 'text-includes', selector: '#result', value: 'admin-local' }],
    }],
  }));
  put(join(adapterDir, 'manifest.json'), JSON.stringify({
    version: 1,
    routes: [SESSION_ROUTE],
    ...(sessions ? { sessions } : {}),
  }));
  put(join(adapterDir, 'index.mjs'), adapterModule(setCookie));
  return { root, source, site, adapterDir, out };
}

function runExport(f, flags = []) {
  return spawnSync(process.execPath, [EXPORT, HOST, '--include-adapter', '--offline', '--strict',
    '--root', 'mirror', '--out', f.out, ...flags], {
    cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: f.source }, timeout: 90_000,
  });
}

function runExportAsync(f, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT, HOST, '--include-adapter', '--offline', '--strict',
      '--root', 'mirror', '--out', f.out, ...flags], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: f.source }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-30_000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-30_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function candidateHealth(f) {
  const candidate = readdirSync(join(f.source, 'deliverable'))
    .filter(name => name.startsWith('.candidate-'))
    .at(-1);
  assert.ok(candidate, 'failed export must retain a candidate bundle');
  return JSON.parse(readFileSync(join(f.source, 'deliverable', candidate, 'health.json'), 'utf8'));
}

test('adapter session routes bootstrap named contexts and report coverage', { timeout: 120_000 }, () => {
  const f = fixture();
  try {
    const run = runExport(f);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const health = JSON.parse(readFileSync(join(f.out, 'health.json'), 'utf8'));
    assert.deepEqual(health.adapter.sessionRoutes, { declared: 1, initialized: 2, failed: 0 });
    assert.deepEqual(health.operationProbe.flows[0].initialSession, {
      sessionName: 'admin', supported: true,
    });
    assert.deepEqual(health.operationProbe.flows[0].sessionSwitches, [
      { actionIndex: 1, sessionName: null, supported: true },
      { actionIndex: 3, sessionName: 'admin', supported: true },
    ]);
    assert.equal(health.adapter.exercisedRoutes, 1);
    assert.equal(health.adapter.untestedRoutes, 0);
    assert.equal(health.strictBlockers.adapterRoutesUntested, 0);
    assert.equal(health.strictBlockers.adapterSessionRoutesFailed, 0);
    assert.ok(health.operationProbe.flows[0].dependencies
      .every(dependency => !dependency.target.includes('/api/session/admin')));
    assert.doesNotMatch(JSON.stringify(health), /admin-local/);

    const accepted = readFileSync(join(f.out, 'health.json'));
    writeFileSync(join(f.adapterDir, 'manifest.json'), JSON.stringify({
      version: 1, routes: [SESSION_ROUTE],
    }));
    const missing = runExport(f);
    assert.equal(missing.status, 1, missing.stderr + missing.stdout);
    assert.deepEqual(readFileSync(join(f.out, 'health.json')), accepted);
    const failure = candidateHealth(f);
    assert.deepEqual(failure.adapter.sessionRoutes, { declared: 0, initialized: 0, failed: 2 });
    assert.equal(failure.strictBlockers.adapterSessionRoutesFailed, 2);
    assert.ok(failure.operationProbe.failures.some(issue =>
      issue.kind === 'sessionUnsupported' && issue.sessionName === 'admin'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('adapter session route without Set-Cookie fails closed', { timeout: 120_000 }, () => {
  const f = fixture({ setCookie: false });
  try {
    const run = runExport(f);
    assert.equal(run.status, 1, run.stderr + run.stdout);
    const health = candidateHealth(f);
    assert.deepEqual(health.adapter.sessionRoutes, { declared: 1, initialized: 0, failed: 2 });
    assert.equal(health.strictBlockers.adapterSessionRoutesFailed, 2);
    assert.ok(health.operationProbe.failures.some(issue =>
      issue.kind === 'sessionUnsupported' && issue.sessionName === 'admin'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('adapter manifest validates named session routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-adapter-session-manifest-'));
  try {
    const adapterDir = join(root, 'runtime-adapter');
    put(join(adapterDir, 'index.mjs'), 'export async function handle() { return new Response(null); }');
    const manifest = sessions => put(join(adapterDir, 'manifest.json'), JSON.stringify({
      version: 1, routes: [SESSION_ROUTE], ...(sessions ? { sessions } : {}),
    }));
    manifest({ admin: SESSION_ROUTE });
    const valid = inspectRuntimeAdapter(root);
    assert.equal(valid.sessionRoutes.size, 1);
    assert.deepEqual(valid.sessionRoutes.get('admin'), SESSION_ROUTE);

    manifest({ admin: { method: 'POST', path: '/api/not-declared' } });
    assert.throws(() => inspectRuntimeAdapter(root), /adapter session route is not declared/);

    manifest({ '../escape': SESSION_ROUTE });
    assert.throws(() => inspectRuntimeAdapter(root), /invalid adapter session route/);

    manifest({ admin: { method: 'GET', path: SESSION_ROUTE.path } });
    assert.throws(() => inspectRuntimeAdapter(root), /invalid adapter session route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compare-source does not count local session bootstrap as dependency parity', { timeout: 180_000 }, async t => {
  const source = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    if (path === '/api/items.json') {
      response.setHeader('content-type', 'application/json');
      return response.end('{"ok":true}');
    }
    response.setHeader('content-type', 'text/html');
    return response.end(`<!doctype html><title>Session source</title>
      <p id="result" hidden>Loaded</p>
      <script>fetch('/api/items.json').then(r => r.json())
        .then(() => { document.querySelector('#result').hidden = false; });</script>`);
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  t.after(async () => {
    source.close();
    source.closeAllConnections?.();
    await once(source, 'close');
  });

  const origin = `http://127.0.0.1:${source.address().port}`;
  const f = fixture({
    origin,
    actions: [],
    html: `<!doctype html><title>Session offline</title>
      <p id="result" hidden>Loaded</p>
      <script>fetch('/api/items.json').then(r => r.json())
        .then(() => { document.querySelector('#result').hidden = false; });</script>`,
  });
  try {
    put(join(f.site, 'session.admin.json'), JSON.stringify({
      cookies: [{ name: 'auth', value: 'admin-session-secret', domain: '127.0.0.1', path: '/',
        expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [],
    }));
    put(join(f.site, 'live', 'api', 'items.json'), '{"ok":true}');
    put(join(f.site, 'operation-plan.json'), JSON.stringify({
      version: 1,
      flows: [{
        path: '/', sessionName: 'admin', actions: [],
        expect: [{ type: 'visible', selector: '#result' }],
      }],
    }));
    const run = await runExportAsync(f, ['--compare-source']);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const health = JSON.parse(readFileSync(join(f.out, 'health.json'), 'utf8'));
    assert.equal(health.adapter.sessionRoutes.initialized, 1);
    assert.equal(health.strictBlockers.adapterSessionRoutesFailed, 0);
    assert.equal(health.sourceOperationProbe.flows[0].sessionName, 'admin');
    assert.equal(health.sourceOperationProbe.flows[0].sessionUsed, true);
    assert.equal(health.dependencyParity.mismatchedFlows, 0);
    assert.ok(health.operationProbe.flows[0].dependencies
      .every(dependency => !dependency.target.includes('/api/session/admin')));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
