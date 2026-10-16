import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAcceptanceRun, acceptanceRunDir, finishAcceptanceRun, readAcceptanceRun,
  readAcceptanceSnapshot, updateAcceptanceRun, ACCEPTANCE_SNAPSHOT_LIMITS } from '../src/acceptance/store.mjs';

const plan = { mode: 'spec', targetUrl: 'http://127.0.0.1:3088', spec: {
  source: { id: 'snapshot-fixture', revision: 'v1' }, approved: true,
  checks: [{ id: 'READ', title: 'Read', path: '/items', method: 'GET', expect: { status: 200 } }],
} };
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-snapshot-'));
  try {
    const run = createAcceptanceRun(plan, { root });
    const dir = acceptanceRunDir(run.runId, root);
    writeFileSync(join(dir, 'detail.json'), '{}');
    const report = finishAcceptanceRun(run.runId, { runId: run.runId, mode: 'spec', name: run.name,
      targetUrl: run.targetUrl, startedAt: run.createdAt, endedAt: new Date().toISOString(), status: 'completed',
      coverage: { planned: 1, completed: 1, capped: false }, checks: [{ id: 'READ', route: '/items', viewport: 'api',
        title: 'Read', dimension: 'behavior', status: 'passed', verdict: 'match', evidence: { response: 'detail.json' } }],
    }, { root });
    return fn({ root, run, dir, report });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const put = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const codes = snapshot => snapshot.integrity.errors.map(error => error.code);

test('snapshot verifies current report, plan, summary and every referenced evidence byte', () => fixture(({ root, run, dir }) => {
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.valid, true);
  assert.equal(snapshot.integrity.evidenceVerified, true);
  assert.equal(snapshot.integrity.verifiedFiles, 1);
  assert.equal(snapshot.integrity.verifiedBytes, 2);
  assert.equal(snapshot.integrity.reportSha256, createHash('sha256').update(readFileSync(join(dir, 'report.json'))).digest('hex'));
  assert.equal(snapshot.integrity.reportSha256, readAcceptanceRun(run.runId, { root }).reportSha256);
  assert.equal(readAcceptanceSnapshot('ac-00000000-0000-4000-8000-000000000000', { root }), null);
  assert.throws(() => readAcceptanceSnapshot('../outside', { root }));
}));

test('same-length changed evidence and missing evidence cannot inherit an old passing hash', () => fixture(({ root, run, dir }) => {
  writeFileSync(join(dir, 'detail.json'), '[]');
  let snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.valid, false);
  assert.ok(codes(snapshot).includes('EVIDENCE_DIGEST_MISMATCH'));
  unlinkSync(join(dir, 'detail.json'));
  snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.evidenceVerified, false);
  assert.ok(codes(snapshot).includes('FILE_UNAVAILABLE'));
}));

test('changing the report or plan after completion prevents reliable comparison', () => fixture(({ root, run, dir }) => {
  const reportFile = join(dir, 'report.json'), changed = json(reportFile);
  changed.checks[0].title = 'Changed after completion';
  put(reportFile, changed);
  assert.ok(codes(readAcceptanceSnapshot(run.runId, { root })).includes('REPORT_DIGEST_MISMATCH'));
  const manifestFile = join(dir, 'manifest.json'), manifest = json(manifestFile);
  manifest.plan.spec.checks[0].expect.status = 204;
  put(manifestFile, manifest);
  assert.ok(codes(readAcceptanceSnapshot(run.runId, { root })).includes('PLAN_DIGEST_MISMATCH'));
}));

test('legacy reports without a completion digest remain readable but unverified', () => fixture(({ root, run, dir }) => {
  const manifestFile = join(dir, 'manifest.json'), manifest = json(manifestFile);
  delete manifest.reportSha256;
  put(manifestFile, manifest);
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.report.checks[0].status, 'passed');
  assert.equal(snapshot.integrity.valid, false);
  assert.ok(codes(snapshot).includes('REPORT_DIGEST_UNAVAILABLE'));
}));

test('inconsistent report identity and summary cannot masquerade as a valid snapshot', () => fixture(({ root, run, dir }) => {
  const reportFile = join(dir, 'report.json'), changed = json(reportFile);
  changed.targetUrl = 'http://other.invalid/';
  changed.summary.passed = 100;
  put(reportFile, changed);
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.valid, false);
  assert.ok(codes(snapshot).includes('RUN_TARGET_MISMATCH'));
  assert.ok(codes(snapshot).includes('SUMMARY_MISMATCH'));
}));

test('integrity verification has explicit byte budgets instead of silently skipping large evidence', () => fixture(({ root, run }) => {
  const limits = { ...ACCEPTANCE_SNAPSHOT_LIMITS, evidenceBytes: 1 };
  const snapshot = readAcceptanceSnapshot(run.runId, { root, limits });
  assert.equal(snapshot.integrity.valid, false);
  assert.equal(snapshot.integrity.evidenceVerified, false);
  assert.ok(codes(snapshot).includes('INTEGRITY_BUDGET'));
}));

test('malformed, duplicated and unindexed evidence entries produce structured integrity failures', () => fixture(({ root, run, dir }) => {
  const file = join(dir, 'report.json'), changed = json(file);
  changed.evidenceManifest.push({ ...changed.evidenceManifest[0] });
  changed.checks[0].evidence.request = 'not-indexed.json';
  put(file, changed);
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.valid, false);
  assert.ok(codes(snapshot).includes('INVALID_EVIDENCE_MANIFEST'));
  assert.ok(codes(snapshot).includes('EVIDENCE_NOT_INDEXED'));
}));

test('damaged JSON is returned as a bounded diagnostic without echoing its payload', () => fixture(({ root, run, dir }) => {
  writeFileSync(join(dir, 'report.json'), '{secret_payload=do-not-echo');
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.report, null);
  assert.equal(snapshot.integrity.valid, false);
  assert.ok(codes(snapshot).includes('INVALID_JSON'));
  assert.ok(!JSON.stringify(snapshot.integrity).includes('do-not-echo'));
}));

test('completed facts are immutable while independent AI metadata can still be saved', () => fixture(({ root, run }) => {
  const before = readAcceptanceRun(run.runId, { root });
  for (const patch of [{ reportSha256: '0'.repeat(64) }, { gate: 'failed' }, { targetUrl: 'http://other.invalid/' },
    { createdAt: '2030-01-01' }, { summary: {} }, { name: 'renamed' }]) {
    assert.throws(() => updateAcceptanceRun(run.runId, patch, { root }), /immutable/);
  }
  updateAcceptanceRun(run.runId, { triageAvailable: true }, { root });
  const after = readAcceptanceRun(run.runId, { root });
  assert.equal(after.reportSha256, before.reportSha256);
  assert.equal(after.gate, 'passed');
  assert.equal(after.triageAvailable, true);
}));

test('evidence symlinks cannot point outside the selected run', t => fixture(({ root, run, dir }) => {
  const outside = join(root, 'outside.json');
  writeFileSync(outside, '{}');
  unlinkSync(join(dir, 'detail.json'));
  try { symlinkSync(outside, join(dir, 'detail.json'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Host does not allow test symlinks');
    throw error;
  }
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.valid, false);
  assert.ok(codes(snapshot).includes('FILE_UNAVAILABLE'));
}));
