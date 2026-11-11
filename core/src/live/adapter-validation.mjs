/**
 * live/adapter-validation — deterministic B2 validation for observed replay adapters.
 *
 * The adapter is generated from the training split only. Held-out requests are
 * sent to that local module and compared without retaining request or response values.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isObservedApiEntry } from './contract.mjs';
import { normalizeUrl } from './har.mjs';

const JSON_MIME = /^(?:application\/(?:[a-z0-9.+-]+\+)?json|text\/json)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HASH = /^[0-9a-f]{16,}$/i;
const DEFAULT_HOLDOUT_RATIO = 0.2;
const MIN_SAMPLES_FOR_HOLDOUT = 3;
const MAX_RESULTS = 200;

function mimeOf(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase() || 'application/octet-stream';
}

function templatePath(pathname) {
  const trailing = pathname.length > 1 && pathname.endsWith('/') ? '/' : '';
  const segments = pathname.split('/').filter(Boolean).map(segment => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    if (/^\d+$/.test(decoded)) return '{n}';
    if (UUID.test(decoded)) return '{uuid}';
    if (LONG_HASH.test(decoded)) return '{id}';
    return segment;
  });
  return '/' + segments.join('/') + trailing;
}

function entryUrl(entry) {
  try { return new URL(entry.url); } catch { return null; }
}

function endpointKey(entry) {
  const url = entryUrl(entry);
  if (!url) return null;
  return `${String(entry.method ?? 'GET').toUpperCase()} ${templatePath(url.pathname)}`;
}

function requestKey(entry) {
  return `${String(entry.method ?? 'GET').toUpperCase()} ${normalizeUrl(entry.url)}`;
}

function entryFingerprint(entry) {
  return createHash('sha256').update(JSON.stringify([
    String(entry.method ?? 'GET').toUpperCase(),
    normalizeUrl(entry.url),
    Number(entry.status) || 0,
    mimeOf(entry.mimeType),
    entry.body ?? null,
  ])).digest('hex');
}

function bodyValue(entry) {
  if (typeof entry?.body !== 'string' || entry.bodyEncoding !== 'base64') {
    return { mimeType: mimeOf(entry?.mimeType), json: null, readable: false };
  }
  let raw;
  try { raw = Buffer.from(entry.body, 'base64'); } catch { return { mimeType: mimeOf(entry?.mimeType), json: null, readable: false }; }
  const mimeType = mimeOf(entry.mimeType);
  if (!JSON_MIME.test(mimeType)) return { mimeType, json: null, readable: true };
  try { return { mimeType, json: JSON.parse(raw.toString('utf8')), readable: true }; }
  catch { return { mimeType, json: null, readable: false }; }
}

function shapeOf(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const shapes = [];
    for (const item of value) {
      const shape = shapeOf(item);
      if (!shapes.some(existing => JSON.stringify(existing) === JSON.stringify(shape))) shapes.push(shape);
    }
    shapes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { type: 'array', items: shapes.length === 1 ? shapes[0] : shapes };
  }
  if (typeof value === 'object') {
    const properties = {};
    for (const key of Object.keys(value).sort()) properties[key] = shapeOf(value[key]);
    return { type: 'object', properties };
  }
  return { type: typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value };
}

function primitiveFields(value, path = '$', output = new Map()) {
  if (value === null || typeof value !== 'object') {
    output.set(path, { path, value });
    return output;
  }
  if (Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) primitiveFields(child, `${path}.${key}`, output);
  return output;
}

function stableFields(values) {
  if (!values.length) return [];
  const fields = new Map();
  for (const value of values) {
    for (const [path, field] of primitiveFields(value)) {
      const item = fields.get(path) ?? { path, values: [] };
      item.values.push(field.value);
      fields.set(path, item);
    }
  }
  return [...fields.values()]
    .filter(item => item.values.length === values.length
      && item.values.every(value => JSON.stringify(value) === JSON.stringify(item.values[0])))
    .map(({ path, values: fieldValues }) => ({ path, value: fieldValues[0] }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function valueAtPath(value, path) {
  if (path === '$') return value;
  let current = value;
  for (const segment of path.slice(2).split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function queryNames(entry) {
  const url = entryUrl(entry);
  return url ? new Set([...url.searchParams.keys()].map(key => key.toLowerCase())) : new Set();
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => entryFingerprint(a).localeCompare(entryFingerprint(b)));
}

function routeCoverage(entries) {
  const routes = new Map();
  for (const entry of entries) {
    const endpoint = endpointKey(entry);
    if (!endpoint) continue;
    const [method, ...pathParts] = endpoint.split(' ');
    const current = routes.get(endpoint) ?? {
      method, path: pathParts.join(' '), queryParams: [], responseBody: 'unavailable',
      writeVerification: ['GET', 'HEAD'].includes(method) ? 'not_applicable' : 'unverified',
    };
    current.queryParams = [...new Set([...current.queryParams, ...queryNames(entry)])].sort();
    if (bodyValue(entry).readable) current.responseBody = 'observed';
    routes.set(endpoint, current);
  }
  return [...routes.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function offlineGapLedger(trainingEntries, heldoutEntries) {
  const knownRoutes = routeCoverage(trainingEntries);
  const knownParams = new Map(knownRoutes.map(route => [`${route.method} ${route.path}`, new Set(route.queryParams)]));
  const gaps = new Map();
  for (const entry of heldoutEntries) {
    const url = entryUrl(entry);
    const endpoint = endpointKey(entry);
    if (!url || !endpoint) continue;
    const [method, ...pathParts] = endpoint.split(' ');
    const path = pathParts.join(' ');
    const params = [...queryNames(entry)];
    const uncovered = params.filter(name => !knownParams.get(endpoint)?.has(name));
    if (!uncovered.length) continue;
    const key = `${method} ${path}|${uncovered.join(',')}`;
    const current = gaps.get(key) ?? {
      method, path, queryParams: uncovered, count: 0,
      categories: ['uncovered-query-parameter'], nearestRoutes: [],
    };
    current.count++;
    gaps.set(key, current);
  }
  const missingResponseBodies = knownRoutes.filter(route => route.responseBody !== 'observed').length;
  const unverifiedWrites = knownRoutes.filter(route => route.writeVerification === 'unverified').length;
  const gapItems = [...gaps.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  return {
    schema: 'heimdall.adapter-gap-ledger/1', source: 'offline-observation', status: 'offline-observed',
    summary: {
      runtimeRequests: 0, uniqueGaps: gapItems.length, unobservedPaths: 0,
      uncoveredQueryParameters: gapItems.length, missingResponseBodies, unverifiedWrites,
    },
    knownRoutes, gaps: gapItems,
    unknowns: ['authentication-permission-unknown', 'business-state-unknown',
      ...(missingResponseBodies ? ['missing-response-body'] : []),
      ...(unverifiedWrites ? ['unverified-write'] : []),
      ...(gapItems.length ? ['uncovered-query-parameter'] : [])],
  };
}

/** Split eligible API observations by endpoint, reserving 20% for held-out validation. */
export function splitObservedApiEntries(entries, { origin = '', holdoutRatio = DEFAULT_HOLDOUT_RATIO } = {}) {
  if (!(holdoutRatio > 0 && holdoutRatio < 1)) throw new TypeError('holdoutRatio must be between 0 and 1');
  const eligible = [];
  let excluded = 0;
  for (const entry of entries ?? []) {
    if (!isObservedApiEntry(entry, origin)) { excluded++; continue; }
    eligible.push(entry);
  }
  const unique = [];
  const seen = new Set();
  let duplicateEntries = 0;
  for (const entry of sortEntries(eligible)) {
    const key = requestKey(entry);
    if (seen.has(key)) { duplicateEntries++; continue; }
    seen.add(key);
    unique.push(entry);
  }
  const groups = new Map();
  for (const entry of unique) {
    const key = endpointKey(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const train = [];
  const heldout = [];
  const endpoints = [];
  for (const [endpoint, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = sortEntries(group);
    const holdout = ordered.length >= MIN_SAMPLES_FOR_HOLDOUT
      ? Math.min(ordered.length - 1, Math.max(1, Math.floor(ordered.length * holdoutRatio)))
      : 0;
    train.push(...ordered.slice(0, ordered.length - holdout));
    heldout.push(...ordered.slice(ordered.length - holdout));
    endpoints.push({ endpoint, total: ordered.length, train: ordered.length - holdout, heldout: holdout,
      status: holdout ? 'heldout' : 'insufficient-samples' });
  }
  return {
    total: entries?.length ?? 0,
    eligible: unique.length,
    excluded,
    duplicateEntries,
    train,
    heldout,
    endpoints,
  };
}

function reasonAdd(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function compareHeldout(entry, response, trainingForEndpoint) {
  const reasons = [];
  const actualMime = mimeOf(response.headers.get('content-type'));
  const expectedMime = mimeOf(entry.mimeType);
  const provenance = response.headers.get('x-heimdall-provenance');
  if (!provenance) reasonAdd(reasons, 'unobserved-path');
  if (response.status !== Number(entry.status)) reasonAdd(reasons, 'status-mismatch');
  if (actualMime !== expectedMime) reasonAdd(reasons, 'mime-mismatch');

  const expectedBody = bodyValue(entry);
  const actualBuffer = response.bodyBuffer;
  let actualJson = null;
  let actualReadable = true;
  if (JSON_MIME.test(actualMime)) {
    try { actualJson = JSON.parse(actualBuffer.toString('utf8')); }
    catch { actualReadable = false; }
    if (!expectedBody.readable || !actualReadable) reasonAdd(reasons, 'json-schema-unverified');
    else if (JSON.stringify(shapeOf(actualJson)) !== JSON.stringify(shapeOf(expectedBody.json))) reasonAdd(reasons, 'json-schema-mismatch');
  }

  const trainingValues = trainingForEndpoint.map(item => bodyValue(item).json).filter(value => value !== null);
  if (expectedBody.json !== null && actualJson !== null && trainingValues.length) {
    for (const field of stableFields(trainingValues)) {
      if (JSON.stringify(valueAtPath(actualJson, field.path)) !== JSON.stringify(valueAtPath(expectedBody.json, field.path))) {
        reasonAdd(reasons, 'stable-field-mismatch');
        break;
      }
    }
  }
  return { passed: reasons.length === 0, reasons, status: reasons.includes('json-schema-unverified') ? 'unverified' : reasons.length ? 'failed' : 'passed',
    expectedStatus: Number(entry.status), actualStatus: response.status, expectedMime, actualMime };
}

/** Validate the generated module against held-out observations without retaining values. */
export async function validateObservedReplayAdapter(adapter, { trainingEntries = [], heldoutEntries = [] } = {}) {
  const split = { train: trainingEntries, heldout: heldoutEntries };
  const endpointTraining = new Map();
  const endpointParams = new Map();
  for (const entry of split.train) {
    const key = endpointKey(entry);
    if (!key) continue;
    endpointTraining.set(key, [...(endpointTraining.get(key) ?? []), entry]);
    const params = endpointParams.get(key) ?? new Set();
    for (const name of queryNames(entry)) params.add(name);
    endpointParams.set(key, params);
  }
  const byEndpoint = new Map();
  const results = [];
  const temp = mkdtempSync(join(tmpdir(), 'heimdall-adapter-validation-'));
  try {
    const modulePath = join(temp, 'index.mjs');
    writeFileSync(modulePath, adapter.moduleSource);
    const module = await import(pathToFileURL(modulePath).href + `?t=${Date.now()}`);
    if (typeof module.handle !== 'function') throw new Error('generated adapter handle is missing');
    for (const entry of split.heldout.slice(0, MAX_RESULTS)) {
      const url = entryUrl(entry);
      const endpoint = endpointKey(entry) ?? '[invalid endpoint]';
      const params = endpointParams.get(endpoint) ?? new Set();
      const uncoveredParams = [...queryNames(entry)].filter(name => !params.has(name)).sort();
      const init = { method: String(entry.method ?? 'GET').toUpperCase() };
      const response = await module.handle(new Request(`http://adapter.local${url.pathname}${url.search}`, init));
      const bodyBuffer = Buffer.from(await response.arrayBuffer());
      const compared = compareHeldout(entry, { status: response.status, headers: response.headers, bodyBuffer }, endpointTraining.get(endpoint) ?? []);
      for (const param of uncoveredParams) reasonAdd(compared.reasons, `uncovered-param:${param}`);
      if (uncoveredParams.length) compared.passed = false;
      if (compared.passed) compared.status = 'passed';
      else if (compared.status !== 'unverified') compared.status = 'failed';
      const item = { endpoint, path: url.pathname, status: compared.status, passed: compared.passed,
        reasons: compared.reasons, expectedStatus: compared.expectedStatus, actualStatus: compared.actualStatus,
        expectedMime: compared.expectedMime, actualMime: compared.actualMime };
      results.push(item);
      const bucket = byEndpoint.get(endpoint) ?? { endpoint, train: endpointTraining.get(endpoint)?.length ?? 0, heldout: 0, passed: 0, failed: 0, unverified: 0 };
      bucket.heldout++;
      if (item.status === 'passed') bucket.passed++;
      else if (item.status === 'unverified') bucket.unverified++;
      else bucket.failed++;
      byEndpoint.set(endpoint, bucket);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }

  const passed = results.filter(item => item.status === 'passed').length;
  const failed = results.filter(item => item.status === 'failed').length;
  const unverified = results.filter(item => item.status === 'unverified').length;
  const omitted = Math.max(0, split.heldout.length - results.length);
  const unknowns = [];
  for (const endpoint of split.train.length ? [] : ['no-training-samples']) unknowns.push(endpoint);
  if (!split.heldout.length) unknowns.push('heldout-set-empty');
  if (omitted) unknowns.push(`heldout-results-truncated:${omitted}`);
  for (const endpoint of [...new Set(split.heldout.map(endpointKey))]) {
    const sampleCount = [...split.train, ...split.heldout].filter(entry => endpointKey(entry) === endpoint).length;
    if (sampleCount < MIN_SAMPLES_FOR_HOLDOUT) unknowns.push(`insufficient-samples:${endpoint}`);
  }
  return {
    schema: 'heimdall.adapter-report/1',
    tier: 'B2',
    generatedFrom: 'training-only',
    threshold: { heldoutEquivalence: 0.9 },
    split: { train: split.train.length, heldout: split.heldout.length },
    results: { heldout: split.heldout.length, validated: results.length, omitted, passed, failed, unverified,
      equivalence: results.length ? +(passed / results.length).toFixed(4) : null,
      status: omitted ? 'not-validated'
        : results.length && passed / results.length >= 0.9 && unverified === 0 ? 'passed'
          : results.length ? 'failed' : 'not-validated' },
    byEndpoint: [...byEndpoint.values()].map(item => ({ ...item, status: item.failed || item.unverified ? 'failed' : 'passed' })),
    failures: results.filter(item => !item.passed),
    gapLedger: offlineGapLedger(split.train, split.heldout),
    unknowns,
    limitation: 'B2 只验证已观察端点的脱敏响应形状，不证明认证、权限、状态机、业务规则或真实副作用等价。',
  };
}
