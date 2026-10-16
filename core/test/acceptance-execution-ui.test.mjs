import assert from 'node:assert/strict';
import test from 'node:test';
import { AcceptanceExecutionError, buildExecutionConfirmation, createAcceptanceExecutionClient,
  createExecutionReadGuard, executionFailure, validateExecutionOperation } from '../../console/src/acceptance-execution.js';

const id = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const projectId = id('ap', 1), sourceReleaseId = id('ar', 2), sourceRunId = id('ac', 3);
const candidateId = id('ab', 4), approvalId = id('aa', 5), generationId = id('ag', 6);
const selectionId = id('as', 7), targetReleaseId = id('ar', 8), runId = id('ac', 9), taskId = id('a', 10);
const digest = 'a'.repeat(64), origin = 'http://127.0.0.1:8900', date = '2026-10-17T08:00:00.000Z';
const version = { generationId, revision: 12 };
const clone = value => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rejection = (code, status = 409, extra = {}) => response({ code, error: '明确拒绝', ...extra }, status);

function material() {
  const candidate = { id: candidateId, projectId, mode: 'spec', projectionVersion: 1, contentDigest: digest,
    source: { runId: sourceRunId, sourceMode: 'spec', side: 'source', releaseId: sourceReleaseId } };
  const detail = { ...version, executionReady: false, project: { id: projectId }, candidates: [candidate],
    approvals: [{ id: approvalId, projectId, candidateId, contentDigest: digest }],
    currentSelections: { spec: { id: selectionId, projectId, mode: 'spec', approvalId } },
    releases: [{ id: targetReleaseId, projectId, label: '目标', targetUrl: 'http://127.0.0.1:3001/full?build=2', buildRef: 'build-2' }] };
  const preview = { ...version, executionReady: false, candidate: clone(candidate),
    diagnostics: { eligible: true, contentMatches: true, issues: [] },
    preview: { projectionVersion: 1, projectId, releaseId: sourceReleaseId, mode: 'spec',
      sourceReference: { runId: sourceRunId, sourceMode: 'spec', side: 'source', releaseId: sourceReleaseId },
      source: { id: 'quota-demand', revision: 'v2', type: 'manual' }, name: '失败来源也可明确批准',
      targetUrl: 'http://127.0.0.1:3000/', sourceStatus: 'completed', sourceGate: 'failed', sourceSpecApproved: false,
      declaredSlots: 1, projectedSlots: 1, omissions: [], executionReady: false,
      checks: [{ id: 'QUOTA', title: '额度遵循需求', method: 'GET', path: '/quota', severity: 'high',
        expect: { status: 200, json: [{ pointer: '/quota', kind: 'equals', value: 0 }] }, rule: {}, identity: {} }] } };
  return { projectId, detail, version: clone(version), preview, targetReleaseId, epoch: 4 };
}
const confirmation = () => buildExecutionConfirmation(material());
function memoryStorage() {
  const values = new Map();
  return { values, get length() { return values.size; }, key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, String(value)); } };
}
function setup(options = {}) {
  const storage = options.storage ?? memoryStorage(), calls = [];
  let sequence = 100;
  const fetcher = options.fetcher ?? (async () => { throw new Error('unexpected request'); });
  const client = createAcceptanceExecutionClient({ baseUrl: origin, storage, now: () => date,
    randomUUID: () => id('ao', sequence++).slice(3),
    ...options, fetcher: async (url, init) => { calls.push({ url, init }); return fetcher(url, init); } });
  return { client, storage, calls };
}
function operation(receipt, change = {}) {
  return { schemaVersion: 1, projectId: receipt.projectId, operationId: receipt.request.operationId,
    sourceRunId, targetReleaseId, runId, taskId, state: 'running', runCreated: true,
    gate: 'blocked', reasonCode: null, ...change };
}
function capability(change = {}) {
  return { schemaVersion: 1, enabled: true, ready: true, busy: false, closing: false, blocked: false,
    code: null, kind: null, runId: null, taskId: null, recoveryReady: true, methods: ['GET', 'HEAD'], triageSupported: false, ...change };
}

test('confirmation pins the current selected chain, complete preview, double CAS and explicit target', () => {
  const input = material();
  input.detail.draft = { candidateId: id('ab', 999) };
  const value = buildExecutionConfirmation(input);
  assert.deepEqual(value, { projectId, ...version, selectionId, approvalId, candidateId, contentDigest: digest,
    sourceRunId, sourceReleaseId, targetReleaseId, targetUrl: 'http://127.0.0.1:3001/full?build=2', buildRef: 'build-2', epoch: 4 });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(value.plan, undefined);
  assert.equal(input.preview.preview.sourceGate, 'failed');
  assert.equal(input.preview.preview.sourceSpecApproved, false);
});

