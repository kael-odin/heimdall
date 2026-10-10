/**
 * css-refs — CSS `url()` 引用扫描（唯一实现，capture / multi-snapshot / build_clone 共用）
 *
 * 为什么不能用全局正则：`url("data:image/svg+xml,<svg><g mask='url(%23f)'/></svg>")`
 * 里**内嵌的 url(...) 是 data URI 的内容，不是外部引用**。用 `/url\(([^)]+)\)/g` 扫会把它
 * 当成顶层引用 → 去原站抓 `https://host/%23f`（SPA 兜底返回首页 HTML）→ 落盘成 `refNNN.html`
 * → 再把 data URI 内的 mask 引用替换掉，**静默改坏内联 SVG 图标**。
 * （2026-10-09 实测于 vitest.dev：34 处内嵌 mask 引用被改写。）
 *
 * 本模块按 CSS 词法逐字符扫描：识别到 `url(` 后，若紧跟引号则**整段跳到配对引号之后**，
 * 内嵌内容因此不会被二次扫描。
 */

/**
 * 扫描 CSS 文本里的全部 url() 引用。
 * @param {string} css
 * @returns {{raw:string, start:number, end:number}[]} start/end 是**原始 URL 文本**在 css 中的区间（不含引号）
 */
export function scanCssRefs(css) {
  const s = String(css ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('url(', i);
    if (at < 0) break;
    let j = at + 4;
    while (j < s.length && /\s/.test(s[j])) j++;
    const q = s[j];
    if (q === '"' || q === "'") {
      let k = j + 1;
      while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++; }
      out.push({ raw: s.slice(j + 1, k), start: j + 1, end: k });
      i = Math.min(k + 1, s.length);           // 跳过整段字符串（含内嵌 url( 的内容）
    } else {
      let k = j;
      while (k < s.length && s[k] !== ')') k++;
      out.push({ raw: s.slice(j, k).trim(), start: j, end: k });
      i = Math.min(k + 1, s.length);
    }
  }
  return out;
}

/**
 * 按样式表基准收集引用（CSS 规范的基准是**样式表自身 URL**，不是页面 origin）。
 * @param {{href?:string|null, css?:string}[]} sheets
 * @param {string} fallbackBase 内联 <style>/adoptedStyleSheets 的基准（通常是 document.baseURI）
 * @returns {{refs:string[], refMap:Record<string,string[]>}}
 */
export function collectCssRefs(sheets, fallbackBase) {
  const refMap = Object.create(null);
  for (const sheet of sheets ?? []) {
    if (!sheet?.css) continue;
    const base = sheet.href || fallbackBase;
    for (const t of scanCssRefs(sheet.css)) {
      const raw = t.raw;
      if (!raw || raw.startsWith('data:')) continue;
      let abs = null;
      try { abs = new URL(raw, base).href; } catch { abs = null; }
      const list = refMap[raw] ?? (refMap[raw] = []);
      if (abs && !list.includes(abs)) list.push(abs);
    }
  }
  return { refs: Object.keys(refMap), refMap };
}

/**
 * 单遍重建：用 resolved 映射替换 CSS 里的引用文本（只换 URL 片段，保留原引号与其余文本）。
 * @param {string} css
 * @param {Map<string,string|null>} resolved raw → 新的相对路径；null/undefined 表示保持原样
 */
export function rewriteCssRefs(css, resolved) {
  const tokens = scanCssRefs(css);
  let out = '', last = 0;
  for (const t of tokens) {
    const rep = resolved.get(t.raw);
    if (!rep) continue;                         // 未解析（data:/#/失败）→ 原样保留
    out += css.slice(last, t.start) + rep;
    last = t.end;
  }
  return out + css.slice(last);
}
