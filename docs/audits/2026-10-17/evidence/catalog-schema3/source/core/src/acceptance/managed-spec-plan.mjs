/** Pure contract preparation only. The caller must separately authorize the
 * current selection/approval and fence catalog/source bytes before dispatch. */
import { createHash } from 'node:crypto';
import { AcceptanceCatalogError, boundedText, candidateProjectionOf, fields, id, iso, url } from './catalog-schema.mjs';
import { canonicalAcceptanceJson } from './identity.mjs';
import { verifySpecBaselineMaterial } from './candidate-projection.mjs';
import { normalizeSpecPlan } from './spec-schema.mjs';

const DIGESTS = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'scopeKey',
  'ruleManifestKey', 'oracleManifestKey', 'environmentKey', 'verifierFingerprint', 'contentDigest'];
const CANDIDATE_FIELDS = ['id', 'projectId', 'mode', 'projectionVersion', 'source', ...DIGESTS, 'createdAt'];
const RELEASE_FIELDS = ['id', 'projectId', 'label', 'targetUrl', 'buildRef', 'createdAt'];
const REQUIRED_RELEASE_FIELDS = RELEASE_FIELDS.filter(key => key !== 'buildRef');
const fail = reason => { throw new AcceptanceCatalogError('INVALID_INPUT', 400, '托管 Spec 合同上下文无效。', { reason }); };
const changed = reason => { throw new AcceptanceCatalogError('BASELINE_CHANGED', 409, '已批准来源与当前材料不一致，请重新复核。', { reason }); };

function candidateOf(candidate) {
  const invalid = () => fail('INVALID_CANDIDATE');
  fields(candidate, CANDIDATE_FIELDS, CANDIDATE_FIELDS, invalid);
  id(candidate.id, 'ab', invalid); id(candidate.projectId, 'ap', invalid);
  fields(candidate.source, ['runId', 'sourceMode', 'side', 'releaseId'], ['runId', 'sourceMode', 'side', 'releaseId'], invalid);
  id(candidate.source.runId, 'ac', invalid); id(candidate.source.releaseId, 'ar', invalid);
  if (candidate.mode !== 'spec' || candidate.projectionVersion !== 1 || candidate.source.sourceMode !== 'spec'
    || candidate.source.side !== 'source' || !iso(candidate.createdAt)
    || DIGESTS.some(key => typeof candidate[key] !== 'string' || !/^[a-f0-9]{64}$/.test(candidate[key]))) fail('INVALID_CANDIDATE');
  return candidate;
}
function releaseOf(release, projectId) {
  const invalid = () => fail('INVALID_RELEASE');
  fields(release, RELEASE_FIELDS, REQUIRED_RELEASE_FIELDS, invalid);
  id(release.id, 'ar', invalid); id(release.projectId, 'ap', invalid);
  if (!boundedText(release.label, 120) || !iso(release.createdAt) || url(release.targetUrl, invalid) !== release.targetUrl
    || Object.hasOwn(release, 'buildRef') && !boundedText(release.buildRef, 200)) fail('INVALID_RELEASE');
  if (release.projectId !== projectId) throw new AcceptanceCatalogError('PROJECT_MISMATCH', 409,
    '目标版本与需求候选不属于同一项目。', { reason: 'TARGET_PROJECT_MISMATCH' });
  return release;
}
function managedName(label) {
  let name = '托管 Spec · ';
  for (const point of label) {
    if (name.length + point.length > 120) break;
    name += point;
  }
  return name.trimEnd();
}

/** Rebuild from verified source bytes, never from target responses or a client
 * plan. Returns fresh JSON objects and retains the original source release. */
export function prepareManagedSpecContract(material, options) {
  fields(options, ['candidate', 'targetRelease'], ['candidate', 'targetRelease'], fail);
  const candidate = candidateOf(options.candidate);
  const targetRelease = releaseOf(options.targetRelease, candidate.projectId);
  const verified = verifySpecBaselineMaterial(material, { projectId: candidate.projectId,
    releaseId: candidate.source.releaseId, sourceSide: candidate.source.side });
  if (canonicalAcceptanceJson(verified.projection) !== canonicalAcceptanceJson(candidateProjectionOf(candidate))) {
    changed('CANDIDATE_SOURCE_CHANGED');
  }
  const sourcePlan = verified.plan;
  if (targetRelease.id === candidate.source.releaseId && targetRelease.targetUrl !== sourcePlan.targetUrl) {
    changed('SOURCE_RELEASE_CHANGED');
  }
  const plan = normalizeSpecPlan({ ...sourcePlan, name: managedName(targetRelease.label), targetUrl: targetRelease.targetUrl,
    spec: { ...sourcePlan.spec, approved: true } });
  return { plan, planFingerprint: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    sourceSpecApproved: sourcePlan.spec.approved, sourceProjection: verified.projection };
}
