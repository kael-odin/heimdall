import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress, finishManagedAcceptanceRun,
  prepareManagedAcceptanceSettlement, assertManagedAcceptanceSettlement, commitManagedAcceptanceSettlement,
  settleManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const cas = store => {
  const { generationId, revision } = store.read();
  return { expectedGenerationId: generationId, expectedRevision: revision };
};
const hasTemporary = (dir, name) => fs.readdirSync(dir).some(entry => entry.startsWith(name + '.') && entry.endsWith('.tmp'));
const safeFailure = (action, mayHaveCommitted) => assert.throws(action, error => {
  assert.ok(error.status >= 400);
  assert.equal(error.writeMayHaveCommitted, mayHaveCommitted);
  assert.equal(error.details.reason, 'PUBLISH_GUARD_FAILED');
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});

// This fixture deliberately builds the real approval/selection/dispatch chain.
// It is local to these fault tests so the main store suite can evolve separately.
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-store-edges-')));
  const owner = acquireAcceptanceOwner({ root }), requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json'); response.end('{"code":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    owner.release(); fs.rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const plan = normalizeSpecPlan({ name: 'managed store edge fixture', mode: 'spec', targetUrl: base + '/source', timeoutMs: 1000,
    spec: { source: { id: 'REQ-STORE-EDGES', revision: '1', type: 'manual' }, approved: false,
      checks: [{ id: 'healthy', title: 'healthy', method: 'GET', path: '/healthy', severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize({ createSchemaVersion: 3 });
  const project = (await catalog.createProject({ ...cas(catalog), name: 'managed edges' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'source', targetUrl: plan.targetUrl })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'target', targetUrl: base + '/target' })).release;
  const source = createAcceptanceRun(plan, { root }), sourceDir = join(root, source.runId);
  finishAcceptanceRun(source.runId, await runSpecAcceptance(plan, { runId: source.runId, outputDir: sourceDir }), { root });
  await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: source.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id,
    contentDigest: candidate.contentDigest, reason: 'approved fixture' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id,
    contentDigest: candidate.contentDigest, reason: 'selected fixture' })).selection;
  const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  const envelope = JSON.parse(record.bytes.toString('utf8')), ref = { operationId: envelope.operationId, dispatchSha256: record.sha256 };
  const dir = join(root, envelope.runId), manifestPath = join(dir, 'manifest.json'), reportPath = join(dir, 'report.json');
  const options = { owner, assertActive: () => true };
  assert.equal(requests.length, 0); assert.equal(fs.existsSync(dir), false);
  return { root, owner, dir, manifestPath, reportPath, ref, options, requests, envelope,
    sidecar: join(root, 'managed-spec-dispatches', 'v1', envelope.operationId + '.json'),
    raw: () => runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: dir }) };
}

test('a report appearing after progress preparation blocks the final manifest write and preserves both originals', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const originalManifest = fs.readFileSync(f.manifestPath), partialReport = Buffer.from('{"partial":true}\n');
  let inserted = false;
  safeFailure(() => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, {
    ...f.options, assertActive() {
      if (!inserted && hasTemporary(f.dir, 'manifest.json')) {
        inserted = true; fs.writeFileSync(f.reportPath, partialReport);
      }
      return true;
    },
  }), false);
  assert.equal(inserted, true);
  assert.deepEqual(fs.readFileSync(f.manifestPath), originalManifest);
  assert.deepEqual(fs.readFileSync(f.reportPath), partialReport);
  assert.equal(hasTemporary(f.dir, 'manifest.json'), true);
  assert.equal(f.requests.length, 0);
});

// Freeze only the evidence inode's visible metadata. This exercises byte
// freshness directly, without relying on sleeps or the host clock resolution.
function freezeMetadata(path) {
  const lstat = nativeFs.lstatSync, fstat = nativeFs.fstatSync;
  const frozen = lstat(path, { bigint: true });
  nativeFs.lstatSync = (current, options) => {
    const observed = lstat(current, options);
    return current === path && options?.bigint ? frozen : observed;
  };
  nativeFs.fstatSync = (fd, options) => {
    const observed = fstat(fd, options);
    return options?.bigint && observed.dev === frozen.dev && observed.ino === frozen.ino ? frozen : observed;
  };
  syncBuiltinESMExports();
  return () => { nativeFs.lstatSync = lstat; nativeFs.fstatSync = fstat; syncBuiltinESMExports(); };
}

