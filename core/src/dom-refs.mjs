/**
 * dom-refs — HTML 里的资产引用识别与清理
 *
 * 抽成独立模块是因为这两个判断都是**纯字符串逻辑**、且都踩过坑，
 * 需要一个能被单测直接喂输入的地方（build_clone.mjs 是 CLI，import 即执行）。
 *
 * 两个真实的坑：
 *
 * ① **rel 是空格分隔的 token 列表，不是单个值**（HTML 规范）。
 *    原实现用 `/<link[^>]*rel="stylesheet"[^>]*>/` 精确匹配，
 *    漏掉了 `rel="preload stylesheet"`。实测 vitest.dev 首页就有
 *    `<link rel="preload stylesheet" href="/assets/style.C-kOEMgT.css" as="style">`，
 *    于是它被原样留进克隆、指向原站根路径、本地 404。
 *    像素分仍是 99.96%（最终样式已在 cssom.css 里），所以肉眼完全看不出来。
 *
 * ② **根相对路径（/foo.css）也算"残留"**。它不带域名，看起来"像是本站的"，
 *    但克隆是挂在 /static/<host>/pages/<page>/clone/ 下服务的 ——
 *    /foo.css 会打到引擎根，一样 404。
 *    原自检只统计 `href.startsWith(origin)`，于是对上面那两条报 "0"。
 *    一个会撒谎的自检比没有自检更糟：它让人相信交付物是干净的。
 */

/** <link> 标签的 rel token 列表（小写，已去空） */
export function relTokens(tag) {
  const m = /\brel\s*=\s*"([^"]*)"/i.exec(String(tag ?? ''));
  return m ? m[1].toLowerCase().split(/\s+/).filter(Boolean) : [];
}

/** 样式表与各类资源提示：这些 <link> 的内容已由 styles/<cssom> 提供，应当摘除 */
export const DROP_RELS = new Set(['stylesheet', 'preload', 'preconnect', 'dns-prefetch', 'modulepreload', 'prefetch']);

/** 属于资产类的 rel（canonical / alternate / next / prev 不算） */
export const ASSET_RELS = new Set([
  'stylesheet', 'icon', 'shortcut', 'apple-touch-icon', 'mask-icon', 'manifest',
  'preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch',
]);

/**
 * 摘掉样式表与资源提示的 <link>（按 token 判断，不是整串比较）。
 * @param {string} html
 * @param {Set<string>} [dropRels]
 */
export function stripAssetLinkTags(html, dropRels = DROP_RELS) {
  return String(html ?? '').replace(/<link\b[^>]*>/gi, (tag) => (
    relTokens(tag).some(t => dropRels.has(t)) ? '' : tag
  ));
}

/**
 * 把 <base href> 改成文档相对（`./`）。
 *
 * 克隆页位于 `/static/<host>/pages/<page>/clone/`，但 Angular 之类的应用会带
 * `<base href="/">` —— 浏览器据此把**所有相对引用**改基到站点根，于是
 * `styles/cssom.css` 被解析成 `/styles/cssom.css` 而 404，
 * `assets/image000.svg` 同理。整页样式与图片一起失效（实测 angular.dev 首页
 * 裸奔成无样式 HTML，像素掉到 89.7%）。
 *
 * 保留元素本身（有些脚本会检测它存在），只把 href 改成 `./` —— 相对文档解析，
 * 无论通过 /static 还是 file:// 打开都成立。没有 href 的 `<base target="...">` 原样保留。
 *
 * 为什么之前没暴露：VitePress / Docusaurus / 多数营销站不带 <base>，
 * 换到 Angular 才第一次踩到。
 */
export function neutralizeBaseTag(html) {
  return String(html ?? '').replace(/<base\b[^>]*>/gi, (tag) => {
    if (!/\bhref\s*=/i.test(tag)) return tag;
    return tag.replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, 'href="./"');
  });
}

/**
 * 把已光栅化的 <canvas> 换成 <img>。
 *
 * 静态镜像会剥离全部 <script>，所以画布上什么都不剩 —— 那是一整类盲区。
 * capture 阶段负责在滚动扫描时把画布像素存成 assets/canvas-<i>.png，
 * 并在元素上打 data-heimdall-canvas="<i>"；这里据此替换。
 *
 * **没抓到的保持原样**：空白画布（从未绘制）或跨域污染（读不到像素）不该
 * 被换成一张空图 —— 那样只是把"缺失"伪装成"已处理"。
 *
 * @returns {{ html: string, count: number }}
 */
export function rasterizeCanvases(html, { assetDir = 'assets' } = {}) {
  let count = 0;
  const out = String(html ?? '').replace(/<canvas\b([^>]*?)(?:\/>|>([\s\S]*?)<\/canvas>)/gi, (tag, attrs) => {
    const m = /data-heimdall-canvas\s*=\s*"(\d+)"/i.exec(attrs);
    if (!m) return tag;
    count++;
    const w = /\bwidth\s*=\s*"?(\d+)"?/i.exec(attrs)?.[1];
    const h = /\bheight\s*=\s*"?(\d+)"?/i.exec(attrs)?.[1];
    const cls = /\bclass\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const kept = [
      `src="${assetDir}/canvas-${m[1]}.png"`,
      cls ? `class="${cls}"` : '',
      w ? `width="${w}"` : '',
      h ? `height="${h}"` : '',
      // 记录来源：这是画面快照，不是原元素。排查"这图哪来的"时省事。
      'data-heimdall-raster="1"',
      'alt=""',   // 原画布无 alt；这些是装饰性插图，显式标装饰
    ].filter(Boolean).join(' ');
    return `<img ${kept}>`;
  });
  return { html: out, count };
}

/**
 * 这个引用在本地服务下会不会 404？
 * @param {string} value 引用原文
 * @param {string} origin 原站 origin（如 https://vitest.dev）
 * @param {string} [originRegex] 预转义的 origin（省去每次重建）
 */
export function isStrayRef(value, origin, originRegex) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (s.startsWith(origin + '/') || s === origin) return true;
  // 根相对（单个 /）—— 裸协议相对 //cdn/x 不算，那是站外
  return s.startsWith('/') && !s.startsWith('//');
}

/**
 * 统计"指向原站或根路径、因而在本地必然 404"的资产引用数。
 *
 * 口径：
 *   · src / poster —— 单值，直接判
 *   · srcset       —— 逗号分隔的多值，逐个判（每段第一段是 URL）
 *   · <link href>  —— 仅资产类 rel；canonical/alternate 指向原站**是对的**，不算残留
 *   · <a href>     —— 不算：指向未克隆页的链接本就该回原站（由 linker 接线）
 */
export function findStrayRefs(html, origin) {
  const s = String(html ?? '');
  const re = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = [];
  for (const m of s.matchAll(/\b(src|poster)\s*=\s*"([^"]*)"/gi)) {
    if (isStrayRef(m[2], origin, re)) out.push({ kind: m[1], ref: m[2] });
  }
  for (const m of s.matchAll(/\bsrcset\s*=\s*"([^"]*)"/gi)) {
    for (const part of m[1].split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url && isStrayRef(url, origin, re)) out.push({ kind: 'srcset', ref: url });
    }
  }
  for (const m of s.matchAll(/<link\b[^>]*>/gi)) {
    if (!relTokens(m[0]).some(t => ASSET_RELS.has(t))) continue;
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    if (href && isStrayRef(href, origin, re)) out.push({ kind: 'link:' + relTokens(m[0]).join(' '), ref: href });
  }
  return out;
}
