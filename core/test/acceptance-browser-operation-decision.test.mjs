import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserOperationStore } from '../src/acceptance/browser-operation-store.mjs';
import { BROWSER_OPERATION_LIMITS, browserOperationRequestFingerprint, browserOperationRejectionBytes,
  browserOperationSha256, validateBrowserOperationRejection } from '../src/acceptance/browser-operation-schema.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/acceptance-browser-start-resolution-vectors.json', import.meta.url), 'utf8')).vectors;
const folder = (f, id) => join(f.root, 'browser-operations', 'v1', id);
const clone = value => JSON.parse(JSON.stringify(value));
const errorCode = code => error => {
  assert.equal(error.code, code);
  assert.equal(/[A-Z]:\\|ENOENT|EACCES/.test(JSON.stringify(error)), false);
  return true;
};
const unavailable = error => {
  assert.equal(error.status, 503);
  assert.equal(/[A-Z]:\\|ENOENT|EACCES/.test(JSON.stringify(error)), false);
  return true;
};
function rejection(f, request) {
  return { schemaVersion: 1, kind: 'browser-start-rejection', projectId: f.project.id, operationId: request.operationId,
    request, requestFingerprint: browserOperationRequestFingerprint({ projectId: f.project.id, ...request }),
    rejectedAt: '2026-10-17T13:00:00.000Z', reasonCode: 'USER_REJECTED_UNKNOWN_START',
    effect: 'deny-future-starts-for-operation', actor: { kind: 'local-user' } };
}
const deny = (f, request, options) => f.store.publishRejection({ projectId: f.project.id, request }, options);

test('rejection schema and canonical LF bytes match all three independently fixed revision vectors', () => {
  assert.equal(BROWSER_OPERATION_LIMITS.rejectionBytes, 16 * 1024);
  assert.equal(vectors.length, 3);
  for (const vector of vectors) {
    assert.deepEqual(validateBrowserOperationRejection(vector.rejection), vector.rejection);
    assert.equal(browserOperationRequestFingerprint({ projectId: vector.projectId, ...vector.request }), vector.requestFingerprint);
    const bytes = browserOperationRejectionBytes(vector.rejection);
    assert.equal(bytes.toString('utf8'), vector.canonicalRejection);
    assert.equal(bytes.length, vector.rejectionBytes);
    assert.equal(browserOperationSha256(bytes), vector.rejectionSha256);
    assert.equal(bytes.at(-1), 10);
  }
});

test('rejection schema rejects variant fields, wrong bindings and hostile data without executing hooks', () => {
  const valid = vectors[1].rejection;
  for (const mutate of [v => v.extra = true, v => delete v.kind, v => v.kind = 'dispatch',
    v => v.projectId = valid.projectId.replace(/1$/, '6'), v => v.operationId = valid.operationId.replace(/2$/, '6'),
    v => v.request.expectedGenerationId = valid.request.expectedGenerationId.replace(/3$/, '6'),
    v => v.request.expectedRevision++, v => v.requestFingerprint = 'a'.repeat(64),
    v => v.rejectedAt = '2026-10-17T13:00:00Z', v => v.reasonCode = 'OTHER',
    v => v.effect = 'allow', v => v.actor.extra = true, v => v.actor.kind = 'remote',
    v => v.request.contentDigest = 'x'.repeat(17000)]) {
    const value = clone(valid); mutate(value); assert.throws(() => validateBrowserOperationRejection(value));
    assert.throws(() => browserOperationRejectionBytes(value));
  }
  let hooks = 0;
  const accessor = clone(valid); Object.defineProperty(accessor, 'kind', { enumerable: true, get() { hooks++; return valid.kind; } });
  const thenable = clone(valid); Object.defineProperty(thenable, 'then', { enumerable: true, get() { hooks++; return () => {}; } });
  const proxy = new Proxy(valid, { ownKeys() { hooks++; return []; }, getPrototypeOf() { hooks++; return Object.prototype; } });
  const revoked = Proxy.revocable(valid, {}); revoked.revoke();
  const symbol = clone(valid); symbol[Symbol('extra')] = true;
  for (const value of [accessor, thenable, proxy, revoked.proxy, symbol]) assert.throws(() => validateBrowserOperationRejection(value));
  assert.equal(hooks, 0);
});

