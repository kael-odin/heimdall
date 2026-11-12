/**
 * live/contract — 从已清洗 HAR 生成观察型 B0/B1 接口契约。
 *
 * 这里只输出接口形状、请求体 Schema 和鉴权形态摘要，不输出请求值、响应值、示例数据或业务规则。
 */
import { isPrivateDataKey, MAX_PUBLIC_DATA_BYTES } from './har.mjs';

const JSON_MIME = /^(?:application\/(?:[a-z0-9.+-]+\+)?json|text\/json)$/i;
const STATIC_MIME = /^(?:image\/|font\/|audio\/|video\/|text\/css\b|(?:text|application)\/(?:javascript|x-javascript)\b|application\/(?:font|wasm)\b)/i;
const STATIC_EXT = /\.(?:css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|riv|glb|gltf)$/i;
const API_PATH = /^\/(?:api|graphql|trpc|rpc)(?:\/|$)/i;
const PRIVATE_QUERY_KEY = /(?:auth|token|key|password|passwd|secret|session|cookie|csrf|xsrf|email|phone|address|user|account|customer|patient)/i;
const PRIVATE_PATH_PARENT = /^(?:users?|accounts?|members?|profiles?|customers?|patients?|orders?|invoices?|sessions?|reset-password|password-reset|verify-email|email-verification|magic-link|invites?|invitations?|tokens?|secrets?)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HASH = /^[0-9a-f]{16,}$/i;

function mimeOf(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase() || 'application/octet-stream';
}

