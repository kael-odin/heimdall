const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const HOP_BY_HOP = new Set([
  'connection', 'content-encoding', 'content-length', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'set-cookie2',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export const PX_PROXY_LIMITS = Object.freeze({
  maxRedirects: 5,
  timeoutMs: 30_000,
  maxResponseBytes: 32 * 1024 * 1024,
});

export class PxProxyError extends Error {
  constructor(message, { status = 502, code = 'PX_PROXY_FAILED', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PxProxyError';
    this.status = status;
    this.code = code;
  }
}

function allowedOrigin(value) {
  const origin = new URL(value).origin;
  if (!/^https?:$/.test(new URL(origin).protocol)) throw new PxProxyError('proxy origin must be HTTP(S)', { code: 'PX_PROXY_ORIGIN_INVALID' });
  return origin;
}

function sameOriginUrl(value, origin, base) {
  let target;
  try { target = new URL(value, base); }
  catch (cause) { throw new PxProxyError('invalid proxy redirect', { code: 'PX_PROXY_REDIRECT_INVALID', cause }); }
  if (!/^https?:$/.test(target.protocol) || target.origin !== origin) {
    throw new PxProxyError('cross-origin proxy redirect blocked', { code: 'PX_PROXY_REDIRECT_BLOCKED' });
  }
  if (target.username || target.password) {
    throw new PxProxyError('credentialed proxy redirect blocked', { code: 'PX_PROXY_REDIRECT_BLOCKED' });
  }
  return target;
}

/** Follow only bounded same-origin redirects. The network never sees an unapproved hop. */
export async function fetchPxUpstream(initialUrl, {
  origin,
  headers = {},
  fetchImpl = fetch,
  maxRedirects = PX_PROXY_LIMITS.maxRedirects,
  signal,
} = {}) {
  const expectedOrigin = allowedOrigin(origin);
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new PxProxyError('invalid proxy redirect budget', { status: 500, code: 'PX_PROXY_CONFIG_INVALID' });
  }
  let target = sameOriginUrl(initialUrl, expectedOrigin, expectedOrigin);
  let redirects = 0;
  for (;;) {
    let response;
    try {
      response = await fetchImpl(target.href, {
        headers,
        redirect: 'manual',
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw new PxProxyError('proxy request timed out', { status: 504, code: 'PX_PROXY_TIMEOUT', cause });
      throw new PxProxyError('proxy request failed', { code: 'PX_PROXY_FETCH_FAILED', cause });
    }
    const location = response.headers.get('location');
    if (!REDIRECT_STATUS.has(response.status) || !location) return { response, finalUrl: target.href, redirects };
    if (redirects >= maxRedirects) {
      try { await response.body?.cancel(); } catch {}
      throw new PxProxyError('too many proxy redirects', { code: 'PX_PROXY_TOO_MANY_REDIRECTS' });
    }
    target = sameOriginUrl(location, expectedOrigin, target);
    redirects += 1;
    try { await response.body?.cancel(); } catch {}
  }
}

export function pxResponseHeaders(upstream) {
  const headers = new Headers();
  const source = upstream?.headers ?? upstream;
  for (const [name, value] of source) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

export async function readPxResponseBody(response, { maxBytes = PX_PROXY_LIMITS.maxResponseBytes, signal } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) {
    throw new PxProxyError('invalid proxy response budget', { status: 500, code: 'PX_PROXY_CONFIG_INVALID' });
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw new PxProxyError('proxy response too large', { code: 'PX_PROXY_RESPONSE_TOO_LARGE' });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const abort = () => { reader.cancel('proxy timeout').catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new PxProxyError('proxy response timed out', { status: 504, code: 'PX_PROXY_TIMEOUT' });
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel('response budget exceeded'); } catch {}
        throw new PxProxyError('proxy response too large', { code: 'PX_PROXY_RESPONSE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(value));
    }
  } catch (cause) {
    if (signal?.aborted) throw new PxProxyError('proxy response timed out', { status: 504, code: 'PX_PROXY_TIMEOUT', cause });
    throw cause;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}
