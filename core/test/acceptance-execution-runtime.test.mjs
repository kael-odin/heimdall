import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptanceExecutionRuntime, AcceptanceExecutionRuntimeError } from '../src/acceptance/execution-runtime.mjs';

const uuid = '00000000-0000-4000-8000-000000000001';
const operationId = `ao-${uuid}`, runId = `ac-${uuid}`, taskId = `a-${uuid}`;
const binding = { runId, taskId };
const error = (code, status = code === 'EXECUTION_BUSY' ? 409 : 503) => value => {
  assert.ok(value instanceof AcceptanceExecutionRuntimeError);
  assert.equal(value.code, code);
  assert.equal(value.status, status);
  assert.deepEqual(Object.keys(value).sort(), ['code', 'name', 'status']);
  assert.equal(value.cause, undefined);
  return true;
};
const initial = { busy: false, closing: false, blocked: false, code: null, kind: null, runId: null, taskId: null };

test('execution runtime: one opaque local lease owns the shared legacy/managed slot', () => {
  const runtime = createAcceptanceExecutionRuntime();
  assert.deepEqual(runtime.state(), initial);
  assert.ok(Object.isFrozen(runtime));
  const lease = runtime.reserve({ kind: 'legacy' });
  assert.equal(Object.getPrototypeOf(lease), null);
  assert.deepEqual(Reflect.ownKeys(lease), []);
  assert.ok(Object.isFrozen(lease));
  assert.equal(runtime.assertHeld(lease), true);
  assert.equal(runtime.assertActive(lease), true);
  assert.equal(runtime.reasonOf(lease), null);
  assert.equal(runtime.signalOf(lease).aborted, false);
  assert.deepEqual(runtime.state(), { ...initial, busy: true, kind: 'legacy' });
  assert.throws(() => runtime.reserve({ kind: 'managed', operationId }), error('EXECUTION_BUSY'));
  assert.equal(runtime.release(lease), true);
  assert.deepEqual(runtime.state(), initial);
  const managed = runtime.reserve({ kind: 'managed', operationId });
  assert.equal(runtime.state().kind, 'managed');
  assert.throws(() => runtime.reserve({ kind: 'legacy' }), error('EXECUTION_BUSY'));
  runtime.release(managed);
});

test('execution runtime: equivalent copies, proxies, primitives and foreign-runtime leases have no authority', () => {
  const runtime = createAcceptanceExecutionRuntime(), other = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' });
  const foreign = other.reserve({ kind: 'managed' });
  let traps = 0;
  const proxy = new Proxy(lease, { get() { traps++; throw Error('secret'); }, getPrototypeOf() { traps++; throw Error('secret'); } });
  for (const invalid of [{ ...lease }, Object.freeze(Object.create(null)), foreign, proxy, undefined, null, 1, 'lease', Symbol('lease')]) {
    for (const call of [() => runtime.assertHeld(invalid), () => runtime.assertActive(invalid), () => runtime.signalOf(invalid),
      () => runtime.reasonOf(invalid), () => runtime.stop(invalid, 'CANCELLED'), () => runtime.bind(invalid, binding), () => runtime.release(invalid)]) {
      assert.throws(call, error('EXECUTION_LEASE_INVALID'));
    }
  }
  assert.equal(traps, 0);
  assert.equal(runtime.assertActive(lease), true);
  runtime.release(lease); other.release(foreign);
});

test('execution runtime: release is exact and once; stale mutations cannot affect the next lease', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const old = runtime.reserve({ kind: 'legacy' });
  runtime.release(old);
  const next = runtime.reserve({ kind: 'managed' });
  const nextSignal = runtime.signalOf(next);
  for (const call of [() => runtime.release(old), () => runtime.stop(old, 'CANCELLED'), () => runtime.bind(old, binding)]) {
    assert.throws(call, error('EXECUTION_LEASE_INVALID'));
  }
  assert.equal(runtime.assertActive(next), true);
  assert.equal(nextSignal.aborted, false);
  runtime.release(next);
  assert.throws(() => runtime.release(next), error('EXECUTION_LEASE_INVALID'));
});

test('execution runtime: safe binding is visible without operation, callback, signal or lease data', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed', operationId });
  runtime.bind(lease, binding);
  const state = runtime.state();
  assert.deepEqual(state, { ...initial, busy: true, kind: 'managed', runId, taskId });
  assert.ok(Object.isFrozen(state));
  assert.equal(JSON.stringify(state).includes(operationId), false);
  assert.throws(() => { state.runId = 'secret'; }, TypeError);
  runtime.release(lease);
  assert.deepEqual(runtime.state(), initial);
  assert.equal(state.runId, runId, 'previous snapshots cannot be rewritten by release');
});

