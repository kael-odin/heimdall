import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as store from '../src/acceptance/store.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { acceptanceMarkdown, summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress, finishManagedAcceptanceRun,
  settleManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';

const core = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const put = (path, value) => fs.writeFileSync(path, encode(value));
const cas = catalog => {
  const { generationId, revision } = catalog.read();
  return { expectedGenerationId: generationId, expectedRevision: revision };
};
function tree(directory, prefix = '') {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = prefix + entry.name, path = join(directory, entry.name);
    return entry.isDirectory() ? [[name + '/', 'directory'], ...Object.entries(tree(path, name + '/'))]
      : [[name, sha(fs.readFileSync(path))]];
  }));
}
const legacyRejected = action => assert.throws(action, error => {
  assert.equal(error.code, 'MANAGED_EXECUTION_REQUIRED');
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /[A-Z]:\\|\/tmp\//);
  return true;
});
function artifactUnavailable(action) {
  let result;
  try { result = action(); }
  catch (error) {
    assert.equal(error.code, 'MANAGED_RUN_INTEGRITY_FAILED');
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /[A-Z]:\\|\/tmp\//);
    return;
  }
  assert.equal(result, null);
}
function validSnapshot(snapshot) {
  assert.deepEqual(Object.keys(snapshot).sort(), ['integrity', 'manifest', 'report']);
  assert.deepEqual(Object.keys(snapshot.integrity).sort(), ['errors', 'evidenceVerified', 'reportSha256', 'valid', 'verifiedBytes', 'verifiedFiles']);
  assert.equal(snapshot.integrity.valid, true);
  assert.equal(snapshot.integrity.evidenceVerified, true);
  assert.deepEqual(snapshot.integrity.errors, []);
}

// Every managed fixture follows the real draft -> candidate -> approval ->
// selection -> dispatch -> owner-bound writer chain. Reads never create it.
async function fixture(t, paths = ['/healthy', '/bug']) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-consumers-'))), root = join(parent, 'acceptance');
  fs.mkdirSync(root);
  const owner = acquireAcceptanceOwner({ root }), requests = [], modelRequests = [];
  const server = createServer((request, response) => {
    if (request.url.startsWith('/v1/')) {
      modelRequests.push(request.url);
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"unexpected model call","items":[]}' } }] }));
      return;
    }
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/slow')) return;
    response.end(request.url.endsWith('/bug') ? '{"code":9}' : '{"code":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    owner.release();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const plan = normalizeSpecPlan({ name: 'managed consumer integration', mode: 'spec', targetUrl: base + '/source', timeoutMs: 1000,
    spec: { source: { id: 'REQ-CONSUMERS', revision: '1', type: 'manual' }, approved: false,
      checks: paths.map((path, index) => ({ id: 'consumer-' + index, title: path, path, method: 'GET', severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } });
  const catalog = createAcceptanceCatalogStore({ root, owner });
  await catalog.initialize();
  const project = (await catalog.createProject({ ...cas(catalog), name: 'managed consumers' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'source', targetUrl: plan.targetUrl })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'target', targetUrl: base + '/target' })).release;
  const source = store.createAcceptanceRun(plan, { root }), sourceDir = join(root, source.runId);
  store.finishAcceptanceRun(source.runId, await runSpecAcceptance(plan, { runId: source.runId, outputDir: sourceDir }), { root });
  await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: source.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id,
    contentDigest: candidate.contentDigest, reason: 'consumer test approval' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id,
    contentDigest: candidate.contentDigest, reason: 'consumer test selection' })).selection;
  async function prepare() {
    const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
      selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
    const envelope = JSON.parse(record.bytes.toString('utf8')), dir = join(root, envelope.runId);
    const ref = { operationId: envelope.operationId, dispatchSha256: record.sha256 }, options = { owner, assertActive: () => true };
    return { envelope, ref, options, dir, manifestPath: join(dir, 'manifest.json'), reportPath: join(dir, 'report.json'),
      raw: () => runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: dir }) };
  }
  const run = await prepare();
  assert.equal(requests.length, 0);
  assert.equal(modelRequests.length, 0);
  assert.equal(fs.existsSync(run.dir), false);
  return { parent, root, owner, base, requests, modelRequests, source, sourceDir, sourceBefore: tree(sourceDir),
    catalog, project, targetRelease, prepare, ...run };
}

