import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareAcceptanceSnapshots, comparisonMarkdown } from '../src/acceptance/comparison.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function check(name = 'menu', patch = {}) {
  const identity = {
    version: 1, kind: 'browser', facet: 'behavior', caseKey: hash(name), contextKey: hash(`${name}:375x812`),
    ruleKey: hash('click-toggle-and-assert-expanded'), oracleKey: hash('approved-reference'),
    environmentKey: hash('chromium-144-profile'), viewport: { width: 375, height: 812 }, pointId: name,
  };
  return { id: name, title: 'Toggle menu', route: '/', viewport: 'mobile', dimension: 'behavior',
    status: 'passed', verdict: 'match', actual: { stepsComplete: true, assertions: [{ passed: true }] },
    evidence: { baselineScreenshot: 'baseline.png', targetScreenshot: 'target.png', baselineDetails: 'baseline.json',
      targetDetails: 'target.json', baselineRepeat: 'baseline-repeat.png', targetRepeat: 'target-repeat.png' },
    ...patch, identity: patch.identity === null ? null : { ...identity, ...patch.identity } };
}
const bug = (name = 'menu', patch = {}) => check(name, { status: 'failed', verdict: 'bug', actual: { assertions: [{ passed: false }] }, ...patch });
function snapshot(runId, checks, patch = {}) {
  const report = summarizeAcceptanceReport({ runId, name: runId, mode: 'regression', status: 'completed',
    targetUrl: `http://127.0.0.1:3000/${runId}`, verifierFingerprint: hash('verifier'),
    startedAt: '2026-10-16T10:00:00.000Z', endedAt: '2026-10-16T10:01:00.000Z',
    checks, coverage: { planned: checks.length, completed: checks.length, capped: false }, ...patch.report });
  return {
    manifest: { runId, name: runId, mode: report.mode, targetUrl: report.targetUrl, status: 'completed', gate: report.gate,
      createdAt: '2026-10-16T10:00:00.000Z', ...patch.manifest },
    report,
    integrity: { valid: true, errors: [], reportSha256: hash(JSON.stringify(report)), evidenceVerified: true, ...patch.integrity },
  };
}
const compare = (beforeChecks, afterChecks, beforePatch, afterPatch) => compareAcceptanceSnapshots(
  snapshot('ac-before', beforeChecks, beforePatch), snapshot('ac-after', afterChecks, afterPatch));

test('a damaged report cannot overwrite the saved original gate in comparison metadata', () => {
  const before = snapshot('ac-before', [bug()]), after = snapshot('ac-after', [bug()]);
  after.report.gate = 'passed';
  after.integrity = { valid: false, evidenceVerified: false, errors: [{ code: 'REPORT_DIGEST_MISMATCH' }] };
  const result = compareAcceptanceSnapshots(before, after);
  assert.equal(result.after.gate, 'failed');
  assert.equal(result.status, 'blocked');
  assert.equal(result.summary.verifiedPassed, 0);
});

test('a complete identical contract must reliably pass before a failure can be called new', () => {
  const result = compare([check()], [bug()]);
  assert.equal(result.checks[0].relation, 'new_failure');
  assert.equal(result.summary.newFailure, 1);
  const untested = compare([], [bug()]);
  assert.equal(untested.summary.newFailure, 0);
  assert.equal(untested.status, 'blocked');
  const added = compare([check('other')], [check('other'), bug()]);
  assert.equal(added.checks.find(row => row.after?.checkId === 'menu').relation, 'observed_failure');
  assert.equal(added.summary.newFailure, 0);
});

test('known failed and passed facts give still_failed, verified_passed and unchanged_passed', () => {
  const result = compare([bug('still'), bug('fixed'), check('same')], [bug('still'), check('fixed'), check('same')]);
  assert.deepEqual(result.checks.map(row => row.relation), ['still_failed', 'verified_passed', 'unchanged_passed']);
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.stillFailed, 1);
  assert.equal(result.summary.verifiedPassed, 1);
  assert.equal(result.summary.unchangedPassed, 1);
  assert.equal(result.after.gate, 'failed');
});

