import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { buildCatalogMigration, buildCatalogMigrationV3, currentSelectionsOf } from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { projectSpecBaselineCandidate } from '../src/acceptance/candidate-projection.mjs';

const at = '2026-10-17T00:00:00.000Z';
const uid = prefix => prefix + '-' + randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveName = bytes => `catalog.v${JSON.parse(bytes).schemaVersion}.${hash(bytes)}.json`;
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };
const archivedRun = 'ac-2424d160-cf8e-4991-8fba-c972a84becd1';
const archivedRoot = fileURLToPath(new URL('../../docs/audits/2026-10-16/evidence/acceptance-catalog/console/run-evidence/', import.meta.url));

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-catalog-schema3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = { root, assertOwned() {} };
  return { root, owner, store: createAcceptanceCatalogStore({ root, owner, ...options }) };
}
const bytesOf = (f, name = 'catalog.json') => readFileSync(join(f.root, name));
const parse = (f, name = 'catalog.json') => JSON.parse(bytesOf(f, name));
const archives = (f, version) => readdirSync(f.root).filter(name => new RegExp(`^catalog\\.v${version}\\.[a-f0-9]{64}\\.json$`).test(name)).sort();
function nativeV2() {
  return { schemaVersion: 2, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {},
    candidates: {}, approvals: {}, selections: {}, migrations: {}, events: [] };
}
function v1() {
  const value = nativeV2(); value.schemaVersion = 1;
  for (const key of ['candidates', 'approvals', 'selections', 'migrations']) delete value[key];
  return value;
}
function seed(f, head, previous = null) {
  const headRaw = Buffer.isBuffer(head) ? head : encode(head), previousRaw = previous && (Buffer.isBuffer(previous) ? previous : encode(previous));
  writeFileSync(join(f.root, 'catalog.json'), headRaw);
  if (previousRaw) writeFileSync(join(f.root, 'catalog.previous.json'), previousRaw);
  return { head: JSON.parse(headRaw), headRaw, previous: previousRaw && JSON.parse(previousRaw), previousRaw };
}
function append(catalog, map, entity, kind, projectId) {
  const entityId = entity.id ?? entity.runId;
  catalog[map][entityId] = entity;
  catalog.events.push({ id: uid('ae'), revision: ++catalog.revision, kind, projectId, entityId,
    entityDigest: hashAcceptanceValue(entity), at: entity.createdAt ?? entity.boundAt ?? entity.approvedAt ?? entity.selectedAt,
    actor: { kind: 'local-operator' } });
}
function assertPreserved(before, after) {
  for (const map of ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'migrations']) {
    for (const [id, entity] of Object.entries(before[map] ?? {})) {
      assert.equal(JSON.stringify(after[map][id]), JSON.stringify(entity), `${map}/${id} serialized bytes`);
      assert.equal(hashAcceptanceValue(after[map][id]), hashAcceptanceValue(entity), `${map}/${id} entity digest`);
    }
  }
  assert.equal(JSON.stringify(after.events.slice(0, before.revision)), JSON.stringify(before.events));
}
function assertV3Step(current, source) {
  assert.equal(current.schemaVersion, 3);
  assert.equal(current.revision, source.head.revision + 1);
  assert.notEqual(current.generationId, source.head.generationId);
  assert.deepEqual(current.browserSourceBindings, {});
  assertPreserved(source.head, current);
  const added = Object.values(current.migrations).filter(value => !Object.hasOwn(source.head.migrations, value.id));
  assert.equal(added.length, 1);
  const migration = added[0];
  assert.equal(migration.fromSchemaVersion, 2); assert.equal(migration.toSchemaVersion, 3);
  assert.equal(migration.fromRevision, source.head.revision); assert.equal(migration.fromGenerationId, source.head.generationId);
  assert.equal(migration.sourceHeadSha256, hash(source.headRaw));
  assert.equal(migration.sourcePreviousSha256, source.previousRaw ? hash(source.previousRaw) : null);
  assert.equal(current.events.at(-1).entityId, migration.id);
  assert.equal(current.events.at(-1).entityDigest, hashAcceptanceValue(migration));
  validateAcceptanceCatalog(current);
}

