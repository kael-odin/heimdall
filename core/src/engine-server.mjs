/**
 * engine-server — Heimdall 引擎服务（W3）
 *
 *   POST /api/recon        {url, maxPages?}  → {taskId}（全站侦察）
 *   POST /api/forge        {url, hostPost?}  → {taskId, pageName}（单页还原流水线）
 *   GET  /api/events?task=  SSE 事件流（重放已发生事件 + 实时）
 *   GET  /api/atlas/:task   recon 任务完成后返回 atlas.json
 *   GET  /api/jobs          任务清单（本进程内存态）
 *   POST /api/jobs/:id/cancel 取消任务
 *   GET  /api/status        健康检查
 *
 * 安全（默认仅本机）：
 *   HEIMDALL_HOST           监听地址，默认 127.0.0.1
 *   HEIMDALL_TOKEN          设置后 /api/* 与 /px/* 需带 x-heimdall-token
 *   HEIMDALL_CORS_ORIGIN    允许的控制台来源（逗号分隔）
 *   HEIMDALL_ALLOWED_HOSTS  代理白名单额外 host（逗号分隔）
 *   代理默认只允许 workspace 下已存在的 host，避免开放代理 / SSRF
 *
 * 用法: node src/engine-server.mjs [port=8900]
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './paths.mjs';

const PORT = Number(process.argv[2] ?? 8900);
const BIND = process.env.HEIMDALL_HOST ?? '127.0.0.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_TOKEN = process.env.HEIMDALL_TOKEN ?? '';
const ALLOWED_ORIGINS = (process.env.HEIMDALL_CORS_ORIGIN ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXTRA_PROXY_HOSTS = new Set((process.env.HEIMDALL_ALLOWED_HOSTS ?? '')
  .split(',').map(s => s.trim().replace(/^www\./, '')).filter(Boolean));
const CORS = { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,x-heimdall-token' };
const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

const json = (res, code, obj) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

/** 只对白名单来源回 CORS 头（默认本机控制台）；无 Origin 的 curl/服务调用不受影响 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}
/** token 可走 header；SSE/EventSource 不支持自定义 header，允许 ?token= 兜底 */
const authorized = (req, u) => !AUTH_TOKEN || req.headers['x-heimdall-token'] === AUTH_TOKEN || u?.searchParams?.get('token') === AUTH_TOKEN;
/** 代理白名单：默认只允许 workspace 下已存在的 host（已侦察/已捕获站点） */
const isProxyHost = (h) => {
  const noWww = String(h).replace(/^www\./, '');
  if (EXTRA_PROXY_HOSTS.has(noWww)) return true;
  return existsSync(join(WORKSPACE, noWww));
};
const isInsideWorkspace = (file) => {
  const rel = relative(WORKSPACE, file);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

/** task = {id,kind:'recon'|'forge',url,status,events:[],subs:Set,child,atlasPath?,pageName?} */
const tasks = new Map();
let seq = 0;
let runningRecon = null;
let runningAudit = null;
const MAX_FORGE = 2;
let forgeSlots = 0;

const push = (t, ev) => {
  t.events.push(ev);
  for (const res of t.subs) res.write(`data: ${JSON.stringify(ev)}\n\n`);
};

function makeTask(kind, url) {
  const id = `${kind[0]}${String(++seq).padStart(3, '0')}`;
  const t = { id, kind, url, status: 'running', events: [], subs: new Set(), child: null, atlasPath: null, createdAt: Date.now(), cancelRequested: false };
  tasks.set(id, t);
  return t;
}

/** spawn 引擎脚本并解析 @@EVENT@@ 行 → task 事件流 */
function spawnTask(t, script, args, opts = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: join(HERE, '..'),
    env: { ...process.env, HEIMDALL_PORT: String(PORT), ...(opts.env ?? {}) },
  });
  t.child = child;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith('@@EVENT@@')) continue;
      try { push(t, JSON.parse(line.slice(9))); } catch {}
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${t.id}] ` + d.toString()));
  child.on('exit', (code) => {
    t.status = t.cancelRequested ? 'cancelled' : code === 0 ? 'done' : 'failed';
    t.endedAt = Date.now();
    push(t, { kind: 'exit', code, status: t.status });
    for (const res of t.subs) res.end();
    t.subs.clear();
    if (t.kind === 'recon') runningRecon = null;
    else if (t.kind === 'audit') runningAudit = null;
    else forgeSlots--;
  });
  return t;
}

function startRecon(url, maxPages) {
  const t = makeTask('recon', url);
  const host = new URL(url).hostname.replace(/^www\./, '');
  t.atlasPath = join(WORKSPACE, host, 'recon', 'atlas.json');
  runningRecon = t;
  return spawnTask(t, join('src', 'crawler', 'recon.mjs'), [url, String(maxPages), '2']).id;
}

function startAudit(url, maxPages = 30) {
  const t = makeTask('audit', url);
  t.host = new URL(url).hostname.replace(/^www\./, '');
  runningAudit = t;
  return spawnTask(t, join('src', 'seo', 'audit.mjs'), [url, '--max', String(maxPages)]).id;
}

function startForge(url, { hostPost = true } = {}) {
  const t = makeTask('forge', url);
  const u = new URL(url);
  const name = u.pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[\/?&#]+/g, '-').slice(0, 60) || 'home';
  t.pageName = name;
  const env = hostPost ? {} : { HEIMDALL_SKIP_HOST_POST: '1' };
  return { id: spawnTask(t, join('src', 'pipeline.mjs'), [url, name], { env }).id, name };
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (!authorized(req, u) && (u.pathname.startsWith('/api/') || u.pathname.startsWith('/px/'))) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && u.pathname === '/api/jobs') {
    return json(res, 200, {
      jobs: [...tasks.values()].map(t => ({
        id: t.id, kind: t.kind, url: t.url, status: t.status, pageName: t.pageName ?? null,
        createdAt: t.createdAt, endedAt: t.endedAt ?? null, events: t.events.length,
      })),
    });
  }

  if (req.method === 'POST' && u.pathname.startsWith('/api/jobs/') && u.pathname.endsWith('/cancel')) {
    const id = u.pathname.split('/')[3];
    const t = tasks.get(id);
    if (!t) return json(res, 404, { error: 'no such task' });
    if (t.status === 'running') {
      t.cancelRequested = true;
      try { t.child?.kill('SIGTERM'); } catch {}
      push(t, { kind: 'cancel-requested' });
    }
    return json(res, 200, { id, status: t.status });
  }

  if (req.method === 'POST' && u.pathname === '/api/recon') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let url, maxPages = 40;
      try { ({ url, maxPages } = JSON.parse(body || '{}')); } catch {}
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      if (runningRecon) return json(res, 409, { error: 'busy', taskId: runningRecon.id });
      json(res, 200, { taskId: startRecon(url, Math.min(Math.max(maxPages ?? 40, 5), 80)), url });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/forge') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let url, hostPost = true;
      try { ({ url, hostPost } = JSON.parse(body || '{}')); } catch {}
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      if (forgeSlots >= MAX_FORGE) return json(res, 409, { error: 'busy' });
      forgeSlots++;
      try {
        const { id, name } = startForge(url, { hostPost: hostPost !== false });
        json(res, 200, { taskId: id, pageName: name, url });
      } catch (e) {
        forgeSlots--;
        json(res, 500, { error: String(e).slice(0, 140) });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/audit') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let url, maxPages = 30;
      try { ({ url, maxPages } = JSON.parse(body || '{}')); } catch {}
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      if (runningAudit) return json(res, 409, { error: 'busy', taskId: runningAudit.id });
      const id = startAudit(url, Math.min(Math.max(maxPages ?? 30, 1), 200));
      json(res, 200, { taskId: id, url });
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/events') {
    const t = tasks.get(u.searchParams.get('task') ?? '');
    if (!t) return json(res, 404, { error: 'no such task' });
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const ev of t.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);   // 重放
    if (t.status !== 'running') { res.end(); return; }
    t.subs.add(res);
    req.on('close', () => t.subs.delete(res));
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/api/atlas/')) {
    const t = tasks.get(u.pathname.split('/').pop());
    if (!t?.atlasPath || !existsSync(t.atlasPath)) return json(res, 404, { error: 'atlas not ready' });
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(readFileSync(t.atlasPath));
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/static/')) {
    // 常驻静态服务：/static/<host>/pages/<name>/clone/index.html 等（workspace 根）
    let rel = decodeURIComponent(u.pathname.slice('/static/'.length));
    if (rel.endsWith('/')) rel += 'index.html';
    const file = join(WORKSPACE, rel);
    if (!isInsideWorkspace(file) || !existsSync(file)) return json(res, 404, { error: 'nf' });
    res.writeHead(200, { ...CORS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/api/pages/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/pages/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const pagesDir = join(WORKSPACE, host, 'pages');
    const out = [];
    if (existsSync(pagesDir)) {
      for (const name of readdirSync(pagesDir)) {
        if (!existsSync(join(pagesDir, name, 'clone', 'index.html'))) continue;
        let target = '', score = null;
        try { target = JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target ?? ''; } catch {}
        try { score = JSON.parse(readFileSync(join(pagesDir, name, 'score.json'), 'utf8')); } catch {}
        out.push({ name, target, forged: true, score: score ? { total: score.total, pixel: score.pixel, grade: score.grade } : null });
      }
    }
    return json(res, 200, { host, pages: out });
  }

  if (req.method === 'GET' && u.pathname === '/api/sites') {
    // 已侦察站点清单（有 atlas.json 的 host）——控制台切换器数据源
    const wsDir = WORKSPACE;
    const sites = [];
    try {
      for (const d of readdirSync(wsDir)) {
        const ap = join(wsDir, d, 'recon', 'atlas.json');
        if (!existsSync(ap)) continue;
        try {
          const a = JSON.parse(readFileSync(ap, 'utf8'));
          const pagesDir = join(wsDir, d, 'pages');
          const forged = existsSync(pagesDir) ? readdirSync(pagesDir).filter(n => existsSync(join(pagesDir, n, 'clone', 'index.html'))).length : 0;
          sites.push({
            host: d, origin: a.origin,
            pages: a.meta?.pages ?? a.nodes?.length ?? 0,
            edges: a.meta?.edges ?? 0, forged,
            status: a.status ?? (a.nodes?.length ? 'ok' : 'failed'),
            failures: a.failures?.length ?? 0,
          });
        } catch {}
      }
    } catch {}
    return json(res, 200, { sites });
  }

  // 反向代理 /px/<host>/<path> → https://<host>/<path> —— 活镜像基础设施：
  // 镜像页的 API/资源请求走此通道回原站，"功能数据用原站跑通"
  if (req.method === 'GET' && u.pathname.startsWith('/px/')) {
    const m = /^\/px\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(res, 400, { error: 'bad proxy path' });
    if (!isProxyHost(m[1])) return json(res, 403, { error: 'host not allowed (recon it first or set HEIMDALL_ALLOWED_HOSTS)' });
    const target = 'https://' + m[1] + (m[2] ?? '/') + u.search;
    try {
      const upstream = await fetch(target, { headers: { 'User-Agent': UA2, Accept: req.headers.accept ?? '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow' });
      const headers = new Headers();
      for (const [k, v] of upstream.headers) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy'].includes(k.toLowerCase())) continue;
        headers.set(k, v);
      }
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) { json(res, 502, { error: String(e).slice(0, 120) }); }
    return;
  }

  // Referrer 感知兜底：活镜像页发出的"裸根相对"请求（JS 运行时拼接，patch 漏接形态）
  // 按 referer 里的 /lm/<host> 溯源转发原站——覆盖 fetch patch 漏掉的 Image src/srcset/动态 import/模块加载
  if (!['/api/', '/static/', '/lm/', '/px/'].some(pre => u.pathname.startsWith(pre))) {
    const ref = req.headers.referer ?? '';
    const lmRef = /\/lm\/([^/]+)\//.exec(ref);
    if (lmRef && isProxyHost(lmRef[1])) {
      const lh = lmRef[1];
      const target = 'https://' + lh + u.pathname + u.search;
      try {
        const upstream = await fetch(target, { method: req.method, headers: { 'User-Agent': UA2, Accept: req.headers.accept ?? '*/*', Referer: 'https://' + lh + '/' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req });
        const headers = new Headers();
        for (const [k, v] of upstream.headers) {
          if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy'].includes(k.toLowerCase())) continue;
          headers.set(k, v);
        }
        res.writeHead(upstream.status, headers);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (e) { json(res, 502, { error: String(e).slice(0, 100) }); }
      return;
    }
  }

  // 活镜像 /lm/<host>/<path> —— 融合路由：
  //   本地 live/<path>/index.html 存在 → 回校准快照（视觉+结构已对齐）
  //   否则 → 全代理回原站（未锻造页/资源/JS chunks/API 全部原样透传，页面"活"）
  // 全方法透传 + cookie 透传 + 剥离 Domain/Secure（cookie 落到我们域）+ 剥 X-Frame/CSP
  if (u.pathname.startsWith('/lm/')) {
    try {
    const m = /^\/lm\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(res, 400, { error: 'bad lm path' });
    const lmHost = m[1];
    if (!isProxyHost(lmHost)) return json(res, 403, { error: 'host not allowed' });
    let rel = decodeURIComponent(m[2] ?? '/');
    if (rel.endsWith('/')) rel += 'index.html';
    const noWww = lmHost.replace(/^www\./, '');

    // 本地优先：live/<path>/index.html（build_live 产物）；无扩展名路径补 /index.html
    // 候选只放"文件"：有扩展名 → 精确路径；无扩展名 → 目录下的 index.html（目录本身绝不入候选，防 EISDIR）
    const lmCandidates = /\.[a-z0-9]+$/i.test(rel)
      ? [join(WORKSPACE, noWww, 'live', rel)]
      : [join(WORKSPACE, noWww, 'live', rel.replace(/\/$/, '') + '/index.html')];
    const localFile = lmCandidates.find(f => isInsideWorkspace(f) && existsSync(f));
    if (localFile) {
      res.writeHead(200, { ...CORS, 'Content-Type': MIME[extname(localFile)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(readFileSync(localFile));
      return;
    }

    // 反代回原站（全方法）
    const targetUrl = 'https://' + lmHost + (m[2] ?? '/') + u.search;
    const fwdHeaders = {};
    for (const k of ['accept', 'accept-language', 'content-type', 'cookie', 'referer']) {
      if (req.headers[k]) fwdHeaders[k] = req.headers[k];
    }
    fwdHeaders['user-agent'] = UA2;
    fwdHeaders.referer = 'https://' + lmHost + '/';
    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        redirect: 'follow',
      });
      const headers = new Headers();
      let cookieCount = 0;
      for (const [k, v] of upstream.headers) {
        const kl = k.toLowerCase();
        if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'set-cookie'].includes(kl)) continue;
        if (kl === 'location') { const v2 = v.replace('https://' + lmHost, '/lm/' + lmHost).replace('https://www.' + lmHost, '/lm/' + lmHost); headers.set(k, v2); continue; }
        headers.set(k, v);
      }
      // Set-Cookie：剥 Domain/Secure（落到我们域，登录态/语言偏好等存活）
      for (const c of upstream.headers.getSetCookie?.() ?? []) {
        cookieCount++;
        headers.append('set-cookie', c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*secure/gi, ''));
      }
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) { json(res, 502, { error: String(e).slice(0, 140) }); }
    return;
    } catch (e) { try { json(res, 502, { error: String(e).slice(0, 140) }); } catch {} }
    return;
  }

  if (u.pathname === '/api/status') {
    return json(res, 200, {
      ok: true,
      recon: runningRecon ? { id: runningRecon.id, url: runningRecon.url } : null,
      audit: runningAudit ? { id: runningAudit.id, url: runningAudit.url } : null,
      forge: { slots: forgeSlots, max: MAX_FORGE },
      jobs: tasks.size,
      bind: BIND,
      auth: !!AUTH_TOKEN,
    });
  }

  json(res, 404, { error: 'nf' });
}).listen(PORT, BIND, () => console.log(`engine-server @ http://${BIND}:${PORT}`));
