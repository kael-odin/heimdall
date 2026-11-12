/**
 * SEO 规则引擎单测（纯函数，无网络/浏览器）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePage, evaluateSite, scoreIssues, countBySeverity } from '../src/seo/rules.mjs';

function page(over = {}) {
  return {
    url: 'https://example.com/pricing',
    finalUrl: 'https://example.com/pricing',
    status: 200,
    ok: true,
    redirectCount: 0,
    title: 'Pricing — Example',
    titleLength: 17,
    description: 'A clear description of the pricing page with enough characters to pass the minimum length check.',
    descriptionLength: 96,
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
});

test('seo: a healthy page has no high/critical issues and scores high', () => {
  const issues = evaluatePage(page(), site);
  assert.equal(issues.filter(i => i.severity === 'critical' || i.severity === 'high').length, 0, JSON.stringify(issues));
  assert.ok(scoreIssues(issues) >= 95, 'healthy page score: ' + scoreIssues(issues));
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
