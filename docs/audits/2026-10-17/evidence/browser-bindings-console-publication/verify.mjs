import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
const ROOT = process.cwd(), HERE = join(ROOT, 'core/workspace/_runs/browser-bindings-console-publication-20261017');
const bases = ['docs/audits/2026-10-17/evidence/browser-bindings-console',
  'docs/audits/2026-10-17/evidence/browser-bindings-ci-main-3b7af9a'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const info = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const slash = path => path.replaceAll('\\', '/');
function safe(base, path) {
  assert.equal(typeof path, 'string'); assert.ok(path && !path.includes('\\') && !path.startsWith('/'));
  assert.ok(path.split('/').every(part => part && part !== '.' && part !== '..'));
  const absolute = resolve(base, path); assert.ok(absolute.startsWith(resolve(base) + sep)); return absolute;
}
function walk(base, sub = '') { return readdirSync(join(base, sub)).sort().flatMap(name => {
  const path = join(sub, name), stat = lstatSync(join(base, path)); assert.ok(!stat.isSymbolicLink());
  if (stat.isDirectory()) return walk(base, path); assert.ok(stat.isFile());
  return [{ path: slash(path), ...info(join(base, path)) }];
}).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
const rules = [['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['openai-long-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{48,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g]];
const matches = [], scanFiles = [], packages = [], stagedPaths = [];
function scan(name, bytes) {
  for (const [rule, pattern] of rules) { pattern.lastIndex = 0;
    const count = [...bytes.toString('utf8').matchAll(pattern)].length; if (count) matches.push({ name, rule, count }); }
  scanFiles.push(name);
}
const verification = mkdtempSync(join(HERE, 'extracted-'));
for (const base of bases) {
  const absolute = safe(ROOT, base), paths = walk(absolute), complete = json(join(absolute, 'COMPLETED.json'));
  assert.equal(complete.status, 'complete');
  const manifestName = base.endsWith('browser-bindings-console') ? 'package-files.json' : 'file-manifest.json';
  const manifest = json(join(absolute, manifestName));
  const excluded = manifest.excludes ?? ['package-files.json', 'COMPLETED.json'];
  assert.deepEqual(paths.map(file => file.path), [...manifest.files.map(file => file.path), ...excluded].sort());
  for (const file of manifest.files) assert.deepEqual(info(safe(absolute, file.path)), { bytes: file.bytes, sha256: file.sha256 });
  const anchor = complete.inventory ?? complete.manifest;
  assert.deepEqual(info(safe(absolute, anchor.path)), { bytes: anchor.bytes, sha256: anchor.sha256 });
  let archives = 0, archivedFiles = 0, copies = 0;
  if (base.endsWith('browser-bindings-console')) {
    const provenance = json(join(absolute, 'provenance.json'));
    assert.equal(provenance.sources.length, 12); assert.equal(provenance.stages.length, 9);
    for (const source of provenance.sources) assert.deepEqual(info(safe(ROOT, source.path)), { bytes: source.bytes, sha256: source.sha256 });
    for (const stage of provenance.stages) { assert.equal(stage.exitCode, 0); assert.equal(stage.signal, null); }
    const frozen = safe(ROOT, 'core/workspace/_runs/browser-bindings-console-gates-20261017');
    assert.deepEqual(json(join(frozen, 'source-before.json')), provenance.sources);
    assert.deepEqual(json(join(frozen, 'source-after.json')), provenance.sources);
    for (const copy of provenance.copies) {
      const source = readFileSync(safe(ROOT, copy.source)), stored = readFileSync(safe(absolute, copy.path));
      assert.ok((copy.gzipRoundTrip ? gunzipSync(stored) : stored).equals(source), copy.path); copies++;
    }
    for (const archive of provenance.archives) {
      const target = safe(absolute, archive.archive.path), source = safe(ROOT, archive.source);
      assert.deepEqual(info(target), { bytes: archive.archive.bytes, sha256: archive.archive.sha256 });
      const index = json(safe(absolute, archive.fileIndex.path));
      const restored = join(verification, 'archive-' + archives++); mkdirSync(restored);
      const extraction = spawnSync('tar', ['-xzf', target, '-C', restored], { windowsHide: true, encoding: 'utf8' });
      assert.equal(extraction.status, 0, extraction.stderr); assert.deepEqual(walk(restored), index);
      for (const file of index) {
        const bytes = readFileSync(safe(restored, file.path)); assert.ok(bytes.equals(readFileSync(safe(source, file.path))));
        if (!file.path.endsWith('.png')) scan(archive.archive.path + ':' + file.path, bytes); archivedFiles++;
      }
    }
  } else {
    assert.equal(complete.runId, 39000366975); assert.equal(complete.head, '3b7af9ae644cba0f1b045fe58b29fcb48268d4e0');
    const checkZip = spawnSync('python', ['-c',
      'import sys,json,zipfile,pathlib,hashlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/"run-logs.zip"); assert z.testzip() is None; idx=json.loads((p/"zip-inventory.json").read_text(encoding="utf-8")); names=[i.filename for i in z.infolist() if not i.is_dir()]; assert sorted(names)==sorted(x["path"] for x in idx["files"]); total=0\nfor f in idx["files"]:\n b=z.read(f["path"]); assert len(b)==f["bytes"]; assert hashlib.sha256(b).hexdigest()==f["sha256"]; assert b==(p/"extracted"/f["path"]).read_bytes(); total+=len(b)\nprint(json.dumps({"status":"passed","entries":len(z.infolist()),"files":len(names),"bytes":total}))', absolute],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(checkZip.status, 0, checkZip.stderr); assert.equal(JSON.parse(checkZip.stdout).files, 60);
    const sums = readFileSync(join(absolute, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
    for (const line of sums) { const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line); assert.ok(match, line);
      assert.equal(info(safe(absolute, match[2])).sha256, match[1]); }
  }
  for (const file of paths) {
    const bytes = readFileSync(safe(absolute, file.path));
    if (/\.(?:png|zip|tar\.gz)$/.test(file.path)) continue;
    scan(base + '/' + file.path, file.path.endsWith('.gz') ? gunzipSync(bytes) : bytes);
  }
  packages.push({ base, files: paths.length, bytes: paths.reduce((sum, file) => sum + file.bytes, 0),
    manifestEntries: manifest.files.length, archives, archivedFiles, copies });
  for (const file of paths) stagedPaths.push(base + '/' + file.path);
}
if (process.argv.includes('--staged')) {
  const result = spawnSync('git', ['cat-file', '--batch'], { windowsHide: true,
    input: stagedPaths.map(path => ':' + path + '\n').join(''), maxBuffer: 128 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString()); let offset = 0;
  for (const path of stagedPaths) {
    const end = result.stdout.indexOf(10, offset), header = result.stdout.subarray(offset, end).toString('utf8');
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(header); assert.ok(match, 'Missing staged blob: ' + path + ' ' + header);
    const size = Number(match[2]), bytes = result.stdout.subarray(end + 1, end + 1 + size);
    assert.ok(bytes.equals(readFileSync(safe(ROOT, path))), 'Staged bytes differ: ' + path);
    assert.equal(result.stdout[end + 1 + size], 10); offset = end + size + 2;
  }
  assert.equal(offset, result.stdout.length);
}
const summary = { schemaVersion: 1, status: matches.length ? 'needs-review' : 'passed', verifiedAt: new Date().toISOString(),
  packages, scannedItems: scanFiles.length, strongCredentialRules: rules.map(([rule]) => rule), matches,
  stagedEvidenceFiles: process.argv.includes('--staged') ? stagedPaths.length : 0,
  verificationDirectory: slash(relative(ROOT, verification)),
  boundaries: 'Independent original-source, full-set tar extraction, SHA, lossless gzip and ZIP byte checks. Strong-pattern scan is bounded, not a guarantee of finding arbitrary credentials.' };
writeFileSync(join(HERE, (process.argv.includes('--staged') ? 'staged-verification' : 'independent-verification') + '.json'),
  JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary, null, 2)); assert.deepEqual(matches, []);
