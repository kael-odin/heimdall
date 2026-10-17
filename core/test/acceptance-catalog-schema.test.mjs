import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as schema from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';

const at = '2026-10-16T00:00:00.000Z', digest = 'a'.repeat(64), previous = 'b'.repeat(64);
const uid = prefix => prefix + '-' + randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
function add(catalog, collection, entity, kind, projectId) {
  catalog[collection][entity.id ?? entity.runId] = entity; catalog.revision++;
  catalog.events.push({ id: uid('ae'), revision: catalog.revision, kind, projectId,
    entityId: entity.id ?? entity.runId, entityDigest: hashAcceptanceValue(entity), at: entity.createdAt ?? entity.boundAt,
    actor: { kind: 'local-operator' } });
}
function v1() {
  const catalog = { schemaVersion: 1, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {}, events: [] };
  const project = { id: uid('ap'), name: 'B1 fixture', createdAt: at };
  const release = { id: uid('ar'), projectId: project.id, label: 'v1', targetUrl: 'http://example.test/app?x=1', createdAt: at };
  const binding = { runId: uid('ac'), projectId: project.id, releaseId: release.id, boundAt: at, actor: { kind: 'local-operator' } };
  add(catalog, 'projects', project, 'project-created', project.id);
  add(catalog, 'releases', release, 'release-created', project.id);
  add(catalog, 'runBindings', binding, 'run-bound', project.id);
  return catalog;
}
const migrate = catalog => schema.buildCatalogMigration(catalog, { headSha256: digest, previousSha256: previous, at });
function rehashMigration(catalog) {
  const event = catalog.events.find(event => event.kind === 'catalog-migrated');
  if (event && catalog.migrations[event.entityId]) event.entityDigest = hashAcceptanceValue(catalog.migrations[event.entityId]);
}
const reject = value => assert.throws(() => schema.validateAcceptanceCatalog(value), { code: 'CATALOG_UNAVAILABLE', status: 503 });

