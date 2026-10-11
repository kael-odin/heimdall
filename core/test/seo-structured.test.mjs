/**
 * seo/structured — JSON-LD 字段级校验
 *
 * 钉的是"写了 ≠ 能用"这条线：一份只有 @type 的空 Product，旧实现判它合格。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStructuredData, flattenNodes, REQUIRED_FIELDS } from '../src/seo/structured.mjs';

const ids = (items) => validateStructuredData(items).map(i => i.id);
const find = (items, id) => validateStructuredData(items).find(i => i.id === id);

test('结构化：完整的 Product 不报问题', () => {
  const items = [{
    '@context': 'https://schema.org', '@type': 'Product',
    name: '无线耳机', image: 'https://shop.test/a.jpg',
    offers: { '@type': 'Offer', price: '99', priceCurrency: 'CNY' },
  }];
  assert.deepEqual(ids(items), []);
});

test('结构化：只有 @type 的 Product 必须报缺失（旧实现判它合格）', () => {
  const items = [{ '@context': 'https://schema.org', '@type': 'Product' }];
  const issue = find(items, 'structured-required-missing');
  assert.ok(issue, '应报缺必填字段');
  assert.match(issue.message, /name/);
  assert.match(issue.message, /image/);
  assert.match(issue.message, /offers \/ review \/ aggregateRating/);
});

test('结构化：Product 的 offers/review/aggregateRating 是「至少其一」', () => {
  const base = { '@context': 'https://schema.org', '@type': 'Product', name: 'x', image: 'https://a.test/i.png' };
  assert.deepEqual(ids([{ ...base, aggregateRating: { ratingValue: 4.5 } }]), [], '有评分就够了');
  assert.ok(ids([base]).includes('structured-required-missing'), '三者都没有才算缺');
});

test('结构化：@graph 里的实体也要校验', () => {
  const items = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article' }] }];
  const issue = find(items, 'structured-required-missing');
  assert.ok(issue, '@graph 内的 Article 缺 headline/image/datePublished/author');
  assert.match(issue.title, /Article/);
});

test('结构化：缺 @context 单独报一条（且 @graph 内层不算）', () => {
  assert.ok(ids([{ '@type': 'Organization', name: 'x', url: 'https://a.test' }]).includes('structured-context-missing'));
  assert.ok(!ids([{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'x', url: 'https://a.test' }] }]).includes('structured-context-missing'));
});

test('结构化：缺 @type 报一条', () => {
  assert.ok(ids([{ '@context': 'https://schema.org', name: 'x' }]).includes('structured-type-missing'));
});

test('结构化：日期必须是 ISO 8601', () => {
  const bad = [{ '@context': 'https://schema.org', '@type': 'Article', headline: 'h', image: 'https://a.test/i.png', author: { name: 'a' }, datePublished: '2026年10月11日' }];
  assert.ok(ids(bad).includes('structured-date-format'));
  const good = [{ '@context': 'https://schema.org', '@type': 'Article', headline: 'h', image: 'https://a.test/i.png', author: { name: 'a' }, datePublished: '2026-10-11T09:00:00+08:00' }];
  assert.deepEqual(ids(good), []);
});

test('结构化：image 用相对路径要报（富结果抓不到图）', () => {
  const items = [{ '@context': 'https://schema.org', '@type': 'Product', name: 'x', image: '/img/a.png', offers: { price: '1' } }];
  assert.ok(ids(items).includes('structured-image-relative'));
});

test('结构化：同一类型多个实体聚合成一条，不刷屏', () => {
  const items = [1, 2, 3, 4, 5].map(() => ({ '@context': 'https://schema.org', '@type': 'Product' }));
  const missing = validateStructuredData(items).filter(i => i.id === 'structured-required-missing');
  assert.equal(missing.length, 1, '5 个实体只报一条');
  assert.match(missing[0].message, /5 个 Product/);
});

test('结构化：不认识的类型不报必填（不瞎猜）', () => {
  assert.deepEqual(ids([{ '@context': 'https://schema.org', '@type': 'SomeCustomThing' }]), []);
});

test('结构化：flattenNodes 摊平 @graph 并忽略垃圾输入', () => {
  assert.equal(flattenNodes([{ '@graph': [{ a: 1 }, { b: 2 }] }, { c: 3 }, null, 'x']).length, 3);
});

test('结构化：规则表里每一条都至少有一个必填组', () => {
  for (const [t, groups] of Object.entries(REQUIRED_FIELDS)) {
    assert.ok(Array.isArray(groups) && groups.length && groups.every(g => Array.isArray(g) && g.length), `${t} 的必填表写错了`);
  }
});

test('结构化：空输入不炸', () => {
  assert.deepEqual(validateStructuredData([]), []);
  assert.deepEqual(validateStructuredData(null), []);
  assert.deepEqual(validateStructuredData([null, undefined, 'x']), []);
});
