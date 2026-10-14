/**
 * live/har — HAR 清洗 / 索引 / 查找（纯函数，无 IO）
 *
 * 目标：把 Playwright 录制的 HAR 变成"可随镜像分发的本地资源与 API 回放表"。
 * 安全：只保留安全的响应头（内容类型/缓存/校验），绝不携带 cookie / authorization / set-cookie。
 */
const SAFE_RESPONSE_HEADERS = [
  'content-type', 'cache-control', 'etag', 'last-modified', 'content-language', 'access-control-allow-origin',
];

const STATIC_MIME = /^(?:image\/|font\/|audio\/|video\/|text\/css\b|(?:text|application)\/(?:javascript|x-javascript)\b|application\/(?:font|wasm)\b)/i;
const STATIC_EXT = /\.(?:css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm)$/i;
const SAFE_QUERY_KEYS = new Set(['v', 'ver', 'version', 'rev', 'hash', 'w', 'h', 'width', 'height', 'q', 'quality', 'dpr', 'fit', 'format', 'auto', 'url', 'dpl', 'cache', 'b']);
const PRIVATE_TEXT = /(?:\b(?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|set-cookie|session|csrf|sid|token|secret)\b\s*[:=]|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i;
const PRIVATE_HEADER = /^(?:cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i;
const PRIVATE_PATH_PARENT = /^(?:users?|accounts?|members?|profiles?|customers?|patients?|orders?|invoices?|sessions?|avatars?|reset-password|password-reset|verify-email|email-verification|magic-link|invites?|invitations?|tokens?|secrets?)$/i;

function reportPath(url) {
  return url.origin + '/[redacted]';
}

function hasPrivatePath(url) {
  let decoded = url.pathname;
  for (let i = 0; i < 2; i++) {
    try { decoded = decodeURIComponent(decoded); } catch { return true; }
    if (PRIVATE_TEXT.test(decoded)) return true;
  }
  const segments = decoded.split('/').filter(Boolean);
  return segments.some((segment, i) => PRIVATE_PATH_PARENT.test(segment) && !!segments[i + 1]);
}

function safeReplayUrl(url, depth = 0) {
  if (depth > 2 || url.username || url.password || hasPrivatePath(url)) return false;
  for (const [key, value] of url.searchParams) {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { return false; }
    if (!SAFE_QUERY_KEYS.has(key.toLowerCase()) || decoded.length > 500 || PRIVATE_TEXT.test(decoded)) return false;
    if (key.toLowerCase() === 'url') {
      let nested;
      try { nested = new URL(value, url); } catch { return false; }
      if (!['http:', 'https:'].includes(nested.protocol) || !safeReplayUrl(nested, depth + 1)) return false;
    }
  }
  return true;
}

function isStaticResponse(url, mimeType) {
  return STATIC_MIME.test(mimeType) || STATIC_EXT.test(url.pathname);
}

export function sanitizeHar(har, { includeApiBodies = false } = {}) {
  const entries = [];
  const excluded = { invalid: 0, privateUrl: 0, authenticated: 0, nonStatic: 0, privateBody: 0 };
  const examples = [];
  for (const e of har?.log?.entries ?? []) {
    const req = e.request ?? {};
    const res = e.response ?? {};
    const method = String(req.method ?? 'GET').toUpperCase();
    const url = String(req.url ?? '');
    const status = Number(res.status ?? 0);
    let parsed;
    try { parsed = new URL(url); } catch { excluded.invalid++; continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !status) { excluded.invalid++; continue; }
    const mimeType = res.content?.mimeType ?? (res.headers ?? []).find(h => String(h.name).toLowerCase() === 'content-type')?.value ?? '';
    let reason = null;
    if (!safeReplayUrl(parsed)) reason = 'privateUrl';
    else if (!includeApiBodies && ((req.headers ?? []).some(h => PRIVATE_HEADER.test(String(h.name))) || (req.cookies ?? []).length > 0)) reason = 'authenticated';
    else if (!includeApiBodies && (method !== 'GET' || /^\/api(?:\/|$)/i.test(parsed.pathname) || !isStaticResponse(parsed, mimeType))) reason = 'nonStatic';
    if (reason) {
      excluded[reason]++;
      if (examples.length < 20) examples.push({ reason, path: reportPath(parsed) });
      continue;
    }
    let body = null;
    const text = res.content?.text;
    if (typeof text === 'string' && text.length) {
      const raw = res.content?.encoding === 'base64' ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8');
      if (!includeApiBodies && (/(?:text|javascript|json|xml|svg)/i.test(mimeType) || /\.(?:js|mjs|css|svg)$/i.test(parsed.pathname)) && PRIVATE_TEXT.test(raw.toString('utf8'))) {
        excluded.privateBody++;
        if (examples.length < 20) examples.push({ reason: 'privateBody', path: reportPath(parsed) });
        continue;
      }
      body = raw.toString('base64');
    }
    const headers = {};
    for (const h of res.headers ?? []) {
      const name = String(h.name ?? '').toLowerCase();
      if (SAFE_RESPONSE_HEADERS.includes(name)) headers[name] = h.value;
    }
    entries.push({
      method, url: parsed.href, status,
      mimeType,
      headers, body, bodyEncoding: body ? 'base64' : null,
    });
  }
  return { version: 1, generatedAt: new Date().toISOString(), entries, privacy: { excluded, examples, includeApiBodies } };
}

/** 合并多页 HAR（同 key 第一条优先；页面顺序 = 参数顺序） */
export function mergeHar(harList) {
  const seen = new Set();
  const entries = [];
  for (const har of harList) {
    for (const e of har?.entries ?? []) {
      const key = harKey(e.method, e.url);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(e);
    }
  }
  return { version: 1, generatedAt: new Date().toISOString(), entries };
}

export function normalizeUrl(u) {
  try { const x = new URL(String(u)); x.hash = ''; return x.href; } catch { return String(u); }
}

export function harKey(method, url) {
  return String(method ?? 'GET').toUpperCase() + ' ' + normalizeUrl(url);
}

export function indexHar(entries) {
  const map = new Map();
  for (const e of entries ?? []) {
    const key = harKey(e.method, e.url);
    if (!map.has(key)) map.set(key, e);
  }
  return map;
}

export function matchHar(index, method, url) {
  return index.get(harKey(method, url)) ?? null;
}

export function harStats(entries) {
  let bytes = 0;
  const byMime = {};
  for (const e of entries ?? []) {
    if (e.body) bytes += Math.floor(e.body.length * 0.75);
    const bucket = String(e.mimeType || 'unknown').split(';')[0];
    byMime[bucket] = (byMime[bucket] ?? 0) + 1;
  }
  return { entries: entries?.length ?? 0, bytes, byMime };
}
