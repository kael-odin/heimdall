/** Pure validation of one captured managed head/completed snapshot. No file,
 * owner, freshness, execution permission or HTTP authenticity is established. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { fields, iso, plain } from './catalog-schema.mjs';
import { ACCEPTANCE_SNAPSHOT_LIMITS } from './constants.mjs';
import { canonicalAcceptanceJson } from './identity.mjs';
import { ManagedAcceptanceRunError, validateManagedRunLinkage } from './managed-run-schema.mjs';
import { validateManagedSpecRaw, validateManagedProgress, validateManagedSettlement } from './managed-execution-schema.mjs';
import { validateManagedSpecEvidence } from './managed-evidence-schema.mjs';
import { summarizeAcceptanceReport } from './report.mjs';

// Keep the literal frozen runner contract. It currently has seventeen fields;
// the remaining stored report fields are independently required below.
const RAW_FIELDS = ['schemaVersion', 'runId', 'name', 'mode', 'targetUrl', 'startedAt', 'endedAt', 'status',
  'checks', 'coverage', 'specSource', 'sourceFingerprint', 'contractFingerprint', 'specApproval', 'safety', 'environment', 'scope'];
const REPORT_FIELDS = [...RAW_FIELDS, 'taskId', 'managed', 'planFingerprint', 'verifierFingerprint', 'evidenceManifest', 'gate', 'summary'];
const HEAD_FIELDS = ['schemaVersion', 'runId', 'taskId', 'name', 'mode', 'targetUrl', 'status', 'gate',
  'createdAt', 'updatedAt', 'plan', 'summary', 'progress', 'managed'];
const SUMMARY_FIELDS = ['total', 'passed', 'failed', 'blocked', 'needsReview', 'bugs', 'baselineFailed', 'missing', 'invalid', 'coverage', 'dimensions'];
const DIMENSION_FIELDS = ['total', 'passed', 'failed', 'blocked', 'needsReview', 'score'];
const HASH = /^[a-f0-9]{64}$/;
const EVIDENCE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/;
const RESERVED = new Set(['manifest.json', 'report.json', 'triage.json', 'plan.json', 'dispatch.json', 'evidence-manifest.json']);
const JSON_NODES = 400_000, JSON_DEPTH = 80;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get;
const typedSet = Uint8Array.prototype.set, mapForEach = Map.prototype.forEach;
const fail = () => { throw new ManagedAcceptanceRunError('MANAGED_RUN_INTEGRITY_FAILED', 'INVALID_INPUT'); };
const requireThat = value => { if (!value) fail(); };
const shape = (value, allowed, required = allowed) => fields(value, allowed, required, fail);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => canonicalAcceptanceJson(a) === canonicalAcceptanceJson(b);
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const evidenceName = name => typeof name === 'string' && name.length <= 240 && EVIDENCE.test(name)
  && !RESERVED.has(name.toLowerCase()) && !name.includes('.tmp.');

/** Descriptor capture never stringifies caller objects or invokes hooks.
 * The JSON accounting includes keys, delimiters and encoded string escapes. */
