/**
 * extract/components — 从渲染后 DOM + CSSOM 抽取可复用组件片段（纯函数）
 *
 * 组件类型：header/nav、hero、pricing、faq、footer、cta。
 * 每个组件输出：outerHTML 片段 + 命中该元素的 CSS 规则（含媒体查询与 :root 变量）。
 */
import { parse, serializeOuter } from 'parse5';
import { esc } from '../html.mjs';

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value ?? '';
const classList = (node) => attr(node, 'class').split(/\s+/).filter(Boolean);
const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function textOf(node, limit = 600) {
  let out = '';
  const rec = (n) => {
    if (out.length >= limit) return;
    if (n.nodeName === '#text') { out += n.value; return; }
    if (['script', 'style', 'noscript'].includes(n.tagName)) return;
    for (const c of n.childNodes ?? []) rec(c);
  };
  rec(node);
  return normText(out).slice(0, limit);
}

function hasTag(node, tag) {
  let yes = false;
  const rec = (n) => { if (yes) return; if (n.tagName === tag) { yes = true; return; } for (const c of n.childNodes ?? []) rec(c); };
  rec(node);
  return yes;
}

const CLASS_RULES = [
  { name: 'header', re: /(^|[-_ ])(nav|navbar|nav-bar|menu|header|navigation|topbar)([-_ ]|$)/i, score: 7 },
  { name: 'hero', re: /hero|banner|masthead|jumbotron/i, score: 8 },
  { name: 'pricing', re: /pricing|plans?|tiers?|price|billing/i, score: 7 },
  { name: 'faq', re: /faq|accordion|question/i, score: 7 },
  { name: 'footer', re: /footer|bottom-bar/i, score: 7 },
  { name: 'cta', re: /(^|[-_ ])(btn|button|cta)([-_ ]|$)/i, score: 5 },
];

export function componentCandidates(html, { max = 12, minText = 20 } = {}) {
  const doc = parse(html);
  const found = [];
  const walk = (node, ancestors) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName) {
        const tag = child.tagName.toLowerCase();
        const classes = classList(child);
        const id = attr(child, 'id');
        const haystack = (classes.join(' ') + ' ' + id).toLowerCase();
        const text = textOf(child);
        const defs = [];
        for (const rule of CLASS_RULES) if (rule.re.test(haystack) || (rule.name === 'header' && tag === 'nav') || (rule.name === 'header' && tag === 'header') || (rule.name === 'footer' && tag === 'footer')) defs.push(rule);
        if (tag === 'details' && !defs.some(d => d.name === 'faq')) defs.push({ name: 'faq', score: 6 });
        if ((tag === 'section' || tag === 'div') && hasTag(child, 'h1') && text.length > 60 && defs.length === 0) defs.push({ name: 'hero', score: 5 });
        const MIN_TEXT = { header: Math.min(3, minText), footer: Math.min(3, minText), cta: 1, faq: Math.min(8, minText), hero: minText, pricing: minText };
        for (const d of defs) {
          if (text.length < (MIN_TEXT[d.name] ?? minText)) continue;
          if (d.name === 'cta' && !['a', 'button'].includes(tag) && text.length < 3) continue;
          const outer = serializeOuter(child);
          found.push({ name: d.name, score: d.score + Math.min(1.5, text.length / 300), tag, id, classes, text: text.slice(0, 180), html: outer, bytes: Buffer.byteLength(outer), depth: ancestors.length });
        }
      }
      walk(child, child.tagName ? [...ancestors, child.tagName.toLowerCase()] : ancestors);
    }
  };
  walk(doc, []);

  // 同名嵌套去重：DOM 顺序保证外层先出现
  const kept = [];
  for (const c of found) {
    if (kept.some(k => k.name === c.name && (k.html.includes(c.html) || c.html.includes(k.html)))) continue;
    kept.push(c);
  }
  // 按类型分组：每组保留 top（pricing/cta 允许多个）
  const groups = {};
  for (const c of kept) (groups[c.name] ??= []).push(c);
  const out = [];
  for (const [name, list] of Object.entries(groups)) {
    list.sort((a, b) => b.score - a.score || a.bytes - b.bytes);
    const seenSig = new Set();
    const unique = list.filter(x => { const sig = x.classes.join('.') + '|' + x.text; if (seenSig.has(sig)) return false; seenSig.add(sig); return true; });
    const limit = name === 'cta' ? 4 : name === 'pricing' ? 3 : 1;
    const picked = unique.slice(0, limit);
    picked.forEach((c, i) => out.push({ ...c, key: picked.length > 1 ? name + '-' + (i + 1) : name }));
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max).map(c => ({ ...c, html: c.html.length > 200_000 ? c.html.slice(0, 200_000) : c.html }));
}

function matchBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return css.length - 1;
}

/** 极简 CSS 规则解析（支持 @media/@supports 嵌套一层） */
export function parseCssRules(css) {
  const src = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const parseBlock = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      const close = matchBrace(text, open);
      if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
        parseBlock(text.slice(open + 1, close), prelude);
      } else if (!prelude.startsWith('@')) {
        const body = text.slice(open + 1, close).trim();
        if (body) out.push({ selector: prelude, body, media });
      }
      i = close + 1;
    }
  };
  parseBlock(src, null);
  return out;
}

export function matchingCssRules(css, { classes = [], id = '', tag = '' }, { maxRules = 300, maxBytes = 180_000 } = {}) {
  const rules = parseCssRules(css);
  const classNeedles = classes.map(c => '.' + c);
  const tagNeedle = tag ? new RegExp('(^|[\\s>+~,])' + tag + '($|[\\s>+~.#:\\[])') : null;
  const kept = [];
  for (const rule of rules) {
    if (/^:root\b/.test(rule.selector)) { kept.push(rule); continue; }
    for (const part of rule.selector.split(',')) {
      const p = part.trim();
      if (!p) continue;
      const hit = classNeedles.some(n => p.includes(n)) || (id && p.includes('#' + id)) || (tagNeedle && tagNeedle.test(p));
      if (hit) { kept.push({ ...rule, selector: p }); break; }
    }
  }
  const seen = new Set(); const texts = []; let bytes = 0;
  for (const r of kept) {
    const key = (r.media ?? '') + '|' + r.selector;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = (r.media ? r.media + '{' + r.selector + '{' + r.body + '}}' : r.selector + '{' + r.body + '}');
    if (bytes + text.length > maxBytes || texts.length >= maxRules) break;
    bytes += text.length; texts.push(text);
  }
  return { css: texts.join('\n'), rules: texts.length, bytes };
}

export function renderComponentPreview(component, cssText, { host = '' } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(component.key)} · ${esc(host)} component</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#0f172a;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif}
body{padding:18px}
.hmd-component-meta{position:fixed;right:10px;bottom:10px;background:rgba(8,145,178,.9);color:#fff;font:11px/1.5 ui-monospace,monospace;padding:4px 8px;border-radius:4px;z-index:99999}
${cssText}
</style></head><body>
${component.html}
<div class="hmd-component-meta">Heimdall · ${esc(component.key)} · ${component.tag} · ${esc(component.classes.slice(0, 3).join(' '))}</div>
</body></html>`;
}

export function renderGallery(host, components) {
  const cards = components.map(c => `
    <div class="card">
      <div class="card-head"><b>${esc(c.key)}</b><span>&lt;${esc(c.tag)}&gt; · ${c.matchedRules} 条规则 · ${(c.bytes / 1024).toFixed(0)}KB</span></div>
      <iframe src="${esc(c.file)}" loading="lazy" sandbox="allow-same-origin"></iframe>
      <div class="card-foot"><code>${esc(c.classes.slice(0, 4).join(' ') || c.id || '—')}</code><a href="${esc(c.file)}" target="_blank" rel="noopener">打开</a></div>
    </div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall Components · ${esc(host)}</title>
<style>
body{margin:0;background:#f8fafc;color:#0f172a;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:34px 26px 80px}.brand{color:#0891b2;letter-spacing:.28em;font-size:12px;font-weight:700}
h1{margin:6px 0 4px;font-size:28px}.meta{color:#64748b;font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
.card-head{display:flex;justify-content:space-between;padding:10px 12px;font-size:12px;border-bottom:1px solid #eef2f7}.card-head span{color:#64748b}
iframe{width:100%;height:300px;border:0;background:#fff}
.card-foot{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;font-size:11px;color:#64748b;border-top:1px solid #eef2f7}
.card-foot a{color:#0891b2;text-decoration:none}
</style></head><body><div class="wrap">
<div class="brand">HEIMDALL · COMPONENTS</div><h1>${esc(host)} 组件抽取</h1>
<div class="meta">${components.length} 个组件 · 预览为独立 HTML（含命中 CSS 与 :root 变量）· 可直接作为改造素材 · 仅供内部分析</div>
<div class="grid">${cards}</div>
</div></body></html>`;
}
