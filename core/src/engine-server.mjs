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
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8900);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

const json = (res, code, obj) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

/** task = {id,kind:'recon'|'forge',url,status,events:[],subs:Set,child,atlasPath?,pageName?} */
const tasks = new Map();
let seq = 0;
let runningRecon = null, runningForge = null;

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
    if (t.kind === 'recon') runningRecon = null; else runningForge = null;
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
  runningForge = t;
  return { id: spawnTask(t, join('src', 'pipeline.mjs'), [url, name]).id, name };
}

createServer((req, res) => {
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
      if (runningForge) return json(res, 409, { error: 'busy', taskId: runningForge.id });
      const { id, name } = startForge(url);
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

  if (u.pathname === '/api/status') {
    return json(res, 200, {
      ok: true,
      recon: runningRecon ? { id: runningRecon.id, url: runningRecon.url } : null,
      forge: runningForge ? { id: runningForge.id, url: runningForge.url } : null,
    });
  }

  json(res, 404, { error: 'nf' });
}).listen(PORT, () => console.log(`engine-server @ http://127.0.0.1:${PORT}`));
