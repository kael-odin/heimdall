import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { browserUrlDisplay, browserBindingRuns, buildBrowserBindingInput, browserBindingHistory,
  validateBrowserBindingSummary, browserBindingPreviewState, validateBrowserBindingWrite,
  createBrowserBindingReadGuard, browserEvidenceMetadata, browserEvidencePath,
  fetchBrowserBindingEvidence } from '../../console/src/acceptance-browser-bindings.js';

const id = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const projectId = id('ap', 1), releaseId = id('ar', 2), runId = id('ac', 3), bindingId = id('ax', 4);
const version = { generationId: id('ag', 5), revision: 12 }, digest = 'a'.repeat(64);
const cas = { expectedGenerationId: version.generationId, expectedRevision: version.revision };
const clone = value => JSON.parse(JSON.stringify(value));
const context = { projectId, bindingId, version };
const invalidResponse = error => error.code === 'INVALID_RESPONSE';
const metadata = (file, bytes = Buffer.from('saved evidence')) => ({ file, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') });
function previewResponse() {
  const source = { runId, sourceMode: 'mirror', side: 'baseline', entryUrlDisplay: 'https://example.test/start?[redacted]', queryPresent: true };
  const binding = { id: bindingId, projectId, releaseId, projectionVersion: 1, source, sourceContentDigest: digest,
    boundAt: '2026-10-17T04:00:00.000Z', actor: { kind: 'local-operator' } };
  for (const key of ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'selectedEvidenceManifestDigest',
    'scopeKey', 'ruleManifestKey', 'oracleManifestKey', 'environmentKey', 'verifierFingerprint']) binding[key] = digest;
  const observation = { slot: { routeDisplay: '/start?[redacted]', queryPresent: true, viewport: { width: 1440, height: 900 } },
    viewportName: 'desktop', title: '<img src=x onerror=alert(1)>', severity: 'high',
    plannedUrlDisplay: source.entryUrlDisplay, plannedQueryPresent: true,
    observedFinalUrlDisplay: 'https://example.test/final?[redacted]', observedFinalQueryPresent: true,
    finalUrlProof: 'redacted-observation-only', evidence: { details: metadata('page-baseline.json'),
      screenshot: metadata('page-baseline.png'), repeat: metadata('page-baseline-repeat.png') },
    expected: { httpStatus: 200, screenshotSha256: metadata('page-baseline.png').sha256,
      structure: { title: 'Page title', headings: ['Saved heading'], controls: [{ path: 'main > a', tag: 'a',
        role: null, label: '<script>untrusted</script>', type: null, disabled: false, expanded: null, selected: null,
        hrefDisplay: '/next?[redacted]', hrefQueryPresent: true }] },
      assertionSummary: { total: 1, passed: 1, checks: [{ kind: 'text', passed: true }] } },
    capture: { captureScope: 'full-page', captureLimited: false, documentSize: { width: 1440, height: 1200 } },
    mask: { maskedRatio: 0, effectiveAreaPx: 1296000, samplingCapped: false }, stability: 1 };
  return { viewVersion: 1, ...version, binding, executionReady: false,
    diagnostics: { eligible: true, contentMatches: true, issues: [] }, preview: { projectionVersion: 1, mode: 'browser',
      sourceReference: clone(source), name: 'Saved source', sourceStatus: 'completed', sourceGate: 'failed',
      declaredSlots: 14, projectedSlots: 14, observations: Array.from({ length: 4 }, () => clone(observation)),
      executionReady: false, oracleStorage: 'captured-side-evidence',
      environment: { platform: 'win32', arch: 'x64', nodeVersion: 'v22', browser: 'chromium', browserVersion: '130',
        playwrightVersion: '1', locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'dark', reducedMotion: 'reduce' },
      verifierFingerprint: digest, urlProof: { planned: 'server-verified-exact-entry; display-query-hidden',
        observedFinal: 'redacted-observation-only; no complete redirect-chain or final-query proof' },
      presentation: { kind: 'organization-review', completeSourceProjection: false,
        omitted: ['raw-query', 'step-values', 'assertion-literals', 'rules'] }, reviewNotice: '来源归属核对' } };
}
function writeResponse() {
  const value = previewResponse(); value.revision++;
  value.event = { id: id('ae', 6), revision: value.revision, projectId, entityId: bindingId,
    entityDigest: digest, at: value.binding.boundAt, kind: 'browser-source-bound', actor: { kind: 'local-operator' } };
  return value;
}
const input = () => ({ ...cas, runId, sourceSide: 'baseline', releaseId });
const fetchEvidence = (options = {}) => fetchBrowserBindingEvidence({ binding: previewResponse().binding,
  metadata: metadata('page-baseline.png'), role: 'screenshot', subtle: webcrypto.subtle,
  fetcher: async () => new Response(Buffer.from('saved evidence'), { headers: { 'content-type': 'image/png' } }), ...options });

test('URL labels omit credentials, fragment and the complete query without creating link targets', () => {
  assert.equal(browserUrlDisplay('https://user:password@example.test/path?secret=value#fragment'), 'https://example.test/path?[redacted]');
  assert.equal(browserUrlDisplay('/path?secret=value', { relative: true }), '/path?[redacted]');
  assert.equal(browserUrlDisplay('https://example.test/path?'), 'https://example.test/path?[redacted]');
  for (const value of [null, 'javascript:alert(1)', '/relative', 'https://example.test/ a', 'https://example.test/\\x']) {
    assert.equal(browserUrlDisplay(value), '无法显示');
  }
});

test('recent Browser choices include failed or blocked comparison gates but exclude incomplete and managed runs', () => {
  const rows = [
    { runId, mode: 'mirror', status: 'completed', gate: 'failed' },
    { runId: id('ac', 11), mode: 'regression', status: 'completed', gate: 'blocked' },
    { runId: id('ac', 12), mode: 'spec', status: 'completed' },
    { runId: id('ac', 13), mode: 'mirror', status: 'failed' },
    { runId: id('ac', 14), mode: 'mirror', status: 'completed', provenance: { kind: 'managed-spec' } },
  ];
  assert.deepEqual(browserBindingRuns(rows).map(value => value.runId), [runId, id('ac', 11)]);
  assert.deepEqual(browserBindingRuns(null), []);
});

test('binding input requires an explicit side and fresh confirmation and sends only three choices plus double CAS', () => {
  const draft = { runId, sourceSide: 'baseline', releaseId, confirmed: true, mode: 'spec', actor: 'admin', executionReady: true };
  assert.deepEqual(buildBrowserBindingInput(draft, version), input());
  assert.equal(buildBrowserBindingInput({ ...draft, sourceSide: 'target' }, version).sourceSide, 'target');
  for (const patch of [{ sourceSide: '' }, { sourceSide: 'source' }, { confirmed: false }, { confirmed: 'true' },
    { runId: '../run' }, { releaseId: id('ap', 2) }]) {
    assert.throws(() => buildBrowserBindingInput({ ...draft, ...patch }, version), error => error.code === 'INVALID_INPUT');
  }
});

test('stored history validates facts without claiming current source health or modifying records', () => {
  const binding = previewResponse().binding;
  const detail = { project: { id: projectId }, browserSourceBindings: [binding],
    browserSourceVerification: { scope: 'stored-record-only', currentSourceVerified: false } };
  const before = clone(detail); assert.deepEqual(browserBindingHistory(detail, projectId), [binding]); assert.deepEqual(detail, before);
  assert.throws(() => browserBindingHistory({ ...detail, browserSourceVerification: { scope: 'stored-record-only', currentSourceVerified: true } }, projectId), invalidResponse);
  assert.throws(() => browserBindingHistory(detail, id('ap', 99)), invalidResponse);
  assert.throws(() => browserBindingHistory({ ...detail, browserSourceBindings: [binding, binding] }, projectId), invalidResponse);
});

test('invalid timestamps and wrong project identities produce stable business errors', () => {
  for (const boundAt of ['not-a-date', '2026-13-40T00:00:00.000Z', '2026-10-17']) {
    assert.throws(() => validateBrowserBindingSummary({ ...previewResponse().binding, boundAt }, projectId), invalidResponse);
  }
  assert.throws(() => validateBrowserBindingSummary({ ...previewResponse().binding, projectId: id('ap', 99) }, projectId), invalidResponse);
});

test('four observations can represent fourteen verified slots and failed comparison gates remain reviewable', () => {
  const value = previewResponse(), before = clone(value), state = browserBindingPreviewState(value, context);
  assert.equal(state.preview.projectedSlots, 14); assert.equal(state.preview.observations.length, 4);
  assert.equal(state.preview.sourceGate, 'failed'); assert.deepEqual(value, before);
  value.preview.sourceGate = 'blocked'; assert.equal(browserBindingPreviewState(value, context).preview.sourceGate, 'blocked');
});

test('nullable display labels are display limitations and do not determine side eligibility', () => {
  const value = previewResponse();
  value.binding.source.entryUrlDisplay = value.preview.sourceReference.entryUrlDisplay = null;
  value.binding.source.queryPresent = value.preview.sourceReference.queryPresent = false;
  const observation = value.preview.observations[0];
  observation.slot.routeDisplay = observation.plannedUrlDisplay = observation.observedFinalUrlDisplay = null;
  observation.slot.queryPresent = observation.plannedQueryPresent = observation.observedFinalQueryPresent = false;
  observation.expected.structure.controls[0].hrefDisplay = null; observation.expected.structure.controls[0].hrefQueryPresent = false;
  assert.equal(browserBindingPreviewState(value, context).diagnostics.eligible, true);
  observation.observedFinalQueryPresent = true;
  assert.throws(() => browserBindingPreviewState(value, context), invalidResponse);
});

test('raw identity fields, unredacted URL values and unknown projection fields are rejected', () => {
  const changes = [value => { value.binding.source.entryUrl = 'https://example.test/?secret=value'; },
    value => { value.preview.targetUrl = 'https://example.test/'; },
    value => { value.preview.observations[0].plannedUrlDisplay = 'https://example.test/?secret=value'; },
    value => { value.preview.observations[0].expected.structure.controls[0].href = '/?secret=value'; },
    value => { value.preview.observations[0].rules = {}; }, value => { value.executionReady = true; }];
  for (const change of changes) { const value = previewResponse(); change(value); assert.throws(() => browserBindingPreviewState(value, context), invalidResponse); }
});

test('preview identities must match selected binding, project and source side regardless of field order', () => {
  for (const patch of [{ runId: id('ac', 99) }, { side: 'target' }, { sourceMode: 'regression' }]) {
    const value = previewResponse(); Object.assign(value.preview.sourceReference, patch);
    assert.throws(() => browserBindingPreviewState(value, context), invalidResponse);
  }
  assert.throws(() => browserBindingPreviewState(previewResponse(), { ...context, bindingId: id('ax', 99) }), invalidResponse);
  assert.throws(() => browserBindingPreviewState(previewResponse(), { ...context, projectId: id('ap', 99) }), invalidResponse);
  const value = previewResponse(); value.preview.sourceReference = Object.fromEntries(Object.entries(value.preview.sourceReference).reverse());
  assert.equal(browserBindingPreviewState(value, context).binding.id, bindingId);
});

test('slot completeness is checked separately from observation coverage and no partial contract is promoted', () => {
  for (const change of [value => { value.preview.projectedSlots = 13; }, value => { value.preview.observations = []; },
    value => { value.preview.presentation.completeSourceProjection = true; }, value => { value.preview.observations[0].capture.captureLimited = true; }]) {
    const value = previewResponse(); change(value); assert.throws(() => browserBindingPreviewState(value, context), invalidResponse);
  }
});

test('changed sources preserve stored binding facts with a null preview and explicit diagnostics', () => {
  const value = previewResponse(); value.preview = null;
  value.diagnostics = { eligible: false, contentMatches: false, issues: [{ code: 'BASELINE_CHANGED', message: '原归属记录保留。' }] };
  const state = browserBindingPreviewState(value, context); assert.equal(state.binding.id, bindingId); assert.equal(state.preview, null);
  value.diagnostics.contentMatches = true; assert.throws(() => browserBindingPreviewState(value, context), invalidResponse);
});

test('preview version mismatches require reconciliation instead of replacing the shared catalog version', () => {
  for (const patch of [{ revision: 11 }, { revision: 13 }, { generationId: id('ag', 99) }]) {
    const value = { ...previewResponse(), ...patch };
    assert.throws(() => browserBindingPreviewState(value, context), error => error.code === 'STALE_REVISION' && error.status === 409);
  }
});

test('a confirmed write returns the requested source, matching event and exactly one catalog revision', () => {
  const value = writeResponse(); assert.equal(validateBrowserBindingWrite(value, { projectId, body: input() }), value);
  const changes = [value => { value.revision++; }, value => { value.generationId = id('ag', 99); },
    value => { value.binding.releaseId = id('ar', 99); }, value => { value.binding.source.side = 'target'; },
    value => { value.event.kind = 'baseline-approved'; }, value => { value.event.projectId = id('ap', 99); },
    value => { value.event.entityId = id('ax', 99); }, value => { value.event.revision--; },
    value => { delete value.event; }, value => { value.preview = null; }];
  for (const change of changes) {
    const response = writeResponse(); change(response);
    assert.throws(() => validateBrowserBindingWrite(response, { projectId, body: input() }), error => error.writeMayHaveCommitted === true);
  }
});

test('read tickets reject late responses through A to B to A and every version or selection change', () => {
  const guard = createBrowserBindingReadGuard(), a = { ...version, projectId, bindingId, selectionEpoch: 1 };
  const old = guard.next(a); guard.next({ ...a, projectId: id('ap', 99), selectionEpoch: 2 });
  const nextA = { ...a, selectionEpoch: 3 }, current = guard.next(nextA);
  assert.equal(guard.accepts(old, nextA), false); assert.equal(guard.accepts(current, nextA), true);
  for (const patch of [{ projectId: id('ap', 99) }, { bindingId: id('ax', 99) }, { revision: 13 },
    { generationId: id('ag', 99) }, { selectionEpoch: 4 }]) assert.equal(guard.accepts(current, { ...nextA, ...patch }), false);
  guard.invalidate(); assert.equal(guard.accepts(current, nextA), false);
  const final = guard.next(nextA); guard.stop(); assert.equal(guard.accepts(final, nextA), false);
});

test('all three evidence roles use the bound run and selected side with a single local filename', () => {
  const binding = previewResponse().binding;
  for (const [role, file] of [['details', 'page-baseline.json'], ['screenshot', 'page-baseline.png'], ['repeat', 'page-baseline-repeat.png']]) {
    assert.equal(browserEvidencePath(binding, metadata(file), role), `/api/acceptance/runs/${runId}/evidence/${file}`);
  }
  for (const file of ['../page-baseline.png', 'sub/page-baseline.png', 'page-target.png', 'page..-baseline.png', 'https://example.test/page-baseline.png']) {
    assert.throws(() => browserEvidencePath(binding, metadata(file), 'screenshot'), invalidResponse);
  }
  assert.throws(() => browserEvidenceMetadata(metadata('page-baseline.png'), 'script', 'baseline'), invalidResponse);
  assert.throws(() => browserEvidenceMetadata({ ...metadata('page-baseline.png'), bytes: 65 * 1024 * 1024 }, 'screenshot', 'baseline'), invalidResponse);
});

test('verified evidence reads are authenticated local no-store requests and return a Blob only after hashing', async () => {
  let seen;
  const result = await fetchEvidence({ baseUrl: 'http://127.0.0.1:3000', headers: { 'x-local-token': 'test-token' },
    fetcher: async (url, options) => { seen = { url, options }; return new Response('saved evidence', { headers: { 'content-type': 'image/png; charset=binary' } }); } });
  assert.equal(result.blob.type, 'image/png'); assert.equal(await result.blob.text(), 'saved evidence'); assert.equal(result.content, '');
  assert.equal(seen.url, `http://127.0.0.1:3000/api/acceptance/runs/${runId}/evidence/page-baseline.png`);
  assert.deepEqual(seen.options.headers, { 'x-local-token': 'test-token' }); assert.equal(seen.options.cache, 'no-store');
  assert.equal(seen.options.credentials, 'omit'); assert.equal(seen.options.redirect, 'error');
});

test('raw details remain exact plain text after byte and SHA checks, including untrusted markup and queries', async () => {
  const bytes = Buffer.from('{"href":"/?secret=raw","title":"<script>alert(1)</script>"}');
  const result = await fetchEvidence({ role: 'details', metadata: metadata('page-baseline.json', bytes),
    fetcher: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.content, bytes.toString()); assert.equal(result.blob.type, 'application/json');
});

test('failed HTTP and incorrect MIME never produce evidence previews', async () => {
  for (const response of [new Response('saved evidence', { status: 404 }),
    new Response('saved evidence', { headers: { 'content-type': 'text/html' } })]) {
    await assert.rejects(fetchEvidence({ fetcher: async () => response }), error => error.code === 'EVIDENCE_UNAVAILABLE');
  }
});

test('short, oversized and same-length modified evidence bytes are rejected with fixed integrity errors', async () => {
  for (const bytes of [Buffer.from('short'), Buffer.from('saved evidence plus'), Buffer.from('taved evidence')]) {
    await assert.rejects(fetchEvidence({ fetcher: async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }) }),
      error => error.code === 'EVIDENCE_CHANGED' && error.message !== 'size');
  }
});

test('stream overflow is cancelled before hashing and reports the fixed business error', async () => {
  let cancelled = false, digested = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('saved evidence plus')); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchEvidence({ fetcher: async () => new Response(body, { headers: { 'content-type': 'image/png' } }),
    subtle: { async digest() { digested = true; return new ArrayBuffer(32); } } }), error => error.code === 'EVIDENCE_CHANGED');
  assert.equal(cancelled, true); assert.equal(digested, false);
});

test('missing WebCrypto blocks evidence before any fetch and aborts prevent returning a verified Blob', async () => {
  let fetched = false;
  await assert.rejects(fetchEvidence({ subtle: null, fetcher: async () => { fetched = true; } }), error => error.code === 'EVIDENCE_VERIFICATION_UNAVAILABLE');
  assert.equal(fetched, false);
  const controller = new AbortController();
  await assert.rejects(fetchEvidence({ signal: controller.signal, subtle: { async digest(...args) {
    const hash = await webcrypto.subtle.digest(...args); controller.abort(); return hash;
  } } }), error => error.name === 'AbortError');
});
