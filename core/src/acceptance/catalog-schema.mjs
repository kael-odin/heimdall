/** Pure, versioned catalog validation and construction; no filesystem access. */
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { normalizeAcceptanceUrl } from './urls.mjs';
import { hashAcceptanceValue } from './identity.mjs';

export const ACCEPTANCE_CATALOG_LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024, manifestBytes: 8 * 1024 * 1024,
  projects: 64, releases: 1024, runBindings: 4096, candidates: 1024, approvals: 2048, selections: 4096,
  migrations: 1, events: 8192, queue: 32 });
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDS = Object.fromEntries(['ag', 'ap', 'ar', 'ac', 'ae', 'ab', 'aa', 'as', 'am'].map(prefix => [prefix, new RegExp(`^${prefix}-${UUID}$`)]));
const HASH = /^[a-f0-9]{64}$/;
const sha256 = value => typeof value === 'string' && HASH.test(value);
const BASE_MAPS = ['projects', 'releases', 'runBindings'];
const EXTRA_MAPS = ['candidates', 'approvals', 'selections', 'migrations'];
const V1_FIELDS = ['schemaVersion', 'generationId', 'revision', ...BASE_MAPS, 'events'];
const V2_FIELDS = [...V1_FIELDS, ...EXTRA_MAPS];
const EVENT_FIELDS = ['id', 'revision', 'kind', 'projectId', 'entityId', 'entityDigest', 'at', 'actor'];
const GLOBAL_EVENT_FIELDS = EVENT_FIELDS.filter(key => key !== 'projectId');
const MIGRATION_FIELDS = ['id', 'fromSchemaVersion', 'toSchemaVersion', 'fromGenerationId', 'fromRevision',
  'sourceHeadSha256', 'sourcePreviousSha256', 'createdAt', 'actor'];
const CANDIDATE_DIGESTS = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'scopeKey',
  'ruleManifestKey', 'oracleManifestKey', 'environmentKey', 'verifierFingerprint', 'contentDigest'];
const CANDIDATE_FIELDS = ['id', 'projectId', 'mode', 'projectionVersion', 'source', ...CANDIDATE_DIGESTS, 'createdAt'];
const APPROVAL_FIELDS = ['id', 'projectId', 'candidateId', 'contentDigest', 'reason', 'approvedAt', 'actor'];
const SELECTION_FIELDS = ['id', 'projectId', 'mode', 'approvalId', 'previousSelectionId', 'reason', 'selectedAt', 'actor'];

/** Stable candidate content, excluding the storage identity and creation time. */
export function candidateProjectionOf(candidate) {
  const { id: _id, createdAt: _at, ...projection } = candidate;
  return projection;
}
export function currentSelectionsOf(catalog, projectId) {
  let spec = null;
  for (const event of catalog.events) {
    if (event.projectId === projectId && event.kind === 'baseline-selected') spec = catalog.selections[event.entityId];
  }
  return { spec };
}

export const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export const iso = value => {
  if (typeof value !== 'string' || value.length !== 24) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
export const boundedText = (value, max) => typeof value === 'string' && value.trim() === value && !!value && value.length <= max;

export class AcceptanceCatalogError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.name = 'AcceptanceCatalogError'; this.code = code; this.status = status;
    if (details) this.details = details;
  }
}
export const error = (code, status, message, details) => new AcceptanceCatalogError(code, status, message, details);
export const invalid = message => { throw error('INVALID_INPUT', 400, message); };
export const unavailable = reason => { throw error('CATALOG_UNAVAILABLE', 503, '项目目录不可用；原记录已保留。', { reason }); };

export function fields(value, allowed, required, fail) {
  if (!plain(value)) return fail('INVALID_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail('INVALID_FIELD');
  }
  if (required.some(key => !Object.hasOwn(descriptors, key))) return fail('MISSING_FIELD');
}
export const id = (value, prefix, fail = invalid) => IDS[prefix]?.test(typeof value === 'string' ? value : '') || fail('运行或目录 ID 无效。');
export function actor(value, fail) {
  fields(value, ['kind'], ['kind'], fail);
  if (value.kind !== 'local-operator') fail('INVALID_ACTOR');
}
export function url(value, fail) {
  try { return normalizeAcceptanceUrl(value); } catch { return fail('URL 必须是无凭据、无片段的完整 HTTP(S) 地址。'); }
}
export function limitsOf(input = {}) {
  fields(input, Object.keys(ACCEPTANCE_CATALOG_LIMITS), [], () => { throw new TypeError('Invalid catalog limits'); });
  const limits = { ...ACCEPTANCE_CATALOG_LIMITS, ...input };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0) || limits.queue < 1) throw new TypeError('Invalid catalog limits');
  return limits;
}
export function capacity(catalog, limits, fail) {
  for (const key of [...BASE_MAPS, ...EXTRA_MAPS, 'events']) {
    const count = key === 'events' ? catalog.events.length : Object.keys(catalog[key] ?? {}).length;
    if (count > limits[key]) fail(key);
  }
}

