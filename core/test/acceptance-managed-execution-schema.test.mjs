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
import { normalizeSpecPlan, SPEC_LIMITS } from '../src/acceptance/spec-schema.mjs';
import { previewOpenApi } from '../src/acceptance/openapi.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { managedRunProvenanceOf, ManagedAcceptanceRunError } from '../src/acceptance/managed-run-schema.mjs';
import { validateManagedSpecRaw, validateManagedProgress, validateManagedSettlement, MANAGED_EXECUTION_LIMITS } from '../src/acceptance/managed-execution-schema.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const uid = prefix => prefix + '-' + randomUUID();
const at = '2026-10-17T01:00:00.000Z';
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const sourceBytes = dir => Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, sha(fs.readFileSync(join(dir, name)))]));
const rejected = action => assert.throws(action, error => {
  assert.ok(error instanceof ManagedAcceptanceRunError);
  assert.equal(error.code, 'INVALID_INPUT'); assert.equal(error.status, 400);
  assert.deepEqual(error.details, { reason: 'INVALID_INPUT' });
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /private|SECRET|[A-Z]:\\/);
  return true;
});
const contract = (id, path = '/' + id, method = 'GET') => ({ id, title: id + ' contract', method, path, severity: 'high',
  expect: { status: 200, contentType: 'application/json', ...(method === 'HEAD' ? {} : { json: [{ pointer: '/code', kind: 'equals', value: 0 }] }) } });

async function fixture(t, openapi = false) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-execution-schema-')));
  const owner = acquireAcceptanceOwner({ root }), requests = [];
  const server = createServer((request, response) => {
    requests.push(request.method + ' ' + request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/slow')) return;
    response.end(request.url.endsWith('/bug') ? '{"code":9}' : request.url.endsWith('/large') ? JSON.stringify({ code: 0, body: 'x'.repeat(2048) }) : '{"code":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  let sourcePlan;
  if (openapi) {
    const document = { openapi: '3.1.1', info: { title: 'Managed OpenAPI', version: '1' }, paths: {
      '/healthy': { get: { responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { const: 0 } } } } } } } } },
      '/bug': { get: { responses: { 200: { description: 'Explicit schema BUG', content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { const: 0 } } } } } } } } },
    } };
    sourcePlan = previewOpenApi(document, { targetUrl: base + '/source', name: 'managed OpenAPI raw' }).plan;
  } else sourcePlan = normalizeSpecPlan({ name: 'managed real HTTP raw', mode: 'spec', targetUrl: base + '/source', timeoutMs: 1000, maxResponseBytes: 1024,
    spec: { source: { id: 'REQ-EXECUTION', revision: '1', type: 'manual' }, approved: false,
      checks: [contract('healthy'), contract('bug'), contract('slow'), contract('large'), contract('head', '/head', 'HEAD')] } });
  const store = createAcceptanceCatalogStore({ root, owner }); await store.initialize();
  const project = (await store.createProject({ ...cas(store), name: 'pure managed raw fixture' })).project;
  const sourceRelease = (await store.createRelease(project.id, { ...cas(store), label: 'draft source', targetUrl: sourcePlan.targetUrl })).release;
  const targetRelease = (await store.createRelease(project.id, { ...cas(store), label: 'fixed target', targetUrl: base + '/target' })).release;
  const sourceRun = createAcceptanceRun(sourcePlan, { root }), sourceDir = acceptanceRunDir(sourceRun.runId, root);
  finishAcceptanceRun(sourceRun.runId, await runSpecAcceptance(sourcePlan, { runId: sourceRun.runId, outputDir: sourceDir }), { root });
  assert.equal(requests.length, 0);
  await store.bindRun(project.id, { ...cas(store), runId: sourceRun.runId, releaseId: sourceRelease.id });
  const candidate = (await store.createBaselineCandidate(project.id, { ...cas(store), mode: 'spec', sourceSide: 'source', sourceRunId: sourceRun.runId })).candidate;
  const approval = (await store.approveBaseline(project.id, { ...cas(store), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: 'approve fixed requirement' })).approval;
  const selection = (await store.selectBaseline(project.id, { ...cas(store), mode: 'spec', approvalId: approval.id, contentDigest: candidate.contentDigest, reason: 'select requirement' })).selection;
  const { record } = await store.prepareManagedSpecDispatch(project.id, { ...cas(store), operationId: uid('ao'), selectionId: selection.id,
    contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  const envelope = JSON.parse(record.bytes.toString('utf8'));
  const manifest = { schemaVersion: 1, runId: envelope.runId, taskId: envelope.taskId, name: envelope.plan.name, mode: 'spec', targetUrl: envelope.plan.targetUrl,
    status: 'running', gate: 'blocked', plan: copy(envelope.plan), managed: managedRunProvenanceOf(record) };
  const events = [], raw = await runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: join(root, 'live-raw'), onEvent: event => { events.push(event); } });
  return { root, record, envelope, manifest, raw, events, requests, sourceDir, originalSource: sourceBytes(sourceDir) };
}
const validate = (f, raw = f.raw, manifest = f.manifest, record = f.record) => validateManagedSpecRaw({ record, manifest, raw });

