/** Manual ticket DTOs and exact browser confirmations. No execution endpoints. */
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-${UUID}$`).test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const number = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 4000, empty = true) => typeof value === 'string' && value.length <= max
  && (empty || value.trim().length > 0) && !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const iso = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const fail = (message = '人工缺陷单响应无法核对，请保留原确认并只读查询。') => {
  throw Object.assign(new Error(message), { code: 'INVALID_RESPONSE' });
};
const need = condition => { if (!condition) fail(); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const equal = (a, b) => canonical(a) === canonical(b);
const MAX_JSON = 32 * 1024 * 1024, MAX_CONFIRMATIONS = 2 * 1024 * 1024;
const proofBindings = new WeakMap(), rejectionBindings = new WeakMap(), transportErrors = new WeakSet();
export const DEFECT_HANDLING_LABELS = Object.freeze({ open: '待处理', closed: '已明确关闭', reopened: '再次发现' });
export const DEFECT_VERIFICATION_LABELS = Object.freeze({ verified_passed: '关联检查已复验通过', still_failed: '仍有可靠失败',
  partially_passed: '部分检查通过', unverified: '尚未核验', incomparable: '条件不同，无法比较', integrity_blocked: '原件核验受阻' });
const relationLabels = ['verified_passed', 'still_failed', 'unverified', 'incomparable'];

function canonical(input, maximum = MAX_JSON) {
  const active = new WeakSet(); let nodes = 0, characters = 0;
  const encode = (value, depth = 0) => {
    need(++nodes <= 600000 && depth <= 64);
    if (value === null || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') { need(Number.isFinite(value)); return JSON.stringify(value); }
    if (typeof value === 'string') { characters += value.length; need(characters <= maximum); return JSON.stringify(value); }
    need(value && typeof value === 'object' && !active.has(value));
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    need(array ? prototype === Array.prototype || prototype === null : prototype === Object.prototype || prototype === null);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    need(keys.every(key => typeof key === 'string' && Object.hasOwn(descriptors[key], 'value')
      && (array && key === 'length' || descriptors[key].enumerable)));
    active.add(value);
    try {
      if (array) {
        const length = descriptors.length.value;
        need(number(length) && length <= 600000 && keys.length === length + 1
          && keys.every(key => key === 'length' || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length));
        return '[' + Array.from({ length }, (_, index) => encode(descriptors[index].value, depth + 1)).join(',') + ']';
      }
      return '{' + keys.sort().map(key => { characters += key.length; need(characters <= maximum);
        return JSON.stringify(key) + ':' + encode(descriptors[key].value, depth + 1); }).join(',') + '}';
    } finally { active.delete(value); }
  };
  const encoded = encode(input); need(new TextEncoder().encode(encoded).length <= maximum); return encoded;
}
const json = (value, maximum) => JSON.parse(canonical(value, maximum));
const fields = (value, allowed, required = allowed) => need(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const checkId = value => text(value, 240, false) && !/[\r\n\t]/.test(value);
function identity(value) {
  fields(value, ['version', 'kind', 'facet', 'caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey', 'viewport', 'pointId'],
    ['version', 'kind', 'facet', 'caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey', 'viewport']);
  need(value.version === 1 && value.kind === 'browser' && typeof value.facet === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value.facet)
    && ['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey'].every(key => hash(value[key])));
  fields(value.viewport, ['width', 'height']); need([value.viewport.width, value.viewport.height].every(size => number(size) && size > 0));
  if (Object.hasOwn(value, 'pointId')) need(typeof value.pointId === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value.pointId));
  need(value.facet !== 'behavior' || Object.hasOwn(value, 'pointId'));
}
const REF = ['operationId', 'targetReleaseId', 'acceptedAt', 'recordedAt', 'dispatchSha256', 'reportSha256', 'observationsSha256'];
function reference(value, extended = []) {
  fields(value, [...REF, ...extended]); need(id(value.operationId, 'bo') && id(value.targetReleaseId, 'ar')
    && iso(value.acceptedAt) && iso(value.recordedAt) && REF.slice(4).every(key => hash(value[key])));
}
function member(value, titled = false) {
  fields(value, ['checkId', 'bugId', 'route', 'identity', 'verifierFingerprint', 'evidence', ...(titled ? ['title'] : [])]);
  need(checkId(value.checkId) && typeof value.bugId === 'string' && /^bug-[a-f0-9]{64}$/.test(value.bugId) && text(value.route, 2000, false)
    && value.route.startsWith('/') && hash(value.verifierFingerprint) && Array.isArray(value.evidence)
    && value.evidence.length >= 1 && value.evidence.length <= 32 && (!titled || text(value.title, 240)));
  identity(value.identity); const roles = new Set();
  for (const evidence of value.evidence) {
    fields(evidence, ['role', 'file', 'bytes', 'sha256']);
    need(typeof evidence.role === 'string' && /^[a-z][a-zA-Z0-9]{0,63}$/.test(evidence.role) && !roles.has(evidence.role)
      && typeof evidence.file === 'string' && evidence.file.length <= 240 && /^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(evidence.file)
      && !['dispatch.json', 'head.json', 'report.json', 'observations.json', 'rejection.json'].includes(evidence.file.toLowerCase())
      && !evidence.file.includes('.tmp.') && number(evidence.bytes) && evidence.bytes <= 64 * 1024 * 1024 && hash(evidence.sha256)); roles.add(evidence.role);
  }
}
function counts(value) {
  fields(value, ['total', 'passed', 'failed', 'incomparable', 'unverified']);
  need(Object.values(value).every(number) && value.total >= 1 && value.total <= 24
    && value.passed + value.failed + value.incomparable + value.unverified === value.total);
}
function states(value) {
  need(Object.hasOwn(DEFECT_HANDLING_LABELS, value.processingStatus) && Object.hasOwn(DEFECT_VERIFICATION_LABELS, value.verificationStatus)
    && typeof value.closeEligible === 'boolean' && text(value.reason, 100, false)); counts(value.counts);
  need(!value.closeEligible || value.processingStatus !== 'closed' && value.verificationStatus === 'verified_passed');
}
function result(value, reason = true) {
  fields(value, ['bugId', 'sourceCheckId', 'afterCheckId', 'relation', ...(reason ? ['reason'] : [])]);
  need(typeof value.bugId === 'string' && /^bug-[a-f0-9]{64}$/.test(value.bugId) && checkId(value.sourceCheckId)
    && (value.afterCheckId === null || checkId(value.afterCheckId)) && relationLabels.includes(value.relation)
    && (!reason || text(value.reason, 100, false)));
}
function event(value) {
  need(value && typeof value === 'object' && !Array.isArray(value));
  need(new TextEncoder().encode(canonical(value) + '\n').length <= 64 * 1024);
  const common = ['ticketContractVersion', 'kind', 'ticketId', 'actionId', 'projectId', 'candidateId', 'contentDigest', 'revision',
    'previousEventSha256', 'requestFingerprint', 'createdAt', 'actor'];
  need(['create', 'close'].includes(value.kind));
  fields(value, [...common, ...(value.kind === 'create' ? ['title', 'severity', 'description', 'reproduction', 'source', 'members', 'memberSetDigest']
    : ['after', 'memberSetDigest', 'factsDigest', 'previewDigest', 'results', 'resolution', 'confirmed'])]);
  need(value.ticketContractVersion === 1 && id(value.ticketId, 'dt') && id(value.actionId, 'da') && id(value.projectId, 'ap')
    && id(value.candidateId, 'bc') && hash(value.contentDigest) && number(value.revision) && hash(value.requestFingerprint)
    && hash(value.memberSetDigest) && iso(value.createdAt)); fields(value.actor, ['kind']); need(value.actor.kind === 'local-operator');
  if (value.kind === 'create') {
    need(value.revision === 0 && value.previousEventSha256 === null && text(value.title, 240, false)
      && ['critical', 'high', 'medium', 'low'].includes(value.severity) && text(value.description, 4000, false)
      && text(value.reproduction, 4000, false) && Array.isArray(value.members) && value.members.length >= 1 && value.members.length <= 24);
    reference(value.source); value.members.forEach(entry => member(entry));
    need(new Set(value.members.map(entry => entry.checkId)).size === value.members.length
      && new Set(value.members.map(entry => entry.bugId)).size === value.members.length);
  } else {
    need(value.revision > 0 && hash(value.previousEventSha256) && hash(value.factsDigest) && hash(value.previewDigest)
      && value.confirmed === true && text(value.resolution, 4000, false) && Array.isArray(value.results)
      && value.results.length >= 1 && value.results.length <= 24); reference(value.after);
    value.results.forEach(entry => { result(entry, false); need(entry.relation === 'verified_passed' && entry.afterCheckId !== null); });
  }
  return value;
}
export function defectTicketCreateInput(raw) {
  const value = json(raw, 32768); fields(value, ['ticketId', 'actionId', 'sourceOperationId', 'memberCheckIds', 'title', 'severity', 'description', 'reproduction']);
  need(id(value.ticketId, 'dt') && id(value.actionId, 'da') && id(value.sourceOperationId, 'bo')
    && Array.isArray(value.memberCheckIds) && value.memberCheckIds.length >= 1 && value.memberCheckIds.length <= 24
    && value.memberCheckIds.every(checkId) && new Set(value.memberCheckIds).size === value.memberCheckIds.length
    && text(value.title, 240, false) && ['critical', 'high', 'medium', 'low'].includes(value.severity)
    && text(value.description, 4000, false) && text(value.reproduction, 4000, false));
  value.memberCheckIds.sort(compare); return value;
}
export function defectTicketCloseInput(raw) {
  const value = json(raw, 32768); fields(value, ['actionId', 'afterOperationId', 'expectedRevision', 'expectedHeadSha256',
    'memberSetDigest', 'factsDigest', 'previewDigest', 'resolution', 'confirmed']);
  need(id(value.actionId, 'da') && id(value.afterOperationId, 'bo') && number(value.expectedRevision)
    && ['expectedHeadSha256', 'memberSetDigest', 'factsDigest', 'previewDigest'].every(key => hash(value[key]))
    && text(value.resolution, 4000, false) && value.confirmed === true); return value;
}
export function defectTicketSources(raw, projectId, candidateId, contentDigest) {
  const value = json(raw); fields(value, ['schemaVersion', 'kind', 'scope', 'projectId', 'candidateId', 'contentDigest', 'factsDigest', 'operations']);
  need(value.schemaVersion === 1 && value.kind === 'manual-defect-ticket-sources' && value.scope === 'registered-completed-browser-operations'
    && value.projectId === projectId && id(projectId, 'ap') && value.candidateId === candidateId && id(candidateId, 'bc')
    && hash(value.contentDigest) && (!contentDigest || value.contentDigest === contentDigest) && hash(value.factsDigest)
    && Array.isArray(value.operations) && value.operations.length <= 1024);
  const ids = new Set(); let previous;
  for (const operation of value.operations) {
    reference(operation, ['members']); need(!ids.has(operation.operationId) && Array.isArray(operation.members) && operation.members.length <= 240);
    operation.members.forEach(entry => member(entry, true));
    need(new Set(operation.members.map(entry => entry.checkId)).size === operation.members.length);
    if (previous) need((compare(previous.acceptedAt, operation.acceptedAt) || compare(previous.recordedAt, operation.recordedAt)
      || compare(previous.operationId, operation.operationId)) < 0);
    previous = operation; ids.add(operation.operationId);
  }
  return freeze(value);
}
export function defectTicketList(raw, projectId) {
  const value = json(raw); fields(value, ['schemaVersion', 'kind', 'scope', 'projectId', 'ticketCount', 'associatedCheckCount', 'tickets']);
  need(value.schemaVersion === 1 && value.kind === 'manual-defect-ticket-list' && value.scope === 'declared-members'
    && value.projectId === projectId && id(projectId, 'ap') && Array.isArray(value.tickets) && value.tickets.length <= 256
    && value.ticketCount === value.tickets.length && number(value.associatedCheckCount)); const ids = new Set();
  for (const ticket of value.tickets) {
    fields(ticket, ['ticketId', 'projectId', 'candidateId', 'contentDigest', 'title', 'severity', 'revision', 'headSha256', 'memberSetDigest',
      'processingStatus', 'verificationStatus', 'currentOperationId', 'counts', 'closeEligible', 'reason']);
    need(id(ticket.ticketId, 'dt') && !ids.has(ticket.ticketId) && ticket.projectId === projectId && id(ticket.candidateId, 'bc')
      && hash(ticket.contentDigest) && text(ticket.title, 240, false) && ['critical', 'high', 'medium', 'low'].includes(ticket.severity)
      && number(ticket.revision) && hash(ticket.headSha256) && hash(ticket.memberSetDigest)
      && (ticket.currentOperationId === null || id(ticket.currentOperationId, 'bo'))); states(ticket); ids.add(ticket.ticketId);
  }
  need(value.associatedCheckCount === value.tickets.reduce((sum, ticket) => sum + ticket.counts.total, 0)); return freeze(value);
}
export function defectTicketDetail(raw, projectId, ticketId) {
  const value = json(raw); fields(value, ['schemaVersion', 'projectId', 'ticket']);
  need(value.schemaVersion === 1 && value.projectId === projectId && id(projectId, 'ap') && id(ticketId, 'dt'));
  const ticket = value.ticket;
  fields(ticket, ['projectionVersion', 'kind', 'scope', 'ticketId', 'projectId', 'candidateId', 'contentDigest', 'title', 'severity', 'description',
    'reproduction', 'source', 'members', 'memberSetDigest', 'revision', 'headSha256', 'history', 'lastClose', 'processingStatus',
    'verificationStatus', 'currentOperationId', 'factsDigest', 'counts', 'results', 'reopenReasons', 'closeEligible', 'reason']);
  need(ticket.projectionVersion === 1 && ticket.kind === 'manual-defect-ticket' && ticket.scope === 'declared-members'
    && ticket.ticketId === ticketId && ticket.projectId === projectId && Array.isArray(ticket.history) && ticket.history.length >= 1
    && ticket.history.length <= 4096 && ticket.history.length === ticket.revision + 1 && hash(ticket.headSha256)
    && (ticket.factsDigest === null || hash(ticket.factsDigest)) && (ticket.currentOperationId === null || id(ticket.currentOperationId, 'bo')));
  ticket.history.forEach((entry, index) => { event(entry); need(entry.ticketId === ticketId && entry.projectId === projectId && entry.revision === index
    && entry.candidateId === ticket.candidateId && entry.contentDigest === ticket.contentDigest && entry.memberSetDigest === ticket.memberSetDigest); });
  const first = ticket.history[0], last = ticket.history.at(-1);
  need(['candidateId', 'contentDigest', 'title', 'severity', 'description', 'reproduction', 'source', 'members', 'memberSetDigest']
    .every(key => equal(ticket[key], first[key])) && equal(ticket.lastClose, last.kind === 'close' ? last : null)); states(ticket);
  need(last.kind === 'create' ? ticket.processingStatus === 'open' : ['closed', 'reopened'].includes(ticket.processingStatus));
  need(ticket.counts.total === ticket.members.length && Array.isArray(ticket.results) && Array.isArray(ticket.reopenReasons));
  ticket.results.forEach(entry => result(entry));
  for (const entry of ticket.reopenReasons) { const { operation, ...rest } = entry; reference(operation); result(rest); need(rest.relation === 'still_failed'); }
  return freeze(value);
}
export function defectTicketPreview(raw, projectId, ticketId, afterOperationId) {
  const value = json(raw); fields(value, ['schemaVersion', 'projectId', 'ticketId', 'preview']);
  need(value.schemaVersion === 1 && value.projectId === projectId && id(projectId, 'ap') && value.ticketId === ticketId && id(ticketId, 'dt'));
  const preview = value.preview;
  fields(preview, ['ticketId', 'expectedRevision', 'expectedHeadSha256', 'memberSetDigest', 'factsDigest', 'afterOperationId', 'after',
    'closeEligible', 'verificationStatus', 'results', 'reason', 'processingStatus', 'counts', 'previewDigest']);
  need(preview.ticketId === ticketId && preview.afterOperationId === afterOperationId && id(afterOperationId, 'bo')
    && number(preview.expectedRevision) && hash(preview.expectedHeadSha256) && hash(preview.memberSetDigest)
    && (preview.factsDigest === null || hash(preview.factsDigest)) && hash(preview.previewDigest) && Array.isArray(preview.results)); states(preview);
  if (preview.after !== null) { reference(preview.after); need(preview.after.operationId === afterOperationId); }
  preview.results.forEach(entry => result(entry));
  need(!preview.closeEligible || preview.after !== null && hash(preview.factsDigest)
    && preview.results.length === preview.counts.total && preview.results.every(entry => entry.relation === 'verified_passed'));
  return freeze(value);
}
async function digest(text, crypto = globalThis.crypto) {
  if (typeof crypto?.subtle?.digest !== 'function') fail('当前浏览器无法核验动作摘要，已阻止提交。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function confirmation(raw) {
  const value = json(raw, 65536); fields(value, ['version', 'projectId', 'ticketId', 'kind', 'actionId', 'requestFingerprint', 'request']);
  need(value.version === 1 && id(value.projectId, 'ap') && id(value.ticketId, 'dt') && ['create', 'close'].includes(value.kind) && hash(value.requestFingerprint));
  const request = value.kind === 'create' ? defectTicketCreateInput(value.request) : defectTicketCloseInput(value.request);
  need(request.actionId === value.actionId && (value.kind !== 'create' || request.ticketId === value.ticketId) && equal(request, value.request)); return value;
}
export async function defectTicketConfirmation(raw, { crypto = globalThis.crypto } = {}) {
  const value = json(raw, 65536); fields(value, ['projectId', 'ticketId', 'kind', 'request']);
  need(id(value.projectId, 'ap') && id(value.ticketId, 'dt') && ['create', 'close'].includes(value.kind));
  const request = value.kind === 'create' ? defectTicketCreateInput(value.request) : defectTicketCloseInput(value.request);
  need(value.kind !== 'create' || request.ticketId === value.ticketId);
  const requestFingerprint = await digest(canonical({ domain: 'heimdall-defect-ticket-request', version: 1,
    projectId: value.projectId, ticketId: value.ticketId, kind: value.kind, request }), crypto);
  return freeze({ version: 1, projectId: value.projectId, ticketId: value.ticketId, kind: value.kind, actionId: request.actionId, requestFingerprint, request });
}
export async function defectTicketAction(raw, expected, { crypto = globalThis.crypto } = {}) {
  const original = confirmation(expected), recreated = await defectTicketConfirmation({ projectId: original.projectId,
    ticketId: original.ticketId, kind: original.kind, request: original.request }, { crypto }); need(equal(original, recreated));
  const value = json(raw, 128 * 1024);
  if (value.outcome === 'unresolved') {
    fields(value, ['schemaVersion', 'kind', 'projectId', 'actionId', 'outcome', 'reason']);
    need(value.schemaVersion === 1 && value.kind === 'manual-defect-ticket-action' && value.projectId === original.projectId
      && value.actionId === original.actionId && value.reason === 'ABSENCE_IS_NOT_A_COMMIT_DECISION'); return freeze(value);
  }
  fields(value, ['schemaVersion', 'kind', 'outcome', 'projectId', 'ticketId', 'actionId', 'requestFingerprint', 'eventSha256', 'event', 'replayed'],
    ['schemaVersion', 'kind', 'outcome', 'projectId', 'ticketId', 'actionId', 'requestFingerprint', 'eventSha256', 'event']);
  need(value.schemaVersion === 1 && value.kind === 'manual-defect-ticket-action' && value.outcome === 'recorded'
    && value.projectId === original.projectId && value.ticketId === original.ticketId && value.actionId === original.actionId
    && value.requestFingerprint === original.requestFingerprint && hash(value.eventSha256)
    && (!Object.hasOwn(value, 'replayed') || typeof value.replayed === 'boolean'));
  const saved = event(value.event), request = original.request;
  need(saved.projectId === original.projectId && saved.ticketId === original.ticketId && saved.actionId === original.actionId
    && saved.kind === original.kind && saved.requestFingerprint === original.requestFingerprint
    && await digest(canonical(saved) + '\n', crypto) === value.eventSha256);
  if (saved.kind === 'create') {
    need(saved.source.operationId === request.sourceOperationId && ['title', 'severity', 'description', 'reproduction'].every(key => saved[key] === request[key])
      && equal(saved.members.map(member => member.checkId), request.memberCheckIds)
      && await digest(canonical({ domain: 'heimdall-defect-ticket-members', version: 1, value: saved.members }), crypto) === saved.memberSetDigest);
  } else need(saved.after.operationId === request.afterOperationId && saved.revision === request.expectedRevision + 1
    && saved.previousEventSha256 === request.expectedHeadSha256 && saved.resolution === request.resolution
    && ['memberSetDigest', 'factsDigest', 'previewDigest'].every(key => saved[key] === request[key]));
  freeze(value); proofBindings.set(value, canonical(original)); return value;
}
export function createDefectTicketReadGuard() {
  let epoch = 0, stopped = false; const channels = new Map();
  const reset = () => { epoch++; for (const value of channels.values()) value.controller.abort(); channels.clear(); };
  return Object.freeze({ begin(channel) {
    channels.get(channel)?.controller.abort(); const controller = new AbortController(), ticket = { epoch, channel, controller, signal: controller.signal };
    if (stopped) controller.abort(); channels.set(channel, ticket); return ticket;
  }, current(ticket) { return !stopped && ticket.epoch === epoch && channels.get(ticket.channel) === ticket && !ticket.signal.aborted; },
  reset, stop() { stopped = true; reset(); } });
}
export function createDefectTicketReceipts({ projectId, origin, storage, locks = globalThis.navigator?.locks } = {}) {
  let normalized; try { normalized = new URL(origin); } catch { fail(); }
  need(id(projectId, 'ap') && normalized.origin === origin && ['http:', 'https:'].includes(normalized.protocol)
    && typeof storage?.getItem === 'function' && typeof storage?.setItem === 'function');
  const key = `heimdall:defect-tickets:v1:${origin}:${projectId}`, claims = new Map(); let faulted = false;
  function read() {
    try {
      if (faulted) fail(); const raw = storage.getItem(key); if (raw === null) return [];
      need(typeof raw === 'string' && raw.length <= MAX_CONFIRMATIONS && new TextEncoder().encode(raw).length <= MAX_CONFIRMATIONS);
      const values = json(JSON.parse(raw), MAX_CONFIRMATIONS); need(Array.isArray(values) && values.length <= 32); const ids = new Set();
      for (const value of values) { confirmation(value); need(value.projectId === projectId && !ids.has(value.actionId)); ids.add(value.actionId); }
      return values;
    } catch { faulted = true; fail('本机原确认无法完整读取；请保留现场，当前项目已阻止提交。'); }
  }
  function write(expected) {
    try { const bytes = canonical(expected, MAX_CONFIRMATIONS); storage.setItem(key, bytes);
      need(equal(read(), expected));
    } catch { faulted = true; fail('本机原确认写入或完整回读失败；已阻止继续提交。'); }
  }
  function lock(action) {
    if (faulted || typeof locks?.request !== 'function') return Promise.reject(Object.assign(new Error('无法独占保存本机确认，当前仅可只读核对。'), { code: 'INVALID_RESPONSE' }));
    return locks.request(key, { mode: 'exclusive' }, action);
  }
  function remove(original) {
    const values = read(), found = values.find(value => value.actionId === original.actionId);
    if (!found) return false; need(equal(found, original)); write(values.filter(value => value.actionId !== original.actionId)); claims.delete(canonical(original)); return true;
  }
  return Object.freeze({ key, get canWrite() { return !faulted && typeof locks?.request === 'function'; }, read,
    async claimForSubmit(input) {
      const original = confirmation(input), verified = await defectTicketConfirmation({ projectId: original.projectId,
        ticketId: original.ticketId, kind: original.kind, request: original.request }); need(equal(original, verified) && original.projectId === projectId);
      return lock(() => { const values = read(); if (values.length) return false; write([original]); claims.set(canonical(original), false); return true; });
    },
    markDispatched(input) { const original = confirmation(input), token = canonical(original); need(claims.has(token) && claims.get(token) === false); claims.set(token, true); },
    cancelUnsent(input) { const original = confirmation(input), token = canonical(original);
      return lock(() => { need(claims.has(token) && claims.get(token) === false); return remove(original); }); },
    resolveExact(input, proof) { const original = confirmation(input); need(original.projectId === projectId && proofBindings.get(proof) === canonical(original));
      return lock(() => remove(original)); },
    releaseRejected(input, proof) {
      const original = confirmation(input), binding = rejectionBindings.get(proof);
      need(original.projectId === projectId && binding?.projectId === projectId && binding.suffix === (original.kind === 'create' ? '' : `/${original.ticketId}/close`)
        && binding.body === canonical(original.request)); return lock(() => remove(original));
    },
  });
}
const failures = Object.freeze({ INVALID_INPUT: [400, '人工缺陷单参数无效，请核对输入。'], NOT_FOUND: [404, '所选人工缺陷单、来源或动作不存在。'],
  STALE_TICKET: [409, '缺陷单已变化，请重新读取并预览。'], STALE_FACTS: [409, '验收事实已变化，请重新预览。'],
  ACTION_CONFLICT: [409, '原动作编号已有不同确认，请核对原动作。'], SOURCE_NOT_ELIGIBLE: [409, '所选来源不符合本次人工操作要求。'],
  CAPACITY: [503, '人工缺陷单或取证预算已达到上限，请保留原件并检查。'],
  INTEGRITY_BLOCKED: [503, '人工缺陷单或验收原件无法安全核验；原件已保留。'],
  ACCEPTANCE_OWNER_UNAVAILABLE: [503, '无法安全确认验收目录所有权，请稍后重试。'],
  ACCEPTANCE_OWNER_LOST: [503, '验收目录所有权已失效，请停止当前引擎后重试。'] });
const throwIfAborted = signal => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
async function abortable(promise, signal) {
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(new DOMException('Aborted', 'AbortError')); });
  signal?.addEventListener('abort', rejectAbort, { once: true }); if (signal?.aborted) rejectAbort();
  try { return await Promise.race([promise, aborted]); }
  finally { signal?.removeEventListener('abort', rejectAbort); }
}
async function boundedResponse(response, maximum, signal) {
  const length = response.headers.get('content-length');
  if (length !== null) need(/^(?:0|[1-9][0-9]*)$/.test(length) && Number(length) <= maximum);
  need(response.body && typeof response.body.getReader === 'function'); const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) { throwIfAborted(signal); const value = await abortable(reader.read(), signal); if (value.done) break;
      bytes += value.value.byteLength; need(bytes <= maximum); chunks.push(value.value); }
  } catch (cause) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Keep primary failure. */ } throw cause; }
  finally { try { reader.releaseLock(); } catch { /* A non-cooperating stream cannot delay the deadline. */ } }
  if (length !== null) need(Number(length) === bytes);
  const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; } return joined;
}
export async function requestDefectTickets(projectId, suffix = '', { baseUrl = '', headers = {}, method = 'GET', body, signal,
  fetcher = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const ticket = `dt-${UUID}`, operation = `bo-${UUID}`, action = `da-${UUID}`, candidate = `bc-${UUID}`;
  const readable = suffix === '' || new RegExp(`^/(?:sources\\?candidateId=${candidate}|actions/${action}|${ticket}(?:/close-preview\\?afterOperationId=${operation})?)$`).test(suffix);
  const writable = suffix === '' || new RegExp(`^/${ticket}/close$`).test(suffix);
  need(id(projectId, 'ap') && typeof suffix === 'string' && (method === 'GET' ? readable && body === undefined : method === 'POST' && writable && body !== undefined)
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const encoded = body === undefined ? undefined : canonical(suffix === '' ? defectTicketCreateInput(body) : defectTicketCloseInput(body), 32768);
  const requestHeaders = new Headers(headers); requestHeaders.set('accept', 'application/json');
  if (method === 'POST') requestHeaders.set('content-type', 'application/json');
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    throwIfAborted(controller.signal);
    const response = await abortable(fetcher(`${baseUrl}/api/acceptance/projects/${projectId}/defect-tickets${suffix}`, {
      method, headers: requestHeaders, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      ...(encoded === undefined ? {} : { body: encoded }) }), controller.signal);
    need(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json');
    const bytes = await boundedResponse(response, MAX_JSON, controller.signal);
    const value = json(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
    if (!response.ok) {
      const known = failures[value.code], definite = method === 'POST' && response.status >= 400 && response.status < 500 && known && (response.status === known[0]
        || value.code === 'INVALID_INPUT' && response.status === 413) && value.outcomeUnknown === false
        && text(value.error, 1000, false) && Object.keys(value).every(key => ['code', 'error', 'outcomeUnknown'].includes(key));
      const problem = Object.assign(new Error(known?.[1] || '人工缺陷单请求失败，请保留原确认并只读核对。'), {
        code: typeof value.code === 'string' ? value.code : 'INVALID_RESPONSE', status: response.status, outcomeUnknown: method === 'POST' && !definite });
      transportErrors.add(problem); if (definite) rejectionBindings.set(problem, { projectId, suffix, body: encoded }); throw problem;
    }
    need((method === 'POST' ? [200, 201] : [200]).includes(response.status)); return value;
  } catch (cause) {
    if (transportErrors.has(cause)) throw cause;
    if (method === 'GET' && controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw Object.assign(new Error('人工缺陷单请求未能完整核对，请保留原确认并只读查询。'), {
      code: 'INVALID_RESPONSE', outcomeUnknown: method === 'POST' });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function fetchDefectTicketExport(projectId, ticketId, format, { baseUrl = '', headers = {}, signal, fetcher = globalThis.fetch,
  timeoutMs = 60000 } = {}) {
  need(id(projectId, 'ap') && id(ticketId, 'dt') && ['md', 'json'].includes(format) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); const timer = setTimeout(abort, timeoutMs);
  try {
    throwIfAborted(controller.signal);
    const response = await abortable(fetcher(`${baseUrl}/api/acceptance/projects/${projectId}/defect-tickets/${ticketId}/export.${format}`, {
      method: 'GET', headers, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' }), controller.signal);
    const type = format === 'md' ? 'text/markdown' : 'application/json', name = `${ticketId}.${format}`;
    need(response.status === 200 && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === type
      && response.headers.get('content-disposition') === `attachment; filename="${name}"`);
    const bytes = await boundedResponse(response, MAX_JSON, controller.signal); return new Blob([bytes], { type });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
