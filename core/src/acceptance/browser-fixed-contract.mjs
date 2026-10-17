/** Private, same-capture compilation of a saved Browser candidate for one target. */
import { createHash } from 'node:crypto';
import { buildBrowserCandidateReview, assertBrowserCandidateEnvelope } from './browser-candidate-review.mjs';
import { buildAcceptanceIdentity, canonicalAcceptanceJson, hashAcceptanceValue } from './identity.mjs';
import { actor, boundedText, browserCandidateContentOf, error, fields, id, iso, url } from './catalog-schema.mjs';
import { normalizeAcceptancePlan } from './schema.mjs';

const compiled = new WeakMap();
const copy = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const fail = () => { throw error('BASELINE_CHANGED', 409, 'Browser 单次执行合同与完整候选或已核验来源不一致。', { reason: 'BROWSER_FIXED_CONTRACT_CHANGED' }); };
const candidateFields = ['id', 'candidateContractVersion', 'mode', 'projectId', 'releaseId', 'sourceBindingId',
  'sourceContentDigest', 'organizationContextDigest', 'contentDigest', 'createdAt', 'actor'];
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const slotKey = value => canonicalAcceptanceJson(value);
function identityData(contract, slot, facet) {
  const selected = contract.observations.find(value => slotKey(value.slot) === slotKey(slot));
  const rule = facet === 'readonly' ? { facet: 'readonly', allowedMethods: ['GET', 'HEAD', 'OPTIONS'], webSockets: 'blocked', oracle: 'captured-browser-side' }
    : contract.rules.find(value => slotKey(value.slot) === slotKey({ ...slot, facet }))?.rule;
  if (!selected || !rule) fail();
  return { rule: copy(rule), oracle: { kind: 'captured-browser-side', candidateId: contract.candidateId,
    contentDigest: contract.contentDigest, sourceContentDigest: contract.fixedBaseline.sourceContentDigest,
    sourceRunId: contract.fixedBaseline.sourceRunId, sourceSide: contract.fixedBaseline.sourceSide,
    entryUrl: contract.fixedBaseline.entryUrl, slot: copy(slot), captured: copy(selected.expected) } };
}

/** Stable recomputation for an already validated serialized contract; no process-local capability is required. */
export function fixedBrowserCheckIdentity(contract, environment, slot, facet) {
  return buildAcceptanceIdentity({ kind: 'browser', facet, route: slot.route, viewport: slot.viewport,
    ...(slot.pointId ? { pointId: slot.pointId } : {}), environment, ...identityData(contract, slot, facet) });
}

/** A captured oracle is comparable only under the complete source execution environment. */
export function fixedBrowserEnvironmentComparison(contract, environment) {
  const source = contract.fixedBaseline.sourceEnvironment;
  const differences = Object.keys(source).filter(key => source[key] !== environment[key])
    .map(key => ({ field: key, source: source[key], target: environment[key] ?? null }));
  return { comparable: differences.length === 0, differences };
}

