/**
 * live/health + live/heal 单测：引用解析、资源分类、缺口自愈（fetch 全 mock，不碰网络）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRefPath, extractRefs, scanLiveBundle } from '../src/live/health.mjs';
import { healBundle, materializeHar, localizeQueryEntries, rewriteHtmlRefs } from '../src/live/heal.mjs';
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

test('live/health: data URI 内嵌的 url() 不得被当成外部引用（实测真实缺陷）', () => {
  // vitest.dev 的 cssom.css 里有 data:image/svg+xml 的内联 SVG，
  // 其中含 filter='url(%23SVGJNgLYdgK)'（= url(#SVGJNgLYdgK)，指向同文档的 filter）。
  // 朴素全局正则 /url\(([^"')]+)\)/g 会把**内嵌那一条**单独匹配出来，
  // 得到 %23SVGJNgLYdgK → 被当成相对路径 → 解析成
  // /static/<host>/pages/<page>/clone/styles/%23SVGJNgLYdgK → 记为"未解析"。
  // 后果：健康报告写 unresolved=91，而真实缺口只有 4 个 —— 报告完全失去指向性。
  const css = `a{background:url("data:image/svg+xml,%3Csvg%3E%3Cg filter='url(%23SVGJNgLYdgK)'%3E%3C/g%3E%3C/svg%3E")}
b{background:url(/real/bg.png)}`;
  const refs = extractRefs(css, 'css');

  // ① 整个 data URI 算**一条**引用（它的内容里当然含 %23SVG，这是对的）
  assert.equal(refs.filter(r => r.url.startsWith('data:image/svg+xml')).length, 1);
  // ② 但绝不能出现一条**以 %23 开头**的独立引用 —— 那才是缺陷的形态
  assert.ok(!refs.some(r => r.url.startsWith('%23')), `不应有以 %23 开头的独立引用，实际: ${JSON.stringify(refs.map(r => r.url))}`);
  // ③ 走到解析：data URI 与片段都该被跳过，只留真正的外部引用
  const resolved = refs
    .map(r => resolveRefPath(r.url, { host: 'x.test', basePath: '/static/x.test/pages/home/clone/styles/' }))
    .filter(Boolean);
  assert.deepEqual(resolved, [{ path: '/real/bg.png', search: '' }]);
  // ④ 解析结果里不得出现指向 %23 的路径（这正是修复前健康报告里的假缺口）
  assert.ok(!resolved.some(r => String(r.path).includes('%23')));
});

test('live/health: URL 编码的片段标识 %23 按片段处理，不当作路径', () => {
  // 字面 # 已被 SKIP_REF 覆盖，但 %23 会绕过它 —— 生成一个永远不存在的目标
  assert.equal(resolveRefPath('%23SVGJNgLYdgK', { host: 'x.test' }), null);
  assert.equal(resolveRefPath('#frag', { host: 'x.test' }), null);
  assert.equal(resolveRefPath('%23a/b.css', { host: 'x.test' }), null);
  // 但普通百分号编码的路径不受影响
  assert.deepEqual(resolveRefPath('/a%20b.png', { host: 'x.test' }), { path: '/a%20b.png', search: '' });
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
    // HAR 条目要**真能回放**才算已覆盖：serve.mjs 要求有 body（`if (hit && hit.body)`）
    // 并且会把录到的状态码原样返回。所以这里给的是完整条目（status + body）。
    const harIndex = indexHar([{ method: 'GET', url: 'https://x.test/styles.css?dpl=1', status: 200, body: 'Y3Nz' }]);
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

test('live/heal: materializeHar writes same-origin bodies and skips query/external/dir entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-mat-'));
  try {
    const entries = [
      { method: 'GET', url: 'https://x.test/a/chunk.js', status: 200, body: Buffer.from('JS').toString('base64') },
      { method: 'GET', url: 'https://x.test/_next/image?url=/a.png', status: 200, body: Buffer.from('IMG').toString('base64') },
      { method: 'GET', url: 'https://cdn.other/x.js', status: 200, body: Buffer.from('X').toString('base64') },
      { method: 'GET', url: 'https://x.test/dir/', status: 200, body: Buffer.from('D').toString('base64') },
      { method: 'POST', url: 'https://x.test/post.js', status: 200, body: Buffer.from('P').toString('base64') },
    ];
    const r = materializeHar({ liveDir: dir, origin: 'https://x.test', entries });
    assert.equal(r.written, 1);
    assert.equal(existsSync(join(dir, 'a', 'chunk.js')), true);
    assert.equal(existsSync(join(dir, '_next')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: localizeQueryEntries + rewriteHtmlRefs localizes dynamic image endpoints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-loc-'));
  try {
    mkdirSync(join(dir, 'live', 'pricing'), { recursive: true });
    writeFileSync(join(dir, 'live', 'pricing', 'index.html'),
      '<img src="/lm/x.test/_next/image?url=%2Fa.png&amp;w=64"><img src="/lm/x.test/_next/image?url=%2Fa.png&w=64">');
    const entries = [{ method: 'GET', url: 'https://x.test/_next/image?url=%2Fa.png&w=64', status: 200, mimeType: 'image/webp', body: Buffer.from('IMG').toString('base64') }];
    const loc = localizeQueryEntries({ entries, liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test' });
    assert.equal(loc.written, 1);
    assert.equal(loc.bytes, 3);
    const rw = rewriteHtmlRefs({ liveDir: join(dir, 'live'), map: loc.map });
    assert.ok(rw.rewrites >= 2, 'both escaped and raw refs rewritten, got ' + rw.rewrites);
    const html = readFileSync(join(dir, 'live', 'pricing', 'index.html'), 'utf8');
    assert.ok(!html.includes('_next/image'), 'all dynamic refs rewritten');
    assert.ok(html.includes('/lm/x.test/_ext/'), 'points at local _ext file');
    const rel = [...loc.map.values()][0].replace('/lm/x.test/', '');
    assert.equal(existsSync(join(dir, 'live', rel)), true);
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

/**
 * HAR 覆盖数只该算**真能放出来的**条目。
 *
 * 原来的判据只看 method+URL 命中，于是"捕获时这条就是 404"或"没有 body"也被算成
 * 已覆盖 —— 而部署出去的 serve.mjs 要求 `hit.body`，还会把录到的状态码原样返回：
 * health 说"离线可用"，浏览器收到的是 404。交付包的 landing 页与 README 照着
 * health.json 说话，所以这个数错了整包就都在说错话。
 */
test('live/health: 没有 body 或状态是 4xx 的 HAR 条目**不算**已覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-health2-'));
  try {
    mkdirSync(join(dir, 'live', 'page'), { recursive: true });
    writeFileSync(join(dir, 'live', 'page', 'index.html'), [
      '<script src="/lm/x.test/no-body.js"></script>',
      '<script src="/lm/x.test/was-404.js"></script>',
      '<script src="/lm/x.test/good.js"></script>',
    ].join(''));
    const harIndex = indexHar([
      { method: 'GET', url: 'https://x.test/no-body.js', status: 200 },              // 录到了但没有 body
      { method: 'GET', url: 'https://x.test/was-404.js', status: 404, body: 'eA==' }, // 录下来就是个 404
      { method: 'GET', url: 'https://x.test/good.js', status: 200, body: 'eA==' },    // 真的能回放
    ]);
    const report = scanLiveBundle({ liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test', harIndex });
    assert.equal(report.assets.har, 1, '只有 good.js 算已覆盖');
    assert.equal(report.assets.unresolved, 2, '另外两条要如实落进缺口，而不是被算成已覆盖');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
