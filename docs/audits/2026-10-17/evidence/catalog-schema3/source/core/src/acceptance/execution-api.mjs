/** Dedicated bounded HTTP admission. The engine performs auth and recovery
 * fencing first; the service alone decides fresh execution versus query. */
import { acceptanceCatalogError } from './catalog-api.mjs';
import { types } from 'node:util';

const PROJECT = 'ap-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const OPERATION = 'ao-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const ROUTE = new RegExp(`^/api/acceptance/projects/(${PROJECT})/spec-executions(?:/(${OPERATION}))?$`);
const MESSAGES = Object.freeze({
  ACCEPTANCE_BUSY: '已有验收正在接纳或运行，请等待结束。',
  MANAGED_EXECUTION_UNAVAILABLE: '托管执行暂时不可用，现场已保留；请检查状态后重启。',
  MANAGED_EXECUTION_START_FAILED: '托管验收未能安全启动，现场已保留；请查询原操作。',
  IDEMPOTENCY_CONFLICT: '操作 ID 已用于其他确认，请查询原操作。',
  INVALID_INPUT: '执行请求参数无效，请核对确认字段。',
  MANAGED_DISPATCH_UNAVAILABLE: '派发记录无法核验，现场已保留。',
  MANAGED_RUN_INTEGRITY_FAILED: '运行状态无法核验，现场已保留。',
  MANAGED_RUN_NOT_WRITABLE: '无法安全创建托管运行，现场已保留。',
  MANAGED_RUN_CONFLICT: '预留运行已有记录，不能再次启动。',
});
const UNAVAILABLE = new Set(['EXECUTION_CLOSED', 'EXECUTION_BLOCKED', 'EXECUTION_LEASE_INVALID', 'EXECUTION_STOPPED',
  'EXECUTION_INVALID_INPUT', 'EXECUTION_HANDLER_FAILED', 'MANAGED_EXECUTION_INACTIVE']);
function data(value, key) {
  if (value === null || !['object', 'function'].includes(typeof value) || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function safeError(error) {
  const captured = {};
  for (const key of ['code', 'status', 'writeMayHaveCommitted', 'currentGenerationId', 'currentRevision']) captured[key] = data(error, key);
  const details = data(error, 'details');
  if (details !== undefined) {
    captured.details = {};
    for (const key of ['generationId', 'revision', 'reason', 'limit']) captured.details[key] = data(details, key);
  }
  return captured;
}
export function acceptanceExecutionError(error) {
  const captured = safeError(error);
  const code = captured.code === 'EXECUTION_BUSY' ? 'ACCEPTANCE_BUSY'
    : UNAVAILABLE.has(captured.code) ? 'MANAGED_EXECUTION_UNAVAILABLE' : captured.code;
  const mapped = typeof code === 'string' && Object.hasOwn(MESSAGES, code)
    ? { status: code === 'ACCEPTANCE_BUSY' || code === 'IDEMPOTENCY_CONFLICT' || code === 'MANAGED_RUN_CONFLICT' ? 409
      : code === 'MANAGED_EXECUTION_START_FAILED' && captured.status === 409 ? 409
        : code === 'INVALID_INPUT' ? captured.status === 413 ? 413 : 400 : 503, payload: { code, error: MESSAGES[code] } }
    : acceptanceCatalogError({ ...captured, code: typeof code === 'string' ? code : undefined });
  if (captured.writeMayHaveCommitted === true) mapped.payload.outcomeUnknown = true;
  return mapped;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let length = 0, oversized = false, ended = false;
    const chunks = [];
    const invalid = () => Object.assign(new Error('invalid execution body'), { code: 'INVALID_INPUT', status: 400 });
    req.on('data', chunk => {
      length += chunk.length;
      if (length > 16 * 1024) { oversized = true; chunks.length = 0; }
      else if (!oversized) chunks.push(chunk);
    });
    req.once('aborted', () => { if (!ended) reject(invalid()); });
    req.once('error', () => reject(invalid()));
    req.once('end', () => {
      ended = true;
      if (oversized) return reject(Object.assign(invalid(), { status: 413 }));
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
        resolve(parsed);
      } catch { reject(invalid()); }
    });
  });
}
export async function handleAcceptanceExecutionRequest(req, res, url, { service, json }) {
  const matched = ROUTE.exec(url.pathname), capability = url.pathname === '/api/acceptance/execution';
  if (!matched && !capability) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, payload) => { if (!res.destroyed && !res.writableEnded) json(res, status, payload); return true; };
  try {
    if ([...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length > 1) {
      throw Object.assign(new Error('invalid execution query'), { code: 'INVALID_INPUT' });
    }
    const method = capability || matched?.[2] ? 'GET' : 'POST';
    if (req.method !== method) { res.setHeader('Allow', method); return send(405, { code: 'METHOD_NOT_ALLOWED', error: '此执行接口不支持该请求方法。' }); }
    if (capability) return send(200, service.capability());
    if (matched[2]) return send(200, service.read(matched[1], matched[2]));
    const result = await service.execute(matched[1], await body(req));
    return send(result.status, result.payload);
  } catch (cause) {
    const failure = acceptanceExecutionError(cause);
    return send(failure.status, failure.payload);
  }
}