for (const stage of ['report', 'terminal']) {
  test(`same-length evidence mutation with frozen metadata at ${stage} publication cannot commit completion`, async t => {
    const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
    const raw = await f.raw(), evidencePath = join(f.dir, raw.checks[0].evidence.contract);
    const originalManifest = fs.readFileSync(f.manifestPath), originalEvidence = fs.readFileSync(evidencePath);
    const changedEvidence = Buffer.from(originalEvidence); changedEvidence[0] = changedEvidence[0] === 0x5b ? 0x7b : 0x5b;
    assert.equal(changedEvidence.length, originalEvidence.length); assert.notDeepEqual(changedEvidence, originalEvidence);
    let changed = false, publishedReportBytes;
    const restore = freezeMetadata(evidencePath);
    try {
      safeFailure(() => finishManagedAcceptanceRun(f.ref, raw, {
        ...f.options, assertActive() {
          const publishing = stage === 'report' ? hasTemporary(f.dir, 'report.json')
            : fs.existsSync(f.reportPath) && hasTemporary(f.dir, 'manifest.json');
          if (!changed && publishing) {
            changed = true;
            if (stage === 'terminal') publishedReportBytes = fs.readFileSync(f.reportPath);
            fs.writeFileSync(evidencePath, changedEvidence);
          }
          return true;
        },
      }), stage === 'terminal');
      assert.equal(changed, true);
      assert.deepEqual(fs.readFileSync(f.manifestPath), originalManifest);
      assert.deepEqual(fs.readFileSync(evidencePath), changedEvidence);
      assert.equal(json(f.manifestPath).status, 'running');
      assert.equal(f.requests.length, 1);
      if (stage === 'report') assert.equal(fs.existsSync(f.reportPath), false);
      else {
        const report = json(f.reportPath);
        assert.equal(report.status, 'completed'); assert.equal(report.gate, 'passed');
        const evidence = report.evidenceManifest.find(item => item.file === raw.checks[0].evidence.contract);
        assert.equal(evidence.sha256, sha(originalEvidence));
        assert.notEqual(evidence.sha256, sha(changedEvidence));
        assert.deepEqual(fs.readFileSync(f.reportPath), publishedReportBytes);
      }
      assert.equal(hasTemporary(f.dir, stage === 'report' ? 'report.json' : 'manifest.json'), true);
    } finally { restore(); }
  });
}

const restart = () => ({ status: 'interrupted', reasonCode: 'ENGINE_RESTARTED', error: '引擎已重启，保留现场。' });
const settlementFailure = (action, committed = false) => assert.throws(action, error => {
  assert.ok(error.status >= 400); assert.equal(typeof error.code, 'string');
  assert.equal(error.writeMayHaveCommitted, committed);
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});
const tokenRejected = token => {
  assert.throws(() => assertManagedAcceptanceSettlement(token), { code: 'INVALID_INPUT' });
  assert.throws(() => commitManagedAcceptanceSettlement(token), { code: 'INVALID_INPUT' });
};

function denyWrites() {
  const names = ['mkdirSync', 'writeFileSync', 'writeSync', 'fsyncSync', 'linkSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync'];
  const originals = Object.fromEntries([...names, 'openSync'].map(name => [name, nativeFs[name]]));
  const attempts = []; let armed = true;
  for (const name of names) nativeFs[name] = (...args) => {
    if (armed) { attempts.push(name); throw Error('unexpected mutation'); }
    return originals[name](...args);
  };
  nativeFs.openSync = (path, flags, ...args) => {
    const writable = typeof flags === 'string' ? !flags.startsWith('r') || flags.includes('+')
      : !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
    if (armed && writable) { attempts.push('openSync'); throw Error('unexpected writable descriptor'); }
    return originals.openSync(path, flags, ...args);
  };
  syncBuiltinESMExports();
  return () => { armed = false; Object.assign(nativeFs, originals); syncBuiltinESMExports(); assert.deepEqual(attempts, []); };
}

test('settlement preparation and repeated readiness assertions perform no writes or active callbacks', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const before = fs.readFileSync(f.manifestPath), names = fs.readdirSync(f.dir), restore = denyWrites();
  let token, active = 0;
  try {
    token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner, assertActive() { active++; throw Error('cancelled'); } });
    assert.equal(Object.isFrozen(token), true); assert.equal(Object.getPrototypeOf(token), null);
    assert.deepEqual(Reflect.ownKeys(token), []); assert.equal(JSON.stringify(token), '{}');
    assert.equal(assertManagedAcceptanceSettlement(token), true);
    assert.equal(assertManagedAcceptanceSettlement(token), true);
  } finally { restore(); }
  assert.equal(active, 0); assert.equal(f.requests.length, 0);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before); assert.deepEqual(fs.readdirSync(f.dir), names);
  const terminal = commitManagedAcceptanceSettlement(token, {});
  assert.equal(terminal.status, 'interrupted'); assert.equal(terminal.gate, 'blocked');
  assert.equal(terminal.reasonCode, 'ENGINE_RESTARTED'); assert.deepEqual(terminal.managed, json(f.manifestPath).managed);
  tokenRejected(token); terminal.error = 'caller change'; assert.equal(json(f.manifestPath).error, restart().error);
});

