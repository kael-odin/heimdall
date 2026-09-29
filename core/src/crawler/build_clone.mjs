/**
 * build_clone — 资产本地化重写，产出离线可渲染的镜像页
 *
 * 样式源 = cssom.css（CSSOM 最终状态），HTML = dom.html 骨架本地化
 * 用法: node src/crawler/build_clone.mjs <pageDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { pickAdapter } from '../adapters/index.mjs';

const PAGE = process.argv[2] ?? join('workspace', 'apify.com', 'pages', 'home');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CLONE = join(PAGE, 'clone');

const map = JSON.parse(readFileSync(join(PAGE, 'asset-map.json'), 'utf8'));
const cssomMeta = JSON.parse(readFileSync(join(PAGE, 'cssom-refs.json'), 'utf8'));
const cssText = readFileSync(join(PAGE, 'cssom.css'), 'utf8');
const ORIGIN = cssomMeta.origin ?? new URL(map.imgs[0] ?? map.css[0]).origin;
const adapter = pickAdapter(readFileSync(join(PAGE, 'dom.html'), 'utf8'));
mkdirSync(join(CLONE, 'styles'), { recursive: true });
mkdirSync(join(CLONE, 'assets'), { recursive: true });

const extOf = (ct, url) => {
  const m = /\.(woff2?|ttf|otf|eot|png|jpe?g|webp|avif|svg|gif|ico)$/i.exec(new URL(url).pathname);
  if (m) return m[1].replace('jpeg', 'jpg');
  return ct.includes('woff2') ? 'woff2' : ct.includes('font') ? 'woff' : ct.includes('svg') ? 'svg'
    : ct.includes('png') ? 'png' : ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'bin';
};

// ---------- 1. CSSOM: 补抓引用(字体/背景图) + 重写为相对路径 ----------
console.log('[1/3] fetch cssom refs (adapter:', adapter.name + ')');
let css = cssText;
let fetched = 0, failed = 0;
const fetchBin = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(res.status);
  return Buffer.from(await res.arrayBuffer());
};
for (const ref of cssomMeta.refs) {
  let abs;
  try { abs = new URL(ref, ORIGIN).href; } catch { continue; }
  const name = `ref${String(fetched).padStart(3, '0')}.${extOf('', abs)}`;
  const sub = /\.(woff2?|ttf|otf|eot)$/i.test(name) ? 'styles' : 'assets';
  const rel = (sub === 'styles' ? '' : '../') + sub + '/' + name;
  css = css.split(ref).join(rel);
  const dest = join(CLONE, sub, name);
  if (existsSync(dest)) { fetched++; continue; }

  // 来源优先级：本地已捕获副本 → 适配器候选 URL 链逐个尝试
  let got = null;
  const bn = decodeURIComponent(new URL(abs).pathname).split('/').pop().split('?')[0];
  for (const dir of [join(PAGE, 'styles'), join(PAGE, 'assets')]) {
    const cand = join(dir, bn);
    if (existsSync(cand)) { got = readFileSync(cand); break; }
  }
  if (!got) {
    for (const u of adapter.cssRefCandidates(abs)) {
      try { got = await fetchBin(u); break; } catch { /* next candidate */ }
    }
  }
  if (!got) { failed++; console.warn('  FAIL', abs); continue; }
  writeFileSync(dest, got);
  fetched++;
}
writeFileSync(join(CLONE, 'styles', 'cssom.css'), css);
console.log(`  refs=${cssomMeta.refs.length} ok=${fetched} fail=${failed} -> styles/cssom.css ${(css.length / 1024).toFixed(0)}KB`);

// ---------- 2. HTML 重写 ----------
console.log('[2/3] rewrite DOM');
const lookup = (raw) => {
  const dec = raw.replace(/&amp;/g, '&');
  const abs = (() => { try { return new URL(dec, ORIGIN).href; } catch { return null; } })();
  return map.imgMap[abs] ?? map.imgMap[dec] ?? null;
};

let html = readFileSync(join(PAGE, 'dom.html'), 'utf8');
for (const [origUrl, relPath] of Object.entries(map.imgMap)) html = html.split(origUrl).join(relPath);

html = html.replace(/\b(src|srcset|href)="([^"]*)"/g, (m, attr, val) => {
  if (!val || /^(#|data:|mailto:|javascript:|tel:)/.test(val)) return m;
  if (attr === 'srcset') {
    const out = val.split(',').map(p => {
      const seg = p.trim().split(/\s+/);
      const hit = lookup(seg[0]);
      if (hit) seg[0] = hit;
      return seg.join(' ');
    }).join(', ');
    return `${attr}="${out}"`;
  }
  const hit = lookup(val);
  return hit ? `${attr}="${hit}"` : m;
});

// 原样式引用让位给 cssom.css；preload 离线无意义
html = html
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, '')
  .replace(/<link[^>]*rel="(preload|preconnect|dns-prefetch|modulepreload)"[^>]*>/gi, '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace('</head>', '<link rel="stylesheet" href="styles/cssom.css"></head>');

// W0 地基假设 = 纯静态保真：移除全部 <script>
html = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<script\b[^>]*\/>/gi, '');

const leftover = (html.match(/\/_next\/[^\s"'())]+/g) ?? []).length;
html = `<!-- heimdall clone: static L1 transplant (CSSOM final state), scripts stripped, adapter=${adapter.name} -->\n` + html;
writeFileSync(join(CLONE, 'index.html'), html);
console.log(`  clone/index.html ${(html.length / 1024).toFixed(0)}KB, leftover /_next refs: ${leftover}`);

// ---------- 3. 复制捕获期已下载的图片/图标到 clone ----------
console.log('[3/3] copy captured assets');
let copied = 0;
for (const [origUrl, relPath] of Object.entries(map.imgMap)) {
  const src = join(PAGE, relPath);
  if (existsSync(src)) {
    const dest = join(CLONE, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
    copied++;
  }
}
console.log(`\nDONE clone -> ${relative(process.cwd(), CLONE)} (assets copied: ${copied})`);
