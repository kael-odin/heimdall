/**
 * engine-server — Heimdall 引擎服务（W3）
 *
 *   POST /api/recon        {url, maxPages?}  → {taskId}（全站侦察）
 *   POST /api/forge        {url, hostPost?}  → {taskId, pageName}（单页还原流水线）
 *   POST /api/clone-site   {host, max?|allDiscovered?, incremental?, force?} → {taskId}（整站批量克隆）
 *   GET  /api/events?task=  SSE 事件流（重放已发生事件 + 实时）
 *   GET  /api/atlas/:task   recon 任务完成后返回 atlas.json
 *   GET  /api/jobs          任务清单（本进程内存态）
 *   POST /api/jobs/:id/cancel 取消任务
 *   GET  /api/status        健康检查
 *
 * 安全（默认仅本机）：
 *   HEIMDALL_HOST           监听地址，默认 127.0.0.1
 *   HEIMDALL_TOKEN          设置后 /api/*、/static/* 与镜像子域需鉴权
 *   HEIMDALL_CORS_ORIGIN    允许的控制台来源（逗号分隔）
 *   HEIMDALL_TRUSTED_HOSTS  反向代理公开域名（逗号分隔；默认仅本机域名）
 *   HEIMDALL_ALLOWED_HOSTS  代理白名单额外 host（逗号分隔）
 *   代理默认只允许 workspace 下已存在的 host，避免开放代理 / SSRF
 *
 * 用法: node src/engine-server.mjs [port=8900]
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, DATA_ROOT, DELIVERABLE, isInside, isSecretFile } from './paths.mjs';
import { assertSiteOrigin, siteIdForOrigin, readSiteOrigin, readSiteIdentity, findSiteIdentity } from './site-origin.mjs';
import { resolveMatrixTarget } from './seo/matrix-target.mjs';
import { assertPageName, isSafePageName } from './page-name.mjs';
import { listPurgedTrashBackups, listTrash, quarantinePage, quarantineSite, restoreTrash } from './audit/site-trash.mjs';
import { openJobStore, recoverInterrupted } from './jobs/store.mjs';
import { llmInfo, llmChat, llmChatWith, llmConfig } from './llm.mjs';
import { llmSettings, normalizePatch, writeEnvKeys } from './settings.mjs';
import { createWatchdog } from './task-watchdog.mjs';
import { writeProxyHead, mirrorHostOf } from './proxy-headers.mjs';
import { unmirroredBanner } from './live/live-html.mjs';
import { liveSnapshotCandidates } from './live/live-path.mjs';
import { rewriteSnapshotMount } from './live/site-routing.mjs';
import { sessionInfo, clearSession } from './session/store.mjs';
import { loadProfile, sanitizeHost, queuePlan, MAX_SLOT_CEILING } from './site-profile.mjs';
import { UA } from './ua.mjs';
import { canonUrl, resolvePageNameOfUrl } from './url-canon.mjs';
import { makeSlotBox } from './forge-slots.mjs';
import { cloneDocFile } from './clone-doc.mjs';
import { readCloneScope } from './clone-scope.mjs';
import { normalizeAcceptancePlan } from './acceptance/schema.mjs';
import { assertUnmanagedAcceptanceInput, ManagedAcceptanceRunError } from './acceptance/managed-run-schema.mjs';
import { createLegacyAcceptanceReadScope } from './acceptance/managed-access.mjs';
import { previewOpenApi } from './acceptance/openapi.mjs';
import { createAcceptanceRun, listAcceptanceRuns, readAcceptanceRun, readAcceptanceDisplayRun, updateAcceptanceRun, acceptanceArtifact, readAcceptanceArtifact, readAcceptanceTriage, saveAcceptanceTriage, readAcceptanceSnapshots } from './acceptance/store.mjs';
import { recoverOwnedAcceptanceRuns } from './acceptance/recovery.mjs';
import { acceptanceRunView } from './acceptance/run-view.mjs';
import { compareAcceptanceSnapshots, comparisonMarkdown } from './acceptance/comparison.mjs';
import { acquireAcceptanceOwner } from './acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from './acceptance/catalog.mjs';
import { handleAcceptanceCatalogRequest, acceptanceCatalogError } from './acceptance/catalog-api.mjs';
import { createAcceptanceExecutionRuntime } from './acceptance/execution-runtime.mjs';
import { createManagedSpecExecutionService } from './acceptance/execution-service.mjs';
import { handleAcceptanceExecutionRequest, acceptanceExecutionError } from './acceptance/execution-api.mjs';
import { createManagedSpecDispatchReadContext } from './acceptance/managed-dispatch-reader.mjs';
import { managedRunProvenanceOf } from './acceptance/managed-run-schema.mjs';

const CONSOLE_DIR = process.env.HEIMDALL_CONSOLE_DIR ?? '';
let acceptanceOwner;
try { acceptanceOwner = acquireAcceptanceOwner(); }
catch (error) {
  const failure = acceptanceCatalogError(error);
  console.error(`[acceptance] ${failure.payload.code}: ${failure.payload.error}`);
  process.exit(1);
}
// Registered immediately: failed startup and normal exit release only our nonce.
process.once('exit', () => acceptanceOwner.release());
const acceptanceCatalog = createAcceptanceCatalogStore({ root: acceptanceOwner.root, owner: acceptanceOwner });
let acceptanceCatalogOpened = false;
try {
  await acceptanceCatalog.initialize({ createSchemaVersion: 3 });
  acceptanceCatalogOpened = true;
}
catch (error) {
  const failure = acceptanceCatalogError(error);
  console.error(`[acceptance] ${failure.payload.code}: ${failure.payload.error}`);
}
// A second engine must never recover the live owner's running records.
acceptanceOwner.assertOwned();
let acceptanceRecovery;
try {
  // Maintenance is explicit. Do not settle run heads while their catalog
  // cannot be opened, including legacy formats that require operator migration.
  if (!acceptanceCatalogOpened) throw Object.assign(new Error('项目目录尚未打开，请先完成目录维护。'), { code: 'CATALOG_NOT_OPEN' });
  const counts = recoverOwnedAcceptanceRuns({ owner: acceptanceOwner });
  acceptanceRecovery = Object.freeze({ schemaVersion: 1, ready: true, status: 'ready', counts, code: null });
}
catch (error) {
  acceptanceRecovery = Object.freeze({ schemaVersion: 1, ready: false, status: 'blocked', counts: null, code: 'ACCEPTANCE_RECOVERY_BLOCKED' });
  console.warn(`[acceptance] recovery blocked: ${error.code}: ${error.message}`);
}
const execFileAsync = promisify(execFile);

// 任务持久化（node:sqlite；不可用时自动降级 JSON）——重启后历史/事件不丢
let jobStore = null;
try {
  jobStore = openJobStore(process.env.HEIMDALL_JOBS_DB ?? join(DATA_ROOT, 'jobs.db'));
} catch (e) { console.warn('[jobs] store unavailable:', String(e).slice(0, 120)); }

const PORT = Number(process.argv[2] ?? 8900);
const BIND = process.env.HEIMDALL_HOST ?? '127.0.0.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_TOKEN = process.env.HEIMDALL_TOKEN ?? '';
const AUTH_SESSIONS = new Map();
const AUTH_SESSION_SCOPES = new Map();
const AUTH_SESSION_TTL = 12 * 60 * 60 * 1000;
const SESSION_TICKETS = new Map();
const SESSION_TICKET_TTL = 60 * 1000;
const MIRROR_SESSION_PATH = '/.heimdall/session';
const ALLOWED_ORIGINS = (process.env.HEIMDALL_CORS_ORIGIN ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXTRA_PROXY_HOSTS = new Set((process.env.HEIMDALL_ALLOWED_HOSTS ?? '')
  .split(',').map(s => s.trim().replace(/^www\./, '')).filter(Boolean));
const TRUSTED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]',
  ...((BIND === '0.0.0.0' || BIND === '::') ? [] : [BIND.toLowerCase()]),
  ...(process.env.HEIMDALL_TRUSTED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)]);
const CORS = { 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,x-heimdall-token' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
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

function trustedRequestHost(raw) {
  if (typeof raw !== 'string' || /[\\/@?#]/.test(raw)) return false;
  try {
    const host = new URL('http://' + raw).hostname.toLowerCase();
    return TRUSTED_HOSTS.has(host) || !!mirrorHostOf(raw);
  } catch { return false; }
}

function activeDocumentHeaders(req, type, { source = 'workspace', file = '', compareView = false } = {}) {
  const mime = String(type ?? '').split(';', 1)[0].trim().toLowerCase();
  const headers = { 'X-Content-Type-Options': 'nosniff' };
  if (source === 'console' || source === 'mirror') return headers;

  if (mime === 'text/html') {
    const rel = source === 'workspace' ? relative(WORKSPACE, file).replaceAll('\\', '/').toLowerCase() : '';
    if (/^[^/]+\/pages\/[^/]+\/clone\//.test(rel)) {
      // The normal entry needs its viewport chooser script. Compare uses a
      // script-free, same-origin view so its parent can synchronize scrolling.
      headers['Content-Security-Policy'] = compareView
        ? "script-src 'none'; form-action 'none'; object-src 'none'"
        : 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox';
    } else if (source !== 'workspace' || !/^[^/]+\/compare\.html$/.test(rel)) {
      headers['Content-Security-Policy'] = source === 'proxy'
        ? 'sandbox'
        : 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';
    }
  } else if (mime === 'application/xhtml+xml' || mime === 'image/svg+xml'
      || mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) {
    headers['Content-Security-Policy'] = 'sandbox';
    if (frameDocNavigation(req)) headers['Content-Disposition'] = 'attachment';
  }
  return headers;
}

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
 * 读 JSON 请求体 → cb(obj)。
 *
 * 这些启动路由原先**各自**写一遍 `let body=''; req.on('data', c => body += c)` ——
 * 13 份，而且都没有上限。上面那道全局 Content-Length 检查挡不住它们：
 * 分块传输的请求压根没有这个头，于是这条路上的内存是无界的。
 * 顺带把 13 份 `try { JSON.parse(body || '{}') } catch {}` 收成一处。
 * 解析失败照旧给 `{}` —— 字段缺省由各路由自己兜（这是原来的行为，不改）。
 */
