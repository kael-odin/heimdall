import assert from 'node:assert/strict';
import { mkdirSync, cpSync, renameSync, readFileSync, lstatSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const repo = process.cwd();
const { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE } = await import(pathToFileURL(join(repo, 'core/src/acceptance/owner.mjs')));
const { readBrowserCandidateSource } = await import(pathToFileURL(join(repo, 'core/src/acceptance/browser-candidate-source.mjs')));
const directory = resolve(repo, 'core/workspace/_runs/browser-reader-root-swap-after-' + randomUUID());
mkdirSync(directory);
const root = join(directory, 'acceptance'), oldRoot = join(directory, 'original-acceptance');
mkdirSync(root);
const fixture = resolve(repo, 'core/test/fixtures/acceptance-browser-source/target-unavailable');
const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'))), runId = manifest.runId;
cpSync(fixture, join(root, runId), { recursive: true });
const owner = acquireAcceptanceOwner({ root });
const identity = path => {
  const stat = lstatSync(path, { bigint: true });
  return Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'mode'].map(key => [key, String(stat[key])]));
};
const lock = join(root, ACCEPTANCE_OWNER_FILE);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalRoot = identity(root), originalLock = identity(lock), originalLockSha256 = sha(readFileSync(lock));
renameSync(root, oldRoot);
mkdirSync(root);
cpSync(join(oldRoot, runId), join(root, runId), { recursive: true });
renameSync(join(oldRoot, ACCEPTANCE_OWNER_FILE), lock);
const currentRoot = identity(root), movedLock = identity(lock);
const report = { schemaVersion: 1, firstReadAfterAcquisition: true, runId,
  originalRoot, currentRoot, originalLock, movedLock, sameLockInode: originalLock.ino === movedLock.ino,
  originalLockSha256, ownerStatus: null, readerStatus: null };
try { owner.assertOwned(); report.ownerStatus = 'accepted'; }
catch (error) { report.ownerStatus = 'rejected'; report.ownerError = { code: error.code, status: error.status }; }
try { const material = readBrowserCandidateSource(runId, { root, owner }); report.readerStatus = 'accepted'; report.files = material.files.size; }
catch (error) { report.readerStatus = 'rejected'; report.readerError = { code: error.code, status: error.status, reason: error.details?.reason }; }
report.releaseResult = owner.release();
report.lockPreserved = existsSync(lock) && sha(readFileSync(lock)) === originalLockSha256;
writeFileSync(join(directory, 'probe.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, report }, null, 2));
assert.notEqual(originalRoot.ino, currentRoot.ino);
assert.equal(report.sameLockInode, true);
assert.equal(report.ownerStatus, 'rejected');
assert.equal(report.ownerError.code, 'ACCEPTANCE_OWNER_LOST');
assert.equal(report.readerStatus, 'rejected');
assert.equal(report.readerError.status, 503);
assert.equal(report.releaseResult, false);
assert.equal(report.lockPreserved, true);