test('native V2 requires initialization, migrates with exact raw hashes and retires its generation even at the new revision', async t => {
  for (const prior of ['none', 'same', 'compact']) await t.test(prior, async t => {
    const f = fixture(t), before = nativeV2(), headRaw = encode(before);
    const previousRaw = prior === 'none' ? null : prior === 'same' ? headRaw : Buffer.from(JSON.stringify(before));
    const source = seed(f, headRaw, previousRaw);
    assert.equal(validateAcceptanceCatalog(before), before);
    assert.throws(() => f.store.read(), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
    await assert.rejects(f.store.createProject({ ...cas(before), name: '迁移前写入' }), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
    assert.deepEqual(bytesOf(f), headRaw);
    const current = await f.store.initialize(); assertV3Step(current, source);
    assert.deepEqual(bytesOf(f, 'catalog.previous.json'), headRaw);
    assert.equal(archives(f, 1).length, 0); assert.equal(archives(f, 2).length, prior === 'compact' ? 2 : 1);
    for (const raw of [headRaw, previousRaw].filter(Boolean)) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
    const committedRaw = bytesOf(f);
    for (const revision of [before.revision, current.revision]) {
      await assert.rejects(f.store.createProject({ expectedGenerationId: before.generationId, expectedRevision: revision,
        name: '旧代 CAS' }), { code: 'STALE_REVISION', status: 409 });
      assert.deepEqual(bytesOf(f), committedRaw);
    }
    const restart = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
    assert.deepEqual(await restart.initialize(), current); assert.deepEqual(await restart.initialize(), current);
    assert.deepEqual(bytesOf(f), committedRaw);
    assert.equal((await restart.createProject({ ...cas(current), name: '迁移后写入' })).revision, current.revision + 1);
  });
});

test('a V1 chain can fail in every second-step publication phase and restart without replaying its committed first migration', async t => {
  for (const phase of ['preimage', 'previous', 'head', 'after-head']) await t.test(phase, async t => {
    let attempted, firstCommittedRaw;
    const f = fixture(t, {
      writeExclusive(file, bytes) {
        if (JSON.parse(bytes).schemaVersion === 2 && phase === 'preimage') throw new Error('second step preimage publication failed');
        writeFileSync(file, bytes, { flag: 'wx' });
      },
      writeAtomic(file, bytes) {
        const value = JSON.parse(bytes);
        if (basename(file) === 'catalog.json' && value.schemaVersion === 2) firstCommittedRaw = Buffer.from(bytes);
        if (basename(file) === 'catalog.previous.json' && value.schemaVersion === 2 && phase === 'previous') throw new Error('second step previous failed');
        if (basename(file) === 'catalog.json' && value.schemaVersion === 3) {
          attempted = value;
          if (phase === 'head') throw new Error('second step head failed');
        }
        writeAtomicFileSync(file, bytes);
        if (basename(file) === 'catalog.json' && value.schemaVersion === 3 && phase === 'after-head') throw new Error('completion lost after V3 commit');
      },
    }), source = seed(f, v1());
    await assert.rejects(f.store.initialize(), unavailable);
    assert.ok(firstCommittedRaw);
    const first = JSON.parse(firstCommittedRaw), afterFailure = parse(f);
    assert.equal(first.schemaVersion, 2); assert.equal(Object.keys(first.migrations).length, 1);
    assert.equal(afterFailure.schemaVersion, phase === 'after-head' ? 3 : 2);
    assert.deepEqual(bytesOf(f, 'catalog.previous.json'), ['head', 'after-head'].includes(phase) ? firstCommittedRaw : source.headRaw);
    assert.deepEqual(readFileSync(join(f.root, archiveName(source.headRaw))), source.headRaw);
    assert.equal(archives(f, 1).length, 1); assert.equal(archives(f, 2).length, phase === 'preimage' ? 0 : 1);
    if (phase !== 'after-head') assert.throws(() => f.store.read(), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
    const restart = createAcceptanceCatalogStore({ root: f.root, owner: f.owner }), current = await restart.initialize();
    assertV3Step(current, { head: first, headRaw: firstCommittedRaw,
      previousRaw: phase === 'head' ? firstCommittedRaw : source.headRaw });
    assert.equal(Object.keys(current.migrations).length, 2);
    assert.deepEqual(current.migrations[Object.keys(first.migrations)[0]], Object.values(first.migrations)[0]);
    if (attempted && phase === 'head') assert.notEqual(current.generationId, attempted.generationId);
    if (phase === 'after-head') assert.deepEqual(current, afterFailure);
    const finalRaw = bytesOf(f); assert.deepEqual(await restart.initialize(), current); assert.deepEqual(bytesOf(f), finalRaw);
  });
});

test('second-step byte CAS detects changes to either input after V2 preimage publication and preserves all original preimages', async t => {
  for (const name of ['catalog.json', 'catalog.previous.json']) await t.test(name, async t => {
    let sourceV2Raw, oldPreviousRaw;
    const f = fixture(t, { writeExclusive(file, bytes) {
      writeFileSync(file, bytes, { flag: 'wx' });
      if (JSON.parse(bytes).schemaVersion === 2) {
        sourceV2Raw = Buffer.from(bytes); oldPreviousRaw = bytesOf(f, 'catalog.previous.json');
        const changed = join(f.root, name); writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from(' ')]));
      }
    } }), source = seed(f, v1());
    await assert.rejects(f.store.initialize(), { code: 'STALE_REVISION', status: 409 });
    assert.ok(sourceV2Raw);
    assert.deepEqual(bytesOf(f), name === 'catalog.json' ? Buffer.concat([sourceV2Raw, Buffer.from(' ')]) : sourceV2Raw);
    assert.deepEqual(bytesOf(f, 'catalog.previous.json'), name === 'catalog.previous.json'
      ? Buffer.concat([oldPreviousRaw, Buffer.from(' ')]) : oldPreviousRaw);
    for (const raw of [source.headRaw, sourceV2Raw]) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
  });
});

