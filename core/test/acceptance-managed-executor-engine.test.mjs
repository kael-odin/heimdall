import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { managedExecutionFixture, facts, json, waitFor } from '../scripts/fixtures/managed-execution.mjs';
import { readAcceptanceSnapshot } from '../src/acceptance/store.mjs';
import { acceptanceMarkdown } from '../src/acceptance/report.mjs';

async function fixture(t, options) { const f = await managedExecutionFixture(options); t.after(f.cleanup); return f; }
const ordinaryPlan = (f, path = '/ordinary-hold') => ({ name: '共享槽普通验收', mode: 'spec', targetUrl: f.base,
  timeoutMs: 30000, spec: { source: { id: 'REQ-ORDINARY', revision: '1' }, approved: true,
    checks: [{ id: 'ORDINARY', title: '普通执行合同', method: 'GET', path,
      expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });
const noModel = f => assert.deepEqual(f.modelRequests, []);
function originalSource(f) { assert.deepEqual(facts(f.sourceDir), f.sourceBefore); assert.equal(json(join(f.sourceDir, 'manifest.json')).plan.spec.approved, false); }
const runIds = f => fs.readdirSync(f.root).filter(name => /^ac-/.test(name)).sort();
function safeOperation(value) {
  const allowed = ['schemaVersion', 'operationId', 'projectId', 'runId', 'taskId', 'sourceRunId', 'targetReleaseId',
    'state', 'runCreated', 'gate', 'reasonCode', 'replayed'];
  assert.deepEqual(Object.keys(value).filter(key => !allowed.includes(key)), []);
}
async function cancel(engine, taskId) {
  const response = await engine.request('/api/jobs/' + taskId + '/cancel', { method: 'POST', body: {} });
  assert.equal(response.status, 200); assert.equal(response.body.id, taskId); return response;
}

test('fresh managed engine admission executes the approved draft against the explicit target, with one fixed task and verifiable BUG evidence', async t => {
  const f = await fixture(t), engine = await f.startEngine({ token: 'managed-engine-test' });
  const capability = await engine.request('/api/acceptance/execution');
  assert.equal(capability.status, 200); assert.equal(capability.headers['cache-control'], 'no-store');
  assert.equal(capability.body.enabled, true); assert.equal(capability.body.ready, true);
  assert.deepEqual(capability.body.methods, ['GET', 'HEAD']); assert.equal(capability.body.triageSupported, false);
  const input = f.confirmation(), response = await engine.execute(input);
  assert.equal(response.status, 202); assert.equal(response.body.replayed, false); assert.equal(response.body.runCreated, true);
  safeOperation(response.body);
  const { runId, taskId } = response.body, envelope = json(f.sidecar(input.operationId));
  assert.equal(envelope.runId, runId); assert.equal(envelope.taskId, taskId);
  assert.equal(envelope.plan.targetUrl, f.targetRelease.targetUrl); assert.equal(envelope.plan.spec.approved, true);
  assert.equal(envelope.candidate.source.runId, f.source.runId);
  const publicHead = await engine.waitRun(runId), task = await engine.waitTask(taskId, 'done');
  assert.equal(publicHead.gate, 'failed'); assert.equal(publicHead.taskId, taskId);
  assert.equal(publicHead.triageSupported, false); assert.equal(Object.hasOwn(publicHead, 'plan'), false);
  assert.equal(Object.hasOwn(publicHead, 'managed'), false);
  assert.equal(publicHead.provenance.sourceRunId, f.source.runId);
  assert.equal(task.history.status, 'done');
  const snapshot = readAcceptanceSnapshot(runId, { root: f.root });
  assert.equal(snapshot.integrity.valid, true); assert.equal(snapshot.integrity.evidenceVerified, true);
  assert.equal(snapshot.report.gate, 'failed'); assert.equal(snapshot.report.summary.bugs, 1);
  assert.deepEqual(snapshot.report.checks.map(check => check.verdict), ['match', 'bug']);
  assert.deepEqual(f.requests.map(request => request.path), ['/target/healthy', '/target/bug']);
  for (const [route, bytes] of [['report', fs.readFileSync(join(f.diskRun(runId), 'report.json'))],
    ['report.md', Buffer.from(acceptanceMarkdown(snapshot.report))],
    ...snapshot.report.evidenceManifest.map(item => ['evidence/' + item.file, fs.readFileSync(join(f.diskRun(runId), item.file))])]) {
    const download = await engine.get('/api/acceptance/runs/' + runId + '/' + route);
    assert.equal(download.status, 200, route); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes, route);
  }
  const triage = await engine.request('/api/acceptance/runs/' + runId + '/triage', { method: 'POST', body: {} });
  assert.equal(triage.status, 503); assert.equal(triage.body.code, 'MANAGED_EXECUTION_REQUIRED');
  const before = facts(f.root), jobsBefore = (await engine.jobs()).body;
  const replay = await engine.execute(input), operation = await engine.operation(input.operationId);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.state, 'completed');
  assert.equal(replay.body.runId, runId); assert.equal(replay.body.taskId, taskId);
  safeOperation(replay.body); safeOperation(operation.body);
  const conflict = await engine.execute({ ...input, targetReleaseId: f.alternateRelease.id });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  const terminalCancel = await cancel(engine, taskId); assert.equal(terminalCancel.body.status, 'done');
  assert.deepEqual(facts(f.root), before); assert.deepEqual((await engine.jobs()).body, jobsBefore);
  assert.equal(f.requests.length, 2); originalSource(f); noModel(f);
  await engine.stop();
  const restarted = await f.startEngine(), restartedJobs = (await restarted.jobs()).body;
  assert.deepEqual(restartedJobs.jobs, []);
  assert.equal(restartedJobs.history.find(item => item.id === taskId).status, 'done');
  assert.equal((await restarted.operation(input.operationId)).body.state, 'completed');
  assert.deepEqual(facts(f.root), before); assert.equal(f.requests.length, 2); noModel(f);
});

test('same-key concurrent managed calls execute once, ordinary admission shares the slot, and pending cancellation prevents every later request', async t => {
  const f = await fixture(t, { paths: ['/hold', '/later'], holdPaths: ['/hold'] }), engine = await f.startEngine();
  const input = f.confirmation(), responses = await Promise.all([engine.execute(input), engine.execute(input)]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 202]);
  assert.equal(responses[0].body.runId, responses[1].body.runId); assert.equal(responses[0].body.taskId, responses[1].body.taskId);
  const { runId, taskId } = responses[0].body;
  await f.arrived('/hold');
  const before = facts(f.root), jobsBefore = (await engine.jobs()).body;
  const busy = await engine.request('/api/acceptance/runs', { method: 'POST', body: ordinaryPlan(f) });
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'ACCEPTANCE_BUSY');
  assert.deepEqual(facts(f.root), before); assert.deepEqual((await engine.jobs()).body, jobsBefore);
  const replay = await engine.execute(input); assert.equal(replay.status, 200); assert.equal(replay.body.runId, runId);
  const capability = await engine.request('/api/acceptance/execution');
  assert.equal(capability.body.busy, true); assert.equal(capability.body.runId, runId); assert.equal(capability.body.taskId, taskId);
  await cancel(engine, taskId);
  const head = await engine.waitRun(runId, 'interrupted'), task = await engine.waitTask(taskId, 'cancelled');
  assert.equal(head.reasonCode, 'CANCELLED'); assert.equal(head.gate, 'blocked'); assert.equal(task.history.status, 'cancelled');
  await waitFor(() => f.matchingRequests('/hold')[0].closed);
  assert.equal(f.matchingRequests('/hold')[0].completed, false);
  assert.equal(f.matchingRequests('/hold').length, 1); assert.equal(f.matchingRequests('/later').length, 0);
  const cancelledBefore = facts(f.root), afterCancel = await engine.execute(input);
  assert.equal(afterCancel.status, 200); assert.equal(afterCancel.body.state, 'interrupted');
  assert.equal(afterCancel.body.reasonCode, 'CANCELLED'); assert.deepEqual(facts(f.root), cancelledBefore);
  f.release('/hold');
  const next = await engine.execute(f.confirmation()); assert.equal(next.status, 202);
  assert.notEqual(next.body.runId, runId); assert.equal((await engine.waitRun(next.body.runId)).gate, 'passed');
  await engine.waitTask(next.body.taskId, 'done');
  assert.equal(f.matchingRequests('/hold').length, 2); assert.equal(f.matchingRequests('/later').length, 1);
  originalSource(f); noModel(f);
  await engine.stop();
  const restarted = await f.startEngine(), history = (await restarted.jobs()).body.history;
  assert.equal(history.find(item => item.id === taskId).status, 'cancelled');
  assert.equal(history.find(item => item.id === next.body.taskId).status, 'done');
  assert.equal(f.manifest(runId).reasonCode, 'CANCELLED'); assert.equal(f.requests.length, 3); noModel(f);
});