test('managed raw contract accepts real local HTTP health, BUG, timeout, body budget and HEAD results without changing verdicts', async t => {
  const f = await fixture(t), accepted = validate(f);
  assert.deepEqual(accepted, f.raw); assert.notEqual(accepted, f.raw); assert.notEqual(accepted.checks[0], f.raw.checks[0]);
  assert.deepEqual(accepted.checks.map(check => [check.status, check.verdict]), [
    ['passed', 'match'], ['failed', 'bug'], ['blocked', 'environment'], ['blocked', 'environment'], ['passed', 'match'],
  ]);
  assert.equal(accepted.status, 'completed'); assert.equal(accepted.safety.requests, 5); assert.equal(f.requests.length, 5);
  assert.equal(accepted.checks[2].actual.errorCode, 'REQUEST_TIMEOUT');
  assert.equal(accepted.checks[3].actual.errorCode, 'RESPONSE_BODY_BUDGET');
  assert.equal(summarizeAcceptanceReport(accepted).gate, 'failed');
  assert.deepEqual(sourceBytes(f.sourceDir), f.originalSource);

  await t.test('record metadata is never authoritative and returned data has no aliases', () => {
    const record = { ...f.record, envelope: { plan: { targetUrl: 'https://private.invalid' }, runId: 'SECRET' } };
    const fresh = validate(f, f.raw, f.manifest, record); assert.deepEqual(fresh, f.raw);
    fresh.checks[0].expected.status = 599; fresh.specSource.id = 'changed';
    assert.equal(f.raw.checks[0].expected.status, 200); assert.equal(validate(f).specSource.id, 'REQ-EXECUTION');
  });
  await t.test('every raw field is required and store-owned/unknown fields are rejected even with correct-looking values', () => {
    for (const field of Object.keys(f.raw)) { const raw = copy(f.raw); delete raw[field]; rejected(() => validate(f, raw)); }
    for (const field of ['managed', 'taskId', 'authority', 'dispatch', 'dispatchId', 'dispatchSha256', 'operationId', 'executor',
      'planFingerprint', 'verifierFingerprint', 'evidenceManifest', 'summary', 'gate', 'unknown']) {
      const raw = copy(f.raw); raw[field] = field === 'managed' ? copy(f.manifest.managed) : f.envelope[field] ?? null;
      rejected(() => validate(f, raw));
    }
  });
  await t.test('fixed identity, approval, fingerprints and requirement expectations cannot be replaced by actual responses', () => {
    for (const mutate of [raw => { raw.runId = uid('ac'); }, raw => { raw.name += '-wrong'; }, raw => { raw.mode = 'mirror'; },
      raw => { raw.targetUrl += '/wrong'; }, raw => { raw.status = 'failed'; }, raw => { raw.schemaVersion = 2; },
      raw => { raw.startedAt = 'yesterday'; }, raw => { raw.endedAt = '2000-01-01T00:00:00.000Z'; },
      raw => { raw.specApproval.approved = false; }, raw => { raw.specApproval.recordedAt = at; },
      raw => { raw.specApproval.authority = true; }, raw => { raw.specSource.revision = '2'; },
      raw => { raw.sourceFingerprint = 'a'.repeat(64); }, raw => { raw.contractFingerprint = 'a'.repeat(64); },
      raw => { raw.checks[1].expected.json[0].value = 9; }, raw => { raw.checks[0].identity.ruleKey = 'a'.repeat(64); },
      raw => { raw.checks[0].oracle.source = 'actual'; }, raw => { raw.checks[0].title = 'different'; },
      raw => { raw.checks.reverse(); }, raw => { raw.checks[1].status = 'passed'; }, raw => { raw.checks[0].verdict = 'bug'; }]) {
      const raw = copy(f.raw); mutate(raw); rejected(() => validate(f, raw));
    }
  });
  await t.test('coverage, safety, environment and evidence shape do not grant broader permissions', () => {
    for (const mutate of [raw => { raw.coverage.completed--; }, raw => { raw.coverage.planned++; }, raw => { raw.coverage.capped = 'true'; },
      raw => { raw.coverage.capped = true; },
      raw => { raw.checks.pop(); }, raw => { raw.safety.readOnly = false; }, raw => { raw.safety.allowedMethods.push('POST'); },
      raw => { raw.safety.credentials = 'include'; }, raw => { raw.safety.redirects = 'follow'; }, raw => { raw.safety.requests++; },
      raw => { raw.environment.runner = 'browser'; }, raw => { raw.environment.maxResponseBytes++; }, raw => { raw.environment.timeoutMs++; },
      raw => { raw.checks[0].evidence.request = '../private.json'; }, raw => { delete raw.checks[0].evidence.response; },
      raw => { raw.checks[0].evidence.manifest = 'manifest.json'; }, raw => { raw.scope = ''; }]) {
      const raw = copy(f.raw); mutate(raw); rejected(() => validate(f, raw));
    }
  });
  await t.test('strict JSON rejects hooks and proxies at the envelope and every nested fact without executing them', () => {
    let calls = 0;
    const getter = () => { calls++; throw new Error('SECRET C:\\private'); };
    for (const location of ['root', 'raw', 'actual', 'manifest']) {
      const input = { record: f.record, manifest: copy(f.manifest), raw: copy(f.raw) };
      const subject = location === 'root' ? input : location === 'raw' ? input.raw : location === 'actual' ? input.raw.checks[0].actual : input.manifest;
      Object.defineProperty(subject, location === 'root' ? 'raw' : 'private', { get: getter, enumerable: true, configurable: true });
      rejected(() => validateManagedSpecRaw(input));
    }
    for (const mutate of [raw => { raw.checks[0].actual = new Proxy({}, { ownKeys: getter, getPrototypeOf: getter, get: getter }); },
      raw => { Object.defineProperty(raw, 'private', { value: true }); }, raw => { raw[Symbol('private')] = true; },
      raw => { raw.checks[0].actual.toJSON = getter; }, raw => { raw.checks[0].actual.toJSON = null; },
      raw => { raw.checks[0].actual.self = raw; }, raw => { raw.checks[0].actual = new Date(); },
      raw => { raw.checks[0].actual.value = undefined; }, raw => { raw.checks[0].actual.value = NaN; },
      raw => { raw.checks[0].actual.value = 1n; }, raw => { raw.checks[0].actual.value = () => {}; },
      raw => { delete raw.checks[0]; }, raw => { raw.checks.extra = true; },
      raw => { Object.defineProperty(raw.checks[0].actual, 'private', { get: getter }); }]) {
      const raw = copy(f.raw); mutate(raw); rejected(() => validate(f, raw));
    }
    const proxy = new Proxy({}, { ownKeys: getter, getPrototypeOf: getter, get: getter });
    rejected(() => validateManagedSpecRaw(proxy)); rejected(() => validate(f, f.raw, proxy));
    rejected(() => validate(f, f.raw, f.manifest, proxy));
    assert.equal(calls, 0);
  });
  await t.test('depth, node and encoded byte budgets reject excess JSON with safe errors', () => {
    for (const mode of ['depth', 'nodes', 'bytes']) {
      const raw = copy(f.raw);
      if (mode === 'depth') { let value = {}; raw.checks[0].actual.extra = value; for (let i = 0; i < MANAGED_EXECUTION_LIMITS.rawDepth; i++) value = value.next = {}; }
      if (mode === 'nodes') raw.checks[0].actual.extra = Array(MANAGED_EXECUTION_LIMITS.rawNodes).fill(null);
      if (mode === 'bytes') raw.checks[0].actual.extra = '界'.repeat(Math.floor(MANAGED_EXECUTION_LIMITS.rawBytes / 3));
      rejected(() => validate(f, raw));
    }
  });
  await t.test('corrupt authoritative dispatch bytes retain a safe integrity error', () => {
    const record = { ...f.record, bytes: Buffer.from(f.record.bytes) }; record.bytes[0] ^= 1;
    assert.throws(() => validate(f, f.raw, f.manifest, record), error => error instanceof ManagedAcceptanceRunError
      && error.code === 'MANAGED_RUN_INTEGRITY_FAILED' && error.details.reason === 'RECORD_DIGEST_MISMATCH');
  });
  await t.test('record envelopes and byte-view properties cannot run hooks or substitute an authority', () => {
    let calls = 0;
    const hook = () => { calls++; throw new Error('SECRET C:\\private'); };
    const record = { bytes: Buffer.from(f.record.bytes), sha256: f.record.sha256 };
    for (const key of ['buffer', 'length']) Object.defineProperty(record.bytes, key, { get: hook });
    assert.deepEqual(validate(f, f.raw, f.manifest, record), f.raw);
    for (const key of ['bytes', 'sha256', 'envelope']) {
      const hostile = { ...f.record }; Object.defineProperty(hostile, key, { get: hook, enumerable: true });
      assert.throws(() => validate(f, f.raw, f.manifest, hostile), error => error instanceof ManagedAcceptanceRunError);
    }
    rejected(() => validate(f, f.raw, f.manifest, { ...f.record, envelope: new Proxy({}, { get: hook, ownKeys: hook }) }));
    const transferred = new Uint8Array(f.record.bytes); structuredClone(transferred, { transfer: [transferred.buffer] });
    assert.throws(() => validate(f, f.raw, f.manifest, { bytes: transferred, sha256: f.record.sha256 }), error => error instanceof ManagedAcceptanceRunError);
    assert.equal(calls, 0);
  });
  await t.test('all actual runner progress kinds survive explicit event projection', () => {
    const projected = f.events.map(({ runId: _runId, ...progress }) => validateManagedProgress({ progress }));
    assert.equal(projected[0].progress.kind, 'acceptance-started'); assert.equal(projected.at(-1).progress.kind, 'acceptance-completed');
    assert.equal(projected.filter(value => value.progress.kind === 'acceptance-check').length, 5);
    assert.deepEqual(validateManagedProgress({ progress: { kind: 'acceptance-heartbeat', message: 'Read-only API acceptance is running.', completed: 0, total: 5 } }).progress.completed, 0);
    rejected(() => validateManagedProgress({ progress: f.events[0] }));
  });
  await t.test('real runner deadline cap remains completed with blocked checks rather than engine failure', async () => {
    const originalNow = Date.now, before = f.requests.length; let capped = false;
    try {
      Date.now = () => originalNow() + (capped ? SPEC_LIMITS.runMs + 1 : 0);
      const raw = await runSpecAcceptance(f.envelope.plan, { runId: f.envelope.runId, outputDir: join(f.root, 'capped-raw'),
        onEvent: event => { if (event.kind === 'acceptance-check') capped = true; } });
      const accepted = validate(f, raw);
      assert.equal(accepted.status, 'completed'); assert.equal(accepted.coverage.capped, true);
      assert.equal(accepted.safety.requests, 1); assert.equal(f.requests.length - before, 1);
      assert.equal(accepted.checks[0].status, 'passed');
      assert.ok(accepted.checks.slice(1).every(check => check.status === 'blocked' && check.verdict === 'environment' && check.actual.requested === false));
      assert.equal(summarizeAcceptanceReport(accepted).gate, 'blocked');
    } finally { Date.now = originalNow; }
  });
  assert.deepEqual(sourceBytes(f.sourceDir), f.originalSource);
  assert.deepEqual(fs.readFileSync(join(f.root, 'managed-spec-dispatches', 'v1', f.envelope.operationId + '.json')), f.record.bytes);
});

