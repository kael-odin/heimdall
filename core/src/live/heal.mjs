/**
 * live/heal — 导出期自愈：把离线缺失的同站资源补进 site/live
 *
 * 背景：活动页/老页面可能没留下 network.har，导致交互镜像离线时
 * chunk / 字体 / favicon / tab 图标 404。导出时（--heal）从原站抓取
 * 这些仍然可用的资源并落盘，使离线包尽量自包含。
 *
 * 规则：
 *   - 只处理同站、非 /static/<host>/（克隆件已在包里）、非动态端点（/_next/image 等）
 *   - 同一路径可能带多个部署变体（?dpl=…）：逐个尝试直到命中，落盘位置只按路径
 *   - 200 且体积 ≤ maxBytes 才写入；并发受控；失败不阻断导出，计入 failed
 *
 * 入口：healBundle({ liveDir, host, origin, targets, fetchImpl?, concurrency?, maxBytes? })
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { UA } from '../ua.mjs';

const DYNAMIC_ENDPOINT = /^\/(?:_next\/image|_next\/data|api\/|cdn-cgi\/)/;

const extOk = (path, mime) => {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!m) return true;
  if (/\.js$/i.test(path)) return /javascript|ecmascript|text\/plain|application\/octet-stream/.test(m);
  if (/\.css$/i.test(path)) return /text\/css|text\/plain|application\/octet-stream/.test(m);
  if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return /font|application\/octet-stream/.test(m);
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(path)) return /image|application\/octet-stream/.test(m);
  if (/\.json$/i.test(path)) return /json|text\/plain|application\/octet-stream/.test(m);
  return true;
};

export async function healBundle({
  liveDir, host, origin, targets = [],
  fetchImpl = globalThis.fetch,
  concurrency = 6,
  maxBytes = 20 * 1024 * 1024,
  timeoutMs = 20_000,
} = {}) {
  const results = { fetched: 0, failed: 0, skipped: 0, bytes: 0, variants: 0, reasons: {}, items: [] };
  const bump = (k) => { results.reasons[k] = (results.reasons[k] ?? 0) + 1; };
  const byPath = new Map();
  for (const raw of targets) {
    const t = String(raw ?? '').trim();
    if (!t || !t.startsWith('/')) continue;
    const path = t.split('?')[0].split('#')[0];
    if (!path || path.endsWith('/')) { results.skipped++; bump('not-a-file'); continue; }
    if (DYNAMIC_ENDPOINT.test(path)) { results.skipped++; bump('dynamic-endpoint'); continue; }
    const list = byPath.get(path) ?? [];
    if (list.length < 4 && !list.includes(t)) list.push(t);
    byPath.set(path, list);
  }
  const queue = [...byPath.entries()];
  results.variants = queue.reduce((a, [, v]) => a + v.length, 0);
  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      const [path, variants] = queue[idx++];
      let done = false;
      for (const target of variants) {
        try {
          const res = await fetchImpl(origin + target, {
            headers: {
              'user-agent': UA,
              accept: '*/*',
              referer: origin + '/',
            },
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
          });
          if (!res.ok) { bump('http-' + res.status); continue; }
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxBytes) { results.skipped++; bump('too-large'); done = true; break; }
          if (!extOk(path, res.headers.get('content-type'))) { results.skipped++; bump('mime-mismatch'); done = true; break; }
          const file = join(liveDir, path.replace(/^\/+/, ''));
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, buf);
          results.fetched++;
          results.bytes += buf.length;
          results.items.push({ path, url: target, status: res.status, bytes: buf.length });
          done = true;
          break;
        } catch (e) {
          bump('error');
          results.items.push({ path, url: target, error: String(e).slice(0, 120) });
        }
      }
      if (!done) results.failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));
  return results;
}

/**
 * 把 HAR 中可回放的响应体落盘为 site/live 实体文件（离线更稳，且能覆盖同路径的其它查询变体）。
 * 只处理：同源 GET 200 有 body、无查询串、非目录路径。带查询的（如 /_next/image?…）继续走 HAR 回放。
 */
