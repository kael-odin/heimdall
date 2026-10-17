import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun, updateAcceptanceRun, acceptanceArtifact, readAcceptanceSnapshot } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { createManagedSpecDispatchReadContext } from '../src/acceptance/managed-dispatch-reader.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress, finishManagedAcceptanceRun, settleManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const snapshot = dir => Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, sha(fs.readFileSync(join(dir, name)))]));
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const safeFailure = action => assert.throws(action, error => {
  assert.ok(error.status >= 400); assert.ok(typeof error.code === 'string');
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});
const settlement = { status: 'interrupted', reasonCode: 'CANCELLED', error: '已取消，保留现场。' };

async function fixture(t, paths = ['/healthy', '/bug']) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-run-store-'))), requests = [];
  const owner = acquireAcceptanceOwner({ root });
  const server = createServer((request, response) => {
    requests.push(request.url); response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/slow')) return;
    response.end(request.url.endsWith('/bug') ? '{"code":9}' : '{"code":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const plan = normalizeSpecPlan({ name: 'owner-bound managed facts', mode: 'spec', targetUrl: base + '/source', timeoutMs: 1000,
    spec: { source: { id: 'REQ-STORE', revision: '1', type: 'manual' }, approved: false,
      checks: paths.map((path, index) => ({ id: 'check-' + index, title: path, method: 'GET', path, severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize({ createSchemaVersion: 3 });
  const project = (await catalog.createProject({ ...cas(catalog), name: 'managed store fixture' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'source', targetUrl: plan.targetUrl })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'target', targetUrl: base + '/target' })).release;
  const source = createAcceptanceRun(plan, { root }), sourceDir = join(root, source.runId);
  finishAcceptanceRun(source.runId, await runSpecAcceptance(plan, { runId: source.runId, outputDir: sourceDir }), { root });
  await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: source.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: 'approved' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id, contentDigest: candidate.contentDigest, reason: 'selected' })).selection;
  const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  const e = JSON.parse(record.bytes.toString('utf8')), ref = { operationId: e.operationId, dispatchSha256: record.sha256 };
  const dir = join(root, e.runId), manifestPath = join(dir, 'manifest.json'), reportPath = join(dir, 'report.json');
  const opts = { owner, assertActive: () => true };
  assert.equal(requests.length, 0); assert.equal(fs.existsSync(dir), false);
  const originalSource = snapshot(sourceDir);
  return { root, owner, e, ref, dir, manifestPath, reportPath, opts, requests, sourceDir, originalSource,
    sidecar: join(root, 'managed-spec-dispatches', 'v1', e.operationId + '.json'),
    raw: () => runSpecAcceptance(e.plan, { runId: e.runId, outputDir: dir }) };
}

test('fixed managed identity accepts real BUG results, commits terminal last and preserves original source bytes', async t => {
  const f = await fixture(t), manifest = createManagedAcceptanceRun(f.ref, f.opts);
  assert.equal(manifest.runId, f.e.runId); assert.equal(manifest.taskId, f.e.taskId);
  assert.deepEqual(manifest.plan, f.e.plan); assert.equal(manifest.managed.source.sourceSpecApproved, false);
  assert.equal(manifest.plan.spec.approved, true); assert.equal(f.requests.length, 0);
  updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-started', total: 2, completed: 0 } }, f.opts);
  const raw = await f.raw(), forged = copy(raw);
  for (const check of forged.checks) if (check.status === 'failed') { check.status = 'passed'; check.verdict = 'match'; }
  safeFailure(() => finishManagedAcceptanceRun(f.ref, forged, f.opts));
  assert.equal(fs.existsSync(f.reportPath), false); assert.equal(json(f.manifestPath).status, 'running');
  const report = finishManagedAcceptanceRun(f.ref, raw, f.opts), terminal = json(f.manifestPath);
  assert.equal(f.requests.length, 2); assert.equal(report.gate, 'failed'); assert.equal(report.summary.bugs, 1);
  assert.equal(terminal.status, 'completed'); assert.equal(terminal.gate, 'failed');
  assert.equal(terminal.reportSha256, sha(fs.readFileSync(f.reportPath)));
  assert.deepEqual(report.checks, raw.checks); assert.deepEqual(report.managed, terminal.managed);
  assert.equal(report.taskId, f.e.taskId); assert.equal(report.planFingerprint, f.e.planFingerprint);
  assert.equal(report.verifierFingerprint, json(join(f.sourceDir, 'report.json')).verifierFingerprint);
  assert.ok(report.evidenceManifest.length >= 3); assert.equal(fs.existsSync(join(f.dir, 'report.md')), false);
  for (const item of report.evidenceManifest) assert.equal(item.sha256, sha(fs.readFileSync(join(f.dir, item.file))));
  assert.deepEqual(snapshot(f.sourceDir), f.originalSource);
  const before = snapshot(f.dir);
  for (const action of [() => createManagedAcceptanceRun(f.ref, f.opts), () => finishManagedAcceptanceRun(f.ref, raw, f.opts), () => settleManagedAcceptanceRun(f.ref, settlement, { owner: f.owner }),
    () => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, f.opts),
    () => updateAcceptanceRun(f.e.runId, { status: 'running' }, { root: f.root }),
    () => finishAcceptanceRun(f.e.runId, raw, { root: f.root }), () => acceptanceArtifact(f.e.runId, 'report.json', { root: f.root })]) safeFailure(action);
  assert.deepEqual(snapshot(f.dir), before);
  const verified = readAcceptanceSnapshot(f.e.runId, { root: f.root });
  assert.equal(verified.integrity.valid, true); assert.equal(verified.integrity.evidenceVerified, true);
  assert.equal(verified.report.gate, 'failed'); assert.equal(verified.report.summary.bugs, 1);
});

