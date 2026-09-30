/**
 * index-page — 生成全站克隆索引页（静态，双击即看）
 *
 * 扫描 workspace/<host>/pages/ 下各页目录，汇总 score.json + intel/semantic.json + 缩略截图，
 * 产出 workspace/<host>/index.html：每页克隆卡片（还原度/评级/语义/打开镜像）。
 * engine-server 静态服务下即 /static/<host>/index.html
 *
 * 用法: node src/crawler/index-page.mjs <host>
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const host = process.argv[2] ?? 'apify.com';
const hostDir = process.argv[3] ?? host;
const BASE = join('workspace', hostDir);
const PAGES = join(BASE, 'pages');
if (!existsSync(PAGES)) { console.error('no pages dir:', PAGES); process.exit(1); }

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const pages = readdirSync(PAGES)
  .filter(n => existsSync(join(PAGES, n, 'clone', 'index.html')))
  .map(n => ({
    name: n,
    score: readJson(join(PAGES, n, 'score.json')),
    intel: readJson(join(PAGES, n, 'intel', 'intel.json')),
    semantic: readJson(join(PAGES, n, 'intel', 'semantic.json')),
  }))
  .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const gradeColor = (g) => g === 'A' ? '#34D399' : g === 'B' ? '#F59E0B' : '#EF4444';

const cards = pages.map(p => {
  const s = p.score ?? {};
  const sem = p.semantic ?? {};
  const plans = (sem.plans ?? []).length;
  const products = (sem.products ?? []).length;
  return `<a class="card" href="pages/${esc(p.name)}/clone/index.html" target="_blank" rel="noopener">
  <div class="thumb"><img src="pages/${esc(p.name)}/shot-clone.png" alt="${esc(p.name)}" loading="lazy" onerror="this.style.display='none'"/></div>
  <div class="meta">
    <div class="row1"><span class="name">${esc(p.name)}</span>
      <span class="grade" style="color:${gradeColor(s.grade)}">${esc(s.grade ?? '-')}·${s.total ?? '-'}%</span></div>
    <div class="path">${esc(p.semantic?.pageType ?? '')}</div>
    <div class="dims">像素 ${s.pixel ? (s.pixel * 100).toFixed(1) : '-'}% · 结构 ${s.dom ? (s.dom.dom * 100).toFixed(0) : '-'}% · 数据 ${s.data ? (s.data.data * 100).toFixed(0) : '-'}%</div>
    <div class="tags">
      ${products ? `<i>产品 ${products}</i>` : ''}${plans ? `<i>套餐 ${plans}</i>` : ''}
      ${p.intel?.prices?.length ? `<i>价格 ${p.intel.prices.length}</i>` : ''}${p.intel?.cta?.length ? `<i>CTA ${p.intel.cta.length}</i>` : ''}
    </div>
    <div class="actions"><span class="cmp" data-p="${esc(p.name)}">⇔ 同步对比</span></div>
  </div>
</a>`;
}).join('\n');

const avg = pages.length ? (pages.reduce((s, p) => s + (p.score?.total ?? 0), 0) / pages.length).toFixed(1) : '-';
const aCount = pages.filter(p => p.score?.grade === 'A').length;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Heimdall · ${esc(host)} 克隆档案</title>
<style>
:root { --abyss:#0B0B10; --cyan:#22D3EE; --line:rgba(34,211,238,.22); --dim:#94A3B8; --faint:#64748B; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--abyss); color:#F8FAFC; font-family:'Noto Sans SC','Microsoft YaHei UI',sans-serif; padding:36px 40px; }
.head { display:flex; align-items:baseline; gap:18px; margin-bottom:6px; }
h1 { font-family:Orbitron,monospace; font-size:22px; letter-spacing:.28em; text-shadow:0 0 22px rgba(34,211,238,.5); }
h1 span { font-size:11px; letter-spacing:.3em; color:var(--faint); }
.sub { color:var(--dim); font-size:13px; margin-bottom:26px; font-family:'Share Tech Mono',monospace; }
.sub b { color:var(--cyan); }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:16px; }
.card { display:block; text-decoration:none; color:inherit; background:linear-gradient(180deg,rgba(30,30,35,.9),rgba(20,20,26,.94)); border:1px solid var(--line); border-radius:5px; overflow:hidden; transition:all .18s ease; }
.card:hover { border-color:rgba(34,211,238,.55); box-shadow:0 0 24px rgba(34,211,238,.14); transform:translateY(-2px); }
.thumb { aspect-ratio:16/10; overflow:hidden; background:#000; border-bottom:1px solid var(--line); }
.thumb img { width:100%; display:block; }
.meta { padding:11px 13px 13px; }
.row1 { display:flex; justify-content:space-between; align-items:baseline; }
.name { font-family:'Share Tech Mono',monospace; font-size:14px; color:var(--cyan); }
.grade { font-family:Orbitron,monospace; font-size:14px; font-weight:700; }
.path { font-size:11px; color:var(--faint); letter-spacing:.15em; margin:4px 0 6px; }
.dims { font-family:'Share Tech Mono',monospace; font-size:11px; color:var(--dim); }
.tags { margin-top:7px; display:flex; gap:6px; flex-wrap:wrap; }
.tags i { font-style:normal; font-size:10px; padding:2px 8px; border:1px dashed rgba(167,139,250,.45); border-radius:3px; color:#A78BFA; }
.actions { margin-top:8px; }
.cmp { font-size:11px; color:var(--cyan); cursor:pointer; letter-spacing:.08em; border-bottom:1px dashed var(--line); }
.cmp:hover { color:#fff; border-color:var(--cyan); }
.foot { margin-top:28px; color:var(--faint); font-size:11px; font-family:'Share Tech Mono',monospace; letter-spacing:.1em; }
.foot a { color:var(--cyan); text-decoration:none; }
</style></head><body>
<div class="head"><h1>HEIMDALL <span>· ${esc(host).toUpperCase()} 克隆档案</span></h1></div>
<div class="sub">镜像 <b>${pages.length}</b> 页 · 平均还原度 <b>${avg}%</b> · A 级 <b>${aCount}</b> 页 · 情报包见 <a href="intel/${esc(host)}-intel.xlsx">intel/${esc(host)}-intel.xlsx</a></div>
<div class="grid">${cards}</div>
<div class="foot">HEIMDALL site replication engine · <a href="../">返回星图控制台</a></div>
<script>
document.addEventListener('click', (e) => {
  const c = e.target.closest('.cmp');
  if (!c) return;
  e.preventDefault(); e.stopPropagation();
  location.href = 'compare.html?p=' + encodeURIComponent(c.dataset.p);
});
</script>
</body></html>`;

writeFileSync(join(BASE, 'index.html'), html);
console.log(`index -> ${join(BASE, 'index.html')} (${pages.length} pages, avg ${avg}%)`);

// ---------- compare.html：同步滚动对比（左=原站全页长图，右=活体镜像 iframe） ----------
const pagesJson = JSON.stringify(pages.map(p => ({ name: p.name, path: p.semantic?.pageType ?? '' })));
const compare = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Heimdall · 同步对比</title>
<style>
:root { --cyan:#22D3EE; --line:rgba(34,211,238,.25); --dim:#94A3B8; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#0B0B10; color:#F8FAFC; font-family:'Noto Sans SC',sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
header { display:flex; align-items:center; gap:14px; padding:10px 18px; border-bottom:1px solid var(--line); flex-shrink:0; }
header h1 { font-family:Orbitron,monospace; font-size:14px; letter-spacing:.24em; }
header select { background:#1E1E23; color:#F8FAFC; border:1px solid var(--line); padding:6px 10px; border-radius:4px; font-family:monospace; }
header .back { color:var(--cyan); text-decoration:none; font-size:12px; font-family:monospace; letter-spacing:.1em; }
header .hint { margin-left:auto; font-size:11px; color:var(--dim); }
.panes { flex:1; display:grid; grid-template-columns:1fr 1fr; min-height:0; }
.pane { position:relative; overflow:auto; border-right:1px solid var(--line); }
.pane:last-child { border-right:0; }
.pane .tag { position:sticky; top:0; z-index:3; display:block; padding:6px 14px; font-family:monospace; font-size:11px; letter-spacing:.2em; color:var(--cyan); background:rgba(11,11,16,.85); border-bottom:1px solid var(--line); }
.pane img { width:100%; display:block; }
.pane iframe { width:100%; height:100%; border:0; background:#fff; display:block; }
.pane .miss { padding:40px 24px; color:var(--dim); font-size:13px; line-height:1.8; }
</style></head><body>
<header>
  <h1>SYNC COMPARE</h1>
  <select id="sel"></select>
  <a class="back" href="index.html">← 档案</a>
  <span class="hint">任意一侧滚动，另一侧按比例同步 · 原站侧为捕获时全页快照</span>
</header>
<div class="panes">
  <div class="pane" id="left"><span class="tag">SOURCE · 原站</span><img id="shot" alt="source full page"/></div>
  <div class="pane" id="right"><span class="tag">MIRROR · 镜像</span><iframe id="frame"></iframe></div>
</div>
<script>
const PAGES = __PAGES__;
const params = new URLSearchParams(location.search);
const cur = params.get('p') || PAGES[0]?.name || '';
const sel = document.getElementById('sel');
for (const p of PAGES) {
  const o = document.createElement('option');
  o.value = p.name; o.textContent = p.name + (p.path ? ' · ' + p.path : '');
  if (p.name === cur) o.selected = true;
  sel.appendChild(o);
}
const shot = document.getElementById('shot');
const left = document.getElementById('left');
const frame = document.getElementById('frame');
function load(name) {
  shot.src = 'pages/' + name + '/shot-src-full.png';
  shot.onerror = () => { shot.replaceWith(Object.assign(document.createElement('div'), { className: 'miss', textContent: '该页未捕获全页长图（旧版产物）。重新锻造此页即可获得同步对比的原站侧。' })); };
  frame.src = 'pages/' + name + '/clone/index.html';
}
sel.addEventListener('change', () => load(sel.value));
load(cur);
let lastSync = 0;   // 程序化滚动时间戳：回声事件在静默窗内被忽略（布尔 lock 挡不住异步回声，曾致滚动被拉回 0）
const QUIET = 180;
function ratioOf(el) { return el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight); }
function applyRatio(el, r) { el.scrollTop = r * Math.max(0, el.scrollHeight - el.clientHeight); }
left.addEventListener('scroll', () => {
  if (performance.now() - lastSync < QUIET) return;
  lastSync = performance.now();
  const doc = frame.contentDocument?.scrollingElement;
  if (doc) applyRatio(doc, ratioOf(left));
});
frame.addEventListener('load', () => {
  frame.contentDocument.addEventListener('scroll', () => {
    if (performance.now() - lastSync < QUIET) return;
    lastSync = performance.now();
    applyRatio(left, ratioOf(frame.contentDocument.scrollingElement));
  });
});
</script>
</body></html>`.replace('__PAGES__', pagesJson);
writeFileSync(join(BASE, 'compare.html'), compare);
console.log(`compare -> ${join(BASE, 'compare.html')}`);
