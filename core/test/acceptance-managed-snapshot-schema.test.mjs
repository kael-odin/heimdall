import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { ManagedAcceptanceRunError } from '../src/acceptance/managed-run-schema.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress, finishManagedAcceptanceRun, settleManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';
import { validateManagedRunHead, validateManagedCompletedSnapshot } from '../src/acceptance/managed-snapshot-schema.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const cloneFiles = files => new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
const rejected = action => assert.throws(action, error => {
  assert.ok(error instanceof ManagedAcceptanceRunError);
  assert.equal(error.code, 'MANAGED_RUN_INTEGRITY_FAILED'); assert.equal(error.status, 409);
  assert.deepEqual(error.details, { reason: 'INVALID_INPUT' });
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});
const headInput = f => ({ record: f.record, manifestBytes: f.manifestBytes, manifest: f.manifest });
const inputOf = f => ({ ...headInput(f), manifest: copy(f.manifest), report: copy(f.report), reportBytes: Buffer.from(f.reportBytes), files: cloneFiles(f.files) });
const repack = input => {
  input.reportBytes = encode(input.report);
  if (input.manifest.status === 'completed') input.manifest.reportSha256 = sha(input.reportBytes);
  input.manifestBytes = encode(input.manifest); return input;
};
const resummarize = input => {
  input.report = summarizeAcceptanceReport(input.report);
  input.manifest.gate = input.report.gate; input.manifest.summary = copy(input.report.summary);
  return repack(input);
};

