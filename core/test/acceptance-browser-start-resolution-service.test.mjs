import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserExecutionService } from '../src/acceptance/browser-execution-service.mjs';
import { createAcceptanceExecutionRuntime } from '../src/acceptance/execution-runtime.mjs';
import { browserOperationRequestFingerprint, browserOperationSha256 } from '../src/acceptance/browser-operation-schema.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { uid } from './fixtures/acceptance-browser-organized-candidate.mjs';
import { facts } from '../scripts/fixtures/managed-execution.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const denial = request => ({ action: 'deny-future-starts-for-operation', request });
function setup(f, options = {}) {
  const runtime = options.runtime ?? createAcceptanceExecutionRuntime();
  const catalog = { read: () => ({ generationId: uid('ag', 901), revision: 99, projects: { [f.project.id]: f.project } }),
    async withBrowserExecutionCandidate(projectId, request, { assertAdmission, publish }) {
      assert.equal(projectId, f.project.id); assertAdmission();
      return { ...publish({ ...f, request }, { assertCurrent: assertAdmission }), contract: f.contract, sourceFiles: f.sourceFiles };
    } };
  const service = createBrowserExecutionService({ owner: f.owner, catalog, runtime, store: f.store,
    runner: (_contract, run) => browserOperationRaw(f, run), ...options });
  if (options.recover !== false) service.recover();
  return { service, runtime, catalog };
}

test('Browser resolution GET is physically read-only and does not call readiness or any runtime method', async t => {
  const f = await browserOperationFixture(t); let calls = 0;
  const runtime = Object.fromEntries(Object.keys(createAcceptanceExecutionRuntime()).map(name => [name, () => { calls++; throw Error(name); }]));
  const { service } = setup(f, { runtime, recover: false, assertReady() { calls++; throw Error('must not check readiness'); },
    runner() { calls++; throw Error('must not run'); } });
  const input = f.request(), before = facts(f.root);
  for (let i = 0; i < 8; i++) {
    const result = service.resolution(f.project.id, input.operationId);
    assert.equal(result.kind, 'browser-start-resolution'); assert.equal(result.outcome, 'unresolved');
    assert.equal(result.reasonCode, 'ABSENT_OBSERVED'); assert.equal(result.operationId, input.operationId);
    assert.equal(result.projectId, f.project.id); assert.equal(Object.hasOwn(result, 'safeToForget'), false);
  }
  assert.equal(calls, 0); assert.deepEqual(facts(f.root), before);
  assert.equal(existsSync(join(f.root, 'browser-operations')), false);
  assert.throws(() => service.resolution(uid('ap', 991), input.operationId), { code: 'NOT_FOUND' });
});

