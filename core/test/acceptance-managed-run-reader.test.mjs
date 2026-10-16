import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { projectSpecBaselineCandidate } from '../src/acceptance/candidate-projection.mjs';
import { createManagedSpecDispatchStore } from '../src/acceptance/managed-dispatch-store.mjs';
import { managedSpecDispatchPlanFingerprint, managedSpecDispatchRequestFingerprint } from '../src/acceptance/managed-dispatch-schema.mjs';
import { createManagedSpecDispatchReadContext } from '../src/acceptance/managed-dispatch-reader.mjs';
import { ManagedAcceptanceRunError } from '../src/acceptance/managed-run-schema.mjs';
import { createManagedAcceptanceRun, finishManagedAcceptanceRun, settleManagedAcceptanceRun, updateManagedAcceptanceProgress } from '../src/acceptance/managed-run-store.mjs';
import { createAcceptanceReadScope, assertAcceptanceReadScope, captureAcceptanceRunHead, captureAcceptanceRunFile, captureManagedRunHead,
  captureManagedCompletedRun, ACCEPTANCE_READ_LIMITS } from '../src/acceptance/managed-run-reader.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = prefix => prefix + '-' + randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
const at = '2026-10-17T00:00:00.000Z';
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const put = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const rejected = (action, code = 'MANAGED_RUN_INTEGRITY_FAILED') => assert.throws(action, error => {
  assert.ok(error instanceof ManagedAcceptanceRunError);
  assert.equal(error.code, code); assert.equal(error.status, code === 'INVALID_INPUT' ? 400 : 409);
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});

