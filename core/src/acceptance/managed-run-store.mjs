/** Narrow owner-bound fact writer. No admission, runner, network or recovery.
 * The completed manifest is the commit point; a lone report stays partial.
 * Path fences assume a cooperating owner/single writer, not hostile OS CAS. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { AcceptanceCatalogError, fields, iso } from './catalog-schema.mjs';
import { ACCEPTANCE_SNAPSHOT_LIMITS } from './constants.mjs';
import { assertAcceptanceOwner } from './owner.mjs';
import { createManagedSpecDispatchReadContext, assertManagedSpecDispatchReadContext } from './managed-dispatch-reader.mjs';
import { isManagedSpecOperationId } from './managed-dispatch-schema.mjs';
import { managedRunProvenanceOf, validateManagedRunLinkage } from './managed-run-schema.mjs';
import { validateManagedSpecRaw, validateManagedProgress, validateManagedSettlement } from './managed-execution-schema.mjs';
import { validateManagedSpecEvidence } from './managed-evidence-schema.mjs';
import { createManagedRunFileContext } from './managed-run-files.mjs';
import { summarizeAcceptanceReport } from './report.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/;
const RESERVED = new Set(['manifest.json', 'report.json', 'triage.json', 'plan.json', 'dispatch.json', 'evidence-manifest.json']);
const MANIFEST_FIELDS = ['schemaVersion', 'runId', 'taskId', 'name', 'mode', 'targetUrl', 'status', 'gate', 'createdAt',
  'updatedAt', 'plan', 'summary', 'progress', 'managed'];
const settlements = new WeakMap();
const digest = value => createHash('sha256').update(value).digest('hex');
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const fail = (reason, code = 'MANAGED_RUN_NOT_WRITABLE', status = 503) => {
  throw new AcceptanceCatalogError(code, status, code === 'INVALID_INPUT' ? '托管运行写入参数无效。'
    : code === 'MANAGED_RUN_CONFLICT' ? '托管运行已有记录或状态不允许此次写入。' : '托管运行无法安全写入，原现场已保留。', { reason });
};
const invalid = () => fail('INVALID_INPUT', 'INVALID_INPUT', 400);
const conflict = reason => fail(reason, 'MANAGED_RUN_CONFLICT', 409);
const shape = (value, allowed, required = allowed) => fields(value, allowed, required, invalid);

// Reject without assimilating arbitrary thenables or executing constructor hooks.
const NativePromise = Promise, promisePrototype = Promise.prototype, promiseThen = Promise.prototype.then;
const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
function consumePromise(value) {
  if (types.isPromise(value) && Object.getPrototypeOf(value) === promisePrototype
      && !Object.getOwnPropertyDescriptor(value, 'constructor')
      && Object.getOwnPropertyDescriptor(promisePrototype, 'constructor')?.value === NativePromise
      && Object.getOwnPropertyDescriptor(NativePromise, Symbol.species)?.get === species) promiseThen.call(value, undefined, () => {});
}
function activeGuard(assertActive) {
  if (typeof assertActive !== 'function' || types.isProxy(assertActive) || types.isAsyncFunction(assertActive)
      || types.isGeneratorFunction(assertActive)) { consumePromise(assertActive); invalid(); }
  return () => {
    let value;
    try { value = assertActive(); } catch { fail('ACTIVE_REJECTED'); }
    if (value !== undefined && value !== true) { consumePromise(value); fail('ACTIVE_REJECTED'); }
  };
}
function limitsOf(input = {}) {
  shape(input, Object.keys(ACCEPTANCE_SNAPSHOT_LIMITS), []);
  for (const [key, value] of Object.entries(input)) if (!Number.isSafeInteger(value) || value < 0 || value > ACCEPTANCE_SNAPSHOT_LIMITS[key]) invalid();
  return { ...ACCEPTANCE_SNAPSHOT_LIMITS, ...input };
}
function directory(path) {
  try {
    const stat = fs.lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) fail('DIRECTORY_IDENTITY_INVALID');
    return stat;
  } catch { fail('DIRECTORY_IDENTITY_INVALID'); }
}
function parse(capture) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capture.bytes)); }
  catch { fail('INVALID_STORED_JSON'); }
}

/** Descriptor reads and repeated byte checks are bounded. Metadata alone is
 * insufficient on coarse clocks. No evidence is promoted or repaired. */