test('prepared managed facts remain unstarted while public reads create no run, evidence, task or request', async t => {
  const f = await fixture(t), runId = f.envelope.runId, before = tree(f.root);
  assert.equal(store.readAcceptanceRun(runId, { root: f.root }), null);
  assert.equal(store.readAcceptanceSnapshot(runId, { root: f.root }), null);
  assert.equal(store.readAcceptanceArtifact(runId, 'report.json', { root: f.root }), null);
  assert.equal(store.listAcceptanceRuns({ root: f.root }).some(row => row.runId === runId), false);
  assert.deepEqual(store.readAcceptanceSnapshots([runId], { root: f.root }), [null]);
  assert.deepEqual(tree(f.root), before);
  assert.equal(f.requests.length, 0);
});

test('valid managed running progress and terminal settlement retain their real lifecycle in head and list reads', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-started', total: 2, completed: 0 } }, f.options);
  const before = tree(f.root), head = store.readAcceptanceRun(runId, { root: f.root });
  assert.equal(head.status, 'running'); assert.equal(head.gate, 'blocked');
  assert.deepEqual(head.progress, { kind: 'acceptance-started', total: 2, completed: 0 });
  const row = store.listAcceptanceRuns({ root: f.root }).find(item => item.runId === runId);
  assert.equal(row.status, 'running'); assert.deepEqual(row.progress, head.progress);
  assert.equal(Object.hasOwn(row, 'plan'), false);
  assert.equal(store.readAcceptanceSnapshot(runId, { root: f.root }).integrity.valid, false);
  assert.deepEqual(tree(f.root), before);
  for (const status of ['interrupted', 'failed']) {
    const run = status === 'interrupted' ? f : await f.prepare();
    if (run !== f) createManagedAcceptanceRun(run.ref, run.options);
    settleManagedAcceptanceRun(run.ref, { status, reasonCode: status === 'interrupted' ? 'CANCELLED' : 'EXECUTION_FAILED',
      error: 'consumer fixture settled' }, { owner: f.owner });
    const settledBefore = tree(f.root), settled = store.readAcceptanceRun(run.envelope.runId, { root: f.root });
    assert.equal(settled.status, status); assert.equal(settled.gate, 'blocked');
    assert.equal(store.listAcceptanceRuns({ root: f.root }).find(item => item.runId === run.envelope.runId).status, status);
    assert.equal(store.readAcceptanceSnapshot(run.envelope.runId, { root: f.root }).integrity.valid, false);
    artifactUnavailable(() => store.readAcceptanceArtifact(run.envelope.runId, 'report.json', { root: f.root }));
    assert.deepEqual(tree(f.root), settledBefore);
  }
  assert.equal(f.requests.length, 0);
});

test('real managed BUG completion yields an exact verified snapshot and ordered mixed legacy/managed batch', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  const report = finishManagedAcceptanceRun(f.ref, await f.raw(), f.options), before = tree(f.root);
  const snapshot = store.readAcceptanceSnapshot(runId, { root: f.root });
  validSnapshot(snapshot);
  assert.deepEqual(snapshot.manifest, json(f.manifestPath));
  assert.deepEqual(snapshot.report, report);
  assert.equal(snapshot.manifest.status, 'completed'); assert.equal(snapshot.report.gate, 'failed');
  assert.equal(snapshot.report.summary.bugs, 1);
  assert.equal(snapshot.integrity.reportSha256, sha(fs.readFileSync(f.reportPath)));
  const referenced = new Set(report.checks.flatMap(check => Object.values(check.evidence)));
  assert.equal(snapshot.integrity.verifiedFiles, referenced.size);
  assert.equal(snapshot.integrity.verifiedBytes, [...referenced].reduce((total, name) => total + fs.readFileSync(join(f.dir, name)).length, 0));
  const batch = store.readAcceptanceSnapshots([runId, f.source.runId], { root: f.root });
  assert.deepEqual(batch.map(item => item.manifest.runId), [runId, f.source.runId]);
  for (const item of batch) validSnapshot(item);
  assert.deepEqual(batch[0], snapshot);
  assert.deepEqual(tree(f.root), before);
  assert.deepEqual(tree(f.sourceDir), f.sourceBefore);
  assert.equal(f.requests.length, 2);
});

