/** Console contract boundaries against durable offline Core facts; no browser or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { browserExecutionRequest, browserOperationView, browserOperationCollection, browserOperationReport,
  browserExecutionLedger, browserExecutionRegistration, createBrowserExecutionReadGuard,
  createBrowserExecutionReceipts, requestBrowserExecution, fetchBrowserExecutionEvidence } from '../../console/src/acceptance-browser-execution.js';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { createBrowserExecutionService } from '../src/acceptance/browser-execution-service.mjs';

const id = prefix => prefix + '-' + randomUUID();
const projectId = id('ap'), origin = 'http://127.0.0.1:3000';
const copy = value => JSON.parse(JSON.stringify(value));
const invalid = error => error?.code === 'INVALID_RESPONSE';
const request = () => ({ operationId: id('bo'), expectedGenerationId: id('ag'), expectedRevision: 4,
  candidateId: id('bc'), contentDigest: 'a'.repeat(64), targetReleaseId: id('ar') });
function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
function complete(f, options) {
  const input = f.request(); f.publish(input); const run = f.store.createRun(input.operationId);
  const raw = browserOperationRaw(f, run, options);
  if (options?.missing) {
    raw.checks = [{ id: 'runner-environment', route: '/', status: 'blocked', verdict: 'environment', evidence: {} }];
    raw.coverage.completed = 1;
  }
  f.store.finishRun(input.operationId, raw);
  const stored = f.store.read(input.operationId);
  // The HTTP JSON round trip removes shared in-memory references, exactly as a console read does.
  return { input, stored, view: copy(f.service.read(f.project.id, input.operationId)), report: copy(f.service.report(f.project.id, input.operationId)) };
}

test('request validation permits exactly durable confirmation identifiers without executing accessors', () => {
  const original = request(), result = browserExecutionRequest(original);
  assert.deepEqual(result, original); assert.notEqual(result, original);
  for (const change of [{ targetUrl: 'https://unreviewed.test' }, { expectedRevision: -1 }, { contentDigest: 'a'.repeat(63) },
    { candidateId: id('ap') }, { operationId: id('ac') }, { expectedGenerationId: null }]) {
    assert.throws(() => browserExecutionRequest({ ...original, ...change }), invalid);
  }
  let invoked = false;
  const getter = { ...original }; Object.defineProperty(getter, 'candidateId', { enumerable: true, get() { invoked = true; return original.candidateId; } });
  assert.throws(() => browserExecutionRequest(getter), invalid); assert.equal(invoked, false);
  const symbol = { ...original, [Symbol('hidden')]: true };
  assert.throws(() => browserExecutionRequest(symbol), invalid);
});

test('receipts isolate engine origins and projects and reject conflicts or corruption without clearing records', () => {
  const storage = memoryStorage(), receipts = createBrowserExecutionReceipts({ projectId, origin, storage }), input = request();
  receipts.save(input); receipts.save(copy(input)); assert.deepEqual(receipts.read(), [input]);
  const raw = [...storage.values.values()][0];
  assert.deepEqual(Object.keys(JSON.parse(raw)[0]).sort(), Object.keys(input).sort());
  assert.throws(() => receipts.save({ ...input, candidateId: id('bc') }), invalid);
  assert.equal([...storage.values.values()][0], raw);
  assert.deepEqual(createBrowserExecutionReceipts({ projectId: id('ap'), origin, storage }).read(), []);
  assert.deepEqual(createBrowserExecutionReceipts({ projectId, origin: 'http://127.0.0.1:3001', storage }).read(), []);
  assert.throws(() => createBrowserExecutionReceipts({ projectId, origin: origin + '/path', storage }), invalid);
  const key = [...storage.values.keys()][0]; storage.values.set(key, '{broken');
  assert.throws(() => receipts.read(), invalid); assert.throws(() => receipts.save(request()), invalid);
  assert.equal(storage.values.get(key), '{broken');
});

test('receipt writes and resolution require the entire expected collection to survive readback', () => {
  const storage = memoryStorage(), receipts = createBrowserExecutionReceipts({ projectId, origin, storage });
  const first = request(), second = request(); receipts.save(first);
  storage.setItem = (key, value) => { storage.values.set(key, JSON.stringify(JSON.parse(value).slice(-1))); };
  assert.throws(() => receipts.save(second), invalid, 'Keeping only the newest receipt must not hide earlier unknown operations.');
  storage.values.clear(); storage.setItem = (key, value) => { storage.values.set(key, value); };
  receipts.save(first); receipts.save(second);
  storage.setItem = (key, _value) => { storage.values.set(key, '[]'); };
  assert.throws(() => receipts.resolve(first.operationId), invalid, 'Resolving one receipt must preserve every other receipt.');
});

test('read guards cancel superseded channels and reject ABA reads after an epoch reset', () => {
  const guard = createBrowserExecutionReadGuard(), a1 = guard.begin('review'), b1 = guard.begin('report'), a2 = guard.begin('review');
  assert.equal(a1.signal.aborted, true); assert.equal(guard.current(a1), false);
  assert.equal(guard.current(a2), true); assert.equal(guard.current(b1), true);
  guard.reset(); const a3 = guard.begin('review');
  assert.equal(a2.signal.aborted, true); assert.equal(b1.signal.aborted, true);
  assert.equal(guard.current(a2), false); assert.equal(guard.current(b1), false); assert.equal(guard.current(a3), true);
  assert.notEqual(a2.epoch, a3.epoch);
});

test('Core operation views, evidence reports and explicit issue history survive console validation', async t => {
  const f = await browserOperationFixture(t), project = f.project.id;
  f.service = createBrowserExecutionService({ owner: f.owner, store: f.store,
    catalog: { read: () => ({ projects: { [project]: f.project } }) },
    runtime: { state: () => ({ busy: false, closing: false, blocked: false, code: null, kind: null, runId: null, taskId: null }) } });
  f.service.recover();
  const failed = complete(f, { bug: true });
  await t.test('prepared, running and completed metadata preserve the request and project bindings', () => {
    const input = f.request(); f.publish(input); const prepared = copy(f.service.read(project, input.operationId));
    assert.equal(browserOperationView(prepared, project, input.operationId, input), prepared);
    f.store.createRun(input.operationId); const running = copy(f.service.read(project, input.operationId));
    assert.equal(browserOperationView(running, project).state, 'running');
    assert.equal(browserOperationView(failed.view, project, failed.input.operationId, failed.input).gate, 'failed');
    for (const change of [{ projectId: id('ap') }, { candidateId: id('bc') }, { targetReleaseId: id('ar') },
      { contentDigest: 'b'.repeat(64) }, { operationId: id('bo') }, { executionReady: true }]) {
      assert.throws(() => browserOperationView({ ...failed.view, ...change }, project, failed.input.operationId, failed.input), invalid);
    }
    assert.throws(() => browserOperationView({ ...running, gate: 'passed' }, project), invalid);
  });
  await t.test('collections reject duplicate operation IDs, hidden fields and contradictory capability', () => {
    const list = copy(f.service.list(project));
    assert.equal(browserOperationCollection(list, project), list);
    const duplicate = copy(list); duplicate.operations.push(copy(duplicate.operations[0]));
    assert.throws(() => browserOperationCollection(duplicate, project), invalid);
    const readyBusy = copy(list); readyBusy.capability.busy = true;
    assert.throws(() => browserOperationCollection(readyBusy, project), invalid);
    const hidden = copy(list); Object.defineProperty(hidden.operations[0], 'secret', { value: true });
    assert.throws(() => browserOperationCollection(hidden, project), invalid);
    const sparse = copy(list); sparse.operations = Array(1);
    assert.throws(() => browserOperationCollection(sparse, project), invalid);
  });
  await t.test('reports reject crossed identities, fabricated summaries, gates and evidence references', () => {
    assert.equal(browserOperationReport(failed.report, project, failed.view), failed.report);
    const changes = [value => { value.report.runId = id('br'); }, value => { value.report.fixedBaseline.candidateId = id('bc'); },
      value => { value.report.targetReleaseId = id('ar'); }, value => { value.reportSha256 = 'b'.repeat(64); },
      value => { value.report.evidenceManifest.find(entry => entry.file === value.report.sourceEvidence[0].file).sha256 = 'b'.repeat(64); },
      value => { value.report.checks[0].evidence.targetScreenshot = 'unindexed.png'; },
      value => { value.report.checks[0].identity.contextKey = value.report.checks[1].identity.contextKey; },
      value => { value.report.summary.coverage.measured = 0; value.summary.coverage.measured = 0; },
      value => { value.report.summary.dimensions.health.passed++; value.summary.dimensions.health.passed++; },
      value => { value.report.summary.baselineFailed++; value.summary.baselineFailed++; },
      value => { value.report.gate = 'passed'; value.gate = 'passed'; },
      value => { value.report.environmentComparison = { comparable: false, differences: [{ field: 'browserVersion', source: 'a', target: 'b' }] }; }];
    for (const [index, change] of changes.entries()) { const changed = copy(failed.report); change(changed); assert.throws(() => browserOperationReport(changed, project, failed.view), invalid, `Report mutation ${index} must be rejected.`); }
  });
  const initial = f.service.registerResult(project, failed.input.operationId, {}), passed = complete(f);
  const fixed = f.service.registerResult(project, passed.input.operationId, { beforeOperationId: failed.input.operationId });
  await t.test('registered results bind the report, dispatch, candidate, target and explicit previous operation', () => {
    assert.equal(browserExecutionRegistration(copy(initial), project, failed.input.operationId, failed.report).operationId, failed.input.operationId);
    assert.equal(browserExecutionRegistration(copy(fixed), project, passed.input.operationId, passed.report, failed.input.operationId).observations[0].relation, 'verified_passed');
    for (const change of [{ dispatchSha256: 'b'.repeat(64) }, { reportSha256: 'b'.repeat(64) }, { candidateId: id('bc') },
      { targetReleaseId: id('ar') }, { beforeOperationId: null }]) {
      assert.throws(() => browserExecutionRegistration({ ...copy(fixed), ...change }, project, passed.input.operationId, passed.report, failed.input.operationId), invalid);
    }
    const forged = copy(fixed); forged.observations[0].status = 'failed';
    assert.throws(() => browserExecutionRegistration(forged, project, passed.input.operationId, passed.report, failed.input.operationId), invalid);
  });
  await t.test('ledger rebuilds verified passes and reopened issues and rejects fabricated closure', () => {
    const verified = copy(f.service.ledger(project)); assert.equal(browserExecutionLedger(verified, project).issues[0].status, 'verified_passed');
    const reopened = complete(f, { bug: true }); f.service.registerResult(project, reopened.input.operationId, { beforeOperationId: passed.input.operationId });
    const ledger = copy(f.service.ledger(project)); assert.equal(browserExecutionLedger(ledger, project).issues[0].status, 'reopened');
    assert.equal(ledger.issues[0].history.at(-1).relation, 'reopened');
    for (const change of [value => { value.issues[0].status = 'closed'; }, value => { value.issues[0].status = 'verified_passed'; },
      value => { value.issues[0].closesBusinessIssue = true; }, value => { value.entries[1].contentDigest = 'b'.repeat(64); },
      value => { value.issues[0].history[0].reportSha256 = 'b'.repeat(64); }, value => { value.entries.push(copy(value.entries[0])); }]) {
      const forged = copy(ledger); change(forged); assert.throws(() => browserExecutionLedger(forged, project), invalid);
    }
  });
});

test('console preserves pinned issue history through passed, missing and reliable recovery reports', async t => {
  const f = await browserOperationFixture(t), project = f.project.id;
  f.service = createBrowserExecutionService({ owner: f.owner, store: f.store,
    catalog: { read: () => ({ projects: { [project]: f.project } }) },
    runtime: { state: () => ({ busy: false, closing: false, blocked: false, code: null, kind: null, runId: null, taskId: null }) } });
  f.service.recover();
  const failed = complete(f, { bug: true }); f.service.registerResult(project, failed.input.operationId, {});
  const passed = complete(f); f.service.registerResult(project, passed.input.operationId, { beforeOperationId: failed.input.operationId });
  const missing = complete(f, { missing: true });
  const gap = copy(f.service.registerResult(project, missing.input.operationId, { beforeOperationId: passed.input.operationId }));
  browserExecutionRegistration(gap, project, missing.input.operationId, missing.report, passed.input.operationId);
  const pending = browserExecutionLedger(copy(f.service.ledger(project)), project).issues[0];
  assert.equal(pending.status, 'unverified'); assert.equal(pending.lastVerifiedState, 'verified_passed'); assert.equal(pending.history.length, 3);
  assert.equal(pending.latestOperationId, missing.input.operationId);
  const repaired = complete(f);
  const recovered = copy(f.service.registerResult(project, repaired.input.operationId, { beforeOperationId: missing.input.operationId }));
  assert.equal(recovered.observations[0].beforeCheckId, null); assert.match(recovered.beforeObservationSha256, /^[a-f0-9]{64}$/);
  browserExecutionRegistration(recovered, project, repaired.input.operationId, repaired.report, missing.input.operationId);
  const fixed = browserExecutionLedger(copy(f.service.ledger(project)), project).issues[0];
  assert.equal(fixed.status, 'verified_passed'); assert.equal(fixed.history.length, 4);
  for (const value of [undefined, 'bad', 1, null]) {
    const malformed = { ...copy(recovered), beforeObservationSha256: value };
    assert.throws(() => browserExecutionRegistration(malformed, project, repaired.input.operationId, repaired.report, missing.input.operationId), invalid);
  }
  const wrongScope = { ...copy(recovered), beforeOperationId: null };
  assert.throws(() => browserExecutionRegistration(wrongScope, project, repaired.input.operationId, repaired.report), invalid);
});

test('POST transport ambiguity retains the original operation without retrying the request', async () => {
  const path = `/${projectId}/browser-executions`, body = request();
  const cases = [async () => { throw new TypeError('Connection lost after commit.'); },
    async () => new Response('{broken', { status: 202 }),
    async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }),
    async () => new Response(JSON.stringify({ error: 'Read original operation', outcomeUnknown: true }), { status: 409 }),
    async () => new Response('{}', { status: 201 })];
  for (const response of cases) {
    const storage = memoryStorage(), receipts = createBrowserExecutionReceipts({ projectId, origin, storage }); receipts.save(body);
    let calls = 0;
    await assert.rejects(requestBrowserExecution(path, { method: 'POST', body, fetcher: async (...args) => { calls++; return response(...args); } }), error => error.outcomeUnknown === true);
    assert.equal(calls, 1); assert.deepEqual(receipts.read(), [body]);
  }
  await assert.rejects(requestBrowserExecution(path, { method: 'POST', body, fetcher: async () => new Response(JSON.stringify({ error: 'Stale version', code: 'STALE_CATALOG' }), { status: 409 }) }), error => error.status === 409 && error.outcomeUnknown === false);
});

test('unfinished POST fetch reaches its independent deadline once and retains the original receipt', async () => {
  const input = request(), storage = memoryStorage(), receipts = createBrowserExecutionReceipts({ projectId, origin, storage });
  receipts.save(input); const reads = createBrowserExecutionReadGuard(); reads.begin('list');
  let calls = 0, submittedSignal;
  const pending = requestBrowserExecution(`/${projectId}/browser-executions`, { method: 'POST', body: input, timeoutMs: 15,
    fetcher: async (_url, options) => { calls++; submittedSignal = options.signal; return new Promise(() => {}); } });
  reads.reset(); // A project/version read epoch change must not cancel or repeat the POST.
  assert.equal(submittedSignal.aborted, false);
  await assert.rejects(pending, error => error.code === 'BROWSER_REQUEST_TIMEOUT' && error.outcomeUnknown === true);
  assert.equal(calls, 1); assert.equal(submittedSignal.aborted, true); assert.deepEqual(receipts.read(), [input]);
});

test('unfinished POST response body shares the fetch deadline and retains the original receipt', async () => {
  const input = request(), storage = memoryStorage(), receipts = createBrowserExecutionReceipts({ projectId, origin, storage });
  receipts.save(input); let calls = 0, bodies = 0, submittedSignal;
  await assert.rejects(requestBrowserExecution(`/${projectId}/browser-executions`, { method: 'POST', body: input, timeoutMs: 15,
    fetcher: async (_url, options) => { calls++; submittedSignal = options.signal; return { ok: true, status: 202,
      json: async () => { bodies++; return new Promise(() => {}); } }; } }), error => error.code === 'BROWSER_REQUEST_TIMEOUT' && error.outcomeUnknown === true);
  assert.equal(calls, 1); assert.equal(bodies, 1); assert.equal(submittedSignal.aborted, true); assert.deepEqual(receipts.read(), [input]);
});

test('settled POSTs detach external abort listeners and clear the independent deadline', async () => {
  for (const status of [202, 503]) {
    const controller = new AbortController(); let submittedSignal;
    const pending = requestBrowserExecution(`/${projectId}/browser-executions`, { method: 'POST', body: request(), signal: controller.signal, timeoutMs: 25,
      fetcher: async (_url, options) => { submittedSignal = options.signal; assert.notEqual(submittedSignal, controller.signal); return new Response('{}', { status }); } });
    if (status === 202) assert.deepEqual(await pending, {}); else await assert.rejects(pending, error => error.status === 503 && error.outcomeUnknown === true);
    controller.abort(); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(submittedSignal.aborted, false, 'Neither an old external abort nor a stale deadline can affect a settled mutation.');
  }
});

test('external POST cancellation remains ambiguous and never retries transport', async () => {
  const controller = new AbortController(); let calls = 0, submittedSignal;
  const pending = requestBrowserExecution(`/${projectId}/browser-executions`, { method: 'POST', body: request(), signal: controller.signal, timeoutMs: 500,
    fetcher: async (_url, options) => { calls++; submittedSignal = options.signal; return new Promise(() => {}); } });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'BROWSER_REQUEST_ABORTED' && error.outcomeUnknown === true);
  assert.equal(calls, 1); assert.equal(submittedSignal.aborted, true);
  await assert.rejects(requestBrowserExecution(`/${projectId}/browser-executions`, { method: 'POST', body: request(), signal: controller.signal,
    fetcher: async () => { calls++; } }), error => error.code === 'BROWSER_REQUEST_ABORTED' && error.outcomeUnknown === true);
  assert.equal(calls, 1, 'A pre-cancelled submission never starts transport.');
});

test('GET abort propagates and unsupported paths never reach transport', async () => {
  const abort = new DOMException('cancelled', 'AbortError'), controller = new AbortController(); let calls = 0;
  await assert.rejects(requestBrowserExecution(`/${projectId}/browser-bugs`, { signal: controller.signal, fetcher: async (_url, options) => {
    calls++; assert.equal(options.signal, controller.signal); assert.equal(options.cache, 'no-store'); throw abort;
  } }), error => error === abort);
  await assert.rejects(requestBrowserExecution(`/${projectId}/browser-bugs`, { fetcher: async () => ({ ok: true, status: 200, json: async () => { throw abort; } }) }), error => error === abort);
  for (const path of [`/${projectId}/browser-bugs?project=other`, `/${projectId}/browser-executions/../report`, '/unknown']) {
    await assert.rejects(requestBrowserExecution(path, { fetcher: async () => { calls++; } }), invalid);
  }
  assert.equal(calls, 1);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aarsAAAAASUVORK5CYII=', 'base64');
const pngEntry = () => ({ file: 'target.png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
function pngResponse(entry, bytes = png, headers = {}) {
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': String(entry.bytes), 'x-content-sha256': entry.sha256, ...headers } });
}
test('image evidence binds exact bytes, headers and operation before yielding a Blob', async () => {
  const entry = pngEntry(), operationId = id('bo'), controller = new AbortController(); let url;
  const blob = await fetchBrowserExecutionEvidence({ projectId, operationId, entry }, { crypto: webcrypto, signal: controller.signal,
    fetcher: async (address, options) => { url = address; assert.equal(options.signal, controller.signal); return pngResponse(entry); } });
  assert.equal(blob.type, 'image/png'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
  assert.ok(url.endsWith(`/browser-executions/${operationId}/evidence/target.png?expectedSha256=${entry.sha256}`));
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
  for (const response of [pngResponse(entry, changed), pngResponse(entry, png, { 'x-content-sha256': 'b'.repeat(64) }),
    pngResponse(entry, png, { 'content-length': String(entry.bytes + 1) }), pngResponse(entry, png, { 'content-type': 'text/html' })]) {
    await assert.rejects(fetchBrowserExecutionEvidence({ projectId, operationId, entry }, { crypto: webcrypto, fetcher: async () => response }), invalid);
  }
  const nonPng = Buffer.alloc(png.length), nonPngEntry = { ...entry, sha256: createHash('sha256').update(nonPng).digest('hex') };
  await assert.rejects(fetchBrowserExecutionEvidence({ projectId, operationId, entry: nonPngEntry }, { crypto: webcrypto, fetcher: async () => pngResponse(nonPngEntry, nonPng) }), invalid);
});

test('image abort is observed after buffered bytes and before creating a displayable Blob', async () => {
  const entry = pngEntry(), controller = new AbortController(), operationId = id('bo');
  await assert.rejects(fetchBrowserExecutionEvidence({ projectId, operationId, entry }, { crypto: webcrypto, signal: controller.signal,
    fetcher: async () => ({ ok: true, headers: pngResponse(entry).headers, arrayBuffer: async () => { controller.abort(); return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength); } }) }), error => error.name === 'AbortError');
});
