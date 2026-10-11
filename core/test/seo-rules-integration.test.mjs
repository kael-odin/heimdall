/**
 * 规则引擎集成：从 evaluatePage/evaluateSite 这两个**真实入口**走一遍
 *
 * 为什么要它：pagination.mjs / structured.mjs 各自有单测，但"接线断了"这类问题
 * 单测看不出来 —— 函数是对的，只是没人调用它。实测踩过一次：canonical 缺失那条
 * 规则被嵌在"至少两页"的前提里，结果只采到一个分页 URL 时静默失效。
 * 所以这里喂的是 collect.mjs 形状的页面信号，断言的是 evaluatePage 的输出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePage, evaluateSite } from '../src/seo/rules.mjs';

/** collect.mjs 的页面信号最小形状（只放规则会碰的字段） */
const page = (over = {}) => ({
  url: 'https://s.test/', finalUrl: 'https://s.test/', status: 200, ok: true, redirectCount: 0,
  title: 'T', titleLength: 1, description: 'd'.repeat(60), descriptionLength: 60,
  canonical: '', robotsMeta: '', xRobots: '', meta: { noindex: false, nofollow: false },
  lang: 'zh', viewport: 'width=device-width', textHash: 'x', textSample: 'x',
  h1: ['H'], headings: [], headingLevels: [], headingSkips: 0,
  wordCount: 300, textRatio: 0.2, htmlBytes: 2000,
  imgTotal: 0, imgMissingAlt: 0, imgEmptyAlt: 0, imgBroken: 0, imgLegacy: 0, imgLazy: 0,
  links: { total: 0, internal: 0, external: 0, emptyAnchor: 0, hashOnly: 0, nofollowExternal: 0 },
  internalHrefs: [], externalSample: [], jsonld: [], microdataCount: 0,
  og: { title: 'T', description: 'd', image: 'https://s.test/i.png', type: 'website' },
  twitter: { card: 'summary', title: 'T', image: 'https://s.test/i.png' },
  hreflang: [], jsPagination: [], raw: null,
  resources: { requests: 1, transferBytes: 1, jsBytes: 1, cssBytes: 1, imgBytes: 1, fontBytes: 1, renderBlocking: 1 },
  vitals: { lcp: 1000, cls: 0.01, fcp: 500 }, security: { https: true, mixedContent: [], headers: {} },
  ...over,
});

const idsOf = (pageSignal, site) => evaluatePage(pageSignal, site ?? { host: 's.test' }).map(i => i.id);

test('接线：分页页 noindex 会从 evaluatePage 里出来', () => {
  const ids = idsOf(page({ url: 'https://s.test/blog?page=3', meta: { noindex: true } }));
  assert.ok(ids.includes('index-pagination-noindex'));
});

test('接线：JS 分页按钮会从 evaluatePage 里出来', () => {
  const ids = idsOf(page({ jsPagination: ['Load more'] }));
  assert.ok(ids.includes('links-pagination-js-only'));
});

test('接线：结构化数据缺必填字段会从 evaluatePage 里出来', () => {
  const ids = idsOf(page({
    jsonld: [{ ok: true, types: ['Product'], items: [{ '@context': 'https://schema.org', '@type': 'Product' }] }],
  }));
  assert.ok(ids.includes('structured-required-missing'), '只有 @type 的 Product 必须被拦下');
});

test('接线：站点级分页规则会从 evaluateSite 里出来（只采到一个分页 URL 也要生效）', () => {
  const site = { host: 's.test', pages: [page({ url: 'https://s.test/?p=2', title: '首页' })] };
  const ids = evaluateSite(site).map(i => i.id);
  assert.ok(ids.includes('links-pagination-canonical-missing'));
});

test('接线：分面参数页够多时报出来', () => {
  const site = {
    host: 's.test',
    pages: [
      page({ url: 'https://s.test/l?color=a', canonical: 'https://s.test/l' }),
      page({ url: 'https://s.test/l?size=1', canonical: 'https://s.test/l' }),
      page({ url: 'https://s.test/l?brand=x', canonical: 'https://s.test/l' }),
    ],
  };
  assert.ok(evaluateSite(site).map(i => i.id).includes('links-faceted-params'));
});

test('接线：干净的页面不产生分页/结构化问题（不误报）', () => {
  const clean = page({
    canonical: 'https://s.test/',
    jsonld: [{ ok: true, types: ['Organization'], items: [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'S', url: 'https://s.test' }] }],
  });
  const ids = idsOf(clean);
  assert.ok(!ids.some(id => /pagination|faceted|structured-required|structured-context/.test(id)), `不该报：${ids.join(',')}`);
});
