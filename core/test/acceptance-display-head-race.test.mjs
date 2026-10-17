import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAcceptanceRun, updateAcceptanceRun, finishAcceptanceRun, readAcceptanceRun, readAcceptanceDisplayRun,
  listAcceptanceRuns, readAcceptanceSnapshot, readAcceptanceArtifact, acceptanceArtifact, saveAcceptanceTriage } from '../src/acceptance/store.mjs';
import { createAcceptanceReadScope, createAcceptanceDisplayReadScope, captureAcceptanceRunHead,
  captureAcceptanceRunFile, assertAcceptanceReadScope, captureManagedCompletedRun } from '../src/acceptance/managed-run-reader.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { managedExecutionFixture } from '../scripts/fixtures/managed-execution.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress } from '../src/acceptance/managed-run-store.mjs';

const integrity = { code: 'MANAGED_RUN_INTEGRITY_FAILED', status: 409 };
const encode = value => JSON.stringify(value, null, 2) + '\n';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-display-head-race-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = createAcceptanceRun({ name: 'display publication race', baselineUrl: 'https://baseline.test',
    targetUrl: 'https://target.test' }, { root });
  return { root, runId: manifest.runId, path: join(root, manifest.runId, 'manifest.json'), manifest };
}
function duringClose(path, publish, read) {
  const open = nativeFs.openSync, close = nativeFs.closeSync, descriptors = new Map();
  let publications = 0, publishing = false;
  nativeFs.openSync = (current, ...args) => {
    const descriptor = open(current, ...args);
    descriptors.set(descriptor, String(current));
    return descriptor;
  };
  nativeFs.closeSync = descriptor => {
    close(descriptor);
    const current = descriptors.get(descriptor); descriptors.delete(descriptor);
    // Publish only after the reader closes its descriptor: Windows correctly
    // denies rename while that handle is open. This models the child writer
    // winning between a stable capture and the next scope fence.
    if (current === path && !publishing) {
      publishing = true;
      try { publications += publish(publications) ? 1 : 0; }
      finally { publishing = false; }
    }
  };
  syncBuiltinESMExports();
  try { return { value: read(), publications }; }
  finally { nativeFs.openSync = open; nativeFs.closeSync = close; syncBuiltinESMExports(); }
}
function listOrder(root) {
  const handle = fs.opendirSync(root), names = []; let entry;
  try { while ((entry = handle.readSync())) if (entry.name.startsWith('ac-')) names.push(entry.name); }
  finally { handle.closeSync(); }
  return names;
}
function releasedDescriptor(f, mutation, read) {
  const open = nativeFs.openSync, close = nativeFs.closeSync, fstat = nativeFs.fstatSync, lstat = nativeFs.lstatSync;
  const descriptors = new Map(); let released = false;
  nativeFs.openSync = (path, ...args) => {
    const descriptor = open(path, ...args);
    if (String(path) === f.path) descriptors.set(descriptor, 0);
    return descriptor;
  };
  nativeFs.fstatSync = (descriptor, ...args) => {
    const stat = fstat(descriptor, ...args);
    if (!descriptors.has(descriptor)) return stat;
    const count = descriptors.get(descriptor) + 1; descriptors.set(descriptor, count);
    if (count < 2) return stat;
    released = true;
    // Model Linux's detached old fd while Windows denies the actual rename.
    return Object.assign(Object.create(stat), { nlink: 0n, ctimeNs: stat.ctimeNs + 1n,
      ...(mutation === 'write' ? { mtimeNs: stat.mtimeNs + 1n } : {}),
      ...(mutation === 'permissions' ? { mode: stat.mode ^ 0o200n } : {}) });
  };
  nativeFs.lstatSync = (path, ...args) => {
    const stat = lstat(path, ...args);
    return String(path) === f.path && released ? Object.assign(Object.create(stat), { ino: stat.ino + 1n,
      birthtimeNs: stat.birthtimeNs + 1n }) : stat;
  };
  nativeFs.closeSync = descriptor => { descriptors.delete(descriptor); return close(descriptor); };
  syncBuiltinESMExports();
  try { return read(); }
  finally {
    nativeFs.openSync = open; nativeFs.closeSync = close; nativeFs.fstatSync = fstat; nativeFs.lstatSync = lstat;
    syncBuiltinESMExports();
  }
}