test('ordinary running execution blocks fresh managed preparation without creating a dispatch or task, then releases the shared slot', async t => {
  const f = await fixture(t, { paths: ['/healthy'], holdPaths: ['/ordinary-hold'] });
  const prepared = await f.prepareOnly(), engine = await f.startEngine();
  const ordinary = await engine.request('/api/acceptance/runs', { method: 'POST', body: ordinaryPlan(f) });
  assert.equal(ordinary.status, 202); await f.arrived('/ordinary-hold');
  const input = f.confirmation(), before = facts(f.root), jobsBefore = (await engine.jobs()).body;
  const busy = await engine.execute(input); assert.equal(busy.status, 409); assert.equal(busy.body.code, 'ACCEPTANCE_BUSY');
  assert.equal(fs.existsSync(f.sidecar(input.operationId)), false);
  assert.deepEqual(facts(f.root), before); assert.deepEqual((await engine.jobs()).body, jobsBefore);
  const existing = await engine.execute(prepared.input);
  assert.equal(existing.status, 200); assert.equal(existing.body.state, 'prepared');
  assert.equal(existing.body.runCreated, false); assert.equal(existing.body.runId, prepared.envelope.runId);
  assert.deepEqual(facts(f.root), before); assert.deepEqual((await engine.jobs()).body, jobsBefore);
  await cancel(engine, ordinary.body.taskId); await engine.waitRun(ordinary.body.runId, 'interrupted');
  await engine.waitTask(ordinary.body.taskId, 'cancelled');
  const admitted = await engine.execute(input); assert.equal(admitted.status, 202);
  assert.equal((await engine.waitRun(admitted.body.runId)).gate, 'passed'); await engine.waitTask(admitted.body.taskId, 'done');
  assert.equal(f.matchingRequests('/healthy').length, 1); originalSource(f); noModel(f);
});

