/** Owner-bound Browser operations, outside the legacy ac-* run namespace. */
import { constants, mkdirSync, readdirSync, realpathSync, lstatSync, openSync, closeSync, fstatSync,
  readSync, writeFileSync, fsyncSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { assertAcceptanceOwner } from './owner.mjs';
import { AcceptanceCatalogError } from './catalog-schema.mjs';
import { hashAcceptanceValue } from './identity.mjs';
import { summarizeAcceptanceReport } from './report.mjs';
import { BROWSER_OPERATION_LIMITS, BrowserOperationError, browserOperationFail as fail,
  browserOperationSha256 as sha, browserOperationSame as same, browserOperationJson as data,
  browserOperationFileName as fileName, browserOperationHash, isBrowserOperationId, validateBrowserOperationRequest,
  browserOperationRequestFingerprint, validateBrowserOperationDispatch, validateBrowserOperationHead,
  validateBrowserOperationReport, validateBrowserOperationRejection, browserOperationRejectionBytes,
  browserCheckBugKey, browserCheckRelation } from './browser-operation-schema.mjs';

const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const copy = value => JSON.parse(JSON.stringify(value));
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode;
const sameFile = (a, b) => identity(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const isBug = c => c?.status === 'failed' && c?.verdict === 'bug';
const STOP = new Set(['CANCELLED', 'WATCHDOG_TIMEOUT', 'WATCHDOG_STALLED', 'ENGINE_SHUTDOWN', 'ENGINE_RESTARTED', 'EXECUTION_FAILED']);
const MAX_OBSERVATION_LINEAGE_DEPTH = 64;
const nativePromise = Promise, nativePromisePrototype = Promise.prototype, nativeThen = Promise.prototype.then;
const nativeSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
function consumeNativePromise(value) {
  if (types.isPromise(value) && Object.getPrototypeOf(value) === nativePromisePrototype
    && !Object.getOwnPropertyDescriptor(value, 'constructor')
    && Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor')?.value === nativePromise
    && Object.getOwnPropertyDescriptor(nativePromise, Symbol.species)?.get === nativeSpecies) nativeThen.call(value, undefined, () => {});
}
function synchronousGuard(fn) {
  if (fn === undefined) return () => {};
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isAsyncFunction(fn) || types.isGeneratorFunction(fn)) fail('INVALID_GUARD', 'INVALID_INPUT', 400);
  return () => { let value;
    try { value = fn(); } catch (cause) { consumeNativePromise(cause); throw cause; }
    if (value !== undefined && value !== true) {
    consumeNativePromise(value);
    fail('INACTIVE', 'BROWSER_OPERATION_INACTIVE', 503);
  } };
}
function boundedFile(path, maximum) {
  let fd;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)
      || realpathSync(path) !== path) fail('FILE_UNSAFE');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true }); if (!sameFile(before, opened)) fail('FILE_CHANGED');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail('FILE_CHANGED'); offset += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0 || !sameFile(opened, fstatSync(fd, { bigint: true }))
      || !sameFile(opened, lstatSync(path, { bigint: true }))) fail('FILE_CHANGED');
    return { path, bytes, stat: opened, sha256: sha(bytes), maximum };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function parse(capture) {
  try { return data(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capture.bytes)), capture.maximum); }
  catch (cause) { if (cause instanceof BrowserOperationError) throw cause; fail('INVALID_JSON'); }
}