// The dispatch and run are published by the real stores. Source projection is
// an unapproved legacy draft; managed raw/evidence come from the real runner
// with an explicit offline fetch stub. No service or remote request is needed.
async function fixture(t, { completed = false, outcome = 'passed', checks = 2 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-reader-'))), owner = acquireAcceptanceOwner({ root });
  t.after(() => { owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: uuid('ap'), name: 'reader fixture', createdAt: at };
  const sourceRelease = { id: uuid('ar'), projectId: project.id, label: 'source', targetUrl: 'http://127.0.0.1:43110/source', createdAt: at };
  const targetRelease = { id: uuid('ar'), projectId: project.id, label: 'target', targetUrl: 'http://127.0.0.1:43110/target', createdAt: at };
  const sourcePlan = normalizeSpecPlan({ name: 'reader draft', mode: 'spec', targetUrl: sourceRelease.targetUrl, timeoutMs: 1000,
    spec: { source: { id: 'REQ-READER', revision: '1', type: 'manual' }, approved: false,
      checks: Array.from({ length: checks }, (_, index) => ({ id: 'check-' + index, title: 'check-' + index, method: 'GET', path: '/check-' + index,
        severity: 'high', expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } });
  const source = createAcceptanceRun(sourcePlan, { root }), sourceDir = join(root, source.runId);
  const sourceRaw = await runSpecAcceptance(sourcePlan, { runId: source.runId, outputDir: sourceDir });
  assert.equal(sourceRaw.safety.requests, 0); finishAcceptanceRun(source.runId, sourceRaw, { root });
  const material = readSpecCandidateSource(source.runId, { root, owner });
  const { projection } = projectSpecBaselineCandidate(material, { projectId: project.id, releaseId: sourceRelease.id, sourceSide: 'source' });
  const candidate = { id: uuid('ab'), ...projection, createdAt: at };
  const approval = { id: uuid('aa'), projectId: project.id, candidateId: candidate.id, contentDigest: candidate.contentDigest,
    reason: 'approved', approvedAt: at, actor: { kind: 'local-operator' } };
  const selection = { id: uuid('as'), projectId: project.id, mode: 'spec', approvalId: approval.id, previousSelectionId: null,
    reason: 'selected', selectedAt: at, actor: { kind: 'local-operator' } };
  const catalog = { generationId: uuid('ag'), revision: 8, headSha256: 'a'.repeat(64) };
  const request = { projectId: project.id, expectedGenerationId: catalog.generationId, expectedRevision: catalog.revision,
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id };
  const plan = normalizeSpecPlan({ ...sourcePlan, name: 'managed reader', targetUrl: targetRelease.targetUrl,
    spec: { ...sourcePlan.spec, approved: true } });
  const envelope = { schemaVersion: 1, operationId: uuid('ao'), dispatchId: uuid('ad'), runId: uuid('ac'), taskId: uuid('a'), acceptedAt: at,
    request, requestFingerprint: managedSpecDispatchRequestFingerprint(request), catalog, project, selection, approval, candidate,
    sourceRelease, targetRelease, sourceSpecApproved: false, plan, planFingerprint: managedSpecDispatchPlanFingerprint(plan), executor: 'engine-owner-spec-v1' };
  const dispatches = createManagedSpecDispatchStore({ root, owner }), record = dispatches.publish(envelope);
  const ref = { operationId: envelope.operationId, dispatchSha256: record.sha256 }, options = { owner, assertActive: () => true };
  const dir = join(root, envelope.runId), manifestPath = join(dir, 'manifest.json'), reportPath = join(dir, 'report.json');
  const raw = async (outcome = 'passed') => {
    const fetch = globalThis.fetch; let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      if (outcome === 'blocked') throw Error('offline fixture');
      return new Response(outcome === 'failed' ? '{"code":9}' : '{"code":0}', { headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: dir });
      assert.equal(requests, checks); return result;
    } finally { globalThis.fetch = fetch; }
  };
  const complete = async (result = outcome) => {
    createManagedAcceptanceRun(ref, options);
    return finishManagedAcceptanceRun(ref, await raw(result), options);
  };
  const f = { root, owner, envelope, record, ref, options, dir, manifestPath, reportPath, sourceDir, sourceRunId: source.runId,
    sidecar: join(root, 'managed-spec-dispatches', 'v1', envelope.operationId + '.json'), dispatches, raw, complete };
  if (completed) await complete();
  return f;
}
function tree(root) {
  const walk = path => fs.readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? walk(child) : [[child.slice(root.length), sha(fs.readFileSync(child))]];
  });
  return walk(root).sort(([a], [b]) => a.localeCompare(b));
}
const scopeOf = f => createAcceptanceReadScope({ root: f.root });
const read = f => { const scope = scopeOf(f), result = captureManagedCompletedRun(f.envelope.runId, { scope }); scope.assertCurrent(); return result; };

function freezeMetadata(path) {
  const lstat = nativeFs.lstatSync, fstat = nativeFs.fstatSync, frozen = lstat(path, { bigint: true });
  nativeFs.lstatSync = (current, options) => current === path && options?.bigint ? frozen : lstat(current, options);
  nativeFs.fstatSync = (fd, options) => {
    const observed = fstat(fd, options);
    return options?.bigint && observed.dev === frozen.dev && observed.ino === frozen.ino ? frozen : observed;
  };
  syncBuiltinESMExports();
  return () => { nativeFs.lstatSync = lstat; nativeFs.fstatSync = fstat; syncBuiltinESMExports(); };
}

test('completed passed, BUG failed and environment blocked remain readable without owner, writes or requests', async t => {
  for (const outcome of ['passed', 'failed', 'blocked']) await t.test(outcome, async t => {
    const f = await fixture(t, { completed: true, outcome }); f.owner.release(); const before = tree(f.root);
    const fetch = globalThis.fetch; let requests = 0;
    globalThis.fetch = () => { requests++; throw Error('reader requested target'); };
    let captured;
    try { captured = read(f); } finally { globalThis.fetch = fetch; }
    assert.equal(captured.snapshot.integrity.valid, true); assert.equal(captured.snapshot.integrity.evidenceVerified, true);
    assert.equal(captured.snapshot.report.gate, outcome); assert.equal(captured.snapshot.manifest.status, 'completed');
    assert.deepEqual(Object.keys(captured.snapshot), ['manifest', 'report', 'integrity']);
    assert.deepEqual(Object.keys(captured.snapshot.integrity), ['valid', 'evidenceVerified', 'errors', 'verifiedFiles', 'verifiedBytes', 'reportSha256']);
    assert.equal(captured.binding.reportSha256, sha(fs.readFileSync(f.reportPath)));
    assert.equal(captured.files.size, captured.snapshot.integrity.verifiedFiles + 2);
    for (const [name, bytes] of captured.files) { assert.ok(Buffer.isBuffer(bytes)); assert.deepEqual(bytes, fs.readFileSync(join(f.dir, name))); }
    assert.equal(requests, 0); assert.deepEqual(tree(f.root), before);
  });
});

test('head shows running progress while prepared and missing runs remain absent without creating anything', async t => {
  const f = await fixture(t), before = tree(f.root), scope = scopeOf(f);
  assert.equal(captureManagedRunHead(f.envelope.runId, { scope }), null);
  assert.equal(captureManagedCompletedRun(uuid('ac'), { scope }), null); scope.assertCurrent();
  assert.deepEqual(tree(f.root), before); assert.equal(fs.existsSync(f.dir), false);
  createManagedAcceptanceRun(f.ref, f.options);
  updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-check', completed: 1, total: 2, route: '/check-0' } }, f.options);
  const current = scopeOf(f), head = captureManagedRunHead(f.envelope.runId, { scope: current }); current.assertCurrent();
  assert.equal(head.kind, 'managed'); assert.equal(head.manifest.status, 'running');
  assert.equal(head.manifest.progress.completed, 1); assert.equal(head.binding.reportSha256, null);
  rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope: scopeOf(f) }));
  rejected(() => scope.assertCurrent());
});

