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
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexHar, matchHar } from './har.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--' + name + '='));
  return eq ? eq.split('=').slice(1).join('=') : def;
};
const has = (name) => argv.includes('--' + name);

const cfgPath = argOf('config', join(HERE, 'heimdall-live.json'));
let cfg = { host: 'localhost', origin: 'http://localhost', port: 8080, offline: false, replayApi: true };
try { cfg = { ...cfg, ...JSON.parse(readFileSync(cfgPath, 'utf8')) }; } catch {}
const HOST = cfg.host;
const ORIGIN = cfg.origin.replace(/\/$/, '');
const PORT = Number(argOf('port', process.env.PORT ?? cfg.port ?? 8080));
const OFFLINE = has('offline') || !!cfg.offline;
const REPLAY = !has('no-replay') && cfg.replayApi !== false;
const ROOT_MODE = (argOf('root', cfg.root ?? 'landing') === 'mirror');

const SITE = join(HERE, 'site');
const LIVE = join(SITE, 'live');
const STATIC = join(SITE, 'static');
const LANDING = join(HERE, 'landing.html');

let HAR_INDEX = new Map();
let HAR_ENTRIES = 0;
const HAR_BY_QUERY = new Map();   // pathname|url参数 → 任意已捕获尺寸（图片优化端点回退）
try {
  const har = JSON.parse(readFileSync(join(HERE, 'har.json'), 'utf8'));
  HAR_INDEX = indexHar(har.entries);
  HAR_ENTRIES = har.entries?.length ?? 0;
  for (const e of har.entries ?? []) {
    try {
      const x = new URL(e.url);
      const target = x.searchParams.get('url');
      if (target) HAR_BY_QUERY.set(x.pathname + '|' + target, e);
    } catch {}
  }
} catch {}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.map': 'application/json; charset=utf-8',
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
  res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': buf.length, ...extra });
  res.end(buf);
  return true;
};
const NOT_FOUND = `<!doctype html><meta charset="utf-8"><title>404 · Heimdall Live</title><body style="font-family:system-ui;background:#0b0b10;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#22d3ee">404 · 本地无快照</h1><p style="color:#94a3b8">${OFFLINE ? '离线模式：未捕获的资源不可用。' : '代理失败：原站不可达。'}</p><p><a href="/" style="color:#22d3ee">返回落地页</a></p></div></body>`;

function rewriteHtml(text) {
  if (!text) return text;
  let out = text;
  for (const h of [HOST, 'www.' + HOST]) {
    out = out.split('https://' + h + '/').join('/lm/' + h + '/').split('https://' + h).join('/lm/' + h);
    out = out.split('http://' + h + '/').join('/lm/' + h + '/').split('http://' + h).join('/lm/' + h);
  }
  if (!/<base\b/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1><base href="/lm/${HOST}/">`);
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function proxy(req, res, pathAndQuery) {
  const target = ORIGIN + (pathAndQuery.startsWith('/') ? pathAndQuery : '/' + pathAndQuery);
  const headers = {};
  for (const k of ['accept', 'accept-language', 'content-type', 'referer']) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }
  headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  headers.referer = ORIGIN + '/';
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  const outHeaders = {};
  for (const [k, v] of upstream.headers) {
    const kl = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'set-cookie', 'connection', 'content-type'].includes(kl)) continue;
    if (kl === 'location') { outHeaders[k] = v.replace(ORIGIN, '/lm/' + HOST); continue; }
    outHeaders[k] = v;
  }
  for (const c of upstream.headers.getSetCookie?.() ?? []) {
    res.append?.('Set-Cookie', c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*secure/gi, ''));
  }
  const type = upstream.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) {
    const text = rewriteHtml(await upstream.text());
    return send(res, upstream.status, text, type, outHeaders);
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  return send(res, upstream.status, buf, type || 'application/octet-stream', outHeaders);
}

async function serveLive(req, res, rel, search) {
  if (rel.endsWith('/')) rel += 'index.html';
  // 1) local snapshot：无扩展名路径按目录 index.html 解析，且只接受文件
  const stripped = rel.replace(/^\/+/, '') || 'index.html';
  const candidates = /\.[a-z0-9]+$/i.test(stripped) ? [stripped] : [stripped.replace(/\/$/, '') + '/index.html', stripped];
  for (const cand of candidates) {
    const local = safeJoin(LIVE, cand);
    if (sendFile(res, local, { 'Cache-Control': 'no-cache' })) return;
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
      const replayHeaders = { ...hit.headers };
      delete replayHeaders['content-type'];
      res.writeHead(hit.status, { 'Content-Type': hit.mimeType || 'application/octet-stream', 'Content-Length': body.length, ...replayHeaders, 'X-Heimdall-Replay': '1' });
      return res.end(body);
    }
  }
  // 3) proxy
  if (OFFLINE) return send(res, 404, NOT_FOUND, 'text/html; charset=utf-8');
  try { return await proxy(req, res, rel + search); }
  catch { return send(res, 502, NOT_FOUND, 'text/html; charset=utf-8'); }
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);

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
      const file = safeJoin(STATIC, rel);
      if (sendFile(res, file)) return;
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
    return serveLive(req, res, m[2] ?? '/', u.search);
  }
  // root=mirror：其余路径（含真实站点的 /static/**）全部按镜像解析
  if (ROOT_MODE) return serveLive(req, res, pathname, u.search);
  return send(res, 404, NOT_FOUND, 'text/html; charset=utf-8');
}).listen(PORT, () => {
  console.log(`[heimdall-live] http://127.0.0.1:${PORT}  host=${HOST}  offline=${OFFLINE}  replay=${REPLAY}  har=${HAR_ENTRIES} entries`);
});
