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
import { evaluatePage, evaluateSite, scoreIssues } from '../src/seo/rules.mjs';

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

test('接线：结构化数据字段建议进入报告，但不扣分；解析与日期错误仍扣分', () => {
  const base = page();
  const items = evaluatePage(page({
    jsonld: [{ ok: true, types: ['Product'], items: [{ '@context': 'https://schema.org', '@type': 'Product' }] }],
  }), { host: 's.test' });
  assert.equal(items.find(i => i.id === 'structured-common-fields').severity, 'info');
  assert.equal(scoreIssues(items), scoreIssues(evaluatePage(base, { host: 's.test' })));
  const broken = evaluatePage(page({ jsonld: [
    { ok: false, error: 'invalid JSON' },
    { ok: true, types: ['Article'], items: [{ '@context': 'https://schema.org', '@type': 'Article', datePublished: 'yesterday' }] },
  ] }), { host: 's.test' });
  assert.equal(broken.find(i => i.id === 'structured-jsonld-error').severity, 'medium');
  assert.equal(broken.find(i => i.id === 'structured-date-format').severity, 'low');
  assert.equal(scoreIssues(broken), scoreIssues(items) - 8);
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
  assert.ok(!ids.some(id => /pagination|faceted|structured-common|structured-context/.test(id)), `不该报：${ids.join(',')}`);
});

/**
 * 进度流与报告必须共用同一份页面级上下文。
 *
 * 这条来自一次真实的"同一个页面两个分数"：audit.mjs 的 onProgress 多传了一个
 * `noindexIntent: true`，而报告那遍传的是站点对象（没有这个字段）——
 * 于是 noindex 页在进度里比报告里高最多 12 分（那条是 high 级规则）。
 * 而 CI 基线取的是报告那个更严的数，两边对不上还没有任何地方会报错。
 *
 * 断言方式：audit.mjs 里 `evaluatePage` 只允许有两个调用点，且都传变量
 * （共用的 pageCtx / site），不得各自现拼一个字面量上下文。
 */
test('audit 的两遍页面评测不得各拼一份上下文', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('../src/seo/audit.mjs', import.meta.url), 'utf8');
  // **先去掉注释再断言**：解释这件事的注释里就写着 noindexIntent，
  // 不剥掉的话这条守卫会被自己那段说明文字判红（第一次就是这么红的）
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal((src.match(/evaluatePage\(/g) ?? []).length, 2, '预期恰好两个调用点（进度流 + 报告）');
  assert.doesNotMatch(src, /evaluatePage\(page,\s*\{/,
    '进度流不得自己拼上下文对象 —— 那正是 noindexIntent 那次的写法');
  assert.doesNotMatch(src, /noindexIntent/,
    'noindexIntent 是补丁式豁免；两遍口径必须一致，不能再单边加上');
});
