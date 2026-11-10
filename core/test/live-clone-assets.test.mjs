import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { startClonePreviewServer } from '../src/clone-preview-server.mjs';
import { probeFontWoff2 } from './fixtures/probe-font.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const HOST = 'fixture.test';

function put(root, name, content) {
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('exported static clones render fonts and masks without exposing other content', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-live-clone-assets-'));
  const site = join(root, 'workspace', HOST);
  const clone = join(site, 'pages', 'home', 'clone');
  const out = join(root, 'deliverable', 'bundle');
  let server, browser, preview;
  try {
    put(site, 'pages/home/manifest.json', JSON.stringify({ target: `https://${HOST}/` }));
    put(site, 'live/index.html', '<!doctype html><title>Live fixture</title>');
    put(site, 'live/style.css', 'body{color:blue}');
    put(clone, 'index.html', `<!doctype html><html><head>
      <link rel="stylesheet" href="styles/site.css">
      <link rel="stylesheet" href="styles/shared.css" crossorigin>
      </head><body style="margin:0"><span id="text">AAAA</span><p id="shared">shared</p><div id="mask"></div></body></html>`);
    put(clone, 'styles/site.css', '@font-face{font-family:HeimdallProbe;src:url(probe.woff2) format("woff2")}'
      + '#text{font:20px/1 HeimdallProbe,monospace}'
      + '#mask{position:absolute;left:0;top:100px;width:40px;height:40px;background:rgb(255,0,0);'
      + '-webkit-mask-image:url(../assets/mask.svg);mask-image:url(../assets/mask.svg)}');
    put(clone, 'styles/shared.css', '#shared{color:rgb(1,2,3)}');
    put(clone, 'styles/probe.woff2', probeFontWoff2());
    put(clone, 'assets/mask.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>');
    put(clone, 'data.json', '{"private":"fixture"}');
    put(clone, 'app.js', 'window.fixture = true');
    put(site, 'pages/home/intel/report.css', 'body{color:red}');
    const result = spawnSync(process.execPath, [join(CORE, 'src/live/export.mjs'), HOST, '--offline', '--out', out], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 45_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(out, 'serve.mjs'), '--port', String(port), '--host', '127.0.0.1'],
      { cwd: out, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`bundle server exited: ${server.exitCode}`);
      try { if ((await fetch(base + '/__heimdall/health')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const prefix = `/static/${HOST}/pages/home/clone/`;
    await page.goto(base + prefix + 'index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const state = await page.evaluate(async () => ({
      origin: self.origin,
      fonts: [...document.fonts].map(face => face.family.replaceAll('"', '') + ':' + face.status),
      textWidth: document.querySelector('#text').getBoundingClientRect().width,
      shared: getComputedStyle(document.querySelector('#shared')).color,
      dataReadable: await fetch('data.json').then(() => true, () => false),
    }));
    const screenshot = await page.screenshot();
    const png = PNG.sync.read(screenshot);
    const center = (120 * png.width + 20) * 4;
    const observed = { ...state, mask: [...png.data.subarray(center, center + 3)] };
    preview = await startClonePreviewServer({ workspace: join(root, 'workspace') });
    await page.goto(preview.urlFor(join(clone, 'index.html')), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const previewScreenshot = await page.screenshot();
    if (process.env.HEIMDALL_AUDIT_EVIDENCE_DIR) {
      const dir = process.env.HEIMDALL_AUDIT_EVIDENCE_DIR;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'bundle-clone-assets.png'), screenshot);
      writeFileSync(join(dir, 'preview-clone-assets.png'), previewScreenshot);
      writeFileSync(join(dir, 'bundle-clone-assets.json'), JSON.stringify(observed, null, 2));
    }
    assert.deepEqual(observed, {
      origin: 'null', fonts: ['HeimdallProbe:loaded'], textWidth: 80,
      shared: 'rgb(1, 2, 3)', dataReadable: false, mask: [255, 0, 0],
    });
    assert.deepEqual(screenshot, previewScreenshot, 'the exported clone matches the verifier preview');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + prefix + 'index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const desktopScreenshot = await page.screenshot();
    await page.goto(preview.urlFor(join(clone, 'index.html')), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(desktopScreenshot, await page.screenshot(), 'desktop export matches the verifier preview');

    for (const [path, expected] of [
      [prefix + 'styles/probe.woff2', '*'],
      [prefix + 'styles/shared.css', '*'],
      [prefix + 'assets/mask.svg', '*'],
      [prefix + 'index.html', null],
      [prefix + 'app.js', null],
      [prefix + 'data.json', null],
      [`/static/${HOST}/pages/home/intel/report.css`, null],
      [prefix + '..%2Fintel/report.css', null],
      [`/lm/${HOST}/style.css`, null],
    ]) {
      const response = await fetch(base + path, { headers: { origin: 'https://other.example' } });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('access-control-allow-origin'), expected, path);
    }
    const svg = await fetch(base + prefix + 'assets/mask.svg', { headers: { 'sec-fetch-dest': 'document' } });
    assert.equal(svg.headers.get('content-security-policy'), 'sandbox');
    assert.equal(svg.headers.get('content-disposition'), 'attachment');
    await t.test('a link outside clone assets does not gain cross-origin access', async t => {
      put(root, 'outside/private.css', 'private fixture');
      const linked = join(out, 'site', 'static', HOST, 'pages', 'home', 'clone', 'linked');
      try { symlinkSync(join(root, 'outside'), linked, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('directory links unavailable');
        throw error;
      }
      const response = await fetch(base + prefix + 'linked/private.css', { headers: { origin: 'https://other.example' } });
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    });
  } finally {
    await browser?.close();
    await preview?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
