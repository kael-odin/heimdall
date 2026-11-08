import { gunzipSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { canonUrl } from '../url-canon.mjs';
import { UA } from '../ua.mjs';

export const DEFAULT_SITEMAP_LIMITS = Object.freeze({
  maxFiles: 100,
  maxUrls: 10_000,
  maxDepth: 8,
  maxDocumentBytes: 5 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxDurationMs: 90_000,
});

function parseSitemap(body, contentType) {
  const text = body.replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('<') && /text\/plain/i.test(contentType)) {
    const locs = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (locs.some(loc => !/^https?:\/\//i.test(loc))) return { kind: 'unknown', locs: [] };
    return { kind: 'pages', locs };
  }
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const locs = [];
  let kind = 'unknown', entryName = '', namespace = '', entry = null, loc = null, invalid = false;
  parser.on('opentag', node => {
    stack.push(node.local);
    if (stack.length === 1) {
      namespace = node.uri;
      if (namespace === '' || namespace === 'http://www.sitemaps.org/schemas/sitemap/0.9') {
        if (node.local === 'sitemapindex') { kind = 'indexes'; entryName = 'sitemap'; }
        if (node.local === 'urlset') { kind = 'pages'; entryName = 'url'; }
      }
    } else if (stack.length === 2 && kind !== 'unknown') {
      if (node.local === entryName && node.uri === namespace) entry = { locCount: 0 };
      else invalid = true;
    } else if (stack.length === 3 && entry && node.local === 'loc' && node.uri === namespace) {
      loc = '';
    } else if (loc !== null) invalid = true;
  });
  const append = value => {
    if (loc !== null) loc += value;
    else if (kind !== 'unknown' && stack.length <= 2 && value.trim()) invalid = true;
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', node => {
    if (stack.length === 3 && entry && node.local === 'loc' && loc !== null) {
      entry.locCount++;
      if (loc.trim()) locs.push(loc.trim());
      else invalid = true;
      loc = null;
    }
    if (stack.length === 2 && entry && node.local === entryName) {
      if (entry.locCount !== 1) invalid = true;
      entry = null;
    }
    stack.pop();
  });
  try { parser.write(text).close(); } catch { return { kind: 'unknown', locs: [] }; }
  return invalid ? { kind: 'unknown', locs: [] } : { kind, locs };
}

async function readBounded(response, maxBytes, onBytes) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      onBytes(value.byteLength);
      if (bytes > maxBytes) {
        const error = new Error('sitemap response exceeds byte limit');
        error.code = 'byte-limit';
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, bytes);
}

function decodeBody(bytes, maxBytes) {
  const body = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes, { maxOutputLength: maxBytes }) : bytes;
  if (body.length > maxBytes) {
    const error = new Error('sitemap document exceeds byte limit');
    error.code = 'byte-limit';
    throw error;
  }
  if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(body.subarray(2));
  if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(body.subarray(2));
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

