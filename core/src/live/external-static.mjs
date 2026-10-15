import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parse } from 'parse5';
import { scanCssRefs, rewriteCssRefs } from '../css-refs.mjs';
import { UA } from '../ua.mjs';
import { localizeQueryEntries } from './heal.mjs';

const MAX_SCAN_FILES = 4_000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_APPROVED_URLS = 50;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TIMEOUT_MS = 15_000;
const PRIVATE_QUERY_KEY = /auth|token|key|password|passwd|secret|session|cookie|csrf|xsrf|email|phone|address|user|account|customer|patient/i;
const SERVICE_HOSTS = ['carbonads.com', 'carbonads.net'];
const MIME_BY_KIND = {
  script: new Set(['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript']),
  style: new Set(['text/css']),
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']),
  media: new Set(['video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm']),
  font: new Set(['font/woff', 'font/woff2', 'font/ttf', 'font/otf', 'application/vnd.ms-fontobject']),
};
const CSS_RESOURCE_MIME = new Set([...MIME_BY_KIND.style, ...MIME_BY_KIND.image,
  ...MIME_BY_KIND.media, ...MIME_BY_KIND.font]);
const EXT_MIME = new Map([
  ['.js', MIME_BY_KIND.script], ['.mjs', MIME_BY_KIND.script], ['.css', MIME_BY_KIND.style],
  ['.png', new Set(['image/png'])], ['.jpg', new Set(['image/jpeg'])], ['.jpeg', new Set(['image/jpeg'])],
  ['.gif', new Set(['image/gif'])], ['.webp', new Set(['image/webp'])], ['.avif', new Set(['image/avif'])],
  ['.bmp', new Set(['image/bmp'])], ['.ico', new Set(['image/x-icon', 'image/vnd.microsoft.icon'])],
  ['.woff', new Set(['font/woff'])], ['.woff2', new Set(['font/woff2'])],
  ['.ttf', new Set(['font/ttf'])], ['.otf', new Set(['font/otf'])],
  ['.eot', new Set(['application/vnd.ms-fontobject'])],
  ['.mp4', new Set(['video/mp4'])], ['.webm', new Set(['video/webm'])],
  ['.m4a', new Set(['audio/mp4'])], ['.weba', new Set(['audio/webm'])],
  ['.mp3', new Set(['audio/mpeg'])], ['.ogg', new Set(['audio/ogg'])],
  ['.oga', new Set(['audio/ogg'])], ['.wav', new Set(['audio/wav'])],
]);

function boundedOption(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`invalid ${name}`);
  return value;
}

function prohibitedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return SERVICE_HOSTS.some(service => host === service || host.endsWith('.' + service));
}

function safePublicUrl(value, sourceOrigin) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin === sourceOrigin || url.username || url.password || url.hash || url.port
    || url.href.length > 2_048 || !/^[a-z0-9.-]+$/i.test(url.hostname)
    || !url.hostname.includes('.') || url.hostname.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
    || /(?:^|\.)\d+(?:\.\d+){3}$/.test(url.hostname) || prohibitedHost(url.hostname)) return null;
  for (const [key, val] of url.searchParams) {
    if (!/^[a-z][a-z0-9_.-]{0,39}$/i.test(key) || PRIVATE_QUERY_KEY.test(key)
      || val.length > 200 || /[\u0000-\u001f@]/.test(val) || /^(?:https?:)?\/\//i.test(val)) return null;
  }
  return url;
}

function expectedMime(kind, mime) {
  if (kind === 'css-resource') return CSS_RESOURCE_MIME.has(mime);
  return MIME_BY_KIND[kind]?.has(mime) ?? false;
}

function allowedPathExtension(url, kinds) {
  const ext = extname(url.pathname).toLowerCase();
  if (!ext) return true;
  const mimes = EXT_MIME.get(ext);
  return !!mimes && [...kinds].every(kind => [...mimes].some(mime => expectedMime(kind, mime)));
}

function safeMime(response, url, kinds) {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mime || ![...kinds].every(kind => expectedMime(kind, mime))) return null;
  const ext = extname(url.pathname).toLowerCase();
  if (ext && (!EXT_MIME.has(ext) || !EXT_MIME.get(ext).has(mime))) return null;
  return mime;
}

