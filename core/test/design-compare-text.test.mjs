import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDesignTexts, normalizeText, diceCoefficient } from '../src/design/compare-text.mjs';

const one = (design, live, opts) => compareDesignTexts([design], live, opts)[0];

test('normalizeText：NFKC、全半角标点、空白、大小写', () => {
  assert.equal(normalizeText('ＶＩＰ会员：９９元'), 'vip会员:99元');
  assert.equal(normalizeText('VIP 会员: 99 元'), 'vip会员:99元');
  assert.equal(normalizeText('“立即”领取。'), '"立即"领取.');
  assert.equal(normalizeText('  Sign\n  In\u200b  '), 'sign in');
  assert.equal(normalizeText('第一行\n第二行'), '第一行第二行', '中文折行不算差异');
  assert.equal(normalizeText(null), '');
});

test('diceCoefficient：二元组多重集，中文可用', () => {
  assert.equal(diceCoefficient('会员中心', '会员中心'), 1);
  assert.equal(diceCoefficient('', ''), 0);
  assert.equal(diceCoefficient('night', 'nacht'), 0.25);
  assert.equal(diceCoefficient('新人礼包', '新人红包'), 1 / 3);
  assert.equal(diceCoefficient('a', 'a'), 1);
});

test('found：包含、全半角与大小写不同、短标签反向包含', () => {
  assert.deepEqual(one('欢迎使用 Xspark', ['欢迎使用XSPARK，开始体验']), { design: '欢迎使用 Xspark', status: 'found', live: '欢迎使用XSPARK，开始体验', similarity: 1, hasNumber: false });
  assert.equal(one('ＶＩＰ会员：９９元', ['VIP 会员: 99 元']).status, 'found');
  assert.equal(one('设置 >', ['设置']).status, 'found', '短标签：线上文字被设计稿包含');
  assert.equal(one('立即领取新人礼包吧', ['领取']).status, 'missing', '反向包含只对短标签，且要够长');
  assert.equal(one('登录', ['首页', '登录 / 注册', '登录']).live, '登录', '取最短的包含者');
});

test('changed：中文改一个字；价格数字变了也不当成 found', () => {
  const r = one('立即领取新人礼包', ['首页', '立即领取新人红包', '我的']);
  assert.equal(r.status, 'changed');
  assert.equal(r.live, '立即领取新人红包');
  assert.ok(r.similarity >= 0.6 && r.similarity < 1, String(r.similarity));
  assert.equal(r.hasNumber, false);

  const price = one('¥99/月', ['首月特惠 ¥199/月 起']);
  assert.equal(price.status, 'changed', '99 不能在 199 里算 found');
  assert.equal(price.hasNumber, true);
  assert.equal(one('9.9', ['19.9']).status, 'changed');
});

test('changed：长段落里按窗口找最像的一段，不被整段稀释', () => {
  const live = ['活动说明：即日起至月底，新用户注册即可立即领取新人红包，名额有限先到先得，详情请咨询客服。'];
  const r = one('立即领取新人礼包', live);
  assert.equal(r.status, 'changed');
  assert.ok(r.similarity >= 0.6);
  assert.ok(diceCoefficient(normalizeText('立即领取新人礼包'), normalizeText(live[0])) < 0.6, '整段比较会低于阈值');
});

test('missing：没有相近的文字；拉丁词不在别的词中间拿分', () => {
  const r = one('联系客服', ['首页', '我的订单']);
  assert.deepEqual(r, { design: '联系客服', status: 'missing', similarity: 0, hasNumber: false });
  assert.equal(r.live, undefined);
  assert.equal(one('Pro', ['approve', 'reprocess']).status, 'missing');
  assert.equal(one('联系客服', []).status, 'missing');
});

test('hasNumber、minLength、对象输入原样带回', () => {
  const design = [{ id: 't1', characters: '剩余 3 次' }, { id: 't2', characters: '×' }, { id: 't3', characters: '套餐' }];
  const live = [{ text: '剩余 3 次', selector: '#quota' }, { text: '套餐' }];
  const results = compareDesignTexts(design, live);
  assert.deepEqual(results.map(r => [r.design.id, r.status, r.hasNumber]), [['t1', 'found', true], ['t3', 'found', false]], '短于 minLength 的跳过');
  assert.equal(results[0].live.selector, '#quota');
  assert.equal(compareDesignTexts(design, live, { minLength: 1 }).length, 3);
  assert.deepEqual(compareDesignTexts(null, null), []);
});