test('detached descriptor link/ctime metadata preserves display bytes while strict reads still reject it', t => {
  const f = fixture(t);
  assert.deepEqual(releasedDescriptor(f, 'unlink', () => readAcceptanceDisplayRun(f.runId, { root: f.root })), f.manifest);
  assert.throws(() => releasedDescriptor(f, 'unlink', () => readAcceptanceRun(f.runId, { root: f.root })), integrity);
  for (const mutation of ['write', 'permissions']) {
    assert.throws(() => releasedDescriptor(f, mutation, () => readAcceptanceDisplayRun(f.runId, { root: f.root })), integrity);
  }
});

test('an actual Linux rename while a descriptor is open returns only that descriptor version', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), open = nativeFs.openSync, close = nativeFs.closeSync, read = nativeFs.readSync;
  const descriptors = new Set(); let publications = 0;
  nativeFs.openSync = (path, ...args) => {
    const descriptor = open(path, ...args); if (String(path) === f.path) descriptors.add(descriptor); return descriptor;
  };
  nativeFs.readSync = (descriptor, ...args) => {
    const count = read(descriptor, ...args);
    if (descriptors.has(descriptor) && count > 0 && !publications) {
      publications++;
      writeAtomicFileSync(f.path, encode({ ...f.manifest, progress: { kind: 'new-linux-inode' } }));
    }
    return count;
  };
  nativeFs.closeSync = descriptor => { descriptors.delete(descriptor); return close(descriptor); };
  syncBuiltinESMExports();
  try { assert.deepEqual(readAcceptanceDisplayRun(f.runId, { root: f.root }), f.manifest); }
  finally { nativeFs.openSync = open; nativeFs.closeSync = close; nativeFs.readSync = read; syncBuiltinESMExports(); }
  assert.equal(publications, 1);
  assert.deepEqual(readAcceptanceDisplayRun(f.runId, { root: f.root }).progress, { kind: 'new-linux-inode' });
});

test('replacement before the first open captures the new stable descriptor bytes', t => {
  const f = fixture(t), open = nativeFs.openSync; let publications = 0;
  nativeFs.openSync = (path, ...args) => {
    if (String(path) === f.path && !publications) {
      publications++;
      writeAtomicFileSync(f.path, encode({ ...f.manifest, progress: { kind: 'before-first-open' } }));
    }
    return open(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const value = readAcceptanceDisplayRun(f.runId, { root: f.root });
    assert.equal(publications, 1); assert.deepEqual(value.progress, { kind: 'before-first-open' });
  } finally { nativeFs.openSync = open; syncBuiltinESMExports(); }
});

test('a larger replacement before open cannot exceed the configured JSON allocation limit', t => {
  const f = fixture(t), open = nativeFs.openSync, maxBytes = fs.statSync(f.path).size;
  const scope = createAcceptanceDisplayReadScope({ root: f.root, limits: { jsonBytes: maxBytes } }); let publications = 0;
  nativeFs.openSync = (path, ...args) => {
    if (String(path) === f.path && !publications) {
      publications++;
      writeAtomicFileSync(f.path, encode({ ...f.manifest, progress: { value: 'x'.repeat(maxBytes) } }));
    }
    return open(path, ...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => captureAcceptanceRunHead(f.runId, { scope }), integrity); }
  finally { nativeFs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(publications, 1);
});

for (const list of [false, true]) test(`${list ? 'list' : 'detail'} display retains its captured legacy version until the next request`, t => {
  const f = fixture(t);
  const { value, publications } = duringClose(f.path, count => {
    if (count) return false;
    updateAcceptanceRun(f.runId, { progress: { kind: 'observing', completed: 1, total: 2 } }, { root: f.root });
    return true;
  }, () => list ? listAcceptanceRuns({ root: f.root }).find(row => row.runId === f.runId)
    : readAcceptanceDisplayRun(f.runId, { root: f.root }));
  assert.equal(publications, 1);
  assert.equal(value.status, 'running');
  assert.equal(value.progress, null);
  assert.deepEqual(readAcceptanceDisplayRun(f.runId, { root: f.root }).progress, { kind: 'observing', completed: 1, total: 2 });
  assert.deepEqual(fs.readdirSync(join(f.root, f.runId)), ['manifest.json']);
});

test('completion publishes without replacing the request-local captured running manifest', t => {
  const f = fixture(t);
  const { value, publications } = duringClose(f.path, count => {
    if (count) return false;
    finishAcceptanceRun(f.runId, { mode: 'mirror', name: f.manifest.name, checks: [],
      endedAt: new Date().toISOString() }, { root: f.root });
    return true;
  }, () => readAcceptanceDisplayRun(f.runId, { root: f.root }));
  assert.equal(publications, 1); assert.equal(value.status, 'running');
  const saved = JSON.parse(fs.readFileSync(f.path));
  assert.deepEqual(value, f.manifest); assert.equal(saved.status, 'completed');
  assert.deepEqual(readAcceptanceDisplayRun(f.runId, { root: f.root }), saved);
  assert.match(saved.reportSha256, /^[a-f0-9]{64}$/);
});

test('a first report publication retains the captured absence in the same display batch', t => {
  const f = fixture(t), reportPath = join(f.root, f.runId, 'report.json'); let closes = 0;
  const { value, publications } = duringClose(f.path, () => {
    if (++closes !== 2) return false;
    writeAtomicFileSync(reportPath, encode({ runId: f.runId, status: 'completed', checks: [] })); return true;
  }, () => readAcceptanceDisplayRun(f.runId, { root: f.root }));
  assert.equal(publications, 1); assert.equal(value.status, 'running');
  assert.deepEqual(value, f.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath)), { runId: f.runId, status: 'completed', checks: [] });
});

