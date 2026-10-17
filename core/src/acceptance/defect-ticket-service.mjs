/** Manual ticket orchestration. This service cannot execute or register runs. */
import { assertAcceptanceOwner } from './owner.mjs';
import { createAcceptanceCatalogStore } from './catalog.mjs';
import { createDefectTicketSourceReader } from './defect-ticket-source.mjs';
import { createDefectTicketStore } from './defect-ticket-store.mjs';
import { DEFECT_TICKET_LIMITS, DefectTicketError, defectTicketFail as fail,
  isDefectTicketId, isDefectTicketActionId, validateDefectTicketCreateRequest, validateDefectTicketCloseRequest,
  defectTicketRequestFingerprint } from './defect-ticket-schema.mjs';
import { createDefectTicketEvent, projectDefectTicket, previewDefectTicketClose,
  closeDefectTicketEvent, listDefectTicketSources } from './defect-ticket-model.mjs';
import { renderDefectTicketExport } from './defect-ticket-report.mjs';

const projectIdOf = value => { if (typeof value !== 'string'
  || !/^ap-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) fail('INVALID_PROJECT_ID', 'INVALID_INPUT', 400); };
const candidateIdOf = value => { if (typeof value !== 'string'
  || !/^bc-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) fail('INVALID_CANDIDATE_ID', 'INVALID_INPUT', 400); };
const ticketIdOf = value => { if (!isDefectTicketId(value)) fail('INVALID_TICKET_ID', 'INVALID_INPUT', 400); };
const operationIdOf = value => { if (typeof value !== 'string'
  || !/^bo-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) fail('INVALID_OPERATION_ID', 'INVALID_INPUT', 400); };

