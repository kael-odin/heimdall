/** Explicit read-only contracts. Drafts can be stored, but cannot cause requests. */
import { normalizeAcceptanceUrl, normalizeAcceptancePath, resolveAcceptanceUrl } from './urls.mjs';
import { normalizeResponseSchema } from './response-schema.mjs';
import { openApiDocumentFingerprint } from './openapi.mjs';

export const SPEC_LIMITS = Object.freeze({ checks: 32, omissions: 64, assertions: 20, maxResponseBytes: 1_048_576, runMs: 300_000 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
function fields(value, keys, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string (max ${max})`);
  return value.trim();
}
function list(value, fallback, max, label) {
  value ??= fallback;
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array with at most ${max} entries`);
  return value;
}
function integer(value, fallback, min, max, label) {
  value ??= fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
function idOf(value, label) {
  const id = text(value, label, 80);
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`${label} must use letters, numbers, underscores or hyphens`);
  return id;
}
function jsonValue(value, label) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON`); }
  if (serialized === undefined || serialized.length > 8192) throw new Error(`${label} exceeds its JSON value budget`);
  const check = (entry, depth) => {
    if (depth > 12) throw new Error(`${label} exceeds its JSON depth budget`);
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error(`${label} must contain finite JSON numbers`);
    if (entry && typeof entry === 'object') for (const child of Object.values(entry)) check(child, depth + 1);
    else if (!['string', 'number', 'boolean'].includes(typeof entry) && entry !== null) throw new Error(`${label} must be JSON`);
  };
  check(value, 0);
  return JSON.parse(serialized);
}
export function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || pointer.length > 500 || (pointer !== '' && !pointer.startsWith('/')) || /~(?![01])/u.test(pointer)) throw new Error('JSON pointer must use RFC6901 escaping');
  return pointer === '' ? [] : pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}
function assertionOf(raw) {
  fields(raw, ['pointer', 'kind', 'value', 'type', 'values'], 'JSON assertion');
  pointerTokens(raw.pointer);
  const out = { pointer: raw.pointer, kind: raw.kind };
  if (!['required', 'equals', 'type', 'enum'].includes(raw.kind)) throw new Error('JSON assertion kind must be required, equals, type or enum');
  if (raw.kind === 'equals') {
    if (!own(raw, 'value')) throw new Error('equals assertion requires value');
    out.value = jsonValue(raw.value, 'assertion value');
  } else if (raw.kind === 'type') {
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(raw.type)) throw new Error('invalid assertion type');
    out.type = raw.type;
  } else if (raw.kind === 'enum') {
    out.values = list(raw.values, [], 30, 'enum values').map(value => jsonValue(value, 'enum value'));
    if (!out.values.length) throw new Error('enum assertion requires at least one value');
  }
  for (const key of ['value', 'type', 'values']) if (own(raw, key) && !own(out, key)) throw new Error(`${raw.kind} assertion does not support ${key}`);
  return out;
}
export function normalizeSpecPlan(input) {
  fields(input, ['schemaVersion', 'name', 'mode', 'targetUrl', 'spec', 'timeoutMs', 'maxResponseBytes'], 'Spec plan');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error('unsupported acceptance schema version');
  if (input.mode !== 'spec') throw new Error('Spec plan mode must be spec');
  const targetUrl = normalizeAcceptanceUrl(input.targetUrl, 'targetUrl');
  fields(input.spec, ['source', 'approved', 'checks', 'omissions', 'document'], 'spec');
  fields(input.spec.source, ['id', 'title', 'revision', 'type', 'sha256'], 'spec source');
  const rawSource = input.spec.source;
  const source = { id: text(rawSource.id, 'source id', 160), revision: text(rawSource.revision, 'source revision', 128), type: rawSource.type ?? 'manual' };
  if (!['manual', 'openapi'].includes(source.type)) throw new Error('source type must be manual or openapi');
  if (rawSource.title !== undefined) source.title = text(rawSource.title, 'source title', 200);
  if (rawSource.sha256 !== undefined) {
    if (typeof rawSource.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(rawSource.sha256)) throw new Error('source sha256 must be a SHA-256 hex digest');
    source.sha256 = rawSource.sha256.toLowerCase();
  }
  if (source.type === 'openapi' && !source.sha256) throw new Error('OpenAPI source requires its document sha256');
  let document;
  if (source.type === 'openapi') {
    if (openApiDocumentFingerprint(input.spec.document) !== source.sha256) throw new Error('OpenAPI source document does not match its declared sha256');
    document = JSON.parse(JSON.stringify(input.spec.document));
  } else if (input.spec.document !== undefined) throw new Error('spec document is only supported for OpenAPI sources');
  if (input.spec.approved !== undefined && typeof input.spec.approved !== 'boolean') throw new Error('spec approved must be a boolean');
  const checks = list(input.spec.checks, [], SPEC_LIMITS.checks, 'spec checks').map(raw => {
    fields(raw, ['id', 'title', 'method', 'path', 'severity', 'expect'], 'spec check');
    const id = idOf(raw.id, 'check id');
    const method = String(raw.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Spec only supports GET and HEAD');
    const path = normalizeAcceptancePath(raw.path);
    resolveAcceptanceUrl(targetUrl, path);
    const severity = raw.severity ?? 'high';
    if (!['critical', 'high', 'medium', 'low'].includes(severity)) throw new Error('invalid check severity');
    fields(raw.expect, ['status', 'contentType', 'json', 'schema'], 'check expectation');
    const expect = { status: integer(raw.expect.status, undefined, 100, 599, 'expected HTTP status') };
    if (raw.expect.contentType !== undefined) {
      const contentType = text(raw.expect.contentType, 'expected content type', 150).toLowerCase();
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)) throw new Error('contentType must be a MIME type without parameters');
      expect.contentType = contentType;
    }
    const assertions = list(raw.expect.json, [], SPEC_LIMITS.assertions, 'JSON assertions').map(assertionOf);
    if (assertions.length) expect.json = assertions;
    if (own(raw.expect, 'schema')) expect.schema = normalizeResponseSchema(raw.expect.schema);
    if (method === 'HEAD' && (assertions.length || own(expect, 'schema'))) throw new Error('HEAD contracts cannot assert a response body');
    return { id, title: text(raw.title, 'check title'), method, path, severity, expect };
  });
  const omissions = list(input.spec.omissions, [], SPEC_LIMITS.omissions, 'spec omissions').map((raw, index) => {
    fields(raw, ['id', 'path', 'method', 'reason'], 'spec omission');
    return { id: idOf(raw.id ?? `omission-${index + 1}`, 'omission id'), path: text(raw.path, 'omission path', 1024),
      method: text(raw.method, 'omission method', 20), reason: text(raw.reason, 'omission reason', 1000) };
  });
  if (!checks.length && !omissions.length) throw new Error('Spec requires checks or explicitly declared omissions');
  if (new Set(checks.map(check => check.id)).size !== checks.length || new Set(omissions.map(item => item.id)).size !== omissions.length) throw new Error('Spec IDs must be unique within checks and omissions');
  return { schemaVersion: 1, name: text(input.name ?? '接口契约验收', 'name', 120), mode: 'spec', targetUrl,
    timeoutMs: integer(input.timeoutMs, 10000, 1000, 30000, 'timeoutMs'),
    maxResponseBytes: integer(input.maxResponseBytes, 262144, 1024, SPEC_LIMITS.maxResponseBytes, 'maxResponseBytes'),
    spec: { source, approved: input.spec.approved === true, checks, omissions, ...(document ? { document } : {}) } };
}
