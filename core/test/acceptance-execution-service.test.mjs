import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { managedExecutionFixture, facts } from '../scripts/fixtures/managed-execution.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceExecutionRuntime } from '../src/acceptance/execution-runtime.mjs';
import { createManagedSpecExecutionService } from '../src/acceptance/execution-service.mjs';
import { handleAcceptanceExecutionRequest, acceptanceExecutionError } from '../src/acceptance/execution-api.mjs';
import { createManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';

const uid = prefix => prefix + '-' + randomUUID();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cas = catalog => { const { generationId, revision } = catalog.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const dispatches = f => {
  const dir = join(f.root, 'managed-spec-dispatches', 'v1');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^ao-.*\.json$/.test(name)) : [];
};
async function fixture(t, options = {}) {
  const f = await managedExecutionFixture({ paths: ['/healthy'], ...options });
  t.after(() => f.cleanup());
  return f;
}
function serviceOf(f, options = {}) {
  const runtime = options.runtime ?? createAcceptanceExecutionRuntime();
  const service = createManagedSpecExecutionService({ owner: f.owner, catalog: f.catalog, runtime, ...options });
  return { runtime, service };
}
/** Only the service call stack is under test here. This synchronous adapter
 * still creates the real owner-fenced manifest, and retains its exact lease. */
function controlledWorker(t, afterCreate = () => {}) {
  const starts = [];
  const startExecution = options => {
    const { runtime, lease, record, owner } = options, e = record.envelope;
    runtime.assertHeld(lease);
    runtime.bind(lease, { runId: e.runId, taskId: e.taskId });
    createManagedAcceptanceRun({ operationId: e.operationId, dispatchSha256: record.sha256 }, {
      owner, assertActive: () => runtime.assertActive(lease),
    });
    const ended = deferred(); let done = false;
    const handle = { taskId: e.taskId, runId: e.runId, finished: ended.promise, finish() {
      if (done) return;
      done = true;
      try { runtime.assertHeld(lease); runtime.release(lease); } catch { /* cleanup of an already released test lease */ }
      ended.resolve({ taskId: e.taskId });
    } };
    starts.push({ ...options, handle });
    afterCreate(options, handle);
    return handle;
  };
  const finish = () => starts.forEach(item => item.handle.finish());
  t.after(finish);
  return { starts, startExecution, finish };
}
async function serving(t, service) {
  const server = createServer(async (req, res) => {
    const json = (response, status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload));
    };
    const handled = await handleAcceptanceExecutionRequest(req, res, new URL(req.url, 'http://fixture'), { service, json });
    if (!handled) json(res, 404, { code: 'FALLTHROUGH' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10000) });
    return { status: response.status, payload: options.method === 'HEAD' ? null : await response.json(), headers: response.headers };
  };
}
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
const operationKeys = ['schemaVersion', 'operationId', 'projectId', 'runId', 'taskId', 'sourceRunId', 'targetReleaseId', 'state', 'runCreated', 'gate', 'reasonCode'];
const keys = value => Object.keys(value).sort();

test('execution service: real fresh admission runs the approved target once and only committed facts become completed', async t => {
  const f = await fixture(t, { paths: ['/healthy', '/bug'] });
  const { runtime, service } = serviceOf(f), input = f.confirmation();
  const accepted = await service.execute(f.project.id, input);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.payload.replayed, false);
  assert.equal(accepted.payload.runCreated, true);
  assert.equal(accepted.payload.state, 'running');
  await service.drain();
  const final = service.read(f.project.id, input.operationId);
  assert.equal(final.state, 'completed');
  assert.equal(final.gate, 'failed', 'business-code bug remains an acceptance failure');
  assert.equal(runtime.state().busy, false);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.path.startsWith('/target/')));
  const before = facts(f.root);
  const replay = await service.execute(f.project.id, input);
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.runId, accepted.payload.runId);
  assert.deepEqual(facts(f.root), before);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(facts(f.sourceDir), f.sourceBefore);
  assert.equal(f.modelRequests.length, 0);
});

