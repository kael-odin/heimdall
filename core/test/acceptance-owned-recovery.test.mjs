import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE } from '../src/acceptance/owner.mjs';
import { createAcceptanceRun, recoverAcceptanceRuns } from '../src/acceptance/store.mjs';
import { createManagedAcceptanceRun, finishManagedAcceptanceRun, settleManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { recoverOwnedAcceptanceRuns, ACCEPTANCE_RECOVERY_LIMITS } from '../src/acceptance/recovery.mjs';

const fixtureRecord = JSON.parse(fs.readFileSync(new URL('../../docs/audits/2026-10-17/evidence/acceptance-managed-store/managed-preparation/prepared-record.json', import.meta.url), 'utf8'));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const put = (path, value) => fs.writeFileSync(path, encode(value));
const blocked = (action, expected = {}) => assert.throws(action, error => {
  assert.equal(error.code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  assert.equal(error.status, 503);
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  if (Object.hasOwn(expected, 'phase')) assert.equal(error.details.phase, expected.phase);
  if (Object.hasOwn(expected, 'count')) assert.equal(error.details.counts.totalInterrupted, expected.count);
  if (Object.hasOwn(expected, 'mayHaveCommitted')) assert.equal(error.writeMayHaveCommitted, expected.mayHaveCommitted);
  return true;
});

// Real historical, schema-validated dispatch bytes provide the authorization
// fixture. Fresh per-test operation/run/task IDs do not change its approved
// requirement projection. The actual owner-bound writer creates every run.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-owned-recovery-')));
  let owner = acquireAcceptanceOwner({ root });
  t.after(() => { owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const legacy = () => {
    const manifest = createAcceptanceRun(fixtureRecord.plan, { root });
    const dir = join(root, manifest.runId), path = join(dir, 'manifest.json');
    return { manifest, dir, path, bytes: fs.readFileSync(path) };
  };
  const prepare = (runId = 'ac-' + randomUUID()) => {
    const envelope = structuredClone(fixtureRecord);
    Object.assign(envelope, { operationId: 'ao-' + randomUUID(), dispatchId: 'ad-' + randomUUID(), runId, taskId: 'a-' + randomUUID() });
    const bytes = encode(envelope), namespace = join(root, 'managed-spec-dispatches', 'v1');
    fs.mkdirSync(namespace, { recursive: true });
    const sidecar = join(namespace, envelope.operationId + '.json');
    fs.writeFileSync(sidecar, bytes);
    const ref = { operationId: envelope.operationId, dispatchSha256: hash(bytes) };
    const dir = join(root, runId), path = join(dir, 'manifest.json'), report = join(dir, 'report.json');
    return { runId, dir, path, report, sidecar, namespace, ref, envelope,
      start: () => createManagedAcceptanceRun(ref, { owner, assertActive: () => true }),
      settle: () => settleManagedAcceptanceRun(ref, { status: 'failed', reasonCode: 'EXECUTION_FAILED', error: 'fixed test error' }, { owner }) };
  };
  return { root, get owner() { return owner; }, legacy, prepare,
    reacquire() { owner.release(); owner = acquireAcceptanceOwner({ root }); return owner; } };
}

function patched(name, replacement, action) {
  const original = nativeFs[name];
  nativeFs[name] = replacement(original); syncBuiltinESMExports();
  try { return action(); }
  finally { nativeFs[name] = original; syncBuiltinESMExports(); }
}

test('a fresh owner interrupts real managed and legacy facts once without replaying requests or publishing reports', t => {
  const f = fixture(t), legacy = [f.legacy(), f.legacy()], managed = [f.prepare(), f.prepare()], prepared = f.prepare();
  managed.forEach(item => item.start());
  const oldNonce = f.owner.nonce; f.reacquire(); assert.notEqual(f.owner.nonce, oldNonce);
  const counts = recoverOwnedAcceptanceRuns({ owner: f.owner });
  assert.deepEqual(counts, { managedInterrupted: 2, legacyInterrupted: 2, prepared: 1, skipped: 0, totalInterrupted: 4 });
  for (const item of managed) {
    const manifest = read(item.path);
    assert.equal(manifest.status, 'interrupted'); assert.equal(manifest.gate, 'blocked'); assert.equal(manifest.reasonCode, 'ENGINE_RESTARTED');
    assert.equal(manifest.reportSha256, undefined); assert.equal(fs.existsSync(item.report), false);
    assert.deepEqual(fs.readdirSync(item.dir), ['manifest.json']);
  }
  for (const item of legacy) { assert.equal(read(item.path).status, 'interrupted'); assert.equal(read(item.path).gate, 'blocked'); }
  assert.equal(fs.existsSync(prepared.dir), false);
  const originals = [...managed, ...legacy].map(item => fs.readFileSync(item.path));
  f.reacquire();
  assert.deepEqual(recoverOwnedAcceptanceRuns({ owner: f.owner }), { managedInterrupted: 0, legacyInterrupted: 0, prepared: 1, skipped: 4, totalInterrupted: 0 });
  [...managed, ...legacy].forEach((item, index) => assert.deepEqual(fs.readFileSync(item.path), originals[index]));
});

test('the compatibility recovery skips managed runs while recovering legacy after the complete strict preflight', t => {
  const f = fixture(t), legacy = f.legacy(), managed = f.prepare(); managed.start();
  fs.writeFileSync(managed.report, '{opaque partial');
  const bytes = fs.readFileSync(managed.path);
  assert.equal(recoverAcceptanceRuns({ root: f.root }), 1);
  assert.equal(read(legacy.path).status, 'interrupted'); assert.deepEqual(fs.readFileSync(managed.path), bytes);
  assert.equal(fs.readFileSync(managed.report, 'utf8'), '{opaque partial');
});

for (const collision of ['runId', 'taskId']) {
  test(`a duplicate dispatch ${collision} blocks healthy legacy recovery before publication`, t => {
    const f = fixture(t), legacy = f.legacy(), first = f.prepare(), second = f.prepare();
    const envelope = read(second.sidecar); envelope[collision] = first.envelope[collision]; put(second.sidecar, envelope);
    blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'preflight', count: 0, mayHaveCommitted: false });
    assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes);
    assert.equal(fs.existsSync(first.dir), false); assert.equal(fs.existsSync(second.dir), false);
  });
}