test('partial report hardlinks retained by a real failed finish do not hide running or settled heads', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options); const raw = await f.raw();
  assert.throws(() => finishManagedAcceptanceRun(f.ref, raw, { ...f.options, assertActive: () => !fs.existsSync(f.reportPath) }));
  assert.equal(fs.statSync(f.reportPath).nlink, 2); const bytes = fs.readFileSync(f.reportPath);
  let scope = scopeOf(f), head = captureManagedRunHead(f.envelope.runId, { scope }); scope.assertCurrent();
  assert.equal(head.manifest.status, 'running'); assert.deepEqual(head.files.get('report.json'), bytes);
  rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope: scopeOf(f) }));
  settleManagedAcceptanceRun(f.ref, { status: 'interrupted', reasonCode: 'ENGINE_RESTARTED', error: 'interrupted' }, { owner: f.owner });
  scope = scopeOf(f); head = captureManagedRunHead(f.envelope.runId, { scope }); scope.assertCurrent();
  assert.equal(head.manifest.status, 'interrupted'); assert.equal(head.binding.reportSha256, null);
  assert.deepEqual(fs.readFileSync(f.reportPath), bytes);
  rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope: scopeOf(f) }));
});

test('a real interrupted create after mkdir is diagnosed as partial instead of an unstarted null', async t => {
  const f = await fixture(t);
  assert.throws(() => createManagedAcceptanceRun(f.ref, { ...f.options, assertActive: () => !fs.existsSync(f.dir) }));
  assert.equal(fs.existsSync(f.dir), true); assert.deepEqual(fs.readdirSync(f.dir), []);
  const before = tree(f.root), scope = scopeOf(f);
  rejected(() => captureManagedRunHead(f.envelope.runId, { scope }));
  rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope }));
  assert.equal(scope.assertCurrent(), true); assert.deepEqual(tree(f.root), before);
  assert.equal(fs.existsSync(f.manifestPath), false);
});

test('legacy head capture shares bounded files, detects both marker locations, and stable bad rows do not poison a batch', async t => {
  const f = await fixture(t), manifestPath = join(f.sourceDir, 'manifest.json'), reportPath = join(f.sourceDir, 'report.json');
  const manifest = fs.readFileSync(manifestPath), report = fs.readFileSync(reportPath);
  const scope = scopeOf(f), legacy = captureAcceptanceRunHead(f.sourceRunId, { scope });
  assert.equal(legacy.kind, 'legacy'); assert.equal(legacy.record, null); assert.equal(legacy.binding, null);
  assert.deepEqual(legacy.files.get('manifest.json'), manifest); assert.deepEqual(legacy.files.get('report.json'), report);
  scope.assertCurrent();
  for (const location of [manifestPath, reportPath]) {
    const value = json(location); value.managed = null; put(location, value);
    const damagedScope = scopeOf(f);
    rejected(() => captureAcceptanceRunHead(f.sourceRunId, { scope: damagedScope }));
    assert.equal(damagedScope.classify(uuid('ac')).kind, 'legacy'); assert.equal(damagedScope.assertCurrent(), true);
    fs.writeFileSync(manifestPath, manifest); fs.writeFileSync(reportPath, report);
  }
});

