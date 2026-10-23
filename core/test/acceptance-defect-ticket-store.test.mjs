/** Offline persistence boundaries only. No Browser, engine, or external I/O. */
import test, { after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readFileSync, writeFileSync, readdirSync,
  appendFileSync, renameSync, linkSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { DefectTicketError, defectTicketRequestFingerprint, defectTicketMemberSetDigest,
  defectTicketEventBytes, defectTicketRejectionBytes } from '../src/acceptance/defect-ticket-schema.mjs';
import { createDefectTicketStore, DEFECT_TICKET_STORE_LIMITS } from '../src/acceptance/defect-ticket-store.mjs';

const uid = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const h = value => createHash('sha256').update(String(value)).digest('hex');
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const projectId = uid('ap', 1), otherProject = uid('ap', 2);
// 默认放系统临时目录、跑完清掉；只有设了 D5_STORE_EVIDENCE_ROOT 才留盘（收集证据用）。
// 以前的默认值是相对「当前工作目录」的 core/workspace/_runs/...：pnpm test 的 cwd 是 core/，
// 于是每跑一次就在 core/core/workspace/ 下留一堆目录（被 gitignore 盖住，一直没人发现）。
const keepEvidence = Boolean(process.env.D5_STORE_EVIDENCE_ROOT);
const evidenceRoot = keepEvidence ? resolve(process.env.D5_STORE_EVIDENCE_ROOT) : mkdtempSync(join(tmpdir(), 'heimdall-d5-store-'));
mkdirSync(evidenceRoot, { recursive: true });
if (!keepEvidence) afterAll(() => { try { rmSync(evidenceRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 清理失败不该让测试变红 */ } });
function createEvent(n = 1, project = projectId, ticket = n) {
  const request = { ticketId: uid('dt', ticket), actionId: uid('da', n), sourceOperationId: uid('bo', n), memberCheckIds: ['desktop'],
    title: 'Menu does not expand', severity: 'high', description: 'Panel is missing.', reproduction: '1. Open menu\n2. Observe panel' };
  const member = { checkId: 'desktop', bugId: 'bug-' + h('bug-' + n), route: '/',
    identity: { version: 1, kind: 'browser', facet: 'visual', caseKey: h('case'), contextKey: h('context'), ruleKey: h('rule'),
      oracleKey: h('oracle'), environmentKey: h('environment'), viewport: { width: 960, height: 640 } },
    verifierFingerprint: h('verifier'), evidence: [{ role: 'targetScreenshot', file: 'target.png', bytes: 17, sha256: h('image') }] };
  return { ticketContractVersion: 1, kind: 'create', ticketId: request.ticketId, actionId: request.actionId,
    projectId: project, candidateId: uid('bc', 1), contentDigest: h('content'), revision: 0, previousEventSha256: null,
    requestFingerprint: defectTicketRequestFingerprint({ projectId: project, ticketId: request.ticketId, kind: 'create', request }),
    createdAt: '2026-10-18T00:00:00.000Z', actor: { kind: 'local-operator' },
    title: request.title, severity: request.severity, description: request.description, reproduction: request.reproduction,
    source: { operationId: request.sourceOperationId, targetReleaseId: uid('ar', n), acceptedAt: '2026-10-17T23:00:00.000Z',
      recordedAt: '2026-10-17T23:01:00.000Z', dispatchSha256: h('dispatch-' + n), reportSha256: h('report-' + n), observationsSha256: h('observations-' + n) },
    members: [member], memberSetDigest: defectTicketMemberSetDigest([member]) };
}
function closeEvent(first, { action = 101, revision = 1, previous = hashBytes(defectTicketEventBytes(first)), hour = 1 } = {}) {
  const after = { ...first.source, operationId: uid('bo', action), targetReleaseId: uid('ar', action),
    acceptedAt: `2026-10-18T0${hour}:00:00.000Z`, recordedAt: `2026-10-18T0${hour}:01:00.000Z` };
  const request = { actionId: uid('da', action), afterOperationId: after.operationId, expectedRevision: revision - 1,
    expectedHeadSha256: previous, memberSetDigest: first.memberSetDigest, factsDigest: h('facts-' + action),
    previewDigest: h('preview-' + action), resolution: 'Restored the menu trigger.', confirmed: true };
  return { ticketContractVersion: 1, kind: 'close', ticketId: first.ticketId, actionId: request.actionId,
    projectId: first.projectId, candidateId: first.candidateId, contentDigest: first.contentDigest,
    revision, previousEventSha256: previous, requestFingerprint: defectTicketRequestFingerprint({ projectId: first.projectId,
      ticketId: first.ticketId, kind: 'close', request }), createdAt: `2026-10-18T0${hour}:02:00.000Z`, actor: { kind: 'local-operator' },
    after, memberSetDigest: first.memberSetDigest, factsDigest: request.factsDigest, previewDigest: request.previewDigest,
    results: [{ bugId: first.members[0].bugId, sourceCheckId: 'desktop', afterCheckId: 'renamed-desktop', relation: 'verified_passed' }],
    resolution: request.resolution, confirmed: true };
}
function fixture(t, limits) {
  const root = realpathSync(mkdtempSync(join(evidenceRoot, 'fixture-'))), owner = acquireAcceptanceOwner({ root });
  const store = createDefectTicketStore({ owner, ...(limits ? { limits } : {}) });
  t.after(() => { owner.release(); });
  return { root, owner, store, events: join(root, 'defect-tickets', 'v1', 'events') };
}
const args = (event, assertCurrent = () => true) => ({ projectId: event.projectId, actionId: event.actionId,
  requestFingerprint: event.requestFingerprint, prepare: () => ({ event, assertCurrent }) });
const put = (store, event, guard) => store.append(args(event, guard));
const reason = expected => error => { assert.equal(error.details?.reason, expected); return true; };
function assertBlocked(fn) { assert.throws(fn, { code: 'INTEGRITY_BLOCKED', status: 503 }); }
function namespace(f) { mkdirSync(f.events, { recursive: true }); }
const finalPath = (f, event) => join(f.events, event.actionId + '.json');

test('read-only snapshot/action do not create namespace and retain the absence fence', t => {
  const f = fixture(t), snapshot = f.store.snapshot(projectId);
  assert.deepEqual(snapshot.tickets, []); assert.deepEqual(snapshot.records, []);
  assert.equal(f.store.action(projectId, uid('da', 1)), null);
  assert.equal(existsSync(join(f.root, 'defect-tickets')), false);
  assert.equal(snapshot.assertCurrent(), true);
  mkdirSync(join(f.root, 'defect-tickets'));
  assert.throws(snapshot.assertCurrent, { code: 'STALE_TICKET', status: 409 });
  assertBlocked(() => f.store.snapshot(projectId));
  assert.deepEqual(readdirSync(join(f.root, 'defect-tickets')), [], 'partial namespace is preserved without repair');
});

test('canonical create/close/reclose events survive owner restart with identical original bytes', async t => {
  const f = fixture(t), first = createEvent(), initial = await put(f.store, first), bytes = readFileSync(finalPath(f, first));
  assert.equal(initial.replayed, false); assert.equal(initial.record.sha256, hashBytes(bytes));
  assert.deepEqual(bytes, defectTicketEventBytes(first));
  const old = f.store.snapshot(projectId), close = closeEvent(first), closed = await put(f.store, close);
  assert.throws(old.assertCurrent, { code: 'STALE_TICKET' });
  const again = closeEvent(first, { action: 102, revision: 2, previous: closed.record.sha256, hour: 2 });
  await put(f.store, again);
  const before = f.store.snapshot(projectId);
  assert.equal(before.tickets.length, 1); assert.deepEqual(before.records.map(value => value.event.revision), [0, 1, 2]);
  assert.equal(Object.isFrozen(before.records[0].event.members[0].identity.viewport), true);
  assert.throws(() => { before.records[0].event.title = 'changed'; }, TypeError);
  assert.equal(f.owner.release(), true);
  const restartedOwner = acquireAcceptanceOwner({ root: f.root }); t.after(() => restartedOwner.release());
  const restarted = createDefectTicketStore({ owner: restartedOwner });
  assert.deepEqual(restarted.snapshot(projectId).records, before.records);
  assert.deepEqual(readFileSync(finalPath(f, first)), bytes);
  assert.deepEqual(readdirSync(f.events).sort(), [first, close, again].map(event => event.actionId + '.json').sort());
});

test('action identity is globally unique and cross-project reads/replays return 404', async t => {
  const f = fixture(t), first = createEvent(), foreign = createEvent(2, otherProject);
  await put(f.store, first); await put(f.store, foreign); let prepared = 0;
  const replayed = await f.store.append({ ...args(first), prepare() { prepared++; throw new Error('must not execute'); } });
  assert.equal(replayed.replayed, true); assert.equal(prepared, 0);
  await assert.rejects(f.store.append({ ...args(first), requestFingerprint: h('changed') }), { code: 'ACTION_CONFLICT', status: 409 });
  await assert.rejects(f.store.append({ ...args(first), projectId: otherProject }), { code: 'NOT_FOUND', status: 404 });
  await assert.rejects(f.store.append({ ...args(foreign), projectId }), { code: 'NOT_FOUND', status: 404 });
  assert.throws(() => f.store.action(otherProject, first.actionId), { code: 'NOT_FOUND', status: 404 });
  assert.throws(() => f.store.action(projectId, foreign.actionId), { code: 'NOT_FOUND', status: 404 });
  assert.deepEqual(f.store.action(projectId, first.actionId).event, first);
  assert.deepEqual(f.store.action(otherProject, foreign.actionId).event, foreign);
  assert.deepEqual(f.store.snapshot(projectId).records.map(record => record.event.actionId), [first.actionId]);
  assert.deepEqual(f.store.snapshot(otherProject).records.map(record => record.event.actionId), [foreign.actionId]);
});

test('one independent queue takes fresh records and allows only one stale-head close', async t => {
  const f = fixture(t), first = createEvent(); await put(f.store, first);
  const one = closeEvent(first), two = closeEvent(first, { action: 102 }), seen = [];
  const append = event => f.store.append({ ...args(event), prepare(records) {
    seen.push(records.map(record => record.event.revision)); return { event, assertCurrent: () => true };
  } });
  const outcomes = await Promise.allSettled([append(one), append(two)]);
  assert.deepEqual(seen, [[0], [0, 1]]); assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected'); assert.equal(outcomes[1].reason.code, 'STALE_TICKET');
  assert.equal(f.store.snapshot(projectId).records.length, 2);
  assert.equal(existsSync(finalPath(f, two)), false); assert.equal(readdirSync(f.events).some(name => name.endsWith('.tmp')), false);
});

test('pending queue capacity is exact, releases on either outcome, and zero blocks writes', async t => {
  const f = fixture(t, { queue: 1 }), first = createEvent(), pending = put(f.store, first);
  await assert.rejects(put(f.store, createEvent(2)), { code: 'CAPACITY' }); await pending;
  await put(f.store, createEvent(2));
  await assert.rejects(f.store.append({ ...args(createEvent(3)), prepare() { throw new Error('failure'); } }), { code: 'INTEGRITY_BLOCKED' });
  await put(f.store, createEvent(3));
  const zero = fixture(t, { queue: 0 }); await assert.rejects(put(zero.store, first), { code: 'CAPACITY' });
  assert.equal(existsSync(join(zero.root, 'defect-tickets')), false);
});

test('options, callbacks, results and callback errors reject hooks without invoking them', async t => {
  const f = fixture(t), first = createEvent(); let hooks = 0;
  const getter = {}; Object.defineProperty(getter, 'owner', { enumerable: true, get() { hooks++; return f.owner; } });
  const proxy = new Proxy({}, { get() { hooks++; }, ownKeys() { hooks++; return []; }, getPrototypeOf() { hooks++; return null; } });
  for (const input of [getter, proxy]) assert.throws(() => createDefectTicketStore(input), { code: 'INVALID_INPUT' });
  const limitsGetter = {}; Object.defineProperty(limitsGetter, 'actions', { enumerable: true, get() { hooks++; return 1; } });
  assert.throws(() => createDefectTicketStore({ owner: f.owner, limits: limitsGetter }), { code: 'INVALID_INPUT' });
  const fakeOwner = {}; Object.defineProperty(fakeOwner, 'root', { get() { hooks++; return f.root; } });
  assert.throws(() => createDefectTicketStore({ owner: fakeOwner }), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE' });
  const requestGetter = {}; Object.defineProperty(requestGetter, 'prepare', { enumerable: true, get() { hooks++; } });
  for (const input of [requestGetter, proxy]) await assert.rejects(f.store.append(input), { code: 'INVALID_INPUT' });
  for (const prepare of [async () => { hooks++; }, function* () { hooks++; }, (async () => { hooks++; }).bind(null),
    (function* () { hooks++; }).bind(null), (() => { hooks++; }).bind(null), new Proxy(() => {}, { apply() { hooks++; } })])
    await assert.rejects(f.store.append({ ...args(first), prepare }), { code: 'INVALID_INPUT' });
  const thenable = {}; Object.defineProperty(thenable, 'then', { enumerable: true, get() { hooks++; return () => hooks++; } });
  const guardGetter = { event: first }; Object.defineProperty(guardGetter, 'assertCurrent', { enumerable: true, get() { hooks++; } });
  for (const result of [thenable, guardGetter, proxy, Promise.reject(new Error('native rejected result'))])
    await assert.rejects(f.store.append({ ...args(first), prepare: () => result }), { code: 'INVALID_INPUT' });
  for (const assertCurrent of [async () => { hooks++; }, function* () { hooks++; }, (async () => { hooks++; }).bind(null),
    (function* () { hooks++; }).bind(null), (() => { hooks++; }).bind(null), new Proxy(() => {}, { apply() { hooks++; } }),
    () => thenable, () => proxy, () => Promise.reject(new Error('native rejected guard'))])
    await assert.rejects(f.store.append({ ...args(first), prepare: () => ({ event: first, assertCurrent }) }), { code: 'INVALID_INPUT' });
  for (const thrown of [proxy, Promise.reject(new Error('native rejected throw'))])
    await assert.rejects(f.store.append({ ...args(first), prepare() { throw thrown; } }), { code: 'INTEGRITY_BLOCKED' });
  const maliciousError = new DefectTicketError(); Object.defineProperty(maliciousError, 'code', { get() { hooks++; return 'STALE_FACTS'; } });
  await assert.rejects(f.store.append({ ...args(first), prepare() { throw maliciousError; } }), { code: 'INTEGRITY_BLOCKED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks, 0); assert.equal(existsSync(join(f.root, 'defect-tickets')), false);
});

test('prepare cannot change namespace or source after capture and before admission', async t => {
  const source = fixture(t), first = createEvent(); let sourceCurrent = true;
  await assert.rejects(source.store.append({ ...args(first), prepare() { sourceCurrent = false;
    return { event: first, assertCurrent() { if (!sourceCurrent) throw new DefectTicketError('STALE_FACTS', 409, 'SOURCE_CHANGED'); } };
  } }), { code: 'STALE_FACTS', status: 409 });
  assert.equal(existsSync(join(source.root, 'defect-tickets')), false);
  const changed = fixture(t);
  await assert.rejects(changed.store.append({ ...args(first), prepare() { namespace(changed);
    writeFileSync(join(changed.events, 'unexpected.tmp'), 'preserve'); return { event: first, assertCurrent: () => true };
  } }), { code: 'STALE_TICKET', status: 409 });
  assert.equal(readFileSync(join(changed.events, 'unexpected.tmp'), 'utf8'), 'preserve');
  assert.equal(existsSync(finalPath(changed, first)), false);
});

test('positive raw-byte fences detect original event mutation during prepare', async t => {
  const f = fixture(t), first = createEvent(); await put(f.store, first); const original = readFileSync(finalPath(f, first));
  const close = closeEvent(first);
  await assert.rejects(f.store.append({ ...args(close), prepare() { appendFileSync(finalPath(f, first), '\n');
    return { event: close, assertCurrent: () => true }; } }), { code: 'STALE_TICKET' });
  assert.deepEqual(readFileSync(finalPath(f, first)), Buffer.concat([original, Buffer.from('\n')]));
  assert.equal(existsSync(finalPath(f, close)), false); assertBlocked(() => f.store.action(projectId, first.actionId));
});

test('only this invocation exact tracked temp is tolerated; failed preparation residue is preserved', async t => {
  const success = fixture(t), first = createEvent(); let sawTracked = false;
  await put(success.store, first, () => {
    if (existsSync(success.events) && readdirSync(success.events).some(name => name.endsWith('.tmp'))) {
      sawTracked = true; assert.equal(success.store.snapshot(projectId).records.length, 0);
    }
  });
  assert.equal(sawTracked, true);
  const failed = fixture(t);
  await assert.rejects(put(failed.store, first, () => {
    if (existsSync(failed.events) && readdirSync(failed.events).some(name => name.endsWith('.tmp')))
      throw new DefectTicketError('STALE_FACTS', 409, 'SOURCE_CHANGED');
  }), error => { assert.equal(error.code, 'STALE_FACTS'); assert.equal(error.writeMayHaveCommitted, undefined); return true; });
  const names = readdirSync(failed.events); assert.equal(names.length, 1); assert.match(names[0], /^\.defect-ticket-.*\.tmp$/);
  const residue = readFileSync(join(failed.events, names[0])); assert.deepEqual(residue, defectTicketEventBytes(first));
  assertBlocked(() => failed.store.snapshot(projectId)); assert.deepEqual(readFileSync(join(failed.events, names[0])), residue);
});

test('post-publication failure is explicitly uncertain and action can reconcile a durable receipt', async t => {
  const f = fixture(t), first = createEvent();
  await assert.rejects(put(f.store, first, () => {
    if (existsSync(finalPath(f, first))) throw new DefectTicketError('STALE_FACTS', 409, 'SOURCE_CHANGED');
  }), error => { assert.equal(error.code, 'STALE_FACTS'); assert.equal(error.writeMayHaveCommitted, true); return true; });
  assert.deepEqual(f.store.action(projectId, first.actionId).event, first);
  assert.deepEqual(readdirSync(f.events), [first.actionId + '.json']);
  const replay = await put(f.store, first, () => { throw new Error('replay needs no new source claim'); });
  assert.equal(replay.replayed, true);
});

test('post-publication namespace mutation cannot be returned as a successful receipt', async t => {
  const f = fixture(t), first = createEvent();
  await assert.rejects(put(f.store, first, () => {
    if (existsSync(finalPath(f, first))) writeFileSync(join(f.events, 'extra.tmp'), 'preserved');
  }), error => { assert.equal(error.writeMayHaveCommitted, true); return true; });
  assert.equal(existsSync(finalPath(f, first)), true); assert.equal(readFileSync(join(f.events, 'extra.tmp'), 'utf8'), 'preserved');
  assertBlocked(() => f.store.snapshot(projectId));
});

test('owner release and canonical root replacement stop reads and writes', async t => {
  const released = fixture(t), empty = released.store.snapshot(projectId); released.owner.release();
  assert.throws(empty.assertCurrent, { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.throws(() => released.store.snapshot(projectId), { code: 'ACCEPTANCE_OWNER_LOST' });
  await assert.rejects(put(released.store, createEvent()), { code: 'ACCEPTANCE_OWNER_LOST' });
  const changed = fixture(t); await put(changed.store, createEvent());
  renameSync(changed.root, changed.root + '-original'); mkdirSync(changed.root);
  assert.throws(() => changed.store.snapshot(projectId), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.equal(readdirSync(changed.root).length, 0);
});

test('replaced directories, junctions, symlink files and hardlinked originals fail closed', async t => {
  const replaced = fixture(t); await put(replaced.store, createEvent());
  renameSync(replaced.events, replaced.events + '-original'); mkdirSync(replaced.events);
  assertBlocked(() => replaced.store.snapshot(projectId));
  const junction = fixture(t); await put(junction.store, createEvent());
  renameSync(junction.events, junction.events + '-original'); symlinkSync(junction.events + '-original', junction.events, 'junction');
  assertBlocked(() => junction.store.snapshot(projectId));
  const hard = fixture(t), first = createEvent(); await put(hard.store, first);
  linkSync(finalPath(hard, first), join(hard.root, 'outside-original.json'));
  assertBlocked(() => hard.store.snapshot(projectId));
  const symbolic = fixture(t); namespace(symbolic); const outside = join(symbolic.root, 'outside.json');
  writeFileSync(outside, defectTicketEventBytes(first));
  try { symlinkSync(outside, finalPath(symbolic, first), 'file'); }
  catch (error) { if (['EPERM', 'ENOTSUP'].includes(error.code)) { t.diagnostic('file symlink privilege unavailable; junction and hardlink boundaries exercised'); return; } throw error; }
  assertBlocked(() => symbolic.store.snapshot(projectId));
});

test('unknown files, foreign corrupt JSON and canonical mismatches are never filtered or repaired', async t => {
  const unknown = fixture(t); await put(unknown.store, createEvent()); writeFileSync(join(unknown.events, '.unknown.tmp'), 'preserved');
  assertBlocked(() => unknown.store.snapshot(otherProject)); assert.equal(readFileSync(join(unknown.events, '.unknown.tmp'), 'utf8'), 'preserved');
  const foreign = fixture(t), foreignEvent = createEvent(2, otherProject); await put(foreign.store, createEvent()); await put(foreign.store, foreignEvent);
  writeFileSync(finalPath(foreign, foreignEvent), '{broken'); assertBlocked(() => foreign.store.snapshot(projectId));
  assert.equal(readFileSync(finalPath(foreign, foreignEvent), 'utf8'), '{broken');
  const noncanonical = fixture(t), first = createEvent(); await put(noncanonical.store, first);
  writeFileSync(finalPath(noncanonical, first), JSON.stringify(first, null, 2) + '\n');
  assert.throws(() => noncanonical.store.snapshot(projectId), reason('EVENT_BYTES_CHANGED'));
});

test('global chain validation rejects forks, cross-scope ticket reuse and filename identity changes', async t => {
  const forked = fixture(t), first = createEvent(); await put(forked.store, first);
  for (const close of [closeEvent(first), closeEvent(first, { action: 102 })]) writeFileSync(finalPath(forked, close), defectTicketEventBytes(close));
  assertBlocked(() => forked.store.snapshot(projectId));
  const mixed = fixture(t); await put(mixed.store, first);
  const foreign = createEvent(2, otherProject, 1);
  writeFileSync(finalPath(mixed, foreign), defectTicketEventBytes(foreign)); assertBlocked(() => mixed.store.snapshot(projectId));
  const name = fixture(t); await put(name.store, first); renameSync(finalPath(name, first), join(name.events, uid('da', 2) + '.json'));
  assert.throws(() => name.store.snapshot(projectId), reason('EVENT_BYTES_CHANGED'));
});

test('all namespace projects count toward exact action, ticket and byte budgets', async t => {
  assert.deepEqual(DEFECT_TICKET_STORE_LIMITS, { tickets: 256, actions: 4096, actionBytes: 65536, namespaceBytes: 16777216, queue: 32 });
  const f = fixture(t), first = createEvent(), foreign = createEvent(2, otherProject);
  await put(f.store, first); await put(f.store, foreign);
  const total = defectTicketEventBytes(first).length + defectTicketEventBytes(foreign).length;
  const maxAction = Math.max(defectTicketEventBytes(first).length, defectTicketEventBytes(foreign).length);
  const exact = createDefectTicketStore({ owner: f.owner, limits: { tickets: 2, actions: 2, actionBytes: maxAction, namespaceBytes: total } });
  assert.equal(exact.snapshot(projectId).records.length, 1);
  for (const limits of [{ tickets: 1 }, { actions: 1 }, { namespaceBytes: total - 1 }])
    assert.throws(() => createDefectTicketStore({ owner: f.owner, limits }).snapshot(projectId), { code: 'CAPACITY' });
  assertBlocked(() => createDefectTicketStore({ owner: f.owner, limits: { actionBytes: maxAction - 1 } }).snapshot(projectId));
  for (const limits of [{ tickets: 0 }, { actions: 0 }, { actionBytes: 0 }, { namespaceBytes: 0 }]) {
    const zero = fixture(t, limits); assert.deepEqual(zero.store.snapshot(projectId).records, []);
    await assert.rejects(put(zero.store, first), { code: 'CAPACITY' });
    assert.equal(existsSync(join(zero.root, 'defect-tickets')), false);
  }
  const full = fixture(t, { tickets: 1, actions: 2 }); await put(full.store, first); await put(full.store, closeEvent(first));
  await assert.rejects(put(full.store, createEvent(2)), { code: 'CAPACITY' });
  assert.equal(full.store.snapshot(projectId).records.length, 2);
});

test('append admission binds scope/fingerprint and rejects invalid limits or forged event scope', async t => {
  const f = fixture(t), first = createEvent();
  for (const limits of [{ actions: -1 }, { actions: 4097 }, { actionBytes: 65537 }, { queue: 1.5 }, { unknown: 1 }])
    assert.throws(() => createDefectTicketStore({ owner: f.owner, limits }), { code: 'INVALID_INPUT', status: 400 });
  await assert.rejects(f.store.append({ ...args(first), projectId: otherProject }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.store.append({ ...args(first), requestFingerprint: h('different') }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.store.append({ ...args(first), actionId: uid('da', 2) }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.store.append({ ...args(first), prepare: () => ({ event: { ...first, passed: true }, assertCurrent: () => true }) }), { code: 'INTEGRITY_BLOCKED' });
  assert.equal(existsSync(join(f.root, 'defect-tickets')), false);
});

function rejection(event = createEvent()) {
  const request = event.kind === 'create' ? { ticketId: event.ticketId, actionId: event.actionId,
    sourceOperationId: event.source.operationId, memberCheckIds: event.members.map(member => member.checkId),
    title: event.title, severity: event.severity, description: event.description, reproduction: event.reproduction }
    : { actionId: event.actionId, afterOperationId: event.after.operationId, expectedRevision: event.revision - 1,
      expectedHeadSha256: event.previousEventSha256, memberSetDigest: event.memberSetDigest,
      factsDigest: event.factsDigest, previewDigest: event.previewDigest, resolution: event.resolution, confirmed: true };
  return { actionDecisionVersion: 1, kind: 'manual-defect-ticket-action-rejection', original: { version: 1,
    projectId: event.projectId, ticketId: event.ticketId, kind: event.kind, actionId: event.actionId,
    requestFingerprint: event.requestFingerprint, request }, effect: 'deny-late-manual-defect-ticket-action',
  decidedAt: '2026-10-18T03:00:00.000Z', actor: { kind: 'local-operator' } };
}
const denyArgs = (rejected, assertCurrent = () => true) => ({ projectId: rejected.original.projectId,
  actionId: rejected.original.actionId, requestFingerprint: rejected.original.requestFingerprint,
  prepare: () => ({ rejection: rejected, assertCurrent }) });
const deny = (store, rejected, guard) => store.deny(denyArgs(rejected, guard));

test('D6 rejected-only namespace is present, immutable, restartable, and absent from accepted ticket chains', async t => {
  const f = fixture(t), first = createEvent(), denied = rejection(first), result = await deny(f.store, denied);
  assert.equal(result.replayed, false); assert.deepEqual(result.record.rejection, denied);
  assert.equal(Object.isFrozen(result.record.rejection.original.request), true);
  const bytes = readFileSync(finalPath(f, first)); assert.deepEqual(bytes, defectTicketRejectionBytes(denied));
  assert.equal(result.record.sha256, hashBytes(bytes)); assert.deepEqual(f.store.snapshot(projectId).records, []);
  assert.deepEqual(f.store.snapshot(projectId).tickets, []);
  assert.deepEqual(f.store.action(projectId, first.actionId), result.record);
  assert.equal(f.owner.release(), true); const owner = acquireAcceptanceOwner({ root: f.root }); t.after(() => owner.release());
  const restarted = createDefectTicketStore({ owner }); assert.deepEqual(restarted.action(projectId, first.actionId), result.record);
  const accepted = await put(restarted, createEvent(2)); assert.equal(accepted.replayed, false);
  assert.deepEqual(restarted.snapshot(projectId).records.map(value => value.event.actionId), [uid('da', 2)]);
  assert.deepEqual(readFileSync(finalPath(f, first)), bytes);
  assert.deepEqual(readdirSync(f.events).sort(), [uid('da', 1), uid('da', 2)].map(value => value + '.json'));
});

test('D6 append and deny compete for one action slot on one queue in both orders', async t => {
  for (const winner of ['event', 'rejection']) {
    const f = fixture(t), event = createEvent(), rejected = rejection(event); let losingPrepare = 0;
    const first = winner === 'event' ? put(f.store, event) : deny(f.store, rejected);
    const second = winner === 'event' ? f.store.deny({ ...denyArgs(rejected), prepare() { losingPrepare++; throw Error('must not prepare'); } })
      : f.store.append({ ...args(event), prepare() { losingPrepare++; throw Error('must not prepare'); } });
    assert.equal(first instanceof Promise, true); assert.equal(second instanceof Promise, true);
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.replayed, false); assert.equal(two.replayed, true); assert.deepEqual(two.record, one.record);
    assert.equal(losingPrepare, 0); assert.equal(Object.hasOwn(one.record, winner), true);
    assert.equal(readdirSync(f.events).length, 1);
    assert.equal(f.store.snapshot(projectId).records.length, winner === 'event' ? 1 : 0);
  }
  const f = fixture(t), denied = rejection(), results = await Promise.all([deny(f.store, denied), deny(f.store, denied)]);
  assert.deepEqual(results.map(value => value.replayed), [false, true]); assert.deepEqual(results[0].record, results[1].record);
});

test('D6 exact complete decisions precede zero/full queue limits and never run prepare', async t => {
  for (const winner of ['event', 'rejection']) {
    const f = fixture(t, { queue: 1 }), event = createEvent(), rejected = rejection(event);
    if (winner === 'event') await put(f.store, event); else await deny(f.store, rejected);
    const pending = put(f.store, createEvent(2)); let prepared = 0;
    for (const store of [f.store, createDefectTicketStore({ owner: f.owner, limits: { queue: 0 } })]) {
      const prepare = () => { prepared++; throw Error('existing proof must bypass admission'); };
      const appendResult = store.append({ ...args(event), prepare }), denyResult = store.deny({ ...denyArgs(rejected), prepare });
      assert.equal(appendResult instanceof Promise, true); assert.equal(denyResult instanceof Promise, true);
      for (const result of await Promise.all([appendResult, denyResult])) {
        assert.equal(result.replayed, true); assert.equal(Object.hasOwn(result.record, winner), true);
      }
    }
    assert.equal(prepared, 0); await pending;
  }
});

test('D6 rejected identity remains globally unique and cross-project/mismatched actions cannot reuse it', async t => {
  const f = fixture(t), event = createEvent(), rejected = rejection(event); await deny(f.store, rejected);
  assert.throws(() => f.store.action(otherProject, event.actionId), { code: 'NOT_FOUND', status: 404 });
  for (const fn of [input => f.store.append(input), input => f.store.deny(input)]) {
    await assert.rejects(fn({ ...args(event), projectId: otherProject }), { code: 'NOT_FOUND', status: 404 });
    await assert.rejects(fn({ ...args(event), requestFingerprint: h('different') }), { code: 'ACTION_CONFLICT', status: 409 });
  }
  const first = createEvent(2); await put(f.store, first); const close = closeEvent(first);
  const before = f.store.snapshot(projectId); await deny(f.store, rejection(close));
  assert.deepEqual(f.store.snapshot(projectId).records, before.records); assert.deepEqual(f.store.snapshot(projectId).tickets, before.tickets);
  assert.throws(before.assertCurrent, { code: 'STALE_TICKET' }, 'the complete decision namespace fence also observes rejected changes');
  const next = closeEvent(first, { action: 102 }); await put(f.store, next);
  assert.deepEqual(f.store.snapshot(projectId).records.map(value => value.event.revision), [0, 1]);
});

test('D6 all rejected decisions count toward actions and bytes but never consume ticket capacity', async t => {
  const f = fixture(t, { tickets: 0 }), event = createEvent(), rejected = rejection(event); await deny(f.store, rejected);
  assert.deepEqual(f.store.snapshot(projectId).records, []);
  const bytes = defectTicketRejectionBytes(rejected).length;
  const exact = createDefectTicketStore({ owner: f.owner, limits: { tickets: 0, actions: 1, actionBytes: bytes, namespaceBytes: bytes } });
  assert.deepEqual(exact.action(projectId, event.actionId).rejection, rejected);
  await assert.rejects(deny(exact, rejection(createEvent(2))), { code: 'CAPACITY' });
  for (const limits of [{ actions: 0 }, { namespaceBytes: bytes - 1 }])
    assert.throws(() => createDefectTicketStore({ owner: f.owner, limits }).snapshot(projectId), { code: 'CAPACITY' });
  assertBlocked(() => createDefectTicketStore({ owner: f.owner, limits: { actionBytes: bytes - 1 } }).snapshot(projectId));
  const mixed = fixture(t, { tickets: 1 }); await deny(mixed.store, rejection(createEvent())); await put(mixed.store, createEvent(2));
  assert.equal(mixed.store.snapshot(projectId).tickets.length, 1);
  const total = bytes + defectTicketEventBytes(createEvent(2)).length;
  assert.throws(() => createDefectTicketStore({ owner: mixed.owner, limits: { namespaceBytes: total - 1 } }).snapshot(projectId), { code: 'CAPACITY' });
});

test('D6 rejected records cannot satisfy an accepted close chain and original rejection bytes are fenced', async t => {
  const missing = fixture(t), event = createEvent(); await deny(missing.store, rejection(event));
  await assert.rejects(put(missing.store, closeEvent(event)), { code: 'STALE_TICKET' });
  assert.deepEqual(missing.store.snapshot(projectId).records, []);
  const changed = fixture(t); await deny(changed.store, rejection(event)); const before = readFileSync(finalPath(changed, event));
  await assert.rejects(changed.store.append({ ...args(createEvent(2)), prepare() {
    appendFileSync(finalPath(changed, event), '\n'); return { event: createEvent(2), assertCurrent: () => true };
  } }), { code: 'STALE_TICKET' });
  assert.deepEqual(readFileSync(finalPath(changed, event)), Buffer.concat([before, Buffer.from('\n')]));
  assert.equal(existsSync(finalPath(changed, createEvent(2))), false); assertBlocked(() => changed.store.snapshot(projectId));
});

test('D6 rejection publication failures retain temporary scenes and uncertain complete decisions', async t => {
  const temporary = fixture(t), event = createEvent(), rejected = rejection(event);
  await assert.rejects(deny(temporary.store, rejected, () => {
    if (existsSync(temporary.events) && readdirSync(temporary.events).some(name => name.endsWith('.tmp')))
      throw new DefectTicketError('STALE_FACTS', 409, 'READY_CHANGED');
  }), error => { assert.equal(error.code, 'STALE_FACTS'); assert.equal(error.writeMayHaveCommitted, undefined); return true; });
  const names = readdirSync(temporary.events); assert.equal(names.length, 1); assert.match(names[0], /\.tmp$/);
  assert.deepEqual(readFileSync(join(temporary.events, names[0])), defectTicketRejectionBytes(rejected)); assertBlocked(() => temporary.store.snapshot(projectId));
  const committed = fixture(t);
  await assert.rejects(deny(committed.store, rejected, () => {
    if (existsSync(finalPath(committed, event))) throw new DefectTicketError('STALE_FACTS', 409, 'READY_CHANGED');
  }), error => { assert.equal(error.code, 'STALE_FACTS'); assert.equal(error.writeMayHaveCommitted, true); return true; });
  assert.deepEqual(committed.store.action(projectId, event.actionId).rejection, rejected);
  const replayed = await put(committed.store, event); assert.equal(replayed.replayed, true); assert.deepEqual(replayed.record.rejection, rejected);
});

test('D6 publication expected map includes old rejections and uncertainty survives safe error rewrapping', async t => {
  const f = fixture(t), event = createEvent(), denied = rejection(event); await deny(f.store, denied); const next = createEvent(2);
  await assert.rejects(put(f.store, next, () => {
    if (existsSync(finalPath(f, next))) appendFileSync(finalPath(f, event), '\n');
  }), error => { assert.equal(error.writeMayHaveCommitted, true); return true; });
  assert.equal(existsSync(finalPath(f, next)), true); assertBlocked(() => f.store.action(projectId, event.actionId));
  const clean = fixture(t); let hooks = 0;
  for (const error of [new DefectTicketError('STALE_FACTS', 409, 'SOURCE_CHANGED'), Error('native callback')]) {
    error.writeMayHaveCommitted = true;
    await assert.rejects(clean.store.deny({ ...denyArgs(denied), prepare() { throw error; } }), caught => {
      assert.equal(caught.writeMayHaveCommitted, true); return true;
    });
  }
  const accessor = new DefectTicketError(); Object.defineProperty(accessor, 'writeMayHaveCommitted', { get() { hooks++; return true; } });
  await assert.rejects(clean.store.deny({ ...denyArgs(denied), prepare() { throw accessor; } }), caught => {
    assert.equal(caught.writeMayHaveCommitted, undefined); return true;
  });
  assert.equal(hooks, 0); assert.equal(existsSync(join(clean.root, 'defect-tickets')), false);
});
