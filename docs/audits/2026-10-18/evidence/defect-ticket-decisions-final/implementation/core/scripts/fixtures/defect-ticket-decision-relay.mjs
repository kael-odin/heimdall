/** Controlled same-origin relay. One UI original body maps to one held native upstream request. */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openSlowBrowserPost, browserResolutionSha } from './browser-resolution-stream.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); return { promise, resolve, reject }; };
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersOf(input) {
  const blocked = new Set([...hop, ...String(input.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)]);
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => !blocked.has(key.toLowerCase()) && value !== undefined));
}
async function rawBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; assert(bytes <= 65536, 'Smoke request body is bounded.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const payloadOf = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { return null; } };

export function createDefectTicketDecisionRelay({ engineBase, scopeFile, logFile }) {
  const upstreamBase = new URL(engineBase); assert.equal(upstreamBase.hostname, '127.0.0.1');
  assert.equal(upstreamBase.protocol, 'http:'); assert.equal(upstreamBase.pathname, '/');
  const cases = [], pendingRequests = new Set(); let armed;
  const record = value => { const event = { at: new Date().toISOString(), ...value }; appendFileSync(logFile, JSON.stringify(event) + '\n'); return event; };
  const destination = path => { assert(path.startsWith('/') && !path.startsWith('//')); const url = new URL(path, upstreamBase);
    assert.equal(url.origin, upstreamBase.origin, 'The relay has one fixed loopback upstream.'); return url; };
  function forward(req, res, { bytes, state, deny = false, frontRequestId } = {}) {
    const forwardedHeaders = headersOf(req.headers);
    if (bytes) forwardedHeaders['content-length'] = bytes.length;
    if (deny) {
      assert.equal(state.denyForwardCount, 0, 'The UI deny request is forwarded exactly once.'); state.denyForwardCount++;
      state.events.push(record({ event: 'deny-forward', caseId: state.caseId, frontRequestId, actionId: state.actionId,
        bytes: bytes.length, bodySha256: browserResolutionSha(bytes) }));
    }
    // Avoid Node's shared keepalive pool: engine work can outlive an idle socket,
    // and no ordinary UI request may be replayed after a stale-pool reset.
    const upstream = request(destination(req.url), { method: req.method, headers: forwardedHeaders, agent: false });
    pendingRequests.add(upstream);
    const failed = cause => {
      pendingRequests.delete(upstream); record({ event: 'proxy-error', frontRequestId, method: req.method, path: req.url,
        reusedSocket: upstream.reusedSocket, message: cause.message });
      if (deny) state.denyReply.reject(cause);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); if (!res.writableEnded) res.end('D6 relay upstream failure');
    };
    upstream.once('error', failed);
    upstream.once('response', reply => {
      const chunks = []; if (!res.headersSent) res.writeHead(reply.statusCode, headersOf(reply.headers));
      reply.on('data', chunk => { if (deny) chunks.push(Buffer.from(chunk)); if (!res.destroyed) res.write(chunk); });
      reply.once('error', failed);
      reply.once('end', () => {
        pendingRequests.delete(upstream); if (!res.writableEnded) res.end();
        if (deny) {
          const body = Buffer.concat(chunks), result = { status: reply.statusCode, payload: payloadOf(body), bytes: body };
          state.events.push(record({ event: 'deny-response', caseId: state.caseId, frontRequestId, actionId: state.actionId,
            status: result.status, bytes: body.length, bodySha256: browserResolutionSha(body) })); state.denyReply.resolve(result);
        }
      });
    });
    if (bytes) upstream.end(bytes); else { req.once('aborted', () => upstream.destroy()); req.pipe(upstream); }
    return upstream;
  }
  const server = createServer((req, res) => {
    const frontRequestId = 'front-' + randomUUID();
    record({ event: 'front-request', frontRequestId, method: req.method, path: req.url });
    (async () => {
      const state = armed;
      if (state && req.method === 'POST' && req.url === state.path) {
        assert.equal(state.originalFrontCount, 0, 'An armed original cannot be silently resent.'); state.originalFrontCount++;
        state.originalRequest = req; state.originalResponse = res; state.originalFrontRequestId = frontRequestId;
        const bytes = await rawBody(req), body = payloadOf(bytes);
        assert(body && /^da-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.actionId));
        state.actionId = body.actionId; state.rawOriginal = bytes;
        state.traceId = 'd6-original-' + randomUUID();
        writeFileSync(scopeFile, JSON.stringify({ path: state.path, actionId: state.actionId, traceId: state.traceId }) + '\n');
        state.events.push(record({ event: 'original-body', caseId: state.caseId, frontRequestId, actionId: state.actionId,
          bytes: bytes.length, bodySha256: browserResolutionSha(bytes), traceId: state.traceId, host: req.headers.host,
          origin: req.headers.origin ?? null, contentType: req.headers['content-type'] }));
        state.originalForwardCount++;
        state.slow = openSlowBrowserPost({ url: destination(state.path), body: bytes,
          operationId: state.actionId, traceId: state.traceId,
          headers: { ...headersOf(req.headers), 'x-heimdall-smoke-action-id': state.actionId } });
        state.slow.response.then(reply => state.events.push(record({ event: 'original-upstream-response', caseId: state.caseId,
          actionId: state.actionId, status: reply.status, bytes: reply.bytes.length, bodySha256: browserResolutionSha(reply.bytes) })),
        cause => record({ event: 'original-upstream-error', caseId: state.caseId, message: cause.message }));
        await state.slow.prefixWritten; state.originalReady.resolve(state); return;
      }
      if (state?.actionId && req.method === 'POST' && req.url === state.path.replace(/\/dt-[a-f0-9-]{36}\/close$/, '') + '/actions/' + state.actionId + '/deny') {
        assert.equal(state.denyFrontCount, 0, 'An armed deny cannot be silently resent.'); state.denyFrontCount++;
        state.denyRequest = req; state.denyResponse = res; state.denyFrontRequestId = frontRequestId;
        state.rawDeny = await rawBody(req);
        state.events.push(record({ event: 'deny-body', caseId: state.caseId, frontRequestId, actionId: state.actionId,
          bytes: state.rawDeny.length, bodySha256: browserResolutionSha(state.rawDeny) }));
        state.denyReady.resolve(state);
        if (state.intendedWinner === 'rejected') state.forwardDeny(); return;
      }
      forward(req, res, { frontRequestId });
    })().catch(cause => {
      record({ event: 'fixture-error', frontRequestId, message: cause.message });
      armed?.originalReady.reject(cause); armed?.denyReady.reject(cause); armed?.denyReply.reject(cause);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); if (!res.writableEnded) res.end('D6 fixture assertion failed');
    });
  });
  function arm({ caseId, path, intendedWinner }) {
    assert(!armed || armed.completed, 'Complete the previous case before arming the next.');
    assert(['rejected', 'recorded'].includes(intendedWinner)); assert(path.startsWith('/api/acceptance/projects/'));
    const state = { caseId, path, intendedWinner, originalFrontCount: 0, originalForwardCount: 0, denyFrontCount: 0,
      denyForwardCount: 0, events: [], originalReady: deferred(), denyReady: deferred(), denyReply: deferred(), completed: false,
      sendControlled502() {
        assert(state.slow && !state.originalResponse.headersSent, 'The original browser response is replaced once after a real prefix.');
        const reply = Buffer.from(JSON.stringify({ code: 'D6_CONTROLLED_HTTP_502',
          error: 'Controlled relay response; original action remains unknown.', outcomeUnknown: true }));
        state.controlledRawReply = reply;
        state.controlledReply = record({ event: 'controlled-http-502', caseId, path, frontRequestId: state.originalFrontRequestId,
          status: 502, contentType: 'application/json; charset=utf-8', bytes: reply.length, bodySha256: browserResolutionSha(reply) });
        for (const event of ['finish', 'close']) state.originalResponse.once(event, () => state.events.push(record({ event: 'original-downstream-' + event,
          caseId, actionId: state.actionId, writableEnded: state.originalResponse.writableEnded, writableFinished: state.originalResponse.writableFinished })));
        // The unchanged product consumes this complete JSON HTTP error, treats
        // its unknown code as outcomeUnknown, and retains the exact confirmation.
        state.events.push(state.controlledReply); state.originalResponse.writeHead(502, { 'content-type': state.controlledReply.contentType,
          'content-length': reply.length, connection: 'close', 'cache-control': 'no-store' }); state.originalResponse.end(reply);
      },
      finishOriginal() {
        assert(state.slow); state.events.push(record({ event: 'original-tail-release', caseId, actionId: state.actionId })); state.slow.finish();
      },
      forwardDeny() {
        assert(state.rawDeny); return forward(state.denyRequest, state.denyResponse, { bytes: state.rawDeny, state, deny: true, frontRequestId: state.denyFrontRequestId });
      },
    };
    armed = state; cases.push(state); return state;
  }
  return { server, arm, cases,
    async drain(timeoutMs = 10000) {
      const until = Date.now() + timeoutMs;
      while (pendingRequests.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(pendingRequests.size, 0, 'Ordinary UI forwards must finish while the real engine remains available.');
    },
    abort() { for (const state of cases) state.slow?.abort(); for (const req of pendingRequests) req.destroy(); },
  };
}
