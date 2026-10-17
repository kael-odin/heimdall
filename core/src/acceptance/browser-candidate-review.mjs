/** Complete organized Browser review from captured material; no source I/O or execution. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalAcceptanceJson } from './identity.mjs';
import { hashBrowserCandidateValue } from './browser-candidate-identity.mjs';
import { hashOrganizedBrowserCandidateValue } from './browser-organized-candidate-identity.mjs';
import { BROWSER_CANDIDATE_LIMITS_V1, verifyBrowserBaselineMaterial } from './browser-candidate-projection.mjs';
import { ACCEPTANCE_CATALOG_LIMITS, actor, boundedText, browserBindingProjectionOf, browserCandidateContentOf,
  error, fields, id, iso, plain, unavailable, url } from './catalog-schema.mjs';

const MAX_REVIEW_BYTES = 12 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const BINDING_DIGESTS = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest',
  'selectedEvidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey',
  'environmentKey', 'verifierFingerprint', 'sourceContentDigest'];
const BINDING_FIELDS = ['id', 'projectId', 'releaseId', 'projectionVersion', 'source', ...BINDING_DIGESTS, 'boundAt', 'actor'];
const CANDIDATE_FIELDS = ['id', 'candidateContractVersion', 'mode', 'projectId', 'releaseId', 'sourceBindingId',
  'sourceContentDigest', 'organizationContextDigest', 'contentDigest', 'createdAt', 'actor'];
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const changed = () => { throw error('BASELINE_CHANGED', 409, 'Browser 完整候选合同与已归属来源或组织上下文不一致。',
  { reason: 'BROWSER_REVIEW_CHANGED' }); };
const budget = () => { throw error('SOURCE_NOT_ELIGIBLE', 409, 'Browser 完整复核内容超过安全预算或不是完整 JSON 数据。',
  { reason: 'BROWSER_REVIEW_BUDGET' }); };
const invalidStored = () => unavailable('BROWSER_CANDIDATE_VIEW_INVALID');

function maxBytesOf(options) {
  fields(options, ['maxBytes'], [], budget);
  const value = options.maxBytes === undefined ? MAX_REVIEW_BYTES : options.maxBytes;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_REVIEW_BYTES) budget();
  return value;
}

/** Check the entire response before commit/serialization; never omit or truncate data. */
export function assertBrowserCandidateEnvelope(value, options = {}) {
  const maxBytes = maxBytesOf(options), active = new WeakSet(), limits = BROWSER_CANDIDATE_LIMITS_V1;
  let nodes = 0, characters = 0;
  const visit = (entry, depth) => {
    if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) budget();
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') { if (!Number.isFinite(entry)) budget(); return; }
    if (typeof entry === 'string') { characters += entry.length; if (characters > limits.jsonCharacters) budget(); return; }
    if (typeof entry !== 'object' || types.isProxy(entry) || active.has(entry)) budget();
    const array = Array.isArray(entry), prototype = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype && prototype !== null : !plain(entry)) budget();
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    if (array && keys.length !== descriptors.length.value + 1) budget();
    active.add(entry);
    try {
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) budget();
        if (array && key === 'length') continue;
        if (!descriptor.enumerable || array && (!/^(?:0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= descriptors.length.value)) budget();
        characters += key.length;
        if (characters > limits.jsonCharacters) budget();
        visit(descriptor.value, depth + 1);
      }
    } finally { active.delete(entry); }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) budget();
  return value;
}

