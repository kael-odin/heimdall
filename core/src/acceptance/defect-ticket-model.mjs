/** Pure manual defect-ticket state. Facts must come from the private owner-bound source reader. */
import { canonicalAcceptanceJson } from './identity.mjs';
import { browserCheckRelation, browserCheckReliablePassed } from './browser-operation-schema.mjs';
import { DEFECT_TICKET_LIMITS, defectTicketJson, defectTicketFail, defectTicketDigest,
  defectTicketRequestFingerprint, defectTicketMemberSetDigest, validateDefectTicketCreateRequest,
  validateDefectTicketCloseRequest, validateDefectTicketEvent, validateDefectTicketChain } from './defect-ticket-schema.mjs';

const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).test(value);
const iso = value => typeof value === 'string' && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const need = (condition, reason, code = 'INTEGRITY_BLOCKED', status = 503) => {
  if (!condition) defectTicketFail(reason, code, status);
};
const fields = (value, allowed) => need(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key)), 'INVALID_FACTS');
const input = raw => defectTicketJson(raw, DEFECT_TICKET_LIMITS.factsJsonBytes);
const refFields = ['operationId', 'targetReleaseId', 'acceptedAt', 'recordedAt', 'dispatchSha256', 'reportSha256', 'observationsSha256'];
const reference = operation => Object.fromEntries(refFields.map(key => [key, operation[key]]));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function compareDefectTicketOrder(a, b) {
  // Callers only pass validated source references, never HTTP values.
  return compareText(a.acceptedAt, b.acceptedAt) || compareText(a.recordedAt, b.recordedAt)
    || compareText(a.operationId, b.operationId);
}
function factsOf(raw, scope) {
  const facts = input(raw);
  fields(facts, ['projectId', 'candidateId', 'contentDigest', 'factsDigest', 'operations']);
  need(id(facts.projectId, 'ap') && id(facts.candidateId, 'bc') && hash(facts.contentDigest) && hash(facts.factsDigest), 'INVALID_FACTS');
  need(!scope || ['projectId', 'candidateId', 'contentDigest'].every(key => facts[key] === scope[key]), 'FACTS_SCOPE_MISMATCH');
  need(Array.isArray(facts.operations) && facts.operations.length <= 1024, 'SOURCE_CAPACITY');
  const operations = [], ids = new Set();
  for (const operation of facts.operations) {
    fields(operation, [...refFields, 'report', 'observation']);
    need(id(operation.operationId, 'bo') && id(operation.targetReleaseId, 'ar') && iso(operation.acceptedAt)
      && iso(operation.recordedAt) && ['dispatchSha256', 'reportSha256', 'observationsSha256'].every(key => hash(operation[key]))
      && !ids.has(operation.operationId), 'INVALID_OPERATION_FACT'); ids.add(operation.operationId);
    const observation = operation.observation, report = operation.report;
    need(observation && typeof observation === 'object' && report && typeof report === 'object'
      && observation.projectId === facts.projectId && observation.candidateId === facts.candidateId
      && observation.contentDigest === facts.contentDigest && observation.operationId === operation.operationId
      && observation.targetReleaseId === operation.targetReleaseId && observation.recordedAt === operation.recordedAt
      && observation.dispatchSha256 === operation.dispatchSha256 && observation.reportSha256 === operation.reportSha256
      && report.operationId === operation.operationId && report.targetReleaseId === operation.targetReleaseId
      && report.dispatchSha256 === operation.dispatchSha256 && report.status === 'completed' && report.mode === 'browser-fixed'
      && hash(report.verifierFingerprint) && Array.isArray(report.checks) && report.checks.length <= 240
      && Array.isArray(report.evidenceManifest) && report.evidenceManifest.length <= 1024
      && Array.isArray(observation.observations) && observation.observations.length <= 240, 'FACTS_BINDING_MISMATCH');
    need(report.checks.every(check => check && typeof check === 'object' && typeof check.id === 'string'
      && (!check.identity || typeof check.identity === 'object'))
      && report.evidenceManifest.every(entry => entry && typeof entry === 'object' && typeof entry.file === 'string'
        && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && hash(entry.sha256))
      && observation.observations.every(row => row && typeof row === 'object' && /^bug-[a-f0-9]{64}$/.test(row.bugId)
        && row.identity && typeof row.identity === 'object' && (row.checkId === null || typeof row.checkId === 'string')
        && typeof row.status === 'string' && typeof row.verdict === 'string' && typeof row.relation === 'string'), 'INVALID_FACT_ROWS');
    need(new Set(report.checks.map(check => check.id)).size === report.checks.length
      && new Set(report.checks.filter(check => check.identity).map(check => check.identity.contextKey)).size === report.checks.filter(check => check.identity).length
      && new Set(observation.observations.map(row => row.bugId)).size === observation.observations.length, 'DUPLICATE_FACT_IDENTITY');
    operations.push(operation);
  }
  operations.sort(compareDefectTicketOrder);
  return { ...facts, operations };
}
function reliableBug(check, report) {
  if (!check?.identity || check.status !== 'failed' || check.verdict !== 'bug' || check.evaluationLimited === true
    || report.environmentComparison?.comparable === false) return false;
  const actual = check.actual ?? {};
  // Failed assertions, overflow and observed console/network errors may be the detected defect itself.
  return actual.eligible !== false && actual.policyAffected !== true && !(actual.blockedRequests?.length)
    && !['baselineStability', 'targetStability'].some(key => typeof actual[key] === 'number' && actual[key] < .9995)
    && !Object.values(actual.capture ?? {}).some(value => value?.captureLimited)
    && !Object.values(actual.maskCoverage ?? {}).some(value => value?.samplingCapped || value?.maskedRatio > .8);
}
function memberOf(operation, checkId) {
  const check = operation.report.checks.find(value => value.id === checkId);
  need(reliableBug(check, operation.report), 'SOURCE_CHECK_NOT_RELIABLE_BUG', 'SOURCE_NOT_ELIGIBLE', 409);
  const matching = operation.observation.observations.filter(row => row.checkId === checkId
    && row.status === 'failed' && row.verdict === 'bug' && same(row.identity, check.identity)
    && ['observed_failure', 'still_failed', 'new_failure'].includes(row.relation));
  need(matching.length === 1, 'SOURCE_OBSERVATION_MISMATCH', 'SOURCE_NOT_ELIGIBLE', 409);
  const manifest = new Map(operation.report.evidenceManifest.map(entry => [entry.file, entry]));
  need(manifest.size === operation.report.evidenceManifest.length && check.evidence && typeof check.evidence === 'object', 'SOURCE_EVIDENCE_INVALID');
  const evidence = Object.entries(check.evidence).filter(([, file]) => file !== null).map(([role, file]) => {
    const entry = manifest.get(file); need(entry, 'SOURCE_EVIDENCE_MISSING');
    return { role, file: entry.file, bytes: entry.bytes, sha256: entry.sha256 };
  }).sort((a, b) => compareText(a.role, b.role));
  for (const role of ['baselineScreenshot', 'baselineDetails', 'baselineRepeat', 'targetScreenshot', 'targetDetails', 'targetRepeat',
    ...(check.identity.facet === 'visual' ? ['diff'] : [])]) need(evidence.some(entry => entry.role === role), 'SOURCE_EVIDENCE_MISSING');
  return { checkId, bugId: matching[0].bugId, route: check.route, identity: check.identity,
    verifierFingerprint: operation.report.verifierFingerprint, evidence };
}
function sourceMatches(create, facts) {
  const operation = facts.operations.find(value => value.operationId === create.source.operationId);
  need(operation && same(reference(operation), create.source), 'PINNED_SOURCE_CHANGED');
  const members = create.members.map(member => memberOf(operation, member.checkId)).sort((a, b) => compareText(a.checkId, b.checkId));
  need(same(members, create.members) && defectTicketMemberSetDigest(members) === create.memberSetDigest, 'PINNED_MEMBERS_CHANGED');
}
function compareMember(member, operation) {
  const base = { bugId: member.bugId, sourceCheckId: member.checkId, afterCheckId: null, relation: 'unverified', reason: 'MEMBER_NOT_REGISTERED' };
  if (operation.report.environmentComparison?.comparable === false)
    return { ...base, relation: 'incomparable', reason: 'REPORT_ENVIRONMENT_NOT_COMPARABLE' };
  const row = operation.observation.observations.find(value => value.bugId === member.bugId);
  if (!row) return base;
  if (!same(row.identity, member.identity)) return { ...base, relation: 'incomparable', reason: 'OBSERVATION_IDENTITY_CHANGED' };
  if (row.checkId === null) return { ...base, reason: 'CHECK_MISSING' };
  const check = operation.report.checks.find(value => value.id === row.checkId);
  need(check && row.status === check.status && row.verdict === check.verdict, 'OBSERVATION_CHECK_MISMATCH');
  const relation = browserCheckRelation({ id: member.checkId, identity: member.identity, status: 'failed', verdict: 'bug' },
    check, { verifierFingerprint: member.verifierFingerprint }, operation.report);
  if (relation === 'incomparable') return { ...base, afterCheckId: check.id, relation, reason: 'IDENTITY_OR_VERIFIER_CHANGED' };
  if (relation === 'verified_passed' && row.relation === 'verified_passed' && browserCheckReliablePassed(check))
    return { ...base, afterCheckId: check.id, relation, reason: 'REGISTERED_RELIABLE_PASS' };
  if (relation === 'still_failed' && reliableBug(check, operation.report)
    && ['observed_failure', 'still_failed', 'new_failure'].includes(row.relation))
    return { ...base, afterCheckId: check.id, relation, reason: 'REGISTERED_RELIABLE_FAILURE' };
  return { ...base, afterCheckId: check.id, reason: relation === 'verified_passed' ? 'REGISTRATION_NOT_VERIFIED' : 'CHECK_NOT_RELIABLE' };
}
function evaluation(create, operation) {
  if (!operation) return { verificationStatus: 'unverified', results: [],
    counts: { total: create.members.length, passed: 0, failed: 0, incomparable: 0, unverified: create.members.length } };
  const results = create.members.map(member => compareMember(member, operation));
  const counts = { total: results.length, passed: 0, failed: 0, incomparable: 0, unverified: 0 };
  for (const result of results) counts[result.relation === 'verified_passed' ? 'passed' : result.relation === 'still_failed' ? 'failed'
    : result.relation === 'incomparable' ? 'incomparable' : 'unverified']++;
  const verificationStatus = counts.incomparable ? 'incomparable' : counts.passed === counts.total ? 'verified_passed'
    : counts.passed > 0 ? 'partially_passed' : counts.failed > 0 ? 'still_failed' : 'unverified';
  return { verificationStatus, results, counts };
}
function history(records) {
  const create = records[0].event, head = records.at(-1), lastClose = records.length > 1 ? head.event : null;
  return { projectionVersion: 1, kind: 'manual-defect-ticket', scope: 'declared-members',
    ticketId: create.ticketId, projectId: create.projectId, candidateId: create.candidateId, contentDigest: create.contentDigest,
    title: create.title, severity: create.severity, description: create.description, reproduction: create.reproduction,
    source: create.source, members: create.members, memberSetDigest: create.memberSetDigest,
    revision: head.event.revision, headSha256: head.sha256,
    processingStatus: lastClose ? 'closed' : 'open', lastClose, history: records.map(record => record.event),
    verificationStatus: 'integrity_blocked', currentOperationId: null, factsDigest: null,
    counts: { total: create.members.length, passed: 0, failed: 0, incomparable: 0, unverified: create.members.length },
    results: [], reopenReasons: [], closeEligible: false, reason: 'SOURCE_UNAVAILABLE' };
}
function project(records, rawFacts) {
  const base = history(records), create = records[0].event;
  if (rawFacts === null || rawFacts === undefined) return base;
  try {
    const facts = factsOf(rawFacts, create); sourceMatches(create, facts);
    for (const record of records.slice(1)) {
      const close = record.event, after = facts.operations.find(value => value.operationId === close.after.operationId);
      need(after && same(reference(after), close.after), 'PINNED_CLOSE_SOURCE_CHANGED');
      const evaluated = evaluation(create, after);
      need(evaluated.verificationStatus === 'verified_passed' && same(close.results, evaluated.results.map(result => ({
        bugId: result.bugId, sourceCheckId: result.sourceCheckId, afterCheckId: result.afterCheckId, relation: result.relation }))), 'PINNED_CLOSE_NOT_VERIFIED');
    }
    const latest = facts.operations.at(-1), current = evaluation(create, latest), reopenReasons = [];
    if (base.lastClose) for (const operation of facts.operations) {
      if (compareDefectTicketOrder(operation, base.lastClose.after) <= 0) continue;
      const failed = evaluation(create, operation).results.filter(result => result.relation === 'still_failed');
      for (const result of failed) reopenReasons.push({ ...result, operation: reference(operation) });
    }
    const processingStatus = reopenReasons.length ? 'reopened' : base.processingStatus;
    const closeEligible = current.verificationStatus === 'verified_passed' && latest.operationId !== create.source.operationId
      && processingStatus !== 'closed';
    return { ...base, ...current, processingStatus, currentOperationId: latest?.operationId ?? null,
      factsDigest: facts.factsDigest, reopenReasons, closeEligible,
      reason: closeEligible ? 'READY_FOR_EXPLICIT_CLOSE' : processingStatus === 'closed' ? 'ALREADY_CLOSED' : 'LATEST_NOT_VERIFIED' };
  } catch (error) {
    if (error?.name !== 'DefectTicketError') throw error;
    return { ...base, reason: error.details.reason };
  }
}