test('execution runtime: stop aborts synchronously, notifies once and keeps the first reason', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' }), signal = runtime.signalOf(lease);
  const events = [];
  signal.addEventListener('abort', () => events.push(['abort', runtime.reasonOf(lease), signal.reason]));
  const onStop = reason => {
    assert.equal(signal.aborted, true);
    assert.equal(runtime.assertHeld(lease), true);
    assert.throws(() => runtime.assertActive(lease), error('EXECUTION_STOPPED'));
    assert.equal(runtime.stop(lease, 'ENGINE_SHUTDOWN'), false, 'reentrant cancellation is inert');
    events.push(['handler', reason]);
  };
  runtime.bind(lease, { ...binding, onStop });
  assert.equal(runtime.stop(lease, 'CANCELLED'), true);
  assert.equal(runtime.stop(lease, 'WATCHDOG_TIMEOUT'), false);
  runtime.bind(lease, { ...binding, onStop });
  assert.deepEqual(events, [['abort', 'CANCELLED', 'CANCELLED'], ['handler', 'CANCELLED']]);
  assert.equal(runtime.reasonOf(lease), 'CANCELLED');
  assert.equal(runtime.state().code, 'CANCELLED');
  assert.throws(() => runtime.reserve({ kind: 'legacy' }), error('EXECUTION_BUSY'));
  assert.equal(runtime.release(lease), true, 'controlled finalization can release a stopped lease');
});

test('execution runtime: binding after stop observes it immediately and exactly once', () => {
  const runtime = createAcceptanceExecutionRuntime(), calls = [];
  const lease = runtime.reserve({ kind: 'legacy' });
  runtime.stop(lease, 'WATCHDOG_STALLED');
  const onStop = reason => calls.push(reason);
  runtime.bind(lease, binding);
  assert.deepEqual(calls, []);
  runtime.bind(lease, { ...binding, onStop });
  assert.deepEqual(calls, ['WATCHDOG_STALLED']);
  runtime.bind(lease, binding);
  runtime.bind(lease, { ...binding, onStop });
  assert.deepEqual(calls, ['WATCHDOG_STALLED']);
  assert.throws(() => runtime.bind(lease, { ...binding, onStop() {} }), error('EXECUTION_INVALID_INPUT'));
  assert.throws(() => runtime.bind(lease, { ...binding, taskId: 'a-00000000-0000-4000-8000-000000000002' }), error('EXECUTION_INVALID_INPUT'));
  assert.equal(runtime.state().taskId, taskId);
  runtime.release(lease);
});

test('execution runtime: reentrant bind cannot multiply stop side effects', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' });
  let calls = 0;
  const onStop = () => { calls++; runtime.bind(lease, { ...binding, onStop }); };
  runtime.bind(lease, { ...binding, onStop });
  runtime.stop(lease, 'CANCELLED');
  assert.equal(calls, 1);
  runtime.release(lease);
});

test('execution runtime: stop handlers may finalize their own lease without releasing a replacement', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'legacy' });
  let next;
  runtime.bind(lease, { ...binding, onStop() { runtime.release(lease); next = runtime.reserve({ kind: 'managed' }); } });
  assert.equal(runtime.stop(lease, 'CANCELLED'), true);
  assert.equal(runtime.assertActive(next), true);
  assert.equal(runtime.signalOf(next).aborted, false);
  assert.throws(() => runtime.release(lease), error('EXECUTION_LEASE_INVALID'));
  runtime.release(next);
});

test('execution runtime: block is sticky, independent of slot accounting and does not fabricate cancellation', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' }), signal = runtime.signalOf(lease);
  assert.equal(runtime.block('OWNER_LOST'), true);
  assert.equal(runtime.block('PUBLICATION_UNCERTAIN'), false);
  assert.equal(runtime.state().code, 'OWNER_LOST');
  assert.equal(runtime.state().busy, true);
  assert.equal(signal.aborted, false);
  assert.equal(runtime.reasonOf(lease), null);
  assert.equal(runtime.assertHeld(lease), true);
  assert.throws(() => runtime.assertActive(lease), error('EXECUTION_BLOCKED'));
  runtime.release(lease);
  assert.deepEqual(runtime.state(), { ...initial, blocked: true, code: 'OWNER_LOST' });
  assert.throws(() => runtime.reserve({ kind: 'legacy' }), error('EXECUTION_BLOCKED'));
});

