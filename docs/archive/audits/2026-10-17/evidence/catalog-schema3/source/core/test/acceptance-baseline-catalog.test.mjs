import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { currentSelectionsOf } from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { normalizeAcceptancePlan } from '../src/acceptance/schema.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { handleAcceptanceCatalogRequest } from '../src/acceptance/catalog-api.mjs';
import { startAcceptanceApiFixture } from './fixtures/acceptance-api.mjs';

const uid = prefix => prefix + '-' + randomUUID();
const TARGET = 'http://127.0.0.1:32987/app?revision=1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const digest = dir => Object.fromEntries(readdirSync(dir).sort().map(file => [file, hash(readFileSync(join(dir, file)))]));
const bytes = f => readFileSync(join(f.root, 'catalog.json'));
const candidateInput = (f, runId) => ({ ...cas(f.store), mode: 'spec', sourceRunId: runId, sourceSide: 'source' });
const approvalInput = (f, candidate) => ({ ...cas(f.store), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: '确认已审阅完整需求' });
const selectInput = (f, approval) => ({ ...cas(f.store), mode: 'spec', approvalId: approval?.id ?? null,
  contentDigest: approval?.contentDigest ?? null, reason: approval ? '选用这份已批准需求' : '取消当前选用' });
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-baseline-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = { root, owner: { root, assertOwned() {} } };
  f.store = createAcceptanceCatalogStore({ root, owner: f.owner, ...options });
  await f.store.initialize();
  f.project = (await f.store.createProject({ ...cas(f.store), name: '合同验收' })).project;
  f.release = (await f.store.createRelease(f.project.id, { ...cas(f.store), label: 'v1', targetUrl: options.targetUrl ?? TARGET })).release;
  return f;
}
async function source(f, { approved = false, path = '/quota', omissions = [], bind = true } = {}) {
  const plan = normalizeAcceptancePlan({ schemaVersion: 1, mode: 'spec', name: '需求合同来源', targetUrl: f.release.targetUrl,
    timeoutMs: 1000, spec: { source: { id: 'REQ-QUOTA', revision: 'v1', type: 'manual' }, approved, omissions,
      checks: [{ id: 'QUOTA', title: '配额正常', method: 'GET', path, severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });
  const run = createAcceptanceRun(plan, { root: f.root }), dir = acceptanceRunDir(run.runId, f.root);
  const report = finishAcceptanceRun(run.runId, await runAcceptance(plan, { outputDir: dir }), { root: f.root });
  if (bind) await f.store.bindRun(f.project.id, { ...cas(f.store), runId: run.runId, releaseId: f.release.id });
  return { runId: run.runId, dir, report, original: digest(dir) };
}
async function rejectUnchanged(f, promise, code) {
  const before = bytes(f);
  await assert.rejects(promise, { code });
  assert.deepEqual(bytes(f), before);
}
async function candidateAndApproval(f, runId) {
  const { candidate } = await f.store.createBaselineCandidate(f.project.id, candidateInput(f, runId));
  const { approval } = await f.store.approveBaseline(f.project.id, approvalInput(f, candidate));
  return { candidate, approval };
}

test('complete draft creates a candidate, approval leaves current empty, selection/cancel/reselect retain immutable history', async t => {
  const f = await fixture(t), s = await source(f);
  assert.equal(s.report.gate, 'blocked');
  assert.equal(s.report.checks[0].evidence.request, undefined);
  const created = await f.store.createBaselineCandidate(f.project.id, candidateInput(f, s.runId));
  const { candidate } = created;
  assert.equal(candidate.mode, 'spec'); assert.equal(candidate.source.side, 'source');
  assert.equal(created.executionReady, false); assert.ok(created.preview);
  const preview = f.store.readBaselineCandidate(f.project.id, candidate.id);
  assert.equal(preview.diagnostics.eligible, true); assert.equal(preview.diagnostics.contentMatches, true);
  const { approval } = await f.store.approveBaseline(f.project.id, approvalInput(f, candidate));
  assert.deepEqual(currentSelectionsOf(f.store.read(), f.project.id), { spec: null });
  const chosen = await f.store.selectBaseline(f.project.id, selectInput(f, approval));
  assert.equal(chosen.executionReady, false); assert.equal(chosen.selection.previousSelectionId, null);
  await rejectUnchanged(f, f.store.selectBaseline(f.project.id, selectInput(f, approval)), 'SELECTION_UNCHANGED');
  const canceled = await f.store.selectBaseline(f.project.id, selectInput(f, null));
  assert.equal(canceled.selection.previousSelectionId, chosen.selection.id);
  assert.equal(canceled.selection.approvalId, null);
  await rejectUnchanged(f, f.store.selectBaseline(f.project.id, selectInput(f, null)), 'SELECTION_UNCHANGED');
  const reselected = await f.store.selectBaseline(f.project.id, selectInput(f, approval));
  assert.equal(reselected.selection.previousSelectionId, canceled.selection.id);
  const catalog = f.store.read(); validateAcceptanceCatalog(catalog);
  assert.equal(Object.keys(catalog.selections).length, 3);
  assert.deepEqual(currentSelectionsOf(catalog, f.project.id).spec, reselected.selection);
  assert.equal(catalog.events.length, catalog.revision);
  assert.deepEqual(digest(s.dir), s.original);
  const saved = bytes(f);
  const reloaded = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  await reloaded.initialize(); assert.deepEqual(bytes(f), saved);
  assert.equal(reloaded.readBaselineCandidate(f.project.id, candidate.id).diagnostics.eligible, true);
});

test('failed target results can supply requirements without turning observed response into expected', async t => {
  const api = await startAcceptanceApiFixture(); t.after(() => api.close());
  const f = await fixture(t, { targetUrl: api.targetUrl });
  const s = await source(f, { approved: true, path: '/wrong-code' });
  assert.equal(s.report.gate, 'failed'); const requests = api.requests.length;
  const { candidate, approval } = await candidateAndApproval(f, s.runId);
  const preview = f.store.readBaselineCandidate(f.project.id, candidate.id);
  assert.equal(preview.diagnostics.eligible, true);
  await f.store.selectBaseline(f.project.id, selectInput(f, approval));
  assert.equal(api.requests.length, requests);
  assert.deepEqual(digest(s.dir), s.original);
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'report.json'))).gate, 'failed');
});

