/** Display-only Browser organization helpers. No approval, execution or POST replay. */
import { AcceptanceCatalogError, catalogPreconditions, catalogVersion } from './acceptance-catalog.js';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const HASH = /^[a-f0-9]{64}$/;
const DIGESTS = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest', 'selectedEvidenceManifestDigest',
  'scopeKey', 'ruleManifestKey', 'oracleManifestKey', 'environmentKey', 'verifierFingerprint'];
const ENVIRONMENT = ['platform', 'arch', 'nodeVersion', 'browser', 'browserVersion', 'playwrightVersion',
  'locale', 'timezoneId', 'colorScheme', 'reducedMotion'];
const SUMMARY = ['id', 'projectId', 'releaseId', 'projectionVersion', 'source', 'sourceContentDigest', 'boundAt', 'actor'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-${UUID}$`).test(value);
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const invalid = message => { throw new AcceptanceCatalogError(message, { code: 'INVALID_INPUT' }); };
const bad = (message = 'Browser 来源响应无效，请刷新目录后核对。') => {
  throw new AcceptanceCatalogError(message, { code: 'INVALID_RESPONSE' });
};
function fields(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) bad();
}
const equalVersion = (a, b) => a.generationId === b.generationId && a.revision === b.revision;
function sameVersion(value, version) {
  const incoming = catalogVersion(value), expected = catalogVersion(version);
  if (!equalVersion(incoming, expected)) throw new AcceptanceCatalogError('来源预览与目录版本不同，请刷新目录后重新核对。', {
    code: 'STALE_REVISION', status: 409, currentGenerationId: incoming.generationId, currentRevision: incoming.revision,
  });
}

/** Text only; this value must never become an href or an identity comparison. */
export function browserUrlDisplay(value, { relative = false } = {}) {
  try {
    if (!text(value) || !value || /[\u0000-\u0020\u007f\\]/.test(value)) return '无法显示';
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
    if (!relative && !absolute) return '无法显示';
    const url = new URL(value, 'https://browser-display.invalid/');
    if (!['http:', 'https:'].includes(url.protocol)) return '无法显示';
    return `${absolute ? url.origin : ''}${url.pathname}${value.split('#', 1)[0].includes('?') ? '?[redacted]' : ''}`;
  } catch { return '无法显示'; }
}
function displayValid(value, queryPresent, { relative = false, nullable = true } = {}) {
  if (value === null) return nullable && queryPresent === false;
  return typeof queryPresent === 'boolean' && text(value) && !!value
    && browserUrlDisplay(value, { relative }) === value
    && value.endsWith('?[redacted]') === queryPresent;
}
function isoDate(value) {
  if (!text(value, 24)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function sourceValid(source) {
  fields(source, ['runId', 'sourceMode', 'side', 'entryUrlDisplay', 'queryPresent']);
  return id(source.runId, 'ac') && ['mirror', 'regression'].includes(source.sourceMode)
    && ['baseline', 'target'].includes(source.side) && displayValid(source.entryUrlDisplay, source.queryPresent);
}
export function validateBrowserBindingSummary(binding, projectId, { detail = false } = {}) {
  fields(binding, [...SUMMARY, ...DIGESTS], detail ? [...SUMMARY, ...DIGESTS] : SUMMARY);
  fields(binding.actor, ['kind']);
  if (!id(binding.id, 'ax') || binding.projectId !== projectId || !id(binding.projectId, 'ap')
    || !id(binding.releaseId, 'ar') || binding.projectionVersion !== 1 || !sourceValid(binding.source)
    || !HASH.test(binding.sourceContentDigest) || binding.actor.kind !== 'local-operator'
    || !isoDate(binding.boundAt)
    || DIGESTS.some(key => Object.hasOwn(binding, key) && !HASH.test(binding[key]))) bad();
  return binding;
}
export function browserBindingHistory(detail, projectId) {
  if (detail?.project?.id !== projectId || !Array.isArray(detail.browserSourceBindings)
    || detail.browserSourceVerification?.scope !== 'stored-record-only'
    || detail.browserSourceVerification?.currentSourceVerified !== false) bad('当前引擎未提供 Browser 来源归属记录，请更新并刷新目录。');
  const rows = detail.browserSourceBindings.map(value => validateBrowserBindingSummary(value, projectId));
  if (new Set(rows.map(value => value.id)).size !== rows.length) bad();
  return rows;
}
export function browserBindingRuns(runs = []) {
  return Array.isArray(runs) ? runs.filter(run => id(run?.runId, 'ac') && run.status === 'completed'
    && ['mirror', 'regression'].includes(run.mode) && run.provenance?.kind !== 'managed-spec') : [];
}
export function buildBrowserBindingInput(draft, version) {
  if (!id(draft?.runId, 'ac')) invalid('请选择已完成的 Browser 运行，或填写完整运行 ID。');
  if (!['baseline', 'target'].includes(draft.sourceSide)) invalid('请明确选择 baseline 或 target 来源侧。');
  if (!id(draft.releaseId, 'ar')) invalid('请选择归入的项目版本。');
  if (draft.confirmed !== true) invalid('请核对本次运行、来源侧和项目版本，再确认归属。');
  return { ...catalogPreconditions(version), runId: draft.runId, sourceSide: draft.sourceSide, releaseId: draft.releaseId };
}

export function browserEvidenceMetadata(value, role, side) {
  fields(value, ['file', 'bytes', 'sha256']);
  const extension = role === 'details' ? 'json' : 'png';
  const suffix = `-${side}${role === 'repeat' ? '-repeat' : ''}.${extension}`;
  if (!['details', 'screenshot', 'repeat'].includes(role) || !['baseline', 'target'].includes(side)
    || !text(value.file, 240) || !/^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(value.file)
    || value.file.includes('..') || !value.file.endsWith(suffix) || !integer(value.bytes)
    || value.bytes === 0 || value.bytes > 64 * 1024 * 1024 || !HASH.test(value.sha256)) bad('来源证据索引无效，请重新核对来源。');
  return value;
}
function structureValid(structure) {
  fields(structure, ['title', 'headings', 'controls']);
  if (!text(structure.title, 300) || !Array.isArray(structure.headings) || structure.headings.length > 20
    || !structure.headings.every(value => text(value, 300)) || !Array.isArray(structure.controls) || structure.controls.length > 80) bad();
  for (const control of structure.controls) {
    fields(control, ['path', 'tag', 'role', 'label', 'type', 'disabled', 'expanded', 'selected', 'hrefDisplay', 'hrefQueryPresent']);
    if (!['path', 'tag', 'label'].every(key => text(control[key], 4096)) || typeof control.disabled !== 'boolean'
      || !['role', 'type', 'expanded', 'selected'].every(key => control[key] === null || text(control[key], 300))
      || !displayValid(control.hrefDisplay, control.hrefQueryPresent, { relative: true, nullable: true })) bad();
  }
}
function observationValid(observation, binding) {
  fields(observation, ['slot', 'viewportName', 'title', 'severity', 'plannedUrlDisplay', 'plannedQueryPresent',
    'observedFinalUrlDisplay', 'observedFinalQueryPresent', 'finalUrlProof', 'evidence', 'expected', 'capture', 'mask', 'stability'],
  ['slot', 'viewportName', 'plannedUrlDisplay', 'plannedQueryPresent', 'observedFinalUrlDisplay', 'observedFinalQueryPresent',
    'finalUrlProof', 'evidence', 'expected', 'capture', 'mask', 'stability']);
  fields(observation.slot, ['routeDisplay', 'queryPresent', 'viewport', 'pointId'], ['routeDisplay', 'queryPresent', 'viewport']);
  fields(observation.slot.viewport, ['width', 'height']);
  if (!displayValid(observation.slot.routeDisplay, observation.slot.queryPresent, { relative: true })
    || observation.slot.routeDisplay !== null && (!observation.slot.routeDisplay.startsWith('/') || observation.slot.routeDisplay.startsWith('//'))
    || !['width', 'height'].every(key => integer(observation.slot.viewport[key]) && observation.slot.viewport[key] > 0)
    || Object.hasOwn(observation.slot, 'pointId') && !text(observation.slot.pointId, 120)
    || !text(observation.viewportName, 120) || !displayValid(observation.plannedUrlDisplay, observation.plannedQueryPresent)
    || !displayValid(observation.observedFinalUrlDisplay, observation.observedFinalQueryPresent)
    || observation.finalUrlProof !== 'redacted-observation-only' || !finite(observation.stability)
    || observation.stability < 0 || observation.stability > 1) bad();
  fields(observation.evidence, ['details', 'screenshot', 'repeat']);
  for (const role of ['details', 'screenshot', 'repeat']) browserEvidenceMetadata(observation.evidence[role], role, binding.source.side);
  fields(observation.expected, ['httpStatus', 'screenshotSha256', 'structure', 'assertionSummary'], ['httpStatus', 'screenshotSha256', 'structure']);
  if (!Number.isInteger(observation.expected.httpStatus) || observation.expected.httpStatus < 200
    || observation.expected.httpStatus >= 400 || observation.expected.screenshotSha256 !== observation.evidence.screenshot.sha256) bad();
  structureValid(observation.expected.structure);
  if (observation.expected.assertionSummary) {
    const summary = observation.expected.assertionSummary;
    fields(summary, ['total', 'passed', 'checks']);
    if (!integer(summary.total) || !integer(summary.passed) || summary.total !== summary.passed
      || !Array.isArray(summary.checks) || summary.checks.length !== summary.total || summary.total > 20) bad();
    for (const item of summary.checks) { fields(item, ['kind', 'passed']); if (!text(item.kind, 120) || item.passed !== true) bad(); }
  }
  fields(observation.capture, ['captureScope', 'captureLimited', 'documentSize']);
  fields(observation.capture.documentSize, ['width', 'height']);
  fields(observation.mask, ['maskedRatio', 'effectiveAreaPx', 'samplingCapped']);
  if (observation.capture.captureScope !== 'full-page' || observation.capture.captureLimited !== false
    || !['width', 'height'].every(key => integer(observation.capture.documentSize[key]) && observation.capture.documentSize[key] > 0)
    || !finite(observation.mask.maskedRatio) || observation.mask.maskedRatio < 0 || observation.mask.maskedRatio > 1
    || !integer(observation.mask.effectiveAreaPx) || typeof observation.mask.samplingCapped !== 'boolean') bad();
}
export function browserBindingPreviewState(value, { projectId, bindingId, version } = {}) {
  fields(value, ['viewVersion', 'generationId', 'revision', 'binding', 'preview', 'diagnostics', 'executionReady', 'event'],
    ['viewVersion', 'generationId', 'revision', 'binding', 'preview', 'diagnostics', 'executionReady']);
  sameVersion(value, version);
  const binding = validateBrowserBindingSummary(value.binding, projectId, { detail: true });
  fields(value.diagnostics, ['eligible', 'contentMatches', 'issues']);
  if (value.viewVersion !== 1 || binding.id !== bindingId || value.executionReady !== false
    || typeof value.diagnostics.eligible !== 'boolean' || typeof value.diagnostics.contentMatches !== 'boolean'
    || !Array.isArray(value.diagnostics.issues)) bad();
  for (const issue of value.diagnostics.issues) { fields(issue, ['code', 'message']); if (!text(issue.code, 80) || !text(issue.message, 1000)) bad(); }
  if (value.preview === null) {
    if (value.diagnostics.eligible || value.diagnostics.contentMatches) bad();
    return { binding, preview: null, diagnostics: value.diagnostics };
  }
  const preview = value.preview;
  fields(preview, ['projectionVersion', 'mode', 'sourceReference', 'name', 'sourceStatus', 'sourceGate', 'declaredSlots', 'projectedSlots',
    'observations', 'executionReady', 'oracleStorage', 'environment', 'verifierFingerprint', 'urlProof', 'presentation', 'reviewNotice']);
  if (preview.projectionVersion !== 1 || preview.mode !== 'browser' || !sourceValid(preview.sourceReference)
    || !['runId', 'sourceMode', 'side', 'entryUrlDisplay', 'queryPresent'].every(key => preview.sourceReference[key] === binding.source[key])
    || !text(preview.name, 4096)
    || preview.sourceStatus !== 'completed' || !['passed', 'failed', 'blocked', 'needs_review'].includes(preview.sourceGate)
    || !integer(preview.declaredSlots) || !preview.declaredSlots || preview.declaredSlots !== preview.projectedSlots
    || !Array.isArray(preview.observations) || !preview.observations.length || preview.observations.length > 600
    || preview.executionReady !== false || preview.oracleStorage !== 'captured-side-evidence'
    || !HASH.test(preview.verifierFingerprint) || !text(preview.reviewNotice, 4096)) bad();
  fields(preview.environment, ENVIRONMENT);
  if (!ENVIRONMENT.every(key => text(preview.environment[key], 300))) bad();
  fields(preview.urlProof, ['planned', 'observedFinal']);
  if (preview.urlProof.planned !== 'server-verified-exact-entry; display-query-hidden'
    || preview.urlProof.observedFinal !== 'redacted-observation-only; no complete redirect-chain or final-query proof') bad();
  fields(preview.presentation, ['kind', 'completeSourceProjection', 'omitted']);
  if (preview.presentation.kind !== 'organization-review' || preview.presentation.completeSourceProjection !== false
    || JSON.stringify(preview.presentation.omitted) !== JSON.stringify(['raw-query', 'step-values', 'assertion-literals', 'rules'])
    || !value.diagnostics.eligible || !value.diagnostics.contentMatches || value.diagnostics.issues.length) bad();
  for (const observation of preview.observations) observationValid(observation, binding);
  return { binding, preview, diagnostics: value.diagnostics };
}
export function validateBrowserBindingWrite(value, { projectId, body }) {
  try {
    catalogVersion(value);
    if (value.generationId !== body.expectedGenerationId || value.revision !== body.expectedRevision + 1) bad();
    const binding = value.binding;
    const state = browserBindingPreviewState(value, { projectId, bindingId: binding?.id, version: value });
    fields(value.event, ['id', 'revision', 'projectId', 'entityId', 'entityDigest', 'at', 'kind', 'actor']);
    fields(value.event.actor, ['kind']);
    if (!state.preview || binding.releaseId !== body.releaseId || binding.source.runId !== body.runId || binding.source.side !== body.sourceSide
      || !id(value.event.id, 'ae') || value.event.kind !== 'browser-source-bound' || value.event.entityId !== binding.id
      || value.event.projectId !== projectId || value.event.revision !== value.revision || !HASH.test(value.event.entityDigest)
      || value.event.at !== binding.boundAt || value.event.actor.kind !== 'local-operator') bad();
    return value;
  } catch (error) { error.writeMayHaveCommitted = true; throw error; }
}
export function createBrowserBindingReadGuard() {
  let sequence = 0, stopped = false;
  const keys = ['projectId', 'bindingId', 'generationId', 'revision', 'selectionEpoch'];
  return {
    next(context) { return { ...context, sequence: ++sequence }; },
    accepts(ticket, context) { return !stopped && ticket.sequence === sequence && keys.every(key => ticket[key] === context[key]); },
    invalidate() { sequence++; }, stop() { stopped = true; sequence++; },
  };
}
export function browserEvidencePath(binding, metadata, role) {
  if (!id(binding?.source?.runId, 'ac')) bad();
  browserEvidenceMetadata(metadata, role, binding.source.side);
  return `/api/acceptance/runs/${encodeURIComponent(binding.source.runId)}/evidence/${encodeURIComponent(metadata.file)}`;
}
export async function fetchBrowserBindingEvidence({ binding, metadata, role, baseUrl = '', headers = {}, signal,
  fetcher = fetch, subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle?.digest) throw new AcceptanceCatalogError('当前环境无法校验证据，请使用支持安全摘要的浏览器环境。', { code: 'EVIDENCE_VERIFICATION_UNAVAILABLE' });
  const path = browserEvidencePath(binding, metadata, role), type = role === 'details' ? 'application/json' : 'image/png';
  const response = await fetcher(`${baseUrl}${path}`, { headers, signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok || (response.headers.get('content-type') ?? '').split(';')[0].trim() !== type) {
    throw new AcceptanceCatalogError('证据尚不可读取或文件类型不符，请重新核对来源。', { code: 'EVIDENCE_UNAVAILABLE' });
  }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        size += result.value.byteLength;
        if (size > metadata.bytes) {
          await reader.cancel();
          throw new AcceptanceCatalogError('证据大小与记录不符，已停止展示。', { code: 'EVIDENCE_CHANGED' });
        }
        chunks.push(result.value);
      }
      bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } finally { reader.releaseLock(); }
  } else bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== metadata.bytes) throw new AcceptanceCatalogError('证据大小与记录不符，已停止展示。', { code: 'EVIDENCE_CHANGED' });
  const digest = [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== metadata.sha256) throw new AcceptanceCatalogError('证据摘要与记录不符，已停止展示。', { code: 'EVIDENCE_CHANGED' });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return { blob: new Blob([bytes], { type }), content: role === 'details' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '' };
}
