import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createBrowserExecutionService } from '../src/acceptance/browser-execution-service.mjs';
import { handleBrowserExecutionRequest } from '../src/acceptance/browser-execution-api.mjs';
import { createAcceptanceExecutionRuntime } from '../src/acceptance/execution-runtime.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { openSlowBrowserPost, browserResolutionWait } from '../scripts/fixtures/browser-resolution-stream.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function serving(t, { beforePublish } = {}) {
  const f = await browserOperationFixture(t), runtime = createAcceptanceExecutionRuntime(), input = f.request();
  let starts = 0, preparations = 0;
  const service = createBrowserExecutionService({ owner: f.owner, store: f.store, runtime,
    catalog: {
      read: () => ({ generationId: input.expectedGenerationId, revision: input.expectedRevision, projects: { [f.project.id]: f.project } }),
      async withBrowserExecutionCandidate(projectId, request, { assertAdmission, publish }) {
        preparations++; assert.equal(projectId, f.project.id); assertAdmission();
        await beforePublish?.();
        assertAdmission(); const result = publish({ ...f, request }, { assertCurrent: assertAdmission });
        return { ...result, contract: f.contract, sourceFiles: f.sourceFiles };
      },
    }, runner(_contract, run) { starts++; return browserOperationRaw(f, run); },
  });
  service.recover();
  const ingress = [];
  const server = createServer(async (req, res) => {
    const digest = createHash('sha256'), entry = { path: req.url, method: req.method, bytes: 0, ended: false,
      remotePort: req.socket.remotePort, traceId: req.headers['x-heimdall-smoke-trace'] };
    ingress.push(entry);
    const emit = req.emit;
    req.emit = function (event, ...args) {
      if (event === 'data') { entry.bytes += args[0].length; digest.update(args[0]); }
      if (event === 'end') { entry.ended = true; entry.sha256 = digest.digest('hex'); }
      return Reflect.apply(emit, this, [event, ...args]);
    };
    const json = (response, status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (!await handleBrowserExecutionRequest(req, res, new URL(req.url, 'http://fixture'), { service, json })) json(res, 404, { code: 'FALLTHROUGH' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.drain(); });
  const base = 'http://127.0.0.1:' + server.address().port, path = '/api/acceptance/projects/' + f.project.id + '/browser-executions';
  async function call(suffix, body, status = 200) {
    const response = await fetch(base + path + suffix, { headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const payload = await response.json(); assert.equal(response.status, status, JSON.stringify(payload)); return payload;
  }
  return { ...f, service, input, base, path, ingress, call, starts: () => starts, preparations: () => preparations };
}
const deny = request => ({ action: 'deny-future-starts-for-operation', request });

test('D4 HTTP race: deny wins while the same original POST body is unfinished, then its original tail cannot start a runner', async t => {
  const f = await serving(t), body = Buffer.from(JSON.stringify(f.input));
  const slow = openSlowBrowserPost({ url: f.base + f.path, body, operationId: f.input.operationId,
    headers: { 'content-type': 'application/json' } });
  t.after(() => slow.abort()); await slow.prefixWritten;
  const original = await browserResolutionWait(() => f.ingress.find(value => value.traceId === slow.traceId && value.bytes > 0), 'original ingress prefix');
  assert.equal(original.bytes, slow.splitAt); assert.equal(original.ended, false); assert.equal(f.preparations(), 0);
  const unresolved = await f.call('/' + f.input.operationId + '/resolution');
  assert.equal(unresolved.outcome, 'unresolved'); assert.equal(unresolved.reasonCode, 'ABSENT_OBSERVED');
  const proofs = await Promise.all([f.call('/' + f.input.operationId + '/deny-start', deny(f.input)),
    f.call('/' + f.input.operationId + '/deny-start', deny({ ...f.input }))]);
  assert.equal(proofs[0].outcome, 'rejected'); assert.equal(proofs[1].outcome, 'rejected');
  assert.equal(proofs[0].rejectionSha256, proofs[1].rejectionSha256);
  assert.equal(original.ended, false, 'The original request stays unfinished until after the durable rejection.');
  slow.finish(); const result = await slow.response;
  assert.equal(result.status, 409); assert.equal(result.payload.code, 'BROWSER_START_REJECTED');
  assert.equal(original.ended, true); assert.equal(original.bytes, body.length); assert.equal(original.sha256, slow.bodySha256);
  assert.equal(f.ingress.filter(value => value.path === f.path && value.method === 'POST').length, 1, 'No second POST may impersonate the original.');
  assert.equal(f.starts(), 0); assert.equal(f.preparations(), 0);
  assert.equal(f.store.inspectDecision(f.input.operationId).kind, 'rejected');
  assert.equal(f.service.list(f.project.id).operations.length, 0);
});

test('D4 HTTP race: a parsed admission pending before publication blocks deny without stopping the original', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await serving(t, { beforePublish: () => gate.promise });
  const original = f.call('', f.input, 202);
  original.catch(() => {});
  await browserResolutionWait(() => f.preparations() === 1, 'original admission pending');
  const proof = await f.call('/' + f.input.operationId + '/resolution');
  assert.equal(proof.outcome, 'unresolved'); assert.equal(proof.reasonCode, 'ADMISSION_PENDING');
  await f.call('/' + f.input.operationId + '/deny-start', deny(f.input), 409);
  assert.equal(f.store.inspectDecision(f.input.operationId).kind, 'absent'); assert.equal(f.starts(), 0);
  gate.resolve(); const accepted = await original; assert.equal(accepted.operationId, f.input.operationId);
  await f.service.drain(); assert.equal(f.starts(), 1); assert.equal(f.store.inspectDecision(f.input.operationId).kind, 'recorded');
  const recorded = await f.call('/' + f.input.operationId + '/deny-start', deny(f.input));
  assert.equal(recorded.outcome, 'recorded'); assert.equal(recorded.operation.operationId, f.input.operationId);
  assert.equal(f.starts(), 1);
});