function validateContext(project, release, binding) {
  fields(project, ['id', 'name', 'createdAt'], ['id', 'name', 'createdAt'], changed);
  id(project.id, 'ap', changed);
  if (!boundedText(project.name, 120) || !iso(project.createdAt)) changed();
  fields(release, ['id', 'projectId', 'label', 'targetUrl', 'buildRef', 'createdAt'],
    ['id', 'projectId', 'label', 'targetUrl', 'createdAt'], changed);
  id(release.id, 'ar', changed); id(release.projectId, 'ap', changed);
  if (release.projectId !== project.id || !boundedText(release.label, 120) || !iso(release.createdAt)
    || url(release.targetUrl, changed) !== release.targetUrl
    || Object.hasOwn(release, 'buildRef') && !boundedText(release.buildRef, 200)) changed();
  fields(binding, BINDING_FIELDS, BINDING_FIELDS, changed);
  id(binding.id, 'ax', changed); id(binding.projectId, 'ap', changed); id(binding.releaseId, 'ar', changed);
  actor(binding.actor, changed);
  fields(binding.source, ['runId', 'sourceMode', 'side', 'entryUrl'], ['runId', 'sourceMode', 'side', 'entryUrl'], changed);
  id(binding.source.runId, 'ac', changed);
  if (binding.projectId !== project.id || binding.releaseId !== release.id || binding.projectionVersion !== 1
    || !['mirror', 'regression'].includes(binding.source.sourceMode) || !['baseline', 'target'].includes(binding.source.side)
    || !iso(binding.boundAt) || url(binding.source.entryUrl, changed) !== binding.source.entryUrl
    || binding.source.entryUrl !== release.targetUrl
    || BINDING_DIGESTS.some(key => typeof binding[key] !== 'string' || !HASH.test(binding[key]))) changed();
}

/** No lineage fields here: mutate owns the committed generation/revision and event. */
export function buildBrowserCandidateReview(input, options = {}) {
  fields(input, ['project', 'release', 'sourceBinding', 'material'], ['project', 'release', 'sourceBinding', 'material'], changed);
  maxBytesOf(options);
  const { project, release, sourceBinding, material } = input;
  validateContext(project, release, sourceBinding);
  const { projection, preview, manifests } = verifyBrowserBaselineMaterial(material, { sourceSide: sourceBinding.source.side });
  if (!same(projection, browserBindingProjectionOf(sourceBinding)) || projection.source.entryUrl !== release.targetUrl) changed();

  // Preserve the saved plan's exact key order: this legacy digest is intentionally
  // JSON.stringify(manifest.plan), not canonical JSON or the normalizer's key order.
  const sourcePlan = copy(material.snapshot.manifest.plan);
  const components = {
    sourcePlanDigest: sha256(JSON.stringify(sourcePlan)), sourceReportDigest: sha256(material.files.get('report.json')),
    evidenceManifestDigest: hashBrowserCandidateValue('verified-evidence', manifests.verifiedEvidence),
    selectedEvidenceManifestDigest: hashBrowserCandidateValue('selected-evidence', manifests.selectedEvidence),
    scopeKey: hashBrowserCandidateValue('scope', manifests.scope), ruleManifestKey: hashBrowserCandidateValue('rules', manifests.rules),
    oracleManifestKey: hashBrowserCandidateValue('oracle', manifests.selectedOracles),
    environmentKey: hashBrowserCandidateValue('environment', preview.environment), verifierFingerprint: preview.verifierFingerprint,
  };
  const { contentDigest: sourceDigest, ...sourceContent } = projection;
  if (Object.entries(components).some(([key, value]) => projection[key] !== value)
    || hashBrowserCandidateValue('content', sourceContent) !== sourceDigest) changed();
  const organizationContext = copy({ project, release, sourceBinding });
  const organizationContextDigest = hashOrganizedBrowserCandidateValue('organization-context', organizationContext);
  const candidateContent = browserCandidateContentOf({ candidateContractVersion: 1, mode: 'browser',
    projectId: project.id, releaseId: release.id, sourceBindingId: sourceBinding.id,
    sourceContentDigest: sourceDigest, organizationContextDigest });
  const result = {
    viewVersion: 1, candidateContractVersion: 1, schemaVersion: 4,
    candidateContent, contentDigest: hashOrganizedBrowserCandidateValue('content', candidateContent),
    organizationContext, organizationContextDigest, sourceProjection: copy(projection),
    review: { sourcePlan, sourceStatus: preview.sourceStatus, sourceGate: preview.sourceGate,
      declaredSlots: preview.declaredSlots, projectedSlots: preview.projectedSlots,
      scope: copy(manifests.scope), rules: copy(manifests.rules), selectedOracles: copy(manifests.selectedOracles),
      observations: copy(preview.observations), selectedEvidence: copy(manifests.selectedEvidence),
      verifiedEvidence: copy(manifests.verifiedEvidence), omissions: [], oracleStorage: preview.oracleStorage,
      environment: copy(preview.environment), verifierFingerprint: preview.verifierFingerprint,
      urlProof: copy(preview.urlProof), limitations: [preview.reviewNotice] },
    completeness: { organizationContext: true, sourceProjection: true, selectedRequirements: true, rawArtifactsEmbedded: false },
    presentation: { kind: 'browser-candidate-full-review', completeSourceProjection: true },
    diagnostics: { eligible: true, contentMatches: true, issues: [] }, executionReady: false,
  };
  return assertBrowserCandidateEnvelope(result, options);
}

