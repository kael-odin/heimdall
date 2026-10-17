import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync, linkSync, mkdirSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { buildCatalogMigration, buildCatalogMigrationV3, buildCatalogMigrationV4 } from '../src/acceptance/catalog-schema.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';

const uid = prefix => prefix + '-' + randomUUID();
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };
function native(version) {
  return { schemaVersion: version, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {},
    ...(version >= 2 ? { candidates: {}, approvals: {}, selections: {}, migrations: {} } : {}),
    ...(version >= 3 ? { browserSourceBindings: {} } : {}), ...(version >= 4 ? { browserCandidates: {} } : {}), events: [] };
}
function fixture(t, options = {}) {
  const owner = acquireAcceptanceOwner({ root: mkdtempSync(join(tmpdir(), 'heimdall-explicit-catalog-')) }), root = owner.root;
  t.after(() => { owner.release(); rmSync(root, { recursive: true, force: true }); });
  return { root, owner, store: createAcceptanceCatalogStore({ root, owner, ...options }) };
}
function seed(f, value, previous = null) {
  const raw = Buffer.isBuffer(value) ? value : encode(value);
  writeFileSync(join(f.root, 'catalog.json'), raw);
  if (previous) writeFileSync(join(f.root, 'catalog.previous.json'), Buffer.isBuffer(previous) ? previous : encode(previous));
  return raw;
}
const archiveName = bytes => 'catalog.v' + JSON.parse(bytes).schemaVersion + '.' + sha(bytes) + '.json';
function facts(f) {
  return Object.fromEntries(readdirSync(f.root).filter(name => name !== '.acceptance-owner.json').sort().map(name => {
    const path = join(f.root, name), stat = lstatSync(path, { bigint: true });
    return [name, { bytes: stat.isFile() ? readFileSync(path) : null, ino: stat.ino, nlink: stat.nlink, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }];
  }));
}
const confirm = preview => ({ targetSchemaVersion: 4, expectedGenerationId: preview.source.generationId,
  expectedRevision: preview.source.revision, expectedHeadSha256: preview.source.headSha256,
  expectedPreviousSha256: preview.source.previousSha256, expectedPlanDigest: preview.planDigest });
const migrate = async store => store.applyMigration(confirm(await store.previewMigration({ targetSchemaVersion: 4 })));

test('whole-chain root entry capacity reserves new preimages, a missing previous file and one publication temporary', async t => {
  for (const scene of [
    { version: 3, entries: 4093, newEntries: 2, accepted: true },
    { version: 3, entries: 4094, newEntries: 2, accepted: false },
    { version: 3, entries: 4095, newEntries: 2, accepted: false },
    { version: 3, entries: 4096, newEntries: 2, accepted: false },
    { version: 1, entries: 4092, newEntries: 4, accepted: false },
    { version: 3, entries: 4095, newEntries: 0, previousAndArchive: true, accepted: true },
    { version: 4, entries: 4096, newEntries: 0, accepted: true },
  ]) await t.test(JSON.stringify(scene), async t => {
    const f = fixture(t), raw = seed(f, native(scene.version));
    if (scene.previousAndArchive) {
      writeFileSync(join(f.root, 'catalog.previous.json'), raw);
      writeFileSync(join(f.root, archiveName(raw)), raw);
    }
    for (let count = readdirSync(f.root).length; count < scene.entries; count++) mkdirSync(join(f.root, 'unrelated-' + count));
    const before = facts(f);
    if (!scene.accepted) {
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.store.previewMigration({ targetSchemaVersion: 4 }),
        { ...unavailable, details: { reason: 'MIGRATION_ROOT_ENTRY_CAPACITY' } });
      assert.deepEqual(facts(f), before);
      return;
    }
    const preview = await f.store.previewMigration({ targetSchemaVersion: 4 });
    assert.deepEqual(preview.capacity.rootEntries, { currentCount: scene.entries, requiredNewCount: scene.newEntries,
      temporaryEntries: scene.version === 4 ? 0 : 1, projectedFinalCount: scene.entries + scene.newEntries, maximumCount: 4096 });
    assert.deepEqual(facts(f), before);
    assert.equal((await f.store.applyMigration(confirm(preview))).catalog.schemaVersion, 4);
    assert.equal(readdirSync(f.root).length, scene.entries + scene.newEntries);
    if (scene.version === 4) assert.deepEqual(facts(f), before);
  });
});

test('unrelated root entries changed since preview invalidate apply before any migration publication', async t => {
  const f = fixture(t); seed(f, native(3));
  const preview = await f.store.previewMigration({ targetSchemaVersion: 4 });
  mkdirSync(join(f.root, 'new-unrelated-entry'));
  const before = facts(f);
  await assert.rejects(f.store.applyMigration(confirm(preview)), { code: 'STALE_REVISION', status: 409 });
  assert.deepEqual(facts(f), before);
});

