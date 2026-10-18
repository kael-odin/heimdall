import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFECT_TICKET_LIMITS, defectTicketJson, defectTicketRequestFingerprint, defectTicketMemberSetDigest,
  validateDefectTicketCreateRequest, validateDefectTicketCloseRequest, validateDefectTicketEvent,
  defectTicketEventBytes, validateDefectTicketChain, defectTicketDigest, validateDefectTicketConfirmation,
  validateDefectTicketRejection, validateDefectTicketDecision, validateDefectTicketDenyRequest,
  defectTicketRejectionBytes, defectTicketDecisionBytes } from '../src/acceptance/defect-ticket-schema.mjs';

const uid = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const h = value => createHash('sha256').update(String(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const request = () => ({ ticketId: uid('dt', 1), actionId: uid('da', 1), sourceOperationId: uid('bo', 1),
  memberCheckIds: ['mobile', 'desktop'], title: 'Menu does not expand', severity: 'high',
  description: '<script>ordinary text</script> | [text](data:text/plain,test)', reproduction: '1. Open menu\n2. Observe missing panel' });
function createEvent() {
  const input = validateDefectTicketCreateRequest({ ...request(), memberCheckIds: ['desktop'] });
  const member = { checkId: 'desktop', bugId: 'bug-' + h('bug'), route: '/',
    identity: { version: 1, kind: 'browser', facet: 'visual', caseKey: h('case'), contextKey: h('context'),
      ruleKey: h('rule'), oracleKey: h('oracle'), environmentKey: h('environment'), viewport: { width: 960, height: 640 } },
    verifierFingerprint: h('verifier'), evidence: [{ role: 'targetScreenshot', file: 'target.png', bytes: 17, sha256: h('image') }] };
  return { ticketContractVersion: 1, kind: 'create', ticketId: input.ticketId, actionId: input.actionId,
    projectId: uid('ap', 1), candidateId: uid('bc', 1), contentDigest: h('content'), revision: 0,
    previousEventSha256: null, requestFingerprint: defectTicketRequestFingerprint({ projectId: uid('ap', 1),
      ticketId: input.ticketId, kind: 'create', request: input }), createdAt: '2026-10-18T00:00:00.000Z', actor: { kind: 'local-operator' },
    title: input.title, severity: input.severity, description: input.description, reproduction: input.reproduction,
    source: { operationId: input.sourceOperationId, targetReleaseId: uid('ar', 1), acceptedAt: '2026-10-17T23:00:00.000Z',
      recordedAt: '2026-10-17T23:00:01.000Z', dispatchSha256: h('dispatch'), reportSha256: h('report'), observationsSha256: h('observations') },
    members: [member], memberSetDigest: defectTicketMemberSetDigest([member]) };
}
const record = event => ({ event, sha256: createHash('sha256').update(defectTicketEventBytes(event)).digest('hex') });
function closeEvent(first, { revision = 1, previousEventSha256 = record(first).sha256, actionId = uid('da', 2) } = {}) {
  const request = { actionId, afterOperationId: uid('bo', 2), expectedRevision: revision - 1,
    expectedHeadSha256: previousEventSha256, memberSetDigest: first.memberSetDigest, factsDigest: h('facts'),
    previewDigest: h('preview'), resolution: 'Restored the menu trigger.', confirmed: true };
  return { ticketContractVersion: 1, kind: 'close', ticketId: first.ticketId, actionId,
    projectId: first.projectId, candidateId: first.candidateId, contentDigest: first.contentDigest,
    revision, previousEventSha256, requestFingerprint: defectTicketRequestFingerprint({ projectId: first.projectId,
      ticketId: first.ticketId, kind: 'close', request }), createdAt: '2026-10-18T01:00:00.000Z', actor: { kind: 'local-operator' },
    after: { ...first.source, operationId: request.afterOperationId, acceptedAt: '2026-10-18T00:30:00.000Z', recordedAt: '2026-10-18T00:31:00.000Z' },
    memberSetDigest: first.memberSetDigest, factsDigest: request.factsDigest, previewDigest: request.previewDigest,
    results: [{ bugId: first.members[0].bugId, sourceCheckId: 'desktop', afterCheckId: 'renamed-desktop', relation: 'verified_passed' }],
    resolution: request.resolution, confirmed: true };
}
const reason = expected => error => { assert.equal(error.details?.reason, expected); return true; };

test('create input has one strict selector/text contract and normalizes only member order', () => {
  const input = request(), normalized = validateDefectTicketCreateRequest(input);
  assert.deepEqual(normalized.memberCheckIds, ['desktop', 'mobile']);
  assert.equal(normalized.description, input.description, 'plain text is retained for escaped rendering/export');
  assert.deepEqual(input.memberCheckIds, ['mobile', 'desktop'], 'caller data is not mutated');
  for (const field of ['passed', 'identity', 'verifierFingerprint', 'file', 'sha256', 'candidateId', 'scope'])
    assert.throws(() => validateDefectTicketCreateRequest({ ...input, [field]: true }), { code: 'INVALID_INPUT', status: 400 });
  for (const memberCheckIds of [[], ['desktop', 'desktop'], Array.from({ length: 25 }, (_, i) => `check-${i}`)])
    assert.throws(() => validateDefectTicketCreateRequest({ ...input, memberCheckIds }), { code: 'INVALID_INPUT' });
  assert.equal(validateDefectTicketCreateRequest({ ...input,
    memberCheckIds: Array.from({ length: 24 }, (_, i) => `check-${i}`) }).memberCheckIds.length, 24);
});

test('identifiers, severities, explicit confirmation and human text are bounded', () => {
  const input = request();
  for (const patch of [{ ticketId: input.ticketId.toUpperCase() }, { actionId: uid('bo', 1) }, { severity: 'urgent' },
    { title: ' ' }, { title: 'a'.repeat(241) }, { description: 'a'.repeat(4001) }, { reproduction: '\0secret' }])
    assert.throws(() => validateDefectTicketCreateRequest({ ...input, ...patch }), { code: 'INVALID_INPUT' });
  const first = createEvent(), close = closeEvent(first), valid = { actionId: close.actionId, afterOperationId: close.after.operationId,
    expectedRevision: 0, expectedHeadSha256: close.previousEventSha256, memberSetDigest: close.memberSetDigest,
    factsDigest: close.factsDigest, previewDigest: close.previewDigest, resolution: close.resolution, confirmed: true };
  assert.deepEqual(validateDefectTicketCloseRequest(valid), valid);
  for (const patch of [{ confirmed: false }, { confirmed: 'true' }, { resolution: '' }, { expectedRevision: -1 },
    { expectedHeadSha256: 'invalid' }, { status: 'passed' }, { revision: 0 }])
    assert.throws(() => validateDefectTicketCloseRequest({ ...valid, ...patch }), { code: 'INVALID_INPUT' });
});

test('JSON guards never invoke accessors, toJSON, proxy or inherited hooks', () => {
  let hooks = 0;
  const getter = {}; Object.defineProperty(getter, 'title', { enumerable: true, get() { hooks++; return 'bad'; } });
  const toJson = { toJSON() { hooks++; return {}; } };
  const inherited = Object.create({ toJSON() { hooks++; return {}; } });
  const proxy = new Proxy({}, { get() { hooks++; }, getPrototypeOf() { hooks++; }, ownKeys() { hooks++; return []; } });
  const arrayProxy = new Proxy([], { get() { hooks++; }, getPrototypeOf() { hooks++; }, ownKeys() { hooks++; return []; } });
  for (const malicious of [getter, toJson, inherited, proxy, arrayProxy, { nested: getter }]) {
    assert.throws(() => defectTicketJson(malicious));
    assert.throws(() => validateDefectTicketCreateRequest(malicious), { code: 'INVALID_INPUT' });
    assert.throws(() => defectTicketRequestFingerprint(malicious));
  }
  assert.equal(hooks, 0);
});

test('non JSON graphs, sparse/named arrays and structural budgets fail before encoding', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const symbol = { [Symbol('secret')]: 1 };
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 });
  const named = []; named.extra = 1;
  let deep = null; for (let i = 0; i < 70; i++) deep = { deep };
  for (const value of [cyclic, symbol, hidden, [1, , 2], named, { bad: undefined }, { n: NaN }, { n: Infinity }, deep, new Date()])
    assert.throws(() => defectTicketJson(value));
  assert.throws(() => defectTicketJson('a'.repeat(100), 32), reason('JSON_BUDGET'));
  const safe = defectTicketJson(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.hasOwn(safe, '__proto__'), true); assert.equal({}.polluted, undefined);
});

