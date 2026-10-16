/** Import-safe local API truth fixtures; no production API or account is involved. */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTANCE_API_HEALTHY_BODY = Object.freeze({ code: 0, data: { id: 7, name: 'Heimdall', active: true } });
export const ACCEPTANCE_API_RESPONSE_SCHEMA = Object.freeze({ type: 'object', required: ['code', 'data'], additionalProperties: false,
  properties: { code: { type: 'integer', const: 0 }, data: { type: 'object', required: ['id', 'name', 'active'], additionalProperties: false,
    properties: { id: { type: 'integer' }, name: { type: 'string' }, active: { type: 'boolean' } } } } });
export const ACCEPTANCE_API_CASES = Object.freeze([
  { id: 'healthy', path: '/healthy', method: 'GET', targetBug: false, expectedVerdict: 'match' },
  { id: 'wrong-code', path: '/wrong-code', method: 'GET', targetBug: true, expectedVerdict: 'bug' },
  { id: 'missing-field', path: '/missing-field', method: 'GET', targetBug: true, expectedVerdict: 'bug' },
  { id: 'wrong-type', path: '/wrong-type', method: 'GET', targetBug: true, expectedVerdict: 'bug' },
  { id: 'wrong-status', path: '/wrong-status', method: 'GET', targetBug: true, expectedVerdict: 'bug' },
  { id: 'non-json', path: '/non-json', method: 'GET', targetBug: true, expectedVerdict: 'bug' },
  { id: 'bad-json', path: '/bad-json', method: 'GET', targetBug: true, expectedVerdict: 'bug' },
  { id: 'redirect', path: '/redirect', method: 'GET', targetBug: true, expectedVerdict: 'bug' },
  { id: 'oversized', path: '/oversized', method: 'GET', targetBug: false, expectedVerdict: 'environment' },
  { id: 'slow', path: '/slow', method: 'GET', targetBug: false, expectedVerdict: 'environment' },
  { id: 'head', path: '/head', method: 'HEAD', targetBug: false, expectedVerdict: 'match' },
]);

export async function startAcceptanceApiFixture({ port = 0, slowMs = 1800, oversizedBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535');
  const timers = new Set();
  const requests = [], requestCounts = Object.create(null);
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    const path = new URL(request.url, 'http://fixture.local').pathname;
    requests.push({ method: request.method, path });
    requestCounts[path] = (requestCounts[path] ?? 0) + 1;
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return; }
    if (!ACCEPTANCE_API_CASES.some(item => item.path === path)) { response.writeHead(404); response.end(); return; }
    if (path === '/redirect') { response.writeHead(302, { location: '/healthy' }); response.end(); return; }
    if (path === '/non-json') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Unexpected HTML</h1>'); return; }
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (path === '/bad-json') { response.end('{"code":0,'); return; }
    if (path === '/oversized') { response.end(JSON.stringify({ payload: 'x'.repeat(oversizedBytes) })); return; }
    if (path === '/slow') {
      const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) response.end(JSON.stringify(ACCEPTANCE_API_HEALTHY_BODY)); }, slowMs);
      timers.add(timer);
      response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
      return;
    }
    const body = structuredClone(ACCEPTANCE_API_HEALTHY_BODY);
    if (path === '/wrong-status') response.statusCode = 503;
    if (path === '/wrong-code') body.code = 400;
    if (path === '/missing-field') delete body.data.name;
    if (path === '/wrong-type') body.data.id = '7';
    response.end(JSON.stringify(body));
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ready); });
  let closed = false;
  return { targetUrl: `http://127.0.0.1:${server.address().port}`, requests, requestCounts, close: () => new Promise((ready, reject) => {
    if (closed) { ready(); return; }
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    server.close(error => error ? reject(error) : ready());
    server.closeAllConnections();
  }) };
}

// Test discovery can execute fixture modules directly. Only an explicit numeric
// port starts a persistent server; imports and no-argument discovery remain inert.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawPort = process.argv[2];
  if (rawPort === undefined || ['--help', '-h'].includes(rawPort)) {
    console.log('Usage: node core/test/fixtures/acceptance-api.mjs <port> (for example: 9088; 0 selects a free loopback port)');
  } else if (process.argv.length !== 3 || !/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
    console.error('port must be an explicit integer from 0 to 65535');
    process.exitCode = 1;
  } else {
    const fixture = await startAcceptanceApiFixture({ port: Number(rawPort) });
    console.log(JSON.stringify({ targetUrl: fixture.targetUrl, cases: ACCEPTANCE_API_CASES.length }));
    const shutdown = async () => { await fixture.close(); process.exit(0); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
