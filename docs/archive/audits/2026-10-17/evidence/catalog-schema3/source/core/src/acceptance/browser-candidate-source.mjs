/**
 * Private Browser source capture. No writes, recovery, network or runner launch.
 * The caller supplies an already acquired owner; side selection and eligibility
 * belong to the pure Browser projector. Both sides' actual references are read.
 * Captured Buffers never belong in snapshots, catalogs, APIs or AI inputs.
 * Byte fences describe a bounded capture, not an atomic multi-file snapshot or
 * a permanent capability to use a mutable directory as an approved baseline.
 */
import { constants, openSync, closeSync, readSync, lstatSync, fstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { types } from 'node:util';
import { ACCEPTANCE_ROOT, ACCEPTANCE_SNAPSHOT_LIMITS } from './constants.mjs';
import { AcceptanceCatalogError } from './catalog-schema.mjs';
import { assertAcceptanceOwner, AcceptanceOwnerError } from './owner.mjs';
import { summarizeAcceptanceReport } from './report.mjs';
import { createLegacyAcceptanceReadScope } from './managed-access.mjs';

export const BROWSER_CANDIDATE_SOURCE_LIMITS = Object.freeze({ ...ACCEPTANCE_SNAPSHOT_LIMITS,
  jsonDepth: 80, jsonNodes: 400_000, jsonCharacters: 32 * 1024 * 1024 });
const RUN_ID = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,234}\.(?:png|json)$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = Object.freeze(['baselineScreenshot', 'targetScreenshot', 'baselineDetails', 'targetDetails', 'baselineRepeat', 'targetRepeat']);
const NULLABLE_ROLES = new Set(['baselineScreenshot', 'targetScreenshot', 'baselineRepeat', 'targetRepeat']);
const MESSAGES = Object.freeze({
  INVALID_INPUT: '来源读取参数无效，请核对输入。',
  NOT_FOUND: '来源运行不存在。',
  SOURCE_NOT_ELIGIBLE: '来源不是可读取的浏览器运行。',
  SOURCE_INTEGRITY_FAILED: '来源材料无法安全核验，请检查原运行。',
  ACCEPTANCE_OWNER_UNAVAILABLE: '来源读取没有可用的验收目录所有者。',
  ACCEPTANCE_OWNER_LOST: '验收目录所有权或目录身份已变化，请停止当前操作。',
});
class SourceReadError extends AcceptanceCatalogError {}
const fail = (reason, code = 'SOURCE_INTEGRITY_FAILED', status = 409) => {
  throw new SourceReadError(code, status, MESSAGES[code], { reason });
};
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => pathKey(a) === pathKey(b);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Keep the reader's own cross-call directory pin in addition to the acquired
// owner's independent acquisition-time directory fence.
const ownerRoots = new WeakMap();

function limitsOf(input) {
  if (!plain(input)) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
  const descriptors = Object.getOwnPropertyDescriptors(input), limits = { ...BROWSER_CANDIDATE_SOURCE_LIMITS };
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !Object.hasOwn(limits, key)
      || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0
      || descriptor.value > limits[key]) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
    limits[key] = descriptor.value;
  }
  return limits;
}

function jsonObject(bytes, limits) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('SOURCE_JSON_INVALID'); }
  if (!plain(value)) fail('SOURCE_JSON_INVALID');
  // Parsed JSON has no hooks. Bound traversal before stringify/summary/projector
  // can recurse into an untrusted legacy head, and bound the work queue too.
  const pending = [[value, 0]]; let nodes = 0, characters = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) fail('SOURCE_JSON_COMPLEXITY_EXCEEDED');
    if (typeof item === 'string') characters += item.length;
    else if (item !== null && typeof item === 'object') {
      for (const key of Object.keys(item)) {
        characters += key.length;
        if (characters > limits.jsonCharacters || pending.length >= limits.jsonNodes - nodes) fail('SOURCE_JSON_COMPLEXITY_EXCEEDED');
        pending.push([item[key], depth + 1]);
      }
    }
    if (characters > limits.jsonCharacters) fail('SOURCE_JSON_COMPLEXITY_EXCEEDED');
  }
  return value;
}

function inside(root, path) {
  const part = relative(root, path);
  return !!part && !part.startsWith('..') && !isAbsolute(part);
}

/** Direct regular files only; linked files are unsafe even within this run. */
function fileIdentity(path, runDir) {
  if (!inside(runDir, path)) fail('SOURCE_PATH_INVALID');
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || !samePath(realpathSync(path), path)) fail('SOURCE_PATH_INVALID');
  return stat;
}