function mapEntries(value, fail) {
  if (!plain(value)) fail('INVALID_MAP');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_MAP');
  }
  return Object.entries(value);
}
function eventsOf(value, fail) {
  if (!Array.isArray(value) || types.isProxy(value)) fail('INVALID_EVENTS');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== value.length + 1 || keys.some(key => {
    const descriptor = descriptors[key];
    return typeof key !== 'string' || !Object.hasOwn(descriptor, 'value') || key !== 'length'
      && (!descriptor.enumerable || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length);
  })) fail('INVALID_EVENTS');
  return value;
}
function validate(catalog, schemaVersion, limits) {
  const fail = unavailable, rootFields = schemaVersion === 1 ? V1_FIELDS : V2_FIELDS;
  fields(catalog, rootFields, rootFields, fail);
  if (catalog.schemaVersion !== schemaVersion) fail('UNSUPPORTED_SCHEMA');
  id(catalog.generationId, 'ag', fail);
  if (!Number.isSafeInteger(catalog.revision) || catalog.revision < 0) fail('INVALID_REVISION');
  const entries = Object.fromEntries([...BASE_MAPS, ...(schemaVersion === 2 ? EXTRA_MAPS : [])]
    .map(key => [key, mapEntries(catalog[key], fail)]));
  const { projects, releases, runBindings } = catalog, events = eventsOf(catalog.events, fail);
  capacity(catalog, limits, () => fail('CAPACITY_EXCEEDED'));
  for (const [key, project] of entries.projects) {
    id(key, 'ap', fail); fields(project, ['id', 'name', 'createdAt'], ['id', 'name', 'createdAt'], fail);
    if (project.id !== key || !boundedText(project.name, 120) || !iso(project.createdAt)) fail('INVALID_PROJECT');
  }
  for (const [key, release] of entries.releases) {
    id(key, 'ar', fail); fields(release, ['id', 'projectId', 'label', 'targetUrl', 'buildRef', 'createdAt'],
      ['id', 'projectId', 'label', 'targetUrl', 'createdAt'], fail);
    id(release.projectId, 'ap', fail);
    if (release.id !== key || !Object.hasOwn(projects, release.projectId) || !boundedText(release.label, 120)
      || !iso(release.createdAt) || url(release.targetUrl, fail) !== release.targetUrl
      || Object.hasOwn(release, 'buildRef') && !boundedText(release.buildRef, 200)) fail('INVALID_RELEASE');
  }
  for (const [key, binding] of entries.runBindings) {
    id(key, 'ac', fail); fields(binding, ['runId', 'projectId', 'releaseId', 'boundAt', 'actor'], ['runId', 'projectId', 'releaseId', 'boundAt', 'actor'], fail);
    id(binding.projectId, 'ap', fail); id(binding.releaseId, 'ar', fail); actor(binding.actor, fail);
    if (binding.runId !== key || !Object.hasOwn(projects, binding.projectId) || !Object.hasOwn(releases, binding.releaseId)
      || releases[binding.releaseId].projectId !== binding.projectId || !iso(binding.boundAt)) fail('INVALID_BINDING');
  }
  if (schemaVersion === 2) {
    for (const [key, candidate] of entries.candidates) {
      id(key, 'ab', fail); fields(candidate, CANDIDATE_FIELDS, CANDIDATE_FIELDS, fail);
      id(candidate.projectId, 'ap', fail);
      fields(candidate.source, ['runId', 'sourceMode', 'side', 'releaseId'], ['runId', 'sourceMode', 'side', 'releaseId'], fail);
      id(candidate.source.runId, 'ac', fail); id(candidate.source.releaseId, 'ar', fail);
      const binding = runBindings[candidate.source.runId];
      if (candidate.id !== key || !Object.hasOwn(projects, candidate.projectId) || candidate.mode !== 'spec'
        || candidate.projectionVersion !== 1 || candidate.source.sourceMode !== 'spec' || candidate.source.side !== 'source'
        || !binding || binding.projectId !== candidate.projectId || binding.releaseId !== candidate.source.releaseId
        || !iso(candidate.createdAt) || CANDIDATE_DIGESTS.some(field => !sha256(candidate[field]))) fail('INVALID_CANDIDATE');
      const { contentDigest: _digest, ...content } = candidateProjectionOf(candidate);
      if (hashAcceptanceValue(content) !== candidate.contentDigest) fail('CANDIDATE_DIGEST_MISMATCH');
    }
    for (const [key, approval] of entries.approvals) {
      id(key, 'aa', fail); fields(approval, APPROVAL_FIELDS, APPROVAL_FIELDS, fail);
      id(approval.projectId, 'ap', fail); id(approval.candidateId, 'ab', fail); actor(approval.actor, fail);
      const candidate = catalog.candidates[approval.candidateId];
      if (approval.id !== key || !candidate || candidate.projectId !== approval.projectId
        || approval.contentDigest !== candidate.contentDigest || !boundedText(approval.reason, 1000)
        || !iso(approval.approvedAt)) fail('INVALID_APPROVAL');
    }
    for (const [key, selection] of entries.selections) {
      id(key, 'as', fail); fields(selection, SELECTION_FIELDS, SELECTION_FIELDS, fail);
      id(selection.projectId, 'ap', fail); actor(selection.actor, fail);
      if (selection.previousSelectionId !== null) id(selection.previousSelectionId, 'as', fail);
      if (selection.approvalId !== null) id(selection.approvalId, 'aa', fail);
      const approval = selection.approvalId === null ? null : catalog.approvals[selection.approvalId];
      if (selection.id !== key || !Object.hasOwn(projects, selection.projectId) || selection.mode !== 'spec'
        || selection.approvalId !== null && (!approval || approval.projectId !== selection.projectId)
        || !boundedText(selection.reason, 1000) || !iso(selection.selectedAt)) fail('INVALID_SELECTION');
    }
    if (entries.migrations.length > 1) fail('INVALID_MIGRATION_COUNT');
    for (const [key, migration] of entries.migrations) {
      id(key, 'am', fail); fields(migration, MIGRATION_FIELDS, MIGRATION_FIELDS, fail);
      id(migration.fromGenerationId, 'ag', fail); actor(migration.actor, fail);
      if (migration.id !== key || migration.fromSchemaVersion !== 1 || migration.toSchemaVersion !== 2
        || migration.fromGenerationId === catalog.generationId || !Number.isSafeInteger(migration.fromRevision)
        || migration.fromRevision < 0 || !sha256(migration.sourceHeadSha256)
        || migration.sourcePreviousSha256 !== null && !sha256(migration.sourcePreviousSha256)
        || !iso(migration.createdAt)) fail('INVALID_MIGRATION');
    }
  }
  const entityCount = Object.values(entries).reduce((total, list) => total + list.length, 0);
  if (events.length !== catalog.revision || events.length !== entityCount) fail('EVENT_HISTORY_MISMATCH');
  const eventIds = new Set(), entities = new Set(), seenProjects = new Set(), seenReleases = new Set();
  const seenBindings = new Set(), seenCandidates = new Set(), seenApprovals = new Set(), selected = new Map();
  let seenBaselineEvent = false;
  for (const [index, event] of events.entries()) {
    fields(event, EVENT_FIELDS, GLOBAL_EVENT_FIELDS, fail);
    const migrationEvent = event.kind === 'catalog-migrated';
    const eventFields = migrationEvent ? GLOBAL_EVENT_FIELDS : EVENT_FIELDS;
    fields(event, eventFields, eventFields, fail);
    id(event.id, 'ae', fail); actor(event.actor, fail);
    if (!migrationEvent) id(event.projectId, 'ap', fail);
    if (event.revision !== index + 1 || eventIds.has(event.id) || entities.has(event.entityId)
      || !sha256(event.entityDigest) || !iso(event.at)) fail('INVALID_EVENT');
    let entity;
    if (event.kind === 'project-created') {
      id(event.entityId, 'ap', fail); entity = projects[event.entityId];
      if (!entity || entity.id !== event.projectId) fail('INVALID_EVENT_REFERENCE');
      seenProjects.add(entity.id);
    } else if (event.kind === 'release-created') {
      id(event.entityId, 'ar', fail); entity = releases[event.entityId];
      if (!entity || entity.projectId !== event.projectId || !seenProjects.has(entity.projectId)) fail('INVALID_EVENT_REFERENCE');
      seenReleases.add(entity.id);
    } else if (event.kind === 'run-bound') {
      id(event.entityId, 'ac', fail); entity = runBindings[event.entityId];
      if (!entity || entity.projectId !== event.projectId || !seenReleases.has(entity.releaseId)) fail('INVALID_EVENT_REFERENCE');
      seenBindings.add(entity.runId);
    } else if (event.kind === 'candidate-created' && schemaVersion === 2) {
      id(event.entityId, 'ab', fail); entity = catalog.candidates[event.entityId];
      if (!entity || entity.projectId !== event.projectId || !seenBindings.has(entity.source.runId)) fail('INVALID_EVENT_REFERENCE');
      seenCandidates.add(entity.id);
      seenBaselineEvent = true;
    } else if (event.kind === 'baseline-approved' && schemaVersion === 2) {
      id(event.entityId, 'aa', fail); entity = catalog.approvals[event.entityId];
      if (!entity || entity.projectId !== event.projectId || !seenCandidates.has(entity.candidateId)) fail('INVALID_EVENT_REFERENCE');
      seenApprovals.add(entity.id);
      seenBaselineEvent = true;
    } else if (event.kind === 'baseline-selected' && schemaVersion === 2) {
      id(event.entityId, 'as', fail); entity = catalog.selections[event.entityId];
      const previous = selected.get(event.projectId) ?? null;
      if (!entity || entity.projectId !== event.projectId || entity.approvalId !== null && !seenApprovals.has(entity.approvalId)
        || entity.previousSelectionId !== (previous?.id ?? null) || entity.approvalId === (previous?.approvalId ?? null)) fail('INVALID_SELECTION_CHAIN');
      selected.set(event.projectId, entity);
      seenBaselineEvent = true;
    } else if (migrationEvent && schemaVersion === 2) {
      id(event.entityId, 'am', fail); entity = catalog.migrations[event.entityId];
      if (!entity || entity.fromRevision !== index || seenBaselineEvent) fail('INVALID_MIGRATION_EVENT');
    } else fail('INVALID_EVENT_KIND');
    if ((entity.createdAt ?? entity.boundAt ?? entity.approvedAt ?? entity.selectedAt) !== event.at
      || hashAcceptanceValue(entity) !== event.entityDigest) fail('ENTITY_HISTORY_MISMATCH');
    eventIds.add(event.id); entities.add(event.entityId);
  }
  return catalog;
}

