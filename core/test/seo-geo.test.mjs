import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateGeoPage, evaluateGeoSite, GEO_DIMENSIONS, GEO_METHOD_VERSION } from '../src/seo/geo.mjs';

const page = (over = {}) => ({
  url: 'https://example.com/guide',
  status: 200, ok: true,
  title: 'Proxy guide',
  description: 'A factual guide that explains the proxy workflow, limits, setup steps, and expected results.',
  canonical: 'https://example.com/guide',
  lang: 'en',
  h1: ['Proxy guide'],
  headings: [{ level: 1, text: 'Proxy guide' }, { level: 2, text: 'Setup' }],
  wordCount: 420,
  meta: { noindex: false, nosnippet: false },
  robotsEvidence: { target: 'googlebot', initialHtml: 'checked', noindex: [], nofollow: [], nosnippet: [] },
  links: { external: 2 },
  microdataCount: 0,
  jsonld: [{
    semanticStatus: 'complete',
    types: ['Article'],
    items: [{
      '@type': 'Article', name: 'Proxy guide',
      author: { name: 'Example team' }, datePublished: '2026-11-01',
    }],
  }],
  raw: { ok: true, wordCount: 360, source: 'navigation' },
  ...over,
});

test('GEO 引用维度权重与页面总权重一致', () => {
  const citation = evaluateGeoPage(page()).dimensions.citation;
  assert.equal(GEO_DIMENSIONS.citation.weight, 20);
  assert.equal(citation.checks.reduce((sum, check) => sum + check.weight, 0), 20);
});

test('GEO 健康页面得分高且四个维度都有证据', () => {
  const result = evaluateGeoPage(page());
  assert.equal(result.score, 100);
  assert.equal(result.grade, 'A');
  assert.equal(result.confidence, 'high');
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.actionPlan, []);
  assert.deepEqual(Object.keys(result.dimensions), ['answerability', 'extractability', 'entity', 'citation']);
  assert.ok(Object.values(result.dimensions).every(dimension => dimension.score === 100));
  const empty = evaluateGeoPage(page({ wordCount: 0, raw: { ok: true, wordCount: 0, source: 'navigation' } }));
  assert.equal(empty.dimensions.answerability.checks.find(item => item.id === 'geo-answer-server-visible').status, 'fail');
});

test('GEO: short initial HTML is visible when it contains the rendered body', () => {
  const check = (wordCount, rawCount) => evaluateGeoPage(page({ wordCount,
    raw: { ok: true, source: 'navigation', wordCount: rawCount } })).dimensions.answerability.checks
    .find(item => item.id === 'geo-answer-server-visible');
  for (const n of [1, 25, 39]) assert.equal(check(n, n).status, 'pass');
  assert.equal(check(25, 0).status, 'fail');
  assert.equal(check(800, 25).status, 'fail');
  assert.equal(check(undefined, 25).status, 'unknown');
});

test('GEO description presence does not claim summary quality or require fifty characters', () => {
  for (const description of ['', '   ', undefined, null, 42, {}, '图书、电影与音乐的推荐和评论。', 'A'.repeat(49), 'A'.repeat(50), 'A'.repeat(161)]) {
    const result = evaluateGeoPage(page({ description }));
    const check = result.dimensions.citation.checks.find(item => item.id === 'geo-citation-description');
    assert.equal(check.status, typeof description === 'string' && description.trim() ? 'pass' : 'fail');
    assert.match(check.title, /摘要有值/);
    assert.match(check.message, /未核实摘要质量或实际引用/);
    assert.doesNotMatch(check.suggestion, /50|160|足够/);
  }
});

test('GEO 缺陷页面保留具体问题，na 和 unknown 不误报成失败', () => {
  const result = evaluateGeoPage(page({
    url: 'https://example.com/app', title: '', description: '', canonical: '', lang: '', h1: [], headings: [],
    wordCount: 20, meta: { noindex: true }, links: { external: 0 }, jsonld: [], raw: { ok: true, wordCount: 0 },
  }));
  const ids = result.issues.map(issue => issue.id);
  assert.ok(result.score < 60, `缺陷页面分数不应过高: ${result.score}`);
  assert.ok(ids.includes('geo-answer-title'));
  assert.ok(ids.includes('geo-extract-structure'));
  assert.ok(ids.includes('geo-citation-discoverable'));
  assert.ok(result.unknown.some(item => item.id === 'geo-citation-links'));
  assert.ok(!ids.includes('geo-citation-freshness'), '非文章页面的时间检查应为 na，不应误报');
  const firstAction = result.actionPlan[0];
  assert.equal(firstAction.priority, 'P0');
  assert.equal(firstAction.impact.affectedPages, 1);
  assert.equal(firstAction.evidenceLevel, 'observed');
  assert.equal(firstAction.validation.method, 'rerun-geo-audit');
  assert.ok(['small', 'medium', 'large'].includes(firstAction.estimatedEffort));
});

test('GEO Google 索引和摘要限制独立于 canonical，旧采集保留未知', () => {
  const check = value => evaluateGeoPage(page(value)).dimensions.citation.checks.find(item => item.id === 'geo-citation-discoverable');
  assert.equal(check({ canonical: '' }).status, 'pass');
  assert.equal(check({ meta: { noindex: false, nosnippet: true } }).status, 'fail');
  assert.equal(check({ meta: { noindex: false } }).status, 'unknown');
  assert.equal(check({ robotsEvidence: undefined }).status, 'unknown');
  assert.equal(check({ raw: { ok: true, source: 'refetch', wordCount: 360 } }).status, 'unknown');
  assert.match(check({ meta: { noindex: false, nosnippet: true } }).title, /Google/);
});

