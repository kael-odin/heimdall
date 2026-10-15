import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const ADAPTER_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MODULE_BYTES = 2 * 1024 * 1024;

function regularFile(path, maxBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error('adapter file is invalid');
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(',') !== 'routes,version'
    || manifest.version !== 1 || !Array.isArray(manifest.routes)
    || manifest.routes.length < 1 || manifest.routes.length > MAX_ROUTES) {
    throw new Error('invalid adapter manifest');
  }
  const routes = new Set();
  for (const route of manifest.routes) {
    let decodedPath;
    try { decodedPath = decodeURIComponent(route?.path); }
    catch { throw new Error('invalid adapter route'); }
    if (!route || typeof route !== 'object' || Array.isArray(route)
      || Object.keys(route).sort().join(',') !== 'method,path'
      || !METHODS.has(route.method) || typeof route.path !== 'string'
      || route.path.length > 2048 || !route.path.startsWith('/')
      || route.path.startsWith('//') || route.path.includes('\\')
      || /[?#]/.test(route.path) || /%(?:2f|5c)/i.test(route.path)
      || decodedPath === '/' || decodedPath === '/static' || decodedPath.startsWith('/static/')
      || decodedPath === '/__heimdall' || decodedPath.startsWith('/__heimdall/')
      || decodedPath === '/lm' || decodedPath.startsWith('/lm/')) {
      throw new Error('invalid adapter route');
    }
    const normalized = new URL(route.path, 'http://adapter.invalid');
    if (normalized.pathname !== route.path || normalized.search || normalized.hash) {
      throw new Error('noncanonical adapter route');
    }
    const key = route.method + ' ' + route.path;
    if (routes.has(key)) throw new Error('duplicate adapter route');
    routes.add(key);
  }
  return routes;
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
  const routes = validateManifest(JSON.parse(readFileSync(manifestFile, 'utf8')));
  return { routes, moduleFile };
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
  return { routes, handle: module.handle, dataDir };
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
  if (!adapter.routes.has(req.method + ' ' + path)) return false;
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
    const response = await Promise.race([adapter.handle(request, { dataDir: adapter.dataDir }), deadline]);
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
