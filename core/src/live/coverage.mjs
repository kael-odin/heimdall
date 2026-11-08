import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonUrl } from '../url-canon.mjs';
import { sanitizeObservedUrl } from '../crawler/state-graph.mjs';
import { loadProfile, queuePlan } from '../site-profile.mjs';
import { liveSnapshotPath } from './live-path.mjs';

const MAX_PATHS = 2000;
const STANDARD_VIEWPORTS = new Set(['375x812', '768x1024', '1440x900']);

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
  if (!existsSync(file)) return { state: 'missing', urls: [], types: new Map() };
  let atlas;
  try { atlas = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { state: 'invalid', issue: 'unreadable-atlas', urls: [], types: new Map() }; }
  if (!Array.isArray(atlas?.nodes)) return { state: 'invalid', issue: 'invalid-nodes', urls: [], types: new Map() };
  let recordedOrigin = null;
  try { if (atlas.origin) recordedOrigin = new URL(atlas.origin).origin; } catch {}
  if (atlas.origin && recordedOrigin !== origin) {
    return { state: 'invalid', issue: 'origin-mismatch', urls: [], types: new Map() };
  }
  const urls = new Set();
  const types = new Map();
  let invalidNodes = 0;
  let foreignNodes = 0;
  for (const node of atlas.nodes) {
    const key = canonUrl(node?.url);
    if (!key || !/^https?:$/.test(new URL(key).protocol)) { invalidNodes++; continue; }
    if (new URL(key).origin !== origin) { foreignNodes++; continue; }
    urls.add(key);
    const nodeTypes = types.get(key) ?? new Set();
    nodeTypes.add(node?.type);
    types.set(key, nodeTypes);
  }
  const failures = Array.isArray(atlas.failures) ? atlas.failures.length : 0;
  const maxPages = Number.isInteger(atlas.meta?.maxPages) && atlas.meta.maxPages > 0 ? atlas.meta.maxPages : null;
  const maxDepth = Number.isInteger(atlas.meta?.maxDepth) && atlas.meta.maxDepth >= 0 ? atlas.meta.maxDepth : null;
  const limitReached = maxPages !== null && urls.size >= maxPages;
  const depthLimitUrls = Number.isInteger(atlas.meta?.depthLimitUrls) && atlas.meta.depthLimitUrls >= 0
    ? atlas.meta.depthLimitUrls : null;
  const depthLimitReached = atlas.meta?.depthLimitReached === true || (depthLimitUrls ?? 0) > 0;
  const sitemapTruncated = Array.isArray(atlas.meta?.sitemap?.truncated)
    ? atlas.meta.sitemap.truncated.filter(reason => typeof reason === 'string').slice(0, 20) : [];
  const sitemapUnknownFormats = Number.isInteger(atlas.meta?.sitemap?.unknownFormats)
    ? atlas.meta.sitemap.unknownFormats : null;
  const declaredSitemapFailures = Number.isInteger(atlas.meta?.sitemap?.declaredSitemapFailures)
    ? atlas.meta.sitemap.declaredSitemapFailures : null;
  const offOriginSitemaps = Number.isInteger(atlas.meta?.sitemap?.offOriginSitemaps)
    ? atlas.meta.sitemap.offOriginSitemaps : null;
  const offOriginPages = Number.isInteger(atlas.meta?.sitemap?.offOriginPages)
    ? atlas.meta.sitemap.offOriginPages : null;
  const sitemapCoverage = ['complete', 'not_found', 'partial', 'unavailable'].includes(atlas.meta?.sitemap?.coverage)
    ? atlas.meta.sitemap.coverage : 'unknown';
  const sitemapReasons = Array.isArray(atlas.meta?.sitemap?.reasons)
    ? atlas.meta.sitemap.reasons.filter(reason => typeof reason === 'string').slice(0, 20) : [];
  const invalid = atlas.status === 'failed' || urls.size === 0 || foreignNodes > 0 || invalidNodes > 0;
  return {
    state: invalid ? 'invalid' : 'ok',
    issue: invalid ? (atlas.status === 'failed' ? 'recon-failed' : foreignNodes ? 'foreign-nodes' : invalidNodes ? 'invalid-nodes' : 'empty-atlas') : null,
    urls: [...urls].sort(), types, invalidNodes, foreignNodes, failures, maxPages, maxDepth,
    limitReached, depthLimitReached, depthLimitUrls, sitemapTruncated, sitemapUnknownFormats,
    declaredSitemapFailures, offOriginSitemaps, offOriginPages, sitemapCoverage, sitemapReasons,
    generatedAt: typeof atlas.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(atlas.generatedAt)
      ? atlas.generatedAt : null,
  };
}

