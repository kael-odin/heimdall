import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = join(CORE, 'src', 'engine-server.mjs');
const INDEX_PAGE = join(CORE, 'src', 'crawler', 'index-page.mjs');
const OLD_CHOOSER = '<!doctype html><script>location.replace(innerWidth<=600?"index-375.html":innerWidth<=1100?"index-768.html":"index-1440.html")</script>';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startEngine(dir, port, upstreamPort) {
  const preload = `
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      const target = new URL(String(url));
      return target.hostname === 'fixture.test'
        ? realFetch('http://127.0.0.1:${upstreamPort}' + target.pathname + target.search, options)
        : realFetch(url, options);
    };
  `;
  const proc = spawn(process.execPath,
    ['--import', 'data:text/javascript,' + encodeURIComponent(preload), ENGINE, String(port)], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dir, HEIMDALL_HOST: '127.0.0.1',
        HEIMDALL_TOKEN: '', HEIMDALL_CONSOLE_DIR: '' },
      stdio: 'ignore',
    });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/status')).ok) return { proc, base }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  proc.kill();
  throw new Error('isolated engine did not start');
}

function writeFixture(dir) {
  const site = join(dir, 'workspace', 'fixture.test');
  const put = (path, body) => {
    const file = join(site, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const payload = "window.__onerrorRan=true;fetch('/api/status').then(r=>r.text()).then(v=>window.__apiRead=v).catch(()=>window.__readBlocked=true);fetch('/api/auth/logout',{mode:'no-cors',method:'POST',headers:{'content-type':'text/plain'},body:'logout'}).then(()=>window.__postFinished=true)";
  const evil = `<html><body><h1>Source HTML</h1><img src="/missing.png" onerror="${payload}"></body></html>`;
  put('design/components/source.html', evil);
  put('pages/home/dom.html', evil);
  put('pages/home/clone/index.html', '<!doctype html><script>location.replace(innerWidth<=600?"index-375.html":innerWidth<=1100?"index-768.html":"index-1440.html")</script>');
  put('pages/home/clone/index-375.html', `<html><body><h1>mobile clone</h1><img src="/missing.png" onerror="${payload}"></body></html>`);
  put('pages/home/clone/index-768.html', '<html><body><h1>tablet clone</h1></body></html>');
  put('pages/home/clone/index-1440.html', `<html><body style="height:2500px"><h1>desktop clone</h1><img src="/missing.png" onerror="${payload}"></body></html>`);
  put('pages/home/manifest.json', JSON.stringify({ target: 'https://fixture.test/path?page=2</script><img src=x onerror=window.__reportInjection=true>' }));
  put('pages/home/intel/semantic.json', JSON.stringify({ pageType: '</script><img src=x onerror=window.__reportInjection=true>' }));
  put('pages/tablet/clone/index.html', OLD_CHOOSER);
  put('pages/tablet/clone/index-768.html', '<!doctype html><h1>legacy tablet clone</h1>');
  put('pages/tablet/manifest.json', JSON.stringify({ target: 'https://fixture.test/tablet' }));
  put('assets/evil.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgRan=true"><text y="20">svg</text></svg>');
  put('assets/evil.xml', '<?xml version="1.0"?><root>xml</root>');
  put('assets/evil.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>window.__xhtmlRan=true</script><body>xhtml</body></html>');
  const shot = new PNG({ width: 1440, height: 2200 });
  shot.data.fill(255);
  put('pages/home/shot-src-full.png', PNG.sync.write(shot));
  execFileSync(process.execPath, [INDEX_PAGE, 'fixture.test'], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dir }, stdio: 'ignore',
  });
  return site;
}

