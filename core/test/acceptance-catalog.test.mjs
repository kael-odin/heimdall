import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';

const TARGET = 'http://127.0.0.1:3000/preview?version=1';
const at = '2026-10-16T00:00:00.000Z';
const uid = prefix => prefix + '-' + randomUUID();
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = { root, assertOwned() {} };
  return { root, owner, store: createAcceptanceCatalogStore({ root, owner, ...options }) };
}
async function projectAndRelease(f, targetUrl = TARGET) {
  await f.store.initialize();
  const { project } = await f.store.createProject({ ...cas(f.store), name: '验收演示' });
  const { release } = await f.store.createRelease(project.id, { ...cas(f.store), label: 'v1', targetUrl });
  return { project, release };
}
function run(root, patch = {}, { report } = {}) {
  const runId = patch.runId ?? uid('ac'), dir = join(root, runId);
  mkdirSync(dir);
  const manifest = { schemaVersion: 1, runId, name: '旧 API 运行', mode: 'spec', targetUrl: TARGET,
    status: 'completed', gate: 'failed', createdAt: at, plan: { mode: 'spec', targetUrl: TARGET }, ...patch };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (report !== undefined) writeFileSync(join(dir, 'report.json'), report);
  return { runId, dir, manifest };
}
function bytes(root) { return readFileSync(join(root, 'catalog.json')); }
function evidenceDigest(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map(file => [file, createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')]));
}
async function unchanged(f, operation, code, status) {
  const original = bytes(f.root);
  await assert.rejects(operation, { code, status });
  assert.deepEqual(bytes(f.root), original);
}

test('catalog initializes once, persists immutable entities and reloads their event history', async t => {
  const f = fixture(t);
  const empty = await f.store.initialize();
  assert.equal(empty.schemaVersion, 1); assert.equal(empty.revision, 0); assert.match(empty.generationId, /^ag-/);
  assert.deepEqual(Object.keys(empty).sort(), ['events', 'generationId', 'projects', 'releases', 'revision', 'runBindings', 'schemaVersion']);
  assert.deepEqual(await f.store.initialize(), empty);
  const first = await f.store.createProject({ ...cas(f.store), name: '  中文项目  ' });
  assert.equal(first.project.name, '中文项目'); assert.equal(first.revision, 1); assert.equal(first.event.kind, 'project-created');
  const second = await f.store.createRelease(first.project.id, { ...cas(f.store), label: '  v1  ', targetUrl: 'HTTP://EXAMPLE.TEST:80/app?x=1', buildRef: ' commit-1 ' });
  assert.equal(second.release.targetUrl, 'http://example.test/app?x=1'); assert.equal(second.release.buildRef, 'commit-1');
  assert.equal(second.event.entityId, second.release.id); assert.equal(second.revision, 2);
  const reloaded = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  assert.deepEqual(await reloaded.initialize(), f.store.read());
  first.project.name = 'changed by caller'; second.release.targetUrl = 'https://evil.test/';
  const returned = f.store.read(); returned.projects[first.project.id].name = 'changed local copy';
  assert.equal(reloaded.read().projects[first.project.id].name, '中文项目');
  assert.equal(reloaded.read().releases[second.release.id].targetUrl, 'http://example.test/app?x=1');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'catalog.previous.json'), 'utf8')), { ...empty, revision: 1,
    projects: reloaded.read().projects, events: [reloaded.read().events[0]] });
});

test('strict mutation inputs reject unsupported approval, actor and mutable-entity fields', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  for (const extra of [{ actor: { kind: 'admin' } }, { actorLabel: 'me' }, { current: {} }, { candidates: [] }, { id: uid('ap') }]) {
    await unchanged(f, f.store.createProject({ ...cas(f.store), name: 'x', ...extra }), 'INVALID_INPUT', 400);
  }
  for (const body of [null, [], {}, { ...cas(f.store), name: '' }, { ...cas(f.store), name: 'x'.repeat(121) },
    { ...cas(f.store), name: 'x', expectedRevision: 1.5 }, { ...cas(f.store), name: 'x', expectedGenerationId: '../catalog' }]) {
    await unchanged(f, f.store.createProject(body), 'INVALID_INPUT', 400);
  }
  await unchanged(f, f.store.createRelease(project.id, { ...cas(f.store), label: 'v2', targetUrl: TARGET, status: 'passed' }), 'INVALID_INPUT', 400);
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: uid('ac'), releaseId: release.id, source: {} }), 'INVALID_INPUT', 400);
  let called = 0;
  const getter = { ...cas(f.store) }; Object.defineProperty(getter, 'name', { enumerable: true, get() { called++; return 'unsafe'; } });
  await unchanged(f, f.store.createProject(getter), 'INVALID_INPUT', 400); assert.equal(called, 0);
  assert.equal(f.store.updateRelease, undefined); assert.equal(f.store.approve, undefined);
});