async function fixture(t, paths = ['/healthy', '/bug', '/large'], complete = true) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-snapshot-'))), requests = [];
  const owner = acquireAcceptanceOwner({ root });
  const server = createServer((request, response) => {
    requests.push(request.url); response.setHeader('content-type', 'application/json');
    response.end(request.url.endsWith('/bug') ? '{"code":9}' : request.url.endsWith('/large')
      ? JSON.stringify({ code: 0, payload: 'x'.repeat(2048) }) : '{"code":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const plan = normalizeSpecPlan({ name: 'pure managed snapshot', mode: 'spec', targetUrl: base + '/source', maxResponseBytes: 1024,
    spec: { source: { id: 'REQ-SNAPSHOT', revision: '1', type: 'manual' }, approved: false,
      checks: paths.map((path, index) => ({ id: 'check-' + index, title: path, method: 'GET', path, severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize({ createSchemaVersion: 3 });
  const project = (await catalog.createProject({ ...cas(catalog), name: 'snapshot fixture' })).project;
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
  const envelope = JSON.parse(record.bytes), ref = { operationId: envelope.operationId, dispatchSha256: record.sha256 };
  const options = { owner, assertActive: () => true }, dir = join(root, envelope.runId);
  createManagedAcceptanceRun(ref, options);
  const runningBytes = fs.readFileSync(join(dir, 'manifest.json')), running = JSON.parse(runningBytes);
  assert.equal(requests.length, 0);
  const f = { record, envelope, root, dir, ref, options, requests, runningBytes, running,
    manifestBytes: runningBytes, manifest: running };
  if (!complete) return f;
  const raw = await runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: dir });
  finishManagedAcceptanceRun(ref, raw, options);
  f.manifestBytes = fs.readFileSync(join(dir, 'manifest.json')); f.manifest = JSON.parse(f.manifestBytes);
  f.reportBytes = fs.readFileSync(join(dir, 'report.json')); f.report = JSON.parse(f.reportBytes);
  f.files = new Map(f.report.evidenceManifest.map(entry => [entry.file, fs.readFileSync(join(dir, entry.file))]));
  return f;
}

test('real writer completed passed, BUG failed and budget blocked are all valid strong snapshots', async t => {
  for (const [path, gate] of [['/healthy', 'passed'], ['/bug', 'failed'], ['/large', 'blocked']]) await t.test(gate, async t => {
    const f = await fixture(t, [path]), input = inputOf(f), before = inputOf(f);
    const result = validateManagedCompletedSnapshot(input);
    assert.deepEqual(Object.keys(result).sort(), ['binding', 'snapshot']);
    assert.deepEqual(Object.keys(result.snapshot).sort(), ['integrity', 'manifest', 'report']);
    assert.deepEqual(Object.keys(result.snapshot.integrity).sort(), ['errors', 'evidenceVerified', 'reportSha256', 'valid', 'verifiedBytes', 'verifiedFiles']);
    assert.equal(result.snapshot.manifest.status, 'completed'); assert.equal(result.snapshot.report.gate, gate);
    assert.equal(result.snapshot.integrity.evidenceVerified, true); assert.equal(result.snapshot.integrity.valid, true);
    assert.equal(result.snapshot.integrity.verifiedFiles, f.files.size);
    assert.equal(result.snapshot.integrity.verifiedBytes, [...f.files.values()].reduce((total, bytes) => total + bytes.length, 0));
    assert.equal(result.snapshot.integrity.reportSha256, sha(f.reportBytes));
    assert.equal(result.binding.projectId, f.envelope.project.id); assert.equal(result.binding.targetReleaseId, f.envelope.targetRelease.id);
    assert.equal(result.binding.dispatchSha256, f.record.sha256); assert.equal(result.binding.reportSha256, sha(f.reportBytes));
    assert.ok(Object.isFrozen(result.binding)); assert.equal(f.requests.length, 1);
    assert.deepEqual(input, before); assert.notEqual(result.snapshot.manifest, input.manifest);
    result.snapshot.report.checks[0].expected.status = 599; result.snapshot.manifest.plan.name = 'changed';
    assert.equal(input.report.checks[0].expected.status, 200); assert.equal(input.manifest.plan.name, f.envelope.plan.name);
    assert.equal(f.requests.length, 1); // Pure revalidation issued no target request.
  });
});

test('head validation distinguishes running and both settled states without manufacturing a snapshot', async t => {
  const f = await fixture(t, ['/healthy'], false);
  let result = validateManagedRunHead(headInput(f));
  assert.equal(result.manifest.status, 'running'); assert.equal(result.binding.reportSha256, null);
  assert.deepEqual(Object.keys(result).sort(), ['binding', 'manifest']);
  updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-check', completed: 1, total: 1, viewport: 'api' } }, f.options);
  const progressBytes = fs.readFileSync(join(f.dir, 'manifest.json'));
  assert.equal(validateManagedRunHead({ record: f.record, manifestBytes: progressBytes, manifest: JSON.parse(progressBytes) }).manifest.progress.completed, 1);
  const raw = await runSpecAcceptance(f.envelope.plan, { runId: f.envelope.runId, outputDir: f.dir });
  const partial = summarizeAcceptanceReport(raw); // An uncommitted report is not a completed manifest.
  rejected(() => validateManagedCompletedSnapshot({ ...headInput(f), report: partial, reportBytes: encode(partial), files: new Map() }));
  assert.equal(validateManagedRunHead(headInput(f)).manifest.status, 'running');
  assert.equal(f.requests.length, 1);
  for (const status of ['interrupted', 'failed']) await t.test(status, async t => {
    const settled = await fixture(t, ['/healthy'], false);
    settleManagedAcceptanceRun(settled.ref, { status, reasonCode: 'ENGINE_RESTARTED', error: 'Engine restart preserved this run.' }, settled.options);
    const bytes = fs.readFileSync(join(settled.dir, 'manifest.json')), manifest = JSON.parse(bytes);
    result = validateManagedRunHead({ record: settled.record, manifestBytes: bytes, manifest });
    assert.equal(result.manifest.status, status); assert.equal(result.manifest.gate, 'blocked'); assert.equal(result.binding.reportSha256, null);
    rejected(() => validateManagedCompletedSnapshot({ record: settled.record, manifestBytes: bytes, manifest,
      report: partial, reportBytes: encode(partial), files: new Map() }));
    assert.equal(settled.requests.length, 0);
  });
});

test('head fields and lifecycle are strict even when linkage identity remains correct', async t => {
  const f = await fixture(t, ['/healthy']);
  const check = manifest => rejected(() => validateManagedRunHead({ record: f.record, manifest, manifestBytes: encode(manifest) }));
  for (const mutate of [manifest => { manifest.unexpected = true; }, manifest => { manifest.createdAt = 'yesterday'; },
    manifest => { manifest.updatedAt = null; }, manifest => { manifest.endedAt = 'tomorrow'; }, manifest => { manifest.error = 'SECRET'; },
    manifest => { delete manifest.reportSha256; }, manifest => { manifest.progress.total = 1; }, manifest => { manifest.progress.kind = 'acceptance-check'; },
    manifest => { manifest.reasonCode = 'CANCELLED'; }, manifest => { manifest.summary.coverage.extra = 1; },
    manifest => { manifest.summary.dimensions.behavior.score = '1'; }, manifest => { manifest.summary.total = -1; }]) {
    const manifest = copy(f.manifest); mutate(manifest); check(manifest);
  }
  for (const mutate of [manifest => { manifest.endedAt = f.manifest.endedAt; }, manifest => { manifest.reportSha256 = sha(f.reportBytes); },
    manifest => { manifest.error = null; }, manifest => { manifest.summary = f.manifest.summary; }, manifest => { manifest.gate = 'passed'; },
    manifest => { manifest.progress = { kind: 'invented-event' }; }]) {
    const manifest = copy(f.running); mutate(manifest); check(manifest);
  }
});

test('head/report original UTF-8 bytes, supplied JSON, dispatch digest and fixed identities are bound together', async t => {
  const f = await fixture(t, ['/healthy']);
  for (const mutate of [input => { input.manifest.name = 'different'; }, input => { input.report.scope = 'changed JSON only'; },
    input => { input.manifestBytes = Buffer.from([0xff]); }, input => { input.reportBytes = Buffer.from([0xff]); },
    input => { input.reportBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), input.reportBytes]); },
    input => { input.record = { ...input.record, sha256: 'a'.repeat(64) }; },
    input => { input.record = { ...input.record, bytes: Buffer.from('{}') }; }]) {
    const input = inputOf(f); mutate(input); rejected(() => validateManagedCompletedSnapshot(input));
  }
  for (const mutate of [input => { input.manifest.taskId = 'at-' + randomUUID(); }, input => { input.manifest.plan.targetUrl += '/other'; },
    input => { input.report.taskId = 'at-' + randomUUID(); }, input => { input.report.runId = 'ac-' + randomUUID(); },
    input => { input.report.planFingerprint = 'a'.repeat(64); }, input => { input.report.managed.target.releaseId = 'ar-' + randomUUID(); },
    input => { input.report.checks[0].identity.ruleKey = 'a'.repeat(64); }, input => { input.report.checks[0].expected.status = 201; },
    input => { input.manifest.endedAt = '2000-01-01T00:00:00.000Z'; }]) {
    const input = inputOf(f); mutate(input); rejected(() => validateManagedCompletedSnapshot(repack(input)));
  }
});

test('the report requires every frozen raw field and every store-owned field and rejects all wider reports', async t => {
  const f = await fixture(t, ['/healthy']);
  for (const key of Object.keys(f.report)) {
    const input = inputOf(f); delete input.report[key]; rejected(() => validateManagedCompletedSnapshot(repack(input)));
  }
  for (const key of ['unknown', 'authority', 'operationId', 'dispatchId', 'dispatchSha256', 'executor', 'baselineUrl', 'plan', 'error', 'triageAvailable']) {
    const input = inputOf(f); input.report[key] = null; rejected(() => validateManagedCompletedSnapshot(repack(input)));
  }
  const input = inputOf(f); input.report.evidenceManifest[0].unindexed = true;
  rejected(() => validateManagedCompletedSnapshot(repack(input)));
});

test('summary and gate are recomputed and even coordinated head/report relabeling cannot erase a recorded BUG', async t => {
  const f = await fixture(t, ['/bug']);
  for (const mutate of [input => { input.report.summary.passed++; }, input => { input.report.summary.dimensions.behavior.failed = 0; },
    input => { input.report.summary.coverage.ratio = 0; }, input => { input.report.gate = 'passed'; }]) {
    const input = inputOf(f); mutate(input); input.manifest.gate = input.report.gate; input.manifest.summary = copy(input.report.summary);
    rejected(() => validateManagedCompletedSnapshot(repack(input)));
  }
  const forged = inputOf(f); forged.report.checks[0].status = 'passed'; forged.report.checks[0].verdict = 'match';
  resummarize(forged); assert.equal(forged.report.gate, 'passed');
  rejected(() => validateManagedCompletedSnapshot(forged));
  const semantic = inputOf(f), response = semantic.report.checks[0].evidence.response;
  const observed = JSON.parse(semantic.files.get(response)); observed.mismatches = [];
  semantic.files.set(response, encode(observed));
  const entry = semantic.report.evidenceManifest.find(entry => entry.file === response);
  entry.bytes = semantic.files.get(response).length; entry.sha256 = sha(semantic.files.get(response));
  rejected(() => validateManagedCompletedSnapshot(repack(semantic)));
});

test('reference closure is exact and evidence byte/hash metadata cannot hide missing, extra or substituted files', async t => {
  const f = await fixture(t, ['/healthy']);
  for (const mutate of [input => { input.files.delete(input.report.evidenceManifest[0].file); },
    input => { input.files.set('extra.json', Buffer.from('{}')); }, input => { input.files.set('manifest.json', input.manifestBytes); },
    input => { input.report.evidenceManifest.push(copy(input.report.evidenceManifest[0])); }, input => { input.report.evidenceManifest.pop(); },
    input => { input.report.evidenceManifest[0].file = '../SECRET.json'; }, input => { input.report.evidenceManifest[0].file = 'triage.json'; },
    input => { input.report.evidenceManifest[0].sha256 = 'a'.repeat(64); }, input => { input.report.evidenceManifest[0].bytes++; },
    input => { input.files.set(input.report.evidenceManifest[0].file, Buffer.from('{}')); },
    input => { input.report.checks[0].evidence.contract = 'unused.json'; }]) {
    const input = inputOf(f); mutate(input); rejected(() => validateManagedCompletedSnapshot(repack(input)));
  }
});

test('historical verifier facts remain intact and safe record envelope metadata has no authority', async t => {
  const f = await fixture(t, ['/healthy']), input = inputOf(f);
  input.report.verifierFingerprint = 'a'.repeat(64);
  input.record = { ...input.record, envelope: { runId: 'SECRET', plan: { targetUrl: 'https://private.invalid' } } };
  const result = validateManagedCompletedSnapshot(repack(input));
  assert.equal(result.snapshot.report.verifierFingerprint, 'a'.repeat(64));
  assert.equal(result.snapshot.report.managed.source.verifierFingerprint, f.report.managed.source.verifierFingerprint);
  assert.equal(result.snapshot.report.runId, f.envelope.runId);
  assert.equal(result.binding.dispatchSha256, f.record.sha256);
});

test('getter, Proxy, hook, hidden-field, shared-byte and non-JSON inputs fail without executing caller code', async t => {
  const f = await fixture(t, ['/healthy']); let calls = 0;
  const getter = () => { calls++; throw new Error('SECRET C:\\private'); };
  const trap = { get: getter, ownKeys: getter, getOwnPropertyDescriptor: getter, getPrototypeOf: getter };
  for (const mutate of [input => { Object.defineProperty(input, 'files', { get: getter, enumerable: true }); },
    input => { Object.defineProperty(input.manifest, 'name', { get: getter, enumerable: true }); },
    input => { Object.defineProperty(input.report.checks[0].actual, 'requested', { get: getter, enumerable: true }); },
    input => { input.report.toJSON = getter; }, input => { input.record.envelope = { get secret() { return getter(); } }; },
    input => { Object.defineProperty(input.report, 'SECRET', { value: true }); }, input => { input.report[Symbol('SECRET')] = true; },
    input => { input.report.self = input.report; }, input => { input.report.scope = Infinity; },
    input => { input.manifest = new Proxy(input.manifest, trap); }, input => { input.report.checks[0].actual = new Proxy({}, trap); },
    input => { input.record = new Proxy(input.record, trap); }, input => { input.files = new Proxy(input.files, trap); },
    input => { input.manifestBytes = new Proxy(input.manifestBytes, trap); },
    input => { const name = input.files.keys().next().value; input.files.set(name, new Uint8Array(new SharedArrayBuffer(1))); },
    input => { Object.defineProperty(input.files, Symbol.iterator, { value: getter }); },
    input => { input.files = new (class extends Map { get size() { return getter(); } })(input.files); },
    input => { input.report.checks = Object.assign([], { 1: input.report.checks[0] }); }]) {
    const input = inputOf(f); mutate(input); rejected(() => validateManagedCompletedSnapshot(input));
  }
  rejected(() => validateManagedCompletedSnapshot(new Proxy(inputOf(f), trap)));
  const hidden = headInput(f); Object.defineProperty(hidden, 'secret', { get: getter }); rejected(() => validateManagedRunHead(hidden));
  assert.equal(calls, 0);
});

test('bounded inputs enforce every snapshot budget and reject invalid or executable limits', async t => {
  const f = await fixture(t, ['/healthy']), total = [...f.files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  for (const limits of [{ jsonBytes: 1 }, { checks: 0 }, { evidenceFiles: f.files.size - 1 },
    { evidenceBytes: total - 1 }, { evidenceFileBytes: Math.max(...[...f.files.values()].map(bytes => bytes.length)) - 1 },
    { evidenceFiles: -1 }, { checks: 1025 }, { unknown: 1 }, { jsonBytes: NaN }]) {
    const input = inputOf(f); input.limits = limits; rejected(() => validateManagedCompletedSnapshot(input));
  }
  let calls = 0; const input = inputOf(f);
  input.limits = { get checks() { calls++; return 1; } }; rejected(() => validateManagedCompletedSnapshot(input));
  assert.equal(calls, 0);
  const deep = inputOf(f); let node = deep.report;
  for (let index = 0; index < 82; index++) node = node.deep = {};
  rejected(() => validateManagedCompletedSnapshot(deep));
  const oversized = inputOf(f); oversized.report.scope = 'x'.repeat(8 * 1024 * 1024);
  rejected(() => validateManagedCompletedSnapshot(oversized));
});