export function createBrowserOperationStore({ owner, limits: inputLimits = {} } = {}) {
  assertAcceptanceOwner(owner);
  const limits = { ...BROWSER_OPERATION_LIMITS };
  if (inputLimits === null || typeof inputLimits !== 'object' || types.isProxy(inputLimits)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(inputLimits))) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
  const limitDescriptors = Object.getOwnPropertyDescriptors(inputLimits);
  for (const key of Reflect.ownKeys(limitDescriptors)) {
    const descriptor = limitDescriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
    const value = descriptor.value;
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 0 || value > limits[key]) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
    limits[key] = value;
  }
  const root = resolve(owner.root), parent = join(root, 'browser-operations'), namespace = join(parent, 'v1'), pins = new Map();
  const claims = new WeakSet(), temporaries = new Map(), decisionScopes = new WeakMap();
  const owned = () => { assertAcceptanceOwner(owner); if (realpathSync(root) !== root) fail('ROOT_CHANGED'); };
  function directory(path, create = false, optional = false) {
    owned();
    let stat, created = false;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      if (pins.has(path)) fail('DIRECTORY_CHANGED');
      if (create) { mkdirSync(path); created = true; stat = lstatSync(path, { bigint: true }); }
      else if (optional) return false; else throw cause;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('DIRECTORY_UNSAFE');
    const previous = pins.get(path); if (previous && !identity(previous, stat)) fail('DIRECTORY_CHANGED');
    pins.set(path, stat); owned();
    if (created) syncDirectory(dirname(path));
    return true;
  }
  function base(create = false) {
    if (!directory(parent, create, true)) return false;
    return directory(namespace, create, true);
  }
  function pathOf(operationId, create = false) {
    if (!isBrowserOperationId(operationId)) fail('INVALID_OPERATION_ID', 'INVALID_INPUT', 400);
    if (!base(create)) return null;
    const path = join(namespace, operationId);
    return directory(path, create, true) ? path : null;
  }
  function syncDirectory(path) {
    // Windows does not expose a portable directory fsync through Node. File
    // contents are flushed there; whole-machine power-loss durability is not claimed.
    if (process.platform === 'win32') return;
    directory(path); const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { fsyncSync(fd); } finally { closeSync(fd); }
    directory(path);
  }
  function safeFileShape(path, maximum) {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 0n
      || stat.size > BigInt(maximum) || realpathSync(path) !== path
      || !sameFile(stat, lstatSync(path, { bigint: true }))) fail('FILE_UNSAFE');
    return stat;
  }
  function shape(path, kind, claim = null) {
    directory(path);
    const rootEntries = readdirSync(path, { withFileTypes: true });
    if (rootEntries.length > limits.directoryEntries) fail('DIRECTORY_CAPACITY');
    const semantic = [], rootNames = rootEntries.map(v => v.name).sort();
    const temporary = (folder, entry) => {
      const target = join(folder, entry.name), tracked = temporaries.get(target);
      if (!tracked) return false;
      if (claim && tracked.claim !== claim) fail('CLAIM_TEMPORARY_MISMATCH', 'BROWSER_OPERATION_INTEGRITY_FAILED');
      const stat = safeFileShape(target, tracked.maximum);
      if (!identity(stat, tracked.stat)) fail('TEMPORARY_CHANGED');
      return true;
    };
    for (const entry of rootEntries) {
      if (temporary(path, entry)) continue;
      semantic.push(entry.name);
      if (kind === 'rejected') {
        if (entry.name !== 'rejection.json') fail('DECISION_MIXED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
        safeFileShape(join(path, entry.name), limits.rejectionBytes);
      } else if (entry.name === 'evidence') {
        const evidence = join(path, 'evidence'); directory(evidence);
        const entries = readdirSync(evidence, { withFileTypes: true }), names = [];
        if (entries.length > limits.directoryEntries) fail('EVIDENCE_BUDGET');
        let bytes = 0n;
        for (const file of entries) {
          if (temporary(evidence, file)) continue;
          if (!fileName(file.name)) fail('DECISION_EVIDENCE_UNSAFE', 'BROWSER_OPERATION_INTEGRITY_FAILED');
          names.push(file.name); bytes += safeFileShape(join(evidence, file.name), limits.evidenceFileBytes).size;
        }
        if (names.length > limits.evidenceFiles || bytes > BigInt(limits.evidenceBytes)) fail('EVIDENCE_BUDGET');
        if (claim && !same(names.sort(), [...claim.evidence].sort())) fail('CLAIM_EVIDENCE_CHANGED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
        if (!same(entries.map(v => v.name).sort(), readdirSync(evidence).sort())) fail('DIRECTORY_CHANGED');
        directory(evidence);
      } else {
        if (!['dispatch.json', 'head.json', 'report.json', 'observations.json'].includes(entry.name))
          fail('DECISION_MIXED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
        safeFileShape(join(path, entry.name), entry.name === 'head.json' ? 64 * 1024 : limits.jsonBytes);
      }
    }
    if (claim) {
      if (!claims.has(claim) || claim.path !== path || claim.kind !== kind
        || !identity(claim.stat, lstatSync(path, { bigint: true })) || !same(semantic.sort(), [...claim.entries].sort()))
        fail('CLAIM_CHANGED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
    } else if (kind === 'rejected' ? !same(semantic, ['rejection.json']) : !semantic.includes('dispatch.json'))
      fail('DECISION_INCOMPLETE', 'BROWSER_OPERATION_INTEGRITY_FAILED');
    if (!same(rootNames, readdirSync(path).sort())) fail('DIRECTORY_CHANGED');
    directory(path); owned();
  }
  function claimNew(operationId, kind, fingerprint) {
    if (inventory().length >= limits.operations) fail('OPERATION_CAPACITY');
    base(true);
    const path = join(namespace, operationId);
    try { mkdirSync(path); }
    catch (cause) { if (cause.code === 'EEXIST') return null; throw cause; }
    directory(path); syncDirectory(namespace);
    const claim = { operationId, kind, fingerprint, path, stat: lstatSync(path, { bigint: true }), entries: new Set(), evidence: new Set() };
    claims.add(claim); shape(path, kind, claim); return claim;
  }
  function currentClaim(claim) {
    if (!claims.has(claim) || pathOf(claim.operationId) !== claim.path) fail('CLAIM_CHANGED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
    inventory(); shape(claim.path, claim.kind, claim);
  }
  const checkPath = operationId => { const path = pathOf(operationId); if (!path) fail('OPERATION_MISSING', 'NOT_FOUND', 404); return path; };
  function captures(operationId, kind = 'recorded') {
    const path = checkPath(operationId), seen = [];
    const readFile = (name, maximum = limits.jsonBytes, optional = false, evidence = false) => {
      directory(path); const folder = evidence ? join(path, 'evidence') : path;
      if (evidence) directory(folder);
      const target = join(folder, name);
      try { const capture = boundedFile(target, maximum); seen.push(capture); return capture; }
      catch (cause) { if (optional && cause.code === 'ENOENT') return null; throw cause; }
    };
    const current = () => {
      shape(path, kind); for (const c of seen) { const again = boundedFile(c.path, c.maximum);
        if (!sameFile(c.stat, again.stat) || !c.bytes.equals(again.bytes)) fail('FILE_CHANGED'); }
      shape(path, kind); owned();
    };
    return { path, readFile, current, seen };
  }
  function publishFile(path, name, bytes, beforePublish = () => {}, previous = null, claim = null) {
    owned(); directory(path); const target = join(path, name), temporary = join(path, `${name}.tmp.${randomUUID()}`);
    let fd, temporaryStat, committed = false;
    try {
      fd = openSync(temporary, 'wx', 0o600); temporaryStat = fstatSync(fd, { bigint: true });
      temporaries.set(temporary, { stat: temporaryStat, maximum: Math.max(bytes.length, 1), claim });
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      directory(path); const captured = boundedFile(temporary, Math.max(bytes.length, 1));
      if (!captured.bytes.equals(bytes) || !identity(captured.stat, temporaryStat)) fail('TEMPORARY_CHANGED');
      beforePublish(); directory(path); owned();
      const ready = boundedFile(temporary, Math.max(bytes.length, 1));
      if (!sameFile(captured.stat, ready.stat) || !ready.bytes.equals(bytes)) fail('TEMPORARY_CHANGED');
      if (previous) {
        const now = boundedFile(target, previous.maximum);
        if (!sameFile(now.stat, previous.stat) || !now.bytes.equals(previous.bytes)) fail('HEAD_CHANGED');
        renameSync(temporary, target); committed = true;
      } else { linkSync(temporary, target); committed = true; unlinkSync(temporary); }
      temporaries.delete(temporary); syncDirectory(path);
      const published = boundedFile(target, Math.max(bytes.length, 1));
      if (!identity(published.stat, temporaryStat) || !published.bytes.equals(bytes)) fail('PUBLICATION_CHANGED');
      if (!claim) shape(path, 'recorded');
      directory(path); owned();
    } catch (cause) {
      if (committed) cause.writeMayHaveCommitted = true;
      throw cause;
    } finally {
      if (fd !== undefined) closeSync(fd);
      // Remove only this invocation's tracked temporary inode, never accepted facts.
      if (!committed && temporaryStat) try {
        directory(path); const now = lstatSync(temporary, { bigint: true });
        if (identity(now, temporaryStat)) { owned(); unlinkSync(temporary); }
      } catch { /* Failed preparation evidence remains if identity is uncertain. */ }
      temporaries.delete(temporary);
    }
  }
  function inventory() {
    if (!base()) return [];
    const entries = readdirSync(namespace, { withFileTypes: true });
    if (entries.length > limits.operations || entries.length > limits.directoryEntries) fail('OPERATION_CAPACITY');
    for (const entry of entries) if (!isBrowserOperationId(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) fail('NAMESPACE_UNSAFE');
    return entries.map(v => v.name).sort();
  }
  function readRecorded(operationId, full = true) {
    shape(checkPath(operationId), 'recorded');
    const scope = captures(operationId), dispatch = scope.readFile('dispatch.json'), envelope = validateBrowserOperationDispatch(parse(dispatch));
    if (envelope.operationId !== operationId) fail('OPERATION_IDENTITY_MISMATCH');
    const record = { envelope, bytes: Buffer.from(dispatch.bytes), sha256: dispatch.sha256 };
    const headCapture = scope.readFile('head.json', 64 * 1024, true);
    const head = headCapture ? validateBrowserOperationHead(parse(headCapture), record) : null;
    let report = null; const files = new Map();
    if (head?.status === 'completed' && full) {
      const captured = scope.readFile('report.json');
      if (captured.sha256 !== head.reportSha256) fail('REPORT_CHANGED');
      report = validateBrowserOperationReport(parse(captured), record);
      if (report.gate !== head.gate) fail('REPORT_GATE_MISMATCH');
      if (!Array.isArray(report.evidenceManifest) || report.evidenceManifest.length > limits.evidenceFiles) fail('EVIDENCE_MANIFEST_MISSING');
      let total = 0; const refs = new Set(report.checks.flatMap(c => Object.values(c.evidence ?? {}).filter(v => typeof v === 'string')));
      const index = new Map(report.evidenceManifest.map(v => [v.file, v]));
      for (const name of refs) if (!index.has(name)) fail('EVIDENCE_UNINDEXED');
      for (const entry of report.evidenceManifest) {
        total += entry.bytes; if (total > limits.evidenceBytes) fail('EVIDENCE_BUDGET');
        const capture = scope.readFile(entry.file, limits.evidenceFileBytes, false, true);
        if (capture.bytes.length !== entry.bytes || capture.sha256 !== entry.sha256) fail('EVIDENCE_CHANGED');
        files.set(entry.file, Buffer.from(capture.bytes));
      }
      for (const entry of envelope.contract.sourceEvidence) {
        if (!index.has(entry.file) || !same(index.get(entry.file), { file: entry.file, bytes: entry.bytes, sha256: entry.sha256 })) fail('SOURCE_EVIDENCE_MISMATCH');
      }
    }
    scope.current();
    return { operationId, projectId: envelope.project.id, runId: envelope.runId, taskId: envelope.taskId,
      record, head, report, state: head?.status ?? 'prepared', files, _scope: scope, _headCapture: headCapture };
  }
  function inspectDecisionInternal(operationId, { full = true } = {}) {
    const path = pathOf(operationId);
    if (!path) return { kind: 'absent', operationId };
    const entries = readdirSync(path);
    if (!entries.includes('rejection.json')) return { kind: 'recorded', value: readRecorded(operationId, full) };
    shape(path, 'rejected');
    const scope = captures(operationId, 'rejected'), captured = scope.readFile('rejection.json', limits.rejectionBytes);
    let envelope, bytes;
    try { envelope = validateBrowserOperationRejection(parse(captured)); bytes = browserOperationRejectionBytes(envelope); }
    catch { fail('INVALID_REJECTION', 'BROWSER_OPERATION_INTEGRITY_FAILED'); }
    if (envelope.operationId !== operationId || !bytes.equals(captured.bytes)) fail('REJECTION_CHANGED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
    scope.current();
    const decision = { kind: 'rejected', record: { envelope, bytes: Buffer.from(captured.bytes), sha256: captured.sha256 } };
    decisionScopes.set(decision, scope); return decision;
  }
  function currentDecision(decision) {
    if (decision.kind === 'recorded') decision.value._scope.current();
    else if (decision.kind === 'rejected') decisionScopes.get(decision).current();
  }
  function readInternal(operationId, full = true) {
    let decision;
    try { decision = inspectDecisionInternal(operationId, { full }); }
    catch (cause) {
      // Legacy accepted-operation readers keep their unavailable contract for a
      // retained partial preparation. The decision inspector remains strict.
      if (cause instanceof BrowserOperationError && cause.code === 'BROWSER_OPERATION_INTEGRITY_FAILED'
        && cause.details.reason === 'DECISION_INCOMPLETE') fail('DECISION_INCOMPLETE');
      throw cause;
    }
    if (decision.kind === 'absent') return null;
    if (decision.kind === 'rejected') fail('START_REJECTED', 'BROWSER_START_REJECTED', 409);
    return decision.value;
  }
  function inspectDecision(operationId, options = {}) { return boundary(() => {
    const checked = data(options, 1024);
    if (!checked || Array.isArray(checked) || Object.keys(checked).some(key => key !== 'full')
      || Object.hasOwn(checked, 'full') && typeof checked.full !== 'boolean') fail('INVALID_INSPECTION_OPTIONS', 'INVALID_INPUT', 400);
    return inspectDecisionInternal(operationId, checked);
  }); }
  function inspectInventory(full = false) {
    const ids = inventory(), decisions = ids.map(id => inspectDecisionInternal(id, { full }));
    if (decisions.some(v => v.kind === 'absent') || !same(ids, inventory())) fail('NAMESPACE_CHANGED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
    return decisions;
  }
  function matchingDecision(operationId, fingerprint, full = true) {
    const decision = inspectDecisionInternal(operationId, { full });
    if (decision.kind === 'absent') return null;
    const record = decision.kind === 'recorded' ? decision.value.record : decision.record;
    if (record.envelope.requestFingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409);
    return decision;
  }
  function read(operationId) { return boundary(() => readInternal(operationId)); }
  function list(projectId) { return boundary(() => {
    if (typeof projectId !== 'string' || !/^ap-[0-9a-f-]{36}$/.test(projectId)) fail('INVALID_PROJECT', 'INVALID_INPUT', 400);
    const decisions = inspectInventory(); for (const decision of decisions) currentDecision(decision);
    return decisions.filter(v => v.kind === 'recorded').map(v => v.value).filter(v => v.projectId === projectId);
  }); }
  function publish(input, { assertCurrent } = {}) { return boundary(() => {
    const guard = synchronousGuard(assertCurrent), request = validateBrowserOperationRequest(input.request), project = data(input.project);
    const fingerprint = browserOperationRequestFingerprint({ projectId: project.id, ...request });
    const replay = decision => {
      if (decision.kind === 'rejected') fail('START_REJECTED', 'BROWSER_START_REJECTED', 409);
      return { record: decision.value.record, replayed: true };
    };
    const existing = matchingDecision(request.operationId, fingerprint, false);
    if (existing) return replay(existing);
    const now = new Date().toISOString();
    const envelope = validateBrowserOperationDispatch({ schemaVersion: 1, operationId: request.operationId,
      runId: 'br-' + randomUUID(), taskId: 'a-' + randomUUID(), acceptedAt: now, request, requestFingerprint: fingerprint,
      project, candidate: input.candidate, sourceBinding: input.sourceBinding,
      sourceRelease: input.review.organizationContext.release, targetRelease: input.targetRelease,
      approval: { scope: 'single-operation', candidateId: input.candidate.id, contentDigest: request.contentDigest,
        targetReleaseId: request.targetReleaseId, approvedAt: now, actor: { kind: 'local-user' } },
      contract: input.contract, contractFingerprint: input.contract.contractDigest });
    const rawMap = input.sourceFiles;
    if (!(rawMap instanceof Map) || types.isProxy(rawMap)) fail('SOURCE_FILES_INVALID');
    const sourceFiles = new Map(); let total = 0;
    if (rawMap.size !== envelope.contract.sourceEvidence.length || rawMap.size > limits.evidenceFiles) fail('SOURCE_FILES_MISMATCH');
    for (const entry of envelope.contract.sourceEvidence) {
      const raw = Map.prototype.get.call(rawMap, entry.sourceFile);
      if (!Buffer.isBuffer(raw) || types.isProxy(raw) || types.isSharedArrayBuffer(raw.buffer)) fail('SOURCE_FILES_INVALID');
      const bytes = Buffer.from(raw); total += bytes.length;
      if (bytes.length > limits.evidenceFileBytes || total > limits.evidenceBytes || bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) fail('SOURCE_FILES_MISMATCH');
      sourceFiles.set(entry.file, bytes);
    }
    const bytes = encode(envelope); if (bytes.length > limits.jsonBytes) fail('JSON_BUDGET');
    guard();
    const concurrent = matchingDecision(request.operationId, fingerprint, false);
    if (concurrent) return replay(concurrent);
    const claim = claimNew(request.operationId, 'recorded', fingerprint);
    if (!claim) {
      const winner = matchingDecision(request.operationId, fingerprint, false);
      if (!winner) fail('CLAIM_UNVERIFIED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
      return replay(winner);
    }
    const claimGuard = () => { guard(); currentClaim(claim); };
    currentClaim(claim);
    const path = claim.path, evidence = join(path, 'evidence');
    mkdirSync(evidence); directory(evidence); claim.entries.add('evidence'); syncDirectory(path); currentClaim(claim);
    // Source bytes are already captured and hashed. Individual copies retain the
    // owner/directory fence; the expensive catalog/source fence runs once before
    // preparation and once immediately before the immutable dispatch commit.
    for (const [file, contents] of sourceFiles) {
      publishFile(evidence, file, contents, () => currentClaim(claim), null, claim);
      claim.evidence.add(file); currentClaim(claim);
    }
    let result;
    publishFile(path, 'dispatch.json', bytes, () => {
      for (const [file, contents] of sourceFiles) if (!boundedFile(join(evidence, file), limits.evidenceFileBytes).bytes.equals(contents)) fail('SOURCE_FILES_CHANGED');
      claimGuard(); }, null, claim);
    claim.entries.add('dispatch.json');
    try { claimGuard(); result = readInternal(request.operationId, false); claimGuard(); }
    catch (cause) { cause.writeMayHaveCommitted = true; throw cause; }
    return { record: result.record, replayed: false };
  }); }
  function publishRejection(input, { assertCurrent } = {}) { return boundary(() => {
    const guard = synchronousGuard(assertCurrent), checked = data(input, limits.rejectionBytes);
    if (Object.keys(checked).length !== 2 || !Object.hasOwn(checked, 'projectId') || !Object.hasOwn(checked, 'request'))
      fail('INVALID_REJECTION_INPUT', 'INVALID_INPUT', 400);
    const request = validateBrowserOperationRequest(checked.request), projectId = checked.projectId;
    const fingerprint = browserOperationRequestFingerprint({ projectId, ...request });
    const existing = matchingDecision(request.operationId, fingerprint);
    if (existing) return { decision: existing, replayed: true };
    const envelope = validateBrowserOperationRejection({ schemaVersion: 1, kind: 'browser-start-rejection', projectId,
      operationId: request.operationId, request, requestFingerprint: fingerprint, rejectedAt: new Date().toISOString(),
      reasonCode: 'USER_REJECTED_UNKNOWN_START', effect: 'deny-future-starts-for-operation', actor: { kind: 'local-user' } });
    const bytes = browserOperationRejectionBytes(envelope);
    if (bytes.length > limits.rejectionBytes) fail('REJECTION_BUDGET');
    guard();
    const concurrent = matchingDecision(request.operationId, fingerprint);
    if (concurrent) return { decision: concurrent, replayed: true };
    const claim = claimNew(request.operationId, 'rejected', fingerprint);
    if (!claim) {
      const winner = matchingDecision(request.operationId, fingerprint);
      if (!winner) fail('CLAIM_UNVERIFIED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
      return { decision: winner, replayed: true };
    }
    const claimGuard = () => { guard(); currentClaim(claim); };
    claimGuard();
    publishFile(claim.path, 'rejection.json', bytes, claimGuard, null, claim);
    claim.entries.add('rejection.json');
    try {
      claimGuard(); const decision = inspectDecisionInternal(request.operationId); claimGuard(); currentDecision(decision);
      if (decision.kind !== 'rejected' || !decision.record.bytes.equals(bytes)) fail('REJECTION_CHANGED', 'BROWSER_OPERATION_INTEGRITY_FAILED');
      return { decision, replayed: false };
    } catch (cause) { cause.writeMayHaveCommitted = true; throw cause; }
  }); }
  function createRun(operationId, { assertActive } = {}) { return boundary(() => {
    const guard = synchronousGuard(assertActive), value = readInternal(operationId, false);
    if (!value) fail('OPERATION_MISSING', 'NOT_FOUND', 404);
    if (value.head) fail('RUN_ALREADY_CREATED', 'BROWSER_OPERATION_CONFLICT', 409);
    const e = value.record.envelope, path = value._scope.path, sourceFiles = new Map();
    for (const entry of e.contract.sourceEvidence) {
      const c = value._scope.readFile(entry.file, limits.evidenceFileBytes, false, true);
      if (c.bytes.length !== entry.bytes || c.sha256 !== entry.sha256) fail('SOURCE_FILES_CHANGED'); sourceFiles.set(entry.sourceFile, Buffer.from(c.bytes));
    }
    const head = validateBrowserOperationHead({ schemaVersion: 1, operationId, runId: e.runId, taskId: e.taskId,
      dispatchSha256: value.record.sha256, status: 'running', gate: 'blocked', createdAt: e.acceptedAt,
      updatedAt: new Date().toISOString(), reportSha256: null, reasonCode: null }, value.record);
    guard(); publishFile(path, 'head.json', encode(head), () => { guard(); value._scope.current(); });
    return { runId: e.runId, taskId: e.taskId, outputDir: join(path, 'evidence'), contract: e.contract, sourceFiles,
      record: value.record, head };
  }); }
  function finishRun(operationId, raw, { assertActive } = {}) { return boundary(() => {
    const guard = synchronousGuard(assertActive), value = readInternal(operationId, false);
    if (!value || value.state !== 'running') fail('RUN_NOT_RUNNING', 'BROWSER_OPERATION_CONFLICT', 409);
    const e = value.record.envelope, report = validateBrowserOperationReport(raw, value.record), index = new Map();
    const references = new Set([...e.contract.sourceEvidence.map(v => v.file),
      ...report.checks.flatMap(c => Object.values(c.evidence ?? {}).filter(v => typeof v === 'string'))]);
    if (references.size > limits.evidenceFiles) fail('EVIDENCE_BUDGET');
    let total = 0;
    for (const file of references) {
      if (!fileName(file)) fail('EVIDENCE_NAME_INVALID');
      const captured = value._scope.readFile(file, limits.evidenceFileBytes, false, true); total += captured.bytes.length;
      if (total > limits.evidenceBytes) fail('EVIDENCE_BUDGET'); index.set(file, { file, bytes: captured.bytes.length, sha256: captured.sha256 });
    }
    for (const s of e.contract.sourceEvidence) if (!same(index.get(s.file), { file: s.file, bytes: s.bytes, sha256: s.sha256 })) fail('SOURCE_FILES_CHANGED');
    const verifierNames = ['browser-operation-schema.mjs', 'browser-operation-store.mjs', 'browser-fixed-contract.mjs', 'browser-fixed-runner.mjs',
      'runner.mjs', 'identity.mjs', 'report.mjs', '../verify/compare.mjs'];
    const verifier = verifierNames.map(file => boundedFile(fileURLToPath(new URL(file, import.meta.url)), limits.jsonBytes));
    const verifierFingerprint = hashAcceptanceValue(verifier.map((c, i) => ({ file: verifierNames[i], sha256: c.sha256 })));
    const complete = validateBrowserOperationReport(summarizeAcceptanceReport({ ...report, operationId, taskId: e.taskId,
      dispatchSha256: value.record.sha256, contractFingerprint: e.contractFingerprint, verifierFingerprint,
      evidenceManifest: [...index.values()].sort((a, b) => a.file.localeCompare(b.file)) }), value.record);
    const reportBytes = encode(complete); if (reportBytes.length > limits.jsonBytes) fail('JSON_BUDGET');
    const guardAll = () => { guard(); value._scope.current(); for (const c of verifier) {
      const now = boundedFile(c.path, c.maximum); if (!sameFile(now.stat, c.stat) || !now.bytes.equals(c.bytes)) fail('VERIFIER_CHANGED'); } guard(); };
    guardAll(); publishFile(value._scope.path, 'report.json', reportBytes, guardAll);
    const head = validateBrowserOperationHead({ ...value.head, status: 'completed', gate: complete.gate,
      reportSha256: sha(reportBytes), updatedAt: new Date().toISOString() }, value.record);
    publishFile(value._scope.path, 'head.json', encode(head), () => { guardAll();
      if (!boundedFile(join(value._scope.path, 'report.json'), limits.jsonBytes).bytes.equals(reportBytes)) fail('REPORT_CHANGED'); }, value._headCapture);
    try { return readInternal(operationId); }
    catch (cause) { cause.writeMayHaveCommitted = true; throw cause; }
  }); }
  function settleRun(operationId, { status, reasonCode } = {}, { assertHeld } = {}) { return boundary(() => {
    if (!['failed', 'interrupted'].includes(status) || !STOP.has(reasonCode)) fail('INVALID_SETTLEMENT', 'INVALID_INPUT', 400);
    const guard = synchronousGuard(assertHeld), value = readInternal(operationId, false);
    if (!value) fail('OPERATION_MISSING', 'NOT_FOUND', 404);
    if (value.head && value.state !== 'running') return value;
    if (!value.head) return value; // A prepared record is never promoted during settlement/recovery.
    const head = validateBrowserOperationHead({ ...value.head, status, reasonCode, gate: 'blocked', reportSha256: null,
      updatedAt: new Date().toISOString() }, value.record);
    guard(); publishFile(value._scope.path, 'head.json', encode(head), () => { guard(); value._scope.current(); }, value._headCapture);
    try { return readInternal(operationId, false); }
    catch (cause) { cause.writeMayHaveCommitted = true; throw cause; }
  }); }
  function readEvidence(operationId, file) { return boundary(() => {
    if (!fileName(file)) fail('INVALID_EVIDENCE', 'INVALID_INPUT', 400);
    const value = readInternal(operationId); if (!value) fail('OPERATION_MISSING', 'NOT_FOUND', 404);
    if (value.state !== 'completed' || !value.files.has(file)) fail('EVIDENCE_UNAVAILABLE', 'NOT_FOUND', 404);
    const entry = value.report.evidenceManifest.find(v => v.file === file);
    return { file, bytes: Buffer.from(value.files.get(file)), sha256: entry.sha256,
      contentType: file.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8' };
  }); }
  function recover() { return boundary(() => {
    const decisions = inspectInventory(true),
      values = decisions.filter(v => v.kind === 'recorded').map(v => v.value);
    // Whole-batch preflight before any write; partial reports/evidence stay opaque.
    const plans = values.filter(value => value.state === 'running').map(value => {
      const head = validateBrowserOperationHead({ ...value.head, status: 'interrupted', reasonCode: 'ENGINE_RESTARTED',
        gate: 'blocked', reportSha256: null, updatedAt: new Date().toISOString() }, value.record), bytes = encode(head);
      if (bytes.length > 64 * 1024) fail('JSON_BUDGET'); return { value, bytes };
    });
    for (const decision of decisions) currentDecision(decision);
    let interrupted = 0;
    for (const { value, bytes } of plans) {
      try { publishFile(value._scope.path, 'head.json', bytes, () => value._scope.current(), value._headCapture); interrupted++; }
      catch (cause) { if (interrupted) cause.writeMayHaveCommitted = true; throw cause; }
    }
    return { schemaVersion: 1, inspected: decisions.length, interrupted, prepared: values.filter(v => v.state === 'prepared').length };
  }); }
  function observationValue(after, before, beforeObservationSha256, inheritedOrigins = new Map()) {
    const e = after.record.envelope, a = before?.report?.checks ?? [], b = after.report.checks;
    const groups = new Map();
    for (const [side, checks] of [['before', a], ['after', b]]) for (const check of checks) {
      if (!check.identity) continue;
      const key = check.identity.contextKey;
      if (!groups.has(key)) groups.set(key, {});
      if (groups.get(key)[side]) fail('DUPLICATE_CHECK_IDENTITY'); groups.get(key)[side] = check;
    }
    // Keep the first verified BUG identity through later pass, blocked and missing
    // reports. An inherited issue is compared against that original oracle and
    // verifier, rather than requiring the immediately previous check to fail.
    const origins = new Map(inheritedOrigins);
    for (const [side, value] of [['before', before], ['after', after]]) for (const check of value?.report?.checks ?? []) {
      if (!isBug(check) || !check.identity) continue;
      const bugKey = browserCheckBugKey(value.record, check), bugId = 'bug-' + bugKey;
      if (!origins.has(bugId)) origins.set(bugId, { bugKey, side, check: copy({ id: check.id, title: check.title ?? check.id,
        route: check.route, identity: check.identity, status: 'failed', verdict: 'bug' }),
      report: { verifierFingerprint: value.report.verifierFingerprint } });
    }
    if (origins.size > limits.checks) fail('OBSERVATION_CAPACITY');
    const observations = [];
    for (const [bugId, origin] of origins) {
      const check = origin.check, bugKey = origin.bugKey, pair = groups.get(check.identity.contextKey) ?? {};
      const inherited = inheritedOrigins.has(bugId);
      const matchingBefore = pair.before && before && browserCheckBugKey(before.record, pair.before) === bugKey ? pair.before : undefined;
      const relation = inherited || origin.side === 'before'
        ? browserCheckRelation(check, pair.after, origin.report, after.report)
        : browserCheckRelation(matchingBefore, pair.after, before?.report, after.report);
      observations.push({ bugId: 'bug-' + bugKey, bugKey, checkId: pair.after?.id ?? null, beforeCheckId: pair.before?.id ?? null,
        title: String(check.title ?? check.id).slice(0, 240), route: check.route, facet: check.identity.facet,
        viewport: copy(check.identity.viewport), identity: copy(check.identity), status: pair.after?.status ?? 'missing',
        verdict: pair.after?.verdict ?? 'unverified', relation, evidenceReferences: copy(pair.after?.evidence ?? {}) });
    }
    const observation = { schemaVersion: 1, kind: 'browser-check-observation', granularity: 'check', projectId: e.project.id,
      operationId: e.operationId, runId: e.runId, reportSha256: after.head.reportSha256, dispatchSha256: after.record.sha256,
      candidateId: e.candidate.id, contentDigest: e.candidate.contentDigest, targetReleaseId: e.targetRelease.id,
      beforeOperationId: before?.operationId ?? null, beforeObservationSha256,
      recordedAt: new Date().toISOString(), observations };
    return { observation, origins };
  }
  function readObservation(value) {
    const capture = value._scope.readFile('observations.json', limits.jsonBytes, true);
    if (!capture) return null;
    const observed = parse(capture), e = value.record.envelope;
    if (observed.schemaVersion !== 1 || observed.kind !== 'browser-check-observation' || observed.operationId !== e.operationId
      || observed.projectId !== e.project.id || observed.runId !== e.runId || observed.reportSha256 !== value.head?.reportSha256
      || observed.dispatchSha256 !== value.record.sha256 || !Array.isArray(observed.observations)
      || observed.beforeObservationSha256 !== null && !browserOperationHash(observed.beforeObservationSha256)
      || observed.beforeOperationId === null && observed.beforeObservationSha256 !== null) fail('OBSERVATION_INVALID');
    value._observationCapture = capture;
    return observed;
  }
  function observationBefore(after, beforeOperationId) {
    if (beforeOperationId !== null && (!isBrowserOperationId(beforeOperationId) || beforeOperationId === after.operationId)) fail('OBSERVATION_INVALID');
    const before = beforeOperationId ? readInternal(beforeOperationId) : null;
    if (beforeOperationId && (!before || before.state !== 'completed' || before.projectId !== after.projectId
      || before.record.envelope.candidate.contentDigest !== after.record.envelope.candidate.contentDigest
      || before.record.envelope.acceptedAt > after.record.envelope.acceptedAt)) fail('INCOMPATIBLE_PAIR', 'BROWSER_OPERATION_CONFLICT', 409);
    return before;
  }
  const observationContext = () => ({ active: new Set(), verified: new Map(), scopes: new Map() });
  function trackObservation(value, context) {
    if (!value) return;
    if (context.scopes.has(value.operationId)) {
      if (value._observationCapture) context.scopes.set(value.operationId, value._scope);
      return;
    }
    if (context.scopes.size >= limits.operations) fail('OBSERVATION_CAPACITY');
    context.scopes.set(value.operationId, value._scope);
  }
  function currentObservations(context) { for (const scope of context.scopes.values()) scope.current(); }
  function verifyObservation(after, observation, context = observationContext()) {
    trackObservation(after, context);
    const digest = after._observationCapture?.sha256, cached = context.verified.get(after.operationId);
    if (cached) { if (cached.digest !== digest) fail('OBSERVATION_CHANGED'); return cached.origins; }
    if (context.active.has(after.operationId)) fail('OBSERVATION_CYCLE');
    if (context.active.size >= MAX_OBSERVATION_LINEAGE_DEPTH) fail('OBSERVATION_DEPTH');
    context.active.add(after.operationId);
    try {
      const before = observationBefore(after, observation.beforeOperationId); trackObservation(before, context);
      if (before && context.active.has(before.operationId)) fail('OBSERVATION_CYCLE');
      let inheritedOrigins = new Map();
      if (observation.beforeObservationSha256 !== null) {
        const inherited = before && readObservation(before);
        if (!inherited || before._observationCapture.sha256 !== observation.beforeObservationSha256) fail('OBSERVATION_LINEAGE_CHANGED');
        inheritedOrigins = verifyObservation(before, inherited, context);
      }
      const { observation: rebuilt, origins } = observationValue(after, before, observation.beforeObservationSha256, inheritedOrigins);
      rebuilt.recordedAt = observation.recordedAt;
      if (!same(rebuilt, observation) || typeof observation.recordedAt !== 'string'
        || !Number.isFinite(Date.parse(observation.recordedAt)) || new Date(observation.recordedAt).toISOString() !== observation.recordedAt) fail('OBSERVATION_CHANGED');
      after._scope.current(); before?._scope.current();
      context.verified.set(after.operationId, { digest, origins }); return origins;
    } finally { context.active.delete(after.operationId); }
  }
  function registerResult(operationId, { beforeOperationId = null } = {}) { return boundary(() => {
    const after = readInternal(operationId); if (!after || after.state !== 'completed') fail('RUN_NOT_COMPLETE', 'BROWSER_OPERATION_CONFLICT', 409);
    if (beforeOperationId !== null && (!isBrowserOperationId(beforeOperationId) || beforeOperationId === operationId)) fail('INVALID_PAIR', 'INVALID_INPUT', 400);
    const previous = readObservation(after), context = observationContext(); trackObservation(after, context);
    if (previous) {
      verifyObservation(after, previous, context);
      if (previous.beforeOperationId !== beforeOperationId) fail('OBSERVATION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409);
      currentObservations(context); return { ...previous, replayed: true };
    }
    const before = observationBefore(after, beforeOperationId); trackObservation(before, context);
    const inherited = before && readObservation(before), beforeObservationSha256 = before?._observationCapture?.sha256 ?? null;
    context.active.add(operationId);
    const inheritedOrigins = inherited ? verifyObservation(before, inherited, context) : new Map();
    context.active.delete(operationId);
    const { observation: value } = observationValue(after, before, beforeObservationSha256, inheritedOrigins), bytes = encode(value);
    if (bytes.length > limits.jsonBytes) fail('OBSERVATION_BUDGET');
    publishFile(after._scope.path, 'observations.json', bytes, () => currentObservations(context));
    return { ...value, replayed: false };
  }); }
  function ledger(projectId) { return boundary(() => {
    if (typeof projectId !== 'string' || !/^ap-[0-9a-f-]{36}$/.test(projectId)) fail('INVALID_PROJECT', 'INVALID_INPUT', 400);
    const registered = [], context = observationContext(), decisions = inspectInventory();
    for (const decision of decisions) {
      if (decision.kind !== 'recorded') continue;
      const metadata = decision.value; if (metadata.projectId !== projectId || metadata.state !== 'completed') continue;
      const operationId = metadata.operationId;
      const value = readInternal(operationId), observation = readObservation(value);
      if (observation) { verifyObservation(value, observation, context); registered.push({ observation, acceptedAt: value.record.envelope.acceptedAt });
      }
    }
    registered.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt)
      || a.observation.recordedAt.localeCompare(b.observation.recordedAt) || a.observation.operationId.localeCompare(b.observation.operationId));
    const entries = registered.map(v => v.observation), issues = new Map();
    for (const entry of entries) for (const observation of entry.observations) {
      const issue = issues.get(observation.bugId) ?? { bugId: observation.bugId, bugKey: observation.bugKey,
        projectId, candidateId: entry.candidateId, contentDigest: entry.contentDigest,
        title: observation.title, route: observation.route, facet: observation.facet,
        viewport: copy(observation.viewport), identity: copy(observation.identity), status: 'unverified',
        lastVerifiedState: 'open', closesBusinessIssue: false, history: [] };
      let relation = observation.relation;
      if (relation === 'verified_passed') issue.status = issue.lastVerifiedState = 'verified_passed';
      else if (observation.status === 'failed' && observation.verdict === 'bug' && relation !== 'incomparable') {
        if (issue.lastVerifiedState === 'verified_passed') relation = 'reopened';
        issue.status = issue.lastVerifiedState = relation === 'reopened' || issue.lastVerifiedState === 'reopened' ? 'reopened' : 'open';
      } else issue.status = 'unverified';
      issue.latestOperationId = entry.operationId; issue.latestTargetReleaseId = entry.targetReleaseId;
      issue.history.push({ operationId: entry.operationId, beforeOperationId: entry.beforeOperationId,
        reportSha256: entry.reportSha256, relation, status: observation.status, verdict: observation.verdict, recordedAt: entry.recordedAt });
      issues.set(observation.bugId, issue);
    }
    currentObservations(context); for (const decision of decisions) currentDecision(decision);
    return { schemaVersion: 1, kind: 'browser-check-ledger', granularity: 'check', projectId,
      scope: 'explicit-operation-observations', closesBugs: false, entries, issues: [...issues.values()] };
  }); }
  function boundary(fn) {
    try { owned(); return fn(); }
    catch (cause) {
      if (cause instanceof BrowserOperationError || cause instanceof AcceptanceCatalogError
        || ['ACCEPTANCE_OWNER_LOST', 'ACCEPTANCE_OWNER_UNAVAILABLE'].includes(cause.code)) throw cause;
      const error = new BrowserOperationError(); if (cause.writeMayHaveCommitted) error.writeMayHaveCommitted = true; throw error;
    }
  }
  return Object.freeze({ read, inspectDecision, list, publish, publishRejection, createRun, finishRun, settleRun, readEvidence, recover, registerResult, ledger });
}