export function materializeHar({ liveDir, origin, entries = [] } = {}) {
  const out = { written: 0, skipped: 0, bytes: 0 };
  const seen = new Set();
  for (const e of entries) {
    if (e.method !== 'GET' || !e.body || e.status !== 200) continue;
    let u;
    try { u = new URL(e.url); } catch { continue; }
    if (u.origin !== origin) continue;
    if (u.search) { out.skipped++; continue; }
    const path = u.pathname;
    if (!path || path === '/' || path.endsWith('/')) { out.skipped++; continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const file = join(liveDir, path.replace(/^\/+/, ''));
    if (existsSync(file)) { out.skipped++; continue; }
    const buf = Buffer.from(e.body, 'base64');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
    out.written++;
    out.bytes += buf.length;
  }
  return out;
}

const MIME_EXT = [
  [/^image\/webp/i, 'webp'], [/^image\/png/i, 'png'], [/^image\/jpe?g/i, 'jpg'], [/^image\/avif/i, 'avif'],
  [/^image\/gif/i, 'gif'], [/^image\/svg/i, 'svg'], [/^image\/x-icon|vnd\.microsoft\.icon/i, 'ico'],
  [/^font\/woff2/i, 'woff2'], [/^font\/woff/i, 'woff'], [/^text\/css/i, 'css'], [/^text\/html/i, 'html'],
];
export const mimeExt = (mime) => {
  const m = String(mime || '');
  for (const [re, ext] of MIME_EXT) if (re.test(m)) return ext;
  return 'bin';
};

/**
 * 把 HAR 中带查询的同源响应（典型：/_next/image?url=…&w=…&q=…）落盘为 _ext/<sha1>.<ext>，
 * 返回 url → 相对路径 的改写表（同时覆盖绝对/根相对//lm/<host> 三种写法）。
 * 页面里用相对路径（_ext/…）替换，配合 <base href="/lm/<host>/"> 在 landing/mirror 两种模式都能命中。
 */
export function localizeQueryEntries({ entries = [], liveDir, host, origin } = {}) {
  const map = new Map();
  const out = { written: 0, skipped: 0, bytes: 0 };
  for (const e of entries) {
    if (e.method !== 'GET' || !e.body || e.status !== 200) continue;
    let u;
    try { u = new URL(e.url); } catch { continue; }
    const sameOrigin = u.origin === origin;
    const isImage = /^image\//i.test(e.mimeType || '');
    if (sameOrigin && !u.search) continue;      // 同源无查询：materializeHar 已落盘
    if (!sameOrigin && !isImage) continue;      // 站外只本地化图片（追踪脚本等留在外网）
    const rel = '_ext/' + createHash('sha1').update(e.url).digest('hex').slice(0, 16) + '.' + mimeExt(e.mimeType);
    // 页面 <base> 是页面级作用域（/lm/<host>/<page>/），相对路径会指错目录 → 用 /lm/<host>/_ext/... 绝对路径
    const publicPath = '/lm/' + host + '/' + rel;
    const file = join(liveDir, rel);
    if (!existsSync(file)) {
      const buf = Buffer.from(e.body, 'base64');
      mkdirSync(join(liveDir, '_ext'), { recursive: true });
      writeFileSync(file, buf);
      out.written++;
      out.bytes += buf.length;
    } else out.skipped++;
    map.set(e.url, publicPath);
    if (sameOrigin) {
      map.set(u.pathname + u.search, publicPath);
      if (host) map.set('/lm/' + host + u.pathname + u.search, publicPath);
    }
  }
  return { map, ...out };
}

/** 在 site/live 的所有 HTML 中把改写表里的 URL 换成相对本地路径（兼容 &amp; 转义） */
export function rewriteHtmlRefs({ liveDir, map }) {
  const out = { files: 0, rewrites: 0 };
  if (!map?.size) return out;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.html?$/i.test(n)) {
        let text = readFileSync(p, 'utf8');
        let hits = 0;
        const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const k of keys) {
          const to = map.get(k);
          for (const variant of [k, k.replace(/&/g, '&amp;')]) {
            // 边界感知：避免命中更长 URL 的子串（如 /lm/www.host/_next/… 里的 /_next/…）
            const re = new RegExp('(?<![\\w.-])' + esc(variant), 'g');
            const n = (text.match(re) || []).length;
            if (!n) continue;
            hits += n;
            text = text.replace(re, to);
          }
        }
        // 写时复制：导出包与 workspace 是硬链接，直接写会连带改坏源文件 → 先写临时文件再改名断链
        if (hits) { writeFileSync(p + '.heimdall-tmp', text); renameSync(p + '.heimdall-tmp', p); out.files++; out.rewrites += hits; }
      }
    }
  };
  walk(liveDir);
  return out;
}
