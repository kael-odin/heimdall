/** One engine owns acceptance recovery/catalog writes for each real data root. */
import { mkdirSync, realpathSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync, fstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { ACCEPTANCE_ROOT } from './constants.mjs';

export const ACCEPTANCE_OWNER_FILE = '.acceptance-owner.json';
export const ACCEPTANCE_RECOVERY_FILE = '.acceptance-recovery.json';
const MAX_LOCK_BYTES = 2048;
const NONCE = /^[a-f0-9]{64}$/;
const acquiredOwners = new WeakSet();

export class AcceptanceOwnerError extends Error {
  constructor(lost = false) {
    super(lost ? '验收目录所有权已失效，请停止当前引擎后重试。' : '验收目录正由其他引擎使用，或无法安全确认目录所有权。');
    this.name = 'AcceptanceOwnerError';
    this.code = lost ? 'ACCEPTANCE_OWNER_LOST' : 'ACCEPTANCE_OWNER_UNAVAILABLE';
    this.status = 503;
  }
}
/** A method-shaped object is not an acquired capability. This brand does not
 * grant execution admission; the original lock must still be owned now. */
export function assertAcceptanceOwner(owner) {
  if (!acquiredOwners.has(owner)) throw new AcceptanceOwnerError();
  return owner.assertOwned();
}
const sameFile = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const sameRoot = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode;
function rootIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new AcceptanceOwnerError();
  return stat;
}
function readRecord(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_LOCK_BYTES) throw new AcceptanceOwnerError();
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size || bytes.length > MAX_LOCK_BYTES) throw new AcceptanceOwnerError();
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'createdAt,hostname,nonce,pid,schemaVersion'
      || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !NONCE.test(value.nonce)
      || typeof value.hostname !== 'string' || !value.hostname || value.hostname.length > 255
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new AcceptanceOwnerError();
  return { value, stat };
}
function matching(a, b) {
  return sameFile(a.stat, b.stat) && a.value.nonce === b.value.nonce && a.value.pid === b.value.pid
    && a.value.hostname === b.value.hostname && a.value.createdAt === b.value.createdAt;
}
function removeOwned(path, owned, assertRoot) {
  try {
    assertRoot();
    if (!matching(readRecord(path), owned)) return false;
    assertRoot();
    unlinkSync(path);
    return true;
  } catch { return false; }
}
function createRecord(path, value, assertRoot, assertCleanupRoot) {
  let fd, stat;
  try {
    assertRoot();
    fd = openSync(path, 'wx', 0o600);
    stat = fstatSync(fd);
    assertRoot();
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
    assertRoot();
    return { value, stat };
  } catch (error) {
    // Only our exclusively created inode may be removed after a partial write.
    // A moved lock inode does not authorize deleting a replacement root's file.
    if (stat) try {
      assertCleanupRoot();
      if (sameFile(lstatSync(path), stat)) { assertCleanupRoot(); unlinkSync(path); }
    } catch { /* Preserve the failure and any unowned directory's scene. */ }
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * A dead PID is recoverable only on this host and after a second nonce/inode
 * check under an exclusive recovery guard. Unknown/EPERM/PID reuse stays locked.
 * A leftover recovery guard is deliberately not guessed stale from age or PID.
 */
export function acquireAcceptanceOwner({ root = ACCEPTANCE_ROOT, processProbe = pid => process.kill(pid, 0) } = {}) {
  const requestedRoot = resolve(root);
  const host = hostname();
  const record = () => ({ schemaVersion: 1, pid: process.pid, hostname: host,
    nonce: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() });
  let actualRoot, rootPin, lockPath, recoveryPath, owned;
  const assertCanonicalRoot = () => {
    if (!actualRoot || !rootPin || !sameRoot(rootPin, rootIdentity(actualRoot))) throw new AcceptanceOwnerError(true);
  };
  const assertRoot = () => {
    if (!actualRoot || realpathSync(requestedRoot) !== actualRoot) throw new AcceptanceOwnerError(true);
    assertCanonicalRoot();
  };
  const dead = value => {
    if (value.hostname !== host) return false;
    try { processProbe(value.pid); return false; }
    catch (error) { return error?.code === 'ESRCH'; }
  };
  try {
    mkdirSync(requestedRoot, { recursive: true });
    actualRoot = realpathSync(requestedRoot);
    // Pin before creating/recovering a lock. A nonce and the same lock inode can
    // otherwise be moved into a newly created directory at this same pathname.
    rootPin = rootIdentity(actualRoot);
    assertRoot();
    lockPath = join(actualRoot, ACCEPTANCE_OWNER_FILE);
    recoveryPath = join(actualRoot, ACCEPTANCE_RECOVERY_FILE);
    // An interrupted recovery cannot be safely inferred complete by a newcomer.
    try { lstatSync(recoveryPath); throw new AcceptanceOwnerError(); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try { owned = createRecord(lockPath, record(), assertRoot, assertCanonicalRoot); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stale = readRecord(lockPath);
      if (!dead(stale.value)) throw new AcceptanceOwnerError();
      assertRoot();
      const recovery = createRecord(recoveryPath, record(), assertRoot, assertCanonicalRoot);
      try {
        const current = readRecord(lockPath);
        if (!matching(stale, current) || !dead(current.value)) throw new AcceptanceOwnerError();
        assertRoot();
        if (!matching(readRecord(recoveryPath), recovery) || !matching(readRecord(lockPath), current)) throw new AcceptanceOwnerError();
        // Cooperating reclaimers are serialized; another fresh owner may win
        // the subsequent exclusive create, which is treated as a conflict.
        assertRoot();
        unlinkSync(lockPath);
        owned = createRecord(lockPath, record(), assertRoot, assertCanonicalRoot);
      } finally { removeOwned(recoveryPath, recovery, assertCanonicalRoot); }
    }
    assertRoot();
    if (!matching(readRecord(lockPath), owned)) throw new AcceptanceOwnerError();
    assertRoot();
  } catch {
    if (owned && lockPath) removeOwned(lockPath, owned, assertCanonicalRoot);
    throw new AcceptanceOwnerError();
  }
  let released = false;
  const owner = Object.freeze({
    root: actualRoot,
    nonce: owned.value.nonce,
    assertOwned() {
      try {
        if (released) throw new AcceptanceOwnerError(true);
        assertRoot();
        if (!matching(readRecord(lockPath), owned)) throw new AcceptanceOwnerError(true);
        assertRoot();
      } catch { throw new AcceptanceOwnerError(true); }
      return true;
    },
    release() {
      if (released) return false;
      released = true;
      // A retargeted caller alias loses authority, but the unchanged canonical
      // root still permits cleanup of this owner's original lock. A replacement
      // canonical root never does, even if the lock inode was moved into it.
      return removeOwned(lockPath, owned, assertCanonicalRoot);
    },
  });
  acquiredOwners.add(owner);
  return owner;
}
