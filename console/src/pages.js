/**
 * pages — 页面标识与 URL 推导（父组件与详情面板都要用）
 *
 * pageNameOf 必须**唯一实现**：它决定了 workspace 里的产物目录名
 * （workspace/<host>/pages/<name>/…），父组件用它取数据、子组件用它拼链接。
 * 复制一份出来，两边规则一旦不一致，链接就会指向不存在的目录 —— 而且不报错，
 * 只是打开是 404。
 */

/** 页面 URL → 页面名（= 产出目录名）。与引擎侧 src/engine-server.mjs 的 pageFor 同规则。 */
export function pageNameOf(n) {
  try {
    const p = new URL(n.url).pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[/?&#]+/g, '-').slice(0, 60);
    return p || 'home';
  } catch {
    return n.path === '/' ? 'home' : String(n.path || '').replace(/^\//, '').replace(/[/?&#]+/g, '-') || 'home';
  }
}

/** 活镜像地址（/lm/<host>/<path>）：功能与数据实时回原站的代理通道 */
export function liveUrl(f) {
  try { const u = new URL(f.url); return `/lm/${u.host}${u.pathname.replace(/\/$/, '')}`; } catch { return '#'; }
}
