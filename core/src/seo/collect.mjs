/**
 * seo/collect — 页面 SEO 信号采集（Playwright）
 *
 * 采集维度：状态/重定向、title/description、标题层级、图片、链接、
 * 结构化数据、OG/Twitter、hreflang、性能（FCP/LCP/CLS + 资源体积）、安全头。
 *
 * 与 clone 捕获不同：这里只读信号，不写资产，不修改页面。
 */
import { chromium } from 'playwright';
import { analyzeRawHtml } from './raw-html.mjs';
import { isStructuralUrl } from './pagination.mjs';
import { restoreSessionStorage, sessionContext } from '../session/store.mjs';
import { canonUrl, isSameOriginUrl } from '../url-canon.mjs';
import { UA } from '../ua.mjs';
import { discoverSitemapUrls } from '../crawler/sitemap-discovery.mjs';

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const ROBOTS_VALUE_DIRECTIVES = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

/** Restriction evidence for Google web search; other crawler-specific rules stay out of this verdict. */
function googleRobotsEvidence(tags, headers, raw) {
  const evidence = { target: 'googlebot', initialHtml: raw?.source === 'navigation' ? 'checked' : 'unavailable', noindex: [], nofollow: [] };
  const apply = (scope, value, source) => {
    if (scope !== 'robots' && scope !== 'googlebot') return;
    for (const part of value.split(',')) {
      const directive = part.trim().toLowerCase();
      if (!directive || directive.includes(':')) continue;
      for (const token of directive.split(/\s+/)) {
        const match = `${source} [${scope}: ${token}]`;
        if (token === 'none' || token === 'noindex') evidence.noindex.push(match);
        if (token === 'none' || token === 'nofollow') evidence.nofollow.push(match);
      }
    }
  };

  for (const { name, content } of tags) {
    apply(name, content, `meta name="${name}" content="${content.slice(0, 200)}"`);
  }
  if (raw?.source === 'navigation') {
    for (const { name, content } of raw.robotsTags ?? []) {
      apply(name, content, `initial HTML meta name="${name}" content="${content.slice(0, 200)}"`);
    }
  }
  for (const header of headers) {
    let scope = 'robots';
    const source = `X-Robots-Tag: ${header.slice(0, 200)}`;
    for (const part of header.split(',')) {
      let value = part.trim();
      const prefix = value.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i);
      if (prefix) {
        const name = prefix[1].toLowerCase();
        if (ROBOTS_VALUE_DIRECTIVES.has(name)) continue;
        scope = name;
        value = prefix[2];
      }
      apply(scope, value, source);
    }
  }
  evidence.noindex = [...new Set(evidence.noindex)];
  evidence.nofollow = [...new Set(evidence.nofollow)];
  return evidence;
}

const VITALS_INIT = `
window.__heimdallVitals = { lcp: null, cls: 0, fcp: null };
try {
  new PerformanceObserver(list => { const e = list.getEntries(); if (e.length) window.__heimdallVitals.lcp = e[e.length - 1].startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__heimdallVitals.cls += entry.value; })
    .observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') window.__heimdallVitals.fcp = entry.startTime; })
    .observe({ type: 'paint', buffered: true });
} catch {}
`;

/** robots.txt + sitemap 探测（Node fetch，不经过浏览器） */
export async function fetchRobotsAndSitemaps(origin, options = {}) {
  const result = await discoverSitemapUrls(origin, options);
  return { ...result, sitemapUrls: new Set(result.urls) };
}