test('execution runtime: blocking an idle runtime and unknown codes yields only safe state', () => {
  for (const value of [undefined, 'raw secret /path?token=secret', null, {}, Symbol('secret')]) {
    const runtime = createAcceptanceExecutionRuntime();
    runtime.block(value);
    assert.deepEqual(runtime.state(), { ...initial, blocked: true, code: 'EXECUTION_BLOCKED' });
    assert.throws(() => runtime.reserve({ kind: 'managed' }), error('EXECUTION_BLOCKED'));
  }
});

test('execution runtime: close stops the current task, preserves its lease and permanently closes admission', () => {
  const runtime = createAcceptanceExecutionRuntime(), calls = [];
  const lease = runtime.reserve({ kind: 'managed' }), signal = runtime.signalOf(lease);
  runtime.bind(lease, { ...binding, onStop: reason => calls.push(reason) });
  assert.equal(runtime.close(), true);
  assert.equal(runtime.close(), false);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, 'ENGINE_SHUTDOWN');
  assert.equal(runtime.reasonOf(lease), 'ENGINE_SHUTDOWN');
  assert.equal(runtime.assertHeld(lease), true);
  assert.throws(() => runtime.assertActive(lease), error('EXECUTION_STOPPED'));
  assert.deepEqual(calls, ['ENGINE_SHUTDOWN']);
  assert.deepEqual(runtime.state(), { ...initial, busy: true, closing: true, code: 'EXECUTION_CLOSED', kind: 'managed', runId, taskId });
  runtime.release(lease);
  assert.deepEqual(runtime.state(), { ...initial, closing: true, code: 'EXECUTION_CLOSED' });
  assert.throws(() => runtime.reserve({ kind: 'legacy' }), error('EXECUTION_CLOSED'));
});

test('execution runtime: close is safe when idle or blocked and never replaces a first stop reason', () => {
  const idle = createAcceptanceExecutionRuntime();
  idle.close();
  assert.deepEqual(idle.state(), { ...initial, closing: true, code: 'EXECUTION_CLOSED' });
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'legacy' });
  runtime.stop(lease, 'WATCHDOG_TIMEOUT');
  runtime.block();
  runtime.close();
  assert.equal(runtime.reasonOf(lease), 'WATCHDOG_TIMEOUT');
  assert.equal(runtime.signalOf(lease).reason, 'WATCHDOG_TIMEOUT');
  runtime.release(lease);
  assert.equal(runtime.state().blocked, true);
  assert.equal(runtime.state().closing, true);
  assert.throws(() => runtime.reserve({ kind: 'managed' }), error('EXECUTION_CLOSED'));
});

test('execution runtime: invalid stop reasons cannot stop an active task or leak caller data', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' });
  for (const reason of [undefined, 'raw secret', new Error('raw secret'), {}, null]) {
    assert.throws(() => runtime.stop(lease, reason), error('EXECUTION_INVALID_INPUT'));
    assert.equal(runtime.assertActive(lease), true);
    assert.equal(runtime.signalOf(lease).aborted, false);
  }
  runtime.release(lease);
});

test('execution runtime: reserve rejects unknown, unsafe or accessor fields without executing hooks', () => {
  const runtime = createAcceptanceExecutionRuntime();
  let hooks = 0;
  const accessor = { get kind() { hooks++; return 'legacy'; } };
  const proxy = new Proxy({ kind: 'legacy' }, { getPrototypeOf() { hooks++; throw Error('secret'); } });
  const hidden = Object.defineProperty({ kind: 'legacy' }, 'operationId', { value: operationId });
  const symbol = { kind: 'legacy', [Symbol('secret')]: true };
  for (const input of [undefined, null, [], 'legacy', {}, { kind: 'other' }, { kind: 'managed', operationId: 'ao-SECRET' },
    { kind: 'legacy', operationId: operationId.toUpperCase() }, { kind: 'legacy', owner: {} }, accessor, proxy, hidden, symbol]) {
    assert.throws(() => runtime.reserve(input), error('EXECUTION_INVALID_INPUT'));
    assert.deepEqual(runtime.state(), initial);
  }
  assert.equal(hooks, 0);
});

test('execution runtime: binding validates descriptors and fixed identifiers before changing state', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' });
  let hooks = 0;
  const getter = { ...binding, get onStop() { hooks++; return () => {}; } };
  const proxy = new Proxy(binding, { ownKeys() { hooks++; throw Error('secret'); } });
  for (const input of [undefined, null, {}, { runId }, { ...binding, runId: '../secret' }, { ...binding, taskId: 'a-secret' },
    { ...binding, extra: true }, { ...binding, onStop: undefined }, getter, proxy]) {
    assert.throws(() => runtime.bind(lease, input), error('EXECUTION_INVALID_INPUT'));
    assert.equal(runtime.state().runId, null);
  }
  assert.equal(hooks, 0);
  runtime.bind(lease, binding);
  assert.throws(() => runtime.bind(lease, { ...binding, runId: 'ac-00000000-0000-4000-8000-000000000002' }), error('EXECUTION_INVALID_INPUT'));
  assert.equal(runtime.state().runId, runId);
  runtime.release(lease);
});

