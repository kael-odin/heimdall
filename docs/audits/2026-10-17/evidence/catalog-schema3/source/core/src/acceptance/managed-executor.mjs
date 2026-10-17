/** Internal fresh-admission worker. The caller owns admission; this module owns
 * the supplied lease after assertHeld, the live writer and the quiet finalizer.
 * A runner event is progress. Only a committed, verified fact is completion. */
import { join } from 'node:path';
import { types } from 'node:util';
import { AcceptanceCatalogError, fields } from './catalog-schema.mjs';
import { assertAcceptanceOwner } from './owner.mjs';
import { managedRunProvenanceOf } from './managed-run-schema.mjs';
import { createManagedSpecDispatchReadContext } from './managed-dispatch-reader.mjs';
import { createAcceptanceReadScope, captureAcceptanceRunFile, captureManagedCompletedRun } from './managed-run-reader.mjs';
import { validateManagedRunHead } from './managed-snapshot-schema.mjs';
import { createManagedRunFileContext } from './managed-run-files.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress, finishManagedAcceptanceRun,
  prepareManagedAcceptanceSettlement, commitManagedAcceptanceSettlement } from './managed-run-store.mjs';
import { runSpecAcceptance } from './spec-runner.mjs';
import { createWatchdog } from '../task-watchdog.mjs';

const HARD_MS = 360000, STALL_MS = 65000;
const PROGRESS = new Set(['acceptance-started', 'acceptance-check', 'acceptance-heartbeat', 'acceptance-completed']);
const STOP = new Set(['CANCELLED', 'WATCHDOG_TIMEOUT', 'WATCHDOG_STALLED', 'ENGINE_SHUTDOWN', 'EXECUTION_FAILED']);
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const copy = value => JSON.parse(JSON.stringify(value));
const invalid = () => { throw new AcceptanceCatalogError('INVALID_INPUT', 400, '托管执行参数无效。'); };
const stopped = () => { throw new AcceptanceCatalogError('MANAGED_EXECUTION_INACTIVE', 503, '托管执行已停止。'); };
const shape = (value, allowed, required = []) => fields(value, allowed, required, invalid);
const callable = fn => typeof fn === 'function' && !types.isProxy(fn) && !types.isAsyncFunction(fn) && !types.isGeneratorFunction(fn);
const NativePromise = Promise, promisePrototype = Promise.prototype, nativeThen = Promise.prototype.then;
const nativeSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
function asynchronous(value) {
  if (types.isPromise(value)) {
    // Internal adapters are synchronous. Consume an accidental ordinary native
    // rejection without assimilating caller thenables or invoking their hooks.
    if (Object.getPrototypeOf(value) === promisePrototype && !Object.hasOwn(value, 'constructor')
        && Object.getOwnPropertyDescriptor(promisePrototype, 'constructor')?.value === NativePromise
        && Object.getOwnPropertyDescriptor(NativePromise, Symbol.species)?.get === nativeSpecies) nativeThen.call(value, undefined, () => {});
    return true;
  }
  return value !== null && ['object', 'function'].includes(typeof value) && Object.hasOwn(value, 'then');
}
function timingOf(input = {}) {
  shape(input, ['timeoutMs', 'stallMs', 'setTimer', 'clearTimer', 'now']);
  const result = { timeoutMs: HARD_MS, stallMs: STALL_MS, setTimer: setTimeout, clearTimer: clearTimeout, now: Date.now, ...input };
  for (const [key, maximum] of [['timeoutMs', HARD_MS], ['stallMs', STALL_MS]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximum) invalid();
  }
  for (const key of ['setTimer', 'clearTimer', 'now']) if (!callable(result[key])) invalid();
  return result;
}
const settlementOf = reason => ({ status: ['CANCELLED', 'ENGINE_SHUTDOWN'].includes(reason) ? 'interrupted' : 'failed',
  reasonCode: reason, error: reason === 'CANCELLED' ? '验收任务已取消；已保留运行现场。'
    : reason === 'ENGINE_SHUTDOWN' ? '引擎正在关闭；已保留运行现场。'
      : reason === 'WATCHDOG_TIMEOUT' ? '验收任务超出时间上限；已保留运行现场。'
        : reason === 'WATCHDOG_STALLED' ? '验收任务长时间无进展；已保留运行现场。' : '验收执行未完成；已保留运行现场。' });

