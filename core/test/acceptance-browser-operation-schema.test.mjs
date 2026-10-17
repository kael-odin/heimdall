import test from 'node:test';
import assert from 'node:assert/strict';
import { browserOperationRequestFingerprint, validateBrowserOperationRequest, validateBrowserOperationDispatch,
  validateBrowserOperationReport, browserCheckRelation, browserCheckReliablePassed } from '../src/acceptance/browser-operation-schema.mjs';
import { fixedBrowserCheckIdentity } from '../src/acceptance/browser-fixed-contract.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { copy } from './fixtures/acceptance-browser-organized-candidate.mjs';

test('single-operation request has six strict fields and a project-scoped immutable fingerprint', async t => {
  const f = await browserOperationFixture(t), request = f.request();
  assert.deepEqual(validateBrowserOperationRequest(request), request);
  const fingerprint = browserOperationRequestFingerprint({ projectId: f.project.id, ...request });
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(browserOperationRequestFingerprint({ projectId: f.project.id, ...request, expectedRevision: 5 }), fingerprint);
  for (const patch of [{ runId: 'extra' }, { operationId: request.operationId.replace('bo-', 'ac-') }, { expectedRevision: -1 }, { contentDigest: 'x' }])
    assert.throws(() => validateBrowserOperationRequest({ ...request, ...patch }), e => e.code === 'INVALID_INPUT' && e.status === 400);
  let touched = false;
  const getter = { ...request }; Object.defineProperty(getter, 'candidateId', { enumerable: true, get() { touched = true; return request.candidateId; } });
  assert.throws(() => validateBrowserOperationRequest(getter)); assert.equal(touched, false);
  assert.throws(() => validateBrowserOperationRequest(new Proxy(request, { ownKeys() { touched = true; return []; } }))); assert.equal(touched, false);
});

test('dispatch binds full organization context, selected evidence, rules, target and approval scope', async t => {
  const f = await browserOperationFixture(t), { record } = f.publish();
  assert.deepEqual(validateBrowserOperationDispatch(record.envelope), record.envelope);
  for (const mutate of [e => e.approval.scope = 'global', e => e.project.name += 'changed',
    e => e.targetRelease.targetUrl += '/changed', e => e.contract.fixedBaseline.sourceSide = 'target',
    e => e.contract.rules[0].rule.timeoutMs += 1, e => e.contract.observations[0].expected.httpStatus = 201]) {
    const e = copy(record.envelope); mutate(e);
    const { contractDigest: _digest, ...content } = e.contract;
    e.contract.contractDigest = hashAcceptanceValue(content); e.contractFingerprint = e.contract.contractDigest;
    assert.throws(() => validateBrowserOperationDispatch(e));
  }
});

test('report rejects wrong identity, oracle, selected source, comparison and hidden incomplete coverage', async t => {
  const f = await browserOperationFixture(t), { record } = f.publish(), run = f.store.createRun(record.envelope.operationId), raw = browserOperationRaw(f, run);
  assert.deepEqual(validateBrowserOperationReport(raw, record), raw);
  for (const mutate of [r => r.checks[0].identity.oracleKey = '1'.repeat(64),
    r => r.checks[0].identity.contextKey = '1'.repeat(64), r => r.sourceEvidence.pop(),
    r => r.checks[0].evidence.baselineDetails = r.checks.at(-1).evidence.baselineDetails,
    r => r.environmentComparison.comparable = false, r => r.resolution.closesBugs = true,
    r => { r.checks.pop(); r.coverage.completed--; }, r => r.checks[0].actual.errors = ['runtime error'],
    r => { r.environment.nodeVersion += 'changed'; r.checks = r.checks.map(c => ({ ...c,
      identity: fixedBrowserCheckIdentity(f.contract, r.environment,
        { route: c.route, viewport: c.identity.viewport, ...(c.identity.pointId ? { pointId: c.identity.pointId } : {}) }, c.identity.facet) })); }]) {
    const r = copy(raw); mutate(r); assert.throws(() => validateBrowserOperationReport(r, record));
  }
});

test('readonly and incomplete diagnostics are stored as blocked observations and never a reliable fix', async t => {
  const f = await browserOperationFixture(t), { record } = f.publish(), run = f.store.createRun(record.envelope.operationId), raw = browserOperationRaw(f, run);
  const first = raw.checks.find(c => !c.identity.pointId), slot = { route: first.route, viewport: first.identity.viewport };
  const readonly = { ...copy(first), id: 'readonly', identity: fixedBrowserCheckIdentity(f.contract, raw.environment, slot, 'readonly'),
    status: 'blocked', verdict: 'environment', evaluationLimited: true };
  const withReadonly = { ...copy(raw), checks: [...copy(raw.checks), readonly], coverage: { planned: raw.checks.length + 1, completed: raw.checks.length + 1, capped: false } };
  assert.equal(validateBrowserOperationReport(withReadonly, record).checks.at(-1).identity.facet, 'readonly');
  const diagnostic = { id: 'runner-environment', route: '/', status: 'blocked', verdict: 'environment', evidence: {} };
  const partial = { ...copy(raw), checks: [diagnostic], coverage: { planned: raw.checks.length, completed: 1, capped: false } };
  assert.deepEqual(validateBrowserOperationReport(partial, record), partial);
  assert.equal(browserCheckReliablePassed(diagnostic), false);
  assert.equal(browserCheckRelation(null, diagnostic), 'unverified');
  const before = { ...copy(first), status: 'failed', verdict: 'bug' }, after = copy(first);
  assert.equal(browserCheckRelation(before, after, { verifierFingerprint: 'a' }, { verifierFingerprint: 'a' }), 'verified_passed');
  assert.equal(browserCheckRelation(before, after, { verifierFingerprint: 'a' }, { verifierFingerprint: 'b' }), 'incomparable');
  after.actual.assertions = [{ passed: false }]; assert.equal(browserCheckRelation(before, after, { verifierFingerprint: 'a' }, { verifierFingerprint: 'a' }), 'unverified');
});
