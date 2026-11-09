/**
 * qa/detect — 没有参照物时也能看出问题的页面内检测
 *
 * QA 原来的探测只覆盖「跑不通」：打不开、4xx/5xx、坏链、坏图、溢出、登录过期。
 * 那些都是外部可观察的失败，但上线前漏掉最多的是「页面能跑、但看起来/用起来不对」的问题：
 * 图片没有替代文字、按钮没有可访问名、文字被裁掉、模板变量没替换、控制台白屏、
 * https 页面混着 http 资源、点击没有任何反应。这些不需要参照站，只需要页面自己。
 *
 * 约定（与 qa/findings 的证据门槛一致）：
 *   · 每条发现都带 observed（实测事实）与 target（选择器或资源地址），能复现、能定位；
 *   · 不猜、不推断：只在 DOM/计算样式/性能条目里能读到的证据上报告；
 *   · 损失写具体的人与事（读屏用户、手机用户、点这个按钮的人），不写「可能」「疑似」；
 *   · 默认只报前若干条，避免一个站点的 300 张图把报告淹掉；总数写在 evidence.count。
 *
 * 本模块在浏览器里执行（Playwright 会序列化函数体），所以不能引用模块作用域里的任何东西。
 * 元数据（DETECTOR_META）只给 Node 侧用，页面函数不读它。
 */
import { KINDS } from './findings.mjs';

export const DETECT_VERSION = 1;
export const QA_CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], input[type="reset"]';
export const QA_FORM_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';
export const QA_FORM_NAME_LIMIT = 500;

/** 检测器清单：id → 输出 kind 与说明。报告与基准都从这里取名字。 */
export const DETECTOR_META = Object.freeze({
  'a11y-image-alt': { kind: 'a11y', label: '图片缺少替代文字' },
  'a11y-control-name': { kind: 'a11y', label: '控件没有可访问名称' },
  'a11y-form-label': { kind: 'a11y', label: '表单控件没有标签' },
  'a11y-duplicate-id': { kind: 'a11y', label: '重复的 id' },
  'a11y-heading': { kind: 'a11y', label: '标题层级异常' },
  'a11y-lang': { kind: 'a11y', label: '页面缺少 lang' },
  'a11y-iframe-title': { kind: 'a11y', label: 'iframe 缺少 title' },
  'a11y-tabindex': { kind: 'a11y', label: '正向 tabindex 打乱焦点顺序' },
  'layout-text-clipped': { kind: 'layout', label: '文字被裁切' },
  'layout-image-ratio': { kind: 'layout', label: '图片被拉伸变形' },
  'layout-tap-target': { kind: 'layout', label: '点击目标过小' },
  'content-placeholder': { kind: 'content', label: '占位或调试文案残留' },
  'content-template': { kind: 'content', label: '模板变量未替换' },
  'content-mojibake': { kind: 'content', label: '文字乱码' },
  'content-invalid-value': { kind: 'content', label: '无效值（Invalid Date / NaN / 1970）' },
  'security-mixed-content': { kind: 'security', label: 'https 页面加载 http 资源' },
  'security-blank-target': { kind: 'security', label: '新窗口打开但缺少 noopener' },
  'security-insecure-form': { kind: 'security', label: '表单提交到 http' },
  'security-secret': { kind: 'security', label: '页面里疑似密钥' },
  'perf-lcp': { kind: 'perf', label: '最大内容绘制过慢' },
  'perf-cls': { kind: 'perf', label: '布局偏移过大' },
  'perf-oversized-image': { kind: 'perf', label: '图片分辨率远大于显示尺寸' },
  'blank-page': { kind: 'blank', label: '页面几乎没有可见内容' },
});

for (const meta of Object.values(DETECTOR_META)) {
  if (!KINDS.includes(meta.kind)) throw new Error(`detect: kind ${meta.kind} 未在 findings.KINDS 中登记`);
}

export const DETECTOR_IDS = Object.freeze(Object.keys(DETECTOR_META));

