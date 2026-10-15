import { readFileSync } from 'node:fs';
import { runtimeServiceForUrl } from './third-party-services.mjs';
import { UA } from '../ua.mjs';

const MAX_SERVICES = 50;
const MAX_URLS = 200;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TIMEOUT_MS = 15_000;
const PRIVATE_QUERY_KEY = /auth|token|key|password|passwd|secret|session|cookie|csrf|xsrf|email|phone|address|user|account|customer|patient/i;
const ACCEPT_MIME = /^(?:application\/(?:json|octet-stream|javascript|ecmascript|x-javascript|wasm|font|vnd\.ms-fontobject|font-woff|x-font)|(?:image|font|audio|video)\/[a-z0-9.+-]+|text\/(?:plain|css|javascript|ecmascript))$/i;

export function parseRuntimeServiceCacheFile(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length > MAX_SERVICES || new Set(parsed).size !== parsed.length
    || parsed.some(id => typeof id !== 'string' || !/^(?:[a-z0-9-]+|external-[a-z0-9-]+)$/.test(id))) {
    throw new TypeError('invalid runtime service cache list');
  }
  return new Set(parsed);
}

export function validateRuntimeServiceCacheServices({ services, discoveredIds }) {
  if (!(services instanceof Set) || !(discoveredIds instanceof Set)) {
    throw new TypeError('runtime service sets must be Sets');
  }
  const missing = [...services].filter(id => !discoveredIds.has(id));
  if (missing.length) throw new RangeError('undiscovered-runtime-service');
}

export function collectRuntimeServiceCacheUrls({ harEntries = [], services = new Set() } = {}) {
  if (!(services instanceof Set)) throw new TypeError('services must be a Set');
  const urls = new Set();
  for (const entry of harEntries ?? []) {
    const url = String(entry?.request?.url ?? '');
    const method = String(entry?.request?.method ?? '').toUpperCase();
    const status = Number(entry?.response?.status ?? 0);
    const service = runtimeServiceForUrl(url);
    if (!service || !services.has(service.id) || method !== 'GET'
      || (![200, 301, 302, 303, 307, 308].includes(status))) continue;
    // Iconify exposes equivalent JSON APIs on three mirror hosts, and its runtime
    // randomly selects one. Cache the observed safe GET on every mirror so an
    // offline run cannot fail merely because it selected the unsampled host.
    const variants = service.id === 'iconify'
      ? service.hosts.map(serviceHost => {
        const mirror = new URL(url);
        mirror.host = serviceHost;
        return mirror.href;
      })
      : [url];
    for (const variant of variants) {
      urls.add(variant);
      if (urls.size > MAX_URLS) throw new RangeError('runtime service cache URL limit exceeded');
    }
  }
  return urls;
}

function safeRuntimeUrl(value, service) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || url.href.length > 2048 || !service.hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
  for (const [key, rawValue] of url.searchParams) {
    if (!/^[a-z][a-z0-9_.-]{0,39}$/i.test(key) || PRIVATE_QUERY_KEY.test(key)
      || rawValue.length > 200 || /[\u0000-\u001f@]/.test(rawValue)) return null;
  }
  return url;
}

async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { body: Buffer.alloc(0), readBytes: 0 };
  const chunks = [];
  let readBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      readBytes += value.byteLength;
      if (readBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* The size failure is already decisive. */ }
        return { body: null, readBytes };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { body: Buffer.concat(chunks, readBytes), readBytes };
}

async function fetchRuntimeUrl(rawUrl, service, limits, fetchImpl) {
  const url = safeRuntimeUrl(rawUrl, service);
  if (!url) return { reason: 'unsafe-url' };
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let response;
    try {
      response = await fetchImpl(current.href, {
        headers: { 'user-agent': UA, accept: '*/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
    } catch {
      return { reason: 'network-error' };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      try { await response.body?.cancel(); } catch { /* The redirect body is unused. */ }
      if (redirects === MAX_REDIRECTS) return { reason: 'redirect-limit' };
      const location = response.headers.get('location');
      if (!location?.trim()) return { reason: 'invalid-redirect' };
      const next = safeRuntimeUrl(new URL(location, current), service);
      if (!next) return { reason: 'unsafe-redirect' };
      current = next;
      continue;
    }
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* The failure body is unused. */ }
      return { reason: 'http-' + response.status };
    }
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!mimeType || !ACCEPT_MIME.test(mimeType)) {
      try { await response.body?.cancel(); } catch { /* The rejected body is unused. */ }
      return { reason: 'unsafe-mime' };
    }
    const remaining = limits.maxTotalBytes - limits.transferBytes;
    if (remaining <= 0) return { reason: 'budget-exhausted' };
    const received = await readBounded(response, Math.min(limits.maxAssetBytes, remaining));
    limits.transferBytes += received.readBytes;
    if (!received.body?.length) return { reason: received.body ? 'empty-body' : 'too-large', readBytes: received.readBytes };
    return { body: received.body, mimeType, readBytes: received.readBytes };
  }
  return { reason: 'redirect-limit' };
}

/** Fetch explicitly approved runtime-service responses for offline replay/localization. */
export async function fetchRuntimeServiceCache({
  urls = new Set(), fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  if (!(urls instanceof Set) || urls.size > MAX_URLS) throw new TypeError('invalid runtime service cache URLs');
  const report = {
    requested: urls.size, fetched: 0, failed: 0, bytes: 0, transferBytes: 0,
    failures: [], entries: [],
  };
  const limits = {
    maxAssetBytes: MAX_ASSET_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    transferBytes: 0,
    timeoutMs: Math.min(Math.max(Number(timeoutMs) || 10_000, 1_000), MAX_TIMEOUT_MS),
  };
  for (const rawUrl of urls) {
    const service = runtimeServiceForUrl(rawUrl);
    if (!service) {
      report.failed++;
      report.failures.push({ url: new URL(rawUrl).origin, reason: 'unknown-service' });
      continue;
    }
    const result = await fetchRuntimeUrl(rawUrl, service, limits, fetchImpl);
    report.transferBytes += result.readBytes ?? 0;
    if (!result.body) {
      report.failed++;
      report.failures.push({ url: new URL(rawUrl).origin, reason: result.reason });
      continue;
    }
    report.fetched++;
    report.bytes += result.body.length;
    report.entries.push({
      method: 'GET', url: rawUrl, status: 200, mimeType: result.mimeType,
      headers: {}, body: result.body.toString('base64'), bodyEncoding: 'base64',
      kind: 'runtime-service-cache',
    });
  }
  return report;
}