test('member and request digests have fixed domain/version and bind all selected source facts', () => {
  const first = createEvent(), input = request();
  const a = defectTicketRequestFingerprint({ projectId: first.projectId, ticketId: first.ticketId, kind: 'create', request: input });
  const b = defectTicketRequestFingerprint({ projectId: first.projectId, ticketId: first.ticketId, kind: 'create',
    request: { ...input, memberCheckIds: [...input.memberCheckIds].reverse() } });
  assert.equal(a, b);
  assert.notEqual(a, defectTicketRequestFingerprint({ projectId: first.projectId, ticketId: first.ticketId, kind: 'create',
    request: { ...input, description: input.description + ' changed' } }));
  const changed = copy(first.members); changed[0].evidence[0].sha256 = h('different image');
  assert.notEqual(first.memberSetDigest, defectTicketMemberSetDigest(changed));
  assert.notEqual(defectTicketDigest('facts', { x: 1 }), defectTicketDigest('preview', { x: 1 }));
  assert.throws(() => defectTicketDigest('unversioned', {}));
});

test('event bytes are canonical, bounded, and unknown contract versions fail closed', () => {
  const first = createEvent(), original = copy(first);
  assert.deepEqual(validateDefectTicketEvent(first), first);
  const bytes = defectTicketEventBytes(first);
  assert.equal(bytes.at(-1), 10); assert(bytes.length <= DEFECT_TICKET_LIMITS.actionBytes);
  assert.deepEqual(JSON.parse(bytes), first); assert.deepEqual(first, original);
  assert.throws(() => validateDefectTicketEvent({ ...first, ticketContractVersion: 2 }), reason('UNKNOWN_TICKET_CONTRACT'));
  assert.throws(() => validateDefectTicketEvent({ ...first, reopened: true }), reason('INVALID_FIELDS'));
  assert.throws(() => validateDefectTicketEvent({ ...first, memberSetDigest: h('different') }), reason('MEMBER_DIGEST_MISMATCH'));
  assert.throws(() => validateDefectTicketEvent({ ...first, title: '' }), { code: 'INTEGRITY_BLOCKED', status: 503 });
});