function pinDirectories(root, owner, runId) {
  const assertOwner = () => {
    try { if (assertAcceptanceOwner(owner) !== true) fail('OWNER_LOST', 'ACCEPTANCE_OWNER_LOST', 503); }
    catch (cause) {
      if (cause instanceof SourceReadError) throw cause;
      if (cause instanceof AcceptanceOwnerError && cause.code === 'ACCEPTANCE_OWNER_LOST') fail('OWNER_LOST', 'ACCEPTANCE_OWNER_LOST', 503);
      fail('OWNER_REQUIRED', 'ACCEPTANCE_OWNER_UNAVAILABLE', 503);
    }
  };
  assertOwner();
  // The brand check precedes all reflection on owner. Genuine owners are frozen
  // local records; a proxy or a method-shaped facade cannot supply authority.
  // Aliases carry no authority: only their continued resolution to the pinned
  // canonical directory matters. Rebuilding an alias to that same directory is
  // allowed; retargeting it or replacing the canonical directory is not.
  const ownerPath = resolve(owner.root), requested = resolve(root);
  let actual, rootStat;
  try {
    actual = realpathSync(requested);
    const ownerActual = realpathSync(ownerPath);
    rootStat = lstatSync(actual, { bigint: true });
    if (!samePath(actual, ownerActual) || !samePath(ownerPath, ownerActual)
      || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('SOURCE_ROOT_INVALID', 'ACCEPTANCE_OWNER_LOST', 503);
  } catch (cause) {
    if (cause instanceof SourceReadError) throw cause;
    fail('SOURCE_ROOT_INVALID', 'ACCEPTANCE_OWNER_LOST', 503);
  }
  const previous = ownerRoots.get(owner);
  if (previous && (!samePath(previous.actual, actual) || !sameIdentity(previous.stat, rootStat))) {
    fail('SOURCE_ROOT_CHANGED', 'ACCEPTANCE_OWNER_LOST', 503);
  }
  ownerRoots.set(owner, { actual, stat: rootStat });
  const runDir = join(actual, runId);
  let runStat;
  try { runStat = lstatSync(runDir, { bigint: true }); }
  catch (cause) { if (cause?.code === 'ENOENT') fail('SOURCE_RUN_MISSING', 'NOT_FOUND', 404); throw cause; }
  if (!runStat.isDirectory() || runStat.isSymbolicLink() || !inside(actual, runDir)
    || !samePath(realpathSync(runDir), runDir)) fail('SOURCE_RUN_PATH_INVALID');
  const assertFence = () => {
    assertOwner();
    try {
      const currentRoot = realpathSync(requested), currentOwner = realpathSync(ownerPath);
      const rootNow = lstatSync(actual, { bigint: true });
      if (!samePath(currentRoot, actual) || !samePath(currentOwner, actual)
        || !rootNow.isDirectory() || rootNow.isSymbolicLink() || !sameIdentity(rootStat, rootNow)) {
        fail('SOURCE_ROOT_CHANGED', 'ACCEPTANCE_OWNER_LOST', 503);
      }
      const runNow = lstatSync(runDir, { bigint: true });
      if (!runNow.isDirectory() || runNow.isSymbolicLink() || !sameIdentity(runStat, runNow)
        || !samePath(realpathSync(runDir), runDir)) fail('SOURCE_RUN_CHANGED');
    } catch (cause) {
      if (cause instanceof SourceReadError) throw cause;
      fail('SOURCE_DIRECTORY_UNAVAILABLE');
    }
  };
  assertFence();
  return { runDir, actual, assertFence };
}

/** Fixed allocation from bounded fstat, followed by EOF and path/FD fences. */
function safeRead(path, { runDir, assertFence }, maxBytes, expected) {
  assertFence();
  const before = fileIdentity(path, runDir);
  if (expected && !sameFile(before, expected)) fail('SOURCE_FILE_CHANGED');
  if (before.size < 0n || before.size > BigInt(maxBytes)) fail('SOURCE_BUDGET_EXCEEDED');
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) fail('SOURCE_FILE_CHANGED');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) fail('SOURCE_FILE_CHANGED');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) fail('SOURCE_FILE_CHANGED');
    if (!sameFile(opened, fstatSync(descriptor, { bigint: true }))
      || !sameFile(opened, fileIdentity(path, runDir))) fail('SOURCE_FILE_CHANGED');
    assertFence();
    return { bytes, stat: opened };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function sourceReferences(report, limits) {
  if (!Array.isArray(report.checks) || report.checks.length > limits.checks
    || !Array.isArray(report.evidenceManifest) || report.evidenceManifest.length > limits.evidenceFiles) fail('SOURCE_BUDGET_EXCEEDED');
  const indexed = new Map(), indexedNames = new Set(), references = new Set();
  for (const entry of report.evidenceManifest) {
    if (!plain(entry) || Object.keys(entry).sort().join(',') !== 'bytes,file,sha256'
      || typeof entry.file !== 'string' || !EVIDENCE_NAME.test(entry.file)
      || ['manifest.json', 'report.json'].includes(entry.file.toLowerCase())
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA256.test(entry.sha256 ?? '')
      || indexedNames.has(entry.file.toLowerCase())) fail('SOURCE_EVIDENCE_INDEX_INVALID');
    indexed.set(entry.file, { bytes: entry.bytes, sha256: entry.sha256 });
    indexedNames.add(entry.file.toLowerCase());
  }
  for (const check of report.checks) {
    if (!plain(check) || !plain(check.evidence)) fail('SOURCE_EVIDENCE_REFERENCE_INVALID');
    const keys = Object.keys(check.evidence);
    if (ROLES.some(role => !Object.hasOwn(check.evidence, role))
      || keys.some(role => !ROLES.includes(role) && role !== 'diff')) fail('SOURCE_EVIDENCE_REFERENCE_INVALID');
    for (const [role, file] of Object.entries(check.evidence)) {
      if (file === null && NULLABLE_ROLES.has(role)) continue;
      if (typeof file !== 'string' || !EVIDENCE_NAME.test(file)
        || ['manifest.json', 'report.json'].includes(file.toLowerCase())) fail('SOURCE_EVIDENCE_REFERENCE_INVALID');
      references.add(file);
    }
  }
  if (references.size > limits.evidenceFiles) fail('SOURCE_BUDGET_EXCEEDED');
  let total = 0;
  for (const file of references) {
    const entry = indexed.get(file);
    if (!entry) fail('SOURCE_EVIDENCE_NOT_INDEXED');
    total += entry.bytes;
    if (entry.bytes > limits.evidenceFileBytes || total > limits.evidenceBytes) fail('SOURCE_BUDGET_EXCEEDED');
  }
  return { indexed, references };
}

