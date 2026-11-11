import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareManagedSpecContract } from '../src/acceptance/managed-spec-plan.mjs';
import { projectSpecBaselineCandidate, SUPPORTED_SPEC_VERIFIERS_V1 } from '../src/acceptance/candidate-projection.mjs';
import { AcceptanceCatalogError, candidateProjectionOf } from '../src/acceptance/catalog-schema.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { previewOpenApi } from '../src/acceptance/openapi.mjs';
import { requiredDir } from './fixtures/audit-evidence.mjs';

const archive = requiredDir('2026-10-16/evidence/acceptance-baseline/console');
const archiveRoot = join(archive, 'run-evidence');
const DRAFT = 'ac-1897dc22-0d21-4b6f-95c3-4dd72201063d';
const BUG = 'ac-10afe248-c3f9-4b86-b3db-373a55025c05';
const TARGET = 'ar-00000000-0000-4000-8000-000000000002';
const OTHER_PROJECT = 'ap-00000000-0000-4000-8000-000000000003';
const AT = '2026-10-16T15:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const ownerOf = root => ({ root: realpathSync(root), assertOwned() { return true; } });
const cloneMaterial = material => ({ snapshot: copy(material.snapshot),
  files: new Map([...material.files].map(([name, bytes]) => [name, Buffer.from(bytes)])) });

function fixture(runId = DRAFT) {
  const catalog = JSON.parse(readFileSync(join(archive, 'catalog-storage.json'), 'utf8'));
  const candidate = Object.values(catalog.candidates).find(item => item.source.runId === runId);
  assert.ok(candidate, 'archived candidate exists');
  const material = readSpecCandidateSource(runId, { root: archiveRoot, owner: ownerOf(archiveRoot) });
  const sourceRelease = catalog.releases[candidate.source.releaseId];
  const targetRelease = { ...sourceRelease, id: TARGET, label: '明确目标版本 v2',
    targetUrl: 'https://target.example.test/app?tenant=beta', buildRef: 'release-v2', createdAt: AT };
  return { material, candidate, sourceRelease, targetRelease };
}
const prepare = f => prepareManagedSpecContract(f.material, { candidate: f.candidate, targetRelease: f.targetRelease });
function fails(action, code, reason) {
  assert.throws(action, error => {
    assert.ok(error instanceof AcceptanceCatalogError);
    assert.equal(error.code, code);
    assert.equal(error.status, code === 'INVALID_INPUT' ? 400 : 409);
    if (reason) assert.equal(error.details.reason, reason);
    assert.match(error.details.reason, /^[A-Z0-9_]{1,80}$/);
    return true;
  });
}
function inputState(f) {
  return { snapshot: copy(f.material.snapshot), candidate: copy(f.candidate), targetRelease: copy(f.targetRelease),
    files: [...f.material.files].map(([name, data]) => [name, data.length, sha(data)]) };
}
function treeBytes(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = prefix + entry.name, path = join(dir, entry.name);
    return entry.isDirectory() ? treeBytes(path, name + '/') : [[name, sha(readFileSync(path))]];
  });
}
function sealReport(material) {
  material.files.set('report.json', jsonBytes(material.snapshot.report));
  material.snapshot.manifest.reportSha256 = sha(material.files.get('report.json'));
  material.snapshot.integrity.reportSha256 = material.snapshot.manifest.reportSha256;
  material.files.set('manifest.json', jsonBytes(material.snapshot.manifest));
}
async function materializeDraft(t, plan, template) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-managed-spec-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let manifest;
  if (template) {
    manifest = { ...copy(template.snapshot.manifest), plan, name: plan.name, targetUrl: plan.targetUrl, status: 'running' };
    const dir = acceptanceRunDir(manifest.runId, root); mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), jsonBytes(manifest));
  } else manifest = createAcceptanceRun(plan, { root });
  const dir = acceptanceRunDir(manifest.runId, root);
  const raw = await runSpecAcceptance(plan, { runId: manifest.runId, outputDir: dir });
  finishAcceptanceRun(manifest.runId, raw, { root });
  return readSpecCandidateSource(manifest.runId, { root, owner: ownerOf(root) });
}

