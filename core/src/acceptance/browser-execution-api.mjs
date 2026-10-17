/** Authenticated, bounded Browser execution and explicit result registration. */
import { acceptanceCatalogError } from './catalog-api.mjs';
import { types } from 'node:util';

const PROJECT = /^ap-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OPERATION = /^bo-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MESSAGES = Object.freeze({
  BROWSER_EXECUTION_UNAVAILABLE: 'Browser 执行暂时不可用；请核对原操作与启动状态。',
  BROWSER_OPERATION_UNAVAILABLE: 'Browser 操作记录无法安全读写，原现场已保留。',
  BROWSER_OPERATION_INTEGRITY_FAILED: 'Browser 操作或证据无法核验，原现场已保留。',
  BROWSER_OPERATION_CONFLICT: '此操作编号已有不同记录，请核对原操作。',
  IDEMPOTENCY_CONFLICT: '此操作编号已用于其他确认，请核对原操作。',
  RESULT_NOT_COMPLETED: '仅可登记已完整核验的完成结果。',
  BUG_LEDGER_CONFLICT: '问题登记或复验关系冲突，原记录已保留。',
  ACCEPTANCE_BUSY: '已有验收占用执行槽，请等待结束。',
});
const invalid = (status = 400) => Object.assign(new Error('invalid Browser request'), { code: 'INVALID_INPUT', status });

function data(value, key) {
  if (value === null || !['object', 'function'].includes(typeof value) || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function safeError(cause) {
  const captured = {};
  for (const key of ['code', 'status', 'writeMayHaveCommitted', 'currentGenerationId', 'currentRevision']) captured[key] = data(cause, key);
  const details = data(cause, 'details');
  if (details !== undefined) {
    captured.details = {};
    for (const key of ['generationId', 'revision', 'reason', 'limit']) captured.details[key] = data(details, key);
  }
  if (typeof captured.code !== 'string') captured.code = undefined;
  return captured;
}
export function browserExecutionError(cause) {
  const captured = safeError(cause);
  const code = captured.code === 'EXECUTION_BUSY' ? 'ACCEPTANCE_BUSY'
    : /^EXECUTION_/.test(captured.code ?? '') ? 'BROWSER_EXECUTION_UNAVAILABLE' : captured.code;
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code);
  const mapped = known ? { status: ['ACCEPTANCE_BUSY', 'IDEMPOTENCY_CONFLICT', 'BROWSER_OPERATION_CONFLICT',
    'RESULT_NOT_COMPLETED', 'BUG_LEDGER_CONFLICT'].includes(code) ? 409 : 503,
    payload: { code, error: MESSAGES[code] } } : acceptanceCatalogError(captured);
  if (captured.writeMayHaveCommitted === true) mapped.payload.outcomeUnknown = true;
  return mapped;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0, oversized = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024) { oversized = true; chunks.length = 0; }
      else if (!oversized) chunks.push(chunk);
    });
    req.once('aborted', () => reject(invalid()));
    req.once('error', () => reject(invalid()));
    req.once('end', () => {
      if (oversized) return reject(invalid(413));
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
        resolve(value);
      } catch { reject(invalid()); }
    });
  });
}

/** The engine must authenticate and verify real ownership before this router. */
export async function handleBrowserExecutionRequest(req, res, url, { service, json }) {
  const segments = url.pathname.split('/');
  if (segments.slice(0, 4).join('/') !== '/api/acceptance/projects'
      || !['browser-executions', 'browser-bugs'].includes(segments[5])) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, payload) => { if (!res.destroyed && !res.writableEnded) json(res, status, payload); return true; };
  try {
    const [, , , , projectId, resource, operationId, action, file] = segments;
    if (!PROJECT.test(projectId) || operationId !== undefined && !OPERATION.test(operationId)) throw invalid();
    const evidence = resource === 'browser-executions' && operationId && action === 'evidence' && segments.length === 9;
    const valid = resource === 'browser-bugs' ? segments.length === 6
      : segments.length === 6 || segments.length === 7
        || segments.length === 8 && ['report', 'cancel', 'register-result'].includes(action) || evidence;
    if (!valid) return send(404, { code: 'NOT_FOUND', error: '此 Browser 接口不存在。' });
    const allowedQuery = evidence ? ['token', 'expectedSha256'] : ['token'];
    if ([...url.searchParams.keys()].some(key => !allowedQuery.includes(key))
      || allowedQuery.some(key => url.searchParams.getAll(key).length > 1)) throw invalid();
    if (evidence && (!/^[a-z0-9][a-z0-9_.-]{0,234}\.(png|json)$/i.test(file ?? '')
      || !HASH.test(url.searchParams.get('expectedSha256') ?? ''))) throw invalid();
    const methods = resource === 'browser-bugs' || operationId && !['cancel', 'register-result'].includes(action)
      ? ['GET'] : operationId ? ['POST'] : ['GET', 'POST'];
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      return send(405, { code: 'METHOD_NOT_ALLOWED', error: '此 Browser 接口不支持该方法。' });
    }
    if (resource === 'browser-bugs') return send(200, service.ledger(projectId));
    if (!operationId) {
      if (req.method === 'GET') return send(200, service.list(projectId));
      const result = await service.execute(projectId, await body(req));
      return send(result.status, result.payload);
    }
    if (evidence) {
      const result = service.evidence(projectId, operationId, file, url.searchParams.get('expectedSha256'));
      res.setHeader('Content-Type', /\.png$/i.test(file) ? 'image/png' : 'application/json; charset=utf-8');
      res.setHeader('Content-Length', result.bytes.length);
      res.setHeader('X-Content-SHA256', result.sha256);
      res.end(result.bytes); return true;
    }
    if (action === 'report') return send(200, service.report(projectId, operationId));
    if (action === 'cancel') return send(200, service.cancel(projectId, operationId, await body(req)));
    if (action === 'register-result') return send(200, service.registerResult(projectId, operationId, await body(req)));
    return send(200, service.read(projectId, operationId));
  } catch (cause) {
    const mapped = browserExecutionError(cause);
    return send(mapped.status, mapped.payload);
  }
}