/** Rebuild only snapshot integrity; source qualification stays in projection. */
function checkedSnapshot(manifest, report, reportBytes, references, indexed) {
  const reportSha256 = hash(reportBytes);
  if (manifest.status !== 'completed' || report.status !== 'completed'
    || !SHA256.test(manifest.reportSha256 ?? '') || manifest.reportSha256 !== reportSha256
    || !plain(manifest.plan) || hash(JSON.stringify(manifest.plan)) !== report.planFingerprint
    || report.targetUrl !== manifest.targetUrl || report.baselineUrl !== manifest.baselineUrl) fail('SOURCE_SNAPSHOT_INVALID');
  const summarized = summarizeAcceptanceReport(report);
  if (JSON.stringify(summarized.summary) !== JSON.stringify(report.summary) || summarized.gate !== report.gate
    || manifest.gate !== report.gate || JSON.stringify(manifest.summary) !== JSON.stringify(report.summary)) fail('SOURCE_SNAPSHOT_INVALID');
  return { manifest, report, integrity: { valid: true, evidenceVerified: true, errors: [],
    verifiedFiles: references.size, verifiedBytes: [...references].reduce((sum, file) => sum + indexed.get(file).bytes, 0), reportSha256 } };
}

/**
 * Private synchronous materializer. All recognized nullable roles remain in the
 * captured report. The pure projector alone decides whether an explicit side
 * has complete, healthy source observations and can produce a new oracle.
 */