test('publication during the final scope fence retains the earlier captured display head', t => {
  const f = fixture(t); let closes = 0;
  const { value, publications } = duringClose(f.path, () => {
    if (++closes !== 3) return false;
    updateAcceptanceRun(f.runId, { progress: { kind: 'final-fence-publication' } }, { root: f.root }); return true;
  }, () => readAcceptanceDisplayRun(f.runId, { root: f.root }));
  assert.equal(publications, 1); assert.equal(value.progress, null);
  assert.deepEqual(readAcceptanceDisplayRun(f.runId, { root: f.root }).progress, { kind: 'final-fence-publication' });
});

test('display never reopens an atomically replaced captured head or waits for a continuously changing writer', t => {
  const f = fixture(t); let publications = 0;
  const result = duringClose(f.path, () => {
    publications++;
    writeAtomicFileSync(f.path, encode({ ...f.manifest, progress: { publication: publications } }));
    return true;
  }, () => readAcceptanceDisplayRun(f.runId, { root: f.root }));
  assert.equal(publications, 1); assert.deepEqual(result.value, f.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.path)).progress, { publication: 1 });
});

test('display uses one complete list batch and never adopts later facts by retrying its inventory', t => {
  const f = fixture(t), opendir = nativeFs.opendirSync; let attempts = 0, publishedAttempt = 0;
  nativeFs.opendirSync = (path, ...args) => {
    if (String(path) === f.root) attempts++;
    return opendir(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = duringClose(f.path, () => {
      if (publishedAttempt === attempts) return false;
      publishedAttempt = attempts;
      writeAtomicFileSync(f.path, encode({ ...f.manifest, progress: { publication: attempts } })); return true;
    }, () => listAcceptanceRuns({ root: f.root }));
    assert.equal(result.value.find(row => row.runId === f.runId).progress, null);
  } finally { nativeFs.opendirSync = opendir; syncBuiltinESMExports(); }
  assert.equal(attempts, 1); assert.equal(publishedAttempt, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.path)).progress, { publication: 1 });
});

test('new malformed heads or managed markers are never adopted by a captured display version and the next request rejects them', t => {
  for (const malformed of [true, false]) {
    const f = fixture(t); let bytes;
    const result = duringClose(f.path, count => {
      if (count) return false;
      bytes = malformed ? '{malformed' : encode({ ...f.manifest, managed: {} });
      writeAtomicFileSync(f.path, bytes); return true;
    }, () => readAcceptanceDisplayRun(f.runId, { root: f.root }));
    assert.deepEqual(result.value, f.manifest);
    assert.throws(() => readAcceptanceDisplayRun(f.runId, { root: f.root }), integrity);
    assert.throws(() => readAcceptanceRun(f.runId, { root: f.root }), integrity);
    assert.equal(fs.readFileSync(f.path, 'utf8'), bytes);
  }
});