test('decision absence is synchronous and all read paths preserve the missing namespace', async t => {
  const f = await browserOperationFixture(t), request = f.request(), before = readdirSync(f.root).sort();
  assert.deepEqual(f.store.inspectDecision(request.operationId), { kind: 'absent', operationId: request.operationId });
  assert.deepEqual(f.store.inspectDecision(request.operationId, { full: false }), { kind: 'absent', operationId: request.operationId });
  assert.deepEqual(f.store.list(f.project.id), []);
  assert.equal(f.store.ledger(f.project.id).entries.length, 0);
  assert.deepEqual(f.store.recover(), { schemaVersion: 1, inspected: 0, interrupted: 0, prepared: 0 });
  assert.deepEqual(readdirSync(f.root).sort(), before);
  assert.equal(existsSync(join(f.root, 'browser-operations')), false);
});

test('permanent rejection replays immutable original bytes across store restart and excludes execution and ledger', async t => {
  const f = await browserOperationFixture(t), request = f.request(), result = deny(f, request);
  assert.equal(result.replayed, false); assert.equal(result.decision.kind, 'rejected');
  const original = readFileSync(join(folder(f, request.operationId), 'rejection.json'));
  assert.deepEqual(original, browserOperationRejectionBytes(result.decision.record.envelope));
  assert.deepEqual(readdirSync(folder(f, request.operationId)), ['rejection.json']);
  const replay = deny(f, request, { assertCurrent() { throw Error('historical replay must not call the admission guard'); } });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.decision.record.bytes, original);
  result.decision.record.bytes.fill(0); result.decision.record.envelope.actor.kind = 'caller mutation';
  const restarted = createBrowserOperationStore({ owner: f.owner });
  assert.deepEqual(restarted.inspectDecision(request.operationId).record.bytes, original);
  assert.deepEqual(f.store.list(f.project.id), []);
  assert.deepEqual(f.store.ledger(f.project.id).entries, []);
  assert.deepEqual(f.store.recover(), { schemaVersion: 1, inspected: 1, interrupted: 0, prepared: 0 });
  for (const invoke of [() => f.store.read(request.operationId), () => f.store.createRun(request.operationId),
    () => f.store.finishRun(request.operationId, {}),
    () => f.store.settleRun(request.operationId, { status: 'interrupted', reasonCode: 'CANCELLED' }),
    () => f.store.readEvidence(request.operationId, 'target.json'), () => f.store.registerResult(request.operationId)])
    assert.throws(invoke, errorCode('BROWSER_START_REJECTED'));
  let sourceReads = 0;
  const late = { project: f.project, request };
  Object.defineProperty(late, 'sourceFiles', { get() { sourceReads++; throw Error('must not consume source'); } });
  assert.throws(() => f.store.publish(late), errorCode('BROWSER_START_REJECTED'));
  assert.equal(sourceReads, 0);
  for (const key of Object.keys(request).filter(key => key !== 'operationId')) {
    const changed = { ...request, [key]: key === 'expectedRevision' ? request[key] + 1
      : key === 'contentDigest' ? '0'.repeat(64) : request[key].slice(0, -1) + (request[key].endsWith('0') ? '1' : '0') };
    assert.throws(() => deny(f, changed), errorCode('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => f.publish(changed), errorCode('IDEMPOTENCY_CONFLICT'));
  }
  assert.deepEqual(readFileSync(join(folder(f, request.operationId), 'rejection.json')), original);
});

test('deny returns an existing accepted fact before admission guards and never starts or alters prepared/running records', async t => {
  const f = await browserOperationFixture(t);
  for (const running of [false, true]) {
    const request = f.request(); f.publish(request);
    if (running) f.store.createRun(request.operationId);
    const dispatch = readFileSync(join(folder(f, request.operationId), 'dispatch.json'));
    const head = running && readFileSync(join(folder(f, request.operationId), 'head.json'));
    const result = deny(f, request, { assertCurrent() { throw Error('do not evaluate fresh admission'); } });
    assert.equal(result.replayed, true); assert.equal(result.decision.kind, 'recorded');
    assert.equal(result.decision.value.state, running ? 'running' : 'prepared');
    assert.deepEqual(readFileSync(join(folder(f, request.operationId), 'dispatch.json')), dispatch);
    assert.equal(existsSync(join(folder(f, request.operationId), 'rejection.json')), false);
    if (head) assert.deepEqual(readFileSync(join(folder(f, request.operationId), 'head.json')), head);
  }
});

test('accepted and rejected decisions share capacity while historical matches remain readable at the limit', async t => {
  const f = await browserOperationFixture(t), a = f.request(), b = f.request();
  deny(f, a); f.publish(b);
  const limited = createBrowserOperationStore({ owner: f.owner, limits: { operations: 2 } });
  assert.equal(limited.publishRejection({ projectId: f.project.id, request: a }).replayed, true);
  assert.equal(limited.publishRejection({ projectId: f.project.id, request: b }).decision.kind, 'recorded');
  const next = f.request();
  assert.throws(() => limited.publishRejection({ projectId: f.project.id, request: next }), unavailable);
  assert.throws(() => limited.publish({ ...f, request: next }), unavailable);
  assert.equal(existsSync(folder(f, next.operationId)), false);
  assert.equal(limited.list(f.project.id).length, 1);
});

test('rejection reads require exact canonical LF original bytes and a single safe file', async t => {
  const f = await browserOperationFixture(t), request = f.request(), result = deny(f, request);
  const path = join(folder(f, request.operationId), 'rejection.json'), original = readFileSync(path);
  for (const bytes of [Buffer.from(JSON.stringify(result.decision.record.envelope, null, 2) + '\n'),
    original.subarray(0, -1), Buffer.concat([original, Buffer.from(' ')]), Buffer.alloc(16 * 1024 + 1, 32), Buffer.from([0xff]), Buffer.alloc(0)]) {
    writeFileSync(path, bytes); assert.throws(() => f.store.inspectDecision(request.operationId), unavailable);
    assert.deepEqual(readFileSync(path), bytes);
  }
  writeFileSync(path, original);
  const alias = join(f.root, 'rejection-alias.json'); linkSync(path, alias);
  assert.throws(() => f.store.inspectDecision(request.operationId), unavailable); rmSync(alias);
  assert.equal(f.store.inspectDecision(request.operationId).kind, 'rejected');
  for (const name of ['dispatch.json', 'head.json', 'report.json', 'observations.json', 'unexpected.json', 'rejection.json.tmp.old', 'evidence']) {
    const extra = join(folder(f, request.operationId), name);
    if (name === 'evidence') mkdirSync(extra); else writeFileSync(extra, '');
    for (const invoke of [() => f.store.inspectDecision(request.operationId), () => deny(f, request),
      () => f.publish(request), () => f.store.list(f.project.id), () => f.store.ledger(f.project.id), () => f.store.recover()])
      assert.throws(invoke, unavailable);
    assert.deepEqual(readFileSync(path), original); rmSync(extra, { recursive: name === 'evidence' });
  }
});

test('empty, evidence-only and unknown accepted shapes are never adopted or repaired', async t => {
  const f = await browserOperationFixture(t), seed = f.request(); deny(f, seed);
  for (const kind of ['empty', 'evidence-only', 'temporary']) {
    const request = f.request(), path = folder(f, request.operationId); mkdirSync(path);
    if (kind === 'evidence-only') mkdirSync(join(path, 'evidence'));
    if (kind === 'temporary') writeFileSync(join(path, 'dispatch.json.tmp.old'), '{}');
    const before = readdirSync(path).sort();
    for (const invoke of [() => f.store.inspectDecision(request.operationId), () => deny(f, request), () => f.publish(request)])
      assert.throws(invoke, unavailable);
    assert.deepEqual(readdirSync(path).sort(), before);
    assert.equal(existsSync(join(path, 'dispatch.json')), false); assert.equal(existsSync(join(path, 'rejection.json')), false);
  }
  const accepted = f.request(); f.publish(accepted);
  writeFileSync(join(folder(f, accepted.operationId), 'untracked.tmp.old'), '');
  assert.throws(() => f.store.inspectDecision(accepted.operationId), unavailable);
});

test('whole-batch recovery preserves legacy partial report and safe opaque evidence alongside a rejection', async t => {
  const f = await browserOperationFixture(t), a = f.request(), b = f.request(), prepared = f.request(), rejected = f.request();
  for (const request of [a, b, prepared]) f.publish(request);
  for (const request of [a, b]) f.store.createRun(request.operationId);
  deny(f, rejected);
  const aPath = folder(f, a.operationId), rejectionPath = join(folder(f, rejected.operationId), 'rejection.json');
  writeFileSync(join(aPath, 'report.json'), '{partial');
  writeFileSync(join(aPath, 'evidence', 'empty.json'), '');
  writeFileSync(join(aPath, 'evidence', 'partial.png'), 'half-written-image');
  const originalRejection = readFileSync(rejectionPath), firstHead = readFileSync(join(aPath, 'head.json'));
  const bad = join(folder(f, rejected.operationId), 'head.json'); writeFileSync(bad, '{}');
  assert.throws(() => f.store.recover(), unavailable);
  assert.deepEqual(readFileSync(join(aPath, 'head.json')), firstHead);
  rmSync(bad);
  assert.deepEqual(f.store.recover(), { schemaVersion: 1, inspected: 4, interrupted: 2, prepared: 1 });
  assert.equal(f.store.read(a.operationId).state, 'interrupted'); assert.equal(f.store.read(b.operationId).state, 'interrupted');
  assert.equal(f.store.read(prepared.operationId).state, 'prepared');
  assert.equal(readFileSync(join(aPath, 'report.json'), 'utf8'), '{partial');
  assert.equal(readFileSync(join(aPath, 'evidence', 'empty.json')).length, 0);
  assert.equal(readFileSync(join(aPath, 'evidence', 'partial.png'), 'utf8'), 'half-written-image');
  assert.deepEqual(readFileSync(rejectionPath), originalRejection);
  mkdirSync(join(aPath, 'evidence', 'nested'));
  assert.throws(() => f.store.read(a.operationId), unavailable);
});

test('a decision published by a preclaim competitor wins without any source copies or duplicate decision', async t => {
  const f = await browserOperationFixture(t), a = f.request(); let entered = false;
  assert.throws(() => f.publish(a, { assertCurrent() {
    if (!entered) { entered = true; deny(f, a); }
  } }), errorCode('BROWSER_START_REJECTED'));
  assert.deepEqual(readdirSync(folder(f, a.operationId)), ['rejection.json']);
  const b = f.request(); entered = false;
  const result = deny(f, b, { assertCurrent() { if (!entered) { entered = true; f.publish(b); } } });
  assert.equal(result.replayed, true); assert.equal(result.decision.kind, 'recorded');
  assert.equal(result.decision.value.state, 'prepared');
  assert.equal(existsSync(join(folder(f, b.operationId), 'rejection.json')), false);
});

test('claim and final publication fences reject injected forbidden entries and clean only their own temporary', async t => {
  const f = await browserOperationFixture(t);
  for (const stage of ['empty', 'temporary']) {
    const request = f.request(), path = folder(f, request.operationId); let injected = false;
    assert.throws(() => deny(f, request, { assertCurrent() {
      if (injected || !existsSync(path)) return;
      const entries = readdirSync(path);
      if (stage === 'empty' ? entries.length === 0 : entries.some(name => name.startsWith('rejection.json.tmp.'))) {
        injected = true; writeFileSync(join(path, 'dispatch.json'), '{}');
      }
    } }), unavailable);
    assert.equal(injected, true); assert.deepEqual(readdirSync(path), ['dispatch.json']);
    assert.throws(() => f.store.inspectDecision(request.operationId), unavailable);
  }
  const request = f.request(), path = folder(f, request.operationId); let injected = false;
  assert.throws(() => f.publish(request, { assertCurrent() {
    if (!injected && existsSync(path) && readdirSync(path).some(name => name.startsWith('dispatch.json.tmp.'))) {
      injected = true; writeFileSync(join(path, 'rejection.json'), browserOperationRejectionBytes(rejection(f, request)));
    }
  } }), unavailable);
  assert.equal(injected, true); assert.equal(existsSync(join(path, 'dispatch.json')), false);
  assert.equal(existsSync(join(path, 'rejection.json')), true); assert.equal(existsSync(join(path, 'evidence')), true);
});

test('postcommit guard failure remains unknown while the committed rejection can only be read or replayed', async t => {
  const f = await browserOperationFixture(t), request = f.request(), path = folder(f, request.operationId);
  assert.throws(() => deny(f, request, { assertCurrent() {
    return !existsSync(join(path, 'rejection.json'));
  } }), error => { assert.equal(error.writeMayHaveCommitted, true); return errorCode('BROWSER_OPERATION_INACTIVE')(error); });
  const record = f.store.inspectDecision(request.operationId).record;
  assert.deepEqual(record.bytes, readFileSync(join(path, 'rejection.json')));
  assert.equal(deny(f, request).replayed, true);
  assert.throws(() => f.publish(request), errorCode('BROWSER_START_REJECTED'));
});

test('claim guards recheck namespace capacity and reject newly injected unsafe namespace entries', async t => {
  const f = await browserOperationFixture(t), limited = createBrowserOperationStore({ owner: f.owner, limits: { operations: 1 } });
  const request = f.request(), competitor = f.request(), path = folder(f, request.operationId);
  let injected = false;
  assert.throws(() => limited.publishRejection({ projectId: f.project.id, request }, { assertCurrent() {
    if (!injected && existsSync(path)) { injected = true; mkdirSync(folder(f, competitor.operationId)); }
  } }), unavailable);
  assert.equal(injected, true); assert.deepEqual(readdirSync(path), []);
  rmdirSync(path); rmdirSync(folder(f, competitor.operationId));
  const next = f.request(), nextPath = folder(f, next.operationId), unsafe = join(f.root, 'browser-operations', 'v1', 'unexpected.json');
  injected = false;
  assert.throws(() => deny(f, next, { assertCurrent() {
    if (!injected && existsSync(nextPath)) { injected = true; writeFileSync(unsafe, '{}'); }
  } }), unavailable);
  assert.equal(injected, true); assert.deepEqual(readdirSync(nextPath), []);
  assert.equal(readFileSync(unsafe, 'utf8'), '{}');
});

test('temporary bytes changed by a final guard are rejected before immutable publication', async t => {
  const f = await browserOperationFixture(t), request = f.request(), path = folder(f, request.operationId);
  let changed = false;
  assert.throws(() => deny(f, request, { assertCurrent() {
    if (changed || !existsSync(path)) return;
    const temporary = readdirSync(path).find(name => name.startsWith('rejection.json.tmp.'));
    if (!temporary) return;
    const bytes = readFileSync(join(path, temporary)); bytes[0] ^= 1; writeFileSync(join(path, temporary), bytes); changed = true;
  } }), unavailable);
  assert.equal(changed, true); assert.deepEqual(readdirSync(path), []);
  assert.throws(() => f.store.inspectDecision(request.operationId), unavailable);
});

test('accepted mutation guards recheck rejection absence and reject unsafe evidence without touching heads', async t => {
  const f = await browserOperationFixture(t), request = f.request(); f.publish(request);
  const path = folder(f, request.operationId), dispatch = readFileSync(join(path, 'dispatch.json'));
  assert.throws(() => f.store.createRun(request.operationId, { assertActive() {
    writeFileSync(join(path, 'rejection.json'), browserOperationRejectionBytes(rejection(f, request)));
  } }), unavailable);
  assert.equal(existsSync(join(path, 'head.json')), false); assert.deepEqual(readFileSync(join(path, 'dispatch.json')), dispatch);
  rmSync(join(path, 'rejection.json'));
  const alias = join(path, 'evidence', 'alias.json'); linkSync(join(path, 'dispatch.json'), alias);
  assert.throws(() => f.store.inspectDecision(request.operationId), unavailable);
});

test('offline constructed D3 first-BUG verifier stays incomparable through consecutive actual D4 pass reports', async t => {
  const f = await browserOperationFixture(t);
  const complete = bug => {
    const request = f.request(); f.publish(request); const run = f.store.createRun(request.operationId);
    return { request, value: f.store.finishRun(request.operationId, browserOperationRaw(f, run, { bug })) };
  };
  const first = complete(true), path = folder(f, first.request.operationId);
  // This is a newly constructed offline historical-binding fixture, not a D3
  // browser execution. The literal verifier was reviewed in D3's public report;
  // only this temporary fixture report/head are rewritten, never D3 originals.
  const historicalVerifier = '03f86ce11ab884fb14f2ee17adde4e39f3ef0787f10ebc76f7eed9b7ee1562e3';
  const historical = clone(first.value.report); historical.verifierFingerprint = historicalVerifier;
  const reportBytes = Buffer.from(JSON.stringify(historical, null, 2) + '\n');
  const head = clone(first.value.head); head.reportSha256 = browserOperationSha256(reportBytes);
  writeFileSync(join(path, 'report.json'), reportBytes);
  writeFileSync(join(path, 'head.json'), JSON.stringify(head, null, 2) + '\n');
  assert.equal(f.store.read(first.request.operationId).report.verifierFingerprint, historicalVerifier);
  f.store.registerResult(first.request.operationId);
  let before = first.request.operationId;
  for (let index = 0; index < 3; index++) {
    const passed = complete(false);
    assert.notEqual(passed.value.report.verifierFingerprint, historicalVerifier);
    const observation = f.store.registerResult(passed.request.operationId, { beforeOperationId: before });
    assert.equal(observation.observations.length, 1);
    assert.equal(observation.observations[0].relation, 'incomparable');
    const issue = f.store.ledger(f.project.id).issues[0];
    assert.equal(issue.status, 'unverified'); assert.equal(issue.lastVerifiedState, 'open');
    assert.equal(issue.history.some(entry => entry.relation === 'verified_passed'), false);
    before = passed.request.operationId;
  }
  assert.deepEqual(readFileSync(join(path, 'report.json')), reportBytes);
});