test('stale, incomplete or substituted confirmation material cannot start an attempt', () => {
  const mutations = [
    value => { value.version.revision++; }, value => { value.detail.generationId = id('ag', 99); },
    value => { value.detail.currentSelections.spec.approvalId = null; },
    value => { value.detail.approvals[0].contentDigest = 'b'.repeat(64); },
    value => { value.detail.candidates[0].source.runId = id('ac', 99); },
    value => { value.targetReleaseId = ''; }, value => { value.detail.releases[0].projectId = id('ap', 99); },
    value => { value.preview.preview.projectedSlots = 0; }, value => { value.preview.diagnostics.contentMatches = false; },
  ];
  for (const mutate of mutations) {
    const input = material(); mutate(input);
    assert.throws(() => buildExecutionConfirmation(input));
  }
});

test('prepare persists and reads back before its single-use closure sends exactly six request fields', async () => {
  let attempt, token = 'first';
  const { client, storage, calls } = setup({ headers: () => ({ 'x-heimdall-token': token }), fetcher: async (_url, init) => {
    assert.equal(storage.length, 1);
    assert.equal(JSON.parse(storage.getItem(storage.key(0))).request.operationId, attempt.receipt.request.operationId);
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['operationId', 'expectedGenerationId', 'expectedRevision', 'selectionId', 'contentDigest', 'targetReleaseId'].sort());
    assert.equal(init.headers['x-heimdall-token'], 'second');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    return response(operation(attempt.receipt, { replayed: false }), 202);
  } });
  assert.equal(calls.length, 0);
  attempt = client.prepareStart(confirmation());
  assert.equal(calls.length, 0); token = 'second';
  const result = await attempt.submit();
  assert.equal(result.state, 'running'); assert.equal(result.replayed, false);
  await assert.rejects(attempt.submit(), error => error.code === 'ALREADY_SUBMITTED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.stringify([...storage.values.values()]).includes('second'), false);
  assert.equal(JSON.stringify([...storage.values.values()]).includes('targetUrl'), false);
});

test('unavailable storage and failed readback prevent all execution requests', () => {
  for (const storage of [null, { length: 0, key() { return null; }, getItem() { return null; }, setItem() { throw new Error('quota'); } },
    { length: 0, key() { return null; }, getItem() { return null; }, setItem() {} }]) {
    const fixture = setup({ storage });
    assert.throws(() => fixture.client.prepareStart(confirmation()));
    assert.equal(fixture.calls.length, 0);
  }
});

test('stored immutable identity cannot be replaced by a new confirmation, a collision or later storage mutation', async () => {
  const fixture = setup({ randomUUID: () => id('ao', 100).slice(3) });
  const attempt = fixture.client.prepareStart(confirmation()), original = fixture.storage.getItem(fixture.storage.key(0));
  const changed = { ...confirmation(), targetReleaseId: id('ar', 99) };
  assert.throws(() => fixture.client.prepareStart(changed), error => error.code === 'RECEIPT_EXISTS');
  assert.equal(fixture.storage.getItem(fixture.storage.key(0)), original);
  const tampered = JSON.parse(original); tampered.request.expectedRevision++;
  fixture.storage.setItem(fixture.storage.key(0), JSON.stringify(tampered));
  await assert.rejects(attempt.submit(), error => error.code === 'RECEIPT_CORRUPT');
  assert.throws(() => fixture.client.readOperation(attempt.receipt), error => error.code === 'RECEIPT_CORRUPT');
  assert.equal(fixture.calls.length, 0);
});

test('lost POST response survives reload and original ID recovery uses GET only, including 404', async () => {
  const fixture = setup({ fetcher: async () => { throw new Error('connection closed after acceptance'); } });
  const attempt = fixture.client.prepareStart(confirmation());
  await assert.rejects(attempt.submit(), error => error.outcomeUnknown && error.code === 'NETWORK_ERROR');
  const recovered = setup({ storage: fixture.storage, fetcher: async () => rejection('NOT_FOUND', 404) });
  const receipts = recovered.client.listReceipts({ projectId });
  assert.equal(receipts.length, 1); assert.equal(receipts[0].request.operationId, attempt.receipt.request.operationId);
  assert.equal(receipts[0].resolution, null); assert.equal(receipts[0].submit, undefined);
  await assert.rejects(recovered.client.readOperation(receipts[0]), error => error.status === 404);
  assert.equal(recovered.client.listReceipts({ projectId })[0].resolution, null);
  assert.equal(recovered.calls.length, 1); assert.equal(recovered.calls[0].init.method, 'GET');
  assert.ok(recovered.calls[0].url.endsWith(attempt.receipt.request.operationId));
});

