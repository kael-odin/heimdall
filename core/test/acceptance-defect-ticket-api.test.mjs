import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { handleDefectTicketRequest, defectTicketError } from '../src/acceptance/defect-ticket-api.mjs';
import { DEFECT_TICKET_LIMITS } from '../src/acceptance/defect-ticket-schema.mjs';

const uid = (prefix, value) => prefix + '-00000000-0000-0000-0000-' + String(value).padStart(12, '0');
const projectId = uid('ap', 31), otherProjectId = uid('ap', 32), ticketId = uid('dt', 33), actionId = uid('da', 34);
const candidateId = uid('bc', 35), operationId = uid('bo', 36), root = '/api/acceptance/projects/' + projectId + '/defect-tickets';
const hash = 'a'.repeat(64), contentType = format => format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8';
const exportBytes = format => Buffer.from(format === 'md' ? '# 人工缺陷单\n固定关联检查。\n' : '{"kind":"manual-defect-ticket","scope":"declared-members"}\n');
const create = (overrides = {}) => ({ ticketId, actionId, sourceOperationId: operationId, memberCheckIds: ['check-a', 'check-b'],
  title: '移动端按钮不可用', severity: 'high', description: '按钮点击后目标未更新。', reproduction: '进入页面并点击按钮。', ...overrides });
const close = (overrides = {}) => ({ actionId, afterOperationId: uid('bo', 37), expectedRevision: 0, expectedHeadSha256: hash,
  memberSetDigest: hash, factsDigest: hash, previewDigest: hash, resolution: '已修复并核对关联检查。', confirmed: true, ...overrides });
const post = value => ({ method: 'POST', body: Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value),
  headers: { 'content-type': 'application/json' } });

async function serving(t, overrides = {}) {
  const calls = [], escapes = []; let forbidden = 0;
  const defaults = {
    list: (...args) => ({ method: 'list', args }), sources: (...args) => ({ method: 'sources', args }),
    read: (...args) => ({ method: 'read', args }), previewClose: (...args) => ({ method: 'previewClose', args }),
    create: async () => ({ status: 201, payload: { outcome: 'recorded', ticketId, actionId } }),
    close: async () => ({ status: 201, payload: { outcome: 'recorded', ticketId, actionId } }),
    action: (project, action) => ({ projectId: project, actionId: action, outcome: 'unresolved', reason: 'ABSENCE_IS_NOT_A_COMMIT_DECISION' }),
    exportTicket: (_project, ticket, format) => ({ bytes: exportBytes(format), filename: ticket + '.' + format, contentType: contentType(format) }),
  };
  const service = Object.fromEntries(Object.entries(defaults).map(([name, handler]) => [name, (...args) => {
    calls.push({ method: name, args }); return (overrides[name] ?? handler)(...args);
  }]));
  for (const name of ['execute', 'launch', 'registerResult', 'recover', 'repair', 'mutateCatalog']) {
    Object.defineProperty(service, name, { get() { forbidden++; throw Error('execution is forbidden in this router'); } });
  }
  const server = createServer(async (req, res) => {
    const json = (response, status, payload) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)); };
    try {
      const handled = await handleDefectTicketRequest(req, res, new URL(req.url, 'http://fixture'), { service, json });
      if (!handled) json(res, 404, { code: 'FALLTHROUGH' });
    } catch (cause) { escapes.push(cause); if (!res.destroyed && !res.writableEnded) json(res, 500, { code: 'ROUTER_ESCAPED' }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(escapes, []); assert.equal(forbidden, 0);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { calls, base, async request(path, options = {}) {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      payload: options.method === 'HEAD' || !response.headers.get('content-type')?.includes('application/json') ? null : JSON.parse(bytes.toString()) };
  } };
}

function chunked(base, path, chunks) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: 'POST', headers: { 'content-type': 'application/json; charset="utf-8"' } }, res => {
      const received = []; res.on('data', chunk => received.push(chunk)); res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(received).toString()) }));
    });
    req.once('error', reject); req.setTimeout(5000, () => req.destroy(Error('fixture request timeout')));
    const next = index => { if (index === chunks.length) req.end(); else { req.write(chunks[index]); setImmediate(() => next(index + 1)); } };
    next(0);
  });
}

