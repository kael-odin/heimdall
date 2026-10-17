/** Actual Vue refs/watchers and the component's saved script, without DOM, Browser or engine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID, webcrypto } from 'node:crypto';
import * as helpers from '../../console/src/acceptance-browser-execution.js';

let vue;
try { vue = createRequire(new URL('../../console/package.json', import.meta.url))('vue'); } catch { /* Core-only installs do not contain the console runtime. */ }
const options = { skip: vue ? false : 'Install console dependencies to run the actual Vue state tests.' };
const { vectors: [vector] } = JSON.parse(fs.readFileSync(new URL('./fixtures/acceptance-browser-start-resolution-vectors.json', import.meta.url), 'utf8'));
const origin = 'http://127.0.0.1:3000', at = '2026-10-17T13:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const keyFor = projectId => `heimdall:browser-operations:v1:${origin}:${projectId}`;
function serialLocks() {
  const tails = new Map(), log = [];
  return { log, request(name, settings, callback) {
    assert.deepEqual(settings, { mode: 'exclusive' }); log.push(name);
    const next = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
    tails.set(name, next.catch(() => {})); return next;
  } };
}
function memoryStorage(values = []) {
  const records = new Map(values.length ? [[keyFor(vector.projectId), JSON.stringify(values)]] : []);
  return { records, getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); } };
}
const capability = { enabled: true, ready: true, recoveryReady: true, busy: false, closing: false, blocked: false,
  code: null, kind: null, runId: null, taskId: null, approvalScope: 'single-operation', baselineNetworkRequests: false };
const response = value => new Response(JSON.stringify(value));
const operation = request => ({ schemaVersion: 1, operationId: request.operationId, runId: 'br-' + randomUUID(), taskId: 'a-' + randomUUID(),
  projectId: vector.projectId, candidateId: request.candidateId, contentDigest: request.contentDigest, targetReleaseId: request.targetReleaseId,
  targetLabel: 'Original target', approvalScope: 'single-operation', state: 'prepared', acceptedAt: at, updatedAt: at,
  gate: null, reportSha256: null, reasonCode: null, summary: null, executionReady: false });