function addRef(refs, raw, base, sourceOrigin, kind) {
  if (typeof raw !== 'string' || !raw.trim() || /^(?:data:|blob:|about:|javascript:|#)/i.test(raw.trim())) return;
  if (/^\/lm\/[^/]+\/_ext\//.test(raw.trim())) return;
  let url;
  try { url = new URL(raw.trim(), base); } catch { return; }
  if (url.origin === sourceOrigin || url.protocol !== 'https:') return;
  const kinds = refs.get(url.href) ?? new Set();
  kinds.add(kind);
  refs.set(url.href, kinds);
}

function cssRefs(refs, css, base, sourceOrigin) {
  for (const token of scanCssRefs(css)) addRef(refs, token.raw, base, sourceOrigin, 'css-resource');
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) {
    addRef(refs, match[1], base, sourceOrigin, 'style');
  }
}

function staticAttributes(tag, attrs, parent) {
  if (tag === 'script') return [['src', 'script']];
  if (tag === 'link') {
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const as = (attrs.get('as') ?? '').toLowerCase();
    const kind = rel.includes('stylesheet') ? 'style'
      : rel.includes('icon') ? 'image'
        : rel.includes('modulepreload') || (rel.includes('preload') && as === 'script') ? 'script'
          : rel.includes('preload') && as === 'style' ? 'style'
            : rel.includes('preload') && as === 'font' ? 'font'
              : rel.includes('preload') && as === 'image' ? 'image'
                : rel.includes('preload') && ['audio', 'video'].includes(as) ? 'media' : null;
    return kind ? [['href', kind]] : [];
  }
  if (tag === 'img') return [['src', 'image'], ['srcset', 'image', true]];
  if (tag === 'source') {
    const kind = parent === 'picture' ? 'image' : 'media';
    return [['src', kind], ['srcset', kind, true]];
  }
  if (tag === 'video') return [['src', 'media'], ['poster', 'image']];
  if (tag === 'audio') return [['src', 'media']];
  if (tag === 'input' && (attrs.get('type') ?? '').toLowerCase() === 'image') return [['src', 'image']];
  return [];
}

function htmlRefs(refs, html, base, sourceOrigin) {
  const walk = (node, parent = '') => {
    const tag = node.tagName ?? '';
    const attrs = new Map((node.attrs ?? []).map(attr => [attr.name.toLowerCase(), attr.value]));
    for (const [name, kind, srcset] of staticAttributes(tag, attrs, parent)) {
      if (srcset) {
        for (const item of (attrs.get(name) ?? '').split(',')) {
          addRef(refs, item.trim().split(/\s+/)[0], base, sourceOrigin, kind);
        }
      } else addRef(refs, attrs.get(name), base, sourceOrigin, kind);
    }
    if (attrs.has('style')) cssRefs(refs, attrs.get('style'), base, sourceOrigin);
    if (tag === 'style') {
      const css = (node.childNodes ?? []).map(child => child.value ?? '').join('');
      cssRefs(refs, css, base, sourceOrigin);
    }
    for (const child of node.childNodes ?? []) walk(child, tag || parent);
    if (node.content) walk(node.content, tag || parent);
  };
  walk(parse(html));
}

function discoverRefs(liveDir, staticDir, origin, cssSources) {
  const refs = new Map();
  const sourceOrigin = new URL(origin).origin;
  let files = 0;
  let bytes = 0;
  const walk = (dir, root) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('external asset scan refuses symlinks');
      if (stat.isDirectory()) { walk(file, root); continue; }
      if (!stat.isFile() || !/\.(?:html?|css)$/i.test(name)) continue;
      if (++files > MAX_SCAN_FILES || (bytes += stat.size) > MAX_SCAN_BYTES) {
        throw new Error('external asset scan limit exceeded');
      }
      const rel = relative(root, file).replaceAll('\\', '/');
      const base = cssSources.get(file) ?? new URL('/' + rel.replace(/index\.html?$/i, ''), origin).href;
      const content = readFileSync(file, 'utf8');
      if (/\.css$/i.test(name)) cssRefs(refs, content, base, sourceOrigin);
      else htmlRefs(refs, content, base, sourceOrigin);
    }
  };
  walk(liveDir, liveDir);
  if (staticDir) walk(staticDir, staticDir);
  return refs;
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) return { body: null, readBytes: 0 };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* The budget failure is already decisive. */ }
        return { body: null, readBytes: size };
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return { body: Buffer.concat(chunks, size), readBytes: size };
}

