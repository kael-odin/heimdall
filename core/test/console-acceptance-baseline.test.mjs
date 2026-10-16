import assert from 'node:assert/strict';
import test from 'node:test';
import { baselineSpecBindings, baselinePreviewState, buildBaselineCandidateInput, buildBaselineApprovalInput,
  buildBaselineSelectionInput, buildBaselineCancellationInput, validateBaselineWrite, createBaselinePreviewGuard } from '../../console/src/acceptance-baseline.js';
import { requestAcceptanceCatalog } from '../../console/src/acceptance-catalog.js';

const id = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const projectId = id('ap', 1), releaseId = id('ar', 2), runId = id('ac', 3), candidateId = id('ab', 4), approvalId = id('aa', 5);
const version = { generationId: id('ag', 6), revision: 12 }, digest = 'a'.repeat(64);
const cas = { expectedGenerationId: version.generationId, expectedRevision: version.revision };
const clone = value => JSON.parse(JSON.stringify(value));
function previewResponse() {
  return { ...version, executionReady: false,
    candidate: { id: candidateId, projectId, mode: 'spec', projectionVersion: 1, contentDigest: digest,
      source: { runId, sourceMode: 'spec', side: 'source', releaseId } },
    diagnostics: { eligible: true, contentMatches: true, issues: [] },
    preview: { projectionVersion: 1, projectId, releaseId, mode: 'spec',
      sourceReference: { runId, sourceMode: 'spec', side: 'source', releaseId },
      source: { id: 'quota-demand', revision: 'v2', type: 'manual' }, name: '正确需求 / 失败目标',
      targetUrl: 'http://127.0.0.1:3000/', sourceStatus: 'completed', sourceGate: 'failed', sourceSpecApproved: false,
      declaredSlots: 1, projectedSlots: 1, omissions: [], executionReady: false,
      checks: [{ id: 'QUOTA', title: '额度响应遵循需求', method: 'GET', path: '/quota', severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [
          { pointer: '', kind: 'equals', value: null }, { pointer: '/enabled', kind: 'equals', value: false },
          { pointer: '/quota', kind: 'equals', value: 0 }, { pointer: '/name', kind: 'equals', value: '' }], schema: false },
        rule: { timeoutMs: 10000, maxResponseBytes: 262144 }, identity: { version: 1 } }] },
  };
}
const context = { projectId, candidateId, version };
const approval = { id: approvalId, projectId, candidateId, contentDigest: digest, reason: '已核对来源与合同' };
const current = { id: id('as', 7), projectId, mode: 'spec', approvalId };

test('bound Spec sources include failed and draft outcomes without consulting a recent-run list', () => {
  const bindings = [
    { runId, releaseId, source: { mode: 'spec', gate: 'failed' } },
    { runId: id('ac', 8), releaseId, source: { mode: 'spec', gate: 'blocked' } },
    { runId: id('ac', 9), releaseId, source: { mode: 'mirror', gate: 'passed' } },
    { runId: id('ac', 10), releaseId, diagnostics: { sourceMissing: true } },
  ];
  assert.deepEqual(baselineSpecBindings(bindings).map(value => value.runId), [runId, id('ac', 8)]);
  assert.equal(bindings.length, 4);
});

test('candidate input fixes Spec/source and sends only the explicit bound run plus double CAS', () => {
  assert.deepEqual(buildBaselineCandidateInput({ sourceRunId: runId, mode: 'mirror', sourceSide: 'target',
    releaseId: id('ar', 90), actor: 'admin', selectCurrent: true }, version), { ...cas, mode: 'spec', sourceRunId: runId, sourceSide: 'source' });
  for (const sourceRunId of ['', '../run', candidateId, runId.toUpperCase()]) {
    assert.throws(() => buildBaselineCandidateInput({ sourceRunId }, version), error => error.code === 'INVALID_INPUT');
  }
});

test('complete failed-target and unapproved-draft previews can be reviewed without changing expected values', () => {
  const value = previewResponse(), before = clone(value);
  const state = baselinePreviewState(value, context);
  assert.equal(state.canDecide, true); assert.equal(state.preview.sourceGate, 'failed'); assert.equal(state.preview.sourceSpecApproved, false);
  assert.equal(state.preview.checks[0].expect.status, 200); assert.equal(state.preview.checks[0].expect.schema, false);
  assert.deepEqual(state.preview.checks[0].expect.json.map(value => value.value), [null, false, 0, '']);
  assert.deepEqual(value, before);
  value.preview.sourceGate = 'blocked'; assert.equal(baselinePreviewState(value, context).canDecide, true);
});

