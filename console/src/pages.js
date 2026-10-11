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

/**
 * 交互镜像地址（/lm/<host>/<path>）：保留脚本、资源实时回原站的代理通道。
 *
 * **目录型路径必须带尾斜杠**。URL 的"基目录"是最后一个 `/` 之前的部分：
 * `/lm/ant.design` 的基目录是 `/lm/`，页内相对引用（`chunk-x.js`）会解析到
 * `/lm/chunk-x.js` —— 靠引擎的 referer 兜底才凑巧能活。补成 `/lm/ant.design/`
 * 之后基目录就是页面自身所在目录，相对引用归位，不再依赖兜底。
 * 带扩展名的路径（.html 等）是文件，不加。
 */
export function liveUrl(f) {
  try {
    const u = new URL(f.url);
    let p = u.pathname.replace(/\/+$/, '');
    if (!/\.[a-z0-9]+$/i.test(p)) p += '/';
    return `/lm/${u.host}${p}`;
  } catch { return '#'; }
}
