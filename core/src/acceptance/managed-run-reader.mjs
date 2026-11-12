/** Synchronous, owner-free captures. No writes, repair, runner or admission.
 * A scope fixes one logical batch: callers must assertCurrent() before using
 * the batch result. Byte fences are not an atomic multi-file snapshot. */
import * as fs from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fields, plain } from './catalog-schema.mjs';
import { ACCEPTANCE_ROOT, ACCEPTANCE_SNAPSHOT_LIMITS } from './constants.mjs';
import { createManagedSpecDispatchReadContext, assertManagedSpecDispatchReadContext } from './managed-dispatch-reader.mjs';
import { ManagedAcceptanceRunError, hasManagedAcceptanceMarker } from './managed-run-schema.mjs';
import { validateManagedRunHead, validateManagedCompletedSnapshot } from './managed-snapshot-schema.mjs';

export const ACCEPTANCE_READ_LIMITS = Object.freeze({ ...ACCEPTANCE_SNAPSHOT_LIMITS,
  runs: 1024, capturedFiles: 4096, capturedBytes: 256 * 1024 * 1024 });
const RUN_ID = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/;
const RESERVED = new Set(['manifest.json', 'report.json', 'triage.json', 'plan.json', 'dispatch.json', 'evidence-manifest.json']);
const scopes = new WeakMap();
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const unlinkedVersion = (before, after) => sameIdentity(before, after) && before.size === after.size
  && before.mtimeNs === after.mtimeNs && before.nlink === 1n && after.nlink === 0n;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (reason = 'INVALID_INPUT') => { throw new ManagedAcceptanceRunError('MANAGED_RUN_INTEGRITY_FAILED', reason); };
const invalid = () => { throw new ManagedAcceptanceRunError('INVALID_INPUT', 'INVALID_INPUT'); };
const boundary = fn => {
  try { return fn(); }
  catch (cause) { if (cause instanceof ManagedAcceptanceRunError) throw cause; fail(); }
};
const runIdOf = runId => { if (typeof runId !== 'string' || !RUN_ID.test(runId)) invalid(); return runId; };
function limitsOf(input) {
  fields(input, Object.keys(ACCEPTANCE_READ_LIMITS), [], invalid);
  const limits = { ...ACCEPTANCE_READ_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > limits[key]) invalid();
    limits[key] = value;
  }
  return Object.freeze(limits);
}
function jsonObject(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { fail('UNSAFE_JSON'); }
  if (!plain(value)) fail('UNSAFE_JSON');
  // JSON.parse executes no user code, but legacy heads need the same bounded
  // traversal as managed heads before returning a caller-owned object.
  const pending = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++nodes > 400_000 || depth > 80) fail('JSON_COMPLEXITY_EXCEEDED');
    if (item !== null && typeof item === 'object') {
      for (const key in item) if (Object.hasOwn(item, key)) {
        if (pending.length >= 400_000 - nodes) fail('JSON_COMPLEXITY_EXCEEDED');
        pending.push([item[key], depth + 1]);
      }
    }
  }
  return value;
}
const recordCopy = record => record ? { bytes: Buffer.from(record.bytes), sha256: record.sha256,
  envelope: JSON.parse(record.bytes.toString('utf8')) } : null;

function identity(path, directory, optional = false, allowHardlinks = false, allowUnlinked = false) {
  let stat;
  try { stat = fs.lstatSync(path, { bigint: true }); }
  catch (cause) { if (optional && cause?.code === 'ENOENT') return null; throw cause; }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()
    || (!allowHardlinks && stat.nlink !== 1n && !(allowUnlinked && stat.nlink === 0n)))
    || !samePath(fs.realpathSync(path), path)) fail();
  return stat;
}

/** Private brand/root validation also fences all previously captured facts.
 * Duck types and proxies cannot supply a scope capability. */
export function assertAcceptanceReadScope(scope, root) {
  return boundary(() => {
    const state = scopes.get(scope);
    if (!state || state.display || typeof root !== 'string' || !root.trim() || !samePath(state.root, resolve(root))) invalid();
    return state.assertCurrent();
  });
}