test('Browser deny fixes the original six fields despite newer revision and permanently fences late starts', async t => {
  const f = await browserOperationFixture(t); let starts = 0, prepares = 0;
  const base = setup(f), { service, runtime } = setup(f, { catalog: { ...base.catalog,
    withBrowserExecutionCandidate() { prepares++; throw Error('denial cannot read source'); } }, runner() { starts++; } });
  const input = f.request(), result = service.denyStart(f.project.id, input.operationId, denial(input));
  assert.equal(result.status, 200); assert.equal(result.payload.outcome, 'rejected');
  const rejection = result.payload.rejection;
  assert.deepEqual(rejection.request, input); assert.equal(rejection.request.expectedRevision, 4);
  assert.equal(rejection.requestFingerprint, browserOperationRequestFingerprint({ projectId: f.project.id, ...input }));
  const raw = readFileSync(join(f.root, 'browser-operations/v1', input.operationId, 'rejection.json'));
  assert.equal(result.payload.rejectionSha256, browserOperationSha256(raw));
  const saved = facts(f.root), repeated = service.denyStart(f.project.id, input.operationId, denial({ ...input }));
  assert.deepEqual(repeated.payload.rejection, rejection);
  await assert.rejects(service.execute(f.project.id, input), { code: 'BROWSER_START_REJECTED' });
  await assert.rejects(service.execute(f.project.id, { ...input, expectedRevision: 99 }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(prepares, 0); assert.equal(starts, 0); assert.equal(runtime.state().busy, false);
  assert.deepEqual(facts(f.root), saved); assert.deepEqual(service.list(f.project.id).operations, []);
  assert.equal(service.ledger(f.project.id).entries.length, 0);
});

test('Browser recorded and rejected proofs precede catalog, readiness, busy, blocked and closing state', async t => {
  const f = await browserOperationFixture(t), accepted = f.request(), rejected = f.request();
  f.publish(accepted, { assertCurrent: () => true });
  f.store.publishRejection({ projectId: f.project.id, request: rejected }, { assertCurrent: () => true });
  const runtime = createAcceptanceExecutionRuntime(), lease = runtime.reserve({ kind: 'legacy' });
  runtime.block(); runtime.close(); let hooks = 0;
  const { service } = setup(f, { runtime, recover: false, assertReady() { hooks++; throw Error('readiness'); },
    catalog: { read() { hooks++; throw Error('catalog'); }, withBrowserExecutionCandidate() { hooks++; } }, runner() { hooks++; } });
  const before = facts(f.root), state = runtime.state();
  for (const [input, outcome] of [[accepted, 'recorded'], [rejected, 'rejected']]) {
    const read = service.resolution(f.project.id, input.operationId);
    assert.equal(read.outcome, outcome);
    const result = service.denyStart(f.project.id, input.operationId, denial(input));
    assert.equal(result.status, 200); assert.equal(result.payload.outcome, outcome);
    if (outcome === 'recorded') {
      assert.deepEqual(read.request, input); assert.equal(read.operation.state, 'prepared');
      assert.equal(read.requestFingerprint, browserOperationRequestFingerprint({ projectId: f.project.id, ...input }));
      assert.equal(read.dispatchSha256, f.store.read(input.operationId).record.sha256);
    }
  }
  assert.equal(hooks, 0); assert.deepEqual(runtime.state(), state); assert.equal(runtime.assertHeld(lease), true);
  assert.deepEqual(facts(f.root), before); runtime.release(lease);
});

test('Browser deny returns every accepted terminal or running fact without cancelling, rewriting or restarting', async t => {
  const f = await browserOperationFixture(t), { service } = setup(f); let count = 0;
  for (const state of ['prepared', 'running', 'completed', 'failed', 'interrupted']) {
    const input = f.request(); f.publish(input, { assertCurrent: () => true });
    if (state !== 'prepared') {
      const run = f.store.createRun(input.operationId, { assertActive: () => true });
      if (state === 'completed') f.store.finishRun(input.operationId, browserOperationRaw(f, run), { assertActive: () => true });
      else if (state !== 'running') f.store.settleRun(input.operationId, { status: state,
        reasonCode: state === 'failed' ? 'EXECUTION_FAILED' : 'CANCELLED' }, { assertHeld: () => true });
    }
    const before = facts(f.root), result = service.denyStart(f.project.id, input.operationId, denial(input));
    assert.equal(result.payload.outcome, 'recorded'); assert.equal(result.payload.operation.state, state);
    assert.deepEqual(result.payload.request, input); assert.deepEqual(facts(f.root), before); count++;
  }
  assert.equal(count, 5);
});

test('Browser deny cannot take or release any occupied legacy, Spec or Browser lease', async t => {
  const f = await browserOperationFixture(t), { service, runtime } = setup(f);
  for (const kind of ['legacy', 'managed', 'browser']) {
    const input = f.request(), lease = runtime.reserve({ kind, ...(kind === 'browser' ? { operationId: f.request().operationId } : {}) });
    const before = facts(f.root), state = runtime.state();
    assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)), { code: 'EXECUTION_BUSY' });
    assert.equal(runtime.assertActive(lease), true); assert.deepEqual(runtime.state(), state);
    assert.deepEqual(facts(f.root), before); runtime.release(lease);
  }
});

test('Browser pending admission has an immediate read-only resolution and cannot be denied or leaked to another project', async t => {
  const f = await browserOperationFixture(t), gate = deferred(), base = setup(f); let starts = 0;
  const { service, runtime } = setup(f, { catalog: { ...base.catalog,
    async withBrowserExecutionCandidate(...args) { await gate.promise; return base.catalog.withBrowserExecutionCandidate(...args); } },
    runner(_contract, run) { starts++; return browserOperationRaw(f, run); } });
  const input = f.request(), executing = service.execute(f.project.id, input);
  try {
    const before = facts(f.root), result = service.resolution(f.project.id, input.operationId);
    assert.equal(result.reasonCode, 'ADMISSION_PENDING'); assert.equal(result.outcome, 'unresolved');
    assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)), { code: 'BROWSER_ADMISSION_PENDING' });
    assert.throws(() => service.resolution(uid('ap', 888), input.operationId), { code: 'NOT_FOUND' });
    assert.throws(() => service.denyStart(uid('ap', 888), input.operationId, denial(input)), { code: 'NOT_FOUND' });
    assert.equal(runtime.state().busy, true); assert.equal(starts, 0); assert.deepEqual(facts(f.root), before);
  } finally { gate.resolve(); await executing; await service.drain(); }
  assert.equal(starts, 1); assert.equal(runtime.state().busy, false);
});

