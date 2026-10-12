/**
 * engine-server — Heimdall 引擎服务（W3）
 *
 *   POST /api/recon        {url, maxPages?}  → {taskId}（全站侦察）
 *   POST /api/forge        {url, hostPost?}  → {taskId, pageName}（单页还原流水线）
 *   POST /api/clone-site   {host, max?, incremental?, force?} → {taskId}（整站批量克隆，引擎侧跑）
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
import { WORKSPACE, DATA_ROOT, DELIVERABLE, isInside, isSecretFile } from './paths.mjs';
import { openJobStore, recoverInterrupted } from './jobs/store.mjs';
import { llmInfo, llmChat, llmChatWith, llmConfig } from './llm.mjs';
import { llmSettings, normalizePatch, writeEnvKeys } from './settings.mjs';
import { createWatchdog } from './task-watchdog.mjs';
import { writeProxyHead, mirrorHostOf } from './proxy-headers.mjs';
import { unmirroredBanner } from './live/live-html.mjs';
import { sessionInfo, clearSession } from './session/store.mjs';
import { loadProfile, sanitizeHost, queuePlan, MAX_SLOT_CEILING } from './site-profile.mjs';
import { UA } from './ua.mjs';
import { pageNameOfUrl } from './url-canon.mjs';

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


/**
 * 镜像站统一服务逻辑 —— 路径前缀入口与独立域名入口共用
 *
 *   · 路径前缀 /lm/<host>/<path>            —— 任何机器、任何浏览器都能用
 *   · 独立域名 <host>.localhost:<port>/<path> —— pathname 就是站点自己的路径
 *
 * 为什么必须有独立域名入口：纯前端渲染（SPA）站点的路由库靠读 location.pathname
 * 决定渲染什么。前缀入口下它看到 /lm/vitest.dev/，匹配不到任何路由，于是渲染
 * **它自己的 404 页** —— 脚本越正常，页面越"错"（实测 vitest.dev 修好响应头后
 * 整页变成 "404 | Vitest"）。独立域名下这个前缀根本不存在，路由、cookie、
 * localStorage 天然按站点隔离，与原站行为一致。
 *
 * 融合路由：本地 live/<path>/index.html 存在 → 回校准快照；否则全代理回原站
 * （未锻造页 / 资源 / JS chunk / API 全部原样透传，页面"活"）。
 */
async function serveMirror(req, res, u, lmHost, prefix) {
  try {
    const rest = prefix ? (decodeURIComponent(u.pathname.slice(prefix.length)) || '/') : u.pathname;
    const noWww = lmHost.replace(/^www\./, '');

    // 本地优先：无扩展名路径 → 该目录下的 index.html；有扩展名 → 精确路径。
    // 候选只放"文件"，目录本身绝不入候选（防 EISDIR）。
    const rel = rest.endsWith('/') ? rest + 'index.html' : rest;
    const candidates = /\.[a-z0-9]+$/i.test(rel)
      ? [join(WORKSPACE, noWww, 'live', rel)]
      : [join(WORKSPACE, noWww, 'live', rel.replace(/\/$/, '') + '/index.html')];
    const localFile = candidates.find(f => isInsideWorkspace(f) && existsSync(f));
    // 只对 GET/HEAD 回本地快照：快照是静态文件，吞掉 POST 会让页面的表单直接失效
    // （实测 apify.com 的 contact-sales 表单就是 POST 到当前路径）。
    if (localFile && (req.method === 'GET' || req.method === 'HEAD')) {
      // 独立域名模式下，快照里烘焙的 /lm/<host>/ 前缀要摘掉：那条路径在这个域名下不存在
      if (!prefix && /\.html?$/i.test(localFile)) {
        const html = readFileSync(localFile, 'utf8')
          .split('/lm/' + lmHost + '/').join('/')
          .split('/lm/' + lmHost).join('');
        res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return req.method === 'HEAD' ? res.end() : res.end(html);
      }
      return sendFile(req, res, localFile, { 'Cache-Control': 'no-cache' });
    }

    // 反代回原站（全方法透传；cookie 透传并剥 Domain/Secure，登录态落到我们域名下）
    const targetUrl = 'https://' + lmHost + rest + u.search;
    const fwdHeaders = {};
    for (const k of ['accept', 'accept-language', 'content-type', 'cookie']) {
      if (req.headers[k]) fwdHeaders[k] = req.headers[k];
    }
    fwdHeaders['user-agent'] = UA;
    fwdHeaders.referer = 'https://' + lmHost + '/';
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      redirect: 'follow',
    });
    const headers = new Headers();
    const to = prefix || '/';
    for (const [k, v] of upstream.headers) {
      const kl = k.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'set-cookie'].includes(kl)) continue;
      // 跳转目标要落回"我们这边的同一个站点"，不能把浏览器直接甩去原站
      if (kl === 'location') { headers.set(k, v.replace('https://' + lmHost, to).replace('https://www.' + lmHost, to)); continue; }
      headers.set(k, v);
    }
    for (const c of upstream.headers.getSetCookie?.() ?? []) {
      headers.append('set-cookie', c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*secure/gi, ''));
    }
    writeProxyHead(res, upstream.status, headers);
    const body = Buffer.from(await upstream.arrayBuffer());
    // 顶层文档导航 + 上游就是 HTML → 这是"用户在浏览一个没镜像的页"。
    // 只在这条路径补提示条：资源请求、RSC/fetch 载荷（sec-fetch-dest: empty）都不插，
    // 否则会把框架的数据流弄脏。理由见 live-html.mjs 的 unmirroredBanner。
    if (frameDocNavigation(req) && /text\/html/i.test(upstream.headers.get('content-type') ?? '')) {
      return res.end(unmirroredBanner(body.toString('utf8'), lmHost, { to }));
    }
    res.end(body);
  } catch (e) {
    try { json(res, 502, { error: String(e).slice(0, 140) }); } catch {}
  }
}

