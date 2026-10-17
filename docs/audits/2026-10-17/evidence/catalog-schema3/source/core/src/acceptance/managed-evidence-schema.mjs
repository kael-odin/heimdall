/** Pure binding of captured evidence to a managed Spec runner result. This is
 * not a second HTTP/schema oracle, a filesystem reader or an authenticity seal. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { fields, plain } from './catalog-schema.mjs';
import { canonicalAcceptanceJson } from './identity.mjs';
import { normalizeSpecPlan, SPEC_LIMITS } from './spec-schema.mjs';
import { resolveAcceptanceUrl } from './urls.mjs';
import { ManagedAcceptanceRunError } from './managed-run-schema.mjs';

const LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024, fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024, files: 1024, nodes: 400_000, depth: 80 });
const OBSERVED_FIELDS = ['requested', 'httpStatus', 'contentType', 'redirectNotFollowed', 'hasLocation', 'mismatches',
  'bodyRead', 'bytes', 'bodySha256', 'body', 'assertions', 'schemaFailures', 'parseError', 'bodyPreview',
  'error', 'errorCode', 'evaluationLimited'];
const fail = () => { throw new ManagedAcceptanceRunError('MANAGED_RUN_INTEGRITY_FAILED', 'INVALID_INPUT'); };
const invalid = () => { throw new ManagedAcceptanceRunError('INVALID_INPUT', 'INVALID_INPUT'); };
const requireThat = value => { if (!value) fail(); };
const shape = (value, allowed, required = allowed) => fields(value, allowed, required, fail);
const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const digest = value => createHash('sha256').update(value).digest('hex');
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get;
const typedSet = Uint8Array.prototype.set, mapForEach = Map.prototype.forEach;

function captureJson(input, maxBytes = LIMITS.jsonBytes, parsed = false) {
  const active = new WeakSet(); let nodes = 0, bytes = 0;
  const spend = value => { bytes += value; requireThat(bytes <= maxBytes); };
  const visit = (value, depth) => {
    requireThat(++nodes <= LIMITS.nodes && depth <= LIMITS.depth);
    if (value === null || typeof value === 'boolean') { spend(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === 'number') { requireThat(Number.isFinite(value)); spend(JSON.stringify(value).length); return value; }
    if (typeof value === 'string') { requireThat(value.length <= maxBytes); spend(Buffer.byteLength(JSON.stringify(value))); return value; }
    requireThat(typeof value === 'object' && !types.isProxy(value) && !active.has(value));
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    requireThat(array ? prototype === Array.prototype || prototype === null : plain(value));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    requireThat(keys.length <= LIMITS.nodes - nodes + 1);
    if (array) requireThat(keys.length === descriptors.length.value + 1);
    const output = array ? [] : {}; let entries = 0;
    active.add(value); spend(2);
    for (const key of keys) {
      const descriptor = descriptors[key];
      requireThat(typeof key === 'string' && (parsed || key !== 'toJSON') && Object.hasOwn(descriptor, 'value'));
      if (array && key === 'length') continue;
      requireThat(descriptor.enumerable && (!array || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < descriptors.length.value));
      if (entries++) spend(1);
      if (!array) { requireThat(key.length <= maxBytes); spend(Buffer.byteLength(JSON.stringify(key)) + 1); }
      Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    active.delete(value); return output;
  };
  return visit(input, 0);
}
function captureFiles(files) {
  requireThat(files !== null && typeof files === 'object' && !types.isProxy(files) && types.isMap(files)
    && Object.getPrototypeOf(files) === Map.prototype && Reflect.ownKeys(files).length === 0);
  const captured = new Map(); let total = 0;
  mapForEach.call(files, (value, name) => {
    requireThat(captured.size < LIMITS.files && typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name)
      && name.length <= 240 && value !== null && typeof value === 'object' && !types.isProxy(value) && types.isUint8Array(value)
      && !types.isSharedArrayBuffer(typedBuffer.call(value)));
    const length = typedLength.call(value);
    requireThat(length > 0 && length <= LIMITS.fileBytes && total + length <= LIMITS.totalBytes);
    const bytes = new Uint8Array(length); typedSet.call(bytes, value);
    total += length; captured.set(name, bytes);
  });
  return captured;
}
function parse(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  // Parsed JSON can legitimately contain a business key named toJSON. It has
  // no executable hooks; external JS facts still forbid that reserved hook.
  return captureJson(value, LIMITS.fileBytes, true);
}
function safeUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
  return url.href;
}
function summary(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  const bytes = JSON.stringify(value);
  return { type: Array.isArray(value) ? 'array' : typeof value,
    ...(typeof value === 'string' || Array.isArray(value) ? { length: value.length } : { properties: Object.keys(value ?? {}).length }),
    sha256: digest(bytes ?? 'undefined'), detail: 'See authenticated response evidence.' };
}
/** Versioned parity with the frozen runner's reportActual projection, not a
 * re-evaluation of actual response values against expectations. */
