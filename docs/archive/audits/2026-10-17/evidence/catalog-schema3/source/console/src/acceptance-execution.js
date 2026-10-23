/** Explicit managed execution admission. Saved receipts can only be queried;
 * only a fresh, persisted in-memory attempt has a single-use POST closure. */
import { baselinePreviewState } from './acceptance-baseline.js';
import { catalogTargetUrl, catalogVersion } from './acceptance-catalog.js';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const PREFIX = 'heimdall-acceptance-execution-v1:';
const REQUEST_KEYS = ['operationId', 'expectedGenerationId', 'expectedRevision', 'selectionId', 'contentDigest', 'targetReleaseId'];
const CONFIRMATION_KEYS = ['projectId', 'generationId', 'revision', 'selectionId', 'approvalId', 'candidateId',
  'contentDigest', 'sourceRunId', 'sourceReleaseId', 'targetReleaseId', 'targetUrl', 'buildRef', 'epoch'];
const RECONCILE = new Set(['STALE_REVISION', 'STALE_GENERATION', 'CATALOG_GENERATION_CHANGED', 'BASELINE_CHANGED']);
const REJECTED_409 = new Set(['ACCEPTANCE_BUSY', ...RECONCILE, 'PROJECT_MISMATCH', 'SOURCE_NOT_ELIGIBLE',
  'SOURCE_INTEGRITY_FAILED', 'CATALOG_QUEUE_FULL', 'CATALOG_CAPACITY']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-${UUID}$`).test(value);
const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const scalarCode = value => typeof value === 'string' && CODE.test(value) ? value : null;
const sameRequest = (a, b) => REQUEST_KEYS.every(key => a[key] === b[key]);

export class AcceptanceExecutionError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'AcceptanceExecutionError';
    Object.assign(this, { status: null, code: 'EXECUTION_ERROR', outcomeUnknown: false, reconcileRequired: false,
      currentGenerationId: null, currentRevision: null, resolutionSaved: false, authoritativeRejectionPersisted: false }, fields);
  }
}
const fail = (message, code = 'INVALID_INPUT', fields = {}) => {
  throw new AcceptanceExecutionError(message, { code, ...fields });
};
const invalidResponse = message => fail(message, 'INVALID_RESPONSE');

/** Public error DTO deliberately excludes causes, paths, arbitrary response fields and credentials. */
export function executionFailure(error) {
  return { message: typeof error?.message === 'string' ? error.message.slice(0, 500) : '执行请求失败。',
    status: Number.isInteger(error?.status) ? error.status : null,
    code: scalarCode(error?.code) || 'EXECUTION_ERROR', outcomeUnknown: error?.outcomeUnknown === true,
    reconcileRequired: error?.reconcileRequired === true,
    currentGenerationId: id(error?.currentGenerationId, 'ag') ? error.currentGenerationId : null,
    currentRevision: Number.isSafeInteger(error?.currentRevision) && error.currentRevision >= 0 ? error.currentRevision : null,
    resolutionSaved: error?.resolutionSaved === true,
    authoritativeRejectionPersisted: error?.authoritativeRejectionPersisted === true };
}

function confirmationOf(value) {
  if (!object(value) || !id(value.projectId, 'ap') || !id(value.generationId, 'ag')
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !id(value.selectionId, 'as')
    || !id(value.approvalId, 'aa') || !id(value.candidateId, 'ab') || !HASH.test(value.contentDigest)
    || !id(value.sourceRunId, 'ac') || !id(value.sourceReleaseId, 'ar') || !id(value.targetReleaseId, 'ar')
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.buildRef !== 'string' || value.buildRef.length > 200) {
    fail('执行确认身份不完整，请重新预览当前选用与目标版本。');
  }
  if (catalogTargetUrl(value.targetUrl) !== value.targetUrl) fail('目标版本 URL 与确认不一致。');
  return Object.freeze(Object.fromEntries(CONFIRMATION_KEYS.map(key => [key, value[key]])));
}

/** The current selected chain is independent of the Baseline component's browsing draft. */
export function buildExecutionConfirmation({ projectId, detail, version, preview, targetReleaseId, epoch = 0 } = {}) {
  const currentVersion = catalogVersion(version), detailVersion = catalogVersion(detail);
  if (currentVersion.generationId !== detailVersion.generationId || currentVersion.revision !== detailVersion.revision) {
    fail('项目详情与目录版本不同，请刷新后重新预览。', 'STALE_REVISION', { status: 409, reconcileRequired: true });
  }
  if (!id(projectId, 'ap') || detail?.project?.id !== projectId || detail.executionReady !== false
    || !['candidates', 'approvals', 'releases'].every(key => Array.isArray(detail[key]))) fail('当前项目详情不完整。');
  const selection = detail.currentSelections?.spec;
  const approval = detail.approvals.find(value => value.id === selection?.approvalId);
  const candidate = detail.candidates.find(value => value.id === approval?.candidateId);
  if (!id(selection?.id, 'as') || selection.projectId !== projectId || selection.mode !== 'spec'
    || !id(approval?.id, 'aa') || approval.projectId !== projectId || !id(candidate?.id, 'ab')
    || candidate.projectId !== projectId || approval.contentDigest !== candidate.contentDigest) {
    fail('当前项目没有完整的 Spec 选用、批准和候选链。');
  }
  const state = baselinePreviewState(preview, { projectId, candidateId: candidate.id, version: currentVersion });
  if (!state.canDecide || state.candidate.contentDigest !== approval.contentDigest
    || state.candidate.source.runId !== candidate.source?.runId
    || state.candidate.source.releaseId !== candidate.source?.releaseId) fail('当前合同来源无法重验或已发生变化。', 'BASELINE_CHANGED', { reconcileRequired: true });
  const release = detail.releases.find(value => value.id === targetReleaseId);
  if (!id(release?.id, 'ar') || release.projectId !== projectId) fail('请明确选择当前项目的目标版本。');
  return confirmationOf({ projectId, ...currentVersion, selectionId: selection.id, approvalId: approval.id,
    candidateId: candidate.id, contentDigest: candidate.contentDigest, sourceRunId: state.candidate.source.runId,
    sourceReleaseId: state.candidate.source.releaseId, targetReleaseId: release.id,
    targetUrl: release.targetUrl, buildRef: release.buildRef ?? '', epoch });
}

function originOf(value) {
  let url;
  try { url = new URL(value); } catch { fail('执行服务地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('执行服务地址必须是 HTTP / HTTPS origin。');
  }
  return url.origin;
}
function receiptOf(value, expectedOrigin) {
  const request = value?.request;
  if (!object(value) || value.schemaVersion !== 1 || value.apiOrigin !== originOf(value.apiOrigin)
    || expectedOrigin && value.apiOrigin !== expectedOrigin || !iso(value.createdAt) || !id(value.projectId, 'ap')
    || !id(value.sourceRunId, 'ac') || !object(request) || Object.keys(request).length !== REQUEST_KEYS.length
    || !REQUEST_KEYS.every(key => Object.hasOwn(request, key)) || !id(request.operationId, 'ao')
    || !id(request.expectedGenerationId, 'ag') || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || !id(request.selectionId, 'as') || !HASH.test(request.contentDigest) || !id(request.targetReleaseId, 'ar')) {
    fail('本地操作记录损坏或不属于当前执行服务；原记录已保留。', 'RECEIPT_CORRUPT');
  }
  return Object.freeze({ schemaVersion: 1, apiOrigin: value.apiOrigin, createdAt: value.createdAt,
    projectId: value.projectId, sourceRunId: value.sourceRunId,
    request: Object.freeze(Object.fromEntries(REQUEST_KEYS.map(key => [key, request[key]]))) });
}
function receiptKey(receipt) {
  return `${PREFIX}${encodeURIComponent(receipt.apiOrigin)}:${receipt.request.expectedGenerationId}:${receipt.projectId}:${receipt.request.operationId}`;
}
function sameReceipt(a, b) {
  return a.apiOrigin === b.apiOrigin && a.createdAt === b.createdAt && a.projectId === b.projectId
    && a.sourceRunId === b.sourceRunId && sameRequest(a.request, b.request);
}
function knownRejection(error) {
  return error.outcomeUnknown !== true && (error.status === 401
    || [400, 413].includes(error.status) && error.code === 'INVALID_INPUT'
    || error.status === 404 && error.code === 'NOT_FOUND'
    || error.status === 409 && REJECTED_409.has(error.code));
}
function rejectionOf(value, receipt) {
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== 'rejected'
    || value.operationId !== receipt.request.operationId || !iso(value.resolvedAt)
    || !scalarCode(value.code) || !knownRejection({ code: value.code, status: value.status })) fail('本地拒绝记录无法核验；原记录已保留。', 'RECEIPT_CORRUPT');
  return Object.freeze({ kind: 'rejected', code: value.code, status: value.status, resolvedAt: value.resolvedAt });
}

/** Operation reads establish head state only. Full report/evidence verification belongs to the run reader. */
export function validateExecutionOperation(value, { receipt, post = false } = {}) {
  const original = receiptOf(receipt), validGate = ['passed', 'failed', 'blocked', 'needs_review'].includes(value?.gate);
  if (!object(value) || value.schemaVersion !== 1 || value.projectId !== original.projectId
    || value.operationId !== original.request.operationId || value.targetReleaseId !== original.request.targetReleaseId
    || value.sourceRunId !== original.sourceRunId || !id(value.runId, 'ac') || value.runId === original.sourceRunId
    || !id(value.taskId, 'a') || typeof value.runCreated !== 'boolean'
    || !['prepared', 'running', 'completed', 'failed', 'interrupted'].includes(value.state)
    || post && typeof value.replayed !== 'boolean') invalidResponse('执行响应与原操作身份不一致，请查询原操作。');
  const consistent = value.state === 'prepared' ? !value.runCreated && value.gate === null && value.reasonCode === null
    : value.runCreated && (value.state === 'completed' ? validGate && value.reasonCode === null
      : value.gate === 'blocked' && (value.state === 'running' ? value.reasonCode === null : !!scalarCode(value.reasonCode)));
  if (!consistent) invalidResponse('执行响应状态组合无效，请查询原操作。');
  return Object.freeze({ schemaVersion: 1, projectId: value.projectId, operationId: value.operationId,
    sourceRunId: value.sourceRunId, targetReleaseId: value.targetReleaseId, runId: value.runId, taskId: value.taskId,
    state: value.state, runCreated: value.runCreated, gate: value.gate, reasonCode: value.reasonCode,
    ...(post ? { replayed: value.replayed } : {}) });
}
function capabilityOf(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.enabled !== true
    || !['ready', 'busy', 'closing', 'blocked', 'recoveryReady'].every(key => typeof value[key] === 'boolean')
    || ![null, 'legacy', 'managed'].includes(value.kind) || value.code !== null && !scalarCode(value.code)
    || value.runId !== null && !id(value.runId, 'ac') || value.taskId !== null && !id(value.taskId, 'a')
    || (value.runId === null) !== (value.taskId === null) || !value.busy && (value.kind !== null || value.runId !== null)
    || value.busy && value.kind === null || value.ready !== (value.recoveryReady && !value.busy && !value.closing && !value.blocked)
    || !Array.isArray(value.methods) || value.methods.length !== 2 || value.methods[0] !== 'GET' || value.methods[1] !== 'HEAD'
    || value.triageSupported !== false) invalidResponse('执行能力响应无效，请检查引擎状态。');
  return Object.freeze(Object.fromEntries(['schemaVersion', 'enabled', 'ready', 'busy', 'closing', 'blocked', 'code', 'kind',
    'runId', 'taskId', 'recoveryReady', 'triageSupported'].map(key => [key, value[key]])));
}

/** Each independent capability/preview/operation reader owns its own guard. */
export function createExecutionReadGuard() {
  let sequence = 0, stopped = false;
  return Object.freeze({
    next(context = {}) { return { sequence: ++sequence, context: JSON.stringify(context) }; },
    accepts(ticket, context = {}) { return !stopped && ticket.sequence === sequence && ticket.context === JSON.stringify(context); },
    invalidate() { sequence++; },
    stop() { stopped = true; sequence++; },
  });
}

export function createAcceptanceExecutionClient({ baseUrl, headers = {}, fetcher = globalThis.fetch,
  storage = globalThis.localStorage, randomUUID = () => globalThis.crypto.randomUUID(), now = () => new Date().toISOString(),
  maxReceipts = 100 } = {}) {
  const origin = originOf(baseUrl);
  const operationPins = new Map();
  if (typeof fetcher !== 'function' || typeof randomUUID !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 1000) fail('执行客户端配置无效。');
  const storageCall = (method, ...args) => {
    try {
      if (!storage || typeof storage[method] !== 'function') throw new Error();
      return storage[method](...args);
    } catch { fail('无法可靠保存或读取本地操作记录；本次不会重新发送执行请求。', 'RECEIPT_STORAGE_FAILED'); }
  };
  function stored(receipt) {
    const key = receiptKey(receipt), raw = storageCall('getItem', key);
    let parsed;
    try { if (typeof raw !== 'string' || raw.length > 8192) throw new Error(); parsed = receiptOf(JSON.parse(raw), origin); }
    catch (error) { if (error instanceof AcceptanceExecutionError) throw error; fail('本地操作记录无法核验；原记录已保留。', 'RECEIPT_CORRUPT'); }
    if (!sameReceipt(parsed, receipt)) fail('本地操作记录身份已经变化；不会提交或导航到其他操作。', 'RECEIPT_CORRUPT');
    const resolutionRaw = storageCall('getItem', `${key}:rejected`);
    let resolution = null;
    if (resolutionRaw !== null) {
      try { if (typeof resolutionRaw !== 'string' || resolutionRaw.length > 2048) throw new Error(); resolution = rejectionOf(JSON.parse(resolutionRaw), parsed); }
      catch (error) { if (error instanceof AcceptanceExecutionError) throw error; fail('本地拒绝记录无法核验；原记录已保留。', 'RECEIPT_CORRUPT'); }
    }
    return Object.freeze({ ...parsed, resolution });
  }
  function listReceipts({ generationId, projectId } = {}) {
    if (!id(projectId, 'ap') || generationId !== undefined && !id(generationId, 'ag')) fail('操作记录查询身份无效。');
    let length;
    try { length = storage.length; } catch { fail('无法读取本地操作记录。', 'RECEIPT_STORAGE_FAILED'); }
    if (!Number.isSafeInteger(length) || length < 0 || length > 10000) fail('本地操作记录目录无法安全读取。', 'RECEIPT_STORAGE_FAILED');
    const prefix = `${PREFIX}${encodeURIComponent(origin)}:`, found = [];
    for (let index = 0; index < length; index++) {
      const key = storageCall('key', index);
      if (typeof key !== 'string' || !key.startsWith(prefix) || key.endsWith(':rejected')) continue;
      const parts = key.slice(prefix.length).split(':');
      if (parts.length !== 3 || !id(parts[0], 'ag') || !id(parts[1], 'ap') || !id(parts[2], 'ao')) fail('本地操作记录键损坏；原记录已保留。', 'RECEIPT_CORRUPT');
      if (parts[1] !== projectId || generationId !== undefined && parts[0] !== generationId) continue;
      const raw = storageCall('getItem', key);
      let receipt;
      try { if (typeof raw !== 'string' || raw.length > 8192) throw new Error(); receipt = receiptOf(JSON.parse(raw), origin); }
      catch (error) { if (error instanceof AcceptanceExecutionError) throw error; fail('本地操作记录无法核验；原记录已保留。', 'RECEIPT_CORRUPT'); }
      if (receiptKey(receipt) !== key) fail('本地操作记录键与身份不一致。', 'RECEIPT_CORRUPT');
      found.push(stored(receipt));
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function request(path, { method = 'GET', body, signal, validate } = {}) {
    const writing = method === 'POST';
    let response;
    try {
      response = await fetcher(`${origin}${path}`, { method, cache: 'no-store', redirect: 'error', credentials: 'omit',
        headers: typeof headers === 'function' ? headers() : headers, signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (cause) {
      if (!writing && cause?.name === 'AbortError') throw cause;
      throw new AcceptanceExecutionError('未能取得执行响应，请保留原操作 ID 并查询。', { code: 'NETWORK_ERROR', outcomeUnknown: writing });
    }
    let value;
    try {
      if (!(response.headers.get('content-type') ?? '').includes('json')) throw new Error();
      const text = await response.text();
      if (!text || text.length > 65536) throw new Error();
      value = JSON.parse(text);
      if (!object(value)) throw new Error();
    } catch {
      throw new AcceptanceExecutionError('引擎未返回有效的执行 JSON，请查询原操作。', { status: response.status,
        code: response.status === 401 ? 'UNAUTHORIZED' : 'INVALID_RESPONSE', outcomeUnknown: writing && response.status !== 401 });
    }
    if (!response.ok) {
      const code = scalarCode(value.code) || (response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR');
      const error = new AcceptanceExecutionError(typeof value.error === 'string' ? value.error.slice(0, 500) : `引擎返回 HTTP ${response.status}。`, {
        status: response.status, code, reconcileRequired: RECONCILE.has(code),
        currentGenerationId: id(value.currentGenerationId, 'ag') ? value.currentGenerationId : null,
        currentRevision: Number.isSafeInteger(value.currentRevision) && value.currentRevision >= 0 ? value.currentRevision : null,
        outcomeUnknown: value.outcomeUnknown === true || writing && response.status >= 500 });
      if (writing && !knownRejection(error)) error.outcomeUnknown = true;
      throw error;
    }
    try { return validate(value, response.status); }
    catch (cause) {
      const error = cause instanceof AcceptanceExecutionError ? cause : new AcceptanceExecutionError('执行响应无效，请查询原操作。', { code: 'INVALID_RESPONSE' });
      error.status = response.status; error.outcomeUnknown = writing; throw error;
    }
  }
  function operationValue(value, receipt, post) {
    const observed = validateExecutionOperation(value, { receipt, post });
    const key = `${receipt.projectId}:${receipt.request.operationId}`, prior = operationPins.get(key);
    if (prior && (prior.runId !== observed.runId || prior.taskId !== observed.taskId)) {
      invalidResponse('原操作返回了不同的运行或任务身份；已保留首次核验身份，请检查引擎。');
    }
    if (!prior) operationPins.set(key, { runId: observed.runId, taskId: observed.taskId });
    return observed;
  }
  function prepareStart(confirmation) {
    const captured = confirmationOf(confirmation), uuid = randomUUID();
    if (typeof uuid !== 'string' || !id(`ao-${uuid}`, 'ao')) fail('无法生成可靠的操作 ID。');
    const receipt = receiptOf({ schemaVersion: 1, apiOrigin: origin, createdAt: now(), projectId: captured.projectId,
      sourceRunId: captured.sourceRunId, request: { operationId: `ao-${uuid}`, expectedGenerationId: captured.generationId,
        expectedRevision: captured.revision, selectionId: captured.selectionId, contentDigest: captured.contentDigest,
        targetReleaseId: captured.targetReleaseId } }, origin);
    if (listReceipts({ projectId: captured.projectId }).length >= maxReceipts) fail('本地操作记录已达到容量上限；原记录均已保留。', 'RECEIPT_CAPACITY');
    const key = receiptKey(receipt);
    if (storageCall('getItem', key) !== null || storageCall('getItem', `${key}:rejected`) !== null) fail('操作 ID 已存在，原确认不会被覆盖。', 'RECEIPT_EXISTS');
    storageCall('setItem', key, JSON.stringify(receipt));
    const saved = stored(receipt);
    let submitted = false;
    return Object.freeze({ receipt: saved, async submit({ signal } = {}) {
      if (submitted) fail('本次确认已经提交过；只能查询原操作。', 'ALREADY_SUBMITTED');
      submitted = true;
      stored(receipt); // A storage mutation between confirmation and click cannot change the request.
      try {
        return await request(`/api/acceptance/projects/${receipt.projectId}/spec-executions`, { method: 'POST', body: receipt.request, signal,
          validate(value, status) {
            if (status === 200 ? value.replayed !== true : status !== 202 || value.replayed !== false || value.runCreated !== true) {
              invalidResponse('启动响应状态与接纳方式不一致。');
            }
            return operationValue(value, receipt, true);
          } });
      } catch (error) {
        if (knownRejection(error)) {
          try {
            const resolution = { schemaVersion: 1, kind: 'rejected', operationId: receipt.request.operationId,
              code: error.code, status: error.status, resolvedAt: now() };
            rejectionOf(resolution, receipt);
            const resolutionKey = `${key}:rejected`, serialized = JSON.stringify(resolution), previous = storageCall('getItem', resolutionKey);
            if (previous !== null && previous !== serialized) fail('本地拒绝记录发生冲突；原操作仍须核对。', 'RECEIPT_CORRUPT');
            storageCall('setItem', resolutionKey, serialized);
            const reread = stored(receipt);
            error.resolutionSaved = reread.resolution !== null;
            error.authoritativeRejectionPersisted = error.resolutionSaved;
          } catch {
            throw new AcceptanceExecutionError('本次拒绝结果未能可靠保存；请保留原操作 ID 并查询核对。', {
              code: 'RECEIPT_STORAGE_FAILED', outcomeUnknown: true });
          }
        }
        throw error;
      }
    } });
  }
  function readOperation(receipt, { signal } = {}) {
    const original = receiptOf(receipt, origin);
    stored(original);
    return request(`/api/acceptance/projects/${original.projectId}/spec-executions/${original.request.operationId}`, {
      signal, validate(value, status) { if (status !== 200) invalidResponse('操作查询响应状态无效。'); return operationValue(value, original, false); } });
  }
  function requestStop({ taskId, runId } = {}, { signal } = {}) {
    if (!id(taskId, 'a') || !id(runId, 'ac')) fail('停止请求缺少已核验的运行与任务身份。');
    return request(`/api/jobs/${taskId}/cancel`, { method: 'POST', signal, validate(value, status) {
      if (status !== 200 || value.id !== taskId || !['running', 'done', 'failed', 'cancelled', 'interrupted'].includes(value.status)
        || Object.hasOwn(value, 'cancelRequested') && typeof value.cancelRequested !== 'boolean') invalidResponse('停止响应身份无效，请继续核对原运行。');
      return Object.freeze({ taskId, runId, status: value.status, cancelRequested: value.cancelRequested === true });
    } });
  }
  return Object.freeze({ readCapability: ({ signal } = {}) => request('/api/acceptance/execution', { signal,
    validate(value, status) { if (status !== 200) invalidResponse('执行能力响应状态无效。'); return capabilityOf(value); } }),
    listReceipts, prepareStart, readOperation, requestStop });
}