/** 默认阈值；站点可在 qa.json 的 defaults.detect 里覆盖（数值型）。 */
export const DETECT_DEFAULTS = Object.freeze({
  lcpMs: 2500,
  cls: 0.1,
  maxPerDetector: 4,
  tapTargetPx: 24,
  mobileTapTargetPx: 44,
  oversizedImageRatio: 2,
  textClippedRatio: 0.3,
});

/**
 * 在页面里跑一次，返回原始发现（还没有 path / evidence / 指纹）。
 * options: { viewportWidth, mobile, maskSelectors, thresholds, loginProfile, maxPerDetector }
 */
export function detectInPage(options = {}) {
  const {
    viewportWidth = 1440,
    mobile = viewportWidth < 600,
    maskSelectors = [],
    thresholds = {},
    loginProfile = null,
    maxPerDetector = 4,
    controlSelector = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], input[type="reset"]',
    namedControls = null,
    formSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
    formSnapshot = null,
    formNames = null,
  } = options;
  const t = {
    tapTargetPx: 24, mobileTapTargetPx: 44, oversizedImageRatio: 2, textClippedRatio: 0.3, ...thresholds,
  };
  const found = [];
  const counts = {};
  const push = (detector, finding) => {
    counts[detector] = (counts[detector] ?? 0) + 1;
    if (counts[detector] > maxPerDetector) return;
    found.push({ detector, ...finding, evidence: { ...(finding.evidence ?? {}), count: undefined } });
  };
  const finalise = () => found.map(f => ({ ...f, evidence: { ...f.evidence, count: counts[f.detector] } }));
  const doc = document;
  const body = doc.body;
  if (!body) return [];

  const clip = (v, n = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const text = (el) => clip(el?.innerText ?? el?.textContent ?? '', 200);
  const cs = (el) => getComputedStyle(el);
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = cs(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01
      && !el.closest('[hidden], [inert], [aria-hidden="true"]');
  };
  const isMasked = (el) => maskSelectors.some(sel => { try { return !!el.closest(sel); } catch { return false; } });
  const unique = (sel) => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };
  const quote = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const selectorOf = (el) => {
    if (!el || el === doc.documentElement) return 'html';
    if (el.id) { const s = '#' + (window.CSS?.escape ? CSS.escape(el.id) : el.id); if (unique(s)) return s; }
    const testId = el.getAttribute?.('data-testid');
    if (testId) { const s = `[data-testid="${quote(testId)}"]`; if (unique(s)) return s; }
    const parts = [];
    let cur = el;
    while (cur && cur !== body && parts.length < 6) {
      const parent = cur.parentElement;
      if (!parent) break;
      const siblings = [...parent.children].filter(c => c.tagName === cur.tagName);
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(cur) + 1})`);
      cur = parent;
    }
    return parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
  };
  const tail = (src, n = 60) => {
    try {
      const url = new URL(src, location.href);
      return ['http:', 'https:'].includes(url.protocol) ? decodeURIComponent(url.pathname).slice(-n) : '[non-http resource]';
    } catch { return '[invalid resource URL]'; }
  };
  const publicResourceUrl = value => {
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return '[non-http resource]';
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return url.href;
    } catch { return '[invalid resource URL]'; }
  };

  /* ---------------- 可访问性 ---------------- */

  for (const img of doc.images) {
    if (!isVisible(img) || isMasked(img)) continue;
    if (img.hasAttribute('alt')) continue;
    push('a11y-image-alt', {
      kind: 'a11y', basis: 'wrong', tier: 'degrade', target: selectorOf(img),
      title: `图片缺少替代文字（alt）：${tail(img.currentSrc || img.src)}`,
      observed: `<img src="${clip(publicResourceUrl(img.currentSrc || img.src), 160)}"> 没有 alt 属性`,
      loss: '读屏用户与图片加载失败的访客都无法知道这张图的内容',
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(img)}`],
    });
  }

  const controlName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const refs = labelledBy.split(/\s+/).map(id => doc.getElementById(id)).filter(Boolean);
      if (refs.length) return refs.map(r => text(r)).join(' ').trim();
    }
    const own = text(el);
    if (own) return own;
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const alt = el.querySelector('img[alt]')?.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase())) {
      const value = el.getAttribute('value');
      if (value && value.trim()) return value.trim();
    }
    return '';
  };
  const controls = [...doc.querySelectorAll(controlSelector)];
  const browserNamed = Array.isArray(namedControls) ? new Set(namedControls) : null;
  const supportedRoles = new Set(['button', 'link', 'tab', 'menuitem']);
  for (const el of controls) {
    if (!isVisible(el) || isMasked(el)) continue;
    if (el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true') continue;
    const explicitRole = el.getAttribute('role')?.trim().split(/\s+/)[0];
    const role = explicitRole || (el.tagName === 'A' ? 'link' : 'button');
    if (browserNamed && supportedRoles.has(role)) {
      if (browserNamed.has(el)) continue;
    } else {
      if (controlName(el)) continue;
      const svgTitle = el.querySelector('svg > title')?.textContent;
      if (svgTitle && svgTitle.trim()) continue;
    }
    push('a11y-control-name', {
      kind: 'a11y', basis: 'wrong', tier: 'degrade', target: selectorOf(el),
      title: `控件没有可访问名称：<${el.tagName.toLowerCase()}>`,
      observed: browserNamed && supportedRoles.has(role)
        ? `${selectorOf(el)} 的浏览器无障碍名称为空`
        : `${selectorOf(el)} 的文本、aria-label、title、内部图片替代文字都为空`,
      loss: `用读屏或键盘导航的人不知道 ${selectorOf(el)} 是做什么的`,
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(el)}`],
    });
  }

  const fieldLabels = [...doc.querySelectorAll(formSelector)];
  if (!formSnapshot || !Array.isArray(formNames) || fieldLabels.length !== formNames.length
    || fieldLabels.length !== formSnapshot.fields.length || formSnapshot.state.changed
    || formSnapshot.observer.takeRecords().length || fieldLabels.some((el, i) => el !== formSnapshot.fields[i])) {
    throw new Error('form name snapshot unavailable or changed');
  }
  for (const [index, el] of fieldLabels.entries()) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (!isVisible(el) || isMasked(el)) continue;
    const name = formNames[index];
    if (!name?.available) throw new Error('form name unavailable');
    if (type === 'file' && name.hasName && !name.sourcesAvailable) throw new Error('file name source unavailable');
    const defaultFileName = type === 'file' && name.defaultFileName && !el.getAttribute('title')?.trim();
    if (name.hasName && !defaultFileName) continue;
    push('a11y-form-label', {
      kind: 'a11y', basis: 'wrong', tier: defaultFileName ? 'tolerable' : 'degrade', target: selectorOf(el),
      title: `表单控件没有标签：<${el.tagName.toLowerCase()}${type ? ' type=' + type : ''}>`,
      observed: defaultFileName
        ? `${selectorOf(el)} 使用浏览器默认的文件选择名称，未发现说明上传用途的标签`
        : `${selectorOf(el)} 的浏览器无障碍名称为空`,
      ...(defaultFileName ? {} : { loss: '读屏用户听不到这个控件要填什么或选择什么' }),
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(el)}`],
    });
  }

  const idCounts = new Map();
  for (const el of doc.querySelectorAll('[id]')) {
    if (!el.id) continue;
    idCounts.set(el.id, (idCounts.get(el.id) ?? 0) + 1);
  }
  for (const [id, n] of idCounts) {
    if (n < 2) continue;
    push('a11y-duplicate-id', {
      kind: 'a11y', basis: 'wrong', tier: 'tolerable', target: `#${id}`,
      title: `id 重复 ${n} 次：${id}`,
      observed: `document 里有 ${n} 个元素使用同一个 id "${id}"`,
      repro: [`打开 ${location.pathname}`, `搜索 id="${id}"`],
    });
  }

  const headings = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter(el => isVisible(el) && !isMasked(el));
  const h1 = headings.filter(el => (el.getAttribute('aria-level') || el.tagName.slice(1)) === '1');
  const levelText = (el) => Number(el.getAttribute('aria-level') || el.tagName.slice(1));
  if (!h1.length && text(body).length > 40) {
    push('a11y-heading', {
      kind: 'a11y', basis: 'wrong', tier: 'tolerable', target: 'h1',
      title: '页面没有一级标题 h1',
      observed: `可见标题 ${headings.length} 个，其中没有 h1`,
      repro: [`打开 ${location.pathname}`],
    });
  } else if (h1.length > 1) {
    push('a11y-heading', {
      kind: 'a11y', basis: 'wrong', tier: 'tolerable', target: 'h1',
      title: `页面有 ${h1.length} 个 h1`,
      observed: h1.slice(0, 3).map(el => clip(text(el), 60)).join(' / '),
      repro: [`打开 ${location.pathname}`],
    });
  }
  let previous = 0;
  for (const el of headings) {
    const level = levelText(el);
    if (previous && level - previous > 1) {
      push('a11y-heading', {
        kind: 'a11y', basis: 'wrong', tier: 'tolerable', target: selectorOf(el),
        title: `标题层级跳跃：h${previous} 之后直接 h${level}`,
        observed: `${selectorOf(el)}：「${clip(text(el), 60)}」`,
        repro: [`打开 ${location.pathname}`],
      });
      break;
    }
    previous = level;
  }

  const htmlLang = doc.documentElement.getAttribute('lang');
  if (!htmlLang || !htmlLang.trim()) {
    push('a11y-lang', {
      kind: 'a11y', basis: 'wrong', tier: 'tolerable', target: 'html',
      title: '页面没有声明 lang',
      observed: '<html> 没有 lang 属性',
      repro: [`打开 ${location.pathname}`],
    });
  }

  for (const frame of [...doc.querySelectorAll('iframe')]) {
    if (!isVisible(frame) || isMasked(frame)) continue;
    if ((frame.getAttribute('title') ?? '').trim()) continue;
    if ((frame.getAttribute('aria-label') ?? '').trim()) continue;
    push('a11y-iframe-title', {
      kind: 'a11y', basis: 'wrong', tier: 'tolerable', target: selectorOf(frame),
      title: `iframe 缺少 title：${tail(frame.src, 50)}`,
      observed: `<iframe src="${clip(publicResourceUrl(frame.src), 160)}"> 没有 title`,
      repro: [`打开 ${location.pathname}`],
    });
  }

  for (const el of doc.querySelectorAll('[tabindex]')) {
    const value = Number(el.getAttribute('tabindex'));
    if (!Number.isFinite(value) || value <= 0 || !isVisible(el)) continue;
    push('a11y-tabindex', {
      kind: 'a11y', basis: 'wrong', tier: 'tolerable', target: selectorOf(el),
      title: `正向 tabindex=${value}：${clip(controlName(el) || text(el), 40) || selectorOf(el)}`,
      observed: `${selectorOf(el)} 的 tabindex=${value}`,
      repro: [`打开 ${location.pathname}`, '按 Tab 走一遍焦点顺序'],
    });
    break;
  }

  /* ---------------- 布局 ---------------- */

  const textEls = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, a, button, label, li, td, th, dt, dd, div')]
    .filter(el => isVisible(el) && !isMasked(el) && el.children.length <= 2);
  const normalText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const horizontalScroller = el => ['auto', 'scroll'].includes(cs(el).overflowX) && el.scrollWidth > el.clientWidth + 2;
  for (const el of textEls) {
    const content = text(el);
    if (content.length < 8) continue;
    const style = cs(el);
    const overflowX = style.overflowX;
    const clips = overflowX === 'hidden' || overflowX === 'clip';
    const ellipsis = style.textOverflow === 'ellipsis';
    if (!(clips || ellipsis)) continue;
    const client = el.clientWidth, scroll = el.scrollWidth;
    if (client <= 0 || scroll <= client + 2) continue;
    const visibleRatio = client / scroll;
    if (visibleRatio > 1 - t.textClippedRatio) continue;
    const rect = el.getBoundingClientRect();
    const screenReaderOnly = rect.width <= 2 && rect.height <= 2 && ['absolute', 'fixed'].includes(style.position)
      && (style.clipPath === 'inset(50%)' || /^rect\(0px,? 0px,? 0px,? 0px\)$/.test(style.clip));
    if (screenReaderOnly) continue;
    const fullText = normalText(el.innerText);
    const scrollableContent = [...el.querySelectorAll('*')].some(child => horizontalScroller(child)
      && fullText && normalText(child.innerText) === fullText);
    if (scrollableContent) continue;
    const title = normalText(el.closest('[title]')?.getAttribute('title'));
    const fullTitle = fullText && title === fullText;
    const tableHeader = !!el.querySelector('thead') && [...(el.parentElement?.children ?? [])]
      .filter(sibling => sibling !== el)
      .some(sibling => [sibling, ...sibling.querySelectorAll('*')].some(child => horizontalScroller(child)
        && child.querySelector('tbody') && Math.abs(child.clientWidth - client) <= 3 && Math.abs(child.scrollWidth - scroll) <= 3));
    push('layout-text-clipped', {
      kind: 'layout', basis: fullTitle || tableHeader ? 'friction' : 'wrong', tier: fullTitle || tableHeader ? 'tolerable' : 'degrade', target: selectorOf(el),
      title: `文字被裁切：${clip(content, 50)}`,
      observed: `显示宽度 ${client}px / 内容宽度 ${scroll}px，只露出约 ${Math.round(visibleRatio * 100)}%`
        + (fullTitle ? '；原生 title 包含完整文字，触屏和键盘使用仍需复核' : tableHeader ? '；同表格正文可横向滚动，需复核表头是否同步' : ''),
      ...(!fullTitle && !tableHeader ? { loss: '访客看不全这段被截断的文字' } : {}),
      repro: [`打开 ${location.pathname}（${innerWidth}px）`, `定位 ${selectorOf(el)}`],
    });
  }

  for (const img of doc.images) {
    if (!isVisible(img) || isMasked(img)) continue;
    if (!img.naturalWidth || !img.naturalHeight) continue;
    const shown = img.getBoundingClientRect();
    if (shown.width < 32 || shown.height < 32) continue;
    const fit = cs(img).objectFit;
    if (fit && fit !== 'fill') continue;
    const natural = img.naturalWidth / img.naturalHeight;
    const rendered = shown.width / shown.height;
    const delta = Math.abs(natural - rendered) / natural;
    if (delta < 0.1) continue;
    push('layout-image-ratio', {
      kind: 'layout', basis: 'wrong', tier: 'tolerable', target: selectorOf(img),
      title: `图片被拉伸变形：${tail(img.currentSrc || img.src)}`,
      observed: `原图 ${img.naturalWidth}×${img.naturalHeight}（比例 ${natural.toFixed(2)}），显示 ${Math.round(shown.width)}×${Math.round(shown.height)}（比例 ${rendered.toFixed(2)}），object-fit: ${fit || 'fill'}`,
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(img)}`],
    });
  }

  const tapLimit = mobile ? t.mobileTapTargetPx : t.tapTargetPx;
  for (const el of doc.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]')) {
    if (!isVisible(el) || isMasked(el)) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    const style = cs(el);
    if (style.display === 'inline' && !style.padding?.match(/[1-9]/)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width >= tapLimit && rect.height >= tapLimit) continue;
    // 整行可点的链接（a 包块级内容）不算小目标
    if (el.querySelector('div, p, ul, li, img') ) continue;
    push('layout-tap-target', {
      kind: 'layout', basis: 'friction', tier: 'tolerable', target: selectorOf(el),
      title: `点击目标过小 ${Math.round(rect.width)}×${Math.round(rect.height)}：${clip(controlName(el) || text(el), 40) || selectorOf(el)}`,
      observed: `在 ${innerWidth}px 宽下可点区域 ${Math.round(rect.width)}×${Math.round(rect.height)}px，低于 ${tapLimit}px`,
      repro: [`在 ${innerWidth}px 宽下打开 ${location.pathname}`, `定位 ${selectorOf(el)}`],
      viewport: `${innerWidth}x${innerHeight}`,
    });
  }

  /* ---------------- 内容 ---------------- */

  const bodyText = clip(body.innerText ?? '', 200000);
  const PLACEHOLDER = /\blorem ipsum\b|\b(TODO|FIXME|XXX)\b|\[object Object\]|\bundefined\b|\bNaN\b/i;
  const placeholderHits = [];
  for (const el of textEls) {
    const content = text(el);
    if (content.length < 2) continue;
    if (!PLACEHOLDER.test(content)) continue;
    if (/undefined|NaN/.test(content) && /^(JSON|NaN|undefined)$/.test(content)) continue;
    placeholderHits.push({ el, content });
  }
  for (const { el, content } of placeholderHits.slice(0, t.maxPerDetector)) {
    push('content-placeholder', {
      kind: 'content', basis: 'wrong', tier: 'degrade', target: selectorOf(el),
      title: `页面出现调试/占位文案：${clip(content, 50)}`,
      observed: `${selectorOf(el)} 的可见文字：「${clip(content, 160)}」`,
      loss: `访客看到的是开发时的占位内容而不是最终文案`,
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(el)}`],
    });
  }

  const TEMPLATE = /\{\{[^{}]{1,60}\}\}|\$\{[^{}]{1,60}\}|<%[^%]{1,60}%>/;
  for (const el of textEls) {
    const content = text(el);
    if (!TEMPLATE.test(content)) continue;
    push('content-template', {
      kind: 'content', basis: 'wrong', tier: 'degrade', target: selectorOf(el),
      title: `模板变量没替换：${clip(content, 50)}`,
      observed: `${selectorOf(el)} 的可见文字：「${clip(content, 160)}」`,
      loss: '访客看到的是 {{变量}} 这类模板占位，而不是实际数据',
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(el)}`],
    });
  }

  const MOJIBAKE = /Ã[\u0080-¿]|â€[™œ“”]|锟斤拷|ï¿½|�/;
  for (const el of textEls) {
    const content = text(el);
    if (!MOJIBAKE.test(content)) continue;
    push('content-mojibake', {
      kind: 'content', basis: 'wrong', tier: 'degrade', target: selectorOf(el),
      title: `乱码：${clip(content, 50)}`,
      observed: `${selectorOf(el)} 的可见文字含乱码特征：「${clip(content, 160)}」`,
      loss: '访客读到的是乱码，中文内容完全不可读',
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(el)}`],
    });
  }

  const INVALID = /Invalid Date|\bNaN\b|1970[-/]0?1[-/]0?1/;
  for (const el of textEls) {
    const content = text(el);
    if (!INVALID.test(content)) continue;
    push('content-invalid-value', {
      kind: 'content', basis: 'wrong', tier: 'degrade', target: selectorOf(el),
      title: `页面显示无效值：${clip(content, 50)}`,
      observed: `${selectorOf(el)} 的可见文字：「${clip(content, 160)}」`,
      loss: '访客看到的是错误的时间或空值，会以为数据坏了',
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(el)}`],
    });
  }

  /* ---------------- 安全 ---------------- */

  if (location.protocol === 'https:') {
    const insecure = [];
    for (const entry of performance.getEntriesByType('resource')) {
      if (/^http:\/\//i.test(entry.name)) insecure.push(entry.name);
    }
    for (const el of doc.querySelectorAll('img[src^="http://"], script[src^="http://"], link[href^="http://"], iframe[src^="http://"], source[src^="http://"]')) {
      const url = el.src || el.href;
      if (url && /^http:\/\//i.test(url)) insecure.push(url);
    }
    const seen = new Set();
    for (const url of insecure) {
      const clean = publicResourceUrl(url);
      if (seen.has(clean)) continue;
      seen.add(clean);
      push('security-mixed-content', {
        kind: 'security', basis: 'failed', tier: 'degrade', target: clean,
        title: `https 页面加载 http 资源：${tail(clean, 60)}`,
        observed: `${clean} 以 http:// 加载，在 https 页面会被浏览器拦截或标记为不安全`,
        loss: '浏览器会拦截或被标记为「不安全」，访客看到警告或资源加载失败',
        repro: [`打开 ${location.pathname}`, '在开发者工具 Network 中查看该请求'],
      });
    }
  }

  for (const el of doc.querySelectorAll('a[target="_blank"], area[target="_blank"]')) {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase();
    if (/\bnoopener\b|\bnoreferrer\b/.test(rel)) continue;
    if (!isVisible(el)) continue;
    push('security-blank-target', {
      kind: 'security', basis: 'wrong', tier: 'tolerable', target: selectorOf(el),
      title: `新窗口链接缺少 rel="noopener"：${tail(el.href, 50)}`,
      observed: `<a target="_blank" href="${clip(publicResourceUrl(el.href), 160)}"> 的 rel="${clip(rel, 40)}"`,
      repro: [`打开 ${location.pathname}`, '点击该链接'],
    });
  }

  for (const form of doc.querySelectorAll('form[action]')) {
    if (!/^http:\/\//i.test(form.getAttribute('action').trim())) continue;
    if (location.protocol !== 'https:') continue;
    push('security-insecure-form', {
      kind: 'security', basis: 'failed', tier: 'wall', target: selectorOf(form),
      title: 'https 页面的表单提交到 http',
      observed: `<form action="${clip(publicResourceUrl(form.getAttribute('action')), 160)}">`,
      loss: '用户填写的表单内容会以明文传输',
      repro: [`打开 ${location.pathname}`, `定位 ${selectorOf(form)}`],
    });
  }

  const html = doc.documentElement.innerHTML ?? '';
  const SECRETS = [
    { re: /\bsk-[A-Za-z0-9_-]{20,}/g, label: 'sk- 密钥' },
    { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS Access Key' },
    { re: /\bghp_[A-Za-z0-9]{30,}\b/g, label: 'GitHub Token' },
    { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, label: '私钥' },
  ];
  for (const { re, label } of SECRETS) {
    re.lastIndex = 0;
    const hit = re.exec(html);
    if (!hit) continue;
    // 不把密钥原文写进报告，只给前缀与位置
    const value = hit[0];
    const masked = value.slice(0, 6) + '…' + value.slice(-2);
    push('security-secret', {
      kind: 'security', basis: 'failed', tier: 'wall', target: label,
      title: `页面里疑似泄露${label}：${masked}`,
      observed: `页面 HTML 中出现形如 ${masked} 的字符串（已截断，不写入完整值）`,
      loss: '任何访问页面的人都能拿到这把密钥',
      repro: [`打开 ${location.pathname}`, '查看页面源代码'],
    });
  }

  /* ---------------- 性能 ---------------- */

  const perf = window.__heimdallPerf;
  if (perf) {
    if (Number.isFinite(perf.lcp) && perf.lcp > (t.lcpMs ?? 2500)) {
      push('perf-lcp', {
        kind: 'perf', basis: 'friction', tier: 'tolerable', target: 'largest-contentful-paint',
        title: `最大内容绘制 ${Math.round(perf.lcp)}ms，超过 ${t.lcpMs}ms`,
        observed: `LCP ${Math.round(perf.lcp)}ms（FCP ${Math.round(perf.fcp ?? 0)}ms）`,
        repro: [`在 ${innerWidth}px 宽下打开 ${location.pathname}`],
        viewport: `${innerWidth}x${innerHeight}`,
      });
    }
    if (Number.isFinite(perf.cls) && perf.cls > (t.cls ?? 0.1)) {
      push('perf-cls', {
        kind: 'perf', basis: 'friction', tier: 'tolerable', target: 'cumulative-layout-shift',
        title: `布局偏移 CLS ${perf.cls.toFixed(3)}，超过 ${t.cls}`,
        observed: `CLS ${perf.cls.toFixed(3)}`,
        repro: [`在 ${innerWidth}px 宽下打开 ${location.pathname}`],
        viewport: `${innerWidth}x${innerHeight}`,
      });
    }
  }

  for (const img of doc.images) {
    if (!isVisible(img) || isMasked(img)) continue;
    if (!img.naturalWidth) continue;
    const shown = img.getBoundingClientRect();
    if (shown.width < 100) continue;
    const ratio = img.naturalWidth / Math.max(1, shown.width * (window.devicePixelRatio || 1));
    if (ratio < t.oversizedImageRatio) continue;
    push('perf-oversized-image', {
      kind: 'perf', basis: 'friction', tier: 'tolerable', target: selectorOf(img),
      title: `图片分辨率远大于显示尺寸：${tail(img.currentSrc || img.src)}`,
      observed: `原图宽 ${img.naturalWidth}px，显示宽 ${Math.round(shown.width)}px（${ratio.toFixed(1)} 倍）`,
      repro: [`在 ${innerWidth}px 宽下打开 ${location.pathname}`],
    });
  }

  /* ---------------- 白屏 ---------------- */

  const visibleText = clip(body.innerText ?? '', 100000);
  const elementCount = body.querySelectorAll('*').length;
  const bodyHeight = body.getBoundingClientRect().height;
  if (visibleText.length < 20 && elementCount > 3 && bodyHeight > 50 && !loginProfile) {
    push('blank-page', {
      kind: 'blank', basis: 'failed', tier: 'wall', target: location.pathname,
      title: '页面几乎没有可见内容（疑似白屏）',
      observed: `可见文字 ${visibleText.length} 字，元素 ${elementCount} 个，页面高度 ${Math.round(bodyHeight)}px`,
      loss: '访客打开页面看到的是空白，没有内容也没有提示',
      repro: [`打开 ${location.pathname}`, '观察页面内容'],
    });
  }

  return finalise();
}

/**
 * 读取 Web Vitals。页面加载后单独调用一次，结果放进 window.__heimdallPerf，
 * 再由 detectInPage 统一消费——这样检测函数不需要变成 async。
 */
export async function readVitalsInPage() {
  // layout-shift 条目只能从 PerformanceObserver 的回调里拿到，getEntriesByType 永远为空。
  return new Promise(resolve => {
    const v = { lcp: 0, cls: 0, fcp: 0 };
    const observers = [];
    try {
      const shift = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) v.cls += entry.value;
      });
      shift.observe({ type: 'layout-shift', buffered: true });
      observers.push(shift);
    } catch { /* 不支持就跳过 */ }
    try {
      const paint = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) v.lcp = Math.max(v.lcp, entry.startTime);
      });
      paint.observe({ type: 'largest-contentful-paint', buffered: true });
      observers.push(paint);
    } catch { /* 不支持就跳过 */ }
    try {
      for (const entry of performance.getEntriesByType('paint')) if (entry.name === 'first-contentful-paint') v.fcp = entry.startTime;
    } catch { /* 老浏览器 */ }
    setTimeout(() => {
      for (const observer of observers) { try { observer.disconnect(); } catch { /* 已断开 */ } }
      window.__heimdallPerf = v;
      resolve(v);
    }, 150);
  });
}