test('source binding, mode, side, exact project and strict write field checks precede any successful event', async t => {
  const f = await fixture(t), s = await source(f, { bind: false });
  await rejectUnchanged(f, f.store.createBaselineCandidate(f.project.id, candidateInput(f, s.runId)), 'SOURCE_NOT_ELIGIBLE');
  await f.store.bindRun(f.project.id, { ...cas(f.store), runId: s.runId, releaseId: f.release.id });
  const other = (await f.store.createProject({ ...cas(f.store), name: '另一个项目' })).project;
  await rejectUnchanged(f, f.store.createBaselineCandidate(other.id, candidateInput(f, s.runId)), 'PROJECT_MISMATCH');
  for (const patch of [{ mode: 'mirror' }, { sourceSide: 'target' }, { sourceSide: 'requirements' }, { actor: {} },
    { sourceReportDigest: 'a'.repeat(64) }, { sourceRunId: '../outside' }, { selectCurrent: true }]) {
    await rejectUnchanged(f, f.store.createBaselineCandidate(f.project.id, { ...candidateInput(f, s.runId), ...patch }), 'INVALID_INPUT');
  }
  const { candidate, approval } = await candidateAndApproval(f, s.runId);
  await rejectUnchanged(f, f.store.approveBaseline(other.id, approvalInput(f, candidate)), 'PROJECT_MISMATCH');
  await rejectUnchanged(f, f.store.selectBaseline(other.id, selectInput(f, approval)), 'PROJECT_MISMATCH');
  for (const patch of [{ contentDigest: 'b'.repeat(64) }, { reason: '' }, { actor: { kind: 'local-operator' } }]) {
    await rejectUnchanged(f, f.store.approveBaseline(f.project.id, { ...approvalInput(f, candidate), ...patch }), patch.contentDigest ? 'BASELINE_CHANGED' : 'INVALID_INPUT');
  }
  await rejectUnchanged(f, f.store.selectBaseline(f.project.id, { ...selectInput(f, approval), mode: 'regression' }), 'INVALID_INPUT');
  await rejectUnchanged(f, f.store.selectBaseline(f.project.id, { ...selectInput(f, null), contentDigest: candidate.contentDigest }), 'INVALID_INPUT');
  assert.deepEqual(digest(s.dir), s.original);
});