test('an independent new defect does not erase reliable retest evidence for another contract', () => {
  const result = compare([bug('fixed'), check('other')], [check('fixed'), bug('other')]);
  assert.equal(result.after.gate, 'failed');
  assert.equal(result.summary.verifiedPassed, 1);
  assert.equal(result.summary.newFailure, 1);
});

test('reordered routes, viewport labels, titles and display IDs do not change semantic matching', () => {
  const before = [bug('menu'), check('other')];
  const after = [check('other', { id: 'route-1-other' }), check('menu', { id: 'route-8-point-3', title: 'Renamed', viewport: 'phone' })];
  const result = compare(before, after);
  assert.equal(result.summary.verifiedPassed, 1);
  const retest = result.checks.find(row => row.before?.checkId === 'menu');
  assert.equal(retest.after.checkId, 'route-8-point-3');
  assert.deepEqual(retest.viewport, { width: 375, height: 812 });
});

test('different mobile dimensions cannot retest the previous mobile context', () => {
  const changed = check('menu', { identity: { contextKey: hash('menu:390x844'), viewport: { width: 390, height: 844 } } });
  const result = compare([bug()], [changed]);
  assert.equal(result.summary.verifiedPassed, 0);
  assert.equal(result.summary.incomparable, 2);
  assert.ok(result.checks.every(row => row.reasons.some(item => item.code === 'viewport-changed')));
});

test('actual viewport, route and method metadata cannot be hidden behind equal hash fields', () => {
  for (const patch of [
    { identity: { viewport: { width: 390, height: 844 } } },
    { route: '/different' }, { identity: { method: 'HEAD' } },
  ]) {
    const result = compare([bug()], [check('menu', patch)]);
    assert.equal(result.summary.verifiedPassed, 0);
    assert.equal(result.checks[0].relation, 'incomparable');
  }
});

test('passing desktop alone leaves the failed phone occurrence unverified', () => {
  const desktop = patch => check('menu', { id: 'desktop-menu', ...patch, identity: {
    contextKey: hash('menu:1440x900'), viewport: { width: 1440, height: 900 }, ...patch?.identity,
  } });
  const result = compare([bug(), desktop({ status: 'failed', verdict: 'bug' })], [desktop()]);
  assert.equal(result.summary.verifiedPassed, 1);
  assert.equal(result.summary.unverified, 1);
  assert.equal(result.checks.find(row => row.before?.checkId === 'menu').relation, 'unverified');
});

test('deleted route or assertion coverage cannot turn the missing failure into a fix', () => {
  const result = compare([bug('deleted'), check('kept')], [check('kept')]);
  assert.equal(result.checks.find(row => row.before?.checkId === 'deleted').relation, 'unverified');
  assert.equal(result.summary.verifiedPassed, 0);
  assert.ok(result.checks.find(row => row.before?.checkId === 'deleted').reasons.some(item => item.code === 'check-not-rerun'));
});

test('threshold, masks, steps, assertions and schema changes remain incomparable', () => {
  for (const change of ['lowered-threshold', 'new-mask', 'deleted-assertion', 'new-step', 'weaker-schema']) {
    const result = compare([bug()], [check('menu', { identity: { ruleKey: hash(change) } })]);
    assert.equal(result.checks[0].relation, 'incomparable', change);
    assert.equal(result.checks[0].reasons[0].code, 'definition-changed', change);
    assert.equal(result.summary.verifiedPassed, 0);
  }
});

test('same baseline URL with changed screenshot or Spec source never proves a fix', () => {
  for (const source of ['new-baseline-screenshot', 'new-document', 'new-revision', 'changed-contract']) {
    const result = compare([bug()], [check('menu', { identity: { oracleKey: hash(source) } })]);
    assert.equal(result.summary.incomparable, 1);
    assert.equal(result.summary.verifiedPassed, 0);
    assert.ok(result.checks[0].reasons.some(item => item.code === 'oracle-changed'));
  }
});