/** The dispatch context is captured once, by one batch API. classify() does
 * no filesystem work. assertCurrent() rechecks namespace and every captured
 * head/evidence/absence, so a later run cannot invalidate an earlier result. */
export const createAcceptanceReadScope = (options = {}) => createScope(options, false);
/** Display heads retain their first stable bytes if an ordinary legacy writer
 * atomically publishes a newer version. They never adopt that replacement in
 * the same request. Namespace, managed facts and in-place edits stay fenced.
 * This capability cannot be used for source snapshots or artifact captures. */
export const createAcceptanceDisplayReadScope = (options = {}) => createScope(options, true);
function createScope(options, display) {
  return boundary(() => {
    fields(options, ['root', 'managedRead', 'limits'], [], invalid);
    const requestedRoot = options.root === undefined ? ACCEPTANCE_ROOT : options.root;
    if (typeof requestedRoot !== 'string' || !requestedRoot.trim()) invalid();
    const root = resolve(requestedRoot), limits = limitsOf(options.limits === undefined ? {} : options.limits), rootPin = identity(root, true);
    let managedRead, captured;
    try {
      managedRead = options.managedRead === undefined ? createManagedSpecDispatchReadContext({ root }) : options.managedRead;
      assertManagedSpecDispatchReadContext(managedRead, root);
      captured = managedRead.captureRecords();
    } catch { fail('DISPATCH_UNAVAILABLE'); }
    const records = new Map();
    for (const record of captured) {
      const envelope = jsonObject(record.bytes);
      if (!SHA256.test(record.sha256) || hash(record.bytes) !== record.sha256 || records.has(envelope.runId)) fail('INVALID_RECORD');
      records.set(envelope.runId, { bytes: Buffer.from(record.bytes), sha256: record.sha256 });
    }
    const runs = new Map(), captures = new Map(), publicationPins = new Map(); let totalBytes = 0, invalidated = false;
    const changed = () => { invalidated = true; fail(); };
    const rootFence = () => {
      try { if (!sameIdentity(rootPin, identity(root, true))) changed(); }
      catch (cause) { invalidated = true; throw cause; }
    };
    const runFence = run => {
      rootFence();
      let current;
      try { current = identity(run.dir, true, true); } catch (cause) { invalidated = true; throw cause; }
      if (run.stat ? !current || !sameIdentity(run.stat, current) : current !== null) changed();
    };
    const publishedHead = (run, name, previous, current) => display && !records.has(run.runId)
      && (name === 'manifest.json' || name === 'report.json') && current?.isFile() && (current.nlink === 1n || current.nlink === 0n)
      && (!previous || previous.dev !== current.dev || previous.ino !== current.ino || previous.birthtimeNs !== current.birthtimeNs);
    const rememberPublication = (path, current) => {
      const pinned = publicationPins.get(path);
      // Newer bytes are not adopted. Still reject a later in-place change to
      // the replacement inode after its metadata was first observed.
      if (pinned && pinned.dev === current.dev && pinned.ino === current.ino && pinned.birthtimeNs === current.birthtimeNs
        && !sameFile(pinned, current) && !unlinkedVersion(pinned, current)) changed();
      publicationPins.set(path, current);
    };
    const run = runId => {
      runIdOf(runId); rootFence();
      if (!runs.has(runId)) {
        if (runs.size >= limits.runs) fail('JSON_COMPLEXITY_EXCEEDED');
        const dir = join(root, runId);
        runs.set(runId, { runId, dir, stat: identity(dir, true, true), evidenceFiles: 0, evidenceBytes: 0 });
      }
      const entry = runs.get(runId); runFence(entry); return entry;
    };
    const safeRead = (run, name, maxBytes, expected, allowHardlinks = false) => {
      runFence(run);
      const path = join(run.dir, name); let before;
      const displayHead = display && !records.has(run.runId) && (name === 'manifest.json' || name === 'report.json');
      try { before = identity(path, false, true, allowHardlinks, displayHead); }
      catch (cause) { if (expected) invalidated = true; throw cause; }
      if (!before) {
        if (expected?.stat) changed();
        runFence(run); return null;
      }
      if (expected && (!expected.stat || !sameFile(expected.stat, before))) {
        if (!publishedHead(run, name, expected.stat, before)
          && !(displayHead && expected.stat && unlinkedVersion(expected.stat, before))) changed();
        rememberPublication(path, before);
        runFence(run); return expected.stat ? expected : null;
      }
      if (before.size < 0n || before.size > BigInt(maxBytes)) fail('JSON_BYTES_EXCEEDED');
      let descriptor;
      try {
        descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile()) changed();
        if (!sameFile(before, opened) && !publishedHead(run, name, before, opened)) {
          // A Linux rename can detach this descriptor before its first fstat.
          // Pin the safe replacement path without adopting its bytes. The fd
          // must either be the unchanged pre-open inode, or an intervening
          // publication opened after that pathname observation.
          const current = identity(path, false, false, allowHardlinks, displayHead);
          const intervening = before.dev !== opened.dev || before.ino !== opened.ino || before.birthtimeNs !== opened.birthtimeNs;
          const detached = opened.nlink === 0n && (publishedHead(run, name, opened, current)
            || (displayHead && unlinkedVersion(before, current)))
            && (intervening || (sameIdentity(before, opened) && before.nlink === 1n
              && before.size === opened.size && before.mtimeNs === opened.mtimeNs));
          if (!detached) changed();
          rememberPublication(path, current);
        }
        if (expected && (!expected.stat || !sameFile(expected.stat, opened))) {
          if (!publishedHead(run, name, expected.stat, opened)
            && !(displayHead && expected.stat && unlinkedVersion(expected.stat, opened))) changed();
          rememberPublication(path, opened);
          runFence(run); return expected.stat ? expected : null;
        }
        if (opened.size < 0n || opened.size > BigInt(maxBytes)) fail('JSON_BYTES_EXCEEDED');
        const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
        while (offset < bytes.length) {
          const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
          if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) changed();
          offset += count;
        }
        if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) changed();
        const finished = fs.fstatSync(descriptor, { bigint: true });
        const current = identity(path, false, false, allowHardlinks, displayHead);
        const replaced = publishedHead(run, name, opened, current);
        // Linux may unlink the old inode while this descriptor still pins its
        // bytes. Only link/ctime changes from replacement are tolerated here.
        const released = displayHead && unlinkedVersion(opened, finished);
        const retiredLookup = displayHead && unlinkedVersion(opened, current);
        if (!sameFile(opened, finished) && !released) changed();
        if (!sameFile(opened, current) && !replaced && !retiredLookup) changed();
        if (replaced || retiredLookup) rememberPublication(path, current);
        runFence(run);
        return { run, name, path, stat: opened, bytes, maxBytes, allowHardlinks };
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    };
    const compare = capture => {
      const observed = safeRead(capture.run, capture.name, capture.maxBytes, capture, capture.allowHardlinks);
      if (capture.stat ? !observed || !observed.bytes.equals(capture.bytes) : observed !== null) changed();
    };
    const read = (run, name, maxBytes, allowHardlinks = false) => {
      const path = join(run.dir, name), existing = captures.get(path), evidence = name !== 'manifest.json' && name !== 'report.json';
      if (!existing && evidence && run.evidenceFiles >= limits.evidenceFiles) fail('JSON_COMPLEXITY_EXCEEDED');
      const remaining = evidence && !existing ? Math.min(maxBytes, limits.evidenceBytes - run.evidenceBytes) : maxBytes;
      const observed = safeRead(run, name, remaining, existing, allowHardlinks);
      if (existing) {
        if (existing.stat ? !observed || !observed.bytes.equals(existing.bytes) : observed !== null) changed();
        return existing.stat ? existing : null;
      }
      if (captures.size >= limits.capturedFiles || totalBytes + (observed?.bytes.length ?? 0) > limits.capturedBytes) fail('JSON_BYTES_EXCEEDED');
      const capture = observed ?? { run, name, path, stat: null, bytes: null, maxBytes, allowHardlinks };
      captures.set(path, capture); totalBytes += observed?.bytes.length ?? 0;
      if (evidence) { run.evidenceFiles++; run.evidenceBytes += observed?.bytes.length ?? 0; }
      return observed;
    };
    const guarded = fn => (...args) => boundary(() => {
      if (invalidated) fail();
      try { return fn(...args); }
      catch (cause) { if (!(cause instanceof ManagedAcceptanceRunError && cause.code === 'INVALID_INPUT')) invalidated = true; throw cause; }
    });
    // A stable damaged row is a per-run diagnostic. Semantic classification
    // failure must not invalidate unrelated captured rows in a list.
    const classify = (runId, manifest, report) => boundary(() => {
      if (invalidated) fail();
      runIdOf(runId);
      const record = records.get(runId);
      if (!record && (hasManagedAcceptanceMarker(manifest) || hasManagedAcceptanceMarker(report))) fail('INVALID_RECORD');
      return record ? { kind: 'managed', record: recordCopy(record) } : { kind: 'legacy' };
    });
    const assertCurrent = guarded(() => {
      rootFence();
      try { assertManagedSpecDispatchReadContext(managedRead, root); } catch { fail('DISPATCH_UNAVAILABLE'); }
      for (const pinned of runs.values()) runFence(pinned);
      for (const capture of captures.values()) compare(capture);
      // The full namespace fence can perform considerable I/O. Check captured
      // run bytes again after it, without adopting any changed facts.
      try { managedRead.assertCurrent(); } catch { fail('DISPATCH_UNAVAILABLE'); }
      for (const capture of captures.values()) compare(capture);
      for (const pinned of runs.values()) runFence(pinned);
      rootFence(); return true;
    });
    const scope = Object.freeze({ root, classify, assertCurrent });
    scopes.set(scope, { root, limits, display, run, read, compare, runFence, classify, assertCurrent,
      captureFence(run) {
        for (const capture of captures.values()) if (capture.run === run) compare(capture);
        runFence(run);
      } });
    rootFence();
    return scope;
  });
}

