import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance, SpecAcceptanceControlError, isSpecAcceptanceControlError } from '../src/acceptance/spec-runner.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const contract = (id, path = '/healthy', method = 'GET') => ({ id, path, method, title: id, severity: 'high',
  expect: method === 'HEAD' ? { status: 200, contentType: 'application/json' }
    : { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } });
const plan = (targetUrl, checks = [contract('first'), contract('second')], extra = {}) => normalizeSpecPlan({
  mode: 'spec', name: '受控只读验收', targetUrl, timeoutMs: 30000,
  spec: { source: { id: 'REQ-CONTROL', revision: 'v1', type: 'manual' }, approved: true, checks }, ...extra,
});
const controlError = (code, cause) => error => {
  assert.ok(error instanceof SpecAcceptanceControlError);
  assert.equal(isSpecAcceptanceControlError(error), true);
  assert.equal(error.code, code);
  if (cause !== undefined) assert.equal(error.cause, cause);
  return true;
};
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'heimdall-spec-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, outputDir: join(root, 'evidence') };
}
async function fixture(t) {
  const requests = [], arrivals = new Map(), closed = new Map();
  const gate = (collection, path) => {
    if (!collection.has(path)) collection.set(path, deferred());
    return collection.get(path);
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture.local').pathname;
    requests.push({ path, method: req.method });
    res.once('close', () => gate(closed, path).resolve());
    gate(arrivals, path).resolve();
    if (path === '/pending-headers') return;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    if (path === '/stream') { res.flushHeaders(); res.write('{"code":'); return; }
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(JSON.stringify({ code: path === '/bug' ? 400 : 0 }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { targetUrl: `http://127.0.0.1:${server.address().port}`, requests,
    arrived: path => gate(arrivals, path).promise, closed: path => gate(closed, path).promise };
}
function externalSignalCounts(t, signal) {
  const add = signal.addEventListener, remove = signal.removeEventListener;
  const counts = { added: 0, removed: 0 };
  t.mock.method(signal, 'addEventListener', function (kind, ...args) {
    if (kind === 'abort') counts.added++;
    return add.call(this, kind, ...args);
  });
  t.mock.method(signal, 'removeEventListener', function (kind, ...args) {
    if (kind === 'abort') counts.removed++;
    return remove.call(this, kind, ...args);
  });
  return counts;
}
function heartbeatClock(t) {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const state = { callback: null, clears: 0, unrefs: 0 };
  const handle = { unref() { state.unrefs++; } };
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    if (ms !== 30000) return realSet(callback, ms, ...args);
    assert.equal(state.callback, null);
    state.callback = callback;
    return handle;
  });
  t.mock.method(globalThis, 'clearInterval', value => {
    if (value === handle) { state.clears++; return; }
    return realClear(value);
  });
  return { state, tick() { assert.ok(state.callback); state.callback(); } };
}

test('pre-aborted control performs no directory, event, guard or target side effects', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), controller = new AbortController();
  const reason = new Error('caller cancelled before admission'); controller.abort(reason);
  let events = 0, guards = 0;
  await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, signal: controller.signal,
    assertActive() { guards++; }, onEvent() { events++; } }), controlError('SPEC_ACCEPTANCE_ABORTED', reason));
  assert.equal(existsSync(outputDir), false);
  assert.equal(events, 0); assert.equal(guards, 0); assert.deepEqual(api.requests, []);
  assert.equal(isSpecAcceptanceControlError(new Error('ordinary')), false);
  assert.equal(isSpecAcceptanceControlError({ code: 'SPEC_ACCEPTANCE_ABORTED' }), false);
});

test('a synchronous initial guard failure is a control error before any output', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), cause = new Error('owner lost');
  await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, assertActive() { throw cause; } }),
    controlError('SPEC_ACCEPTANCE_GUARD_FAILED', cause));
  assert.equal(existsSync(outputDir), false); assert.deepEqual(api.requests, []);
});

