import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BASELINE_VERSION } from './baseline.mjs';
import { SEVERITY_PENALTY } from './rules.mjs';
import { SEO_SCORE_METHOD_VERSION } from './method.mjs';

const SEVERITIES = new Set(Object.keys(SEVERITY_PENALTY));

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeOrigin(value, label = 'origin') {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`baseline ${label} is not a valid URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`baseline ${label} must be an HTTP(S) origin`);
  }
  return url.origin;
}

function normalizePageUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  const href = url.href;
  return href.endsWith('/') ? href.slice(0, -1) : href;
}

/** Stable, path-safe key used by the CI workflow for config/seo-baseline/<key>.json. */
export function baselineFileKey(target) {
  const raw = String(target ?? '').trim();
  let parsed;
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new Error('baseline target is not a valid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('baseline target must be an HTTP(S) URL without credentials');
  }
  const origin = normalizeOrigin(parsed.origin, 'target');
  const url = new URL(origin);
  const hostLabel = url.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 100);
  const fingerprint = createHash('sha256').update(origin).digest('hex').slice(0, 24);
  return `${hostLabel}--origin-${fingerprint}`;
}

/** Keep each scoring method's CI baseline separate from older snapshots. */
export function versionedBaselineFileKey(target) {
  return `${baselineFileKey(target)}--score-v${SEO_SCORE_METHOD_VERSION}`;
}

function validateIssueMap(value, label) {
  if (!isRecord(value)) throw new Error(`baseline ${label} must be an object`);
  for (const [ruleId, severity] of Object.entries(value)) {
    if (!ruleId.trim() || !SEVERITIES.has(severity)) {
      throw new Error(`baseline ${label}.${ruleId} has invalid severity: ${severity}`);
    }
  }
}

function validateScore(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`baseline ${label} must be a finite number between 0 and 100`);
  }
}

export function readBaselineFile(path, { required = false, expectedOrigin = null, expectedHost = null } = {}) {
  if (!existsSync(path)) {
    if (required) throw new Error(`baseline not found: ${path}`);
    return null;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`baseline cannot be parsed: ${path}: ${error.message}`);
  }
  if (!isRecord(baseline) || !isRecord(baseline.pages)) {
    throw new Error(`baseline has invalid structure: ${path}`);
  }
  if (Number(baseline.version) !== BASELINE_VERSION) {
    throw new Error(`baseline version ${baseline.version} != ${BASELINE_VERSION}: ${path}`);
  }
  if (baseline.scoreMethodVersion != null
      && (!Number.isSafeInteger(baseline.scoreMethodVersion) || baseline.scoreMethodVersion < 1)) {
    throw new Error(`baseline score method version is invalid: ${path}`);
  }
  if (Object.keys(baseline.pages).length === 0) {
    throw new Error(`baseline has invalid structure: ${path} (pages is empty)`);
  }

  let origin;
  try { origin = normalizeOrigin(baseline.origin); }
  catch (error) { throw new Error(`${error.message}: ${path}`); }
  if (expectedOrigin && origin !== normalizeOrigin(expectedOrigin, 'expected origin')) {
    throw new Error(`baseline origin mismatch: ${origin} != ${normalizeOrigin(expectedOrigin, 'expected origin')}: ${path}`);
  }
  if (typeof baseline.host !== 'string' || !baseline.host.trim()) {
    throw new Error(`baseline host is missing: ${path}`);
  }
  if (expectedHost && baseline.host.toLowerCase() !== String(expectedHost).toLowerCase()) {
    throw new Error(`baseline host mismatch: ${baseline.host} != ${expectedHost}: ${path}`);
  }
  validateScore(baseline.stable, 'stable');
  validateScore(baseline.score, 'score', { nullable: true });
  validateIssueMap(baseline.siteIssues ?? {}, 'siteIssues');

  for (const [pageUrl, page] of Object.entries(baseline.pages)) {
    const normalized = normalizePageUrl(pageUrl);
    if (!normalized || normalized !== pageUrl || new URL(normalized).origin !== origin) {
      throw new Error(`baseline page URL is invalid or cross-origin: ${pageUrl}: ${path}`);
    }
    if (!isRecord(page) || !isRecord(page.issues)) {
      throw new Error(`baseline page entry is invalid: ${pageUrl}: ${path}`);
    }
    validateScore(page.stable, `pages.${pageUrl}.stable`);
    validateScore(page.score, `pages.${pageUrl}.score`, { nullable: true });
    validateIssueMap(page.issues, `pages.${pageUrl}.issues`);
  }
  if (baseline.summary != null) {
    if (!isRecord(baseline.summary) || (baseline.summary.pages != null
      && baseline.summary.pages !== Object.keys(baseline.pages).length)) {
      throw new Error(`baseline summary does not match pages: ${path}`);
    }
  }
  return baseline;
}
