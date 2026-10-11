/**
 * 交互镜像 HTML：根相对引用 → 代理前缀
 *
 * 单独成模块是为了**可测** —— 这段改写把一个通用形态写坏了，而它只在真站点上
 * 才显形（ant.design 的图标字体全丢）。
 *
 * 前提：镜像页处在 `/lm/<host>/` 前缀下，`<base href>` 管不了以 `/` 开头的路径
 * （那是直接打当前源根），所以必须逐条改写成前缀形式。但"以 / 开头"里包含
 * **协议相对 URL**：`//at.alicdn.com/x.woff2`、`//cdn.example.com/a.js` ——
 * 它本该原样留着（浏览器自动补成当前协议的绝对地址）。此前它被当成根相对，
 * 被改写成 `/lm/<host>//at.alicdn.com/…`：一个指向本机根目录、永远 404 的路径。
 * 实测 ant.design 交互镜像：图标字体的 8 个引用全是这么坏的，体检报告据此报
 * 8 个 unresolved（`/at.alicdn.com/t/webfont_….woff2` 这种少了协议的怪样子就是它）。
 *
 * 所以每条规则的 `/` 后面都要跟一个 `(?!/)`。静态镜像那侧（dom-refs.mjs:117）
 * 一直是 `startsWith('/') && !startsWith('//')`，这里对齐。
 */
export function prefixRootRelative(html, lmPrefix, rootDirs = []) {
  const p = lmPrefix.replace(/\/$/, '');
  let out = html;
  // 属性里的根相对引用
  out = out.replace(/((?:src|href|srcset|action)\s*=\s*["'])\/(?!\/|lm\/|static\/)/gi, `$1${p}/`);
  // CSS url()
  out = out.replace(/url\(\s*(?:&quot;|['"])?\/(?!\/|lm\/|static\/)/gi, `url("${p}/`);
  // JS 动态 import()（语言级，不走 fetch patch，漏了就整段 chunk 加载不了）
  out = out.replace(/(import\s*\(\s*["'])\/(?!\/|lm\/|static\/)/gi, `$1${p}/`);
  // importmap JSON 与 JS 字符串里的已知根目录（字符串定位，避免正则回溯）
  for (const d of rootDirs) {
    out = out.split('"/' + d).join('"' + p + '/' + d);
    out = out.split("'/" + d).join("'" + p + '/' + d);
  }
  // 收尾：任意目录的根相对引用
  out = out.replace(/(\b(?:src|href|srcset|action)\s*=\s*["']?)\/(?!\/|lm\/|static\/)/gi, `$1${p}/`);
  out = out.replace(/url\(\s*(?:&quot;|['"])?\/(?!\/|lm\/|static\/)/gi, `url("${p}/`);
  return out;
}
