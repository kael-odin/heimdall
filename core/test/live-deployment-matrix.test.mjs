import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { liveSnapshotPath } from '../src/live/live-path.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

const CASES = {
  ssr: {
    host: 'ssr-deployment.invalid',
    routes: ['/', '/docs/', '/docs/next?revision=2'],
    pages: [
      ['home', '/', '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1>Welcome</h1><a href="/docs/">Docs</a></body></html>'],
      ['docs', '/docs/', '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1>Documentation</h1><a href="next?revision=2">Next</a></body></html>'],
      ['next', '/docs/next?revision=2', '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1>Revision 2</h1><a href="/">Home</a></body></html>'],
    ],
    flow: {
      path: '/',
      actions: [{ type: 'click', selector: 'a[href="/docs/"]' }, { type: 'click', selector: 'a[href="next?revision=2"]' }],
      expect: [{ type: 'url', path: '/docs/next?revision=2' }, { type: 'text-includes', selector: 'h1', value: 'Revision 2' }],
    },
  },
  spa: {
    host: 'spa-deployment.invalid',
    routes: ['/', '/catalog?tag=blue', '/item/42?view=details'],
    flow: {
      path: '/',
      actions: [{ type: 'click', selector: 'a[href="/catalog?tag=blue"]' }, { type: 'click', selector: 'a[href="/item/42?view=details"]' }],
      expect: [{ type: 'url', path: '/item/42?view=details' }, { type: 'text-includes', selector: 'h1', value: 'Item 42' }],
    },
  },
};

const SPA_HTML = '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><main id="app"></main><script src="/assets/spa.js"></script></body></html>';
const SPA_JS = `
function render() {
  const path = location.pathname;
  const query = new URLSearchParams(location.search);
  const app = document.querySelector('#app');
  if (path === '/catalog') {
    app.innerHTML = '<h1>Catalog: ' + query.get('tag') + '</h1><a href="/item/42?view=details">Item 42</a>';
  } else if (path === '/item/42') {
    app.innerHTML = '<h1>Item 42</h1><p>' + query.get('view') + '</p><a href="/">Home</a>';
  } else {
    app.innerHTML = '<h1>SPA home</h1><a href="/catalog?tag=blue">Catalog</a>';
  }
  app.querySelectorAll('a').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    history.pushState(null, '', link.href);
    render();
  }));
}
addEventListener('popstate', render);
render();
`;

function writePage(site, name, path, html, origin) {
  const page = join(site, 'pages', name);
  mkdirSync(join(page, 'clone'), { recursive: true });
  writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: origin + path }));
  writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><h1>Clone fixture</h1>');
  const url = new URL(path, origin);
  const snapshot = join(site, 'live', liveSnapshotPath(url.pathname, url.search));
  mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, html);
}

function prepareFixture(kind) {
  const fixture = CASES[kind];
  const root = mkdtempSync(join(tmpdir(), `heimdall-${kind}-deployment-`));
  const source = join(root, 'source');
  const site = join(source, 'workspace', fixture.host);
  const exported = join(source, 'deliverable', 'bundle');
  const deployed = join(root, 'deployed');
  const origin = `https://${fixture.host}`;
  try {
    const pages = kind === 'spa'
      ? fixture.routes.map((path, index) => [`route-${index}`, path, SPA_HTML])
      : fixture.pages;
    for (const [name, path, html] of pages) writePage(site, name, path, html, origin);
    mkdirSync(join(site, 'live', 'assets'), { recursive: true });
    writeFileSync(join(site, 'live', 'assets', 'site.css'), 'body { background-color: rgb(14, 36, 58); }');
    if (kind === 'spa') writeFileSync(join(site, 'live', 'assets', 'spa.js'), SPA_JS);
    mkdirSync(join(site, 'recon'), { recursive: true });
    writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({
      origin, status: 'ok', nodes: fixture.routes.map(url => ({ url: origin + url })),
    }));
    writeFileSync(join(site, 'operation-plan.json'), JSON.stringify({ version: 1, flows: [fixture.flow] }));

    const result = spawnSync(process.execPath, [EXPORT, fixture.host, '--offline', '--strict', '--root', 'mirror', '--out', exported], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: source }, encoding: 'utf8', timeout: 90_000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const health = JSON.parse(readFileSync(join(exported, 'health.json'), 'utf8'));
    assert.equal(health.coverage.delivered, fixture.routes.length);
    assert.equal(health.browserProbe.checked, fixture.routes.length);
    assert.equal(health.browserProbe.failed, 0);
    assert.equal(health.browserProbe.untested, 0);
    assert.equal(health.operationProbe.checked, 1);
    assert.equal(health.operationProbe.failed, 0);
    assert.equal(health.operationProbe.untested, 0);

    cpSync(exported, deployed, { recursive: true });
    rmSync(source, { recursive: true, force: true });
    assert.equal(existsSync(source), false, 'source workspace must be absent before deployment');
    assert.equal(existsSync(join(deployed, 'node_modules')), false);
    return { ...fixture, root, source, deployed, origin };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function startBundle(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs', '--port', '0', '--host', '127.0.0.1'], {
      cwd: dir, env: { ...process.env, HEIMDALL_DATA_DIR: join(dir, 'missing-workspace') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', part => { stderr = (stderr + part).slice(-2000); });
    const timer = setTimeout(() => fail(new Error('bundle startup timed out: ' + stderr)), 10_000);
    function fail(error) { clearTimeout(timer); child.kill(); reject(error); }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`bundle exited (${code}): ${stderr}`)));
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      resolve({ child, base: `http://127.0.0.1:${message.port}` });
    });
  });
}

