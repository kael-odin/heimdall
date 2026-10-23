/** Convert an OpenAPI JSON document into an unapproved, read-only Spec candidate. */
import { createHash } from 'node:crypto';
import { normalizeResponseSchema, validateResponseSchema } from './response-schema.mjs';
import { normalizeAcceptanceUrl, normalizeAcceptancePath } from './urls.mjs';

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace'];
const ANNOTATIONS = new Set(['title', 'description', 'example', 'examples', 'default', 'deprecated', 'xml', 'externalDocs']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new TypeError(message); };
const own = (value, key) => Object.hasOwn(value, key);

function canonicalJson(value, active = new Set(), state = { nodes: 0 }, depth = 0) {
  if (++state.nodes > 100_000 || depth > 64) fail('OpenAPI document exceeds the JSON complexity limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') fail('OpenAPI document must contain JSON values only');
  if (active.has(value)) fail('OpenAPI document must not contain circular JavaScript objects');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('OpenAPI document requires plain JSON objects');
  const keys = Reflect.ownKeys(value).filter(key => !(Array.isArray(value) && key === 'length'));
  if (keys.some(key => typeof key !== 'string')) fail('OpenAPI document does not support symbol keys');
  if (Array.isArray(value) && (keys.length !== value.length || keys.some(key => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail('OpenAPI document requires dense JSON arrays');
  for (const key of keys) if (!own(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('OpenAPI document does not support accessor properties');
  active.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(item => canonicalJson(item, active, state, depth + 1)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], active, state, depth + 1)}`).join(',')}}`;
  active.delete(value);
  return result;
}

function canonicalDocument(document) {
  if (!object(document)) fail('OpenAPI document must be a JSON object');
  const serialized = canonicalJson(document);
  if (Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024) fail('OpenAPI document exceeds 4 MiB');
  return serialized;
}

/** Full-document SHA-256. Key order is normalized; data and unsupported fields are never trimmed. */
export function openApiDocumentFingerprint(document) {
  return createHash('sha256').update(canonicalDocument(document)).digest('hex');
}

function fixedPath(value) {
  let decoded = value;
  try { for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded); } catch { fail('path contains invalid URL encoding'); }
  if (typeof value !== 'string' || !value.startsWith('/') || decoded.startsWith('//') || /[\\\s?#\u0000-\u001f{}]/.test(decoded)
      || decoded.split('/').some(part => part === '.' || part === '..')) fail('only fixed entry-relative paths without templates, queries or traversal are supported');
  if (value.length > 1024) fail('path exceeds 1024 characters');
  return value;
}

function component(document, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/components/')) fail('only local #/components/ references are supported; external references are never requested');
  let parts;
  try {
    parts = decodeURIComponent(ref.slice(2)).split('/');
    if (parts.some(part => /~(?![01])/u.test(part))) fail('reference must use RFC6901 escaping');
    parts = parts.map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  catch { fail('reference contains invalid encoding'); }
  let result = document;
  for (const part of parts) {
    if (!object(result) || !own(result, part)) fail(`unresolved local reference: ${ref}`);
    result = result[part];
  }
  return result;
}

function dereference(raw, context, chain = []) {
  if (!object(raw)) fail('referenced OpenAPI object must be an object');
  if (!own(raw, '$ref')) return raw;
  const ref = raw.$ref;
  if (chain.length >= 32) fail('reference chain exceeds 32 components');
  if (chain.includes(ref)) fail(`circular reference is unsupported: ${ref}`);
  const extra = Object.keys(raw).filter(key => key !== '$ref' && !['summary', 'description'].includes(key));
  if (extra.length) fail(`reference siblings are unsupported: ${extra.join(', ')}`);
  return dereference(component(context.document, ref), context, [...chain, ref]);
}

function responseSchema(raw, context, chain = [], depth = 0) {
  if (depth > 32) fail('response schema exceeds the reference depth limit');
  if (typeof raw === 'boolean') {
    if (context.version === '3.0') fail('boolean schemas require OpenAPI 3.1');
    return raw;
  }
  if (!object(raw)) fail('response schema must be an object or an OpenAPI 3.1 boolean schema');
  if (raw.writeOnly === true) fail('writeOnly response semantics are outside the executable schema subset');
  if (own(raw, '$ref')) {
    const ref = raw.$ref;
    if (chain.includes(ref)) fail(`circular reference is unsupported: ${ref}`);
    const resolved = responseSchema(component(context.document, ref), context, [...chain, ref], depth + 1);
    const siblings = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== '$ref'));
    if (!Object.keys(siblings).length) return resolved;
    if (context.version === '3.0') {
      if (Object.keys(siblings).some(key => !ANNOTATIONS.has(key))) fail('OpenAPI 3.0 schema $ref siblings are unsupported; put constraints in the referenced schema');
      return resolved;
    }
    return { allOf: [resolved, responseSchema(siblings, context, chain, depth + 1)] };
  }
  const result = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (['deprecated', 'xml', 'externalDocs'].includes(key) || key.startsWith('x-')) continue;
    if (key === 'nullable' && context.version === '3.0') continue;
    if (key === 'properties' && object(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, responseSchema(schema, context, chain, depth + 1)]));
    } else if (['items', 'additionalProperties', 'not'].includes(key) && (object(value) || typeof value === 'boolean')) {
      // OpenAPI 3.0 permits boolean additionalProperties, even though a root boolean schema requires 3.1.
      result[key] = typeof value === 'boolean' && key === 'additionalProperties' ? value : responseSchema(value, context, chain, depth + 1);
    } else if (['allOf', 'anyOf', 'oneOf'].includes(key) && Array.isArray(value)) {
      result[key] = value.map(schema => responseSchema(schema, context, chain, depth + 1));
    } else result[key] = value;
  }
  if (context.version === '3.0') {
    if (own(raw, 'nullable') && typeof raw.nullable !== 'boolean') fail('OpenAPI 3.0 nullable must be boolean');
    if (raw.nullable === true && own(raw, 'type')) {
      if (typeof raw.type !== 'string') fail('OpenAPI 3.0 type must be a single string');
      result.type = [raw.type, 'null'];
    }
    for (const [exclusive, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
      if (own(raw, exclusive) && typeof raw[exclusive] !== 'boolean') fail(`OpenAPI 3.0 ${exclusive} must use boolean syntax`);
      if (typeof raw[exclusive] === 'boolean') {
        delete result[exclusive];
        if (raw[exclusive]) {
          if (typeof raw[bound] !== 'number') fail(`${exclusive}: true requires a numeric ${bound} in OpenAPI 3.0`);
          result[exclusive] = raw[bound];
          delete result[bound];
        }
      }
    }
  }
  return result;
}