function captureFile(path, maxBytes) {
  let fd;
  try {
    const before = fs.lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail('FILE_UNSAFE_OR_EXCEEDED');
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) fail('FILE_CHANGED');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('FILE_CHANGED'); offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0
        || !sameFile(opened, fs.fstatSync(fd, { bigint: true })) || !sameFile(opened, fs.lstatSync(path, { bigint: true }))) fail('FILE_CHANGED');
    return { path, stat: opened, bytes, sha256: digest(bytes), maxBytes };
  } catch (cause) {
    if (cause instanceof AcceptanceCatalogError) throw cause;
    fail('FILE_UNREADABLE');
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { fail('FILE_CLOSE_FAILED'); }
  }
}
function assertCaptured(captured) {
  const current = captureFile(captured.path, captured.maxBytes);
  if (!sameFile(captured.stat, current.stat) || !captured.bytes.equals(current.bytes)) fail('FILE_CHANGED');
}
function currentVerifier() {
  const captures = ['schema.mjs', 'urls.mjs', 'runner.mjs', 'report.mjs', 'spec-schema.mjs', 'spec-runner.mjs',
    'response-schema.mjs', 'openapi.mjs', 'identity.mjs', '../verify/compare.mjs'].map(file =>
    captureFile(new URL(file, import.meta.url), ACCEPTANCE_SNAPSHOT_LIMITS.jsonBytes));
  // Preserve the legacy exact ten-source algorithm, including its final join.
  const fingerprint = digest(captures.slice(0, 9).map(c => c.bytes.toString('utf8')).join('\n') + captures[9].bytes.toString('utf8'));
  return { captures, fingerprint };
}

function operation(ref, options, active) {
  shape(ref, ['operationId', 'dispatchSha256']);
  const { operationId, dispatchSha256 } = ref;
  if (!isManagedSpecOperationId(operationId) || typeof dispatchSha256 !== 'string' || !SHA256.test(dispatchSha256)) invalid();
  shape(options, ['owner', 'assertActive', 'managedRead', 'limits'], ['owner', ...(active ? ['assertActive'] : [])]);
  const { owner, assertActive, managedRead: providedRead, limits: inputLimits } = options;
  assertAcceptanceOwner(owner);
  const root = owner.root, limits = limitsOf(inputLimits);
  const checkActive = active ? activeGuard(assertActive) : () => {};
  checkActive(); assertAcceptanceOwner(owner);
  const rootPin = directory(root);
  const managedRead = providedRead ?? createManagedSpecDispatchReadContext({ root });
  assertManagedSpecDispatchReadContext(managedRead, root);
  const record = managedRead.reread(operationId, dispatchSha256);
  const managed = managedRunProvenanceOf(record), envelope = parse(record), runId = managed.runId, dir = join(root, runId);
  const parent = join(root, 'managed-spec-dispatches'), namespace = join(parent, 'v1');
  const parentPin = directory(parent), namespacePin = directory(namespace);
  const sidecar = captureFile(join(namespace, operationId + '.json'), ACCEPTANCE_SNAPSHOT_LIMITS.jsonBytes);
  if (sidecar.sha256 !== dispatchSha256 || !sidecar.bytes.equals(record.bytes)) fail('DISPATCH_CHANGED');
  let runPin = null, failed = false;
  const captures = [], extraFences = [];
  const coreFence = () => {
    if (failed) fail('WRITE_SCOPE_INVALIDATED');
    try {
      checkActive(); assertAcceptanceOwner(owner);
      if (!sameIdentity(rootPin, directory(root))) fail('ROOT_CHANGED');
      if (runPin && !sameIdentity(runPin, directory(dir))) fail('RUN_DIRECTORY_CHANGED');
      if (!sameIdentity(parentPin, directory(parent)) || !sameIdentity(namespacePin, directory(namespace))) fail('DISPATCH_DIRECTORY_CHANGED');
    } catch (error) { failed = true; throw error; }
    return true;
  };
  const fileFence = () => {
    coreFence();
    try { assertCaptured(sidecar); }
    catch (error) { failed = true; throw error; }
    return true;
  };
  const assertWritable = () => {
    coreFence();
    try {
      managedRead.reread(operationId, dispatchSha256);
      for (const captured of captures) assertCaptured(captured);
      for (const fence of extraFences) fence();
      assertAcceptanceOwner(owner);
    } catch (error) { failed = true; throw error; }
    return true;
  };
  const pinRun = () => { runPin = directory(dir); assertWritable(); };
  const fileContext = () => createManagedRunFileContext({ root, runId, assertWritable: fileFence, limits: { jsonBytes: limits.jsonBytes } });
  const translate = fn => {
    let wrote = false;
    try { return fn(() => { wrote = true; }); }
    catch (cause) {
      const error = cause instanceof AcceptanceCatalogError || cause?.name === 'AcceptanceOwnerError' ? cause
        : new AcceptanceCatalogError('MANAGED_RUN_NOT_WRITABLE', 503, '托管运行无法安全写入，原现场已保留。', { reason: 'FILESYSTEM_FAILURE' });
      error.writeMayHaveCommitted = wrote || error.writeMayHaveCommitted === true;
      error.details = { ...(error.details ?? {}), operationId, runId };
      throw error;
    }
  };
  return { record, managed, envelope, root, dir, runId, limits, captures, extraFences, coreFence, assertWritable, pinRun, fileContext, translate };
}
function requireAbsentReport(scope) {
  scope.extraFences.push(() => {
    try { fs.lstatSync(join(scope.dir, 'report.json')); }
    catch (cause) { if (cause?.code === 'ENOENT') return; throw cause; }
    conflict('PARTIAL_REPORT_EXISTS');
  });
}
function running(scope, files) {
  const expected = files.read('manifest.json'), manifest = parse(expected);
  validateManagedRunLinkage({ record: scope.record, manifest });
  if (manifest.status !== 'running') conflict('TERMINAL_IMMUTABLE');
  shape(manifest, MANIFEST_FIELDS);
  if (!iso(manifest.createdAt) || !iso(manifest.updatedAt) || manifest.summary !== null || manifest.gate !== 'blocked') fail('INVALID_RUNNING_MANIFEST');
  if (manifest.progress !== null) validateManagedProgress({ progress: manifest.progress });
  return { manifest, expected };
}

