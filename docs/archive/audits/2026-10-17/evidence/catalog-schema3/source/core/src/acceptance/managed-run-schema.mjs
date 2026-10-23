/** Pure managed-run linkage only. Captured bytes are not an owner, a fresh
 * admission, filesystem-origin proof, evidence verification or completion. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { AcceptanceCatalogError, fields, iso, plain } from './catalog-schema.mjs';
import { canonicalAcceptanceJson } from './identity.mjs';
import { MANAGED_SPEC_DISPATCH_LIMITS, validateManagedSpecDispatchEnvelope } from './managed-dispatch-schema.mjs';
import { normalizeSpecPlan } from './spec-schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MARKERS = Object.freeze(['managed', 'authority', 'dispatchId', 'dispatchSha256', 'operationId', 'executor']);
const RESERVED_INPUT = Object.freeze([...MARKERS, 'runId', 'taskId']);
const ERRORS = Object.freeze({
  INVALID_INPUT: [400, '托管运行校验参数无效。'],
  MANAGED_EXECUTION_REQUIRED: [503, '当前入口尚不支持安全处理托管验收运行。'],
  MANAGED_RUN_INTEGRITY_FAILED: [409, '托管运行与准备记录的关联无法安全核验。'],
});
const REASONS = new Set(['INVALID_INPUT', 'MANAGED_NOT_SUPPORTED', 'DISPATCH_UNAVAILABLE', 'INVALID_RECORD', 'RECORD_BYTES_REQUIRED', 'RECORD_BYTES_EXCEEDED',
  'RECORD_DIGEST_INVALID', 'RECORD_DIGEST_MISMATCH', 'RECORD_JSON_INVALID', 'RECORD_ENVELOPE_INVALID',
  'UNSAFE_JSON', 'JSON_COMPLEXITY_EXCEEDED', 'JSON_BYTES_EXCEEDED', 'RESERVED_INPUT_FIELD',
  'MANIFEST_REQUIRED', 'MANIFEST_MANAGED_REQUIRED', 'MANIFEST_PROVENANCE_MISMATCH', 'MANIFEST_RESERVED_FIELD',
  'MANIFEST_IDENTITY_MISMATCH', 'MANIFEST_PLAN_MISMATCH', 'MANIFEST_STATUS_INVALID',
  'REPORT_MANAGED_REQUIRED', 'REPORT_PROVENANCE_MISMATCH', 'REPORT_RESERVED_FIELD', 'REPORT_IDENTITY_MISMATCH',
  'REPORT_PLAN_MISMATCH', 'REPORT_REQUIREMENT_MISMATCH', 'REPORT_APPROVAL_MISMATCH', 'REPORT_VERIFIER_INVALID']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArraySet = Uint8Array.prototype.set;

/** Neither arbitrary messages/statuses nor underlying parser errors escape. */
export class ManagedAcceptanceRunError extends AcceptanceCatalogError {
  constructor(code = 'MANAGED_RUN_INTEGRITY_FAILED', reason = 'INVALID_INPUT') {
    const safeCode = typeof code === 'string' && Object.hasOwn(ERRORS, code) ? code : 'MANAGED_RUN_INTEGRITY_FAILED';
    const safeReason = typeof reason === 'string' && REASONS.has(reason) ? reason : 'INVALID_INPUT';
    super(safeCode, ERRORS[safeCode][0], ERRORS[safeCode][1], Object.freeze({ reason: safeReason }));
    this.name = 'ManagedAcceptanceRunError';
  }
}
const fail = (reason, code = 'MANAGED_RUN_INTEGRITY_FAILED') => { throw new ManagedAcceptanceRunError(code, reason); };
const requireThat = (value, reason) => { if (!value) fail(reason); };

/** Own markers count even when false, undefined, hidden or accessor-backed.
 * A proxy cannot safely establish absence and is conservatively protected. */
export function hasManagedAcceptanceMarker(value) {
  if (value === null || !['object', 'function'].includes(typeof value)) return false;
  if (types.isProxy(value)) return true;
  return MARKERS.some(key => Object.hasOwn(value, key));
}

/** Top-level plan guard, not a plan normalizer. Nested business JSON can use
 * these names; ordinary manifest runId/taskId are not managed markers. */
export function assertUnmanagedAcceptanceInput(input) {
  if (!plain(input)) fail('INVALID_INPUT', 'INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (RESERVED_INPUT.some(key => Object.hasOwn(descriptors, key))) fail('RESERVED_INPUT_FIELD', 'INVALID_INPUT');
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT', 'INVALID_INPUT');
  }
  return input;
}

