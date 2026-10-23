/** Pure input contracts for the narrow managed writer. No owner, filesystem,
 * evidence-origin proof, current-verifier proof or execution permission. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { fields, iso, plain } from './catalog-schema.mjs';
import { canonicalAcceptanceJson, buildAcceptanceIdentity } from './identity.mjs';
import { normalizeSpecPlan, SPEC_LIMITS } from './spec-schema.mjs';
import { RESPONSE_SCHEMA_LIMITS } from './response-schema.mjs';
import { ManagedAcceptanceRunError, validateManagedRunLinkage } from './managed-run-schema.mjs';

export const MANAGED_EXECUTION_LIMITS = Object.freeze({
  rawBytes: 8 * 1024 * 1024, rawNodes: 400_000, rawDepth: 80,
  progressBytes: 8192, progressNodes: 32, progressDepth: 2,
  messageCharacters: 1000, routeCharacters: 1024, errorCharacters: 600,
});
const RAW_FIELDS = ['schemaVersion', 'runId', 'name', 'mode', 'targetUrl', 'startedAt', 'endedAt', 'status',
  'checks', 'coverage', 'specSource', 'sourceFingerprint', 'contractFingerprint', 'specApproval', 'safety', 'environment', 'scope'];
const CHECK_FIELDS = ['id', 'title', 'route', 'viewport', 'dimension', 'severity', 'identity', 'oracle', 'evidenceLevel',
  'expected', 'reproduction', 'evidence', 'status', 'verdict', 'evaluationLimited', 'actual'];
const PROGRESS_KINDS = ['acceptance-started', 'acceptance-check', 'acceptance-heartbeat', 'acceptance-completed'];
const REASON_CODES = ['CANCELLED', 'WATCHDOG_TIMEOUT', 'WATCHDOG_STALLED', 'ENGINE_SHUTDOWN', 'ENGINE_RESTARTED', 'EXECUTION_FAILED'];
const fail = () => { throw new ManagedAcceptanceRunError('INVALID_INPUT', 'INVALID_INPUT'); };
const requireThat = value => { if (!value) fail(); };
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const shape = (value, allowed, required = allowed) => fields(value, allowed, required, fail);

/** Capture by descriptors, accounting for the encoded JSON before returning.
 * Never stringify an input object or call its hooks; reject before getters or
 * proxy traps can execute. Shared references are copied; ancestor cycles fail. */