test('source evidence mutation after preview rejects approval and selection, yet missing source can be canceled', async t => {
  const f = await fixture(t), s = await source(f);
  const { candidate, approval } = await candidateAndApproval(f, s.runId);
  await f.store.selectBaseline(f.project.id, selectInput(f, approval));
  const file = join(s.dir, s.report.checks[0].evidence.contract), original = readFileSync(file);
  writeFileSync(file, Buffer.alloc(original.length, 32));
  const changed = f.store.readBaselineCandidate(f.project.id, candidate.id);
  assert.equal(changed.preview, null); assert.equal(changed.diagnostics.eligible, false);
  assert.equal(changed.candidate.contentDigest, candidate.contentDigest);
  await rejectUnchanged(f, f.store.approveBaseline(f.project.id, approvalInput(f, candidate)), 'SOURCE_INTEGRITY_FAILED');
  const prior = (await f.store.selectBaseline(f.project.id, selectInput(f, null))).selection;
  await rejectUnchanged(f, f.store.selectBaseline(f.project.id, selectInput(f, approval)), 'SOURCE_INTEGRITY_FAILED');
  writeFileSync(file, original);
  await f.store.selectBaseline(f.project.id, selectInput(f, approval));
  renameSync(s.dir, s.dir + '-retained');
  const missing = f.store.readBaselineCandidate(f.project.id, candidate.id);
  assert.equal(missing.diagnostics.eligible, false); assert.equal(missing.preview, null);
  await f.store.selectBaseline(f.project.id, selectInput(f, null));
  assert.equal(f.store.read().selections[prior.id].approvalId, null);
  assert.equal(Object.keys(f.store.read().approvals).length, 1);
});

test('incomplete scopes and legacy metadata cannot become an approved baseline', async t => {
  const f = await fixture(t);
  const incomplete = await source(f, { omissions: [{ id: 'write', method: 'POST', path: '/write', reason: '不可只读验收' }] });
  await rejectUnchanged(f, f.store.createBaselineCandidate(f.project.id, candidateInput(f, incomplete.runId)), 'SOURCE_NOT_ELIGIBLE');
  const legacy = await source(f), file = join(legacy.dir, 'manifest.json'), manifest = JSON.parse(readFileSync(file));
  delete manifest.reportSha256; writeFileSync(file, JSON.stringify(manifest));
  await rejectUnchanged(f, f.store.createBaselineCandidate(f.project.id, candidateInput(f, legacy.runId)), 'SOURCE_INTEGRITY_FAILED');
});

