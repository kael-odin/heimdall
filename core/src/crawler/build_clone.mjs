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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { pickAdapter, refRewriteCandidates } from '../adapters/index.mjs';
import { loadProfile, sanitizeHost } from '../site-profile.mjs';
import { extFrom, isNonAssetRef, isSoftHtml } from '../asset-ext.mjs';
import { scanCssRefs, rewriteCssRefs } from '../css-refs.mjs';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';

const PAGE = requireArg(process.argv[2], 'node src/crawler/build_clone.mjs <pageDir>', '页面目录');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CLONE = join(PAGE, 'clone');
// 站点从产物路径反推：workspace/<host>/pages/<name>
const HOST = sanitizeHost(relative(WORKSPACE, PAGE).split(sep)[0]);

const map = JSON.parse(readFileSync(join(PAGE, 'asset-map.json'), 'utf8'));
const cssomMeta = JSON.parse(readFileSync(join(PAGE, 'cssom-refs.json'), 'utf8'));
const cssText = readFileSync(join(PAGE, 'cssom.css'), 'utf8');
const ORIGIN = cssomMeta.origin ?? new URL(map.imgs[0] ?? map.css[0]).origin;
const domHtml = readFileSync(join(PAGE, 'dom.html'), 'utf8');
const profile = loadProfile(HOST);
const adapter = pickAdapter(domHtml, profile);
const rewriteCandidates = refRewriteCandidates(adapter, profile);
mkdirSync(join(CLONE, 'styles'), { recursive: true });
mkdirSync(join(CLONE, 'assets'), { recursive: true });

const FONT_EXT = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);

/** 取回响应体 + Content-Type（扩展名判定需要真实类型，不能只靠 URL 后缀猜） */
const fetchBin = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(res.status);
  const ct = res.headers.get('content-type') || '';
  // 软 404 / SPA 兜底：要图片却回 HTML。落盘会变成"看着有、其实全错"的假资产
  if (isSoftHtml(ct, url)) throw new Error('soft-404 (text/html)');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty body');
  return { buf, ct };
};

/**
 * ref-index.json —— 「CSS 原始引用 → 本地文件」的稳定映射（每张 CSS 一张表）
 *
 * 为什么需要它：refNNN 的编号来自引用在 CSS 里的出现顺序。一旦扫描口径变化
 * （例如修正 data URI 内嵌 url() 的误判），编号就会整体位移；此时若按“序号”复用
 * 上一次的产物，就会把 A 图接到 B 的位置 —— 静默串资产。按引用原文建索引则天然免疫。
 *
 * 磁盘格式：{ "cssom.css": { "<raw ref>": { "rel": "../assets/ref003.png", "candidates": ["https://…"] } } }
 */
const REF_INDEX = join(CLONE, 'ref-index.json');
let refIndex = {};
try { refIndex = JSON.parse(readFileSync(REF_INDEX, 'utf8')); } catch { refIndex = {}; }

/**
 * 老产物迁移：没有 ref-index.json 时，用「已构建 CSS 的 token 顺序 ↔ 源 CSS token 顺序」
 * 一一对应反推出映射（构建只换 URL 文本、不增删 token，所以顺序严格对应）。
 * 对不上（长度不等）就放弃复用，重新解析 —— 宁可慢，不可错。
 */
