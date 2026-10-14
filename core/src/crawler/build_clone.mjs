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
import { scanCssRefs, rewriteCssRefs, extractFontRules } from '../css-refs.mjs';
import { relTokens, stripAssetLinkTags, findStrayRefs, rasterizeCanvases, applyVideoPosters, materializeMediaPosters, dropCrossoriginOnLocalRefs, neutralizeBaseTag, replaceRefTable } from '../dom-refs.mjs';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { UA } from '../ua.mjs';
import { sanitizeStaticHtml, staticCloneChooserHtml } from '../static-html-safety.mjs';


const PAGE = requireArg(process.argv[2], 'node src/crawler/build_clone.mjs <pageDir>', '页面目录');
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

/** 累计：本地引用上被摘掉的 crossorigin 个数（进 clone-gaps，别做成一件事没人知道） */
let crossOriginDropped = 0;

/** 取回响应体 + Content-Type（扩展名判定需要真实类型，不能只靠 URL 后缀猜） */
/**
 * 取回一份资产。
 *
 * **只对网络层失败重试**（连接重置 / 超时 / DNS 抖动），HTTP 状态码与内容问题不重试 ——
 * 404 再问三次还是 404，只是白等。实测：一次瞬时失败会让 19 个字体引用里凭空多出
 * 一个"不可达"缺口（重跑即消失），在几十页的批量里这种噪声需要人逐个甄别。
 */
const ASSET_TIMEOUT = Number(process.env.HEIMDALL_ASSET_TIMEOUT_MS ?? 60_000);
const fetchBin = async (url, attempts = 3) => {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ASSET_TIMEOUT) });
      if (!res.ok) throw new Error(String(res.status));      // HTTP 状态：重试无意义
      const ct = res.headers.get('content-type') || '';
      // 软 404 / SPA 兜底：要图片却回 HTML。落盘会变成"看着有、其实全错"的假资产
      if (isSoftHtml(ct, url)) throw new Error('soft-404 (text/html)');
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty body');
      return { buf, ct };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const permanent = /^\d+$/.test(msg) || /soft-404|empty body/.test(msg);
      if (permanent || i === attempts) break;
      await new Promise(r => setTimeout(r, 300 * i));
    }
  }
  throw lastErr;
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
 * 被**多个不同引用**认领的文件名。
 *
 * 这种映射本身是坏的：文件名在同一个目录里是唯一的，两个引用指向它，
 * 内容只可能属于其中一个（旧版本的分配逻辑会撞名覆盖，见 writeAssetUnique）。
 * 而复用路径只检查"文件在不在"，不检查内容对不对 —— 于是坏映射一旦落进
 * ref-index.json 就**永久**保留，每次重建都照抄（实测 linear.app 的三个页）。
 * 所以这类映射一律不复用，让它们重新走一遍分配。
 */
function ambiguousRels(index) {
  const owners = new Map();
  for (const map of Object.values(index ?? {})) {
    for (const [raw, v] of Object.entries(map ?? {})) {
      const rel = v?.rel;
      if (!rel) continue;
      if (!owners.has(rel)) owners.set(rel, new Set());
      owners.get(rel).add(raw);
    }
  }
  const bad = new Set();
  for (const [rel, set] of owners) if (set.size > 1) bad.add(rel);
  return bad;
}
const AMBIGUOUS_RELS = ambiguousRels(refIndex);
if (AMBIGUOUS_RELS.size) console.warn('  [ref-index] ' + AMBIGUOUS_RELS.size + ' 个文件名被多个引用认领（旧版分配撞名留下的）→ 不复用，重新分配');

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
  // 坏映射不复用（见 AMBIGUOUS_RELS）：文件在 ≠ 文件对
  if (reuse && !AMBIGUOUS_RELS.has(reuse)) {
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
  // 联网补抓（fetchBin 内部对网络抖动已重试）
  let lastErr = null;
  if (!got) {
    for (const c of cands) {
      try { const r = await fetchBin(c); got = r.buf; gotExt = extFrom(c, r.ct, r.buf); break; } catch (e) { lastErr = e; }
    }
  }
  if (!got || !got.length) {
    gaps.push({ ref, candidates: cands, file: cssFileName, reason: 'unreachable', error: lastErr ? String(lastErr.message ?? lastErr).slice(0, 80) : null });
    return null;
  }
  const ext = gotExt || 'bin';
  const sub = FONT_EXT.has(ext) ? 'styles' : 'assets';
  return writeAssetUnique(sub, idx, ext, got);
}