function isJsonMime(value) {
  return JSON_MIME.test(mimeOf(value));
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function safePath(url) {
  let decoded = url.pathname;
  for (let i = 0; i < 2; i++) {
    try { decoded = decodeURIComponent(decoded); } catch { return false; }
  }
  const segments = decoded.split('/').filter(Boolean);
  return !segments.some((segment, index) => PRIVATE_PATH_PARENT.test(segment) && !!segments[index + 1]);
}

function pathTemplate(pathname) {
  const trailing = pathname.length > 1 && pathname.endsWith('/') ? '/' : '';
  const segments = pathname.split('/').filter(Boolean).map(segment => {
    const decoded = decodeSegment(segment);
    if (/^\d+$/.test(decoded)) return '{n}';
    if (UUID.test(decoded)) return '{uuid}';
    if (LONG_HASH.test(decoded)) return '{id}';
    return segment;
  });
  return '/' + segments.join('/') + trailing;
}

function safeQueryParams(url) {
  const counts = new Map();
  for (const [rawKey] of url.searchParams) {
    const key = decodeSegment(rawKey).trim().toLowerCase();
    if (!key || key.length > 64 || PRIVATE_QUERY_KEY.test(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isApiEntry(entry, url) {
  const method = String(entry?.method ?? 'GET').toUpperCase();
  const mime = mimeOf(entry?.mimeType);
  return entry?.kind === 'public-read-only-data'
    || method !== 'GET'
    || API_PATH.test(url.pathname)
    || (isJsonMime(mime) && !STATIC_MIME.test(mime) && !STATIC_EXT.test(url.pathname));
}

export function isObservedApiEntry(entry, origin = '') {
  let url;
  try { url = new URL(entry?.url); } catch { return false; }
  return (!origin || url.origin === origin) && safePath(url) && isApiEntry(entry, url);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function stringFormat(value) {
  if (typeof value !== 'string') return undefined;
  if (UUID.test(value)) return 'uuid';
  if (!Number.isNaN(Date.parse(value)) && /[T:]\d{2}/.test(value)) return 'date-time';
  try { if (/^https?:\/\//i.test(value)) return 'uri'; } catch {}
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email';
  return undefined;
}

function schemaForValue(value) {
  const type = typeOf(value);
  if (type === 'object') {
    const properties = Object.create(null);
    const required = [];
    for (const [key, child] of Object.entries(value)) {
      if (isPrivateDataKey(key)) continue;
      properties[key] = schemaForValue(child);
      required.push(key);
    }
    return {
      type: 'object',
      'x-heimdall-provenance': 'observed',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: true,
    };
  }
  if (type === 'array') {
    let items = null;
    for (const child of value) items = mergeSchemas(items, schemaForValue(child));
    return { type: 'array', 'x-heimdall-provenance': 'observed', items: items ?? {} };
  }
  return {
    type,
    'x-heimdall-provenance': 'observed',
    ...(type === 'string' && stringFormat(value) ? { format: stringFormat(value) } : {}),
  };
}

function schemaVariants(schema) {
  if (schema.oneOf) return schema.oneOf.flatMap(schemaVariants);
  return Array.isArray(schema.type) ? schema.type.map(type => ({ ...schema, type })) : [schema];
}

function mergeSchemas(left, right) {
  if (!left || (!left.type && !left.oneOf)) return right;
  if (!right || (!right.type && !right.oneOf)) return left;
  if (left.oneOf || right.oneOf || Array.isArray(left.type) || Array.isArray(right.type)) {
    const byType = new Map();
    for (const variant of [...schemaVariants(left), ...schemaVariants(right)]) {
      const type = variant.type === 'integer' ? 'number' : variant.type;
      byType.set(type, mergeSchemas(byType.get(type), variant));
    }
    const variants = [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
    return variants.length === 1 ? variants[0] : { oneOf: variants, 'x-heimdall-provenance': 'inferred' };
  }
  if (left.type !== right.type) {
    if ([left.type, right.type].every(type => type === 'integer' || type === 'number')) {
      return { type: 'number', 'x-heimdall-provenance': 'observed' };
    }
    return { oneOf: [left, right].sort((a, b) => a.type.localeCompare(b.type)), 'x-heimdall-provenance': 'inferred' };
  }
  if (left.type === 'object') {
    const properties = Object.create(null);
    for (const key of new Set([...Object.keys(left.properties ?? {}), ...Object.keys(right.properties ?? {})])) {
      properties[key] = mergeSchemas(left.properties?.[key], right.properties?.[key]);
    }
    const leftRequired = new Set(left.required ?? []);
    const required = (right.required ?? []).filter(key => leftRequired.has(key));
    return { type: 'object', 'x-heimdall-provenance': 'observed', properties,
      ...(required.length ? { required } : {}), additionalProperties: true };
  }
  if (left.type === 'array') {
    return { type: 'array', 'x-heimdall-provenance': 'observed', items: mergeSchemas(left.items, right.items) ?? {} };
  }
  const format = left.format && left.format === right.format ? left.format : undefined;
  return { type: left.type, 'x-heimdall-provenance': 'observed', ...(format ? { format } : {}) };
}

function parseJsonBody(entry) {
  if (!isJsonMime(entry?.mimeType) || typeof entry?.body !== 'string' || entry.bodyEncoding !== 'base64') return undefined;
  let raw;
  try { raw = Buffer.from(entry.body, 'base64'); } catch { return undefined; }
  if (raw.length > MAX_PUBLIC_DATA_BYTES) return undefined;
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)); } catch { return undefined; }
}

function parameterSchema(name) {
  return { type: 'string', 'x-heimdall-provenance': 'observed', 'x-heimdall-observations': { name } };
}

function operationId(method, path) {
  const slug = path.replace(/[{}]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
  return `observed_${method.toLowerCase()}_${slug}`;
}

function sortStatusCodes(values) {
  return [...values].sort((a, b) => Number(a) - Number(b));
}

function collectEntries(entries, origin) {
  const groups = new Map();
  let apiEntries = 0;
  let excluded = 0;
  for (const entry of entries ?? []) {
    let url;
    try { url = new URL(entry?.url); } catch { excluded++; continue; }
    if (!isObservedApiEntry(entry, origin)) continue;
    apiEntries++;
    const method = String(entry.method ?? 'GET').toUpperCase();
    const path = pathTemplate(url.pathname);
    const key = `${method} ${path}`;
    const group = groups.get(key) ?? {
      method, path, samples: 0, pages: new Set(), queryParams: new Map(), responses: new Map(),
      requestBodies: new Map(), authSchemes: new Map(),
    };
    group.samples++;
    for (const [name, count] of safeQueryParams(url)) group.queryParams.set(name, (group.queryParams.get(name) ?? 0) + count);
    if (entry.requestBody) {
      const mime = String(entry.requestBody.mimeType ?? 'application/octet-stream');
      const bucket = group.requestBodies.get(mime) ?? { samples: 0, schemas: 0, schema: null };
      bucket.samples++;
      if (entry.requestBody.schema) {
        bucket.schemas++;
        bucket.schema = mergeSchemas(bucket.schema, entry.requestBody.schema);
      }
      group.requestBodies.set(mime, bucket);
    }
    for (const scheme of entry.requestAuth ?? []) {
      group.authSchemes.set(scheme, (group.authSchemes.get(scheme) ?? 0) + 1);
    }
    const status = String(Number.isInteger(entry.status) ? entry.status : Number(entry.status) || 0);
    const mime = mimeOf(entry.mimeType);
    const response = group.responses.get(status) ?? new Map();
    const bucket = response.get(mime) ?? { samples: 0, schemas: 0, schema: null };
    bucket.samples++;
    const value = parseJsonBody(entry);
    if (value !== undefined) { bucket.schemas++; bucket.schema = mergeSchemas(bucket.schema, schemaForValue(value)); }
    response.set(mime, bucket);
    group.responses.set(status, response);
    groups.set(key, group);
  }
  return { groups, apiEntries, excluded };
}

function openApiResponse(status, mimeBuckets) {
  const content = {};
  let samples = 0;
  for (const [mime, bucket] of mimeBuckets) {
    samples += bucket.samples;
    content[mime] = {
      'x-heimdall-samples': bucket.samples,
      ...(bucket.schema ? { schema: bucket.schema } : {}),
    };
  }
  return {
    description: `Observed HTTP ${status} response`,
    'x-heimdall-provenance': 'observed',
    'x-heimdall-samples': samples,
    ...(Object.keys(content).length ? { content } : {}),
  };
}

function openApiRequestBody(mimeBuckets) {
  const content = {};
  let samples = 0;
  for (const [mime, bucket] of mimeBuckets) {
    samples += bucket.samples;
    content[mime] = {
      'x-heimdall-samples': bucket.samples,
      'x-heimdall-parseable': bucket.schemas > 0,
      ...(bucket.schema ? { schema: bucket.schema } : {}),
    };
  }
  return { 'x-heimdall-provenance': 'observed', 'x-heimdall-samples': samples, content };
}

function buildOperation(group) {
  const parameters = [];
  for (const name of group.path.matchAll(/\{([^}]+)\}/g)) {
    parameters.push({ name: name[1], in: 'path', required: true, schema: { type: 'string', 'x-heimdall-provenance': 'inferred' }, 'x-heimdall-provenance': 'inferred' });
  }
  for (const [name, occurrences] of [...group.queryParams].sort(([a], [b]) => a.localeCompare(b))) {
    parameters.push({ name, in: 'query', required: false, schema: parameterSchema(name), 'x-heimdall-provenance': 'observed', 'x-heimdall-observations': { occurrences } });
  }
  const responses = {};
  for (const status of sortStatusCodes(group.responses.keys())) responses[status] = openApiResponse(status, group.responses.get(status));
  const requestBody = group.requestBodies.size ? openApiRequestBody(group.requestBodies) : null;
  const authSchemes = [...group.authSchemes.keys()].sort();
  return {
    operationId: operationId(group.method, group.path),
    summary: `Observed ${group.method} ${group.path}`,
    'x-heimdall-provenance': 'observed',
    'x-heimdall-observations': {
      samples: group.samples,
      statusCodes: sortStatusCodes(group.responses.keys()).map(Number),
      queryParams: [...group.queryParams.keys()].sort(),
      ...(group.requestBodies.size ? {
        requestBodyMimes: [...group.requestBodies.keys()].sort(),
        withRequestSchema: [...group.requestBodies.values()].some(bucket => bucket.schemas > 0),
      } : {}),
      ...(authSchemes.length ? { authSchemes } : {}),
    },
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...(authSchemes.length ? {
      'x-heimdall-auth': {
        schemes: authSchemes,
        observations: [...group.authSchemes.values()].reduce((sum, count) => sum + count, 0),
      },
    } : {}),
    responses,
  };
}

function buildUnknowns(groups) {
  const unknowns = [];
  if (!groups.length) return [{ kind: 'no-observed-api', detail: '清洗 HAR 中没有可判定的同源接口条目。' }];
  const authSchemes = [...new Set(groups.flatMap(group => [...group.authSchemes.keys()]))].sort();
  unknowns.push({ kind: 'auth-unknown', ...(authSchemes.length ? { observedSchemes: authSchemes } : {}),
    detail: authSchemes.length
      ? '观察到请求带鉴权形态，但没有验证哪些接口强制鉴权、凭据如何刷新或权限如何变化。'
      : '清洗视图没有观察到可判定的鉴权形态，不能判断接口是否要求登录。' });
  let hasWrite = false;
  for (const group of groups) {
    if (group.method !== 'GET') hasWrite = true;
    if (group.samples === 1) unknowns.push({ kind: 'single-sample', op: `${group.method} ${group.path}`, detail: '该端点只有一个观察样本。' });
    if (group.method !== 'GET' && !group.requestBodies.size) unknowns.push({ kind: 'request-body-unknown', op: `${group.method} ${group.path}`, detail: '非 GET 端点没有观察到请求体。' });
    const statuses = [...group.responses.keys()].map(Number);
    if (!statuses.some(status => status >= 400)) unknowns.push({ kind: 'error-shape-unknown', op: `${group.method} ${group.path}`, detail: '没有观察到 4xx 或 5xx 响应形状。' });
    if (group.queryParams.size && group.samples < 2) unknowns.push({ kind: 'unexercised-param', op: `${group.method} ${group.path}`, detail: '查询参数只在一个样本中出现，未观察到参数变化。' });
  }
  if (!hasWrite) unknowns.push({ kind: 'unexercised-write', detail: '没有观察到非 GET 请求，写入行为未验证。' });
  return unknowns;
}

export function summarizeObservedApiContract(contract) {
  const endpoints = Object.keys(contract?.openapi?.paths ?? {}).reduce((sum, path) => sum + Object.keys(contract.openapi.paths[path]).filter(key => !key.startsWith('x-')).length, 0);
  const observations = contract?.observations ?? [];
  const authSchemes = [...new Set(observations.flatMap(item => item.authSchemes ?? []))].sort();
  return {
    path: 'api-contract.json',
    tier: contract?.tier ?? 'B0',
    endpoints,
    withResponseSchema: observations.filter(item => item.withResponseSchema).length,
    withRequestSchema: observations.filter(item => item.withRequestSchema).length,
    authSchemes,
    errorSamples: observations.reduce((sum, item) => sum + item.errorSamples, 0),
    unknowns: contract?.unknowns?.length ?? 0,
    status: endpoints ? 'observed' : 'no-observed-api',
  };
}

export function buildObservedApiContract(entries, { siteId = '', origin = '', pages = 0, generatedAt = new Date().toISOString() } = {}) {
  const { groups, apiEntries, excluded } = collectEntries(entries, origin);
  const sortedGroups = [...groups.values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
  const paths = {};
  const observations = [];
  let withErrorSample = 0;
  let withWriteSample = 0;
  for (const group of sortedGroups) {
    const operation = buildOperation(group);
    paths[group.path] ??= {};
    paths[group.path][group.method.toLowerCase()] = operation;
    const errorSamples = [...group.responses.entries()].filter(([status]) => Number(status) >= 400)
      .reduce((sum, [, buckets]) => sum + [...buckets.values()].reduce((n, bucket) => n + bucket.samples, 0), 0);
    const withSchema = [...group.responses.values()].some(buckets => [...buckets.values()].some(bucket => bucket.schemas > 0));
    const withRequestSchema = [...group.requestBodies.values()].some(bucket => bucket.schemas > 0);
    const authSchemes = [...group.authSchemes.keys()].sort();
    if (errorSamples) withErrorSample++;
    if (group.method !== 'GET') withWriteSample++;
    observations.push({
      op: `${group.method} ${group.path}`,
      samples: group.samples,
      statusCodes: [...group.responses.keys()].map(Number).sort((a, b) => a - b),
      queryParams: [...group.queryParams.keys()].sort(),
      withResponseSchema: withSchema,
      requestBodyMimes: [...group.requestBodies.keys()].sort(),
      withRequestSchema,
      authSchemes,
      errorSamples,
      provenance: 'observed',
    });
  }
  const unknowns = buildUnknowns(sortedGroups);
  const tier = sortedGroups.length ? 'B1' : 'B0';
  const openapi = {
    openapi: '3.1.0',
    info: { title: `${siteId || 'site'} observed API contract`, version: 'observed-1' },
    ...(origin ? { servers: [{ url: origin, 'x-heimdall-provenance': 'observed' }] } : {}),
    'x-heimdall-tier': tier,
    paths,
  };
  const contract = {
    schema: 'heimdall.contract/1', siteId, generatedAt, tier,
    sources: { pages, journeys: [], harEntries: entries?.length ?? 0, apiEntries, excluded },
    openapi, observations, fixtures: [], unknowns,
    coverage: {
      endpoints: {
        observed: sortedGroups.length, withErrorSample, withWriteSample,
        withRequestSchema: observations.filter(item => item.withRequestSchema).length,
        authObserved: observations.filter(item => item.authSchemes.length > 0).length,
      },
      fixtures: { train: 0, heldout: 0, excluded: 0 },
      unknowns: unknowns.length, invented: 0,
    },
  };
  return { ...contract, summary: summarizeObservedApiContract(contract) };
}