test('execution runtime: async, generator and proxy handlers are rejected before being called', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' });
  let calls = 0;
  const handlers = [async () => { calls++; }, function* () { calls++; }, async function* () { calls++; },
    new Proxy(() => { calls++; }, { apply() { calls++; throw Error('secret'); } })];
  for (const onStop of handlers) assert.throws(() => runtime.bind(lease, { ...binding, onStop }), error('EXECUTION_INVALID_INPUT'));
  assert.equal(calls, 0);
  assert.equal(runtime.state().runId, null);
  runtime.stop(lease, 'CANCELLED');
  runtime.release(lease);
});

test('execution runtime: thrown handler details are replaced after abort and are never retried', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'managed' });
  let calls = 0, reads = 0;
  const thrown = { get message() { reads++; return 'secret'; }, get cause() { reads++; return 'secret'; } };
  const onStop = () => { calls++; throw thrown; };
  runtime.bind(lease, { ...binding, onStop });
  assert.throws(() => runtime.stop(lease, 'EXECUTION_FAILED'), error('EXECUTION_HANDLER_FAILED'));
  assert.equal(runtime.signalOf(lease).aborted, true);
  assert.equal(runtime.reasonOf(lease), 'EXECUTION_FAILED');
  assert.equal(runtime.stop(lease, 'CANCELLED'), false);
  runtime.bind(lease, { ...binding, onStop });
  assert.equal(calls, 1);
  assert.equal(reads, 0);
  runtime.release(lease);
});

test('execution runtime: a late failing handler is sanitized without undoing stopped binding', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'legacy' });
  runtime.stop(lease, 'CANCELLED');
  const onStop = () => { throw Error('secret /path?token=secret'); };
  assert.throws(() => runtime.bind(lease, { ...binding, onStop }), error('EXECUTION_HANDLER_FAILED'));
  assert.equal(runtime.state().runId, runId);
  assert.equal(runtime.reasonOf(lease), 'CANCELLED');
  assert.equal(runtime.bind(lease, { ...binding, onStop }), true);
  runtime.release(lease);
});

test('execution runtime: close remains latched after a failing handler', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'legacy' });
  runtime.bind(lease, { ...binding, onStop() { throw Error('secret'); } });
  assert.throws(() => runtime.close(), error('EXECUTION_HANDLER_FAILED'));
  assert.equal(runtime.state().closing, true);
  assert.equal(runtime.signalOf(lease).reason, 'ENGINE_SHUTDOWN');
  assert.equal(runtime.close(), false);
  runtime.release(lease);
  assert.throws(() => runtime.reserve({ kind: 'managed' }), error('EXECUTION_CLOSED'));
});

test('execution runtime: returned thenables are rejected without getters or Promise assimilation', () => {
  for (const makeValue of [() => ({ get then() { throw Error('must not read'); } }),
    () => new Proxy({}, { get() { throw Error('must not read'); }, getPrototypeOf() { throw Error('must not read'); } }),
    () => () => {}]) {
    const runtime = createAcceptanceExecutionRuntime();
    const lease = runtime.reserve({ kind: 'managed' });
    runtime.bind(lease, { ...binding, onStop: makeValue });
    assert.throws(() => runtime.stop(lease, 'CANCELLED'), error('EXECUTION_HANDLER_FAILED'));
    assert.equal(runtime.reasonOf(lease), 'CANCELLED');
    runtime.release(lease);
  }
});

test('execution runtime: ordinary rejected Promises returned, thrown or passed as handlers are safely observed', async () => {
  for (const mode of ['return', 'throw', 'input']) {
    const runtime = createAcceptanceExecutionRuntime();
    const lease = runtime.reserve({ kind: 'managed' });
    const promise = Promise.reject(Error('secret'));
    if (mode === 'input') {
      assert.throws(() => runtime.bind(lease, { ...binding, onStop: promise }), error('EXECUTION_INVALID_INPUT'));
    } else {
      const onStop = () => { if (mode === 'throw') throw promise; return promise; };
      runtime.bind(lease, { ...binding, onStop });
      assert.throws(() => runtime.stop(lease, 'CANCELLED'), error('EXECUTION_HANDLER_FAILED'));
      assert.equal(runtime.signalOf(lease).aborted, true);
    }
    runtime.release(lease);
  }
  await new Promise(resolve => setImmediate(resolve));
});
