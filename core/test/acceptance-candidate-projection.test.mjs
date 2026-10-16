import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectSpecBaselineCandidate, SPEC_CANDIDATE_LIMITS_V1, SUPPORTED_SPEC_VERIFIERS_V1 } from '../src/acceptance/candidate-projection.mjs';
import { AcceptanceCatalogError, candidateProjectionOf } from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { createAcceptanceRun, finishAcceptanceRun, readAcceptanceSnapshot, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { previewOpenApi } from '../src/acceptance/openapi.mjs';
import { startAcceptanceApiFixture } from './fixtures/acceptance-api.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const options = () => ({ projectId: 'ap-' + randomUUID(), releaseId: 'ar-' + randomUUID(), sourceSide: 'source' });
const contract = (overrides = {}) => ({ id: 'code', title: '业务状态必须为零', method: 'GET', path: '/healthy', severity: 'high',
  expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }],
    schema: { type: 'object', required: ['code'], properties: { code: { type: 'integer' } } } }, ...overrides });
const manualPlan = (overrides = {}, spec = {}) => normalizeSpecPlan({ name: '候选合同投影', mode: 'spec',
  targetUrl: 'http://127.0.0.1:1/not-requested?release=one', timeoutMs: 1000,
  spec: { source: { id: 'REQ-CODE', revision: 'v1', type: 'manual', title: '业务接口需求' },
    approved: false, checks: [contract()], ...spec }, ...overrides });

