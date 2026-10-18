import { createServer, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const out = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3 || !process.argv[2]) throw Error('One fresh output directory is required');
mkdirSync(out, { recursive: false });
const events = [], modes = [];
const origin = performance.now();
function log(type, detail = {}) {
  const event = { sequence: events.length + 1, at: new Date().toISOString(), elapsedMs: performance.now() - origin, type, ...detail };
  events.push(event); process.stdout.write(JSON.stringify(event) + '\n');
}
function errorOf(error) {
  return { name: error?.name, message: error?.message, code: error?.code, stack: error?.stack,
    cause: error?.cause ? { name: error.cause.name, message: error.cause.message, code: error.cause.code,
      syscall: error.cause.syscall, stack: error.cause.stack } : null };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const body = Buffer.from(JSON.stringify({ schemaVersion: 1, actionId: 'local-loopback-control', payload: 'identical-complete-POST-body' }));
log('experiment-start', { node: process.version, executable: process.execPath, versions: process.versions,
  platform: process.platform, argv: process.argv, cwd: process.cwd(), bodyBytes: body.length, bodySha256: sha(body),
  noEngineBrowserOrMaintainedTests: true, retryCount: 0 });

async function runMode(mode) {
  let connectionCounter = 0;
  const sockets = new Set(), connections = new WeakMap(), requests = [];
  const server = createServer((req, res) => {
    const connectionId = connections.get(req.socket), chunks = [];
    log('server-request', { mode, connectionId, url: req.url, method: req.method, headers: req.headers });
    req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => {
      const received = Buffer.concat(chunks);
      const response = { mode, connectionId, receivedBytes: received.length, receivedSha256: sha(received), fullBodyEqual: received.equals(body) };
      requests.push({ url: req.url, ...response });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
      log('server-response', { mode, connectionId, url: req.url, status: 200, ...response });
    });
    req.once('error', error => log('server-request-error', { mode, connectionId, error: errorOf(error) }));
  });
  server.on('connection', socket => {
    const connectionId = ++connectionCounter;
    connections.set(socket, connectionId); sockets.add(socket);
    log('server-connection', { mode, connectionId, localPort: socket.localPort, remotePort: socket.remotePort });
    socket.on('timeout', () => log('server-socket-timeout-observed', { mode, connectionId }));
    socket.on('error', error => log('server-socket-error', { mode, connectionId, error: errorOf(error) }));
    socket.once('close', hadError => { sockets.delete(socket); log('server-socket-close', { mode, connectionId, hadError }); });
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const timeouts = { keepAliveTimeout: server.keepAliveTimeout, keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer,
    requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout, serverTimeout: server.timeout };
  const blockMs = server.keepAliveTimeout + (server.keepAliveTimeoutBuffer ?? 0) + 1000;
  log('server-listening', { mode, base, timeouts, blockMs, defaultsUnchanged: true });
  async function post(label) {
    const started = performance.now(); log('client-post-start', { mode, label });
    try {
      let result;
      if (mode === 'fetch') {
        const response = await fetch(base + '/' + label, { method: 'POST', headers: { 'content-type': 'application/json' },
          body, signal: AbortSignal.timeout(30000) });
        const text = await response.text();
        result = { status: response.status, headers: Object.fromEntries(response.headers), text, payload: JSON.parse(text) };
      } else {
        result = await new Promise((resolveRequest, reject) => {
          const req = request(base + '/' + label, { method: 'POST', agent: false,
            headers: { 'content-type': 'application/json', 'content-length': body.length }, signal: AbortSignal.timeout(30000) }, incoming => {
            const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.once('error', reject);
            incoming.once('end', () => { try {
              const text = Buffer.concat(chunks).toString('utf8');
              resolveRequest({ status: incoming.statusCode, headers: incoming.headers, text, payload: JSON.parse(text) });
            } catch (error) { reject(error); } });
          });
          req.once('error', reject);
          req.on('socket', socket => log('client-native-socket', { mode, label, reusedSocket: req.reusedSocket,
            localPort: socket.localPort, remotePort: socket.remotePort }));
          req.end(body);
        });
      }
      const value = { label, success: true, durationMs: performance.now() - started, ...result };
      log('client-post-complete', { mode, ...value }); return value;
    } catch (error) {
      const value = { label, success: false, durationMs: performance.now() - started, error: errorOf(error) };
      log('client-post-failed', { mode, ...value }); return value;
    }
  }
  let result;
  try {
    const first = await post('first');
    if (!first.success) throw Error('Initial POST failed; cannot interpret a reuse experiment');
    // Deliberately perform synchronous work in the same process as both ends.
    // No await/yield occurs between the first full body and the late request.
    const blockingStart = performance.now(); let loops = 0;
    log('synchronous-work-start', { mode, blockMs });
    while (performance.now() - blockingStart < blockMs) loops++;
    const actualBlockMs = performance.now() - blockingStart;
    log('synchronous-work-end', { mode, actualBlockMs, loops });
    const late = await post('late');
    result = { mode, base, timeouts, intendedBlockMs: blockMs, actualBlockMs, first, late, requests, connectionsOpened: connectionCounter };
    modes.push(result);
  } finally {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    for (const socket of sockets) socket.destroy();
    log('server-closed', { mode, connectionsOpened: connectionCounter });
  }
  return result;
}

try {
  await runMode('fetch');
  await runMode('native-agent-false');
  const result = { schemaVersion: 1, kind: 'single-local-http-keepalive-control', node: process.version,
    executable: process.execPath, endedAt: new Date().toISOString(), modes,
    fetchLateFailureReproduced: modes[0].late.success === false,
    freshAgentLateSucceeded: modes[1].late.success === true,
    scope: 'One local same-process HTTP experiment. No engine, Browser, product fixture or full Core rerun. This does not establish the original Core failure cause.',
    events };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(out, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(join(out, 'script-identity.json'), JSON.stringify({ path: process.argv[1], bytes: readFileSync(process.argv[1]).length,
    sha256: sha(readFileSync(process.argv[1])) }, null, 2) + '\n');
  log('experiment-complete', { fetchLateFailureReproduced: result.fetchLateFailureReproduced,
    freshAgentLateSucceeded: result.freshAgentLateSucceeded });
} catch (error) {
  log('experiment-failed', { error: errorOf(error) });
  writeFileSync(join(out, 'failure.json'), JSON.stringify({ error: errorOf(error), modes, events }, null, 2) + '\n');
  process.exitCode = 1;
}