/** No source I/O, URLs, approval or catalog mutation is performed here. */
export function compileFixedBrowserContract(input) {
  fields(input, ['material', 'review', 'candidate', 'targetRelease'], ['material', 'review', 'candidate', 'targetRelease'], fail);
  const { material, review, candidate, targetRelease } = input;
  assertBrowserCandidateEnvelope(review); assertBrowserCandidateEnvelope(candidate); assertBrowserCandidateEnvelope(targetRelease);
  const context = review.organizationContext;
  if (!context) fail();
  const fresh = buildBrowserCandidateReview({ ...context, material });
  if (!same(fresh, review)) fail();
  fields(candidate, candidateFields, candidateFields, fail);
  id(candidate.id, 'bc', fail); actor(candidate.actor, fail);
  if (!iso(candidate.createdAt) || !same(browserCandidateContentOf(candidate), fresh.candidateContent)
    || candidate.contentDigest !== fresh.contentDigest) fail();
  fields(targetRelease, ['id', 'projectId', 'label', 'targetUrl', 'buildRef', 'createdAt'],
    ['id', 'projectId', 'label', 'targetUrl', 'createdAt'], fail);
  id(targetRelease.id, 'ar', fail); id(targetRelease.projectId, 'ap', fail);
  if (targetRelease.projectId !== candidate.projectId || !boundedText(targetRelease.label, 120)
    || !iso(targetRelease.createdAt) || url(targetRelease.targetUrl, fail) !== targetRelease.targetUrl
    || Object.hasOwn(targetRelease, 'buildRef') && !boundedText(targetRelease.buildRef, 200)) fail();

  const data = fresh.review, projection = fresh.sourceProjection, sourceFiles = new Map(), sourceEvidence = [];
  const seenSlots = new Set();
  for (const observation of data.selectedEvidence) {
    const key = slotKey(observation.slot);
    if (seenSlots.has(key)) fail();
    seenSlots.add(key);
    for (const role of ['details', 'screenshot', 'repeat']) {
      const entry = observation.roles[role], original = material.files.get(entry.file);
      if (!Buffer.isBuffer(original) || original.length !== entry.bytes || sha(original) !== entry.sha256
        || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.file)) fail();
      if (!sourceFiles.has(entry.file)) {
        sourceFiles.set(entry.file, Buffer.from(original));
        sourceEvidence.push({ sourceFile: entry.file, file: `source-${entry.file}`, bytes: entry.bytes, sha256: entry.sha256 });
      }
    }
  }
  sourceEvidence.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile, 'en'));
  const fixedBaseline = { kind: 'captured-browser-side', candidateId: candidate.id, contentDigest: candidate.contentDigest,
    sourceBindingId: candidate.sourceBindingId, sourceRunId: projection.source.runId, sourceMode: projection.source.sourceMode,
    sourceSide: projection.source.side, entryUrl: projection.source.entryUrl, sourceContentDigest: candidate.sourceContentDigest,
    organizationContextDigest: candidate.organizationContextDigest, sourceEnvironment: copy(data.environment),
    verifierFingerprint: data.verifierFingerprint, sourcePlanDigest: projection.sourcePlanDigest,
    selectedEvidenceManifestDigest: projection.selectedEvidenceManifestDigest, scopeKey: projection.scopeKey,
    ruleManifestKey: projection.ruleManifestKey, oracleManifestKey: projection.oracleManifestKey };
  const plan = { ...copy(data.sourcePlan), baselineUrl: projection.source.entryUrl, targetUrl: targetRelease.targetUrl };
  const contract = { contractVersion: 1, mode: 'browser-fixed', projectId: candidate.projectId, candidateId: candidate.id,
    contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id, targetUrl: targetRelease.targetUrl,
    plan, fixedBaseline, observations: copy(data.observations), rules: copy(data.rules), scope: copy(data.scope), sourceEvidence };
  contract.contractDigest = hashAcceptanceValue(contract);
  validateFixedBrowserContract(contract);
  freeze(contract);
  // The capability is process-local. Serialized user input cannot introduce a baseline provider.
  compiled.set(contract, { digest: contract.contractDigest, files: new Map([...sourceFiles].map(([file, bytes]) => [file, Buffer.from(bytes)])) });
  return { contract, sourceFiles };
}