test('accidental native async guards reject before effects and consume rejected promises', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), unhandled = [];
  const rejection = new Error('accidental async owner check');
  const listener = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', listener); t.after(() => process.removeListener('unhandledRejection', listener));
  for (const assertActive of [async () => { throw rejection; }, () => Promise.reject(rejection), () => Promise.resolve(true)]) {
    await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, assertActive }), controlError('SPEC_ACCEPTANCE_ASYNC_GUARD'));
  }
  await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, assertActive: Promise.reject(rejection) }),
    controlError('SPEC_ACCEPTANCE_INVALID_CONTROL'));
  await turn(); await turn();
  assert.deepEqual(unhandled, []); assert.equal(existsSync(outputDir), false); assert.deepEqual(api.requests, []);
});

test('rejected guard objects never evaluate then, constructor or species accessors', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t);
  let accesses = 0;
  const accessor = () => { accesses++; throw new Error('untrusted getter'); };
  const thenable = Object.defineProperty({}, 'then', { get: accessor });
  const constructorPromise = Object.defineProperty(Promise.resolve(), 'constructor', { get: accessor });
  class OtherPromise extends Promise { static get [Symbol.species]() { return accessor(); } }
  const subclass = new OtherPromise(resolve => resolve());
  const ownThen = Object.defineProperty(Promise.reject(new Error('native with own then')), 'then', { get: accessor });
  const proxy = new Proxy({}, { get: accessor, getPrototypeOf: accessor, ownKeys: accessor });
  for (const value of [thenable, constructorPromise, subclass, ownThen, proxy]) {
    await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, assertActive: () => value }),
      controlError('SPEC_ACCEPTANCE_ASYNC_GUARD'));
  }
  await turn();
  assert.equal(accesses, 0); assert.equal(existsSync(outputDir), false); assert.deepEqual(api.requests, []);
});

test('external abort interrupts a real pending HTTP response and prevents all later contracts', { timeout: 5000 }, async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), controller = new AbortController();
  const events = [], counts = externalSignalCounts(t, controller.signal);
  const run = runSpecAcceptance(plan(api.targetUrl, [contract('first', '/pending-headers'), contract('second')]),
    { outputDir, signal: controller.signal, onEvent: event => events.push(event.kind) });
  const rejected = assert.rejects(run, controlError('SPEC_ACCEPTANCE_ABORTED'));
  await api.arrived('/pending-headers'); controller.abort(); await rejected; await api.closed('/pending-headers');
  assert.deepEqual(api.requests, [{ path: '/pending-headers', method: 'GET' }]);
  assert.deepEqual(events, ['acceptance-started']);
  assert.deepEqual((await readdir(outputDir)).sort(), ['spec-1-first-contract.json', 'spec-1-first-request.json']);
  assert.deepEqual(counts, { added: 1, removed: 1 });
});

test('external abort interrupts a real streamed body while its next read is pending', { timeout: 5000 }, async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), controller = new AbortController();
  const realFetch = globalThis.fetch, nextRead = deferred();
  t.mock.method(globalThis, 'fetch', async (...args) => {
    const response = await realFetch(...args), getReader = response.body.getReader.bind(response.body);
    t.mock.method(response.body, 'getReader', (...readerArgs) => {
      const reader = getReader(...readerArgs), read = reader.read.bind(reader);
      let reads = 0;
      t.mock.method(reader, 'read', (...readArgs) => { if (++reads === 2) nextRead.resolve(); return read(...readArgs); });
      return reader;
    });
    return response;
  });
  const events = [];
  const run = runSpecAcceptance(plan(api.targetUrl, [contract('first', '/stream'), contract('second')]),
    { outputDir, signal: controller.signal, onEvent: event => events.push(event.kind) });
  const rejected = assert.rejects(run, controlError('SPEC_ACCEPTANCE_ABORTED'));
  await nextRead.promise; controller.abort(); await rejected; await api.closed('/stream');
  assert.deepEqual(api.requests, [{ path: '/stream', method: 'GET' }]);
  assert.deepEqual(events, ['acceptance-started']);
  assert.equal((await readdir(outputDir)).some(file => file.endsWith('-response.json')), false);
});