/** Validates one facts batch once and lists the same eligible source members
 * used by create. Empty registrations remain available as later anchors. */
export function listDefectTicketSources(raw) {
  const value = input(raw); fields(value, ['facts']);
  const facts = factsOf(value.facts);
  return { projectId: facts.projectId, candidateId: facts.candidateId, contentDigest: facts.contentDigest,
    factsDigest: facts.factsDigest, operations: facts.operations.map(operation => ({ ...reference(operation),
      members: operation.report.checks.flatMap(check => {
        try {
          const member = memberOf(operation, check.id); defectTicketMemberSetDigest([member]);
          return [{ ...member, title: check.title ?? check.id }];
        } catch (error) {
          if (error?.code === 'SOURCE_NOT_ELIGIBLE' && error.status === 409) return [];
          throw error;
        }
      }).sort((a, b) => compareText(a.checkId, b.checkId)) })) };
}

export function createDefectTicketEvent(raw) {
  const value = input(raw); fields(value, ['projectId', 'request', 'facts', 'createdAt']);
  const request = validateDefectTicketCreateRequest(value.request), facts = factsOf(value.facts);
  need(value.projectId === facts.projectId && iso(value.createdAt), 'CREATE_SCOPE_MISMATCH', 'SOURCE_NOT_ELIGIBLE', 409);
  const operation = facts.operations.find(entry => entry.operationId === request.sourceOperationId);
  need(operation, 'SOURCE_NOT_REGISTERED', 'SOURCE_NOT_ELIGIBLE', 409);
  const members = request.memberCheckIds.map(checkId => memberOf(operation, checkId)).sort((a, b) => compareText(a.checkId, b.checkId));
  const memberSetDigest = defectTicketMemberSetDigest(members);
  return validateDefectTicketEvent({ ticketContractVersion: 1, kind: 'create', ticketId: request.ticketId, actionId: request.actionId,
    projectId: facts.projectId, candidateId: facts.candidateId, contentDigest: facts.contentDigest,
    revision: 0, previousEventSha256: null, requestFingerprint: defectTicketRequestFingerprint({ projectId: facts.projectId,
      ticketId: request.ticketId, kind: 'create', request }), createdAt: value.createdAt, actor: { kind: 'local-operator' },
    title: request.title, severity: request.severity, description: request.description, reproduction: request.reproduction,
    source: reference(operation), members, memberSetDigest });
}
export function projectDefectTicket(raw) {
  const value = input(raw); fields(value, ['records', 'facts']);
  return project(validateDefectTicketChain(value.records), value.facts);
}
export function previewDefectTicketClose(raw) {
  const value = input(raw); fields(value, ['records', 'facts', 'afterOperationId']);
  need(id(value.afterOperationId, 'bo'), 'INVALID_AFTER_ID', 'INVALID_INPUT', 400);
  const records = validateDefectTicketChain(value.records), projected = project(records, value.facts);
  let after = null;
  if (projected.verificationStatus !== 'integrity_blocked') {
    const facts = factsOf(value.facts, records[0].event);
    after = facts.operations.find(operation => operation.operationId === value.afterOperationId) ?? null;
  }
  const closeEligible = projected.closeEligible && projected.currentOperationId === value.afterOperationId;
  const snapshot = { ticketId: projected.ticketId, expectedRevision: projected.revision, expectedHeadSha256: projected.headSha256,
    memberSetDigest: projected.memberSetDigest, factsDigest: projected.factsDigest,
    afterOperationId: value.afterOperationId, after: after ? reference(after) : null, closeEligible,
    verificationStatus: projected.verificationStatus, results: projected.results,
    reason: projected.verificationStatus === 'integrity_blocked' ? projected.reason : !after ? 'AFTER_NOT_REGISTERED'
      : value.afterOperationId === records[0].event.source.operationId ? 'SOURCE_OPERATION_IS_AFTER'
        : projected.currentOperationId !== value.afterOperationId ? 'AFTER_NOT_LATEST' : projected.reason };
  return { ...snapshot, processingStatus: projected.processingStatus, counts: projected.counts,
    previewDigest: defectTicketDigest('preview', snapshot) };
}
export function closeDefectTicketEvent(raw) {
  const value = input(raw); fields(value, ['records', 'facts', 'request', 'createdAt']);
  const request = validateDefectTicketCloseRequest(value.request), records = validateDefectTicketChain(value.records);
  const create = records[0].event, head = records.at(-1);
  need(iso(value.createdAt) && value.createdAt >= head.event.createdAt, 'INVALID_CLOSE_TIME', 'INVALID_INPUT', 400);
  need(request.expectedRevision === head.event.revision && request.expectedHeadSha256 === head.sha256
    && request.memberSetDigest === create.memberSetDigest, 'TICKET_CHANGED', 'STALE_TICKET', 409);
  const preview = previewDefectTicketClose({ records, facts: value.facts, afterOperationId: request.afterOperationId });
  need(request.factsDigest === preview.factsDigest && request.previewDigest === preview.previewDigest, 'FACTS_CHANGED', 'STALE_FACTS', 409);
  need(preview.closeEligible && preview.after, preview.reason, 'SOURCE_NOT_ELIGIBLE', 409);
  return validateDefectTicketEvent({ ticketContractVersion: 1, kind: 'close', ticketId: create.ticketId, actionId: request.actionId,
    projectId: create.projectId, candidateId: create.candidateId, contentDigest: create.contentDigest,
    revision: head.event.revision + 1, previousEventSha256: head.sha256,
    requestFingerprint: defectTicketRequestFingerprint({ projectId: create.projectId, ticketId: create.ticketId, kind: 'close', request }),
    createdAt: value.createdAt, actor: { kind: 'local-operator' }, after: preview.after,
    memberSetDigest: create.memberSetDigest, factsDigest: preview.factsDigest, previewDigest: preview.previewDigest,
    results: preview.results.map(result => ({ bugId: result.bugId, sourceCheckId: result.sourceCheckId,
      afterCheckId: result.afterCheckId, relation: result.relation })), resolution: request.resolution, confirmed: request.confirmed });
}
