import test from 'node:test';
import assert from 'node:assert/strict';
import { browserBindingUrlView, browserBindingSummaryView, browserBindingCollectionView,
  browserBindingPreviewView, browserBindingReadView, browserBindingMutationView,
  browserBindingSummariesOf } from '../src/acceptance/browser-binding-view.mjs';

const uid = (prefix, n) => prefix + '-' + String(n).repeat(8) + '-' + String(n).repeat(4)
  + '-' + String(n).repeat(4) + '-' + String(n).repeat(4) + '-' + String(n).repeat(12);
const projectId = uid('ap', 1), releaseId = uid('ar', 2), runId = uid('ac', 3), bindingId = uid('ax', 4);
const generationId = uid('ag', 5), digest = 'a'.repeat(64);
const forbidden = ['query-key-secret', 'query-value-secret', 'password-secret', 'fragment-secret',
  'step-secret', 'assertion-secret', 'rule-secret', 'private-path-secret', 'unexpected-secret'];
const url = 'https://user:password-secret@example.test/app?query-key-secret=query-value-secret#fragment-secret';
const evidence = Object.fromEntries(['details', 'screenshot', 'repeat'].map(role => [role,
  { file: 'selected-' + role + (role === 'details' ? '.json' : '.png'), bytes: 100, sha256: digest, href: '/private-path-secret' }]));
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const binding = { id: bindingId, projectId, releaseId, projectionVersion: 1,
    source: { runId, sourceMode: 'regression', side: 'baseline', entryUrl: url, path: 'private-path-secret' },
    sourcePlanDigest: digest, sourceReportDigest: digest, evidenceManifestDigest: digest,
    selectedEvidenceManifestDigest: digest, scopeKey: digest, ruleManifestKey: digest, oracleManifestKey: digest,
    environmentKey: digest, verifierFingerprint: digest, sourceContentDigest: digest,
    boundAt: '2026-10-17T00:00:00.000Z', actor: { kind: 'local-operator', token: 'unexpected-secret' },
    preview: 'unexpected-secret', plan: { url }, files: Buffer.from('unexpected-secret') };
  const observation = { slot: { route: '/app?query-key-secret=query-value-secret#fragment-secret',
    viewport: { width: 960, height: 640, private: 'unexpected-secret' }, pointId: 'P1' },
    viewportName: 'desktop', title: '<img src=x onerror=alert(1)>', severity: 'high', plannedUrl: url,
    observedFinalUrl: 'https://example.test/app?query-key-secret=%5Bredacted%5D#fragment-secret',
    finalUrlProof: 'unexpected-secret', evidence: clone(evidence),
    expected: { httpStatus: 200, screenshotSha256: digest,
      structure: { title: '<script>not executable</script>', headings: ['<h1>Page</h1>'],
        controls: [{ path: 'button#go', tag: 'button', role: 'button', label: '<svg onload=alert(1)>', type: 'button',
          href: url, disabled: false, expanded: 'false', selected: null, private: 'unexpected-secret' },
        { path: 'a#bad', tag: 'a', role: null, label: 'Untrusted link', type: null,
          href: 'javascript:alert("query-value-secret")', disabled: false, expanded: null, selected: null }] },
      steps: [{ action: 'fill', selector: '#password', value: 'step-secret' }],
      assertions: [{ kind: 'text', selector: '#result', equals: 'assertion-secret' }],
      observedAssertions: [{ kind: 'text', selector: '#result', expected: 'assertion-secret', actual: 'assertion-secret', passed: true,
        error: 'private-path-secret' }], private: 'unexpected-secret' },
    steps: [{ value: 'step-secret' }], assertions: [{ equals: 'assertion-secret' }],
    capture: { captureScope: 'full-page', captureLimited: false, documentSize: { width: 960, height: 640, private: 'unexpected-secret' },
      private: 'unexpected-secret' }, mask: { maskedRatio: 0, effectiveAreaPx: 614400, samplingCapped: false, private: 'unexpected-secret' },
    stability: 1, rawDetails: 'private-path-secret' };
  const preview = { projectionVersion: 1, mode: 'browser', sourceReference: clone(binding.source), name: 'Organization review',
    sourceStatus: 'completed', sourceGate: 'failed', declaredSlots: 14, projectedSlots: 14, observations: [observation],
    rules: [{ route: 'rule-secret', steps: [{ value: 'step-secret' }] }], omissions: [], executionReady: true,
    oracleStorage: 'unexpected-secret', environment: { platform: 'win32', arch: 'x64', nodeVersion: 'v22.0.0', browser: 'chromium',
      browserVersion: '130', playwrightVersion: '1.63', locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce',
      private: 'private-path-secret' }, verifierFingerprint: digest,
    urlProof: { planned: url, observedFinal: url }, reviewNotice: 'unexpected-secret', path: 'private-path-secret' };
  const event = { id: uid('ae', 6), revision: 7, kind: 'browser-source-bound', projectId, entityId: bindingId,
    entityDigest: digest, at: binding.boundAt, actor: { kind: 'local-operator', token: 'unexpected-secret' }, private: url };
  return { binding, preview, event, generationId, revision: 7, executionReady: true,
    diagnostics: { eligible: true, contentMatches: true, issues: [], path: 'private-path-secret' }, plan: { url } };
}
function noSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const secret of forbidden) assert.equal(serialized.includes(secret), false, secret);
  for (const field of ['entryUrl', 'plannedUrl', 'observedFinalUrl', 'href', 'rules', 'steps', 'assertions', 'observedAssertions', 'plan', 'files', 'rawDetails']) {
    assert.equal(serialized.includes('"' + field + '":'), false, field);
  }
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('URL text hides credentials, whole query and fragments without confusing display with exact identity', async t => {
  for (const [input, relative, expected] of [
    [url, false, { display: 'https://example.test/app?[redacted]', queryPresent: true }],
    ['https://example.test/app?', false, { display: 'https://example.test/app?[redacted]', queryPresent: true }],
    ['https://example.test/app#query-key-secret=query-value-secret', false, { display: 'https://example.test/app', queryPresent: false }],
    ['/app?query-key-secret=query-value-secret#fragment-secret', true, { display: '/app?[redacted]', queryPresent: true }],
    ['https://example.test/app%3Fencoded', false, { display: 'https://example.test/app%3Fencoded', queryPresent: false }],
    ['javascript:query-value-secret', true, { display: null, queryPresent: false }],
    ['file:///private-path-secret?query-value-secret', false, { display: null, queryPresent: false }],
    ['/app\\private-path-secret?query-value-secret', true, { display: null, queryPresent: false }],
    ['not a URL?query-value-secret', false, { display: null, queryPresent: false }],
    [null, false, { display: null, queryPresent: false }],
  ]) await t.test(String(input), () => assert.deepEqual(browserBindingUrlView(input, { relative }), expected));
  assert.deepEqual(browserBindingUrlView('https://example.test/app?a=1&a=2'), browserBindingUrlView('https://example.test/app?b=other'));
});

