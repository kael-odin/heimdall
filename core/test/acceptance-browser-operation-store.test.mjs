import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createBrowserOperationStore } from '../src/acceptance/browser-operation-store.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { copy } from './fixtures/acceptance-browser-organized-candidate.mjs';

const folder = (f, id) => join(f.root, 'browser-operations', 'v1', id);
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const rejects = (reason, code) => error => {
  if (reason) assert.equal(error.details?.reason, reason);
  if (code) assert.equal(error.code, code);
  assert.equal(/[A-Z]:\\|ENOENT|EACCES/.test(JSON.stringify(error)), false);
  return true;
};
function operation(f, options) {
  const request = f.request(), publication = f.publish(request), run = f.store.createRun(request.operationId);
  const raw = browserOperationRaw(f, run, options), value = f.store.finishRun(request.operationId, raw);
  return { request, publication, run, raw, value };
}
function limitedOperation(f, { missing = false, environment } = {}) {
  const request = f.request(); f.publish(request); const run = f.store.createRun(request.operationId);
  const raw = browserOperationRaw(f, run, { environment });
  if (missing) {
    raw.checks = [{ id: 'runner-environment', route: '/', status: 'blocked', verdict: 'environment', evidence: {} }];
    raw.coverage.completed = 1;
  } else for (const check of raw.checks) { check.status = 'blocked'; check.verdict = 'environment'; check.evaluationLimited = true; }
  return { request, run, raw, value: f.store.finishRun(request.operationId, raw) };
}
const observationDigest = (f, operationId) => createHash('sha256').update(readFileSync(join(folder(f, operationId), 'observations.json'))).digest('hex');

test('reads, listing, recovery and ledger do not create an operation namespace', async t => {
  const f = await browserOperationFixture(t), request = f.request(), before = readdirSync(f.root).sort();
  assert.equal(f.store.read(request.operationId), null);
  assert.deepEqual(f.store.list(f.project.id), []);
  assert.deepEqual(f.store.recover(), { schemaVersion: 1, inspected: 0, interrupted: 0, prepared: 0 });
  const ledger = f.store.ledger(f.project.id); assert.deepEqual(ledger.entries, []); assert.deepEqual(ledger.issues, []);
  assert.deepEqual(readdirSync(f.root).sort(), before);
  assert.throws(() => f.store.read(request.operationId.replace('bo-', 'ac-')), rejects('INVALID_OPERATION_ID', 'INVALID_INPUT'));
});