test('a real existing preparation stays query-only across POST and owned restarts', async t => {
  const f = await fixture(t), prepared = await f.prepareOnly(), before = facts(f.root), first = await f.startEngine();
  assert.equal(fs.existsSync(f.diskRun(prepared.envelope.runId)), false);
  const response = await first.execute(prepared.input), operation = await first.operation(prepared.input.operationId);
  assert.equal(response.status, 200); assert.equal(response.body.replayed, true); assert.equal(response.body.state, 'prepared');
  assert.equal(response.body.runCreated, false); assert.equal(operation.status, 200); assert.equal(operation.body.state, 'prepared');
  assert.equal(operation.body.runId, prepared.envelope.runId); assert.equal(operation.body.taskId, prepared.envelope.taskId);
  assert.deepEqual((await first.jobs()).body.jobs, []); assert.deepEqual((await first.jobs()).body.history, []);
  assert.deepEqual(facts(f.root), before); assert.deepEqual(f.requests, []); noModel(f);
  await first.stop(); const second = await f.startEngine(), replay = await second.execute(prepared.input);
  assert.equal(replay.status, 200); assert.equal(replay.body.state, 'prepared'); assert.equal(replay.body.runCreated, false);
  assert.deepEqual(facts(f.root), before); assert.deepEqual(f.requests, []); noModel(f); originalSource(f);
});

