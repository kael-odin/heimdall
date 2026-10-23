/** Startup barrier only. Inventory and readiness are read-only; publications
 * settle existing running facts without executing, repairing or replaying them.
 * A batch is not a transaction: a later failure preserves earlier settlements. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { AcceptanceCatalogError, fields } from './catalog-schema.mjs';
import { ACCEPTANCE_ROOT } from './constants.mjs';
import { assertAcceptanceOwner } from './owner.mjs';
import { createManagedSpecDispatchReadContext } from './managed-dispatch-reader.mjs';
import { ACCEPTANCE_READ_LIMITS, createAcceptanceReadScope, captureAcceptanceRunFile, captureAcceptanceRunHead } from './managed-run-reader.mjs';
import { validateManagedRunHead } from './managed-snapshot-schema.mjs';
import { createManagedRunFileContext } from './managed-run-files.mjs';
import { prepareManagedAcceptanceSettlement, assertManagedAcceptanceSettlement, commitManagedAcceptanceSettlement } from './managed-run-store.mjs';

export const ACCEPTANCE_RECOVERY_LIMITS = Object.freeze({ runs: 1024, rootEntries: 4096, settlements: 128,
  capturedFiles: 4096, capturedBytes: 256 * 1024 * 1024, jsonBytes: 8 * 1024 * 1024 });
const RUN_ID = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESSAGE = '引擎已重启；此任务未完成，请重新运行。';
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode;
const sameFile = (a, b) => identity(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const reject = reason => { throw new AcceptanceCatalogError('ACCEPTANCE_RECOVERY_BLOCKED', 503,
  '启动恢复无法安全完成；已保留运行现场，验收写入暂不可用。', { reason }); };
const invalid = () => { throw new AcceptanceCatalogError('INVALID_INPUT', 400, '启动恢复参数无效。'); };
function limitsOf(input = {}) {
  fields(input, Object.keys(ACCEPTANCE_RECOVERY_LIMITS), [], invalid);
  const result = { ...ACCEPTANCE_RECOVERY_LIMITS, ...input };
  for (const key of Object.keys(result)) if (!Number.isSafeInteger(result[key]) || result[key] < 0
    || result[key] > ACCEPTANCE_RECOVERY_LIMITS[key]) invalid();
  return result;
}
function directory(path, optional = false) {
  let stat;
  try { stat = fs.lstatSync(path, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) reject('DIRECTORY_INVALID');
  return stat;
}
function inventory(root, limits) {
  const rootPin = directory(root), runs = new Map(), handle = fs.opendirSync(root);
  try {
    let entry, count = 0;
    while ((entry = handle.readSync())) {
      if (++count > limits.rootEntries) reject('ROOT_ENTRY_BUDGET');
      if (!RUN_ID.test(entry.name)) continue;
      if (runs.size >= limits.runs) reject('RUN_BUDGET');
      runs.set(entry.name, directory(join(root, entry.name)));
    }
  } finally { handle.closeSync(); }
  return { rootPin, runs };
}
function sameInventory(before, after) {
  if (!identity(before.rootPin, after.rootPin) || before.runs.size !== after.runs.size) reject('INVENTORY_CHANGED');
  for (const [runId, stat] of before.runs) if (!after.runs.has(runId) || !identity(stat, after.runs.get(runId))) reject('INVENTORY_CHANGED');
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject('INVALID_MANIFEST'); }
}

function recover({ root, owner, limits, owned }) {
  const counts = { managedInterrupted: 0, legacyInterrupted: 0, prepared: 0, skipped: 0, totalInterrupted: 0 };
  let phase = 'preflight', mayHaveCommitted = false;
  try {
    const authority = () => { if (owned) assertAcceptanceOwner(owner); return true; };
    authority();
    if (!directory(root, true)) {
      if (owned) reject('ROOT_MISSING');
      return counts;
    }
    const managedRead = createManagedSpecDispatchReadContext({ root });
    const scopeLimits = Object.fromEntries(Object.keys(ACCEPTANCE_READ_LIMITS).filter(key => Object.hasOwn(limits, key)).map(key => [key, limits[key]]));
    const scope = createAcceptanceReadScope({ root, managedRead, limits: scopeLimits });
    const initial = inventory(root, limits), reserved = new Map(), expectedHeads = new Map();
    // The scope captured the full dispatch batch once; inventory() supplies
    // bounded immutable references without rereading every record separately.
    for (const reference of managedRead.inventory()) reserved.set(reference.runId, reference);
    const ids = [...new Set([...initial.runs.keys(), ...reserved.keys()])].sort();
    if (ids.length > limits.runs) reject('RUN_BUDGET');
    const managed = [], legacy = [], witnesses = [];
    const inventoryFence = () => { authority(); sameInventory(initial, inventory(root, limits)); authority(); return true; };
    for (const runId of ids) {
      const classified = scope.classify(runId);
      if (classified.kind === 'managed') {
        const bytes = captureAcceptanceRunFile(runId, 'manifest.json', { scope });
        if (!bytes) {
          if (initial.runs.has(runId)) reject('PARTIAL_MANAGED_IDENTITY');
          counts.prepared++; continue;
        }
        const manifest = json(bytes);
        validateManagedRunHead({ record: classified.record, manifestBytes: bytes, manifest });
        expectedHeads.set(runId, bytes);
        if (manifest.status === 'running' && owned) {
          const ref = reserved.get(runId);
          managed.push({ runId, token: prepareManagedAcceptanceSettlement(
            { operationId: ref.operationId, dispatchSha256: ref.sha256 },
            { status: 'interrupted', reasonCode: 'ENGINE_RESTARTED', error: MESSAGE }, { owner, managedRead, limits: { jsonBytes: limits.jsonBytes } }) });
        } else counts.skipped++;
      } else {
        // Legacy classification must inspect both heads: a report-only marker
        // or unreadable report cannot be reinterpreted as marker absence.
        const head = captureAcceptanceRunHead(runId, { scope });
        if (!head) reject('LEGACY_IDENTITY_MISSING');
        if (head.manifest.runId !== runId || head.manifest.schemaVersion !== 1
          || !['running', 'completed', 'failed', 'interrupted'].includes(head.manifest.status)) reject('LEGACY_IDENTITY_INVALID');
        const files = createManagedRunFileContext({ root, runId, assertWritable: authority, limits: { jsonBytes: limits.jsonBytes } });
        const expected = files.read('manifest.json');
        if (!expected.bytes.equals(head.files.get('manifest.json'))) reject('LEGACY_HEAD_CHANGED');
        for (const name of ['manifest.json', 'report.json']) {
          const bytes = head.files.get(name) ?? null, path = join(root, runId, name);
          const stat = bytes ? fs.lstatSync(path, { bigint: true }) : null;
          witnesses.push({ runId, name, bytes, stat, files });
        }
        if (head.manifest.status === 'running') {
          const now = new Date().toISOString();
          const next = { ...head.manifest, status: 'interrupted', gate: 'blocked', error: MESSAGE, endedAt: now, updatedAt: now };
          if (encoded(next).length > limits.jsonBytes) reject('SETTLEMENT_BYTES_BUDGET');
          legacy.push({ runId, files, expected, next });
        } else counts.skipped++;
      }
      if (managed.length + legacy.length > limits.settlements) reject('SETTLEMENT_BUDGET');
    }
    const legacyFence = () => {
      for (const item of witnesses) {
        const captured = item.files.read(item.name, { optional: true });
        if (item.bytes ? !captured || !captured.bytes.equals(item.bytes)
          || !sameFile(item.stat, fs.lstatSync(join(root, item.runId, item.name), { bigint: true })) : captured !== null) reject('LEGACY_HEAD_CHANGED');
      }
      return true;
    };
    const preflight = consumed => {
      inventoryFence(); scope.assertCurrent(); legacyFence();
      for (const item of managed) if (item !== consumed) assertManagedAcceptanceSettlement(item.token);
      inventoryFence(); return true;
    };
    preflight();
    phase = 'managed'; let firstPublication = true;
    for (const item of managed) {
      const next = commitManagedAcceptanceSettlement(item.token, { beforePublish: () => {
        if (firstPublication) preflight(item); else { inventoryFence(); managedRead.assertCurrent(); }
        return true;
      } });
      firstPublication = false; counts.managedInterrupted++; counts.totalInterrupted++; mayHaveCommitted = true;
      expectedHeads.set(item.runId, encoded(next));
    }
    phase = 'legacy';
    // A fresh managed-only scope follows our own valid writes. Compare to the
    // exact expected heads before accepting it, so freshness never adopts edits.
    const managedScope = createAcceptanceReadScope({ root, managedRead, limits: scopeLimits });
    for (const runId of reserved.keys()) {
      const bytes = captureAcceptanceRunFile(runId, 'manifest.json', { scope: managedScope });
      const expected = expectedHeads.get(runId);
      if (expected ? !bytes || !bytes.equals(expected) : bytes !== null) reject('MANAGED_HEAD_CHANGED');
      if (bytes) validateManagedRunHead({ record: managedScope.classify(runId).record, manifestBytes: bytes, manifest: json(bytes) });
    }
    const phaseFence = () => { inventoryFence(); managedScope.assertCurrent(); legacyFence(); inventoryFence(); return true; };
    phaseFence();
    for (const item of legacy) {
      phaseFence();
      item.files.publish('manifest.json', encoded(item.next), { expected: item.expected, beforePublish: phaseFence });
      counts.legacyInterrupted++; counts.totalInterrupted++; mayHaveCommitted = true;
      const witness = witnesses.find(entry => entry.runId === item.runId && entry.name === 'manifest.json');
      const current = item.files.read('manifest.json');
      if (!current.bytes.equals(encoded(item.next))) reject('LEGACY_HEAD_CHANGED');
      witness.bytes = Buffer.from(current.bytes); witness.stat = fs.lstatSync(join(root, item.runId, 'manifest.json'), { bigint: true });
    }
    phaseFence(); return counts;
  } catch (cause) {
    const error = new AcceptanceCatalogError('ACCEPTANCE_RECOVERY_BLOCKED', 503,
      '启动恢复无法安全完成；已保留运行现场，验收写入暂不可用。', { phase, counts: { ...counts } });
    error.writeMayHaveCommitted = mayHaveCommitted || cause?.writeMayHaveCommitted === true;
    throw error;
  }
}

/** The engine invokes this once before admitting any tasks. A real live owner
 * is required; recovery neither acquires nor releases that authority. */
export function recoverOwnedAcceptanceRuns(options) {
  fields(options, ['owner', 'limits'], ['owner'], invalid);
  const limits = limitsOf(options.limits); assertAcceptanceOwner(options.owner);
  return recover({ root: options.owner.root, owner: options.owner, limits, owned: true });
}
/** Compatibility adapter. It performs the same strict preflight but never
 * settles a managed run or obtains owner authority. */
export function recoverLegacyAcceptanceRuns(options = {}) {
  fields(options, ['root', 'limits'], [], invalid);
  const root = options.root ?? ACCEPTANCE_ROOT;
  if (typeof root !== 'string' || !root.trim()) invalid();
  return recover({ root: resolve(root), limits: limitsOf(options.limits), owned: false }).legacyInterrupted;
}
