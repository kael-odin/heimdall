import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as schema from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';

const at = '2026-10-17T00:00:00.000Z';
const headSha256 = 'a'.repeat(64), previousSha256 = 'b'.repeat(64);
const uid = prefix => `${prefix}-${randomUUID()}`;
const copy = value => JSON.parse(JSON.stringify(value));
const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };
const upgrade = (value, options = {}) => schema.buildCatalogMigrationV3(value, { headSha256, previousSha256, at, ...options });
const reject = value => assert.throws(() => schema.validateAcceptanceCatalog(value), unavailable);

function empty(version = 2) {
  return { schemaVersion: version, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {},
    candidates: {}, approvals: {}, selections: {}, migrations: {}, events: [], ...(version === 3 ? { browserSourceBindings: {} } : {}) };
}
function add(catalog, map, entity, kind, projectId) {
  const entityId = entity.id ?? entity.runId;
  catalog[map][entityId] = entity;
  catalog.events.push({ id: uid('ae'), revision: ++catalog.revision, kind, ...(projectId ? { projectId } : {}),
    entityId, entityDigest: hashAcceptanceValue(entity), at: entity.createdAt ?? entity.boundAt ?? entity.approvedAt ?? entity.selectedAt,
    actor: { kind: 'local-operator' } });
  return entity;
}
function organization(catalog) {
  const project = add(catalog, 'projects', { id: uid('ap'), name: '迁移保留完整需求历史', createdAt: at }, 'project-created');
  catalog.events.at(-1).projectId = project.id;
  const release = add(catalog, 'releases', { id: uid('ar'), projectId: project.id, label: '已有版本',
    targetUrl: 'http://example.test/source?tenant=1', createdAt: at }, 'release-created', project.id);
  const binding = add(catalog, 'runBindings', { runId: uid('ac'), projectId: project.id, releaseId: release.id,
    boundAt: at, actor: { kind: 'local-operator' } }, 'run-bound', project.id);
  return { project, release, binding };
}
function withSpecHistory(catalog) {
  const project = Object.values(catalog.projects)[0], binding = Object.values(catalog.runBindings)[0];
  const approvals = [];
  for (const marker of ['1', '2']) {
    const projection = { projectId: project.id, mode: 'spec', projectionVersion: 1,
      source: { runId: binding.runId, sourceMode: 'spec', side: 'source', releaseId: binding.releaseId },
      ...Object.fromEntries(['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'scopeKey', 'ruleManifestKey',
        'oracleManifestKey', 'environmentKey', 'verifierFingerprint'].map(key => [key, marker.repeat(64)])) };
    const candidate = add(catalog, 'candidates', { id: uid('ab'), ...projection,
      contentDigest: hashAcceptanceValue(projection), createdAt: at }, 'candidate-created', project.id);
    approvals.push(add(catalog, 'approvals', { id: uid('aa'), projectId: project.id, candidateId: candidate.id,
      contentDigest: candidate.contentDigest, reason: '保留人工复核理由', approvedAt: at,
      actor: { kind: 'local-operator' } }, 'baseline-approved', project.id));
  }
  let previousSelectionId = null;
  for (const approval of [approvals[0], approvals[1], null, approvals[0]]) {
    const selection = add(catalog, 'selections', { id: uid('as'), projectId: project.id, mode: 'spec',
      approvalId: approval?.id ?? null, previousSelectionId, reason: '有序选用、取消和重新选用', selectedAt: at,
      actor: { kind: 'local-operator' } }, 'baseline-selected', project.id);
    previousSelectionId = selection.id;
  }
  schema.validateAcceptanceCatalog(catalog);
  return catalog;
}
function nativeV2({ spec = false } = {}) {
  const catalog = empty(); organization(catalog);
  return spec ? withSpecHistory(catalog) : catalog;
}
function migratedV2({ spec = false } = {}) {
  const legacy = { schemaVersion: 1, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {}, events: [] };
  organization(legacy);
  const catalog = schema.buildCatalogMigration(legacy, { headSha256: 'c'.repeat(64), previousSha256: null, at });
  return spec ? withSpecHistory(catalog) : catalog;
}
function rehashMigrations(catalog) {
  for (const event of catalog.events) if (event.kind === 'catalog-migrated' && catalog.migrations[event.entityId]) {
    event.entityDigest = hashAcceptanceValue(catalog.migrations[event.entityId]);
  }
}
function reindexMigrations(catalog) {
  catalog.events.forEach((event, index) => {
    event.revision = index + 1;
    if (event.kind === 'catalog-migrated') catalog.migrations[event.entityId].fromRevision = index;
  });
  rehashMigrations(catalog);
}

