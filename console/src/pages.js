/**
 * pages — 页面标识与 URL 推导（父组件与详情面板都要用）
 *
 * pageNameOf 必须**唯一实现**：它决定了 workspace 里的产物目录名
 * （workspace/<host>/pages/<name>/…），父组件用它取数据、子组件用它拼链接。
 * 复制一份出来，两边规则一旦不一致，链接就会指向不存在的目录 —— 而且不报错，
 * 只是打开是 404。
 */

import { API } from './api.js';

/** 页面 URL → 页面名（= 产出目录名）。规则与 core/src/url-canon.mjs 的 pageNameOfUrl **同一份**。 */
export function pageNameOf(n) {
  try {
    const p = new URL(n.url).pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[/?&#]+/g, '-').slice(0, 60);
    return p || 'home';
  } catch {
    return n.path === '/' ? 'home' : String(n.path || '').replace(/^\//, '').replace(/[/?&#]+/g, '-') || 'home';
  }
}

/**
 * 交互镜像地址：保留脚本、资源实时回原站的代理通道。**两种入口**：
 *
 *   · 独立域名  http://<host>.localhost:<port>/<path>   ← liveUrl，优先
 *   · 路径前缀  /lm/<host>/<path>                        ← liveAltUrl，备用
 *
 * 为什么优先独立域名：纯前端渲染（SPA）站点的路由库读 location.pathname 决定渲染什么。
 * 前缀入口下它看到的是 /lm/vitest.dev/，匹配不到任何路由，于是渲染**它自己的 404 页** ——
 * 实测 vitest.dev（VitePress）整页变成 "404 | Vitest"，脚本越正常页面越不对。
 * 独立域名下这个前缀根本不存在，路由、cookie、localStorage 都按站点隔离，与原站一致。
 * 代价是依赖 *.localhost 解析到本机（Chrome/Firefox 原生支持；本机 DNS 被代理接管时
 * 可能失败）—— 失败就用 liveAltUrl 那个入口，两者服务的是同一份产物。
 *
 * **目录型路径必须带尾斜杠**。URL 的"基目录"是最后一个 `/` 之前的部分：
 * `/lm/ant.design` 的基目录是 `/lm/`，页内相对引用（`chunk-x.js`）会解析到
 * `/lm/chunk-x.js` —— 靠引擎的 referer 兜底才凑巧能活。补成 `/lm/ant.design/`
 * 之后基目录就是页面自身所在目录，相对引用归位，不再依赖兜底。
 * 带扩展名的路径（.html 等）是文件，不加。
 *
 * **协议与端口必须取引擎的 origin，不能取控制台的 `location`。**
 * 两处端口只有单端口部署时才相同：dev 下控制台在 Vite（:5173）而镜像由引擎（:8900）提供，
 * 按 location 拼出来的 `<host>.localhost:5173` 会打到 Vite 上 —— 实测返回的是
 * **控制台自己的 SPA 首页**（200 + `<title>Heimdall · Site Atlas</title>`），
 * 于是"点交互镜像"看起来毫无反应。引擎地址在 api.js 里已经是唯一事实来源
 * （含用户在设置里改过的地址），这里复用它。
 */
export function liveUrl(f) {
  try {
    const { hostname, pathname } = new URL(f.url);
    const engine = new URL(API);
    return `${engine.protocol}//${hostname}.localhost${engine.port ? ':' + engine.port : ''}${dirPath(pathname)}`;
  } catch { return '#'; }
}

/** 备用入口：不依赖 *.localhost 解析，但前缀会进 location.pathname（SPA 站点会落到它自己的 404）。
 *  同样指向**引擎**的 origin —— dev 下 Vite 没有 /lm 的代理，相对路径会命中 SPA 回退。 */
export function liveAltUrl(f) {
  try {
    return `${API}/lm/${new URL(f.url).host}${dirPath(new URL(f.url).pathname)}`;
  } catch { return '#'; }
}

/** 目录型路径补尾斜杠；文件型路径（带扩展名）原样 */
function dirPath(pathname) {
  let p = pathname.replace(/\/+$/, '');
  if (!/\.[a-z0-9]+$/i.test(p)) p += '/';
  return p || '/';
}