test('POST abort and every malformed successful response preserve unknown admission outcome', async () => {
  const changes = [
    () => new Response('<html>wrong engine</html>', { status: 202, headers: { 'content-type': 'text/html' } }),
    receipt => response(operation(receipt, { replayed: false, operationId: id('ao', 999) }), 202),
    receipt => response(operation(receipt, { replayed: false, targetReleaseId: id('ar', 999) }), 202),
    receipt => response(operation(receipt, { replayed: false, sourceRunId: id('ac', 999) }), 202),
    receipt => response(operation(receipt, { replayed: false, runCreated: false }), 202),
    receipt => response(operation(receipt, { replayed: false, taskId: '../../secret' }), 202),
    receipt => response(operation(receipt), 202),
    () => { throw new DOMException('aborted', 'AbortError'); },
  ];
  for (const change of changes) {
    let attempt;
    const fixture = setup({ fetcher: async () => change(attempt.receipt) });
    attempt = fixture.client.prepareStart(confirmation());
    await assert.rejects(attempt.submit(), error => error.outcomeUnknown === true);
    assert.equal(fixture.client.listReceipts({ projectId })[0].resolution, null);
    assert.equal(fixture.calls.length, 1);
  }
});

test('known pre-admission rejections get an immutable durable resolution without deleting original identity', async () => {
  for (const [code, status] of [['STALE_REVISION', 409], ['ACCEPTANCE_BUSY', 409], ['BASELINE_CHANGED', 409], ['INVALID_INPUT', 400], ['NOT_FOUND', 404], ['UNAUTHORIZED', 401]]) {
    const fixture = setup({ fetcher: async () => rejection(code, status) }), attempt = fixture.client.prepareStart(confirmation());
    const original = fixture.storage.getItem(fixture.storage.key(0));
    await assert.rejects(attempt.submit(), error => error.code === code && error.outcomeUnknown === false
      && error.authoritativeRejectionPersisted === true && error.resolutionSaved === true);
    const receipt = fixture.client.listReceipts({ projectId })[0];
    assert.deepEqual(receipt.resolution, { kind: 'rejected', code, status, resolvedAt: date });
    assert.equal(fixture.storage.length, 2);
    assert.equal(fixture.storage.getItem(fixture.storage.key(0)), original);
    assert.equal(fixture.calls.length, 1);
  }
});

test('START_FAILED, idempotency conflict, server failure and explicit uncertainty never archive an unknown receipt', async () => {
  for (const [code, status, extra] of [['MANAGED_EXECUTION_START_FAILED', 409, {}], ['MANAGED_RUN_CONFLICT', 409, {}],
    ['IDEMPOTENCY_CONFLICT', 409, {}], ['MANAGED_EXECUTION_UNAVAILABLE', 503, {}], ['STALE_REVISION', 409, { outcomeUnknown: true }]]) {
    const fixture = setup({ fetcher: async () => rejection(code, status, extra) }), attempt = fixture.client.prepareStart(confirmation());
    await assert.rejects(attempt.submit(), error => error.outcomeUnknown === true && !error.authoritativeRejectionPersisted);
    assert.equal(fixture.storage.length, 1); assert.equal(fixture.client.listReceipts({ projectId })[0].resolution, null);
  }
});

test('failure to persist a known rejection remains recoverable unknown instead of falsely archived', async () => {
  const storage = memoryStorage(), write = storage.setItem;
  storage.setItem = (key, value) => { if (key.endsWith(':rejected')) throw new Error('quota'); write(key, value); };
  const fixture = setup({ storage, fetcher: async () => rejection('STALE_REVISION') }), attempt = fixture.client.prepareStart(confirmation());
  await assert.rejects(attempt.submit(), error => error.code === 'RECEIPT_STORAGE_FAILED' && error.outcomeUnknown && !error.authoritativeRejectionPersisted);
  assert.equal(fixture.client.listReceipts({ projectId })[0].resolution, null);
  assert.equal(fixture.calls.length, 1);
});