test('archived draft builds a distinct approved plan for the explicit release without altering its source', () => {
  const f = fixture(), before = inputState(f), sourcePlan = f.material.snapshot.manifest.plan;
  const result = prepare(f);
  assert.deepEqual(Object.keys(result).sort(), ['plan', 'planFingerprint', 'sourceSpecApproved', 'sourceProjection'].sort());
  assert.equal(result.sourceSpecApproved, false);
  assert.equal(sourcePlan.spec.approved, false);
  assert.equal(f.material.snapshot.manifest.gate, 'blocked');
  assert.equal(result.plan.spec.approved, true);
  assert.equal(result.plan.targetUrl, f.targetRelease.targetUrl);
  assert.notEqual(result.plan.name, sourcePlan.name);
  assert.match(result.plan.name, /^托管 Spec · /);
  assert.deepEqual(result.plan.spec, { ...sourcePlan.spec, approved: true });
  assert.equal(result.plan.timeoutMs, sourcePlan.timeoutMs);
  assert.equal(result.plan.maxResponseBytes, sourcePlan.maxResponseBytes);
  assert.equal(result.planFingerprint, sha(JSON.stringify(result.plan)));
  assert.notEqual(result.planFingerprint, f.candidate.sourcePlanDigest);
  assert.equal(result.sourceProjection.source.releaseId, f.sourceRelease.id);
  assert.notEqual(result.sourceProjection.source.releaseId, f.targetRelease.id);
  assert.deepEqual(result.sourceProjection, candidateProjectionOf(f.candidate));
  assert.deepEqual(result.plan.spec.checks[0].expect.json.map(item => item.value), [0, false, '']);
  assert.equal(result.plan.spec.checks[1].method, 'HEAD');
  assert.deepEqual(inputState(f), before);
});

test('archived BUG response never becomes the expected contract', () => {
  const f = fixture(BUG), response = JSON.parse(f.material.files.get('spec-1-QUOTA-response.json'));
  assert.equal(f.material.snapshot.report.gate, 'failed');
  assert.equal(response.body.code, 1);
  const result = prepare(f);
  assert.equal(result.sourceSpecApproved, true);
  assert.equal(result.plan.spec.checks[0].expect.json[0].value, 0);
  assert.deepEqual(result.plan.spec.checks, f.material.snapshot.manifest.plan.spec.checks);
});

test('same source release is allowed only with its original target URL; a new release may reuse that URL', () => {
  const f = fixture(); f.targetRelease = copy(f.sourceRelease);
  assert.equal(prepare(f).plan.targetUrl, f.sourceRelease.targetUrl);
  f.targetRelease.targetUrl += '&changed=1';
  fails(() => prepare(f), 'BASELINE_CHANGED', 'SOURCE_RELEASE_CHANGED');
  f.targetRelease = { ...f.sourceRelease, id: TARGET };
  const result = prepare(f);
  assert.equal(result.plan.targetUrl, f.sourceRelease.targetUrl);
  assert.equal(result.sourceProjection.source.releaseId, f.sourceRelease.id);
  assert.notEqual(result.sourceProjection.source.releaseId, f.targetRelease.id);
});

test('target release must belong to the candidate project', () => {
  const f = fixture(); f.targetRelease.projectId = OTHER_PROJECT;
  fails(() => prepare(f), 'PROJECT_MISMATCH', 'TARGET_PROJECT_MISMATCH');
});

