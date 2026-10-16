/**
 * live/health + live/heal 单测：引用解析、资源分类、缺口自愈（fetch 全 mock，不碰网络）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveRefPath, extractRefs, listLivePageRoutes, scanLiveBundle } from '../src/live/health.mjs';
import { healBundle, healReferencedAssets, materializeHar, localizeQueryEntries, rewriteLocalRefs, removeNonvisualExternalPixels, isStaticAsset, mimeExt } from '../src/live/heal.mjs';
import { indexHar } from '../src/live/har.mjs';
import { liveSnapshotPath } from '../src/live/live-path.mjs';

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
  const html = '<link rel="stylesheet" href="/a.css"><link rel="canonical" href="/canon"><link rel="dns-prefetch" href="https://fonts.example"><link rel="preconnect" href="https://fonts.example"><script src="/s.js"></script><img src="/i.png" srcset="/i2.png 2x"><a href="/page/">go</a>';
  const refs = extractRefs(html, 'html');
  const kind = (u) => refs.find(r => r.url === u)?.kind;
  assert.equal(kind('/a.css'), 'asset');
  assert.equal(kind('https://fonts.example'), 'link');
  assert.equal(kind('/s.js'), 'asset');
  assert.equal(kind('/i.png'), 'asset');
  assert.equal(kind('/i2.png'), 'asset');
  assert.equal(kind('/page/'), 'link');
  assert.equal(kind('/canon'), 'link');
});

test('live/health: inline style blocks and style attributes are strict resources', () => {
  const refs = extractRefs([
    '<style>.hero{background-image:url("/hero.webp")} .icon{background:url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E)}</style>',
    '<div style="background:url(/card.webp)"></div>',
  ].join(''), 'html');
  assert.ok(refs.some(r => r.url === '/hero.webp' && r.required));
  assert.ok(refs.some(r => r.url === '/card.webp' && r.required));
  assert.equal(resolveRefPath(refs.find(r => r.url.startsWith('data:'))?.url, { host: 'x.test' }), null);
  assert.ok(!refs.some(r => r.url.startsWith('%23')));
  assert.ok(!extractRefs('<script>const text = `style="background:url(/not-a-resource.webp)"`;</script>', 'html')
    .some(r => r.url === '/not-a-resource.webp'));
});

test('live/health: missing inline CSS assets enter the strict unresolved count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-health-inline-'));
  try {
    mkdirSync(join(dir, 'live'), { recursive: true });
    writeFileSync(join(dir, 'live', 'index.html'), '<style>body{background:url(/missing-inline.webp)}</style><div style="background:url(/missing-attr.webp)"></div>');
    const report = scanLiveBundle({ liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test' });
    assert.equal(report.assets.unresolved, 2);
    assert.ok(report.unresolvedPaths.includes('/missing-inline.webp'));
    assert.ok(report.unresolvedPaths.includes('/missing-attr.webp'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
      '<img src="https://cdn.other/image?id=7">',
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
    assert.equal(report.assets.externalAssets, 2);
    assert.equal(report.links.missing, 1);
    assert.ok(report.unresolvedPaths.includes('/missing.png'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/health: missing links are classified without leaking query parameters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-health-missing-details-'));
  try {
    mkdirSync(join(dir, 'live', 'guide'), { recursive: true });
    writeFileSync(join(dir, 'live', 'guide', 'index.html'), [
      '<a href="/config.md?token=private">Config source</a>',
      '<a href="/config.md">Config source again</a>',
      '<a href="/features?utm_source=internal">Features alias</a>',
      '<a href="/missing.pdf?token=private">PDF</a>',
    ].join(''));
    const report = scanLiveBundle({ liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test' });
    assert.equal(report.links.missing, 4);
    assert.deepEqual(report.missingLinkDetails, [
      { path: '/config.md', kind: 'source-document', references: 2, pages: ['/guide/'] },
      { path: '/features', kind: 'path-alias', references: 1, pages: ['/guide/'] },
      { path: '/missing.pdf', kind: 'resource-link', references: 1, pages: ['/guide/'] },
    ]);
    assert.equal(report.missingLinkDetailsTruncated, false);
    assert.doesNotMatch(JSON.stringify(report.missingLinkDetails), /private|utm_source/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/health: external refs preserve serving-relevant tag evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-health-external-details-'));
  try {
    mkdirSync(join(dir, 'live'), { recursive: true });
    writeFileSync(join(dir, 'live', 'index.html'),
      '<iframe src="https://www.youtube-nocookie.com/embed/demo"></iframe>'
      + '<script src="https://cdn.carbonads.com/carbon.js?serve=demo"></script>');
    const report = scanLiveBundle({ liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test' });
    const byHost = new Map(report.externalRefsTop.map(ref => [new URL(ref.url).hostname, ref]));
    assert.deepEqual(byHost.get('www.youtube-nocookie.com').tags, ['iframe']);
    assert.equal(byHost.get('www.youtube-nocookie.com').required, false);
    assert.deepEqual(byHost.get('cdn.carbonads.com').tags, ['script']);
    assert.equal(byHost.get('cdn.carbonads.com').required, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/health: relative links from a trailing-slash page resolve under that directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-health-relative-'));
  const liveDir = join(dir, 'live');
  const queryPath = '/docs/next?revision=2';
  try {
    mkdirSync(join(liveDir, 'docs'), { recursive: true });
    writeFileSync(join(liveDir, 'docs', 'index.html'),
      '<!doctype html><h1>Docs</h1><a href="next?revision=2">Next</a><img src="badge.svg">');
    writeFileSync(join(liveDir, 'docs', 'badge.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const snapshot = join(liveDir, liveSnapshotPath('/docs/next', '?revision=2'));
    mkdirSync(dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, '<!doctype html><h1>Next</h1>');

    assert.deepEqual(listLivePageRoutes(liveDir, 'https://x.test', [queryPath]), ['/docs/', queryPath]);
    const report = scanLiveBundle({ liveDir, host: 'x.test', origin: 'https://x.test', queryPages: [queryPath] });
    assert.equal(report.links.local, 1);
    assert.equal(report.links.missing, 0);
    assert.equal(report.assets.local, 1);
    assert.equal(report.assets.unresolved, 0);
    assert.ok(report.probePaths.includes(queryPath));
    assert.ok(report.probePaths.includes('/docs/badge.svg'));
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

test('live/heal: materialized CSS exposes nested assets for bounded follow-up healing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-heal-css-'));
  const liveDir = join(dir, 'live');
  const origin = 'https://x.test';
  const requests = [];
  try {
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'index.html'), '<link rel="stylesheet" href="/assets/theme.css"><h1>Page</h1>');
    materializeHar({
      liveDir, origin,
      entries: [{ method: 'GET', url: origin + '/assets/theme.css', status: 200,
        body: Buffer.from('@import url("/assets/fonts.css");').toString('base64') }],
    });
    const before = scanLiveBundle({ liveDir, host: 'x.test', origin });
    assert.deepEqual(before.unresolvedPaths, ['/assets/fonts.css']);

    const fetchImpl = async url => {
      requests.push(String(url));
      if (String(url).endsWith('/assets/fonts.css')) {
        return new Response('@font-face{src:url("/assets/font.woff2")}',
          { status: 200, headers: { 'content-type': 'text/css' } });
      }
      if (String(url).endsWith('/assets/font.woff2')) {
        return new Response('font-bytes', { status: 200, headers: { 'content-type': 'font/woff2' } });
      }
      return new Response('missing', { status: 404 });
    };
    const { health, healed } = await healReferencedAssets({
      liveDir, host: 'x.test', origin, fetchImpl,
    });
    assert.equal(health.assets.unresolved, 0);
    assert.equal(healed.passes, 2);
    assert.equal(healed.fetched, 2);
    assert.deepEqual(requests, [origin + '/assets/fonts.css', origin + '/assets/font.woff2']);
    assert.ok(existsSync(join(liveDir, 'assets', 'font.woff2')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: localizeQueryEntries + rewriteLocalRefs localizes dynamic image endpoints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-loc-'));
  try {
    mkdirSync(join(dir, 'live', 'pricing'), { recursive: true });
    writeFileSync(join(dir, 'live', 'pricing', 'index.html'),
      '<img src="/lm/x.test/_next/image?url=%2Fa.png&amp;w=64"><img src="/lm/x.test/_next/image?url=%2Fa.png&w=64">');
    const entries = [{ method: 'GET', url: 'https://x.test/_next/image?url=%2Fa.png&w=64', status: 200, mimeType: 'image/webp', body: Buffer.from('IMG').toString('base64') }];
    const loc = localizeQueryEntries({ entries, liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test' });
    assert.equal(loc.written, 1);
    assert.equal(loc.bytes, 3);
    const rw = rewriteLocalRefs({ liveDir: join(dir, 'live'), map: loc.map });
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

/**
 * ---- 站外静态资源的本地化（2026-10-13） ----
 *
 * 这组守卫来自一次实测：交付包断网时 1.5 秒内像素变化 **0.00%**（联网同一测量 6.13%）。
 * 原因不是资源没抓到 —— 原始 network.har 里 36/38 条都带着响应体 —— 而是**判据**：
 * `!sameOrigin && !isImage → continue`，注释写的是"站外只本地化图片（追踪脚本等留在外网）"。
 * 它把**站外**当成了**第三方**，可 moonshot 把整个应用的 JS、字体、WebGL 驱动
 * （`unicornStudio-2.1.4.umd.js`）全放在 `statics.kimi.ai` 上 —— 于是整套应用被跳过，
 * 离线只剩一张不会动的照片。加上导出侧还有第二道同样的闸门（HAR 合并时丢掉站外非图片）。
 * 新判据：**看类型，不看域名**。
 */

