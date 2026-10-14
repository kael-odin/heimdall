import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { TILE_HEIGHT } from '../src/verify/tiled-compare.mjs';
import { csv, inputInfo, invalidateOldVerifier, invalidateSessionMeasurements,
  verifierSha256, waitForExitOrTimeout } from '../scripts/verify-historical-batch.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-historical-batch.mjs', import.meta.url));
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'heimdall-historical-batch-'));
const WORKSPACE = join(DATA_ROOT, 'workspace');
const RUNS = join(WORKSPACE, '_runs');
const PAGE = join(WORKSPACE, 'fixture.test', 'pages', 'ai');
const PENDING_PAGE = join(WORKSPACE, 'fixture.test', 'pages', 'pending');
const EVIDENCE = 'data/workspace/fixture.test/verify/ai/verify.json';
mkdirSync(join(PAGE, 'clone'), { recursive: true });
writeFileSync(join(PAGE, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/ai' }));
writeFileSync(join(PAGE, 'clone', 'index.html'), '<!doctype html><body>' + 'x'.repeat(128 * 1024) + '</body>');
mkdirSync(join(PENDING_PAGE, 'clone'), { recursive: true });
writeFileSync(join(PENDING_PAGE, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/pending' }));
writeFileSync(join(PENDING_PAGE, 'clone', 'index.html'), '<!doctype html><body>Pending</body>');
after(() => rmSync(DATA_ROOT, { recursive: true, force: true }));
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--run-dir', dir,
  '--host', 'fixture.test', '--page', 'ai', '--max-pages', '1', '--max-copy-mb', '5',
  '--max-page-mb', '5', ...args], { encoding: 'utf8', timeout: 15000,
  env: { ...process.env, HEIMDALL_DATA_DIR: DATA_ROOT } });

function tempRun() {
  mkdirSync(RUNS, { recursive: true });
  return mkdtempSync(join(RUNS, 'historical-batch-test-'));
}

function clean(dir) {
  const rel = relative(RUNS, resolve(dir));
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep));
  assert.equal(realpathSync(dir).toLowerCase(), resolve(dir).toLowerCase());
  assert.equal(lstatSync(dir).isSymbolicLink(), false);
  rmSync(dir, { recursive: true, force: true });
}

function seedMeasured(dir, { tiled = false } = {}) {
  const input = inputInfo(PAGE);
  const file = join(dir, EVIDENCE);
  const diffEvidence = [];
  const viewports = ['375x812', '768x1024', '1440x900'].map((name, index) => {
    const height = tiled && index === 0 ? TILE_HEIGHT + 4 : 1;
    const captureMode = tiled && index === 0 ? 'tiled' : 'full';
    const diffParts = captureMode === 'tiled'
      ? [`diff-${name}-part-001.png`, `diff-${name}-part-002.png`] : null;
    const files = diffParts ?? [`diff-${name}.png`];
    for (let part = 0; part < files.length; part++) {
      const png = new PNG({ width: 10, height: captureMode === 'tiled'
        ? Math.min(TILE_HEIGHT, height - part * TILE_HEIGHT) : height });
      const bytes = PNG.sync.write(png);
      const diffFile = join(file, '..', files[part]);
      mkdirSync(join(diffFile, '..'), { recursive: true });
      writeFileSync(diffFile, bytes);
      diffEvidence.push({ name: files[part], bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return { name, width: 10, score: 0.9, grade: 'B', settleTimedOut: false,
      captureMode, ...(diffParts ? { diffParts } : {}),
      sourceCapture: { settle: { beforeScroll: { stable: true }, afterScroll: { stable: true } } },
      cloneCapture: { settle: { beforeScroll: { stable: true }, afterScroll: { stable: true } } },
      sourceSize: { width: 10, height }, cloneSize: { width: 10, height },
      sourceHeight: height, cloneHeight: height, mismatched: height,
      missingPixels: 0, coverageRatio: 1, heightDelta: 0 };
  });
  const viewportRows = viewports.map(viewport => ({
    host: 'fixture.test', page: 'ai', viewport: viewport.name, status: 'measured',
    score: viewport.score, grade: viewport.grade, settleTimedOut: false,
  }));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ page: 'ai', scoreVersion: 2, measured: true,
    overall: 0.9, grade: 'B', generatedAt: new Date().toISOString(), viewports }));
  const record = { status: 'measured', measured: true, inputBytes: input.bytes, inputSha256: input.sha256,
    verifierSha256: verifierSha256(), evidence: EVIDENCE, newOverall: 0.9, newGrade: 'B',
    resultSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    diffEvidence, viewportsMeasured: 3, viewports: viewportRows };
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({ records: { 'fixture.test/ai': record } }));
  return { file, record };
}

