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
const STATIC_EXT = /\.(?:css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|riv|glb|gltf)$/i;
const SAFE_QUERY_KEYS = new Set(['v', 'ver', 'version', 'rev', 'hash', 'w', 'h', 'width', 'height', 'q', 'quality', 'dpr', 'fit', 'format', 'auto', 'url', 'dpl', 'cache', 'b']);
// Start email detection at '@'; scanning its unbounded local part at every character is quadratic.
const PRIVATE_TEXT = /(?:\b(?:authorization|bearer|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|set-cookie|session|csrf|sid|token|secret)\b\s*[:=]|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|(?<=[\w.+-])@[\w.-]+\.[A-Za-z]{2,})/i;
const PRIVATE_HEADER = /^(?:cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i;
const PRIVATE_PATH_PARENT = /^(?:users?|accounts?|members?|profiles?|customers?|patients?|orders?|invoices?|sessions?|avatars?|reset-password|password-reset|verify-email|email-verification|magic-link|invites?|invitations?|tokens?|secrets?)$/i;
const PRIVATE_DATA_HEADER = /(?:cookie|authorization|api[_-]?key|auth[_-]?token|access[_-]?token|session|csrf|xsrf|secret|(?:^|[-_])(?:token|key)(?:$|[-_]))/i;
const PRIVATE_DATA_KEY = /^(?:auth(?:orization)?|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|session(?:[_-]?id)?|cookie|csrf|xsrf|email|phone|mobile|address|birth(?:day|date)?|dob|ssn|credit(?:[_-]?card)?|card(?:[_-]?number)?|bank(?:[_-]?account)?|iban|customer(?:[_-]?id)?|patient(?:[_-]?id)?|account(?:[_-]?id)?|profile(?:[_-]?id)?|user(?:[_-]?id|name)?)$|(?:^|[_-])(?:auth|token|key|secret|password|session|cookie|csrf|xsrf|email|phone|address|account|customer|patient|user)(?:$|[_-])/i;
const PRIVATE_QUERY_KEY = /(?:auth|token|key|password|passwd|secret|session|cookie|csrf|xsrf|email|phone|address|user|account|customer|patient)/i;
const DATA_MIME = /^(?:application\/(?:[a-z0-9.+-]+\+)?json|text\/plain)(?:\s*;|$)/i;
const JSON_BODY_MIME = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)|^text\/json(?:\s*;|$)/i;
const FORM_BODY_MIME = /^application\/x-www-form-urlencoded(?:\s*;|$)/i;
export const MAX_PUBLIC_DATA_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function isPrivateText(value) {
  return PRIVATE_TEXT.test(String(value ?? ''));
}

function normalizedDataMime(value) {
  const mime = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return DATA_MIME.test(mime) && mime.length <= 80 ? mime + '; charset=utf-8' : null;
}

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

