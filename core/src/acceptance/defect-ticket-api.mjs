/** Bounded manual defect-ticket HTTP projection. The engine authenticates and
 * verifies real ownership first; this router never executes or registers runs. */
import { types } from 'node:util';
import { DEFECT_TICKET_LIMITS, isDefectTicketId, isDefectTicketActionId,
  validateDefectTicketCreateRequest, validateDefectTicketCloseRequest, validateDefectTicketDenyRequest } from './defect-ticket-schema.mjs';

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const PROJECT = new RegExp(`^ap-${UUID}$`), CANDIDATE = new RegExp(`^bc-${UUID}$`), OPERATION = new RegExp(`^bo-${UUID}$`);
const FAILURES = Object.freeze({
  INVALID_INPUT: { status: 400, error: '人工缺陷单请求参数无效，请核对输入。' },
  NOT_FOUND: { status: 404, error: '所选人工缺陷单、来源或动作不存在。' },
  STALE_TICKET: { status: 409, error: '人工缺陷单已变化，请重新读取并预览。' },
  STALE_FACTS: { status: 409, error: '验收事实已变化，请重新预览。' },
  ACTION_CONFLICT: { status: 409, error: '此动作编号已有不同确认，请核对原动作。' },
  SOURCE_NOT_ELIGIBLE: { status: 409, error: '所选验收来源不符合此人工缺陷单的要求。' },
  CAPACITY: { status: 503, error: '人工缺陷单或取证预算已达到上限，请保留原件并检查。' },
  INTEGRITY_BLOCKED: { status: 503, error: '人工缺陷单或验收原件无法安全核验；原件已保留。' },
  ACCEPTANCE_OWNER_UNAVAILABLE: { status: 503, error: '无法安全确认验收目录所有权，请稍后重试。' },
  ACCEPTANCE_OWNER_LOST: { status: 503, error: '验收目录所有权已失效，请停止当前引擎后重试。' },
});
const invalid = (status = 400) => Object.assign(new Error('invalid defect-ticket request'), { code: 'INVALID_INPUT', status });

function data(value, key) {
  if (value === null || !['object', 'function'].includes(typeof value) || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** Only fixed public messages and own data descriptors may cross this boundary. */
export function defectTicketError(cause) {
  const supplied = data(cause, 'code');
  const code = typeof supplied === 'string' && Object.hasOwn(FAILURES, supplied) ? supplied : 'INTEGRITY_BLOCKED';
  const failure = FAILURES[code], status = code === 'INVALID_INPUT' && data(cause, 'status') === 413 ? 413 : failure.status;
  const payload = { code, error: failure.error, outcomeUnknown: data(cause, 'writeMayHaveCommitted') === true };
  return { status, payload };
}

function body(req, maximum = DEFECT_TICKET_LIMITS.requestBytes) {
  return new Promise((resolve, reject) => {
    req.once('aborted', () => reject(invalid()));
    req.once('error', () => reject(invalid()));
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
      req.resume(); reject(invalid()); return;
    }
    let size = 0, oversized = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maximum) { oversized = true; chunks.length = 0; }
      else if (!oversized) chunks.push(chunk);
    });
    req.once('end', () => {
      if (oversized) return reject(invalid(413));
      try {
        // Keep a BOM visible to JSON.parse; invalid UTF-8 is never replaced.
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
        resolve(value);
      } catch { reject(invalid()); }
    });
  });
}

function query(url, field, pattern) {
  const allowed = field ? ['token', field] : ['token'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key))
    || allowed.some(key => url.searchParams.getAll(key).length > 1)) throw invalid();
  if (field && !pattern.test(url.searchParams.get(field) ?? '')) throw invalid();
  return field ? url.searchParams.get(field) : undefined;
}

