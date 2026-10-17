import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
const ROOT = process.cwd();
const bases = ['docs/audits/2026-10-17/evidence/browser-bindings', 'docs/audits/2026-10-17/evidence/catalog-schema3-ci-main-db3cd3f'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
function filesOf(base, sub = '') { return readdirSync(join(base, sub)).sort().flatMap(name => {
  const path = join(sub, name), stat = lstatSync(join(base, path)); assert.ok(!stat.isSymbolicLink());
  return stat.isDirectory() ? filesOf(base, path) : [path.replaceAll('\\', '/')];
}); }
const scanRules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['openai-long-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{48,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g],
];
const scans = [], packages = [], staged = [];
function scan(name, bytes) {
  const text = bytes.toString('utf8');
  for (const [rule, pattern] of scanRules) { pattern.lastIndex = 0; const matches = [...text.matchAll(pattern)];
    if (matches.length) scans.push({ name, rule, count: matches.length }); }
}
for (const base of bases) {
  const absolute = join(ROOT, base), complete = JSON.parse(readFileSync(join(absolute, 'COMPLETED.json'), 'utf8'));
  assert.ok(complete.status === 'complete' || complete.status === 'completed');
  const paths = filesOf(absolute);
  for (const path of paths) {
    const bytes = readFileSync(join(absolute, path));
    if (path.endsWith('.tar.gz')) {
      const listing = spawnSync('tar', ['-tzf', join(absolute, path)], { encoding: 'utf8', windowsHide: true }); assert.equal(listing.status, 0);
      for (const member of listing.stdout.split(/\r?\n/).filter(line => line && !line.endsWith('/'))) {
        const extracted = spawnSync('tar', ['-xOzf', join(absolute, path), member], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(extracted.status, 0); scan(base + '/' + path + ':' + member, extracted.stdout);
      }
    } else if (path.endsWith('.gz')) scan(base + '/' + path + ':gunzip', gunzipSync(bytes));
    else if (!/\.(?:png|zip)$/.test(path)) scan(base + '/' + path, bytes);
  }
  if (base.endsWith('browser-bindings')) {
    const inventory = JSON.parse(readFileSync(join(absolute, 'package-files.json'), 'utf8'));
    assert.deepEqual(paths, [...inventory.files.map(item => item.path), 'package-files.json', 'COMPLETED.json'].sort());
    for (const file of inventory.files) assert.deepEqual(record(join(absolute, file.path)), { bytes: file.bytes, sha256: file.sha256 });
    assert.equal(complete.inventory.sha256, record(join(absolute, 'package-files.json')).sha256);
    const provenance = JSON.parse(readFileSync(join(absolute, 'provenance.json'), 'utf8'));
    for (const copy of provenance.copies) {
      const source = readFileSync(join(ROOT, copy.source)), target = readFileSync(join(absolute, copy.path));
      assert.ok((copy.gzipRoundTrip ? gunzipSync(target) : target).equals(source), 'Copy changed: ' + copy.path);
    }
    for (const archive of provenance.archives) {
      const index = JSON.parse(readFileSync(join(absolute, archive.fileIndex.path), 'utf8'));
      const listing = spawnSync('tar', ['-tzf', join(absolute, archive.archive.path)], { encoding: 'utf8', windowsHide: true }); assert.equal(listing.status, 0);
      const members = listing.stdout.split(/\r?\n/).filter(line => line && !line.endsWith('/'));
      assert.deepEqual(members.map(member => member.replace(/^\.\//, '')).sort(), index.map(file => file.path).sort());
      for (const file of index) {
        const extracted = spawnSync('tar', ['-xOzf', join(absolute, archive.archive.path), './' + file.path], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(extracted.status, 0); assert.equal(extracted.stdout.length, file.bytes); assert.equal(sha(extracted.stdout), file.sha256);
        assert.ok(extracted.stdout.equals(readFileSync(join(ROOT, archive.source, file.path))));
      }
    }
    packages.push({ base, files: paths.length, inventoryFiles: inventory.files.length, copiedOrGzipRoundTrips: provenance.copies.length,
      archiveCount: provenance.archives.length, archivedFiles: provenance.archives.reduce((sum, item) => sum + item.fileCount, 0),
      bytes: paths.reduce((sum, path) => sum + record(join(absolute, path)).bytes, 0) });
  } else packages.push({ base, files: paths.length, bytes: paths.reduce((sum, path) => sum + record(join(absolute, path)).bytes, 0) });
  if (process.argv.includes('--staged')) for (const path of paths) {
    const repositoryPath = base + '/' + path;
    const blob = spawnSync('git', ['show', ':' + repositoryPath], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(blob.status, 0, 'Not staged: ' + repositoryPath);
    assert.ok(blob.stdout.equals(readFileSync(join(absolute, path))), 'Staged bytes differ: ' + repositoryPath);
    staged.push(repositoryPath);
  }
}
const result = { schemaVersion: 1, status: scans.length === 0 ? 'passed' : 'needs-review', verifiedAt: new Date().toISOString(),
  packages, strongCredentialPatternMatches: scans, stagedEvidenceFiles: staged.length,
  boundaries: 'Independent tar-member bytes, copies/gzip and complete package membership verification. Strong credential patterns are a bounded scan, not a claim of detecting arbitrary secrets.' };
if (process.argv.includes('--write')) writeFileSync(join(ROOT, 'core/workspace/_runs/browser-bindings-publication-20261017/' +
  (process.argv.includes('--staged') ? 'staged-verification.json' : 'independent-verification.json')), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2)); assert.equal(scans.length, 0);