function captureJson(input, { bytes, nodes, depth }) {
  const active = new WeakSet();
  let seenNodes = 0, seenBytes = 0;
  const add = size => { seenBytes += size; requireThat(seenBytes <= bytes); };
  const visit = (value, level) => {
    requireThat(++seenNodes <= nodes && level <= depth);
    if (value === null || typeof value === 'boolean') { add(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === 'number') { requireThat(Number.isFinite(value)); add(JSON.stringify(value).length); return value; }
    if (typeof value === 'string') {
      requireThat(value.length <= bytes); add(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    requireThat(typeof value === 'object' && !types.isProxy(value) && !active.has(value));
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    requireThat(array ? prototype === Array.prototype || prototype === null : plain(value));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    requireThat(keys.length <= nodes - seenNodes + 1);
    if (array) requireThat(keys.length === descriptors.length.value + 1);
    const output = array ? [] : {};
    active.add(value); add(2);
    let entries = 0;
    for (const key of keys) {
      const descriptor = descriptors[key];
      requireThat(typeof key === 'string' && key !== 'toJSON' && Object.hasOwn(descriptor, 'value'));
      if (array && key === 'length') continue;
      requireThat(descriptor.enumerable && (!array || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < descriptors.length.value));
      if (entries++) add(1);
      if (!array) { requireThat(key.length <= bytes); add(Buffer.byteLength(JSON.stringify(key)) + 1); }
      Object.defineProperty(output, key, { value: visit(descriptor.value, level + 1), enumerable: true, writable: true, configurable: true });
    }
    active.delete(value);
    return output;
  };
  return visit(input, 0);
}

function environmentOf(environment, plan) {
  shape(environment, ['runner', 'platform', 'arch', 'nodeVersion', 'maxResponseBytes', 'timeoutMs']);
  requireThat(environment.runner === 'node-fetch' && text(environment.platform, 80) && text(environment.arch, 80)
    && text(environment.nodeVersion, 80) && environment.maxResponseBytes === plan.maxResponseBytes && environment.timeoutMs === plan.timeoutMs);
}
function evidenceOf(evidence, source) {
  const required = ['contract', ...(source.type === 'openapi' ? ['source'] : [])];
  shape(evidence, ['contract', 'source', 'request', 'response'], required);
  // The writer must still capture and verify every referenced file. A bounded
  // relative name here does not prove containment, bytes, or evidence origin.
  for (const name of Object.values(evidence)) requireThat(text(name, 240) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name));
  if (source.type !== 'openapi') requireThat(!Object.hasOwn(evidence, 'source'));
}
function oracleOf(plan, sourceFingerprint, contractFingerprint) {
  return { kind: 'approved-spec', source: plan.spec.source.id, revision: plan.spec.source.revision,
    sourceFingerprint, documentSha256: plan.spec.source.sha256 ?? null, contractFingerprint };
}
function checkOf(check, index, plan, raw, oracle) {
  const contract = plan.spec.checks[index];
  shape(check, CHECK_FIELDS, CHECK_FIELDS);
  requireThat(check.id === `spec-${index + 1}-${contract.id}` && check.title === contract.title && check.route === contract.path
    && check.viewport === 'api' && check.dimension === 'behavior' && check.severity === contract.severity
    && check.evidenceLevel === 'http-reproduced' && same(check.expected, contract.expect) && same(check.oracle, oracle));
  const definition = { method: contract.method, path: contract.path, expect: contract.expect };
  const source = { id: plan.spec.source.id, revision: plan.spec.source.revision, type: plan.spec.source.type, sha256: plan.spec.source.sha256 ?? null };
  const identity = buildAcceptanceIdentity({ kind: 'spec', facet: 'contract', route: contract.path, contractId: contract.id,
    method: contract.method, viewport: 'api', environment: raw.environment,
    rule: { ...definition, timeoutMs: plan.timeoutMs, maxResponseBytes: plan.maxResponseBytes,
      runMs: SPEC_LIMITS.runMs, responseSchemaLimits: RESPONSE_SCHEMA_LIMITS, redirect: 'manual', credentials: 'omit', allowedMethods: ['GET', 'HEAD'] },
    oracle: { kind: 'spec', source, contract: definition } });
  requireThat(same(check.identity, identity) && typeof check.evaluationLimited === 'boolean' && plain(check.actual));
  requireThat(check.status === 'passed' && check.verdict === 'match'
    || check.status === 'failed' && check.verdict === 'bug'
    || check.status === 'blocked' && check.verdict === 'environment');
  requireThat(Array.isArray(check.reproduction) && check.reproduction.length === 3 && check.reproduction.every(value => text(value, 4096)));
  requireThat(typeof check.actual.requested === 'boolean');
  evidenceOf(check.evidence, plan.spec.source);
  if (check.actual.requested) requireThat(Object.hasOwn(check.evidence, 'request') && Object.hasOwn(check.evidence, 'response'));
  else requireThat(check.status === 'blocked' && check.evaluationLimited === true
    && !Object.hasOwn(check.evidence, 'request') && !Object.hasOwn(check.evidence, 'response'));
}
/** Validate only a completed runner result against its fixed dispatch plan.
 * BUG/environment/omission verdicts remain unchanged. Completion publication,
 * evidence bytes and lifecycle/owner fences are the writer's responsibility. */
export function validateManagedSpecRaw(input) {
  shape(input, ['record', 'manifest', 'raw']);
  shape(input.record, ['bytes', 'sha256', 'envelope'], ['bytes', 'sha256']);
  // Optional metadata must also be safe JSON, but it never supplies authority.
  // Uint8Array bytes remain an opaque capture handled by the frozen linkage.
  if (Object.hasOwn(input.record, 'envelope')) captureJson(input.record.envelope, { bytes: MANAGED_EXECUTION_LIMITS.rawBytes,
    nodes: MANAGED_EXECUTION_LIMITS.rawNodes, depth: MANAGED_EXECUTION_LIMITS.rawDepth });
  const manifest = captureJson(input.manifest, { bytes: MANAGED_EXECUTION_LIMITS.rawBytes,
    nodes: MANAGED_EXECUTION_LIMITS.rawNodes, depth: MANAGED_EXECUTION_LIMITS.rawDepth });
  const linked = validateManagedRunLinkage({ record: input.record, manifest });
  const plan = normalizeSpecPlan(linked.plan);
  const raw = captureJson(input.raw, { bytes: MANAGED_EXECUTION_LIMITS.rawBytes,
    nodes: MANAGED_EXECUTION_LIMITS.rawNodes, depth: MANAGED_EXECUTION_LIMITS.rawDepth });
  shape(raw, RAW_FIELDS);
  requireThat(raw.schemaVersion === 1 && raw.runId === linked.runId && raw.name === plan.name && raw.mode === 'spec'
    && raw.targetUrl === plan.targetUrl && raw.status === 'completed' && iso(raw.startedAt) && iso(raw.endedAt)
    && raw.endedAt >= raw.startedAt);
  requireThat(same(raw.specSource, plan.spec.source) && raw.sourceFingerprint === digest(JSON.stringify(plan.spec.source))
    && raw.contractFingerprint === digest(JSON.stringify(plan.spec)));
  shape(raw.specApproval, ['approved', 'recordedAt']);
  requireThat(raw.specApproval.approved === true && raw.specApproval.recordedAt === raw.startedAt);
  // The current managed dispatch contract admits only a complete Spec scope.
  // A real legacy runner omission is evidence of an unprepared plan, not a new
  // authority to widen the fixed managed plan during finish.
  requireThat(plan.spec.omissions.length === 0);
  const planned = plan.spec.checks.length;
  shape(raw.coverage, ['planned', 'completed', 'capped']);
  requireThat(Array.isArray(raw.checks) && raw.checks.length === planned && raw.coverage.planned === planned
    && raw.coverage.completed === planned && typeof raw.coverage.capped === 'boolean');
  shape(raw.safety, ['readOnly', 'allowedMethods', 'redirects', 'credentials', 'requests']);
  requireThat(raw.safety.readOnly === true && same(raw.safety.allowedMethods, ['GET', 'HEAD'])
    && raw.safety.redirects === 'not-followed' && raw.safety.credentials === 'none'
    && count(raw.safety.requests, plan.spec.checks.length));
  environmentOf(raw.environment, plan);
  requireThat(text(raw.scope, 2000));
  const oracle = oracleOf(plan, raw.sourceFingerprint, raw.contractFingerprint);
  plan.spec.checks.forEach((_contract, index) => checkOf(raw.checks[index], index, plan, raw, oracle));
  requireThat(raw.safety.requests === raw.checks.filter(check => check.actual.requested).length
    && raw.coverage.capped === raw.checks.some(check => !check.actual.requested));
  return raw;
}

/** The caller projects runner event fields; runId/status/plan are not patches. */
export function validateManagedProgress(input) {
  const captured = captureJson(input, { bytes: MANAGED_EXECUTION_LIMITS.progressBytes,
    nodes: MANAGED_EXECUTION_LIMITS.progressNodes, depth: MANAGED_EXECUTION_LIMITS.progressDepth });
  shape(captured, ['progress']);
  const progress = captured.progress;
  shape(progress, ['kind', 'message', 'completed', 'total', 'route', 'viewport', 'at'], ['kind']);
  requireThat(PROGRESS_KINDS.includes(progress.kind));
  if (Object.hasOwn(progress, 'message')) requireThat(text(progress.message, MANAGED_EXECUTION_LIMITS.messageCharacters));
  if (Object.hasOwn(progress, 'route')) requireThat(text(progress.route, MANAGED_EXECUTION_LIMITS.routeCharacters));
  if (Object.hasOwn(progress, 'viewport')) requireThat(progress.viewport === 'api');
  if (Object.hasOwn(progress, 'at')) requireThat(iso(progress.at));
  const max = SPEC_LIMITS.checks + SPEC_LIMITS.omissions;
  for (const key of ['completed', 'total']) if (Object.hasOwn(progress, key)) requireThat(count(progress[key], max));
  if (Object.hasOwn(progress, 'completed') && Object.hasOwn(progress, 'total')) requireThat(progress.completed <= progress.total);
  return captured;
}

/** Settlement does not fabricate a completed report. The writer supplies time
 * and enforces the running-to-terminal transition and blocked gate. */
export function validateManagedSettlement(input) {
  const captured = captureJson(input, { bytes: MANAGED_EXECUTION_LIMITS.progressBytes, nodes: 8, depth: 1 });
  shape(captured, ['status', 'reasonCode', 'error']);
  requireThat(['interrupted', 'failed'].includes(captured.status) && REASON_CODES.includes(captured.reasonCode)
    && text(captured.error, MANAGED_EXECUTION_LIMITS.errorCharacters));
  return captured;
}