test('empty creation explicitly chooses 3 or 4; existing opens never migrate or change metadata bytes/stat', async t => {
  for (const version of [3, 4]) await t.test('v' + version, async t => {
    const f = fixture(t);
    await assert.rejects(f.store.initialize(), { ...unavailable, details: { reason: 'CREATION_SCHEMA_REQUIRED' } });
    assert.deepEqual(Object.keys(facts(f)), []);
    const current = await f.store.initialize({ createSchemaVersion: version }), before = facts(f);
    assert.equal(current.schemaVersion, version); assert.equal(current.revision, 0); assert.deepEqual(current.migrations, {});
    for (const options of [undefined, { createSchemaVersion: 3 }, { createSchemaVersion: 4 }]) assert.deepEqual(await f.store.initialize(options), current);
    assert.deepEqual(await createAcceptanceCatalogStore({ root: f.root, owner: f.owner }).initialize(), current); assert.deepEqual(facts(f), before);
    const result = await f.store.createProject({ expectedGenerationId: current.generationId, expectedRevision: 0, name: '原写合同仍可用' });
    assert.equal(result.revision, 1); assert.equal(f.store.read().schemaVersion, version);
  });
});

test('legacy ordinary opens refuse migration even when a create format is supplied, preserving the scene', async t => {
  for (const version of [1, 2]) await t.test('v' + version, async t => {
    const f = fixture(t), value = native(version); seed(f, value); const before = facts(f);
    for (const options of [undefined, { createSchemaVersion: 3 }, { createSchemaVersion: 4 }]) await assert.rejects(f.store.initialize(options), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
    assert.throws(() => f.store.read(), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
    await assert.rejects(f.store.createProject({ expectedGenerationId: value.generationId, expectedRevision: 0, name: '旧写入口' }), unavailable);
    assert.deepEqual(facts(f), before);
  });
});

test('strict initialize options cannot overwrite missing-head recovery material', async t => {
  const f = fixture(t);
  for (const input of [null, [], { createSchemaVersion: 1 }, { createSchemaVersion: '4' }, { other: 4 }, Object.defineProperty({}, 'createSchemaVersion', { get() { throw Error('getter'); }, enumerable: true })]) await assert.rejects(f.store.initialize(input), { code: 'INVALID_INPUT', status: 400 });
  for (const name of ['catalog.previous.json', 'catalog.json.crashed.tmp', 'catalog.v3.' + '0'.repeat(64) + '.json']) {
    const other = fixture(t); writeFileSync(join(other.root, name), '{original opaque recovery'); const before = facts(other);
    await assert.rejects(other.store.initialize({ createSchemaVersion: 4 }), { ...unavailable, details: { reason: 'MISSING_CATALOG_WITH_RECOVERY_MATERIAL' } }); assert.deepEqual(facts(other), before);
  }
});

test('deterministic metadata previews and explicit legacy chains preserve exact preimages and retire generations', async t => {
  for (const version of [1, 2, 3]) for (const prior of ['none', 'same', 'compact']) await t.test('v' + version + '/' + prior, async t => {
    const f = fixture(t), value = native(version), raw = encode(value), previous = prior === 'none' ? null : prior === 'same' ? raw : Buffer.from(JSON.stringify(value));
    seed(f, raw, previous); mkdirSync(join(f.root, uid('ac'))); const before = facts(f);
    const preview = await f.store.previewMigration({ targetSchemaVersion: 4 }); assert.deepEqual(await f.store.previewMigration({ targetSchemaVersion: 4 }), preview); assert.deepEqual(facts(f), before);
    assert.equal(preview.executionReady, false); assert.equal(preview.source.headSha256, sha(raw)); assert.equal(preview.source.previousSha256, previous ? sha(previous) : null);
    assert.deepEqual(preview.steps.map(step => [step.fromSchemaVersion, step.toSchemaVersion]), Array.from({ length: 4 - version }, (_, i) => [version + i, version + i + 1])); assert.equal(JSON.stringify(preview).includes('targetUrl'), false);
    const applied = await f.store.applyMigration(confirm(preview)), current = applied.catalog;
    assert.equal(current.schemaVersion, 4); assert.equal(current.revision, 4 - version); assert.equal(applied.completedSteps.length, 4 - version); assert.equal(applied.executionReady, false);
    assert.equal(readFileSync(join(f.root, 'catalog.json')).length, preview.capacity.finalJsonBytes); assert.deepEqual(current.browserCandidates, {});
    const generations = [value.generationId, ...applied.completedSteps.map(step => step.generationId)]; assert.equal(new Set(generations).size, generations.length);
    for (const bytes of [raw, previous].filter(Boolean)) assert.deepEqual(readFileSync(join(f.root, archiveName(bytes))), bytes);
    for (const [index, event] of current.events.entries()) {
      const migration = current.migrations[event.entityId], source = readFileSync(join(f.root, 'catalog.v' + migration.fromSchemaVersion + '.' + migration.sourceHeadSha256 + '.json'));
      assert.equal(sha(source), migration.sourceHeadSha256); assert.equal(migration.fromGenerationId, generations[index]); assert.equal(migration.fromRevision, index); assert.equal(migration.toSchemaVersion, migration.fromSchemaVersion + 1);
    }
    validateAcceptanceCatalog(current); const final = facts(f); assert.deepEqual(await f.store.initialize(), current); assert.deepEqual(facts(f), final);
    await assert.rejects(f.store.applyMigration(confirm(preview)), { code: 'STALE_REVISION', status: 409 });
    const noop = await migrate(f.store); assert.equal(noop.changed, false); assert.deepEqual(noop.completedSteps, []); assert.deepEqual(facts(f), final);
  });
});

test('genuine owner brand rejects method-shaped owners and proxies before reflection', async t => {
  const f = fixture(t); seed(f, native(3)); const preview = await f.store.previewMigration({ targetSchemaVersion: 4 }); let traps = 0;
  for (const owner of [null, undefined, { root: f.root, assertOwned() { traps++; } }, { ...f.owner }, new Proxy(f.owner, { get() { traps++; throw Error('trap'); } })]) {
    const store = createAcceptanceCatalogStore({ root: f.root, owner });
    await assert.rejects(store.previewMigration({ targetSchemaVersion: 4 }), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE', status: 503 }); await assert.rejects(store.applyMigration(confirm(preview)), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE', status: 503 });
  }
  assert.equal(traps, 0); f.owner.release(); await assert.rejects(f.store.previewMigration({ targetSchemaVersion: 4 }), { code: 'ACCEPTANCE_OWNER_LOST', status: 503 });
});

test('maintenance fields, versions, digests and descriptors are strict without preparation', async t => {
  const f = fixture(t); seed(f, native(3)); const preview = await f.store.previewMigration({ targetSchemaVersion: 4 }), input = confirm(preview), before = facts(f);
  for (const value of [{}, { targetSchemaVersion: 3 }, { targetSchemaVersion: '4' }, { targetSchemaVersion: 4, extra: true }, new Proxy({}, {})]) await assert.rejects(f.store.previewMigration(value), { code: 'INVALID_INPUT', status: 400 });
  for (const change of [v => { delete v.expectedPreviousSha256; }, v => { v.actor = {}; }, v => { v.expectedRevision = '0'; }, v => { v.expectedRevision = Number.MAX_SAFE_INTEGER + 1; }, v => { v.expectedHeadSha256 = 'A'.repeat(64); }, v => { v.expectedPreviousSha256 = ''; }, v => { v.targetSchemaVersion = 3; }, v => { v.expectedPlanDigest = 'bad'; }, v => { Object.defineProperty(v, 'expectedGenerationId', { get() { throw Error('getter'); }, enumerable: true }); }]) {
    const value = { ...input }; change(value); await assert.rejects(f.store.applyMigration(value), { code: 'INVALID_INPUT', status: 400 });
  }
  assert.deepEqual(facts(f), before);
});

test('generation, revision, head/previous bytes, plan and preimage inventory all fence stale applies', async t => {
  for (const kind of ['generation', 'revision', 'head-hash', 'previous-hash', 'plan', 'head-bytes', 'previous-bytes', 'inventory']) await t.test(kind, async t => {
    const f = fixture(t), raw = encode(native(3)); seed(f, raw, raw); const input = confirm(await f.store.previewMigration({ targetSchemaVersion: 4 }));
    if (kind === 'generation') input.expectedGenerationId = uid('ag'); if (kind === 'revision') input.expectedRevision++;
    if (kind === 'head-hash') input.expectedHeadSha256 = '0'.repeat(64); if (kind === 'previous-hash') input.expectedPreviousSha256 = null; if (kind === 'plan') input.expectedPlanDigest = '0'.repeat(64);
    if (kind === 'head-bytes') writeFileSync(join(f.root, 'catalog.json'), Buffer.concat([raw, Buffer.from(' ')])); if (kind === 'previous-bytes') writeFileSync(join(f.root, 'catalog.previous.json'), Buffer.concat([raw, Buffer.from(' ')]));
    if (kind === 'inventory') { const other = encode(native(1)); writeFileSync(join(f.root, archiveName(other)), other); }
    const before = facts(f); await assert.rejects(f.store.applyMigration(input), { code: 'STALE_REVISION', status: 409 }); assert.deepEqual(facts(f), before);
  });
});

test('the shared queue consumes a confirmation once', async t => {
  const f = fixture(t); seed(f, native(3)); const input = confirm(await f.store.previewMigration({ targetSchemaVersion: 4 })); const results = await Promise.allSettled([f.store.applyMigration(input), f.store.applyMigration(input)]);
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1); assert.equal(results.find(v => v.status === 'rejected').reason.code, 'STALE_REVISION'); assert.equal(f.store.read().revision, 1);
});

