/**
 * crawler/classify — 页面类型判定
 *
 * 回归背景：旧实现只认英文路径，中文站（/价格、/关于我们、/帮助中心）会整站退化成
 * generic —— 而 queue 的排除项（auth/legal 不批量克隆）与星图图例都依赖 type。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathOfType, refineType, classifyPath, compileExtraRules, TYPE_RULES } from '../src/crawler/classify.mjs';

test('classify: 英文路径（保持既有行为）', () => {
  const cases = {
    '/pricing': 'pricing', '/plans': 'pricing', '/billing': 'pricing',
    '/blog': 'blog', '/blog/post-1': 'blog', '/news/x': 'blog', '/changelog': 'blog',
    '/case-studies': 'case_study', '/customers/acme': 'case_study',
    '/careers': 'career', '/jobs/123': 'career',
    '/help': 'help', '/faq': 'help', '/support/ticket': 'help',
    '/docs': 'doc', '/docs/api': 'doc', '/guide/install': 'doc', '/reference/x': 'doc',
    '/tools/checker': 'tools', '/free-calculator': 'tools',
    '/product/foo': 'product', '/solutions/x': 'product',
    '/store': 'listing', '/templates': 'listing', '/integrations/zapier': 'listing',
    '/login': 'auth', '/signup': 'auth', '/dashboard': 'auth',
    '/terms': 'legal', '/privacy': 'legal', '/acceptable-use': 'legal',
    '/about': 'company', '/contact': 'company', '/partners': 'company',
    '/': 'marketing', '/index.html': 'marketing',
    '/some-random-slug': 'generic',
  };
  for (const [path, want] of Object.entries(cases)) {
    assert.equal(pathOfType(path), want, `${path} 应为 ${want}`);
  }
});

test('classify: 中文/日文路径不再退化成 generic', () => {
  const cases = {
    '/价格': 'pricing', '/定价': 'pricing', '/套餐': 'pricing', '/价格/企业版': 'pricing',
    '/新闻': 'blog', '/博客': 'blog', '/动态': 'blog',
    '/客户案例': 'case_study', '/成功案例': 'case_study',
    '/招聘': 'career', '/加入我们': 'career', '/职位': 'career',
    '/帮助中心': 'help', '/常见问题': 'help', '/教程': 'help',
    '/开发文档': 'doc', '/接口文档': 'doc',
    '/工具': 'tools', '/计算器': 'tools',
    '/产品': 'product', '/解决方案': 'product',
    '/模板': 'listing', '/应用': 'listing',
    '/登录': 'auth', '/注册': 'auth', '/控制台': 'auth', '/后台': 'auth',
    '/隐私政策': 'legal', '/服务条款': 'legal', '/法律声明': 'legal',
    '/关于我们': 'company', '/联系我们': 'company', '/团队': 'company',
    '/料金': 'pricing', '/価格': 'pricing', '/採用': 'career', '/ヘルプ': 'help',
  };
  for (const [path, want] of Object.entries(cases)) {
    assert.equal(pathOfType(path), want, `${path} 应为 ${want}`);
  }
});

test('classify: 首条命中即返回（顺序是从特异到宽泛）', () => {
  assert.equal(pathOfType('/pricing/about'), 'pricing', 'pricing 优先于 company');
  assert.equal(pathOfType('/docs/pricing'), 'pricing');
  assert.equal(pathOfType('/legal/pricing'), 'pricing');
});

test('classify: refineType 用 DOM 特征兜底，但只在 generic/marketing 且非首页时介入', () => {
  const f = (o) => ({ passwordField: false, priceHits: 0, tableCount: 0, form: 0, codeBlocks: 0, faq: false, jobPosting: false, headings: 0, article: false, ...o });

  assert.equal(refineType('generic', '/x', f({ passwordField: true })), 'auth');
  assert.equal(refineType('generic', '/x', f({ codeBlocks: 5, form: 1 })), 'doc');
  assert.equal(refineType('generic', '/x', f({ codeBlocks: 5, form: 3 })), 'generic', '表单多则不像文档');
  assert.equal(refineType('generic', '/x', f({ faq: true })), 'help');
  assert.equal(refineType('generic', '/x', f({ faq: true, priceHits: 4, tableCount: 1 })), 'pricing', '有价格表时 pricing 优先于 help');
  assert.equal(refineType('generic', '/x', f({ priceHits: 5, tableCount: 2 })), 'pricing');
  assert.equal(refineType('generic', '/x', f({ priceHits: 5, tableCount: 0 })), 'generic', '没有表不算定价页');
  assert.equal(refineType('generic', '/x', f({ jobPosting: true })), 'career');
  assert.equal(refineType('marketing', '/x', f({ article: true, headings: 6 })), 'blog');

  assert.equal(refineType('marketing', '/', f({ passwordField: true })), 'marketing', '首页不参与兜底');
  assert.equal(refineType('pricing', '/pricing', f({ passwordField: true })), 'pricing', '路径已判定则不覆盖');
  assert.equal(refineType('generic', '/x', null), 'generic', '无特征时原样返回');
});

test('classify: classifyPath 串起两步，并由配方规则优先', () => {
  assert.equal(classifyPath('/whatever', null), 'generic');
  assert.equal(classifyPath('/whatever', { passwordField: true }), 'auth');
  assert.equal(classifyPath('/pricing', { passwordField: true }), 'pricing');

  const extra = compileExtraRules([{ type: 'pricing', pattern: '^/plans-and-pricing' }]);
  assert.equal(classifyPath('/plans-and-pricing', null, extra), 'pricing', '站点规则优先于通用规则');
  assert.equal(classifyPath('/pricing', null, extra), 'pricing', '通用规则仍生效');
});

test('classify: compileExtraRules 跳过坏正则与缺字段的规则', () => {
  const rules = compileExtraRules([
    { type: 'pricing', pattern: '^/a' },
    { type: 'blog', pattern: '([' },      // 坏正则
    { pattern: '^/b' },                   // 缺 type
    null,
  ]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].type, 'pricing');
});

test('classify: 每条规则都是合法正则且类型唯一', () => {
  const seen = new Set();
  for (const [type, re] of TYPE_RULES) {
    assert.ok(re instanceof RegExp, type);
    assert.ok(!seen.has(type), `${type} 重复注册`);
    seen.add(type);
  }
  assert.ok(seen.has('auth') && seen.has('legal'));
});