test('Browser reserve-before-pending reentrancy is still protected by the shared lease', async t => {
  const f = await browserOperationFixture(t), base = setup(f); let service, conflict;
  ({ service } = setup(f, { catalog: { ...base.catalog, withBrowserExecutionCandidate(projectId, input, options) {
    try { service.denyStart(projectId, input.operationId, denial(input)); } catch (cause) { conflict = cause.code; }
    return base.catalog.withBrowserExecutionCandidate(projectId, input, options);
  } } }));
  const input = f.request(); await service.execute(f.project.id, input); await service.drain();
  assert.equal(conflict, 'EXECUTION_BUSY'); assert.equal(service.read(f.project.id, input.operationId).state, 'completed');
});

test('Browser rejection scope requires the original generation and a real project without refreshing the request', async t => {
  const f = await browserOperationFixture(t), { service } = setup(f), input = f.request(), before = facts(f.root);
  assert.throws(() => service.denyStart(f.project.id, input.operationId,
    denial({ ...input, expectedGenerationId: uid('ag', 902) })), { code: 'BROWSER_OPERATION_SCOPE_UNVERIFIED' });
  assert.throws(() => service.denyStart(uid('ap', 999), input.operationId, denial(input)), { code: 'NOT_FOUND' });
  assert.deepEqual(facts(f.root), before);
});

test('Browser rejection input rejects accessors, proxies, unknown fields and path/request mismatch without invoking hooks', async t => {
  const f = await browserOperationFixture(t), { service } = setup(f), input = f.request(); let hooks = 0;
  const trap = () => { hooks++; throw Error('must not invoke'); }, before = facts(f.root);
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const bad = [null, [], proxy, Object.defineProperty({}, 'action', { enumerable: true, get: trap }),
    { ...denial(input), extra: true }, { action: 'clear-receipt', request: input },
    denial({ ...input, sourceUrl: 'https://private.invalid' }), denial({ ...input, operationId: f.request().operationId }),
    denial({ ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }), { action: 'deny-future-starts-for-operation', request: proxy }];
  for (const raw of bad) assert.throws(() => service.denyStart(f.project.id, input.operationId, raw), { code: 'INVALID_INPUT' });
  assert.equal(hooks, 0); assert.deepEqual(facts(f.root), before);
});

test('Browser matching proofs bind each original confirmation field and isolate foreign projects', async t => {
  const f = await browserOperationFixture(t), { service } = setup(f), input = f.request();
  service.denyStart(f.project.id, input.operationId, denial(input));
  const before = facts(f.root);
  for (const patch of [{ expectedGenerationId: uid('ag', 905) }, { expectedRevision: 5 },
    { candidateId: uid('bc', 905) }, { contentDigest: 'f'.repeat(64) }, { targetReleaseId: uid('ar', 905) }]) {
    assert.throws(() => service.denyStart(f.project.id, input.operationId, denial({ ...input, ...patch })), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.throws(() => service.resolution(uid('ap', 999), input.operationId), { code: 'NOT_FOUND' });
  assert.throws(() => service.denyStart(uid('ap', 999), input.operationId, denial(input)), { code: 'NOT_FOUND' });
  assert.deepEqual(facts(f.root), before);
});

test('Browser partial decisions are never absence or a safe rejection and retain every original byte', async t => {
  const f = await browserOperationFixture(t), { service } = setup(f), input = f.request();
  mkdirSync(join(f.root, 'browser-operations/v1', input.operationId), { recursive: true });
  const before = facts(f.root), blocked = cause => ['BROWSER_OPERATION_UNAVAILABLE', 'BROWSER_OPERATION_INTEGRITY_FAILED'].includes(cause.code);
  assert.throws(() => service.resolution(f.project.id, input.operationId), blocked);
  assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)), blocked);
  await assert.rejects(service.execute(f.project.id, input), blocked);
  assert.deepEqual(facts(f.root), before);
});

