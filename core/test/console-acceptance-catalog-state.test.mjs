/** Actual component refs/watchers with real transport and controlled DTOs. No Browser/engine/network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as helpers from '../../console/src/acceptance-catalog.js';
import { validateBaselineWrite } from '../../console/src/acceptance-baseline.js';
import { validateBrowserBindingWrite } from '../../console/src/acceptance-browser-bindings.js';
import { createBrowserCandidateSubmission } from '../../console/src/acceptance-browser-candidates.js';

let vue;
try { vue = createRequire(new URL('../../console/package.json', import.meta.url))('vue'); } catch { /* Core-only installs omit Vue. */ }
const options = { skip: vue ? false : 'Console dependencies are required for the actual Vue state tests.', timeout: 3000 };
const clone = value => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const never = () => new Promise(() => {});
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }
async function waitFor(predicate) { const end = Date.now() + 1500; while (!predicate()) {
  assert(Date.now() < end, 'Actual Vue state did not reach the controlled checkpoint.'); await new Promise(resolve => setTimeout(resolve, 2));
} }
const script = fs.readFileSync(new URL('../../console/src/AcceptanceCatalog.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\r?$/gm, '');
const evaluate = new Function('vue', 'helpers', 'env', `
  const { computed, nextTick, reactive, ref, watch } = vue;
  const { defineProps, defineEmits, onBeforeUnmount, API, apiHeaders, validateBaselineWrite,
    validateBrowserBindingWrite, createBrowserCandidateSubmission } = env;
  const { AcceptanceCatalogError, buildCatalogBindingInput, buildCatalogProjectInput, buildCatalogReleaseInput,
    catalogFailure, catalogTargetUrl, catalogTerminalRuns, catalogVersion, createCatalogReadGuard, requestAcceptanceCatalog } = helpers;
  const STATUS_LABELS = {}, GATE_LABELS = {};
  ${script}
  return { selectedProject, draft, projectDraft, projects, version, detail, listLoading, detailLoading, writing, ready, notice, error,
    requiresReconcile, refreshCatalog, loadProject, mutate, writeBaseline, writeBrowserBinding, writeBrowserCandidate,
    waitForDetails: () => detailsPromise };
`);

function model(t, { transport = () => undefined, timeoutMs = 35 } = {}) {
  const store = { generationId: 'ag-state-fixture', revision: 1,
    projects: [{ id: 'ap-a', name: 'Project A' }, { id: 'ap-b', name: 'Project B' }],
    releases: { 'ap-a': [], 'ap-b': [] }, runBindings: [], events: [] };
  const version = () => ({ generationId: store.generationId, revision: store.revision });
  const listValue = () => ({ ...version(), projects: clone(store.projects), runBindings: clone(store.runBindings) });
  const detailValue = id => ({ ...version(), project: clone(store.projects.find(project => project.id === id)),
    releases: clone(store.releases[id]), runBindings: clone(store.runBindings.filter(binding => binding.projectId === id)), events: clone(store.events) });
  const calls = [], scope = vue.effectScope(); let dispose, disposed = false;
  const fetcher = async (url, requestOptions) => {
    const path = url.slice('/api/acceptance/projects'.length), call = { path, ...requestOptions };
    calls.push(call);
    const defaultResponse = () => {
      if (requestOptions.method === 'GET') return response(path ? detailValue(path.slice(1)) : listValue());
      const body = JSON.parse(requestOptions.body); store.revision++;
      if (!path) {
        const project = { id: 'ap-created', name: body.name }; store.projects.push(project); store.releases[project.id] = [];
        return response({ ...version(), project: clone(project) }, 201);
      }
      const projectId = path.split('/')[1];
      if (path.endsWith('/releases')) {
        const release = { id: 'ar-committed', projectId, label: body.label, targetUrl: body.targetUrl, ...(body.buildRef ? { buildRef: body.buildRef } : {}) };
        store.releases[projectId].push(release); return response({ ...version(), release: clone(release) }, 201);
      }
      assert.fail(`Unexpected offline write: ${path}`);
    };
    const custom = transport({ ...call, defaultResponse, listValue, detailValue });
    return custom === undefined ? defaultResponse() : custom;
  };
  const state = scope.run(() => evaluate(vue, { ...helpers,
    requestAcceptanceCatalog: (path, requestOptions) => helpers.requestAcceptanceCatalog(path, { ...requestOptions, timeoutMs, fetcher }) }, {
    defineProps: () => ({ runs: [] }), defineEmits: () => () => {}, onBeforeUnmount: callback => { dispose = callback; }, API: '', apiHeaders: () => ({}),
    validateBaselineWrite, validateBrowserBindingWrite, createBrowserCandidateSubmission }));
  const stop = () => { if (!disposed) { disposed = true; dispose(); scope.stop(); } };
  t.after(stop);
  return { ...state, store, calls, listValue, detailValue, stop, posts: () => calls.filter(call => call.method === 'POST') };
}
function releaseDraft(state, label = 'Acknowledged release') {
  Object.assign(state.draft.value.release, { label, targetUrl: 'https://example.test/', buildRef: 'commit-control' });
}

test('normal delayed release acknowledgement preserves a different current project and its unsubmitted draft', options, async t => {
  const delivery = deferred(); let acknowledged = false;
  const state = model(t, { transport(call) {
    if (call.method === 'POST') { const result = call.defaultResponse(); acknowledged = true; return delivery.promise.then(() => result); }
  } });
  await state.refreshCatalog(); releaseDraft(state, 'Delayed release from A');
  const pending = state.mutate('release'); await waitFor(() => acknowledged);
  state.selectedProject.value = 'ap-b'; await state.waitForDetails();
  releaseDraft(state, 'Unsubmitted B draft'); const draftB = clone(state.draft.value);
  delivery.resolve(); await pending;
  assert.equal(state.selectedProject.value, 'ap-b'); assert.deepEqual(clone(state.draft.value), draftB);
  assert.equal(state.store.releases['ap-a'].length, 1); assert.equal(state.store.releases['ap-b'].length, 0);
  assert.equal(state.posts().length, 1); assert.equal(state.ready.value, true); assert.equal(state.error.value, null);
  assert.match(state.notice.value, /Project A.*Delayed release from A/);
});

for (const stage of ['fetch', 'body']) for (const reader of ['list', 'detail']) {
  test(`acknowledged release keeps its confirmed fact when post-write ${reader} ${stage} stalls and cancellation never settles`, options, async t => {
    const delivery = deferred(); let stalled = false, acknowledged = false, cancellations = 0, readStarted = false;
    const state = model(t, { transport(call) {
      if (call.method === 'POST') { const result = call.defaultResponse(); acknowledged = true; return delivery.promise.then(() => result); }
      if (stalled && call.path === (reader === 'list' ? '' : '/ap-b')) {
        if (stage === 'fetch') { readStarted = true; return never(); }
        return { ok: true, status: 200, json() { readStarted = true; return never(); }, body: { cancel() { cancellations++; return never(); } } };
      }
    } });
    await state.refreshCatalog(); releaseDraft(state);
    const pending = state.mutate('release'); await waitFor(() => acknowledged);
    state.selectedProject.value = 'ap-b'; await state.waitForDetails(); releaseDraft(state, 'Preserved B draft');
    const draftB = clone(state.draft.value); stalled = true; delivery.resolve();
    await waitFor(() => readStarted);
    assert.equal(state.writing.value, 'release'); assert.equal(state.listLoading.value, true);
    assert.match(state.notice.value, /Project A.*Acknowledged release.*写入已确认/);
    await pending;
    assert.equal(state.writing.value, ''); assert.equal(state.listLoading.value, false); assert.equal(state.detailLoading.value, false);
    assert.equal(state.requiresReconcile.value, true); assert.equal(state.ready.value, false);
    assert.equal(state.error.value.code, 'REQUEST_TIMEOUT'); assert.equal(state.error.value.writeMayHaveCommitted, false);
    assert.match(state.notice.value, /Acknowledged release.*写入已确认.*刷新核对/);
    assert.equal(state.selectedProject.value, 'ap-b'); assert.deepEqual(clone(state.draft.value), draftB);
    assert.equal(state.posts().length, 1); assert.equal(state.store.releases['ap-a'].length, 1);
    if (stage === 'body') assert.equal(cancellations, 1);
    const beforeRecovery = state.calls.length; stalled = false;
    assert.equal(await state.refreshCatalog({ reconcile: true }), true);
    assert(state.calls.slice(beforeRecovery).every(call => call.method === 'GET'));
    assert.equal(state.posts().length, 1); assert.equal(state.requiresReconcile.value, false); assert.equal(state.error.value, null);
    assert.equal(state.ready.value, true); assert.equal(state.selectedProject.value, 'ap-b'); assert.deepEqual(clone(state.draft.value), draftB);
  });
}

for (const stage of ['fetch', 'body']) {
  test(`initial ${stage} timeout releases catalog busy state and only an explicit refresh reads again`, options, async t => {
    let stalled = true;
    const state = model(t, { transport(call) {
      if (stalled && !call.path) return stage === 'fetch' ? never()
        : { ok: true, status: 200, json: never, body: { cancel: never } };
    } });
    assert.equal(await state.refreshCatalog(), false);
    assert.equal(state.listLoading.value, false); assert.equal(state.writing.value, ''); assert.equal(state.ready.value, false);
    assert.equal(state.error.value.code, 'REQUEST_TIMEOUT'); assert.equal(state.calls.length, 1); assert.equal(state.posts().length, 0);
    await settle(); assert.equal(state.calls.length, 1);
    stalled = false; assert.equal(await state.refreshCatalog({ reconcile: true }), true);
    assert.equal(state.error.value, null); assert.equal(state.ready.value, true);
  });

  test(`unknown POST ${stage} preserves the draft, blocks new writes and permits only read recovery`, options, async t => {
    let lateBody, held = true;
    const headers = deferred();
    const state = model(t, { transport(call) {
      if (call.method === 'POST' && held) {
        lateBody = call.defaultResponse();
        return stage === 'fetch' ? headers.promise : { ok: true, status: 201, json: never, body: { cancel: never } };
      }
    } });
    await state.refreshCatalog(); releaseDraft(state, 'Outcome unknown draft'); const draft = clone(state.draft.value);
    await state.mutate('release');
    assert.equal(state.writing.value, ''); assert.equal(state.listLoading.value, false); assert.equal(state.requiresReconcile.value, true);
    assert.equal(state.error.value.code, 'REQUEST_TIMEOUT'); assert.equal(state.error.value.writeMayHaveCommitted, true);
    assert.equal(state.notice.value, ''); assert.deepEqual(clone(state.draft.value), draft); assert.equal(state.posts().length, 1);
    await state.mutate('release'); assert.equal(state.posts().length, 1);
    const beforeRecovery = state.calls.length; held = false;
    assert.equal(await state.refreshCatalog({ reconcile: true }), true);
    assert(state.calls.slice(beforeRecovery).every(call => call.method === 'GET'));
    assert.equal(state.detail.value.releases.length, 1); assert.equal(state.posts().length, 1);
    assert.deepEqual(clone(state.draft.value), draft); assert.equal(state.requiresReconcile.value, false);
    if (stage === 'fetch') { const notice = state.notice.value; headers.resolve(lateBody); await settle(); assert.equal(state.notice.value, notice); }
  });
}

for (const stage of ['fetch', 'body']) {
  test(`project A-B-A discards the first A ${stage} even when its abort is ignored`, options, async t => {
    const late = deferred(); let intercepted = false;
    const state = model(t, { transport(call) {
      if (call.path === '/ap-a' && !intercepted) {
        intercepted = true;
        return stage === 'fetch' ? late.promise : { ok: true, status: 200, json: () => late.promise, body: { cancel: never } };
      }
    } });
    const initial = state.refreshCatalog(); await waitFor(() => intercepted); await settle();
    const oldSignal = state.calls.find(call => call.path === '/ap-a').signal;
    state.selectedProject.value = 'ap-b'; await state.waitForDetails(); releaseDraft(state, 'B draft');
    state.selectedProject.value = 'ap-a'; await state.waitForDetails(); releaseDraft(state, 'A new draft');
    await initial;
    assert.equal(oldSignal.aborted, true); assert.equal(state.error.value, null);
    const stale = { ...state.detailValue('ap-a'), revision: 999, releases: [{ id: 'ar-stale', label: 'Stale A' }] };
    late.resolve(stage === 'fetch' ? response(stale) : stale); await settle();
    assert.equal(state.selectedProject.value, 'ap-a'); assert.equal(state.detail.value.project.id, 'ap-a');
    assert.equal(state.version.value.revision, 1); assert.equal(state.detail.value.releases.length, 0);
    assert.equal(state.draft.value.release.label, 'A new draft'); assert.equal(state.error.value, null);
    state.selectedProject.value = 'ap-b'; await state.waitForDetails(); assert.equal(state.draft.value.release.label, 'B draft');
    assert.equal(state.listLoading.value, false); assert.equal(state.detailLoading.value, false); assert.equal(state.posts().length, 0);
  });
}

test('project creation acknowledged after A-B-A does not hijack the returned A selection or a newer draft', options, async t => {
  const delivery = deferred(); let acknowledged = false;
  const state = model(t, { transport(call) {
    if (call.method === 'POST') { const result = call.defaultResponse(); acknowledged = true; return delivery.promise.then(() => result); }
  } });
  await state.refreshCatalog(); state.projectDraft.name = 'Created from A';
  const pending = state.mutate('project'); await waitFor(() => acknowledged);
  state.selectedProject.value = 'ap-b'; await state.waitForDetails();
  state.selectedProject.value = 'ap-a'; await state.waitForDetails(); state.projectDraft.name = 'Newer project draft';
  delivery.resolve(); await pending;
  assert.equal(state.selectedProject.value, 'ap-a'); assert.equal(state.projectDraft.name, 'Newer project draft');
  assert.equal(state.projects.value.filter(project => project.id === 'ap-created').length, 1); assert.equal(state.posts().length, 1);
  assert.match(state.notice.value, /Created from A.*已创建/); assert.equal(state.error.value, null); assert.equal(state.ready.value, true);
});

test('a superseded list response cannot overwrite the newer catalog even if the fetcher ignores abort', options, async t => {
  const late = deferred(); let intercepted = false;
  const state = model(t, { transport(call) { if (!call.path && !intercepted) { intercepted = true; return late.promise; } } });
  const old = state.refreshCatalog(); await waitFor(() => intercepted);
  assert.equal(await state.refreshCatalog({ reconcile: true }), true); assert.equal(await old, false);
  const notice = state.notice.value;
  late.resolve(response({ generationId: 'ag-stale', revision: 999, projects: [], runBindings: [] })); await settle();
  assert.equal(state.version.value.generationId, 'ag-state-fixture'); assert.equal(state.projects.value.length, 2);
  assert.equal(state.selectedProject.value, 'ap-a'); assert.equal(state.notice.value, notice); assert.equal(state.error.value, null);
});

for (const stage of ['fetch', 'body']) {
  test(`unmount settles an ignored ${stage} abort and suppresses late component writes`, options, async t => {
    const late = deferred();
    const state = model(t, { transport(call) { if (!call.path) return stage === 'fetch' ? late.promise
      : { ok: true, status: 200, json: () => late.promise, body: { cancel: never } }; } });
    const pending = state.refreshCatalog(); await settle(); state.stop();
    assert.equal(await pending, false);
    late.resolve(stage === 'fetch' ? response(state.listValue()) : state.listValue()); await settle();
    assert.equal(state.version.value, null); assert.equal(state.detail.value, null); assert.equal(state.error.value, null); assert.equal(state.notice.value, '');
  });
}

test('unmount during an acknowledged write refresh does not replace its last confirmed notice', options, async t => {
  let stalled = false, refreshing = false;
  const state = model(t, { transport(call) {
    if (call.method === 'POST') { stalled = true; return call.defaultResponse(); }
    if (stalled && !call.path) { refreshing = true; return never(); }
  } });
  await state.refreshCatalog(); releaseDraft(state);
  const pending = state.mutate('release'); await waitFor(() => refreshing);
  assert.match(state.notice.value, /Acknowledged release.*写入已确认/);
  const notice = state.notice.value; state.stop(); await pending;
  assert.equal(state.notice.value, notice); assert.equal(state.requiresReconcile.value, false); assert.equal(state.error.value, null);
  assert.equal(state.posts().length, 1);
});
