import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'adapter-export.invalid';
const ORIGIN = `https://${HOST}`;
const ADAPTER = `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function handle(request, { dataDir }) {
  const file = join(dataDir, 'items.json');
  let items;
  try { items = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; items = []; }
  if (request.method === 'POST') {
    items.push(JSON.parse(await request.text()));
    await writeFile(file, JSON.stringify(items));
    return Response.json({ count: items.length }, { status: 201 });
  }
  return Response.json(items);
}
`;
const HTML = `<!doctype html><title>Adapter fixture</title>
<button id="save" type="button">Save</button><p id="result"></p>
<script>
document.querySelector('#save').onclick = async () => {
  const saved = await fetch('/api/items', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'saved' }),
  });
  if (saved.status !== 201) throw Error('save failed');
  const items = await (await fetch('/api/items')).json();
  document.querySelector('#result').textContent = items[0]?.name ?? 'missing';
};
</script>`;

function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-adapter-export-'));
  const source = join(root, 'source');
  const site = join(source, 'workspace', HOST);
  const adapterDir = join(site, 'runtime-adapter');
  const out = join(source, 'deliverable', 'bundle');
  put(join(site, 'site-origin.json'), JSON.stringify({ origin: ORIGIN }));
  put(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: ORIGIN + '/' }));
  put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  put(join(site, 'live', 'index.html'), HTML);
  put(join(site, 'recon', 'atlas.json'), JSON.stringify({
    origin: ORIGIN, status: 'ok', nodes: [{ url: ORIGIN + '/' }],
  }));
  put(join(site, 'operation-plan.json'), JSON.stringify({
    version: 1, flows: [{
      path: '/', actions: [{ type: 'click', selector: '#save' }],
      expect: [{ type: 'text-includes', selector: '#result', value: 'saved' }],
    }],
  }));
  put(join(adapterDir, 'manifest.json'), JSON.stringify({
    version: 1, routes: [
      { method: 'POST', path: '/api/items' },
      { method: 'GET', path: '/api/items' },
    ],
  }));
  put(join(adapterDir, 'index.mjs'), ADAPTER);
  return { root, source, site, adapterDir, out };
}

function runExport(f, flags = ['--include-adapter', '--offline', '--strict']) {
  return spawnSync(process.execPath, [EXPORT, HOST, ...flags, '--root', 'mirror', '--out', f.out], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: f.source },
    encoding: 'utf8', timeout: 90_000,
  });
}

