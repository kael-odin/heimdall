/**
 * B2.1 Spec requirements projector. Pure, synchronous, no filesystem/network/clock/IDs.
 * files is a native Map<basename, Buffer | Uint8Array> containing
 * manifest.json, report.json and every report-referenced evidence file. Extra
 * unreferenced index entries/files never become verified-evidence provenance.
 * The I/O adapter must load/fence one run directory under the catalog owner; this
 * function cannot prove filesystem origin, ownership or a post-return mutation.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalAcceptanceJson, hashAcceptanceValue, buildAcceptanceIdentity } from './identity.mjs';
import { normalizeSpecPlan, SPEC_LIMITS } from './spec-schema.mjs';
import { RESPONSE_SCHEMA_LIMITS } from './response-schema.mjs';
import { openApiDocumentFingerprint } from './openapi.mjs';
import { summarizeAcceptanceReport } from './report.mjs';
import { AcceptanceCatalogError } from './catalog-schema.mjs';

export const SPEC_CANDIDATE_PROJECTION_V1 = Object.freeze({
  projectionVersion: 1, canonicalJsonVersion: 'acceptance-json-v1', digestAlgorithm: 'sha256',
  domain: 'heimdall-acceptance-spec-candidate',
});
export const SPEC_CANDIDATE_LIMITS_V1 = Object.freeze({ jsonBytes: 8 * 1024 * 1024,
  snapshotBytes: 24 * 1024 * 1024, previewBytes: 2 * 1024 * 1024,
  evidenceFiles: 1024, evidenceFileBytes: 64 * 1024 * 1024, evidenceBytes: 256 * 1024 * 1024,
  jsonDepth: 80, jsonNodes: 400_000, jsonCharacters: 32 * 1024 * 1024,
});
/**
 * store.mjs legacy ten-file verifier concatenation. The original pair was
 * sampled from main 1a87b2d; the controlled Spec runner pair was explicitly
 * reviewed with unchanged contract/report/identity semantics when controls are
 * omitted. Cancellation produces no completed report or reusable candidate.
 * D3 changes the shared Browser runner bytes, while its early Spec delegation
 * and the other nine verifier sources retain their reviewed semantics. The
 * shared ten-file D3 LF/CRLF manifest is browser-verifier-reviewed-d3.json.
 * Explicit compatibility is intentional. No unknown historical digest can select
 * today's rules by assertion. When any verifier source changes, review/rebuild
 * this mapping and its golden fixtures; do not simply accept a reported hash.
 */