test('post-fetch guard failure stays sticky and cannot become a transport verdict', { timeout: 5000 }, async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), realFetch = globalThis.fetch;
  const cause = new Error('owner changed after await'); let failNext = false, failed = false;
  t.mock.method(globalThis, 'fetch', async (...args) => { const response = await realFetch(...args); failNext = true; return response; });
  const events = [];
  await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, assertActive() {
    if (failNext) { failNext = false; failed = true; throw cause; }
  }, onEvent: event => events.push(event.kind) }), controlError('SPEC_ACCEPTANCE_GUARD_FAILED', cause));
  assert.equal(failed, true); assert.equal(failNext, false);
  assert.deepEqual(api.requests, [{ path: '/healthy', method: 'GET' }]);
  assert.deepEqual(events, ['acceptance-started']);
  assert.equal((await readdir(outputDir)).some(file => file.endsWith('-response.json')), false);
});

test('an already-started evidence write remains but its failed fence permits no next side effect', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), cause = new Error('fence lost after write');
  const events = [];
  await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, assertActive() {
    if (existsSync(join(outputDir, 'spec-1-first-contract.json'))) throw cause;
  }, onEvent: event => events.push(event.kind) }), controlError('SPEC_ACCEPTANCE_GUARD_FAILED', cause));
  assert.deepEqual(await readdir(outputDir), ['spec-1-first-contract.json']);
  assert.deepEqual(events, ['acceptance-started']); assert.deepEqual(api.requests, []);
});

test('onEvent backpressure rechecks the guard before creating any contract or request', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), entered = deferred(), release = deferred();
  const cause = new Error('owner lost while event was pending'); let active = true;
  const run = runSpecAcceptance(plan(api.targetUrl), { outputDir, assertActive() { if (!active) throw cause; },
    onEvent(event) { assert.equal(event.kind, 'acceptance-started'); entered.resolve(); return release.promise; } });
  const rejected = assert.rejects(run, controlError('SPEC_ACCEPTANCE_GUARD_FAILED', cause));
  await entered.promise; active = false; release.resolve(); await rejected;
  assert.deepEqual(await readdir(outputDir), []); assert.deepEqual(api.requests, []);
});

for (const kind of ['acceptance-started', 'acceptance-completed']) {
  test(`external abort wakes a pending ${kind} callback and consumes its late rejection`, { timeout: 5000 }, async t => {
    const { outputDir } = await workspace(t), api = await fixture(t), entered = deferred(), release = deferred();
    const controller = new AbortController(), counts = externalSignalCounts(t, controller.signal), events = [];
    const run = runSpecAcceptance(plan(api.targetUrl, [contract('first')]), { outputDir, signal: controller.signal,
      onEvent(event) { events.push(event.kind); if (event.kind === kind) { entered.resolve(); return release.promise; } } });
    const rejected = assert.rejects(run, controlError('SPEC_ACCEPTANCE_ABORTED'));
    await entered.promise; controller.abort(); await rejected;
    assert.deepEqual(counts, { added: 1, removed: 1 });
    assert.equal(api.requests.length, kind === 'acceptance-started' ? 0 : 1);
    assert.equal(events.at(-1), kind);
    release.reject(new Error('late callback failure must be consumed')); await turn();
  });
}

test('an event rejection cannot replace an earlier external cancellation', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), controller = new AbortController();
  const cause = new Error('cancel reason');
  await assert.rejects(runSpecAcceptance(plan(api.targetUrl), { outputDir, signal: controller.signal,
    onEvent() { controller.abort(cause); throw new Error('later callback error'); } }), controlError('SPEC_ACCEPTANCE_ABORTED', cause));
  assert.deepEqual(api.requests, []); assert.deepEqual(await readdir(outputDir), []);
});

