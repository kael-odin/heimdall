/** One in-process admission slot shared by legacy and managed acceptance.
 * A lease proves only local slot ownership; the caller retains owner fences.
 * Stopping, releasing, blocking admission and closing are separate decisions. */
import { types } from 'node:util';
import { fields } from './catalog-schema.mjs';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const OPERATION_ID = new RegExp(`^ao-${UUID}$`);
const RUN_ID = new RegExp(`^ac-${UUID}$`);
const TASK_ID = new RegExp(`^a-${UUID}$`);
const REASONS = new Set(['CANCELLED', 'WATCHDOG_TIMEOUT', 'WATCHDOG_STALLED', 'ENGINE_SHUTDOWN', 'ENGINE_RESTARTED', 'EXECUTION_FAILED']);
const BLOCK_CODES = new Set(['EXECUTION_BLOCKED', 'OWNER_LOST', 'PUBLICATION_UNCERTAIN', 'LEASE_LOST', 'ENGINE_SHUTDOWN', 'ENGINE_RESTARTED']);
const MESSAGES = Object.freeze({
  EXECUTION_BUSY: '已有项目验收占用执行槽，请等待结束。',
  EXECUTION_CLOSED: '项目验收执行器已关闭。',
  EXECUTION_BLOCKED: '项目验收执行器暂时无法安全接收任务。',
  EXECUTION_LEASE_INVALID: '项目验收执行令牌已失效。',
  EXECUTION_STOPPED: '项目验收执行已停止。',
  EXECUTION_INVALID_INPUT: '项目验收执行参数无效。',
  EXECUTION_HANDLER_FAILED: '项目验收停止处理未能同步完成。',
});

export class AcceptanceExecutionRuntimeError extends Error {
  constructor(code) {
    // Never reflect caller errors, reasons or identifiers in public failures.
    const safeCode = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'EXECUTION_INVALID_INPUT';
    super(MESSAGES[safeCode]);
    this.name = 'AcceptanceExecutionRuntimeError';
    this.code = safeCode;
    this.status = safeCode === 'EXECUTION_BUSY' ? 409 : 503;
  }
}
const fail = code => { throw new AcceptanceExecutionRuntimeError(code); };
const invalid = () => fail('EXECUTION_INVALID_INPUT');
const shape = (value, allowed, required) => fields(value, allowed, required, invalid);
const id = (value, pattern) => typeof value === 'string' && pattern.test(value);

// Observe ordinary native rejections without invoking arbitrary thenable or
// constructor hooks. A handler must finish synchronously; no return is awaited.
const NativePromise = Promise, promisePrototype = Promise.prototype, promiseThen = Promise.prototype.then;
const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
function consumePromise(value) {
  if (types.isPromise(value) && Object.getPrototypeOf(value) === promisePrototype
      && !Object.getOwnPropertyDescriptor(value, 'constructor')
      && Object.getOwnPropertyDescriptor(promisePrototype, 'constructor')?.value === NativePromise
      && Object.getOwnPropertyDescriptor(NativePromise, Symbol.species)?.get === species) promiseThen.call(value, undefined, () => {});
}
function synchronousHandler(value) {
  if (typeof value !== 'function' || types.isProxy(value) || types.isAsyncFunction(value) || types.isGeneratorFunction(value)) {
    consumePromise(value);
    invalid();
  }
  return value;
}

export function createAcceptanceExecutionRuntime() {
  const leases = new WeakMap();
  let current = null, closing = false, blocked = false, blockCode = null;

  function held(lease) {
    const record = leases.get(lease);
    if (!record || !record.held || current !== lease) fail('EXECUTION_LEASE_INVALID');
    return record;
  }
  function notify(record) {
    if (!record.reason || !record.onStop || record.notified) return;
    // Latch before calling user code so reentrant stop/bind cannot notify twice.
    record.notified = true;
    let result;
    try { result = record.onStop(record.reason); }
    catch (error) { consumePromise(error); fail('EXECUTION_HANDLER_FAILED'); }
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      consumePromise(result);
      fail('EXECUTION_HANDLER_FAILED');
    }
  }
  function stop(lease, reasonCode) {
    const record = held(lease);
    if (!REASONS.has(reasonCode)) invalid();
    if (record.reason) return false;
    record.reason = reasonCode;
    // Abort is observable synchronously, before any cancellation side effect.
    record.controller.abort(reasonCode);
    notify(record);
    return true;
  }

  return Object.freeze({
    reserve(input) {
      shape(input, ['kind', 'operationId'], ['kind']);
      if (!['legacy', 'managed'].includes(input.kind)
          || Object.hasOwn(input, 'operationId') && !id(input.operationId, OPERATION_ID)) invalid();
      if (closing) fail('EXECUTION_CLOSED');
      if (blocked) fail('EXECUTION_BLOCKED');
      if (current) fail('EXECUTION_BUSY');
      const lease = Object.freeze(Object.create(null));
      leases.set(lease, { held: true, kind: input.kind, runId: null, taskId: null,
        controller: new AbortController(), reason: null, onStop: null, notified: false });
      current = lease;
      return lease;
    },
    assertHeld(lease) { held(lease); return true; },
    assertActive(lease) {
      const record = held(lease);
      if (record.reason) fail('EXECUTION_STOPPED');
      if (closing) fail('EXECUTION_CLOSED');
      if (blocked) fail('EXECUTION_BLOCKED');
      return true;
    },
    signalOf(lease) { return held(lease).controller.signal; },
    stop,
    reasonOf(lease) { return held(lease).reason; },
    bind(lease, input) {
      const record = held(lease);
      shape(input, ['runId', 'taskId', 'onStop'], ['runId', 'taskId']);
      if (!id(input.runId, RUN_ID) || !id(input.taskId, TASK_ID)) invalid();
      const onStop = Object.hasOwn(input, 'onStop') ? synchronousHandler(input.onStop) : null;
      if (record.runId !== null && (record.runId !== input.runId || record.taskId !== input.taskId)
          || record.onStop && onStop && record.onStop !== onStop) invalid();
      record.runId = input.runId;
      record.taskId = input.taskId;
      if (onStop) record.onStop = onStop;
      // A cancellation can race with preparation; late binding still observes it.
      notify(record);
      return true;
    },
    release(lease) {
      const record = held(lease);
      record.held = false;
      record.onStop = null;
      current = null;
      return true;
    },
    block(code = 'EXECUTION_BLOCKED') {
      if (blocked) return false;
      blocked = true;
      blockCode = BLOCK_CODES.has(code) ? code : 'EXECUTION_BLOCKED';
      return true;
    },
    close() {
      if (closing) return false;
      closing = true;
      if (current) stop(current, 'ENGINE_SHUTDOWN');
      return true;
    },
    state() {
      const record = current ? leases.get(current) : null;
      return Object.freeze({ busy: current !== null, closing, blocked,
        code: closing ? 'EXECUTION_CLOSED' : blocked ? blockCode : record?.reason ?? null,
        kind: record?.kind ?? null, runId: record?.runId ?? null, taskId: record?.taskId ?? null });
    },
  });
}
