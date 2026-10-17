import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserExecutionService } from '../src/acceptance/browser-execution-service.mjs';
import { createAcceptanceExecutionRuntime } from '../src/acceptance/execution-runtime.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { uid } from './fixtures/acceptance-browser-organized-candidate.mjs';
import { facts } from '../scripts/fixtures/managed-execution.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function serviceOf(f, options = {}) {
  const runtime = options.runtime ?? createAcceptanceExecutionRuntime();
  const catalog = { read: () => ({ projects: { [f.project.id]: f.project } }),
    async withBrowserExecutionCandidate(projectId, request, { assertAdmission, publish }) {
      assert.equal(projectId, f.project.id); assertAdmission();
      const result = publish({ ...f, request }, { assertCurrent: assertAdmission });
      return { ...result, contract: f.contract, sourceFiles: f.sourceFiles };
    } };
  const service = createBrowserExecutionService({ owner: f.owner, catalog, runtime, store: f.store,
    runner: (_contract, run) => browserOperationRaw(f, run, { bug: true }), ...options });
  service.recover();
  return { runtime, service, catalog };
}

test('Browser service: fresh approval runs once and complete BUG facts survive replay and restart', async t => {
  const f = await browserOperationFixture(t); let starts = 0;
  const { service, runtime } = serviceOf(f, { runner(contract, run) {
    starts++; assert.equal(contract, f.contract); assert.equal(run.assertActive(), true);
    return browserOperationRaw(f, run, { bug: true });
  } });
  const input = f.request(), before = facts(f.root), result = await service.execute(f.project.id, input);
  assert.equal(result.status, 202); assert.equal(result.payload.replayed, false);
  await service.drain();
  const complete = service.read(f.project.id, input.operationId);
  assert.equal(complete.state, 'completed'); assert.equal(complete.gate, 'failed');
  assert.equal(complete.summary.bugs, 1); assert.match(complete.runId, /^br-/); assert.match(complete.taskId, /^a-/);
  assert.equal(runtime.state().busy, false); assert.equal(starts, 1); assert.notDeepEqual(facts(f.root), before);
  const record = service.registerResult(f.project.id, input.operationId, {});
  assert.equal(record.replayed, false); assert.equal(record.observations.length, 1);
  assert.equal(service.registerResult(f.project.id, input.operationId, {}).replayed, true);
  const persisted = facts(f.root), restarted = serviceOf(f, { runner() { throw Error('must never restart'); } }).service;
  assert.equal((await restarted.execute(f.project.id, input)).payload.replayed, true);
  assert.deepEqual(restarted.read(f.project.id, input.operationId), complete);
  assert.equal(restarted.ledger(f.project.id).entries.length, 1); assert.deepEqual(facts(f.root), persisted);
  assert.equal(service.report(f.project.id, input.operationId).report.mode, 'browser-fixed');
});

