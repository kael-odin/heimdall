/**
 * engine-server — Heimdall 引擎服务（W3）
 *
 *   POST /api/recon        {url, maxPages?}  → {taskId}（全站侦察）
 *   POST /api/forge        {url}             → {taskId, pageName}（单页还原流水线）
 *   GET  /api/events?task=  SSE 事件流（重放已发生事件 + 实时）
 *   GET  /api/atlas/:task   recon 任务完成后返回 atlas.json
 *   GET  /api/status        健康检查
 *
 * 用法: node src/engine-server.mjs [port=8900]
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8900);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

const json = (res, code, obj) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

/** task = {id,kind:'recon'|'forge',url,status,events:[],subs:Set,child,atlasPath?,pageName?} */
const tasks = new Map();
let seq = 0;
let runningRecon = null;
const MAX_FORGE = 2;
let forgeSlots = 0;

const push = (t, ev) => {
  t.events.push(ev);
  for (const res of t.subs) res.write(`data: ${JSON.stringify(ev)}\n\n`);
};

function makeTask(kind, url) {
  const id = `${kind[0]}${String(++seq).padStart(3, '0')}`;
  const t = { id, kind, url, status: 'running', events: [], subs: new Set(), child: null, atlasPath: null };
  tasks.set(id, t);
  return t;
}

/** spawn 引擎脚本并解析 @@EVENT@@ 行 → task 事件流 */
function spawnTask(t, script, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: join(HERE, '..') });
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
    t.status = code === 0 ? 'done' : 'failed';
    push(t, { kind: 'exit', code, status: t.status });
    for (const res of t.subs) res.end();
    t.subs.clear();
    if (t.kind === 'recon') runningRecon = null; else forgeSlots--;
  });
  return t;
}

function startRecon(url, maxPages) {
  const t = makeTask('recon', url);
  const host = new URL(url).hostname.replace(/^www\./, '');
  t.atlasPath = join(HERE, '..', 'workspace', host, 'recon', 'atlas.json');
  runningRecon = t;
  return spawnTask(t, join('src', 'crawler', 'recon.mjs'), [url, String(maxPages), '2']).id;
}

function startForge(url) {
  const t = makeTask('forge', url);
  const u = new URL(url);
  const name = u.pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[\/?&#]+/g, '-').slice(0, 60) || 'home';
  t.pageName = name;
  return { id: spawnTask(t, join('src', 'pipeline.mjs'), [url, name]).id, name };
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

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
      let url;
      try { ({ url } = JSON.parse(body || '{}')); } catch {}
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      if (forgeSlots >= MAX_FORGE) return json(res, 409, { error: 'busy' });
      const { id, name } = startForge(url);
      forgeSlots++;
      json(res, 200, { taskId: id, pageName: name, url });
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
    const file = join(HERE, '..', 'workspace', rel);
    if (!file.startsWith(join(HERE, '..', 'workspace')) || !existsSync(file)) return json(res, 404, { error: 'nf' });
    res.writeHead(200, { ...CORS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/sites') {
    // 已侦察站点清单（有 atlas.json 的 host）——控制台切换器数据源
    const wsDir = join(HERE, '..', 'workspace');
    const sites = [];
    try {
      for (const d of readdirSync(wsDir)) {
        const ap = join(wsDir, d, 'recon', 'atlas.json');
        if (!existsSync(ap)) continue;
        try {
          const a = JSON.parse(readFileSync(ap, 'utf8'));
          const pagesDir = join(wsDir, d, 'pages');
          const forged = existsSync(pagesDir) ? readdirSync(pagesDir).filter(n => existsSync(join(pagesDir, n, 'clone', 'index.html'))).length : 0;
          sites.push({ host: d, origin: a.origin, pages: a.meta?.pages ?? a.nodes?.length ?? 0, edges: a.meta?.edges ?? 0, forged });
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
    const target = 'https://' + m[1] + (m[2] ?? '/') + u.search;
    try {
      const upstream = await fetch(target, { headers: { 'User-Agent': UA2, Accept: req.headers.accept ?? '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow' });
      const headers = new Headers();
      for (const [k, v] of upstream.headers) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy'].includes(k.toLowerCase())) continue;
        headers.set(k, v);
      }
      headers.set('Access-Control-Allow-Origin', '*');
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
    if (lmRef && !existsSync(join(HERE, '..', 'workspace', '___never___'))) {
      const lh = lmRef[1];
      const target = 'https://' + lh + u.pathname + u.search;
      try {
        const upstream = await fetch(target, { method: req.method, headers: { 'User-Agent': UA2, Accept: req.headers.accept ?? '*/*', Referer: 'https://' + lh + '/' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req });
        const headers = new Headers();
        for (const [k, v] of upstream.headers) {
          if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy'].includes(k.toLowerCase())) continue;
          headers.set(k, v);
        }
        headers.set('Access-Control-Allow-Origin', '*');
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
    console.error('[lm] hit', u.pathname);
    try {
    const m = /^\/lm\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(res, 400, { error: 'bad lm path' });
    const lmHost = m[1];
    let rel = decodeURIComponent(m[2] ?? '/');
    if (rel.endsWith('/')) rel += 'index.html';
    const noWww = lmHost.replace(/^www\./, '');

    // 本地优先：live/<path>/index.html（build_live 产物）；无扩展名路径补 /index.html
    // 候选只放"文件"：有扩展名 → 精确路径；无扩展名 → 目录下的 index.html（目录本身绝不入候选，防 EISDIR）
    const lmCandidates = /\.[a-z0-9]+$/i.test(rel)
      ? [join(HERE, '..', 'workspace', noWww, 'live', rel)]
      : [join(HERE, '..', 'workspace', noWww, 'live', rel.replace(/\/$/, '') + '/index.html')];
    const localFile = lmCandidates.find(f => !f.includes('..') && existsSync(f));
    console.error('[lm] localFile =', localFile ?? '(none, will proxy)');
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
      headers.set('Access-Control-Allow-Origin', '*');
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
      forge: { slots: forgeSlots, max: MAX_FORGE },
    });
  }

  json(res, 404, { error: 'nf' });
}).listen(PORT, () => console.log(`engine-server @ http://127.0.0.1:${PORT}`));
