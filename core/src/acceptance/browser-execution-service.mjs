/** Fresh single-operation approval, target-only execution and durable queries. */
import { assertAcceptanceOwner } from './owner.mjs';
import { types } from 'node:util';
import { AcceptanceCatalogError, fields, id } from './catalog-schema.mjs';
import { createBrowserOperationStore } from './browser-operation-store.mjs';
import { validateBrowserOperationRequest, browserOperationRequestFingerprint, isBrowserOperationId } from './browser-operation-schema.mjs';
import { runFixedBrowserAcceptance } from './browser-fixed-runner.mjs';

const fail = (code = 'BROWSER_EXECUTION_UNAVAILABLE', status = 503) => {
  throw new AcceptanceCatalogError(code, status, code === 'NOT_FOUND' ? 'Browser 操作不存在。'
    : code === 'INVALID_INPUT' ? 'Browser 执行参数无效。' : 'Browser 执行暂不可用；原记录已保留。');
};
const NativePromise = Promise, promisePrototype = Promise.prototype, promiseThen = Promise.prototype.then;
const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
function consumePromise(value) {
  if (types.isPromise(value) && Object.getPrototypeOf(value) === promisePrototype
      && !Object.getOwnPropertyDescriptor(value, 'constructor')
      && Object.getOwnPropertyDescriptor(promisePrototype, 'constructor')?.value === NativePromise
      && Object.getOwnPropertyDescriptor(NativePromise, Symbol.species)?.get === species) promiseThen.call(value, undefined, () => {});
}
const synchronous = value => typeof value === 'function' && !types.isProxy(value)
  && !types.isAsyncFunction(value) && !types.isGeneratorFunction(value);

