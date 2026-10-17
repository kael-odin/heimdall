/** Smoke-only passive observer. No data listener, read(), resume() or body change. */
import { Server } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const scopeFile = process.env.HEIMDALL_BROWSER_RESOLUTION_INGRESS_SCOPE;
const logFile = process.env.HEIMDALL_BROWSER_RESOLUTION_INGRESS_LOG;
if (!scopeFile || !logFile) throw Error('Explicit smoke ingress scope and log are required.');
const nativeEmit = Server.prototype.emit, connections = new WeakMap();
function scoped(req) {
  try {
    const bytes = readFileSync(scopeFile); if (bytes.length > 4096) return null;
    const scope = JSON.parse(bytes.toString('utf8'));
    if (req.method !== 'POST' || req.url !== scope.path || !/^bo-[a-f0-9-]{36}$/.test(scope.operationId)
      || req.headers['x-heimdall-smoke-operation-id'] !== scope.operationId
      || req.headers['x-heimdall-smoke-trace'] !== scope.traceId) return null;
    return scope;
  } catch { return null; }
}
Server.prototype.emit = function (event, ...args) {
  if (event === 'request') {
    const req = args[0], scope = scoped(req);
    if (scope) {
      let connectionId = connections.get(req.socket);
      if (!connectionId) { connectionId = 'connection-' + randomUUID(); connections.set(req.socket, connectionId); }
      const digest = createHash('sha256'); let bytes = 0, ended = false;
      const record = (kind, extra = {}) => appendFileSync(logFile, JSON.stringify({
        event: kind, connectionId, operationId: scope.operationId, traceId: scope.traceId,
        bytes, bodySha256: digest.copy().digest('hex'), ...extra,
      }) + '\n');
      record('request', { contentLength: Number(req.headers['content-length']) });
      const requestEmit = req.emit;
      // Observe only events the product stream itself emits. This does not make it flow.
      req.emit = function (kind, ...values) {
        if (kind === 'data') { bytes += values[0].length; digest.update(values[0]); record('data', { ended: false }); }
        if (kind === 'end') { ended = true; record('end', { ended: true }); }
        if (kind === 'close') record('close', { ended });
        return Reflect.apply(requestEmit, this, [kind, ...values]);
      };
    }
  }
  return Reflect.apply(nativeEmit, this, [event, ...args]);
};
