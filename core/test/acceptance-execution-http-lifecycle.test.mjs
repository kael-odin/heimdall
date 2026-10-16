import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { managedExecutionFixture, facts, waitFor } from '../scripts/fixtures/managed-execution.mjs';

const TOKEN = 'managed-execution-lifecycle-fixture';
async function fixture(t, options) {
  const f = await managedExecutionFixture(options);
  t.after(() => f.cleanup());
  return f;
}
async function rawClient(t, engine) {
  const url = new URL(engine.base), chunks = [], errors = [];
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  socket.setNoDelay(true);
  socket.on('data', chunk => chunks.push(chunk));
  socket.on('error', error => errors.push(error.code));
  t.after(() => socket.destroy());
  await once(socket, 'connect', { signal: AbortSignal.timeout(10000) });
  return {
    socket, errors, response: () => Buffer.concat(chunks).toString('utf8'),
    write(bytes) { return new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve())); },
    async disconnect() {
      if (socket.destroyed) return;
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(10000) });
      socket.destroy(); await closed;
    },
  };
}
function headers(engine, path, bytes, extra = []) {
  return [`POST ${path} HTTP/1.1`, `Host: ${new URL(engine.base).host}`, 'Content-Type: application/json',
    `X-Heimdall-Token: ${TOKEN}`, `Content-Length: ${bytes}`, 'Connection: keep-alive', ...extra, '', ''].join('\r\n');
}
const runDirectories = f => fs.readdirSync(f.root).filter(name => /^ac-/.test(name)).sort();

test('managed HTTP lifecycle: client disconnection after a complete body does not cancel the admitted execution', async t => {
  const f = await fixture(t, { paths: ['/slow', '/after'], holdPaths: ['/slow'] });
  const engine = await f.startEngine({ token: TOKEN, forceJson: true }), input = f.confirmation();
  const client = await rawClient(t, engine), body = JSON.stringify(input);
  await client.write(headers(engine, f.executionPath, Buffer.byteLength(body)) + body);
  // A held real target request proves the complete body crossed admission.
  // Drop the initiating TCP connection while the worker remains in flight.
  const target = await f.arrived('/slow');
  await client.disconnect();
  const query = await engine.operation(input.operationId);
  assert.equal(query.status, 200); assert.equal(query.body.state, 'running');
  assert.equal(query.body.runCreated, true);
  const runId = query.body.runId, taskId = query.body.taskId;
  const capability = await engine.request('/api/acceptance/execution');
  assert.equal(capability.status, 200); assert.equal(capability.body.ready, false); assert.equal(capability.body.busy, true);
  const replay = await engine.execute(input);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.runId, runId);
  const busy = await engine.execute(f.confirmation());
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'ACCEPTANCE_BUSY');
  assert.equal(target.closed, false, 'dropping the caller must not abort the target fetch');
  assert.equal(f.requests.length, 1, 'later checks stay behind the controlled target response');
  f.release('/slow');
  const completed = await engine.waitRun(runId);
  assert.equal(completed.gate, 'passed');
  const task = await engine.waitTask(taskId, 'done');
  assert.equal(task.history?.status, 'done');
  assert.equal(f.requests.length, 2); assert.equal(f.matchingRequests('/after').length, 1);
  const original = fs.readFileSync(f.sidecar(input.operationId)), source = facts(f.sourceDir);
  const after = await engine.execute(input);
  assert.equal(after.status, 200); assert.equal(after.body.state, 'completed');
  assert.equal(after.body.runId, runId); assert.equal(f.requests.length, 2);
  assert.deepEqual(fs.readFileSync(f.sidecar(input.operationId)), original);
  assert.deepEqual(source, f.sourceBefore); assert.deepEqual(facts(f.sourceDir), f.sourceBefore);
  assert.equal(f.modelRequests.length, 0);
});