function data(object, key, fail = invalidStored) {
  if (!plain(object)) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
  return descriptor.value;
}

export function browserCandidateSupportOf(catalog) {
  return { available: data(catalog, 'schemaVersion') === 4, requiredSchemaVersion: 4 };
}

function storedCandidate(value, key) {
  fields(value, CANDIDATE_FIELDS, CANDIDATE_FIELDS, invalidStored);
  id(key, 'bc', invalidStored); id(value.projectId, 'ap', invalidStored); id(value.releaseId, 'ar', invalidStored);
  id(value.sourceBindingId, 'ax', invalidStored); actor(value.actor, invalidStored);
  if (value.id !== key || value.candidateContractVersion !== 1 || value.mode !== 'browser' || !iso(value.createdAt)
    || ['sourceContentDigest', 'organizationContextDigest', 'contentDigest'].some(name => typeof value[name] !== 'string' || !HASH.test(value[name]))
    || hashOrganizedBrowserCandidateValue('content', browserCandidateContentOf(value)) !== value.contentDigest) invalidStored();
  return copy(value);
}

/** Stored metadata only: deliberately never reads source bindings, URLs or captured bytes. */
export function browserCandidateCollectionView(catalog, projectId) {
  id(projectId, 'ap', invalidStored);
  const schemaVersion = data(catalog, 'schemaVersion'), generationId = data(catalog, 'generationId'), revision = data(catalog, 'revision');
  id(generationId, 'ag', invalidStored);
  if (![3, 4].includes(schemaVersion) || !Number.isSafeInteger(revision) || revision < 0) invalidStored();
  const projects = data(catalog, 'projects');
  if (!plain(projects)) invalidStored();
  if (!Object.hasOwn(projects, projectId)) throw error('NOT_FOUND', 404, '所选项目不存在。');
  data(projects, projectId);
  const candidates = [];
  if (schemaVersion === 4) {
    const map = data(catalog, 'browserCandidates');
    if (!plain(map)) invalidStored();
    const descriptors = Object.getOwnPropertyDescriptors(map), keys = Reflect.ownKeys(descriptors);
    if (keys.length > ACCEPTANCE_CATALOG_LIMITS.browserCandidates) invalidStored();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalidStored();
      const candidate = storedCandidate(descriptor.value, key);
      if (candidate.projectId === projectId) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => a.createdAt === b.createdAt ? a.id < b.id ? 1 : a.id > b.id ? -1 : 0 : a.createdAt < b.createdAt ? 1 : -1);
  return { schemaVersion, generationId, revision, projectId, browserCandidates: candidates,
    verification: { scope: 'stored-candidate-metadata', currentSourceVerified: false },
    browserCandidateSupport: browserCandidateSupportOf(catalog), executionReady: false };
}
