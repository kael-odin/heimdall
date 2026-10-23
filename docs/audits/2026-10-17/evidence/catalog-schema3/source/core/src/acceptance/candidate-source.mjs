/**
 * Private Spec source material; no filesystem writes, network or worker launch.
 * Binding/project/release checks and side='source' belong to projector/catalog.
 *
 * Byte integrity is bounded and checked for the complete report reference set.
 * The private Map includes original manifest/report bytes and every referenced
 * evidence file. evidenceFiles/evidenceBytes count only referenced evidence;
 * jsonBytes separately bounds each head. Role and JSON evidence semantics are
 * verified by the pure projector against these captured bytes.
 * Captured Buffers are private return data for the projector, never properties
 * on the old snapshot, catalog records, API responses or AI inputs. A valid
 * snapshot is not source eligibility: this reader does not require approval or
 * a passed gate, and leaves omissions and requirement semantics to projection.
 */
import { constants, openSync, closeSync, readSync, lstatSync, fstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { types } from 'node:util';
import { ACCEPTANCE_ROOT, ACCEPTANCE_SNAPSHOT_LIMITS } from './store.mjs';
import { AcceptanceCatalogError } from './catalog-schema.mjs';
import { summarizeAcceptanceReport } from './report.mjs';
import { createLegacyAcceptanceReadScope } from './managed-access.mjs';

export const SPEC_CANDIDATE_SOURCE_LIMITS = Object.freeze({ ...ACCEPTANCE_SNAPSHOT_LIMITS });
const RUN_ID = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,234}\.(?:png|json)$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MESSAGES = Object.freeze({
  INVALID_INPUT: '来源读取参数无效，请核对输入。',
  NOT_FOUND: '来源运行不存在。',
  SOURCE_NOT_ELIGIBLE: '来源不是可读取的需求型运行。',
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
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ownerRoots = new WeakMap();

function limitsOf(input) {
  if (!plain(input)) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !Object.hasOwn(SPEC_CANDIDATE_SOURCE_LIMITS, key)
      || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0
      || descriptor.value > SPEC_CANDIDATE_SOURCE_LIMITS[key]) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
  }
  return { ...SPEC_CANDIDATE_SOURCE_LIMITS, ...input };
}

function jsonObject(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(value)) fail('SOURCE_JSON_INVALID');
    return value;
  } catch (cause) { if (cause instanceof SourceReadError) throw cause; fail('SOURCE_JSON_INVALID'); }
}

function inside(root, path) {
  const part = relative(root, path);
  return !!part && !part.startsWith('..') && !isAbsolute(part);
}

/** Return only regular, direct files. A linked file inside the run is rejected too. */
function fileIdentity(path, runDir) {
  if (!inside(runDir, path)) fail('SOURCE_PATH_INVALID');
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) fail('SOURCE_PATH_INVALID');
  return stat;
}

function pinDirectories(root, owner, runId) {
  if (!plain(owner)) fail('OWNER_REQUIRED', 'ACCEPTANCE_OWNER_UNAVAILABLE', 503);
  const rootDescriptor = Object.getOwnPropertyDescriptor(owner, 'root');
  const checkDescriptor = Object.getOwnPropertyDescriptor(owner, 'assertOwned');
  if (!rootDescriptor || !Object.hasOwn(rootDescriptor, 'value') || typeof rootDescriptor.value !== 'string'
    || !rootDescriptor.value.trim() || !isAbsolute(rootDescriptor.value)
    || !checkDescriptor || !Object.hasOwn(checkDescriptor, 'value') || typeof checkDescriptor.value !== 'function') {
    fail('OWNER_REQUIRED', 'ACCEPTANCE_OWNER_UNAVAILABLE', 503);
  }
  const assertOwner = () => {
    try { checkDescriptor.value.call(owner); }
    catch { fail('OWNER_LOST', 'ACCEPTANCE_OWNER_LOST', 503); }
  };
  assertOwner();
  const requested = resolve(root), ownerPath = resolve(rootDescriptor.value);
  const actual = realpathSync(requested), ownerActual = realpathSync(ownerPath);
  const rootStat = lstatSync(actual, { bigint: true });
  if (!samePath(actual, ownerActual) || !samePath(ownerPath, ownerActual)
    || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('SOURCE_ROOT_INVALID', 'ACCEPTANCE_OWNER_LOST', 503);
  const previous = ownerRoots.get(owner);
  if (previous && (!samePath(previous.actual, actual) || !sameInode(previous.stat, rootStat))) {
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
        || !rootNow.isDirectory() || rootNow.isSymbolicLink() || !sameInode(rootStat, rootNow)) {
        fail('SOURCE_ROOT_CHANGED', 'ACCEPTANCE_OWNER_LOST', 503);
      }
      const runNow = lstatSync(runDir, { bigint: true });
      if (!runNow.isDirectory() || runNow.isSymbolicLink() || !sameInode(runStat, runNow)
        || !samePath(realpathSync(runDir), runDir)) fail('SOURCE_RUN_CHANGED');
    } catch (cause) {
      if (cause instanceof SourceReadError) throw cause;
      fail('SOURCE_DIRECTORY_UNAVAILABLE');
    }
  };
  assertFence();
  return { runDir, actual, assertFence };
}