test('changed verifier or environment stops historical acceptance claims', () => {
  const environment = compare([bug()], [check('menu', { identity: { environmentKey: hash('other-chromium') } })]);
  assert.equal(environment.checks[0].relation, 'incomparable');
  assert.ok(environment.checks[0].reasons.some(item => item.code === 'environment-changed'));
  const verifier = compare([bug()], [check()], {}, { report: { verifierFingerprint: hash('other-verifier') } });
  assert.ok(verifier.checks[0].reasons.some(item => item.code === 'verifier-changed'));
  const unknown = compare([bug()], [check()], {}, { report: { verifierFingerprint: undefined } });
  assert.ok(unknown.checks[0].reasons.some(item => item.code === 'verifier-unknown'));
});

test('legacy, incomplete and ambiguous identities are not guessed from display IDs', () => {
  const legacy = compare([bug('same-id', { identity: null })], [check('same-id', { identity: null })]);
  assert.equal(legacy.summary.incomparable, 2);
  assert.equal(legacy.summary.verifiedPassed, 0);
  const unknownEnvironment = compare([bug()], [check('menu', { identity: { environmentKey: null } })]);
  assert.ok(unknownEnvironment.checks.some(row => row.reasons.some(item => item.code === 'identity-unavailable')));
  const conflict = compare([bug(), bug('menu', { id: 'duplicate-id' })], [check()]);
  assert.equal(conflict.summary.incomparable, 3);
  assert.ok(conflict.checks.every(row => row.reasons[0].code === 'identity-conflict'));
});

test('failed, interrupted, partial, capped and invalid snapshots block reliable retest', () => {
  const patches = [
    { manifest: { status: 'interrupted' } }, { report: { status: 'failed' } },
    { report: { coverage: undefined } },
    { report: { coverage: { planned: 2, completed: 1, capped: false } } },
    { report: { coverage: { planned: 1, completed: 0, capped: false } } },
    { report: { coverage: { planned: 1, completed: 1, capped: true } } },
    { report: { coverage: { planned: 1, completed: 1 } } },
  ];
  for (const patch of patches) {
    const result = compare([bug()], [check()], {}, patch);
    assert.equal(result.status, 'blocked', JSON.stringify(patch));
    assert.equal(result.summary.verifiedPassed, 0);
    assert.equal(result.summary.unverified, 1);
  }
  const invalid = compare([bug()], [check('menu', { verdict: 'environment' })]);
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.summary.verifiedPassed, 0);
});

test('currently tampered or missing report/evidence never inherits the historical gate', () => {
  for (const integrity of [
    { valid: false, errors: [{ code: 'EVIDENCE_HASH_MISMATCH', message: 'changed' }] },
    { evidenceVerified: false }, { valid: undefined },
    { valid: true, evidenceVerified: true, errors: [{ code: 'REPORT_DIGEST_UNAVAILABLE', message: 'old' }] },
  ]) {
    const result = compare([bug()], [check()], {}, { integrity });
    assert.equal(result.status, 'blocked');
    assert.equal(result.summary.verifiedPassed, 0);
    assert.ok(result.checks[0].reasons.some(item => item.code === 'after-evidence-integrity'));
  }
  const priorTampered = compare([check()], [bug()], { integrity: { valid: false } });
  assert.equal(priorTampered.summary.newFailure, 0);
  const unavailable = compare([bug()], [check()], {}, { integrity: {
    valid: false, errors: [{ code: 'REPORT_DIGEST_UNAVAILABLE', message: 'PRIVATE_FILE_PATH' }],
  } });
  assert.match(unavailable.checks[0].reasons[0].message, /REPORT_DIGEST_UNAVAILABLE/);
  assert.equal(JSON.stringify(unavailable).includes('PRIVATE_FILE_PATH'), false);
});