test('prepared terminal bytes and timestamps cannot change with caller input or a later clock', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const input = restart(), NativeDate = Date, fixedAt = '2037-06-07T08:09:10.000Z'; let token;
  globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixedAt])); } };
  try { token = prepareManagedAcceptanceSettlement(f.ref, input, { owner: f.owner }); }
  finally { globalThis.Date = NativeDate; }
  input.status = 'failed'; input.reasonCode = 'EXECUTION_FAILED'; input.error = 'changed after preparation';
  const terminal = commitManagedAcceptanceSettlement(token);
  assert.equal(terminal.status, 'interrupted'); assert.equal(terminal.reasonCode, 'ENGINE_RESTARTED');
  assert.equal(terminal.error, restart().error); assert.equal(terminal.endedAt, fixedAt); assert.equal(terminal.updatedAt, fixedAt);
  assert.deepEqual(json(f.manifestPath), terminal); assert.equal(f.requests.length, 0);
});

test('a readable running manifest whose prepared terminal exceeds jsonBytes is rejected before all writes', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const before = fs.readFileSync(f.manifestPath), names = fs.readdirSync(f.dir), restore = denyWrites();
  try {
    assert.throws(() => prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner, limits: { jsonBytes: before.length } }),
      error => error.details.reason === 'TERMINAL_BYTES_EXCEEDED' && error.writeMayHaveCommitted === false);
  } finally { restore(); }
  assert.deepEqual(fs.readFileSync(f.manifestPath), before); assert.deepEqual(fs.readdirSync(f.dir), names);
  assert.equal(f.requests.length, 0);
  const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
  assert.equal(assertManagedAcceptanceSettlement(token), true);
});

test('settlement tokens reject copies, prototypes and proxies without executing hooks', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }), before = fs.readFileSync(f.manifestPath);
  let hooks = 0;
  for (const fake of [{ ...token }, Object.create(token), new Proxy(token, { get() { hooks++; throw Error('SECRET'); } }),
    { get owner() { hooks++; throw Error('SECRET'); } }, JSON.parse(JSON.stringify(token)), null, undefined, 1]) tokenRejected(fake);
  assert.equal(hooks, 0); assert.equal(assertManagedAcceptanceSettlement(token), true);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before); commitManagedAcceptanceSettlement(token); tokenRejected(token);
});

test('settlement readiness never creates an unstarted run or repairs a partial directory', async t => {
  const f = await fixture(t), restore = denyWrites();
  try { settlementFailure(() => prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner })); }
  finally { restore(); }
  assert.equal(fs.existsSync(f.dir), false);
  fs.mkdirSync(f.dir); const restorePartial = denyWrites();
  try { settlementFailure(() => prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner })); }
  finally { restorePartial(); }
  assert.deepEqual(fs.readdirSync(f.dir), []); assert.equal(f.requests.length, 0);
});

test('a new owner may prepare interruption but the former owner token is fenced', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const oldToken = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }), before = fs.readFileSync(f.manifestPath);
  assert.equal(f.owner.release(), true);
  const owner = acquireAcceptanceOwner({ root: f.root }); t.after(() => owner.release());
  settlementFailure(() => assertManagedAcceptanceSettlement(oldToken));
  settlementFailure(() => commitManagedAcceptanceSettlement(oldToken)); tokenRejected(oldToken);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  const next = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner });
  assert.equal(assertManagedAcceptanceSettlement(next), true); commitManagedAcceptanceSettlement(next);
  assert.equal(json(f.manifestPath).status, 'interrupted'); assert.equal(f.requests.length, 0);
});

test('owner loss after preparation blocks readiness and consumes the commit attempt', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }), before = fs.readFileSync(f.manifestPath);
  const ownerPath = join(f.root, ACCEPTANCE_OWNER_FILE), ownerBytes = fs.readFileSync(ownerPath), owner = json(ownerPath);
  owner.nonce = 'f'.repeat(64); fs.writeFileSync(ownerPath, JSON.stringify(owner));
  settlementFailure(() => assertManagedAcceptanceSettlement(token));
  settlementFailure(() => commitManagedAcceptanceSettlement(token)); tokenRejected(token);
  assert.deepEqual(fs.readFileSync(f.manifestPath), before); assert.equal(hasTemporary(f.dir, 'manifest.json'), false);
  fs.writeFileSync(ownerPath, ownerBytes);
});

