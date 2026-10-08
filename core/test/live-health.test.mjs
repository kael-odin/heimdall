/**
 * live/health + live/heal 单测：引用解析、资源分类、缺口自愈（fetch 全 mock，不碰网络）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRefPath, extractRefs, scanLiveBundle } from '../src/live/health.mjs';
import { healBundle } from '../src/live/heal.mjs';
import { indexHar } from '../src/live/har.mjs';

test('live/health: resolver handles /lm prefix, queries, relative paths and externals', () => {
  assert.deepEqual(resolveRefPath('/lm/x.test/a.js?dpl=1', { host: 'x.test' }), { path: '/a.js', search: '?dpl=1' });
  assert.deepEqual(resolveRefPath('/favicon.ico?favicon.abc.ico?dpl=2', { host: 'x.test' }), { path: '/favicon.ico', search: '?favicon.abc.ico?dpl=2' });
  assert.deepEqual(resolveRefPath('https://x.test/a.js', { host: 'x.test' }), { path: '/a.js', search: '' });
  assert.deepEqual(resolveRefPath('https://www.x.test/a.js', { host: 'x.test' }), { path: '/a.js', search: '' });
  assert.deepEqual(resolveRefPath('https://cdn.other/z.png', { host: 'x.test' }), { external: true });
  assert.deepEqual(resolveRefPath('../img/a.png', { host: 'x.test', basePath: '/pages/' }), { path: '/img/a.png', search: '' });
  assert.equal(resolveRefPath('data:image/png;base64,xx', { host: 'x.test' }), null);
  assert.equal(resolveRefPath('#top', { host: 'x.test' }), null);
});

test('live/health: extractRefs separates assets from links', () => {
  const html = '<link rel="stylesheet" href="/a.css"><link rel="canonical" href="/canon"><script src="/s.js"></script><img src="/i.png" srcset="/i2.png 2x"><a href="/page/">go</a>';
  const refs = extractRefs(html, 'html');
  const kind = (u) => refs.find(r => r.url === u)?.kind;
  assert.equal(kind('/a.css'), 'asset');
  assert.equal(kind('/s.js'), 'asset');
  assert.equal(kind('/i.png'), 'asset');
  assert.equal(kind('/i2.png'), 'asset');
  assert.equal(kind('/page/'), 'link');
  assert.equal(kind('/canon'), 'link');
});

test('live/health: scan classifies local/har/unresolved/dynamic/external and missing links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-health-'));
  try {
    mkdirSync(join(dir, 'live', 'page'), { recursive: true });
    mkdirSync(join(dir, 'live', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'live', 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'live', 'page', 'index.html'), [
      '<script src="/lm/x.test/assets/app.js"></script>',
      '<link rel="stylesheet" href="/lm/x.test/styles.css?dpl=1">',
      '<img src="/missing.png">',
      '<img src="https://cdn.other/logo.svg">',
      '<a href="/other/">other</a>',
      '<img src="/_next/image?url=/a.png&w=64">',
    ].join(''));
    const harIndex = indexHar([{ method: 'GET', url: 'https://x.test/styles.css?dpl=1' }]);
    const report = scanLiveBundle({ liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test', harIndex });
    assert.equal(report.pages, 1);
    assert.equal(report.assets.local, 1);
    assert.equal(report.assets.har, 1);
    assert.equal(report.assets.unresolved, 1);
    assert.equal(report.assets.dynamic, 1);
    assert.equal(report.assets.externalAssets, 1);
    assert.equal(report.links.missing, 1);
    assert.ok(report.unresolvedPaths.includes('/missing.png'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: retries path variants, writes fetched file, skips dynamic endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-heal-'));
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('good.js')) return new Response('ok-js', { status: 200, headers: { 'content-type': 'text/javascript' } });
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    };
    const r = await healBundle({
      liveDir: dir, host: 'x.test', origin: 'https://x.test',
      targets: ['/a/good.js?dpl=1', '/a/good.js?dpl=2', '/_next/image?url=/x.png&w=64', '/dead.js'],
      fetchImpl,
    });
    assert.equal(r.fetched, 1);
    assert.equal(r.failed, 1);
    assert.ok(r.skipped >= 1, 'dynamic endpoint must be skipped');
    assert.equal(existsSync(join(dir, 'a', 'good.js')), true);
    assert.ok(calls.some(u => u.includes('/a/good.js')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
