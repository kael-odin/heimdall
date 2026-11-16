/**
 * SEO 规则引擎单测（纯函数，无网络/浏览器）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePage, evaluateSite, scoreIssues, countBySeverity } from '../src/seo/rules.mjs';
import { parseRobots, robotsAllows } from '../src/seo/robots.mjs';
import { sampleOrder } from '../src/seo/collect.mjs';

function page(over = {}) {
  return {
    url: 'https://example.com/pricing',
    finalUrl: 'https://example.com/pricing',
    status: 200,
    ok: true,
    redirectCount: 0,
    title: 'Pricing — Example',
    titleLength: 17,
    description: 'A factual summary of the pricing page, available plans, billing terms, and usage limits.',
    descriptionLength: 88,
    canonical: 'https://example.com/pricing',
    robotsMeta: '',
    xRobots: '',
    meta: { noindex: false, nofollow: false },
    lang: 'en',
    viewport: 'width=device-width, initial-scale=1',
    h1: ['Pricing'],
    headings: [{ level: 1, text: 'Pricing' }, { level: 2, text: 'Plans' }],
    headingLevels: [1, 2],
    headingSkips: 0,
    wordCount: 800,
    textRatio: 0.2,
    htmlBytes: 40_000,
    imgTotal: 2, imgMissingAlt: 0, imgEmptyAlt: 1, imgBroken: 0, imgLegacy: 0, imgLazy: 1,
    links: { total: 10, internal: 8, external: 2, emptyAnchor: 0, hashOnly: 0, nofollowExternal: 0 },
    internalHrefs: ['https://example.com/'],
    jsonld: [{ ok: true, types: ['Product'] }],
    microdataCount: 0,
    og: { title: 'Pricing', description: 'desc', image: 'https://example.com/og.png' },
    twitter: { card: 'summary_large_image' },
    hreflang: [],
    resources: { requests: 30, transferBytes: 800_000, jsBytes: 200_000, cssBytes: 40_000, imgBytes: 300_000, fontBytes: 0, renderBlocking: 2 },
    vitals: { lcp: 1800, cls: 0.02, fcp: 900 },
    security: { https: true, mixedContent: [], headers: { hsts: 'max-age=31536000', xcto: 'nosniff' } },
    depth: 1,
    ...over,
  };
}
const site = { host: 'example.com', sitemapUrls: new Set(['https://example.com/pricing']), robots: { ok: true }, duplicates: {}, orphans: [] };

test('seo: duplicate titles and descriptions are optional only within one valid pagination series', () => {
  for (const [urls, severity] of [
    [['https://s.test/blog?page=2', 'https://s.test/blog?page=3'], 'info'],
    [['https://s.test/blog', 'https://s.test/blog?page=2', 'https://s.test/blog?page=3'], 'info'],
    [['https://s.test/blog/', 'https://s.test/blog/page/2/', 'https://s.test/blog/page/3/'], 'info'],
    [['https://s.test/blog/page/2/', 'https://s.test/blog/page/3/'], 'info'],
    [['https://s.test/blog?page=2#top', 'https://s.test/blog?page=3'], 'info'],
    [['https://s.test/blog?page=2', 'https://s.test/other?page=3'], 'medium'],
    [['https://s.test/blog?page=2', 'https://s.test/blog?page=3&sort=new'], 'medium'],
    [['https://s.test/blog?page=2', 'http://s.test/blog?page=3'], 'medium'],
    [['https://s.test/blog?page=2', 'https://www.s.test/blog?page=3'], 'medium'],
    [['https://s.test/blog?page=2', 'https://s.test/blog?page=invalid'], 'medium'],
    [['https://s.test/blog?page=2', 'https://s.test/blog?page=1e2'], 'medium'],
    [['https://s.test/blog?page=2', 'https://s.test/blog?page=3&page=4'], 'medium'],
    [['https://s.test/blog', 'https://s.test/other'], 'medium'],
    [['https://s.test/blog', 'https://s.test/blog/?page=2'], 'medium'],
  ]) {
    const issues = evaluateSite({ duplicates: { title: { shared: urls }, description: { shared: urls } } });
    assert.equal(issues.find(issue => issue.id === 'content-title-duplicate').severity, severity, urls.join(' '));
    assert.equal(issues.find(issue => issue.id === 'content-description-duplicate').severity, severity, urls.join(' '));
  }
  assert.ok(!evaluatePage(page({ url: 'https://example.com/blog?page=2', meta: { noindex: true } }), { ...site, noindexIntent: true })
    .some(issue => issue.id === 'index-pagination-noindex'));
  const siteIssues = evaluateSite({ duplicates: { description: { shared: ['https://s.test/a', 'https://s.test/b'] } } });
  assert.deepEqual(siteIssues.find(issue => issue.id === 'content-description-duplicate').pages,
    ['https://s.test/a', 'https://s.test/b']);
});

test('seo: a healthy page has no high/critical issues and scores high', () => {
  const issues = evaluatePage(page(), site);
  assert.equal(issues.filter(i => i.severity === 'critical' || i.severity === 'high').length, 0, JSON.stringify(issues));
  assert.ok(scoreIssues(issues) >= 95, 'healthy page score: ' + scoreIssues(issues));
  for (const canonical of ['https://other.example/copy', 'https://example.com/pricing?plan=annual', 'https://example.com/pricing/', 'http://example.com/pricing']) {
    const observed = evaluatePage(page({ canonical }), site);
    const declarations = observed.filter(issue => issue.id.startsWith('index-canonical'));
    assert.ok(declarations.length > 0, canonical);
    assert.ok(declarations.every(issue => issue.severity === 'info'), canonical);
    assert.equal(scoreIssues(observed), scoreIssues(issues), canonical);
  }
});

test('seo: missing title/h1/viewport and thin content are detected', () => {
  const issues = evaluatePage(page({ title: '', titleLength: 0, h1: [], headingLevels: [2], headingSkips: 0, viewport: '', wordCount: 120 }), site);
  const ids = issues.map(i => i.id);
  assert.ok(ids.includes('content-title-missing'));
  assert.ok(ids.includes('content-h1-missing'));
  assert.ok(ids.includes('perf-viewport-missing'));
  assert.ok(ids.includes('content-thin'));
  assert.ok(scoreIssues(issues) < 60, 'score should drop: ' + scoreIssues(issues));
});

test('seo: noindex and non-https are flagged', () => {
  const issues = evaluatePage(page({ meta: { noindex: true, nofollow: false }, robotsMeta: 'noindex', security: { https: false, mixedContent: [], headers: {} } }), site);
  const ids = issues.map(i => i.id);
  assert.ok(ids.includes('index-noindex'));
  assert.ok(ids.includes('index-not-https'));
});

test('seo: a short body is an observation, not evidence of a ranking defect', () => {
  for (const wordCount of [0, 25, 299]) {
    const issues = evaluatePage(page({ wordCount }), site);
    assert.equal(issues.find(i => i.id === 'content-thin').severity, 'info');
    assert.equal(scoreIssues(issues), scoreIssues(issues.filter(i => i.id !== 'content-thin')));
  }
});

test('seo: metadata length is an unscored review hint and missing metadata remains a defect', () => {
  for (const [field, cases] of [
    ['title', [['豆瓣', 'short'], ['A'.repeat(9), 'short'], ['A'.repeat(10), null], ['A'.repeat(60), null], ['A'.repeat(61), 'long']]],
    ['description', [['图书、电影与音乐的推荐和评论。', 'short'], ['A'.repeat(49), 'short'], ['A'.repeat(50), null], ['A'.repeat(160), null], ['A'.repeat(161), 'long']]],
  ]) {
    for (const [value, lengthHint] of cases) {
      const issues = evaluatePage(page({ [field]: value, [`${field}Length`]: value.length }), site);
      const hints = issues.filter(i => i.id.startsWith(`content-${field}-`) && /-(short|long)$/.test(i.id));
      assert.deepEqual(hints.map(i => [i.id, i.severity]), lengthHint ? [[`content-${field}-${lengthHint}`, 'info']] : []);
      assert.equal(scoreIssues(issues), scoreIssues(evaluatePage(page(), site)), `${field}: ${value.length}`);
      if (lengthHint) assert.match(hints[0].evidence, /人工检查提示/);
    }
    const issues = evaluatePage(page({ [field]: '', [`${field}Length`]: 0 }), site);
    const missing = issues.find(i => i.id === `content-${field}-missing`);
    assert.equal(missing.severity, field === 'title' ? 'critical' : 'high');
    assert.ok(scoreIssues(issues) < scoreIssues(issues.filter(i => i !== missing)));
  }
});

test('seo: slow vitals and heavy resources are flagged', () => {
  const issues = evaluatePage(page({ vitals: { lcp: 5200, cls: 0.31, fcp: 3500 }, resources: { requests: 150, transferBytes: 5_000_000, jsBytes: 2_000_000, cssBytes: 50_000, imgBytes: 0, fontBytes: 0, renderBlocking: 8 } }), site);
  const ids = issues.map(i => i.id);
  assert.ok(ids.includes('perf-lcp-poor'));
  assert.ok(ids.includes('perf-cls-poor'));
  assert.ok(ids.includes('perf-weight-large'));
  assert.ok(ids.includes('perf-js-large'));
  assert.match(issues.find(i => i.id === 'perf-weight-large').evidence, /不含主文档/);
  assert.match(issues.find(i => i.id === 'perf-js-large').evidence, /可能不完整/);
});

test('seo: image format observation describes URL suffixes, not decoded formats', () => {
  const input = page({ imgTotal: 3, imgLegacy: 2 });
  const issues = evaluatePage(input, site);
  const observation = issues.find(i => i.id === 'perf-img-format');
  assert.equal(observation.severity, 'info');
  assert.match(observation.title, /地址后缀/);
  assert.match(observation.message, /2\/3.*图片元素.*地址/);
  assert.match(observation.evidence, /未核验响应类型或图片编码/);
  assert.match(observation.evidence, /重复或未加载/);
  assert.equal(scoreIssues(issues), scoreIssues(issues.filter(i => i !== observation)));
  assert.equal(evaluatePage(page({ imgTotal: 4, imgLegacy: 2 }), site).some(i => i.id === 'perf-img-format'), false);
});

test('seo: site-level duplicates, sitemap gaps and orphans are flagged', () => {
  const a = page({ url: 'https://example.com/a', finalUrl: 'https://example.com/a', title: 'Same', canonical: 'https://example.com/a' });
  const b = page({ url: 'https://example.com/b', finalUrl: 'https://example.com/b', title: 'Same', canonical: 'https://example.com/b', depth: 1, internalHrefs: [] });
  const s = {
    host: 'example.com',
    pages: [a, b],
    sitemapUrls: new Set(['https://example.com/a']),
    robots: { ok: false, status: 404, sitemaps: [] },
    sitemapCoverage: 'complete',
    duplicates: { title: { Same: [a.url, b.url] }, description: {}, h1: {} },
    orphans: [b.url],
  };
  const issues = evaluateSite(s);
  const ids = issues.map(i => i.id);
  assert.ok(ids.includes('content-title-duplicate'));
  assert.ok(ids.includes('links-orphan'));
  assert.ok(ids.includes('index-sitemap-missing-page'));
  assert.ok(ids.includes('index-robots-missing'));
});

test('seo: alias addresses of one page are a canonical problem, not duplicate metadata', () => {
  const urls = ['https://example.com/', 'https://example.com/index.html'];
  const pages = urls.map(url => page({ url, finalUrl: url, canonical: '' }));
  const duplicates = { title: { Home: urls }, description: { Same: urls }, text: { 'abc:300': urls } };
  const ids = (input) => evaluateSite(input).map(issue => issue.id);
  assert.deepEqual(ids({ pages, duplicates }), ['content-duplicate'], 'duplicate title and description are symptoms of the same cause');
  assert.deepEqual(ids({ pages: pages.map(p => ({ ...p, canonical: urls[0] })), duplicates }), [], 'one shared canonical already resolves the aliases');
  assert.deepEqual(ids({ pages: [pages[0], { ...pages[1], canonical: urls[1] }], duplicates }), ['content-duplicate']);
  const third = [...urls, 'https://example.com/page-2.html'];
  assert.deepEqual(ids({ pages, duplicates: { title: { Home: third }, text: { 'abc:300': urls } } }), ['content-duplicate', 'content-title-duplicate'],
    'aliases count once; another page sharing the title is still reported');
  const wall = ['https://example.com/', 'https://example.com/signin?next=%2Ffollow'];
  assert.deepEqual(ids({ pages: wall.map(url => page({ url, finalUrl: url })), duplicates: { text: { 'abc:300': wall } } }), [],
    'the same body at unrelated paths is usually a login wall, not an address to merge');
  const spelled = [page({ url: 'https://example.com/news', finalUrl: 'https://example.com/news/' }), page({ url: 'https://example.com/news/', finalUrl: 'https://example.com/news/' })];
  assert.deepEqual(ids({ pages: spelled, duplicates: { text: { 'abc:300': spelled.map(p => p.url) } } }), [], 'two spellings that land on one address are one page');
});

test('seo: robots.txt rules follow RFC 9309 and gate Googlebot crawling', () => {
  const groups = parseRobots(['# staging', 'User-agent: *', 'Disallow: /private/', 'Allow: /private/press', 'Disallow: /*.pdf$', 'Disallow:', '',
    'User-agent: GPTBot', 'User-agent: PerplexityBot', 'Disallow: /'].join('\n'));
  const allowed = (token, path) => robotsAllows(groups, token, 'https://example.com' + path).allowed;
  assert.equal(allowed('Googlebot', '/pricing'), true);
  assert.equal(allowed('Googlebot', '/private/a'), false);
  assert.equal(allowed('Googlebot', '/private/press/2026'), true, 'the longest matching rule wins');
  assert.equal(allowed('Googlebot', '/files/a.pdf'), false);
  assert.equal(allowed('Googlebot', '/files/a.pdf?download=1'), true, '$ anchors the end of the address');
  assert.equal(allowed('perplexitybot', '/private/press'), false, 'a group that names the crawler replaces the * group');
  assert.deepEqual(robotsAllows(groups, 'GPTBot', 'https://example.com/pricing'), { allowed: false, rule: 'Disallow: /', agent: 'gptbot' });
  const at = (path, robots) => evaluatePage(page({ url: 'https://example.com' + path, finalUrl: 'https://example.com' + path }), { ...site, robots })
    .find(issue => issue.id === 'index-robots-blocked');
  assert.equal(at('/private/a', { ok: true, groups })?.severity, 'high');
  assert.match(at('/private/a', { ok: true, groups }).message, /User-agent: \* 分组的 Disallow: \/private\//);
  assert.equal(at('/pricing', { ok: true, groups }), undefined);
  for (const robots of [{ ok: false, status: 503 }, { ok: false, status: 429 }, { ok: false, status: 404 }, undefined]) {
    assert.equal(at('/private/a', robots), undefined, 'no rules were read, so nothing is reported as blocked');
  }
});

test('seo: a redirect that only adds the trailing slash is not charged to a normalised audit address', () => {
  const hop = { url: 'https://example.com/news', finalUrl: 'https://example.com/news/', redirectCount: 1, canonical: 'https://example.com/news/' };
  const redirect = (over) => evaluatePage(page({ ...hop, ...over }), site).some(issue => issue.id === 'index-redirect');
  assert.equal(redirect({}), false);
  assert.equal(redirect({ urlGiven: true }), true, 'an address the site itself links or lists does redirect');
  assert.equal(redirect({ finalUrl: 'https://example.com/blog/' }), true);
  assert.equal(redirect({ redirectCount: 2 }), true);
});

test('seo: a page quota is spread over page types instead of the first N addresses', () => {
  const urls = ['/en/download/a', '/en/download/b', '/en/download/c', '/en/blog', '/en/blog/x/1', '/en/blog/x/2', '/zh/about', '/en/about', '/fr/about']
    .map(path => 'https://example.com' + path);
  const paths = (entry) => sampleOrder(urls, 'https://example.com' + entry).map(url => new URL(url).pathname);
  assert.deepEqual(paths('/en').slice(0, 5), ['/en/download/a', '/en/blog', '/en/blog/x/1', '/en/about', '/en/download/b'],
    'the entry section comes first and each page type takes one turn');
  assert.deepEqual(paths('/en').slice(-2), ['/zh/about', '/fr/about'], 'other sections only fill what is left');
  assert.deepEqual(paths('/en/blog/x/1').slice(0, 2), ['/en/blog/x/1', '/en/blog/x/2'], 'a leaf entry scopes to its own directory');
  assert.deepEqual(paths('/').slice(0, 4), ['/en/download/a', '/en/blog', '/en/blog/x/1', '/zh/about']);
});

test('seo: missing robots and unlocated sitemap are observations, not automatic score penalties', () => {
  for (const status of [404, 410]) {
    const issues = evaluateSite({ robots: { status }, sitemapCoverage: 'not_found' });
    const robots = issues.find(i => i.id === 'index-robots-missing');
    const sitemap = issues.find(i => i.id === 'index-sitemap-missing');
    assert.equal(robots?.severity, 'info');
    assert.match(robots.message, new RegExp(String(status)));
    assert.match(robots.evidence, /Googlebot/);
    assert.equal(sitemap?.severity, 'info');
    assert.match(sitemap.evidence, /其他位置|其他途径/);
    assert.equal(scoreIssues(issues), 100);
  }
  for (const status of [200, 401, 403, 429, 500, null]) {
    const issues = evaluateSite({ robots: { status }, sitemapCoverage: 'unavailable' });
    assert.ok(!issues.some(i => i.id === 'index-robots-missing' || i.id === 'index-sitemap-missing'), String(status));
  }
});

test('seo: severity counting and score math', () => {
  const issues = [{ severity: 'critical' }, { severity: 'high' }, { severity: 'medium' }, { severity: 'info' }];
  assert.deepEqual(countBySeverity(issues), { critical: 1, high: 1, medium: 1, low: 0, info: 1 });
  assert.equal(scoreIssues(issues), 100 - 25 - 12 - 6);
});