test('completed timeout is readable and verified while its acceptance gate stays environment-blocked', async t => {
  const f = await fixture(t, ['/slow']);
  createManagedAcceptanceRun(f.ref, f.options);
  finishManagedAcceptanceRun(f.ref, await f.raw(), f.options);
  const before = tree(f.root), snapshot = store.readAcceptanceSnapshot(f.envelope.runId, { root: f.root });
  validSnapshot(snapshot);
  assert.equal(snapshot.manifest.status, 'completed'); assert.equal(snapshot.report.gate, 'blocked');
  assert.equal(snapshot.report.checks[0].verdict, 'environment');
  assert.equal(snapshot.report.checks[0].actual.errorCode, 'REQUEST_TIMEOUT');
  assert.deepEqual(tree(f.root), before); assert.equal(f.requests.length, 1);
});

test('a published partial report never upgrades running or interrupted facts to a complete snapshot or artifact', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  const raw = await f.raw();
  assert.throws(() => finishManagedAcceptanceRun(f.ref, raw, { ...f.options, assertActive: () => !fs.existsSync(f.reportPath) }), error => error.writeMayHaveCommitted === true);
  const partialBytes = fs.readFileSync(f.reportPath), before = tree(f.root);
  assert.equal(store.readAcceptanceRun(runId, { root: f.root }).status, 'running');
  assert.equal(store.readAcceptanceSnapshot(runId, { root: f.root }).integrity.valid, false);
  artifactUnavailable(() => store.readAcceptanceArtifact(runId, 'report.json', { root: f.root }));
  assert.deepEqual(tree(f.root), before);
  settleManagedAcceptanceRun(f.ref, { status: 'interrupted', reasonCode: 'ENGINE_RESTARTED', error: 'preserved partial report' }, { owner: f.owner });
  assert.equal(store.readAcceptanceRun(runId, { root: f.root }).status, 'interrupted');
  assert.equal(store.readAcceptanceSnapshot(runId, { root: f.root }).integrity.valid, false);
  artifactUnavailable(() => store.readAcceptanceArtifact(runId, 'report.md', { root: f.root }));
  assert.deepEqual(fs.readFileSync(f.reportPath), partialBytes);
});

test('recomputed report digest and summary cannot hide a BUG status/verdict forgery from managed consumers', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  const report = finishManagedAcceptanceRun(f.ref, await f.raw(), f.options);
  for (const check of report.checks) if (check.verdict === 'bug') { check.status = 'passed'; check.verdict = 'match'; }
  const forged = summarizeAcceptanceReport(report), manifest = json(f.manifestPath);
  assert.equal(forged.gate, 'passed');
  put(f.reportPath, forged);
  Object.assign(manifest, { gate: forged.gate, summary: forged.summary, reportSha256: sha(fs.readFileSync(f.reportPath)) });
  put(f.manifestPath, manifest);
  const before = tree(f.root), snapshot = store.readAcceptanceSnapshot(runId, { root: f.root });
  assert.equal(snapshot.integrity.valid, false); assert.equal(snapshot.integrity.evidenceVerified, false);
  assert.ok(snapshot.integrity.errors.length > 0);
  artifactUnavailable(() => store.readAcceptanceArtifact(runId, 'report.json', { root: f.root }));
  assert.deepEqual(tree(f.root), before); assert.deepEqual(tree(f.sourceDir), f.sourceBefore);
});

