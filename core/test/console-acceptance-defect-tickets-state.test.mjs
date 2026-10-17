/** Actual component refs and watchers. Pure model DTOs; no Browser, engine or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import * as helpers from '../../console/src/acceptance-defect-tickets.js';
import { buildAcceptanceIdentity } from '../src/acceptance/identity.mjs';
import { defectTicketDigest, defectTicketEventBytes } from '../src/acceptance/defect-ticket-schema.mjs';
import { createDefectTicketEvent, projectDefectTicket, previewDefectTicketClose, listDefectTicketSources } from '../src/acceptance/defect-ticket-model.mjs';

let vue;
try { vue = createRequire(new URL('../../console/package.json', import.meta.url))('vue'); } catch { /* Core-only installs omit Vue. */ }
const options = { skip: vue ? false : 'Console dependencies are required for the actual Vue state tests.' };
const uid = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const origin = 'http://127.0.0.1:3000', projectId = uid('ap', 1), otherProjectId = uid('ap', 2), candidateId = uid('bc', 1), contentDigest = hash('content');
const at = n => `2026-10-18T01:${String(n).padStart(2, '0')}:00.000Z`;
const identity = buildAcceptanceIdentity({ kind: 'browser', facet: 'visual', route: '/', viewport: { width: 960, height: 640 },
  rule: { minimumScore: .97 }, oracle: { text: 'fixed oracle' }, environment: { platform: 'linux', arch: 'x64', nodeVersion: 'v22.0.0',
    browser: 'chromium', browserVersion: '153', playwrightVersion: '1.63.0', locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' } });
function operation(n, state) {
  const operationId = uid('bo', n), targetReleaseId = uid('ar', n), dispatchSha256 = hash('dispatch-' + n), evidenceManifest = [], evidence = {};
  for (const role of ['baselineScreenshot', 'baselineDetails', 'baselineRepeat', 'targetScreenshot', 'targetDetails', 'targetRepeat', 'diff']) {
    const file = `${n}-${role.toLowerCase()}.${role.endsWith('Details') ? 'json' : 'png'}`;
    evidence[role] = file; evidenceManifest.push({ file, bytes: 17, sha256: hash(file) });
  }
  const checks = state ? [{ id: 'desktop', title: 'Saved menu check', route: '/', identity: clone(identity), status: state,
    verdict: state === 'failed' ? 'bug' : 'match', actual: { eligible: true, stepsComplete: true, assertions: [] }, evidence }] : [];
  const report = { operationId, targetReleaseId, dispatchSha256, status: 'completed', mode: 'browser-fixed', verifierFingerprint: hash('verifier'),
    environmentComparison: { comparable: true, differences: [] }, checks, evidenceManifest };
  const reportSha256 = hash(report), observation = { projectId, candidateId, contentDigest, operationId, targetReleaseId, dispatchSha256, reportSha256,
    recordedAt: at(n), observations: checks.map(check => ({ bugId: 'bug-' + hash('bug'), checkId: check.id, identity: clone(identity), status: check.status,
      verdict: check.verdict, relation: check.status === 'failed' ? 'observed_failure' : 'verified_passed', evidenceReferences: clone(evidence) })) };
  return { operationId, targetReleaseId, acceptedAt: at(n), recordedAt: at(n), dispatchSha256, reportSha256, observationsSha256: hash(observation), report, observation };
}
const source = operation(1, 'failed'), healthy = operation(2, 'passed'), empty = operation(3, null);
const ref = operation => Object.fromEntries(['operationId', 'targetReleaseId', 'acceptedAt', 'recordedAt', 'dispatchSha256', 'reportSha256', 'observationsSha256'].map(key => [key, operation[key]]));
const factsFor = (operations = [source, healthy]) => ({ projectId, candidateId, contentDigest, factsDigest: defectTicketDigest('facts', operations.map(ref)), operations });
const request = { ticketId: uid('dt', 1), actionId: uid('da', 1), sourceOperationId: source.operationId, memberCheckIds: ['desktop'],
  title: 'Menu defect', severity: 'high', description: 'Declared menu state fails.', reproduction: '1. Open /\n2. Expand menu' };
const createEvent = input => createDefectTicketEvent({ projectId, request: input, facts: factsFor(), createdAt: at(4) });
const record = event => ({ event, sha256: hash(defectTicketEventBytes(event)) });
const records = [record(createEvent(request))];
const detailResponse = (facts = factsFor()) => ({ schemaVersion: 1, projectId, ticket: projectDefectTicket({ records, facts }) });
const sourcesResponse = () => ({ schemaVersion: 1, kind: 'manual-defect-ticket-sources', scope: 'registered-completed-browser-operations', ...listDefectTicketSources({ facts: factsFor() }) });
const listResponse = project => ({ schemaVersion: 1, kind: 'manual-defect-ticket-list', scope: 'declared-members', projectId: project,
  ticketCount: 0, associatedCheckCount: 0, tickets: [] });
const actionResponse = event => ({ schemaVersion: 1, kind: 'manual-defect-ticket-action', outcome: 'recorded', projectId, ticketId: event.ticketId,
  actionId: event.actionId, requestFingerprint: event.requestFingerprint, eventSha256: hash(defectTicketEventBytes(event)), event });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function locksFor() {
  const tails = new Map(); return { request(name, settings, callback) { assert.deepEqual(settings, { mode: 'exclusive' });
    const next = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' })); tails.set(name, next.catch(() => {})); return next; } };
}
function storageFor() { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
const keyFor = project => `heimdall:defect-tickets:v1:${origin}:${project}`;
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }
async function waitFor(predicate) { const deadline = Date.now() + 3000; while (!predicate()) {
  if (Date.now() >= deadline) assert.fail('Offline Vue state did not settle.'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const script = fs.readFileSync(new URL('../../console/src/AcceptanceDefectTickets.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\r?$/gm, '');
const evaluate = new Function('vue', 'helpers', 'environment', `
  const { computed, nextTick, reactive, ref, watch } = vue;
  const { defineProps, onBeforeUnmount, API, apiHeaders, location, window, localStorage, crypto } = environment;
  const { DEFECT_HANDLING_LABELS, DEFECT_VERIFICATION_LABELS, defectTicketCreateInput, defectTicketCloseInput,
    defectTicketSources, defectTicketList, defectTicketDetail, defectTicketPreview, defectTicketConfirmation,
    defectTicketAction, createDefectTicketReadGuard, createDefectTicketReceipts, requestDefectTickets, fetchDefectTicketExport } = helpers;
  ${script}
  return { draft, candidates, sources, selectedTicket, preview, pending, writing, loading, error, notice,
    createConfirmed, closeConfirmed, canCreate, canClose, canWrite, loadList, loadSources, openTicket, previewClose, submit, reconcile };
`);
function model(t, { storage = storageFor(), locks = locksFor(), transport = () => null, receiptAdapter } = {}) {
  const detailFor = project => ({ project: { id: project }, browserCandidates: project === projectId ? [{ id: candidateId, contentDigest, releaseId: source.targetReleaseId }] : [], releases: [] });
  const props = vue.reactive({ projectId, detail: detailFor(projectId), active: true, ready: true, version: { generationId: 'test-generation', revision: 1 } });
  const calls = [], listeners = new Map(), scope = vue.effectScope(); let dispose;
  const fetcher = async (url, options) => {
    calls.push({ url, ...options }); const value = transport(url, options); if (value !== null && value !== undefined) return value;
    const selectedProject = /\/projects\/([^/]+)/.exec(url)?.[1];
    if (options.method === 'GET' && url.endsWith('/defect-tickets')) return response(listResponse(selectedProject));
    if (options.method === 'GET' && url.includes('/sources?')) return response(sourcesResponse());
    if (options.method === 'GET' && url.endsWith('/' + request.ticketId)) return response(detailResponse());
    assert.fail(`Unexpected offline transport: ${options.method} ${url}`);
  };
  const adapted = { ...helpers,
    defectTicketConfirmation: (raw, options) => helpers.defectTicketConfirmation(raw, { ...options, crypto: webcrypto }),
    defectTicketAction: (raw, original, options) => helpers.defectTicketAction(raw, original, { ...options, crypto: webcrypto }),
    createDefectTicketReceipts: value => { const receipts = helpers.createDefectTicketReceipts({ ...value, locks }); return receiptAdapter ? receiptAdapter(receipts) : receipts; },
    requestDefectTickets: (project, suffix, options) => helpers.requestDefectTickets(project, suffix, { ...options, timeoutMs: 30, fetcher }) };
  const state = scope.run(() => evaluate(vue, adapted, { defineProps: () => props, onBeforeUnmount: callback => { dispose = callback; },
    API: '', apiHeaders: () => ({}), location: { origin, href: origin + '/' }, localStorage: storage, crypto: { subtle: webcrypto.subtle, randomUUID },
    window: { addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type) } }));
  t.after(() => { dispose(); scope.stop(); });
  const switchProject = project => { props.ready = false; props.projectId = project; props.detail = detailFor(project); props.ready = true; };
  return { ...state, props, calls, storage, listeners, switchProject, dispose };
}
async function prepare(state) {
  state.draft.value.candidateId = candidateId; await waitFor(() => !!state.sources.value);
  state.draft.value.sourceOperationId = source.operationId; state.draft.value.memberCheckIds = ['desktop'];
  Object.assign(state.draft.value, { title: request.title, severity: request.severity, description: request.description, reproduction: request.reproduction });
  state.createConfirmed.value = true; assert.equal(state.canCreate.value, true);
}

test('project switches preserve each draft, abort stale source reads and clear every explicit confirmation', options, async t => {
  const delayed = deferred(); const state = model(t, { transport: (url, options) => url.includes('/sources?') ? delayed.promise : null });
  state.draft.value.candidateId = candidateId; state.draft.value.title = 'Project A draft'; state.createConfirmed.value = true;
  await waitFor(() => state.calls.some(call => call.url.includes('/sources?'))); const original = state.calls.find(call => call.url.includes('/sources?'));
  state.switchProject(otherProjectId); state.draft.value.title = 'Project B draft'; assert.equal(original.signal.aborted, true);
  delayed.resolve(response(sourcesResponse())); await settle();
  assert.equal(state.sources.value, null); assert.equal(state.createConfirmed.value, false); assert.equal(state.canCreate.value, false);
  assert.equal(state.draft.value.title, 'Project B draft'); state.switchProject(projectId); await settle();
  assert.equal(state.draft.value.title, 'Project A draft'); assert.equal(state.createConfirmed.value, false);
  assert(state.calls.every(call => call.method === 'GET'));
});

test('switching projects after an exclusive claim cancels only the provably unsent original', options, async t => {
  const claimed = deferred(), release = deferred(); let once = true;
  const state = model(t, { receiptAdapter: receipts => ({ ...receipts, async claimForSubmit(original) {
    const saved = await receipts.claimForSubmit(original); if (once) { once = false; claimed.resolve(); await release.promise; } return saved;
  } }) });
  await prepare(state); const submitting = state.submit('create'); await claimed.promise;
  assert.equal(JSON.parse(state.storage.getItem(keyFor(projectId))).length, 1);
  state.switchProject(otherProjectId); release.resolve(); await submitting; await settle();
  assert.deepEqual(JSON.parse(state.storage.getItem(keyFor(projectId))), []); assert.equal(state.pending.value.length, 0);
  assert.equal(state.writing.value, false); assert(state.calls.every(call => call.method === 'GET'));
});

test('unknown POST results survive collapse, project switching and unresolved GET reconciliation without another POST', options, async t => {
  const state = model(t, { transport: (url, options) => {
    if (options.method === 'POST') throw new Error('simulated lost transport');
    if (url.includes('/actions/')) return response({ schemaVersion: 1, kind: 'manual-defect-ticket-action', projectId,
      actionId: url.split('/').at(-1), outcome: 'unresolved', reason: 'ABSENCE_IS_NOT_A_COMMIT_DECISION' });
    return null;
  } });
  await prepare(state); await state.submit('create'); assert.equal(state.pending.value.length, 1); assert.equal(state.canWrite.value, false);
  const original = clone(state.pending.value[0]); state.props.active = false; state.props.active = true;
  state.switchProject(otherProjectId); state.switchProject(projectId); await settle();
  assert.deepEqual(clone(state.pending.value), [original]); await state.reconcile(state.pending.value[0]);
  assert.deepEqual(clone(state.pending.value), [original]); assert.match(state.notice.value, /不代表确定未提交/);
  assert.equal(state.calls.filter(call => call.method === 'POST').length, 1); assert.equal(state.draft.value.title, request.title);
});

test('safe original POST rejection releases only its receipt and keeps the visible draft', options, async t => {
  const state = model(t, { transport: (url, options) => options.method === 'POST'
    ? response({ code: 'SOURCE_NOT_ELIGIBLE', error: 'private stack must not appear', outcomeUnknown: false }, 409) : null });
  await prepare(state); await state.submit('create');
  assert.equal(state.pending.value.length, 0); assert.equal(state.draft.value.title, request.title);
  assert.equal(state.createConfirmed.value, false); assert.equal(state.canCreate.value, false); assert.match(state.notice.value, /明确拒绝/);
  assert(!state.error.value.includes('private stack')); assert.equal(state.calls.filter(call => call.method === 'POST').length, 1);
});

test('an aborted late GET cannot clear its receipt or mutate another project; a new exact GET can resolve it', options, async t => {
  const delayed = deferred(); let originalEvent;
  const state = model(t, { transport: (url, options) => {
    if (options.method === 'POST') { originalEvent = createEvent(JSON.parse(options.body)); throw new Error('lost response'); }
    if (url.includes('/actions/')) return delayed.promise;
    if (originalEvent && options.method === 'GET' && url.endsWith('/' + originalEvent.ticketId)) return response({ schemaVersion: 1, projectId,
      ticket: projectDefectTicket({ records: [record(originalEvent)], facts: factsFor() }) });
    return null;
  } });
  await prepare(state); await state.submit('create'); const original = clone(state.pending.value[0]);
  const resolving = state.reconcile(state.pending.value[0]); await waitFor(() => state.calls.some(call => call.url.includes('/actions/')));
  state.switchProject(otherProjectId); state.draft.value.title = 'New project untouched'; delayed.resolve(response(actionResponse(originalEvent)));
  await resolving; await settle();
  // Reset aborted the GET. Its late body cannot serve as the complete proof for removal.
  assert.equal(JSON.parse(state.storage.getItem(keyFor(projectId)))[0].actionId, original.actionId);
  assert.equal(state.pending.value.length, 0); assert.equal(state.draft.value.title, 'New project untouched');
  assert.equal(state.error.value, ''); assert.equal(state.selectedTicket.value, null);
  state.switchProject(projectId); await settle(); await state.reconcile(state.pending.value[0]);
  assert.deepEqual(JSON.parse(state.storage.getItem(keyFor(projectId))), []); assert.equal(state.pending.value.length, 0);
  assert.equal(state.calls.filter(call => call.method === 'POST').length, 1);
});

test('close preview uses the latest registered operation even when an earlier operation passed', options, async t => {
  const latestFacts = factsFor([source, healthy, empty]); let selectedAfter;
  const state = model(t, { transport: (url, options) => {
    if (options.method === 'GET' && url.endsWith('/' + request.ticketId)) return response(detailResponse(latestFacts));
    if (url.includes('/close-preview?')) { selectedAfter = new URL(url, origin).searchParams.get('afterOperationId');
      return response({ schemaVersion: 1, projectId, ticketId: request.ticketId,
        preview: previewDefectTicketClose({ records, facts: latestFacts, afterOperationId: selectedAfter }) }); }
    return null;
  } });
  await state.openTicket(request.ticketId); await state.previewClose();
  assert.equal(selectedAfter, empty.operationId); assert.equal(state.preview.value.closeEligible, false);
  assert.equal(state.preview.value.verificationStatus, 'unverified'); state.draft.value.resolution = 'Reviewed'; state.closeConfirmed.value = true;
  assert.equal(state.canClose.value, false); await state.submit('close'); assert(state.calls.every(call => call.method === 'GET'));
});

test('storage changes invalidate explicit close confirmation and preserve unknown originals', options, async t => {
  const state = model(t); await state.openTicket(request.ticketId); state.closeConfirmed.value = true;
  const original = await helpers.defectTicketConfirmation({ projectId, ticketId: request.ticketId, kind: 'create', request }, { crypto: webcrypto });
  state.storage.setItem(keyFor(projectId), JSON.stringify([original])); state.listeners.get('storage')({ key: keyFor(projectId) });
  assert.equal(state.closeConfirmed.value, false); assert.deepEqual(clone(state.pending.value), [original]); assert.equal(state.canWrite.value, false);
  state.dispose(); assert.equal(state.listeners.size, 0); assert.equal(state.canWrite.value, false);
});