export function createManagedAcceptanceRun(ref, options) {
  const s = operation(ref, options, true);
  return s.translate(committed => {
    s.assertWritable();
    try { fs.mkdirSync(s.dir); } catch (cause) { if (cause?.code === 'EEXIST') conflict('RUN_DIRECTORY_EXISTS'); throw cause; }
    // A failure after mkdir preserves this partial directory for reconciliation.
    s.pinRun();
    requireAbsentReport(s);
    const now = new Date().toISOString();
    const manifest = { schemaVersion: 1, runId: s.runId, taskId: s.managed.taskId, name: s.envelope.plan.name, mode: 'spec',
      targetUrl: s.envelope.plan.targetUrl, status: 'running', gate: 'blocked', createdAt: now, updatedAt: now,
      plan: s.envelope.plan, summary: null, progress: null, managed: s.managed };
    validateManagedRunLinkage({ record: s.record, manifest });
    s.fileContext().publish('manifest.json', encoded(manifest), { expected: null, beforePublish: s.assertWritable }); committed();
    return manifest;
  });
}

export function updateManagedAcceptanceProgress(ref, input, options) {
  const progress = validateManagedProgress(input).progress, s = operation(ref, options, true);
  return s.translate(committed => {
    s.pinRun(); const files = s.fileContext(), { manifest, expected } = running(s, files);
    if (files.read('report.json', { optional: true })) conflict('PARTIAL_REPORT_EXISTS');
    requireAbsentReport(s);
    const next = { ...manifest, progress, updatedAt: new Date().toISOString() };
    files.publish('manifest.json', encoded(next), { expected, beforePublish: s.assertWritable }); committed(); return next;
  });
}