test('receipts are isolated by engine, project and generation, with explicit access to older generation IDs', () => {
  const fixture = setup(), first = fixture.client.prepareStart(confirmation()).receipt;
  const second = fixture.client.prepareStart({ ...confirmation(), generationId: id('ag', 99) }).receipt;
  fixture.client.prepareStart({ ...confirmation(), projectId: id('ap', 99) });
  assert.equal(fixture.client.listReceipts({ projectId }).length, 2);
  assert.equal(fixture.client.listReceipts({ projectId, generationId }).length, 1);
  const foreign = setup({ baseUrl: 'http://127.0.0.1:8901', storage: fixture.storage });
  assert.deepEqual(foreign.client.listReceipts({ projectId }), []);
  assert.throws(() => foreign.client.readOperation(first), error => error.code === 'RECEIPT_CORRUPT');
  assert.equal(second.request.expectedGenerationId, id('ag', 99));
  assert.equal(foreign.calls.length, 0);
});

test('malformed saved identity is preserved and cannot trigger a query or silently disappear from the listing', () => {
  const fixture = setup(), attempt = fixture.client.prepareStart(confirmation()), key = fixture.storage.key(0);
  fixture.storage.setItem(key, '{');
  assert.throws(() => fixture.client.listReceipts({ projectId }), error => error.code === 'RECEIPT_CORRUPT');
  assert.throws(() => fixture.client.readOperation(attempt.receipt), error => error.code === 'RECEIPT_CORRUPT');
  assert.equal(fixture.storage.getItem(key), '{'); assert.equal(fixture.calls.length, 0);
});

test('capacity failure preserves all unresolved records and sends no automatic POST', () => {
  const fixture = setup({ maxReceipts: 1 }), first = fixture.client.prepareStart(confirmation());
  assert.throws(() => fixture.client.prepareStart({ ...confirmation(), revision: 13 }), error => error.code === 'RECEIPT_CAPACITY');
  assert.equal(fixture.client.listReceipts({ projectId })[0].request.operationId, first.receipt.request.operationId);
  assert.equal(fixture.storage.length, 1); assert.equal(fixture.calls.length, 0);
});

test('prepared is query-only and every public operation DTO excludes extra server data', async () => {
  let attempt;
  const fixture = setup({ fetcher: async () => response(operation(attempt.receipt, {
    state: 'prepared', runCreated: false, gate: null, reasonCode: null, plan: { forbidden: true }, owner: 'secret' })) });
  attempt = fixture.client.prepareStart(confirmation());
  const result = await fixture.client.readOperation(attempt.receipt);
  assert.equal(result.state, 'prepared'); assert.equal(result.runCreated, false);
  assert.equal(result.plan, undefined); assert.equal(result.owner, undefined); assert.equal(result.replayed, undefined);
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].init.method, 'GET');
});

test('operation state and gate are validated independently without claiming report verification', () => {
  const fixture = setup(), { receipt } = fixture.client.prepareStart(confirmation());
  const completed = validateExecutionOperation(operation(receipt, { state: 'completed', gate: 'failed', evidenceVerified: true }), { receipt });
  assert.equal(completed.state, 'completed'); assert.equal(completed.gate, 'failed'); assert.equal(completed.evidenceVerified, undefined);
  assert.equal(validateExecutionOperation(operation(receipt, { state: 'interrupted', reasonCode: 'CANCELLED' }), { receipt }).reasonCode, 'CANCELLED');
  for (const change of [{ state: 'prepared' }, { state: 'completed', gate: null }, { state: 'running', reasonCode: 'CANCELLED' },
    { state: 'failed', gate: 'passed', reasonCode: 'EXECUTION_FAILED' }, { state: 'interrupted', reasonCode: null }]) {
    assert.throws(() => validateExecutionOperation(operation(receipt, change), { receipt }), error => error.code === 'INVALID_RESPONSE');
  }
});

