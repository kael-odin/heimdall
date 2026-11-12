import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HOP_HEADERS = new Set([
  'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const MAX_ROUTES = 200;
const MAX_SESSIONS = 100;
const SESSION_NAME = /^[a-z0-9_-]{1,64}$/i;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const ADAPTER_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const GAP_LEDGER_FILE = 'adapter-gap-ledger.json';
const MAX_GAP_ENTRIES = 200;
const MAX_GAP_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HASH = /^[0-9a-f]{16,}$/i;

function regularFile(path, maxBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error('adapter file is invalid');
  }
}

export function isRuntimeAdapterPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')
    || value.includes('\\') || /[?#]/.test(value) || /%(?:2f|5c)/i.test(value)) return false;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  if (['/', '/static', '/__heimdall', '/lm'].some(root => decoded === root || (root !== '/' && decoded.startsWith(root + '/')))) return false;
  const names = new Set();
  let invalid = false;
  const canonical = value.split('/').map(part => {
    if (!/[{}]/.test(part)) return part;
    const match = /^\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}$/.exec(part);
    if (!match || names.has(match[1])) { invalid = true; return part; }
    names.add(match[1]);
    return 'parameter';
  }).join('/');
  return !invalid && new URL(canonical, 'http://adapter.invalid').pathname === canonical;
}

export function matchesRuntimeAdapterRoute(routes, method, path) {
  if (!isRuntimeAdapterPath(path)) return false;
  if (routes.has(method + ' ' + path)) return true;
  const actual = path.split('/');
  for (const route of routes) {
    if (!route.startsWith(method + ' ') || !route.includes('{')) continue;
    const parts = route.slice(method.length + 1).split('/');
    if (parts.length !== actual.length) continue;
    if (parts.every((part, index) => {
      if (!part.startsWith('{')) return part === actual[index];
      let value;
      try { value = decodeURIComponent(actual[index]); } catch { return false; }
      return value.length > 0 && !/[\/\\\x00-\x1f\x7f]/.test(value);
    })) return true;
  }
  return false;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !['routes,version', 'routes,sessions,version'].includes(Object.keys(manifest).sort().join(','))
    || manifest.version !== 1 || !Array.isArray(manifest.routes)
    || manifest.routes.length < 1 || manifest.routes.length > MAX_ROUTES) {
    throw new Error('invalid adapter manifest');
  }
  const routes = new Set();
  for (const route of manifest.routes) {
    if (!route || typeof route !== 'object' || Array.isArray(route)
      || Object.keys(route).sort().join(',') !== 'method,path'
      || !METHODS.has(route.method) || !isRuntimeAdapterPath(route.path)) {
      throw new Error('invalid adapter route');
    }
    const key = route.method + ' ' + route.path;
    if (routes.has(key)) throw new Error('duplicate adapter route');
    routes.add(key);
  }
  const sessionRoutes = new Map();
  if (manifest.sessions != null) {
    if (typeof manifest.sessions !== 'object' || Array.isArray(manifest.sessions)
      || Object.keys(manifest.sessions).length < 1 || Object.keys(manifest.sessions).length > MAX_SESSIONS) {
      throw new Error('invalid adapter sessions');
    }
    for (const [name, route] of Object.entries(manifest.sessions)) {
      if (!SESSION_NAME.test(name) || !route || typeof route !== 'object' || Array.isArray(route)
        || Object.keys(route).sort().join(',') !== 'method,path' || route.method !== 'POST'
        || !isRuntimeAdapterPath(route.path) || route.path.includes('{')) {
        throw new Error('invalid adapter session route');
      }
      const key = 'POST ' + route.path;
      if (!routes.has(key)) throw new Error('adapter session route is not declared');
      if (sessionRoutes.has(name)) throw new Error('duplicate adapter session route');
      sessionRoutes.set(name, route);
    }
  }
  return { routes, sessionRoutes };
}