test('managed raw accepts real complete OpenAPI response schema and rejects a real omission outside the fixed dispatch', async t => {
  const f = await fixture(t, true), accepted = validate(f);
  assert.equal(accepted.specSource.type, 'openapi'); assert.equal(accepted.checks.length, 2);
  const healthy = accepted.checks.find(check => check.route === '/healthy'), bug = accepted.checks.find(check => check.route === '/bug');
  assert.equal(healthy.status, 'passed'); assert.equal(bug.status, 'failed'); assert.equal(bug.verdict, 'bug');
  assert.ok(bug.actual.schemaFailures.length > 0); assert.equal(accepted.safety.requests, 2);
  assert.ok(accepted.checks.every(check => check.evidence.source === 'requirement-source.json'));
  assert.equal(summarizeAcceptanceReport(accepted).gate, 'failed');
  assert.deepEqual(sourceBytes(f.sourceDir), f.originalSource);
  for (const mutate of [raw => { delete raw.checks[0].evidence.source; },
    raw => { raw.checks[0].expected.schema = true; }]) {
    const raw = copy(f.raw); mutate(raw); rejected(() => validate(f, raw));
  }
  const document = copy(f.envelope.plan.spec.document);
  document.paths['/write'] = { post: { responses: { 200: { description: 'Read-only omission' } } } };
  const omissionPlan = previewOpenApi(document, { targetUrl: f.envelope.plan.targetUrl, name: f.envelope.plan.name }).plan;
  omissionPlan.spec.approved = true;
  const before = f.requests.length;
  const omissionRaw = await runSpecAcceptance(omissionPlan, { runId: f.envelope.runId, outputDir: join(f.root, 'omission-raw') });
  assert.equal(f.requests.length - before, 2); assert.equal(omissionRaw.checks.length, 3);
  const omission = omissionRaw.checks.at(-1);
  assert.equal(omission.status, 'blocked'); assert.equal(omission.verdict, 'needs_review');
  assert.equal(omission.actual.requested, false); assert.equal(summarizeAcceptanceReport(omissionRaw).gate, 'failed');
  const original = copy(omissionRaw); rejected(() => validate(f, omissionRaw)); assert.deepEqual(omissionRaw, original);
});

