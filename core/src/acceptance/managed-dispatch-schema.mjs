/** Immutable preparation authorization only; this record does not launch a run. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { AcceptanceCatalogError, actor, boundedText, candidateProjectionOf, fields, id, iso, plain, url } from './catalog-schema.mjs';
import { canonicalAcceptanceJson, hashAcceptanceValue } from './identity.mjs';
import { SPEC_CANDIDATE_PROJECTION_V1 } from './candidate-projection.mjs';
import { normalizeSpecPlan, SPEC_LIMITS } from './spec-schema.mjs';
import { RESPONSE_SCHEMA_LIMITS } from './response-schema.mjs';

export const MANAGED_SPEC_DISPATCH_LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024,
  dispatches: 1024, totalBytes: 256 * 1024 * 1024, directoryEntries: 1152,
  jsonDepth: 80, jsonNodes: 400_000, jsonCharacters: 32 * 1024 * 1024 });
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OPERATION_ID = new RegExp(`^ao-${UUID}$`), DISPATCH_ID = new RegExp(`^ad-${UUID}$`), TASK_ID = new RegExp(`^a-${UUID}$`);
const HASH = /^[a-f0-9]{64}$/;
const REQUEST_FIELDS = ['projectId', 'expectedGenerationId', 'expectedRevision', 'selectionId', 'contentDigest', 'targetReleaseId'];
const DIGESTS = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'scopeKey', 'ruleManifestKey',
  'oracleManifestKey', 'environmentKey', 'verifierFingerprint', 'contentDigest'];
const ENVELOPE_FIELDS = ['schemaVersion', 'operationId', 'dispatchId', 'runId', 'taskId', 'acceptedAt', 'request', 'requestFingerprint',
  'catalog', 'project', 'selection', 'approval', 'candidate', 'sourceRelease', 'targetRelease', 'sourceSpecApproved', 'plan', 'planFingerprint', 'executor'];
const fail = reason => { throw new AcceptanceCatalogError('INVALID_INPUT', 400, '托管 Spec 准备记录无效。', { reason }); };
const requireThat = (condition, reason) => { if (!condition) fail(reason); };
const hash = value => typeof value === 'string' && HASH.test(value);

export const isManagedSpecOperationId = value => typeof value === 'string' && OPERATION_ID.test(value);
export function managedSpecDispatchLimits(input = {}) {
  fields(input, Object.keys(MANAGED_SPEC_DISPATCH_LIMITS), [], fail);
  for (const [key, value] of Object.entries(input)) requireThat(Number.isSafeInteger(value) && value >= 0
    && value <= MANAGED_SPEC_DISPATCH_LIMITS[key], 'INVALID_LIMITS');
  return { ...MANAGED_SPEC_DISPATCH_LIMITS, ...input };
}

/** Reject dangerous input before JSON.stringify or the older plan normalizer. */
function strictData(value, limits) {
  const active = new WeakSet();
  let nodes = 0, characters = 0;
  const visit = (entry, depth) => {
    requireThat(++nodes <= limits.jsonNodes && depth <= limits.jsonDepth, 'JSON_COMPLEXITY_EXCEEDED');
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') { requireThat(Number.isFinite(entry), 'INVALID_JSON'); return; }
    if (typeof entry === 'string') {
      characters += entry.length; requireThat(characters <= limits.jsonCharacters, 'JSON_COMPLEXITY_EXCEEDED'); return;
    }
    requireThat(typeof entry === 'object' && !types.isProxy(entry) && !active.has(entry), 'INVALID_JSON');
    const array = Array.isArray(entry);
    requireThat(array ? [Array.prototype, null].includes(Object.getPrototypeOf(entry)) : plain(entry), 'INVALID_JSON');
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    if (array) requireThat(keys.length === descriptors.length.value + 1, 'INVALID_JSON');
    active.add(entry);
    for (const key of keys) {
      const descriptor = descriptors[key];
      requireThat(typeof key === 'string' && Object.hasOwn(descriptor, 'value'), 'INVALID_JSON');
      if (array && key === 'length') continue;
      requireThat(descriptor.enumerable && (!array || /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < descriptors.length.value), 'INVALID_JSON');
      characters += key.length; requireThat(characters <= limits.jsonCharacters, 'JSON_COMPLEXITY_EXCEEDED');
      visit(descriptor.value, depth + 1);
    }
    active.delete(entry);
  };
  visit(value, 0);
  requireThat(Buffer.byteLength(JSON.stringify(value)) <= limits.jsonBytes, 'JSON_BYTES_EXCEEDED');
}
function requestOf(request) {
  fields(request, REQUEST_FIELDS, REQUEST_FIELDS, fail);
  id(request.projectId, 'ap', fail); id(request.expectedGenerationId, 'ag', fail);
  id(request.selectionId, 'as', fail); id(request.targetReleaseId, 'ar', fail);
  requireThat(Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0 && hash(request.contentDigest), 'INVALID_REQUEST');
  return request;
}
export function managedSpecDispatchRequestFingerprint(request) {
  return hashAcceptanceValue({ domain: 'heimdall-managed-spec-dispatch-request', version: 1, request: requestOf(request) });
}
/** Keep the legacy saved-plan byte algorithm; canonical JSON would change it. */
export function managedSpecDispatchPlanFingerprint(plan) {
  strictData(plan, MANAGED_SPEC_DISPATCH_LIMITS);
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
function releaseOf(release, projectId) {
  const allowed = ['id', 'projectId', 'label', 'targetUrl', 'buildRef', 'createdAt'];
  fields(release, allowed, allowed.filter(key => key !== 'buildRef'), fail);
  id(release.id, 'ar', fail); id(release.projectId, 'ap', fail);
  requireThat(release.projectId === projectId && boundedText(release.label, 120) && iso(release.createdAt)
    && url(release.targetUrl, fail) === release.targetUrl
    && (!Object.hasOwn(release, 'buildRef') || boundedText(release.buildRef, 200)), 'INVALID_RELEASE');
}
function planManifests(plan) {
  const digest = (kind, value) => hashAcceptanceValue({ ...SPEC_CANDIDATE_PROJECTION_V1, kind, value });
  const slots = [], rules = [], contracts = [];
  for (const check of plan.spec.checks) {
    const slot = { contractId: check.id, method: check.method, path: check.path };
    slots.push(slot);
    rules.push({ slot, rule: { method: check.method, path: check.path, expect: check.expect,
      timeoutMs: plan.timeoutMs, maxResponseBytes: plan.maxResponseBytes, runMs: SPEC_LIMITS.runMs,
      responseSchemaLimits: RESPONSE_SCHEMA_LIMITS, redirect: 'manual', credentials: 'omit', allowedMethods: ['GET', 'HEAD'] } });
    contracts.push({ id: check.id, method: check.method, path: check.path, expect: check.expect });
  }
  const compare = (a, b) => {
    const x = canonicalAcceptanceJson(a.slot ?? a), y = canonicalAcceptanceJson(b.slot ?? b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  slots.sort(compare); rules.sort(compare);
  contracts.sort((a, b) => compare({ contractId: a.id, method: a.method, path: a.path }, { contractId: b.id, method: b.method, path: b.path }));
  const source = { id: plan.spec.source.id, revision: plan.spec.source.revision,
    type: plan.spec.source.type, sha256: plan.spec.source.sha256 ?? null };
  return { scopeKey: digest('scope', slots), ruleManifestKey: digest('rules', rules),
    oracleManifestKey: digest('oracle', { source, documentSha256: plan.spec.source.sha256 ?? null, contracts }) };
}

/** Complete structural/reference validation. Original report bytes and live
 * catalog authorization remain the engine's pre-publication guard obligation. */
export function validateManagedSpecDispatchEnvelope(envelope, options = {}) {
  fields(options, ['limits'], [], fail);
  const limits = managedSpecDispatchLimits(options.limits ?? {});
  strictData(envelope, limits);
  fields(envelope, ENVELOPE_FIELDS, ENVELOPE_FIELDS, fail);
  requireThat(envelope.schemaVersion === 1 && isManagedSpecOperationId(envelope.operationId)
    && DISPATCH_ID.test(envelope.dispatchId) && TASK_ID.test(envelope.taskId) && iso(envelope.acceptedAt)
    && envelope.executor === 'engine-owner-spec-v1' && typeof envelope.sourceSpecApproved === 'boolean', 'INVALID_ENVELOPE');
  id(envelope.runId, 'ac', fail);
  const request = requestOf(envelope.request), project = envelope.project, catalog = envelope.catalog;
  requireThat(envelope.requestFingerprint === managedSpecDispatchRequestFingerprint(request), 'REQUEST_FINGERPRINT_MISMATCH');
  fields(catalog, ['generationId', 'revision', 'headSha256'], ['generationId', 'revision', 'headSha256'], fail);
  id(catalog.generationId, 'ag', fail);
  requireThat(catalog.generationId === request.expectedGenerationId && catalog.revision === request.expectedRevision
    && hash(catalog.headSha256), 'CATALOG_CONTEXT_MISMATCH');
  fields(project, ['id', 'name', 'createdAt'], ['id', 'name', 'createdAt'], fail);
  id(project.id, 'ap', fail);
  requireThat(project.id === request.projectId && boundedText(project.name, 120) && iso(project.createdAt), 'INVALID_PROJECT');
  const candidate = envelope.candidate;
  const candidateFields = ['id', 'projectId', 'mode', 'projectionVersion', 'source', ...DIGESTS, 'createdAt'];
  fields(candidate, candidateFields, candidateFields, fail);
  id(candidate.id, 'ab', fail); id(candidate.projectId, 'ap', fail);
  fields(candidate.source, ['runId', 'sourceMode', 'side', 'releaseId'], ['runId', 'sourceMode', 'side', 'releaseId'], fail);
  id(candidate.source.runId, 'ac', fail); id(candidate.source.releaseId, 'ar', fail);
  requireThat(candidate.projectId === project.id && candidate.mode === 'spec' && candidate.projectionVersion === 1
    && candidate.source.sourceMode === 'spec' && candidate.source.side === 'source' && iso(candidate.createdAt)
    && candidate.source.runId !== envelope.runId && DIGESTS.every(key => hash(candidate[key])), 'INVALID_CANDIDATE');
  const { contentDigest: _digest, ...projection } = candidateProjectionOf(candidate);
  requireThat(hashAcceptanceValue(projection) === candidate.contentDigest && candidate.contentDigest === request.contentDigest, 'CANDIDATE_DIGEST_MISMATCH');
  const approval = envelope.approval;
  const approvalFields = ['id', 'projectId', 'candidateId', 'contentDigest', 'reason', 'approvedAt', 'actor'];
  fields(approval, approvalFields, approvalFields, fail);
  id(approval.id, 'aa', fail); id(approval.projectId, 'ap', fail); id(approval.candidateId, 'ab', fail); actor(approval.actor, fail);
  requireThat(approval.projectId === project.id && approval.candidateId === candidate.id && approval.contentDigest === candidate.contentDigest
    && boundedText(approval.reason, 1000) && iso(approval.approvedAt), 'APPROVAL_CONTEXT_MISMATCH');
  const selection = envelope.selection;
  const selectionFields = ['id', 'projectId', 'mode', 'approvalId', 'previousSelectionId', 'reason', 'selectedAt', 'actor'];
  fields(selection, selectionFields, selectionFields, fail);
  id(selection.id, 'as', fail); id(selection.projectId, 'ap', fail); id(selection.approvalId, 'aa', fail); actor(selection.actor, fail);
  if (selection.previousSelectionId !== null) id(selection.previousSelectionId, 'as', fail);
  requireThat(selection.id === request.selectionId && selection.projectId === project.id && selection.mode === 'spec'
    && selection.approvalId === approval.id && selection.previousSelectionId !== selection.id
    && boundedText(selection.reason, 1000) && iso(selection.selectedAt), 'SELECTION_CONTEXT_MISMATCH');
  releaseOf(envelope.sourceRelease, project.id); releaseOf(envelope.targetRelease, project.id);
  requireThat(envelope.sourceRelease.id === candidate.source.releaseId && envelope.targetRelease.id === request.targetReleaseId, 'RELEASE_CONTEXT_MISMATCH');
  if (envelope.sourceRelease.id === envelope.targetRelease.id) requireThat(canonicalAcceptanceJson(envelope.sourceRelease)
    === canonicalAcceptanceJson(envelope.targetRelease), 'RELEASE_CONTEXT_MISMATCH');
  let plan;
  try { plan = normalizeSpecPlan(envelope.plan); } catch { fail('INVALID_PLAN'); }
  requireThat(canonicalAcceptanceJson(plan) === canonicalAcceptanceJson(envelope.plan) && plan.targetUrl === envelope.targetRelease.targetUrl
    && plan.spec.approved === true && plan.spec.checks.length > 0 && plan.spec.omissions.length === 0, 'PLAN_CONTEXT_MISMATCH');
  requireThat(envelope.planFingerprint === managedSpecDispatchPlanFingerprint(envelope.plan), 'PLAN_FINGERPRINT_MISMATCH');
  const manifests = planManifests(plan);
  requireThat(Object.entries(manifests).every(([key, value]) => value === candidate[key]), 'PLAN_CANDIDATE_MISMATCH');
  return envelope;
}