for (const variant of ['invalid manifest', 'invalid namespace', 'partial identity', 'report-only marker', 'orphan manifest marker', 'invalid legacy report']) {
  test(`the whole preflight preserves every healthy legacy fact before a final ${variant}`, t => {
    const f = fixture(t), legacy = [f.legacy(), f.legacy()];
    if (variant === 'invalid manifest' || variant === 'partial identity') {
      const bad = f.prepare('ac-ffffffff-ffff-ffff-ffff-ffffffffffff');
      if (variant === 'invalid manifest') { bad.start(); fs.writeFileSync(bad.path, '{SECRET invalid'); }
      else fs.mkdirSync(bad.dir);
    } else if (variant === 'invalid namespace') {
      const managed = f.prepare(); managed.start(); fs.writeFileSync(join(managed.namespace, 'unrecognized.json'), '{}');
    } else {
      const bad = f.legacy(), target = join(f.root, 'ac-ffffffff-ffff-ffff-ffff-ffffffffffff');
      fs.renameSync(bad.dir, target);
      const path = join(target, 'manifest.json'), manifest = read(path); manifest.runId = 'ac-ffffffff-ffff-ffff-ffff-ffffffffffff';
      if (variant === 'orphan manifest marker') manifest.managed = {};
      put(path, manifest);
      if (variant === 'report-only marker') put(join(target, 'report.json'), { managed: {} });
      if (variant === 'invalid legacy report') fs.writeFileSync(join(target, 'report.json'), '{SECRET invalid');
    }
    blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'preflight', count: 0, mayHaveCommitted: false });
    legacy.forEach(item => assert.deepEqual(fs.readFileSync(item.path), item.bytes));
    blocked(() => recoverAcceptanceRuns({ root: f.root }), { phase: 'preflight', count: 0, mayHaveCommitted: false });
    legacy.forEach(item => assert.deepEqual(fs.readFileSync(item.path), item.bytes));
  });
}