async function fetchStatic(url, kinds, { fetchImpl, timeoutMs, maxRedirects, maxBytes }, sourceOrigin) {
  let current = url;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    let response;
    try {
      response = await fetchImpl(current.href, {
        headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { reason: 'network-error' }; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === maxRedirects) {
        try { await response.body?.cancel(); } catch { /* The response is unused. */ }
        return { reason: 'redirect-limit' };
      }
      const location = response.headers.get('location');
      if (!location?.trim()) {
        try { await response.body?.cancel(); } catch { /* The response is unused. */ }
        return { reason: 'invalid-redirect' };
      }
      let next;
      try { next = new URL(location, current); } catch { return { reason: 'invalid-redirect' }; }
      try { await response.body?.cancel(); } catch { /* The redirect response body is not used. */ }
      if (next.origin !== url.origin || !safePublicUrl(next.href, sourceOrigin)) return { reason: 'unsafe-redirect' };
      current = next;
      continue;
    }
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* The response is unused. */ }
      return { reason: 'http-status' };
    }
    const mimeType = safeMime(response, current, kinds);
    if (!mimeType) {
      try { await response.body?.cancel(); } catch { /* The response is unused. */ }
      return { reason: 'unsafe-mime' };
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      try { await response.body?.cancel(); } catch { /* The response is unused. */ }
      return { reason: 'too-large' };
    }
    let received;
    try { received = await readBoundedBody(response, maxBytes); }
    catch { return { reason: 'network-error' }; }
    const { body, readBytes } = received;
    if (!body?.length) return { reason: body ? 'empty-body' : 'too-large', readBytes };
    const leadingText = body.subarray(0, 8_192).toString('utf8').trimStart()
      .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
    if (/^<(?:!doctype\b|[a-z][\w:-]*\b)/i.test(leadingText)) {
      return { reason: 'html-fallback', readBytes };
    }
    return { body, mimeType, readBytes, finalUrl: current.href };
  }
  return { reason: 'redirect-limit' };
}

function localUrl(raw, base, urlMap) {
  try { return urlMap.get(new URL(raw, base).href) ?? null; }
  catch { return null; }
}

function rewriteCssText(css, base, urlMap) {
  const replacements = new Map();
  let hits = 0;
  for (const token of scanCssRefs(css)) {
    const local = localUrl(token.raw, base, urlMap);
    if (local) { replacements.set(token.raw, local); hits++; }
  }
  const text = rewriteCssRefs(css, replacements).replace(/(@import\s+["'])([^"']+)(["'])/gi,
    (match, before, raw, after) => {
      const local = localUrl(raw, base, urlMap);
      if (!local) return match;
      hits++;
      return before + local + after;
    });
  return { text, hits };
}

function rewriteHtmlText(html, base, urlMap) {
  const ranges = [];
  let hits = 0;
  const escapeAttr = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const walk = (node, parent = '') => {
    const tag = node.tagName ?? '';
    const attrs = new Map((node.attrs ?? []).map(attr => [attr.name.toLowerCase(), attr.value]));
    const replaceAttr = (name, value, count) => {
      const location = node.sourceCodeLocation?.attrs?.[name];
      if (!location || !count || value === attrs.get(name)) return;
      ranges.push({ start: location.startOffset, end: location.endOffset,
        text: `${name}="${escapeAttr(value)}"` });
      hits += count;
    };
    for (const [name, , srcset] of staticAttributes(tag, attrs, parent)) {
      const raw = attrs.get(name);
      if (!raw) continue;
      if (!srcset) {
        const local = localUrl(raw, base, urlMap);
        if (local) replaceAttr(name, local, 1);
        continue;
      }
      let count = 0;
      const value = raw.split(',').map(item => item.replace(/^(\s*)(\S+)/, (part, space, url) => {
        const local = localUrl(url, base, urlMap);
        if (!local) return part;
        count++;
        return space + local;
      })).join(',');
      replaceAttr(name, value, count);
    }
    if (attrs.has('style')) {
      const changed = rewriteCssText(attrs.get('style'), base, urlMap);
      replaceAttr('style', changed.text, changed.hits);
    }
    if (tag === 'style') {
      for (const child of node.childNodes ?? []) {
        const location = child.sourceCodeLocation;
        if (child.nodeName !== '#text' || !location) continue;
        const original = html.slice(location.startOffset, location.endOffset);
        const changed = rewriteCssText(original, base, urlMap);
        if (changed.text === original) continue;
        ranges.push({ start: location.startOffset, end: location.endOffset, text: changed.text });
        hits += changed.hits;
      }
    }
    for (const child of node.childNodes ?? []) walk(child, tag || parent);
    if (node.content) walk(node.content, tag || parent);
  };
  walk(parse(html, { sourceCodeLocationInfo: true }));
  let text = html;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, range.start) + range.text + text.slice(range.end);
  }
  return { text, hits };
}

