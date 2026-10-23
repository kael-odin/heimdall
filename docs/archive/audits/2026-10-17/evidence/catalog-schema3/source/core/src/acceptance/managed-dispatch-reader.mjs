/** Request-scoped, owner-free dispatch inventory. No writes, admission or repair.
 * One bounded capture fixes the namespace; later checks never refresh it.
 * Filesystem metadata fences are not a cross-file atomic snapshot or signature. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, isAbsolute } from 'node:path';
import { AcceptanceCatalogError, fields } from './catalog-schema.mjs';
import { isManagedSpecOperationId, managedSpecDispatchLimits, validateManagedSpecDispatchEnvelope } from './managed-dispatch-schema.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PUBLISHED = new RegExp(`^(ao-${UUID})\\.json$`), TEMPORARY = new RegExp(`^ao-${UUID}\\.${UUID}\\.tmp$`);
const RUN_ID = new RegExp(`^ac-${UUID}$`), SHA256 = /^[a-f0-9]{64}$/;
const contexts = new WeakMap();
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (reason, invalid = false) => {
  throw new AcceptanceCatalogError(invalid ? 'INVALID_INPUT' : 'MANAGED_DISPATCH_UNAVAILABLE', invalid ? 400 : 503,
    invalid ? '托管 Spec 只读上下文参数无效。' : '托管 Spec 准备记录无法完成完整性核验，原记录已保留。', { reason });
};
const badInput = reason => fail(reason, true);
const rootPath = root => {
  if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) badInput('INVALID_ROOT');
  return resolve(root);
};
const translated = fn => {
  try { return fn(); }
  catch (cause) { if (cause instanceof AcceptanceCatalogError) throw cause; fail('FILESYSTEM_FAILURE'); }
};

/** Validate the private brand and canonical root, then fence the current capture.
 * Duck-typed objects, proxies and a context from another root are not accepted. */
export function assertManagedSpecDispatchReadContext(context, root) {
  const state = contexts.get(context);
  if (!state) badInput('INVALID_READ_CONTEXT');
  if (!samePath(state.root, rootPath(root))) badInput('CONTEXT_ROOT_MISMATCH');
  return state.assertCurrent();
}