/** Only the engine's fresh-admission call stack supplies record/runtime/lease.
 * No existing preparation is resumed by this entry point or by a disk scan.
 * A valid lease is taken over here, including every subsequent throw path. */
export function startManagedSpecExecution(options) {
  shape(options, ['owner', 'runtime', 'lease', 'record', 'mirror', 'timing', 'dependencies'], ['owner', 'runtime', 'lease', 'record']);
  const { owner, runtime, lease, record } = options, mirror = options.mirror ?? {}, timing = timingOf(options.timing);
  const dependencies = options.dependencies ?? {};
  shape(mirror, ['preflight', 'register', 'event', 'terminal']);
  shape(dependencies, ['runSpecAcceptance']);
  for (const name of ['preflight', 'register']) if (mirror[name] !== undefined && !callable(mirror[name])) invalid();
  for (const name of ['event', 'terminal']) if (mirror[name] !== undefined && typeof mirror[name] !== 'function') invalid();
  const run = dependencies.runSpecAcceptance ?? runSpecAcceptance;
  if (typeof run !== 'function') invalid();
  assertAcceptanceOwner(owner);
  runtime.assertHeld(lease);
  let ref, runId, taskId, latest = null, phase = 'preflight', authorityLost = false, uncertain = false;
  let watchdog = null, finalized = false, finalResult = null, mirrorDegraded = false, released = false, managedRead, signal, deadline;
  let runFiles = null, writing = false, fenceLost = false;
  const block = () => { try { runtime.block(); } catch { /* Never replace the primary failure. */ } };
  const detachWatchdog = () => {
    const current = watchdog; watchdog = null;
    try { current?.stop(); } catch { block(); }
  };
  const held = () => { runtime.assertHeld(lease); return true; };
  const authority = () => {
    try { assertAcceptanceOwner(owner); }
    catch (error) { authorityLost = true; block(); throw error; }
    return true;
  };
  const stop = (reason = 'CANCELLED') => {
    if (!STOP.has(reason)) invalid();
    if (finalized) return false;
    return runtime.stop(lease, reason);
  };
  const active = () => {
    if (finalized || ['stopping', 'reconciling'].includes(phase)) stopped();
    authority(); runtime.assertActive(lease);
    // Pin the original preparation independently of the mutable run manifest.
    // The runner calls this fence around requests and while awaiting a response.
    try {
      managedRead?.assertCurrent();
      runFiles?.assertCurrent();
      // A writer's own terminal/progress replacement is fenced by its private
      // expected token. Between writes the runner must retain our exact head.
      if (runFiles && latest && !writing && !runFiles.read('manifest.json').bytes.equals(latest)) stopped();
    }
    catch (error) { fenceLost = true; block(); throw error; }
    const now = timing.now();
    if (!Number.isFinite(now)) invalid();
    deadline ??= now + timing.timeoutMs;
    if (now >= deadline) { stop('WATCHDOG_TIMEOUT'); runtime.assertActive(lease); }
    return true;
  };
  const write = action => {
    writing = true;
    try { return action(); }
    catch (error) { uncertain ||= error?.writeMayHaveCommitted === true; throw error; }
    finally { writing = false; }
  };
  const safeMirror = (name, value) => {
    try { if (mirror[name] && asynchronous(mirror[name](copy(value)))) mirrorDegraded = true; }
    catch { mirrorDegraded = true; }
  };
  const requiredMirror = (name, value) => {
    if (mirror[name] && asynchronous(mirror[name](copy(value)))) invalid();
  };
  const reason = () => {
    try { const value = runtime.reasonOf(lease); return STOP.has(value) ? value : 'EXECUTION_FAILED'; }
    catch { return 'EXECUTION_FAILED'; }
  };
  const release = () => {
    if (released) return;
    released = true;
    try { runtime.release(lease); } catch { block(); }
  };
  const result = (manifest = null, report = null, code = null) => ({ runId, taskId,
    status: manifest?.status === 'completed' ? 'done' : manifest?.status === 'interrupted'
      ? manifest.reasonCode === 'CANCELLED' ? 'cancelled' : 'interrupted' : authorityLost ? 'interrupted' : 'failed',
    runStatus: manifest?.status ?? null, gate: report?.gate ?? manifest?.gate ?? 'blocked',
    reasonCode: manifest?.reasonCode ?? (manifest?.status === 'completed' ? null : reason()), code,
    summary: report?.summary ? copy(report.summary) : null, mirrorDegraded, publicationUncertain: uncertain });
  // Reconciliation deliberately starts with only the manifest. A partial report
  // can be malformed, linked or a FIFO and is not needed to observe running.
  const readCurrent = () => {
    authority(); held();
    managedRead?.assertCurrent();
    runFiles?.assertCurrent();
    const read = createManagedSpecDispatchReadContext({ root: owner.root });
    const fixed = read.reread(ref.operationId, ref.dispatchSha256);
    const scope = createAcceptanceReadScope({ root: owner.root, managedRead: read });
    const bytes = captureAcceptanceRunFile(runId, 'manifest.json', { scope });
    if (!bytes) stopped();
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    validateManagedRunHead({ record: fixed, manifestBytes: bytes, manifest });
    let report = null;
    if (manifest.status === 'completed') {
      const captured = captureManagedCompletedRun(runId, { scope });
      if (!captured || captured.binding.operationId !== ref.operationId || captured.binding.dispatchSha256 !== ref.dispatchSha256
        || captured.binding.runId !== runId || captured.binding.taskId !== taskId) stopped();
      report = captured.snapshot.report;
    }
    scope.assertCurrent(); authority(); held();
    return { bytes, manifest, report };
  };
  const recoverFailure = cause => {
    uncertain ||= cause?.writeMayHaveCommitted === true;
    phase = 'stopping'; detachWatchdog();
    try { stop(reason()); } catch { block(); }
    phase = 'reconciling';
    if (uncertain) block();
    let current;
    try { current = readCurrent(); }
    catch { block(); return result(null, null, authorityLost ? 'ACCEPTANCE_OWNER_LOST' : 'MANAGED_EXECUTION_BLOCKED'); }
    if (current.manifest.status !== 'running') return result(current.manifest, current.report,
      uncertain ? 'MANAGED_PUBLICATION_UNCERTAIN' : null);
    if (uncertain || fenceLost || !latest || !current.bytes.equals(latest)) {
      block(); return result(null, null, uncertain ? 'MANAGED_PUBLICATION_UNCERTAIN' : 'MANAGED_EXECUTION_BLOCKED');
    }
    // The stopped signal must not be reused as the settlement guard. The same
    // live owner and held lease still fence this one narrow terminal attempt.
    const beforePublish = () => {
      authority(); held();
      if (!readCurrent().bytes.equals(latest)) stopped();
      return true;
    };
    try {
      beforePublish();
      const token = prepareManagedAcceptanceSettlement(ref, settlementOf(reason()), { owner });
      const manifest = write(() => commitManagedAcceptanceSettlement(token, { beforePublish }));
      return result(manifest, null, reason() === 'EXECUTION_FAILED' ? 'MANAGED_EXECUTION_FAILED' : null);
    } catch {
      block();
      // The consumed token is never retried, including a commit-then-throw.
      try { const observed = readCurrent(); if (observed.manifest.status !== 'running') return result(observed.manifest, observed.report, 'MANAGED_PUBLICATION_UNCERTAIN'); }
      catch { /* Preserve all unknown facts. */ }
      return result(null, null, authorityLost ? 'ACCEPTANCE_OWNER_LOST' : 'MANAGED_EXECUTION_BLOCKED');
    }
  };
  const finalize = value => {
    if (finalized) return finalResult;
    detachWatchdog(); finalized = true; phase = 'finalized';
    finalResult = value;
    safeMirror('terminal', value);
    value.mirrorDegraded = mirrorDegraded;
    release();
    return Object.freeze(value);
  };
  try {
    const provenance = managedRunProvenanceOf(record);
    ref = { operationId: provenance.operationId, dispatchSha256: provenance.dispatchSha256 };
    ({ runId, taskId } = provenance);
    managedRead = createManagedSpecDispatchReadContext({ root: owner.root });
    const fixed = managedRead.reread(ref.operationId, ref.dispatchSha256);
    const envelope = JSON.parse(fixed.bytes.toString('utf8'));
    active();
    requiredMirror('preflight', { runId, taskId, targetUrl: envelope.plan.targetUrl });
    active(); phase = 'starting';
    const manifest = write(() => createManagedAcceptanceRun(ref, { owner, assertActive: active, managedRead }));
    latest = encode(manifest);
    runFiles = createManagedRunFileContext({ root: owner.root, runId, assertWritable: () => { authority(); held(); return true; } });
    requiredMirror('register', manifest);
    runtime.bind(lease, { runId, taskId, onStop: detachWatchdog });
    signal = runtime.signalOf(lease);
    active();
    watchdog = createWatchdog({ timeoutMs: timing.timeoutMs, stallMs: timing.stallMs,
      setTimer: timing.setTimer, clearTimer: timing.clearTimer,
      onKill: why => { if (!finalized) stop(why === 'stalled' ? 'WATCHDOG_STALLED' : 'WATCHDOG_TIMEOUT'); } });
    const onEvent = event => {
      if (phase !== 'executing') stopped();
      active();
      if (!event || !PROGRESS.has(event.kind)) invalid();
      const progress = { kind: event.kind };
      for (const key of ['message', 'completed', 'total', 'route', 'viewport']) if (Object.hasOwn(event, key)) progress[key] = event[key];
      progress.at = new Date().toISOString();
      const next = write(() => updateManagedAcceptanceProgress(ref, { progress }, { owner, assertActive: active, managedRead }));
      latest = encode(next);
      safeMirror('event', { ...progress, runId });
      active(); watchdog?.touch();
    };
    const execute = async () => {
      try {
        phase = 'executing'; active();
        const raw = await run(envelope.plan, { runId, outputDir: join(owner.root, runId), signal, assertActive: active, onEvent });
        active(); phase = 'committing';
        const report = write(() => finishManagedAcceptanceRun(ref, raw, { owner, assertActive: active, managedRead }));
        return finalize(result({ status: 'completed', gate: report.gate }, report));
      } catch (cause) { return finalized ? finalResult : finalize(recoverFailure(cause)); }
    };
    // This observer is installed before exposing the handle. Even unexpected
    // finalizer errors are reduced to a safe outcome, with no orphan rejection.
    const finished = Promise.resolve().then(execute).catch(() => {
      if (finalized && finalResult) { release(); return Object.freeze(finalResult); }
      block(); detachWatchdog(); finalized = true;
      const failed = result(null, null, authorityLost ? 'ACCEPTANCE_OWNER_LOST' : 'MANAGED_EXECUTION_BLOCKED');
      finalResult = failed;
      safeMirror('terminal', failed); failed.mirrorDegraded = mirrorDegraded; release(); return Object.freeze(failed);
    });
    return Object.freeze({ runId, taskId, finished, requestStop: stop });
  } catch (cause) {
    if (phase !== 'preflight') {
      if (ref) finalize(recoverFailure(cause)); else { block(); release(); }
    } else { detachWatchdog(); release(); }
    const error = new AcceptanceCatalogError('MANAGED_EXECUTION_START_FAILED', cause?.status === 409 ? 409 : 503,
      '托管验收未能安全启动；已保留原现场。');
    error.writeMayHaveCommitted = uncertain;
    throw error;
  }
}