function rewriteCandidateStaticRefs(liveDir, staticDir, origin, cssSources, urlMap) {
  const out = { files: 0, rewrites: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (dir, root) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('external asset rewrite refuses symlinks');
      if (stat.isDirectory()) { walk(file, root); continue; }
      if (!stat.isFile() || !/\.(?:html?|css)$/i.test(name)) continue;
      if (++files > MAX_SCAN_FILES || (bytes += stat.size) > MAX_SCAN_BYTES) {
        throw new Error('external asset rewrite limit exceeded');
      }
      const rel = relative(root, file).replaceAll('\\', '/');
      const base = cssSources.get(file) ?? new URL('/' + rel.replace(/index\.html?$/i, ''), origin).href;
      const content = readFileSync(file, 'utf8');
      const changed = /\.css$/i.test(name)
        ? rewriteCssText(content, base, urlMap) : rewriteHtmlText(content, base, urlMap);
      if (changed.text === content) continue;
      writeFileSync(file + '.heimdall-tmp', changed.text);
      renameSync(file + '.heimdall-tmp', file);
      out.files++;
      out.rewrites += changed.hits;
    }
  };
  walk(liveDir, liveDir);
  if (staticDir) walk(staticDir, staticDir);
  return out;
}

function unrewrittenRuntimeRefs(liveDir, staticDir, urlMap, origin) {
  const variants = [...urlMap.keys()].map(url => [url, ...(origin.startsWith('https:')
    && url.startsWith('https:') ? [url.slice('https:'.length)] : [])]);
  const found = new Set();
  const containsExact = (text, url) => {
    let at = -1;
    while ((at = text.indexOf(url, at + 1)) !== -1) {
      const next = text[at + url.length];
      if (!next || !/[a-z0-9._~%/?#&=+\-:@]/i.test(next)) return true;
    }
    return false;
  };
  const check = text => {
    const normalized = text.replaceAll('\\/', '/');
    for (const [index, forms] of variants.entries()) {
      if (found.has(index)) continue;
      if (forms.some(url => containsExact(normalized, url))) found.add(index);
    }
  };
  let files = 0;
  let bytes = 0;
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('external runtime scan refuses symlinks');
      if (stat.isDirectory()) { walk(file); continue; }
      if (!stat.isFile() || !/\.(?:html?|[cm]?js)$/i.test(name)) continue;
      if (++files > MAX_SCAN_FILES || (bytes += stat.size) > MAX_SCAN_BYTES) {
        throw new Error('external runtime scan limit exceeded');
      }
      const text = readFileSync(file, 'utf8');
      if (!/\.html?$/i.test(name)) { check(text); continue; }
      const visit = node => {
        if (node.tagName === 'script') {
          for (const child of node.childNodes ?? []) if (typeof child.value === 'string') check(child.value);
        }
        for (const child of node.childNodes ?? []) visit(child);
        if (node.content) visit(node.content);
      };
      visit(parse(text));
    }
  };
  walk(liveDir);
  if (staticDir) walk(staticDir);
  return new Set([...found].map(index => [...urlMap.keys()][index]));
}