function reportActual(observed) {
  const { body: _body, bodyPreview: _preview, ...actual } = observed;
  if (actual.assertions) actual.assertions = actual.assertions.map(assertion => ({ ...assertion, actual: assertion.exists ? summary(assertion.actual) : '[missing]' }));
  if (actual.schemaFailures) actual.schemaFailures = actual.schemaFailures.map(failure => ({ ...failure, actual: summary(failure.actual) }));
  if (actual.mismatches) actual.mismatches = actual.mismatches.map(mismatch => ['json-assertion', 'json-schema'].includes(mismatch.kind)
    ? { ...mismatch, actual: mismatch.exists === false ? '[missing]' : summary(mismatch.actual) } : mismatch);
  return actual;
}
function responseOf(observed, check) {
  shape(observed, OBSERVED_FIELDS, ['requested']);
  requireThat(observed.requested === true);
  if (Object.hasOwn(observed, 'httpStatus')) {
    requireThat(Number.isSafeInteger(observed.httpStatus) && observed.httpStatus >= 100 && observed.httpStatus <= 599
      && typeof observed.contentType === 'string' && typeof observed.redirectNotFollowed === 'boolean'
      && typeof observed.hasLocation === 'boolean' && Array.isArray(observed.mismatches));
  } else requireThat(observed.evaluationLimited === true && !Object.hasOwn(observed, 'contentType')
    && !Object.hasOwn(observed, 'redirectNotFollowed') && !Object.hasOwn(observed, 'hasLocation'));
  for (const key of ['assertions', 'schemaFailures', 'mismatches']) if (Object.hasOwn(observed, key)) {
    requireThat(Array.isArray(observed[key]));
    for (const entry of observed[key]) requireThat(plain(entry) && Object.hasOwn(entry, 'actual'));
  }
  if (observed.assertions) for (const assertion of observed.assertions) requireThat(typeof assertion.exists === 'boolean' && typeof assertion.passed === 'boolean');
  if (observed.mismatches) for (const mismatch of observed.mismatches) requireThat(typeof mismatch.kind === 'string');
  if (Object.hasOwn(observed, 'evaluationLimited')) requireThat(observed.evaluationLimited === true);
  if (observed.evaluationLimited === true) requireThat(typeof observed.error === 'string' && observed.error.length > 0 && Object.hasOwn(observed, 'errorCode'));
  else requireThat(!Object.hasOwn(observed, 'error') && !Object.hasOwn(observed, 'errorCode'));
  requireThat(same(reportActual(observed), check.actual) && check.evaluationLimited === (observed.evaluationLimited === true));
  // These are the runner's recorded conjunction outcome and execution-limit
  // facts. No HTTP/schema/assertion predicate is evaluated again here.
  const mismatch = (observed.mismatches?.length ?? 0) > 0, limited = observed.evaluationLimited === true;
  requireThat(!(observed.assertions?.some(assertion => assertion.passed === false)
    || observed.schemaFailures?.length || Object.hasOwn(observed, 'parseError')) || mismatch);
  const status = mismatch ? 'failed' : limited ? 'blocked' : 'passed';
  const verdict = mismatch ? 'bug' : limited ? 'environment' : 'match';
  requireThat(check.status === status && check.verdict === verdict);
}