/** Capture JSON without invoking accessors/toJSON, following proxies or retaining
 * references. Preserve property order for the existing saved-plan digest. */
function captureJson(value) {
  const active = new WeakSet(), limits = MANAGED_SPEC_DISPATCH_LIMITS;
  let nodes = 0, characters = 0;
  const visit = (entry, depth) => {
    requireThat(++nodes <= limits.jsonNodes && depth <= limits.jsonDepth, 'JSON_COMPLEXITY_EXCEEDED');
    if (entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') { requireThat(Number.isFinite(entry), 'UNSAFE_JSON'); return entry; }
    if (typeof entry === 'string') {
      characters += entry.length; requireThat(characters <= limits.jsonCharacters, 'JSON_COMPLEXITY_EXCEEDED'); return entry;
    }
    requireThat(typeof entry === 'object' && !types.isProxy(entry) && !active.has(entry), 'UNSAFE_JSON');
    const array = Array.isArray(entry);
    requireThat(array ? [Array.prototype, null].includes(Object.getPrototypeOf(entry)) : plain(entry), 'UNSAFE_JSON');
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    if (array) requireThat(keys.length === descriptors.length.value + 1, 'UNSAFE_JSON');
    requireThat(keys.length <= limits.jsonNodes - nodes + 1, 'JSON_COMPLEXITY_EXCEEDED');
    const output = array ? [] : {};
    active.add(entry);
    for (const key of keys) {
      const descriptor = descriptors[key];
      requireThat(typeof key === 'string' && Object.hasOwn(descriptor, 'value'), 'UNSAFE_JSON');
      if (array && key === 'length') continue;
      requireThat(descriptor.enumerable && (!array || /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < descriptors.length.value), 'UNSAFE_JSON');
      characters += key.length; requireThat(characters <= limits.jsonCharacters, 'JSON_COMPLEXITY_EXCEEDED');
      Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    active.delete(entry);
    return output;
  };
  const output = visit(value, 0);
  requireThat(Buffer.byteLength(JSON.stringify(output)) <= limits.jsonBytes, 'JSON_BYTES_EXCEEDED');
  return output;
}

function capturedRecord(record) {
  fields(record, ['envelope', 'bytes', 'sha256'], ['bytes', 'sha256'], () => fail('INVALID_RECORD'));
  const descriptors = Object.getOwnPropertyDescriptors(record), source = descriptors.bytes.value;
  requireThat(source !== null && typeof source === 'object' && !types.isProxy(source) && types.isUint8Array(source), 'RECORD_BYTES_REQUIRED');
  requireThat(!types.isSharedArrayBuffer(typedArrayBuffer.call(source)), 'RECORD_BYTES_REQUIRED');
  const length = typedArrayLength.call(source);
  requireThat(length > 0 && length <= MANAGED_SPEC_DISPATCH_LIMITS.jsonBytes, 'RECORD_BYTES_EXCEEDED');
  const privateBytes = new Uint8Array(length);
  typedArraySet.call(privateBytes, source);
  const sha256 = descriptors.sha256.value;
  requireThat(typeof sha256 === 'string' && HASH.test(sha256), 'RECORD_DIGEST_INVALID');
  requireThat(digest(privateBytes) === sha256, 'RECORD_DIGEST_MISMATCH');
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(privateBytes)); }
  catch { fail('RECORD_JSON_INVALID'); }
  try { validateManagedSpecDispatchEnvelope(envelope); }
  catch { fail('RECORD_ENVELOPE_INVALID'); }
  return { envelope, sha256 };
}

function provenanceOf({ envelope: e, sha256 }) {
  const c = e.candidate;
  return {
    schemaVersion: 1, authority: 'catalog-approval', operationId: e.operationId, dispatchId: e.dispatchId,
    dispatchSha256: sha256, runId: e.runId, taskId: e.taskId,
    catalog: { generationId: e.catalog.generationId, revision: e.catalog.revision, headSha256: e.catalog.headSha256 },
    projectId: e.project.id, selectionId: e.selection.id, approvalId: e.approval.id, candidateId: c.id, contentDigest: c.contentDigest,
    source: { runId: c.source.runId, releaseId: c.source.releaseId, sourceSpecApproved: e.sourceSpecApproved,
      sourcePlanDigest: c.sourcePlanDigest, sourceReportDigest: c.sourceReportDigest,
      evidenceManifestDigest: c.evidenceManifestDigest, verifierFingerprint: c.verifierFingerprint },
    target: { releaseId: e.targetRelease.id, targetUrl: e.targetRelease.targetUrl },
    planFingerprint: e.planFingerprint, executor: e.executor,
  };
}

