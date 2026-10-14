/** Byte-for-byte copies of trash entries kept outside the active data root. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DATA_ROOT, isInside } from '../paths.mjs';

const HASH = /^[0-9a-f]{64}$/;
const samePath = (a, b) => process.platform === 'win32'
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

function assertDirectory(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('backup path is not a regular directory');
}

export function backupRootFor(dataRoot = DATA_ROOT, configured = process.env.HEIMDALL_TRASH_BACKUP_DIR) {
  if (!configured) return null;
  if (!isAbsolute(configured)) throw new Error('HEIMDALL_TRASH_BACKUP_DIR must be absolute');
  const root = resolve(configured);
  const data = realpathSync(dataRoot);
  if (samePath(root, data) || isInside(root, data) || isInside(data, root)) {
    throw new Error('trash backup root must be outside the data root');
  }
  if (!existsSync(root)) throw new Error('trash backup root must exist');
  assertDirectory(root);
  const real = realpathSync(root);
  if (samePath(real, data) || isInside(real, data) || isInside(data, real)) {
    throw new Error('trash backup root resolves inside the data root');
  }
  return real;
}

export function hashFile(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

export function inspectTree(root) {
  assertDirectory(root);
  const entries = [];
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('backup source contains a symlink');
      if (stat.isDirectory()) {
        entries.push({ path: rel, type: 'directory' });
        walk(file, rel);
      } else if (stat.isFile()) {
        const sha256 = hashFile(file);
        const after = lstatSync(file);
        if (!after.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
          throw new Error('backup source changed while hashing');
        }
        entries.push({ path: rel, type: 'file', size: stat.size, sha256 });
      } else throw new Error('backup source contains a special file');
    }
  };
  walk(root);
  return entries;
}

const treeHash = (entries) => createHash('sha256').update(JSON.stringify(entries)).digest('hex');

function copyTree(source, target) {
  assertDirectory(source);
  mkdirSync(target);
  const copy = (from, to) => {
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      const dest = join(to, name);
      const stat = lstatSync(src);
      if (stat.isSymbolicLink()) throw new Error('backup source contains a symlink');
      if (stat.isDirectory()) { mkdirSync(dest); copy(src, dest); }
      else if (stat.isFile()) copyFileSync(src, dest);
      else throw new Error('backup source contains a special file');
    }
  };
  copy(source, target);
}

function backupDir(root, id, revision) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !HASH.test(revision)) throw new Error('invalid backup identity');
  return join(root, id, revision);
}

export function verifyTrashBackup(id, revision, { dataRoot = DATA_ROOT, backupRoot } = {}) {
  const root = backupRootFor(dataRoot, backupRoot);
  if (!root) throw new Error('trash backup root is not configured');
  const dir = backupDir(root, id, revision);
  assertDirectory(join(root, id));
  assertDirectory(dir);
  const manifestPath = join(dir, 'manifest.json');
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('backup manifest is not a regular file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.id !== id || manifest.sourceRevision !== revision
      || !HASH.test(manifest.treeHash) || !Array.isArray(manifest.entries)) throw new Error('invalid backup manifest');
  const actual = inspectTree(join(dir, 'entry'));
  if (treeHash(actual) !== manifest.treeHash || JSON.stringify(actual) !== JSON.stringify(manifest.entries)) {
    throw new Error('trash backup hash mismatch');
  }
  const sourceStat = statSync(dataRoot);
  const backupStat = statSync(root);
  return { ...manifest, directory: dir, sameFilesystem: sourceStat.dev === backupStat.dev };
}

export function createTrashBackup(id, revision, source, { dataRoot = DATA_ROOT, backupRoot } = {}) {
  const root = backupRootFor(dataRoot, backupRoot);
  if (!root) throw new Error('trash backup root is not configured');
  const parent = join(root, id);
  if (!existsSync(parent)) mkdirSync(parent);
  assertDirectory(parent);
  const final = backupDir(root, id, revision);
  if (existsSync(final)) {
    const existing = verifyTrashBackup(id, revision, { dataRoot, backupRoot: root });
    const current = inspectTree(source);
    if (treeHash(current) !== existing.treeHash) throw new Error('trash entry differs from existing backup');
    return existing;
  }
  const stage = join(parent, `.stage-${randomUUID()}`);
  mkdirSync(stage);
  try {
    copyTree(source, join(stage, 'entry'));
    const copied = inspectTree(join(stage, 'entry'));
    const original = inspectTree(source);
    if (JSON.stringify(copied) !== JSON.stringify(original)) throw new Error('trash entry changed while copying');
    const manifest = { version: 1, id, sourceRevision: revision,
      createdAt: new Date().toISOString(), treeHash: treeHash(copied), entries: copied };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    renameSync(stage, final);
    return verifyTrashBackup(id, revision, { dataRoot, backupRoot: root });
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
  }
}

export function copyTrashBackup(id, revision, target, { dataRoot = DATA_ROOT, backupRoot } = {}) {
  const backup = verifyTrashBackup(id, revision, { dataRoot, backupRoot });
  copyTree(join(backup.directory, 'entry'), target);
  const copied = inspectTree(target);
  if (treeHash(copied) !== backup.treeHash) throw new Error('restored trash copy hash mismatch');
  return backup;
}

export function treeMatchesBackup(source, backup) {
  return treeHash(inspectTree(source)) === backup.treeHash;
}