test('a killed managed pending request is interrupted by owned startup and neither query nor replay resends the request', async t => {
  const f = await fixture(t, { paths: ['/hold', '/later'], holdPaths: ['/hold'] }), first = await f.startEngine();
  const input = f.confirmation(), admitted = await first.execute(input); assert.equal(admitted.status, 202);
  const { runId, taskId } = admitted.body; await f.arrived('/hold');
  const dispatchBefore = fs.readFileSync(f.sidecar(input.operationId));
  await first.stop(); await waitFor(() => f.matchingRequests('/hold')[0].closed);
  assert.equal(f.matchingRequests('/hold')[0].completed, false);
  const second = await f.startEngine(), head = await second.waitRun(runId, 'interrupted');
  assert.equal(head.reasonCode, 'ENGINE_RESTARTED'); assert.equal(head.taskId, taskId); assert.equal(head.gate, 'blocked');
  const interruptedBefore = facts(f.root), jobsBefore = (await second.jobs()).body;
  assert.deepEqual(jobsBefore.jobs, []);
  assert.equal(jobsBefore.history.find(item => item.id === taskId).status, 'interrupted');
  const operation = await second.operation(input.operationId), replay = await second.execute(input);
  assert.equal(operation.status, 200); assert.equal(operation.body.state, 'interrupted'); assert.equal(operation.body.taskId, taskId);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.runId, runId);
  assert.equal(f.matchingRequests('/hold').length, 1); assert.equal(f.matchingRequests('/later').length, 0);
  assert.deepEqual(fs.readFileSync(f.sidecar(input.operationId)), dispatchBefore);
  assert.deepEqual(facts(f.root), interruptedBefore); assert.deepEqual((await second.jobs()).body, jobsBefore);
  await second.stop(); const third = await f.startEngine();
  assert.equal((await third.operation(input.operationId)).body.state, 'interrupted');
  assert.deepEqual(facts(f.root), interruptedBefore); assert.equal(f.requests.length, 1); originalSource(f); noModel(f);
});

test('the dedicated managed admission route rejects caller execution authority, unauthorized access and malformed input before any side effects', async t => {
  const f = await fixture(t), engine = await f.startEngine({ token: 'strict-managed-route' });
  const before = facts(f.root), runsBefore = runIds(f), input = f.confirmation();
  for (const [key, value] of [['plan', f.source.plan], ['targetUrl', f.base], ['approved', true], ['budget', 1],
    ['runId', f.source.runId], ['taskId', 'a-injected'], ['managed', {}]]) {
    const response = await engine.execute({ ...input, [key]: value });
    assert.equal(response.status, 400, key); assert.equal(response.body.code, 'INVALID_INPUT', key);
  }
  const malformed = await engine.request(f.executionPath, { method: 'POST', body: '{invalid' });
  assert.equal(malformed.status, 400); assert.equal(malformed.body.code, 'INVALID_INPUT');
  const unauthorized = await fetch(engine.base + f.executionPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(unauthorized.status, 401);
  const unknown = await engine.operation(input.operationId); assert.equal(unknown.status, 404);
  assert.deepEqual(facts(f.root), before); assert.deepEqual(runIds(f), runsBefore);
  assert.deepEqual((await engine.jobs()).body.jobs, []); assert.equal(fs.existsSync(f.sidecar(input.operationId)), false);
  assert.deepEqual(f.requests, []); noModel(f); originalSource(f);
});