async function materialize(t, plan = manualPlan()) {
  const root = await mkdtemp(join(tmpdir(), 'heimdall-candidate-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = createAcceptanceRun(plan, { root });
  const dir = acceptanceRunDir(run.runId, root);
  const report = await runSpecAcceptance(plan, { runId: run.runId, outputDir: dir });
  finishAcceptanceRun(run.runId, report, { root });
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.valid, true);
  const names = new Set(['manifest.json', 'report.json', ...snapshot.report.checks.flatMap(check => Object.values(check.evidence))]);
  const files = new Map(await Promise.all([...names].map(async file => [file, await readFile(join(dir, file))])));
  return { snapshot, files, root, dir };
}
function cloneSource(source) {
  return { snapshot: copy(source.snapshot), files: new Map([...source.files].map(([file, data]) => [file, Buffer.from(data)])) };
}
function seal(source) {
  const { manifest, report } = source.snapshot;
  const names = new Set(report.checks.flatMap(check => Object.values(check.evidence)));
  for (const entry of report.evidenceManifest) if (names.has(entry.file) && source.files.has(entry.file)) {
    const data = source.files.get(entry.file); entry.bytes = data.length; entry.sha256 = sha(data);
  }
  const normalized = summarizeAcceptanceReport(report);
  report.summary = normalized.summary; report.gate = normalized.gate;
  manifest.summary = copy(report.summary); manifest.gate = report.gate;
  source.files.set('report.json', bytes(report));
  manifest.reportSha256 = sha(source.files.get('report.json'));
  source.files.set('manifest.json', bytes(manifest));
  const indexed = new Map(report.evidenceManifest.map(entry => [entry.file, entry]));
  source.snapshot.integrity = { valid: true, evidenceVerified: true, errors: [], verifiedFiles: names.size,
    verifiedBytes: [...names].reduce((sum, file) => sum + (indexed.get(file)?.bytes ?? 0), 0), reportSha256: manifest.reportSha256 };
  return source;
}
function project(source, context = options()) {
  return projectSpecBaselineCandidate({ snapshot: source.snapshot, files: source.files }, context);
}
function rejects(source, reason, context = options()) {
  assert.throws(() => project(source, context), error => error instanceof AcceptanceCatalogError && error.status === 409
    && ['SOURCE_NOT_ELIGIBLE', 'SOURCE_INTEGRITY_FAILED'].includes(error.code) && error.details?.reason === reason,
  reason);
}

test('complete unapproved Spec projects full human-reviewable contracts without making requests or approvals', async t => {
  const fixture = await startAcceptanceApiFixture(); t.after(() => fixture.close());
  const source = await materialize(t, manualPlan({ targetUrl: fixture.targetUrl }));
  const before = bytes(source.snapshot), beforeFiles = [...source.files].map(([file, data]) => [file, sha(data)]);
  const context = options(), result = project(source, context), repeated = project(source, context);
  assert.deepEqual(result, repeated);
  assert.equal(fixture.requests.length, 0);
  assert.equal(result.preview.sourceStatus, 'completed');
  assert.equal(result.preview.sourceGate, 'blocked');
  assert.equal(result.preview.sourceSpecApproved, false);
  assert.equal(result.preview.executionReady, false);
  assert.equal(result.preview.declaredSlots, 1); assert.equal(result.preview.projectedSlots, 1);
  assert.deepEqual(result.preview.omissions, []);
  assert.deepEqual(result.preview.source, source.snapshot.manifest.plan.spec.source);
  assert.deepEqual(result.preview.checks[0].expect, source.snapshot.manifest.plan.spec.checks[0].expect);
  assert.deepEqual(result.preview.checks[0].identity, source.snapshot.report.checks[0].identity);
  assert.equal(result.preview.checks[0].rule.redirect, 'manual');
  assert.equal(result.preview.checks[0].rule.responseSchemaLimits.validationSteps, 100000);
  assert.equal(result.projection.source.side, 'source');
  assert.equal(result.projection.source.releaseId, context.releaseId);
  assert.equal(result.projection.projectId, context.projectId);
  const { contentDigest, ...content } = result.projection;
  assert.equal(hashAcceptanceValue(content), contentDigest);
  assert.deepEqual(Object.keys(result.projection).sort(), ['projectionVersion', 'projectId', 'mode', 'source', 'sourcePlanDigest',
    'sourceReportDigest', 'evidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey', 'environmentKey',
    'verifierFingerprint', 'contentDigest'].sort());
  assert.equal(JSON.stringify(result.projection).includes('业务接口需求'), false);
  assert.equal(JSON.stringify(result.projection).includes('expect'), false);
  assert.deepEqual(bytes(source.snapshot), before);
  assert.deepEqual([...source.files].map(([file, data]) => [file, sha(data)]), beforeFiles);
  result.preview.checks[0].expect.status = 500;
  assert.equal(source.snapshot.manifest.plan.spec.checks[0].expect.status, 200);
});

test('failed target and limited transport remain eligible; actual/response values never become oracle', async t => {
  const fixture = await startAcceptanceApiFixture(); t.after(() => fixture.close());
  const source = await materialize(t, manualPlan({ targetUrl: fixture.targetUrl }, { approved: true, checks: [contract({ path: '/wrong-code' })] }));
  assert.equal(source.snapshot.report.gate, 'failed');
  const context = options(), initial = project(source, context), requestCount = fixture.requests.length;
  assert.equal(initial.preview.checks[0].expect.json[0].value, 0);
  const changed = cloneSource(source), reportCheck = changed.snapshot.report.checks[0];
  reportCheck.actual = { requested: true, forgedActual: 'must not become an expectation' };
  changed.files.set(reportCheck.evidence.response, bytes({ body: { code: 999, injectedOracle: true } }));
  seal(changed);
  const second = project(changed, context);
  assert.equal(second.projection.oracleManifestKey, initial.projection.oracleManifestKey);
  assert.equal(second.projection.ruleManifestKey, initial.projection.ruleManifestKey);
  assert.notEqual(second.projection.sourceReportDigest, initial.projection.sourceReportDigest);
  assert.notEqual(second.projection.evidenceManifestDigest, initial.projection.evidenceManifestDigest);
  assert.notEqual(second.projection.contentDigest, initial.projection.contentDigest);
  assert.equal(fixture.requests.length, requestCount);
  const limited = await materialize(t, manualPlan({ targetUrl: fixture.targetUrl, maxResponseBytes: 1024 },
    { approved: true, checks: [contract({ path: '/oversized' })] }));
  assert.equal(limited.snapshot.report.gate, 'blocked');
  assert.equal(project(limited).preview.sourceSpecApproved, true);
});

test('OpenAPI source document is required, current and exactly tied to the normalized contract', async t => {
  const document = { openapi: '3.1.1', info: { title: '源文档', version: '1.0.0' }, paths: {
    '/healthy': { get: { responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } } } } };
  const { plan } = previewOpenApi(document, { targetUrl: 'http://127.0.0.1:1/' });
  const source = await materialize(t, plan);
  assert.equal(project(source).preview.source.type, 'openapi');
  const missing = cloneSource(source);
  delete missing.snapshot.report.checks[0].evidence.source;
  seal(missing);
  rejects(missing, 'SOURCE_REQUIREMENT_EVIDENCE_MISSING');
  const changed = cloneSource(source), evidence = JSON.parse(changed.files.get('requirement-source.json'));
  evidence.document.info.version = '2.0.0'; changed.files.set('requirement-source.json', bytes(evidence)); seal(changed);
  rejects(changed, 'SOURCE_REQUIREMENT_EVIDENCE_MISMATCH');
});

