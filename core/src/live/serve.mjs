#!/usr/bin/env node
/**
 * live/serve — 独立可部署的交互镜像服务器（零依赖 Node）
 *
 * 路由：
 *   /                         默认落地页（landing.html）；--root mirror 时直接就是交互镜像
 *   /lm/<host>/<path>         本地 live 快照优先 → HAR 回放 → 原站代理（offline 时 404）
 *   /static/<host>/<path>     本地静态产物（克隆页 / CSS / 资产）
 *   /__heimdall/health        健康检查
 *
 * 用法：
 *   node serve.mjs [--port 8080] [--offline] [--no-replay] [--root landing|mirror] [--config heimdall-live.json]
 *
 * 配置（heimdall-live.json）：
 *   { "host": "apify.com", "origin": "https://apify.com", "port": 8080, "offline": false, "replayApi": true, "root": "landing" }
 *   root=mirror：镜像直接挂在 /（drop-in 替代部署），/lm/<host>/ 仍作为别名可用。
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexHar, isReplayableReadOnlyDataEntry, matchHar } from './har.mjs';
import { liveSnapshotCandidates } from './live-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

/**
 * 参数解析**故意在本文件里自带一份，不从 ../args.mjs 导入**。
 *
 * 这个文件会被 export.mjs 原样拷进交付包，而包里只有 serve.mjs 与 har.mjs ——
 * 任何指向包外的 import 都会让部署出去的服务直接起不来
 * （`Cannot find module .../args.mjs`，实测踩到过）。交付包里的文件必须零外部依赖。
 */
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--' + name + '='));
  return eq ? eq.slice(name.length + 3) : def;
};
const has = (name) => argv.includes('--' + name);

const cfgPath = argOf('config', join(HERE, 'heimdall-live.json'));
let cfg = { host: 'localhost', origin: 'http://localhost', port: 8080, offline: false, replayApi: true };
try { cfg = { ...cfg, ...JSON.parse(readFileSync(cfgPath, 'utf8')) }; }
catch {
  if (existsSync(cfgPath)) {
    console.error('[heimdall-live] invalid configuration');
    process.exit(1);
  }
}
const HOST = cfg.siteId ?? cfg.host;
const ORIGIN = cfg.origin.replace(/\/$/, '');
const PORT = Number(argOf('port', process.env.PORT ?? cfg.port ?? 8080));
const OFFLINE = has('offline') || !!cfg.offline || cfg.adapter === true;
const REPLAY = !has('no-replay') && cfg.replayApi !== false;
const ROOT_MODE = (argOf('root', cfg.root ?? 'landing') === 'mirror');
/**
 * 监听地址。**默认 0.0.0.0，和引擎相反（引擎显式绑回环）——这是有意的**：
 * 这个脚本的产物是**交付包**，用户的用法是 `docker compose up` 或丢到内网服务器，
 * 绑回环等于部署完外面访问不到。但也正因为它默认对外，日志必须把实际地址**说清楚**，
 * 不能像以前那样永远打印 127.0.0.1（实际却 listen 在所有网卡上）—— 那是会误导人的。
 * 只在本机看就用 `--host 127.0.0.1`。
 */
const BIND = argOf('host', process.env.HEIMDALL_LIVE_HOST ?? cfg.bind ?? '0.0.0.0');

const SITE = join(HERE, 'site');
const LIVE = join(SITE, 'live');
const STATIC = join(SITE, 'static');
const LANDING = join(HERE, 'landing.html');
let adapterRuntime = null;
if (existsSync(join(HERE, 'runtime-adapter')) && cfg.adapter !== true) {
  console.error('[heimdall-live] adapter files present but not enabled');
  process.exit(1);
}
if (cfg.adapter !== undefined && cfg.adapter !== false && cfg.adapter !== true) {
  console.error('[heimdall-live] invalid adapter configuration');
  process.exit(1);
}
if (cfg.adapter === true) {
  try {
    const runtime = await import('./adapter-runtime.mjs');
    const adapter = await runtime.loadRuntimeAdapter(HERE, process.env.HEIMDALL_RUNTIME_DATA_DIR);
    adapterRuntime = { ...runtime, adapter };
  } catch {
    console.error('[heimdall-live] adapter initialization failed');
    process.exit(1);
  }
}

