import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import { resolveCloneUrl } from '../src/clone-doc.mjs';
import { startClonePreviewServer } from '../src/clone-preview-server.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const SHOT = join(CORE, 'src', 'crawler', 'shot_clone.mjs');
const VERIFY = join(CORE, 'src', 'verify', 'verify.mjs');
const ENGINE = join(CORE, 'src', 'engine-server.mjs');

function run(script, args, env, timeout = 40_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: CORE, env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${output}`)); }, timeout);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startAlienEngine(dataRoot) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [ENGINE, String(port)], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_LLM: '0', HEIMDALL_TOKEN: '' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`alien engine exited: ${output}`);
    try { if ((await fetch(base + '/api/status')).ok) return { child, base, port }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`alien engine did not start: ${output}`);
}

async function stopServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('shot and verify use the current isolated workspace when another engine owns the port', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-clone-root-'));
  const current = join(root, 'current');
  const alien = join(root, 'alien');
  const page = join(current, 'workspace', 'fixture.test', 'pages', 'home');
  const clone = join(page, 'clone');
  const html = '<!doctype html><html><body style="margin:0;background:rgb(0,128,0)"><main style="height:800px"></main></body></html>';
  mkdirSync(clone, { recursive: true });
  mkdirSync(alien, { recursive: true });
  writeFileSync(join(clone, 'index.html'), '<!doctype html><html><head><script>location.replace(innerWidth<=600?"index-375.html":"index-1440.html")</script></head></html>');
  writeFileSync(join(clone, 'index-375.html'), html);
  writeFileSync(join(clone, 'index-1440.html'), html);
  const source = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  let wrong;
  try {
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    const sourceUrl = `http://127.0.0.1:${source.address().port}/`;
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: sourceUrl }));
    wrong = await startAlienEngine(alien);
    const alienClone = `${wrong.base}/static/fixture.test/pages/home/clone/index.html`;
    const alienResponse = await fetch(alienClone);
    assert.equal(alienResponse.status, 404);
    assert.deepEqual(await alienResponse.json(), { error: 'nf' });

    const resolved = await resolveCloneUrl('fixture.test', 'home', page);
    assert.equal(resolved.via, 'local');
    assert.equal(resolved.url, pathToFileURL(join(clone, 'index.html')).href);
    const env = { HEIMDALL_DATA_DIR: current, HEIMDALL_PORT: String(wrong.port), HEIMDALL_LLM: '0' };
    const shotPath = join(page, 'shot-clone.png');
    const shot = await run(SHOT, [resolved.url, shotPath], env);
    assert.equal(shot.code, 0, shot.output);
    const png = PNG.sync.read(readFileSync(shotPath));
    const center = (450 * png.width + 700) * 4;
    assert.deepEqual([...png.data.subarray(center, center + 3)], [0, 128, 0]);

    const verify = await run(VERIFY, ['fixture.test', 'home', '--no-interactions', '--keep-screenshots', '--viewports', '320x240'], env);
    assert.equal(verify.code, 0, verify.output);
    const result = JSON.parse(readFileSync(join(current, 'workspace', 'fixture.test', 'verify', 'home', 'verify.json'), 'utf8'));
    assert.equal(result.measured, true);
    assert.equal(result.viewports[0].score, 1);
    assert.ok(result.viewports[0].cloneCapture.finalUrl.startsWith('http://127.0.0.1:'));
    assert.ok(!result.viewports[0].cloneCapture.finalUrl.startsWith(wrong.base));
    assert.match(result.viewports[0].cloneCapture.finalUrl, /index-375\.html$/);
  } finally {
    if (wrong) {
      wrong.child.kill();
      await new Promise(resolve => wrong.child.once('close', resolve));
    }
    if (source.listening) await stopServer(source);
    rmSync(root, { recursive: true, force: true });
  }
});

test('shot rejects HTTP error and JSON document responses without creating screenshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-shot-error-'));
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/missing' ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end('{"error":"nf"}');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['missing', 'soft-error']) {
      const out = join(root, route + '.png');
      const result = await run(SHOT, [base + '/' + route, out], { HEIMDALL_LLM: '0' });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /clone document is not local HTML/);
      assert.equal(existsSync(out), false);
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('clone preview and engine static route apply the same sandbox to modules, fetch, CSS, and images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-preview-csp-'));
  const clone = join(root, 'workspace', 'fixture.test', 'pages', 'home', 'clone');
  mkdirSync(clone, { recursive: true });
  const fixture = new Map([
    ['index.html', `<!doctype html><html><head>
      <link rel="stylesheet" href="style.css">
      <script>window.probe={module:false,fetch:null};fetch('data.json').then(r=>r.json()).then(()=>probe.fetch=true).catch(()=>probe.fetch=false)</script>
      <script type="module" src="app.mjs"></script>
      </head><body><div id="target">SPA probe</div><img id="image" src="image.png"></body></html>`],
    ['style.css', '#target{background-color:rgb(23,45,67)}'],
    ['app.mjs', 'window.probe.module=true'],
    ['data.json', '{"ok":true}'],
  ]);
  for (const [name, body] of fixture) writeFileSync(join(clone, name), body);
  const png = new PNG({ width: 1, height: 1 });
  png.data.set([255, 0, 0, 255]);
  writeFileSync(join(clone, 'image.png'), PNG.sync.write(png));
  const baseline = createServer((req, res) => {
    const name = req.url?.slice(1) || 'index.html';
    const body = name === 'image.png' ? readFileSync(join(clone, name)) : fixture.get(name);
    if (!body) { res.writeHead(404); res.end(); return; }
    const mime = name.endsWith('.html') ? 'text/html' : name.endsWith('.mjs') ? 'text/javascript'
      : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'image/png';
    res.writeHead(200, { 'Content-Type': mime }); res.end(body);
  });
  let engine, preview, browser;
  try {
    await new Promise(resolve => baseline.listen(0, '127.0.0.1', resolve));
    engine = await startAlienEngine(root);
    preview = await startClonePreviewServer({ workspace: join(root, 'workspace') });
    browser = await chromium.launch();
    async function inspect(url) {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => window.probe?.fetch !== null);
        return await page.evaluate(() => ({
          module: window.probe.module,
          fetch: window.probe.fetch,
          css: getComputedStyle(document.querySelector('#target')).backgroundColor,
          image: document.querySelector('#image').naturalWidth,
        }));
      } finally { await page.close(); }
    }
    const path = '/static/fixture.test/pages/home/clone/index.html';
    const baselineState = await inspect(`http://127.0.0.1:${baseline.address().port}/index.html`);
    const engineState = await inspect(engine.base + path);
    const previewState = await inspect(preview.urlFor(join(clone, 'index.html')));
    assert.deepEqual(baselineState, { module: true, fetch: true, css: 'rgb(23, 45, 67)', image: 1 });
    assert.deepEqual(previewState, engineState);
    assert.deepEqual(previewState, { module: false, fetch: false, css: 'rgb(23, 45, 67)', image: 1 });
  } finally {
    await browser?.close();
    await preview?.close();
    if (engine) {
      engine.child.kill();
      await new Promise(resolve => engine.child.once('close', resolve));
    }
    if (baseline.listening) await stopServer(baseline);
    rmSync(root, { recursive: true, force: true });
  }
});