test('live/heal: isStaticAsset 认静态资源，不认文档与数据接口', () => {
  const A = (url, mimeType) => isStaticAsset({ url, mimeType });
  assert.equal(A('https://cdn.x/a.js', 'text/javascript'), true);
  assert.equal(A('https://cdn.x/a.css', 'text/css'), true);
  assert.equal(A('https://cdn.x/f.woff2', 'font/woff2'), true);
  assert.equal(A('https://cdn.x/wasm', 'application/wasm'), true);
  assert.equal(A('https://cdn.x/i.webp', 'image/webp'), true);
  assert.equal(A('https://cdn.x/doodle.riv', 'application/octet-stream'), true, 'CDN 上 .riv/.wasm 常被这么发');
  assert.equal(A('https://cdn.x/chunk.js', ''), true, '没有 content-type 时按 URL 后缀兜底');
  assert.equal(A('https://x.test/', 'text/html'), false, '页面/iframe 本身不搬');
  assert.equal(A('https://api.x/collect?v=2', 'application/json'), false, '数据接口离线无法伪造，收了也只是体积');
  assert.equal(A('https://api.x/g/collect', ''), false, '没有后缀的数据接口也不搬');
});

test('live/heal: 站外的 JS/字体/CSS 会整份搬进 _ext，并给出协议相对写法的映射', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-ext-'));
  try {
    const live = join(dir, 'live');
    const entries = [
      { method: 'GET', url: 'https://statics.cdn/app/chunks/a.js', status: 200, mimeType: 'text/javascript', body: Buffer.from('A').toString('base64') },
      { method: 'GET', url: 'https://statics.cdn/app/f.woff2', status: 200, mimeType: 'font/woff2', body: Buffer.from('F').toString('base64') },
      { method: 'GET', url: 'https://statics.cdn/app/g.css', status: 200, mimeType: 'text/css', body: Buffer.from('C').toString('base64') },
      { method: 'GET', url: 'https://api.cdn/collect?v=2', status: 200, mimeType: 'application/json', body: Buffer.from('{}').toString('base64') },
    ];
    const loc = localizeQueryEntries({ entries, liveDir: live, host: 'x.test', origin: 'https://x.test' });
    assert.equal(loc.written, 3, 'JS / 字体 / CSS 都该落盘，JSON 接口不该');
    // 落盘位置按"域名 + 原路径"保留结构（目录层级所以是嵌套的，见 crossOriginRel）
    for (const [url, ext] of [['https://statics.cdn/app/chunks/a.js', 'js'], ['https://statics.cdn/app/f.woff2', 'woff2'], ['https://statics.cdn/app/g.css', 'css']]) {
      const pub = loc.map.get(url);
      assert.ok(pub.endsWith('.' + ext), url + ' 的落盘名该以 .' + ext + ' 结尾，实际 ' + pub);
      assert.equal(existsSync(join(live, pub.replace('/lm/x.test/', ''))), true, url + ' 的实体文件必须真的写下去了');
    }
    assert.equal(loc.map.get('https://api.cdn/collect?v=2'), undefined, '数据接口不该被本地化');
    // 页面里极常见的是**协议相对**写法，而 HAR 记的是绝对 URL ——
    // 少这一条，HTML 里的引用会原样留在外网
    assert.equal(loc.map.get('https://statics.cdn/app/chunks/a.js'), loc.map.get('//statics.cdn/app/chunks/a.js'));
    assert.ok(loc.map.get('//statics.cdn/app/f.woff2').startsWith('/lm/x.test/_ext/statics.cdn/'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: rewriteLocalRefs 必须改到 JS 里面（WebGL 驱动是应用自己拉的，HTML 里根本没有那个 URL）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-jsrw-'));
  try {
    const live = join(dir, 'live');
    mkdirSync(join(live, '_ext'), { recursive: true });
    writeFileSync(join(live, 'index.html'), '<script src="//statics.cdn/app/chunks/a.js"></script>');
    writeFileSync(join(live, '_ext', 'abc.js'),
      'import("https://statics.cdn/app/chunks/b.js");const f="https://statics.cdn/app/f.woff2";');
    writeFileSync(join(live, '_ext', 'abc.css'), '@font-face{src:url(https://statics.cdn/app/f.woff2)}');
    const map = new Map([
      ['https://statics.cdn/app/chunks/a.js', '/lm/x.test/_ext/a.js'],
      ['//statics.cdn/app/chunks/a.js', '/lm/x.test/_ext/a.js'],
      ['https://statics.cdn/app/chunks/b.js', '/lm/x.test/_ext/b.js'],
      ['https://statics.cdn/app/f.woff2', '/lm/x.test/_ext/f.woff2'],
    ]);
    const rw = rewriteLocalRefs({ liveDir: live, map });
    assert.equal(rw.files, 3, 'HTML / JS / CSS 三个文件都该被改到，实际 ' + rw.files);
    const js = readFileSync(join(live, '_ext', 'abc.js'), 'utf8');
    assert.ok(js.includes('/lm/x.test/_ext/b.js'), 'JS 内部拼的 URL 必须被改写');
    assert.ok(!js.includes('statics.cdn'), '一个外域残留都不该有');
    assert.ok(!readFileSync(join(live, '_ext', 'abc.css'), 'utf8').includes('statics.cdn'));
    assert.ok(!readFileSync(join(live, 'index.html'), 'utf8').includes('statics.cdn'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: absolute and relative navigation links survive external asset localization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-ad-link-'));
  try {
    const live = join(dir, 'live');
    const html = `<!doctype html><title>Ad links</title>
      <a href="https://ads.test/click?id=1&amp;source=site">Ad<img src="https://ads.test/banner.png"></a>
      <a href='//ads.test/offer'>Offer</a>
      <a href="/docs?next=https://cdn.test/logo.png&amp;return=/offer">Relative query</a>
      <area href="https://ads.test/map" alt="Map">
      <area href="../map?next=//ads.test/offer" alt="Relative map">
      <template><a href="https://ads.test/template-offer">Template offer</a></template>
      <form action="https://ads.test/submit"><button formaction="https://ads.test/button-submit">Submit</button>
        <input type="submit" formaction="//ads.test/input-submit"></form>
      <form action="submit?next=https://cdn.test/app.js"><button formaction="/submit?next=//ads.test/offer">Submit</button>
        <input type="submit" formaction="?next=https://ads.test/click"></form>
      <link rel="stylesheet" href="https://cdn.test/app.css">
      <script src="https://cdn.test/app.js"></script>
      <img src="//cdn.test/logo.png"><img src="https://unmapped.test/missing.png">`;
    mkdirSync(join(live, '_ext', 'ads.test'), { recursive: true });
    mkdirSync(join(live, '_ext', 'cdn.test'), { recursive: true });
    writeFileSync(join(live, 'index.html'), html);
    for (const path of ['ads.test/banner.png', 'cdn.test/app.css', 'cdn.test/app.js', 'cdn.test/logo.png']) {
      writeFileSync(join(live, '_ext', path), 'resource');
    }
    const map = new Map([
      ['https://ads.test/banner.png', '/lm/x.test/_ext/ads.test/banner.png'],
      ['https://ads.test/', '/lm/x.test/_ext/ads.test/'],
      ['//ads.test/', '/lm/x.test/_ext/ads.test/'],
      ['https://cdn.test/', '/lm/x.test/_ext/cdn.test/'],
      ['//cdn.test/', '/lm/x.test/_ext/cdn.test/'],
    ]);
    const changed = rewriteLocalRefs({ liveDir: live, map });
    assert.ok(changed.rewrites >= 4);
    const result = readFileSync(join(live, 'index.html'), 'utf8');
    assert.match(result, /href="https:\/\/ads\.test\/click\?id=1&amp;source=site"/);
    assert.match(result, /href='\/\/ads\.test\/offer'/);
    assert.match(result, /href="\/docs\?next=https:\/\/cdn\.test\/logo\.png&amp;return=\/offer"/,
      'relative navigation query must remain byte-for-byte unchanged');
    assert.match(result, /href="https:\/\/ads\.test\/map"/);
    assert.match(result, /href="\.\.\/map\?next=\/\/ads\.test\/offer"/);
    assert.match(result, /href="https:\/\/ads\.test\/template-offer"/);
    assert.match(result, /<form action="https:\/\/ads\.test\/submit"/);
    assert.match(result, /<button formaction="https:\/\/ads\.test\/button-submit"/);
    assert.match(result, /<input type="submit" formaction="\/\/ads\.test\/input-submit"/);
    assert.match(result, /<form action="submit\?next=https:\/\/cdn\.test\/app\.js"/);
    assert.match(result, /<button formaction="\/submit\?next=\/\/ads\.test\/offer"/);
    assert.match(result, /<input type="submit" formaction="\?next=https:\/\/ads\.test\/click"/);
    assert.doesNotMatch(result, /_ext\/ads\.test\/(?:click|offer|map|template-offer|submit|button-submit|input-submit)/);
    for (const path of ['ads.test/banner.png', 'cdn.test/app.css', 'cdn.test/app.js', 'cdn.test/logo.png']) {
      assert.ok(result.includes('/lm/x.test/_ext/' + path), path + ' should be local');
    }
    const health = scanLiveBundle({ liveDir: live, host: 'x.test', origin: 'https://x.test', harIndex: new Map() });
    assert.equal(health.assets.externalAssets, 1, 'the unmapped external image must remain a strict gap');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: mimeExt 对 .js 不能给出 .bin —— 后缀决定 serve.mjs 发的 Content-Type', () => {
  assert.equal(mimeExt('application/octet-stream', 'https://cdn.x/a.js'), 'js',
    '.bin 会让 serve.mjs 用 octet-stream 发出去，浏览器以 MIME 不符拒绝执行模块脚本');
  assert.equal(mimeExt('', 'https://cdn.x/doodle.riv'), 'riv');
  assert.equal(mimeExt('application/octet-stream', 'https://cdn.x/noext'), 'bin', '真的没有后缀才认 bin');
  assert.equal(mimeExt('text/javascript'), 'js');
  assert.equal(mimeExt('application/wasm'), 'wasm');
});

test('live/health: data-heimdall-poster 不能被当成真 poster —— 否则报出不存在的缺口，heal 还会去抓', () => {
  // 实测链条：我们给视频打的标记 `data-heimdall-poster="0"`（值是帧序号）被
  // 无边界正则读成 poster 属性 → health 报 3 个假缺口 → heal 去
  // https://www.moonshot.cn/0 抓，SPA 的 fallback 返回首页 → 交付包里多出 3 个
  // 295KB 的垃圾文件，而报告写着"已补齐 3 个"。
  const html = '<video src="/media/a.mp4" data-heimdall-poster="0"></video>'
    + '<video poster="/media/b.jpg"></video>'
    + '<script data-heimdall-src="9" src="/a.js"></script>';
  const urls = extractRefs(html, 'html').map(r => r.url);
  assert.ok(urls.includes('/media/a.mp4'));
  assert.ok(urls.includes('/media/b.jpg'), '真的 poster 必须认出来');
  assert.ok(urls.includes('/a.js'));
  assert.ok(!urls.includes('0'), '帧序号不是资源地址');
  assert.ok(!urls.includes('9'), 'data-* 前缀的属性名不该命中');
});

test('live/heal: 站外资源要保留原始目录结构 —— 兄弟相对路径（../chunks/x.js）才不会断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-ext-'));
  try {
    const live = join(dir, 'live');
    const entries = [
      { method: 'GET', url: 'https://statics.cdn/app/assets/entries/entry.js', status: 200, mimeType: 'text/javascript', body: Buffer.from('E').toString('base64') },
      { method: 'GET', url: 'https://statics.cdn/app/assets/chunks/chunk-X.js', status: 200, mimeType: 'text/javascript', body: Buffer.from('C').toString('base64') },
    ];
    const loc = localizeQueryEntries({ entries, liveDir: live, host: 'x.test', origin: 'https://x.test' });
    assert.equal(loc.written, 2);
    const entryPublic = loc.map.get('https://statics.cdn/app/assets/entries/entry.js');
    // 从落盘后的入口地址出发，按 Vite 清单里的写法解析依赖 —— 必须落在真正写下的文件上。
    // 拍平成 _ext/<sha1>.js 时这一步会解析到 /lm/x.test/chunks/chunk-X.js（404），
    // 于是模块链从中间断掉、WebGL hero 起不来。
    const dep = new URL('../chunks/chunk-X.js', 'http://x' + entryPublic).pathname;
    assert.equal(dep, '/lm/x.test/_ext/statics.cdn/app/assets/chunks/chunk-X.js');
    assert.equal(existsSync(join(live, dep.replace('/lm/x.test/', ''))), true, '相对引用必须能找到实体文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: 离线包把站外 CDN 的整站前缀接进本地镜像树（运行时拼出来的地址抓不到）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-pfx-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'heimdall-pfx2-'));
  try {
    const entries = [{ method: 'GET', url: 'https://statics.cdn/app/assets/chunks/chunk-X.js', status: 200, mimeType: 'text/javascript', body: Buffer.from('C').toString('base64') }];
    // 实测：断网时这些拼出来的地址以 `http://statics.cdn/...` 的形式被请求出去
    // （协议相对 + http 页面），文本里根本没有完整 URL 可替换。
    const off = localizeQueryEntries({ entries, liveDir: join(dir, 'live'), host: 'x.test', origin: 'https://x.test', hostPrefixes: true });
    assert.equal(off.map.get('//statics.cdn/'), '/lm/x.test/_ext/statics.cdn/', '协议相对前缀要接过去');
    assert.equal(off.map.get('http://statics.cdn/'), undefined, '另一个协议是独立 origin，不能复用 HTTPS 资产');
    assert.equal(off.map.get('https://statics.cdn/'), '/lm/x.test/_ext/statics.cdn/');
    // 前缀接过去之后，运行时拼出来的任意路径都落在保结构的镜像树里
    const built = new URL('assets/chunks/chunk-Y.js', 'http://x' + off.map.get('//statics.cdn/')).pathname;
    assert.equal(built, '/lm/x.test/_ext/statics.cdn/assets/chunks/chunk-Y.js');
    // 在线镜像不接前缀：未捕获的资源要留给回源，接过去会变成"本地 404"
    const on = localizeQueryEntries({ entries, liveDir: join(dir2, 'live'), host: 'x.test', origin: 'https://x.test' });
    assert.equal(on.map.get('//statics.cdn/'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('live/heal: same-host origins retain independent, Windows-safe resource paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-ext-origins-'));
  try {
    const urls = ['https://cdn.test/app.js', 'http://cdn.test/app.js', 'http://cdn.test:8081/app.js', 'http://cdn.test:8082/app.js'];
    const entries = urls.map((url, i) => ({ method: 'GET', url, status: 200, mimeType: 'text/javascript', body: Buffer.from(`asset-${i}`).toString('base64') }));
    const liveDir = join(dir, 'live');
    const result = localizeQueryEntries({ entries, liveDir, host: 'site-id', origin: 'https://main.test', hostPrefixes: true });
    assert.equal(result.written, 4);
    const paths = urls.map(url => result.map.get(url));
    assert.equal(new Set(paths).size, 4);
    for (const [i, path] of paths.entries()) {
      assert.doesNotMatch(path, /:/);
      assert.equal(readFileSync(join(liveDir, path.replace('/lm/site-id/', '')), 'utf8'), `asset-${i}`);
    }
    assert.equal(result.map.get('//cdn.test/'), '/lm/site-id/_ext/cdn.test/');
    assert.notEqual(result.map.get('http://cdn.test/'), result.map.get('https://cdn.test/'));
    assert.deepEqual(resolveRefPath('http://main.test/app.js', { host: 'site-id', origin: 'https://main.test' }), { external: true });
    assert.deepEqual(resolveRefPath('https://main.test:8443/app.js', { host: 'site-id', origin: 'https://main.test' }), { external: true });
    assert.deepEqual(resolveRefPath('https://main.test/app.js', { host: 'site-id', origin: 'https://main.test' }), { path: '/app.js', search: '' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: offline bundle removes only nonvisual external pixels from live and static HTML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-pixel-'));
  try {
    const live = join(dir, 'live', 'index.html');
    const staticClone = join(dir, 'static', 'clone', 'index.html');
    const html = '<!doctype html><html><body>'
      + '<img src="https://tracker.test/hit?order=1&amp;token=secret" width="1" height="1" style="display: none;" alt="Tracking beacon" border="0">'
      + '<img src="https://cdn.test/logo.png" alt="Visible logo">'
      + '<img src="https://cdn.test/tiny.png" width="1" height="1" alt="Small but visible">'
      + '<img src="https://cdn.test/callback.gif" width="1" height="1" style="display:none" onload="ready()">'
      + '<img src="https://cdn.test/widget.gif" width="1" height="1" style="display:none" data-widget="yes">'
      + '<img src="https://cdn.test/overridden.gif" width="1" height="1" style="display:none; display:block">'
      + '<img src="https://cdn.test/comment-override.gif" width="1" height="1" style="display:none; /* note */ display:block">'
      + '<img src="/local.gif" width="1" height="1" style="display:none">'
      + '<script src="https://cdn.test/app.js"></script>'
      + '<a href="https://tracker.test/offer">External navigation</a>'
      + '</body></html>';
    mkdirSync(dirname(live), { recursive: true });
    mkdirSync(dirname(staticClone), { recursive: true });
    writeFileSync(live, html);
    writeFileSync(staticClone, html);

    assert.deepEqual(removeNonvisualExternalPixels({ rootDir: dir, origin: 'https://source.test' }),
      { files: 2, removed: 2 });
    for (const path of [live, staticClone]) {
      const result = readFileSync(path, 'utf8');
      assert.doesNotMatch(result, /tracker\.test\/hit/);
      for (const required of ['cdn.test/logo.png', 'cdn.test/tiny.png', 'cdn.test/callback.gif',
        'cdn.test/widget.gif', 'cdn.test/overridden.gif', 'cdn.test/comment-override.gif',
        '/local.gif', 'cdn.test/app.js',
        'tracker.test/offer']) {
        assert.ok(result.includes(required), required + ' must remain');
      }
    }
    assert.deepEqual(removeNonvisualExternalPixels({ rootDir: dir, origin: 'https://source.test' }),
      { files: 0, removed: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live/heal: pixel omission refuses a symlinked directory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-pixel-link-'));
  try {
    const root = join(dir, 'bundle');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const externalHtml = join(outside, 'index.html');
    const original = '<img src="https://tracker.test/hit" width="1" height="1" style="display:none">';
    writeFileSync(externalHtml, original);
    try { symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('directory links unavailable');
      throw error;
    }
    assert.throws(() => removeNonvisualExternalPixels({ rootDir: root, origin: 'https://source.test' }), /symlink/);
    assert.equal(readFileSync(externalHtml, 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