test('Defect-ticket HTTP: literal routes and each explicit service action preserve exact project and ID arguments', async t => {
  const f = await serving(t), after = close().afterOperationId;
  const routes = [
    [root, {}, 'list', [projectId]],
    [root + '/sources?candidateId=' + candidateId + '&token=authenticated-elsewhere', {}, 'sources', [projectId, candidateId]],
    [root + '/actions/' + actionId, {}, 'action', [projectId, actionId]],
    [root + '/' + ticketId, {}, 'read', [projectId, ticketId]],
    [root + '/' + ticketId + '/close-preview?afterOperationId=' + after, {}, 'previewClose', [projectId, ticketId, after]],
    [root + '?token=authenticated-elsewhere', post(create()), 'create', [projectId, create()]],
    [root + '/' + ticketId + '/close', post(close()), 'close', [projectId, ticketId, close()]],
  ];
  for (const [path, options, method, args] of routes) {
    const result = await f.request(path, options);
    assert.equal(result.status, ['create', 'close'].includes(method) ? 201 : 200, path);
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(f.calls.at(-1), { method, args });
  }
  assert.equal(f.calls.length, routes.length);
  const foreign = root.replace(projectId, otherProjectId);
  assert.equal((await f.request(foreign + '/' + ticketId)).status, 200);
  assert.deepEqual(f.calls.at(-1), { method: 'read', args: [otherProjectId, ticketId] });
  assert.equal((await f.request(foreign, post(create({ ticketId: uid('dt', 40), actionId: uid('da', 41) })))).status, 201);
  assert.deepEqual(f.calls.at(-1).args, [otherProjectId, create({ ticketId: uid('dt', 40), actionId: uid('da', 41) })]);
});

test('Defect-ticket HTTP: a missing action remains unresolved through repeated reads with zero writes or execution', async t => {
  const f = await serving(t), path = root + '/actions/' + actionId;
  for (let index = 0; index < 3; index++) {
    const result = await f.request(path + '?token=local-auth');
    assert.equal(result.status, 200); assert.equal(result.payload.outcome, 'unresolved');
    assert.equal(result.payload.reason, 'ABSENCE_IS_NOT_A_COMMIT_DECISION');
    assert.equal(Object.hasOwn(result.payload, 'recorded'), false);
  }
  assert.deepEqual(f.calls, Array.from({ length: 3 }, () => ({ method: 'action', args: [projectId, actionId] })));
  const recorded = await serving(t, { action: (project, action) => ({ outcome: 'recorded', projectId: project, actionId: action }) });
  assert.equal((await recorded.request(path)).payload.outcome, 'recorded');
  assert.deepEqual(recorded.calls, [{ method: 'action', args: [projectId, actionId] }]);
});

test('Defect-ticket HTTP: exact methods, Allow headers, malformed IDs, unknown routes and namespaces cannot dispatch', async t => {
  const f = await serving(t), cases = [
    [root, { method: 'PUT' }, 405, 'GET, POST'], [root, { method: 'HEAD' }, 405, 'GET, POST'],
    [root + '/sources?candidateId=' + candidateId, post(create()), 405, 'GET'],
    [root + '/actions/' + actionId, post(create()), 405, 'GET'],
    [root + '/' + ticketId, post(create()), 405, 'GET'],
    [root + '/' + ticketId + '/close-preview?afterOperationId=' + operationId, post(close()), 405, 'GET'],
    [root + '/' + ticketId + '/close', {}, 405, 'POST'],
    [root + '/' + ticketId + '/export.md', post(create()), 405, 'GET'],
    [root + '/' + ticketId + '/export.json', { method: 'DELETE' }, 405, 'GET'],
    [root + '/sources/extra', {}, 404], [root + '/actions/' + actionId + '/extra', {}, 404],
    [root + '/' + ticketId + '/edit', post(create()), 404], [root + '/' + ticketId + '/close/extra', post(close()), 404],
    [root + '/' + ticketId + '/export.JSON', {}, 404], [root + '/actions', {}, 400],
    [root + '/actions/' + ticketId, {}, 400], [root + '/' + actionId, {}, 400],
    [root + '/' + ticketId.toUpperCase(), {}, 400], [root + '/dt-invalid/close', post(close()), 400],
    [root + '/%64t-' + ticketId.slice(3), {}, 400], [root + '/%2e%2e%2fprivate', {}, 400],
    [root.replace(projectId, 'ap-invalid'), {}, 400], [root + '/', {}, 400],
  ];
  for (const [path, options, status, allow] of cases) {
    const result = await f.request(path, options); assert.equal(result.status, status, path);
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    if (options.method !== 'HEAD') assert.equal(result.payload.outcomeUnknown, false, path);
    if (allow) assert.equal(result.headers.get('allow'), allow, path);
  }
  for (const path of [root.replace('defect-tickets', 'browser-executions'), root + '-other', '/api/other/projects/' + projectId + '/defect-tickets']) {
    assert.equal((await f.request(path)).payload.code, 'FALLTHROUGH');
  }
  assert.equal(f.calls.length, 0);
});

