import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { buildCatalogMigration } from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';

const at = '2026-10-16T00:00:00.000Z';
const targetUrl = 'http://127.0.0.1:3000/preview?version=1';
const uid = prefix => `${prefix}-${randomUUID()}`;
const clone = value => JSON.parse(JSON.stringify(value));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const archiveName = bytes => `catalog.v1.${sha256(bytes)}.json`;
const versionedArchiveName = bytes => `catalog.v${JSON.parse(bytes).schemaVersion}.${sha256(bytes)}.json`;
const headBytes = f => readFileSync(join(f.root, 'catalog.json'));
const previousBytes = f => readFileSync(join(f.root, 'catalog.previous.json'));
const archives = root => readdirSync(root).filter(name => /^catalog\.v1\.[a-f0-9]{64}\.json$/.test(name)).sort();
const archivesV2 = root => readdirSync(root).filter(name => /^catalog\.v2\.[a-f0-9]{64}\.json$/.test(name)).sort();
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-catalog-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = { root, assertOwned() {} };
  return { root, owner, store: createAcceptanceCatalogStore({ root, owner, ...options }) };
}

// Construct only the exact B1 format. It must remain valid without a B2 initializer.
function legacySnapshots() {
  const catalog = { schemaVersion: 1, generationId: uid('ag'), revision: 0,
    projects: {}, releases: {}, runBindings: {}, events: [] };
  const snapshots = [clone(catalog)];
  const project = { id: uid('ap'), name: '迁移前项目', createdAt: at };
  const release = { id: uid('ar'), projectId: project.id, label: 'v1', targetUrl, buildRef: 'old-build', createdAt: at };
  const binding = { runId: uid('ac'), projectId: project.id, releaseId: release.id, boundAt: at, actor: { kind: 'local-operator' } };
  for (const [map, entity, kind] of [['projects', project, 'project-created'], ['releases', release, 'release-created'], ['runBindings', binding, 'run-bound']]) {
    const entityId = entity.id ?? entity.runId;
    catalog[map][entityId] = entity;
    catalog.events.push({ id: uid('ae'), revision: ++catalog.revision, kind, projectId: project.id,
      entityId, entityDigest: hashAcceptanceValue(entity), at, actor: { kind: 'local-operator' } });
    snapshots.push(clone(catalog));
  }
  for (const snapshot of snapshots) validateAcceptanceCatalog(snapshot);
  return { snapshots, project, release, binding };
}

function seedLegacy(f, { head = 3, previous = 2 } = {}) {
  const old = legacySnapshots(), headValue = old.snapshots[head];
  const headRaw = encode(headValue);
  writeFileSync(join(f.root, 'catalog.json'), headRaw);
  const previousValue = previous === null ? null : old.snapshots[previous];
  const previousRaw = previousValue ? encode(previousValue) : null;
  if (previousRaw) writeFileSync(join(f.root, 'catalog.previous.json'), previousRaw);
  return { ...old, root: f.root, head: headValue, headRaw, previous: previousValue, previousRaw };
}

function assertOldEntities(current, old) {
  for (const map of ['projects', 'releases', 'runBindings']) assert.deepEqual(current[map], old[map]);
  assert.deepEqual(current.events.slice(0, old.revision), old.events);
}

