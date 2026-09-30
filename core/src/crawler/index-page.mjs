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
.foot { margin-top:28px; color:var(--faint); font-size:11px; font-family:'Share Tech Mono',monospace; letter-spacing:.1em; }
.foot a { color:var(--cyan); text-decoration:none; }
</style></head><body>
<div class="head"><h1>HEIMDALL <span>· ${esc(host).toUpperCase()} 克隆档案</span></h1></div>
<div class="sub">镜像 <b>${pages.length}</b> 页 · 平均还原度 <b>${avg}%</b> · A 级 <b>${aCount}</b> 页 · 情报包见 <a href="intel/${esc(host)}-intel.xlsx">intel/${esc(host)}-intel.xlsx</a></div>
<div class="grid">${cards}</div>
<div class="foot">HEIMDALL site replication engine · <a href="../">返回星图控制台</a></div>
</body></html>`;

writeFileSync(join(BASE, 'index.html'), html);
console.log(`index -> ${join(BASE, 'index.html')} (${pages.length} pages, avg ${avg}%)`);
