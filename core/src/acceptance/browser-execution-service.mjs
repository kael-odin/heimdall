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
    const decision = inspect(projectId, operationId);
    if (decision.kind !== 'recorded') fail('NOT_FOUND', 404);
    return decision.value;
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
  function inspect(projectId, operationId) {
    owned(); id(projectId, 'ap');
    if (!isBrowserOperationId(operationId)) fail('INVALID_INPUT', 400);
    const decision = store.inspectDecision(operationId);
    if (decision.kind === 'recorded' && decision.value.record.envelope.project.id !== projectId
        || decision.kind === 'rejected' && decision.record.envelope.projectId !== projectId) fail('NOT_FOUND', 404);
    owned(); return decision;
  }
  function proof(projectId, operationId, decision) {
    const result = { schemaVersion: 1, kind: 'browser-start-resolution', projectId, operationId,
      observedAt: new Date().toISOString(), outcome: decision.kind };
    if (decision.kind === 'recorded') {
      const value = decision.value, e = value.record.envelope;
      Object.assign(result, { request: e.request, requestFingerprint: e.requestFingerprint,
        dispatchSha256: value.record.sha256, operation: view(value) });
    } else if (decision.kind === 'rejected') {
      Object.assign(result, { rejection: decision.record.envelope, rejectionSha256: decision.record.sha256 });
    } else fail();
    owned(); return result;
  }
  function matching(projectId, input, decision) {
    if (decision.kind === 'absent') return false;
    const e = decision.kind === 'recorded' ? decision.value.record.envelope : decision.record.envelope;
    const scope = decision.kind === 'recorded' ? e.project.id : e.projectId;
    if (scope !== projectId) fail('NOT_FOUND', 404);
    if (e.requestFingerprint !== browserOperationRequestFingerprint({ projectId, ...input })) fail('IDEMPOTENCY_CONFLICT', 409);
    return true;
  }
  function inFlight(projectId, operationId, fingerprint) {
    const value = pending.get(operationId) ?? handles.get(operationId);
    if (!value) return false;
    if (value.projectId !== projectId) fail('NOT_FOUND', 404);
    if (fingerprint !== undefined && value.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409);
    return true;
  }
  function resolution(projectId, operationId) {
    const decision = inspect(projectId, operationId);
    if (decision.kind !== 'absent') return proof(projectId, operationId, decision);
    const waiting = inFlight(projectId, operationId);
    if (!catalog.read().projects[projectId]) fail('NOT_FOUND', 404);
    owned();
    return { schemaVersion: 1, kind: 'browser-start-resolution', projectId, operationId,
      observedAt: new Date().toISOString(), outcome: 'unresolved',
      reasonCode: waiting ? 'ADMISSION_PENDING' : 'ABSENT_OBSERVED' };
  }
  function denyStart(projectId, operationId, raw) {
    owned(); id(projectId, 'ap');
    if (!isBrowserOperationId(operationId)) fail('INVALID_INPUT', 400);
    fields(raw, ['action', 'request'], ['action', 'request'], () => fail('INVALID_INPUT', 400));
    if (raw.action !== 'deny-future-starts-for-operation') fail('INVALID_INPUT', 400);
    const input = validateBrowserOperationRequest(raw.request);
    if (input.operationId !== operationId) fail('INVALID_INPUT', 400);
    const fingerprint = browserOperationRequestFingerprint({ projectId, ...input });
    const existing = inspect(projectId, operationId);
    if (matching(projectId, input, existing)) return { status: 200, payload: proof(projectId, operationId, existing) };
    if (inFlight(projectId, operationId, fingerprint)) fail('BROWSER_ADMISSION_PENDING', 409);
    const scope = () => {
      const value = catalog.read();
      if (!value.projects[projectId]) fail('NOT_FOUND', 404);
      if (value.generationId !== input.expectedGenerationId) fail('BROWSER_OPERATION_SCOPE_UNVERIFIED', 409);
      owned(); return true;
    };
    ready(); scope();
    const lease = runtime.reserve({ kind: 'browser', operationId });
    let published = false, commitMayExist = false;
    const active = () => {
      ready(); runtime.assertActive(lease);
      if (inFlight(projectId, operationId, fingerprint)) fail('BROWSER_ADMISSION_PENDING', 409);
      return scope();
    };
    try {
      owned(); runtime.assertHeld(lease);
      const decided = inspect(projectId, operationId);
      if (matching(projectId, input, decided)) return { status: 200, payload: proof(projectId, operationId, decided) };
      active();
      const result = store.publishRejection({ projectId, request: input }, { assertCurrent: active });
      published = !result.replayed;
      owned(); runtime.assertActive(lease);
      const current = inspect(projectId, operationId);
      if (!matching(projectId, input, current) || current.kind !== result.decision.kind) fail();
      const captured = current.kind === 'recorded' ? current.value.record : current.record;
      const original = result.decision.kind === 'recorded' ? result.decision.value.record : result.decision.record;
      if (captured.sha256 !== original.sha256 || !captured.bytes.equals(original.bytes)) fail();
      const payload = proof(projectId, operationId, current);
      owned(); runtime.assertActive(lease);
      return { status: 200, payload };
    } catch (cause) {
      commitMayExist = published || cause?.writeMayHaveCommitted === true;
      if (commitMayExist) { cause.writeMayHaveCommitted = true; runtime.block('PUBLICATION_UNCERTAIN'); }
      throw cause;
    } finally {
      try { runtime.release(lease); }
      catch {
        runtime.block('LEASE_LOST');
        const cause = new AcceptanceCatalogError('BROWSER_EXECUTION_UNAVAILABLE', 503, 'Browser 执行槽无法安全释放；请只读核对原操作。');
        if (published || commitMayExist) cause.writeMayHaveCommitted = true;
        throw cause;
      }
    }
  }
  function execute(projectId, raw) {
    try {
      owned(); id(projectId, 'ap');
      const input = validateBrowserOperationRequest(raw), operationId = input.operationId;
      const fingerprint = browserOperationRequestFingerprint({ projectId, ...input });
      const decision = inspect(projectId, operationId);
      if (matching(projectId, input, decision)) {
        if (decision.kind === 'rejected') fail('BROWSER_START_REJECTED', 409);
        return Promise.resolve({ status: 200, payload: { ...view(decision.value), replayed: true } });
      }
      const waiting = pending.get(operationId);
      if (waiting) {
        if (waiting.projectId !== projectId) fail('NOT_FOUND', 404);
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
          const handle = { lease, finished: null, projectId, fingerprint };
          handles.set(operationId, handle); transferred = true;
          const finished = (async () => {
            try {
              const rawReport = await runner(prepared.contract, { runId: e.runId, outputDir: run.outputDir,
                sourceFiles: prepared.sourceFiles, signal: runtime.signalOf(lease), assertActive: active });
              active(); store.finishRun(operationId, rawReport, { assertActive: active });
            } catch (cause) {
              try {
                held();
                const current = store.inspectDecision(operationId, { full: false });
                if (current.kind === 'recorded' && current.value.state === 'running') {
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
              const current = store.inspectDecision(operationId, { full: false });
              if (current.kind === 'recorded' && current.value.state === 'running') store.settleRun(operationId,
                { status: 'interrupted', reasonCode: runtime.reasonOf(lease) ?? 'EXECUTION_FAILED' }, { assertHeld: held });
            } catch { runtime.block('PUBLICATION_UNCERTAIN'); }
          }
          throw cause;
        } finally {
          if (!transferred) try { runtime.release(lease); } catch { /* Exact lease was already released. */ }
        }
      })();
      const tracked = promise.finally(() => { if (pending.get(operationId)?.promise === tracked) pending.delete(operationId); });
      pending.set(operationId, { projectId, fingerprint, promise: tracked });
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
  return Object.freeze({ execute, list, read, report, evidence, cancel, registerResult, ledger, capability, recover, drain,
    resolution, denyStart });
}