test('managed progress and settlement are fresh narrow bounded data, never generic patches', () => {
  const progress = { progress: { kind: 'acceptance-check', message: 'checked', completed: 1, total: 2, route: '/healthy', viewport: 'api', at } };
  const accepted = validateManagedProgress(progress); assert.deepEqual(accepted, progress); assert.notEqual(accepted.progress, progress.progress);
  accepted.progress.message = 'changed'; assert.equal(progress.progress.message, 'checked');
  for (const field of ['status', 'gate', 'error', 'plan', 'managed', 'summary', 'reportSha256']) {
    rejected(() => validateManagedProgress({ ...progress, [field]: null }));
    rejected(() => validateManagedProgress({ progress: { ...progress.progress, [field]: null } }));
  }
  for (const patch of [{ kind: 'unknown' }, { completed: -1 }, { completed: 3 }, { total: 97 }, { total: 1.5 }, { completed: '1' },
    { message: 'x'.repeat(1001) }, { message: '' }, { route: 'x'.repeat(1025) }, { viewport: { width: 10, height: 10 } }, { at: 'now' }]) {
    rejected(() => validateManagedProgress({ progress: { ...progress.progress, ...patch } }));
  }
  for (const status of ['interrupted', 'failed']) for (const reasonCode of ['CANCELLED', 'WATCHDOG_TIMEOUT', 'WATCHDOG_STALLED', 'ENGINE_SHUTDOWN', 'ENGINE_RESTARTED', 'EXECUTION_FAILED']) {
    const input = { status, reasonCode, error: 'bounded engine outcome' }, result = validateManagedSettlement(input);
    assert.deepEqual(result, input); assert.notEqual(result, input);
  }
  for (const patch of [{ status: 'completed' }, { status: 'running' }, { reasonCode: 'C:\\private' }, { error: '' }, { error: 'x'.repeat(601) },
    { error: { message: 'no' } }, { gate: 'blocked' }, { endedAt: at }, { plan: {} }]) {
    rejected(() => validateManagedSettlement({ status: 'failed', reasonCode: 'EXECUTION_FAILED', error: 'bounded', ...patch }));
  }
  for (const key of ['status', 'reasonCode', 'error']) {
    const input = { status: 'failed', reasonCode: 'EXECUTION_FAILED', error: 'bounded' }; delete input[key]; rejected(() => validateManagedSettlement(input));
  }
});

