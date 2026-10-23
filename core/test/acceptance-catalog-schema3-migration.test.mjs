import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { buildCatalogMigration, buildCatalogMigrationV3, buildCatalogMigrationV4, currentSelectionsOf } from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { projectSpecBaselineCandidate } from '../src/acceptance/candidate-projection.mjs';
import { requiredDir } from './fixtures/audit-evidence.mjs';

const at = '2026-10-17T00:00:00.000Z', uid = prefix => prefix + '-' + randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveName = bytes => 'catalog.v' + JSON.parse(bytes).schemaVersion + '.' + hash(bytes) + '.json';
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };
const confirm = preview => ({ targetSchemaVersion: 4, expectedGenerationId: preview.source.generationId, expectedRevision: preview.source.revision,
  expectedHeadSha256: preview.source.headSha256, expectedPreviousSha256: preview.source.previousSha256, expectedPlanDigest: preview.planDigest });
const migrate = async store => store.applyMigration(confirm(await store.previewMigration({ targetSchemaVersion: 4 })));
function native(version) {
  return { schemaVersion: version, generationId: uid('ag'), revision: 0, projects: {}, releases: {}, runBindings: {},
    ...(version >= 2 ? { candidates: {}, approvals: {}, selections: {}, migrations: {} } : {}), ...(version >= 3 ? { browserSourceBindings: {} } : {}), events: [] };
}
function fixture(t, options = {}) {
  const owner = acquireAcceptanceOwner({ root: mkdtempSync(join(tmpdir(), 'heimdall-catalog-explicit-recovery-')) }), root = owner.root;
  t.after(() => { owner.release(); rmSync(root, { recursive: true, force: true }); });
  return { root, owner, store: createAcceptanceCatalogStore({ root, owner, ...options }) };
}
function seed(f, value, previous = null) {
  const raw = Buffer.isBuffer(value) ? value : encode(value); writeFileSync(join(f.root, 'catalog.json'), raw);
  if (previous) writeFileSync(join(f.root, 'catalog.previous.json'), Buffer.isBuffer(previous) ? previous : encode(previous));
  return raw;
}
const bytesOf = (f, name = 'catalog.json') => readFileSync(join(f.root, name));
const archives = f => readdirSync(f.root).filter(name => /^catalog\.v[123]\.[a-f0-9]{64}\.json$/.test(name)).sort();
function append(catalog, map, entity, kind, projectId) {
  const entityId = entity.id ?? entity.runId; catalog[map][entityId] = entity;
  catalog.events.push({ id: uid('ae'), revision: ++catalog.revision, kind, projectId, entityId, entityDigest: hashAcceptanceValue(entity),
    at: entity.createdAt ?? entity.boundAt ?? entity.approvedAt ?? entity.selectedAt, actor: { kind: 'local-operator' } });
}
function assertPreserved(before, after) {
  for (const map of ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'migrations', 'browserSourceBindings']) {
    for (const [id, entity] of Object.entries(before[map] ?? {})) {
      assert.equal(JSON.stringify(after[map][id]), JSON.stringify(entity)); assert.equal(hashAcceptanceValue(after[map][id]), hashAcceptanceValue(entity));
    }
  }
  assert.equal(JSON.stringify(after.events.slice(0, before.revision)), JSON.stringify(before.events));
}