test('extra unreferenced evidence index is not hashed as verified evidence', async t => {
  const source = await materialize(t), context = options(), initial = project(source, context);
  const extra = cloneSource(source);
  extra.snapshot.report.evidenceManifest.push({ file: 'unread-extra.json', bytes: 999, sha256: 'a'.repeat(64) });
  seal(extra);
  const result = project(extra, context);
  assert.equal(result.projection.evidenceManifestDigest, initial.projection.evidenceManifestDigest);
  assert.equal(result.projection.oracleManifestKey, initial.projection.oracleManifestKey);
  assert.notEqual(result.projection.sourceReportDigest, initial.projection.sourceReportDigest);
});

test('raw report/manifest and every referenced evidence are independently revalidated', async t => {
  const source = await materialize(t);
  const cases = [
    ['SOURCE_FILE_MISSING', changed => changed.files.delete('manifest.json')],
    ['SOURCE_FILE_MISSING', changed => changed.files.delete(changed.snapshot.report.checks[0].evidence.contract)],
    ['SOURCE_SNAPSHOT_BYTES_MISMATCH', changed => { const report = copy(changed.snapshot.report); report.name = 'changed'; changed.files.set('report.json', bytes(report)); }],
    ['SOURCE_REPORT_DIGEST_MISMATCH', changed => { changed.snapshot.report.name = 'changed'; changed.files.set('report.json', bytes(changed.snapshot.report)); }],
    ['SOURCE_EVIDENCE_DIGEST_MISMATCH', changed => changed.files.set(changed.snapshot.report.checks[0].evidence.contract, Buffer.from('{}'))],
    ['SOURCE_VERIFIED_INDEX_MISMATCH', changed => { changed.snapshot.integrity.verifiedBytes++; }],
    ['SOURCE_INTEGRITY_FAILED', changed => { changed.snapshot.integrity.evidenceVerified = false; }],
  ];
  for (const [reason, mutate] of cases) { const changed = cloneSource(source); mutate(changed); rejects(changed, reason); }
});

test('valid generic hashes cannot substitute for complete slots, source, expected, identity and evidence semantics', async t => {
  const source = await materialize(t);
  const cases = [
    ['SOURCE_CHECK_IDENTITY_MISMATCH', changed => { changed.snapshot.report.checks[0].identity.ruleKey = 'a'.repeat(64); }],
    ['SOURCE_CHECK_CONTRACT_MISMATCH', changed => { changed.snapshot.report.checks[0].expected.status = 500; }],
    ['SOURCE_REQUIREMENT_MISMATCH', changed => { changed.snapshot.report.specSource.revision = 'v9'; }],
    ['SOURCE_SPEC_APPROVAL_MISMATCH', changed => { changed.snapshot.report.specApproval.approved = true; }],
    ['SOURCE_CHECK_SLOTS_MISMATCH', changed => { changed.snapshot.report.checks.push(copy(changed.snapshot.report.checks[0])); }],
    ['SOURCE_COVERAGE_INCOMPLETE', changed => { changed.snapshot.report.coverage.capped = true; }],
    ['SOURCE_VERIFIER_UNSUPPORTED', changed => { changed.snapshot.report.verifierFingerprint = 'b'.repeat(64); }],
    ['SOURCE_CONTRACT_ROLE_MISMATCH', changed => {
      const check = changed.snapshot.report.checks[0], previous = check.evidence.contract;
      changed.files.set('other-contract.json', changed.files.get(previous));
      const entry = changed.snapshot.report.evidenceManifest.find(item => item.file === previous); entry.file = 'other-contract.json';
      check.evidence.contract = 'other-contract.json';
    }],
    ['SOURCE_CONTRACT_EVIDENCE_MISMATCH', changed => {
      const file = changed.snapshot.report.checks[0].evidence.contract, evidence = JSON.parse(changed.files.get(file));
      evidence.contract.expect.status = 500; changed.files.set(file, bytes(evidence));
    }],
    ['SOURCE_EVIDENCE_INDEX_INVALID', changed => { changed.snapshot.report.evidenceManifest.push(copy(changed.snapshot.report.evidenceManifest[0])); }],
    ['SOURCE_SAFETY_REQUEST_COUNT_MISMATCH', changed => { changed.snapshot.report.safety.requests = 1; }],
  ];
  for (const [reason, mutate] of cases) { const changed = cloneSource(source); mutate(changed); seal(changed); rejects(changed, reason); }
});

