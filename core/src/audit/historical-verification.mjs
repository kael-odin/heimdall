import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonUrl, createPageNameResolver, isSameOriginUrl } from '../url-canon.mjs';
import { gradeOf, overallScore } from '../verify/compare.mjs';
import { loadProfile } from '../site-profile.mjs';

const readJson = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const isDir = file => { try { return statSync(file).isDirectory(); } catch { return false; } };
const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };
const round4 = value => +value.toFixed(4);

export function estimateLegacyV2(record) {
  if (!record || record.scoreVersion === 2 || !Array.isArray(record.viewports)) return null;
  const viewports = record.viewports.map(v => {
    const width = Number(v?.width);
    const sourceHeight = Number(v?.sourceHeight);
    const cloneHeight = Number(v?.cloneHeight);
    const mismatched = Number(v?.mismatched);
    if (!v?.name || !Number.isInteger(width) || width <= 0
        || !Number.isInteger(sourceHeight) || sourceHeight <= 0
        || !Number.isInteger(cloneHeight) || cloneHeight <= 0
        || !Number.isInteger(mismatched) || mismatched < 0) return null;
    const overlap = width * Math.min(sourceHeight, cloneHeight);
    const union = width * Math.max(sourceHeight, cloneHeight);
    if (mismatched > overlap) return null;
    return { name: v.name, score: Math.max(0, 1 - (mismatched + union - overlap) / union),
      coverageRatio: round4(overlap / union), sourceHeight, cloneHeight };
  });
  const expected = new Set(['375x812', '768x1024', '1440x900']);
  if (viewports.length !== expected.size || viewports.some(v => !v)
      || viewports.some(v => !expected.delete(v.name)) || expected.size) {
    return { state: 'incomplete_observation', availableViewports: viewports.filter(Boolean).length };
  }
  const overall = overallScore(viewports);
  for (const viewport of viewports) viewport.score = round4(viewport.score);
  return { state: 'legacy_count_estimate', overall, grade: gradeOf(overall),
    worstCoverage: Math.min(...viewports.map(v => v.coverageRatio)), viewports };
}

function publicUrlParts(input) {
  const url = new URL(input);
  return { pathname: url.pathname, hasQuery: !!url.search,
    queryHash: url.search ? createHash('sha256').update(url.search).digest('hex').slice(0, 12) : '' };
}

function legacyName(input) {
  return new URL(input).pathname.replace(/\/$/, '').replace(/^\//, '')
    .replace(/[/?&#]+/g, '-').slice(0, 60) || 'home';
}

export function auditHistoricalVerification(workspaceRoot) {
  const pages = [];
  const missing = [];
  const summary = { sites: 0, atlasSites: 0, pageDirs: 0, forgedPages: 0,
    legacyVerify: 0, completeEstimates: 0, incompleteObservations: 0,
    v2Verify: 0, withoutVerify: 0, legacyGradeDrops: 0,
    comparableAtlasUrls: 0, coveredAtlasUrls: 0, missingAtlasUrls: 0, missingLegacyCollisions: 0 };
  for (const host of readdirSync(workspaceRoot).filter(name => !name.startsWith('_')).sort()) {
    const site = join(workspaceRoot, host);
    if (!isDir(site)) continue;
    summary.sites++;
    const pagesDir = join(site, 'pages');
    const resolver = createPageNameResolver(site);
    const names = isDir(pagesDir) ? readdirSync(pagesDir).filter(name => isDir(join(pagesDir, name))).sort() : [];
    summary.pageDirs += names.length;
    const forgedUrls = new Set();
    const byLegacyName = new Map();
    for (const page of names) {
      const dir = join(pagesDir, page);
      const manifest = readJson(join(dir, 'manifest.json'));
      const canonical = canonUrl(manifest?.target);
      const hasClone = isFile(join(dir, 'clone', 'index.html'));
      if (canonical && hasClone) {
        forgedUrls.add(canonical);
        summary.forgedPages++;
        byLegacyName.set(legacyName(canonical).toLowerCase(), page);
      }
      const verify = readJson(join(site, 'verify', page, 'verify.json'));
      const estimate = estimateLegacyV2(verify);
      const state = verify?.scoreVersion === 2 ? 'v2' : verify ? estimate?.state ?? 'incomplete_observation' : 'no_verify';
      if (state === 'v2') summary.v2Verify++;
      else if (state === 'no_verify') summary.withoutVerify++;
      else {
        summary.legacyVerify++;
        if (state === 'legacy_count_estimate') summary.completeEstimates++;
        else summary.incompleteObservations++;
      }
      const oldGrade = typeof verify?.overall === 'number' ? gradeOf(verify.overall) : null;
      const gradeDrop = oldGrade && estimate?.state === 'legacy_count_estimate'
        ? Math.max(0, 'ABCD'.indexOf(estimate.grade) - 'ABCD'.indexOf(oldGrade)) : 0;
      if (gradeDrop) summary.legacyGradeDrops++;
      pages.push({ host, page, targetPath: canonical ? new URL(canonical).pathname : '',
        hasQuery: canonical ? !!new URL(canonical).search : false, hasClone,
        verifyState: state, oldOverall: typeof verify?.overall === 'number' ? verify.overall : null,
        oldGrade, estimatedV2: estimate?.state === 'legacy_count_estimate' ? estimate.overall : null,
        estimatedGrade: estimate?.state === 'legacy_count_estimate' ? estimate.grade : null,
        worstCoverage: estimate?.state === 'legacy_count_estimate' ? estimate.worstCoverage : null,
        observedViewports: estimate?.availableViewports ?? estimate?.viewports?.length ?? 0,
        gradeDrop });
    }
    const atlas = readJson(join(site, 'recon', 'atlas.json'));
    if (!Array.isArray(atlas?.nodes) || !atlas.origin) continue;
    summary.atlasSites++;
    const excluded = new Set(loadProfile(host).queue.excludeTypes);
    const candidates = new Map();
    for (let index = 0; index < atlas.nodes.length; index++) {
      const node = atlas.nodes[index];
      const canonical = canonUrl(node?.url);
      if (canonical && !excluded.has(node.type) && isSameOriginUrl(canonical, atlas.origin)) {
        if (!candidates.has(canonical)) candidates.set(canonical, { node, index });
      }
    }
    summary.comparableAtlasUrls += candidates.size;
    for (const [url, { node, index }] of candidates) {
      if (forgedUrls.has(url)) { summary.coveredAtlasUrls++; continue; }
      const parts = publicUrlParts(url);
      const collision = byLegacyName.has(legacyName(url).toLowerCase());
      if (collision) summary.missingLegacyCollisions++;
      missing.push({ host, atlasIndex: index, type: node.type ?? '', pathname: parts.pathname,
        hasQuery: parts.hasQuery, queryHash: parts.queryHash,
        proposedPage: resolver(url), reason: collision ? 'legacy_name_collision' : 'not_cloned' });
    }
  }
  summary.missingAtlasUrls = missing.length;
  pages.sort((a, b) => b.gradeDrop - a.gradeDrop
    || (a.verifyState === 'incomplete_observation' ? -1 : 0) - (b.verifyState === 'incomplete_observation' ? -1 : 0)
    || a.host.localeCompare(b.host) || a.page.localeCompare(b.page));
  missing.sort((a, b) => a.host.localeCompare(b.host) || a.atlasIndex - b.atlasIndex);
  return { generatedAt: new Date().toISOString(), summary, pages, missing };
}
