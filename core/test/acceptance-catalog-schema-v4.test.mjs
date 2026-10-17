/** Pure catalog metadata validation; no source, report, PNG or browser access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../src/acceptance/catalog-schema.mjs';
import { AT, LATER, uid, copy, independentHash, organizedHash, resealSource, candidateContent,
  empty, append, metadataFixture, rehashEvents } from './fixtures/acceptance-browser-organized-candidate.mjs';

const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };
const headSha256 = 'a'.repeat(64), previousSha256 = 'b'.repeat(64);
const upgrade = (value, options = {}) => schema.buildCatalogMigrationV4(value, { headSha256, previousSha256, at: AT, ...options });
const reject = value => assert.throws(() => schema.validateAcceptanceCatalog(value), unavailable);
const valid = value => assert.equal(schema.validateAcceptanceCatalogV4(value), value);
function resealCandidate(f) {
  f.candidate.sourceContentDigest = f.binding.sourceContentDigest;
  f.candidate.organizationContextDigest = organizedHash('organization-context', { project: f.project, release: f.release, sourceBinding: f.binding });
  f.candidate.contentDigest = organizedHash('content', candidateContent(f.candidate));
  rehashEvents(f.catalog);
}
function specHistory(catalog, project, release) {
  const binding = append(catalog, 'runBindings', { runId: uid('ac', 50), projectId: project.id, releaseId: release.id,
    boundAt: AT, actor: { kind: 'local-operator' } }, 'run-bound', project.id);
  const projection = { projectId: project.id, mode: 'spec', projectionVersion: 1,
    source: { runId: binding.runId, sourceMode: 'spec', side: 'source', releaseId: release.id },
    ...Object.fromEntries(['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'scopeKey',
      'ruleManifestKey', 'oracleManifestKey', 'environmentKey', 'verifierFingerprint'].map(key => [key, 'c'.repeat(64)])) };
  const candidate = append(catalog, 'candidates', { id: uid('ab', 51), ...projection,
    contentDigest: independentHash(projection), createdAt: AT }, 'candidate-created', project.id);
  const approval = append(catalog, 'approvals', { id: uid('aa', 52), projectId: project.id, candidateId: candidate.id,
    contentDigest: candidate.contentDigest, reason: '完整旧Spec批准', approvedAt: AT, actor: { kind: 'local-operator' } }, 'baseline-approved', project.id);
  let previousSelectionId = null;
  for (const [index, approvalId] of [approval.id, null, approval.id].entries()) {
    const selected = append(catalog, 'selections', { id: uid('as', 53 + index), projectId: project.id, mode: 'spec',
      approvalId, previousSelectionId, reason: '保留选用取消及重新选用', selectedAt: AT,
      actor: { kind: 'local-operator' } }, 'baseline-selected', project.id);
    previousSelectionId = selected.id;
  }
}

test('native V4 requires an exact Browser candidate map and retains independent V1/V2/V3 shapes', () => {
  valid(empty()); const f = metadataFixture(); valid(f.catalog);
  assert.deepEqual(f.catalog.runBindings, {}, 'ax and bc do not require legacy run-bound');
  const missing = empty(); delete missing.browserCandidates; reject(missing);
  const extra = empty(); extra.browserApprovals = {}; reject(extra);
  for (const version of [1, 2, 3]) {
    const original = empty(version); schema.validateAcceptanceCatalog(original);
    reject({ ...original, browserCandidates: {} });
    assert.throws(() => schema[`validateAcceptanceCatalogV${version}`](f.catalog), unavailable);
    assert.throws(() => schema.validateAcceptanceCatalogV4(original), unavailable);
  }
  reject({ ...empty(), schemaVersion: 5 });
});

test('V4 permits plain null-prototype metadata containers without weakening strictness', () => {
  const f = metadataFixture();
  for (const key of ['browserCandidates', 'browserSourceBindings']) f.catalog[key] = Object.assign(Object.create(null), f.catalog[key]);
  Object.setPrototypeOf(f.candidate, null); Object.setPrototypeOf(f.candidate.actor, null);
  valid(f.catalog);
});

test('every Browser candidate field is required and exact scalar contracts reject malformed values', () => {
  const original = metadataFixture();
  for (const field of Object.keys(original.candidate)) { const f = metadataFixture(); delete f.candidate[field]; reject(f.catalog); }
  const mutations = { id: uid('ab', 6), candidateContractVersion: '1', mode: 'spec', projectId: uid('ar', 1),
    releaseId: uid('ap', 2), sourceBindingId: uid('ac', 5), sourceContentDigest: 'A'.repeat(64),
    organizationContextDigest: 'not-a-hash', contentDigest: null, createdAt: '2026-10-17' };
  for (const [field, value] of Object.entries(mutations)) { const f = metadataFixture(); f.candidate[field] = value; reject(f.catalog); }
  for (const value of [0, 2, NaN, null, true]) { const f = metadataFixture(); f.candidate.candidateContractVersion = value; reject(f.catalog); }
  for (const field of ['projection', 'source', 'preview', 'plan', 'rules', 'executionReady', 'projectionVersion']) {
    const f = metadataFixture(); f.candidate[field] = {}; reject(f.catalog);
  }
  const wrongKey = copy(original); wrongKey.catalog.browserCandidates[uid('bc', 100)] = wrongKey.candidate;
  delete wrongKey.catalog.browserCandidates[original.candidate.id]; reject(wrongKey.catalog);
});

test('unsafe maps, candidates and actors fail before any user code runs', () => {
  let calls = 0;
  const proxy = () => new Proxy({}, { ownKeys() { calls++; throw new Error('trap'); }, getPrototypeOf() { calls++; throw new Error('trap'); } });
  for (const target of ['root', 'map', 'candidate', 'actor']) for (const kind of ['proxy', 'accessor', 'symbol', 'hidden', 'prototype']) {
    const f = metadataFixture();
    const object = { root: f.catalog, map: f.catalog.browserCandidates, candidate: f.candidate, actor: f.candidate.actor }[target];
    if (kind === 'proxy') {
      if (target === 'root') { reject(proxy()); continue; }
      if (target === 'map') f.catalog.browserCandidates = proxy();
      if (target === 'candidate') f.catalog.browserCandidates[f.candidate.id] = proxy();
      if (target === 'actor') f.candidate.actor = proxy();
    } else if (kind === 'accessor') {
      const key = target === 'root' ? 'browserCandidates' : target === 'map' ? f.candidate.id : target === 'candidate' ? 'contentDigest' : 'kind';
      Object.defineProperty(object, key, { enumerable: true, get() { calls++; return 'injected'; } });
    } else if (kind === 'symbol') object[Symbol('injected')] = 1;
    else if (kind === 'hidden') Object.defineProperty(object, 'injected', { value: 1 });
    else Object.setPrototypeOf(object, { injected: 1 });
    reject(f.catalog);
  }
  for (const value of [null, [], '', true, { bogus: {} }]) { const f = metadataFixture(); f.catalog.browserCandidates = value; reject(f.catalog); }
  for (const actor of [{ kind: 'other' }, { kind: 'local-operator', extra: true }, null, []]) { const f = metadataFixture(); f.candidate.actor = actor; reject(f.catalog); }
  assert.equal(calls, 0);
});

test('references, three digest layers and source binding uniqueness stay strict after event rehash', () => {
  for (const change of [f => { f.candidate.projectId = uid('ap', 999); }, f => { f.candidate.releaseId = uid('ar', 999); },
    f => { f.candidate.sourceBindingId = uid('ax', 999); }, f => { f.candidate.sourceContentDigest = 'a'.repeat(64); },
    f => { f.candidate.organizationContextDigest = 'b'.repeat(64); }, f => { f.candidate.contentDigest = 'c'.repeat(64); }]) {
    const f = metadataFixture(); change(f); rehashEvents(f.catalog); reject(f.catalog);
  }
  const duplicate = metadataFixture(), second = { ...copy(duplicate.candidate), id: uid('bc', 999), createdAt: LATER };
  append(duplicate.catalog, 'browserCandidates', second, 'browser-candidate-created', second.projectId); reject(duplicate.catalog);
  const foreign = metadataFixture(), otherProject = append(foreign.catalog, 'projects', { id: uid('ap', 999), name: '另一个项目', createdAt: AT }, 'project-created', uid('ap', 999));
  foreign.candidate.projectId = otherProject.id; resealCandidate(foreign); reject(foreign.catalog);
  const otherRelease = metadataFixture();
  append(otherRelease.catalog, 'releases', { ...copy(otherRelease.release), id: uid('ar', 999) }, 'release-created', otherRelease.project.id);
  otherRelease.candidate.releaseId = uid('ar', 999); resealCandidate(otherRelease); reject(otherRelease.catalog);
});

test('complete immutable organization fields are bound while candidate storage metadata is excluded', () => {
  for (const [section, field, value] of [['project', 'name', '改名'], ['project', 'createdAt', LATER],
    ['release', 'label', '改标签'], ['release', 'buildRef', 'other-build'], ['release', 'createdAt', LATER], ['binding', 'boundAt', LATER]]) {
    const f = metadataFixture(); f[section][field] = value; rehashEvents(f.catalog); reject(f.catalog);
  }
  const removedBuild = metadataFixture(); delete removedBuild.release.buildRef; rehashEvents(removedBuild.catalog); reject(removedBuild.catalog);
  const changedQuery = metadataFixture(); changedQuery.release.targetUrl = 'https://example.test/app?tenant=two&tenant=one&token=fixture-value';
  changedQuery.binding.source.entryUrl = changedQuery.release.targetUrl; resealSource(changedQuery.binding);
  changedQuery.candidate.sourceContentDigest = changedQuery.binding.sourceContentDigest; rehashEvents(changedQuery.catalog); reject(changedQuery.catalog);
  const f = metadataFixture(), original = f.candidate.contentDigest;
  delete f.catalog.browserCandidates[f.candidate.id]; f.candidate.id = uid('bc', 100); f.candidate.createdAt = LATER;
  f.catalog.browserCandidates[f.candidate.id] = f.candidate; f.catalog.events.at(-1).entityId = f.candidate.id;
  rehashEvents(f.catalog); valid(f.catalog); assert.equal(f.candidate.contentDigest, original);
});

test('events retain exact record identity, ordering and one event per entity', () => {
  for (const [field, value] of [['kind', 'candidate-created'], ['entityId', uid('ab', 6)], ['projectId', uid('ap', 999)],
    ['at', LATER], ['entityDigest', '0'.repeat(64)], ['revision', 999]]) {
    const f = metadataFixture(); f.catalog.events.at(-1)[field] = value; reject(f.catalog);
  }
  for (const destination of [0, 1, 2]) {
    const f = metadataFixture(), event = f.catalog.events.pop(); f.catalog.events.splice(destination, 0, event);
    rehashEvents(f.catalog); reject(f.catalog);
  }
  const missingEvent = metadataFixture(); missingEvent.catalog.events.pop(); missingEvent.catalog.revision--; reject(missingEvent.catalog);
  const missingEntity = metadataFixture(); delete missingEntity.catalog.browserCandidates[missingEntity.candidate.id]; reject(missingEntity.catalog);
  const duplicateEvent = metadataFixture(); duplicateEvent.catalog.events.push(copy(duplicateEvent.catalog.events.at(-1))); duplicateEvent.catalog.revision++; reject(duplicateEvent.catalog);
});

test('V3 to V4 construction preserves complete Spec and independent Browser history exactly', () => {
  const f = metadataFixture({ version: 3, candidate: false }); specHistory(f.catalog, f.project, f.release);
  schema.validateAcceptanceCatalogV3(f.catalog); const before = copy(f.catalog), currentSelection = schema.currentSelectionsOf(before, f.project.id);
  const migrated = upgrade(f.catalog); valid(migrated); assert.deepEqual(f.catalog, before);
  assert.equal(migrated.schemaVersion, 4); assert.equal(migrated.revision, before.revision + 1);
  assert.notEqual(migrated.generationId, before.generationId); assert.deepEqual(migrated.browserCandidates, {});
  for (const map of ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'browserSourceBindings']) {
    assert.deepEqual(migrated[map], before[map]); assert.notEqual(migrated[map], f.catalog[map]);
    assert.equal(independentHash(migrated[map]), independentHash(before[map]));
  }
  assert.deepEqual(migrated.events.slice(0, before.revision), before.events);
  assert.deepEqual(schema.currentSelectionsOf(migrated, f.project.id), currentSelection);
  const event = migrated.events.at(-1), migration = migrated.migrations[event.entityId];
  assert.equal(migration.fromSchemaVersion, 3); assert.equal(migration.toSchemaVersion, 4);
  assert.equal(migration.fromGenerationId, before.generationId); assert.equal(migration.fromRevision, before.revision);
  assert.equal(migration.sourceHeadSha256, headSha256); assert.equal(migration.sourcePreviousSha256, previousSha256);
  assert.equal(event.entityDigest, independentHash(migration)); assert.equal(Object.hasOwn(event, 'projectId'), false);
});

test('full V1 to V4 chain preserves every earlier step and generation identity', () => {
  const first = empty(1), f = metadataFixture({ version: 3, candidate: false });
  append(first, 'projects', copy(f.project), 'project-created', f.project.id);
  append(first, 'releases', copy(f.release), 'release-created', f.project.id);
  const second = schema.buildCatalogMigration(first, { headSha256, previousSha256: null, at: AT });
  specHistory(second, f.project, f.release);
  const third = schema.buildCatalogMigrationV3(second, { headSha256: 'c'.repeat(64), previousSha256: headSha256, at: AT });
  append(third, 'browserSourceBindings', copy(f.binding), 'browser-source-bound', f.project.id);
  const before = copy(third), fourth = upgrade(third); valid(fourth);
  const migrations = fourth.events.filter(event => event.kind === 'catalog-migrated').map(event => fourth.migrations[event.entityId]);
  assert.deepEqual(migrations.map(value => [value.fromSchemaVersion, value.toSchemaVersion]), [[1, 2], [2, 3], [3, 4]]);
  assert.equal(new Set([...migrations.map(value => value.fromGenerationId), fourth.generationId]).size, 4);
  for (const [key, migration] of Object.entries(before.migrations)) assert.deepEqual(fourth.migrations[key], migration);
  assert.deepEqual(fourth.events.slice(0, before.revision), before.events);
});

test('migration gates reject early Browser candidate events and retain the V3 source-binding gate in V4', () => {
  const f = metadataFixture({ version: 3, candidate: false }), migrated = upgrade(f.catalog);
  append(migrated, 'browserCandidates', copy(f.candidate), 'browser-candidate-created', f.project.id); valid(migrated);
  const moved = copy(migrated), candidateEvent = moved.events.pop(); moved.events.splice(moved.events.length - 1, 0, candidateEvent);
  rehashEvents(moved); reject(moved);
  const base = empty(2); append(base, 'projects', copy(f.project), 'project-created', f.project.id);
  append(base, 'releases', copy(f.release), 'release-created', f.project.id);
  const third = schema.buildCatalogMigrationV3(base, { headSha256, at: AT });
  append(third, 'browserSourceBindings', copy(f.binding), 'browser-source-bound', f.project.id);
  const fourth = upgrade(third); valid(fourth);
  const axIndex = fourth.events.findIndex(event => event.kind === 'browser-source-bound');
  const [axEvent] = fourth.events.splice(axIndex, 1); fourth.events.splice(2, 0, axEvent); rehashEvents(fourth); reject(fourth);
});

test('V4 migration transitions, final chain and generation reuse fail even after rehash', () => {
  for (const mutate of [m => { m.fromSchemaVersion = 2; }, m => { m.toSchemaVersion = 5; },
    (m, catalog) => { m.fromGenerationId = catalog.generationId; }, m => { m.fromRevision--; }, m => { m.actor.extra = true; },
    m => { m.sourceHeadSha256 = 'A'.repeat(64); }, m => { delete m.sourcePreviousSha256; }]) {
    const f = metadataFixture({ version: 3, candidate: false }), migrated = upgrade(f.catalog), migration = Object.values(migrated.migrations)[0];
    mutate(migration, migrated); const event = migrated.events.find(value => value.entityId === migration.id);
    event.entityDigest = independentHash(migration); reject(migrated);
  }
  const incomplete = metadataFixture({ version: 3, candidate: false }).catalog;
  incomplete.schemaVersion = 4; incomplete.browserCandidates = {};
  // A native V4 with no migration is a legitimate shape. A present unfinished
  // migration lineage, however, cannot claim to finish at V4.
  valid(incomplete);
  const v2 = empty(2), v3 = schema.buildCatalogMigrationV3(v2, { headSha256, at: AT });
  v3.schemaVersion = 4; v3.browserCandidates = {}; reject(v3);
});

test('V4 capacities include candidate count, exact entity bytes and migration construction budgets', () => {
  const f = metadataFixture(), bytes = Buffer.byteLength(JSON.stringify(f.candidate));
  assert.equal(schema.validateAcceptanceCatalogV4(f.catalog, { limits: { browserCandidates: 1, browserCandidateBytes: bytes } }), f.catalog);
  for (const limits of [{ browserCandidates: 0 }, { browserCandidateBytes: bytes - 1 }]) assert.throws(() => schema.validateAcceptanceCatalogV4(f.catalog, { limits }), unavailable);
  for (const limits of [{ browserCandidates: -1 }, { browserCandidates: 0.5 }, { browserCandidateBytes: -1 }, { other: 1 }]) assert.throws(() => schema.limitsOf(limits), TypeError);
  const old = metadataFixture({ version: 3, candidate: false }).catalog;
  for (const limits of [{ migrations: 0 }, { events: old.revision }, { jsonBytes: 1 }]) {
    assert.throws(() => upgrade(old, { limits }), { code: 'CATALOG_CAPACITY', status: 409 });
  }
  valid(upgrade(old, { limits: { migrations: 1, browserCandidates: 0 } }));
  assert.equal(schema.ACCEPTANCE_CATALOG_LIMITS.browserCandidates, 1024);
  assert.equal(schema.ACCEPTANCE_CATALOG_LIMITS.browserCandidateBytes, 8192);
});

test('the real 1024 candidate boundary accepts complete histories and rejects the next entity', () => {
  const f = metadataFixture();
  const addPair = index => {
    const binding = copy(f.binding); binding.id = uid('ax', 1000 + index); binding.source.runId = uid('ac', 1000 + index);
    resealSource(binding); append(f.catalog, 'browserSourceBindings', binding, 'browser-source-bound', f.project.id);
    const candidate = { ...copy(f.candidate), id: uid('bc', 1000 + index), sourceBindingId: binding.id,
      sourceContentDigest: binding.sourceContentDigest,
      organizationContextDigest: organizedHash('organization-context', { project: f.project, release: f.release, sourceBinding: binding }) };
    candidate.contentDigest = organizedHash('content', candidateContent(candidate));
    append(f.catalog, 'browserCandidates', candidate, 'browser-candidate-created', f.project.id);
  };
  for (let index = 1; index < 1024; index++) addPair(index);
  assert.equal(Object.keys(f.catalog.browserCandidates).length, 1024); valid(f.catalog);
  addPair(1024); assert.equal(Object.keys(f.catalog.browserCandidates).length, 1025); reject(f.catalog);
});

test('V4 retains independent Browser baseline attribution and both legacy target binding orders', () => {
  for (const browserFirst of [true, false]) {
    const f = metadataFixture(), projectId = uid('ap', 200), releaseId = uid('ar', 201);
    append(f.catalog, 'projects', { id: projectId, name: '目标属于另一项目', createdAt: AT }, 'project-created', projectId);
    append(f.catalog, 'releases', { id: releaseId, projectId, label: '明确目标版本', targetUrl: f.release.targetUrl,
      createdAt: AT }, 'release-created', projectId);
    const target = { ...copy(f.binding), id: uid('ax', 202), projectId, releaseId,
      source: { ...copy(f.binding.source), side: 'target' } }; resealSource(target);
    const legacy = { runId: target.source.runId, projectId, releaseId, boundAt: AT, actor: { kind: 'local-operator' } };
    const bindTarget = () => append(f.catalog, 'browserSourceBindings', target, 'browser-source-bound', projectId);
    const bindLegacy = () => append(f.catalog, 'runBindings', legacy, 'run-bound', projectId);
    if (browserFirst) { bindTarget(); bindLegacy(); } else { bindLegacy(); bindTarget(); }
    valid(f.catalog);
    assert.equal(f.catalog.browserSourceBindings[f.binding.id].projectId, f.project.id);
    legacy.projectId = f.project.id; legacy.releaseId = f.release.id; rehashEvents(f.catalog); reject(f.catalog);
  }
});

test('V4 construction rejects non-V3 inputs and malformed caller-supplied byte identities', () => {
  for (const value of [empty(1), empty(2), empty(4), null, {}, new Proxy({}, {})]) assert.throws(() => upgrade(value), unavailable);
  for (const options of [{ headSha256: undefined }, { headSha256: 'bad' }, { previousSha256: false }, { at: 'now' }]) {
    assert.throws(() => upgrade(empty(3), options), { code: 'INVALID_INPUT', status: 400 });
  }
  const withoutPrevious = upgrade(empty(3), { previousSha256: null });
  assert.equal(Object.values(withoutPrevious.migrations)[0].sourcePreviousSha256, null);
});

test('Browser candidates cannot enter existing Spec candidate, approval or selection contracts', () => {
  for (const change of [f => { f.catalog.candidates[f.candidate.id] = f.candidate; delete f.catalog.browserCandidates[f.candidate.id]; },
    f => { append(f.catalog, 'approvals', { id: uid('aa', 100), projectId: f.project.id, candidateId: f.candidate.id,
      contentDigest: f.candidate.contentDigest, reason: '不能批准bc', approvedAt: AT, actor: { kind: 'local-operator' } }, 'baseline-approved', f.project.id); },
    f => { append(f.catalog, 'selections', { id: uid('as', 100), projectId: f.project.id, mode: 'browser', approvalId: null,
      previousSelectionId: null, reason: '不能选用browser', selectedAt: AT, actor: { kind: 'local-operator' } }, 'baseline-selected', f.project.id); }]) {
    const f = metadataFixture(); change(f); reject(f.catalog);
  }
  const f = metadataFixture(); specHistory(f.catalog, f.project, f.release); valid(f.catalog);
  assert.deepEqual(Object.keys(schema.currentSelectionsOf(f.catalog, f.project.id)), ['spec']);
  assert.equal(schema.currentSelectionsOf(f.catalog, f.project.id).spec.id, uid('as', 55));
});
