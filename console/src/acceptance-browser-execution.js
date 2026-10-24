/** Strict durable identifiers, read DTOs and cancellable in-memory evidence. */
import { defaultReceiptCollections } from './receipt-collections.js';
const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const validId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-${UUID}$`).test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 1000) => typeof value === 'string' && value.length <= max;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = (message = 'Browser 响应无法核对，请只读查询原操作。') => { throw Object.assign(new Error(message), { code: 'INVALID_RESPONSE' }); };
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const same = (a, b) => canonical(a) === canonical(b);
const iso = value => text(value, 24) && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const REQUEST = ['operationId', 'expectedGenerationId', 'expectedRevision', 'candidateId', 'contentDigest', 'targetReleaseId'];
const VIEW = ['schemaVersion', 'operationId', 'runId', 'taskId', 'projectId', 'candidateId', 'contentDigest', 'targetReleaseId', 'targetLabel', 'approvalScope', 'state', 'acceptedAt', 'updatedAt', 'gate', 'reportSha256', 'reasonCode', 'summary', 'executionReady'];
const STATES = ['prepared', 'running', 'completed', 'failed', 'interrupted'];
const GATES = ['passed', 'failed', 'blocked', 'needs_review'];
const fileName = value => text(value, 240) && /^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(value) && !value.includes('..') && !['dispatch.json', 'head.json', 'report.json', 'observations.json'].includes(value.toLowerCase());
function fields(value, allowed, required = allowed) {
  if (!object(value)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) invalid();
}
function json(value, maximum = 12 * 1024 * 1024) {
  const pending = [[value, 0]], seen = new Set(); let nodes = 0, characters = 0;
  while (pending.length) {
    const [entry, depth] = pending.pop(); if (++nodes > 400_000 || depth > 80) invalid();
    if (typeof entry === 'string') characters += entry.length;
    else if (entry !== null && typeof entry === 'object') {
      if (seen.has(entry) || !object(entry) && !Array.isArray(entry)) invalid(); seen.add(entry);
      const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
      if (Array.isArray(entry) && (Object.getPrototypeOf(entry) !== Array.prototype || keys.length !== entry.length + 1 || keys.some(key => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= entry.length)))) invalid();
      for (const key of keys) {
        const descriptor = descriptors[key]; if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) invalid();
        if (Array.isArray(entry) && key === 'length') continue;
        if (!descriptor.enumerable) invalid(); characters += key.length; pending.push([descriptor.value, depth + 1]);
      }
    } else if (entry !== null && !['boolean', 'number'].includes(typeof entry) || typeof entry === 'number' && !Number.isFinite(entry)) invalid();
    if (characters > 32 * 1024 * 1024) invalid();
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) invalid('Browser 响应超过完整读取预算，请核对原操作。'); return value;
}
function summary(value) {
  fields(value, ['total', 'passed', 'failed', 'blocked', 'needsReview', 'bugs', 'baselineFailed', 'missing', 'invalid', 'coverage', 'dimensions']);
  if (!['total', 'passed', 'failed', 'blocked', 'needsReview', 'bugs', 'baselineFailed', 'missing', 'invalid'].every(key => integer(value[key]))) invalid();
  fields(value.coverage, ['measured', 'total', 'ratio']);
  if (!integer(value.coverage.measured) || !integer(value.coverage.total) || !Number.isFinite(value.coverage.ratio) || value.coverage.ratio < 0 || value.coverage.ratio > 1 || value.coverage.measured > value.coverage.total) invalid();
  fields(value.dimensions, ['visual', 'structure', 'behavior', 'health']);
  for (const dimension of Object.values(value.dimensions)) {
    fields(dimension, ['total', 'passed', 'failed', 'blocked', 'needsReview', 'score']);
    if (!['total', 'passed', 'failed', 'blocked', 'needsReview'].every(key => integer(dimension[key])) || dimension.score !== null && (!Number.isFinite(dimension.score) || dimension.score < 0 || dimension.score > 1)) invalid();
  }
}
function measuredSummary(report) {
  const checks = report.checks, planned = report.coverage.planned;
  const count = fn => checks.filter(fn).length;
  const reliable = check => ['passed', 'failed'].includes(check.status) && ['match', 'bug'].includes(check.verdict);
  const dimensions = Object.fromEntries(['visual', 'structure', 'behavior', 'health'].map(name => {
    const rows = checks.filter(check => check.dimension === name);
    const scores = rows.filter(check => ['passed', 'failed'].includes(check.status) && Number.isFinite(check.score));
    return [name, { total: rows.length, passed: rows.filter(check => check.status === 'passed' && check.verdict === 'match').length,
      failed: rows.filter(check => check.status === 'failed').length, blocked: rows.filter(check => check.status === 'blocked').length,
      needsReview: rows.filter(check => check.status === 'needs_review').length,
      score: scores.length ? +(scores.reduce((sum, check) => sum + check.score, 0) / scores.length).toFixed(4) : null }];
  }));
  const measured = count(reliable);
  return { total: checks.length, passed: count(check => check.status === 'passed' && check.verdict === 'match'),
    failed: count(check => check.status === 'failed'), blocked: count(check => check.status === 'blocked'),
    needsReview: count(check => check.status === 'needs_review'), bugs: count(check => check.verdict === 'bug'),
    baselineFailed: count(check => check.verdict === 'baseline_failed'), missing: planned - checks.length, invalid: 0,
    coverage: { measured, total: planned, ratio: planned ? +(measured / planned).toFixed(4) : 0 }, dimensions };
}
export function browserExecutionRequest(value) {
  json(value, 16 * 1024); fields(value, REQUEST);
  if (!validId(value.operationId, 'bo') || !validId(value.expectedGenerationId, 'ag') || !integer(value.expectedRevision) || !validId(value.candidateId, 'bc') || !hash(value.contentDigest) || !validId(value.targetReleaseId, 'ar')) invalid('Browser 单次执行确认无效，请重新复核。');
  return Object.fromEntries(REQUEST.map(key => [key, value[key]]));
}
export function browserOperationView(value, projectId, operationId, request) {
  json(value); fields(value, [...VIEW, 'report', 'replayed', 'stopRequested'], VIEW);
  if (value.schemaVersion !== 1 || !validId(projectId, 'ap') || value.projectId !== projectId || !validId(value.operationId, 'bo') || operationId && value.operationId !== operationId || !validId(value.runId, 'br') || !validId(value.taskId, 'a') || !validId(value.candidateId, 'bc') || !validId(value.targetReleaseId, 'ar') || !hash(value.contentDigest) || !text(value.targetLabel, 120) || !iso(value.acceptedAt) || !iso(value.updatedAt) || value.updatedAt < value.acceptedAt || value.approvalScope !== 'single-operation' || value.executionReady !== false || !STATES.includes(value.state) || ['replayed', 'stopRequested'].some(key => Object.hasOwn(value, key) && typeof value[key] !== 'boolean')) invalid();
  if (value.state === 'prepared' ? value.gate !== null || value.reportSha256 !== null || value.reasonCode !== null : value.state === 'completed' ? !GATES.includes(value.gate) || !hash(value.reportSha256) || value.reasonCode !== null : value.gate !== 'blocked' || value.reportSha256 !== null || (value.state === 'running' ? value.reasonCode !== null : typeof value.reasonCode !== 'string' || !/^[A-Z_]{1,80}$/.test(value.reasonCode))) invalid();
  if (value.summary !== null) { if (value.state !== 'completed') invalid(); summary(value.summary); }
  if (request) { const expected = browserExecutionRequest(request); if (!['operationId', 'candidateId', 'contentDigest', 'targetReleaseId'].every(key => value[key] === expected[key])) invalid(); }
  return value;
}
export async function browserStartResolution(raw, { projectId, request, crypto = globalThis.crypto } = {}) {
  const expected = browserExecutionRequest(request);
  json(raw, 12 * 1024 * 1024);
  // Retain an inert snapshot while Web Crypto yields; callers cannot swap a proof mid-check.
  const value = JSON.parse(JSON.stringify(raw));
  const common = ['schemaVersion', 'kind', 'projectId', 'operationId', 'observedAt', 'outcome'];
  const variants = { recorded: ['request', 'requestFingerprint', 'dispatchSha256', 'operation'],
    rejected: ['rejection', 'rejectionSha256'], unresolved: ['reasonCode'] };
  if (!object(value) || !Object.hasOwn(variants, value.outcome)) invalid();
  fields(value, [...common, ...variants[value.outcome]]);
  if (!validId(projectId, 'ap') || value.schemaVersion !== 1 || value.kind !== 'browser-start-resolution'
    || value.projectId !== projectId || value.operationId !== expected.operationId || !iso(value.observedAt)) invalid();
  if (value.outcome === 'unresolved') {
    if (!['ABSENT_OBSERVED', 'ADMISSION_PENDING'].includes(value.reasonCode)) invalid();
    return value;
  }
  const digest = async input => {
    if (typeof crypto?.subtle?.digest !== 'function') invalid('当前浏览器无法核验操作证明摘要；原确认已保留。');
    let bytes;
    try { bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))); }
    catch { invalid('操作证明摘要无法核验；原确认已保留。'); }
    const result = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (!hash(result)) invalid(); return result;
  };
  const fingerprint = await digest(canonical({ domain: 'heimdall-browser-operation-request', version: 1, projectId, request: expected }));
  if (value.outcome === 'recorded') {
    if (!same(browserExecutionRequest(value.request), expected) || value.requestFingerprint !== fingerprint || !hash(value.dispatchSha256)) invalid();
    fields(value.operation, VIEW); browserOperationView(value.operation, projectId, expected.operationId, expected);
  } else {
    const rejection = value.rejection;
    fields(rejection, ['schemaVersion', 'kind', 'projectId', 'operationId', 'request', 'requestFingerprint', 'rejectedAt', 'reasonCode', 'effect', 'actor']);
    fields(rejection.actor, ['kind']);
    if (rejection.schemaVersion !== 1 || rejection.kind !== 'browser-start-rejection' || rejection.projectId !== projectId
      || rejection.operationId !== expected.operationId || !same(browserExecutionRequest(rejection.request), expected)
      || rejection.requestFingerprint !== fingerprint || !iso(rejection.rejectedAt)
      || rejection.reasonCode !== 'USER_REJECTED_UNKNOWN_START' || rejection.effect !== 'deny-future-starts-for-operation'
      || rejection.actor.kind !== 'local-user' || !hash(value.rejectionSha256)
      || value.rejectionSha256 !== await digest(canonical(rejection) + '\n')) invalid();
  }
  return value;
}
export function browserOperationCollection(value, projectId) {
  json(value); fields(value, ['schemaVersion', 'projectId', 'operations', 'capability']);
  if (value.schemaVersion !== 1 || value.projectId !== projectId || !Array.isArray(value.operations) || value.operations.length > 1024) invalid();
  const ids = new Set();
  for (const operation of value.operations) { fields(operation, VIEW); browserOperationView(operation, projectId); if (ids.has(operation.operationId)) invalid(); ids.add(operation.operationId); }
  fields(value.capability, ['enabled', 'ready', 'recoveryReady', 'busy', 'closing', 'blocked', 'code', 'kind', 'runId', 'taskId', 'approvalScope', 'baselineNetworkRequests']);
  const c = value.capability;
  if (!['enabled', 'ready', 'recoveryReady', 'busy', 'closing', 'blocked'].every(key => typeof c[key] === 'boolean') || c.enabled !== true || c.approvalScope !== 'single-operation' || c.baselineNetworkRequests !== false || c.code !== null && !/^[A-Z_]{1,80}$/.test(c.code) || ![null, 'legacy', 'managed', 'browser'].includes(c.kind) || c.runId !== null && !['ac', 'br'].some(prefix => validId(c.runId, prefix)) || c.taskId !== null && !validId(c.taskId, 'a') || c.ready && (!c.recoveryReady || c.busy || c.closing || c.blocked)) invalid();
  return value;
}
export function browserOperationReport(value, projectId, expected) {
  browserOperationView(value, projectId, expected.operationId);
  if (value.state !== 'completed' || value.runId !== expected.runId || value.taskId !== expected.taskId || value.reportSha256 !== expected.reportSha256 || value.candidateId !== expected.candidateId || value.contentDigest !== expected.contentDigest || value.targetReleaseId !== expected.targetReleaseId) invalid();
  const report = value.report;
  if (!object(report) || report.schemaVersion !== 1 || report.mode !== 'browser-fixed' || report.runId !== value.runId || report.operationId !== value.operationId || report.taskId !== value.taskId || report.targetReleaseId !== value.targetReleaseId || report.status !== 'completed' || !hash(report.dispatchSha256) || !hash(report.contractDigest) || report.contractFingerprint !== report.contractDigest || !hash(report.verifierFingerprint) || !iso(report.startedAt) || !iso(report.endedAt) || report.endedAt < report.startedAt || report.gate !== value.gate || !Array.isArray(report.checks) || !report.checks.length || report.checks.length > 240 || !object(report.fixedBaseline) || report.fixedBaseline.kind !== 'captured-browser-side' || report.fixedBaseline.candidateId !== value.candidateId || report.fixedBaseline.contentDigest !== value.contentDigest || !object(report.resolution) || report.resolution.kind !== 'observation-only' || report.resolution.closesBugs !== false || !object(report.environmentComparison) || typeof report.environmentComparison.comparable !== 'boolean' || !Array.isArray(report.environmentComparison.differences) || !Array.isArray(report.evidenceManifest) || report.evidenceManifest.length > 1024) invalid();
  summary(report.summary); if (!same(report.summary, value.summary)) invalid();
  fields(report.coverage, ['planned', 'completed', 'capped']);
  if (!integer(report.coverage.planned) || report.coverage.planned < report.checks.length || report.coverage.completed !== report.checks.length
    || typeof report.coverage.capped !== 'boolean' || report.summary.total !== report.checks.length
    || report.summary.coverage.total !== report.coverage.planned || report.summary.missing !== report.coverage.planned - report.checks.length) invalid();
  fields(report.safety, ['networkPolicy', 'isolatedContexts', 'blockedRequests']);
  if (report.safety.networkPolicy !== 'read-only' || report.safety.isolatedContexts !== true || !integer(report.safety.blockedRequests)
    || !validId(report.fixedBaseline.sourceRunId, 'ac') || !hash(report.fixedBaseline.sourceContentDigest)
    || !['baseline', 'target'].includes(report.fixedBaseline.sourceSide)
    || report.environmentComparison.comparable !== (report.environmentComparison.differences.length === 0)) invalid();
  const index = new Map(); let bytes = 0;
  for (const entry of report.evidenceManifest) { fields(entry, ['file', 'bytes', 'sha256']); if (!fileName(entry.file) || !integer(entry.bytes) || entry.bytes > 64 * 1024 * 1024 || !hash(entry.sha256) || index.has(entry.file)) invalid(); index.set(entry.file, entry); bytes += entry.bytes; }
  if (bytes > 256 * 1024 * 1024) invalid();
  const ids = new Set(), contexts = new Set();
  for (const check of report.checks) {
    if (!object(check) || !text(check.id, 240) || ids.has(check.id) || !text(check.title, 1000) || !text(check.route, 4096) || !GATES.includes(check.status) || !['match', 'bug', 'baseline_failed', 'environment', 'needs_review'].includes(check.verdict) || check.status === 'passed' && check.verdict !== 'match' || check.verdict === 'bug' && check.status !== 'failed' || !object(check.evidence)) invalid();
    if (check.identity) {
      const identity = check.identity;
      if (identity.version !== 1 || identity.kind !== 'browser' || !['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey'].every(key => hash(identity[key]))
        || contexts.has(identity.contextKey) || !object(identity.viewport) || !integer(identity.viewport.width) || !identity.viewport.width
        || !integer(identity.viewport.height) || !identity.viewport.height) invalid();
      contexts.add(identity.contextKey);
    } else if (check.status !== 'blocked' || check.verdict !== 'environment') invalid();
    if ((!report.environmentComparison.comparable || check.evaluationLimited === true) && ['passed', 'failed'].includes(check.status)) invalid();
    ids.add(check.id); for (const file of Object.values(check.evidence)) if (file !== null && (typeof file !== 'string' || !index.has(file))) invalid();
  }
  if (!same(report.summary, measuredSummary(report))) invalid();
  const expectedGate = report.summary.bugs || report.summary.failed ? 'failed'
    : report.summary.blocked || report.summary.missing || report.coverage.capped ? 'blocked'
      : report.summary.needsReview || report.summary.baselineFailed ? 'needs_review' : 'passed';
  if (report.gate !== expectedGate) invalid();
  if (!Array.isArray(report.sourceEvidence) || !report.sourceEvidence.length) invalid();
  const sourceFiles = new Set();
  for (const entry of report.sourceEvidence) {
    fields(entry, ['sourceFile', 'file', 'bytes', 'sha256']);
    if (!fileName(entry.sourceFile) || entry.file !== `source-${entry.sourceFile}`
      || sourceFiles.has(entry.file) || !same(index.get(entry.file), { file: entry.file, bytes: entry.bytes, sha256: entry.sha256 })) invalid();
    sourceFiles.add(entry.file);
  }
  for (const check of report.checks) for (const role of ['baselineScreenshot', 'baselineDetails', 'baselineRepeat']) {
    if (check.evidence[role] && !sourceFiles.has(check.evidence[role])) invalid();
  }
  if ([...index.keys()].filter(file => file.startsWith('source-')).some(file => !sourceFiles.has(file))) invalid();
  return value;
}
function observation(value, projectId) {
  const names = ['schemaVersion', 'kind', 'granularity', 'projectId', 'operationId', 'runId', 'reportSha256', 'dispatchSha256', 'candidateId', 'contentDigest', 'targetReleaseId', 'beforeOperationId', 'beforeObservationSha256', 'recordedAt', 'observations'];
  fields(value, [...names, 'replayed'], names);
  if (value.schemaVersion !== 1 || value.kind !== 'browser-check-observation' || value.granularity !== 'check' || value.projectId !== projectId || !validId(value.operationId, 'bo') || !validId(value.runId, 'br') || !validId(value.candidateId, 'bc') || !validId(value.targetReleaseId, 'ar') || !hash(value.reportSha256) || !hash(value.dispatchSha256) || !hash(value.contentDigest) || !iso(value.recordedAt) || value.beforeOperationId !== null && (!validId(value.beforeOperationId, 'bo') || value.beforeOperationId === value.operationId) || Object.hasOwn(value, 'replayed') && typeof value.replayed !== 'boolean' || !Array.isArray(value.observations) || value.observations.length > 240) invalid();
  if (value.beforeObservationSha256 !== null && (!hash(value.beforeObservationSha256) || !value.beforeOperationId)) invalid();
  const ids = new Set();
  for (const item of value.observations) {
    fields(item, ['bugId', 'bugKey', 'checkId', 'beforeCheckId', 'title', 'route', 'facet', 'viewport', 'identity', 'status', 'verdict', 'relation', 'evidenceReferences']);
    if (!hash(item.bugKey) || item.bugId !== 'bug-' + item.bugKey || ids.has(item.bugId) || !text(item.title, 240) || !text(item.route, 4096) || !['navigation', 'console', 'network', 'overflow', 'structure', 'visual', 'behavior'].includes(item.facet) || !['observed_failure', 'observed_passed', 'still_failed', 'new_failure', 'verified_passed', 'unchanged_passed', 'unverified', 'incomparable'].includes(item.relation) || ![...GATES, 'missing'].includes(item.status) || !['match', 'bug', 'baseline_failed', 'environment', 'needs_review', 'unverified'].includes(item.verdict) || !object(item.viewport) || !integer(item.viewport.width) || !item.viewport.width || !integer(item.viewport.height) || !item.viewport.height || !object(item.identity) || item.identity.version !== 1 || item.identity.kind !== 'browser' || item.identity.facet !== item.facet || !same(item.identity.viewport, item.viewport) || !['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey'].every(key => hash(item.identity[key])) || !object(item.evidenceReferences) || Object.values(item.evidenceReferences).some(file => file !== null && !fileName(file)) || ![item.checkId, item.beforeCheckId].every(id => id === null || text(id, 240))) invalid();
    if (['observed_failure', 'still_failed', 'new_failure'].includes(item.relation) && (item.status !== 'failed' || item.verdict !== 'bug')
      || ['verified_passed', 'observed_passed', 'unchanged_passed'].includes(item.relation) && (item.status !== 'passed' || item.verdict !== 'match')
      || item.relation === 'verified_passed' && (!value.beforeOperationId || !item.checkId || !item.beforeCheckId && !hash(value.beforeObservationSha256))) invalid();
    ids.add(item.bugId);
  }
  return value;
}
export function browserExecutionLedger(value, projectId) {
  json(value); fields(value, ['schemaVersion', 'kind', 'granularity', 'projectId', 'scope', 'closesBugs', 'entries', 'issues']);
  if (value.schemaVersion !== 1 || value.kind !== 'browser-check-ledger' || value.granularity !== 'check' || value.projectId !== projectId || value.scope !== 'explicit-operation-observations' || value.closesBugs !== false || !Array.isArray(value.entries) || value.entries.length > 1024 || !Array.isArray(value.issues) || value.issues.length > 8192) invalid();
  const ids = new Set();
  for (const entry of value.entries) { observation(entry, projectId); if (ids.has(entry.operationId)) invalid(); ids.add(entry.operationId); }
  const issueIds = new Set(), rebuilt = new Map();
  for (const entry of value.entries) for (const observed of entry.observations) {
    const issue = rebuilt.get(observed.bugId) ?? { bugId: observed.bugId, bugKey: observed.bugKey, projectId,
      candidateId: entry.candidateId, contentDigest: entry.contentDigest, title: observed.title, route: observed.route,
      facet: observed.facet, viewport: JSON.parse(JSON.stringify(observed.viewport)), identity: JSON.parse(JSON.stringify(observed.identity)),
      status: 'unverified', lastVerifiedState: 'open', closesBusinessIssue: false, history: [] };
    if (issue.contentDigest !== entry.contentDigest || ['caseKey', 'contextKey', 'ruleKey', 'oracleKey'].some(key => issue.identity[key] !== observed.identity[key])) invalid();
    let relation = observed.relation;
    if (relation === 'verified_passed') issue.status = issue.lastVerifiedState = 'verified_passed';
    else if (observed.status === 'failed' && observed.verdict === 'bug' && relation !== 'incomparable') {
      if (issue.lastVerifiedState === 'verified_passed') relation = 'reopened';
      issue.status = issue.lastVerifiedState = relation === 'reopened' || issue.lastVerifiedState === 'reopened' ? 'reopened' : 'open';
    } else issue.status = 'unverified';
    issue.latestOperationId = entry.operationId; issue.latestTargetReleaseId = entry.targetReleaseId;
    issue.history.push({ operationId: entry.operationId, beforeOperationId: entry.beforeOperationId, reportSha256: entry.reportSha256,
      relation, status: observed.status, verdict: observed.verdict, recordedAt: entry.recordedAt });
    rebuilt.set(observed.bugId, issue);
  }
  for (const issue of value.issues) {
    fields(issue, ['bugId', 'bugKey', 'projectId', 'candidateId', 'contentDigest', 'title', 'route', 'facet', 'viewport', 'identity', 'status', 'lastVerifiedState', 'latestOperationId', 'latestTargetReleaseId', 'closesBusinessIssue', 'history']);
    if (issue.bugId !== 'bug-' + issue.bugKey || !hash(issue.bugKey) || issueIds.has(issue.bugId) || issue.projectId !== projectId || !validId(issue.candidateId, 'bc') || !hash(issue.contentDigest) || !text(issue.title, 240) || !text(issue.route, 4096) || !['open', 'reopened', 'verified_passed', 'unverified'].includes(issue.status) || ![null, 'open', 'reopened', 'verified_passed'].includes(issue.lastVerifiedState) || !validId(issue.latestOperationId, 'bo') || !validId(issue.latestTargetReleaseId, 'ar') || issue.closesBusinessIssue !== false || !Array.isArray(issue.history) || !issue.history.length || issue.history.length > 1024) invalid();
    for (const item of issue.history) {
      fields(item, ['operationId', 'beforeOperationId', 'reportSha256', 'relation', 'status', 'verdict', 'recordedAt']);
      if (!validId(item.operationId, 'bo') || !ids.has(item.operationId) || item.beforeOperationId !== null && !validId(item.beforeOperationId, 'bo') || !hash(item.reportSha256) || !iso(item.recordedAt) || !['observed_failure', 'observed_passed', 'still_failed', 'new_failure', 'verified_passed', 'unchanged_passed', 'unverified', 'incomparable', 'reopened'].includes(item.relation) || ![...GATES, 'missing'].includes(item.status) || !text(item.verdict, 80)) invalid();
    }
    if (!same(issue, rebuilt.get(issue.bugId))) invalid(); issueIds.add(issue.bugId);
  }
  if (issueIds.size !== rebuilt.size) invalid();
  return value;
}
export function browserExecutionRegistration(value, projectId, operationId, report, beforeOperationId = null) {
  json(value); observation(value, projectId);
  if (value.operationId !== operationId || value.reportSha256 !== report.reportSha256 || value.dispatchSha256 !== report.report?.dispatchSha256 || value.runId !== report.runId || value.candidateId !== report.candidateId || value.contentDigest !== report.contentDigest || value.targetReleaseId !== report.targetReleaseId || value.beforeOperationId !== beforeOperationId) invalid(); return value;
}
export function createBrowserExecutionReadGuard() {
  let epoch = 0; const channels = new Map();
  const reset = () => { epoch++; for (const value of channels.values()) value.controller.abort(); channels.clear(); };
  return Object.freeze({ reset,
    begin(channel) { channels.get(channel)?.controller.abort(); const controller = new AbortController(), token = { epoch, controller }; channels.set(channel, token); return Object.freeze({ epoch, channel, signal: controller.signal, token }); },
    current(value) { return !!value && value.epoch === epoch && !value.signal.aborted && channels.get(value.channel) === value.token; },
  });
}
export async function requestBrowserExecution(path, { baseUrl = '', headers = {}, method = 'GET', body, signal, fetcher = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const route = new RegExp(`^/ap-${UUID}/(?:browser-executions(?:/bo-${UUID}(?:/(?:report|cancel|register-result|resolution|deny-start))?)?|browser-bugs|browser-baseline-candidates/bc-${UUID})$`);
  if (!route.test(path) || !['GET', 'POST'].includes(method) || path.endsWith('/resolution') && method !== 'GET'
    || path.endsWith('/deny-start') && method !== 'POST') invalid();
  const perform = async requestSignal => {
    let response, value;
    try { response = await fetcher(`${baseUrl}/api/acceptance/projects${path}`, { method, headers, cache: 'no-store', signal: requestSignal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch (cause) { if (method === 'GET' && cause?.name === 'AbortError') throw cause; throw Object.assign(new Error('无法确认 Browser 请求结果，请查询原操作。'), { outcomeUnknown: method === 'POST' }); }
    try { value = json(await response.json()); } catch (cause) { if (method === 'GET' && cause?.name === 'AbortError') throw cause; throw Object.assign(new Error('Browser 响应无法读取，请查询原操作。'), { outcomeUnknown: method === 'POST' }); }
    if (!response.ok) throw Object.assign(new Error(text(value?.error, 1000) ? value.error : 'Browser 请求失败，请查询原操作。'), { code: typeof value?.code === 'string' ? value.code : undefined, status: response.status, outcomeUnknown: method === 'POST' && (response.status >= 500 || value?.outcomeUnknown === true) });
    if (!(method === 'POST' ? [200, 202] : [200]).includes(response.status)) throw Object.assign(new Error('Browser 响应状态无法核对，请查询原操作。'), { code: 'INVALID_RESPONSE', outcomeUnknown: method === 'POST' }); return value;
  };
  if (method === 'GET') return perform(signal);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) invalid('Browser 请求期限无效。');
  // This lifetime belongs to the submitted mutation, independently of read epochs.
  // A deadline cannot establish whether the server committed, so the receipt remains.
  const controller = new AbortController(); let timer, rejectStopped;
  const stopped = new Promise((_resolve, reject) => { rejectStopped = reject; });
  const stop = (code, message) => {
    const problem = Object.assign(new Error(message), { code, outcomeUnknown: true });
    rejectStopped(problem); controller.abort(problem);
  };
  const onAbort = () => stop('BROWSER_REQUEST_ABORTED', 'Browser 请求已中断，结果未知；请只读查询原操作。');
  try {
    if (signal?.aborted) throw Object.assign(new Error('Browser 请求已中断，结果未知；请只读查询原操作。'), { code: 'BROWSER_REQUEST_ABORTED', outcomeUnknown: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('BROWSER_REQUEST_TIMEOUT', 'Browser 请求超时，结果未知；请只读查询原操作。'), timeoutMs);
    // Race the entire fetch/body lifetime, including a transport that ignores abort.
    return await Promise.race([perform(controller.signal), stopped]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
export async function fetchBrowserExecutionEvidence({ projectId, operationId, entry }, { baseUrl = '', headers = {}, signal, fetcher = globalThis.fetch, crypto = globalThis.crypto } = {}) {
  if (!validId(projectId, 'ap') || !validId(operationId, 'bo') || !entry || !fileName(entry.file) || !entry.file.endsWith('.png') || !hash(entry.sha256) || !integer(entry.bytes) || entry.bytes <= 0 || entry.bytes > 64 * 1024 * 1024) invalid();
  const response = await fetcher(`${baseUrl}/api/acceptance/projects/${projectId}/browser-executions/${operationId}/evidence/${entry.file}?expectedSha256=${entry.sha256}`, { headers, signal, cache: 'no-store' });
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'image/png' || response.headers.get('x-content-sha256') !== entry.sha256 || response.headers.get('content-length') !== String(entry.bytes)) invalid('图片响应身份无法核对，请重新读取完成报告。');
  const bytes = await response.arrayBuffer(), digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (bytes.byteLength !== entry.bytes || digest !== entry.sha256 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => new Uint8Array(bytes)[i] === value)) invalid('图片大小、格式或 SHA-256 不一致。'); return new Blob([bytes], { type: 'image/png' });
}
export function createBrowserExecutionReceipts({ projectId, origin, storage, locks = globalThis.navigator?.locks, collections = defaultReceiptCollections() }) {
  let normalized; try { normalized = new URL(origin); } catch { invalid('执行记录上下文无效。'); }
  if (!validId(projectId, 'ap') || !['http:', 'https:'].includes(normalized.protocol) || normalized.origin !== origin || !storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') invalid('执行记录上下文无效。');
  const key = `heimdall:browser-operations:v1:${origin}:${projectId}`;
  function parse(raw) {
    if (raw === null) return [];
    if (typeof raw !== 'string' || raw.length > 32768) invalid('本机操作记录无法读取；尚未提交新请求。');
    let values; try { values = JSON.parse(raw); } catch { invalid('本机操作记录损坏；请先核对原操作。'); }
    if (!Array.isArray(values) || values.length > 32) invalid('本机待核对操作过多或记录损坏。');
    const result = values.map(browserExecutionRequest); if (new Set(result.map(value => value.operationId)).size !== result.length) invalid('本机操作记录重复。'); return result;
  }
  // Synchronous display read: the localStorage mirror. Never used to decide a write.
  function read() { return parse(storage.getItem(key)); }
  const canWrite = typeof locks?.request === 'function';
  /**
   * One write = one decision against the authoritative copy.
   * With IndexedDB (every real browser), `decide` runs inside a readwrite
   * transaction on the committed value, so a write from another tab can never be
   * overwritten by a stale collection; the result is then mirrored to
   * localStorage for synchronous readers. Without IndexedDB (Node tests), the
   * mirror itself is the store, as before. The Web Lock still serializes the
   * whole step so the mirror is written in the same order as the transactions.
   */
  const commit = decide => {
    if (!canWrite) invalid('当前浏览器不支持安全保存或解除启动确认所需的 Web Locks；仅可只读查询。');
    return locks.request(key, { mode: 'exclusive' }, async () => {
      if (!collections) {
        const planned = decide(read());
        if (planned.write !== undefined) {
          storage.setItem(key, JSON.stringify(planned.write));
          if (!same(read(), planned.write)) invalid(planned.failure);
        }
        return planned.result;
      }
      let mirrored;
      const result = await collections.update(key, raw => {
        // The legacy mirror may hold receipts written before this store moved to IndexedDB;
        // adopt them once so an upgrade never drops an unresolved original confirmation.
        const planned = decide(raw === null ? read() : parse(raw));
        if (planned.write === undefined) { mirrored = raw === null ? undefined : raw; return { result: planned.result }; }
        mirrored = JSON.stringify(planned.write);
        return { write: mirrored, result: planned.result };
      });
      if (mirrored !== undefined) {
        storage.setItem(key, mirrored);
        if (storage.getItem(key) !== mirrored) invalid('本机操作记录未能完整保存；尚未提交请求。');
      }
      return result;
    });
  };
  return Object.freeze({ canWrite, read,
    async claimForStart(request) {
      const value = browserExecutionRequest(request);
      return commit(values => values.length ? { result: false }
        : { write: [value], result: true, failure: '本机操作记录未能完整保存；尚未提交请求。' });
    },
    async save(request) {
      const value = browserExecutionRequest(request);
      await commit(values => {
        const old = values.find(item => item.operationId === value.operationId);
        if (old && !same(old, value)) invalid('操作 ID 已用于其他确认。');
        const next = old ? values : [...values, value];
        if (next.length > 32) invalid('请先核对原操作，再开始新的验收。');
        return { write: next, failure: '本机操作记录未能完整保存；尚未提交请求。' };
      });
    },
    async resolveExact(request) {
      const expected = browserExecutionRequest(request);
      await commit(values => {
        const old = values.find(value => value.operationId === expected.operationId);
        if (old && !same(old, expected)) invalid('本机原确认已变化，不能解除另一条确认。');
        if (!old) return {};
        return { write: values.filter(value => value.operationId !== expected.operationId), failure: '本机操作记录尚未完整核对；不能报告已解除。' };
      });
    },
  });
}
