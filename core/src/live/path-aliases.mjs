import { lstatSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parse } from 'parse5';
import { UA } from '../ua.mjs';
import { resolveRefPath } from './health.mjs';
import { liveSnapshotCandidates } from './live-path.mjs';

const MAX_FILES = 4000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_TARGETS = 64;
const MAX_REDIRECTS = 3;
const MAX_TIMEOUT_MS = 10_000;
const MAX_WALL_MS = 30_000;

function localPathExists(liveDir, path, search = '') {
  for (const candidate of liveSnapshotCandidates(path, search)) {
    try {
      if (statSync(join(liveDir, candidate)).isFile()) return true;
    } catch { /* Missing routes are normal for aliases. */ }
  }
  return false;
}

function sameOriginTarget(raw, origin, host) {
  const resolved = resolveRefPath(raw, { host, origin, basePath: '/' });
  if (!resolved || resolved.external) return null;
  if (resolved.path.includes('\\') || resolved.path.includes('\0') || resolved.path.split('/').includes('..')) return null;
  return { path: resolved.path || '/', search: resolved.search ?? '' };
}

function targetKey(target) {
  return (target.path || '/') + (target.search || '');
}

function escapeAttr(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function findBase(node, host, origin, fallbackBase) {
  if (node.tagName === 'base') {
    const href = (node.attrs ?? []).find(attr => attr.name.toLowerCase() === 'href')?.value;
    const resolved = href ? resolveRefPath(href, { host, origin, basePath: fallbackBase }) : null;
    if (resolved && !resolved.external && resolved.path.endsWith('/')) return resolved.path;
  }
  for (const child of node.childNodes ?? []) {
    const found = findBase(child, host, origin, fallbackBase);
    if (found) return found;
  }
  if (node.content) return findBase(node.content, host, origin, fallbackBase);
  return null;
}

function rewriteHtml(html, { host, origin, map, fallbackBase }) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const base = findBase(document, host, origin, fallbackBase) ?? fallbackBase;
  const ranges = [];
  let rewrites = 0;
  const walk = node => {
    if (node.tagName !== 'a') {
      for (const child of node.childNodes ?? []) walk(child);
      if (node.content) walk(node.content);
      return;
    }
    const attr = (node.attrs ?? []).find(item => item.name.toLowerCase() === 'href');
    if (attr?.value) {
      const resolved = resolveRefPath(attr.value, { host, origin, basePath: base });
      if (resolved && !resolved.external) {
        const local = map.get(targetKey(resolved));
        if (local) {
          const hash = String(attr.value).split('#')[1];
          const value = local + (hash ? '#' + hash : '');
          const location = node.sourceCodeLocation?.attrs?.href;
          if (location && value !== attr.value) {
            ranges.push({ start: location.startOffset, end: location.endOffset, text: `href="${escapeAttr(value)}"` });
            rewrites++;
          }
        }
      }
    }
  };
  walk(document);
  let text = html;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, range.start) + range.text + text.slice(range.end);
  }
  return { text, rewrites };
}