const readJsonBody = (req, res, cb, limit = 64 * 1024) => {
  const chunks = [];
  let n = 0, done = false;
  req.on('data', (c) => {
    if (done) return;
    n += c.length;
    if (n > limit) { done = true; json(res, 413, { error: 'body too large', limit }); try { req.destroy(); } catch {} return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    let parsed = {};
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    cb(parsed);
  });
  req.on('error', () => { done = true; });
};

/**
 * 流式下发文件：Content-Length + Range 支持 + 正确 MIME。
 * 此前四处用 readFileSync 全量入内存 —— 面对几百 MB 的镜像包/合并 HAR 会顶爆堆，
 * 且不支持 Range（视频无法拖动/续传）。这里统一替换为流式。
 */
function sendFile(req, res, file, extraHeaders = {}, source = 'workspace') {
  const workspaceRel = source === 'workspace' ? relative(WORKSPACE, file).replaceAll('\\', '/').toLowerCase() : '';
  const compareView = source === 'workspace' && new URL(req.url, 'http://x').searchParams.get('compare') === '1'
    && /^[^/]+\/pages\/[^/]+\/clone\/[^/]+\.html?$/.test(workspaceRel);
  if (compareView && workspaceRel.endsWith('/clone/index.html')) {
    file = cloneDocFile(dirname(file));
  }
  let st;
  try { st = statSync(file); } catch { return json(res, 404, { error: 'nf' }); }
  if (!st.isFile()) return json(res, 404, { error: 'nf' });
  const headers = {
    ...CORS,
    'Content-Type': mimeOf(file),
    ...activeDocumentHeaders(req, mimeOf(file), { source, file, compareView }),
    'Content-Length': String(st.size),
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    ...extraHeaders,
  };
  if (source === 'workspace' && /^[^/]+\/compare\.html$/.test(workspaceRel)) {
    const nonce = randomBytes(16).toString('base64');
    const original = readFileSync(file, 'utf8');
    const html = original
      .replace('<script>\nconst PAGES = ', `<script nonce="${nonce}">\nconst PAGES = `)
      .replace("frame.src = 'pages/' + name + '/clone/index.html';",
        "frame.src = 'pages/' + name + '/clone/index.html?compare=1';");
    headers['Content-Security-Policy'] = `script-src 'nonce-${nonce}'; form-action 'none'; object-src 'none'`;
    headers['Content-Length'] = String(Buffer.byteLength(html));
    res.writeHead(200, headers);
    return req.method === 'HEAD' ? res.end() : res.end(html);
  }
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
 * 独立域名镜像站：<host>.localhost:<port>/<path>。
 * pathname 与原站一致，站点脚本、cookie 和 localStorage 均与引擎主域隔离。
 *
 * 融合路由：本地 live/<path>/index.html 存在 → 回校准快照；否则全代理回原站
 * （未锻造页 / 资源 / JS chunk / API 全部原样透传，页面"活"）。
 */
async function serveMirror(req, res, u, identity) {
  try {
    const { siteId: lmHost, origin } = identity;
    const rest = u.pathname;
    const liveRoot = join(WORKSPACE, lmHost, 'live');
    const staticPrefix = `/static/${lmHost}/`;
    if (rest.startsWith(staticPrefix)) {
      const siteRoot = join(WORKSPACE, lmHost);
      const file = join(siteRoot, decodeURIComponent(rest.slice(staticPrefix.length)));
      if (!isInside(siteRoot, file) || isSecretFile(file)) return json(res, 403, { error: 'forbidden' });
      return sendFile(req, res, file, {}, 'mirror');
    }

    // 本地优先：无扩展名路径 → 该目录下的 index.html；有扩展名 → 精确路径。
    // 候选只放"文件"，目录本身绝不入候选（防 EISDIR）。
    const candidates = liveSnapshotCandidates(rest, u.search).map(rel => join(liveRoot, rel));
    const localFile = candidates.find(f => isInside(liveRoot, f) && existsSync(f) && !isSecretFile(f));
    // 只对 GET/HEAD 回本地快照：快照是静态文件，吞掉 POST 会让页面的表单直接失效
    // （实测 apify.com 的 contact-sales 表单就是 POST 到当前路径）。
    if (localFile && (req.method === 'GET' || req.method === 'HEAD')) {
      // 快照里烘焙的 /lm/<host>/ 前缀在独立域名下不存在。
      if (/\.html?$/i.test(localFile)) {
        const html = rewriteSnapshotMount(readFileSync(localFile, 'utf8'), { siteId: lmHost, origin });
        res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
        return req.method === 'HEAD' ? res.end() : res.end(html);
      }
      return sendFile(req, res, localFile, { 'Cache-Control': 'no-cache' }, 'mirror');
    }

    // 反代回原站（全方法透传；cookie 透传并剥 Domain/Secure，登录态落到我们域名下）
    const targetUrl = origin + rest + u.search;
    const fwdHeaders = {};
    for (const k of ['accept', 'accept-language', 'content-type']) {
      if (req.headers[k]) fwdHeaders[k] = req.headers[k];
    }
    const siteCookies = String(req.headers.cookie ?? '').split(';').map(part => part.trim())
      .filter(part => part && !part.startsWith('heimdall_session='));
    if (siteCookies.length) fwdHeaders.cookie = siteCookies.join('; ');
    fwdHeaders['user-agent'] = UA;
    fwdHeaders.referer = origin + '/';
    if (req.headers.origin) fwdHeaders.origin = origin;
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      ...(['GET', 'HEAD'].includes(req.method) ? {} : { duplex: 'half' }),
      redirect: 'manual',
    });
    const headers = new Headers();
    for (const [k, v] of upstream.headers) {
      const kl = k.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'set-cookie'].includes(kl)) continue;
      // 跳转目标要落回"我们这边的同一个站点"，不能把浏览器直接甩去原站
      if (kl === 'location') {
        const destination = new URL(v, targetUrl);
        headers.set(k, destination.origin === origin ? destination.pathname + destination.search + destination.hash : v);
        continue;
      }
      headers.set(k, v);
    }
    for (const c of upstream.headers.getSetCookie?.() ?? []) {
      headers.append('set-cookie', c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*secure/gi, ''));
    }
    const authCookie = res.getHeader('Set-Cookie');
    if (authCookie) headers.append('set-cookie', String(authCookie));
    writeProxyHead(res, upstream.status, headers);
    const body = Buffer.from(await upstream.arrayBuffer());
    // 顶层文档导航 + 上游就是 HTML → 这是"用户在浏览一个没镜像的页"。
    // 只在这条路径补提示条：资源请求、RSC/fetch 载荷（sec-fetch-dest: empty）都不插，
    // 否则会把框架的数据流弄脏。理由见 live-html.mjs 的 unmirroredBanner。
    if (frameDocNavigation(req) && /text\/html/i.test(upstream.headers.get('content-type') ?? '')) {
      return res.end(unmirroredBanner(body.toString('utf8'), lmHost, { to: '/' }));
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
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}
/** token 可走 header；SSE/EventSource 不支持自定义 header，允许 ?token= 兜底 */
function authorized(req, u, res, scope = '') {
  if (!AUTH_TOKEN) return true;
  const cookie = String(req.headers.cookie ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith('heimdall_session='))?.slice('heimdall_session='.length);
  if (req.headers['x-heimdall-token'] === AUTH_TOKEN || u?.searchParams?.get('token') === AUTH_TOKEN) {
    issueAuthSession(res, cookie, scope);
    return true;
  }
  const expires = AUTH_SESSIONS.get(cookie);
  if (expires && expires > Date.now()) return AUTH_SESSION_SCOPES.get(cookie) === scope;
  if (cookie) { AUTH_SESSIONS.delete(cookie); AUTH_SESSION_SCOPES.delete(cookie); }
  return false;
}
function issueAuthSession(res, existing, scope = '') {
  const now = Date.now();
  for (const [id, expires] of AUTH_SESSIONS) if (expires <= now) { AUTH_SESSIONS.delete(id); AUTH_SESSION_SCOPES.delete(id); }
  const session = existing && AUTH_SESSIONS.has(existing) && AUTH_SESSION_SCOPES.get(existing) === scope ? existing : randomUUID();
  if (!AUTH_SESSIONS.has(session) && AUTH_SESSIONS.size >= 1024) {
    const oldest = AUTH_SESSIONS.keys().next().value;
    AUTH_SESSIONS.delete(oldest); AUTH_SESSION_SCOPES.delete(oldest);
  }
  AUTH_SESSIONS.set(session, now + AUTH_SESSION_TTL);
  AUTH_SESSION_SCOPES.set(session, scope);
  // CSP-sandboxed workspace HTML has an opaque origin. Its relative assets are
  // cross-site requests, so Lax would authenticate the document but 401 its images/CSS.
  res.setHeader('Set-Cookie', `heimdall_session=${session}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=43200`);
}

