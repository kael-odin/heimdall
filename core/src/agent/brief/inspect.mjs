/**
 * agent/brief/inspect — 在镜像页里运行的测量函数（page.evaluate 的参数，必须自包含、可序列化）
 *
 *   planSections   分段计划（E6-03，PRD 05 §2.2）：从 body 往下，只在「太高」「单子容器包裹」「body / main」时下钻，
 *                  且只在子元素纵向堆叠时下钻（左右分栏的高块不拆）；fixed / sticky 单列为叠放层；
 *                  矮于 minH 的碎块并进前一段。每段一个 DOM 锚点路径，ID 由调用方按路径算（跨重新生成稳定）。
 *   measureAnchors 按锚点路径在当前视口量外接框（小数保留两位）。
 *   sectionDetail  单段详情（E6-04）：元素清单（三视口外接框由调用方拼）、计算样式、伪元素样式、
 *                  写死与撑开的高度、外层画进来的装饰、命中的 CSS 规则、资产引用。
 *                  Phase 0 S2 里四次 Opus 运行都先写脚本量参考图来补这些事实，这里直接给。
 *   fontFaces      页面实际声明的 @font-face。
 *
 * 文本在这里只做截断，清理与围栏由调用方统一做（fence.mjs）。
 */

/* eslint-disable no-undef */

