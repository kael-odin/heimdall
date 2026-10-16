import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { createAcceptanceExecutionRuntime } from '../src/acceptance/execution-runtime.mjs';
import { startManagedSpecExecution } from '../src/acceptance/managed-executor.mjs';

const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const cas = catalog => { const { generationId, revision } = catalog.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
async function fixture(t, paths = ['/healthy'], timeoutMs = 1000) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-executor-'))), owner = acquireAcceptanceOwner({ root });
  const requests = [], arrivals = new Map(), closures = new Map();
  const gate = (map, path) => { if (!map.has(path)) map.set(path, deferred()); return map.get(path); };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    requests.push(path); gate(arrivals, path).resolve(); response.on('close', () => gate(closures, path).resolve());
    if (path.endsWith('/pending')) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (path.endsWith('/stream')) { response.flushHeaders(); response.write('{"code":'); return; }
    response.end(JSON.stringify({ code: path.endsWith('/bug') ? 9 : 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, catalog = createAcceptanceCatalogStore({ root, owner });
  await catalog.initialize();
  const project = (await catalog.createProject({ ...cas(catalog), name: 'executor real admission fixture' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'source', targetUrl: base + '/source' })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'target', targetUrl: base + '/target' })).release;
  const source = createAcceptanceRun({ mode: 'spec', name: 'managed executor', targetUrl: sourceRelease.targetUrl, timeoutMs,
    spec: { source: { id: 'REQ-EXECUTOR', revision: '1', type: 'manual' }, approved: false,
      checks: paths.map((path, i) => ({ id: 'check-' + i, title: path, method: 'GET', path, severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } }, { root });
  const sourceDir = join(root, source.runId);
  finishAcceptanceRun(source.runId, await runSpecAcceptance(source.plan, { runId: source.runId, outputDir: sourceDir }), { root });
  await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: source.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: 'approved' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id, contentDigest: candidate.contentDigest, reason: 'selected' })).selection;
  const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  const envelope = JSON.parse(record.bytes.toString('utf8')), dir = join(root, envelope.runId), manifestPath = join(dir, 'manifest.json'), reportPath = join(dir, 'report.json');
  const sidecar = join(root, 'managed-spec-dispatches', 'v1', envelope.operationId + '.json');
  const runtime = createAcceptanceExecutionRuntime(), lease = runtime.reserve({ kind: 'managed', operationId: envelope.operationId });
  assert.deepEqual(requests, []); assert.equal(fs.existsSync(dir), false);
  return { root, owner, record, envelope, runtime, lease, dir, manifestPath, reportPath, sidecar, requests,
    arrived: path => gate(arrivals, path).promise, closed: path => gate(closures, path).promise,
    start: options => startManagedSpecExecution({ owner, runtime, lease, record, ...options }) };
}
function fakeClock() {
  let current = 0, sequence = 0; const pending = new Map();
  return { pending, timing: { now: () => current, setTimer(fn, ms) { const id = ++sequence; pending.set(id, { fn, at: current + ms }); return id; }, clearTimer(id) { pending.delete(id); } },
    advance(ms, fire = true) { current += ms; if (fire) for (const [id, timer] of [...pending]) if (timer.at <= current) { pending.delete(id); timer.fn(); } } };
}
function heartbeatClock(t) {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval; let callback;
  const handle = { unref() {} };
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => { if (ms !== 30000) return realSet(fn, ms, ...args); callback = fn; return handle; });
  t.mock.method(globalThis, 'clearInterval', value => value === handle ? undefined : realClear(value));
  return () => { assert.ok(callback); callback(); };
}

for (const [path, gate, bugs] of [['/healthy', 'passed', 0], ['/bug', 'failed', 1], ['/pending', 'blocked', 0]]) {
  test('real HTTP ' + path + ' keeps the report gate separate from task completion', { timeout: 10000 }, async t => {
    const f = await fixture(t, [path]), terminals = [], handle = f.start({ mirror: { terminal: result => terminals.push(result) } });
    assert.equal(json(f.manifestPath).status, 'running'); assert.equal(f.runtime.state().busy, true);
    const result = await handle.finished;
    assert.equal(result.status, 'done'); assert.equal(result.runStatus, 'completed'); assert.equal(result.gate, gate);
    assert.equal(result.summary.bugs, bugs); assert.equal(json(f.manifestPath).status, 'completed');
    assert.equal(json(f.reportPath).gate, gate); assert.equal(f.requests.length, 1); assert.equal(terminals.length, 1);
    assert.equal(f.runtime.state().busy, false); assert.equal(f.runtime.state().blocked, false);
    if (path === '/pending') assert.equal(json(f.reportPath).checks[0].actual.errorCode, 'REQUEST_TIMEOUT');
  });
}