test('fresh V3 requires its exact empty Browser reservation and still validates ordinary history', () => {
  const catalog = empty(3);
  assert.equal(schema.validateAcceptanceCatalogV3(catalog), catalog);
  assert.equal(schema.validateAcceptanceCatalog(catalog), catalog);
  organization(catalog); withSpecHistory(catalog);
  assert.deepEqual(catalog.browserSourceBindings, {});
  assert.deepEqual(catalog.migrations, {});
  schema.validateAcceptanceCatalogV3(catalog);
  const nullMap = empty(3); nullMap.browserSourceBindings = Object.create(null);
  schema.validateAcceptanceCatalogV3(nullMap);
});

test('V1 and V2 stay independently strict when V3 fields or transitions are supplied', () => {
  const old = nativeV2();
  for (const validate of [schema.validateAcceptanceCatalog, schema.validateAcceptanceCatalogV2]) {
    assert.throws(() => validate({ ...old, browserSourceBindings: {} }), unavailable);
  }
  assert.throws(() => schema.validateAcceptanceCatalogV1(empty(3)), unavailable);
  assert.throws(() => schema.validateAcceptanceCatalogV2(empty(3)), unavailable);
  assert.throws(() => schema.validateAcceptanceCatalogV3(old), unavailable);
  const extraMigration = migratedV2(), migration = copy(Object.values(extraMigration.migrations)[0]);
  migration.id = uid('am'); migration.fromGenerationId = uid('ag');
  migration.fromRevision = extraMigration.revision;
  add(extraMigration, 'migrations', migration, 'catalog-migrated');
  assert.throws(() => schema.validateAcceptanceCatalogV2(extraMigration, { limits: { migrations: 10 } }), unavailable);
  const unsupported = migratedV2(); Object.values(unsupported.migrations)[0].toSchemaVersion = 3;
  rehashMigrations(unsupported); reject(unsupported);
});

test('V2 to V3 appends one migration without changing any complete Spec entity, digest or event', () => {
  for (const old of [nativeV2({ spec: true }), migratedV2({ spec: true })]) {
    const saved = copy(old), value = upgrade(old), projectId = Object.keys(old.projects)[0];
    assert.deepEqual(old, saved);
    assert.notEqual(value, old); assert.equal(value.schemaVersion, 3);
    assert.notEqual(value.generationId, old.generationId); assert.equal(value.revision, old.revision + 1);
    assert.deepEqual(value.browserSourceBindings, {});
    for (const map of ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections']) {
      assert.deepEqual(value[map], old[map]); assert.notEqual(value[map], old[map]);
      for (const key of Object.keys(old[map])) {
        assert.equal(hashAcceptanceValue(value[map][key]), hashAcceptanceValue(old[map][key]));
        assert.notEqual(value[map][key], old[map][key]);
      }
    }
    for (const [key, migration] of Object.entries(old.migrations)) assert.deepEqual(value.migrations[key], migration);
    assert.deepEqual(value.events.slice(0, old.revision), old.events);
    assert.deepEqual(schema.currentSelectionsOf(value, projectId), schema.currentSelectionsOf(old, projectId));
    const event = value.events.at(-1), migration = value.migrations[event.entityId];
    assert.deepEqual(Object.keys(migration).sort(), ['id', 'fromSchemaVersion', 'toSchemaVersion', 'fromGenerationId', 'fromRevision',
      'sourceHeadSha256', 'sourcePreviousSha256', 'createdAt', 'actor'].sort());
    assert.equal(migration.fromSchemaVersion, 2); assert.equal(migration.toSchemaVersion, 3);
    assert.equal(migration.fromGenerationId, old.generationId); assert.equal(migration.fromRevision, old.revision);
    assert.equal(migration.sourceHeadSha256, headSha256); assert.equal(migration.sourcePreviousSha256, previousSha256);
    assert.equal(event.entityDigest, hashAcceptanceValue(migration)); assert.equal(event.revision, value.revision);
    assert.equal(Object.hasOwn(event, 'projectId'), false);
    schema.validateAcceptanceCatalogV3(value);
  }
});