function legacyRelMap(cssFileName, sourceCss) {
  const built = join(CLONE, 'styles', cssFileName);
  if (!existsSync(built)) return {};
  let builtText = '';
  try { builtText = readFileSync(built, 'utf8'); } catch { return {}; }
  const src = scanCssRefs(sourceCss).map(t => t.raw);
  const out = scanCssRefs(builtText).map(t => t.raw);
  if (!src.length || src.length !== out.length) return {};
  const map = {};
  for (let i = 0; i < src.length; i++) {
    const m = /^((?:\.\.\/assets\/)?(ref\d+\.[a-z0-9]+))$/i.exec(out[i]);
    if (!m || !src[i]) continue;
    const rel = m[1];
    const onDisk = join(CLONE, rel.replace(/^\.\.\//, ''));
    try {
      if (!existsSync(onDisk) || !statSync(onDisk).isFile()) continue;
    } catch { continue; }
    map[src[i]] = { rel, candidates: [] };
  }
  return map;
}

/**
 * 候选链：① 样式表基准（规范）② 页面 origin（历史兼容/无 refMap 的老产物）
 * ③ 适配器 + 配方的前缀重写规则（例如 nextjs 的 /_next/static/media）
 */
function candidateChain(ref, refMap, origin) {
  const out = [];
  const push = (u) => { if (u && !out.includes(u)) out.push(u); };
  const sheetBased = Array.isArray(refMap?.[ref]) ? refMap[ref] : [];
  for (const u of sheetBased) push(u);
  let originBased = null;
  try { originBased = new URL(ref, origin).href; push(originBased); } catch { /* 相对 ref 但 origin 非法 */ }
  for (const u of sheetBased) for (const c of rewriteCandidates(u)) push(c);
  if (originBased) for (const c of rewriteCandidates(originBased)) push(c);
  return out;
}

/** 解析单个引用 → 本地相对路径（失败返回 null） */
async function resolveRef(ref, idx, refMap, origin, gaps, cssFileName, priorMap) {
  const cands = candidateChain(ref, refMap, origin);
  if (!cands.length) { gaps.push({ ref, candidates: [], file: cssFileName, reason: 'unresolvable' }); return null; }

  // 幂等：按“引用原文”复用上一次的产物（绝不用序号——编号会随扫描口径位移）
  const reuse = priorMap?.[ref]?.rel;
  if (reuse) {
    try {
      if (existsSync(join(CLONE, reuse.replace(/^\.\.\//, ''))) && statSync(join(CLONE, reuse.replace(/^\.\.\//, ''))).isFile()) return reuse;
    } catch { /* 损坏的复用目标 → 重新解析 */ }
  }

  let got = null, gotExt = null;
  // 捕获期已下载的同名文件（精确 basename，避免模糊命中；目录名必须排除，防 EISDIR）
  for (const c of cands) {
    let bn = '';
    try { bn = decodeURIComponent(new URL(c).pathname).split('/').pop(); } catch { continue; }
    if (!bn || bn.includes('/')) continue;
    for (const dir of [join(PAGE, 'styles'), join(PAGE, 'assets')]) {
      const f = join(dir, bn);
      try {
        if (!existsSync(f) || !statSync(f).isFile()) continue;
      } catch { continue; }
      got = readFileSync(f);
      if (!got.length) { got = null; continue; }
      gotExt = extFrom(c, '', got);
      break;
    }
    if (got) break;
  }
  // 联网补抓
  if (!got) {
    for (const c of cands) {
      try { const r = await fetchBin(c); got = r.buf; gotExt = extFrom(c, r.ct, r.buf); break; } catch { /* 下一个候选 */ }
    }
  }
  if (!got || !got.length) {
    gaps.push({ ref, candidates: cands, file: cssFileName, reason: 'unreachable' });
    return null;
  }
  const ext = gotExt || 'bin';
  const sub = FONT_EXT.has(ext) ? 'styles' : 'assets';
  const name = 'ref' + String(idx).padStart(3, '0') + '.' + ext;
  writeFileSync(join(CLONE, sub, name), got);
  return sub === 'styles' ? name : '../assets/' + name;
}

/**
 * CSSOM 引用本地化（字体与 cssom 同目录 → 文件名；其余 ../assets/）
 *
 * 用 css-refs 的扫描器取引用并**单遍重建**：只替换 URL 片段，且天然跳过
 * data URI 内嵌的 url(...) —— 旧实现的全局 split/join 会把内联 SVG 的
 * `mask='url(%23f)'` 一起改掉，静默破坏图标。
 */
async function localizeCss(cssTextIn, cssFileName, origin, refMap = {}, gaps = []) {
  const uniq = [...new Set(scanCssRefs(cssTextIn).map(t => t.raw))];
  // 幂等基线：优先用 ref-index.json；老产物（无索引）从已构建 CSS 反推
  const priorMap = { ...legacyRelMap(cssFileName, cssTextIn), ...(refIndex[cssFileName] ?? {}) };
  const nextIndex = {};
  const resolved = new Map();
  let fetched = 0, failed = 0, idx = 0;
  for (const ref of uniq) {
    if (!ref || ref.startsWith('data:')) continue;
    if (isNonAssetRef(ref)) continue;                 // #id / %23id / 伪协议：文档内引用，原样保留
    const cands = candidateChain(ref, refMap, origin);
    const i = idx++;
    const rel = await resolveRef(ref, i, refMap, origin, gaps, cssFileName, priorMap);
    if (rel) { resolved.set(ref, rel); nextIndex[ref] = { rel, candidates: cands }; fetched++; } else failed++;
  }
  const css = rewriteCssRefs(cssTextIn, resolved);
  writeFileSync(join(CLONE, 'styles', cssFileName), css);
  refIndex[cssFileName] = nextIndex;
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
const cssGaps = [];   // 本地化失败的 CSS 引用（落盘可见，不再只打日志）
console.log('[1/4] localize cssom (desktop, adapter:', adapter.name + ')');
const mainCss = await localizeCss(cssText, 'cssom.css', ORIGIN, cssomMeta.refMap ?? {}, cssGaps);
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
  const r = await localizeCss(readFileSync(join(PAGE, 'cssom-' + w + '.css'), 'utf8'), cssOut, meta.origin ?? ORIGIN, meta.refMap ?? {}, cssGaps);
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
// 未本地化的站内**资产**引用——口径只算真正的资产：
//   ① src/srcset/poster 上的绝对站内地址
//   ② <link> 里属于资产类的 rel（icon/preload/manifest…），**不含 canonical/alternate**
//      —— canonical 指向原站是正确的 SEO 归属，不该算残留
// 也不含 <a href>：指向未克隆页的链接本来就该指回原站（由 linker 负责跨页接线）。
const ORIGIN_RE = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const assetRefRe = new RegExp('(?:src|srcset|poster)="' + ORIGIN_RE + '[^"]*"', 'g');
const assetRels = new Set(['stylesheet', 'icon', 'shortcut icon', 'apple-touch-icon', 'mask-icon', 'manifest', 'preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch']);
const leftover = (desktopHtml.match(assetRefRe) ?? []).length
  + [...desktopHtml.matchAll(/<link\b[^>]*>/gi)].filter(tag => {
    const rel = (/\brel="([^"]*)"/i.exec(tag[0])?.[1] ?? '').toLowerCase().trim();
    const href = /\bhref="([^"]*)"/i.exec(tag[0])?.[1] ?? '';
    return assetRels.has(rel) && href.startsWith(ORIGIN);
  }).length;
console.log('  desktop index ' + (desktopHtml.length / 1024).toFixed(0) + 'KB, leftover same-origin asset refs: ' + leftover);

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
// 幂等索引：下次重建按「引用原文」复用，编号位移也不会串资产
writeFileSync(REF_INDEX, JSON.stringify(refIndex, null, 2));

// CSS 本地化缺口落盘：让"字体/背景图悄悄没抓到"变成可见事实（控制台质检 tab 读它）
const gapReport = {
  page: relative(WORKSPACE, PAGE).split('\\').join('/'),
  generatedAt: new Date().toISOString(),
  cssRefsFailed: cssGaps.length,
  leftoverSameOriginRefs: leftover,
  gaps: cssGaps,
};
writeFileSync(join(PAGE, 'clone-gaps.json'), JSON.stringify(gapReport, null, 2));
if (cssGaps.length) {
  console.log('\n  ⚠ CSS 引用缺口 ' + cssGaps.length + ' 处（详见 clone-gaps.json，多为原站已失效的引用）');
  for (const g of cssGaps.slice(0, 3)) console.log('     · ' + g.ref.slice(0, 80));
}

console.log('\nDONE clone -> ' + relative(process.cwd(), CLONE) + ' (assets copied: ' + copied + ', variants: ' + VARIANTS.length + ', css gaps: ' + cssGaps.length + ')');