/** raw first passes validateManagedSpecRaw; this validates its evidence binding.
 * files is the writer's private Map of already captured basename -> bytes.
 * Returns true only after fixed roles/content and recorded result projection
 * agree. The caller must retain physical byte/owner fences through publish.
 * Coordinated rewrites of raw and all evidence cannot prove HTTP authenticity. */
export function validateManagedSpecEvidence(input) {
  fields(input, ['plan', 'raw', 'files'], ['plan', 'raw', 'files'], invalid);
  try {
    const savedPlan = captureJson(input.plan), raw = captureJson(input.raw), files = captureFiles(input.files);
    let plan;
    try { plan = normalizeSpecPlan(savedPlan); } catch { fail(); }
    requireThat(same(plan, savedPlan) && plan.spec.approved === true && plan.spec.checks.length > 0
      && plan.spec.omissions.length === 0 && Array.isArray(raw.checks) && raw.checks.length === plan.spec.checks.length);
    const sourceFingerprint = digest(JSON.stringify(plan.spec.source)), contractFingerprint = digest(JSON.stringify(plan.spec));
    requireThat(raw.sourceFingerprint === sourceFingerprint && raw.contractFingerprint === contractFingerprint);
    const referenced = new Set(), parsed = new Map();
    const read = name => {
      requireThat(files.has(name)); referenced.add(name);
      if (!parsed.has(name)) parsed.set(name, parse(files.get(name)));
      return parsed.get(name);
    };
    const openapi = plan.spec.source.type === 'openapi';
    if (openapi) requireThat(same(read('requirement-source.json'), { source: plan.spec.source, document: plan.spec.document }));
    let requested = 0, capped = false;
    for (const [index, contract] of plan.spec.checks.entries()) {
      const check = raw.checks[index], checkId = `spec-${index + 1}-${contract.id}`;
      requireThat(plain(check) && check.id === checkId && plain(check.actual) && typeof check.actual.requested === 'boolean');
      const evidence = check.evidence;
      shape(evidence, ['source', 'contract', 'request', 'response'], ['contract', ...(openapi ? ['source'] : [])]);
      requireThat(evidence.contract === `${checkId}-contract.json`
        && (openapi ? evidence.source === 'requirement-source.json' : !Object.hasOwn(evidence, 'source')));
      requireThat(same(read(evidence.contract), { source: plan.spec.source, approved: true, contract, contractFingerprint }));
      if (check.actual.requested) {
        requested++;
        requireThat(evidence.request === `${checkId}-request.json` && evidence.response === `${checkId}-response.json`);
        requireThat(same(read(evidence.request), { method: contract.method, url: safeUrl(resolveAcceptanceUrl(plan.targetUrl, contract.path)),
          redirect: 'manual', credentials: 'omit', headers: { Accept: contract.expect.contentType ?? 'application/json, */*;q=0.5' } }));
        responseOf(read(evidence.response), check);
      } else {
        capped = true;
        requireThat(!Object.hasOwn(evidence, 'request') && !Object.hasOwn(evidence, 'response')
          && same(check.actual, { requested: false, reason: 'Run execution budget exhausted.' })
          && check.evaluationLimited === true && check.status === 'blocked' && check.verdict === 'environment');
      }
    }
    requireThat(plain(raw.coverage) && raw.coverage.capped === capped && raw.coverage.planned === plan.spec.checks.length
      && raw.coverage.completed === plan.spec.checks.length && plain(raw.safety) && raw.safety.requests === requested
      && files.size === referenced.size && plan.spec.checks.length <= SPEC_LIMITS.checks);
    return true;
  } catch (cause) {
    if (cause instanceof ManagedAcceptanceRunError) throw cause;
    fail();
  }
}