test('a displayed completed version never authorizes artifacts or triage after a new managed marker appears', t => {
  const f = fixture(t);
  finishAcceptanceRun(f.runId, { mode: 'mirror', status: 'completed', baselineUrl: f.manifest.baselineUrl,
    targetUrl: f.manifest.targetUrl, checks: [] }, { root: f.root });
  const completed = readAcceptanceRun(f.runId, { root: f.root });
  const result = duringClose(f.path, count => {
    if (count) return false;
    writeAtomicFileSync(f.path, encode({ ...completed, managed: {} })); return true;
  }, () => readAcceptanceDisplayRun(f.runId, { root: f.root }));
  assert.deepEqual(result.value, completed); assert.equal(result.value.managed, undefined);
  assert.throws(() => readAcceptanceRun(f.runId, { root: f.root }), integrity);
  assert.throws(() => readAcceptanceArtifact(f.runId, 'report.json', { root: f.root }), integrity);
  assert.throws(() => acceptanceArtifact(f.runId, 'report.json', { root: f.root }), { code: 'MANAGED_EXECUTION_REQUIRED' });
  assert.throws(() => saveAcceptanceTriage(f.runId, {}, { root: f.root }), { code: 'MANAGED_EXECUTION_REQUIRED' });
  assert.equal(fs.existsSync(join(f.root, f.runId, 'triage.json')), false);
});

test('in-place mutations do not qualify as an atomic publication retry', t => {
  const f = fixture(t); let publications = 0;
  assert.throws(() => duringClose(f.path, () => {
    publications++; fs.writeFileSync(f.path, encode({ ...f.manifest, progress: { changed: true } })); return true;
  }, () => readAcceptanceDisplayRun(f.runId, { root: f.root })), integrity);
  assert.equal(publications, 1);
});

test('in-place permission changes and new hardlinks do not qualify as head publication retries', t => {
  for (const hardlink of [false, true]) {
    const f = fixture(t); let publications = 0;
    try {
      assert.throws(() => duringClose(f.path, () => {
        publications++;
        if (hardlink) fs.linkSync(f.path, join(f.root, f.runId, 'linked-head.json'));
        else fs.chmodSync(f.path, 0o400);
        return true;
      }, () => readAcceptanceDisplayRun(f.runId, { root: f.root })), integrity);
      assert.equal(publications, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.path)), f.manifest);
    } finally { fs.chmodSync(f.path, 0o600); }
  }
});

for (const replacement of ['run', 'root', 'dispatch']) test(`${replacement} namespace replacement is never adopted as a head publication`, t => {
  const f = fixture(t); let publications = 0;
  const parked = replacement === 'root' ? f.root + '.original' : join(f.root, '.original-run');
  t.after(() => { if (replacement === 'root') fs.rmSync(parked, { recursive: true, force: true }); });
  assert.throws(() => duringClose(f.path, () => {
    publications++;
    if (replacement === 'dispatch') {
      writeAtomicFileSync(f.path, encode({ ...f.manifest, progress: { changed: true } }));
      fs.mkdirSync(join(f.root, 'managed-spec-dispatches', 'v1'), { recursive: true });
    } else {
      const original = replacement === 'root' ? f.root : join(f.root, f.runId);
      fs.renameSync(original, parked); fs.cpSync(parked, original, { recursive: true });
    }
    return true;
  }, () => readAcceptanceDisplayRun(f.runId, { root: f.root })), integrity);
  assert.equal(publications, 1);
});

test('real reserved managed progress keeps its original fixed-scope refusal during publication', async t => {
  const f = await managedExecutionFixture({ paths: ['/healthy'] }); t.after(() => f.cleanup());
  const prepared = await f.prepareOnly(), ref = { operationId: prepared.envelope.operationId, dispatchSha256: prepared.record.sha256 };
  const options = { owner: f.owner, assertActive: () => true };
  createManagedAcceptanceRun(ref, options);
  const path = join(f.root, prepared.envelope.runId, 'manifest.json'); let publications = 0;
  assert.throws(() => duringClose(path, () => {
    publications++;
    updateManagedAcceptanceProgress(ref, { progress: { kind: 'acceptance-check', completed: 1, total: 1 } }, options); return true;
  }, () => readAcceptanceDisplayRun(prepared.envelope.runId, { root: f.root })), integrity);
  assert.equal(publications, 1); assert.equal(f.requests.length, 0);
  assert.equal(readAcceptanceDisplayRun(prepared.envelope.runId, { root: f.root }).progress.completed, 1);
});

