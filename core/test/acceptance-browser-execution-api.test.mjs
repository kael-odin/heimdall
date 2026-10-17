import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { handleBrowserExecutionRequest, browserExecutionError } from '../src/acceptance/browser-execution-api.mjs';
import { uid } from './fixtures/acceptance-browser-organized-candidate.mjs';

const projectId = uid('ap', 31), operationId = uid('bo', 32), root = '/api/acceptance/projects/' + projectId;
const bytes = Buffer.from('controlled original evidence'), sha256 = createHash('sha256').update(bytes).digest('hex');
const post = value => ({ method: 'POST', body: Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value),
  headers: { 'content-type': 'application/json' } });
async function serving(t, overrides = {}) {
  const calls = [], service = Object.fromEntries(['list', 'read', 'report', 'cancel', 'registerResult', 'ledger'].map(method => [method,
    (...args) => { calls.push({ method, args }); return { method, args }; }]));
  service.execute = async (...args) => { calls.push({ method: 'execute', args }); return { status: 202, payload: { accepted: true } }; };
  service.evidence = (...args) => { calls.push({ method: 'evidence', args }); return { bytes, sha256 }; };
  Object.assign(service, overrides);
  const server = createServer(async (req, res) => {
    const json = (response, status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
    const handled = await handleBrowserExecutionRequest(req, res, new URL(req.url, 'http://fixture'), { service, json });
    if (!handled) json(res, 404, { code: 'FALLTHROUGH' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { calls, async request(path, options = {}) {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes: body,
      payload: options.method === 'HEAD' || !response.headers.get('content-type')?.includes('application/json') ? null : JSON.parse(body.toString()) };
  } };
}

test('Browser HTTP: dedicated collection, operation, report, stop, registration and ledger route exactly once', async t => {
  const f = await serving(t), tests = [
    [root + '/browser-executions', {}, 'list', [projectId]],
    [root + '/browser-executions', post({ confirmation: 'bounded' }), 'execute', [projectId, { confirmation: 'bounded' }]],
    [root + '/browser-executions/' + operationId, {}, 'read', [projectId, operationId]],
    [root + '/browser-executions/' + operationId + '/report', {}, 'report', [projectId, operationId]],
    [root + '/browser-executions/' + operationId + '/cancel', post({}), 'cancel', [projectId, operationId, {}]],
    [root + '/browser-executions/' + operationId + '/register-result', post({ beforeOperationId: uid('bo', 33) }), 'registerResult', [projectId, operationId, { beforeOperationId: uid('bo', 33) }]],
    [root + '/browser-bugs', {}, 'ledger', [projectId]],
  ];
  for (const [path, options, method, args] of tests) {
    const result = await f.request(path, options); assert.equal(result.status, method === 'execute' ? 202 : 200);
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(f.calls.at(-1), { method, args });
  }
  assert.equal(f.calls.length, tests.length);
});

test('Browser HTTP: evidence requires an expected hash and returns the exact bounded original bytes', async t => {
  const f = await serving(t), path = root + '/browser-executions/' + operationId + '/evidence/target-original.png';
  const result = await f.request(path + '?expectedSha256=' + sha256);
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/png');
  assert.equal(result.headers.get('x-content-sha256'), sha256); assert.equal(result.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(result.bytes, bytes); assert.deepEqual(f.calls, [{ method: 'evidence', args: [projectId, operationId, 'target-original.png', sha256] }]);
  for (const query of ['', '?expectedSha256=bad', '?expectedSha256=' + sha256 + '&expectedSha256=' + sha256,
    '?expectedSha256=' + sha256 + '&sourceUrl=https://private.invalid']) assert.equal((await f.request(path + query)).status, 400);
  for (const file of ['%2e%2e%2fprivate.png', 'foo.html', 'foo.svg', 'C%3afoo.png', 'foo.png%00']) {
    assert.equal((await f.request(root + '/browser-executions/' + operationId + '/evidence/' + file + '?expectedSha256=' + sha256)).status, 400);
  }
  assert.equal(f.calls.length, 1);
});

test('Browser HTTP: unsupported methods, unknown actions, malformed IDs and extra queries cannot dispatch', async t => {
  const f = await serving(t);
  const tests = [
    [root + '/browser-executions', { method: 'PUT' }, 405],
    [root + '/browser-executions/' + operationId, post({}), 405],
    [root + '/browser-executions/' + operationId + '/report', post({}), 405],
    [root + '/browser-executions/' + operationId + '/cancel', {}, 405],
    [root + '/browser-executions/' + operationId + '/register-result', {}, 405],
    [root + '/browser-bugs', post({}), 405],
    [root + '/browser-executions/' + operationId + '/restart', post({}), 404],
    [root + '/browser-executions/', {}, 400],
    [root + '/browser-bugs/' + operationId, {}, 404],
    [root + '/browser-executions/' + uid('ao', 32), {}, 400],
    [root.replace(projectId, 'ap-invalid') + '/browser-executions', {}, 400],
    [root + '/browser-executions?selectionId=unrequested', {}, 400],
    [root + '/browser-executions?token=a&token=b', {}, 400],
    [root + '/browser-executions?expectedSha256=' + sha256, {}, 400],
  ];
  for (const [path, options, status] of tests) {
    const result = await f.request(path, options); assert.equal(result.status, status, path);
    if (status === 405) assert.ok(result.headers.get('allow'));
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(root + '/baseline-executions')).payload.code, 'FALLTHROUGH');
});

test('Browser HTTP: bounded object-only fatal UTF-8 request bodies cannot reach service on invalid input', async t => {
  const f = await serving(t), path = root + '/browser-executions';
  for (const input of ['', '{', 'null', '[]', '"text"', '0', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
    assert.equal((await f.request(path, post(input))).status, 400);
  }
  assert.equal((await f.request(path, post(JSON.stringify({ huge: 'x'.repeat(16384) })))).status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(path, post({ bounded: true }))).status, 202); assert.equal(f.calls.length, 1);
});

test('Browser HTTP: public errors retain safe codes and unknown outcome without private diagnostics', async t => {
  const privateMessage = 'private path C:/operator/key.txt https://private.invalid?token=secret';
  const f = await serving(t, { execute() { throw Object.assign(Error(privateMessage), { code: 'BROWSER_OPERATION_UNAVAILABLE',
    status: 503, writeMayHaveCommitted: true, details: { reason: privateMessage } }); } });
  const result = await f.request(root + '/browser-executions', post({}));
  assert.equal(result.status, 503); assert.equal(result.payload.code, 'BROWSER_OPERATION_UNAVAILABLE');
  assert.equal(result.payload.outcomeUnknown, true); assert.equal(JSON.stringify(result.payload).includes('private'), false);
  assert.equal(browserExecutionError(Object.assign(Error(privateMessage), { code: 'EXECUTION_BUSY' })).status, 409);
  assert.equal(browserExecutionError(Object.assign(Error(privateMessage), { code: 'EXECUTION_LEASE_INVALID' })).payload.code, 'BROWSER_EXECUTION_UNAVAILABLE');
  const unknown = browserExecutionError(Error(privateMessage)); assert.equal(unknown.status, 503);
  assert.equal(JSON.stringify(unknown).includes('private'), false);
});

test('Browser HTTP: error mapping never invokes accessors, proxies or coercion hooks', async t => {
  let hooks = 0;
  const trap = () => { hooks++; throw Error('private diagnostic must not escape'); };
  const accessors = Object.fromEntries(['code', 'status', 'writeMayHaveCommitted', 'currentGenerationId', 'currentRevision', 'details']
    .map(key => [key, { get: trap }]));
  const detailAccessors = Object.fromEntries(['generationId', 'revision', 'reason', 'limit'].map(key => [key, { get: trap }]));
  const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const cases = [Object.defineProperties({}, accessors), proxy, revoked.proxy,
    { code: { [Symbol.toPrimitive]: trap, toString: trap } },
    { code: 'INVALID_INPUT', status: 400, details: Object.defineProperties({}, detailAccessors) },
    { code: 'INVALID_INPUT', status: 400, details: proxy },
    Object.create(Object.defineProperties({}, accessors))];
  for (const cause of cases) {
    const mapped = browserExecutionError(cause);
    assert.ok([400, 503].includes(mapped.status)); assert.equal(hooks, 0);
    assert.equal(JSON.stringify(mapped).includes('private'), false);
  }
  const f = await serving(t, { list() { throw cases[0]; } });
  const result = await f.request(root + '/browser-executions');
  assert.equal(result.status, 503); assert.equal(result.payload.code, 'CATALOG_UNAVAILABLE'); assert.equal(hooks, 0);
  const stale = browserExecutionError({ code: 'STALE_REVISION', status: 409, details: { revision: 7, generationId: uid('ag', 9), reason: 'SOURCE_CHANGED' } });
  assert.equal(stale.status, 409); assert.equal(stale.payload.currentRevision, 7);
  assert.equal(stale.payload.currentGenerationId, uid('ag', 9));
});
