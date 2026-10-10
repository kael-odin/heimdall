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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, createReadStream } from 'node:fs';
import { join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, DATA_ROOT, DELIVERABLE } from './paths.mjs';
import { openJobStore, recoverInterrupted } from './jobs/store.mjs';
import { llmInfo, llmChat, llmChatWith, llmConfig } from './llm.mjs';
import { llmSettings, normalizePatch, writeEnvKeys } from './settings.mjs';
import { gcCas } from './store/cas.mjs';

const CONSOLE_DIR = process.env.HEIMDALL_CONSOLE_DIR ?? '';

// 任务持久化（node:sqlite；不可用时自动降级 JSON）——重启后历史/事件不丢
let jobStore = null;
try {
  jobStore = openJobStore(process.env.HEIMDALL_JOBS_DB ?? join(DATA_ROOT, 'jobs.db'));
  const recovered = recoverInterrupted(jobStore);
  if (recovered) console.log('[jobs] recovered ' + recovered + ' interrupted job(s) from previous run');
} catch (e) { console.warn('[jobs] store unavailable:', String(e).slice(0, 120)); }

const PORT = Number(process.argv[2] ?? 8900);
const BIND = process.env.HEIMDALL_HOST ?? '127.0.0.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_TOKEN = process.env.HEIMDALL_TOKEN ?? '';
const ALLOWED_ORIGINS = (process.env.HEIMDALL_CORS_ORIGIN ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXTRA_PROXY_HOSTS = new Set((process.env.HEIMDALL_ALLOWED_HOSTS ?? '')
  .split(',').map(s => s.trim().replace(/^www\./, '')).filter(Boolean));
const CORS = { 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,x-heimdall-token' };
const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.har': 'application/json',
  '.bin': 'application/octet-stream',
};
const mimeOf = (file) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';

const json = (res, code, obj) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

/** 读请求体（带大小上限，避免被一个超大 body 撑爆内存） */
const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  let body = '', n = 0;
  req.on('data', (c) => {
    n += c.length;
    if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
    body += c;
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const isLoopback = (req) => {
  const a = req.socket?.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

/**
 * 流式下发文件：Content-Length + Range 支持 + 正确 MIME。
 * 此前四处用 readFileSync 全量入内存 —— 面对几百 MB 的镜像包/合并 HAR 会顶爆堆，
 * 且不支持 Range（视频无法拖动/续传）。这里统一替换为流式。
 */
function sendFile(req, res, file, extraHeaders = {}) {
  let st;
  try { st = statSync(file); } catch { return json(res, 404, { error: 'nf' }); }
  if (!st.isFile()) return json(res, 404, { error: 'nf' });
  const headers = {
    ...CORS,
    'Content-Type': mimeOf(file),
    'Content-Length': String(st.size),
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    ...extraHeaders,
  };
  const range = req?.headers?.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? undefined : Number(m[1]);
    let end = m[2] === '' ? undefined : Number(m[2]);
    if (start === undefined && end !== undefined) { start = Math.max(0, st.size - end); end = st.size - 1; }   // 后缀范围
    else { if (start === undefined) start = 0; if (end === undefined || end >= st.size) end = st.size - 1; }
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...CORS, 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    headers['Content-Length'] = String(end - start + 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(206, headers);
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, headers);
  if (req?.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

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
const pageFor = (u) => {
  try {
    const x = typeof u === 'string' ? new URL(u) : u;
    const p = x.pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[/?&#]+/g, '-').slice(0, 60);
    return p || 'home';
  } catch { return 'home'; }
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
let runningWatch = null;
let runningAssets = null;
let runningMatrix = null;
let runningVerify = null;
let runningLive = null;
let runningReclaim = null;
let runningUpgrade = null;
const pageMetaCache = new Map();
const MAX_FORGE = 2;
let forgeSlots = 0;

const push = (t, ev) => {
  t.events.push(ev);
  if (typeof ev?.kind === 'string' && ev.kind.endsWith('-error')) t.error = ev.error ?? 'error';
  jobStore?.appendEvent(t.id, ev);
  for (const res of t.subs) res.write(`data: ${JSON.stringify(ev)}\n\n`);
};

function makeTask(kind, url) {
  const id = `${kind[0]}${String(++seq).padStart(3, '0')}`;
  const t = { id, kind, url, status: 'running', events: [], subs: new Set(), child: null, atlasPath: null, createdAt: Date.now(), cancelRequested: false };
  tasks.set(id, t);
  jobStore?.upsert({ id, kind, url, status: 'running', createdAt: t.createdAt });
  return t;
}

/** spawn 引擎脚本并解析 @@EVENT@@ 行 → task 事件流 */
function spawnTask(t, script, args, opts = {}) {
  const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), script, ...args], {
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
    else if (t.kind === 'watch') runningWatch = null;
    else if (t.kind === 'assets') runningAssets = null;
    else if (t.kind === 'matrix') runningMatrix = null;
    else if (t.kind === 'verify') runningVerify = null;
    else if (t.kind === 'live') runningLive = null;
    else if (t.kind === 'upgrade') runningUpgrade = null;
    else if (t.kind === 'storage') storageScanTask = null;   // 盘点任务不占锻造槽
    else forgeSlots--;
    jobStore?.upsert({ id: t.id, kind: t.kind, url: t.url, status: t.status, pageName: t.pageName ?? null, createdAt: t.createdAt, endedAt: t.endedAt ?? null, error: t.error ?? null });
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

function startWatch(url, maxPages = 20, accept = false) {
  const t = makeTask('watch', url);
  t.host = new URL(url).hostname.replace(/^www\./, '');
  runningWatch = t;
  const args = [url, '--max', String(maxPages)];
  if (accept) args.push('--accept');
  return spawnTask(t, join('src', 'watch', 'watch.mjs'), args).id;
}

function startAssets(host, maxPages = 60) {
  const t = makeTask('assets', 'https://' + host);
  t.host = host;
  runningAssets = t;
  return spawnTask(t, join('src', 'audit', 'assets.mjs'), [host, '--max', String(maxPages)]).id;
}

function startMatrix(sites, maxPages = 15) {
  const t = makeTask('matrix', sites.join(','));
  t.host = sites[0];
  runningMatrix = t;
  return spawnTask(t, join('src', 'seo', 'matrix.mjs'), [...sites, '--max', String(maxPages)]).id;
}

function startResponsiveUpgrade(host, { threshold = 0.97, max = 8, force = false } = {}) {
  const t = makeTask('upgrade', 'https://' + host);
  t.host = host;
  t.label = '响应式升级 ' + host;
  runningUpgrade = t;
  const args = [host, '--threshold', String(threshold), '--max', String(max)];
  if (force) args.push('--force');
  return spawnTask(t, join('src', 'crawler', 'responsive-upgrade.mjs'), args).id;
}

function startVerify(host, { page, maxPages = 20 } = {}) {
  const t = makeTask('verify', 'https://' + host);
  t.host = host;
  t.label = page ? '多视口体检 ' + page : '全站体检';
  runningVerify = t;
  const args = page ? [host, page, '--no-interactions'] : [host, '--all', '--max', String(maxPages)];
  return spawnTask(t, join('src', 'verify', 'verify.mjs'), args).id;
}

function startLiveExport(host, { root = 'mirror', rebuild = false } = {}) {
  const t = makeTask('live', 'https://' + host);
  t.host = host;
  t.label = '活镜像导出 ' + host;
  runningLive = t;
  const args = [host, '--offline', '--root', root === 'landing' ? 'landing' : 'mirror', '--heal', '--materialize-har'];
  if (rebuild) args.push('--rebuild');
  return spawnTask(t, join('src', 'live', 'export.mjs'), args, { nodeArgs: ['--max-old-space-size=4096'] }).id;
}

/**
 * 磁盘盘点必须走子进程。
 *
 * 实测：同步遍历 5.4 万文件要 ~12 秒，期间 **Node 事件循环完全冻结** ——
 * 连 500ms 的定时器都不会触发，所有 API 请求（含 SSE、活镜像代理）全部排队。
 * 所以引擎只把结果当成"一份会被刷新的文件"读，真正的遍历交给子进程。
 */
const STORAGE_JSON = join(DATA_ROOT, 'storage.json');
const STORAGE_TTL_MS = 5 * 60_000;
let storageScanTask = null;

function readStorageFile() {
  try {
    const s = JSON.parse(readFileSync(STORAGE_JSON, 'utf8'));
    return { ...s, stale: Date.now() - Date.parse(s.generatedAt ?? 0) > STORAGE_TTL_MS };
  } catch { return null; }
}

/** 后台盘点（不阻塞事件循环）；已在跑则复用同一个任务 */
function startStorageScan() {
  if (storageScanTask && storageScanTask.status === 'running') return storageScanTask.id;
  const t = makeTask('storage', 'local://storage');
  t.label = '磁盘盘点';
  storageScanTask = t;
  return spawnTask(t, join('src', 'audit', 'storage.mjs'), []).id;
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

  if (req.method === 'GET' && u.pathname === '/api/llm/status') {
    return json(res, 200, llmInfo());
  }

  // ---- 模型服务配置（控制台可直接改，保存即生效——env.mjs 不缓存、llm 每次重读）----
  if (u.pathname === '/api/settings/llm') {
    if (req.method === 'GET') return json(res, 200, llmSettings());

    if (req.method === 'PUT') {
      // 安全：未设 HEIMDALL_TOKEN 时只允许本机回环改写。
      // 否则把引擎绑到 0.0.0.0 共享出去后，任何内网同事都能替换你的模型端点与 Key。
      if (!AUTH_TOKEN && !isLoopback(req)) {
        return json(res, 403, { error: '写配置需要 HEIMDALL_TOKEN；未设置时仅允许本机回环访问' });
      }
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); }
      catch { return json(res, 400, { error: 'invalid json' }); }
      try {
        const patch = normalizePatch(body);
        const written = writeEnvKeys(patch);
        console.log('[settings] llm updated:', Object.keys(patch).map(k => k === 'LLM_API_KEY' ? 'LLM_API_KEY=****' : k).join(', '));
        return json(res, 200, { ok: true, ...written, settings: llmSettings() });
      } catch (e) {
        return json(res, 400, { error: String(e?.message ?? e) });
      }
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  if (req.method === 'POST' && u.pathname === '/api/llm/test') {
    // 支持「草稿配置」：传 baseUrl/apiKey/model/protocol 就按草稿测，不落盘 —— 先测通再保存
    let draft = null;
    try { draft = JSON.parse((await readBody(req)) || '{}'); } catch { draft = {}; }
    const cur = llmConfig();
    const cfg = {
      ...cur,
      // Key 留空 = 沿用已保存的（控制台不会回显 Key，因此不能把空值当成"要清空"）
      protocol: draft?.protocol ? String(draft.protocol).toLowerCase() : cur.protocol,
      base: draft?.baseUrl !== undefined ? String(draft.baseUrl).trim().replace(/\/+$/, '') : cur.base,
      key: draft?.apiKey ? String(draft.apiKey).trim() : cur.key,
      model: draft?.model ? String(draft.model).trim() : cur.model,
      fastModel: draft?.model ? String(draft.model).trim() : cur.fastModel,
    };
    if (!cfg.base || !cfg.key) {
      return json(res, 200, { ok: false, error: '缺少 Base URL 或 API Key' });
    }
    const started = Date.now();
    try {
      const reply = await llmChatWith(cfg, [{ role: 'user', content: '只回复四个字符：连接正常' }], { maxTokens: 512, timeout: 60_000 });
      return json(res, 200, {
        ok: true, latencyMs: Date.now() - started, model: cfg.model, protocol: cfg.protocol,
        draft: !!(draft && Object.keys(draft).length), reply: String(reply).trim().slice(0, 80),
      });
    } catch (e) {
      return json(res, 200, { ok: false, latencyMs: Date.now() - started, error: String(e).slice(0, 300) });
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/jobs') {
    return json(res, 200, {
      store: jobStore?.kind ?? null,
      jobs: [...tasks.values()].map(t => ({
        id: t.id, kind: t.kind, url: t.url, status: t.status, pageName: t.pageName ?? null,
        createdAt: t.createdAt, endedAt: t.endedAt ?? null, events: t.events.length,
      })),
      history: jobStore?.list({ limit: 50 }) ?? [],
    });
  }

  if (req.method === 'POST' && u.pathname.startsWith('/api/jobs/') && u.pathname.endsWith('/cancel')) {
    const id = u.pathname.split('/')[3];
    const t = tasks.get(id);
    if (!t) return json(res, 404, { error: 'no such task' });
    if (t.status === 'running') {
      t.cancelRequested = true;
      try { t.child?.kill('SIGTERM'); } catch {}
      jobStore?.upsert({ id: t.id, kind: t.kind, url: t.url, status: 'cancelled', pageName: t.pageName ?? null, createdAt: t.createdAt, endedAt: Date.now() });
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

  if (req.method === 'POST' && u.pathname === '/api/matrix') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let sites = [], maxPages = 15;
      try { ({ sites, maxPages } = JSON.parse(body || '{}')); } catch {}
      sites = (Array.isArray(sites) ? sites : []).map(s => String(s).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(s => /^[a-z0-9.-]+$/i.test(s));
      if (sites.length < 2 || sites.length > 6) return json(res, 400, { error: 'need 2-6 valid hosts' });
      if (runningMatrix) return json(res, 409, { error: 'busy', taskId: runningMatrix.id });
      const id = startMatrix([...new Set(sites)], Math.min(Math.max(maxPages ?? 15, 1), 100));
      json(res, 200, { taskId: id, sites });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/reclaim') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let host, apply = false;
      try { ({ host, apply } = JSON.parse(body || '{}')); } catch {}
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningReclaim) return json(res, 409, { error: 'busy', host: runningReclaim });
      runningReclaim = host;
      try {
        const out = await new Promise((resolve) => {
          const child = spawn(process.execPath, [join(HERE, '..', 'src', 'audit', 'reclaim-orphans.mjs'), host, ...(apply ? ['--apply'] : [])], { cwd: join(HERE, '..'), env: process.env });
          let buf = '';
          child.stdout.on('data', (d) => { buf += d.toString(); });
          child.on('exit', (code) => resolve({ code, buf }));
          child.on('error', () => resolve({ code: -1, buf: '' }));
        });
        const line = out.buf.split('\n').find(l => l.startsWith('@@RAWS@@') || l.startsWith('@@EVENT@@'));
        const summary = line ? JSON.parse(line.slice(line.startsWith('@@RAWS@@') ? 8 : 9)) : null;
        let byPage = null;
        try { byPage = JSON.parse(readFileSync(join(WORKSPACE, host, 'audit', 'reclaim-plan.json'), 'utf8')).byPage ?? null; } catch {}
        return json(res, out.code === 0 ? 200 : 500, { host, apply: !!apply, exit: out.code, summary, byPage });
      } finally { runningReclaim = null; }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/responsive-upgrade') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let host, threshold = 0.97, max = 8, force = false;
      try { ({ host, threshold, max, force } = JSON.parse(body || '{}')); } catch {}
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningUpgrade) return json(res, 409, { error: 'busy', taskId: runningUpgrade.id });
      const id = startResponsiveUpgrade(host, { threshold: Math.min(Math.max(Number(threshold) || 0.97, 0.5), 1), max: Math.min(Math.max(Number(max) || 8, 1), 61), force: !!force });
      json(res, 200, { taskId: id, host });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/verify') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let host, page = null, maxPages = 20;
      try { ({ host, page, maxPages } = JSON.parse(body || '{}')); } catch {}
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (page != null && !/^[a-z0-9._-]+$/i.test(String(page))) return json(res, 400, { error: 'bad page' });
      if (runningVerify) return json(res, 409, { error: 'busy', taskId: runningVerify.id });
      const id = startVerify(host, { page: page ? String(page) : null, maxPages: Math.min(Math.max(maxPages ?? 20, 1), 200) });
      json(res, 200, { taskId: id, host, page: page ?? null });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/live-export') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let host, root = 'mirror', rebuild = false;
      try { ({ host, root, rebuild } = JSON.parse(body || '{}')); } catch {}
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningLive) return json(res, 409, { error: 'busy', taskId: runningLive.id });
      const id = startLiveExport(host, { root, rebuild: !!rebuild });
      json(res, 200, { taskId: id, host, root });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/assets-audit') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let host, maxPages = 60;
      try { ({ host, maxPages } = JSON.parse(body || '{}')); } catch {}
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningAssets) return json(res, 409, { error: 'busy', taskId: runningAssets.id });
      const id = startAssets(host, Math.min(Math.max(maxPages ?? 60, 1), 500));
      json(res, 200, { taskId: id, host });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/watch') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let url, maxPages = 20, accept = false;
      try { ({ url, maxPages, accept } = JSON.parse(body || '{}')); } catch {}
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      if (runningWatch) return json(res, 409, { error: 'busy', taskId: runningWatch.id });
      const id = startWatch(url, Math.min(Math.max(maxPages ?? 20, 1), 200), !!accept);
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
    return sendFile(req, res, file);
  }

  if (req.method === 'GET' && u.pathname.startsWith('/api/pages/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/pages/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const pagesDir = join(WORKSPACE, host, 'pages');
    const out = [];
    // 资产缺口（若已跑过扫描）
    const gapMap = {};
    try {
      const gaps = JSON.parse(readFileSync(join(WORKSPACE, host, 'audit', 'asset-gaps.json'), 'utf8'));
      for (const p of gaps.pages ?? []) gapMap[p.page] = { visual: p.visualGaps ?? 0, origin: p.visualOrigin ?? 0, third: p.visualThird ?? 0 };
    } catch {}
    if (existsSync(pagesDir)) {
      for (const name of readdirSync(pagesDir)) {
        const cloneHtml = join(pagesDir, name, 'clone', 'index.html');
        if (!existsSync(cloneHtml)) continue;
        let target = '', score = null;
        try { target = JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target ?? ''; } catch {}
        try { score = JSON.parse(readFileSync(join(pagesDir, name, 'score.json'), 'utf8')); } catch {}
        // 资产统计（按 clone/index.html mtime 缓存）
        let mtime = 0; try { mtime = statSync(cloneHtml).mtimeMs; } catch {}
        let meta = pageMetaCache.get(name);
        if (!meta || meta.mtime !== mtime) {
          let count = 0, bytes = 0;
          const walk = (d) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const fp = join(d, n); let st; try { st = statSync(fp); } catch { continue; } if (st.isDirectory()) walk(fp); else { count++; bytes += st.size; } } };
          walk(join(pagesDir, name, 'clone', 'assets'));
          meta = { mtime, meta: { count, bytes } };
          pageMetaCache.set(name, meta);
        }
        // verify 结果：interactions（交互列）与 minViewport（视觉列的最差值）同源，
        // 一次读文件一起给。控制台此前为这两列逐页发 2 个请求（80 页 = 160 个），
        // 而这里本来就已经在读同一个文件了。
        let interactions = null, minViewport = null;
        try {
          const v = JSON.parse(readFileSync(join(WORKSPACE, host, 'verify', name, 'verify.json'), 'utf8'));
          interactions = v.functional ?? null;
          minViewport = v.minViewport
            ? { name: v.minViewport.name, score: v.minViewport.score, grade: v.minViewport.grade }
            : null;
        } catch {}
        out.push({
          name, target, forged: true,
          score: score ? { total: score.total, pixel: score.pixel, grade: score.grade } : null,
          assets: meta.meta,
          visualGaps: gapMap[name] ?? null,
          interactions,
          minViewport,
          updatedAt: mtime,
        });
      }
    }
    return json(res, 200, { host, pages: out });
  }

  // 单页锻造历史（持久化 jobs/events）
  if (req.method === 'GET' && u.pathname.startsWith('/api/history/')) {
    const parts = u.pathname.split('/').filter(Boolean); // ['api','history',host,page]
    const host = decodeURIComponent(parts[2] ?? '');
    const page = decodeURIComponent(parts[3] ?? '');
    if (!/^[a-z0-9.-]+$/i.test(host) || !page) return json(res, 400, { error: 'bad history path' });
    const jobs = (jobStore?.list({ limit: 500 }) ?? [])
      .filter(j => {
        try { const x = new URL(j.url); return x.hostname.replace(/^www\./, '') === host && (j.pageName === page || (j.kind === 'forge' && pageFor(x) === page)); } catch { return false; }
      })
      .slice(0, 30)
      .map(j => {
        let score = null;
        try {
          const evs = jobStore.events(j.id, { limit: 300 });
          for (const e of evs) if (e.data?.kind === 'forge-score' && e.data.score) score = e.data.score;
        } catch {}
        return { id: j.id, status: j.status, createdAt: j.createdAt, endedAt: j.endedAt, error: j.error, score: score ? { pixel: score.pixel, total: score.total, grade: score.grade } : null };
      });
    return json(res, 200, { host, page, jobs });
  }

  // 活镜像体检：读取最新 <host>-live-*/health.json（导出时生成）
  if (req.method === 'GET' && u.pathname.startsWith('/api/live-health/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/live-health/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    let dirs = [];
    try { dirs = readdirSync(DELIVERABLE).filter(n => n.startsWith(host + '-live-')).sort().reverse(); } catch {}
    for (const d of dirs) {
      const p = join(DELIVERABLE, d, 'health.json');
      if (!existsSync(p)) continue;
      try {
        const health = JSON.parse(readFileSync(p, 'utf8'));
        return json(res, 200, { ...health, bundle: d });
      } catch {}
    }
    return json(res, 404, { error: 'no live health report', host });
  }

  // 存储治理。**遍历一律在子进程里做**（见 startStorageScan 的注释）：
  // 这里只读一份会被刷新的 storage.json，并顺手在过期时后台补一次。
  if (u.pathname === '/api/storage' && req.method === 'GET') {
    const s = readStorageFile();
    if (!s || s.stale) startStorageScan();            // 不 await：立刻把已有结果给出去
    if (!s) return json(res, 200, { pending: true, scanning: !!storageScanTask, sites: [], totals: null });
    return json(res, 200, { ...s, scanning: !!(storageScanTask && storageScanTask.status === 'running') });
  }
  if (u.pathname === '/api/storage/scan' && req.method === 'POST') {
    const taskId = startStorageScan();
    return json(res, 202, { ok: true, taskId, status: 'running' });
  }
  if (u.pathname === '/api/storage/gc' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
    const apply = body.apply === true;
    if (apply && !AUTH_TOKEN && !isLoopback(req)) {
      return json(res, 403, { error: '真回收需要 HEIMDALL_TOKEN；未设置时仅允许本机回环访问' });
    }
    if (apply && body.confirm !== 'HEIMDALL_CAS_GC') {
      return json(res, 400, { error: '真回收需要 confirm=HEIMDALL_CAS_GC' });
    }
    const result = gcCas(join(DATA_ROOT, 'assets-cas'), { apply });   // ~0.5s，可接受
    startStorageScan();                                               // 重新盘点交给子进程
    return json(res, 200, { ok: true, ...result, storage: readStorageFile() });
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
      return sendFile(req, res, localFile, { 'Cache-Control': 'no-cache' });
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
      watch: runningWatch ? { id: runningWatch.id, url: runningWatch.url } : null,
      assets: runningAssets ? { id: runningAssets.id, url: runningAssets.url } : null,
      matrix: runningMatrix ? { id: runningMatrix.id, url: runningMatrix.url } : null,
      verify: runningVerify ? { id: runningVerify.id, host: runningVerify.host } : null,
      live: runningLive ? { id: runningLive.id, host: runningLive.host } : null,
      upgrade: runningUpgrade ? { id: runningUpgrade.id, host: runningUpgrade.host } : null,
      forge: { slots: forgeSlots, max: MAX_FORGE },
      jobs: tasks.size,
      jobsStore: jobStore?.kind ?? null,
      bind: BIND,
      auth: !!AUTH_TOKEN,
    });
  }

  // 删除：整站（workspace/<host>）或单页（页面产物 + atlas 节点）
  if (req.method === 'DELETE' && u.pathname.startsWith('/api/sites/')) {
    const parts = u.pathname.split('/').filter(Boolean); // ['api','sites',host?...]
    const host = decodeURIComponent(parts[2] ?? '');
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const base = join(WORKSPACE, host);
    if (!isInsideWorkspace(base) || !existsSync(base)) return json(res, 404, { error: 'site not found' });
    try {
      if (parts.length === 3) {
        rmSync(base, { recursive: true, force: true });
        const casGc = gcCas(join(DATA_ROOT, 'assets-cas'), { apply: true });   // 6k 文件约 0.5s，可接受
        startStorageScan();                                                     // 12s 的盘点交给子进程
        return json(res, 200, { ok: true, removed: 'site', host, casGc: { freed: casGc.freed, orphanFiles: casGc.orphanFiles, failed: casGc.failed, skipped: casGc.skipped } });
      }
      if (parts.length === 5 && parts[3] === 'pages') {
        const name = decodeURIComponent(parts[4]);
        if (!/^[a-z0-9._-]+$/i.test(name)) return json(res, 400, { error: 'bad page name' });
        const pageDir = join(base, 'pages', name);
        let removedArtifacts = false;
        if (isInsideWorkspace(pageDir) && existsSync(pageDir)) { rmSync(pageDir, { recursive: true, force: true }); removedArtifacts = true; }
        // 从 atlas 中移除对应节点与边（按 manifest.target 或页面名匹配）
        let removedNode = false;
        const atlasPath = join(base, 'recon', 'atlas.json');
        if (existsSync(atlasPath)) {
          try {
            const atlas = JSON.parse(readFileSync(atlasPath, 'utf8'));
            const before = atlas.nodes?.length ?? 0;
            atlas.nodes = (atlas.nodes ?? []).filter(n => pageFor(n.url) !== name);
            const ids = new Set(atlas.nodes.map(n => n.id));
            atlas.edges = (atlas.edges ?? []).filter(e => ids.has(e.from) && ids.has(e.to));
            if (atlas.meta) { atlas.meta.pages = atlas.nodes.length; atlas.meta.edges = atlas.edges.length; }
            removedNode = atlas.nodes.length !== before;
            writeFileSync(atlasPath, JSON.stringify(atlas, null, 2));
          } catch {}
        }
        const pageGc = removedArtifacts ? gcCas(join(DATA_ROOT, 'assets-cas'), { apply: true }) : null;
        if (removedArtifacts) startStorageScan();
        return json(res, 200, { ok: true, removed: 'page', host, name, removedArtifacts, removedNode, casGc: pageGc ? { freed: pageGc.freed, orphanFiles: pageGc.orphanFiles, failed: pageGc.failed, skipped: pageGc.skipped } : null });
      }
    } catch (e) { return json(res, 500, { error: String(e).slice(0, 200) }); }
    return json(res, 400, { error: 'bad delete path' });
  }

  // 报告索引：控制台「报告」页动态展示可用产物
  if (req.method === 'GET' && u.pathname.startsWith('/api/reports/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/reports/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const base = join(WORKSPACE, host);
    const defs = [
      { id: 'archive', name: '克隆档案', file: join(base, 'index.html'), url: '/static/' + host + '/index.html' },
      { id: 'compare', name: '同步滚动对比', file: join(base, 'compare.html'), url: '/static/' + host + '/compare.html' },
      { id: 'seo', name: 'SEO 审计报告', file: join(base, 'seo', 'seo.html'), url: '/static/' + host + '/seo/seo.html' },
      { id: 'watch', name: '变更监控报告', file: join(base, 'watch', 'watch.html'), url: '/static/' + host + '/watch/watch.html' },
      { id: 'tokens', name: '设计 Token 预览', file: join(base, 'design', 'tokens.html'), url: '/static/' + host + '/design/tokens.html' },
      { id: 'components', name: '组件画廊', file: join(base, 'design', 'components', 'components.html'), url: '/static/' + host + '/design/components/components.html' },
      { id: 'verify', name: '多视口验证汇总', file: join(base, 'verify', 'verify-summary.json'), url: '/static/' + host + '/verify/verify-summary.json' },
      { id: 'assets', name: '资产缺口报告', file: join(base, 'audit', 'asset-gaps.html'), url: '/static/' + host + '/audit/asset-gaps.html' },
      { id: 'intel', name: '竞品情报 Excel', file: join(base, 'intel', host + '-intel.xlsx'), url: '/static/' + host + '/intel/' + host + '-intel.xlsx' },
    ];
    return json(res, 200, { host, reports: defs.map(r => ({ id: r.id, name: r.name, url: r.url, available: existsSync(r.file), updatedAt: existsSync(r.file) ? statSync(r.file).mtimeMs : null })) });
  }

  // 资产清单：按页聚合 clone 资产（Top N 按体积排序）
  if (req.method === 'GET' && u.pathname.startsWith('/api/assets/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/assets/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const base = join(WORKSPACE, host);
    const pagesDir = join(base, 'pages');
    const items = [];
    let totalBytes = 0;
    let orphanReport = null;
    try {
      const op = join(base, 'audit', 'orphans.json');
      if (existsSync(op)) orphanReport = JSON.parse(readFileSync(op, 'utf8'));
    } catch {}
    const orphanSet = new Set(orphanReport?.orphanPaths ?? []);
    const reverse = new Map();   // page -> (clone 内相对路径 -> 原始 URL)
    if (existsSync(pagesDir)) {
      for (const page of readdirSync(pagesDir)) {
        try {
          const m = JSON.parse(readFileSync(join(pagesDir, page, 'asset-map.json'), 'utf8'));
          const r = new Map();
          for (const k of Object.keys(m.imgMap ?? {})) r.set(String(m.imgMap[k]), k);
          for (const k of Object.keys(m.resMap ?? {})) r.set(String(m.resMap[k]), k);
          reverse.set(page, r);
        } catch {}
      }
    }
    const walk = (dir, page, group) => {
      if (!existsSync(dir) || items.length > 200000) return;   // 收集上限（防极端目录；不再截断正常站点）
      for (const name of readdirSync(dir)) {
        const f = join(dir, name);
        let st; try { st = statSync(f); } catch { continue; }
        if (st.isDirectory()) walk(f, page, group);
        else if (st.isFile()) {
          totalBytes += st.size;
          const relWs = relative(WORKSPACE, f).split('\\').join('/');
          const relClone = relative(join(pagesDir, page, 'clone'), f).split('\\').join('/');
          items.push({ path: relWs, page, group, ext: extname(name).toLowerCase(), size: st.size, url: '/static/' + relWs, src: reverse.get(page)?.get(relClone) ?? '', orphan: orphanSet.has(relWs) });
        }
      }
    };
    if (existsSync(pagesDir)) {
      for (const page of readdirSync(pagesDir)) {
        walk(join(pagesDir, page, 'clone', 'assets'), page, 'asset');
        walk(join(pagesDir, page, 'clone', 'styles'), page, 'style');
      }
    }
    const byExt = {};
    const byPage = {};
    for (const it of items) {
      const k = it.ext || '(none)';
      byExt[k] = (byExt[k] ?? 0) + 1;
      const p = byPage[it.page] ?? (byPage[it.page] = { count: 0, bytes: 0 });
      p.count++; p.bytes += it.size;
    }
    // 查询参数：q / ext / page / minSize / sort / limit / offset
    const q = (u.searchParams.get('q') ?? '').trim().toLowerCase();
    const extSel = (u.searchParams.get('ext') ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const pageSel = u.searchParams.get('page') ?? '';
    const minSize = Number(u.searchParams.get('minSize') ?? 0) || 0;
    const sort = u.searchParams.get('sort') ?? 'size';
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit') ?? 300) || 300, 1), 2000);
    const offset = Math.max(Number(u.searchParams.get('offset') ?? 0) || 0, 0);
    let filtered = items;
    if (q) filtered = filtered.filter(it => it.path.toLowerCase().includes(q) || String(it.src ?? '').toLowerCase().includes(q));
    if (extSel.length) filtered = filtered.filter(it => extSel.includes(it.ext || '(none)'));
    if (pageSel) filtered = filtered.filter(it => it.page === pageSel);
    if (minSize > 0) filtered = filtered.filter(it => it.size >= minSize);
    if (u.searchParams.get('orphan') === '1') filtered = filtered.filter(it => it.orphan);
    filtered = [...filtered];
    if (sort === 'name') filtered.sort((x, y) => x.path.localeCompare(y.path));
    else if (sort === 'page') filtered.sort((x, y) => x.page.localeCompare(y.page) || y.size - x.size);
    else filtered.sort((x, y) => y.size - x.size);
    const filteredBytes = filtered.reduce((n, it) => n + it.size, 0);
    const ledgerPath = join(base, 'asset-ledger.json');
    let ledger = null; try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch {}
    const orphans = orphanReport ? { count: orphanReport.orphans, bytes: orphanReport.orphanBytes, generatedAt: orphanReport.generatedAt } : null;
    return json(res, 200, { host, count: items.length, totalBytes, filtered: filtered.length, filteredBytes, byExt, byPage, ledger, orphans, items: filtered.slice(offset, offset + limit) });
  }

  // 单端口部署：workspace 作为公开静态目录（/apify.com/recon/atlas.json 等，等价 Vite publicDir）
  {
    const firstSeg = u.pathname.split('/')[1] ?? '';
    if (firstSeg && !firstSeg.startsWith('.')) {
      const file = join(WORKSPACE, decodeURIComponent(u.pathname.replace(/^\/+/, '')));
      if (isInsideWorkspace(file) && existsSync(file)) {
        try {
          if (statSync(file).isFile()) return sendFile(req, res, file);
        } catch {}
      }
    }
  }

  // 单端口部署：控制台静态资源 + SPA 回退（HEIMDALL_CONSOLE_DIR=console/dist）
  if (CONSOLE_DIR && existsSync(CONSOLE_DIR) && u.pathname !== '/api') {
    const rel = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'index.html';
    const candidates = [join(CONSOLE_DIR, rel), join(CONSOLE_DIR, rel, 'index.html')];
    for (const f of candidates) {
      try {
        const r = relative(CONSOLE_DIR, f);
        if (r.startsWith('..') || isAbsolute(r)) continue;
        if (existsSync(f) && statSync(f).isFile()) return sendFile(req, res, f);
      } catch {}
    }
    if (!extname(u.pathname)) {
      const index = join(CONSOLE_DIR, 'index.html');
      if (existsSync(index)) { res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync(index)); return; }
    }
  }

  json(res, 404, { error: 'nf' });
}).listen(PORT, BIND, () => console.log(`engine-server @ http://${BIND}:${PORT}`));

// 优雅退出：关闭持久化存储（Docker stop / Ctrl-C）
const shutdown = () => { try { jobStore?.close(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