for (const mutation of ['run-directory', 'in-place', 'permissions', 'hardlink']) test(`a later legacy publication cannot hide an earlier ${mutation} change in the display batch`, t => {
  const f = fixture(t);
  createAcceptanceRun({ baselineUrl: 'https://baseline.test', targetUrl: 'https://target.test' }, { root: f.root });
  const ids = listOrder(f.root), firstPath = join(f.root, ids[0], 'manifest.json'), secondPath = join(f.root, ids[1], 'manifest.json');
  const first = JSON.parse(fs.readFileSync(firstPath)), second = JSON.parse(fs.readFileSync(secondPath));
  let publications = 0;
  try {
    assert.throws(() => duringClose(secondPath, () => {
      publications++;
      if (mutation === 'run-directory') {
        const directory = join(f.root, ids[0]), parked = join(f.root, '.earlier-run');
        fs.renameSync(directory, parked); fs.cpSync(parked, directory, { recursive: true });
      } else if (mutation === 'in-place') fs.writeFileSync(firstPath, encode({ ...first, progress: { kind: 'in-place-tamper' } }));
      else if (mutation === 'permissions') fs.chmodSync(firstPath, 0o400);
      else fs.linkSync(firstPath, join(f.root, ids[0], 'linked-head.json'));
      writeAtomicFileSync(secondPath, encode({ ...second, progress: { kind: 'legitimate-publication' } })); return true;
    }, () => listAcceptanceRuns({ root: f.root })), integrity);
    assert.equal(publications, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(secondPath)).progress, { kind: 'legitimate-publication' });
  } finally { fs.chmodSync(firstPath, 0o600); }
});

test('two ordinary head publications leave both previously captured list versions untouched', t => {
  const f = fixture(t);
  createAcceptanceRun({ baselineUrl: 'https://baseline.test', targetUrl: 'https://target.test' }, { root: f.root });
  const ids = listOrder(f.root), firstPath = join(f.root, ids[0], 'manifest.json'), secondPath = join(f.root, ids[1], 'manifest.json');
  const first = JSON.parse(fs.readFileSync(firstPath)), second = JSON.parse(fs.readFileSync(secondPath));
  const { value, publications } = duringClose(secondPath, count => {
    if (count) return false;
    writeAtomicFileSync(firstPath, encode({ ...first, progress: { kind: 'first-publication' } }));
    writeAtomicFileSync(secondPath, encode({ ...second, progress: { kind: 'second-publication' } })); return true;
  }, () => listAcceptanceRuns({ root: f.root }));
  assert.equal(publications, 1);
  assert.equal(value.find(row => row.runId === ids[0]).progress, null);
  assert.equal(value.find(row => row.runId === ids[1]).progress, null);
  const current = listAcceptanceRuns({ root: f.root });
  assert.deepEqual(current.find(row => row.runId === ids[0]).progress, { kind: 'first-publication' });
  assert.deepEqual(current.find(row => row.runId === ids[1]).progress, { kind: 'second-publication' });
});

test('a change after an earlier manifest final-fence read is caught by the second fixed-batch pass', t => {
  const f = fixture(t);
  createAcceptanceRun({ baselineUrl: 'https://baseline.test', targetUrl: 'https://target.test' }, { root: f.root });
  const ids = listOrder(f.root), firstPath = join(f.root, ids[0], 'manifest.json'), secondPath = join(f.root, ids[1], 'manifest.json');
  const first = JSON.parse(fs.readFileSync(firstPath)); let closes = 0;
  assert.throws(() => duringClose(firstPath, () => {
    if (++closes !== 3) return false;
    fs.writeFileSync(firstPath, encode({ ...first, progress: { kind: 'late-in-place-change' } }));
    writeAtomicFileSync(secondPath, encode({ ...JSON.parse(fs.readFileSync(secondPath)), progress: { kind: 'legitimate-publication' } })); return true;
  }, () => listAcceptanceRuns({ root: f.root })), integrity);
  assert.equal(closes, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(firstPath)).progress, { kind: 'late-in-place-change' });
});