function context(options) {
  fields(options, ['scope'], ['scope'], invalid);
  const state = scopes.get(options.scope);
  if (!state) invalid();
  return state;
}

function head(runId, state) {
  const run = state.run(runId);
  if (!run.stat) return null;
  const manifestCapture = state.read(run, 'manifest.json', state.limits.jsonBytes);
  const manifest = manifestCapture ? jsonObject(manifestCapture.bytes) : null;
  const reserved = state.classify(runId).kind === 'managed';
  // A failed report publication can legitimately retain its exclusive-link
  // temporary name. It is non-authoritative while the manifest is uncompleted.
  const reportCapture = state.read(run, 'report.json', state.limits.jsonBytes, reserved && manifest?.status !== 'completed');
  const report = reportCapture ? jsonObject(reportCapture.bytes) : null;
  const classified = state.classify(runId, manifest, report);
  state.captureFence(run);
  if (!manifestCapture) {
    // A prepared record with no run is unstarted. An existing run directory
    // without its identity manifest is partial material, never safe absence.
    if (classified.kind === 'managed') fail('MANIFEST_REQUIRED');
    return null;
  }
  const files = new Map([['manifest.json', Buffer.from(manifestCapture.bytes)]]);
  if (reportCapture) files.set('report.json', Buffer.from(reportCapture.bytes));
  if (classified.kind === 'legacy') return { kind: 'legacy', manifest, report, files, record: null, binding: null };
  const checked = validateManagedRunHead({ record: classified.record, manifestBytes: manifestCapture.bytes, manifest });
  return { kind: 'managed', manifest: checked.manifest, report, files, record: classified.record, binding: checked.binding };
}

