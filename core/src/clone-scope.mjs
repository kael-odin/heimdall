import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonUrl } from './url-canon.mjs';
import { readSiteOrigin } from './site-origin.mjs';
import { loadProfile, queuePlan } from './site-profile.mjs';

function sameOriginUrl(value, origin) {
  const url = canonUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin ? url : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

/** The denominator is the valid, distinct same-origin URLs in this atlas. */
export function readCloneScope(siteDir) {
  const atlasPath = join(siteDir, 'recon', 'atlas.json');
  if (!existsSync(atlasPath)) return { status: 'missing', issue: 'missing-atlas' };

  const atlas = readJson(atlasPath);
  if (!Array.isArray(atlas?.nodes)) return { status: 'invalid', issue: 'invalid-atlas' };

  let origin;
  try { origin = readSiteOrigin(siteDir); } catch {}
  if (!origin) return { status: 'invalid', issue: 'unconfirmed-origin' };
  try {
    if (atlas.origin && new URL(atlas.origin).origin !== origin) {
      return { status: 'invalid', issue: 'origin-mismatch' };
    }
  } catch { return { status: 'invalid', issue: 'invalid-origin' }; }

  const discovered = new Map();
  let invalidNodes = 0;
  let foreignNodes = 0;
  for (const node of atlas.nodes) {
    const url = canonUrl(node?.url);
    if (!url || !['http:', 'https:'].includes(new URL(url).protocol)) { invalidNodes++; continue; }
    if (new URL(url).origin !== origin) { foreignNodes++; continue; }
    const types = discovered.get(url) ?? new Set();
    types.add(node?.type);
    discovered.set(url, types);
  }
  if (atlas.status === 'failed' || discovered.size === 0) {
    return { status: 'invalid', issue: atlas.status === 'failed' ? 'recon-failed' : 'empty-atlas', invalidNodes, foreignNodes };
  }

  const profile = loadProfile(new URL(origin).hostname.replace(/^www\./, ''));
  const plan = queuePlan(profile);
  const typeEligible = [...discovered.values()].filter(types => [...types].some(type => !plan.excludeTypes.includes(type))).length;
  const eligible = Math.min(typeEligible, plan.maxPages);

  const queuePath = join(siteDir, 'queue.json');
  const queue = existsSync(queuePath) ? readJson(queuePath) : [];
  if (!Array.isArray(queue)) return { status: 'invalid', issue: 'invalid-queue', invalidNodes, foreignNodes };
  if (queue.some(row => !row || typeof row !== 'object' || !canonUrl(row.url)
    || !['pending', 'queued', 'done', 'failed'].includes(row.status))) {
    return { status: 'invalid', issue: 'invalid-queue-row', invalidNodes, foreignNodes };
  }
  const foreignQueue = queue.filter(row => {
    const url = new URL(canonUrl(row.url));
    return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
  }).length;
  if (foreignQueue) return { status: 'invalid', issue: 'foreign-queue-url', foreignQueue, invalidNodes, foreignNodes };
  const queued = new Set(queue.map(row => sameOriginUrl(row?.url, origin)).filter(Boolean));
  const inQueue = [...discovered.keys()].filter(url => queued.has(url)).length;
  const outsideAtlas = [...queued].filter(url => !discovered.has(url)).length;
  const maxPages = Number.isInteger(atlas.meta?.maxPages) && atlas.meta.maxPages > 0 ? atlas.meta.maxPages : null;
  const maxDepth = Number.isInteger(atlas.meta?.maxDepth) && atlas.meta.maxDepth >= 0 ? atlas.meta.maxDepth : null;

  return {
    status: 'ok', discovered: discovered.size, eligible,
    excludedByDefault: discovered.size - eligible,
    excludedByType: discovered.size - typeEligible,
    excludedByPageLimit: typeEligible - eligible,
    inQueue, notQueued: discovered.size - inQueue, outsideAtlas,
    invalidNodes, foreignNodes,
    reconFailures: Array.isArray(atlas.failures) ? atlas.failures.length : 0,
    maxPages, maxDepth, limitReached: maxPages !== null && discovered.size >= maxPages,
  };
}
