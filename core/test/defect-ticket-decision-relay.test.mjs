import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefectTicketDecisionRelay } from '../scripts/fixtures/defect-ticket-decision-relay.mjs';

const PROJECT = 'ap-11111111-1111-4111-8111-111111111111';
const ACTION = 'da-22222222-2222-4222-8222-222222222222';
const TICKET = 'dt-33333333-3333-4333-8333-333333333333';
const COLLECTION = `/api/acceptance/projects/${PROJECT}/defect-tickets`;
const ACTION_PATH = `${COLLECTION}/actions/${ACTION}`;
const BYTE_BUDGET = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const deferred = () => {
  let yes, no;
  const promise = new Promise((resolvePromise, rejectPromise) => { yes = resolvePromise; no = rejectPromise; });
  promise.catch(() => {}); return { promise, resolve: yes, reject: no };
};
async function until(fn, label, budget = 3000) {
  const end = Date.now() + budget;
  while (Date.now() < end) { if (fn()) return; await delay(5); }
  throw Error(label);
}
async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (server.listening) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
}
function nativeClient(url, { method = 'GET', body, headers = {} } = {}) {
  const received = deferred(), terminal = deferred(), chunks = [];
  const client = request(url, { method, agent: false, headers: { ...headers, ...(body ? { 'content-length': body.length } : {}) } });
  const result = { client, received: received.promise, terminal: terminal.promise, chunks, bytes: 0, ended: false };
  client.once('error', cause => { received.reject(cause); terminal.resolve({ kind: 'request-error', error: cause.message }); });
  client.once('response', response => {
    result.response = response;
    response.on('data', chunk => { chunks.push(Buffer.from(chunk)); result.bytes += chunk.length; });
    response.once('error', cause => terminal.resolve({ kind: 'response-error', error: cause.message }));
    response.once('aborted', () => terminal.resolve({ kind: 'response-aborted' }));
    response.once('end', () => {
      result.ended = true;
      terminal.resolve({ kind: 'finished', status: response.statusCode, headers: response.headers,
        complete: response.complete, body: Buffer.concat(chunks) });
    });
    received.resolve(response);
  });
  client.end(body); return result;
}
async function heldBeforeEnd(client) {
  await Promise.race([
    client.received.then(() => { throw Error('An action response became visible before native upstream end.'); }),
    delay(100),
  ]);
  assert.equal(client.bytes, 0);
}
async function fixture(t, handler) {
  const retained = process.env.HEIMDALL_FRAMING_TEST_OUT;
  const parent = resolve(retained || tmpdir()); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'native-relay-'));
  const logFile = join(root, 'relay.jsonl'), scopeFile = join(root, 'scope.json');
  writeFileSync(logFile, ''); writeFileSync(scopeFile, '{}\n');
  const requests = [], errors = [];
  const upstream = createServer((req, res) => {
    const readDone = deferred();
    const row = { method: req.method, path: req.url, chunks: [], ended: false, readDone: readDone.promise,
      responseClosed: false, responseErrors: [] };
    requests.push(row);
    req.on('data', chunk => row.chunks.push(Buffer.from(chunk)));
    req.on('end', () => { row.ended = true; row.body = Buffer.concat(row.chunks); readDone.resolve(row.body); });
    req.on('error', cause => { row.error = cause.message; });
    res.on('error', cause => row.responseErrors.push(cause.message));
    res.once('close', () => { row.responseClosed = true; });
    Promise.resolve().then(() => handler(req, res, row)).catch(cause => { errors.push(cause); res.destroy(); });
  });
  const engineBase = await listen(upstream);
  const relay = createDefectTicketDecisionRelay({ engineBase, scopeFile, logFile });
  const base = await listen(relay.server), clients = [];
  t.after(async () => {
    for (const value of clients) value.client.destroy();
    relay.abort(); await Promise.all([close(relay.server), close(upstream)]);
    if (!retained) {
      assert.equal(dirname(root), parent); assert(basename(root).startsWith('native-relay-'));
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, requests, errors, relay, open(path, options) { const value = nativeClient(base + path, options); clients.push(value); return value; },
    events: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
function assertSingleRequest(f, method, path) {
  assert.equal(f.errors.length, 0);
  assert.deepEqual(f.requests.map(value => [value.method, value.path]), [[method, path]]);
}
function assertSuccessEnd(f, path, reply) {
  assert.equal(reply.kind, 'finished'); assert.equal(reply.complete, true);
  const ends = f.events().filter(value => value.event === 'action-response-end' && value.path === path);
  assert.equal(ends.length, 1); assert.equal(ends[0].upstreamComplete, true);
  assert.equal(ends[0].status, reply.status); assert.equal(ends[0].bytes, reply.body.length); assert.equal(ends[0].bodySha256, hash(reply.body));
  assert.equal(f.events().filter(value => value.event === 'proxy-error').length, 0);
}
function assertFailedClosed(f, path, reply, prefix) {
  assert.equal(reply.kind, 'finished'); assert.equal(reply.complete, true); assert.equal(reply.status, 502);
  assert.equal(reply.body.includes(prefix), false);
  assert(f.events().some(value => value.event === 'proxy-error' && value.path === path));
  assert.equal(f.events().filter(value => value.event === 'action-response-end' && value.path === path).length, 0);
}

for (const status of [200, 409]) test(`action GET preserves native ${status}, exact UTF-8 bytes and headers after upstream end`, { timeout: 10000 }, async t => {
  const prefixWritten = deferred(), release = deferred();
  const prefix = Buffer.from('{"message":"原始字节'), tail = Buffer.from('保持一致","n":3}\n'), expected = Buffer.concat([prefix, tail]);
  const path = ACTION_PATH + '?token=native-contract';
  const f = await fixture(t, async (req, res) => {
    req.resume(); res.writeHead(status, { 'content-type': 'application/json', 'x-evidence-marker': 'preserved',
      connection: 'close, x-hop-marker', 'x-hop-marker': 'must-not-cross', 'cache-control': 'no-store' });
    res.write(prefix, () => prefixWritten.resolve()); await release.promise; res.end(tail);
  });
  const client = f.open(path); await prefixWritten.promise; await heldBeforeEnd(client); release.resolve();
  const reply = await client.terminal;
  assert.equal(reply.status, status); assert.deepEqual(reply.body, expected);
  assert.equal(reply.headers['content-type'], 'application/json'); assert.equal(reply.headers['x-evidence-marker'], 'preserved');
  assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['x-hop-marker'], undefined);
  assert.equal(reply.headers['transfer-encoding'], undefined); assert.equal(reply.headers['content-length'], String(expected.length));
  assertSingleRequest(f, 'GET', path); assertSuccessEnd(f, path, reply);
});

test('real held-original deny POST frames one real native response without replaying either request', { timeout: 10000 }, async t => {
  const denyPrefixWritten = deferred(), releaseDeny = deferred(), original = Buffer.from(JSON.stringify({ actionId: ACTION, ticketId: TICKET, description: 'native-only' }));
  const denyBody = Buffer.from('{"confirmed":true,"source":"native-only"}');
  const replyPrefix = Buffer.from('{"outcome":"rejected",'), replyTail = Buffer.from('"source":"真实上游"}'), expected = Buffer.concat([replyPrefix, replyTail]);
  const f = await fixture(t, async (req, res, row) => {
    if (req.url === COLLECTION) {
      await row.readDone;
      res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"outcome":"late-original"}'); return;
    }
    assert.equal(req.url, ACTION_PATH + '/deny');
    await row.readDone;
    res.writeHead(201, { 'content-type': 'application/json', 'x-native-deny': 'preserved' });
    res.write(replyPrefix, () => denyPrefixWritten.resolve()); await releaseDeny.promise; res.end(replyTail);
  });
  const state = f.relay.arm({ caseId: 'native-rejected', path: COLLECTION, intendedWinner: 'rejected' });
  const originalClient = f.open(COLLECTION, { method: 'POST', body: original, headers: { 'content-type': 'application/json' } });
  await state.originalReady.promise; state.sendControlled502(); assert.equal((await originalClient.terminal).status, 502);
  const denyClient = f.open(ACTION_PATH + '/deny', { method: 'POST', body: denyBody, headers: { 'content-type': 'application/json' } });
  await denyPrefixWritten.promise; await heldBeforeEnd(denyClient); releaseDeny.resolve();
  const reply = await denyClient.terminal;
  assert.equal(reply.status, 201); assert.deepEqual(reply.body, expected); assert.equal(reply.headers['x-native-deny'], 'preserved');
  assert.equal(reply.headers['content-length'], String(expected.length)); assert.equal(reply.headers['transfer-encoding'], undefined);
  await state.denyReply.promise; state.finishOriginal(); await state.slow.response;
  assert.equal(f.errors.length, 0);
  assert.deepEqual(f.requests.map(value => [value.method, value.path]), [['POST', COLLECTION], ['POST', ACTION_PATH + '/deny']]);
  assert.deepEqual(f.requests[0].body, original); assert.deepEqual(f.requests[1].body, denyBody);
  assertSuccessEnd(f, ACTION_PATH + '/deny', reply);
});

test('a non-action response remains observable as a stream before upstream end', { timeout: 10000 }, async t => {
  const written = deferred(), release = deferred(), prefix = Buffer.from('unframed-prefix-'), tail = Buffer.from('tail');
  const f = await fixture(t, async (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/plain', 'x-stream-marker': 'preserved' });
    res.write(prefix, () => written.resolve()); await release.promise; res.end(tail);
  });
  const client = f.open(COLLECTION); await written.promise; await client.received;
  await until(() => client.bytes === prefix.length, 'The ordinary response prefix did not stream while its upstream tail was held.');
  assert.equal(client.ended, false); assert.deepEqual(Buffer.concat(client.chunks), prefix);
  release.resolve(); const reply = await client.terminal;
  assert.equal(reply.kind, 'finished'); assert.deepEqual(reply.body, Buffer.concat([prefix, tail]));
  assert.equal(reply.headers['x-stream-marker'], 'preserved'); assertSingleRequest(f, 'GET', COLLECTION);
  assert.equal(f.events().filter(value => value.event === 'action-response-end').length, 0);
});

test('an action upstream abort sends no accepted prefix and retains a proxy failure', { timeout: 10000 }, async t => {
  const written = deferred(), abort = deferred(), prefix = Buffer.from('never-forward-this-partial-action-body');
  const f = await fixture(t, async (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'application/json' });
    res.write(prefix, () => written.resolve()); await abort.promise; res.destroy();
  });
  const client = f.open(ACTION_PATH); await written.promise; await heldBeforeEnd(client); abort.resolve();
  assertFailedClosed(f, ACTION_PATH, await client.terminal, prefix); assertSingleRequest(f, 'GET', ACTION_PATH);
});