/** Discover page URLs from robots.txt and bounded, same-origin sitemap trees. */
export async function discoverSitemapUrls(origin, { fetchImpl = fetch, limits = {} } = {}) {
  const siteOrigin = new URL(origin).origin;
  const budget = { ...DEFAULT_SITEMAP_LIMITS, ...limits };
  const truncated = new Set();
  const stats = {
    robotsStatus: null, robotsSitemaps: 0,
    sitemapFilesAttempted: 0, sitemapFilesRead: 0, sitemapFilesFailed: 0,
    declaredSitemapFailures: 0, validSitemapFiles: 0,
    offOriginSitemaps: 0, offOriginPages: 0,
    unknownFormats: 0, bytesRead: 0, truncated: [], limits: budget,
  };
  const robots = { ok: false, status: null, sitemaps: [] };
  const reasons = new Set();
  const pages = new Set();
  const queue = [];
  const queued = new Set();
  const deadline = Date.now() + budget.maxDurationMs;

  function sameOrigin(value, base) {
    try {
      const url = new URL(value, base);
      if (!/^https?:$/.test(url.protocol) || url.origin !== siteOrigin || url.username || url.password) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }

  async function request(url, maxBytes) {
    let current = url;
    for (let redirects = 0; redirects < 6; redirects++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { truncated.add('time-limit'); return { reason: 'time-limit' }; }
      if (stats.bytesRead >= budget.maxTotalBytes) { truncated.add('total-byte-limit'); return { reason: 'total-byte-limit' }; }
      const response = await fetchImpl(current, {
        headers: { 'User-Agent': UA }, redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const next = sameOrigin(response.headers.get('location'), current);
        await response.body?.cancel().catch(() => {});
        if (!next) { stats.offOriginSitemaps++; reasons.add('cross-origin-sitemap'); return { reason: 'cross-origin-sitemap' }; }
        current = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return { status: response.status }; }
      const available = Math.min(maxBytes, budget.maxTotalBytes - stats.bytesRead);
      if (available <= 0) { truncated.add('total-byte-limit'); return { reason: 'total-byte-limit' }; }
      let bytes;
      try {
        bytes = await readBounded(response, available, size => { stats.bytesRead += size; });
        return { status: response.status, body: decodeBody(bytes, maxBytes), contentType: response.headers.get('content-type') ?? '', finalUrl: current };
      } catch (error) {
        if (error.code === 'byte-limit' || error.code === 'ERR_BUFFER_TOO_LARGE') {
          truncated.add(available < maxBytes ? 'total-byte-limit' : 'document-byte-limit');
        }
        throw error;
      }
    }
    return { reason: 'redirect-limit' };
  }

  function enqueue(value, base, depth, declared = true) {
    const url = sameOrigin(value, base);
    if (!url) { stats.offOriginSitemaps++; reasons.add('cross-origin-sitemap'); return; }
    if (queued.has(url)) return;
    if (depth > budget.maxDepth) { truncated.add('depth-limit'); return; }
    if (queued.size >= budget.maxFiles) { truncated.add('file-limit'); return; }
    queued.add(url);
    queue.push({ url, depth, declared });
  }

  try {
    const response = await request(siteOrigin + '/robots.txt', Math.min(budget.maxDocumentBytes, 512 * 1024));
    stats.robotsStatus = robots.status = response.status ?? null;
    robots.ok = response.body !== undefined && !/^\s*(?:<!doctype\s+html|<html\b)/i.test(response.body);
    if (robots.ok) {
      for (const line of response.body.split(/\r?\n/)) {
        const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
        if (!match) continue;
        stats.robotsSitemaps++;
        robots.sitemaps.push(match[1]);
        enqueue(match[1], response.finalUrl, 0);
      }
    } else if (response.status !== 404 && response.status !== 410) reasons.add('robots-unavailable');
  } catch { reasons.add('robots-unavailable'); }

  let fallbacksQueued = false;
  while (queue.length || !fallbacksQueued) {
    if (!queue.length) {
      fallbacksQueued = true;
      enqueue(siteOrigin + '/sitemap.xml', siteOrigin, 0, false);
      enqueue(siteOrigin + '/sitemap_index.xml', siteOrigin, 0, false);
      if (!queue.length) break;
    }
    if (stats.sitemapFilesAttempted >= budget.maxFiles) { truncated.add('file-limit'); break; }
    if (Date.now() >= deadline) { truncated.add('time-limit'); break; }
    if (pages.size >= budget.maxUrls) { truncated.add('url-limit'); break; }
    const { url, depth, declared } = queue.shift();
    stats.sitemapFilesAttempted++;
    let response;
    try { response = await request(url, budget.maxDocumentBytes); }
    catch {
      stats.sitemapFilesFailed++;
      if (declared) stats.declaredSitemapFailures++;
      reasons.add('sitemap-request-failed');
      continue;
    }
    if (response.body === undefined) {
      if (declared || (response.status !== 404 && response.status !== 410)) {
        stats.sitemapFilesFailed++;
        if (declared) stats.declaredSitemapFailures++;
        reasons.add('sitemap-request-failed');
      }
      continue;
    }
    stats.sitemapFilesRead++;
    let parsed;
    try { parsed = parseSitemap(response.body, response.contentType); }
    catch {
      stats.sitemapFilesFailed++;
      if (declared) stats.declaredSitemapFailures++;
      reasons.add('unknown-sitemap-format');
      continue;
    }
    if (parsed.kind === 'unknown') { stats.unknownFormats++; reasons.add('unknown-sitemap-format'); continue; }
    stats.validSitemapFiles++;
    if (parsed.kind === 'indexes') {
      for (const loc of parsed.locs) enqueue(loc, response.finalUrl, depth + 1);
      continue;
    }
    for (const loc of parsed.locs) {
      const page = sameOrigin(loc, response.finalUrl);
      if (!page) { stats.offOriginPages++; continue; }
      const canonical = canonUrl(page);
      if (pages.has(canonical)) continue;
      if (pages.size >= budget.maxUrls) { truncated.add('url-limit'); break; }
      pages.add(canonical);
    }
  }
  stats.truncated = [...truncated].sort();
  if (stats.truncated.length) reasons.add('budget-exhausted');
  const coverage = reasons.size ? (stats.validSitemapFiles ? 'partial' : 'unavailable')
    : (stats.validSitemapFiles ? 'complete' : 'not_found');
  stats.coverage = coverage;
  stats.reasons = [...reasons].sort();
  stats.urlCount = pages.size;
  return { urls: [...pages], stats, robots, coverage, reasons: stats.reasons };
}
