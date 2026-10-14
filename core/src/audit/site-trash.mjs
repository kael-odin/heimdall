/** Reversible removal of site and page artifacts. No entry is purged here. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, isInside } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { isSafePageName } from '../page-name.mjs';
import { resolvePageNameOfUrl, sameCanonUrl } from '../url-canon.mjs';
import { backupRootFor, createTrashBackup, copyTrashBackup, hashFile, treeMatchesBackup, verifyTrashBackup } from './trash-backup.mjs';

const SITE_NAME = /^[a-z0-9.-]+$/i;
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const activePurges = new Set();

function assertSiteName(host) {
  if (typeof host !== 'string' || !SITE_NAME.test(host) || host === '.' || host === '..') {
    throw new Error('bad host');
  }
}

function pathExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function assertDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('artifact is not a directory');
}

function assertDirectoryIfPresent(path) {
  if (pathExists(path)) assertDirectory(path);
}

function sitePaths(dataRoot, host) {
  assertSiteName(host);
  const workspace = join(dataRoot, 'workspace');
  const site = join(workspace, host);
  if (!isInside(workspace, site)) throw new Error('site outside workspace');
  return { workspace, site, trash: join(dataRoot, 'trash') };
}

function newEntry(trash) {
  mkdirSync(trash, { recursive: true });
  assertDirectory(trash);
  const id = randomUUID();
  const dir = join(trash, id);
  mkdirSync(dir);
  return { id, dir, recordPath: join(dir, 'record.json') };
}

function saveRecord(entry, record) {
  writeFileAtomic(entry.recordPath, JSON.stringify(record, null, 2));
}

function readEntry(dataRoot, id) {
  if (!ENTRY_ID.test(id)) throw new Error('bad trash id');
  const dir = join(dataRoot, 'trash', id);
  assertDirectory(join(dataRoot, 'trash'));
  assertDirectory(dir);
  const recordPath = join(dir, 'record.json');
  const recordStat = lstatSync(recordPath);
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) throw new Error('trash record is not a regular file');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (record.id !== id || !['site', 'page'].includes(record.kind)) throw new Error('invalid trash record');
  assertSiteName(record.host);
  if (record.kind === 'page' && !isSafePageName(record.name)) throw new Error('invalid trash page');
  return { id, dir, recordPath, record };
}

function atlasChange(site, name, target) {
  const recon = join(site, 'recon');
  assertDirectoryIfPresent(recon);
  const path = join(recon, 'atlas.json');
  if (!pathExists(path)) return { path, before: null, after: null, removedNode: false };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('atlas is not a regular file');
  const before = readFileSync(path, 'utf8');
  let atlas;
  try { atlas = JSON.parse(before); } catch { return { path, before, after: null, removedNode: false }; }
  if (!atlas || typeof atlas !== 'object' || !Array.isArray(atlas.nodes)) {
    return { path, before, after: null, removedNode: false };
  }
  const count = atlas.nodes.length;
  atlas.nodes = atlas.nodes.filter((node) => {
    if (target) return !sameCanonUrl(node.url, target);
    try { return resolvePageNameOfUrl(new URL(node.url), site) !== name; }
    catch { return true; }
  });
  if (atlas.nodes.length === count) return { path, before, after: null, removedNode: false };
  const ids = new Set(atlas.nodes.map(node => node.id));
  atlas.edges = (atlas.edges ?? []).filter(edge => ids.has(edge.from) && ids.has(edge.to));
  if (atlas.meta) { atlas.meta.pages = atlas.nodes.length; atlas.meta.edges = atlas.edges.length; }
  return { path, before, after: JSON.stringify(atlas, null, 2), removedNode: true };
}

export function quarantineSite(host, { dataRoot = DATA_ROOT } = {}) {
  const { site, trash } = sitePaths(dataRoot, host);
  assertDirectory(site);
  const entry = newEntry(trash);
  const payload = join(entry.dir, 'site');
  const record = { id: entry.id, kind: 'site', host, createdAt: new Date().toISOString(), state: 'prepared' };
  saveRecord(entry, record);
  renameSync(site, payload);
  try { saveRecord(entry, { ...record, state: 'ready' }); }
  catch (error) {
    try { renameSync(payload, site); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
  return { trashId: entry.id };
}

export function quarantinePage(host, name, { dataRoot = DATA_ROOT } = {}) {
  const { site, trash } = sitePaths(dataRoot, host);
  if (!isSafePageName(name)) throw new Error('bad page name');
  assertDirectory(site);
  const pages = join(site, 'pages');
  assertDirectoryIfPresent(pages);
  const page = join(pages, name);
  if (!isInside(site, page)) throw new Error('page outside site');
  const pagePresent = pathExists(page);
  if (pagePresent) assertDirectory(page);
  let target = null;
  try { target = JSON.parse(readFileSync(join(page, 'manifest.json'), 'utf8')).target; } catch {}
  const atlas = atlasChange(site, name, target);
  if (!pagePresent && !atlas.removedNode) return { removedArtifacts: false, removedNode: false, trashId: null };
  const entry = newEntry(trash);
  const payload = join(entry.dir, 'page');
  const record = {
    id: entry.id, kind: 'page', host, name, createdAt: new Date().toISOString(), state: 'prepared',
    pagePresent, removedNode: atlas.removedNode, atlasChanged: atlas.after !== null,
    atlasBeforeHash: atlas.before === null ? null : digest(atlas.before),
    atlasAfterHash: atlas.after === null ? null : digest(atlas.after),
  };
  if (atlas.after !== null) writeFileSync(join(entry.dir, 'atlas-before.json'), atlas.before);
  saveRecord(entry, record);
  let moved = false;
  let atlasWritten = false;
  try {
    if (pagePresent) { renameSync(page, payload); moved = true; }
    if (atlas.after !== null) {
      if (digest(readFileSync(atlas.path, 'utf8')) !== record.atlasBeforeHash) {
        throw new Error('atlas changed during deletion');
      }
      writeFileAtomic(atlas.path, atlas.after);
      atlasWritten = true;
    }
    saveRecord(entry, { ...record, state: 'ready' });
  } catch (error) {
    try {
      if (atlasWritten) writeFileAtomic(atlas.path, atlas.before);
      if (moved) renameSync(payload, page);
    } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
  return { removedArtifacts: pagePresent, removedNode: atlas.removedNode, trashId: entry.id };
}

export function restoreTrash(id, { dataRoot = DATA_ROOT } = {}) {
  const entry = readEntry(dataRoot, id);
  const { record } = entry;
  if (!['ready', 'prepared'].includes(record.state)) throw new Error('trash entry is not ready');
  const { site } = sitePaths(dataRoot, record.host);
  if (record.kind === 'site') {
    const payload = join(entry.dir, 'site');
    if (record.state === 'prepared' && pathExists(site) && !pathExists(payload)) {
      saveRecord(entry, { ...record, state: 'aborted' });
      return { kind: 'site', host: record.host, trashId: id, restored: false };
    }
    if (pathExists(site)) throw new Error('site already exists');
    assertDirectory(payload);
    renameSync(payload, site);
    try { saveRecord(entry, { ...record, state: 'restored', restoredAt: new Date().toISOString() }); }
    catch (error) {
      try { renameSync(site, payload); } catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
    return { kind: 'site', host: record.host, trashId: id };
  }
  assertDirectory(site);
  const pages = join(site, 'pages');
  assertDirectoryIfPresent(pages);
  const page = join(pages, record.name);
  const payload = join(entry.dir, 'page');
  const pageExists = pathExists(page);
  const backupExists = pathExists(payload);
  if (record.state === 'ready' && pageExists) throw new Error('page already exists');
  if (record.state === 'prepared' && pageExists && backupExists) throw new Error('page already exists');
  if (record.pagePresent && !backupExists && !pageExists) throw new Error('page backup missing');
  if (!record.pagePresent && pageExists) throw new Error('page already exists');
  if (backupExists) assertDirectory(payload);
  const recon = join(site, 'recon');
  assertDirectoryIfPresent(recon);
  const atlasPath = join(recon, 'atlas.json');
  let atlasBefore = null;
  let atlasAfter = null;
  let restoreAtlas = false;
  if (record.atlasChanged) {
    atlasBefore = readFileSync(join(entry.dir, 'atlas-before.json'), 'utf8');
    if (digest(atlasBefore) !== record.atlasBeforeHash) throw new Error('atlas backup changed');
    const atlasStat = lstatSync(atlasPath);
    if (!atlasStat.isFile() || atlasStat.isSymbolicLink()) throw new Error('atlas is not a regular file');
    atlasAfter = readFileSync(atlasPath, 'utf8');
    const currentHash = digest(atlasAfter);
    if (currentHash !== record.atlasAfterHash && !(record.state === 'prepared' && currentHash === record.atlasBeforeHash)) {
      throw new Error('atlas changed after deletion');
    }
    restoreAtlas = currentHash === record.atlasAfterHash;
  }
  let moved = false;
  let atlasWritten = false;
  try {
    if (record.pagePresent && backupExists) {
      mkdirSync(pages, { recursive: true });
      renameSync(payload, page);
      moved = true;
    }
    if (restoreAtlas) { writeFileAtomic(atlasPath, atlasBefore); atlasWritten = true; }
    const restored = moved || restoreAtlas;
    saveRecord(entry, { ...record, state: restored ? 'restored' : 'aborted', restoredAt: restored ? new Date().toISOString() : null });
  } catch (error) {
    try {
      if (atlasWritten) writeFileAtomic(atlasPath, atlasAfter);
      if (moved) renameSync(page, payload);
    } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
  return { kind: 'page', host: record.host, name: record.name, trashId: id };
}

function purgeProcessActive(receipt) {
  if (!Number.isSafeInteger(receipt.pid) || receipt.pid < 1) return false;
  if (receipt.pid === process.pid) return activePurges.has(receipt.id);
  try { process.kill(receipt.pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function reconcileStartedReceipt(id, dataRoot) {
  if (!ENTRY_ID.test(id)) return;
  const trash = join(dataRoot, 'trash');
  if (!pathExists(trash)) return;
  assertDirectory(trash);
  const receipts = join(trash, '.purge-receipts');
  const receiptPath = join(receipts, `${id}.json`);
  if (!pathExists(receiptPath)) return;
  assertDirectory(receipts);
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) return;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.state !== 'started' || purgeProcessActive(receipt)) return;
  if (receipt.mode === 'recoverable') {
    if (receipt.id !== id || receipt.record?.id !== id || receipt.preview?.id !== id
        || receipt.preview?.revision !== receipt.backup?.sourceRevision
        || receipt.backup?.treeHash == null) return;
    const stage = join(trash, `.purging-${id}`);
    const source = join(trash, id);
    let state = 'needs-review';
    let reason = 'entry or staging directory still present; inspect before retrying';
    if (!pathExists(stage) && !pathExists(source)) {
      state = 'complete';
      reason = 'entry absent after interrupted purge; verify external backup before recovery';
    } else if (!pathExists(stage) && pathExists(source)) {
      try {
        const backup = verifyTrashBackup(id, receipt.backup.sourceRevision, { dataRoot });
        if (backup.treeHash === receipt.backup.treeHash && treeMatchesBackup(source, backup)) {
          state = 'aborted'; reason = 'intact entry remained after interrupted purge';
        }
      } catch {}
    }
    writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, state,
      reconciledAt: new Date().toISOString(),
      reconciliation: reason,
      ...(state === 'complete' ? { completedAt: new Date().toISOString() } : {}) }, null, 2));
    if (state === 'aborted') {
      const history = join(receipts, 'history');
      mkdirSync(history, { recursive: true });
      assertDirectory(history);
      renameSync(receiptPath, join(history, `${id}-${randomUUID()}.json`));
    }
    return;
  }
  if (receipt.id !== id || receipt.record?.id !== id || receipt.preview?.id !== id
      || receipt.preview?.purgeable !== true
      || receipt.preview?.state !== receipt.record?.state
      || !['restored', 'aborted'].includes(receipt.record?.state)
      || !['site', 'page'].includes(receipt.record?.kind)) return;
  assertSiteName(receipt.record.host);
  if (receipt.record.kind === 'page' && !isSafePageName(receipt.record.name)) return;

  const dir = join(dataRoot, 'trash', id);
  let state, reason;
  if (!pathExists(dir)) {
    state = 'complete';
    reason = 'entry absent after interrupted purge';
  } else {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      state = 'needs-review'; reason = 'entry path is not a directory';
    } else {
      const names = readdirSync(dir);
      if (names.length === 0) {
        writeFileAtomic(join(dir, 'record.json'), JSON.stringify(receipt.record, null, 2));
        state = 'aborted'; reason = 'record recovered from receipt';
      } else if (names.length === 1 && names[0] === 'record.json') {
        const recordPath = join(dir, 'record.json');
        const recordStat = lstatSync(recordPath);
        let matches = false;
        if (recordStat.isFile() && !recordStat.isSymbolicLink()) {
          try { matches = digest(JSON.stringify(JSON.parse(readFileSync(recordPath, 'utf8'))))
            === digest(JSON.stringify(receipt.record)); } catch {}
        }
        state = matches ? 'aborted' : 'needs-review';
        reason = matches ? 'terminal record still present' : 'record differs from receipt';
      } else {
        state = 'needs-review'; reason = 'entry contains additional evidence';
      }
    }
  }
  writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, state,
    reconciledAt: new Date().toISOString(), reconciliation: reason,
    ...(state === 'complete' ? { completedAt: new Date().toISOString() } : {}) }, null, 2));
}

function reconcileStartedReceipts(dataRoot) {
  const trash = join(dataRoot, 'trash');
  assertDirectory(trash);
  const receipts = join(trash, '.purge-receipts');
  if (!pathExists(receipts)) return;
  assertDirectory(receipts);
  for (const name of readdirSync(receipts)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ENTRY_ID.test(id)) continue;
    try { reconcileStartedReceipt(id, dataRoot); }
    catch (error) { console.warn(`trash receipt ${id}: ${String(error?.message ?? error)}`); }
  }
}

export function listTrash({ dataRoot = DATA_ROOT } = {}) {
  const trash = join(dataRoot, 'trash');
  if (!existsSync(trash)) return [];
  reconcileStartedReceipts(dataRoot);
  return readdirSync(trash, { withFileTypes: true }).filter(e => e.isDirectory() && ENTRY_ID.test(e.name))
    .flatMap(e => {
      try { return [readEntry(dataRoot, e.name).record]; } catch { return []; }
    }).sort((a, b) => {
      const at = typeof a.createdAt === 'string' ? Date.parse(a.createdAt) : NaN;
      const bt = typeof b.createdAt === 'string' ? Date.parse(b.createdAt) : NaN;
      if (Number.isFinite(at) && Number.isFinite(bt)) return bt - at || a.id.localeCompare(b.id);
      if (Number.isFinite(at)) return -1;
      if (Number.isFinite(bt)) return 1;
      return a.id.localeCompare(b.id);
    });
}

export function listPurgedTrashBackups({ dataRoot = DATA_ROOT, backupRoot } = {}) {
  const trash = join(dataRoot, 'trash');
  if (!pathExists(trash)) return [];
  assertDirectory(trash);
  const receipts = join(trash, '.purge-receipts');
  if (!pathExists(receipts)) return [];
  assertDirectory(receipts);
  return readdirSync(receipts).filter(name => ENTRY_ID.test(name.slice(0, -5)) && name.endsWith('.json'))
    .flatMap(name => {
      const receiptPath = join(receipts, name);
      try {
        const stat = lstatSync(receiptPath);
        if (!stat.isFile() || stat.isSymbolicLink()) return [];
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        const id = name.slice(0, -5);
        if (receipt.id !== id || receipt.mode !== 'recoverable'
            || !['complete', 'needs-review'].includes(receipt.state)
            || pathExists(join(trash, id))) return [];
        const record = receipt.record;
        if (record?.id !== id || !['site', 'page'].includes(record.kind)) return [];
        assertSiteName(record.host);
        if (record.kind === 'page' && !isSafePageName(record.name)) return [];
        let backup;
        try {
          const root = backupRootFor(dataRoot, backupRoot);
          if (!root) throw new Error('trash backup root is not configured');
          const directory = join(root, id, receipt.backup.sourceRevision);
          assertDirectory(directory);
          const manifestPath = join(directory, 'manifest.json');
          const manifestStat = lstatSync(manifestPath);
          if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('backup manifest is not a regular file');
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
          if (manifest.id !== id || manifest.sourceRevision !== receipt.backup.sourceRevision
              || manifest.treeHash !== receipt.backup.treeHash) throw new Error('backup manifest differs from purge receipt');
          assertDirectory(join(directory, 'entry'));
          backup = { available: true, directory, sameFilesystem: receipt.backup.sameFilesystem };
        } catch (error) { backup = { available: false, reason: String(error?.message ?? error) }; }
        return [{ id, kind: record.kind, host: record.host, name: record.name ?? null,
          state: receipt.state === 'complete' ? 'purged' : 'needs-review',
          createdAt: receipt.completedAt ?? receipt.startedAt,
          revision: receipt.backup.sourceRevision,
          stagingPresent: pathExists(join(trash, `.purging-${id}`)),
          reconciliation: receipt.reconciliation ?? null, backup }];
      } catch { return []; }
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function previewTrash(id, { dataRoot = DATA_ROOT, backupRoot } = {}) {
  reconcileStartedReceipt(id, dataRoot);
  const entry = readEntry(dataRoot, id);
  const paths = [];
  const hash = createHash('sha256');
  let files = 0, dirs = 0, logicalBytes = 0, potentiallyReclaimableBytes = 0, unsafe = false;
  const scan = (dir, rel = '') => {
    dirs++;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const childRel = rel ? rel + '/' + name : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) unsafe = true;
      if (stat.isFile()) {
        files++;
        logicalBytes += stat.size;
        if (stat.nlink === 1) potentiallyReclaimableBytes += stat.size;
        hash.update(hashFile(path));
      }
      paths.push(childRel);
      hash.update(JSON.stringify([childRel, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode]));
      if (stat.isDirectory()) scan(path, childRel);
    }
  };
  scan(entry.dir);
  const payloadPresent = paths.some(path => path === 'site' || path.startsWith('site/')
    || path === 'page' || path.startsWith('page/'));
  const emptyTerminal = ['restored', 'aborted'].includes(entry.record.state)
    && !unsafe && paths.length === 1 && paths[0] === 'record.json';
  let backup = null;
  try {
    const root = backupRootFor(dataRoot, backupRoot);
    if (root) {
      try {
        const verified = verifyTrashBackup(id, hash.copy().digest('hex'), { dataRoot, backupRoot: root });
        if (!treeMatchesBackup(entry.dir, verified)) throw new Error('trash entry differs from external backup');
        backup = { configured: true, verified: true, directory: verified.directory,
          treeHash: verified.treeHash, sameFilesystem: verified.sameFilesystem };
      } catch (error) {
        backup = { configured: true, verified: false, reason: String(error?.message ?? error) };
      }
    }
  } catch (error) { backup = { configured: true, verified: false, reason: String(error?.message ?? error) }; }
  const purgeable = Boolean(emptyTerminal || (!unsafe && entry.record.state === 'ready' && backup?.verified)
    || (!unsafe && ['restored', 'aborted'].includes(entry.record.state) && backup?.verified));
  const reason = purgeable ? null : payloadPresent ? 'payload requires a verified external backup before permanent removal'
    : entry.record.state === 'prepared' ? 'prepared entry may need recovery'
      : entry.record.state === 'ready' ? 'recoverable entry requires an independently verified backup'
        : unsafe ? 'entry contains symlink or special file'
          : 'entry contains additional evidence';
  return { id, kind: entry.record.kind, host: entry.record.host, name: entry.record.name ?? null,
    state: entry.record.state, files, dirs, logicalBytes, potentiallyReclaimableBytes,
    payloadPresent, purgeable, reason, backup,
    revision: hash.digest('hex') };
}

export function backupTrash(id, { dataRoot = DATA_ROOT, revision, backupRoot } = {}) {
  const preview = previewTrash(id, { dataRoot, backupRoot });
  if (preview.revision !== revision) throw new Error('trash entry changed after preview');
  if (!['ready', 'restored', 'aborted'].includes(preview.state)) throw new Error('trash entry is not ready for backup');
  const entry = readEntry(dataRoot, id);
  const verified = createTrashBackup(id, revision, entry.dir, { dataRoot, backupRoot });
  if (previewTrash(id, { dataRoot, backupRoot }).revision !== revision || !treeMatchesBackup(entry.dir, verified)) {
    throw new Error('trash entry changed while backing up');
  }
  return { id, revision, verified: true, directory: verified.directory,
    treeHash: verified.treeHash, files: verified.entries.filter(row => row.type === 'file').length,
    sameFilesystem: verified.sameFilesystem };
}

function removeRegularTree(dir) {
  assertDirectory(dir);
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error('trash entry changed to symlink while purging');
    if (stat.isDirectory()) removeRegularTree(child);
    else if (stat.isFile()) unlinkSync(child);
    else throw new Error('trash entry changed to special file while purging');
  }
  rmdirSync(dir);
}

function archivePreviousRecoveryReceipt(receiptPath, receipts, id, entryRecord) {
  if (!pathExists(receiptPath)) return;
  const stat = lstatSync(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('purge receipt is not a regular file');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.id !== id || receipt.mode !== 'recoverable'
      || !['recovered', 'complete'].includes(receipt.state)
      || JSON.stringify(receipt.record) !== JSON.stringify(entryRecord)) {
    throw new Error('purge receipt already exists');
  }
  const history = join(receipts, 'history');
  mkdirSync(history, { recursive: true });
  assertDirectory(history);
  renameSync(receiptPath, join(history, `${id}-${randomUUID()}.json`));
}

export function purgeTrashRecord(id, { dataRoot = DATA_ROOT, confirmId, revision, backupRoot,
  acceptSameFilesystem = false } = {}) {
  if (confirmId !== id) throw new Error('confirmId must match trash id');
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/i.test(revision)) throw new Error('valid preview revision required');
  const preview = previewTrash(id, { dataRoot, backupRoot });
  if (!preview.purgeable) throw new Error(preview.reason);
  if (preview.revision !== revision) throw new Error('trash entry changed after preview');
  const entry = readEntry(dataRoot, id);
  const receipts = join(dataRoot, 'trash', '.purge-receipts');
  mkdirSync(receipts, { recursive: true });
  assertDirectory(receipts);
  const receiptPath = join(receipts, `${id}.json`);
  const recoverable = !(['restored', 'aborted'].includes(preview.state) && !preview.payloadPresent
    && preview.files === 1 && preview.dirs === 1);
  let backup = null;
  if (recoverable) {
    if (!preview.backup?.verified) throw new Error('verified external backup required');
    backup = verifyTrashBackup(id, revision, { dataRoot, backupRoot });
    if (!treeMatchesBackup(entry.dir, backup)) throw new Error('trash entry differs from external backup');
    if (backup.sameFilesystem && !acceptSameFilesystem) {
      throw new Error('backup shares the data filesystem; explicit risk acknowledgement required');
    }
  }
  if (pathExists(receiptPath)) {
    if (!recoverable) throw new Error('purge receipt already exists');
    archivePreviousRecoveryReceipt(receiptPath, receipts, id, entry.record);
  }
  const receipt = { id, record: entry.record, preview, pid: process.pid,
    startedAt: new Date().toISOString(), state: 'started',
    ...(recoverable ? { mode: 'recoverable', backup: {
      sourceRevision: revision, treeHash: backup.treeHash, directory: backup.directory,
      sameFilesystem: backup.sameFilesystem, riskAccepted: backup.sameFilesystem && acceptSameFilesystem,
    } } : {}) };
  activePurges.add(id);
  try {
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    if (recoverable) {
      const stage = join(dataRoot, 'trash', `.purging-${id}`);
      let deleting = false;
      try {
        if (pathExists(stage)) throw new Error('purge staging directory already exists');
        renameSync(entry.dir, stage);
        if (!treeMatchesBackup(stage, backup)) throw new Error('trash entry changed after staging');
        deleting = true;
        removeRegularTree(stage);
        writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, state: 'complete',
          completedAt: new Date().toISOString() }, null, 2));
        return { id, receipt: `.purge-receipts/${id}.json`, purged: true,
          backup: { directory: backup.directory, treeHash: backup.treeHash,
            sameFilesystem: backup.sameFilesystem } };
      } catch (error) {
        if (!deleting && pathExists(stage) && !pathExists(entry.dir)) {
          try { renameSync(stage, entry.dir); }
          catch (rollbackError) { error.rollbackError = rollbackError; }
        }
        const intact = pathExists(entry.dir) && !pathExists(stage);
        const removed = !pathExists(entry.dir) && !pathExists(stage);
        const state = removed ? 'complete' : intact ? 'aborted' : 'needs-review';
        writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, state,
          reconciliation: removed ? 'entry removed; external backup retained'
            : intact ? 'entry restored after failed purge' : 'purge staging requires manual inspection',
          reconciledAt: new Date().toISOString() }, null, 2));
        if (intact) {
          const history = join(receipts, 'history');
          mkdirSync(history, { recursive: true });
          assertDirectory(history);
          renameSync(receiptPath, join(history, `${id}-${randomUUID()}.json`));
        }
        throw error;
      }
    }
    const recordBytes = readFileSync(entry.recordPath);
    try {
      unlinkSync(entry.recordPath);
      rmdirSync(entry.dir);
    } catch (error) {
      if (pathExists(entry.dir) && !pathExists(entry.recordPath)) writeFileAtomic(entry.recordPath, recordBytes);
      throw error;
    }
    writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, state: 'complete', completedAt: new Date().toISOString() }, null, 2));
    return { id, receipt: `.purge-receipts/${id}.json`, purged: true };
  } finally {
    activePurges.delete(id);
  }
}

export function recoverTrashBackup(id, { dataRoot = DATA_ROOT, confirmId, revision, backupRoot } = {}) {
  if (!ENTRY_ID.test(id) || confirmId !== id || !/^[0-9a-f]{64}$/.test(revision ?? '')) {
    throw new Error('matching trash id and backup revision required');
  }
  const trash = join(dataRoot, 'trash');
  assertDirectory(trash);
  const target = join(trash, id);
  if (pathExists(target) || pathExists(join(trash, `.purging-${id}`))) {
    throw new Error('trash entry or purge staging directory already exists');
  }
  const receiptPath = join(trash, '.purge-receipts', `${id}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.id !== id || receipt.mode !== 'recoverable' || receipt.state !== 'complete'
      || receipt.backup?.sourceRevision !== revision) throw new Error('matching completed purge receipt required');
  const stage = join(trash, `.recovering-${randomUUID()}`);
  try {
    const backup = copyTrashBackup(id, revision, stage, { dataRoot, backupRoot });
    if (backup.treeHash !== receipt.backup.treeHash) throw new Error('purge receipt backup hash mismatch');
    const restoredRecord = JSON.parse(readFileSync(join(stage, 'record.json'), 'utf8'));
    if (restoredRecord.id !== id || !['ready', 'restored', 'aborted'].includes(restoredRecord.state)
        || JSON.stringify(restoredRecord) !== JSON.stringify(receipt.record)) {
      throw new Error('backup record differs from purge receipt');
    }
    renameSync(stage, target);
    writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, state: 'recovered',
      recoveredAt: new Date().toISOString() }, null, 2));
    return { id, restoredToTrash: true, host: restoredRecord.host,
      kind: restoredRecord.kind, state: restoredRecord.state, backup: backup.directory };
  } finally { if (pathExists(stage)) removeRegularTree(stage); }
}

const isMain = process.argv[1]?.replaceAll('\\', '/').endsWith('/audit/site-trash.mjs');
if (isMain) {
  const [command, id, revision, confirmId, riskAcknowledgement] = process.argv.slice(2);
  try {
    if (command === 'list') console.log(JSON.stringify(listTrash(), null, 2));
    else if (command === 'list-purged') console.log(JSON.stringify(listPurgedTrashBackups(), null, 2));
    else if (command === 'restore' && id) console.log(JSON.stringify(restoreTrash(id), null, 2));
    else if (command === 'preview' && id) console.log(JSON.stringify(previewTrash(id), null, 2));
    else if (command === 'backup' && id) console.log(JSON.stringify(backupTrash(id, { revision }), null, 2));
    else if (command === 'purge-record' && id) console.log(JSON.stringify(purgeTrashRecord(id, { revision, confirmId,
      acceptSameFilesystem: riskAcknowledgement === 'accept-same-filesystem' }), null, 2));
    else if (command === 'recover-backup' && id) console.log(JSON.stringify(recoverTrashBackup(id, { revision, confirmId }), null, 2));
    else { console.error('usage: node src/audit/site-trash.mjs list | restore <id> | preview <id> | backup <id> <revision> | purge-record <id> <revision> <confirm-id> [accept-same-filesystem] | recover-backup <id> <revision> <confirm-id>'); process.exitCode = 2; }
  } catch (error) { console.error(error?.message ?? String(error)); process.exitCode = 1; }
}
