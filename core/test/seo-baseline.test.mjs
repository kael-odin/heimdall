/**
 * seo/baseline — SEO 回归基线
 *
 * 这组测试钉住的是**门禁的可信度**，不是函数返回值好不好看：
 * 一个会随机变红的门禁，等于没有门禁（团队会加 continue-on-error 然后忘掉它）。
 * 所以重点覆盖三件事：波动规则不误报、页面消失必报、计数漂移不误报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildBaseline, snapshotOf, diffBaseline, stableScore, isVolatile,
  renderDiffText, renderDiffMarkdown, BASELINE_VERSION, issueKey,
} = await import('../src/seo/baseline.mjs');

// ---------- 构造 report 的小工具 ----------
const iss = (id, severity = 'medium') => ({ id, severity, category: 'content', title: id, message: '', evidence: '', suggestion: '' });

function report({ pages, siteIssues = [], score = null, categories = {} }) {
  const pagesOut = pages.map(p => ({
    url: p.url,
    issues: p.issues ?? [],
    score: p.score ?? stableScore(p.issues ?? []),
  }));
  const all = [...pagesOut.flatMap(p => p.issues), ...siteIssues];
  return {
    host: 'example.com', origin: 'https://example.com',
    generatedAt: '2026-10-10T00:00:00.000Z',
    score: score ?? 0,
    categories,
    siteIssues,
    pages: pagesOut,
    summary: { pages: pagesOut.length, issues: all.length },
  };
}

test('baseline: 波动规则识别（LCP/CLS/FCP 才算，perf-weight 不算）', () => {
  assert.equal(isVolatile('perf-lcp-poor'), true);
  assert.equal(isVolatile('perf-lcp-slow'), true);
  assert.equal(isVolatile('perf-cls-warn'), true);
  assert.equal(isVolatile('perf-fcp-slow'), true);
  assert.equal(isVolatile('perf-weight-large'), false);
  assert.equal(isVolatile('content-title-long'), false);
  assert.equal(isVolatile(undefined), false);
});

test('baseline: stableScore 剔除波动规则', () => {
  // critical(25) + medium(6) = 69；LCP high(12) 不计
  const s = stableScore([iss('content-title-missing', 'critical'), iss('content-thin', 'medium'), iss('perf-lcp-poor', 'high')]);
  assert.equal(s, 69);
  assert.equal(stableScore([]), 100);
  // 只扣波动规则 → 仍是满分（这正是门禁不抖的原因）
  assert.equal(stableScore([iss('perf-lcp-poor', 'high'), iss('perf-cls-poor', 'high')]), 100);
  // 扣到负数也不能为负
  assert.equal(stableScore(Array.from({ length: 10 }, () => iss('x', 'critical'))), 0);
});

test('baseline: 快照自带严重度（比对不依赖外部映射，避免静默降级）', () => {
  const b = buildBaseline(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-thin', 'medium'), iss('content-title-missing', 'critical')] }] }));
  assert.equal(b.version, BASELINE_VERSION);
  assert.deepEqual(b.pages['https://example.com/a'].issues, {
    'content-thin': 'medium',
    'content-title-missing': 'critical',
  });
  const size = JSON.stringify(b).length;
  assert.ok(size < 700, `快照应保持紧凑，实际 ${size} 字节`);
});

test('baseline: 同一规则多次触发取最严重的一次', () => {
  const b = buildBaseline(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-img-alt', 'medium'), iss('content-img-alt', 'high')] }] }));
  assert.equal(b.pages['https://example.com/a'].issues['content-img-alt'], 'high');
});

test('baseline: critical 新问题必须是阻断的（不得被降级为 medium 放行）', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-title-missing', 'critical')] }] }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.regressions[0].severity, 'critical');
  assert.equal(d.ok, false);
});

test('baseline: 尾斜杠归一化（/a 与 /a/ 是同一页，不能算消失）', () => {
  const a = buildBaseline(report({ pages: [{ url: 'https://example.com/a/' }] }));
  const b = snapshotOf(report({ pages: [{ url: 'https://example.com/a' }] }));
  assert.deepEqual(Object.keys(a.pages), ['https://example.com/a']);
  const d = diffBaseline(a, b, {});
  assert.equal(d.regressions.length, 0, '尾斜杠差异不得报成页面消失');
});

test('baseline: 页面消失必报（最重的一类回归，必须单列且阻断）', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }, { url: 'https://example.com/landing' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a' }] }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.ok, false);
  assert.equal(d.regressions.length, 1);
  assert.equal(d.regressions[0].type, 'page-missing');
  assert.equal(d.regressions[0].severity, 'critical');
  assert.equal(d.regressions[0].url, 'https://example.com/landing');
});

test('baseline: 新增页面是中性，不报回归', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a' }, { url: 'https://example.com/new', issues: [iss('content-title-missing', 'critical')] }] }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.ok, true);
  assert.deepEqual(d.addedPages, ['https://example.com/new']);
  assert.equal(d.regressions.length, 0, '新页面的问题不是"回归"——没有基线可比');
});

test('baseline: 波动规则新出现时只作观测，不放行阻断', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('perf-lcp-poor', 'high'), iss('perf-cls-warn', 'medium')] }] }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.ok, true, 'LCP 抖动不得让门禁变红');
  assert.equal(d.regressions.length, 0);
  assert.equal(d.observations.length, 2);
  // 而且总分不受影响（稳定分剔除波动规则）
  assert.equal(d.score.before, d.score.after);
});

test('baseline: 同一条规则的计数漂移不误报（基线是 (page,rule) 对，不是计数）', () => {
  // 上次 1 个页面有 content-thin；本次同一页仍有、另有两页新页面也有 → 不是回归
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-thin')] }] }));
  const after = snapshotOf(report({
    pages: [
      { url: 'https://example.com/a', issues: [iss('content-thin')] },
      { url: 'https://example.com/n1', issues: [iss('content-thin')] },
      { url: 'https://example.com/n2', issues: [iss('content-thin')] },
    ],
  }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.regressions.length, 0);
});

test('baseline: 同一页新增高severity问题 → 阻断；低severity默认不阻断但仍记录', () => {
  const base = () => buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const high = diffBaseline(base(), snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-h1-missing', 'high')] }] })), {});
  assert.equal(high.ok, false);
  assert.equal(high.counts.blocking, 1);

  const low = diffBaseline(base(), snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-heading-skip', 'low')] }] })), {});
  assert.equal(low.ok, true, 'low 默认不阻断');
  assert.equal(low.regressions.length, 1, '但要如实记录');
});

test('baseline: existing issue severity escalation is a regression', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-title-long', 'low')] }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-title-long', 'high')] }] }));
  const diff = diffBaseline(before, after);
  assert.equal(diff.ok, false);
  assert.equal(diff.counts.blocking, 1);
  assert.equal(diff.regressions[0].type, 'issue-worsened');

  const better = diffBaseline(after, before);
  assert.equal(better.ok, true);
  assert.equal(better.improvements[0].type, 'issue-improved');
});

test('baseline: failOn 可配（把 medium 也算阻断）', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-h1-multiple', 'medium')] }] }));
  assert.equal(diffBaseline(before, after, {}).ok, true);
  assert.equal(diffBaseline(before, after, { failOn: ['critical', 'high', 'medium'] }).ok, false);
});

test('baseline: 分数是派生量，不得作为第二条回归重复计入', () => {
  // 一页新增 1 条 critical：回归应恰好 1 条（新增问题），
  // 而不是「新增问题 + 分数下降」两条 —— 那会让 blocking 计数虚高、同一条问题报两遍。
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-title-missing', 'critical')] }] }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.regressions.length, 1, `应只有具名问题一条，实际 ${JSON.stringify(d.regressions.map(r => r.type))}`);
  assert.equal(d.counts.blocking, 1);
  assert.ok(d.score.delta < 0, '分数仍要如实反映下降');
});

test('baseline: tolerance 默认 0 = 不启用分数门禁；>0 才按跌幅阻断', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  // medium 问题扣 6 分，默认不阻断（medium ∉ failOn）
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-h1-multiple', 'medium')] }] }));
  const off = diffBaseline(before, after, {});
  assert.equal(off.regressions.filter(r => r.type === 'score-drop').length, 0, '默认不得有分数门禁条目');

  // 显式启用、容忍度小于跌幅 → 阻断
  const tight = diffBaseline(before, after, { tolerance: 3 });
  assert.equal(tight.ok, false);
  assert.equal(tight.regressions.filter(r => r.type === 'score-drop').length, 1);

  // 容忍度大于跌幅 → 放行
  const loose = diffBaseline(before, after, { tolerance: 99 });
  assert.equal(loose.regressions.filter(r => r.type === 'score-drop').length, 0);
});

test('baseline: 分数门禁也不受波动规则影响（否则等于没修）', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('perf-lcp-poor', 'high'), iss('perf-cls-poor', 'high')] }] }));
  // 原始分大跌，但稳定分不变 → 启用了分数门禁也不会红
  const d = diffBaseline(before, after, { tolerance: 0.5 });
  assert.equal(d.score.delta, 0, '稳定分不得因 LCP/CLS 抖动而变化');
  assert.equal(d.ok, true);
});

test('baseline: 修复会出现在 improvements 里', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-title-missing', 'critical'), iss('content-lang-missing', 'medium')] }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-lang-missing', 'medium')] }] }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.ok, true);
  assert.equal(d.regressions.length, 0);
  assert.ok(d.improvements.some(i => i.ruleId === 'content-title-missing'));
  assert.ok(d.score.delta > 0);
});

test('baseline: 站点级问题的新增/修复走独立通道', () => {
  const noRobots = iss('index-robots-missing', 'low');
  const noSitemap = iss('index-sitemap-missing', 'medium');
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }], siteIssues: [noRobots] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a' }], siteIssues: [noRobots, noSitemap] }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.regressions.filter(r => r.type === 'new-site-issue').length, 1);
  assert.equal(d.regressions.find(r => r.type === 'new-site-issue').severity, 'medium');

  const fixed = diffBaseline(before, snapshotOf(report({ pages: [{ url: 'https://example.com/a' }], siteIssues: [] })), {});
  assert.ok(fixed.improvements.some(i => i.type === 'resolved-site-issue'));
});

test('baseline: 首次运行不判回归，且明确标记', () => {
  const d = diffBaseline(null, snapshotOf(report({ pages: [{ url: 'https://example.com/a' }] })), {});
  assert.equal(d.firstRun, true);
  assert.equal(d.ok, true);
  assert.match(renderDiffText(d), /首次运行/);
});

test('baseline: 版本不符要抛错，不得静默当首次运行放过', () => {
  const stale = { ...buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] })), version: 0 };
  assert.throws(
    () => diffBaseline(stale, snapshotOf(report({ pages: [{ url: 'https://example.com/a' }] })), {}),
    /baseline version/,
  );
});

test('baseline: 回归排序 —— 页面消失最前，严重度优先', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/gone' }, { url: 'https://example.com/a' }, { url: 'https://example.com/b' }] }));
  const after = snapshotOf(report({
    pages: [
      { url: 'https://example.com/a', issues: [iss('content-heading-skip', 'low')] },
      { url: 'https://example.com/b', issues: [iss('content-title-missing', 'critical')] },
    ],
  }));
  const d = diffBaseline(before, after, {});
  assert.equal(d.regressions[0].type, 'page-missing');
  const sevs = d.regressions.map(r => r.severity);
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  for (let i = 1; i < sevs.length; i++) assert.ok(order[sevs[i - 1]] <= order[sevs[i]], `严重度未排序: ${sevs}`);
});

test('baseline: 报告渲染不炸，且结论行与 ok 一致', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: [iss('content-title-missing', 'critical')] }] }));
  const d = diffBaseline(before, after, {});
  const txt = renderDiffText(d);
  assert.match(txt, /不通过/);
  const md = renderDiffMarkdown(d);
  assert.match(md, /不通过/);
  assert.match(md, /content-title-missing/);

  const okDiff = diffBaseline(before, before, {});
  assert.match(renderDiffText(okDiff), /通过/);
  assert.match(renderDiffMarkdown(okDiff), /通过/);
});

test('baseline: 空报告/空基线不抛错', () => {
  const b = buildBaseline(report({ pages: [] }));
  assert.deepEqual(b.pages, {});
  const d = diffBaseline(b, b, {});
  assert.equal(d.ok, true);
});

test('baseline: 大规模截断渲染（报告不该把终端刷爆）', () => {
  const before = buildBaseline(report({ pages: [{ url: 'https://example.com/a' }] }));
  const many = Array.from({ length: 50 }, (_, i) => iss(`rule-${i}`, 'high'));
  const after = snapshotOf(report({ pages: [{ url: 'https://example.com/a', issues: many }] }));
  const d = diffBaseline(before, after, {});
  const lines = renderDiffText(d, { limit: 20 }).split('\n');
  assert.ok(lines.some(l => /另有\s*30\s*项/.test(l)), '超出 limit 要给出剩余数量');
  assert.ok(d.regressions.length === 50, `回归数应为 50，实际 ${d.regressions.length}`);
  assert.ok(lines.length < 60, `终端输出应受 limit 约束，实际 ${lines.length} 行`);
});

test('baseline: issueKey 归一化 page', () => {
  assert.equal(issueKey('https://example.com/a/', 'x'), 'https://example.com/a::x');
  assert.equal(issueKey(null, 'x'), '~site::x');
});
