import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { normalizeAcceptancePlan } from '../src/acceptance/schema.mjs';
import { handleAcceptanceCatalogRequest } from '../src/acceptance/catalog-api.mjs';

const uid = prefix => prefix + '-' + randomUUID();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const sourceFiles = dir => Object.fromEntries(readdirSync(dir).sort().map(file => [file, sha(readFileSync(join(dir, file)))]));
const heads = f => ['catalog.json', 'catalog.previous.json'].map(file => readFileSync(join(f.root, file)));
const dispatchDir = f => join(f.root, 'managed-spec-dispatches', 'v1');
const published = f => existsSync(dispatchDir(f)) ? readdirSync(dispatchDir(f)).filter(name => /^ao-.*\.json$/.test(name)) : [];
const runIds = f => readdirSync(f.root).filter(name => /^ac-/.test(name));
const preparedInput = (f, operationId = uid('ao')) => ({ ...cas(f.store), operationId,
  selectionId: f.selection.id, contentDigest: f.candidate.contentDigest, targetReleaseId: f.target.id });
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-managed-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = { root, active: true };
  f.owner = { root, assertOwned() {
    if (!f.active) throw Object.assign(new Error('Owner lost'), { code: 'ACCEPTANCE_OWNER_LOST', status: 503 });
  } };
  f.store = createAcceptanceCatalogStore({ root, owner: f.owner, managedDispatchOptions: options });
  await f.store.initialize();
  f.project = (await f.store.createProject({ ...cas(f.store), name: '受控需求准备' })).project;
  f.release = (await f.store.createRelease(f.project.id, { ...cas(f.store), label: '需求来源 v1', targetUrl: 'http://127.0.0.1:32987/source?revision=1' })).release;
  f.target = (await f.store.createRelease(f.project.id, { ...cas(f.store), label: '明确目标 v2', targetUrl: 'http://127.0.0.1:32988/development?revision=2', buildRef: 'target-build-v2' })).release;
  const plan = normalizeAcceptancePlan({ schemaVersion: 1, mode: 'spec', name: '完整未执行草稿', targetUrl: f.release.targetUrl,
    timeoutMs: 1000, maxResponseBytes: 32768,
    spec: { source: { id: 'REQ-MANAGED', revision: 'v1', type: 'manual' }, approved: false, checks: [
      { id: 'QUOTA', title: '业务额度正确', method: 'GET', path: '/quota', severity: 'high', expect: { status: 200,
        contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 },
          { pointer: '/enabled', kind: 'equals', value: false }, { pointer: '/name', kind: 'equals', value: '' }],
        schema: { type: 'object', required: ['code'], properties: { code: { type: 'integer' } } } } },
      { id: 'HEALTH', title: '健康HEAD', method: 'HEAD', path: '/health', severity: 'medium', expect: { status: 204 } },
    ], omissions: [] } });
  f.source = createAcceptanceRun(plan, { root }); f.sourceDir = acceptanceRunDir(f.source.runId, root);
  finishAcceptanceRun(f.source.runId, await runAcceptance(plan, { outputDir: f.sourceDir }), { root });
  await f.store.bindRun(f.project.id, { ...cas(f.store), runId: f.source.runId, releaseId: f.release.id });
  f.candidate = (await f.store.createBaselineCandidate(f.project.id, { ...cas(f.store), mode: 'spec', sourceSide: 'source', sourceRunId: f.source.runId })).candidate;
  f.approval = (await f.store.approveBaseline(f.project.id, { ...cas(f.store), candidateId: f.candidate.id,
    contentDigest: f.candidate.contentDigest, reason: '确认完整需求符合规范' })).approval;
  f.selection = (await f.store.selectBaseline(f.project.id, { ...cas(f.store), mode: 'spec', approvalId: f.approval.id,
    contentDigest: f.approval.contentDigest, reason: '明确选用该需求' })).selection;
  f.plan = plan; f.originalSource = sourceFiles(f.sourceDir);
  return f;
}
async function assertNoAcceptance(f, input, code) {
  const before = heads(f), runs = runIds(f), dispatches = published(f);
  await assert.rejects(f.store.prepareManagedSpecDispatch(f.project.id, input), { code });
  assert.deepEqual(heads(f), before); assert.deepEqual(runIds(f), runs); assert.deepEqual(published(f), dispatches);
}