function exampleOf(parameter, schema) {
  if (own(parameter, 'example')) return parameter.example;
  if (object(parameter.examples)) {
    const entries = Object.values(parameter.examples);
    if (entries.length !== 1 || !object(entries[0]) || !own(entries[0], 'value') || own(entries[0], '$ref') || own(entries[0], 'externalValue')) fail('query parameter requires one inline example value');
    return entries[0].value;
  }
  if (object(schema) && own(schema, 'example')) return schema.example;
  fail(`query parameter ${parameter.name ?? '(unnamed)'} needs an explicit example`);
}

function operationPath(path, item, operation, context) {
  let result = fixedPath(path);
  const parameters = new Map();
  for (const list of [own(item, 'parameters') ? item.parameters : [], own(operation, 'parameters') ? operation.parameters : []]) {
    if (!Array.isArray(list) || list.length > 32) fail('parameters must be an array with at most 32 entries');
    const seen = new Set();
    for (const raw of list) {
      const parameter = dereference(raw, context);
      if (typeof parameter.name !== 'string' || !parameter.name || parameter.name.length > 120 || /[\u0000-\u001f]/.test(parameter.name)) fail('parameter requires a bounded name');
      const key = `${parameter.in}:${parameter.name}`;
      if (seen.has(key)) fail(`duplicate parameter: ${key}`);
      seen.add(key); parameters.set(key, parameter);
    }
  }
  const query = new URLSearchParams();
  for (const parameter of parameters.values()) {
    if (parameter.in !== 'query') fail(`parameter location ${parameter.in ?? '(missing)'} is unsupported; only explicit primitive query examples can run`);
    if (parameter.content || parameter.allowReserved || parameter.style && parameter.style !== 'form') fail(`query parameter ${parameter.name} uses unsupported serialization`);
    if (!own(parameter, 'schema')) fail(`query parameter ${parameter.name} requires a schema`);
    const schema = normalizeResponseSchema(responseSchema(parameter.schema, context));
    const value = exampleOf(parameter, schema);
    if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail(`query parameter ${parameter.name} requires a primitive non-null example`);
    if (String(value).length > 1000) fail(`query parameter ${parameter.name} example exceeds 1000 characters`);
    if (validateResponseSchema(value, schema).length) fail(`query parameter ${parameter.name} example does not satisfy its schema`);
    query.append(parameter.name, String(value));
  }
  if (query.size) result += `?${query}`;
  return normalizeAcceptancePath(result);
}

function expectation(operation, method, context) {
  if (!object(operation.responses)) fail('operation needs responses');
  const keys = Object.keys(operation.responses);
  const success = keys.filter(key => /^2\d\d$/.test(key));
  if (success.length !== 1 || keys.some(key => /^2XX$/i.test(key))) fail('operation needs exactly one explicit success status; multiple or ranged success responses are ambiguous');
  const response = dereference(operation.responses[success[0]], context);
  const expect = { status: Number(success[0]) };
  if (own(response, 'headers') && (!object(response.headers) || Object.keys(response.headers).length)) fail('response header contracts are not supported');
  if (method === 'HEAD') return expect;
  if (!object(response.content) || Object.keys(response.content).length !== 1) fail('GET requires exactly one JSON response media type');
  const [contentType, media] = Object.entries(response.content)[0];
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i.test(contentType) || !object(media)) fail('only an explicit JSON response media type is supported');
  expect.contentType = contentType.toLowerCase();
  if (own(media, 'schema')) expect.schema = normalizeResponseSchema(responseSchema(media.schema, context));
  return expect;
}

