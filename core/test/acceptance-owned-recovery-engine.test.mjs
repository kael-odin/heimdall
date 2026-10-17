import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoveryFixture, facts, json, encode, waitFor } from '../scripts/fixtures/owned-recovery.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { finishManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';

const ready = counts => ({ schemaVersion: 1, ready: true, status: 'ready', counts, code: null });
const blocked = { schemaVersion: 1, ready: false, status: 'blocked', counts: null, code: 'ACCEPTANCE_RECOVERY_BLOCKED' };
async function fixture(t) { const f = await recoveryFixture(); t.after(f.cleanup); return f; }
const responseJson = async (engine, path) => (await engine.get(path)).json();
const noExecution = (f, expectedRequests = []) => { assert.deepEqual(f.requests, expectedRequests); assert.deepEqual(f.modelRequests, []); };

test('owned engine startup settles mixed existing runs, preserves opaque managed partials and is byte-idempotent on restart', async t => {
  const f = await fixture(t), running = f.prepare({ start: true }), partial = f.prepare({ start: true }), terminal = f.prepare({ start: true });
  const legacy = f.legacy(), legacyPath = join(f.root, legacy.runId, 'manifest.json');
  const draftPlan = { ...f.legacyInput, spec: { ...f.legacyInput.spec, approved: false } };
  const source = createAcceptanceRun(draftPlan, { root: f.root });
  finishAcceptanceRun(source.runId, await runSpecAcceptance(source.plan, { runId: source.runId,
    outputDir: join(f.root, source.runId) }), { root: f.root });
  const terminalReport = finishManagedAcceptanceRun(terminal.ref, await runSpecAcceptance(terminal.envelope.plan,
    { runId: terminal.envelope.runId, outputDir: terminal.dir }), terminal.options);
  assert.equal(terminalReport.gate, 'failed'); assert.equal(terminalReport.summary.bugs, 1);
  const requestsBeforeStartup = structuredClone(f.requests); assert.equal(requestsBeforeStartup.length, 2);
  // Recovery verifies this completed manifest's linkage, without interpreting
  // or repairing its subsequently damaged optional historical report.
  fs.writeFileSync(terminal.reportPath, '{damaged historical report');
  const prepared = f.prepare(), opaque = Buffer.from('{private opaque unfinished report');
  fs.writeFileSync(partial.reportPath, opaque);
  fs.linkSync(partial.reportPath, join(partial.dir, 'report.json.' + randomUUID() + '.tmp'));
  assert.equal(fs.lstatSync(partial.reportPath).nlink, 2);
  const before = facts(f.root), original = [running, partial].map(run => json(run.manifestPath));
  const first = await f.startEngine();
  assert.deepEqual(await responseJson(first, '/api/acceptance/recovery'), ready({ managedInterrupted: 2,
    legacyInterrupted: 1, prepared: 1, skipped: 2, totalInterrupted: 3 }));
  for (const [index, run] of [running, partial].entries()) {
    const manifest = json(run.manifestPath);
    assert.equal(manifest.status, 'interrupted'); assert.equal(manifest.gate, 'blocked');
    assert.equal(manifest.reasonCode, 'ENGINE_RESTARTED');
    for (const key of ['runId', 'taskId', 'managed', 'plan', 'createdAt']) assert.deepEqual(manifest[key], original[index][key]);
  }
  assert.equal(json(legacyPath).status, 'interrupted'); assert.equal(json(legacyPath).gate, 'blocked');
  assert.match(json(legacyPath).error, /引擎已重启/);
  assert.deepEqual(fs.readFileSync(partial.reportPath), opaque); assert.equal(fs.lstatSync(partial.reportPath).nlink, 2);
  const after = facts(f.root), changed = [running.envelope.runId, partial.envelope.runId, legacy.runId].map(id => id + '/manifest.json');
  assert.deepEqual(Object.keys(after).filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name])).sort(), changed.sort());
  assert.equal(fs.existsSync(prepared.dir), false); assert.equal(fs.existsSync(join(f.root, '.acceptance-recovery.json')), false);
  assert.equal((await responseJson(first, '/api/status')).acceptance, null);
  const jobs = await responseJson(first, '/api/jobs'); assert.deepEqual(jobs.jobs, []); assert.deepEqual(jobs.history, []);
  assert.equal((await responseJson(first, '/api/acceptance/runs/' + running.envelope.runId)).status, 'interrupted');
  noExecution(f, requestsBeforeStartup); await first.stop();
  const second = await f.startEngine();
  assert.deepEqual(await responseJson(second, '/api/acceptance/recovery'), ready({ managedInterrupted: 0,
    legacyInterrupted: 0, prepared: 1, skipped: 5, totalInterrupted: 0 }));
  assert.deepEqual(facts(f.root), after); noExecution(f, requestsBeforeStartup);
});

