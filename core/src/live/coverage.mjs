import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonUrl } from '../url-canon.mjs';
import { sanitizeObservedUrl } from '../crawler/state-graph.mjs';
import { liveSnapshotPath } from './live-path.mjs';

const MAX_PATHS = 2000;

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function pageKey(value, origin) {
  const key = canonUrl(value);
  return key && new URL(key).origin === origin ? key : null;
}

function publicPath(value) {
  const url = new URL(value);
  const safe = sanitizeObservedUrl(url.href);
  return (safe.startsWith(url.origin) ? safe.slice(url.origin.length) : '/[redacted]')
    + (url.search ? '?[redacted]' : '');
}

function atlasSource(baseDir, origin) {
  const file = join(baseDir, 'recon', 'atlas.json');
  if (!existsSync(file)) return { state: 'missing', urls: [] };
  let atlas;
  try { atlas = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { state: 'invalid', issue: 'unreadable-atlas', urls: [] }; }
  if (!Array.isArray(atlas?.nodes)) return { state: 'invalid', issue: 'invalid-nodes', urls: [] };
  let recordedOrigin = null;
  try { if (atlas.origin) recordedOrigin = new URL(atlas.origin).origin; } catch {}
  if (atlas.origin && recordedOrigin !== origin) {
    return { state: 'invalid', issue: 'origin-mismatch', urls: [] };
  }
  const urls = new Set();
  let invalidNodes = 0;
  let foreignNodes = 0;
  for (const node of atlas.nodes) {
    const key = canonUrl(node?.url);
    if (!key || !/^https?:$/.test(new URL(key).protocol)) { invalidNodes++; continue; }
    if (new URL(key).origin !== origin) { foreignNodes++; continue; }
    urls.add(key);
  }
  const failures = Array.isArray(atlas.failures) ? atlas.failures.length : 0;
  const maxPages = Number.isInteger(atlas.meta?.maxPages) && atlas.meta.maxPages > 0 ? atlas.meta.maxPages : null;
  const maxDepth = Number.isInteger(atlas.meta?.maxDepth) && atlas.meta.maxDepth >= 0 ? atlas.meta.maxDepth : null;
  const limitReached = maxPages !== null && urls.size >= maxPages;
  const invalid = atlas.status === 'failed' || urls.size === 0 || foreignNodes > 0 || invalidNodes > 0;
  return {
    state: invalid ? 'invalid' : 'ok',
    issue: invalid ? (atlas.status === 'failed' ? 'recon-failed' : foreignNodes ? 'foreign-nodes' : invalidNodes ? 'invalid-nodes' : 'empty-atlas') : null,
    urls: [...urls].sort(), invalidNodes, foreignNodes, failures, maxPages, maxDepth,
    limitReached,
    generatedAt: typeof atlas.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(atlas.generatedAt)
      ? atlas.generatedAt : null,
  };
}

/** Match discovered URLs to files in the candidate bundle, never to stale workspace live files. */
export function buildCoverageLedger({ baseDir, bundleDir, host, origin, pageNames }) {
  const source = atlasSource(baseDir, origin);
  const clones = new Map();
  let unmappedClones = 0;
  for (const name of pageNames) {
    let key;
    try { key = pageKey(JSON.parse(readFileSync(join(baseDir, 'pages', name, 'manifest.json'), 'utf8')).target, origin); }
    catch { key = null; }
    if (!key) { unmappedClones++; continue; }
    const target = new URL(key);
    const clone = isFile(join(bundleDir, 'site', 'static', host, 'pages', name, 'clone', 'index.html'));
    const live = isFile(join(bundleDir, 'site', 'live', liveSnapshotPath(target.pathname, target.search)));
    const previous = clones.get(key);
    clones.set(key, { clone: clone || !!previous?.clone, live: live || !!previous?.live });
  }

  const hasAtlas = source.state !== 'missing';
  const targets = hasAtlas ? source.urls : [...clones.keys()].sort();
  const missing = [];
  let cloned = 0;
  let delivered = 0;
  let missingClone = 0;
  let missingLive = 0;
  for (const [sourceIndex, key] of targets.entries()) {
    const product = clones.get(key);
    if (!product?.clone) {
      missingClone++;
      missing.push({ sourceIndex, path: publicPath(key), reason: 'not-cloned' });
    } else if (!product.live) {
      cloned++;
      missingLive++;
      missing.push({ sourceIndex, path: publicPath(key), reason: 'no-live-route' });
    } else {
      cloned++;
      delivered++;
    }
  }
  const discovered = new Set(source.urls);
  const extraClones = source.state === 'missing' ? 0
    : source.issue === 'origin-mismatch' ? null
      : [...clones.keys()].filter(key => !discovered.has(key)).length;
  return {
    version: 1,
    scope: source.state === 'missing' ? 'captured-only' : source.state === 'ok' ? 'recon-discovered' : 'untrusted-recon',
    source: hasAtlas ? 'recon/atlas.json' : 'pages/*/manifest.json',
    sourceStatus: source.state,
    ...(source.issue ? { sourceIssue: source.issue } : {}),
    denominator: source.state === 'invalid' ? null : targets.length,
    observedTargets: targets.length,
    capturedClones: clones.size,
    cloned,
    delivered,
    missingClone,
    missingLive,
    extraClones,
    unmappedClones,
    invalidNodes: source.invalidNodes ?? 0,
    foreignNodes: source.foreignNodes ?? 0,
    reconFailures: source.failures ?? 0,
    discovery: hasAtlas ? {
      maxPages: source.maxPages ?? null, maxDepth: source.maxDepth ?? null,
      limitReached: source.limitReached ?? false, generatedAt: source.generatedAt ?? null,
    } : null,
    missingPaths: missing.slice(0, MAX_PATHS),
    omittedMissingPaths: Math.max(0, missing.length - MAX_PATHS),
  };
}
