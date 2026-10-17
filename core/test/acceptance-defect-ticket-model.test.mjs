import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { buildAcceptanceIdentity } from '../src/acceptance/identity.mjs';
import { defectTicketDigest, defectTicketEventBytes } from '../src/acceptance/defect-ticket-schema.mjs';
import { createDefectTicketEvent, projectDefectTicket, previewDefectTicketClose,
  closeDefectTicketEvent, listDefectTicketSources } from '../src/acceptance/defect-ticket-model.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';

const uid = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const projectId = uid('ap', 1), candidateId = uid('bc', 1), contentDigest = sha('content'), verifier = sha('verifier');
const environment = { platform: 'linux', arch: 'x64', nodeVersion: 'v22.0.0', browser: 'chromium', browserVersion: '153',
  playwrightVersion: '1.63.0', locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' };
const identities = [960, 375].map(width => buildAcceptanceIdentity({ kind: 'browser', facet: 'visual', route: '/',
  viewport: { width, height: 640 }, rule: { minimumScore: .97 }, oracle: { text: 'fixed oracle' }, environment }));
const bugIds = identities.map((_, i) => 'bug-' + sha('bug-' + i));
const at = n => `2026-10-18T01:${String(n).padStart(2, '0')}:00.000Z`;
const refKeys = ['operationId', 'targetReleaseId', 'acceptedAt', 'recordedAt', 'dispatchSha256', 'reportSha256', 'observationsSha256'];
const ref = operation => Object.fromEntries(refKeys.map(key => [key, operation[key]]));
function finishOperation(operation) {
  operation.reportSha256 = sha(operation.report);
  operation.observation.reportSha256 = operation.reportSha256;
  operation.observationsSha256 = sha(operation.observation); return operation;
}
function operation(n, states = ['passed', 'passed'], { empty = false, relations, renamed = false, acceptedAt = at(n), recordedAt = at(n),
  changedIdentity, verifierFingerprint = verifier } = {}) {
  const operationId = uid('bo', n), targetReleaseId = uid('ar', n), dispatchSha256 = sha('dispatch-' + n), manifest = [];
  const checks = [], rows = [];
  for (let i = 0; i < 2; i++) {
    const state = states[i], checkId = `${renamed ? 'renamed-' : ''}${i ? 'mobile' : 'desktop'}`;
    const identity = changedIdentity?.[i] ?? identities[i], evidence = {};
    for (const role of ['baselineScreenshot', 'baselineDetails', 'baselineRepeat', 'targetScreenshot', 'targetDetails', 'targetRepeat', 'diff']) {
      const file = `${n}-${i}-${role.toLowerCase()}.${role.endsWith('Details') ? 'json' : 'png'}`;
      evidence[role] = file; manifest.push({ file, bytes: 17, sha256: sha(file) });
    }
    if (state !== 'missing') checks.push({ id: checkId, title: 'Same title on both viewports', route: '/', identity: copy(identity),
      status: state, verdict: state === 'failed' ? 'bug' : state === 'passed' ? 'match' : 'environment',
      actual: { eligible: true, stepsComplete: true, assertions: [] }, evaluationLimited: state === 'blocked', evidence });
    rows.push({ bugId: bugIds[i], checkId: state === 'missing' ? null : checkId, identity: copy(identities[i]),
      status: state, verdict: state === 'failed' ? 'bug' : state === 'passed' ? 'match' : state === 'missing' ? 'unverified' : 'environment',
      relation: relations?.[i] ?? (state === 'failed' ? n === 1 ? 'observed_failure' : 'still_failed'
        : state === 'passed' ? 'verified_passed' : 'unverified'), evidenceReferences: evidence });
  }
  const report = { operationId, targetReleaseId, dispatchSha256, status: 'completed', mode: 'browser-fixed',
    verifierFingerprint, environmentComparison: { comparable: true, differences: [] }, checks, evidenceManifest: manifest };
  const observation = { projectId, candidateId, contentDigest, operationId, targetReleaseId, dispatchSha256,
    reportSha256: null, recordedAt, observations: empty ? [] : rows };
  return finishOperation({ operationId, targetReleaseId, acceptedAt, recordedAt, dispatchSha256,
    reportSha256: null, observationsSha256: null, report, observation });
}
function facts(operations) { return { projectId, candidateId, contentDigest,
  factsDigest: defectTicketDigest('facts', operations.map(ref)), operations }; }
const createRequest = () => ({ ticketId: uid('dt', 1), actionId: uid('da', 1), sourceOperationId: uid('bo', 1),
  memberCheckIds: ['mobile', 'desktop'], title: 'Menu fails on desktop and mobile', severity: 'high',
  description: 'Both declared viewports fail.', reproduction: 'Open / and expand the menu.' });
const record = event => ({ event, sha256: sha(defectTicketEventBytes(event)) });
function start(operations = [operation(1, ['failed', 'failed'])]) {
  const sourceFacts = facts(operations), create = createDefectTicketEvent({ projectId, request: createRequest(),
    facts: sourceFacts, createdAt: '2026-10-18T12:00:00.000Z' });
  return { records: [record(create)], facts: sourceFacts };
}
function closeRequest(records, sourceFacts, operationId, action = 2) {
  const preview = previewDefectTicketClose({ records, facts: sourceFacts, afterOperationId: operationId });
  return { actionId: uid('da', action), afterOperationId: operationId, expectedRevision: preview.expectedRevision,
    expectedHeadSha256: preview.expectedHeadSha256, memberSetDigest: preview.memberSetDigest, factsDigest: preview.factsDigest,
    previewDigest: preview.previewDigest, resolution: 'Restored all declared menu states.', confirmed: true };
}
function close(records, sourceFacts, operationId, action = 2) {
  return closeDefectTicketEvent({ records, facts: sourceFacts, request: closeRequest(records, sourceFacts, operationId, action),
    createdAt: `2026-10-18T${String(12 + action).padStart(2, '0')}:00:00.000Z` });
}

test('real finishRun reports and immutable ledger drive a two-member close/reopen/explicit-reclose chain', async t => {
  let cleanup;
  const f = await browserOperationFixture({ after(fn) { cleanup = fn; } }), registered = [];
  t.after(() => {
    if (process.env.HEIMDALL_DEFECT_MODEL_EVIDENCE) cpSync(f.root, join(process.env.HEIMDALL_DEFECT_MODEL_EVIDENCE, 'real-store-fixture'),
      { recursive: true, errorOnExist: true, force: false });
    cleanup();
  });
  const executeOffline = bugs => {
    const request = f.request(); f.publish(request); const run = f.store.createRun(request.operationId);
    const raw = browserOperationRaw(f, run);
    assert(raw.checks.length >= 2);
    for (const index of bugs) { raw.checks[index].status = 'failed'; raw.checks[index].verdict = 'bug'; }
    const result = f.store.finishRun(request.operationId, raw);
    f.store.registerResult(request.operationId, { beforeOperationId: registered.at(-1) ?? null });
    registered.push(request.operationId); return result;
  };
  const readFacts = () => {
    const ledger = f.store.ledger(f.project.id);
    const operations = ledger.entries.map(observation => {
      const value = f.store.read(observation.operationId);
      return { operationId: value.operationId, targetReleaseId: observation.targetReleaseId,
        acceptedAt: value.record.envelope.acceptedAt, recordedAt: observation.recordedAt,
        dispatchSha256: value.record.sha256, reportSha256: value.head.reportSha256,
        observationsSha256: sha(readFileSync(join(value._scope.path, 'observations.json'))), report: value.report, observation };
    });
    return { projectId: f.project.id, candidateId: f.candidate.id, contentDigest: f.candidate.contentDigest,
      factsDigest: defectTicketDigest('facts', operations.map(ref)), operations };
  };
  const source = executeOffline([0, 1]), sourceFacts = readFacts();
  const request = { ...createRequest(), sourceOperationId: source.operationId, memberCheckIds: source.report.checks.slice(0, 2).map(check => check.id) };
  const create = createDefectTicketEvent({ projectId: f.project.id, request, facts: sourceFacts, createdAt: new Date().toISOString() });
  const records = [record(create)], immutableCreate = Buffer.from(defectTicketEventBytes(create));
  const healthy = executeOffline([]); let current = readFacts();
  let preview = previewDefectTicketClose({ records, facts: current, afterOperationId: healthy.operationId });
  assert.equal(preview.closeEligible, true); assert.equal(preview.counts.passed, 2);
  const performClose = action => {
    const input = { actionId: uid('da', action), afterOperationId: preview.afterOperationId,
      expectedRevision: preview.expectedRevision, expectedHeadSha256: preview.expectedHeadSha256,
      memberSetDigest: preview.memberSetDigest, factsDigest: preview.factsDigest, previewDigest: preview.previewDigest,
      resolution: 'Verified both real offline fixture checks.', confirmed: true };
    return closeDefectTicketEvent({ records, facts: current, request: input, createdAt: new Date().toISOString() });
  };
  records.push(record(performClose(2)));
  assert.equal(projectDefectTicket({ records, facts: current }).processingStatus, 'closed');
  executeOffline([1]); current = readFacts();
  let projected = projectDefectTicket({ records, facts: current });
  assert.equal(projected.processingStatus, 'reopened'); assert.equal(projected.reopenReasons.length, 1);
  const recovered = executeOffline([]); current = readFacts();
  projected = projectDefectTicket({ records, facts: current });
  assert.equal(projected.processingStatus, 'reopened'); assert.equal(projected.verificationStatus, 'verified_passed');
  preview = previewDefectTicketClose({ records, facts: current, afterOperationId: recovered.operationId });
  records.push(record(performClose(3)));
  assert.equal(projectDefectTicket({ records, facts: current }).processingStatus, 'closed');
  assert(defectTicketEventBytes(records[0].event).equals(immutableCreate));
  assert.deepEqual(f.store.ledger(f.project.id).entries.map(entry => entry.operationId), registered);
});

test('source listing validates one facts batch and preserves empty operation anchors', () => {
  const failed = operation(1, ['failed', 'passed']), empty = operation(2, ['failed', 'failed'], { empty: true });
  const batch = facts([empty, failed]), listed = listDefectTicketSources({ facts: batch });
  assert.equal(listed.projectId, projectId); assert.equal(listed.factsDigest, batch.factsDigest);
  assert.deepEqual(listed.operations.map(value => value.operationId), [failed.operationId, empty.operationId]);
  assert.deepEqual(listed.operations[0].members.map(member => member.checkId), ['desktop']);
  assert.equal(listed.operations[0].members[0].title, failed.report.checks[0].title);
  assert.deepEqual(listed.operations[1].members, []);
  assert.equal(Object.hasOwn(listed.operations[0], 'report'), false);
  const broken = copy(failed); broken.report.evidenceManifest = [];
  assert.throws(() => listDefectTicketSources({ facts: facts([broken]) }), { code: 'INTEGRITY_BLOCKED' });
  assert.throws(() => listDefectTicketSources({ facts: { ...batch, scope: {} } }), { code: 'INTEGRITY_BLOCKED' });
});

test('latest empty or unverified registration blocks an older healthy operation', () => {
  const source = operation(1, ['failed', 'failed']), healthy = operation(2), empty = operation(3, ['passed', 'passed'], { empty: true });
  const { records } = start([source]);
  for (const latest of [empty, operation(3, ['passed', 'passed'], { relations: ['observed_passed', 'observed_passed'] }), operation(3, ['blocked', 'blocked'])]) {
    const current = facts([source, healthy, latest]), projected = projectDefectTicket({ records, facts: current });
    assert.equal(projected.currentOperationId, latest.operationId);
    assert.equal(projected.verificationStatus, 'unverified'); assert.equal(projected.closeEligible, false);
    const preview = previewDefectTicketClose({ records, facts: current, afterOperationId: healthy.operationId });
    assert.equal(preview.closeEligible, false); assert.equal(preview.reason, 'AFTER_NOT_LATEST');
    assert.throws(() => close(records, current, healthy.operationId), { code: 'SOURCE_NOT_ELIGIBLE' });
  }
});

test('partial results cannot be joined across operations, viewports or target releases', () => {
  const source = operation(1, ['failed', 'failed']), desktop = operation(2, ['passed', 'failed']), mobile = operation(3, ['failed', 'passed']);
  const { records } = start([source]), current = facts([source, desktop, mobile]);
  const projected = projectDefectTicket({ records, facts: current });
  assert.equal(projected.verificationStatus, 'partially_passed'); assert.equal(projected.counts.passed, 1);
  assert.equal(projected.counts.failed, 1); assert.equal(projected.closeEligible, false);
  for (const after of [desktop, mobile]) assert.equal(previewDefectTicketClose({ records, facts: current, afterOperationId: after.operationId }).closeEligible, false);
  assert.throws(() => close(records, current, mobile.operationId), { code: 'SOURCE_NOT_ELIGIBLE' });
});

test('rule, oracle, case, environment or verifier changes remain incomparable despite declared verified_passed', () => {
  const source = operation(1, ['failed', 'failed']), { records } = start([source]);
  for (const key of ['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey']) {
    const changed = { ...identities[0], [key]: sha('changed-' + key) };
    const after = operation(2, ['passed', 'passed'], { changedIdentity: [changed, identities[1]] });
    const projected = projectDefectTicket({ records, facts: facts([source, after]) });
    assert.equal(projected.verificationStatus, 'incomparable', key); assert.equal(projected.closeEligible, false);
  }
  const after = operation(2, ['passed', 'passed'], { verifierFingerprint: sha('new generation') });
  assert.equal(projectDefectTicket({ records, facts: facts([source, after]) }).verificationStatus, 'incomparable');
  const environmentBlocked = operation(2); environmentBlocked.report.environmentComparison.comparable = false; finishOperation(environmentBlocked);
  assert.equal(projectDefectTicket({ records, facts: facts([source, environmentBlocked]) }).verificationStatus, 'incomparable');
});

test('limited capture, unstable masks, incomplete steps and policy never become reliable passes', () => {
  const source = operation(1, ['failed', 'failed']), { records } = start([source]);
  for (const patch of [{ eligible: false }, { stepsComplete: false }, { policyAffected: true }, { baselineStability: .8 },
    { targetStability: .8 }, { capture: { target: { captureLimited: true } } },
    { maskCoverage: { target: { maskedRatio: .81 } } }, { maskCoverage: { target: { samplingCapped: true } } },
    { assertions: [{ passed: false }] }, { blockedRequests: ['blocked'] }, { stepError: 'incomplete' }]) {
    const after = operation(2); Object.assign(after.report.checks[0].actual, patch); finishOperation(after);
    const projected = projectDefectTicket({ records, facts: facts([source, after]) });
    assert.equal(projected.closeEligible, false, JSON.stringify(patch)); assert.equal(projected.counts.passed, 1);
  }
});

test('check display IDs and row order may change; stable registered identities select exact members', () => {
  const source = operation(1, ['failed', 'failed']), after = operation(2, ['passed', 'passed'], { renamed: true });
  after.report.checks.reverse(); after.observation.observations.reverse(); finishOperation(after);
  const { records } = start([source]), current = facts([after, source]);
  const preview = previewDefectTicketClose({ records, facts: current, afterOperationId: after.operationId });
  assert.equal(preview.closeEligible, true);
  assert.deepEqual(preview.results.map(row => row.afterCheckId), ['renamed-desktop', 'renamed-mobile']);
  assert.equal(projectDefectTicket({ records: [...records, record(close(records, current, after.operationId))], facts: current }).processingStatus, 'closed');
});

test('late registration follows accepted order, then recordedAt, then operation ID', () => {
  const source = operation(1, ['failed', 'failed']), after = operation(4), { records } = start([source]);
  const current = facts([source, after]); records.push(record(close(records, current, after.operationId)));
  const lateOldFailure = operation(2, ['failed', 'failed'], { recordedAt: at(59) });
  let projected = projectDefectTicket({ records, facts: facts([lateOldFailure, after, source]) });
  assert.equal(projected.processingStatus, 'closed'); assert.equal(projected.currentOperationId, after.operationId);
  const sameAccepted = operation(5, ['failed', 'failed'], { acceptedAt: after.acceptedAt, recordedAt: at(5) });
  projected = projectDefectTicket({ records, facts: facts([source, after, sameAccepted]) });
  assert.equal(projected.processingStatus, 'reopened'); assert.equal(projected.currentOperationId, sameAccepted.operationId);
  const sameTime = operation(6, ['failed', 'failed'], { acceptedAt: after.acceptedAt, recordedAt: after.recordedAt });
  assert.equal(projectDefectTicket({ records, facts: facts([source, sameTime, after]) }).processingStatus, 'reopened');
});

test('a reliable regression remains reopened through a later pass or blocked observation until explicit close', () => {
  const source = operation(1, ['failed', 'failed']), healthy = operation(2), broken = operation(3, ['failed', 'passed']);
  const { records } = start([source]); records.push(record(close(records, facts([source, healthy]), healthy.operationId)));
  const recovered = operation(4), blocked = operation(5, ['blocked', 'blocked']);
  const recoveredFacts = facts([source, healthy, broken, recovered]);
  let projected = projectDefectTicket({ records, facts: recoveredFacts });
  assert.equal(projected.processingStatus, 'reopened'); assert.equal(projected.verificationStatus, 'verified_passed');
  assert.equal(projected.closeEligible, true);
  projected = projectDefectTicket({ records, facts: facts([...recoveredFacts.operations, blocked]) });
  assert.equal(projected.processingStatus, 'reopened'); assert.equal(projected.verificationStatus, 'unverified');
  assert.equal(projected.reopenReasons[0].operation.operationId, broken.operationId);
  const closedAgain = [...records, record(close(records, recoveredFacts, recovered.operationId, 3))];
  assert.equal(projectDefectTicket({ records: closedAgain, facts: recoveredFacts }).processingStatus, 'closed');
});

test('new missing/blocked/incomparable results preserve historical close without inventing a regression', () => {
  const source = operation(1, ['failed', 'failed']), healthy = operation(2), { records } = start([source]);
  records.push(record(close(records, facts([source, healthy]), healthy.operationId)));
  for (const after of [operation(3, ['missing', 'missing']), operation(3, ['blocked', 'blocked']),
    operation(3, ['passed', 'passed'], { empty: true }), operation(3, ['passed', 'passed'], { verifierFingerprint: sha('new') })]) {
    const projected = projectDefectTicket({ records, facts: facts([source, healthy, after]) });
    assert.equal(projected.processingStatus, 'closed'); assert.equal(projected.closeEligible, false);
    assert.deepEqual(projected.reopenReasons, []);
  }
});

test('preview digest fences new empty facts and revision/head; source self and unregistered after cannot close', () => {
  const source = operation(1, ['failed', 'failed']), healthy = operation(2), { records } = start([source]), current = facts([source, healthy]);
  const request = closeRequest(records, current, healthy.operationId), later = facts([source, healthy, operation(3, ['passed', 'passed'], { empty: true })]);
  assert.throws(() => closeDefectTicketEvent({ records, facts: later, request, createdAt: '2026-10-18T14:00:00.000Z' }), { code: 'STALE_FACTS' });
  const closeEvent = close(records, current, healthy.operationId);
  assert.throws(() => closeDefectTicketEvent({ records: [...records, record(closeEvent)], facts: current, request,
    createdAt: '2026-10-18T15:00:00.000Z' }), { code: 'STALE_TICKET' });
  assert.equal(previewDefectTicketClose({ records, facts: current, afterOperationId: source.operationId }).reason, 'SOURCE_OPERATION_IS_AFTER');
  assert.equal(previewDefectTicketClose({ records, facts: current, afterOperationId: uid('bo', 99) }).reason, 'AFTER_NOT_REGISTERED');
});

test('source selection rejects missing registration, mixed members and untrusted extra facts', () => {
  const source = operation(1, ['failed', 'failed']);
  for (const current of [facts([]), facts([operation(1, ['passed', 'passed'])]), facts([operation(1, ['failed', 'failed'], { empty: true })])])
    assert.throws(() => createDefectTicketEvent({ projectId, request: createRequest(), facts: current, createdAt: '2026-10-18T12:00:00.000Z' }), { code: 'SOURCE_NOT_ELIGIBLE' });
  assert.throws(() => createDefectTicketEvent({ projectId, request: { ...createRequest(), memberCheckIds: ['desktop', 'from-other-operation'] },
    facts: facts([source]), createdAt: '2026-10-18T12:00:00.000Z' }), { code: 'SOURCE_NOT_ELIGIBLE' });
  const { records } = start([source]), foreign = operation(2); foreign.observation.candidateId = uid('bc', 8); finishOperation(foreign);
  const projected = projectDefectTicket({ records, facts: facts([source, foreign]) });
  assert.equal(projected.verificationStatus, 'integrity_blocked'); assert.equal(projected.processingStatus, 'open');
});

test('source or historical close proof changes block verification while immutable ticket history remains readable', () => {
  const source = operation(1, ['failed', 'failed']), healthy = operation(2), { records } = start([source]);
  records.push(record(close(records, facts([source, healthy]), healthy.operationId)));
  const before = copy(records), changed = copy(healthy); changed.report.verifierFingerprint = sha('rewritten report'); finishOperation(changed);
  for (const current of [null, facts([source]), facts([source, changed])]) {
    const projected = projectDefectTicket({ records, facts: current });
    assert.equal(projected.processingStatus, 'closed'); assert.equal(projected.verificationStatus, 'integrity_blocked');
    assert.equal(projected.closeEligible, false); assert.equal(projected.history.length, 2);
  }
  assert.deepEqual(records, before);
});

test('malicious model arguments reject without executing hooks, and projections are deterministic and read only', () => {
  let hooks = 0;
  const getter = {}; Object.defineProperty(getter, 'records', { enumerable: true, get() { hooks++; return []; } });
  const proxy = new Proxy({}, { ownKeys() { hooks++; return []; }, getPrototypeOf() { hooks++; return Object.prototype; } });
  for (const raw of [getter, proxy, { toJSON() { hooks++; return {}; } }]) for (const fn of [createDefectTicketEvent,
    projectDefectTicket, previewDefectTicketClose, closeDefectTicketEvent]) assert.throws(() => fn(raw));
  assert.equal(hooks, 0);
  const source = operation(1, ['failed', 'failed']), { records } = start([source]), current = facts([source, operation(2)]);
  const original = copy({ records, facts: current }), a = projectDefectTicket({ records, facts: current }), b = projectDefectTicket({ records, facts: current });
  assert.deepEqual(a, b); assert.deepEqual({ records, facts: current }, original);
  a.members[0].evidence[0].file = 'caller-change.png';
  assert.deepEqual(projectDefectTicket({ records, facts: current }), b);
});
