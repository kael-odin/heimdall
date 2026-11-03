/** Actual workbench refs/watchers with a fake transport; no DOM, Browser or engine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as helpers from '../../console/src/acceptance-workbench.js';
import * as demo from '../../console/src/acceptance-demo.js';

const require = createRequire(new URL('../../console/package.json', import.meta.url));
let vue, compiler;
try { vue = require('vue'); compiler = require('vue/compiler-sfc'); } catch { /* A Core-only install omits Console packages. */ }
const options = { skip: vue && compiler ? false : 'Console dependencies are required for the actual Vue state tests.' };
const source = fs.readFileSync(new URL('../../console/src/AcceptanceWorkbench.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\r?$/gm, '');
const evaluate = new Function('vue', 'helpers', 'demo', 'environment', `
  const { computed, reactive, ref, watch } = vue;
  const { defineEmits, onMounted, onBeforeUnmount, API, apiHeaders, location, localStorage, fetch } = environment;
  const { acceptanceDemoContext, acceptanceDemoDraft } = demo;
  const { DIMENSIONS, STATUS_LABELS, GATE_LABELS, VERDICT_LABELS, buildAcceptanceInput,
    filterAcceptanceChecks, acceptanceEvidenceEntries, acceptanceScore, acceptanceViewport,
    acceptanceSpecFingerprint, buildOpenApiPreviewInput, SPEC_CHECK_EXAMPLE,
    acceptanceLocalizationResult, localizationWhere, buildExplorationInput, mergeExploredPoints } = helpers;
  ${script}
  return { form, demoContext, demoLoaded, insertDemoPlan, creating, previewLoading, formError,
    previewResult, previewError, approvalInvalidated, createRun };
`);
const origin = 'http://127.0.0.1:8902';
const fixtureOrigin = 'http://127.0.0.1:39137';
const href = origin + '/?' + new URLSearchParams({ acceptanceDemo: 'local-fixed-v1', fixtureOrigin });
const acceptanceHref = href + '&view=acceptance';
const runId = 'ac-00000000-0000-4000-8000-000000000001';
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function model(t, url = href) {
  const calls = [], values = new Map(), mounted = [], scope = vue.effectScope(); let dispose;
  const state = scope.run(() => evaluate(vue, helpers, demo, {
    defineEmits: () => {}, onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => { dispose = callback; },
    API: '', apiHeaders: () => ({}), location: { href: url },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: async (url, input) => {
      calls.push({ url, ...input });
      if (input.method === 'POST' && url === '/api/acceptance/runs') return response({ runId });
      if (input.method === 'GET' && url === '/api/acceptance/runs/' + runId) return response({ runId, status: 'failed' });
      if (input.method === 'GET' && url === '/api/acceptance/runs') return response({ runs: [] });
      assert.fail(`Unexpected offline request: ${input.method} ${url}`);
    },
  }));
  t.after(() => { dispose(); scope.stop(); });
  return { ...state, calls, mounted, dispose };
}

test('workbench source and demo conditional compile with the real Vue compiler', options, () => {
  const parsed = compiler.parse(source, { filename: 'AcceptanceWorkbench.vue' });
  assert.deepEqual(parsed.errors, []);
  const script = compiler.compileScript(parsed.descriptor, { id: 'demo-state-check' });
  const template = compiler.compileTemplate({ source: parsed.descriptor.template.content, filename: 'AcceptanceWorkbench.vue',
    id: 'demo-state-check', compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  assert.match(source, /<section v-if="demoContext"[^>]+data-testid="acceptance-demo"/);
  assert.match(source, /<button type="button"[^>]+data-testid="acceptance-demo-prefill"[^>]+@click="insertDemoPlan"/);
});

test('valid local demo is inert until the operator loads the fixed form, and loading performs no requests', options, async t => {
  const state = model(t);
  assert(state.demoContext); assert.equal(state.form.mode, 'mirror'); assert.equal(state.form.baselineUrl, '');
  assert.equal(state.demoLoaded.value, false); assert.deepEqual(state.calls, []);
  state.formError.value = 'Earlier form error'; state.insertDemoPlan(); await vue.nextTick();
  assert.equal(state.form.mode, 'regression'); assert.equal(state.form.targetUrl, fixtureOrigin + '/bug');
  assert.equal(state.formError.value, ''); assert.equal(state.demoLoaded.value, true);
  assert.equal(state.form.specApproved, false); assert.equal(state.form.specApprovedFingerprint, '');
  assert.deepEqual(helpers.buildAcceptanceInput(state.form), helpers.buildAcceptanceInput(demo.acceptanceDemoDraft(state.demoContext)));
  assert.deepEqual(state.calls, []);
});

test('the routed acceptance view keeps the local demo available after navigation', options, async t => {
  const state = model(t, acceptanceHref);
  assert(state.demoContext);
  state.insertDemoPlan(); await vue.nextTick();
  assert.equal(state.form.mode, 'regression');
  assert.equal(state.form.targetUrl, fixtureOrigin + '/bug');
  assert.equal(state.demoLoaded.value, true);
  assert.deepEqual(state.calls, []);
});

test('ordinary and invalid-link workbenches keep the existing form and cannot load a demo', options, t => {
  for (const url of [origin + '/', href + '&token=secret', href.replace(encodeURIComponent(fixtureOrigin), encodeURIComponent('https://evil.test'))]) {
    const state = model(t, url); Object.assign(state.form, { name: 'User draft', targetUrl: 'https://target.test/', points: '[]' });
    const before = JSON.stringify(state.form); state.insertDemoPlan();
    assert.equal(state.demoContext, null); assert.equal(state.demoLoaded.value, false);
    assert.equal(JSON.stringify(state.form), before); assert.deepEqual(state.calls, []);
  }
});

test('loading is blocked while creating, previewing or unmounted and never retries automatically', options, async t => {
  const state = model(t); const before = JSON.stringify(state.form);
  state.creating.value = true; state.insertDemoPlan(); assert.equal(JSON.stringify(state.form), before);
  state.creating.value = false; state.previewLoading.value = true; state.insertDemoPlan(); assert.equal(JSON.stringify(state.form), before);
  state.previewLoading.value = false; await vue.nextTick(); assert.equal(JSON.stringify(state.form), before);
  state.dispose(); state.insertDemoPlan(); assert.equal(JSON.stringify(state.form), before); assert.deepEqual(state.calls, []);
});

test('loading replaces a draft only by explicit action and removes any prior Spec approval', options, async t => {
  const state = model(t);
  Object.assign(state.form, { mode: 'spec', targetUrl: 'https://old.test/', specSourceId: 'retained-source', specChecks: '[]' });
  state.form.specApproved = true; state.form.specApprovedFingerprint = helpers.acceptanceSpecFingerprint(state.form);
  state.insertDemoPlan(); await vue.nextTick();
  assert.equal(state.form.mode, 'regression'); assert.equal(state.form.specApproved, false); assert.equal(state.form.specApprovedFingerprint, '');
  state.form.targetUrl = 'https://operator.test/edited'; await vue.nextTick();
  assert.equal(state.form.targetUrl, 'https://operator.test/edited');
  state.insertDemoPlan(); assert.equal(state.form.targetUrl, fixtureOrigin + '/bug'); assert.deepEqual(state.calls, []);
});

test('after prefill only the normal explicit Run action posts the ordinary acceptance input once', options, async t => {
  const state = model(t); state.insertDemoPlan(); await vue.nextTick(); assert.deepEqual(state.calls, []);
  const expected = helpers.buildAcceptanceInput(state.form); await state.createRun(); await vue.nextTick();
  const posts = state.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].url, '/api/acceptance/runs'); assert.deepEqual(JSON.parse(posts[0].body), expected);
  assert(!state.calls.some(call => /projects|tickets|approve|register/.test(call.url)));
});

test('a workbench without a demo link still submits the operator form through the same Run action', options, async t => {
  const state = model(t, origin + '/');
  Object.assign(state.form, { name: 'Manual regression', mode: 'regression', baselineUrl: 'https://reference.test', targetUrl: 'https://target.test', routes: '/checkout' });
  const expected = helpers.buildAcceptanceInput(state.form); await state.createRun();
  const posts = state.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(JSON.parse(posts[0].body), expected); assert.equal(state.demoLoaded.value, false);
});