test('summary and stored collection never access preview, source readers or source files', () => {
  const source = fixture(), binding = source.binding;
  const other = { ...binding, id: uid('ax', 8), projectId: uid('ap', 9) };
  Object.defineProperty(binding, 'preview', { enumerable: true, get() { throw new Error('preview read'); } });
  const catalog = { schemaVersion: 3, generationId, revision: 7,
    browserSourceBindings: { [bindingId]: binding, [uid('ax', 8)]: other } };
  const summary = browserBindingSummaryView(binding), list = browserBindingCollectionView(catalog, projectId);
  assert.deepEqual(list.bindings, [summary]); assert.equal(list.executionReady, false);
  assert.deepEqual(list.verification, { scope: 'stored-record-only', currentSourceVerified: false });
  assert.deepEqual(Object.keys(summary).sort(), ['actor', 'boundAt', 'id', 'projectId', 'projectionVersion', 'releaseId', 'source', 'sourceContentDigest']);
  assert.equal(Object.hasOwn(summary, 'sourcePlanDigest'), false); noSecrets(list);
});

test('display preview omits rules and private literals but preserves selected evidence, text and slot count meaning', () => {
  const source = fixture(), before = JSON.stringify(source.preview), preview = browserBindingPreviewView(deepFreeze(source.preview));
  noSecrets(preview); assert.equal(JSON.stringify(source.preview), before);
  assert.equal(preview.declaredSlots, 14); assert.equal(preview.projectedSlots, 14); assert.equal(preview.observations.length, 1);
  assert.equal(preview.sourceGate, 'failed'); assert.equal(preview.executionReady, false);
  assert.deepEqual(preview.presentation, { kind: 'organization-review', completeSourceProjection: false,
    omitted: ['raw-query', 'step-values', 'assertion-literals', 'rules'] });
  const observation = preview.observations[0];
  assert.equal(observation.title, '<img src=x onerror=alert(1)>');
  assert.equal(observation.expected.structure.title, '<script>not executable</script>');
  assert.equal(observation.expected.structure.controls[0].label, '<svg onload=alert(1)>');
  assert.equal(observation.expected.structure.controls[1].hrefDisplay, null);
  assert.equal(observation.expected.structure.controls[0].hrefDisplay, 'https://example.test/app?[redacted]');
  assert.equal(observation.slot.routeDisplay, '/app?[redacted]');
  assert.deepEqual(observation.expected.assertionSummary, { total: 1, passed: 1, checks: [{ kind: 'text', passed: true }] });
  for (const role of ['details', 'screenshot', 'repeat']) assert.deepEqual(observation.evidence[role],
    { file: evidence[role].file, bytes: 100, sha256: digest });
  observation.expected.structure.headings.push('view-local');
  assert.equal(source.preview.observations[0].expected.structure.headings.includes('view-local'), false);
});