test('Defect-ticket HTTP: required selectors and every repeated or unknown query are rejected before service access', async t => {
  const f = await serving(t), candidate = 'candidateId=' + candidateId, after = 'afterOperationId=' + operationId;
  const cases = [
    [root + '?unknown=x'], [root + '?candidateId=' + candidateId], [root + '?token=a&token=b'], [root + '?token=a&%74oken=b'],
    [root + '/sources'], [root + '/sources?candidateId='], [root + '/sources?' + candidate + '&' + candidate],
    [root + '/sources?candidateId=' + ticketId], [root + '/sources?' + candidate + '&contentDigest=' + hash],
    [root + '/sources?' + candidate + '&token=a&token=b'], [root + '/sources?' + candidate + '&projectId=' + otherProjectId],
    [root + '/actions/' + actionId + '?candidateId=' + candidateId],
    [root + '/' + ticketId + '?afterOperationId=' + operationId],
    [root + '/' + ticketId + '/close-preview'], [root + '/' + ticketId + '/close-preview?afterOperationId='],
    [root + '/' + ticketId + '/close-preview?' + after + '&' + after],
    [root + '/' + ticketId + '/close-preview?afterOperationId=' + candidateId],
    [root + '/' + ticketId + '/close-preview?' + after + '&previewDigest=' + hash],
    [root + '/' + ticketId + '/export.md?filename=private.md'], [root + '/' + ticketId + '/export.json?format=md'],
    [root + '?unknown=x', post(create())], [root + '/' + ticketId + '/close?unknown=x', post(close())],
  ];
  for (const [path, options] of cases) assert.equal((await f.request(path, options)).status, 400, path);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(root + '?token=one')).status, 200);
  assert.deepEqual(f.calls, [{ method: 'list', args: [projectId] }]);
});

test('Defect-ticket HTTP: strict schema fields and IDs cannot smuggle client facts or cross-project body selectors', async t => {
  const f = await serving(t);
  const creates = [create({ projectId: otherProjectId }), create({ candidateId }), create({ contentDigest: hash }),
    create({ passed: true }), create({ members: [{ checkId: 'check-a', identity: 'client-fact' }] }),
    create({ ticketId: actionId }), create({ actionId: ticketId }), create({ sourceOperationId: candidateId }),
    create({ memberCheckIds: [] }), create({ memberCheckIds: ['check-a', 'check-a'] }),
    create({ memberCheckIds: Array.from({ length: 25 }, (_, index) => 'check-' + index) }),
    create({ severity: 'urgent' }), create({ description: '' }), create({ title: 'a'.repeat(241) })];
  for (const value of creates) assert.equal((await f.request(root, post(value))).status, 400);
  const closes = [close({ projectId: otherProjectId }), close({ ticketId: uid('dt', 40) }), close({ confirmed: false }),
    close({ expectedRevision: -1 }), close({ expectedHeadSha256: 'bad' }), close({ afterOperationId: candidateId }),
    close({ memberSetDigest: undefined }), close({ facts: [] }), close({ resolution: '' })];
  for (const value of closes) assert.equal((await f.request(root + '/' + ticketId + '/close', post(value))).status, 400);
  assert.equal(f.calls.length, 0);
  const unsorted = create({ memberCheckIds: ['check-b', 'check-a'] });
  assert.equal((await f.request(root, post(unsorted))).status, 201);
  assert.deepEqual(f.calls[0].args, [projectId, create()]);
});

