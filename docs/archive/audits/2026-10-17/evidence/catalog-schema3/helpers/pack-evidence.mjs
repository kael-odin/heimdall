import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

// Ignored packaging helper. It never runs a gate, repairs a log, or overwrites a publication.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const RUNS = join(ROOT, 'core/workspace/_runs');
const DEST = join(ROOT, 'docs/audits/2026-10-17/evidence/catalog-schema3');
const REQUIRED = [
  '01-catalog-compatibility', '02-migration-browser', '03-final-lint', '04-console-build',
  '05a-baseline-integrity', '05b-core-test-final', '06-core-smoke', '07-catalog-browser',
  '08-baseline-browser', '09-managed-prepare', '10-execution-ui', '11-cdp-clone',
];
const EXPECTED_COMMANDS = {
  '03-final-lint': 'pnpm -C core lint', '04-console-build': 'pnpm -C console build',
  '05-core-test': 'pnpm -C core test', '05b-core-test-final': 'pnpm -C core test',
  '06-core-smoke': 'pnpm -C core smoke', '07-catalog-browser': 'pnpm acceptance:catalog:smoke',
  '08-baseline-browser': 'pnpm acceptance:baseline:smoke',
  '09-managed-prepare': 'pnpm acceptance:managed:prepare:smoke',
  '10-execution-ui': 'pnpm acceptance:execution:ui:smoke',
  '11-cdp-clone': 'node core/scripts/smoke-console-cdp.mjs core/workspace/_runs/schema3-gates-20261017/cdp-clone',
};
const MIGRATION_ATTEMPTS = [
  'schema3-migration-tests-cc1195b7-dfb5-4525-9a3f-3220454b8eb6',
  'schema3-migration-tests-c472a09c-f277-4df1-87a4-297b50d72626',
  'schema3-migration-tests-e7dcd3f6-d02b-4260-858b-3f5212360a07',
];
const FROZEN_IMPLEMENTATION = {
  'core/src/acceptance/catalog-schema.mjs': '780e53914abbc137b5969b9e073b8f23f01054f5b3552c4c8146e35b54603242',
  'core/src/acceptance/catalog.mjs': '84135be15828241ddeed125818681b80f4c1909363d3ffb6932e7ae356debf2a',
  'core/scripts/smoke-acceptance-catalog-migration.mjs': '8b23d616cd1d18b943a750002ea44bcd3a7ea1dc1d9a45da81703d8ae9c86a6c',
};
const SOURCE_FILES = [...new Set([
  ...Object.keys(FROZEN_IMPLEMENTATION),
  'core/test/acceptance-catalog-migration.test.mjs', 'core/test/acceptance-catalog-schema.test.mjs',
  'core/test/acceptance-catalog.test.mjs', 'core/test/acceptance-catalog-schema-v3.test.mjs',
  'core/test/acceptance-catalog-schema3-migration.test.mjs', 'core/test/acceptance-baseline-integrity.test.mjs',
  'core/test/acceptance-baseline-catalog.test.mjs', 'core/test/acceptance-managed-catalog.test.mjs',
  'core/test/acceptance-catalog-api.test.mjs',
  ...readdirSync(join(ROOT, 'core/src/acceptance')).filter(name => name.endsWith('.mjs')).map(name => 'core/src/acceptance/' + name),
  ...readdirSync(join(ROOT, 'console/src')).filter(name => /^(?:Acceptance|acceptance[-.])/.test(name)).map(name => 'console/src/' + name),
  'core/scripts/smoke-acceptance-catalog-console.mjs', 'core/scripts/smoke-acceptance-baseline-console.mjs',
  'core/scripts/smoke-acceptance-managed-preparation.mjs', 'core/scripts/smoke-acceptance-execution-ui.mjs',
  'core/scripts/test-core.mjs', 'core/scripts/smoke-forge.mjs', 'core/scripts/smoke-console-cdp.mjs',
  'core/package.json', 'console/package.json', 'package.json',
  'core/pnpm-lock.yaml', 'console/pnpm-lock.yaml', 'pnpm-lock.yaml',
])].sort();

