/**
 * audit/assets — 克隆资产缺口扫描（精细化：视觉缺口 / 元数据 / 追踪 / 设计替代）
 *
 * 对比三个来源：dom.html（原站渲染后 DOM） / clone/index.html / clone/styles/cssom.css
 * 判定：本地化 / 仍指向原站 / 第三方远程，并分类：
 *   visual    真正的视觉资产缺口（img/icon/svg-use/video/audio/css-url/inline-style）
 *   metadata  元数据链接（canonical/alternate/og:image/.well-known 等）
 *   tracking  追踪像素/分析脚本
 *   replaced  设计上被替换（源站 stylesheet/preload → 本地 cssom/资产）
 *
 * 用法: node src/audit/assets.mjs <host> [--max 60]
 * 产物: workspace/<host>/audit/{asset-gaps.json,asset-gaps.html}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'parse5';
import { WORKSPACE } from '../paths.mjs';
import { renderAssetGapsHtml } from './assets-report.mjs';

const IGNORE = /^(data:|#|mailto:|javascript:|tel:|about:blank)/i;
const TRACKING = /(t\.co|analytics\.twitter|facebook\.|doubleclick|googletagmanager|google-analytics|cookiepro|cookiebot|hs-scripts|clarity\.ms|hotjar|segment\.|mixpanel|bat\.bing)/i;
const META_LINK = /link\[(canonical|alternate|author|me|dns-prefetch|preconnect|agent-skills|api-catalog|service-desc|agents-md|auth-md|ai-catalog|service-doc|mcp-server-card|stylesheet)\]/;
const VISUAL_KINDS = /^(img|img-srcset|img-lazy|img-lazy-srcset|source-srcset|source-src|video|video-poster|audio|icon|svg-use|object|embed|inline-style|css-url)$/;

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value ?? '';
const splitSrcset = (v) => String(v ?? '').split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
const urlsInCssText = (text) => {
  const out = [];
  for (const m of String(text ?? '').matchAll(/url\(\s*(?:'|")?([^'")]+)(?:'|")?\s*\)/g)) out.push(m[1].trim());
  for (const m of String(text ?? '').matchAll(/@import\s+(?:url\(\s*)?(?:'|")?([^'")\s;]+)/g)) out.push(m[1].trim());
  return out;
};

/** 从 HTML 提取引用（纯函数） */
export function extractRefsFromHtml(html) {
  const doc = parse(String(html ?? ''));
  const refs = [];
  const push = (url, kind, extra = {}) => { if (url && !IGNORE.test(url)) refs.push({ url, kind, ...extra }); };
  const walk = (n) => {
    for (const c of n.childNodes ?? []) {
      if (c.tagName) {
        const tag = c.tagName.toLowerCase();
        const cls = attr(c, 'class').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        const where = tag + (cls ? '.' + cls : '');
        if (tag === 'img') {
          push(attr(c, 'src'), 'img', { where });
          for (const u of splitSrcset(attr(c, 'srcset'))) push(u, 'img-srcset', { where });
          for (const u of splitSrcset(attr(c, 'data-srcset'))) push(u, 'img-lazy-srcset', { where });
          push(attr(c, 'data-src'), 'img-lazy', { where });
        } else if (tag === 'source') {
          for (const u of splitSrcset(attr(c, 'srcset'))) push(u, 'source-srcset', { where });
          push(attr(c, 'src'), 'source-src', { where });
        } else if (tag === 'video') { push(attr(c, 'src'), 'video', { where }); push(attr(c, 'poster'), 'video-poster', { where }); }
        else if (tag === 'audio') push(attr(c, 'src'), 'audio', { where });
        else if (tag === 'link') {
          const rel = attr(c, 'rel').toLowerCase();
          const kind = rel.includes('icon') ? 'icon' : rel.includes('manifest') ? 'manifest' : rel.includes('preload') ? 'preload-' + (attr(c, 'as') || 'other') : 'link';
          push(attr(c, 'href'), kind, { where: 'link[' + rel + ']' });
        } else if (tag === 'use') push(attr(c, 'href') || attr(c, 'xlink:href'), 'svg-use', { where });
        else if (tag === 'object') push(attr(c, 'data'), 'object', { where });
        else if (tag === 'embed') push(attr(c, 'src'), 'embed', { where });
        else if (tag === 'meta') {
          const p = (attr(c, 'property') || attr(c, 'name') || '').toLowerCase();
          if (['og:image', 'twitter:image', 'msapplication-tileimage'].includes(p)) push(attr(c, 'content'), 'meta-image', { where: 'meta[' + p + ']' });
        }
        if (attr(c, 'style') && /url\(/i.test(attr(c, 'style'))) for (const u of urlsInCssText(attr(c, 'style'))) push(u, 'inline-style', { where });
        walk(c);
      }
    }
  };
  walk(doc);
  return refs;
}

export function extractRefsFromCss(css) {
  return urlsInCssText(css).filter(u => !IGNORE.test(u)).map(u => ({ url: u, kind: 'css-url', where: 'css' }));
}

const resolveUrl = (u, base) => { try { return new URL(String(u), base).href.split('#')[0]; } catch { return null; } };
const safeRead = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

function categorizeRef(r) {
  if (TRACKING.test(r.abs)) return 'tracking';
  if (/^preload/.test(r.kind) && !r.froms.includes('clone-html') && !r.froms.includes('clone-css')) return 'replaced';
  // 只出现在原站 DOM/inline style 的 CSS url（字体等），克隆改用 cssom.css，不算视觉缺口
  if (r.kind === 'css-url' && r.froms.every(f => f.startsWith('source-'))) return 'replaced';
  if (r.kind === 'link' && META_LINK.test(r.where ?? '')) return r.where.includes('stylesheet') ? 'replaced' : 'metadata';
  if (r.kind === 'meta-image') return 'metadata';
  if (VISUAL_KINDS.test(r.kind)) return 'visual';
  return 'metadata';
}

/** 单个页面扫描 */
export function scanPage(pageDir, { origin }) {
  const cloneDir = join(pageDir, 'clone');
  const manifest = (() => { try { return JSON.parse(readFileSync(join(pageDir, 'manifest.json'), 'utf8')); } catch { return {}; } })();
  const target = manifest.target ?? origin + '/';
  const assetMap = (() => { try { return JSON.parse(readFileSync(join(pageDir, 'asset-map.json'), 'utf8')); } catch { return {}; } })();
  const resMap = { ...(assetMap.resMap ?? {}), ...(assetMap.imgMap ?? {}) };
  const source = { dom: safeRead(join(pageDir, 'dom.html')), clone: safeRead(join(cloneDir, 'index.html')), css: safeRead(join(cloneDir, 'styles', 'cssom.css')) };
  const allRefs = [
    ...extractRefsFromHtml(source.dom).map(r => ({ ...r, from: 'source-dom' })),
    ...extractRefsFromHtml(source.clone).map(r => ({ ...r, from: 'clone-html' })),
    ...extractRefsFromCss(source.css).map(r => ({ ...r, from: 'clone-css' })),
    ...extractRefsFromCss(source.dom).map(r => ({ ...r, from: 'source-css-inline' })),
  ];
  const seen = new Map();
  for (const r of allRefs) {
    const abs = resolveUrl(r.url, target);
    if (!abs) continue;
    if (!seen.has(abs)) seen.set(abs, { ...r, abs, froms: new Set([r.from]) });
    else seen.get(abs).froms.add(r.from);
  }
  const host = (() => { try { return new URL(target).hostname.replace(/^www\./, ''); } catch { return ''; } })();

  const gaps = [];
  let localized = 0;
  for (const r of seen.values()) {
    r.froms = [...r.froms];
    // 克隆内自校验：clone-css/clone-html 的站内相对引用必须按“文件自身目录”解析到真实文件。
    // 必须在同名兜底之前执行，否则 styles/styles/refNNN.woff2 会被 styles/refNNN.woff2 掩盖。
    const fromClone = r.froms.includes('clone-css') || r.froms.includes('clone-html');
    const rawRef = String(r.url ?? '');
    const isRelativeRef = !/^(?:data:|blob:|https?:|\/\/|#)/i.test(rawRef);
    if (fromClone && isRelativeRef) {
      let inner = null;
      try {
        const clean = decodeURIComponent(rawRef.split('#')[0].split('?')[0]);
        const baseDir = r.froms.includes('clone-css') ? join(cloneDir, 'styles') : cloneDir;
        const p = clean.startsWith('/') ? join(cloneDir, clean) : join(baseDir, clean);
        inner = existsSync(p) ? p : null;
      } catch {}
      if (!inner) {
        gaps.push({
          url: r.abs, kind: r.kind, where: r.where ?? '', froms: r.froms,
          status: 'clone-broken', category: categorizeRef(r), inClone: true,
        });
        continue;
      }
    }
    const mapped = resMap[r.abs];
    let localRel = mapped && existsSync(join(cloneDir, mapped)) ? mapped : null;
    if (!localRel) {
      const cn = basename(decodeURIComponent((() => { try { return new URL(r.abs).pathname; } catch { return r.abs; } })()));
      for (const sub of ['assets', 'styles']) if (cn && existsSync(join(cloneDir, sub, cn))) { localRel = sub + '/' + cn; break; }
    }
    if (localRel) { localized++; continue; }
    const isOrigin = (() => { try { return new URL(r.abs).hostname.replace(/^www\./, '') === host; } catch { return false; } })();
    gaps.push({
      url: r.abs, kind: r.kind, where: r.where ?? '', froms: r.froms,
      status: isOrigin ? 'remote-origin' : 'remote-third-party',
      category: categorizeRef(r),
      inClone: source.clone.includes(r.url) || source.css.includes(r.url),
    });
  }
  const visual = gaps.filter(g => g.category === 'visual');
  return {
    page: basename(pageDir), target, refs: seen.size, localized,
    gaps, visualGaps: visual.length,
    visualOrigin: visual.filter(g => g.status === 'remote-origin').length,
    visualThird: visual.filter(g => g.status === 'remote-third-party').length,
    byStatus: gaps.reduce((a, g) => ((a[g.status] = (a[g.status] ?? 0) + 1), a), {}),
    byCategory: gaps.reduce((a, g) => ((a[g.category] = (a[g.category] ?? 0) + 1), a), {}),
    byKind: gaps.reduce((a, g) => ((a[g.kind] = (a[g.kind] ?? 0) + 1), a), {}),
  };
}

const isMain = !!process.argv[1] && process.argv[1].endsWith('assets.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const host = argv.find(a => !a.startsWith('--'));
  const maxIdx = argv.indexOf('--max');
  const MAX = maxIdx > -1 ? Number(argv[maxIdx + 1]) : 60;
  if (!host) { console.error('usage: node src/audit/assets.mjs <host> [--max 60]'); process.exit(2); }
  const BASE = join(WORKSPACE, host);
  const PAGES = join(BASE, 'pages');
  if (!existsSync(PAGES)) { console.error('no pages for host:', host); process.exit(1); }
  const pages = readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'clone', 'index.html'))).slice(0, MAX);
  const results = pages.map(p => scanPage(join(PAGES, p), { origin: 'https://' + host }));
  const totals = results.reduce((a, r) => ({
    refs: a.refs + r.refs, localized: a.localized + r.localized, gaps: a.gaps + r.gaps.length,
    origin: a.origin + (r.byStatus['remote-origin'] ?? 0), third: a.third + (r.byStatus['remote-third-party'] ?? 0),
    visual: a.visual + r.visualGaps, visualOrigin: a.visualOrigin + r.visualOrigin, visualThird: a.visualThird + r.visualThird,
  }), { refs: 0, localized: 0, gaps: 0, origin: 0, third: 0, visual: 0, visualOrigin: 0, visualThird: 0 });
  const report = {
    host, generatedAt: new Date().toISOString(),
    summary: { pages: results.length, ...totals, localizationRate: totals.refs ? +(totals.localized / totals.refs).toFixed(4) : null },
    pages: results,
  };
  const outDir = join(BASE, 'audit');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'asset-gaps.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'asset-gaps.html'), renderAssetGapsHtml(report));
  console.log(`[assets] pages=${results.length} refs=${totals.refs} localized=${totals.localized} (${((report.summary.localizationRate ?? 0) * 100).toFixed(1)}%) | 视觉缺口 ${totals.visual}（原站 ${totals.visualOrigin} / 第三方 ${totals.visualThird}）| 元数据/追踪/设计替代 ${totals.gaps - totals.visual}`);
  console.log('[assets] report ->', join(outDir, 'asset-gaps.html'));
  for (const w of [...results].sort((a, b) => b.visualGaps - a.visualGaps || b.gaps.length - a.gaps.length).slice(0, 10)) {
    console.log('  ' + w.page.padEnd(34), 'visual=' + String(w.visualGaps).padStart(3), 'origin=' + String(w.visualOrigin).padStart(3), 'third=' + String(w.visualThird).padStart(3), 'all=' + w.gaps.length);
  }
  process.stdout.write('@@EVENT@@' + JSON.stringify({ kind: 'asset-gaps-done', host, pages: results.length, localizationRate: report.summary.localizationRate, visualGaps: totals.visual, visualOrigin: totals.visualOrigin, visualThird: totals.visualThird }) + '\n');
}
