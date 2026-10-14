import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const BUILD_CLONE = join(CORE, 'src', 'crawler', 'build_clone.mjs');
const INDEX_PAGE = join(CORE, 'src', 'crawler', 'index-page.mjs');
const EXPORT = join(CORE, 'src', 'live', 'export.mjs');
const HOST = 'fixture.test';
const EVIDENCE_DIR = process.env.HEIMDALL_AUDIT_EVIDENCE_DIR;

const sourceHtml = (label) => `<!doctype html><html><head>
  <title>${label}</title><meta http-equiv="refresh" content="0;url=https://fixture.test/escape">
  </head><body><h1>${label}</h1>
  <img id="broken" src="missing.png" onerror="window.__cloneRan=true">
  <svg onload="window.__svgRan=true"><a xlink:href="java&#x73;cript:window.__svgLinkRan=true">SVG link</a></svg>
  <a id="active-link" href="java&#x73;cript:window.__linkRan=true">Active link</a>
  <iframe id="embedded" sandbox="allow-scripts allow-same-origin" srcdoc="&lt;script&gt;parent.__frameRan=true&lt;/script&gt;"></iframe>
  <canvas data-heimdall-canvas="0" onerror="window.__canvasRan=true"></canvas>
  <mux-player poster="poster.png" onerror="window.__mediaRan=true"></mux-player>
  <script>window.__scriptRan=true</script>
  </body></html>`;

function put(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function run(script, args, dataRoot) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot },
    encoding: 'utf8', timeout: 45_000,
  });
  assert.equal(result.status, 0, `${script} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

function writeCapture(site, name, label, { variants = [] } = {}) {
  const page = join(site, 'pages', name);
  put(page, 'manifest.json', JSON.stringify({ target: `https://${HOST}/${name === 'single' ? '' : name}` }));
  put(page, 'dom.html', sourceHtml(label));
  put(page, 'cssom.css', 'body{color:#123456}');
  put(page, 'cssom-refs.json', JSON.stringify({ origin: `https://${HOST}`, refs: [], refMap: {}, sheets: [] }));
  put(page, 'asset-map.json', JSON.stringify({ imgMap: {}, resMap: {}, imgs: [], css: [] }));
  if (variants) {
    for (const width of variants === true ? [375, 768] : variants) {
      put(page, `dom-${width}.html`, sourceHtml(`${label} ${width}`));
      put(page, `cssom-${width}.css`, 'body{color:#123456}');
      put(page, `cssom-refs-${width}.json`, JSON.stringify({ origin: `https://${HOST}`, refs: [], refMap: {} }));
    }
  }
  return page;
}