test('each migration publication phase preserves committed steps and requires a fresh explicit confirmation after interruption', async t => {
  for (const failedFrom of [1, 2, 3]) for (const phase of ['preimage', 'previous', 'head', 'after-head']) await t.test(failedFrom + '/' + phase, async t => {
    let failed = false; const published = new Map();
    const f = fixture(t, {
      writeExclusive(file, bytes) {
        if (!failed && JSON.parse(bytes).schemaVersion === failedFrom && phase === 'preimage') { failed = true; throw Error('injected wx failure'); }
        writeFileSync(file, bytes, { flag: 'wx' });
      },
      writeAtomic(file, bytes) {
        const value = JSON.parse(bytes), isPrevious = basename(file) === 'catalog.previous.json';
        if (!failed && (isPrevious && value.schemaVersion === failedFrom && phase === 'previous'
          || !isPrevious && value.schemaVersion === failedFrom + 1 && phase === 'head')) { failed = true; throw Error('injected publication failure'); }
        writeAtomicFileSync(file, bytes);
        if (!isPrevious) published.set(value.schemaVersion, Buffer.from(bytes));
        if (!failed && !isPrevious && value.schemaVersion === failedFrom + 1 && phase === 'after-head') { failed = true; throw Error('completion lost after published head'); }
      },
    }), source = seed(f, native(1)), first = confirm(await f.store.previewMigration({ targetSchemaVersion: 4 }));
    await assert.rejects(f.store.applyMigration(first), unavailable); assert.equal(failed, true);
    const retained = bytesOf(f), current = JSON.parse(retained), beforeRestart = archives(f);
    assert.equal(current.schemaVersion, failedFrom + (phase === 'after-head' ? 1 : 0));
    const reopened = createAcceptanceCatalogStore({ root: f.root, owner: f.owner });
    if (current.schemaVersion < 3) await assert.rejects(reopened.initialize(), { ...unavailable, details: { reason: 'MIGRATION_REQUIRED' } });
    else assert.deepEqual(await reopened.initialize(), current);
    assert.deepEqual(bytesOf(f), retained); assert.deepEqual(archives(f), beforeRestart);
    if (current.schemaVersion > 1) await assert.rejects(reopened.applyMigration(first), { code: 'STALE_REVISION', status: 409 });
    const result = await migrate(reopened), final = result.catalog;
    assert.equal(final.schemaVersion, 4); assert.equal(final.revision, 3); assert.equal(Object.keys(final.migrations).length, 3);
    assert.deepEqual(final.events.map(event => { const migration = final.migrations[event.entityId]; return [migration.fromSchemaVersion, migration.toSchemaVersion]; }), [[1, 2], [2, 3], [3, 4]]);
    assert.deepEqual(readFileSync(join(f.root, archiveName(source))), source);
    for (const [version, bytes] of published) if (version < 4) assert.deepEqual(readFileSync(join(f.root, archiveName(bytes))), bytes);
    const after = bytesOf(f); assert.deepEqual(await reopened.initialize(), final); assert.deepEqual(bytesOf(f), after);
  });
});

test('both source bytes are checked after preimages and again after rolling previous replacement', async t => {
  for (const phase of ['preimage', 'previous']) for (const name of ['catalog.json', 'catalog.previous.json']) await t.test(phase + '/' + name, async t => {
    let changed = false;
    const alter = f => { const path = join(f.root, name); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(' ')])); changed = true; };
    let f; f = fixture(t, {
      writeExclusive(file, bytes) { writeFileSync(file, bytes, { flag: 'wx' }); if (!changed && phase === 'preimage') alter(f); },
      writeAtomic(file, bytes) { writeAtomicFileSync(file, bytes); if (!changed && phase === 'previous' && basename(file) === 'catalog.previous.json') alter(f); },
    });
    const raw = seed(f, native(3)); writeFileSync(join(f.root, 'catalog.previous.json'), raw);
    const confirmation = confirm(await f.store.previewMigration({ targetSchemaVersion: 4 }));
    await assert.rejects(f.store.applyMigration(confirmation), { code: 'STALE_REVISION', status: 409 });
    assert.equal(JSON.parse(bytesOf(f)).schemaVersion, 3); assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
    assert.deepEqual(bytesOf(f, name), Buffer.concat([raw, Buffer.from(' ')]));
  });
});