test('Chromium isolates workspace and proxy documents while clone viewport and compare still work',
  { timeout: 45_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heimdall-document-isolation-'));
    const site = writeFixture(dir);
    const upstream = createServer((req, res) => {
      if (req.url === '/evil.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<h1>proxied HTML</h1><img src="/missing.png" onerror="window.__pxRan=true">');
      }
      if (req.url === '/evil.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgRan=true"/>');
      }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;
    const port = await freePort();
    let engine, browser;
    try {
      engine = await startEngine(dir, port, upstreamPort);
      const base = engine.base;
      const evidence = { capturedAt: new Date().toISOString(), hostGate: {}, documents: [], downloads: [] };
      const rebinding = async (method) => new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path: '/api/status', method,
          headers: { Host: `attacker.example:${port}` } }, response => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      evidence.hostGate.get = await rebinding('GET');
      evidence.hostGate.post = await rebinding('POST');
      assert.deepEqual([evidence.hostGate.get, evidence.hostGate.post], [421, 421],
        'an arbitrary DNS-rebound Host must not reach the tokenless API');
      evidence.prefix = [];
      for (const path of ['/lm', '/lm/fixture.test/', '/lm//fixture.test/']) {
        const status = (await fetch(base + path)).status;
        assert.equal(status, 410, path);
        evidence.prefix.push({ path, status });
      }
      for (const path of ['/l%6d/fixture.test/', '/lm%2ffixture.test/', '/LM/fixture.test/']) {
        const status = (await fetch(base + path)).status;
        assert.equal(status, 404, path);
        evidence.prefix.push({ path, status });
      }
      const ctx = await (browser = await chromium.launch()).newContext({ viewport: { width: 375, height: 800 }, acceptDownloads: true });
      evidence.chromium = browser.version();
      const page = await ctx.newPage();
      const writes = [];
      page.on('response', response => {
        if (response.url() === base + '/api/auth/logout') writes.push(response.status());
      });
      const component = base + '/static/fixture.test/design/components/source.html';
      for (const path of [component, component + '?compare=1', base + '/fixture.test/design/components/source.html',
        base + '/static/fixture.test/pages/home/dom.html']) {
        await page.goto(path);
        await page.waitForFunction(() => window.__readBlocked && window.__postFinished);
        const origin = await page.evaluate(() => window.origin);
        assert.equal(origin, 'null', path);
        assert.equal(await page.evaluate(() => window.__apiRead), undefined, path);
        evidence.documents.push({ path: new URL(path).pathname + new URL(path).search,
          origin, apiReadBlocked: true, apiPostStatus: writes.at(-1) });
      }
      assert.deepEqual(writes, [403, 403, 403, 403], 'opaque Origin no-cors POST must reach the API and be rejected even without a token');

      const clone = base + '/static/fixture.test/pages/home/clone/index.html';
      await page.goto(clone);
      await page.waitForURL('**/index-375.html');
      assert.equal(await page.locator('h1').textContent(), 'mobile clone');
      await page.waitForFunction(() => window.__readBlocked && window.__postFinished);
      assert.equal(await page.evaluate(() => window.origin), 'null');
      assert.equal(writes.at(-1), 403);
      evidence.clone = { mobileText: 'mobile clone', origin: 'null', apiReadBlocked: true, apiPostStatus: writes.at(-1) };

      const px = base + '/px/fixture.test/evil.html';
      const pxResponse = await page.goto(px);
      assert.equal(await page.locator('h1').textContent(), 'proxied HTML');
      assert.equal(await page.evaluate(() => window.__pxRan), undefined);
      assert.equal(pxResponse.headers()['content-security-policy'], 'sandbox');
      assert.equal(pxResponse.headers()['x-content-type-options'], 'nosniff');
      evidence.proxyHtml = { status: pxResponse.status(), csp: pxResponse.headers()['content-security-policy'], scriptExecuted: false };

      for (const path of ['/static/fixture.test/assets/evil.svg', '/fixture.test/assets/evil.xml',
        '/static/fixture.test/assets/evil.xhtml', '/px/fixture.test/evil.svg']) {
        const response = await fetch(base + path, { headers: { accept: 'text/html' } });
        assert.equal(response.headers.get('content-security-policy'), 'sandbox', path);
        assert.equal(response.headers.get('content-disposition'), 'attachment', path);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
        const downloadPage = await ctx.newPage();
        const download = downloadPage.waitForEvent('download');
        await downloadPage.goto(base + path).catch(() => {});
        assert.ok((await download).suggestedFilename(), path);
        evidence.downloads.push({ path, csp: 'sandbox', disposition: 'attachment' });
        await downloadPage.close();
      }

      await page.setViewportSize({ width: 1440, height: 800 });
      await page.goto(base + '/static/fixture.test/index.html');
      await page.locator('.cmp[data-p="home"]').click();
      await page.waitForURL('**/compare.html?p=home');
      const frame = page.frameLocator('#frame');
      await frame.locator('h1').waitFor();
      assert.equal(await frame.locator('h1').textContent(), 'desktop clone');
      assert.equal(await frame.locator('body').evaluate(() => window.__onerrorRan), undefined,
        'compare exception must not execute clone event handlers');
      assert.equal(await page.evaluate(() => !!document.getElementById('frame').contentDocument), true);
      assert.equal(await page.evaluate(() => window.__reportInjection), undefined);
      const interactiveHref = await page.locator('#inter').getAttribute('href');
      assert.equal(new URL(interactiveHref).pathname, '/api/mirror-launch');
      assert.equal(new URL(new URL(interactiveHref).searchParams.get('url')).searchParams.get('page').startsWith('2</script>'), true,
        'compare mirror link must retain its source query');
      await page.waitForTimeout(220);
      const geometry = await page.evaluate(() => {
        const left = document.getElementById('left');
        const doc = document.getElementById('frame').contentDocument.scrollingElement;
        return { leftMax: left.scrollHeight - left.clientHeight, frameMax: doc.scrollHeight - doc.clientHeight };
      });
      assert.ok(geometry.leftMax > 250 && geometry.frameMax > 500, JSON.stringify(geometry));
      await page.evaluate(() => { document.getElementById('left').scrollTop = 250; });
      await page.waitForFunction(() => document.getElementById('frame').contentDocument.scrollingElement.scrollTop > 0);
      await page.waitForTimeout(220);
      await page.evaluate(() => {
        document.getElementById('frame').contentDocument.scrollingElement.scrollTop = 50;
      });
      await page.waitForFunction(() => document.getElementById('left').scrollTop < 250);
      evidence.compare = { iframeSameOrigin: true, cloneScriptExecuted: false,
        leftToRightScroll: true, rightToLeftScroll: true, queryPreserved: true, injectedScriptExecuted: false };

      const fallbackPath = '/static/fixture.test/pages/tablet/clone/index.html?compare=1';
      const fallbackResponse = await fetch(base + fallbackPath);
      assert.equal(fallbackResponse.status, 200);
      assert.match(fallbackResponse.headers.get('content-security-policy') ?? '', /script-src 'none'/);
      assert.match(await fallbackResponse.text(), /legacy tablet clone/);
      await page.goto(base + '/static/fixture.test/compare.html?p=tablet');
      assert.equal(await page.frameLocator('#frame').locator('h1').textContent(), 'legacy tablet clone');
      assert.equal(readFileSync(join(site, 'pages', 'tablet', 'clone', 'index.html'), 'utf8'), OLD_CHOOSER,
        'workspace chooser remains untouched');
      evidence.compareFallback = { path: fallbackPath, selected: 'index-768.html', status: 200,
        scriptBlocked: true, browserText: 'legacy tablet clone', workspaceUnchanged: true };

      const compareFile = join(site, 'compare.html');
      writeFileSync(compareFile, readFileSync(compareFile, 'utf8').replace('/clone/index.html?compare=1', '/clone/index.html'));
      const legacy = await fetch(base + '/static/fixture.test/compare.html');
      assert.match(await legacy.text(), /clone\/index\.html\?compare=1/, 'legacy report gets the safe same-origin compare view');
      evidence.legacyCompareQueryRewritten = true;
      const evidencePath = process.env.HEIMDALL_SECURITY_EVIDENCE_FILE;
      if (evidencePath) {
        mkdirSync(dirname(evidencePath), { recursive: true });
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
      }
    } finally {
      await browser?.close();
      if (engine && engine.proc.exitCode === null) {
        engine.proc.kill();
        await new Promise(resolve => engine.proc.once('exit', resolve));
      }
      await new Promise(resolve => upstream.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