test('all narrow JSON inputs reject dangerous descriptors, prototypes and complexity before hooks execute', () => {
  let calls = 0;
  const hook = () => { calls++; throw new Error('SECRET C:\\private'); };
  for (const [validator, valid, nested] of [
    [validateManagedProgress, () => ({ progress: { kind: 'acceptance-heartbeat' } }), value => value.progress],
    [validateManagedSettlement, () => ({ status: 'interrupted', reasonCode: 'CANCELLED', error: 'cancelled' }), value => value],
  ]) {
    for (const mutate of [value => { Object.defineProperty(nested(value), 'private', { get: hook, enumerable: true }); },
      value => { Object.defineProperty(nested(value), 'private', { value: true }); }, value => { nested(value)[Symbol('private')] = true; },
      value => { nested(value).toJSON = hook; }, value => { nested(value).self = value; },
      value => { Object.setPrototypeOf(nested(value), { inherited: true }); },
      value => { nested(value).extra = 'x'.repeat(MANAGED_EXECUTION_LIMITS.progressBytes); }]) {
      const value = valid(); mutate(value); rejected(() => validator(value));
    }
    rejected(() => validator(new Proxy({}, { getPrototypeOf: hook, ownKeys: hook, get: hook })));
    for (const value of [null, [], 'input', undefined, new Date()]) rejected(() => validator(value));
  }
  assert.equal(calls, 0);
});
