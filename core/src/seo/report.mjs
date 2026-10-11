/**
 * seo/report — 报告渲染（自包含 HTML + CSV），无外部依赖
 */
import { CATEGORIES, SEVERITY_LABEL, SEVERITY_PENALTY } from './rules.mjs';
import { esc } from '../html.mjs';

const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const scoreColor = (n) => n >= 90 ? '#059669' : n >= 75 ? '#b45309' : '#dc2626';

export function renderCsv(report) {
  const rows = [['page', 'score', 'status', 'severity', 'rule', 'category', 'title', 'message', 'evidence', 'suggestion']];
  for (const p of report.pages) {
    const issues = [...(p.issues ?? [])].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
    if (!issues.length) rows.push([p.url, p.score, p.status, '', '', '', '', '', '', '']);
    for (const i of issues) rows.push([p.url, p.score, p.status, i.severity, i.id, CATEGORIES[i.category] ?? i.category, i.title, i.message, i.evidence, i.suggestion]);
  }
  for (const i of report.siteIssues ?? []) rows.push(['(site)', '', '', i.severity, i.id, CATEGORIES[i.category] ?? i.category, i.title, i.message, i.evidence, i.suggestion]);
  return rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function renderHtml(report) {
  const { host, origin, generatedAt, score, pages, siteIssues, summary, categories, config } = report;
  const pageRows = pages.map(p => {
    const top = [...(p.issues ?? [])].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).slice(0, 3);
    return `<tr data-score="${p.score}">
      <td class="num" style="color:${scoreColor(p.score)}">${p.score}</td>
      <td><a class="url" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(new URL(p.url).pathname || '/')}</a><div class="subtitle">${esc(p.title || '(无 title)')}</div></td>
      <td class="num">${p.status || 'ERR'}</td>
      <td class="num">${(p.issues ?? []).length}</td>
      <td>${top.map(i => `<span class="pill ${i.severity}">${esc(i.title)}</span>`).join(' ') || '<span class="ok-text">通过</span>'}</td>
    </tr>`;
  }).join('\n');

  const detail = pages.map(p => {
    const issues = [...(p.issues ?? [])].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
    const body = issues.length ? issues.map(i => `
      <div class="issue ${i.severity}">
        <div class="issue-head"><span class="pill ${i.severity}">${SEVERITY_LABEL[i.severity]}</span><b>${esc(i.title)}</b><code>${esc(i.id)}</code></div>
        <div class="issue-msg">${esc(i.message)}</div>
        ${i.evidence ? `<pre class="evidence">${esc(i.evidence)}</pre>` : ''}
        ${i.suggestion ? `<div class="suggestion">建议：${esc(i.suggestion)}</div>` : ''}
      </div>`).join('') : '<div class="ok-text">✓ 未发现规则命中</div>';
    return `<details class="page-detail" id="p-${esc(p.url)}">
      <summary><span class="num" style="color:${scoreColor(p.score)}">${p.score}</span> ${esc(new URL(p.url).pathname || '/')} <span class="subtitle">${esc(p.title || '')}</span></summary>
      <div class="page-meta">${esc(p.url)} · HTTP ${p.status || 'ERR'} · ${p.wordCount} 词 · LCP ${p.vitals?.lcp != null ? (p.vitals.lcp / 1000).toFixed(2) + 's' : 'n/a'} · CLS ${p.vitals?.cls != null ? p.vitals.cls.toFixed(3) : 'n/a'}</div>
      ${body}
    </details>`;
  }).join('\n');

  const siteIssueHtml = (siteIssues ?? []).map(i => `
    <div class="issue ${i.severity}">
      <div class="issue-head"><span class="pill ${i.severity}">${SEVERITY_LABEL[i.severity]}</span><b>${esc(i.title)}</b><code>${esc(i.id)}</code></div>
      <div class="issue-msg">${esc(i.message)}</div>
      ${i.evidence ? `<pre class="evidence">${esc(i.evidence)}</pre>` : ''}
      ${i.suggestion ? `<div class="suggestion">建议：${esc(i.suggestion)}</div>` : ''}
    </div>`).join('') || '<div class="ok-text">✓ 站点级未发现问题</div>';

  const catRows = Object.entries(CATEGORIES).map(([key, label]) => {
    const c = categories?.[key] ?? { score: 100, issues: 0 };
    return `<div class="cat">
      <div class="cat-top"><span>${label}</span><b style="color:${scoreColor(c.score)}">${c.score}</b></div>
      <div class="bar"><i style="width:${c.score}%;background:${scoreColor(c.score)}"></i></div>
      <div class="cat-sub">${c.issues} 条问题</div>
    </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Heimdall SEO 审计 · ${esc(host)}</title>
<style>
:root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; --cyan:#0891b2; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:'Segoe UI',system-ui,-apple-system,'Noto Sans SC','Microsoft YaHei',sans-serif; line-height:1.55; }
.wrap { max-width:1180px; margin:0 auto; padding:36px 28px 80px; }
header { display:flex; align-items:center; gap:24px; flex-wrap:wrap; }
.brand { font-size:13px; letter-spacing:.28em; color:var(--cyan); font-weight:700; }
h1 { margin:4px 0 0; font-size:30px; }
.meta { color:var(--muted); font-size:13px; }
.score-ring { margin-left:auto; width:132px; height:132px; border-radius:50%; display:grid; place-items:center; background:conic-gradient(${scoreColor(score)} ${score}%, #e2e8f0 0); }
.score-ring > div { width:106px; height:106px; border-radius:50%; background:#fff; display:grid; place-items:center; text-align:center; }
.score-ring b { font-size:34px; display:block; line-height:1; }
.score-ring span { font-size:11px; color:var(--muted); }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:28px 0; }
.kpi { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.kpi b { font-size:24px; display:block; }
.kpi span { color:var(--muted); font-size:12px; }
.cats { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; margin:20px 0 34px; }
.cat { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.cat-top { display:flex; justify-content:space-between; font-size:14px; }
.bar { height:6px; background:#eef2f7; border-radius:4px; margin:10px 0 6px; overflow:hidden; }
.bar i { display:block; height:100%; border-radius:4px; }
.cat-sub { font-size:12px; color:var(--muted); }
h2 { margin:36px 0 12px; font-size:20px; }
table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
th, td { text-align:left; padding:11px 12px; border-bottom:1px solid var(--line); vertical-align:top; font-size:13px; }
th { background:#f1f5f9; font-size:12px; color:var(--muted); letter-spacing:.04em; }
td.num { font-variant-numeric:tabular-nums; font-weight:700; }
a.url { color:var(--cyan); text-decoration:none; font-weight:600; }
.subtitle { color:var(--muted); font-size:12px; }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; margin:1px 2px; }
.pill.critical { background:#fee2e2; color:#b91c1c; }
.pill.high { background:#ffedd5; color:#c2410c; }
.pill.medium { background:#fef9c3; color:#a16207; }
.pill.low { background:#e0f2fe; color:#0369a1; }
.pill.info { background:#f1f5f9; color:#475569; }
.ok-text { color:#059669; font-size:13px; }
.page-detail { background:#fff; border:1px solid var(--line); border-radius:10px; margin:10px 0; padding:12px 16px; }
.page-detail summary { cursor:pointer; font-weight:600; }
.page-meta { color:var(--muted); font-size:12px; margin:8px 0 12px; word-break:break-all; }
.issue { border-left:4px solid #cbd5e1; padding:10px 12px; margin:10px 0; background:#f8fafc; border-radius:0 8px 8px 0; }
.issue.critical { border-color:#dc2626; } .issue.high { border-color:#ea580c; } .issue.medium { border-color:#ca8a04; } .issue.low { border-color:#0284c7; } .issue.info { border-color:#94a3b8; }
.issue-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.issue-head code { color:var(--muted); font-size:11px; }
.issue-msg { font-size:13px; margin-top:4px; }
.evidence { background:#0f172a; color:#e2e8f0; padding:8px 10px; border-radius:6px; font-size:12px; overflow:auto; white-space:pre-wrap; }
.suggestion { color:#0369a1; font-size:12px; margin-top:6px; }
footer { margin-top:44px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <div class="brand">HEIMDALL · SEO AUDIT</div>
      <h1>${esc(host)} SEO 审计报告</h1>
      <div class="meta">${esc(origin)} · ${esc(generatedAt)} · 采集 ${config.max} 页上限 · 视口 ${esc(config.viewport)}</div>
    </div>
    <div class="score-ring"><div><b style="color:${scoreColor(score)}">${score}</b><span>站点分</span></div></div>
  </header>

  <div class="kpis">
    <div class="kpi"><b>${summary.pages}</b><span>采集页面</span></div>
    <div class="kpi"><b style="color:#b91c1c">${summary.bySeverity.critical ?? 0}</b><span>严重问题</span></div>
    <div class="kpi"><b style="color:#c2410c">${summary.bySeverity.high ?? 0}</b><span>高优先级</span></div>
    <div class="kpi"><b style="color:#a16207">${summary.bySeverity.medium ?? 0}</b><span>中优先级</span></div>
    <div class="kpi"><b>${summary.issues}</b><span>问题总数</span></div>
  </div>

  <h2>分类得分</h2>
  <div class="cats">${catRows}</div>

  <h2>站点级问题</h2>
  ${siteIssueHtml}

  <h2>页面概览</h2>
  <table>
    <thead><tr><th>分数</th><th>页面</th><th>状态</th><th>问题</th><th>主要问题</th></tr></thead>
    <tbody>${pageRows}</tbody>
  </table>

  <h2>逐页明细</h2>
  ${detail}

  <footer>由 Heimdall SEO 审计生成 · 规则引擎 v1 · 分数 = 100 − 严重度扣分（严重25/高12/中6/低2）· 本报告仅用于内部分析</footer>
</div>
</body>
</html>`;
}
