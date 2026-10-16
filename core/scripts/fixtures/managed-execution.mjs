/** Full local admission fixture: draft -> binding -> candidate -> approval ->
 * current selection -> explicit target release. No synthetic dispatch facts. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireAcceptanceOwner } from '../../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../../src/acceptance/spec-runner.mjs';
export const CORE = fileURLToPath(new URL('../..', import.meta.url));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
export const sleep = ms => new Promise(ready => setTimeout(ready, ms));
export async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(50);
  }
  throw new Error('Managed execution fixture timed out: ' + (last?.message ?? 'state not reached'), { cause: last });
}
const errorFacts = (error, depth = 0) => !error || depth > 4 ? null : {
  ...Object.fromEntries(['name', 'message', 'code', 'errno', 'syscall', 'address', 'port'].filter(key => error[key] !== undefined)
    .map(key => [key, String(error[key]).slice(0, 2000)])),
  ...(error.cause ? { cause: errorFacts(error.cause, depth + 1) } : {}),
  ...(Array.isArray(error.errors) ? { errors: error.errors.slice(0, 8).map(item => errorFacts(item, depth + 1)) } : {}),
};
/** Snapshot regular controlled fixture files only; never scan arbitrary paths. */
export function facts(root, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && entry.name === '.acceptance-owner.json') continue;
    const name = prefix + entry.name, path = join(root, entry.name);
    if (entry.isDirectory()) {
      result[name + '/'] = 'directory'; Object.assign(result, facts(path, name + '/'));
    } else {
      assert.ok(entry.isFile(), 'Fixture snapshots accept regular files only: ' + name);
      result[name] = { sha256: hash(fs.readFileSync(path)), nlink: fs.lstatSync(path).nlink };
    }
  }
  return result;
}
const cas = catalog => {
  const { generationId, revision } = catalog.read();
  return { expectedGenerationId: generationId, expectedRevision: revision };
};
async function listen(server) {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready)); return server.address().port;
}
export async function managedExecutionFixture({ paths = ['/healthy', '/bug'], holdPaths = [], timeoutMs = 30000 } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-execution-'))), root = join(parent, 'acceptance');
  const requests = [], modelRequests = [], engines = [], held = new Set(holdPaths), pending = new Set();
  let owner;
  const target = createServer((req, res) => {
    req.resume();
    if (req.url.startsWith('/v1/')) {
      modelRequests.push({ method: req.method, path: req.url });
      res.setHeader('content-type', 'application/json');
      res.end('{"choices":[{"message":{"content":"{\\"summary\\":\\"unexpected model call\\",\\"items\\":[]}"}}]}');
      return;
    }
    const request = { method: req.method, path: req.url, closed: false, completed: false };
    requests.push(request);
    res.on('finish', () => { request.completed = true; });
    res.on('close', () => { request.closed = true; pending.delete(item); });
    const item = { request, res, send() {
      if (res.destroyed || res.writableEnded) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: new URL(req.url, 'http://fixture').pathname.endsWith('/bug') ? 9 : 0 }));
      pending.delete(item);
    } };
    if ([...held].some(path => new URL(req.url, 'http://fixture').pathname.endsWith(path))) pending.add(item);
    else item.send();
  });
  const base = 'http://127.0.0.1:' + await listen(target);
  try {
    owner = acquireAcceptanceOwner({ root });
    const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize();
    const project = (await catalog.createProject({ ...cas(catalog), name: '托管执行真实接纳夹具' })).project;
    const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: '草稿需求来源',
      targetUrl: base + '/source?tenant=source' })).release;
    const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: '明确待验收版本',
      targetUrl: base + '/target?tenant=execution' })).release;
    const alternateRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: '另一个目标版本',
      targetUrl: base + '/alternate?tenant=execution' })).release;
    const source = createAcceptanceRun({ name: '来源草稿完整合同', mode: 'spec', targetUrl: sourceRelease.targetUrl, timeoutMs,
      spec: { source: { id: 'REQ-MANAGED-EXECUTION', revision: '1', type: 'manual', title: '健康与业务码合同' }, approved: false,
        checks: paths.map((path, index) => ({ id: 'CHECK-' + index, title: path === '/bug' ? '业务码必须为零' : '响应符合已批准合同',
          method: 'GET', path, severity: path === '/bug' ? 'high' : 'medium',
          expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } }, { root });
    const sourceDir = join(root, source.runId);
    finishAcceptanceRun(source.runId, await runSpecAcceptance(source.plan, { runId: source.runId, outputDir: sourceDir }), { root });
    assert.equal(requests.length, 0, 'Draft creation/completion must never request the target.');
    await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
    const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec',
      sourceSide: 'source', sourceRunId: source.runId })).candidate;
    const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id,
      contentDigest: candidate.contentDigest, reason: '已核对完整草稿合同，批准托管执行测试来源' })).approval;
    const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id,
      contentDigest: candidate.contentDigest, reason: '本次测试明确选用此批准，并单独确认目标版本' })).selection;
    const version = cas(catalog), sourceBefore = facts(sourceDir);
    const confirmation = (operationId = 'ao-' + randomUUID()) => ({ operationId, ...version,
      selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
    const executionPath = '/api/acceptance/projects/' + project.id + '/spec-executions';
    const diskRun = runId => join(root, runId);
    const manifest = runId => json(join(diskRun(runId), 'manifest.json'));
    const sidecar = operationId => join(root, 'managed-spec-dispatches', 'v1', operationId + '.json');
    const matches = (request, path) => new URL(request.path, base).pathname.endsWith(path);
    const matchingRequests = path => requests.filter(request => matches(request, path));
    const arrived = (path, count = 1) => waitFor(() => matchingRequests(path).length >= count && matchingRequests(path)[count - 1]);
    function release(path) {
      if (path === undefined) held.clear(); else held.delete(path);
      for (const item of [...pending]) if (path === undefined || matches(item.request, path)) item.send();
    }
    const hold = path => held.add(path);
    async function prepareOnly(input = confirmation()) {
      const { record } = await catalog.prepareManagedSpecDispatch(project.id, input);
      assert.equal(requests.length, 0);
      return { input, record, envelope: JSON.parse(record.bytes.toString('utf8')) };
    }
    async function startEngine({ consoleDir = '', token = '', forceJson = false } = {}) {
      owner.release();
      const reservation = createServer(), port = await listen(reservation);
      await new Promise(ready => reservation.close(ready));
      const engineBase = 'http://127.0.0.1:' + port;
      const child = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: CORE, windowsHide: true,
        env: { ...process.env, HEIMDALL_DATA_DIR: parent, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token,
          HEIMDALL_CONSOLE_DIR: consoleDir, HEIMDALL_ENV_FILE: join(parent, 'missing.env'), HEIMDALL_LLM: '1',
          HEIMDALL_JOBS_FORCE_JSON: forceJson ? '1' : '0', LLM_BASE_URL: base + '/v1', LLM_API_KEY: 'managed-execution-fixture-key',
          LLM_MODEL: 'managed-execution-fixture-model', LLM_PROTOCOL: 'chat', LLM_TIMEOUT_MS: '1000', LLM_MAX_RETRIES: '1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', spawnError;
      child.on('error', error => { spawnError = error; });
      child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
      const get = (path, options = {}) => fetch(engineBase + path, { ...options,
        headers: { 'content-type': 'application/json', 'x-heimdall-token': token, ...options.headers },
        signal: options.signal ?? AbortSignal.timeout(15000) });
      async function request(path, { body, ...options } = {}) {
        const response = await get(path, { ...options, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
        return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
      }
      const execute = input => request(executionPath, { method: 'POST', body: input });
      const operation = operationId => request(executionPath + '/' + operationId);
      const run = runId => request('/api/acceptance/runs/' + runId);
      const jobs = () => request('/api/jobs');
      async function waitRun(runId, status = 'completed') {
        const startedAt = Date.now(); let attempts = 0, lastResponse = null, lastFailure = null;
        try {
          return await waitFor(async () => {
            attempts++;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('Engine exited while waiting for run.');
            let current;
            try { current = await run(runId); }
            catch (error) { lastFailure = { elapsedMs: Date.now() - startedAt, error: errorFacts(error) }; throw error; }
            lastResponse = { elapsedMs: Date.now() - startedAt, httpStatus: current.status, body: current.body };
            return current.status === 200 && current.body.status === status && current.body;
          });
        } catch (error) {
          // A stale early transport error must not hide later successful reads.
          // These captures diagnose a failed assertion; they never extend its
          // 15s polling budget, retry execution, settle a run or contact targets.
          const diagnostic = { runId, expectedStatus: status, elapsedMs: Date.now() - startedAt, attempts,
            engineExit: child.exitCode, engineSignal: child.signalCode, lastResponse, lastFailure, waitError: errorFacts(error),
            heldPaths: [...held], pendingRequests: [...pending].map(item => ({ ...item.request })),
            targetRequests: requests.map(item => ({ ...item })) };
          try {
            const disk = manifest(runId);
            diagnostic.diskManifest = Object.fromEntries(['runId', 'taskId', 'status', 'gate', 'reasonCode', 'error', 'progress',
              'createdAt', 'updatedAt', 'endedAt'].filter(key => Object.hasOwn(disk, key)).map(key => [key, disk[key]]));
            diagnostic.diskFiles = fs.readdirSync(diskRun(runId)).sort();
          } catch (cause) { diagnostic.diskError = errorFacts(cause); }
          const observations = await Promise.allSettled(['/api/acceptance/execution', '/api/jobs'].map(path =>
            request(path, { signal: AbortSignal.timeout(1000) })));
          for (const [index, observed] of observations.entries()) diagnostic[index === 0 ? 'capabilityAfterTimeout' : 'jobsAfterTimeout'] =
            observed.status === 'fulfilled' ? observed.value : { error: errorFacts(observed.reason) };
          throw new Error(error.message + '\nManaged wait diagnostics:\n' + JSON.stringify(diagnostic, null, 2) + '\nEngine output:\n' + output, { cause: error });
        }
      }
      async function waitTask(taskId, status) {
        return waitFor(async () => {
          const result = await jobs(), task = result.body.jobs.find(item => item.id === taskId);
          return task && task.status === status && { task, history: result.body.history.find(item => item.id === taskId), jobs: result.body };
        });
      }
      const stop = async (signal = 'SIGKILL') => {
        if (child.exitCode !== null || child.signalCode !== null || spawnError) return;
        const exited = once(child, 'exit'); child.kill(signal);
        if (signal === 'SIGKILL') await exited;
        else { await Promise.race([exited, sleep(5000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
      };
      const engine = { child, base: engineBase, get, request, execute, operation, run, jobs, waitRun, waitTask, stop, output: () => output };
      engines.push(engine);
      try {
        await waitFor(async () => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('Engine exited: ' + output);
          return output.includes(engineBase) && (await get('/api/status')).ok;
        });
      } catch (error) { await stop(); throw error; }
      return engine;
    }
    async function cleanup() {
      for (const engine of engines) await engine.stop();
      owner.release(); target.closeAllConnections(); await new Promise(ready => target.close(ready));
      assert.ok(parent.startsWith(fs.realpathSync(tmpdir()) + sep) && parent.includes('heimdall-managed-execution-'));
      fs.rmSync(parent, { recursive: true, force: true });
    }
    return { parent, root, base, owner, catalog, project, sourceRelease, targetRelease, alternateRelease, source, sourceDir, sourceBefore,
      candidate, approval, selection, version, executionPath, requests, modelRequests, engines, confirmation, diskRun, manifest,
      sidecar, matchingRequests, arrived, release, hold, prepareOnly, startEngine, cleanup };
  } catch (error) {
    owner?.release(); target.closeAllConnections(); await new Promise(ready => target.close(ready));
    fs.rmSync(parent, { recursive: true, force: true }); throw error;
  }
}
