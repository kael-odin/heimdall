/** Bounded, owner-fenced, immutable preparation envelopes. No executor/recovery.
 * Exclusive hard-link publication is the acceptance point. This is not a
 * cross-file transaction or a claim of directory-entry power-loss durability. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, isAbsolute } from 'node:path';
import { types } from 'node:util';
import { AcceptanceCatalogError, fields, plain } from './catalog-schema.mjs';
import { isManagedSpecOperationId, managedSpecDispatchLimits, validateManagedSpecDispatchEnvelope } from './managed-dispatch-schema.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PUBLISHED = new RegExp(`^(ao-${UUID})\\.json$`), TEMPORARY = new RegExp(`^ao-${UUID}\\.${UUID}\\.tmp$`);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const NativePromise = Promise, nativePromisePrototype = Promise.prototype, nativePromiseThen = Promise.prototype.then;
const nativeSpeciesGetter = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
// Only consume the common accidental native Promise. Intrinsic then bypasses
// an own `then` getter, but still consults constructor/species; verify that
// exact trusted path without invoking any user-supplied property accessor.
const ordinaryNativePromise = value => types.isPromise(value) && Object.getPrototypeOf(value) === nativePromisePrototype
  && !Object.getOwnPropertyDescriptor(value, 'constructor')
  && Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor')?.value === NativePromise
  && Object.getOwnPropertyDescriptor(NativePromise, Symbol.species)?.get === nativeSpeciesGetter;
const fail = (reason, code = 'MANAGED_DISPATCH_UNAVAILABLE', status = 503) => {
  throw new AcceptanceCatalogError(code, status, code === 'INVALID_INPUT' ? '托管 Spec 准备参数无效。'
    : code === 'DISPATCH_CONFLICT' ? '该操作编号已存在不同的准备记录。'
      : code === 'DISPATCH_CAPACITY_EXCEEDED' ? '托管 Spec 准备记录已达到容量限制，原记录已保留。'
        : '托管 Spec 准备记录暂不可安全读写，原记录已保留。', { reason });
};
const badInput = reason => fail(reason, 'INVALID_INPUT', 400);

export function createManagedSpecDispatchStore(options) {
  fields(options, ['root', 'owner', 'limits', 'hooks', 'io'], ['owner'], badInput);
  const { owner } = options;
  if (!plain(owner)) fail('OWNER_REQUIRED', 'ACCEPTANCE_OWNER_UNAVAILABLE');
  const rootDescriptor = Object.getOwnPropertyDescriptor(owner, 'root'), ownerDescriptor = Object.getOwnPropertyDescriptor(owner, 'assertOwned');
  if (!rootDescriptor || !Object.hasOwn(rootDescriptor, 'value') || typeof rootDescriptor.value !== 'string'
    || !rootDescriptor.value.trim() || !isAbsolute(rootDescriptor.value) || !ownerDescriptor
    || !Object.hasOwn(ownerDescriptor, 'value') || typeof ownerDescriptor.value !== 'function') fail('OWNER_REQUIRED', 'ACCEPTANCE_OWNER_UNAVAILABLE');
  if (options.root !== undefined && (typeof options.root !== 'string' || !options.root.trim())) badInput('INVALID_ROOT');
  const ownerRoot = resolve(rootDescriptor.value), requestedRoot = resolve(options.root ?? ownerRoot);
  if (!samePath(ownerRoot, requestedRoot)) badInput('ROOT_OWNER_MISMATCH');
  const limits = managedSpecDispatchLimits(options.limits ?? {});
  const hooks = options.hooks ?? {}, overrides = options.io ?? {};
  fields(hooks, ['afterTemporaryWrite', 'afterPublish'], [], badInput);
  if (Object.values(hooks).some(value => typeof value !== 'function')) badInput('INVALID_HOOKS');
  const ioNames = ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'linkSync', 'unlinkSync', 'readSync'];
  fields(overrides, ioNames, [], badInput);
  if (Object.values(overrides).some(value => typeof value !== 'function')) badInput('INVALID_IO');
  const io = Object.fromEntries(ioNames.map(key => [key, overrides[key] ?? fs[key]]));
  const parent = join(ownerRoot, 'managed-spec-dispatches'), directory = join(parent, 'v1');
  let pins = null;
  const assertOwner = () => {
    try { ownerDescriptor.value.call(owner); }
    catch { fail('OWNER_LOST', 'ACCEPTANCE_OWNER_LOST'); }
  };
  const directoryIdentity = path => {
    const stat = fs.lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) fail('DIRECTORY_IDENTITY_INVALID');
    return stat;
  };
  const assertRoot = () => {
    assertOwner();
    if (!samePath(fs.realpathSync(requestedRoot), ownerRoot) || !samePath(fs.realpathSync(rootDescriptor.value), ownerRoot)) {
      fail('ROOT_CHANGED', 'ACCEPTANCE_OWNER_LOST');
    }
    const stat = directoryIdentity(ownerRoot);
    if (pins && !sameInode(pins.root, stat)) fail('ROOT_CHANGED', 'ACCEPTANCE_OWNER_LOST');
    return stat;
  };
  const assertFence = () => {
    assertRoot();
    if (!pins || !sameInode(pins.parent, directoryIdentity(parent)) || !sameInode(pins.directory, directoryIdentity(directory))) {
      fail('DIRECTORY_CHANGED');
    }
  };
  const initialize = () => {
    if (pins) { assertFence(); return; }
    const rootStat = assertRoot();
    // Fence each individual mkdir. Never follow an existing linked component.
    assertRoot();
    try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (cause) { if (cause?.code !== 'EEXIST') throw cause; }
    const parentStat = directoryIdentity(parent);
    assertRoot();
    if (!sameInode(parentStat, directoryIdentity(parent))) fail('DIRECTORY_CHANGED');
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (cause) { if (cause?.code !== 'EEXIST') throw cause; }
    const directoryStat = directoryIdentity(directory);
    if (!sameInode(rootStat, assertRoot()) || !sameInode(parentStat, directoryIdentity(parent))) fail('DIRECTORY_CHANGED');
    pins = { root: rootStat, parent: parentStat, directory: directoryStat };
    assertFence();
  };
  const fileIdentity = path => {
    const stat = fs.lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) fail('FILE_IDENTITY_INVALID');
    return stat;
  };
  const safeRead = (path, expected) => {
    assertFence();
    const before = fileIdentity(path);
    if (expected && !sameFile(expected, before)) fail('FILE_CHANGED');
    if (before.size > BigInt(limits.jsonBytes)) fail('FILE_BYTES_EXCEEDED');
    let descriptor;
    try {
      descriptor = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || !sameFile(before, opened)) fail('FILE_CHANGED');
      const bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = io.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) fail('FILE_CHANGED');
        offset += count;
      }
      if (io.readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0
        || !sameFile(opened, fs.fstatSync(descriptor, { bigint: true })) || !sameFile(opened, fileIdentity(path))) fail('FILE_CHANGED');
      assertFence();
      return { bytes, stat: opened };
    } finally { if (descriptor !== undefined) io.closeSync(descriptor); }
  };
  const captured = (path, expected) => {
    const first = safeRead(path, expected), second = safeRead(path, first.stat);
    if (!first.bytes.equals(second.bytes) || hash(first.bytes) !== hash(second.bytes)) fail('FILE_CHANGED');
    return first;
  };
  const read = operationId => {
    if (!isManagedSpecOperationId(operationId)) badInput('INVALID_OPERATION_ID');
    initialize(); assertFence();
    const path = join(directory, operationId + '.json');
    let pin;
    try { pin = fileIdentity(path); }
    catch (cause) {
      // Absence is only accepted while the directory/owner fence still holds.
      if (cause?.code === 'ENOENT') { assertFence(); return null; }
      throw cause;
    }
    const source = captured(path, pin);
    let envelope;
    try {
      envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes));
      validateManagedSpecDispatchEnvelope(envelope, { limits });
    } catch { fail('STORED_ENVELOPE_INVALID'); }
    if (envelope.operationId !== operationId) fail('STORED_OPERATION_MISMATCH');
    return { envelope, bytes: source.bytes, sha256: hash(source.bytes) };
  };
  const scan = () => {
    initialize(); assertFence();
    let handle, entries = 0, totalBytes = 0;
    const ids = [];
    try {
      handle = fs.opendirSync(directory);
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        if (++entries > limits.directoryEntries) fail('DIRECTORY_ENTRIES_EXCEEDED', 'DISPATCH_CAPACITY_EXCEEDED', 409);
        assertFence();
        const published = PUBLISHED.exec(entry.name);
        if (!published && !TEMPORARY.test(entry.name)) fail('UNKNOWN_DIRECTORY_ENTRY');
        const stat = fileIdentity(join(directory, entry.name));
        if (stat.size > BigInt(limits.jsonBytes)) fail('FILE_BYTES_EXCEEDED');
        totalBytes += Number(stat.size);
        if (totalBytes > limits.totalBytes) fail('TOTAL_BYTES_EXCEEDED', 'DISPATCH_CAPACITY_EXCEEDED', 409);
        if (published) ids.push(published[1]);
        if (ids.length > limits.dispatches) fail('DISPATCH_COUNT_EXCEEDED', 'DISPATCH_CAPACITY_EXCEEDED', 409);
      }
    } finally { if (handle) handle.closeSync(); }
    assertFence();
    return { ids: ids.sort(), entries, totalBytes };
  };
  const list = () => scan().ids.map(operationId => {
    const record = read(operationId);
    if (!record) fail('PUBLISHED_RECORD_DISAPPEARED');
    return record;
  });
  const invoke = (callback, context) => {
    if (!callback) return;
    const result = callback(context);
    // Callbacks are synchronous commit fences; never publish ahead of a Promise.
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      // Internal hooks must be synchronous. Handle a mistaken async hook's
      // rejection while still refusing publication synchronously; never follow
      // arbitrary thenables, Promise subclasses or constructor/species getters.
      if (ordinaryNativePromise(result)) nativePromiseThen.call(result, undefined, () => {});
      badInput('ASYNC_GUARD_UNSUPPORTED');
    }
  };
  const publish = (envelope, publishOptions = {}) => {
    fields(publishOptions, ['beforePublish'], [], badInput);
    if (publishOptions.beforePublish !== undefined && typeof publishOptions.beforePublish !== 'function') badInput('INVALID_GUARD');
    validateManagedSpecDispatchEnvelope(envelope, { limits });
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
    if (bytes.length > limits.jsonBytes) badInput('JSON_BYTES_EXCEEDED');
    // Capture a private normalized copy before callbacks can mutate caller data.
    const ownedEnvelope = JSON.parse(bytes.toString('utf8'));
    const { operationId, dispatchId, runId } = ownedEnvelope, context = { operationId, dispatchId, runId };
    let descriptor, temporaryPath, temporaryStat, published = false, publicationAttempted = false;
    try {
      initialize();
      const existing = read(operationId);
      if (existing) {
        if (!existing.bytes.equals(bytes)) fail('OPERATION_EXISTS', 'DISPATCH_CONFLICT', 409);
        return existing;
      }
      const capacity = scan();
      // Both names coexist until fenced cleanup; reserve their bounded logical
      // size even though the exclusive link refers to the same physical inode.
      if (capacity.ids.length >= limits.dispatches || capacity.entries + 2 > limits.directoryEntries
        || capacity.totalBytes + 2 * bytes.length > limits.totalBytes) fail('CAPACITY_EXCEEDED', 'DISPATCH_CAPACITY_EXCEEDED', 409);
      // Existing published history must be valid before accepting another key.
      for (const operation of capacity.ids) if (!read(operation)) fail('PUBLISHED_RECORD_DISAPPEARED');
      temporaryPath = join(directory, operationId + '.' + randomUUID() + '.tmp');
      assertFence();
      descriptor = io.openSync(temporaryPath, 'wx', 0o600);
      temporaryStat = fs.fstatSync(descriptor, { bigint: true });
      assertFence();
      let offset = 0;
      while (offset < bytes.length) {
        assertFence();
        const count = io.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) fail('WRITE_INCOMPLETE');
        offset += count;
      }
      assertFence(); io.fsyncSync(descriptor);
      const completed = descriptor; descriptor = undefined; io.closeSync(completed);
      invoke(hooks.afterTemporaryWrite, { ...context, temporaryPath });
      const temporary = captured(temporaryPath);
      if (!sameInode(temporaryStat, temporary.stat) || !bytes.equals(temporary.bytes)) fail('TEMPORARY_CHANGED');
      const finalTemporary = captured(temporaryPath);
      if (!sameFile(temporary.stat, finalTemporary.stat) || !bytes.equals(finalTemporary.bytes)) fail('TEMPORARY_CHANGED');
      const finalCapacity = scan();
      if (finalCapacity.ids.length >= limits.dispatches || finalCapacity.entries + 1 > limits.directoryEntries
        || finalCapacity.totalBytes + bytes.length > limits.totalBytes) fail('CAPACITY_EXCEEDED', 'DISPATCH_CAPACITY_EXCEEDED', 409);
      for (const operation of finalCapacity.ids) if (!read(operation)) fail('PUBLISHED_RECORD_DISAPPEARED');
      const directoryBeforeGuard = directoryIdentity(directory);
      // The source/catalog guard is the final business validation. Keep bounded
      // byte reads and potentially large history scans ahead of it. Afterwards
      // only owner/path/inode/metadata fences separate it from exclusive link;
      // this still does not create a cross-file atomic transaction.
      assertFence(); invoke(publishOptions.beforePublish, { ...context }); assertFence();
      if (!sameFile(finalTemporary.stat, fileIdentity(temporaryPath))) fail('TEMPORARY_CHANGED');
      if (!sameFile(directoryBeforeGuard, directoryIdentity(directory))) fail('DIRECTORY_CHANGED');
      assertFence(); publicationAttempted = true;
      io.linkSync(temporaryPath, join(directory, operationId + '.json')); published = true;
      assertFence(); invoke(hooks.afterPublish, { ...context }); assertFence();
      const result = read(operationId);
      if (!result || !result.bytes.equals(bytes)) fail('PUBLISHED_RECORD_CHANGED');
      return result;
    } catch (cause) {
      let committed = published;
      // A link wrapper can publish and then throw. Never delete or overwrite it.
      if (publicationAttempted && !committed) {
        try { assertFence(); committed = !!read(operationId); } catch { committed = true; }
      }
      let error = cause instanceof AcceptanceCatalogError ? cause
        : new AcceptanceCatalogError('MANAGED_DISPATCH_UNAVAILABLE', 503, '托管 Spec 准备记录暂不可安全读写，原记录已保留。', { reason: 'FILESYSTEM_FAILURE' });
      if (committed) { error.writeMayHaveCommitted = true; Object.assign(error, context); }
      else error.writeMayHaveCommitted = false;
      throw error;
    } finally {
      if (descriptor !== undefined) try { io.closeSync(descriptor); } catch { /* Keep primary failure; partial temp is not accepted. */ }
      if (temporaryPath && temporaryStat) {
        try {
          assertFence();
          if (sameInode(temporaryStat, fileIdentity(temporaryPath))) { assertFence(); io.unlinkSync(temporaryPath); }
        } catch { /* A lost fence or replaced inode forbids cleanup. Keep it. */ }
      }
    }
  };
  const safe = fn => (...args) => {
    try { return fn(...args); }
    catch (cause) {
      if (cause instanceof AcceptanceCatalogError) throw cause;
      fail('FILESYSTEM_FAILURE');
    }
  };
  return Object.freeze({ initialize: safe(initialize), read: safe(read), list: safe(list), publish: safe(publish) });
}
