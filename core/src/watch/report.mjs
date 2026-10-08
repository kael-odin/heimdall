/**
 * watch/report — 变更报告（自包含 HTML）
 */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const trunc = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };
const sevColor = { high: '#dc2626', medium: '#ca8a04', low: '#0284c7', info: '#64748b' };

export function renderWatchHtml(report) {
  const { host, generatedAt, baselineAt, summary, diff } = report;
  const changedRows = diff.changed.map(c => `
    <div class="page">
      <div class="page-head"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(trunc(c.url, 120))}</a><span>${esc(trunc(c.title, 80))}</span></div>
      ${c.fields.map(f => `<div class="field ${f.severity}">
        <span class="pill" style="background:${sevColor[f.severity]}">${esc(f.label)}</span>
        <div class="val"><del>${esc(trunc(f.before, 220) || '(空)')}</del><ins>${esc(trunc(f.after, 220) || '(空)')}</ins></div>
      </div>`).join('')}
    </div>`).join('') || '<div class="ok">✓ 没有字段变化</div>';
  const list = (items, kind) => items.length ? `<ul class="list">${items.map(i => `<li><b>${kind}</b> ${esc(i.url)} <span>${esc(trunc(i.title, 80))}</span></li>`).join('')}</ul>` : '<div class="ok">无</div>';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall 变更监控 · ${esc(host)}</title>
<style>
body{margin:0;background:#f8fafc;color:#0f172a;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif;line-height:1.55}
.wrap{max-width:1080px;margin:0 auto;padding:36px 28px 80px}.brand{color:#0891b2;letter-spacing:.28em;font-size:12px;font-weight:700}
h1{margin:6px 0 4px;font-size:28px}.meta{color:#64748b;font-size:13px;margin-bottom:24px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0 30px}
.kpi{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px}.kpi b{font-size:24px;display:block}.kpi span{color:#64748b;font-size:12px}
h2{margin:28px 0 10px;font-size:19px}.page{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:10px 0}
.page-head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}.page-head a{color:#0891b2;text-decoration:none;font-weight:600;font-size:13px;word-break:break-all}.page-head span{color:#64748b;font-size:12px}
.field{border-left:3px solid #cbd5e1;padding:6px 10px;margin:8px 0;background:#f8fafc}.field.high{border-color:#dc2626}.field.medium{border-color:#ca8a04}.field.low{border-color:#0284c7}
.pill{display:inline-block;color:#fff;border-radius:999px;padding:1px 8px;font-size:11px;margin-right:6px}
.val del{color:#b91c1c;text-decoration:line-through;display:block;font-size:12.5px}.val ins{color:#047857;text-decoration:none;display:block;font-size:12.5px}
.ok{color:#059669;font-size:13px;padding:8px 0}.list{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 16px 10px 30px;font-size:13px}.list span{color:#64748b;font-size:12px}
footer{margin-top:40px;color:#64748b;font-size:12px}
</style></head><body><div class="wrap">
<div class="brand">HEIMDALL · SITE WATCH</div><h1>${esc(host)} 变更监控报告</h1>
<div class="meta">本次采集 ${esc(generatedAt)} · 基线 ${esc(baselineAt ?? '(首次)')} · 对比页面 ${summary.total} · 有变化 ${summary.changedTotal}</div>
<div class="kpis">
<div class="kpi"><b>${diff.added.length}</b><span>新增页面</span></div>
<div class="kpi"><b>${diff.removed.length}</b><span>移除页面</span></div>
<div class="kpi"><b>${diff.changed.length}</b><span>内容变化</span></div>
<div class="kpi"><b style="color:#dc2626">${diff.bySeverity.high ?? 0}</b><span>高优先级变化</span></div>
<div class="kpi"><b>${diff.unchanged}</b><span>无变化</span></div>
</div>
<h2>字段变化</h2>${changedRows}
${(diff.dynamic ?? []).length ? `<h2>动态噪声（两次采样不一致，已排除判定）</h2>${diff.dynamic.map(d => `<div class="page"><div class="page-head"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(trunc(d.url, 120))}</a></div><div class="val">${d.fields.map(f => `${esc(f.label)}`).join(' · ')}</div></div>`).join('')}` : ''}
<h2>新增页面</h2>${list(diff.added, '新增')}
<h2>移除页面</h2>${list(diff.removed, '移除')}
<footer>由 Heimdall 变更监控生成 · 仅供内部分析 · 正文变化以 textHash 判定，字段明细可点开原站核对</footer>
</div></body></html>`;
}
