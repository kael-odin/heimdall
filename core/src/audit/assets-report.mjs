/**
 * audit/assets-report — 资产缺口报告（视觉缺口优先，自包含 HTML）
 */
import { esc } from '../html.mjs';

const trunc = (s, n = 120) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };
const catLabel = { visual: '视觉', metadata: '元数据', tracking: '追踪', replaced: '设计替代' };

export function renderAssetGapsHtml(report) {
  const { host, generatedAt, summary, pages } = report;
  const rate = summary.refs ? (summary.localized / summary.refs * 100).toFixed(1) : '—';
  const sorted = [...pages].sort((a, b) => (b.visualGaps ?? 0) - (a.visualGaps ?? 0) || b.gaps.length - a.gaps.length);
  const rows = sorted.map(p => {
    const localRate = p.refs ? ((p.localized / p.refs) * 100).toFixed(1) : '—';
    return `<tr>
      <td class="name">${esc(p.page)}</td>
      <td class="num">${p.refs}</td>
      <td class="num">${p.localized}</td>
      <td class="num ${Number(localRate) >= 99 ? 'ok' : Number(localRate) >= 90 ? 'mid' : 'bad'}">${localRate}%</td>
      <td class="num ${(p.visualGaps ?? 0) === 0 ? 'ok' : 'bad'}">${p.visualGaps ?? 0}</td>
      <td class="num">${p.visualOrigin ?? 0}</td>
      <td class="num">${p.visualThird ?? 0}</td>
      <td class="num">${p.gaps.length}</td>
    </tr>`;
  }).join('');

  const details = sorted.slice(0, 20).map(p => {
    const visual = p.gaps.filter(g => g.category === 'visual');
    const others = p.gaps.filter(g => g.category !== 'visual');
    const gapRow = (g) => `<tr>
      <td class="${g.category === 'visual' ? 'bad' : ''}">${esc(catLabel[g.category] ?? g.category ?? '-')}</td>
      <td>${esc(g.kind)}</td>
      <td class="${g.status === 'remote-origin' ? 'bad' : 'mid'}">${g.status === 'remote-origin' ? '仍指向原站' : '第三方远程'}</td>
      <td>${esc((g.froms ?? []).join(','))}</td>
      <td>${esc(g.where)}</td>
      <td class="url">${esc(trunc(g.url, 150))}</td></tr>`;
    return `<details ${visual.length ? 'open' : ''}>
      <summary><b>${esc(p.page)}</b> · 视觉缺口 <b class="${visual.length ? 'bad' : 'ok'}">${visual.length}</b> · 其它 ${others.length}</summary>
      ${p.gaps.length ? `<table class="gaps"><thead><tr><th>类别</th><th>类型</th><th>状态</th><th>来源</th><th>位置</th><th>URL</th></tr></thead><tbody>
        ${[...visual, ...others].slice(0, 60).map(gapRow).join('')}
      </tbody></table>${p.gaps.length > 60 ? `<div class="more">… 还有 ${p.gaps.length - 60} 条，见 asset-gaps.json</div>` : ''}` : '<div class="ok">✓ 全部引用已本地化</div>'}
    </details>`;
  }).join('');

  const kindTotals = {};
  for (const p of pages) for (const [k, v] of Object.entries(p.byKind ?? {})) kindTotals[k] = (kindTotals[k] ?? 0) + v;
  const visualKindTotals = {};
  for (const p of pages) for (const g of p.gaps.filter(x => x.category === 'visual')) visualKindTotals[g.kind] = (visualKindTotals[g.kind] ?? 0) + 1;
  const kindRows = Object.entries(visualKindTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="tag bad-tag">${esc(k)} ×${v}</span>`).join(' ') || '<span class="tag ok-tag">无视觉缺口</span>';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall 资产缺口 · ${esc(host)}</title>
<style>
body{margin:0;background:#f8fafc;color:#0f172a;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif;line-height:1.5}
.wrap{max-width:1220px;margin:0 auto;padding:34px 26px 80px}.brand{color:#0891b2;letter-spacing:.28em;font-size:12px;font-weight:700}
h1{margin:6px 0 4px;font-size:28px}.meta{color:#64748b;font-size:13px;margin-bottom:22px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0 26px}
.kpi{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px}.kpi b{font-size:24px;display:block}.kpi span{color:#64748b;font-size:12px}
h2{margin:26px 0 10px;font-size:18px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:12.5px}
th{background:#f1f5f9;color:#475569;font-size:12px}
td.num{font-variant-numeric:tabular-nums}.ok{color:#059669}.mid{color:#b45309}.bad{color:#dc2626}
td.name{font-family:ui-monospace,monospace;color:#0e7490}
details{background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin:10px 0;padding:10px 14px}
summary{cursor:pointer;font-size:13px}
table.gaps{margin-top:10px}
.url{font-family:ui-monospace,monospace;color:#64748b;word-break:break-all}
.more{margin-top:8px;color:#64748b;font-size:12px}
.tag{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11px;margin:2px;background:#f1f5f9;border:1px solid #e2e8f0}
.bad-tag{color:#b91c1c;border-color:#fecaca;background:#fef2f2}.ok-tag{color:#047857;border-color:#a7f3d0;background:#ecfdf5}
footer{margin-top:34px;color:#64748b;font-size:12px}
</style></head><body><div class="wrap">
<div class="brand">HEIMDALL · ASSET GAPS</div><h1>${esc(host)} 资产缺口扫描</h1>
<div class="meta">${esc(generatedAt)} · ${summary.pages} 页 · 引用 ${summary.refs} · 本地化率 <b>${rate}%</b> · 视觉缺口 <b>${summary.visual ?? 0}</b></div>
<div class="kpis">
  <div class="kpi"><b>${summary.refs}</b><span>引用总数（HTML/CSS/SVG/媒体）</span></div>
  <div class="kpi"><b class="ok">${summary.localized}</b><span>已本地化</span></div>
  <div class="kpi"><b class="${(summary.visual ?? 0) === 0 ? 'ok' : 'bad'}">${summary.visual ?? 0}</b><span>视觉缺口（真正影响还原）</span></div>
  <div class="kpi"><b class="bad">${summary.visualOrigin ?? 0}</b><span>视觉缺口·仍指向原站</span></div>
  <div class="kpi"><b class="mid">${summary.visualThird ?? 0}</b><span>视觉缺口·第三方</span></div>
  <div class="kpi"><b>${rate}%</b><span>引用本地化率</span></div>
</div>
<h2>视觉缺口类型</h2>
<div>${kindRows}</div>
<h2>按页面（按视觉缺口排序）</h2>
<table><thead><tr><th>页面</th><th>引用</th><th>本地化</th><th>本地化率</th><th>视觉缺口</th><th>其中原站</th><th>其中第三方</th><th>全部缺口</th></tr></thead><tbody>${rows}</tbody></table>
<h2>缺口明细（视觉缺口最多的 20 页）</h2>
${details}
<footer>判定：本地文件存在（asset-map / 目录同名）即视为本地化；视觉缺口只统计会直接影响画面的资产（图标/图片/媒体/CSS url）；元数据链接、追踪像素、被 cssom 取代的 stylesheet/preload 单独归类，不计入视觉缺口。· 仅供内部分析</footer>
</div></body></html>`;
}
