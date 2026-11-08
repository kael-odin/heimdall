/**
 * qa/report — 两份输出
 *
 *   report.md  全量：待提单、已知仍在、按裁决过滤掉的（附理由）、可容忍、环境问题、检查点没对上、覆盖范围
 *   bugs.md    只放「该提单」的：撞墙/受损、没被以往裁决过滤、证据是实测的。可以直接贴给开发
 *
 * 人工测试里八成的发现最后不提单（生产可忽略、与 PRD 的小差异、环境差异）。
 * 报告不替人做这个判断，但把可以按以往裁决自动挡掉的先挡掉，并写清楚依据，方便人复核。
 */
import { VERDICT_LABEL } from './findings.mjs';

const TIER = { wall: '撞墙', degrade: '受损', tolerable: '可容忍' };
const BASIS = { failed: '实测失败', wrong: '结果错误', promise: '与承诺/PRD 不符', friction: '能用但费劲', cosmetic: '措辞/视觉小瑕疵' };
const KIND = {
  console: '控制台', network: '网络', 'broken-link': '坏链', 'broken-image': '坏图', overflow: '横向溢出', 'login-expired': '登录态',
  assertion: '检查点', text: '文案', 'design-text': '设计稿文案', agent: 'AI 提交', 'blocked-write': '请求策略', navigation: '打不开',
  a11y: '无障碍', layout: '布局', content: '内容', security: '安全', perf: '性能', blank: '白屏',
  interaction: '交互', regression: '回归',
};
/** 检测器类别的中文名，报告分组用 */
const GROUP = { a11y: '无障碍', layout: '布局与响应式', content: '内容正确性', security: '安全', perf: '性能', blank: '页面可用性', interaction: '交互', regression: '版本回归' };
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** 该不该进提单清单 */
export function fileable(f) {
  if (!['new', 'known-bug', 'reopened'].includes(f.triage?.status)) return false;
  if (!['wall', 'degrade'].includes(f.tier)) return false;
  if (['login-expired', 'blocked-write'].includes(f.kind)) return false;
  return !['environment', 'check-error', 'check-unverified'].includes(f.confidence);
}

const where = (f) => `${f.path}${f.viewports?.length ? `（${f.viewports.join('、')}）` : f.viewport ? `（${f.viewport}）` : ''}`;

function card(f, { withVerdictHint = true } = {}) {
  const lines = [`### ${f.id} ${f.title}`, ''];
  lines.push(`- 位置：${where(f)}${f.target ? ` · \`${esc(f.target).slice(0, 120)}\`` : ''}`);
  lines.push(`- 分级：${TIER[f.tier] ?? f.tier}${f.basis ? ` · ${BASIS[f.basis] ?? f.basis}` : ''} · 来源：${f.source === 'agent' ? 'AI 提交' : '自动检查'}（${KIND[f.kind] ?? f.kind}${f.detector ? ` · ${f.detector}` : ''}）`);
  if (f.loss) lines.push(`- 影响：${f.loss}`);
  if (f.prd) lines.push(`- 依据：${f.prd}`);
  if (f.expected) lines.push(`- 预期：${f.expected}`);
  if (f.observed) lines.push(`- 实际：${f.observed}`);
  if (f.repro?.length) lines.push('- 复现：', ...f.repro.map((s, i) => `  ${i + 1}. ${s}`));
  const shot = f.evidence?.screenshot;
  if (shot) lines.push(`- 截图：[${shot}](${shot})`);
  if (f.evidence?.url) lines.push(`- 地址：${f.evidence.url}`);
  if (f.triage?.status === 'known-bug') lines.push(`- 已知问题：${f.triage.reason}（${String(f.triage.at).slice(0, 10)} 记为真问题）`);
  if (f.triage?.status === 'reopened') lines.push(`- 重新打开：${f.triage.note ?? ''}；原裁决「${VERDICT_LABEL[f.triage.verdict]}」：${f.triage.reason}`);
  if (f.notes?.length) lines.push(`- 说明：${f.notes.join('；')}`);
  if (withVerdictHint) lines.push(`- 指纹：\`${f.fingerprint}\``);
  lines.push('');
  return lines.join('\n');
}