let HAR_INDEX = new Map();
let HAR_ENTRIES = 0;
const HAR_BY_QUERY = new Map();   // pathname|url参数 → 任意已捕获尺寸（图片优化端点回退）
try {
  const har = JSON.parse(readFileSync(join(HERE, 'har.json'), 'utf8'));
  const replayable = (har.entries ?? []).filter(e => e?.kind !== 'public-read-only-data'
    || isReplayableReadOnlyDataEntry(e, ORIGIN));
  HAR_INDEX = indexHar(replayable);
  HAR_ENTRIES = replayable.length;
  for (const e of replayable) {
    try {
      const x = new URL(e.url);
      if (x.origin !== ORIGIN || e.kind === 'public-read-only-data' || !/^\/_next\/image$/i.test(x.pathname)
        || !/^image\//i.test(String(e.mimeType ?? ''))) continue;
      const target = x.searchParams.get('url');
      if (target) HAR_BY_QUERY.set(x.pathname + '|' + target, e);
    } catch {}
  }
} catch {}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.rss': 'application/rss+xml; charset=utf-8', '.atom': 'application/atom+xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.weba': 'audio/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const mimeOf = (file) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
const safeJoin = (root, rel) => {
  const file = normalize(join(root, rel));
  const r = relative(root, file);
  return r && !r.startsWith('..') && !isAbsolute(r) ? file : null;
};
const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, ...extra });
  res.end(buf);
};
const sendFile = (res, file, extra = {}) => {
  if (!file || !existsSync(file)) return false;
  let st; try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;   // 目录绝不进 readFileSync（EISDIR）
  const buf = readFileSync(file);
  res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(buf);
  return true;
};
function staticDocumentHeaders(req, file, compareView = false) {
  const type = mimeOf(file).split(';', 1)[0];
  if (type === 'text/html') return { 'Content-Security-Policy': compareView
    ? "script-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'"
    : 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation' };
  if (type === 'image/svg+xml' || type === 'application/xml' || type === 'application/xhtml+xml') {
    const headers = { 'Content-Security-Policy': 'sandbox' };
    const dest = req.headers['sec-fetch-dest'];
    if (dest === 'document' || (!dest && String(req.headers.accept ?? '').includes('text/html'))) {
      headers['Content-Disposition'] = 'attachment';
    }
    return headers;
  }
  return {};
}
function sendCompare(req, res, file) {
  const nonce = randomBytes(16).toString('base64');
  const original = readFileSync(file, 'utf8');
  const html = original
    .replace(/<script>\r?\n(?=const PAGES = )/, `<script nonce="${nonce}">\n`)
    .replace('<iframe id="frame"></iframe>', '<iframe id="frame" sandbox="allow-same-origin"></iframe>')
    .replace("frame.src = 'pages/' + name + '/clone/index.html';",
      "frame.src = 'pages/' + name + '/clone/index.html?compare=1';");
  return send(res, 200, html, 'text/html; charset=utf-8', {
    'Content-Security-Policy': `script-src 'nonce-${nonce}'; object-src 'none'; form-action 'none'`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
  });
}
const NOT_FOUND = `<!doctype html><meta charset="utf-8"><title>404 · Heimdall Live</title><body style="font-family:system-ui;background:#0b0b10;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#22d3ee">404 · 本地无快照</h1><p style="color:#94a3b8">${OFFLINE ? '离线模式：未捕获的资源不可用。' : '代理失败：原站不可达。'}</p><p><a href="/" style="color:#22d3ee">返回落地页</a></p></div></body>`;

function rewriteHtml(text, targetPath = '/') {
  if (!text) return text;
  let out = text;
  // Older hand-authored bundles sometimes used host as an explicit alias.
  // New bundles carry siteId and rewrite only the exact upstream origin.
  for (const source of [ORIGIN, ...(cfg.siteId ? [] : [`http://${HOST}`, `https://${HOST}`])]) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}(?![a-z0-9_.:@-])`, 'gi');
    const mount = ROOT_MODE ? '' : '/lm/' + HOST;
    out = out.replace(pattern, (match, index, source) => mount || (source[index + match.length] === '/' ? '' : '/'));
  }
  if (!ROOT_MODE) {
    out = out.replace(/<form\b[^>]*>/gi, tag =>
      tag.replace(/(\saction\s*=\s*)(["']?)\/(?!\/|lm\/)/i, `$1$2/lm/${HOST}/`));
  }
  if (!ROOT_MODE && !/<base\b/i.test(out)) {
    const directory = targetPath.replace(/[^/]*$/, '');
    out = out.replace(/<head([^>]*)>/i, `<head$1><base href="/lm/${HOST}${directory}">`);
  }
  return out;
}

function rootSnapshotHtml(text) {
  let out = text;
  const hosts = new Set([HOST, new URL(ORIGIN).host]);
  for (const host of hosts) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`/lm/${escaped}(?![a-z0-9_.:@-])`, 'gi'), '');
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function localLocation(value, target) {
  try {
    const dest = new URL(value, target);
    if (dest.origin !== ORIGIN) return value;
    return (ROOT_MODE ? '' : '/lm/' + HOST) + dest.pathname + dest.search + dest.hash;
  } catch { return value; }
}

async function proxy(req, res, pathAndQuery) {
  const target = ORIGIN + (pathAndQuery.startsWith('/') ? pathAndQuery : '/' + pathAndQuery);
  const headers = {};
  for (const k of ['accept', 'accept-language', 'content-type', 'cookie', 'authorization', 'x-csrf-token', 'x-xsrf-token', 'x-requested-with', 'if-none-match', 'if-modified-since', 'range']) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }
  // This file ships without src/ua.mjs; keep its fallback in sync with that source.
  headers['user-agent'] = req.headers['user-agent'] ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  if (req.headers.origin) headers.origin = ORIGIN;
  try {
    const referer = new URL(req.headers.referer);
    const path = ROOT_MODE ? referer.pathname : referer.pathname.replace(new RegExp('^/lm/' + HOST.replace(/\./g, '\\.') + '(?=/|$)'), '');
    headers.referer = ORIGIN + (path || '/') + referer.search;
  } catch { headers.referer = ORIGIN + '/'; }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  const outHeaders = {};
  for (const [k, v] of upstream.headers) {
    const kl = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'set-cookie', 'connection', 'content-type'].includes(kl)) continue;
    if (kl === 'location') { outHeaders[k] = localLocation(v, target); continue; }
    outHeaders[k] = v;
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) outHeaders['Set-Cookie'] = cookies.map(c => c.replace(/;\s*domain=[^;]+/gi, ''));
  const type = upstream.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) {
    const text = rewriteHtml(await upstream.text(), new URL(target).pathname);
    return send(res, upstream.status, text, type, outHeaders);
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  return send(res, upstream.status, buf, type || 'application/octet-stream', outHeaders);
}

function localizedQueryCandidate(rel, search) {
  if (!search || !/^\/?_ext\//.test(rel)) return null;
  const match = /^\/?_ext\/([^/]+)(\/.*)?$/.exec(rel);
  if (!match) return null;
  const externalDir = match[1];
  let protocol = 'https:';
  let hostname = externalDir;
  let port = '';
  const originMatch = /^(.*)--(https?)(?:-port-(\d+))?$/.exec(externalDir);
  if (originMatch) {
    hostname = originMatch[1];
    protocol = originMatch[2] + ':';
    port = originMatch[3] ? ':' + originMatch[3] : '';
  }
  let sourceUrl;
  try {
    sourceUrl = new URL((match[2] ?? '/') + search, protocol + '//' + hostname + port);
  } catch {
    return null;
  }
  let path = sourceUrl.pathname.replace(/^\/+/, '').replace(/[<>:"|?*\x00-\x1f]/g, '_');
  if (!path || path.endsWith('/')) path += 'index';
  const extension = /(\.[a-z0-9]{1,5})$/i.exec(path);
  if (!extension) return null;
  const digest = createHash('sha1').update(sourceUrl.href).digest('hex').slice(0, 8);
  path = path.slice(0, extension.index) + '~' + digest + extension[1];
  return '_ext/' + externalDir + '/' + path;
}

async function serveLive(req, res, rel, search) {
  if (adapterRuntime && await adapterRuntime.dispatchRuntimeAdapter(adapterRuntime.adapter, req, res, rel, search)) return;
  // 1) local snapshot：带 query 的页面必须精确命中对应快照。
  const candidates = liveSnapshotCandidates(rel, search);
  if (req.method === 'GET' || req.method === 'HEAD') {
    for (const cand of candidates) {
      const local = safeJoin(LIVE, cand);
      if (ROOT_MODE && local && /\.html?$/i.test(local) && existsSync(local) && statSync(local).isFile()) {
        const html = rootSnapshotHtml(readFileSync(local, 'utf8'));
        const body = Buffer.from(html);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
        return req.method === 'HEAD' ? res.end() : res.end(body);
      }
      if (sendFile(res, local, { 'Cache-Control': 'no-cache' })) return;
    }
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const candidate = localizedQueryCandidate(rel, search);
    if (candidate && sendFile(res, safeJoin(LIVE, candidate), {
      'Cache-Control': 'no-cache', 'X-Heimdall-Localized-Query': '1',
    })) return;
  }
  // 2) HAR replay（原站重新部署后旧 chunk 仍可用）
  if (REPLAY && req.method === 'GET') {
    let hit = matchHar(HAR_INDEX, req.method, ORIGIN + rel + search);
    if (!hit && search) {
      // /_next/image?url=…&w=…：精确变体没录到就回退到同一源图的任意已捕获尺寸
      try {
        const target = new URLSearchParams(search).get('url');
        if (target) hit = HAR_BY_QUERY.get(rel + '|' + target) ?? null;
      } catch {}
    }
    if (hit && hit.body) {
      const body = Buffer.from(hit.body, 'base64');
      const replayHeaders = hit.kind === 'public-read-only-data'
        ? { 'Cache-Control': 'no-store' } : { ...hit.headers };
      delete replayHeaders['content-type'];
      res.writeHead(hit.status, { 'Content-Type': hit.mimeType || 'application/octet-stream', 'Content-Length': body.length,
        ...replayHeaders, 'X-Content-Type-Options': 'nosniff', 'X-Heimdall-Replay': '1' });
      return res.end(body);
    }
  }
  // 3) proxy
  if (OFFLINE) return send(res, 404, NOT_FOUND, 'text/html; charset=utf-8');
  try { return await proxy(req, res, rel + search); }
  catch { return send(res, 502, NOT_FOUND, 'text/html; charset=utf-8'); }
}

createServer(async (req, res) => {
  let u, pathname;
  try {
    u = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return send(res, 400, 'bad request');
  }

  if (pathname === '/__heimdall/health') {
    return send(res, 200, JSON.stringify({
      ok: true, host: HOST, origin: ORIGIN, offline: OFFLINE, replay: REPLAY, root: ROOT_MODE ? 'mirror' : 'landing', harEntries: HAR_ENTRIES, uptime: Math.round(process.uptime()),
    }), 'application/json; charset=utf-8');
  }
  if (pathname === '/') {
    if (ROOT_MODE) return serveLive(req, res, '/', u.search);
    if (sendFile(res, LANDING, { 'Cache-Control': 'no-cache' })) return;
    return res.writeHead(302, { Location: '/lm/' + HOST + '/' }).end();
  }
  // 本地静态产物
  if (pathname.startsWith('/static/')) {
    const rel = pathname.slice('/static/'.length);
    const first = rel.split('/')[0];
    if (first === HOST || first === 'www.' + HOST) {
      let file = safeJoin(STATIC, rel);
      const siteRel = rel.slice(first.length + 1);
      if (siteRel === 'compare.html' && file && existsSync(file) && statSync(file).isFile()) {
        return sendCompare(req, res, file);
      }
      const compareView = u.searchParams.get('compare') === '1'
        && /^pages\/[^/]+\/clone\/[^/]+\.html?$/i.test(siteRel);
      if (file && compareView && siteRel.endsWith('/clone/index.html') && existsSync(file)
          && /<script\b[^>]*>\s*location\.replace\s*\(\s*innerWidth\s*<=\s*600\s*\?/i.test(readFileSync(file, 'utf8'))) {
        for (const width of [1440, 768, 375]) {
          const variant = join(dirname(file), `index-${width}.html`);
          try {
            if (statSync(variant).isFile()) { file = variant; break; }
          } catch {}
        }
      }
      if (sendFile(res, file, file ? staticDocumentHeaders(req, file, compareView) : {})) return;
      return send(res, 404, NOT_FOUND, 'text/html; charset=utf-8');
    }
    if (!ROOT_MODE) return send(res, 404, NOT_FOUND, 'text/html; charset=utf-8');
    // root=mirror：真实站点的 /static/** 仍按镜像资源解析（落到末尾 serveLive）
  }
  // 交互镜像：/lm/<host>/** 始终保持可用
  if (pathname.startsWith('/lm/')) {
    const m = /^\/lm\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!m) return send(res, 400, 'bad lm path');
    const reqHost = m[1];
    if (reqHost !== HOST && reqHost !== 'www.' + HOST) return send(res, 403, 'host not allowed');
    return serveLive(req, res, u.pathname.slice('/lm/'.length + reqHost.length) || '/', u.search);
  }
  // root=mirror：其余路径（含真实站点的 /static/**）全部按镜像解析
  if (ROOT_MODE) return serveLive(req, res, u.pathname, u.search);
  return send(res, 404, NOT_FOUND, 'text/html; charset=utf-8');
}).listen(PORT, BIND, function () {
  const actualPort = this.address().port;
  process.send?.({ kind: 'heimdall-live-ready', port: actualPort });
  const where = BIND === '0.0.0.0' ? '0.0.0.0（所有网卡；只在本机看请加 --host 127.0.0.1）' : BIND;
  console.log(`[heimdall-live] 监听 ${where}:${actualPort}  host=${HOST}  offline=${OFFLINE}  replay=${REPLAY}  har=${HAR_ENTRIES} entries`);
});
