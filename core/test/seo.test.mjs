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

test('seo: severity counting and score math', () => {
  const issues = [{ severity: 'critical' }, { severity: 'high' }, { severity: 'medium' }, { severity: 'info' }];
  assert.deepEqual(countBySeverity(issues), { critical: 1, high: 1, medium: 1, low: 0, info: 1 });
  assert.equal(scoreIssues(issues), 100 - 25 - 12 - 6);
});
