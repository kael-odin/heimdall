import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateGeoPage, evaluateGeoSite, GEO_DIMENSIONS } from '../src/seo/geo.mjs';

const page = (over = {}) => ({
  url: 'https://example.com/guide',
  title: 'Proxy guide',
  description: 'A factual guide that explains the proxy workflow, limits, setup steps, and expected results.',
  canonical: 'https://example.com/guide',
  lang: 'en',
  h1: ['Proxy guide'],
  headings: [{ level: 1, text: 'Proxy guide' }, { level: 2, text: 'Setup' }],
  wordCount: 420,
  meta: { noindex: false },
  links: { external: 2 },
  microdataCount: 0,
  jsonld: [{
    types: ['Article'],
    items: [{
      '@type': 'Article', name: 'Proxy guide',
      author: { name: 'Example team' }, datePublished: '2026-11-01',
    }],
  }],
  raw: { ok: true, wordCount: 360 },
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

test('GEO 初始 HTML 未核实时标记 unknown，不把缺证据当失败', () => {
  const result = evaluateGeoPage(page({ raw: null }));
  const check = result.dimensions.answerability.checks.find(item => item.id === 'geo-answer-server-visible');
  assert.equal(check.status, 'unknown');
  assert.ok(!result.issues.some(issue => issue.id === 'geo-answer-server-visible'));
  assert.ok(result.coverage.ratio < 1);
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
  assert.equal(result.methodVersion, 2);
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