test('empty/omitted, unnormalized, cross-mode, unfinished and mismatching complete URLs cannot qualify', async t => {
  const source = await materialize(t);
  const omitted = await materialize(t, manualPlan({}, { omissions: [{ id: 'write', method: 'POST', path: '/orders', reason: 'write unsupported' }] }));
  rejects(omitted, 'SOURCE_SCOPE_INCOMPLETE');
  const onlyOmission = await materialize(t, manualPlan({}, { checks: [], omissions: [{ id: 'write', method: 'POST', path: '/orders', reason: 'write unsupported' }] }));
  rejects(onlyOmission, 'SOURCE_SCOPE_INCOMPLETE');
  const cases = [
    ['SOURCE_PLAN_NOT_NORMALIZED', changed => { changed.snapshot.manifest.plan.spec.checks[0].expect.json = []; }],
    ['SOURCE_MODE_UNSUPPORTED', changed => { changed.snapshot.manifest.mode = 'mirror'; changed.snapshot.report.mode = 'mirror'; }],
    ['SOURCE_RUN_NOT_COMPLETE', changed => { changed.snapshot.manifest.status = 'interrupted'; }],
    ['SOURCE_TARGET_MISMATCH', changed => { changed.snapshot.report.targetUrl = changed.snapshot.manifest.targetUrl + '&other=query'; }],
    ['SOURCE_SIDE_UNSUPPORTED', changed => { changed.snapshot.report.baselineUrl = changed.snapshot.manifest.targetUrl; }],
  ];
  for (const [reason, mutate] of cases) { const changed = cloneSource(source); mutate(changed); seal(changed); rejects(changed, reason); }
  for (const sourceSide of ['target', 'baseline', 'requirements']) rejects(source, 'SOURCE_SIDE_UNSUPPORTED', { ...options(), sourceSide });
  rejects(source, 'SOURCE_CONTEXT_INVALID', { ...options(), projectId: 'ap-truncated' });
});

test('saved plan uses legacy insertion-order hash while runner source/contracts use normalized legacy hashes', async t => {
  const source = await materialize(t), context = options(), initial = project(source, context);
  const reordered = cloneSource(source), plan = reordered.snapshot.manifest.plan;
  plan.spec.source = Object.fromEntries(Object.entries(plan.spec.source).reverse());
  reordered.snapshot.manifest.plan = Object.fromEntries(Object.entries(plan).reverse());
  reordered.snapshot.report.planFingerprint = sha(JSON.stringify(reordered.snapshot.manifest.plan));
  seal(reordered);
  const result = project(reordered, context);
  assert.notEqual(result.projection.sourcePlanDigest, initial.projection.sourcePlanDigest);
  assert.equal(result.projection.sourcePlanDigest, reordered.snapshot.report.planFingerprint);
  assert.equal(result.projection.oracleManifestKey, initial.projection.oracleManifestKey);
  assert.equal(result.projection.ruleManifestKey, initial.projection.ruleManifestKey);
  const wrongLegacy = cloneSource(reordered);
  wrongLegacy.snapshot.report.planFingerprint = hashAcceptanceValue(wrongLegacy.snapshot.manifest.plan); seal(wrongLegacy);
  rejects(wrongLegacy, 'SOURCE_PLAN_DIGEST_MISMATCH');
});

test('reviewed LF and CRLF verifier hashes preserve exact legacy provenance and unknown versions fail', async t => {
  const source = await materialize(t), context = options();
  const initial = project(source, context);
  assert.ok(SUPPORTED_SPEC_VERIFIERS_V1.includes(source.snapshot.report.verifierFingerprint));
  for (const verifierFingerprint of SUPPORTED_SPEC_VERIFIERS_V1) {
    const changed = cloneSource(source); changed.snapshot.report.verifierFingerprint = verifierFingerprint; seal(changed);
    const result = project(changed, context);
    assert.equal(result.projection.verifierFingerprint, verifierFingerprint);
    assert.equal(result.projection.oracleManifestKey, initial.projection.oracleManifestKey);
    assert.equal(result.projection.ruleManifestKey, initial.projection.ruleManifestKey);
  }
  const changed = cloneSource(source); changed.snapshot.report.verifierFingerprint = '0'.repeat(64); seal(changed);
  rejects(changed, 'SOURCE_VERIFIER_UNSUPPORTED');
});

