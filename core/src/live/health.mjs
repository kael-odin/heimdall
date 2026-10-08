/**
 * live/health — 活镜像离线体检（纯静态：无浏览器、无网络）
 *
 * 从 site/live 的 HTML/CSS 出发，按 serve.mjs 的同一套解析规则
 * （本地快照 → HAR 回放）逐条检查引用，输出 health.json：
 *   资源（assets）：
 *     local       站点 live 目录已有该文件（离线可用）
 *     har         HAR 可回放（原站更新后旧 chunk 仍可用）
 *     unresolved  同站资源，离线模式下会 404 —— 交付阻断项
 *     external    站外域名；其中静态资源离线一定裂，单独列 externalAssetsTop
 *   链接（links）：站内 <a href> 指向的页面是否已在镜像里（missing = 未镜像页面）
 *
 * 入口：scanLiveBundle({ liveDir, host, origin, harIndex })
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, extname } from 'node:path';
import { matchHar } from './har.mjs';

const SKIP_REF = /^(?:data:|blob:|about:|javascript:|mailto:|tel:|#)/i;
const ASSET_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|css|js|mjs|mp4|webm|mp3|pdf)(?:$|[?#])/i;
const ASSET_REL = /stylesheet|icon|preload|modulepreload|manifest|prefetch/i;
const MAX_UNRESOLVED = 200;
const MAX_FILES = 4000;

const stripHash = (u) => String(u ?? '').split('#')[0].trim();
const decodeEntities = (u) => String(u).replace(/&amp;/gi, '&');

/** 把一条引用解析成站内路径 / 站外标记 / null（跳过） */
export function resolveRefPath(raw, { host, basePath = '/' } = {}) {
  const clean = decodeEntities(stripHash(raw));
  if (!clean || SKIP_REF.test(clean)) return null;
  let u = clean;
  if (u.startsWith('//')) u = 'https:' + u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    let parsed;
    try { parsed = new URL(u); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const targetHost = String(host).replace(/^www\./, '');
    if (parsed.hostname.replace(/^www\./, '') !== targetHost) return { external: true };
    return { path: parsed.pathname || '/', search: parsed.search };
  }
  // 根相对/相对引用：先切掉 query（Next 会产出 favicon.ico?x.ico?dpl=… 这种双 ? 形式）
  const q = u.indexOf('?');
  const pathPart = q >= 0 ? u.slice(0, q) : u;
  const search = q >= 0 ? u.slice(q) : '';
  const abs = pathPart.startsWith('/') ? posix.normalize(pathPart) : posix.normalize(posix.join(basePath || '/', pathPart));
  // /lm/<host>/ 或 /lm/<host:port>/ 前缀（本地 fixture 会带端口）
  const lm = /^\/lm\/([^/]+)(\/.*)?$/.exec(abs);
  if (lm) {
    const seg = lm[1].toLowerCase();
    const h = String(host).toLowerCase().replace(/^www\./, '');
    const bare = seg.replace(/^www\./, '');
    if (bare === h || bare.startsWith(h + ':')) return { path: lm[2] ?? '/', search };
  }
  return { path: abs, search };
}

/** serveLive 的候选文件规则：目录 → index.html，无扩展名 → 目录/文件都试 */
function candidatesFor(p) {
  const rel = String(p ?? '/').replace(/^\/+/, '');
  if (!rel) return ['index.html'];
  if (/\.[a-z0-9]+$/i.test(rel)) return [rel];
  return [rel.replace(/\/$/, '') + '/index.html', rel];
}

function fileFor(liveDir, p, staticDir = null, host = '') {
  for (const c of candidatesFor(p)) {
    const f = join(liveDir, c);
    try { if (statSync(f).isFile()) return f; } catch {}
  }
  if (staticDir && host) {
    for (const prefix of ['/static/' + host + '/', '/static/www.' + host + '/']) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      for (const c of candidatesFor(rest)) {
        const f = join(staticDir, host, c);
        try { if (statSync(f).isFile()) return f; } catch {}
      }
    }
  }
  return null;
}

function attr(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(tag);
  return m ? m[1] : null;
}

/** 返回 [{ url, kind: 'asset' | 'link' }] */
export function extractRefs(text, kind) {
  const out = [];
  if (kind === 'css') {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) out.push({ url: m[1], kind: 'asset' });
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) out.push({ url: m[1], kind: 'asset' });
    return out;
  }
  for (const m of text.matchAll(/<(a|link|script|img|source|video|audio|iframe|embed|track|input)\b[^>]*>/gi)) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    if (name === 'a') { const h = attr(tag, 'href'); if (h) out.push({ url: h, kind: 'link' }); continue; }
    if (name === 'link') {
      const h = attr(tag, 'href');
      if (h) out.push({ url: h, kind: ASSET_REL.test(attr(tag, 'rel') ?? '') ? 'asset' : 'link' });
      continue;
    }
    for (const n of ['src', 'poster']) { const v = attr(tag, n); if (v) out.push({ url: v, kind: 'asset' }); }
    const ss = attr(tag, 'srcset');
    if (ss) for (const part of ss.split(',')) { const u = part.trim().split(/\s+/)[0]; if (u) out.push({ url: u, kind: 'asset' }); }
  }
  return out;
}