export function inspectRuntimeAdapter(bundleDir) {
  const bundle = realpathSync(bundleDir);
  const adapterDir = join(bundle, 'runtime-adapter');
  const stat = lstatSync(adapterDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('adapter directory is invalid');
  if (readdirSync(adapterDir).sort().join(',') !== 'index.mjs,manifest.json') {
    throw new Error('adapter directory must contain only index.mjs and manifest.json');
  }
  const manifestFile = join(adapterDir, 'manifest.json');
  const moduleFile = join(adapterDir, 'index.mjs');
  regularFile(manifestFile, MAX_MANIFEST_BYTES);
  regularFile(moduleFile, MAX_MODULE_BYTES);
  const { routes, sessionRoutes } = validateManifest(JSON.parse(readFileSync(manifestFile, 'utf8')));
  return { routes, sessionRoutes, moduleFile };
}

export async function loadRuntimeAdapter(bundleDir, dataDirValue) {
  if (typeof dataDirValue !== 'string' || !dataDirValue.trim()) {
    throw new Error('HEIMDALL_RUNTIME_DATA_DIR is required');
  }
  const bundle = realpathSync(bundleDir);
  const dataDir = realpathSync(dataDirValue);
  if (!lstatSync(dataDir).isDirectory()) throw new Error('adapter data directory is invalid');
  const rel = relative(bundle, dataDir);
  if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) {
    throw new Error('adapter data directory must be outside the bundle');
  }
  const { routes, moduleFile } = inspectRuntimeAdapter(bundle);
  const module = await import(pathToFileURL(moduleFile).href);
  if (typeof module.handle !== 'function') throw new Error('adapter handle function is missing');
  const gapLedger = createGapLedger(dataDir, routes, module.__heimdallAdapter);
  return { routes, handle: module.handle, dataDir, gapLedger };
}

function safePath(path) {
  let pathname;
  try { pathname = new URL(String(path ?? '/'), 'http://adapter.local').pathname; }
  catch { return '/[invalid]'; }
  const segments = pathname.split('/').filter(Boolean).map(segment => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    if (/^\d+$/.test(decoded)) return '{n}';
    if (UUID.test(decoded)) return '{uuid}';
    if (LONG_HASH.test(decoded) || decoded.length > 64 || /@/.test(decoded) || /^[a-z0-9_-]{24,}$/i.test(decoded)) return '{value}';
    return decoded.slice(0, 128);
  });
  return '/' + segments.join('/');
}

function safeQueryNames(value) {
  const names = Array.isArray(value) ? value : [...new URLSearchParams(String(value ?? '')).keys()];
  return [...new Set(names.map(name => String(name).trim().toLowerCase())
    .filter(name => /^[a-z0-9_.:[\]~-]{1,128}$/i.test(name)).slice(0, 50))].sort();
}

function routeParts(route) {
  const split = String(route).indexOf(' ');
  return split < 1 ? { method: '', path: '/' } : { method: String(route).slice(0, split), path: String(route).slice(split + 1) };
}

