/**
 * SEO 对标矩阵单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, siteAggregate, buildMatrix, renderMatrixHtml, renderMatrixCsv } from '../src/seo/matrix-core.mjs';

const audit = (host, specs) => ({
  host, score: 80,
  summary: { issues: specs.length * 3, bySeverity: { high: 1, medium: 1, low: 1, info: 0 } },
  pages: specs.map(s => ({
    url: `https://${host}${s.path}`, status: 200,
    titleLength: s.titleLen ?? 40, descriptionLength: s.descLen ?? 90,
    h1: ['H'], jsonld: s.jsonld === false ? [] : [{ ok: true, types: ['WebSite'] }],
    wordCount: s.words ?? 600, vitals: { lcp: s.lcp ?? 2000 },
    issues: [{ id: 'content-img-alt' }, { id: 'perf-cls-warn' }],
  })),
  siteIssues: [],
});

test('matrix: categorize common URL shapes', () => {
  assert.equal(categorize('https://x.test/'), 'home');
  assert.equal(categorize('https://x.test/pricing'), 'pricing');
  assert.equal(categorize('https://x.test/docs/getting-started'), 'docs');
  assert.equal(categorize('https://x.test/blog/post-1'), 'blog');
  assert.equal(categorize('https://x.test/use-cases/ai'), 'product');
  assert.equal(categorize('https://x.test/about'), 'company');
});

test('matrix: site aggregates compute rates and averages', () => {
  const a = audit('a.test', [{ path: '/', lcp: 1000, words: 400 }, { path: '/pricing', lcp: 3000, words: 800, descLen: 0 }]);
  const agg = siteAggregate(a);
  assert.equal(agg.pages, 2);
  assert.equal(agg.avgLcp, 2000);
  assert.equal(agg.avgWords, 600);
  assert.equal(agg.descRate, 50);
  assert.equal(agg.issuesPerPage, 3);
});

test('matrix: buildMatrix groups page types and top issues', () => {
  const m = buildMatrix([
    audit('a.test', [{ path: '/' }, { path: '/pricing' }]),
    audit('b.test', [{ path: '/' }, { path: '/docs/x', jsonld: false }]),
  ]);
  assert.equal(m.sites.length, 2);
  const home = m.rows.find(r => r.type === 'home');
  assert.ok(home && home.cells.every(c => c.pages === 1));
  const docs = m.rows.find(r => r.type === 'docs');
  assert.ok(docs && docs.cells[1].pages === 1);
  assert.ok(m.topIssues[0].top.some(t => t.id === 'content-img-alt'));
});

test('matrix: html and csv render all sites', () => {
  const m = buildMatrix([audit('a.test', [{ path: '/' }]), audit('b.test', [{ path: '/' }])]);
  const html = renderMatrixHtml(m);
  assert.ok(html.includes('a.test') && html.includes('b.test'));
  assert.ok(html.includes('站点分'));
  const csv = renderMatrixCsv(m);
  assert.ok(csv.includes('site_score'));
  assert.ok(csv.includes('a.test'));
});
