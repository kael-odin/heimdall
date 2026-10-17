/** Complete Browser candidate contracts. Display-only binding DTOs never enter this boundary. */
import { AcceptanceCatalogError, catalogPreconditions, catalogVersion } from './acceptance-catalog.js';
import { browserEvidenceMetadata, fetchBrowserBindingEvidence } from './acceptance-browser-bindings.js';

export const BROWSER_CANDIDATE_REVIEW_BYTES = 12 * 1024 * 1024;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const HASH = /^[a-f0-9]{64}$/;
const FACETS = ['navigation', 'console', 'network', 'overflow', 'structure', 'visual'];
const DIGESTS = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'selectedEvidenceManifestDigest',
  'scopeKey', 'ruleManifestKey', 'oracleManifestKey', 'environmentKey', 'verifierFingerprint'];
const CANDIDATE_FIELDS = ['id', 'candidateContractVersion', 'mode', 'projectId', 'releaseId', 'sourceBindingId',
  'sourceContentDigest', 'organizationContextDigest', 'contentDigest', 'createdAt', 'actor'];
const CONTENT_FIELDS = ['candidateContractVersion', 'mode', 'projectId', 'releaseId', 'sourceBindingId',
  'sourceContentDigest', 'organizationContextDigest'];
const REVIEW_FIELDS = ['sourcePlan', 'sourceStatus', 'sourceGate', 'declaredSlots', 'projectedSlots', 'scope', 'rules',
  'selectedOracles', 'observations', 'selectedEvidence', 'verifiedEvidence', 'omissions', 'oracleStorage',
  'environment', 'verifierFingerprint', 'urlProof', 'limitations'];