/** Opt-in, exact-URL capture for public external assets referenced by a candidate bundle. */
export async function localizeApprovedExternalStaticAssets({
  liveDir, staticDir = null, host, origin, approvedUrls = [], fetchImpl = globalThis.fetch,
  cssSources: knownCssSources = new Map(), maxAssetBytes, maxTotalBytes, maxRedirects, timeoutMs,
} = {}) {
  if (typeof liveDir !== 'string' || !liveDir || typeof host !== 'string' || !/^(?!\.\.?$)[a-z0-9.-]+$/i.test(host)
    || typeof origin !== 'string' || !origin || !Array.isArray(approvedUrls)
    || approvedUrls.length > MAX_APPROVED_URLS || approvedUrls.some(url => typeof url !== 'string')
    || new Set(approvedUrls).size !== approvedUrls.length || !(knownCssSources instanceof Map)) {
    throw new TypeError('invalid external asset capture input');
  }
  const sourceOrigin = new URL(origin).origin;
  const limits = {
    maxAssetBytes: boundedOption(maxAssetBytes, 5 * 1024 * 1024, 1, MAX_ASSET_BYTES, 'maxAssetBytes'),
    maxTotalBytes: boundedOption(maxTotalBytes, 32 * 1024 * 1024, 1, MAX_TOTAL_BYTES, 'maxTotalBytes'),
    maxRedirects: boundedOption(maxRedirects, 2, 0, MAX_REDIRECTS, 'maxRedirects'),
    timeoutMs: boundedOption(timeoutMs, 10_000, 1, MAX_TIMEOUT_MS, 'timeoutMs'),
  };
  const requested = approvedUrls;
  const report = { requested: requested.length, fetched: 0, failed: 0, bytes: 0, transferBytes: 0,
    failures: [], localized: 0, rewrittenFiles: 0, rewrites: 0, remainingExternal: 0 };
  const urlMap = new Map();
  const cssSources = new Map(knownCssSources);
  if (!requested.length) {
    report.remainingExternal = discoverRefs(liveDir, staticDir, sourceOrigin, cssSources).size;
    return { report, urlMap };
  }
  const processed = new Set();
  const failure = (index, reason) => { report.failed++; report.failures.push({ index, reason }); };
  let refs = discoverRefs(liveDir, staticDir, sourceOrigin, cssSources);
  for (let pass = 0; pass < requested.length; pass++) {
    let progressed = false;
    for (const [index, raw] of requested.entries()) {
      if (processed.has(raw) || !refs.has(raw)) continue;
      processed.add(raw);
      progressed = true;
      let candidate;
      try { candidate = new URL(raw); } catch { /* Invalid URLs fail below. */ }
      if (candidate && prohibitedHost(candidate.hostname)) { failure(index, 'prohibited-service'); continue; }
      const url = safePublicUrl(raw, sourceOrigin);
      if (!url) { failure(index, 'unsafe-url'); continue; }
      if (!allowedPathExtension(url, refs.get(raw))) { failure(index, 'unsafe-extension'); continue; }
      const remaining = limits.maxTotalBytes - report.transferBytes;
      if (remaining <= 0) { failure(index, 'budget-exhausted'); continue; }
      const result = await fetchStatic(url, refs.get(raw), {
        fetchImpl, timeoutMs: limits.timeoutMs, maxRedirects: limits.maxRedirects,
        maxBytes: Math.min(limits.maxAssetBytes, remaining),
      }, sourceOrigin);
      report.transferBytes += result.readBytes ?? 0;
      if (!result.body) { failure(index, result.reason); continue; }
      const entry = { method: 'GET', url: raw, status: 200, mimeType: result.mimeType,
        body: result.body.toString('base64') };
      const localized = localizeQueryEntries({ entries: [entry], liveDir, host, origin: sourceOrigin });
      const local = localized.map.get(raw);
      if (!local || !localized.written && !localized.skipped) { failure(index, 'localization-failed'); continue; }
      const file = join(liveDir, local.slice(('/lm/' + host + '/').length));
      if (localized.skipped) {
        let existing;
        try {
          if (!lstatSync(file).isFile()) throw new Error('not a regular file');
          existing = readFileSync(file);
        } catch { failure(index, 'localization-failed'); continue; }
        if (!existing.equals(result.body)) { failure(index, 'localization-conflict'); continue; }
      }
      urlMap.set(raw, local);
      report.fetched++;
      report.bytes += result.body.length;
      report.localized += localized.written;
      if (result.mimeType === 'text/css') {
        cssSources.set(file, result.finalUrl);
      }
    }
    if (!progressed) break;
    refs = discoverRefs(liveDir, staticDir, sourceOrigin, cssSources);
  }
  for (const [index, raw] of requested.entries()) if (!processed.has(raw)) failure(index, 'not-referenced');
  const rewritten = rewriteCandidateStaticRefs(liveDir, staticDir, sourceOrigin, cssSources, urlMap);
  report.rewrittenFiles = rewritten.files;
  report.rewrites = rewritten.rewrites;
  report.remainingExternal = discoverRefs(liveDir, staticDir, sourceOrigin, cssSources).size;
  const runtimeRefs = unrewrittenRuntimeRefs(liveDir, staticDir, urlMap, sourceOrigin);
  for (const [index, raw] of requested.entries()) {
    if (runtimeRefs.has(raw)) failure(index, 'unrewritten-runtime-reference');
  }
  return { report, urlMap };
}