test('execution service: same-key concurrent callers share one preparation/start and conflicting confirmation is rejected before busy', async t => {
  const f = await fixture(t), gate = deferred(), worker = controlledWorker(t);
  let prepares = 0;
  const catalog = { ...f.catalog, async prepareManagedSpecDispatch(...args) { prepares++; await gate.promise; return f.catalog.prepareManagedSpecDispatch(...args); } };
  const { runtime, service } = serviceOf(f, { catalog, startExecution: worker.startExecution }), input = f.confirmation();
  const first = service.execute(f.project.id, input), duplicate = service.execute(f.project.id, { ...input });
  await assert.rejects(service.execute(f.project.id, { ...input, targetReleaseId: f.alternateRelease.id }), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  await assert.rejects(service.execute(f.project.id, f.confirmation()), { code: 'EXECUTION_BUSY', status: 409 });
  assert.equal(runtime.state().busy, true);
  assert.equal(prepares, 1);
  assert.equal(worker.starts.length, 0);
  assert.deepEqual(dispatches(f), []);
  gate.resolve();
  const [fresh, replay] = await Promise.all([first, duplicate]);
  assert.equal(fresh.status, 202); assert.equal(replay.status, 200);
  assert.equal(fresh.payload.replayed, false); assert.equal(replay.payload.replayed, true);
  assert.equal(fresh.payload.runId, replay.payload.runId);
  assert.equal(worker.starts.length, 1);
  assert.deepEqual(dispatches(f), [input.operationId + '.json']);
  worker.finish(); await service.drain();
});

test('execution service: prepared operations are queries before busy even after the selection/catalog/source change', async t => {
  const f = await fixture(t), prepared = await f.prepareOnly(), worker = controlledWorker(t);
  await f.catalog.selectBaseline(f.project.id, { ...cas(f.catalog), mode: 'spec', approvalId: null, contentDigest: null, reason: '取消当前选用以验证原操作只读查询' });
  fs.renameSync(join(f.root, 'catalog.json'), join(f.root, 'catalog.saved.json'));
  fs.renameSync(f.sourceDir, f.sourceDir + '.saved');
  const { runtime, service } = serviceOf(f, { startExecution: worker.startExecution });
  const legacy = runtime.reserve({ kind: 'legacy' }), before = facts(f.root);
  const result = await service.execute(f.project.id, prepared.input);
  assert.equal(result.status, 200);
  assert.equal(result.payload.state, 'prepared');
  assert.equal(result.payload.runCreated, false);
  assert.equal(result.payload.replayed, true);
  assert.equal(result.payload.runId, prepared.envelope.runId);
  assert.equal(runtime.assertActive(legacy), true);
  await assert.rejects(service.execute(f.project.id, { ...prepared.input, expectedRevision: prepared.input.expectedRevision + 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(worker.starts.length, 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(facts(f.root), before);
  runtime.release(legacy);
});

test('execution service: an operation appearing during preparation is replayed without borrowing fresh authority', async t => {
  const f = await fixture(t), worker = controlledWorker(t), input = f.confirmation();
  let prepares = 0;
  const catalog = { ...f.catalog, async prepareManagedSpecDispatch(projectId, raw, options) {
    prepares++;
    await f.catalog.prepareManagedSpecDispatch(projectId, raw);
    return f.catalog.prepareManagedSpecDispatch(projectId, raw, options);
  } };
  const { runtime, service } = serviceOf(f, { catalog, startExecution: worker.startExecution });
  const result = await service.execute(f.project.id, input);
  assert.equal(result.status, 200); assert.equal(result.payload.replayed, true);
  assert.equal(result.payload.state, 'prepared'); assert.equal(result.payload.runCreated, false);
  assert.equal(prepares, 1); assert.equal(worker.starts.length, 0);
  assert.equal(runtime.state().busy, false); assert.equal(f.requests.length, 0);
});

test('execution service: close before queued preparation publishes no dispatch, run, task or namespace', async t => {
  const f = await fixture(t), worker = controlledWorker(t), before = facts(f.root);
  const { runtime, service } = serviceOf(f, { startExecution: worker.startExecution });
  const admission = service.execute(f.project.id, f.confirmation());
  assert.equal(runtime.state().busy, true);
  runtime.close();
  await assert.rejects(admission, { code: 'EXECUTION_STOPPED', status: 503 });
  await service.drain();
  assert.deepEqual(facts(f.root), before);
  assert.equal(fs.existsSync(join(f.root, 'managed-spec-dispatches')), false);
  assert.equal(runtime.state().busy, false);
  assert.equal(runtime.state().closing, true);
  assert.equal(worker.starts.length, 0); assert.equal(f.requests.length, 0);
  await assert.rejects(service.execute(f.project.id, f.confirmation()), { code: 'EXECUTION_CLOSED' });
});

test('execution service: a newly failing readiness fence revokes queued preparation before publication', async t => {
  const f = await fixture(t), worker = controlledWorker(t), before = facts(f.root);
  let ready = true;
  const { runtime, service } = serviceOf(f, { startExecution: worker.startExecution, assertReady() {
    if (!ready) throw Object.assign(Error('private recovery state'), { code: 'MANAGED_EXECUTION_UNAVAILABLE', status: 503 });
  } });
  const admission = service.execute(f.project.id, f.confirmation());
  ready = false;
  await assert.rejects(admission, { code: 'MANAGED_EXECUTION_UNAVAILABLE' });
  assert.deepEqual(facts(f.root), before);
  assert.equal(runtime.state().busy, false); assert.equal(worker.starts.length, 0);
  const capability = service.capability();
  assert.equal(capability.ready, false); assert.equal(capability.recoveryReady, false);
});

test('execution service: readiness accepts only synchronous true/undefined and never invokes async, proxy or thenable hooks', async t => {
  const f = await fixture(t), before = facts(f.root);
  let hooks = 0, starts = 0;
  const hooked = Promise.resolve(true);
  Object.defineProperty(hooked, 'constructor', { get() { hooks++; throw Error('private constructor'); } });
  class HookedPromise extends Promise { static get [Symbol.species]() { hooks++; throw Error('private species'); } }
  const subclass = new HookedPromise(resolve => resolve(true));
  const thenable = { get then() { hooks++; throw Error('private then'); } };
  const guards = [() => false, () => 0, () => ({}), () => thenable, () => hooked, () => subclass,
    () => Promise.reject(Error('ordinary accidental rejection')), () => { throw Promise.reject(Error('ordinary thrown rejection')); },
    async () => { hooks++; }, function* () { hooks++; },
    new Proxy(() => true, { apply() { hooks++; throw Error('private apply'); } }), false, thenable];
  for (const assertReady of guards) {
    const { runtime, service } = serviceOf(f, { assertReady, startExecution() { starts++; throw Error('must not start'); } });
    assert.equal(service.capability().ready, false);
    assert.equal(service.capability().recoveryReady, false);
    await assert.rejects(service.execute(f.project.id, f.confirmation()), { code: 'MANAGED_EXECUTION_UNAVAILABLE', status: 503 });
    assert.equal(runtime.state().busy, false);
    assert.deepEqual(facts(f.root), before);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks, 0); assert.equal(starts, 0);
  for (const assertReady of [() => true, () => undefined]) assert.equal(serviceOf(f, { assertReady }).service.capability().ready, true);
});

test('execution service: unknown preparation outcome blocks fresh admission while retry only queries preserved bytes', async t => {
  const f = await fixture(t), worker = controlledWorker(t);
  let hooks = 0;
  const catalog = createAcceptanceCatalogStore({ root: f.root, owner: f.owner, managedDispatchOptions: {
    hooks: { afterPublish() { hooks++; throw Error('private response failure'); } },
  } });
  const { runtime, service } = serviceOf(f, { catalog, startExecution: worker.startExecution }), input = f.confirmation();
  const outcomes = await Promise.allSettled([service.execute(f.project.id, input), service.execute(f.project.id, { ...input })]);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.writeMayHaveCommitted === true));
  assert.equal(hooks, 1); assert.equal(worker.starts.length, 0);
  assert.equal(runtime.state().blocked, true); assert.equal(runtime.state().busy, false);
  const preserved = fs.readFileSync(f.sidecar(input.operationId)), before = facts(f.root);
  const retry = await service.execute(f.project.id, input);
  assert.equal(retry.status, 200); assert.equal(retry.payload.replayed, true);
  assert.equal(retry.payload.state, 'prepared'); assert.equal(retry.payload.runCreated, false);
  assert.deepEqual(fs.readFileSync(f.sidecar(input.operationId)), preserved);
  assert.deepEqual(facts(f.root), before);
  await assert.rejects(service.execute(f.project.id, f.confirmation()), { code: 'EXECUTION_BLOCKED' });
  assert.equal(worker.starts.length, 0); assert.equal(f.requests.length, 0);
});

test('execution service: a start rejection never converts a saved preparation into a retry queue', async t => {
  const f = await fixture(t); let starts = 0;
  const { runtime, service } = serviceOf(f, { startExecution() { starts++; throw Error('start rejected before taking ownership'); } });
  const input = f.confirmation();
  await assert.rejects(service.execute(f.project.id, input), /start rejected/);
  assert.equal(runtime.state().busy, false);
  const before = facts(f.root), retry = await service.execute(f.project.id, input);
  assert.equal(retry.status, 200); assert.equal(retry.payload.replayed, true);
  assert.equal(retry.payload.state, 'prepared'); assert.equal(retry.payload.runCreated, false);
  assert.equal(starts, 1); assert.equal(f.requests.length, 0);
  assert.deepEqual(facts(f.root), before);
});

test('execution service: response read failure after start preserves the owned lease and cannot restart the operation', async t => {
  const f = await fixture(t), worker = controlledWorker(t, (options, handle) => {
    fs.writeFileSync(join(f.diskRun(handle.runId), 'manifest.json'), '{}');
  });
  const { runtime, service } = serviceOf(f, { startExecution: worker.startExecution }), input = f.confirmation();
  await assert.rejects(service.execute(f.project.id, input));
  assert.equal(worker.starts.length, 1);
  const lease = worker.starts[0].lease;
  assert.equal(runtime.assertHeld(lease), true, 'service must not release the transferred running worker');
  const before = facts(f.root);
  await assert.rejects(service.execute(f.project.id, input));
  await assert.rejects(service.execute(f.project.id, f.confirmation()), { code: 'EXECUTION_BUSY' });
  assert.deepEqual(facts(f.root), before);
  worker.finish(); await service.drain();
  await assert.rejects(service.execute(f.project.id, input));
  assert.equal(worker.starts.length, 1); assert.equal(f.requests.length, 0);
  assert.deepEqual(facts(f.root), before);
});

test('execution service: read is physically read-only and does not claim partial/empty run directories are prepared', async t => {
  const f = await fixture(t), { service } = serviceOf(f), input = f.confirmation();
  const beforeMissing = facts(f.root);
  assert.throws(() => service.read(f.project.id, input.operationId), { code: 'NOT_FOUND', status: 404 });
  assert.deepEqual(facts(f.root), beforeMissing);
  const { record } = await f.catalog.prepareManagedSpecDispatch(f.project.id, input), e = record.envelope;
  const prepared = service.read(f.project.id, input.operationId);
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.runCreated, false);
  fs.mkdirSync(f.diskRun(e.runId));
  const beforePartial = facts(f.root);
  assert.throws(() => service.read(f.project.id, input.operationId), { code: 'MANAGED_EXECUTION_UNAVAILABLE', status: 503 });
  assert.deepEqual(facts(f.root), beforePartial);
  assert.throws(() => service.read(uid('ap'), input.operationId), { code: 'NOT_FOUND' });
  assert.throws(() => service.read('../secret', input.operationId), { code: 'INVALID_INPUT' });
  assert.equal(f.requests.length, 0);
});

test('catalog admission options: invalid descriptors and async/proxy functions reject before side storage or caller hooks', async t => {
  const f = await fixture(t), before = facts(f.root);
  let hooks = 0;
  const getter = { get assertAdmission() { hooks++; return () => {}; } };
  const proxy = new Proxy({}, { getPrototypeOf() { hooks++; throw Error('private hook'); } });
  for (const options of [null, [], { unknown: true }, getter, proxy,
    { assertAdmission: false }, { assertAdmission: async () => { hooks++; } },
    { assertAdmission: function* () { hooks++; } },
    { assertAdmission: new Proxy(() => {}, { apply() { hooks++; throw Error('private hook'); } }) }]) {
    await assert.rejects(f.catalog.prepareManagedSpecDispatch(f.project.id, f.confirmation(), options), { code: 'INVALID_INPUT' });
    assert.deepEqual(facts(f.root), before);
  }
  assert.equal(hooks, 0);
});

test('catalog admission options: false, thenables and Promise constructor/species hooks never publish or execute hooks', async t => {
  const f = await fixture(t), before = facts(f.root);
  let hooks = 0;
  const promise = Promise.resolve(true);
  Object.defineProperty(promise, 'constructor', { get() { hooks++; throw Error('private constructor'); } });
  class HookedPromise extends Promise { static get [Symbol.species]() { hooks++; throw Error('private species'); } }
  const subclass = new HookedPromise(resolve => resolve(true));
  const thenable = { get then() { hooks++; throw Error('private then'); } };
  for (const result of [false, 0, {}, thenable, promise, subclass]) {
    await assert.rejects(f.catalog.prepareManagedSpecDispatch(f.project.id, f.confirmation(), { assertAdmission: () => result }), { code: 'MANAGED_EXECUTION_UNAVAILABLE', status: 503 });
    assert.deepEqual(facts(f.root), before);
  }
  const rejected = Promise.reject(Error('ordinary accidental rejection'));
  await assert.rejects(f.catalog.prepareManagedSpecDispatch(f.project.id, f.confirmation(), { assertAdmission: () => rejected }), { code: 'MANAGED_EXECUTION_UNAVAILABLE' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks, 0);
  assert.deepEqual(facts(f.root), before);
});

test('catalog admission options: the final publication fence can revoke a prepared temporary without publishing authority', async t => {
  const f = await fixture(t); let active = true, fences = 0;
  const catalog = createAcceptanceCatalogStore({ root: f.root, owner: f.owner, managedDispatchOptions: {
    hooks: { afterTemporaryWrite() { active = false; } },
  } });
  const runs = fs.readdirSync(f.root).filter(name => /^ac-/.test(name));
  await assert.rejects(catalog.prepareManagedSpecDispatch(f.project.id, f.confirmation(), { assertAdmission() {
    fences++;
    if (!active) throw Object.assign(Error('admission revoked'), { code: 'MANAGED_EXECUTION_UNAVAILABLE', status: 503 });
    return true;
  } }), { code: 'MANAGED_DISPATCH_UNAVAILABLE', status: 503 });
  assert.ok(fences >= 3);
  assert.deepEqual(dispatches(f), []);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => /^ac-/.test(name)), runs);
  assert.deepEqual(facts(f.sourceDir), f.sourceBefore);
  assert.equal(f.requests.length, 0);
});

test('execution HTTP: strict body parsing and confirmation schema reject invalid input without admission side effects', async t => {
  const f = await fixture(t), worker = controlledWorker(t), { runtime, service } = serviceOf(f, { startExecution: worker.startExecution });
  const request = await serving(t, service), input = f.confirmation(), before = facts(f.root);
  const missing = { ...input }; delete missing.selectionId;
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]);
  const bodies = ['', '{bad', '[]', 'null', '"text"', 'true', '0', invalidUtf8, {}, missing,
    { ...input, plan: { targetUrl: 'http://private.invalid' } }, { ...input, approved: true },
    { ...input, targetUrl: 'http://private.invalid' }, { ...input, actor: { kind: 'administrator' } },
    { ...input, expectedRevision: '1' }, { ...input, operationId: '../operation' },
    JSON.stringify(input).replace('}', ',"__proto__":{"polluted":true}}')];
  for (const body of bodies) {
    const response = await request(f.executionPath, post(body));
    assert.equal(response.status, 400, String(body));
    assert.equal(response.payload.code, 'INVALID_INPUT');
    assert.equal(runtime.state().busy, false);
    assert.deepEqual(facts(f.root), before);
  }
  const oversized = await request(f.executionPath, post(' '.repeat(16 * 1024 + 1)));
  assert.equal(oversized.status, 413); assert.equal(oversized.payload.code, 'INVALID_INPUT');
  assert.equal(worker.starts.length, 0); assert.equal(f.requests.length, 0);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(facts(f.root), before);
});

