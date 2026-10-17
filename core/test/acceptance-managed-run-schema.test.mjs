import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { canonicalAcceptanceJson } from '../src/acceptance/identity.mjs';
import { MANAGED_SPEC_DISPATCH_LIMITS } from '../src/acceptance/managed-dispatch-schema.mjs';
import { ManagedAcceptanceRunError, managedRunProvenanceOf, validateManagedRunLinkage,
  hasManagedAcceptanceMarker, assertUnmanagedAcceptanceInput } from '../src/acceptance/managed-run-schema.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const uid = prefix => prefix + '-' + randomUUID();
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const sourceFiles = dir => Object.fromEntries(fs.readdirSync(dir).sort().map(file => [file, sha(fs.readFileSync(join(dir, file)))]));
const recordOf = envelope => { const bytes = Buffer.from(JSON.stringify(envelope) + '\n'); return { envelope: copy(envelope), bytes, sha256: sha(bytes) }; };
const rejected = (action, reason, code = 'MANAGED_RUN_INTEGRITY_FAILED', status = 409) => assert.throws(action, error =>
  error instanceof ManagedAcceptanceRunError && error.code === code && error.status === status && error.details.reason === reason);

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-run-schema-')));
  const owner = acquireAcceptanceOwner({ root });
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.setHeader('content-type', 'application/json'); response.end('{"code":0}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const store = createAcceptanceCatalogStore({ root, owner });
  await store.initialize({ createSchemaVersion: 3 });
  const project = (await store.createProject({ ...cas(store), name: '纯关联真实准备来源' })).project;
  const sourceRelease = (await store.createRelease(project.id, { ...cas(store), label: '需求草稿', targetUrl: base + '/source' })).release;
  const targetRelease = (await store.createRelease(project.id, { ...cas(store), label: '明确目标', targetUrl: base + '/target' })).release;
  const sourcePlan = normalizeSpecPlan({ name: '原始草稿', mode: 'spec', targetUrl: sourceRelease.targetUrl, timeoutMs: 1000,
    spec: { source: { id: 'REQ-MANAGED-RUN', revision: '1', type: 'manual' }, approved: false,
      checks: [{ id: 'healthy', title: '健康接口', method: 'GET', path: '/health', severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });
  const sourceRun = createAcceptanceRun(sourcePlan, { root }), sourceDir = acceptanceRunDir(sourceRun.runId, root);
  const sourceRaw = await runSpecAcceptance(sourcePlan, { runId: sourceRun.runId, outputDir: sourceDir });
  const sourceReport = finishAcceptanceRun(sourceRun.runId, sourceRaw, { root });
  assert.equal(sourceRaw.safety.requests, 0); assert.equal(requests, 0);
  await store.bindRun(project.id, { ...cas(store), runId: sourceRun.runId, releaseId: sourceRelease.id });
  const candidate = (await store.createBaselineCandidate(project.id, { ...cas(store), mode: 'spec', sourceSide: 'source', sourceRunId: sourceRun.runId })).candidate;
  const approval = (await store.approveBaseline(project.id, { ...cas(store), candidateId: candidate.id,
    contentDigest: candidate.contentDigest, reason: '确认需求合同' })).approval;
  const selection = (await store.selectBaseline(project.id, { ...cas(store), mode: 'spec', approvalId: approval.id,
    contentDigest: approval.contentDigest, reason: '选作当前规范' })).selection;
  const prepared = await store.prepareManagedSpecDispatch(project.id, { ...cas(store), operationId: uid('ao'), selectionId: selection.id,
    contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  assert.equal(prepared.runCreated, false); assert.equal(prepared.executionReady, false); assert.equal(requests, 0);
  const record = prepared.record, e = JSON.parse(record.bytes.toString('utf8')), managed = managedRunProvenanceOf(record);
  const raw = await runSpecAcceptance(e.plan, { runId: e.runId, outputDir: join(root, 'raw-runner-output') });
  assert.equal(requests, 1); assert.equal(raw.safety.requests, 1);
  const report = summarizeAcceptanceReport({ ...raw, taskId: e.taskId, managed: copy(managed),
    planFingerprint: e.planFingerprint, verifierFingerprint: sourceReport.verifierFingerprint });
  const manifest = { schemaVersion: 1, runId: e.runId, taskId: e.taskId, name: e.plan.name, mode: 'spec', targetUrl: e.plan.targetUrl,
    status: 'running', gate: 'blocked', createdAt: raw.startedAt, updatedAt: raw.startedAt, plan: copy(e.plan),
    summary: null, progress: null, managed: copy(managed) };
  return { root, record, e, managed, manifest, report, sourcePlan, sourceDir, originalSource: sourceFiles(sourceDir),
    requests: () => requests };
}

function leafPaths(value, path = []) {
  return Object.entries(value).flatMap(([key, entry]) => entry !== null && typeof entry === 'object'
    ? leafPaths(entry, [...path, key]) : [[...path, key]]);
}
function alter(value, path) {
  let parent = value;
  for (const key of path.slice(0, -1)) parent = parent[key];
  const key = path.at(-1), previous = parent[key];
  parent[key] = typeof previous === 'boolean' ? !previous : typeof previous === 'number' ? previous + 1 : previous + '-changed';
}

test('managed provenance and linkage from a real catalog-prepared draft source', async t => {
  const f = await fixture(t);
  const linked = (manifest = copy(f.manifest), report = copy(f.report), record = f.record) => validateManagedRunLinkage({ record, manifest, report });

  await t.test('explicit provenance mapping preserves draft authority and independent execution identity', () => {
    const e = f.e, c = e.candidate;
    assert.deepEqual(f.managed, { schemaVersion: 1, authority: 'catalog-approval', operationId: e.operationId, dispatchId: e.dispatchId,
      dispatchSha256: sha(f.record.bytes), runId: e.runId, taskId: e.taskId,
      catalog: { generationId: e.catalog.generationId, revision: e.catalog.revision, headSha256: e.catalog.headSha256 },
      projectId: e.project.id, selectionId: e.selection.id, approvalId: e.approval.id, candidateId: c.id, contentDigest: c.contentDigest,
      source: { runId: c.source.runId, releaseId: c.source.releaseId, sourceSpecApproved: false, sourcePlanDigest: c.sourcePlanDigest,
        sourceReportDigest: c.sourceReportDigest, evidenceManifestDigest: c.evidenceManifestDigest, verifierFingerprint: c.verifierFingerprint },
      target: { releaseId: e.targetRelease.id, targetUrl: e.targetRelease.targetUrl }, planFingerprint: e.planFingerprint, executor: 'engine-owner-spec-v1' });
    assert.equal(f.sourcePlan.spec.approved, false); assert.equal(e.plan.spec.approved, true);
    assert.notEqual(f.managed.source.runId, f.managed.runId);
    assert.notEqual(f.managed.source.sourcePlanDigest, f.managed.planFingerprint);
    assert.equal(JSON.stringify(f.managed).includes('确认需求合同'), false);
    assert.equal(fs.existsSync(join(f.root, e.runId)), false);
  });

  await t.test('running report-before-terminal and completed identities do not confer completion', () => {
    const running = linked();
    assert.deepEqual(running.managed, f.managed); assert.deepEqual(running.plan, f.e.plan);
    const completed = copy(f.manifest); completed.status = 'completed'; completed.gate = f.report.gate;
    assert.deepEqual(linked(completed).managed, f.managed);
    assert.equal(validateManagedRunLinkage({ record: f.record, manifest: f.manifest }).currentVerifierFingerprint, null);
    const differentCurrent = copy(f.report); differentCurrent.verifierFingerprint = 'b'.repeat(64);
    assert.equal(linked(f.manifest, differentCurrent).currentVerifierFingerprint, 'b'.repeat(64));
    assert.equal(linked(f.manifest, differentCurrent).managed.source.verifierFingerprint, f.e.candidate.verifierFingerprint);
    assert.equal(f.requests(), 1);
  });

  for (const kind of ['manifest', 'report']) {
    for (const path of leafPaths(f.managed)) await t.test(kind + ' provenance mismatch: ' + path.join('.'), () => {
      const manifest = copy(f.manifest), report = copy(f.report);
      alter((kind === 'manifest' ? manifest : report).managed, path);
      rejected(() => linked(manifest, report), kind.toUpperCase() + '_PROVENANCE_MISMATCH');
    });
    await t.test(kind + ' provenance is mandatory and has no extra fields at any level', () => {
      for (const path of [[], ['catalog'], ['source'], ['target']]) {
        const manifest = copy(f.manifest), report = copy(f.report), subject = kind === 'manifest' ? manifest : report;
        let object = subject.managed;
        for (const key of path) object = object[key];
        object.unexpected = true;
        rejected(() => linked(manifest, report), kind.toUpperCase() + '_PROVENANCE_MISMATCH');
      }
      const manifest = copy(f.manifest), report = copy(f.report);
      delete (kind === 'manifest' ? manifest : report).managed;
      rejected(() => linked(manifest, report), kind.toUpperCase() + '_MANAGED_REQUIRED');
      for (const value of [null, false, {}, []]) {
        const manifest = copy(f.manifest), report = copy(f.report);
        (kind === 'manifest' ? manifest : report).managed = value;
        rejected(() => linked(manifest, report), kind.toUpperCase() + '_PROVENANCE_MISMATCH');
      }
    });
  }

  await t.test('all manifest/report fixed identities and top-level reserved overlays reject', () => {
    for (const kind of ['manifest', 'report']) {
      for (const key of ['schemaVersion', 'runId', 'taskId', 'name', 'mode', 'targetUrl']) {
        const manifest = copy(f.manifest), report = copy(f.report);
        alter(kind === 'manifest' ? manifest : report, [key]);
        rejected(() => linked(manifest, report), kind.toUpperCase() + '_IDENTITY_MISMATCH');
      }
      for (const key of ['authority', 'dispatchId', 'dispatchSha256', 'operationId', 'executor']) {
        const manifest = copy(f.manifest), report = copy(f.report);
        (kind === 'manifest' ? manifest : report)[key] = false;
        rejected(() => linked(manifest, report), kind.toUpperCase() + '_RESERVED_FIELD');
      }
      const manifest = copy(f.manifest), report = copy(f.report);
      (kind === 'manifest' ? manifest : report).baselineUrl = null;
      rejected(() => linked(manifest, report), kind.toUpperCase() + '_IDENTITY_MISMATCH');
    }
  });

  await t.test('saved plan content, byte-order digest and report requirement facts remain distinct', () => {
    for (const mutate of [m => { m.plan.targetUrl += '?changed'; }, m => { m.plan.spec.approved = false; },
      m => { m.planFingerprint = 'c'.repeat(64); }, m => { m.plan = Object.fromEntries(Object.entries(m.plan).reverse()); }]) {
      const manifest = copy(f.manifest); mutate(manifest);
      rejected(() => linked(manifest), 'MANIFEST_PLAN_MISMATCH');
    }
    for (const key of ['planFingerprint', 'sourceFingerprint', 'contractFingerprint', 'specSource']) {
      const report = copy(f.report); report[key] = key === 'specSource' ? { ...report.specSource, revision: 'changed' } : 'd'.repeat(64);
      rejected(() => linked(f.manifest, report), key === 'planFingerprint' ? 'REPORT_PLAN_MISMATCH' : 'REPORT_REQUIREMENT_MISMATCH');
    }
    const reordered = copy(f.e);
    reordered.plan.spec.source = Object.fromEntries(Object.entries(reordered.plan.spec.source).reverse());
    reordered.plan.spec = Object.fromEntries(Object.entries(reordered.plan.spec).reverse());
    assert.equal(canonicalAcceptanceJson(reordered.plan), canonicalAcceptanceJson(f.e.plan));
    reordered.planFingerprint = sha(JSON.stringify(reordered.plan));
    assert.notEqual(reordered.planFingerprint, f.e.planFingerprint);
    const record = recordOf(reordered), managed = managedRunProvenanceOf(record);
    const manifest = { ...copy(f.manifest), managed: copy(managed), plan: copy(reordered.plan) };
    const report = { ...copy(f.report), managed: copy(managed), planFingerprint: reordered.planFingerprint };
    assert.deepEqual(linked(manifest, report, record).managed, managed);
  });

  await t.test('approval/status/current verifier fields cannot borrow source approval or fingerprints', () => {
    for (const approval of [{ approved: false, recordedAt: f.report.startedAt }, { approved: true, recordedAt: f.e.approval.approvedAt },
      { approved: true, recordedAt: f.report.startedAt, actor: 'operator' }, {}]) {
      const report = { ...copy(f.report), specApproval: approval };
      if (approval.recordedAt === f.report.startedAt && Object.keys(approval).length === 2 && approval.approved) continue;
      rejected(() => linked(f.manifest, report), 'REPORT_APPROVAL_MISMATCH');
    }
    for (const value of [null, '', 'A'.repeat(64), f.e.candidate.contentDigest.slice(1), 1]) {
      rejected(() => linked(f.manifest, { ...copy(f.report), verifierFingerprint: value }), 'REPORT_VERIFIER_INVALID');
    }
    for (const value of ['running', 'failed', 'interrupted']) {
      rejected(() => linked(f.manifest, { ...copy(f.report), status: value }), 'REPORT_IDENTITY_MISMATCH');
    }
    rejected(() => linked({ ...copy(f.manifest), status: 'unknown' }), 'MANIFEST_STATUS_INVALID');
    rejected(() => linked({ ...copy(f.manifest), gate: 'passed' }), 'MANIFEST_STATUS_INVALID');
    rejected(() => linked(f.manifest, { ...copy(f.report), startedAt: 'not-a-date' }), 'REPORT_IDENTITY_MISMATCH');
  });

  await t.test('original bytes and SHA are mandatory; malformed or structurally invalid envelope fails closed', () => {
    rejected(() => managedRunProvenanceOf({ envelope: f.e, sha256: f.record.sha256 }), 'INVALID_RECORD');
    for (const bytes of [null, f.record.bytes.toString('utf8'), new Uint16Array(2), new Uint8Array(new SharedArrayBuffer(2))]) {
      rejected(() => managedRunProvenanceOf({ bytes, sha256: f.record.sha256 }), 'RECORD_BYTES_REQUIRED');
    }
    rejected(() => managedRunProvenanceOf({ bytes: Buffer.alloc(MANAGED_SPEC_DISPATCH_LIMITS.jsonBytes + 1), sha256: f.record.sha256 }), 'RECORD_BYTES_EXCEEDED');
    rejected(() => managedRunProvenanceOf({ bytes: f.record.bytes, sha256: 'BAD' }), 'RECORD_DIGEST_INVALID');
    const changed = Buffer.from(f.record.bytes); changed[0] ^= 1;
    rejected(() => managedRunProvenanceOf({ bytes: changed, sha256: f.record.sha256 }), 'RECORD_DIGEST_MISMATCH');
    const invalidUtf8 = Buffer.from([0xff]);
    rejected(() => managedRunProvenanceOf({ bytes: invalidUtf8, sha256: sha(invalidUtf8) }), 'RECORD_JSON_INVALID');
    const invalidJson = Buffer.from('{"private":"C:\\\\secret"');
    rejected(() => managedRunProvenanceOf({ bytes: invalidJson, sha256: sha(invalidJson) }), 'RECORD_JSON_INVALID');
    const invalid = copy(f.e); delete invalid.executor;
    rejected(() => managedRunProvenanceOf(recordOf(invalid)), 'RECORD_ENVELOPE_INVALID');
    const sourceCannotBecomeExecutionPlan = copy(f.e); sourceCannotBecomeExecutionPlan.plan.spec.approved = false;
    rejected(() => managedRunProvenanceOf(recordOf(sourceCannotBecomeExecutionPlan)), 'RECORD_ENVELOPE_INVALID');
  });

  await t.test('metadata mutation and returned references cannot change authority or cache a past result', () => {
    const record = { ...f.record, envelope: { plan: { approved: false }, runId: uid('ac') } };
    assert.deepEqual(managedRunProvenanceOf(record), f.managed);
    const first = managedRunProvenanceOf(record); first.source.sourceSpecApproved = true; first.catalog.revision = 999;
    assert.deepEqual(managedRunProvenanceOf(record), f.managed);
    const result = linked(); result.plan.spec.approved = false; result.managed.source.verifierFingerprint = '0'.repeat(64);
    assert.deepEqual(linked().plan, f.e.plan); assert.deepEqual(linked().managed, f.managed);
    const privateRecord = { bytes: Buffer.from(f.record.bytes), sha256: f.record.sha256 };
    managedRunProvenanceOf(privateRecord); privateRecord.bytes[0] ^= 1;
    rejected(() => managedRunProvenanceOf(privateRecord), 'RECORD_DIGEST_MISMATCH');
    assert.deepEqual(managedRunProvenanceOf({ bytes: new Uint8Array(f.record.bytes), sha256: f.record.sha256 }), f.managed);
  });

  await t.test('record and captured facts reject getters/proxies without invoking attacker properties', () => {
    let calls = 0;
    const record = { bytes: f.record.bytes, sha256: f.record.sha256 };
    Object.defineProperty(record, 'envelope', { enumerable: true, get() { calls++; return f.e; } });
    rejected(() => managedRunProvenanceOf(record), 'INVALID_RECORD');
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { calls++; throw new Error('private path'); }, ownKeys() { calls++; return []; } });
    rejected(() => managedRunProvenanceOf(proxy), 'INVALID_RECORD');
    const bytes = Buffer.from(f.record.bytes);
    for (const key of ['length', 'buffer']) Object.defineProperty(bytes, key, { get() { calls++; throw new Error('private path'); } });
    assert.deepEqual(managedRunProvenanceOf({ bytes, sha256: f.record.sha256 }), f.managed);
    for (const kind of ['manifest', 'report']) {
      const manifest = copy(f.manifest), report = copy(f.report), subject = kind === 'manifest' ? manifest : report;
      Object.defineProperty(subject, 'managed', { enumerable: true, get() { calls++; return f.managed; } });
      rejected(() => linked(manifest, report), 'UNSAFE_JSON');
    }
    assert.equal(calls, 0);
  });

  await t.test('non-JSON, hidden, cyclic and excessive facts reject before canonicalization', () => {
    const variants = [value => { value.hidden = undefined; }, value => { value.number = NaN; }, value => { value.cycle = value; },
      value => { value.symbol = Symbol('private'); }, value => { value.sparse = Array(2); }, value => { value.fn = () => {}; },
      value => { Object.defineProperty(value, 'hidden', { value: 1 }); }, value => { value[Symbol('private')] = 1; },
      value => { value.proxy = new Proxy({}, { ownKeys() { throw new Error('must not run'); } }); }];
    for (const mutate of variants) {
      const manifest = copy(f.manifest); mutate(manifest);
      rejected(() => linked(manifest), 'UNSAFE_JSON');
    }
    const deep = copy(f.manifest); let nested = deep;
    for (let index = 0; index < 90; index++) nested = nested.child = {};
    rejected(() => linked(deep), 'JSON_COMPLEXITY_EXCEEDED');
    const huge = { ...copy(f.manifest), padding: 'x'.repeat(MANAGED_SPEC_DISPATCH_LIMITS.jsonBytes) };
    rejected(() => linked(huge), 'JSON_BYTES_EXCEEDED');
    const nodes = { ...copy(f.manifest), nodes: Array(MANAGED_SPEC_DISPATCH_LIMITS.jsonNodes).fill(null) };
    rejected(() => linked(nodes), 'JSON_COMPLEXITY_EXCEEDED');
  });

  await t.test('no source bytes, prepared sidecar or target requests change during pure validation', () => {
    assert.deepEqual(sourceFiles(f.sourceDir), f.originalSource);
    assert.deepEqual(fs.readFileSync(join(f.root, 'managed-spec-dispatches', 'v1', f.e.operationId + '.json')), f.record.bytes);
    assert.equal(fs.existsSync(join(f.root, f.e.runId)), false); assert.equal(f.requests(), 1);
  });
});

test('own managed markers and ordinary plan reserved-field guards', () => {
  const keys = ['managed', 'authority', 'dispatchId', 'dispatchSha256', 'operationId', 'executor'];
  let calls = 0;
  for (const key of keys) {
    for (const value of [null, false, undefined, '', 0]) {
      assert.equal(hasManagedAcceptanceMarker({ [key]: value }), true);
      rejected(() => assertUnmanagedAcceptanceInput({ [key]: value }), 'RESERVED_INPUT_FIELD', 'INVALID_INPUT', 400);
    }
    for (const descriptor of [{ value: false }, { enumerable: true, get() { calls++; return false; } }]) {
      const input = {}; Object.defineProperty(input, key, descriptor);
      assert.equal(hasManagedAcceptanceMarker(input), true);
      rejected(() => assertUnmanagedAcceptanceInput(input), 'RESERVED_INPUT_FIELD', 'INVALID_INPUT', 400);
    }
    assert.equal(hasManagedAcceptanceMarker(Object.create({ [key]: true })), false);
  }
  for (const key of ['runId', 'taskId']) {
    assert.equal(hasManagedAcceptanceMarker({ [key]: uid(key === 'runId' ? 'ac' : 'a') }), false);
    rejected(() => assertUnmanagedAcceptanceInput({ [key]: null }), 'RESERVED_INPUT_FIELD', 'INVALID_INPUT', 400);
  }
  const ordinary = { mode: 'spec', spec: { checks: [{ expect: { json: [{ value: { managed: true, operationId: 'business-value' } }] } }] } };
  assert.equal(hasManagedAcceptanceMarker(ordinary), false); assert.equal(assertUnmanagedAcceptanceInput(ordinary), ordinary);
  for (const value of [null, 1, 'managed', [], () => {}]) {
    assert.equal(hasManagedAcceptanceMarker(value), false);
    rejected(() => assertUnmanagedAcceptanceInput(value), 'INVALID_INPUT', 'INVALID_INPUT', 400);
  }
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { calls++; return undefined; }, ownKeys() { calls++; return []; } });
  assert.equal(hasManagedAcceptanceMarker(proxy), true);
  rejected(() => assertUnmanagedAcceptanceInput(proxy), 'INVALID_INPUT', 'INVALID_INPUT', 400);
  assert.equal(calls, 0);
});

test('managed errors have fixed safe code/status/message/details', () => {
  const unsupported = new ManagedAcceptanceRunError('MANAGED_EXECUTION_REQUIRED', 'MANAGED_NOT_SUPPORTED');
  assert.equal(unsupported.status, 503); assert.deepEqual(unsupported.details, { reason: 'MANAGED_NOT_SUPPORTED' });
  assert.equal(Object.isFrozen(unsupported.details), true);
  assert.deepEqual(new ManagedAcceptanceRunError('MANAGED_EXECUTION_REQUIRED', 'DISPATCH_UNAVAILABLE').details, { reason: 'DISPATCH_UNAVAILABLE' });
  const error = new ManagedAcceptanceRunError('C:\\private\\file.json', '/private/source');
  assert.equal(error.code, 'MANAGED_RUN_INTEGRITY_FAILED'); assert.equal(error.status, 409);
  assert.deepEqual(error.details, { reason: 'INVALID_INPUT' });
  assert.doesNotMatch(JSON.stringify({ code: error.code, status: error.status, message: error.message, details: error.details }), /private|[A-Z]:\\|\/private/);
});