test('mutation and read expose safe history and opaque digests without claiming execution or approval', () => {
  const source = fixture(), before = JSON.stringify(source), write = browserBindingMutationView(source), read = browserBindingReadView(source);
  noSecrets(write); noSecrets(read); assert.equal(JSON.stringify(source), before);
  assert.deepEqual(read.diagnostics, { eligible: true, contentMatches: true, issues: [] });
  assert.equal(write.viewVersion, 1); assert.equal(write.executionReady, false); assert.equal(read.executionReady, false);
  assert.equal(write.event.entityDigest, digest); assert.equal(write.event.kind, 'browser-source-bound');
  assert.equal(write.binding.sourceContentDigest, digest); assert.equal(write.binding.sourcePlanDigest, digest);
  assert.equal(write.binding.selectedEvidenceManifestDigest, digest); assert.equal(Object.hasOwn(read, 'event'), false);
  assert.deepEqual(write.preview, read.preview); assert.deepEqual(write.binding, read.binding);
  const changed = browserBindingReadView({ ...source, preview: null,
    diagnostics: { eligible: false, contentMatches: false, issues: [{ code: 'EACCES', message: url, path: 'private-path-secret' }] } });
  assert.equal(changed.preview, null); assert.deepEqual(changed.binding, read.binding);
  assert.deepEqual(changed.diagnostics, { eligible: false, contentMatches: false, issues: [{ code: 'BASELINE_CHANGED',
    message: '当前 Browser 所选来源无法重建已记录内容；历史归属保留，请检查原运行。' }] }); noSecrets(changed);
});

test('stored sorting is deterministic, project-scoped and does not mutate catalog records', () => {
  const first = fixture().binding, second = { ...first, id: uid('ax', 7) }, third = { ...first, id: uid('ax', 8), boundAt: '2026-10-17T01:00:00.000Z' };
  const catalog = deepFreeze({ browserSourceBindings: { first, third, second } }), before = JSON.stringify(catalog);
  assert.deepEqual(browserBindingSummariesOf(catalog, projectId).map(item => item.id), [third.id, second.id, first.id]);
  assert.deepEqual(browserBindingSummariesOf(catalog, uid('ap', 9)), []); assert.equal(JSON.stringify(catalog), before);
});

test('invalid evidence paths and event types fail closed without reflecting the supplied value', async t => {
  for (const file of ['../query-value-secret.png', 'https://example.test/query-value-secret.png', 'a%2fquery-value-secret.png', 'a\\query-value-secret.png']) {
    await t.test(file, () => { const source = fixture(); source.preview.observations[0].evidence.screenshot.file = file;
      assert.throws(() => browserBindingPreviewView(source.preview), error => !error.message.includes('query-value-secret')); });
  }
  const source = fixture(); source.event.kind = 'unexpected-secret';
  assert.throws(() => browserBindingMutationView(source), error => !error.message.includes('unexpected-secret'));
});
