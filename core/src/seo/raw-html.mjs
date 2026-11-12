/**
 * seo/raw-html — 解析"服务端返回、未经 JS 执行"的那份 HTML
 *
 * 为什么要单独有一份：渲染后的 DOM 会骗人。
 * 现代站点大量内容由 JS 注入 —— Vue/React 水合、客户端路由、懒渲染。
 * 用 Playwright 看到的 DOM 是**浏览器执行完脚本之后**的样子，
 * 而 Googlebot 之外的抓取者（AI 爬虫、社交预览、多数 SEO 工具的默认模式）
 * 看到的是服务端那一份。两者差多少，直接决定了内容能不能被抓到。
 *
 * 实测场景：一个 SPA 的渲染后正文 3000 字、原始 HTML 只有一句
 * "You need to enable JavaScript" —— 渲染后审计会给它满分，
 * 因为它量的是浏览器里的样子。这类站点是最需要被指出来的。
 *
 * 这里只做**结构信号的提取**，不做评分 —— 评分在 rules.mjs 里，
 * 需要与渲染后的同名信号并排比较才能下结论。
 */
import { parse } from 'parse5';

const words = new Intl.Segmenter('en', { granularity: 'word' });

// Both HTML and rendered text use the host's ICU, so script coverage cannot diverge between them.
export function countWords(text) {
  let count = 0;
  for (const segment of words.segment(text)) if (segment.isWordLike) count++;
  return count;
}

/** depth-first 遍历（parse5 默认树适配器：childNodes / tagName / attrs / value） */
function walk(node, fn) {
  fn(node);
  for (const c of node.childNodes ?? []) walk(c, fn);
}

const attr = (node, name) => (node.attrs ?? []).find(a => a.name.toLowerCase() === name)?.value ?? '';

/** 收集元素的文本（跳过 script/style） */
function textOf(node, out = []) {
  for (const c of node.childNodes ?? []) {
    if (c.nodeName === '#text') { out.push(c.value ?? ''); continue; }
    if (c.tagName === 'script' || c.tagName === 'style' || c.tagName === 'noscript') continue;
    textOf(c, out);
  }
  return out;
}

/**
 * @param {string} html 服务端返回的 HTML 原文
 * @returns 与 collect.mjs 渲染侧同名的信号，便于并排比较
 */
export function analyzeRawHtml(html) {
  const src = String(html ?? '');
  const out = {
    bytes: Buffer.byteLength(src, 'utf8'),
    codeUnits: src.length,
    ok: true,
    title: '', description: '', canonical: '', lang: '', viewport: '',
    h1Count: 0, headingCount: 0,
    imgCount: 0, imgMissingAlt: 0,
    anchorCount: 0, internalLinkCount: 0,
    jsonLdCount: 0, microdataCount: 0,
    hreflang: [], robotsTags: [],
    wordCount: 0, textLength: 0,
    scriptCount: 0, hasNoscript: false,
  };
  if (!src.trim()) return { ...out, ok: false, error: 'empty' };

  let doc;
  try { doc = parse(src); } catch (e) { return { ...out, ok: false, error: String(e).slice(0, 120) }; }

  walk(doc, (n) => {
    if (n.nodeName === '#text') return;
    const t = n.tagName;
    if (!t) return;

    if (t === 'title' && !out.title) out.title = textOf(n).join('').replace(/\s+/g, ' ').trim();
    else if (t === 'html') out.lang = attr(n, 'lang') || out.lang;
    else if (t === 'script') {
      out.scriptCount++;
      const type = (attr(n, 'type') || '').toLowerCase();
      if (type === 'application/ld+json') out.jsonLdCount++;
    } else if (t === 'noscript') out.hasNoscript = true;
    else if (t === 'h1') out.h1Count++;
    else if (/^h[1-6]$/.test(t)) out.headingCount++;
    else if (t === 'img') { out.imgCount++; if (!(n.attrs ?? []).some(a => a.name.toLowerCase() === 'alt')) out.imgMissingAlt++; }
    else if (t === 'a') {
      out.anchorCount++;
      const href = attr(n, 'href');
      if (href && !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) out.internalLinkCount++;
      else if (href && href.startsWith('/') && !href.startsWith('//')) out.internalLinkCount++;
    } else if (t === 'link') {
      const rel = (attr(n, 'rel') || '').toLowerCase();
      if (rel === 'canonical' && !out.canonical) out.canonical = attr(n, 'href');
      if (rel.split(/\s+/).includes('alternate') && attr(n, 'hreflang')) {
        out.hreflang.push({ lang: attr(n, 'hreflang'), href: attr(n, 'href') });
      }
    } else if (t === 'meta') {
      const name = (attr(n, 'name') || '').toLowerCase();
      const prop = (attr(n, 'property') || '').toLowerCase();
      const content = attr(n, 'content');
      if (name === 'description' && !out.description) out.description = content;
      else if (name === 'viewport' && !out.viewport) out.viewport = content;
      else if (name === 'robots' || name === 'googlebot') out.robotsTags.push({ name, content });
      else if (prop === 'og:title' && !out.ogTitle) out.ogTitle = content;
    }
  });

  // 可见文本 ≈ 全文去掉 script/style 后的空白规整
  const text = textOf(doc).join(' ').replace(/\s+/g, ' ').trim();
  out.textLength = text.length;
  out.wordCount = countWords(text);
  return out;
}
