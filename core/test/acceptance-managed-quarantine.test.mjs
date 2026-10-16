import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAcceptanceRun, readAcceptanceRun, updateAcceptanceRun, finishAcceptanceRun, listAcceptanceRuns,
  readAcceptanceSnapshot, acceptanceArtifact, saveAcceptanceTriage, readAcceptanceTriage, recoverAcceptanceRuns } from '../src/acceptance/store.mjs';
import { createManagedSpecDispatchReadContext } from '../src/acceptance/managed-dispatch-reader.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';

const core = fileURLToPath(new URL('..', import.meta.url));
const preparedBytes = readFileSync(new URL('../../docs/audits/2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json', import.meta.url));
const prepared = JSON.parse(preparedBytes);
const input = { name: 'quarantine legacy', mode: 'spec', targetUrl: 'http://127.0.0.1:1', spec: {
  source: { id: 'quarantine', revision: 'v1' }, approved: false,
  checks: [{ id: 'HEALTH', title: 'health', path: '/health', method: 'GET', expect: { status: 200 } }],
} };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const put = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const get = path => JSON.parse(readFileSync(path, 'utf8'));
const errorIs = code => error => error.code === code && !error.message.includes(tmpdir());
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'heimdall-quarantine-')), root = join(parent, 'acceptance');
  mkdirSync(root); t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}
function publish(root, bytes = preparedBytes) {
  const directory = join(root, 'managed-spec-dispatches', 'v1'); mkdirSync(directory, { recursive: true });
  const file = join(directory, prepared.operationId + '.json'); writeFileSync(file, bytes); return file;
}
function reservedRun(root) {
  const dir = join(root, prepared.runId); mkdirSync(dir);
  put(join(dir, 'manifest.json'), { schemaVersion: 1, runId: prepared.runId, taskId: prepared.taskId,
    name: prepared.plan.name, mode: 'spec', plan: prepared.plan, targetUrl: prepared.plan.targetUrl,
    status: 'running', gate: 'blocked', createdAt: prepared.acceptedAt });
  return dir;
}
function tree(root) {
  const entries = {};
  const visit = (path, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, file = join(path, entry.name);
      if (entry.isDirectory()) visit(file, name + '/'); else entries[name] = hash(readFileSync(file));
    }
  };
  visit(root); return entries;
}
async function completed(root) {
  const run = createAcceptanceRun(input, { root });
  const raw = await runSpecAcceptance(run.plan, { runId: run.runId, outputDir: join(root, run.runId) });
  finishAcceptanceRun(run.runId, raw, { root }); return run;
}

test('reserved IDs cannot be downgraded by stripping every managed marker; all legacy consumers preserve bytes', t => {
  const { root } = fixture(t); publish(root); reservedRun(root);
  const before = tree(root), runId = prepared.runId;
  assert.throws(() => readAcceptanceRun(runId, { root }), errorIs('MANAGED_RUN_INTEGRITY_FAILED'));
  const calls = [() => updateAcceptanceRun(runId, { status: 'failed' }, { root }),
    () => finishAcceptanceRun(runId, {}, { root }), () => acceptanceArtifact(runId, 'report.json', { root }),
    () => saveAcceptanceTriage(runId, {}, { root }), () => readAcceptanceTriage(runId, { root })];
  for (const call of calls) assert.throws(call, errorIs('MANAGED_EXECUTION_REQUIRED'));
  const snapshot = readAcceptanceSnapshot(runId, { root });
  assert.deepEqual(snapshot.manifest, { runId }); assert.equal(snapshot.report, null);
  assert.equal(snapshot.integrity.valid, false); assert.equal(snapshot.integrity.errors[0].code, 'MANAGED_RUN_INTEGRITY_FAILED');
  assert.throws(() => readSpecCandidateSource(runId, { root, owner: { root, assertOwned() {} } }), errorIs('SOURCE_INTEGRITY_FAILED'));
  assert.equal(recoverAcceptanceRuns({ root }), 0);
  const list = listAcceptanceRuns({ root }); assert.equal(Array.isArray(list), true);
  assert.deepEqual(list.map(row => [row.runId, row.gate, row.code]), [[runId, 'blocked', 'MANAGED_RUN_INTEGRITY_FAILED']]);
  assert.deepEqual(tree(root), before);
});

test('prepared records without a run remain unstarted and never create manifests or tasks', t => {
  const { root } = fixture(t); publish(root); const before = tree(root);
  assert.equal(readAcceptanceRun(prepared.runId, { root }), null);
  assert.equal(readAcceptanceSnapshot(prepared.runId, { root }), null);
  assert.deepEqual(listAcceptanceRuns({ root }), []); assert.equal(recoverAcceptanceRuns({ root }), 0);
  assert.deepEqual(tree(root), before); assert.equal(existsSync(join(root, prepared.runId)), false);
});

