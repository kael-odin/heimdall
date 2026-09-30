/**
 * engine-server — Heimdall 引擎服务（W2.5）
 *
 *   POST /api/recon        {url, maxPages?}  → {taskId}（同时仅一个侦察任务）
 *   GET  /api/events?task=  SSE 事件流（重放已发生事件 + 实时）
 *   GET  /api/atlas/:task   任务完成后返回 atlas.json
 *   GET  /api/status        健康检查
 *
 * 用法: node src/engine-server.mjs [port=8900]
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8900);
const HERE = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0';
/** @type {{id:string,url:string,status:string,events:object[],sub:Set,child:any,atlasPath?:string}|null} */
let task = null;
let taskSeq = 0;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const json = (res, code, obj) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

function startRecon(url, maxPages) {
  const id = `t${String(++taskSeq).padStart(3, '0')}`;
  task = { id, url, status: 'running', events: [], subs: new Set(), child: null, atlasPath: null };
  const host = new URL(url).hostname;
  task.atlasPath = join(HERE, '..', 'workspace', host, 'recon', 'atlas.json');
  const child = spawn(process.execPath, [join(HERE, 'crawler', 'recon.mjs'), url, String(maxPages), '2'], { cwd: join(HERE, '..') });
  task.child = child;
  const push = (ev) => {
    task.events.push(ev);
    for (const res of task.subs) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith('@@EVENT@@')) continue;
      try { push(JSON.parse(line.slice(9))); } catch {}
    }
  });
  child.stderr.on('data', (d) => process.stderr.write('[recon] ' + d.toString()));
  child.on('exit', (code) => {
    task.status = code === 0 ? 'done' : 'failed';
    push({ kind: 'exit', code, status: task.status });
    for (const res of task.subs) res.end();
    task.subs.clear();
  });
  return id;
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
      if (task && task.status === 'running') return json(res, 409, { error: 'busy', taskId: task.id });
      const id = startRecon(url, Math.min(Math.max(maxPages ?? 40, 5), 80));
      json(res, 200, { taskId: id, url });
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/events') {
    const t = task;
    if (!t || u.searchParams.get('task') !== t.id) return json(res, 404, { error: 'no such task' });
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const ev of t.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);   // 重放
    if (t.status !== 'running') { res.end(); return; }
    t.subs.add(res);
    req.on('close', () => t.subs.delete(res));
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/api/atlas/')) {
    const t = task;
    if (!t || !existsSync(t.atlasPath)) return json(res, 404, { error: 'atlas not ready' });
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(readFileSync(t.atlasPath));
    return;
  }

  if (u.pathname === '/api/status') return json(res, 200, { ok: true, task: task ? { id: task.id, status: task.status, url: task.url } : null });

  json(res, 404, { error: 'nf' });
}).listen(PORT, () => console.log(`engine-server @ http://127.0.0.1:${PORT}`));