test('verifier support is an exact reviewed set and real current completion retains its byte-based provenance', async t => {
  const reviewed = [
    '8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d',
    '32fab6ccb46b1954e7a64c81783699a715013062e6c0bfb6ba19299afc18654f',
    'e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8',
    '8d1b75da7efad4f18b279a466ebdf880b1e24bb641ca80070cd03d0700376e9f',
  ];
  assert.deepEqual(SUPPORTED_SPEC_VERIFIERS_V1, reviewed);
  const files = ['schema.mjs', 'urls.mjs', 'runner.mjs', 'report.mjs', 'spec-schema.mjs',
    'spec-runner.mjs', 'response-schema.mjs', 'openapi.mjs', 'identity.mjs'];
  const sources = await Promise.all([...files.map(file => new URL('../src/acceptance/' + file, import.meta.url)),
    new URL('../src/verify/compare.mjs', import.meta.url)].map(url => readFile(url, 'utf8')));
  // Preserve store.mjs's legacy separators exactly: LF between the first nine
  // sources, with the final compare source appended without an extra separator.
  const fingerprint = values => sha(values.slice(0, -1).join('\n') + values.at(-1));
  const lf = sources.map(source => source.replaceAll('\r\n', '\n'));
  assert.equal(fingerprint(lf), reviewed[2]);
  assert.equal(fingerprint(lf.map(source => source.replaceAll('\n', '\r\n'))), reviewed[3]);
  const actual = fingerprint(sources);
  assert.ok([reviewed[2], reviewed[3]].includes(actual), 'mixed or unreviewed checkout bytes need explicit review');
  const source = await materialize(t);
  assert.equal(source.snapshot.report.verifierFingerprint, actual);
  assert.equal(project(source).projection.verifierFingerprint, actual);
  const unreviewed = [...sources]; unreviewed[5] += '\n// Unreviewed source byte change.\n';
  const unknown = fingerprint(unreviewed);
  assert.equal(SUPPORTED_SPEC_VERIFIERS_V1.includes(unknown), false);
  const changed = cloneSource(source); changed.snapshot.report.verifierFingerprint = unknown; seal(changed);
  rejects(changed, 'SOURCE_VERIFIER_UNSUPPORTED');
});

test('strict pure inputs reject accessors/proxies/Map substitutes without evaluating user hooks', async t => {
  const source = await materialize(t);
  let reads = 0;
  const snapshot = copy(source.snapshot);
  Object.defineProperty(snapshot, 'report', { get() { reads++; throw new Error('must not evaluate'); }, enumerable: true });
  rejects({ snapshot, files: source.files }, 'SOURCE_SNAPSHOT_INVALID');
  assert.equal(reads, 0);
  rejects({ snapshot: source.snapshot, files: new Proxy(source.files, {}) }, 'SOURCE_FILES_INVALID');
  rejects({ snapshot: source.snapshot, files: Object.fromEntries(source.files) }, 'SOURCE_FILES_INVALID');
  const getterOptions = { ...options() };
  Object.defineProperty(getterOptions, 'projectId', { get() { reads++; return options().projectId; }, enumerable: true });
  rejects(source, 'SOURCE_INPUT_INVALID', getterOptions); assert.equal(reads, 0);
  assert.equal(Object.isFrozen(SUPPORTED_SPEC_VERIFIERS_V1), true);
});

test('human approval preview is complete or explicitly rejected when full expected contracts exceed its budget', async t => {
  const json = Array.from({ length: 20 }, (_, index) => ({ pointer: `/field${index}`, kind: 'equals', value: 'x'.repeat(7000) }));
  const checks = Array.from({ length: 8 }, (_, index) => contract({ id: `large-${index}`, expect: { status: 200, json } }));
  const source = await materialize(t, manualPlan({}, { checks }));
  assert.ok(Buffer.byteLength(JSON.stringify(source.snapshot.manifest.plan)) < SPEC_CANDIDATE_LIMITS_V1.jsonBytes);
  rejects(source, 'SOURCE_PREVIEW_BUDGET');
});