test('Browser service: concurrent duplicate confirmations share admission; conflicts precede busy', async t => {
  const f = await browserOperationFixture(t), gate = deferred(); let prepares = 0, starts = 0;
  const base = serviceOf(f), catalog = { ...base.catalog, async withBrowserExecutionCandidate(...args) {
    prepares++; await gate.promise; return base.catalog.withBrowserExecutionCandidate(...args);
  } };
  const { service, runtime } = serviceOf(f, { catalog, runner(_contract, run) { starts++; return browserOperationRaw(f, run); } });
  const input = f.request(), first = service.execute(f.project.id, input), duplicate = service.execute(f.project.id, { ...input });
  await assert.rejects(service.execute(f.project.id, { ...input, expectedRevision: 5 }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(service.execute(f.project.id, f.request()), { code: 'EXECUTION_BUSY' });
  assert.equal(prepares, 1); assert.equal(starts, 0); assert.equal(runtime.state().busy, true);
  gate.resolve(); const [fresh, replay] = await Promise.all([first, duplicate]); await service.drain();
  assert.equal(fresh.status, 202); assert.equal(replay.status, 200); assert.equal(replay.payload.replayed, true);
  assert.equal(fresh.payload.runId, replay.payload.runId); assert.equal(starts, 1); assert.equal(runtime.state().busy, false);
});

test('Browser service: prepared historical approval is read before readiness, source material and shared busy state', async t => {
  const f = await browserOperationFixture(t), input = f.request(); f.publish(input, { assertCurrent: () => true });
  const { service, runtime } = serviceOf(f, { catalog: {
    read() { throw Error('private catalog missing'); }, withBrowserExecutionCandidate() { throw Error('must not prepare'); },
  } });
  f.material.files.clear(); const legacy = runtime.reserve({ kind: 'legacy' }), before = facts(f.root);
  const replay = await service.execute(f.project.id, input);
  assert.equal(replay.status, 200); assert.equal(replay.payload.state, 'prepared'); assert.equal(replay.payload.replayed, true);
  assert.deepEqual(facts(f.root), before); assert.equal(runtime.assertActive(legacy), true); runtime.release(legacy);
  const restarted = createBrowserExecutionService({ owner: f.owner, runtime, store: f.store, catalog: {}, assertReady: () => false });
  assert.equal((await restarted.execute(f.project.id, input)).payload.state, 'prepared');
  await assert.rejects(restarted.execute(f.project.id, f.request()), { code: 'BROWSER_EXECUTION_UNAVAILABLE' });
});

test('Browser service: unknown dispatch publication blocks fresh admission and never starts a saved preparation', async t => {
  const f = await browserOperationFixture(t); let starts = 0;
  const store = { ...f.store, publish(...args) {
    f.store.publish(...args); throw Object.assign(Error('private publish failure'), { writeMayHaveCommitted: true });
  } };
  const { service, runtime } = serviceOf(f, { store, runner() { starts++; throw Error('must not start'); } });
  const input = f.request(); await assert.rejects(service.execute(f.project.id, input), { writeMayHaveCommitted: true });
  assert.equal(runtime.state().blocked, true); assert.equal(runtime.state().busy, false);
  const saved = facts(f.root), replay = await service.execute(f.project.id, input);
  assert.equal(replay.payload.state, 'prepared'); assert.equal(starts, 0); assert.deepEqual(facts(f.root), saved);
  await assert.rejects(service.execute(f.project.id, f.request()), { code: 'EXECUTION_BLOCKED' });
});

test('Browser service: closing queued admission cannot publish or start any operation', async t => {
  const f = await browserOperationFixture(t), gate = deferred(), base = serviceOf(f); let starts = 0;
  const { service, runtime } = serviceOf(f, { catalog: { ...base.catalog, async withBrowserExecutionCandidate(...args) {
    await gate.promise; return base.catalog.withBrowserExecutionCandidate(...args);
  } }, runner() { starts++; } });
  const before = facts(f.root), running = service.execute(f.project.id, f.request()); runtime.close(); gate.resolve();
  await assert.rejects(running, { code: 'EXECUTION_STOPPED' }); await service.drain();
  assert.equal(starts, 0); assert.deepEqual(facts(f.root), before); assert.equal(runtime.state().busy, false);
});

test('Browser service: cancellation signals the running worker and preserves a terminal interrupted operation', async t => {
  const f = await browserOperationFixture(t); let seenSignal;
  const { service, runtime } = serviceOf(f, { runner(_contract, run) {
    seenSignal = run.signal;
    return new Promise((_resolve, reject) => run.signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }));
  } });
  const input = f.request(); await service.execute(f.project.id, input);
  assert.equal(service.cancel(f.project.id, input.operationId, {}).stopRequested, true);
  assert.equal(seenSignal.aborted, true); await service.drain();
  const result = service.read(f.project.id, input.operationId);
  assert.equal(result.state, 'interrupted'); assert.equal(result.reasonCode, 'CANCELLED');
  assert.equal(runtime.state().busy, false); assert.equal(service.cancel(f.project.id, input.operationId, {}).stopRequested, false);
  assert.throws(() => service.report(f.project.id, input.operationId), { code: 'RESULT_NOT_COMPLETED' });
});