test('schema3 initialization and writes reject a V1 predecessor even when it is the exact earlier chain source', async t => {
  const f = fixture(t), source = seed(f, v1()), current = await f.store.initialize(), original = bytesOf(f);
  writeFileSync(join(f.root, 'catalog.previous.json'), source.headRaw);
  assert.deepEqual(f.store.read(), current);
  await assert.rejects(f.store.initialize(), unavailable);
  await assert.rejects(f.store.createProject({ ...cas(current), name: '拒绝跳步桥' }), unavailable);
  assert.deepEqual(bytesOf(f), original); assert.deepEqual(bytesOf(f, 'catalog.previous.json'), source.headRaw);
});

test('V2 history cannot change after a separately built V3 migration merely by making the predecessor pure-valid', async t => {
  for (const variant of ['formatting', 'generation', 'event', 'entity']) await t.test(variant, async t => {
    const f = fixture(t), old = nativeV2(), project = { id: uid('ap'), name: '旧项目', createdAt: at };
    append(old, 'projects', project, 'project-created', project.id);
    const raw = encode(old), current = buildCatalogMigrationV3(old, { headSha256: hash(raw), at });
    let prior = copy(old);
    if (variant === 'generation') prior.generationId = uid('ag');
    if (variant === 'event') prior.events[0].id = uid('ae');
    if (variant === 'entity') { prior.projects[project.id].name = '另一个旧项目'; prior.events[0].entityDigest = hashAcceptanceValue(prior.projects[project.id]); }
    validateAcceptanceCatalog(prior);
    const previousRaw = variant === 'formatting' ? Buffer.from(JSON.stringify(prior)) : encode(prior);
    seed(f, current, previousRaw); const headRaw = bytesOf(f);
    assert.deepEqual(f.store.read(), current);
    await assert.rejects(f.store.initialize(), unavailable);
    await assert.rejects(f.store.createProject({ ...cas(current), name: '不接受分叉历史' }), unavailable);
    assert.deepEqual(bytesOf(f), headRaw); assert.deepEqual(bytesOf(f, 'catalog.previous.json'), previousRaw);
    assert.deepEqual(archives(f, 2), []);
  });
});

test('preimage capacities are independent by actual schema and both V2 raw inputs are preflighted before publication', async t => {
  for (const kind of ['two-v1', 'extra-v2']) await t.test(kind, async t => {
    const f = fixture(t), head = nativeV2(), source = seed(f, head, Buffer.from(JSON.stringify(head)));
    const existing = kind === 'two-v1' ? [encode(v1()), encode(v1())] : [encode(nativeV2())];
    for (const raw of existing) writeFileSync(join(f.root, archiveName(raw)), raw);
    if (kind === 'two-v1') {
      assertV3Step(await f.store.initialize(), source);
      assert.equal(archives(f, 1).length, 2); assert.equal(archives(f, 2).length, 2);
    } else {
      await assert.rejects(f.store.initialize(), unavailable);
      assert.deepEqual(bytesOf(f), source.headRaw); assert.deepEqual(bytesOf(f, 'catalog.previous.json'), source.previousRaw);
      assert.deepEqual(archives(f, 2), [archiveName(existing[0])]);
    }
    for (const raw of existing) assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
  });
});