export function renderReport({ ws, run, findings, hits }) {
  const s = run.summary;
  const groups = {
    file: findings.filter(fileable),
    suppressed: findings.filter(f => f.triage?.status === 'suppressed'),
    env: findings.filter(f => !fileable(f) && (f.kind === 'login-expired' || f.confidence === 'environment')),
    checks: findings.filter(f => !fileable(f) && ['check-error', 'check-unverified'].includes(f.confidence)),
  };
  groups.tolerable = findings.filter(f => !groups.file.includes(f) && !groups.suppressed.includes(f) && !groups.env.includes(f) && !groups.checks.includes(f));
  const date = run.startedAt.slice(0, 16).replace('T', ' ');
  const out = [];
  out.push(`# 测试报告 · ${ws.project} · ${run.site}`, '');
  out.push(`> 运行 \`${run.runId}\` · ${date} · ${run.siteUrl} · 环境：${run.environment}${run.login ? ` · 登录档：${run.login.name}` : ' · 未登录'}`, '');
  const lead = groups.file.length
    ? `建议提单 ${groups.file.length} 条${groups.file.some(f => f.tier === 'wall') ? `，其中撞墙 ${groups.file.filter(f => f.tier === 'wall').length} 条` : ''}。`
    : groups.env.length ? '登录状态失效，业务页面未完整检查。'
      : run.coverage.detection?.failedPages?.length ? '页面检测器执行失败，本次检查未完成。' : '这次没有需要提单的问题。';
  const extra = [
    s.suppressed ? `按以往裁决过滤 ${s.suppressed} 条` : null,
    groups.tolerable.length ? `可容忍 ${groups.tolerable.length} 条未入单` : null,
    run.coverage.detection?.failedPages?.length ? `检测器在 ${run.coverage.detection.failedPages.length} 个页面视口执行失败` : null,
    groups.env.length ? `${groups.env.length} 条是环境问题` : null,
    groups.checks.length ? `${groups.checks.length} 个检查点没对上，需要先确认检查点本身` : null,
  ].filter(Boolean);
  out.push(`**${lead}**${extra.length ? extra.join('；') + '。' : ''}`, '');
  out.push('| 建议提单 | 已知仍在 | 按裁决过滤 | 可容忍 | 环境问题 | 检查点待修 |', '| ---: | ---: | ---: | ---: | ---: | ---: |');
  out.push(`| ${groups.file.length} | ${s.knownBug} | ${s.suppressed} | ${groups.tolerable.length} | ${groups.env.length} | ${groups.checks.length} |`, '');

  if (groups.env.length) {
    out.push('## 先处理：环境问题（不是产品问题）', '');
    for (const f of groups.env) out.push(`- **${f.title}**：${f.observed ?? ''}${f.note ? `。${f.note}` : ''}`);
    out.push('');
  }
  out.push('## 建议提单', '');
  if (!groups.file.length) out.push('无。', '');
  for (const f of groups.file.sort((a, b) => (a.tier === 'wall' ? 0 : 1) - (b.tier === 'wall' ? 0 : 1))) out.push(card(f));

  const detected = findings.filter(f => f.detector);
  if (detected.length) {
    const byKind = new Map();
    for (const f of detected) {
      const row = byKind.get(f.kind) ?? { total: 0, fileable: 0 };
      row.total++;
      if (fileable(f)) row.fileable++;
      byKind.set(f.kind, row);
    }
    out.push(`## 无参照物检测（${detected.length} 条）`, '');
    out.push('这些检查不需要参照站：只读页面自身的 DOM、计算样式、性能条目与页面文字，判断「页面能跑但看起来/用起来不对」。'
      + '每条都带定位与实测值；按类别汇总如下，明细在「建议提单 / 可容忍」两节里。', '');
    out.push('| 类别 | 命中 | 其中建议提单 |', '| --- | ---: | ---: |');
    for (const [kind, row] of [...byKind.entries()].sort((a, b) => b[1].total - a[1].total)) {
      out.push(`| ${GROUP[kind] ?? KIND[kind] ?? kind} | ${row.total} | ${row.fileable} |`);
    }
    out.push('');
  }

  if (groups.checks.length) {
    out.push('## 检查点没对上（先确认检查点写对了，再判断是不是问题）', '');
    out.push('这些检查点要么执行出错，要么找不到要检查的元素。常见原因是选择器或预期文字写得太死（例如页面写「30s」，检查点却在找「秒」）。', '');
    for (const f of groups.checks) out.push(`- ${f.id} **${f.title}**（${f.path}）：${f.observed ?? ''}`);
    out.push('');
  }
  if (groups.suppressed.length) {
    out.push(`## 按以往裁决过滤掉的（${groups.suppressed.length} 条）`, '');
    out.push('每条都能追溯到当时的裁决。觉得哪条规则不对，用 `heimdall qa verdict --revoke <规则编号>` 撤销。', '');
    out.push('| 规则 | 裁决 | 理由 | 命中 | 例子 |', '| --- | --- | --- | ---: | --- |');
    for (const h of hits.filter(h => groups.suppressed.some(f => f.triage.rule === h.rule))) {
      out.push(`| \`${h.rule}\` | ${VERDICT_LABEL[h.verdict] ?? h.verdict} | ${esc(h.reason).slice(0, 80)} | ${h.count} | ${esc(h.examples[0]).slice(0, 60)} |`);
    }
    out.push('');
  }
  if (groups.tolerable.length) {
    out.push(`## 可容忍，未入单（${groups.tolerable.length} 条）`, '');
    out.push('<details><summary>展开</summary>', '');
    for (const f of groups.tolerable) out.push(`- ${f.id} ${f.title} · ${where(f)}${f.observed ? ` · ${esc(f.observed).slice(0, 120)}` : ''} · \`${f.fingerprint}\``);
    out.push('', '</details>', '');
  }
  out.push('## 覆盖范围', '');
  out.push(`视口：${run.coverage.viewports.join('、')}。页面 ${run.coverage.pages.length} 次打开，检查点 ${run.coverage.checks.length} 个。`, '');
  out.push('| 页面 | 视口 | 结果 | 控制台 | 4xx/5xx | 坏链/已查 | 坏图 |', '| --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const p of run.coverage.pages) {
    out.push(`| ${p.path} | ${p.viewport} | ${p.unavailableReason === 'login-expired' ? '登录失效' : p.navError ? '打不开：' + esc(p.navError) : p.detectorError ? '检测器执行失败' : '已打开'} | ${p.counts.console + p.counts.pageErrors} | ${p.counts.http} | ${p.counts.brokenLinks}/${p.counts.linksChecked} | ${p.counts.brokenImages} |`);
  }
  if (run.coverage.checks.length) {
    out.push('', '| 检查点 | 结果 | 覆盖 |', '| --- | --- | --- |');
    for (const c of run.coverage.checks) {
      const coverage = (c.assertions ?? []).map(a => `${esc(a.selector)}：可见 ${a.matched} 项，不符 ${a.failed} 项`).join('<br>') || '-';
      out.push(`| ${esc(c.title)} | ${c.blockedReason === 'login-expired' ? '登录失效，未完成' : c.pass ? '通过' : c.error ? '执行出错' : '未通过'} | ${coverage} |`);
    }
  }
  out.push('', '## 请求策略', '');
  if (!run.requestPolicy) out.push('- 历史运行未记录请求策略；请核对当时的配置和证据。');
  else if (run.requestPolicy.mode === 'allow') out.push('- 本次配置放行所有 HTTP 方法，可能修改数据。');
  else out.push(`- 默认拦截非 GET/HEAD/OPTIONS 的 HTTP 请求；另配置 ${run.requestPolicy.allowedQueries?.length ?? 0} 条精确 POST 例外。`);
  out.push('- HTTP 方法和路径不能证明业务只读，查询参数、请求体及非 HTTP 操作也不受该规则完整约束。');
  out.push('', '## 没测到的', '');
  out.push('- 本报告列出的页面、检查点与探索之外，不代表已验证下单、支付或其他业务流程。');
  out.push('- 检查点之外的业务规则（价格计算、权限、数据口径）需要按 PRD 写检查点，或由 AI 测试后用 `heimdall qa submit` 提交。');
  if (!run.login) out.push('- 这次没带登录档，需要登录的页面没测。');
  out.push('', '## 怎么处理这份报告', '');
  out.push('对每条建议提单的问题，告诉 Heimdall 你的裁决，下次同样的问题会自动归类：', '');
  out.push('```', `heimdall qa verdict F1 bug "确认是问题，已提单"`, `heimdall qa verdict F2 false-positive "脚本点击不算用户手势，真人点正常"`, `heimdall qa verdict F3 convention "【】是强调写法" --pattern`, '```', '');
  return out.join('\n');
}

export function renderBugs({ ws, run, findings }) {
  const list = findings.filter(fileable).sort((a, b) => (a.tier === 'wall' ? 0 : 1) - (b.tier === 'wall' ? 0 : 1));
  const out = [`# 待提单 · ${ws.project} · ${run.site} · ${run.startedAt.slice(0, 10)}`, ''];
  out.push(`> 来自运行 \`${run.runId}\`（${run.siteUrl}，环境 ${run.environment}）。已排除：以往裁决为误报/约定/暂缓的、可容忍的、环境问题、没对上的检查点。`, '');
  if (!list.length) {
    const incomplete = [];
    if (findings.some(f => f.kind === 'login-expired')) incomplete.push('登录失效的业务页面');
    if (run.coverage.detection?.failedPages?.length) incomplete.push('检测器执行失败的页面');
    if (findings.some(f => ['check-error', 'check-unverified'].includes(f.confidence))) incomplete.push('未能核实的检查点');
    out.push(incomplete.length ? `没有建议提单的问题；${incomplete.join('、')}未完成检查。` : '没有需要提单的问题。', '');
    return out.join('\n');
  }
  for (const f of list) out.push(card(f, { withVerdictHint: false }));
  return out.join('\n');
}