test('runner completion event remains running with held slot until the report writer commits', async t => {
  const f = await fixture(t), completed = deferred(), resume = deferred(), terminals = [];
  const handle = f.start({ mirror: { terminal: value => terminals.push(value) }, dependencies: { async runSpecAcceptance(plan, options) {
    const raw = await runSpecAcceptance(plan, options); completed.resolve(); await resume.promise; return raw;
  } } });
  await completed.promise;
  assert.equal(json(f.manifestPath).progress.kind, 'acceptance-completed'); assert.equal(json(f.manifestPath).status, 'running');
  assert.equal(fs.existsSync(f.reportPath), false); assert.equal(f.runtime.state().busy, true); assert.deepEqual(terminals, []);
  resume.resolve(); assert.equal((await handle.finished).status, 'done'); assert.equal(terminals.length, 1);
});

for (const path of ['/pending', '/stream']) {
  test('cancel interrupts real ' + path + ' and never starts the next contract', { timeout: 10000 }, async t => {
    const f = await fixture(t, [path, '/healthy'], 30000), handle = f.start();
    await f.arrived('/target' + path);
    assert.equal(handle.requestStop('CANCELLED'), true); assert.equal(handle.requestStop('WATCHDOG_TIMEOUT'), false);
    assert.equal(f.runtime.state().busy, true);
    const result = await handle.finished; await f.closed('/target' + path);
    assert.equal(result.status, 'cancelled'); assert.equal(result.runStatus, 'interrupted'); assert.equal(result.reasonCode, 'CANCELLED');
    assert.equal(json(f.manifestPath).status, 'interrupted'); assert.equal(fs.existsSync(f.reportPath), false);
    assert.deepEqual(f.requests, ['/target' + path]); assert.equal(f.runtime.state().busy, false); assert.equal(f.runtime.state().blocked, false);
    assert.equal(handle.requestStop('CANCELLED'), false);
  });
}

for (const change of ['owner', 'dispatch']) {
  test(change + ' loss during pending headers fails the heartbeat fence and preserves running facts', { timeout: 10000 }, async t => {
    const f = await fixture(t, ['/pending', '/healthy'], 30000), tick = heartbeatClock(t), handle = f.start();
    await f.arrived('/target/pending'); const before = fs.readFileSync(f.manifestPath);
    const path = change === 'owner' ? join(f.root, ACCEPTANCE_OWNER_FILE) : f.sidecar, original = fs.readFileSync(path);
    t.after(() => { if (fs.existsSync(path)) fs.writeFileSync(path, original); });
    const changed = json(path); if (change === 'owner') changed.nonce = 'a'.repeat(64); else changed.plan.name += ' changed';
    fs.writeFileSync(path, JSON.stringify(changed)); tick();
    const result = await handle.finished; await f.closed('/target/pending');
    assert.equal(result.status, change === 'owner' ? 'interrupted' : 'failed'); assert.equal(result.gate, 'blocked');
    assert.deepEqual(fs.readFileSync(f.manifestPath), before); assert.equal(fs.existsSync(f.reportPath), false);
    assert.deepEqual(f.requests, ['/target/pending']); assert.equal(f.runtime.state().busy, false); assert.equal(f.runtime.state().blocked, true);
  });
}

for (const change of ['run-directory', 'running-head']) {
  test(change + ' substitution during pending headers stops before another evidence write and never settles the replacement', { timeout: 15000 }, async t => {
    const f = await fixture(t, ['/pending', '/healthy'], 30000), tick = heartbeatClock(t), handle = f.start();
    await f.arrived('/target/pending'); const original = fs.readFileSync(f.manifestPath);
    if (change === 'run-directory') {
      fs.renameSync(f.dir, f.dir + '-original'); fs.mkdirSync(f.dir); fs.writeFileSync(f.manifestPath, original);
    } else {
      const head = json(f.manifestPath); head.progress.message = 'replaced same binding'; fs.writeFileSync(f.manifestPath, JSON.stringify(head, null, 2) + '\n');
    }
    const replacement = fs.readFileSync(f.manifestPath); tick();
    const result = await handle.finished; await f.closed('/target/pending');
    assert.equal(result.gate, 'blocked'); assert.equal(f.runtime.state().blocked, true); assert.equal(f.runtime.state().busy, false);
    assert.deepEqual(fs.readFileSync(f.manifestPath), replacement); assert.equal(fs.existsSync(f.reportPath), false);
    assert.deepEqual(f.requests, ['/target/pending']);
    if (change === 'run-directory') assert.deepEqual(fs.readdirSync(f.dir), ['manifest.json']);
  });
}