test('execution HTTP: methods, queries and exact routes are bounded before fresh execution', async t => {
  const f = await fixture(t), worker = controlledWorker(t), { service } = serviceOf(f, { startExecution: worker.startExecution });
  const request = await serving(t, service), op = uid('ao'), before = facts(f.root);
  for (const [path, method, allowed] of [[f.executionPath, 'GET', 'POST'], [f.executionPath, 'HEAD', 'POST'],
    [f.executionPath + '/' + op, 'POST', 'GET'], ['/api/acceptance/execution', 'POST', 'GET']]) {
    const response = await request(path, { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), allowed);
    if (method !== 'HEAD') assert.equal(response.payload.code, 'METHOD_NOT_ALLOWED');
  }
  for (const query of ['?unknown=1', '?token=a&token=b']) {
    const response = await request(f.executionPath + query, post(f.confirmation()));
    assert.equal(response.status, 400); assert.equal(response.payload.code, 'INVALID_INPUT');
  }
  for (const path of [f.executionPath + '/', f.executionPath + '/not-an-operation', f.executionPath + '/' + op + '/retry',
    '/api/acceptance/execution/extra', f.executionPath.replace(f.project.id, 'not-a-project')]) {
    assert.equal((await request(path, post(f.confirmation()))).status, 404);
  }
  const capability = await request('/api/acceptance/execution?token=one');
  assert.equal(capability.status, 200);
  assert.equal(capability.headers.get('cache-control'), 'no-store');
  assert.equal(capability.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(worker.starts.length, 0); assert.equal(f.requests.length, 0);
  assert.deepEqual(facts(f.root), before);
});

test('execution HTTP: response DTOs expose fixed safe facts and existing operations remain queries while busy', async t => {
  const f = await fixture(t), worker = controlledWorker(t), { runtime, service } = serviceOf(f, { startExecution: worker.startExecution });
  const request = await serving(t, service), input = f.confirmation();
  const accepted = await request(f.executionPath, post(input));
  assert.equal(accepted.status, 202);
  assert.deepEqual(keys(accepted.payload), [...operationKeys, 'replayed'].sort());
  assert.equal(accepted.payload.state, 'running'); assert.equal(accepted.payload.replayed, false);
  const operationPath = f.executionPath + '/' + input.operationId;
  const read = await request(operationPath);
  assert.equal(read.status, 200); assert.deepEqual(keys(read.payload), [...operationKeys].sort());
  const replay = await request(f.executionPath, post(input));
  assert.equal(replay.status, 200); assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.runId, accepted.payload.runId);
  const busy = await request(f.executionPath, post(f.confirmation()));
  assert.equal(busy.status, 409); assert.equal(busy.payload.code, 'ACCEPTANCE_BUSY');
  const capability = await request('/api/acceptance/execution');
  assert.deepEqual(keys(capability.payload), ['schemaVersion', 'enabled', 'ready', 'busy', 'closing', 'blocked', 'code', 'kind',
    'runId', 'taskId', 'recoveryReady', 'methods', 'triageSupported'].sort());
  assert.equal(capability.payload.ready, false); assert.equal(capability.payload.busy, true);
  assert.equal(capability.payload.triageSupported, false);
  for (const payload of [accepted.payload, read.payload, replay.payload, capability.payload, busy.payload]) {
    const text = JSON.stringify(payload);
    for (const secret of [f.base, f.root, '?tenant=', f.candidate.contentDigest, input.selectionId]) assert.equal(text.includes(secret), false);
  }
  worker.finish(); await service.drain();
  assert.equal(runtime.state().busy, false);
  assert.equal(worker.starts.length, 1); assert.equal(f.requests.length, 0);
});

