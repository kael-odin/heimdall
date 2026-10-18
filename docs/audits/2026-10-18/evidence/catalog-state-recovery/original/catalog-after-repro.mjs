/** Actual current Vue refs/watchers + bounded current helper. Controlled DTOs; no Browser/engine/network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as helpers from '../../../../console/src/acceptance-catalog.js';
import { createBrowserCandidateSubmission } from '../../../../console/src/acceptance-browser-candidates.js';
const vue = createRequire(new URL('../../../../console/package.json', import.meta.url))('vue');
const source = fs.readFileSync(new URL('../../../../console/src/AcceptanceCatalog.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\r?$/gm, '');
const evaluate = new Function('vue', 'helpers', 'env', `
  const { computed, nextTick, reactive, ref, watch } = vue;
  const { defineProps, defineEmits, onBeforeUnmount, API, apiHeaders, createBrowserCandidateSubmission } = env;
  const { AcceptanceCatalogError, buildCatalogBindingInput, buildCatalogProjectInput, buildCatalogReleaseInput,
    catalogFailure, catalogTargetUrl, catalogTerminalRuns, catalogVersion, createCatalogReadGuard, requestAcceptanceCatalog } = helpers;
  const STATUS_LABELS = {}, GATE_LABELS = {};
  ${script}
  return { selectedProject, draft, projects, version, detail, listLoading, detailLoading, writing, ready, notice, error,
    requiresReconcile, refreshCatalog, mutate, details: () => detailsPromise };
`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) { const end = Date.now() + 2000; while (!predicate()) {
  assert(Date.now() < end, 'Actual Vue state did not reach the checkpoint.'); await pause(1); } }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const clone = value => JSON.parse(JSON.stringify(value));
const snapshot = state => Object.fromEntries(['selectedProject', 'listLoading', 'detailLoading', 'writing', 'ready', 'notice', 'error', 'requiresReconcile']
  .map(key => [key, clone(state[key].value)]));
const results = [];
for (const stage of ['fetch', 'body']) {
  const calls = [], projects = [{ id: 'ap-a', name: 'Project A' }, { id: 'ap-b', name: 'Project B' }];
  const releases = { 'ap-a': [], 'ap-b': [] }; let revision = 1, stalled = false, started = false, dispose, cancellations = 0;
  const version = () => ({ generationId: 'ag-control', revision });
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body), release = { id: 'ar-committed', projectId: 'ap-a', label: body.label, targetUrl: body.targetUrl };
      revision++; releases['ap-a'].push(release); stalled = true;
      return response({ ...version(), release }, 201);
    }
    if (url === '/api/acceptance/projects') {
      if (stalled) {
        started = true;
        return stage === 'fetch' ? new Promise(() => {}) : { ok: true, status: 200, json: () => new Promise(() => {}),
          body: { cancel() { cancellations++; return new Promise(() => {}); } } };
      }
      return response({ ...version(), projects, runBindings: [] });
    }
    const id = url.split('/').at(-1);
    return response({ ...version(), project: projects.find(project => project.id === id), releases: releases[id], runBindings: [], events: [] });
  };
  const scope = vue.effectScope();
  const state = scope.run(() => evaluate(vue, { ...helpers,
    requestAcceptanceCatalog: (path, options) => helpers.requestAcceptanceCatalog(path, { ...options, timeoutMs: 35, fetcher }) }, {
    defineProps: () => ({ runs: [] }), defineEmits: () => () => {}, onBeforeUnmount: callback => { dispose = callback; },
    API: '', apiHeaders: () => ({}), createBrowserCandidateSubmission }));
  try {
    await state.refreshCatalog();
    Object.assign(state.draft.value.release, { label: 'Acknowledged release', targetUrl: 'https://example.test/' });
    const operation = state.mutate('release');
    await waitFor(() => started); const whileRefreshing = snapshot(state);
    assert.match(whileRefreshing.notice, /Acknowledged release.*写入已确认/);
    await operation; const boundedFailure = snapshot(state);
    assert.equal(boundedFailure.writing, ''); assert.equal(boundedFailure.listLoading, false);
    assert.equal(boundedFailure.requiresReconcile, true); assert.equal(boundedFailure.error.code, 'REQUEST_TIMEOUT');
    assert.match(boundedFailure.notice, /Acknowledged release.*写入已确认.*刷新核对/);
    const beforeRecovery = calls.length; stalled = false;
    await state.refreshCatalog({ reconcile: true }); const afterReadOnlyRecovery = snapshot(state);
    assert(calls.slice(beforeRecovery).every(call => call.method === 'GET'));
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(state.detail.value.releases.length, 1); assert.equal(afterReadOnlyRecovery.ready, true);
    results.push({ stage, timeoutMs: 35, whileRefreshing, boundedFailure, afterReadOnlyRecovery, posted: 1, cancellations,
      serverEntity: clone(releases['ap-a'][0]), recoveryMethods: calls.slice(beforeRecovery).map(call => call.method) });
  } finally { dispose(); scope.stop(); }
}
const output = { evidenceLevel: 'offline-actual-Vue-script-refs-watchers', productionRequestTimeoutMs: helpers.CATALOG_REQUEST_TIMEOUT_MS,
  ciCause: 'unknown; the prior CI was not reproduced and the unchanged Browser smoke still needs separate validation',
  inputs: Object.fromEntries(['console/src/AcceptanceCatalog.vue', 'console/src/acceptance-catalog.js'].map(path => [path,
    createHash('sha256').update(fs.readFileSync(new URL('../../../../' + path, import.meta.url))).digest('hex')])), results };
fs.writeFileSync(new URL('./after-results.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