for (const status of ['running', 'terminal']) {
  for (const opaque of ['malformed', 'hardlink', 'symlink', 'fifo']) {
    test(`${status} managed ${opaque} partial report and evidence remain opaque and unchanged`, t => {
      if (opaque === 'fifo' && process.platform === 'win32') return t.skip('POSIX FIFO is exercised by the Linux recovery suite');
      const f = fixture(t), managed = f.prepare(); managed.start();
      if (status === 'terminal') managed.settle();
      const original = Buffer.from('{SECRET opaque partial\n'), evidence = join(managed.dir, 'partial-evidence.json');
      fs.writeFileSync(evidence, original);
      if (opaque === 'malformed') fs.writeFileSync(managed.report, original);
      else if (opaque === 'hardlink') { fs.linkSync(evidence, managed.report); assert.equal(fs.lstatSync(managed.report).nlink, 2); }
      else if (opaque === 'symlink') {
        try { fs.symlinkSync(evidence, managed.report, 'file'); }
        catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows host does not grant file symlink creation'); throw error; }
      } else assert.equal(spawnSync('mkfifo', [managed.report]).status, 0);
      const reportPin = fs.lstatSync(managed.report, { bigint: true }), manifestBefore = fs.readFileSync(managed.path);
      const counts = patched('openSync', originalOpen => (path, ...args) => {
        if (path === managed.report || path === evidence) throw Error('opaque partial must never be opened');
        return originalOpen(path, ...args);
      }, () => recoverOwnedAcceptanceRuns({ owner: f.owner }));
      assert.equal(counts.totalInterrupted, status === 'running' ? 1 : 0);
      assert.equal(counts.skipped, status === 'terminal' ? 1 : 0);
      if (status === 'terminal') assert.deepEqual(fs.readFileSync(managed.path), manifestBefore);
      else assert.equal(read(managed.path).status, 'interrupted');
      const reportNow = fs.lstatSync(managed.report, { bigint: true });
      for (const key of ['dev', 'ino', 'nlink', 'mode', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(reportNow[key], reportPin[key]);
      assert.deepEqual(fs.readFileSync(evidence), original);
      if (opaque !== 'fifo') assert.deepEqual(fs.readFileSync(managed.report), original);
    });
  }
}

test('a completed managed head is skipped even when its historical report and referenced evidence are unreadable', async t => {
  const f = fixture(t), managed = f.prepare(); managed.start();
  const fetchBefore = globalThis.fetch; let requests = 0;
  let report;
  try {
    // Produce the normal runner's complete offline fixture and exact evidence
    // bytes, then forbid every request during the synchronous startup barrier.
    globalThis.fetch = async (_url, options) => {
      requests++;
      return options.method === 'HEAD' ? new Response(null, { status: 204 })
        : new Response('{"code":0,"quota":1,"enabled":false,"name":""}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const raw = await runSpecAcceptance(managed.envelope.plan, { runId: managed.runId, outputDir: managed.dir });
    report = finishManagedAcceptanceRun(managed.ref, raw, { owner: f.owner, assertActive: () => true });
    assert.equal(requests, 2); assert.equal(read(managed.path).status, 'completed');
    fs.writeFileSync(managed.report, '{SECRET invalid historical report');
    const evidence = join(managed.dir, report.evidenceManifest[0].file); fs.writeFileSync(evidence, '{SECRET invalid historical evidence');
    const before = fs.readFileSync(managed.path), reportBefore = fs.readFileSync(managed.report), evidenceBefore = fs.readFileSync(evidence);
    globalThis.fetch = () => { throw Error('recovery must never request the target'); };
    assert.deepEqual(recoverOwnedAcceptanceRuns({ owner: f.owner }), { managedInterrupted: 0, legacyInterrupted: 0, prepared: 0, skipped: 1, totalInterrupted: 0 });
    assert.deepEqual(fs.readFileSync(managed.path), before); assert.deepEqual(fs.readFileSync(managed.report), reportBefore);
    assert.deepEqual(fs.readFileSync(evidence), evidenceBefore); assert.equal(requests, 2);
  } finally { globalThis.fetch = fetchBefore; }
});

test('recovery requires the private live owner capability before reading an attacker-shaped root', t => {
  const f = fixture(t), managed = f.prepare(); managed.start(); const before = fs.readFileSync(managed.path); let hooks = 0;
  const fake = { get root() { hooks++; throw Error('SECRET'); }, assertOwned() { hooks++; return true; } };
  for (const owner of [fake, { ...f.owner }, new Proxy(f.owner, { get() { hooks++; throw Error('SECRET'); } })]) {
    assert.throws(() => recoverOwnedAcceptanceRuns({ owner }), error => error.code === 'ACCEPTANCE_OWNER_UNAVAILABLE');
  }
  assert.equal(hooks, 0); assert.deepEqual(fs.readFileSync(managed.path), before);
  f.owner.release();
  assert.throws(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), error => error.code === 'ACCEPTANCE_OWNER_LOST');
  assert.deepEqual(fs.readFileSync(managed.path), before);
});

test('an owned root disappearing at its first owner check loses authority without writes while an absent legacy root stays compatible', t => {
  const f = fixture(t), legacy = f.legacy(), moved = f.root + '.moved', writes = [];
  const mutations = ['mkdirSync', 'writeSync', 'writeFileSync', 'fsyncSync', 'linkSync', 'renameSync', 'unlinkSync'];
  const originals = new Map(mutations.map(name => [name, nativeFs[name]])), originalLstat = nativeFs.lstatSync;
  let injected = false;
  try {
    for (const name of mutations) nativeFs[name] = () => { writes.push(name); throw Error('recovery must not write after root loss'); };
    nativeFs.lstatSync = (path, ...args) => {
      if (!injected && path === f.root) {
        injected = true; originals.get('renameSync')(f.root, moved);
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), error => {
      assert.equal(error.code, 'ACCEPTANCE_OWNER_LOST');
      assert.equal(error.status, 503);
      assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
      return true;
    });
    assert.equal(injected, true); assert.deepEqual(writes, []);
    assert.deepEqual(fs.readFileSync(join(moved, legacy.manifest.runId, 'manifest.json')), legacy.bytes);
  } finally {
    nativeFs.lstatSync = originalLstat;
    for (const [name, original] of originals) nativeFs[name] = original;
    syncBuiltinESMExports();
    if (fs.existsSync(moved)) fs.renameSync(moved, f.root);
  }
  const missing = join(f.root, 'absent-legacy-root');
  assert.equal(recoverAcceptanceRuns({ root: missing }), 0); assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes);
});

for (const [name, limit] of [['runs', 1], ['rootEntries', 1], ['settlements', 1], ['capturedFiles', 1], ['capturedBytes', 1], ['jsonBytes', 1]]) {
  test(`tightened ${name} budget rejects the full batch before any manifest publication`, t => {
    const f = fixture(t), legacy = f.legacy(), managed = f.prepare(); managed.start(); const before = fs.readFileSync(managed.path);
    blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner, limits: { [name]: limit } }), { phase: 'preflight', count: 0, mayHaveCommitted: false });
    assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes); assert.deepEqual(fs.readFileSync(managed.path), before);
  });
}

