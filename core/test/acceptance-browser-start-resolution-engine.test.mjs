import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createBrowserOperationStore } from '../src/acceptance/browser-operation-store.mjs';
import { browserFixedFixture } from './fixtures/acceptance-browser-fixed.mjs';
import { browserResolutionWait, browserResolutionSha } from '../scripts/fixtures/browser-resolution-stream.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
function tree(root) {
  const entries = {};
  for (const item of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, item.name);
    if (item.isDirectory()) for (const [file, value] of Object.entries(tree(path))) entries[item.name + '/' + file] = value;
    else { const stat = fs.statSync(path, { bigint: true }), bytes = fs.readFileSync(path);
      entries[item.name] = { sha256: browserResolutionSha(bytes), bytes: bytes.length, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }; }
  }
  return entries;
}

test('D4 real engine: recovery barrier keeps ordinary/new writes closed while exact old accepted/rejected proofs remain readable', async t => {
  const data = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-resolution-engine-'))), root = join(data, 'acceptance');
  const f = await browserFixedFixture(), owner = acquireAcceptanceOwner({ root });
  let child, output = '';
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    owner.release(); fs.rmSync(data, { recursive: true, force: true });
  });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize({ createSchemaVersion: 4 });
  const version = catalog.read(), store = createBrowserOperationStore({ owner }), { project, sourceBinding } = f.review.organizationContext;
  const request = () => ({ operationId: 'bo-' + randomUUID(), expectedGenerationId: version.generationId, expectedRevision: version.revision,
    candidateId: f.candidate.id, contentDigest: f.candidate.contentDigest, targetReleaseId: f.targetRelease.id });
  const accepted = request(), rejected = request(), absent = request();
  store.publish({ ...f, project, sourceBinding, request: accepted }, { assertCurrent: () => true });
  store.publishRejection({ projectId: project.id, request: rejected }, { assertCurrent: () => true });
  const oldAccepted = store.inspectDecision(accepted.operationId), oldRejected = store.inspectDecision(rejected.operationId);
  // Separate corrupt scenes block global recovery and Browser recovery without touching the old facts.
  const badLegacy = join(root, 'ac-' + randomUUID()); fs.mkdirSync(badLegacy); fs.writeFileSync(join(badLegacy, 'manifest.json'), '{partial');
  const partialBrowser = join(root, 'browser-operations/v1', 'bo-' + randomUUID()); fs.mkdirSync(partialBrowser);
  const browserBefore = tree(join(root, 'browser-operations')), legacyBefore = tree(badLegacy);
  owner.release();
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const token = 'd4-real-engine-recovery-fixture';
  child = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: CORE, windowsHide: true,
    env: { ...process.env, HEIMDALL_DATA_DIR: data, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const base = 'http://127.0.0.1:' + port, headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
  async function call(path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + '/api/acceptance/' + path, { headers, signal: AbortSignal.timeout(5000),
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json(); assert.equal(response.status, status, JSON.stringify(payload)); return payload;
  }
  await browserResolutionWait(async () => {
    if (child.exitCode !== null) throw Error(output);
    return (await fetch(base + '/api/status', { headers })).ok;
  }, 'real engine starts with a blocked recovery', 15000);
  const recovery = await call('recovery'); assert.equal(recovery.ready, false); assert.equal(recovery.code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  const path = request => 'projects/' + project.id + '/browser-executions/' + request.operationId;
  const deny = request => ({ action: 'deny-future-starts-for-operation', request });
  for (const [request, outcome, original] of [[accepted, 'recorded', oldAccepted], [rejected, 'rejected', oldRejected]]) {
    const read = await call(path(request) + '/resolution'), replay = await call(path(request) + '/deny-start', deny(request));
    assert.equal(read.outcome, outcome); assert.equal(replay.outcome, outcome);
    if (outcome === 'recorded') {
      assert.equal(read.operation.state, 'prepared'); assert.deepEqual(read.request, request);
      assert.equal(read.dispatchSha256, original.value.record.sha256); assert.equal(replay.dispatchSha256, read.dispatchSha256);
    } else {
      assert.equal(read.rejectionSha256, original.record.sha256); assert.equal(replay.rejectionSha256, read.rejectionSha256);
    }
    await call(path(request) + '/deny-start', deny({ ...request, expectedRevision: request.expectedRevision + 1 }), 409);
  }
  await call(path(absent) + '/deny-start', deny(absent), 503);
  assert.equal(fs.existsSync(join(root, 'browser-operations/v1', absent.operationId)), false);
  const ordinary = await call('projects', { expectedGenerationId: version.generationId, expectedRevision: version.revision, name: 'Must stay blocked' }, 503);
  assert.equal(ordinary.code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  const start = await call('projects/' + project.id + '/browser-executions', absent, 503);
  assert.equal(start.code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  const blockedWrites = [
    [path(absent) + '/deny-start/', 'POST'],
    [path(absent) + '/deny-start-extra', 'POST'],
    [path(absent) + '/report', 'POST'],
    [path(absent) + '/deny-start', 'PUT'],
    [path(absent) + '/deny-start', 'DELETE'],
    ['projects/' + project.id + '/browser-executions/bo-invalid/deny-start', 'POST'],
  ];
  for (const [path, method] of blockedWrites) {
    const result = await call(path, deny(absent), 503, method);
    assert.equal(result.code, 'ACCEPTANCE_RECOVERY_BLOCKED', method + ' ' + path);
  }
  assert.deepEqual(tree(join(root, 'browser-operations')), browserBefore, 'All proof queries and failed writes preserve every Browser original.');
  assert.deepEqual(tree(badLegacy), legacyBefore, 'The blocked legacy scene is retained.');
});
