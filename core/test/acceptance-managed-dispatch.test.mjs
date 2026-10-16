import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { projectSpecBaselineCandidate } from '../src/acceptance/candidate-projection.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { AcceptanceCatalogError } from '../src/acceptance/catalog-schema.mjs';
import { createManagedSpecDispatchStore } from '../src/acceptance/managed-dispatch-store.mjs';
import { MANAGED_SPEC_DISPATCH_LIMITS, validateManagedSpecDispatchEnvelope, managedSpecDispatchPlanFingerprint,
  managedSpecDispatchRequestFingerprint } from '../src/acceptance/managed-dispatch-schema.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const uuid = prefix => prefix + '-' + randomUUID();
const sha = value => createHash('sha256').update(value).digest('hex');
const at = '2026-10-16T00:00:00.000Z';
async function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-dispatch-')));
  const owner = acquireAcceptanceOwner({ root });
  t.after(() => { owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: uuid('ap'), name: '托管验收', createdAt: at };
  const sourceRelease = { id: uuid('ar'), projectId: project.id, label: '规范来源', targetUrl: 'http://127.0.0.1:1/source', createdAt: at };
  const targetRelease = { id: uuid('ar'), projectId: project.id, label: '新目标', targetUrl: 'http://127.0.0.1:2/target', buildRef: 'build-2', createdAt: at };
  const sourcePlan = normalizeSpecPlan({ name: '需求', mode: 'spec', targetUrl: sourceRelease.targetUrl, timeoutMs: 1000,
    spec: { source: { id: 'req', revision: '1', type: 'manual' }, approved: false,
      checks: [{ id: 'healthy', title: '健康接口', method: 'GET', path: '/healthy', severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });
  const run = createAcceptanceRun(sourcePlan, { root });
  const report = await runSpecAcceptance(sourcePlan, { runId: run.runId, outputDir: acceptanceRunDir(run.runId, root) });
  finishAcceptanceRun(run.runId, report, { root });
  const material = readSpecCandidateSource(run.runId, { root, owner });
  const { projection } = projectSpecBaselineCandidate(material, { projectId: project.id, releaseId: sourceRelease.id, sourceSide: 'source' });
  const candidate = { id: uuid('ab'), ...projection, createdAt: at };
  const approval = { id: uuid('aa'), projectId: project.id, candidateId: candidate.id,
    contentDigest: candidate.contentDigest, reason: '完整合同已复核', approvedAt: at, actor: { kind: 'local-operator' } };
  const selection = { id: uuid('as'), projectId: project.id, mode: 'spec', approvalId: approval.id,
    previousSelectionId: null, reason: '选作托管来源', selectedAt: at, actor: { kind: 'local-operator' } };
  const catalog = { generationId: uuid('ag'), revision: 8, headSha256: 'a'.repeat(64) };
  const request = { projectId: project.id, expectedGenerationId: catalog.generationId, expectedRevision: catalog.revision,
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id };
  const plan = normalizeSpecPlan({ ...sourcePlan, name: '托管计划', targetUrl: targetRelease.targetUrl,
    spec: { ...sourcePlan.spec, approved: true } });
  const envelope = { schemaVersion: 1, operationId: uuid('ao'), dispatchId: uuid('ad'), runId: uuid('ac'), taskId: uuid('a'), acceptedAt: at,
    request, requestFingerprint: managedSpecDispatchRequestFingerprint(request), catalog, project, selection, approval, candidate,
    sourceRelease, targetRelease, sourceSpecApproved: false, plan, planFingerprint: managedSpecDispatchPlanFingerprint(plan), executor: 'engine-owner-spec-v1' };
  const store = createManagedSpecDispatchStore({ root, owner, ...options });
  const directory = join(root, 'managed-spec-dispatches', 'v1');
  return { root, owner, envelope, store, directory, file: join(directory, envelope.operationId + '.json'), report };
}
const unavailable = error => error instanceof AcceptanceCatalogError && error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
  && !/[A-Z]:\\|heimdall-managed-dispatch-/.test(error.message);
const reseal = envelope => {
  envelope.requestFingerprint = managedSpecDispatchRequestFingerprint(envelope.request);
  envelope.planFingerprint = managedSpecDispatchPlanFingerprint(envelope.plan);
  return envelope;
};
const rehashCandidate = envelope => {
  const { id: _id, createdAt: _at, contentDigest: _digest, ...content } = envelope.candidate;
  envelope.candidate.contentDigest = hashAcceptanceValue(content);
  envelope.approval.contentDigest = envelope.candidate.contentDigest;
  envelope.request.contentDigest = envelope.candidate.contentDigest;
  reseal(envelope);
};

test('strict envelope validates a real unapproved source without creating a new run or sending requests', async t => {
  const f = await fixture(t);
  assert.equal(f.report.safety.requests, 0);
  const before = fs.readdirSync(f.root);
  assert.equal(validateManagedSpecDispatchEnvelope(f.envelope), f.envelope);
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(managedSpecDispatchRequestFingerprint(f.envelope.request), hashAcceptanceValue({
    domain: 'heimdall-managed-spec-dispatch-request', version: 1, request: f.envelope.request }));
  assert.equal(managedSpecDispatchPlanFingerprint(f.envelope.plan), sha(JSON.stringify(f.envelope.plan)));
});

test('absent operation reads do not create either sidecar directory and later publication remains possible', async t => {
  const f = await fixture(t), before = fs.readdirSync(f.root).sort();
  assert.equal(f.store.read(f.envelope.operationId), null);
  assert.deepEqual(fs.readdirSync(f.root).sort(), before);
  const parent = join(f.root, 'managed-spec-dispatches'); fs.mkdirSync(parent);
  assert.equal(f.store.read(f.envelope.operationId), null);
  assert.deepEqual(fs.readdirSync(parent), []);
  fs.mkdirSync(f.directory);
  assert.equal(f.store.read(f.envelope.operationId), null);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const record = f.store.publish(f.envelope);
  assert.deepEqual(f.store.read(f.envelope.operationId), record);
});

test('read-only absence cannot bypass an unsafe sidecar ancestor', async t => {
  const f = await fixture(t), destination = join(f.root, 'linked-destination'); fs.mkdirSync(destination);
  const parent = join(f.root, 'managed-spec-dispatches'); fs.symlinkSync(destination, parent, 'junction');
  assert.throws(() => f.store.read(f.envelope.operationId), unavailable);
  assert.equal(fs.lstatSync(parent).isSymbolicLink(), true); assert.deepEqual(fs.readdirSync(destination), []);
});

test('read-only absence pins an observed parent even before its version directory exists', async t => {
  const f = await fixture(t), parent = join(f.root, 'managed-spec-dispatches'); fs.mkdirSync(parent);
  assert.equal(f.store.read(f.envelope.operationId), null);
  fs.renameSync(parent, parent + '.saved'); fs.mkdirSync(f.directory, { recursive: true });
  assert.throws(() => f.store.read(f.envelope.operationId), unavailable);
  assert.throws(() => f.store.initialize(), unavailable);
  assert.deepEqual(fs.readdirSync(parent + '.saved'), []); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('read-only absence still requires the current root owner', async t => {
  const f = await fixture(t); assert.equal(f.owner.release(), true);
  assert.throws(() => f.store.read(f.envelope.operationId), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.equal(fs.existsSync(join(f.root, 'managed-spec-dispatches')), false);
});

test('envelope rejects identity/reference, approved selection and plan/source/budget substitutions', async t => {
  const f = await fixture(t);
  const cases = [
    ['unknown root', e => { e.entityDigest = 'a'.repeat(64); }],
    ['operation path', e => { e.operationId = '../escape'; }],
    ['dispatch type', e => { e.dispatchId = uuid('ac'); }],
    ['task type', e => { e.taskId = uuid('ac'); }],
    ['unsupported schema', e => { e.schemaVersion = 2; }],
    ['invalid time', e => { e.acceptedAt = '2026-10-16'; }],
    ['different request', e => { e.request.targetReleaseId = uuid('ar'); reseal(e); }],
    ['generation', e => { e.catalog.generationId = uuid('ag'); }],
    ['revision', e => { e.catalog.revision++; }],
    ['project', e => { e.project.id = uuid('ap'); }],
    ['approval null', e => { e.selection.approvalId = null; }],
    ['approval identity', e => { e.approval.id = uuid('aa'); }],
    ['approval candidate', e => { e.approval.candidateId = uuid('ab'); }],
    ['selection identity', e => { e.selection.id = uuid('as'); }],
    ['source release', e => { e.sourceRelease.id = uuid('ar'); }],
    ['candidate side', e => { e.candidate.source.side = 'target'; rehashCandidate(e); }],
    ['reuse source run', e => { e.runId = e.candidate.source.runId; }],
    ['candidate digest', e => { e.candidate.sourceReportDigest = 'b'.repeat(64); }],
    ['target URL', e => { e.plan.targetUrl = 'http://127.0.0.1:3/'; reseal(e); }],
    ['budget', e => { e.plan.timeoutMs = 2000; reseal(e); }],
    ['response budget', e => { e.plan.maxResponseBytes = 1024; reseal(e); }],
    ['source revision', e => { e.plan.spec.source.revision = 'new'; reseal(e); }],
    ['expected', e => { e.plan.spec.checks[0].expect.status = 201; reseal(e); }],
    ['contract id', e => { e.plan.spec.checks[0].id = 'injected'; reseal(e); }],
    ['plan draft', e => { e.plan.spec.approved = false; reseal(e); }],
    ['executor', e => { e.executor = 'browser'; }],
    ['source fact', e => { e.sourceSpecApproved = 'true'; }],
  ];
  for (const [label, mutate] of cases) {
    const envelope = copy(f.envelope); mutate(envelope);
    assert.throws(() => validateManagedSpecDispatchEnvelope(envelope), error => error.code === 'INVALID_INPUT', label);
  }
});

test('no getter/proxy/toJSON/symbol/nonenumerable/cycle/array hooks execute during validation', async t => {
  const f = await fixture(t);
  let touched = 0;
  const cases = [
    e => Object.defineProperty(e.plan.spec.source, 'revision', { enumerable: true, get() { touched++; return '1'; } }),
    e => { e.plan = new Proxy(e.plan, { get() { touched++; throw Error('proxy'); } }); },
    e => { e.plan.toJSON = () => { touched++; return {}; }; },
    e => Object.defineProperty(e.approval, 'hidden', { value: true }),
    e => { e.plan[Symbol('hidden')] = true; },
    e => { e.plan.spec.checks.push(e.plan); },
    e => { e.plan.spec.checks.named = true; },
    e => { delete e.plan.spec.checks[0]; },
  ];
  for (const mutate of cases) {
    const envelope = copy(f.envelope); mutate(envelope);
    assert.throws(() => validateManagedSpecDispatchEnvelope(envelope), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(touched, 0);
});

test('limits only tighten and complexity is bounded before recursion or serialization', async t => {
  const f = await fixture(t);
  for (const limits of [{ jsonBytes: MANAGED_SPEC_DISPATCH_LIMITS.jsonBytes + 1 }, { unknown: 1 }, { jsonNodes: -1 }, { jsonDepth: 1.1 }]) {
    assert.throws(() => validateManagedSpecDispatchEnvelope(f.envelope, { limits }), error => error.code === 'INVALID_INPUT');
  }
  for (const limits of [{ jsonBytes: 1 }, { jsonNodes: 1 }, { jsonCharacters: 1 }, { jsonDepth: 1 }]) {
    assert.throws(() => validateManagedSpecDispatchEnvelope(f.envelope, { limits }), error => error.code === 'INVALID_INPUT');
  }
});

test('lazy store publishes exactly once with private bytes, no catalog/head/run changes, stable list/read', async t => {
  const f = await fixture(t);
  assert.equal(fs.existsSync(f.directory), false);
  const beforeRuns = fs.readdirSync(f.root).filter(name => name.startsWith('ac-'));
  let guards = 0;
  const record = f.store.publish(f.envelope, { beforePublish() { guards++; } });
  assert.equal(guards, 1); assert.equal(record.sha256, sha(record.bytes));
  assert.deepEqual(record.envelope, f.envelope);
  assert.deepEqual(f.store.read(f.envelope.operationId), record);
  assert.deepEqual(f.store.list(), [record]);
  assert.deepEqual(fs.readdirSync(f.directory), [f.envelope.operationId + '.json']);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('ac-')), beforeRuns);
  assert.deepEqual(f.store.publish(copy(f.envelope)), record);
  assert.equal(guards, 1);
  f.envelope.project.name = 'caller mutation'; record.bytes.fill(0); record.envelope.project.name = 'result mutation';
  assert.equal(f.store.read(f.envelope.operationId).envelope.project.name, '托管验收');
});

test('same operation never overwrites an existing envelope', async t => {
  const f = await fixture(t); const record = f.store.publish(f.envelope);
  const changed = copy(f.envelope); changed.dispatchId = uuid('ad');
  assert.throws(() => f.store.publish(changed), error => error.code === 'DISPATCH_CONFLICT' && error.writeMayHaveCommitted === false);
  assert.deepEqual(fs.readFileSync(f.file), record.bytes);
});

test('synchronous final guard sees full fsynced temporary and runs before publication', async t => {
  let temporaryPath, synced = false, f;
  f = await fixture(t, { hooks: { afterTemporaryWrite(context) { temporaryPath = context.temporaryPath; } },
    io: { fsyncSync(fd) { fs.fsyncSync(fd); synced = true; } } });
  f.store.publish(f.envelope, { beforePublish() {
    assert.equal(synced, true); assert.equal(fs.existsSync(f.file), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(temporaryPath, 'utf8')), f.envelope);
  } });
  assert.equal(fs.existsSync(temporaryPath), false);
});

test('final guard follows all temporary/history byte reads and immediately precedes publication fences', async t => {
  let guardFinished = false, published = false;
  const descriptors = new Map();
  const f = await fixture(t, { io: {
    openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); descriptors.set(fd, { path, flags }); return fd; },
    closeSync(fd) { fs.closeSync(fd); descriptors.delete(fd); },
    readSync(...args) {
      assert.equal(guardFinished && !published, false, 'No byte read may separate final guard from exclusive link');
      return fs.readSync(...args);
    },
    linkSync(from, to) {
      assert.equal(guardFinished, true); assert.equal(descriptors.size, 1);
      const [[pin, { path, flags }]] = descriptors;
      assert.equal(path, from); assert.equal(typeof flags, 'number');
      assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
      assert.equal(fs.fstatSync(pin, { bigint: true }).ino, fs.lstatSync(from, { bigint: true }).ino);
      fs.linkSync(from, to); published = true;
    },
  } });
  const record = f.store.publish(f.envelope, { beforePublish() { guardFinished = true; } });
  assert.equal(published, true); assert.equal(descriptors.size, 0);
  assert.deepEqual(f.store.read(f.envelope.operationId), record);
});

test('post-guard temporary metadata change still prevents publication without a late byte read', async t => {
  let temporaryPath;
  const f = await fixture(t, { hooks: { afterTemporaryWrite(context) { temporaryPath = context.temporaryPath; } } });
  assert.throws(() => f.store.publish(f.envelope, { beforePublish() {
    const bytes = fs.readFileSync(temporaryPath); bytes[0] = 32; fs.writeFileSync(temporaryPath, bytes);
  } }), error => unavailable(error) && error.details.reason === 'TEMPORARY_CHANGED' && !error.writeMayHaveCommitted);
  assert.equal(f.store.read(f.envelope.operationId), null);
});

test('guard rejection/thenable cannot publish and private temporary is removed', async t => {
  const f = await fixture(t);
  for (const beforePublish of [() => { throw new AcceptanceCatalogError('STALE_REVISION', 409, '目录已变化'); },
    () => Promise.resolve(), () => Object.create({ then() {} })]) {
    assert.throws(() => f.store.publish(f.envelope, { beforePublish }), error => !error.writeMayHaveCommitted
      && ['STALE_REVISION', 'INVALID_INPUT'].includes(error.code));
    assert.equal(f.store.read(f.envelope.operationId), null); assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('ordinary async rejection is consumed under strict unhandled mode and then getters never execute', async t => {
  const f = await fixture(t);
  const moduleUrl = new URL('../src/acceptance/managed-dispatch-store.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { createManagedSpecDispatchStore } from ${JSON.stringify(moduleUrl)};
    const { root, envelope } = JSON.parse(readFileSync(0, 'utf8'));
    const store = createManagedSpecDispatchStore({ root, owner: { root, assertOwned() {} } });
    let getters = 0;
    const thenGetter = value => Object.defineProperty(value, 'then', { get() { getters++; throw Error('must not execute'); } });
    const constructorGetter = value => Object.defineProperty(value, 'constructor', { get() { getters++; throw Error('must not execute'); } });
    const guards = [async () => { throw Error('async rejection'); }, () => Promise.reject(Error('ordinary rejection')),
      () => thenGetter(Promise.reject(Error('native own then rejection'))), () => thenGetter({}),
      () => constructorGetter(Promise.resolve())];
    for (const beforePublish of guards) {
      assert.throws(() => store.publish(envelope, { beforePublish }), error => error.code === 'INVALID_INPUT' && !error.writeMayHaveCommitted);
      assert.equal(store.read(envelope.operationId), null);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(getters, 0);
    console.log('strict async guard rejection: consumed; then/constructor getters: 0');
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source], {
    input: JSON.stringify({ root: f.root, envelope: f.envelope }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, ''); assert.match(child.stdout, /getters: 0/);
  assert.equal(f.store.read(f.envelope.operationId), null);
});

test('short writes complete, while write/fsync/close failure never publishes', async t => {
  const partial = await fixture(t, { io: { writeSync(fd, bytes, offset, length, position) {
    return fs.writeSync(fd, bytes, offset, Math.min(length, 79), position);
  } } });
  partial.store.publish(partial.envelope);
  for (const fault of ['writeSync', 'fsyncSync', 'closeSync']) {
    let writer;
    const io = { openSync(path, flags, mode) { const fd = fs.openSync(path, flags, mode); if (flags === 'wx') writer = fd; return fd; } };
    io[fault] = (...args) => {
      if (args[0] === writer) { if (fault === 'closeSync') fs.closeSync(args[0]); throw Object.assign(new Error('secret path'), { code: 'EIO' }); }
      return fs[fault](...args);
    };
    const f = await fixture(t, { io });
    assert.throws(() => f.store.publish(f.envelope), error => unavailable(error) && error.writeMayHaveCommitted === false, fault);
    assert.equal(f.store.read(f.envelope.operationId), null, fault);
  }
});

test('post-publication faults retain accepted originals and expose lookup identities', async t => {
  for (const fault of ['hook', 'linkThenThrow', 'readAfterLink']) {
    let linked = false;
    const f = await fixture(t, fault === 'hook' ? { hooks: { afterPublish() { throw Error('post publish secret'); } } } : { io: {
      linkSync(from, to) { fs.linkSync(from, to); linked = true; if (fault === 'linkThenThrow') throw Error('after link'); },
      readSync(...args) { if (linked && fault === 'readAfterLink') { linked = false; throw Error('read back'); } return fs.readSync(...args); },
    } });
    assert.throws(() => f.store.publish(f.envelope), error => unavailable(error) && error.writeMayHaveCommitted === true
      && error.operationId === f.envelope.operationId && error.dispatchId === f.envelope.dispatchId && error.runId === f.envelope.runId, fault);
    assert.deepEqual(f.store.read(f.envelope.operationId).envelope, f.envelope, fault);
    assert.equal(fs.existsSync(f.file), true);
  }
});

test('temporary mutation and inode replacement fail closed without deleting replaced files', async t => {
  let temporaryPath;
  const changed = await fixture(t, { hooks: { afterTemporaryWrite(context) { temporaryPath = context.temporaryPath; fs.writeFileSync(temporaryPath, '{}'); } } });
  assert.throws(() => changed.store.publish(changed.envelope), unavailable);
  assert.equal(changed.store.read(changed.envelope.operationId), null);
  const replaced = await fixture(t, { hooks: { afterTemporaryWrite(context) {
    temporaryPath = context.temporaryPath; fs.unlinkSync(temporaryPath); fs.writeFileSync(temporaryPath, '{}');
  } } });
  assert.throws(() => replaced.store.publish(replaced.envelope), unavailable);
  assert.equal(fs.readFileSync(temporaryPath, 'utf8'), '{}');
  assert.equal(replaced.store.read(replaced.envelope.operationId), null);
});

test('a live read-only inode pin survives same-byte temporary replacement and closes on every outcome', async t => {
  for (const outcome of ['accepted', 'guard-rejected', 'temporary-replaced', 'owner-lost']) {
    const descriptors = new Map(); let checked = false, temporaryPath, f;
    f = await fixture(t, { io: {
      openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); descriptors.set(fd, { path, flags }); return fd; },
      closeSync(fd) { fs.closeSync(fd); descriptors.delete(fd); },
    }, hooks: { afterTemporaryWrite(context) {
      temporaryPath = context.temporaryPath;
      assert.equal(descriptors.size, 1, 'The writer is closed while an independent inode pin remains open');
      const [[pin, { path, flags }]] = descriptors;
      assert.equal(path, temporaryPath); assert.equal(typeof flags, 'number');
      assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
      const original = fs.fstatSync(pin, { bigint: true });
      assert.equal(original.ino, fs.lstatSync(temporaryPath, { bigint: true }).ino);
      if (outcome === 'temporary-replaced') {
        const bytes = fs.readFileSync(temporaryPath);
        fs.unlinkSync(temporaryPath); fs.writeFileSync(temporaryPath, bytes);
        const replacement = fs.lstatSync(temporaryPath, { bigint: true });
        assert.equal(replacement.dev === original.dev && replacement.ino === original.ino, false,
          'An unlinked original inode remains allocated until its live pin is closed');
        assert.equal(fs.fstatSync(pin, { bigint: true }).ino, original.ino);
      }
      if (outcome === 'owner-lost') f.owner.release();
      checked = true;
    } } });
    const publish = () => f.store.publish(f.envelope, { beforePublish() {
      if (outcome === 'guard-rejected') throw new AcceptanceCatalogError('STALE_REVISION', 409, '目录已变化');
    } });
    if (outcome === 'accepted') assert.deepEqual(publish().envelope, f.envelope);
    else assert.throws(publish, error => error.writeMayHaveCommitted === false
      && (outcome === 'temporary-replaced' ? unavailable(error)
        : error.code === (outcome === 'owner-lost' ? 'ACCEPTANCE_OWNER_LOST' : 'STALE_REVISION')));
    assert.equal(checked, true, outcome); assert.equal(descriptors.size, 0, outcome);
    assert.equal(fs.existsSync(f.file), outcome === 'accepted', outcome);
    assert.equal(fs.existsSync(temporaryPath), ['temporary-replaced', 'owner-lost'].includes(outcome), outcome);
    if (outcome === 'temporary-replaced') assert.deepEqual(JSON.parse(fs.readFileSync(temporaryPath, 'utf8')), f.envelope);
  }
});

test('temporary inode pin acquisition failure closes the writer and never publishes', async t => {
  const descriptors = new Set(); let opens = 0;
  const f = await fixture(t, { io: {
    openSync(path, flags, ...args) {
      if (++opens === 2) throw Object.assign(Error('pin unavailable'), { code: 'EIO' });
      const fd = fs.openSync(path, flags, ...args); descriptors.add(fd); return fd;
    },
    closeSync(fd) { fs.closeSync(fd); descriptors.delete(fd); },
  } });
  assert.throws(() => f.store.publish(f.envelope), error => unavailable(error) && error.writeMayHaveCommitted === false);
  assert.equal(opens, 2); assert.equal(descriptors.size, 0);
  assert.equal(f.store.read(f.envelope.operationId), null); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('owner loss after temporary write preserves temporary and prevents any publish/cleanup mutation', async t => {
  let temporaryPath, f;
  f = await fixture(t, { hooks: { afterTemporaryWrite(context) { temporaryPath = context.temporaryPath; f.owner.release(); } } });
  assert.throws(() => f.store.publish(f.envelope), error => error.code === 'ACCEPTANCE_OWNER_LOST' && !error.writeMayHaveCommitted);
  assert.equal(fs.existsSync(f.file), false); assert.equal(fs.existsSync(temporaryPath), true);
});

test('directory replacement is detected across calls and cleanup leaves replacement intact', async t => {
  const f = await fixture(t); f.store.initialize();
  fs.renameSync(f.directory, f.directory + '-old'); fs.mkdirSync(f.directory);
  fs.writeFileSync(join(f.directory, 'must-remain'), 'new owner');
  assert.throws(() => f.store.read(f.envelope.operationId), unavailable);
  assert.equal(fs.readFileSync(join(f.directory, 'must-remain'), 'utf8'), 'new owner');
});

test('orphan temporary is never promoted; malformed/unknown published records cannot look missing', async t => {
  const f = await fixture(t); f.store.initialize();
  const temporary = join(f.directory, f.envelope.operationId + '.' + randomUUID() + '.tmp');
  fs.writeFileSync(temporary, JSON.stringify(f.envelope));
  assert.deepEqual(f.store.list(), []); assert.equal(f.store.read(f.envelope.operationId), null);
  assert.equal(fs.existsSync(temporary), true);
  for (const content of [Buffer.from('{'), Buffer.from([0xc3, 0x28]), JSON.stringify({ ...f.envelope, schemaVersion: 2 })]) {
    fs.writeFileSync(f.file, content);
    assert.throws(() => f.store.read(f.envelope.operationId), unavailable);
    assert.throws(() => f.store.list(), unavailable);
    fs.unlinkSync(f.file);
  }
  fs.writeFileSync(join(f.directory, 'unexpected.json'), '{}');
  assert.throws(() => f.store.list(), unavailable);
});

test('a published file removed during a bounded read is unavailable rather than missing', async t => {
  const f = await fixture(t); f.store.publish(f.envelope);
  let removed = false;
  const store = createManagedSpecDispatchStore({ root: f.root, owner: f.owner, io: {
    readSync(...args) {
      const count = fs.readSync(...args);
      if (!removed) { removed = true; fs.unlinkSync(f.file); }
      return count;
    },
  } });
  assert.throws(() => store.read(f.envelope.operationId), unavailable);
  assert.equal(store.read(f.envelope.operationId), null);
});

test('a record observed by lstat cannot become absent after realpath ENOENT', async t => {
  const f = await fixture(t); f.store.publish(f.envelope); f.owner.release();
  const storeUrl = new URL('../src/acceptance/managed-dispatch-store.mjs', import.meta.url).href;
  const ownerUrl = new URL('../src/acceptance/owner.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createManagedSpecDispatchStore } from ${JSON.stringify(storeUrl)};
    import { acquireAcceptanceOwner } from ${JSON.stringify(ownerUrl)};
    const { root, file, operationId } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const owner = acquireAcceptanceOwner({ root });
    const realpath = fs.realpathSync; let resolutions = 0;
    assert.equal(fs.lstatSync(file).isFile(), true);
    fs.realpathSync = (path, ...args) => {
      if (path === file) { resolutions++; throw Object.assign(Error('record resolution failed'), { code: 'ENOENT' }); }
      return realpath(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      const store = createManagedSpecDispatchStore({ root, owner });
      assert.throws(() => store.read(operationId), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
        && error.details.reason === 'FILESYSTEM_FAILURE');
      assert.equal(resolutions, 1);
      console.log('Observed record resolution failure remains unavailable');
    } finally { fs.realpathSync = realpath; syncBuiltinESMExports(); owner.release(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    input: JSON.stringify({ root: f.root, file: f.file, operationId: f.envelope.operationId }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, ''); assert.match(child.stdout, /remains unavailable/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), f.envelope);
});

test('oversized and filename-mismatched published records reject without returning raw filesystem errors', async t => {
  const f = await fixture(t); const record = f.store.publish(f.envelope);
  const bounded = createManagedSpecDispatchStore({ root: f.root, owner: f.owner, limits: { jsonBytes: 10 } });
  assert.throws(() => bounded.read(f.envelope.operationId), unavailable);
  const other = uuid('ao'); fs.writeFileSync(join(f.directory, other + '.json'), record.bytes);
  assert.throws(() => f.store.read(other), unavailable);
  assert.deepEqual(fs.readFileSync(f.file), record.bytes);
});

test('capacity is bounded with immutable history and same-key replay still works at capacity', async t => {
  const f = await fixture(t, { limits: { dispatches: 1 } });
  const first = f.store.publish(f.envelope);
  assert.deepEqual(f.store.publish(copy(f.envelope)), first);
  const next = copy(f.envelope); next.operationId = uuid('ao');
  assert.throws(() => f.store.publish(next), error => error.code === 'DISPATCH_CAPACITY_EXCEEDED');
  assert.deepEqual(f.store.list(), [first]);
  assert.deepEqual(fs.readFileSync(f.file), first.bytes);
  const empty = await fixture(t, { limits: { totalBytes: 1 } });
  assert.throws(() => empty.store.publish(empty.envelope), error => error.code === 'DISPATCH_CAPACITY_EXCEEDED');
  assert.deepEqual(fs.readdirSync(empty.directory), []);
});

test('guard cannot add files beyond the reserved directory budget; orphans still consume capacity', async t => {
  const f = await fixture(t, { limits: { directoryEntries: 2 } });
  let orphan;
  assert.throws(() => f.store.publish(f.envelope, { beforePublish() {
    orphan = join(f.directory, uuid('ao') + '.' + randomUUID() + '.tmp');
    fs.writeFileSync(orphan, '{}');
  } }), error => unavailable(error) && error.details.reason === 'DIRECTORY_CHANGED' && !error.writeMayHaveCommitted);
  assert.equal(f.store.read(f.envelope.operationId), null);
  assert.deepEqual(fs.readdirSync(f.directory), [orphan.split(/[\\/]/).at(-1)]);
  assert.throws(() => f.store.publish(f.envelope), error => error.code === 'DISPATCH_CAPACITY_EXCEEDED');
  assert.equal(fs.readFileSync(orphan, 'utf8'), '{}');
});

test('unlink cleanup failure keeps accepted bytes queryable and never replays an orphan as accepted', async t => {
  const f = await fixture(t, { io: { unlinkSync() { throw Error('cleanup unavailable'); } } });
  const record = f.store.publish(f.envelope);
  assert.equal(fs.readdirSync(f.directory).length, 2);
  assert.deepEqual(f.store.read(f.envelope.operationId), record);
  assert.deepEqual(f.store.list(), [record]);
  const rejecting = await fixture(t, { io: { unlinkSync() { throw Error('cleanup unavailable'); } } });
  assert.throws(() => rejecting.store.publish(rejecting.envelope, { beforePublish() { throw Error('guard failed'); } }), unavailable);
  assert.equal(rejecting.store.read(rejecting.envelope.operationId), null);
  assert.deepEqual(rejecting.store.list(), []);
  assert.equal(fs.readdirSync(rejecting.directory).length, 1);
});

test('linked directory and linked envelope are rejected', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, join(f.root, 'managed-spec-dispatches'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink privilege unavailable'); return; } throw error; }
  assert.throws(() => f.store.initialize(), unavailable);
  fs.unlinkSync(join(f.root, 'managed-spec-dispatches')); f.store.initialize();
  const target = join(outside, 'envelope.json'); fs.writeFileSync(target, JSON.stringify(f.envelope));
  try { fs.symlinkSync(target, f.file); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('file symlink privilege unavailable'); return; } throw error; }
  assert.throws(() => f.store.read(f.envelope.operationId), unavailable);
});