test('publish preserves a copied fixed source and one immutable confirmation per operation ID', async t => {
  const f = await browserOperationFixture(t), request = f.request();
  const published = f.publish(request); assert.equal(published.replayed, false);
  const record = published.record, value = f.store.read(request.operationId);
  assert.equal(value.state, 'prepared'); assert.equal(value.head, null);
  assert.equal(existsSync(join(f.root, record.envelope.runId)), false);
  assert.equal(record.envelope.approval.scope, 'single-operation');
  assert.equal(f.publish(request).replayed, true);
  assert.throws(() => f.publish({ ...request, expectedRevision: request.expectedRevision + 1 }), rejects('REQUEST_CONFLICT', 'IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(readdirSync(folder(f, request.operationId)).sort(), ['dispatch.json', 'evidence']);
  const first = f.contract.sourceEvidence[0];
  f.sourceFiles.get(first.sourceFile).fill(0);
  assert.notEqual(readFileSync(join(folder(f, request.operationId), 'evidence', first.file)).toString('hex'), f.sourceFiles.get(first.sourceFile).toString('hex'));
  value.record.bytes.fill(0); value.record.envelope.project.name = 'caller mutation';
  assert.deepEqual(f.store.read(request.operationId).record.envelope, record.envelope);
});

test('source/capacity/current guards reject before dispatch publication and prepared runs require a fresh active fence', async t => {
  const f = await browserOperationFixture(t), request = f.request(), name = f.contract.sourceEvidence[0].sourceFile;
  const original = f.sourceFiles.get(name); f.sourceFiles.set(name, Buffer.from(original).fill(0));
  assert.throws(() => f.publish(request), rejects('SOURCE_FILES_MISMATCH')); assert.equal(existsSync(join(f.root, 'browser-operations')), false);
  f.sourceFiles.set(name, original);
  assert.throws(() => f.publish(request, { assertCurrent: () => false }), rejects('INACTIVE')); assert.equal(existsSync(join(f.root, 'browser-operations')), false);
  const limited = createBrowserOperationStore({ owner: f.owner, limits: { operations: 0 } });
  assert.throws(() => limited.publish({ ...f, request }), rejects('OPERATION_CAPACITY')); assert.equal(existsSync(join(f.root, 'browser-operations')), false);
  f.publish(request);
  assert.throws(() => f.store.createRun(request.operationId, { assertActive: () => false }), rejects('INACTIVE'));
  assert.equal(existsSync(join(folder(f, request.operationId), 'head.json')), false);
  const first = f.contract.sourceEvidence[0], sourcePath = join(folder(f, request.operationId), 'evidence', first.file), bytes = readFileSync(sourcePath);
  writeFileSync(sourcePath, Buffer.concat([bytes, Buffer.from('change')]));
  assert.throws(() => f.store.createRun(request.operationId), rejects('SOURCE_FILES_CHANGED'));
  assert.equal(existsSync(join(folder(f, request.operationId), 'head.json')), false);
  writeFileSync(sourcePath, bytes);
  f.store.createRun(request.operationId); assert.equal(f.store.read(request.operationId).state, 'running');
  assert.throws(() => f.store.createRun(request.operationId), rejects('RUN_ALREADY_CREATED', 'BROWSER_OPERATION_CONFLICT'));
});

test('finish commits a failed detector result as completed and strictly verifies report and all indexed evidence on reads', async t => {
  const f = await browserOperationFixture(t), result = operation(f, { bug: true }), id = result.request.operationId;
  const value = f.store.read(id), report = value.report;
  assert.equal(value.state, 'completed'); assert.equal(report.gate, 'failed'); assert.equal(value.head.gate, 'failed');
  assert.equal(report.summary.bugs, 1); assert.match(report.verifierFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.operationId, id); assert.equal(report.taskId, result.run.taskId);
  assert.equal(f.store.ledger(f.project.id).entries.length, 0, 'completion alone must not register observations');
  const evidence = f.store.readEvidence(id, report.evidenceManifest[0].file), expected = Buffer.from(evidence.bytes); evidence.bytes.fill(0);
  assert.deepEqual(f.store.readEvidence(id, evidence.file).bytes, expected);
  assert.throws(() => f.store.readEvidence(id, '../dispatch.json'), rejects('INVALID_EVIDENCE', 'INVALID_INPUT'));
  const target = join(result.run.outputDir, report.checks[0].evidence.targetDetails), bytes = readFileSync(target);
  writeFileSync(target, Buffer.concat([bytes, Buffer.from('change')])); assert.throws(() => f.store.read(id), rejects('EVIDENCE_CHANGED'));
  writeFileSync(target, bytes); assert.equal(f.store.read(id).report.gate, 'failed');
  const reportPath = join(folder(f, id), 'report.json'), reportBytes = readFileSync(reportPath);
  writeFileSync(reportPath, Buffer.concat([reportBytes, Buffer.from(' ')])); assert.throws(() => f.store.read(id), rejects('REPORT_CHANGED'));
  writeFileSync(reportPath, reportBytes);
  const headPath = join(folder(f, id), 'head.json'), h = json(headPath); writeJson(headPath, { ...h, gate: 'passed' });
  assert.throws(() => f.store.read(id), rejects('REPORT_GATE_MISMATCH')); writeJson(headPath, h);
  assert.throws(() => f.store.finishRun(id, result.raw), rejects('RUN_NOT_RUNNING', 'BROWSER_OPERATION_CONFLICT'));
});

test('a cancelled active guard cannot publish results; held settlement preserves prepared and terminal facts', async t => {
  const f = await browserOperationFixture(t), request = f.request(); f.publish(request);
  assert.equal(f.store.settleRun(request.operationId, { status: 'interrupted', reasonCode: 'CANCELLED' }).state, 'prepared');
  const run = f.store.createRun(request.operationId), raw = browserOperationRaw(f, run);
  assert.throws(() => f.store.finishRun(request.operationId, raw, { assertActive: () => false }), rejects('INACTIVE'));
  assert.equal(existsSync(join(folder(f, request.operationId), 'report.json')), false);
  assert.equal(f.store.read(request.operationId).state, 'running');
  assert.throws(() => f.store.settleRun(request.operationId, { status: 'interrupted', reasonCode: 'CANCELLED' }, { assertHeld: () => false }), rejects('INACTIVE'));
  const settled = f.store.settleRun(request.operationId, { status: 'interrupted', reasonCode: 'CANCELLED' });
  assert.equal(settled.state, 'interrupted'); assert.equal(settled.head.reasonCode, 'CANCELLED');
  assert.equal(f.store.settleRun(request.operationId, { status: 'failed', reasonCode: 'EXECUTION_FAILED' }).head.reasonCode, 'CANCELLED');
});

test('whole-batch recovery rejects a later malformed head before touching any running operation, then never starts prepared work', async t => {
  const f = await browserOperationFixture(t), a = f.request(), b = f.request(), prepared = f.request();
  for (const request of [a, b, prepared]) f.publish(request);
  f.store.createRun(a.operationId); f.store.createRun(b.operationId);
  const firstPath = join(folder(f, a.operationId), 'head.json'), badPath = join(folder(f, b.operationId), 'head.json');
  const first = readFileSync(firstPath), original = readFileSync(badPath); writeFileSync(badPath, '{');
  assert.throws(() => f.store.recover()); assert.deepEqual(readFileSync(firstPath), first);
  writeFileSync(badPath, original); writeFileSync(join(folder(f, a.operationId), 'report.json'), '{partial');
  assert.deepEqual(f.store.recover(), { schemaVersion: 1, inspected: 3, interrupted: 2, prepared: 1 });
  for (const id of [a.operationId, b.operationId]) {
    assert.equal(f.store.read(id).state, 'interrupted'); assert.equal(f.store.read(id).head.reasonCode, 'ENGINE_RESTARTED');
  }
  assert.equal(f.store.read(prepared.operationId).state, 'prepared');
  assert.equal(readFileSync(join(folder(f, a.operationId), 'report.json'), 'utf8'), '{partial');
});

test('explicit immutable check observations verify fixes, reopen regressions and preserve unverified missing checks', async t => {
  const f = await browserOperationFixture(t), failed = operation(f, { bug: true }), passed = operation(f);
  const first = f.store.registerResult(failed.request.operationId);
  assert.equal(first.observations.length, 1); assert.equal(first.observations[0].relation, 'observed_failure');
  const fixed = f.store.registerResult(passed.request.operationId, { beforeOperationId: failed.request.operationId });
  assert.equal(fixed.observations[0].relation, 'verified_passed');
  const again = f.store.registerResult(passed.request.operationId, { beforeOperationId: failed.request.operationId });
  assert.equal(again.replayed, true); assert.equal(again.recordedAt, fixed.recordedAt);
  assert.throws(() => f.store.registerResult(passed.request.operationId), rejects('OBSERVATION_CONFLICT', 'IDEMPOTENCY_CONFLICT'));
  let ledger = f.store.ledger(f.project.id); assert.equal(ledger.issues[0].status, 'verified_passed'); assert.equal(ledger.closesBugs, false);
  const reopened = operation(f, { bug: true }); f.store.registerResult(reopened.request.operationId, { beforeOperationId: passed.request.operationId });
  ledger = f.store.ledger(f.project.id); assert.equal(ledger.issues.length, 1); assert.equal(ledger.issues[0].status, 'reopened');
  assert.equal(ledger.issues[0].history.at(-1).relation, 'reopened'); assert.equal(ledger.issues[0].history.length, 3);
  const req = f.request(); f.publish(req); const run = f.store.createRun(req.operationId), raw = browserOperationRaw(f, run);
  raw.checks = [{ id: 'runner-environment', route: '/', status: 'blocked', verdict: 'environment', evidence: {} }]; raw.coverage.completed = 1;
  f.store.finishRun(req.operationId, raw); const missing = f.store.registerResult(req.operationId, { beforeOperationId: reopened.request.operationId });
  assert.equal(missing.observations[0].relation, 'unverified');
  ledger = f.store.ledger(f.project.id); assert.equal(ledger.issues[0].status, 'unverified'); assert.equal(ledger.issues[0].lastVerifiedState, 'reopened');
  const restarted = createBrowserOperationStore({ owner: f.owner }); assert.deepEqual(restarted.ledger(f.project.id), ledger);
});

test('incomparable environments and tampered observation files cannot close or replay an issue', async t => {
  const f = await browserOperationFixture(t), failed = operation(f, { bug: true }); f.store.registerResult(failed.request.operationId);
  const request = f.request(); f.publish(request); const run = f.store.createRun(request.operationId);
  const environment = { ...f.contract.fixedBaseline.sourceEnvironment, browserVersion: 'different-browser-version' }, raw = browserOperationRaw(f, run, { environment });
  for (const check of raw.checks) { check.status = 'blocked'; check.verdict = 'environment'; check.evaluationLimited = true; }
  f.store.finishRun(request.operationId, raw); const observation = f.store.registerResult(request.operationId, { beforeOperationId: failed.request.operationId });
  assert.equal(observation.observations[0].relation, 'incomparable'); assert.equal(f.store.ledger(f.project.id).issues[0].status, 'unverified');
  const path = join(folder(f, request.operationId), 'observations.json'), original = readFileSync(path), changed = copy(observation);
  delete changed.replayed; changed.observations[0].relation = 'verified_passed'; writeJson(path, changed);
  assert.throws(() => f.store.registerResult(request.operationId, { beforeOperationId: failed.request.operationId }), rejects('OBSERVATION_CHANGED'));
  assert.throws(() => f.store.ledger(f.project.id), rejects('OBSERVATION_CHANGED'));
  writeFileSync(path, original); assert.equal(f.store.ledger(f.project.id).issues[0].status, 'unverified');
});

test('registered issue lineage survives consecutive pass, blocked, missing, environment recovery and reopened runs', async t => {
  const f = await browserOperationFixture(t), ids = [], registrations = [];
  const register = (value, before) => {
    const operationId = value.request.operationId, input = before ? { beforeOperationId: before.request.operationId } : {};
    const result = f.store.registerResult(operationId, input); ids.push(operationId); registrations.push(result);
    assert.equal(result.observations.length, 1);
    assert.equal(result.beforeObservationSha256, before ? observationDigest(f, before.request.operationId) : null);
    assert.equal(f.store.registerResult(operationId, input).replayed, true);
    return result.observations[0];
  };
  const first = operation(f, { bug: true }); assert.equal(register(first).relation, 'observed_failure');
  const fixed = operation(f); assert.equal(register(fixed, first).relation, 'verified_passed');
  const stillPassed = operation(f); assert.equal(register(stillPassed, fixed).relation, 'verified_passed');
  const blocked = limitedOperation(f); assert.equal(register(blocked, stillPassed).relation, 'unverified');
  let issue = f.store.ledger(f.project.id).issues[0];
  assert.equal(issue.status, 'unverified'); assert.equal(issue.lastVerifiedState, 'verified_passed');
  const recovered = operation(f); assert.equal(register(recovered, blocked).relation, 'verified_passed');
  const missing = limitedOperation(f, { missing: true }); assert.equal(register(missing, recovered).relation, 'unverified');
  issue = f.store.ledger(f.project.id).issues[0]; assert.equal(issue.status, 'unverified'); assert.equal(issue.lastVerifiedState, 'verified_passed');
  const recoveredMissing = operation(f), missingResult = register(recoveredMissing, missing);
  assert.equal(missingResult.relation, 'verified_passed'); assert.equal(missingResult.beforeCheckId, null);
  const changedEnvironment = { ...f.contract.fixedBaseline.sourceEnvironment, browserVersion: 'another-browser-version' };
  const incomparable = limitedOperation(f, { environment: changedEnvironment }); assert.equal(register(incomparable, recoveredMissing).relation, 'incomparable');
  issue = f.store.ledger(f.project.id).issues[0]; assert.equal(issue.status, 'unverified'); assert.equal(issue.lastVerifiedState, 'verified_passed');
  const reopened = operation(f, { bug: true }); register(reopened, incomparable);
  let ledger = f.store.ledger(f.project.id); issue = ledger.issues[0];
  assert.equal(issue.status, 'reopened'); assert.equal(issue.lastVerifiedState, 'reopened');
  assert.equal(issue.history.at(-1).relation, 'reopened'); assert.equal(issue.history.length, ids.length);
  assert.deepEqual(issue.history.map(value => value.operationId), ids); assert.equal(ledger.entries.length, ids.length);
  assert.deepEqual(ledger.entries.map(value => value.observations[0].identity), ids.map(() => registrations[0].observations[0].identity));
  const recoveredAgain = operation(f); assert.equal(register(recoveredAgain, reopened).relation, 'verified_passed');
  ledger = f.store.ledger(f.project.id); assert.equal(ledger.issues[0].status, 'verified_passed');
  assert.equal(ledger.issues[0].history.length, ids.length); assert.equal(ledger.issues[0].latestOperationId, recoveredAgain.request.operationId);
  const restarted = createBrowserOperationStore({ owner: f.owner }); assert.deepEqual(restarted.ledger(f.project.id), ledger);
  assert.equal(restarted.registerResult(recoveredAgain.request.operationId, { beforeOperationId: reopened.request.operationId }).replayed, true);
});

test('late before registration cannot change an existing observation, while pinned lineage rejects changed bytes', async t => {
  const f = await browserOperationFixture(t), failed = operation(f, { bug: true }), passed = operation(f);
  const blocked = limitedOperation(f), beforeId = passed.request.operationId, afterId = blocked.request.operationId;
  const original = f.store.registerResult(afterId, { beforeOperationId: beforeId });
  assert.equal(original.beforeObservationSha256, null); assert.deepEqual(original.observations, []);
  const originalBytes = readFileSync(join(folder(f, afterId), 'observations.json'));
  f.store.registerResult(beforeId, { beforeOperationId: failed.request.operationId });
  assert.equal(f.store.registerResult(afterId, { beforeOperationId: beforeId }).replayed, true);
  assert.deepEqual(readFileSync(join(folder(f, afterId), 'observations.json')), originalBytes);
  assert.deepEqual(createBrowserOperationStore({ owner: f.owner }).ledger(f.project.id), f.store.ledger(f.project.id));
  const recovery = operation(f), pinned = f.store.registerResult(recovery.request.operationId, { beforeOperationId: beforeId });
  assert.equal(pinned.observations[0].relation, 'verified_passed'); assert.equal(pinned.beforeObservationSha256, observationDigest(f, beforeId));
  const beforePath = join(folder(f, beforeId), 'observations.json'), beforeBytes = readFileSync(beforePath);
  writeFileSync(beforePath, Buffer.concat([beforeBytes, Buffer.from(' ')]));
  assert.throws(() => f.store.registerResult(recovery.request.operationId, { beforeOperationId: beforeId }), rejects('OBSERVATION_LINEAGE_CHANGED'));
  assert.throws(() => f.store.ledger(f.project.id), rejects('OBSERVATION_LINEAGE_CHANGED'));
  writeFileSync(beforePath, beforeBytes); assert.equal(f.store.ledger(f.project.id).issues[0].status, 'verified_passed');
});

test('lineage checks reject cycles and cumulative operation capacity before writing a registration', async t => {
  const f = await browserOperationFixture(t), ActualDate = Date, stamp = Date.now();
  let a, b;
  try {
    globalThis.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : [stamp])); } static now() { return stamp; } };
    a = operation(f, { bug: true }); b = operation(f);
  } finally { globalThis.Date = ActualDate; }
  f.store.registerResult(a.request.operationId, { beforeOperationId: b.request.operationId });
  assert.throws(() => f.store.registerResult(b.request.operationId, { beforeOperationId: a.request.operationId }), rejects('OBSERVATION_CYCLE'));
  assert.equal(existsSync(join(folder(f, b.request.operationId), 'observations.json')), false);
  const c = operation(f), constrained = createBrowserOperationStore({ owner: f.owner, limits: { operations: 2 } });
  assert.throws(() => constrained.registerResult(c.request.operationId, { beforeOperationId: a.request.operationId }), rejects('OBSERVATION_CAPACITY'));
  assert.equal(existsSync(join(folder(f, c.request.operationId), 'observations.json')), false);
});