const FULL_FIELDS = ['viewVersion', 'candidateContractVersion', 'schemaVersion', 'generationId', 'revision',
  'candidateContent', 'contentDigest', 'organizationContext', 'organizationContextDigest', 'sourceProjection',
  'review', 'completeness', 'presentation', 'diagnostics', 'executionReady'];
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-${UUID}$`).test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bad = (message = '完整 Browser 候选合同响应无效，已停止确认；请刷新目录后重新复核。') => {
  throw new AcceptanceCatalogError(message, { code: 'INVALID_RESPONSE' });
};
const inputError = message => { throw new AcceptanceCatalogError(message, { code: 'INVALID_INPUT' }); };
function fields(value, allowed, required = allowed) {
  if (!object(value)) bad();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key)
    || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)
    || required.some(key => !Object.hasOwn(descriptors, key))) bad();
}
const equal = (a, b) => {
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
      : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return canonical(a) === canonical(b);
};
function boundedJson(value) {
  const stack = [[value, 0]], seen = new Set(); let nodes = 0, characters = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++nodes > 400_000 || depth > 80) bad();
    if (typeof item === 'string') characters += item.length;
    else if (item !== null && typeof item === 'object') {
      if (seen.has(item) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) bad();
      seen.add(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) bad();
        if (Array.isArray(item) && key === 'length') continue;
        if (!descriptor.enumerable || stack.length + nodes >= 400_000) bad();
        characters += key.length; stack.push([descriptor.value, depth + 1]);
      }
    } else if (!['number', 'boolean'].includes(typeof item) && item !== null || typeof item === 'number' && !Number.isFinite(item)) bad();
    if (characters > 32 * 1024 * 1024) bad();
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BROWSER_CANDIDATE_REVIEW_BYTES) bad('完整合同超过 12 MiB，不能截断后确认。');
}
function timestamp(value) { return text(value, 24) && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value; }
function actor(value) { fields(value, ['kind']); if (value.kind !== 'local-operator') bad(); }
function versionMatches(value, expected) {
  const incoming = catalogVersion(value), wanted = catalogVersion(expected);
  if (!id(incoming.generationId, 'ag')) bad();
  if (incoming.generationId !== wanted.generationId || incoming.revision !== wanted.revision) {
    throw new AcceptanceCatalogError('目录谱系或修订已变化，请刷新目录并重新复核完整合同。', {
      code: 'STALE_REVISION', status: 409, currentGenerationId: incoming.generationId, currentRevision: incoming.revision,
    });
  }
}
function diagnostics(value, valid) {
  fields(value, ['eligible', 'contentMatches', 'issues']);
  if (value.eligible !== valid || value.contentMatches !== valid || !Array.isArray(value.issues) || valid && value.issues.length) bad();
  for (const issue of value.issues) { fields(issue, ['code', 'message']); if (!text(issue.code, 80) || !text(issue.message, 1000)) bad(); }
}
export function validateBrowserCandidate(candidate, projectId) {
  fields(candidate, CANDIDATE_FIELDS); actor(candidate.actor);
  if (!id(candidate.id, 'bc') || candidate.candidateContractVersion !== 1 || candidate.mode !== 'browser'
    || !id(projectId, 'ap') || candidate.projectId !== projectId || !id(candidate.releaseId, 'ar')
    || !id(candidate.sourceBindingId, 'ax') || !timestamp(candidate.createdAt)
    || !['sourceContentDigest', 'organizationContextDigest', 'contentDigest'].every(key => HASH.test(candidate[key]))) bad();
  return candidate;
}
export function browserCandidateHistory(detail, projectId) {
  if (detail?.project?.id !== projectId || !Array.isArray(detail.browserCandidates)) bad('当前引擎未提供 Browser 候选记录，请刷新目录。');
  fields(detail.browserCandidateSupport, ['available', 'requiredSchemaVersion']);
  const support = detail.browserCandidateSupport;
  if (typeof support.available !== 'boolean' || support.requiredSchemaVersion !== 4 || !support.available && detail.browserCandidates.length) bad();
  const candidates = detail.browserCandidates.map(value => validateBrowserCandidate(value, projectId));
  if (new Set(candidates.map(value => value.id)).size !== candidates.length
    || new Set(candidates.map(value => value.sourceBindingId)).size !== candidates.length) bad();
  return { candidates, available: support.available };
}
export function browserCandidateCollectionState(value, projectId) {
  fields(value, ['schemaVersion', 'generationId', 'revision', 'projectId', 'browserCandidates', 'verification', 'browserCandidateSupport', 'executionReady']);
  catalogVersion(value); fields(value.verification, ['scope', 'currentSourceVerified']);
  if (value.schemaVersion !== 4 || !id(value.generationId, 'ag') || value.projectId !== projectId || value.executionReady !== false
    || value.verification.scope !== 'stored-candidate-metadata' || value.verification.currentSourceVerified !== false) bad();
  const state = browserCandidateHistory({ project: { id: projectId }, browserCandidates: value.browserCandidates,
    browserCandidateSupport: value.browserCandidateSupport }, projectId);
  if (!state.available) bad();
  return { ...state, version: catalogVersion(value) };
}
function slotKey(slot, facet = false) {
  fields(slot, ['route', 'viewport', 'pointId', ...(facet ? ['facet'] : [])], ['route', 'viewport', ...(facet ? ['facet'] : [])]);
  fields(slot.viewport, ['width', 'height']);
  if (!text(slot.route) || !slot.route || !integer(slot.viewport.width) || !slot.viewport.width || !integer(slot.viewport.height)
    || !slot.viewport.height || Object.hasOwn(slot, 'pointId') && (!text(slot.pointId, 80) || !slot.pointId)
    || facet && ![...FACETS, 'behavior'].includes(slot.facet)) bad();
  return JSON.stringify([slot.route, slot.viewport.width, slot.viewport.height, slot.pointId ?? null, ...(facet ? [slot.facet] : [])]);
}
function planAndCoverage(review) {
  const plan = review.sourcePlan;
  fields(plan, ['schemaVersion', 'name', 'mode', 'baselineUrl', 'targetUrl', 'routes', 'viewports', 'points', 'thresholds', 'timeoutMs', 'settleMs', 'normalization']);
  if (plan.schemaVersion !== 1 || !['mirror', 'regression'].includes(plan.mode) || !text(plan.name, 120)
    || ![plan.baselineUrl, plan.targetUrl].every(value => text(value) && /^https?:\/\//.test(value))
    || !Array.isArray(plan.routes) || !plan.routes.length || !Array.isArray(plan.viewports) || !plan.viewports.length
    || !Array.isArray(plan.points) || !object(plan.thresholds) || !object(plan.normalization)
    || !Array.isArray(plan.normalization.maskSelectors) || !Number.isFinite(plan.thresholds.visual)
    || !Number.isFinite(plan.timeoutMs) || !Number.isFinite(plan.settleMs)) bad();
  fields(plan.thresholds, ['visual']); fields(plan.normalization, ['maskSelectors']);
  if (plan.thresholds.visual < 0 || plan.thresholds.visual > 1 || plan.timeoutMs <= 0 || plan.settleMs < 0
    || !plan.normalization.maskSelectors.every(value => text(value))
    || new Set(plan.routes).size !== plan.routes.length || !plan.points.every(object)) bad();
  const observations = new Map(), scope = new Set();
  for (const route of plan.routes) for (const viewport of plan.viewports) {
    fields(viewport, ['name', 'width', 'height']);
    if (!text(viewport.name, 80)) bad();
    const base = { route, viewport: { width: viewport.width, height: viewport.height } };
    const key = slotKey(base); if (observations.has(key)) bad(); observations.set(key, null);
    for (const facet of FACETS) scope.add(slotKey({ ...base, facet }, true));
    for (const point of plan.points.filter(value => value.route === route)) {
      if (!text(point.id, 80) || !point.id || !text(point.title, 200) || !Array.isArray(point.steps) || !Array.isArray(point.assertions)) bad();
      const slot = { ...base, pointId: point.id }, pointKey = slotKey(slot);
      if (observations.has(pointKey)) bad(); observations.set(pointKey, point); scope.add(slotKey({ ...slot, facet: 'behavior' }, true));
    }
  }
  if (plan.points.some(point => !plan.routes.includes(point.route)) || !scope.size || !integer(review.declaredSlots)
    || review.declaredSlots !== scope.size || review.projectedSlots !== scope.size || review.scope.length !== scope.size
    || review.rules.length !== scope.size || review.observations.length !== observations.size
    || review.selectedOracles.length !== observations.size || review.selectedEvidence.length !== observations.size) bad();
  const checkSet = (values, keyOf, expected) => {
    const keys = values.map(keyOf); if (new Set(keys).size !== expected.size || keys.some(key => !expected.has(key))) bad();
  };
  checkSet(review.scope, value => slotKey(value, true), scope);
  checkSet(review.rules, value => { fields(value, ['slot', 'rule']); return slotKey(value.slot, true); }, scope);
  for (const entry of review.rules) {
    const { facet: _facet, ...observationSlot } = entry.slot;
    const rule = entry.rule, point = observations.get(slotKey(observationSlot));
    if (!object(rule) || rule.facet !== entry.slot.facet || rule.route !== entry.slot.route || !object(rule.network)
      || !object(rule.capture) || !Array.isArray(rule.maskSelectors) || !Number.isFinite(rule.timeoutMs)
      || !Number.isFinite(rule.settleMs) || !Number.isFinite(rule.runMs)
      || point && (!equal(rule.steps, point.steps) || !equal(rule.assertions, point.assertions))) bad();
    fields(rule.network, ['allowedMethods', 'webSockets', 'isolatedContexts', 'serviceWorkers', 'acceptDownloads', 'maxObservations']);
    fields(rule.capture, ['maxPixels', 'maxHeight', 'scope', 'animations', 'caret', 'repeatWaitMs', 'timeoutMs']);
    if (!equal(rule.network, { allowedMethods: ['GET', 'HEAD', 'OPTIONS'], webSockets: 'blocked', isolatedContexts: true,
      serviceWorkers: 'block', acceptDownloads: false, maxObservations: 100 }) || rule.capture.scope !== 'bounded-full-page'
      || rule.capture.animations !== 'disabled' || rule.capture.caret !== 'hide'
      || !['maxPixels', 'maxHeight', 'repeatWaitMs', 'timeoutMs'].every(key => integer(rule.capture[key]))
      || rule.timeoutMs !== plan.timeoutMs || rule.settleMs !== Math.min(2000, plan.settleMs) || rule.runMs !== 300000) bad();
  }
  checkSet(review.observations, value => slotKey(value.slot), observations);
  checkSet(review.selectedOracles, value => { fields(value, ['slot', 'oracle']); return slotKey(value.slot); }, observations);
  checkSet(review.selectedEvidence, value => { fields(value, ['slot', 'roles']); return slotKey(value.slot); }, observations);
  return observations;
}
export function browserCandidateReviewState(value, { projectId, sourceBindingId, candidateId = '', version } = {}) {
  boundedJson(value); versionMatches(value, version);
  if (value.schemaVersion !== 4 || value.executionReady !== false) bad();
  if (value.review === null) {
    fields(value, ['schemaVersion', 'generationId', 'revision', 'candidate', 'review', 'diagnostics', 'executionReady']);
    const candidate = validateBrowserCandidate(value.candidate, projectId); diagnostics(value.diagnostics, false);
    if (!candidateId || candidate.id !== candidateId || sourceBindingId && candidate.sourceBindingId !== sourceBindingId) bad();
    return { value, candidate, review: null, canConfirm: false, diagnostics: value.diagnostics };
  }
  fields(value, [...FULL_FIELDS, 'candidate', 'event'], FULL_FIELDS);
  fields(value.candidateContent, CONTENT_FIELDS); fields(value.organizationContext, ['project', 'release', 'sourceBinding']);
  const { project, release, sourceBinding } = value.organizationContext, content = value.candidateContent, projection = value.sourceProjection;
  fields(project, ['id', 'name', 'createdAt']); fields(release, ['id', 'projectId', 'label', 'targetUrl', 'buildRef', 'createdAt'], ['id', 'projectId', 'label', 'targetUrl', 'createdAt']);
  fields(sourceBinding, ['id', 'projectId', 'releaseId', 'projectionVersion', 'source', ...DIGESTS, 'sourceContentDigest', 'boundAt', 'actor']); actor(sourceBinding.actor);
  fields(projection, ['projectionVersion', 'mode', 'source', ...DIGESTS, 'contentDigest']);
  fields(projection.source, ['runId', 'sourceMode', 'side', 'entryUrl']); fields(sourceBinding.source, ['runId', 'sourceMode', 'side', 'entryUrl']);
  if (value.viewVersion !== 1 || value.candidateContractVersion !== 1 || content.candidateContractVersion !== 1 || content.mode !== 'browser'
    || !id(projectId, 'ap') || project.id !== projectId || content.projectId !== projectId || sourceBinding.projectId !== projectId
    || release.projectId !== projectId || !id(release.id, 'ar') || sourceBinding.releaseId !== release.id || content.releaseId !== release.id
    || !id(sourceBinding.id, 'ax') || sourceBinding.id !== sourceBindingId || content.sourceBindingId !== sourceBindingId
    || projection.projectionVersion !== 1 || sourceBinding.projectionVersion !== 1 || projection.mode !== 'browser'
    || !id(projection.source.runId, 'ac') || !['mirror', 'regression'].includes(projection.source.sourceMode)
    || !['baseline', 'target'].includes(projection.source.side) || !equal(projection.source, sourceBinding.source)
    || release.targetUrl !== projection.source.entryUrl || !timestamp(project.createdAt) || !timestamp(release.createdAt)
    || !timestamp(sourceBinding.boundAt) || !text(project.name, 120) || !text(release.label, 120)
    || Object.hasOwn(release, 'buildRef') && !text(release.buildRef, 200)
    || !DIGESTS.every(key => HASH.test(projection[key]) && projection[key] === sourceBinding[key])
    || !HASH.test(value.organizationContextDigest) || value.organizationContextDigest !== content.organizationContextDigest
    || !HASH.test(value.contentDigest) || !HASH.test(projection.contentDigest)
    || projection.contentDigest !== sourceBinding.sourceContentDigest || projection.contentDigest !== content.sourceContentDigest) bad();
  fields(value.completeness, ['organizationContext', 'sourceProjection', 'selectedRequirements', 'rawArtifactsEmbedded']);
  fields(value.presentation, ['kind', 'completeSourceProjection']);
  if (value.completeness.organizationContext !== true || value.completeness.sourceProjection !== true
    || value.completeness.selectedRequirements !== true || value.completeness.rawArtifactsEmbedded !== false
    || value.presentation.kind !== 'browser-candidate-full-review' || value.presentation.completeSourceProjection !== true) bad();
  diagnostics(value.diagnostics, true);
  const review = value.review; fields(review, REVIEW_FIELDS);
  if (review.sourceStatus !== 'completed' || !['passed', 'failed', 'blocked', 'needs_review'].includes(review.sourceGate)
    || !['scope', 'rules', 'selectedOracles', 'observations', 'selectedEvidence', 'verifiedEvidence', 'omissions', 'limitations'].every(key => Array.isArray(review[key]))
    || review.omissions.length || review.oracleStorage !== 'captured-side-evidence' || !review.limitations.length
    || !review.limitations.every(value => text(value, 4096)) || review.verifierFingerprint !== projection.verifierFingerprint) bad();
  fields(review.environment, ['platform', 'arch', 'nodeVersion', 'browser', 'browserVersion', 'playwrightVersion', 'locale', 'timezoneId', 'colorScheme', 'reducedMotion']);
  if (!Object.values(review.environment).every(value => text(value, 300))) bad();
  fields(review.urlProof, ['planned', 'observedFinal']);
  if (review.urlProof.planned !== 'exact-normalized-plan'
    || review.urlProof.observedFinal !== 'query-values-redacted; no complete redirect-chain or final-query proof') bad();
  const expectedObservations = planAndCoverage(review), side = projection.source.side;
  if (review.sourcePlan.mode !== projection.source.sourceMode || review.sourcePlan[`${side}Url`] !== projection.source.entryUrl) bad();
  const verified = new Map();
  for (const metadata of review.verifiedEvidence) {
    fields(metadata, ['file', 'bytes', 'sha256']);
    if (!text(metadata.file, 240) || !/^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(metadata.file) || metadata.file.includes('..')
      || !integer(metadata.bytes) || !metadata.bytes || metadata.bytes > 64 * 1024 * 1024 || !HASH.test(metadata.sha256) || verified.has(metadata.file)) bad();
    verified.set(metadata.file, metadata);
  }
  for (const observation of review.observations) {
    const key = slotKey(observation.slot), point = expectedObservations.get(key);
    fields(observation, ['slot', 'viewportName', 'title', 'severity', 'plannedUrl', 'observedFinalUrl', 'finalUrlProof',
      'evidence', 'expected', 'capture', 'mask', 'stability', 'steps', 'assertions'],
    ['slot', 'viewportName', 'plannedUrl', 'observedFinalUrl', 'finalUrlProof', 'evidence', 'expected', 'capture', 'mask', 'stability',
      ...(point ? ['title', 'severity', 'steps', 'assertions'] : [])]);
    const selected = review.selectedEvidence.find(value => slotKey(value.slot) === key), oracle = review.selectedOracles.find(value => slotKey(value.slot) === key)?.oracle;
    if (!object(oracle)) bad();
    const { kind: _kind, entryUrl: _entry, ...oracleExpected } = oracle;
    fields(observation.evidence, ['details', 'screenshot', 'repeat']); fields(selected.roles, ['details', 'screenshot', 'repeat']);
    for (const role of ['details', 'screenshot', 'repeat']) {
      browserEvidenceMetadata(observation.evidence[role], role, side);
      if (!equal(observation.evidence[role], selected.roles[role]) || !equal(verified.get(selected.roles[role].file), selected.roles[role])) bad();
    }
    fields(observation.expected, ['httpStatus', 'structure', 'screenshotSha256', 'steps', 'assertions', 'observedAssertions'],
      ['httpStatus', 'structure', 'screenshotSha256', ...(point ? ['steps', 'assertions', 'observedAssertions'] : [])]);
    fields(observation.expected.structure, ['title', 'headings', 'controls']);
    fields(observation.capture, ['captureScope', 'captureLimited', 'documentSize']);
    fields(observation.capture.documentSize, ['width', 'height']);
    fields(observation.mask, ['maskedRatio', 'effectiveAreaPx', 'samplingCapped']);
    const structure = observation.expected.structure;
    if (!text(structure.title, 300) || !Array.isArray(structure.headings) || !structure.headings.every(value => text(value, 300))
      || !Array.isArray(structure.controls) || !['width', 'height'].every(key => integer(observation.capture.documentSize[key]) && observation.capture.documentSize[key] > 0)
      || !Number.isFinite(observation.mask.maskedRatio) || observation.mask.maskedRatio < 0 || observation.mask.maskedRatio > 0.8
      || !integer(observation.mask.effectiveAreaPx) || observation.mask.samplingCapped !== false) bad();
    for (const control of structure.controls) {
      fields(control, ['path', 'tag', 'role', 'label', 'type', 'href', 'disabled', 'expanded', 'selected']);
      if (!['path', 'tag', 'label'].every(key => text(control[key])) || typeof control.disabled !== 'boolean'
        || !['role', 'type', 'href', 'expanded', 'selected'].every(key => control[key] === null || text(control[key]))) bad();
    }
    if (!object(observation.expected) || !object(observation.expected.structure) || !object(observation.capture) || !object(observation.mask)
      || !text(observation.viewportName, 80) || !text(observation.plannedUrl) || !text(observation.observedFinalUrl)
      || observation.finalUrlProof !== 'redacted-observation-only' || observation.capture.captureScope !== 'full-page'
      || observation.capture.captureLimited !== false || !Number.isFinite(observation.stability) || observation.stability < 0.9995 || observation.stability > 1
      || observation.expected.screenshotSha256 !== observation.evidence.screenshot.sha256 || !integer(observation.expected.httpStatus)
      || observation.expected.httpStatus < 200 || observation.expected.httpStatus >= 400 || !object(oracle)
      || oracle.kind !== 'captured-browser-side' || oracle.entryUrl !== projection.source.entryUrl
      || !equal(oracleExpected, observation.expected)) bad();
    if (point && (!equal(observation.steps, point.steps) || !equal(observation.assertions, point.assertions)
      || !equal(observation.expected.steps, point.steps) || !equal(observation.expected.assertions, point.assertions)
      || !Array.isArray(observation.expected.observedAssertions) || observation.expected.observedAssertions.length !== point.assertions.length
      || observation.expected.observedAssertions.some(value => value.passed !== true))) bad();
  }
  const candidate = Object.hasOwn(value, 'candidate') ? validateBrowserCandidate(value.candidate, projectId) : null;
  if (candidateId && candidate?.id !== candidateId || candidate && (!CONTENT_FIELDS.every(key => candidate[key] === content[key])
    || candidate.contentDigest !== value.contentDigest)) bad();
  return { value, candidate, project, release, sourceBinding, review, diagnostics: value.diagnostics, canConfirm: !candidate };
}
export function buildBrowserCandidateInput(draft, version, state) {
  if (draft?.confirmed !== true || !state?.canConfirm || !state.review || state.candidate) inputError('请完整复核本次所选侧合同，再明确确认记录候选。');
  versionMatches(state.value, version);
  if (!id(draft.sourceBindingId, 'ax') || draft.sourceBindingId !== state.sourceBinding.id
    || draft.contentDigest !== state.value.contentDigest || !HASH.test(draft.contentDigest)) inputError('完整合同已改变，请重新复核。');
  return { ...catalogPreconditions(version), sourceBindingId: draft.sourceBindingId, contentDigest: draft.contentDigest };
}
export function validateBrowserCandidateWrite(value, { projectId, body }) {
  try {
    if (value?.generationId !== body.expectedGenerationId || value?.revision !== body.expectedRevision + 1) bad();
    const state = browserCandidateReviewState(value, { projectId, sourceBindingId: body.sourceBindingId, version: value });
    const candidate = state.candidate, event = value.event;
    fields(event, ['id', 'revision', 'kind', 'projectId', 'entityId', 'entityDigest', 'at', 'actor']); actor(event.actor);
    if (!candidate || candidate.contentDigest !== body.contentDigest || !id(event.id, 'ae') || event.kind !== 'browser-candidate-created'
      || event.projectId !== projectId || event.entityId !== candidate.id || event.revision !== value.revision
      || event.at !== candidate.createdAt || !HASH.test(event.entityDigest)) bad();
    return value;
  } catch (error) { error.writeMayHaveCommitted = true; throw error; }
}
export function createBrowserCandidateReadGuard() {
  let sequence = 0, stopped = false;
  const keys = ['projectId', 'sourceBindingId', 'candidateId', 'generationId', 'revision', 'selectionEpoch'];
  return { next(context) { return { ...context, sequence: ++sequence }; },
    accepts(ticket, context) { return !stopped && ticket.sequence === sequence && keys.every(key => ticket[key] === context[key]); },
    invalidate() { sequence++; }, stop() { stopped = true; sequence++; } };
}
export function browserCandidateEvidencePath({ projectId, sourceBindingId, candidateId = '', contentDigest, side }, metadata, role) {
  if (!id(projectId, 'ap') || !id(sourceBindingId, 'ax') || candidateId && !id(candidateId, 'bc') || !HASH.test(contentDigest)
    || !['screenshot', 'repeat'].includes(role)) bad();
  browserEvidenceMetadata(metadata, role, side);
  const endpoint = candidateId ? `browser-baseline-candidates/${candidateId}` : `browser-source-bindings/${sourceBindingId}/candidate-preview`;
  return `/api/acceptance/projects/${projectId}/${endpoint}/evidence/${encodeURIComponent(metadata.file)}?expectedContentDigest=${contentDigest}`;
}
export async function fetchBrowserCandidateEvidence({ state, metadata, role, baseUrl = '', fetcher = fetch, ...options }) {
  if (!state?.review || !state.sourceBinding || !state.value) bad();
  const path = browserCandidateEvidencePath({ projectId: state.project.id, sourceBindingId: state.sourceBinding.id,
    candidateId: state.candidate?.id ?? '', contentDigest: state.value.contentDigest, side: state.sourceBinding.source.side }, metadata, role);
  // Reuse only the bounded stream/type/SHA reader. The actual fetch always uses the dedicated D2 route.
  return fetchBrowserBindingEvidence({ binding: state.sourceBinding, metadata, role, ...options,
    fetcher: (_oldPath, settings) => fetcher(`${baseUrl}${path}`, settings) });
}
/** A lost/invalid 201 creates a durable-in-component latch; reopening cannot replay its POST. */
export function createBrowserCandidateSubmission() {
  const states = new Map(), keyOf = (projectId, sourceBindingId) => `${projectId}/${sourceBindingId}`;
  return {
    facts() { return [...states.values()].map(value => ({ ...value })); },
    async submit({ projectId, body, post, refresh }) {
      const key = keyOf(projectId, body.sourceBindingId), previous = states.get(key);
      if (['unknown', 'submitting', 'confirmed'].includes(previous?.phase)) inputError('此来源已有待核对或已确认的提交，请先核对候选集合。');
      const base = { projectId, sourceBindingId: body.sourceBindingId, contentDigest: body.contentDigest,
        generationId: body.expectedGenerationId, revision: body.expectedRevision };
      states.set(key, { ...base, phase: 'submitting' });
      let value;
      try { value = await post(body); validateBrowserCandidateWrite(value, { projectId, body }); }
      catch (error) {
        if (error.writeMayHaveCommitted) states.set(key, { ...base, phase: 'unknown' }); else states.delete(key);
        throw error;
      }
      states.set(key, { ...base, phase: 'confirmed', candidateId: value.candidate.id });
      let refreshed = false;
      try { refreshed = await refresh() === true; } catch { /* The validated 201 remains a confirmed write. */ }
      return { value, refreshed };
    },
    reconcile(value, { projectId, sourceBindingId }) {
      const { candidates, version } = browserCandidateCollectionState(value, projectId), key = keyOf(projectId, sourceBindingId), pending = states.get(key);
      if (!pending || pending.phase !== 'unknown') inputError('此来源没有结果未知的提交。');
      if (version.generationId !== pending.generationId || version.revision < pending.revision) {
        throw new AcceptanceCatalogError('候选集合谱系已变化或修订已回退，不能据此确认先前写入。请核对目录恢复情况。', {
          code: 'STALE_REVISION', status: 409, currentGenerationId: version.generationId, currentRevision: version.revision,
        });
      }
      const candidate = candidates.find(row => row.sourceBindingId === sourceBindingId && row.contentDigest === pending.contentDigest);
      if (candidate && version.revision <= pending.revision) bad('候选集合修订不足以证明此次写入，请刷新后核对。');
      const next = candidate ? { ...pending, phase: 'confirmed', candidateId: candidate.id } : { ...pending, phase: 'absent' };
      states.set(key, next); return { ...next };
    },
  };
}