test('Browser service: sync runner failure settles once and releases its handle and shared lease', async t => {
  const f = await browserOperationFixture(t); let starts = 0;
  const { service, runtime } = serviceOf(f, { runner() { starts++; throw Error('private runner path'); } });
  const input = f.request(); await service.execute(f.project.id, input); await service.drain();
  assert.equal(service.read(f.project.id, input.operationId).state, 'failed'); assert.equal(runtime.state().busy, false);
  assert.equal(service.cancel(f.project.id, input.operationId, {}).stopRequested, false);
  assert.equal((await service.execute(f.project.id, input)).payload.replayed, true); assert.equal(starts, 1);
});

test('Browser service: owner loss after start fences completion, retains bytes and blocks admission', async t => {
  const f = await browserOperationFixture(t), gate = deferred();
  const { service, runtime } = serviceOf(f, { async runner(_contract, run) { await gate.promise; return browserOperationRaw(f, run); } });
  const input = f.request(); await service.execute(f.project.id, input);
  const lock = join(f.root, '.acceptance-owner.json'), original = readFileSync(lock); renameSync(lock, lock + '.saved');
  gate.resolve(); await service.drain();
  assert.equal(runtime.state().busy, false); assert.equal(runtime.state().blocked, true);
  assert.throws(() => service.read(f.project.id, input.operationId), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.deepEqual(readFileSync(lock + '.saved'), original); assert.equal(existsSync(lock), false);
  renameSync(lock + '.saved', lock);
  assert.equal(service.read(f.project.id, input.operationId).state, 'running', 'lost owner cannot rewrite the head');
  assert.equal(service.recover().interrupted, 1); assert.equal(service.read(f.project.id, input.operationId).reasonCode, 'ENGINE_RESTARTED');
});

test('Browser service: strict request and project isolation reject mixed old identifiers and foreign access', async t => {
  const f = await browserOperationFixture(t), { service } = serviceOf(f), input = f.request();
  for (const patch of [{ operationId: uid('ao', 4) }, { candidateId: uid('ab', 5) }, { sourceUrl: 'https://private.invalid' }, { expectedRevision: 1.1 }]) {
    await assert.rejects(service.execute(f.project.id, { ...input, ...patch }), { code: 'INVALID_INPUT' });
  }
  await service.execute(f.project.id, input); await service.drain();
  const foreign = uid('ap', 999);
  for (const access of [() => service.read(foreign, input.operationId), () => service.report(foreign, input.operationId),
    () => service.evidence(foreign, input.operationId, 'anything.png', 'a'.repeat(64)),
    () => service.cancel(foreign, input.operationId, {}), () => service.registerResult(foreign, input.operationId, {}),
    () => service.ledger(foreign), () => service.list(foreign)]) assert.throws(access, { code: 'NOT_FOUND' });
});

test('Browser service: synchronous readiness rejects callable hooks and async results without invoking thenable hooks', async t => {
  const f = await browserOperationFixture(t); let hooks = 0;
  const thenable = { get then() { hooks++; throw Error('private then'); } };
  for (const assertReady of [async () => { hooks++; }, function* () { hooks++; }, new Proxy(() => true, { apply() { hooks++; } }),
    () => thenable, () => Promise.reject(Error('discarded rejection')), () => { throw Promise.reject(Error('discarded thrown rejection')); }, () => undefined, () => false]) {
    const runtime = createAcceptanceExecutionRuntime();
    const service = createBrowserExecutionService({ owner: f.owner, catalog: {}, store: f.store, runtime, assertReady });
    assert.throws(() => service.recover(), { code: 'BROWSER_EXECUTION_UNAVAILABLE' });
    assert.equal(service.capability().ready, false);
    await assert.rejects(service.execute(f.project.id, f.request()), { code: 'BROWSER_EXECUTION_UNAVAILABLE' });
    assert.equal(runtime.state().busy, false);
  }
  await new Promise(resolve => setImmediate(resolve)); assert.equal(hooks, 0);
});
