/**
 * Legal Browser entities originate in the four frozen real-source samples and the
 * real projector; this file does not fabricate zero-hash eligible material. Pure
 * catalog validation proves stored relationships and digest consistency, while
 * current source eligibility/freshness remains a reader/projector responsibility.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateAcceptanceCatalog, validateAcceptanceCatalogV1,
  validateAcceptanceCatalogV2, validateAcceptanceCatalogV3,
  buildCatalogMigration, buildCatalogMigrationV3, browserBindingProjectionOf,
} from '../src/acceptance/catalog-schema.mjs';
import { BROWSER_CANDIDATE_PROJECTION_V1 as identityConfiguration,
  hashBrowserCandidateValue } from '../src/acceptance/browser-candidate-identity.mjs';
import { BROWSER_CANDIDATE_PROJECTION_V1 as projectorConfiguration,
  projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';

const ROOT = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const AT = '2026-10-17T00:00:00.000Z';
const LATER = '2026-10-17T00:00:01.000Z';
const unavailable = { code: 'CATALOG_UNAVAILABLE', status: 503 };
const uid = prefix => `${prefix}-${randomUUID()}`;
const copy = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const rawHash = value => sha(JSON.stringify(value, null, 2) + '\n');
const digestFields = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest',
  'selectedEvidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey',
  'environmentKey', 'verifierFingerprint', 'sourceContentDigest'];
const bindingFields = ['id', 'projectId', 'releaseId', 'projectionVersion', 'source',
  ...digestFields, 'boundAt', 'actor'];
const sourceFields = ['runId', 'sourceMode', 'side', 'entryUrl'];
const validCases = [['matrix', 'baseline'], ['matrix', 'target'],
  ['target-unavailable', 'baseline'], ['baseline-unavailable', 'target']];
const projectionCache = new Map();
const references = report => [...new Set(report.checks.flatMap(check =>
  Object.values(check.evidence ?? {})).filter(file => file !== null))];

async function loadSource(sample = 'matrix') {
  const dir = join(ROOT, sample);
  const [manifest, report, integrity] = await Promise.all(
    ['manifest.json', 'report.json', 'integrity.json']
      .map(async file => JSON.parse(await readFile(join(dir, file)))));
  const names = ['manifest.json', 'report.json', ...references(report)];
  const files = new Map(await Promise.all(names.map(async file =>
    [file, await readFile(join(dir, file))])));
  return { snapshot: { manifest, report, integrity }, files };
}

async function realProjection(sample = 'matrix', side = 'baseline') {
  const key = `${sample}/${side}`;
  if (!projectionCache.has(key)) projectionCache.set(key, loadSource(sample).then(source =>
    projectBrowserBaselineCandidate(source, { sourceSide: side })));
  // Mutating a negative case must not contaminate another test or the cached result.
  return copy(await projectionCache.get(key));
}

function empty(version = 3) {
  return { schemaVersion: version, generationId: uid('ag'), revision: 0,
    projects: {}, releases: {}, runBindings: {},
    ...(version >= 2 ? { candidates: {}, approvals: {}, selections: {}, migrations: {} } : {}),
    ...(version === 3 ? { browserSourceBindings: {} } : {}), events: [] };
}

function append(catalog, map, entity, kind, projectId) {
  const entityId = entity.id ?? entity.runId;
  catalog[map][entityId] = entity;
  catalog.events.push({ id: uid('ae'), revision: ++catalog.revision, kind,
    ...(projectId ? { projectId } : {}), entityId,
    entityDigest: hashAcceptanceValue(entity),
    at: entity.createdAt ?? entity.boundAt ?? entity.approvedAt ?? entity.selectedAt,
    actor: { kind: 'local-operator' } });
  return entity;
}

function organization(catalog, entryUrl, existingProject) {
  const project = existingProject ?? append(catalog, 'projects', {
    id: uid('ap'), name: 'Browser 来源归属 schema fixture', createdAt: AT,
  }, 'project-created');
  if (!existingProject) catalog.events.at(-1).projectId = project.id;
  const release = append(catalog, 'releases', {
    id: uid('ar'), projectId: project.id, label: '明确的完整入口版本',
    targetUrl: entryUrl, createdAt: AT,
  }, 'release-created', project.id);
  return { project, release };
}

function oldRun(catalog, runId, org) {
  return append(catalog, 'runBindings', { runId, projectId: org.project.id,
    releaseId: org.release.id, boundAt: AT, actor: { kind: 'local-operator' } },
  'run-bound', org.project.id);
}

function bindingFrom(projection, org) {
  return { id: uid('ax'), projectId: org.project.id, releaseId: org.release.id,
    projectionVersion: projection.projectionVersion,
    source: copy(projection.source),
    sourcePlanDigest: projection.sourcePlanDigest,
    sourceReportDigest: projection.sourceReportDigest,
    evidenceManifestDigest: projection.evidenceManifestDigest,
    selectedEvidenceManifestDigest: projection.selectedEvidenceManifestDigest,
    scopeKey: projection.scopeKey, ruleManifestKey: projection.ruleManifestKey,
    oracleManifestKey: projection.oracleManifestKey, environmentKey: projection.environmentKey,
    verifierFingerprint: projection.verifierFingerprint,
    sourceContentDigest: projection.contentDigest,
    boundAt: AT, actor: { kind: 'local-operator' } };
}

function appendBrowser(catalog, projection, org) {
  return append(catalog, 'browserSourceBindings', bindingFrom(projection, org),
    'browser-source-bound', org.project.id);
}

async function fixtureCatalog({ sample = 'matrix', side = 'baseline' } = {}) {
  const { projection, preview } = await realProjection(sample, side);
  const catalog = empty(), org = organization(catalog, projection.source.entryUrl);
  const binding = appendBrowser(catalog, projection, org);
  return { catalog, org, binding, projection, preview };
}

function rehash(catalog, entityId, entity) {
  const event = catalog.events.find(item => item.entityId === entityId);
  assert.ok(event, `fixture has an event for ${entityId}`);
  event.entityDigest = hashAcceptanceValue(entity);
}

function rehashBinding(catalog, bindingId) {
  rehash(catalog, bindingId, catalog.browserSourceBindings[bindingId]);
}

// This test-side field list is independent of browserBindingProjectionOf. In
// particular, mode must be reconstructed and organization fields stay excluded.
function contentOf(binding) {
  return { projectionVersion: binding.projectionVersion, mode: 'browser',
    source: { runId: binding.source.runId, sourceMode: binding.source.sourceMode,
      side: binding.source.side, entryUrl: binding.source.entryUrl },
    sourcePlanDigest: binding.sourcePlanDigest,
    sourceReportDigest: binding.sourceReportDigest,
    evidenceManifestDigest: binding.evidenceManifestDigest,
    selectedEvidenceManifestDigest: binding.selectedEvidenceManifestDigest,
    scopeKey: binding.scopeKey, ruleManifestKey: binding.ruleManifestKey,
    oracleManifestKey: binding.oracleManifestKey, environmentKey: binding.environmentKey,
    verifierFingerprint: binding.verifierFingerprint };
}

function explicitBrowserDigest(value, overrides = {}) {
  return hashAcceptanceValue({ projectionVersion: 1, canonicalJsonVersion: 'acceptance-json-v1',
    digestAlgorithm: 'sha256', domain: 'heimdall-acceptance-browser-candidate',
    kind: 'content', value, ...overrides });
}

function refreshSourceDigest(catalog, bindingId) {
  const binding = catalog.browserSourceBindings[bindingId];
  binding.sourceContentDigest = explicitBrowserDigest(contentOf(binding));
  rehashBinding(catalog, bindingId);
}

function reindex(catalog) {
  catalog.revision = catalog.events.length;
  for (const [index, event] of catalog.events.entries()) {
    event.revision = index + 1;
    if (event.kind === 'catalog-migrated') {
      const migration = catalog.migrations[event.entityId];
      migration.fromRevision = index;
      event.entityDigest = hashAcceptanceValue(migration);
    }
  }
}

function reject(catalog, label) {
  assert.throws(() => validateAcceptanceCatalog(catalog), unavailable, label);
  assert.throws(() => validateAcceptanceCatalogV3(catalog), unavailable, label);
}

function accept(catalog) {
  assert.equal(validateAcceptanceCatalog(catalog), catalog);
  assert.equal(validateAcceptanceCatalogV3(catalog), catalog);
}

function addSpecHistory(catalog, org, browserProjection) {
  const run = oldRun(catalog, uid('ac'), org);
  const projection = { projectId: org.project.id, mode: 'spec', projectionVersion: 1,
    source: { runId: run.runId, sourceMode: 'spec', side: 'source', releaseId: org.release.id },
    ...Object.fromEntries(digestFields.filter(field =>
      !['sourceContentDigest', 'selectedEvidenceManifestDigest'].includes(field))
      .map(field => [field, browserProjection[field]])) };
  const candidate = append(catalog, 'candidates', { id: uid('ab'), ...projection,
    contentDigest: hashAcceptanceValue(projection), createdAt: AT }, 'candidate-created', org.project.id);
  const approval = append(catalog, 'approvals', { id: uid('aa'), projectId: org.project.id,
    candidateId: candidate.id, contentDigest: candidate.contentDigest,
    reason: '保留现有 Spec 审批合同', approvedAt: AT, actor: { kind: 'local-operator' } },
  'baseline-approved', org.project.id);
  const selection = append(catalog, 'selections', { id: uid('as'), projectId: org.project.id,
    mode: 'spec', approvalId: approval.id, previousSelectionId: null,
    reason: '保留现有 Spec 选用链', selectedAt: AT, actor: { kind: 'local-operator' } },
  'baseline-selected', org.project.id);
  return { candidate, approval, selection };
}

test('all four frozen samples preserve original bytes; only genuinely eligible sides supply legal entities', async () => {
  const index = JSON.parse(await readFile(join(ROOT, 'source-index.json')));
  assert.equal(index.kind, 'frozen-real-browser-source-material');
  assert.deepEqual(index.samples.map(sample => sample.id).sort(),
    ['matrix', 'target-unavailable', 'baseline-unavailable', 'assertion-failed'].sort());
  for (const sample of index.samples) {
    const actualNames = (await readdir(join(ROOT, sample.id)))
      .filter(file => file !== 'integrity.json').sort();
    assert.deepEqual(actualNames, sample.files.map(entry => entry.file).sort());
    for (const entry of sample.files) {
      const data = await readFile(join(ROOT, sample.id, entry.file));
      assert.equal(data.length, entry.bytes, `${sample.id}/${entry.file}`);
      assert.equal(sha(data), entry.sha256, `${sample.id}/${entry.file}`);
    }
    const source = await loadSource(sample.id);
    assert.equal(source.snapshot.report.runId, sample.runId);
    assert.equal(sha(source.files.get('report.json')), sample.reportSha256);
  }
  for (const [sample, side] of validCases) {
    const { catalog, preview } = await fixtureCatalog({ sample, side });
    assert.equal(preview.executionReady, false);
    assert.ok(['failed', 'blocked'].includes(preview.sourceGate));
    assert.deepEqual(catalog.runBindings, {});
    accept(catalog);
  }
  for (const [sample, side] of [['target-unavailable', 'target'],
    ['baseline-unavailable', 'baseline'], ['assertion-failed', 'baseline'], ['assertion-failed', 'target']]) {
    const source = await loadSource(sample);
    assert.throws(() => projectBrowserBaselineCandidate(source, { sourceSide: side }), error =>
      error.code === 'SOURCE_NOT_ELIGIBLE' && error.status === 409
      && error.details?.reason === 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE', `${sample}/${side}`);
  }
});

test('real source records reconstruct exact projections with independent Browser domain and unchanged golden hashes', async () => {
  assert.equal(projectorConfiguration, identityConfiguration);
  assert.equal(Object.isFrozen(identityConfiguration), true);
  assert.deepEqual(identityConfiguration, { projectionVersion: 1, canonicalJsonVersion: 'acceptance-json-v1',
    digestAlgorithm: 'sha256', domain: 'heimdall-acceptance-browser-candidate' });
  const golden = { baseline: '62a5381abd2c9f604bc88d14c641ff833284bf6ac9ad6a4a1e6db1123ba5d103',
    target: 'ecf2a93ccee1719beb31675620eeea16450fe7a4a743078802c4c94a94b7aed5' };
  for (const [sample, side] of validCases) {
    const { catalog, binding, projection } = await fixtureCatalog({ sample, side });
    const saved = copy(binding), expectedContent = contentOf(binding);
    assert.deepEqual(Object.keys(binding).sort(), [...bindingFields].sort());
    assert.deepEqual(Object.keys(binding.source).sort(), [...sourceFields].sort());
    assert.deepEqual(browserBindingProjectionOf(binding), projection);
    assert.deepEqual(browserBindingProjectionOf(binding), { ...expectedContent,
      contentDigest: binding.sourceContentDigest });
    assert.equal(binding.sourceContentDigest, explicitBrowserDigest(expectedContent));
    assert.equal(hashBrowserCandidateValue('content', expectedContent), explicitBrowserDigest(expectedContent));
    assert.notEqual(binding.sourceContentDigest, hashAcceptanceValue(expectedContent));
    if (sample === 'matrix') assert.equal(binding.sourceContentDigest, golden[side]);
    assert.deepEqual(binding, saved);
    assert.equal(catalog.events.at(-1).entityDigest, hashAcceptanceValue(binding));
    assert.equal(Object.hasOwn(binding, 'mode'), false);
    assert.equal(Object.hasOwn(binding, 'contentDigest'), false);
    assert.equal(Object.hasOwn(binding, 'preview'), false);
    accept(catalog);
  }
});

test('Browser entity, source and actor have exact required field sets even after rehashing the event', async () => {
  const original = await fixtureCatalog();
  for (const field of bindingFields) {
    const { catalog, binding } = copy(original);
    delete catalog.browserSourceBindings[binding.id][field];
    rehashBinding(catalog, binding.id);
    reject(catalog, `missing binding.${field}`);
  }
  for (const [field, value] of [['mode', 'browser'], ['contentDigest', original.binding.sourceContentDigest],
    ['preview', {}], ['plan', {}], ['files', []], ['owner', {}], ['executionReady', false]]) {
    const { catalog, binding } = copy(original);
    catalog.browserSourceBindings[binding.id][field] = value;
    rehashBinding(catalog, binding.id);
    reject(catalog, `extra binding.${field}`);
  }
  for (const field of sourceFields) {
    const { catalog, binding } = copy(original);
    delete catalog.browserSourceBindings[binding.id].source[field];
    rehashBinding(catalog, binding.id);
    reject(catalog, `missing source.${field}`);
  }
  for (const [field, value] of [['releaseId', original.org.release.id], ['projectId', original.org.project.id],
    ['mode', 'browser'], ['sourceSide', 'baseline'], ['observedFinalUrl', original.binding.source.entryUrl]]) {
    const { catalog, binding } = copy(original);
    catalog.browserSourceBindings[binding.id].source[field] = value;
    rehashBinding(catalog, binding.id);
    reject(catalog, `extra source.${field}`);
  }
  for (const mutate of [actor => { delete actor.kind; }, actor => { actor.reason = 'unsupported'; }]) {
    const { catalog, binding } = copy(original);
    mutate(catalog.browserSourceBindings[binding.id].actor);
    rehashBinding(catalog, binding.id);
    reject(catalog, 'strict actor');
  }
});

test('unsafe Browser maps, records, nested containers and scalars fail without evaluating user hooks', async () => {
  const original = await fixtureCatalog();
  let hooks = 0;
  const unsafe = () => new Proxy({}, { get() { hooks++; throw new Error('get trap'); },
    ownKeys() { hooks++; throw new Error('keys trap'); },
    getPrototypeOf() { hooks++; throw new Error('prototype trap'); } });
  const mutations = [
    ({ catalog }) => { catalog.browserSourceBindings = unsafe(); },
    ({ catalog, binding }) => { catalog.browserSourceBindings[binding.id] = unsafe(); },
    ({ catalog, binding }) => { catalog.browserSourceBindings[binding.id].source = unsafe(); },
    ({ catalog, binding }) => { catalog.browserSourceBindings[binding.id].actor = unsafe(); },
    ({ catalog, binding }) => { Object.defineProperty(catalog.browserSourceBindings, binding.id,
      { enumerable: true, get() { hooks++; throw new Error('map getter'); } }); },
    ({ catalog, binding }) => { Object.defineProperty(catalog.browserSourceBindings[binding.id], 'sourceContentDigest',
      { enumerable: true, get() { hooks++; throw new Error('digest getter'); } }); },
    ({ catalog, binding }) => { Object.defineProperty(catalog.browserSourceBindings[binding.id].source, 'entryUrl',
      { enumerable: true, get() { hooks++; throw new Error('source getter'); } }); },
    ({ catalog, binding }) => { Object.defineProperty(catalog.browserSourceBindings[binding.id].actor, 'kind',
      { enumerable: true, get() { hooks++; throw new Error('actor getter'); } }); },
    ({ catalog, binding }) => { catalog.browserSourceBindings[binding.id].source.sourceMode =
      { toString() { hooks++; throw new Error('coercion'); } }; },
    ({ catalog, binding }) => { catalog.browserSourceBindings[binding.id].sourceContentDigest =
      { toString() { hooks++; throw new Error('digest coercion'); } }; },
  ];
  for (const mutate of mutations) {
    const value = copy(original); mutate(value);
    // Do not hash an unsafe object here: the validator itself must reject it first.
    reject(value.catalog, 'unsafe Browser value');
    assert.equal(hooks, 0);
  }
  for (const target of ['map', 'record', 'source', 'actor']) for (const kind of ['symbol', 'hidden']) {
    const { catalog, binding } = copy(original);
    const record = catalog.browserSourceBindings[binding.id];
    const object = { map: catalog.browserSourceBindings, record, source: record.source, actor: record.actor }[target];
    if (kind === 'symbol') object[Symbol('unsupported')] = true;
    else Object.defineProperty(object, 'hidden', { value: true, enumerable: false });
    reject(catalog, `${target}/${kind}`);
  }
  for (const field of ['projectionVersion', ...digestFields]) for (const value of [Symbol('value'), 1n, unsafe()]) {
    const { catalog, binding } = copy(original);
    catalog.browserSourceBindings[binding.id][field] = value;
    reject(catalog, `unsafe scalar ${field}`);
    assert.equal(hooks, 0);
  }
});

test('Browser identifiers, enum values, ISO time and every digest use strict scalar contracts', async () => {
  const original = await fixtureCatalog();
  const changes = [
    ['id', uid('ab')], ['id', original.binding.id.toUpperCase()],
    ['projectId', uid('ap')], ['releaseId', uid('ar')],
    ['projectionVersion', 0], ['projectionVersion', 2], ['projectionVersion', '1'],
    ['projectionVersion', null], ['boundAt', '2026-10-17'], ['boundAt', 'yesterday'],
    ['boundAt', 1792195200000], ['actor', null], ['actor', { kind: 'remote-operator' }],
  ];
  for (const [field, value] of changes) {
    const { catalog, binding } = copy(original);
    catalog.browserSourceBindings[binding.id][field] = value;
    rehashBinding(catalog, binding.id);
    reject(catalog, `invalid binding.${field}`);
  }
  for (const [field, value] of [
    ['runId', uid('ap')], ['runId', uid('ac').toUpperCase()], ['runId', null],
    ['sourceMode', 'spec'], ['sourceMode', 'managed'], ['sourceMode', 'browser'], ['sourceMode', null],
    ['side', 'source'], ['side', 'automatic'], ['side', null], ['side', 0],
    ['entryUrl', ''], ['entryUrl', null], ['entryUrl', '/baseline'],
  ]) {
    const { catalog, binding } = copy(original);
    catalog.browserSourceBindings[binding.id].source[field] = value;
    rehashBinding(catalog, binding.id);
    reject(catalog, `invalid source.${field}`);
  }
  for (const field of digestFields) for (const value of [
    'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '', null, 0, [], {},
  ]) {
    const { catalog, binding } = copy(original);
    catalog.browserSourceBindings[binding.id][field] = value;
    rehashBinding(catalog, binding.id);
    reject(catalog, `invalid digest ${field}`);
  }
  const nullPrototype = copy(original.catalog);
  nullPrototype.browserSourceBindings = Object.assign(Object.create(null), nullPrototype.browserSourceBindings);
  accept(nullPrototype);
});

test('Browser content digest binds every projection field and the exact domain instead of the Spec formula', async () => {
  const original = await fixtureCatalog();
  for (const field of digestFields) {
    const { catalog, binding } = copy(original), record = catalog.browserSourceBindings[binding.id];
    record[field] = sha(`deliberately changed ${field}:${record[field]}`);
    rehashBinding(catalog, binding.id);
    reject(catalog, `valid-looking changed hash ${field}`);
  }
  const content = contentOf(original.binding);
  const { mode: _mode, ...withoutMode } = content;
  const wrongDigests = [
    ['Spec direct hash', hashAcceptanceValue(content)],
    ['missing reconstructed mode', explicitBrowserDigest(withoutMode)],
    ['wrong domain', explicitBrowserDigest(content, { domain: 'heimdall-acceptance-spec-candidate' })],
    ['wrong kind', explicitBrowserDigest(content, { kind: 'candidate' })],
    ['wrong digest envelope version', explicitBrowserDigest(content, { projectionVersion: 2 })],
    ['organization included', explicitBrowserDigest({ ...content,
      projectId: original.org.project.id, releaseId: original.org.release.id })],
    ['storage identity included', explicitBrowserDigest({ ...content,
      id: original.binding.id, boundAt: original.binding.boundAt })],
  ];
  for (const [label, digest] of wrongDigests) {
    const { catalog, binding } = copy(original);
    assert.notEqual(digest, original.binding.sourceContentDigest, label);
    catalog.browserSourceBindings[binding.id].sourceContentDigest = digest;
    rehashBinding(catalog, binding.id);
    reject(catalog, label);
  }
  for (const [field, value] of [['sourceMode', 'mirror'], ['runId', uid('ac')],
    ['side', 'target'], ['entryUrl', original.binding.source.entryUrl + '?changed=1']]) {
    const { catalog, binding, org } = copy(original);
    catalog.browserSourceBindings[binding.id].source[field] = value;
    if (field === 'entryUrl') {
      catalog.releases[org.release.id].targetUrl = value;
      rehash(catalog, org.release.id, catalog.releases[org.release.id]);
    }
    rehashBinding(catalog, binding.id);
    reject(catalog, `source.${field} participates in the content digest`);
  }
});

test('Browser binding requires its exact project, release and normalized full planned entry URL', async () => {
  const original = await fixtureCatalog(), entry = original.binding.source.entryUrl;
  for (const value of [`${entry}/other`, `${entry}?tenant=one`, `${entry}?tenant=two`,
    `${entry}#fragment`, entry.replace('http:', 'HTTP:'), ` ${entry} `,
    entry.replace('http://', 'http://user:pass@')]) {
    const { catalog, binding } = copy(original);
    catalog.browserSourceBindings[binding.id].source.entryUrl = value;
    // Keep both the content and complete entity event digests self-consistent.
    refreshSourceDigest(catalog, binding.id);
    reject(catalog, `full planned URL: ${value}`);
  }
  for (const [plannedQuery, releaseQuery] of [
    ['?tenant=one&revision=two', '?revision=two&tenant=one'],
    ['?tenant=one', '?tenant=two'], ['?tenant=one', ''], ['', '?tenant=one'],
  ]) {
    const { catalog, binding, org } = copy(original);
    catalog.browserSourceBindings[binding.id].source.entryUrl = entry + plannedQuery;
    catalog.releases[org.release.id].targetUrl = entry + releaseQuery;
    rehash(catalog, org.release.id, catalog.releases[org.release.id]);
    refreshSourceDigest(catalog, binding.id);
    reject(catalog, 'query values and order are part of the complete normalized href');
  }
  const foreign = copy(original);
  const other = organization(foreign.catalog, entry);
  foreign.catalog.browserSourceBindings[foreign.binding.id].releaseId = other.release.id;
  rehashBinding(foreign.catalog, foreign.binding.id);
  reject(foreign.catalog, 'release belongs to another project despite identical URL');
});

test('run and explicit side are globally unique across projects and releases', async () => {
  const original = await fixtureCatalog();
  for (const scope of ['same release', 'different release', 'different project']) {
    const { catalog, org, projection } = copy(original);
    const target = scope === 'same release' ? org : organization(catalog, projection.source.entryUrl,
      scope === 'different release' ? org.project : undefined);
    const duplicate = appendBrowser(catalog, projection, target);
    assert.notEqual(duplicate.id, original.binding.id);
    assert.equal(catalog.events.at(-1).entityDigest, hashAcceptanceValue(duplicate));
    reject(catalog, scope);
  }
  const wrongMapKey = copy(original.catalog), key = original.binding.id;
  wrongMapKey.browserSourceBindings[uid('ax')] = wrongMapKey.browserSourceBindings[key];
  delete wrongMapKey.browserSourceBindings[key];
  reject(wrongMapKey, 'binding ID must equal its map key');
});

test('two source sides can belong to distinct projects without an inferred runBinding', async () => {
  const baseline = await realProjection('matrix', 'baseline');
  const target = await realProjection('matrix', 'target');
  const catalog = empty();
  const baselineOrg = organization(catalog, baseline.projection.source.entryUrl);
  const targetOrg = organization(catalog, target.projection.source.entryUrl);
  const left = appendBrowser(catalog, baseline.projection, baselineOrg);
  const right = appendBrowser(catalog, target.projection, targetOrg);
  assert.equal(left.source.runId, right.source.runId);
  assert.notEqual(left.source.side, right.source.side);
  assert.notEqual(left.projectId, right.projectId);
  assert.deepEqual(catalog.runBindings, {});
  assert.deepEqual(catalog.migrations, {});
  accept(catalog);
});

test('target compatibility is mandatory in both event orders while a foreign baseline never owns the old target', async () => {
  const { projection: target } = await realProjection('matrix', 'target');
  const { projection: baseline } = await realProjection('matrix', 'baseline');
  for (const order of ['old run first', 'Browser target first']) {
    for (const relationship of ['same', 'different release', 'different project']) {
      const catalog = empty(), browserOrg = organization(catalog, target.source.entryUrl);
      const runOrg = relationship === 'same' ? browserOrg : organization(catalog, target.source.entryUrl,
        relationship === 'different release' ? browserOrg.project : undefined);
      if (order === 'old run first') oldRun(catalog, target.source.runId, runOrg);
      appendBrowser(catalog, target, browserOrg);
      if (order === 'Browser target first') oldRun(catalog, target.source.runId, runOrg);
      if (relationship === 'same') accept(catalog);
      else reject(catalog, `${order}/${relationship}; same URL cannot substitute for IDs`);
    }
    const catalog = empty();
    const baselineOrg = organization(catalog, baseline.source.entryUrl);
    const targetOrg = organization(catalog, target.source.entryUrl);
    if (order === 'old run first') oldRun(catalog, target.source.runId, targetOrg);
    appendBrowser(catalog, baseline, baselineOrg);
    if (order === 'Browser target first') oldRun(catalog, target.source.runId, targetOrg);
    accept(catalog);
  }
});

test('Browser events bind one complete entity and exact project/time without weakening revision or ID rules', async () => {
  const original = await fixtureCatalog();
  const mutations = [
    catalog => { catalog.events.at(-1).entityDigest = sha('wrong full entity'); },
    catalog => { catalog.events.at(-1).entityId = uid('ax'); },
    catalog => { catalog.events.at(-1).projectId = uid('ap'); },
    catalog => { catalog.events.at(-1).at = LATER; },
    catalog => { catalog.events.at(-1).kind = 'run-bound'; },
    catalog => { catalog.events.at(-1).revision--; },
    catalog => { catalog.events.at(-1).id = catalog.events[0].id; },
    catalog => { catalog.events.at(-1).actor.kind = 'remote-operator'; },
    catalog => { catalog.revision++; },
    catalog => { catalog.events.pop(); reindex(catalog); },
    catalog => { delete catalog.browserSourceBindings[original.binding.id]; },
    catalog => { catalog.events.push(copy(catalog.events.at(-1))); reindex(catalog); },
  ];
  for (const mutate of mutations) {
    const catalog = copy(original.catalog); mutate(catalog);
    reject(catalog, 'Browser entity/event bijection');
  }
  const changedTime = copy(original.catalog);
  changedTime.browserSourceBindings[original.binding.id].boundAt = LATER;
  rehashBinding(changedTime, original.binding.id);
  reject(changedTime, 'full event digest alone cannot replace boundAt equality');
  const wrongProject = copy(original.catalog);
  const other = organization(wrongProject, original.binding.source.entryUrl);
  wrongProject.events.find(event => event.entityId === original.binding.id).projectId = other.project.id;
  reject(wrongProject, 'event must reference the binding project even when both projects exist');
});

test('Browser events require earlier project/release events and do not require an earlier old run-bound event', async () => {
  const original = await fixtureCatalog();
  for (const order of [[2, 0, 1], [0, 2, 1]]) {
    const catalog = copy(original.catalog);
    catalog.events = order.map(index => catalog.events[index]);
    reindex(catalog);
    reject(catalog, 'Browser event precedes a dependency');
  }
  const { projection } = await realProjection('matrix', 'target');
  const catalog = empty(), org = organization(catalog, projection.source.entryUrl);
  appendBrowser(catalog, projection, org);
  oldRun(catalog, projection.source.runId, org);
  assert.equal(catalog.events.at(-2).kind, 'browser-source-bound');
  assert.equal(catalog.events.at(-1).kind, 'run-bound');
  accept(catalog);
});

test('fresh V3 accepts Browser history while migrated histories require Browser events strictly after the 2-to-3 step', async () => {
  const { projection } = await realProjection();
  for (const fromV1 of [false, true]) {
    const legacy = empty(fromV1 ? 1 : 2);
    const org = organization(legacy, projection.source.entryUrl);
    const v2 = fromV1 ? buildCatalogMigration(legacy, {
      headSha256: rawHash(legacy), previousSha256: null, at: AT,
    }) : legacy;
    const prefix = copy(v2.events);
    const catalog = buildCatalogMigrationV3(v2, {
      headSha256: rawHash(v2), previousSha256: null, at: AT,
    });
    const binding = appendBrowser(catalog, projection, org);
    assert.deepEqual(catalog.events.slice(0, prefix.length), prefix);
    accept(catalog);
    const tooEarly = copy(catalog);
    const browserIndex = tooEarly.events.findIndex(event => event.entityId === binding.id);
    const [browserEvent] = tooEarly.events.splice(browserIndex, 1);
    const migrationIndex = tooEarly.events.findIndex(event => event.kind === 'catalog-migrated'
      && tooEarly.migrations[event.entityId].toSchemaVersion === 3);
    tooEarly.events.splice(migrationIndex, 0, browserEvent);
    // Update every index, fromRevision and migration digest so only phase order is wrong.
    reindex(tooEarly);
    assert.equal(tooEarly.events.length, Object.values(tooEarly.projects).length
      + Object.values(tooEarly.releases).length + Object.values(tooEarly.migrations).length
      + Object.values(tooEarly.browserSourceBindings).length);
    reject(tooEarly, fromV1 ? 'full 1-to-2-to-3 history' : 'native V2-to-V3 history');
    if (fromV1) {
      const beforeV2 = copy(catalog);
      const [event] = beforeV2.events.splice(beforeV2.events.findIndex(item => item.entityId === binding.id), 1);
      beforeV2.events.splice(beforeV2.events.findIndex(item => item.kind === 'catalog-migrated'), 0, event);
      reindex(beforeV2);
      reject(beforeV2, 'Browser entity cannot predate the 1-to-2 step either');
    }
  }
  const fresh = await fixtureCatalog();
  assert.deepEqual(fresh.catalog.migrations, {});
  accept(fresh.catalog);
});

test('V1 and V2 retain their strict old roots and reject empty or populated Browser maps and events', async () => {
  const { projection } = await realProjection();
  for (const version of [1, 2]) {
    const legacy = empty(version), org = organization(legacy, projection.source.entryUrl);
    const validateOld = version === 1 ? validateAcceptanceCatalogV1 : validateAcceptanceCatalogV2;
    assert.equal(validateOld(legacy), legacy);
    assert.equal(validateAcceptanceCatalog(legacy), legacy);
    for (const populated of [false, true]) {
      const catalog = copy(legacy);
      catalog.browserSourceBindings = {};
      if (populated) appendBrowser(catalog, projection, org);
      assert.throws(() => validateOld(catalog), unavailable);
      assert.throws(() => validateAcceptanceCatalog(catalog), unavailable);
    }
    const eventOnly = copy(legacy), binding = bindingFrom(projection, org);
    eventOnly.events.push({ id: uid('ae'), revision: ++eventOnly.revision,
      kind: 'browser-source-bound', projectId: org.project.id, entityId: binding.id,
      entityDigest: hashAcceptanceValue(binding), at: AT, actor: { kind: 'local-operator' } });
    assert.throws(() => validateOld(eventOnly), unavailable);
  }
  const fresh = await fixtureCatalog();
  assert.throws(() => validateAcceptanceCatalogV1(fresh.catalog), unavailable);
  assert.throws(() => validateAcceptanceCatalogV2(fresh.catalog), unavailable);
});

test('Browser source capacity and Spec-only candidate/approval/selection contracts remain independent', async () => {
  const { catalog, binding, org, projection } = await fixtureCatalog();
  assert.equal(validateAcceptanceCatalogV3(catalog, { limits: { browserSourceBindings: 1 } }), catalog);
  assert.throws(() => validateAcceptanceCatalogV3(catalog, { limits: { browserSourceBindings: 0 } }), unavailable);
  const spec = addSpecHistory(catalog, org, projection);
  accept(catalog);
  assert.equal(catalog.browserSourceBindings[binding.id].sourceContentDigest, projection.contentDigest);
  for (const mutate of [
    ({ candidate }) => { candidate.mode = 'browser'; },
    ({ candidate }) => { candidate.source.sourceMode = 'regression'; },
    ({ candidate }) => { candidate.source.side = 'target'; },
    ({ approval }) => { approval.mode = 'browser'; },
    ({ selection }) => { selection.mode = 'browser'; },
  ]) {
    const changed = copy(catalog), entities = {
      candidate: changed.candidates[spec.candidate.id], approval: changed.approvals[spec.approval.id],
      selection: changed.selections[spec.selection.id],
    };
    mutate(entities);
    const { id: _id, createdAt: _at, contentDigest: _digest, ...content } = entities.candidate;
    entities.candidate.contentDigest = hashAcceptanceValue(content);
    entities.approval.contentDigest = entities.candidate.contentDigest;
    for (const entity of Object.values(entities)) rehash(changed, entity.id, entity);
    reject(changed, 'Browser source binding does not admit Browser approval authority');
  }
});

test('importing pure catalog schema in an isolated process does not load the PNG dependency', () => {
  const schemaUrl = new URL('../src/acceptance/catalog-schema.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(import.meta.url)});
    await import(${JSON.stringify(schemaUrl)});
    assert.deepEqual(Object.keys(require.cache).filter(file =>
      file.replaceAll(String.fromCharCode(92), '/').includes('/pngjs/')), []);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