function queueCoverage(baseDir, origin, targets) {
  const file = join(baseDir, 'queue.json');
  if (!existsSync(file)) return { status: 'missing', queued: 0, notQueued: targets.length, outsideScope: 0 };
  let rows;
  try { rows = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { status: 'invalid', queued: null, notQueued: null, outsideScope: null }; }
  if (!Array.isArray(rows)) return { status: 'invalid', queued: null, notQueued: null, outsideScope: null };
  const urls = new Set();
  for (const row of rows) {
    const url = canonUrl(row?.url);
    if (!url || !['pending', 'queued', 'done', 'failed'].includes(row?.status)
      || new URL(url).origin !== origin || !/^https?:$/.test(new URL(url).protocol)) {
      return { status: 'invalid', queued: null, notQueued: null, outsideScope: null };
    }
    urls.add(url);
  }
  const targetSet = new Set(targets);
  const queued = targets.filter(url => urls.has(url)).length;
  return {
    status: 'ok', queued, notQueued: targets.length - queued,
    outsideScope: [...urls].filter(url => !targetSet.has(url)).length,
  };
}

function defaultQueueCoverage(source, origin) {
  if (source.state !== 'ok') return null;
  const profile = loadProfile(new URL(origin).hostname.replace(/^www\./, ''));
  const plan = queuePlan(profile);
  const typeEligible = source.urls.filter(url =>
    [...(source.types.get(url) ?? [undefined])].some(type => !plan.excludeTypes.includes(type))).length;
  const eligible = Math.min(typeEligible, plan.maxPages);
  return {
    eligible, excluded: source.urls.length - eligible,
    excludedByType: source.urls.length - typeEligible,
    excludedByPageLimit: typeEligible - eligible,
  };
}

function invalidatedVerifications(baseDir) {
  const file = join(baseDir, 'verify', 'verify-summary.json');
  let summary;
  try { summary = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return new Map(); }
  if (summary.mode !== 'all' || !Array.isArray(summary.pages)) return new Map();
  const stamp = Date.parse(summary.generatedAt ?? '');
  const at = Number.isFinite(stamp) ? stamp : statSync(file).mtimeMs;
  return new Map(summary.pages
    .filter(page => typeof page?.page === 'string' && (page.measured === false || page.invalidated))
    .map(page => [page.page, at]));
}

function verificationCoverage(baseDir, name, target, invalidated) {
  const file = join(baseDir, 'verify', name, 'verify.json');
  try {
    const cloneTime = statSync(join(baseDir, 'pages', name, 'clone', 'index.html')).mtimeMs;
    const verifyTime = statSync(file).mtimeMs;
    if (verifyTime < cloneTime) return { measured: false, standard: false };
    const verify = JSON.parse(readFileSync(file, 'utf8'));
    const stamp = Date.parse(verify.generatedAt ?? '');
    const measuredAt = Number.isFinite(stamp) ? stamp : verifyTime;
    if (measuredAt < cloneTime || measuredAt <= (invalidated.get(name) ?? -Infinity)
      || verify.scoreVersion !== 2 || verify.measured !== true
      || canonUrl(verify.target) !== target || !Array.isArray(verify.viewports)
      || !verify.viewports.length || verify.viewports.some(viewport =>
        !Number.isFinite(viewport?.score) || viewport.settleTimedOut)) {
      return { measured: false, standard: false };
    }
    const names = new Set(verify.viewports.map(viewport => viewport.name));
    return { measured: true, standard: [...STANDARD_VIEWPORTS].every(name => names.has(name)) };
  } catch { return { measured: false, standard: false }; }
}