test('a later valid progress manifest cannot be adopted by a prepared settlement', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
  updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, f.options);
  const changed = fs.readFileSync(f.manifestPath);
  settlementFailure(() => assertManagedAcceptanceSettlement(token));
  settlementFailure(() => commitManagedAcceptanceSettlement(token)); tokenRejected(token);
  assert.deepEqual(fs.readFileSync(f.manifestPath), changed); assert.equal(json(f.manifestPath).status, 'running');
  assert.equal(hasTemporary(f.dir, 'manifest.json'), false);
});

test('same-length manifest bytes are fixed even with frozen metadata, and failed readiness stays failed', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const original = fs.readFileSync(f.manifestPath), modified = Buffer.from(original); modified[modified.indexOf(10)] = 32;
  const restore = freezeMetadata(f.manifestPath);
  try {
    const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
    fs.writeFileSync(f.manifestPath, modified);
    settlementFailure(() => assertManagedAcceptanceSettlement(token));
    fs.writeFileSync(f.manifestPath, original);
    settlementFailure(() => assertManagedAcceptanceSettlement(token));
    settlementFailure(() => commitManagedAcceptanceSettlement(token)); tokenRejected(token);
    assert.deepEqual(fs.readFileSync(f.manifestPath), original); assert.equal(hasTemporary(f.dir, 'manifest.json'), false);
  } finally { restore(); }
});

test('changed dispatch and run identity cannot be refreshed by a prepared settlement', async t => {
  for (const part of ['dispatch', 'directory']) {
    const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
    const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }), before = fs.readFileSync(f.manifestPath);
    if (part === 'dispatch') fs.appendFileSync(f.sidecar, ' ');
    else { fs.renameSync(f.dir, f.dir + '.saved'); fs.mkdirSync(f.dir); fs.writeFileSync(f.manifestPath, before); }
    settlementFailure(() => assertManagedAcceptanceSettlement(token));
    settlementFailure(() => commitManagedAcceptanceSettlement(token)); tokenRejected(token);
    assert.deepEqual(fs.readFileSync(f.manifestPath), before); assert.equal(hasTemporary(f.dir, 'manifest.json'), false);
    if (part === 'directory') assert.deepEqual(fs.readFileSync(join(f.dir + '.saved', 'manifest.json')), before);
  }
});

test('opaque partial report hardlinks are neither read nor modified by prepare, assert or commit', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const opaque = Buffer.from('{opaque SECRET partial report'), alias = f.reportPath + '.partial';
  fs.writeFileSync(f.reportPath, opaque); fs.linkSync(f.reportPath, alias);
  const originalOpen = nativeFs.openSync; let opened = 0;
  nativeFs.openSync = (path, ...args) => {
    if (path === f.reportPath || path === alias) { opened++; throw Error('report must stay opaque'); }
    return originalOpen(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
    assert.equal(assertManagedAcceptanceSettlement(token), true); commitManagedAcceptanceSettlement(token);
  } finally { nativeFs.openSync = originalOpen; syncBuiltinESMExports(); }
  assert.equal(opened, 0); assert.deepEqual(fs.readFileSync(f.reportPath), opaque); assert.deepEqual(fs.readFileSync(alias), opaque);
  assert.equal(fs.statSync(f.reportPath).nlink, 2); assert.equal(json(f.manifestPath).status, 'interrupted'); assert.equal(f.requests.length, 0);
});

test('a partial report FIFO stays opaque during settlement', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const result = spawnSync('mkfifo', [f.reportPath], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
  assert.equal(assertManagedAcceptanceSettlement(token), true); commitManagedAcceptanceSettlement(token);
  assert.equal(fs.lstatSync(f.reportPath).isFIFO(), true); assert.equal(json(f.manifestPath).status, 'interrupted');
});

