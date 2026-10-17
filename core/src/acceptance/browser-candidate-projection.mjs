/**
 * Browser selected-side source projection. Pure and synchronous: no I/O,
 * network, clock, IDs or execution. The caller must capture/fence the source
 * directory separately. Digests prove captured bytes, not filesystem ownership,
 * a signed history, a deployment freeze, or future contents of a live URL.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { PNG } from 'pngjs';
import { canonicalAcceptanceJson, buildAcceptanceIdentity } from './identity.mjs';
import { hashBrowserCandidateValue as digest } from './browser-candidate-identity.mjs';
import { normalizeAcceptancePlan, resolveAcceptanceUrl } from './schema.mjs';
import { summarizeAcceptanceReport } from './report.mjs';
import { AcceptanceCatalogError } from './catalog-schema.mjs';
import { comparePngBuffers } from '../verify/compare.mjs';

export { BROWSER_CANDIDATE_PROJECTION_V1 } from './browser-candidate-identity.mjs';
export const BROWSER_CANDIDATE_LIMITS_V1 = Object.freeze({
  jsonBytes: 8 * 1024 * 1024, snapshotBytes: 24 * 1024 * 1024, previewBytes: 2 * 1024 * 1024,
  evidenceFiles: 1024, evidenceFileBytes: 64 * 1024 * 1024, evidenceBytes: 256 * 1024 * 1024,
  pngDimension: 12_000, pngPixels: 12_000_000, pngTotalPixels: 96_000_000, pngChunks: 4096,
  jsonDepth: 80, jsonNodes: 400_000, jsonCharacters: 32 * 1024 * 1024,
});
/**
 * Independently reviewed Browser semantics at e427ec1: bounded full-page
 * capture, read-only isolated contexts, six base facets and declared points.
 * These are the exact legacy ten-file fingerprints with LF / CRLF sources.
 * The controlled Spec change in this source set did not alter Browser rules.
 * Never derive this allowlist from the running checkout or a source assertion.
 */
export const SUPPORTED_BROWSER_VERIFIERS_V1 = Object.freeze([
  'e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8',
  '8d1b75da7efad4f18b279a466ebdf880b1e24bb641ca80070cd03d0700376e9f',
]);