/**
 * 这是否是一次"用户在地址栏里进了这个页"的顶层文档导航？
 *
 * 优先信 `Sec-Fetch-Dest`（Fetch Metadata，Chrome/Firefox/Safari 都发）；
 * 只有它缺失时才退回看 Accept。**有 dest 但不是 document 就一律不算** ——
 * 反过来写会把 Next.js 用 `Accept: text/html` 拉的 RSC 载荷也当成导航。
 */
function frameDocNavigation(req) {
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document';
  return String(req.headers.accept ?? '').includes('text/html');
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
/** 代理白名单：默认只允许 workspace 下已存在的 host（已侦察/已捕获站点）
 *  用"列一次目录得到集合"代替"每个请求 stat 一次"：清单请求最热的一条路，
 *  而集合走 listCaches（8s TTL + 任务结束即失效）。顺带更安全 ——
 *  只有目录里真实存在的名字能命中，`..` 之类的构造永远匹配不上。 */
/**
 * workspace/<host>/live 下已生成的镜像页数 —— 交互镜像的**真实产量**。
 *
 * 为什么控制台需要这个数：镜像路由是"融合"的（本地有快照就回快照，否则反代回原站），
 * 所以一个**从没导出过**交互镜像的站点，`<host>.localhost:8900` 打开就是原站本身
 * （经本地代理）。按钮上写着「交互镜像」、点开却是官方页 —— 实测就是这个原因
 * （vercel.com 没有 live/ 产物）。有了这个数，控制台才能如实说明点下去会发生什么。
 */
function countLivePages(host) {
  let n = 0;
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === 'index.html') n++;
    }
  };
  walk(join(WORKSPACE, host, 'live'));
  return n;
}

const isProxyHost = (h) => {
  const noWww = String(h).replace(/^www\./, '');
  if (EXTRA_PROXY_HOSTS.has(noWww)) return true;
  return cached('proxyhosts', () => {
    try { return new Set(readdirSync(WORKSPACE)); } catch { return new Set(); }
  }).has(noWww);
};
const pageFor = (u) => pageNameOfUrl(u);
// 路径归属判断统一走 paths.mjs 的 isInside（用 relative 判，前缀判断会被 `..` 绕过）
const isInsideWorkspace = (file) => isInside(WORKSPACE, file);
const isInsideDataRoot = (file) => isInside(DATA_ROOT, file);

/** 请求体上限（8MB）：本工具的 API 都是小 JSON，唯一的大体量走的是文件而不是请求体 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 保留多少个任务对象。终态任务超量后按创建时间淘汰 —— 事件数组会一直涨，不清就是内存泄漏 */
const MAX_TASKS = 300;

/**
 * task = {id,kind:'recon'|'forge',url,status,events:[],subs:Set,child,atlasPath?,pageName?}
 */
const tasks = new Map();
let seq = 0;
let runningRecon = null;
let runningAudit = null;
let runningWatch = null;
let runningAssets = null;
let runningMatrix = null;
let runningVerify = null;
let runningLive = null;
let runningSession = null;
let runningReclaim = null;
let runningUpgrade = null;
let runningClone = null;

/**
 * 请求期读盘缓存 —— 只服务"读多写少"的三处清单接口。
 *
 * 为什么需要：/api/assets、/api/sites、isProxyHost 都在请求里同步遍历磁盘
 * （前者递归走完每页的资产树，后两者是站点×页面）。事件循环是单线程的，
 * 一次几百毫秒的遍历期间，所有其它请求（含 SSE 心跳）都被卡住。
 *
 * 失效策略两条一起用，缺一不可：
 *   · 短 TTL（清单视图容忍几秒陈旧，不值得每帧重算）
 *   · 任何任务结束就 bust（克隆/删除/导出刚落盘，用户马上就会去看 —— 这一刻不能陈旧）
 * bust 是"正确性"那一半：光靠 TTL 会让"刚克隆完打开资产页还是旧的"变成新 bug。
 */
const CACHE_TTL_MS = 8000;
const listCaches = new Map();   // key -> { at, val }
function cached(key, compute) {
  const hit = listCaches.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;
  const val = compute();
  listCaches.set(key, { at: Date.now(), val });
  return val;
}
function bustCaches() { listCaches.clear(); }
// 每个锻造槽 = 一个 Chromium 实例。默认 2（笔记本上稳），大机子/演示可调 HEIMDALL_FORGE_SLOTS。
const MAX_FORGE = (() => {
  const n = Math.floor(Number(process.env.HEIMDALL_FORGE_SLOTS));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_SLOT_CEILING) : 2;
})();
let forgeSlots = 0;

const push = (t, ev) => {
  t.events.push(ev);
  if (typeof ev?.kind === 'string' && ev.kind.endsWith('-error')) t.error = ev.error ?? 'error';
  jobStore?.appendEvent(t.id, ev);
  for (const res of t.subs) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  // 有进展就重置"无进展熔断"计时 —— 熔断判的是卡死，不是总耗时
  t.watchdog?.touch();
};

/** 日志环缓冲的容量：够看"现在在干什么"，又不至于把内存当日志仓库 */
const LOG_KEEP = 200;

/**
 * 子进程的普通输出（非 @@EVENT@@ 行）转成**日志事件**，只给"正在跑"的界面看。
 *
 * 为什么与 push 分开：push 会把每个事件写进 sqlite（jobs.db），而捕获阶段每下一张图
 * 就打印一行 —— 一次整站克隆能刷出上万行，进数据库纯属糟蹋。
 * 这里只留在内存环形缓冲里（最近 200 行），SSE 实时推给订阅者，任务结束后随对象消失。
 */