export function createManagedSpecDispatchReadContext(options) {
  return translated(() => {
    fields(options, ['root', 'limits'], ['root'], badInput);
    const root = rootPath(options.root), limits = managedSpecDispatchLimits(options.limits ?? {});
    const parent = join(root, 'managed-spec-dispatches'), directory = join(parent, 'v1');
    let invalidReason;
    // Optional absence belongs only to the initial lstat. A later realpath or
    // descriptor failure can never turn an observed component into an empty set.
    const identity = (path, directoryExpected, optional = false) => {
      let stat;
      try { stat = fs.lstatSync(path, { bigint: true }); }
      catch (cause) { if (optional && cause?.code === 'ENOENT') return null; throw cause; }
      if (stat.isSymbolicLink() || (directoryExpected ? !stat.isDirectory() : !stat.isFile())
        || !samePath(fs.realpathSync(path), path)) fail(directoryExpected ? 'DIRECTORY_IDENTITY_INVALID' : 'FILE_IDENTITY_INVALID');
      return stat;
    };
    const rootPin = identity(root, true, true);
    if (!rootPin) fail('ROOT_UNAVAILABLE');
    const parentPin = identity(parent, true, true), directoryPin = parentPin ? identity(directory, true, true) : null;
    const assertLayout = () => {
      const rootNow = identity(root, true, true);
      if (!rootNow || !sameIdentity(rootPin, rootNow)) fail('ROOT_CHANGED');
      const parentNow = identity(parent, true, true);
      if (!!parentPin !== !!parentNow || (parentPin && !sameIdentity(parentPin, parentNow))) fail('DIRECTORY_CHANGED');
      const directoryNow = parentNow ? identity(directory, true, true) : null;
      if (!!directoryPin !== !!directoryNow || (directoryPin && !sameFile(directoryPin, directoryNow))) fail('DIRECTORY_CHANGED');
    };
    assertLayout();
    const entries = new Map(), records = new Map(), runs = new Map(), tasks = new Set();
    // The initial enumeration fixes the inventory. Later enumerations compare
    // only names and never adopt or parse newly observed namespace material.
    if (directoryPin) {
      let handle, totalBytes = 0, dispatches = 0;
      try {
        handle = fs.opendirSync(directory);
        for (;;) {
          const entry = handle.readSync();
          if (!entry) break;
          if (entries.size >= limits.directoryEntries) fail('DIRECTORY_ENTRIES_EXCEEDED');
          if (entries.has(entry.name)) fail('DIRECTORY_CHANGED');
          const published = PUBLISHED.exec(entry.name);
          if (!published && !TEMPORARY.test(entry.name)) fail('UNKNOWN_DIRECTORY_ENTRY');
          const stat = identity(join(directory, entry.name), false);
          if (stat.size > BigInt(limits.jsonBytes)) fail('FILE_BYTES_EXCEEDED');
          totalBytes += Number(stat.size);
          if (totalBytes > limits.totalBytes) fail('TOTAL_BYTES_EXCEEDED');
          if (published && ++dispatches > limits.dispatches) fail('DISPATCH_COUNT_EXCEEDED');
          entries.set(entry.name, { name: entry.name, operationId: published?.[1], stat });
        }
      } finally { if (handle) handle.closeSync(); }
      assertLayout();
    }
    const assertNames = () => {
      if (!directoryPin) return;
      let handle;
      const seen = new Set();
      try {
        handle = fs.opendirSync(directory);
        for (;;) {
          const entry = handle.readSync();
          if (!entry) break;
          if (seen.size >= limits.directoryEntries) fail('DIRECTORY_ENTRIES_EXCEEDED');
          if (seen.has(entry.name) || !entries.has(entry.name)) fail('DIRECTORY_CHANGED');
          seen.add(entry.name);
        }
        if (seen.size !== entries.size) fail('DIRECTORY_CHANGED');
      } finally { if (handle) handle.closeSync(); }
    };
    const assertCurrentInternal = () => {
      assertLayout();
      // A same-tick directory edit may preserve every metadata field. Check
      // the fixed name set once per fence, with the same bounded entry budget.
      assertNames();
      // Filesystems can reuse the same timestamp within one clock tick. Metadata
      // alone cannot protect even a same-length rewrite or a negative run index.
      // Compare every original byte, including unaccepted temporary material.
      for (const entry of entries.values()) if (!safeRead(entry).equals(entry.bytes)) fail('FILE_CHANGED');
      for (const entry of entries.values()) if (!sameFile(entry.stat, identity(join(directory, entry.name), false))) fail('FILE_CHANGED');
      assertLayout();
      return true;
    };
    const safeRead = entry => {
      assertLayout();
      const path = join(directory, entry.name), before = identity(path, false);
      if (!sameFile(entry.stat, before)) fail('FILE_CHANGED');
      let descriptor;
      try {
        descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || !sameFile(before, opened)) fail('FILE_CHANGED');
        const bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
          if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) fail('FILE_CHANGED');
          offset += count;
        }
        if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0
          || !sameFile(opened, fs.fstatSync(descriptor, { bigint: true })) || !sameFile(opened, identity(path, false))) fail('FILE_CHANGED');
        assertLayout();
        return bytes;
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    };
    const capture = entry => {
      const first = safeRead(entry), second = safeRead(entry);
      if (!first.equals(second)) fail('FILE_CHANGED');
      return first;
    };
    for (const entry of [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const bytes = capture(entry);
      entry.bytes = bytes;
      // Orphans consume every entry/byte budget and get the same bounded reads,
      // but their contents never become accepted JSON or a reserved identity.
      if (!entry.operationId) continue;
      let envelope;
      try {
        envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        validateManagedSpecDispatchEnvelope(envelope, { limits });
      } catch { fail('STORED_ENVELOPE_INVALID'); }
      if (envelope.operationId !== entry.operationId) fail('STORED_OPERATION_MISMATCH');
      if (runs.has(envelope.runId)) fail('RESERVED_RUN_CONFLICT');
      if (tasks.has(envelope.taskId)) fail('RESERVED_TASK_CONFLICT');
      const sha256 = hash(bytes);
      const record = { bytes, sha256, entry, reference: Object.freeze({ operationId: envelope.operationId,
        dispatchId: envelope.dispatchId, runId: envelope.runId, taskId: envelope.taskId, sha256 }) };
      records.set(envelope.operationId, record); runs.set(envelope.runId, record); tasks.add(envelope.taskId);
    }
    assertCurrentInternal();
    const guarded = fn => (...args) => {
      if (invalidReason) fail(invalidReason);
      try { return fn(...args); }
      catch (cause) {
        if (cause instanceof AcceptanceCatalogError && cause.code === 'INVALID_INPUT') throw cause;
        invalidReason = cause instanceof AcceptanceCatalogError ? cause.details.reason : 'FILESYSTEM_FAILURE';
        fail(invalidReason);
      }
    };
    const recordCopy = record => record ? { envelope: JSON.parse(record.bytes.toString('utf8')),
      bytes: Buffer.from(record.bytes), sha256: record.sha256 } : null;
    const operation = operationId => { if (!isManagedSpecOperationId(operationId)) badInput('INVALID_OPERATION_ID'); };
    const assertCurrent = guarded(assertCurrentInternal);
    const context = Object.freeze({
      read: guarded(operationId => { operation(operationId); assertCurrentInternal(); return recordCopy(records.get(operationId)); }),
      findByRunId: guarded(runId => {
        if (typeof runId !== 'string' || !RUN_ID.test(runId)) badInput('INVALID_RUN_ID');
        assertCurrentInternal(); return recordCopy(runs.get(runId));
      }),
      inventory: guarded(() => { assertCurrentInternal(); return Object.freeze([...records.values()].map(record => record.reference)); }),
      // One logical batch gets copies of all accepted records after one full
      // freshness fence. Calling read() for every inventory reference would
      // instead re-read the whole namespace once per record.
      captureRecords: guarded(() => { assertCurrentInternal(); return Object.freeze([...records.values()].map(recordCopy)); }),
      assertCurrent,
      reread: guarded((operationId, expectedSha256) => {
        operation(operationId);
        if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) badInput('INVALID_EXPECTED_SHA256');
        assertCurrentInternal();
        const record = records.get(operationId);
        if (!record) fail('DISPATCH_MISSING');
        if (record.sha256 !== expectedSha256) fail('DISPATCH_DIGEST_MISMATCH');
        const bytes = capture(record.entry);
        if (!bytes.equals(record.bytes) || hash(bytes) !== expectedSha256) fail('DISPATCH_DIGEST_MISMATCH');
        assertCurrentInternal(); return recordCopy(record);
      }),
    });
    contexts.set(context, { root, assertCurrent });
    return context;
  });
}