export const SUPPORTED_SPEC_VERIFIERS_V1 = Object.freeze([
  // Exact LF Git blobs / default checkout (the legacy hash remains byte based).
  '8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d',
  // Same reviewed ten source files with CRLF contents; separators remain LF.
  '32fab6ccb46b1954e7a64c81783699a715013062e6c0bfb6ba19299afc18654f',
  // Reviewed B2.2 controlled Spec runner, exact LF source files.
  'e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8',
  // Same controlled runner source set with CRLF contents; separators stay LF.
  '8d1b75da7efad4f18b279a466ebdf880b1e24bb641ca80070cd03d0700376e9f',
  // Reviewed D3 shared Browser runner; Spec delegates before Browser execution.
  '2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337',
  // Same reviewed D3 source set with CRLF contents; separators remain LF.
  '270251e1ca417383ee019a456d1a103ec461c57a9a8c661fdc9ff562cac515f2',
  // Initial-navigation guard; Spec still delegates first. Independent review is outstanding.
  '7066c543d13122ca37cd28aa061fbd7ba5f0dcecf4c4f67959759aaef2bf47a0',
  '3fa0303bfc4813bbddae1744ba8675a809fbc12003decdc76304d0cf0b45b5f5',
  // Reviewed oversized-page sampling verifier; Spec contracts remain unchanged.
  '55b87d3783441d9f04defc2c5bbb4b95728fcaa18752044eef4c99241f5bc64e',
  '3db03d17818b11182bdbbb5e1374f9305055392a934c0d21a73b57372db25de8',
]);
const HASH = /^[a-f0-9]{64}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDS = Object.fromEntries(['ap', 'ar', 'ac'].map(prefix => [prefix, new RegExp(`^${prefix}-${UUID}$`)]));
const FILE = /^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (a, b) => {
  try { return canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b); } catch { return false; }
};
const copy = value => JSON.parse(JSON.stringify(value));
const id = (value, prefix) => typeof value === 'string' && IDS[prefix].test(value);
const iso = value => typeof value === 'string' && value.length === 24 && (() => {
  try { return new Date(value).toISOString() === value; } catch { return false; }
})();
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
class Rejection extends Error {
  constructor(code, context = {}) { super(code); this.reason = { code, ...context }; }
}
const reject = (code, context) => { throw new Rejection(code, context); };
const requireThat = (condition, code, context) => { if (!condition) reject(code, context); };
function fields(value, allowed, required = allowed, code = 'SOURCE_INPUT_INVALID', context) {
  requireThat(plain(value), code, context);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) requireThat(typeof key === 'string'
    && allowed.includes(key) && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value'), code, context);
  requireThat(required.every(key => Object.hasOwn(descriptors, key)), code, context);
}
/** Bound complexity before canonical recursion, without evaluating getters/hooks. */
function strictJson(value, maxBytes, code) {
  const active = new WeakSet();
  let nodes = 0, characters = 0;
  const visit = (entry, depth) => {
    requireThat(++nodes <= SPEC_CANDIDATE_LIMITS_V1.jsonNodes && depth <= SPEC_CANDIDATE_LIMITS_V1.jsonDepth, code);
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') { requireThat(Number.isFinite(entry), code); return; }
    if (typeof entry === 'string') {
      characters += entry.length;
      requireThat(characters <= SPEC_CANDIDATE_LIMITS_V1.jsonCharacters, code); return;
    }
    requireThat(typeof entry === 'object' && !types.isProxy(entry) && !active.has(entry), code);
    const array = Array.isArray(entry);
    requireThat(array ? [Array.prototype, null].includes(Object.getPrototypeOf(entry)) : plain(entry), code);
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    if (array) requireThat(keys.length === descriptors.length.value + 1, code);
    active.add(entry);
    for (const key of keys) {
      const descriptor = descriptors[key];
      requireThat(typeof key === 'string' && Object.hasOwn(descriptor, 'value'), code);
      if (array && key === 'length') continue;
      requireThat(descriptor.enumerable && (!array || /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < descriptors.length.value), code);
      characters += key.length;
      requireThat(characters <= SPEC_CANDIDATE_LIMITS_V1.jsonCharacters, code);
      visit(descriptor.value, depth + 1);
    }
    active.delete(entry);
  };
  visit(value, 0);
  canonicalAcceptanceJson(value);
  requireThat(Buffer.byteLength(JSON.stringify(value)) <= maxBytes, code);
  return value;
}
function digestManifest(kind, value) {
  return hashAcceptanceValue({ ...SPEC_CANDIDATE_PROJECTION_V1, kind, value });
}
function byteReader(files) {
  requireThat(files !== null && typeof files === 'object' && !types.isProxy(files)
    && Object.getPrototypeOf(files) === Map.prototype && Reflect.ownKeys(files).length === 0, 'SOURCE_FILES_INVALID');
  const entries = [...Map.prototype.entries.call(files)];
  requireThat(entries.length <= SPEC_CANDIDATE_LIMITS_V1.evidenceFiles + 2, 'SOURCE_FILES_BUDGET');
  const supplied = new Map(entries);
  for (const [name] of entries) requireThat(typeof name === 'string' && FILE.test(name), 'SOURCE_FILES_INVALID');
  const cache = new Map();
  return (name, maxBytes) => {
    if (cache.has(name)) return cache.get(name);
    requireThat(supplied.has(name), 'SOURCE_FILE_MISSING', { file: name });
    const raw = supplied.get(name);
    requireThat(raw !== null && typeof raw === 'object' && !types.isProxy(raw)
      && (Buffer.isBuffer(raw) && Object.getPrototypeOf(raw) === Buffer.prototype
        || raw instanceof Uint8Array && Object.getPrototypeOf(raw) === Uint8Array.prototype), 'SOURCE_FILE_INVALID', { file: name });
    const nativeByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get.call(raw);
    requireThat(nativeByteLength <= maxBytes, 'SOURCE_FILE_BUDGET', { file: name });
    const bytes = Buffer.from(raw);
    requireThat(bytes.length <= maxBytes, 'SOURCE_FILE_BUDGET', { file: name });
    cache.set(name, bytes);
    return bytes;
  };
}
function parseObject(bytes, file) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject('SOURCE_FILE_JSON_INVALID', { file }); }
  requireThat(plain(value), 'SOURCE_FILE_JSON_INVALID', { file });
  strictJson(value, SPEC_CANDIDATE_LIMITS_V1.jsonBytes, 'SOURCE_FILE_JSON_BUDGET');
  return value;
}
function ruleOf(plan, contract) {
  return { method: contract.method, path: contract.path, expect: contract.expect,
    timeoutMs: plan.timeoutMs, maxResponseBytes: plan.maxResponseBytes, runMs: SPEC_LIMITS.runMs,
    responseSchemaLimits: RESPONSE_SCHEMA_LIMITS, redirect: 'manual', credentials: 'omit', allowedMethods: ['GET', 'HEAD'] };
}

