import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
const ROOT = process.cwd(), RUNS = join(ROOT, 'core/workspace/_runs');
const HERE = join(RUNS, 'browser-bindings-final-gates-20261017');
const DEST = join(ROOT, 'docs/audits/2026-10-17/evidence/browser-bindings');
const slash = value => value.replaceAll('\\', '/');
const rel = value => slash(relative(ROOT, value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const info = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function walk(base, sub = '') {
  return readdirSync(join(base, sub)).sort().flatMap(name => {
    const path = join(sub, name), stat = lstatSync(join(base, path));
    assert.ok(!stat.isSymbolicLink(), 'Symlink in evidence: ' + path);
    if (stat.isDirectory()) return walk(base, path);
    assert.ok(stat.isFile(), 'Not regular evidence: ' + path);
    return [{ path: slash(path), ...info(join(base, path)) }];
  });
}
const totals = files => ({ fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
function testCounts(text) {
  const result = {};
  for (const [, key, value] of text.matchAll(/^\s*(?:#|ℹ)\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)/gm)) result[key] = Number(value);
  assert.ok(Number.isInteger(result.tests) && Number.isInteger(result.pass) && Number.isInteger(result.fail), 'No complete test summary.');
  return result;
}
function finalObject(text) {
  const end = text.lastIndexOf('}');
  const starts = [...text.matchAll(/^\{/gm)].map(item => item.index).reverse();
  for (const start of starts) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  throw new Error('No final JSON object.');
}
function allChecks(summary) {
  assert.ok(summary && Object.keys(summary.checks ?? {}).length > 0);
  if (Number.isSafeInteger(summary.checks.total)) {
    assert.ok(summary.checks.total > 0); assert.equal(summary.checks.passed, summary.checks.total);
    assert.deepEqual(Object.keys(summary.checks).sort(), ['passed', 'total']);
  } else assert.ok(Object.values(summary.checks).every(value => value === true));
  if (summary.errors) assert.deepEqual(summary.errors, []);
}
const stages = readdirSync(HERE).filter(name => name.endsWith('.exitcode.json')).sort().map(name => {
  const record = json(join(HERE, name)); assert.equal(record.exitCode, 0, name); assert.equal(record.signal, null);
  assert.ok(Date.parse(record.finishedAt) >= Date.parse(record.startedAt));
  const stdout = readFileSync(join(HERE, record.stage + '.stdout.log'), 'utf8');
  return { ...record, ...(record.stage === '03-core-test' ? { testCounts: testCounts(stdout) } : {}) };
});
assert.equal(stages.length, 10, 'All final stages required.');
const core = stages.find(item => item.stage === '03-core-test').testCounts;
assert.equal(core.fail, 0); assert.equal(core.cancelled, 0);
const sources = json(join(HERE, 'source-before.json'));
assert.deepEqual(sources, json(join(HERE, 'source-after.json')));
for (const file of sources) assert.deepEqual(info(join(ROOT, file.path)), { bytes: file.bytes, sha256: file.sha256 });
const schemaFinal = join(RUNS, 'browser-binding-schema-051afbde-9664-46ef-ac99-a835092aef11');
const storeFinal = join(RUNS, 'browser-source-binding-tests-115a2cbe-4370-4c29-bdfd-d5cc2a4ee29a');
assert.equal(json(join(schemaFinal, 'exitcode.json')).code, 0);
assert.equal(json(join(storeFinal, 'exitcode.json')).code, 0);
const schemaCounts = testCounts(readFileSync(join(schemaFinal, 'stdout.log'), 'utf8'));
const storeCounts = testCounts(readFileSync(join(storeFinal, 'stdout.log'), 'utf8'));
assert.equal(schemaCounts.tests, 75); assert.equal(schemaCounts.fail, 0);
assert.equal(storeCounts.tests, 58); assert.equal(storeCounts.fail, 0);
const groups = [];
const add = (id, directory, summaryFile, stage) => {
  const summary = summaryFile ? json(join(directory, summaryFile)) : null;
  if (summary && id !== 'cdp-clone') allChecks(summary);
  groups.push({ id, directory: rel(directory), summaryFile, stage, summary, files: walk(directory) });
};
for (const [id, name] of [
  ['schema-initial', 'browser-binding-schema-39b5a245-dc20-4267-b4ac-5d77af7a5c64'],
  ['schema-final', 'browser-binding-schema-051afbde-9664-46ef-ac99-a835092aef11'],
  ['store-initial-failure', 'browser-source-binding-tests-de375ce5-dcc3-4b1f-9ab6-a6192cea2aa8'],
  ['store-final', 'browser-source-binding-tests-115a2cbe-4370-4c29-bdfd-d5cc2a4ee29a'],
  ['fresh-smoke-commands', 'browser-bindings-gates-20261017-c3d9df1f-4aa4-4e1f-81db-0d4f1dfcfa80'],
]) add(id, join(RUNS, name));
for (const [id, name] of [
  ['fresh-smoke-initial', 'browser-bindings-smoke-e9c0f93e-73a6-4b98-b544-31f3fedde0a8'],
  ['fresh-smoke-final', 'browser-bindings-smoke-f8f0978b-0da1-45eb-abf3-9a5c5f7429ee'],
]) {
  add(id, join(RUNS, name), 'summary.json');
  const group = groups.at(-1), summary = group.summary;
  assert.equal(summary.checkCount, 30); assert.equal(summary.bindingAndReadTargetRequests, 0);
  assert.equal(summary.bindingFetchAttempts, 0); assert.deepEqual(summary.forbiddenProcessEvents, []);
  assert.equal(summary.bindings, 4); assert.equal(summary.singleBindingReads, 6);
  const index = json(join(ROOT, group.directory, 'capture-index.json'));
  assert.equal(index.samples.length, 2);
  for (const sample of index.samples) {
    assert.deepEqual(walk(join(ROOT, group.directory, sample.runtimeDirectory)), sample.originalFiles.map(({ file, ...item }) => ({ path: file, ...item })));
    assert.deepEqual(walk(join(ROOT, group.directory, sample.archivedRun)), sample.originalFiles.map(({ file, ...item }) => ({ path: file, ...item })));
  }
}
const smokeGate = groups.find(item => item.id === 'fresh-smoke-commands');
const smokeCommand = json(join(ROOT, smokeGate.directory, 'default-command-result.json'));
assert.equal(smokeCommand.exitCode, 0);
assert.ok(readFileSync(join(ROOT, smokeGate.directory, 'default-stdout.bin'), 'utf8').includes(JSON.stringify(groups.find(item => item.id === 'fresh-smoke-final').summary, null, 2)));
for (const [id, stageName, parent, summaryFile] of [
  ['catalog-console', '05-catalog-browser', 'acceptance-catalog-console', 'browser-checks.json'],
  ['migration-console', '06-migration-browser', 'acceptance-catalog-migration', 'migration-checks.json'],
  ['baseline-console', '07-baseline-browser', 'acceptance-baseline-console', 'browser-checks.json'],
  ['managed-preparation', '08-managed-prepare', null, 'quality-gates.json'],
  ['execution-ui', '09-execution-ui', null, 'browser-checks.json'],
  ['cdp-clone', '10-cdp-clone', null, 'cdp-real-forge.json'],
]) {
  const stage = stages.find(item => item.stage === stageName), printed = finalObject(readFileSync(join(HERE, stageName + '.stdout.log'), 'utf8'));
  let directory;
  if (id === 'cdp-clone') directory = join(HERE, 'cdp-clone');
  else if (printed.outputDirectory) directory = resolve(printed.outputDirectory);
  else {
    const base = join(RUNS, parent);
    const candidates = readdirSync(base).map(name => join(base, name)).filter(path => {
      const time = lstatSync(path).birthtimeMs;
      return lstatSync(path).isDirectory() && time >= Date.parse(stage.startedAt) - 2000 && time <= Date.parse(stage.finishedAt) + 2000;
    });
    assert.equal(candidates.length, 1, id + ' unique output required'); directory = candidates[0];
  }
  assert.ok(rel(directory).startsWith('core/workspace/_runs/'));
  add(id, directory, summaryFile, stageName);
  const summary = groups.at(-1).summary;
  if (id === 'cdp-clone') { assert.equal(summary.taskStatus, 'done'); assert.equal(summary.cloneStatus, 200); assert.deepEqual(summary.pageErrors, []); }
  else if (id === 'managed-preparation') { const { outputDirectory, ...rest } = printed; assert.deepEqual(rest, summary); }
  else if (id === 'execution-ui') { assert.deepEqual(printed.checks, summary.checks); }
  else assert.deepEqual(printed, summary);
}
const sourceRefs = sources.map(file => ({ source: join(ROOT, file.path), target: 'source/' + file.path, ...file }));
const gateFiles = walk(HERE).filter(file => !file.path.startsWith('cdp-clone/') && file.path !== 'README.draft.md' && !file.path.startsWith('verification-'));
const inputs = [...sourceRefs.map(item => ({ absolute: item.source, bytes: item.bytes, sha256: item.sha256 })),
  ...groups.flatMap(group => group.files.map(file => ({ absolute: join(ROOT, group.directory, file.path), bytes: file.bytes, sha256: file.sha256 }))),
  ...gateFiles.map(file => ({ absolute: join(HERE, file.path), bytes: file.bytes, sha256: file.sha256 }))];
for (const file of inputs) assert.deepEqual(info(file.absolute), { bytes: file.bytes, sha256: file.sha256 });
if (process.argv[2] !== '--publish') { console.log(JSON.stringify({ ready: true, core, schemaCounts, storeCounts, groups: groups.map(({ files, summary, ...group }) => ({ ...group, ...totals(files) })), sources: sources.length }, null, 2)); process.exit(0); }
assert.ok(!existsSync(DEST), 'Refuse overwriting evidence package.');
const verification = mkdtempSync(join(HERE, 'verification-'));
mkdirSync(DEST);
function write(path, bytes) { const target = join(DEST, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' }); assert.ok(readFileSync(target).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))); return { path, ...info(target) }; }
const writeJson = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
write('.gitattributes', '* -text\nREADME.md text eol=lf\n.gitattributes text eol=lf\nsource/** whitespace=cr-at-eol\n');
const copies = [], archives = [];
const copy = (source, target) => { const result = write(target, readFileSync(source)); copies.push({ source: rel(source), ...result }); };
for (const file of sourceRefs) copy(file.source, file.target);
for (const file of gateFiles) {
  const source = join(HERE, file.path), bytes = readFileSync(source);
  if (file.path.endsWith('.log')) {
    const compressed = gzipSync(bytes); assert.ok(gunzipSync(compressed).equals(bytes));
    copies.push({ source: rel(source), originalBytes: bytes.length, originalSha256: sha(bytes), gzipRoundTrip: true, ...write('gates/' + file.path + '.gz', compressed) });
  } else copy(source, 'gates/' + file.path);
}
for (const group of groups) {
  const source = join(ROOT, group.directory), filename = 'originals/' + group.id + '.tar.gz', target = join(DEST, filename);
  mkdirSync(dirname(target), { recursive: true });
  const fd = openSync(target, 'wx'); let result;
  try { result = spawnSync('tar', ['-czf', '-', '-C', source, '.'], { windowsHide: true, stdio: ['ignore', fd, 'pipe'] }); } finally { closeSync(fd); }
  assert.equal(result.status, 0, String(result.stderr));
  const restored = join(verification, group.id); mkdirSync(restored);
  const unpack = spawnSync('tar', ['-xzf', target, '-C', restored], { encoding: 'utf8', windowsHide: true }); assert.equal(unpack.status, 0, unpack.stderr);
  assert.deepEqual(walk(restored), group.files);
  for (const file of group.files) assert.ok(readFileSync(join(source, file.path)).equals(readFileSync(join(restored, file.path))));
  archives.push({ id: group.id, source: group.directory, archive: { path: filename, ...info(target) },
    fileIndex: writeJson('originals/' + group.id + '.files.json', group.files), ...totals(group.files), byteRoundTripPassed: true });
  for (const file of group.files.filter(file =>
    (!file.path.includes('/') && /\.(?:json|png)$/.test(file.path))
    || group.id === 'fresh-smoke-final' && file.path.startsWith('runs/') && file.path.endsWith('.png'))) copy(join(source, file.path), 'browse/' + group.id + '/' + file.path);
}
for (const file of inputs) assert.deepEqual(info(file.absolute), { bytes: file.bytes, sha256: file.sha256 });
const productHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }); assert.equal(productHead.status, 0);
writeJson('provenance.json', { schemaVersion: 1, capturedAt: new Date().toISOString(), parentHead: productHead.stdout.trim(),
  sourceState: 'Working-tree implementation frozen before full gates; source bytes are recorded separately from the parent commit.',
  sources, stages, groups, archives, copies,
  boundaries: ['B internal store/schema only; no HTTP/UI or Browser approval/selection/execution.',
    'Fresh captures are controlled local fixtures; original runtime and copied run trees are preserved separately.',
    'Both successful smoke rounds are retained; final default command is authoritative and counts are not added.',
    'First store failure contains two failed leaves and one failed parent. Test expectations were corrected without product or timeout changes.',
    'No remote CI is included in this local package.'] });
writeJson('summary.json', { schemaVersion: 1, status: 'passed', fullCore: core, schemaFocused: schemaCounts, storeFocused: storeCounts,
  storeInitial: testCounts(readFileSync(join(RUNS, 'browser-source-binding-tests-de375ce5-dcc3-4b1f-9ab6-a6192cea2aa8/stdout.log'), 'utf8')),
  authoritativeFreshSmoke: groups.find(group => group.id === 'fresh-smoke-final').summary,
  stages: stages.map(({ testCounts, ...item }) => item), archiveRoundTrips: archives.map(({ source, archive, fileIndex, ...item }) => item),
  countPolicy: 'Full Core counted once; focused tests, initial attempts, fresh smoke checks and UI regression checks are separate and overlap.' });
write('README.md', readFileSync(join(HERE, 'README.draft.md')));
const inventory = walk(DEST);
const inventoryFile = writeJson('package-files.json', { schemaVersion: 1, excludesSelf: true, excludesCompletionReceipt: true, ...totals(inventory), files: inventory });
for (const file of inventory) assert.deepEqual(info(join(DEST, file.path)), { bytes: file.bytes, sha256: file.sha256 });
writeJson('COMPLETED.json', { schemaVersion: 1, status: 'complete', completedAt: new Date().toISOString(),
  inventory: inventoryFile, inventoryFileCount: inventory.length, archiveCount: archives.length, allByteRoundTripsPassed: true, sourcesUnchanged: true });
console.log(JSON.stringify({ status: 'published', directory: rel(DEST), verificationDirectory: rel(verification), ...totals(walk(DEST)), archives: archives.length, copies: copies.length }, null, 2));
