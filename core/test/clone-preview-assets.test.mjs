import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import { startClonePreviewServer } from '../src/clone-preview-server.mjs';
import { probeFontWoff2 } from './fixtures/probe-font.mjs';

function put(root, relative, value) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeClone(clone) {
  put(clone, 'index.html', `<!doctype html><html><head>
    <link rel="stylesheet" href="styles/site.css">
    <link rel="stylesheet" href="styles/shared.css" crossorigin>
    <script>window.dataReadable=fetch('data.json').then(()=>true,()=>false)</script>
    </head><body style="margin:0"><span id="text">AAAA</span><p id="shared">shared</p><div id="mask"></div></body></html>`);
  put(clone, 'styles/site.css', '@font-face{font-family:HeimdallProbe;src:url(probe.woff2) format("woff2")}'
    + '#text{font:20px/1 HeimdallProbe,monospace}'
    + '#mask{position:absolute;left:0;top:100px;width:40px;height:40px;background:rgb(255,0,0);'
    + '-webkit-mask-image:url(../assets/mask.svg);mask-image:url(../assets/mask.svg)}');
  put(clone, 'styles/shared.css', '#shared{color:rgb(1,2,3)}');
  put(clone, 'styles/probe.woff2', probeFontWoff2());
  put(clone, 'assets/mask.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>');
  put(clone, 'data.json', '{"ok":true}');
}

test('clone preview loads web fonts and CSS masks while the clone document stays sandboxed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-preview-assets-'));
  const clone = join(root, 'workspace', 'fixture.test', 'pages', 'home', 'clone');
  writeClone(clone);
  let preview, browser;
  try {
    preview = await startClonePreviewServer({ workspace: join(root, 'workspace') });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await page.goto(preview.urlFor(join(clone, 'index.html')), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const state = await page.evaluate(async () => ({
      origin: self.origin,
      fonts: [...document.fonts].map(face => face.family.replaceAll('"', '') + ':' + face.status),
      textWidth: document.querySelector('#text').getBoundingClientRect().width,
      shared: getComputedStyle(document.querySelector('#shared')).color,
      cssRules: [...document.styleSheets].map(sheet => {
        try { return sheet.cssRules.length; } catch (error) { return error.name; }
      }),
      dataReadable: await window.dataReadable,
    }));
    const png = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 100, width: 40, height: 40 } }));
    const center = (20 * png.width + 20) * 4;
    assert.deepEqual({ ...state, mask: [...png.data.subarray(center, center + 3)] }, {
      // Still an opaque origin: data files stay unreadable, and so do the
      // rules of no-cors stylesheets; only a crossorigin sheet exposes them.
      origin: 'null',
      fonts: ['HeimdallProbe:loaded'],
      textWidth: 80,
      shared: 'rgb(1, 2, 3)',
      cssRules: ['SecurityError', 1],
      dataReadable: false,
      mask: [255, 0, 0],
    });
  } finally {
    await browser?.close();
    await preview?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('clone preview opens CORS only for rendering assets of clones it handed out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-preview-cors-'));
  const workspace = join(root, 'workspace');
  writeClone(join(workspace, 'fixture.test', 'pages', 'home', 'clone'));
  writeClone(join(workspace, 'other.test', 'pages', 'home', 'clone'));
  put(workspace, 'fixture.test/pages/home/shot-src.png', PNG.sync.write(new PNG({ width: 1, height: 1 })));
  let preview;
  try {
    preview = await startClonePreviewServer({ workspace });
    preview.urlFor(join(workspace, 'fixture.test', 'pages', 'home', 'clone', 'index.html'));
    const allowOrigin = async rel => {
      const response = await fetch(`${preview.origin}/static/${rel}`);
      await response.arrayBuffer();
      assert.equal(response.status, 200, rel);
      return response.headers.get('access-control-allow-origin');
    };
    const files = [
      'fixture.test/pages/home/clone/styles/probe.woff2',
      'fixture.test/pages/home/clone/styles/site.css',
      'fixture.test/pages/home/clone/assets/mask.svg',
      'fixture.test/pages/home/clone/index.html',
      'fixture.test/pages/home/clone/data.json',
      'fixture.test/pages/home/shot-src.png',
      'other.test/pages/home/clone/styles/probe.woff2',
    ];
    const headers = [];
    for (const rel of files) headers.push(await allowOrigin(rel));
    assert.deepEqual(headers, ['*', '*', '*', null, null, null, null]);
  } finally {
    await preview?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
