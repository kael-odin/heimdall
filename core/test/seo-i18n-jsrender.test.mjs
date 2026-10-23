/**
 * SEO 新增规则：hreflang 国际定向 + JS 渲染依赖
 *
 * 两组的共同点：它们判的都是**服务端那份 HTML**，而不是浏览器执行完脚本之后的样子。
 * 所以每个用例都要显式构造 page.raw —— 也是提醒读的人：
 * 没有 raw 时这些规则必须安静（很多站抓不到原始 HTML）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePage } from '../src/seo/rules.mjs';
import { analyzeRawHtml } from '../src/seo/raw-html.mjs';

function page(over = {}) {
  return {
    url: 'https://example.com/pricing',
    finalUrl: 'https://example.com/pricing',
    status: 200, ok: true, redirectCount: 0,
    title: 'Pricing — Example', titleLength: 17,
    description: 'A clear description of the pricing page with enough characters to pass the minimum length check.',
    descriptionLength: 96,
    canonical: 'https://example.com/pricing',
    robotsMeta: '', xRobots: '', meta: { noindex: false, nofollow: false },
    lang: 'en', viewport: 'width=device-width, initial-scale=1',
    h1: ['Pricing'], headings: [{ level: 1, text: 'Pricing' }], headingLevels: [1], headingSkips: 0,
    wordCount: 800, textRatio: 0.2, htmlBytes: 40_000,
    imgTotal: 2, imgMissingAlt: 0, imgEmptyAlt: 1, imgBroken: 0, imgLegacy: 0, imgLazy: 1,
    links: { total: 10, internal: 8, external: 2, emptyAnchor: 0, hashOnly: 0, nofollowExternal: 0 },
    internalHrefs: ['https://example.com/'],
    jsonld: [{ ok: true, types: ['Product'] }], microdataCount: 0,
    og: { title: 'Pricing', description: 'desc', image: 'https://example.com/og.png' },
    twitter: { card: 'summary_large_image' },
    hreflang: [], raw: null,
    resources: { requests: 30, transferBytes: 800_000, jsBytes: 200_000, cssBytes: 40_000, imgBytes: 300_000, fontBytes: 0, renderBlocking: 2 },
    vitals: { lcp: 1800, cls: 0.02, fcp: 900 },
    security: { https: true, mixedContent: [], headers: { hsts: 'max-age=1', xcto: 'nosniff' } },
    ...over,
  };
}
const ids = (p) => evaluatePage(p, { host: 'example.com' }).map(i => i.id);
const has = (p, id) => ids(p).includes(id);

// ---------- hreflang ----------
test('hreflang: 无 hreflang 时不产生任何相关规则', () => {
  const out = ids(page({ hreflang: [] }));
  assert.ok(!out.some(i => i.startsWith('index-hreflang')), `不该有 hreflang 规则：${out.filter(i => i.includes('hreflang'))}`);
});

test('hreflang: 完整正确的一组不报警（含自指与 x-default）', () => {
  const p = page({
    hreflang: [
      { lang: 'en', href: 'https://example.com/pricing' },
      { lang: 'zh-CN', href: 'https://example.com/zh/pricing' },
      { lang: 'x-default', href: 'https://example.com/pricing' },
    ],
  });
  assert.ok(!has(p, 'index-hreflang-no-self'));
  assert.ok(!has(p, 'index-hreflang-relative'));
  assert.ok(!has(p, 'index-hreflang-invalid-code'));
  assert.ok(!has(p, 'index-hreflang-xdefault-missing'));
});

test('hreflang: 缺少自指条目 → medium', () => {
  const p = page({ hreflang: [{ lang: 'zh-CN', href: 'https://example.com/zh/pricing' }] });
  const issue = evaluatePage(p, { host: 'example.com' }).find(i => i.id === 'index-hreflang-no-self');
  assert.ok(issue, '应报缺少自指');
  assert.equal(issue.severity, 'medium');
});

test('hreflang: 自指可由 canonical 满足（不必等于当前 URL）', () => {
  const p = page({
    canonical: 'https://example.com/pricing',
    hreflang: [{ lang: 'en', href: 'https://www.example.com/pricing/' }],   // 去 www / 尾斜杠后同页
    hreflangNote: null,
  });
  assert.ok(!has(p, 'index-hreflang-no-self'), 'www 与尾斜杠差异不该判为缺少自指');
});

test('hreflang: 相对地址 → medium', () => {
  const p = page({ hreflang: [{ lang: 'en', href: '/pricing' }, { lang: 'zh-CN', href: '/zh/pricing' }] });
  assert.ok(has(p, 'index-hreflang-relative'));
});

test('hreflang: 采集层已把 href 绝对化时，按 rawHref（标签原值）判相对地址', () => {
  const p = page({
    hreflang: [
      { lang: 'en', href: 'https://example.com/pricing', rawHref: 'https://example.com/pricing' },
      { lang: 'zh-CN', href: 'https://example.com/zh/pricing', rawHref: '/zh/pricing' },
    ],
  });
  const issue = evaluatePage(p, { host: 'example.com' }).find(i => i.id === 'index-hreflang-relative');
  assert.ok(issue, '原值是相对地址，即使 href 已绝对化也要报');
  assert.match(issue.message, /^1 条/, '只有一条是相对地址');
  assert.match(issue.evidence, /zh-CN → \/zh\/pricing/, '证据展示标签原值而不是绝对化后的值');
});

test('hreflang: 非法语言码（下划线 / 单字母 / 空）→ low', () => {
  for (const bad of ['zh_CN', 'e', '', 'ZH-cn-extra-more']) {
    const p = page({ hreflang: [{ lang: bad, href: 'https://example.com/x' }] });
    assert.ok(has(p, 'index-hreflang-invalid-code'), `${JSON.stringify(bad)} 应被判非法`);
  }
});

test('hreflang: 合法语言码不误报', () => {
  for (const good of ['en', 'zh-CN', 'pt-BR', 'sr-Latn', 'zh-Hant-HK', 'es-419', 'x-default']) {
    const p = page({ hreflang: [{ lang: good, href: 'https://example.com/' }] });
    assert.ok(!has(p, 'index-hreflang-invalid-code'), `${good} 不该被判非法`);
  }
});

test('hreflang: 多条但无 x-default → low；单条不报', () => {
  const two = page({ hreflang: [{ lang: 'en', href: 'https://example.com/' }, { lang: 'zh-CN', href: 'https://example.com/zh' }] });
  assert.ok(has(two, 'index-hreflang-xdefault-missing'));
  const one = page({ hreflang: [{ lang: 'en', href: 'https://example.com/' }] });
  assert.ok(!has(one, 'index-hreflang-xdefault-missing'), '只有一条时不要求 x-default');
});

// ---------- JS 渲染依赖 ----------
test('JS 渲染: 没有 raw 时全部安静（抓不到原始 HTML 不是页面的错）', () => {
  const out = ids(page({ raw: null }));
  assert.ok(!out.some(i => i.startsWith('index-raw-') || i === 'content-js-dependent'));
});

test('JS 渲染: raw 取失败（ok:false）时也安静', () => {
  const out = ids(page({ raw: { ok: false, error: 'abort' } }));
  assert.ok(!out.some(i => i.startsWith('index-raw-') || i === 'content-js-dependent'));
});

test('JS 渲染: 正文只存在于渲染后 → high（这是 SPA 的核心问题）', () => {
  const p = page({
    wordCount: 1200,
    raw: { ok: true, bytes: 8000, title: 'Example', description: 'x'.repeat(80), wordCount: 20 },
  });
  const issue = evaluatePage(p, { host: 'example.com' }).find(i => i.id === 'content-js-dependent');
  assert.ok(issue);
  assert.equal(issue.severity, 'high');
});

test('JS 渲染: 服务端直出内容不误报', () => {
  const p = page({
    wordCount: 800,
    raw: { ok: true, bytes: 60_000, title: 'Pricing — Example', description: 'd', wordCount: 760 },
  });
  assert.ok(!has(p, 'content-js-dependent'));
});

test('JS 渲染: 阈值边界 —— 恰好 30% 不报，低于则报', () => {
  const at = page({ wordCount: 1000, raw: { ok: true, bytes: 1000, title: 't', description: 'd', wordCount: 300 } });
  assert.ok(!has(at, 'content-js-dependent'), '恰好 30% 不应报');
  const below = page({ wordCount: 1000, raw: { ok: true, bytes: 1000, title: 't', description: 'd', wordCount: 299 } });
  assert.ok(has(below, 'content-js-dependent'));
});

test('JS 渲染: 渲染后本身就没内容时不报（空页不是 JS 依赖）', () => {
  const p = page({ wordCount: 80, raw: { ok: true, bytes: 2000, title: 't', description: '', wordCount: 5 } });
  assert.ok(!has(p, 'content-js-dependent'));
});

test('JS 渲染: title / description 只在渲染后存在 → 分别报', () => {
  const t = page({ raw: { ok: true, bytes: 5000, title: '', description: 'ok', wordCount: 800 } });
  assert.ok(has(t, 'index-raw-title-missing'));
  assert.ok(!has(t, 'index-raw-description-missing'));
  const d = page({ raw: { ok: true, bytes: 5000, title: 'ok', description: '', wordCount: 800 } });
  assert.ok(!has(d, 'index-raw-title-missing'));
  assert.ok(has(d, 'index-raw-description-missing'));
});

// ---------- 原始 HTML 解析 ----------
test('analyzeRawHtml: 提取标题/描述/canonical/lang/viewport', () => {
  const r = analyzeRawHtml(`<!doctype html><html lang="zh-CN"><head>
    <title>测试页面</title>
    <meta name="description" content="描述文本">
    <meta name="viewport" content="width=device-width">
    <link rel="canonical" href="https://example.com/a">
  </head><body><h1>标题</h1></body></html>`);
  assert.equal(r.title, '测试页面');
  assert.equal(r.description, '描述文本');
  assert.equal(r.canonical, 'https://example.com/a');
  assert.equal(r.lang, 'zh-CN');
  assert.equal(r.viewport, 'width=device-width');
  assert.ok(r.ok);
});

test('analyzeRawHtml: 统计 h1 / 图片 / 链接 / 缺 alt', () => {
  const r = analyzeRawHtml(`<body>
    <h1>A</h1><h1>B</h1>
    <img src="/a.png"><img src="/b.png" alt="有">
    <a href="/x">内</a><a href="https://other.com/y">外</a>
  </body>`);
  assert.equal(r.h1Count, 2);
  assert.equal(r.imgCount, 2);
  assert.equal(r.imgMissingAlt, 1);
  assert.equal(r.anchorCount, 2);
});

test('analyzeRawHtml: script/style 内容不计入正文', () => {
  const r = analyzeRawHtml('<body><p>可见文字</p><script>var x = "不该被算作正文的字符串";</script><style>.a{color:red}</style></body>');
  assert.match(r.textLength > 0 ? 'has-text' : 'empty', /has-text/);
  assert.ok(!r.textLength || r.textLength < 40, `script/style 不应计入正文，实际 textLength=${r.textLength}`);
});

test('analyzeRawHtml: JSON-LD 与普通 script 分开计数', () => {
  const r = analyzeRawHtml(`<body>
    <script type="application/ld+json">{"@type":"Product"}</script>
    <script src="/app.js"></script><script>var a=1</script>
  </body>`);
  assert.equal(r.jsonLdCount, 1);
  assert.equal(r.scriptCount, 3);
});

test('analyzeRawHtml: 空输入 / 畸形 HTML 不抛错', () => {
  assert.equal(analyzeRawHtml('').ok, false);
  assert.equal(analyzeRawHtml(null).ok, false);
  const messy = analyzeRawHtml('<div><p>未闭合<span>也没关');
  assert.ok(messy.ok, '畸形 HTML 也要能解析出东西');
});

test('analyzeRawHtml: hreflang 从原始 HTML 也能取到', () => {
  const r = analyzeRawHtml('<link rel="alternate" hreflang="zh-CN" href="https://example.com/zh">');
  assert.deepEqual(r.hreflang, [{ lang: 'zh-CN', href: 'https://example.com/zh' }]);
});