/** Recompute every time from captured original bytes. record.envelope is ignored. */
export function managedRunProvenanceOf(record) {
  return provenanceOf(capturedRecord(record));
}

function validateProvenance(facts, expected, kind) {
  requireThat(Object.hasOwn(facts, 'managed'), kind + '_MANAGED_REQUIRED');
  requireThat(same(facts.managed, expected), kind + '_PROVENANCE_MISMATCH');
  requireThat(!MARKERS.some(key => key !== 'managed' && Object.hasOwn(facts, key)), kind + '_RESERVED_FIELD');
}

/** Validate identity, not lifecycle/evidence/summary or today's verifier bytes.
 * A running manifest may have an uncommitted completed report. Return fresh
 * private JSON only; callers must separately re-read/fence files before writes. */
export function validateManagedRunLinkage(input) {
  fields(input, ['record', 'manifest', 'report'], ['record', 'manifest'], () => fail('INVALID_INPUT', 'INVALID_INPUT'));
  const captured = capturedRecord(input.record), e = captured.envelope, managed = provenanceOf(captured);
  const manifest = captureJson(input.manifest);
  requireThat(plain(manifest), 'MANIFEST_REQUIRED');
  validateProvenance(manifest, managed, 'MANIFEST');
  requireThat(manifest.schemaVersion === 1 && manifest.runId === e.runId && manifest.taskId === e.taskId
    && manifest.name === e.plan.name && manifest.mode === 'spec' && manifest.targetUrl === e.targetRelease.targetUrl
    && !Object.hasOwn(manifest, 'baselineUrl'), 'MANIFEST_IDENTITY_MISMATCH');
  requireThat(['running', 'completed', 'failed', 'interrupted'].includes(manifest.status)
    && ['passed', 'failed', 'blocked', 'needs_review'].includes(manifest.gate)
    && (manifest.status === 'completed' || manifest.gate === 'blocked'), 'MANIFEST_STATUS_INVALID');
  requireThat(plain(manifest.plan) && same(manifest.plan, e.plan) && digest(JSON.stringify(manifest.plan)) === e.planFingerprint
    && (!Object.hasOwn(manifest, 'planFingerprint') || manifest.planFingerprint === e.planFingerprint), 'MANIFEST_PLAN_MISMATCH');
  let currentVerifierFingerprint = null;
  if (input.report !== undefined) {
    const report = captureJson(input.report), plan = normalizeSpecPlan(e.plan);
    requireThat(plain(report), 'REPORT_IDENTITY_MISMATCH');
    validateProvenance(report, managed, 'REPORT');
    requireThat(report.schemaVersion === 1 && report.runId === e.runId && report.taskId === e.taskId && report.name === plan.name
      && report.mode === 'spec' && report.targetUrl === e.targetRelease.targetUrl && report.status === 'completed'
      && iso(report.startedAt) && iso(report.endedAt) && !Object.hasOwn(report, 'baselineUrl'), 'REPORT_IDENTITY_MISMATCH');
    requireThat(report.planFingerprint === e.planFingerprint, 'REPORT_PLAN_MISMATCH');
    requireThat(plain(report.specSource) && same(report.specSource, plan.spec.source)
      && report.sourceFingerprint === digest(JSON.stringify(plan.spec.source))
      && report.contractFingerprint === digest(JSON.stringify(plan.spec)), 'REPORT_REQUIREMENT_MISMATCH');
    fields(report.specApproval, ['approved', 'recordedAt'], ['approved', 'recordedAt'], () => fail('REPORT_APPROVAL_MISMATCH'));
    requireThat(report.specApproval.approved === true && report.specApproval.recordedAt === report.startedAt, 'REPORT_APPROVAL_MISMATCH');
    requireThat(typeof report.verifierFingerprint === 'string' && HASH.test(report.verifierFingerprint), 'REPORT_VERIFIER_INVALID');
    currentVerifierFingerprint = report.verifierFingerprint;
  }
  return { runId: e.runId, taskId: e.taskId, managed, plan: e.plan, currentVerifierFingerprint };
}