test('a preimage with correct content hash but the wrong schema label blocks migration without relabeling or replacing it', async t => {
  for (const version of [1, 2]) await t.test('mislabeled-v' + version, async t => {
    const f = fixture(t), source = seed(f, nativeV2()), raw = encode(version === 1 ? nativeV2() : v1());
    const name = `catalog.v${version}.${hash(raw)}.json`; writeFileSync(join(f.root, name), raw);
    await assert.rejects(f.store.initialize(), unavailable);
    assert.deepEqual(bytesOf(f), source.headRaw); assert.deepEqual(readFileSync(join(f.root, name)), raw);
    assert.deepEqual(readdirSync(f.root).sort(), ['catalog.json', name].sort());
  });
});

test('second-step capacity failures preserve committed V2 without preparation and continue once the actual limit is increased', async t => {
  for (const limit of ['migrations', 'events', 'jsonBytes']) await t.test(limit, async t => {
    const old = v1(), oldRaw = encode(old);
    // All generated IDs, hashes and timestamps have fixed serialized widths.
    // This computes the exact V2 byte budget without using a V3 initializer.
    const expectedV2 = buildCatalogMigration(old, { headSha256: hash(oldRaw), at });
    const limits = limit === 'migrations' ? { migrations: 1 }
      : limit === 'events' ? { events: expectedV2.revision } : { jsonBytes: encode(expectedV2).length };
    const f = fixture(t, { limits }), source = seed(f, oldRaw);
    await assert.rejects(f.store.initialize(), { code: 'CATALOG_CAPACITY', status: 409, details: { limit } });
    const retainedRaw = bytesOf(f), retained = JSON.parse(retainedRaw);
    assert.equal(retained.schemaVersion, 2); assert.equal(retained.revision, old.revision + 1);
    assert.equal(retained.events.at(-1).kind, 'catalog-migrated');
    assert.equal(Object.keys(retained.migrations).length, 1);
    assert.equal(validateAcceptanceCatalog(retained, { limits }), retained);
    if (limit === 'jsonBytes') assert.equal(retainedRaw.length, limits.jsonBytes);
    assert.deepEqual(bytesOf(f, 'catalog.previous.json'), source.headRaw);
    assert.deepEqual(archives(f, 1), [archiveName(source.headRaw)]);
    assert.deepEqual(readFileSync(join(f.root, archiveName(source.headRaw))), source.headRaw);
    assert.deepEqual(archives(f, 2), []);
    assert.deepEqual(readdirSync(f.root).sort(), ['catalog.json', 'catalog.previous.json', archiveName(source.headRaw)].sort());
    assert.throws(() => f.store.read(), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });

    const expectedV3 = buildCatalogMigrationV3(retained, { headSha256: hash(retainedRaw),
      previousSha256: hash(source.headRaw), at });
    const relaxedLimits = { ...limits, [limit]: limit === 'migrations' ? 2
      : limit === 'events' ? expectedV3.revision : encode(expectedV3).length };
    assert.ok(relaxedLimits[limit] > limits[limit]);
    const restart = createAcceptanceCatalogStore({ root: f.root, owner: f.owner, limits: relaxedLimits });
    const current = await restart.initialize();
    assertV3Step(current, { head: retained, headRaw: retainedRaw, previousRaw: source.headRaw });
    assertPreserved(retained, current);
    assert.deepEqual(bytesOf(f, 'catalog.previous.json'), retainedRaw);
    assert.deepEqual(readFileSync(join(f.root, archiveName(retainedRaw))), retainedRaw);
    assert.deepEqual(readFileSync(join(f.root, archiveName(source.headRaw))), source.headRaw);
    assert.equal(Object.keys(current.migrations).length, 2);
    const committedRaw = bytesOf(f); assert.deepEqual(await restart.initialize(), current); assert.deepEqual(bytesOf(f), committedRaw);
  });
});