/**
 * Fixed allocation from bounded fstat size; never readFileSync(fd), which could
 * consume an unexpectedly growing file. O_NOFOLLOW is additional protection
 * where supported; Windows still gets lstat/fstat/inode and final path checks.
 */
function safeRead(path, { runDir, assertFence }, maxBytes, expected) {
  assertFence();
  const before = fileIdentity(path, runDir);
  if (expected && !sameFile(before, expected)) fail('SOURCE_FILE_CHANGED');
  if (before.size > BigInt(maxBytes)) fail('SOURCE_BUDGET_EXCEEDED');
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) fail('SOURCE_FILE_CHANGED');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('SOURCE_FILE_CHANGED');
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
  const indexed = new Map(), references = new Set();
  for (const entry of report.evidenceManifest) {
    if (!plain(entry) || typeof entry.file !== 'string' || !EVIDENCE_NAME.test(entry.file)
      || ['manifest.json', 'report.json'].includes(entry.file.toLowerCase())
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA256.test(entry.sha256 ?? '')
      || indexed.has(entry.file)) fail('SOURCE_EVIDENCE_INDEX_INVALID');
    indexed.set(entry.file, { bytes: entry.bytes, sha256: entry.sha256 });
  }
  for (const check of report.checks) {
    if (!plain(check) || !plain(check.evidence)) fail('SOURCE_EVIDENCE_REFERENCE_INVALID');
    for (const file of Object.values(check.evidence)) {
      if (typeof file !== 'string' || !EVIDENCE_NAME.test(file)) fail('SOURCE_EVIDENCE_REFERENCE_INVALID');
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

/** Match store snapshot integrity using only bytes already read with bounds. */
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
 * Private synchronous source materializer. A completed failed/blocked Spec and
 * an unapproved source are readable; only the projector decides eligibility.
 * No private bytes are attached to snapshot. Callers must not serialize files.
 */
export function readSpecCandidateSource(runId, options = {}) {
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
    const scope = createLegacyAcceptanceReadScope(directories.actual);
    scope.assertUnmanaged(runId);
    const manifestPath = join(directories.runDir, 'manifest.json'), reportPath = join(directories.runDir, 'report.json');
    const originalManifest = safeRead(manifestPath, directories, limits.jsonBytes);
    const originalReport = safeRead(reportPath, directories, limits.jsonBytes);
    const manifest = jsonObject(originalManifest.bytes), report = jsonObject(originalReport.bytes);
    scope.assertUnmanaged(runId, manifest, report);
    if (manifest.runId !== runId || report.runId !== runId) fail('SOURCE_RUN_IDENTITY_INVALID');
    if (manifest.mode !== 'spec' || report.mode !== 'spec') fail('SOURCE_MODE_UNSUPPORTED', 'SOURCE_NOT_ELIGIBLE', 409);
    const { indexed, references } = sourceReferences(report, limits);
    const pins = new Map();
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
    // Every referenced file gets two bounded reads. Do not call the older
    // stat/readFileSync snapshot reader, which could allocate a growing file.
    for (const file of [...references].sort()) {
      const entry = indexed.get(file);
      const reread = safeRead(join(directories.runDir, file), directories, limits.evidenceFileBytes, pins.get(file));
      if (reread.bytes.length !== entry.bytes || hash(reread.bytes) !== entry.sha256
        || !reread.bytes.equals(files.get(file))) fail('SOURCE_EVIDENCE_CHANGED');
    }
    const finalManifest = safeRead(manifestPath, directories, limits.jsonBytes, originalManifest.stat);
    const finalReport = safeRead(reportPath, directories, limits.jsonBytes, originalReport.stat);
    if (!finalManifest.bytes.equals(originalManifest.bytes) || !finalReport.bytes.equals(originalReport.bytes)) fail('SOURCE_HEAD_CHANGED');
    directories.assertFence();
    if (!sameFile(originalManifest.stat, fileIdentity(manifestPath, directories.runDir))
      || !sameFile(originalReport.stat, fileIdentity(reportPath, directories.runDir))) fail('SOURCE_HEAD_CHANGED');
    for (const [file, pinned] of pins) {
      if (!sameFile(pinned, fileIdentity(join(directories.runDir, file), directories.runDir))) fail('SOURCE_EVIDENCE_CHANGED');
    }
    scope.assertCurrent();
    return { snapshot, files };
  } catch (cause) {
    if (cause instanceof SourceReadError) throw cause;
    // Do not retain cause/errno/message/absolute paths from fs, owner or parser.
    fail('SOURCE_READ_FAILED');
  }
}