test('a truncated declared action body fails closed instead of recomputing a successful short length', { timeout: 10000 }, async t => {
  const prefix = Buffer.from('truncated-native-response');
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'application/json', 'content-length': prefix.length + 1 }); res.end(prefix);
  });
  const reply = await f.open(ACTION_PATH).terminal;
  assertFailedClosed(f, ACTION_PATH, reply, prefix); assertSingleRequest(f, 'GET', ACTION_PATH);
});

function drainedOrClosed(res) {
  return new Promise(resolveReady => {
    const done = () => { res.removeListener('drain', done); res.removeListener('close', done); resolveReady(); };
    res.once('drain', done); res.once('close', done);
  });
}
test('an action body one byte beyond the 32 MiB contract fails closed with one upstream request', { timeout: 10000 }, async t => {
  const f = await fixture(t, async (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(65536, 0x78); let remaining = BYTE_BUDGET + 1;
    while (remaining > 0 && !res.destroyed) {
      const value = chunk.subarray(0, Math.min(chunk.length, remaining)); remaining -= value.length;
      if (!res.write(value)) await drainedOrClosed(res);
    }
    if (!res.destroyed) res.end();
  });
  const reply = await f.open(ACTION_PATH).terminal;
  assertFailedClosed(f, ACTION_PATH, reply, Buffer.from('xxxxxxxx')); assertSingleRequest(f, 'GET', ACTION_PATH);
});

test('downstream cancellation closes the sole native upstream before any successful action response', { timeout: 10000 }, async t => {
  const written = deferred(), upstreamClosed = deferred();
  const f = await fixture(t, (req, res) => {
    req.resume(); res.once('close', () => upstreamClosed.resolve());
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"held":', () => written.resolve());
  });
  const client = f.open(ACTION_PATH); await written.promise; await heldBeforeEnd(client); client.client.destroy();
  await upstreamClosed.promise; await client.terminal;
  assertSingleRequest(f, 'GET', ACTION_PATH);
  assert.equal(f.events().filter(value => value.event === 'action-response-end').length, 0);
  assert(f.events().some(value => value.event === 'proxy-error' && value.path === ACTION_PATH));
});
