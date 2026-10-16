/** Catalog input, transport and stale-read guards. Writes are never replayed. */
export const CATALOG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);

export class AcceptanceCatalogError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'AcceptanceCatalogError';
    Object.assign(this, { status: null, code: 'CATALOG_ERROR', details: null,
      currentGenerationId: null, currentRevision: null, writeMayHaveCommitted: false }, fields);
  }
}

export function catalogVersion(value) {
  if (typeof value?.generationId !== 'string' || !value.generationId
    || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new AcceptanceCatalogError('目录版本响应无效，请刷新目录后再操作。', { code: 'INVALID_RESPONSE' });
  }
  return { generationId: value.generationId, revision: value.revision };
}

export function catalogPreconditions(value) {
  const { generationId, revision } = catalogVersion(value);
  return { expectedGenerationId: generationId, expectedRevision: revision };
}

function text(value, label, max) {
  const clean = String(value ?? '').trim();
  if (!clean || clean.length > max) throw new AcceptanceCatalogError(`${label}需要填写 1 到 ${max} 个字符。`, { code: 'INVALID_INPUT' });
  return clean;
}

export function catalogTargetUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new AcceptanceCatalogError('版本目标需要完整的 HTTP / HTTPS URL。', { code: 'INVALID_INPUT' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new AcceptanceCatalogError('版本目标仅支持不含账号、密码和片段的 HTTP / HTTPS URL。', { code: 'INVALID_INPUT' });
  }
  return url.href;
}

export function buildCatalogProjectInput(draft, version) {
  return { ...catalogPreconditions(version), name: text(draft.name, '项目名称', 120) };
}

export function buildCatalogReleaseInput(draft, version) {
  const buildRef = String(draft.buildRef ?? '').trim();
  if (buildRef.length > 200) throw new AcceptanceCatalogError('构建引用不能超过 200 个字符。', { code: 'INVALID_INPUT' });
  return { ...catalogPreconditions(version), label: text(draft.label, '版本名称', 120),
    targetUrl: catalogTargetUrl(draft.targetUrl), ...(buildRef ? { buildRef } : {}) };
}

export function buildCatalogBindingInput(draft, version) {
  if (draft.confirmed !== true) throw new AcceptanceCatalogError('请确认本次后续归属，以及原报告保持不变。', { code: 'INVALID_INPUT' });
  return { ...catalogPreconditions(version), runId: text(draft.runId, '历史运行', 100), releaseId: text(draft.releaseId, '版本', 100) };
}

export function catalogTerminalRuns(runs = []) {
  return runs.filter(run => CATALOG_TERMINAL_STATUSES.has(run.status) && run.provenance?.kind !== 'managed-spec');
}

/** Each reader owns a guard. A project switch invalidates earlier detail responses. */
export function createCatalogReadGuard() {
  let sequence = 0, stopped = false;
  return {
    next(projectId = '') { return { sequence: ++sequence, projectId }; },
    accepts(ticket, projectId = '') { return !stopped && ticket.sequence === sequence && ticket.projectId === projectId; },
    invalidate() { sequence++; },
    stop() { stopped = true; sequence++; },
  };
}

export function catalogFailure(error) {
  return { message: error?.message || '目录请求失败。', status: error?.status ?? null,
    code: error?.code || 'CATALOG_ERROR', details: error?.details ?? null,
    currentGenerationId: error?.currentGenerationId ?? null, currentRevision: error?.currentRevision ?? null,
    writeMayHaveCommitted: error?.writeMayHaveCommitted === true };
}

/** One invocation issues exactly one request. A lost POST response is never replayed. */
export async function requestAcceptanceCatalog(path = '', { method = 'GET', body, signal, fetcher = fetch, baseUrl = '', headers = {} } = {}) {
  const writing = method === 'POST';
  let response;
  try {
    response = await fetcher(`${baseUrl}/api/acceptance/projects${path}`, {
      method, headers, signal, cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error?.name === 'AbortError' && !writing) throw error;
    throw new AcceptanceCatalogError(error?.message || '无法连接目录服务。', { code: 'NETWORK_ERROR', writeMayHaveCommitted: writing });
  }
  let value;
  try { value = await response.json(); } catch {
    throw new AcceptanceCatalogError('引擎未返回有效的目录 JSON。', { status: response.status, code: 'INVALID_RESPONSE',
      writeMayHaveCommitted: writing && (response.ok || response.status >= 500) });
  }
  if (!response.ok) {
    const { code, error, message, currentGenerationId, currentRevision, ...details } = value ?? {};
    throw new AcceptanceCatalogError(error || message || `目录请求返回 HTTP ${response.status}。`, {
      status: response.status, code: code || 'CATALOG_ERROR', details: value?.details ?? details,
      currentGenerationId: currentGenerationId ?? null, currentRevision: currentRevision ?? null,
      writeMayHaveCommitted: writing && response.status >= 500,
    });
  }
  try { catalogVersion(value); } catch (error) {
    error.status = response.status;
    error.writeMayHaveCommitted = writing;
    throw error;
  }
  return value;
}
