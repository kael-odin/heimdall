/**
 * 引擎 API 客户端 —— 控制台里**唯一**的 URL 拼接处。
 *
 * 工作区文件统一走引擎的 /static/，由引擎检查 HEIMDALL_TOKEN；
 * Vite 不直接公开 core/workspace。缺失 JSON 仍需检查 content-type，
 * 避免 SPA 回退把 index.html 当成 JSON。
 */

const DEV_PORTS = ['5173', '5174', '5175'];

/** 引擎 API 直连（vite proxy 会缓冲实时 SSE，引擎侧 CORS 已开放）。
 *  单端口部署时与引擎同源；dev 下直连 :8900 以避免代理缓冲 SSE。 */
export function normalizeApiBase(value) {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch { return ''; }
}

const defaultApi = DEV_PORTS.includes(location.port) || !/^https?:/.test(location.protocol)
  ? 'http://127.0.0.1:8900' : location.origin;
export const API = normalizeApiBase(localStorage.getItem('heimdall-api')) || defaultApi;

export const tokenOf = () => localStorage.getItem('heimdall-token') ?? '';

export function apiHeaders() {
  const t = tokenOf();
  return { 'Content-Type': 'application/json', ...(t ? { 'x-heimdall-token': t } : {}) };
}

/** workspace 文件的规范 URL。`rel` 相对站点根，如 'verify/home/verify.json'。 */
export function wsUrl(host, rel) {
  return staticUrl('/static/' + encodeURIComponent(host) + '/' + String(rel).replace(/^\/+/, ''));
}

/** 只接受引擎自身的静态产物地址，防止报告索引把浏览器带到其他源。 */
export function staticUrl(path) {
  try {
    const url = new URL(path, API);
    return url.origin === API && url.pathname.startsWith('/static/') && !url.username && !url.password
      ? url.href : '';
  } catch { return ''; }
}

export function staticBridgeNeeded() {
  try { return !!tokenOf() && new URL(API).origin !== location.origin; }
  catch { return false; }
}

/** 可直接用于 <a href> 的产物入口；原生新标签导航也要先在控制台同源领票。 */
export function artifactOpenUrl(path) {
  const target = staticUrl(path);
  if (!target || !staticBridgeNeeded()) return target;
  const artifact = new URL(target);
  const bridge = new URL('/', location.origin);
  bridge.searchParams.set('artifact', artifact.pathname + artifact.search);
  return bridge.href;
}

export function wsOpenUrl(host, rel) {
  return artifactOpenUrl(wsUrl(host, rel));
}

/** 跨主机控制台无法替静态导航附加请求头；用一次性票据建立引擎主域会话。 */
export async function openArtifactWithTicket(path, { newTab = true } = {}) {
  const target = staticUrl(path);
  if (!target) throw new Error('无效的产物地址');
  const popup = newTab ? window.open('about:blank', '_blank') : null;
  if (popup) popup.opener = null;
  try {
    const url = new URL(target);
    const response = await fetch(`${API}/api/artifact-ticket`, {
      method: 'POST', headers: apiHeaders(), credentials: 'omit',
      body: JSON.stringify({ path: url.pathname + url.search }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `引擎返回 ${response.status}`);
    const next = new URL(body.url, API);
    if (next.origin !== API || next.pathname !== '/.heimdall/session'
        || !next.searchParams.get('ticket') || next.username || next.password) {
      throw new Error('引擎返回了无效的产物授权地址');
    }
    if (popup && !popup.closed) popup.location.replace(next.href);
    else window.location.assign(next.href);
  } catch (error) {
    try { popup?.close(); } catch {}
    throw error;
  }
}

/** 取 workspace 的 JSON。**取不到就返回 null，不抛** —— 调用方按「没跑过」处理。 */
export function wsJson(host, rel) {
  return fetch(wsUrl(host, rel), { headers: apiHeaders() })
    .then(r => (r.ok && (r.headers.get('content-type') ?? '').includes('json')) ? r.json() : null)
    .catch(() => null);
}

// 这里原本还有 apiFetch / apiJson / apiPost 三个"调引擎 API"的封装，从建库起就没人用过：
// 所有请求都写在各自的处理器里（要接 SSE、要记任务行、要挑错误文案），封装省不掉那几行，
// 于是只留下一个并行的第二套写法。删掉 —— 留着一个"看起来该用"的死入口，比没有更误导。
