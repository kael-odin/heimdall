/** D6 smoke-only passive native HTTP observer. Never reads, resumes or changes a body. */
import { Server } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const scopeFile = process.env.HEIMDALL_DEFECT_TICKET_DECISION_INGRESS_SCOPE;
const logFile = process.env.HEIMDALL_DEFECT_TICKET_DECISION_INGRESS_LOG;
if (!scopeFile || !logFile) throw Error('Explicit D6 smoke ingress scope and log are required.');
const nativeEmit = Server.prototype.emit, connections = new WeakMap();
function scoped(req) {
  try {
    const bytes = readFileSync(scopeFile); if (bytes.length > 4096) return null;
    const scope = JSON.parse(bytes.toString('utf8'));
    if (req.method !== 'POST' || req.url !== scope.path || !/^da-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(scope.actionId)
      || typeof scope.traceId !== 'string' || !scope.traceId.startsWith('d6-original-')
      || req.headers['x-heimdall-smoke-action-id'] !== scope.actionId
      || req.headers['x-heimdall-smoke-operation-id'] !== scope.actionId
      || req.headers['x-heimdall-smoke-trace'] !== scope.traceId) return null;
    return scope;
  } catch { return null; }
}
Server.prototype.emit = function(event, ...args) {
  if (event === 'request') {
    const req = args[0], scope = scoped(req);
    if (scope) {
      let connectionId = connections.get(req.socket);
      if (!connectionId) { connectionId = 'connection-' + randomUUID(); connections.set(req.socket, connectionId); }
      const requestId = 'ingress-' + randomUUID(), digest = createHash('sha256'); let bytes = 0, ended = false;
      const record = (kind, extra = {}) => appendFileSync(logFile, JSON.stringify({ event: kind,
        at: new Date().toISOString(), requestId, connectionId, actionId: scope.actionId, traceId: scope.traceId,
        method: req.method, path: req.url, bytes, bodySha256: digest.copy().digest('hex'), ...extra }) + '\n');
      record('request', { contentLength: Number(req.headers['content-length']) });
      const requestEmit = req.emit;
      req.emit = function(kind, ...values) {
        if (kind === 'data') { bytes += values[0].length; digest.update(values[0]); record('data', { ended: false }); }
        if (kind === 'end') { ended = true; record('end', { ended: true }); }
        if (kind === 'aborted') record('aborted', { ended });
        if (kind === 'close') record('close', { ended });
        return Reflect.apply(requestEmit, this, [kind, ...values]);
      };
    }
  }
  return Reflect.apply(nativeEmit, this, [event, ...args]);
};
