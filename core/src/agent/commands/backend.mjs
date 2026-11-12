#!/usr/bin/env node
/**
 * heimdall backend scaffold — 生成 B3 最小可运行后端起点。
 *
 * 只读取已清洗的 api-contract.json 和已验证格式的 runtime-adapter。
 * 不发明业务规则，也不把观察型契约包装成源站后端等价物。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectRuntimeAdapter } from '../../live/adapter-runtime.mjs';
import { CapabilityError, exitCodeOf, fromError, ok } from '../envelope.mjs';
import { parseArgs } from '../parse-args.mjs';
import { assertSiteId, siteDir } from '../workspace.mjs';

const CONTRACT_FILES = ['api-contract.json', 'deliver/api-contract.json', 'deliverable/api-contract.json'];
const METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function readJson(file, maxBytes = 4 * 1024 * 1024) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileChecked(file, value) {
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CapabilityError('invalid_args', '输出文件不是普通文件：' + file);
  }
  writeFileSync(file, value, 'utf8');
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function text(value, max = 256) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function safePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || value.includes('\\') || /[?#]/.test(value) || /%(?:2f|5c)/i.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded === '/' || decoded === '/static' || decoded.startsWith('/static/')
      || decoded === '/__heimdall' || decoded.startsWith('/__heimdall/')
      || decoded === '/lm' || decoded.startsWith('/lm/')) return null;
    const url = new URL(value, 'http://heimdall.local');
    return url.pathname === value && !url.search && !url.hash ? value : null;
  } catch {
    return null;
  }
}

function names(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item).trim().toLowerCase())
    .filter(item => /^[a-z0-9_.:[\]~-]{1,128}$/i.test(item)))].sort().slice(0, max);
}

function schema(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return undefined;
  const output = {};
  for (const key of ['type', 'format', 'nullable', 'additionalProperties']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'boolean') output[key] = value[key];
  }
  if (Array.isArray(value.required)) output.required = value.required.filter(name => typeof name === 'string').slice(0, 100);
  if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
    output.properties = {};
    for (const [name, item] of Object.entries(value.properties).slice(0, 100)) {
      const child = schema(item, depth + 1);
      if (child) output.properties[text(name, 128)] = child;
    }
  }
  if (value.items && typeof value.items === 'object') {
    const child = schema(value.items, depth + 1);
    if (child) output.items = child;
  }
  return output;
}

function content(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [mime, item] of Object.entries(value).slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const child = schema(item.schema);
    output[text(mime, 128)] = child ? { schema: child } : {};
  }
  return output;
}

function operation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  const observed = value['x-heimdall-observations'];
  if (observed && typeof observed === 'object') {
    output['x-heimdall-observations'] = {
      samples: Number.isFinite(Number(observed.samples)) ? Number(observed.samples) : null,
      queryParams: names(observed.queryParams),
      authSchemes: names(observed.authSchemes),
    };
  }
  if (value.requestBody && typeof value.requestBody === 'object') output.requestBody = { content: content(value.requestBody.content) };
  if (value.responses && typeof value.responses === 'object') {
    output.responses = {};
    for (const [status, response] of Object.entries(value.responses).slice(0, 30)) {
      if (!/^[0-9]{3}$/.test(status) || !response || typeof response !== 'object') continue;
      const item = { content: content(response.content) };
      if (Number.isFinite(Number(response['x-heimdall-samples']))) item['x-heimdall-samples'] = Number(response['x-heimdall-samples']);
      output.responses[status] = item;
    }
  }
  return output;
}

function projectContract(source, siteId, status) {
  const input = source && typeof source === 'object' ? source : {};
  const openapi = input.openapi && typeof input.openapi === 'object' ? input.openapi : {};
  const paths = {};
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {}).slice(0, 200)) {
    const safe = safePath(path);
    if (!safe || !pathItem || typeof pathItem !== 'object') continue;
    const item = {};
    for (const [method, value] of Object.entries(pathItem)) {
      if (!METHODS.has(method.toLowerCase())) continue;
      const projected = operation(value);
      if (projected) item[method.toLowerCase()] = projected;
    }
    if (Object.keys(item).length) paths[safe] = item;
  }
  const origin = (() => {
    try {
      const url = new URL(openapi.servers?.[0]?.url);
      return /^https?:$/.test(url.protocol) ? url.origin : null;
    } catch {
      return null;
    }
  })();
  const observed = Array.isArray(input.observations) ? input.observations.slice(0, 200).map(item => ({
    op: text(item?.op),
    samples: Number.isFinite(Number(item?.samples)) ? Number(item.samples) : null,
    statusCodes: Array.isArray(item?.statusCodes) ? item.statusCodes.filter(Number.isInteger).slice(0, 30) : [],
    queryParams: names(item?.queryParams),
    withResponseSchema: item?.withResponseSchema === true,
    withRequestSchema: item?.withRequestSchema === true,
    authSchemes: names(item?.authSchemes),
    errorSamples: Number.isFinite(Number(item?.errorSamples)) ? Number(item.errorSamples) : 0,
    provenance: 'observed',
  })) : [];
  const endpointCount = Object.values(paths).reduce((sum, item) => sum + Object.keys(item).length, 0);
  return {
    schema: 'heimdall.backend-scaffold-contract/1',
    sourceSchema: text(input.schema, 80),
    siteId,
    generatedAt: new Date().toISOString(),
    tier: endpointCount ? 'B1' : 'B0',
    status,
    origin,
    openapi: {
      openapi: '3.1.0',
      info: { title: siteId + ' observed API contract', version: 'observed-1' },
      ...(origin ? { servers: [{ url: origin, 'x-heimdall-provenance': 'observed' }] } : {}),
      'x-heimdall-tier': endpointCount ? 'B1' : 'B0',
      paths,
    },
    observations: observed,
    unknowns: Array.isArray(input.unknowns)
      ? input.unknowns.slice(0, 100).map(item => ({ kind: text(item?.kind, 80), op: text(item?.op), detail: text(item?.detail) }))
      : [{ kind: status === 'missing' ? 'api-contract-missing' : 'api-contract-invalid' }],
    coverage: {
      endpoints: endpointCount,
      observed: endpointCount,
      withResponseSchema: observed.filter(item => item.withResponseSchema).length,
      withRequestSchema: observed.filter(item => item.withRequestSchema).length,
      authObserved: observed.filter(item => item.authSchemes.length > 0).length,
      invented: 0,
    },
  };
}

function routesOf(contract) {
  const rows = [];
  for (const [path, item] of Object.entries(contract.openapi?.paths ?? {})) {
    for (const [method, value] of Object.entries(item ?? {})) {
      const upper = method.toUpperCase();
      if (!HTTP_METHODS.has(upper)) continue;
      rows.push({
        method: upper,
        path,
        queryParams: names(value?.['x-heimdall-observations']?.queryParams),
        authSchemes: names(value?.['x-heimdall-observations']?.authSchemes),
        responseStatuses: Object.keys(value?.responses ?? {}).filter(code => /^[0-9]{3}$/.test(code)).map(Number),
        basis: 'observed',
      });
    }
  }
  return rows.sort((a, b) => (a.method + ' ' + a.path).localeCompare(b.method + ' ' + b.path)).slice(0, 200);
}

function findContract(root) {
  for (const suffix of CONTRACT_FILES) {
    const file = join(root, suffix);
    if (!existsSync(file)) continue;
    const source = readJson(file);
    return source ? { status: 'observed', source, path: suffix } : { status: 'invalid', source: null, path: suffix };
  }
  return { status: 'missing', source: null, path: null };
}

function readAdapter(root) {
  const dir = join(root, 'runtime-adapter');
  if (!existsSync(dir)) return { status: 'missing', present: false, routes: [] };
  try {
    const inspected = inspectRuntimeAdapter(root);
    const stat = lstatSync(inspected.moduleFile);
    if (stat.size > 2 * 1024 * 1024) throw new Error('adapter module is too large');
    const manifest = readJson(join(dir, 'manifest.json'), 1024 * 1024);
    if (!manifest) throw new Error('adapter manifest is invalid');
    return {
      status: 'observed',
      present: true,
      routes: manifest.routes.map(route => ({ method: route.method, path: route.path })),
      sessions: manifest.sessions ? Object.keys(manifest.sessions).length : 0,
      moduleFile: inspected.moduleFile,
    };
  } catch (error) {
    throw new CapabilityError('invalid_args', '已有 runtime-adapter 无法安全纳入脚手架：' + String(error.message).slice(0, 180));
  }
}

function stateRules(siteId, contract, adapter) {
  return {
    schema: 'heimdall.backend-state-rules/1',
    siteId,
    status: 'inferred-draft',
    provenance: {
      observed: [
        ...(contract.status === 'observed' ? ['api-contract.json'] : []),
        ...(adapter.present ? ['runtime-adapter/manifest.json'] : []),
      ],
      inferred: ['authentication', 'permissions', 'state transitions', 'validation', 'persistence', 'side effects'],
      invented: [],
    },
    routes: routesOf(contract),
    rules: [],
    unknowns: ['authentication', 'permissions', 'state-machine', 'business-rules', 'persistence', 'side-effects',
      ...(contract.status !== 'observed' ? ['api-contract'] : [])],
    note: '这里故意留空；没有授权的真实旅程和业务规则时，Heimdall 不替人编造后端行为。',
  };
}

function serverSource() {
  return String.raw`#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const portArg = process.argv.indexOf('--port');
const PORT = Number(process.env.PORT || (portArg >= 0 ? process.argv[portArg + 1] : 8080));
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ADAPTER_TIMEOUT_MS = 15_000;
const HOP_HEADERS = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const contract = readJson(join(ROOT, 'api-contract.json'), { openapi: { paths: {} }, status: 'missing' });
const contractRoutes = routeRows(contract);
const adapterManifest = readJson(join(ROOT, 'runtime-adapter', 'manifest.json'), null);
const dataDir = resolve(process.env.HEIMDALL_RUNTIME_DATA_DIR || join(ROOT, '..', basename(ROOT) + '-data'));
mkdirSync(dataDir, { recursive: true });
const gapFile = join(dataDir, 'adapter-gap-ledger.json');
let adapterModule = null;
let adapterError = null;
if (adapterManifest) {
  try {
    adapterModule = await import(new URL('./runtime-adapter/index.mjs', import.meta.url));
    if (typeof adapterModule.handle !== 'function') throw new Error('adapter handle function is missing');
  } catch (error) {
    adapterError = String(error.message || error);
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function routeRows(value) {
  const rows = [];
  for (const [path, item] of Object.entries(value?.openapi?.paths || {})) {
    for (const method of Object.keys(item || {})) {
      if (/^(get|head|post|put|patch|delete|options)$/i.test(method)) rows.push({ method: method.toUpperCase(), path });
    }
  }
  return rows.sort((a, b) => (a.method + ' ' + a.path).localeCompare(b.method + ' ' + b.path));
}
function manifestRows(value) {
  return Array.isArray(value?.routes) ? value.routes.map(item => ({ method: item.method, path: item.path })) : [];
}
function key(row) { return row.method + ' ' + row.path; }
const adapterRoutes = manifestRows(adapterManifest);
const adapterRouteSet = new Set(adapterRoutes.map(key));
const observedRouteSet = new Set(contractRoutes.map(key));
const initialLedger = {
  schema: 'heimdall.adapter-gap-ledger/1',
  source: 'b3-scaffold-runtime',
  status: 'not-run',
  updatedAt: null,
  summary: { runtimeRequests: 0, uniqueGaps: 0, unobservedPaths: 0, uncoveredQueryParameters: 0, missingResponseBodies: 0, unverifiedWrites: adapterRoutes.filter(item => !['GET', 'HEAD'].includes(item.method)).length },
  knownRoutes: adapterRoutes,
  gaps: [],
  unknowns: ['authentication-permission-unknown', 'business-state-unknown'],
};
const ledger = readJson(gapFile, initialLedger);
ledger.gaps = Array.isArray(ledger.gaps) ? ledger.gaps : [];
function safePath(value) {
  try { return new URL(String(value || '/'), 'http://adapter.local').pathname; } catch { return '/[invalid]'; }
}
function queryNames(value) {
  try { return [...new Set([...new URL('http://adapter.local' + (value || '')).searchParams.keys()].map(item => item.toLowerCase()))].sort(); } catch { return []; }
}
function saveLedger() {
  ledger.summary.runtimeRequests = ledger.gaps.reduce((sum, item) => sum + item.count, 0);
  ledger.summary.uniqueGaps = ledger.gaps.length;
  ledger.summary.unobservedPaths = ledger.gaps.filter(item => item.categories.includes('unobserved-path')).length;
  ledger.summary.uncoveredQueryParameters = ledger.gaps.filter(item => item.categories.includes('uncovered-query-parameter')).length;
  ledger.status = ledger.gaps.length ? 'needs-review' : ledger.summary.runtimeRequests ? 'no-gaps-observed' : 'not-run';
  ledger.updatedAt = new Date().toISOString();
  writeFileSync(gapFile + '.tmp', JSON.stringify(ledger, null, 2));
  renameSync(gapFile + '.tmp', gapFile);
}
function recordGap(details) {
  const method = String(details?.method || 'GET').toUpperCase();
  const path = safePath(details?.path);
  const params = [...new Set((details?.queryParams || queryNames(details?.search)).map(item => String(item).toLowerCase()))].sort().slice(0, 50);
  const category = ['unobserved-path', 'uncovered-query-parameter', 'unobserved-query-variant'].includes(details?.category) ? details.category : 'unobserved-path';
  const gapKey = method + ' ' + path + '|' + params.join(',') + '|' + category;
  const current = ledger.gaps.find(item => item.key === gapKey);
  if (current) current.count += 1;
  else ledger.gaps.push({ key: gapKey, method, path, queryParams: params, count: 1, categories: [category], nearestRoutes: [] });
  while (ledger.gaps.length > 200) ledger.gaps.shift();
  saveLedger();
}
function jsonResponse(res, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value, null, 2) + String.fromCharCode(10));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}
function health() {
  const missing = contractRoutes.filter(item => !adapterRouteSet.has(key(item)));
  return {
    schema: 'heimdall.backend-health/1',
    level: 'B3-scaffold',
    siteId: contract.siteId || null,
    implementation: adapterModule ? 'observed-adapter-plus-stubs' : 'route-stubs-only',
    observedRoutes: contractRoutes.length,
    adapterRoutes: adapterRoutes.length,
    missingObservedRoutes: missing,
    unknowns: ['authentication', 'permissions', 'state-machine', 'business-rules', 'persistence', 'side-effects'],
    adapter: { present: !!adapterModule, loadError: adapterError, gapLedger: ledger.summary },
    warning: '这是可运行的后端起点，不是源站后端等价物。',
  };
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
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
  for (const [name, value] of response.headers) if (!HOP_HEADERS.has(name)) headers[name] = value;
  return headers;
}
async function serveAdapter(req, res, url) {
  let body;
  try { body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req); }
  catch (error) { jsonResponse(res, error.status || 400, { error: error.message }); return; }
  const request = new Request('http://adapter.local' + url.pathname + url.search, {
    method: req.method,
    headers: requestHeaders(req),
    body: body && body.length ? body : undefined,
  });
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('adapter timed out')), ADAPTER_TIMEOUT_MS); });
    const response = await Promise.race([adapterModule.handle(request, { dataDir, method: req.method, recordGap }), deadline]);
    if (!(response instanceof Response)) throw new Error('adapter must return Response');
    res.writeHead(response.status, responseHeaders(response));
    if (req.method === 'HEAD' || !response.body) {
      await response.body?.cancel();
      res.end();
    } else {
      await pipeline(Readable.fromWeb(response.body), res);
    }
  } catch (error) {
    if (!res.headersSent) jsonResponse(res, String(error.message).includes('timed out') ? 504 : 500, { error: 'adapter_failed' });
    else res.destroy();
  } finally {
    clearTimeout(timer);
  }
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/__heimdall/health') return jsonResponse(res, 200, health());
  if (req.method === 'GET' && url.pathname === '/__heimdall/adapter-gaps') return jsonResponse(res, 200, ledger);
  if (req.method === 'GET' && url.pathname === '/__heimdall/contract') return jsonResponse(res, 200, contract);
  if (adapterModule) return serveAdapter(req, res, url);
  if (observedRouteSet.has(req.method + ' ' + url.pathname)) {
    return jsonResponse(res, 501, { error: 'not_implemented', message: '该观察到的路由还没有业务实现。' }, { 'X-Heimdall-Provenance': 'scaffold' });
  }
  return jsonResponse(res, 404, { error: 'not_found' });
});
server.on('error', error => { console.error('[heimdall-backend] ' + error.message); process.exitCode = 1; });
server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  console.log('HEIMDALL_BACKEND_READY http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + port);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
`;
}

function checksSource() {
  return String.raw`#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8080').replace(new RegExp('/$'), '');
const contract = JSON.parse(readFileSync(join(ROOT, 'api-contract.json'), 'utf8'));
const rows = [];
function responseRows(operation) {
  return Object.entries(operation?.responses || {})
    .filter(([status]) => /^[0-9]{3}$/.test(status))
    .map(([status, response]) => {
      const content = response && typeof response === 'object' && !Array.isArray(response) ? response.content || {} : {};
      return {
        status: Number(status),
        mimeTypes: Object.keys(content).map(value => String(value).split(';', 1)[0].trim().toLowerCase()).filter(Boolean).sort(),
        schemas: Object.entries(content).map(([mimeType, item]) => ({
          mimeType: String(mimeType).split(';', 1)[0].trim().toLowerCase(),
          schema: item && typeof item.schema === 'object' && !Array.isArray(item.schema) ? item.schema : null,
        })).filter(item => item.schema),
      };
    });
}
for (const [path, item] of Object.entries(contract.openapi?.paths || {})) {
  for (const method of Object.keys(item || {})) {
    if (!/^(get|head|post|put|patch|delete|options)$/i.test(method)) continue;
    const operation = item[method] || {};
    const observations = operation['x-heimdall-observations'] || {};
    rows.push({
      method: method.toUpperCase(),
      path,
      queryParams: Array.isArray(observations.queryParams) ? [...new Set(observations.queryParams.map(String))].sort() : [],
      responses: responseRows(operation),
    });
  }
}
function normalizeMime(value) { return String(value || '').split(';', 1)[0].trim().toLowerCase(); }
function mimeMatches(actual, expected) {
  const left = normalizeMime(actual);
  const right = normalizeMime(expected);
  if (!left || !right) return false;
  if (right === '*/*' || left === right) return true;
  const [leftType] = left.split('/');
  const [rightType, rightSubtype] = right.split('/');
  return rightSubtype === '*' && leftType === rightType;
}
function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}
function schemaError(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  if (value === null) return schema.nullable === true || schema.type === 'null' ? null : { path, expected: schema.type || 'non-null', actual: 'null' };
  const expected = schema.type || (schema.properties ? 'object' : null);
  if (expected && expected !== actualType(value)
    && !(expected === 'number' && actualType(value) === 'integer')) {
    return { path, expected, actual: actualType(value) };
  }
  if (expected === 'object') {
    if (schema.required && schema.required.some(name => !Object.prototype.hasOwnProperty.call(value, name))) {
      return { path, expected: 'required property', actual: 'missing' };
    }
    for (const [name, child] of Object.entries(schema.properties || {})) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      const error = schemaError(value[name], child, path + '.' + name);
      if (error) return error;
    }
  }
  if (expected === 'array' && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = schemaError(value[index], schema.items, path + '[' + index + ']');
      if (error) return error;
    }
  }
  return null;
}
async function inspectResponse(route, response) {
  const expectedStatuses = route.responses.map(item => item.status);
  const expected = route.responses.find(item => item.status === response.status);
  const actualMimeType = normalizeMime(response.headers.get('content-type'));
  if (response.status === 501) return { status: 'not_implemented', httpStatus: response.status, expectedStatuses, actualMimeType };
  if (expectedStatuses.length && !expectedStatuses.includes(response.status)) {
    return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, reason: '响应状态码没有出现在观察契约中' };
  }
  const expectedMimeTypes = expected?.mimeTypes || [];
  if (expectedMimeTypes.length && !expectedMimeTypes.some(item => mimeMatches(actualMimeType, item))) {
    return { status: 'failed', httpStatus: response.status, expectedStatuses, expectedMimeTypes, actualMimeType, reason: '响应 MIME 没有出现在观察契约中' };
  }
  const schemaCandidates = (expected?.schemas || []).filter(item => !item.mimeType || mimeMatches(actualMimeType, item.mimeType));
  if (schemaCandidates.length && route.method !== 'HEAD' && response.status !== 204 && response.status !== 304) {
    const raw = await response.text();
    if (!raw.trim()) return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, reason: '契约声明了响应结构，但实际响应没有响应体' };
    let value;
    try { value = JSON.parse(raw); }
    catch { return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, reason: '契约声明 JSON 结构，但实际响应不是合法 JSON' }; }
    const errors = schemaCandidates.map(item => schemaError(value, item.schema)).filter(Boolean);
    if (errors.length === schemaCandidates.length) {
      return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, schemaError: errors[0], reason: '响应 JSON 不满足观察到的字段结构' };
    }
  }
  return { status: response.status >= 500 ? 'failed' : 'implemented', httpStatus: response.status, expectedStatuses, expectedMimeTypes, actualMimeType };
}
function repairTaskFor(item) {
  const id = String(item?.id || '');
  if (id === 'health') return {
    id: 'repair-service-health', kind: 'service-health', target: 'server.mjs',
    instruction: '先修复服务启动或健康端点，再运行 npm run check。', requiresHumanApproval: false,
  };
  if (id === 'adapter-coverage') return {
    id: 'repair-route-coverage', kind: 'route-coverage', target: 'runtime-adapter/index.mjs',
    instruction: '补齐观察到但适配器未覆盖的路由；证据不足时先补观察契约。', requiresHumanApproval: false,
    evidence: { missingObservedRoutes: Array.isArray(item.missingObservedRoutes) ? item.missingObservedRoutes.length : 0 },
  };
  if (id === 'adapter-gap-ledger') {
    const uniqueGaps = Number(item.uniqueGaps || 0);
    const uncoveredQueryParameters = Number(item.uncoveredQueryParameters || 0);
    const unverifiedWrites = Number(item.unverifiedWrites || 0);
    const kind = unverifiedWrites > 0 ? 'write-verification' : uncoveredQueryParameters > 0 ? 'query-parameter-gap' : 'runtime-gap';
    const instruction = unverifiedWrites > 0
      ? '先用授权测试旅程验证写入、回读和清理，再修改适配器。'
      : uncoveredQueryParameters > 0
        ? '补齐查询参数名对应的路由分支，再运行 npm run check。'
        : '补齐运行时发现但契约未声明的路由，再运行 npm run check。';
    return {
      id: 'repair-' + kind, kind, target: 'runtime-adapter/index.mjs', instruction,
      requiresHumanApproval: unverifiedWrites > 0,
      evidence: { uniqueGaps, uncoveredQueryParameters, unverifiedWrites },
    };
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) /.test(id)) return null;
  const target = id.slice(0, 256);
  const taskId = 'repair-' + target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  if (item.status === 'not_implemented') return {
    id: taskId || 'repair-route-implementation', kind: 'route-implementation', target,
    instruction: '根据观察到的契约实现这个路由；不要臆造认证、权限或业务副作用。', requiresHumanApproval: false,
  };
  if (item.status === 'skipped') return {
    id: taskId || 'repair-authorized-journey', kind: 'authorized-journey', target,
    instruction: '先补明确授权的测试数据和业务旅程，再实现该路由并复测。', requiresHumanApproval: true,
  };
  return {
    id: taskId || 'repair-response-contract', kind: 'response-contract', target,
    instruction: '按观察契约修正响应状态码、MIME 或有限 JSON 结构，再运行 npm run check。', requiresHumanApproval: false,
    evidence: {
      httpStatus: item.httpStatus,
      expectedStatuses: Array.isArray(item.expectedStatuses) ? item.expectedStatuses.slice(0, 30) : [],
      expectedMimeTypes: Array.isArray(item.expectedMimeTypes) ? item.expectedMimeTypes.slice(0, 20) : [],
      actualMimeType: typeof item.actualMimeType === 'string' ? item.actualMimeType.slice(0, 128) : undefined,
      schemaPath: typeof item.schemaError?.path === 'string' ? item.schemaError.path.slice(0, 128) : undefined,
    },
  };
}
function attachRepairTask(item) {
  if (!['failed', 'incomplete', 'not_implemented', 'skipped'].includes(item?.status)) return item;
  const repairTask = repairTaskFor(item);
  return repairTask ? { ...item, repairTask } : item;
}
function overallOf(items) {
  if (items.some(item => item.status === 'failed')) return 'failed';
  if (items.some(item => ['incomplete', 'not_implemented', 'skipped'].includes(item.status))) return 'incomplete';
  return 'passed';
}
const results = [];
try {
  const health = await fetch(base + '/__heimdall/health');
  let healthJson = null;
  try { healthJson = await health.json(); } catch {}
  results.push({ id: 'health', status: health.ok ? 'passed' : 'failed', httpStatus: health.status });
  if (!health.ok || !healthJson) throw new Error('health check failed');
  const missingObservedRoutes = Array.isArray(healthJson.missingObservedRoutes) ? healthJson.missingObservedRoutes : null;
  results.push({
    id: 'adapter-coverage',
    status: missingObservedRoutes?.length ? 'incomplete' : missingObservedRoutes ? 'passed' : 'incomplete',
    adapterPresent: healthJson.adapter?.present === true,
    missingObservedRoutes: missingObservedRoutes || [],
    reason: missingObservedRoutes?.length ? '适配器没有覆盖全部观察到的路由' : missingObservedRoutes ? undefined : '健康端点没有提供观察路由覆盖结果',
  });
  for (const route of rows) {
    if (route.method !== 'GET' && route.method !== 'HEAD') {
      results.push({ id: route.method + ' ' + route.path, status: 'skipped', reason: '写入路由需要人工授权和业务规则' });
      continue;
    }
    if (route.path.includes('{')) {
      results.push({ id: route.method + ' ' + route.path, status: 'skipped', reason: '路径参数需要具体测试数据' });
      continue;
    }
    const response = await fetch(base + route.path, { method: route.method });
    results.push({ id: route.method + ' ' + route.path, queryParams: route.queryParams, ...(await inspectResponse(route, response)) });
  }
  try {
    const gapResponse = await fetch(base + '/__heimdall/adapter-gaps');
    const gapLedger = await gapResponse.json();
    const summary = gapLedger?.summary || {};
    results.push({
      id: 'adapter-gap-ledger',
      status: !gapResponse.ok ? 'failed' : Number(summary.uniqueGaps || 0) > 0 ? 'failed' : Number(summary.unverifiedWrites || 0) > 0 ? 'incomplete' : 'passed',
      ledgerStatus: gapLedger?.status || 'unknown',
      uniqueGaps: Number(summary.uniqueGaps || 0),
      uncoveredQueryParameters: Number(summary.uncoveredQueryParameters || 0),
      unverifiedWrites: Number(summary.unverifiedWrites || 0),
      reason: Number(summary.uniqueGaps || 0) > 0 ? '运行时发现未观察路径或未覆盖查询参数' : Number(summary.unverifiedWrites || 0) > 0 ? '写入路由仍只有回放证据，尚未完成业务验证' : undefined,
    });
  } catch (error) {
    results.push({ id: 'adapter-gap-ledger', status: 'failed', reason: '无法读取适配器缺口账本：' + String(error.message || error).slice(0, 180) });
  }
} catch (error) {
  results.push({ id: 'server', status: 'failed', reason: String(error.message || error) });
}
for (let index = 0; index < results.length; index += 1) results[index] = attachRepairTask(results[index]);
let overall = overallOf(results);
const repairTasks = results.map(item => item.repairTask).filter(Boolean);
const report = { schema: 'heimdall.backend-check/1', generatedAt: new Date().toISOString(), base, overall, results, repairTasks, note: '通过只表示脚手架能启动并完成当前检查，不代表业务正确。' };
try {
  writeFileSync(join(ROOT, 'backend-check.json.tmp'), JSON.stringify(report, null, 2) + String.fromCharCode(10), 'utf8');
  renameSync(join(ROOT, 'backend-check.json.tmp'), join(ROOT, 'backend-check.json'));
} catch (error) {
  results.push({ id: 'report', status: 'failed', reason: '检查结果无法落盘：' + String(error.message || error).slice(0, 180) });
  overall = overallOf(results);
}
console.log(JSON.stringify({ ...report, overall, results }, null, 2));
process.exitCode = overall === 'passed' ? 0 : 1;
`;
}

function readmeSource({ siteId, outDir, adapter, routes }) {
  const routeText = routes.length ? routes.map(item => '- ' + item.method + ' ' + item.path).join('\n') : '- 没有可用的观察型 API 路由';
  const adapterText = adapter.present
    ? '已纳入现有 B2 观察回放适配器（' + adapter.routes.length + ' 条路由）；它只证明已观察样本的回放能力。'
    : '没有纳入 B2 适配器；已观察路由会返回 501，等待 AI 或开发者补实现。';
  return [
    '# Heimdall B3 后端脚手架',
    '',
    '站点：' + siteId,
    '当前级别：B3-scaffold',
    '输出目录：' + outDir,
    '',
    '## 先说人话',
    '',
    '这是一个能启动、能看健康状态、能逐条补路由的后端起点，不是源站后端的复制品。',
    '观察到的内容来自脱敏 API 契约；没有观察到的认证、权限、状态机、持久化和副作用都留在未知项里。',
    adapterText,
    '',
    '## 已观察路由',
    '',
    routeText,
    '',
    '## 运行',
    '',
    'npm start',
    '打开 http://127.0.0.1:8080/__heimdall/health 查看当前状态。',
    '运行 npm run check 做健康、只读路由和未实现项检查。',
    '需要外置状态目录时设置 HEIMDALL_RUNTIME_DATA_DIR；默认目录在脚手架目录旁边。',
    '',
    '## 生成证据',
    '',
    'api-contract.json：脱敏的观察型接口形状。',
    'state-rules.json：待人工确认的状态规则草稿，当前没有自动编造规则。',
    'runtime-adapter/：如果纳入，只有 manifest.json 和 index.mjs。',
    'checks.mjs：本地可重复检查，并把最近一次结果写入 backend-check.json。',
    '',
    '## 未完成且不能猜的事情',
    '',
    '- 登录、退出、凭据刷新和失效。',
    '- 角色、权限、资源边界和拒绝口径。',
    '- 创建、更新、删除、回滚、幂等和持久化。',
    '- 消息、邮件、支付、Webhook 等副作用。',
    '- 路径参数、异常输入和业务数据清理。',
    '',
    '验证时请把 observed、inferred、invented、unknown 分开写；当前 invented 数量为 0。',
    '',
  ].join('\n');
}

function packageSource(siteId) {
  return json({
    name: 'heimdall-' + siteId + '-backend-scaffold',
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=22.13.0' },
    scripts: { start: 'node server.mjs', check: 'node checks.mjs' },
  });
}

function build(flags, positional) {
  if (positional[0] !== 'scaffold' || !positional[1]) {
    throw new CapabilityError('invalid_args', '用法：heimdall backend scaffold <siteId> [--out D] [--force] [--json]');
  }
  const siteId = assertSiteId(positional[1]);
  const root = siteDir(siteId);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new CapabilityError('not_found', '没有站点 ' + siteId, { hint: '运行 heimdall overview 列出已有站点。' });
  }
  const base = process.env.HEIMDALL_INVOKE_CWD ?? process.cwd();
  const outDir = resolve(base, flags.out ? String(flags.out) : join(root, 'backend-scaffold'));
  if (existsSync(outDir)) {
    const stat = lstatSync(outDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CapabilityError('invalid_args', '输出目录不是普通目录：' + outDir);
    if (!flags.force && readdirSync(outDir).length) {
      throw new CapabilityError('invalid_args', '输出目录已有文件：' + outDir, { hint: '确认覆盖后加 --force，或换一个 --out 目录。' });
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }
  const source = findContract(root);
  const contract = projectContract(source.source, siteId, source.status);
  const adapter = readAdapter(root);
  const routes = routesOf(contract);
  const dockerfile = [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY package.json server.mjs checks.mjs api-contract.json state-rules.json ./',
    ...(adapter.present ? ['COPY runtime-adapter ./runtime-adapter'] : []),
    'ENV NODE_ENV=production',
    'EXPOSE 8080',
    'CMD ["node", "server.mjs"]',
    '',
  ].join('\n');
  const files = [
    ['package.json', packageSource(siteId)],
    ['server.mjs', serverSource()],
    ['checks.mjs', checksSource()],
    ['api-contract.json', json(contract)],
    ['state-rules.json', json(stateRules(siteId, contract, adapter))],
    ['Dockerfile', dockerfile],
  ];
  for (const [name, value] of files) writeFileChecked(join(outDir, name), value);
  if (adapter.present) {
    const target = join(outDir, 'runtime-adapter');
    mkdirSync(target, { recursive: true });
    writeFileChecked(join(target, 'manifest.json'), json(readJson(join(root, 'runtime-adapter', 'manifest.json'), {})));
    writeFileChecked(join(target, 'index.mjs'), readFileSync(adapter.moduleFile, 'utf8'));
  }
  writeFileChecked(join(outDir, 'README.md'), readmeSource({ siteId, outDir, adapter, routes }));
  const unknowns = ['authentication', 'permissions', 'state-machine', 'business-rules', 'persistence', 'side-effects'];
  if (source.status !== 'observed') unknowns.push('api-contract:' + source.status);
  return ok({
    schema: 'heimdall.backend-scaffold/1',
    siteId,
    level: 'B3-scaffold',
    outDir,
    contract: { status: source.status, source: source.path, observedRoutes: routes.length },
    adapter: { status: adapter.status, present: adapter.present, routes: adapter.routes.length, sessions: adapter.sessions ?? 0 },
    files: files.map(([name]) => name).concat(adapter.present ? ['runtime-adapter/manifest.json', 'runtime-adapter/index.mjs'] : ['runtime-adapter/ not copied']),
    provenance: { observed: source.status === 'observed' ? ['api-contract.json'] : [], inferred: ['state-rules.json', 'checks.mjs'], invented: [] },
    unknowns,
    verification: { commands: ['npm start', 'npm run check', 'GET /__heimdall/health', 'GET /__heimdall/adapter-gaps'] },
  }, {
    summary: 'B3 后端脚手架已生成：' + outDir + '；观察到 ' + routes.length + ' 条路由，' + (adapter.present ? '已带观察回放适配器' : '没有适配器，路由先返回 501') + '。',
    warnings: [
      '这是可运行的后端起点，不是源站后端等价物。',
      ...(source.status !== 'observed' ? ['API 契约状态为 ' + source.status + '，没有自动发明接口。'] : []),
      ...(adapter.present ? ['已复制现有 runtime-adapter；它仍只代表观察样本回放。'] : []),
    ],
  });
}

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const env = (() => {
    try { return build(flags, positional); } catch (error) { return fromError(error); }
  })();
  process.stdout.write((flags.json ? JSON.stringify(env) : [
    env.summary,
    ...(env.warnings ?? []).map(item => '! ' + item),
    ...(env.ok ? ['输出：' + env.result.outDir, '下一步：npm start，然后运行 npm run check。'] : ['[' + env.error.code + '] ' + env.error.message, '下一步：' + env.error.hint]),
  ].join('\n')) + '\n');
  return exitCodeOf(env);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exit(await run(process.argv.slice(2)));
}