/** Accept only the original B1 shape, including its one-event-per-entity rule. */
export function validateAcceptanceCatalogV1(catalog, { limits = {} } = {}) {
  return validate(catalog, 1, limitsOf(limits));
}
/** B2.1 validates immutable Spec candidates, approvals and ordered selections. */
export function validateAcceptanceCatalogV2(catalog, { limits = {} } = {}) {
  return validate(catalog, 2, limitsOf(limits));
}
export function validateAcceptanceCatalog(catalog, { limits = {} } = {}) {
  fields(catalog, V2_FIELDS, V1_FIELDS, unavailable);
  if (![1, 2].includes(catalog.schemaVersion)) unavailable('UNSUPPORTED_SCHEMA');
  return validate(catalog, catalog.schemaVersion, limitsOf(limits));
}

/** Build a new value only. The caller supplies hashes of validated raw bytes. */
export function buildCatalogMigration(catalog, { headSha256, previousSha256 = null,
  at = new Date().toISOString(), limits: inputLimits = {} } = {}) {
  const limits = limitsOf(inputLimits);
  validate(catalog, 1, limits);
  if (!sha256(headSha256) || previousSha256 !== null && !sha256(previousSha256) || !iso(at)) invalid('目录迁移摘要或时间无效。');
  const migrated = JSON.parse(JSON.stringify(catalog));
  const migration = { id: 'am-' + randomUUID(), fromSchemaVersion: 1, toSchemaVersion: 2,
    fromGenerationId: catalog.generationId, fromRevision: catalog.revision,
    sourceHeadSha256: headSha256, sourcePreviousSha256: previousSha256, createdAt: at, actor: { kind: 'local-operator' } };
  migrated.schemaVersion = 2;
  do { migrated.generationId = 'ag-' + randomUUID(); } while (migrated.generationId === catalog.generationId);
  migrated.revision++;
  migrated.candidates = {}; migrated.approvals = {}; migrated.selections = {}; migrated.migrations = { [migration.id]: migration };
  migrated.events.push({ id: 'ae-' + randomUUID(), revision: migrated.revision, kind: 'catalog-migrated',
    entityId: migration.id, entityDigest: hashAcceptanceValue(migration), at, actor: { kind: 'local-operator' } });
  capacity(migrated, limits, limit => { throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限；历史记录未删除。', { limit }); });
  if (Buffer.byteLength(JSON.stringify(migrated, null, 2) + '\n') > limits.jsonBytes) {
    throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限；历史记录未删除。', { limit: 'jsonBytes' });
  }
  return validate(migrated, 2, limits);
}