test('candidate approval and selection writes each have exactly one double-CAS winner', async t => {
  const f = await fixture(t), s = await source(f);
  const request = candidateInput(f, s.runId);
  const candidates = await Promise.allSettled([f.store.createBaselineCandidate(f.project.id, request), f.store.createBaselineCandidate(f.project.id, request)]);
  assert.deepEqual(candidates.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(candidates.find(item => item.status === 'rejected').reason.code, 'STALE_REVISION');
  const candidate = candidates.find(item => item.status === 'fulfilled').value.candidate;
  const approvalRequest = approvalInput(f, candidate);
  const approvals = await Promise.allSettled([f.store.approveBaseline(f.project.id, approvalRequest), f.store.approveBaseline(f.project.id, approvalRequest)]);
  assert.equal(approvals.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(approvals.find(item => item.status === 'rejected').reason.code, 'STALE_REVISION');
  const approval = approvals.find(item => item.status === 'fulfilled').value.approval, selectionRequest = selectInput(f, approval);
  const selections = await Promise.allSettled([f.store.selectBaseline(f.project.id, selectionRequest), f.store.selectBaseline(f.project.id, selectionRequest)]);
  assert.equal(selections.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(selections.find(item => item.status === 'rejected').reason.code, 'STALE_REVISION');
  const restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner }); await restarted.initialize();
  assert.equal(restarted.read().revision, 6);
});

test('schema rejects forged references, recomputed event digests and broken ordered selection chains', async t => {
  const f = await fixture(t), s = await source(f), { candidate, approval } = await candidateAndApproval(f, s.runId);
  await f.store.selectBaseline(f.project.id, selectInput(f, approval));
  await f.store.selectBaseline(f.project.id, selectInput(f, null));
  const catalog = f.store.read();
  for (const mutate of [
    value => { value.candidates[candidate.id].source.side = 'target'; },
    value => { value.candidates[candidate.id].contentDigest = 'f'.repeat(64); value.approvals[approval.id].contentDigest = 'f'.repeat(64); },
    value => { value.candidates[candidate.id].executionReady = true; },
    value => { value.approvals[approval.id].candidateId = uid('ab'); },
    value => { Object.values(value.selections).at(-1).previousSelectionId = null; },
    value => { Object.values(value.selections).at(-1).approvalId = approval.id; },
    value => { value.events[3].kind = 'baseline-approved'; },
    value => { [value.events[3], value.events[4]] = [value.events[4], value.events[3]]; value.events.forEach((event, i) => { event.revision = i + 1; }); },
  ]) {
    const changed = structuredClone(catalog); mutate(changed);
    for (const event of changed.events) {
      const entity = ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections'].map(key => changed[key][event.entityId]).find(Boolean);
      if (entity) event.entityDigest = hashAcceptanceValue(entity);
    }
    assert.throws(() => validateAcceptanceCatalog(changed), { code: 'CATALOG_UNAVAILABLE' });
  }
});

test('capacity failure preserves candidate history and source bytes without a success event', async t => {
  const f = await fixture(t, { limits: { approvals: 0 } }), s = await source(f);
  const { candidate } = await f.store.createBaselineCandidate(f.project.id, candidateInput(f, s.runId));
  await rejectUnchanged(f, f.store.approveBaseline(f.project.id, approvalInput(f, candidate)), 'CATALOG_CAPACITY');
  assert.deepEqual(digest(s.dir), s.original);
});

test('real HTTP baseline flow exposes storage facts, exact routes and currently verified previews', async t => {
  const f = await fixture(t), s = await source(f);
  const server = createServer(async (req, res) => {
    const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (!await handleAcceptanceCatalogRequest(req, res, new URL(req.url, 'http://local'), { catalog: f.store, json })) json(res, 404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/acceptance/projects/${f.project.id}`;
  const post = async (suffix, body) => {
    const response = await fetch(base + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 201, JSON.stringify(value)); return value;
  };
  const { candidate } = await post('/baseline-candidates', candidateInput(f, s.runId));
  const response = await fetch(base + '/baseline-candidates/' + candidate.id);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).diagnostics.eligible, true);
  const { approval } = await post('/baseline-approvals', approvalInput(f, candidate));
  let detail = await (await fetch(base)).json(); assert.equal(detail.currentSelections.spec, null);
  await post('/baseline-selections', selectInput(f, approval));
  detail = await (await fetch(base)).json();
  assert.equal(detail.candidates.length, 1); assert.equal(detail.approvals.length, 1); assert.equal(detail.selections.length, 1);
  assert.equal(detail.currentSelections.spec.approvalId, approval.id); assert.equal(detail.executionReady, false);
  assert.equal((await fetch(base + '/baseline-candidates')).status, 405);
  assert.equal((await fetch(base + '/baseline-candidates/not-an-id')).status, 400);
  assert.equal((await fetch(base + '/baseline-candidates/' + candidate.id + '/extra')).status, 404);
  assert.equal((await fetch(base + '/baseline-approvals/' + approval.id)).status, 404);
  assert.deepEqual(digest(s.dir), s.original);
});
