/**
 * agent/brief/outline — 结构大纲（E6-02，PRD 01 §1.4 的探针算法转正）
 *
 * 用 parse5 解析 dom.html，只保留：标签、id、前两个类名、role、少量属性（截断）、直接文本前 60 字符；
 * 跳过 script / style / noscript / template / link / meta / head；svg 记为 [svg]；
 * 连续签名相同的兄弟折叠成「… ×N」；深度上限 14、节点上限 3000。
 * 本机 7 页实测压缩 7–63 倍（apify about 0.55 MB → 13.7 KB）。
 *
 * 不可见文本（hidden 属性、aria-hidden、内联 display:none / visibility:hidden）与注释不进正文，只计数
 * ——提示注入最常藏在这里（PRD 08 §3.3）。返回的文本还要经调用方的围栏包起来。
 */
import { parse } from 'parse5';
import { sanitize } from '../fence.mjs';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'head']);
const ATTRS = ['href', 'src', 'alt', 'aria-label', 'type', 'name', 'placeholder'];
const attr = (n, k) => n.attrs?.find(a => a.name === k)?.value;

function hidden(n) {
  if (attr(n, 'hidden') !== undefined || attr(n, 'aria-hidden') === 'true') return true;
  const style = (attr(n, 'style') ?? '').replace(/\s+/g, '').toLowerCase();
  return /display:none|visibility:hidden/.test(style);
}

function sig(n) {
  const cls = (attr(n, 'class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(c => c.slice(0, 24)).join('.');
  const id = attr(n, 'id');
  const role = attr(n, 'role');
  return n.tagName + (id ? '#' + id.slice(0, 24) : '') + (cls ? '.' + cls : '') + (role ? `[role=${role}]` : '');
}

function findBody(n) {
  if (n.tagName === 'body') return n;
  for (const c of n.childNodes ?? []) { const r = findBody(c); if (r) return r; }
  return null;
}

/**
 * @returns {{ text: string, nodes: number, hiddenSkipped: number, comments: number, truncatedNodes: boolean, bytes: number }}
 */
export function buildOutline(html, { maxDepth = 14, maxNodes = 3000 } = {}) {
  const doc = parse(String(html ?? ''));
  const body = findBody(doc);
  const out = [];
  const stats = { nodes: 0, hiddenSkipped: 0, comments: 0, truncatedNodes: false };
  const counts = { control: 0, zeroWidth: 0, bidi: 0, tags: 0, truncated: 0 };
  const clean = (s, max) => sanitize(s, max, counts).text;
  const directText = (n) => {
    let t = '';
    for (const c of n.childNodes ?? []) {
      if (c.nodeName === '#text') t += c.value;
      else if (c.nodeName === '#comment') stats.comments++;
    }
    return clean(t.replace(/\s+/g, ' ').trim(), 60);
  };
  const render = (n, depth) => {
    if (!n.tagName || SKIP.has(n.tagName)) return;
    if (stats.nodes >= maxNodes) { stats.truncatedNodes = true; return; }
    if (hidden(n)) { stats.hiddenSkipped++; return; }
    const pad = '  '.repeat(depth);
    if (n.tagName === 'svg') { out.push(pad + '[svg]'); stats.nodes++; return; }
    const kids = (n.childNodes ?? []).filter(c => c.tagName && !SKIP.has(c.tagName));
    const t = directText(n);
    const extra = [];
    for (const k of ATTRS) { const v = attr(n, k); if (v) extra.push(k + '=' + clean(String(v), 40)); }
    out.push(pad + clean(sig(n), 120) + (extra.length ? ' ' + extra.join(' ') : '') + (t ? ' "' + t + '"' : ''));
    stats.nodes++;
    if (depth >= maxDepth) { if (kids.length) out.push(pad + '  …'); return; }
    let i = 0;
    while (i < kids.length) {
      let j = i + 1;
      const s = sig(kids[i]) + '|' + (kids[i].childNodes?.length ?? 0);
      while (j < kids.length && (sig(kids[j]) + '|' + (kids[j].childNodes?.length ?? 0)) === s) j++;
      render(kids[i], depth + 1);
      if (j - i > 1) out.push('  '.repeat(depth + 1) + `… ×${j - i - 1} more like the above`);
      i = j;
    }
  };
  if (body) render(body, 0);
  if (stats.truncatedNodes) out.push(`… 已到节点上限 ${maxNodes}，其余省略`);
  const text = out.join('\n');
  return { text, ...stats, bytes: Buffer.byteLength(text), redactions: counts };
}