function captureJson(input, maxBytes, parsed = false) {
  const ancestors = new WeakSet(); let nodes = 0, bytes = 0;
  const spend = amount => { bytes += amount; requireThat(bytes <= maxBytes); };
  const visit = (value, depth) => {
    requireThat(++nodes <= JSON_NODES && depth <= JSON_DEPTH);
    if (value === null || typeof value === 'boolean') { spend(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === 'number') { requireThat(Number.isFinite(value)); spend(JSON.stringify(value).length); return value; }
    if (typeof value === 'string') { requireThat(value.length <= maxBytes); spend(Buffer.byteLength(JSON.stringify(value))); return value; }
    requireThat(typeof value === 'object' && !types.isProxy(value) && !ancestors.has(value));
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    requireThat(array ? prototype === Array.prototype || prototype === null : plain(value));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    requireThat(keys.length <= JSON_NODES - nodes + 1);
    if (array) requireThat(keys.length === descriptors.length.value + 1);
    const output = array ? [] : {}; let entries = 0;
    ancestors.add(value); spend(2);
    for (const key of keys) {
      const descriptor = descriptors[key];
      requireThat(typeof key === 'string' && (parsed || key !== 'toJSON') && Object.hasOwn(descriptor, 'value'));
      if (array && key === 'length') continue;
      requireThat(descriptor.enumerable && (!array || /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < descriptors.length.value));
      if (entries++) spend(1);
      if (!array) { requireThat(key.length <= maxBytes); spend(Buffer.byteLength(JSON.stringify(key)) + 1); }
      Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(value); return output;
  };
  return visit(input, 0);
}
/** Opaque bytes use typed-array intrinsics, never user slice/iterator/toJSON.
 * Shared memory cannot supply stable captured facts and is rejected. */
function captureBytes(value, maxBytes) {
  requireThat(value !== null && typeof value === 'object' && !types.isProxy(value) && types.isUint8Array(value)
    && !types.isSharedArrayBuffer(typedBuffer.call(value)));
  const length = typedLength.call(value);
  requireThat(length > 0 && length <= maxBytes);
  const copy = new Uint8Array(length); typedSet.call(copy, value); return copy;
}
function capturedJson(bytesInput, jsonInput, maxBytes) {
  const bytes = captureBytes(bytesInput, maxBytes);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { fail(); }
  parsed = captureJson(parsed, maxBytes, true);
  requireThat(same(parsed, captureJson(jsonInput, maxBytes)));
  return { bytes, json: parsed };
}
function limitsOf(input = {}) {
  shape(input, Object.keys(ACCEPTANCE_SNAPSHOT_LIMITS), []);
  for (const [key, value] of Object.entries(input)) requireThat(count(value, ACCEPTANCE_SNAPSHOT_LIMITS[key]));
  return { ...ACCEPTANCE_SNAPSHOT_LIMITS, ...input };
}
function recordOf(input, maxBytes) {
  shape(input, ['bytes', 'sha256', 'envelope'], ['bytes', 'sha256']);
  if (Object.hasOwn(input, 'envelope')) captureJson(input.envelope, maxBytes);
  const bytes = captureBytes(input.bytes, maxBytes);
  requireThat(typeof input.sha256 === 'string' && HASH.test(input.sha256) && digest(bytes) === input.sha256);
  return { bytes, sha256: input.sha256 };
}
function summaryOf(summary, limit) {
  shape(summary, SUMMARY_FIELDS);
  for (const key of SUMMARY_FIELDS.slice(0, -2)) requireThat(count(summary[key], limit));
  shape(summary.coverage, ['measured', 'total', 'ratio']);
  requireThat(count(summary.coverage.measured, limit) && count(summary.coverage.total, limit)
    && summary.coverage.measured <= summary.coverage.total && typeof summary.coverage.ratio === 'number'
    && Number.isFinite(summary.coverage.ratio) && summary.coverage.ratio >= 0 && summary.coverage.ratio <= 1);
  shape(summary.dimensions, ['visual', 'structure', 'behavior', 'health']);
  for (const row of Object.values(summary.dimensions)) {
    shape(row, DIMENSION_FIELDS);
    for (const key of DIMENSION_FIELDS.slice(0, -1)) requireThat(count(row[key], limit));
    requireThat(row.score === null || typeof row.score === 'number' && Number.isFinite(row.score) && row.score >= 0 && row.score <= 1);
  }
}
function bindingOf(linked, reportSha256) {
  const managed = linked.managed;
  return Object.freeze({ runId: linked.runId, taskId: linked.taskId, operationId: managed.operationId,
    dispatchSha256: managed.dispatchSha256, projectId: managed.projectId, targetReleaseId: managed.target.releaseId,
    planFingerprint: managed.planFingerprint, reportSha256 });
}
function headOf(input, limits) {
  const record = recordOf(input.record, limits.jsonBytes);
  const captured = capturedJson(input.manifestBytes, input.manifest, limits.jsonBytes), manifest = captured.json;
  const linked = validateManagedRunLinkage({ record, manifest });
  const terminalFields = manifest.status === 'completed' ? ['endedAt', 'error', 'reportSha256']
    : manifest.status === 'running' ? [] : ['endedAt', 'reasonCode', 'error'];
  shape(manifest, [...HEAD_FIELDS, ...terminalFields]);
  requireThat(iso(manifest.createdAt) && iso(manifest.updatedAt));
  if (manifest.progress !== null) validateManagedProgress({ progress: manifest.progress });
  if (manifest.status === 'completed') {
    requireThat(iso(manifest.endedAt) && manifest.error === null && typeof manifest.reportSha256 === 'string' && HASH.test(manifest.reportSha256));
    shape(manifest.progress, ['kind']); requireThat(manifest.progress.kind === 'acceptance-completed');
    summaryOf(manifest.summary, limits.checks);
  } else {
    requireThat(manifest.gate === 'blocked' && manifest.summary === null);
    if (manifest.status !== 'running') {
      requireThat(iso(manifest.endedAt));
      validateManagedSettlement({ status: manifest.status, reasonCode: manifest.reasonCode, error: manifest.error });
    }
  }
  return { record, manifest, linked, binding: bindingOf(linked, manifest.status === 'completed' ? manifest.reportSha256 : null) };
}
function filesOf(input, limits) {
  requireThat(input !== null && typeof input === 'object' && !types.isProxy(input) && types.isMap(input)
    && Object.getPrototypeOf(input) === Map.prototype && Reflect.ownKeys(input).length === 0);
  const files = new Map(); let total = 0;
  mapForEach.call(input, (value, name) => {
    requireThat(files.size < limits.evidenceFiles && evidenceName(name));
    const bytes = captureBytes(value, Math.min(limits.evidenceFileBytes, limits.evidenceBytes - total));
    total += bytes.byteLength; files.set(name, bytes);
  });
  return { files, total };
}
function referencesOf(report, files, limits) {
  requireThat(Array.isArray(report.checks) && report.checks.length <= limits.checks
    && Array.isArray(report.evidenceManifest) && report.evidenceManifest.length <= limits.evidenceFiles);
  const references = new Set(), indexed = new Set();
  for (const check of report.checks) {
    for (const name of Object.values(check.evidence)) { requireThat(evidenceName(name)); references.add(name); }
  }
  requireThat(references.size === files.size && references.size === report.evidenceManifest.length);
  for (const entry of report.evidenceManifest) {
    shape(entry, ['file', 'bytes', 'sha256']);
    requireThat(evidenceName(entry.file) && references.has(entry.file) && !indexed.has(entry.file)
      && count(entry.bytes, limits.evidenceFileBytes) && entry.bytes > 0 && typeof entry.sha256 === 'string' && HASH.test(entry.sha256));
    const bytes = files.get(entry.file);
    requireThat(bytes !== undefined && bytes.byteLength === entry.bytes && digest(bytes) === entry.sha256);
    indexed.add(entry.file);
  }
  requireThat(indexed.size === references.size);
}

/** Head-only validity is lifecycle/linkage validity, never report/evidence proof.
 * Partial reports cannot promote a running or settled head to completion. */
export function validateManagedRunHead(input) {
  try {
    shape(input, ['record', 'manifestBytes', 'manifest']);
    const { manifest, binding } = headOf(input, ACCEPTANCE_SNAPSHOT_LIMITS);
    return { manifest, binding };
  } catch { fail(); }
}

/** files contains referenced evidence only, excluding both heads. Return the
 * exact public snapshot contract; private binding stays a separate value.
 * Historical verifier hashes are facts, not a demand to match today's sources. */
export function validateManagedCompletedSnapshot(input) {
  try {
    shape(input, ['record', 'manifestBytes', 'manifest', 'reportBytes', 'report', 'files', 'limits'],
      ['record', 'manifestBytes', 'manifest', 'reportBytes', 'report', 'files']);
    const limits = limitsOf(input.limits), head = headOf(input, limits), { record, manifest } = head;
    requireThat(manifest.status === 'completed');
    const captured = capturedJson(input.reportBytes, input.report, limits.jsonBytes), report = captured.json;
    shape(report, REPORT_FIELDS);
    const linked = validateManagedRunLinkage({ record, manifest, report });
    const projected = Object.fromEntries(RAW_FIELDS.map(key => [key, report[key]]));
    const raw = validateManagedSpecRaw({ record, manifest, raw: projected });
    const recomputed = summarizeAcceptanceReport(raw), reportSha256 = digest(captured.bytes);
    requireThat(same(recomputed.summary, report.summary) && recomputed.gate === report.gate
      && manifest.gate === report.gate && same(manifest.summary, report.summary)
      && manifest.endedAt === report.endedAt && manifest.reportSha256 === reportSha256);
    const { files, total } = filesOf(input.files, limits);
    referencesOf(report, files, limits);
    validateManagedSpecEvidence({ plan: linked.plan, raw, files });
    return { snapshot: { manifest, report, integrity: { valid: true, evidenceVerified: true, errors: [],
      verifiedFiles: files.size, verifiedBytes: total, reportSha256 } }, binding: bindingOf(linked, reportSha256) };
  } catch { fail(); }
}