test('exports required helpers and independent schema validators', () => {
  for (const name of ['error', 'invalid', 'unavailable', 'fields', 'id', 'actor', 'url', 'limitsOf', 'capacity', 'plain', 'iso',
    'boundedText', 'validateAcceptanceCatalog', 'validateAcceptanceCatalogV1', 'validateAcceptanceCatalogV2', 'validateAcceptanceCatalogV3',
    'buildCatalogMigration', 'buildCatalogMigrationV3']) assert.equal(typeof schema[name], 'function');
  assert.equal(schema.ACCEPTANCE_CATALOG_LIMITS.migrations, 2);
  assert.equal(schema.ACCEPTANCE_CATALOG_LIMITS.browserSourceBindings, 4096);
  assert.equal(Object.isFrozen(schema.ACCEPTANCE_CATALOG_LIMITS), true);
});
test('v1 remains strict and independent', () => {
  const value = v1(); assert.equal(schema.validateAcceptanceCatalogV1(value), value);
  assert.equal(schema.validateAcceptanceCatalog(value), value);
  reject({ ...value, candidates: {} }); reject({ ...value, schemaVersion: 3 });
  assert.throws(() => schema.validateAcceptanceCatalogV2(value), { code: 'CATALOG_UNAVAILABLE' });
  const bad = copy(value); bad.events[1].entityDigest = '0'.repeat(64); reject(bad);
});
test('schema dispatch rejects malformed roots and proxies without reading accessors', () => {
  for (const value of [null, [], {}, true, 'catalog', { ...v1(), schemaVersion: '1' }, { ...v1(), schemaVersion: 0 }]) reject(value);
  let reads = 0;
  const rootGetter = v1();
  Object.defineProperty(rootGetter, 'schemaVersion', { enumerable: true, get() { reads++; return 1; } }); reject(rootGetter);
  const proxy = new Proxy(v1(), { get() { reads++; throw new Error('getter trap'); }, getPrototypeOf() { reads++; throw new Error('prototype trap'); } });
  reject(proxy); assert.equal(reads, 0);
  const mapProxy = v1(); mapProxy.projects = new Proxy(mapProxy.projects, { ownKeys() { reads++; throw new Error('map trap'); } });
  reject(mapProxy); assert.equal(reads, 0);
  const eventProxy = v1(); eventProxy.events = new Proxy(eventProxy.events, { get() { reads++; throw new Error('event trap'); } });
  reject(eventProxy); assert.equal(reads, 0);
});
test('migration preserves every old entity and event and returns a distinct generation with one global event', () => {
  const old = v1(), saved = copy(old), value = migrate(old);
  assert.deepEqual(old, saved); assert.equal(value.schemaVersion, 2); assert.notEqual(value.generationId, old.generationId);
  assert.equal(value.revision, 4); assert.deepEqual(value.events.slice(0, 3), old.events);
  for (const key of ['projects', 'releases', 'runBindings']) { assert.deepEqual(value[key], old[key]); assert.notEqual(value[key], old[key]); }
  for (const key of ['candidates', 'approvals', 'selections']) assert.deepEqual(value[key], {});
  const [migration] = Object.values(value.migrations), event = value.events.at(-1);
  assert.equal(migration.fromRevision, 3); assert.equal(migration.fromGenerationId, old.generationId);
  assert.equal(migration.sourceHeadSha256, digest); assert.equal(migration.sourcePreviousSha256, previous);
  assert.equal(event.entityDigest, hashAcceptanceValue(migration)); assert.equal(Object.hasOwn(event, 'projectId'), false);
  schema.validateAcceptanceCatalog(value); schema.validateAcceptanceCatalogV2(value);
});
test('fresh schema2 needs no migration and both fresh and migrated catalogs accept later B1 events', () => {
  const fresh = { schemaVersion: 2, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {},
    candidates: {}, approvals: {}, selections: {}, migrations: {}, events: [] };
  schema.validateAcceptanceCatalog(fresh);
  for (const value of [fresh, migrate(v1())]) {
    const project = { id: uid('ap'), name: 'new project', createdAt: at };
    add(value, 'projects', project, 'project-created', project.id); schema.validateAcceptanceCatalog(value);
  }
  const empty = { schemaVersion: 1, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {}, events: [] };
  const migrated = schema.buildCatalogMigration(empty, { headSha256: digest, at });
  assert.equal(migrated.revision, 1); assert.equal(Object.values(migrated.migrations)[0].sourcePreviousSha256, null);
});
test('strict v2 rejects invalid or unsupported migration facts even after their event digest is recalculated', () => {
  const value = migrate(v1());
  for (const mutate of [
    item => { Object.values(item.migrations)[0].fromGenerationId = item.generationId; },
    item => { Object.values(item.migrations)[0].fromRevision = 0; },
    item => { Object.values(item.migrations)[0].fromRevision = '3'; },
    item => { Object.values(item.migrations)[0].sourceHeadSha256 = [digest]; },
    item => { Object.values(item.migrations)[0].sourcePreviousSha256 = [previous]; },
    item => { Object.values(item.migrations)[0].sourceHeadSha256 = 'bad'; },
    item => { Object.values(item.migrations)[0].toSchemaVersion = 3; },
    item => { Object.values(item.migrations)[0].actor.label = 'extra'; },
    item => { delete Object.values(item.migrations)[0].sourcePreviousSha256; },
    item => { item.events.at(-1).projectId = Object.keys(item.projects)[0]; },
    item => { item.events.at(-1).revision--; },
    item => { const migration = copy(Object.values(item.migrations)[0]); migration.id = uid('am'); item.migrations[migration.id] = migration; },
    item => { item.candidates[uid('ab')] = {}; },
    item => { item.approvals[uid('aa')] = {}; },
    item => { item.selections[uid('as')] = {}; },
    item => { item.current = {}; },
    item => { delete item.candidates; },
  ]) { const bad = copy(value); mutate(bad); rehashMigration(bad); reject(bad); }
});
test('migration event cannot move before its B1 prefix or manufacture unsupported events', () => {
  const bad = migrate(v1()), event = bad.events.pop(); bad.events.unshift(event);
  bad.events.forEach((event, index) => { event.revision = index + 1; }); reject(bad);
  const unsupported = migrate(v1()); unsupported.events[0].kind = 'baseline-approved'; reject(unsupported);
  const duplicated = migrate(v1()); duplicated.events[1].entityId = duplicated.events[0].entityId; reject(duplicated);
});
test('all historical B1 entities require one ordered event with current immutable contents', () => {
  for (const base of [v1(), migrate(v1())]) {
    for (const mutate of [
      item => { Object.values(item.projects)[0].name = 'tampered'; },
      item => { item.events[0].revision = 2; },
      item => { item.events[1].id = item.events[0].id; },
      item => { item.events[1].projectId = uid('ap'); },
      item => { item.events[2].entityId = uid('ac'); },
      item => { delete item.releases[Object.keys(item.releases)[0]]; },
      item => { item.revision++; },
      item => { [item.events[0], item.events[1]] = [item.events[1], item.events[0]]; item.events.forEach((event, index) => { event.revision = index + 1; }); },
    ]) { const bad = copy(base); mutate(bad); reject(bad); }
  }
});
test('event digests accept only strings and global migration fields cannot impersonate a project event', () => {
  for (const base of [v1(), migrate(v1())]) {
    for (const value of [[base.events[0].entityDigest], 123, null, {}, true]) {
      const bad = copy(base); bad.events[0].entityDigest = value; reject(bad);
    }
  }
  const global = migrate(v1()); global.events.at(-1).projectId = Object.keys(global.projects)[0]; reject(global);
  const project = v1(); delete project.events[0].projectId; reject(project);
  const unsupported = v1(); unsupported.events[0].kind = 'catalog-migrated'; delete unsupported.events[0].projectId; reject(unsupported);
  const missingMigration = migrate(v1()); missingMigration.migrations = {}; reject(missingMigration);
});
test('getters and unsafe map/array metadata are rejected without execution', () => {
  let calls = 0; const getter = v1();
  Object.defineProperty(getter.projects, uid('ap'), { enumerable: true, get() { calls++; return {}; } }); reject(getter); assert.equal(calls, 0);
  const badEvent = v1(); Object.defineProperty(badEvent.events[0], 'kind', { enumerable: true, get() { calls++; return 'project-created'; } });
  reject(badEvent); assert.equal(calls, 0);
  const extra = v1(); extra.events.extra = true; reject(extra);
  const sparse = v1(); delete sparse.events[0]; reject(sparse);
  const prototype = v1(); prototype.projects = JSON.parse('{"__proto__":{}}'); reject(prototype);
});
test('migration construction rejects invalid input and enforces event, migration and byte budgets before return', () => {
  const old = v1();
  for (const options of [{ headSha256: [digest] }, { headSha256: digest, previousSha256: [previous] },
    { headSha256: digest, at: 'yesterday' }, { headSha256: Symbol('bad') }]) {
    assert.throws(() => schema.buildCatalogMigration(old, options), { code: 'INVALID_INPUT', status: 400 });
  }
  for (const limits of [{ events: old.revision }, { migrations: 0 }, { jsonBytes: 1 }]) {
    assert.throws(() => schema.buildCatalogMigration(old, { headSha256: digest, at, limits }), { code: 'CATALOG_CAPACITY', status: 409 });
  }
  assert.throws(() => migrate(migrate(old)), { code: 'CATALOG_UNAVAILABLE', status: 503 });
});
