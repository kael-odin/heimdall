/** Private synchronous file publisher; authority belongs to assertWritable.
 * No owner/store imports, directory creation, execution, repair or recovery.
 * Successful link/rename is the file commit point, not a cross-file transaction
 * or directory power-loss durability. Path fences are not an OS inode CAS: the
 * caller must enforce one real owner. Tokens do not retain target descriptors,
 * so bytes/stat/birthtime checks do not claim protection from adversarial ABA.
 * A failed publication reports writeMayHaveCommitted=true after a successful
 * call or whenever fenced reconciliation cannot establish the original target
 * (or original absence). It never rolls a formal file back or retries an
 * uncertain commit. io/platform/sleep/now are trusted synchronous test seams. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { AcceptanceCatalogError, fields } from './catalog-schema.mjs';

const NAMES = new Set(['manifest.json', 'report.json']);
const RUN_ID = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024, maxRetryMs: 750 });
const WINDOWS_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']), DELAYS = [10, 20, 40, 80, 120, 160, 200];
const captures = new WeakMap(), errors = new WeakSet();
const releaseClose = fs.closeSync, releaseStat = fs.fstatSync;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const NativePromise = Promise, promisePrototype = Promise.prototype, promiseThen = Promise.prototype.then;
const speciesGetter = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
const consumeOrdinaryPromise = value => {
  if (types.isPromise(value) && Object.getPrototypeOf(value) === promisePrototype
    && !Object.getOwnPropertyDescriptor(value, 'constructor')
    && Object.getOwnPropertyDescriptor(promisePrototype, 'constructor')?.value === NativePromise
    && Object.getOwnPropertyDescriptor(NativePromise, Symbol.species)?.get === speciesGetter) {
    promiseThen.call(value, undefined, () => {});
  }
};
const fail = (reason, code = 'MANAGED_RUN_FILES_UNAVAILABLE') => {
  const error = new AcceptanceCatalogError(code, code === 'INVALID_INPUT' ? 400 : code === 'MANAGED_RUN_FILE_CONFLICT' ? 409 : 503,
    code === 'INVALID_INPUT' ? '托管运行文件参数无效。' : code === 'MANAGED_RUN_FILE_CONFLICT'
      ? '托管运行文件的预期状态已发生冲突，原文件已保留。' : '托管运行文件暂不可安全读写，原文件已保留。', Object.freeze({ reason }));
  error.writeMayHaveCommitted = false; errors.add(error); throw error;
};
const badInput = reason => fail(reason, 'INVALID_INPUT');
const conflict = reason => fail(reason, 'MANAGED_RUN_FILE_CONFLICT');
const sanitized = cause => {
  if (errors.has(cause)) return cause;
  try { fail('FILESYSTEM_FAILURE'); } catch (error) { return error; }
};
const synchronous = (value, reason) => {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    consumeOrdinaryPromise(value); badInput(reason);
  }
  return value;
};
const callable = value => typeof value === 'function' && !types.isProxy(value)
  && !types.isAsyncFunction(value) && !types.isGeneratorFunction(value);
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get;
const typedSet = Uint8Array.prototype.set;
const byteCopy = (value, maxBytes) => {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !types.isUint8Array(value)
    || types.isSharedArrayBuffer(typedBuffer.call(value))) badInput('INVALID_BYTES');
  const length = typedLength.call(value);
  if (length > maxBytes) badInput('FILE_BYTES_EXCEEDED');
  const copy = new Uint8Array(length); typedSet.call(copy, value); return Buffer.from(copy);
};
const sleepWord = new Int32Array(new SharedArrayBuffer(4));
const defaultSleep = milliseconds => { Atomics.wait(sleepWord, 0, 0, milliseconds); };

export function createManagedRunFileContext(options) {
  try {
    fields(options, ['root', 'runId', 'assertWritable', 'limits', 'io', 'platform', 'sleep', 'now'], ['root', 'runId', 'assertWritable'], badInput);
    if (typeof options.root !== 'string' || !options.root.trim() || !isAbsolute(options.root)) badInput('INVALID_ROOT');
    if (typeof options.runId !== 'string' || !RUN_ID.test(options.runId)) badInput('INVALID_RUN_ID');
    if (!callable(options.assertWritable)) badInput('INVALID_WRITABLE_GUARD');
    const root = resolve(options.root), directory = join(root, options.runId), guard = options.assertWritable;
    const requestedLimits = options.limits ?? {}; fields(requestedLimits, Object.keys(DEFAULT_LIMITS), [], badInput);
    const limits = { ...DEFAULT_LIMITS, ...requestedLimits };
    for (const key of Object.keys(limits)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 0 || limits[key] > DEFAULT_LIMITS[key]) badInput('INVALID_LIMITS');
    const platform = options.platform ?? process.platform, sleep = options.sleep ?? defaultSleep, now = options.now ?? (() => performance.now());
    if (typeof platform !== 'string' || !['win32', 'linux', 'darwin', 'aix', 'freebsd', 'openbsd', 'sunos', 'android'].includes(platform)
      || !callable(sleep) || !callable(now)) badInput('INVALID_RUNTIME');
    const ioNames = ['openSync', 'closeSync', 'writeSync', 'readSync', 'fsyncSync', 'linkSync', 'renameSync', 'unlinkSync'];
    const overrides = options.io ?? {}; fields(overrides, ioNames, [], badInput);
    if (Object.values(overrides).some(value => !callable(value))) badInput('INVALID_IO');
    const io = Object.fromEntries(ioNames.map(key => [key, overrides[key] ?? fs[key]]));
    const callIo = (name, ...args) => synchronous(io[name](...args), 'ASYNC_IO_UNSUPPORTED');
    const callVoid = (name, ...args) => { if (callIo(name, ...args) !== undefined) badInput('INVALID_IO_RESULT'); };
    const closeOwned = fd => {
      // A synchronous override can fail before or after closing. Do not leak a
      // still-owned descriptor, and never blindly close a number already reused
      // for a different inode. Overrides are trusted fault-injection seams.
      let pin;
      try { pin = releaseStat(fd, { bigint: true }); } catch { /* Already closed. */ }
      try { callVoid('closeSync', fd); }
      catch (cause) {
        if (pin) try { if (sameIdentity(pin, releaseStat(fd, { bigint: true }))) releaseClose(fd); } catch { /* Preserve close failure. */ }
        throw cause;
      }
    };
    const descriptor = value => {
      if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_DESCRIPTOR'); return value;
    };
    let invalid;
    const directoryIdentity = path => {
      const stat = fs.lstatSync(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) fail('DIRECTORY_IDENTITY_INVALID');
      return stat;
    };
    const assertGuard = () => {
      let result;
      try { result = guard(); } catch { fail('WRITABLE_FENCE_FAILED'); }
      synchronous(result, 'ASYNC_GUARD_UNSUPPORTED');
      if (result !== undefined && result !== true) fail('WRITABLE_GUARD_REJECTED');
    };
    let rootPin, directoryPin;
    const invalidate = cause => {
      const error = sanitized(cause); invalid = { reason: error.details.reason, code: error.code }; throw error;
    };
    const assertLayout = () => {
      if (invalid) fail(invalid.reason, invalid.code);
      try {
        const rootNow = directoryIdentity(root);
        if (rootPin && !sameIdentity(rootPin, rootNow)) fail('ROOT_CHANGED');
        const directoryNow = directoryIdentity(directory);
        if (directoryPin && !sameIdentity(directoryPin, directoryNow)) fail('RUN_DIRECTORY_CHANGED');
        rootPin ??= rootNow; directoryPin ??= directoryNow;
        return true;
      } catch (cause) { invalidate(cause); }
    };
    const assertFence = () => {
      if (invalid) fail(invalid.reason, invalid.code);
      try { assertGuard(); } catch (cause) { invalidate(cause); }
      return assertLayout();
    };
    const fileIdentity = (path, optional = false) => {
      let stat;
      try { stat = fs.lstatSync(path, { bigint: true }); }
      catch (cause) { if (optional && cause?.code === 'ENOENT') return null; throw cause; }
      // Only the first lstat can establish absence. Resolution failure after
      // observing an entry is never an optional missing file.
      if (!stat.isFile() || stat.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) fail('FILE_IDENTITY_INVALID');
      return stat;
    };
    const safeRead = (path, pin, maxBytes, fence = assertFence) => {
      fence();
      const before = fileIdentity(path);
      if (pin && !sameFile(pin, before)) conflict('FILE_CHANGED');
      if (before.size > BigInt(maxBytes)) fail('FILE_BYTES_EXCEEDED');
      let fd;
      try {
        fd = descriptor(callIo('openSync', path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)));
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || !sameFile(before, opened)) conflict('FILE_CHANGED');
        const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
        while (offset < bytes.length) {
          const count = callIo('readSync', fd, bytes, offset, bytes.length - offset, offset);
          if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) fail('READ_INCOMPLETE');
          offset += count;
        }
        if (callIo('readSync', fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0
          || !sameFile(opened, fs.fstatSync(fd, { bigint: true })) || !sameFile(opened, fileIdentity(path))) conflict('FILE_CHANGED');
        fence(); return { bytes, stat: opened };
      } finally { if (fd !== undefined) { const closing = fd; fd = undefined; closeOwned(closing); } }
    };
    const captured = (path, pin, maxBytes = limits.jsonBytes, fence = assertFence) => {
      const first = safeRead(path, pin, maxBytes, fence), second = safeRead(path, first.stat, maxBytes, fence);
      if (!first.bytes.equals(second.bytes)) conflict('FILE_CHANGED'); return first;
    };
    const state = {};
    const token = (name, source) => {
      const result = Object.freeze({ bytes: Buffer.from(source.bytes), sha256: hash(source.bytes) });
      captures.set(result, { state, name, bytes: Buffer.from(source.bytes), stat: source.stat }); return result;
    };
    const nameOf = name => { if (typeof name !== 'string' || !NAMES.has(name)) badInput('INVALID_FILE_NAME'); return join(directory, name); };
    const read = (name, readOptions = {}) => {
      const path = nameOf(name); fields(readOptions, ['optional', 'maxBytes'], [], badInput);
      const optional = Object.hasOwn(readOptions, 'optional') ? readOptions.optional : false;
      const maxBytes = Object.hasOwn(readOptions, 'maxBytes') ? readOptions.maxBytes : limits.jsonBytes;
      if (typeof optional !== 'boolean' || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > limits.jsonBytes) badInput('INVALID_READ_OPTIONS');
      assertFence(); const pin = fileIdentity(path, optional);
      if (!pin) { assertFence(); return null; }
      return token(name, captured(path, pin, maxBytes));
    };
    const publish = (name, input, publishOptions) => {
      const path = nameOf(name); fields(publishOptions, ['expected', 'beforePublish'], ['expected'], badInput);
      const beforePublish = publishOptions.beforePublish;
      if (beforePublish !== undefined && !callable(beforePublish)) badInput('INVALID_PUBLISH_GUARD');
      const expectedToken = publishOptions.expected, expected = expectedToken === null ? null : captures.get(expectedToken);
      if (expectedToken !== null && (!expected || expected.state !== state || expected.name !== name)) badInput('INVALID_EXPECTED_TOKEN');
      const bytes = byteCopy(input, limits.jsonBytes);
      let fd, anchor, temporaryPath, temporaryStat, published = false, attempted = false, mayHaveCommitted = false, cleanupAttempted = false;
      const targetMetadata = () => {
        const current = fileIdentity(path, expected === null);
        if (expected === null) { if (current) conflict('TARGET_EXISTS'); }
        else if (!sameFile(expected.stat, current)) conflict('FILE_CHANGED');
      };
      const targetBytes = (fence = assertFence) => {
        if (expected === null) { targetMetadata(); return; }
        const current = captured(path, expected.stat, limits.jsonBytes, fence);
        if (!current.bytes.equals(expected.bytes)) conflict('FILE_CHANGED');
      };
      const temporaryMetadata = () => {
        const live = anchor ?? fd;
        if (!temporaryStat || live === undefined) fail('TEMPORARY_IDENTITY_UNKNOWN');
        const held = fs.fstatSync(live, { bigint: true }), current = fileIdentity(temporaryPath);
        if (!held.isFile() || !sameIdentity(temporaryStat, held) || !sameFile(held, current)) fail('TEMPORARY_CHANGED');
      };
      const mutationFence = (withTemporary = true) => {
        assertFence(); targetMetadata(); if (withTemporary) temporaryMetadata();
      };
      const assertPublishGuard = () => {
        if (!beforePublish) return;
        try {
          let result;
          try { result = beforePublish(); } catch { fail('PUBLISH_GUARD_FAILED'); }
          synchronous(result, 'ASYNC_GUARD_UNSUPPORTED');
          if (result !== undefined && result !== true) fail('PUBLISH_GUARD_REJECTED');
        } catch (cause) { invalidate(cause); }
      };
      const preparePublication = () => {
        const temporary = captured(temporaryPath);
        if (!sameIdentity(temporaryStat, temporary.stat) || !temporary.bytes.equals(bytes)) fail('TEMPORARY_CHANGED');
        targetBytes();
        // Run the cheap authority guard before the full business hook. After
        // the last arbitrary business callback, only internal layout/byte/FD
        // checks and trusted native IO remain; a coarse-clock edit by either
        // callback cannot evade the original expected bytes.
        assertFence(); assertPublishGuard();
        const afterGuard = captured(temporaryPath, temporary.stat, limits.jsonBytes, assertLayout);
        if (!sameIdentity(temporaryStat, afterGuard.stat) || !afterGuard.bytes.equals(bytes)) fail('TEMPORARY_CHANGED');
        targetBytes(assertLayout);
        assertLayout(); targetMetadata(); temporaryMetadata();
        if (!sameFile(afterGuard.stat, fileIdentity(temporaryPath))) fail('TEMPORARY_CHANGED');
      };
      const reconcile = () => {
        if (published) return true;
        if (!attempted) return false;
        try {
          assertFence(); const current = fileIdentity(path, true);
          if (!current) return expected !== null;
          const observed = captured(path, current);
          if (temporaryStat && sameIdentity(temporaryStat, observed.stat) && observed.bytes.equals(bytes)) return true;
          if (expected && sameFile(expected.stat, observed.stat) && expected.bytes.equals(observed.bytes)) return false;
          return true;
        } catch { return true; }
      };
      const cleanupTemporary = () => {
        cleanupAttempted = true;
        const live = anchor ?? fd;
        if (!temporaryPath || !temporaryStat || live === undefined || (mayHaveCommitted && !published)) return;
        try {
          assertFence();
          if (published) {
            const target = fileIdentity(path);
            if (!sameIdentity(temporaryStat, target)) fail('PUBLISHED_FILE_CHANGED');
          } else targetMetadata();
          temporaryMetadata(); callVoid('unlinkSync', temporaryPath);
        } catch { /* Lost authority or unknown identity forbids cleanup. */ }
      };
      try {
        assertFence(); targetBytes();
        temporaryPath = join(directory, name + '.' + randomUUID() + '.tmp');
        mutationFence(false); fd = descriptor(callIo('openSync', temporaryPath, 'wx', 0o600));
        temporaryStat = fs.fstatSync(fd, { bigint: true });
        if (!temporaryStat.isFile()) fail('TEMPORARY_CHANGED');
        let offset = 0;
        while (offset < bytes.length) {
          mutationFence(); const count = callIo('writeSync', fd, bytes, offset, bytes.length - offset, offset);
          if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) fail('WRITE_INCOMPLETE');
          offset += count;
        }
        mutationFence(); callVoid('fsyncSync', fd);
        // Pin the allocated inode before closing the writer. Keeping this
        // readonly descriptor until after cleanup prevents Linux inode reuse
        // from making somebody else's replacement appear to be our temporary.
        mutationFence(); anchor = descriptor(callIo('openSync', temporaryPath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)));
        temporaryMetadata(); mutationFence();
        const closing = fd; fd = undefined; closeOwned(closing);
        if (expected === null) {
          preparePublication(); attempted = true; callVoid('linkSync', temporaryPath, path); published = true;
        } else {
          const started = synchronous(now(), 'ASYNC_RUNTIME_UNSUPPORTED');
          if (!Number.isFinite(started)) badInput('INVALID_CLOCK');
          let attempts = 0, waited = 0;
          for (;;) {
            preparePublication(); attempted = true; attempts++;
            try { callVoid('renameSync', temporaryPath, path); published = true; break; }
            catch (cause) {
              // A wrapper can commit and then throw. A missing original temp
              // ends retries, leaving reconciliation to report uncertainty.
              let currentTemporary;
              try { currentTemporary = fileIdentity(temporaryPath, true); } catch { throw cause; }
              if (!currentTemporary || !sameIdentity(temporaryStat, currentTemporary)) throw cause;
              const currentTime = synchronous(now(), 'ASYNC_RUNTIME_UNSUPPORTED');
              if (!Number.isFinite(currentTime)) badInput('INVALID_CLOCK');
              const remaining = limits.maxRetryMs - Math.max(waited, currentTime - started, 0);
              if (errors.has(cause) || platform !== 'win32' || !WINDOWS_BUSY.has(cause?.code) || remaining <= 0) throw cause;
              const delay = Math.min(DELAYS[Math.min(attempts - 1, DELAYS.length - 1)], remaining);
              if (synchronous(sleep(delay), 'ASYNC_RUNTIME_UNSUPPORTED') !== undefined) badInput('INVALID_SLEEP_RESULT');
              waited += delay;
            }
          }
        }
        assertFence(); cleanupTemporary();
        // Windows may finalize metadata when the last retained handle closes.
        // The anchor has served its cleanup purpose; release it before issuing
        // the reusable target token as well as after removing the extra link.
        const closingAnchor = anchor; anchor = undefined; closeOwned(closingAnchor);
        // Exclusive link temporarily adds nlink/ctime metadata. Capture the
        // returned CAS token only after our conditional unlink has completed.
        const result = read(name);
        const accepted = captures.get(result);
        if (!sameIdentity(temporaryStat, accepted.stat) || !accepted.bytes.equals(bytes)) fail('PUBLISHED_FILE_CHANGED');
        return result;
      } catch (cause) {
        mayHaveCommitted = reconcile(); const error = sanitized(cause); error.writeMayHaveCommitted = mayHaveCommitted; throw error;
      } finally {
        // Releasing descriptors is always permitted. Unlink requires a live
        // authority/path fence plus our still-allocated temporary inode; an
        // uncertain publication or replacement is deliberately preserved.
        if (!cleanupAttempted) cleanupTemporary();
        if (fd !== undefined) try { closeOwned(fd); } catch { /* Preserve primary outcome. */ }
        if (anchor !== undefined) try { closeOwned(anchor); } catch { /* Preserve primary outcome. */ }
      }
    };
    const safe = fn => (...args) => { try { return fn(...args); } catch (cause) { throw sanitized(cause); } };
    assertFence();
    return Object.freeze({ read: safe(read), publish: safe(publish), assertCurrent: safe(assertFence) });
  } catch (cause) { throw sanitized(cause); }
}