test('failed startup keeps catalog diagnostic reads, blocks every acceptance mutation and latches until a new owned startup', async t => {
  const f = await fixture(t), managed = f.prepare({ start: true }), legacy = f.legacy(), prepared = f.prepare();
  fs.writeFileSync(prepared.sidecar, '{private corrupt namespace');
  const before = facts(f.root), engine = await f.startEngine();
  const recovery = await engine.get('/api/acceptance/recovery');
  assert.equal(recovery.status, 200); assert.equal(recovery.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await recovery.json(), blocked);
  const catalog = await engine.get('/api/acceptance/projects'); assert.equal(catalog.status, 200);
  const project = await responseJson(engine, '/api/acceptance/projects/' + f.project.id);
  assert.equal(project.executionReady, false);
  const jobs = await responseJson(engine, '/api/jobs');
  const paths = ['/projects', '/projects/' + f.project.id + '/releases', '/projects/' + f.project.id + '/run-bindings',
    '/projects/' + f.project.id + '/baseline-candidates', '/projects/' + f.project.id + '/baseline-approvals',
    '/projects/' + f.project.id + '/baseline-selections', '/runs', '/runs/' + legacy.runId + '/triage', '/openapi/preview'];
  for (const path of paths) {
    const response = await engine.get('/api/acceptance' + path, { method: 'POST', body: JSON.stringify({ ...f.legacyInput, managed: null }) });
    assert.equal(response.status, 503, path); assert.equal((await response.json()).code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  }
  for (const method of ['PATCH', 'DELETE']) {
    const response = await engine.get('/api/acceptance/unknown-route', { method, body: '{}' });
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  }
  const runs = await engine.get('/api/acceptance/runs'); assert.equal(runs.status, 409);
  assert.equal((await runs.json()).code, 'MANAGED_RUN_INTEGRITY_FAILED');
  assert.deepEqual(facts(f.root), before); assert.deepEqual(await responseJson(engine, '/api/jobs'), jobs); noExecution(f);
  fs.writeFileSync(prepared.sidecar, prepared.bytes);
  assert.deepEqual(await responseJson(engine, '/api/acceptance/recovery'), blocked);
  assert.equal((await responseJson(engine, '/api/acceptance/runs/' + managed.envelope.runId)).status, 'running');
  assert.equal((await engine.get('/api/acceptance/projects', { method: 'POST', body: '{}' })).status, 503);
  await engine.stop();
  const restarted = await f.startEngine();
  assert.deepEqual(await responseJson(restarted, '/api/acceptance/recovery'), ready({ managedInterrupted: 1,
    legacyInterrupted: 1, prepared: 1, skipped: 0, totalInterrupted: 2 }));
  assert.equal(json(managed.manifestPath).status, 'interrupted');
  assert.equal(json(join(f.root, legacy.runId, 'manifest.json')).status, 'interrupted');
  assert.equal(fs.existsSync(prepared.dir), false); noExecution(f);
});

test('a live owner rejects a second engine before recovery, jobs initialization or listening', async t => {
  const f = await fixture(t); f.prepare({ start: true }); f.legacy();
  const lockPath = join(f.root, '.acceptance-owner.json'), lock = fs.readFileSync(lockPath), before = facts(f.root);
  const engine = await f.startEngine({ releaseOwner: false });
  await waitFor(() => engine.child.exitCode !== null || engine.child.signalCode !== null);
  assert.equal(engine.child.exitCode, 1); assert.match(engine.output(), /ACCEPTANCE_OWNER_UNAVAILABLE/);
  assert.equal(engine.output().includes(engine.base), false);
  assert.equal(fs.existsSync(join(f.parent, 'jobs.db')), false);
  assert.equal(fs.existsSync(join(f.parent, 'jobs.json')), false);
  assert.deepEqual(fs.readFileSync(lockPath), lock); assert.deepEqual(facts(f.root), before); noExecution(f);
});

test('an existing prepared run directory without identity blocks the whole startup and owner loss takes precedence', async t => {
  const f = await fixture(t), healthy = f.prepare({ start: true }), prepared = f.prepare(); f.legacy();
  fs.mkdirSync(prepared.dir);
  const before = facts(f.root), engine = await f.startEngine();
  assert.deepEqual(await responseJson(engine, '/api/acceptance/recovery'), blocked);
  assert.deepEqual(facts(f.root), before); assert.equal(json(healthy.manifestPath).status, 'running');
  const lockPath = join(f.root, '.acceptance-owner.json'), lock = json(lockPath);
  fs.writeFileSync(lockPath, encode({ ...lock, nonce: '1'.repeat(64) === lock.nonce ? '2'.repeat(64) : '1'.repeat(64) }));
  for (const [path, options] of [['/api/acceptance/recovery', {}], ['/api/acceptance/projects', { method: 'POST', body: '{}' }]]) {
    const response = await engine.get(path, options); assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'ACCEPTANCE_OWNER_LOST');
  }
  noExecution(f);
});