test('limits only tighten supported finite integer budgets', t => {
  const f = fixture(t);
  for (const limits of [{ settlements: ACCEPTANCE_RECOVERY_LIMITS.settlements + 1 }, { runs: -1 }, { jsonBytes: 1.5 }, { capturedFiles: Infinity }, { unsupported: 1 }]) {
    assert.throws(() => recoverOwnedAcceptanceRuns({ owner: f.owner, limits }), error => error.code === 'INVALID_INPUT');
  }
});

test('an inventory addition at the first temporary allocation blocks all formal writes', t => {
  const f = fixture(t), legacy = f.legacy(), managed = f.prepare(); managed.start(); const before = fs.readFileSync(managed.path); let injected = false;
  patched('openSync', originalOpen => (path, ...args) => {
    if (!injected && typeof path === 'string' && path.startsWith(managed.path + '.') && path.endsWith('.tmp')) {
      injected = true; fs.mkdirSync(join(f.root, 'ac-ffffffff-ffff-ffff-ffff-ffffffffffff'));
    }
    return originalOpen(path, ...args);
  }, () => blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'managed', count: 0, mayHaveCommitted: false }));
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes); assert.deepEqual(fs.readFileSync(managed.path), before);
});

test('a changed captured running manifest cannot become a fresh expected head during commit', t => {
  const f = fixture(t), legacy = f.legacy(), managed = f.prepare(); managed.start(); let injected = false, changed;
  patched('openSync', originalOpen => (path, ...args) => {
    if (!injected && typeof path === 'string' && path.startsWith(managed.path + '.') && path.endsWith('.tmp')) {
      injected = true; const manifest = read(managed.path); manifest.updatedAt = '2026-10-17T01:02:03.004Z'; put(managed.path, manifest); changed = fs.readFileSync(managed.path);
    }
    return originalOpen(path, ...args);
  }, () => blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'managed', count: 0, mayHaveCommitted: false }));
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(managed.path), changed); assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes);
});

