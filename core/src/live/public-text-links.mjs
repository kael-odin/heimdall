import { linkSync, lstatSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { UA } from '../ua.mjs';

const FEED_EXTENSIONS = new Set(['.rss', '.atom', '.xml']);
const EXPECTED_MIMES = new Map([
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.markdown', 'text/markdown'],
  ['.rss', 'application/rss+xml'], ['.atom', 'application/atom+xml'], ['.xml', 'application/xml'],
]);
const decoder = new TextDecoder('utf-8', { fatal: true });
const bounded = (value, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
const PRIVATE_SEGMENT = /^(?:api|auth|login|admin|private|users?|accounts?|members?|profiles?|customers?|patients?|orders?|invoices?|sessions?|tokens?|secrets?|credentials?|config|\.git|\.env)$/i;

function extensionOf(pathname) {
  return /\.(?:rss|atom|xml|md|markdown|txt)$/i.exec(pathname)?.[0].toLowerCase() ?? null;
}

function targetUrl(value, origin) {
  if (typeof value !== 'string' || value.includes('\\')) return null;
  let url;
  try { url = new URL(value, origin); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || url.hash || url.search || !extensionOf(url.pathname)) return null;
  const parts = url.pathname.split('/');
  for (const [index, part] of parts.entries()) {
    if (/%(?:2f|5c|2e|00|25|3f|23)/i.test(part)) return null;
    let decoded = part;
    try { decoded = decodeURIComponent(decodeURIComponent(decoded)); } catch { return null; }
    if (/[\\/\u0000]/.test(decoded) || decoded === '.' || decoded === '..') return null;
    const name = index === parts.length - 1 ? decoded.replace(/\.(?:rss|atom|xml|md|markdown|txt)$/i, '') : decoded;
    if (PRIVATE_SEGMENT.test(name)) return null;
  }
  return url;
}

function localFile(liveDir, pathname) {
  const file = resolve(liveDir, pathname.slice(1));
  const rel = relative(liveDir, file);
  return rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel) ? file : null;
}

function regularParents(liveDir, file) {
  let parent = resolve(liveDir);
  const parts = relative(parent, dirname(file)).split(/[\\/]/).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) parent = join(parent, part);
    try {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if (error?.code !== 'ENOENT' || !part) return false;
    }
  }
  return true;
}

function acceptedText(pathname, mime, body) {
  const extension = extensionOf(pathname);
  if (!extension || mime !== EXPECTED_MIMES.get(extension) || !body.length) return false;
  let text;
  try { text = decoder.decode(body).replace(/^\uFEFF/, ''); } catch { return false; }
  if (/^\s*(?:<!doctype\s+html|<html\b|<body\b)/i.test(text)) return false;
  if (!FEED_EXTENSIONS.has(extension)) return !/\u0000/.test(text);
  return /^(?:\s*<\?xml[^>]*>\s*)?(?:\s*<!--[\s\S]*?-->\s*)*<(?:rss|feed)\b/i.test(text);
}

async function limitedBody(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* Ignore cancelled or exhausted bodies. */ }
  }
}

/** Capture only scanner-observed public text links; result contains counts, never URLs. */
export async function capturePublicTextLinks({
  liveDir, origin, targets = [], fetchImpl = globalThis.fetch,
  maxTargets = 32, maxFileBytes = 512 * 1024, maxTotalBytes = 4 * 1024 * 1024,
  maxRedirects = 3, timeoutMs = 10_000, maxWallMs = 60_000,
} = {}) {
  const base = new URL(origin).origin;
  maxTargets = bounded(maxTargets, 32);
  maxFileBytes = bounded(maxFileBytes, 512 * 1024);
  maxTotalBytes = bounded(maxTotalBytes, 4 * 1024 * 1024);
  maxRedirects = bounded(maxRedirects, 3);
  timeoutMs = bounded(timeoutMs, 10_000);
  maxWallMs = bounded(maxWallMs, 60_000);
  const deadline = Date.now() + maxWallMs;
  const eligible = new Map();
  for (const raw of targets) {
    const url = targetUrl(raw, base);
    if (url) eligible.set(url.href, url);
  }
  const result = { eligible: eligible.size, attempted: 0, captured: 0, rejected: 0, bytes: 0,
    limited: eligible.size > maxTargets };
  for (const url of [...eligible.values()].slice(0, maxTargets)) {
    if (result.bytes >= maxTotalBytes || Date.now() >= deadline) { result.limited = true; break; }
    const file = localFile(liveDir, url.pathname);
    if (!file || !regularParents(liveDir, file)) { result.rejected++; continue; }
    try { if (statSync(file).isFile()) continue; } catch { /* Missing file is expected. */ }
    result.attempted++;
    let current = url;
    let response = null;
    try {
      const signal = AbortSignal.timeout(Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
      for (let redirect = 0; redirect <= maxRedirects; redirect++) {
        response = await fetchImpl(current.href, {
          method: 'GET', redirect: 'manual', signal,
          headers: { 'user-agent': UA, accept: 'text/plain, text/markdown, application/rss+xml, application/atom+xml, application/xml;q=0.9', referer: base + '/' },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        const next = location ? targetUrl(new URL(location, current).href, base) : null;
        await response.body?.cancel();
        response = null;
        if (!next || redirect === maxRedirects) break;
        current = next;
      }
      const mime = response?.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
      const finalUrl = response?.url ? targetUrl(response.url, base) : current;
      const cacheControl = response?.headers.get('cache-control') ?? '';
      const vary = response?.headers.get('vary') ?? '';
      if (response?.status !== 200 || !finalUrl
        || response.headers.has('set-cookie') || /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(cacheControl)
        || /(?:^|,)\s*\*/.test(vary) || /\b(?:cookie|authorization)\b/i.test(vary)
        || mime !== EXPECTED_MIMES.get(extensionOf(url.pathname))) {
        result.rejected++;
        await response?.body?.cancel();
        continue;
      }
      const body = await limitedBody(response, Math.min(maxFileBytes, maxTotalBytes - result.bytes));
      if (!body || !acceptedText(url.pathname, mime, body)) { result.rejected++; continue; }
      mkdirSync(dirname(file), { recursive: true });
      if (!regularParents(liveDir, file)) { result.rejected++; continue; }
      const temporary = join(dirname(file), '.heimdall-public-text-' + randomBytes(8).toString('hex') + '.tmp');
      try {
        writeFileSync(temporary, body, { flag: 'wx' });
        if (!regularParents(liveDir, file)) throw new Error('candidate directory changed');
        linkSync(temporary, file);
      } finally {
        try { unlinkSync(temporary); } catch { /* The temporary file may never have been created. */ }
      }
      result.captured++;
      result.bytes += body.length;
    } catch {
      result.rejected++;
      try { await response?.body?.cancel(); } catch { /* Request already failed. */ }
    }
  }
  return result;
}
