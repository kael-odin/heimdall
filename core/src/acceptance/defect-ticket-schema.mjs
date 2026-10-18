/** Version 1 manual defect-ticket data contracts. No Browser or persistence effects. */
import { types } from 'node:util';
import { canonicalAcceptanceJson, hashAcceptanceValue } from './identity.mjs';
import { browserOperationFileName } from './browser-operation-schema.mjs';

export const DEFECT_TICKET_LIMITS = Object.freeze({ members: 24, tickets: 256, actions: 4096,
  actionBytes: 64 * 1024, namespaceBytes: 16 * 1024 * 1024, queue: 32,
  requestBytes: 32 * 1024, denyRequestBytes: 64 * 1024, factsJsonBytes: 32 * 1024 * 1024,
  titleCharacters: 240, descriptionCharacters: 4000, reproductionCharacters: 4000,
  resolutionCharacters: 4000, evidencePerMember: 32 });
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const idPattern = prefix => new RegExp(`^${prefix}-${UUID}$`);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = value => typeof value === 'string' && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const isDefectTicketId = value => typeof value === 'string' && idPattern('dt').test(value);
export const isDefectTicketActionId = value => typeof value === 'string' && idPattern('da').test(value);

export class DefectTicketError extends Error {
  constructor(code = 'INTEGRITY_BLOCKED', status = 503, reason = 'UNAVAILABLE') {
    super(code === 'INVALID_INPUT' ? '人工缺陷单参数无效。' : code === 'SOURCE_NOT_ELIGIBLE' ? '所选验收来源不能用于此缺陷单。'
      : code === 'STALE_FACTS' || code === 'STALE_TICKET' ? '人工缺陷单或验收事实已变化，请重新预览。'
        : code === 'NOT_FOUND' ? '人工缺陷单不存在。' : '人工缺陷单原件无法安全核验；原件已保留。');
    this.name = 'DefectTicketError'; this.code = code; this.status = status; this.details = { reason };
  }
}
export const defectTicketFail = (reason, code = 'INTEGRITY_BLOCKED', status = 503) => {
  throw new DefectTicketError(code, status, reason);
};
const need = (condition, reason = 'INVALID_RECORD') => { if (!condition) defectTicketFail(reason); };

