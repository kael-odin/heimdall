/** Evidence-bearing results, with coverage and hard gates independent of visual score. */
const DIMENSIONS = ['visual', 'structure', 'behavior', 'health'];
export function summarizeAcceptanceReport(raw) {
  const checks = Array.isArray(raw.checks) ? raw.checks : [];
  const count = fn => checks.filter(fn).length;
  const planned = Math.max(checks.length, raw.coverage?.planned ?? checks.length);
  const passed = count(c => c.status === 'passed' && c.verdict === 'match');
  const failed = count(c => c.status === 'failed');
  const blocked = count(c => c.status === 'blocked');
  const needsReview = count(c => c.status === 'needs_review');
  const bugs = count(c => c.verdict === 'bug');
  const baselineFailed = count(c => c.verdict === 'baseline_failed');
  const measured = count(c => ['passed', 'failed'].includes(c.status) && ['match', 'bug'].includes(c.verdict));
  const missing = Math.max(0, planned - checks.length);
  const invalid = count(c => !['passed', 'failed', 'blocked', 'needs_review'].includes(c.status)
    || !['match', 'bug', 'baseline_failed', 'environment', 'needs_review'].includes(c.verdict)
    || (c.status === 'passed' && c.verdict !== 'match') || (c.verdict === 'bug' && c.status !== 'failed'));
  const dimensions = Object.fromEntries(DIMENSIONS.map(dimension => {
    const rows = checks.filter(c => c.dimension === dimension);
    const scores = rows.filter(c => ['passed', 'failed'].includes(c.status) && typeof c.score === 'number' && Number.isFinite(c.score));
    return [dimension, { total: rows.length, passed: rows.filter(c => c.status === 'passed' && c.verdict === 'match').length,
      failed: rows.filter(c => c.status === 'failed').length,
      blocked: rows.filter(c => c.status === 'blocked').length,
      needsReview: rows.filter(c => c.status === 'needs_review').length,
      score: scores.length ? +(scores.reduce((sum, c) => sum + c.score, 0) / scores.length).toFixed(4) : null }];
  }));
  const gate = bugs || failed ? 'failed' : !checks.length || blocked || missing || invalid || raw.coverage?.capped
    || raw.status === 'failed' ? 'blocked' : needsReview || baselineFailed ? 'needs_review' : 'passed';
  return { ...raw, checks, gate,
    summary: { total: checks.length, passed, failed, blocked, needsReview, bugs, baselineFailed, missing, invalid,
      coverage: { measured, total: planned, ratio: planned ? +(measured / planned).toFixed(4) : 0 }, dimensions },
    scope: raw.scope ?? '仅验收已声明路由、视口、操作和有界观察窗口；没有声明的业务与接口契约为未测。' };
}
const cell = value => String(typeof value === 'object' ? JSON.stringify(value) : value ?? '未测').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
export function acceptanceMarkdown(input) {
  const r = summarizeAcceptanceReport(input);
  const labels = { passed: '通过', failed: '阻断：发现缺陷', blocked: '阻断：存在未测/环境失败', needs_review: '待复核' };
  const lines = [`# ${cell(r.name)} · 项目验收报告`, '',
    `任务：${cell(r.runId)}`, `模式：${cell(r.mode)}；时间：${cell(r.startedAt)} → ${cell(r.endedAt)}`,
    ...(r.mode === 'spec' ? [`需求来源：${cell(r.specSource?.id)}；版本：${cell(r.specSource?.revision)}`, `清单批准：${r.specApproval?.approved ? '已显式声明批准' : '未批准候选'}`, `来源指纹：${cell(r.sourceFingerprint)}`, `契约指纹：${cell(r.contractFingerprint)}`] : [`基线：${cell(r.baselineUrl)}`]), `目标：${cell(r.targetUrl)}`, '',
    ...(r.planFingerprint ? [`计划指纹：${r.planFingerprint}`, `验证器指纹：${r.verifierFingerprint}`, ''] : []),
    `**门禁：${labels[r.gate]}**`, '',
    `声明检查 ${r.summary.coverage.total}，已形成结果 ${r.summary.total}，完成可靠判定 ${r.summary.coverage.measured}。`,
    `通过 ${r.summary.passed}；失败 ${r.summary.failed}；阻塞 ${r.summary.blocked}；待复核 ${r.summary.needsReview}；目标缺陷 ${r.summary.bugs}；基线失败 ${r.summary.baselineFailed}；缺测 ${r.summary.missing}。`, '',
    r.scope, '', '## 维度', '', '| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(r.summary.dimensions).map(([key, d]) => `| ${key} | ${d.total} | ${d.passed} | ${d.failed} | ${d.blocked} | ${d.needsReview} | ${d.score === null ? '未测' : (d.score * 100).toFixed(2) + '%'} |`), '',
    '## 检查明细', '', '| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |', '| --- | --- | --- | --- | --- | --- |',
    ...r.checks.map(c => `| ${cell(c.id)} | ${cell(c.route)} | ${cell(c.viewport)} | ${cell(c.status)} | ${cell(c.verdict)} | ${cell(c.severity)} |`), '', '## 问题与证据', ''];
  for (const c of r.checks.filter(c => c.status !== 'passed')) {
    lines.push(`### ${cell(c.id)} · ${cell(c.title)}`, '',
      `结论：${cell(c.verdict)}；证据等级：${cell(c.evidenceLevel)}；参照：${cell(c.oracle)}`,
      `预期：${cell(c.expected)}`, `实际：${cell(c.actual)}`, '', '复现步骤：', '',
      ...(c.reproduction ?? []).map((s, i) => `${i + 1}. ${cell(s)}`), '', '证据文件：', '',
      ...Object.entries(c.evidence ?? {}).map(([key, file]) => `- ${cell(key)}：${cell(file)}`), '');
  }
  lines.push('## 边界', '', r.mode === 'spec'
    ? '仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。'
    : '页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。', '');
  return lines.join('\n');
}