test('immutable chain needs one contiguous unbranched create/close sequence with original previous SHA', () => {
  const first = createEvent(), close = closeEvent(first), a = record(first), b = record(close);
  assert.deepEqual(validateDefectTicketChain([b, a]), [a, b], 'disk listing order cannot select a head');
  assert.throws(() => validateDefectTicketChain([a, b, record(closeEvent(first, { actionId: uid('da', 3) }))]), reason('CHAIN_FORK'));
  assert.throws(() => validateDefectTicketChain([a, record(closeEvent(first, { revision: 2 }))]), reason('CHAIN_GAP'));
  assert.throws(() => validateDefectTicketChain([a, record(closeEvent(first, { previousEventSha256: h('other original') }))]), reason('CHAIN_GAP'));
  assert.throws(() => validateDefectTicketChain([b]), reason('MISSING_CREATE'));
  const scopeChanged = { ...close, candidateId: uid('bc', 9) };
  assert.throws(() => validateDefectTicketChain([a, record(scopeChanged)]), reason('CHAIN_SCOPE_MISMATCH'));
  assert.throws(() => validateDefectTicketChain([a, b, record(closeEvent(first, { revision: 2,
    previousEventSha256: b.sha256, actionId: uid('da', 3) }))]), reason('CLOSE_ANCHOR_NOT_NEWER'));
});

test('chain rejects partial member close results and action ID reuse', () => {
  const first = createEvent(), close = closeEvent(first);
  assert.throws(() => validateDefectTicketChain([record(first), record({ ...close, actionId: first.actionId,
    requestFingerprint: defectTicketRequestFingerprint({ projectId: first.projectId, ticketId: first.ticketId, kind: 'close',
      request: { actionId: first.actionId, afterOperationId: close.after.operationId, expectedRevision: 0,
        expectedHeadSha256: close.previousEventSha256, memberSetDigest: close.memberSetDigest, factsDigest: close.factsDigest,
        previewDigest: close.previewDigest, resolution: close.resolution, confirmed: true } }) })]), reason('CHAIN_FORK'));
  const wrong = copy(close); wrong.results[0].sourceCheckId = 'not-the-source-member';
  assert.throws(() => validateDefectTicketChain([record(first), record(wrong)]), reason('RESULT_MEMBER_MISMATCH'));
});

