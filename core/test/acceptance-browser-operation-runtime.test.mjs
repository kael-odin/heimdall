import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptanceExecutionRuntime } from '../src/acceptance/execution-runtime.mjs';

const uuid = '00000000-0000-4000-8000-000000000001';
const operationId = `bo-${uuid}`, runId = `br-${uuid}`, taskId = `a-${uuid}`;

test('Browser operations share the existing admission slot and cancellation lifecycle', () => {
  const runtime = createAcceptanceExecutionRuntime();
  const lease = runtime.reserve({ kind: 'browser', operationId });
  assert.throws(() => runtime.reserve({ kind: 'legacy' }), { code: 'EXECUTION_BUSY' });
  assert.throws(() => runtime.reserve({ kind: 'managed' }), { code: 'EXECUTION_BUSY' });
  runtime.bind(lease, { runId, taskId });
  assert.equal(runtime.state().kind, 'browser');
  assert.equal(runtime.state().runId, runId);
  const signal = runtime.signalOf(lease);
  assert.equal(runtime.stop(lease, 'CANCELLED'), true);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, 'CANCELLED');
  assert.throws(() => runtime.assertActive(lease), { code: 'EXECUTION_STOPPED' });
  runtime.release(lease);
  const next = runtime.reserve({ kind: 'managed' });
  runtime.release(next);
});

test('Browser identifiers do not broaden the Spec and legacy namespaces', () => {
  const runtime = createAcceptanceExecutionRuntime();
  for (const kind of ['managed', 'legacy']) {
    assert.throws(() => runtime.reserve({ kind, operationId }), { code: 'EXECUTION_INVALID_INPUT' });
    const lease = runtime.reserve({ kind });
    assert.throws(() => runtime.bind(lease, { runId, taskId }), { code: 'EXECUTION_INVALID_INPUT' });
    runtime.release(lease);
  }
  assert.throws(() => runtime.reserve({ kind: 'browser' }), { code: 'EXECUTION_INVALID_INPUT' });
  assert.throws(() => runtime.reserve({ kind: 'browser', operationId: `ao-${uuid}` }), { code: 'EXECUTION_INVALID_INPUT' });
  const lease = runtime.reserve({ kind: 'browser', operationId });
  assert.throws(() => runtime.bind(lease, { runId: `ac-${uuid}`, taskId }), { code: 'EXECUTION_INVALID_INPUT' });
  runtime.release(lease);
});
