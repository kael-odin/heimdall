import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE } from '../src/acceptance/owner.mjs';
import { validateAcceptanceCatalog } from '../src/acceptance/catalog-schema.mjs';
import { createBrowserOperationStore } from '../src/acceptance/browser-operation-store.mjs';
import { compileFixedBrowserContract } from '../src/acceptance/browser-fixed-contract.mjs';
import { createDefectTicketService } from '../src/acceptance/defect-ticket-service.mjs';
import { browserFixedFixture } from './fixtures/acceptance-browser-fixed.mjs';
import { browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { append, empty, copy, AT } from './fixtures/acceptance-browser-organized-candidate.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uid = prefix => prefix + '-' + randomUUID();
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function tree(root) {
  if (!fs.existsSync(root)) return null;
  const files = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(tree(path))) files[entry.name + '/' + name] = value;
    else {
      const bytes = fs.readFileSync(path), stat = fs.statSync(path, { bigint: true });
      files[entry.name] = { sha256: sha(bytes), bytes: bytes.length, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    }
  }
  return files;
}

// These are offline, schema-checked captured facts. No Browser is launched to
// prepare them. A local target sentinel independently records any accidental I/O.
async function fixture(t, name, { seedTicket = false, blockedRecovery = false } = {}) {
  const evidenceRoot = process.env.HEIMDALL_D5_ENGINE_TEST_EVIDENCE_DIR;
  const evidence = evidenceRoot ? join(evidenceRoot, name) : null;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  let data;
  if (evidence) { data = join(evidence, 'data'); fs.mkdirSync(data); }
  else data = fs.mkdtempSync(join(tmpdir(), 'heimdall-defect-ticket-engine-'));
  data = fs.realpathSync(data);
  const root = join(data, 'acceptance'), requests = [], calls = [], engines = [], snapshots = {};
  let owner, target;
  async function stop(engine) {
    if (engine?.child && engine.child.exitCode === null && engine.child.signalCode === null) {
      const done = once(engine.child, 'exit'); engine.child.kill('SIGKILL'); await done;
    }
  }
  t.after(async () => {
    for (const engine of engines) await stop(engine);
    owner?.release();
    if (target?.listening) { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
    if (evidence) {
      for (const [index, engine] of engines.entries()) {
        fs.writeFileSync(join(evidence, `engine-${index + 1}.stdout.log`), engine.stdout);
        fs.writeFileSync(join(evidence, `engine-${index + 1}.stderr.log`), engine.stderr);
      }
      fs.writeFileSync(join(evidence, 'http.json'), encode(calls));
      fs.writeFileSync(join(evidence, 'source-snapshots.json'), encode(snapshots));
      fs.writeFileSync(join(evidence, 'target-requests.json'), encode(requests));
    } else fs.rmSync(data, { recursive: true, force: true });
  });
  target = createServer((req, res) => { requests.push({ method: req.method, url: req.url }); res.writeHead(500); res.end('unexpected target request'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const original = await browserFixedFixture(), targetRelease = { ...original.targetRelease,
    targetUrl: 'http://127.0.0.1:' + target.address().port + '/must-not-be-requested' };
  const f = { ...original, targetRelease, ...compileFixedBrowserContract({ material: original.material,
    review: original.review, candidate: original.candidate, targetRelease }) };
  const { project, sourceBinding } = f.review.organizationContext, foreignProject = { id: uid('ap'), name: 'Foreign project', createdAt: AT };
  owner = acquireAcceptanceOwner({ root });
  const catalog = empty();
  append(catalog, 'projects', copy(project), 'project-created', project.id);
  append(catalog, 'projects', foreignProject, 'project-created', foreignProject.id);
  append(catalog, 'releases', copy(f.review.organizationContext.release), 'release-created', project.id);
  append(catalog, 'releases', copy(targetRelease), 'release-created', project.id);
  append(catalog, 'browserSourceBindings', copy(sourceBinding), 'browser-source-bound', project.id);
  append(catalog, 'browserCandidates', copy(f.candidate), 'browser-candidate-created', project.id);
  validateAcceptanceCatalog(catalog); fs.writeFileSync(join(root, 'catalog.json'), encode(catalog), { flag: 'wx' });
  const operationStore = createBrowserOperationStore({ owner });
  async function operation(bugs, beforeOperationId = null) {
    const request = { operationId: uid('bo'), expectedGenerationId: catalog.generationId, expectedRevision: catalog.revision,
      candidateId: f.candidate.id, contentDigest: f.candidate.contentDigest, targetReleaseId: targetRelease.id };
    operationStore.publish({ ...f, project, sourceBinding, request });
    const run = operationStore.createRun(request.operationId), raw = browserOperationRaw(f, run);
    for (const index of bugs) { raw.checks[index].status = 'failed'; raw.checks[index].verdict = 'bug'; }
    const result = operationStore.finishRun(request.operationId, raw);
    operationStore.registerResult(request.operationId, { beforeOperationId });
    // Each accepted operation has an independently ordered timestamp.
    await pause(2); return result;
  }
  const source = await operation([0, 1]), healthy = await operation([], source.operationId);
  const createRequest = { ticketId: uid('dt'), actionId: uid('da'), sourceOperationId: source.operationId,
    memberCheckIds: source.report.checks.slice(0, 2).map(check => check.id), title: '两项页面还原缺陷', severity: 'high',
    description: '捕获的来源包含两项失败检查。', reproduction: '打开固定路由并核对这两项检查。' };
  if (seedTicket) await createDefectTicketService({ owner }).create(project.id, createRequest);
  let corruptPath;
  if (blockedRecovery) {
    corruptPath = join(root, uid('ac')); fs.mkdirSync(corruptPath); fs.writeFileSync(join(corruptPath, 'manifest.json'), '{partial fixture');
  }
  function sourceFacts(label) {
    const facts = { catalog: tree(root)['catalog.json'], browser: tree(join(root, 'browser-operations')),
      corrupt: corruptPath ? tree(corruptPath) : null };
    snapshots[label] = facts; return facts;
  }
  const originalFacts = sourceFacts('before-engine'); owner.release();
  const token = 'd5-isolated-engine-fixture';
  async function start() {
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const engine = { stdout: '', stderr: '', base: 'http://127.0.0.1:' + port };
    engine.child = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: CORE, windowsHide: true,
      env: { ...process.env, HEIMDALL_DATA_DIR: data, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    engines.push(engine);
    const engineIndex = engines.length;
    engine.child.stdout.on('data', bytes => {
      engine.stdout += bytes;
      if (evidence) fs.writeFileSync(join(evidence, `engine-${engineIndex}.stdout.log`), engine.stdout);
    });
    engine.child.stderr.on('data', bytes => {
      engine.stderr += bytes;
      if (evidence) fs.writeFileSync(join(evidence, `engine-${engineIndex}.stderr.log`), engine.stderr);
    });
    engine.request = async (path, { auth = token, method = 'GET', body, status = 200, ...options } = {}) => {
      const started = Date.now(), requested = { method, path,
        auth: auth === null ? 'missing' : auth === token ? 'valid' : 'invalid', ...(body === undefined ? {} : { body }) };
      let response, bytes;
      try {
        response = await fetch(engine.base + path, { method,
          headers: { ...(auth === null ? {} : { 'x-heimdall-token': auth }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options, signal: AbortSignal.timeout(30000) });
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (cause) {
        calls.push({ ...requested, elapsedMs: Date.now() - started, transportFailure: String(cause) });
        if (evidence) fs.writeFileSync(join(evidence, 'http.json'), encode(calls));
        throw cause;
      }
      const headers = Object.fromEntries(response.headers);
      const payload = headers['content-type']?.includes('application/json') ? JSON.parse(bytes) : null;
      calls.push({ ...requested, elapsedMs: Date.now() - started, status: response.status, headers, bytes: bytes.length, sha256: sha(bytes),
        ...(payload === null ? { text: bytes.toString() } : { payload }) });
      if (evidence) fs.writeFileSync(join(evidence, 'http.json'), encode(calls));
      assert.equal(response.status, status, `${method} ${path}: ${bytes.toString()}`);
      if (path.startsWith('/api/acceptance/')) {
        assert.equal(headers['cache-control'], 'no-store'); assert.equal(headers['x-content-type-options'], 'nosniff');
      }
      return { payload, bytes, headers };
    };
    const deadline = Date.now() + 15000;
    while (true) {
      if (engine.child.exitCode !== null) throw Error(engine.stdout + engine.stderr);
      try { await engine.request('/api/status'); break; }
      catch (error) { if (Date.now() >= deadline) throw Error(engine.stdout + engine.stderr, { cause: error }); await pause(75); }
    }
    return engine;
  }
  function unchanged(label) {
    assert.deepEqual(sourceFacts(label), originalFacts, 'D5 HTTP must preserve all Catalog and Browser source bytes/timestamps.');
    assert.deepEqual(requests, [], 'D5 HTTP must never request the target site.');
  }
  async function noJobs(engine) {
    const jobs = (await engine.request('/api/jobs')).payload;
    assert.deepEqual(jobs.jobs, []); assert.deepEqual(jobs.history, []);
    assert.equal((await engine.request('/api/status')).payload.acceptance, null);
  }
  return { root, project, foreignProject, candidate: f.candidate, source, healthy, createRequest, start, stop, unchanged, noJobs, token,
    path: '/api/acceptance/projects/' + project.id + '/defect-tickets', ticketNamespace: join(root, 'defect-tickets') };
}

const closeRequest = preview => ({ actionId: uid('da'), afterOperationId: preview.afterOperationId,
  expectedRevision: preview.expectedRevision, expectedHeadSha256: preview.expectedHeadSha256,
  memberSetDigest: preview.memberSetDigest, factsDigest: preview.factsDigest, previewDigest: preview.previewDigest,
  resolution: '两项固定检查均已复核通过。', confirmed: true });

test('D5 real engine authenticates all ticket routes and reads sources/actions without creating a ticket namespace', async t => {
  const f = await fixture(t, 'read-only'), engine = await f.start(), { ticketId, actionId } = f.createRequest;
  const paths = [f.path, f.path + '/sources?candidateId=' + f.candidate.id, f.path + '/actions/' + actionId,
    f.path + '/' + ticketId, f.path + '/' + ticketId + '/close-preview?afterOperationId=' + f.healthy.operationId,
    f.path + '/' + ticketId + '/export.md', f.path + '/' + ticketId + '/export.json'];
  for (const path of paths) for (const auth of [null, 'wrong-token']) await engine.request(path, { auth, status: 401 });
  await engine.request(f.path, { method: 'POST', auth: null, body: f.createRequest, status: 401 });
  assert.equal((await engine.request('/api/acceptance/recovery')).payload.ready, true);
  assert.equal((await engine.request(f.path)).payload.ticketCount, 0);
  const sources = (await engine.request(paths[1])).payload;
  assert.equal(sources.kind, 'manual-defect-ticket-sources'); assert.equal(sources.operations.length, 2);
  assert.equal(sources.operations.find(value => value.operationId === f.source.operationId).members.length, 2);
  assert.equal(sources.operations.find(value => value.operationId === f.healthy.operationId).members.length, 0);
  for (let index = 0; index < 2; index++) {
    const action = (await engine.request(paths[2])).payload;
    assert.equal(action.outcome, 'unresolved'); assert.equal(action.reason, 'ABSENCE_IS_NOT_A_COMMIT_DECISION');
  }
  const queryAuth = await engine.request(f.path + '?token=' + f.token, { auth: null });
  assert.equal(queryAuth.payload.kind, 'manual-defect-ticket-list');
  for (const path of paths.slice(3)) assert.equal((await engine.request(path, { status: 404 })).payload.code, 'NOT_FOUND');
  const foreign = f.path.replace(f.project.id, f.foreignProject.id);
  await engine.request(foreign + '/sources?candidateId=' + f.candidate.id, { status: 404 });
  await engine.request(f.path + '/unknown/suffix', { status: 404 });
  await engine.request(f.path + '/sources?candidateId=' + f.candidate.id + '&factsDigest=client', { status: 400 });
  assert.equal(fs.existsSync(f.ticketNamespace), false);
  await f.noJobs(engine); f.unchanged('after-read-only-http');
});

test('D5 real engine durably creates, previews, closes, replays and exports fixed members across restart', async t => {
  const f = await fixture(t, 'ticket-lifecycle'), engine = await f.start(), { ticketId, actionId } = f.createRequest;
  const created = (await engine.request(f.path, { method: 'POST', body: f.createRequest, status: 201 })).payload;
  assert.equal(created.outcome, 'recorded'); assert.equal(created.event.members.length, 2); assert.equal(created.event.revision, 0);
  const action = (await engine.request(f.path + '/actions/' + actionId)).payload;
  assert.equal(action.eventSha256, created.eventSha256); assert.deepEqual(action.event, created.event);
  const replayed = (await engine.request(f.path, { method: 'POST', body: f.createRequest })).payload;
  assert.equal(replayed.replayed, true); assert.equal(replayed.eventSha256, created.eventSha256);
  const conflict = (await engine.request(f.path, { method: 'POST', body: { ...f.createRequest, title: 'Different title' }, status: 409 })).payload;
  assert.equal(conflict.code, 'ACTION_CONFLICT'); assert.equal(conflict.outcomeUnknown, false);
  let ticket = (await engine.request(f.path + '/' + ticketId)).payload.ticket;
  assert.equal(ticket.processingStatus, 'open'); assert.equal(ticket.verificationStatus, 'verified_passed');
  assert.equal(ticket.members.length, 2);
  const preview = (await engine.request(f.path + '/' + ticketId + '/close-preview?afterOperationId=' + f.healthy.operationId)).payload.preview;
  assert.equal(preview.closeEligible, true); assert.equal(preview.counts.passed, 2);
  const closing = closeRequest(preview);
  const closed = (await engine.request(f.path + '/' + ticketId + '/close', { method: 'POST', body: closing, status: 201 })).payload;
  assert.equal(closed.event.revision, 1); assert.equal(closed.event.previousEventSha256, created.eventSha256);
  assert.equal((await engine.request(f.path + '/' + ticketId + '/close', { method: 'POST', body: closing })).payload.replayed, true);
  ticket = (await engine.request(f.path + '/' + ticketId)).payload.ticket;
  assert.equal(ticket.processingStatus, 'closed'); assert.equal(ticket.members.length, 2);
  const listing = (await engine.request(f.path)).payload;
  assert.equal(listing.ticketCount, 1); assert.equal(listing.associatedCheckCount, 2);
  for (const format of ['md', 'json']) {
    const artifact = await engine.request(f.path + '/' + ticketId + '/export.' + format);
    assert.equal(artifact.headers['content-disposition'], 'attachment; filename="' + ticketId + '.' + format + '"');
    assert.equal(artifact.headers['content-length'], String(artifact.bytes.length));
    assert.equal(artifact.headers['content-type'], format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8');
    if (format === 'json') {
      assert.equal(artifact.payload.handling.status, 'closed'); assert.equal(artifact.payload.members.length, 2);
      assert.equal(artifact.payload.history[0].eventSha256, created.eventSha256);
      assert.equal(artifact.payload.history[1].eventSha256, closed.eventSha256);
    } else assert.match(artifact.bytes.toString(), /人工缺陷单/);
  }
  const foreign = f.path.replace(f.project.id, f.foreignProject.id);
  for (const suffix of ['/' + ticketId, '/' + ticketId + '/export.json', '/actions/' + actionId, '/actions/' + closing.actionId]) {
    assert.equal((await engine.request(foreign + suffix, { status: 404 })).payload.code, 'NOT_FOUND');
  }
  const retainedTickets = tree(f.ticketNamespace);
  await f.noJobs(engine); f.unchanged('after-ticket-lifecycle'); await f.stop(engine);
  const restarted = await f.start();
  assert.equal((await restarted.request(f.path + '/' + ticketId)).payload.ticket.processingStatus, 'closed');
  assert.equal((await restarted.request(f.path + '/actions/' + closing.actionId)).payload.eventSha256, closed.eventSha256);
  assert.equal((await restarted.request(f.path, { method: 'POST', body: f.createRequest })).payload.replayed, true);
  assert.deepEqual(tree(f.ticketNamespace), retainedTickets, 'Restart and reads must retain exact ticket events.');
  await f.noJobs(restarted); f.unchanged('after-restart');
});

test('D5 real engine recovery barrier preserves old ticket reads and rejects every ticket POST before dispatch', async t => {
  const f = await fixture(t, 'recovery-blocked', { seedTicket: true, blockedRecovery: true }), engine = await f.start();
  const { ticketId, actionId } = f.createRequest, ticketsBefore = tree(f.ticketNamespace);
  assert.equal((await engine.request('/api/acceptance/recovery')).payload.ready, false);
  assert.equal((await engine.request(f.path + '/' + ticketId)).payload.ticket.processingStatus, 'open');
  assert.equal((await engine.request(f.path + '/actions/' + actionId)).payload.outcome, 'recorded');
  assert.equal((await engine.request(f.path + '/actions/' + uid('da'))).payload.outcome, 'unresolved');
  await engine.request(f.path + '/sources?candidateId=' + f.candidate.id);
  await engine.request(f.path + '/' + ticketId + '/export.json');
  const preview = (await engine.request(f.path + '/' + ticketId + '/close-preview?afterOperationId=' + f.healthy.operationId)).payload.preview;
  for (const [path, body] of [[f.path, f.createRequest], [f.path, { ...f.createRequest, ticketId: uid('dt'), actionId: uid('da') }],
    [f.path + '/' + ticketId + '/close', closeRequest(preview)], [f.path + '/unknown', {}]]) {
    const rejected = (await engine.request(path, { method: 'POST', body, status: 503 })).payload;
    assert.equal(rejected.code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  }
  assert.deepEqual(tree(f.ticketNamespace), ticketsBefore); await f.noJobs(engine); f.unchanged('after-blocked-http');
});

test('D5 real engine checks live ownership before any ticket source, action, download or write', async t => {
  const f = await fixture(t, 'owner-lost', { seedTicket: true }), engine = await f.start();
  const { ticketId, actionId } = f.createRequest;
  const ownerFile = join(f.root, ACCEPTANCE_OWNER_FILE);
  fs.renameSync(ownerFile, ownerFile + '.retained'); fs.writeFileSync(ownerFile, '{}', { flag: 'wx' });
  const originals = tree(f.root);
  for (const path of [f.path, f.path + '/sources?candidateId=' + f.candidate.id, f.path + '/actions/' + actionId,
    f.path + '/' + ticketId, f.path + '/' + ticketId + '/export.md', f.path + '/' + ticketId + '/export.json',
    f.path + '/' + ticketId + '/close-preview?afterOperationId=' + f.healthy.operationId]) {
    assert.equal((await engine.request(path, { status: 503 })).payload.code, 'ACCEPTANCE_OWNER_LOST');
  }
  for (const path of [f.path, f.path + '/' + ticketId + '/close']) {
    assert.equal((await engine.request(path, { method: 'POST', body: f.createRequest, status: 503 })).payload.code, 'ACCEPTANCE_OWNER_LOST');
  }
  await engine.request(f.path, { auth: null, status: 401 });
  assert.deepEqual(tree(f.root), originals, 'Lost owner cannot repair or mutate original records.');
  await f.noJobs(engine); f.unchanged('after-owner-lost-http');
});