test('the first valid operation response pins run and task IDs across subsequent GET and POST responses', async () => {
  let attempt, returned = {};
  const fixture = setup({ fetcher: async (_url, init) => response(operation(attempt.receipt, {
    ...(init.method === 'POST' ? { replayed: false } : {}), ...returned }), init.method === 'POST' ? 202 : 200) });
  attempt = fixture.client.prepareStart(confirmation());
  assert.equal((await fixture.client.readOperation(attempt.receipt)).runId, runId);
  returned = { runId: id('ac', 99) };
  await assert.rejects(attempt.submit(), error => error.code === 'INVALID_RESPONSE' && error.outcomeUnknown);
  returned = { taskId: id('a', 99) };
  await assert.rejects(fixture.client.readOperation(attempt.receipt), error => error.code === 'INVALID_RESPONSE' && !error.outcomeUnknown);
  returned = {};
  assert.equal((await fixture.client.readOperation(attempt.receipt)).runId, runId);
  assert.equal((await fixture.client.readOperation(attempt.receipt)).taskId, taskId);
});

test('POST HTTP status, replay marker and run creation must agree', async () => {
  for (const [status, change] of [[200, { replayed: false }], [202, { replayed: true }],
    [202, { replayed: false, state: 'prepared', runCreated: false, gate: null }]]) {
    let attempt;
    const fixture = setup({ fetcher: async () => response(operation(attempt.receipt, change), status) });
    attempt = fixture.client.prepareStart(confirmation());
    await assert.rejects(attempt.submit(), error => error.code === 'INVALID_RESPONSE' && error.outcomeUnknown);
    assert.equal(fixture.client.listReceipts({ projectId })[0].resolution, null);
  }
});

test('capability accepts reservation before bind and keeps readiness a separate snapshot', async () => {
  const fixture = setup({ fetcher: async () => response(capability({ ready: false, busy: true, kind: 'managed', privatePath: 'secret' })) });
  const result = await fixture.client.readCapability();
  assert.equal(result.busy, true); assert.equal(result.runId, null); assert.equal(result.privatePath, undefined);
  assert.equal(fixture.calls[0].init.method, 'GET'); assert.equal(fixture.storage.length, 0);
  const invalid = setup({ fetcher: async () => response(capability({ ready: true, busy: true, kind: 'managed' })) });
  await assert.rejects(invalid.client.readCapability(), error => error.code === 'INVALID_RESPONSE' && !error.outcomeUnknown);
});

test('a stop response remains a stop request, with identity checked and no invented interrupted state', async () => {
  const fixture = setup({ fetcher: async () => response({ id: taskId, status: 'running', cancelRequested: true, owner: 'secret' }) });
  const result = await fixture.client.requestStop({ taskId, runId });
  assert.deepEqual(result, { taskId, runId, status: 'running', cancelRequested: true });
  assert.equal(result.reasonCode, undefined); assert.equal(fixture.storage.length, 0);
  const invalid = setup({ fetcher: async () => response({ id: id('a', 99), status: 'running', cancelRequested: true }) });
  await assert.rejects(invalid.client.requestStop({ taskId, runId }), error => error.code === 'INVALID_RESPONSE' && error.outcomeUnknown);
});

test('read aborts remain local aborts and never alter or resolve an operation receipt', async () => {
  const aborted = new DOMException('stopped local wait', 'AbortError');
  const fixture = setup({ fetcher: async () => { throw aborted; } }), attempt = fixture.client.prepareStart(confirmation());
  await assert.rejects(fixture.client.readOperation(attempt.receipt), error => error === aborted);
  assert.equal(fixture.storage.length, 1); assert.equal(fixture.client.listReceipts({ projectId })[0].resolution, null);
});

test('independent read guards reject project A to B to A and receipt epoch ABA responses', () => {
  const guard = createExecutionReadGuard(), a = { projectId, operationId: id('ao', 1), epoch: 1 };
  const first = guard.next(a); guard.next({ ...a, projectId: id('ap', 99) }); guard.next(a);
  assert.equal(guard.accepts(first, a), false);
  const current = guard.next(a);
  assert.equal(guard.accepts(current, { ...a, epoch: 2 }), false);
  assert.equal(guard.accepts(current, a), true);
  guard.stop(); assert.equal(guard.accepts(current, a), false);
});

test('public errors project only bounded diagnostic fields', () => {
  const value = executionFailure(new AcceptanceExecutionError('服务异常', { code: 'STALE_REVISION', status: 409,
    currentGenerationId: generationId, currentRevision: 13, outcomeUnknown: true, token: 'secret', stackPath: 'C:/private', details: { plan: 'secret' } }));
  assert.equal(value.currentRevision, 13); assert.equal(value.outcomeUnknown, true);
  assert.equal(value.token, undefined); assert.equal(value.stackPath, undefined); assert.equal(value.details, undefined);
});