export const STYLE_PROPS = ['display', 'position', 'top', 'left', 'right', 'bottom', 'zIndex', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'gap',
  'gridTemplateColumns', 'gridTemplateRows', 'width', 'height', 'maxWidth', 'minHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign',
  'textTransform', 'textDecorationLine', 'whiteSpace', 'color', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
  'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'boxShadow', 'opacity', 'overflow', 'objectFit', 'objectPosition', 'transform', 'boxSizing'];

export const PSEUDO_PROPS = ['content', 'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'backgroundColor', 'backgroundImage',
  'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'transform', 'opacity', 'color', 'fontSize'];

/** 规划分段（在 1440 下运行） */
export const planSections = ({ minH = 48, maxH = 1200, maxDepth = 12 }) => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR']);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const same = [...n.parentElement.children].filter(c => c.tagName === n.tagName);
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n) + 1})`);
    }
    return ['body', ...parts].join(' > ');
  };
  const kids = (el) => [...el.children].filter(c => !SKIP.has(c.tagName) && visible(c));
  // 纵向堆叠判定只看「在文档流里」的子元素：fixed / sticky 是叠放层，absolute 的页头压在首屏上，
  // 都不该让父元素被当成「左右分栏、不能拆」（thordata.com 首页的 header 就是 absolute，叠在 hero 上）
  const inFlow = (c) => { const p = getComputedStyle(c).position; return p !== 'fixed' && p !== 'sticky' && p !== 'absolute'; };
  const stacked = (list) => {
    const bs = list.filter(inFlow).map(box).sort((a, b) => a.y - b.y);
    for (let i = 1; i < bs.length; i++) {
      const ov = Math.min(bs[i - 1].y + bs[i - 1].h, bs[i].y + bs[i].h) - Math.max(bs[i - 1].y, bs[i].y);
      if (ov > 0.5 * Math.min(bs[i - 1].h, bs[i].h)) return false;
    }
    return true;
  };
  const docTop = 0, docBottom = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const roleOf = (el, index) => {
    const tag = el.tagName.toLowerCase(), role = el.getAttribute('role') ?? '';
    const hint = `${el.id} ${el.className && typeof el.className === 'string' ? el.className : ''}`.toLowerCase();
    const b = box(el);
    // header / footer 标签只有在页面顶端 / 底端时才是页头页脚；段内的 <header> 是这一段的标题区
    if (role === 'banner' || (tag === 'header' && b.y - docTop < 200)) return 'header';
    if (role === 'contentinfo' || (tag === 'footer' && docBottom - (b.y + b.h) < 200)) return 'footer';
    if (tag === 'nav' || role === 'navigation') return 'nav';
    if (tag === 'aside' || role === 'complementary') return 'aside';
    if (/\bfaq\b|faq[-_]/.test(hint)) return 'faq';
    if (/pricing|price|plans?\b/.test(hint)) return 'pricing';
    if (/\bhero\b|hero[-_]|masthead|jumbotron/.test(hint) || (index <= 2 && el.querySelector('h1'))) return 'hero';
    if (/feature/.test(hint)) return 'features';
    if (/\bcta\b|cta[-_]|call-to-action/.test(hint)) return 'cta';
    return 'content';
  };
  const picked = [];
  const visit = (el, depth) => {
    const cs = getComputedStyle(el);
    if (el !== document.body && (cs.position === 'fixed' || cs.position === 'sticky')) { picked.push({ el, overlay: true }); return; }
    // absolute 的块叠在别的段上（页头压在首屏、装饰背景层）：单列为 layered，不下钻，不计入覆盖与重叠
    if (el !== document.body && cs.position === 'absolute') { picked.push({ el, overlay: false, layered: true }); return; }
    const b = box(el);
    const ks = kids(el);
    const flowKids = ks.filter(inFlow);
    // 包装层：body / main，或只有一个流内子元素、且它几乎占满自己（#app > div 这类框架外壳）
    const wrapper = el === document.body || el.tagName === 'MAIN' || (flowKids.length === 1 && box(flowKids[0]).h >= 0.9 * b.h);
    if (depth < maxDepth && ks.length && (wrapper || b.h > maxH) && stacked(ks)) { for (const k of ks) visit(k, depth + 1); return; }
    picked.push({ el, overlay: false });
  };
  visit(document.body, 0);
  // 碎块（矮于 minH、非叠放层）并进紧挨着的前一段；不挨着的碎块（追踪像素、定位到别处的小块）
  // 若几乎没有面积就丢掉，否则自成一段。apify.com/about 曾把一个 absolute 的 1px 元素并进页脚，
  // 页脚的外接框于是从 y=0 拉到页底，和每一段都重叠
  const groups = [];
  const lastBox = () => { const g = groups[groups.length - 1]; const bs = g.els.map(box); const y0 = Math.min(...bs.map(b => b.y)); return { y: y0, h: Math.max(...bs.map(b => b.y + b.h)) - y0 }; };
  const layeredDecor = [];
  for (const p of picked) {
    const b = box(p.el);
    // 几乎没有内容的 absolute 层（装饰背景、渐变遮罩）归到它压着的那一段，不单列
    if (p.layered && p.el.querySelectorAll('*').length < 3) { layeredDecor.push(p.el); continue; }
    if (!p.overlay && !p.layered && b.h < minH) {
      if (groups.length && !groups[groups.length - 1].overlay && !groups[groups.length - 1].layered) {
        const prev = lastBox();
        if (b.y >= prev.y - 4 && b.y <= prev.y + prev.h + 40) { groups[groups.length - 1].els.push(p.el); continue; }
      }
      if (b.w * b.h < 2000) continue;
    }
    groups.push({ els: [p.el], overlay: p.overlay, layered: !!p.layered });
  }
  if (groups.length > 1 && !groups[0].overlay && !groups[0].layered && box(groups[0].els[0]).h < minH) { groups[1].els.unshift(...groups[0].els); groups.shift(); }
  for (const el of layeredDecor) {
    const b = box(el);
    let best = null, bestArea = 0;
    for (const g of groups) {
      if (g.overlay || g.layered) continue;
      for (const gb of g.els.map(box)) {
        const w = Math.min(b.x + b.w, gb.x + gb.w) - Math.max(b.x, gb.x), h = Math.min(b.y + b.h, gb.y + gb.h) - Math.max(b.y, gb.y);
        if (w > 0 && h > 0 && w * h > bestArea) { bestArea = w * h; best = g; }
      }
    }
    if (best) best.els.push(el);
  }
  const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  // 段与段之间的空隙里有没有「不属于任何一段」的可见内容：没有就是父容器的内边距 / 间距（要复刻，但不算漏掉），
  // 有就是真的没覆盖到（覆盖检查据此判断，E6-03）
  const roots = groups.flatMap(g => g.els);
  const unionBox = (els) => { const bs = els.map(box); const y0 = Math.min(...bs.map(b => b.y)); return { y: y0, bottom: Math.max(...bs.map(b => b.y + b.h)) }; };
  const flowBoxes = groups.filter(g => !g.overlay).map(g => unionBox(g.els)).sort((a, b) => a.y - b.y);
  const gaps = [];
  let cursor = 0;
  for (const b of [...flowBoxes, { y: docH, bottom: docH }]) {
    if (b.y - cursor >= 2) gaps.push({ y: cursor, h: b.y - cursor });
    cursor = Math.max(cursor, b.bottom);
  }
  const leaves = [...document.body.querySelectorAll('img, svg, video, canvas, input, button, p, h1, h2, h3, h4, h5, h6, li, a, span')]
    .filter(el => visible(el) && !roots.some(r => r.contains(el)) && !el.closest('svg:not(:scope)'));
  for (const g of gaps) {
    g.content = leaves.filter(el => { const b = box(el); const cy = b.y + b.h / 2; return cy > g.y && cy < g.y + g.h && b.w > 2 && b.h > 2; }).length;
  }
  const opaque = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
  const bodyBg = getComputedStyle(document.body).backgroundColor, htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  return {
    docH, docW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    pageBg: opaque(bodyBg) ? bodyBg : opaque(htmlBg) ? htmlBg : 'rgb(255, 255, 255)',
    gaps,
    sections: groups.map((g, i) => ({
      role: g.overlay ? 'overlay' : roleOf(g.els[0], i),
      overlay: g.overlay,
      layered: g.layered,
      anchors: g.els.map(pathOf),
      tag: g.els[0].tagName.toLowerCase(),
      elementCount: g.els.reduce((s, e) => s + e.querySelectorAll('*').length + 1, 0),
    })),
  };
};

/** 按锚点路径量外接框；多个锚点取并集；找不到或不可见返回 null */
export const measureAnchors = (anchorLists) => {
  const r2 = (v) => Math.round(v * 100) / 100;
  return anchorLists.map((anchors) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, found = 0;
    for (const a of anchors) {
      let el = null;
      try { el = document.querySelector(a); } catch {}
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || cs.display === 'none' || cs.visibility === 'hidden') continue;
      found++;
      x0 = Math.min(x0, r.left + scrollX); y0 = Math.min(y0, r.top + scrollY);
      x1 = Math.max(x1, r.right + scrollX); y1 = Math.max(y1, r.bottom + scrollY);
    }
    return found ? { x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0) } : null;
  });
};

/**
 * 单段详情。opts: { anchors, props, pseudoProps, withStyle, withRules, maxElements, maxText }
 * 返回元素按 DOM 顺序编号 e0…（与 compare 修复包里的 ref 一致）。
 */
export const sectionDetail = (opts) => {
  const { anchors, props, pseudoProps, withStyle = true, withRules = false, maxElements = 600, maxText = 600 } = opts;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);
  const roots = anchors.map(a => { try { return document.querySelector(a); } catch { return null; } }).filter(Boolean);
  if (!roots.length) return null;
  const r2 = (v) => Math.round(v * 100) / 100;
  const els = [];
  for (const root of roots) {
    els.push(root);
    for (const el of root.querySelectorAll('*')) {
      if (SKIP.has(el.tagName)) continue;
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      els.push(el);
    }
  }
  const truncated = els.length > maxElements;
  const list = els.slice(0, maxElements);
  const index = new Map(list.map((el, i) => [el, i]));
  const isVisible = (el, r, cs) => r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse'
    && Number(cs.opacity) > 0 && el.getAttribute('aria-hidden') !== 'true';
  const items = list.map((el, i) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const visible = isVisible(el, r, cs);
    let depth = 0;
    for (let p = el; p && !roots.includes(p); p = p.parentElement) depth++;
    const item = {
      i, tag: el.tagName.toLowerCase(), depth, visible,
      box: visible ? { x: r2(r.left + scrollX), y: r2(r.top + scrollY), w: r2(r.width), h: r2(r.height) } : null,
      parent: el.parentElement && index.has(el.parentElement) ? index.get(el.parentElement) : null,
    };
    if (!withStyle) {
      // 轻量模式（compare 的元素索引）：只要「是不是文字 / 图像」与资源引用，不要计算样式
      if (visible) {
        const direct = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (direct.length >= 2) { item.textual = true; item.text = direct.slice(0, 40); }
        const bgs = [...cs.backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)].map(m => m[1]);
        if (['img', 'svg', 'picture', 'video', 'canvas'].includes(item.tag) || bgs.length) item.img = true;
        if (el.tagName === 'IMG' && (el.currentSrc || el.src)) item.src = el.currentSrc || el.src;
        if (bgs.length) item.bg = bgs;
        if (el.tagName === 'IMG') item.natural = { w: el.naturalWidth, h: el.naturalHeight };
      }
      return item;
    }
    item.cls = [...(el.classList ?? [])].slice(0, 3).map(c => c.slice(0, 40)).join('.');
    if (el.id) item.id = el.id.slice(0, 60);
    if (visible) {
      const direct = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (direct) { item.text = direct.slice(0, maxText); if (direct.length > maxText) item.textTruncated = direct.length; }
    }
    item.attrs = Object.fromEntries(['href', 'alt', 'aria-label', 'role', 'type', 'placeholder', 'name', 'value', 'title'].filter(a => el.hasAttribute(a))
      .map(a => [a, String(el.getAttribute(a)).slice(0, 120)]));
    if (el.tagName === 'IMG') item.src = el.currentSrc || el.src;
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') item.natural = { w: el.naturalWidth ?? el.videoWidth ?? 0, h: el.naturalHeight ?? el.videoHeight ?? 0 };
    if (el.tagName.toLowerCase() === 'svg') item.svg = el.outerHTML.slice(0, 20000);
    const bgs = [...cs.backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)].map(m => m[1]);
    if (bgs.length) item.bg = bgs;
    item.style = Object.fromEntries(props.map(p => [p, cs[p]]));
    for (const which of ['::before', '::after']) {
      const ps = getComputedStyle(el, which);
      if (ps.content && ps.content !== 'none' && ps.content !== 'normal') {
        item[which === '::before' ? 'before' : 'after'] = Object.fromEntries(pseudoProps.map(p => [p, String(ps[p]).slice(0, 200)]));
      }
    }
    // 写死还是撑开：临时把高度放开再量，变了就是被 CSS 定住的（S2：770 写死、内容自然高 770.78）
    if (visible && cs.display !== 'inline' && cs.display !== 'contents') {
      const saved = el.getAttribute('style');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('min-height', '0', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      const natural = el.getBoundingClientRect().height;
      if (saved === null) el.removeAttribute('style'); else el.setAttribute('style', saved);
      if (Math.abs(natural - r.height) > 0.5) item.heightMode = { mode: 'fixed', natural: r2(natural) };
    }
    return item;
  });
  // 外层画进来的装饰：祖先的边框、阴影、背景，伪元素；与分段重叠的绝对定位兄弟
  const root = roots[0];
  const rb = root.getBoundingClientRect();
  const outer = [];
  let depth = 0;
  for (let p = root.parentElement; p && p !== document.documentElement && outer.length < 12; p = p.parentElement) {
    depth++;
    const cs = getComputedStyle(p), r = p.getBoundingClientRect();
    const entry = { level: depth, tag: p.tagName.toLowerCase(), box: { x: r2(r.left + scrollX), y: r2(r.top + scrollY), w: r2(r.width), h: r2(r.height) } };
    let notable = false;
    const borders = {};
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') { borders[side.toLowerCase()] = cs[`border${side}`]; notable = true; }
    }
    if (Object.keys(borders).length) entry.borders = borders;
    if (cs.boxShadow !== 'none') { entry.boxShadow = cs.boxShadow; notable = true; }
    if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') { entry.backgroundColor = cs.backgroundColor; notable = true; }
    if (cs.backgroundImage !== 'none') { entry.backgroundImage = cs.backgroundImage.slice(0, 200); notable = true; }
    for (const which of ['::before', '::after']) {
      const ps = getComputedStyle(p, which);
      if (ps.content && ps.content !== 'none' && ps.content !== 'normal') {
        entry[which === '::before' ? 'before' : 'after'] = Object.fromEntries(pseudoProps.map(k => [k, String(ps[k]).slice(0, 200)]));
        notable = true;
      }
    }
    if (notable) outer.push(entry);
    if (p === document.body) break;
  }
  const siblings = [];
  for (const s of root.parentElement ? [...root.parentElement.children] : []) {
    if (s === root || roots.includes(s)) continue;
    const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
    const ov = Math.min(r.bottom, rb.bottom) - Math.max(r.top, rb.top);
    if (ov > 0 && r.width > 0 && r.height > 0) {
      siblings.push({ tag: s.tagName.toLowerCase(), position: cs.position, box: { x: r2(r.left + scrollX), y: r2(r.top + scrollY), w: r2(r.width), h: r2(r.height) },
        backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage.slice(0, 200), zIndex: cs.zIndex });
    }
    if (siblings.length >= 6) break;
  }
  // 起点的亚像素偏移：取整后的外接框藏住了 0.1–0.6px（S2）
  const offset = { x: r2(rb.left + scrollX - Math.round(rb.left + scrollX)), y: r2(rb.top + scrollY - Math.round(rb.top + scrollY)) };
  // 命中的 CSS 规则（faithful 档直接复用）：选择器命中段内任一元素的样式规则，含所在的 @media
  let rules;
  if (withRules) {
    rules = [];
    let budget = 400;
    const visitRules = (ruleList, media) => {
      for (const rule of ruleList) {
        if (budget <= 0) return;
        if (rule.type === CSSRule.MEDIA_RULE) { visitRules(rule.cssRules, rule.conditionText ?? rule.media?.mediaText); continue; }
        if (rule.type === CSSRule.SUPPORTS_RULE) { visitRules(rule.cssRules, media); continue; }
        if (rule.type !== CSSRule.STYLE_RULE) continue;
        let hit = false;
        try { hit = list.some(el => el.matches(rule.selectorText)); } catch { hit = false; }
        if (!hit) continue;
        rules.push({ selector: rule.selectorText.slice(0, 300), ...(media ? { media } : {}), declarations: rule.style.cssText.slice(0, 2000) });
        budget--;
      }
    };
    for (const sheet of document.styleSheets) {
      let rl;
      try { rl = sheet.cssRules; } catch { continue; }
      visitRules(rl, null);
    }
  }
  const rcs = getComputedStyle(root);
  let effectiveBg = 'rgb(255, 255, 255)';
  for (let p = root.parentElement; p; p = p.parentElement) {
    const c = getComputedStyle(p).backgroundColor;
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { effectiveBg = c; break; }
  }
  return {
    items, truncated, total: els.length, outer, siblings, offset, rules, effectiveBg,
    rootMargin: [rcs.marginTop, rcs.marginRight, rcs.marginBottom, rcs.marginLeft].join(' '),
    rootBox: { x: r2(rb.left + scrollX), y: r2(rb.top + scrollY), w: r2(rb.width), h: r2(rb.height) },
  };
};

/** 页面声明的 @font-face（读得到的样式表） */
export const fontFaces = () => {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rl;
    try { rl = sheet.cssRules; } catch { continue; }
    for (const rule of rl) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const s = rule.style;
      const urls = [...String(s.getPropertyValue('src')).matchAll(/url\("?([^")]+)"?\)/g)].map(m => new URL(m[1], sheet.href || location.href).href);
      out.push({ family: s.getPropertyValue('font-family').replace(/^["']|["']$/g, ''), weight: s.getPropertyValue('font-weight') || '400',
        style: s.getPropertyValue('font-style') || 'normal', urls, unicodeRange: s.getPropertyValue('unicode-range') || undefined });
    }
  }
  const loaded = [...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family.replace(/^["']|["']$/g, '')}|${f.weight}|${f.style}`);
  return { faces: out, loaded: [...new Set(loaded)] };
};
