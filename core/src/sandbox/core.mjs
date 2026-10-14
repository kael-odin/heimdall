/**
 * sandbox/core — 沙盒改造的纯函数（路径 / 注入 / 编辑器页）
 */
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';
import { esc } from '../html.mjs';
import { assertPageName } from '../page-name.mjs';

export function sandboxPaths(host, page) {
  assertPageName(page);
  const dir = join(WORKSPACE, host, 'sandbox', page);
  return {
    dir,
    html: join(dir, 'sandbox.html'),
    css: join(dir, 'sandbox.css'),
    meta: join(dir, 'meta.json'),
    score: join(dir, 'score.json'),
    diff: join(dir, 'diff.png'),
  };
}

/** 把沙盒 CSS 注入克隆页 HTML：统一 base 指向 /clone/，并在 </head> 前插入 style */
export function injectSandboxEdits(html, css = '') {
  let out = String(html ?? '');
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/<head([^>]*)>/i, '<head$1><base href="/clone/">');
  if (!/<head/i.test(out)) out = '<base href="/clone/">' + out;
  const style = `<style id="hmd-sandbox">\n${String(css ?? '')}\n</style>`;
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, style + '</head>');
  else out = style + out;
  return out;
}

export function renderEditorPage({ host, page, port = 0 }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall 沙盒 · ${esc(host)}/${esc(page)}</title>
<style>
:root{--bg:#0b0b10;--panel:#14141a;--line:rgba(34,211,238,.25);--cyan:#22d3ee;--dim:#94a3b8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:#e2e8f0;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{color:var(--cyan);letter-spacing:.22em;font-size:11px;font-weight:700}
.title{font-size:13px;color:var(--dim)}.spacer{flex:1}
button{background:rgba(34,211,238,.08);border:1px solid var(--line);color:var(--cyan);border-radius:5px;padding:6px 12px;font-size:12px;cursor:pointer}
button:hover{background:rgba(34,211,238,.16)}
button.primary{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.5);color:#34d399}
.main{flex:1;display:grid;grid-template-columns:minmax(320px,42%) 1fr;gap:0;overflow:hidden}
.editors{display:flex;flex-direction:column;border-right:1px solid var(--line);overflow:hidden}
.editor{flex:1;display:flex;flex-direction:column;min-height:0}
.editor label{font-size:10.5px;letter-spacing:.16em;color:var(--dim);padding:8px 12px 4px;font-family:ui-monospace,monospace}
.editor textarea{flex:1;background:#0e0e13;color:#dbeafe;border:0;border-top:1px solid var(--line);padding:10px 12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;resize:none;outline:none}
.preview{display:flex;flex-direction:column;min-width:0}
.preview-head{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--dim)}
.preview iframe{flex:1;width:100%;border:0;background:#fff}
.diff{margin-left:auto;display:flex;align-items:center;gap:8px}
.score{font-family:ui-monospace,monospace;color:#34d399}
a{color:var(--cyan)}
</style></head><body>
<header>
  <span class="brand">HEIMDALL · SANDBOX</span>
  <span class="title">${esc(host)} / ${esc(page)}</span>
  <span class="spacer"></span>
  <span class="title" id="status">就绪</span>
  <button id="reload">刷新预览</button>
  <button id="reset">还原 HTML</button>
  <button class="primary" id="save">保存 (Ctrl+S)</button>
</header>
<div class="main">
  <div class="editors">
    <div class="editor"><label>HTML（沙盒副本）</label><textarea id="html" spellcheck="false"></textarea></div>
    <div class="editor" style="max-height:38%"><label>CSS 覆盖（sandbox.css）</label><textarea id="css" spellcheck="false"></textarea></div>
  </div>
  <div class="preview">
    <div class="preview-head">
      <span>预览（/preview）</span>
      <span class="diff"><span class="score" id="score">—</span><button id="diff">与原始对比</button><a id="diffLink" href="/diff.png" target="_blank" rel="noopener" style="display:none">打开差异图</a></span>
    </div>
    <iframe id="preview" src="/preview"></iframe>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let originalHtml = '';
async function load() {
  const r = await fetch('/api/state').then(r => r.json());
  originalHtml = r.originalHtml || '';
  $('html').value = r.html || originalHtml;
  $('css').value = r.css || '';
  $('status').textContent = '已加载（${esc(host)}/${esc(page)}）';
}
async function save() {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: $('html').value, css: $('css').value }) });
  const j = await r.json();
  $('status').textContent = j.ok ? '已保存 ' + new Date().toLocaleTimeString() : '保存失败';
  $('preview').src = '/preview?t=' + Date.now();
}
async function diff() {
  $('status').textContent = '对比中…';
  const r = await fetch('/api/diff', { method: 'POST' });
  const j = await r.json();
  if (j.error) { $('status').textContent = '对比失败：' + j.error; return; }
  $('score').textContent = '相似度 ' + (j.score * 100).toFixed(1) + '%';
  $('status').textContent = '差异像素 ' + j.mismatched.toLocaleString() + ' · 高度差 ' + j.heightDelta + 'px';
  $('diffLink').style.display = 'inline';
  $('diffLink').href = '/diff.png?t=' + Date.now();
}
$('reload').onclick = () => { $('preview').src = '/preview?t=' + Date.now(); };
$('reset').onclick = () => { $('html').value = originalHtml; };
$('save').onclick = save;
$('diff').onclick = diff;
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
load();
</script>
</body></html>`;
}