test('two-step V1 to V2 to V3 retains the old migration and has three distinct generations', () => {
  const second = migratedV2(), firstMigration = copy(Object.values(second.migrations)[0]);
  const value = upgrade(second, { previousSha256: null });
  const ordered = value.events.filter(event => event.kind === 'catalog-migrated').map(event => value.migrations[event.entityId]);
  assert.deepEqual(ordered[0], firstMigration);
  assert.deepEqual(ordered.map(item => [item.fromSchemaVersion, item.toSchemaVersion]), [[1, 2], [2, 3]]);
  assert.equal(new Set([...ordered.map(item => item.fromGenerationId), value.generationId]).size, 3);
  assert.equal(ordered[1].sourcePreviousSha256, null);
  assert.equal(Object.keys(value.migrations).length, 2);
});

test('V3 rejects every unsupported Browser map shape, entry and event without invoking accessors', () => {
  for (const value of [null, [], '', true, { bogus: {} }, JSON.parse('{"__proto__":{}}'), Object.create({ inherited: true })]) {
    const catalog = empty(3); catalog.browserSourceBindings = value; reject(catalog);
  }
  const missing = empty(3); delete missing.browserSourceBindings; reject(missing);
  const extra = empty(3); extra.browserCandidates = {}; reject(extra);
  let reads = 0;
  const rootGetter = empty(3);
  Object.defineProperty(rootGetter, 'browserSourceBindings', { enumerable: true, get() { reads++; return {}; } }); reject(rootGetter);
  const entryGetter = empty(3);
  Object.defineProperty(entryGetter.browserSourceBindings, uid('ac'), { enumerable: true, get() { reads++; return {}; } }); reject(entryGetter);
  const hidden = empty(3); Object.defineProperty(hidden.browserSourceBindings, 'hidden', { value: {}, enumerable: false }); reject(hidden);
  const symbol = empty(3); symbol.browserSourceBindings[Symbol('binding')] = {}; reject(symbol);
  const proxy = empty(3); proxy.browserSourceBindings = new Proxy({}, {
    ownKeys() { reads++; throw new Error('trap'); }, getPrototypeOf() { reads++; throw new Error('trap'); },
  }); reject(proxy);
  assert.equal(reads, 0);
  const unsupportedEvent = empty(3); organization(unsupportedEvent);
  unsupportedEvent.events.at(-1).kind = 'browser-source-bound'; reject(unsupportedEvent);
});

test('V3 migration chain rejects missing, duplicate, skipped, reversed and incomplete stages', () => {
  const old = migratedV2(), incomplete = { ...copy(old), schemaVersion: 3, generationId: uid('ag'), browserSourceBindings: {} };
  reject(incomplete);
  for (const mutate of [
    catalog => { Object.values(catalog.migrations).find(item => item.toSchemaVersion === 3).fromSchemaVersion = 1; },
    catalog => { Object.values(catalog.migrations).find(item => item.toSchemaVersion === 3).toSchemaVersion = 4; },
    catalog => { Object.values(catalog.migrations).find(item => item.fromSchemaVersion === 1).fromSchemaVersion = 2; },
    catalog => { Object.values(catalog.migrations).find(item => item.fromSchemaVersion === 1).toSchemaVersion = 3; },
    catalog => {
      const events = catalog.events.filter(event => event.kind === 'catalog-migrated');
      const first = catalog.events.indexOf(events[0]), second = catalog.events.indexOf(events[1]);
      [catalog.events[first], catalog.events[second]] = [catalog.events[second], catalog.events[first]];
      reindexMigrations(catalog);
    },
    catalog => { delete catalog.migrations[catalog.events.at(-1).entityId]; },
    catalog => { catalog.events.pop(); catalog.revision--; },
  ]) {
    const catalog = upgrade(old); mutate(catalog); rehashMigrations(catalog); reject(catalog);
  }
});

test('V3 migration generation cannot reuse current, source or intermediate identities even after rehash', () => {
  for (const mutate of [
    (value, chain) => { chain[0].fromGenerationId = value.generationId; },
    (value, chain) => { chain[1].fromGenerationId = value.generationId; },
    (_value, chain) => { chain[1].fromGenerationId = chain[0].fromGenerationId; },
    (value, chain) => { value.generationId = chain[0].fromGenerationId; },
  ]) {
    const catalog = upgrade(migratedV2()), chain = Object.values(catalog.migrations);
    mutate(catalog, chain); rehashMigrations(catalog); reject(catalog);
  }
});