const L = BROWSER_CANDIDATE_LIMITS_V1;
const HASH = /^[a-f0-9]{64}$/;
const RUN = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^[a-z0-9][a-z0-9_.-]{0,234}\.(?:png|json)$/i;
const CAPTURE = Object.freeze({ maxPixels: 12_000_000, maxHeight: 12_000 });
const PROFILE = Object.freeze({ locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' });
const ENVIRONMENT = ['platform', 'arch', 'nodeVersion', 'browser', 'browserVersion', 'playwrightVersion', ...Object.keys(PROFILE)];
const FACETS = ['navigation', 'console', 'network', 'overflow', 'structure', 'visual'];
const ROLES = ['baselineScreenshot', 'targetScreenshot', 'baselineDetails', 'targetDetails', 'baselineRepeat', 'targetRepeat'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const copy = value => JSON.parse(JSON.stringify(value));
const serialized = value => JSON.parse(JSON.stringify(value));
const safeName = value => value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 70);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const message = value => typeof value === 'string' && value.length > 0 && value.length <= 800;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const size = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && value.length === 24 && (() => {
  try { return new Date(value).toISOString() === value; } catch { return false; }
})();
class Rejection extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const requireThat = (value, reason) => { if (!value) throw new Rejection(reason); };
function fields(value, allowed, required = allowed, reason = 'SOURCE_INPUT_INVALID') {
  requireThat(plain(value), reason);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) requireThat(typeof key === 'string' && allowed.includes(key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value'), reason);
  requireThat(required.every(key => Object.hasOwn(descriptors, key)), reason);
}
function strictJson(value, maxBytes, reason) {
  const active = new WeakSet();
  let nodes = 0, characters = 0;
  const visit = (entry, depth) => {
    requireThat(++nodes <= L.jsonNodes && depth <= L.jsonDepth, reason);
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') { requireThat(Number.isFinite(entry), reason); return; }
    if (typeof entry === 'string') { characters += entry.length; requireThat(characters <= L.jsonCharacters, reason); return; }
    requireThat(typeof entry === 'object' && !types.isProxy(entry) && !active.has(entry), reason);
    const array = Array.isArray(entry);
    requireThat(array ? [Array.prototype, null].includes(Object.getPrototypeOf(entry)) : plain(entry), reason);
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    if (array) requireThat(keys.length === descriptors.length.value + 1, reason);
    active.add(entry);
    for (const key of keys) {
      const d = descriptors[key];
      requireThat(typeof key === 'string' && Object.hasOwn(d, 'value'), reason);
      if (array && key === 'length') continue;
      requireThat(d.enumerable && (!array || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < descriptors.length.value), reason);
      characters += key.length; requireThat(characters <= L.jsonCharacters, reason);
      visit(d.value, depth + 1);
    }
    active.delete(entry);
  };
  visit(value, 0);
  requireThat(Buffer.byteLength(canonicalAcceptanceJson(value)) <= maxBytes, reason);
}
function byteReader(files) {
  requireThat(files !== null && typeof files === 'object' && !types.isProxy(files)
    && Object.getPrototypeOf(files) === Map.prototype && Reflect.ownKeys(files).length === 0, 'SOURCE_FILES_INVALID');
  const supplied = new Map(Map.prototype.entries.call(files));
  requireThat(supplied.size <= L.evidenceFiles + 2, 'SOURCE_FILES_BUDGET');
  for (const [name] of supplied) requireThat(typeof name === 'string' && FILE.test(name), 'SOURCE_FILES_INVALID');
  const native = Object.getPrototypeOf(Uint8Array.prototype), captured = new Map();
  const get = key => Object.getOwnPropertyDescriptor(native, key).get;
  return (name, maxBytes) => {
    if (captured.has(name)) return captured.get(name);
    requireThat(supplied.has(name), 'SOURCE_FILE_MISSING');
    const raw = supplied.get(name);
    requireThat(raw !== null && typeof raw === 'object' && !types.isProxy(raw)
      && (Buffer.isBuffer(raw) && Object.getPrototypeOf(raw) === Buffer.prototype
        || raw instanceof Uint8Array && Object.getPrototypeOf(raw) === Uint8Array.prototype), 'SOURCE_FILE_INVALID');
    const length = get('byteLength').call(raw), buffer = get('buffer').call(raw), offset = get('byteOffset').call(raw);
    requireThat(length <= maxBytes && !types.isSharedArrayBuffer(buffer), 'SOURCE_FILE_BUDGET');
    const bytes = Buffer.from(Buffer.from(buffer, offset, length));
    captured.set(name, bytes); return bytes;
  };
}
function parse(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Rejection('SOURCE_FILE_JSON_INVALID'); }
  requireThat(plain(value), 'SOURCE_FILE_JSON_INVALID');
  strictJson(value, L.jsonBytes, 'SOURCE_FILE_JSON_BUDGET');
  return value;
}
function redactedUrl(value) {
  const url = new URL(value);
  url.username = ''; url.password = ''; url.hash = '';
  for (const key of url.searchParams.keys()) url.searchParams.set(key, '[redacted]');
  return url.href;
}
function observationKey(item, entryUrl) {
  let path = item.url, message = item.message ?? '';
  try {
    const entry = new URL(entryUrl), prefix = entry.pathname.replace(/\/$/, '');
    if (item.url) {
      const observed = new URL(item.url); path = observed.pathname;
      if (observed.origin === entry.origin && prefix && (path === prefix || path.startsWith(prefix + '/'))) path = path.slice(prefix.length) || '/';
    }
    message = message.replaceAll(entry.origin + (prefix || ''), '[entry]');
  } catch { /* Legacy runner treats an unparseable observation URL as opaque. */ }
  return `${item.kind}|${item.status ?? ''}|${item.method ?? ''}|${path ?? ''}|${message}`;
}
function ruleOf(plan, route, facet, point) {
  const settleMs = Math.min(2000, plan.settleMs);
  return { facet, route, timeoutMs: plan.timeoutMs, settleMs, runMs: 300_000,
    network: { allowedMethods: ['GET', 'HEAD', 'OPTIONS'], webSockets: 'blocked', isolatedContexts: true, serviceWorkers: 'block', acceptDownloads: false, maxObservations: 100 },
    capture: { ...CAPTURE, scope: 'bounded-full-page', animations: 'disabled', caret: 'hide', repeatWaitMs: Math.max(80, settleMs), timeoutMs: Math.min(plan.timeoutMs, 10_000) },
    maskSelectors: [...new Set(plan.normalization.maskSelectors)].sort(),
    ...(['visual', 'structure'].includes(facet) ? { stabilityMinimum: 0.9995, maximumMaskedRatio: 0.8 } : {}),
    ...(facet === 'visual' ? { minimumScore: plan.thresholds.visual } : {}),
    ...(point ? { steps: copy(point.steps), assertions: copy(point.assertions) } : {}) };
}
function sourceIdentity(plan, environment, route, viewport, facet, expected, baseline, point) {
  return buildAcceptanceIdentity({ kind: 'browser', facet, route, viewport: { width: viewport.width, height: viewport.height },
    ...(point ? { pointId: point.id } : {}), environment, rule: ruleOf(plan, route, facet, point),
    oracle: facet === 'visual' ? { kind: 'runtime', source: plan.baselineUrl, baselineScreenshotSha256: baseline.image ? sha(baseline.image) : null }
      : { kind: 'runtime', source: plan.baselineUrl, expected: serialized(expected) } });
}
function pngPreflight(evidence) {
  const headers = new Map();
  let pixels = 0;
  for (const [file, bytes] of evidence) {
    if (!file.endsWith('.png')) continue;
    requireThat(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'SOURCE_PNG_INVALID');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    requireThat(width > 0 && height > 0 && width <= L.pngDimension && height <= L.pngDimension
      && width * height <= L.pngPixels, 'SOURCE_PNG_BUDGET');
    pixels += width * height;
    requireThat(pixels <= L.pngTotalPixels, 'SOURCE_PNG_TOTAL_BUDGET');
    // Chromium captures and the reviewed diff encoder emit non-interlaced
    // 8-bit RGB/RGBA. Walk every chunk before invoking pngjs: duplicate IHDR can
    // replace its allocation dimensions, and its interlaced inflate is unbound.
    requireThat(bytes[24] === 8 && [2, 6].includes(bytes[25])
      && bytes[26] === 0 && bytes[27] === 0 && bytes[28] === 0, 'SOURCE_PNG_INVALID');
    let offset = 8, chunks = 0, data = false, ended = false;
    while (offset < bytes.length) {
      requireThat(++chunks <= L.pngChunks && offset + 12 <= bytes.length, 'SOURCE_PNG_INVALID');
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      requireThat(length <= bytes.length - offset - 12, 'SOURCE_PNG_INVALID');
      if (chunks === 1) {
        requireThat(type === 'IHDR' && length === 13, 'SOURCE_PNG_INVALID');
      } else if (type === 'IDAT') {
        requireThat(!ended, 'SOURCE_PNG_INVALID');
        data = true;
      } else {
        // An intentionally narrow accepted capture format avoids other PNG
        // metadata changing decoder interpretation after the inspected header.
        requireThat(type === 'IEND' && length === 0 && data
          && offset + 12 === bytes.length, 'SOURCE_PNG_INVALID');
        ended = true;
      }
      offset += 12 + length;
    }
    requireThat(ended && offset === bytes.length, 'SOURCE_PNG_INVALID');
    headers.set(file, { width, height });
  }
  const comparisons = new Map(), decoded = new Set();
  const compare = (a, b) => {
    const key = `${a}|${b}`;
    if (!comparisons.has(key)) {
      const first = headers.get(a), second = headers.get(b);
      // comparePngBuffers allocates the bounding rectangle, which can be much
      // larger than either image (for example a tall image against a wide one).
      requireThat(first && second && Math.max(first.width, second.width) * Math.max(first.height, second.height)
        <= L.pngPixels, 'SOURCE_PNG_COMPARISON_BUDGET');
      try {
        const result = comparePngBuffers(evidence.get(a), evidence.get(b));
        requireThat(same(result.sourceSize, first) && same(result.cloneSize, second), 'SOURCE_PNG_INVALID');
        comparisons.set(key, result.score);
      }
      catch { throw new Rejection('SOURCE_PNG_INVALID'); }
      decoded.add(a); decoded.add(b);
    }
    return comparisons.get(key);
  };
  const assertDecoded = () => {
    for (const file of headers.keys()) if (!decoded.has(file)) {
      try {
        const image = PNG.sync.read(evidence.get(file));
        requireThat(image.width === headers.get(file).width && image.height === headers.get(file).height, 'SOURCE_PNG_INVALID');
      } catch { throw new Rejection('SOURCE_PNG_INVALID'); }
    }
  };
  return { headers, compare, assertDecoded };
}
function validateAssertions(results, point) {
  if (!point) { requireThat(results.length === 0, 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH'); return; }
  // Navigation/capture failures may leave no assertions at all. Their selected
  // side is rejected later; the other side remains valid historical material.
  requireThat(results.length === 0 || results.length === point.assertions.length, 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
  for (const [i, result] of results.entries()) {
    const a = point.assertions[i];
    requireThat(plain(result) && result.kind === a.kind && (result.selector ?? null) === (a.selector ?? null), 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
    if (Object.hasOwn(result, 'error')) {
      fields(result, ['kind', 'selector', 'passed', 'error'], ['kind', 'passed', 'error'], 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
      requireThat(result.passed === false && message(result.error), 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
      continue;
    }
    fields(result, ['kind', 'selector', 'attribute', 'expected', 'actual', 'passed'], ['kind', 'expected', 'actual', 'passed'], 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
    requireThat((result.attribute ?? null) === (a.attribute ?? null), 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
    requireThat(['visible', 'hidden'].includes(a.kind) ? typeof result.actual === 'boolean'
      : a.kind === 'attribute' ? result.actual === null || typeof result.actual === 'string'
        : typeof result.actual === 'string' && (a.kind !== 'text' || result.actual.length <= 300), 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
    const expected = a.equals !== undefined ? a.equals : a.contains !== undefined ? { contains: a.contains } : true;
    const passed = a.equals !== undefined ? result.actual === a.equals : a.contains !== undefined ? String(result.actual ?? '').includes(a.contains) : result.actual === true;
    requireThat(same(expected, result.expected) && result.passed === passed, 'SOURCE_OBSERVATION_ASSERTIONS_MISMATCH');
  }
}
function observationOf(evidence, png, plan, prefix, side, viewport, route, point) {
  const detailsFile = `${prefix}-${side}.json`, value = parse(evidence.get(detailsFile));
  const required = ['url','navigationError','httpStatus','errors','network','blockedRequests','assertions','stepError','snapshot','screenshot','repeatedScreenshot','stability','captureScope','captureLimited','documentSize','details'];
  fields(value, [...required, 'captureError'], required, 'SOURCE_OBSERVATION_INVALID');
  requireThat(value.details === detailsFile && value.url === redactedUrl(resolveAcceptanceUrl(plan[`${side}Url`], route))
    && (value.navigationError === null || message(value.navigationError))
    && (value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    && (value.stepError === null || message(value.stepError))
    && (!Object.hasOwn(value, 'captureError') || message(value.captureError)), 'SOURCE_OBSERVATION_INVALID');
  for (const key of ['errors','network','blockedRequests','assertions']) requireThat(Array.isArray(value[key]) && value[key].length <= (key === 'assertions' ? 20 : 100), 'SOURCE_OBSERVATION_INVALID');
  for (const key of ['errors','network','blockedRequests']) for (const item of value[key]) {
    requireThat(plain(item) && text(item.kind, 80), 'SOURCE_OBSERVATION_INVALID');
  }
  validateAssertions(value.assertions, point);
  requireThat(typeof value.captureLimited === 'boolean', 'SOURCE_OBSERVATION_INVALID');
  if (value.snapshot !== null) {
    const s = value.snapshot;
    fields(s, ['title','headings','controls','overflow','overflowingElements','maskedRatio','effectiveAreaPx','maskSamplingCapped','documentSize','bodyTextLength','url','captureScope','captureLimited'], undefined, 'SOURCE_SNAPSHOT_SEMANTICS_INVALID');
    requireThat(typeof s.title === 'string' && s.title.length <= 300 && Array.isArray(s.headings) && s.headings.length <= 20
      && s.headings.every(v => typeof v === 'string' && v.length <= 300) && Array.isArray(s.controls) && s.controls.length <= 80
      && typeof s.overflow === 'boolean' && Array.isArray(s.overflowingElements) && s.overflowingElements.length <= 12
      && finite(s.maskedRatio) && s.maskedRatio >= 0 && s.maskedRatio <= 1 && size(s.effectiveAreaPx)
      && s.effectiveAreaPx === Math.round(viewport.width * viewport.height * (1 - s.maskedRatio))
      && typeof s.maskSamplingCapped === 'boolean' && size(s.bodyTextLength)
      && typeof s.url === 'string' && redactedUrl(s.url) === s.url, 'SOURCE_SNAPSHOT_SEMANTICS_INVALID');
    for (const control of s.controls) {
      fields(control, ['path','tag','role','label','type','href','disabled','expanded','selected'], undefined, 'SOURCE_SNAPSHOT_SEMANTICS_INVALID');
      requireThat(typeof control.path === 'string' && typeof control.tag === 'string' && typeof control.label === 'string'
        && control.label.length <= 300 && typeof control.disabled === 'boolean'
        && ['role', 'type', 'href', 'expanded', 'selected'].every(key => control[key] === null || typeof control[key] === 'string'), 'SOURCE_SNAPSHOT_SEMANTICS_INVALID');
    }
    for (const overflow of s.overflowingElements) {
      fields(overflow, ['selector', 'right'], undefined, 'SOURCE_SNAPSHOT_SEMANTICS_INVALID');
      requireThat(typeof overflow.selector === 'string' && Number.isSafeInteger(overflow.right), 'SOURCE_SNAPSHOT_SEMANTICS_INVALID');
    }
    fields(value.documentSize, ['width','height'], undefined, 'SOURCE_CAPTURE_MISMATCH');
    requireThat(Number.isSafeInteger(value.documentSize.width) && value.documentSize.width >= viewport.width
      && Number.isSafeInteger(value.documentSize.height) && value.documentSize.height >= viewport.height
      && same(s.documentSize, value.documentSize), 'SOURCE_CAPTURE_MISMATCH');
    const limited = value.documentSize.height > CAPTURE.maxHeight || value.documentSize.width * value.documentSize.height > CAPTURE.maxPixels;
    requireThat(value.captureLimited === limited && s.captureLimited === limited
      && value.captureScope === (limited ? 'viewport-only' : 'full-page') && s.captureScope === value.captureScope, 'SOURCE_CAPTURE_MISMATCH');
  } else requireThat(value.documentSize === null && value.captureScope === null && value.captureLimited === false, 'SOURCE_OBSERVATION_INVALID');
  for (const [key, name] of [['screenshot', `${prefix}-${side}.png`], ['repeatedScreenshot', `${prefix}-${side}-repeat.png`]]) {
    requireThat(value[key] === null || value[key] === name && png.headers.has(name), 'SOURCE_EVIDENCE_ROLES_INVALID');
  }
  if (value.screenshot && value.repeatedScreenshot && finite(value.stability)) {
    requireThat(value.stability === png.compare(value.screenshot, value.repeatedScreenshot), 'SOURCE_STABILITY_MISMATCH');
    const a = png.headers.get(value.screenshot), b = png.headers.get(value.repeatedScreenshot);
    requireThat(same(a, b), 'SOURCE_CAPTURE_MISMATCH');
    if (!value.captureLimited) requireThat(same(a, value.documentSize), 'SOURCE_CAPTURE_MISMATCH');
  } else requireThat(value.stability === null, 'SOURCE_STABILITY_MISMATCH');
  return { ...value, details: detailsFile,
    image: value.screenshot && value.repeatedScreenshot && finite(value.stability) ? evidence.get(value.screenshot) : null };
}
const navigated = s => !s.navigationError && !s.captureError && s.httpStatus !== null && s.httpStatus < 400
  && !!s.snapshot && !!s.image && !!s.screenshot && !!s.repeatedScreenshot && finite(s.stability);
const healthy = s => navigated(s) && !s.errors.length && !s.network.length && !s.blockedRequests.length && !s.snapshot.overflow;
const structureOf = s => s.snapshot ? { title: s.snapshot.title, headings: s.snapshot.headings, controls: s.snapshot.controls } : null;
const maskOf = s => ({ maskedRatio: s.snapshot?.maskedRatio ?? null, effectiveAreaPx: s.snapshot?.effectiveAreaPx ?? null, samplingCapped: s.snapshot?.maskSamplingCapped ?? false });
const captureOf = s => ({ captureScope: s.captureScope, captureLimited: s.captureLimited, documentSize: s.documentSize });
const evidenceOf = (a, b) => ({ baselineScreenshot:a.screenshot,targetScreenshot:b.screenshot,baselineDetails:a.details,targetDetails:b.details,baselineRepeat:a.repeatedScreenshot,targetRepeat:b.repeatedScreenshot });

function rebuildChecks(plan, environment, route, viewport, prefix, baseline, target, png, point) {
  const common = { route, viewport: viewport.name,
    oracle: { kind: 'approved-runtime', source: plan.baselineUrl }, evidenceLevel: 'browser-reproduced' };
  const reproduction = [
    `Open ${resolveAcceptanceUrl(plan.baselineUrl, route)} at ${viewport.width}×${viewport.height}.`,
    `Open ${resolveAcceptanceUrl(plan.targetUrl, route)} in a fresh browser context at the same viewport.`,
  ];
  const make = (facet, title, dimension, expected, actual, status = 'passed', verdict = 'match', severity = 'medium') => ({
    ...common, id: `${prefix}-${facet}`,
    identity: sourceIdentity(plan, environment, route, viewport, facet, expected, baseline),
    title, dimension, expected, actual, status, verdict, severity,
    evaluationLimited: !['passed', 'failed'].includes(status), reproduction, evidence: evidenceOf(baseline, target),
  });
  if (point) {
    const baselinePassed = healthy(baseline) && !baseline.stepError
      && baseline.assertions.every(value => value.passed) && point.assertions.length > 0;
    const targetPassed = healthy(target) && !target.stepError && target.assertions.every(value => value.passed);
    const writeBlocked = baseline.blockedRequests.length || target.blockedRequests.length;
    const environmentFailed = !!(target.navigationError || target.captureError);
    const expected = { stepsComplete: !baseline.stepError, assertions: baseline.assertions, httpStatus: baseline.httpStatus };
    return [{ ...common, id: `${prefix}-${safeName(point.id)}`, title: point.title, dimension: 'behavior', severity: point.severity,
      identity: sourceIdentity(plan, environment, route, viewport, 'behavior', expected, baseline, point),
      status: writeBlocked || !baselinePassed || environmentFailed ? 'blocked' : targetPassed ? 'passed' : 'failed',
      verdict: writeBlocked ? 'environment' : !baselinePassed ? 'baseline_failed' : environmentFailed ? 'environment' : targetPassed ? 'match' : 'bug',
      evaluationLimited: !!(writeBlocked || !baselinePassed || environmentFailed), expected,
      actual: serialized({ stepsComplete: !target.stepError, stepError: target.stepError, assertions: target.assertions,
        httpStatus: target.httpStatus, navigationError: target.navigationError, errors: target.errors,
        network: target.network, overflow: target.snapshot?.overflow, blockedRequests: target.blockedRequests }),
      reproduction: [...reproduction, ...point.steps.map(step =>
        `${step.action} ${step.selector}${step.value !== undefined ? ` (${String(step.value).slice(0, 120)})` : ''}`)],
      evidence: evidenceOf(baseline, target),
    }];
  }
  const checks = [];
  if (!navigated(baseline)) {
    checks.push(make('navigation', '基线页面可访问', 'health', 'Approved runtime loads successfully.',
      { baseline: baseline.navigationError || baseline.captureError || baseline.httpStatus,
        target: target.navigationError || target.captureError || target.httpStatus }, 'blocked', 'baseline_failed', 'high'));
  } else if (!navigated(target)) {
    const environmentFailed = !!(target.navigationError || target.captureError);
    checks.push(make('navigation', '目标页面可访问', 'health', `HTTP ${baseline.httpStatus}`,
      target.navigationError || target.captureError || `HTTP ${target.httpStatus}`,
      environmentFailed ? 'blocked' : 'failed', environmentFailed ? 'environment' : 'bug', 'high'));
  } else {
    checks.push(make('navigation', '页面导航与 HTTP 状态', 'health', baseline.httpStatus, target.httpStatus));
  }
  for (const [facet, title, itemsOf] of [
    ['console', '浏览器脚本与控制台错误', side => side.errors],
    ['network', '资源与只读网络请求', side => side.network],
    ['overflow', '视口水平溢出', side => side.snapshot?.overflow ? [{ kind: 'overflow' }] : []],
  ]) {
    const before = itemsOf(baseline), after = itemsOf(target);
    const existing = new Set(before.map(value => observationKey(value, plan.baselineUrl)));
    const added = after.filter(value => !existing.has(observationKey(value, plan.targetUrl)));
    const policyAffected = ['console', 'network'].includes(facet)
      && (baseline.blockedRequests.length > 0 || target.blockedRequests.length > 0);
    const status = policyAffected || !navigated(baseline) || !navigated(target) ? 'blocked'
      : added.length ? 'failed' : before.length ? 'needs_review' : 'passed';
    const verdict = policyAffected ? 'environment' : !navigated(baseline) ? 'baseline_failed'
      : !navigated(target) ? 'environment' : added.length ? 'bug' : before.length ? 'baseline_failed' : 'match';
    checks.push(make(facet, title, 'health', before, { observed: after, added, policyAffected },
      status, verdict, facet === 'console' ? 'high' : 'medium'));
  }
  if (baseline.blockedRequests.length || target.blockedRequests.length) {
    checks.push(make('readonly', '只读执行安全边界', 'health', 'GET, HEAD and OPTIONS only.',
      { baseline: baseline.blockedRequests, target: target.blockedRequests }, 'blocked', 'environment'));
  }
  const before = structureOf(baseline), after = structureOf(target);
  const ready = healthy(baseline) && healthy(target) && baseline.snapshot.bodyTextLength > 0;
  const stable = baseline.stability >= 0.9995 && target.stability >= 0.9995;
  const maskCoverage = { baseline: maskOf(baseline), target: maskOf(target) };
  const maskLimited = baseline.snapshot?.maskedRatio > 0.8 || target.snapshot?.maskedRatio > 0.8
    || baseline.snapshot?.maskSamplingCapped || target.snapshot?.maskSamplingCapped;
  const match = JSON.stringify(before) === JSON.stringify(after);
  checks.push(make('structure', '标题、主标题与关键控件语义', 'structure', before, { ...after, maskCoverage },
    !ready ? 'blocked' : maskLimited ? 'needs_review' : match ? 'passed' : !stable ? 'needs_review' : 'failed',
    !healthy(baseline) || !baseline.snapshot?.bodyTextLength ? 'baseline_failed'
      : !healthy(target) ? 'environment' : maskLimited ? 'needs_review' : match ? 'match' : !stable ? 'needs_review' : 'bug', 'high'));
  const score = baseline.image && target.image ? png.compare(baseline.screenshot, target.screenshot) : null;
  const visualReady = healthy(baseline) && healthy(target), limited = baseline.captureLimited || target.captureLimited;
  let status = 'passed', verdict = 'match';
  if (!visualReady || score === null) {
    status = 'blocked'; verdict = !healthy(baseline) ? 'baseline_failed' : 'environment';
  } else if (maskLimited || limited || !stable) {
    status = 'needs_review'; verdict = 'needs_review';
  } else if (score < plan.thresholds.visual) {
    status = 'failed'; verdict = 'bug';
  }
  const visual = make('visual', '页面视觉还原度', 'visual',
    { minimumScore: plan.thresholds.visual, stabilityMinimum: 0.9995, maximumMaskedRatio: 0.8, captureBudget: CAPTURE },
    { score, baselineStability: baseline.stability, targetStability: target.stability, maskCoverage,
      capture: { baseline: captureOf(baseline), target: captureOf(target) }, eligible: visualReady && !maskLimited && !limited }, status, verdict);
  if (score !== null) {
    visual.score = score; visual.evidence = { ...visual.evidence, diff: `${prefix}-diff.png` };
  }
  checks.push(visual);
  return checks;
}

/** Full byte/legacy-semantics verification; normalized plan remains private. */
export function verifyBrowserBaselineMaterial(input, options) {
  try {
    fields(input, ['snapshot', 'files']);
    fields(options, ['sourceSide']);
    const { snapshot, files } = input, { sourceSide } = options;
    requireThat(['baseline', 'target'].includes(sourceSide), 'SOURCE_SIDE_UNSUPPORTED');
    strictJson(snapshot, L.snapshotBytes, 'SOURCE_SNAPSHOT_INVALID');
    fields(snapshot, ['manifest', 'report', 'integrity'], undefined, 'SOURCE_SNAPSHOT_INVALID');
    fields(snapshot.integrity, ['valid', 'evidenceVerified', 'errors', 'verifiedFiles', 'verifiedBytes', 'reportSha256'],
      undefined, 'SOURCE_INTEGRITY_FAILED');
    requireThat(snapshot.integrity.valid === true && snapshot.integrity.evidenceVerified === true
      && Array.isArray(snapshot.integrity.errors) && snapshot.integrity.errors.length === 0, 'SOURCE_INTEGRITY_FAILED');
    const read = byteReader(files);
    const manifestBytes = read('manifest.json', L.jsonBytes), reportBytes = read('report.json', L.jsonBytes);
    const manifest = parse(manifestBytes), report = parse(reportBytes);
    requireThat(same(manifest, snapshot.manifest) && same(report, snapshot.report), 'SOURCE_SNAPSHOT_BYTES_MISMATCH');
    requireThat(RUN.test(manifest.runId ?? '') && report.runId === manifest.runId
      && manifest.schemaVersion === 1 && report.schemaVersion === 1, 'SOURCE_RUN_IDENTITY_MISMATCH');
    requireThat(['mirror', 'regression'].includes(manifest.mode) && report.mode === manifest.mode
      && manifest.plan?.mode === manifest.mode, 'SOURCE_MODE_UNSUPPORTED');
    requireThat(manifest.status === 'completed' && report.status === 'completed', 'SOURCE_RUN_NOT_COMPLETE');
    requireThat(iso(report.startedAt) && iso(report.endedAt) && report.endedAt >= report.startedAt
      && manifest.endedAt === report.endedAt, 'SOURCE_REPORT_TIME_INVALID');
    requireThat(HASH.test(manifest.reportSha256 ?? '') && sha(reportBytes) === manifest.reportSha256
      && snapshot.integrity.reportSha256 === manifest.reportSha256, 'SOURCE_REPORT_DIGEST_MISMATCH');
    let plan;
    try { plan = normalizeAcceptancePlan(manifest.plan); }
    catch { throw new Rejection('SOURCE_PLAN_INVALID'); }
    requireThat(same(plan, manifest.plan), 'SOURCE_PLAN_NOT_NORMALIZED');
    requireThat(plan.baselineUrl === manifest.baselineUrl && plan.targetUrl === manifest.targetUrl
      && report.baselineUrl === plan.baselineUrl && report.targetUrl === plan.targetUrl
      && manifest.name === plan.name && report.name === plan.name, 'SOURCE_PLAN_CONTEXT_MISMATCH');
    const sourcePlanDigest = sha(JSON.stringify(manifest.plan));
    requireThat(report.planFingerprint === sourcePlanDigest, 'SOURCE_PLAN_DIGEST_MISMATCH');
    requireThat(SUPPORTED_BROWSER_VERIFIERS_V1.includes(report.verifierFingerprint), 'SOURCE_VERIFIER_UNSUPPORTED');
    fields(report.environment, ENVIRONMENT, undefined, 'SOURCE_ENVIRONMENT_INVALID');
    requireThat(ENVIRONMENT.every(key => text(report.environment[key], 200)) && report.environment.browser === 'chromium'
      && Object.keys(PROFILE).every(key => report.environment[key] === PROFILE[key]), 'SOURCE_ENVIRONMENT_INVALID');
    fields(report.safety, ['networkPolicy', 'isolatedContexts', 'blockedRequests'], undefined, 'SOURCE_SAFETY_MISMATCH');
    requireThat(report.safety.networkPolicy === 'read-only' && report.safety.isolatedContexts === true
      && size(report.safety.blockedRequests), 'SOURCE_SAFETY_MISMATCH');
    requireThat(Array.isArray(report.checks) && report.checks.length > 0 && report.checks.length <= 240
      && Array.isArray(report.evidenceManifest) && report.evidenceManifest.length <= L.evidenceFiles, 'SOURCE_CHECK_SLOTS_MISMATCH');
    const index = new Map(), references = new Set(), checks = new Map();
    for (const entry of report.evidenceManifest) {
      fields(entry, ['file', 'bytes', 'sha256'], undefined, 'SOURCE_EVIDENCE_INDEX_INVALID');
      requireThat(typeof entry.file === 'string' && FILE.test(entry.file)
        && !['manifest.json', 'report.json'].includes(entry.file.toLowerCase()) && size(entry.bytes)
        && HASH.test(entry.sha256 ?? '') && !index.has(entry.file), 'SOURCE_EVIDENCE_INDEX_INVALID');
      index.set(entry.file, entry);
    }
    for (const check of report.checks) {
      requireThat(plain(check) && text(check.id, 240) && !checks.has(check.id), 'SOURCE_CHECK_SLOTS_MISMATCH');
      checks.set(check.id, check);
      fields(check.evidence, [...ROLES, 'diff'], ROLES, 'SOURCE_EVIDENCE_ROLES_INVALID');
      for (const [role, file] of Object.entries(check.evidence)) {
        requireThat(file === null && role !== 'diff' && !role.endsWith('Details')
          || typeof file === 'string' && FILE.test(file), 'SOURCE_EVIDENCE_REFERENCE_INVALID');
        if (file !== null) references.add(file);
      }
    }
    const evidence = new Map(), verified = [];
    let verifiedBytes = 0;
    requireThat(references.size <= L.evidenceFiles, 'SOURCE_EVIDENCE_BUDGET');
    for (const file of [...references].sort()) {
      const entry = index.get(file);
      requireThat(!!entry, 'SOURCE_EVIDENCE_NOT_INDEXED');
      requireThat(entry.bytes <= L.evidenceFileBytes && verifiedBytes + entry.bytes <= L.evidenceBytes, 'SOURCE_EVIDENCE_BUDGET');
      const bytes = read(file, L.evidenceFileBytes);
      requireThat(bytes.length === entry.bytes && sha(bytes) === entry.sha256, 'SOURCE_EVIDENCE_DIGEST_MISMATCH');
      verifiedBytes += bytes.length; evidence.set(file, bytes); verified.push(copy(entry));
    }
    requireThat(snapshot.integrity.verifiedFiles === verified.length
      && snapshot.integrity.verifiedBytes === verifiedBytes, 'SOURCE_VERIFIED_INDEX_MISMATCH');
    const png = pngPreflight(evidence), expectedChecks = [], selected = [], slots = [], rules = [], oracles = [], selectedEvidence = [];
    let blockedRequests = 0;
    for (const [routeIndex, route] of plan.routes.entries()) {
      for (const [viewportIndex, viewport] of plan.viewports.entries()) {
        const basePrefix = `route-${routeIndex + 1}-${viewportIndex + 1}-${safeName(viewport.name)}`;
        const observations = [
          { prefix: basePrefix, point: null },
          ...plan.points.map((point, i) => ({ point, prefix: `${basePrefix}-point-${i + 1}` })).filter(value => value.point.route === route),
        ];
        for (const { prefix, point } of observations) {
          const baseline = observationOf(evidence, png, plan, prefix, 'baseline', viewport, route, point);
          const target = observationOf(evidence, png, plan, prefix, 'target', viewport, route, point);
          blockedRequests += baseline.blockedRequests.length + target.blockedRequests.length;
          const rebuilt = rebuildChecks(plan, report.environment, route, viewport, prefix, baseline, target, png, point);
          for (const expected of rebuilt) {
            const actual = checks.get(expected.id);
            requireThat(!!actual, 'SOURCE_CHECK_SLOT_MISSING');
            // A point can additionally become limited at its final deadline
            // check. Retain that unobservable fact; do not claim execution.
            const actualComparable = copy(actual);
            if (point && actual.evaluationLimited === true && expected.evaluationLimited === false) {
              actualComparable.evaluationLimited = false;
            }
            requireThat(same(serialized(expected), actualComparable), 'SOURCE_CHECK_SEMANTICS_MISMATCH');
            expectedChecks.push(expected);
          }
          const side = sourceSide === 'baseline' ? baseline : target;
          requireThat(healthy(side) && side.httpStatus >= 200 && side.snapshot.bodyTextLength > 0 && !side.stepError
            && side.assertions.length === (point?.assertions.length ?? 0) && side.assertions.every(value => value.passed === true)
            && side.captureLimited === false && side.captureScope === 'full-page' && !side.snapshot.maskSamplingCapped
            && side.snapshot.maskedRatio <= 0.8 && side.stability >= 0.9995, 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE');
          const slot = { route, viewport: { width: viewport.width, height: viewport.height }, ...(point ? { pointId: point.id } : {}) };
          const roles = { details: side.details, screenshot: side.screenshot, repeat: side.repeatedScreenshot };
          const selectedFiles = Object.fromEntries(Object.entries(roles).map(([role, file]) =>
            [role, { file, bytes: evidence.get(file).length, sha256: sha(evidence.get(file)) }]));
          selectedEvidence.push({ slot, roles: selectedFiles });
          const expected = { httpStatus: side.httpStatus, structure: structureOf(side), screenshotSha256: selectedFiles.screenshot.sha256,
            ...(point ? { steps: copy(point.steps), assertions: copy(point.assertions), observedAssertions: copy(side.assertions) } : {}) };
          // The report oracle retains old-baseline provenance. Rebuild the new
          // oracle exclusively from the explicitly selected side and its bytes.
          oracles.push({ slot, oracle: { kind: 'captured-browser-side', entryUrl: plan[`${sourceSide}Url`], ...expected } });
          for (const facet of point ? ['behavior'] : FACETS) {
            const caseSlot = { ...slot, facet };
            slots.push(caseSlot); rules.push({ slot: caseSlot, rule: ruleOf(plan, route, facet, point) });
          }
          selected.push({ slot, viewportName: viewport.name, ...(point ? { title: point.title, severity: point.severity } : {}),
            plannedUrl: resolveAcceptanceUrl(plan[`${sourceSide}Url`], route), observedFinalUrl: side.snapshot.url,
            finalUrlProof: 'redacted-observation-only', evidence: selectedFiles, expected,
            capture: captureOf(side), mask: maskOf(side), stability: side.stability,
            ...(point ? { steps: copy(point.steps), assertions: copy(point.assertions) } : {}),
          });
        }
      }
    }
    requireThat(expectedChecks.length === checks.size, 'SOURCE_CHECK_SLOTS_MISMATCH');
    fields(report.coverage, ['planned', 'completed', 'capped'], undefined, 'SOURCE_COVERAGE_INCOMPLETE');
    requireThat(report.coverage.planned === expectedChecks.length && report.coverage.completed === expectedChecks.length
      && report.coverage.capped === false, 'SOURCE_COVERAGE_INCOMPLETE');
    requireThat(report.safety.blockedRequests === blockedRequests, 'SOURCE_SAFETY_MISMATCH');
    const summarized = summarizeAcceptanceReport(report);
    requireThat(same(summarized.summary, report.summary) && same(manifest.summary, report.summary)
      && summarized.gate === report.gate && manifest.gate === report.gate && report.summary.missing === 0
      && report.summary.invalid === 0, 'SOURCE_REPORT_SUMMARY_MISMATCH');
    png.assertDecoded();
    const sort = (a, b) => {
      const x = canonicalAcceptanceJson(a.slot ?? a), y = canonicalAcceptanceJson(b.slot ?? b);
      return x < y ? -1 : x > y ? 1 : 0;
    };
    slots.sort(sort); rules.sort(sort); oracles.sort(sort); selectedEvidence.sort(sort); selected.sort(sort);
    const projection = { projectionVersion: 1, mode: 'browser',
      source: { runId: manifest.runId, sourceMode: plan.mode, side: sourceSide, entryUrl: plan[`${sourceSide}Url`] },
      sourcePlanDigest, sourceReportDigest: manifest.reportSha256,
      evidenceManifestDigest: digest('verified-evidence', verified),
      selectedEvidenceManifestDigest: digest('selected-evidence', selectedEvidence),
      scopeKey: digest('scope', slots), ruleManifestKey: digest('rules', rules), oracleManifestKey: digest('oracle', oracles),
      environmentKey: digest('environment', report.environment), verifierFingerprint: report.verifierFingerprint,
    };
    projection.contentDigest = digest('content', projection);
    const preview = { projectionVersion: 1, mode: 'browser', sourceReference: copy(projection.source), name: plan.name,
      sourceStatus: report.status, sourceGate: report.gate, declaredSlots: slots.length, projectedSlots: slots.length,
      observations: selected, rules, omissions: [], executionReady: false, oracleStorage: 'captured-side-evidence',
      environment: copy(report.environment), verifierFingerprint: report.verifierFingerprint,
      urlProof: { planned: 'exact-normalized-plan', observedFinal: 'query-values-redacted; no complete redirect-chain or final-query proof' },
      reviewNotice: '人工复核的是明确所选侧的已保存截图、结构与已声明操作；原比较门禁仍保留。观测仅覆盖声明槽位、有界语义摘要和两次截图，不证明全部业务正确、持续稳定、最终完整查询参数、部署内容冻结或目录归属。此投影不会批准、选用或启动运行。',
    };
    requireThat(Buffer.byteLength(JSON.stringify(preview)) <= L.previewBytes, 'SOURCE_PREVIEW_BUDGET');
    return { projection, preview, plan, manifests: copy({ scope: slots, rules, selectedOracles: oracles,
      selectedEvidence, verifiedEvidence: verified }) };
  } catch (cause) {
    const reason = cause instanceof Rejection ? cause.reason : 'SOURCE_INPUT_INVALID';
    const integrity = /(?:INTEGRITY|DIGEST|BYTES|FILE_|FILES_|EVIDENCE_|VERIFIED_INDEX|PNG_INVALID)/.test(reason);
    throw new AcceptanceCatalogError(integrity ? 'SOURCE_INTEGRITY_FAILED' : 'SOURCE_NOT_ELIGIBLE', 409,
      integrity ? 'Browser 来源原件或引用证据未通过完整性核验。' : 'Browser 来源未满足完整所选侧资格。', { reason });
  }
}

/** Public projection never exposes the private normalized plan or raw bytes. */
export function projectBrowserBaselineCandidate(input, options) {
  const { projection, preview } = verifyBrowserBaselineMaterial(input, options);
  return { projection, preview };
}