export function createBrowserExecutionService({ owner, catalog, runtime, assertReady = () => true,
  store = createBrowserOperationStore({ owner }), runner = runFixedBrowserAcceptance } = {}) {
  assertAcceptanceOwner(owner);
  const pending = new Map(), handles = new Map();
  let recoveryReady = false;
  const owned = () => assertAcceptanceOwner(owner);
  const checkReady = () => {
    if (!synchronous(assertReady)) { consumePromise(assertReady); fail(); }
    let result;
    try { result = assertReady(); } catch (cause) { consumePromise(cause); fail(); }
    if (result !== true) { consumePromise(result); fail(); }
  };
  const ready = () => {
    owned();
    if (!recoveryReady) fail();
    checkReady();
    owned(); return true;
  };
  function operation(projectId, operationId) {
    owned(); id(projectId, 'ap');
    if (!isBrowserOperationId(operationId)) fail('INVALID_INPUT', 400);
    const value = store.read(operationId);
    if (!value || value.record.envelope.project.id !== projectId) fail('NOT_FOUND', 404);
    return value;
  }
  function view(value) {
    const e = value.record.envelope, h = value.head;
    return { schemaVersion: 1, operationId: e.operationId, runId: e.runId, taskId: e.taskId,
      projectId: e.project.id, candidateId: e.candidate.id, contentDigest: e.candidate.contentDigest,
      targetReleaseId: e.targetRelease.id, targetLabel: e.targetRelease.label,
      approvalScope: 'single-operation', state: value.state, acceptedAt: e.acceptedAt,
      updatedAt: h?.updatedAt ?? e.acceptedAt, gate: h?.gate ?? null,
      reportSha256: h?.reportSha256 ?? null, reasonCode: h?.reasonCode ?? null,
      summary: value.report?.summary ?? null, executionReady: false };
  }
  function read(projectId, operationId) { return view(operation(projectId, operationId)); }
  function capability() {
    owned(); const state = runtime.state();
    let available = false;
    try { if (recoveryReady) { checkReady(); available = true; } } catch { /* Safe capability only. */ }
    owned();
    return { enabled: true, ready: available && !state.busy && !state.blocked && !state.closing,
      recoveryReady, ...state, approvalScope: 'single-operation', baselineNetworkRequests: false };
  }
  function list(projectId) {
    owned(); id(projectId, 'ap');
    if (!catalog.read().projects[projectId]) fail('NOT_FOUND', 404);
    return { schemaVersion: 1, projectId, operations: store.list(projectId).map(view), capability: capability() };
  }
  function report(projectId, operationId) {
    const value = operation(projectId, operationId);
    if (value.state !== 'completed' || !value.report) fail('RESULT_NOT_COMPLETED', 409);
    return { ...view(value), report: value.report };
  }
  function evidence(projectId, operationId, file, expectedSha256) {
    operation(projectId, operationId);
    const captured = store.readEvidence(operationId, file);
    if (captured.sha256 !== expectedSha256) fail('BASELINE_CHANGED', 409);
    return captured;
  }
  function execute(projectId, raw) {
    try {
      owned(); id(projectId, 'ap');
      const input = validateBrowserOperationRequest(raw), operationId = input.operationId;
      const fingerprint = browserOperationRequestFingerprint({ projectId, ...input });
      const existing = store.read(operationId);
      if (existing) {
        if (existing.record.envelope.requestFingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409);
        return Promise.resolve({ status: 200, payload: { ...view(existing), replayed: true } });
      }
      const waiting = pending.get(operationId);
      if (waiting) {
        if (waiting.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409);
        return waiting.promise.then(result => ({ status: 200, payload: { ...result.payload, replayed: true } }));
      }
      ready();
      const lease = runtime.reserve({ kind: 'browser', operationId });
      const active = () => { ready(); return runtime.assertActive(lease); };
      const held = () => { owned(); return runtime.assertHeld(lease); };
      let transferred = false;
      const promise = (async () => {
        try {
          const prepared = await catalog.withBrowserExecutionCandidate(projectId, input, {
            assertAdmission: active, publish: (context, options) => store.publish(context, options),
          });
          active();
          if (prepared.replayed) return { status: 200, payload: { ...read(projectId, operationId), replayed: true } };
          const e = prepared.record.envelope;
          runtime.bind(lease, { runId: e.runId, taskId: e.taskId });
          active(); const run = store.createRun(operationId, { assertActive: active }); active();
          const watchdog = setTimeout(() => { try { runtime.stop(lease, 'WATCHDOG_TIMEOUT'); } catch { /* Lease ended. */ } }, 300_000);
          watchdog.unref();
          const handle = { lease, finished: null };
          handles.set(operationId, handle); transferred = true;
          const finished = (async () => {
            try {
              const rawReport = await runner(prepared.contract, { runId: e.runId, outputDir: run.outputDir,
                sourceFiles: prepared.sourceFiles, signal: runtime.signalOf(lease), assertActive: active });
              active(); store.finishRun(operationId, rawReport, { assertActive: active });
            } catch (cause) {
              try {
                held();
                const current = store.read(operationId);
                if (current?.state === 'running') {
                  const reason = runtime.reasonOf(lease);
                  store.settleRun(operationId, { status: reason ? 'interrupted' : 'failed',
                    reasonCode: reason ?? 'EXECUTION_FAILED' }, { assertHeld: held });
                }
              } catch { runtime.block('PUBLICATION_UNCERTAIN'); }
              if (cause?.writeMayHaveCommitted === true) runtime.block('PUBLICATION_UNCERTAIN');
            } finally {
              clearTimeout(watchdog);
              try { runtime.release(lease); } catch { runtime.block('LEASE_LOST'); }
              handles.delete(operationId);
            }
          })();
          handle.finished = finished;
          finished.catch(() => { runtime.block(); });
          return { status: 202, payload: { ...read(projectId, operationId), replayed: false } };
        } catch (cause) {
          if (cause?.writeMayHaveCommitted === true) runtime.block('PUBLICATION_UNCERTAIN');
          if (!transferred) {
            try {
              held();
              if (store.read(operationId)?.state === 'running') store.settleRun(operationId,
                { status: 'interrupted', reasonCode: runtime.reasonOf(lease) ?? 'EXECUTION_FAILED' }, { assertHeld: held });
            } catch { runtime.block('PUBLICATION_UNCERTAIN'); }
          }
          throw cause;
        } finally {
          if (!transferred) try { runtime.release(lease); } catch { /* Exact lease was already released. */ }
        }
      })();
      const tracked = promise.finally(() => { if (pending.get(operationId)?.promise === tracked) pending.delete(operationId); });
      pending.set(operationId, { fingerprint, promise: tracked });
      return tracked;
    } catch (cause) { return Promise.reject(cause); }
  }
  function cancel(projectId, operationId, input) {
    fields(input, [], [], () => fail('INVALID_INPUT', 400));
    const value = operation(projectId, operationId), handle = handles.get(operationId);
    if (handle) runtime.stop(handle.lease, 'CANCELLED');
    return { ...view(value), stopRequested: !!handle };
  }
  function registerResult(projectId, operationId, input) {
    ready();
    operation(projectId, operationId);
    fields(input, ['beforeOperationId'], [], () => fail('INVALID_INPUT', 400));
    if (input.beforeOperationId !== undefined) operation(projectId, input.beforeOperationId);
    return store.registerResult(operationId, input);
  }
  function ledger(projectId) {
    owned(); id(projectId, 'ap');
    if (!catalog.read().projects[projectId]) fail('NOT_FOUND', 404);
    return store.ledger(projectId);
  }
  function recover() {
    owned(); recoveryReady = false;
    if (runtime.state().busy) fail();
    checkReady(); owned();
    const result = store.recover(); owned(); recoveryReady = true; return result;
  }
  async function drain() {
    await Promise.allSettled([...pending.values()].map(value => value.promise));
    await Promise.allSettled([...handles.values()].map(value => value.finished));
  }
  return Object.freeze({ execute, list, read, report, evidence, cancel, registerResult, ledger, capability, recover, drain });
}