/** Shared head capture also protects legacy report-only markers. Optional
 * report bytes are captured, but no report/evidence completion is inferred. */
export function captureAcceptanceRunHead(runId, options) {
  return boundary(() => head(runIdOf(runId), context(options)));
}
export const captureManagedRunHead = captureAcceptanceRunHead;

/** A narrow bounded file capture for the legacy snapshot validator. This does
 * not validate a report or grant artifact access; it only fixes bytes in the
 * same batch scope. No namespace scan occurs until its final assertCurrent(). */
export function captureAcceptanceRunFile(runId, name, options) {
  return boundary(() => {
    runIdOf(runId);
    fields(options, ['scope', 'maxBytes'], ['scope'], invalid);
    const state = scopes.get(options.scope);
    if (!state || state.display || typeof name !== 'string' || name.length > 240) invalid();
    const isHead = name === 'manifest.json' || name === 'report.json';
    if (!isHead && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|json)$/i.test(name)
      || RESERVED.has(name.toLowerCase()) || name.toLowerCase().includes('.tmp.'))) invalid();
    const upper = isHead ? state.limits.jsonBytes : Math.min(state.limits.evidenceFileBytes, state.limits.evidenceBytes);
    const maxBytes = options.maxBytes === undefined ? upper : options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > upper) invalid();
    const run = state.run(runId);
    if (!run.stat) return null;
    const captured = state.read(run, name, maxBytes);
    // Do not re-read all earlier evidence for every single legacy file. The
    // caller's final scope fence covers the complete accumulated batch.
    if (captured) state.compare(captured); else state.read(run, name, maxBytes);
    state.runFence(run);
    return captured ? Buffer.from(captured.bytes) : null;
  });
}

