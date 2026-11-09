/**
 * seo/matrix-core — 竞品对标矩阵（纯函数）
 */
import { esc } from '../html.mjs';

export function categorize(url) {
  const p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return String(url).toLowerCase(); } })();
  if (p === '/' || p === '') return 'home';
  if (/pricing|plans?|billing/.test(p)) return 'pricing';
  if (/blog|news|article|post/.test(p)) return 'blog';
  if (/docs?|guide|manual|reference|academy|university/.test(p)) return 'docs';
  if (/product|feature|solution|use-case|proxy/.test(p)) return 'product';
  if (/about|company|contact|team|partner/.test(p)) return 'company';
  if (/store|marketplace|actors?|templates|integrations|apps/.test(p)) return 'listing';
  return 'other';
}

const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const siteLabel = (audit) => audit.origin ?? audit.host;

export function siteAggregate(audit) {
  const pages = audit.pages ?? [];
  const withSignals = pages.filter(p => p.status > 0);
  const baselineEligible = audit.summary?.baselineEligible === true;
  return {
    host: siteLabel(audit),
    score: baselineEligible ? (audit.score ?? null) : null,
    scoreMethodVersion: audit.scoreMethodVersion ?? null,
    baselineEligible,
    sitemapCoverage: audit.summary?.sitemapCoverage ?? 'unknown',
    pages: pages.length,
    avgTitleLen: round(avg(withSignals.map(p => p.titleLength ?? 0)), 0),
    descRate: pct(withSignals.filter(p => (p.descriptionLength ?? 0) > 0).length, withSignals.length),
    h1Rate: pct(withSignals.filter(p => (p.h1 ?? []).length === 1).length, withSignals.length),
    jsonldRate: pct(withSignals.filter(p => (p.jsonld ?? []).some(j => j.ok && (j.types ?? []).length)).length, withSignals.length),
    avgLcp: round(avg(withSignals.map(p => p.vitals?.lcp).filter(v => typeof v === 'number')) , 0),
    avgWords: round(avg(withSignals.map(p => p.wordCount ?? 0)), 0),
    issuesPerPage: baselineEligible ? round((audit.summary?.issues ?? 0) / Math.max(pages.length, 1), 1) : null,
    bySeverity: audit.summary?.bySeverity ?? {},
  };
}

export function buildMatrix(audits) {
  const eligible = audits.filter(a => a.summary?.baselineEligible === true);
  const versions = eligible.map(a => a.scoreMethodVersion);
  const reason = versions.length < 2 ? 'insufficient-eligible-audits'
    : versions.some(v => !Number.isSafeInteger(v) || v < 1) ? 'unknown-method'
      : versions.some(v => v !== versions[0]) ? 'method-mismatch' : null;
  const comparable = reason === null;
  const sites = audits.map(a => {
    const aggregate = siteAggregate(a);
    if (!comparable) { aggregate.score = null; aggregate.issuesPerPage = null; }
    return { host: siteLabel(a), aggregate };
  });
  const types = ['home', 'pricing', 'product', 'listing', 'docs', 'blog', 'company', 'other'];
  const rows = [];
  for (const type of types) {
    const cells = audits.map(a => {
      const pages = (a.pages ?? []).filter(p => categorize(p.url) === type);
      return {
        host: siteLabel(a),
        pages: pages.length,
        avgScore: comparable && a.summary?.baselineEligible === true ? round(avg(pages.map(p => p.score)), 1) : null,
        avgWords: round(avg(pages.map(p => p.wordCount ?? 0)), 0),
        avgLcp: round(avg(pages.map(p => p.vitals?.lcp).filter(v => typeof v === 'number')), 0),
      };
    });
    if (cells.some(c => c.pages > 0)) rows.push({ type, cells });
  }
  // 各站 Top 问题
  const topIssues = audits.map(a => {
    const counts = {};
    for (const p of a.pages ?? []) for (const i of p.issues ?? []) counts[i.id] = (counts[i.id] ?? 0) + 1;
    for (const i of a.siteIssues ?? []) counts[i.id] = (counts[i.id] ?? 0) + 1;
    return { host: siteLabel(a), top: Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([id, count]) => ({ id, count })) };
  });
  return { generatedAt: new Date().toISOString(), scoreComparison: { comparable, methodVersion: comparable ? versions[0] : null, reason }, sites, rows, topIssues };
}

const fmt = (v, suffix = '') => (v == null ? '—' : String(v) + suffix);