test('reindexed request evidence still has to match the frozen managed plan instead of merely passing hashes', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  const report = finishManagedAcceptanceRun(f.ref, await f.raw(), f.options);
  const requestName = report.checks[0].evidence.request, requestPath = join(f.dir, requestName), request = json(requestPath);
  request.method = 'HEAD'; put(requestPath, request);
  const entry = report.evidenceManifest.find(item => item.file === requestName), bytes = fs.readFileSync(requestPath);
  entry.bytes = bytes.length; entry.sha256 = sha(bytes);
  put(f.reportPath, report);
  const manifest = json(f.manifestPath); manifest.reportSha256 = sha(fs.readFileSync(f.reportPath)); put(f.manifestPath, manifest);
  const before = tree(f.root), snapshot = store.readAcceptanceSnapshot(runId, { root: f.root });
  assert.equal(snapshot.integrity.valid, false); assert.equal(snapshot.integrity.evidenceVerified, false);
  artifactUnavailable(() => store.readAcceptanceArtifact(runId, requestName, { root: f.root }));
  assert.deepEqual(tree(f.root), before);
});

test('managed artifacts return captured bytes and derive Markdown while ignoring disk Markdown and unreferenced files', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  const report = finishManagedAcceptanceRun(f.ref, await f.raw(), f.options);
  fs.writeFileSync(join(f.dir, 'report.md'), 'MALICIOUS_DISK_MARKDOWN');
  fs.writeFileSync(join(f.dir, 'extra.json'), '{"unreferenced":true}\n');
  const before = tree(f.root), original = fs.readFileSync(f.reportPath);
  const artifact = store.readAcceptanceArtifact(runId, 'report.json', { root: f.root });
  assert.deepEqual(Object.keys(artifact).sort(), ['bytes', 'contentType', 'sha256']);
  assert.ok(Buffer.isBuffer(artifact.bytes)); assert.deepEqual(artifact.bytes, original);
  assert.equal(artifact.sha256, sha(original)); assert.equal(artifact.contentType, 'application/json; charset=utf-8');
  const markdown = store.readAcceptanceArtifact(runId, 'report.md', { root: f.root }), expectedMarkdown = Buffer.from(acceptanceMarkdown(report));
  assert.deepEqual(markdown.bytes, expectedMarkdown); assert.equal(markdown.sha256, sha(expectedMarkdown));
  assert.equal(markdown.contentType, 'text/markdown; charset=utf-8');
  const name = report.checks[0].evidence.response, evidence = store.readAcceptanceArtifact(runId, name, { root: f.root });
  assert.deepEqual(evidence.bytes, fs.readFileSync(join(f.dir, name)));
  assert.equal(evidence.sha256, sha(evidence.bytes));
  for (const name of ['extra.json', 'manifest.json', 'triage.json', 'plan.json', 'dispatch.json']) {
    assert.equal(store.readAcceptanceArtifact(runId, name, { root: f.root }), null, name);
  }
  assert.throws(() => store.readAcceptanceArtifact(runId, 'report.json.tmp', { root: f.root }));
  artifact.bytes.fill(0);
  assert.deepEqual(store.readAcceptanceArtifact(runId, 'report.json', { root: f.root }).bytes, original);
  assert.deepEqual(tree(f.root), before);
});

test('opening managed readers leaves all legacy mutations, triage, path artifacts and restart recovery quarantined', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  let before = tree(f.root);
  legacyRejected(() => store.readLegacyAcceptanceRun(runId, { root: f.root }));
  legacyRejected(() => store.updateAcceptanceRun(runId, { status: 'failed' }, { root: f.root }));
  assert.equal(store.recoverAcceptanceRuns({ root: f.root }), 0);
  assert.deepEqual(tree(f.root), before);
  const raw = await f.raw(); finishManagedAcceptanceRun(f.ref, raw, f.options); before = tree(f.root);
  for (const action of [() => store.updateAcceptanceRun(runId, { triageAvailable: true }, { root: f.root }),
    () => store.finishAcceptanceRun(runId, raw, { root: f.root }),
    () => store.acceptanceArtifact(runId, 'report.json', { root: f.root }),
    () => store.acceptanceArtifact(runId, 'report.md', { root: f.root }),
    () => store.saveAcceptanceTriage(runId, { status: 'completed', items: [] }, { root: f.root }),
    () => store.readAcceptanceTriage(runId, { root: f.root })]) legacyRejected(action);
  assert.equal(store.recoverAcceptanceRuns({ root: f.root }), 0);
  assert.deepEqual(tree(f.root), before); assert.equal(f.requests.length, 2);
});