test('Defect-ticket HTTP: malformed JSON, object-only payloads, fatal UTF-8 and unsupported MIME never reach a writer', async t => {
  const f = await serving(t), paths = [root, root + '/' + ticketId + '/close'];
  const malformed = ['', '{', 'null', '[]', '"text"', '0', 'true', '{}\n{}',
    Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(create()))]),
    Buffer.from('{"title":"\xff"}', 'latin1')];
  for (const path of paths) for (const value of malformed) assert.equal((await f.request(path, post(value))).status, 400);
  for (const value of ['', 'text/plain', 'application/problem+json', 'application/json; charset=latin1',
    'application/json; charset=utf-8; charset=utf-8', 'application/json; unknown=true']) {
    assert.equal((await f.request(root, { ...post(create()), headers: { 'content-type': value } })).status, 400, value);
  }
  assert.equal((await f.request(root, { ...post(create()), headers: {} })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(root, { ...post(create()), headers: { 'content-type': 'Application/JSON; Charset=UTF-8' } })).status, 201);
  assert.equal(f.calls.length, 1);
});

function atByteLimit() {
  const value = create({ title: 'x', description: '界'.repeat(4000), reproduction: '界'.repeat(4000),
    memberCheckIds: Array.from({ length: 24 }, (_, index) => 'check-' + String(index).padStart(2, '0') + '-' + '界'.repeat(80)) });
  let remaining = DEFECT_TICKET_LIMITS.requestBytes - Buffer.byteLength(JSON.stringify(value));
  assert.ok(remaining > 0);
  for (let index = 0; index < value.memberCheckIds.length; index++) {
    const count = Math.min(240 - value.memberCheckIds[index].length, remaining);
    value.memberCheckIds[index] += 'x'.repeat(count); remaining -= count;
  }
  assert.equal(remaining, 0);
  const bytes = Buffer.from(JSON.stringify(value)); assert.equal(bytes.length, 32 * 1024);
  return { value, bytes };
}

test('Defect-ticket HTTP: 32 KiB uses raw UTF-8 bytes across chunks and accepts the exact inclusive boundary', async t => {
  const f = await serving(t), exact = atByteLimit(), split = exact.bytes.indexOf(Buffer.from('界')) + 1;
  const accepted = await chunked(f.base, root, [exact.bytes.subarray(0, split), exact.bytes.subarray(split)]);
  assert.equal(accepted.status, 201); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, [projectId, exact.value]);
  const oversized = { ...exact.value, memberCheckIds: [...exact.value.memberCheckIds] };
  oversized.memberCheckIds[23] += 'x';
  const bytes = Buffer.from(JSON.stringify(oversized)); assert.equal(bytes.length, 32769);
  assert.equal((await chunked(f.base, root, [bytes.subarray(0, 10000), bytes.subarray(10000, 20000), bytes.subarray(20000)])).status, 413);
  assert.equal((await f.request(root + '/' + ticketId + '/close', post(JSON.stringify({ padding: '界'.repeat(11000) })))).status, 413);
  assert.equal(f.calls.length, 1);
});

test('Defect-ticket HTTP: exports return exact bytes with fixed safe filenames, content types and download controls', async t => {
  const f = await serving(t);
  for (const format of ['md', 'json']) {
    const result = await f.request(root + '/' + ticketId + '/export.' + format + '?token=local-auth');
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('content-type'), contentType(format));
    assert.equal(result.headers.get('content-disposition'), 'attachment; filename="' + ticketId + '.' + format + '"');
    assert.equal(result.headers.get('content-length'), String(exportBytes(format).length));
    assert.deepEqual(result.bytes, exportBytes(format));
    assert.deepEqual(f.calls.at(-1), { method: 'exportTicket', args: [projectId, ticketId, format] });
  }
  assert.equal(f.calls.length, 2);
});

test('Defect-ticket HTTP: untrusted download metadata cannot inject paths, headers or a different artifact', async t => {
  let hooks = 0;
  const trap = () => { hooks++; throw Error('private download metadata'); };
  const original = { bytes: exportBytes('md'), filename: ticketId + '.md', contentType: contentType('md') };
  const malformed = [{ ...original, filename: '../private.md' }, { ...original, filename: 'private\r\nX-Secret: value' },
    { ...original, filename: uid('dt', 88) + '.md' }, { ...original, contentType: 'text/html' }, { ...original, bytes: 'private' },
    Object.defineProperty({ ...original }, 'filename', { get: trap }),
    new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap })];
  for (const artifact of malformed) {
    const f = await serving(t, { exportTicket: () => artifact }), result = await f.request(root + '/' + ticketId + '/export.md');
    assert.equal(result.status, 503); assert.equal(result.payload.code, 'INTEGRITY_BLOCKED');
    assert.equal(result.headers.get('content-disposition'), null); assert.equal(result.headers.get('x-secret'), null);
    assert.equal(result.bytes.includes(Buffer.from('private')), false); assert.equal(hooks, 0);
  }
});

