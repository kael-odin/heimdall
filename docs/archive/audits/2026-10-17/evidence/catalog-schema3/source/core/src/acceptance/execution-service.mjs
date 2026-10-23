/** Fresh admission and read-only operation reconciliation. A saved dispatch is
 * never a queue: only this call's successful fresh preparation can start work. */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { types } from 'node:util';
import { assertAcceptanceOwner } from './owner.mjs';
import { AcceptanceCatalogError } from './catalog-schema.mjs';
import { managedSpecDispatchRequestFingerprint, isManagedSpecOperationId } from './managed-dispatch-schema.mjs';
import { createManagedSpecDispatchReadContext } from './managed-dispatch-reader.mjs';
import { createAcceptanceReadScope, captureAcceptanceRunFile } from './managed-run-reader.mjs';
import { validateManagedRunHead } from './managed-snapshot-schema.mjs';
import { startManagedSpecExecution } from './managed-executor.mjs';

const PROJECT = /^ap-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const failure = (code = 'MANAGED_EXECUTION_UNAVAILABLE', status = 503) => new AcceptanceCatalogError(code, status,
  code === 'NOT_FOUND' ? '托管执行操作不存在。' : code === 'IDEMPOTENCY_CONFLICT' ? '操作 ID 已用于其他确认。'
    : code === 'INVALID_INPUT' ? '执行请求参数无效。' : '无法安全接纳或核验托管执行，现场已保留。');
const copied = input => ({ operationId: input.operationId, expectedGenerationId: input.expectedGenerationId,
  expectedRevision: input.expectedRevision, selectionId: input.selectionId,
  contentDigest: input.contentDigest, targetReleaseId: input.targetReleaseId });
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

export function createManagedSpecExecutionService({ owner, catalog, runtime, mirrorFactory = () => ({}),
  assertReady = () => true, startExecution = startManagedSpecExecution } = {}) {
  assertAcceptanceOwner(owner);
  const pending = new Map(), handles = new Map();
  const owned = () => assertAcceptanceOwner(owner);
  const checkReady = () => {
    if (!synchronous(assertReady)) { consumePromise(assertReady); throw failure(); }
    let result;
    try { result = assertReady(); }
    catch (cause) { consumePromise(cause); throw failure(); }
    if (result !== true && result !== undefined) { consumePromise(result); throw failure(); }
  };
  const ready = () => { owned(); checkReady(); owned(); return true; };

  function read(projectId, operationId) {
    owned();
    if (typeof projectId !== 'string' || !PROJECT.test(projectId) || !isManagedSpecOperationId(operationId)) throw failure('INVALID_INPUT', 400);
    const managedRead = createManagedSpecDispatchReadContext({ root: owner.root });
    const record = managedRead.read(operationId);
    if (!record || record.envelope.project.id !== projectId) throw failure('NOT_FOUND', 404);
    const e = record.envelope, scope = createAcceptanceReadScope({ root: owner.root, managedRead });
    const bytes = captureAcceptanceRunFile(e.runId, 'manifest.json', { scope });
    let manifest = null;
    if (bytes) manifest = validateManagedRunHead({ record, manifestBytes: bytes,
      manifest: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }).manifest;
    else {
      // Only an absent run directory denotes prepared. An empty/partial run
      // has unknown creation outcome and is never offered as safely unstarted.
      try { lstatSync(join(owner.root, e.runId)); throw failure(); }
      catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
    }
    scope.assertCurrent(); owned();
    return { schemaVersion: 1, operationId, projectId, runId: e.runId, taskId: e.taskId,
      sourceRunId: e.candidate.source.runId, targetReleaseId: e.targetRelease.id,
      state: manifest?.status ?? 'prepared', runCreated: manifest !== null,
      gate: manifest?.gate ?? null, reasonCode: manifest?.reasonCode ?? null };
  }

  function execute(projectId, raw) {
    try {
      ready();
      // This strict full-confirmation lookup is intentionally before busy.
      // Existing operations remain queries when today's selection has changed.
      const existing = catalog.readManagedSpecDispatch(projectId, raw);
      const input = copied(raw), { operationId, ...confirmation } = input;
      const fingerprint = managedSpecDispatchRequestFingerprint({ projectId, ...confirmation });
      if (existing) return Promise.resolve({ status: 200, payload: { ...read(projectId, operationId), replayed: true } });
      const prior = pending.get(operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', 409);
        return prior.promise.then(result => ({ status: 200, payload: { ...result.payload, replayed: true } }));
      }
      const lease = runtime.reserve({ kind: 'managed', operationId });
      const assertAdmission = () => { ready(); return runtime.assertActive(lease); };
      let transferred = false;
      const promise = (async () => {
        try {
          const prepared = await catalog.prepareManagedSpecDispatch(projectId, input, { assertAdmission });
          assertAdmission();
          if (prepared.replayed) return { status: 200, payload: { ...read(projectId, operationId), replayed: true } };
          // No disk scan or retry can enter here after a failed preparation.
          // The original call stack and exact lease carry fresh admission.
          const handle = startExecution({ owner, runtime, lease, record: prepared.record,
            mirror: mirrorFactory({ lease, record: prepared.record }) });
          transferred = true;
          handles.set(handle.taskId, handle);
          handle.finished.finally(() => { if (handles.get(handle.taskId) === handle) handles.delete(handle.taskId); }).catch(() => {});
          const state = read(projectId, operationId);
          return { status: 202, payload: { ...state, replayed: false } };
        } catch (cause) {
          if (cause?.writeMayHaveCommitted === true) runtime.block();
          throw cause;
        } finally {
          if (!transferred) {
            // startExecution owns the lease after its first successful held
            // assertion; a rejected admission may still own an unhanded lease.
            try { runtime.assertHeld(lease); runtime.release(lease); } catch { /* exact lease already ended */ }
          }
        }
      })();
      const tracked = promise.finally(() => { if (pending.get(operationId)?.promise === tracked) pending.delete(operationId); });
      pending.set(operationId, { fingerprint, promise: tracked });
      return tracked;
    } catch (cause) { return Promise.reject(cause); }
  }

  function capability() {
    owned();
    let recoveryReady = true;
    try { checkReady(); } catch { recoveryReady = false; }
    owned();
    const state = runtime.state();
    return { schemaVersion: 1, enabled: true, ready: recoveryReady && !state.busy && !state.closing && !state.blocked,
      ...state, recoveryReady, methods: ['GET', 'HEAD'], triageSupported: false };
  }
  async function drain() {
    await Promise.allSettled([...pending.values()].map(item => item.promise));
    await Promise.allSettled([...handles.values()].map(handle => handle.finished));
  }
  return Object.freeze({ execute, read, capability, drain });
}
