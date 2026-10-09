#!/usr/bin/env node
/**
 * build_clone — 资产本地化重写，产出离线可渲染的镜像页
 *
 * 样式源 = cssom.css（CSSOM 最终状态），HTML = dom.html 骨架本地化。
 * 若存在 dom-375/768.html（由 multi-snapshot.mjs 生成），则额外构建
 * index-375.html / index-768.html / index-1440.html，并以 index.html 作视口选择器。
 *
 * 用法: node src/crawler/build_clone.mjs <pageDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { pickAdapter } from '../adapters/index.mjs';
import { WORKSPACE } from '../paths.mjs';

const PAGE = process.argv[2] ?? join(WORKSPACE, 'apify.com', 'pages', 'home');
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

const fetchBin = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty body');
  return buf;
};

/** CSSOM 引用本地化（字体与 cssom 同目录 → 文件名；其余 ../assets/） */
async function localizeCss(cssTextIn, refs, cssFileName, origin) {
  let css = cssTextIn;
  let fetched = 0, failed = 0, refIndex = 0;
  for (const ref of refs) {
    let abs;
    try { abs = new URL(ref, origin).href; } catch { refIndex++; continue; }
    const name = 'ref' + String(refIndex++).padStart(3, '0') + '.' + extOf('', abs);
    const sub = /\.(woff2?|ttf|otf|eot)$/i.test(name) ? 'styles' : 'assets';
    const rel = sub === 'styles' ? name : '../assets/' + name;
    const dest = join(CLONE, sub, name);
    if (existsSync(dest)) { css = css.split(ref).join(rel); fetched++; continue; }
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
    if (!got || !got.length) { failed++; continue; }
    writeFileSync(dest, got);
    css = css.split(ref).join(rel);
    fetched++;
  }
  writeFileSync(join(CLONE, 'styles', cssFileName), css);
  return { fetched, failed, size: css.length };
}

/** HTML 本地化重写（资产表替换 + 引用属性 + 样式让位 + 去脚本） */
const resTable = { ...(map.resMap ?? {}), ...(map.imgMap ?? {}) };
const lookup = (raw) => {
  const dec = raw.replace(/&amp;/g, '&');
  const abs = (() => { try { return new URL(dec, ORIGIN).href; } catch { return null; } })();
  return resTable[abs] ?? resTable[dec] ?? null;
};
function rewriteHtml(domText, cssFileName) {
  let html = domText;
  for (const [origUrl, relPath] of Object.entries(resTable)) html = html.split(origUrl).join(relPath);
  html = html.replace(/(<use\b[^>]*\b(?:href|xlink:href)=")([^"#]+)(#[^"]*)(")/gi, (m, head, file, frag, tail) => {
    const hit = lookup(file);
    return hit ? head + hit + frag + tail : m;
  });
  html = html.replace(/\b(src|srcset|href|data|poster|content)="([^"]*)"/g, (m, attr, val) => {
    if (!val || /^(#|data:|mailto:|javascript:|tel:)/.test(val)) return m;
    if (attr === 'srcset') {
      const out = val.split(',').map(p => {
        const seg = p.trim().split(/\s+/);
        const hit = lookup(seg[0]);
        if (hit) seg[0] = hit;
        return seg.join(' ');
      }).join(', ');
      return attr + '="' + out + '"';
    }
    const hit = lookup(val);
    return hit ? attr + '="' + hit + '"' : m;
  });
  html = html
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, '')
    .replace(/<link[^>]*rel="(preload|preconnect|dns-prefetch|modulepreload)"[^>]*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace('</head>', '<link rel="stylesheet" href="styles/' + cssFileName + '"></head>');
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
}

// ---------- 1. 主（桌面）CSSOM 本地化 ----------
console.log('[1/4] localize cssom (desktop, adapter:', adapter.name + ')');
const mainCss = await localizeCss(cssText, cssomMeta.refs, 'cssom.css', ORIGIN);
console.log('  refs=' + cssomMeta.refs.length + ' ok=' + mainCss.fetched + ' fail=' + mainCss.failed + ' -> styles/cssom.css ' + (mainCss.size / 1024).toFixed(0) + 'KB');

// ---------- 2. 桌面 HTML ----------
console.log('[2/4] rewrite desktop DOM');
const header = '<!-- heimdall clone: static L1 transplant (CSSOM final state), scripts stripped, adapter=' + adapter.name + ' -->\n';
const desktopHtml = rewriteHtml(readFileSync(join(PAGE, 'dom.html'), 'utf8'), 'cssom.css');

// ---------- 3. 多视口快照（可选） ----------
const VARIANTS = [375, 768].filter(w => existsSync(join(PAGE, 'dom-' + w + '.html')) && existsSync(join(PAGE, 'cssom-' + w + '.css')));
for (const w of VARIANTS) {
  console.log('[3/4] build viewport snapshot @' + w);
  const meta = JSON.parse(readFileSync(join(PAGE, 'cssom-refs-' + w + '.json'), 'utf8'));
  const cssOut = 'cssom-' + w + '.css';
  const r = await localizeCss(readFileSync(join(PAGE, 'cssom-' + w + '.css'), 'utf8'), meta.refs ?? [], cssOut, meta.origin ?? ORIGIN);
  const html = rewriteHtml(readFileSync(join(PAGE, 'dom-' + w + '.html'), 'utf8'), cssOut);
  writeFileSync(join(CLONE, 'index-' + w + '.html'), header + html);
  console.log('  ' + cssOut + ' refs=' + (meta.refs ?? []).length + ' ok=' + r.fetched + ' fail=' + r.failed);
}
if (VARIANTS.length) {
  writeFileSync(join(CLONE, 'index-1440.html'), header + desktopHtml);
  const chooser = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Heimdall clone</title><script>location.replace(innerWidth<=600?"index-375.html":innerWidth<=1100?"index-768.html":"index-1440.html");</script>'
    + '<noscript><meta http-equiv="refresh" content="0;url=index-1440.html"></noscript></head><body></body></html>';
  writeFileSync(join(CLONE, 'index.html'), chooser);
  console.log('  viewport chooser -> index.html (375/768/1440)');
} else {
  writeFileSync(join(CLONE, 'index.html'), header + desktopHtml);
}
const leftover = (desktopHtml.match(/\/_next\/[^\s"'())]+/g) ?? []).length;
console.log('  desktop index ' + (desktopHtml.length / 1024).toFixed(0) + 'KB, leftover /_next refs: ' + leftover);

// ---------- 4. 复制捕获期已下载的图片/图标 ----------
console.log('[4/4] copy captured assets');
let copied = 0;
for (const [origUrl, relPath] of Object.entries(map.imgMap)) {
  const src = join(PAGE, relPath);
  if (!existsSync(src)) continue;
  const dest = join(CLONE, relPath);
  const buf = readFileSync(src);
  if (!buf.length) continue;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  copied++;
}
console.log('\nDONE clone -> ' + relative(process.cwd(), CLONE) + ' (assets copied: ' + copied + ', variants: ' + VARIANTS.length + ')');