/**
 * 把取回的字节写进 `clone/<sub>/refNNN.ext`，**保证不会覆盖别人的同名文件**。
 *
 * 为什么需要这一步：`idx` 是**每个 CSS 文件各自从 0 数**的引用序号，
 * 而 cssom.css / fonts.css / cssom-375.css / cssom-768.css 全都往同一个
 * `clone/styles/` 与 `clone/assets/` 里写。两份样式表的同一个序号指向不同资产时，
 * 后写的那个就把先写的**覆盖掉**，而且一声不响 —— 实测 linear.app：
 * `ref002.woff2` 同时被 cssom 的 InterVariable-Italic 与 fonts.css 的 Berkeley Mono 认领，
 * 最后落盘的是 Berkeley（两者 sha256 与 ref003 完全相同）。
 *
 * 后果是永久性的：ref-index.json 记的是**文件名**，复用路径只检查文件在不在、
 * 不检查内容对不对，于是错配一次就一直是错的，每次重建都照抄。
 *
 * 撞名且内容不同 → 往后找一个空位（编号只是内部标识，**唯一性才是硬要求**）。
 * 内容相同（同一份字体被两份样式表各按自己的顺序编号）→ 直接复用，不重写。
 */
function writeAssetUnique(sub, idx, ext, buf) {
  for (let i = idx; ; i++) {
    const name = 'ref' + String(i).padStart(3, '0') + '.' + ext;
    const file = join(CLONE, sub, name);
    if (existsSync(file)) {
      let same = false;
      try { same = readFileSync(file).equals(buf); } catch { same = false; }
      if (!same) continue;         // 同名不同内容 → 这个位置是别人的，往后找
    } else {
      writeFileSync(file, buf);
    }
    return sub === 'styles' ? name : '../assets/' + name;
  }
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
  writeFileAtomic(join(CLONE, 'styles', cssFileName), css);
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
  // 整表一次替换，而不是逐条 split/join —— 原因（前缀、重扫、速度）见 dom-refs.replaceRefTable
  html = replaceRefTable(html, resTable);
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
  // 引用都改成本地路径了，`crossorigin` 就只剩副作用：**用 file:// 打开克隆页时
  // 图片会被 CORS 拦掉**，变成一排裂图占位框（"双击即看"是我们承诺过的用法）。
  // 详见 dom-refs.mjs。放在引用改写**之后**：判断依据是改写后的值。
  const cx = dropCrossoriginOnLocalRefs(html);
  crossOriginDropped += cx.count;
  html = cx.html;
  html = stripAssetLinkTags(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace('</head>', '<link rel="stylesheet" href="styles/' + cssFileName + '">'
      + (fontCss ? '<link rel="stylesheet" href="styles/fonts.css">' : '') + '</head>');
  // <base href="/"> 会把上面这些相对路径全部改基到站点根（Angular 应用默认带它）
  html = neutralizeBaseTag(html);
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
}

// ---------- 1. 主（桌面）CSSOM 本地化 ----------
const cssGaps = [];   // 本地化失败的 CSS 引用（落盘可见，不再只打日志）
console.log('[1/4] localize cssom (desktop, adapter:', adapter.name + ')');
const mainCss = await localizeCss(cssText, 'cssom.css', ORIGIN, cssomMeta.refMap ?? {}, cssGaps);
console.log('  refs=' + cssomMeta.refs.length + ' ok=' + mainCss.fetched + ' fail=' + mainCss.failed + ' -> styles/cssom.css ' + (mainCss.size / 1024).toFixed(0) + 'KB');

// ---------- 1b. 跨域样式表里的 @font-face ----------
// 浏览器读不到跨域样式表的 cssRules（同源策略），所以 Google Fonts 这类
// @font-face 从来进不了我们的 CSSOM —— 结果是图标字体的连字名当文字渲染出来
// （实测 angular.dev：页面上直接印着 chevron_right / more_horiz）。
// 只能服务端取原文再抽，**只抽 @font-face**：把整份第三方 CSS 倒进来会连它的
// reset 与工具类一起带进来，足以把版面搞乱。
const crossSheets = (cssomMeta.sheets ?? []).filter(s => s.href && s.error);
console.log('[1b] cross-origin @font-face (' + crossSheets.length + ' sheet)');
let fontCss = '';
for (const s of crossSheets) {
  try {
    const res = await fetch(s.href, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    fontCss += extractFontRules(await res.text(), s.href);
  } catch { /* 取不到就跳过 —— 不为一个图标字体让整页构建失败 */ }
}
if (fontCss) {
  const r = await localizeCss(fontCss, 'fonts.css', ORIGIN, {}, cssGaps);
  console.log('  @font-face 本地化 refs=' + r.fetched + ' fail=' + r.failed + ' -> styles/fonts.css ' + (r.size / 1024).toFixed(0) + 'KB');
} else {
  console.log('  （无跨域 @font-face）');
}

// ---------- 2. 桌面 HTML ----------
console.log('[2/4] rewrite desktop DOM');const header = '<!-- heimdall clone: static L1 transplant (CSSOM final state), scripts stripped, adapter=' + adapter.name + ' -->\n';
const rawDesktopHtml = rewriteHtml(readFileSync(join(PAGE, 'dom.html'), 'utf8'), 'cssom.css');
// 画布替换放在引用改写**之后**：这样新插入的 src="assets/canvas-N.png" 不会被
// 当成待解析的站内引用（它本来就是本地文件）。
const { html: desktopHtmlBeforeVideo, count: rasterizedCanvases } = rasterizeCanvases(rawDesktopHtml);
// 视频 poster 同理，也放在引用改写之后（见 dom-refs.mjs 里 applyVideoPosters 的注释）
const { html: desktopHtmlBeforeMedia, count: videoPosters } = applyVideoPosters(desktopHtmlBeforeVideo);
// 自定义媒体组件（`<mux-player poster="…">`）换成那张 poster 的 <img>：
// 它们的画面是脚本建的 shadow DOM，剥了脚本就只剩空壳（理由见 dom-refs.mjs）。
// 同样放在引用改写之后 —— 此时 poster 已经是本地路径，直接当 src 用。
const { html: desktopHtmlWithMedia, count: mediaPosters, remote: mediaPostersRemote } = materializeMediaPosters(desktopHtmlBeforeMedia);
const desktopHtml = sanitizeStaticHtml(desktopHtmlWithMedia);

// ---------- 3. 多视口快照（可选） ----------
const VARIANTS = [375, 768].filter(w => existsSync(join(PAGE, 'dom-' + w + '.html')) && existsSync(join(PAGE, 'cssom-' + w + '.css')));
for (const w of VARIANTS) {
  console.log('[3/4] build viewport snapshot @' + w);
  const meta = JSON.parse(readFileSync(join(PAGE, 'cssom-refs-' + w + '.json'), 'utf8'));
  const cssOut = 'cssom-' + w + '.css';
  const r = await localizeCss(readFileSync(join(PAGE, 'cssom-' + w + '.css'), 'utf8'), cssOut, meta.origin ?? ORIGIN, meta.refMap ?? {}, cssGaps);
  const html = sanitizeStaticHtml(rewriteHtml(readFileSync(join(PAGE, 'dom-' + w + '.html'), 'utf8'), cssOut));
  writeFileAtomic(join(CLONE, 'index-' + w + '.html'), header + html);
  console.log('  ' + cssOut + ' refs=' + (meta.refs ?? []).length + ' ok=' + r.fetched + ' fail=' + r.failed);
}
if (VARIANTS.length) {
  writeFileAtomic(join(CLONE, 'index-1440.html'), header + desktopHtml);
  writeFileAtomic(join(CLONE, 'index.html'), staticCloneChooserHtml([...VARIANTS, 1440]));
  console.log('  viewport chooser -> index.html (' + [...VARIANTS, 1440].join('/') + ')');
} else {
  writeFileAtomic(join(CLONE, 'index.html'), header + desktopHtml);
}
// 未本地化的站内**资产**引用（口径与两个坑见 src/dom-refs.mjs 顶部注释）。
// 这里只负责调用与打印 —— 判断逻辑在 dom-refs.mjs，那里有单测覆盖
// "rel 是 token 列表" 与 "根相对路径也算残留" 两条。
const leftoverRefs = findStrayRefs(desktopHtml, ORIGIN);
const leftover = leftoverRefs.length;
console.log('  desktop index ' + (desktopHtml.length / 1024).toFixed(0) + 'KB, stray same-origin asset refs: ' + leftover);
if (leftover) {
  console.log('    ⚠ 这些路径在本地服务下会 404：' + leftoverRefs.slice(0, 5).map(r => r.ref).join(', '));
}

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
  writeFileAtomic(dest, buf);
  copied++;
}
// 画布光栅图（capture 阶段落的）：不在 imgMap 里，要单独拷
let copiedCanvases = 0;
{
  const srcDir = join(PAGE, 'assets');
  if (existsSync(srcDir)) {
    for (const n of readdirSync(srcDir)) {
      if (!/^canvas-\d+\.png$/.test(n)) continue;
      const dest = join(CLONE, 'assets', n);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileAtomic(dest, readFileSync(join(srcDir, n)));
      copiedCanvases++;
    }
  }
}
// 幂等索引：下次重建按「引用原文」复用，编号位移也不会串资产
writeFileSync(REF_INDEX, JSON.stringify(refIndex, null, 2));

// CSS 本地化缺口落盘：让"字体/背景图悄悄没抓到"变成可见事实（控制台质检 tab 读它）
const gapReport = {
  page: relative(WORKSPACE, PAGE).split('\\').join('/'),
  generatedAt: new Date().toISOString(),
  cssRefsFailed: cssGaps.length,
  leftoverSameOriginRefs: leftover,
  // 画布：脚本被剥离后画布上什么都不剩，所以捕获阶段会把它光栅化成静态图。
  // 这里如实记录抓到几个 —— 没抓到的（从未绘制 / 跨域污染）保持原样，
  // 不伪装成"已处理"，否则"缺失"就变成肉眼之外看不见的东西。
  crossOriginDropped,
  canvasRasterized: rasterizedCanvases,
  videoPosterized: videoPosters,
  // 自定义媒体组件换成 poster 静态图的个数；remote 那几个是 poster 没能本地化的
  // （镜像里会联网取原站图），离线不干净要看得见
  mediaPosterized: mediaPosters,
  mediaPosterRemote: mediaPostersRemote,
  gaps: cssGaps,
};
writeFileSync(join(PAGE, 'clone-gaps.json'), JSON.stringify(gapReport, null, 2));
if (cssGaps.length) {
  console.log('\n  ⚠ CSS 引用缺口 ' + cssGaps.length + ' 处（详见 clone-gaps.json，多为原站已失效的引用）');
  for (const g of cssGaps.slice(0, 3)) console.log('     · ' + g.ref.slice(0, 80));
}

console.log('\nDONE clone -> ' + relative(process.cwd(), CLONE) + ' (assets copied: ' + copied + ', canvas rasters: ' + copiedCanvases + ', crossorigin dropped: ' + crossOriginDropped + ', media posters: ' + mediaPosters + (mediaPostersRemote ? ' (' + mediaPostersRemote + ' 张仍是远程)' : '') + ', variants: ' + VARIANTS.length + ', css gaps: ' + cssGaps.length + ')');