const slash = value => value.split(sep).join('/');
const rel = value => slash(relative(ROOT, value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const bytesInfo = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const record = path => ({ path: rel(path), ...bytesInfo(path) });
function pngDimensions(path) {
  const data = readFileSync(path);
  assert.ok(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG: ' + path);
  assert.equal(data.toString('ascii', 12, 16), 'IHDR');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
const inside = (base, path) => { const p = relative(base, path); assert.ok(p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p), `Outside ${base}: ${path}`); return path; };
const atRoot = path => inside(ROOT, resolve(ROOT, path));
function walk(base) {
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), `Symlink refused: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else { assert.ok(stat.isFile(), `Not a regular file: ${path}`); entries.push({ path: slash(relative(base, path)), ...bytesInfo(path) }); }
  }
  visit(base); return entries;
}
function totals(files) { return { fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }; }
function testTotals(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const result = {};
  for (const name of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    const matches = [...clean.matchAll(new RegExp('^(?:ℹ|#)\\s+' + name + '\\s+([0-9.]+)\\s*$', 'gm'))];
    if (matches.length) result[name] = Number(matches.at(-1)[1]);
  }
  return Object.hasOwn(result, 'tests') ? result : null;
}
function jsonObjects(text) {
  const values = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' || (i > 0 && text.slice(text.lastIndexOf('\n', i) + 1, i).trim() !== '')) continue;
    let depth = 0, quoted = false, escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { try { values.push(JSON.parse(text.slice(i, j + 1))); } catch {} i = j; break; }
    }
  }
  return values;
}
function printedSummary(stage, predicate = value => value.status === 'passed' || value.passed === true) {
  const matches = jsonObjects(readFileSync(join(HERE, stage + '.stdout.log'), 'utf8')).filter(predicate);
  assert.equal(matches.length, 1, `Expected exactly one stdout summary for ${stage}`); return matches[0];
}
function validWindow(item) {
  const start = Date.parse(item.startedAt), end = Date.parse(item.finishedAt ?? item.endedAt);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'Invalid stage time window');
  return [start, end];
}
function inWindow(directory, item) {
  const [start, end] = validWindow(item), created = statSync(directory).birthtimeMs;
  assert.ok(created >= start && created <= end, `Directory creation outside stage window: ${rel(directory)}`);
}
function datedOutput(base, item) {
  const [start, end] = validWindow(item);
  const matches = readdirSync(base, { withFileTypes: true }).filter(entry => {
    if (!entry.isDirectory()) return false;
    const match = entry.name.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)-[0-9a-f]{8}$/);
    if (!match) return false;
    const time = Date.parse(`${match[1]}:${match[2]}:${match[3]}`);
    return time >= start && time <= end;
  });
  assert.equal(matches.length, 1, `Expected one output directory in stage window: ${rel(base)}`);
  const out = join(base, matches[0].name); inWindow(out, item); return out;
}
function allChecks(summary, label) {
  assert.ok(summary.status === 'passed' || summary.passed === true, `${label} not passed`);
  if (summary.checks && !Object.hasOwn(summary.checks, 'total')) {
    assert.ok(Object.values(summary.checks).every(value => value === true), `${label} contains a non-true check`);
    if (summary.checkCount !== undefined) assert.equal(summary.checkCount, Object.keys(summary.checks).length);
  } else if (summary.checks) assert.equal(summary.checks.total, summary.checks.passed);
  for (const name of ['errors', 'pageErrors']) if (summary[name]) assert.deepEqual(summary[name], [], `${label} ${name}`);
}
function healthyTests(counts, label) {
  assert.ok(counts && counts.tests > 0, `${label} has no complete test summary`);
  assert.equal(counts.fail, 0, `${label} failed`); assert.equal(counts.cancelled, 0, `${label} cancelled`);
  assert.equal(counts.todo, 0, `${label} todo`);
  assert.equal(counts.tests, counts.pass + counts.skipped, `${label} counts disagree`);
}

function preflight() {
  const issues = [], stages = [], outputs = [], sources = [], fixtureSources = [];
  const attempt = (label, work) => { try { return work(); } catch (error) { issues.push({ label, message: error.message }); return null; } };
  const stageMap = new Map();
  for (const name of readdirSync(HERE).filter(name => name.endsWith('.exitcode.json')).sort()) attempt(name, () => {
    const item = json(join(HERE, name)), stage = name.slice(0, -'.exitcode.json'.length);
    assert.ok([...REQUIRED, '05-core-test'].includes(stage), `Unreviewed stage attempt: ${stage}; update the explicit final-attempt mapping`);
    assert.equal(item.stage, stage); validWindow(item);
    for (const kind of ['stdout', 'stderr']) assert.equal(resolve(item[kind + 'Path']), join(HERE, stage + '.' + kind + '.log'));
    if (EXPECTED_COMMANDS[stage]) assert.equal(item.command, EXPECTED_COMMANDS[stage]);
    assert.ok(item.signal === null && !item.error, `${stage} has signal or spawn error`);
    const stdout = join(HERE, stage + '.stdout.log'), stderr = join(HERE, stage + '.stderr.log');
    const info = { ...item, stdoutPath: rel(stdout), stderrPath: rel(stderr), exitRecordPath: rel(join(HERE, name)),
      stdout: record(stdout), stderr: record(stderr), exitRecord: record(join(HERE, name)),
      testTotals: testTotals(readFileSync(stdout, 'utf8')) };
    stages.push(info); stageMap.set(stage, info);
  });
  for (const stage of REQUIRED) attempt(stage, () => {
    const item = stageMap.get(stage); assert.ok(item, `Missing completed stage: ${stage}`); assert.equal(item.exitCode, 0, `${stage} exit code`);
  });
  for (const stage of new Set(readdirSync(HERE).filter(name => /\.(?:stdout|stderr)\.log$/.test(name)).map(name => name.replace(/\.(?:stdout|stderr)\.log$/, '')))) {
    if (!stageMap.has(stage)) issues.push({ label: stage, message: 'Log exists without a completed exit record' });
  }
  attempt('initial-core-history', () => { const item = stageMap.get('05-core-test'); assert.ok(item); assert.equal(item.exitCode, 1); assert.equal(item.testTotals?.fail, 1); });
  for (const stage of ['01-catalog-compatibility', '05a-baseline-integrity', '05b-core-test-final']) if (stageMap.has(stage)) {
    attempt(stage + '-counts', () => healthyTests(stageMap.get(stage).testTotals, stage));
  }
  for (const [path, expected] of Object.entries(FROZEN_IMPLEMENTATION)) attempt('frozen:' + path, () => assert.equal(bytesInfo(atRoot(path)).sha256, expected));
  for (const path of SOURCE_FILES) attempt('source:' + path, () => sources.push({ path, ...bytesInfo(atRoot(path)) }));
  const purePath = join(RUNS, 'catalog-schema3-pure-20261017/pure-tests.log');
  const pure = attempt('pure-schema', () => {
    const counts = testTotals(readFileSync(purePath, 'utf8')); healthyTests(counts, 'pure-schema'); assert.equal(counts.tests, 23);
    return { log: record(purePath), testTotals: counts, exitCode: null, exitRecordAvailable: false,
      scope: 'Completed stdout summary only; no standalone exit-code record was captured.' };
  });
  const migrations = [];
  const unknownAttempts = readdirSync(RUNS).filter(name => name.startsWith('schema3-migration-tests-') && !MIGRATION_ATTEMPTS.includes(name));
  if (unknownAttempts.length) issues.push({ label: 'migration-attempts', message: 'Unreviewed attempts exist: ' + unknownAttempts.join(', ') });
  for (const name of MIGRATION_ATTEMPTS) attempt(name, () => {
    const base = join(RUNS, name), item = json(join(base, 'exitcode.json'));
    validWindow(item); assert.equal(item.code, 0); assert.equal(item.signal, null); assert.equal(item.error, null);
    const counts = testTotals(readFileSync(join(base, 'stdout.log'), 'utf8')); healthyTests(counts, name);
    const files = walk(base); for (const required of ['run.mjs', 'stdout.log', 'stderr.log', 'exitcode.json']) assert.ok(files.some(file => file.path === required));
    migrations.push({ directory: rel(base), exitRecord: item, testTotals: counts, files });
  });
  migrations.sort((a, b) => Date.parse(a.exitRecord.endedAt) - Date.parse(b.exitRecord.endedAt));
  if (migrations.length) attempt('final-migration-counts', () => assert.equal(migrations.at(-1).testTotals.tests, 97));
  function output(id, stage, locate, summaryName, compare) {
    if (!stageMap.has(stage) || stageMap.get(stage).exitCode !== 0) return;
    attempt(id, () => {
      const stdout = printedSummary(stage, id === 'cdp-clone' ? value => value.cloneStatus === 200 : undefined);
      const directory = locate(stageMap.get(stage), stdout), summary = json(join(directory, summaryName));
      if (id === 'cdp-clone') { assert.equal(summary.cloneStatus, 200); assert.deepEqual(summary.pageErrors, []); }
      else allChecks(summary, id);
      (compare ?? ((a, b) => assert.deepEqual(a, b, `${id} stdout/file summary mismatch`)))(stdout, summary);
      const files = walk(directory); assert.ok(files.length > 0);
      outputs.push({ id, stage, directory: rel(directory), summaryName, summary, files, ...totals(files) });
    });
  }
  output('migration', '02-migration-browser', item => datedOutput(join(RUNS, 'acceptance-catalog-migration'), item), 'migration-checks.json');
  output('catalog-console', '07-catalog-browser', item => datedOutput(join(RUNS, 'acceptance-catalog-console'), item), 'browser-checks.json');
  output('baseline-console', '08-baseline-browser', item => datedOutput(join(RUNS, 'acceptance-baseline-console'), item), 'browser-checks.json');
  const explicitOutput = (prefix, parent) => (item, stdout) => {
    assert.ok(typeof stdout.outputDirectory === 'string' && isAbsolute(stdout.outputDirectory));
    const out = inside(parent, resolve(stdout.outputDirectory));
    assert.ok(relative(parent, out).startsWith(prefix)); inWindow(out, item); return out;
  };
  output('managed-preparation', '09-managed-prepare', explicitOutput('', join(RUNS, 'acceptance-managed-preparation')), 'quality-gates.json', (stdout, summary) => {
    const { outputDirectory, ...printed } = stdout; assert.deepEqual(printed, summary);
    assert.equal(summary.browserStarted, false); assert.equal(summary.engineStarted, false);
    assert.equal(summary.executionTested, false); assert.equal(summary.runCreated, false);
  });
  output('execution-ui', '10-execution-ui', explicitOutput('execution-ui-', RUNS), 'browser-checks.json', (stdout, summary) => {
    assert.deepEqual({ status: stdout.status, checks: stdout.checks, checkCount: stdout.checkCount },
      { status: summary.status, checks: summary.checks, checkCount: Object.keys(summary.checks).length });
    assert.deepEqual(json(join(stdout.outputDirectory, 'layouts.json')), summary.layouts);
  });
  output('cdp-clone', '11-cdp-clone', item => { const out = join(HERE, 'cdp-clone'); inWindow(out, item); return out; }, 'cdp-real-forge.json');
  const migration = outputs.find(item => item.id === 'migration');
  if (migration) attempt('migration-sources', () => {
    assert.equal(migration.files.length, 34); assert.equal(migration.bytes, 1369488);
    assert.equal(migration.summary.checkCount, 15); assert.equal(migration.summary.layouts.length, 7);
    assert.equal(migration.summary.targetRequests, 0); assert.equal(migration.summary.apiCaseCount, 16);
    const base = atRoot(migration.directory), provenance = json(join(base, 'fixture-provenance.json'));
    const b1Digests = json(join(base, 'run-file-digests.json'));
    assert.deepEqual(b1Digests.source, provenance.runFileDigests); assert.deepEqual(b1Digests.mainCopyAfter, b1Digests.source);
    const native = json(join(base, 'native-v2-spec-history.json')), nativeDigests = json(join(base, 'native-v2-spec-run-digests.json'));
    assert.deepEqual(nativeDigests.source, nativeDigests.copied);
    for (const [id, directory, catalogSha256, expected, count] of [
      ['b1-spec', provenance.fixture, provenance.catalogSha256, provenance.runFileDigests, 18],
      ['native-v2-spec', native.fixture, native.originalSha256, nativeDigests.source, 14],
    ]) {
      const root = atRoot(directory), catalog = join(root, 'catalog-storage.json'), runs = join(root, 'run-evidence');
      assert.equal(bytesInfo(catalog).sha256, catalogSha256); const runFiles = walk(runs); assert.equal(runFiles.length, count);
      assert.deepEqual(Object.fromEntries(runFiles.map(file => [file.path, file.sha256])), expected);
      for (const file of runFiles.filter(file => file.path.endsWith('/manifest.json'))) assert.equal(json(join(runs, file.path)).mode, 'spec');
      const files = [{ path: 'catalog-storage.json', ...bytesInfo(catalog) }, ...runFiles.map(file => ({ ...file, path: 'run-evidence/' + file.path }))];
      fixtureSources.push({ id, directory, files, ...totals(files), role: 'Committed original Spec source; not a surviving migration temporary copy.' });
    }
  });
  const layouts = outputs.flatMap(item => (item.summary.layouts ?? []).map(layout => ({ evidence: item.id, ...layout })));
  const screenshots = outputs.flatMap(item => item.files.filter(file => file.path.endsWith('.png')).map(file =>
    ({ evidence: item.id, ...file, ...pngDimensions(join(atRoot(item.directory), file.path)) })));
  if (migration) attempt('migration-png-sizes', () => {
    const pngs = screenshots.filter(item => item.evidence === 'migration'); assert.equal(pngs.length, 12);
    assert.equal(pngs.filter(item => item.width === 1440 && item.height === 1000).length, 5);
    assert.equal(pngs.filter(item => item.width === 390 && item.height === 844).length, 7);
  });
  return { ready: issues.length === 0, issues, stages, pure, migrations, outputs, fixtureSources, sources, layouts, screenshots };
}

function publish(plan) {
  assert.equal(plan.ready, true, 'Preflight must pass before any publication writes');
  assert.ok(!existsSync(DEST), 'Publication already exists; new-only publication refused');
  // Recheck every captured byte before creating the destination, including historical failed logs.
  const checks = [
    ...plan.sources.map(file => ({ absolute: atRoot(file.path), ...file })),
    ...plan.stages.flatMap(stage => [stage.stdout, stage.stderr, stage.exitRecord].map(file => ({ absolute: atRoot(file.path), ...file }))),
    { absolute: atRoot(plan.pure.log.path), ...plan.pure.log },
    ...plan.outputs.flatMap(item => item.files.map(file => ({ absolute: join(atRoot(item.directory), file.path), ...file }))),
    ...plan.fixtureSources.flatMap(item => item.files.map(file => ({ absolute: join(atRoot(item.directory), file.path), ...file }))),
    ...plan.migrations.flatMap(item => item.files.map(file => ({ absolute: join(atRoot(item.directory), file.path), ...file }))),
  ];
  for (const file of checks) assert.deepEqual(bytesInfo(file.absolute), { bytes: file.bytes, sha256: file.sha256 }, 'Input changed: ' + file.path);
  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true }); assert.equal(tar.status, 0, 'tar unavailable');
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }); assert.equal(gitHead.status, 0);
  const startedAt = new Date().toISOString();
  const verificationRoot = mkdtempSync(join(HERE, 'pack-verification-'));
  mkdirSync(DEST); // Must fail if another process created the destination after the existence check.
  function write(path, bytes) {
    const target = inside(DEST, join(DEST, path)); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' }); assert.ok(readFileSync(target).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
    return { path: slash(path), ...bytesInfo(target) };
  }
  const writeJson = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
  const copies = [], archives = [];
  const copy = (source, target) => { const item = write(target, readFileSync(source)); copies.push({ source: rel(source), ...item }); return item; };
  function gzip(source, target) {
    const bytes = readFileSync(source), compressed = gzipSync(bytes, { level: 9 }); assert.ok(gunzipSync(compressed).equals(bytes));
    const item = write(target, compressed); copies.push({ source: rel(source), originalBytes: bytes.length, originalSha256: sha(bytes), gzipRoundTrip: true, ...item });
  }
  write('.gitattributes', '* -text\nREADME.md text eol=lf\n.gitattributes text eol=lf\n*.json whitespace=cr-at-eol\n');
  for (const stage of plan.stages) {
    for (const kind of ['stdout', 'stderr']) gzip(atRoot(stage[kind].path), 'gates/' + stage.stage + '.' + kind + '.log.gz');
    copy(atRoot(stage.exitRecordPath), 'gates/' + stage.stage + '.exitcode.json');
  }
  for (const name of ['run-stage.mjs', 'run-final-gates.mjs', 'resume-final-gates.mjs', 'pack-evidence.mjs']) copy(join(HERE, name), 'helpers/' + name);
  gzip(atRoot(plan.pure.log.path), 'specialized/pure-schema/pure-tests.log.gz');
  for (const item of plan.migrations) for (const file of item.files) {
    const source = join(atRoot(item.directory), file.path), target = 'specialized/' + item.directory.split('/').at(-1) + '/' + file.path;
    if (file.path.endsWith('.log')) gzip(source, target + '.gz'); else copy(source, target);
  }
  for (const file of plan.sources) copy(atRoot(file.path), 'source/' + file.path);
  // Full live output trees, not a fixed PNG/JSON subset. Each archive is extracted into a fresh ignored directory.
  function archive(item, source, snapshotRoot) {
    const filename = 'originals/' + item.id + '.tar.gz', target = join(DEST, filename); mkdirSync(dirname(target), { recursive: true });
    const fd = openSync(target, 'wx'); let result;
    try { result = spawnSync('tar', ['-czf', '-', '-C', source, '.'], { windowsHide: true, stdio: ['ignore', fd, 'pipe'] }); }
    finally { closeSync(fd); }
    assert.equal(result.status, 0, String(result.stderr ?? result.error ?? 'tar archive failed'));
    const unpacked = join(verificationRoot, item.id); mkdirSync(unpacked);
    const unpack = spawnSync('tar', ['-xzf', target, '-C', unpacked], { windowsHide: true, encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr || String(unpack.error ?? 'tar extract failed'));
    const restored = walk(unpacked); assert.deepEqual(restored, item.files, `${item.id} archive file/byte/hash mismatch`);
    for (const file of item.files) assert.ok(readFileSync(join(source, file.path)).equals(readFileSync(join(unpacked, file.path))), `${item.id}/${file.path} restored byte mismatch`);
    archives.push({ id: item.id, source: rel(source), fileIndex: writeJson('originals/' + item.id + '.files.json', item.files),
      archive: { path: filename, ...bytesInfo(target) }, ...totals(item.files), roundTripFileSetAndBytes: true });
    // Browser-friendly raw summaries, provenance, layouts, and every screenshot. Full remainder lives in tar.gz.
    if (snapshotRoot) for (const file of item.files.filter(file => !file.path.includes('/') && /\.(?:json|png)$/.test(file.path))) copy(join(source, file.path), snapshotRoot + '/' + file.path);
  }
  for (const item of plan.outputs) archive(item, atRoot(item.directory), 'browse/' + item.id);
  // Fixture bundles intentionally contain only their original catalog and full run-evidence tree.
  for (const item of plan.fixtureSources) {
    const staging = join(verificationRoot, 'fixture-source-' + item.id); mkdirSync(staging);
    for (const file of item.files) { const target = join(staging, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(join(atRoot(item.directory), file.path)), { flag: 'wx' }); }
    archive(item, staging, null);
    archives.at(-1).source = item.directory;
  }
  writeJson('source-files.json', { schemaVersion: 1, capturedAt: startedAt, gitHead: gitHead.stdout.trim(),
    state: 'Working-tree bytes after the explicit schema3 assertion correction; not a claim of a committed final revision.',
    frozenImplementation: FROZEN_IMPLEMENTATION, files: plan.sources, documentsExcluded: true });
  writeJson('layout.json', { schemaVersion: 1, derivedFromOriginalSummaries: true, layouts: plan.layouts, screenshots: plan.screenshots,
    migrationLayoutRows: 7, migrationPngFiles: 12,
    scope: 'Layout rows and PNG counts are separate. Managed preparation has no browser, engine, PNG, or layout evidence.' });
  writeJson('provenance.json', { schemaVersion: 1, packagedAt: startedAt, repositoryHead: gitHead.stdout.trim(),
    stages: plan.stages, sourceFixtures: plan.fixtureSources,
    outputs: plan.outputs.map(({ summary, ...item }) => item), archives, copies,
    boundaries: [
      'Migration OUT has 34 original files but no surviving temporary copied run-evidence trees. Digest equality was recorded by smoke before cleanup.',
      'The two self-contained committed source fixture bundles are Spec evidence. They do not establish Browser worker execution.',
      'The native V2 pre-migration catalog is the separately bundled committed source catalog; it was not preserved inside migration OUT.',
      'No prior Browser reader CI run or log is included in this schema3 package.',
    ] });
  // A failed final source recheck must not leave success-labelled summary/README files.
  for (const file of checks) assert.deepEqual(bytesInfo(file.absolute), { bytes: file.bytes, sha256: file.sha256 }, 'Input changed during pack: ' + file.path);
  writeJson('summary.json', { schemaVersion: 1, status: 'passed', packagedAt: startedAt, packageCompletionReceipt: 'COMPLETED.json',
    finalStageNames: REQUIRED, coreCountSource: '05b-core-test-final',
    finalCore: plan.stages.find(item => item.stage === '05b-core-test-final').testTotals,
    historicalCore: { stage: '05-core-test', ...plan.stages.find(item => item.stage === '05-core-test').testTotals, exitCode: 1,
      reason: 'Legacy migrated-B1 revision assertion expected +1; schema3 requires 1→2→3 (+2). Failure retained, then contract assertion corrected.' },
    focusedIntegrity: plan.stages.find(item => item.stage === '05a-baseline-integrity').testTotals,
    compatibility: plan.stages.find(item => item.stage === '01-catalog-compatibility').testTotals,
    pureSchema: plan.pure, migrationTestAttempts: plan.migrations.map(({ files, ...item }) => item),
    finalMigrationTestSource: plan.migrations.at(-1).directory,
    outputs: plan.outputs.map(item => ({ id: item.id, stage: item.stage, source: item.directory, ...totals(item.files), summary: item.summary })),
    archiveRoundTrips: archives.map(item => ({ id: item.id, fileCount: item.fileCount, bytes: item.bytes, passed: item.roundTripFileSetAndBytes })),
    countPolicy: 'Final Core is one complete final run. Historical failures, focused runs, pure schema, migration attempts, Docker, and earlier reader CI are not added to Core.' });
  const draft = readFileSync(join(HERE, 'README.draft.md'), 'utf8');
  write('README.md', draft.replace('<!-- PACKAGING_STATUS -->', `归档生成于 ${startedAt}。全部必需阶段完成且退出码为 0；历史失败和专项日志按下文保留。`));
  const inventory = walk(DEST);
  const inventoryFile = writeJson('package-files.json', { schemaVersion: 1, excludesSelf: true, excludesCompletionReceipt: true, ...totals(inventory), files: inventory });
  for (const file of inventory) assert.deepEqual(bytesInfo(join(DEST, file.path)), { bytes: file.bytes, sha256: file.sha256 }, 'Published byte changed: ' + file.path);
  // Last exclusive write: without this receipt the directory is an incomplete retained attempt.
  writeJson('COMPLETED.json', { schemaVersion: 1, status: 'complete', completedAt: new Date().toISOString(),
    inventory: inventoryFile, inventoryFileCount: inventory.length, archiveCount: archives.length,
    archiveRoundTripsPassed: archives.every(item => item.roundTripFileSetAndBytes === true),
    sourceRecheckPassed: true, inventoryBytesRechecked: true });
  const finalFiles = walk(DEST);
  return { status: 'published', directory: rel(DEST), verificationDirectory: rel(verificationRoot), ...totals(finalFiles),
    archiveCount: archives.length, copiedFiles: copies.length, packageInventory: bytesInfo(join(DEST, 'package-files.json')) };
}

const mode = process.argv[2] ?? '--inspect';
assert.ok(['--inspect', '--publish'].includes(mode) && process.argv.length <= 3, 'Usage: node pack-evidence.mjs [--inspect|--publish]');
const plan = preflight();
if (mode === '--inspect') {
  console.log(JSON.stringify({ mode, ready: plan.ready, destinationExists: existsSync(DEST), issues: plan.issues,
    stages: plan.stages.map(item => ({ stage: item.stage, exitCode: item.exitCode, testTotals: item.testTotals })),
    pureSchema: plan.pure, migrations: plan.migrations.map(({ files, ...item }) => item),
    outputs: plan.outputs.map(item => ({ id: item.id, directory: item.directory, ...totals(item.files) })),
    fixtureSources: plan.fixtureSources.map(({ files, ...item }) => item), sourceFiles: plan.sources.length,
    layoutRows: plan.layouts.length, screenshots: plan.screenshots.length }, null, 2));
  process.exitCode = plan.ready ? 0 : 2;
} else {
  assert.equal(plan.ready, true, JSON.stringify(plan.issues, null, 2));
  console.log(JSON.stringify(publish(plan), null, 2));
}