test('release validation matches the strict stored shape, optional buildRef and canonical URL', async t => {
  const cases = [
    ['unknown', release => { release.plan = { spec: { approved: true } }; }],
    ['missing', release => { delete release.createdAt; }],
    ['invalid id', release => { release.id = 'ar-truncated'; }],
    ['invalid project', release => { release.projectId = 'ap-truncated'; }],
    ['date', release => { release.createdAt = '2026-10-16'; }],
    ['label whitespace', release => { release.label = ' padded '; }],
    ['label empty', release => { release.label = ''; }],
    ['label too long', release => { release.label = 'x'.repeat(121); }],
    ['buildRef whitespace', release => { release.buildRef = ' padded '; }],
    ['buildRef too long', release => { release.buildRef = 'x'.repeat(201); }],
    ['undefined buildRef', release => { release.buildRef = undefined; }],
    ['URL canonicalization', release => { release.targetUrl = 'HTTPS://Target.example.test'; }],
    ['URL credentials', release => { release.targetUrl = 'https://user:password@target.example.test/'; }],
    ['URL fragment', release => { release.targetUrl = 'https://target.example.test/#fragment'; }],
    ['URL protocol', release => { release.targetUrl = 'file:///tmp/target'; }],
    ['URL unknown type', release => { release.targetUrl = { toString() { throw new Error('do not coerce'); } }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const f = fixture(); mutate(f.targetRelease); fails(() => prepare(f), 'INVALID_INPUT', 'INVALID_RELEASE');
  });
  const f = fixture(); delete f.targetRelease.buildRef;
  assert.equal(prepare(f).plan.targetUrl, f.targetRelease.targetUrl);
});

test('unknown execution inputs cannot override the verified contract', async t => {
  for (const key of ['plan', 'expected', 'checks', 'source', 'approved', 'name', 'targetUrl', 'timeoutMs', 'maxResponseBytes']) {
    await t.test(key, () => {
      const f = fixture();
      fails(() => prepareManagedSpecContract(f.material, { candidate: f.candidate, targetRelease: f.targetRelease, [key]: true }),
        'INVALID_INPUT');
    });
  }
  const f = fixture();
  fails(() => prepareManagedSpecContract({ ...f.material, expected: { status: 500 } },
    { candidate: f.candidate, targetRelease: f.targetRelease }), 'SOURCE_NOT_ELIGIBLE', 'SOURCE_INPUT_INVALID');
});

test('candidate shape and every stored projection digest are checked', async t => {
  for (const [name, mutate] of [
    ['unknown field', candidate => { candidate.approved = true; }],
    ['nested unknown', candidate => { candidate.source.targetReleaseId = TARGET; }],
    ['missing id', candidate => { delete candidate.id; }],
    ['invalid id', candidate => { candidate.id = 'ab-truncated'; }],
    ['mode', candidate => { candidate.mode = 'browser'; }],
    ['projection version', candidate => { candidate.projectionVersion = 2; }],
    ['source side', candidate => { candidate.source.side = 'target'; }],
    ['source run id', candidate => { candidate.source.runId = 'ac-truncated'; }],
    ['source release id', candidate => { candidate.source.releaseId = 'ar-truncated'; }],
    ['createdAt', candidate => { candidate.createdAt = 'yesterday'; }],
    ['invalid digest', candidate => { candidate.contentDigest = 'f'; }],
  ]) await t.test(name, () => {
    const f = fixture(); mutate(f.candidate); fails(() => prepare(f), 'INVALID_INPUT', 'INVALID_CANDIDATE');
  });
  for (const field of ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'scopeKey', 'ruleManifestKey',
    'oracleManifestKey', 'environmentKey', 'verifierFingerprint', 'contentDigest']) await t.test(field, () => {
    const f = fixture(); f.candidate[field] = '0'.repeat(64);
    fails(() => prepare(f), 'BASELINE_CHANGED', 'CANDIDATE_SOURCE_CHANGED');
  });
});

test('full source validation rejects changed raw bytes, unverified snapshots and Map substitutes', async t => {
  const cases = [
    ['contract bytes', f => { const bytes = f.material.files.get('spec-1-QUOTA-contract.json'); bytes[0] ^= 1; }, 'SOURCE_INTEGRITY_FAILED'],
    ['missing contract', f => { f.material.files.delete('spec-2-HEALTH-contract.json'); }, 'SOURCE_INTEGRITY_FAILED'],
    ['snapshot expected', f => { f.material.snapshot.manifest.plan.spec.checks[0].expect.status = 500; }, 'SOURCE_INTEGRITY_FAILED'],
    ['unverified', f => { f.material.snapshot.integrity.evidenceVerified = false; }, 'SOURCE_INTEGRITY_FAILED'],
    ['Map substitute', f => { f.material.files = Object.fromEntries(f.material.files); }, 'SOURCE_INTEGRITY_FAILED'],
    ['unsupported verifier', f => { f.material.snapshot.report.verifierFingerprint = '0'.repeat(64); sealReport(f.material); }, 'SOURCE_NOT_ELIGIBLE'],
  ];
  for (const [name, mutate, code] of cases) await t.test(name, () => {
    const f = fixture(); f.material = cloneMaterial(f.material); mutate(f); fails(() => prepare(f), code);
  });
});

