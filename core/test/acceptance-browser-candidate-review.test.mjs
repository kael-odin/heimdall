/** Pure review tests use frozen captured bytes, never a Browser, runner or live URL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrowserCandidateReview, assertBrowserCandidateEnvelope,
  browserCandidateCollectionView, browserCandidateSupportOf } from '../src/acceptance/browser-candidate-review.mjs';
import { projectBrowserBaselineCandidate, verifyBrowserBaselineMaterial,
  BROWSER_CANDIDATE_LIMITS_V1 } from '../src/acceptance/browser-candidate-projection.mjs';
import { browserBindingReadView } from '../src/acceptance/browser-binding-view.mjs';
import { browserBindingProjectionOf, AcceptanceCatalogError } from '../src/acceptance/catalog-schema.mjs';
import { buildAcceptanceIdentity } from '../src/acceptance/identity.mjs';
import { AT, uid, copy, canonical, independentHash, organizedHash, metadataFixture } from './fixtures/acceptance-browser-organized-candidate.mjs';

const ROOT = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const refs = report => [...new Set(report.checks.flatMap(check => Object.values(check.evidence)).filter(value => value !== null))];
const sourceHash = (kind, value) => independentHash({ projectionVersion: 1, canonicalJsonVersion: 'acceptance-json-v1',
  digestAlgorithm: 'sha256', domain: 'heimdall-acceptance-browser-candidate', kind, value });
const sources = new Map();
async function load(id = 'matrix') {
  if (!sources.has(id)) sources.set(id, (async () => {
    const dir = join(ROOT, id), [manifest, report, integrity] = await Promise.all(['manifest.json', 'report.json', 'integrity.json']
      .map(async name => JSON.parse(await readFile(join(dir, name)))));
    const files = new Map(await Promise.all(['manifest.json', 'report.json', ...refs(report)]
      .map(async name => [name, await readFile(join(dir, name))])));
    return { snapshot: { manifest, report, integrity }, files };
  })());
  return sources.get(id);
}
function context(material, side = 'baseline', projection) {
  projection ??= projectBrowserBaselineCandidate(material, { sourceSide: side }).projection;
  const project = { id: uid('ap', 101), name: '完整复核 <script>fixture</script>', createdAt: AT };
  const release = { id: uid('ar', 102), projectId: project.id, label: '声明来源', targetUrl: material.snapshot.manifest.plan[side + 'Url'],
    buildRef: 'full-review-fixture', createdAt: AT };
  const { mode: _mode, contentDigest: sourceContentDigest, ...sourceProjection } = projection;
  const sourceBinding = { id: uid('ax', 103), projectId: project.id, releaseId: release.id, ...copy(sourceProjection),
    sourceContentDigest, boundAt: AT, actor: { kind: 'local-operator' } };
  sourceBinding.source = { ...sourceBinding.source, runId: material.snapshot.manifest.runId, side,
    sourceMode: material.snapshot.manifest.mode, entryUrl: release.targetUrl };
  return { project, release, sourceBinding, material };
}
const snapshot = material => ({ snapshot: copy(material.snapshot), files: [...material.files].map(([file, data]) => [file, data.length, sha(data)]) });
const cloneMaterial = material => ({ snapshot: copy(material.snapshot), files: new Map([...material.files].map(([name, data]) => [name, Buffer.from(data)])) });
function reseal(material) {
  const { manifest, report } = material.snapshot, names = refs(report);
  for (const entry of report.evidenceManifest) if (names.includes(entry.file)) {
    const data = material.files.get(entry.file); entry.bytes = data.length; entry.sha256 = sha(data);
  }
  material.files.set('report.json', bytes(report));
  manifest.reportSha256 = sha(material.files.get('report.json'));
  material.files.set('manifest.json', bytes(manifest));
  material.snapshot.integrity = { valid: true, evidenceVerified: true, errors: [], verifiedFiles: names.length,
    verifiedBytes: names.reduce((sum, name) => sum + material.files.get(name).length, 0), reportSha256: manifest.reportSha256 };
}
const changed = cause => cause instanceof AcceptanceCatalogError && cause.code === 'BASELINE_CHANGED' && cause.status === 409;
const budget = cause => cause instanceof AcceptanceCatalogError && cause.code === 'SOURCE_NOT_ELIGIBLE'
  && cause.status === 409 && cause.details?.reason === 'BROWSER_REVIEW_BUDGET';

test('private manifests retain all independently hashed components without expanding the public projector', async () => {
  const material = await load(), before = snapshot(material);
  for (const side of ['baseline', 'target']) {
    const result = verifyBrowserBaselineMaterial(material, { sourceSide: side });
    const publicView = projectBrowserBaselineCandidate(material, { sourceSide: side });
    assert.deepEqual(Object.keys(publicView).sort(), ['preview', 'projection']);
    assert.deepEqual(publicView, { projection: result.projection, preview: result.preview });
    const { manifests, projection } = result;
    assert.deepEqual(Object.keys(manifests).sort(), ['rules', 'scope', 'selectedEvidence', 'selectedOracles', 'verifiedEvidence']);
    for (const [field, kind, value] of [
      ['scopeKey', 'scope', manifests.scope], ['ruleManifestKey', 'rules', manifests.rules],
      ['oracleManifestKey', 'oracle', manifests.selectedOracles],
      ['selectedEvidenceManifestDigest', 'selected-evidence', manifests.selectedEvidence],
      ['evidenceManifestDigest', 'verified-evidence', manifests.verifiedEvidence],
    ]) assert.equal(projection[field], sourceHash(kind, value), side + '.' + field);
    assert.equal(manifests.scope.length, 28);
    assert.equal(manifests.rules.length, 28);
    assert.equal(manifests.selectedOracles.length, 8);
    assert.equal(manifests.selectedEvidence.length, 8);
    assert.deepEqual(manifests.verifiedEvidence.map(value => value.file), refs(material.snapshot.report).sort());
    const timeout = result.preview.rules[0].rule.timeoutMs;
    manifests.rules[0].rule.timeoutMs = -1;
    manifests.selectedOracles[0].oracle.structure.title = 'changed returned manifest';
    assert.equal(result.preview.rules[0].rule.timeoutMs, timeout, 'private manifests must not alias preview');
    assert.notEqual(result.preview.observations[0].expected.structure.title, 'changed returned manifest');
  }
  assert.deepEqual(snapshot(material), before);
});

test('all four frozen fixtures and both explicit sides preserve the existing eligibility decision', async t => {
  const fallback = projectBrowserBaselineCandidate(await load(), { sourceSide: 'baseline' }).projection;
  for (const [name, eligibleSides] of [['matrix', ['baseline', 'target']], ['target-unavailable', ['baseline']],
    ['baseline-unavailable', ['target']], ['assertion-failed', []]]) {
    for (const side of ['baseline', 'target']) await t.test(name + '/' + side, async () => {
      const material = await load(name), before = snapshot(material);
      if (eligibleSides.includes(side)) {
        const input = context(material, side), result = buildBrowserCandidateReview(input);
        assert.deepEqual(result.sourceProjection, browserBindingProjectionOf(input.sourceBinding));
        assert.equal(result.review.sourceGate, material.snapshot.report.gate);
        assert.equal(result.sourceProjection.source.side, side);
        assert.equal(result.executionReady, false);
      } else {
        assert.throws(() => buildBrowserCandidateReview(context(material, side, fallback)), cause => cause.status === 409
          && ['SOURCE_NOT_ELIGIBLE', 'SOURCE_INTEGRITY_FAILED'].includes(cause.code));
      }
      assert.deepEqual(snapshot(material), before);
    });
  }
});

test('complete target review contains all raw plan/rules/oracles while C remains an incomplete display DTO', async () => {
  const material = await load(), input = context(material, 'target'), result = buildBrowserCandidateReview(input);
  assert.deepEqual(Object.keys(result).sort(), ['viewVersion', 'candidateContractVersion', 'schemaVersion', 'candidateContent',
    'contentDigest', 'organizationContext', 'organizationContextDigest', 'sourceProjection', 'review', 'completeness',
    'presentation', 'diagnostics', 'executionReady'].sort());
  for (const name of ['generationId', 'revision', 'candidate', 'event']) assert.equal(Object.hasOwn(result, name), false);
  assert.deepEqual(result.organizationContext, { project: input.project, release: input.release, sourceBinding: input.sourceBinding });
  assert.equal(result.organizationContextDigest, organizedHash('organization-context', result.organizationContext));
  assert.equal(result.contentDigest, organizedHash('content', result.candidateContent));
  assert.deepEqual(result.candidateContent, { candidateContractVersion: 1, mode: 'browser', projectId: input.project.id,
    releaseId: input.release.id, sourceBindingId: input.sourceBinding.id, sourceContentDigest: input.sourceBinding.sourceContentDigest,
    organizationContextDigest: result.organizationContextDigest });
  assert.deepEqual(result.review.sourcePlan, material.snapshot.manifest.plan);
  assert.equal(result.review.sourcePlan.routes[0], '/visual-shift?revision=one');
  assert.equal(result.review.scope.length, result.review.declaredSlots);
  assert.equal(result.review.rules.length, result.review.projectedSlots);
  assert.deepEqual(result.review.omissions, []);
  assert.equal(result.review.oracleStorage, 'captured-side-evidence');
  assert.equal(result.review.verifiedEvidence.length, material.snapshot.integrity.verifiedFiles);
  const plan = result.review.sourcePlan;
  for (const point of plan.points) {
    const rules = result.review.rules.filter(row => row.slot.pointId === point.id);
    assert.equal(rules.length, plan.viewports.length);
    for (const row of rules) {
      assert.deepEqual(row.rule.steps, point.steps);
      assert.deepEqual(row.rule.assertions, point.assertions);
      assert.equal(row.rule.assertions[1].equals, 'true');
    }
  }
  const expectedOracles = material.snapshot.report.checks.filter(check => ['visual', 'behavior'].includes(check.identity.facet)).map(check => {
    const viewport = plan.viewports.find(value => value.name === check.viewport);
    const point = plan.points.find(value => value.id === check.identity.pointId);
    const detail = JSON.parse(material.files.get(check.evidence.targetDetails));
    return { slot: { route: check.route, viewport: { width: viewport.width, height: viewport.height }, ...(point ? { pointId: point.id } : {}) },
      oracle: { kind: 'captured-browser-side', entryUrl: plan.targetUrl, httpStatus: detail.httpStatus,
        structure: { title: detail.snapshot.title, headings: detail.snapshot.headings, controls: detail.snapshot.controls },
        screenshotSha256: sha(material.files.get(detail.screenshot)),
        ...(point ? { steps: point.steps, assertions: point.assertions, observedAssertions: detail.assertions } : {}) } };
  }).sort((a, b) => canonical(a.slot) < canonical(b.slot) ? -1 : canonical(a.slot) > canonical(b.slot) ? 1 : 0);
  assert.deepEqual(result.review.selectedOracles, expectedOracles);
  assert.equal(sourceHash('oracle', expectedOracles), 'a8ca1887fecfc0e5ac6e7eb00b64f6005c17f413c9945ad6243a6cab462a4842');
  assert.equal(result.completeness.rawArtifactsEmbedded, false);
  assert.equal(result.presentation.completeSourceProjection, true);
  assert.match(result.review.urlProof.observedFinal, /redacted/);
  assert.equal(result.review.limitations.length, 1);
  const oldPreview = projectBrowserBaselineCandidate(material, { sourceSide: 'target' }).preview;
  const cView = browserBindingReadView({ generationId: uid('ag', 10), revision: 3, binding: input.sourceBinding,
    preview: oldPreview, diagnostics: result.diagnostics, executionReady: false });
  assert.equal(cView.preview.presentation.completeSourceProjection, false);
  assert.equal(JSON.stringify(cView).includes('revision=one'), false);
  assert.equal(Object.hasOwn(cView.preview, 'rules'), false);
});

test('full review preserves fill values and raw assertion literals from coherently captured plan data', async () => {
  const material = cloneMaterial(await load()), plan = material.snapshot.manifest.plan;
  const old = projectBrowserBaselineCandidate(material, { sourceSide: 'baseline' }).preview;
  const point = plan.points[0], value = '  fixture-secret <script>value</script> 中文  ';
  point.steps.push({ action: 'fill', selector: '#fixture-input', value });
  for (const check of material.snapshot.report.checks.filter(check => check.identity.pointId === point.id)) {
    const viewport = plan.viewports.find(value => value.name === check.viewport);
    const rule = copy(old.rules.find(row => row.slot.pointId === point.id && row.slot.viewport.width === viewport.width).rule);
    rule.steps = copy(point.steps);
    check.identity = buildAcceptanceIdentity({ kind: 'browser', facet: 'behavior', route: point.route,
      viewport: { width: viewport.width, height: viewport.height }, pointId: point.id,
      environment: material.snapshot.report.environment, rule, oracle: { kind: 'runtime', source: plan.baselineUrl, expected: check.expected } });
    check.reproduction = [...check.reproduction.slice(0, 2), ...point.steps.map(step =>
      `${step.action} ${step.selector}${step.value !== undefined ? ` (${String(step.value).slice(0, 120)})` : ''}`)];
  }
  material.snapshot.report.planFingerprint = sha(JSON.stringify(plan)); reseal(material);
  const result = buildBrowserCandidateReview(context(material, 'target'));
  assert.equal(result.review.sourcePlan.points[0].steps.at(-1).value, value);
  for (const row of result.review.rules.filter(row => row.slot.pointId === point.id)) assert.equal(row.rule.steps.at(-1).value, value);
  for (const row of result.review.selectedOracles.filter(row => row.slot.pointId === point.id)) {
    assert.equal(row.oracle.steps.at(-1).value, value);
    assert.equal(row.oracle.assertions[1].equals, 'true');
  }
  assert.equal(result.review.sourceGate, 'failed', 'coherent fixture reseal is not a successful live execution claim');
});

test('saved-plan key order remains the legacy byte fingerprint rather than a canonical replacement', async () => {
  const material = cloneMaterial(await load('target-unavailable'));
  material.snapshot.manifest.plan = Object.fromEntries(Object.entries(material.snapshot.manifest.plan).reverse());
  material.snapshot.report.planFingerprint = sha(JSON.stringify(material.snapshot.manifest.plan)); reseal(material);
  const input = context(material), result = buildBrowserCandidateReview(input);
  assert.deepEqual(Object.keys(result.review.sourcePlan), Object.keys(material.snapshot.manifest.plan));
  assert.equal(sha(JSON.stringify(result.review.sourcePlan)), result.sourceProjection.sourcePlanDigest);
  assert.notEqual(independentHash(result.review.sourcePlan), result.sourceProjection.sourcePlanDigest);
});

test('all source projection components and exact ordered entry URL must match the stored ax', async () => {
  const material = await load('target-unavailable'), base = context(material);
  for (const name of ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'selectedEvidenceManifestDigest',
    'scopeKey', 'ruleManifestKey', 'oracleManifestKey', 'environmentKey', 'verifierFingerprint', 'sourceContentDigest']) {
    const input = { ...base, sourceBinding: copy(base.sourceBinding) };
    input.sourceBinding[name] = 'f'.repeat(64);
    assert.throws(() => buildBrowserCandidateReview(input), changed, name);
  }
  for (const tail of ['?x=1&x=2', '?x=2&x=1']) {
    const input = { ...base, release: copy(base.release), sourceBinding: copy(base.sourceBinding) };
    input.release.targetUrl += tail; input.sourceBinding.source.entryUrl += tail;
    assert.throws(() => buildBrowserCandidateReview(input), changed);
  }
});

test('complete project/release/ax context is independently bound, including buildRef absence', async () => {
  const material = await load('target-unavailable'), base = context(material), initial = buildBrowserCandidateReview(base);
  for (const [object, key, value] of [['project', 'name', 'renamed project'], ['release', 'buildRef', undefined],
    ['sourceBinding', 'boundAt', '2026-10-17T00:00:02.000Z']]) {
    const input = { ...base, [object]: copy(base[object]) };
    if (value === undefined) delete input[object][key]; else input[object][key] = value;
    const result = buildBrowserCandidateReview(input);
    assert.deepEqual(result.sourceProjection, initial.sourceProjection);
    assert.notEqual(result.organizationContextDigest, initial.organizationContextDigest);
    assert.notEqual(result.contentDigest, initial.contentDigest);
  }
  const mismatched = { ...base, release: { ...base.release, projectId: uid('ap', 909) } };
  assert.throws(() => buildBrowserCandidateReview(mismatched), changed);
  const extra = { ...base, sourceBinding: { ...base.sourceBinding, draft: true } };
  assert.throws(() => buildBrowserCandidateReview(extra), changed);
  let called = false;
  const hostile = { ...base, project: { ...base.project } };
  Object.defineProperty(hostile.project, 'name', { enumerable: true, get() { called = true; throw new Error('getter must not run'); } });
  assert.throws(() => buildBrowserCandidateReview(hostile), changed); assert.equal(called, false);
  const coercion = { ...base, sourceBinding: { ...base.sourceBinding, sourceContentDigest: { toString() { called = true; return 'a'.repeat(64); } } } };
  assert.throws(() => buildBrowserCandidateReview(coercion), changed); assert.equal(called, false);
  assert.throws(() => buildBrowserCandidateReview(new Proxy(base, { get() { throw new Error('proxy must not run'); } })), changed);
});

test('entire envelopes enforce exact UTF-8 byte boundaries without trimming review fields', async () => {
  const material = await load('target-unavailable'), input = context(material), result = buildBrowserCandidateReview(input);
  const exact = Buffer.byteLength(JSON.stringify(result));
  assert.equal(assertBrowserCandidateEnvelope(result, { maxBytes: exact }), result);
  assert.throws(() => assertBrowserCandidateEnvelope(result, { maxBytes: exact - 1 }), budget);
  assert.throws(() => buildBrowserCandidateReview(input, { maxBytes: exact - 1 }), budget);
  assert.deepEqual(buildBrowserCandidateReview(input, { maxBytes: exact }), result);
  const envelope = { ...result, generationId: uid('ag', 10), revision: 4, candidate: metadataFixture().candidate,
    event: { id: uid('ae', 104), revision: 4, actor: { kind: 'local-operator' } } };
  assert.throws(() => assertBrowserCandidateEnvelope(envelope, { maxBytes: exact }), budget, 'lineage/candidate/event also consume the response budget');
  const utf8 = { text: '中文🙂' }, size = Buffer.byteLength(JSON.stringify(utf8));
  assert.equal(assertBrowserCandidateEnvelope(utf8, { maxBytes: size }), utf8);
  assert.throws(() => assertBrowserCandidateEnvelope(utf8, { maxBytes: size - 1 }), budget);
  for (const maxBytes of [-1, 1.5, NaN, Infinity, '12', 12 * 1024 * 1024 + 1]) assert.throws(() => assertBrowserCandidateEnvelope({}, { maxBytes }), budget);
});

test('envelope budgets reject active data and excessive JSON depth without invoking hooks', () => {
  let invoked = false;
  const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get() { invoked = true; return 1; } });
  const proxy = new Proxy({}, { ownKeys() { invoked = true; throw new Error('proxy must not run'); } });
  const cycle = {}; cycle.next = cycle;
  const sparse = []; sparse.length = 2;
  const hidden = {}; Object.defineProperty(hidden, 'x', { value: 1 });
  const toJSON = { toJSON() { invoked = true; return {}; } };
  let deep = {}, cursor = deep;
  for (let n = 0; n <= BROWSER_CANDIDATE_LIMITS_V1.jsonDepth; n++) cursor = cursor.next = {};
  for (const value of [getter, proxy, cycle, sparse, hidden, toJSON, Buffer.from('{}'), { x: undefined },
    { [Symbol('x')]: true }, { x: Infinity }, deep]) assert.throws(() => assertBrowserCandidateEnvelope(value), budget);
  assert.equal(invoked, false);
});

test('stored collection copies only strict eleven-field bc metadata without inspecting source or URL fields', () => {
  const fixture = metadataFixture(), { catalog, project, candidate } = fixture;
  const before = copy(catalog); let touched = false;
  for (const key of ['browserSourceBindings', 'releases', 'runBindings']) Object.defineProperty(catalog, key,
    { enumerable: true, get() { touched = true; throw new Error('stored list must not touch source or URLs'); } });
  const result = browserCandidateCollectionView(catalog, project.id);
  assert.deepEqual(result.browserCandidates, [candidate]);
  assert.equal(Object.keys(result.browserCandidates[0]).length, 11);
  assert.deepEqual(result.verification, { scope: 'stored-candidate-metadata', currentSourceVerified: false });
  assert.deepEqual(result.browserCandidateSupport, { available: true, requiredSchemaVersion: 4 });
  assert.equal(result.executionReady, false); assert.equal(touched, false);
  assert.equal(JSON.stringify(result).includes('fixture-value'), false);
  result.browserCandidates[0].actor.kind = 'changed copy';
  assert.equal(candidate.actor.kind, 'local-operator');
  assert.deepEqual(catalog.browserCandidates, before.browserCandidates);
  const v3 = metadataFixture({ version: 3, candidate: false });
  assert.deepEqual(browserCandidateSupportOf(v3.catalog), { available: false, requiredSchemaVersion: 4 });
  assert.deepEqual(browserCandidateCollectionView(v3.catalog, v3.project.id).browserCandidates, []);
  assert.throws(() => browserCandidateCollectionView(catalog, uid('ap', 707)), { code: 'NOT_FOUND', status: 404 });
});

test('stored summaries reject malformed records and accessor maps instead of laundering them into safe-looking metadata', () => {
  const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };
  for (const mutate of [candidate => { candidate.extra = 'hidden raw URL'; }, candidate => { delete candidate.actor; },
    candidate => { candidate.mode = 'spec'; }, candidate => { candidate.contentDigest = 'a'.repeat(64); },
    candidate => { candidate.sourceBindingId = uid('ab', 1); }, candidate => { candidate.actor.extra = true; }]) {
    const f = metadataFixture(); mutate(f.candidate);
    assert.throws(() => browserCandidateCollectionView(f.catalog, f.project.id), unavailable);
  }
  let called = false;
  const f = metadataFixture(); Object.defineProperty(f.catalog.browserCandidates, f.candidate.id,
    { enumerable: true, get() { called = true; throw new Error('getter must not run'); } });
  assert.throws(() => browserCandidateCollectionView(f.catalog, f.project.id), unavailable); assert.equal(called, false);
});

test('review and stored views perform zero filesystem or live-target operations', async () => {
  const material = await load('target-unavailable'), input = context(material), fixture = metadataFixture(), before = snapshot(material);
  const originals = [], calls = [], originalFetch = globalThis.fetch;
  for (const [object, names] of [[fs, ['readFileSync', 'writeFileSync', 'openSync', 'statSync', 'readdirSync', 'mkdirSync', 'renameSync', 'unlinkSync']],
    [fsPromises, ['readFile', 'writeFile', 'open', 'stat', 'readdir', 'mkdir', 'rename', 'unlink']]]) {
    for (const name of names) { originals.push([object, name, object[name]]); object[name] = () => { calls.push(name); throw new Error('unexpected I/O'); }; }
  }
  globalThis.fetch = () => { calls.push('fetch'); throw new Error('unexpected live-target request'); }; syncBuiltinESMExports();
  try {
    assert.equal(buildBrowserCandidateReview(input).executionReady, false);
    assert.equal(browserCandidateCollectionView(fixture.catalog, fixture.project.id).browserCandidates.length, 1);
    assert.deepEqual(calls, []);
  } finally {
    for (const [object, name, value] of originals) object[name] = value;
    globalThis.fetch = originalFetch; syncBuiltinESMExports();
  }
  assert.deepEqual(snapshot(material), before);
});
