/**
 * 正式基线供给与体检（E7-19）：服务的边界、清洗规则、三种状态
 *
 * 用临时数据根搭镜像；浏览器用本机 Chromium。blocked 用页内脚本持续打外部请求来构造。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'heimdall-gate-'));
process.env.HEIMDALL_DATA_DIR = root;

let baseline, browser, launchBrowser;

const mirror = (siteId, page, files) => {
  const dir = join(root, 'workspace', siteId, 'pages', page);
  mkdirSync(join(dir, 'clone'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, 'clone', name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
};

before(async () => {
  baseline = await import('../src/agent/gate/baseline.mjs');
  ({ launchBrowser } = await import('../src/agent/evidence/capture.mjs'));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

test('baseline: reference classification keeps data, anchors and local paths', () => {
  const { classifyRef } = baseline;
  assert.equal(classifyRef('https://cdn.example/x.js').kind, 'external');
  assert.equal(classifyRef('//cdn.example/x.js').kind, 'external');
  assert.equal(classifyRef('http://127.0.0.1:9/x.js').kind, 'external', 'any other origin is external, loopback included');
  assert.equal(classifyRef('./styles.css').kind, 'local');
  assert.equal(classifyRef('/assets/a.png').kind, 'local');
  assert.equal(classifyRef('data:image/gif;base64,AA').kind, 'ignored');
  assert.equal(classifyRef('#top').kind, 'ignored');
  assert.equal(classifyRef('mailto:a@b.c').kind, 'ignored');
});

test('baseline: sanitizing drops external code and frames, keeps layout for images', () => {
  const dir = join(root, 'sanitize');
  mkdirSync(join(dir, 'img'), { recursive: true });
  writeFileSync(join(dir, 'ok.css'), 'body{color:#000}');
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="ok.css">
    <link rel="stylesheet" href="https://fonts.example/x.css">
    <link rel="icon" href="https://cdn.example/favicon.ico">
    <link rel="alternate" hreflang="zh" href="https://www.example.com/zh">
    <script src="https://analytics.example/a.js"></script>
    <script src="missing.js"></script>
    </head><body>
    <img src="img/ok.png" width="10" height="10">
    <img src="img/gone.png" width="20" height="20">
    <img src="https://cdn.example/p.png">
    <iframe src="https://doubleclick.example/frame"></iframe>
    <form action="https://collector.example/post"></form>
    <a href="https://example.org/page">链接</a>
    <div style="background:url(https://cdn.example/bg.png)"></div>
    </body></html>`;
  const r = baseline.sanitizeHtml(html, { root: dir, file: join(dir, 'index.html') });
  assert.doesNotMatch(r.html, /analytics\.example|fonts\.example|doubleclick\.example|cdn\.example|missing\.js|gone\.png|collector\.example/);
  assert.match(r.html, /example\.org\/page/, 'ordinary links are content, not requests');
  assert.match(r.html, /rel="alternate"[^>]*zh/, 'non-fetching links to the original site stay: they cause no request');
  assert.match(r.html, /ok\.css/);
  assert.equal((r.html.match(/data:image\/gif;base64/g) ?? []).length, 4, 'three replaced images plus one background');
  assert.match(r.html, /width="20"/, 'the broken image keeps its box');
  const kinds = r.changes.map(c => c.kind);
  for (const k of ['external_script_removed', 'broken_script_removed', 'external_frame_removed', 'external_link_removed', 'external_asset_replaced', 'broken_asset_replaced']) {
    assert.ok(kinds.includes(k), k);
  }
});

test('baseline: css external urls and imports become blank pixels', () => {
  const r = baseline.sanitizeCss('@import url("https://a.example/x.css");\n.a{background:url(//b.example/y.png)}\n.b{color:red}');
  assert.doesNotMatch(r.text, /a\.example|b\.example/);
  assert.match(r.text, /\.b\{color:red\}/);
  assert.equal(r.count, 2);
  assert.equal(baseline.sanitizeCss('.b{color:red}').changed, false);
});

test('baseline: the server is read-only, has no CSP, and never serves secrets', async () => {
  const dir = join(root, 'srv');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(dir, 'session.json'), '{"token":"x"}');
  const server = await baseline.startBaselineServer(dir);
  try {
    const home = await fetch(`${server.origin}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.equal(home.headers.get('content-security-policy'), null, 'no sandbox header: fonts and workers must work');
    assert.equal(await (await fetch(`${server.origin}/session.json`)).status, 404);
    assert.equal(await (await fetch(`${server.origin}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
    assert.equal((await fetch(`${server.origin}/`, { method: 'POST' })).status, 405);
  } finally { await server.close(); }
});

test('baseline: a clean mirror is healthy and needs no copy', { timeout: 120_000 }, async () => {
  mirror('clean.test', 'home', {
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="s.css"></head><body><h1>ok</h1><img src="p.png" width="4" height="4"></body></html>',
    's.css': 'h1{color:#123456}',
    'p.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'),
  });
  const r = await baseline.prepareBaseline(browser, { siteId: 'clean.test', page: 'home' });
  assert.equal(r.status, 'healthy');
  assert.equal(r.probe.healthy, true);
  assert.equal(r.sanitized, undefined);
  assert.equal(r.evidence.sha256.length, 64);
  assert.ok(readFileSync(r.reportPath, 'utf8').includes('"status": "healthy"'));
});

test('baseline: a dirty mirror becomes a sanitized copy that passes the probe', { timeout: 180_000 }, async () => {
  mirror('dirty.test', 'home', {
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="s.css"><script src="https://analytics.example/a.js"></script>'
      + '</head><body><h1>ok</h1><img src="gone.png" width="4" height="4"><iframe src="https://tracker.example/f"></iframe></body></html>',
    's.css': 'h1{color:#123456}',
  });
  const r = await baseline.prepareBaseline(browser, { siteId: 'dirty.test', page: 'home' });
  assert.equal(r.probe.healthy, false);
  assert.equal(r.status, 'sanitized');
  assert.equal(r.sanitizedProbe.healthy, true);
  assert.ok(r.sanitized.changes.some(c => c.kind === 'external_script_removed'));
  const copy = readFileSync(join(r.sanitized.dir, 'index.html'), 'utf8');
  assert.doesNotMatch(copy, /analytics\.example|tracker\.example|gone\.png/);
});

test('baseline: when even the copy is dirty the dimension is blocked, not failed', { timeout: 180_000 }, async () => {
  mirror('hopeless.test', 'home', {
    'index.html': '<!doctype html><html><body><h1>ok</h1><script>fetch("https://beacon.example/ping").catch(() => {})</script></body></html>',
  });
  const r = await baseline.prepareBaseline(browser, { siteId: 'hopeless.test', page: 'home' });
  assert.equal(r.probe.healthy, false);
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /blocked|无法判定/);
  assert.ok(r.sanitizedProbe.issues.some(i => i.code === 'external_request'));
});