function resolution(url) {
  const [, projectId, operationId] = /\/projects\/(ap-[^/]+)\/browser-executions\/(bo-[^/]+)\/resolution$/.exec(url);
  return { schemaVersion: 1, kind: 'browser-start-resolution', projectId, operationId, observedAt: at,
    outcome: 'unresolved', reasonCode: 'ABSENT_OBSERVED' };
}
const rejected = () => ({ schemaVersion: 1, kind: 'browser-start-resolution', projectId: vector.projectId,
  operationId: vector.request.operationId, observedAt: at, outcome: 'rejected', rejection: clone(vector.rejection), rejectionSha256: vector.rejectionSha256 });
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('State did not settle before the offline deadline.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }

const script = fs.readFileSync(new URL('../../console/src/AcceptanceBrowserExecution.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\r?$/gm, '');
const evaluate = new Function('vue', 'helpers', 'environment', `
  const { computed, ref, watch } = vue;
  const { onBeforeUnmount, defineProps, API, apiHeaders, location, window, localStorage, crypto } = environment;
  const { browserOperationView, browserOperationCollection, browserOperationReport, browserExecutionLedger,
    browserStartResolution, browserExecutionRegistration, createBrowserExecutionReadGuard,
    createBrowserExecutionReceipts, fetchBrowserExecutionEvidence, requestBrowserExecution } = helpers;
  const browserCandidateReviewState = () => { throw new Error('This offline state test does not fabricate a candidate read.'); };
  ${script}
  return { start, denyStart, load, canStart, pending, error, notice, writing, candidateId, targetReleaseId,
    confirmed, review, denyConfirmed, operations, receiptReadable, receiptWritable };
`);
function model(t, { storage = memoryStorage(), locks = serialLocks(), transport = () => null } = {}) {
  const props = vue.reactive({ projectId: vector.projectId, active: true, ready: true,
    version: { generationId: vector.request.expectedGenerationId, revision: vector.request.expectedRevision },
    detail: { browserCandidates: [{ id: vector.request.candidateId }],
      releases: [{ id: vector.request.targetReleaseId, label: 'Original target', targetUrl: 'http://target.test/' }] } });
  const calls = [], scope = vue.effectScope(); let dispose;
  const fetcher = async (url, requestOptions) => {
    calls.push({ url, ...requestOptions }); const result = transport(url, requestOptions);
    if (result !== null && result !== undefined) return result;
    if (url.endsWith('/resolution')) return response(resolution(url));
    if (requestOptions.method === 'GET' && url.endsWith('/browser-executions')) {
      const projectId = /\/projects\/(ap-[^/]+)/.exec(url)[1];
      return response({ schemaVersion: 1, projectId, operations: [], capability });
    }
    assert.fail(`Unexpected offline transport: ${requestOptions.method} ${url}`);
  };
  const adapted = { ...helpers,
    createBrowserExecutionReceipts: value => helpers.createBrowserExecutionReceipts({ ...value, locks }),
    browserStartResolution: (raw, value) => helpers.browserStartResolution(raw, { ...value, crypto: webcrypto }),
    requestBrowserExecution: (path, value) => helpers.requestBrowserExecution(path, { ...value, timeoutMs: 20, fetcher }) };
  const state = scope.run(() => evaluate(vue, adapted, { defineProps: () => props, onBeforeUnmount: callback => { dispose = callback; },
    API: '', apiHeaders: () => ({}), location: { origin, href: origin + '/' },
    window: { addEventListener() {}, removeEventListener() {} }, localStorage: storage, crypto: { subtle: webcrypto.subtle, randomUUID } }));
  t.after(() => { dispose(); scope.stop(); }); return { ...state, props, calls, storage, locks };
}
async function prepare(state) {
  state.candidateId.value = vector.request.candidateId; state.targetReleaseId.value = vector.request.targetReleaseId;
  await settle();
  state.review.value = { candidate: { id: vector.request.candidateId, contentDigest: vector.request.contentDigest }, review: {},
    generationId: vector.request.expectedGenerationId, revision: vector.request.expectedRevision,
    diagnostics: { contentMatches: true }, presentation: { completeSourceProjection: true } };
  state.confirmed.value = true;
}

test('a listed same-ID operation cannot clear an unresolved original receipt or permit another start', options, async t => {
  const stored = operation(vector.request), storage = memoryStorage([vector.request]);
  const state = model(t, { storage, transport: (url, requestOptions) => requestOptions.method === 'GET' && url.endsWith('/browser-executions')
    ? response({ schemaVersion: 1, projectId: vector.projectId, operations: [stored], capability }) : null });
  await waitFor(() => state.operations.value.length === 1); await prepare(state);
  assert.deepEqual(state.pending.value, [vector.request]); assert.equal(state.canStart.value, false);
  assert.ok(state.calls.some(value => value.url.endsWith('/resolution'))); assert.ok(state.calls.every(value => value.method === 'GET'));
});

test('successful old operation views and ordinary 4xx both retain receipts until dedicated full proof', options, async t => {
  for (const status of [202, 409]) {
    const state = model(t, { transport: (url, requestOptions) => requestOptions.method === 'POST' && url.endsWith('/browser-executions')
      ? new Response(JSON.stringify(status === 202 ? operation(JSON.parse(requestOptions.body)) : { error: 'Stale version', code: 'STALE_CATALOG' }), { status }) : null });
    await prepare(state); assert.equal(state.canStart.value, true); await state.start();
    assert.equal(state.pending.value.length, 1); assert.equal(state.canStart.value, false);
    assert.equal(state.calls.filter(value => value.method === 'POST').length, 1);
    assert.equal(state.calls.filter(value => value.url.endsWith('/deny-start')).length, 0);
  }
});

test('two reviewed Vue pages starting together send one POST and retain exactly one shared confirmation', options, async t => {
  const storage = memoryStorage(), locks = serialLocks(), entered = deferred(), release = deferred();
  const blocker = locks.request(keyFor(vector.projectId), { mode: 'exclusive' }, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const transport = (_url, requestOptions) => requestOptions.method === 'POST'
    ? new Response(JSON.stringify({ error: 'Controlled unknown start.' }), { status: 503 }) : null;
  const first = model(t, { storage, locks, transport }), second = model(t, { storage, locks, transport });
  await prepare(first); await prepare(second);
  assert.equal(first.canStart.value, true); assert.equal(second.canStart.value, true);
  const pa = first.start(), pb = second.start();
  assert.equal(first.writing.value, true); assert.equal(second.writing.value, true);
  assert.equal(storage.records.size, 0); release.resolve(); await Promise.all([blocker, pa, pb]); await settle();
  const posts = [...first.calls, ...second.calls].filter(value => value.method === 'POST');
  assert.equal(posts.length, 1); const original = JSON.parse(posts[0].body);
  assert.deepEqual(JSON.parse(storage.records.get(keyFor(vector.projectId))), [original]);
  for (const state of [first, second]) {
    assert.deepEqual(state.pending.value, [original]); assert.equal(state.receiptReadable.value, true);
    assert.equal(state.canStart.value, false); assert.equal(state.review.value, null); assert.equal(state.confirmed.value, false);
    assert.equal(state.writing.value, false);
  }
  assert.equal(second.calls.filter(value => value.method === 'POST').length, 0);
  assert.equal(second.error.value, ''); assert.match(second.notice.value, /待核对启动确认/);
});

test('a receipt appearing while a Vue start waits is loaded without a POST or storage fault', options, async t => {
  const storage = memoryStorage(), locks = serialLocks(), entered = deferred(), release = deferred();
  const blocker = locks.request(keyFor(vector.projectId), { mode: 'exclusive' }, async () => { entered.resolve(); await release.promise; });
  await entered.promise; const state = model(t, { storage, locks }); await prepare(state);
  const other = helpers.createBrowserExecutionReceipts({ projectId: vector.projectId, origin, storage, locks });
  const saved = other.save(vector.request), started = state.start();
  assert.equal(state.writing.value, true); assert.equal(storage.records.size, 0);
  release.resolve(); await Promise.all([blocker, saved, started]); await settle();
  assert.deepEqual(JSON.parse(storage.records.get(keyFor(vector.projectId))), [vector.request]);
  assert.deepEqual(state.pending.value, [vector.request]); assert.equal(state.receiptReadable.value, true);
  assert.equal(state.error.value, ''); assert.match(state.notice.value, /待核对启动确认/);
  assert.equal(state.canStart.value, false); assert.equal(state.review.value, null); assert.equal(state.confirmed.value, false);
  assert.equal(state.calls.filter(value => value.method === 'POST').length, 0);
});

test('a start claim waits for its real serialized lock and a project switch prevents the captured old start from reaching transport', options, async t => {
  const storage = memoryStorage(), locks = serialLocks(), entered = deferred(), release = deferred();
  const blocker = locks.request(keyFor(vector.projectId), { mode: 'exclusive' }, async () => { entered.resolve(); await release.promise; });
  await entered.promise; const state = model(t, { storage, locks }); await prepare(state);
  const pending = state.start(); assert.equal(state.writing.value, true);
  const foreignProject = 'ap-' + randomUUID(); state.props.projectId = foreignProject;
  release.resolve(); await blocker; await pending; await settle();
  assert.equal(state.calls.filter(value => value.method === 'POST').length, 0);
  assert.equal(JSON.parse(storage.records.get(keyFor(vector.projectId))).length, 1);
  assert.equal(storage.records.has(keyFor(foreignProject)), false); assert.deepEqual(state.pending.value, []);
  assert.equal(state.notice.value, ''); assert.equal(state.error.value, ''); assert.equal(state.writing.value, false);
});

test('denial timeout sends one POST, then only GET recovers the exact receipt without auto-starting', options, async t => {
  let decision = false;
  const state = model(t, { storage: memoryStorage([vector.request]), transport: (url, requestOptions) => {
    if (url.endsWith('/deny-start')) return new Promise(() => {});
    if (decision && url.endsWith('/resolution')) return response(rejected());
    return null;
  } });
  await settle(); state.denyConfirmed.value = [vector.request.operationId]; await state.denyStart(state.pending.value[0]);
  assert.equal(state.pending.value.length, 1); assert.equal(state.writing.value, false);
  await state.denyStart(state.pending.value[0]); assert.equal(state.calls.filter(value => value.method === 'POST').length, 1);
  decision = true; await state.load(); assert.deepEqual(state.pending.value, []);
  assert.match(state.notice.value, /永久拒绝/); assert.equal(state.calls.filter(value => value.method === 'POST').length, 1);
  assert.equal(state.calls.filter(value => value.url.endsWith('/browser-executions') && value.method === 'POST').length, 0);
});

test('no lock support and unreadable storage keep a valid reviewed start disabled', options, async t => {
  const readonly = model(t, { locks: null }); await prepare(readonly);
  assert.equal(readonly.receiptReadable.value, true); assert.equal(readonly.receiptWritable.value, false); assert.equal(readonly.canStart.value, false);
  const storage = memoryStorage(); storage.getItem = () => { throw new Error('Storage denied.'); };
  const broken = model(t, { storage }); await prepare(broken);
  assert.equal(broken.receiptReadable.value, false); assert.equal(broken.canStart.value, false);
  assert.equal(broken.calls.filter(value => value.method === 'POST').length, 0);
});

test('a late proof waiting for a lock cannot erase changed same-ID confirmation or refill an ABA project view', options, async t => {
  const storage = memoryStorage([vector.request]), locks = serialLocks(), entered = deferred(), release = deferred();
  const blocker = locks.request(keyFor(vector.projectId), { mode: 'exclusive' }, async () => { entered.resolve(); await release.promise; });
  await entered.promise; let resolutions = 0;
  const state = model(t, { storage, locks, transport: url => url.endsWith('/resolution') && ++resolutions === 1 ? response(rejected()) : null });
  await waitFor(() => locks.log.length >= 2);
  state.props.projectId = 'ap-' + randomUUID();
  const changed = { ...vector.request, expectedRevision: vector.request.expectedRevision + 1 };
  storage.records.set(keyFor(vector.projectId), JSON.stringify([changed])); state.props.projectId = vector.projectId;
  release.resolve(); await blocker; await settle();
  assert.deepEqual(JSON.parse(storage.records.get(keyFor(vector.projectId))), [changed]);
  assert.deepEqual(state.pending.value, [changed]); assert.equal(state.notice.value, ''); assert.equal(state.error.value, '');
  assert.equal(state.calls.filter(value => value.method === 'POST').length, 0);
});

test('failed full-collection readback stays blocked even when faulty storage later looks empty', options, async t => {
  const other = { ...vector.request, operationId: 'bo-' + randomUUID() }, storage = memoryStorage([vector.request, other]);
  let decision = false;
  const state = model(t, { storage, transport: url => decision && url.endsWith(`/${vector.request.operationId}/resolution`) ? response(rejected()) : null });
  await settle(); storage.setItem = (key, _value) => { storage.records.set(key, '[]'); }; decision = true;
  await state.load(); assert.equal(state.receiptReadable.value, false); assert.deepEqual(state.pending.value, [vector.request, other]);
  await state.load(); await prepare(state);
  assert.equal(state.receiptReadable.value, false); assert.equal(state.canStart.value, false); assert.deepEqual(state.pending.value, [vector.request, other]);
  assert.doesNotMatch(state.notice.value, /已解除/); assert.match(state.error.value, /完整回读失败/);
  assert.equal(state.calls.filter(value => value.method === 'POST').length, 0);
});

test('a failed start-claim readback never sends a start and cannot be cleared by a later empty read', options, async t => {
  for (const fault of ['empty', 'changed-field']) {
    const storage = memoryStorage(), state = model(t, { storage }); await prepare(state);
    storage.setItem = (key, value) => {
      const values = JSON.parse(value); values[0].expectedRevision++;
      storage.records.set(key, fault === 'empty' ? '[]' : JSON.stringify(values));
    };
    await state.start(); assert.equal(state.receiptReadable.value, false);
    storage.records.set(keyFor(vector.projectId), '[]'); await state.load(); await prepare(state);
    assert.equal(state.receiptReadable.value, false); assert.equal(state.canStart.value, false);
    assert.match(state.error.value, /完整回读失败/);
    assert.equal(state.calls.filter(value => value.method === 'POST').length, 0); assert.doesNotMatch(state.notice.value, /已解除/);
  }
});

test('a read-only browser verifies a complete proof without attempting receipt resolution or latching a write fault', options, async t => {
  const storage = memoryStorage([vector.request]), state = model(t, { storage, locks: null,
    transport: url => url.endsWith('/resolution') ? response(rejected()) : null });
  await settle(); await state.load();
  assert.deepEqual(state.pending.value, [vector.request]); assert.equal(state.receiptReadable.value, true);
  assert.equal(state.receiptWritable.value, false); assert.equal(state.canStart.value, false);
  assert.equal(state.error.value, ''); assert.equal(state.notice.value, '');
  assert.deepEqual(JSON.parse(storage.records.get(keyFor(vector.projectId))), [vector.request]);
  assert.equal(state.calls.filter(value => value.method === 'POST').length, 0);
});