test('private preparation freezes draft authority and explicit target without creating a run, changing the catalog or contacting targets', async t => {
  const f = await fixture(t), input = preparedInput(f), before = heads(f), runs = runIds(f);
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Preparation must never fetch'); };
  let result;
  try { result = await f.store.prepareManagedSpecDispatch(f.project.id, input); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(result.state, 'prepared'); assert.equal(result.replayed, false);
  assert.equal(result.runCreated, false); assert.equal(result.executionReady, false); assert.equal(requests, 0);
  const { envelope, bytes, sha256 } = result.record;
  assert.equal(envelope.sourceSpecApproved, false); assert.equal(envelope.plan.spec.approved, true);
  assert.equal(envelope.plan.targetUrl, f.target.targetUrl); assert.equal(envelope.sourceRelease.id, f.release.id);
  assert.equal(envelope.targetRelease.id, f.target.id); assert.equal(envelope.selection.id, f.selection.id);
  assert.equal(envelope.approval.id, f.approval.id); assert.equal(envelope.candidate.id, f.candidate.id);
  assert.deepEqual(envelope.plan.spec.checks, f.plan.spec.checks);
  assert.deepEqual(envelope.plan.spec.source, f.plan.spec.source);
  assert.equal(envelope.plan.timeoutMs, f.plan.timeoutMs); assert.equal(envelope.plan.maxResponseBytes, f.plan.maxResponseBytes);
  assert.equal(envelope.planFingerprint, sha(JSON.stringify(envelope.plan)));
  assert.equal(sha256, sha(bytes)); assert.equal(envelope.catalog.headSha256, sha(before[0]));
  assert.equal(existsSync(join(f.root, envelope.runId)), false);
  assert.deepEqual(heads(f), before); assert.deepEqual(runIds(f), runs); assert.deepEqual(sourceFiles(f.sourceDir), f.originalSource);
  assert.deepEqual(published(f), [input.operationId + '.json']);
});

test('same operation replays original bytes after cancellation, unavailable source and unavailable catalog, including a new store instance', async t => {
  const f = await fixture(t), input = preparedInput(f), first = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  await f.store.selectBaseline(f.project.id, { ...cas(f.store), mode: 'spec', approvalId: null, contentDigest: null, reason: '取消选用' });
  renameSync(f.sourceDir, f.sourceDir + '.saved'); renameSync(join(f.root, 'catalog.json'), join(f.root, 'catalog.saved'));
  const restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  const replay = await restarted.prepareManagedSpecDispatch(f.project.id, input);
  assert.equal(replay.replayed, true); assert.equal(replay.executionReady, false); assert.equal(replay.runCreated, false);
  assert.deepEqual(replay.record.bytes, first.record.bytes); assert.deepEqual(replay.record.envelope, first.record.envelope);
  assert.equal(published(f).length, 1); assert.equal(existsSync(join(f.root, first.record.envelope.runId)), false);
});

test('concurrent duplicate operation requests reserve only one immutable identity set', async t => {
  const f = await fixture(t), input = preparedInput(f), before = heads(f);
  const result = await Promise.all([f.store.prepareManagedSpecDispatch(f.project.id, input), f.store.prepareManagedSpecDispatch(f.project.id, input)]);
  assert.deepEqual(result.map(item => item.replayed), [false, true]);
  assert.deepEqual(result[0].record.bytes, result[1].record.bytes); assert.deepEqual(heads(f), before);
  assert.equal(published(f).length, 1); assert.equal(runIds(f).length, 1);
});

test('an operation key is bound to all original confirmation fields, including old CAS context', async t => {
  const f = await fixture(t), input = preparedInput(f);
  await f.store.prepareManagedSpecDispatch(f.project.id, input);
  for (const patch of [{ targetReleaseId: f.release.id }, { expectedRevision: input.expectedRevision + 1 },
    { expectedGenerationId: uid('ag') }, { selectionId: uid('as') }, { contentDigest: 'a'.repeat(64) }]) {
    await assertNoAcceptance(f, { ...input, ...patch }, 'IDEMPOTENCY_CONFLICT');
  }
});

test('injection, accessors and invalid identifiers reject before creating side storage or reading a source', async t => {
  const f = await fixture(t), input = preparedInput(f);
  for (const patch of [{ plan: f.plan }, { approved: true }, { targetUrl: f.target.targetUrl }, { actor: {} },
    { timeoutMs: 1 }, { operationId: '../outside' }, { selectionId: '' }, { targetReleaseId: '' }, { expectedRevision: '8' }]) {
    await assertNoAcceptance(f, { ...input, ...patch }, 'INVALID_INPUT');
  }
  let called = false;
  const accessor = { ...input }; Object.defineProperty(accessor, 'selectionId', { enumerable: true, get() { called = true; return f.selection.id; } });
  await assertNoAcceptance(f, accessor, 'INVALID_INPUT'); assert.equal(called, false);
  assert.equal(existsSync(dispatchDir(f)), false);
});

test('fresh preparations require current CAS, exact selection and digest, and refuse cancelled or ABA selections', async t => {
  const f = await fixture(t), input = preparedInput(f);
  await assertNoAcceptance(f, { ...input, expectedGenerationId: uid('ag') }, 'STALE_REVISION');
  await assertNoAcceptance(f, { ...input, expectedRevision: input.expectedRevision - 1 }, 'STALE_REVISION');
  await assertNoAcceptance(f, { ...input, selectionId: uid('as') }, 'BASELINE_CHANGED');
  await assertNoAcceptance(f, { ...input, contentDigest: 'b'.repeat(64) }, 'BASELINE_CHANGED');
  await f.store.selectBaseline(f.project.id, { ...cas(f.store), mode: 'spec', approvalId: null, contentDigest: null, reason: '取消' });
  await assertNoAcceptance(f, { ...input, ...cas(f.store) }, 'BASELINE_CHANGED');
  await f.store.selectBaseline(f.project.id, { ...cas(f.store), mode: 'spec', approvalId: f.approval.id, contentDigest: f.approval.contentDigest, reason: '回到原批准' });
  await assertNoAcceptance(f, { ...input, ...cas(f.store) }, 'BASELINE_CHANGED');
});

test('same catalog queue observes a preceding cancellation before preparing a fresh operation', async t => {
  const f = await fixture(t), input = preparedInput(f);
  const cancel = f.store.selectBaseline(f.project.id, { ...cas(f.store), mode: 'spec', approvalId: null, contentDigest: null, reason: '并发取消' });
  const preparing = f.store.prepareManagedSpecDispatch(f.project.id, input);
  await cancel; await assert.rejects(preparing, { code: 'STALE_REVISION' });
  assert.equal(published(f).length, 0); assert.equal(runIds(f).length, 1);
});

test('target must be an explicit existing release in the same project, even when another project uses the same URL', async t => {
  const f = await fixture(t);
  const other = (await f.store.createProject({ ...cas(f.store), name: '其他项目' })).project;
  const target = (await f.store.createRelease(other.id, { ...cas(f.store), label: '同URL但不同归属', targetUrl: f.target.targetUrl })).release;
  await assertNoAcceptance(f, { ...preparedInput(f), targetReleaseId: target.id }, 'PROJECT_MISMATCH');
  await assertNoAcceptance(f, { ...preparedInput(f), targetReleaseId: uid('ar') }, 'NOT_FOUND');
});

test('source changes after selection are refused without rewriting history', async t => {
  const f = await fixture(t), input = preparedInput(f), file = join(f.sourceDir, 'report.json');
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')]));
  await assertNoAcceptance(f, input, 'SOURCE_INTEGRITY_FAILED');
});

test('source change after temporary dispatch write is caught by final guard before publication', async t => {
  let f, fired = false;
  f = await fixture(t, { hooks: { afterTemporaryWrite() {
    fired = true; const file = join(f.sourceDir, 'report.json'); writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')]));
  } } });
  await assertNoAcceptance(f, preparedInput(f), 'SOURCE_INTEGRITY_FAILED');
  assert.equal(fired, true); assert.equal(published(f).length, 0);
});

test('source change during the last temporary byte recheck is caught by the publication final guard', async t => {
  let f, temporaryReads = 0, changed = false;
  const descriptors = new Map();
  f = await fixture(t, { io: {
    openSync(path, ...args) { const fd = openSync(path, ...args); descriptors.set(fd, path); return fd; },
    closeSync(fd) { closeSync(fd); descriptors.delete(fd); },
    readSync(...args) {
      const count = readSync(...args);
      if (descriptors.get(args[0])?.endsWith('.tmp') && ++temporaryReads === 5) {
        const file = join(f.sourceDir, 'report.json');
        writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')])); changed = true;
      }
      return count;
    },
  } });
  await assertNoAcceptance(f, preparedInput(f), 'SOURCE_INTEGRITY_FAILED');
  assert.equal(changed, true); assert.equal(published(f).length, 0); assert.equal(runIds(f).length, 1);
});

test('catalog byte change after temporary dispatch write rejects even a semantic whitespace rewrite', async t => {
  let f, fired = false;
  f = await fixture(t, { hooks: { afterTemporaryWrite() {
    fired = true; const file = join(f.root, 'catalog.json'); writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')]));
  } } });
  await assert.rejects(f.store.prepareManagedSpecDispatch(f.project.id, preparedInput(f)), { code: 'STALE_REVISION' });
  assert.equal(fired, true); assert.equal(published(f).length, 0); assert.equal(runIds(f).length, 1);
});

test('owner loss after temporary write refuses publication and does not create reserved run IDs', async t => {
  let f; f = await fixture(t, { hooks: { afterTemporaryWrite() { f.active = false; } } });
  await assert.rejects(f.store.prepareManagedSpecDispatch(f.project.id, preparedInput(f)), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.equal(published(f).length, 0); assert.equal(runIds(f).length, 1);
});

test('a response failure after publication keeps the record and the same operation only queries it', async t => {
  let fired = false;
  const f = await fixture(t, { hooks: { afterPublish() { fired = true; throw new Error('Simulated response path failure'); } } });
  const input = preparedInput(f), before = heads(f);
  await assert.rejects(f.store.prepareManagedSpecDispatch(f.project.id, input), error => error.writeMayHaveCommitted === true);
  assert.equal(fired, true); assert.equal(published(f).length, 1);
  const result = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  assert.equal(result.replayed, true); assert.equal(result.runCreated, false); assert.equal(result.executionReady, false);
  assert.deepEqual(heads(f), before); assert.deepEqual(sourceFiles(f.sourceDir), f.originalSource);
  assert.equal(existsSync(join(f.root, result.record.envelope.runId)), false);
});

test('corrupt accepted dispatch is retained and cannot be replaced by retrying its operation key', async t => {
  const f = await fixture(t), input = preparedInput(f), first = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  const file = join(dispatchDir(f), input.operationId + '.json'); writeFileSync(file, '{broken');
  await assert.rejects(f.store.prepareManagedSpecDispatch(f.project.id, input));
  assert.equal(readFileSync(file, 'utf8'), '{broken'); assert.equal(published(f).length, 1);
  assert.equal(existsSync(join(f.root, first.record.envelope.runId)), false);
});

test('operation IDs have root-wide scope and do not become reusable under another project path', async t => {
  const f = await fixture(t), input = preparedInput(f);
  const first = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  await assert.rejects(f.store.prepareManagedSpecDispatch(uid('ap'), input), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(published(f).length, 1); assert.equal(existsSync(join(f.root, first.record.envelope.runId)), false);
});

test('failed prepublication operation can be prepared once with the same key after the fault is removed', async t => {
  let firstAttempt = true;
  const f = await fixture(t, { hooks: { afterTemporaryWrite() { if (firstAttempt) { firstAttempt = false; throw new Error('Preparation failed before publication'); } } } });
  const input = preparedInput(f), before = heads(f);
  await assert.rejects(f.store.prepareManagedSpecDispatch(f.project.id, input));
  assert.equal(published(f).length, 0);
  const result = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  assert.equal(result.replayed, false); assert.equal(published(f).length, 1);
  assert.equal(result.runCreated, false); assert.deepEqual(heads(f), before);
});

test('different operation IDs can independently prepare under one unchanged CAS without an execution slot', async t => {
  const f = await fixture(t), before = heads(f);
  const result = await Promise.all([f.store.prepareManagedSpecDispatch(f.project.id, preparedInput(f)),
    f.store.prepareManagedSpecDispatch(f.project.id, preparedInput(f))]);
  assert.equal(result.every(item => item.replayed === false && item.runCreated === false && item.executionReady === false), true);
  assert.notEqual(result[0].record.envelope.runId, result[1].record.envelope.runId);
  assert.notEqual(result[0].record.envelope.taskId, result[1].record.envelope.taskId);
  assert.equal(published(f).length, 2); assert.equal(runIds(f).length, 1);
  assert.deepEqual(heads(f), before); assert.deepEqual(sourceFiles(f.sourceDir), f.originalSource);
});

test('private preparation has no HTTP route and cannot be invoked by a guessed method suffix', async t => {
  const f = await fixture(t); let calls = 0;
  const catalog = { ...f.store, prepareManagedSpecDispatch() { calls++; throw new Error('Private preparation leaked to HTTP'); } };
  const invoke = async (method, path) => {
    let response;
    const handled = await handleAcceptanceCatalogRequest({ method }, { setHeader() {} }, new URL('http://local/api/acceptance/projects/' + path),
      { catalog, json(_res, status, body) { response = { status, body }; } });
    assert.equal(handled, true); return response;
  };
  for (const suffix of ['managed-spec-runs', 'managed-spec-dispatches', 'prepareManagedSpecDispatch', 'readManagedSpecDispatch']) {
    assert.equal((await invoke('POST', f.project.id + '/' + suffix)).status, 404);
  }
  assert.equal((await invoke('GET', f.project.id)).status, 200);
  assert.equal((await invoke('GET', f.project.id + '/baseline-candidates/' + f.candidate.id)).status, 200);
  assert.equal(calls, 0); assert.equal(existsSync(dispatchDir(f)), false);
});

test('ordinary B2.1 catalog initialization and HTTP reads remain independent of a damaged sidecar', async t => {
  const f = await fixture(t), input = preparedInput(f), before = heads(f);
  mkdirSync(dispatchDir(f), { recursive: true }); const file = join(dispatchDir(f), input.operationId + '.json');
  writeFileSync(file, '{broken');
  const reopened = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  assert.equal((await reopened.initialize()).revision, f.store.read().revision);
  assert.equal(reopened.readBaselineCandidate(f.project.id, f.candidate.id).diagnostics.eligible, true);
  let response;
  await handleAcceptanceCatalogRequest({ method: 'GET' }, { setHeader() {} }, new URL('http://local/api/acceptance/projects/' + f.project.id),
    { catalog: reopened, json(_res, status, body) { response = { status, body }; } });
  assert.equal(response.status, 200); assert.equal(response.body.executionReady, false);
  await assert.rejects(reopened.prepareManagedSpecDispatch(f.project.id, input));
  assert.deepEqual(heads(f), before); assert.equal(readFileSync(file, 'utf8'), '{broken'); assert.equal(runIds(f).length, 1);
});

test('private dispatch query returns absence without preparing an operation, including a queued future preparation', async t => {
  const f = await fixture(t), input = preparedInput(f), before = heads(f), runs = runIds(f);
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('A dispatch query cannot execute'); };
  try {
    assert.equal(f.store.readManagedSpecDispatch(f.project.id, input), null);
    assert.equal(existsSync(join(f.root, 'managed-spec-dispatches')), false);
    assert.deepEqual(published(f), []); assert.deepEqual(heads(f), before); assert.deepEqual(runIds(f), runs);
    const pending = f.store.prepareManagedSpecDispatch(f.project.id, input);
    assert.equal(f.store.readManagedSpecDispatch(f.project.id, input), null);
    const prepared = await pending;
    const record = f.store.readManagedSpecDispatch(f.project.id, input);
    assert.deepEqual(record.bytes, prepared.record.bytes); assert.equal(record.sha256, prepared.record.sha256);
    record.envelope.plan.name = 'Caller mutation'; record.bytes.fill(0);
    assert.deepEqual(f.store.readManagedSpecDispatch(f.project.id, input), prepared.record);
    assert.equal(requests, 0); assert.equal(existsSync(join(f.root, prepared.record.envelope.runId)), false);
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(heads(f), before); assert.deepEqual(runIds(f), runs); assert.deepEqual(sourceFiles(f.sourceDir), f.originalSource);
});

test('private dispatch query reads original confirmation after cancellation and source or catalog loss without initializing the catalog', async t => {
  const f = await fixture(t), input = preparedInput(f), first = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  await f.store.selectBaseline(f.project.id, { ...cas(f.store), mode: 'spec', approvalId: null, contentDigest: null, reason: '取消但保留已接受操作' });
  renameSync(f.sourceDir, f.sourceDir + '.saved');
  renameSync(join(f.root, 'catalog.json'), join(f.root, 'catalog.saved'));
  const restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  const record = restarted.readManagedSpecDispatch(f.project.id, input);
  assert.deepEqual(record, first.record); assert.equal(existsSync(join(f.root, 'catalog.json')), false);
  assert.equal(published(f).length, 1); assert.equal(existsSync(join(f.root, record.envelope.runId)), false);
  assert.deepEqual(sourceFiles(f.sourceDir + '.saved'), f.originalSource);
});

test('private dispatch query requires all original confirmation fields and rejects unknown fields or getters before storage access', async t => {
  const f = await fixture(t), input = preparedInput(f);
  let called = false;
  const accessor = { ...input }; Object.defineProperty(accessor, 'contentDigest', { enumerable: true, get() { called = true; return input.contentDigest; } });
  for (const raw of [{ ...input, plan: f.plan }, { ...input, expectedRevision: '8' }, { ...input, operationId: '../outside' }, accessor]) {
    assert.throws(() => f.store.readManagedSpecDispatch(f.project.id, raw), { code: 'INVALID_INPUT' });
  }
  assert.equal(called, false); assert.equal(existsSync(dispatchDir(f)), false);
  const first = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  for (const patch of [{ expectedGenerationId: uid('ag') }, { expectedRevision: input.expectedRevision + 1 },
    { targetReleaseId: f.release.id }, { selectionId: uid('as') }, { contentDigest: 'a'.repeat(64) }]) {
    assert.throws(() => f.store.readManagedSpecDispatch(f.project.id, { ...input, ...patch }), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.throws(() => f.store.readManagedSpecDispatch(uid('ap'), input), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.store.readManagedSpecDispatch(f.project.id, input), first.record); assert.equal(published(f).length, 1);
});

test('private dispatch query preserves corrupt accepted bytes and refuses reads when the owner is lost', async t => {
  const f = await fixture(t), input = preparedInput(f), first = await f.store.prepareManagedSpecDispatch(f.project.id, input);
  const file = join(dispatchDir(f), input.operationId + '.json'); writeFileSync(file, '{broken-query-record');
  assert.throws(() => f.store.readManagedSpecDispatch(f.project.id, input), { code: 'MANAGED_DISPATCH_UNAVAILABLE' });
  assert.equal(readFileSync(file, 'utf8'), '{broken-query-record');
  f.active = false;
  assert.throws(() => f.store.readManagedSpecDispatch(f.project.id, input), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.throws(() => f.store.readManagedSpecDispatch(f.project.id, { ...input, operationId: uid('ao') }), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.equal(published(f).length, 1); assert.equal(existsSync(join(f.root, first.record.envelope.runId)), false);
});