test('exclusive-create races accept only exact source bytes and new unrelated preimages invalidate the confirmed inventory', async t => {
  for (const kind of ['same', 'different', 'unrelated']) await t.test(kind, async t => {
    let injected = false; const f = fixture(t, { writeExclusive(file, bytes) {
      if (injected) return writeFileSync(file, bytes, { flag: 'wx' }); injected = true;
      writeFileSync(file, kind === 'different' ? encode(native(3)) : bytes, { flag: 'wx' });
      if (kind === 'unrelated') { const other = encode(native(1)); writeFileSync(join(f.root, archiveName(other)), other); }
      throw Object.assign(Error('wx race'), { code: 'EEXIST' });
    } }); seed(f, native(3)); const input = confirm(await f.store.previewMigration({ targetSchemaVersion: 4 }));
    if (kind === 'same') assert.equal((await f.store.applyMigration(input)).catalog.schemaVersion, 4);
    else { await assert.rejects(f.store.applyMigration(input), kind === 'unrelated' ? { code: 'STALE_REVISION', status: 409 } : unavailable); assert.equal(JSON.parse(bytesOf(f)).schemaVersion, 3); }
  });
});

test('owner loss after preimage or previous publication cannot publish a new head', async t => {
  for (const phase of ['preimage', 'previous']) await t.test(phase, async t => {
    let f; f = fixture(t, { writeExclusive(file, bytes) { writeFileSync(file, bytes, { flag: 'wx' }); if (phase === 'preimage') f.owner.release(); },
      writeAtomic(file, bytes) { writeAtomicFileSync(file, bytes); if (phase === 'previous' && basename(file) === 'catalog.previous.json') f.owner.release(); } });
    const raw = seed(f, native(3)), input = confirm(await f.store.previewMigration({ targetSchemaVersion: 4 }));
    await assert.rejects(f.store.applyMigration(input), { code: 'ACCEPTANCE_OWNER_LOST', status: 503 }); assert.deepEqual(bytesOf(f), raw);
  });
});

test('root replacement during wx publication leaves the replacement root untouched', async t => {
  let f, moved; f = fixture(t, { writeExclusive(file, bytes) { writeFileSync(file, bytes, { flag: 'wx' }); moved = f.root + '-moved'; renameSync(f.root, moved); mkdirSync(f.root); } });
  t.after(() => { if (moved) rmSync(moved, { recursive: true, force: true }); }); const raw = seed(f, native(3));
  await assert.rejects(migrate(f.store), { code: 'ACCEPTANCE_OWNER_LOST', status: 503 }); assert.deepEqual(readdirSync(f.root), []); assert.deepEqual(readFileSync(join(moved, 'catalog.json')), raw);
});

test('strict previous lineage rejects skips, reverse schemas, retired generations and divergent but pure-valid history', async t => {
  for (const kind of ['skip', 'reverse', 'format', 'generation', 'entity', 'migration']) await t.test(kind, async t => {
    const f = fixture(t), v1 = native(1), v1raw = encode(v1), v2 = buildCatalogMigration(v1, { headSha256: hash(v1raw), at }), v2raw = encode(v2), v3 = buildCatalogMigrationV3(v2, { headSha256: hash(v2raw), previousSha256: hash(v1raw), at }), v3raw = encode(v3), v4 = buildCatalogMigrationV4(v3, { headSha256: hash(v3raw), previousSha256: hash(v2raw), at });
    let current = v4, previous = v3raw;
    if (kind === 'skip') previous = v2raw;
    if (kind === 'reverse') { current = v2; previous = v3raw; }
    if (kind === 'format') previous = Buffer.from(JSON.stringify(v3));
    if (kind === 'generation') { const prior = copy(v3); prior.generationId = uid('ag'); previous = encode(prior); }
    if (kind === 'entity') { const prior = copy(v3); append(prior, 'projects', { id: uid('ap'), name: '分叉项目', createdAt: at }, 'project-created', null); prior.events.at(-1).projectId = prior.events.at(-1).entityId; previous = encode(prior); }
    if (kind === 'migration') { const prior = copy(v4); prior.migrations = {}; prior.events = []; prior.revision = 0; current = prior; previous = encode(v4); }
    seed(f, current, previous); const raw = bytesOf(f), priorRaw = bytesOf(f, 'catalog.previous.json');
    await assert.rejects(f.store.initialize(), unavailable); await assert.rejects(f.store.previewMigration({ targetSchemaVersion: 4 }), unavailable);
    assert.deepEqual(bytesOf(f), raw); assert.deepEqual(bytesOf(f, 'catalog.previous.json'), priorRaw); assert.deepEqual(archives(f), []);
  });
});

