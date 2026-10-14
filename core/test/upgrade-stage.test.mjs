import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCandidate, commitCandidate, publishCandidate, discardCandidate, snapshotCloneArtifacts, recalculateVerificationSummary, invalidatePublishedVerification } from '../src/crawler/upgrade-stage.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-upgrade-'));
  const page = join(root, 'pages', 'home');
  const stageRoot = join(root, 'audit', 'upgrade-candidates');
  const candidate = join(stageRoot, 'home-attempt');
  const backup = join(root, 'audit', 'upgrade-backups', 'home-attempt');
  mkdirSync(page, { recursive: true });
  writeFileSync(join(page, 'clone.html'), 'old bytes');
  return { root, page, stageRoot, candidate, backup };
}

test('candidate is isolated, and accepted page keeps a reversible backup', () => {
  const f = fixture();
  try {
    prepareCandidate(f.page, f.candidate);
    writeFileSync(join(f.candidate, 'clone.html'), 'new bytes');
    assert.equal(readFileSync(join(f.page, 'clone.html'), 'utf8'), 'old bytes');
    commitCandidate(f.page, f.candidate, f.backup);
    assert.equal(readFileSync(join(f.page, 'clone.html'), 'utf8'), 'new bytes');
    assert.equal(readFileSync(join(f.backup, 'clone.html'), 'utf8'), 'old bytes');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('failed candidate rename restores original page byte for byte', () => {
  const f = fixture();
  try {
    prepareCandidate(f.page, f.candidate);
    writeFileSync(join(f.candidate, 'clone.html'), 'new bytes');
    const rename = (from, to) => {
      if (from === f.candidate) throw new Error('simulated switch failure');
      renameSync(from, to);
    };
    assert.throws(() => commitCandidate(f.page, f.candidate, f.backup, { rename }), /simulated switch failure/);
    assert.equal(readFileSync(join(f.page, 'clone.html'), 'utf8'), 'old bytes');
    assert.equal(existsSync(f.backup), false);
    discardCandidate(f.candidate, f.stageRoot);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('published page, verification evidence, and summary move together', () => {
  const f = fixture();
  try {
    const verify = join(f.root, 'verify', 'home');
    const backupVerify = join(f.root, 'audit', 'upgrade-backups', 'home-attempt-verify');
    const summary = join(f.root, 'verify', 'verify-summary.json');
    mkdirSync(verify, { recursive: true });
    writeFileSync(join(verify, 'verify.json'), 'old verify');
    writeFileSync(summary, 'old summary');
    prepareCandidate(f.page, f.candidate);
    mkdirSync(join(f.candidate, 'verify'));
    writeFileSync(join(f.candidate, 'clone.html'), 'new bytes');
    writeFileSync(join(f.candidate, 'verify', 'verify.json'), 'new verify');
    publishCandidate(f.page, f.candidate, f.backup, verify, backupVerify, summary, 'new summary');
    assert.equal(readFileSync(join(f.page, 'clone.html'), 'utf8'), 'new bytes');
    assert.equal(readFileSync(join(verify, 'verify.json'), 'utf8'), 'new verify');
    assert.equal(readFileSync(summary, 'utf8'), 'new summary');
    assert.equal(readFileSync(join(f.backup, 'clone.html'), 'utf8'), 'old bytes');
    assert.equal(readFileSync(join(backupVerify, 'verify.json'), 'utf8'), 'old verify');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('summary publication failure restores page and verification evidence', () => {
  const f = fixture();
  try {
    const verify = join(f.root, 'verify', 'home');
    const backupVerify = join(f.root, 'audit', 'upgrade-backups', 'home-attempt-verify');
    const summary = join(f.root, 'verify', 'verify-summary.json');
    mkdirSync(verify, { recursive: true });
    writeFileSync(join(verify, 'verify.json'), 'old verify');
    writeFileSync(summary, 'old summary');
    prepareCandidate(f.page, f.candidate);
    mkdirSync(join(f.candidate, 'verify'));
    writeFileSync(join(f.candidate, 'clone.html'), 'new bytes');
    writeFileSync(join(f.candidate, 'verify', 'verify.json'), 'new verify');
    assert.throws(() => publishCandidate(f.page, f.candidate, f.backup, verify, backupVerify, summary, 'new summary', {
      writeSummary: () => { throw new Error('simulated summary failure'); },
    }), /simulated summary failure/);
    assert.equal(readFileSync(join(f.page, 'clone.html'), 'utf8'), 'old bytes');
    assert.equal(readFileSync(join(verify, 'verify.json'), 'utf8'), 'old verify');
    assert.equal(readFileSync(summary, 'utf8'), 'old summary');
    assert.equal(readFileSync(join(f.candidate, 'verify', 'verify.json'), 'utf8'), 'new verify');
    assert.equal(existsSync(f.backup), false);
    assert.equal(existsSync(backupVerify), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('candidate cleanup rejects a sibling directory', () => {
  const f = fixture();
  try {
    assert.throws(() => discardCandidate(f.page, f.stageRoot), /outside staging root/);
    assert.equal(readFileSync(join(f.page, 'clone.html'), 'utf8'), 'old bytes');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('summary worst viewport excludes pages without a complete measurement', () => {
  const summary = recalculateVerificationSummary({
    targetTotal: 2,
    pages: [
      { page: 'complete', measured: true, overall: 0.9, minViewport: { name: 'mobile', score: 0.8 } },
      { page: 'partial', measured: false, overall: 0.2, minViewport: { name: 'tablet', score: 0.1 } },
    ],
  });
  assert.equal(summary.measured, 1);
  assert.equal(summary.unmeasured, 1);
  assert.equal(summary.untested, 1);
  assert.equal(summary.average, 0.9);
  assert.deepEqual(summary.worst, { page: 'complete', name: 'mobile', score: 0.8 });
  assert.equal(summary.passed, false);
});

test('postprocessing artifact changes invalidate the published verification result', () => {
  const f = fixture();
  try {
    const clone = join(f.page, 'clone');
    const verify = join(f.root, 'verify', 'home');
    mkdirSync(clone, { recursive: true });
    mkdirSync(verify, { recursive: true });
    writeFileSync(join(clone, 'index.html'), '<html>before</html>');
    writeFileSync(join(verify, 'verify.json'), JSON.stringify({
      page: 'home', target: 'https://fixture.test/', generatedAt: '2026-10-14T00:00:00.000Z',
      scoreVersion: 2, overall: 0.95, measured: true, minViewport: { score: 0.9 },
    }));
    const summary = {
      host: 'fixture.test', scoreVersion: 2, mode: 'all', targetTotal: 1, measured: 1, untested: 0,
      average: 0.95, passed: true, pages: [{ page: 'home', overall: 0.95, measured: true, minViewport: { score: 0.9 } }],
    };
    const before = snapshotCloneArtifacts(join(f.root, 'pages'), ['home']);
    writeFileSync(join(clone, 'styles.css'), 'body { color: red }');
    const after = snapshotCloneArtifacts(join(f.root, 'pages'), ['home']);
    assert.notEqual(before.get('home'), after.get('home'));

    const result = invalidatePublishedVerification(f.root, summary, ['home'], 'linker changed clone');
    assert.deepEqual(result.errors, []);
    assert.equal(result.summary.passed, false);
    assert.equal(result.summary.measured, 0);
    assert.equal(result.summary.untested, 1);
    assert.equal(result.summary.pages[0].overall, null);
    const page = JSON.parse(readFileSync(join(verify, 'verify.json'), 'utf8'));
    assert.equal(page.minViewport, null);
    assert.equal(page.invalidated.previous.overall, 0.95);
    const writtenSummary = JSON.parse(readFileSync(join(f.root, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(writtenSummary.passed, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