/** 目标 URL 解析：优先 sitemap，其次轻量 BFS 爬取 */
export async function discoverTargets(browser, origin, { max = 30, sitemapUrls = new Set() } = {}) {
  const targets = [];
  const seen = new Set();
  const push = (url, depth = 99) => {
    const clean = canonUrl(url);
    if (!isSameOriginUrl(clean, origin) || seen.has(clean)) return;
    if (/\.(pdf|zip|png|jpe?g|svg|webp|avif|mp4|mp3|xml|json|txt|ico|woff2?)$/i.test(new URL(clean).pathname)) return;
    seen.add(clean);
    targets.push({ url: clean, depth });
  };
  for (const u of sitemapUrls) { if (targets.length >= max) break; push(u); }

  if (targets.length === 0) {
    const ctx = await browser.newContext({ viewport: DEFAULT_VIEWPORT, userAgent: UA, ...sessionContext(new URL(origin).hostname) });
    await restoreSessionStorage(ctx, new URL(origin).hostname);
    const page = await ctx.newPage();
    const queue = [{ url: origin + '/', depth: 0 }];
    const visited = new Set();
    while (queue.length && targets.length < max) {
      const job = queue.shift();
      if (visited.has(job.url)) continue;
      visited.add(job.url);
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(300);
        push(job.url, job.depth);
        if (job.depth >= 2) continue;
        const links = await page.evaluate((o) =>
          [...document.querySelectorAll('a[href]')]
            .map(a => { try { return new URL(a.getAttribute('href'), location.href).href.split('#')[0]; } catch { return null; } })
            .filter(u => {
              try { return new URL(u).origin === o; } catch { return false; }
            }), origin);
        // 结构性 URL（分页/分面）优先入队：它们通常排在页尾，按 DOM 顺序会被配额挤掉，
        // 而这类页面正是审计最该覆盖的
        const uniq = [...new Set(links)].sort((a, b) => (isStructuralUrl(b) ? 1 : 0) - (isStructuralUrl(a) ? 1 : 0));
        for (const u of uniq) queue.push({ url: u, depth: job.depth + 1 });
      } catch {}
    }
    await ctx.close();
  }
  return targets.slice(0, max);
}