test('real CLI rejects a valid readable managed running record before catch, runner, request or file mutation', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  assert.equal(store.readAcceptanceRun(runId, { root: f.root }).status, 'running');
  const before = tree(f.root);
  const script = `let requests = 0; globalThis.fetch = async () => { requests++; throw Error('unexpected target request'); };
    const { executeAcceptanceRun } = await import('./src/acceptance/cli.mjs');
    try { await executeAcceptanceRun(${JSON.stringify(runId)}); process.exitCode = 2; }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, requests })); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: core, env: { ...process.env, HEIMDALL_DATA_DIR: f.parent, HEIMDALL_ENV_FILE: join(f.parent, 'missing.env') },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: 'MANAGED_EXECUTION_REQUIRED', requests: 0 });
  assert.deepEqual(tree(f.root), before); assert.equal(f.requests.length, 0);
});

test('legacy catalog binding cannot claim a completed managed run for its frozen release or another project at the same URL', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  finishManagedAcceptanceRun(f.ref, await f.raw(), f.options);
  const otherProject = (await f.catalog.createProject({ ...cas(f.catalog), name: 'same URL is not managed ownership' })).project;
  const otherRelease = (await f.catalog.createRelease(otherProject.id, { ...cas(f.catalog), label: 'same URL release',
    targetUrl: f.targetRelease.targetUrl })).release;
  const before = tree(f.root), catalogBefore = fs.readFileSync(join(f.root, 'catalog.json'));
  for (const [projectId, releaseId] of [[f.project.id, f.targetRelease.id], [otherProject.id, otherRelease.id]]) {
    await assert.rejects(f.catalog.bindRun(projectId, { ...cas(f.catalog), runId, releaseId }), error => {
      assert.equal(error.code, 'SOURCE_NOT_ELIGIBLE'); assert.equal(error.status, 409); return true;
    });
    assert.deepEqual(fs.readFileSync(join(f.root, 'catalog.json')), catalogBefore);
    assert.deepEqual(tree(f.root), before);
  }
  assert.equal(f.requests.length, 2);
});

async function engine(f) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  f.owner.release();
  const child = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: core,
    env: { ...process.env, HEIMDALL_DATA_DIR: f.parent, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: '',
      HEIMDALL_CONSOLE_DIR: '', HEIMDALL_ENV_FILE: join(f.parent, 'missing.env'), HEIMDALL_LLM: '1',
      LLM_BASE_URL: f.base + '/v1', LLM_API_KEY: 'consumer-fixture-key', LLM_MODEL: 'consumer-fixture-model',
      LLM_PROTOCOL: 'chat', LLM_TIMEOUT_MS: '2000', LLM_MAX_RETRIES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  };
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (output.includes('http://127.0.0.1:' + port)) return { base: 'http://127.0.0.1:' + port, stop };
      if (child.exitCode !== null) assert.fail('engine exited: ' + output);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail('engine startup timed out: ' + output);
  } catch (error) { await stop(); throw error; }
}
function publicManagedDto(value, nonce) {
  const forbidden = new Set(['plan', 'envelope', 'record', 'dispatch', 'files', 'binding', 'receipt', 'owner', 'nonce']);
  const visit = current => {
    if (!current || typeof current !== 'object') return;
    for (const [key, entry] of Object.entries(current)) {
      assert.equal(forbidden.has(key), false, 'private DTO field: ' + key);
      visit(entry);
    }
  };
  visit(value);
  assert.equal(value.triageSupported, false);
  assert.equal(JSON.stringify(value).includes(nonce), false);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|D:\\private|\/tmp\/private/);
}

test('real HTTP managed consumers expose safe DTOs and exact bytes while triage and free-form managed execution stay isolated', async t => {
  const f = await fixture(t), runId = f.envelope.runId;
  createManagedAcceptanceRun(f.ref, f.options);
  const report = finishManagedAcceptanceRun(f.ref, await f.raw(), f.options), original = fs.readFileSync(f.reportPath);
  fs.writeFileSync(join(f.dir, 'report.md'), 'MALICIOUS_HTTP_MARKDOWN');
  fs.writeFileSync(join(f.dir, 'extra.json'), '{"unreferenced":true}');
  const running = await f.prepare(); createManagedAcceptanceRun(running.ref, running.options);
  const settled = await f.prepare(); createManagedAcceptanceRun(settled.ref, settled.options);
  const storedError = 'SECRET execution error at D:\\private\\trace.json /tmp/private/trace.json';
  settleManagedAcceptanceRun(settled.ref, { status: 'failed', reasonCode: 'EXECUTION_FAILED', error: storedError }, { owner: f.owner });
  const settledBytes = fs.readFileSync(settled.manifestPath);
  const { base, stop } = await engine(f);
  const get = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
  try {
    const ownerNonce = json(join(f.root, '.acceptance-owner.json')).nonce, before = tree(f.root);
    const jobsBefore = await (await get('/api/jobs')).json();
    assert.equal((await (await get('/api/llm/status')).json()).enabled, true);
    const listResponse = await get('/api/acceptance/runs'); assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    const statuses = new Map([[runId, 'completed'], [running.envelope.runId, 'running'], [settled.envelope.runId, 'failed']]);
    for (const [id, status] of statuses) {
      const row = list.runs.find(item => item.runId === id); assert.ok(row); publicManagedDto(row, ownerNonce);
      const response = await get('/api/acceptance/runs/' + id); assert.equal(response.status, 200);
      const detail = await response.json(); publicManagedDto(detail, ownerNonce);
      assert.equal(detail.status, status);
    }
    for (const id of statuses.keys()) for (const method of ['GET', 'POST']) {
      const response = await get('/api/acceptance/runs/' + id + '/triage', { method });
      assert.equal(response.status, 503); assert.equal((await response.json()).code, 'MANAGED_EXECUTION_REQUIRED');
    }
    assert.equal((await get('/api/acceptance/runs/' + running.envelope.runId + '/report')).status, 409);
    const response = await get('/api/acceptance/runs/' + runId + '/report');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    const markdown = await get('/api/acceptance/runs/' + runId + '/report.md');
    assert.equal(markdown.status, 200); assert.equal(markdown.headers.get('cache-control'), 'no-store');
    assert.equal(markdown.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await markdown.arrayBuffer()), Buffer.from(acceptanceMarkdown(report)));
    const evidenceName = report.checks[0].evidence.response, evidence = await get('/api/acceptance/runs/' + runId + '/evidence/' + evidenceName);
    assert.equal(evidence.status, 200); assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), fs.readFileSync(join(f.dir, evidenceName)));
    for (const name of ['extra.json', 'manifest.json', 'triage.json']) {
      assert.equal((await get('/api/acceptance/runs/' + runId + '/evidence/' + name)).status, 404, name);
    }
    for (const key of ['managed', 'authority', 'operationId', 'dispatchId', 'dispatchSha256', 'executor', 'runId', 'taskId']) {
      const rejected = await get('/api/acceptance/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...f.envelope.plan, [key]: null }) });
      assert.equal(rejected.status, 400, key); assert.equal((await rejected.json()).code, 'INVALID_INPUT');
    }
    assert.deepEqual(await (await get('/api/jobs')).json(), jobsBefore);
    assert.deepEqual(tree(f.root), before);
    assert.deepEqual(fs.readFileSync(settled.manifestPath), settledBytes);
    assert.equal(json(settled.manifestPath).error, storedError);
    assert.equal(f.modelRequests.length, 0); assert.equal(f.requests.length, 2);
    assert.deepEqual(tree(f.sourceDir), f.sourceBefore);
  } finally { await stop(); }
});