test('reserved IDs cannot become legacy by stripping both managed markers', async t => {
  const f = await fixture(t, { completed: true });
  for (const path of [f.manifestPath, f.reportPath]) { const value = json(path); delete value.managed; put(path, value); }
  const before = tree(f.root), scope = scopeOf(f);
  assert.equal(scope.classify(f.envelope.runId).kind, 'managed');
  rejected(() => captureManagedRunHead(f.envelope.runId, { scope }));
  rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope }));
  assert.deepEqual(tree(f.root), before);
});

test('scope and dispatch brands, roots and caller options reject without invoking accessors or proxy traps', async t => {
  const f = await fixture(t), scope = scopeOf(f); let hooks = 0;
  const fake = { get assertCurrent() { hooks++; throw Error('SECRET'); } };
  for (const managedRead of [null, fake, new Proxy({}, { get() { hooks++; throw Error('SECRET'); } })]) rejected(() => createAcceptanceReadScope({ root: f.root, managedRead }));
  for (const candidate of [fake, { ...scope }, new Proxy(scope, { get() { hooks++; throw Error('SECRET'); } })]) {
    rejected(() => captureManagedRunHead(f.envelope.runId, { scope: candidate }), 'INVALID_INPUT');
    rejected(() => assertAcceptanceReadScope(candidate, f.root), 'INVALID_INPUT');
  }
  const other = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-reader-other-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  rejected(() => createAcceptanceReadScope({ root: f.root, managedRead: createManagedSpecDispatchReadContext({ root: other }) }));
  rejected(() => assertAcceptanceReadScope(scope, other), 'INVALID_INPUT');
  for (const options of [{ get root() { hooks++; return f.root; } }, { root: f.root, owner: f.owner },
    new Proxy({}, { ownKeys() { hooks++; return []; } })]) rejected(() => createAcceptanceReadScope(options), 'INVALID_INPUT');
  for (const limits of [null, { jsonBytes: ACCEPTANCE_READ_LIMITS.jsonBytes + 1 }, { runs: -1 }, { unknown: 1 },
    { get checks() { hooks++; return 1; } }, new Proxy({}, { ownKeys() { hooks++; return []; } })]) {
    rejected(() => createAcceptanceReadScope({ root: f.root, limits }), 'INVALID_INPUT');
  }
  assert.equal(hooks, 0); assert.equal(Object.isFrozen(scope), true);
  const relativeScope = createAcceptanceReadScope({ root: relative(process.cwd(), f.root) });
  assert.equal(assertAcceptanceReadScope(relativeScope, f.root), true);
});

test('returned records, buffers, maps and JSON cannot poison the scope private capture', async t => {
  const f = await fixture(t, { completed: true }), scope = scopeOf(f);
  const first = captureManagedCompletedRun(f.envelope.runId, { scope });
  first.files.get('manifest.json').fill(0); first.files.clear(); first.record.bytes.fill(0); first.record.envelope.runId = uuid('ac');
  first.snapshot.manifest.name = 'poison'; first.snapshot.report.checks[0].status = 'failed';
  const classified = scope.classify(f.envelope.runId); classified.record.bytes.fill(0); classified.record.envelope.plan.name = 'poison';
  const second = captureManagedCompletedRun(f.envelope.runId, { scope }); scope.assertCurrent();
  assert.equal(second.snapshot.manifest.name, f.envelope.plan.name); assert.equal(second.snapshot.report.checks[0].status, 'passed');
  assert.equal(sha(second.record.bytes), f.record.sha256); assert.deepEqual(second.files.get('manifest.json'), fs.readFileSync(f.manifestPath));
});