test('record wrapper budget permits a valid chain close to the raw namespace byte limit', t => {
  const first = createEvent(), records = [record(first)]; let rawBytes = defectTicketEventBytes(first).length;
  for (let revision = 1; revision < DEFECT_TICKET_LIMITS.actions; revision++) {
    const close = closeEvent(first, { revision, previousEventSha256: records.at(-1).sha256, actionId: uid('da', 10000 + revision) });
    close.after.operationId = uid('bo', 10000 + revision); close.resolution = 'r'.repeat(DEFECT_TICKET_LIMITS.resolutionCharacters);
    close.requestFingerprint = defectTicketRequestFingerprint({ projectId: first.projectId, ticketId: first.ticketId, kind: 'close', request: {
      actionId: close.actionId, afterOperationId: close.after.operationId, expectedRevision: revision - 1,
      expectedHeadSha256: close.previousEventSha256, memberSetDigest: close.memberSetDigest, factsDigest: close.factsDigest,
      previewDigest: close.previewDigest, resolution: close.resolution, confirmed: true } });
    const bytes = defectTicketEventBytes(close);
    if (rawBytes + bytes.length > DEFECT_TICKET_LIMITS.namespaceBytes) break;
    rawBytes += bytes.length; records.push({ event: close, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const wrappedBytes = Buffer.byteLength(JSON.stringify(records));
  assert(rawBytes <= DEFECT_TICKET_LIMITS.namespaceBytes);
  assert(wrappedBytes > DEFECT_TICKET_LIMITS.namespaceBytes, 'record SHA/array wrappers require their own bounded allowance');
  assert.equal(wrappedBytes, rawBytes + 86 * records.length + 1);
  assert.equal(validateDefectTicketChain(records).length, records.length);
  t.diagnostic(JSON.stringify({ actions: records.length, rawBytes, wrappedBytes }));
});

function original(kind = 'create') {
  const first = createEvent(), close = closeEvent(first), request = kind === 'create'
    ? validateDefectTicketCreateRequest({ ticketId: first.ticketId, actionId: first.actionId,
      sourceOperationId: first.source.operationId, memberCheckIds: first.members.map(member => member.checkId),
      title: first.title, severity: first.severity, description: first.description, reproduction: first.reproduction })
    : { actionId: close.actionId, afterOperationId: close.after.operationId, expectedRevision: 0,
      expectedHeadSha256: close.previousEventSha256, memberSetDigest: close.memberSetDigest,
      factsDigest: close.factsDigest, previewDigest: close.previewDigest, resolution: close.resolution, confirmed: true };
  return { version: 1, projectId: first.projectId, ticketId: first.ticketId, kind, actionId: request.actionId,
    requestFingerprint: defectTicketRequestFingerprint({ projectId: first.projectId, ticketId: first.ticketId, kind, request }), request };
}
const rejection = (confirmation = original()) => ({ actionDecisionVersion: 1, kind: 'manual-defect-ticket-action-rejection',
  original: confirmation, effect: 'deny-late-manual-defect-ticket-action', decidedAt: '2026-10-18T02:00:00.000Z', actor: { kind: 'local-operator' } });

test('D6 confirmation binds every original identity and request field without silently normalizing members', () => {
  for (const kind of ['create', 'close']) {
    const value = original(kind); assert.deepEqual(validateDefectTicketConfirmation(value), value);
    for (const [key, changed] of Object.entries({ version: 2, projectId: uid('ap', 99), ticketId: uid('dt', 99),
      kind: kind === 'create' ? 'close' : 'create', actionId: uid('da', 99), requestFingerprint: h('different') }))
      assert.throws(() => validateDefectTicketConfirmation({ ...value, [key]: changed }), { code: 'INVALID_INPUT' }, key);
    for (const [key, before] of Object.entries(value.request)) {
      const changed = typeof before === 'string' ? before + 'x' : typeof before === 'number' ? before + 1
        : typeof before === 'boolean' ? !before : [...before, 'extra-member'];
      assert.throws(() => validateDefectTicketConfirmation({ ...value, request: { ...value.request, [key]: changed } }),
        { code: 'INVALID_INPUT' }, `${kind}.${key}`);
    }
    assert.throws(() => validateDefectTicketConfirmation({ ...value, generation: uid('ag', 1) }), { code: 'INVALID_INPUT' });
  }
  const value = original(); value.request.memberCheckIds = ['mobile', 'desktop'];
  value.requestFingerprint = defectTicketRequestFingerprint({ projectId: value.projectId, ticketId: value.ticketId, kind: value.kind, request: value.request });
  assert.throws(() => validateDefectTicketConfirmation(value), { code: 'INVALID_INPUT' });
  value.request.memberCheckIds.sort(); assert.deepEqual(validateDefectTicketConfirmation(value), value);
});

test('D6 rejection is an independent strict decision and accepted serialization remains byte identical', () => {
  const event = createEvent(), denied = rejection(), bytes = defectTicketRejectionBytes(denied);
  assert.deepEqual(validateDefectTicketRejection(denied), denied);
  assert.deepEqual(validateDefectTicketDecision(denied), denied); assert.equal(bytes.at(-1), 10);
  assert.deepEqual(defectTicketDecisionBytes(denied), bytes);
  assert.deepEqual(validateDefectTicketDecision(event), event);
  assert.deepEqual(defectTicketDecisionBytes(event), defectTicketEventBytes(event));
  assert.throws(() => validateDefectTicketEvent(denied), { code: 'INTEGRITY_BLOCKED' });
  for (const patch of [{ actionDecisionVersion: 2 }, { kind: 'create' }, { effect: 'cancel' },
    { decidedAt: '2026-10-18' }, { actor: { kind: 'remote-operator' } }, { ticketContractVersion: 1 }, { extra: true }])
    assert.throws(() => validateDefectTicketDecision({ ...denied, ...patch }), { code: 'INTEGRITY_BLOCKED' });
  for (const invalid of [null, false, [], {}, { kind: 'create' }, { ...event, actionDecisionVersion: 1 }, { ...denied, original: { ...denied.original, requestFingerprint: h('bad') } }])
    assert.throws(() => validateDefectTicketDecision(invalid), { code: 'INTEGRITY_BLOCKED' });
});

test('D6 confirmation, rejection, decision and deny boundaries reject hooks without invoking them', () => {
  let hooks = 0;
  const accessor = {}; Object.defineProperty(accessor, 'original', { enumerable: true, get() { hooks++; } });
  const proxy = new Proxy({}, { get() { hooks++; }, ownKeys() { hooks++; }, getPrototypeOf() { hooks++; } });
  const nested = rejection(); Object.defineProperty(nested.original.request, 'title', { enumerable: true, get() { hooks++; } });
  for (const input of [accessor, proxy, nested]) for (const validate of [validateDefectTicketConfirmation,
    validateDefectTicketRejection, validateDefectTicketDecision, validateDefectTicketDenyRequest]) assert.throws(() => validate(input));
  assert.equal(hooks, 0);
});

test('D6 deny has a separate 65536 byte wrapper budget while original requests retain 32768', t => {
  assert.equal(DEFECT_TICKET_LIMITS.requestBytes, 32768); assert.equal(DEFECT_TICKET_LIMITS.denyRequestBytes, 65536);
  const confirmation = original();
  confirmation.request.title = 'a'.repeat(239); confirmation.request.description = '界'.repeat(4000);
  confirmation.request.reproduction = '界'.repeat(4000);
  confirmation.request.memberCheckIds = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0') + 'a'.repeat(236));
  // Change one-byte characters to three-byte characters, within each legacy text limit.
  for (let index = 0; Buffer.byteLength(JSON.stringify(confirmation.request)) < DEFECT_TICKET_LIMITS.requestBytes - 1; index++) {
    const member = index % 24;
    confirmation.request.memberCheckIds[member] = confirmation.request.memberCheckIds[member].replace('a', '界');
  }
  const room = DEFECT_TICKET_LIMITS.requestBytes - Buffer.byteLength(JSON.stringify(confirmation.request));
  confirmation.request.title += 'a'.repeat(room);
  assert.equal(Buffer.byteLength(JSON.stringify(confirmation.request)), 32768);
  confirmation.requestFingerprint = defectTicketRequestFingerprint({ projectId: confirmation.projectId,
    ticketId: confirmation.ticketId, kind: confirmation.kind, request: confirmation.request });
  const envelope = { schemaVersion: 1, confirmed: true, original: confirmation };
  assert(Buffer.byteLength(JSON.stringify(envelope)) > 32768);
  assert.deepEqual(validateDefectTicketDenyRequest(envelope), envelope);
  assert.throws(() => validateDefectTicketCreateRequest({ ...confirmation.request, title: confirmation.request.title + 'a' }), { code: 'INVALID_INPUT' });
  for (const patch of [{ schemaVersion: 2 }, { confirmed: false }, { extra: true }, { original: { ...confirmation, extra: 'a'.repeat(65536) } }])
    assert.throws(() => validateDefectTicketDenyRequest({ ...envelope, ...patch }), { code: 'INVALID_INPUT' });
  t.diagnostic(JSON.stringify({ originalBytes: Buffer.byteLength(JSON.stringify(confirmation.request)), denyBytes: Buffer.byteLength(JSON.stringify(envelope)) }));
});