test('blocked, baseline failure and needs_review do not close an earlier bug', () => {
  for (const state of [
    { status: 'blocked', verdict: 'environment' },
    { status: 'blocked', verdict: 'baseline_failed' },
    { status: 'needs_review', verdict: 'needs_review' },
  ]) {
    const result = compare([bug()], [check('menu', state)]);
    assert.equal(result.checks[0].relation, 'unverified');
    assert.equal(result.summary.verifiedPassed, 0);
  }
});

test('reported pass with budget, capture, masks, policy or execution limits cannot retest', () => {
  const observations = [
    { evaluationLimited: true }, { requested: false }, { eligible: false }, { captureLimited: true },
    { capture: { baseline: { captureLimited: true } } }, { capture: { target: { captureLimited: true } } },
    { maskCoverage: { baseline: { samplingCapped: true } } }, { maskCoverage: { target: { maskedRatio: 0.81 } } },
    { baselineStability: 0.8 }, { targetStability: 0.99 }, { policyAffected: true },
    { stepsComplete: false }, { assertions: [{ passed: false }] }, { errorCode: 'VALIDATION_BUDGET' },
    { mismatches: [{ kind: 'http-status' }] }, { schemaFailures: [{ pointer: '/items' }] },
    { blockedRequests: [{ method: 'POST' }] },
  ];
  for (const actual of observations) {
    const result = compare([bug()], [check('menu', { actual })]);
    assert.equal(result.checks[0].relation, 'unverified', JSON.stringify(actual));
    assert.ok(result.checks[0].reasons.some(item => item.code === 'evaluation-limited'));
  }
});

test('a previous limited pass cannot justify a claim of new regression', () => {
  const result = compare([check('menu', { actual: { evaluationLimited: true } })], [bug()]);
  assert.equal(result.checks[0].relation, 'observed_failure');
  assert.equal(result.summary.newFailure, 0);
});

test('hashing only the references that exist cannot prove a pass with omitted required evidence', () => {
  for (const evidence of [undefined, {}, { baselineScreenshot: 'baseline.png' }]) {
    const result = compare([bug()], [check('menu', { evidence })]);
    assert.equal(result.checks[0].relation, 'unverified');
    assert.ok(result.checks[0].reasons.some(item => item.code === 'evidence-reference-missing'));
    const regression = compare([check('menu', { evidence })], [bug()]);
    assert.equal(regression.checks[0].relation, 'observed_failure');
    assert.equal(regression.summary.newFailure, 0);
  }
});

test('Spec requires the entire same approved contract to pass, not a missing child mismatch', () => {
  const spec = (failed, patch = {}) => (failed ? bug : check)('items', { viewport: 'api', ...patch,
    evidence: { contract: 'contract.json', request: 'request.json', response: 'response.json', ...patch.evidence },
    identity: { kind: 'spec', facet: 'contract', viewport: 'api', contractId: 'items', method: 'GET', ...patch.identity } });
  const approved = { report: { mode: 'spec', specApproval: { approved: true } } };
  const stillWrong = compare([spec(true, { actual: { mismatches: [{ pointer: '/items' }] } })],
    [spec(true, { actual: { mismatches: [{ kind: 'http-status' }], bodyRead: 'not-needed-after-header-mismatch' } })], approved, approved);
  assert.equal(stillWrong.checks[0].relation, 'still_failed');
  assert.equal(stillWrong.summary.verifiedPassed, 0);
  const passed = compare([spec(true)], [spec(false)], approved, approved);
  assert.equal(passed.summary.verifiedPassed, 1);
  const unapproved = compare([spec(true)], [spec(false)], approved, { report: { mode: 'spec', specApproval: { approved: false } } });
  assert.equal(unapproved.status, 'blocked');
  assert.equal(unapproved.summary.verifiedPassed, 0);
});

test('mode changes and GET to HEAD do not close existing failures', () => {
  const mode = compare([bug()], [check()], {}, { report: { mode: 'mirror' } });
  assert.equal(mode.checks[0].relation, 'incomparable');
  const method = compare([bug()], [check('menu-head', { identity: { method: 'HEAD' } })]);
  assert.equal(method.summary.verifiedPassed, 0);
  assert.equal(method.summary.observedPassed, 1);
  assert.equal(method.summary.unverified, 1);
});

