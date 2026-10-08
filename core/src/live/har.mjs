/**
 * live/har — HAR 清洗 / 索引 / 查找（纯函数，无 IO）
 *
 * 目标：把 Playwright 录制的 HAR 变成"可随镜像分发的本地资源与 API 回放表"。
 * 安全：只保留安全的响应头（内容类型/缓存/校验），绝不携带 cookie / authorization / set-cookie。
 */
const SAFE_RESPONSE_HEADERS = [
  'content-type', 'cache-control', 'etag', 'last-modified', 'content-language', 'access-control-allow-origin',
];

export function sanitizeHar(har) {
  const entries = [];
  for (const e of har?.log?.entries ?? []) {
    const req = e.request ?? {};
    const res = e.response ?? {};
    const method = String(req.method ?? 'GET').toUpperCase();
    const url = String(req.url ?? '');
    const status = Number(res.status ?? 0);
    if (!url || !status) continue;
    let body = null;
    const text = res.content?.text;
    if (typeof text === 'string' && text.length) {
      body = res.content?.encoding === 'base64' ? text : Buffer.from(text, 'utf8').toString('base64');
    }
    const headers = {};
    for (const h of res.headers ?? []) {
      const name = String(h.name ?? '').toLowerCase();
      if (SAFE_RESPONSE_HEADERS.includes(name)) headers[name] = h.value;
    }
    entries.push({
      method, url, status,
      mimeType: res.content?.mimeType ?? headers['content-type'] ?? '',
      headers, body, bodyEncoding: body ? 'base64' : null,
    });
  }
  return { version: 1, generatedAt: new Date().toISOString(), entries };
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