test('invalid commit options and synchronous guard results consume tokens without executing hooks', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options); const before = fs.readFileSync(f.manifestPath); let hooks = 0;
  const getter = { get beforePublish() { hooks++; throw Error('SECRET'); } };
  const cases = [() => null, () => getter, () => ({ unknown: true }), () => ({ owner: f.owner }),
    () => new Proxy({}, { get() { hooks++; throw Error('SECRET'); }, ownKeys() { hooks++; throw Error('SECRET'); } }),
    () => ({ beforePublish: async () => { hooks++; throw Error('SECRET'); } }),
    () => ({ beforePublish: function* () { hooks++; } }),
    () => ({ beforePublish: new Proxy(() => { hooks++; }, { apply() { hooks++; throw Error('SECRET'); } }) }),
    () => ({ beforePublish: { get then() { hooks++; throw Error('SECRET'); } } }),
    () => ({ beforePublish: Promise.reject(Error('SECRET')) }),
    ...[false, null, 0, 'true', {}, () => {}].map(value => () => ({ beforePublish: () => value })),
    () => ({ beforePublish: () => ({ get then() { hooks++; throw Error('SECRET'); } }) }),
    () => ({ beforePublish: () => Promise.reject(Error('SECRET')) })];
  for (const options of cases) {
    const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
    settlementFailure(() => commitManagedAcceptanceSettlement(token, options())); tokenRejected(token);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks, 0); assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  assert.equal(hasTemporary(f.dir, 'manifest.json'), false); assert.equal(f.requests.length, 0);
});

test('batch publication guard runs before temporary writes and again before formal replacement', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const before = fs.readFileSync(f.manifestPath), first = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
  let calls = 0;
  settlementFailure(() => commitManagedAcceptanceSettlement(first, { beforePublish() {
    calls++; assert.equal(hasTemporary(f.dir, 'manifest.json'), false); throw Error('SECRET');
  } }));
  assert.equal(calls, 1); tokenRejected(first); assert.equal(hasTemporary(f.dir, 'manifest.json'), false);
  const second = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }); calls = 0;
  settlementFailure(() => commitManagedAcceptanceSettlement(second, { beforePublish() {
    calls++;
    assert.equal(hasTemporary(f.dir, 'manifest.json'), calls > 1);
    if (calls > 1) throw Error('SECRET');
  } }));
  assert.equal(calls, 2); tokenRejected(second); assert.deepEqual(fs.readFileSync(f.manifestPath), before);
  assert.equal(hasTemporary(f.dir, 'manifest.json'), true);
});

test('a final batch hook changing fixed manifest bytes is rejected before formal publication', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const original = fs.readFileSync(f.manifestPath), modified = Buffer.from(original); modified[modified.indexOf(10)] = 32;
  const restore = freezeMetadata(f.manifestPath);
  try {
    const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }); let calls = 0;
    settlementFailure(() => commitManagedAcceptanceSettlement(token, { beforePublish() {
      if (++calls === 2) fs.writeFileSync(f.manifestPath, modified);
    } }));
    assert.equal(calls, 2); tokenRejected(token); assert.deepEqual(fs.readFileSync(f.manifestPath), modified);
    assert.equal(json(f.manifestPath).status, 'running'); assert.equal(hasTemporary(f.dir, 'manifest.json'), true);
  } finally { restore(); }
});

test('tokens are consumed before the batch callback and cannot be asserted or committed reentrantly', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }); let calls = 0;
  const result = commitManagedAcceptanceSettlement(token, { beforePublish() { calls++; tokenRejected(token); return true; } });
  assert.equal(calls, 2); assert.equal(result.status, 'interrupted'); tokenRejected(token);
  assert.deepEqual(json(f.manifestPath), result); assert.equal(hasTemporary(f.dir, 'manifest.json'), false);
});

for (const didCommit of [false, true]) {
  test(`settlement rename ${didCommit ? 'commit-then-throw' : 'failure'} preserves actual facts and consumes its token`, async t => {
    const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
    const before = fs.readFileSync(f.manifestPath), originalRename = nativeFs.renameSync; let calls = 0, token;
    nativeFs.renameSync = (source, target) => {
      if (target !== f.manifestPath) return originalRename(source, target);
      calls++; if (didCommit) originalRename(source, target);
      throw Object.assign(Error('SECRET filesystem path'), { code: 'ENOSPC' });
    };
    syncBuiltinESMExports();
    try {
      token = prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner });
      settlementFailure(() => commitManagedAcceptanceSettlement(token), didCommit);
    } finally { nativeFs.renameSync = originalRename; syncBuiltinESMExports(); }
    assert.equal(calls, 1); tokenRejected(token);
    if (didCommit) assert.equal(json(f.manifestPath).status, 'interrupted');
    else assert.deepEqual(fs.readFileSync(f.manifestPath), before);
    assert.equal(hasTemporary(f.dir, 'manifest.json'), false); assert.equal(f.requests.length, 0);
    if (didCommit) settlementFailure(() => prepareManagedAcceptanceSettlement(f.ref, restart(), { owner: f.owner }));
    else settleManagedAcceptanceRun(f.ref, restart(), { owner: f.owner });
  });
}