export function createDefectTicketService({ owner, sourceLimits = {}, storeLimits = {} } = {}) {
  assertAcceptanceOwner(owner);
  const catalog = createAcceptanceCatalogStore({ root: owner.root, owner });
  const source = createDefectTicketSourceReader({ owner, limits: sourceLimits });
  const store = createDefectTicketStore({ owner, limits: storeLimits });
  function project(projectId) {
    assertAcceptanceOwner(owner); projectIdOf(projectId);
    const current = catalog.read();
    if (!current.projects[projectId]) fail('PROJECT_NOT_FOUND', 'NOT_FOUND', 404);
    assertAcceptanceOwner(owner); return current;
  }
  function ticket(snapshot, ticketId) {
    ticketIdOf(ticketId);
    const records = snapshot.tickets.find(chain => chain[0].event.ticketId === ticketId);
    if (!records) fail('TICKET_NOT_FOUND', 'NOT_FOUND', 404);
    return records;
  }
  function sourceScope(records) {
    const create = records[0].event;
    return { projectId: create.projectId, candidateId: create.candidateId, contentDigest: create.contentDigest };
  }
  function optionalSource(records) {
    try { return source.capture(sourceScope(records)); }
    catch (cause) {
      // Retain verifiable ticket history when its source cannot currently be
      // checked. Owner loss must still abort, rather than serve a stale root.
      if (!(cause instanceof DefectTicketError) || cause.code === 'INVALID_INPUT') throw cause;
      return null;
    }
  }
  // All values here have already crossed their descriptor-only request or
  // private source/store boundary. Account the actual complete model input.
  function boundedModel(input) {
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (bytes > DEFECT_TICKET_LIMITS.factsJsonBytes) fail('MODEL_INPUT_BUDGET', 'CAPACITY', 503);
    return bytes;
  }
  function detail(projectId, ticketId) {
    project(projectId); const snapshot = store.snapshot(projectId), records = ticket(snapshot, ticketId), captured = optionalSource(records);
    const input = { records, facts: captured?.facts ?? null }; boundedModel(input);
    const projection = projectDefectTicket(input);
    captured?.assertCurrent(); snapshot.assertCurrent(); assertAcceptanceOwner(owner);
    return { records, projection, captured, snapshot };
  }
  function list(projectId) {
    const current = project(projectId), snapshot = store.snapshot(projectId);
    // A removed or superseded candidate only blocks its own tickets. Capture
    // the shared project batch through a scope still present in the catalog.
    const available = snapshot.tickets.find(records => {
      const create = records[0].event, candidate = current.browserCandidates?.[create.candidateId];
      return candidate?.projectId === projectId && candidate.contentDigest === create.contentDigest;
    });
    const captured = available ? optionalSource(available) : null;
    const cache = new Map(), inputs = []; let totalModelBytes = 0;
    for (const records of snapshot.tickets) {
      const create = records[0].event, key = create.candidateId + ':' + create.contentDigest;
      if (!cache.has(key)) {
        let facts = null;
        if (captured) try { facts = captured.factsFor({ candidateId: create.candidateId, contentDigest: create.contentDigest }); }
        catch (cause) { if (!(cause instanceof DefectTicketError) || cause.code === 'INVALID_INPUT') throw cause; }
        cache.set(key, facts);
      }
      const facts = cache.get(key); totalModelBytes += boundedModel({ records, facts });
      // A single list request must not repeatedly copy an entire large source
      // batch for every ticket. Detail and export remain independently bounded.
      if (totalModelBytes > 128 * 1024 * 1024) fail('LIST_MODEL_WORK_BUDGET', 'CAPACITY', 503);
      inputs.push({ records, facts });
    }
    const tickets = inputs.map(input => {
      const value = projectDefectTicket(input);
      return Object.fromEntries(['ticketId', 'projectId', 'candidateId', 'contentDigest', 'title', 'severity', 'revision', 'headSha256',
        'memberSetDigest', 'processingStatus', 'verificationStatus', 'currentOperationId', 'counts', 'closeEligible', 'reason']
        .map(key => [key, value[key]]));
    });
    captured?.assertCurrent(); snapshot.assertCurrent(); assertAcceptanceOwner(owner);
    return { schemaVersion: 1, kind: 'manual-defect-ticket-list', scope: 'declared-members', projectId,
      ticketCount: tickets.length, associatedCheckCount: tickets.reduce((sum, value) => sum + value.counts.total, 0), tickets };
  }
  function sources(projectId, candidateId) {
    const current = project(projectId); candidateIdOf(candidateId);
    const candidate = current.browserCandidates?.[candidateId];
    if (!candidate || candidate.projectId !== projectId) fail('SOURCE_NOT_FOUND', 'NOT_FOUND', 404);
    const captured = source.capture({ projectId, candidateId, contentDigest: candidate.contentDigest });
    const input = { facts: captured.facts }; boundedModel(input);
    const result = listDefectTicketSources(input);
    captured.assertCurrent(); assertAcceptanceOwner(owner);
    return { schemaVersion: 1, kind: 'manual-defect-ticket-sources', scope: 'registered-completed-browser-operations', ...result };
  }
  function read(projectId, ticketId) {
    const { projection } = detail(projectId, ticketId);
    return { schemaVersion: 1, projectId, ticket: projection };
  }
  function previewClose(projectId, ticketId, afterOperationId) {
    operationIdOf(afterOperationId);
    const { records, captured, snapshot } = detail(projectId, ticketId), facts = captured?.facts ?? null;
    const input = { records, facts, afterOperationId }; boundedModel(input);
    const preview = previewDefectTicketClose(input);
    captured?.assertCurrent(); snapshot.assertCurrent(); assertAcceptanceOwner(owner);
    return { schemaVersion: 1, projectId, ticketId, preview };
  }
  function receipt(projectId, record, replayed = undefined) {
    return { schemaVersion: 1, kind: 'manual-defect-ticket-action', outcome: 'recorded', projectId,
      ticketId: record.event.ticketId, actionId: record.event.actionId,
      requestFingerprint: record.event.requestFingerprint, eventSha256: record.sha256, event: record.event,
      ...(replayed === undefined ? {} : { replayed }) };
  }
  function create(projectId, raw) {
    project(projectId); const request = validateDefectTicketCreateRequest(raw);
    const fingerprint = defectTicketRequestFingerprint({ projectId, ticketId: request.ticketId, kind: 'create', request });
    return store.append({ projectId, actionId: request.actionId, requestFingerprint: fingerprint, prepare(records) {
      if (records.some(record => record.event.ticketId === request.ticketId)) fail('TICKET_ALREADY_EXISTS', 'STALE_TICKET', 409);
      const captured = source.capture({ projectId, operationId: request.sourceOperationId });
      const input = { projectId, request, facts: captured.facts, createdAt: new Date().toISOString() }; boundedModel(input);
      const event = createDefectTicketEvent(input);
      captured.assertCurrent(); return { event, assertCurrent: captured.assertCurrent };
    } }).then(result => ({ status: result.replayed ? 200 : 201, payload: receipt(projectId, result.record, result.replayed) }));
  }
  function close(projectId, ticketId, raw) {
    project(projectId); ticketIdOf(ticketId); const request = validateDefectTicketCloseRequest(raw);
    const fingerprint = defectTicketRequestFingerprint({ projectId, ticketId, kind: 'close', request });
    return store.append({ projectId, actionId: request.actionId, requestFingerprint: fingerprint, prepare(allRecords) {
      const records = allRecords.filter(record => record.event.ticketId === ticketId);
      if (!records.length) fail('TICKET_NOT_FOUND', 'NOT_FOUND', 404);
      const captured = source.capture(sourceScope(records));
      const input = { records, facts: captured.facts, request, createdAt: new Date().toISOString() }; boundedModel(input);
      const event = closeDefectTicketEvent(input);
      captured.assertCurrent(); return { event, assertCurrent: captured.assertCurrent };
    } }).then(result => ({ status: result.replayed ? 200 : 201, payload: receipt(projectId, result.record, result.replayed) }));
  }
  function action(projectId, actionId) {
    project(projectId); if (!isDefectTicketActionId(actionId)) fail('INVALID_ACTION_ID', 'INVALID_INPUT', 400);
    const record = store.action(projectId, actionId); assertAcceptanceOwner(owner);
    return record ? receipt(projectId, record) : { schemaVersion: 1, kind: 'manual-defect-ticket-action', projectId, actionId,
      outcome: 'unresolved', reason: 'ABSENCE_IS_NOT_A_COMMIT_DECISION' };
  }
  function exportTicket(projectId, ticketId, format) {
    const { records, projection, captured, snapshot } = detail(projectId, ticketId);
    const artifact = renderDefectTicketExport({ projection, records, format, exportedAt: new Date().toISOString() });
    captured?.assertCurrent(); snapshot.assertCurrent(); assertAcceptanceOwner(owner); return artifact;
  }
  return Object.freeze({ list, sources, read, previewClose, create, close, action, exportTicket });
}