export function readBrowserCandidateSource(runId, options = {}) {
  try {
    if (!plain(options)) fail('INVALID_SOURCE_INPUT', 'INVALID_INPUT', 400);
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !['root', 'owner', 'limits'].includes(key)
        || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) {
        fail('INVALID_SOURCE_INPUT', 'INVALID_INPUT', 400);
      }
    }
    const root = descriptors.root?.value === undefined ? ACCEPTANCE_ROOT : descriptors.root.value;
    const owner = descriptors.owner?.value;
    const inputLimits = descriptors.limits?.value === undefined ? {} : descriptors.limits.value;
    if (typeof runId !== 'string' || !RUN_ID.test(runId) || typeof root !== 'string' || !root.trim()) {
      fail('INVALID_SOURCE_INPUT', 'INVALID_INPUT', 400);
    }
    const limits = limitsOf(inputLimits), directories = pinDirectories(root, owner, runId);
    let scope;
    try { scope = createLegacyAcceptanceReadScope(directories.actual); }
    catch { fail('SOURCE_MANAGED_DISPATCH_UNAVAILABLE'); }
    const assertUnmanaged = (manifest, report) => {
      try { scope.assertUnmanaged(runId, manifest, report); }
      catch { fail('SOURCE_MANAGED_UNSUPPORTED', 'SOURCE_NOT_ELIGIBLE', 409); }
    };
    assertUnmanaged();
    const manifestPath = join(directories.runDir, 'manifest.json'), reportPath = join(directories.runDir, 'report.json');
    const originalManifest = safeRead(manifestPath, directories, limits.jsonBytes);
    const originalReport = safeRead(reportPath, directories, limits.jsonBytes);
    const manifest = jsonObject(originalManifest.bytes, limits), report = jsonObject(originalReport.bytes, limits);
    assertUnmanaged(manifest, report);
    if (manifest.runId !== runId || report.runId !== runId) fail('SOURCE_RUN_IDENTITY_INVALID');
    if (!['mirror', 'regression'].includes(manifest.mode) || report.mode !== manifest.mode) fail('SOURCE_MODE_UNSUPPORTED', 'SOURCE_NOT_ELIGIBLE', 409);
    const { indexed, references } = sourceReferences(report, limits), pins = new Map();
    for (const file of references) {
      directories.assertFence();
      const stat = fileIdentity(join(directories.runDir, file), directories.runDir);
      if (stat.size !== BigInt(indexed.get(file).bytes)) fail('SOURCE_EVIDENCE_CHANGED');
      pins.set(file, stat);
    }
    const files = new Map([['manifest.json', originalManifest.bytes], ['report.json', originalReport.bytes]]);
    for (const file of [...references].sort()) {
      const entry = indexed.get(file);
      const captured = safeRead(join(directories.runDir, file), directories, limits.evidenceFileBytes, pins.get(file));
      if (captured.bytes.length !== entry.bytes || hash(captured.bytes) !== entry.sha256) fail('SOURCE_EVIDENCE_CHANGED');
      files.set(file, captured.bytes);
    }
    const snapshot = checkedSnapshot(manifest, report, originalReport.bytes, references, indexed);
    for (const file of [...references].sort()) {
      const entry = indexed.get(file);
      const reread = safeRead(join(directories.runDir, file), directories, limits.evidenceFileBytes, pins.get(file));
      if (reread.bytes.length !== entry.bytes || hash(reread.bytes) !== entry.sha256
        || !reread.bytes.equals(files.get(file))) fail('SOURCE_EVIDENCE_CHANGED');
    }
    const finalManifest = safeRead(manifestPath, directories, limits.jsonBytes, originalManifest.stat);
    const finalReport = safeRead(reportPath, directories, limits.jsonBytes, originalReport.stat);
    if (!finalManifest.bytes.equals(originalManifest.bytes) || !finalReport.bytes.equals(originalReport.bytes)) fail('SOURCE_HEAD_CHANGED');
    const assertMetadata = () => {
      directories.assertFence();
      if (!sameFile(originalManifest.stat, fileIdentity(manifestPath, directories.runDir))
        || !sameFile(originalReport.stat, fileIdentity(reportPath, directories.runDir))) fail('SOURCE_HEAD_CHANGED');
      for (const [file, pinned] of pins) {
        if (!sameFile(pinned, fileIdentity(join(directories.runDir, file), directories.runDir))) fail('SOURCE_EVIDENCE_CHANGED');
      }
    };
    assertMetadata();
    try { scope.assertCurrent(); }
    catch { fail('SOURCE_MANAGED_DISPATCH_CHANGED'); }
    // The namespace recheck performs native reads too; fence this capture again
    // afterwards without adopting changed source facts or refreshing the scope.
    assertMetadata();
    directories.assertFence();
    return { snapshot, files };
  } catch (cause) {
    if (cause instanceof SourceReadError) throw cause;
    // No raw path, errno, parser message or arbitrary cause crosses this edge.
    fail('SOURCE_READ_FAILED');
  }
}
