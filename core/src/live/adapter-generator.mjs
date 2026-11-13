/**
 * live/adapter-generator — 从显式允许的 API HAR 生成观察回放适配器。
 *
 * 这是 B1 到 B2 的桥接产物：它只回放已观察到的响应，不推断权限、状态机或副作用。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PUBLIC_DATA_BYTES, isPrivateText, parseReplayJson, scrubPublicJsonValue } from './har.mjs';
import { isObservedApiEntry } from './contract.mjs';

const MAX_ROUTES = 200;
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const JSON_MIME = /^(?:application\/(?:[a-z0-9.+-]+\+)?json|text\/json)$/i;

function mimeOf(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase() || 'application/octet-stream';
}

function bodyOf(entry) {
  if (typeof entry?.body !== 'string' || entry.bodyEncoding !== 'base64') return { body: null, redacted: false };
  let raw;
  try { raw = Buffer.from(entry.body, 'base64'); } catch { return { body: null, redacted: true }; }
  if (raw.length > MAX_PUBLIC_DATA_BYTES) return { body: null, redacted: true };
  const mime = mimeOf(entry.mimeType);
  if (JSON_MIME.test(mime)) {
    let value;
    try { value = parseReplayJson(raw.toString('utf8')); } catch { return { body: null, redacted: true }; }
    const safe = scrubPublicJsonValue(value);
    if (safe === undefined) return { body: null, redacted: true };
    const text = JSON.stringify(safe);
    return { body: Buffer.from(text, 'utf8').toString('base64'), redacted: text !== raw.toString('utf8') };
  }
  if (isPrivateText(raw.toString('utf8'))) return { body: null, redacted: true };
  return { body: entry.body, redacted: false };
}

function fixtureOf(entry) {
  let url;
  try { url = new URL(entry.url); } catch { return null; }
  const body = bodyOf(entry);
  return {
    method: String(entry.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    search: url.search,
    status: Number.isInteger(entry.status) ? entry.status : Number(entry.status) || 500,
    mimeType: mimeOf(entry.mimeType),
    body: body.body,
    redacted: body.redacted,
  };
}

function safeAdapterPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
    || path.includes('\\') || /[?#]/.test(path) || /%(?:2f|5c)/i.test(path)) return false;
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  return decoded !== '/' && decoded !== '/static' && !decoded.startsWith('/static/')
    && decoded !== '/__heimdall' && !decoded.startsWith('/__heimdall/')
    && decoded !== '/lm' && !decoded.startsWith('/lm/');
}

const fixtureKey = fixture => `${fixture.method} ${fixture.path}${fixture.search}`;
const routeKey = fixture => `${fixture.method} ${fixture.path}`;

function queryNames(search) {
  try { return [...new Set([...new URL('http://adapter.local' + search).searchParams.keys()].map(name => name.toLowerCase()))].sort(); }
  catch { return []; }
}

function routeMetadata(fixtures) {
  const routes = new Map();
  for (const fixture of fixtures) {
    const key = routeKey(fixture);
    const current = routes.get(key) ?? {
      method: fixture.method, path: fixture.path, queryParams: [],
      responseBody: 'unavailable',
      writeVerification: ['GET', 'HEAD'].includes(fixture.method) ? 'not_applicable' : 'unverified',
    };
    current.queryParams = [...new Set([...current.queryParams, ...queryNames(fixture.search)])].sort();
    if (fixture.body != null) current.responseBody = 'observed';
    routes.set(key, current);
  }
  return [...routes.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function initialGapLedger(routes) {
  const missingResponseBodies = routes.filter(route => route.responseBody !== 'observed').length;
  const unverifiedWrites = routes.filter(route => route.writeVerification === 'unverified').length;
  return {
    schema: 'heimdall.adapter-gap-ledger/1', source: 'training-only', status: 'not-run',
    summary: {
      runtimeRequests: 0, uniqueGaps: 0, unobservedPaths: 0, unobservedQueryVariants: 0, uncoveredQueryParameters: 0,
      missingResponseBodies, unverifiedWrites,
    },
    knownRoutes: routes, gaps: [],
    unknowns: ['authentication-permission-unknown', 'business-state-unknown',
      ...(missingResponseBodies ? ['missing-response-body'] : []),
      ...(unverifiedWrites ? ['unverified-write'] : [])],
  };
}

function moduleSource(fixtures, fallbacks, metadata) {
  return `// Generated from sanitized API HAR. Observed replay only; not backend equivalence.\n` +
    `const fixtures = ${JSON.stringify(fixtures)};\n` +
    `const exact = new Map(fixtures.map(item => [item.key, item]));\n` +
    `const fallbacks = new Map(${JSON.stringify(fallbacks)});\n` +
    `const routeMetadata = ${JSON.stringify(metadata)};\n` +
    `const routeMeta = new Map(routeMetadata.routes.map(item => [item.method + ' ' + item.path, item]));\n` +
    `export const __heimdallAdapter = routeMetadata;\n` +
    `function queryNames(url) { return [...new Set([...url.searchParams.keys()].map(name => name.toLowerCase()))].sort(); }\n` +
    `async function recordGap(context, url, category) {\n` +
    `  if (typeof context?.recordGap !== 'function') return;\n` +
    `  const method = requestMethod(context);\n` +
    `  const known = routeMeta.get(method + ' ' + url.pathname);\n` +
    `  const params = queryNames(url);\n` +
    `  await context.recordGap({ method, path: url.pathname, queryParams: params, category, knownQueryParams: known?.queryParams ?? [] });\n` +
    `}\n` +
    `function requestMethod(context) { return context?.method ?? 'GET'; }\n` +
    `export async function handle(request, context = {}) {\n` +
    `  const url = new URL(request.url);\n` +
    `  const key = request.method + ' ' + url.pathname + url.search;\n` +
    `  const exactFixture = exact.get(key);\n` +
    `  const fixture = exactFixture || fallbacks.get(request.method + ' ' + url.pathname);\n` +
    `  const known = routeMeta.get(request.method + ' ' + url.pathname);\n` +
    `  const params = queryNames(url);\n` +
    `  const uncovered = known ? params.filter(name => !known.queryParams.includes(name)) : [];\n` +
    `  if (!fixture) { await recordGap({ ...context, method: request.method }, url, known ? (uncovered.length ? 'uncovered-query-parameter' : 'unobserved-query-variant') : 'unobserved-path'); return Response.json({ error: 'unobserved-route' }, { status: 404 }); }\n` +
    `  if (!exactFixture && url.search) await recordGap({ ...context, method: request.method }, url, uncovered.length ? 'uncovered-query-parameter' : 'unobserved-query-variant');\n` +
    `  const headers = { 'content-type': fixture.mimeType, 'x-heimdall-provenance': 'observed-replay' };\n` +
    `  const body = fixture.body == null ? undefined : Buffer.from(fixture.body, 'base64');\n` +
    `  return new Response(body, { status: fixture.status, headers });\n` +
    `}\n`;
}

export function buildObservedReplayAdapter(entries, { siteId = '', origin = '', pages = 0, generatedAt = new Date().toISOString() } = {}) {
  const byKey = new Map();
  let excluded = 0;
  let redactedBodies = 0;
  let ambiguous = 0;
  for (const entry of entries ?? []) {
    if (!isObservedApiEntry(entry, origin)) { excluded++; continue; }
    const fixture = fixtureOf(entry);
    if (!fixture || !safeAdapterPath(fixture.path) || fixture.status < 100 || fixture.status > 599) { excluded++; continue; }
    const key = fixtureKey(fixture);
    if (byKey.has(key)) { ambiguous++; continue; }
    byKey.set(key, fixture);
    if (fixture.redacted) redactedBodies++;
  }
  const fixtures = [...byKey.values()].sort((a, b) => fixtureKey(a).localeCompare(fixtureKey(b)))
    .map(({ redacted, ...fixture }) => ({ ...fixture, key: fixtureKey(fixture) }));
  if (!fixtures.length) throw new Error('no observed API entries');
  const routes = [...new Map(fixtures.map(fixture => [routeKey(fixture), { method: fixture.method, path: fixture.path }])).values()]
    .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  if (routes.length > MAX_ROUTES) throw new Error(`observed API routes exceed ${MAX_ROUTES}`);
  const variants = new Map();
  for (const fixture of fixtures) {
    const key = routeKey(fixture);
    variants.set(key, [...(variants.get(key) ?? []), fixture]);
  }
  const fallbacks = [...variants.entries()]
    .filter(([, items]) => items.length === 1 && !items[0].search)
    .map(([key, items]) => [key, items[0]])
    .sort(([a], [b]) => a.localeCompare(b));
  const metadata = { version: 1, routes: routeMetadata(fixtures) };
  const source = moduleSource(fixtures, fallbacks, metadata);
  const moduleBytes = Buffer.byteLength(source);
  if (moduleBytes > MAX_MODULE_BYTES) throw new Error(`generated adapter exceeds ${MAX_MODULE_BYTES} bytes`);
  return {
    schema: 'heimdall.adapter/1',
    kind: 'observed-replay-adapter',
    siteId,
    origin,
    generatedAt,
    manifest: { version: 1, routes },
    moduleSource: source,
    report: {
      tier: 'B1-replay', pages, entries: fixtures.length, routes: routes.length,
      moduleBytes, excluded, ambiguous, redactedBodies, status: 'observed-only',
      unknowns: ['认证要求', '参数校验', '权限', '状态机', '副作用', '未观察路径'],
      gapLedger: initialGapLedger(metadata.routes),
    },
  };
}

export function writeObservedReplayAdapter(outDir, adapter) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(adapter.manifest, null, 2));
  writeFileSync(join(outDir, 'index.mjs'), adapter.moduleSource);
  return { outDir, files: ['manifest.json', 'index.mjs'] };
}