function safePublicDataUrl(url) {
  if (url.username || url.password || hasPrivatePath(url) || url.hash || url.href.length > 2048) return false;
  for (const [key, value] of url.searchParams) {
    if (!/^[a-z][a-z0-9_.-]{0,39}$/i.test(key) || PRIVATE_QUERY_KEY.test(key) || value.length > 200) return false;
    let decoded = value;
    for (let i = 0; i < 2; i++) {
      try { decoded = decodeURIComponent(decoded); } catch { return false; }
      if (PRIVATE_TEXT.test(decoded) || /^(?:https?:)?\/\//i.test(decoded)) return false;
    }
  }
  return true;
}

export function isSafeReadOnlyGetUrl(value, origin) {
  try {
    const allowedOrigin = publicDataOrigin(origin);
    const url = new URL(value);
    return !!allowedOrigin && ['http:', 'https:'].includes(url.protocol)
      && url.origin === allowedOrigin && safePublicDataUrl(url);
  } catch { return false; }
}

function publicDataBody(raw, mimeType) {
  if (!raw?.length || raw.length > MAX_PUBLIC_DATA_BYTES) return false;
  let text;
  try { text = UTF8_DECODER.decode(raw); } catch { return false; }
  if (PRIVATE_TEXT.test(text) || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return false;
  if (!/^application\//i.test(mimeType)) return true;
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  const stack = [value];
  let visited = 0;
  while (stack.length) {
    if (++visited > 10_000) return false;
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (PRIVATE_DATA_KEY.test(key) || (typeof child === 'string' && PRIVATE_TEXT.test(child))) return false;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return true;
}

/** Shared by the contract view so schema generation keeps the HAR privacy boundary. */
export function isPrivateDataKey(value) {
  return PRIVATE_DATA_KEY.test(String(value ?? ''));
}

/** Retain unsafe integer and overflowing number tokens without rounding them. */
export function parseReplayJson(text) {
  return JSON.parse(text, (_key, value, context) => typeof value === 'number'
    && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    ? JSON.rawJSON(context.source) : value);
}

/** Remove sensitive keys and values before an explicitly requested API replay export. */
export function scrubPublicJsonValue(value) {
  if (JSON.isRawJSON(value) && /^-?\d/.test(value.rawJSON)) return value;
  if (Array.isArray(value)) return value.map(scrubPublicJsonValue).filter(item => item !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (isPrivateDataKey(key) || isPrivateText(key)) continue;
      const safe = scrubPublicJsonValue(child);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  if (typeof value === 'string' && isPrivateText(value)) return undefined;
  return value;
}

function observedSchema(value) {
  if (value === null) return { type: 'null', 'x-heimdall-provenance': 'observed' };
  if (Array.isArray(value)) {
    return {
      type: 'array', 'x-heimdall-provenance': 'observed',
      items: value.length ? observedSchema(value[0]) : {},
    };
  }
  if (value && typeof value === 'object') {
    const properties = {};
    for (const [key, child] of Object.entries(value)) properties[key] = observedSchema(child);
    return { type: 'object', 'x-heimdall-provenance': 'observed', properties, additionalProperties: true };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number', 'x-heimdall-provenance': 'observed' };
  if (typeof value === 'boolean') return { type: 'boolean', 'x-heimdall-provenance': 'observed' };
  return { type: 'string', 'x-heimdall-provenance': 'observed' };
}

function observedRequestBody(req) {
  const postData = req?.postData;
  const bodyText = typeof postData === 'string' ? postData : postData?.text;
  if (typeof bodyText !== 'string' || !bodyText.length || bodyText.length > MAX_PUBLIC_DATA_BYTES) return null;
  const headerMime = (req.headers ?? []).find(h => /^content-type$/i.test(String(h.name)))?.value;
  const mimeType = String(postData?.mimeType ?? headerMime ?? '').split(';', 1)[0].trim().toLowerCase();
  if (JSON_BODY_MIME.test(mimeType)) {
    let value;
    try { value = JSON.parse(bodyText); } catch { return { mimeType, parseable: false }; }
    const safe = scrubPublicJsonValue(value);
    return { mimeType, parseable: true, schema: observedSchema(safe ?? '') };
  }
  if (FORM_BODY_MIME.test(mimeType)) {
    const properties = {};
    for (const [key] of new URLSearchParams(bodyText)) {
      if (!isPrivateDataKey(key)) properties[key] = { type: 'string', 'x-heimdall-provenance': 'observed' };
    }
    return { mimeType, parseable: true, schema: { type: 'object', 'x-heimdall-provenance': 'observed', properties, additionalProperties: true } };
  }
  return { mimeType: mimeType || 'application/octet-stream', parseable: false };
}

function observedRequestAuth(req) {
  const schemes = new Set();
  for (const header of req?.headers ?? []) {
    const name = String(header.name ?? '').toLowerCase();
    if (name === 'authorization') {
      const scheme = String(header.value ?? '').trim().split(/\s+/, 1)[0].toLowerCase();
      schemes.add(scheme === 'bearer' || scheme === 'basic' || scheme === 'digest' ? scheme : 'authorization');
    } else if (name === 'cookie' || name === 'set-cookie' || name === 'proxy-authorization') schemes.add('cookie');
    else if (/^(?:x-)?api-key$/.test(name)) schemes.add('api-key');
    else if (/(?:csrf|xsrf)/.test(name)) schemes.add('csrf');
    else if (/(?:auth|token|session|secret|key)/.test(name)) schemes.add('token-like-header');
  }
  if ((req?.cookies ?? []).length) schemes.add('cookie');
  return [...schemes].sort();
}

function publicDataOrigin(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('invalid readOnlyOrigin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new TypeError('invalid readOnlyOrigin');
  return url.origin;
}

function approvedPublicDataUrls(urls, origin) {
  if (!Array.isArray(urls) || urls.length > 1000 || (urls.length && !origin)) {
    throw new TypeError('readOnlyGetUrls requires an origin and at most 1000 URLs');
  }
  const approved = new Set();
  for (const value of urls) {
    let url;
    try { url = new URL(value); } catch { throw new TypeError('invalid readOnlyGetUrl'); }
    if (!isSafeReadOnlyGetUrl(value, origin)) throw new TypeError('unsafe readOnlyGetUrl');
    approved.add(normalizeUrl(url.href));
  }
  return approved;
}

/** An opt-in public data entry must stay safe after it is copied into a bundle. */
export function isReplayableReadOnlyDataEntry(entry, origin) {
  let url;
  try { url = new URL(entry?.url); } catch { return false; }
  let raw;
  try {
    if (typeof entry.body !== 'string' || entry.bodyEncoding !== 'base64'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.body)) return false;
    raw = Buffer.from(entry.body, 'base64');
  } catch { return false; }
  return entry.kind === 'public-read-only-data' && entry.method === 'GET'
    && url.origin === origin && safePublicDataUrl(url)
    && Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300
    && entry.mimeType === normalizedDataMime(entry.mimeType) && publicDataBody(raw, entry.mimeType)
    && entry.headers && typeof entry.headers === 'object' && !Object.keys(entry.headers).length;
}

export function sanitizeHar(har, { includeApiBodies = false, readOnlyGetUrls = [], readOnlyOrigin = '' } = {}) {
  const origin = publicDataOrigin(readOnlyOrigin);
  const approved = approvedPublicDataUrls(readOnlyGetUrls, origin);
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
    const dataMime = normalizedDataMime(mimeType);
    const publicData = approved.has(normalizeUrl(parsed.href)) && parsed.origin === origin && !!dataMime;
    let reason = null;
    if (publicData && !safePublicDataUrl(parsed)) reason = 'privateUrl';
    else if (!publicData && !safeReplayUrl(parsed)) reason = 'privateUrl';
    else if (publicData && (method !== 'GET' || status < 200 || status >= 300 || req.postData)) reason = 'nonStatic';
    else if (publicData && ((req.headers ?? []).some(h => PRIVATE_DATA_HEADER.test(String(h.name)))
      || (req.cookies ?? []).length > 0 || (res.cookies ?? []).length > 0
      || (res.headers ?? []).some(h => /^set-cookie$/i.test(String(h.name))
        || (/^vary$/i.test(String(h.name)) && /cookie|authorization/i.test(String(h.value)))
        || (/^cache-control$/i.test(String(h.name)) && /(?:^|,)\s*private\b/i.test(String(h.value)))))) reason = 'authenticated';
    else if (!includeApiBodies && ((req.headers ?? []).some(h => PRIVATE_HEADER.test(String(h.name))) || (req.cookies ?? []).length > 0)) reason = 'authenticated';
    else if (!publicData && !includeApiBodies && (method !== 'GET' || /^\/api(?:\/|$)/i.test(parsed.pathname)
      || DATA_MIME.test(mimeType) || !isStaticResponse(parsed, mimeType))) reason = 'nonStatic';
    if (reason) {
      excluded[reason]++;
      if (examples.length < 20) examples.push({ reason, path: reportPath(parsed) });
      continue;
    }
    let body = null;
    const text = res.content?.text;
    if (typeof text === 'string' && text.length) {
      const raw = res.content?.encoding === 'base64' ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8');
      if (publicData && !publicDataBody(raw, mimeType)) {
        excluded.privateBody++;
        if (examples.length < 20) examples.push({ reason: 'privateBody', path: reportPath(parsed) });
        continue;
      }
      if (!publicData && !includeApiBodies && (/(?:text|javascript|json|xml|svg)/i.test(mimeType) || /\.(?:js|mjs|css|svg)$/i.test(parsed.pathname)) && PRIVATE_TEXT.test(raw.toString('utf8'))) {
        excluded.privateBody++;
        if (examples.length < 20) examples.push({ reason: 'privateBody', path: reportPath(parsed) });
        continue;
      }
      body = raw.toString('base64');
    }
    if (publicData && !body) {
      excluded.nonStatic++;
      if (examples.length < 20) examples.push({ reason: 'nonStatic', path: reportPath(parsed) });
      continue;
    }
    const requestBody = includeApiBodies ? observedRequestBody(req) : null;
    const requestAuth = includeApiBodies ? observedRequestAuth(req) : [];
    const headers = {};
    for (const h of res.headers ?? []) {
      const name = String(h.name ?? '').toLowerCase();
      if (!publicData && SAFE_RESPONSE_HEADERS.includes(name)) headers[name] = h.value;
    }
    entries.push({
      method, url: parsed.href, status,
      mimeType: publicData ? dataMime : mimeType,
      headers, body, bodyEncoding: body ? 'base64' : null,
      ...(requestBody ? { requestBody } : {}),
      ...(requestAuth.length ? { requestAuth } : {}),
      ...(publicData ? { kind: 'public-read-only-data' } : {}),
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