test('narrow file capture fixes legacy evidence in the batch and rejects arbitrary paths, hooks and loosened budgets', async t => {
  const f = await fixture(t), report = json(join(f.sourceDir, 'report.json')), name = report.evidenceManifest[0].file;
  const scope = scopeOf(f), path = join(f.sourceDir, name), bytes = fs.readFileSync(path);
  const first = captureAcceptanceRunFile(f.sourceRunId, name, { scope, maxBytes: bytes.length });
  assert.deepEqual(first, bytes); first.fill(0);
  assert.deepEqual(captureAcceptanceRunFile(f.sourceRunId, name, { scope }), bytes);
  assert.equal(captureAcceptanceRunFile(f.sourceRunId, 'absent.png', { scope }), null);
  let hooks = 0;
  for (const invalidName of ['../report.json', 'report.md', 'triage.json', 'plan.json', 'evidence-manifest.json', 'payload.json.aaa.tmp', 'x.tmp.json', 'Manifest.json']) {
    rejected(() => captureAcceptanceRunFile(f.sourceRunId, invalidName, { scope }), 'INVALID_INPUT');
  }
  for (const options of [{ scope, get maxBytes() { hooks++; return 1; } }, { scope, owner: f.owner },
    { scope, maxBytes: -1 }, { scope, maxBytes: ACCEPTANCE_READ_LIMITS.evidenceFileBytes + 1 },
    new Proxy({}, { ownKeys() { hooks++; return []; } })]) {
    rejected(() => captureAcceptanceRunFile(f.sourceRunId, name, options), 'INVALID_INPUT');
  }
  assert.equal(hooks, 0); assert.equal(scope.assertCurrent(), true);
  const changed = Buffer.from(bytes); changed[0] ^= 1; const restore = freezeMetadata(path);
  try { fs.writeFileSync(path, changed); rejected(() => scope.assertCurrent()); }
  finally { restore(); }
});

test('a batch final fence rechecks earlier managed evidence and legacy heads and stays invalid after restoration', async t => {
  for (const kind of ['evidence', 'legacy-head']) await t.test(kind, async t => {
    const f = await fixture(t, { completed: true }), scope = scopeOf(f);
    const completed = captureManagedCompletedRun(f.envelope.runId, { scope });
    captureAcceptanceRunHead(f.sourceRunId, { scope });
    const path = kind === 'evidence' ? join(f.dir, completed.snapshot.report.evidenceManifest[0].file) : join(f.sourceDir, 'manifest.json');
    const bytes = fs.readFileSync(path), changed = Buffer.from(bytes); changed[0] ^= 1;
    const restore = freezeMetadata(path);
    try {
      fs.writeFileSync(path, changed); rejected(() => scope.assertCurrent());
      fs.writeFileSync(path, bytes); rejected(() => scope.assertCurrent());
    } finally { restore(); }
  });
});

test('stale namespace and same-length sidecar mutation block and never refresh a scope', async t => {
  const f = await fixture(t), context = createManagedSpecDispatchReadContext({ root: f.root }), scope = createAcceptanceReadScope({ root: f.root, managedRead: context });
  const bytes = fs.readFileSync(f.sidecar), changed = Buffer.from(bytes); changed[0] ^= 1;
  const restore = freezeMetadata(f.sidecar);
  try {
    fs.writeFileSync(f.sidecar, changed);
    rejected(() => scope.assertCurrent()); rejected(() => createAcceptanceReadScope({ root: f.root, managedRead: context }));
    fs.writeFileSync(f.sidecar, bytes); rejected(() => scope.assertCurrent());
  } finally { restore(); }
});

test('manifest, report and evidence are two-read fenced even when all visible file stats stay unchanged', async t => {
  for (const kind of ['manifest', 'report', 'evidence']) await t.test(kind, async t => {
    const f = await fixture(t, { completed: true }), report = json(f.reportPath);
    const path = kind === 'manifest' ? f.manifestPath : kind === 'report' ? f.reportPath : join(f.dir, report.evidenceManifest[0].file);
    const bytes = fs.readFileSync(path), changedBytes = Buffer.from(bytes); changedBytes[0] ^= 1;
    const restore = freezeMetadata(path), open = nativeFs.openSync, close = nativeFs.closeSync, readSync = nativeFs.readSync;
    const descriptors = new Set(); let changed = false;
    nativeFs.openSync = (...args) => { const fd = open(...args); if (args[0] === path) descriptors.add(fd); return fd; };
    nativeFs.closeSync = fd => { descriptors.delete(fd); return close(fd); };
    nativeFs.readSync = (fd, buffer, offset, length, position) => {
      const count = readSync(fd, buffer, offset, length, position);
      if (descriptors.has(fd) && count === 0 && !changed) { changed = true; fs.writeFileSync(path, changedBytes); }
      return count;
    };
    syncBuiltinESMExports();
    try { rejected(() => read(f)); assert.equal(changed, true); }
    finally { nativeFs.openSync = open; nativeFs.closeSync = close; nativeFs.readSync = readSync; restore(); syncBuiltinESMExports(); }
  });
});