test('batch CSV escapes spreadsheet formulas in text fields', () => {
  const output = csv([{ host: '=1+1', error: ' -HYPERLINK("x")', score: -1 }], ['host', 'error', 'score']);
  assert.match(output, /"'=1\+1"/);
  assert.match(output, /"' -HYPERLINK\(""x""\)"/);
  assert.match(output, /"-1"/);
});

test('new verifier invalidates measured records outside this run selection', () => {
  const records = {
    'a.test/one': { status: 'measured', measured: true, newOverall: 0.9, newGrade: 'B', verifierSha256: 'old', evidence: 'old.json' },
    'b.test/two': { status: 'measured', measured: true, newOverall: 0.8, newGrade: 'C', verifierSha256: 'current' },
  };
  const catalog = [{ host: 'a.test', page: 'one' }, { host: 'b.test', page: 'two' }];
  assert.equal(invalidateOldVerifier(records, catalog, 'current'), 1);
  assert.equal(records['a.test/one'].status, 'stale');
  assert.equal(records['a.test/one'].newOverall, null);
  assert.equal(records['a.test/one'].priorMeasured.overall, 0.9);
  assert.equal(records['a.test/one'].verifierSha256, 'old');
  assert.equal(records['b.test/two'].status, 'measured');
  assert.equal(invalidateOldVerifier(records, catalog, 'current'), 0);
});

test('an original source session invalidates isolated historical measurements', () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-session-'));
  try {
    const pageDir = join(root, 'protected.test', 'pages', 'home');
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: 'https://protected.test/home' }));
    writeFileSync(join(root, 'protected.test', 'session.json'), JSON.stringify({ cookies: [], origins: [] }));
    const records = { 'protected.test/home': { status: 'measured', measured: true,
      newOverall: 0.9, newGrade: 'B', evidence: 'old.json' } };
    const catalog = [{ host: 'protected.test', page: 'home' }];
    assert.equal(invalidateSessionMeasurements(records, catalog, root), 1);
    assert.equal(records['protected.test/home'].status, 'stale');
    assert.equal(records['protected.test/home'].measured, false);
    assert.equal(records['protected.test/home'].newOverall, null);
    assert.equal(records['protected.test/home'].priorMeasured.overall, 0.9);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('damaged progress is rejected without replacing it or leaving a run lock', () => {
  const dir = tempRun();
  try {
    const file = join(dir, 'progress.json');
    writeFileSync(file, '{broken');
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /progress\.json is damaged/);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
    assert.equal(existsSync(join(dir, 'run.lock')), false);
  } finally { clean(dir); }
});

test('live run lock blocks concurrent execution and explicit recovery', () => {
  const dir = tempRun();
  try {
    const file = join(dir, 'run.lock');
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'held', startedAt: new Date().toISOString() }));
    assert.equal(run(dir).status, 1);
    const recovery = run(dir, '--recover-lock');
    assert.equal(recovery.status, 1);
    assert.match(recovery.stderr, /still alive/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'held');
  } finally { clean(dir); }
});

test('resume checks evidence and verifier version; force still selects the page', () => {
  const dir = tempRun();
  try {
    const { file } = seedMeasured(dir);
    const resumed = run(dir, '--dry-run');
    assert.equal(resumed.status, 0);
    assert.equal(JSON.parse(resumed.stdout).selected.length, 0);
    const forced = run(dir, '--dry-run', '--force');
    assert.equal(JSON.parse(forced.stdout).selected.length, 1);
    unlinkSync(file);
    const missing = run(dir, '--dry-run');
    assert.equal(JSON.parse(missing.stdout).selected.length, 1);
  } finally { clean(dir); }
});

test('resume rejects a modified or missing tiled diff image', () => {
  const dir = tempRun();
  try {
    seedMeasured(dir, { tiled: true });
    assert.equal(JSON.parse(run(dir, '--dry-run').stdout).selected.length, 0);
    const diffFile = join(dir, EVIDENCE, '..', 'diff-375x812-part-002.png');
    const png = PNG.sync.read(readFileSync(diffFile));
    png.data[0] = 255;
    writeFileSync(diffFile, PNG.sync.write(png));
    assert.equal(JSON.parse(run(dir, '--dry-run').stdout).selected.length, 1);
    seedMeasured(dir, { tiled: true });
    unlinkSync(diffFile);
    assert.equal(JSON.parse(run(dir, '--dry-run').stdout).selected.length, 1);
  } finally { clean(dir); }
});

test('incomplete or inconsistent measured evidence is not accepted for resume', () => {
  const dir = tempRun();
  try {
    const { file } = seedMeasured(dir);
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const validViewports = evidence.viewports;
    evidence.viewports = evidence.viewports.slice(0, 2);
    writeFileSync(file, JSON.stringify(evidence));
    const incomplete = run(dir, '--dry-run');
    assert.equal(incomplete.status, 0);
    assert.equal(JSON.parse(incomplete.stdout).selected.length, 1);

    evidence.viewports = validViewports;
    evidence.grade = 'A';
    writeFileSync(file, JSON.stringify(evidence));
    const mismatched = run(dir, '--dry-run');
    assert.equal(mismatched.status, 0);
    assert.equal(JSON.parse(mismatched.stdout).selected.length, 1);
  } finally { clean(dir); }
});