test('execution HTTP: unknown publication and ordinary internal failures expose only fixed errors', async t => {
  const f = await fixture(t);
  const catalog = createAcceptanceCatalogStore({ root: f.root, owner: f.owner, managedDispatchOptions: {
    hooks: { afterPublish() { throw Error('C:\\private\\secret?token=secret'); } },
  } });
  const { service } = serviceOf(f, { catalog }), request = await serving(t, service), input = f.confirmation();
  const unknown = await request(f.executionPath, post(input));
  assert.equal(unknown.status, 503); assert.equal(unknown.payload.outcomeUnknown, true);
  assert.equal(unknown.payload.code, 'MANAGED_DISPATCH_UNAVAILABLE');
  assert.deepEqual(keys(unknown.payload), ['code', 'error', 'outcomeUnknown']);
  assert.equal(JSON.stringify(unknown.payload).includes('secret'), false);
  const retry = await request(f.executionPath, post(input));
  assert.equal(retry.status, 200); assert.equal(retry.payload.state, 'prepared');
  assert.equal(retry.payload.runCreated, false);
  const closed = await request(f.executionPath, post(f.confirmation()));
  assert.equal(closed.status, 503); assert.equal(closed.payload.code, 'MANAGED_EXECUTION_UNAVAILABLE');
  assert.equal(f.requests.length, 0);
  const other = await fixture(t);
  const internal = serviceOf(other, { startExecution() { throw Object.assign(Error('C:\\private\\secret'), { code: 'EACCES', status: 500 }); } });
  const internalRequest = await serving(t, internal.service);
  const failure = await internalRequest(other.executionPath, post(other.confirmation()));
  assert.equal(failure.status, 503); assert.equal(failure.payload.code, 'CATALOG_UNAVAILABLE');
  assert.equal(JSON.stringify(failure.payload).includes('secret'), false);
});