test('owner loss at allocation blocks the formal manifest and does not enter legacy recovery', t => {
  const f = fixture(t), legacy = f.legacy(), managed = f.prepare(); managed.start(); const before = fs.readFileSync(managed.path); let injected = false;
  const lockPath = join(f.root, ACCEPTANCE_OWNER_FILE), lockBefore = fs.readFileSync(lockPath);
  try {
    patched('openSync', originalOpen => (path, ...args) => {
      if (!injected && typeof path === 'string' && path.startsWith(managed.path + '.') && path.endsWith('.tmp')) {
        injected = true; const lock = read(lockPath); lock.nonce = 'a'.repeat(64); put(lockPath, lock);
      }
      return originalOpen(path, ...args);
    }, () => blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'managed', count: 0, mayHaveCommitted: false }));
    assert.equal(injected, true); assert.deepEqual(fs.readFileSync(managed.path), before); assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes);
  } finally { fs.writeFileSync(lockPath, lockBefore); }
});

test('a second managed publication failure preserves the first fact, reports its count, and leaves all legacy facts untouched', t => {
  const f = fixture(t), legacy = f.legacy(), first = f.prepare('ac-11111111-1111-1111-1111-111111111111'), second = f.prepare('ac-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
  first.start(); second.start(); const secondBefore = fs.readFileSync(second.path); let failures = 0;
  patched('renameSync', originalRename => (from, to) => {
    if (to === second.path) { failures++; const error = Error('SECRET simulated IO fault'); error.code = 'EIO'; throw error; }
    return originalRename(from, to);
  }, () => blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'managed', count: 1, mayHaveCommitted: true }));
  assert.equal(failures, 1); assert.equal(read(first.path).status, 'interrupted'); assert.deepEqual(fs.readFileSync(second.path), secondBefore);
  assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes);
});

test('an uncertain legacy publication stops the batch and a fresh owner settles only the remaining running facts', t => {
  const f = fixture(t), legacy = [f.legacy(), f.legacy()].sort((a, b) => a.manifest.runId.localeCompare(b.manifest.runId));
  const managed = f.prepare(); managed.start(); let injected = false;
  patched('renameSync', originalRename => (from, to) => {
    const result = originalRename(from, to);
    if (!injected && to === legacy[0].path) {
      injected = true; const error = Error('SECRET publication committed before IO failure'); error.code = 'EIO'; throw error;
    }
    return result;
  }, () => assert.throws(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), error => {
    assert.equal(error.code, 'ACCEPTANCE_RECOVERY_BLOCKED'); assert.equal(error.details.phase, 'legacy');
    assert.equal(error.details.counts.managedInterrupted, 1); assert.equal(error.details.counts.legacyInterrupted, 0);
    assert.equal(error.details.counts.totalInterrupted, 1); assert.equal(error.writeMayHaveCommitted, true);
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
    return true;
  }));
  assert.equal(injected, true); assert.equal(read(managed.path).status, 'interrupted'); assert.equal(read(legacy[0].path).status, 'interrupted');
  assert.deepEqual(fs.readFileSync(legacy[1].path), legacy[1].bytes);
  const managedBefore = fs.readFileSync(managed.path), settledBefore = fs.readFileSync(legacy[0].path);
  f.reacquire();
  assert.deepEqual(recoverOwnedAcceptanceRuns({ owner: f.owner }), { managedInterrupted: 0, legacyInterrupted: 1, prepared: 0, skipped: 2, totalInterrupted: 1 });
  assert.deepEqual(fs.readFileSync(managed.path), managedBefore); assert.deepEqual(fs.readFileSync(legacy[0].path), settledBefore);
  assert.equal(read(legacy[1].path).status, 'interrupted');
});