const MIRROR_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function storeSessionTicket(payload) {
  const now = Date.now();
  for (const [id, ticket] of SESSION_TICKETS) if (ticket.expires <= now) SESSION_TICKETS.delete(id);
  if (SESSION_TICKETS.size >= 1024) SESSION_TICKETS.delete(SESSION_TICKETS.keys().next().value);
  const id = randomUUID();
  SESSION_TICKETS.set(id, { ...payload, expires: now + SESSION_TICKET_TTL });
  return id;
}
function issueMirrorTicket(rawUrl, mode) {
  if (mode !== 'root') return { status: 400, error: 'invalid mirror mode' };
  let target;
  try { target = new URL(rawUrl ?? ''); }
  catch { return { status: 400, error: 'invalid mirror URL' }; }
  const host = target.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password
      || !MIRROR_HOST_RE.test(host)) return { status: 400, error: 'invalid mirror URL' };
  let identity;
  try { identity = findSiteIdentity(WORKSPACE, target); } catch {}
  if (!identity && EXTRA_PROXY_HOSTS.has(host) && target.origin === `https://${host}`) identity = { siteId: host, origin: target.origin };
  if (!identity) return { status: 403, error: 'origin not allowed' };
  const path = target.pathname + target.search;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return { status: 400, error: 'invalid mirror path' };
  }
  const id = storeSessionTicket({ host: identity.siteId, origin: identity.origin, path, mode });
  const destination = new URL(`http://${identity.siteId}.localhost:${PORT}${MIRROR_SESSION_PATH}`);
  destination.searchParams.set('ticket', id);
  return { url: destination.href, siteId: identity.siteId, origin: identity.origin };
}
function issueArtifactTicket(rawPath, engineHost) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/static/')
      || rawPath.startsWith('//') || rawPath.includes('\\') || rawPath.includes('#')) {
    return { status: 400, error: 'invalid artifact path' };
  }
  let destination;
  try { destination = new URL(rawPath, 'http://heimdall.invalid'); }
  catch { return { status: 400, error: 'invalid artifact path' }; }
  if (destination.origin !== 'http://heimdall.invalid'
      || !/^\/static\/[a-z0-9.-]+\//i.test(destination.pathname)) {
    return { status: 400, error: 'invalid artifact path' };
  }
  const id = storeSessionTicket({ mode: 'artifact', engineHost: String(engineHost ?? '').toLowerCase(),
    path: destination.pathname + destination.search });
  return { url: `${MIRROR_SESSION_PATH}?ticket=${encodeURIComponent(id)}` };
}
function mirrorLaunch(req, res, u) {
  if (!authorized(req, null, res)) return json(res, 401, { error: 'unauthorized' });
  const issued = issueMirrorTicket(u.searchParams.get('url'), 'root');
  if (issued.error) return json(res, issued.status, { error: issued.error });
  const destination = issued.url;
  res.writeHead(302, { Location: destination, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}
function exchangeMirrorTicket(req, res, u, host) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const id = u.searchParams.get('ticket');
  const ticket = id && SESSION_TICKETS.get(id);
  if (id) SESSION_TICKETS.delete(id);
  if (!ticket || ticket.expires <= Date.now()
      || (host ? ticket.mode !== 'root' || ticket.host !== host || mirrorIdentity(host)?.origin !== ticket.origin
        : ticket.mode !== 'artifact'
          || ticket.engineHost !== String(req.headers.host ?? '').toLowerCase())) {
    return json(res, 401, { error: 'invalid mirror ticket' });
  }
  issueAuthSession(res, undefined, host ? `${host}|${ticket.origin}` : '');
  res.writeHead(302, { Location: ticket.path,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}
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

function mirrorIdentity(siteId) {
  try {
    return readSiteIdentity(WORKSPACE, siteId)
      ?? (EXTRA_PROXY_HOSTS.has(siteId) ? { siteId, origin: `https://${siteId}` } : null);
  } catch { return null; }
}
const pageFor = (u) => resolvePageNameOfUrl(u, join(WORKSPACE, siteIdForOrigin(WORKSPACE, u)));
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
let runningAcceptance = null;
let runningAcceptanceTriage = null;
const acceptanceRuntime = createAcceptanceExecutionRuntime();
let shuttingDown = false;

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
// 槽位计数收进一个会"大声失败"的小对象：归还一个没占过的槽会被拒绝并留痕。
// 此前这里是一串 if/else + 兜底的 else forgeSlots--，于是**没占过槽的任务类型**
// （cas-gc / editmanifest / replace-domain）退出时也会减一 —— 计数变负，
// 而 `used >= max` 这道闸门从此永不触发，并发上限静默失效。
// 症状只是控制台上那句「克隆槽 -1/2」。
const forgeSlots = makeSlotBox(MAX_FORGE);

/**
 * 把一条事件推给这个任务的所有订阅者。
 *
 * **逐个 try** —— 这里原来是三处裸循环 `for (const res of t.subs) res.write(...)`：
 * 只要有一个订阅者的套接字已经断了，就会当场抛出去。抛在子进程的 'exit' 回调里
 * 是未捕获异常（可能带走整个引擎进程），抛在被 catch {} 包着的 stdout 回调里
 * 则是"这条事件剩下的订阅者被静默跳过"。一个关掉的标签页不该有这两种后果。
 * 写失败的订阅者直接从集合里摘掉（它自己也会在 req 'close' 时被删，这里只是不等那一刻）。
 */
const writeSubs = (t, payload) => {
  for (const res of t.subs) {
    try { res.write(payload); } catch { t.subs.delete(res); }
  }
};

const push = (t, ev) => {
  if (t.kind === 'recon' && ev?.kind === 'calibrated' && ev.host && ev.origin) {
    t.host = ev.host;
    t.siteId = ev.host;
    t.origin = ev.origin;
    t.atlasPath = join(WORKSPACE, ev.host, 'recon', 'atlas.json');
  }
  t.events.push(ev);
  if (typeof ev?.kind === 'string' && ev.kind.endsWith('-error')) t.error = ev.error ?? 'error';
  try { jobStore?.appendEvent(t.id, ev); } catch { t.mirrorDegraded = true; }
  writeSubs(t, `data: ${JSON.stringify(ev)}\n\n`);
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
  writeSubs(t, `data: ${JSON.stringify(ev)}\n\n`);
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
  if (t.acceptanceLease) {
    try { acceptanceRuntime.stop(t.acceptanceLease, reason === 'stalled' ? 'WATCHDOG_STALLED' : 'WATCHDOG_TIMEOUT'); } catch {}
  }
  killTree(t.child);
}

function makeTask(kind, url) {
  const id = `${kind[0]}-${randomUUID()}`;
  const t = { id, kind, url, status: 'running', events: [], logs: [], subs: new Set(), child: null, atlasPath: null, createdAt: Date.now(), cancelRequested: false, killed: null, timeoutMs: 0, stallMs: 0 };
  tasks.set(id, t);
  try { jobStore?.upsert({ id, kind, url, status: 'running', createdAt: t.createdAt }); }
  catch { t.mirrorDegraded = true; }
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
    // 收尾：先记一条"任务结束"再挂断所有订阅者。push 内部已逐订阅者 try（见 writeSubs）。
    // 这里的 res.end() 同样逐个 try —— 它在子进程 'exit' 回调里，抛出去就是未捕获异常。
    push(t, { kind: 'exit', code, status: t.status, killed: t.killed ?? undefined });
    // 任务刚落盘新产物，缓存的清单即刻变陈旧 —— 这一刻必须失效，不能等 TTL。
    // "刚克隆完打开资产页还是旧的"会是比卡顿难查得多的 bug。
    bustCaches();
    for (const res of t.subs) { try { res.end(); } catch { /* 订阅者已断开 */ } }
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
    else if (t.kind === 'session') runningSession = null;    // 登录会话不占锻造槽
    else if (t.kind === 'storage') {
      storageScanTask = null;                                // 盘点任务不占锻造槽
      if (storageScanDirty) {
        storageScanDirty = false;
        setImmediate(() => startStorageScan());              // 盘点过程中有变更，再扫描最终状态
      }
    }
    else if (t.kind === 'deliver') {
      deliverTask = null;
      if (t.apply) {
        deliverExpectedRunId = randomUUID();
        startStorageScan({ afterMutation: true });
      }
    }
    // 槽位归还跟着"谁占过"走（t.tookForgeSlot 在 startForge 里置位），
    // 不再用兜底分支去猜 —— 兜底正是当初把计数减成负数的原因
    if (t.tookForgeSlot && !forgeSlots.release()) {
      console.warn('[slots] 归还了一个没占过的锻造槽（记账漏了一笔），已忽略');
    }
    try { jobStore?.upsert({ id: t.id, kind: t.kind, url: t.url, status: t.status, pageName: t.pageName ?? null, createdAt: t.createdAt, endedAt: t.endedAt ?? null, error: t.error ?? null }); }
    catch { t.mirrorDegraded = true; }
    // 保留策略。放在这里而不是只放启动时：演示/长跑时引擎可能连着开好几天不重启，
    // 只靠启动那一次裁剪就等于不裁。一次 SELECT 的开销，超限才会删。
    try { jobStore?.prune(); } catch (e) { console.warn('[jobs] prune failed:', String(e).slice(0, 120)); }
  });
  return t;
}

// Jobs and SSE are projections. Only the owned writer may decide a managed
// run's terminal fact; a broken projection must not trigger a second finish.
function managedTaskMirror({ lease, record }) {
  const p = managedRunProvenanceOf(record);
  const binding = { schemaVersion: 1, operationId: p.operationId, runId: p.runId,
    taskId: p.taskId, dispatchSha256: p.dispatchSha256, projectId: p.projectId };
  let t;
  const attempt = action => { try { action(); } catch { if (t) t.mirrorDegraded = true; } };
  const persist = () => attempt(() => jobStore?.upsert({ id: t.id, kind: t.kind, url: t.url,
    status: t.status, createdAt: t.createdAt, endedAt: t.endedAt ?? null,
    payload: { managedAcceptance: binding }, error: t.error ?? null }));
  const event = ev => {
    t.events.push(ev);
    if (t.events.length > 1000) t.events.splice(0, t.events.length - 1000);
    attempt(() => jobStore?.appendEvent(t.id, ev));
    attempt(() => writeSubs(t, `data: ${JSON.stringify(ev)}\n\n`));
  };
  return {
    preflight({ taskId }) {
      // A failed lookup is never interpreted as absence.
      if (tasks.has(taskId) || jobStore?.get(taskId)) {
        throw Object.assign(new Error('reserved task already exists'), { code: 'MANAGED_RUN_CONFLICT', status: 409 });
      }
    },
    register(manifest) {
      t = { id: p.taskId, kind: 'acceptance', runId: p.runId, url: p.target.targetUrl,
        label: manifest.name, status: 'running', createdAt: Date.parse(manifest.createdAt),
        events: [], logs: [], subs: new Set(), child: null, cancelRequested: false,
        managedAcceptance: true, acceptanceLease: lease, mirrorDegraded: false };
      t.requestStop = reason => { acceptanceRuntime.stop(lease, reason); };
      tasks.set(t.id, t); runningAcceptance = t;
      persist();
    },
    event,
    terminal(result) {
      if (!t || t.status !== 'running') return;
      t.status = result.status; t.endedAt = Date.now();
      t.error = result.code ?? (result.runStatus === 'completed' ? null : result.reasonCode);
      if (result.runStatus === 'completed') event({ kind: 'acceptance-complete', runId: t.runId,
        gate: result.gate, summary: result.summary });
      event({ kind: 'exit', status: t.status, code: result.code ?? null });
      persist();
      for (const res of t.subs) attempt(() => res.end());
      t.subs.clear();
      if (runningAcceptance?.id === t.id) runningAcceptance = null;
      bustCaches(); attempt(() => jobStore?.prune());
      if (tasks.size > MAX_TASKS) {
        const finished = [...tasks.values()].filter(item => item.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
        for (const old of finished.slice(0, tasks.size - MAX_TASKS)) tasks.delete(old.id);
      }
    },
  };
}
const acceptanceExecutions = createManagedSpecExecutionService({ owner: acceptanceOwner,
  catalog: acceptanceCatalog, runtime: acceptanceRuntime, mirrorFactory: managedTaskMirror,
  assertReady() {
    acceptanceOwner.assertOwned();
    if (!acceptanceRecovery.ready || shuttingDown) throw Object.assign(new Error('acceptance admission unavailable'),
      { code: 'MANAGED_EXECUTION_UNAVAILABLE', status: 503 });
    return true;
  } });

// Recover the disposable job projection from verified run facts, never in the
// other direction. In particular, completed BUG reports still mean task done.
if (jobStore) {
  try {
    const jobs = jobStore.list({ limit: 500 });
    const managed = job => job.payload && Object.hasOwn(job.payload, 'managedAcceptance');
    for (const job of jobs.filter(managed)) {
      try {
        if (!acceptanceRecovery.ready) throw new Error('recovery blocked');
        acceptanceOwner.assertOwned();
        const b = job.payload.managedAcceptance;
        const managedRead = createManagedSpecDispatchReadContext({ root: acceptanceOwner.root });
        const record = managedRead.reread(b.operationId, b.dispatchSha256), p = managedRunProvenanceOf(record);
        const expected = { schemaVersion: 1, operationId: p.operationId, runId: p.runId,
          taskId: p.taskId, dispatchSha256: p.dispatchSha256, projectId: p.projectId };
        if (!b || Object.keys(b).length !== Object.keys(expected).length
            || Object.entries(expected).some(([key, value]) => b[key] !== value)
            || job.id !== p.taskId || job.kind !== 'acceptance' || job.url !== p.target.targetUrl) throw new Error('binding mismatch');
        const head = readAcceptanceRun(p.runId, { root: acceptanceOwner.root, managedRead });
        if (!head || Date.parse(head.createdAt) !== job.createdAt || head.status === 'running') throw new Error('unsettled run');
        if (head.status === 'completed') {
          const [snapshot] = readAcceptanceSnapshots([p.runId], { root: acceptanceOwner.root, managedRead });
          if (!snapshot?.integrity?.valid || !snapshot.integrity.evidenceVerified) throw new Error('completed snapshot unavailable');
        }
        managedRead.assertCurrent(); acceptanceOwner.assertOwned();
        const status = head.status === 'completed' ? 'done'
          : head.reasonCode === 'CANCELLED' ? 'cancelled' : head.status;
        jobStore.upsert({ ...job, status, endedAt: Date.parse(head.endedAt ?? head.updatedAt),
          error: head.status === 'completed' ? null : head.reasonCode ?? 'MANAGED_EXECUTION_INTERRUPTED' });
      } catch {
        // Unknown is a projection failure, not permission to resume or rewrite.
        try { jobStore.upsert({ ...job, status: 'failed', endedAt: job.endedAt ?? Date.now(), error: 'MANAGED_MIRROR_UNAVAILABLE' }); } catch {}
      }
    }
    const n = recoverInterrupted({ list: () => jobs.filter(job => !managed(job)), upsert: job => jobStore.upsert(job) });
    if (n) console.log(`[jobs] recovered ${n} interrupted task(s)`);
    jobStore.prune();
  } catch { console.warn('[jobs] startup projection reconciliation unavailable'); }
}

function startRecon(url, maxPages) {
  const siteId = siteIdForOrigin(WORKSPACE, url);
  const t = makeTask('recon', url);
  t.host = siteId;
  t.siteId = siteId;
  t.origin = new URL(url).origin;
  t.atlasPath = join(WORKSPACE, siteId, 'recon', 'atlas.json');
  runningRecon = t;
  return spawnTask(t, join('src', 'crawler', 'recon.mjs'), [url, String(maxPages), '2']).id;
}

function startAudit(url, maxPages = 30) {
  const t = makeTask('audit', url);
  t.host = siteIdForOrigin(WORKSPACE, url);
  runningAudit = t;
  return spawnTask(t, join('src', 'seo', 'audit.mjs'), [url, '--max', String(maxPages)]).id;
}

function startWatch(url, maxPages = 20, accept = false) {
  const t = makeTask('watch', url);
  t.host = siteIdForOrigin(WORKSPACE, url);
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
  t.host = resolveMatrixTarget(sites[0]).siteId;
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

function startVerify(host, { page, maxPages = null } = {}) {
  const t = makeTask('verify', 'https://' + host);
  t.host = host;
  t.label = page ? '多视口体检 ' + page : '全站体检';
  runningVerify = t;
  const args = page ? [host, page, '--no-interactions'] : [host, '--all'];
  if (!page && maxPages !== null) args.push('--max', String(maxPages));
  return spawnTask(t, join('src', 'verify', 'verify.mjs'), args).id;
}

function startLiveExport(host, { root = 'mirror', rebuild = false } = {}) {
  const t = makeTask('live', 'https://' + host);
  t.host = host;
  t.label = '交互镜像导出 ' + host;
  runningLive = t;
  const args = [host, '--offline', '--strict', '--root', root === 'landing' ? 'landing' : 'mirror', '--heal', '--materialize-har'];
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
const TRASH_WARN_BYTES = Number.isSafeInteger(Number(process.env.HEIMDALL_TRASH_WARN_BYTES))
  && Number(process.env.HEIMDALL_TRASH_WARN_BYTES) > 0
  ? Number(process.env.HEIMDALL_TRASH_WARN_BYTES) : 1024 ** 3;
let storageScanTask = null;
let storageScanDirty = false;
let storageMutationAt = 0;

function readStorageFile() {
  try {
    const s = JSON.parse(readFileSync(STORAGE_JSON, 'utf8'));
    const generatedAt = Date.parse(s.generatedAt ?? 0);
    return { ...s, stale: Date.now() - generatedAt > STORAGE_TTL_MS || generatedAt <= storageMutationAt };
  } catch { return null; }
}

/** 后台盘点（不阻塞事件循环）；已在跑则复用同一个任务 */
function startStorageScan({ afterMutation = false } = {}) {
  if (afterMutation) storageMutationAt = Math.max(Date.now(), storageMutationAt + 1);
  if (storageScanTask && storageScanTask.status === 'running') {
    if (afterMutation) storageScanDirty = true;
    return storageScanTask.id;
  }
  const t = makeTask('storage', 'local://storage');
  t.label = '磁盘盘点';
  storageScanTask = t;
  return spawnTask(t, join('src', 'audit', 'storage.mjs'), []).id;
}

async function runTrashCommand(args) {
  try {
    const longRunning = ['preview', 'backup', 'purge-record', 'recover-backup'].includes(args[0]);
    const { stdout } = await execFileAsync(process.execPath,
      [join(HERE, 'audit', 'site-trash.mjs'), ...args],
      { cwd: join(HERE, '..'), env: process.env,
        timeout: longRunning ? 30 * 60_000 : 120_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(String(error?.stderr || error?.message || error).trim().slice(0, 200));
  }
}

/**
 * 交付包清理。**同样走子进程**：deliverable/ 实测有 8 个包 / 1.88GB / 上万个文件，
 * 扫描要读取文件内容计算指纹，隔离要移动目录 —— 与磁盘盘点同一量级，
 * 放在请求处理里会冻住事件循环（见上面 startStorageScan 的注释）。
 */
const DELIVER_PLAN_JSON = join(DATA_ROOT, 'deliver-plan.json');
let deliverTask = null;
let deliverExpectedRunId = null;
let deliverRestoreRunning = false;

function readDeliverPlan() {
  try {
    const plan = JSON.parse(readFileSync(DELIVER_PLAN_JSON, 'utf8'));
    return !deliverExpectedRunId || plan.runId === deliverExpectedRunId ? plan : null;
  } catch { return null; }
}

function startDeliverPrune(apply, revision = null) {
  if (deliverTask && deliverTask.status === 'running') return deliverTask.id;
  const t = makeTask('deliver', 'local://deliver');
  t.apply = apply;
  t.revision = revision;
  t.label = apply ? '交付包隔离' : '交付包盘点';
  deliverTask = t;
  deliverExpectedRunId = t.id;
  return spawnTask(t, join('src', 'audit', 'deliver-prune.mjs'),
    [...(apply ? ['--apply', '--revision', revision] : []), '--run-id', t.id]).id;
}

async function runDeliverCommand(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath,
      [join(HERE, 'audit', 'deliver-prune.mjs'), ...args, '--json'],
      { cwd: join(HERE, '..'), env: process.env, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(String(error?.stderr || error?.message || error).trim().slice(0, 250));
  }
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

function startForge(url, { hostPost = true } = {}) {
  const u = new URL(url);
  const siteId = siteIdForOrigin(WORKSPACE, url);
  const siteDir = join(WORKSPACE, siteId);
  const name = assertPageName(resolvePageNameOfUrl(u, siteDir));
  assertSiteOrigin(siteDir, url, { pageName: name });
  // 占槽的动作和"这个任务占着槽"的标记放在一起 —— 分开放就会有人漏掉一处
  if (!forgeSlots.acquire()) { const e = new Error('busy'); e.code = 'busy'; throw e; }
  let t;
  try {
    t = makeTask('forge', url);
  } catch (e) { forgeSlots.release(); throw e; }
  t.tookForgeSlot = true;
  t.pageName = name;
  t.host = siteId;
  t.siteId = siteId;
  t.origin = u.origin;
  const env = hostPost ? {} : { HEIMDALL_SKIP_HOST_POST: '1' };
  // 单页熔断参数来自站点配方（大站可以给更长的上限，挂死页统一在 8 分钟内判死）
  const plan = queuePlan(loadProfile(u.hostname.replace(/^www\./, '')));
  return { id: spawnTask(t, join('src', 'pipeline.mjs'), [url, name], { env, timeoutMs: plan.pageTimeoutMs, stallMs: plan.stallMs }).id, name };
}

/**
 * 整站批量克隆 —— 由引擎跑 queue.mjs，而不是让浏览器标签页来驱动。
 * 好处：关掉控制台页面任务照跑、并发与超时按配方走、只占一个"编排"名额不占锻造槽。
 */
function startCloneSite(host, { max = null, allDiscovered = false, incremental = false, force = false } = {}) {
  const origin = readSiteOrigin(join(WORKSPACE, host)) ?? 'https://' + host;
  const t = makeTask('clone', origin);
  t.host = host;
  t.label = '整站克隆 ' + host;
  runningClone = t;
  const profile = loadProfile(new URL(origin).hostname.replace(/^www\./, ''));
  const plan = queuePlan(profile, MAX_FORGE);
  t.plan = { workers: plan.workers, maxPages: allDiscovered ? null : max ?? plan.maxPages, allDiscovered, incremental, force };
  const args = [host, ...(allDiscovered ? ['--all-discovered'] : ['--max', String(max ?? plan.maxPages)]), '--json-events'];
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
  if (!trustedRequestHost(req.headers.host)) return json(res, 421, { error: 'untrusted host' });
  const u = new URL(req.url, 'http://x');
  // 镜像子域的 /api/* 与 /static/* 属于原站，先按 Host 分流。
  const mirrorHost = mirrorHostOf(req.headers.host);
  if (mirrorHost) {
    if (u.pathname === MIRROR_SESSION_PATH) return exchangeMirrorTicket(req, res, u, mirrorHost);
    // Mirror hosts cannot receive the main host's cookie. They require their own
    // session or an explicit token header; a token in the URL would reach upstream.
    const identity = mirrorIdentity(mirrorHost);
    if (!authorized(req, null, res, `${mirrorHost}|${identity?.origin}`)) return json(res, 401, { error: 'unauthorized' });
    if (!identity) return json(res, 403, { error: 'host not allowed', host: mirrorHost });
    return serveMirror(req, res, u, identity);
  }
  if (req.method === 'DELETE' && u.pathname.startsWith('/api/sites/')) {
    let segments;
    try { segments = String(req.url).split(/[?#]/, 1)[0].split('/').map(decodeURIComponent); }
    catch { return json(res, 400, { error: 'bad delete path' }); }
    if (segments.some(segment => segment === '.' || segment === '..' || /[\\/]/.test(segment))) {
      return json(res, 400, { error: 'bad delete path' });
    }
  }
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // Sandboxed workspace documents have an opaque Origin. Reject their simple
  // form/fetch writes even when the browser sends the engine session cookie.
  if (u.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)
      && req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)
      && req.headers.origin !== `http://${req.headers.host}`
      && req.headers.origin !== `https://${req.headers.host}`) {
    return json(res, 403, { error: 'origin not allowed' });
  }

  // 请求体上限。两道：
  //   ① 这里用 Content-Length 提前拦掉"声明了一个巨大 body"的请求（尤其是 /api/reveal、
  //      登录这类不解析 body 的路由，它们根本不会走 readJsonBody）；
  //   ② 真正读 body 的 13 个启动路由统一走 readJsonBody()，它自带 64KB 上限 ——
  //      这一道才挡得住分块传输（没有长度头的请求，① 看不见）。
  // 原先只有 ①，而注释末尾那句"真要堵就得所有处理器共用一个 readBody"是当时的自我提醒；
  // 现在已经共用了（见 readJsonBody）。
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) return json(res, 413, { error: 'body too large', limit: MAX_BODY_BYTES });
  }

  if (req.method === 'POST' && u.pathname === '/api/auth/logout') {
    const cookie = String(req.headers.cookie ?? '').split(';').map(part => part.trim())
      .find(part => part.startsWith('heimdall_session='))?.slice('heimdall_session='.length);
    if (cookie) { AUTH_SESSIONS.delete(cookie); AUTH_SESSION_SCOPES.delete(cookie); }
    res.setHeader('Set-Cookie', 'heimdall_session=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (u.pathname === MIRROR_SESSION_PATH) return exchangeMirrorTicket(req, res, u, null);
  if (req.method === 'GET' && u.pathname === '/api/mirror-launch') return mirrorLaunch(req, res, u);
  if (req.method === 'POST' && u.pathname === '/api/mirror-ticket') {
    if (!AUTH_TOKEN || !authorized(req, null, res)) return json(res, 401, { error: 'unauthorized' });
    return readJsonBody(req, res, (body) => {
      const issued = issueMirrorTicket(body.url, body.mode ?? 'root');
      return issued.error ? json(res, issued.status, { error: issued.error }) : json(res, 200, issued);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/artifact-ticket') {
    if (!AUTH_TOKEN || req.headers['x-heimdall-token'] !== AUTH_TOKEN) return json(res, 401, { error: 'unauthorized' });
    return readJsonBody(req, res, (body) => {
      const issued = issueArtifactTicket(body.path, req.headers.host);
      return issued.error ? json(res, issued.status, { error: issued.error }) : json(res, 200, issued);
    });
  }

  if (u.pathname.startsWith('/api/acceptance/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if (!authorized(req, (u.pathname === '/lm' || u.pathname.startsWith('/lm/')) ? null : u, res)
      && (u.pathname.startsWith('/api/') || u.pathname.startsWith('/px/')
        || u.pathname.startsWith('/static/') || u.pathname === '/lm' || u.pathname.startsWith('/lm/'))) {
    return json(res, 401, { error: 'unauthorized' });
  }

  // Independent project acceptance: persistent runs, protected evidence, bounded worker.
  if (u.pathname.startsWith('/api/acceptance/')) {
    try { acceptanceOwner.assertOwned(); }
    catch (error) {
      const failure = acceptanceCatalogError(error);
      return json(res, failure.status, failure.payload);
    }
    if (u.pathname === '/api/acceptance/recovery') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return json(res, 200, acceptanceRecovery);
    }
    if (!acceptanceRecovery.ready && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return json(res, 503, { code: 'ACCEPTANCE_RECOVERY_BLOCKED', error: '启动恢复未完成，验收写入暂不可用；请检查运行现场后重启引擎。' });
    }
  }
  if (await handleAcceptanceExecutionRequest(req, res, u, { service: acceptanceExecutions, json })) return;
  if (await handleAcceptanceCatalogRequest(req, res, u, { catalog: acceptanceCatalog, json })) return;
  if (u.pathname === '/api/acceptance/comparisons') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if ([...u.searchParams.keys()].some(key => !['before', 'after', 'format'].includes(key))
      || ['before', 'after', 'format'].some(key => u.searchParams.getAll(key).length > 1)) {
      return json(res, 400, { code: 'INVALID_INPUT', error: '对比参数只支持 before、after 和 format，不能重复。' });
    }
    const beforeId = u.searchParams.get('before');
    const afterId = u.searchParams.get('after');
    const format = u.searchParams.get('format') ?? 'json';
    if (!beforeId || !afterId || !['json', 'md'].includes(format)) return json(res, 400, { code: 'INVALID_INPUT', error: '请明确选择两次不同的运行，格式支持 json 或 md。' });
    try {
      if (beforeId === afterId) return json(res, 400, { code: 'SAME_RUN', error: '此前运行与本次运行不能相同。' });
      const [before, after] = readAcceptanceSnapshots([beforeId, afterId]);
      if (!before || !after) return json(res, 404, { code: 'RUN_NOT_FOUND', error: '所选运行不存在。' });
      const beforeTime = Date.parse(before.manifest?.createdAt);
      const afterTime = Date.parse(after.manifest?.createdAt);
      if (Number.isFinite(beforeTime) && Number.isFinite(afterTime) && beforeTime > afterTime) {
        return json(res, 400, { code: 'RUN_ORDER', error: '此前运行的创建时间晚于本次运行，请核对选择。' });
      }
      const comparison = compareAcceptanceSnapshots(before, after);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (format === 'md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="acceptance-comparison.md"' });
        return res.end(comparisonMarkdown(comparison));
      }
      return json(res, 200, comparison);
    } catch (error) {
      return json(res, 400, { code: error.code ?? 'COMPARISON_UNAVAILABLE', error: '无法对比所选运行，请核对运行身份、报告和证据是否可用。' });
    }
  }
  if (u.pathname === '/api/acceptance/openapi/preview') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    return readJsonBody(req, res, input => {
      try {
        const preview = previewOpenApi(input.document, { targetUrl: input.targetUrl, name: input.name });
        preview.plan = normalizeAcceptancePlan(preview.plan);
        return json(res, 200, preview);
      } catch (error) { return json(res, 400, { error: String(error.message).slice(0, 500) }); }
    }, 4 * 1024 * 1024 + 16 * 1024);
  }
  if (u.pathname === '/api/acceptance/runs') {
    if (req.method === 'GET') {
      try { return json(res, 200, { runs: listAcceptanceRuns() }); }
      catch (error) {
        if (!(error instanceof ManagedAcceptanceRunError)) throw error;
        return json(res, error.status, { code: error.code, error: error.message });
      }
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    return readJsonBody(req, res, input => {
      let plan;
      try {
        assertUnmanagedAcceptanceInput(input);
        plan = normalizeAcceptancePlan(input);
        createLegacyAcceptanceReadScope(acceptanceOwner.root).assertCurrent();
      } catch (error) {
        if (error instanceof ManagedAcceptanceRunError) return json(res, error.status, { code: error.code, error: error.message });
        return json(res, 400, { error: error.message });
      }
      let lease, t, manifest, finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        if (runningAcceptance?.id === t?.id) runningAcceptance = null;
        try {
          acceptanceOwner.assertOwned();
          if (manifest) {
            const current = readAcceptanceRun(manifest.runId);
            if (current?.status === 'running') updateAcceptanceRun(manifest.runId, {
              status: t.cancelRequested ? 'interrupted' : 'failed', gate: 'blocked',
              endedAt: new Date().toISOString(), error: t.cancelRequested ? '验收任务已取消，请重新运行。' : '验收进程未完成；已保留现场，请重新运行。',
            });
          }
        } catch { acceptanceRuntime.block(); }
        finally { if (lease) { try { acceptanceRuntime.release(lease); } catch {} } }
      };
      try {
        acceptanceOwner.assertOwned();
        lease = acceptanceRuntime.reserve({ kind: 'legacy' });
        t = makeTask('acceptance', plan.targetUrl);
        manifest = createAcceptanceRun(plan, { taskId: t.id });
        t.runId = manifest.runId; t.label = plan.name; t.acceptanceLease = lease;
        t.requestStop = reason => { acceptanceRuntime.stop(lease, reason); };
        acceptanceRuntime.bind(lease, { runId: t.runId, taskId: t.id, onStop(reason) {
          if (['CANCELLED', 'ENGINE_SHUTDOWN'].includes(reason)) t.cancelRequested = true;
          killTree(t.child, 'SIGTERM');
        } });
        acceptanceRuntime.assertActive(lease);
        runningAcceptance = t;
        spawnTask(t, join('src', 'acceptance', 'cli.mjs'), ['--run', manifest.runId], { timeoutMs: 360000, stallMs: 65000 });
        t.child.once('exit', finalize);
        t.child.once('error', () => {
          t.watchdog?.stop(); t.status = 'failed'; t.endedAt = Date.now();
          t.error = '验收进程未能启动。'; finalize();
          try { jobStore?.upsert({ id: t.id, kind: t.kind, url: t.url, status: t.status,
            createdAt: t.createdAt, endedAt: t.endedAt, error: t.error }); } catch {}
        });
        return json(res, 202, { runId: manifest.runId, taskId: t.id });
      } catch (error) {
        if (t) {
          t.status = 'failed'; t.endedAt = Date.now(); t.error = '无法创建验收记录。';
          try { jobStore?.upsert({ id: t.id, kind: t.kind, url: t.url, status: t.status,
            createdAt: t.createdAt, endedAt: t.endedAt, error: t.error }); } catch {}
        }
        finalize();
        const failure = acceptanceExecutionError(error);
        return json(res, failure.status, failure.payload);
      }
    }, 7 * 1024 * 1024);
  }
  if (u.pathname.startsWith('/api/acceptance/runs/')) {
    const segments = u.pathname.slice('/api/acceptance/runs/'.length).split('/');
    const [runId, kind, name] = segments;
    try {
      const manifest = segments.length === 1 && req.method === 'GET'
        ? readAcceptanceDisplayRun(runId) : readAcceptanceRun(runId);
      if (!manifest) return json(res, 404, { error: '验收任务不存在' });
      if (segments.length === 2 && kind === 'triage') {
        if (req.method === 'GET') {
          const saved = readAcceptanceTriage(runId);
          return saved ? json(res, 200, saved) : json(res, 404, { error: '尚未生成 AI 解读' });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (runningAcceptanceTriage) return json(res, 409, { error: 'AI 正在解读另一份验收报告，请稍后重试。' });
        const reportFile = acceptanceArtifact(runId, 'report.json');
        if (!reportFile) return json(res, 409, { error: '请等待验收完成后再生成 AI 解读。' });
        runningAcceptanceTriage = runId;
        try {
          const { triageAcceptanceReport } = await import('./acceptance/triage.mjs');
          const triage = await triageAcceptanceReport(JSON.parse(readFileSync(reportFile, 'utf8')));
          saveAcceptanceTriage(runId, triage);
          return json(res, 200, triage);
        } finally { runningAcceptanceTriage = null; }
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      if (segments.length === 1) return json(res, 200, acceptanceRunView(manifest, { includePlan: true }));
      let fileName;
      if (segments.length === 2 && kind === 'report') fileName = 'report.json';
      else if (segments.length === 2 && kind === 'report.md') fileName = 'report.md';
      else if (segments.length === 3 && kind === 'evidence') fileName = decodeURIComponent(name);
      else return json(res, 404, { error: 'unknown acceptance endpoint' });
      const artifact = readAcceptanceArtifact(runId, fileName);
      if (!artifact) return json(res, manifest.status === 'running' ? 409 : 404, { error: '报告或证据尚不可用' });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', artifact.contentType);
      return res.end(artifact.bytes);
    } catch (error) {
      if (error instanceof ManagedAcceptanceRunError) return json(res, error.status, { code: error.code, error: error.message });
      return json(res, 400, { error: String(error.message).slice(0, 300) });
    }
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
        mirrorDegraded: t.mirrorDegraded === true,
      })),
      history: jobStore?.list({ limit: 50 }) ?? [],
    });
  }

  if (req.method === 'POST' && u.pathname.startsWith('/api/jobs/') && u.pathname.endsWith('/cancel')) {
    const id = u.pathname.split('/')[3];
    const t = tasks.get(id);
    if (!t) return json(res, 404, { error: 'no such task' });
    if (t.requestStop) {
      if (t.status === 'running') {
        // Aborting local work is safe even if ownership was lost. The writer
        // independently refuses settlement without the original owner fence.
        t.cancelRequested = true;
        try { t.requestStop('CANCELLED'); }
        catch (cause) { const failure = acceptanceExecutionError(cause); return json(res, failure.status, failure.payload); }
      }
      return json(res, 200, { id, status: t.status, cancelRequested: t.cancelRequested });
    }
    if (t.status === 'running') {
      t.cancelRequested = true;
      killTree(t.child, 'SIGTERM');      // 取消时先给个优雅退出的机会（win32 上仍是整树杀）
      jobStore?.upsert({ id: t.id, kind: t.kind, url: t.url, status: 'cancelled', pageName: t.pageName ?? null, createdAt: t.createdAt, endedAt: Date.now() });
      push(t, { kind: 'cancel-requested' });
    }
    return json(res, 200, { id, status: t.status });
  }

  if (req.method === 'POST' && u.pathname === '/api/recon') {
    readJsonBody(req, res, (b) => {
      let { url, maxPages = 40 } = b;
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      if (runningRecon) return json(res, 409, { error: 'busy', taskId: runningRecon.id });
      try {
        const taskId = startRecon(url, Math.min(Math.max(maxPages ?? 40, 5), 80));
        json(res, 200, { taskId, url, siteId: tasks.get(taskId)?.siteId ?? null });
      } catch (error) {
        json(res, error?.code === 'origin-conflict' ? 409 : 500, { error: String(error?.message ?? error).slice(0, 300) });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/forge') {
    readJsonBody(req, res, (b) => {
      let { url, hostPost = true } = b;
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      try {
        const { id, name } = startForge(url, { hostPost: hostPost !== false });
        json(res, 200, { taskId: id, pageName: name, url, siteId: tasks.get(id)?.siteId ?? null });
      } catch (e) {
        // 满槽由 startForge 抛 busy —— 那是 409（可以等会儿再来），不是 500
        json(res, e?.code === 'invalid-page-name' ? 400 : ['busy', 'origin-conflict'].includes(e?.code) ? 409 : 500,
          { error: e?.code === 'busy' ? 'busy' : String(e.message ?? e).slice(0, 300) });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/clone-site') {
    readJsonBody(req, res, (b) => {
      let { host, max = null, allDiscovered = false, incremental = false, force = false } = b;
      host = sanitizeHost(host);
      if (!/^[a-z0-9.-]+$/.test(host)) return json(res, 400, { error: 'bad host' });
      if (typeof allDiscovered !== 'boolean') return json(res, 400, { error: 'allDiscovered must be a boolean' });
      if (allDiscovered && Object.hasOwn(b, 'max')) return json(res, 400, { error: 'allDiscovered and max cannot be combined' });
      if (allDiscovered) {
        const scope = readCloneScope(join(WORKSPACE, host));
        if (scope.status !== 'ok') return json(res, 400, { error: 'allDiscovered requires a valid same-origin atlas and queue', issue: scope.issue });
      }
      if (runningClone) return json(res, 409, { error: 'busy', taskId: runningClone.id });
      const id = startCloneSite(host, {
        max: max == null ? null : Math.min(Math.max(Number(max) || 20, 1), 2000),
        allDiscovered, incremental: !!incremental, force: !!force,
      });
      json(res, 200, { taskId: id, host });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/audit') {
    readJsonBody(req, res, (b) => {
      let { url, maxPages = 30 } = b;
      try { url = new URL(url).href; } catch { return json(res, 400, { error: 'invalid url' }); }
      if (runningAudit) return json(res, 409, { error: 'busy', taskId: runningAudit.id });
      const id = startAudit(url, Math.min(Math.max(maxPages ?? 30, 1), 200));
      json(res, 200, { taskId: id, url });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/matrix') {
    readJsonBody(req, res, (b) => {
      let { sites = [], maxPages = 15 } = b;
      try {
        sites = [...new Map((Array.isArray(sites) ? sites : []).map(site => {
          const target = resolveMatrixTarget(site);
          return [target.origin, target.origin];
        })).values()];
      } catch { return json(res, 400, { error: 'invalid matrix site' }); }
      if (sites.length < 2 || sites.length > 6) return json(res, 400, { error: 'need 2-6 distinct origins' });
      if (runningMatrix) return json(res, 409, { error: 'busy', taskId: runningMatrix.id });
      const id = startMatrix(sites, Math.min(Math.max(maxPages ?? 15, 1), 100));
      json(res, 200, { taskId: id, sites });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/reclaim') {
    readJsonBody(req, res, async (b) => {
      let { host, apply = false } = b;
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
    readJsonBody(req, res, (b) => {
      let { host, threshold = 0.97, max = 8, force = false } = b;
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningUpgrade) return json(res, 409, { error: 'busy', taskId: runningUpgrade.id });
      const id = startResponsiveUpgrade(host, { threshold: Math.min(Math.max(Number(threshold) || 0.97, 0.5), 1), max: Math.min(Math.max(Number(max) || 8, 1), 61), force: !!force });
      json(res, 200, { taskId: id, host });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/verify') {
    readJsonBody(req, res, (b) => {
      let { host, page = null, maxPages = null } = b;
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (page != null && (!/^[a-z0-9._-]+$/i.test(String(page)) || !isSafePageName(String(page)))) return json(res, 400, { error: 'bad page' });
      if (maxPages !== null && (!Number.isInteger(Number(maxPages)) || Number(maxPages) < 1 || Number(maxPages) > 200)) return json(res, 400, { error: 'maxPages must be an integer from 1 to 200' });
      if (runningVerify) return json(res, 409, { error: 'busy', taskId: runningVerify.id });
      const id = startVerify(host, { page: page ? String(page) : null, maxPages: maxPages === null ? null : Number(maxPages) });
      json(res, 200, { taskId: id, host, page: page ?? null });
    });
    return;
  }

  // 在系统文件管理器里显示一个产物目录（导出交付包之后要"拿去发给同事"）。
  // 只允许 DATA_ROOT 以内的路径：这是个"打开资源管理器"的口子，不能变成任意路径探针。
  if (req.method === 'POST' && u.pathname === '/api/reveal') {
    readJsonBody(req, res, (b) => {
      const target = b.path ?? '';
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
    readJsonBody(req, res, (b) => {
      const host = String(b.host ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
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
    readJsonBody(req, res, (b) => {
      let { host, root = 'mirror', rebuild = false } = b;
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningLive) return json(res, 409, { error: 'busy', taskId: runningLive.id });
      const id = startLiveExport(host, { root, rebuild: !!rebuild });
      json(res, 200, { taskId: id, host, root });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/assets-audit') {
    readJsonBody(req, res, (b) => {
      let { host, maxPages = 60 } = b;
      host = String(host ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'invalid host' });
      if (runningAssets) return json(res, 409, { error: 'busy', taskId: runningAssets.id });
      const id = startAssets(host, Math.min(Math.max(maxPages ?? 60, 1), 500));
      json(res, 200, { taskId: id, host });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/watch') {
    readJsonBody(req, res, (b) => {
      let { url, maxPages = 20, accept = false } = b;
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
    const invalidatedVerifyPages = new Map();
    try {
      const summaryPath = join(WORKSPACE, host, 'verify', 'verify-summary.json');
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const generatedAt = Date.parse(summary.generatedAt ?? '');
      const summaryAt = Number.isFinite(generatedAt) ? generatedAt : statSync(summaryPath).mtimeMs;
      if (summary.mode === 'all' && Array.isArray(summary.pages)) {
        for (const page of summary.pages) {
          if (typeof page?.page === 'string' && (page.measured === false || page.invalidated)) {
            invalidatedVerifyPages.set(page.page, summaryAt);
          }
        }
      }
    } catch {}
    // 资产缺口（若已跑过扫描）
    const gapMap = {};
    const siteArtifacts = {
      linker: existsSync(join(WORKSPACE, host, 'linker-report.json')),
      assetGaps: existsSync(join(WORKSPACE, host, 'audit', 'asset-gaps.json')),
    };
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
        let interactions = null, minViewport = null, verifyScoreVersion = null;
        const artifacts = {
          verify: existsSync(join(WORKSPACE, host, 'verify', name, 'verify.json')),
          fixup: existsSync(join(pagesDir, name, 'fixup-history.json')),
          cloneGaps: existsSync(join(pagesDir, name, 'clone-gaps.json')),
          ...siteArtifacts,
        };
        let verifyMeasured = invalidatedVerifyPages.has(name) ? false : null;
        let verifyFresh = false;
        try {
          const verifyPath = join(WORKSPACE, host, 'verify', name, 'verify.json');
          const verifyMtime = statSync(verifyPath).mtimeMs;
          if (verifyMtime >= mtime) {
            const v = JSON.parse(readFileSync(verifyPath, 'utf8'));
            const generatedAt = Date.parse(v.generatedAt ?? '');
            const verifyAt = Number.isFinite(generatedAt) ? generatedAt : verifyMtime;
            if (!invalidatedVerifyPages.has(name) || verifyAt > invalidatedVerifyPages.get(name)) {
              verifyFresh = true;
              interactions = v.functional ?? null;
              verifyScoreVersion = v.scoreVersion ?? 1;
              verifyMeasured = v.measured === true;
              minViewport = v.minViewport
                ? { name: v.minViewport.name, score: v.minViewport.score, grade: v.minViewport.grade,
                    coverageRatio: v.minViewport.coverageRatio ?? null,
                    sourceSize: v.minViewport.sourceSize ?? null, cloneSize: v.minViewport.cloneSize ?? null,
                    heightDelta: v.minViewport.heightDelta ?? null, missingPixels: v.minViewport.missingPixels ?? null }
                : null;
            }
          }
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
          verifyScoreVersion,
          verifyMeasured,
          verifyFresh,
          artifacts,
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
        try { const x = new URL(j.url); return siteIdForOrigin(WORKSPACE, x) === host && (j.pageName === page || (j.kind === 'forge' && pageFor(x) === page)); } catch { return false; }
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
  // 交付包保留策略。扫描与隔离都在子进程里做，这里只读预览结果。
  if (u.pathname === '/api/deliver/plan' && req.method === 'GET') {
    const p = readDeliverPlan();
    if (!p) startDeliverPrune(false);      // 第一次访问时后台算一次
    const scanning = !!(deliverTask && deliverTask.status === 'running');
    return json(res, 200, p ? { ...p, scanning } : { pending: true, scanning });
  }
  if (u.pathname === '/api/deliver/prune' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
    const apply = body.apply === true;
    // 未设 token 时，写操作只允许本机回环。
    if (apply && !AUTH_TOKEN && !isLoopback(req)) {
      return json(res, 403, { error: '交付包隔离需要 HEIMDALL_TOKEN；未设置时仅允许本机回环访问' });
    }
    if (apply && body.confirm !== 'HEIMDALL_DELIVER_PRUNE') {
      return json(res, 400, { error: '交付包隔离需要 confirm=HEIMDALL_DELIVER_PRUNE' });
    }
    const revision = body.revision;
    if (apply && (typeof revision !== 'string' || !/^[0-9a-f]{64}$/i.test(revision))) {
      return json(res, 400, { error: '需要有效的预览 revision，请重新盘点' });
    }
    if (deliverRestoreRunning) return json(res, 409, { error: '交付包恢复正在进行，请稍后重试' });
    if (deliverTask?.status === 'running' && deliverTask.apply !== apply) {
      return json(res, 409, { error: '另一种交付包操作正在进行，请稍后重试' });
    }
    if (apply && deliverTask?.status === 'running' && deliverTask.revision !== revision) {
      return json(res, 409, { error: '预览 revision 已变化，请重新盘点' });
    }
    if (apply && !deliverTask) {
      const plan = readDeliverPlan();
      if (!plan || plan.revision !== revision || !plan.candidates?.length) {
        return json(res, 409, { error: '预览已过期或没有候选包，请重新盘点' });
      }
    }
    const taskId = startDeliverPrune(apply, revision);
    return json(res, 202, { ok: true, taskId, apply, status: 'running' });
  }
  if (u.pathname === '/api/deliver/trash' && req.method === 'GET') {
    try { return json(res, 200, { entries: await runDeliverCommand(['--list-trash']) }); }
    catch (error) { return json(res, 500, { error: String(error.message ?? error) }); }
  }
  const deliverRestore = /^\/api\/deliver\/trash\/([^/]+)\/restore$/.exec(u.pathname);
  if (deliverRestore && req.method === 'POST') {
    const id = deliverRestore[1];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return json(res, 400, { error: 'invalid quarantine id' });
    }
    if (!AUTH_TOKEN && !isLoopback(req)) return json(res, 403, { error: 'forbidden' });
    if (deliverTask?.status === 'running' || deliverRestoreRunning) {
      return json(res, 409, { error: '另一项交付包操作正在进行，请稍后重试' });
    }
    deliverRestoreRunning = true;
    try {
      const restored = await runDeliverCommand(['--restore', id]);
      deliverExpectedRunId = randomUUID();
      startStorageScan({ afterMutation: true });
      return json(res, 200, restored);
    } catch (error) { return json(res, 409, { error: String(error.message ?? error) }); }
    finally { deliverRestoreRunning = false; }
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
    startStorageScan({ afterMutation: true });                        // 重新盘点交给另一个子进程
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
      for (const d of existsSync(wsDir) ? readdirSync(wsDir) : []) {
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
        const clonedUrls = new Set(clonedTargets.map(canonUrl).filter(Boolean));
        // 从**克隆产物**这一侧数重合：atlas 里可能有两个节点指向同一路径
        // （`https://x` 与 `https://x/`），从 atlas 侧数就会得出比克隆页还多的重合数。
        const atlasPaths = new Set((atlas?.nodes ?? []).map(n => canonUrl(n.url)).filter(Boolean));
        let clonedInAtlas = 0;
        for (const p of clonedUrls) if (atlasPaths.has(p)) clonedInAtlas++;

        // 没有 atlas 时从页面 manifest 推 origin（manifest.target 是原站 URL）
        let origin = atlas?.origin ?? '';
        try { origin = readSiteOrigin(join(wsDir, d)) ?? origin; } catch { /* corrupted identity must not hide every site */ }
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
    const scope = readCloneScope(join(WORKSPACE, host));
    const qp = join(WORKSPACE, host, 'queue.json');
    if (!existsSync(qp)) return json(res, 200, { host, exists: false, scope });
    let q;
    try { q = JSON.parse(readFileSync(qp, 'utf8')); } catch { return json(res, 200, { host, exists: true, unreadable: true, scope }); }
    if (!Array.isArray(q)) return json(res, 200, { host, exists: true, unreadable: true, scope });
    const count = (s) => q.filter(x => x.status === s).length;
    const done = count('done'), failed = count('failed'), pending = count('pending'), queued = count('queued');
    const active = !!(runningClone && runningClone.host === host && runningClone.status === 'running');
    return json(res, 200, { host, exists: true, total: q.length, done, failed, pending, queued, unfinished: failed + pending + queued, active, taskId: active ? runningClone.id : null, scope });
  }

  // 反向代理 /px/<host>/<path> → https://<host>/<path> —— 交互镜像基础设施：
  // 镜像页的 API/资源请求走此通道回原站，"功能数据用原站跑通"
  if (req.method === 'GET' && u.pathname.startsWith('/px/')) {
    const m = /^\/px\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(res, 400, { error: 'bad proxy path' });
    const identity = mirrorIdentity(m[1]);
    if (!identity) return json(res, 403, { error: 'host not allowed (recon it first or set HEIMDALL_ALLOWED_HOSTS)' });
    const target = identity.origin + (m[2] ?? '/') + u.search;
    try {
      const upstream = await fetch(target, { headers: { 'User-Agent': UA, Accept: req.headers.accept ?? '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow' });
      const headers = new Headers();
      for (const [k, v] of upstream.headers) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy'].includes(k.toLowerCase())) continue;
        headers.set(k, v);
      }
      for (const [k, v] of Object.entries(activeDocumentHeaders(req, headers.get('content-type'), { source: 'proxy' }))) {
        headers.set(k, v);
      }
      writeProxyHead(res, upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) { json(res, 502, { error: String(e).slice(0, 120) }); }
    return;
  }

  // A prefix mirror would execute source-site scripts on the engine API origin.
  // The isolated <host>.localhost mirror remains the interactive entry point.
  if (u.pathname === '/lm' || u.pathname.startsWith('/lm/')) {
    return json(res, 410, { error: 'prefix mirror disabled; use the isolated mirror host' });
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
      acceptance: runningAcceptance ? { id: runningAcceptance.id, runId: runningAcceptance.runId } : null,
      live: runningLive ? { id: runningLive.id, host: runningLive.host } : null,
      session: runningSession ? { id: runningSession.id, host: runningSession.host } : null,
      upgrade: runningUpgrade ? { id: runningUpgrade.id, host: runningUpgrade.host } : null,
      clone: runningClone ? { id: runningClone.id, host: runningClone.host, plan: runningClone.plan } : null,
      editManifest: editManifestTask && editManifestTask.status === 'running' ? { id: editManifestTask.id, host: editManifestTask.host } : null,
      forge: { slots: forgeSlots.used, max: forgeSlots.max },
      jobs: tasks.size,
      jobsStore: jobStore?.kind ?? null,
      bind: BIND,
      auth: !!AUTH_TOKEN,
    });
  }

  if (req.method === 'GET' && u.pathname === '/api/trash') {
    const storage = readStorageFile();
    if (!storage || storage.stale) startStorageScan();
    const bytes = storage?.trash?.uniqueBytes ?? null;
    const purged = listPurgedTrashBackups();
    return json(res, 200, { entries: listTrash(), purged, summary: {
      logicalBytes: storage?.trash?.logicalBytes ?? null,
      uniqueBytes: bytes,
      files: storage?.trash?.files ?? null,
      generatedAt: storage?.generatedAt ?? null,
      pending: !storage,
      stale: !!storage?.stale,
      scanning: !!(storageScanTask && storageScanTask.status === 'running'),
      warningBytes: TRASH_WARN_BYTES,
      warning: bytes !== null && bytes >= TRASH_WARN_BYTES,
    } });
  }
  if (req.method === 'GET' && /^\/api\/trash\/[^/]+\/preview$/.test(u.pathname)) {
    const id = u.pathname.split('/')[3];
    try { return json(res, 200, await runTrashCommand(['preview', id])); }
    catch (error) {
      const message = String(error.message);
      return json(res, message.includes('bad trash id') ? 400 : /ENOENT|no such file/.test(message) ? 404 : 409,
        { error: message });
    }
  }
  if (req.method === 'POST' && /^\/api\/trash\/[^/]+\/backup$/.test(u.pathname)) {
    const id = u.pathname.split('/')[3];
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { return json(res, 400, { error: 'invalid json' }); }
    if (!/^[0-9a-f]{64}$/i.test(body?.revision ?? '')) {
      return json(res, 400, { error: 'preview revision required' });
    }
    try { return json(res, 200, { ok: true, ...await runTrashCommand(['backup', id, body.revision]) }); }
    catch (error) {
      const message = String(error.message);
      return json(res, /ENOENT|no such file/.test(message) ? 404 : 409, { error: message });
    }
  }
  if (req.method === 'POST' && /^\/api\/trash\/[^/]+\/recover-backup$/.test(u.pathname)) {
    const id = u.pathname.split('/')[3];
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { return json(res, 400, { error: 'invalid json' }); }
    if (body?.confirmId !== id || !/^[0-9a-f]{64}$/i.test(body?.revision ?? '')) {
      return json(res, 400, { error: 'matching confirmId and backup revision required' });
    }
    try {
      const result = await runTrashCommand(['recover-backup', id, body.revision, body.confirmId]);
      startStorageScan({ afterMutation: true });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      const message = String(error.message);
      return json(res, /ENOENT|no such file/.test(message) ? 404 : 409, { error: message });
    }
  }
  if (req.method === 'DELETE' && /^\/api\/trash\/[^/]+$/.test(u.pathname)) {
    const id = u.pathname.split('/')[3];
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { return json(res, 400, { error: 'invalid json' }); }
    if (body?.confirmId !== id || !/^[0-9a-f]{64}$/i.test(body?.revision ?? '')) {
      return json(res, 400, { error: 'matching confirmId and preview revision required' });
    }
    try {
      const result = await runTrashCommand(['purge-record', id, body.revision, body.confirmId,
        body.acceptSameFilesystem === true ? 'accept-same-filesystem' : 'reject-same-filesystem']);
      startStorageScan({ afterMutation: true });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      const message = String(error.message);
      return json(res, /ENOENT|no such file/.test(message) ? 404 : 409, { error: message });
    }
  }
  if (req.method === 'POST' && /^\/api\/trash\/[^/]+\/restore$/.test(u.pathname)) {
    const id = u.pathname.split('/')[3];
    try {
      await readBody(req);
      const result = restoreTrash(id);
      if (result.restored !== false) {
        bustCaches();
        startStorageScan({ afterMutation: true });
      }
      return json(res, 200, { ok: true, restored: true, ...result });
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 200);
      const code = message === 'bad trash id' ? 400 : error?.code === 'ENOENT' ? 404
        : /already exists|changed|not ready|backup missing|not a directory|not a regular file/.test(message) ? 409 : 500;
      return json(res, code, { error: message });
    }
  }

  // 删除：整站（workspace/<host>）或单页（页面产物 + atlas 节点），保留可恢复副本。
  if (req.method === 'DELETE' && u.pathname.startsWith('/api/sites/')) {
    const parts = u.pathname.split('/').filter(Boolean); // ['api','sites',host?...]
    const host = decodeURIComponent(parts[2] ?? '');
    if (!/^[a-z0-9.-]+$/i.test(host)) return json(res, 400, { error: 'bad host' });
    const base = join(WORKSPACE, host);
    if (!isInsideWorkspace(base) || !existsSync(base)) return json(res, 404, { error: 'site not found' });
    try {
      if (parts.length === 3) {
        return readJsonBody(req, res, (body) => {
          if (body?.confirmHost !== host) return json(res, 400, { error: 'site deletion requires matching confirmHost' });
          try {
            const { trashId } = quarantineSite(host);
            bustCaches();                                                        // 站点没了，清单与代理白名单都得重算
            const casGcTask = startCasGc(true);                                  // 回收改子进程，不占请求线程
            startStorageScan({ afterMutation: true });                           // 12s 的盘点交给子进程
            return json(res, 200, { ok: true, removed: 'site', host, trashId, casGcTask });
          } catch (e) { return json(res, 500, { error: String(e).slice(0, 200) }); }
        });
      }
      if (parts.length === 5 && parts[3] === 'pages') {
        const name = decodeURIComponent(parts[4]);
        if (!/^[a-z0-9._-]+$/i.test(name) || !isSafePageName(name)) return json(res, 400, { error: 'bad page name' });
        const { removedArtifacts, removedNode, trashId } = quarantinePage(host, name);
        const casGcTask = removedArtifacts ? startCasGc(true) : null;          // 回收改子进程
        if (trashId) startStorageScan({ afterMutation: true });
        bustCaches();                                                          // 删了一页，资产清单/站点重合数随即变化
        return json(res, 200, { ok: true, removed: 'page', host, name, removedArtifacts, removedNode, trashId, casGcTask });
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
      { id: 'edit-manifest', name: '改站起点清单', file: join(base, 'deliver', 'edit-manifest.json'), url: '/static/' + host + '/deliver/edit-manifest.json' },
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
          if (statSync(file).isFile()) {
            if (!authorized(req, u, res)) return json(res, 401, { error: 'unauthorized' });
            return sendFile(req, res, file);
          }
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
        if (existsSync(f) && statSync(f).isFile()) return sendFile(req, res, f, {}, 'console');
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

// 优雅退出：先停掉任务子进程，再关闭持久化存储（Docker stop / Ctrl-C）。
// 存储盘点、克隆、导出都是子进程；只杀引擎会让它们继续写数据目录，
// 测试里表现为临时目录 ENOTEMPTY，生产里则是孤儿任务继续占资源。
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { acceptanceRuntime.close(); } catch { acceptanceRuntime.block(); }
  server.close();
  const running = [...tasks.values()].filter(t => t.status === 'running' && t.child && t.child.exitCode === null);
  const children = Promise.all(running.map(t => new Promise(resolve => {
    t.cancelRequested = true;
    t.child.once('exit', resolve);
    killTree(t.child, 'SIGTERM');
    const forceKill = setTimeout(() => {
      killTree(t.child, 'SIGKILL');
      resolve();
    }, 1500);
    t.child.once('exit', () => clearTimeout(forceKill));
  })));
  let grace;
  await Promise.race([Promise.allSettled([children, acceptanceExecutions.drain()]),
    new Promise(resolve => { grace = setTimeout(resolve, 2500); })]);
  clearTimeout(grace);
  try { jobStore?.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