test('bounded descriptor reads reject growth, premature EOF and strict invalid UTF-8 without unbounded readFileSync', async t => {
  for (const kind of ['growth', 'short-read', 'utf8', 'bom']) await t.test(kind, async t => {
    const f = await fixture(t, { completed: true });
    if (kind === 'utf8' || kind === 'bom') {
      const bytes = fs.readFileSync(f.manifestPath);
      fs.writeFileSync(f.manifestPath, kind === 'utf8' ? Buffer.concat([Buffer.from([0xff]), bytes]) : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
      rejected(() => captureManagedRunHead(f.envelope.runId, { scope: scopeOf(f) })); return;
    }
    const open = nativeFs.openSync, close = nativeFs.closeSync, readSync = nativeFs.readSync, restore = freezeMetadata(f.manifestPath);
    const descriptors = new Set(); let changed = false;
    nativeFs.openSync = (...args) => { const fd = open(...args); if (args[0] === f.manifestPath) descriptors.add(fd); return fd; };
    nativeFs.closeSync = fd => { descriptors.delete(fd); return close(fd); };
    nativeFs.readSync = (fd, buffer, offset, length, position) => {
      if (descriptors.has(fd) && !changed && position === 0) {
        changed = true;
        if (kind === 'short-read') return 0;
        fs.appendFileSync(f.manifestPath, 'G');
      }
      return readSync(fd, buffer, offset, length, position);
    };
    syncBuiltinESMExports();
    try { rejected(() => captureManagedRunHead(f.envelope.runId, { scope: scopeOf(f) })); assert.equal(changed, true); }
    finally { nativeFs.openSync = open; nativeFs.closeSync = close; nativeFs.readSync = readSync; restore(); syncBuiltinESMExports(); }
  });
});

test('missing evidence, digest mismatch, reserved names and index/reference closure reject without repairing originals', async t => {
  const f = await fixture(t, { completed: true }), report = json(f.reportPath), reportBytes = fs.readFileSync(f.reportPath), manifestBytes = fs.readFileSync(f.manifestPath);
  const evidence = join(f.dir, report.evidenceManifest[0].file), evidenceBytes = fs.readFileSync(evidence);
  for (const mutation of ['missing', 'bytes', 'index-extra', 'reserved', 'duplicate']) {
    if (mutation === 'missing') fs.renameSync(evidence, evidence + '.kept');
    else if (mutation === 'bytes') fs.writeFileSync(evidence, Buffer.from('{}'));
    else {
      const changed = copy(report);
      if (mutation === 'index-extra') changed.evidenceManifest.push({ file: 'unreferenced.json', bytes: 2, sha256: sha('{}') });
      if (mutation === 'reserved') { changed.evidenceManifest[0].file = 'manifest.json'; changed.checks[0].evidence.contract = 'manifest.json'; }
      if (mutation === 'duplicate') changed.evidenceManifest.push(copy(changed.evidenceManifest[0]));
      put(f.reportPath, changed); const manifest = json(f.manifestPath); manifest.reportSha256 = sha(fs.readFileSync(f.reportPath)); put(f.manifestPath, manifest);
    }
    const before = tree(f.root); rejected(() => read(f)); assert.deepEqual(tree(f.root), before);
    if (mutation === 'missing') fs.renameSync(evidence + '.kept', evidence);
    fs.writeFileSync(evidence, evidenceBytes); fs.writeFileSync(f.reportPath, reportBytes); fs.writeFileSync(f.manifestPath, manifestBytes);
  }
});

test('read budgets tighten only and cap cumulative batch files/bytes as well as each snapshot', async t => {
  const f = await fixture(t, { completed: true });
  for (const limits of [{ runs: 0 }, { capturedFiles: 0 }, { capturedBytes: 0 }, { jsonBytes: 1 }, { checks: 0 },
    { evidenceFiles: 0 }, { evidenceFileBytes: 1 }, { evidenceBytes: 1 }]) {
    rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope: createAcceptanceReadScope({ root: f.root, limits }) }));
  }
  const oneHead = fs.statSync(f.manifestPath).size + fs.statSync(f.reportPath).size;
  const scope = createAcceptanceReadScope({ root: f.root, limits: { capturedBytes: oneHead } });
  captureManagedRunHead(f.envelope.runId, { scope });
  rejected(() => captureAcceptanceRunHead(f.sourceRunId, { scope }));
});

