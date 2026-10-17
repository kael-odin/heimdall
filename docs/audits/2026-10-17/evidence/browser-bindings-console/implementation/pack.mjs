import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..'), RUNS = join(ROOT, 'core/workspace/_runs');
const GATES = join(RUNS, 'browser-bindings-console-gates-20261017');
const DEST = join(ROOT, 'docs/audits/2026-10-17/evidence/browser-bindings-console');
const mode = process.argv[2];
assert.ok(['--dry-run', '--publish'].includes(mode) && process.argv.length === 3, 'Use exactly --dry-run or --publish.');
const slash = value => value.replaceAll('\\', '/');
const rel = value => slash(relative(ROOT, value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const info = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const totals = files => ({ fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
function inside(base, path) { const name = relative(base, path); return name && !name.startsWith('..') && !isAbsolute(name); }
function walk(base, sub = '') {
  assert.equal(lstatSync(base).isSymbolicLink(), false);
  return readdirSync(join(base, sub)).flatMap(name => {
    const path = join(sub, name), stat = lstatSync(join(base, path));
    assert.equal(stat.isSymbolicLink(), false, 'Symlink in evidence: ' + path);
    if (stat.isDirectory()) return walk(base, path);
    assert.ok(stat.isFile(), 'Nonregular evidence: ' + path);
    return [{ path: slash(path), ...info(join(base, path)) }];
  }).sort(compare);
}
function counts(text) {
  const result = {}, occurrences = {};
  for (const [, key, value] of text.matchAll(/^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)\s*$/gm)) {
    result[key] = Number(value); occurrences[key] = (occurrences[key] ?? 0) + 1;
  }
  assert.equal(Object.keys(result).length, 8, 'Incomplete test totals');
  assert.ok(Object.values(occurrences).every(count => count === 1), 'Ambiguous duplicate test totals');
  assert.equal(result.tests, result.pass + result.fail + result.cancelled + result.skipped + result.todo);
  return result;
}
function finalObject(text) {
  const end = text.lastIndexOf('}');
  for (const start of [...text.matchAll(/^\{/gm)].map(item => item.index).reverse()) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error('No final structured stdout object');
}
function allChecks(summary) {
  assert.ok(summary && Object.keys(summary.checks ?? {}).length > 0);
  assert.ok(summary.status === 'passed' || summary.passed === true);
  if (Number.isSafeInteger(summary.checks.total)) {
    assert.ok(summary.checks.total > 0); assert.equal(summary.checks.passed, summary.checks.total);
  } else assert.ok(Object.values(summary.checks).every(value => value === true));
  if (summary.errors) assert.deepEqual(summary.errors, []);
  if (summary.pageErrors) assert.deepEqual(summary.pageErrors, []);
}
const groups = [];
function add(id, directory, summaryFile = null, stage = null) {
  assert.ok(inside(RUNS, directory), 'Evidence must stay under the exact repository runs root');
  const summary = summaryFile ? json(join(directory, summaryFile)) : null;
  const group = { id, directory: rel(directory), summaryFile, stage, summary, files: walk(directory) };
  groups.push(group); return group;
}
function verifyLoggedOutput(directory, record, prefix = '') {
  for (const channel of ['stdout', 'stderr']) if (record[channel]) {
    const reference = record[channel], path = isAbsolute(reference.path) ? reference.path : join(directory, reference.path);
    assert.ok(inside(directory, path), prefix + ' output escapes its original directory');
    assert.deepEqual(info(path), { bytes: reference.bytes, sha256: reference.sha256 });
  }
}

const sources = json(join(GATES, 'source-before.json'));
assert.equal(sources.length, 12); assert.equal(new Set(sources.map(file => file.path)).size, sources.length);
for (const file of sources) assert.deepEqual(info(join(ROOT, file.path)), { bytes: file.bytes, sha256: file.sha256 });
const sourceFor = path => { const record = sources.find(file => file.path === path); assert.ok(record, path); return record; };
const dto = add('dto-focused', join(RUNS, 'browser-binding-http-dto-73e57b7a-29a6-4ee0-aff8-998e8c5cd7cc'));
for (const name of ['api-syntax', 'view-syntax', 'dto-tests']) {
  const record = json(join(ROOT, dto.directory, name + '.exitcode.json'));
  assert.equal(record.code, 0); assert.equal(record.signal, null); verifyLoggedOutput(join(ROOT, dto.directory), record, name);
}
const dtoCounts = counts(readFileSync(join(ROOT, dto.directory, 'dto-tests.stdout.log'), 'utf8'));
assert.equal(dtoCounts.tests, 20); assert.equal(dtoCounts.fail, 0);
const http = [
  ['http-initial', '2315c9f8-a136-4154-b54b-4e2ed140b6c1', 1, 26, 20, 6],
  ['http-second', 'b4f8f91b-ba31-4b29-ba95-c6a8c017d9b5', 1, 34, 32, 2],
  ['http-final', 'bd1a42cf-901c-41ff-bcaf-533c37a5fa83', 0, 34, 34, 0],
].map(([id, suffix, code, tests, pass, fail]) => {
  const group = add(id, join(RUNS, 'browser-bindings-http-tests-' + suffix));
  const directory = join(ROOT, group.directory), record = json(join(directory, 'exitcode.json'));
  assert.equal(record.code, code); assert.equal(record.signal, null);
  const actual = counts(readFileSync(join(directory, 'test.stdout.log'), 'utf8'));
  assert.deepEqual(actual, record.totals); assert.equal(actual.tests, tests); assert.equal(actual.pass, pass); assert.equal(actual.fail, fail);
  for (const file of record.files) assert.deepEqual(info(join(directory, file.file)), { bytes: file.bytes, sha256: file.sha256 });
  return { id, ...actual };
});
const finalHttpInputs = json(join(ROOT, groups.find(group => group.id === 'http-final').directory, 'input.json')).inputs;
const httpSource = finalHttpInputs.find(file => file.file === 'test/acceptance-browser-binding-api.test.mjs');
assert.deepEqual({ bytes: httpSource.bytes, sha256: httpSource.sha256 }, { bytes: sourceFor('core/' + httpSource.file).bytes, sha256: sourceFor('core/' + httpSource.file).sha256 });
for (const file of finalHttpInputs) assert.deepEqual(info(join(ROOT, 'core', file.file)), { bytes: file.bytes, sha256: file.sha256 });

const attemptGroup = add('fresh-ui-command', join(RUNS, 'browser-bindings-console-attempts-20261017'));
const attemptRoot = join(ROOT, attemptGroup.directory);
const attempts = readdirSync(attemptRoot).filter(name => /^attempt-[a-f0-9-]{36}$/.test(name)).sort();
assert.equal(attempts.length, 1, 'Explicitly review any later attempt before changing the authoritative round');
const attemptDirectory = join(attemptRoot, attempts[0]), attempt = json(join(attemptDirectory, 'exitcode.json'));
const attemptCommand = json(join(attemptDirectory, 'command.json'));
assert.equal(attempt.command, 'pnpm acceptance:browser:bindings:ui:smoke'); assert.equal(attempt.exitCode, 0); assert.equal(attempt.signal, null);
const smokeSource = sourceFor('core/scripts/smoke-acceptance-browser-bindings-console.mjs');
assert.deepEqual(info(join(attemptDirectory, 'smoke-source.mjs')), { bytes: smokeSource.bytes, sha256: smokeSource.sha256 });
assert.equal(attemptCommand.sourceBytes, smokeSource.bytes); assert.equal(attemptCommand.sourceSha256, smokeSource.sha256);
const printedFresh = finalObject(readFileSync(join(attemptDirectory, 'stdout.log'), 'utf8'));
const freshDirectory = join(RUNS, 'browser-bindings-console-smoke-dfb73d91-b154-47c0-99a9-86b6b7e8eeb2');
assert.equal(resolve(printedFresh.outputDirectory), freshDirectory);
const fresh = add('fresh-ui', freshDirectory, 'browser-checks.json'); allChecks(fresh.summary);
assert.deepEqual(printedFresh.checks, fresh.summary.checks); assert.equal(printedFresh.checkCount, 14);
assert.equal(fresh.summary.checkCount, 14); assert.equal(Object.keys(fresh.summary.checks).length, 14);
assert.equal(fresh.summary.sourceRuns.length, 2); assert.deepEqual(fresh.summary.sourceRuns.map(item => item.mode), ['mirror', 'regression']);
assert.ok(fresh.summary.sourceRuns.every(item => item.reportGate === 'failed'));
assert.equal(fresh.summary.browserBindingPostCount, 3); assert.equal(fresh.summary.captureTargetRequests, 16);
assert.equal(fresh.summary.bindingAndReadTargetRequests, 0); assert.equal(fresh.summary.executionReady, false);
assert.equal(json(join(freshDirectory, 'target-requests.json')).length, 16);
assert.equal(json(join(freshDirectory, 'browser-requests.json')).filter(request => request.method === 'POST' && /\/browser-source-bindings$/.test(request.path)).length, 3);
assert.deepEqual(json(join(freshDirectory, 'browser-errors.json')).pageErrors, []);
assert.equal(fresh.summary.captures.length, 8); assert.equal(new Set(fresh.summary.captures).size, 8);
for (const file of fresh.summary.captures) {
  assert.ok(/^[a-z0-9-]+\.png$/.test(file)); const bytes = readFileSync(join(freshDirectory, file));
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a'); assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
}
for (const record of json(join(freshDirectory, 'source-file-digests.json'))) {
  assert.deepEqual(record.before, record.after);
  const expected = record.before.map(({ file, ...data }) => ({ path: file, ...data })).sort(compare);
  assert.deepEqual(walk(join(freshDirectory, 'runtime/acceptance', record.runId)), expected);
}
const runs = json(join(freshDirectory, 'runs.json')); assert.equal(runs.length, 2);
for (const run of runs) {
  const expected = run.originalFiles.map(({ file, ...data }) => ({ path: file, ...data })).sort(compare);
  assert.deepEqual(walk(join(freshDirectory, 'runtime/acceptance', run.runId)), expected);
}
const review = add('finish-review', join(RUNS, 'browser-bindings-console-review-20261017'), 'finish-review.json');
assert.equal(review.summary.disposition, 'ship'); assert.deepEqual(review.summary.materialFindings, []);
assert.equal(review.summary.captureValidity.status, 'pass'); assert.equal(review.summary.captureValidity.openedAndVisuallyInspected, 8);
assert.deepEqual(review.summary.captureValidity.invalidOrMissing, []); assert.equal(review.summary.captureValidity.evidenceRoot, fresh.directory);
assert.deepEqual(review.summary.captureValidity.captures.map(item => item.file).sort(), [...fresh.summary.captures].sort());
const documentation = add('documentation-review', join(RUNS, 'browser-bindings-console-documentation-20261017'), 'documentation-review.json');
assert.equal(documentation.summary.status, 'documentation-complete'); assert.equal(documentation.summary.evidence.evidenceRoot, fresh.directory);
for (const [path, digest] of Object.entries(documentation.summary.sourceSnapshotSha256)) assert.equal(sourceFor(path).sha256, digest.toLowerCase());
const detector = json(join(GATES, 'impeccable-detect.json'));
assert.equal(detector.length, 1); assert.equal(detector[0].antipattern, 'side-tab');
assert.ok(slash(detector[0].file).endsWith('/console/src/AcceptanceCatalog.vue'));
const parentCatalog = spawnSync('git', ['show', 'HEAD:console/src/AcceptanceCatalog.vue'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
assert.equal(parentCatalog.status, 0); assert.ok(parentCatalog.stdout.includes(detector[0].snippet));

const expectedStages = [
  ['01-lint', 'pnpm -C core lint'], ['02-console-build', 'pnpm -C console build'], ['03-core-test', 'pnpm -C core test'],
  ['04-core-smoke', 'pnpm -C core smoke'], ['05-catalog-browser', 'pnpm acceptance:catalog:smoke'],
  ['06-baseline-browser', 'pnpm acceptance:baseline:smoke'], ['07-managed-prepare', 'pnpm acceptance:managed:prepare:smoke'],
  ['08-execution-ui', 'pnpm acceptance:execution:ui:smoke'],
  ['09-cdp-clone', 'node core/scripts/smoke-console-cdp.mjs core/workspace/_runs/browser-bindings-console-gates-20261017/cdp-clone'],
];
const stages = [], missing = [];
for (const [name, command] of expectedStages) {
  const path = join(GATES, name + '.exitcode.json');
  if (!existsSync(path)) { missing.push(name + '.exitcode.json'); continue; }
  const record = json(path), invocation = json(join(GATES, name + '.command.json'));
  assert.equal(record.stage, name); assert.equal(record.command, command); assert.equal(invocation.command, command);
  assert.equal(record.exitCode, 0); assert.equal(record.signal, null); assert.ok(Date.parse(record.finishedAt) >= Date.parse(record.startedAt));
  assert.equal(invocation.startedAt, record.startedAt); assert.equal(resolve(invocation.cwd), ROOT);
  for (const suffix of ['.stdout.log', '.stderr.log']) assert.ok(existsSync(join(GATES, name + suffix)));
  if (name === '09-cdp-clone') assert.equal(invocation.environmentOverrides.HEIMDALL_E2E_CDP_SELF, '1');
  stages.push({ ...record, ...(name === '03-core-test' ? { testCounts: counts(readFileSync(join(GATES, name + '.stdout.log'), 'utf8')) } : {}) });
}
if (!existsSync(join(GATES, 'source-after.json'))) missing.push('source-after.json');
else assert.deepEqual(sources, json(join(GATES, 'source-after.json')));
const fullCore = stages.find(item => item.stage === '03-core-test')?.testCounts ?? null;
if (fullCore) { assert.equal(fullCore.fail, 0); assert.equal(fullCore.cancelled, 0); assert.equal(fullCore.todo, 0); }
if (missing.length) {
  console.log(JSON.stringify({ ready: false, mode, destinationExists: existsSync(DEST), missing,
    completedStages: stages.map(stage => stage.stage), fullCore, dtoCounts, http,
    knownGroups: groups.map(({ files, summary, ...group }) => ({ ...group, ...totals(files) })), sources: sources.length }, null, 2));
  process.exit(2);
}
assert.equal(stages.length, 9);
assert.deepEqual(readdirSync(GATES).filter(name => name.endsWith('.exitcode.json')).sort(), expectedStages.map(([stage]) => stage + '.exitcode.json'));
for (let i = 1; i < stages.length; i++) assert.ok(Date.parse(stages[i].startedAt) >= Date.parse(stages[i - 1].finishedAt), 'Gate stage overlap');

for (const [id, stageName, parent, summaryFile] of [
  ['catalog-console', '05-catalog-browser', 'acceptance-catalog-console', 'browser-checks.json'],
  ['baseline-console', '06-baseline-browser', 'acceptance-baseline-console', 'browser-checks.json'],
  ['managed-preparation', '07-managed-prepare', null, 'quality-gates.json'],
  ['execution-ui', '08-execution-ui', null, 'browser-checks.json'],
  ['cdp-clone', '09-cdp-clone', null, 'cdp-real-forge.json'],
]) {
  const stage = stages.find(item => item.stage === stageName), printed = finalObject(readFileSync(join(GATES, stageName + '.stdout.log'), 'utf8'));
  let directory, selection;
  if (id === 'cdp-clone') { directory = join(GATES, 'cdp-clone'); selection = { kind: 'explicit-command-output-directory' }; }
  else if (printed.outputDirectory) { directory = resolve(printed.outputDirectory); selection = { kind: 'stdout-outputDirectory' }; }
  else {
    const parentDirectory = join(RUNS, parent);
    const candidates = readdirSync(parentDirectory).map(name => join(parentDirectory, name)).filter(path => {
      const stat = lstatSync(path); return stat.isDirectory() && stat.birthtimeMs >= Date.parse(stage.startedAt) - 2000
        && stat.birthtimeMs <= Date.parse(stage.finishedAt) + 2000 && existsSync(join(path, summaryFile));
    });
    assert.equal(candidates.length, 1, id + ': require one newly born output directory in this exact stage interval');
    directory = candidates[0]; selection = { kind: 'unique-stage-birthtime-and-exact-stdout-summary', candidates: candidates.map(rel) };
  }
  assert.ok(inside(RUNS, directory));
  const group = add(id, directory, summaryFile, stageName); group.selection = selection;
  if (id === 'cdp-clone') {
    assert.deepEqual(printed, group.summary); assert.equal(group.summary.taskStatus, 'done'); assert.equal(group.summary.cloneStatus, 200);
    assert.deepEqual(group.summary.pageErrors, []); assert.ok(Date.parse(group.summary.ranAt) >= Date.parse(stage.startedAt));
    assert.ok(Date.parse(group.summary.ranAt) <= Date.parse(stage.finishedAt));
  } else {
    allChecks(group.summary);
    if (id === 'managed-preparation') { const { outputDirectory, ...rest } = printed; assert.deepEqual(rest, group.summary); }
    else if (id === 'execution-ui') assert.deepEqual(printed.checks, group.summary.checks);
    else assert.deepEqual(printed, group.summary);
  }
}

const gateFiles = walk(GATES).filter(file => !file.path.startsWith('cdp-clone/'));
const packerFiles = ['pack.mjs', 'README.draft.md', 'input-plan.json'].map(path => ({ path, ...info(join(HERE, path)) }));
const inputs = [...sources.map(file => ({ absolute: join(ROOT, file.path), bytes: file.bytes, sha256: file.sha256 })),
  ...groups.flatMap(group => group.files.map(file => ({ absolute: join(ROOT, group.directory, file.path), bytes: file.bytes, sha256: file.sha256 }))),
  ...gateFiles.map(file => ({ absolute: join(GATES, file.path), bytes: file.bytes, sha256: file.sha256 })),
  ...packerFiles.map(file => ({ absolute: join(HERE, file.path), bytes: file.bytes, sha256: file.sha256 }))];
const verifyInputs = () => { for (const file of inputs) assert.deepEqual(info(file.absolute), { bytes: file.bytes, sha256: file.sha256 }); };
verifyInputs();
if (mode === '--dry-run') {
  console.log(JSON.stringify({ ready: true, mode, destinationExists: existsSync(DEST), fullCore, dtoCounts, http,
    groups: groups.map(({ files, summary, ...group }) => ({ ...group, ...totals(files) })), sources: sources.length,
    inputs: { fileOccurrences: inputs.length, uniqueFiles: new Set(inputs.map(file => file.absolute)).size, bytes: inputs.reduce((sum, file) => sum + file.bytes, 0) },
    boundary: 'No files or directories were written by this dry-run; publishing still requires an explicit --publish invocation.' }, null, 2));
  process.exit(0);
}

assert.equal(existsSync(DEST), false, 'Existing package refused; preserve any incomplete attempt');
const verificationDirectory = mkdtempSync(join(HERE, 'verification-')); mkdirSync(DEST);
function write(path, bytes) {
  const target = join(DEST, path); assert.ok(inside(DEST, target)); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx' }); assert.ok(readFileSync(target).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
  return { path, ...info(target) };
}
const writeJson = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
write('.gitattributes', '* -text\nREADME.md text eol=lf\n.gitattributes text eol=lf\nsource/** whitespace=cr-at-eol\n');
const copies = [], archives = [];
function copy(source, target, compress = false) {
  const original = readFileSync(source), bytes = compress ? gzipSync(original) : original;
  if (compress) assert.ok(gunzipSync(bytes).equals(original));
  copies.push({ source: rel(source), originalBytes: original.length, originalSha256: sha(original),
    gzipRoundTrip: compress, encoding: compress ? 'gzip' : 'identity', ...write(target, bytes) });
}
for (const file of sources) copy(join(ROOT, file.path), 'source/' + file.path);
for (const file of packerFiles) copy(join(HERE, file.path), 'implementation/' + file.path);
for (const file of gateFiles) copy(join(GATES, file.path), 'gates/' + file.path + (file.path.endsWith('.log') ? '.gz' : ''), file.path.endsWith('.log'));
for (const group of groups) {
  const source = join(ROOT, group.directory), filename = 'originals/' + group.id + '.tar.gz', target = join(DEST, filename);
  mkdirSync(dirname(target), { recursive: true }); const descriptor = openSync(target, 'wx'); let packed;
  try { packed = spawnSync('tar', ['-czf', '-', '-C', source, '.'], { windowsHide: true, stdio: ['ignore', descriptor, 'pipe'] }); }
  finally { closeSync(descriptor); }
  assert.equal(packed.error, undefined); assert.equal(packed.status, 0, String(packed.stderr));
  const restored = join(verificationDirectory, group.id); mkdirSync(restored);
  const unpacked = spawnSync('tar', ['-xzf', target, '-C', restored], { encoding: 'utf8', windowsHide: true });
  assert.equal(unpacked.error, undefined); assert.equal(unpacked.status, 0, unpacked.stderr);
  assert.deepEqual(walk(restored), group.files, 'Archive entry set, lengths or SHA changed: ' + group.id);
  for (const file of group.files) assert.ok(readFileSync(join(source, file.path)).equals(readFileSync(join(restored, file.path))));
  archives.push({ id: group.id, source: group.directory, archive: { path: filename, ...info(target) },
    fileIndex: writeJson('originals/' + group.id + '.files.json', group.files), ...totals(group.files),
    packExitCode: packed.status, unpackExitCode: unpacked.status, completeFileSetVerified: true, byteRoundTripPassed: true });
}
const browse = {
  'fresh-ui': ['browser-checks.json', 'layouts.json', 'browser-errors.json', 'browser-requests.json', 'target-requests.json',
    'source-file-digests.json', 'blob-lifecycle.json', 'baseline-detail.json', 'changed-source-detail.json', ...fresh.summary.captures],
  'finish-review': ['finish-review.json', 'finish-review.md'], 'documentation-review': ['documentation-review.json', 'documentation-review.md'],
  'dto-focused': ['summary.json'], 'catalog-console': ['browser-checks.json'], 'baseline-console': ['browser-checks.json'],
  'managed-preparation': ['quality-gates.json'], 'execution-ui': ['browser-checks.json'],
  'cdp-clone': ['cdp-real-forge.json', 'cdp-console-forge.png', 'cdp-clone-artifact.png'],
};
for (const group of groups) for (const file of browse[group.id] ?? []) {
  assert.ok(group.files.some(item => item.path === file), 'Missing required browse material');
  copy(join(ROOT, group.directory, file), 'browse/' + group.id + '/' + file);
}
verifyInputs();
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }); assert.equal(head.status, 0);
const uiHelperEvidence = { reportedFocusedTests: 21, rawFocusedLogArchived: false,
  reason: 'Initial helper/build commands were only visible in tool output; no wx command log exists and none is reconstructed.',
  frozenTestSourceCoveredByFinalCore: 'core/test/console-acceptance-browser-bindings.test.mjs' };
writeJson('provenance.json', { schemaVersion: 1, capturedAt: new Date().toISOString(), parentHead: head.stdout.trim(),
  sourceState: 'Working-tree implementation frozen before nine serial gates; exact source bytes are independent of the parent commit.',
  sources, stages, groups, archives, copies, verificationDirectory: rel(verificationDirectory), uiHelperEvidence,
  detector: { suppliedFindings: detector.length, existingDeclarationConfirmedInParentHead: true, findings: detector },
  boundaries: ['C provides authenticated Browser source organization and display DTO/UI only; no Browser candidate, approval, selection or executor.',
    'Fresh source capture is a controlled local fixture, not arbitrary-site acceptance or deployment immutability.',
    'Raw source records intentionally retain controlled query sentinels; HTTP DTO displays hide query text. Old URL surfaces remain separate.',
    'Three HTTP rounds are kept. Earlier failures were test expectation corrections; parents are included in TAP counts.',
    'Final full Core is counted once; DTO/HTTP/UI/smoke regressions overlap it and are not added.',
    'The initial UI helper/build command has no archived wx log; final full Core includes the frozen helper test file.',
    'No remote CI, including the separately archived B CI, is included in this local package.'] });
writeJson('summary.json', { schemaVersion: 1, status: 'passed', fullCore, dtoFocused: dtoCounts, httpRounds: http,
  finalHttpComposition: { total: 34, browserHttp: 28, previousCatalogApiRegression: 6 }, uiHelperEvidence,
  authoritativeFreshSmoke: fresh.summary, finishReview: { disposition: 'ship', capturesReviewed: 8, materialFindings: 0 },
  documentationReview: { status: documentation.summary.status }, stages,
  archiveRoundTrips: archives.map(({ archive, fileIndex, ...item }) => item),
  countPolicy: 'Full Core once; focused suites, failed attempts, 14 fresh checks and later smoke regressions remain separate and overlap.' });
const lead = `# Browser 来源归属控制台：片 C 本机证据\n\n` +
  `完整 Core：**${fullCore.tests} total / ${fullCore.pass} pass / ${fullCore.fail} fail / ${fullCore.skipped} skip**，${fullCore.duration_ms} ms。九阶段串行命令均 exit 0，source-before/source-after 与当前 12 份冻结源码逐项一致。\n\n` +
  `专项 DTO **${dtoCounts.tests}/${dtoCounts.pass}**；最终 HTTP **34/34**（新 HTTP 28 + 原 catalog API 6）；fresh UI **14/14**，2 个 fresh source runs、3 次归属 POST、16 次 capture 目标请求，归属与读取新增目标请求 **0**。独立 finish review 检查 8 张截图，结论 ship、0 material findings；documenter 已完成只读文档核对。\n\n`;
write('README.md', lead + readFileSync(join(HERE, 'README.draft.md'), 'utf8'));
verifyInputs();
const inventory = walk(DEST);
const inventoryFile = writeJson('package-files.json', { schemaVersion: 1, excludesSelf: true, excludesCompletionReceipt: true, ...totals(inventory), files: inventory });
for (const file of inventory) assert.deepEqual(info(join(DEST, file.path)), { bytes: file.bytes, sha256: file.sha256 });
verifyInputs();
writeJson('COMPLETED.json', { schemaVersion: 1, status: 'complete', completedAt: new Date().toISOString(), inventory: inventoryFile,
  inventoryFileCount: inventory.length, archiveCount: archives.length, allByteRoundTripsPassed: true, completeArchiveFileSetsVerified: true,
  sourcesUnchanged: true, allOriginalInputsUnchanged: true, serialGatesPassed: 9 });
console.log(JSON.stringify({ status: 'published', directory: rel(DEST), verificationDirectory: rel(verificationDirectory),
  ...totals(walk(DEST)), archives: archives.length, copies: copies.length, inventory: inventoryFile }, null, 2));