function pageFiles(liveDir) {
  const pages = [];
  const walk = (dir, rel) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, rel ? rel + '/' + n : n);
      else if (n === 'index.html') pages.push(rel ? '/' + rel + '/' : '/');
    }
  };
  walk(liveDir, '');
  return pages.sort();
}

function scanPage(liveDir, pagePath, { host, origin, harIndex, staticDir }) {
  const visited = new Set();
  const queue = [{ path: pagePath, kind: 'html', base: posix.dirname(pagePath) + '/' }];
  const out = {
    assets: { total: 0, local: 0, har: 0, unresolvedCount: 0, dynamic: 0, unresolved: [], external: 0, externalAssetUrls: [] },
    links: { total: 0, local: 0, missing: [] },
  };
  while (queue.length && visited.size < MAX_FILES) {
    const item = queue.shift();
    const file = fileFor(liveDir, item.path, staticDir, host);
    if (!file) continue;
    const key = file + '|' + item.kind;
    if (visited.has(key)) continue;
    visited.add(key);
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let base = item.base;
    if (item.kind === 'html') {
      const bm = /<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(text);
      if (bm) {
        const br = resolveRefPath(bm[1], { host, basePath: item.base });
        if (br && !br.external) base = br.path.endsWith('/') ? br.path : posix.dirname(br.path) + '/';
      }
    }
    for (const ref of extractRefs(text, item.kind)) {
      const r = resolveRefPath(ref.url, { host, basePath: base });
      if (!r) continue;
      if (r.external) {
        if (ref.kind !== 'asset') continue;
        out.assets.external++;
        const clean = decodeEntities(stripHash(ref.url)).slice(0, 300);
        if (ASSET_EXT.test(clean)) out.assets.externalAssetUrls.push(clean);
        continue;
      }
      const target = (r.path || '/') + (r.search || '');
      const localFile = fileFor(liveDir, r.path, staticDir, host);
      if (ref.kind === 'link') {
        out.links.total++;
        if (localFile) out.links.local++;
        else if (out.links.missing.length < MAX_UNRESOLVED) out.links.missing.push(target);
        continue;
      }
      out.assets.total++;
      if (localFile) {
        out.assets.local++;
        if (extname(r.path).toLowerCase() === '.css') queue.push({ path: r.path, kind: 'css', base: posix.dirname(r.path) + '/' });
        continue;
      }
      if (harIndex && (matchHar(harIndex, 'GET', origin + target) || matchHar(harIndex, 'GET', origin + r.path))) { out.assets.har++; continue; }
      if (/^\/(?:_next\/image|_next\/data)\b/.test(target)) { out.assets.dynamic++; continue; }
      out.assets.unresolvedCount++;
      if (out.assets.unresolved.length < MAX_UNRESOLVED) out.assets.unresolved.push(target);
    }
  }
  return out;
}

/** 扫描整个活镜像目录，返回可写入 health.json 的报告对象 */
export function scanLiveBundle({ liveDir, host, origin, harIndex, staticDir = null }) {
  const pages = pageFiles(liveDir);
  const details = [];
  const externalAssets = new Map();
  const assets = { total: 0, local: 0, har: 0, unresolved: 0, dynamic: 0, external: 0, externalAssets: 0 };
  const unresolvedPaths = new Set();
  const links = { total: 0, local: 0, missing: 0 };
  for (const pagePath of pages.slice(0, 1000)) {
    const r = scanPage(liveDir, pagePath, { host, origin, harIndex, staticDir });
    assets.total += r.assets.total;
    assets.local += r.assets.local;
    assets.har += r.assets.har;
    assets.external += r.assets.external;
    assets.unresolved += r.assets.unresolvedCount;
    assets.dynamic += r.assets.dynamic ?? 0;
    for (const u of r.assets.unresolved) { if (unresolvedPaths.size < 5000) unresolvedPaths.add(u); }
    links.total += r.links.total;
    links.local += r.links.local;
    links.missing += r.links.missing.length;
    if (r.assets.unresolvedCount) {
      details.push({ page: pagePath, unresolvedCount: r.assets.unresolvedCount, unresolved: r.assets.unresolved, refs: { total: r.assets.total, local: r.assets.local, har: r.assets.har } });
    }
    for (const url of r.assets.externalAssetUrls) {
      assets.externalAssets++;
      const cur = externalAssets.get(url) ?? { url, pages: [] };
      if (cur.pages.length < 5 && !cur.pages.includes(pagePath)) cur.pages.push(pagePath);
      externalAssets.set(url, cur);
    }
  }
  return {
    version: 1,
    host,
    origin,
    generatedAt: new Date().toISOString(),
    pages: pages.length,
    assets,
    links,
    pagesWithUnresolved: details.length,
    unresolvedPaths: [...unresolvedPaths],
    details: details.slice(0, 40),
    externalAssetsTop: [...externalAssets.values()].slice(0, 25),
  };
}