test('legacy relative roots retain create/read/list/snapshot compatibility and share absolute read contexts', async t => {
  const { root } = fixture(t), relativeRoot = relative(process.cwd(), root);
  const run = await completed(relativeRoot); publish(root);
  const context = createManagedSpecDispatchReadContext({ root });
  assert.equal(readAcceptanceRun(run.runId, { root: relativeRoot, managedRead: context }).runId, run.runId);
  assert.equal(listAcceptanceRuns({ root: relativeRoot, managedRead: context })[0].runId, run.runId);
  assert.equal(readAcceptanceSnapshot(run.runId, { root: relativeRoot, managedRead: context }).integrity.valid, true);
});

for (const location of ['manifest', 'report']) test(`${location}-only managed markers quarantine otherwise ordinary completed facts`, async t => {
  const { root } = fixture(t), run = await completed(root), dir = join(root, run.runId);
  assert.equal(readAcceptanceSnapshot(run.runId, { root }).integrity.valid, true);
  const path = join(dir, location + '.json'), value = get(path); value.managed = null; put(path, value);
  const before = tree(root);
  assert.throws(() => readAcceptanceRun(run.runId, { root }), errorIs('MANAGED_RUN_INTEGRITY_FAILED'));
  assert.throws(() => acceptanceArtifact(run.runId, 'report.md', { root }), errorIs('MANAGED_EXECUTION_REQUIRED'));
  assert.throws(() => readSpecCandidateSource(run.runId, { root, owner: { root, assertOwned() {} } }), errorIs('SOURCE_INTEGRITY_FAILED'));
  assert.equal(readAcceptanceSnapshot(run.runId, { root }).report, null);
  assert.equal(listAcceptanceRuns({ root })[0].code, 'MANAGED_RUN_INTEGRITY_FAILED');
  assert.deepEqual(tree(root), before);
});

test('reserved ordinary input and patch fields fail before creating or rewriting run files', t => {
  const { parent, root } = fixture(t), absent = join(parent, 'absent');
  for (const key of ['managed', 'authority', 'operationId', 'dispatchId', 'dispatchSha256', 'executor', 'runId', 'taskId']) {
    assert.throws(() => createAcceptanceRun({ ...input, [key]: null }, { root: absent }), errorIs('INVALID_INPUT'));
    assert.equal(existsSync(absent), false);
  }
  const run = createAcceptanceRun(input, { root: absent }); assert.equal(readAcceptanceRun(run.runId, { root: absent }).status, 'running');
  const before = tree(absent);
  for (const mutate of [updateAcceptanceRun, finishAcceptanceRun]) {
    assert.throws(() => mutate(run.runId, { managed: undefined }, { root: absent }), errorIs('INVALID_INPUT'));
  }
  assert.deepEqual(tree(absent), before); assert.deepEqual(tree(root), {});
});

test('ordinary legacy runs remain readable with a valid namespace and a shared context; stale or wrong contexts block', async t => {
  const { root } = fixture(t), run = await completed(root); publish(root);
  const context = createManagedSpecDispatchReadContext({ root });
  assert.equal(readAcceptanceRun(run.runId, { root, managedRead: context }).runId, run.runId);
  assert.equal(readAcceptanceSnapshot(run.runId, { root, managedRead: context }).integrity.valid, true);
  assert.equal(listAcceptanceRuns({ root, managedRead: context })[0].runId, run.runId);
  const other = fixture(t).root, wrong = createManagedSpecDispatchReadContext({ root: other });
  assert.throws(() => readAcceptanceRun(run.runId, { root, managedRead: wrong }), errorIs('MANAGED_RUN_INTEGRITY_FAILED'));
  const file = join(root, 'managed-spec-dispatches', 'v1', prepared.operationId + '.json'); writeFileSync(file, '{}');
  assert.throws(() => listAcceptanceRuns({ root, managedRead: context }), errorIs('MANAGED_RUN_INTEGRITY_FAILED'));
  assert.equal(readAcceptanceSnapshot(run.runId, { root, managedRead: context }).integrity.valid, false);
});

test('damaged published namespace blocks list, creation and recovery without promoting or repairing files', t => {
  const { root } = fixture(t), run = createAcceptanceRun(input, { root }); publish(root, Buffer.from('{private payload'));
  const before = tree(root);
  for (const call of [() => listAcceptanceRuns({ root }), () => createAcceptanceRun(input, { root }),
    () => recoverAcceptanceRuns({ root }), () => readAcceptanceRun(run.runId, { root })]) {
    assert.throws(call, errorIs('MANAGED_RUN_INTEGRITY_FAILED'));
  }
  assert.equal(readAcceptanceSnapshot(run.runId, { root }).integrity.valid, false);
  assert.deepEqual(tree(root), before);
});