test('invalid URLs and identifiers cannot create releases or access outside runs', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  for (const targetUrl of ['file:///tmp/x', 'https://user:secret@example.test/', 'https://example.test/#x', '//example.test', 42]) {
    await unchanged(f, f.store.createRelease(project.id, { ...cas(f.store), label: 'v2', targetUrl }), 'INVALID_INPUT', 400);
  }
  for (const invalidId of ['../escape', uid('ar'), '__proto__', uid('ac') + '/report.json', uid('ac').toUpperCase()]) {
    await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: invalidId, releaseId: release.id }), 'INVALID_INPUT', 400);
  }
  await unchanged(f, f.store.createRelease('../escape', { ...cas(f.store), label: 'v2', targetUrl: TARGET }), 'INVALID_INPUT', 400);
});

test('terminal legacy runs can be explicitly bound without changing any source bytes', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  for (const status of ['completed', 'failed', 'interrupted']) {
    const source = run(f.root, { status, gate: status === 'completed' ? 'failed' : 'blocked' });
    writeFileSync(join(source.dir, 'old-evidence.json'), '{"original":true}\n');
    const original = evidenceDigest(source.dir);
    const result = await f.store.bindRun(project.id, { ...cas(f.store), runId: source.runId, releaseId: release.id });
    assert.equal(result.binding.runId, source.runId); assert.deepEqual(result.binding.actor, { kind: 'local-operator' });
    assert.equal(result.source.status, status); assert.equal(result.diagnostics.scope, 'manifest-only');
    assert.equal(result.diagnostics.manifestValid, true); assert.equal(result.diagnostics.evidenceVerified, false);
    assert.equal(result.diagnostics.reportPresent, false); assert.equal(result.diagnostics.reportDigestRecorded, false);
    assert.ok(result.diagnostics.issues.some(issue => issue.code === 'REPORT_DIGEST_UNAVAILABLE'));
    assert.deepEqual(evidenceDigest(source.dir), original);
    assert.deepEqual(f.store.read().runBindings[source.runId], result.binding);
    assert.equal(Object.hasOwn(result.binding, 'source'), false);
  }
  assert.equal(f.store.read().events.filter(event => event.kind === 'run-bound').length, 3);
});

test('a corrupt report does not become proof and does not block valid metadata association', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  const source = run(f.root, { reportSha256: 'a'.repeat(64) }, { report: 'not a report, contains raw-secret-123' });
  const original = evidenceDigest(source.dir);
  const result = await f.store.bindRun(project.id, { ...cas(f.store), runId: source.runId, releaseId: release.id });
  assert.equal(result.diagnostics.reportPresent, true); assert.equal(result.diagnostics.reportDigestRecorded, true);
  assert.equal(result.diagnostics.evidenceVerified, false); assert.match(result.diagnostics.issues[0].message, /未验证/);
  assert.equal(JSON.stringify(result).includes('raw-secret'), false);
  assert.equal(JSON.stringify(f.store.read()).includes('raw-secret'), false);
  assert.deepEqual(evidenceDigest(source.dir), original);
});

test('run lookup uses the full ID even when over 100 newer manifests exist', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  const older = run(f.root);
  for (let i = 0; i < 105; i++) run(f.root, { createdAt: new Date(Date.parse(at) + i + 1).toISOString() });
  const result = await f.store.bindRun(project.id, { ...cas(f.store), runId: older.runId, releaseId: release.id });
  assert.equal(result.binding.runId, older.runId);
});

test('binding requires full normalized URL equality, including entry path and query', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f, 'http://example.test/app?version=1');
  const normalized = run(f.root, { targetUrl: 'HTTP://EXAMPLE.TEST:80/app?version=1', plan: { mode: 'spec', targetUrl: 'http://example.test/app?version=1' } });
  const result = await f.store.bindRun(project.id, { ...cas(f.store), runId: normalized.runId, releaseId: release.id });
  assert.equal(result.source.targetUrl, 'http://example.test/app?version=1');
  for (const targetUrl of ['http://example.test/other?version=1', 'http://example.test/app?version=2', 'http://example.test/app', 'https://example.test/app?version=1']) {
    const source = run(f.root, { targetUrl, plan: { mode: 'spec', targetUrl } });
    await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: source.runId, releaseId: release.id }), 'PROJECT_MISMATCH', 409);
  }
});

