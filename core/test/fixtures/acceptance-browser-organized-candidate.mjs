/** Format-only metadata fixture, never evidence of source eligibility or freshness.
 * The test-side canonical encoder deliberately does not import production hashes. */
import { createHash } from 'node:crypto';

export const AT = '2026-10-17T00:00:00.000Z';
export const LATER = '2026-10-17T00:00:01.000Z';
export const uid = (prefix, index) => `${prefix}-00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
export const copy = value => JSON.parse(JSON.stringify(value));
export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
export const independentHash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const organizedHash = (kind, value) => independentHash({ candidateContractVersion: 1,
  canonicalJsonVersion: 'acceptance-json-v1', digestAlgorithm: 'sha256',
  domain: 'heimdall-acceptance-browser-organized-candidate', kind, value });
export function sourceContent(binding) {
  return { projectionVersion: binding.projectionVersion, mode: 'browser', source: copy(binding.source),
    ...Object.fromEntries(['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest',
      'selectedEvidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey',
      'environmentKey', 'verifierFingerprint'].map(key => [key, binding[key]])) };
}
export function resealSource(binding) {
  binding.sourceContentDigest = independentHash({ projectionVersion: 1,
    canonicalJsonVersion: 'acceptance-json-v1', digestAlgorithm: 'sha256',
    domain: 'heimdall-acceptance-browser-candidate', kind: 'content', value: sourceContent(binding) });
}
export function candidateContent(candidate) {
  return { candidateContractVersion: 1, mode: 'browser', projectId: candidate.projectId,
    releaseId: candidate.releaseId, sourceBindingId: candidate.sourceBindingId,
    sourceContentDigest: candidate.sourceContentDigest, organizationContextDigest: candidate.organizationContextDigest };
}
export function append(catalog, map, entity, kind, projectId) {
  const entityId = entity.id ?? entity.runId;
  catalog[map][entityId] = entity;
  catalog.events.push({ id: uid('ae', catalog.revision + 20), revision: ++catalog.revision, kind,
    ...(projectId ? { projectId } : {}), entityId, entityDigest: independentHash(entity),
    at: entity.createdAt ?? entity.boundAt ?? entity.approvedAt ?? entity.selectedAt,
    actor: { kind: 'local-operator' } });
  return entity;
}
export function empty(version = 4) {
  return { schemaVersion: version, generationId: uid('ag', 10), revision: 0, projects: {}, releases: {}, runBindings: {},
    ...(version >= 2 ? { candidates: {}, approvals: {}, selections: {}, migrations: {} } : {}),
    ...(version >= 3 ? { browserSourceBindings: {} } : {}), ...(version >= 4 ? { browserCandidates: {} } : {}), events: [] };
}
export function metadataFixture({ version = 4, candidate = true, buildRef = true, organizationOffset = 0 } = {}) {
  const catalog = empty(version);
  const project = append(catalog, 'projects', { id: uid('ap', 1 + organizationOffset), name: 'Browser 组织候选', createdAt: AT }, 'project-created');
  catalog.events.at(-1).projectId = project.id;
  const release = append(catalog, 'releases', { id: uid('ar', 2 + organizationOffset), projectId: project.id,
    label: '不可变来源版本', targetUrl: 'https://example.test/app?tenant=one&tenant=two&token=fixture-value',
    ...(buildRef ? { buildRef: 'fixture-build-ref' } : {}), createdAt: AT }, 'release-created', project.id);
  const binding = { id: uid('ax', 5 + organizationOffset), projectId: project.id, releaseId: release.id, projectionVersion: 1,
    source: { runId: uid('ac', 4), sourceMode: 'regression', side: 'baseline', entryUrl: release.targetUrl },
    ...Object.fromEntries(['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest',
      'selectedEvidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey',
      'environmentKey', 'verifierFingerprint'].map((key, index) => [key, String(index + 1).repeat(64)])),
    boundAt: AT, actor: { kind: 'local-operator' } };
  resealSource(binding);
  append(catalog, 'browserSourceBindings', binding, 'browser-source-bound', project.id);
  const record = { id: uid('bc', 6), candidateContractVersion: 1, mode: 'browser', projectId: project.id,
    releaseId: release.id, sourceBindingId: binding.id, sourceContentDigest: binding.sourceContentDigest,
    organizationContextDigest: organizedHash('organization-context', { project, release, sourceBinding: binding }),
    createdAt: AT, actor: { kind: 'local-operator' } };
  record.contentDigest = organizedHash('content', candidateContent(record));
  if (candidate) append(catalog, 'browserCandidates', record, 'browser-candidate-created', project.id);
  return { catalog, project, release, binding, candidate: record };
}
export function rehashEvents(catalog) {
  const maps = ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'migrations', 'browserSourceBindings', 'browserCandidates'];
  catalog.events.forEach((event, index) => {
    const entity = maps.map(map => catalog[map]?.[event.entityId]).find(Boolean);
    event.revision = index + 1;
    if (event.kind === 'catalog-migrated' && entity) entity.fromRevision = index;
    if (entity) { event.entityDigest = independentHash(entity); event.at = entity.createdAt ?? entity.boundAt ?? entity.approvedAt ?? entity.selectedAt; }
  });
  catalog.revision = catalog.events.length;
}