/** Literal routes precede ticket IDs. Unknown routes cannot reach the service. */
function route(segments) {
  const [, , , , projectId, , ticketId, suffix] = segments;
  if (!PROJECT.test(projectId)) throw invalid();
  if (segments.length === 6) return { kind: 'collection', methods: ['GET', 'POST'] };
  if (ticketId === 'sources') return segments.length === 7 ? { kind: 'sources', methods: ['GET'] } : null;
  if (ticketId === 'actions') {
    if (segments.length === 7) throw invalid();
    if (segments.length !== 8 && !(segments.length === 9 && segments[8] === 'deny')) return null;
    if (!isDefectTicketActionId(suffix)) throw invalid();
    return { kind: segments.length === 9 ? 'deny' : 'action', methods: segments.length === 9 ? ['POST'] : ['GET'], actionId: suffix };
  }
  const kind = segments.length === 7 ? 'read' : segments.length !== 8 ? null
    : suffix === 'close-preview' ? 'preview' : suffix === 'close' ? 'close'
      : suffix === 'export.md' ? 'md' : suffix === 'export.json' ? 'json' : null;
  if (!kind) return null;
  if (!isDefectTicketId(ticketId)) throw invalid();
  return { kind, ticketId, methods: kind === 'close' ? ['POST'] : ['GET'] };
}

/** The engine must perform authentication and owner checks before this call. */
export async function handleDefectTicketRequest(req, res, url, { service, json }) {
  const segments = url.pathname.split('/');
  if (segments.slice(0, 4).join('/') !== '/api/acceptance/projects' || segments[5] !== 'defect-tickets') return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, payload) => { if (!res.destroyed && !res.writableEnded) json(res, status, payload); return true; };
  try {
    const matched = route(segments), projectId = segments[4];
    if (!matched) return send(404, { code: 'NOT_FOUND', error: FAILURES.NOT_FOUND.error, outcomeUnknown: false });
    const { kind, ticketId, actionId, methods } = matched;
    const selector = kind === 'sources' ? query(url, 'candidateId', CANDIDATE)
      : kind === 'preview' ? query(url, 'afterOperationId', OPERATION) : query(url);
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      return send(405, { code: 'METHOD_NOT_ALLOWED', error: '此人工缺陷单接口不支持该请求方法。', outcomeUnknown: false });
    }
    if (kind === 'collection') {
      if (req.method === 'GET') return send(200, service.list(projectId));
      const result = await service.create(projectId, validateDefectTicketCreateRequest(await body(req)));
      return send(result.status, result.payload);
    }
    if (kind === 'sources') return send(200, service.sources(projectId, selector));
    if (kind === 'action') return send(200, service.action(projectId, actionId));
    if (kind === 'deny') {
      const request = validateDefectTicketDenyRequest(await body(req, DEFECT_TICKET_LIMITS.denyRequestBytes));
      if (request.original.projectId !== projectId || request.original.actionId !== actionId) throw invalid();
      const result = await service.deny(projectId, actionId, request.original);
      return send(result.status, result.payload);
    }
    if (kind === 'read') return send(200, service.read(projectId, ticketId));
    if (kind === 'preview') return send(200, service.previewClose(projectId, ticketId, selector));
    if (kind === 'close') {
      const result = await service.close(projectId, ticketId, validateDefectTicketCloseRequest(await body(req)));
      return send(result.status, result.payload);
    }
    const result = service.exportTicket(projectId, ticketId, kind), bytes = data(result, 'bytes');
    const filename = ticketId + '.' + kind, contentType = kind === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8';
    if (types.isProxy(bytes) || !Buffer.isBuffer(bytes) || bytes.length > DEFECT_TICKET_LIMITS.factsJsonBytes
      || data(result, 'filename') !== filename || data(result, 'contentType') !== contentType) throw new Error('invalid defect-ticket export');
    if (!res.destroyed && !res.writableEnded) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', bytes.length);
      res.end(bytes);
    }
    return true;
  } catch (cause) {
    const failure = defectTicketError(cause);
    return send(failure.status, failure.payload);
  }
}