/** Pure serialized-data validation. Authenticity still comes from the owning operation's immutable dispatch. */
export function validateFixedBrowserContract(contract) {
  assertBrowserCandidateEnvelope(contract);
  const names = ['contractVersion', 'mode', 'projectId', 'candidateId', 'contentDigest', 'targetReleaseId', 'targetUrl',
    'plan', 'fixedBaseline', 'observations', 'rules', 'scope', 'sourceEvidence', 'contractDigest'];
  fields(contract, names, names, fail);
  const { contractDigest, ...content } = contract, baseline = contract.fixedBaseline, hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (contract.contractVersion !== 1 || contract.mode !== 'browser-fixed' || !hash(contractDigest)
    || hashAcceptanceValue(content) !== contractDigest) fail();
  id(contract.projectId, 'ap', fail); id(contract.candidateId, 'bc', fail); id(contract.targetReleaseId, 'ar', fail);
  if (!hash(contract.contentDigest) || url(contract.targetUrl, fail) !== contract.targetUrl) fail();
  const baselineNames = ['kind', 'candidateId', 'contentDigest', 'sourceBindingId', 'sourceRunId', 'sourceMode', 'sourceSide',
    'entryUrl', 'sourceContentDigest', 'organizationContextDigest', 'sourceEnvironment', 'verifierFingerprint', 'sourcePlanDigest',
    'selectedEvidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey'];
  fields(baseline, baselineNames, baselineNames, fail);
  id(baseline.sourceBindingId, 'ax', fail); id(baseline.sourceRunId, 'ac', fail);
  if (baseline.kind !== 'captured-browser-side' || baseline.candidateId !== contract.candidateId || baseline.contentDigest !== contract.contentDigest
    || !['mirror', 'regression'].includes(baseline.sourceMode) || !['baseline', 'target'].includes(baseline.sourceSide)
    || url(baseline.entryUrl, fail) !== baseline.entryUrl
    || ['sourceContentDigest', 'organizationContextDigest', 'verifierFingerprint', 'sourcePlanDigest', 'selectedEvidenceManifestDigest',
      'scopeKey', 'ruleManifestKey', 'oracleManifestKey'].some(key => !hash(baseline[key]))) fail();
  let normalized;
  try { normalized = normalizeAcceptancePlan(contract.plan); } catch { fail(); }
  if (!same(normalized, contract.plan) || normalized.mode !== baseline.sourceMode
    || normalized.baselineUrl !== baseline.entryUrl || normalized.targetUrl !== contract.targetUrl) fail();
  if (![contract.observations, contract.rules, contract.scope, contract.sourceEvidence].every(Array.isArray)) fail();
  const expectedSlots = [];
  for (const route of normalized.routes) for (const viewport of normalized.viewports) {
    const slot = { route, viewport: { width: viewport.width, height: viewport.height } };
    expectedSlots.push(slot, ...normalized.points.filter(point => point.route === route).map(point => ({ ...slot, pointId: point.id })));
  }
  const slots = new Set(expectedSlots.map(slotKey)), found = new Set(), files = new Map();
  if (contract.observations.length !== slots.size) fail();
  for (const value of contract.observations) {
    const key = slotKey(value.slot);
    if (!slots.has(key) || found.has(key)) fail(); found.add(key);
    for (const role of ['details', 'screenshot', 'repeat']) {
      const entry = value.evidence?.[role];
      if (!entry || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.file) || !Number.isSafeInteger(entry.bytes)
        || entry.bytes <= 0 || !hash(entry.sha256)) fail();
      const prior = files.get(entry.file);
      if (prior && !same(prior, entry)) fail();
      files.set(entry.file, entry);
    }
  }
  if (files.size !== contract.sourceEvidence.length) fail();
  const seenFiles = new Set();
  for (const value of contract.sourceEvidence) {
    fields(value, ['sourceFile', 'file', 'bytes', 'sha256'], ['sourceFile', 'file', 'bytes', 'sha256'], fail);
    const original = files.get(value.sourceFile);
    if (!original || seenFiles.has(value.sourceFile) || value.file !== `source-${value.sourceFile}`
      || value.bytes !== original.bytes || value.sha256 !== original.sha256) fail();
    seenFiles.add(value.sourceFile);
  }
  const expectedCases = expectedSlots.flatMap(slot => (slot.pointId ? ['behavior'] : ['navigation', 'console', 'network', 'overflow', 'structure', 'visual'])
    .map(facet => ({ ...slot, facet })));
  if (contract.scope.length !== expectedCases.length || contract.rules.length !== expectedCases.length
    || !same([...contract.scope].map(slotKey).sort(), expectedCases.map(slotKey).sort())
    || !same(contract.rules.map(value => slotKey(value.slot)).sort(), expectedCases.map(slotKey).sort())) fail();
  return contract;
}

/** Internal runner bridge: only an actual compiler result and its exact captured bytes qualify. */
export function fixedBrowserRuntimeOf(contract, sourceFiles) {
  const state = compiled.get(contract);
  if (!state || !(sourceFiles instanceof Map) || sourceFiles.size !== state.files.size) fail();
  const { contractDigest, ...content } = contract;
  if (state.digest !== contractDigest || hashAcceptanceValue(content) !== state.digest) fail();
  for (const [file, original] of state.files) {
    const data = sourceFiles.get(file);
    if (!Buffer.isBuffer(data) || !data.equals(original)) fail();
  }
  const observations = new Map(contract.observations.map(value => [slotKey(value.slot), value]));
  return {
    contract,
    sourceFiles: new Map([...state.files].map(([file, bytes]) => [file, Buffer.from(bytes)])),
    observation(route, viewport, point) {
      const slot = { route, viewport: { width: viewport.width, height: viewport.height }, ...(point ? { pointId: point.id } : {}) };
      const selected = observations.get(slotKey(slot));
      if (!selected) fail();
      const original = state.files.get(selected.evidence.details.file);
      const side = JSON.parse(original.toString('utf8'));
      side.details = `source-${selected.evidence.details.file}`;
      side.screenshot = `source-${selected.evidence.screenshot.file}`;
      side.repeatedScreenshot = `source-${selected.evidence.repeat.file}`;
      side.image = Buffer.from(state.files.get(selected.evidence.screenshot.file));
      return side;
    },
    identity(route, viewport, facet, point) {
      const slot = { route, viewport: { width: viewport.width, height: viewport.height }, ...(point ? { pointId: point.id } : {}) };
      return identityData(contract, slot, facet);
    },
  };
}