const emitLog = (t, raw) => {
  const line = String(raw).replace(/\s+$/, '');
  if (!line) return;
  t.logs.push(line);
  if (t.logs.length > LOG_KEEP) t.logs.splice(0, t.logs.length - LOG_KEEP);
  const ev = { kind: 'log', line };
  for (const res of t.subs) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  t.watchdog?.touch();
};

/** 杀掉子进程树。win32 上普通 kill 不带走孙进程（Chromium），必须 taskkill /T。 */
function killTree(child, signal = 'SIGKILL') {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

/** 熔断：超时或无进展时杀掉任务子进程，并把它记成失败原因 */
function killTask(t, reason) {
  if (t.status !== 'running' || t.killed) return;
  t.killed = reason;
  t.error = reason === 'stalled' ? '单页长时间无进展，已熔断' : '单页超出时间上限，已熔断';
  push(t, { kind: 'forge-timeout', reason, message: t.error });
  killTree(t.child);
}

function makeTask(kind, url) {
  const id = `${kind[0]}${String(++seq).padStart(3, '0')}`;
  const t = { id, kind, url, status: 'running', events: [], logs: [], subs: new Set(), child: null, atlasPath: null, createdAt: Date.now(), cancelRequested: false, killed: null, timeoutMs: 0, stallMs: 0 };
  tasks.set(id, t);
  jobStore?.upsert({ id, kind, url, status: 'running', createdAt: t.createdAt });
  // 淘汰：终态任务超过上限就按创建时间丢掉最老的。每个任务的 events/logs 只涨不消，
  // 长跑（或长时间不重启引擎）必然涨内存 —— 而任务列表本来就是"最近发生过什么"。
  if (tasks.size > MAX_TASKS) {
    const finished = [...tasks.values()].filter(x => x.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
    for (const old of finished.slice(0, tasks.size - MAX_TASKS)) {
      try { old.subs.clear(); } catch { /* 订阅者已经断了 */ }
      tasks.delete(old.id);
    }
  }
  return t;
}

/** spawn 引擎脚本并解析 @@EVENT@@ 行 → task 事件流 */
function spawnTask(t, script, args, opts = {}) {
  const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), script, ...args], {
    cwd: join(HERE, '..'),
    env: { ...process.env, HEIMDALL_PORT: String(PORT), ...(opts.env ?? {}) },
  });
  t.child = child;
  // 熔断：硬超时（这页跑太久）+ 无进展（这页卡死了）。判据与计时见 task-watchdog.mjs。
  if (opts.timeoutMs > 0 || opts.stallMs > 0) {
    t.timeoutMs = opts.timeoutMs ?? 0;
    t.stallMs = opts.stallMs ?? 0;
    t.watchdog = createWatchdog({
      timeoutMs: opts.timeoutMs ?? 0,
      stallMs: opts.stallMs ?? 0,
      onKill: (reason) => killTask(t, reason),
    });
  }
  let buf = '';
  child.stdout.on('data', (d) => {
    t.watchdog?.touch();   // 子进程还在说话 = 还活着（捕获下载大图时可能几分钟没有阶段事件）
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith('@@EVENT@@')) { emitLog(t, line); continue; }
      try { push(t, JSON.parse(line.slice(9))); } catch {}
    }
  });
  child.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) emitLog(t, line);
    process.stderr.write(`[${t.id}] ` + d.toString());   // 引擎自己的终端也照旧显示，便于排查
  });
  child.on('exit', (code) => {
    t.watchdog?.stop();
    t.status = t.cancelRequested ? 'cancelled' : code === 0 ? 'done' : 'failed';
    t.endedAt = Date.now();
    push(t, { kind: 'exit', code, status: t.status, killed: t.killed ?? undefined });
    // 任务刚落盘新产物，缓存的清单即刻变陈旧 —— 这一刻必须失效，不能等 TTL。
    // "刚克隆完打开资产页还是旧的"会是比卡顿难查得多的 bug。
    bustCaches();
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
    else if (t.kind === 'clone') runningClone = null;        // 整站克隆是编排任务，不占锻造槽
    else if (t.kind === 'session') runningSession = null;    // 登录会话不占锻造槽（漏这条会走到末尾的 forgeSlots--）
    else if (t.kind === 'storage') storageScanTask = null;   // 盘点任务不占锻造槽
    else if (t.kind === 'deliver') deliverTask = null;       // 同理
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
  t.label = '交互镜像导出 ' + host;
  runningLive = t;
  const args = [host, '--offline', '--root', root === 'landing' ? 'landing' : 'mirror', '--heal', '--materialize-har'];
  if (rebuild) args.push('--rebuild');
  return spawnTask(t, join('src', 'live', 'export.mjs'), args, { nodeArgs: ['--max-old-space-size=4096'] }).id;
}

/**
 * 磁盘盘点必须走子进程。
 *
 * 实测：同步遍历 5.4 万文件要 ~12 秒，期间 **Node 事件循环完全冻结** ——
 * 连 500ms 的定时器都不会触发，所有 API 请求（含 SSE、交互镜像代理）全部排队。
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

/**
 * 交付包清理。**同样走子进程**：deliverable/ 实测有 8 个包 / 1.88GB / 上万个文件，
 * 扫描要 stat 每一个文件、删除要 unlink 每一个 —— 与磁盘盘点同一量级，
 * 放在请求处理里会冻住事件循环（见上面 startStorageScan 的注释）。
 */
const DELIVER_PLAN_JSON = join(DATA_ROOT, 'deliver-plan.json');
let deliverTask = null;

function readDeliverPlan() {
  try { return JSON.parse(readFileSync(DELIVER_PLAN_JSON, 'utf8')); } catch { return null; }
}

function startDeliverPrune(apply) {
  if (deliverTask && deliverTask.status === 'running') return deliverTask.id;
  const t = makeTask('deliver', 'local://deliver');
  t.label = apply ? '交付包清理' : '交付包盘点';
  deliverTask = t;
  return spawnTask(t, join('src', 'audit', 'deliver-prune.mjs'), apply ? ['--apply'] : []).id;
}

/**
 * CAS 资产回收/盘点。**同样走子进程**：它要遍历整个内容寻址库（实测 0.5s 起，
 * 站点多时更久），同步跑就是在这段时间冻住所有别的请求。脚本本来就有
 * （audit/cas-gc.mjs），结果以 `cas-gc` 事件回来，控制台据此更新读数。
 */
function startCasGc(apply = false) {
  const t = makeTask('cas-gc', 'local://cas');
  t.label = apply ? 'CAS 资产回收' : 'CAS 资产盘点';
  return spawnTask(t, join('src', 'audit', 'cas-gc.mjs'), apply ? ['--apply'] : []).id;
}

/**
 * 「改站起点」清单：把已抓取的产物按"要改什么"重排（域名 / 资源 / 文案）。
 * **为什么走子进程**：它要读每一页的 asset-map 与 intel，大站（apify 61 页）实测
 * 约 5 秒 —— 放在请求处理里就是 5 秒的事件循环冻结，与 /api/assets 是同一个教训。
 */
let editManifestTask = null;

function startEditManifest(host) {
  if (editManifestTask && editManifestTask.status === 'running' && editManifestTask.host === host) return editManifestTask.id;
  const t = makeTask('editmanifest', 'https://' + host);
  t.host = host;
  t.label = '改站清单 · ' + host;
  editManifestTask = t;
  return spawnTask(t, join('src', 'deliver', 'edit-manifest.mjs'), [host]).id;
}

function startForge(url, { hostPost = true } = {}) {  const t = makeTask('forge', url);
  const u = new URL(url);
  const name = pageNameOfUrl(u);
  t.pageName = name;
  const env = hostPost ? {} : { HEIMDALL_SKIP_HOST_POST: '1' };
  // 单页熔断参数来自站点配方（大站可以给更长的上限，挂死页统一在 8 分钟内判死）
  const plan = queuePlan(loadProfile(u.hostname.replace(/^www\./, '')));
  return { id: spawnTask(t, join('src', 'pipeline.mjs'), [url, name], { env, timeoutMs: plan.pageTimeoutMs, stallMs: plan.stallMs }).id, name };
}

/**
 * 整站批量克隆 —— 由引擎跑 queue.mjs，而不是让浏览器标签页来驱动。
 * 好处：关掉控制台页面任务照跑、并发与超时按配方走、只占一个"编排"名额不占锻造槽。
 */
function startCloneSite(host, { max = null, incremental = false, force = false } = {}) {
  const t = makeTask('clone', 'https://' + host);
  t.host = host;
  t.label = '整站克隆 ' + host;
  runningClone = t;
  const profile = loadProfile(host);
  const plan = queuePlan(profile, MAX_FORGE);
  t.plan = { workers: plan.workers, maxPages: max ?? plan.maxPages, incremental, force };
  const args = [host, '--max', String(max ?? plan.maxPages), '--json-events'];
  if (incremental) args.push('--incremental');
  if (force) args.push('--force');
  return spawnTask(t, join('src', 'queue.mjs'), args, { env: { HEIMDALL_QUEUE_WORKERS: String(plan.workers) } }).id;
}

/**
 * 资产索引 —— 一次遍历，两处共用。
 *
 * 全引擎最重的请求期同步 IO：走完每一页的 clone/assets 与 clone/styles，
 * 外加每页的 asset-map 反查表。/api/assets 要它做清单，/api/pages 的「资产」列
 * 也只是同一批文件的一个分组统计 —— 此前两边各走一遍，纯属重复劳动。
 *
 * 进 listCaches：8s TTL + 任务结束/删站删页即失效（见 cached 的注释）。
 */
function assetIndex(host) {
  return cached('assets:' + host, () => {
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
      const byPageAssets = {};   // 只看 clone/assets（/api/pages 的「资产」列口径；byPage 还含 styles）
      for (const it of items) {
        const k = it.ext || '(none)';
        byExt[k] = (byExt[k] ?? 0) + 1;
        const p = byPage[it.page] ?? (byPage[it.page] = { count: 0, bytes: 0 });
        p.count++; p.bytes += it.size;
        if (it.group === 'asset') {
          const q = byPageAssets[it.page] ?? (byPageAssets[it.page] = { count: 0, bytes: 0 });
          q.count++; q.bytes += it.size;
        }
      }
      return { items, totalBytes, orphanSet, orphanSummary: orphanReport, byExt, byPage, byPageAssets };
  });
}

const handleRequest = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // 请求体上限。十来个 POST 处理器各自 `req.on('data')` 累加 body，谁都没有上限 ——
  // 一个声明了 2GB 的请求就够把引擎撑爆。这里用 Content-Length 提前拦掉这种请求
  // （分块传输没有长度头，本地工具场景下不追；真要堵就得所有处理器共用一个 readBody）。
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) return json(res, 413, { error: 'body too large', limit: MAX_BODY_BYTES });
  }

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
      killTree(t.child, 'SIGTERM');      // 取消时先给个优雅退出的机会（win32 上仍是整树杀）
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

  if (req.method === 'POST' && u.pathname === '/api/clone-site') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let host, max = null, incremental = false, force = false;
      try { ({ host, max, incremental, force } = JSON.parse(body || '{}')); } catch {}
      host = sanitizeHost(host);
      if (!/^[a-z0-9.-]+$/.test(host)) return json(res, 400, { error: 'bad host' });
      if (runningClone) return json(res, 409, { error: 'busy', taskId: runningClone.id });
      const id = startCloneSite(host, {
        max: max == null ? null : Math.min(Math.max(Number(max) || 20, 1), 2000),
        incremental: !!incremental, force: !!force,
      });
      json(res, 200, { taskId: id, host });
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

  // 在系统文件管理器里显示一个产物目录（导出交付包之后要"拿去发给同事"）。
  // 只允许 DATA_ROOT 以内的路径：这是个"打开资源管理器"的口子，不能变成任意路径探针。
  if (req.method === 'POST' && u.pathname === '/api/reveal') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let target = '';
      try { ({ path: target } = JSON.parse(body || '{}')); } catch {}
      const abs = isAbsolute(String(target)) ? String(target) : join(DATA_ROOT, String(target));
      if (!isInsideDataRoot(abs)) return json(res, 403, { error: 'path outside data root' });
      if (!existsSync(abs)) return json(res, 404, { error: 'not found', path: abs });
      const cmd = process.platform === 'win32' ? ['explorer.exe', ['/select,' + abs]]
        : process.platform === 'darwin' ? ['open', ['-R', abs]]
          : ['xdg-open', [dirname(abs)]];
      try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); return json(res, 200, { ok: true, path: abs }); }
      catch (e) { return json(res, 500, { error: String(e).slice(0, 120) }); }
    });
    return;
  }

  // 登录态：开一个可见浏览器让人手动登录一次，之后所有抓取复用（见 src/session/）
  if (req.method === 'POST' && u.pathname === '/api/session/login') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let host = '';
      try { ({ host } = JSON.parse(body || '{}')); } catch {}
      host = String(host ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningSession) return json(res, 409, { error: 'busy', taskId: runningSession.id });
      const task = makeTask('session', 'https://' + host);
      task.host = host;
      task.label = '登录会话 ' + host;
      runningSession = task;
      const id = spawnTask(task, join('src', 'session', 'login.mjs'), [host, '--timeout', '15']);
      json(res, 200, { taskId: id, host, hint: '浏览器窗口已打开：登录完成后关掉那个标签页即可' });
    });
    return;
  }
  if (req.method === 'GET' && u.pathname.startsWith('/api/session/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/session/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    return json(res, 200, sessionInfo(host));
  }
  if (req.method === 'DELETE' && u.pathname.startsWith('/api/session/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/session/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    return json(res, 200, clearSession(host));
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
    // 重放：先日志（它描述"过程"），再事件（它描述"状态"）。
    // 日志不进 sqlite（见 emitLog），所以只在这里的内存缓冲里重放。
    if (t.logs?.length) for (const line of t.logs) res.write(`data: ${JSON.stringify({ kind: 'log', line })}\n\n`);
    for (const ev of t.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);   // 重放
    if (t.status !== 'running') { res.end(); return; }
    t.subs.add(res);
    req.on('close', () => t.subs.delete(res));
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/api/atlas/')) {
    const t = tasks.get(u.pathname.split('/').pop());
    if (!t?.atlasPath || !existsSync(t.atlasPath)) return json(res, 404, { error: 'atlas not ready' });
    // 流式发送：atlas.json 可能上百 KB~MB，readFileSync 会先整个读进内存再写，
    // 期间阻塞事件循环。createReadStream 边读边写，不占事件循环。
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    createReadStream(t.atlasPath).pipe(res);
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/static/')) {
    // 常驻静态服务：/static/<host>/pages/<name>/clone/index.html 等（workspace 根）
    let rel = decodeURIComponent(u.pathname.slice('/static/'.length));
    if (rel.endsWith('/')) rel += 'index.html';
    const file = join(WORKSPACE, rel);
    if (!isInsideWorkspace(file) || !existsSync(file)) return json(res, 404, { error: 'nf' });
    if (isSecretFile(file)) return json(res, 403, { error: 'not served', hint: '登录凭据与原始抓包不通过静态通道外发' });
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
      // 资产统计复用 /api/assets 的那份索引（同一批文件、同一趟遍历）——
      // 此前这里对每页各自走一遍 clone/assets，和 /api/assets 的整树遍历是重复劳动。
      const pageAssets = assetIndex(host).byPageAssets ?? {};
      for (const name of readdirSync(pagesDir)) {
        const cloneHtml = join(pagesDir, name, 'clone', 'index.html');
        if (!existsSync(cloneHtml)) continue;
        let target = '', score = null;
        try { target = JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target ?? ''; } catch {}
        try { score = JSON.parse(readFileSync(join(pagesDir, name, 'score.json'), 'utf8')); } catch {}
        const assets = pageAssets[name] ?? { count: 0, bytes: 0 };
        // updatedAt = 这一页克隆产物的构建时间。控制台拿它当截图的 cache-buster
        // （重新克隆后两张图必须刷新）。只需要**一次 stat**，不走资产树遍历。
        let mtime = 0; try { mtime = statSync(cloneHtml).mtimeMs; } catch {}
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
        // 动效驱动画像（capture 阶段采，见 crawler/motion.mjs）——旧产物没有这个文件
        let motion = null;
        try { motion = JSON.parse(readFileSync(join(pagesDir, name, 'motion.json'), 'utf8')); } catch {}
        out.push({
          name, target, forged: true,
          score: score ? { total: score.total, pixel: score.pixel, grade: score.grade } : null,
          assets,
          visualGaps: gapMap[name] ?? null,
          interactions,
          minViewport,
          motion,
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

  // 交互镜像体检：读取最新 <host>-live-*/health.json（导出时生成）
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
        // 与上一次导出的差异（live/changes.mjs 产出）——"这次多了什么"要能读出来
        let changes = null;
        try { changes = JSON.parse(readFileSync(join(DELIVERABLE, d, 'changes.json'), 'utf8')); } catch {}
        return json(res, 200, { ...health, bundle: d, bundlePath: join(DELIVERABLE, d), changes });
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
  // 「改站起点」清单：读每页的 asset-map/intel 并重排（大站约 5s），所以走子进程 + 任务。
  // 产物落在 workspace/<host>/deliver/edit-manifest.{json,md}，控制台与交付包都读它。
  if (u.pathname === '/api/edit-manifest' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
    const host = String(body.host ?? '');
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const taskId = startEditManifest(host);
    return json(res, 202, { ok: true, taskId, status: 'running' });
  }
  // 域名替换：预览（apply=false，默认）或真改（apply=true，子进程里先备份再改）。
  // 真改会写用户的产物 —— 所以默认必须是预览，且改前备份（见 deliver/replace-domain.mjs 文件头）。
  if (u.pathname === '/api/replace-domain' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
    const host = String(body.host ?? '');
    const from = String(body.from ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const to = String(body.to ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const apply = body.apply === true;
    if (!/^[a-z0-9.-]+$/i.test(host) || !/^[a-z0-9.-]+$/.test(from) || !/^[a-z0-9.-]+$/.test(to)) return json(res, 400, { error: 'bad host/from/to' });
    if (from === to) return json(res, 400, { error: 'same' });
    if (apply && !isLoopback(req) && AUTH_TOKEN && req.headers['x-heimdall-token'] !== AUTH_TOKEN) return json(res, 403, { error: 'forbidden' });
    const t = makeTask('replace-domain', 'https://' + host);
    t.host = host;
    t.label = (apply ? '替换域名 · ' : '预览替换 · ') + from + ' → ' + to;
    const args = [host, '--from', from, '--to', to, ...(apply ? ['--apply'] : []), ...(body.js === true ? ['--js'] : [])];
    return json(res, 202, { ok: true, taskId: spawnTask(t, join('src', 'deliver', 'replace-domain.mjs'), args).id, status: 'running' });
  }
  // 交付包保留策略。扫描与删除都在子进程里做（上万个文件），这里只读结果文件。
  if (u.pathname === '/api/deliver/plan' && req.method === 'GET') {
    const p = readDeliverPlan();
    if (!p) startDeliverPrune(false);      // 第一次访问时后台算一次
    return json(res, 200, p ?? { pending: true, scanning: !!(deliverTask && deliverTask.status === 'running') });
  }
  if (u.pathname === '/api/deliver/prune' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
    const apply = body.apply === true;
    // 与 CAS 回收同一道闸：删除不可逆，未设 token 时只允许本机回环
    if (apply && !AUTH_TOKEN && !isLoopback(req)) {
      return json(res, 403, { error: '真删除需要 HEIMDALL_TOKEN；未设置时仅允许本机回环访问' });
    }
    if (apply && body.confirm !== 'HEIMDALL_DELIVER_PRUNE') {
      return json(res, 400, { error: '真删除需要 confirm=HEIMDALL_DELIVER_PRUNE' });
    }
    const taskId = startDeliverPrune(apply);
    return json(res, 202, { ok: true, taskId, apply, status: 'running' });
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
    // 走子进程：gcCas 要遍历整个 CAS（实测 0.5s 起），在请求线程里同步跑会冻住所有别的请求。
    // 脚本本来就存在（audit/cas-gc.mjs），结果作为 cas-gc 事件回来。
    const taskId = startCasGc(apply);
    startStorageScan();                                               // 重新盘点交给另一个子进程
    return json(res, 202, { ok: true, taskId, apply, status: 'running' });
  }

  if (req.method === 'GET' && u.pathname === '/api/sites') {
    // 站点清单 —— 控制台切换器数据源。
    //
    // 判据是"这个 host 有可用产物"，**不只是"有 atlas.json"**：
    // 用户完全可能只跑 `forge <url>` 克隆单页（这正是"一次性便利"的主路径），
    // 那样只有 pages/ 没有 recon/。此前这类站点在控制台里完全看不见 ——
    // 克隆成功了，但界面上找不到它。实测：vitest.dev 就被这样漏掉。
    const wsDir = WORKSPACE;
    let sites;
    try {
      // 整段进缓存：它是 O(站点 × 页面) 的同步遍历，控制台切站/刷新都会打它。
      // 缓存键是常量 'sites'，靠 listCaches 的 TTL + 任务结束 bust 保鲜。
      sites = cached('sites', () => {
      const sites = [];
      for (const d of readdirSync(wsDir)) {
        if (d.startsWith('.') || d.startsWith('_')) continue;   // _matrix / _shots 等内部目录不是站点
        const pagesDir = join(wsDir, d, 'pages');
        const forged = existsSync(pagesDir)
          ? readdirSync(pagesDir).filter(n => existsSync(join(pagesDir, n, 'clone', 'index.html'))).length
          : 0;
        const ap = join(wsDir, d, 'recon', 'atlas.json');
        const hasAtlas = existsSync(ap);
        // 只做过 SEO 审计（没有侦察也没有克隆）的站点也要出现 ——
        // 否则"审计完一个竞品站，回控制台找不到它"就成了死角。实测踩到。
        const seoJson = join(wsDir, d, 'seo', 'seo.json');
        const hasAudit = existsSync(seoJson);
        if (!hasAtlas && !forged && !hasAudit) continue;        // 什么产物都没有 → 不算站点

        let atlas = null;
        if (hasAtlas) { try { atlas = JSON.parse(readFileSync(ap, 'utf8')); } catch {} }

        // 克隆产物与侦察集合**不是同一批页面**，混在一起做分子分母就是错的。
        // 实测：apify 侦察发现 62 页、磁盘上有 61 页克隆产物，但真正落在侦察集合里的
        // 只有 48 页 —— 界面上一度写「61/62 已克隆」，那个分数是假的。
        // 所以四个数分开给，界面各取所需。
        const discovered = atlas?.nodes?.length ?? 0;
        // manifest.json 只读一次：下面"重合页数"和"origin 兜底"都要它，
        // 之前拆成两个循环读两遍 —— 每页一次多余的 IO。
        const clonedTargets = [];
        if (forged) {
          for (const n of readdirSync(pagesDir)) {
            try {
              const t = JSON.parse(readFileSync(join(pagesDir, n, 'manifest.json'), 'utf8')).target;
              if (t) clonedTargets.push(t);
            } catch { /* 缺 manifest 的产物不参与重合统计 */ }
          }
        }
        const clonedUrls = new Set();
        for (const t of clonedTargets) {
          try { clonedUrls.add(new URL(t).pathname.replace(/\/$/, '') || '/'); } catch {}
        }
        // 从**克隆产物**这一侧数重合：atlas 里可能有两个节点指向同一路径
        // （`https://x` 与 `https://x/`），从 atlas 侧数就会得出比克隆页还多的重合数。
        const atlasPaths = new Set();
        for (const n of atlas?.nodes ?? []) {
          try { atlasPaths.add(new URL(n.url).pathname.replace(/\/$/, '') || '/'); } catch {}
        }
        let clonedInAtlas = 0;
        for (const p of clonedUrls) if (atlasPaths.has(p)) clonedInAtlas++;

        // 没有 atlas 时从页面 manifest 推 origin（manifest.target 是原站 URL）
        let origin = atlas?.origin ?? '';
        if (!origin) {
          for (const t of clonedTargets) { try { origin = new URL(t).origin; break; } catch {} }
        }
        // 只审计过的站点：分数从 seo.json 里取，列表上直接能看见结果
        let audit = null;
        if (hasAudit) {
          try {
            const j = JSON.parse(readFileSync(seoJson, 'utf8'));
            audit = { score: j.score ?? null, pages: j.summary?.pages ?? j.pages?.length ?? 0, at: j.generatedAt ?? null };
            if (!origin && j.origin) origin = j.origin;
          } catch { /* 报告坏了不影响站点出现 */ }
        }
        sites.push({
          host: d,
          origin: origin || ('https://' + d),
          pages: discovered,          // 兼容旧字段名 = 侦察发现的页数
          discovered,                 // 侦察发现
          forged,                     // 磁盘上的克隆产物
          cloned: forged,
          clonedInAtlas,              // 既被侦察发现、也已克隆（唯一诚实的"完成度"分子）
          extra: Math.max(0, forged - clonedInAtlas),   // 已克隆但侦察没覆盖到（早先手工克隆等）
          // 交互镜像的实际产量：0 表示没导出过，此时「交互镜像」入口打开的是原站本身
          mirrored: countLivePages(d),
          audit,
          edges: atlas?.meta?.edges ?? 0,
          // partial = 缺全站侦察（只克隆过，或只审计过）；控制台据此给不同的引导
          status: atlas ? (atlas.status ?? (atlas.nodes?.length ? 'ok' : 'failed')) : 'partial',
          failures: atlas?.failures?.length ?? 0,
        });
      }
      return sites;
      });
    } catch (e) {
      // 静默返回空清单是最坏的失败方式：控制台的站点下拉会**变空**，看起来像"站点全没了"，
      // 而真正的原因（某个产物文件读不动、权限、磁盘）一个字都看不到。
      return json(res, 500, { error: 'scan failed', detail: String(e).slice(0, 200), sites: [] });
    }
    return json(res, 200, { sites });
  }

  // 整站克隆的断点状态：读 workspace/<host>/queue.json。
  // 存在的意义：queue.mjs 本来就支持"跳过已完成页续跑"，但控制台看不到这件事 ——
  // 一批 60 页的站中断后，用户唯一能做的判断是"再点一次整站克隆"，而不知道它会不会重头再来。
  // 这个接口把那句"还剩 N 页"变成可显示的读数，再配一个"继续"按钮。
  if (req.method === 'GET' && u.pathname.startsWith('/api/queue/')) {
    const host = decodeURIComponent(u.pathname.slice('/api/queue/'.length));
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const qp = join(WORKSPACE, host, 'queue.json');
    if (!existsSync(qp)) return json(res, 200, { host, exists: false });
    let q;
    try { q = JSON.parse(readFileSync(qp, 'utf8')); } catch { return json(res, 200, { host, exists: true, unreadable: true }); }
    if (!Array.isArray(q)) return json(res, 200, { host, exists: true, unreadable: true });
    const count = (s) => q.filter(x => x.status === s).length;
    const done = count('done'), failed = count('failed'), pending = count('pending'), queued = count('queued');
    const active = !!(runningClone && runningClone.host === host && runningClone.status === 'running');
    return json(res, 200, { host, exists: true, total: q.length, done, failed, pending, queued, unfinished: failed + pending + queued, active, taskId: active ? runningClone.id : null });
  }

  // 反向代理 /px/<host>/<path> → https://<host>/<path> —— 交互镜像基础设施：
  // 镜像页的 API/资源请求走此通道回原站，"功能数据用原站跑通"
  if (req.method === 'GET' && u.pathname.startsWith('/px/')) {
    const m = /^\/px\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(res, 400, { error: 'bad proxy path' });
    if (!isProxyHost(m[1])) return json(res, 403, { error: 'host not allowed (recon it first or set HEIMDALL_ALLOWED_HOSTS)' });
    const target = 'https://' + m[1] + (m[2] ?? '/') + u.search;
    try {
      const upstream = await fetch(target, { headers: { 'User-Agent': UA, Accept: req.headers.accept ?? '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow' });
      const headers = new Headers();
      for (const [k, v] of upstream.headers) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy'].includes(k.toLowerCase())) continue;
        headers.set(k, v);
      }
      writeProxyHead(res, upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) { json(res, 502, { error: String(e).slice(0, 120) }); }
    return;
  }

  // Referrer 感知兜底：交互镜像页发出的"裸根相对"请求（JS 运行时拼接，patch 漏接形态）
  // 按 referer 里的 /lm/<host> 溯源转发原站——覆盖 fetch patch 漏掉的 Image src/srcset/动态 import/模块加载
  //
  // host 后面**不能要求必须有斜杠**：`/lm/ant.design`（首页无尾斜杠，正是控制台「交互镜像」
  // 链接的形态）此前匹配不上，于是页面的根相对 chunk 全部落到 SPA 兜底 → 404 → 白屏。
  // 实测 ant.design 交互镜像整页空白就是这个原因。
  if (!['/api/', '/static/', '/lm/', '/px/'].some(pre => u.pathname.startsWith(pre))) {
    const ref = req.headers.referer ?? '';
    const lmRef = /\/lm\/([^/?#]+)(?:\/|$|\?|#)/.exec(ref);
    if (lmRef && isProxyHost(lmRef[1])) {
      const lh = lmRef[1];
      const target = 'https://' + lh + u.pathname + u.search;
      try {
        const upstream = await fetch(target, { method: req.method, headers: { 'User-Agent': UA, Accept: req.headers.accept ?? '*/*', Referer: 'https://' + lh + '/' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req });
        const headers = new Headers();
        for (const [k, v] of upstream.headers) {
          if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy'].includes(k.toLowerCase())) continue;
          headers.set(k, v);
        }
        writeProxyHead(res, upstream.status, headers);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (e) { json(res, 502, { error: String(e).slice(0, 100) }); }
      return;
    }
  }

  // 独立域名入口：<host>.localhost:<port>/ —— 该站镜像的根（理由见 serveMirror 注释）
  // 放在 /static/ 之后：本地快照引用的 /static/<host>/… 仍由引擎自己的静态分支提供，
  // 其余一切（含被镜像站自己的 /api/）都属于那个站，原样透传。
  const subHost = mirrorHostOf(req.headers.host);
  if (subHost) {
    if (!isProxyHost(subHost)) return json(res, 403, { error: 'host not allowed', host: subHost });
    return serveMirror(req, res, u, subHost, '');
  }

  // 路径前缀入口：/lm/<host>/<path> —— 通用（不依赖 *.localhost 解析），但前缀会进 location.pathname
  if (u.pathname.startsWith('/lm/')) {
    const m = /^\/lm\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(res, 400, { error: 'bad lm path' });
    if (!isProxyHost(m[1])) return json(res, 403, { error: 'host not allowed' });
    return serveMirror(req, res, u, m[1], '/lm/' + m[1]);
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
      session: runningSession ? { id: runningSession.id, host: runningSession.host } : null,
      upgrade: runningUpgrade ? { id: runningUpgrade.id, host: runningUpgrade.host } : null,
      clone: runningClone ? { id: runningClone.id, host: runningClone.host, plan: runningClone.plan } : null,
      editManifest: editManifestTask && editManifestTask.status === 'running' ? { id: editManifestTask.id, host: editManifestTask.host } : null,
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
        bustCaches();                                                          // 站点没了，清单与代理白名单都得重算
        const casGcTask = startCasGc(true);                                    // 回收改子进程，不占请求线程
        startStorageScan();                                                    // 12s 的盘点交给子进程
        return json(res, 200, { ok: true, removed: 'site', host, casGcTask });
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
        const casGcTask = removedArtifacts ? startCasGc(true) : null;          // 回收改子进程
        if (removedArtifacts) startStorageScan();
        bustCaches();                                                          // 删了一页，资产清单/站点重合数随即变化
        return json(res, 200, { ok: true, removed: 'page', host, name, removedArtifacts, removedNode, casGcTask });
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
    const { items, totalBytes, orphanSet, orphanSummary, byExt, byPage } = assetIndex(host);
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
    const orphans = orphanSummary ? { count: orphanSummary.orphans, bytes: orphanSummary.orphanBytes, generatedAt: orphanSummary.generatedAt } : null;
    return json(res, 200, { host, count: items.length, totalBytes, filtered: filtered.length, filteredBytes, byExt, byPage, ledger, orphans, items: filtered.slice(offset, offset + limit) });
  }

  // 单端口部署：workspace 作为公开静态目录（/apify.com/recon/atlas.json 等，等价 Vite publicDir）
  {
    const firstSeg = u.pathname.split('/')[1] ?? '';
    if (firstSeg && !firstSeg.startsWith('.')) {
      const file = join(WORKSPACE, decodeURIComponent(u.pathname.replace(/^\/+/, '')));
      if (isInsideWorkspace(file) && existsSync(file) && !isSecretFile(file)) {
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
};

// 兜底：任何路由里抛出的异常只让这一个请求变 500，**不带崩进程**。
// 这不是假想的防御 —— 本文件里一次改动漏掉一个变量作用域就让整个引擎
// 在收到一个 /api/assets 请求时直接退出（所有其它接口一起没），排查成本极高。
const server = createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((err) => {
    console.error('[engine] request handler failed:', err);
    try {
      if (!res.headersSent) json(res, 500, { error: 'internal', detail: String(err?.message ?? err).slice(0, 200) });
      else res.end();
    } catch { /* 响应已经废了，只能吞掉 */ }
  });
});
server.listen(PORT, BIND, () => console.log(`engine-server @ http://${BIND}:${PORT}`));

// 优雅退出：关闭持久化存储（Docker stop / Ctrl-C）
const shutdown = () => { try { jobStore?.close(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