test('heartbeat stays single-flight, still checks the guard, stops and aborts pending HTTP', { timeout: 5000 }, async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), clock = heartbeatClock(t), release = deferred();
  let active = true, guards = 0, heartbeats = 0;
  const cause = new Error('heartbeat found owner lost');
  const run = runSpecAcceptance(plan(api.targetUrl, [contract('first', '/pending-headers'), contract('second')]), {
    outputDir, assertActive() { guards++; if (!active) throw cause; },
    onEvent(event) { if (event.kind === 'acceptance-heartbeat') { heartbeats++; return release.promise; } },
  });
  const rejected = assert.rejects(run, controlError('SPEC_ACCEPTANCE_GUARD_FAILED', cause));
  await api.arrived('/pending-headers'); clock.tick(); const before = guards; clock.tick();
  assert.equal(heartbeats, 1); assert.ok(guards > before);
  active = false; clock.tick(); await rejected; await api.closed('/pending-headers');
  assert.equal(clock.state.clears, 1); assert.equal(clock.state.unrefs, 1);
  assert.equal(heartbeats, 1); assert.equal(api.requests.length, 1);
  release.reject(new Error('late heartbeat rejection')); await turn();
});

test('guard failure after a check event prevents the next request, omission and completed event', async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), events = [];
  let active = true;
  const input = plan(api.targetUrl); input.spec.omissions = [{ id: 'unsupported', method: 'POST', path: '/write', reason: 'Read-only scope' }];
  await assert.rejects(runSpecAcceptance(input, { outputDir, assertActive() { if (!active) throw new Error('cancel after first check'); },
    onEvent(event) { events.push(event.kind); if (event.kind === 'acceptance-check') active = false; } }),
  controlError('SPEC_ACCEPTANCE_GUARD_FAILED'));
  assert.deepEqual(events, ['acceptance-started', 'acceptance-check']); assert.equal(api.requests.length, 1);
  assert.equal((await readdir(outputDir)).some(file => file.includes('second') || file.includes('omission')), false);
});

test('internal timeout stays an ordinary blocked check and continues while external control is active', { timeout: 5000 }, async t => {
  const { outputDir } = await workspace(t), api = await fixture(t), controller = new AbortController();
  const report = await runSpecAcceptance(plan(api.targetUrl, [contract('first', '/pending-headers'), contract('second')], { timeoutMs: 1000 }),
    { outputDir, signal: controller.signal, assertActive() {} });
  assert.equal(report.status, 'completed'); assert.equal(report.checks[0].status, 'blocked');
  assert.equal(report.checks[0].actual.errorCode, 'REQUEST_TIMEOUT'); assert.equal(report.checks[1].status, 'passed');
  assert.equal(summarizeAcceptanceReport(report).gate, 'blocked'); assert.equal(controller.signal.aborted, false);
  assert.deepEqual(api.requests.map(item => item.path), ['/pending-headers', '/healthy']);
});

test('omitting controls and supplying active controls have the same output and evidence contract', async t => {
  const { root } = await workspace(t), api = await fixture(t), controller = new AbortController();
  const input = plan(api.targetUrl, [contract('healthy'), contract('bug', '/bug'), contract('head', '/head', 'HEAD')]);
  const bytes = JSON.stringify(input), sha = value => createHash('sha256').update(value).digest('hex');
  const stripTime = raw => ({ ...raw, startedAt: 'time', endedAt: 'time', specApproval: { ...raw.specApproval, recordedAt: 'time' } });
  const firstDir = join(root, 'legacy'), secondDir = join(root, 'controlled'), runId = 'fixed-test-run';
  const first = await runSpecAcceptance(input, { runId, outputDir: firstDir });
  const second = await runSpecAcceptance(input, { runId, outputDir: secondDir, signal: controller.signal, assertActive() { return true; } });
  assert.deepEqual(stripTime(second), stripTime(first)); assert.equal(JSON.stringify(input), bytes);
  assert.equal(sha(JSON.stringify(normalizeSpecPlan(input))), sha(bytes));
  const names = (await readdir(firstDir)).sort(); assert.deepEqual((await readdir(secondDir)).sort(), names);
  for (const name of names) assert.deepEqual(await readFile(join(secondDir, name)), await readFile(join(firstDir, name)), name);
  assert.equal(summarizeAcceptanceReport(second).gate, 'failed');
  assert.deepEqual(api.requests.map(item => item.method), ['GET', 'GET', 'HEAD', 'GET', 'GET', 'HEAD']);
  assert.equal(Object.hasOwn(second, 'signal'), false); assert.equal(Object.hasOwn(second, 'assertActive'), false);
});
