import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'offline-source.invalid';
const ORIGIN = `https://${HOST}`;

function writeFixturePage(site, name, pathname, title) {
  const page = join(site, 'pages', name);
  mkdirSync(join(page, 'clone'), { recursive: true });
  writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: ORIGIN + pathname }));
  writeFileSync(join(page, 'clone', 'index.html'), `<!doctype html><title>Clone ${title}</title><h1>${title}</h1>`);
}

function startBundle(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs', '--port', '0', '--host', '127.0.0.1'], {
      cwd: dir,
      env: { ...process.env, HEIMDALL_DATA_DIR: join(dir, 'missing-source-workspace') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    const timer = setTimeout(() => fail(new Error('relocated bundle startup timed out: ' + stderr)), 10_000);
    function fail(error) {
      clearTimeout(timer);
      child.kill();
      reject(error);
    }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`relocated bundle exited (${code}): ${stderr}`)));
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      resolve({ child, base: `http://127.0.0.1:${message.port}` });
    });
  });
}

test('strict offline export runs after relocation with source workspace removed and origin blocked', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-independent-deploy-'));
  const source = join(root, 'source');
  const site = join(source, 'workspace', HOST);
  const exported = join(source, 'deliverable', 'bundle');
  const deployed = join(root, 'deployed');
  let child;
  let browser;
  try {
    writeFixturePage(site, 'home', '/', 'Home');
    writeFixturePage(site, 'about', '/about/', 'About');
    mkdirSync(join(site, 'recon'), { recursive: true });
    mkdirSync(join(site, 'live', 'about'), { recursive: true });
    writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({
      origin: ORIGIN, status: 'ok', nodes: [
        { url: ORIGIN + '/', title: 'Home' },
        { url: ORIGIN + '/about/', title: 'About' },
      ],
    }));
    writeFileSync(join(site, 'live', 'index.html'), `<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="/static/${HOST}/pages/home/clone/styles.css"></head><body><h1>Home</h1><p id="script-state">Waiting</p><a href="/about/">About</a><img alt="Badge" src="/media/badge.svg?v=1"><script src="/app.js"></script></body></html>`);
    writeFileSync(join(site, 'live', 'about', 'index.html'), '<!doctype html><title>About</title><h1>About</h1><a href="/">Home</a>');
    writeFileSync(join(site, 'live', 'app.js'), "document.querySelector('#script-state').textContent = 'Script ready';");
    writeFileSync(join(site, 'pages', 'home', 'clone', 'styles.css'), 'body { background-color: rgb(12, 34, 56); }');
    writeFileSync(join(site, 'pages', 'home', 'network.har'), JSON.stringify({ log: { entries: [{
      request: { method: 'GET', url: ORIGIN + '/media/badge.svg?v=1', headers: [] },
      response: { status: 200, headers: [], content: {
        mimeType: 'image/svg+xml',
        text: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>',
      } },
    }] } }));

    const result = spawnSync(process.execPath, [EXPORT, HOST, '--offline', '--strict', '--root', 'mirror', '--out', exported], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: source }, encoding: 'utf8', timeout: 70_000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const exportHealth = JSON.parse(readFileSync(join(exported, 'health.json'), 'utf8'));
    assert.equal(exportHealth.browserProbe.failed, 0);
    assert.equal(exportHealth.browserProbe.untested, 0);
    assert.equal(exportHealth.coverage.delivered, 2);

    cpSync(exported, deployed, { recursive: true });
    rmSync(source, { recursive: true, force: true });
    assert.equal(existsSync(source), false, 'test source workspace must be unavailable at runtime');
    assert.equal(existsSync(join(deployed, 'node_modules')), false, 'bundle must not rely on project dependencies');

    const server = await startBundle(deployed);
    child = server.child;
    const base = server.base;
    const health = await (await fetch(base + '/__heimdall/health')).json();
    assert.equal(health.offline, true, 'exported configuration must enforce offline mode');
    assert.equal(health.root, 'mirror');
    assert.equal(health.origin, ORIGIN);
    assert.equal((await fetch(base + '/missing')).status, 404, 'uncaptured paths must not proxy to the origin');
    assert.equal((await fetch(base + `/static/${HOST}/pages/home/clone/index.html`)).status, 200);
    assert.match(await (await fetch(base + `/static/${HOST}/pages/home/clone/styles.css`)).text(), /background-color/);
    const harAsset = await fetch(base + '/media/badge.svg?v=1');
    assert.equal(harAsset.status, 200);
    assert.equal(harAsset.headers.get('x-heimdall-replay'), '1');
    assert.match(await harAsset.text(), /<svg/);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const outsideRequests = [];
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      outsideRequests.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('h1').textContent(), 'Home');
    assert.equal(await page.locator('#script-state').textContent(), 'Script ready');
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(12, 34, 56)');
    assert.equal(await page.locator('img[alt="Badge"]').evaluate(el => el.complete && el.naturalWidth > 0), true);
    await page.getByRole('link', { name: 'About' }).click();
    assert.equal(new URL(page.url()).pathname, '/about/');
    assert.equal(await page.locator('h1').textContent(), 'About');
    assert.deepEqual(outsideRequests, [], 'deployed pages must make no requests outside their own origin');
    await context.close();
  } finally {
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