test('execution HTTP: real executor preflight conflict stays HTTP 409 and its saved operation never starts on retry', async t => {
  const f = await fixture(t); let preflights = 0;
  const { runtime, service } = serviceOf(f, { mirrorFactory: () => ({ preflight() {
    preflights++;
    throw Object.assign(Error('private colliding task /path'), { code: 'TASK_COLLISION', status: 409 });
  } }) });
  const request = await serving(t, service), input = f.confirmation();
  const first = await request(f.executionPath, post(input));
  assert.equal(first.status, 409); assert.equal(first.payload.code, 'MANAGED_EXECUTION_START_FAILED');
  assert.equal(JSON.stringify(first.payload).includes('private'), false);
  assert.equal(runtime.state().busy, false);
  const query = await request(f.executionPath + '/' + input.operationId);
  assert.equal(query.status, 200); assert.equal(query.payload.state, 'prepared'); assert.equal(query.payload.runCreated, false);
  const before = facts(f.root), retry = await request(f.executionPath, post(input));
  assert.equal(retry.status, 200); assert.equal(retry.payload.replayed, true); assert.equal(retry.payload.runCreated, false);
  assert.equal(preflights, 1); assert.equal(f.requests.length, 0);
  assert.deepEqual(facts(f.root), before);
});

test('execution error projection: fixed runtime mappings preserve unknown-outcome facts without reading caller hooks', () => {
  let hooks = 0;
  const getter = { get code() { hooks++; throw Error('private code'); }, get status() { hooks++; throw Error('private status'); },
    get writeMayHaveCommitted() { hooks++; throw Error('private outcome'); } };
  const proxy = new Proxy({}, { get() { hooks++; throw Error('private get'); }, getOwnPropertyDescriptor() { hooks++; throw Error('private descriptor'); } });
  for (const value of [getter, proxy, { code: {}, status: 500 }, { code: Symbol('private') }, null, 'private raw error']) {
    const result = acceptanceExecutionError(value);
    assert.equal(result.status, 503); assert.equal(result.payload.code, 'CATALOG_UNAVAILABLE');
    assert.deepEqual(keys(result.payload), ['code', 'error']);
    assert.equal(JSON.stringify(result.payload).includes('private'), false);
  }
  assert.equal(hooks, 0);
  for (const code of ['EXECUTION_CLOSED', 'EXECUTION_BLOCKED', 'EXECUTION_LEASE_INVALID', 'EXECUTION_STOPPED',
    'EXECUTION_INVALID_INPUT', 'EXECUTION_HANDLER_FAILED', 'MANAGED_EXECUTION_INACTIVE']) {
    const result = acceptanceExecutionError({ code, status: 500, message: 'C:\\private\\secret' });
    assert.equal(result.status, 503); assert.equal(result.payload.code, 'MANAGED_EXECUTION_UNAVAILABLE');
  }
  assert.equal(acceptanceExecutionError({ code: 'EXECUTION_BUSY', status: 503 }).status, 409);
  assert.equal(acceptanceExecutionError({ code: 'EXECUTION_BUSY' }).payload.code, 'ACCEPTANCE_BUSY');
  assert.equal(acceptanceExecutionError({ code: 'INVALID_INPUT', status: 413 }).status, 413);
  assert.equal(acceptanceExecutionError({ code: 'MANAGED_EXECUTION_START_FAILED', status: 409 }).status, 409);
  assert.equal(acceptanceExecutionError({ code: 'MANAGED_EXECUTION_START_FAILED', status: 500 }).status, 503);
  const unknown = acceptanceExecutionError({ code: 'EIO', writeMayHaveCommitted: true, message: 'private path' });
  assert.equal(unknown.status, 503); assert.equal(unknown.payload.code, 'CATALOG_UNAVAILABLE');
  assert.equal(unknown.payload.outcomeUnknown, true);
  const generation = uid('ag');
  const stale = acceptanceExecutionError({ code: 'STALE_REVISION', status: 409,
    details: { generationId: generation, revision: 5, reason: 'CATALOG_CHANGED' } });
  assert.equal(stale.status, 409); assert.equal(stale.payload.currentGenerationId, generation);
  assert.equal(stale.payload.currentRevision, 5);
  assert.deepEqual(stale.payload.details, { generationId: generation, revision: 5, reason: 'CATALOG_CHANGED' });
});