/** Match discovered URLs to files in the candidate bundle, never to stale workspace live files. */
export function buildCoverageLedger({ baseDir, bundleDir, host, origin, pageNames }) {
  const source = atlasSource(baseDir, origin);
  const invalidated = invalidatedVerifications(baseDir);
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
    const verification = clone ? verificationCoverage(baseDir, name, key, invalidated)
      : { measured: false, standard: false };
    const previous = clones.get(key);
    clones.set(key, {
      clone: clone || !!previous?.clone, live: live || !!previous?.live,
      verifiedV2: verification.measured || !!previous?.verifiedV2,
      verifiedStandardViewports: verification.standard || !!previous?.verifiedStandardViewports,
    });
  }

  const hasAtlas = source.state !== 'missing';
  const targets = hasAtlas ? source.urls : [...clones.keys()].sort();
  const missing = [];
  let cloned = 0;
  let delivered = 0;
  let missingClone = 0;
  let missingLive = 0;
  let verifiedV2 = 0;
  let verifiedStandardViewports = 0;
  for (const [sourceIndex, key] of targets.entries()) {
    const product = clones.get(key);
    if (product?.clone && product.verifiedV2) verifiedV2++;
    if (product?.clone && product.verifiedStandardViewports) verifiedStandardViewports++;
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
  const queue = queueCoverage(baseDir, origin, targets);
  const defaultQueue = defaultQueueCoverage(source, origin);
  return {
    version: 2,
    scope: source.state === 'missing' ? 'captured-only' : source.state === 'ok' ? 'recon-discovered' : 'untrusted-recon',
    source: hasAtlas ? 'recon/atlas.json' : 'pages/*/manifest.json',
    sourceStatus: source.state,
    ...(source.issue ? { sourceIssue: source.issue } : {}),
    denominator: source.state === 'invalid' ? null : targets.length,
    observedTargets: targets.length,
    defaultQueue,
    queue,
    capturedClones: clones.size,
    cloned,
    verifiedV2,
    verifiedStandardViewports,
    unverifiedV2: targets.length - verifiedV2,
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
      limitReached: source.limitReached ?? false,
      depthLimitReached: source.depthLimitReached ?? false,
      depthLimitUrls: source.depthLimitUrls ?? null,
      sitemapTruncated: source.sitemapTruncated ?? [],
      sitemapUnknownFormats: source.sitemapUnknownFormats ?? null,
      declaredSitemapFailures: source.declaredSitemapFailures ?? null,
      offOriginSitemaps: source.offOriginSitemaps ?? null,
      offOriginPages: source.offOriginPages ?? null,
      sitemapCoverage: source.sitemapCoverage ?? 'unknown',
      sitemapReasons: source.sitemapReasons ?? [],
      scopeLimited: !!source.limitReached || !!source.depthLimitReached || !!source.sitemapTruncated?.length
        || (source.sitemapUnknownFormats ?? 0) > 0 || (source.declaredSitemapFailures ?? 0) > 0
        || (source.offOriginSitemaps ?? 0) > 0 || (source.failures ?? 0) > 0
        || !['complete', 'not_found'].includes(source.sitemapCoverage),
      generatedAt: source.generatedAt ?? null,
    } : null,
    missingPaths: missing.slice(0, MAX_PATHS),
    omittedMissingPaths: Math.max(0, missing.length - MAX_PATHS),
  };
}