/** 单页采集 */
export async function collectPage(browser, url, { timeout = 45_000, settleMs = 1500 } = {}) {
  const ctx = await browser.newContext({ viewport: DEFAULT_VIEWPORT, userAgent: UA, ignoreHTTPSErrors: true, ...sessionContext(new URL(url).hostname) });
  await restoreSessionStorage(ctx, new URL(url).hostname);
  const page = await ctx.newPage();
  await page.addInitScript(VITALS_INIT);
  const started = Date.now();
  let response = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(settleMs);

    const headers = response ? response.headers() : {};
    let robotsHeaders = headers['x-robots-tag'] ? [headers['x-robots-tag']] : [];
    try {
      const values = (await response?.headersArray() ?? [])
        .filter(h => h.name.toLowerCase() === 'x-robots-tag')
        .map(h => h.value);
      if (values.length) robotsHeaders = values;
    } catch { /* Keep the combined header when individual values are unavailable. */ }
    const finalUrl = page.url();
    const status = response ? response.status() : 0;
    let redirectCount = 0;
    try { let req = response?.request(); while (req?.redirectedFrom?.()) { redirectCount++; req = req.redirectedFrom(); } } catch {}

    // Prefer the actual navigation response: a later fetch may see changed cookies or content.
    let raw = null;
    let rawTimer;
    try {
      if (response && response.url().split('#')[0] === finalUrl.split('#')[0]) {
        const html = await Promise.race([
          response.text(),
          new Promise(resolve => { rawTimer = setTimeout(() => resolve(null), 2000); }),
        ]);
        if (html) raw = { ...analyzeRawHtml(html), source: 'navigation' };
      }
    } catch { /* Some browser navigations no longer expose their response body. */ }
    finally { clearTimeout(rawTimer); }
    try {
      const r = raw?.ok ? null : await page.evaluate(async (u) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 20_000);
        try {
          const res = await fetch(u, { signal: ac.signal, credentials: 'same-origin', cache: 'no-store' });
          return { status: res.status, html: await res.text() };
        } catch (e) { return { status: 0, html: '', error: String(e).slice(0, 120) }; }
        finally { clearTimeout(timer); }
      }, finalUrl).catch(() => null);
      if (r?.html) raw = { ...analyzeRawHtml(r.html), source: 'refetch' };
    } catch { /* 取不到就不做对照，不算失败 */ }

    const dom = await page.evaluate(() => {
      // 空值必须保持为空：new URL('', base) 会解析成页面自身地址，
      // 于是没有 canonical / og:image 的页面看上去"都有"，对应的缺失类规则永远不会触发。
      const abs = (u) => { if (!u || !String(u).trim()) return ''; try { return new URL(u, location.href).href; } catch { return u; } };
      const meta = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) ?? '';
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const headings = [];
      document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => headings.push({ level: +h.tagName[1], text: h.innerText.replace(/\s+/g, ' ').trim().slice(0, 120) }));
      let skips = 0, prev = 0;
      for (const h of headings) { if (prev && h.level > prev + 1) skips++; prev = h.level; }
      const imgs = [...document.querySelectorAll('img')];
      const imgStats = {
        total: imgs.length,
        missingAlt: imgs.filter(i => !i.hasAttribute('alt')).length,
        emptyAlt: imgs.filter(i => i.hasAttribute('alt') && !i.getAttribute('alt').trim()).length,
        // 只统计"有实际渲染尺寸"的坏图：排除 0x0/1x1 追踪像素与 data URI（避免误报）
        broken: imgs.filter(i => {
          if (!i.complete || i.naturalWidth !== 0) return false;
          if (!(i.getAttribute('src') || i.getAttribute('srcset'))) return false;
          const src = i.currentSrc || i.src || '';
          if (src.startsWith('data:')) return false;
          const rect = i.getBoundingClientRect();
          return rect.width > 4 || rect.height > 4 || i.width > 4 || i.height > 4;
        }).length,
        legacy: imgs.filter(i => /\.(jpe?g|png)(\?|$)/i.test(i.currentSrc || i.src || '')).length,
        lazy: imgs.filter(i => i.loading === 'lazy').length,
      };
      const anchors = [...document.querySelectorAll('a[href]')];
      const internalHrefs = [], externalHrefs = [];
      let emptyAnchor = 0, hashOnly = 0, nofollowExternal = 0;
      for (const a of anchors) {
        const raw = a.getAttribute('href') ?? '';
        const href = abs(raw);
        const label = (a.innerText || '').trim() || a.getAttribute('aria-label') || (a.querySelector('img') ? '[img]' : '');
        if (!label) emptyAnchor++;
        if (raw.startsWith('#')) { hashOnly++; continue; }
        try {
          const u = new URL(href);
          if (u.origin === location.origin) internalHrefs.push(href.split('#')[0]);
          else {
            externalHrefs.push(href);
            if ((a.rel || '').toLowerCase().includes('nofollow')) nofollowExternal++;
          }
        } catch {}
      }
      // 结构化数据：除了 @type，还要把**实体本身**带回去做字段级校验
      // （只判断「有没有 Product 这个词」是不够的 —— 决定能否出富结果的是 name/image/offers）。
      // 对象可能很大（商品目录），所以按白名单裁剪并限制深度与条数。
      const LD_KEYS = new Set(['@context', '@type', '@id', '@graph', 'name', 'headline', 'description', 'title',
        'image', 'logo', 'url', 'datePublished', 'dateModified', 'datePosted', 'uploadDate', 'startDate', 'endDate',
        'author', 'publisher', 'provider', 'offers', 'aggregateRating', 'review', 'reviewRating', 'itemReviewed',
        'itemListElement', 'mainEntity', 'acceptedAnswer', 'address', 'telephone', 'priceRange', 'location',
        'thumbnailUrl', 'contentUrl', 'price', 'priceCurrency', 'availability', 'brand', 'sku', 'position', 'item',
        'mainEntityOfPage', 'sameAs', 'hiringOrganization', 'ratingValue', 'ratingCount', 'reviewCount', 'step']);
      const pickLd = (v, depth = 0) => {
        if (depth > 3 || v == null) return v == null ? v : undefined;
        if (Array.isArray(v)) return v.slice(0, 20).map(x => pickLd(x, depth + 1)).filter(x => x !== undefined);
        if (typeof v === 'object') {
          const o = {};
          for (const k of Object.keys(v)) if (LD_KEYS.has(k)) { const p = pickLd(v[k], depth + 1); if (p !== undefined) o[k] = p; }
          return o;
        }
        return typeof v === 'string' ? v.slice(0, 200) : v;
      };
      const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => {
        try {
          const data = JSON.parse(s.textContent);
          const arr = Array.isArray(data) ? data : [data];
          const types = arr.flatMap(x => [].concat(x?.['@type'] ?? [])).filter(Boolean);
          return { ok: true, types, items: arr.slice(0, 12).map(x => pickLd(x)).filter(Boolean) };
        } catch (e) { return { ok: false, types: [], items: [], error: String(e).slice(0, 120) }; }
      });
      // 「加载更多 / 下一页」这类按钮：分页如果用 JS 做，爬虫拿不到下一页的 URL ——
      // 这是列表页最常见也最容易被忽略的问题，而它在 HTML 里只留下一个可点的按钮。
      // 只认强特征文案（"更多" 单独出现太容易误判成导航菜单，不收）。
      const JS_PAGE_LABEL = /^(older\s*posts?|newer\s*posts?|next\s*(page|posts?)?|prev(ious)?(\s*(page|posts?))?|load\s*more|show\s*more|下一页|上一页|加载更多|显示更多)$/i;
      const jsPagination = [...document.querySelectorAll('button,[role="button"],a[role="button"]')]
        .filter(el => !(el.tagName === 'A' && el.hasAttribute('href')))
        .map(el => (el.innerText || el.getAttribute('aria-label') || '').trim())
        .filter(t => JS_PAGE_LABEL.test(t))
        .slice(0, 5);
      // rawHref 保留标签上写的原值：href 已被绝对化，规则要判"是否写成了相对地址"只能看原值。
      const hreflang = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(l => ({ lang: l.getAttribute('hreflang'), href: abs(l.getAttribute('href')), rawHref: l.getAttribute('href') }));
      const res = performance.getEntriesByType('resource').map(r => ({ name: r.name, initiator: r.initiatorType, transfer: r.transferSize || 0, encoded: r.encodedBodySize || 0 }));
      const nav = performance.getEntriesByType('navigation')[0];
      const sum = (pred) => res.filter(pred).reduce((a, r) => a + Math.max(r.transfer, r.encoded), 0);
      const renderBlocking = [...document.querySelectorAll('head link[rel="stylesheet"]')].length
        + [...document.querySelectorAll('head script[src]')].filter(s => !s.async && !s.defer).length;
      const robotsTags = [...document.querySelectorAll('meta[name]')]
        .map(el => ({ name: (el.getAttribute('name') || '').trim().toLowerCase(), content: el.getAttribute('content') || '' }))
        .filter(el => el.name === 'robots' || el.name === 'googlebot');
      const robotsMeta = robotsTags.filter(el => el.name === 'robots').map(el => el.content.toLowerCase()).join(', ');
      // 内容指纹（FNV-1a）：用于变更监控判断"正文是否变化"
      const normText = text.toLowerCase().slice(0, 200000);
      let th = 0x811c9dc5;
      for (let i = 0; i < normText.length; i++) { th ^= normText.charCodeAt(i); th = (th * 0x01000193) >>> 0; }
      return {
        textHash: th.toString(16).padStart(8, '0'),
        textSample: normText.slice(0, 200),
        title: (document.title || '').trim(),
        description: meta('meta[name="description"]').trim(),
        canonical: abs(meta('link[rel="canonical"]', 'href')),
        robotsMeta, robotsTags,
        lang: document.documentElement.lang || '',
        viewport: meta('meta[name="viewport"]'),
        h1: headings.filter(h => h.level === 1).map(h => h.text),
        headings,
        headingLevels: headings.map(h => h.level),
        headingSkips: skips,
        wordCount: ((text.match(/[\u4e00-\u9fff]/g) || []).length) + ((text.match(/[A-Za-z0-9]+/g) || []).length),
        textLength: text.length,
        htmlBytes: (document.documentElement.outerHTML || '').length,
        imgTotal: imgStats.total, imgMissingAlt: imgStats.missingAlt, imgEmptyAlt: imgStats.emptyAlt,
        imgBroken: imgStats.broken, imgLegacy: imgStats.legacy, imgLazy: imgStats.lazy,
        links: { total: anchors.length, internal: internalHrefs.length, external: externalHrefs.length, emptyAnchor, hashOnly, nofollowExternal },
        internalHrefs: [...new Set(internalHrefs)],
        externalSample: externalHrefs.slice(0, 20),
        jsonld, microdataCount: document.querySelectorAll('[itemscope]').length,
        og: { title: meta('meta[property="og:title"]'), description: meta('meta[property="og:description"]'), image: abs(meta('meta[property="og:image"]', 'content')), type: meta('meta[property="og:type"]') },
        twitter: { card: meta('meta[name="twitter:card"]'), title: meta('meta[name="twitter:title"]'), image: abs(meta('meta[name="twitter:image"]', 'content')) },
        hreflang,
        jsPagination,
        resources: {
          requests: res.length,
          transferBytes: res.reduce((a, r) => a + Math.max(r.transfer, r.encoded), 0),
          jsBytes: sum(r => r.initiator === 'script' || /\.m?js($|\?)/.test(r.name)),
          cssBytes: sum(r => r.initiator === 'link' || /\.css($|\?)/.test(r.name)),
          imgBytes: sum(r => r.initiator === 'img' || /\.(png|jpe?g|webp|avif|gif|svg)($|\?)/.test(r.name)),
          fontBytes: sum(r => /\.(woff2?|ttf|otf|eot)($|\?)/.test(r.name)),
          renderBlocking,
        },
        vitals: { ...(window.__heimdallVitals || { lcp: null, cls: 0, fcp: null }), domContentLoaded: nav?.domContentLoadedEventEnd ?? null, load: nav?.loadEventEnd ?? null },
        mixedContent: location.protocol === 'https:' ? res.map(r => r.name).filter(n => n.startsWith('http:')).slice(0, 10) : [],
      };
    });

    const robotsEvidence = googleRobotsEvidence(dom.robotsTags, robotsHeaders, raw);
    return {
      url,
      finalUrl,
      status,
      ok: status >= 200 && status < 400,
      redirectCount,
      responseTimeMs: Date.now() - started,
      title: dom.title, titleLength: dom.title.length,
      description: dom.description, descriptionLength: dom.description.length,
      canonical: dom.canonical,
      robotsMeta: dom.robotsMeta,
      xRobots: headers['x-robots-tag'] ?? '',
      robotsEvidence,
      meta: { noindex: robotsEvidence.noindex.length > 0, nofollow: robotsEvidence.nofollow.length > 0 },
      lang: dom.lang, viewport: dom.viewport, textHash: dom.textHash, textSample: dom.textSample,
      h1: dom.h1, headings: dom.headings, headingLevels: dom.headingLevels, headingSkips: dom.headingSkips,
      wordCount: dom.wordCount, textRatio: dom.htmlBytes ? Math.min(1, dom.textLength / dom.htmlBytes) : 0, htmlBytes: dom.htmlBytes,
      imgTotal: dom.imgTotal, imgMissingAlt: dom.imgMissingAlt, imgEmptyAlt: dom.imgEmptyAlt, imgBroken: dom.imgBroken, imgLegacy: dom.imgLegacy, imgLazy: dom.imgLazy,
      links: dom.links, internalHrefs: dom.internalHrefs, externalSample: dom.externalSample,
      jsonld: dom.jsonld, microdataCount: dom.microdataCount,
      og: dom.og, twitter: dom.twitter, hreflang: dom.hreflang, jsPagination: dom.jsPagination,
      // 服务端原始 HTML 的同名信号（未经 JS）。两者并排才能回答
      // "这个站的内容依赖不依赖 JS"。取不到时为 null，规则里要判空。
      raw,
      resources: dom.resources, vitals: dom.vitals,
      security: { https: finalUrl.startsWith('https://'), mixedContent: dom.mixedContent, headers: { hsts: headers['strict-transport-security'] ?? '', xcto: headers['x-content-type-options'] ?? '' } },
    };
  } catch (e) {
    return {
      url, finalUrl: url, status: 0, ok: false, error: String(e).slice(0, 200), redirectCount: 0, responseTimeMs: Date.now() - started,
      title: '', titleLength: 0, description: '', descriptionLength: 0, canonical: '', robotsMeta: '', xRobots: '', meta: { noindex: false, nofollow: false },
      lang: '', viewport: '', h1: [], headings: [], headingLevels: [], headingSkips: 0, wordCount: 0, textRatio: 0, htmlBytes: 0, textHash: '', textSample: '',
      imgTotal: 0, imgMissingAlt: 0, imgEmptyAlt: 0, imgBroken: 0, imgLegacy: 0, imgLazy: 0,
      links: { total: 0, internal: 0, external: 0, emptyAnchor: 0, hashOnly: 0, nofollowExternal: 0 }, internalHrefs: [], externalSample: [],
      jsonld: [], microdataCount: 0, og: {}, twitter: {}, hreflang: [], jsPagination: [], raw: null, resources: { requests: 0, transferBytes: 0, jsBytes: 0, cssBytes: 0, imgBytes: 0, fontBytes: 0, renderBlocking: 0 },
      vitals: { lcp: null, cls: 0, fcp: null }, security: { https: url.startsWith('https://'), mixedContent: [], headers: {} },
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** 站点采集：并发 2，逐页回调进度 */
export async function collectSite(origin, targets, { concurrency = 2, onProgress, browser } = {}) {
  const ownBrowser = !browser;
  const b = browser ?? await chromium.launch();
  const queue = [...targets];
  const pages = [];
  const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      if (!t) break;
      const page = await collectPage(b, t.url);
      page.depth = t.depth ?? 0;
      pages.push(page);
      onProgress?.(page, pages.length, targets.length);
    }
  });
  try { await Promise.all(workers); } finally { if (ownBrowser) await b.close(); }
  pages.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  return pages;
}