test('same run is rejected, selected order is preserved, and no input is mutated', () => {
  const a = snapshot('ac-before', [bug()]), b = snapshot('ac-after', [check()]);
  assert.throws(() => compareAcceptanceSnapshots(a, a), error => error.code === 'SAME_RUN');
  const original = JSON.stringify([a, b]);
  const result = compareAcceptanceSnapshots(b, a);
  assert.equal(result.before.runId, 'ac-after');
  assert.equal(result.after.runId, 'ac-before');
  assert.equal(result.summary.newFailure, 1);
  assert.equal(JSON.stringify([a, b]), original);
});

test('corrupt snapshots render a blocked result instead of throwing', () => {
  for (const broken of [null, {}, { manifest: { runId: 'ac-broken' }, report: null, integrity: { valid: false } }]) {
    const result = compareAcceptanceSnapshots(broken, snapshot('ac-after', [check()]));
    assert.equal(result.status, 'blocked');
    assert.equal(result.summary.verifiedPassed, 0);
    assert.match(comparisonMarkdown(result), /受阻/);
  }
});

test('comparison JSON and Markdown preserve references without copying raw evidence or approval', () => {
  const secret = 'PRIVATE_RESPONSE_AND_SOURCE_TEXT';
  const before = snapshot('ac-before', [bug('menu', { actual: { response: secret }, expected: { source: secret } })]);
  const after = snapshot('ac-after', [check('menu', { title: '<script>x</script>|menu\nsecond' })]);
  after.report.source = secret;
  const result = compareAcceptanceSnapshots(before, after);
  assert.equal(result.scope, 'explicit-pair');
  assert.equal(result.checks[0].before.checkId, 'menu');
  assert.equal(result.checks[0].after.checkId, 'menu');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(Object.hasOwn(result, 'approved'), false);
  const markdown = comparisonMarkdown(result);
  assert.match(markdown, /可靠复验通过/);
  assert.match(markdown, /&lt;script&gt;/);
  assert.match(markdown, /\\\|menu second/);
  assert.equal(markdown.includes('<script>'), false);
  assert.equal(markdown.includes(secret), false);
  assert.match(markdown, /不自动批准/);
});

test('integrity diagnostics project bounded codes and basenames without raw messages or absolute paths', () => {
  const errors = [
    { code: 'REPORT_DIGEST_UNAVAILABLE', message: 'PRIVATE_RESPONSE_BODY', file: 'manifest.json' },
    { code: 'EVIDENCE_DIGEST_MISMATCH', message: 'C:\\Users\\private\\source', file: 'target.png', raw: 'SECRET' },
    { code: 'FILE_UNREADABLE', message: '/home/private/source', file: 'C:\\Users\\private\\target.png' },
    ...Array.from({ length: 45 }, () => ({ code: 'INTEGRITY_BUDGET', message: 'SECRET' })),
  ];
  const result = compare([bug()], [check()], {}, { integrity: {
    valid: false, evidenceVerified: false, verifiedFiles: 3, verifiedBytes: 2048, errors,
  } });
  assert.equal(result.integrity.after.errors.length, 40);
  assert.equal(result.integrity.after.verifiedFiles, 3);
  assert.equal(result.integrity.after.verifiedBytes, 2048);
  assert.equal(result.integrity.after.errors[0].file, 'manifest.json');
  assert.equal(result.integrity.after.errors[2].file, undefined);
  assert.match(result.integrity.after.errors[0].message, /旧运行/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_RESPONSE_BODY'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  const markdown = comparisonMarkdown(result);
  assert.match(markdown, /证据完整性/);
  assert.match(markdown, /EVIDENCE_DIGEST_MISMATCH/);
  assert.match(markdown, /target\.png/);
  assert.match(markdown, /2048/);
});