function assertStaticDocument(html, { expectIframe = true } = {}) {
  assert.match(html, /<h1>/i, 'the captured content remains visible');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'event handler attributes are removed');
  assert.doesNotMatch(html, /\bsrcdoc\s*=/i, 'iframe srcdoc is removed');
  assert.doesNotMatch(html, /javascript\s*:/i, 'entity-encoded javascript URLs are removed');
  assert.doesNotMatch(html, /<script\b/i, 'source scripts are removed');
  assert.doesNotMatch(html, /http-equiv\s*=\s*["']?refresh/i, 'meta refresh is removed');
  if (expectIframe) assert.match(html, /<iframe\b[^>]*\bsandbox=""/i,
    'retained iframe has a restrictive sandbox');
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`bundle server exited with ${child.exitCode}`);
    try { if ((await fetch(base + '/__heimdall/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('bundle server did not start');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exited;
}

test('static clone build and offline export isolate source HTML while live HAR replay remains interactive',
  { timeout: 120_000 }, async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-static-clone-'));
    const site = join(dataRoot, 'workspace', HOST);
    const out = join(dataRoot, 'deliverable', 'isolated-bundle');
    let child, browser;
    try {
      const single = writeCapture(site, 'single', 'Single clone');
      const responsive = writeCapture(site, 'responsive', 'Responsive clone', { variants: true });
      const mobileOnly = writeCapture(site, 'mobile-only', 'Mobile only', { variants: [375] });
      const tabletOnly = writeCapture(site, 'tablet-only', 'Tablet only', { variants: [768] });
      run(BUILD_CLONE, [single], dataRoot);
      run(BUILD_CLONE, [responsive], dataRoot);
      run(BUILD_CLONE, [mobileOnly], dataRoot);
      run(BUILD_CLONE, [tabletOnly], dataRoot);

      assertStaticDocument(readFileSync(join(single, 'clone', 'index.html'), 'utf8'));
      for (const width of [375, 768, 1440]) {
        assertStaticDocument(readFileSync(join(responsive, 'clone', `index-${width}.html`), 'utf8'));
      }
      const chooser = readFileSync(join(responsive, 'clone', 'index.html'), 'utf8');
      assert.match(chooser, /<script>location\.replace\(innerWidth<=600\?/,
        'the trusted viewport chooser remains executable');
      const tamperedChooser = chooser.replace('</head>', '<script>window.__tamperedChooserRan=true</script></head>');
      writeFileSync(join(responsive, 'clone', 'index.html'), tamperedChooser);
      const mobileChooser = readFileSync(join(mobileOnly, 'clone', 'index.html'), 'utf8');
      assert.doesNotMatch(mobileChooser, /index-768\.html/);
      const tabletChooser = readFileSync(join(tabletOnly, 'clone', 'index.html'), 'utf8');
      assert.doesNotMatch(tabletChooser, /index-375\.html/);
      assert.match(readFileSync(join(single, 'dom.html'), 'utf8'), /onerror=/,
        'captured source DOM remains untouched');

      put(single, 'intel/semantic.json', JSON.stringify({ pageType: '</script><img src=x onerror=window.__reportInjection=true>' }));
      put(single, 'manifest.json', JSON.stringify({ target: `https://${HOST}/single?page=2</script><img src=x onerror=window.__reportInjection=true>` }));

      const legacy = join(site, 'pages', 'legacy');
      put(legacy, 'manifest.json', JSON.stringify({ target: `https://${HOST}/legacy` }));
      const legacyHtml = '<!doctype html><html><body><h1>Legacy clone</h1><img src="missing.png" onerror="window.__legacyRan=true"></body></html>';
      put(legacy, 'clone/index.html', legacyHtml);
      const oldTablet = join(site, 'pages', 'old-tablet');
      put(oldTablet, 'manifest.json', JSON.stringify({ target: `https://${HOST}/old-tablet` }));
      const oldChooser = '<!doctype html><script>location.replace(innerWidth<=600?"index-375.html":innerWidth<=1100?"index-768.html":"index-1440.html")</script>';
      put(oldTablet, 'clone/index.html', oldChooser);
      put(oldTablet, 'clone/index-768.html', '<!doctype html><h1>Old tablet only</h1>');
      const stale = join(site, 'pages', 'stale-variant');
      put(stale, 'manifest.json', JSON.stringify({ target: `https://${HOST}/stale-variant` }));
      put(stale, 'clone/index.html', '<!doctype html><h1>Current full document</h1>');
      put(stale, 'clone/index-375.html', '<!doctype html><h1>Stale mobile document</h1>');
      put(site, 'live/index.html', '<!doctype html><html><body><h1>Interactive live</h1><button id="load">Load private JSON</button><output id="result"></output><script>document.querySelector("#load").onclick=async()=>{const r=await fetch("/lm/fixture.test/api/private");document.querySelector("#result").textContent=(await r.json()).value}</script></body></html>');
      const privateBody = JSON.stringify({ value: 'fixture-private-value' });
      put(single, 'network.har', JSON.stringify({ log: { entries: [{
        request: { method: 'GET', url: `https://${HOST}/api/private`, headers: [], cookies: [] },
        response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }],
          content: { mimeType: 'application/json', text: privateBody } },
      }] } }));

      run(INDEX_PAGE, [HOST], dataRoot);
      const comparePath = join(site, 'compare.html');
      const legacyCompare = readFileSync(comparePath, 'utf8')
        .replaceAll('\\u003c', '<').replaceAll('\\u003e', '>').replace(/\r?\n/g, '\r\n');
      assert.match(legacyCompare, /<\/script><img src=x onerror=/);
      writeFileSync(comparePath, legacyCompare);

      run(EXPORT, [HOST, '--offline', '--include-api-har', '--out', out], dataRoot);
      assert.equal(readFileSync(join(legacy, 'clone', 'index.html'), 'utf8'), legacyHtml,
        'export never modifies the workspace source');
      assert.equal(readFileSync(join(oldTablet, 'clone', 'index.html'), 'utf8'), oldChooser,
        'export does not rewrite the old chooser in the workspace');
      const exportedLegacy = readFileSync(join(out, 'site', 'static', HOST, 'pages', 'legacy', 'clone', 'index.html'), 'utf8');
      assertStaticDocument(exportedLegacy, { expectIframe: false });
      assert.match(exportedLegacy, /Legacy clone/);
      const exportedChooser = readFileSync(join(out, 'site', 'static', HOST, 'pages', 'responsive', 'clone', 'index.html'), 'utf8');
      assert.match(exportedChooser,
        /<script>location\.replace\(innerWidth<=600\?/,
        'export preserves the responsive chooser');
      assert.doesNotMatch(exportedChooser, /__tamperedChooserRan/,
        'export reconstructs rather than copying the historical chooser');
      assert.equal(readFileSync(join(responsive, 'clone', 'index.html'), 'utf8'), tamperedChooser);
      const bundledOldChooser = readFileSync(join(out, 'site', 'static', HOST, 'pages', 'old-tablet', 'clone', 'index.html'), 'utf8');
      assert.doesNotMatch(bundledOldChooser, /index-(?:375|1440)\.html/);
      assert.match(bundledOldChooser, /index-768\.html/);
      const bundledFullDocument = readFileSync(join(out, 'site', 'static', HOST, 'pages', 'stale-variant', 'clone', 'index.html'), 'utf8');
      assert.match(bundledFullDocument, /Current full document/);
      assert.doesNotMatch(bundledFullDocument, /location\.replace/);
      const exportedCompare = readFileSync(join(out, 'site', 'static', HOST, 'compare.html'), 'utf8');
      assert.doesNotMatch(exportedCompare, /<\/script><img src=x onerror=/,
        'old compare metadata is rebuilt in the candidate bundle');
      assert.equal(readFileSync(comparePath, 'utf8'), legacyCompare,
        'historical compare report remains untouched');
      const har = JSON.parse(readFileSync(join(out, 'har.json'), 'utf8'));
      const privateEntry = har.entries.find(e => e.url === `https://${HOST}/api/private`);
      assert.equal(Buffer.from(privateEntry?.body ?? '', 'base64').toString('utf8'), privateBody,
        'the fixture contains an intentionally replayable private JSON body');

      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, [join(out, 'serve.mjs'), '--port', String(port), '--host', '127.0.0.1'],
        { cwd: out, stdio: 'ignore' });
      await waitForServer(base, child);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
      const missingVariants = [];
      const pageErrors = [];
      page.on('response', response => {
        if (/\/clone\/index-(?:375|768|1440)\.html/.test(response.url()) && response.status() >= 400) {
          missingVariants.push({ url: response.url(), status: response.status() });
        }
      });
      page.on('pageerror', error => pageErrors.push(error.message));

      const oldCloneUrl = `${base}/static/${HOST}/pages/legacy/clone/index.html`;
      const oldCloneResponse = await page.goto(oldCloneUrl);
      assert.equal(oldCloneResponse.status(), 200);
      assert.match(oldCloneResponse.headers()['content-security-policy'] ?? '', /\bsandbox\b/,
        'packaged static HTML has an opaque-origin sandbox');
      assert.equal(await page.evaluate(() => window.origin), 'null');
      assert.equal(await page.evaluate(() => window.__legacyRan), undefined);
      const privateRead = await page.evaluate(async () => {
        try {
          const response = await fetch('/lm/fixture.test/api/private');
          return { readable: true, body: await response.text() };
        } catch { return { readable: false }; }
      });
      assert.deepEqual(privateRead, { readable: false }, 'a static clone cannot read same-server HAR data');

      await page.goto(pathToFileURL(join(out, 'site', 'static', HOST, 'pages', 'legacy', 'clone', 'index.html')).href);
      assert.equal(await page.evaluate(() => window.__legacyRan), undefined,
        'the exported clone is safe when opened directly from disk');

      await page.goto(`${base}/static/${HOST}/pages/responsive/clone/index.html`);
      await page.waitForURL('**/index-375.html');
      assert.equal(await page.locator('h1').textContent(), 'Responsive clone 375');
      assert.equal(await page.evaluate(() => window.origin), 'null');
      assert.equal(await page.evaluate(() => window.__cloneRan), undefined);
      assert.equal(await page.evaluate(() => window.__tamperedChooserRan), undefined);

      await page.goto(pathToFileURL(join(mobileOnly, 'clone', 'index.html')).href);
      await page.waitForURL('**/index-375.html');
      assert.equal(await page.locator('h1').textContent(), 'Mobile only 375');
      await page.setViewportSize({ width: 900, height: 800 });
      await page.goto(pathToFileURL(join(mobileOnly, 'clone', 'index.html')).href);
      await page.waitForURL('**/index-1440.html');
      assert.equal(await page.locator('h1').textContent(), 'Mobile only');
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(pathToFileURL(join(tabletOnly, 'clone', 'index.html')).href);
      await page.waitForURL('**/index-768.html');
      assert.equal(await page.locator('h1').textContent(), 'Tablet only 768');
      await page.setViewportSize({ width: 900, height: 800 });
      await page.goto(pathToFileURL(join(tabletOnly, 'clone', 'index.html')).href);
      await page.waitForURL('**/index-768.html');
      assert.equal(await page.locator('h1').textContent(), 'Tablet only 768');
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.goto(pathToFileURL(join(out, 'site', 'static', HOST, 'pages', 'old-tablet', 'clone', 'index.html')).href);
      await page.waitForURL('**/index-768.html');
      assert.equal(await page.locator('h1').textContent(), 'Old tablet only');
      const screenshotBytes = await page.screenshot();
      const screenshot = PNG.sync.read(screenshotBytes);
      assert.equal(screenshot.width, 1440);
      assert.ok(screenshot.data.some((value, index) => index % 4 !== 3 && value < 240),
        'the fallback variant renders nonblank pixels');
      if (EVIDENCE_DIR) {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(join(EVIDENCE_DIR, 'chooser-old-tablet-export-1440.png'), screenshotBytes);
      }
      await page.goto(`${base}/static/${HOST}/pages/old-tablet/clone/index.html`);
      await page.waitForURL('**/index-768.html');
      assert.equal(await page.locator('h1').textContent(), 'Old tablet only');
      if (EVIDENCE_DIR) {
        writeFileSync(join(EVIDENCE_DIR, 'chooser-old-tablet-engine-1440.png'), await page.screenshot());
        writeFileSync(join(EVIDENCE_DIR, 'chooser-old-tablet.json'), JSON.stringify({
          capturedAt: new Date().toISOString(), viewport: { width: 1440, height: 800 },
          sourceVariants: [768], selectedVariant: 'index-768.html',
          exportRendered: true, engineRendered: true, nonblankPixels: true,
        }, null, 2));
      }

      await page.goto(`${base}/static/${HOST}/compare.html?p=single`);
      assert.equal(await page.locator('#sel option').count(), 7,
        'the CRLF historical compare script receives a nonce and still runs');
      const frame = page.frameLocator('#frame');
      await frame.locator('h1').waitFor();
      assert.equal(await frame.locator('h1').textContent(), 'Single clone');
      assert.equal(await page.evaluate(() => !!document.getElementById('frame').contentDocument), true,
        'the compare report can read its script-free iframe for scroll sync');
      assert.equal(await page.evaluate(() => window.__reportInjection), undefined);
      await page.goto(`${base}/static/${HOST}/compare.html?p=old-tablet`);
      assert.equal(await page.frameLocator('#frame').locator('h1').textContent(), 'Old tablet only',
        'comparison view opens the available old variant with scripts disabled');
      await page.goto(`${base}/static/${HOST}/compare.html?p=stale-variant`);
      assert.equal(await page.frameLocator('#frame').locator('h1').textContent(), 'Current full document',
        'comparison view ignores old variants when index.html is a full document');

      await page.goto(`${base}/lm/${HOST}/`);
      assert.equal(await page.locator('h1').textContent(), 'Interactive live');
      await page.getByRole('button', { name: 'Load private JSON' }).click();
      await page.waitForFunction(() => document.querySelector('#result')?.textContent === 'fixture-private-value');
      assert.equal(await page.locator('#result').textContent(), 'fixture-private-value',
        'the trusted live snapshot can execute script and use HAR replay');
      assert.deepEqual(missingVariants, [], 'no chooser requested an absent variant');
      assert.deepEqual(pageErrors, [], 'the browser saw no uncaught document errors');
    } finally {
      await browser?.close();
      await stopChild(child);
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