test('Browser rejection publication uncertainty blocks new admission while original facts remain readable', async t => {
  const f = await browserOperationFixture(t); let writes = 0;
  const store = { ...f.store, publishRejection(...args) { writes++; f.store.publishRejection(...args);
    throw Object.assign(Error('private after commit'), { writeMayHaveCommitted: true }); } };
  const { service, runtime } = setup(f, { store }), input = f.request();
  assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)), { writeMayHaveCommitted: true });
  assert.equal(runtime.state().blocked, true); assert.equal(runtime.state().busy, false);
  const before = facts(f.root), original = service.resolution(f.project.id, input.operationId);
  assert.equal(original.outcome, 'rejected'); assert.equal(service.denyStart(f.project.id, input.operationId, denial(input)).payload.outcome, 'rejected');
  assert.equal(writes, 1); assert.deepEqual(facts(f.root), before);
  const another = f.request();
  assert.throws(() => service.denyStart(f.project.id, another.operationId, denial(another)), { code: 'EXECUTION_BLOCKED' });
});

test('Browser readback failure after a newly published denial preserves unknown outcome and exact rejection', async t => {
  const f = await browserOperationFixture(t); let reads = 0;
  const store = { ...f.store, inspectDecision(...args) { if (++reads === 3) throw Error('private readback'); return f.store.inspectDecision(...args); } };
  const { service, runtime } = setup(f, { store }), input = f.request();
  assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)), { writeMayHaveCommitted: true });
  assert.equal(runtime.state().blocked, true); assert.equal(runtime.state().busy, false);
  const before = facts(f.root); assert.equal(service.resolution(f.project.id, input.operationId).outcome, 'rejected');
  assert.deepEqual(facts(f.root), before);
});

test('Browser late queued admission observes a rejection and never attempts settlement or starts a runner', async t => {
  const f = await browserOperationFixture(t), gate = deferred(), base = setup(f); let starts = 0, settlements = 0;
  const { service, runtime } = setup(f, { store: { ...f.store, settleRun(...args) { settlements++; return f.store.settleRun(...args); } },
    catalog: { ...base.catalog, async withBrowserExecutionCandidate(...args) {
      await gate.promise; return base.catalog.withBrowserExecutionCandidate(...args);
    } }, runner() { starts++; } });
  const input = f.request(), promise = service.execute(f.project.id, input);
  // Simulate a competing persisted decision, below the service lease boundary.
  f.store.publishRejection({ projectId: f.project.id, request: input }, { assertCurrent: () => true });
  const before = facts(f.root); gate.resolve();
  await assert.rejects(promise, { code: 'BROWSER_START_REJECTED' }); await service.drain();
  assert.equal(starts, 0); assert.equal(settlements, 0); assert.equal(runtime.state().busy, false);
  assert.equal(runtime.state().blocked, false); assert.deepEqual(facts(f.root), before);
});

test('Browser denial rechecks generation after reserving and releases only its own unused lease', async t => {
  const f = await browserOperationFixture(t), original = createAcceptanceExecutionRuntime();
  let generationId = uid('ag', 901), writes = 0;
  const runtime = { ...original, reserve(input) { const lease = original.reserve(input); generationId = uid('ag', 902); return lease; } };
  const { service } = setup(f, { runtime,
    catalog: { read: () => ({ generationId, projects: { [f.project.id]: f.project } }) },
    store: { ...f.store, publishRejection(...args) { writes++; return f.store.publishRejection(...args); } } });
  const input = f.request(), before = facts(f.root);
  assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)), { code: 'BROWSER_OPERATION_SCOPE_UNVERIFIED' });
  assert.equal(writes, 0); assert.equal(original.state().busy, false); assert.equal(original.state().blocked, false);
  assert.deepEqual(facts(f.root), before);
});

test('Browser denial returns a newly visible persisted fact even when the reserved runtime closes', async t => {
  const f = await browserOperationFixture(t), original = createAcceptanceExecutionRuntime(), input = f.request();
  const runtime = { ...original, reserve(value) {
    const lease = original.reserve(value);
    f.store.publishRejection({ projectId: f.project.id, request: input }, { assertCurrent: () => true });
    original.close(); return lease;
  } };
  const { service } = setup(f, { runtime });
  const result = service.denyStart(f.project.id, input.operationId, denial(input));
  assert.equal(result.payload.outcome, 'rejected'); assert.deepEqual(result.payload.rejection.request, input);
  assert.equal(original.state().closing, true); assert.equal(original.state().busy, false);
  const before = facts(f.root); assert.equal(service.resolution(f.project.id, input.operationId).outcome, 'rejected');
  assert.deepEqual(facts(f.root), before);
});

