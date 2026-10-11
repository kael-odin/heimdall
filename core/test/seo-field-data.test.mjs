/**
 * seo/field-data — 真实用户指标（CrUX via PSI）
 *
 * 解析是纯函数，喂真实形状的响应体。取数那一步依赖外网与自备 Key，
 * 这里只钉解析与对照逻辑 —— 不把"没验证过的东西"写成验证过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePsiResponse, fetchFieldData, compareLabToField, categoryCn } from '../src/seo/field-data.mjs';

/** 照 PageSpeed Insights 的真实响应裁出来的最小样本 */
const PSI = {
  loadingExperience: {
    overall_category: 'AVERAGE',
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3800, category: 'AVERAGE' },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' },      // API 里是百分之一
      INTERACTION_TO_NEXT_PAINT: { percentile: 210, category: 'FAST' },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 1800, category: 'AVERAGE' },
    },
  },
};

test('解析：抽出 p75，CLS 按百分之一还原', () => {
  const r = parsePsiResponse(PSI);
  assert.equal(r.available, true);
  assert.equal(r.overall, 'AVERAGE');
  assert.equal(r.metrics.lcp.p75, 3800);
  assert.equal(r.metrics.cls.p75, 0.05, 'CLS 的 5 表示 0.05');
  assert.equal(r.metrics.inp.p75, 210);
});

test('解析：没有 CrUX 数据是常态，返回 available:false 而不是抛错', () => {
  assert.equal(parsePsiResponse({}).available, false);
  assert.equal(parsePsiResponse({ loadingExperience: { metrics: {} } }).available, false);
  const r = parsePsiResponse({ loadingExperience: { metrics: {} } });
  assert.match(r.reason, /流量不足/);
});

test('解析：不认识的指标被忽略，不污染结果', () => {
  const r = parsePsiResponse({ loadingExperience: { metrics: { SOMETHING_NEW: { percentile: 1, category: 'FAST' } } } });
  assert.equal(r.available, true, '有指标就算有数据');
  assert.equal(r.metrics.something_new, undefined);
  assert.equal(r.metrics.lcp, undefined, '认不出的指标不该被塞进 lcp 之类的槽位');
});

test('取数：没配 Key 时直接返回"取不到"，不发请求', async () => {
  const r = await fetchFieldData('https://apify.com', { key: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HEIMDALL_PSI_KEY/);
});

test('对照：实验室比真实用户好太多时要明说（避免拿本机分数当用户体验）', () => {
  const cmp = compareLabToField({ lcp: 1200, cls: 0.01 }, {
    available: true, metrics: { lcp: { p75: 3800, category: 'AVERAGE' }, cls: { p75: 0.05, category: 'FAST' } },
  });
  assert.ok(cmp.rows.length);
  assert.match(cmp.note, /偏乐观/);
});

test('对照：量级一致时不吓人', () => {
  const cmp = compareLabToField({ lcp: 2000, cls: 0.04 }, {
    available: true, metrics: { lcp: { p75: 2200, category: 'AVERAGE' }, cls: { p75: 0.05, category: 'FAST' } },
  });
  assert.match(cmp.note, /一致/);
});

test('对照：没有真实数据就返回 null（调用方据此不显示这一段）', () => {
  assert.equal(compareLabToField({ lcp: 1000 }, { available: false }), null);
});

test('对照：实验室缺项时跳过该项，不编数字', () => {
  const cmp = compareLabToField({ lcp: null, cls: 0.05 }, { available: true, metrics: { lcp: { p75: 3800 }, cls: { p75: 0.05 } } });
  assert.equal(cmp.rows.length, 1);
  assert.equal(cmp.rows[0].label, 'CLS');
});

test('categoryCn: 三档都有中文', () => {
  assert.equal(categoryCn('FAST'), '快');
  assert.equal(categoryCn('SLOW'), '慢');
  assert.equal(categoryCn(undefined), '—');
});
