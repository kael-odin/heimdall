/** A single native HTTP request, held between two writes of the original body. */
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export const browserResolutionSha = bytes => createHash('sha256').update(bytes).digest('hex');
export const browserResolutionDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function browserResolutionWait(fn, label, budget = 25000) {
  const until = Date.now() + budget; let last;
  while (Date.now() < until) {
    try { const result = await fn(); if (result) return result; } catch (cause) { last = cause; }
    await browserResolutionDelay(50);
  }
  throw new Error(label + ': ' + (last?.message ?? 'state not reached'), { cause: last });
}

export function openSlowBrowserPost({ url, body, headers = {}, operationId, traceId = 'resolution-smoke-' + randomUUID() }) {
  const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body);
  if (bytes.length < 2) throw Error('A split body requires at least two bytes.');
  const splitAt = Math.max(1, Math.floor(bytes.length / 2)), events = [];
  let finishCalled = false, prefixResolve, prefixReject, responseResolve, responseReject;
  const prefixWritten = new Promise((resolve, reject) => { prefixResolve = resolve; prefixReject = reject; });
  const response = new Promise((resolve, reject) => { responseResolve = resolve; responseReject = reject; });
  // Keep teardown from producing unhandled rejections; callers still await the originals.
  prefixWritten.catch(() => {}); response.catch(() => {});
  const req = request(url, { method: 'POST', headers: { ...headers, 'content-length': bytes.length,
    'x-heimdall-smoke-trace': traceId, 'x-heimdall-smoke-operation-id': operationId } });
  req.once('socket', socket => {
    socket.once('connect', () => events.push({ event: 'connected', localPort: socket.localPort, remotePort: socket.remotePort }));
  });
  req.once('error', cause => { prefixReject(cause); responseReject(cause); });
  req.once('response', res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.once('error', responseReject);
    res.once('end', () => {
      const reply = Buffer.concat(chunks); let payload;
      try { payload = JSON.parse(reply.toString('utf8')); } catch { payload = null; }
      events.push({ event: 'response', status: res.statusCode, bytes: reply.length });
      responseResolve({ status: res.statusCode, payload, bytes: reply });
    });
  });
  req.flushHeaders();
  req.write(bytes.subarray(0, splitAt), cause => {
    if (cause) return prefixReject(cause);
    events.push({ event: 'prefix-written', bytes: splitAt, endCalled: false });
    prefixResolve();
  });
  return { request: req, response, prefixWritten, traceId, splitAt, bytes: bytes.length,
    bodySha256: browserResolutionSha(bytes), events,
    finish() {
      if (finishCalled) throw Error('The original body can be completed only once.');
      finishCalled = true; events.push({ event: 'tail-released', bytes: bytes.length - splitAt });
      req.end(bytes.subarray(splitAt));
    },
    abort() { req.destroy(); },
  };
}