test('full native and migrated Spec history keeps entity/digest/source bytes and permits the original prepare contract after v4 migration', async t => {
  const archivedRun = 'ac-2424d160-cf8e-4991-8fba-c972a84becd1';
  const archivedRoot = requiredDir('2026-10-16/evidence/acceptance-catalog/console/run-evidence');
  for (const origin of ['native-v2', 'migrated-v2']) await t.test(origin, async t => {
    const f = fixture(t), runDir = join(f.root, archivedRun); cpSync(join(archivedRoot, archivedRun), runDir, { recursive: true });
    const originalFiles = Object.fromEntries(readdirSync(runDir).map(name => [name, readFileSync(join(runDir, name))]));
    const material = readSpecCandidateSource(archivedRun, { root: f.root, owner: f.owner }), v1raw = encode(native(1));
    const old = origin === 'native-v2' ? native(2) : buildCatalogMigration(JSON.parse(v1raw), { headSha256: hash(v1raw), at });
    if (origin === 'migrated-v2') writeFileSync(join(f.root, archiveName(v1raw)), v1raw);
    const project = { id: uid('ap'), name: '完整 Spec 历史', createdAt: at }, release = { id: uid('ar'), projectId: project.id, label: '原版本', targetUrl: material.snapshot.manifest.targetUrl, createdAt: at };
    append(old, 'projects', project, 'project-created', project.id); append(old, 'releases', release, 'release-created', project.id);
    append(old, 'runBindings', { runId: archivedRun, projectId: project.id, releaseId: release.id, boundAt: at, actor: { kind: 'local-operator' } }, 'run-bound', project.id);
    const { projection } = projectSpecBaselineCandidate(material, { projectId: project.id, releaseId: release.id, sourceSide: 'source' });
    const candidate = { id: uid('ab'), ...projection, createdAt: at }, approval = { id: uid('aa'), projectId: project.id, candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: '已审阅需求', approvedAt: at, actor: { kind: 'local-operator' } };
    append(old, 'candidates', candidate, 'candidate-created', project.id); append(old, 'approvals', approval, 'baseline-approved', project.id);
    let selected = null, ancestor;
    for (const approvalId of [approval.id, null, approval.id]) {
      const selection = { id: uid('as'), projectId: project.id, mode: 'spec', approvalId, previousSelectionId: selected?.id ?? null, reason: approvalId ? '明确选用' : '取消选用', selectedAt: at, actor: { kind: 'local-operator' } };
      ancestor = copy(old); append(old, 'selections', selection, 'baseline-selected', project.id); selected = selection;
    }
    validateAcceptanceCatalog(old); const raw = seed(f, old, ancestor), current = (await migrate(f.store)).catalog; assertPreserved(old, current);
    assert.deepEqual(currentSelectionsOf(current, project.id).spec, selected); assert.deepEqual(readFileSync(join(f.root, archiveName(raw))), raw);
    const view = f.store.readBaselineCandidate(project.id, candidate.id); assert.equal(view.diagnostics.eligible, true); assert.equal(view.candidate.contentDigest, candidate.contentDigest);
    const prepared = await f.store.prepareManagedSpecDispatch(project.id, { ...cas(current), operationId: uid('ao'), selectionId: selected.id, contentDigest: approval.contentDigest, targetReleaseId: release.id });
    assert.equal(prepared.state, 'prepared'); assert.equal(prepared.runCreated, false); assert.equal(prepared.executionReady, false); assert.equal(prepared.record.envelope.approval.contentDigest, approval.contentDigest);
    assert.deepEqual(bytesOf(f), encode(current)); for (const [name, bytes] of Object.entries(originalFiles)) assert.deepEqual(readFileSync(join(runDir, name)), bytes, name);
    assert.deepEqual(readdirSync(runDir).sort(), Object.keys(originalFiles).sort()); assert.equal(Object.keys(current.migrations).length, origin === 'native-v2' ? 2 : 3);
  });
});