test('hardlinked facts and partial operation directories fail closed without replacement', async t => {
  const f = await browserOperationFixture(t), request = f.request(); f.publish(request);
  const dispatch = join(folder(f, request.operationId), 'dispatch.json'), alias = join(f.root, 'dispatch-alias.json'); linkSync(dispatch, alias);
  assert.throws(() => f.store.read(request.operationId), rejects('FILE_UNSAFE')); rmSync(alias);
  assert.equal(f.store.read(request.operationId).state, 'prepared');
  const partial = f.request(); mkdirSync(folder(f, partial.operationId));
  assert.throws(() => f.store.read(partial.operationId)); assert.throws(() => f.publish(partial));
  assert.equal(existsSync(join(folder(f, partial.operationId), 'dispatch.json')), false);
});

test('guard and limit rejection never invokes async, proxy, accessor, thenable or Promise species hooks', async t => {
  const f = await browserOperationFixture(t); let hooks = 0;
  const asyncGuard = async () => { hooks++; return true; }, generator = function* () { hooks++; yield true; };
  const proxyGuard = new Proxy(() => true, { apply() { hooks++; return true; } });
  for (const assertCurrent of [asyncGuard, generator, proxyGuard])
    assert.throws(() => f.publish(f.request(), { assertCurrent }), rejects('INVALID_GUARD', 'INVALID_INPUT'));
  const thenable = {}; Object.defineProperty(thenable, 'then', { get() { hooks++; throw Error('must not read then'); } });
  const constructorPromise = Promise.resolve(true);
  Object.defineProperty(constructorPromise, 'constructor', { get() { hooks++; throw Error('must not read constructor'); } });
  const speciesPromise = Promise.resolve(true), constructor = {};
  Object.defineProperty(constructor, Symbol.species, { get() { hooks++; throw Error('must not read species'); } });
  Object.defineProperty(speciesPromise, 'constructor', { value: constructor });
  for (const value of [thenable, constructorPromise, speciesPromise, Promise.reject(Error('returned rejected guard'))])
    assert.throws(() => f.publish(f.request(), { assertCurrent: () => value }), rejects('INACTIVE', 'BROWSER_OPERATION_INACTIVE'));
  assert.throws(() => f.publish(f.request(), { assertCurrent() { throw Promise.reject(Error('thrown rejected guard')); } }), rejects());
  const getterLimits = {}; Object.defineProperty(getterLimits, 'operations', { enumerable: true, get() { hooks++; return 0; } });
  const proxyLimits = new Proxy({}, { ownKeys() { hooks++; return []; }, getPrototypeOf() { hooks++; return Object.prototype; } });
  for (const limits of [getterLimits, proxyLimits]) assert.throws(() => createBrowserOperationStore({ owner: f.owner, limits }), rejects('INVALID_LIMITS', 'INVALID_INPUT'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks, 0); assert.equal(existsSync(join(f.root, 'browser-operations')), false);
});