test('a rejected head fence stays lost even if the runner restores the same bytes before unwinding', async t => {
  const f = await fixture(t); let original;
  const result = await f.start({ dependencies: { async runSpecAcceptance(_plan, options) {
    original = fs.readFileSync(f.manifestPath);
    const head = json(f.manifestPath); head.progress = { kind: 'acceptance-heartbeat', message: 'changed' };
    fs.writeFileSync(f.manifestPath, JSON.stringify(head, null, 2) + '\n');
    try { options.assertActive(); } finally { fs.writeFileSync(f.manifestPath, original); }
  } } }).finished;
  assert.equal(result.status, 'failed'); assert.equal(f.runtime.state().blocked, true); assert.equal(f.runtime.state().busy, false);
  assert.deepEqual(fs.readFileSync(f.manifestPath), original); assert.equal(json(f.manifestPath).status, 'running');
  assert.deepEqual(f.requests, []); assert.equal(fs.existsSync(f.reportPath), false);
});

for (const [timeoutMs, stallMs, step, reasonCode] of [[100, 50, 50, 'WATCHDOG_STALLED'], [50, 100, 50, 'WATCHDOG_TIMEOUT']]) {
  test('fake watchdog settles ' + reasonCode + ' once and detaches every timer', { timeout: 10000 }, async t => {
    const f = await fixture(t, ['/pending', '/healthy'], 30000), clock = fakeClock();
    const handle = f.start({ timing: { ...clock.timing, timeoutMs, stallMs } });
    await f.arrived('/target/pending'); clock.advance(step);
    assert.equal(handle.requestStop('CANCELLED'), false);
    const result = await handle.finished;
    assert.equal(result.status, 'failed'); assert.equal(result.runStatus, 'failed'); assert.equal(result.reasonCode, reasonCode);
    assert.equal(clock.pending.size, 0); clock.advance(10000); assert.equal(clock.pending.size, 0);
    assert.equal(f.runtime.state().blocked, false); assert.deepEqual(f.requests, ['/target/pending']);
  });
}

test('hard deadline fence rejects completion even when the injected timer has not fired', async t => {
  const f = await fixture(t), clock = fakeClock();
  const handle = f.start({ timing: { ...clock.timing, timeoutMs: 100, stallMs: 100 }, dependencies: { async runSpecAcceptance(plan, options) {
    const raw = await runSpecAcceptance(plan, options); clock.advance(100, false); return raw;
  } } });
  const result = await handle.finished;
  assert.equal(result.reasonCode, 'WATCHDOG_TIMEOUT'); assert.equal(result.runStatus, 'failed'); assert.equal(fs.existsSync(f.reportPath), false);
  assert.equal(clock.pending.size, 0);
});

test('event and terminal mirror failures are degraded observability after an authoritative completed report', async t => {
  const f = await fixture(t); let terminalCalls = 0;
  const result = await f.start({ mirror: { event(value) { value.runId = 'forged'; throw Error('SECRET event'); }, terminal(value) {
    terminalCalls++; value.gate = 'forged'; throw Error('SECRET terminal');
  } } }).finished;
  assert.equal(result.status, 'done'); assert.equal(result.gate, 'passed'); assert.equal(result.mirrorDegraded, true);
  assert.equal(terminalCalls, 1); assert.equal(json(f.reportPath).gate, 'passed'); assert.equal(f.runtime.state().blocked, false);
});

for (const stage of ['preflight', 'register']) {
  test('synchronous ' + stage + ' failure releases the slot and makes zero target requests', async t => {
    const f = await fixture(t), terminals = [];
    assert.throws(() => f.start({ mirror: { [stage]() { throw Error('SECRET local path'); }, terminal: value => terminals.push(value) } }),
      error => error.code === 'MANAGED_EXECUTION_START_FAILED' && !error.message.includes('SECRET'));
    assert.equal(f.runtime.state().busy, false); assert.deepEqual(f.requests, []);
    if (stage === 'preflight') { assert.equal(fs.existsSync(f.dir), false); assert.equal(terminals.length, 0); }
    else { assert.equal(json(f.manifestPath).status, 'failed'); assert.equal(terminals.length, 1); }
  });
}

test('an asynchronous mirror return is observed without an unhandled rejection or changed report facts', async t => {
  const f = await fixture(t), unhandled = [], listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener); t.after(() => process.removeListener('unhandledRejection', listener));
  const result = await f.start({ mirror: { event: () => Promise.reject(Error('event')), terminal: () => Promise.reject(Error('terminal')) } }).finished;
  await turn(); await turn(); assert.deepEqual(unhandled, []); assert.equal(result.status, 'done'); assert.equal(result.mirrorDegraded, true);
});