function startBundle(bundle, state) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs', '--port', '0', '--host', '127.0.0.1'], {
      cwd: bundle, env: { ...process.env, HEIMDALL_RUNTIME_DATA_DIR: state },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', part => { stderr = (stderr + part).slice(-2000); });
    const timer = setTimeout(() => fail(new Error('adapter bundle startup timed out: ' + stderr)), 10_000);
    function fail(error) { clearTimeout(timer); child.kill(); reject(error); }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`adapter bundle exited (${code}): ${stderr}`)));
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      resolve({ child, base: `http://127.0.0.1:${message.port}` });
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('strict adapter export is relocatable and keeps runtime state outside the bundle', { timeout: 120_000 }, async () => {
  const f = fixture();
  let child;
  try {
    const run = runExport(f);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const health = JSON.parse(readFileSync(join(f.out, 'health.json'), 'utf8'));
    assert.deepEqual(health.adapter, {
      status: 'included', declaredRoutes: 2, exercisedRoutes: 2, untestedRoutes: 0,
      serverEgress: 'not-tested',
      sessionRoutes: { declared: 0, initialized: 0, failed: 0 },
    });
    assert.equal(health.operationProbe.failed, 0);
    assert.equal(health.strictBlockers.adapterRoutesUntested, 0);
    assert.equal(existsSync(join(f.out, 'items.json')), false);
    assert.equal(existsSync(join(f.out, 'runtime-adapter', 'items.json')), false);
    assert.equal(existsSync(join(f.out, 'node_modules')), false);
    assert.match(readFileSync(join(f.out, 'Dockerfile'), 'utf8'), /HEIMDALL_RUNTIME_DATA_DIR=\/data/);
    assert.match(readFileSync(join(f.out, 'docker-compose.yml'), 'utf8'), /heimdall-runtime-data:\/data/);
    assert.match(readFileSync(join(f.out, 'README.md'), 'utf8'), /HEIMDALL_RUNTIME_DATA_DIR/);

    const acceptedHealth = readFileSync(join(f.out, 'health.json'), 'utf8');
    put(join(f.site, 'live', 'index.html'), HTML + '<a href="/uncaptured/">Uncaptured page</a>');
    const blocked = runExport(f);
    assert.equal(blocked.status, 1, blocked.stderr + blocked.stdout);
    const candidateName = readdirSync(join(f.source, 'deliverable')).find(name => name.startsWith('.candidate-'));
    const partial = JSON.parse(readFileSync(join(f.source, 'deliverable', candidateName, 'health.json'), 'utf8'));
    assert.ok(partial.strictBlockers.missingLinks > 0);
    assert.equal(partial.operationProbe.checked, 1, 'missing navigation must not hide declared bundled flow diagnostics');
    assert.equal(partial.operationProbe.failed, 0);
    assert.equal(partial.strictBlockers.adapterRoutesUntested, 0);
    assert.equal(readFileSync(join(f.out, 'health.json'), 'utf8'), acceptedHealth, 'blocked diagnostics must preserve the accepted bundle');
    put(join(f.site, 'live', 'index.html'), HTML);

    const deployed = join(f.root, 'deployed');
    const state = join(f.root, 'runtime-state');
    cpSync(f.out, deployed, { recursive: true });
    mkdirSync(state);
    rmSync(f.source, { recursive: true, force: true });
    assert.equal(existsSync(f.source), false);
    const config = join(deployed, 'heimdall-live.json');
    const settings = JSON.parse(readFileSync(config, 'utf8'));
    writeFileSync(config, JSON.stringify({ ...settings, offline: false }));

    let server = await startBundle(deployed, state);
    child = server.child;
    const healthResponse = await (await fetch(server.base + '/__heimdall/health')).json();
    assert.equal(healthResponse.offline, true, 'adapter mode must remain offline even if config is edited');
    assert.deepEqual(await (await fetch(server.base + '/api/items')).json(), []);
    const saved = await fetch(server.base + '/api/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"persisted"}',
    });
    assert.equal(saved.status, 201);
    assert.equal((await fetch(server.base + '/api/unknown', { method: 'POST' })).status, 404);
    await stop(child);
    server = await startBundle(deployed, state);
    child = server.child;
    assert.deepEqual(await (await fetch(server.base + '/api/items')).json(), [{ name: 'persisted' }]);
    assert.equal(existsSync(join(state, 'items.json')), true);
    assert.equal(existsSync(join(deployed, 'items.json')), false);
  } finally {
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('adapter export rejects missing flags, unexpected files, invalid code and uncovered routes', { timeout: 120_000 }, () => {
  const f = fixture();
  const modulePath = join(f.adapterDir, 'index.mjs');
  const manifestPath = join(f.adapterDir, 'manifest.json');
  const validManifest = readFileSync(manifestPath, 'utf8');
  try {
    for (const flags of [['--include-adapter'], ['--include-adapter', '--offline'], ['--include-adapter', '--strict']]) {
      const run = runExport(f, flags);
      assert.equal(run.status, 2, run.stderr + run.stdout);
    }
    for (const path of ['/', `/static/${HOST}/site.css`, `/%73tatic/${HOST}/site.css`]) {
      put(manifestPath, JSON.stringify({
        version: 1, routes: [{ method: 'GET', path }],
      }));
      const reserved = runExport(f);
      assert.equal(reserved.status, 2, `${path}: ${reserved.stderr}${reserved.stdout}`);
      assert.match(reserved.stderr, /invalid runtime adapter/);
    }
    put(manifestPath, validManifest);
    put(join(f.adapterDir, 'extra.json'), '{}');
    assert.equal(runExport(f).status, 2);
    rmSync(join(f.adapterDir, 'extra.json'));
    put(manifestPath, JSON.stringify({ version: 1, routes: [{ method: 'POST', path: '/api/../other' }] }));
    assert.equal(runExport(f).status, 2);
    put(manifestPath, validManifest);
    put(modulePath, 'export async function handle( {');
    assert.equal(runExport(f).status, 2);
    put(modulePath, ADAPTER);

    const expanded = JSON.parse(validManifest);
    expanded.routes.push({ method: 'GET', path: '/api/never-used' });
    put(manifestPath, JSON.stringify(expanded));
    const uncovered = runExport(f);
    assert.equal(uncovered.status, 1, uncovered.stderr + uncovered.stdout);
    const candidates = readdirSync(join(f.source, 'deliverable'))
      .filter(name => name.startsWith('.candidate-'));
    assert.ok(candidates.length > 0);
    const candidate = JSON.parse(readFileSync(join(f.source, 'deliverable', candidates.at(-1), 'health.json'), 'utf8'));
    assert.equal(candidate.strictBlockers.adapterRoutesUntested, 1);
    put(manifestPath, validManifest);

    put(modulePath, "import 'playwright'; export async function handle() { return Response.json([]); }");
    const outsideDependency = runExport(f);
    assert.equal(outsideDependency.status, 1, outsideDependency.stderr + outsideDependency.stdout);
    assert.match(outsideDependency.stderr, /offline gaps/);
    assert.equal(existsSync(f.out), false, 'failed probes must not publish a bundle');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('adapter validation rejects symlinks when the platform permits creating one', () => {
  const f = fixture();
  try {
    const modulePath = join(f.adapterDir, 'index.mjs');
    const actual = join(f.root, 'actual-index.mjs');
    writeFileSync(actual, ADAPTER);
    rmSync(modulePath);
    try { symlinkSync(actual, modulePath); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return;
      throw error;
    }
    assert.equal(runExport(f).status, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