test('links, nonregular evidence and replaced root/run identities fail closed', async t => {
  for (const kind of ['head-link', 'evidence-link', 'hardlink', 'run-replaced', 'root-replaced']) await t.test(kind, async t => {
    const f = await fixture(t, { completed: true }), report = json(f.reportPath), evidence = join(f.dir, report.evidenceManifest[0].file);
    const scope = scopeOf(f);
    if (kind === 'head-link' || kind === 'evidence-link') {
      const path = kind === 'head-link' ? f.manifestPath : evidence;
      fs.renameSync(path, path + '.kept'); fs.symlinkSync(path + '.kept', path, 'file');
      rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope }));
    } else if (kind === 'hardlink') {
      fs.linkSync(evidence, evidence + '.linked'); rejected(() => captureManagedCompletedRun(f.envelope.runId, { scope }));
    } else if (kind === 'run-replaced') {
      captureManagedRunHead(f.envelope.runId, { scope });
      fs.renameSync(f.dir, f.dir + '.kept'); fs.mkdirSync(f.dir); rejected(() => scope.assertCurrent());
    } else {
      fs.renameSync(f.root, f.root + '.kept'); fs.mkdirSync(f.root);
      t.after(() => fs.rmSync(f.root + '.kept', { recursive: true, force: true }));
      rejected(() => scope.assertCurrent());
    }
  });
});

test('FIFO evidence is rejected before open on Linux', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { completed: true }), report = json(f.reportPath), evidence = join(f.dir, report.evidenceManifest[0].file);
  fs.renameSync(evidence, evidence + '.kept');
  const result = spawnSync('mkfifo', [evidence], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  rejected(() => read(f));
});

test('multi-run and multi-evidence batches use fixed namespace boundary counts', async t => {
  const f = await fixture(t, { completed: true, checks: 6 });
  for (let index = 0; index < 6; index++) {
    const e = { ...copy(f.envelope), operationId: uuid('ao'), dispatchId: uuid('ad'), runId: uuid('ac'), taskId: uuid('a') };
    const record = f.dispatches.publish(e);
    createManagedAcceptanceRun({ operationId: e.operationId, dispatchSha256: record.sha256 }, f.options);
  }
  const open = nativeFs.opendirSync, namespace = join(f.root, 'managed-spec-dispatches', 'v1'); let enumerations = 0;
  nativeFs.opendirSync = (...args) => { if (args[0] === namespace) enumerations++; return open(...args); }; syncBuiltinESMExports();
  try {
    const scope = scopeOf(f), construction = enumerations;
    captureManagedCompletedRun(f.envelope.runId, { scope });
    for (const record of createManagedSpecDispatchReadContext({ root: f.root }).captureRecords()) {
      captureManagedRunHead(record.envelope.runId, { scope });
    }
    // Constructing the independent test inventory above has a fixed cost too;
    // no reader capture itself is permitted to enumerate the namespace.
    const beforeFinal = enumerations;
    for (let index = 0; index < 5; index++) captureManagedRunHead(f.envelope.runId, { scope });
    assert.equal(enumerations, beforeFinal); assert.ok(construction > 0);
    scope.assertCurrent(); assert.equal(enumerations - beforeFinal, 2);
  } finally { nativeFs.opendirSync = open; syncBuiltinESMExports(); }
});

test('legacy file adapter reads evidence a fixed number of times rather than re-reading the growing prefix', async t => {
  const f = await fixture(t, { completed: true, checks: 6 }), report = json(f.reportPath);
  const names = report.evidenceManifest.map(entry => entry.file), paths = new Set(names.map(name => join(f.dir, name)));
  const open = nativeFs.openSync; let evidenceOpens = 0;
  nativeFs.openSync = (...args) => { if (paths.has(args[0])) evidenceOpens++; return open(...args); }; syncBuiltinESMExports();
  try {
    const scope = scopeOf(f);
    for (const name of names) assert.ok(captureAcceptanceRunFile(f.envelope.runId, name, { scope }));
    assert.equal(evidenceOpens, names.length * 2);
    scope.assertCurrent(); assert.equal(evidenceOpens, names.length * 4);
  } finally { nativeFs.openSync = open; syncBuiltinESMExports(); }
});
