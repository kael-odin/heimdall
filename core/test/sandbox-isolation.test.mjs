import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import { probeFontWoff2 } from './fixtures/probe-font.mjs';
import { certificate, key } from './fixtures/self-signed-certificate.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function startSandbox(t, html) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-sandbox-isolation-'));
  const clone = join(root, 'workspace', 'fixture.test', 'pages', 'home', 'clone');
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, 'index.html'), html);
  const child = spawn(process.execPath, ['src/sandbox/serve.mjs', 'fixture.test', 'home', '--port', '0'], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`sandbox exited: ${output}`);
    const origin = output.match(/\[sandbox\] fixture\.test\/home -> (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    try {
      if (origin) {
        const response = await fetch(`${origin}/api/state`);
        if (response.ok) return { origin, root };
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`sandbox did not start: ${output}`);
}

test('untrusted preview scripts cannot read or overwrite the sandbox editor', { timeout: 30_000 }, async t => {
  let observe;
  const finished = new Promise(resolve => { observe = resolve; });
  const observer = createServer((req, res) => {
    observe(req.url);
    res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
  });
  const observerPort = await listen(observer);
  t.after(() => new Promise(resolve => observer.close(resolve)));
  const html = `<!doctype html><html><body>original<script>
    (async () => {
      let readable = false;
      try { readable = (await fetch('/api/state')).ok; } catch {}
      try { await fetch('/api/save', { method: 'POST', body: JSON.stringify({html:'overwritten'}) }); } catch {}
      await fetch('http://127.0.0.1:${observerPort}/done?readable=' + readable, { mode: 'no-cors' });
    })();
  </script></body></html>`;
  const { origin, root } = await startSandbox(t, html);
  const editor = await fetch(origin);
  assert.equal(editor.headers.get('x-frame-options'), 'DENY');
  assert.equal(editor.headers.get('content-security-policy'), "frame-ancestors 'none'");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  const event = await Promise.race([finished, new Promise((_, reject) => {
    setTimeout(() => reject(new Error('fixture script did not finish')), 10_000).unref();
  })]);
  assert.equal(readFileSync(join(root, 'workspace', 'fixture.test', 'sandbox', 'home', 'sandbox.html'), 'utf8'), html);
  assert.equal(event, '/done?readable=false');
  await page.locator('#html').fill('<!doctype html><title>saved by user</title>');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('已保存'));
  assert.equal(readFileSync(join(root, 'workspace', 'fixture.test', 'sandbox', 'home', 'sandbox.html'), 'utf8'), '<!doctype html><title>saved by user</title>');
});

test('direct clone pages and cross-origin requests cannot access editor writes', { timeout: 30_000 }, async t => {
  const html = `<!doctype html><script>
    (async () => {
      try { window.readable = (await fetch('/api/state')).ok; } catch { window.readable = false; }
      try { await fetch('/api/save', { method: 'POST', body: JSON.stringify({html:'overwritten'}) }); } catch {}
      window.done = true;
    })();
  </script>`;
  const { origin, root } = await startSandbox(t, html);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${origin}/clone/index.html`);
  await page.waitForFunction(() => window.done);
  assert.deepEqual(await page.evaluate(() => [self.origin, window.readable]), ['null', false]);
  const saved = join(root, 'workspace', 'fixture.test', 'sandbox', 'home', 'sandbox.html');
  assert.equal(readFileSync(saved, 'utf8'), html);
  const post = headers => fetch(`${origin}/api/save`, { method: 'POST', headers, body: JSON.stringify({ html: 'forged' }) });
  assert.equal((await post({ 'content-type': 'application/json' })).status, 403);
  assert.equal((await post({ origin: 'null', 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post({ origin: 'http://other.test', 'content-type': 'application/json' })).status, 403);
  assert.equal((await post({ origin, 'content-type': 'text/plain' })).status, 415);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    request(`${origin}/api/state`, { headers: { host: `other.test:${new URL(origin).port}` } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(forgedHostStatus, 421);
  assert.equal(readFileSync(saved, 'utf8'), html);
  assert.equal((await fetch(`${origin}/%zz`)).status, 400);
  assert.equal((await fetch(`${origin}/api/state`)).status, 200);
  const clone = join(root, 'workspace', 'fixture.test', 'pages', 'home', 'clone');
  const sandbox = join(root, 'workspace', 'fixture.test', 'sandbox', 'home');
  writeFileSync(join(sandbox, 'sandbox.css'), 'private fixture');
  writeFileSync(join(clone, 'session.json'), '{"fixture":"private"}');
  symlinkSync(sandbox, join(clone, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fetch(`${origin}/clone/linked/sandbox.css`)).status, 404);
  assert.equal((await fetch(`${origin}/clone/session.json`)).status, 404);
});

test('isolated sandbox previews preserve fonts, masks and screenshot comparison', { timeout: 45_000 }, async t => {
  const html = `<!doctype html><html><head><style>
    @font-face { font-family: Probe; src: url(probe.woff2) format('woff2'); }
    body { margin: 0; } #text { font: 20px/1 Probe, monospace; }
    #mask { width: 40px; height: 40px; background: rgb(255,0,0); mask-image: url(mask.svg); }
  </style></head><body><span id="text">AAAA</span><div id="mask"></div></body></html>`;
  const { origin, root } = await startSandbox(t, html);
  const clone = join(root, 'workspace', 'fixture.test', 'pages', 'home', 'clone');
  writeFileSync(join(clone, 'probe.woff2'), probeFontWoff2());
  writeFileSync(join(clone, 'mask.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  const frame = page.frameLocator('#preview');
  const width = await frame.locator('#text').evaluate(async element => {
    await document.fonts.ready;
    return element.getBoundingClientRect().width;
  });
  assert.equal(width, 80);
  const png = PNG.sync.read(await frame.locator('#mask').screenshot());
  const center = (20 * png.width + 20) * 4;
  assert.deepEqual([...png.data.subarray(center, center + 3)], [255, 0, 0]);
  await page.locator('#diff').click();
  await page.waitForFunction(() => document.querySelector('#score').textContent.startsWith('相似度 '), null, { timeout: 30_000 });
  const score = await fetch(`${origin}/score.json`).then(response => response.json());
  assert.equal(score.score, 1);
});

test('sandbox comparison rejects an observed invalid TLS resource without sending HTTP', { timeout: 45_000 }, async t => {
  let received = 0;
  const https = createHttpsServer({ key, cert: certificate }, (_req, res) => { received++; res.writeHead(204).end(); });
  const httpsPort = await listen(https);
  t.after(() => new Promise(resolve => https.close(resolve)));
  const { origin, root } = await startSandbox(t, `<!doctype html><img src="https://127.0.0.1:${httpsPort}/fixture">`);
  const response = await fetch(`${origin}/api/diff`, { method: 'POST', headers: { origin } });
  const result = await response.json();
  assert.equal(received, 0);
  assert.equal(response.status, 500);
  assert.match(result.error, /certificate|TLS/i);
  const scoreFile = join(root, 'workspace', 'fixture.test', 'sandbox', 'home', 'score.json');
  assert.equal(existsSync(scoreFile), false);
  const previous = JSON.stringify({ score: 0.5, at: 'previous' });
  writeFileSync(scoreFile, previous);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(() => {
    document.querySelector('#score').textContent = '相似度 50.0%';
    document.querySelector('#diffLink').style.display = 'inline';
  });
  await page.locator('#diff').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('对比失败'));
  assert.equal(await page.locator('#score').textContent(), '—');
  assert.equal(await page.locator('#diffLink').isVisible(), false);
  assert.equal(readFileSync(scoreFile, 'utf8'), previous);
  assert.equal(received, 0);
});