// Preserve the original 1 -> 2 facts, including its exact input raw hashes.
function assertMigrationV2(current, old, { headRaw, previousRaw }) {
  assert.equal(current.schemaVersion, 2);
  assert.notEqual(current.generationId, old.generationId);
  assert.equal(current.revision, old.revision + 1);
  for (const map of ['candidates', 'approvals', 'selections']) assert.deepEqual(current[map], {});
  assert.equal(Object.keys(current.migrations).length, 1);
  const migration = Object.values(current.migrations)[0];
  assert.match(migration.id, /^am-[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(migration).sort(), ['actor', 'createdAt', 'fromGenerationId', 'fromRevision', 'fromSchemaVersion', 'id',
    'sourceHeadSha256', 'sourcePreviousSha256', 'toSchemaVersion']);
  assert.equal(migration.fromSchemaVersion, 1); assert.equal(migration.toSchemaVersion, 2);
  assert.equal(migration.fromGenerationId, old.generationId); assert.equal(migration.fromRevision, old.revision);
  assert.equal(migration.sourceHeadSha256, sha256(headRaw));
  assert.equal(migration.sourcePreviousSha256, previousRaw ? sha256(previousRaw) : null);
  assert.deepEqual(migration.actor, { kind: 'local-operator' });
  const event = current.events.at(-1);
  assert.equal(event.kind, 'catalog-migrated'); assert.equal(event.revision, current.revision);
  assert.equal(event.entityId, migration.id); assert.equal(event.entityDigest, hashAcceptanceValue(migration));
  assert.equal(event.at, migration.createdAt); assert.equal(Object.hasOwn(event, 'projectId'), false);
  assertOldEntities(current, old);
  validateAcceptanceCatalog(current);
  return migration;
}

function assertMigration(current, old, source) {
  if (current.schemaVersion === 2) return assertMigrationV2(current, old, source);
  const migrations = Object.values(current.migrations), last = migrations.find(value => value.fromSchemaVersion === 2);
  assert.equal(current.schemaVersion, 3);
  assert.equal(migrations.length, 2);
  assert.deepEqual(current.browserSourceBindings, {});
  assert.equal(current.revision, old.revision + 2);
  assert.equal(last.toSchemaVersion, 3);
  const intermediateRaw = readFileSync(join(source.root, `catalog.v2.${last.sourceHeadSha256}.json`));
  const intermediate = JSON.parse(intermediateRaw);
  assertMigrationV2(intermediate, old, source);
  assert.notEqual(current.generationId, old.generationId);
  assert.notEqual(current.generationId, intermediate.generationId);
  assert.equal(last.fromGenerationId, intermediate.generationId);
  assert.equal(last.fromRevision, intermediate.revision);
  assert.equal(last.sourceHeadSha256, sha256(intermediateRaw));
  assert.equal(last.sourcePreviousSha256, sha256(source.headRaw));
  assert.deepEqual(current.events.slice(0, intermediate.revision), intermediate.events);
  assert.deepEqual(current.migrations[Object.keys(intermediate.migrations)[0]], Object.values(intermediate.migrations)[0]);
  const event = current.events.at(-1);
  assert.equal(event.kind, 'catalog-migrated'); assert.equal(event.revision, current.revision);
  assert.equal(event.entityId, last.id); assert.equal(event.entityDigest, hashAcceptanceValue(last));
  assert.equal(event.at, last.createdAt); assert.equal(Object.hasOwn(event, 'projectId'), false);
  assertOldEntities(current, old);
  validateAcceptanceCatalog(current);
  return last;
}

async function assertBlockedMigration(f, old, expected = unavailable) {
  await assert.rejects(f.store.initialize(), expected);
  assert.deepEqual(headBytes(f), old.headRaw);
  if (old.previousRaw) assert.deepEqual(previousBytes(f), old.previousRaw);
  assert.throws(() => f.store.read(), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
}

function changeProject(catalog) {
  const changed = clone(catalog), project = Object.values(changed.projects)[0];
  project.name = '另一个合法历史';
  changed.events.find(event => event.entityId === project.id).entityDigest = hashAcceptanceValue(project);
  validateAcceptanceCatalog(changed);
  return changed;
}

test('new catalogs start at schema3 without a migration and restart without changing bytes', async t => {
  const f = fixture(t), current = await f.store.initialize();
  assert.equal(current.schemaVersion, 3); assert.equal(current.revision, 0);
  assert.deepEqual(Object.keys(current).sort(), ['approvals', 'browserSourceBindings', 'candidates', 'events', 'generationId', 'migrations',
    'projects', 'releases', 'revision', 'runBindings', 'schemaVersion', 'selections']);
  for (const key of ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'migrations', 'browserSourceBindings']) assert.deepEqual(current[key], {});
  assert.deepEqual(current.events, []); assert.deepEqual(readdirSync(f.root), ['catalog.json']);
  const original = headBytes(f);
  assert.deepEqual(await f.store.initialize(), current);
  const restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  assert.deepEqual(await restarted.initialize(), current); assert.deepEqual(headBytes(f), original);
});

test('an unmigrated schema1 head is pure-valid but cannot be read or mutated as the active catalog', async t => {
  const f = fixture(t), old = seedLegacy(f);
  assert.equal(validateAcceptanceCatalog(old.head), old.head);
  assert.throws(() => f.store.read(), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
  await assert.rejects(f.store.createProject({ ...cas(old.head), name: '不能回退旧写路径' }), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
  assert.deepEqual(headBytes(f), old.headRaw); assert.deepEqual(previousBytes(f), old.previousRaw);
  assert.deepEqual(archives(f.root), []);
});

test('an empty schema1 head commits both migration steps and preserves the null first previous hash', async t => {
  const f = fixture(t), old = seedLegacy(f, { head: 0, previous: null });
  const current = await f.store.initialize();
  assertMigration(current, old.head, old);
  assert.deepEqual(archives(f.root), [archiveName(old.headRaw)]);
  assert.deepEqual(readFileSync(join(f.root, archiveName(old.headRaw))), old.headRaw);
  assert.equal(JSON.parse(previousBytes(f)).schemaVersion, 2);
  assert.equal(archivesV2(f.root).length, 1);
  assert.deepEqual(readFileSync(join(f.root, versionedArchiveName(previousBytes(f)))), previousBytes(f));
  const committed = headBytes(f), restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  assert.deepEqual(await restarted.initialize(), current); assert.deepEqual(headBytes(f), committed);
  assert.equal(restarted.read().events.filter(event => event.kind === 'catalog-migrated').length, 2);
});

test('nonempty migration preserves every B1 entity, event and run byte and archives both raw snapshots', async t => {
  const f = fixture(t), old = seedLegacy(f);
  const runDir = join(f.root, old.binding.runId); mkdirSync(runDir);
  const manifestRaw = encode({ schemaVersion: 1, runId: old.binding.runId, name: '旧运行', mode: 'spec', targetUrl,
    status: 'completed', gate: 'failed', createdAt: at, plan: { mode: 'spec', targetUrl } });
  const reportRaw = Buffer.from('{"originalReport":true}\n');
  writeFileSync(join(runDir, 'manifest.json'), manifestRaw); writeFileSync(join(runDir, 'report.json'), reportRaw);
  const current = await f.store.initialize();
  assertMigration(current, old.head, old);
  assert.deepEqual(archives(f.root), [archiveName(old.headRaw), archiveName(old.previousRaw)].sort());
  for (const raw of [old.headRaw, old.previousRaw]) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
  assert.equal(JSON.parse(previousBytes(f)).schemaVersion, 2);
  assert.deepEqual(readFileSync(join(runDir, 'manifest.json')), manifestRaw);
  assert.deepEqual(readFileSync(join(runDir, 'report.json')), reportRaw);
  const source = f.store.readRunReference(old.binding.runId);
  assert.equal(source.diagnostics.manifestValid, true); assert.equal(source.diagnostics.evidenceVerified, false);
  assert.deepEqual(source.source.runId, old.binding.runId);
});

test('identical legacy head and previous bytes reuse one archive while different formatting keeps two raw preimages', async t => {
  for (const formatting of ['same', 'compact']) await t.test(formatting, async t => {
    const f = fixture(t), old = seedLegacy(f, { head: 3, previous: 3 });
    if (formatting === 'compact') {
      old.previousRaw = Buffer.from(JSON.stringify(old.head));
      writeFileSync(join(f.root, 'catalog.previous.json'), old.previousRaw);
    }
    const current = await f.store.initialize(); assertMigration(current, old.head, old);
    assert.equal(archives(f.root).length, formatting === 'same' ? 1 : 2);
    assert.deepEqual(readFileSync(join(f.root, archiveName(old.previousRaw))), old.previousRaw);
  });
});

test('the first schema3 write accepts its exact B2 predecessor and fences both older generation CAS including equal-revision ABA', async t => {
  const f = fixture(t), old = seedLegacy(f), migrated = await f.store.initialize(), migratedRaw = headBytes(f);
  for (const revision of [old.head.revision, migrated.revision]) {
    await assert.rejects(f.store.createProject({ expectedGenerationId: old.head.generationId, expectedRevision: revision, name: '旧页面' }), { code: 'STALE_REVISION', status: 409 });
    assert.deepEqual(headBytes(f), migratedRaw);
  }
  const intermediate = JSON.parse(previousBytes(f));
  await assert.rejects(f.store.createProject({ expectedGenerationId: intermediate.generationId,
    expectedRevision: migrated.revision, name: '中间代旧页面' }), { code: 'STALE_REVISION', status: 409 });
  assert.deepEqual(headBytes(f), migratedRaw);
  const result = await f.store.createProject({ ...cas(migrated), name: '升级后项目' });
  assert.equal(result.generationId, migrated.generationId); assert.equal(result.revision, migrated.revision + 1);
  assert.deepEqual(previousBytes(f), migratedRaw);
  for (const raw of [old.headRaw, old.previousRaw]) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
  assert.deepEqual(f.store.read().events.slice(0, migrated.revision), migrated.events);
});

test('legacy predecessor validation rejects another generation and valid divergent histories before archiving', async t => {
  for (const kind of ['generation', 'same-revision-entity', 'event-prefix', 'newer-revision']) await t.test(kind, async t => {
    const f = fixture(t), old = seedLegacy(f);
    let prior = clone(old.previous);
    if (kind === 'generation') prior.generationId = uid('ag');
    if (kind === 'same-revision-entity') prior = changeProject(old.head);
    if (kind === 'event-prefix') prior.events[0].id = uid('ae');
    if (kind === 'newer-revision') {
      prior = clone(old.head);
      const project = { id: uid('ap'), name: '未来项目', createdAt: at };
      prior.projects[project.id] = project;
      prior.events.push({ id: uid('ae'), revision: ++prior.revision, kind: 'project-created', projectId: project.id,
        entityId: project.id, entityDigest: hashAcceptanceValue(project), at, actor: { kind: 'local-operator' } });
    }
    validateAcceptanceCatalog(prior); old.previousRaw = encode(prior);
    writeFileSync(join(f.root, 'catalog.previous.json'), old.previousRaw);
    await assertBlockedMigration(f, old); assert.deepEqual(archives(f.root), []);
  });
});

test('schema1 head with a schema2 previous is a refused lineage ambiguity', async t => {
  const f = fixture(t), old = seedLegacy(f);
  old.previousRaw = encode(buildCatalogMigration(old.head, { headSha256: sha256(old.headRaw) }));
  writeFileSync(join(f.root, 'catalog.previous.json'), old.previousRaw);
  await assertBlockedMigration(f, old); assert.deepEqual(archives(f.root), []);
});

test('schema3 diagnostic read remains available while an inexact B2 previous blocks initialization and every write', async t => {
  for (const kind of ['formatting', 'generation', 'revision']) await t.test(kind, async t => {
    const f = fixture(t), old = seedLegacy(f), migrated = await f.store.initialize(), committed = headBytes(f);
    let prior = JSON.parse(previousBytes(f));
    if (kind === 'generation') prior.generationId = uid('ag');
    if (kind === 'revision') prior = buildCatalogMigration(old.previous, { headSha256: sha256(old.previousRaw) });
    const altered = kind === 'formatting' ? Buffer.from(JSON.stringify(prior)) : encode(prior);
    writeFileSync(join(f.root, 'catalog.previous.json'), altered);
    assert.deepEqual(f.store.read(), migrated);
    await assert.rejects(f.store.initialize(), unavailable);
    await assert.rejects(f.store.createProject({ ...cas(migrated), name: '不会覆盖前像' }), unavailable);
    assert.deepEqual(headBytes(f), committed); assert.deepEqual(previousBytes(f), altered);
  });
});

test('schema3 predecessors require same-generation immutable event and entity ancestry', async t => {
  for (const kind of ['ancestor', 'same-snapshot', 'generation', 'same-revision-entity', 'event-prefix']) await t.test(kind, async t => {
    const f = fixture(t); await f.store.initialize();
    await f.store.createProject({ ...cas(f.store.read()), name: '项目一' }); const ancestor = f.store.read();
    await f.store.createProject({ ...cas(ancestor), name: '项目二' }); const head = f.store.read(), original = headBytes(f);
    let prior = kind === 'same-snapshot' || kind === 'same-revision-entity' ? clone(head) : clone(ancestor);
    if (kind === 'generation') prior.generationId = uid('ag');
    if (kind === 'same-revision-entity') prior = changeProject(prior);
    if (kind === 'event-prefix') prior.events[0].id = uid('ae');
    validateAcceptanceCatalog(prior); const raw = encode(prior); writeFileSync(join(f.root, 'catalog.previous.json'), raw);
    const operation = f.store.createProject({ ...cas(head), name: '后续操作' });
    if (['ancestor', 'same-snapshot'].includes(kind)) {
      assert.equal((await operation).revision, head.revision + 1); assert.deepEqual(previousBytes(f), original);
    } else {
      await assert.rejects(operation, unavailable); assert.deepEqual(headBytes(f), original); assert.deepEqual(previousBytes(f), raw);
    }
  });
});

test('schema3 rolling previous cannot omit or alter the migration lineage', async t => {
  const f = fixture(t); seedLegacy(f); const migrated = await f.store.initialize();
  await f.store.createProject({ ...cas(migrated), name: '迁移后项目' }); const committed = headBytes(f), current = f.store.read();
  const prior = clone(migrated), migration = Object.values(prior.migrations)[0];
  migration.sourcePreviousSha256 = 'f'.repeat(64);
  prior.events.find(event => event.entityId === migration.id).entityDigest = hashAcceptanceValue(migration);
  validateAcceptanceCatalog(prior); const raw = encode(prior); writeFileSync(join(f.root, 'catalog.previous.json'), raw);
  assert.deepEqual(f.store.read(), current);
  await assert.rejects(f.store.createProject({ ...cas(current), name: '阻止改谱系' }), unavailable);
  assert.deepEqual(headBytes(f), committed); assert.deepEqual(previousBytes(f), raw);
});

test('corrupt, unknown and unsafe previous files abort migration without erasing recovery material', async t => {
  for (const kind of ['json', 'schema', 'directory', 'junction']) await t.test(kind, async t => {
    const f = fixture(t), old = seedLegacy(f, { previous: null });
    const path = join(f.root, 'catalog.previous.json');
    if (kind === 'json') writeFileSync(path, '{broken previous');
    if (kind === 'schema') writeFileSync(path, encode({ ...old.head, schemaVersion: 3 }));
    if (kind === 'directory') mkdirSync(path);
    const outside = fixture(t); writeFileSync(join(outside.root, 'keep.txt'), 'outside original');
    if (kind === 'junction') symlinkSync(outside.root, path, process.platform === 'win32' ? 'junction' : 'dir');
    const original = ['json', 'schema'].includes(kind) ? readFileSync(path) : null;
    await assert.rejects(f.store.initialize(), unavailable); assert.deepEqual(headBytes(f), old.headRaw);
    assert.deepEqual(archives(f.root), []);
    if (original) assert.deepEqual(readFileSync(path), original);
    else assert.equal(statSync(path).isDirectory(), true);
    assert.equal(readFileSync(join(outside.root, 'keep.txt'), 'utf8'), 'outside original');
  });
});

test('missing head with an archive, rolling previous or temporary file never initializes an empty directory', async t => {
  for (const kind of ['archive', 'previous', 'temporary']) await t.test(kind, async t => {
    const f = fixture(t), legacy = encode(legacySnapshots().snapshots[0]);
    const name = kind === 'archive' ? archiveName(legacy) : kind === 'previous' ? 'catalog.previous.json' : 'catalog.json.crashed.tmp';
    writeFileSync(join(f.root, name), legacy);
    await assert.rejects(f.store.initialize(), unavailable);
    assert.deepEqual(readdirSync(f.root), [name]); assert.deepEqual(readFileSync(join(f.root, name)), legacy);
  });
});

test('matching archive bytes are reused without replacement and conflicting or unsafe archive paths are refused', async t => {
  for (const kind of ['same', 'different', 'directory', 'junction']) await t.test(kind, async t => {
    const f = fixture(t), old = seedLegacy(f, { head: 0, previous: null }), path = join(f.root, archiveName(old.headRaw));
    const outside = fixture(t); writeFileSync(join(outside.root, 'keep.txt'), 'outside original');
    if (kind === 'same') writeFileSync(path, old.headRaw);
    if (kind === 'different') writeFileSync(path, encode(legacySnapshots().snapshots[0]));
    if (kind === 'directory') mkdirSync(path);
    if (kind === 'junction') symlinkSync(outside.root, path, process.platform === 'win32' ? 'junction' : 'dir');
    const before = statSync(path, { bigint: true });
    const original = ['same', 'different'].includes(kind) ? readFileSync(path) : null;
    if (kind === 'same') {
      await f.store.initialize(); const after = statSync(path, { bigint: true });
      assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
    } else await assertBlockedMigration(f, old);
    if (original) assert.deepEqual(readFileSync(path), original);
    assert.equal(readFileSync(join(outside.root, 'keep.txt'), 'utf8'), 'outside original');
  });
});

test('migration entity, event and byte capacity are checked before creating any preparation files', async t => {
  for (const kind of ['events', 'migrations', 'jsonBytes']) await t.test(kind, async t => {
    const f = fixture(t), old = seedLegacy(f);
    const limits = kind === 'events' ? { events: old.head.revision } : kind === 'migrations' ? { migrations: 0 } : { jsonBytes: old.headRaw.length };
    const limited = createAcceptanceCatalogStore({ root: f.root, owner: f.owner, limits });
    await assert.rejects(limited.initialize(), { code: 'CATALOG_CAPACITY', status: 409, details: { limit: kind } });
    assert.deepEqual(headBytes(f), old.headRaw); assert.deepEqual(previousBytes(f), old.previousRaw);
    assert.deepEqual(archives(f.root), []);
  });
});

test('archive capacity is preflighted for both new hashes without partially preparing a migration', async t => {
  const f = fixture(t), old = seedLegacy(f), unrelated = encode(legacySnapshots().snapshots[0]);
  writeFileSync(join(f.root, archiveName(unrelated)), unrelated);
  await assertBlockedMigration(f, old);
  assert.deepEqual(archives(f.root), [archiveName(unrelated)]);
  assert.deepEqual(readFileSync(join(f.root, archiveName(unrelated))), unrelated);
});

test('exclusive archive publication failures preserve original files and a fresh initializer can retry', async t => {
  for (const failAt of [1, 2]) await t.test(`archive-${failAt}`, async t => {
    let calls = 0;
    const f = fixture(t, { writeExclusive(file, bytes) {
      if (++calls === failAt) throw new Error('private filesystem failure');
      writeFileSync(file, bytes, { flag: 'wx' });
    } }), old = seedLegacy(f);
    await assertBlockedMigration(f, old); assert.equal(archives(f.root).length, failAt - 1);
    const restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
    const current = await restarted.initialize(); assertMigration(current, old.head, old);
    for (const raw of [old.headRaw, old.previousRaw]) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
  });
});

test('an exclusive-create race is accepted only when the published archive has the exact original bytes', async t => {
  for (const kind of ['same', 'different']) await t.test(kind, async t => {
    let competingRaw;
    const f = fixture(t, { writeExclusive(file, bytes) {
      const publishedRaw = kind === 'same' ? bytes : encode(legacySnapshots().snapshots[0]);
      competingRaw ??= publishedRaw;
      writeFileSync(file, publishedRaw, { flag: 'wx' });
      throw Object.assign(new Error('another publisher won'), { code: 'EEXIST' });
    } }), old = seedLegacy(f, { head: 0, previous: null });
    if (kind === 'same') assertMigration(await f.store.initialize(), old.head, old);
    else await assertBlockedMigration(f, old);
    assert.deepEqual(readFileSync(join(f.root, archiveName(old.headRaw))), competingRaw);
  });
});

test('failed rolling previous and head replacements are retryable and never reuse an uncommitted generation', async t => {
  for (const failAt of ['catalog.previous.json', 'catalog.json']) await t.test(failAt, async t => {
    let attempted;
    const f = fixture(t, { writeAtomic(file, bytes) {
      if (basename(file) === failAt) {
        if (failAt === 'catalog.json') attempted = JSON.parse(bytes.toString('utf8'));
        throw new Error('private filesystem failure');
      }
      writeAtomicFileSync(file, bytes);
    } }), old = seedLegacy(f);
    await assert.rejects(f.store.initialize(), unavailable); assert.deepEqual(headBytes(f), old.headRaw);
    assert.deepEqual(previousBytes(f), failAt === 'catalog.json' ? old.headRaw : old.previousRaw);
    const beforeRetry = previousBytes(f), restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
    const current = await restarted.initialize();
    assertMigration(current, old.head, { root: f.root, headRaw: old.headRaw, previousRaw: beforeRetry });
    if (attempted) assert.notEqual(current.generationId, attempted.generationId);
    for (const raw of [old.headRaw, old.previousRaw]) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
    assert.equal(current.events.filter(event => event.kind === 'catalog-migrated').length, 2);
  });
});

test('a B2 head committed before an injected transport failure is recognized before the remaining step on restart', async t => {
  const f = fixture(t, { writeAtomic(file, bytes) {
    writeAtomicFileSync(file, bytes);
    if (basename(file) === 'catalog.json') throw new Error('lost completion after durable replacement');
  } }), old = seedLegacy(f);
  await assert.rejects(f.store.initialize(), unavailable);
  const committedRaw = headBytes(f), committed = JSON.parse(committedRaw.toString('utf8'));
  assertMigrationV2(committed, old.head, old);
  const restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
  const current = await restarted.initialize();
  assertMigration(current, old.head, old); assert.deepEqual(previousBytes(f), committedRaw);
  const finalRaw = headBytes(f);
  assert.deepEqual(await restarted.initialize(), current); assert.deepEqual(headBytes(f), finalRaw);
  assert.equal(current.events.filter(event => event.kind === 'catalog-migrated').length, 2);
});

test('owner loss before preparation, before previous, or before head fences the next migration write', async t => {
  for (const phase of ['preparation', 'previous', 'head']) await t.test(phase, async t => {
    let allowed = true, ownerCalls = 0, archiveCalls = 0;
    const f = fixture(t, {
      writeExclusive(file, bytes) {
        writeFileSync(file, bytes, { flag: 'wx' });
        if (phase === 'previous' && ++archiveCalls === 2) allowed = false;
      },
      writeAtomic(file, bytes) {
        writeAtomicFileSync(file, bytes);
        if (phase === 'head' && basename(file) === 'catalog.previous.json') allowed = false;
      },
    }), old = seedLegacy(f);
    f.owner.assertOwned = () => {
      if (phase === 'preparation' && ++ownerCalls === 2) allowed = false;
      if (!allowed) throw Object.assign(new Error('owner lost'), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE', status: 503 });
    };
    await assert.rejects(f.store.initialize(), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE', status: 503 });
    assert.deepEqual(headBytes(f), old.headRaw);
    assert.deepEqual(previousBytes(f), phase === 'head' ? old.headRaw : old.previousRaw);
    assert.equal(archives(f.root).length, phase === 'preparation' ? 0 : 2);
  });
});

test('byte CAS checks both legacy files again after preimages have been published', async t => {
  for (const changedName of ['catalog.json', 'catalog.previous.json']) await t.test(changedName, async t => {
    let calls = 0;
    const f = fixture(t, { writeExclusive(file, bytes) {
      writeFileSync(file, bytes, { flag: 'wx' });
      if (++calls === 2) {
        const changed = join(f.root, changedName);
        writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from(' ')]));
      }
    } }), old = seedLegacy(f);
    await assert.rejects(f.store.initialize(), { code: 'STALE_REVISION', status: 409 });
    assert.deepEqual(headBytes(f), changedName === 'catalog.json' ? Buffer.concat([old.headRaw, Buffer.from(' ')]) : old.headRaw);
    assert.deepEqual(previousBytes(f), changedName === 'catalog.previous.json' ? Buffer.concat([old.previousRaw, Buffer.from(' ')]) : old.previousRaw);
    assert.equal(JSON.parse(headBytes(f).toString('utf8')).schemaVersion, 1);
    for (const raw of [old.headRaw, old.previousRaw]) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
  });
});

test('external changes after rolling previous replacement fence the final head commit', async t => {
  for (const changedName of ['catalog.json', 'catalog.previous.json']) await t.test(changedName, async t => {
    const f = fixture(t, { writeAtomic(file, bytes) {
      writeAtomicFileSync(file, bytes);
      if (basename(file) === 'catalog.previous.json') {
        const changed = join(f.root, changedName);
        writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from(' ')]));
      }
    } }), old = seedLegacy(f);
    await assert.rejects(f.store.initialize(), { code: 'STALE_REVISION', status: 409 });
    assert.deepEqual(headBytes(f), changedName === 'catalog.json' ? Buffer.concat([old.headRaw, Buffer.from(' ')]) : old.headRaw);
    assert.deepEqual(previousBytes(f), changedName === 'catalog.previous.json' ? Buffer.concat([old.headRaw, Buffer.from(' ')]) : old.headRaw);
    assert.equal(JSON.parse(headBytes(f).toString('utf8')).schemaVersion, 1);
    for (const raw of [old.headRaw, old.previousRaw]) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
  });
});