for (const schemaVersion of [1, 2, 99]) test(`schema${schemaVersion} startup preserves the maintenance scene and never settles running records`, async t => {
  const f = await fixture(t), managed = f.prepare({ start: true }), legacy = f.legacy();
  const catalog = { schemaVersion, generationId: 'ag-' + randomUUID(), revision: 0,
    projects: {}, releases: {}, runBindings: {}, events: [] };
  if (schemaVersion === 2) Object.assign(catalog, { candidates: {}, approvals: {}, selections: {}, migrations: {} });
  for (const name of ['catalog.json', 'catalog.previous.json']) fs.writeFileSync(join(f.root, name), encode(catalog));
  const before = facts(f.root);
  for (let attempt = 0; attempt < 2; attempt++) {
    const engine = await f.startEngine();
    assert.deepEqual(await responseJson(engine, '/api/acceptance/recovery'), blocked);
    const response = await engine.get('/api/acceptance/projects');
    assert.equal(response.status, 503);
    const failure = await response.json();
    assert.equal(failure.code, 'CATALOG_UNAVAILABLE');
    assert.equal(failure.details.reason, schemaVersion === 99 ? 'UNSUPPORTED_SCHEMA' : 'MIGRATION_REQUIRED');
    assert.match(engine.output(), /recovery blocked: CATALOG_NOT_OPEN/);
    const write = await engine.get('/api/acceptance/projects', { method: 'POST', body: '{}' });
    assert.equal(write.status, 503); assert.equal((await write.json()).code, 'ACCEPTANCE_RECOVERY_BLOCKED');
    assert.deepEqual(facts(f.root), before);
    assert.equal(json(managed.manifestPath).status, 'running');
    assert.equal(json(join(f.root, legacy.runId, 'manifest.json')).status, 'running');
    noExecution(f); await engine.stop();
  }
});

test('explicit schema4 maintenance preserves prepared dispatch bytes and repeated ordinary startup stays read only', async t => {
  const f = await fixture(t), prepared = f.prepare();
  const preview = await f.catalog.previewMigration({ targetSchemaVersion: 4 });
  const migrated = await f.catalog.applyMigration({ targetSchemaVersion: 4,
    expectedGenerationId: preview.source.generationId, expectedRevision: preview.source.revision,
    expectedHeadSha256: preview.source.headSha256, expectedPreviousSha256: preview.source.previousSha256,
    expectedPlanDigest: preview.planDigest });
  assert.equal(migrated.catalog.schemaVersion, 4); assert.equal(migrated.completedSteps.length, 1);
  assert.deepEqual(migrated.catalog.browserCandidates, {});
  const before = facts(f.root), statPaths = Object.keys(before).filter(name => !name.endsWith('/'));
  const stats = () => Object.fromEntries(statPaths.map(name => {
    const stat = fs.statSync(join(f.root, name), { bigint: true });
    return [name, [stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].map(String)];
  }));
  const beforeStats = stats();
  for (let attempt = 0; attempt < 2; attempt++) {
    const engine = await f.startEngine();
    assert.deepEqual(await responseJson(engine, '/api/acceptance/recovery'), ready({ managedInterrupted: 0,
      legacyInterrupted: 0, prepared: 1, skipped: 0, totalInterrupted: 0 }));
    const listed = await responseJson(engine, '/api/acceptance/projects');
    assert.equal(listed.schemaVersion, 4); assert.equal(listed.generationId, migrated.catalog.generationId);
    assert.equal(listed.revision, migrated.catalog.revision);
    assert.deepEqual(facts(f.root), before); assert.deepEqual(stats(), beforeStats);
    assert.deepEqual(fs.readFileSync(prepared.sidecar), prepared.bytes); assert.equal(fs.existsSync(prepared.dir), false);
    noExecution(f); await engine.stop();
  }
});