test('a later legacy publication cannot hide an earlier managed progress change from the display scope', async t => {
  const f = await managedExecutionFixture({ paths: ['/healthy'] }); t.after(() => f.cleanup());
  const prepared = await f.prepareOnly(), ref = { operationId: prepared.envelope.operationId, dispatchSha256: prepared.record.sha256 };
  const options = { owner: f.owner, assertActive: () => true };
  createManagedAcceptanceRun(ref, options);
  const legacy = createAcceptanceRun({ baselineUrl: 'https://baseline.test', targetUrl: 'https://target.test' }, { root: f.root });
  const path = join(f.root, legacy.runId, 'manifest.json'), scope = createAcceptanceDisplayReadScope({ root: f.root });
  captureAcceptanceRunHead(prepared.envelope.runId, { scope });
  assert.throws(() => duringClose(path, count => {
    if (count) return false;
    updateManagedAcceptanceProgress(ref, { progress: { kind: 'acceptance-check', completed: 1, total: 1 } }, options);
    updateAcceptanceRun(legacy.runId, { progress: { kind: 'legitimate-publication' } }, { root: f.root }); return true;
  }, () => { captureAcceptanceRunHead(legacy.runId, { scope }); scope.assertCurrent(); }), integrity);
  assert.equal(f.requests.length, 0);
});

test('fixed scopes and source snapshots retain their original fail-closed byte fences', t => {
  const f = fixture(t);
  assert.throws(() => duringClose(f.path, count => {
    if (count) return false;
    updateAcceptanceRun(f.runId, { progress: { changed: true } }, { root: f.root }); return true;
  }, () => readAcceptanceRun(f.runId, { root: f.root })), integrity);
  assert.throws(() => duringClose(f.path, count => {
    if (count) return false;
    writeAtomicFileSync(f.path, encode({ ...f.manifest, progress: { changed: true } })); return true;
  }, () => {
    const scope = createAcceptanceReadScope({ root: f.root });
    const head = captureAcceptanceRunHead(f.runId, { scope }); scope.assertCurrent(); return head;
  }), integrity);
  finishAcceptanceRun(f.runId, { mode: 'mirror', status: 'completed', baselineUrl: f.manifest.baselineUrl,
    targetUrl: f.manifest.targetUrl, checks: [] }, { root: f.root });
  assert.equal(readAcceptanceSnapshot(f.runId, { root: f.root }).integrity.valid, true);
  const result = duringClose(f.path, count => {
    if (count) return false;
    writeAtomicFileSync(f.path, encode({ ...JSON.parse(fs.readFileSync(f.path)), triageAvailable: true })); return true;
  }, () => readAcceptanceSnapshot(f.runId, { root: f.root }));
  assert.equal(result.publications, 1); assert.equal(result.value.integrity.valid, false);
});

test('a display capability cannot be used as a fixed source scope or for any artifact capture', t => {
  const f = fixture(t), scope = createAcceptanceDisplayReadScope({ root: f.root });
  assert.deepEqual(captureAcceptanceRunHead(f.runId, { scope }).manifest, f.manifest);
  assert.equal(scope.assertCurrent(), true);
  assert.throws(() => assertAcceptanceReadScope(scope, f.root), { code: 'INVALID_INPUT' });
  assert.throws(() => captureAcceptanceRunFile(f.runId, 'manifest.json', { scope }), { code: 'INVALID_INPUT' });
  assert.throws(() => captureAcceptanceRunFile(f.runId, 'evidence.json', { scope }), { code: 'INVALID_INPUT' });
  assert.throws(() => captureManagedCompletedRun(f.runId, { scope }), { code: 'INVALID_INPUT' });
});

test('in-place changes to an already observed replacement are rejected without adopting its bytes', t => {
  const f = fixture(t);
  createAcceptanceRun({ baselineUrl: 'https://baseline.test', targetUrl: 'https://target.test' }, { root: f.root });
  const ids = listOrder(f.root), firstPath = join(f.root, ids[0], 'manifest.json'), secondPath = join(f.root, ids[1], 'manifest.json');
  const second = JSON.parse(fs.readFileSync(secondPath)); let firstCloses = 0;
  assert.throws(() => duringClose(firstPath, () => {
    if (++firstCloses !== 3) return false;
    fs.writeFileSync(secondPath, encode({ ...second, progress: { kind: 'in-place-after-publication' } })); return true;
  }, () => duringClose(secondPath, count => {
    if (count) return false;
    writeAtomicFileSync(secondPath, encode({ ...second, progress: { kind: 'legitimate-publication' } })); return true;
  }, () => listAcceptanceRuns({ root: f.root }))), integrity);
  assert.equal(firstCloses, 3);
});
