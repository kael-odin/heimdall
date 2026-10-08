/**
 * extract/tokens — 从 CSSOM 提取设计 token（纯函数）
 *
 * 输出：CSS 变量、颜色、字体/字号/字重/行高、间距、圆角、阴影、媒体断点，
 * 每项带出现次数，可直接生成可用的 tokens.css 与可视化预览。
 */
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const add = (map, value, n = 1) => {
  const v = norm(value);
  if (!v || v === 'none' || v === '0px 0px') { /* keep 0? */ }
  if (!v) return;
  map[v] = (map[v] ?? 0) + n;
};
const COLOR_RE = /(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|rgba?\([^)]*\)|hsla?\([^)]*\))/gi;

export function extractTokens(css) {
  const tokens = { variables: {}, colors: {}, fontFamilies: {}, fontSizes: {}, fontWeights: {}, lineHeights: {}, spacings: {}, radii: {}, shadows: {}, breakpoints: {} };
  const clean = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

  for (const block of clean.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) add(tokens.variables, m[1] + '::' + norm(m[2]));
  }
  for (const m of clean.matchAll(/([-a-z]+)\s*:\s*([^;{}]+);/gi)) {
    const prop = m[1].toLowerCase();
    const value = m[2];
    if (prop === 'color' || prop === 'background-color' || prop === 'border-color' || prop === 'fill' || prop === 'stroke' || prop === 'outline-color') {
      for (const c of value.matchAll(COLOR_RE)) add(tokens.colors, c[1]);
    } else if (prop === 'background' || prop === 'background-image' || prop === 'box-shadow') {
      for (const c of value.matchAll(COLOR_RE)) add(tokens.colors, c[1]);
      if (prop === 'box-shadow') add(tokens.shadows, value);
    } else if (prop === 'font-family') add(tokens.fontFamilies, value);
    else if (prop === 'font-size') add(tokens.fontSizes, value);
    else if (prop === 'font-weight') add(tokens.fontWeights, value);
    else if (prop === 'line-height') add(tokens.lineHeights, value);
    else if (/^(margin|padding)(-top|-right|-bottom|-left)?$/.test(prop)) {
      for (const part of value.split(/\s+/)) if (/^-?[\d.]+(px|rem|em|%)?$/.test(part.trim())) add(tokens.spacings, part.trim());
    } else if (prop === 'border-radius') add(tokens.radii, value);
  }
  for (const m of clean.matchAll(/@media([^{]+)\{/g)) add(tokens.breakpoints, m[1]);

  // 变量拆成 name/value 结构，并把 var(--x) 使用次数计入（真实使用频次）
  const variables = {};
  for (const [key, count] of Object.entries(tokens.variables)) {
    const [name, value] = key.split('::');
    const uses = (clean.match(new RegExp('var\\(\\s*' + name.replace(/[-]/g, '\\-') + '\\s*[,)]', 'g')) ?? []).length;
    variables[name] = { value, count: count + uses };
  }
  return { ...tokens, variables };
}

export function topEntries(map, n = 20, minCount = 1) {
  return Object.entries(map ?? {})
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'token';

export function buildTokensCss(tokens, { host = 'site' } = {}) {
  const colors = topEntries(tokens.colors, 20, 2);
  const fonts = topEntries(tokens.fontFamilies, 3, 1);
  const sizes = topEntries(tokens.fontSizes, 10, 2);
  const weights = topEntries(tokens.fontWeights, 6, 2);
  const spaces = topEntries(tokens.spacings, 14, 2);
  const radii = topEntries(tokens.radii, 6, 2);
  const shadows = topEntries(tokens.shadows, 4, 2);
  const vars = Object.entries(tokens.variables ?? {}).sort((a, b) => b[1].count - a[1].count).slice(0, 60);
  const lines = [
    `/* Heimdall design tokens · ${host} · generated ${new Date().toISOString()} */`,
    ':root {',
  ];
  if (colors.length) { lines.push('  /* palette（按使用频次） */'); colors.forEach((c, i) => lines.push(`  --hmd-color-${i + 1}: ${c.value}; /* x${c.count} */`)); }
  if (fonts.length) { lines.push('  /* typography */'); fonts.forEach((f, i) => lines.push(`  --hmd-font-${i + 1}: ${f.value}; /* x${f.count} */`)); }
  sizes.forEach((s, i) => lines.push(`  --hmd-size-${i + 1}: ${s.value}; /* x${s.count} */`));
  weights.forEach((w, i) => lines.push(`  --hmd-weight-${i + 1}: ${w.value}; /* x${w.count} */`));
  if (spaces.length) { lines.push('  /* spacing */'); spaces.forEach((s, i) => lines.push(`  --hmd-space-${i + 1}: ${s.value}; /* x${s.count} */`)); }
  if (radii.length) { lines.push('  /* radii */'); radii.forEach((r, i) => lines.push(`  --hmd-radius-${i + 1}: ${r.value}; /* x${r.count} */`)); }
  if (shadows.length) { lines.push('  /* shadows */'); shadows.forEach((s, i) => lines.push(`  --hmd-shadow-${i + 1}: ${s.value}; /* x${s.count} */`)); }
  if (vars.length) { lines.push('  /* source variables（原站 :root 变量，保留原名加前缀） */'); vars.forEach(([name, v]) => lines.push(`  --src-${slug(name)}: ${v.value}; /* x${v.count} */`)); }
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function renderTokensHtml(host, tokens) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const luminance = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return 1;
    const v = parseInt(m[1], 16); const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  };
  const colors = topEntries(tokens.colors, 24, 2);
  const swatches = colors.map(c => `<div class="sw"><div class="chip" style="background:${esc(c.value)};color:${luminance(c.value) > 0.6 ? '#0f172a' : '#fff'}">${esc(c.value)}</div><span>x${c.count}</span></div>`).join('');
  const fonts = topEntries(tokens.fontFamilies, 4, 1).map(f => `<div class="row"><code>${esc(f.value)}</code><span>x${f.count}</span></div>`).join('');
  const sizes = topEntries(tokens.fontSizes, 12, 2).map(s => `<div class="row"><span style="font-size:${esc(s.value)}">Aa 设计 Token</span><code>${esc(s.value)} · x${s.count}</code></div>`).join('');
  const spaces = topEntries(tokens.spacings, 14, 3).map(s => `<div class="row"><i style="width:${esc(s.value)}"></i><code>${esc(s.value)} · x${s.count}</code></div>`).join('');
  const radii = topEntries(tokens.radii, 8, 2).map(r => `<div class="row"><i class="rad" style="border-radius:${esc(r.value)}"></i><code>${esc(r.value)} · x${r.count}</code></div>`).join('');
  const shadows = topEntries(tokens.shadows, 6, 2).map(s => `<div class="row"><i class="shd" style="box-shadow:${esc(s.value)}"></i><code>${esc(String(s.value).slice(0, 80))} · x${s.count}</code></div>`).join('');
  const breaks = topEntries(tokens.breakpoints, 12, 1).map(b => `<div class="row"><code>@media${esc(b.value)}</code><span>x${b.count}</span></div>`).join('');
  const vars = Object.entries(tokens.variables ?? {}).sort((a, b) => b[1].count - a[1].count).slice(0, 60).map(([k, v]) => `<div class="row"><code>${esc(k)}</code><span>${esc(v.value)} · x${v.count}</span></div>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall Design Tokens · ${esc(host)}</title>
<style>
body{margin:0;background:#f8fafc;color:#0f172a;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif;line-height:1.5}
.wrap{max-width:1100px;margin:0 auto;padding:36px 28px 80px}.brand{color:#0891b2;letter-spacing:.28em;font-size:12px;font-weight:700}h1{margin:6px 0 4px;font-size:28px}.meta{color:#64748b;font-size:13px;margin-bottom:26px}
h2{margin:30px 0 10px;font-size:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.sw{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff}.chip{height:54px;display:grid;place-items:center;font-size:11px;font-family:monospace}.sw>span{display:block;padding:4px 8px;color:#64748b;font-size:11px}
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px}.row{display:flex;align-items:center;gap:14px;padding:6px 0;border-bottom:1px dashed #eef2f7;font-size:12.5px}.row:last-child{border-bottom:0}.row code{font-family:ui-monospace,monospace;color:#0f172a}.row span{color:#64748b;font-size:11.5px;margin-left:auto}
.row i{display:inline-block;height:10px;background:#0891b2;border-radius:3px;min-width:2px}.rad{width:44px;height:32px;background:#e0f2fe;border:1px solid #7dd3fc;border-radius:8px}.shd{width:44px;height:32px;background:#fff;border:1px solid #e2e8f0;border-radius:6px}
footer{margin-top:36px;color:#64748b;font-size:12px}
</style></head><body><div class="wrap">
<div class="brand">HEIMDALL · DESIGN TOKENS</div><h1>${esc(host)} 设计 Token</h1>
<div class="meta">颜色去重 ${Object.keys(tokens.colors).length} · 字体 ${Object.keys(tokens.fontFamilies).length} · 间距值 ${Object.keys(tokens.spacings).length} · 原生变量 ${Object.keys(tokens.variables).length}</div>
<h2>色板</h2><div class="grid">${swatches || '<div class="panel">未提取到颜色</div>'}</div>
<h2>字体</h2><div class="panel">${fonts || '—'}</div>
<h2>字号</h2><div class="panel">${sizes || '—'}</div>
<h2>间距</h2><div class="panel">${spaces || '—'}</div>
<h2>圆角</h2><div class="panel">${radii || '—'}</div>
<h2>阴影</h2><div class="panel">${shadows || '—'}</div>
<h2>媒体断点</h2><div class="panel">${breaks || '—'}</div>
<h2>原站 CSS 变量（Top 60）</h2><div class="panel">${vars || '—'}</div>
<footer>由 Heimdall 设计 Token 提取器生成 · 配套 tokens.css 可直接引入 · 仅供内部分析</footer>
</div></body></html>`;
}