test('run bindings are unique and cannot cross project/release boundaries', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  const { project: other } = await f.store.createProject({ ...cas(f.store), name: 'Other' });
  const source = run(f.root);
  await unchanged(f, f.store.bindRun(other.id, { ...cas(f.store), runId: source.runId, releaseId: release.id }), 'PROJECT_MISMATCH', 409);
  await f.store.bindRun(project.id, { ...cas(f.store), runId: source.runId, releaseId: release.id });
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: source.runId, releaseId: release.id }), 'CONTEXT_ALREADY_BOUND', 409);
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: uid('ac'), releaseId: release.id }), 'NOT_FOUND', 404);
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: uid('ac'), releaseId: uid('ar') }), 'NOT_FOUND', 404);
  await unchanged(f, f.store.createRelease(uid('ap'), { ...cas(f.store), label: 'x', targetUrl: TARGET }), 'NOT_FOUND', 404);
});

test('running, malformed and internally inconsistent manifests are rejected without source mutation', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  const running = run(f.root, { status: 'running', gate: 'blocked' });
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: running.runId, releaseId: release.id }), 'SOURCE_NOT_ELIGIBLE', 409);
  const patches = [{ runId: 'invalid' }, { schemaVersion: 2 }, { mode: 'unknown' }, { status: 'other' }, { name: '' }, { createdAt: 'yesterday' },
    { status: 'failed', gate: 'passed' }, { targetUrl: 'file:///tmp/x' }, { plan: { mode: 'mirror', targetUrl: TARGET } },
    { plan: { mode: 'spec', targetUrl: 'http://127.0.0.1:3000/other' } }];
  for (const patch of patches) {
    const source = run(f.root); writeFileSync(join(source.dir, 'manifest.json'), JSON.stringify({ ...source.manifest, ...patch }));
    const original = evidenceDigest(source.dir);
    await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: source.runId, releaseId: release.id }), 'SOURCE_INTEGRITY_FAILED', 409);
    assert.deepEqual(evidenceDigest(source.dir), original);
  }
  const broken = run(f.root); writeFileSync(join(broken.dir, 'manifest.json'), '{invalid json');
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: broken.runId, releaseId: release.id }), 'SOURCE_INTEGRITY_FAILED', 409);
});

test('manifest size budget and escaping run junctions fail closed', async t => {
  const f = fixture(t, { limits: { manifestBytes: 1024 } }); const { project, release } = await projectAndRelease(f);
  const big = run(f.root, { extra: 'x'.repeat(1200) });
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: big.runId, releaseId: release.id }), 'SOURCE_INTEGRITY_FAILED', 409);
  const outside = mkdtempSync(join(tmpdir(), 'heimdall-catalog-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  const runId = uid('ac'); writeFileSync(join(outside, 'manifest.json'), JSON.stringify({ ...big.manifest, runId, extra: undefined }));
  symlinkSync(outside, join(f.root, runId), process.platform === 'win32' ? 'junction' : 'dir');
  const original = readFileSync(join(outside, 'manifest.json'));
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId, releaseId: release.id }), 'SOURCE_INTEGRITY_FAILED', 409);
  assert.deepEqual(readFileSync(join(outside, 'manifest.json')), original);
});

test('a manifest file alias cannot read metadata outside its run directory', async t => {
  const f = fixture(t); const { project, release } = await projectAndRelease(f);
  const source = run(f.root), manifestFile = join(source.dir, 'manifest.json');
  const outside = mkdtempSync(join(tmpdir(), 'heimdall-catalog-manifest-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, 'external-manifest.json');
  const original = readFileSync(manifestFile); writeFileSync(outsideFile, original); rmSync(manifestFile);
  try { symlinkSync(outsideFile, manifestFile, 'file'); }
  catch (cause) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(cause.code)) {
      t.skip('This Windows process cannot create file symbolic links.'); return;
    }
    throw cause;
  }
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: source.runId, releaseId: release.id }), 'SOURCE_INTEGRITY_FAILED', 409);
  assert.deepEqual(readFileSync(outsideFile), original);
});