test('Defect-ticket HTTP: fixed error statuses ignore private messages, details, coercion and caller status overrides', async t => {
  const privateMessage = 'C:/operator/private/key.txt https://private.invalid/?token=secret Authorization: Bearer hidden';
  const statuses = { INVALID_INPUT: 400, NOT_FOUND: 404, STALE_TICKET: 409, STALE_FACTS: 409, ACTION_CONFLICT: 409,
    SOURCE_NOT_ELIGIBLE: 409, CAPACITY: 503, INTEGRITY_BLOCKED: 503, ACCEPTANCE_OWNER_UNAVAILABLE: 503, ACCEPTANCE_OWNER_LOST: 503 };
  for (const [code, status] of Object.entries(statuses)) {
    const cause = Object.assign(Error(privateMessage), { code, status: 418, details: { reason: privateMessage }, stack: privateMessage });
    const f = await serving(t, { list() { throw cause; } }), result = await f.request(root);
    assert.equal(result.status, status, code); assert.equal(result.payload.code, code);
    assert.equal(JSON.stringify(result.payload).includes('private'), false); assert.equal(Object.hasOwn(result.payload, 'details'), false);
    assert.equal(Object.hasOwn(result.payload, 'stack'), false); assert.equal(result.payload.outcomeUnknown, false);
  }
  assert.equal(defectTicketError({ code: 'INVALID_INPUT', status: 413 }).status, 413);
  assert.equal(defectTicketError({ code: 'INVALID_INPUT', status: '413' }).status, 400);
  for (const cause of [Error(privateMessage), { code: 'PRIVATE_ERROR', status: 400 }, null, undefined, 'private', 0]) {
    const mapped = defectTicketError(cause); assert.equal(mapped.status, 503); assert.equal(mapped.payload.code, 'INTEGRITY_BLOCKED');
    assert.equal(JSON.stringify(mapped).includes('private'), false);
  }
});

test('Defect-ticket HTTP: error extraction uses own descriptors without accessors, proxy traps or primitive conversion', async t => {
  let hooks = 0;
  const trap = () => { hooks++; throw Error('private getter'); };
  const accessors = Object.fromEntries(['code', 'status', 'writeMayHaveCommitted', 'details', 'message', 'stack'].map(key => [key, { get: trap }]));
  const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const cases = [Object.defineProperties({}, accessors), Object.create(Object.defineProperties({}, accessors)), proxy, revoked.proxy,
    { code: { [Symbol.toPrimitive]: trap, toString: trap }, status: { valueOf: trap } },
    { code: 'STALE_FACTS', details: proxy }, Object.defineProperty({ code: 'INVALID_INPUT' }, 'status', { get: trap }),
    Object.defineProperty({ code: 'INTEGRITY_BLOCKED' }, 'writeMayHaveCommitted', { get: trap })];
  for (const cause of cases) {
    const mapped = defectTicketError(cause); assert.ok([400, 409, 503].includes(mapped.status)); assert.equal(hooks, 0);
    assert.equal(JSON.stringify(mapped).includes('private'), false);
    const f = await serving(t, { list() { throw cause; } }), result = await f.request(root);
    assert.equal(result.status, mapped.status); assert.deepEqual(result.payload, mapped.payload); assert.equal(hooks, 0);
  }
  const inherited = defectTicketError(Object.create({ code: 'NOT_FOUND', writeMayHaveCommitted: true }));
  assert.equal(inherited.payload.code, 'INTEGRITY_BLOCKED'); assert.equal(inherited.payload.outcomeUnknown, false);
});

