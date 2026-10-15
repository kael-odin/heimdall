import { gunzipSync } from 'node:zlib';
import { parseFragment } from 'parse5';
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

function localName(node) {
  return String(node?.tagName ?? '').split(':').at(-1);
}

function children(node, name) {
  return (node?.childNodes ?? []).filter(child => localName(child) === name);
}

function elementText(node) {
  return (node?.childNodes ?? []).map(child => {
    if (child.nodeName === '#text') return child.value;
    // parse5 represents XML CDATA as a comment in HTML parsing mode.
    if (child.nodeName === '#comment' && /^\[CDATA\[[\s\S]*\]\]$/.test(child.data ?? '')) {
      return child.data.slice(7, -2);
    }
    return '';
  }).join('').trim();
}

function parseSitemap(body, contentType) {
  const text = body.replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('<') && /text\/plain/i.test(contentType)) {
    return { kind: 'pages', locs: text.split(/\r?\n/).map(line => line.trim()).filter(Boolean) };
  }
  const document = parseFragment(text);
  const root = document.childNodes?.find(node => node.tagName);
  const kind = localName(root);
  if (kind === 'sitemapindex') {
    return { kind: 'indexes', locs: children(root, 'sitemap').map(node => elementText(children(node, 'loc')[0])).filter(Boolean) };
  }
  if (kind === 'urlset') {
    return { kind: 'pages', locs: children(root, 'url').map(node => elementText(children(node, 'loc')[0])).filter(Boolean) };
  }
  return { kind: 'unknown', locs: [] };
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
  if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder('utf-16le').decode(body.subarray(2));
  if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be').decode(body.subarray(2));
  return new TextDecoder('utf-8').decode(body);
}

/** Discover page URLs from robots.txt and bounded, same-origin sitemap trees. */
export async function discoverSitemapUrls(origin, { fetchImpl = fetch, limits = {} } = {}) {
  const siteOrigin = new URL(origin).origin;
  const budget = { ...DEFAULT_SITEMAP_LIMITS, ...limits };
  const truncated = new Set();
  const stats = {
    robotsStatus: null, robotsSitemaps: 0,
    sitemapFilesAttempted: 0, sitemapFilesRead: 0, sitemapFilesFailed: 0,
    declaredSitemapFailures: 0,
    offOriginSitemaps: 0, offOriginPages: 0,
    unknownFormats: 0, bytesRead: 0, truncated: [], limits: budget,
  };
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
      if (remaining <= 0) { truncated.add('time-limit'); return null; }
      if (stats.bytesRead >= budget.maxTotalBytes) { truncated.add('total-byte-limit'); return null; }
      const response = await fetchImpl(current, {
        headers: { 'User-Agent': UA }, redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const next = sameOrigin(response.headers.get('location'), current);
        await response.body?.cancel().catch(() => {});
        if (!next) { stats.offOriginSitemaps++; return null; }
        current = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return { status: response.status }; }
      const available = Math.min(maxBytes, budget.maxTotalBytes - stats.bytesRead);
      if (available <= 0) { truncated.add('total-byte-limit'); return null; }
      let bytes;
      try {
        bytes = await readBounded(response, available, size => { stats.bytesRead += size; });
        return { status: response.status, body: decodeBody(bytes, maxBytes), contentType: response.headers.get('content-type') ?? '' };
      } catch (error) {
        if (error.code === 'byte-limit' || error.code === 'ERR_BUFFER_TOO_LARGE') {
          truncated.add(available < maxBytes ? 'total-byte-limit' : 'document-byte-limit');
        }
        throw error;
      }
    }
    stats.sitemapFilesFailed++;
    return null;
  }

  function enqueue(value, base, depth, declared = true) {
    const url = sameOrigin(value, base);
    if (!url) { stats.offOriginSitemaps++; return; }
    if (queued.has(url)) return;
    if (depth > budget.maxDepth) { truncated.add('depth-limit'); return; }
    if (queued.size >= budget.maxFiles) { truncated.add('file-limit'); return; }
    queued.add(url);
    queue.push({ url, depth, declared });
  }

  try {
    const robots = await request(siteOrigin + '/robots.txt', Math.min(budget.maxDocumentBytes, 512 * 1024));
    stats.robotsStatus = robots?.status ?? null;
    if (robots?.body) {
      for (const line of robots.body.split(/\r?\n/)) {
        const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
        if (!match) continue;
        stats.robotsSitemaps++;
        enqueue(match[1], siteOrigin + '/robots.txt', 0);
      }
    }
  } catch { stats.sitemapFilesFailed++; }

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
      continue;
    }
    if (!response?.body) {
      if (declared && response?.status >= 400) {
        stats.sitemapFilesFailed++;
        stats.declaredSitemapFailures++;
      }
      continue;
    }
    stats.sitemapFilesRead++;
    let parsed;
    try { parsed = parseSitemap(response.body, response.contentType); }
    catch {
      stats.sitemapFilesFailed++;
      if (declared) stats.declaredSitemapFailures++;
      continue;
    }
    if (parsed.kind === 'unknown') { stats.unknownFormats++; continue; }
    if (parsed.kind === 'indexes') {
      for (const loc of parsed.locs) enqueue(loc, url, depth + 1);
      continue;
    }
    for (const loc of parsed.locs) {
      const page = sameOrigin(loc, url);
      if (!page) { stats.offOriginPages++; continue; }
      const canonical = canonUrl(page);
      if (pages.has(canonical)) continue;
      if (pages.size >= budget.maxUrls) { truncated.add('url-limit'); break; }
      pages.add(canonical);
    }
  }
  stats.truncated = [...truncated].sort();
  return { urls: [...pages], stats };
}
