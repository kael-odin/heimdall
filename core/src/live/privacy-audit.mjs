import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxFiles: 50_000,
  maxDepth: 40,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFindings: 200,
  maxFailures: 40,
});
const MAX_TOTAL_BYTES_LIMIT = 1024 * 1024 * 1024;

const TEXT_EXT = new Set([
  '.css', '.csv', '.htm', '.html', '.js', '.json', '.md', '.mjs', '.cjs',
  '.svg', '.tsv', '.txt', '.webmanifest', '.xml', '.yaml', '.yml',
]);
const BINARY_EXT = new Set([
  '.avif', '.bin', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.mp3', '.mp4',
  '.otf', '.pdf', '.png', '.ttf', '.wasm', '.wav', '.webm', '.webp', '.woff', '.woff2',
]);
const SAFE_PARTS = new Set([
  'site', 'static', 'live', 'pages', 'clone', 'intel', 'seo', 'assets', 'styles',
  'images', 'img', 'fonts', 'media', 'index.html', 'landing.html', 'compare.html',
  'score.json', 'semantic.json', 'har.json', 'har-privacy.json', 'health.json',
  'heimdall-live.json', 'checksums.json', 'changes.json', 'README.md',
  'Dockerfile', 'docker-compose.yml', 'serve.mjs', 'live-path.mjs',
]);
const CREDENTIAL_QUERY_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|authorization|api[_-]?key|apikey|client[_-]?secret|password|passwd|pwd|session[_-]?(?:id|token)|sid|jwt|bearer|token|secret|x-amz-(?:credential|security-token|signature)|x-goog-(?:credential|signature)|awsaccesskeyid|googleaccessid)$/i;
const AUTH_COOKIE_NAME = /(?:^|[-_.])(?:session|auth|token|sid|jwt|csrf|xsrf|bearer)(?:$|[-_.])|^(?:phpsessid|jsessionid|connect\.sid)$/i;
const COOKIE_ATTRIBUTE = /^(?:domain|path|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i;
const QUERY_PAIR = /[?&]([a-z0-9_.%+-]+)=([^&#\s"'<>`\\]*)/gi;
const BEARER_HEADER = /\b(?:authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?Bearer[ \t]+([a-z0-9._~+/=-]{8,})/gi;
const COOKIE_HEADER = /\b(set-cookie|cookie)\b["']?\s*[:=]\s*["']?([^"'\r\n<>]+)/gi;
const COOKIE_PAIR = /(?:^|;)\s*([^=;\s]+)\s*=\s*([^;\s]*)/g;
const decoder = new TextDecoder('utf-8', { fatal: true });

function boundedLimit(value, fallback, maximum = fallback) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function safePath(root, path) {
  const rel = relative(root, path);
  if (!rel) return '.';
  return rel.split(/[\\/]/).filter(Boolean).map(part => {
    if (SAFE_PARTS.has(part)) return part;
    const suffix = extname(part).toLowerCase();
    const safeSuffix = /^\.[a-z0-9]{1,12}$/.test(suffix) ? suffix : '';
    const hash = createHash('sha256').update(part).digest('hex').slice(0, 12);
    return `[redacted-${hash}]${safeSuffix}`;
  }).join('/');
}

function normalizedText(text) {
  return text.replace(/\\\//g, '/').replace(/\\u00(?:26|3[fF]|3[dD])/g, code => {
    const n = code.slice(-2).toLowerCase();
    return n === '26' ? '&' : n === '3f' ? '?' : '=';
  }).replace(/&amp;/gi, '&');
}

function meaningfulValue(value) {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* The literal is still inspectable. */ }
  if (!decoded || /^(?:0|1|123|abc|xyz|foo|foobar|\.{3}|true|false|null|undefined|redacted|placeholder|example|sample|dummy|changeme|x+)$/i.test(decoded)) return false;
  if (/^(?:your[_-]?|<|\$\{|\{\{)/i.test(decoded)) return false;
  return true;
}

function scanText(text, add) {
  const content = normalizedText(text);
  for (const match of content.matchAll(QUERY_PAIR)) {
    let key = match[1];
    try { key = decodeURIComponent(key); } catch { continue; }
    if (CREDENTIAL_QUERY_KEY.test(key) && meaningfulValue(match[2])) add('credential-query');
  }
  for (const match of content.matchAll(BEARER_HEADER)) {
    if (meaningfulValue(match[1])) add('bearer-value');
  }
  for (const header of content.matchAll(COOKIE_HEADER)) {
    const isSetCookie = header[1].toLowerCase() === 'set-cookie';
    let first = true;
    for (const pair of header[2].matchAll(COOKIE_PAIR)) {
      if (isSetCookie && !first) break;
      first = false;
      const [name, value] = [pair[1], pair[2]];
      if (COOKIE_ATTRIBUTE.test(name) || !meaningfulValue(value)) continue;
      if (AUTH_COOKIE_NAME.test(name) || value.length >= 8) add('cookie-value');
    }
  }
}

function isBinary(buffer) {
  if (buffer.includes(0)) return true;
  let controls = 0;
  // Text documentation can legitimately contain ANSI escape sequences (for
  // example copied terminal output). Escape is not evidence of binary content.
  for (const byte of buffer) if (byte < 32 && ![9, 10, 13, 27].includes(byte)) controls++;
  return controls > Math.max(2, buffer.length / 100);
}

/**
 * Audit a candidate delivery directory. No source text, matched value or raw
 * filesystem error is returned. An incomplete scan must not pass a strict gate.
 */
export function auditBundlePrivacy({ bundleDir, limits = {} }) {
  const bound = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key, boundedLimit(limits[key], value)]));
  bound.maxTotalBytes = boundedLimit(limits.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, MAX_TOTAL_BYTES_LIMIT);
  const counts = { 'credential-query': 0, 'bearer-value': 0, 'cookie-value': 0 };
  const findings = new Map();
  const failures = [];
  let entriesVisited = 0, filesVisited = 0, scannedFiles = 0, skippedBinaryFiles = 0;
  let scannedBytes = 0, issueCount = 0, failureCount = 0, stopped = false;
  let findingsTruncated = false, failuresTruncated = false;

  function fail(path, reason) {
    failureCount++;
    if (failures.length < bound.maxFailures) failures.push({ path: safePath(bundleDir, path), reason });
    else failuresTruncated = true;
  }

  function add(path, type) {
    issueCount++;
    counts[type]++;
    const rel = safePath(bundleDir, path);
    const key = rel + '\0' + type;
    if (findings.has(key)) findings.get(key).count++;
    else if (findings.size < bound.maxFindings) findings.set(key, { path: rel, type, count: 1 });
    else findingsTruncated = true;
  }

  function inspectHarBodies(path, text) {
    if (basename(path) !== 'har.json') return;
    let har;
    try { har = JSON.parse(text); } catch { fail(path, 'invalid-har-json'); return; }
    if (!Array.isArray(har?.entries)) return;
    for (const entry of har.entries) {
      if (!entry || entry.bodyEncoding !== 'base64' || typeof entry.body !== 'string') continue;
      if (!/(?:text|json|javascript|xml|svg)/i.test(String(entry.mimeType ?? ''))) continue;
      if (entry.body.length > Math.ceil(bound.maxFileBytes * 4 / 3) + 4) { fail(path, 'embedded-body-too-large'); continue; }
      const body = Buffer.from(entry.body, 'base64');
      if (body.length > bound.maxFileBytes) { fail(path, 'embedded-body-too-large'); continue; }
      if (scannedBytes + body.length > bound.maxTotalBytes) { fail(path, 'total-byte-limit'); stopped = true; return; }
      scannedBytes += body.length;
      try { scanText(decoder.decode(body), type => add(path, type)); }
      catch { fail(path, 'undecodable-embedded-text'); }
    }
  }

  function inspectFile(path, initialStat) {
    const extension = extname(path).toLowerCase();
    if (BINARY_EXT.has(extension)) { skippedBinaryFiles++; return; }
    if (initialStat.size > bound.maxFileBytes) { fail(path, 'file-byte-limit'); return; }
    if (scannedBytes + initialStat.size > bound.maxTotalBytes) { fail(path, 'total-byte-limit'); stopped = true; return; }
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== initialStat.size || (initialStat.ino && stat.ino !== initialStat.ino)) {
        fail(path, 'file-changed'); return;
      }
      const buffer = Buffer.allocUnsafe(Math.min(bound.maxFileBytes + 1, stat.size + 1));
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (n === 0) break;
        size += n;
      }
      if (size !== stat.size) { fail(path, 'file-changed'); return; }
      const content = buffer.subarray(0, size);
      if (isBinary(content)) {
        if (TEXT_EXT.has(extension)) fail(path, 'undecodable-text');
        else skippedBinaryFiles++;
        return;
      }
      let text;
      try { text = decoder.decode(content); }
      catch {
        if (TEXT_EXT.has(extension)) fail(path, 'undecodable-text');
        else skippedBinaryFiles++;
        return;
      }
      scannedFiles++;
      scannedBytes += content.length;
      scanText(text, type => add(path, type));
      inspectHarBodies(path, text);
    } catch { fail(path, 'read-failed'); }
    finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { fail(path, 'close-failed'); }
      }
    }
  }

  function visit(dirPath, depth) {
    if (depth > bound.maxDepth) { fail(dirPath, 'depth-limit'); return; }
    let dir;
    try { dir = opendirSync(dirPath); }
    catch { fail(dirPath, 'directory-read-failed'); return; }
    try {
      let entry;
      while (!stopped && (entry = dir.readSync())) {
        entriesVisited++;
        if (entriesVisited > bound.maxEntries) { fail(join(dirPath, entry.name), 'entry-limit'); stopped = true; break; }
        const path = join(dirPath, entry.name);
        let stat;
        try { stat = lstatSync(path); }
        catch { fail(path, 'stat-failed'); continue; }
        if (stat.isSymbolicLink()) { fail(path, 'symbolic-link'); continue; }
        if (stat.isDirectory()) { visit(path, depth + 1); continue; }
        if (!stat.isFile()) { fail(path, 'unsupported-entry'); continue; }
        filesVisited++;
        if (filesVisited > bound.maxFiles) { fail(path, 'file-limit'); stopped = true; break; }
        inspectFile(path, stat);
      }
    } catch { fail(dirPath, 'directory-read-failed'); }
    finally { dir.closeSync(); }
  }

  if (typeof bundleDir !== 'string' || !bundleDir) throw new TypeError('bundleDir must be a nonempty string');
  let rootStat;
  try { rootStat = lstatSync(bundleDir); }
  catch { fail(bundleDir, 'root-unavailable'); }
  if (rootStat?.isSymbolicLink()) fail(bundleDir, 'symbolic-link');
  else if (rootStat && !rootStat.isDirectory()) fail(bundleDir, 'root-not-directory');
  else if (rootStat) visit(bundleDir, 0);

  return {
    status: failureCount ? 'incomplete' : issueCount ? 'issues' : 'clean',
    entriesVisited, filesVisited, scannedFiles, skippedBinaryFiles, scannedBytes,
    issueCount, counts,
    findings: [...findings.values()].sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type)),
    findingsTruncated, failureCount, failures, failuresTruncated,
  };
}
