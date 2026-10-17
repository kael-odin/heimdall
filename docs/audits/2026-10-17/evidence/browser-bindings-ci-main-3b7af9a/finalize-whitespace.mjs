import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const out = dirname(fileURLToPath(import.meta.url));
const expected = join(process.cwd(), 'docs/audits/2026-10-17/evidence/browser-bindings-ci-main-3b7af9a');
assert.equal(out, expected);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const info = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: hash(bytes) }; };
const load = name => JSON.parse(readFileSync(join(out, name), 'utf8'));
const wx = (name, bytes) => { const path = join(out, name); writeFileSync(path, bytes, { flag: 'wx' }); return { path: name, ...info(path) }; };
const json = (name, value) => wx(name, JSON.stringify(value, null, 2) + '\n');
const before = load('COMPLETED.json'), oldManifest = load('file-manifest.json');
assert.equal(before.status, 'complete'); assert.equal(before.runId, 39000366975);
assert.equal(before.head, '3b7af9ae644cba0f1b045fe58b29fcb48268d4e0');
for (const item of oldManifest.files) assert.deepEqual(info(join(out, item.path)), { bytes: item.bytes, sha256: item.sha256 });
for (const anchor of ['manifest', 'sha256sums']) assert.deepEqual(info(join(out, before[anchor].path)), { bytes: before[anchor].bytes, sha256: before[anchor].sha256 });
const originals = oldManifest.files.filter(file => file.path === 'ci.stdout.log' || file.path.startsWith('commands/') || file.path.startsWith('extracted/') || file.path === 'run-logs.zip');
const rawText = originals.filter(file => /\.(?:log|txt|bin)$/.test(file.path));
const empty = join(tmpdir(), 'heimdall-ci-check-empty-' + randomUUID()); writeFileSync(empty, '', { flag: 'wx' });
function check() {
 const findings = [];
 for (const file of rawText) {
  const args = ['diff', '--no-index', '--check', '--', empty, join(out, file.path)];
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined);
  if (output.trim()) findings.push({ path: file.path, code: result.status, issueLines: output.trim().split(/\r?\n/).length });
 }
 return { checkedFiles: rawText.length, findingFiles: findings.length, findings };
}
const preliminaryCheck = check(); assert.ok(preliminaryCheck.findingFiles > 0);
const history = 'history/pre-whitespace-attributes';
mkdirSync(join(out, history), { recursive: true });
const moved = [];
for (const name of ['.gitattributes', 'README.md', 'file-manifest.json', 'SHA256SUMS.txt', 'COMPLETED.json']) {
 const source = join(out, name), destination = join(out, history, name), originalInfo = info(source);
 assert.equal(existsSync(destination), false); renameSync(source, destination);
 assert.deepEqual(info(destination), originalInfo); moved.push({ from: name, to: history + '/' + name, ...originalInfo });
}
const rules = 'ci.stdout.log -whitespace\ncommands/*.stdout.bin -whitespace\ncommands/*.stderr.log -whitespace\nextracted/**/*.txt -whitespace\n';
wx('.gitattributes', readFileSync(join(out, history, '.gitattributes'), 'utf8') + '\n# Preserve raw CI log whitespace exactly. Only these original-output paths are exempt.\n' + rules);
wx('README.md', readFileSync(join(out, history, 'README.md'), 'utf8')
 + '\n原日志包含 GitHub 原生尾空格，保持字节不变。包内 `.gitattributes` 仅对 `ci.stdout.log`、`commands/*.stdout.bin`、`commands/*.stderr.log` 与 `extracted/**/*.txt` 关闭 whitespace 检查；其余文件继续正常检查。首版生成元数据已原样移动到 `history/pre-whitespace-attributes/`，当前完成链包含该历史。`finalize-whitespace.mjs` 与 `whitespace-verification.json` 记录此步骤，原始命令、JSON、日志与 ZIP 未重写。\n');
const finalCheck = check(); assert.equal(finalCheck.findingFiles, 0);
for (const file of originals) assert.deepEqual(info(join(out, file.path)), { bytes: file.bytes, sha256: file.sha256 });
json('whitespace-verification.json', { schemaVersion: 1, verifiedAt: new Date().toISOString(), preliminaryCheck, finalCheck,
 movedGeneratedMetadata: moved, originalFilesRehashedUnchanged: originals.length, exactAttributeRules: rules.split('\n').filter(Boolean),
 policy: 'All original outputs retain every byte. First generated metadata is preserved under history; replacement derived files are created with wx after moving their predecessors, never overwritten.' });
function files() {
 const result = [];
 function visit(path) {
  const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
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
const previous = moved.find(item => item.from === 'COMPLETED.json');
json('COMPLETED.json', { schemaVersion: 1, status: 'complete', runId: before.runId, head: before.head, completedAt: new Date().toISOString(),
 manifest, sha256sums: sums, previousCompletion: { path: previous.to, bytes: previous.bytes, sha256: previous.sha256 },
 originalZipCrcPassed: before.originalZipCrcPassed, extractedLogFiles: before.extractedLogFiles,
 verifiedCommandAttempts: before.verifiedCommandAttempts, strongSensitiveMatchCount: before.strongSensitiveMatchCount,
 originalOutputBytesUnchanged: true, originalLogWhitespacePreserved: true });
const final = files();
console.log(JSON.stringify({ status: 'complete-with-original-log-whitespace-preserved', fileCount: final.length,
 bytes: final.reduce((sum, item) => sum + item.bytes, 0), preliminaryCheck, finalCheck,
 unchangedOriginalFiles: originals.length, manifest, sha256sums: sums, completedSha256: info(join(out, 'COMPLETED.json')).sha256 }, null, 2));