test('managed HTTP lifecycle: an incomplete body then disconnected socket creates no authority and the same key remains fresh', async t => {
  const f = await fixture(t, { paths: ['/healthy'] }), engine = await f.startEngine({ token: TOKEN, forceJson: true });
  const input = f.confirmation(), body = JSON.stringify(input), client = await rawClient(t, engine);
  const before = facts(f.root), runs = runDirectories(f);
  // The engine acknowledges these real headers, then receives syntactically
  // complete JSON whose declared HTTP body still lacks one byte. JSON validity
  // cannot authorize execution until IncomingMessage emits a complete end.
  await client.write(headers(engine, f.executionPath, Buffer.byteLength(body) + 1, ['Expect: 100-continue']));
  await waitFor(() => client.response().includes('100 Continue'));
  await client.write(body);
  const pending = await engine.operation(input.operationId);
  assert.equal(pending.status, 404); assert.equal(pending.body.code, 'NOT_FOUND');
  assert.equal((await engine.request('/api/acceptance/execution')).body.ready, true);
  assert.equal(f.requests.length, 0); assert.deepEqual(runDirectories(f), runs);
  assert.equal(fs.existsSync(f.sidecar(input.operationId)), false);
  await client.disconnect();
  const afterDisconnect = await engine.operation(input.operationId);
  assert.equal(afterDisconnect.status, 404);
  assert.deepEqual(facts(f.root), before);
  assert.equal(fs.existsSync(join(f.root, 'managed-spec-dispatches')), false);
  const jobs = await engine.jobs();
  assert.equal(jobs.body.jobs.filter(item => item.kind === 'acceptance').length, 0);
  // A subsequent full request with the same key must still be a fresh 202.
  const admitted = await engine.execute(input);
  assert.equal(admitted.status, 202); assert.equal(admitted.body.replayed, false);
  assert.equal(admitted.body.runCreated, true);
  await engine.waitRun(admitted.body.runId);
  await engine.waitTask(admitted.body.taskId, 'done');
  assert.equal(f.requests.length, 1); assert.deepEqual(facts(f.sourceDir), f.sourceBefore);
  assert.equal(f.modelRequests.length, 0);
});

test('managed HTTP lifecycle: POSIX SIGTERM settles the held worker as ENGINE_SHUTDOWN and restart never resumes it', {
  skip: process.platform === 'win32' ? 'Windows child.kill(SIGTERM) terminates the process without delivering a catchable POSIX shutdown signal.' : false,
}, async t => {
  const f = await fixture(t, { paths: ['/slow', '/after'], holdPaths: ['/slow'] });
  const engine = await f.startEngine({ token: TOKEN, forceJson: true }), input = f.confirmation();
  const admitted = await engine.execute(input);
  assert.equal(admitted.status, 202);
  const target = await f.arrived('/slow');
  const exited = once(engine.child, 'exit', { signal: AbortSignal.timeout(10000) });
  assert.equal(engine.child.kill('SIGTERM'), true);
  const [code, signal] = await exited;
  assert.equal(code, 0, engine.output()); assert.equal(signal, null);
  const manifest = f.manifest(admitted.body.runId);
  assert.equal(manifest.status, 'interrupted'); assert.equal(manifest.reasonCode, 'ENGINE_SHUTDOWN');
  assert.equal(manifest.gate, 'blocked');
  assert.equal(fs.existsSync(join(f.diskRun(admitted.body.runId), 'report.json')), false);
  await waitFor(() => target.closed);
  assert.equal(f.matchingRequests('/after').length, 0);
  const preserved = facts(f.diskRun(admitted.body.runId)), dispatch = fs.readFileSync(f.sidecar(input.operationId));
  const restarted = await f.startEngine({ token: TOKEN, forceJson: true });
  const queried = await restarted.operation(input.operationId);
  assert.equal(queried.status, 200); assert.equal(queried.body.state, 'interrupted');
  assert.equal(queried.body.reasonCode, 'ENGINE_SHUTDOWN');
  const replayed = await restarted.execute(input);
  assert.equal(replayed.status, 200); assert.equal(replayed.body.replayed, true);
  assert.equal(replayed.body.runId, admitted.body.runId);
  assert.deepEqual(facts(f.diskRun(admitted.body.runId)), preserved);
  assert.deepEqual(fs.readFileSync(f.sidecar(input.operationId)), dispatch);
  assert.equal(f.requests.length, 1); assert.equal(f.matchingRequests('/after').length, 0);
  assert.deepEqual(facts(f.sourceDir), f.sourceBefore); assert.equal(f.modelRequests.length, 0);
});