function nearestRoutes(routes, method, path) {
  const target = path.split('/').filter(Boolean);
  return [...routes].map(route => {
    const item = routeParts(route);
    const parts = item.path.split('/').filter(Boolean);
    let common = 0;
    while (common < target.length && common < parts.length && target[common] === parts[common]) common++;
    const score = (item.method === method ? 100 : 0) + common * 10 - Math.abs(target.length - parts.length);
    return { method: item.method, path: safePath(item.path), score };
  }).sort((a, b) => b.score - a.score || `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)).slice(0, 3);
}

function metadataRoutes(metadata, routes) {
  const declared = new Set(routes);
  const source = Array.isArray(metadata?.routes) ? metadata.routes : [];
  const known = source.filter(item => item && declared.has(`${item.method} ${item.path}`)).map(item => ({
    method: item.method, path: safePath(item.path), queryParams: safeQueryNames(item.queryParams),
    responseBody: item.responseBody === 'observed' ? 'observed' : 'unavailable',
    writeVerification: item.writeVerification === 'unverified' ? 'unverified' : ['GET', 'HEAD'].includes(item.method) ? 'not_applicable' : 'unverified',
  }));
  const present = new Set(known.map(item => `${item.method} ${item.path}`));
  for (const route of routes) {
    const item = routeParts(route);
    const key = `${item.method} ${safePath(item.path)}`;
    if (!present.has(key)) known.push({
      method: item.method, path: safePath(item.path), queryParams: [], responseBody: 'unavailable',
      writeVerification: ['GET', 'HEAD'].includes(item.method) ? 'not_applicable' : 'unverified',
    });
  }
  return known.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function storedGaps(value, routes) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(['unobserved-path', 'uncovered-query-parameter', 'unobserved-query-variant']);
  const output = new Map();
  for (const item of value) {
    const method = String(item?.method ?? '').toUpperCase();
    if (!METHODS.has(method)) continue;
    const path = safePath(item?.path);
    const queryParams = safeQueryNames(item?.queryParams);
    const category = (Array.isArray(item?.categories) && item.categories.find(name => allowed.has(name))) || 'unobserved-path';
    const count = Number.isSafeInteger(item?.count) && item.count > 0 ? Math.min(item.count, 1_000_000_000) : 0;
    if (!count) continue;
    const key = `${method} ${path}|${queryParams.join(',')}|${category}`;
    const current = output.get(key) ?? {
      key, method, path, queryParams, count: 0, categories: [category],
      nearestRoutes: nearestRoutes(routes, method, path),
    };
    current.count = Math.min(1_000_000_000, current.count + count);
    output.set(key, current);
  }
  return [...output.values()].slice(-MAX_GAP_ENTRIES);
}

function createGapLedger(dataDir, routes, metadata) {
  const path = join(dataDir, GAP_LEDGER_FILE);
  const knownRoutes = metadataRoutes(metadata, routes);
  const missingResponseBodies = knownRoutes.filter(route => route.responseBody !== 'observed').length;
  const unverifiedWrites = knownRoutes.filter(route => route.writeVerification === 'unverified').length;
  let state = {
    schema: 'heimdall.adapter-gap-ledger/1', source: 'runtime', status: 'not-run',
    updatedAt: null,
    summary: { runtimeRequests: 0, uniqueGaps: 0, unobservedPaths: 0, uncoveredQueryParameters: 0, missingResponseBodies, unverifiedWrites },
    knownRoutes, gaps: [],
    unknowns: ['authentication-permission-unknown', 'business-state-unknown',
      ...(missingResponseBodies ? ['missing-response-body'] : []), ...(unverifiedWrites ? ['unverified-write'] : [])],
  };
  try {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    if (existing?.schema === state.schema && Array.isArray(existing.gaps)) {
      state.gaps = storedGaps(existing.gaps, routes);
      state.updatedAt = typeof existing.updatedAt === 'string' ? existing.updatedAt : null;
    }
  } catch {}

  const refresh = () => {
    const runtimeRequests = state.gaps.reduce((sum, item) => sum + item.count, 0);
    const hasCategory = category => state.gaps.filter(item => item.categories.includes(category)).length;
    state.summary = {
      ...state.summary, runtimeRequests, uniqueGaps: state.gaps.length,
      unobservedPaths: hasCategory('unobserved-path'),
      uncoveredQueryParameters: hasCategory('uncovered-query-parameter'),
      missingResponseBodies, unverifiedWrites,
    };
    state.status = runtimeRequests === 0 ? 'not-run' : state.gaps.length ? 'needs-review' : 'no-gaps-observed';
    state.updatedAt = new Date().toISOString();
    state.unknowns = ['authentication-permission-unknown', 'business-state-unknown',
      ...(missingResponseBodies ? ['missing-response-body'] : []), ...(unverifiedWrites ? ['unverified-write'] : []),
      ...(state.gaps.length ? ['runtime-gap-observed'] : [])];
  };
  const persist = () => {
    refresh();
    while (state.gaps.length > MAX_GAP_ENTRIES || Buffer.byteLength(JSON.stringify(state)) > MAX_GAP_BYTES) state.gaps.shift();
    refresh();
    const text = JSON.stringify(state, null, 2);
    try {
      writeFileSync(path + '.tmp', text);
      renameSync(path + '.tmp', path);
    } catch { /* A read-only state volume must not break the mirrored page. */ }
  };
  const record = ({ method, path: requestPath, search = '', queryParams, category = 'unobserved-path' }) => {
    const upperMethod = String(method ?? 'GET').toUpperCase();
    const safe = safePath(requestPath);
    const params = safeQueryNames(queryParams ?? search);
    const allowed = new Set(['unobserved-path', 'uncovered-query-parameter', 'unobserved-query-variant']);
    const normalizedCategory = allowed.has(category) ? category : 'unobserved-path';
    const key = `${upperMethod} ${safe}|${params.join(',')}|${normalizedCategory}`;
    const current = state.gaps.find(item => item.key === key);
    if (current) current.count++;
    else {
      state.gaps.push({ key, method: upperMethod, path: safe, queryParams: params, count: 1,
        categories: [normalizedCategory], nearestRoutes: nearestRoutes(routes, upperMethod, safe) });
    }
    persist();
  };
  refresh();
  return { path, record, snapshot: () => JSON.parse(JSON.stringify(state)) };
}

function boundedBody(req) {
  const claimedLength = Number(req.headers['content-length']);
  if (Number.isFinite(claimedLength) && claimedLength > MAX_BODY_BYTES) {
    return Promise.resolve({ status: 413 });
  }
  return new Promise((resolve, reject) => {
    let length = 0;
    let settled = false;
    const chunks = [];
    const timer = setTimeout(() => stop(408), BODY_TIMEOUT_MS);
    const cleanup = (keepError = false) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      if (!keepError) req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const stop = status => {
      if (settled) return;
      settled = true;
      req.pause();
      cleanup(true);
      req.once('close', () => req.off('error', onError));
      resolve({ status });
    };
    const onData = chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) stop(413);
      else chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ body: Buffer.concat(chunks) });
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => stop(408);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('data', onData);
  });
}

function rejectBody(req, res, status) {
  const socket = req.socket;
  const body = status === 413 ? 'request body too large' : 'request body timed out';
  res.shouldKeepAlive = false;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  res.once('finish', () => socket.destroy());
  res.end(body);
}

function requestHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name) || value == null) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function responseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (!HOP_HEADERS.has(name) && name !== 'set-cookie') headers[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  return headers;
}

export async function dispatchRuntimeAdapter(adapter, req, res, path, search) {
  if (!matchesRuntimeAdapterRoute(adapter.routes, req.method, path)) {
    adapter.gapLedger?.record({ method: req.method, path, search, category: 'unobserved-path' });
    return false;
  }
  let timeout;
  let timedOut = false;
  const controller = new AbortController();
  try {
    const incoming = req.method === 'GET' || req.method === 'HEAD'
      ? { body: undefined } : await boundedBody(req);
    if (incoming.status) {
      if (!res.destroyed) rejectBody(req, res, incoming.status);
      return true;
    }
    const request = new Request('http://adapter.local' + path + search, {
      method: req.method, headers: requestHeaders(req),
      body: incoming.body?.length ? incoming.body : undefined, signal: controller.signal,
    });
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('adapter timed out'));
      }, ADAPTER_TIMEOUT_MS);
    });
    const response = await Promise.race([adapter.handle(request, {
      dataDir: adapter.dataDir, recordGap: details => adapter.gapLedger?.record({ ...details, search }),
    }), deadline]);
    if (!(response instanceof Response)) throw new TypeError('adapter must return Response');
    if (controller.signal.aborted) throw new Error('adapter timed out');
    res.writeHead(response.status, responseHeaders(response));
    if (req.method === 'HEAD' || !response.body) {
      await response.body?.cancel();
      res.end();
    } else {
      await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
    }
  } catch {
    if (res.headersSent) res.destroy();
    else {
      if (timedOut) res.shouldKeepAlive = false;
      res.writeHead(timedOut ? 504 : 500, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...(timedOut ? { Connection: 'close' } : {}),
      });
      res.end(timedOut ? 'adapter timed out' : 'adapter failed');
    }
  } finally {
    clearTimeout(timeout);
  }
  return true;
}
