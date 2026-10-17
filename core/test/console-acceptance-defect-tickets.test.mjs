/** Pure DTO, durable-confirmation and simulated transport tests. No Browser or service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { buildAcceptanceIdentity, canonicalAcceptanceJson } from '../src/acceptance/identity.mjs';
import { defectTicketDigest, defectTicketRequestFingerprint, defectTicketEventBytes,
  validateDefectTicketCreateRequest, validateDefectTicketCloseRequest } from '../src/acceptance/defect-ticket-schema.mjs';
import { createDefectTicketEvent, closeDefectTicketEvent, projectDefectTicket,
  previewDefectTicketClose, listDefectTicketSources } from '../src/acceptance/defect-ticket-model.mjs';
import { renderDefectTicketExport } from '../src/acceptance/defect-ticket-report.mjs';
import { defectTicketCreateInput, defectTicketCloseInput, defectTicketSources, defectTicketList,
  defectTicketDetail, defectTicketPreview, createDefectTicketReadGuard, defectTicketConfirmation,
  defectTicketAction, createDefectTicketReceipts, requestDefectTickets,
  fetchDefectTicketExport } from '../../console/src/acceptance-defect-tickets.js';

const uid = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const projectId = uid('ap', 1), otherProjectId = uid('ap', 2), candidateId = uid('bc', 1);
const ticketId = uid('dt', 1), contentDigest = sha('content'), origin = 'http://127.0.0.1:3000';
const invalidResponse = error => { assert.equal(error.code, 'INVALID_RESPONSE'); assert.equal(typeof error.message, 'string'); return true; };
const refKeys = ['operationId', 'targetReleaseId', 'acceptedAt', 'recordedAt', 'dispatchSha256', 'reportSha256', 'observationsSha256'];
const ref = value => Object.fromEntries(refKeys.map(key => [key, value[key]]));
const environment = { platform: 'linux', arch: 'x64', nodeVersion: 'v22.0.0', browser: 'chromium', browserVersion: '153',
  playwrightVersion: '1.63.0', locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' };
const identities = [960, 375].map(width => buildAcceptanceIdentity({ kind: 'browser', facet: 'visual', route: '/',
  viewport: { width, height: 640 }, rule: { minimumScore: .97 }, oracle: { text: 'fixed oracle' }, environment }));
const at = n => `2026-10-18T01:${String(n).padStart(2, '0')}:00.000Z`;

function operation(n, states) {
  const operationId = uid('bo', n), targetReleaseId = uid('ar', n), dispatchSha256 = sha('dispatch-' + n), evidenceManifest = [];
  const checks = states.map((state, i) => {
    const evidence = {};
    for (const role of ['baselineScreenshot', 'baselineDetails', 'baselineRepeat', 'targetScreenshot', 'targetDetails', 'targetRepeat', 'diff']) {
      const file = `${n}-${i}-${role.toLowerCase()}.${role.endsWith('Details') ? 'json' : 'png'}`;
      evidence[role] = file; evidenceManifest.push({ file, bytes: 17, sha256: sha(file) });
    }
    return { id: i ? 'mobile' : 'desktop', title: 'Saved menu check', route: '/', identity: clone(identities[i]),
      status: state, verdict: state === 'failed' ? 'bug' : 'match', actual: { eligible: true, stepsComplete: true, assertions: [] }, evidence };
  });
  const report = { operationId, targetReleaseId, dispatchSha256, status: 'completed', mode: 'browser-fixed',
    verifierFingerprint: sha('verifier'), environmentComparison: { comparable: true, differences: [] }, checks, evidenceManifest };
  const reportSha256 = sha(report), observation = { projectId, candidateId, contentDigest, operationId, targetReleaseId,
    dispatchSha256, reportSha256, recordedAt: at(n), observations: checks.map((check, i) => ({ bugId: 'bug-' + sha('bug-' + i),
      checkId: check.id, identity: clone(check.identity), status: check.status, verdict: check.verdict,
      relation: check.status === 'failed' ? 'observed_failure' : 'verified_passed', evidenceReferences: clone(check.evidence) })) };
  return { operationId, targetReleaseId, acceptedAt: at(n), recordedAt: at(n), dispatchSha256,
    reportSha256, observationsSha256: sha(observation), report, observation };
}
const createRequest = (n = 1) => ({ ticketId: uid('dt', n), actionId: uid('da', n), sourceOperationId: uid('bo', 1),
  memberCheckIds: ['mobile', 'desktop'], title: '<script>Menu defect</script>', severity: 'high',
  description: 'Both declared viewports fail. | [ordinary text](data:text/plain,test)', reproduction: '1. Open /\n2. Expand the menu' });
const source = operation(1, ['failed', 'failed']), healthy = operation(2, ['passed', 'passed']);
const facts = { projectId, candidateId, contentDigest, factsDigest: defectTicketDigest('facts', [source, healthy].map(ref)), operations: [source, healthy] };
const create = createDefectTicketEvent({ projectId, request: createRequest(), facts, createdAt: '2026-10-18T02:00:00.000Z' });
const record = event => ({ event, sha256: sha(defectTicketEventBytes(event)) });
const records = [record(create)], projected = projectDefectTicket({ records, facts });
const preview = previewDefectTicketClose({ records, facts, afterOperationId: healthy.operationId });
const closeRequest = () => ({ actionId: uid('da', 3), afterOperationId: healthy.operationId, expectedRevision: preview.expectedRevision,
  expectedHeadSha256: preview.expectedHeadSha256, memberSetDigest: preview.memberSetDigest, factsDigest: preview.factsDigest,
  previewDigest: preview.previewDigest, resolution: 'Restored both declared menu states.', confirmed: true });
const closed = closeDefectTicketEvent({ records, facts, request: closeRequest(), createdAt: '2026-10-18T03:00:00.000Z' });
const listKeys = ['ticketId', 'projectId', 'candidateId', 'contentDigest', 'title', 'severity', 'revision', 'headSha256',
  'memberSetDigest', 'processingStatus', 'verificationStatus', 'currentOperationId', 'counts', 'closeEligible', 'reason'];
const sourcesResponse = () => ({ schemaVersion: 1, kind: 'manual-defect-ticket-sources',
  scope: 'registered-completed-browser-operations', ...listDefectTicketSources({ facts }) });
const listResponse = () => ({ schemaVersion: 1, kind: 'manual-defect-ticket-list', scope: 'declared-members', projectId,
  ticketCount: 1, associatedCheckCount: 2, tickets: [Object.fromEntries(listKeys.map(key => [key, clone(projected[key])]))] });
const detailResponse = () => ({ schemaVersion: 1, projectId, ticket: clone(projected) });
const previewResponse = () => ({ schemaVersion: 1, projectId, ticketId, preview: clone(preview) });
const actionResponse = (event = create) => ({ schemaVersion: 1, kind: 'manual-defect-ticket-action', outcome: 'recorded', projectId,
  ticketId: event.ticketId, actionId: event.actionId, requestFingerprint: event.requestFingerprint,
  eventSha256: sha(defectTicketEventBytes(event)), event: clone(event), replayed: false });
const confirmation = (request = createRequest(), kind = 'create', selectedTicketId = request.ticketId ?? ticketId) =>
  defectTicketConfirmation({ projectId, ticketId: selectedTicketId, kind, request }, { crypto: webcrypto });
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const requestOptions = options => ({ baseUrl: origin, headers: { 'x-local-token': 'saved-local-token' }, ...options });

function memoryStorage(seed = null) {
  const values = new Map(); let reads = 0, writes = 0;
  return { values, get reads() { return reads; }, get writes() { return writes; },
    getItem(key) { reads++; return values.has(key) ? values.get(key) : seed; },
    setItem(key, value) { writes++; values.set(key, value); } };
}
function memoryLocks() {
  const tails = new Map(), calls = [];
  return { calls, request(name, options, callback) {
    calls.push({ name, options });
    const next = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: options.mode }));
    tails.set(name, next.catch(() => {})); return next;
  } };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const receiptsFor = (storage = memoryStorage(), locks = memoryLocks(), selectedProjectId = projectId) =>
  createDefectTicketReceipts({ projectId: selectedProjectId, origin, storage, locks });

test('create/close inputs and WebCrypto fingerprints match the Core request contract exactly', async () => {
  const input = createRequest(), before = clone(input), checked = defectTicketCreateInput(input);
  assert.deepEqual(checked, validateDefectTicketCreateRequest(input)); assert.deepEqual(input, before);
  const close = closeRequest(); assert.deepEqual(defectTicketCloseInput(close), validateDefectTicketCloseRequest(close));
  for (const [kind, request, selectedTicketId] of [['create', input, input.ticketId], ['close', close, ticketId]]) {
    const confirmed = await confirmation(request, kind, selectedTicketId);
    assert.deepEqual(confirmed, { version: 1, projectId, ticketId: selectedTicketId, kind, actionId: request.actionId,
      requestFingerprint: defectTicketRequestFingerprint({ projectId, ticketId: selectedTicketId, kind, request }),
      request: kind === 'create' ? validateDefectTicketCreateRequest(request) : validateDefectTicketCloseRequest(request) });
  }
  const unicode = { ...input, memberCheckIds: ['界面', '😀', 'é', 'a'], title: '菜单与\u2028分页', description: '路径 /?token=原文 仍作为纯文本。' };
  const confirmed = await confirmation(unicode);
  assert.equal(confirmed.requestFingerprint, defectTicketRequestFingerprint({ projectId, ticketId, kind: 'create', request: unicode }));
  assert.deepEqual(confirmed.request.memberCheckIds, validateDefectTicketCreateRequest(unicode).memberCheckIds);
});

test('input selectors and explicit close confirmation reject extra facts, duplicates and bounds', () => {
  for (const patch of [{ passed: true }, { candidateId }, { sourceOperationId: '../source' }, { title: '' },
    { description: 'x'.repeat(4001) }, { memberCheckIds: [] }, { memberCheckIds: ['desktop', 'desktop'] },
    { memberCheckIds: Array.from({ length: 25 }, (_, i) => `check-${i}`) }])
    assert.throws(() => defectTicketCreateInput({ ...createRequest(), ...patch }), invalidResponse);
  for (const patch of [{ confirmed: false }, { confirmed: 'true' }, { resolution: '' }, { expectedRevision: -1 },
    { previewDigest: 'bad' }, { state: 'closed' }])
    assert.throws(() => defectTicketCloseInput({ ...closeRequest(), ...patch }), invalidResponse);
});

test('DTO/input copies reject accessors, toJSON and cycles before executing hooks', async () => {
  let hooks = 0; const getter = {};
  Object.defineProperty(getter, 'ticketId', { enumerable: true, get() { hooks++; return ticketId; } });
  const toJSON = { toJSON() { hooks++; return createRequest(); } }, cyclic = {}; cyclic.self = cyclic;
  for (const raw of [getter, toJSON, cyclic]) {
    for (const fn of [defectTicketCreateInput, defectTicketCloseInput]) assert.throws(() => fn(raw), invalidResponse);
    assert.throws(() => defectTicketSources(raw, projectId, candidateId, contentDigest), invalidResponse);
    assert.throws(() => defectTicketList(raw, projectId), invalidResponse);
    assert.throws(() => defectTicketDetail(raw, projectId, ticketId), invalidResponse);
    assert.throws(() => defectTicketPreview(raw, projectId, ticketId, healthy.operationId), invalidResponse);
    await assert.rejects(defectTicketConfirmation(raw, { crypto: webcrypto }), invalidResponse);
  }
  assert.equal(hooks, 0);
});

test('sources, list, detail and preview accept real model DTOs without mutating them', () => {
  const values = [sourcesResponse(), listResponse(), detailResponse(), previewResponse()], before = clone(values);
  assert.doesNotThrow(() => defectTicketSources(values[0], projectId, candidateId, contentDigest));
  assert.doesNotThrow(() => defectTicketList(values[1], projectId));
  assert.doesNotThrow(() => defectTicketDetail(values[2], projectId, ticketId));
  assert.doesNotThrow(() => defectTicketPreview(values[3], projectId, ticketId, healthy.operationId));
  assert.deepEqual(values, before);
  const choices = defectTicketSources(sourcesResponse(), projectId, candidateId, contentDigest);
  assert.equal(choices.operations.length, 2, 'empty later registrations remain visible as anchors');
  assert.equal(choices.operations[1].members.length, 0);
  for (const currentFacts of [null, { ...facts, operations: [...facts.operations, operation(3, ['failed', 'passed'])] }]) {
    const ticket = projectDefectTicket({ records: [...records, record(closed)], facts: currentFacts });
    assert.doesNotThrow(() => defectTicketDetail({ schemaVersion: 1, projectId, ticket }, projectId, ticketId));
  }
});

test('every read DTO rejects cross-project, candidate, ticket and selected-operation mismatches', () => {
  assert.throws(() => defectTicketSources(sourcesResponse(), otherProjectId, candidateId, contentDigest), invalidResponse);
  assert.throws(() => defectTicketSources(sourcesResponse(), projectId, uid('bc', 9), contentDigest), invalidResponse);
  assert.throws(() => defectTicketSources(sourcesResponse(), projectId, candidateId, sha('changed content')), invalidResponse);
  assert.throws(() => defectTicketList(listResponse(), otherProjectId), invalidResponse);
  assert.throws(() => defectTicketDetail(detailResponse(), projectId, uid('dt', 9)), invalidResponse);
  assert.throws(() => defectTicketDetail(detailResponse(), otherProjectId, ticketId), invalidResponse);
  assert.throws(() => defectTicketPreview(previewResponse(), projectId, ticketId, source.operationId), invalidResponse);
  assert.throws(() => defectTicketPreview(previewResponse(), otherProjectId, ticketId, healthy.operationId), invalidResponse);
});

test('count, duplicate identity, unknown-field and chain mutations never become accepted DTOs', () => {
  for (const mutate of [value => { value.ticketCount++; }, value => { value.associatedCheckCount++; },
    value => { value.tickets.push(clone(value.tickets[0])); value.ticketCount++; value.associatedCheckCount += 2; },
    value => { value.tickets[0].counts.passed = 3; }, value => { value.tickets[0].unexpected = true; }]) {
    const value = listResponse(); mutate(value); assert.throws(() => defectTicketList(value, projectId), invalidResponse);
  }
  for (const mutate of [value => { value.ticket.projectId = otherProjectId; }, value => { value.ticket.history[0].ticketId = uid('dt', 8); },
    value => { value.ticket.members[0].identity.contextKey = value.ticket.members[1].identity.contextKey; },
    value => { value.ticket.headSha256 = 'not-a-hash'; }, value => { value.ticket.executionReady = true; }]) {
    const value = detailResponse(); mutate(value); assert.throws(() => defectTicketDetail(value, projectId, ticketId), invalidResponse);
  }
  const selected = previewResponse(); selected.preview.after.operationId = source.operationId;
  assert.throws(() => defectTicketPreview(selected, projectId, ticketId, healthy.operationId), invalidResponse);
});

test('malformed nested response types always produce fixed INVALID_RESPONSE errors', async () => {
  const nonPrimitive = { toString: null, valueOf: null }, confirmed = await confirmation();
  for (const mutate of [value => { value.ticket.history[0].members[0].identity.facet = nonPrimitive; },
    value => { value.ticket.history[0].members[0].bugId = nonPrimitive; }, value => { value.ticket.history = null; },
    value => { value.ticket.members = null; }, value => { value.ticket.counts = null; }]) {
    const value = detailResponse(); mutate(value);
    assert.throws(() => defectTicketDetail(value, projectId, ticketId), invalidResponse);
  }
  const action = actionResponse(); action.event.members[0].identity.facet = nonPrimitive;
  await assert.rejects(defectTicketAction(action, confirmed, { crypto: webcrypto }), invalidResponse);
});

test('read epochs abort only the replaced channel and discard stale responses through reset and stop', () => {
  const guard = createDefectTicketReadGuard(), oldList = guard.begin('list'), detail = guard.begin('detail');
  assert.equal(guard.current(oldList), true); assert.equal(guard.current(detail), true);
  const newList = guard.begin('list'); assert.equal(oldList.signal.aborted, true);
  assert.equal(guard.current(oldList), false); assert.equal(guard.current(newList), true); assert.equal(guard.current(detail), true);
  guard.reset(); assert.equal(newList.signal.aborted, true); assert.equal(detail.signal.aborted, true);
  const next = guard.begin('list'); assert.equal(guard.current(next), true); assert.equal(guard.current(oldList), false);
  guard.stop(); assert.equal(next.signal.aborted, true); assert.equal(guard.current(next), false);
  const afterStop = guard.begin('list'); assert.equal(afterStop.signal.aborted, true); assert.equal(guard.current(afterStop), false);
});

test('action verification binds exact event SHA, request fields, project, ticket and action', async () => {
  for (const [event, request, kind] of [[create, createRequest(), 'create'], [closed, closeRequest(), 'close']]) {
    const confirmed = await confirmation(request, kind), original = actionResponse(event), before = clone(original);
    await defectTicketAction(original, confirmed, { crypto: webcrypto }); assert.deepEqual(original, before);
    for (const mutate of [value => { value.projectId = otherProjectId; }, value => { value.ticketId = uid('dt', 99); },
      value => { value.actionId = uid('da', 99); }, value => { value.requestFingerprint = sha('changed'); },
      value => { value.eventSha256 = sha('changed bytes'); }, value => { value.event.description = 'changed event'; },
      value => { value.event.projectId = otherProjectId; }, value => { value.outcome = 'unresolved'; }]) {
      const changed = clone(original); mutate(changed);
      await assert.rejects(defectTicketAction(changed, confirmed, { crypto: webcrypto }), invalidResponse);
    }
    const rehashed = clone(original);
    if (kind === 'create') rehashed.event.description = 'Changed exact request despite a matching event SHA.';
    else rehashed.event.resolution = 'Changed exact close resolution despite a matching event SHA.';
    rehashed.eventSha256 = sha(Buffer.from(canonicalAcceptanceJson(rehashed.event) + '\n'));
    await assert.rejects(defectTicketAction(rehashed, confirmed, { crypto: webcrypto }), invalidResponse);
  }
});

test('unavailable WebCrypto cannot create confirmation or action success proof', async () => {
  await assert.rejects(defectTicketConfirmation({ projectId, ticketId, kind: 'create', request: createRequest() }, { crypto: null }), invalidResponse);
  const confirmed = await confirmation();
  await assert.rejects(defectTicketAction(actionResponse(), confirmed, { crypto: null }), invalidResponse);
});

test('two receipts managers sharing storage and Web Locks permit exactly one pending submission', async () => {
  const storage = memoryStorage(), locks = memoryLocks(), a = receiptsFor(storage, locks), b = receiptsFor(storage, locks);
  const one = await confirmation(), two = await confirmation(createRequest(2));
  assert.equal(a.canWrite, true); assert.equal(a.key, b.key); assert(a.key.includes(projectId));
  const outcomes = await Promise.all([a.claimForSubmit(one), b.claimForSubmit(two)]);
  assert.deepEqual([...outcomes].sort(), [false, true]);
  assert.deepEqual(a.read(), [outcomes[0] ? one : two]); assert.equal(storage.writes, 1);
  assert(locks.calls.every(call => call.name === a.key && call.options.mode === 'exclusive'));
  assert.notEqual(receiptsFor(storage, locks, otherProjectId).key, a.key);
});

test('a changed read epoch while awaiting Web Locks cancels only this client unsent claim', async () => {
  const storage = memoryStorage(), waiting = deferred(), release = deferred(), inner = memoryLocks();
  const locks = { request(name, options, action) { waiting.resolve(); return inner.request(name, options, async () => {
    await release.promise; return action();
  }); } };
  const receipts = receiptsFor(storage, locks), guard = createDefectTicketReadGuard(), epoch = guard.begin('submit-context');
  const confirmed = await confirmation(); let posts = 0;
  const workflow = (async () => {
    if (!await receipts.claimForSubmit(confirmed)) return 'occupied';
    if (!guard.current(epoch)) { await receipts.cancelUnsent(confirmed); return 'unsent-cancelled'; }
    receipts.markDispatched(confirmed); posts++; return 'dispatched';
  })();
  await waiting.promise; guard.reset(); release.resolve();
  assert.equal(await workflow, 'unsent-cancelled'); assert.equal(posts, 0); assert.deepEqual(receipts.read(), []);
});

test('unsent cancellation requires the exact original client capability and becomes impossible after dispatch', async () => {
  const storage = memoryStorage(), locks = memoryLocks(), receipts = receiptsFor(storage, locks), confirmed = await confirmation();
  await receipts.claimForSubmit(confirmed);
  const reloaded = receiptsFor(storage, locks);
  await assert.rejects(async () => reloaded.cancelUnsent(confirmed), invalidResponse);
  await assert.rejects(async () => receipts.cancelUnsent({ ...confirmed, requestFingerprint: sha('different') }), invalidResponse);
  assert.deepEqual(receipts.read(), [confirmed]);
  receipts.markDispatched(confirmed);
  assert.throws(() => receipts.markDispatched(confirmed), invalidResponse);
  await assert.rejects(async () => receipts.cancelUnsent(confirmed), invalidResponse);
  await assert.rejects(async () => reloaded.cancelUnsent(confirmed), invalidResponse);
  assert.deepEqual(receipts.read(), [confirmed]);
  const proof = await defectTicketAction(actionResponse(), confirmed, { crypto: webcrypto });
  await receipts.resolveExact(confirmed, proof); assert.deepEqual(receipts.read(), []);
});

test('lack of Web Locks, inaccessible storage and incomplete save/readback prevent POST admission', async () => {
  const confirmed = await confirmation(); let posts = 0;
  const noLocks = receiptsFor(memoryStorage(), null); assert.equal(noLocks.canWrite, false);
  await assert.rejects(noLocks.claimForSubmit(confirmed), invalidResponse);
  for (const storage of [
    { getItem() { throw new Error('private filesystem path'); }, setItem() {} },
    { getItem() { return null; }, setItem() { throw new Error('quota private detail'); } },
    { getItem() { return null; }, setItem() {} },
    memoryStorage('{broken'),
  ]) {
    const receipts = receiptsFor(storage);
    await assert.rejects((async () => { if (await receipts.claimForSubmit(confirmed)) posts++; })());
  }
  assert.equal(posts, 0);
  const extra = await confirmation(createRequest(2)), values = memoryStorage();
  values.setItem = function (key, value) { values.values.set(key, JSON.stringify([...JSON.parse(value), extra])); };
  await assert.rejects(receiptsFor(values).claimForSubmit(confirmed), invalidResponse);
});

test('stored confirmation sets must be complete, unique, in scope and descriptor safe', async () => {
  const one = await confirmation(), two = await confirmation(createRequest(2));
  for (const raw of ['{broken', '{}', JSON.stringify([one, one]), JSON.stringify([{ ...one, projectId: otherProjectId }]),
    JSON.stringify(Array.from({ length: 33 }, () => one))])
    assert.throws(() => receiptsFor(memoryStorage(raw)).read(), invalidResponse);
  assert.deepEqual(receiptsFor(memoryStorage(JSON.stringify([one, two]))).read(), [one, two]);
  await assert.rejects(receiptsFor().claimForSubmit({ ...one, requestFingerprint: sha('changed') }), invalidResponse);
});

test('only branded exact action success clears its matching durable confirmation', async () => {
  const confirmed = await confirmation(), storage = memoryStorage(), receipts = receiptsFor(storage);
  await receipts.claimForSubmit(confirmed);
  for (const forged of [actionResponse(), { outcome: 'recorded' }, clone(confirmed), undefined]) {
    await assert.rejects(async () => receipts.resolveExact(confirmed, forged), invalidResponse); assert.deepEqual(receipts.read(), [confirmed]);
  }
  const another = await confirmation(createRequest(2)), proof = await defectTicketAction(actionResponse(), confirmed, { crypto: webcrypto });
  await assert.rejects(async () => receipts.resolveExact(another, proof), invalidResponse); assert.deepEqual(receipts.read(), [confirmed]);
  await receipts.resolveExact(confirmed, proof); assert.deepEqual(receipts.read(), []);
});

test('resolution verifies the entire remaining collection after storage write', async () => {
  const one = await confirmation(), two = await confirmation(createRequest(2)), storage = memoryStorage();
  const receipts = receiptsFor(storage), proof = await defectTicketAction(actionResponse(), one, { crypto: webcrypto });
  storage.values.set(receipts.key, JSON.stringify([one, two]));
  storage.setItem = (key, _value) => storage.values.set(key, '[]');
  await assert.rejects(receipts.resolveExact(one, proof), invalidResponse);
});

test('GET unresolved and all unbranded or uncertain errors keep the pending confirmation', async () => {
  const confirmed = await confirmation(), receipts = receiptsFor(); await receipts.claimForSubmit(confirmed);
  const unresolved = { schemaVersion: 1, kind: 'manual-defect-ticket-action', projectId, actionId: confirmed.actionId,
    outcome: 'unresolved', reason: 'ABSENCE_IS_NOT_A_COMMIT_DECISION' };
  const returned = await requestDefectTickets(projectId, '/actions/' + confirmed.actionId, requestOptions({ fetcher: async () => jsonResponse(unresolved) }));
  await assert.rejects(async () => receipts.resolveExact(confirmed, returned), invalidResponse);
  for (const error of [Object.assign(new Error('forged'), { code: 'STALE_FACTS', status: 409, outcomeUnknown: false }),
    { code: 'INVALID_INPUT', status: 400, outcomeUnknown: false }, unresolved])
    await assert.rejects(async () => receipts.releaseRejected(confirmed, error), invalidResponse);
  assert.deepEqual(receipts.read(), [confirmed]);
});

test('an exact explicit safe POST rejection alone can release its confirmation', async () => {
  const confirmed = await confirmation(), receipts = receiptsFor(); await receipts.claimForSubmit(confirmed);
  let failure;
  try { await requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request,
    fetcher: async () => jsonResponse({ code: 'SOURCE_NOT_ELIGIBLE', error: 'private server stack', outcomeUnknown: false }, 409) })); }
  catch (error) { failure = error; }
  assert.equal(failure.outcomeUnknown, false); assert(!failure.message.includes('private server stack'));
  const different = await confirmation(createRequest(2));
  await assert.rejects(async () => receipts.releaseRejected(different, failure), invalidResponse);
  assert.deepEqual(receipts.read(), [confirmed]);
  await receipts.releaseRejected(confirmed, failure); assert.deepEqual(receipts.read(), []);
});

test('request transport uses fixed local routes, authenticated no-store headers and validated bodies', async () => {
  let seen;
  const confirmed = await confirmation();
  await requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request,
    fetcher: async (url, options) => { seen = { url, options }; return jsonResponse(actionResponse(), 201); } }));
  assert.equal(seen.url, `${origin}/api/acceptance/projects/${projectId}/defect-tickets`);
  assert.equal(seen.options.method, 'POST'); assert.equal(seen.options.cache, 'no-store');
  assert.equal(seen.options.credentials, 'omit'); assert.equal(seen.options.redirect, 'error');
  assert.equal(new Headers(seen.options.headers).get('x-local-token'), 'saved-local-token');
  assert.equal(new Headers(seen.options.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(seen.options.body), validateDefectTicketCreateRequest(confirmed.request));
  let fetched = 0;
  for (const [suffix, options] of [['/../other', {}], ['?token=leak', {}], ['/actions/' + uid('da', 1), { method: 'POST', body: confirmed.request }],
    ['', { method: 'DELETE' }], ['', { method: 'POST', body: { ...confirmed.request, passed: true } }]])
    await assert.rejects(requestDefectTickets(projectId, suffix, requestOptions({ ...options, fetcher: async () => { fetched++; } })), invalidResponse);
  assert.equal(fetched, 0);
});

test('POST network, malformed status/MIME/JSON and every ambiguous failure remain unknown', async () => {
  const confirmed = await confirmation();
  const fetchers = [async () => { throw new Error('secret network path'); }, async () => jsonResponse({ code: 'INTEGRITY_BLOCKED', outcomeUnknown: false }, 503),
    async () => jsonResponse({ code: 'STALE_FACTS' }, 409), async () => jsonResponse({ code: 'STALE_FACTS', outcomeUnknown: 'false' }, 409),
    async () => jsonResponse({ code: 'PRIVATE_UNKNOWN', outcomeUnknown: false }, 400), async () => jsonResponse({ code: 'STALE_FACTS', outcomeUnknown: false }, 400),
    async () => jsonResponse(actionResponse(), 202), async () => new Response('<secret>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => new Response('{broken', { headers: { 'content-type': 'application/json' } })];
  for (const fetcher of fetchers) {
    await assert.rejects(requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request, fetcher })), error => {
      assert.equal(error.outcomeUnknown, true); assert(!error.message.includes('secret')); return true;
    });
  }
});

test('safe known code/status rejection requires explicit false and ignores supplied visible error text', async () => {
  const confirmed = await confirmation(), messages = [];
  for (const error of ['first private stack', '<script>another private stack</script>']) {
    await assert.rejects(requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request,
      fetcher: async () => jsonResponse({ code: 'STALE_FACTS', error, outcomeUnknown: false }, 409) })), failure => {
      assert.equal(failure.code, 'STALE_FACTS'); assert.equal(failure.status, 409); assert.equal(failure.outcomeUnknown, false);
      assert(!failure.message.includes('private stack')); messages.push(failure.message); return true;
    });
  }
  assert.equal(messages[0], messages[1]);
});

test('the complete POST fetch/body lifetime times out or aborts even when transport ignores the signal', async () => {
  const confirmed = await confirmation(), forever = () => new Promise(() => {});
  await assert.rejects(requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request, timeoutMs: 5, fetcher: forever })),
    error => error.outcomeUnknown === true);
  const controller = new AbortController(), pending = requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request,
    signal: controller.signal, timeoutMs: 1000, fetcher: forever }));
  controller.abort(); await assert.rejects(pending, error => error.outcomeUnknown === true);
  const preAborted = new AbortController(); preAborted.abort(); let calls = 0;
  await assert.rejects(requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request, signal: preAborted.signal,
    fetcher: async () => { calls++; } })), error => error.outcomeUnknown === true);
  assert.equal(calls, 0);
});

test('a stalled response body and stalled cancellation cannot hold POST beyond its deadline', async () => {
  const confirmed = await confirmation(); let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  const pending = requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request, timeoutMs: 5,
    fetcher: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) }));
  let watchdog;
  try {
    const outcome = await Promise.race([pending.then(() => ({ successful: true }), error => ({ error })),
      new Promise(resolve => { watchdog = setTimeout(() => resolve({ hung: true }), 150); })]);
    assert.notEqual(outcome.hung, true, 'cleanup must not extend the request lifetime');
    assert.equal(outcome.error?.outcomeUnknown, true); assert.equal(cancelled, true);
  } finally { clearTimeout(watchdog); }
});

test('read reset aborts a pending GET without granting any mutation-release proof', async () => {
  const guard = createDefectTicketReadGuard(), selected = guard.begin('detail');
  const pending = requestDefectTickets(projectId, '/' + ticketId, requestOptions({ signal: selected.signal,
    fetcher: () => new Promise(() => {}) }));
  guard.reset(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(guard.current(selected), false);
});

test('bounded JSON transport cancels overflow instead of returning a partial success', async () => {
  const confirmed = await confirmation(); let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(32 * 1024 * 1024 + 1, 32)); }, cancel() { cancelled = true; } });
  await assert.rejects(requestDefectTickets(projectId, '', requestOptions({ method: 'POST', body: confirmed.request,
    fetcher: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) })), error => error.outcomeUnknown === true);
  assert.equal(cancelled, true);
});

test('exports return exact bounded model artifacts only after response identity and MIME checks', async () => {
  for (const format of ['md', 'json']) {
    const artifact = renderDefectTicketExport({ projection: projected, records, format, exportedAt: '2026-10-18T04:00:00.000Z' }); let seen;
    const blob = await fetchDefectTicketExport(projectId, ticketId, format, requestOptions({ fetcher: async (url, options) => {
      seen = { url, options }; return new Response(artifact.bytes, { headers: { 'content-type': artifact.contentType,
        'content-length': String(artifact.bytes.length), 'content-disposition': `attachment; filename="${artifact.filename}"` } });
    } }));
    assert(blob instanceof Blob); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), artifact.bytes);
    assert.equal(seen.url, `${origin}/api/acceptance/projects/${projectId}/defect-tickets/${ticketId}/export.${format}`);
    assert.equal(seen.options.cache, 'no-store'); assert.equal(seen.options.credentials, 'omit'); assert.equal(seen.options.redirect, 'error');
  }
});

test('wrong export status, disposition, length or type never yields a downloadable artifact', async () => {
  const bytes = Buffer.from('# Saved ticket\n'), headers = { 'content-type': 'text/markdown; charset=utf-8',
    'content-length': String(bytes.length), 'content-disposition': `attachment; filename="${ticketId}.md"` };
  for (const response of [new Response(bytes, { status: 404, headers }), new Response(bytes, { status: 206, headers }),
    new Response(bytes, { headers: { ...headers, 'content-type': 'text/html' } }),
    new Response(bytes, { headers: { ...headers, 'content-disposition': 'attachment; filename="other.md"' } }),
    new Response(bytes, { headers: { ...headers, 'content-length': String(bytes.length + 1) } })])
    await assert.rejects(fetchDefectTicketExport(projectId, ticketId, 'md', requestOptions({ fetcher: async () => response })), invalidResponse);
});

test('aborted or overflowing export streams never return an artifact', async () => {
  const controller = new AbortController(), headers = { 'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${ticketId}.md"` };
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('# saved')); controller.abort(); stream.close(); } }), { headers });
  await assert.rejects(fetchDefectTicketExport(projectId, ticketId, 'md', requestOptions({ signal: controller.signal, fetcher: async () => response })),
    error => error.name === 'AbortError' || error.code === 'INVALID_RESPONSE');
  let cancelled = false;
  const overflow = new ReadableStream({ start(stream) { stream.enqueue(Buffer.alloc(32 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchDefectTicketExport(projectId, ticketId, 'md', requestOptions({ fetcher: async () => new Response(overflow, { headers }) })), invalidResponse);
  assert.equal(cancelled, true);
});