test('complete native and previously migrated V2 Spec histories retain entity bytes, digests, source bytes and cancel/reselect identity after migration', async t => {
  for (const origin of ['native-v2', 'migrated-v2']) await t.test(origin, async t => {
    const f = fixture(t), runDir = join(f.root, archivedRun); cpSync(join(archivedRoot, archivedRun), runDir, { recursive: true });
    const originalFiles = Object.fromEntries(readdirSync(runDir).map(name => [name, readFileSync(join(runDir, name))]));
    const material = readSpecCandidateSource(archivedRun, { root: f.root, owner: f.owner });
    const oldV1Raw = encode(v1());
    const old = origin === 'native-v2' ? nativeV2()
      : buildCatalogMigration(JSON.parse(oldV1Raw), { headSha256: hash(oldV1Raw), at });
    if (origin === 'migrated-v2') writeFileSync(join(f.root, archiveName(oldV1Raw)), oldV1Raw);
    const project = { id: uid('ap'), name: '完整 Spec 历史', createdAt: at };
    const release = { id: uid('ar'), projectId: project.id, label: 'V2 原版本', targetUrl: material.snapshot.manifest.targetUrl, createdAt: at };
    const binding = { runId: archivedRun, projectId: project.id, releaseId: release.id, boundAt: at, actor: { kind: 'local-operator' } };
    append(old, 'projects', project, 'project-created', project.id);
    append(old, 'releases', release, 'release-created', project.id);
    append(old, 'runBindings', binding, 'run-bound', project.id);
    const { projection } = projectSpecBaselineCandidate(material, { projectId: project.id, releaseId: release.id, sourceSide: 'source' });
    const candidate = { id: uid('ab'), ...projection, createdAt: at };
    const approval = { id: uid('aa'), projectId: project.id, candidateId: candidate.id,
      contentDigest: candidate.contentDigest, reason: 'V2 中已审阅完整需求', approvedAt: at, actor: { kind: 'local-operator' } };
    append(old, 'candidates', candidate, 'candidate-created', project.id);
    append(old, 'approvals', approval, 'baseline-approved', project.id);
    let selected = null, ancestor;
    for (const approved of [approval.id, null, approval.id]) {
      const selection = { id: uid('as'), projectId: project.id, mode: 'spec', approvalId: approved,
        previousSelectionId: selected?.id ?? null, reason: approved ? 'V2 明确选用需求' : 'V2 取消选用', selectedAt: at, actor: { kind: 'local-operator' } };
      ancestor = copy(old); append(old, 'selections', selection, 'baseline-selected', project.id); selected = selection;
    }
    validateAcceptanceCatalog(old); validateAcceptanceCatalog(ancestor);
    const source = seed(f, old, ancestor), current = await f.store.initialize(); assertV3Step(current, source);
    assertPreserved(old, current);
    assert.deepEqual(currentSelectionsOf(current, project.id).spec, selected);
    assert.equal(current.approvals[approval.id].contentDigest, approval.contentDigest);
    const view = f.store.readBaselineCandidate(project.id, candidate.id);
    assert.equal(view.diagnostics.eligible, true); assert.equal(view.diagnostics.contentMatches, true);
    assert.equal(view.candidate.contentDigest, candidate.contentDigest);
    const prepared = await f.store.prepareManagedSpecDispatch(project.id, { ...cas(current), operationId: uid('ao'),
      selectionId: selected.id, contentDigest: approval.contentDigest, targetReleaseId: release.id });
    assert.equal(prepared.state, 'prepared'); assert.equal(prepared.runCreated, false); assert.equal(prepared.executionReady, false);
    assert.equal(prepared.record.envelope.selection.id, selected.id);
    assert.equal(prepared.record.envelope.approval.contentDigest, approval.contentDigest);
    assert.equal(prepared.record.envelope.plan.mode, 'spec');
    assert.deepEqual(bytesOf(f), encode(current));
    for (const [name, raw] of Object.entries(originalFiles)) assert.deepEqual(readFileSync(join(runDir, name)), raw, name);
    assert.deepEqual(readdirSync(runDir).sort(), Object.keys(originalFiles).sort());
    if (origin === 'migrated-v2') {
      assert.deepEqual(readFileSync(join(f.root, archiveName(oldV1Raw))), oldV1Raw);
      assert.equal(Object.keys(current.migrations).length, 2);
    } else assert.equal(Object.keys(current.migrations).length, 1);
  });
});