test('whole-chain event, migration and JSON budgets fail before preparing any file', async t => {
  const value = native(1), raw = encode(value), v2 = buildCatalogMigration(value, { headSha256: sha(raw) }), v2raw = encode(v2), v3 = buildCatalogMigrationV3(v2, { headSha256: sha(v2raw), previousSha256: sha(raw) }), v3raw = encode(v3), v4 = buildCatalogMigrationV4(v3, { headSha256: sha(v3raw), previousSha256: sha(v2raw) });
  for (const limits of [{ events: 2 }, { migrations: 2 }, { jsonBytes: encode(v4).length - 1 }]) {
    const f = fixture(t, { limits }); seed(f, raw); const before = facts(f);
    await assert.rejects(f.store.previewMigration({ targetSchemaVersion: 4 }), { code: 'CATALOG_CAPACITY', status: 409, details: { limit: Object.keys(limits)[0] } }); assert.deepEqual(facts(f), before);
    const relaxed = createAcceptanceCatalogStore({ root: f.root, owner: f.owner }); await migrate(relaxed); assert.equal(relaxed.read().schemaVersion, 4);
  }
});

test('each preimage version keeps its own two slots and exact existing bytes/stat are reused', async t => {
  const f = fixture(t), raw = encode(native(3)); seed(f, raw);
  for (const version of [1, 2]) for (let index = 0; index < 2; index++) { const bytes = encode(native(version)); writeFileSync(join(f.root, archiveName(bytes)), bytes); }
  writeFileSync(join(f.root, archiveName(raw)), raw); const original = facts(f)[archiveName(raw)]; await migrate(f.store); assert.deepEqual(facts(f)[archiveName(raw)], original);
  const full = fixture(t); seed(full, native(3)); for (let i = 0; i < 2; i++) { const bytes = encode(native(3)); writeFileSync(join(full.root, archiveName(bytes)), bytes); }
  const before = facts(full); await assert.rejects(full.store.previewMigration({ targetSchemaVersion: 4 }), { ...unavailable, details: { reason: 'MIGRATION_PREIMAGE_CAPACITY' } }); assert.deepEqual(facts(full), before);
});