/** Copies descriptor values only. Rejects accessors, proxies, hooks, sparse arrays and cycles before encoding. */
export function defectTicketJson(input, maximum = DEFECT_TICKET_LIMITS.actionBytes) {
  need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= DEFECT_TICKET_LIMITS.factsJsonBytes, 'JSON_BUDGET');
  const active = new WeakSet(); let nodes = 0, characters = 0;
  const copy = (value, depth) => {
    need(++nodes <= 600000 && depth <= 64, 'JSON_BUDGET');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { need(Number.isFinite(value), 'INVALID_JSON'); return value; }
    if (typeof value === 'string') {
      characters += value.length; need(characters <= maximum, 'JSON_BUDGET'); return value;
    }
    need(typeof value === 'object' && !types.isProxy(value), 'INVALID_JSON');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    need(array ? prototype === Array.prototype || prototype === null : plain(value), 'INVALID_JSON');
    need(!active.has(value), 'INVALID_JSON'); active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
      need(keys.every(key => typeof key === 'string' && Object.hasOwn(descriptors[key], 'value')
        && (array && key === 'length' || descriptors[key].enumerable)), 'INVALID_JSON');
      if (array) {
        const length = descriptors.length.value;
        need(Number.isSafeInteger(length) && length >= 0 && length <= 600000 && keys.length === length + 1
          && keys.every(key => key === 'length' || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length), 'INVALID_JSON');
        return Array.from({ length }, (_, index) => copy(descriptors[index].value, depth + 1));
      }
      const result = Object.create(null);
      for (const key of keys) {
        characters += key.length; need(characters <= maximum, 'JSON_BUDGET');
        Object.defineProperty(result, key, { value: copy(descriptors[key].value, depth + 1), enumerable: true });
      }
      return result;
    } finally { active.delete(value); }
  };
  const safe = copy(input, 0), encoded = canonicalAcceptanceJson(safe);
  need(Buffer.byteLength(encoded) <= maximum, 'JSON_BUDGET');
  return JSON.parse(encoded);
}
function fields(value, allowed, required = allowed) {
  need(plain(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key)), 'INVALID_FIELDS');
}
function ident(value, prefix) { need(typeof value === 'string' && idPattern(prefix).test(value), 'INVALID_ID'); }
function text(value, maximum, empty = false) {
  need(typeof value === 'string' && value.length <= maximum && (empty || value.trim().length > 0)
    && !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'INVALID_TEXT');
}
function checkId(value) { text(value, 240); need(!/[\r\n\t]/.test(value), 'INVALID_CHECK_ID'); }
function inputBoundary(fn) {
  try { return fn(); } catch { defectTicketFail('INVALID_REQUEST', 'INVALID_INPUT', 400); }
}
export function validateDefectTicketCreateRequest(raw) { return inputBoundary(() => {
  const value = defectTicketJson(raw, DEFECT_TICKET_LIMITS.requestBytes);
  fields(value, ['ticketId', 'actionId', 'sourceOperationId', 'memberCheckIds', 'title', 'severity', 'description', 'reproduction']);
  ident(value.ticketId, 'dt'); ident(value.actionId, 'da'); ident(value.sourceOperationId, 'bo');
  need(Array.isArray(value.memberCheckIds) && value.memberCheckIds.length >= 1
    && value.memberCheckIds.length <= DEFECT_TICKET_LIMITS.members, 'MEMBER_CAPACITY');
  value.memberCheckIds.forEach(checkId);
  need(new Set(value.memberCheckIds).size === value.memberCheckIds.length, 'DUPLICATE_MEMBER');
  value.memberCheckIds.sort();
  text(value.title, DEFECT_TICKET_LIMITS.titleCharacters);
  need(['critical', 'high', 'medium', 'low'].includes(value.severity), 'INVALID_SEVERITY');
  text(value.description, DEFECT_TICKET_LIMITS.descriptionCharacters);
  text(value.reproduction, DEFECT_TICKET_LIMITS.reproductionCharacters);
  return value;
}); }
export function validateDefectTicketCloseRequest(raw) { return inputBoundary(() => {
  const value = defectTicketJson(raw, DEFECT_TICKET_LIMITS.requestBytes);
  fields(value, ['actionId', 'afterOperationId', 'expectedRevision', 'expectedHeadSha256', 'memberSetDigest',
    'factsDigest', 'previewDigest', 'resolution', 'confirmed']);
  ident(value.actionId, 'da'); ident(value.afterOperationId, 'bo');
  need(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && ['expectedHeadSha256', 'memberSetDigest', 'factsDigest', 'previewDigest'].every(key => hash(value[key]))
    && value.confirmed === true, 'INVALID_CONFIRMATION');
  text(value.resolution, DEFECT_TICKET_LIMITS.resolutionCharacters); return value;
}); }
export function defectTicketDigest(domain, value) {
  need(['members', 'preview', 'facts'].includes(domain), 'INVALID_DOMAIN');
  return hashAcceptanceValue({ domain: `heimdall-defect-ticket-${domain}`, version: 1, value: defectTicketJson(value, DEFECT_TICKET_LIMITS.factsJsonBytes) });
}
export function defectTicketRequestFingerprint(raw) {
  const value = defectTicketJson(raw, DEFECT_TICKET_LIMITS.actionBytes);
  fields(value, ['projectId', 'ticketId', 'kind', 'request']);
  const { projectId, ticketId, kind, request } = value;
  ident(projectId, 'ap'); ident(ticketId, 'dt'); need(['create', 'close'].includes(kind), 'INVALID_KIND');
  const checked = kind === 'create' ? validateDefectTicketCreateRequest(request) : validateDefectTicketCloseRequest(request);
  need(kind !== 'create' || checked.ticketId === ticketId, 'TICKET_MISMATCH');
  return hashAcceptanceValue({ domain: 'heimdall-defect-ticket-request', version: 1, projectId, ticketId, kind, request: checked });
}
/** The original browser confirmation is exact: normalization cannot change it. */
export function validateDefectTicketConfirmation(raw) { return inputBoundary(() => {
  const value = defectTicketJson(raw);
  fields(value, ['version', 'projectId', 'ticketId', 'kind', 'actionId', 'requestFingerprint', 'request']);
  need(value.version === 1 && ['create', 'close'].includes(value.kind), 'INVALID_CONFIRMATION');
  ident(value.projectId, 'ap'); ident(value.ticketId, 'dt'); ident(value.actionId, 'da');
  need(hash(value.requestFingerprint), 'INVALID_CONFIRMATION');
  const checked = value.kind === 'create' ? validateDefectTicketCreateRequest(value.request)
    : validateDefectTicketCloseRequest(value.request);
  need(canonicalAcceptanceJson(value.request) === canonicalAcceptanceJson(checked)
    && value.actionId === checked.actionId && (value.kind !== 'create' || value.ticketId === checked.ticketId), 'INVALID_CONFIRMATION');
  need(value.requestFingerprint === defectTicketRequestFingerprint({ projectId: value.projectId,
    ticketId: value.ticketId, kind: value.kind, request: checked }), 'REQUEST_FINGERPRINT_MISMATCH');
  return value;
}); }
export function validateDefectTicketDenyRequest(raw) { return inputBoundary(() => {
  const value = defectTicketJson(raw, DEFECT_TICKET_LIMITS.denyRequestBytes);
  fields(value, ['schemaVersion', 'confirmed', 'original']);
  need(value.schemaVersion === 1 && value.confirmed === true, 'INVALID_CONFIRMATION');
  value.original = validateDefectTicketConfirmation(value.original); return value;
}); }
export function validateDefectTicketRejection(raw) {
  try {
    const value = defectTicketJson(raw);
    fields(value, ['actionDecisionVersion', 'kind', 'original', 'effect', 'decidedAt', 'actor']);
    need(value.actionDecisionVersion === 1, 'UNKNOWN_ACTION_DECISION');
    need(value.kind === 'manual-defect-ticket-action-rejection'
      && value.effect === 'deny-late-manual-defect-ticket-action' && iso(value.decidedAt), 'INVALID_REJECTION');
    fields(value.actor, ['kind']); need(value.actor.kind === 'local-operator', 'INVALID_ACTOR');
    value.original = validateDefectTicketConfirmation(value.original); return value;
  } catch (cause) {
    defectTicketFail(cause instanceof DefectTicketError ? cause.details.reason : 'INVALID_REJECTION');
  }
}
export function defectTicketRejectionBytes(value) {
  const bytes = Buffer.from(canonicalAcceptanceJson(validateDefectTicketRejection(value)) + '\n');
  need(bytes.length <= DEFECT_TICKET_LIMITS.actionBytes, 'ACTION_BUDGET'); return bytes;
}
/** A physical action slot holds exactly one event or one independent rejection. */
export function validateDefectTicketDecision(raw) {
  try {
    const value = defectTicketJson(raw), event = Object.hasOwn(value, 'ticketContractVersion'),
      rejection = Object.hasOwn(value, 'actionDecisionVersion');
    need(event !== rejection, 'INVALID_DECISION');
    return event ? validateDefectTicketEvent(value) : validateDefectTicketRejection(value);
  } catch (cause) {
    defectTicketFail(cause instanceof DefectTicketError ? cause.details.reason : 'INVALID_DECISION');
  }
}
export function defectTicketDecisionBytes(raw) {
  const value = validateDefectTicketDecision(raw);
  return Object.hasOwn(value, 'ticketContractVersion') ? defectTicketEventBytes(value) : defectTicketRejectionBytes(value);
}
function identity(value) {
  fields(value, ['version', 'kind', 'facet', 'caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey', 'viewport', 'pointId'],
    ['version', 'kind', 'facet', 'caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey', 'viewport']);
  need(value.version === 1 && value.kind === 'browser' && typeof value.facet === 'string'
    && /^[a-z0-9_-]{1,80}$/i.test(value.facet)
    && ['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey'].every(key => hash(value[key])), 'INVALID_IDENTITY');
  fields(value.viewport, ['width', 'height']);
  need([value.viewport.width, value.viewport.height].every(size => Number.isSafeInteger(size) && size > 0), 'INVALID_IDENTITY');
  if (Object.hasOwn(value, 'pointId')) need(typeof value.pointId === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value.pointId), 'INVALID_IDENTITY');
  need(value.facet !== 'behavior' || Object.hasOwn(value, 'pointId'), 'INVALID_IDENTITY');
}
function sourceRef(value) {
  fields(value, ['operationId', 'targetReleaseId', 'acceptedAt', 'recordedAt', 'dispatchSha256', 'reportSha256', 'observationsSha256']);
  ident(value.operationId, 'bo'); ident(value.targetReleaseId, 'ar');
  need(iso(value.acceptedAt) && iso(value.recordedAt)
    && ['dispatchSha256', 'reportSha256', 'observationsSha256'].every(key => hash(value[key])), 'INVALID_SOURCE_REF');
}
function member(value) {
  fields(value, ['checkId', 'bugId', 'route', 'identity', 'verifierFingerprint', 'evidence']);
  checkId(value.checkId); need(typeof value.bugId === 'string' && /^bug-[a-f0-9]{64}$/.test(value.bugId), 'INVALID_BUG_ID');
  text(value.route, 2000); need(value.route.startsWith('/') && !/[\r\n\t]/.test(value.route), 'INVALID_ROUTE');
  identity(value.identity); need(hash(value.verifierFingerprint), 'INVALID_VERIFIER');
  need(Array.isArray(value.evidence) && value.evidence.length >= 1
    && value.evidence.length <= DEFECT_TICKET_LIMITS.evidencePerMember, 'INVALID_EVIDENCE');
  const roles = new Set();
  for (const evidence of value.evidence) {
    fields(evidence, ['role', 'file', 'bytes', 'sha256']);
    need(typeof evidence.role === 'string' && /^[a-z][a-zA-Z0-9]{0,63}$/.test(evidence.role)
      && !roles.has(evidence.role) && browserOperationFileName(evidence.file)
      && Number.isSafeInteger(evidence.bytes) && evidence.bytes >= 0 && evidence.bytes <= 64 * 1024 * 1024
      && hash(evidence.sha256), 'INVALID_EVIDENCE'); roles.add(evidence.role);
  }
  need(canonicalAcceptanceJson(value.evidence) === canonicalAcceptanceJson([...value.evidence].sort((a, b) => compareText(a.role, b.role))), 'UNSORTED_EVIDENCE');
}
export function defectTicketMemberSetDigest(raw) {
  const members = defectTicketJson(raw);
  need(Array.isArray(members) && members.length >= 1 && members.length <= DEFECT_TICKET_LIMITS.members, 'MEMBER_CAPACITY');
  members.forEach(member);
  need(new Set(members.map(value => value.checkId)).size === members.length
    && new Set(members.map(value => value.bugId)).size === members.length
    && new Set(members.map(value => value.identity.contextKey)).size === members.length, 'DUPLICATE_MEMBER');
  need(canonicalAcceptanceJson(members) === canonicalAcceptanceJson([...members].sort((a, b) => compareText(a.checkId, b.checkId))), 'UNSORTED_MEMBERS');
  return defectTicketDigest('members', members);
}
export function validateDefectTicketEvent(raw) {
  try {
  const value = defectTicketJson(raw), common = ['ticketContractVersion', 'kind', 'ticketId', 'actionId', 'projectId',
    'candidateId', 'contentDigest', 'revision', 'previousEventSha256', 'requestFingerprint', 'createdAt', 'actor'];
  need(value.ticketContractVersion === 1, 'UNKNOWN_TICKET_CONTRACT');
  need(['create', 'close'].includes(value.kind), 'INVALID_KIND');
  fields(value, [...common, ...(value.kind === 'create' ? ['title', 'severity', 'description', 'reproduction', 'source', 'members', 'memberSetDigest']
    : ['after', 'memberSetDigest', 'factsDigest', 'previewDigest', 'results', 'resolution', 'confirmed'])]);
  ident(value.ticketId, 'dt'); ident(value.actionId, 'da'); ident(value.projectId, 'ap'); ident(value.candidateId, 'bc');
  need(hash(value.contentDigest) && hash(value.requestFingerprint) && iso(value.createdAt), 'INVALID_RECORD');
  fields(value.actor, ['kind']); need(value.actor.kind === 'local-operator', 'INVALID_ACTOR');
  need(Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision < DEFECT_TICKET_LIMITS.actions, 'INVALID_REVISION');
  if (value.kind === 'create') {
    need(value.revision === 0 && value.previousEventSha256 === null, 'INVALID_CREATE'); sourceRef(value.source);
    need(Array.isArray(value.members), 'INVALID_MEMBERS');
    const request = validateDefectTicketCreateRequest({ ticketId: value.ticketId, actionId: value.actionId,
      sourceOperationId: value.source.operationId, memberCheckIds: value.members?.map(entry => entry.checkId),
      title: value.title, severity: value.severity, description: value.description, reproduction: value.reproduction });
    need(value.memberSetDigest === defectTicketMemberSetDigest(value.members), 'MEMBER_DIGEST_MISMATCH');
    need(value.requestFingerprint === defectTicketRequestFingerprint({ projectId: value.projectId, ticketId: value.ticketId,
      kind: 'create', request }), 'REQUEST_FINGERPRINT_MISMATCH');
  } else {
    need(value.revision > 0 && hash(value.previousEventSha256) && hash(value.memberSetDigest)
      && hash(value.factsDigest) && hash(value.previewDigest), 'INVALID_CLOSE'); sourceRef(value.after);
    need(Array.isArray(value.results) && value.results.length >= 1 && value.results.length <= DEFECT_TICKET_LIMITS.members, 'INVALID_RESULTS');
    const bugs = new Set();
    for (const result of value.results) {
      fields(result, ['bugId', 'sourceCheckId', 'afterCheckId', 'relation']);
      need(typeof result.bugId === 'string' && /^bug-[a-f0-9]{64}$/.test(result.bugId)
        && !bugs.has(result.bugId) && result.relation === 'verified_passed', 'INVALID_RESULTS');
      checkId(result.sourceCheckId); checkId(result.afterCheckId); bugs.add(result.bugId);
    }
    const request = validateDefectTicketCloseRequest({ actionId: value.actionId, afterOperationId: value.after.operationId,
      expectedRevision: value.revision - 1, expectedHeadSha256: value.previousEventSha256,
      memberSetDigest: value.memberSetDigest, factsDigest: value.factsDigest, previewDigest: value.previewDigest,
      resolution: value.resolution, confirmed: value.confirmed });
    need(value.requestFingerprint === defectTicketRequestFingerprint({ projectId: value.projectId, ticketId: value.ticketId,
      kind: 'close', request }), 'REQUEST_FINGERPRINT_MISMATCH');
  }
    return value;
  } catch (cause) {
    defectTicketFail(cause instanceof DefectTicketError ? cause.details.reason : 'INVALID_EVENT');
  }
}
export function defectTicketEventBytes(value) {
  const bytes = Buffer.from(canonicalAcceptanceJson(validateDefectTicketEvent(value)) + '\n');
  need(bytes.length <= DEFECT_TICKET_LIMITS.actionBytes, 'ACTION_BUDGET'); return bytes;
}
/** Record SHA is supplied by the owner-bound store from the original serialized bytes. */
export function validateDefectTicketChain(raw) {
  // namespaceBytes counts original event files. A canonical record also adds
  // its raw SHA and object/array punctuation (less than 128 bytes per action).
  // Keep that bounded transport overhead separate from the persisted-byte cap.
  const records = defectTicketJson(raw, DEFECT_TICKET_LIMITS.namespaceBytes + DEFECT_TICKET_LIMITS.actions * 128 + 2);
  need(Array.isArray(records) && records.length >= 1 && records.length <= DEFECT_TICKET_LIMITS.actions, 'ACTION_CAPACITY');
  const actions = new Set(), revisions = new Set();
  for (const record of records) {
    fields(record, ['event', 'sha256']); need(hash(record.sha256), 'INVALID_EVENT_SHA');
    record.event = validateDefectTicketEvent(record.event);
    need(!actions.has(record.event.actionId) && !revisions.has(record.event.revision), 'CHAIN_FORK');
    actions.add(record.event.actionId); revisions.add(record.event.revision);
  }
  records.sort((a, b) => a.event.revision - b.event.revision);
  const first = records[0].event;
  need(first.kind === 'create', 'MISSING_CREATE');
  for (const [index, record] of records.entries()) {
    const event = record.event;
    need(event.revision === index && (index === 0 || event.kind === 'close'
      && event.previousEventSha256 === records[index - 1].sha256), 'CHAIN_GAP');
    need(['ticketId', 'projectId', 'candidateId', 'contentDigest', 'memberSetDigest'].every(key => event[key] === first[key]), 'CHAIN_SCOPE_MISMATCH');
    if (index > 0) {
      need(event.createdAt >= records[index - 1].event.createdAt && event.after.operationId !== first.source.operationId, 'INVALID_CLOSE');
      const previousAnchor = index === 1 ? first.source : records[index - 1].event.after;
      need((compareText(event.after.acceptedAt, previousAnchor.acceptedAt)
        || compareText(event.after.recordedAt, previousAnchor.recordedAt)
        || compareText(event.after.operationId, previousAnchor.operationId)) > 0, 'CLOSE_ANCHOR_NOT_NEWER');
      need(event.results.length === first.members.length && first.members.every(entry => event.results.some(result =>
        result.bugId === entry.bugId && result.sourceCheckId === entry.checkId)), 'RESULT_MEMBER_MISMATCH');
    }
  }
  return records;
}
