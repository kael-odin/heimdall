import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gcCas } from '../src/store/cas.mjs';
import { backupTrash, listPurgedTrashBackups, listTrash, previewTrash, purgeTrashRecord, quarantinePage, quarantineSite, recoverTrashBackup, restoreTrash } from '../src/audit/site-trash.mjs';
import { verifyTrashBackup } from '../src/audit/trash-backup.mjs';

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-site-trash-'));
  const host = 'fixture.test';
  const site = join(dataRoot, 'workspace', host);
  mkdirSync(site, { recursive: true });
  return { dataRoot, host, site };
}

function startedReceipt(f, id, preview) {
  const record = JSON.parse(readFileSync(join(f.dataRoot, 'trash', id, 'record.json'), 'utf8'));
  const dir = join(f.dataRoot, 'trash', '.purge-receipts');
  mkdirSync(dir);
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, record, preview, state: 'started', startedAt: new Date().toISOString() }));
  return path;
}

test('site quarantine preserves CAS links and restores the exact files', () => {
  const f = fixture();
  try {
    const cas = join(f.dataRoot, 'assets-cas');
    mkdirSync(cas);
    const original = join(cas, 'asset.png');
    writeFileSync(original, 'image bytes');
    linkSync(original, join(f.site, 'asset.png'));

    const result = quarantineSite(f.host, { dataRoot: f.dataRoot });
    assert.equal(existsSync(f.site), false);
    assert.equal(readFileSync(join(f.dataRoot, 'trash', result.trashId, 'site', 'asset.png'), 'utf8'), 'image bytes');
    assert.equal(statSync(original).nlink, 2);
    assert.equal(gcCas(cas, { apply: true }).freed, 0);
    assert.equal(listTrash({ dataRoot: f.dataRoot })[0].state, 'ready');

    restoreTrash(result.trashId, { dataRoot: f.dataRoot });
    assert.equal(readFileSync(join(f.site, 'asset.png'), 'utf8'), 'image bytes');
    assert.equal(statSync(original).nlink, 2);
    assert.equal(listTrash({ dataRoot: f.dataRoot })[0].state, 'restored');
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('purge preview protects recoverable payload and only removes an empty terminal record', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.site, 'original.txt'), 'recoverable evidence');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    const entryDir = join(f.dataRoot, 'trash', trashId);
    const ready = previewTrash(trashId, { dataRoot: f.dataRoot });
    assert.equal(ready.payloadPresent, true);
    assert.equal(ready.purgeable, false);
    assert.throws(() => purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, confirmId: trashId, revision: ready.revision,
    }), /backup/);
    assert.equal(readFileSync(join(entryDir, 'site', 'original.txt'), 'utf8'), 'recoverable evidence');

    restoreTrash(trashId, { dataRoot: f.dataRoot });
    const terminal = previewTrash(trashId, { dataRoot: f.dataRoot });
    assert.equal(terminal.purgeable, true);
    assert.equal(terminal.files, 1);
    assert.throws(() => purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, confirmId: 'wrong', revision: terminal.revision,
    }), /confirmId/);
    assert.throws(() => purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, confirmId: trashId, revision: '0'.repeat(64),
    }), /changed after preview/);
    assert.equal(existsSync(entryDir), true);
    assert.equal(readFileSync(join(f.site, 'original.txt'), 'utf8'), 'recoverable evidence');

    const result = purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, confirmId: trashId, revision: terminal.revision,
    });
    assert.equal(result.purged, true);
    assert.equal(existsSync(entryDir), false);
    assert.equal(readFileSync(join(f.site, 'original.txt'), 'utf8'), 'recoverable evidence');
    const receipt = JSON.parse(readFileSync(join(f.dataRoot, 'trash', '.purge-receipts', `${trashId}.json`), 'utf8'));
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.preview.revision, terminal.revision);
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('recoverable trash requires a verified external backup before local payload cleanup and can be restored from it', () => {
  const f = fixture();
  const backupRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-backup-'));
  try {
    writeFileSync(join(f.site, 'original.txt'), 'recoverable evidence');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    const before = previewTrash(trashId, { dataRoot: f.dataRoot, backupRoot });
    assert.equal(before.backup.configured, true);
    assert.equal(before.backup.verified, false);
    assert.throws(() => purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, backupRoot, confirmId: trashId, revision: before.revision,
    }), /verified external backup/);

    const copied = backupTrash(trashId, { dataRoot: f.dataRoot, backupRoot, revision: before.revision });
    assert.equal(copied.verified, true);
    const afterBackup = previewTrash(trashId, { dataRoot: f.dataRoot, backupRoot });
    assert.equal(afterBackup.revision, before.revision);
    assert.equal(afterBackup.backup.verified, true);
    assert.equal(afterBackup.backup.treeHash, copied.treeHash);
    assert.equal(verifyTrashBackup(trashId, before.revision, { dataRoot: f.dataRoot, backupRoot }).treeHash, copied.treeHash);

    const purged = purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, backupRoot, confirmId: trashId, revision: before.revision,
      acceptSameFilesystem: true,
    });
    assert.equal(purged.purged, true);
    assert.equal(existsSync(join(f.dataRoot, 'trash', trashId)), false);
    assert.equal(readFileSync(join(backupRoot, trashId, before.revision, 'entry', 'site', 'original.txt'), 'utf8'), 'recoverable evidence');
    const purgedRows = listPurgedTrashBackups({ dataRoot: f.dataRoot, backupRoot });
    assert.equal(purgedRows.length, 1);
    assert.equal(purgedRows[0].backup.available, true);

    const recovered = recoverTrashBackup(trashId, {
      dataRoot: f.dataRoot, backupRoot, confirmId: trashId, revision: before.revision,
    });
    assert.equal(recovered.restoredToTrash, true);
    assert.equal(readFileSync(join(f.dataRoot, 'trash', trashId, 'site', 'original.txt'), 'utf8'), 'recoverable evidence');
    restoreTrash(trashId, { dataRoot: f.dataRoot });
    assert.equal(readFileSync(join(f.site, 'original.txt'), 'utf8'), 'recoverable evidence');
  } finally {
    rmSync(f.dataRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test('trash backup rejects data-root overlap and detects modified external copies', () => {
  const f = fixture();
  const backupRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-backup-tamper-'));
  try {
    writeFileSync(join(f.site, 'original.txt'), 'recoverable evidence');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    const preview = previewTrash(trashId, { dataRoot: f.dataRoot, backupRoot });
    assert.throws(() => backupTrash(trashId, {
      dataRoot: f.dataRoot, backupRoot: join(f.dataRoot, 'backup'), revision: preview.revision,
    }), /outside the data root/);
    backupTrash(trashId, { dataRoot: f.dataRoot, backupRoot, revision: preview.revision });
    writeFileSync(join(backupRoot, trashId, preview.revision, 'entry', 'site', 'original.txt'), 'tampered');
    assert.throws(() => verifyTrashBackup(trashId, preview.revision, { dataRoot: f.dataRoot, backupRoot }), /hash mismatch/);
    assert.throws(() => purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, backupRoot, confirmId: trashId, revision: preview.revision,
      acceptSameFilesystem: true,
    }), /backup|hash mismatch/);
    assert.equal(readFileSync(join(f.dataRoot, 'trash', trashId, 'site', 'original.txt'), 'utf8'), 'recoverable evidence');
  } finally {
    rmSync(f.dataRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test('page backup preserves removed atlas node through purge and recovery', () => {
  const f = fixture();
  const backupRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-page-backup-'));
  try {
    const page = join(f.site, 'pages', 'home');
    const recon = join(f.site, 'recon');
    mkdirSync(page, { recursive: true });
    mkdirSync(recon);
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(join(page, 'original.txt'), 'page evidence');
    const atlas = JSON.stringify({ nodes: [{ id: 'home', url: 'https://fixture.test/' }], edges: [] });
    writeFileSync(join(recon, 'atlas.json'), atlas);
    const { trashId } = quarantinePage(f.host, 'home', { dataRoot: f.dataRoot });
    const before = previewTrash(trashId, { dataRoot: f.dataRoot, backupRoot });
    backupTrash(trashId, { dataRoot: f.dataRoot, backupRoot, revision: before.revision });
    purgeTrashRecord(trashId, { dataRoot: f.dataRoot, backupRoot, confirmId: trashId,
      revision: before.revision, acceptSameFilesystem: true });
    recoverTrashBackup(trashId, { dataRoot: f.dataRoot, backupRoot, confirmId: trashId,
      revision: before.revision });
    restoreTrash(trashId, { dataRoot: f.dataRoot });
    assert.equal(readFileSync(join(page, 'original.txt'), 'utf8'), 'page evidence');
    assert.equal(readFileSync(join(recon, 'atlas.json'), 'utf8'), atlas);
  } finally {
    rmSync(f.dataRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test('a damaged backup cannot rebuild a purged entry', () => {
  const f = fixture();
  const backupRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-damaged-backup-'));
  try {
    writeFileSync(join(f.site, 'original.txt'), 'recoverable evidence');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    const before = previewTrash(trashId, { dataRoot: f.dataRoot, backupRoot });
    backupTrash(trashId, { dataRoot: f.dataRoot, backupRoot, revision: before.revision });
    purgeTrashRecord(trashId, { dataRoot: f.dataRoot, backupRoot, confirmId: trashId,
      revision: before.revision, acceptSameFilesystem: true });
    writeFileSync(join(backupRoot, trashId, before.revision, 'entry', 'site', 'original.txt'), 'damaged');
    assert.throws(() => recoverTrashBackup(trashId, { dataRoot: f.dataRoot,
      backupRoot, confirmId: trashId, revision: before.revision }), /hash mismatch/);
    assert.equal(existsSync(join(f.dataRoot, 'trash', trashId)), false);
    assert.equal(existsSync(f.site), false);
  } finally {
    rmSync(f.dataRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test('a started receipt becomes complete when the terminal entry was removed before interruption', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.site, 'keep.txt'), 'restored data');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    restoreTrash(trashId, { dataRoot: f.dataRoot });
    const preview = previewTrash(trashId, { dataRoot: f.dataRoot });
    const receiptPath = startedReceipt(f, trashId, preview);
    const entryDir = join(f.dataRoot, 'trash', trashId);
    unlinkSync(join(entryDir, 'record.json'));
    rmdirSync(entryDir);

    const cli = fileURLToPath(new URL('../src/audit/site-trash.mjs', import.meta.url));
    const listed = spawnSync(process.execPath, [cli, 'list'], {
      env: { ...process.env, HEIMDALL_DATA_DIR: f.dataRoot }, encoding: 'utf8',
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), []);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.reconciliation, 'entry absent after interrupted purge');
    assert.equal(readFileSync(join(f.site, 'keep.txt'), 'utf8'), 'restored data');
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('a started receipt becomes aborted when the empty terminal record still exists', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.site, 'keep.txt'), 'restored data');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    restoreTrash(trashId, { dataRoot: f.dataRoot });
    const preview = previewTrash(trashId, { dataRoot: f.dataRoot });
    const receiptPath = startedReceipt(f, trashId, preview);

    assert.equal(previewTrash(trashId, { dataRoot: f.dataRoot }).purgeable, true);
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).state, 'aborted');
    assert.equal(existsSync(join(f.dataRoot, 'trash', trashId, 'record.json')), true);
    assert.throws(() => purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, confirmId: trashId, revision: preview.revision,
    }), /purge receipt already exists/);
    assert.equal(readFileSync(join(f.site, 'keep.txt'), 'utf8'), 'restored data');
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('a started receipt restores a terminal record interrupted after unlink', () => {
  const f = fixture();
  try {
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    restoreTrash(trashId, { dataRoot: f.dataRoot });
    const preview = previewTrash(trashId, { dataRoot: f.dataRoot });
    const receiptPath = startedReceipt(f, trashId, preview);
    unlinkSync(join(f.dataRoot, 'trash', trashId, 'record.json'));

    assert.deepEqual(listTrash({ dataRoot: f.dataRoot }).map(record => record.id), [trashId]);
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).state, 'aborted');
    assert.equal(JSON.parse(readFileSync(join(f.dataRoot, 'trash', trashId, 'record.json'), 'utf8')).state, 'restored');
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('started receipts never reconcile recoverable payload or added evidence as complete', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.site, 'keep.txt'), 'recoverable');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    const readyPreview = previewTrash(trashId, { dataRoot: f.dataRoot });
    const receiptPath = startedReceipt(f, trashId, readyPreview);
    listTrash({ dataRoot: f.dataRoot });
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).state, 'started');
    assert.equal(readFileSync(join(f.dataRoot, 'trash', trashId, 'site', 'keep.txt'), 'utf8'), 'recoverable');

    restoreTrash(trashId, { dataRoot: f.dataRoot });
    const terminal = previewTrash(trashId, { dataRoot: f.dataRoot });
    writeFileSync(receiptPath, JSON.stringify({ id: trashId,
      record: JSON.parse(readFileSync(join(f.dataRoot, 'trash', trashId, 'record.json'), 'utf8')),
      preview: terminal, state: 'started', startedAt: new Date().toISOString() }));
    writeFileSync(join(f.dataRoot, 'trash', trashId, 'extra.txt'), 'evidence');
    listTrash({ dataRoot: f.dataRoot });
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).state, 'needs-review');
    assert.equal(readFileSync(join(f.dataRoot, 'trash', trashId, 'extra.txt'), 'utf8'), 'evidence');
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('receipt reconciliation refuses a symlinked trash root', (t) => {
  const f = fixture();
  const external = mkdtempSync(join(tmpdir(), 'heimdall-trash-external-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    const receipts = join(external, '.purge-receipts');
    mkdirSync(receipts);
    const receiptPath = join(receipts, `${id}.json`);
    writeFileSync(receiptPath, JSON.stringify({ id, record: { id, kind: 'site', host: f.host, state: 'restored' },
      preview: { id, purgeable: true }, state: 'started' }));
    try { symlinkSync(external, join(f.dataRoot, 'trash'), 'junction'); }
    catch (error) { t.skip('directory symlinks unavailable: ' + error.code); return; }
    assert.throws(() => listTrash({ dataRoot: f.dataRoot }), /artifact is not a directory/);
    assert.throws(() => previewTrash(id, { dataRoot: f.dataRoot }), /artifact is not a directory/);
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).state, 'started');
  } finally {
    if (existsSync(join(f.dataRoot, 'trash'))) rmdirSync(join(f.dataRoot, 'trash'));
    rmSync(f.dataRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('trash listing places missing or invalid timestamps last and skips corrupt records', () => {
  const f = fixture();
  try {
    const trash = join(f.dataRoot, 'trash');
    mkdirSync(trash);
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    for (const [index, id] of ids.entries()) {
      const dir = join(trash, id);
      mkdirSync(dir);
      writeFileSync(join(dir, 'record.json'), index === 3 ? '{broken' : JSON.stringify({
        id, kind: 'site', host: f.host, state: 'restored',
        ...(index === 0 ? { createdAt: '2026-10-14T12:00:00.000Z' }
          : index === 2 ? { createdAt: 'not a date' } : {}),
      }));
    }
    assert.deepEqual(listTrash({ dataRoot: f.dataRoot }).map(record => record.id), ids.slice(0, 3));
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('terminal entries with atlas backup or new evidence cannot be purged', () => {
  const f = fixture();
  try {
    const page = join(f.site, 'pages', 'home');
    const atlasPath = join(f.site, 'recon', 'atlas.json');
    mkdirSync(page, { recursive: true });
    mkdirSync(join(f.site, 'recon'));
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(atlasPath, JSON.stringify({ nodes: [{ id: 'home', url: 'https://fixture.test/' }], edges: [] }));
    const { trashId } = quarantinePage(f.host, 'home', { dataRoot: f.dataRoot });
    restoreTrash(trashId, { dataRoot: f.dataRoot });
    const preview = previewTrash(trashId, { dataRoot: f.dataRoot });
    assert.equal(preview.purgeable, false);
    assert.match(preview.reason, /additional evidence/);
    assert.throws(() => purgeTrashRecord(trashId, {
      dataRoot: f.dataRoot, confirmId: trashId, revision: preview.revision,
    }), /additional evidence/);
    assert.equal(existsSync(join(f.dataRoot, 'trash', trashId, 'atlas-before.json')), true);
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('page quarantine restores page and atlas node and edge byte for byte', () => {
  const f = fixture();
  try {
    const page = join(f.site, 'pages', 'home');
    const atlasPath = join(f.site, 'recon', 'atlas.json');
    mkdirSync(page, { recursive: true });
    mkdirSync(join(f.site, 'recon'));
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(join(page, 'clone.html'), '<html>old</html>');
    const atlas = JSON.stringify({ nodes: [
      { id: 'home', url: 'https://fixture.test/' },
      { id: 'about', url: 'https://fixture.test/about' },
    ], edges: [{ from: 'home', to: 'about' }], meta: { pages: 2, edges: 1 } });
    writeFileSync(atlasPath, atlas);

    const result = quarantinePage(f.host, 'home', { dataRoot: f.dataRoot });
    assert.equal(result.removedArtifacts, true);
    assert.equal(result.removedNode, true);
    assert.equal(existsSync(page), false);
    const remaining = JSON.parse(readFileSync(atlasPath, 'utf8'));
    assert.deepEqual(remaining.nodes.map(n => n.id), ['about']);
    assert.deepEqual(remaining.edges, []);
    assert.equal(remaining.meta.pages, 1);

    restoreTrash(result.trashId, { dataRoot: f.dataRoot });
    assert.equal(readFileSync(join(page, 'clone.html'), 'utf8'), '<html>old</html>');
    assert.equal(readFileSync(atlasPath, 'utf8'), atlas);
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('restore refuses a recreated site or page without overwriting either copy', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.site, 'old.txt'), 'old');
    const siteEntry = quarantineSite(f.host, { dataRoot: f.dataRoot });
    mkdirSync(f.site);
    writeFileSync(join(f.site, 'new.txt'), 'new');
    assert.throws(() => restoreTrash(siteEntry.trashId, { dataRoot: f.dataRoot }), /site already exists/);
    assert.equal(readFileSync(join(f.site, 'new.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(join(f.dataRoot, 'trash', siteEntry.trashId, 'site', 'old.txt'), 'utf8'), 'old');

    const page = join(f.site, 'pages', 'home');
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, 'old.txt'), 'old page');
    const pageEntry = quarantinePage(f.host, 'home', { dataRoot: f.dataRoot });
    mkdirSync(page);
    writeFileSync(join(page, 'new.txt'), 'new page');
    assert.throws(() => restoreTrash(pageEntry.trashId, { dataRoot: f.dataRoot }), /page already exists/);
    assert.equal(readFileSync(join(page, 'new.txt'), 'utf8'), 'new page');
    assert.equal(readFileSync(join(f.dataRoot, 'trash', pageEntry.trashId, 'page', 'old.txt'), 'utf8'), 'old page');
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('restore refuses an atlas changed since deletion', () => {
  const f = fixture();
  try {
    const page = join(f.site, 'pages', 'home');
    const atlasPath = join(f.site, 'recon', 'atlas.json');
    mkdirSync(page, { recursive: true });
    mkdirSync(join(f.site, 'recon'));
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(atlasPath, JSON.stringify({ nodes: [{ id: 'home', url: 'https://fixture.test/' }], edges: [] }));
    const result = quarantinePage(f.host, 'home', { dataRoot: f.dataRoot });
    const changed = JSON.stringify({ nodes: [{ id: 'fresh', url: 'https://fixture.test/fresh' }], edges: [] });
    writeFileSync(atlasPath, changed);

    assert.throws(() => restoreTrash(result.trashId, { dataRoot: f.dataRoot }), /atlas changed after deletion/);
    assert.equal(readFileSync(atlasPath, 'utf8'), changed);
    assert.equal(existsSync(page), false);
    assert.equal(existsSync(join(f.dataRoot, 'trash', result.trashId, 'page', 'manifest.json')), true);
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('unsafe names cannot reach another site or the trash root', () => {
  const f = fixture();
  try {
    for (const host of ['..', '.', '../fixture.test']) {
      assert.throws(() => quarantineSite(host, { dataRoot: f.dataRoot }));
    }
    for (const name of ['..', '../other', 'home\\other']) {
      assert.throws(() => quarantinePage(f.host, name, { dataRoot: f.dataRoot }));
    }
    assert.equal(existsSync(f.site), true);
    assert.deepEqual(listTrash({ dataRoot: f.dataRoot }), []);
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('prepared records recover a move interrupted before the ready marker', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.site, 'original.txt'), 'original');
    const siteResult = quarantineSite(f.host, { dataRoot: f.dataRoot });
    const siteRecord = join(f.dataRoot, 'trash', siteResult.trashId, 'record.json');
    writeFileSync(siteRecord, JSON.stringify({ ...JSON.parse(readFileSync(siteRecord, 'utf8')), state: 'prepared' }));
    restoreTrash(siteResult.trashId, { dataRoot: f.dataRoot });
    assert.equal(readFileSync(join(f.site, 'original.txt'), 'utf8'), 'original');

    const page = join(f.site, 'pages', 'home');
    const atlasPath = join(f.site, 'recon', 'atlas.json');
    mkdirSync(page, { recursive: true });
    mkdirSync(join(f.site, 'recon'));
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    const originalAtlas = JSON.stringify({ nodes: [{ id: 'home', url: 'https://fixture.test/' }], edges: [] });
    writeFileSync(atlasPath, originalAtlas);
    const pageResult = quarantinePage(f.host, 'home', { dataRoot: f.dataRoot });
    const pageRecord = join(f.dataRoot, 'trash', pageResult.trashId, 'record.json');
    writeFileSync(pageRecord, JSON.stringify({ ...JSON.parse(readFileSync(pageRecord, 'utf8')), state: 'prepared' }));
    restoreTrash(pageResult.trashId, { dataRoot: f.dataRoot });
    assert.equal(existsSync(page), true);
    assert.equal(readFileSync(atlasPath, 'utf8'), originalAtlas);
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('page and recon symlinks cannot redirect deletion outside the site', (t) => {
  const f = fixture();
  const external = mkdtempSync(join(tmpdir(), 'heimdall-site-trash-external-'));
  try {
    const outsidePage = join(external, 'home');
    mkdirSync(outsidePage);
    writeFileSync(join(outsidePage, 'keep.txt'), 'keep');
    try { symlinkSync(external, join(f.site, 'pages'), 'junction'); }
    catch (error) { t.skip('directory symlinks unavailable: ' + error.code); return; }
    assert.throws(() => quarantinePage(f.host, 'home', { dataRoot: f.dataRoot }), /artifact is not a directory/);
    assert.equal(readFileSync(join(outsidePage, 'keep.txt'), 'utf8'), 'keep');
    rmdirSync(join(f.site, 'pages'));

    symlinkSync(external, join(f.site, 'recon'), 'junction');
    assert.throws(() => quarantinePage(f.host, 'home', { dataRoot: f.dataRoot }), /artifact is not a directory/);
    assert.equal(readFileSync(join(outsidePage, 'keep.txt'), 'utf8'), 'keep');
    assert.deepEqual(listTrash({ dataRoot: f.dataRoot }), []);
  } finally {
    rmSync(f.dataRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('deleting an absent page without an atlas node is an empty operation', () => {
  const f = fixture();
  try {
    assert.deepEqual(quarantinePage(f.host, 'missing', { dataRoot: f.dataRoot }), {
      removedArtifacts: false, removedNode: false, trashId: null,
    });
    assert.deepEqual(listTrash({ dataRoot: f.dataRoot }), []);
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});

test('CLI lists and restores a site from an isolated data root', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.site, 'marker.txt'), 'saved');
    const { trashId } = quarantineSite(f.host, { dataRoot: f.dataRoot });
    const cli = fileURLToPath(new URL('../src/audit/site-trash.mjs', import.meta.url));
    const run = (args) => spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, HEIMDALL_DATA_DIR: f.dataRoot }, encoding: 'utf8',
    });
    const listed = run(['list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).find(entry => entry.id === trashId)?.state, 'ready');
    const restored = run(['restore', trashId]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).host, f.host);
    assert.equal(readFileSync(join(f.site, 'marker.txt'), 'utf8'), 'saved');
  } finally { rmSync(f.dataRoot, { recursive: true, force: true }); }
});