test('Defect-ticket HTTP: uncertain create and close writes preserve outcomeUnknown and only query the original action', async t => {
  for (const method of ['create', 'close']) {
    let committed = 0;
    const f = await serving(t, { [method]: async () => { committed++; await Promise.resolve();
      throw Object.assign(Error('private write completed but readback failed'), { code: 'INTEGRITY_BLOCKED', writeMayHaveCommitted: true }); } });
    const path = method === 'create' ? root : root + '/' + ticketId + '/close';
    const failed = await f.request(path, post(method === 'create' ? create() : close()));
    assert.equal(failed.status, 503); assert.equal(failed.payload.code, 'INTEGRITY_BLOCKED'); assert.equal(failed.payload.outcomeUnknown, true);
    assert.equal(failed.bytes.includes(Buffer.from('private')), false); assert.equal(committed, 1);
    const receipt = await f.request(root + '/actions/' + actionId);
    assert.equal(receipt.status, 200); assert.equal(receipt.payload.outcome, 'unresolved'); assert.equal(committed, 1);
    assert.deepEqual(f.calls.map(call => call.method), [method, 'action']);
    assert.deepEqual(f.calls.at(-1).args, [projectId, actionId]);
  }
  const unknown = defectTicketError({ code: 'PRIVATE_WRITE_ERROR', writeMayHaveCommitted: true });
  assert.equal(unknown.status, 503); assert.equal(unknown.payload.code, 'INTEGRITY_BLOCKED'); assert.equal(unknown.payload.outcomeUnknown, true);
  assert.equal(defectTicketError({ code: 'INTEGRITY_BLOCKED', writeMayHaveCommitted: 'true' }).payload.outcomeUnknown, false);
});

test('Defect-ticket HTTP: every rejected original POST explicitly states whether its write may have committed', async t => {
  for (const method of ['create', 'close']) for (const [code, status] of [
    ['INVALID_INPUT', 400], ['NOT_FOUND', 404], ['ACTION_CONFLICT', 409], ['SOURCE_NOT_ELIGIBLE', 409], ['STALE_FACTS', 409],
  ]) for (const uncertain of [false, true]) {
    const f = await serving(t, { [method]: async () => { throw Object.assign(Error('private rejection'),
      { code, writeMayHaveCommitted: uncertain }); } });
    const path = method === 'create' ? root : root + '/' + ticketId + '/close';
    const result = await f.request(path, post(method === 'create' ? create() : close()));
    assert.equal(result.status, status); assert.equal(result.payload.code, code);
    assert.equal(result.payload.outcomeUnknown, uncertain);
    assert.deepEqual(f.calls.map(call => call.method), [method]);
  }
  for (const cause of [undefined, null, {}, { code: 'PRIVATE' }, { code: 'INVALID_INPUT' },
    { code: 'INVALID_INPUT', writeMayHaveCommitted: 'true' }]) {
    assert.equal(defectTicketError(cause).payload.outcomeUnknown, false);
  }
});

test('Defect-ticket HTTP: replayed writer receipts retain the service status and original recorded fact', async t => {
  const receipt = { outcome: 'recorded', ticketId, actionId, replayed: true, eventSha256: hash };
  const f = await serving(t, { create: async () => ({ status: 200, payload: receipt }), close: async () => ({ status: 200, payload: receipt }) });
  assert.deepEqual((await f.request(root, post(create()))).payload, receipt);
  const replayed = await f.request(root + '/' + ticketId + '/close', post(close()));
  assert.equal(replayed.status, 200); assert.deepEqual(replayed.payload, receipt);
  assert.deepEqual(f.calls.map(call => call.method), ['create', 'close']);
});

test('Defect-ticket HTTP: an actual disconnected create response is reconciled only by its original action read', { timeout: 5000 }, async t => {
  let committed = 0, announceCommit, releaseResponse;
  const didCommit = new Promise(resolve => { announceCommit = resolve; });
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  const receipt = { projectId, ticketId, actionId, outcome: 'recorded', eventSha256: hash };
  const f = await serving(t, {
    create: async () => { committed++; announceCommit(); await responseGate; return { status: 201, payload: receipt }; },
    action: () => receipt,
  });
  const client = httpRequest(f.base + root, { method: 'POST', headers: { 'content-type': 'application/json' } });
  client.on('error', () => {});
  const disconnected = new Promise(resolve => client.once('close', resolve));
  t.after(() => { client.destroy(); releaseResponse(); });
  client.end(JSON.stringify(create()));
  await didCommit;
  client.destroy(); await disconnected; releaseResponse();
  const reconciled = await f.request(root + '/actions/' + actionId);
  assert.equal(reconciled.status, 200); assert.deepEqual(reconciled.payload, receipt);
  assert.equal(committed, 1); assert.deepEqual(f.calls.map(call => call.method), ['create', 'action']);
  assert.deepEqual(f.calls.at(-1).args, [projectId, actionId]);
});
