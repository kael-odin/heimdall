/** Spec-only review records. No worker launch, client digest construction or POST replay. */
import { AcceptanceCatalogError, catalogPreconditions, catalogVersion } from './acceptance-catalog.js';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-${UUID}$`).test(value);
const invalid = message => { throw new AcceptanceCatalogError(message, { code: 'INVALID_INPUT' }); };
const invalidResponse = message => { throw new AcceptanceCatalogError(message, { code: 'INVALID_RESPONSE' }); };
const sameVersion = (a, b) => a.generationId === b.generationId && a.revision === b.revision;

function reasonOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1000) invalid('请填写 1 到 1000 字的理由。');
  return value.trim();
}
function confirmed(draft) {
  if (draft?.confirmed !== true) invalid('请核对本次具体合同与操作对象，再明确确认。');
}
function candidateOf(value, projectId) {
  if (!object(value) || !id(value.id, 'ab') || value.projectId !== projectId || value.mode !== 'spec'
    || value.projectionVersion !== 1 || !HASH.test(value.contentDigest) || !object(value.source)
    || !id(value.source.runId, 'ac') || !id(value.source.releaseId, 'ar')
    || value.source.sourceMode !== 'spec' || value.source.side !== 'source') invalidResponse('候选身份响应无效，请刷新目录后核对。');
  return value;
}
function assertionValid(value) {
  if (!object(value) || typeof value.pointer !== 'string' || !['required', 'equals', 'type', 'enum'].includes(value.kind)) return false;
  if (value.kind === 'equals') return Object.hasOwn(value, 'value');
  if (value.kind === 'type') return ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type);
  if (value.kind === 'enum') return Array.isArray(value.values) && value.values.length > 0;
  return true;
}
function checkValid(value) {
  const expect = value?.expect;
  return object(value) && typeof value.id === 'string' && !!value.id && typeof value.title === 'string'
    && ['GET', 'HEAD'].includes(value.method) && typeof value.path === 'string' && value.path.startsWith('/')
    && ['critical', 'high', 'medium', 'low'].includes(value.severity) && object(expect)
    && Number.isInteger(expect.status) && expect.status >= 100 && expect.status <= 599
    && (!Object.hasOwn(expect, 'contentType') || typeof expect.contentType === 'string' && !!expect.contentType)
    && (!Object.hasOwn(expect, 'json') || Array.isArray(expect.json) && expect.json.every(assertionValid))
    && (!Object.hasOwn(expect, 'schema') || typeof expect.schema === 'boolean' || object(expect.schema))
    && (value.method !== 'HEAD' || !Object.hasOwn(expect, 'schema') && !expect.json?.length)
    && object(value.rule) && object(value.identity);
}

/** Use bound source metadata, including failed/draft runs absent from the recent-run list. */
export function baselineSpecBindings(bindings = []) {
  return Array.isArray(bindings) ? bindings.filter(binding => binding.source?.mode === 'spec') : [];
}

/** A readable stored candidate is retained even when its current source cannot be projected. */
export function baselinePreviewState(value, { projectId, candidateId, version } = {}) {
  const incoming = catalogVersion(value), expected = catalogVersion(version);
  if (!sameVersion(incoming, expected)) {
    throw new AcceptanceCatalogError('合同预览与目录版本不同，请刷新完整目录，再重新核对合同。', {
      code: 'STALE_REVISION', status: 409, currentGenerationId: incoming.generationId, currentRevision: incoming.revision,
    });
  }
  const candidate = candidateOf(value.candidate, projectId), diagnostics = value.diagnostics;
  if (candidate.id !== candidateId || value.executionReady !== false || !object(diagnostics)
    || typeof diagnostics.eligible !== 'boolean' || typeof diagnostics.contentMatches !== 'boolean'
    || !Array.isArray(diagnostics.issues) || diagnostics.issues.some(issue => !object(issue)
      || typeof issue.code !== 'string' || typeof issue.message !== 'string')) invalidResponse('合同预览诊断响应无效。');
  const preview = value.preview;
  if (preview === null) {
    if (diagnostics.eligible || diagnostics.contentMatches) invalidResponse('来源预览缺失，不能批准或选用。');
    return { candidate, preview: null, diagnostics, canDecide: false };
  }
  if (!object(preview) || preview.projectionVersion !== 1 || preview.projectId !== projectId || preview.mode !== 'spec'
    || preview.releaseId !== candidate.source.releaseId || preview.executionReady !== false
    || !object(preview.sourceReference) || preview.sourceReference.runId !== candidate.source.runId
    || preview.sourceReference.releaseId !== candidate.source.releaseId || preview.sourceReference.sourceMode !== 'spec'
    || preview.sourceReference.side !== 'source' || !object(preview.source)
    || typeof preview.source.id !== 'string' || !preview.source.id || typeof preview.source.revision !== 'string'
    || !preview.source.revision || !['manual', 'openapi'].includes(preview.source.type)
    || preview.source.type === 'openapi' && !HASH.test(preview.source.sha256)
    || preview.sourceStatus !== 'completed' || typeof preview.sourceSpecApproved !== 'boolean'
    || !['passed', 'failed', 'blocked', 'needs_review'].includes(preview.sourceGate)
    || typeof preview.targetUrl !== 'string' || !preview.targetUrl || typeof preview.name !== 'string'
    || !Array.isArray(preview.omissions) || preview.omissions.length || !Array.isArray(preview.checks)
    || !preview.checks.length || preview.declaredSlots !== preview.checks.length || preview.projectedSlots !== preview.checks.length
    || new Set(preview.checks.map(check => check.id)).size !== preview.checks.length || !preview.checks.every(checkValid)) {
    invalidResponse('完整合同预览缺失或数量不一致，不能批准或选用。');
  }
  return { candidate, preview, diagnostics, canDecide: diagnostics.eligible && diagnostics.contentMatches };
}

export function buildBaselineCandidateInput(draft, version) {
  if (!id(draft?.sourceRunId, 'ac')) invalid('请选择已归属本项目的 Spec 运行。');
  return { ...catalogPreconditions(version), mode: 'spec', sourceRunId: draft.sourceRunId, sourceSide: 'source' };
}
export function buildBaselineApprovalInput(draft, version, value, projectId) {
  confirmed(draft);
  const state = baselinePreviewState(value, { projectId, candidateId: value?.candidate?.id, version });
  if (!state.canDecide) invalid('来源当前无法重验或内容已经变化，请重新核对候选。');
  return { ...catalogPreconditions(version), candidateId: state.candidate.id,
    contentDigest: state.candidate.contentDigest, reason: reasonOf(draft.reason) };
}
export function buildBaselineSelectionInput(draft, version, value, approval, projectId) {
  confirmed(draft);
  const state = baselinePreviewState(value, { projectId, candidateId: value?.candidate?.id, version });
  if (!state.canDecide) invalid('来源当前无法重验或内容已经变化，不能选用该批准。');
  if (!id(approval?.id, 'aa') || approval.projectId !== projectId || approval.candidateId !== state.candidate.id
    || approval.contentDigest !== state.candidate.contentDigest) invalid('请选择属于当前候选的合同批准。');
  return { ...catalogPreconditions(version), mode: 'spec', approvalId: approval.id,
    contentDigest: state.candidate.contentDigest, reason: reasonOf(draft.reason) };
}
export function buildBaselineCancellationInput(draft, version, current) {
  confirmed(draft);
  if (!id(current?.id, 'as') || current.mode !== 'spec' || !id(current.approvalId, 'aa')) invalid('当前没有可取消的 Spec 选用。');
  return { ...catalogPreconditions(version), mode: 'spec', approvalId: null, contentDigest: null, reason: reasonOf(draft.reason) };
}

/** Validate the captured request relation before treating a 201 as a confirmed write. */
export function validateBaselineWrite(kind, value, { projectId, body }) {
  const key = { candidate: 'candidate', approval: 'approval', selection: 'selection', cancellation: 'selection' }[kind];
  const entity = value?.[key];
  try {
    catalogVersion(value);
    if (value.generationId !== body.expectedGenerationId || value.revision !== body.expectedRevision + 1
      || !key || value.executionReady !== false || !object(value.event) || value.event.revision !== value.revision
      || value.event.projectId !== projectId || entity?.projectId !== projectId || value.event.entityId !== entity?.id) invalidResponse('写入响应缺少有效实体或事件。');
    if (kind === 'candidate') {
      candidateOf(entity, projectId);
      if (entity.source.runId !== body.sourceRunId || value.event.kind !== 'candidate-created') invalidResponse('候选写入响应关联不符。');
    } else if (kind === 'approval') {
      if (!id(entity.id, 'aa') || entity.candidateId !== body.candidateId || entity.contentDigest !== body.contentDigest
        || entity.reason !== body.reason || value.event.kind !== 'baseline-approved') invalidResponse('批准写入响应关联不符。');
    } else if (!id(entity.id, 'as') || entity.mode !== 'spec' || entity.approvalId !== body.approvalId
      || entity.reason !== body.reason || value.event.kind !== 'baseline-selected') invalidResponse('选用写入响应关联不符。');
    return entity;
  } catch (error) { error.writeMayHaveCommitted = true; throw error; }
}

/** Sequence plus all identity fields rejects project A→B→A and candidate/lineage ABA. */
export function createBaselinePreviewGuard() {
  let sequence = 0, stopped = false;
  const keys = ['projectId', 'generationId', 'revision', 'candidateId', 'selectionEpoch'];
  return {
    next(context) { return { sequence: ++sequence, context: { ...context } }; },
    accepts(ticket, context) { return !stopped && ticket.sequence === sequence && keys.every(key => ticket.context[key] === context[key]); },
    invalidate() { sequence++; },
    stop() { stopped = true; sequence++; },
  };
}