test('a source that is missing or changed preserves stored candidate facts and blocks decisions', () => {
  const missing = previewResponse(); missing.preview = null;
  missing.diagnostics = { eligible: false, contentMatches: false, issues: [{ code: 'SOURCE_UNAVAILABLE', message: '来源缺失，历史仍保留。' }] };
  const state = baselinePreviewState(missing, context);
  assert.equal(state.candidate.id, candidateId); assert.equal(state.preview, null); assert.equal(state.canDecide, false);
  const changed = previewResponse(); changed.diagnostics.contentMatches = false;
  assert.equal(baselinePreviewState(changed, context).canDecide, false);
  assert.throws(() => buildBaselineApprovalInput({ reason: '旧预览', confirmed: true }, version, changed, projectId), error => error.code === 'INVALID_INPUT');
});

test('preview version mismatches never silently promote or regress the shared catalog version', () => {
  for (const change of [value => value.revision--, value => value.revision++, value => { value.generationId = id('ag', 99); }]) {
    const value = previewResponse(); change(value);
    assert.throws(() => baselinePreviewState(value, context), error => error.code === 'STALE_REVISION' && error.status === 409
      && error.currentGenerationId === value.generationId && error.currentRevision === value.revision);
  }
});

test('incomplete or mismatched previews cannot enable approval or nonempty selection', () => {
  const changes = [
    value => { value.executionReady = true; }, value => { delete value.executionReady; },
    value => { value.candidate.projectId = id('ap', 99); }, value => { value.candidate.source.side = 'target'; },
    value => { value.preview.releaseId = id('ar', 99); }, value => { value.preview.sourceReference.runId = id('ac', 99); },
    value => { value.preview.projectedSlots = 0; }, value => { value.preview.declaredSlots = 2; },
    value => { value.preview.omissions.push({ id: 'omitted' }); }, value => { delete value.preview.checks[0].expect; },
    value => { delete value.preview.checks[0].rule; }, value => { delete value.preview.checks[0].identity; },
    value => { value.preview.checks[0].expect.json[0].kind = 'unknown'; }, value => { delete value.preview.checks[0].expect.json[0].value; },
    value => { value.preview.checks[0].method = 'HEAD'; }, value => { value.preview.checks.push(clone(value.preview.checks[0])); value.preview.declaredSlots = value.preview.projectedSlots = 2; },
    value => { value.preview.source.type = 'openapi'; }, value => { value.preview = null; },
  ];
  for (const change of changes) {
    const value = previewResponse(); change(value);
    assert.throws(() => baselinePreviewState(value, context), error => error.code === 'INVALID_RESPONSE');
  }
});

test('approval requires fresh explicit confirmation and pins the server content digest and reason only', () => {
  const value = previewResponse();
  assert.deepEqual(buildBaselineApprovalInput({ reason: '  完整核对需求  ', confirmed: true, actor: 'admin', selectCurrent: true }, version, value, projectId), {
    ...cas, candidateId, contentDigest: digest, reason: '完整核对需求',
  });
  for (const confirmed of [false, undefined, 'true', 1]) {
    assert.throws(() => buildBaselineApprovalInput({ reason: 'reason', confirmed }, version, value, projectId), error => error.code === 'INVALID_INPUT');
  }
  for (const reason of ['', ' ', 'x'.repeat(1001), 7]) {
    assert.throws(() => buildBaselineApprovalInput({ reason, confirmed: true }, version, value, projectId), error => error.code === 'INVALID_INPUT');
  }
});