test('only the 2 to 3 step may follow Spec history; later Spec events remain valid', () => {
  const before = upgrade(migratedV2()); withSpecHistory(before); schema.validateAcceptanceCatalogV3(before);
  const after = upgrade(migratedV2({ spec: true })); schema.validateAcceptanceCatalogV3(after);
  const misplaced = copy(after), firstIndex = misplaced.events.findIndex(event => event.kind === 'catalog-migrated');
  const [first] = misplaced.events.splice(firstIndex, 1);
  misplaced.events.splice(misplaced.events.length - 1, 0, first);
  reindexMigrations(misplaced); reject(misplaced);
});

test('V3 validates migration facts and exact global events even when event digests are recalculated', () => {
  const badValues = [null, [], {}, true, '2', 1n, Symbol('version')];
  for (const field of ['fromSchemaVersion', 'toSchemaVersion', 'fromRevision', 'sourceHeadSha256', 'sourcePreviousSha256']) {
    for (const badValue of badValues) {
      if (field === 'sourcePreviousSha256' && badValue === null) continue;
      const catalog = upgrade(nativeV2()), migration = Object.values(catalog.migrations)[0];
      migration[field] = badValue;
      // Unsupported in-memory scalar shapes must fail before digest traversal.
      assert.throws(() => schema.validateAcceptanceCatalogV3(catalog), unavailable);
    }
  }
  for (const mutate of [
    (catalog, migration) => { migration.fromRevision--; },
    (_catalog, migration) => { migration.actor.note = 'unsupported'; },
    (_catalog, migration) => { migration.createdAt = 'yesterday'; },
    (_catalog, migration) => { delete migration.sourcePreviousSha256; },
    catalog => { catalog.events.at(-1).projectId = Object.keys(catalog.projects)[0]; },
    catalog => { catalog.events.at(-1).at = '2026-10-17T00:00:01.000Z'; },
    catalog => { catalog.events.at(-1).revision--; },
  ]) {
    const catalog = upgrade(nativeV2()), migration = Object.values(catalog.migrations)[0];
    mutate(catalog, migration); rehashMigrations(catalog); reject(catalog);
  }
});

test('V3 constructor accepts only strict V2 and valid byte-hash/time metadata without changing inputs', () => {
  for (const catalog of [null, {}, empty(3), { ...nativeV2(), browserSourceBindings: {} }]) {
    assert.throws(() => upgrade(catalog), unavailable);
  }
  const old = nativeV2({ spec: true }), saved = copy(old);
  for (const options of [
    { headSha256: null }, { headSha256: [headSha256] }, { headSha256: Symbol('hash') },
    { previousSha256: [previousSha256] }, { previousSha256: 'bad' }, { at: 'yesterday' },
  ]) {
    assert.throws(() => upgrade(old, options), { code: 'INVALID_INPUT', status: 400 });
    assert.deepEqual(old, saved);
  }
});

test('V3 rejects unsafe migration containers and scalar coercion without invoking user code', () => {
  let reads = 0;
  const unsafe = () => new Proxy({}, { get() { reads++; throw new Error('trap'); },
    ownKeys() { reads++; throw new Error('trap'); }, getPrototypeOf() { reads++; throw new Error('trap'); } });
  const mapProxy = upgrade(nativeV2()); mapProxy.migrations = unsafe(); reject(mapProxy);
  const recordProxy = upgrade(nativeV2()); recordProxy.migrations[Object.keys(recordProxy.migrations)[0]] = unsafe(); reject(recordProxy);
  const getter = upgrade(nativeV2()), migration = Object.values(getter.migrations)[0];
  Object.defineProperty(migration, 'fromSchemaVersion', { enumerable: true, get() { reads++; return 2; } }); reject(getter);
  const coercion = upgrade(nativeV2());
  Object.values(coercion.migrations)[0].fromSchemaVersion = { [Symbol.toPrimitive]() { reads++; throw new Error('coercion'); } };
  reject(coercion);
  assert.equal(reads, 0);
});

test('V3 construction enforces migration, event and byte capacities before returning a value', () => {
  const old = migratedV2({ spec: true }), saved = copy(old);
  for (const limits of [{ migrations: 1 }, { events: old.revision }, { jsonBytes: 1 }]) {
    assert.throws(() => upgrade(old, { limits }), { code: 'CATALOG_CAPACITY', status: 409 });
    assert.deepEqual(old, saved);
  }
  const native = nativeV2();
  schema.validateAcceptanceCatalogV3(upgrade(native, { limits: { migrations: 1, browserSourceBindings: 0 } }));
  for (const limits of [{ browserSourceBindings: -1 }, { browserSourceBindings: 0.5 }, { other: 2 }]) {
    assert.throws(() => upgrade(native, { limits }), TypeError);
  }
});