test('a root inode replacement during archive publication cannot write into the replacement root', async t => {
  let replaced = false, moved;
  const f = fixture(t, { writeExclusive(file, bytes) {
    writeFileSync(file, bytes, { flag: 'wx' });
    if (!replaced) {
      replaced = true; moved = f.root + '-moved'; renameSync(f.root, moved); mkdirSync(f.root);
    }
  } }), old = seedLegacy(f);
  t.after(() => { if (moved) rmSync(moved, { recursive: true, force: true }); });
  await assert.rejects(f.store.initialize(), unavailable);
  assert.deepEqual(readdirSync(f.root), []);
  assert.deepEqual(readFileSync(join(moved, 'catalog.json')), old.headRaw);
  assert.deepEqual(readFileSync(join(moved, 'catalog.previous.json')), old.previousRaw);
});

test('version dispatch remains strict for reserved B2 maps and malformed migration event history', async t => {
  const f = fixture(t); seedLegacy(f); const current = await f.store.initialize();
  const variants = [
    value => { value.schemaVersion = 4; },
    value => { value.candidates[uid('ab')] = { arbitrary: true }; },
    value => { value.approvals[uid('aa')] = { arbitrary: true }; },
    value => { value.selections[uid('as')] = { arbitrary: true }; },
    value => { delete value.migrations; },
    value => { value.events.at(-1).projectId = Object.keys(value.projects)[0]; },
    value => { value.events.at(-1).entityDigest = '0'.repeat(64); },
    value => { Object.values(value.migrations)[0].fromGenerationId = value.generationId; },
    value => { Object.values(value.migrations)[0].fromRevision--; },
  ];
  for (const alter of variants) {
    const value = clone(current); alter(value);
    assert.throws(() => validateAcceptanceCatalog(value), unavailable);
  }
});