test('real request timeout remains completed and environment-blocked', async t => {
  const f = await fixture(t, ['/slow']); createManagedAcceptanceRun(f.ref, f.opts);
  const raw = await f.raw(), report = finishManagedAcceptanceRun(f.ref, raw, f.opts);
  assert.equal(raw.checks[0].actual.errorCode, 'REQUEST_TIMEOUT');
  assert.equal(report.checks[0].verdict, 'environment'); assert.equal(report.gate, 'blocked');
  assert.equal(json(f.manifestPath).status, 'completed'); assert.equal(f.requests.length, 1);
});

test('failure after exclusive mkdir preserves partial identity without publishing or retrying another run', async t => {
  const f = await fixture(t);
  assert.throws(() => createManagedAcceptanceRun(f.ref, { ...f.opts, assertActive: () => !fs.existsSync(f.dir) }), error => {
    assert.equal(error.writeMayHaveCommitted, false); return true;
  });
  assert.equal(fs.existsSync(f.dir), true); assert.deepEqual(fs.readdirSync(f.dir), []);
  safeFailure(() => createManagedAcceptanceRun(f.ref, f.opts));
  assert.equal(fs.existsSync(f.manifestPath), false); assert.equal(f.requests.length, 0);
});

test('exclusive fixed directory refuses empty, partial, complete and linked collisions without choosing another ID', async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.dir); safeFailure(() => createManagedAcceptanceRun(f.ref, f.opts));
  fs.writeFileSync(join(f.dir, 'partial.json'), 'partial');
  safeFailure(() => createManagedAcceptanceRun(f.ref, f.opts)); assert.equal(fs.readFileSync(join(f.dir, 'partial.json'), 'utf8'), 'partial');
  fs.renameSync(f.dir, f.dir + '-original');
  fs.symlinkSync(f.dir + '-original', f.dir, process.platform === 'win32' ? 'junction' : 'dir');
  safeFailure(() => createManagedAcceptanceRun(f.ref, f.opts)); fs.unlinkSync(f.dir);
  fs.renameSync(f.dir + '-original', f.dir);
  assert.equal(f.requests.length, 0); assert.equal(fs.existsSync(f.manifestPath), false);
});

test('only actual owner and synchronous active guard can create; invalid controls execute no hooks or requests', async t => {
  const f = await fixture(t); let hooks = 0;
  const fake = { get root() { hooks++; throw Error('SECRET'); }, assertOwned() { hooks++; return true; } };
  for (const owner of [fake, { ...f.owner }, new Proxy(f.owner, { get() { hooks++; throw Error('SECRET'); } })]) {
    safeFailure(() => createManagedAcceptanceRun(f.ref, { ...f.opts, owner }));
  }
  const thenable = { get then() { hooks++; throw Error('SECRET'); } };
  for (const result of [false, null, 0, 'true', {}, thenable, () => true, Promise.reject(Error('SECRET'))]) {
    safeFailure(() => createManagedAcceptanceRun(f.ref, { ...f.opts, assertActive: () => result }));
  }
  safeFailure(() => createManagedAcceptanceRun(f.ref, { ...f.opts, assertActive: async () => { throw Error('SECRET'); } }));
  safeFailure(() => createManagedAcceptanceRun({ ...f.ref, runId: f.e.runId }, f.opts));
  safeFailure(() => createManagedAcceptanceRun(f.ref, { ...f.opts, root: f.root }));
  safeFailure(() => createManagedAcceptanceRun({ ...f.ref, dispatchSha256: 'a'.repeat(64) }, f.opts));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks, 0); assert.equal(f.requests.length, 0); assert.equal(fs.existsSync(f.dir), false);
});

test('released and changed owner reject before publication, and owner loss never settles', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.opts); const before = snapshot(f.dir);
  const lock = join(f.root, ACCEPTANCE_OWNER_FILE), original = fs.readFileSync(lock), changed = json(lock);
  changed.nonce = 'a'.repeat(64); fs.writeFileSync(lock, JSON.stringify(changed));
  safeFailure(() => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, f.opts));
  safeFailure(() => settleManagedAcceptanceRun(f.ref, settlement, { owner: f.owner }));
  assert.deepEqual(snapshot(f.dir), before);
  fs.writeFileSync(lock, original); f.owner.release();
  safeFailure(() => createManagedAcceptanceRun(f.ref, f.opts)); assert.deepEqual(snapshot(f.dir), before);
});

