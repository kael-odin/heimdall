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
import { esc } from '../html.mjs';

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

/** 未镜像提示条上的标记属性（幂等：已有就不再插） */
export const UNMIRRORED_MARK = 'data-heimdall-unmirrored';

/**
 * 给"没有本地快照、只能反代回原站"的页面插一条提示。
 *
 * 镜像路由是**融合**的：本地 `live/<path>/index.html` 存在就回快照，否则反代回原站 ——
 * 这让未锻造的页与所有 JS chunk / API 都"活着"。但代价是：一个**根本没导出过**
 * 交互镜像的站点，`<host>.localhost:8900` 打开的就是原站本身。用户看到的界面写着
 * 「交互镜像」，实际显示的是官方页，界面上没有一个字说明这件事
 * （实测就是这个原因：vercel.com 没有 live/ 产物，点「交互镜像」= 打开 vercel.com）。
 *
 * 所以只在**顶层文档导航**上补这一条（资源请求、RSC/fetch 都不插）：
 * 让人一眼知道"这一段是原站实时内容，不是我们复刻的"。
 * 一个会撒谎的界面比没有界面更糟 —— 这条提示就是为了不撒谎。
 *
 * @param {string} html  上游返回的 HTML
 * @param {string} host  正在被代理的站点
 * @param {{to?: string}} [opts] to = 镜像首页地址（前缀入口下是 /lm/<host>）
 */
export function unmirroredBanner(html, host, { to = '/' } = {}) {
  const src = String(html ?? '');
  if (src.includes(UNMIRRORED_MARK)) return src;
  const box = '<div ' + UNMIRRORED_MARK + '="" role="status" style="position:fixed;left:12px;bottom:12px;z-index:2147483647;'
    + 'max-width:min(440px,calc(100vw - 24px));padding:9px 13px;border-radius:9px;'
    + "font:12px/1.6 system-ui,-apple-system,'Segoe UI','Noto Sans SC',sans-serif;"
    + 'background:rgba(17,17,22,.93);color:#E5E7EB;box-shadow:0 8px 28px rgba(0,0,0,.4)">'
    + '<b style="color:#FBBF24">此页未镜像</b> · 以下是 <b>' + esc(host) + '</b> 的原站实时内容（经本地代理）。'
    + ' <a href="' + esc(to) + '" style="color:#22D3EE;text-decoration:none">← 回镜像首页</a></div>';
  // 插在 </body> 前；没有 </body>（片段/畸形 HTML）就追加到末尾 —— 都不能让提示消失
  const i = src.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? src + box : src.slice(0, i) + box + src.slice(i);
}