test('wrong labels/hashes/names, bad JSON, hardlinks and symlinks preserve the original scene', async t => {
  for (const kind of ['label', 'hash', 'unknown', 'invalid-json', 'head-hardlink', 'preimage-hardlink', 'symlink']) await t.test(kind, async t => {
    const f = fixture(t), raw = encode(native(3)); seed(f, raw);
    if (kind === 'label') { const other = encode(native(2)); writeFileSync(join(f.root, 'catalog.v1.' + sha(other) + '.json'), other); }
    if (kind === 'hash') writeFileSync(join(f.root, 'catalog.v3.' + '0'.repeat(64) + '.json'), raw); if (kind === 'unknown') writeFileSync(join(f.root, 'catalog.v5.' + sha(raw) + '.json'), raw);
    if (kind === 'invalid-json') writeFileSync(join(f.root, 'catalog.previous.json'), '{opaque invalid original'); if (kind === 'head-hardlink') linkSync(join(f.root, 'catalog.json'), join(f.root, 'external-link'));
    if (kind === 'preimage-hardlink') { writeFileSync(join(f.root, archiveName(raw)), raw); linkSync(join(f.root, archiveName(raw)), join(f.root, 'external-link')); }
    if (kind === 'symlink') { mkdirSync(join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), join(f.root, 'catalog.previous.json'), process.platform === 'win32' ? 'junction' : 'dir'); }
    const before = facts(f); await assert.rejects(f.store.previewMigration({ targetSchemaVersion: 4 }), unavailable); assert.deepEqual(facts(f), before);
  });
});

test('wrong genuine root and acquisition-time root replacement cannot authorize migration', async t => {
  const f = fixture(t), other = fixture(t); seed(f, native(3)); await assert.rejects(createAcceptanceCatalogStore({ root: f.root, owner: other.owner }).previewMigration({ targetSchemaVersion: 4 }), unavailable);
  const moved = f.root + '-moved'; t.after(() => rmSync(moved, { recursive: true, force: true })); renameSync(f.root, moved); mkdirSync(f.root);
  await assert.rejects(f.store.previewMigration({ targetSchemaVersion: 4 }), { code: 'ACCEPTANCE_OWNER_LOST', status: 503 }); assert.deepEqual(readdirSync(f.root), []);
});
