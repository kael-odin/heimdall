import assert from 'node:assert/strict';
import test from 'node:test';
import { AcceptanceCatalogError, CATALOG_REQUEST_TIMEOUT_MS, buildCatalogBindingInput, buildCatalogProjectInput, buildCatalogReleaseInput,
  catalogFailure, catalogPreconditions, catalogTargetUrl, catalogTerminalRuns, catalogVersion,
  createCatalogReadGuard, requestAcceptanceCatalog } from '../../console/src/acceptance-catalog.js';

const version = { generationId: 'ag-first-lineage', revision: 12 };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('catalog writes pin both lineage and revision, including revision zero', () => {
  assert.deepEqual(catalogPreconditions(version), { expectedGenerationId: 'ag-first-lineage', expectedRevision: 12 });
  assert.deepEqual(catalogPreconditions({ generationId: 'ag-restored-lineage', revision: 0 }), {
    expectedGenerationId: 'ag-restored-lineage', expectedRevision: 0,
  });
  for (const input of [null, {}, { generationId: '', revision: 0 }, { generationId: 'ag-one', revision: -1 },
    { generationId: 'ag-one', revision: 1.5 }, { generationId: 'ag-one', revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => catalogVersion(input), error => error.code === 'INVALID_RESPONSE');
  }
});

test('project input only submits the declared name and explicit catalog preconditions', () => {
  assert.deepEqual(buildCatalogProjectInput({ name: '  商城验收  ', current: { mirror: 'approved' }, actor: 'other' }, version), {
    expectedGenerationId: 'ag-first-lineage', expectedRevision: 12, name: '商城验收',
  });
  for (const name of ['', '  ', 'x'.repeat(121)]) assert.throws(() => buildCatalogProjectInput({ name }, version), /项目名称/);
});

test('release declarations keep the full normalized URL and never add approval or deployment facts', () => {
  assert.deepEqual(buildCatalogReleaseInput({ label: ' v2 ', targetUrl: 'HTTPS://EXAMPLE.test:443/app/?branch=qa', buildRef: ' commit-42 ', verified: true }, version), {
    expectedGenerationId: 'ag-first-lineage', expectedRevision: 12, label: 'v2', targetUrl: 'https://example.test/app/?branch=qa', buildRef: 'commit-42',
  });
  assert.equal(Object.hasOwn(buildCatalogReleaseInput({ label: 'v1', targetUrl: 'https://example.test', buildRef: '' }, version), 'buildRef'), false);
  assert.notEqual(catalogTargetUrl('https://example.test/app/?branch=qa'), catalogTargetUrl('https://example.test/app/?branch=prod'));
  for (const targetUrl of ['relative/path', 'file:///tmp/site', 'https://u:p@example.test', 'https://example.test/#fragment']) {
    assert.throws(() => buildCatalogReleaseInput({ label: 'v1', targetUrl }, version), error => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => buildCatalogReleaseInput({ label: 'v1', targetUrl: 'https://example.test', buildRef: 'x'.repeat(201) }, version), /构建引用/);
});

test('binding requires a fresh explicit confirmation and sends only selected run and release', () => {
  const draft = { runId: 'ac-run-one', releaseId: 'ar-release-two' };
  for (const confirmed of [undefined, false, 1, 'true']) assert.throws(() => buildCatalogBindingInput({ ...draft, confirmed }, version), /后续归属/);
  assert.deepEqual(buildCatalogBindingInput({ ...draft, confirmed: true, approved: true, targetUrl: 'https://ignored.test' }, version), {
    expectedGenerationId: 'ag-first-lineage', expectedRevision: 12, runId: 'ac-run-one', releaseId: 'ar-release-two',
  });
  assert.throws(() => buildCatalogBindingInput({ ...draft, confirmed: true, runId: '' }, version), /历史运行/);
});

test('only terminal runs enter the claim selector, without changing original history', () => {
  const runs = ['completed', 'failed', 'interrupted', 'running', 'unknown'].map((status, index) => ({ runId: `ac-${index}`, status }));
  assert.deepEqual(catalogTerminalRuns(runs).map(run => run.status), ['completed', 'failed', 'interrupted']);
  assert.equal(runs.length, 5);
  const managed = { runId: 'ac-managed', status: 'completed', provenance: { kind: 'managed-spec' } };
  assert.deepEqual(catalogTerminalRuns([...runs, managed]), runs.slice(0, 3));
});

test('detail read guards discard delayed responses after project changes and newer refreshes', () => {
  const guard = createCatalogReadGuard();
  const oldA = guard.next('project-a');
  const currentB = guard.next('project-b');
  assert.equal(guard.accepts(oldA, 'project-b'), false);
  assert.equal(guard.accepts(oldA, 'project-a'), false);
  assert.equal(guard.accepts(currentB, 'project-b'), true);
  assert.equal(guard.accepts(currentB, 'project-a'), false);
  const newerB = guard.next('project-b');
  assert.equal(guard.accepts(currentB, 'project-b'), false);
  assert.equal(guard.accepts(newerB, 'project-b'), true);
  guard.invalidate();
  assert.equal(guard.accepts(newerB, 'project-b'), false);
  const last = guard.next('project-a');
  guard.stop();
  assert.equal(guard.accepts(last, 'project-a'), false);
});

test('catalog transport preserves structured conflict code, HTTP status and current CAS version', async () => {
  const payload = { code: 'STALE_REVISION', error: 'Directory changed', currentGenerationId: 'ag-restored', currentRevision: 0,
    details: { expectedGenerationId: version.generationId, expectedRevision: version.revision } };
  let requests = 0;
  await assert.rejects(requestAcceptanceCatalog('/ap-one/releases', { method: 'POST', body: { expectedRevision: 12 },
    fetcher: async () => { requests++; return response(payload, 409); } }), error => {
    assert.deepEqual(catalogFailure(error), { message: 'Directory changed', status: 409, code: 'STALE_REVISION',
      currentGenerationId: 'ag-restored', currentRevision: 0, details: payload.details, writeMayHaveCommitted: false });
    return true;
  });
  assert.equal(requests, 1, 'conflicts must not trigger automatic POST replay');
});

test('a lost write response is uncertain and is never retried automatically', async () => {
  let requests = 0;
  await assert.rejects(requestAcceptanceCatalog('', { method: 'POST', body: { name: 'one' }, fetcher: async () => {
    requests++; throw new TypeError('Connection closed after sending');
  } }), error => error.code === 'NETWORK_ERROR' && error.status === null && error.writeMayHaveCommitted === true);
  assert.equal(requests, 1);
  await assert.rejects(requestAcceptanceCatalog('', { fetcher: async () => { throw new TypeError('Offline'); } }),
    error => error.code === 'NETWORK_ERROR' && error.writeMayHaveCommitted === false);
});

test('malformed successful writes remain uncertain until a GET reconciles the directory', async () => {
  for (const fetcher of [async () => new Response('not json', { status: 201 }), async () => response({ project: { id: 'ap-one' } }, 201)]) {
    await assert.rejects(requestAcceptanceCatalog('', { method: 'POST', body: { name: 'one' }, fetcher }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 201 && error.writeMayHaveCommitted === true);
  }
});

test('successful catalog request uses authenticated JSON without caching or duplicated sends', async () => {
  const calls = [];
  const payload = { ...version, project: { id: 'ap-one', name: 'one' }, event: { revision: 12 } };
  const result = await requestAcceptanceCatalog('', { method: 'POST', body: { name: 'one' }, baseUrl: 'http://127.0.0.1:8900',
    headers: { 'Content-Type': 'application/json', 'x-heimdall-token': 'local-fixture' }, fetcher: async (...args) => {
      calls.push(args); return response(payload, 201);
    } });
  assert.deepEqual(result, payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://127.0.0.1:8900/api/acceptance/projects');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].headers['x-heimdall-token'], 'local-fixture');
  assert.deepEqual(JSON.parse(calls[0][1].body), { name: 'one' });
});

test('server-side unavailable writes keep their structured diagnostic and require reconciliation', async () => {
  await assert.rejects(requestAcceptanceCatalog('', { method: 'POST', body: {}, fetcher: async () => response({
    code: 'CATALOG_UNAVAILABLE', error: 'Atomic replace failed', details: { reason: 'temporarily-busy' },
  }, 503) }), error => error instanceof AcceptanceCatalogError && error.code === 'CATALOG_UNAVAILABLE'
    && error.status === 503 && error.details.reason === 'temporarily-busy' && error.writeMayHaveCommitted);
});

const never = () => new Promise(() => {});
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('catalog deadline defaults to 60 seconds and invalid budgets issue no request', async () => {
  assert.equal(CATALOG_REQUEST_TIMEOUT_MS, 60000);
  let requests = 0;
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, '60000', 2147483648]) {
    await assert.rejects(requestAcceptanceCatalog('', { timeoutMs, fetcher: () => { requests++; } }),
      problem => problem.code === 'INVALID_INPUT' && !problem.writeMayHaveCommitted);
  }
  assert.equal(requests, 0);
});

for (const method of ['GET', 'POST']) {
  test(`${method} fetch ignoring abort still times out with exactly one send`, { timeout: 2000 }, async () => {
    let requests = 0, requestSignal;
    await assert.rejects(requestAcceptanceCatalog('', { method, timeoutMs: 20, ...(method === 'POST' ? { body: {} } : {}),
      fetcher: (_url, options) => { requests++; requestSignal = options.signal; return never(); } }),
    problem => problem.code === 'REQUEST_TIMEOUT' && problem.status === null && problem.writeMayHaveCommitted === (method === 'POST'));
    assert.equal(requests, 1);
    assert.equal(requestSignal.aborted, true);
  });

  test(`${method} body and cancellation ignoring abort cannot keep the caller busy`, { timeout: 2000 }, async () => {
    let requests = 0, cancellations = 0, reads = 0, requestSignal;
    await assert.rejects(requestAcceptanceCatalog('', { method, timeoutMs: 20, ...(method === 'POST' ? { body: {} } : {}),
      fetcher: (_url, options) => { requests++; requestSignal = options.signal; return {
        ok: true, status: method === 'POST' ? 201 : 200,
        json() { reads++; return never(); }, body: { cancel() { cancellations++; return never(); } },
      }; } }), problem => problem.code === 'REQUEST_TIMEOUT' && problem.status === (method === 'POST' ? 201 : 200)
        && problem.writeMayHaveCommitted === (method === 'POST'));
    assert.equal(requests, 1); assert.equal(reads, 1); assert.equal(cancellations, 1); assert.equal(requestSignal.aborted, true);
  });

  for (const stage of ['fetch', 'body']) {
    test(`${method} external abort settles a non-cooperating ${stage} and removes its listener`, { timeout: 2000 }, async () => {
      const controller = new AbortController(), originalAdd = controller.signal.addEventListener.bind(controller.signal),
        originalRemove = controller.signal.removeEventListener.bind(controller.signal);
      let listeners = 0, requests = 0, reads = 0;
      controller.signal.addEventListener = (...args) => { listeners++; originalAdd(...args); };
      controller.signal.removeEventListener = (...args) => { listeners--; originalRemove(...args); };
      const pending = requestAcceptanceCatalog('', { method, signal: controller.signal, timeoutMs: 1000,
        fetcher: () => { requests++; return stage === 'fetch' ? never() : { ok: true, status: 200,
          json() { reads++; return never(); }, body: { cancel: never } }; } });
      const outcome = assert.rejects(pending, problem => method === 'GET' ? problem.name === 'AbortError'
        : problem.code === 'REQUEST_ABORTED' && problem.writeMayHaveCommitted === true);
      await flush(); assert.equal(reads, stage === 'body' ? 1 : 0);
      controller.abort(); await outcome;
      assert.equal(listeners, 0); assert.equal(requests, 1);
    });
  }
}

test('fetch and full JSON body share one deadline rather than restarting it at headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const headers = deferred(), body = deferred(); let reads = 0, failed = false;
  const pending = requestAcceptanceCatalog('', { timeoutMs: 40, fetcher: () => headers.promise });
  const outcome = assert.rejects(pending, problem => { failed = true; return problem.code === 'REQUEST_TIMEOUT'; });
  t.mock.timers.tick(20);
  headers.resolve({ ok: true, status: 200, json() { reads++; return body.promise; }, body: { cancel: never } });
  await flush(); assert.equal(reads, 1);
  t.mock.timers.tick(19); await flush(); assert.equal(failed, false);
  t.mock.timers.tick(1); await outcome; assert.equal(failed, true);
  body.resolve({ ...version, projects: [], runBindings: [] }); await flush();
});

test('late fetch responses are cancelled without reading or changing the completed timeout outcome', { timeout: 2000 }, async () => {
  const headers = deferred(); let requests = 0, reads = 0, cancellations = 0;
  await assert.rejects(requestAcceptanceCatalog('', { timeoutMs: 20, fetcher: () => { requests++; return headers.promise; } }),
    problem => problem.code === 'REQUEST_TIMEOUT');
  headers.resolve({ json() { reads++; }, body: { cancel() { cancellations++; return never(); } } });
  await flush();
  assert.equal(requests, 1); assert.equal(reads, 0); assert.equal(cancellations, 1);
});

test('an incomplete POST error body never becomes a definite rejection from its status alone', { timeout: 2000 }, async () => {
  for (const status of [400, 409, 503]) {
    let requests = 0;
    await assert.rejects(requestAcceptanceCatalog('', { method: 'POST', body: {}, timeoutMs: 20, fetcher: () => {
      requests++; return { ok: false, status, json: never, body: { cancel: never } };
    } }), problem => problem.code === 'REQUEST_TIMEOUT' && problem.status === status && problem.writeMayHaveCommitted);
    assert.equal(requests, 1);
  }
});

test('pre-aborted callers send nothing and successful responses clear the shared deadline', async t => {
  let requests = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(requestAcceptanceCatalog('', { signal: controller.signal, fetcher: () => { requests++; } }),
    problem => problem.name === 'AbortError');
  await assert.rejects(requestAcceptanceCatalog('', { method: 'POST', signal: controller.signal, fetcher: () => { requests++; } }),
    problem => problem.code === 'REQUEST_ABORTED' && problem.writeMayHaveCommitted === false);
  assert.equal(requests, 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const value = await requestAcceptanceCatalog('', { timeoutMs: 25, fetcher: (_url, options) => {
    requests++; requestSignal = options.signal; return response({ ...version, projects: [], runBindings: [] });
  } });
  assert.equal(value.revision, version.revision);
  t.mock.timers.tick(1000); await flush();
  assert.equal(requestSignal.aborted, false); assert.equal(requests, 1);
});