/** Probe public path aliases and rewrite them only to verified local routes or local 404 routes. */
export async function probePublicPathAliases({
  liveDir, host, origin, targets = [], fetchImpl = globalThis.fetch,
  maxTargets = 64, timeoutMs = 10_000, maxWallMs = 30_000,
} = {}) {
  maxTargets = Number.isSafeInteger(maxTargets) && maxTargets > 0 ? Math.min(maxTargets, MAX_TARGETS) : 64;
  timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : 10_000;
  maxWallMs = Number.isSafeInteger(maxWallMs) && maxWallMs > 0 ? Math.min(maxWallMs, MAX_WALL_MS) : 30_000;
  const deadline = Date.now() + maxWallMs;
  const unique = new Map();
  for (const raw of targets) {
    const target = sameOriginTarget(raw, origin, host);
    if (!target) continue;
    const key = targetKey(target);
    const current = unique.get(key) ?? { ...target, references: 0 };
    current.references++;
    unique.set(key, current);
  }
  const report = {
    status: unique.size ? 'checked' : 'not-detected',
    targets: unique.size,
    checked: 0,
    resolvedLocal: 0,
    expectedMissing: 0,
    expectedMissingReferences: 0,
    unsupportedExternalRedirects: 0,
    unsupportedExternalRedirectReferences: 0,
    unexpected: 0,
    unexpectedReferences: 0,
    failed: 0,
    untested: 0,
    details: [],
  };
  const rewriteMap = new Map();
  for (const target of [...unique.values()].slice(0, maxTargets)) {
    if (Date.now() >= deadline) {
      report.untested++;
      continue;
    }
    let current = { ...target };
    let sourceStatus = null;
    let disposition = 'failed';
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        const response = await fetchImpl(new URL(targetKey(current), origin).href, {
          method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        });
        sourceStatus = response.status;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          const next = location ? sameOriginTarget(location, origin, host) : null;
          await response.body?.cancel();
          if (!next) {
            disposition = 'unsupported-external-redirect';
            break;
          }
          if (localPathExists(liveDir, next.path, next.search)) {
            current = next;
            disposition = 'resolved-local';
            break;
          }
          if (redirect === MAX_REDIRECTS) {
            disposition = 'redirect-limit';
            break;
          }
          current = next;
          continue;
        }
        if (response.headers.has('set-cookie')) {
          disposition = 'credentialed-response';
          await response.body?.cancel();
          break;
        }
        if (response.status === 404 || response.status === 410) {
          disposition = 'expected-missing';
          await response.body?.cancel();
          break;
        }
        if (response.status !== 200) {
          disposition = 'http-status';
          await response.body?.cancel();
          break;
        }
        const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
        await response.body?.cancel();
        disposition = mime === 'text/html' || mime === 'application/xhtml+xml'
          ? 'uncaptured-page' : 'unexpected-content';
        break;
      }
    } catch {
      disposition = 'failed';
      sourceStatus ??= 0;
    }
    report.checked++;
    const local = disposition === 'resolved-local'
      ? '/lm/' + host + targetKey(current)
      : '/lm/' + host + targetKey(target);
    rewriteMap.set(targetKey(target), local);
    if (disposition === 'expected-missing') {
      report.expectedMissing++;
      report.expectedMissingReferences += target.references;
    } else if (disposition === 'unsupported-external-redirect') {
      report.unsupportedExternalRedirects++;
      report.unsupportedExternalRedirectReferences += target.references;
    } else if (disposition === 'failed') {
      report.failed++;
      report.unexpectedReferences += target.references;
    } else if (disposition !== 'resolved-local') {
      report.unexpected++;
      report.unexpectedReferences += target.references;
    }
    if (disposition === 'resolved-local') report.resolvedLocal++;
    if (report.details.length < 100) {
      report.details.push({
        path: target.path.split('?')[0],
        sourceStatus,
        disposition,
        references: target.references,
      });
    }
  }
  report.untested += Math.max(0, unique.size - maxTargets);
  if (report.failed || report.untested) report.status = 'partial';
  else if (report.unsupportedExternalRedirectReferences) report.status = 'unsupported-detected';
  else if (report.unexpectedReferences) report.status = 'unexpected-detected';
  return { report, rewriteMap };
}

/** Rewrite alias navigation links in candidate live and static HTML. */
export function rewritePathAliasLinks({ liveDir, staticDir = null, host, origin, map }) {
  if (!(map instanceof Map) || !map.size) return { files: 0, rewrites: 0 };
  const out = { files: 0, rewrites: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (dir, root, isLive) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('path alias rewrite refuses symlinks');
      if (stat.isDirectory()) { walk(file, root, isLive); continue; }
      if (!stat.isFile() || !/\.html?$/i.test(name) || extname(name).toLowerCase() === '') continue;
      if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) {
        throw new Error('path alias rewrite limit exceeded');
      }
      const rel = relative(root, file).replaceAll('\\', '/');
      const fallbackBase = isLive
        ? '/' + (rel.replace(/index\.html?$/i, '').split('/').slice(0, -1).join('/') || '')
        : '/';
      const html = readFileSync(file, 'utf8');
      const changed = rewriteHtml(html, { host, origin, map, fallbackBase });
      if (!changed.rewrites || changed.text === html) continue;
      writeFileSync(file + '.heimdall-tmp', changed.text);
      renameSync(file + '.heimdall-tmp', file);
      out.files++;
      out.rewrites += changed.rewrites;
    }
  };
  walk(liveDir, liveDir, true);
  if (staticDir) walk(staticDir, staticDir, false);
  return out;
}
