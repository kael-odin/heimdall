import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localizeApprovedExternalStaticAssets } from '../src/live/external-static.mjs';
import { scanLiveBundle } from '../src/live/health.mjs';

const HOST = 'site.example.org';
const ORIGIN = `https://${HOST}`;

function fixture(html) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-external-static-'));
  const liveDir = join(root, 'site', 'live');
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, 'index.html'), html);
  return { root, liveDir };
}

test('approved exact static refs localize through existing pipeline, including nested CSS', async () => {
  const script = 'https://cdn.example.org/js/app.js?v=1';
  const style = 'https://cdn.example.org/css/site.css?v=2';
  const font = 'https://cdn.example.org/fonts/text.woff2?v=3';
  const image = 'https://cdn.example.org/images/hero.png';
  const { root, liveDir } = fixture(`<!doctype html>
    <script src="${script}"></script>
    <link rel="stylesheet" href="//cdn.example.org/css/site.css?v=2">
    <img src="${image}">
    <a href="https://external.example.org/page">External navigation</a>`);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, undefined);
    if (url === script) return new Response(null, {
      status: 302, headers: { location: '/js/app-v1.js' },
    });
    if (url === 'https://cdn.example.org/js/app-v1.js') {
      return new Response('window.externalAssetLoaded = true;', {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    if (url === style) return new Response('@font-face{src:url("../fonts/text.woff2?v=3")}', {
      headers: { 'content-type': 'text/css' },
    });
    if (url === font) return new Response('font-data', {
      headers: { 'content-type': 'font/woff2' },
    });
    if (url === image) return new Response(Buffer.from('89504e470d0a1a0a', 'hex'), {
      headers: { 'content-type': 'image/png' },
    });
    throw new Error('unexpected URL');
  };
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [script, style, font, image], fetchImpl,
    });
    assert.deepEqual({ requested: report.requested, fetched: report.fetched, failed: report.failed },
      { requested: 4, fetched: 4, failed: 0 });
    assert.equal(report.localized, 4);
    assert.equal(report.failures.length, 0);
    assert.deepEqual(new Set(calls), new Set([script, 'https://cdn.example.org/js/app-v1.js', style, font, image]));
    const html = readFileSync(join(liveDir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /(?:https?:)?\/\/cdn\.example\.org/);
    assert.match(html, /href="https:\/\/external\.example\.org\/page"/);
    const cssFile = join(liveDir, urlMap.get(style).slice((`/lm/${HOST}/`).length));
    const css = readFileSync(cssFile, 'utf8');
    assert.match(css, new RegExp(urlMap.get(font).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const target of [script, style, font, image]) {
      assert.ok(existsSync(join(liveDir, urlMap.get(target).slice((`/lm/${HOST}/`).length))));
    }
    const health = scanLiveBundle({ liveDir, host: HOST, origin: ORIGIN });
    assert.equal(health.assets.externalAssets, 0);
    assert.equal(health.assets.unresolved, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('third-party service, JSON, unsafe redirect and unreferenced URLs remain unlocalized', async () => {
  const carbon = 'https://cdn.carbonads.com/carbon.js?serve=CEBIEK3N&placement=vitejsdev';
  const json = 'https://cdn.example.org/data.json';
  const redirect = 'https://cdn.example.org/theme.css';
  const privateUrl = 'https://cdn.example.org/secret.png?token=private-value';
  const unused = 'https://cdn.example.org/unused.png';
  const { root, liveDir } = fixture(`<!doctype html>
    <script src="${carbon.replace('&', '&amp;')}"></script>
    <script src="${json}"></script>
    <link rel="stylesheet" href="${redirect}">
    <img src="${privateUrl}">`);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === json) return new Response('{"ads":[]}', { headers: { 'content-type': 'application/json' } });
    if (url === redirect) return new Response(null, {
      status: 302, headers: { location: 'https://other.example.org/theme.css' },
    });
    throw new Error('must not fetch disallowed URLs');
  };
  try {
    const original = readFileSync(join(liveDir, 'index.html'));
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN,
      approvedUrls: [carbon, json, redirect, privateUrl, unused], fetchImpl,
    });
    assert.equal(report.fetched, 0);
    assert.equal(report.failed, 5);
    assert.deepEqual(report.failures, [
      { index: 0, reason: 'prohibited-service' }, { index: 1, reason: 'unsafe-extension' },
      { index: 2, reason: 'unsafe-redirect' }, { index: 3, reason: 'unsafe-url' },
      { index: 4, reason: 'not-referenced' },
    ]);
    assert.deepEqual(calls, [redirect]);
    assert.equal(urlMap.size, 0);
    assert.deepEqual(readFileSync(join(liveDir, 'index.html')), original);
    assert.doesNotMatch(JSON.stringify(report), /private-value|CEBIEK3N/);
    assert.equal(scanLiveBundle({ liveDir, host: HOST, origin: ORIGIN }).assets.externalAssets, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('trailing-dot service and private hosts are rejected before a request', async () => {
  const service = 'https://cdn.carbonads.com./carbon.js';
  const privateHost = 'https://printer.internal./app.js';
  const { root, liveDir } = fixture(`<script src="${service}"></script><script src="${privateHost}"></script>`);
  try {
    const { report } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [service, privateHost],
      fetchImpl: () => { throw new Error('unexpected fetch'); },
    });
    assert.deepEqual(report.failures, [
      { index: 0, reason: 'prohibited-service' }, { index: 1, reason: 'unsafe-url' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('download budgets leave excess assets external for the strict gate', async () => {
  const first = 'https://cdn.example.org/a.png';
  const second = 'https://cdn.example.org/b.png';
  const { root, liveDir } = fixture(`<img src="${first}"><img src="${second}">`);
  const fetchImpl = async () => new Response(Buffer.from('89504e470d0a1a0a', 'hex'), {
    headers: { 'content-type': 'image/png' },
  });
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [first, second], fetchImpl,
      maxAssetBytes: 10, maxTotalBytes: 10,
    });
    assert.equal(report.fetched, 1);
    assert.deepEqual(report.failures, [{ index: 1, reason: 'too-large' }]);
    assert.equal(urlMap.has(first), true);
    assert.equal(urlMap.has(second), false);
    assert.equal(scanLiveBundle({ liveDir, host: HOST, origin: ORIGIN }).assets.externalAssets, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an existing local path with different bytes is never counted as captured', async () => {
  const url = 'https://cdn.example.org/app.js';
  const { root, liveDir } = fixture(`<script src="${url}"></script>`);
  const local = join(liveDir, '_ext', 'cdn.example.org', 'app.js');
  mkdirSync(join(liveDir, '_ext', 'cdn.example.org'), { recursive: true });
  writeFileSync(local, 'old-script');
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [url],
      fetchImpl: async () => new Response('new-script', { headers: { 'content-type': 'text/javascript' } }),
    });
    assert.equal(report.fetched, 0);
    assert.deepEqual(report.failures, [{ index: 0, reason: 'localization-conflict' }]);
    assert.equal(urlMap.size, 0);
    assert.equal(readFileSync(local, 'utf8'), 'old-script');
    assert.match(readFileSync(join(liveDir, 'index.html'), 'utf8'), /cdn\.example\.org\/app\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a directory at the destination path is reported without aborting capture', async () => {
  const url = 'https://cdn.example.org/app.js';
  const { root, liveDir } = fixture(`<script src="${url}"></script>`);
  mkdirSync(join(liveDir, '_ext', 'cdn.example.org', 'app.js'), { recursive: true });
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [url],
      fetchImpl: async () => new Response('window.ok = true;', { headers: { 'content-type': 'text/javascript' } }),
    });
    assert.deepEqual(report.failures, [{ index: 0, reason: 'localization-failed' }]);
    assert.equal(urlMap.size, 0);
    assert.match(readFileSync(join(liveDir, 'index.html'), 'utf8'), /cdn\.example\.org\/app\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without exact approval, capture makes no network request or file edit', async () => {
  const { root, liveDir } = fixture('<script src="https://cdn.example.org/app.js"></script>');
  try {
    const original = readFileSync(join(liveDir, 'index.html'));
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN,
      fetchImpl: () => { throw new Error('unexpected fetch'); },
    });
    assert.equal(report.requested, 0);
    assert.equal(urlMap.size, 0);
    assert.deepEqual(readFileSync(join(liveDir, 'index.html')), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('relative dependencies in a redirected stylesheet use the final stylesheet URL', async () => {
  const style = 'https://cdn.example.org/theme.css';
  const font = 'https://cdn.example.org/v2/fonts/ui.woff2';
  const { root, liveDir } = fixture(`<link rel="stylesheet" href="${style}">`);
  const calls = [];
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [style, font],
      fetchImpl: async url => {
        calls.push(url);
        if (url === style) return new Response(null, { status: 302, headers: { location: '/v2/theme.css' } });
        if (url === 'https://cdn.example.org/v2/theme.css') {
          return new Response('@font-face{src:url("fonts/ui.woff2")}', { headers: { 'content-type': 'text/css' } });
        }
        if (url === font) return new Response('font', { headers: { 'content-type': 'font/woff2' } });
        throw new Error('unexpected URL');
      },
    });
    assert.equal(report.fetched, 2);
    assert.equal(report.failed, 0);
    assert.ok(calls.includes(font));
    const cssFile = join(liveDir, urlMap.get(style).slice((`/lm/${HOST}/`).length));
    assert.match(readFileSync(cssFile, 'utf8'), /\/lm\/site\.example\.org\/_ext\/cdn\.example\.org\/v2\/fonts\/ui\.woff2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a verified HAR stylesheet source resolves its relative font on the CDN', async () => {
  const style = 'https://cdn.example.org/styles/site.css';
  const font = 'https://cdn.example.org/fonts/ui.woff2';
  const { root, liveDir } = fixture('<link rel="stylesheet" href="/_ext/cdn.example.org/styles/site.css">');
  const cssFile = join(liveDir, '_ext', 'cdn.example.org', 'styles', 'site.css');
  mkdirSync(join(liveDir, '_ext', 'cdn.example.org', 'styles'), { recursive: true });
  writeFileSync(cssFile, '@font-face{src:url("../fonts/ui.woff2")}');
  const calls = [];
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [font],
      cssSources: new Map([[cssFile, style]]),
      fetchImpl: async url => {
        calls.push(url);
        return new Response('font', { headers: { 'content-type': 'font/woff2' } });
      },
    });
    assert.deepEqual(calls, [font]);
    assert.equal(report.fetched, 1);
    assert.equal(report.remainingExternal, 0);
    assert.ok(readFileSync(cssFile, 'utf8').includes(urlMap.get(font)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an HTML fallback with a misleading JavaScript MIME is rejected', async () => {
  const script = 'https://cdn.example.org/app.js';
  const { root, liveDir } = fixture(`<script src="${script}"></script>`);
  try {
    const { report } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [script],
      fetchImpl: async () => new Response('<body>missing</body>', { headers: { 'content-type': 'text/javascript' } }),
    });
    assert.deepEqual(report.failures, [{ index: 0, reason: 'html-fallback' }]);
    assert.match(readFileSync(join(liveDir, 'index.html'), 'utf8'), /cdn\.example\.org\/app\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('extensionless approved media use a serving-compatible file extension', async () => {
  const image = 'https://cdn.example.org/photo';
  const audio = 'https://cdn.example.org/sound';
  const { root, liveDir } = fixture(`<img src="${image}"><audio src="${audio}"></audio>`);
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [image, audio],
      fetchImpl: async url => new Response(url === image ? 'bmp' : 'ogg', {
        headers: { 'content-type': url === image ? 'image/bmp' : 'audio/ogg' },
      }),
    });
    assert.equal(report.fetched, 2);
    assert.match(urlMap.get(image), /\/photo\.bmp$/);
    assert.match(urlMap.get(audio), /\/sound\.ogg$/);
    assert.equal(scanLiveBundle({ liveDir, host: HOST, origin: ORIGIN }).assets.externalAssets, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exact approval rewrites protocol-relative resources but leaves URL variants and navigation intact', async () => {
  const exact = 'https://cdn.example.org/app.js';
  const queryVariant = exact + '?v=2';
  const pathVariant = exact + '-next';
  const { root, liveDir } = fixture(`<!doctype html>
    <script src="//cdn.example.org/app.js"></script>
    <script src="${queryVariant}"></script>
    <script src="${pathVariant}"></script>
    <a href="${exact}">Download</a>`);
  const calls = [];
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [exact],
      fetchImpl: async url => {
        calls.push(url);
        return new Response('window.ok = true;', { headers: { 'content-type': 'text/javascript' } });
      },
    });
    const html = readFileSync(join(liveDir, 'index.html'), 'utf8');
    assert.match(html, new RegExp(`src="${urlMap.get(exact).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.ok(html.includes(`src="${queryVariant}"`));
    assert.ok(html.includes(`src="${pathVariant}"`));
    assert.ok(html.includes(`href="${exact}"`));
    assert.deepEqual(calls, [exact]);
    assert.equal(report.remainingExternal, 2);
    assert.equal(scanLiveBundle({ liveDir, host: HOST, origin: ORIGIN }).assets.externalAssets, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CSS token rewriting preserves unapproved query and path variants', async () => {
  const exact = 'https://cdn.example.org/a.png';
  const { root, liveDir } = fixture('<link rel="stylesheet" href="/main.css">');
  writeFileSync(join(liveDir, 'main.css'), `.a{background:url("${exact}")}`
    + `.b{background:url("${exact}?v=2")}`
    + `.c{background:url("${exact}-next")}`);
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [exact],
      fetchImpl: async () => new Response('png', { headers: { 'content-type': 'image/png' } }),
    });
    const css = readFileSync(join(liveDir, 'main.css'), 'utf8');
    assert.ok(css.includes(`url("${urlMap.get(exact)}")`));
    assert.ok(css.includes(`url("${exact}?v=2")`));
    assert.ok(css.includes(`url("${exact}-next")`));
    assert.equal(report.remainingExternal, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('static clone HTML and CSS are scanned and rewritten using exact approval', async () => {
  const font = 'https://cdn.example.org/fonts/ui.woff2';
  const image = 'https://cdn.example.org/images/hero.png';
  const { root, liveDir } = fixture('<!doctype html><title>Live</title>');
  const staticDir = join(root, 'site', 'static');
  const clone = join(staticDir, HOST, 'pages', 'home', 'clone');
  mkdirSync(join(clone, 'styles'), { recursive: true });
  writeFileSync(join(clone, 'index.html'), `<link rel="stylesheet" href="styles/cssom.css"><img src="${image}">`
    + `<a href="${image}">Original image</a>`);
  writeFileSync(join(clone, 'styles', 'cssom.css'), `@font-face{src:url("${font}")}`);
  const calls = [];
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, staticDir, host: HOST, origin: ORIGIN, approvedUrls: [font, image],
      fetchImpl: async url => {
        calls.push(url);
        return new Response(url === font ? 'font' : 'png', {
          headers: { 'content-type': url === font ? 'font/woff2' : 'image/png' },
        });
      },
    });
    assert.deepEqual(calls, [font, image]);
    assert.equal(report.fetched, 2);
    assert.equal(report.remainingExternal, 0);
    assert.ok(readFileSync(join(clone, 'styles', 'cssom.css'), 'utf8').includes(urlMap.get(font)));
    const html = readFileSync(join(clone, 'index.html'), 'utf8');
    assert.ok(html.includes(`src="${urlMap.get(image)}"`));
    assert.ok(html.includes(`href="${image}"`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a CSS response containing an HTML fragment is rejected', async () => {
  const style = 'https://cdn.example.org/theme.css';
  const { root, liveDir } = fixture(`<link rel="stylesheet" href="${style}">`);
  try {
    const { report } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [style],
      fetchImpl: async () => new Response('<!-- fallback --><div>Not Found</div>', {
        headers: { 'content-type': 'text/css' },
      }),
    });
    assert.deepEqual(report.failures, [{ index: 0, reason: 'html-fallback' }]);
    assert.equal(report.remainingExternal, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approved URL left in inline and bundled JavaScript is a strict failure', async () => {
  const script = 'https://cdn.example.org/app.js';
  const { root, liveDir } = fixture(`<script src="${script}"></script>`
    + `<script>setTimeout(() => import("${script}"), 30000)</script>`);
  writeFileSync(join(liveDir, 'later.js'), `const next = "${script}";`);
  try {
    const { report, urlMap } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [script],
      fetchImpl: async () => new Response('window.loaded = true;', {
        headers: { 'content-type': 'text/javascript' },
      }),
    });
    assert.equal(report.fetched, 1);
    assert.deepEqual(report.failures, [{ index: 0, reason: 'unrewritten-runtime-reference' }]);
    assert.equal(report.remainingExternal, 0);
    assert.ok(readFileSync(join(liveDir, 'index.html'), 'utf8').includes(`src="${urlMap.get(script)}"`));
    assert.ok(readFileSync(join(liveDir, 'later.js'), 'utf8').includes(script));
    assert.doesNotMatch(JSON.stringify(report), /cdn\.example\.org|app\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a redirect without Location is rejected without requesting a substitute path', async () => {
  const style = 'https://cdn.example.org/theme.css';
  const { root, liveDir } = fixture(`<link rel="stylesheet" href="${style}">`);
  const calls = [];
  try {
    const { report } = await localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [style],
      fetchImpl: async url => {
        calls.push(url);
        return new Response(null, { status: 302 });
      },
    });
    assert.deepEqual(calls, [style]);
    assert.deepEqual(report.failures, [{ index: 0, reason: 'invalid-redirect' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate approval URLs are rejected before any fetch', async () => {
  const exact = 'https://cdn.example.org/app.js';
  const { root, liveDir } = fixture(`<script src="${exact}"></script>`);
  try {
    await assert.rejects(localizeApprovedExternalStaticAssets({
      liveDir, host: HOST, origin: ORIGIN, approvedUrls: [exact, exact],
      fetchImpl: () => { throw new Error('unexpected fetch'); },
    }), /invalid external asset capture input/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
