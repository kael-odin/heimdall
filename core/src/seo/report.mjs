/**
 * seo/report — 报告渲染（自包含 HTML + CSV），无外部依赖
 */
import { CATEGORIES, SEVERITY_LABEL, SEVERITY_PENALTY } from './rules.mjs';
import { esc } from '../html.mjs';

const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const scoreColor = (n) => n == null ? '#64748b' : n >= 90 ? '#059669' : n >= 75 ? '#b45309' : '#dc2626';
const scoreText = (n) => n == null ? '未计算' : String(n);
const geoConfidenceLabel = { high: '高', medium: '中', low: '低' };
const geoStatusLabel = { complete: '完整', partial: '部分', unavailable: '不可用', unknown: '未知' };
const geoEffortLabel = { small: '小', medium: '中', large: '大' };

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
  const geo = report.geo && typeof report.geo === 'object' ? report.geo : null;
  const sitemapLabel = { complete: '已完成声明项和常见地址的受限检查', not_found: '已检查的位置未发现', partial: '采集不完整', unavailable: '采集不可用' }[summary.sitemapCoverage] ?? '采集状态未知';
  const pageRows = pages.map(p => {
    const top = [...(p.issues ?? [])].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).slice(0, 3);
    return `<tr data-score="${p.score}">
      <td class="num" style="color:${scoreColor(p.score)}">${p.score}</td>
      <td><a class="url" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(new URL(p.url).pathname || '/')}</a><div class="subtitle">${esc(p.title || '(无 title)')}</div></td>
      <td class="num">${p.status || 'ERR'}</td>
      <td class="num">${(p.issues ?? []).length}</td>
      <td>${top.map(i => `<span class="pill ${i.severity}">${esc(i.title)}</span>`).join(' ') || '<span class="ok-text">未命中规则</span>'}</td>
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
      <div class="page-meta">${esc(p.url)} · HTTP ${p.status || 'ERR'} · 初始 HTML ${p.robotsEvidence?.initialHtml === 'checked' ? '已核对' : '未核对'} · ${p.wordCount} 词 · LCP ${p.vitals?.lcp != null ? (p.vitals.lcp / 1000).toFixed(2) + 's' : 'n/a'} · CLS ${p.vitals?.cls != null ? p.vitals.cls.toFixed(3) : 'n/a'}</div>
      ${body}
    </details>`;
  }).join('\n');

  const siteIssueHtml = (siteIssues ?? []).map(i => `
    <div class="issue ${i.severity}">
      <div class="issue-head"><span class="pill ${i.severity}">${SEVERITY_LABEL[i.severity]}</span><b>${esc(i.title)}</b><code>${esc(i.id)}</code></div>
      <div class="issue-msg">${esc(i.message)}</div>
      ${i.evidence ? `<pre class="evidence">${esc(i.evidence)}</pre>` : ''}
      ${i.suggestion ? `<div class="suggestion">建议：${esc(i.suggestion)}</div>` : ''}
    </div>`).join('') || '<div class="ok-text">✓ 站点级未命中规则</div>';

  const catRows = Object.entries(CATEGORIES).map(([key, label]) => {
    const c = categories?.[key] ?? { score: 100, issues: 0 };
    return `<div class="cat">
      <div class="cat-top"><span>${label}</span><b style="color:${scoreColor(c.score)}">${c.score}</b></div>
      <div class="bar"><i style="width:${c.score}%;background:${scoreColor(c.score)}"></i></div>
      <div class="cat-sub">${c.issues} 条问题</div>
    </div>`;
  }).join('\n');

  const geoDimensions = Object.entries(geo?.dimensions ?? {}).map(([key, dimension]) => `
    <div class="geo-dim">
      <div class="geo-dim-top"><span>${esc(dimension.label ?? key)}</span><b style="color:${scoreColor(dimension.score)}">${esc(scoreText(dimension.score))}</b></div>
      <div class="bar"><i style="width:${dimension.score == null ? 0 : dimension.score}%;background:${scoreColor(dimension.score)}"></i></div>
      <div class="cat-sub">${esc(geoStatusLabel[dimension.status] ?? '未知')} · ${dimension.pages ?? 0} 页有观测</div>
    </div>`).join('\n');
  const geoRecommendations = (geo?.actionPlan ?? []).slice(0, 5).map(item => `<li><b>${esc(item.priority ?? 'P2')}</b> ${esc(item.action)}</li>`).join('')
    || (geo?.recommendations ?? []).slice(0, 5).map(item => `<li>${esc(item)}</li>`).join('')
    || '<li>当前没有可执行建议。</li>';
  const geoActionRows = (geo?.actionPlan ?? []).map(item => {
    const pages = (item.affectedPages ?? []).slice(0, 5).map(url => `<div class="geo-action-page">${esc(url)}</div>`).join('');
    const evidence = (item.evidence ?? []).slice(0, 2).map(row => `<div class="geo-action-evidence"><b>${esc(row.url ?? '站点级')}</b><br>${esc(row.message ?? '')}${row.detail ? `<br>${esc(row.detail)}` : ''}</div>`).join('');
    return `<tr>
      <td class="num">${esc(item.rank)}</td>
      <td><span class="pill ${esc(item.severity ?? 'info')}">${esc(item.priority ?? 'P2')}</span><br><code>${esc(item.id)}</code></td>
      <td><b>${esc(item.title)}</b><div class="geo-action-text">${esc(item.action)}</div></td>
      <td class="num">${esc(item.impact?.affectedPages ?? 0)} 页<br><span class="subtitle">影响分 ${esc(item.impactScore ?? 0)}</span></td>
      <td>${esc(geoEffortLabel[item.estimatedEffort] ?? item.estimatedEffort ?? '未知')}</td>
      <td>${pages || '<span class="subtitle">未记录页面</span>'}<details><summary>证据与复测</summary>${evidence || '<span class="subtitle">无额外证据</span>'}<div class="geo-action-verify">复测：${esc(item.validation?.method ?? '重新审计')} · ${esc(item.validation?.checkId ?? item.id)} → ${esc(item.validation?.expectedStatus ?? 'pass')}</div></details></td>
    </tr>`;
  }).join('\n');
  const geoActionHtml = geo ? `
    <h3>GEO 行动计划</h3>
    ${geoActionRows ? `<table class="geo-actions"><thead><tr><th>#</th><th>优先级</th><th>要改什么</th><th>影响</th><th>预计成本</th><th>受影响页面 / 证据</th></tr></thead><tbody>${geoActionRows}</tbody></table>` : '<div class="meta">当前没有已观察到的 GEO 失败项。</div>'}
    <p class="meta">影响分 = 检查权重 × 受影响页面数；行动计划只聚合 fail，不把 unknown 当成缺陷。${geo.actionPlanMeta?.truncated ? `当前显示 ${geo.actionPlanMeta.returned}/${geo.actionPlanMeta.total} 项。` : ''}</p>` : '';
  const geoCaveats = (geo?.caveats ?? []).map(item => `<li>${esc(item)}</li>`).join('');
  const geoHtml = geo ? `
  <section class="geo-panel">
    <div class="geo-head">
      <div>
        <h2>GEO 准备度</h2>
        <p class="meta">${esc(geo.label ?? 'AI 可回答与可引用准备度')} · 方法 v${esc(geo.methodVersion ?? '未记录')} · 证据置信度 ${esc(geoConfidenceLabel[geo.confidence] ?? '未知')} · 覆盖 ${geo.coverage?.pagesScored ?? 0}/${geo.coverage?.pages ?? 0} 页</p>
        <p class="meta">证据状态 ${esc(geoStatusLabel[geo.status] ?? '未知')} · 检查权重覆盖 ${esc(geo.coverage?.observedWeight ?? '未知')}/${esc(geo.coverage?.totalWeight ?? '未知')}；部分分数只代表已观测检查。</p>
      </div>
      <div class="geo-score"><b style="color:${scoreColor(geo.score)}">${esc(scoreText(geo.score))}</b><span>GEO ${esc(geo.grade ?? '未定级')}</span></div>
    </div>
    <div class="geo-dims">${geoDimensions || '<div class="meta">没有足够页面证据生成维度分数。</div>'}</div>
    <div class="geo-columns">
      <div><b>优先建议</b><ul>${geoRecommendations}</ul></div>
      <div><b>边界说明</b><ul>${geoCaveats}</ul></div>
    </div>
    ${geoActionHtml}
  </section>` : '';

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
  .geo-panel { background:#fff; border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin:28px 0 34px; }
  .geo-head { display:flex; align-items:center; gap:18px; justify-content:space-between; }
  .geo-head h2 { margin:0 0 4px; }
  .geo-score { min-width:92px; text-align:center; border-left:1px solid var(--line); padding-left:18px; }
  .geo-score b { display:block; font-size:30px; line-height:1.1; }
  .geo-score span { color:var(--muted); font-size:11px; }
  .geo-dims { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin:18px 0; }
  .geo-dim { border-top:1px solid var(--line); padding-top:10px; }
  .geo-dim-top { display:flex; justify-content:space-between; font-size:13px; }
  .geo-columns { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:20px; color:var(--muted); font-size:12px; }
  .geo-columns b { color:var(--ink); }
  .geo-columns ul { margin:8px 0 0; padding-left:18px; }
  .geo-columns li { margin:4px 0; }
  .geo-actions { margin:12px 0 0; font-size:12px; }
  .geo-actions th, .geo-actions td { padding:8px 9px; }
  .geo-actions code { color:var(--muted); font-size:10px; }
  .geo-action-text { color:var(--muted); margin-top:3px; }
  .geo-action-page { max-width:330px; overflow-wrap:anywhere; }
  .geo-actions details { margin-top:5px; }
  .geo-actions summary { color:var(--cyan); cursor:pointer; }
  .geo-action-evidence { margin:6px 0; color:var(--muted); overflow-wrap:anywhere; }
  .geo-action-verify { color:var(--cyan); margin-top:6px; }
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
    <div class="score-ring"><div><b style="color:${scoreColor(score)}">${score}</b><span>${summary.baselineEligible === false ? '暂算分' : '站点分'}</span></div></div>
  </header>

  <p class="meta">收录指令按本次浏览器收到的通用与 Googlebot 指令解释；不代表搜索引擎实际收录、排名或 AI 引用。初始 HTML 未核对的页面仍有漏检风险。</p>
  <p class="meta">评分口径：${esc(report.scoreMethodVersion ?? '未记录')}；测量口径：${esc(report.measurementVersion ?? '未记录')}。${[2, 3, 4, 5, 6, 7, 8, 9, 10].includes(report.scoreMethodVersion) ? '文本/DOM 比例仅供观察，不扣分；两者按 UTF-16 代码单元计算。' : '历史或未知口径不能与当前分数直接比较。'}${[2, 3, 4, 5, 6].includes(report.measurementVersion) ? 'HTML 字节数是解码内容重新编码为 UTF-8 的大小，不是网络传输量。' : '历史或未知口径的 HTML 字节数不可按当前单位解释。'}</p>
  ${[3, 4, 5, 6, 7, 8, 9, 10].includes(report.scoreMethodVersion) ? '<p class="meta">robots.txt 返回 404/410 或已检查的位置未发现 sitemap，仅为待核查提示，不单独扣分；本次采集不代表搜索引擎实际抓取或收录。</p>' : ''}
  ${[4, 5, 6].includes(report.measurementVersion) ? '<p class="meta">子资源类别按浏览器发起类型和页面声明估算，每条只归入一类；CSS 发起的部分资源按地址后缀推测。未分类、缓存及跨源限制可能影响数字，它们不是完整的网络传输量。</p>' : ''}
  <p class="meta">${[3, 4, 5, 6].includes(report.measurementVersion) ? '结构化数据提示仅检查 JSON-LD 顶层及 @graph 类型和 microdata 标记，不检查 RDFa；发现类型不代表搜索引擎认可或富结果合格。' : '历史或未知测量口径可能遗漏 @graph 类型，不能据此认定没有结构化数据；RDFa 未核实。'}</p>
  ${[6, 7, 8, 9, 10].includes(report.scoreMethodVersion) ? '<p class="meta">结构化数据常见字段仅作不扣分的待核查提示，不判定必填或富结果资格；不因相对图片地址扣分，字段仅为受限投影，未验证图片可抓取性或合并跨脚本实体引用。</p>' : ''}
  ${[8, 9, 10].includes(report.scoreMethodVersion) ? '<p class="meta">hreflang 按完整地址匹配访问地址或声明的 canonical，未验证其他 URL 的等价关系及双向链接；语言检查仅针对 Google 标记形式，不核对 ISO 代码表成员或通用 BCP 47 合法性。x-default 是按回退需求配置的不扣分建议，HTTP Link 与 sitemap 语言声明未检查。</p>' : ''}
  ${[9, 10].includes(report.scoreMethodVersion) ? '<p class="meta">同一数字分页序列允许共用标题和描述，只给不扣分建议；跨栏目、筛选条件和来源仍分开检查。分页与分面 canonical 按完整 HTTP(S) 地址比较，非自指声明不证明内容等价或抓取收敛。分面页是否收录或归并须按实际内容和发布意图确认。</p>' : ''}
  ${report.measurementVersion === 6 ? '<p class="meta">JSON-LD 使用标准处理器及固定的本地 Schema.org 上下文展开别名和类型；未自动访问其他远程上下文。上下文无法核实或超限时保留未知并跳过基线，字段投影受限时 GEO 不把未观察字段当作缺陷。</p>' : ''}
  <p class="meta">资源体积取本次浏览器可见子资源的传输或编码大小估算，不含主文档；缓存、跨源限制和条目上限可能影响完整性，不等同于完整网络流量。</p>
  <p class="meta">图片格式提示仅匹配图片地址后缀，不能证明响应类型或实际编码；旧报告中的“张为 jpg/png”也只表示后缀匹配。</p>
  <p class="meta">sitemap：${esc(sitemapLabel)}。仅限同来源的声明项与常见地址，不能证明其他位置不存在地图。${summary.baselineEligible === false ? '采集存在缺口，分数仅供参考，不能作为基线或门禁依据。' : ''}${summary.legacyBaseline ? '旧基线未记录采集完整性，本次未比对。' : ''}${summary.baselineMethodMismatch ? '基线评分或测量口径缺失或不兼容，本次未比对。' : ''}</p>

  <div class="kpis">
    <div class="kpi"><b>${summary.pages}</b><span>采集页面</span></div>
    <div class="kpi"><b style="color:#b91c1c">${summary.bySeverity.critical ?? 0}</b><span>严重问题</span></div>
    <div class="kpi"><b style="color:#c2410c">${summary.bySeverity.high ?? 0}</b><span>高优先级</span></div>
    <div class="kpi"><b style="color:#a16207">${summary.bySeverity.medium ?? 0}</b><span>中优先级</span></div>
    <div class="kpi"><b>${summary.issues}</b><span>问题总数</span></div>
  </div>

  <h2>分类得分</h2>
  <div class="cats">${catRows}</div>

  ${geoHtml}

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
