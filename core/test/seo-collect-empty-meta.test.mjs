/**
 * SEO 采集：缺失的元数据必须保持"缺失"。
 *
 * 此前页内的 abs() 对空串也做 new URL('', location.href)，结果是页面自身地址：
 * 没有 canonical / og:image / twitter:image 的页面采集出来反而"都有值"，
 * index-canonical-missing 与 structured-og-image 两条规则对真实页面永远不会触发。
 * 而规则单测都是手工构造 page 对象，恰好绕开了采集层，所以一直没被发现。
 *
 * 这条用例走真实的 collectPage → evaluatePage，守住整条链路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { collectPage } from '../src/seo/collect.mjs';
import { evaluatePage } from '../src/seo/rules.mjs';
import { scoreIssues } from '../src/seo/rules.mjs';
import { siteAggregate } from '../src/seo/matrix-core.mjs';
import { SEO_MEASUREMENT_VERSION } from '../src/seo/method.mjs';

const BARE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bare page without social or canonical tags</title>
<meta name="description" content="A page that deliberately omits canonical, og:image and twitter:image, and uses a relative hreflang.">
<link rel="alternate" hreflang="fr" href="/fr/">
</head><body><h1>Bare</h1><p>some body text some body text some body text</p></body></html>`;

const COMPLETE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Complete page with canonical and images</title>
<link rel="canonical" href="/complete">
<meta property="og:image" content="/og.png"><meta name="twitter:image" content="/tw.png">
<link rel="alternate" hreflang="en" href="{{ORIGIN}}/complete">
</head><body><h1>Complete</h1><p>some body text some body text some body text</p></body></html>`;

async function withPages(t, fn) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // 端口是动态的，所以对照页的 hreflang 用请求的 Host 现场拼成绝对地址
    res.end((req.url.startsWith('/complete') ? COMPLETE : BARE).replaceAll('{{ORIGIN}}', `http://${req.headers.host}`));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  return fn(browser, `http://127.0.0.1:${server.address().port}`);
}

const idsOf = page => evaluatePage(page, { host: new URL(page.url).host }).map(i => i.id);

test('采集：缺少 canonical / og:image / twitter:image 时保持空串，规则能报缺失', async t => {
  await withPages(t, async (browser, origin) => {
    const page = await collectPage(browser, `${origin}/bare`, { settleMs: 50 });
    assert.equal(page.canonical, '', 'canonical 不该被填成页面自身地址');
    assert.equal(page.og.image, '');
    assert.equal(page.twitter.image, '');
    const ids = idsOf(page);
    assert.ok(ids.includes('index-canonical-missing'), `应报缺少 canonical：${ids}`);
    assert.ok(ids.includes('structured-og-image'), `应报缺少 og:image：${ids}`);
  });
});

test('采集：相对地址的 canonical / 图片仍按页面地址绝对化，不误报缺失', async t => {
  await withPages(t, async (browser, origin) => {
    const page = await collectPage(browser, `${origin}/complete`, { settleMs: 50 });
    assert.equal(page.canonical, `${origin}/complete`);
    assert.equal(page.og.image, `${origin}/og.png`);
    assert.equal(page.twitter.image, `${origin}/tw.png`);
    const ids = idsOf(page);
    assert.ok(!ids.includes('index-canonical-missing'));
    assert.ok(!ids.includes('structured-og-image'));
  });
});

test('采集：hreflang 的 href 绝对化，同时保留标签原值，使"相对地址"规则对真实页面生效', async t => {
  await withPages(t, async (browser, origin) => {
    const page = await collectPage(browser, `${origin}/bare`, { settleMs: 50 });
    assert.deepEqual(page.hreflang, [{ lang: 'fr', href: `${origin}/fr/`, rawHref: '/fr/' }]);
    assert.ok(idsOf(page).includes('index-hreflang-relative'), '标签写的是 /fr/，应被判为相对地址');

    // 对照：标签本来就写绝对地址的页面不该被报
    const ok = await collectPage(browser, `${origin}/complete`, { settleMs: 50 });
    assert.equal(ok.hreflang[0].rawHref, `${origin}/complete`);
    assert.ok(!idsOf(ok).includes('index-hreflang-relative'));
  });
});

test('采集：资源体积按用途分类，预加载图片不能算成 CSS', { timeout: 30_000 }, async t => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=', 'base64');
  const server = createServer((req, res) => {
    if (req.url === '/pixel.png' || req.url === '/pixel.css') {
      res.setHeader('content-type', 'image/png');
      return res.end(pixel);
    }
    if (req.url === '/style') {
      res.setHeader('content-type', 'text/css');
      return res.end('body { color: black; }');
    }
    if (req.url === '/script.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end("fetch('/data').catch(() => {});");
    }
    if (req.url === '/data') {
      res.setHeader('content-type', 'application/json');
      return res.end('{"ok":true}');
    }
    if (req.url === '/style-preload') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><link rel="preload" as="style" href="/style">');
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const extra = req.url === '/mixed'
      ? '<link rel="StyleSheet" href="/style"><link rel="preload" as="script" href="/script.js"><script src="/script.js"></script>'
      : '';
    const img = req.url === '/image-with-css-extension' ? '/pixel.css' : '/pixel.png';
    res.end(`<!doctype html><html><head><link rel="icon" href="data:,"><link rel="preload" as="image" href="${img}">${extra}</head><body><img src="${img}"></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const imageOnly = await collectPage(browser, `${origin}/image-only`, { settleMs: 150 });
  assert.ok(imageOnly.resources.imgBytes > 0);
  assert.equal(imageOnly.resources.cssBytes, 0, 'image preload must not be counted as CSS');

  const misleadingName = await collectPage(browser, `${origin}/image-with-css-extension`, { settleMs: 150 });
  assert.ok(misleadingName.resources.transferBytes > 0);
  assert.equal(misleadingName.resources.cssBytes, 0, 'explicit image use takes precedence over a CSS extension');

  const stylePreload = await collectPage(browser, `${origin}/style-preload`, { settleMs: 150 });
  assert.ok(stylePreload.resources.cssBytes > 0, 'extensionless style preload should be counted as CSS');

  const mixed = await collectPage(browser, `${origin}/mixed`, { settleMs: 150 });
  const { transferBytes, jsBytes, cssBytes, imgBytes, fontBytes } = mixed.resources;
  assert.ok(jsBytes > 0, 'script preload should be counted as JavaScript');
  assert.ok(cssBytes > 0, 'extensionless stylesheet should be counted as CSS');
  assert.ok(imgBytes > 0, 'image preload should be counted as an image');
  assert.ok(jsBytes + cssBytes + imgBytes + fontBytes <= transferBytes, 'these resources must not be double counted');
});

test('采集：不能仅因地址后缀把非脚本算成 JavaScript', { timeout: 30_000 }, async t => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=', 'base64');
  const largeImage = Buffer.concat([pixel, Buffer.alloc(1_100_000)]);
  const largeComment = `/*${'x'.repeat(1_100_000)}*/`;
  const pages = {
    image: '<img src="/image.js" alt="fixture">',
    preloadImage: '<link rel="preload" as="image" href="/image.js"><img src="/image.js" alt="fixture">',
    background: '<style>body { background-image: url("/image.js") }</style>',
    style: '<link rel="stylesheet" href="/style.js">',
    data: '<script>fetch("/data.js").catch(() => {})</script>',
    preloadData: '<link rel="preload" as="fetch" href="/data.js" crossorigin>',
    script: '<script src="/script.png"></script>',
    preloadScript: '<link rel="preload" as="script" href="/large-script">',
    moduleScript: '<link rel="modulepreload" href="/large-module">',
    ambiguousModule: '<link rel="modulepreload" href="/large-module"><link rel="preload" as="image" href="/large-module">',
  };
  const server = createServer((req, res) => {
    if (req.url === '/image.js') {
      res.setHeader('content-type', 'image/png');
      return res.end(largeImage);
    }
    if (req.url === '/style.js') {
      res.setHeader('content-type', 'text/css');
      return res.end(`${largeComment}body { color: black }`);
    }
    if (req.url === '/data.js') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: 'x'.repeat(1_100_000) }));
    }
    if (req.url === '/script.png' || req.url === '/large-script' || req.url === '/large-module') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(`${largeComment}window.fixtureLoaded = true;`);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><link rel="icon" href="data:,"><title>Fixture</title><h1>Fixture</h1>${pages[req.url.slice(1)] ?? ''}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const name of ['image', 'preloadImage', 'background', 'style', 'data', 'preloadData']) {
    await t.test(name, async () => {
      const page = await collectPage(browser, `${origin}/${name}`, { settleMs: 150 });
      assert.ok(page.resources.transferBytes > 1_048_576, 'the large resource must have loaded');
      if (name.includes('Image') || name === 'image') assert.equal(page.imgBroken, 0);
      assert.equal(page.resources.jsBytes, 0, `${name} is not a JavaScript resource`);
      assert.ok(!idsOf(page).includes('perf-js-large'), `${name} must not trigger the JavaScript warning`);
      if (name === 'image' || name === 'preloadImage') assert.ok(page.resources.imgBytes > 1_048_576);
      if (name === 'style') assert.ok(page.resources.cssBytes > 1_048_576);
      if (['background', 'data', 'preloadData'].includes(name)) assert.ok(page.resources.otherBytes > 1_048_576);
    });
  }
  for (const name of ['script', 'preloadScript', 'moduleScript']) {
    await t.test(name, async () => {
      const page = await collectPage(browser, `${origin}/${name}`, { settleMs: 150 });
      assert.ok(page.resources.jsBytes > 1_048_576, `${name} must be counted as JavaScript`);
      assert.ok(idsOf(page).includes('perf-js-large'));
      assert.equal(page.resources.imgBytes, 0, 'the script must not also be counted as an image');
    });
  }
  await t.test('ambiguousModule', async () => {
    const page = await collectPage(browser, `${origin}/ambiguousModule`, { settleMs: 150 });
    assert.ok(page.resources.otherBytes > 1_048_576);
    assert.equal(page.resources.jsBytes, 0, 'conflicting link uses must remain unclassified');
    assert.ok(!idsOf(page).includes('perf-js-large'));
  });
  const reference = await browser.newPage();
  await reference.goto(`${origin}/script`);
  assert.equal(await reference.evaluate(() => window.fixtureLoaded), true, 'the script with an image suffix executed');
  await reference.close();
});

test('采集：图片 URL 后缀与真实响应不一致时只报告后缀线索', { timeout: 30_000 }, async t => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/actually-gif.png') {
      res.setHeader('content-type', 'image/gif');
      return res.end(gif);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><link rel="icon" href="data:,"><title>Image format fixture</title><h1>Fixture</h1><img src="/actually-gif.png" alt="fixture">');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const collected = await collectPage(browser, origin, { settleMs: 50 });
  const observation = evaluatePage(collected, { host: new URL(origin).host }).find(i => i.id === 'perf-img-format');
  const reference = await browser.newPage();
  const imageResponse = reference.waitForResponse(response => response.url() === `${origin}/actually-gif.png`);
  await reference.goto(origin);
  assert.equal((await imageResponse).headers()['content-type'], 'image/gif');
  assert.deepEqual(await reference.locator('img').evaluate(img => ({ complete: img.complete, width: img.naturalWidth })), { complete: true, width: 1 });
  await reference.close();

  assert.ok(requests.includes('/actually-gif.png'));
  assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(collected.imgTotal, 1);
  assert.equal(collected.imgLegacy, 1);
  assert.equal(collected.imgBroken, 0);
  assert.match(observation.title, /地址后缀/);
  assert.match(observation.evidence, /未核验响应类型或图片编码/);
  assert.doesNotMatch(observation.message, /张为/);
});

test('采集：中文和表情的 DOM 与初始 HTML 区分代码单元、UTF-8 字节和网络大小', { timeout: 30_000 }, async t => {
  const source = `<!doctype html><html><head><meta charset="utf-8"><title>Unicode</title></head><body>汉字🙂<script>document.body.append(' 动态')</script><!--${'x'.repeat(21_000)}--></body></html>`;
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(source);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const collected = await collectPage(browser, url, { settleMs: 50 });
  const reference = await browser.newPage();
  await reference.goto(url);
  const dom = await reference.evaluate(() => ({ html: document.documentElement.outerHTML, text: document.body.innerText.replace(/\s+/g, ' ').trim() }));
  await reference.close();

  assert.equal(collected.htmlCodeUnits, dom.html.length);
  assert.equal(collected.htmlBytes, Buffer.byteLength(dom.html, 'utf8'));
  assert.ok(collected.htmlBytes > collected.htmlCodeUnits);
  assert.equal(collected.textRatio, dom.text.length / dom.html.length);
  assert.equal(collected.raw.source, 'navigation');
  assert.equal(collected.raw.codeUnits, source.length);
  assert.equal(collected.raw.bytes, Buffer.byteLength(source, 'utf8'));
  assert.notEqual(collected.raw.bytes, collected.htmlBytes, 'initial HTML and rendered DOM are distinct');

  const issues = evaluatePage(collected, { host: '127.0.0.1' });
  const observation = issues.find(i => i.id === 'content-text-ratio');
  assert.equal(observation.severity, 'info');
  assert.match(observation.evidence, /UTF-16/);
  assert.equal(scoreIssues(issues), scoreIssues(issues.filter(i => i.id !== observation.id)));
});

test('采集：JSON-LD 的顶层和 @graph 类型进入规则与矩阵，不把未检查的 RDFa 说成不存在', { timeout: 30_000 }, async t => {
  const cases = {
    direct: { ld: { '@context': 'https://schema.org', '@type': 'Organization', name: 'Fixture' }, types: ['Organization'] },
    graph: { ld: { '@context': 'https://schema.org', '@graph': [{ '@type': ['Organization', 'LocalBusiness'], name: 'Fixture' }] }, types: ['Organization', 'LocalBusiness'] },
    nested: { ld: [{ '@graph': { '@graph': [{ '@type': 'WebSite' }] } }], types: ['WebSite'] },
    both: { ld: { '@type': 'WebPage', '@graph': [{ '@type': 'Organization' }] }, types: ['WebPage', 'Organization'] },
    large: { ld: { '@graph': [...Array(100_001).fill({}), { '@type': 'WebSite' }] }, types: ['WebSite'] },
    empty: { ld: {}, types: [], missing: true },
    invalidType: { ld: { '@type': [null, 5, '', '  '] }, types: [], missing: true },
    broken: { raw: '{not json', types: [], missing: true, broken: true },
    microdata: { markup: '<div itemscope itemtype="https://schema.org/Organization"></div>', types: [] },
    rdfa: { markup: '<div vocab="https://schema.org/" typeof="Organization"></div>', types: [], missing: true },
  };
  const server = createServer((req, res) => {
    const fixture = cases[req.url.slice(1)];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const script = fixture.ld !== undefined || fixture.raw !== undefined
      ? `<script type="application/ld+json">${fixture.raw ?? JSON.stringify(fixture.ld)}</script>` : '';
    res.end(`<!doctype html><title>Fixture</title>${script}<h1>Fixture</h1>${fixture.markup ?? ''}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const [name, fixture] of Object.entries(cases)) {
    const page = await collectPage(browser, `${origin}/${name}`, { settleMs: 25 });
    assert.equal(page.ok, true, name);
    assert.deepEqual((page.jsonld[0]?.types ?? []).slice().sort(), fixture.types.slice().sort(), name);
    const issues = evaluatePage(page, { host: new URL(origin).host });
    const missing = issues.find(issue => issue.id === 'structured-none');
    assert.equal(Boolean(missing), Boolean(fixture.missing), name);
    assert.equal(issues.some(issue => issue.id === 'structured-jsonld-error'), Boolean(fixture.broken), name);
    if (name === 'rdfa') {
      assert.match(missing.title, /JSON-LD.*microdata/i);
      assert.match(missing.evidence, /RDFa/i);
    }
    const aggregate = siteAggregate({ pages: [page], measurementVersion: SEO_MEASUREMENT_VERSION, summary: { baselineEligible: true } });
    assert.equal(aggregate.jsonldRate, fixture.types.length ? 100 : 0, name);
  }
});
