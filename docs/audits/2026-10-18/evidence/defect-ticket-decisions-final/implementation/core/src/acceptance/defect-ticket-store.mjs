/** Owner-bound, append-only manual defect-ticket decisions. No Browser effects.
 * Reads never create, repair or remove namespace entries. A checked namespace
 * is not a multi-file atomic snapshot or a backup/rollback detector. */
import { constants, mkdirSync, opendirSync, realpathSync, lstatSync, openSync, closeSync, fstatSync,
  readSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { assertAcceptanceOwner, AcceptanceOwnerError } from './owner.mjs';
import { DEFECT_TICKET_LIMITS, DefectTicketError, defectTicketFail as fail,
  isDefectTicketActionId, validateDefectTicketEvent, validateDefectTicketRejection,
  validateDefectTicketDecision, defectTicketDecisionBytes,
  validateDefectTicketChain } from './defect-ticket-schema.mjs';

export const DEFECT_TICKET_STORE_LIMITS = Object.freeze(Object.fromEntries(
  ['tickets', 'actions', 'actionBytes', 'namespaceBytes', 'queue'].map(key => [key, DEFECT_TICKET_LIMITS[key]])));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode;
const sameFile = (a, b) => identity(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sameNames = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const scopeOf = record => record.event ?? record.rejection.original;
const freeze = value => { if (value && typeof value === 'object') {
  Object.values(value).forEach(freeze); Object.freeze(value);
} return value; };
const nativePromise = Promise, nativePromisePrototype = Promise.prototype, nativeThen = Promise.prototype.then;
const nativeSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
const functionSource = Function.prototype.toString;
function consumeNativePromise(value) {
  // Never read then/constructor from caller values or assimilate a thenable.
  if (!types.isProxy(value) && types.isPromise(value) && Object.getPrototypeOf(value) === nativePromisePrototype
    && !Object.getOwnPropertyDescriptor(value, 'constructor')
    && Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor')?.value === nativePromise
    && Object.getOwnPropertyDescriptor(nativePromise, Symbol.species)?.get === nativeSpecies)
    nativeThen.call(value, undefined, () => {});
}
function ownValues(input, allowed, required = allowed) {
  if (!input || typeof input !== 'object' || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    consumeNativePromise(input); fail('INVALID_OPTIONS', 'INVALID_INPUT', 400);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !descriptors[key].enumerable
    || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key)))
    fail('INVALID_OPTIONS', 'INVALID_INPUT', 400);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function callable(fn, reason) {
  // Bound functions hide async/generator classification. This private callback
  // contract accepts direct JavaScript functions, with no opaque native wrapper.
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isAsyncFunction(fn) || types.isGeneratorFunction(fn)
    || /\{\s*\[native code\]\s*\}$/.test(functionSource.call(fn)))
    fail(reason, 'INVALID_INPUT', 400);
  return fn;
}
function invoke(fn, args = []) {
  try { return fn(...args); } catch (cause) { consumeNativePromise(cause); throw cause; }
}
function synchronousGuard(fn) {
  callable(fn, 'INVALID_GUARD');
  return () => {
    const result = invoke(fn);
    if (result !== undefined && result !== true) {
      consumeNativePromise(result); fail('INVALID_GUARD_RESULT', 'INVALID_INPUT', 400);
    }
    return true;
  };
}
function safeError(cause, writeMayHaveCommitted = false) {
  // Callback failures are data. Do not inspect a proxy or invoke error getters.
  let result;
  if (cause && !types.isProxy(cause) && types.isNativeError(cause)) {
    const prototype = Object.getPrototypeOf(cause), descriptors = Object.getOwnPropertyDescriptors(cause);
    const value = key => descriptors[key] && Object.hasOwn(descriptors[key], 'value') ? descriptors[key].value : undefined;
    writeMayHaveCommitted ||= value('writeMayHaveCommitted') === true;
    if (prototype === DefectTicketError.prototype) {
      const code = value('code'), status = value('status'), details = value('details');
      if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) && Number.isSafeInteger(status) && status >= 400 && status <= 599
        && details && typeof details === 'object' && !types.isProxy(details)
        && [Object.prototype, null].includes(Object.getPrototypeOf(details))) {
        const reason = Object.getOwnPropertyDescriptor(details, 'reason');
        if (reason && Object.hasOwn(reason, 'value') && typeof reason.value === 'string' && /^[A-Z_]{1,100}$/.test(reason.value))
          result = new DefectTicketError(code, status, reason.value);
      }
    } else if (prototype === AcceptanceOwnerError.prototype) {
      if (value('code') === 'ACCEPTANCE_OWNER_LOST') result = new AcceptanceOwnerError(true);
      else if (value('code') === 'ACCEPTANCE_OWNER_UNAVAILABLE') result = new AcceptanceOwnerError();
    }
  }
  result ??= new DefectTicketError('INTEGRITY_BLOCKED', 503, 'STORE_UNAVAILABLE');
  if (writeMayHaveCommitted) result.writeMayHaveCommitted = true;
  return result;
}
function boundedFile(path, maximum, links = 1n) {
  let fd;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== links || before.size < 1n
      || before.size > BigInt(maximum) || realpathSync(path) !== path) fail('FILE_UNSAFE');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true }); if (!sameFile(before, opened)) fail('FILE_CHANGED');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('FILE_CHANGED'); offset += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0 || !sameFile(opened, fstatSync(fd, { bigint: true }))
      || !sameFile(opened, lstatSync(path, { bigint: true }))) fail('FILE_CHANGED');
    return { path, bytes, stat: opened, sha256: sha(bytes), maximum };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function createDefectTicketStore(input = {}) {
  const { owner, limits: inputLimits = {} } = ownValues(input, ['owner', 'limits'], ['owner']);
  assertAcceptanceOwner(owner);
  const supplied = ownValues(inputLimits, Object.keys(DEFECT_TICKET_STORE_LIMITS), []), limits = { ...DEFECT_TICKET_STORE_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > limits[key]) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
    limits[key] = value;
  }
  const root = resolve(owner.root), parent = join(root, 'defect-tickets'), version = join(parent, 'v1'), events = join(version, 'events');
  const pins = new Map(), temporaries = new Map();
  let pending = 0, tail = Promise.resolve();
  const owned = () => { assertAcceptanceOwner(owner); if (realpathSync(root) !== root) fail('ROOT_CHANGED'); };
  function boundary(fn) { try { owned(); return fn(); } catch (cause) { throw safeError(cause); } }
  function directory(path, optional = false) {
    owned(); let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (cause) {
      if (cause.code === 'ENOENT' && optional && !pins.has(path)) return null;
      if (cause.code === 'ENOENT' && pins.has(path)) fail('DIRECTORY_CHANGED');
      throw cause;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('DIRECTORY_UNSAFE');
    const previous = pins.get(path); if (previous && !identity(previous, stat)) fail('DIRECTORY_CHANGED');
    pins.set(path, stat); owned(); return stat;
  }
  function readNames(path, maximum) {
    const names = [], handle = opendirSync(path);
    try { let entry; while ((entry = handle.readSync())) {
      if (names.length >= maximum) fail('ACTION_CAPACITY', 'CAPACITY', 503);
      names.push(entry.name);
    } } finally { handle.closeSync(); }
    return names.sort(compare);
  }
  function semanticNames() {
    const names = readNames(events, limits.actions + temporaries.size), result = [];
    for (const name of names) {
      const path = join(events, name), temporary = temporaries.get(path);
      if (temporary) {
        const current = boundedFile(path, temporary.maximum);
        if (!sameFile(current.stat, temporary.stat) || !current.bytes.equals(temporary.bytes)) fail('TEMPORARY_CHANGED');
      } else {
        if (!name.endsWith('.json') || !isDefectTicketActionId(name.slice(0, -5))) fail('NAMESPACE_UNSAFE');
        result.push(name);
      }
    }
    return result;
  }
  function syncDirectory(path) {
    // Windows file bytes are fsynced; portable directory fsync and whole-machine
    // power-loss durability are not available there through Node.
    if (process.platform === 'win32') return;
    directory(path); const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { fsyncSync(fd); } finally { closeSync(fd); }
    directory(path);
  }
  function group(records) {
    const tickets = new Map();
    for (const record of records) {
      const key = record.event.ticketId;
      if (!tickets.has(key)) tickets.set(key, []);
      tickets.get(key).push(record);
    }
    if (tickets.size > limits.tickets) fail('TICKET_CAPACITY', 'CAPACITY', 503);
    return [...tickets.entries()].sort(([a], [b]) => compare(a, b)).map(([, chain]) => validateDefectTicketChain(chain));
  }
  function capture() {
    owned(); directory(root);
    const capturedDirectories = new Map([[root, pins.get(root)]]), captures = [];
    const parentStat = directory(parent, true);
    let names = [], absent = null;
    if (!parentStat) absent = parent;
    else {
      capturedDirectories.set(parent, parentStat);
      if (!sameNames(readNames(parent, 2), ['v1'])) fail('NAMESPACE_INCOMPLETE');
      const versionStat = directory(version, true); if (!versionStat) fail('NAMESPACE_INCOMPLETE');
      capturedDirectories.set(version, versionStat);
      if (!sameNames(readNames(version, 2), ['events'])) fail('NAMESPACE_INCOMPLETE');
      const eventsStat = directory(events, true); if (!eventsStat) fail('NAMESPACE_INCOMPLETE');
      capturedDirectories.set(events, eventsStat); names = semanticNames();
    }
    if (names.length > limits.actions) fail('ACTION_CAPACITY', 'CAPACITY', 503);
    let totalBytes = 0;
    const shapes = names.map(name => {
      const path = join(events, name), stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n
        || stat.size > BigInt(limits.actionBytes) || realpathSync(path) !== path) fail('FILE_UNSAFE');
      totalBytes += Number(stat.size); if (totalBytes > limits.namespaceBytes) fail('NAMESPACE_BYTE_CAPACITY', 'CAPACITY', 503);
      return { path, stat, name };
    });
    const decisions = shapes.map(shape => {
      const current = boundedFile(shape.path, limits.actionBytes); if (!sameFile(shape.stat, current.stat)) fail('FILE_CHANGED');
      const decision = validateDefectTicketDecision(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes))),
        record = Object.hasOwn(decision, 'ticketContractVersion') ? { event: decision, sha256: current.sha256 }
          : { rejection: decision, sha256: current.sha256 };
      if (shape.name !== scopeOf(record).actionId + '.json' || !defectTicketDecisionBytes(decision).equals(current.bytes)) fail('EVENT_BYTES_CHANGED');
      captures.push(current); return record;
    });
    const tickets = group(decisions.filter(record => Object.hasOwn(record, 'event'))), ordered = tickets.flat();
    freeze(decisions); freeze(tickets); freeze(ordered);
    const checkShape = () => {
      owned();
      for (const [path, stat] of capturedDirectories) if (!identity(stat, directory(path))) fail('DIRECTORY_CHANGED');
      if (absent) {
        try { lstatSync(absent); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
        fail('NAMESPACE_CHANGED', 'STALE_TICKET', 409);
      }
      if (!sameNames(readNames(parent, 2), ['v1']) || !sameNames(readNames(version, 2), ['events'])
        || !sameNames(names, semanticNames())) fail('NAMESPACE_CHANGED', 'STALE_TICKET', 409);
    };
    const assertCurrent = () => boundary(() => {
      checkShape();
      for (const previous of captures) {
        const current = boundedFile(previous.path, previous.maximum);
        if (!sameFile(previous.stat, current.stat) || !previous.bytes.equals(current.bytes)) fail('EVENT_CHANGED', 'STALE_TICKET', 409);
      }
      checkShape(); owned(); return true;
    });
    assertCurrent();
    return { decisions, records: ordered, tickets, assertCurrent, totalBytes, present: !absent };
  }
  const projectIdOf = value => { if (!id(value, 'ap')) fail('INVALID_PROJECT_ID', 'INVALID_INPUT', 400); return value; };
  function snapshot(projectId) { return boundary(() => {
    projectIdOf(projectId); const checked = capture();
    return Object.freeze({ tickets: Object.freeze(checked.tickets.filter(chain => chain[0].event.projectId === projectId)),
      records: Object.freeze(checked.records.filter(record => record.event.projectId === projectId)), assertCurrent: checked.assertCurrent });
  }); }
  function action(projectId, actionId) { return boundary(() => {
    projectIdOf(projectId); if (!isDefectTicketActionId(actionId)) fail('INVALID_ACTION_ID', 'INVALID_INPUT', 400);
    const checked = capture(), record = checked.decisions.find(value => scopeOf(value).actionId === actionId);
    if (record && scopeOf(record).projectId !== projectId) fail('ACTION_NOT_FOUND', 'NOT_FOUND', 404);
    return record ?? null;
  }); }
  function replay(checked, { projectId, actionId, requestFingerprint }) {
    const existing = checked.decisions.find(record => scopeOf(record).actionId === actionId);
    if (!existing) return null;
    const scope = scopeOf(existing);
    if (scope.projectId !== projectId) fail('ACTION_NOT_FOUND', 'NOT_FOUND', 404);
    if (scope.requestFingerprint !== requestFingerprint) fail('ACTION_CONTENT_CONFLICT', 'ACTION_CONFLICT', 409);
    checked.assertCurrent(); return Object.freeze({ record: existing, replayed: true });
  }
  function createNamespace(previous, guard) {
    guard(); previous.assertCurrent();
    for (const path of [parent, version, events]) {
      owned(); directory(dirname(path)); mkdirSync(path); directory(path); syncDirectory(dirname(path));
    }
    const fresh = capture();
    if (fresh.decisions.length !== previous.decisions.length
      || fresh.decisions.some((record, index) => record.sha256 !== previous.decisions[index].sha256)) fail('NAMESPACE_CHANGED', 'STALE_TICKET', 409);
    guard(); fresh.assertCurrent(); return fresh;
  }
  function execute({ projectId, actionId, requestFingerprint, prepare }, kind) {
    let publicationAttempted = false, fd, temporary;
    try {
      owned(); let checked = capture();
      const existing = replay(checked, { projectId, actionId, requestFingerprint }); if (existing) return existing;
      const projectRecords = Object.freeze(checked.records.filter(record => record.event.projectId === projectId));
      const prepared = ownValues(invoke(prepare, [projectRecords]), [kind, 'assertCurrent']);
      const guard = synchronousGuard(prepared.assertCurrent), decision = kind === 'event'
        ? validateDefectTicketEvent(prepared.event) : validateDefectTicketRejection(prepared.rejection);
      const scope = kind === 'event' ? decision : decision.original;
      if (scope.projectId !== projectId || scope.actionId !== actionId || scope.requestFingerprint !== requestFingerprint)
        fail('APPEND_SCOPE_MISMATCH', 'INVALID_INPUT', 400);
      const bytes = defectTicketDecisionBytes(decision), record = freeze({ [kind]: decision, sha256: sha(bytes) });
      if (bytes.length > limits.actionBytes) fail('ACTION_BYTE_CAPACITY', 'CAPACITY', 503);
      if (checked.decisions.length >= limits.actions) fail('ACTION_CAPACITY', 'CAPACITY', 503);
      if (checked.totalBytes + bytes.length > limits.namespaceBytes) fail('NAMESPACE_BYTE_CAPACITY', 'CAPACITY', 503);
      try { group(kind === 'event' ? [...checked.records, record] : checked.records); }
      catch (cause) {
        const safe = safeError(cause); if (safe.code === 'CAPACITY') throw safe;
        fail('APPEND_CHAIN_INVALID', 'STALE_TICKET', 409);
      }
      guard(); checked.assertCurrent();
      if (!checked.present) checked = createNamespace(checked, guard);
      guard(); checked.assertCurrent(); directory(events); owned();
      const target = join(events, actionId + '.json'); temporary = join(events, `.defect-ticket-${randomUUID()}.tmp`);
      fd = openSync(temporary, 'wx', 0o600); const created = fstatSync(fd, { bigint: true });
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      const staged = boundedFile(temporary, limits.actionBytes);
      if (!identity(staged.stat, created) || !staged.bytes.equals(bytes)) fail('TEMPORARY_CHANGED');
      temporaries.set(temporary, staged);
      guard(); checked.assertCurrent(); directory(events); owned();
      const ready = boundedFile(temporary, limits.actionBytes);
      if (!sameFile(ready.stat, staged.stat) || !ready.bytes.equals(bytes)) fail('TEMPORARY_CHANGED');
      publicationAttempted = true;
      linkSync(temporary, target);
      // The two private/public names share an inode until the private name is
      // removed. Check that exact pair before normal nlink=1 receipt validation.
      directory(events); owned();
      for (const path of [temporary, target]) {
        const linked = boundedFile(path, limits.actionBytes, 2n);
        if (!identity(linked.stat, staged.stat) || !linked.bytes.equals(bytes)) fail('PUBLICATION_CHANGED');
      }
      directory(events); owned(); unlinkSync(temporary); temporaries.delete(temporary); syncDirectory(events);
      const published = boundedFile(target, limits.actionBytes);
      if (!identity(published.stat, staged.stat) || !published.bytes.equals(bytes)) fail('PUBLICATION_CHANGED');
      const receipt = capture(), expected = new Map([...checked.decisions, record].map(value => [scopeOf(value).actionId, value.sha256]));
      if (receipt.decisions.length !== expected.size || receipt.decisions.some(value => expected.get(scopeOf(value).actionId) !== value.sha256))
        fail('PUBLICATION_NAMESPACE_CHANGED');
      guard(); receipt.assertCurrent(); owned();
      return Object.freeze({ record: receipt.decisions.find(value => scopeOf(value).actionId === actionId), replayed: false });
    } catch (cause) { throw safeError(cause, publicationAttempted); }
    finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* Preserve the primary failure and scene. */ }
      // Failed temporary files remain as evidence and make subsequent reads
      // fail closed. Only a successfully published invocation removes its temp.
      if (temporary) temporaries.delete(temporary);
    }
  }
  function enqueue(input, kind) {
    let admission;
    try { admission = boundary(() => {
      const checked = ownValues(input, ['projectId', 'actionId', 'requestFingerprint', 'prepare']);
      projectIdOf(checked.projectId);
      if (!isDefectTicketActionId(checked.actionId) || !hash(checked.requestFingerprint)) fail('INVALID_APPEND_REQUEST', 'INVALID_INPUT', 400);
      callable(checked.prepare, 'INVALID_PREPARE');
      const existing = replay(capture(), checked); if (existing) return { existing };
      if (pending >= limits.queue) fail('QUEUE_CAPACITY', 'CAPACITY', 503);
      return { value: checked };
    }); } catch (cause) { return Promise.reject(safeError(cause)); }
    if (admission.existing) return Promise.resolve(admission.existing);
    pending++;
    const result = tail.then(() => execute(admission.value, kind));
    tail = result.then(() => { pending--; }, () => { pending--; });
    return result;
  }
  const append = input => enqueue(input, 'event'), deny = input => enqueue(input, 'rejection');
  return Object.freeze({ snapshot, action, append, deny });
}