export function renderMatrixCsv(matrix) {
  const header = ['metric', ...matrix.sites.map(s => s.host)];
  const rows = [
    header,
    ['site_score', ...matrix.sites.map(s => fmt(s.aggregate.score))],
    ['score_method_version', ...matrix.sites.map(s => fmt(s.aggregate.scoreMethodVersion))],
    ['score_comparable', ...matrix.sites.map(() => String(matrix.scoreComparison?.comparable === true))],
    ['baseline_eligible', ...matrix.sites.map(s => String(s.aggregate.baselineEligible))],
    ['sitemap_coverage', ...matrix.sites.map(s => s.aggregate.sitemapCoverage)],
    ['pages', ...matrix.sites.map(s => fmt(s.aggregate.pages))],
    ['avg_title_len', ...matrix.sites.map(s => fmt(s.aggregate.avgTitleLen))],
    ['description_rate_%', ...matrix.sites.map(s => fmt(s.aggregate.descRate))],
    ['h1_rate_%', ...matrix.sites.map(s => fmt(s.aggregate.h1Rate))],
    ['jsonld_rate_%', ...matrix.sites.map(s => fmt(s.aggregate.jsonldRate))],
    ['avg_lcp_ms', ...matrix.sites.map(s => fmt(s.aggregate.avgLcp))],
    ['avg_words', ...matrix.sites.map(s => fmt(s.aggregate.avgWords))],
    ['issues_per_page', ...matrix.sites.map(s => fmt(s.aggregate.issuesPerPage))],
    [],
    ['page_type_pages', ...matrix.sites.map(s => s.host)],
    ...matrix.rows.map(r => [r.type, ...r.cells.map(c => c.pages)]),
    [],
    ['page_type_avg_score', ...matrix.sites.map(s => s.host)],
    ...matrix.rows.map(r => [r.type, ...r.cells.map(c => fmt(c.avgScore))]),
    [],
    ['top_issues'],
    ...matrix.topIssues.flatMap(t => t.top.map(i => [t.host, i.id, i.count])),
  ];
  return rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function renderMatrixHtml(matrix) {
  const best = (key) => {
    const vals = matrix.sites.map(s => s.aggregate[key]).filter(v => typeof v === 'number');
    return vals.length ? Math.max(...vals) : null;
  };
  const metricRows = [
    ['站点分', 'score', '', true],
    ['采集页面', 'pages', '', false],
    ['平均 title 长度', 'avgTitleLen', '', false],
    ['description 覆盖率', 'descRate', '%', true],
    ['H1 规范率', 'h1Rate', '%', true],
    ['结构化数据覆盖率', 'jsonldRate', '%', true],
    ['平均 LCP', 'avgLcp', 'ms', false],
    ['平均字数', 'avgWords', '', true],
    ['每页问题数', 'issuesPerPage', '', false],
  ].map(([label, key, suffix, higherBetter]) => {
    const values = matrix.sites.map(s => s.aggregate[key]);
    const b = values.filter(v => typeof v === 'number');
    const bestVal = b.length ? (higherBetter ? Math.max(...b) : Math.min(...b)) : null;
    const cells = matrix.sites.map(s => {
      const v = s.aggregate[key];
      const isBest = bestVal != null && v === bestVal;
      return `<td class="${isBest ? 'best' : ''}">${fmt(v, suffix)}</td>`;
    }).join('');
    return `<tr><th>${esc(label)}</th>${cells}</tr>`;
  }).join('');

  const typeRows = matrix.rows.map(r => `<tr><th>${esc(r.type)}</th>${r.cells.map(c => `<td><b>${c.pages}</b> 页<br/><span>分 ${fmt(c.avgScore)} · ${fmt(c.avgWords)} 词</span></td>`).join('')}</tr>`).join('');

  const issues = matrix.topIssues.map(t => `<tr><th>${esc(t.host)}</th><td>${t.top.map(i => `<span class="tag">${esc(i.id)} ×${i.count}</span>`).join(' ') || '—'}</td></tr>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall SEO 对标矩阵</title>
<style>
body{margin:0;background:#f8fafc;color:#0f172a;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:36px 26px 80px}.brand{color:#0891b2;letter-spacing:.28em;font-size:12px;font-weight:700}
h1{margin:6px 0 4px;font-size:28px}.meta{color:#64748b;font-size:13px;margin-bottom:24px}
h2{margin:28px 0 10px;font-size:18px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef2f7;font-size:13px}
th{background:#f1f5f9;color:#475569;font-weight:600;width:210px}
td{font-variant-numeric:tabular-nums}td span{color:#64748b;font-size:11.5px}
td.best{color:#059669;font-weight:700;background:#f0fdf4}
.tag{display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:1px 8px;font-size:11px;margin:2px 0}
footer{margin-top:36px;color:#64748b;font-size:12px}
</style></head><body><div class="wrap">
<div class="brand">HEIMDALL · SEO BENCHMARK</div><h1>竞品 SEO 对标矩阵</h1>
<div class="meta">${matrix.sites.map(s => esc(s.host)).join(' vs ')} · ${esc(matrix.generatedAt)} · 绿色 = 该指标最优 · 样本量不同时优先对比比率/均值</div>
<div class="meta">采集不完整或旧报告未记录采集状态时，不比较分数和每页问题数。其他指标仅描述本次采集样本。</div>
<div class="meta">${matrix.scoreComparison?.comparable ? `评分口径 ${esc(matrix.scoreComparison.methodVersion)}；页面集合不同时分数仍需谨慎解释。` : matrix.scoreComparison?.reason === 'insufficient-eligible-audits' ? '完整审计不足两份，已隐藏分数和每页问题数。' : '评分口径缺失或不一致，已隐藏分数和每页问题数；请重新采集同口径报告。'}</div>
<h2>总体指标</h2><table><tbody><tr><th>指标</th>${matrix.sites.map(s => `<th>${esc(s.host)}</th>`).join('')}</tr>${metricRows}</tbody></table>
<h2>页面类型分布</h2><table><tbody><tr><th>页面类型</th>${matrix.sites.map(s => `<th>${esc(s.host)}</th>`).join('')}</tr>${typeRows || '<tr><td>—</td></tr>'}</tbody></table>
<h2>各站高频问题</h2><table><tbody>${issues}</tbody></table>
<footer>数据来自 Heimdall SEO 审计（workspace/&lt;siteId&gt;/seo/seo.json）· 仅供内部分析</footer>
</div></body></html>`;
}
