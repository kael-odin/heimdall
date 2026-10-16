import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { currentSelectionsOf } from '../src/acceptance/catalog-schema.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir, readAcceptanceSnapshot } from '../src/acceptance/store.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { projectSpecBaselineCandidate } from '../src/acceptance/candidate-projection.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { startAcceptanceApiFixture } from './fixtures/acceptance-api.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const cas = f => { const value = f.store.read(); return { expectedGenerationId: value.generationId, expectedRevision: value.revision }; };
const createInput = (f, source) => ({ ...cas(f), mode: 'spec', sourceRunId: source.runId, sourceSide: 'source' });
const approveInput = (f, candidate) => ({ ...cas(f), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: '核对完整合同' });
const selectInput = (f, approval) => ({ ...cas(f), mode: 'spec', approvalId: approval?.id ?? null,
  contentDigest: approval?.contentDigest ?? null, reason: approval ? '选用已批准合同' : '取消选用' });
const heads = f => readFileSync(join(f.root, 'catalog.json'));
const runFiles = source => new Map(readdirSync(source.dir).map(file => [file, readFileSync(join(source.dir, file))]));
const writeFiles = (source, files) => { for (const [file, bytes] of files) writeFileSync(join(source.dir, file), bytes); };
async function fixture(t, targetUrl = 'http://127.0.0.1:1/app?release=one') {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-baseline-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = { root, owned: true, afterPrevious: null };
  f.owner = { root, assertOwned() {
    if (!f.owned) throw Object.assign(new Error('owner deliberately lost'), { code: 'ACCEPTANCE_OWNER_LOST', status: 503 });
    return true;
  } };
  f.store = createAcceptanceCatalogStore({ root, owner: f.owner, writeAtomic(file, bytes) {
    writeAtomicFileSync(file, bytes);
    if (basename(file) === 'catalog.previous.json' && f.afterPrevious) {
      const callback = f.afterPrevious; f.afterPrevious = null; callback();
    }
  } });
  await f.store.initialize();
  f.project = (await f.store.createProject({ ...cas(f), name: '完整性独立回归' })).project;
  f.release = (await f.store.createRelease(f.project.id, { ...cas(f), label: 'v1', targetUrl })).release;
  return f;
}
async function source(f, { approved = false, path = '/healthy', checks = 1 } = {}) {
  const plan = normalizeSpecPlan({ name: '需求定义来源', mode: 'spec', targetUrl: f.release.targetUrl, timeoutMs: 1000,
    spec: { source: { id: 'REQ-INTEGRITY', revision: 'v1', type: 'manual' }, approved,
      checks: Array.from({ length: checks }, (_, index) => ({ id: `CODE-${index + 1}`, title: `业务状态 ${index + 1}`,
        method: 'GET', path, severity: 'high', expect: { status: 200, contentType: 'application/json',
          json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } });
  const run = createAcceptanceRun(plan, { root: f.root }), dir = acceptanceRunDir(run.runId, f.root);
  const report = finishAcceptanceRun(run.runId, await runSpecAcceptance(plan, { runId: run.runId, outputDir: dir }), { root: f.root });
  await f.store.bindRun(f.project.id, { ...cas(f), runId: run.runId, releaseId: f.release.id });
  return { runId: run.runId, dir, plan, report };
}
async function candidate(f, source) { return (await f.store.createBaselineCandidate(f.project.id, createInput(f, source))).candidate; }
async function approval(f, candidate) { return (await f.store.approveBaseline(f.project.id, approveInput(f, candidate))).approval; }
async function unchanged(f, action, code) {
  const before = heads(f);
  await assert.rejects(action, error => error.code === code);
  assert.deepEqual(heads(f), before);
  validateAcceptanceCatalog(f.store.read());
}
function resealReport(source, mutate) {
  const report = parse(join(source.dir, 'report.json')), manifest = parse(join(source.dir, 'manifest.json'));
  mutate(report, manifest);
  const references = new Set(report.checks.flatMap(check => Object.values(check.evidence)));
  for (const entry of report.evidenceManifest) if (references.has(entry.file)) {
    const bytes = readFileSync(join(source.dir, entry.file)); entry.bytes = bytes.length; entry.sha256 = hash(bytes);
  }
  const summarized = summarizeAcceptanceReport(report);
  report.summary = summarized.summary; report.gate = summarized.gate;
  manifest.summary = report.summary; manifest.gate = report.gate; manifest.endedAt = report.endedAt;
  const bytes = jsonBytes(report); writeFileSync(join(source.dir, 'report.json'), bytes);
  manifest.reportSha256 = hash(bytes); writeFileSync(join(source.dir, 'manifest.json'), jsonBytes(manifest));
}
/** Regenerate a supported draft using the actual runner, then recompute every
 * legacy completion hash. This deliberately models coherent local rewriting,
 * not a fake verifier or a changed rule implementation. */
async function regenerate(source, changes) {
  const previous = parse(join(source.dir, 'report.json')), manifest = parse(join(source.dir, 'manifest.json'));
  const plan = normalizeSpecPlan(changes(structuredClone(manifest.plan)));
  assert.equal(plan.spec.approved, false);
  const raw = await runSpecAcceptance(plan, { runId: source.runId, outputDir: source.dir });
  const references = new Set(raw.checks.flatMap(check => Object.values(check.evidence)));
  const evidenceManifest = [...references].map(file => { const bytes = readFileSync(join(source.dir, file)); return { file, bytes: bytes.length, sha256: hash(bytes) }; });
  const report = summarizeAcceptanceReport({ ...raw, planFingerprint: hash(JSON.stringify(plan)),
    verifierFingerprint: previous.verifierFingerprint, evidenceManifest });
  const reportBytes = jsonBytes(report); writeFileSync(join(source.dir, 'report.json'), reportBytes);
  Object.assign(manifest, { plan, name: plan.name, targetUrl: plan.targetUrl, status: 'completed', gate: report.gate,
    summary: report.summary, endedAt: report.endedAt, updatedAt: report.endedAt, reportSha256: hash(reportBytes) });
  writeFileSync(join(source.dir, 'manifest.json'), jsonBytes(manifest));
}
function currentProjection(f, source) {
  return projectSpecBaselineCandidate(readSpecCandidateSource(source.runId, { root: f.root, owner: f.owner }),
    { projectId: f.project.id, releaseId: f.release.id, sourceSide: 'source' }).projection;
}

test('coherent source rewrite with all legacy hashes rebuilt cannot authorize the old candidate or approval', async t => {
  const f = await fixture(t), s = await source(f), old = await candidate(f, s), approved = await approval(f, old);
  await f.store.selectBaseline(f.project.id, selectInput(f, approved));
  await regenerate(s, plan => { plan.spec.source.revision = 'v2'; plan.spec.checks[0].expect.status = 201; return plan; });
  assert.equal(readAcceptanceSnapshot(s.runId, { root: f.root }).integrity.valid, true);
  assert.notEqual(currentProjection(f, s).contentDigest, old.contentDigest);
  const preview = f.store.readBaselineCandidate(f.project.id, old.id);
  assert.equal(preview.diagnostics.eligible, false);
  assert.equal(preview.diagnostics.issues[0].code, 'BASELINE_CHANGED');
  await unchanged(f, f.store.approveBaseline(f.project.id, approveInput(f, old)), 'BASELINE_CHANGED');
  await f.store.selectBaseline(f.project.id, selectInput(f, null));
  await unchanged(f, f.store.selectBaseline(f.project.id, selectInput(f, approved)), 'BASELINE_CHANGED');
  const next = await candidate(f, s);
  assert.notEqual(next.contentDigest, old.contentDigest);
  assert.equal(f.store.readBaselineCandidate(f.project.id, next.id).preview.checks[0].expect.status, 201);
  assert.equal(Object.keys(f.store.read().approvals).length, 1);
  assert.deepEqual(f.store.read().candidates[old.id], old);
});

test('a coherently rehashed observed response changes provenance while preserving the requirements oracle', async t => {
  const api = await startAcceptanceApiFixture(); t.after(() => api.close());
  const f = await fixture(t, api.targetUrl), s = await source(f, { approved: true, path: '/wrong-code' });
  const old = await candidate(f, s), before = currentProjection(f, s), requests = api.requests.length;
  writeFileSync(join(s.dir, s.report.checks[0].evidence.response), jsonBytes({ requested: true, body: { code: 999 } }));
  resealReport(s, () => {});
  assert.equal(readAcceptanceSnapshot(s.runId, { root: f.root }).integrity.valid, true);
  const after = currentProjection(f, s);
  assert.equal(after.oracleManifestKey, before.oracleManifestKey);
  assert.notEqual(after.evidenceManifestDigest, before.evidenceManifestDigest);
  await unchanged(f, f.store.approveBaseline(f.project.id, approveInput(f, old)), 'BASELINE_CHANGED');
  assert.equal(api.requests.length, requests);
});

test('sharing one valid contract file between two slots cannot hide the missing required role', async t => {
  const f = await fixture(t), s = await source(f, { checks: 2 });
  resealReport(s, report => { report.checks[1].evidence.contract = report.checks[0].evidence.contract; });
  assert.equal(readAcceptanceSnapshot(s.runId, { root: f.root }).integrity.valid, true);
  await unchanged(f, f.store.createBaselineCandidate(f.project.id, createInput(f, s)), 'SOURCE_NOT_ELIGIBLE');
});

test('late source corruption after rolling backup and before head publication rejects candidate/approval/selection', async t => {
  for (const operation of ['candidate', 'approval', 'selection']) await t.test(operation, async t => {
    const f = await fixture(t), s = await source(f);
    const old = operation === 'candidate' ? null : await candidate(f, s);
    const approved = operation === 'selection' ? await approval(f, old) : null;
    let changed = false;
    f.afterPrevious = () => { writeFileSync(join(s.dir, s.report.checks[0].evidence.contract), '{}\n'); changed = true; };
    const before = heads(f);
    const action = operation === 'candidate' ? f.store.createBaselineCandidate(f.project.id, createInput(f, s))
      : operation === 'approval' ? f.store.approveBaseline(f.project.id, approveInput(f, old))
        : f.store.selectBaseline(f.project.id, selectInput(f, approved));
    await assert.rejects(action, { code: 'SOURCE_INTEGRITY_FAILED' });
    assert.equal(changed, true); assert.deepEqual(heads(f), before);
    assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), before);
    validateAcceptanceCatalog(f.store.read());
    assert.equal(Object.keys(f.store.read().candidates).length, old ? 1 : 0);
    assert.equal(Object.keys(f.store.read().approvals).length, approved ? 1 : 0);
    assert.equal(Object.keys(f.store.read().selections).length, 0);
  });
});

test('late coherent requirement rewrite is also compared against the original candidate at final publication', async t => {
  const f = await fixture(t), s = await source(f), old = await candidate(f, s);
  const original = runFiles(s);
  await regenerate(s, plan => { plan.spec.checks[0].expect.json[0].value = 1; return plan; });
  const replacement = runFiles(s); assert.equal(readAcceptanceSnapshot(s.runId, { root: f.root }).integrity.valid, true);
  writeFiles(s, original);
  f.afterPrevious = () => writeFiles(s, replacement);
  await unchanged(f, f.store.approveBaseline(f.project.id, approveInput(f, old)), 'BASELINE_CHANGED');
  assert.equal(readAcceptanceSnapshot(s.runId, { root: f.root }).integrity.valid, true);
  assert.notEqual(currentProjection(f, s).contentDigest, old.contentDigest);
});

test('owner loss after rolling backup rejects each baseline write without publishing an event', async t => {
  for (const operation of ['candidate', 'approval', 'selection']) await t.test(operation, async t => {
    const f = await fixture(t), s = await source(f);
    const old = operation === 'candidate' ? null : await candidate(f, s);
    const approved = operation === 'selection' ? await approval(f, old) : null;
    f.afterPrevious = () => { f.owned = false; };
    const before = heads(f), sourceBefore = runFiles(s);
    const action = operation === 'candidate' ? f.store.createBaselineCandidate(f.project.id, createInput(f, s))
      : operation === 'approval' ? f.store.approveBaseline(f.project.id, approveInput(f, old))
        : f.store.selectBaseline(f.project.id, selectInput(f, approved));
    await assert.rejects(action, { code: 'ACCEPTANCE_OWNER_LOST' });
    assert.deepEqual(heads(f), before); assert.deepEqual(runFiles(s), sourceBefore);
    validateAcceptanceCatalog(f.store.read());
  });
});

test('cancel keeps approved history available even when source is already absent at the final fence', async t => {
  const f = await fixture(t), s = await source(f), old = await candidate(f, s), approved = await approval(f, old);
  const first = (await f.store.selectBaseline(f.project.id, selectInput(f, approved))).selection;
  renameSync(s.dir, s.dir + '-retained');
  const cancel = (await f.store.selectBaseline(f.project.id, selectInput(f, null))).selection;
  assert.equal(cancel.previousSelectionId, first.id); assert.equal(cancel.approvalId, null);
  assert.equal(f.store.read().approvals[approved.id].candidateId, old.id);
  assert.deepEqual(currentSelectionsOf(f.store.read(), f.project.id).spec, cancel);
});

test('B2 JSON accessors and extra fields reject before evaluating hooks or writing history', async t => {
  const f = await fixture(t), s = await source(f), old = await candidate(f, s), approved = await approval(f, old);
  let getterReads = 0;
  const entries = [
    ['sourceRunId', createInput(f, s), input => f.store.createBaselineCandidate(f.project.id, input)],
    ['reason', approveInput(f, old), input => f.store.approveBaseline(f.project.id, input)],
    ['contentDigest', selectInput(f, approved), input => f.store.selectBaseline(f.project.id, input)],
  ];
  for (const [key, input, action] of entries) {
    Object.defineProperty(input, key, { get() { getterReads++; throw new Error('untrusted getter'); }, enumerable: true });
    await unchanged(f, action(input), 'INVALID_INPUT');
  }
  assert.equal(getterReads, 0);
  await unchanged(f, f.store.approveBaseline(f.project.id, { ...approveInput(f, old), current: true }), 'INVALID_INPUT');
  await unchanged(f, f.store.selectBaseline(f.project.id, { ...selectInput(f, approved), previousSelectionId: null }), 'INVALID_INPUT');
});

test('migrated B1 bindings can produce B2 history and ordered selections across restart without changing the B1 prefix', async t => {
  const f = await fixture(t), s = await source(f), original = f.store.read();
  const v1 = { schemaVersion: 1, generationId: original.generationId, revision: original.revision,
    projects: original.projects, releases: original.releases, runBindings: original.runBindings, events: original.events };
  const oldBytes = jsonBytes(v1);
  writeFileSync(join(f.root, 'catalog.json'), oldBytes); writeFileSync(join(f.root, 'catalog.previous.json'), oldBytes);
  f.store = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  const migrated = await f.store.initialize();
  assert.equal(migrated.revision, v1.revision + 1);
  assert.deepEqual(migrated.events.slice(0, v1.revision), v1.events);
  assert.deepEqual(migrated.runBindings, v1.runBindings);
  const old = await candidate(f, s), approved = await approval(f, old);
  const first = (await f.store.selectBaseline(f.project.id, selectInput(f, approved))).selection;
  const cancel = (await f.store.selectBaseline(f.project.id, selectInput(f, null))).selection;
  const rollback = (await f.store.selectBaseline(f.project.id, selectInput(f, approved))).selection;
  assert.equal(cancel.previousSelectionId, first.id); assert.equal(rollback.previousSelectionId, cancel.id);
  const before = heads(f), restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  await restarted.initialize(); assert.deepEqual(heads(f), before);
  assert.deepEqual(currentSelectionsOf(restarted.read(), f.project.id).spec, rollback);
  assert.deepEqual(restarted.read().events.slice(0, v1.revision), v1.events);
  validateAcceptanceCatalog(restarted.read());
});