export function finishManagedAcceptanceRun(ref, input, options) {
  const s = operation(ref, options, true);
  return s.translate(committed => {
    s.pinRun(); const files = s.fileContext(), { manifest, expected } = running(s, files);
    if (files.read('report.json', { optional: true })) conflict('PARTIAL_REPORT_EXISTS');
    const raw = validateManagedSpecRaw({ record: s.record, manifest, raw: input });
    if (raw.checks.length > s.limits.checks) fail('EVIDENCE_BUDGET_EXCEEDED');
    const names = new Set(raw.checks.flatMap(check => Object.values(check.evidence)));
    if (names.size > s.limits.evidenceFiles) fail('EVIDENCE_BUDGET_EXCEEDED');
    const evidenceManifest = [], evidenceCaptures = []; let total = 0;
    s.assertWritable();
    for (const name of [...names].sort()) {
      if (!EVIDENCE.test(name) || RESERVED.has(name.toLowerCase()) || name.includes('.tmp.')) fail('RESERVED_EVIDENCE_NAME');
      // The namespace is captured once at the batch boundary, not once for
      // every evidence item. Publication still rechecks the entire namespace.
      s.coreFence();
      const captured = captureFile(join(s.dir, name), Math.min(s.limits.evidenceFileBytes, s.limits.evidenceBytes - total));
      s.coreFence();
      total += captured.bytes.length;
      evidenceManifest.push({ file: name, bytes: captured.bytes.length, sha256: captured.sha256 }); evidenceCaptures.push(captured);
    }
    validateManagedSpecEvidence({ plan: s.envelope.plan, raw,
      files: new Map(evidenceCaptures.map(captured => [captured.path.slice(s.dir.length + 1), captured.bytes])) });
    s.captures.push(...evidenceCaptures);
    const verifier = currentVerifier(); s.captures.push(...verifier.captures);
    const report = summarizeAcceptanceReport({ ...raw, taskId: s.managed.taskId, managed: s.managed,
      planFingerprint: s.managed.planFingerprint, verifierFingerprint: verifier.fingerprint, evidenceManifest });
    validateManagedRunLinkage({ record: s.record, manifest, report });
    const reportCapture = files.publish('report.json', encoded(report), { expected: null, beforePublish: s.assertWritable }); committed();
    // Keep both evidence and the just-published report fixed before terminal CAS.
    s.captures.push(captureFile(join(s.dir, 'report.json'), s.limits.jsonBytes));
    if (s.captures.at(-1).sha256 !== reportCapture.sha256) fail('REPORT_CHANGED');
    const terminal = { ...manifest, status: 'completed', gate: report.gate, summary: report.summary, endedAt: report.endedAt,
      updatedAt: new Date().toISOString(), progress: { kind: 'acceptance-completed' }, error: null, reportSha256: reportCapture.sha256 };
    files.publish('manifest.json', encoded(terminal), { expected, beforePublish: s.assertWritable }); committed();
    return report;
  });
}

/** Prepare only the existing running manifest. Partial reports and evidence
 * stay opaque; cancellation is not consulted and no file is created or written.
 * The private token fixes the owner, expected bytes and terminal timestamp. */
export function prepareManagedAcceptanceSettlement(ref, input, options) {
  const settlement = validateManagedSettlement(input), s = operation(ref, options, false);
  return s.translate(() => {
    s.pinRun();
    const captured = captureFile(join(s.dir, 'manifest.json'), s.limits.jsonBytes);
    s.captures.push(captured);
    const files = s.fileContext(), { manifest, expected } = running(s, files);
    if (!captured.bytes.equals(expected.bytes)) fail('FILE_CHANGED');
    const now = new Date().toISOString(), terminal = { ...manifest, ...settlement, gate: 'blocked', updatedAt: now, endedAt: now };
    const bytes = encoded(terminal);
    if (bytes.length > s.limits.jsonBytes) fail('TERMINAL_BYTES_EXCEEDED');
    s.assertWritable();
    const token = Object.freeze(Object.create(null));
    settlements.set(token, { s, files, expected, bytes });
    return token;
  });
}

const settlementOf = token => {
  const state = settlements.get(token);
  if (!state) invalid();
  return state;
};

/** Zero-write freshness check. A failed scope cannot be revived by restoring
 * old bytes, and a copied/proxied/consumed token carries no write capability. */
export function assertManagedAcceptanceSettlement(token) {
  const { s } = settlementOf(token);
  return s.translate(() => { s.assertWritable(); return true; });
}

/** A commit attempt consumes its token even when options, a guard or IO fails.
 * The batch guard runs before temporary writes and again before publication;
 * only the original owner/dispatch/manifest may publish the prepared bytes. */
export function commitManagedAcceptanceSettlement(token, options = {}) {
  const { s, files, expected, bytes } = settlementOf(token);
  settlements.delete(token);
  return s.translate(committed => {
    shape(options, ['beforePublish'], []);
    const guard = options.beforePublish === undefined ? () => {} : activeGuard(options.beforePublish);
    const beforePublish = () => { guard(); s.assertWritable(); };
    beforePublish();
    files.publish('manifest.json', bytes, { expected, beforePublish }); committed();
    return parse({ bytes });
  });
}

/** Settle after cancellation without invoking a now-cancelled active guard.
 * Owner, root, sidecar and run identity are still fenced at every publication. */
export function settleManagedAcceptanceRun(ref, input, options) {
  return commitManagedAcceptanceSettlement(prepareManagedAcceptanceSettlement(ref, input, options));
}
