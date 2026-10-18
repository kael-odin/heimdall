/** Frozen real Vue script/refs/watchers; deterministic DTOs, no Browser/engine/network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as helpers from './acceptance-catalog.before.js';
import { createBrowserCandidateSubmission } from '../../../../console/src/acceptance-browser-candidates.js';
const vue = createRequire(new URL('../../../../console/package.json', import.meta.url))('vue');
const source = fs.readFileSync(new URL('./AcceptanceCatalog.before.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\r?$/gm, '');
const evaluate = new Function('vue', 'helpers', 'env', `
  const { computed, nextTick, reactive, ref, watch } = vue;
  const { defineProps, defineEmits, onBeforeUnmount, API, apiHeaders, createBrowserCandidateSubmission } = env;
  const { AcceptanceCatalogError, buildCatalogBindingInput, buildCatalogProjectInput, buildCatalogReleaseInput,
    catalogFailure, catalogTargetUrl, catalogTerminalRuns, catalogVersion, createCatalogReadGuard, requestAcceptanceCatalog } = helpers;
  const STATUS_LABELS = {}, GATE_LABELS = {};
  ${script}
  return { selectedProject, draft, projects, version, detail, listLoading, detailLoading, writing, ready, notice, error,
    requiresReconcile, refreshCatalog, mutate };
`);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) { const end = Date.now() + 2000; while (!predicate()) {
  assert(Date.now() < end, 'Actual Vue state did not reach the controlled checkpoint.'); await pause(1); } }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const clone = value => JSON.parse(JSON.stringify(value));
function model({ stall = false } = {}) {
  const post = deferred(), list = deferred(), calls = [], projects = [{ id: 'ap-a', name: 'Project A' }, { id: 'ap-b', name: 'Project B' }];
  const releases = { 'ap-a': [], 'ap-b': [] }; let revision = 1, committed = false, dispose, listPending = false;
  const version = () => ({ generationId: 'ag-control', revision });
  const listValue = () => ({ ...version(), projects, runBindings: [] });
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body), release = { id: 'ar-committed', projectId: 'ap-a', label: body.label, targetUrl: body.targetUrl };
      revision++; committed = true; releases['ap-a'].push(release); await post.promise;
      return response({ ...version(), release }, 201);
    }
    if (url === '/api/acceptance/projects') {
      if (stall && committed) { listPending = true; await list.promise; }
      return response(listValue());
    }
    const id = url.split('/').at(-1);
    return response({ ...version(), project: projects.find(project => project.id === id), releases: releases[id], runBindings: [], events: [] });
  };
  const scope = vue.effectScope();
  const state = scope.run(() => evaluate(vue, { ...helpers,
    requestAcceptanceCatalog: (path, options) => helpers.requestAcceptanceCatalog(path, { ...options, fetcher }) }, {
    defineProps: () => ({ runs: [] }), defineEmits: () => () => {}, onBeforeUnmount: callback => { dispose = callback; },
    API: '', apiHeaders: () => ({}), createBrowserCandidateSubmission }));
  return { state, calls, post, list, releases, get listPending() { return listPending; }, get committed() { return committed; },
    dispose() { dispose(); scope.stop(); } };
}
const snapshot = state => Object.fromEntries(['selectedProject', 'listLoading', 'detailLoading', 'writing', 'ready', 'notice', 'error', 'requiresReconcile']
  .map(key => [key, clone(state[key].value)]));
const results = [];
for (const stall of [false, true]) {
  const fixture = model({ stall }), state = fixture.state;
  try {
    await state.refreshCatalog();
    Object.assign(state.draft.value.release, { label: 'Delayed acknowledged release', targetUrl: 'https://example.test/', buildRef: '' });
    const operation = state.mutate('release');
    await waitFor(() => fixture.committed);
    state.selectedProject.value = 'ap-b';
    await waitFor(() => !state.detailLoading.value);
    state.draft.value.release.label = 'Project B unsubmitted draft';
    fixture.post.resolve();
    if (stall) {
      await waitFor(() => fixture.listPending);
      const first = snapshot(state); await pause(80); const later = snapshot(state);
      assert.deepEqual(later, first);
      assert.equal(state.listLoading.value, true); assert.equal(state.writing.value, 'release');
      assert.equal(state.notice.value, ''); assert.equal(state.error.value, null); assert.equal(state.ready.value, false);
      assert.equal(fixture.releases['ap-a'].length, 1);
      results.push({ case: 'acknowledged-POST-then-never-settling-list-fetch', acknowledgedServerEntity: clone(fixture.releases['ap-a'][0]),
        checkpoint: first, unchangedAfter80ms: later, interpretation: 'No deadline exists in captured helper; manual test gate release is needed to settle.' });
      fixture.list.resolve();
    }
    await operation;
    assert.equal(state.writing.value, ''); assert.equal(state.listLoading.value, false); assert.equal(state.selectedProject.value, 'ap-b');
    assert.equal(state.draft.value.release.label, 'Project B unsubmitted draft'); assert.match(state.notice.value, /Delayed acknowledged release/);
    assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 1);
    results.push({ case: stall ? 'manual-gate-release-control' : 'normal-completed-lifecycle-control', state: snapshot(state),
      currentDraft: clone(state.draft.value), posts: 1 });
  } finally { fixture.dispose(); }
}
const output = { evidenceLevel: 'offline-actual-Vue-script-refs-watchers', ciCause: 'unknown; this deterministic product gap does not prove the CI stall cause',
  inputs: Object.fromEntries(['AcceptanceCatalog.before.vue', 'acceptance-catalog.before.js'].map(name => [name,
    createHash('sha256').update(fs.readFileSync(new URL(name, import.meta.url))).digest('hex')])), results };
fs.writeFileSync(new URL('./before-results.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
