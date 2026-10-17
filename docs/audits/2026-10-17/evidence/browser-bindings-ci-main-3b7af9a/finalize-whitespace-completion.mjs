import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const out = dirname(fileURLToPath(import.meta.url));
const relativeRoot = 'docs/audits/2026-10-17/evidence/browser-bindings-ci-main-3b7af9a';
assert.equal(out, join(process.cwd(), relativeRoot));
const history = 'history/pre-whitespace-attributes';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const info = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: hash(bytes) }; };
const load = name => JSON.parse(readFileSync(join(out, name), 'utf8'));
const wx = (name, bytes) => { const path = join(out, name); writeFileSync(path, bytes, { flag: 'wx' }); return { path: name, ...info(path) }; };
const json = (name, value) => wx(name, JSON.stringify(value, null, 2) + '\n');
assert.equal(existsSync(join(out, 'COMPLETED.json')), false);
const previous = load(history + '/COMPLETED.json'), oldManifest = load(history + '/file-manifest.json');
assert.equal(previous.runId, 39000366975); assert.equal(previous.head, '3b7af9ae644cba0f1b045fe58b29fcb48268d4e0');
for (const item of oldManifest.files) {
 const moved = ['.gitattributes', 'README.md'].includes(item.path);
 assert.deepEqual(info(join(out, moved ? history + '/' + item.path : item.path)), { bytes: item.bytes, sha256: item.sha256 });
}
for (const anchor of ['manifest', 'sha256sums']) assert.deepEqual(info(join(out, history, previous[anchor].path)), { bytes: previous[anchor].bytes, sha256: previous[anchor].sha256 });
const originals = oldManifest.files.filter(file => file.path === 'ci.stdout.log' || file.path.startsWith('commands/') || file.path.startsWith('extracted/') || file.path === 'run-logs.zip');
const rawText = originals.filter(file => /\.(?:log|txt|bin)$/.test(file.path));
const names = rawText.map(file => relativeRoot + '/' + file.path);
const attributes = spawnSync('git', ['check-attr', '-z', '--stdin', 'whitespace', 'text'], { input: names.join('\0') + '\0', encoding: 'utf8', windowsHide: true });
assert.equal(attributes.status, 0); assert.equal(attributes.stderr, '');
const pieces = attributes.stdout.split('\0'); assert.equal(pieces.pop(), '');
const entries = [];
for (let i = 0; i < pieces.length; i += 3) entries.push({ path: pieces[i], attribute: pieces[i + 1], value: pieces[i + 2] });
assert.equal(entries.length, rawText.length * 2); assert.ok(entries.every(item => item.value === 'unset'));
const derived = ['README.md', 'archive-ci.mjs', 'finalize-whitespace.mjs', 'finalize-whitespace-completion.mjs'];
const scoped = spawnSync('git', ['check-attr', '-z', '--stdin', 'whitespace'], { input: derived.map(name => relativeRoot + '/' + name).join('\0') + '\0', encoding: 'utf8', windowsHide: true });
assert.equal(scoped.status, 0); assert.equal(scoped.stderr, '');
const scopedPieces = scoped.stdout.split('\0'); assert.equal(scopedPieces.pop(), '');
const outside = [];
for (let i = 0; i < scopedPieces.length; i += 3) outside.push({ path: scopedPieces[i], attribute: scopedPieces[i + 1], value: scopedPieces[i + 2] });
assert.ok(outside.every(item => item.value === 'unspecified'));
const empty = join(tmpdir(), 'heimdall-ci-empty-' + randomUUID()); writeFileSync(empty, '', { flag: 'wx' });
const findings = [];
for (const file of rawText) {
 const result = spawnSync('git', ['diff', '--no-index', '--check', '--', empty, join(out, file.path)], { encoding: 'utf8', windowsHide: true });
 assert.equal(result.error, undefined); const output = result.stdout + result.stderr;
 if (output.trim()) findings.push({ path: file.path, code: result.status, issueLines: output.trim().split(/\r?\n/).length });
}
assert.equal(findings.length, 20);
for (const file of originals) assert.deepEqual(info(join(out, file.path)), { bytes: file.bytes, sha256: file.sha256 });
json(history + '/finalizer-failure.json', { schemaVersion: 1, observedExitCode: 1,
 command: ['node', relativeRoot + '/finalize-whitespace.mjs'],
 observedError: { name: 'AssertionError', code: 'ERR_ASSERTION', actual: 20, expected: 0, file: 'finalize-whitespace.mjs', line: 48 },
 correction: 'The no-index comparison against an outside empty file reports original whitespace even after scoped attributes. It detects source bytes, not the later repository attribute gate. Finalization instead verifies the exact Git attributes and unchanged original byte hashes; no actual Git index is modified.',
 outputPolicy: 'This is a structured record of the captured tool result. No original local stdout/stderr byte archive is claimed. All remote CI command stdout/stderr originals remain included.' });
json('whitespace-verification.json', { schemaVersion: 1, verifiedAt: new Date().toISOString(), originalTextFiles: rawText.length,
 noIndexOriginalByteFindings: findings, repositoryAttributes: entries, nonExemptDerivedFiles: outside,
 originalFilesRehashedUnchanged: originals.length,
 policy: 'Raw output bytes are preserved. Only exact raw-output path patterns have whitespace unset; README and helper source retain normal whitespace checks. Shared index untouched.',
 firstGeneratedMetadata: history, retainedLocalFailure: history + '/finalizer-failure.json' });
function files() {
 const result = [];
 function visit(path) { const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
  if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  else { assert.equal(stat.isFile(), true); result.push({ path: relative(out, path).split(sep).join('/'), ...info(path) }); }
 }
 visit(out); return result;
}
const inventory = files();
const manifest = json('file-manifest.json', { schemaVersion: 1, excludes: ['file-manifest.json', 'SHA256SUMS.txt', 'COMPLETED.json'],
 fileCount: inventory.length, bytes: inventory.reduce((sum, item) => sum + item.bytes, 0), files: inventory });
const sumFiles = [...inventory, manifest].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sums = wx('SHA256SUMS.txt', sumFiles.map(item => item.sha256 + '  ' + item.path).join('\n') + '\n');
for (const item of sumFiles) assert.deepEqual(info(join(out, item.path)), { bytes: item.bytes, sha256: item.sha256 });
const previousInfo = info(join(out, history, 'COMPLETED.json'));
json('COMPLETED.json', { schemaVersion: 1, status: 'complete', runId: previous.runId, head: previous.head, completedAt: new Date().toISOString(),
 manifest, sha256sums: sums, previousCompletion: { path: history + '/COMPLETED.json', ...previousInfo },
 originalZipCrcPassed: previous.originalZipCrcPassed, extractedLogFiles: previous.extractedLogFiles,
 verifiedCommandAttempts: previous.verifiedCommandAttempts, strongSensitiveMatchCount: previous.strongSensitiveMatchCount,
 originalOutputBytesUnchanged: true, originalLogWhitespacePreserved: true, scopedGitWhitespaceAttributesVerified: true });
const final = files();
console.log(JSON.stringify({ status: 'complete-original-output-bytes-preserved', fileCount: final.length,
 bytes: final.reduce((sum, item) => sum + item.bytes, 0), originalFilesVerified: originals.length,
 originalTextFilesWithScopedAttributes: rawText.length, noIndexOriginalWhitespaceFindingFiles: findings.length,
 manifest, sha256sums: sums, completedSha256: info(join(out, 'COMPLETED.json')).sha256 }, null, 2));
