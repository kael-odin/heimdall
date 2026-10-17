/** Single-operation Browser approval and immutable observation schemas. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalAcceptanceJson, hashAcceptanceValue } from './identity.mjs';
import { browserCandidateContentOf, browserBindingProjectionOf } from './catalog-schema.mjs';
import { hashBrowserCandidateValue } from './browser-candidate-identity.mjs';
import { hashOrganizedBrowserCandidateValue } from './browser-organized-candidate-identity.mjs';
import { summarizeAcceptanceReport } from './report.mjs';
import { validateFixedBrowserContract, fixedBrowserCheckIdentity, fixedBrowserEnvironmentComparison } from './browser-fixed-contract.mjs';

export const BROWSER_OPERATION_LIMITS = Object.freeze({ operations: 1024, jsonBytes: 12 * 1024 * 1024, rejectionBytes: 16 * 1024,
  evidenceFiles: 1024, evidenceFileBytes: 64 * 1024 * 1024, evidenceBytes: 256 * 1024 * 1024,
  checks: 240, directoryEntries: 1152 });
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const ID = prefix => new RegExp(`^${prefix}-${UUID}$`);
export const isBrowserOperationId = value => typeof value === 'string' && ID('bo').test(value);
export const isBrowserRunId = value => typeof value === 'string' && ID('br').test(value);
export const browserOperationSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const browserOperationSame = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
export const browserOperationFileName = value => typeof value === 'string' && value.length <= 240
  && /^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(value)
  && !['dispatch.json', 'head.json', 'report.json', 'observations.json', 'rejection.json'].includes(value.toLowerCase())
  && !value.includes('.tmp.');
export const browserOperationHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const browserOperationIso = value => typeof value === 'string' && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export class BrowserOperationError extends Error {
  constructor(code = 'BROWSER_OPERATION_UNAVAILABLE', status = 503, reason = 'UNAVAILABLE') {
    super(code === 'NOT_FOUND' ? 'Browser 验收操作不存在。' : code === 'INVALID_INPUT' ? 'Browser 验收参数无效。'
      : code === 'IDEMPOTENCY_CONFLICT' ? '操作 ID 已用于另一份确认。' : 'Browser 验收记录无法安全核验；原件已保留。');
    this.name = 'BrowserOperationError'; this.code = code; this.status = status;
    this.details = { reason };
  }
}
export const browserOperationFail = (reason, code = 'BROWSER_OPERATION_UNAVAILABLE', status = 503) => {
  throw new BrowserOperationError(code, status, reason);
};
const need = (value, reason = 'INVALID_RECORD') => { if (!value) browserOperationFail(reason); };
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function browserOperationJson(value, maximum = BROWSER_OPERATION_LIMITS.jsonBytes) {
  const pending = [[value, 0]]; let nodes = 0, characters = 0;
  while (pending.length) {
    const [entry, depth] = pending.pop(); need(++nodes <= 400000 && depth <= 80, 'JSON_BUDGET');
    if (typeof entry === 'string') characters += entry.length;
    else if (entry !== null && typeof entry === 'object') {
      need(!types.isProxy(entry) && (Array.isArray(entry) || plain(entry)), 'INVALID_JSON');
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      for (const key of Reflect.ownKeys(descriptors)) {
        need(typeof key === 'string' && Object.hasOwn(descriptors[key], 'value'), 'INVALID_JSON');
        if (Array.isArray(entry) && key === 'length') continue;
        need(descriptors[key].enumerable, 'INVALID_JSON');
        characters += key.length; pending.push([descriptors[key].value, depth + 1]);
        need(pending.length + nodes <= 400000, 'JSON_BUDGET');
      }
    } else need(entry === null || typeof entry === 'boolean' || typeof entry === 'number' && Number.isFinite(entry), 'INVALID_JSON');
    need(characters <= 32 * 1024 * 1024, 'JSON_BUDGET');
  }
  canonicalAcceptanceJson(value);
  const bytes = Buffer.from(JSON.stringify(value)); need(bytes.length <= maximum, 'JSON_BUDGET');
  return JSON.parse(bytes.toString('utf8'));
}
function fields(value, allowed, required = allowed) {
  need(plain(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  need(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && allowed.includes(key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')));
  need(required.every(key => Object.hasOwn(descriptors, key)));
}
function ident(value, prefix) { need(typeof value === 'string' && ID(prefix).test(value), 'INVALID_ID'); }
export function validateBrowserOperationRequest(raw) {
  try {
    fields(raw, ['operationId', 'expectedGenerationId', 'expectedRevision', 'candidateId', 'contentDigest', 'targetReleaseId']);
    ident(raw.operationId, 'bo'); ident(raw.expectedGenerationId, 'ag'); ident(raw.candidateId, 'bc'); ident(raw.targetReleaseId, 'ar');
    need(Number.isSafeInteger(raw.expectedRevision) && raw.expectedRevision >= 0 && browserOperationHash(raw.contentDigest));
    return browserOperationJson(raw, 16 * 1024);
  } catch { browserOperationFail('INVALID_REQUEST', 'INVALID_INPUT', 400); }
}
export function browserOperationRequestFingerprint(raw) {
  fields(raw, ['projectId', 'operationId', 'expectedGenerationId', 'expectedRevision', 'candidateId', 'contentDigest', 'targetReleaseId']);
  ident(raw.projectId, 'ap'); const { projectId, ...request } = raw;
  return hashAcceptanceValue({ domain: 'heimdall-browser-operation-request', version: 1, projectId,
    request: validateBrowserOperationRequest(request) });
}
export function validateBrowserOperationRejection(input) {
  const e = browserOperationJson(input, BROWSER_OPERATION_LIMITS.rejectionBytes);
  fields(e, ['schemaVersion', 'kind', 'projectId', 'operationId', 'request', 'requestFingerprint',
    'rejectedAt', 'reasonCode', 'effect', 'actor']);
  ident(e.projectId, 'ap'); ident(e.operationId, 'bo');
  const request = validateBrowserOperationRequest(e.request);
  fields(e.actor, ['kind']);
  need(e.schemaVersion === 1 && e.kind === 'browser-start-rejection' && request.operationId === e.operationId
    && e.requestFingerprint === browserOperationRequestFingerprint({ projectId: e.projectId, ...request })
    && browserOperationIso(e.rejectedAt) && e.reasonCode === 'USER_REJECTED_UNKNOWN_START'
    && e.effect === 'deny-future-starts-for-operation' && e.actor.kind === 'local-user', 'INVALID_REJECTION');
  return e;
}
export function browserOperationRejectionBytes(value) {
  const record = validateBrowserOperationRejection(value);
  const bytes = Buffer.from(canonicalAcceptanceJson(record) + '\n', 'utf8');
  need(bytes.length <= BROWSER_OPERATION_LIMITS.rejectionBytes, 'REJECTION_BUDGET');
  return bytes;
}
export function validateBrowserOperationDispatch(input) {
  const e = browserOperationJson(input);
  fields(e, ['schemaVersion', 'operationId', 'runId', 'taskId', 'acceptedAt', 'request', 'requestFingerprint',
    'project', 'candidate', 'sourceBinding', 'sourceRelease', 'targetRelease', 'approval', 'contract', 'contractFingerprint']);
  need(e.schemaVersion === 1 && isBrowserOperationId(e.operationId) && isBrowserRunId(e.runId)
    && ID('a').test(e.taskId) && browserOperationIso(e.acceptedAt));
  const request = validateBrowserOperationRequest(e.request);
  need(request.operationId === e.operationId && request.candidateId === e.candidate.id
    && request.contentDigest === e.candidate.contentDigest && request.targetReleaseId === e.targetRelease.id);
  ident(e.project.id, 'ap'); ident(e.candidate.id, 'bc'); ident(e.sourceBinding.id, 'ax');
  ident(e.sourceRelease.id, 'ar'); ident(e.targetRelease.id, 'ar');
  need(e.requestFingerprint === browserOperationRequestFingerprint({ projectId: e.project.id, ...request }));
  const c = e.candidate;
  need(c.projectId === e.project.id && c.releaseId === e.sourceRelease.id && c.sourceBindingId === e.sourceBinding.id
    && c.mode === 'browser' && c.candidateContractVersion === 1
    && c.contentDigest === hashOrganizedBrowserCandidateValue('content', browserCandidateContentOf(c)));
  need(e.sourceBinding.projectId === e.project.id && e.sourceBinding.releaseId === e.sourceRelease.id
    && e.sourceBinding.sourceContentDigest === c.sourceContentDigest
    && e.targetRelease.projectId === e.project.id && e.sourceRelease.projectId === e.project.id);
  need(c.organizationContextDigest === hashOrganizedBrowserCandidateValue('organization-context',
    { project: e.project, release: e.sourceRelease, sourceBinding: e.sourceBinding }), 'ORGANIZATION_CONTEXT_MISMATCH');
  const { contentDigest: bindingDigest, ...bindingProjection } = browserBindingProjectionOf(e.sourceBinding);
  need(bindingDigest === hashBrowserCandidateValue('content', bindingProjection), 'SOURCE_BINDING_MISMATCH');
  fields(e.approval, ['scope', 'candidateId', 'contentDigest', 'targetReleaseId', 'approvedAt', 'actor']);
  need(e.approval.scope === 'single-operation' && e.approval.candidateId === c.id
    && e.approval.contentDigest === c.contentDigest && e.approval.targetReleaseId === e.targetRelease.id
    && e.approval.approvedAt === e.acceptedAt && browserOperationSame(e.approval.actor, { kind: 'local-user' }));
  validateFixedBrowserContract(e.contract);
  need(e.contract.projectId === e.project.id && e.contract.candidateId === c.id && e.contract.contentDigest === c.contentDigest
    && e.contract.targetReleaseId === e.targetRelease.id && e.contract.targetUrl === e.targetRelease.targetUrl
    && e.contract.fixedBaseline.sourceBindingId === e.sourceBinding.id
    && e.contract.fixedBaseline.sourceRunId === e.sourceBinding.source.runId
    && e.contract.fixedBaseline.sourceSide === e.sourceBinding.source.side
    && e.contract.fixedBaseline.sourceContentDigest === c.sourceContentDigest
    && e.contract.fixedBaseline.organizationContextDigest === c.organizationContextDigest
    && e.contractFingerprint === e.contract.contractDigest);
  const contract = e.contract, b = contract.fixedBaseline, binding = e.sourceBinding;
  need(b.sourceMode === binding.source.sourceMode && b.entryUrl === binding.source.entryUrl && b.entryUrl === e.sourceRelease.targetUrl
    && ['sourcePlanDigest', 'selectedEvidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey', 'verifierFingerprint']
      .every(k => b[k] === binding[k])
    && binding.environmentKey === hashBrowserCandidateValue('environment', b.sourceEnvironment)
    && binding.scopeKey === hashBrowserCandidateValue('scope', contract.scope)
    && binding.ruleManifestKey === hashBrowserCandidateValue('rules', contract.rules)
    && binding.selectedEvidenceManifestDigest === hashBrowserCandidateValue('selected-evidence',
      contract.observations.map(v => ({ slot: v.slot, roles: v.evidence })))
    && binding.oracleManifestKey === hashBrowserCandidateValue('oracle', contract.observations.map(v =>
      ({ slot: v.slot, oracle: { kind: 'captured-browser-side', entryUrl: b.entryUrl, ...v.expected } }))), 'CONTRACT_SOURCE_MISMATCH');
  return e;
}
export function validateBrowserOperationHead(input, record) {
  const h = browserOperationJson(input, 64 * 1024), e = record.envelope;
  fields(h, ['schemaVersion', 'operationId', 'runId', 'taskId', 'dispatchSha256', 'status', 'gate',
    'createdAt', 'updatedAt', 'reportSha256', 'reasonCode']);
  need(h.schemaVersion === 1 && h.operationId === e.operationId && h.runId === e.runId && h.taskId === e.taskId
    && h.dispatchSha256 === record.sha256 && browserOperationIso(h.createdAt) && browserOperationIso(h.updatedAt)
    && h.createdAt === e.acceptedAt && h.updatedAt >= h.createdAt);
  need(['running', 'completed', 'failed', 'interrupted'].includes(h.status)
    && ['passed', 'failed', 'blocked', 'needs_review'].includes(h.gate));
  need(h.status === 'completed' ? browserOperationHash(h.reportSha256) && h.reasonCode === null
    : h.reportSha256 === null && h.gate === 'blocked'
      && (h.status === 'running' ? h.reasonCode === null : typeof h.reasonCode === 'string' && /^[A-Z_]{1,80}$/.test(h.reasonCode)));
  return h;
}
const bug = c => c.status === 'failed' && c.verdict === 'bug';
export function browserCheckReliablePassed(check) {
  const a = check.actual ?? {};
  return check.status === 'passed' && check.verdict === 'match' && check.evaluationLimited !== true
    && a.eligible !== false && a.policyAffected !== true && a.stepsComplete !== false
    && !['error', 'errorCode', 'navigationError', 'captureError', 'stepError', 'parseError'].some(k => a[k])
    && !(a.blockedRequests?.length) && !(a.errors?.length) && !(a.network?.length) && a.overflow !== true
    && !(a.assertions?.some(v => v.passed !== true))
    && !['baselineStability', 'targetStability'].some(k => typeof a[k] === 'number' && a[k] < .9995)
    && !Object.values(a.capture ?? {}).some(v => v?.captureLimited)
    && !Object.values(a.maskCoverage ?? {}).some(v => v?.samplingCapped || v?.maskedRatio > .8);
}
export function validateBrowserOperationReport(input, record) {
  const report = browserOperationJson(input), e = record.envelope, contract = e.contract;
  need(report.schemaVersion === 1 && report.runId === e.runId && report.mode === 'browser-fixed'
    && report.targetUrl === e.targetRelease.targetUrl && report.targetReleaseId === e.targetRelease.id
    && report.status === 'completed' && browserOperationIso(report.startedAt) && browserOperationIso(report.endedAt)
    && report.endedAt >= report.startedAt && report.contractDigest === contract.contractDigest
    && browserOperationSame(report.fixedBaseline, contract.fixedBaseline)
    && report.baselineUrl === contract.fixedBaseline.entryUrl && report.name === contract.plan.name
    && browserOperationSame(report.sourceEvidence, contract.sourceEvidence)
    && browserOperationSame(report.resolution, { kind: 'observation-only', closesBugs: false }));
  need(Array.isArray(report.checks) && report.checks.length >= 1 && report.checks.length <= BROWSER_OPERATION_LIMITS.checks);
  const coverage = report.coverage;
  need(plain(coverage) && Number.isSafeInteger(coverage.planned) && coverage.completed === report.checks.length
    && typeof coverage.capped === 'boolean');
  need(plain(report.safety) && report.safety.networkPolicy === 'read-only' && report.safety.isolatedContexts === true
    && Number.isSafeInteger(report.safety.blockedRequests) && report.safety.blockedRequests >= 0);
  need(plain(report.environment) && browserOperationSame(report.environmentComparison,
    fixedBrowserEnvironmentComparison(contract, report.environment)), 'ENVIRONMENT_COMPARISON_MISMATCH');
  const ids = new Set(), contexts = new Set(), covered = new Set(); let readonly = 0, diagnostics = 0;
  for (const check of report.checks) {
    need(plain(check) && typeof check.id === 'string' && check.id.length <= 240 && !ids.has(check.id)); ids.add(check.id);
    need(['passed', 'failed', 'blocked', 'needs_review'].includes(check.status)
      && ['match', 'bug', 'baseline_failed', 'environment', 'needs_review'].includes(check.verdict)
      && (check.status !== 'passed' || check.verdict === 'match') && (check.verdict !== 'bug' || check.status === 'failed'));
    const i = check.identity;
    // Environment-only terminal diagnostics may lack a case identity; never become BUGs or reliable passes.
    if (!i) { need(check.id === 'runner-environment' && check.status === 'blocked' && check.verdict === 'environment'
      && plain(check.evidence) && Object.keys(check.evidence).length === 0); diagnostics++; continue; }
    need(i.version === 1 && i.kind === 'browser' && ['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey'].every(k => browserOperationHash(i[k]))
      && !contexts.has(i.contextKey)); contexts.add(i.contextKey);
    const slot = { route: check.route, viewport: i.viewport, ...(i.pointId ? { pointId: i.pointId } : {}), facet: i.facet };
    const rule = contract.rules.find(v => browserOperationSame(v.slot, slot));
    const observationSlot = { route: check.route, viewport: i.viewport, ...(i.pointId ? { pointId: i.pointId } : {}) };
    const observation = contract.observations.find(v => browserOperationSame(v.slot, observationSlot));
    if (i.facet === 'readonly') {
      need(!i.pointId && observation && check.status === 'blocked' && check.verdict === 'environment', 'REPORT_SLOT_MISMATCH'); readonly++;
    } else { need(rule && observation, 'REPORT_SLOT_MISMATCH'); covered.add(canonicalAcceptanceJson(slot)); }
    const rebuilt = fixedBrowserCheckIdentity(contract, report.environment, observationSlot, i.facet);
    need(rebuilt && browserOperationSame(rebuilt, i), 'REPORT_IDENTITY_MISMATCH');
    need(plain(check.evidence), 'REPORT_EVIDENCE_MISSING');
    need(Object.values(check.evidence).every(v => v === null || browserOperationFileName(v)), 'REPORT_EVIDENCE_INVALID');
    for (const [role, sourceRole] of [['baselineScreenshot', 'screenshot'], ['baselineDetails', 'details'], ['baselineRepeat', 'repeat']]) {
      need(check.evidence[role] === 'source-' + observation.evidence[sourceRole].file, 'REPORT_SOURCE_SLOT_MISMATCH');
    }
    if (check.status === 'passed' || bug(check)) {
      for (const role of ['baselineScreenshot', 'baselineDetails', 'baselineRepeat', 'targetScreenshot', 'targetDetails', 'targetRepeat',
        ...(i.facet === 'visual' ? ['diff'] : [])]) need(browserOperationFileName(check.evidence[role]), 'REPORT_EVIDENCE_MISSING');
    }
    need(check.status !== 'passed' || browserCheckReliablePassed(check), 'UNRELIABLE_PASS');
  }
  const planned = contract.scope.length + readonly;
  need(diagnostics <= 1 && coverage.planned === Math.max(planned, report.checks.length), 'REPORT_COVERAGE_MISMATCH');
  const incomplete = covered.size !== contract.scope.length || diagnostics > 0;
  need(!incomplete || !report.checks.some(c => ['passed', 'failed'].includes(c.status)), 'REPORT_COVERAGE_INCOMPLETE');
  need(report.environmentComparison.comparable || !report.checks.some(c => ['passed', 'failed'].includes(c.status)), 'REPORT_ENVIRONMENT_UNRELIABLE');
  if (report.operationId !== undefined) need(report.operationId === e.operationId && report.taskId === e.taskId
    && report.dispatchSha256 === record.sha256 && report.contractFingerprint === e.contractFingerprint);
  if (report.evidenceManifest !== undefined) {
    need(browserOperationHash(report.verifierFingerprint) && report.operationId === e.operationId && report.taskId === e.taskId
      && report.dispatchSha256 === record.sha256 && report.contractFingerprint === e.contractFingerprint, 'REPORT_BINDING_MISSING');
    need(Array.isArray(report.evidenceManifest) && report.evidenceManifest.length <= BROWSER_OPERATION_LIMITS.evidenceFiles);
    const names = new Set(); let total = 0;
    for (const item of report.evidenceManifest) {
      fields(item, ['file', 'bytes', 'sha256']); need(browserOperationFileName(item.file) && !names.has(item.file)
        && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= BROWSER_OPERATION_LIMITS.evidenceFileBytes
        && browserOperationHash(item.sha256)); names.add(item.file); total += item.bytes;
    }
    need(total <= BROWSER_OPERATION_LIMITS.evidenceBytes);
    const summary = summarizeAcceptanceReport(report); need(browserOperationSame(summary.summary, report.summary) && summary.gate === report.gate);
  }
  return report;
}
export function browserCheckBugKey(record, check) {
  const e = record.envelope, i = check.identity;
  return hashAcceptanceValue({ domain: 'heimdall-browser-check-bug', version: 1, projectId: e.project.id,
    contentDigest: e.candidate.contentDigest, caseKey: i.caseKey, contextKey: i.contextKey, ruleKey: i.ruleKey, oracleKey: i.oracleKey });
}
export function browserCheckRelation(before, after, beforeReport, afterReport) {
  if (!before || !after) return before ? 'unverified' : !after ? 'unverified'
    : bug(after) ? 'observed_failure' : browserCheckReliablePassed(after) ? 'observed_passed' : 'unverified';
  const a = before.identity, b = after.identity;
  if (!a || !b || ['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey'].some(k => a[k] !== b[k])
    || beforeReport.verifierFingerprint !== afterReport.verifierFingerprint) return 'incomparable';
  if (bug(after)) return bug(before) ? 'still_failed' : browserCheckReliablePassed(before) ? 'new_failure' : 'observed_failure';
  if (browserCheckReliablePassed(after)) return bug(before) ? 'verified_passed'
    : browserCheckReliablePassed(before) ? 'unchanged_passed' : 'observed_passed';
  return 'unverified';
}