test('GEO 仅首次导航响应能证明初始 HTML，未知证据贯通站点维度', () => {
  for (const raw of [null, { ok: true, wordCount: 360 }, { ok: true, wordCount: 360, source: 'refetch' }]) {
    const result = evaluateGeoSite({ pages: [page({ raw })] });
    const dimension = result.pages[0].dimensions.answerability;
    assert.equal(dimension.checks.find(item => item.id === 'geo-answer-server-visible').status, 'unknown');
    assert.equal(result.status, 'partial');
    assert.equal(result.dimensions.answerability.status, 'partial');
    assert.equal(result.coverage.ratio, 0.88);
    assert.deepEqual(result.actionPlan, []);
  }
});

test('GEO 采集失败和 HTTP 错误页不生成内容整改，混合站点保留缺口', () => {
  for (const status of [0, 401, 403, 404, 429, 500]) {
    const failed = page({ url: 'https://example.com/failed', status, ok: false });
    const result = evaluateGeoPage(failed);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.score, null);
    assert.equal(result.grade, null);
    assert.equal(result.confidence, 'low');
    assert.equal(result.coverage.observedWeight, 0);
    assert.deepEqual(result.actionPlan, []);
    assert.ok(Object.values(result.dimensions).every(d => d.status === 'unknown'));
    assert.ok(Object.values(result.dimensions).flatMap(d => d.checks).every(c => !c.suggestion));
    const site = evaluateGeoSite({ pages: [page(), failed] });
    assert.equal(site.score, 100);
    assert.equal(site.status, 'partial');
    assert.equal(site.coverage.pagesScored, 1);
    assert.equal(site.coverage.pagesUnavailable, 1);
    assert.equal(site.coverage.ratio, 0.5);
    assert.ok(Object.values(site.dimensions).every(d => d.status === 'partial'));
    assert.deepEqual(site.actionPlan, []);
  }
  for (const pages of [[], [{}]]) {
    const result = evaluateGeoSite({ pages });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.score, null);
  }
});

test('GEO 不适用检查不降低覆盖率，部分未知也不能四舍五入成完整', () => {
  const input = page({ jsonld: [{ semanticStatus: 'complete', types: ['Organization'], items: [{ name: 'Example', author: 'Team' }] }] });
  const result = evaluateGeoSite({ pages: [input] });
  assert.equal(result.status, 'complete');
  assert.equal(result.coverage.totalWeight, 96);
  assert.equal(result.coverage.ratio, 1);
  assert.equal(result.dimensions.citation.status, 'complete');
  const partial = evaluateGeoSite({ pages: [{ ...input, links: { external: 0 } }] });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.coverage.ratio, 0.958);
  assert.equal(partial.dimensions.citation.status, 'partial');
});

test('GEO 站点聚合覆盖页面和维度建议', () => {
  const result = evaluateGeoSite({ pages: [page(), page({ url: 'https://example.com/app', title: '', h1: [], wordCount: 10, jsonld: [], canonical: '' })] });
  assert.equal(result.coverage.pages, 2);
  assert.equal(result.coverage.pagesScored, 2);
  assert.equal(result.pages.length, 2);
  assert.equal(result.dimensions.answerability.pages, 2);
  assert.ok(result.score < 100);
  assert.ok(result.recommendations.length > 0);
  assert.ok(result.actionPlan.length > 0);
  assert.equal(result.actionPlanMeta.total, result.actionPlan.length);
  assert.equal(result.methodVersion, GEO_METHOD_VERSION);
});

test('GEO 未解析上下文与受限字段不能变成缺陷或通过，已观测证据仍可使用', () => {
  const check = (result, id) => Object.values(result.dimensions).flatMap(d => d.checks).find(c => c.id === id);
  for (const semanticStatus of ['unknown', undefined]) {
    const result = evaluateGeoPage(page({ jsonld: [{ semanticStatus, types: ['Article'], items: [{ author: 'Unverified' }] }] }));
    assert.equal(check(result, 'geo-entity-type').status, 'unknown');
    assert.equal(check(result, 'geo-extract-structure').status, 'unknown');
    assert.equal(check(result, 'geo-citation-attribution').status, 'unknown');
    assert.equal(check(result, 'geo-citation-freshness').status, 'unknown');
    assert.ok(!result.actionPlan.some(i => /geo-entity-type|geo-citation-attribution/.test(i.id)));
  }
  const limited = evaluateGeoPage(page({ jsonld: [{ semanticStatus: 'complete', types: ['TechArticle'], truncated: true, items: [{ name: 'Example', datePublished: '2026-11-13' }] }] }));
  assert.equal(check(limited, 'geo-entity-type').status, 'pass');
  assert.equal(check(limited, 'geo-citation-freshness').status, 'pass');
  assert.equal(check(limited, 'geo-citation-attribution').status, 'unknown');
});

test('Xspark 脱敏 SEO 证据可以离线生成带页面和复测方式的 GEO 待办', () => {
  const saved = JSON.parse(readFileSync(new URL('../../docs/cases/xspark/2026-11-04/evidence/seo.json', import.meta.url), 'utf8'));
  const result = evaluateGeoSite({ pages: saved.pages });
  assert.equal(result.coverage.pages, 5);
  assert.ok(result.actionPlan.some(item => item.id === 'geo-extract-structure'));
  assert.ok(result.actionPlan.every(item => item.affectedPages.length > 0));
  assert.ok(result.actionPlan.every(item => item.validation.expectedStatus === 'pass'));
  assert.doesNotMatch(JSON.stringify(result.actionPlan), /eyJ[a-zA-Z0-9_-]{20,}/);
});