/**
 * Candidate eligibility approves complete declared requirements; source gate may
 * be failed/blocked and source spec.approved may be false. No actual/request/body
 * value can create or replace an expected contract. Internal server preparation
 * also receives the freshly parsed, normalized plan; HTTP callers must use the
 * public projector below, which returns only projection and bounded preview.
 */
export function verifySpecBaselineMaterial(input, options) {
  try {
    fields(input, ['snapshot', 'files']);
    fields(options, ['projectId', 'releaseId', 'sourceSide']);
    const { snapshot, files } = input;
    const { projectId, releaseId, sourceSide } = options;
    requireThat(id(projectId, 'ap') && id(releaseId, 'ar'), 'SOURCE_CONTEXT_INVALID');
    requireThat(sourceSide === 'source', 'SOURCE_SIDE_UNSUPPORTED');
    strictJson(snapshot, SPEC_CANDIDATE_LIMITS_V1.snapshotBytes, 'SOURCE_SNAPSHOT_INVALID');
    fields(snapshot, ['manifest', 'report', 'integrity'], undefined, 'SOURCE_SNAPSHOT_INVALID');
    fields(snapshot.integrity, ['valid', 'evidenceVerified', 'errors', 'verifiedFiles', 'verifiedBytes', 'reportSha256'], undefined, 'SOURCE_INTEGRITY_FAILED');
    const integrity = snapshot.integrity;
    requireThat(integrity.valid === true && integrity.evidenceVerified === true
      && Array.isArray(integrity.errors) && integrity.errors.length === 0, 'SOURCE_INTEGRITY_FAILED');
    const read = byteReader(files);
    const manifestBytes = read('manifest.json', SPEC_CANDIDATE_LIMITS_V1.jsonBytes);
    const reportBytes = read('report.json', SPEC_CANDIDATE_LIMITS_V1.jsonBytes);
    const manifest = parseObject(manifestBytes, 'manifest.json'), report = parseObject(reportBytes, 'report.json');
    const sourceRunId = manifest.runId;
    requireThat(same(manifest, snapshot.manifest) && same(report, snapshot.report), 'SOURCE_SNAPSHOT_BYTES_MISMATCH');
    requireThat(id(sourceRunId, 'ac') && manifest.schemaVersion === 1 && report.schemaVersion === 1
      && report.runId === sourceRunId, 'SOURCE_RUN_IDENTITY_MISMATCH');
    requireThat(manifest.mode === 'spec' && report.mode === 'spec' && manifest.plan?.mode === 'spec', 'SOURCE_MODE_UNSUPPORTED');
    requireThat(manifest.status === 'completed' && report.status === 'completed', 'SOURCE_RUN_NOT_COMPLETE');
    requireThat(!Object.hasOwn(manifest, 'baselineUrl') && !Object.hasOwn(report, 'baselineUrl'), 'SOURCE_SIDE_UNSUPPORTED');
    requireThat(manifest.targetUrl === report.targetUrl, 'SOURCE_TARGET_MISMATCH');
    requireThat(HASH.test(manifest.reportSha256 ?? '') && sha(reportBytes) === manifest.reportSha256
      && integrity.reportSha256 === manifest.reportSha256, 'SOURCE_REPORT_DIGEST_MISMATCH');
    requireThat(iso(report.startedAt) && iso(report.endedAt) && report.endedAt >= report.startedAt
      && manifest.endedAt === report.endedAt, 'SOURCE_REPORT_TIME_INVALID');
    strictJson(manifest.plan, SPEC_CANDIDATE_LIMITS_V1.jsonBytes, 'SOURCE_PLAN_INVALID');
    let plan;
    try { plan = normalizeSpecPlan(manifest.plan); } catch { reject('SOURCE_PLAN_INVALID'); }
    requireThat(same(plan, manifest.plan), 'SOURCE_PLAN_NOT_NORMALIZED');
    requireThat(plan.targetUrl === manifest.targetUrl && manifest.name === plan.name && report.name === plan.name, 'SOURCE_PLAN_CONTEXT_MISMATCH');
    // Exact historical algorithms: store hashes the saved plan; the Spec runner
    // normalizes its input again before hashing source and contract objects.
    const sourcePlanDigest = sha(JSON.stringify(manifest.plan));
    const sourceFingerprint = sha(JSON.stringify(plan.spec.source));
    const contractFingerprint = sha(JSON.stringify(plan.spec));
    requireThat(HASH.test(report.planFingerprint ?? '') && report.planFingerprint === sourcePlanDigest, 'SOURCE_PLAN_DIGEST_MISMATCH');
    requireThat(report.sourceFingerprint === sourceFingerprint && report.contractFingerprint === contractFingerprint, 'SOURCE_CONTRACT_DIGEST_MISMATCH');
    requireThat(same(report.specSource, plan.spec.source), 'SOURCE_REQUIREMENT_MISMATCH');
    fields(report.specApproval, ['approved', 'recordedAt'], undefined, 'SOURCE_SPEC_APPROVAL_MISMATCH');
    requireThat(report.specApproval.approved === plan.spec.approved && report.specApproval.recordedAt === report.startedAt, 'SOURCE_SPEC_APPROVAL_MISMATCH');
    requireThat(plan.spec.checks.length >= 1 && plan.spec.omissions.length === 0, 'SOURCE_SCOPE_INCOMPLETE');
    requireThat(Array.isArray(report.checks) && report.checks.length === plan.spec.checks.length, 'SOURCE_CHECK_SLOTS_MISMATCH');
    fields(report.coverage, ['planned', 'completed', 'capped'], undefined, 'SOURCE_COVERAGE_INCOMPLETE');
    requireThat(report.coverage.planned === plan.spec.checks.length && report.coverage.completed === plan.spec.checks.length
      && report.coverage.capped === false, 'SOURCE_COVERAGE_INCOMPLETE');
    const summarized = summarizeAcceptanceReport(report);
    requireThat(same(summarized.summary, report.summary) && same(manifest.summary, report.summary)
      && summarized.gate === report.gate && manifest.gate === report.gate
      && report.summary.missing === 0 && report.summary.invalid === 0, 'SOURCE_REPORT_SUMMARY_MISMATCH');
    requireThat(SUPPORTED_SPEC_VERIFIERS_V1.includes(report.verifierFingerprint), 'SOURCE_VERIFIER_UNSUPPORTED');
    fields(report.environment, ['runner', 'platform', 'arch', 'nodeVersion', 'maxResponseBytes', 'timeoutMs'], undefined, 'SOURCE_ENVIRONMENT_INVALID');
    const environment = { platform: report.environment.platform, arch: report.environment.arch,
      nodeVersion: report.environment.nodeVersion, runner: report.environment.runner };
    requireThat(environment.runner === 'node-fetch' && [environment.platform, environment.arch, environment.nodeVersion].every(value => text(value, 200))
      && report.environment.maxResponseBytes === plan.maxResponseBytes && report.environment.timeoutMs === plan.timeoutMs, 'SOURCE_ENVIRONMENT_INVALID');
    fields(report.safety, ['readOnly', 'allowedMethods', 'redirects', 'credentials', 'requests'], undefined, 'SOURCE_SAFETY_MISMATCH');
    requireThat(report.safety.readOnly === true && same(report.safety.allowedMethods, ['GET', 'HEAD'])
      && report.safety.redirects === 'not-followed' && report.safety.credentials === 'none'
      && Number.isSafeInteger(report.safety.requests) && report.safety.requests >= 0
      && report.safety.requests <= plan.spec.checks.length, 'SOURCE_SAFETY_MISMATCH');
    requireThat(Array.isArray(report.evidenceManifest) && report.evidenceManifest.length <= SPEC_CANDIDATE_LIMITS_V1.evidenceFiles, 'SOURCE_EVIDENCE_INDEX_INVALID');
    const index = new Map();
    for (const entry of report.evidenceManifest) {
      fields(entry, ['file', 'bytes', 'sha256'], undefined, 'SOURCE_EVIDENCE_INDEX_INVALID');
      requireThat(typeof entry.file === 'string' && FILE.test(entry.file) && Number.isSafeInteger(entry.bytes)
        && entry.bytes >= 0 && HASH.test(entry.sha256 ?? '') && !index.has(entry.file), 'SOURCE_EVIDENCE_INDEX_INVALID');
      index.set(entry.file, entry);
    }
    const references = new Set(), checksById = new Map();
    for (const check of report.checks) {
      requireThat(plain(check) && typeof check.id === 'string' && !checksById.has(check.id), 'SOURCE_CHECK_SLOTS_MISMATCH');
      checksById.set(check.id, check);
      fields(check.evidence, ['source', 'contract', 'request', 'response'], ['contract'], 'SOURCE_EVIDENCE_ROLES_INVALID', { checkId: check.id });
      for (const file of Object.values(check.evidence)) {
        requireThat(typeof file === 'string' && FILE.test(file), 'SOURCE_EVIDENCE_REFERENCE_INVALID', { checkId: check.id });
        references.add(file);
      }
    }
    requireThat(references.size <= SPEC_CANDIDATE_LIMITS_V1.evidenceFiles, 'SOURCE_EVIDENCE_BUDGET');
    const verified = [], evidenceBytes = new Map();
    let verifiedBytes = 0;
    for (const file of [...references].sort()) {
      const entry = index.get(file);
      requireThat(!!entry, 'SOURCE_EVIDENCE_NOT_INDEXED', { file });
      requireThat(entry.bytes <= SPEC_CANDIDATE_LIMITS_V1.evidenceFileBytes
        && verifiedBytes + entry.bytes <= SPEC_CANDIDATE_LIMITS_V1.evidenceBytes, 'SOURCE_EVIDENCE_BUDGET', { file });
      const bytes = read(file, SPEC_CANDIDATE_LIMITS_V1.evidenceFileBytes);
      requireThat(bytes.length === entry.bytes && sha(bytes) === entry.sha256, 'SOURCE_EVIDENCE_DIGEST_MISMATCH', { file });
      verifiedBytes += bytes.length;
      verified.push({ file, bytes: bytes.length, sha256: entry.sha256 });
      evidenceBytes.set(file, bytes);
    }
    requireThat(integrity.verifiedFiles === verified.length && integrity.verifiedBytes === verifiedBytes, 'SOURCE_VERIFIED_INDEX_MISMATCH');
    const openapi = plan.spec.source.type === 'openapi';
    if (openapi) {
      const file = 'requirement-source.json';
      requireThat(evidenceBytes.has(file), 'SOURCE_REQUIREMENT_EVIDENCE_MISSING', { file });
      const sourceEvidence = parseObject(evidenceBytes.get(file), file);
      fields(sourceEvidence, ['source', 'document'], undefined, 'SOURCE_REQUIREMENT_EVIDENCE_MISMATCH', { file });
      requireThat(same(sourceEvidence.source, plan.spec.source) && same(sourceEvidence.document, plan.spec.document)
        && openApiDocumentFingerprint(sourceEvidence.document) === plan.spec.source.sha256, 'SOURCE_REQUIREMENT_EVIDENCE_MISMATCH', { file });
    }
    const sourceIdentity = { id: plan.spec.source.id, revision: plan.spec.source.revision,
      type: plan.spec.source.type, sha256: plan.spec.source.sha256 ?? null };
    const reportOracle = { kind: plan.spec.approved ? 'approved-spec' : 'draft-spec', source: plan.spec.source.id,
      revision: plan.spec.source.revision, sourceFingerprint, documentSha256: plan.spec.source.sha256 ?? null, contractFingerprint };
    const slots = [], rules = [], oracles = [], previewChecks = [];
    let requested = 0;
    for (const [position, contract] of plan.spec.checks.entries()) {
      const checkId = `spec-${position + 1}-${contract.id}`, check = checksById.get(checkId);
      requireThat(!!check, 'SOURCE_CHECK_SLOT_MISSING', { checkId });
      const context = { checkId };
      const definition = { method: contract.method, path: contract.path, expect: contract.expect };
      const rule = ruleOf(plan, contract);
      const identity = buildAcceptanceIdentity({ kind: 'spec', facet: 'contract', route: contract.path,
        contractId: contract.id, method: contract.method, viewport: 'api', environment: report.environment,
        rule, oracle: { kind: 'spec', source: sourceIdentity, contract: definition } });
      requireThat(identity !== null && same(identity, check.identity), 'SOURCE_CHECK_IDENTITY_MISMATCH', context);
      requireThat(check.title === contract.title && check.route === contract.path && check.viewport === 'api'
        && check.dimension === 'behavior' && check.severity === contract.severity && check.evidenceLevel === 'http-reproduced'
        && same(check.expected, contract.expect) && same(check.oracle, reportOracle), 'SOURCE_CHECK_CONTRACT_MISMATCH', context);
      requireThat(typeof check.evaluationLimited === 'boolean' && plain(check.actual)
        && typeof check.actual.requested === 'boolean', 'SOURCE_CHECK_EXECUTION_INVALID', context);
      requireThat(check.evidence.contract === `${checkId}-contract.json`, 'SOURCE_CONTRACT_ROLE_MISMATCH', context);
      requireThat(openapi ? check.evidence.source === 'requirement-source.json' : !Object.hasOwn(check.evidence, 'source'), 'SOURCE_REQUIREMENT_ROLE_MISMATCH', context);
      const file = check.evidence.contract, contractEvidence = parseObject(evidenceBytes.get(file), file);
      fields(contractEvidence, ['source', 'approved', 'contract', 'contractFingerprint'], undefined, 'SOURCE_CONTRACT_EVIDENCE_MISMATCH', { ...context, file });
      requireThat(same(contractEvidence.source, plan.spec.source) && contractEvidence.approved === plan.spec.approved
        && same(contractEvidence.contract, contract) && contractEvidence.contractFingerprint === contractFingerprint, 'SOURCE_CONTRACT_EVIDENCE_MISMATCH', { ...context, file });
      if (check.actual.requested) {
        requested++;
        requireThat(plan.spec.approved && check.evidence.request === `${checkId}-request.json`
          && check.evidence.response === `${checkId}-response.json`, 'SOURCE_EXECUTION_ROLES_MISMATCH', context);
        requireThat(check.status === 'passed' && check.verdict === 'match' || check.status === 'failed' && check.verdict === 'bug'
          || check.status === 'blocked' && check.verdict === 'environment', 'SOURCE_CHECK_EXECUTION_INVALID', context);
      } else {
        // capped execution is rejected above, so the only supported unrequested
        // source is the current runner's complete, unapproved requirement draft.
        requireThat(!plan.spec.approved && check.status === 'blocked' && check.verdict === 'needs_review'
          && check.evaluationLimited === true && !Object.hasOwn(check.evidence, 'request')
          && !Object.hasOwn(check.evidence, 'response'), 'SOURCE_CHECK_EXECUTION_INVALID', context);
      }
      const slot = { contractId: contract.id, method: contract.method, path: contract.path };
      slots.push(slot); rules.push({ slot, rule });
      oracles.push({ id: contract.id, ...definition });
      previewChecks.push({ ...copy(contract), rule: copy(rule), identity: copy(identity) });
    }
    requireThat(requested === report.safety.requests, 'SOURCE_SAFETY_REQUEST_COUNT_MISMATCH');
    const sortKey = value => canonicalAcceptanceJson(value.slot ?? value);
    const compare = (a, b) => sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0;
    slots.sort(compare); rules.sort(compare);
    oracles.sort((a, b) => compare({ contractId: a.id, method: a.method, path: a.path }, { contractId: b.id, method: b.method, path: b.path }));
    const projection = { projectionVersion: 1, projectId, mode: 'spec',
      source: { runId: sourceRunId, sourceMode: 'spec', side: 'source', releaseId },
      sourcePlanDigest, sourceReportDigest: manifest.reportSha256,
      evidenceManifestDigest: digestManifest('verified-evidence', verified),
      scopeKey: digestManifest('scope', slots), ruleManifestKey: digestManifest('rules', rules),
      oracleManifestKey: digestManifest('oracle', { source: sourceIdentity,
        documentSha256: plan.spec.source.sha256 ?? null, contracts: oracles }),
      environmentKey: digestManifest('environment', environment), verifierFingerprint: report.verifierFingerprint };
    projection.contentDigest = hashAcceptanceValue(projection);
    const preview = { projectionVersion: 1, projectId, releaseId, mode: 'spec',
      sourceReference: { ...projection.source }, source: copy(plan.spec.source), targetUrl: plan.targetUrl, name: plan.name,
      sourceStatus: report.status, sourceGate: report.gate, sourceSpecApproved: plan.spec.approved,
      declaredSlots: plan.spec.checks.length, projectedSlots: slots.length, omissions: [],
      checks: previewChecks, executionReady: false, oracleStorage: 'stored-contract',
      reviewNotice: '人工复核并批准的是这里完整显示的来源与规范合同；来源运行门禁和目标响应不会成为期望值。批准或选用不会发起新运行。' };
    requireThat(Buffer.byteLength(JSON.stringify(preview)) <= SPEC_CANDIDATE_LIMITS_V1.previewBytes, 'SOURCE_PREVIEW_BUDGET');
    return { projection, preview, plan };
  } catch (error) {
    const reason = error instanceof Rejection ? error.reason : { code: 'SOURCE_INPUT_INVALID' };
    const integrityFailure = /(?:INTEGRITY|DIGEST|BYTES|FILE_|FILES_|EVIDENCE_|VERIFIED_INDEX)/.test(reason.code);
    throw new AcceptanceCatalogError(integrityFailure ? 'SOURCE_INTEGRITY_FAILED' : 'SOURCE_NOT_ELIGIBLE', 409,
      integrityFailure ? '来源文件未通过完整性复验，不能批准为基线。' : '来源运行未满足完整 Spec 合同资格。',
      { reason: reason.code });
  }
}

/** Public candidate projection never exposes the normalized source plan/document. */
export function projectSpecBaselineCandidate(input, options) {
  const { projection, preview } = verifySpecBaselineMaterial(input, options);
  return { projection, preview };
}