test('a legacy witness changed after managed settlement blocks the legacy phase without undoing the managed fact', t => {
  const f = fixture(t), legacy = f.legacy(), managed = f.prepare(); managed.start(); let injected = false;
  patched('renameSync', originalRename => (from, to) => {
    const result = originalRename(from, to);
    if (!injected && to === managed.path) { injected = true; fs.writeFileSync(join(legacy.dir, 'report.json'), '{"new":"report"}\n'); }
    return result;
  }, () => blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'legacy', count: 1, mayHaveCommitted: true }));
  assert.equal(injected, true); assert.equal(read(managed.path).status, 'interrupted'); assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes);
});

test('the fresh managed scope never adopts an externally changed head after our own settlements', t => {
  const f = fixture(t), legacy = f.legacy(), first = f.prepare('ac-11111111-1111-1111-1111-111111111111'), second = f.prepare('ac-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
  first.start(); second.start(); let injected = false, changed;
  patched('renameSync', originalRename => (from, to) => {
    const result = originalRename(from, to);
    if (!injected && to === second.path) {
      injected = true; const manifest = read(first.path); manifest.error = 'external but structurally valid interruption'; put(first.path, manifest); changed = fs.readFileSync(first.path);
    }
    return result;
  }, () => blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner }), { phase: 'legacy', count: 2, mayHaveCommitted: true }));
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(first.path), changed); assert.equal(read(second.path).status, 'interrupted');
  assert.deepEqual(fs.readFileSync(legacy.path), legacy.bytes);
});

test('a terminal encoding that exceeds a tightened JSON budget blocks the full batch during preflight', t => {
  const f = fixture(t), first = f.prepare('ac-11111111-1111-1111-1111-111111111111'), second = f.prepare('ac-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
  first.start(); second.start();
  // Add valid running progress to the later head, making its terminal encoding
  // exceed the limit while the earlier terminal would still fit.
  const secondManifest = read(second.path); secondManifest.progress = { kind: 'acceptance-heartbeat', message: 'x'.repeat(600) }; put(second.path, secondManifest);
  const before = [first, second].map(item => fs.readFileSync(item.path));
  const jsonBytes = Math.max(...before.map(bytes => bytes.length));
  assert.ok(before[0].length + 300 < jsonBytes, 'the first terminal fits while the later terminal must exceed the tightened budget');
  blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner, limits: { jsonBytes } }), { phase: 'preflight', count: 0, mayHaveCommitted: false });
  [first, second].forEach((item, index) => assert.deepEqual(fs.readFileSync(item.path), before[index]));
});

test('an oversized legacy settlement is rejected before a smaller managed settlement can be published', t => {
  const f = fixture(t), legacy = f.legacy(), managed = f.prepare(); managed.start();
  const manifest = read(legacy.path); manifest.progress = { kind: 'acceptance-heartbeat', message: 'x'.repeat(12_000) }; put(legacy.path, manifest);
  const legacyBefore = fs.readFileSync(legacy.path), managedBefore = fs.readFileSync(managed.path), jsonBytes = legacyBefore.length;
  assert.ok(managedBefore.length + 300 < jsonBytes);
  blocked(() => recoverOwnedAcceptanceRuns({ owner: f.owner, limits: { jsonBytes } }), { phase: 'preflight', count: 0, mayHaveCommitted: false });
  assert.deepEqual(fs.readFileSync(legacy.path), legacyBefore); assert.deepEqual(fs.readFileSync(managed.path), managedBefore);
});
