/**
 * 引擎 API 客户端 —— 控制台里**唯一**的 URL 拼接处。
 *
 * 为什么值得单独一个文件：控制台里有两套等价的取 workspace 文件写法，
 * 混用了很久，每次新增一处都要重新判断用哪个。引擎两条路都支持：
 *
 *   /static/<host>/<path>   引擎显式路由（engine-server: /static/ 前缀）
 *   /<host>/<path>          引擎的 workspace 静态兜底（等价 Vite publicDir，
 *                           也等价 dev 时 vite 的 publicDir 设置）
 *
 * 两者当前都返回正确内容，实测过存在的文件（200 + JSON）与缺失的文件（404 + JSON）。
 * 统一走 /static/ 的理由不是"另一个坏了"，而是：
 *   · 它是**显式**路由，语义不会随开发/生产模式改变；
 *   · /<host>/ 这个命名空间在活镜像语境里是有含义的（/lm/<host>/ 的镜像路径），
 *     现在靠兜底顺序才没撞上，将来加路由容易出事；
 *   · 缺失文件没有扩展名时，控制台 SPA 回退会把它变成 **200 + index.html**，
 *     调用方的 r.json() 抛错后被 catch 吞掉，表现为"没有数据"而不是"路径写错了"。
 *     wsJson() 里的 content-type 检查就是为了让这种情况不可能发生。
 */

const DEV_PORTS = ['5173', '5174', '5175'];

/** 引擎 API 直连（vite proxy 会缓冲实时 SSE，引擎侧 CORS 已开放）。
 *  单端口部署时与引擎同源；dev 下直连 :8900 以避免代理缓冲 SSE。 */
export const API = localStorage.getItem('heimdall-api')
  ?? (DEV_PORTS.includes(location.port) || !/^https?:/.test(location.protocol) ? 'http://127.0.0.1:8900' : location.origin);

export const tokenOf = () => localStorage.getItem('heimdall-token') ?? '';

export function apiHeaders() {
  const t = tokenOf();
  return { 'Content-Type': 'application/json', ...(t ? { 'x-heimdall-token': t } : {}) };
}

/** workspace 文件的规范 URL。`rel` 相对站点根，如 'verify/home/verify.json'。 */
export function wsUrl(host, rel) {
  return '/static/' + host + '/' + String(rel).replace(/^\/+/, '');
}

/** 取 workspace 的 JSON。**取不到就返回 null，不抛** —— 调用方按「没跑过」处理。 */
export function wsJson(host, rel) {
  return fetch(wsUrl(host, rel))
    .then(r => (r.ok && (r.headers.get('content-type') ?? '').includes('json')) ? r.json() : null)
    .catch(() => null);
}

/** 调引擎 API。init.method 省略即 GET。 */
export function apiFetch(path, init = {}) {
  return fetch(API + path, { ...init, headers: { ...apiHeaders(), ...(init.headers ?? {}) } });
}

/** 调引擎 API 并解析 JSON；失败返回 null。 */
export function apiJson(path, init) {
  return apiFetch(path, init).then(r => (r.ok ? r.json() : null)).catch(() => null);
}

/** 按引擎任务约定发一个 POST，返回 { taskId } 或 { error }。 */
export function apiPost(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
    .then(async r => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) }))
    .catch(e => ({ ok: false, error: String(e) }));
}
