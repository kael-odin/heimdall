import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAcceptancePlan, resolveAcceptanceUrl } from '../src/acceptance/schema.mjs';
import { summarizeAcceptanceReport, acceptanceMarkdown } from '../src/acceptance/report.mjs';
import { createAcceptanceRun, readAcceptanceRun, listAcceptanceRuns, recoverAcceptanceRuns, finishAcceptanceRun, acceptanceRunDir, acceptanceArtifact, updateAcceptanceRun, readAcceptanceTriage, saveAcceptanceTriage } from '../src/acceptance/store.mjs';

const input = { baselineUrl: 'http://127.0.0.1:3000/reference', targetUrl: 'http://127.0.0.1:3001/preview' };
const match = { id: 'visual', title: 'Same page', dimension: 'visual', status: 'passed', verdict: 'match', score: 1 };
test('acceptance entry-relative routes preserve entries and reject traversal and foreign origins', () => {
  const plan = normalizeAcceptancePlan(input);
  assert.equal(plan.viewports.length, 3);
  assert.equal(resolveAcceptanceUrl(input.baselineUrl, '/'), input.baselineUrl);
  assert.equal(resolveAcceptanceUrl(input.baselineUrl, '/overview?a=1'), input.baselineUrl + '/overview?a=1');
  for (const route of ['//evil.test', '/%2fexample.test', '/%252e%252e/private', '/a/../b', '/a\\b', '/a#b']) {
    assert.throws(() => normalizeAcceptancePlan({ ...input, routes: [route] }));
  }
});
test('acceptance schema rejects unsupported execution and unbounded coverage instead of trimming', () => {
  for (const patch of [
    { baselineUrl: 'file:///tmp/a' }, { targetUrl: 'https://user:password@site.test' },
    { routes: [] }, { routes: ['/','/'] }, { routes: Array.from({ length: 9 }, (_, i) => '/' + i) },
    { mode: 'spec' }, { viewports: [{ name: '../escape', width: 1440, height: 900 }] },
    { thresholds: { visual: 1.5 } }, { timeoutMs: Infinity }, { normalization: { maskSelectors: [null] } },
    { points: [{ id: 'a', title: 'A', assertions: [{ kind: 'evaluate', expression: 'document.cookie' }] }] },
    { points: [{ id: 'a', title: 'A', route: '/undeclared', assertions: [{ kind: 'visible', selector: 'button' }] }] },
    { points: [{ id: 'a', title: 'A', assertions: [{ kind: 'text', selector: 'body', equals: '', contains: '' }] }] },
  ]) assert.throws(() => normalizeAcceptancePlan({ ...input, ...patch }), JSON.stringify(patch));
  const point = { id: 'a', title: 'A', assertions: [{ kind: 'attribute', selector: 'button', attribute: 'aria-expanded', equals: 'true' }] };
  assert.equal(normalizeAcceptancePlan({ ...input, points: [point] }).points[0].assertions[0].equals, 'true');
});
test('acceptance gate cannot hide behavioral failure behind perfect visual score', () => {
  const report = summarizeAcceptanceReport({ checks: [match, { id: 'behavior', dimension: 'behavior', status: 'failed', verdict: 'bug', severity: 'critical' }] });
  assert.equal(report.gate, 'failed');
  assert.equal(report.summary.dimensions.visual.score, 1);
  assert.equal(report.summary.bugs, 1);
  assert.equal(report.summary.dimensions.structure.score, null);
});
test('acceptance empty, partial, baseline-failed, inconsistent and unstable evidence never pass', () => {
  assert.equal(summarizeAcceptanceReport({ checks: [] }).gate, 'blocked');
  assert.equal(summarizeAcceptanceReport({ checks: [match], coverage: { planned: 3 } }).summary.missing, 2);
  for (const raw of [
    { checks: [match], coverage: { planned: 3 } },
    { checks: [{ ...match, status: 'blocked', verdict: 'baseline_failed' }] },
    { checks: [{ ...match, status: 'needs_review', verdict: 'needs_review' }] },
    { checks: [{ ...match, verdict: 'environment' }] },
    { checks: [match], coverage: { capped: true } },
  ]) assert.notEqual(summarizeAcceptanceReport(raw).gate, 'passed');
  assert.equal(summarizeAcceptanceReport({ checks: [match] }).gate, 'passed');
});
test('acceptance store preserves evidence allowlist, history and interrupted runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-model-'));
  try {
    const run = createAcceptanceRun(input, { root });
    assert.equal(listAcceptanceRuns({ root })[0].runId, run.runId);
    assert.equal(listAcceptanceRuns({ root })[0].plan, undefined);
    assert.throws(() => acceptanceRunDir('../escape', root));
    assert.equal(acceptanceArtifact(run.runId, 'report.json', { root }), null);
    const dir = acceptanceRunDir(run.runId, root);
    writeFileSync(join(dir, 'evidence.png'), 'fixture');
    writeFileSync(join(dir, 'unreferenced.json'), '{}');
    finishAcceptanceRun(run.runId, { ...input, name: 'A|B', checks: [{ ...match, evidence: { baselineScreenshot: 'evidence.png' } }] }, { root });
    assert.equal(readAcceptanceRun(run.runId, { root }).status, 'completed');
    assert.ok(existsSync(acceptanceArtifact(run.runId, 'evidence.png', { root })));
    assert.equal(acceptanceArtifact(run.runId, 'unreferenced.json', { root }), null);
    assert.throws(() => acceptanceArtifact(run.runId, '../manifest.json', { root }));
    assert.equal(acceptanceArtifact(run.runId, 'manifest.json', { root }), null);
    assert.ok(readFileSync(join(dir, 'report.md'), 'utf8').includes('A\\|B'));
    const interrupted = createAcceptanceRun(input, { root });
    assert.equal(recoverAcceptanceRuns({ root }), 1);
    assert.equal(readAcceptanceRun(interrupted.runId, { root }).status, 'interrupted');
    assert.throws(() => finishAcceptanceRun(interrupted.runId, { checks: [match] }, { root }));
    assert.throws(() => updateAcceptanceRun(interrupted.runId, { progress: { kind: 'old-worker' } }, { root }));
    assert.equal(readAcceptanceRun(interrupted.runId, { root }).gate, 'blocked');
    saveAcceptanceTriage(run.runId, { status: 'completed', items: [] }, { root });
    assert.deepEqual(readAcceptanceTriage(run.runId, { root }), { status: 'completed', items: [] });
    assert.equal(readAcceptanceRun(run.runId, { root }).gate, 'passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Markdown report keeps bug reproduction and baseline evidence independently of score', () => {
  const content = acceptanceMarkdown({ ...input, name: 'Report', checks: [{ ...match, status: 'failed', verdict: 'bug', reproduction: ['Click menu'], evidenceLevel: 'browser-reproduced', evidence: { baselineScreenshot: 'baseline.png', targetScreenshot: 'target.png' } }] });
  assert.match(content, /Click menu/);
  assert.match(content, /baseline\.png/);
  assert.match(content, /阻断：发现缺陷/);
  assert.match(content, /未测/);
});
test('missing referenced evidence blocks a run and intact evidence has reproducible hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-integrity-'));
  try {
    const missing = createAcceptanceRun(input, { root });
    const report = finishAcceptanceRun(missing.runId, { checks: [{ ...match, evidence: { baselineScreenshot: 'missing.png' } }] }, { root });
    assert.equal(report.gate, 'blocked');
    assert.equal(report.summary.blocked, 1);
    assert.equal(report.checks.at(-1).id, 'evidence-integrity');
    assert.match(report.planFingerprint, /^[a-f0-9]{64}$/);
    assert.match(report.verifierFingerprint, /^[a-f0-9]{64}$/);
    const intact = createAcceptanceRun(input, { root });
    writeFileSync(join(acceptanceRunDir(intact.runId, root), 'detail.json'), '{}');
    const complete = finishAcceptanceRun(intact.runId, { checks: [{ ...match, evidence: { baselineDetails: 'detail.json' } }] }, { root });
    assert.equal(complete.gate, 'passed');
    assert.equal(complete.evidenceManifest.length, 1);
    assert.equal(complete.evidenceManifest[0].bytes, 2);
    assert.match(complete.evidenceManifest[0].sha256, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