test('input change that cannot pass the budget marks the old measurement stale', () => {
  const dir = tempRun();
  try {
    const { file, record } = seedMeasured(dir);
    const progressFile = join(dir, 'progress.json');
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'));
    progress.records['fixture.test/ai'].inputBytes = record.inputBytes + 1;
    writeFileSync(progressFile, JSON.stringify(progress));

    const result = run(dir, '--max-copy-mb', '0.1');
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.remaining >= 1);
    const saved = JSON.parse(readFileSync(progressFile, 'utf8'));
    const current = saved.records['fixture.test/ai'];
    assert.equal(current.status, 'stale');
    assert.equal(current.measured, false);
    assert.equal(current.newOverall, null);
    assert.equal(current.priorMeasured.overall, record.newOverall);
    assert.equal(current.priorMeasured.evidence, EVIDENCE);
    assert.equal(existsSync(file), true);
    assert.doesNotMatch(readFileSync(join(dir, 'viewports.csv'), 'utf8'), /fixture\.test/);
  } finally { clean(dir); }
});

test('verifier change that cannot pass the budget marks the old measurement stale', () => {
  const dir = tempRun();
  try {
    const { file } = seedMeasured(dir);
    const progressFile = join(dir, 'progress.json');
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'));
    progress.records['fixture.test/ai'].verifierSha256 = 'old-verifier';
    writeFileSync(progressFile, JSON.stringify(progress));

    const result = run(dir, '--max-copy-mb', '0.1');
    assert.equal(result.status, 1);
    const saved = JSON.parse(readFileSync(progressFile, 'utf8'));
    const current = saved.records['fixture.test/ai'];
    assert.equal(current.status, 'stale');
    assert.equal(current.priorMeasured.overall, 0.9);
    assert.notEqual(current.verifierSha256, 'old-verifier');
    assert.equal(existsSync(file), true);
  } finally { clean(dir); }
});

test('viewport CSV excludes records outside the current catalog', () => {
  const dir = tempRun();
  try {
    seedMeasured(dir);
    const progressFile = join(dir, 'progress.json');
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'));
    progress.records['ghost.example/old'] = { viewports: [{ host: 'ghost.example', page: 'old', viewport: '375x812' }] };
    writeFileSync(progressFile, JSON.stringify(progress));

    const result = run(dir);
    assert.equal(result.status, 0);
    const viewports = readFileSync(join(dir, 'viewports.csv'), 'utf8');
    const savedProgress = JSON.parse(readFileSync(progressFile, 'utf8'));
    assert.match(viewports, /fixture\.test/);
    assert.doesNotMatch(viewports, /ghost\.example/);
    assert.equal(savedProgress.lastRun.status, 'partial');
    assert.ok(savedProgress.lastRun.remaining > 0);
  } finally { clean(dir); }
});

test('a hung verifier child has a bounded timeout and is terminated', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const started = Date.now();
    const result = await waitForExitOrTimeout(child, 100);
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationFailed, false);
    assert.ok(Date.now() - started < 8000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('budget failure records partial while preserving measured evidence', () => {
  const dir = tempRun();
  try {
    const { file } = seedMeasured(dir);
    const result = run(dir, '--force', '--max-copy-mb', '0.1');
    assert.equal(result.status, 1);
    const saved = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
    assert.equal(saved.lastRun.status, 'partial');
    assert.equal(saved.records['fixture.test/ai'].status, 'stale');
    assert.equal(saved.records['fixture.test/ai'].measured, false);
    assert.equal(saved.records['fixture.test/ai'].lastAttempt.status, 'budget_skipped');
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(join(dir, 'run.lock')), false);
  } finally { clean(dir); }
});

test('preparation deadline produces a recorded partial exit', () => {
  const dir = tempRun();
  try {
    const result = run(dir, '--max-minutes', '0.000001');
    assert.equal(result.status, 1);
    const saved = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
    assert.equal(saved.lastRun.status, 'partial');
    assert.ok(saved.lastRun.issues.some(issue => issue.status === 'preparation_timeout'));
  } finally { clean(dir); }
});

test('run directory junction cannot redirect writes into historical workspace', t => {
  const dir = tempRun();
  const link = join(dir, 'redirect');
  try {
    try { symlinkSync(join(WORKSPACE, 'fixture.test'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip('junction creation unavailable: ' + error.code); return; }
    const result = run(join(link, 'nested'), '--dry-run');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink or junction/);
  } finally {
    if (existsSync(link)) unlinkSync(link);
    clean(dir);
  }
});
