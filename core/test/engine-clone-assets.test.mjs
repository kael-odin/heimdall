import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { probeFontWoff2 } from './fixtures/probe-font.mjs';

const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));
const CORE = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('engine static clone previews load local fonts and masks with scoped asset CORS', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-engine-clone-assets-'));
  const clone = join(root, 'workspace', 'fixture.test', 'pages', 'home', 'clone');
  mkdirSync(join(clone, 'styles'), { recursive: true });
  mkdirSync(join(clone, 'assets'), { recursive: true });
  writeFileSync(join(clone, 'index.html'), `<!doctype html><html><head>
    <link rel="stylesheet" href="styles/site.css">
    <script>window.dataReadable=fetch('data.json').then(()=>true,()=>false)</script>
    </head><body><span id="text">AAAA</span><div id="mask"></div></body></html>`);
  writeFileSync(join(clone, 'styles', 'site.css'), '@font-face{font-family:HeimdallProbe;src:url(probe.woff2) format("woff2")}'
    + '#text{font:20px/1 HeimdallProbe,monospace}'
    + '#mask{width:40px;height:40px;background:rgb(255,0,0);-webkit-mask-image:url(../assets/mask.svg);mask-image:url(../assets/mask.svg)}');
  writeFileSync(join(clone, 'styles', 'probe.woff2'), probeFontWoff2());
  writeFileSync(join(clone, 'assets', 'mask.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>');
  writeFileSync(join(clone, 'data.json'), '{"ok":true}');
  const port = await freePort();
  const engine = spawn(process.execPath, [ENGINE, String(port)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: '' },
    stdio: 'ignore',
  });
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(base + '/api/status')).ok) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await page.goto(base + '/static/fixture.test/pages/home/clone/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const state = await page.evaluate(async () => ({
      origin: self.origin,
      fonts: [...document.fonts].map(face => face.family.replaceAll('"', '') + ':' + face.status),
      textWidth: document.querySelector('#text').getBoundingClientRect().width,
      mask: getComputedStyle(document.querySelector('#mask')).webkitMaskImage,
      dataReadable: await window.dataReadable,
    }));
    assert.deepEqual(state, {
      origin: 'null',
      fonts: ['HeimdallProbe:loaded'],
      textWidth: 80,
      mask: 'url("http://127.0.0.1:' + port + '/static/fixture.test/pages/home/clone/assets/mask.svg")',
      dataReadable: false,
    });
    const asset = await fetch(base + '/static/fixture.test/pages/home/clone/styles/probe.woff2', { headers: { origin: 'null' } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('access-control-allow-origin'), '*');
    const html = await fetch(base + '/static/fixture.test/pages/home/clone/index.html', { headers: { origin: 'null' } });
    assert.equal(html.headers.get('access-control-allow-origin'), null);
    const data = await fetch(base + '/static/fixture.test/pages/home/clone/data.json', { headers: { origin: 'null' } });
    assert.equal(data.headers.get('access-control-allow-origin'), null);
  } finally {
    await browser?.close();
    engine.kill();
    await new Promise(resolve => engine.once('exit', resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
