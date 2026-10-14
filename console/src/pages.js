/**
 * pages — 页面标识与 URL 推导（父组件与详情面板都要用）
 *
 * 产物目录名由 core 决定，控制台从 /api/pages 或 /api/forge 接收 pageName。
 * 未锻造节点的回退名字仅用于任务开始前显示。
 */

import { API, apiHeaders, tokenOf } from './api.js';

/**
 * 输入框里的地址 → 站点级 URL（**只留 origin**）。侦察是按站点跑的，路径无意义。
 * 补协议、去路径、去查询。空串表示输入无效。
 */
export function normalizeSiteUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try { return new URL(/^https?:\/\//.test(s) ? s : 'https://' + s).origin; } catch { return ''; }
}

/**
 * 输入框里的地址 → **页面级** URL（保留路径）。「只克隆此页」用这个。
 *
 * 为什么必须有两个：这两个函数此前是一个（返回 `new URL(s).origin`），
 * 而「只克隆此页」也复用了它 —— 于是填 `apify.com/store` 会**悄悄克隆成首页**。
 * 实测证据就是「进行中」轨道上的目标写着 `apify.com/home`，
 * 而用户点的是那个按钮、输入框里明明带着 `/store`。
 * 标签写着"这一个页面"，代码却拿走整站根，是那种不报错、只是做错事的错。
 */
export function normalizePageUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try { const u = new URL(/^https?:\/\//.test(s) ? s : 'https://' + s); u.hash = ''; return u.href; } catch { return ''; }
}

/** Workspace directories use hostname without a port or leading www. */
export function workspaceHostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 页面清单的可读路径保留 query；`/list?page=1/2` 是两条不同页面。 */
export function pagePathOf(node) {
  try { const url = new URL(node?.url); return url.pathname + url.search; }
  catch { return String(node?.path ?? ''); }
}

/** 已有产物以引擎返回的 pageName 为准；回退值只作临时显示。 */
export function pageNameOf(n) {
  if (n?.pageName) return n.pageName;
  try {
    const p = new URL(n.url).pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[/?&#]+/g, '-').slice(0, 60);
    return p || 'home';
  } catch {
    return n.path === '/' ? 'home' : String(n.path || '').replace(/^\//, '').replace(/[/?&#]+/g, '-') || 'home';
  }
}

/**
 * 交互镜像地址：保留脚本、资源实时回原站的独立域名入口。
 *
 * 独立域名保留站点自己的 pathname，并让 cookie 与 localStorage 按站点隔离。
 * 依赖 *.localhost 解析到本机；解析失败时需要修正本机 DNS/代理设置。
 * Token 模式先经过引擎主域 /api/mirror-launch：主域会话换一次性短期票据，
 * 子域兑换票据建立自己的会话后跳到无票据的站点路径，SPA 仍看到原站 pathname。
 *
 * **目录型路径必须带尾斜杠**，让页内相对引用落在页面所在目录。
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
    const target = new URL(f.url);
    if (!localEngineSupportsMirror()) return '#';
    target.pathname = dirPath(target.pathname);
    target.hash = '';
    return `${API}/api/mirror-launch?url=${encodeURIComponent(target.href)}`;
  } catch { return '#'; }
}

export function localEngineSupportsMirror() {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(API).hostname); }
  catch { return false; }
}

export function mirrorBridgeNeeded() {
  try { return !!tokenOf() && new URL(API).origin !== location.origin; }
  catch { return false; }
}

/** Different origins need a Token-bearing request to establish the engine's browser session. */
export async function openMirrorWithTicket(f) {
  if (!localEngineSupportsMirror()) throw new Error('独立子域镜像需要本机引擎地址');
  const target = new URL(f.url);
  target.pathname = dirPath(target.pathname);
  target.hash = '';
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  try {
    const response = await fetch(`${API}/api/mirror-ticket`, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url: target.href, mode: 'root' }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `引擎返回 ${response.status}`);
    const siteId = String(body.siteId ?? '');
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/i.test(siteId) || siteId === '.' || siteId === '..') {
      throw new Error('引擎返回了无效的站点标识');
    }
    if (body.origin !== target.origin) {
      throw new Error('引擎返回的站点来源与目标不一致');
    }
    const next = new URL(body.url, API);
    const engine = new URL(API);
    const expectedHost = `${siteId}.localhost`;
    if (next.protocol !== engine.protocol || next.username || next.password
        || next.hostname !== expectedHost || next.pathname !== '/.heimdall/session'
        || next.port !== engine.port || !next.searchParams.get('ticket')) {
      throw new Error('引擎返回了无效的镜像授权地址');
    }
    if (popup && !popup.closed) popup.location.replace(next.href);
    else window.location.assign(next.href);
  } catch (error) {
    try { popup?.close(); } catch {}
    throw error;
  }
}

/** 目录型路径补尾斜杠；文件型路径（带扩展名）原样 */
function dirPath(pathname) {
  let p = pathname.replace(/\/+$/, '');
  if (!/\.[a-z0-9]+$/i.test(p)) p += '/';
  return p || '/';
}