async function stopBundle(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
}

for (const kind of ['ssr', 'spa']) {
  test(`${kind.toUpperCase()} strict bundle survives relocation and origin blocking`, { timeout: 120_000 }, async () => {
    const fixture = prepareFixture(kind);
    let child;
    let browser;
    try {
      const server = await startBundle(fixture.deployed);
      child = server.child;
      const { base } = server;
      const health = await (await fetch(base + '/__heimdall/health')).json();
      assert.equal(health.offline, true);
      assert.equal(health.root, 'mirror');
      assert.equal(health.origin, fixture.origin);
      assert.equal((await fetch(base + '/missing')).status, 404);
      assert.equal((await fetch(base + '/catalog?tag=uncaptured')).status, 404);

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const outside = [];
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin === base) return route.continue();
        outside.push(route.request().url());
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      await page.goto(base + '/', { waitUntil: 'networkidle' });
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(14, 36, 58)');
      if (kind === 'ssr') {
        assert.equal(await page.locator('h1').textContent(), 'Welcome');
        await page.getByRole('link', { name: 'Docs' }).click();
        assert.equal(await page.locator('h1').textContent(), 'Documentation');
        await page.getByRole('link', { name: 'Next' }).click();
        assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/docs/next?revision=2');
        assert.equal(await page.locator('h1').textContent(), 'Revision 2');
        await page.reload();
        assert.equal(await page.locator('h1').textContent(), 'Revision 2');
      } else {
        assert.equal(await page.locator('h1').textContent(), 'SPA home');
        await page.getByRole('link', { name: 'Catalog' }).click();
        assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/catalog?tag=blue');
        assert.equal(await page.locator('h1').textContent(), 'Catalog: blue');
        await page.getByRole('link', { name: 'Item 42' }).click();
        assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/item/42?view=details');
        assert.equal(await page.locator('h1').textContent(), 'Item 42');
        assert.equal(await page.locator('p').textContent(), 'details');
        await page.goBack();
        assert.equal(await page.locator('h1').textContent(), 'Catalog: blue');
        await page.goto(base + '/item/42?view=details', { waitUntil: 'networkidle' });
        assert.equal(await page.locator('h1').textContent(), 'Item 42');
      }
      assert.deepEqual(outside, [], 'deployed bundle must not require another origin');
      await context.close();
    } finally {
      await browser?.close();
      await stopBundle(child);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

function docker(args, timeout = 30_000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  assert.equal(result.status, 0, `docker ${args[0]} failed: ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  return result.stdout.trim();
}

test('Docker network-none delivery serves SSR and SPA bundles without a source workspace', {
  timeout: 600_000, skip: process.env.HEIMDALL_DOCKER_TEST !== '1',
}, () => {
  docker(['info', '--format', '{{.ServerVersion}}']);
  for (const kind of ['ssr', 'spa']) {
    const fixture = prepareFixture(kind);
    const image = `heimdall-deploy-matrix:${process.pid}-${kind}`;
    const container = `heimdall-deploy-matrix-${process.pid}-${kind}`;
    let started = false;
    let built = false;
    try {
      docker(['build', '--tag', image, fixture.deployed], 180_000);
      built = true;
      docker(['run', '--detach', '--rm', '--network', 'none', '--name', container, image]);
      started = true;
      assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]), 'none');
      const routes = kind === 'ssr'
        ? { '/': '<h1>Welcome</h1>', '/docs/': '<h1>Documentation</h1>',
          '/docs/next?revision=2': '<h1>Revision 2</h1>', '/assets/site.css': 'rgb(14, 36, 58)' }
        : { '/': '<main id="app">', '/catalog?tag=blue': '<main id="app">',
          '/item/42?view=details': '<main id="app">', '/assets/site.css': 'rgb(14, 36, 58)',
          '/assets/spa.js': "addEventListener('popstate', render)" };
      const script = `
        const routes = JSON.parse(process.argv[1]);
        const { existsSync } = await import('node:fs');
        const base = 'http://127.0.0.1:8080';
        if (existsSync('/app/workspace')) throw Error('source workspace copied into image');
        let health;
        for (let i = 0; i < 50; i++) {
          try { health = await (await fetch(base + '/__heimdall/health')).json(); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        if (!health?.offline || health.root !== 'mirror') throw Error('not an offline root mirror');
        for (const [path, expected] of Object.entries(routes)) {
          const response = await fetch(base + path);
          if (response.status !== 200) throw Error(path + ': ' + response.status);
          const body = await response.text();
          if (!body.includes(expected)) throw Error(path + ': unexpected content');
        }
        for (const path of ['/missing', '/catalog?tag=uncaptured']) {
          const response = await fetch(base + path);
          if (response.status !== 404) throw Error(path + ': ' + response.status);
          await response.body.cancel();
        }
        console.log('offline routes verified: ' + Object.keys(routes).length);
      `;
      assert.match(docker(['exec', container, 'node', '--input-type=module', '-e', script, JSON.stringify(routes)], 30_000), /offline routes verified/);
    } finally {
      if (started) spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8', timeout: 30_000 });
      if (built) spawnSync('docker', ['image', 'rm', image], { encoding: 'utf8', timeout: 30_000 });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