test('selection is a separate confirmed request tied to a matching approval and current preview', () => {
  const value = previewResponse();
  assert.deepEqual(buildBaselineSelectionInput({ reason: '本次选用', confirmed: true, current: {}, actor: 'admin' }, version, value, approval, projectId), {
    ...cas, mode: 'spec', approvalId, contentDigest: digest, reason: '本次选用',
  });
  for (const patch of [{ projectId: id('ap', 99) }, { candidateId: id('ab', 99) }, { contentDigest: 'b'.repeat(64) }, { id: candidateId }]) {
    assert.throws(() => buildBaselineSelectionInput({ reason: '选用', confirmed: true }, version, value, { ...approval, ...patch }, projectId),
      error => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => buildBaselineSelectionInput({ reason: '批准勾选不能复用', confirmed: false }, version, value, approval, projectId), error => error.code === 'INVALID_INPUT');
});

test('cancellation requires a current selection but never reads or requires any source preview', () => {
  assert.deepEqual(buildBaselineCancellationInput({ reason: ' 来源已丢失，取消选用 ', confirmed: true, contentDigest: digest }, version, current), {
    ...cas, mode: 'spec', approvalId: null, contentDigest: null, reason: '来源已丢失，取消选用',
  });
  for (const value of [null, {}, { ...current, approvalId: null }, { ...current, mode: 'mirror' }]) {
    assert.throws(() => buildBaselineCancellationInput({ reason: '取消', confirmed: true }, version, value), error => error.code === 'INVALID_INPUT');
  }
});

test('preview tickets reject late project, candidate, revision and generation responses including A→B→A', () => {
  const guard = createBaselinePreviewGuard(), a = { projectId, generationId: version.generationId, revision: 12, candidateId, selectionEpoch: 1 };
  const oldA = guard.next(a), b = { ...a, projectId: id('ap', 90), selectionEpoch: 2 };
  guard.next(b); const nextA = { ...a, selectionEpoch: 3 }, fresh = guard.next(nextA);
  assert.equal(guard.accepts(oldA, nextA), false); assert.equal(guard.accepts(fresh, nextA), true);
  for (const patch of [{ candidateId: id('ab', 90) }, { generationId: id('ag', 90) }, { revision: 13 }, { selectionEpoch: 4 }]) {
    assert.equal(guard.accepts(fresh, { ...nextA, ...patch }), false);
  }
  guard.invalidate(); assert.equal(guard.accepts(fresh, nextA), false);
  const last = guard.next(nextA); guard.stop(); assert.equal(guard.accepts(last, nextA), false);
});

function writeResponse(kind, entity) {
  const eventKind = { candidate: 'candidate-created', approval: 'baseline-approved', selection: 'baseline-selected' }[kind];
  return { generationId: version.generationId, revision: version.revision + 1, executionReady: false, [kind]: entity,
    event: { id: id('ae', 20), projectId, entityId: entity.id, kind: eventKind, revision: version.revision + 1 } };
}

test('confirmed writes must return one matching entity and event without an execution-ready promise', () => {
  const candidate = previewResponse().candidate, candidateBody = buildBaselineCandidateInput({ sourceRunId: runId }, version);
  assert.deepEqual(validateBaselineWrite('candidate', writeResponse('candidate', candidate), { projectId, body: candidateBody }), candidate);
  const approvalBody = { ...cas, candidateId, contentDigest: digest, reason: approval.reason };
  assert.deepEqual(validateBaselineWrite('approval', writeResponse('approval', approval), { projectId, body: approvalBody }), approval);
  const selection = { ...current, reason: '选用原因' }, selectionBody = { ...cas, mode: 'spec', approvalId, contentDigest: digest, reason: selection.reason };
  assert.deepEqual(validateBaselineWrite('selection', writeResponse('selection', selection), { projectId, body: selectionBody }), selection);
});

test('malformed 201 envelopes are uncertain rather than permission to clear drafts or issue the next POST', () => {
  const body = { ...cas, candidateId, contentDigest: digest, reason: approval.reason };
  for (const alter of [value => { delete value.generationId; }, value => { value.revision++; }, value => { value.generationId = id('ag', 99); },
    value => { value.executionReady = true; }, value => { delete value.event; }, value => { value.event.entityId = candidateId; },
    value => { value.approval.projectId = id('ap', 99); }, value => { value.approval.contentDigest = 'b'.repeat(64); }]) {
    const value = writeResponse('approval', clone(approval)); alter(value);
    assert.throws(() => validateBaselineWrite('approval', value, { projectId, body }), error => error.code === 'INVALID_RESPONSE' && error.writeMayHaveCommitted === true);
  }
});

test('aborting an already dispatched POST is uncertain and never retries while GET abort remains an abort', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new DOMException('aborted after send', 'AbortError'); };
  await assert.rejects(requestAcceptanceCatalog('/baseline-approvals', { method: 'POST', body: {}, fetcher }),
    error => error.code === 'NETWORK_ERROR' && error.writeMayHaveCommitted === true);
  assert.equal(calls, 1);
  await assert.rejects(requestAcceptanceCatalog('/candidate', { fetcher }), error => error.name === 'AbortError');
  assert.equal(calls, 2);
});

test('a non-JSON gateway 502 after POST is uncertain and never retries, while GET remains a read failure', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('<html>Bad Gateway</html>', { status: 502 }); };
  await assert.rejects(requestAcceptanceCatalog('/baseline-approvals', { method: 'POST', body: {}, fetcher }),
    error => error.status === 502 && error.code === 'INVALID_RESPONSE' && error.writeMayHaveCommitted === true);
  assert.equal(calls, 1);
  await assert.rejects(requestAcceptanceCatalog('/candidate', { fetcher }),
    error => error.status === 502 && error.code === 'INVALID_RESPONSE' && error.writeMayHaveCommitted === false);
  assert.equal(calls, 2);
});