function references(report, limits) {
  if (!Array.isArray(report.checks) || report.checks.length > limits.checks
    || !Array.isArray(report.evidenceManifest) || report.evidenceManifest.length > limits.evidenceFiles) fail();
  const indexed = new Map(), names = new Set(); let total = 0;
  for (const entry of report.evidenceManifest) {
    fields(entry, ['file', 'bytes', 'sha256'], ['file', 'bytes', 'sha256'], fail);
    if (typeof entry.file !== 'string' || entry.file.length > 240 || !EVIDENCE.test(entry.file)
      || RESERVED.has(entry.file.toLowerCase()) || entry.file.includes('.tmp.') || indexed.has(entry.file)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > limits.evidenceFileBytes
      || !SHA256.test(entry.sha256)) fail();
    total += entry.bytes;
    if (total > limits.evidenceBytes) fail();
    indexed.set(entry.file, entry);
  }
  for (const check of report.checks) {
    if (!plain(check) || !plain(check.evidence)) fail();
    for (const name of Object.values(check.evidence)) {
      if (typeof name !== 'string' || !indexed.has(name)) fail();
      names.add(name);
    }
  }
  if (names.size !== indexed.size) fail();
  return indexed;
}

/** A completed capture adds only referenced evidence. Non-completed lifecycle
 * heads remain readable above, but can never become a valid evidence snapshot.
 * files is a caller-owned Map<basename, Buffer>; binding stays outside snapshot. */
export function captureManagedCompletedRun(runId, options) {
  return boundary(() => {
    runIdOf(runId); const state = context(options);
    if (state.display) invalid();
    const captured = head(runId, state);
    if (!captured) return null;
    if (captured.kind !== 'managed' || captured.manifest.status !== 'completed' || !captured.report) fail();
    const run = state.run(runId), evidence = new Map();
    for (const [name, entry] of references(captured.report, state.limits)) {
      const file = state.read(run, name, Math.min(state.limits.evidenceFileBytes, entry.bytes));
      if (!file || file.bytes.length !== entry.bytes || hash(file.bytes) !== entry.sha256) fail();
      evidence.set(name, Buffer.from(file.bytes));
    }
    const snapshotLimits = Object.fromEntries(Object.keys(ACCEPTANCE_SNAPSHOT_LIMITS).map(key => [key, state.limits[key]]));
    const checked = validateManagedCompletedSnapshot({ record: captured.record,
      manifestBytes: captured.files.get('manifest.json'), manifest: captured.manifest,
      reportBytes: captured.files.get('report.json'), report: captured.report, files: evidence, limits: snapshotLimits });
    state.captureFence(run);
    for (const [name, bytes] of evidence) captured.files.set(name, bytes);
    return { snapshot: checked.snapshot, files: captured.files, binding: checked.binding, record: captured.record };
  });
}
