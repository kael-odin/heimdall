import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { managedExecutionFixture, facts, json, waitFor } from '../scripts/fixtures/managed-execution.mjs';
import { readAcceptanceSnapshot } from '../src/acceptance/store.mjs';

async function fixture(t, options) { const f = await managedExecutionFixture(options); t.after(f.cleanup); return f; }
async function completed(t, options) {
  const f = await fixture(t, options), engine = await f.startEngine({ forceJson: true });
  const response = await engine.execute(f.confirmation()); assert.equal(response.status, 202);
  const { runId, taskId } = response.body;
  try { await engine.waitRun(runId); await engine.waitTask(taskId, 'done'); }
  catch (cause) { throw new Error('Completed fixture did not finish: ' + engine.output(), { cause }); }
  await engine.stop();
  return { f, runId, taskId };
}
async function history(engine, taskId) {
  const response = await engine.jobs(); assert.equal(response.status, 200); assert.equal(response.body.store, 'json');
  const job = response.body.history.find(item => item.id === taskId); assert.ok(job); return job;
}

test('startup projects a verified completed BUG report as task done and never reruns its target', async t => {
  const { f, runId, taskId } = await completed(t, { paths: ['/bug'] }), before = facts(f.root);
  const snapshot = readAcceptanceSnapshot(runId, { root: f.root });
  assert.equal(snapshot.integrity.valid, true); assert.equal(snapshot.report.gate, 'failed'); assert.equal(snapshot.report.summary.bugs, 1);
  const second = await f.startEngine({ forceJson: true }), job = await history(second, taskId);
  assert.equal(job.status, 'done'); assert.equal(job.error, null); assert.equal(job.payload.managedAcceptance.runId, runId);
  assert.deepEqual(facts(f.root), before); assert.equal(f.requests.length, 1); assert.deepEqual(f.modelRequests, []);
});

for (const artifact of ['report', 'evidence']) {
  test('startup rejects corrupted managed ' + artifact + ' instead of publishing a done job', async t => {
    const { f, runId, taskId } = await completed(t, { paths: ['/healthy'] });
    const report = json(join(f.diskRun(runId), 'report.json'));
    const path = artifact === 'report' ? join(f.diskRun(runId), 'report.json') : join(f.diskRun(runId), report.evidenceManifest[0].file);
    fs.writeFileSync(path, 'corrupted-' + artifact);
    const before = facts(f.root), snapshot = readAcceptanceSnapshot(runId, { root: f.root });
    assert.equal(snapshot.integrity.valid, false); assert.equal(snapshot.integrity.evidenceVerified, false);
    const second = await f.startEngine({ forceJson: true }), job = await history(second, taskId);
    assert.equal(job.status, 'failed'); assert.equal(job.error, 'MANAGED_MIRROR_UNAVAILABLE');
    assert.equal(json(join(f.diskRun(runId), 'manifest.json')).status, 'completed');
    assert.deepEqual(facts(f.root), before); assert.equal(fs.readFileSync(path, 'utf8'), 'corrupted-' + artifact);
    assert.equal(f.requests.length, 1); assert.deepEqual(f.modelRequests, []);
  });
}

for (const corrupted of ['binding', 'null-marker']) {
  test('startup rejects a managed job ' + corrupted + ' and never writes the referenced run', async t => {
    const { f, runId, taskId } = await completed(t, { paths: ['/healthy'] }), before = facts(f.root);
    const path = join(f.parent, 'jobs.db'), stored = json(path);
    if (corrupted === 'binding') stored.jobs[taskId].payload.managedAcceptance.runId = 'ac-' + randomUUID();
    else stored.jobs[taskId].payload.managedAcceptance = null;
    stored.jobs[taskId].status = 'running'; fs.writeFileSync(path, JSON.stringify(stored));
    const second = await f.startEngine({ forceJson: true }), job = await history(second, taskId);
    assert.equal(job.status, 'failed'); assert.equal(job.error, 'MANAGED_MIRROR_UNAVAILABLE');
    assert.equal(json(join(f.diskRun(runId), 'manifest.json')).status, 'completed');
    assert.deepEqual(facts(f.root), before); assert.equal(f.requests.length, 1); assert.deepEqual(f.modelRequests, []);
  });
}

test('startup derives an interrupted job from owned recovery after a real pending managed process crashes', async t => {
  const f = await fixture(t, { paths: ['/hold', '/later'], holdPaths: ['/hold'] }), first = await f.startEngine({ forceJson: true });
  const confirmation = f.confirmation(), response = await first.execute(confirmation); assert.equal(response.status, 202);
  const { runId, taskId } = response.body; await f.arrived('/hold');
  const dispatch = fs.readFileSync(f.sidecar(confirmation.operationId));
  await first.stop(); await waitFor(() => f.matchingRequests('/hold')[0].closed);
  const second = await f.startEngine({ forceJson: true }), job = await history(second, taskId), head = f.manifest(runId);
  assert.equal(head.status, 'interrupted'); assert.equal(head.reasonCode, 'ENGINE_RESTARTED');
  assert.equal(job.status, 'interrupted'); assert.equal(job.error, 'ENGINE_RESTARTED');
  assert.deepEqual(fs.readFileSync(f.sidecar(confirmation.operationId)), dispatch);
  assert.equal(fs.existsSync(join(f.diskRun(runId), 'report.json')), false);
  assert.equal(f.matchingRequests('/hold').length, 1); assert.equal(f.matchingRequests('/later').length, 0);
  const before = facts(f.root), replay = await second.execute(confirmation);
  assert.equal(replay.status, 200); assert.equal(replay.body.state, 'interrupted'); assert.deepEqual(facts(f.root), before);
  assert.deepEqual(f.modelRequests, []);
});

test('startup retains generic interrupted recovery for old jobs without a managed marker', async t => {
  const f = await fixture(t), before = facts(f.root), path = join(f.parent, 'jobs.db'), createdAt = Date.now();
  const runningId = 'a-' + randomUUID(), queuedId = 'r-' + randomUUID();
  fs.writeFileSync(path, JSON.stringify({ jobs: {
    [runningId]: { id: runningId, kind: 'acceptance', url: f.base, status: 'running', createdAt, payload: null },
    [queuedId]: { id: queuedId, kind: 'recon', url: f.base, status: 'queued', createdAt: createdAt - 1, payload: { legacy: true } },
  }, events: {} }));
  const engine = await f.startEngine({ forceJson: true });
  for (const id of [runningId, queuedId]) {
    const job = await history(engine, id); assert.equal(job.status, 'interrupted'); assert.equal(job.error, 'engine restarted while running');
  }
  assert.deepEqual(facts(f.root), before); assert.deepEqual(f.requests, []); assert.deepEqual(f.modelRequests, []);
});