test('coherently regenerated source with new expectations cannot match the old candidate', async t => {
  const f = fixture(), plan = copy(f.material.snapshot.manifest.plan);
  plan.spec.checks[0].expect.json[0].value = 999;
  const changed = await materializeDraft(t, normalizeSpecPlan(plan), f.material);
  const projected = projectSpecBaselineCandidate(changed, { projectId: f.candidate.projectId,
    releaseId: f.candidate.source.releaseId, sourceSide: 'source' });
  assert.notEqual(projected.projection.contentDigest, f.candidate.contentDigest);
  assert.equal(changed.snapshot.manifest.runId, f.material.snapshot.manifest.runId);
  fails(() => prepareManagedSpecContract(changed, { candidate: f.candidate, targetRelease: f.targetRelease }),
    'BASELINE_CHANGED', 'CANDIDATE_SOURCE_CHANGED');
});

test('OpenAPI document, source metadata, schema and nondefault budgets survive as independent copies', async t => {
  const document = { openapi: '3.1.1', info: { title: '完整 OpenAPI 需求', version: '3.0.0' }, paths: {
    '/healthy': { get: { responses: { 200: { description: 'OK', content: { 'application/json': {
      schema: { type: 'object', required: ['enabled'], additionalProperties: false,
        properties: { enabled: { type: 'boolean' } } } } } } } } } } };
  const sourcePlan = normalizeSpecPlan({ ...previewOpenApi(document, { targetUrl: 'http://127.0.0.1:1/source' }).plan,
    timeoutMs: 17500, maxResponseBytes: 16384 });
  const f = fixture(); f.material = await materializeDraft(t, sourcePlan);
  const { projection } = projectSpecBaselineCandidate(f.material, { projectId: f.candidate.projectId,
    releaseId: f.candidate.source.releaseId, sourceSide: 'source' });
  f.candidate = { id: f.candidate.id, ...projection, createdAt: AT };
  const before = inputState(f), result = prepare(f);
  assert.deepEqual(result.plan.spec.document, sourcePlan.spec.document);
  assert.deepEqual(result.plan.spec.source, sourcePlan.spec.source);
  assert.deepEqual(result.plan.spec.checks, sourcePlan.spec.checks);
  assert.deepEqual(result.plan.spec.omissions, []);
  assert.equal(result.plan.timeoutMs, 17500); assert.equal(result.plan.maxResponseBytes, 16384);
  assert.equal(result.sourceSpecApproved, false);
  result.plan.spec.document.info.title = 'changed result only';
  result.plan.spec.source.id = 'changed-result';
  result.plan.spec.checks[0].expect.schema.required.push('injected');
  result.sourceProjection.source.releaseId = TARGET;
  assert.deepEqual(inputState(f), before);
});