for (const point of ['completed-manifest', 'report']) {
  test('commit then throw at ' + point + ' blocks admission, observes facts and never retries or settles', async t => {
    const f = await fixture(t), realRename = fs.renameSync, realLink = fs.linkSync; let terminalWrites = 0, reportWrites = 0, faulted = false;
    let renameMock, linkMock;
    const install = () => {
      renameMock = t.mock.method(fs, 'renameSync', (from, to) => {
        const terminal = String(to) === f.manifestPath && json(from).status !== 'running';
        if (terminal) terminalWrites++;
        const value = realRename(from, to);
        if (terminal && point === 'completed-manifest' && !faulted) { faulted = true; throw Error('commit then throw'); }
        return value;
      });
      linkMock = t.mock.method(fs, 'linkSync', (from, to) => {
        const report = String(to) === f.reportPath; if (report) reportWrites++;
        const value = realLink(from, to);
        if (report && point === 'report' && !faulted) { faulted = true; throw Error('report commit then throw'); }
        return value;
      }); syncBuiltinESMExports();
    };
    let result;
    try {
      result = await f.start({ dependencies: { async runSpecAcceptance(plan, options) { const raw = await runSpecAcceptance(plan, options); install(); return raw; } } }).finished;
    } finally { renameMock?.mock.restore(); linkMock?.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(faulted, true); assert.equal(result.publicationUncertain, true); assert.equal(f.runtime.state().blocked, true);
    assert.equal(f.runtime.state().busy, false); assert.equal(reportWrites, 1);
    assert.equal(json(f.manifestPath).status, point === 'report' ? 'running' : 'completed');
    assert.equal(terminalWrites, point === 'report' ? 0 : 1); assert.equal(result.status, point === 'report' ? 'failed' : 'done');
    assert.equal(result.code, 'MANAGED_PUBLICATION_UNCERTAIN'); assert.equal(fs.existsSync(f.reportPath), true);
  });
}

for (const committed of [false, true]) {
  test('settlement publication error after commit=' + committed + ' is observed once without retry', async t => {
    const f = await fixture(t), realRename = fs.renameSync; let attempts = 0, mock;
    let result;
    try {
      result = await f.start({ dependencies: { async runSpecAcceptance() {
        f.runtime.stop(f.lease, 'CANCELLED');
        mock = t.mock.method(fs, 'renameSync', (from, to) => {
          if (String(to) !== f.manifestPath) return realRename(from, to);
          attempts++; if (committed) realRename(from, to);
          throw Object.assign(Error('settlement write failure'), { code: 'EIO' });
        }); syncBuiltinESMExports();
        throw Error('runner stopped');
      } } }).finished;
    } finally { mock?.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(attempts, 1); assert.equal(f.runtime.state().blocked, true); assert.equal(f.runtime.state().busy, false);
    assert.equal(json(f.manifestPath).status, committed ? 'interrupted' : 'running'); assert.equal(fs.existsSync(f.reportPath), false);
    assert.equal(result.status, committed ? 'cancelled' : 'failed'); assert.equal(result.publicationUncertain, committed);
  });
}

test('late events after completion cannot mutate facts or release a newly held lease', async t => {
  const f = await fixture(t); let event;
  const handle = f.start({ dependencies: { async runSpecAcceptance(plan, options) { event = options.onEvent; return runSpecAcceptance(plan, options); } } });
  await handle.finished; const before = fs.readFileSync(f.manifestPath), another = f.runtime.reserve({ kind: 'legacy' });
  assert.throws(() => event({ kind: 'acceptance-heartbeat' }), error => error.code === 'MANAGED_EXECUTION_INACTIVE');
  assert.equal(handle.requestStop('CANCELLED'), false); assert.equal(f.runtime.assertHeld(another), true);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before); f.runtime.release(another);
});

test('cancel holds its lease until an uncooperative runner becomes quiet; late raw results never finish', async t => {
  const f = await fixture(t), rawReady = deferred(), resume = deferred(); let raw;
  const handle = f.start({ dependencies: { async runSpecAcceptance(plan, options) { raw = await runSpecAcceptance(plan, options); rawReady.resolve(); await resume.promise; return raw; } } });
  await rawReady.promise; handle.requestStop('CANCELLED'); await turn();
  assert.equal(f.runtime.state().busy, true); assert.equal(json(f.manifestPath).status, 'running');
  resume.resolve(); const result = await handle.finished;
  assert.equal(result.status, 'cancelled'); assert.equal(fs.existsSync(f.reportPath), false); assert.equal(f.runtime.state().busy, false);
});

test('timing cannot disable or enlarge hard and stall budgets; validation has not taken over the lease', async t => {
  const f = await fixture(t);
  for (const timing of [{ timeoutMs: 0 }, { timeoutMs: 360001 }, { stallMs: 0 }, { stallMs: 65001 }, { timeoutMs: 1.5 }]) {
    assert.throws(() => f.start({ timing }), error => error.code === 'INVALID_INPUT');
    assert.equal(f.runtime.assertHeld(f.lease), true); assert.equal(fs.existsSync(f.dir), false);
  }
  f.runtime.release(f.lease); assert.deepEqual(f.requests, []);
});
