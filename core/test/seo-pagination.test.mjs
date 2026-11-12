/**
 * seo/pagination — 分页与分面导航
 *
 * 这一类问题的特点是**跨页才看得出来**，所以测试既喂单页信号，也喂整站页面数组。
 * 重点钉住方向性：没有收敛策略才算问题；已经 canonical 到主列表页的不该被误报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagination, facetParams, trackingParams, paginationPageIssues, paginationSiteIssues, isStructuralUrl } from '../src/seo/pagination.mjs';

// ---------- 识别 ----------
test('识别：三种分页形态都认', () => {
  assert.equal(parsePagination('https://s.test/blog?page=3').isPaginated, true);
  assert.equal(parsePagination('https://s.test/blog?p=3').isPaginated, true);
  assert.deepEqual(parsePagination('https://s.test/blog/page/3/'), { isPaginated: true, param: '(路径)', num: 3 });
});

test('识别：普通页面与坏 URL 不算分页', () => {
  assert.equal(parsePagination('https://s.test/blog').isPaginated, false);
  assert.equal(parsePagination('https://s.test/blog?tag=x').isPaginated, false);
  assert.equal(parsePagination('not a url').isPaginated, false);
});

test('识别：分面参数与跟踪参数分开', () => {
  const u = 'https://s.test/list?color=red&size=40&utm_source=x&gclid=y&page=2';
  assert.deepEqual(facetParams(u).sort(), ['color', 'size']);
  assert.deepEqual(trackingParams(u).sort(), ['gclid', 'utm_source']);
  assert.ok(!facetParams(u).includes('utm_source'), '跟踪参数不算分面参数');
});

// ---------- 单页 ----------
const page = (over = {}) => ({
  url: 'https://s.test/blog', status: 200, title: 'Blog', canonical: '', finalUrl: '', meta: { noindex: false }, internalHrefs: [], ...over,
});

test('单页：分页页被 noindex → 报高危', () => {
  const issues = paginationPageIssues(page({ url: 'https://s.test/blog?page=3', meta: { noindex: true } }));
  const hit = issues.find(i => i.id === 'index-pagination-noindex');
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
  assert.match(hit.message, /第 3 页/);
  assert.doesNotMatch(hit.suggestion, /一并消失/);
  assert.ok(!paginationPageIssues(page({ url: 'https://s.test/blog?page=3', meta: { noindex: true } }), { noindexIntent: true })
    .some(i => i.id === 'index-pagination-noindex'));
});

test('单页：非分页页 noindex 不归这条规则管', () => {
  assert.ok(!paginationPageIssues(page({ meta: { noindex: true } })).some(i => i.id === 'index-pagination-noindex'));
});

test('单页：内链带跟踪参数 → 报提醒', () => {
  const issues = paginationPageIssues(page({ internalHrefs: ['https://s.test/a?utm_source=nav', 'https://s.test/b', 'https://s.test/c?gclid=1'] }));
  const hit = issues.find(i => i.id === 'links-tracking-params');
  assert.ok(hit);
  assert.match(hit.message, /2 个站内链接/);
});

// ---------- 站点级 ----------
const siteOf = (pages) => ({ pages });

test('站点：分页页允许共用 title，只给不扣分建议', () => {
  const issues = paginationSiteIssues(siteOf([
    page({ url: 'https://s.test/blog?page=1', title: '博客' }),
    page({ url: 'https://s.test/blog?page=2', title: '博客' }),
  ]));
  assert.equal(issues.find(i => i.id === 'links-pagination-title-duplicate')?.severity, 'info');
});

test('站点：分页页各带页码 title → 不报重复', () => {
  const issues = paginationSiteIssues(siteOf([
    page({ url: 'https://s.test/blog?page=1', title: '博客 – 第 1 页' }),
    page({ url: 'https://s.test/blog?page=2', title: '博客 – 第 2 页' }),
  ]));
  assert.ok(!issues.some(i => i.id === 'links-pagination-title-duplicate'));
});

test('站点：canonical 一半自指一半归并 → 报不一致', () => {
  const issues = paginationSiteIssues(siteOf([
    page({ url: 'https://s.test/blog?page=1', finalUrl: 'https://s.test/blog?page=1', canonical: 'https://s.test/blog?page=1' }),
    page({ url: 'https://s.test/blog?page=2', finalUrl: 'https://s.test/blog?page=2', canonical: 'https://s.test/blog' }),
  ]));
  assert.ok(issues.some(i => i.id === 'links-pagination-canonical-mixed'));
  for (const canonical of ['http://s.test/blog?page=2', 'https://s.test:444/blog?page=2', 'https://www.s.test/blog?page=2', 'https://s.test/blog/?page=2']) {
    const mixed = paginationSiteIssues(siteOf([
      page({ url: 'https://s.test/blog?page=1', finalUrl: 'https://s.test/blog?page=1', canonical: 'https://s.test/blog?page=1' }),
      page({ url: 'https://s.test/blog?page=2', finalUrl: 'https://s.test/blog?page=2', canonical }),
    ]));
    assert.ok(mixed.some(i => i.id === 'links-pagination-canonical-mixed'), canonical);
  }
});

test('站点：分面页没有收敛策略 → 报 medium；已收敛 → 降为 info', () => {
  const mk = (u, canonical) => page({ url: u, finalUrl: u, canonical });
  const uncontrolled = paginationSiteIssues(siteOf([
    mk('https://s.test/list?color=red'), mk('https://s.test/list?size=40'), mk('https://s.test/list?color=blue&size=41'),
  ])).find(i => i.id === 'links-faceted-params');
  assert.ok(uncontrolled);
  assert.equal(uncontrolled.severity, 'medium');
  assert.match(uncontrolled.message, /0 个.*非自指 canonical/);

  const controlled = paginationSiteIssues(siteOf([
    mk('https://s.test/list?color=red', 'https://s.test/list'), mk('https://s.test/list?size=40', 'https://s.test/list'), mk('https://s.test/list?color=blue', 'https://s.test/list'),
  ])).find(i => i.id === 'links-faceted-params');
  assert.equal(controlled.severity, 'info');
  assert.match(controlled.message, /3 个.*非自指 canonical/);
  assert.match(controlled.message, /未验证/);
  assert.doesNotMatch(controlled.suggestion, /各自 canonical 到主列表页/);
  for (const canonical of ['', 'not-a-url', 'file:///list', 'javascript:void(0)']) {
    const partial = paginationSiteIssues(siteOf([
      mk('https://s.test/list?color=red', 'https://s.test/list'),
      mk('https://s.test/list?color=blue', canonical), mk('https://s.test/list?color=green', canonical),
    ])).find(i => i.id === 'links-faceted-params');
    assert.equal(partial.severity, 'medium', canonical);
  }
});

test('站点：只有一两个参数页不报（别把偶发当问题）', () => {
  const issues = paginationSiteIssues(siteOf([page({ url: 'https://s.test/list?color=red' })]));
  assert.ok(!issues.some(i => i.id === 'links-faceted-params'));
});

test('站点：证据里带上参数出现次数，便于判断哪个参数在放大 URL', () => {
  const issues = paginationSiteIssues(siteOf([
    page({ url: 'https://s.test/l?color=a' }), page({ url: 'https://s.test/l?color=b' }), page({ url: 'https://s.test/l?size=1' }),
  ]));
  const hit = issues.find(i => i.id === 'links-faceted-params');
  assert.match(hit.evidence, /color×2/);
});

test('站点：noindex 的页面不参与统计', () => {
  const issues = paginationSiteIssues(siteOf([
    page({ url: 'https://s.test/l?color=a', meta: { noindex: true } }),
    page({ url: 'https://s.test/l?color=b', meta: { noindex: true } }),
    page({ url: 'https://s.test/l?color=c', meta: { noindex: true } }),
  ]));
  assert.ok(!issues.some(i => i.id === 'links-faceted-params'));
});

test('站点：空站点不炸', () => {
  assert.deepEqual(paginationSiteIssues({}), []);
  assert.deepEqual(paginationSiteIssues({ pages: [] }), []);
});

test('抓取排序：分页与分面 URL 判为"结构性"，普通页不是', () => {
  assert.equal(isStructuralUrl('https://s.test/blog?page=2'), true);
  assert.equal(isStructuralUrl('https://s.test/blog/page/3/'), true);
  assert.equal(isStructuralUrl('https://s.test/list?color=red'), true);
  assert.equal(isStructuralUrl('https://s.test/blog/hello-world'), false);
  assert.equal(isStructuralUrl('https://s.test/item?id=123'), false, 'id 不改变内容集合，不算结构性');
});

test('抓取排序：结构性 URL 排在前面（否则会被页数配额挤掉）', () => {
  const links = ['https://s.test/a', 'https://s.test/b?page=2', 'https://s.test/c', 'https://s.test/d?sort=price'];
  const sorted = [...links].sort((a, b) => (isStructuralUrl(b) ? 1 : 0) - (isStructuralUrl(a) ? 1 : 0));
  assert.deepEqual(sorted.slice(0, 2).sort(), ['https://s.test/b?page=2', 'https://s.test/d?sort=price']);
});

test('站点：只采到一个分页页、且它没有 canonical —— 也要报（逐页问题不该被"至少两页"挡住）', () => {
  const issues = paginationSiteIssues(siteOf([page({ url: 'https://s.test/?p=2', title: 'Home' })]));
  assert.ok(issues.some(i => i.id === 'links-pagination-canonical-missing'), '实测 news.ycombinator.com 就卡在这里');
});

test('单页：分页只有 JS 按钮、没有可抓链接 → 报（实测 blog.jetbrains.com 就是这样）', () => {
  const issues = paginationPageIssues(page({ jsPagination: ['Older posts'], internalHrefs: ['https://s.test/a', 'https://s.test/b'] }));
  const hit = issues.find(i => i.id === 'links-pagination-js-only');
  assert.ok(hit);
  assert.equal(hit.severity, 'medium');
  assert.match(hit.message, /Older posts/);
});

test('单页：有可抓的分页链接时不再报 JS 分页（按钮只是增强）', () => {
  const issues = paginationPageIssues(page({ jsPagination: ['Load more'], internalHrefs: ['https://s.test/blog?page=2'] }));
  assert.ok(!issues.some(i => i.id === 'links-pagination-js-only'));
});

test('单页：没有分页控件就不提这条', () => {
  assert.ok(!paginationPageIssues(page({ internalHrefs: ['https://s.test/a'] })).some(i => i.id === 'links-pagination-js-only'));
});