test('Browser denial proof leaves the actual active runner and its cancellation signal untouched', async t => {
  const f = await browserOperationFixture(t), gate = deferred(); let starts = 0, signal;
  const { service, runtime } = setup(f, { async runner(_contract, run) {
    starts++; signal = run.signal; await gate.promise; return browserOperationRaw(f, run);
  } });
  const input = f.request();
  try {
    const accepted = await service.execute(f.project.id, input); assert.equal(accepted.status, 202);
    assert.equal(starts, 1); assert.equal(signal.aborted, false); assert.equal(runtime.state().busy, true);
    const before = facts(f.root), result = service.denyStart(f.project.id, input.operationId, denial(input));
    assert.equal(result.payload.outcome, 'recorded'); assert.equal(result.payload.operation.state, 'running');
    assert.equal(signal.aborted, false); assert.equal(runtime.state().busy, true); assert.deepEqual(facts(f.root), before);
  } finally { gate.resolve(); await service.drain(); }
  assert.equal(starts, 1); assert.equal(service.read(f.project.id, input.operationId).state, 'completed');
  assert.equal(runtime.state().busy, false); assert.equal(runtime.state().blocked, false);
});

test('Browser denial release failure reports an unknown commit while preserving the readable decision', async t => {
  const f = await browserOperationFixture(t), original = createAcceptanceExecutionRuntime();
  const runtime = { ...original, release(lease) { original.release(lease); throw Error('private release failure'); } };
  const { service } = setup(f, { runtime }), input = f.request();
  assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)), { code: 'BROWSER_EXECUTION_UNAVAILABLE', writeMayHaveCommitted: true });
  assert.equal(original.state().busy, false); assert.equal(original.state().blocked, true);
  const before = facts(f.root); assert.equal(service.resolution(f.project.id, input.operationId).outcome, 'rejected');
  assert.equal(service.denyStart(f.project.id, input.operationId, denial(input)).payload.outcome, 'rejected');
  assert.deepEqual(facts(f.root), before);
});

test('Browser accepted-only routes never reveal rejected operations across project scopes', async t => {
  const f = await browserOperationFixture(t), { service } = setup(f), input = f.request();
  service.denyStart(f.project.id, input.operationId, denial(input));
  const before = facts(f.root);
  for (const projectId of [f.project.id, uid('ap', 999)]) {
    for (const read of [() => service.read(projectId, input.operationId), () => service.report(projectId, input.operationId),
      () => service.evidence(projectId, input.operationId, 'result.png', '0'.repeat(64)),
      () => service.cancel(projectId, input.operationId, {}), () => service.registerResult(projectId, input.operationId, {})]) {
      assert.throws(read, { code: 'NOT_FOUND', status: 404 });
    }
  }
  assert.equal(service.resolution(f.project.id, input.operationId).outcome, 'rejected');
  assert.throws(() => service.resolution(uid('ap', 999), input.operationId), { code: 'NOT_FOUND', status: 404 });
  assert.deepEqual(facts(f.root), before);
});

test('Browser uncertain publication retains the unknown marker through a second lease-release failure', async t => {
  const f = await browserOperationFixture(t), original = createAcceptanceExecutionRuntime();
  const runtime = { ...original, release(lease) { original.release(lease); throw Error('private release failure'); } };
  const store = { ...f.store, publishRejection(...args) {
    f.store.publishRejection(...args); throw Object.assign(Error('private post-commit failure'), { writeMayHaveCommitted: true });
  } };
  const { service } = setup(f, { store, runtime }), input = f.request();
  assert.throws(() => service.denyStart(f.project.id, input.operationId, denial(input)),
    { code: 'BROWSER_EXECUTION_UNAVAILABLE', status: 503, writeMayHaveCommitted: true });
  assert.equal(original.state().blocked, true); assert.equal(original.state().busy, false);
  const before = facts(f.root); assert.equal(service.resolution(f.project.id, input.operationId).outcome, 'rejected');
  assert.deepEqual(facts(f.root), before);
});