/** No fetch, servers traversal or approval occurs here. Every path operation is accounted once. */
export function previewOpenApi(document, { targetUrl, name } = {}) {
  if (!object(document)) fail('OpenAPI JSON 3.0 or 3.1 is required');
  const serialized = canonicalDocument(document);
  document = JSON.parse(serialized);
  if (typeof document.openapi !== 'string' || !/^3\.(?:0|1)\.\d+$/.test(document.openapi)) fail('OpenAPI JSON 3.0 or 3.1 is required');
  if (!object(document.info) || typeof document.info.title !== 'string' || !document.info.title.trim() || typeof document.info.version !== 'string' || !document.info.version.trim()) fail('OpenAPI info.title and info.version are required');
  if (!object(document.paths)) fail('OpenAPI paths must be an object');
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const context = { document, version: document.openapi.startsWith('3.0.') ? '3.0' : '3.1' };
  const supportedDialect = !document.jsonSchemaDialect || ['https://spec.openapis.org/oas/3.1/dialect/base', 'https://json-schema.org/draft/2020-12/schema'].includes(document.jsonSchemaDialect);
  const checks = [], omissions = [], warnings = [];
  if (document.servers?.length) warnings.push('Document servers are ignored. Only the supplied targetUrl can be executed.');
  if (own(document, 'webhooks')) {
    if (!object(document.webhooks)) fail('OpenAPI webhooks must be an object');
    for (const [name, rawItem] of Object.entries(document.webhooks)) {
      const path = `webhook:${name}`;
      if (path.length > 1024) fail('webhook name exceeds the omission path budget');
      let methods;
      try { const item = dereference(rawItem, context); methods = METHODS.filter(method => own(item, method)); }
      catch { methods = []; }
      for (const method of methods.length ? methods : ['unknown']) omissions.push({ id: `openapi-${checks.length + omissions.length + 1}`, path,
        method: method.toUpperCase(), reason: 'Webhook operations and unresolved webhook references are outside the executable read-only target scope; no request is made.' });
    }
  }
  for (const [path, rawItem] of Object.entries(document.paths)) {
    if (path.startsWith('x-')) continue;
    let item;
    try { item = dereference(rawItem, context); }
    catch (error) {
      omissions.push({ id: `openapi-${omissions.length + checks.length + 1}`, path, method: 'UNKNOWN', reason: String(error.message) });
      continue;
    }
    for (const method of METHODS) {
      if (!own(item, method)) continue;
      const id = `openapi-${omissions.length + checks.length + 1}`;
      const upper = method.toUpperCase();
      try {
        const operation = item[method];
        if (!object(operation)) fail('operation must be an object');
        if (!supportedDialect) fail('custom JSON Schema dialects are outside the executable schema subset');
        if (!['GET', 'HEAD'].includes(upper)) fail('only GET and HEAD are read-only candidates; this method is not executed');
        if (checks.length >= 32) fail('candidate check budget of 32 reached; this operation remains unmeasured');
        const security = own(operation, 'security') ? operation.security : own(document, 'security') ? document.security : [];
        if (!Array.isArray(security) || security.some(requirement => !object(requirement) || Object.keys(requirement).length)) fail('authenticated operations require explicit session support and are omitted');
        if (own(operation, 'requestBody')) fail('request bodies are unsupported in read-only candidates');
        if (own(operation, 'callbacks') && (!object(operation.callbacks) || Object.keys(operation.callbacks).length)) fail('callback contracts are unsupported');
        const route = operationPath(path, item, operation, context);
        const expect = expectation(operation, upper, context);
        checks.push({ id, title: String(operation.summary || operation.operationId || `${upper} ${path}`).slice(0, 200), path: route, method: upper, severity: 'high', expect });
        if (upper === 'GET' && !own(expect, 'schema')) warnings.push(`${upper} ${path} has no response schema; only status, media type and JSON decoding are checked.`);
      } catch (error) {
        omissions.push({ id, path, method: upper, reason: String(error.message).slice(0, 1000) });
      }
    }
  }
  const total = checks.length + omissions.length;
  if (total > 96 || omissions.length > 64) fail('OpenAPI preview exceeds the coverage budget (32 candidates, 64 omissions, 96 total); split the document without dropping operations');
  const title = document.info.title.trim().slice(0, 200);
  const planName = name ?? `${title} API 验收候选`.slice(0, 120);
  if (typeof planName !== 'string' || !planName.trim() || planName.length > 120) fail('name must be a non-empty string with at most 120 characters');
  return {
    plan: { schemaVersion: 1, name: planName.trim(), mode: 'spec', targetUrl: normalizeAcceptanceUrl(targetUrl, 'targetUrl'),
      spec: { source: { id: `openapi-${sha256.slice(0, 16)}`, title, revision: document.info.version.trim().slice(0, 120), type: 'openapi', sha256 }, document, approved: false, checks, omissions } },
    coverage: { declaredOperations: total, candidateChecks: checks.length, omittedOperations: omissions.length, complete: total > 0 && omissions.length === 0, ratio: total ? checks.length / total : 0 },
    warnings,
  };
}