test('accessors, proxies, symbols and hidden fields are rejected without invoking user code', () => {
  const f = fixture(); let reads = 0;
  const getter = () => { reads++; throw new Error('must not evaluate'); };
  const accessorCandidate = { ...f.candidate };
  Object.defineProperty(accessorCandidate, 'projectId', { get: getter, enumerable: true });
  fails(() => prepareManagedSpecContract(f.material, { candidate: accessorCandidate, targetRelease: f.targetRelease }), 'INVALID_INPUT');
  const accessorRelease = { ...f.targetRelease };
  Object.defineProperty(accessorRelease, 'targetUrl', { get: getter, enumerable: true });
  fails(() => prepareManagedSpecContract(f.material, { candidate: f.candidate, targetRelease: accessorRelease }), 'INVALID_INPUT');
  const accessorOptions = { targetRelease: f.targetRelease };
  Object.defineProperty(accessorOptions, 'candidate', { get: getter, enumerable: true });
  fails(() => prepareManagedSpecContract(f.material, accessorOptions), 'INVALID_INPUT');
  for (const candidate of [new Proxy(f.candidate, {}), { ...f.candidate, [Symbol('hidden')]: true },
    Object.defineProperty({ ...f.candidate }, 'hidden', { value: true })]) {
    fails(() => prepareManagedSpecContract(f.material, { candidate, targetRelease: f.targetRelease }), 'INVALID_INPUT');
  }
  const snapshot = copy(f.material.snapshot);
  Object.defineProperty(snapshot.manifest.plan.spec, 'checks', { get: getter, enumerable: true });
  fails(() => prepareManagedSpecContract({ snapshot, files: f.material.files },
    { candidate: f.candidate, targetRelease: f.targetRelease }), 'SOURCE_NOT_ELIGIBLE');
  assert.equal(reads, 0);
});

test('result does not alias source snapshots, candidate projection or raw byte buffers', () => {
  const f = fixture(), before = inputState(f), result = prepare(f);
  result.plan.spec.checks[0].expect.json[0].value = 999;
  result.plan.spec.source.title = 'result only'; result.plan.spec.omissions.push({ reason: 'result only' });
  result.sourceProjection.source.runId = BUG;
  assert.deepEqual(inputState(f), before);
  const fresh = prepare(f);
  f.material.snapshot.manifest.plan.spec.checks[0].expect.json[0].value = 777;
  f.candidate.source.releaseId = TARGET;
  f.material.files.get('spec-1-QUOTA-contract.json').fill(0);
  assert.equal(fresh.plan.spec.checks[0].expect.json[0].value, 0);
  assert.notEqual(fresh.sourceProjection.source.releaseId, TARGET);
});

test('preparation is deterministic without requests or clock reads and archived bytes remain unchanged', () => {
  const f = fixture(), before = treeBytes(archiveRoot), inputBefore = inputState(f);
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let requests = 0, clockReads = 0, first, second;
  globalThis.fetch = () => { requests++; throw new Error('no HTTP permitted'); };
  Date.now = () => { clockReads++; throw new Error('no clock permitted'); };
  try { first = prepare(f); second = prepare(f); }
  finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
  assert.equal(requests, 0); assert.equal(clockReads, 0); assert.deepEqual(first, second);
  assert.deepEqual(inputState(f), inputBefore);
  assert.deepEqual(treeBytes(archiveRoot), before);
});

test('generated names are bounded and do not split surrogate pairs; public projector remains unchanged', () => {
  const f = fixture(); f.targetRelease.label = '😀'.repeat(60);
  const result = prepare(f);
  assert.ok(result.plan.name.length <= 120);
  assert.equal([...result.plan.name].every(point => point.length === 2 || !/[\ud800-\udfff]/u.test(point)), true);
  const projected = projectSpecBaselineCandidate(f.material, { projectId: f.candidate.projectId,
    releaseId: f.candidate.source.releaseId, sourceSide: 'source' });
  assert.deepEqual(Object.keys(projected).sort(), ['preview', 'projection']);
  assert.equal(Object.hasOwn(projected, 'plan'), false);
  assert.deepEqual(SUPPORTED_SPEC_VERIFIERS_V1, [
    '8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d',
    '32fab6ccb46b1954e7a64c81783699a715013062e6c0bfb6ba19299afc18654f',
    'e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8',
    '8d1b75da7efad4f18b279a466ebdf880b1e24bb641ca80070cd03d0700376e9f',
    '2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337',
    '270251e1ca417383ee019a456d1a103ec461c57a9a8c661fdc9ff562cac515f2',
    '7066c543d13122ca37cd28aa061fbd7ba5f0dcecf4c4f67959759aaef2bf47a0',
    '3fa0303bfc4813bbddae1744ba8675a809fbc12003decdc76304d0cf0b45b5f5',
  ]);
});