test('cancellation blocks progress but settlement still requires live owner and keeps narrow interrupted facts', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.opts); const before = snapshot(f.dir);
  safeFailure(() => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, { ...f.opts, assertActive: () => false }));
  assert.deepEqual(snapshot(f.dir), before);
  let activeCalls = 0;
  const result = settleManagedAcceptanceRun(f.ref, settlement, { owner: f.owner, assertActive: () => { activeCalls++; throw Error(); } });
  assert.equal(activeCalls, 0); assert.equal(result.status, 'interrupted'); assert.equal(result.gate, 'blocked');
  assert.deepEqual(result.managed, json(f.manifestPath).managed); assert.equal(fs.existsSync(f.reportPath), false);
  safeFailure(() => settleManagedAcceptanceRun(f.ref, settlement, { owner: f.owner }));
  assert.equal(f.requests.length, 0);
});

test('partial report never resumes finish; interrupted settlement preserves published report bytes', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.opts); const raw = await f.raw();
  assert.throws(() => finishManagedAcceptanceRun(f.ref, raw, { ...f.opts, assertActive: () => !fs.existsSync(f.reportPath) }), error => {
    assert.equal(error.writeMayHaveCommitted, true); return true;
  });
  assert.equal(fs.existsSync(f.reportPath), true); assert.equal(json(f.manifestPath).status, 'running');
  const reportBytes = fs.readFileSync(f.reportPath);
  safeFailure(() => finishManagedAcceptanceRun(f.ref, raw, f.opts));
  safeFailure(() => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, f.opts));
  settleManagedAcceptanceRun(f.ref, { ...settlement, reasonCode: 'ENGINE_RESTARTED' }, { owner: f.owner });
  assert.equal(json(f.manifestPath).status, 'interrupted'); assert.deepEqual(fs.readFileSync(f.reportPath), reportBytes);
});

test('invalid raw, reserved evidence, links and byte/count budgets never publish a reliable report', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.opts); const raw = await f.raw(), before = fs.readFileSync(f.manifestPath);
  for (const key of ['managed', 'taskId', 'summary', 'gate']) {
    safeFailure(() => finishManagedAcceptanceRun(f.ref, { ...raw, [key]: null }, f.opts));
  }
  const reserved = copy(raw); reserved.checks[0].evidence.contract = 'manifest.json';
  safeFailure(() => finishManagedAcceptanceRun(f.ref, reserved, f.opts));
  const name = raw.checks[0].evidence.contract, path = join(f.dir, name), bytes = fs.readFileSync(path);
  fs.linkSync(path, path + '.linked'); safeFailure(() => finishManagedAcceptanceRun(f.ref, raw, f.opts)); fs.unlinkSync(path + '.linked');
  const responsePath = join(f.dir, raw.checks[0].evidence.response), responseBytes = fs.readFileSync(responsePath);
  for (const replacement of [Buffer.from('{"bad":}'), bytes]) {
    fs.writeFileSync(responsePath, replacement); safeFailure(() => finishManagedAcceptanceRun(f.ref, raw, f.opts));
    assert.deepEqual(fs.readFileSync(f.manifestPath), before); assert.equal(fs.existsSync(f.reportPath), false);
  }
  fs.writeFileSync(responsePath, responseBytes);
  for (const limits of [{ evidenceFiles: 0 }, { evidenceFileBytes: 0 }, { evidenceBytes: 0 }, { checks: 0 }, { jsonBytes: 1 }]) {
    safeFailure(() => finishManagedAcceptanceRun(f.ref, raw, { ...f.opts, limits }));
  }
  assert.deepEqual(fs.readFileSync(path), bytes); assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  assert.equal(fs.existsSync(f.reportPath), false);
});

test('fresh sidecar and run identity fence each write and preserve changes rather than repairing them', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.opts);
  const context = createManagedSpecDispatchReadContext({ root: f.root }), bytes = fs.readFileSync(f.sidecar);
  fs.writeFileSync(f.sidecar, Buffer.concat([bytes, Buffer.from(' ')])); const before = snapshot(f.dir);
  safeFailure(() => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, { ...f.opts, managedRead: context }));
  safeFailure(() => settleManagedAcceptanceRun(f.ref, settlement, { owner: f.owner }));
  assert.deepEqual(snapshot(f.dir), before); fs.writeFileSync(f.sidecar, bytes);
  const originalManifest = fs.readFileSync(f.manifestPath);
  let changed = false, calls = 0;
  safeFailure(() => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, { ...f.opts, assertActive: () => {
    if (++calls === 3) {
      changed = true; fs.renameSync(f.dir, f.dir + '-original'); fs.mkdirSync(f.dir);
    } return true;
  } }));
  assert.equal(changed, true); assert.deepEqual(fs.readFileSync(join(f.dir + '-original', 'manifest.json')), originalManifest);
  assert.equal(fs.existsSync(f.manifestPath), false);
});