test('archived real passing/BUG runs project through the source reader with every source byte unchanged and no request', async () => {
  const root = fileURLToPath(new URL('../../docs/audits/2026-10-16/evidence/acceptance-catalog/console/run-evidence/', import.meta.url));
  const runIds = ['ac-2424d160-cf8e-4991-8fba-c972a84becd1', 'ac-4a58013b-af7f-498a-a9bb-258c81bd9b6d',
    'ac-5494a1d9-c1bc-4b1c-ad1b-144f8591f743'];
  const tree = async (dir, prefix = '') => {
    const result = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, path = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...await tree(path, name + '/'));
      else result.push([name, sha(await readFile(path))]);
    }
    return result;
  };
  const before = await tree(root), originalFetch = globalThis.fetch;
  const owner = { root: await realpath(root), assertOwned() { return true; } };
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('projector must never request'); };
  try {
    for (const [index, runId] of runIds.entries()) {
      const source = readSpecCandidateSource(runId, { root, owner }), result = project(source);
      assert.equal(result.projection.source.runId, runId);
      assert.equal(result.preview.sourceGate, index === 2 ? 'failed' : 'passed');
      assert.equal(result.preview.sourceStatus, 'completed');
      assert.equal(result.preview.sourceSpecApproved, true);
      assert.equal(result.preview.checks[0].expect.json[0].value, 0);
      assert.equal(result.projection.sourceReportDigest, sha(source.files.get('report.json')));
      assert.equal(source.files.size, 5);
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(requests, 0);
  assert.deepEqual(await tree(root), before);
});

test('archived B2.1 draft and BUG candidates retain their golden projection and all 14 original files', async () => {
  const archive = fileURLToPath(new URL('../../docs/audits/2026-10-16/evidence/acceptance-baseline/console/', import.meta.url));
  const root = join(archive, 'run-evidence'), catalogBytes = await readFile(join(archive, 'catalog-storage.json'));
  const catalog = JSON.parse(catalogBytes), archivedDigests = JSON.parse(await readFile(join(archive, 'run-file-digests.json')));
  const cases = [
    { runId: 'ac-1897dc22-0d21-4b6f-95c3-4dd72201063d', approved: false, gate: 'blocked', fileCount: 5,
      contentDigest: '9f7a0548eed717bd4603062f4c15ab4676228a23e9b8bfebfd09fee64ff61c8d' },
    { runId: 'ac-10afe248-c3f9-4b86-b3db-373a55025c05', approved: true, gate: 'failed', fileCount: 9,
      contentDigest: 'cbf10096861b5b95f2c03a749f1184b29f4b4cd9bb86a02d2d23e3ec1ad7c965' },
  ];
  const digests = async () => Object.fromEntries(await Promise.all(cases.map(async ({ runId }) => [runId,
    Object.fromEntries(await Promise.all((await readdir(join(root, runId))).sort().map(async name =>
      [name, sha(await readFile(join(root, runId, name)))])))])));
  assert.deepEqual(await digests(), archivedDigests);
  assert.equal(Object.values(archivedDigests).reduce((total, files) => total + Object.keys(files).length, 0), 14);
  const owner = { root: await realpath(root), assertOwned() { return true; } }, originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('historical projection must never request'); };
  try {
    for (const expected of cases) {
      const candidate = Object.values(catalog.candidates).find(item => item.source.runId === expected.runId);
      assert.ok(candidate);
      const source = readSpecCandidateSource(expected.runId, { root, owner });
      const result = project(source, { projectId: candidate.projectId, releaseId: candidate.source.releaseId, sourceSide: 'source' });
      assert.deepEqual(result.projection, candidateProjectionOf(candidate));
      assert.equal(result.projection.contentDigest, expected.contentDigest);
      assert.equal(result.projection.verifierFingerprint, '8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d');
      assert.equal(result.preview.sourceSpecApproved, expected.approved);
      assert.equal(result.preview.sourceGate, expected.gate);
      assert.equal(result.preview.projectedSlots, 2);
      assert.equal(result.preview.executionReady, false);
      assert.equal(Object.keys(archivedDigests[expected.runId]).length, expected.fileCount);
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(requests, 0);
  assert.deepEqual(await digests(), archivedDigests);
  assert.deepEqual(await readFile(join(archive, 'catalog-storage.json')), catalogBytes);
});