test('real CLI execute rejects a stripped reserved run before its catch or runner can write or request a target', t => {
  const { parent, root } = fixture(t); publish(root); reservedRun(root); const before = tree(root);
  const script = `let requests = 0; globalThis.fetch = () => { requests++; throw Error('unexpected request'); };
    const { executeAcceptanceRun } = await import('./src/acceptance/cli.mjs');
    try { await executeAcceptanceRun(${JSON.stringify(prepared.runId)}); process.exitCode = 2; }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, requests })); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: core, env: { ...process.env, HEIMDALL_DATA_DIR: parent }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: 'MANAGED_EXECUTION_REQUIRED', requests: 0 });
  assert.deepEqual(tree(root), before);
});

async function engine(t, parent) {
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: core,
    env: { ...process.env, HEIMDALL_DATA_DIR: parent, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: '', HEIMDALL_CONSOLE_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  };
  t.after(stop);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return { base: match[0], output: () => output, stop };
    if (child.exitCode !== null) assert.fail('engine exited: ' + output);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('engine startup timed out: ' + output);
}

test('engine keeps catalog readable with corrupt dispatches, blocks recovery and free execution before task creation', async t => {
  const { parent, root } = fixture(t), run = createAcceptanceRun(input, { root });
  const file = publish(root, Buffer.from('{private disk payload'));
  const manifestBefore = readFileSync(join(root, run.runId, 'manifest.json'));
  const { base, output, stop } = await engine(t, parent);
  try {
  const catalog = await fetch(base + '/api/acceptance/projects'); assert.equal(catalog.status, 200);
  assert.match(output(), /recovery blocked: MANAGED_RUN_INTEGRITY_FAILED/);
  assert.deepEqual(readFileSync(join(root, run.runId, 'manifest.json')), manifestBefore);
  const before = tree(root), jobsBefore = await (await fetch(base + '/api/jobs')).json();
  for (const path of ['/api/acceptance/runs', '/api/acceptance/runs/' + run.runId,
    '/api/acceptance/runs/' + run.runId + '/report', '/api/acceptance/runs/' + run.runId + '/triage']) {
    const response = await fetch(base + path); assert.equal(response.status, 409, path);
    const body = await response.json(); assert.equal(body.code, 'MANAGED_RUN_INTEGRITY_FAILED');
    assert.equal(JSON.stringify(body).includes('private'), false);
  }
  for (const extra of [{}, { managed: null }, { runId: prepared.runId }]) {
    const response = await fetch(base + '/api/acceptance/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, ...extra }) });
    assert.equal(response.status, Object.keys(extra).length ? 400 : 409);
    assert.equal((await response.json()).code, Object.keys(extra).length ? 'INVALID_INPUT' : 'MANAGED_RUN_INTEGRITY_FAILED');
  }
  assert.deepEqual(await (await fetch(base + '/api/jobs')).json(), jobsBefore);
  assert.deepEqual(tree(root), before); assert.equal(readFileSync(file, 'utf8'), '{private disk payload');
  } finally { await stop(); }
});

test('engine rejects invalid reserved facts and forged ordinary input before making tasks', async t => {
  const { parent, root } = fixture(t); publish(root); reservedRun(root);
  const { base, stop } = await engine(t, parent);
  try {
    const before = tree(root), jobsBefore = await (await fetch(base + '/api/jobs')).json();
    const list = await (await fetch(base + '/api/acceptance/runs')).json();
    assert.equal(Array.isArray(list.runs), true); assert.equal(list.runs[0].gate, 'blocked');
    assert.equal(list.runs[0].code, 'MANAGED_RUN_INTEGRITY_FAILED');
    for (const suffix of ['', '/report', '/report.md', '/evidence/detail.json', '/triage']) {
      const response = await fetch(base + '/api/acceptance/runs/' + prepared.runId + suffix);
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'MANAGED_RUN_INTEGRITY_FAILED');
    }
    for (const key of ['managed', 'authority', 'operationId', 'dispatchId', 'dispatchSha256', 'executor', 'runId', 'taskId']) {
      const response = await fetch(base + '/api/acceptance/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, [key]: null }) });
      assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_INPUT');
    }
    assert.deepEqual(await (await fetch(base + '/api/jobs')).json(), jobsBefore);
    assert.deepEqual(tree(root), before);
  } finally { await stop(); }
});
