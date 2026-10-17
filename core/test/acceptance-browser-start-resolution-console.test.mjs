/** Independent fixed proof vectors and serialized cross-client receipt writes; no Browser/Core server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { browserStartResolution, createBrowserExecutionReceipts, requestBrowserExecution } from '../../console/src/acceptance-browser-execution.js';

const { vectors } = JSON.parse(fs.readFileSync(new URL('./fixtures/acceptance-browser-start-resolution-vectors.json', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = error => error?.code === 'INVALID_RESPONSE';
const origin = 'http://127.0.0.1:3000', at = '2026-10-17T13:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rejected = vector => ({ schemaVersion: 1, kind: 'browser-start-resolution', projectId: vector.projectId,
  operationId: vector.request.operationId, observedAt: at, outcome: 'rejected',
  rejection: clone(vector.rejection), rejectionSha256: vector.rejectionSha256 });
const recorded = vector => ({ schemaVersion: 1, kind: 'browser-start-resolution', projectId: vector.projectId,
  operationId: vector.request.operationId, observedAt: at, outcome: 'recorded', request: clone(vector.request),
  requestFingerprint: vector.requestFingerprint, dispatchSha256: 'a'.repeat(64), operation: {
    schemaVersion: 1, operationId: vector.request.operationId, runId: 'br-' + randomUUID(), taskId: 'a-' + randomUUID(),
    projectId: vector.projectId, candidateId: vector.request.candidateId, contentDigest: vector.request.contentDigest,
    targetReleaseId: vector.request.targetReleaseId, targetLabel: 'Original target', approvalScope: 'single-operation',
    state: 'prepared', acceptedAt: at, updatedAt: at, gate: null, reportSha256: null, reasonCode: null,
    summary: null, executionReady: false,
  } });
const unresolved = vector => ({ schemaVersion: 1, kind: 'browser-start-resolution', projectId: vector.projectId,
  operationId: vector.request.operationId, observedAt: at, outcome: 'unresolved', reasonCode: 'ABSENT_OBSERVED' });
function memoryStorage() {
  const values = new Map(); let writes = 0;
  return { values, get writes() { return writes; }, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes++; values.set(key, value); } };
}
function serialLocks() {
  const tails = new Map(), log = [], active = new Map();
  return { log, active, request(name, options, callback) {
    assert.deepEqual(options, { mode: 'exclusive' }); log.push({ event: 'requested', name });
    const pending = (tails.get(name) ?? Promise.resolve()).then(async () => {
      assert.equal(active.get(name) ?? 0, 0); active.set(name, 1); log.push({ event: 'entered', name });
      try { return await callback({ name, mode: 'exclusive' }); }
      finally { active.set(name, 0); log.push({ event: 'released', name }); }
    });
    tails.set(name, pending.catch(() => {})); return pending;
  } };
}
async function hold(locks, key) {
  const entered = deferred(), release = deferred();
  const finished = locks.request(key, { mode: 'exclusive' }, async () => { entered.resolve(); await release.promise; });
  await entered.promise; return { release: () => release.resolve(), finished };
}

test('all fixed revision vectors verify domain fingerprints and canonical rejection bytes including LF', async () => {
  for (const vector of vectors) {
    const options = { projectId: vector.projectId, request: vector.request, crypto: webcrypto };
    assert.equal((await browserStartResolution(rejected(vector), options)).rejectionSha256, vector.rejectionSha256);
    assert.equal((await browserStartResolution(recorded(vector), options)).requestFingerprint, vector.requestFingerprint);
    const reordered = rejected(vector);
    reordered.rejection = Object.fromEntries(Object.entries(reordered.rejection).reverse());
    reordered.rejection.request = Object.fromEntries(Object.entries(reordered.rejection.request).reverse());
    assert.equal((await browserStartResolution(reordered, options)).outcome, 'rejected');
    for (const bytes of [vector.canonicalRejection.trimEnd(), JSON.stringify(vector.rejection) + '\n', vector.canonicalRejection + '\n']) {
      const wrong = { ...rejected(vector), rejectionSha256: createHash('sha256').update(bytes).digest('hex') };
      await assert.rejects(browserStartResolution(wrong, options), invalid);
    }
  }
});

test('recorded and rejected proofs bind every original field and project without trusting the old four-field view', async () => {
  const vector = vectors[1];
  const changes = { operationId: 'bo-' + randomUUID(), expectedGenerationId: 'ag-' + randomUUID(), expectedRevision: 13,
    candidateId: 'bc-' + randomUUID(), contentDigest: 'b'.repeat(64), targetReleaseId: 'ar-' + randomUUID() };
  for (const make of [recorded, rejected]) {
    for (const [key, value] of Object.entries(changes)) {
      await assert.rejects(browserStartResolution(make(vector), { projectId: vector.projectId,
        request: { ...vector.request, [key]: value }, crypto: webcrypto }), invalid, key);
      const forged = make(vector), nested = forged.outcome === 'recorded' ? forged.request : forged.rejection.request;
      nested[key] = value;
      await assert.rejects(browserStartResolution(forged, { projectId: vector.projectId, request: vector.request, crypto: webcrypto }), invalid, key);
    }
    await assert.rejects(browserStartResolution(make(vector), { projectId: 'ap-' + randomUUID(), request: vector.request, crypto: webcrypto }), invalid);
  }
});

test('strict resolution unions reject extras, crossed variants, invalid timestamps and forged immutable facts', async () => {
  const vector = vectors[0], options = { projectId: vector.projectId, request: vector.request, crypto: webcrypto };
  const changes = [value => { value.schemaVersion = 2; }, value => { value.kind = 'other'; },
    value => { value.observedAt = '2026-10-17T13:00:00Z'; }, value => { value.safeToForget = true; },
    value => { value.request = vector.request; }, value => { value.requestFingerprint = vector.requestFingerprint; },
    value => { value.operation = recorded(vector).operation; }, value => { value.rejectionSha256 = 'b'.repeat(64); },
    value => { value.rejection.requestFingerprint = 'b'.repeat(64); }, value => { value.rejection.reasonCode = 'EXPIRED'; },
    value => { value.rejection.effect = 'allow-retry'; }, value => { value.rejection.actor.kind = 'timer'; },
    value => { value.rejection.actor.secret = true; }, value => { value.rejection.rejectedAt = 'bad'; },
    value => { value.rejection.projectId = 'ap-' + randomUUID(); }, value => { value.rejection.operationId = 'bo-' + randomUUID(); },
    value => { delete value.rejection.request.expectedRevision; }, value => { value.rejection.ttl = 1; },
    value => { delete value.rejection; }, value => { value.outcome = 'absent'; }];
  for (const change of changes) { const raw = rejected(vector); change(raw); await assert.rejects(browserStartResolution(raw, options), invalid); }
  for (const change of [value => { value.requestFingerprint = 'b'.repeat(64); }, value => { value.dispatchSha256 = 'x'; },
    value => { value.operation.report = {}; }, value => { value.operation.candidateId = 'bc-' + randomUUID(); },
    value => { value.operation.projectId = 'ap-' + randomUUID(); }, value => { value.operation.executionReady = true; },
    value => { value.rejection = rejected(vector).rejection; }]) {
    const raw = recorded(vector); change(raw); await assert.rejects(browserStartResolution(raw, options), invalid);
  }
  let invoked = false; const accessor = rejected(vector);
  Object.defineProperty(accessor.rejection, 'actor', { enumerable: true, get() { invoked = true; return { kind: 'local-user' }; } });
  await assert.rejects(browserStartResolution(accessor, options), invalid); assert.equal(invoked, false);
  await assert.rejects(browserStartResolution(rejected(vector), { ...options, crypto: {} }), invalid);
});

test('unresolved is a strict observation and never grants a decision proof', async () => {
  const vector = vectors[0], options = { projectId: vector.projectId, request: vector.request, crypto: {} };
  for (const reasonCode of ['ABSENT_OBSERVED', 'ADMISSION_PENDING']) {
    assert.equal((await browserStartResolution({ ...unresolved(vector), reasonCode }, options)).outcome, 'unresolved');
  }
  for (const extra of [{ safeToForget: true }, { request: vector.request }, { reasonCode: 'EXPIRED' }, { rejectionSha256: 'a'.repeat(64) }]) {
    await assert.rejects(browserStartResolution({ ...unresolved(vector), ...extra }, options), invalid);
  }
});

test('asynchronous digest verification retains an inert original request and proof snapshot', async () => {
  const vector = vectors[0], raw = rejected(vector), original = clone(vector.request), entered = deferred(), release = deferred();
  let calls = 0;
  const crypto = { subtle: { digest: async (algorithm, bytes) => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    return webcrypto.subtle.digest(algorithm, bytes);
  } } };
  const pending = browserStartResolution(raw, { projectId: vector.projectId, request: original, crypto });
  await entered.promise; raw.rejection.request.expectedRevision = 123; original.expectedRevision = 456; release.resolve();
  const proof = await pending; assert.deepEqual(proof.rejection.request, vector.request); assert.notEqual(proof, raw);
});

test('no Web Locks means read-only diagnostics with no write fallback or bare-ID resolution', async () => {
  const vector = vectors[0], storage = memoryStorage(), key = `heimdall:browser-operations:v1:${origin}:${vector.projectId}`;
  storage.values.set(key, JSON.stringify([vector.request]));
  const client = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks: null });
  assert.equal(client.canWrite, false); assert.equal(client.resolve, undefined); assert.deepEqual(client.read(), [vector.request]);
  await assert.rejects(client.claimForStart(vector.request), invalid);
  await assert.rejects(client.save(vector.request), invalid); await assert.rejects(client.resolveExact(vector.request), invalid);
  assert.equal(storage.writes, 0); assert.deepEqual(client.read(), [vector.request]);
});

test('two clients queue saves behind the same origin/project lock and preserve both original confirmations', async () => {
  const vector = vectors[0], storage = memoryStorage(), locks = serialLocks(), key = `heimdall:browser-operations:v1:${origin}:${vector.projectId}`;
  const a = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const b = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const first = clone(vector.request), second = { ...first, operationId: 'bo-' + randomUUID() }, block = await hold(locks, key);
  const pa = a.save(first), pb = b.save(second); assert.equal(storage.writes, 0); assert.deepEqual(a.read(), []);
  block.release(); await Promise.all([block.finished, pa, pb]);
  assert.equal(a.canWrite, true); assert.deepEqual(a.read(), [first, second]); assert.deepEqual(b.read(), [first, second]);
  assert.equal(locks.log.filter(value => value.event === 'entered').length, 3);
  assert.ok(locks.log.every(value => value.name === key));
});

test('two start claims queue behind one lock and only the first saves a confirmation', async () => {
  const vector = vectors[0], storage = memoryStorage(), locks = serialLocks(), key = `heimdall:browser-operations:v1:${origin}:${vector.projectId}`;
  const a = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const b = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const first = clone(vector.request), second = { ...first, operationId: 'bo-' + randomUUID() }, block = await hold(locks, key);
  const pa = a.claimForStart(first), pb = b.claimForStart(second);
  assert.equal(storage.writes, 0); assert.deepEqual(a.read(), []);
  block.release(); const results = await Promise.all([pa, pb]); await block.finished;
  assert.deepEqual(results, [true, false]); assert.equal(storage.writes, 1);
  assert.deepEqual(a.read(), [first]); assert.deepEqual(b.read(), [first]);
});

test('a receipt saved while a start claim waits rejects the claim without another write', async () => {
  const vector = vectors[0], storage = memoryStorage(), locks = serialLocks(), key = `heimdall:browser-operations:v1:${origin}:${vector.projectId}`;
  const a = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const b = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const next = { ...vector.request, operationId: 'bo-' + randomUUID() }, block = await hold(locks, key);
  const saved = a.save(vector.request), claimed = b.claimForStart(next);
  assert.equal(storage.writes, 0); block.release(); await saved;
  assert.equal(await claimed, false); await block.finished;
  assert.equal(storage.writes, 1); assert.deepEqual(b.read(), [vector.request]);
});

test('a start claim rejects a changed full-collection readback even when the operation ID is unchanged', async () => {
  const vector = vectors[0], storage = memoryStorage(), locks = serialLocks();
  storage.setItem = (key, value) => {
    const values = JSON.parse(value); values[0].expectedRevision++;
    storage.values.set(key, JSON.stringify(values));
  };
  const client = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  await assert.rejects(client.claimForStart(vector.request), error => invalid(error) && /完整保存/.test(error.message));
  assert.deepEqual(client.read(), [{ ...vector.request, expectedRevision: vector.request.expectedRevision + 1 }]);
});

test('save versus exact resolution and two resolutions serialize without losing unrelated receipts', async () => {
  const vector = vectors[0], storage = memoryStorage(), locks = serialLocks(), key = `heimdall:browser-operations:v1:${origin}:${vector.projectId}`;
  const a = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const b = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const first = clone(vector.request), second = { ...first, operationId: 'bo-' + randomUUID() };
  await a.save(first); let block = await hold(locks, key);
  const saved = b.save(second), resolved = a.resolveExact(first); assert.deepEqual(a.read(), [first]);
  block.release(); await Promise.all([block.finished, saved, resolved]); assert.deepEqual(a.read(), [second]);
  await a.save(first); block = await hold(locks, key);
  const ra = a.resolveExact(first), rb = b.resolveExact(first), writes = storage.writes;
  block.release(); await Promise.all([block.finished, ra, rb]);
  assert.deepEqual(a.read(), [second]); assert.equal(storage.writes, writes + 1, 'The second exact absence is idempotent without writing.');
});

test('a proof cannot delete changed same-ID fields after waiting for a lock, and clean absence cannot hide corruption', async () => {
  const vector = vectors[0], storage = memoryStorage(), locks = serialLocks(), key = `heimdall:browser-operations:v1:${origin}:${vector.projectId}`;
  const client = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  await client.save(vector.request); const block = await hold(locks, key);
  const pending = client.resolveExact(vector.request), changed = { ...vector.request, expectedGenerationId: 'ag-' + randomUUID() };
  storage.values.set(key, JSON.stringify([changed])); block.release();
  await assert.rejects(pending, invalid); await block.finished; assert.deepEqual(client.read(), [changed]);
  storage.values.set(key, '{broken'); await assert.rejects(client.resolveExact(vector.request), invalid);
  assert.equal(storage.values.get(key), '{broken');
  storage.values.set(key, JSON.stringify([{ ...vector.request, operationId: 'bo-' + randomUUID(), expectedRevision: -1 }]));
  await assert.rejects(client.resolveExact(vector.request), invalid);
});

test('resolution GET and explicit denial POST have exact methods, no-store transport and no implicit retries', async () => {
  const vector = vectors[0], path = `/${vector.projectId}/browser-executions/${vector.request.operationId}`, calls = [];
  const fetcher = async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify(rejected(vector)), { status: 200 }); };
  await requestBrowserExecution(`${path}/resolution`, { fetcher });
  await requestBrowserExecution(`${path}/deny-start`, { method: 'POST', body: { action: 'deny-future-starts-for-operation', request: vector.request }, fetcher });
  assert.equal(calls.length, 2); assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].method, 'POST'); assert.deepEqual(JSON.parse(calls[1].body).request, vector.request);
  assert.ok(calls.every(value => value.cache === 'no-store'));
  await assert.rejects(requestBrowserExecution(`${path}/resolution`, { method: 'POST', fetcher }), invalid);
  await assert.rejects(requestBrowserExecution(`${path}/deny-start`, { fetcher }), invalid); assert.equal(calls.length, 2);
});

test('explicit denial fetch and body hangs each reach one independent deadline, retain receipts and recover using GET only', async () => {
  const vector = vectors[0], path = `/${vector.projectId}/browser-executions/${vector.request.operationId}`;
  for (const phase of ['fetch', 'body']) {
    const storage = memoryStorage(), locks = serialLocks(), client = createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
    await client.save(vector.request); let posts = 0, gets = 0, signal;
    await assert.rejects(requestBrowserExecution(`${path}/deny-start`, { method: 'POST', timeoutMs: 15,
      body: { action: 'deny-future-starts-for-operation', request: vector.request }, fetcher: async (_url, options) => {
        posts++; signal = options.signal;
        if (phase === 'fetch') return new Promise(() => {});
        return { ok: true, status: 200, json: async () => new Promise(() => {}) };
      } }), error => error.code === 'BROWSER_REQUEST_TIMEOUT' && error.outcomeUnknown === true);
    assert.equal(posts, 1); assert.equal(signal.aborted, true); assert.deepEqual(client.read(), [vector.request]);
    const raw = await requestBrowserExecution(`${path}/resolution`, { fetcher: async (_url, options) => {
      gets++; assert.equal(options.method, 'GET'); return new Response(JSON.stringify(rejected(vector)));
    } });
    await browserStartResolution(raw, { projectId: vector.projectId, request: vector.request, crypto: webcrypto });
    await client.resolveExact(vector.request); assert.deepEqual(client.read(), []); assert.equal(posts, 1); assert.equal(gets, 1);
  }
});