test('generation and revision are checked inside serialized writes and cannot be replayed', async t => {
  const f = fixture(t); await f.store.initialize(); const original = cas(f.store);
  const results = await Promise.allSettled(['A', 'B'].map(name => f.store.createProject({ ...original, name })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STALE_REVISION');
  assert.equal(f.store.read().revision, 1); assert.equal(Object.keys(f.store.read().projects).length, 1);
  await unchanged(f, f.store.createProject({ ...cas(f.store), expectedGenerationId: uid('ag'), name: 'stale generation' }), 'STALE_REVISION', 409);
  const restored = f.store.read(); restored.generationId = uid('ag'); writeFileSync(join(f.root, 'catalog.json'), JSON.stringify(restored));
  await unchanged(f, f.store.createProject({ ...original, expectedRevision: restored.revision, name: 'old tab after restore' }), 'STALE_REVISION', 409);
});

test('bounded write queue rejects overload and recovers after rejected transactions', async t => {
  const f = fixture(t, { limits: { queue: 2 } }); await f.store.initialize(); const base = cas(f.store);
  const results = await Promise.allSettled(['A', 'B', 'C'].map(name => f.store.createProject({ ...base, name })));
  assert.deepEqual(results.map(result => result.status === 'fulfilled' ? 'ok' : result.reason.code), ['ok', 'STALE_REVISION', 'CATALOG_QUEUE_FULL']);
  await f.store.createProject({ ...cas(f.store), name: 'queue still works' }); assert.equal(f.store.read().revision, 2);
});

test('entity, event and byte capacity refuse writes without deleting or revising history', async t => {
  for (const limits of [{ projects: 1 }, { events: 1 }, { jsonBytes: 800 }]) {
    const f = fixture(t, { limits }); await f.store.initialize();
    if (!limits.jsonBytes) await f.store.createProject({ ...cas(f.store), name: 'first' });
    await unchanged(f, f.store.createProject({ ...cas(f.store), name: 'x'.repeat(120) }), 'CATALOG_CAPACITY', 409);
  }
  const f = fixture(t, { limits: { releases: 1, runBindings: 1 } }); const { project, release } = await projectAndRelease(f);
  await unchanged(f, f.store.createRelease(project.id, { ...cas(f.store), label: 'second', targetUrl: TARGET }), 'CATALOG_CAPACITY', 409);
  const first = run(f.root), second = run(f.root);
  await f.store.bindRun(project.id, { ...cas(f.store), runId: first.runId, releaseId: release.id });
  await unchanged(f, f.store.bindRun(project.id, { ...cas(f.store), runId: second.runId, releaseId: release.id }), 'CATALOG_CAPACITY', 409);
});

test('corrupt catalog schemas, references and event history are preserved rather than reinitialized', async t => {
  const f = fixture(t); await projectAndRelease(f); const valid = f.store.read();
  const projectId = Object.keys(valid.projects)[0], releaseId = Object.keys(valid.releases)[0];
  const mutations = [
    value => { value.schemaVersion = 2; }, value => { value.approvals = {}; }, value => { value.revision = -1; },
    value => { value.projects[projectId].current = {}; }, value => { value.releases[releaseId].projectId = uid('ap'); },
    value => { value.releases[releaseId].targetUrl = 'https://changed.test/'; }, value => { value.events[0].revision = 2; },
    value => { value.events[1].kind = 'baseline-approved'; }, value => { value.events[1].entityDigest = '0'.repeat(64); },
    value => { value.events[0].actor.label = 'not supported'; }, value => { value.events.reverse(); },
  ];
  for (const mutate of mutations) {
    const corrupt = JSON.parse(JSON.stringify(valid)); mutate(corrupt);
    const original = Buffer.from(JSON.stringify(corrupt)); writeFileSync(join(f.root, 'catalog.json'), original);
    assert.throws(() => f.store.read(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
    await assert.rejects(f.store.initialize(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
    assert.deepEqual(bytes(f.root), original);
  }
  for (const invalidJson of ['null', '[]', '{}', '{broken']) {
    writeFileSync(join(f.root, 'catalog.json'), invalidJson);
    await assert.rejects(f.store.initialize(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
    assert.equal(bytes(f.root).toString(), invalidJson);
  }
});

test('missing catalog with a backup or orphan temporary is never silently replaced by an empty catalog', async t => {
  const f = fixture(t); await f.store.initialize(); await f.store.createProject({ ...cas(f.store), name: 'old' });
  const original = readFileSync(join(f.root, 'catalog.previous.json')); rmSync(join(f.root, 'catalog.json'));
  await assert.rejects(f.store.initialize(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
  assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), original);
  const other = fixture(t); writeFileSync(join(other.root, 'catalog.json.crashed.tmp'), 'unfinished');
  await assert.rejects(other.store.initialize(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
  assert.equal(readdirSync(other.root).includes('catalog.json'), false);
});

test('catalog byte limits and corrupt recovery material block writes without clobbering originals', async t => {
  const f = fixture(t); await f.store.initialize(); await f.store.createProject({ ...cas(f.store), name: 'old' });
  writeFileSync(join(f.root, 'catalog.previous.json'), '{broken backup');
  await unchanged(f, f.store.createProject({ ...cas(f.store), name: 'new' }), 'CATALOG_UNAVAILABLE', 503);
  assert.equal(readFileSync(join(f.root, 'catalog.previous.json'), 'utf8'), '{broken backup');
  const bounded = createAcceptanceCatalogStore({ root: f.root, owner: f.owner, limits: { jsonBytes: 20 } });
  assert.throws(() => bounded.read(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
});

test('owner fencing runs before initialization and immediately before committing a mutation', async t => {
  const f = fixture(t); let allowed = false, calls = 0, loseAt = Infinity;
  f.owner.assertOwned = () => { calls++; if (!allowed || calls === loseAt) throw Object.assign(new Error('private disk path'), { status: 503, code: 'ACCEPTANCE_OWNER_UNAVAILABLE' }); };
  await assert.rejects(f.store.initialize(), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE', status: 503 });
  assert.equal(readdirSync(f.root).length, 0);
  allowed = true; await f.store.initialize(); calls = 0; loseAt = 2;
  await unchanged(f, f.store.createProject({ ...cas(f.store), name: 'lost owner' }), 'ACCEPTANCE_OWNER_UNAVAILABLE', 503);
  assert.equal(f.store.read().revision, 0);
  loseAt = Infinity; allowed = false;
  await unchanged(f, f.store.createProject({ ...cas(f.store), name: 'not owner' }), 'ACCEPTANCE_OWNER_UNAVAILABLE', 503);
  const wrong = createAcceptanceCatalogStore({ root: f.root, owner: { root: join(f.root, 'different'), assertOwned() {} } });
  await assert.rejects(wrong.initialize(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
});

test('failed atomic replacement leaves the old catalog and safe recovery preimage intact', async t => {
  let failedPath;
  const f = fixture(t, { writeAtomic(file, content) {
    if (failedPath && file.endsWith(failedPath)) throw new Error('secret absolute path and filesystem details');
    return writeAtomicFileSync(file, content);
  } });
  await f.store.initialize(); const original = bytes(f.root);
  for (const name of ['catalog.previous.json', 'catalog.json']) {
    failedPath = name;
    await unchanged(f, f.store.createProject({ ...cas(f.store), name: 'failed write' }), 'CATALOG_UNAVAILABLE', 503);
  }
  assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), original);
  failedPath = undefined; await f.store.createProject({ ...cas(f.store), name: 'recovered' });
  assert.equal(f.store.read().revision, 1);
});

test('catalog path aliases cannot overwrite another directory or escape through a run manifest', async t => {
  const f = fixture(t); const outside = mkdtempSync(join(tmpdir(), 'heimdall-catalog-path-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'keep.json'), '{"keep":true}');
  symlinkSync(outside, join(f.root, 'catalog.json'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.initialize(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
  assert.deepEqual(readdirSync(outside), ['keep.json']);
  const alias = join(outside, 'root-alias'); rmSync(join(f.root, 'catalog.json'), { recursive: true, force: true });
  symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const throughAlias = createAcceptanceCatalogStore({ root: alias, owner: f.owner });
  await throughAlias.initialize();
  assert.deepEqual(throughAlias.read(), f.store.read());
});

test('root directory replacement is detected even when the pathname stays the same', async t => {
  const f = fixture(t); await f.store.initialize(); const moved = f.root + '-moved';
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  renameSync(f.root, moved); mkdirSync(f.root);
  await assert.rejects(f.store.initialize(), { code: 'CATALOG_UNAVAILABLE', status: 503 });
  assert.deepEqual(readdirSync(f.root), []);
});

test('pure catalog validation rejects prototype-map keys and malformed revision types', async t => {
  const f = fixture(t); const valid = await f.store.initialize();
  for (const value of [true, '0', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateAcceptanceCatalog({ ...valid, revision: value }), { code: 'CATALOG_UNAVAILABLE', status: 503 });
  }
  const injected = JSON.parse(JSON.stringify(valid)); injected.projects = JSON.parse('{"__proto__":{}}');
  assert.throws(() => validateAcceptanceCatalog(injected), { code: 'CATALOG_UNAVAILABLE', status: 503 });
});
