/** Controlled recovery fixtures, not a substitute for live catalog admission.
 * Reuse the archived validated envelope, vary identities and the local target,
 * then create lifecycle facts through the real owner-bound writer. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { acquireAcceptanceOwner } from '../../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../../src/acceptance/catalog.mjs';
import { managedSpecDispatchPlanFingerprint, validateManagedSpecDispatchEnvelope } from '../../src/acceptance/managed-dispatch-schema.mjs';
import { createManagedAcceptanceRun } from '../../src/acceptance/managed-run-store.mjs';
import { createAcceptanceRun } from '../../src/acceptance/store.mjs';

export const CORE = fileURLToPath(new URL('../..', import.meta.url));
const archived = JSON.parse(fs.readFileSync(new URL('../../../docs/audits/2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json', import.meta.url), 'utf8'));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
export const sleep = ms => new Promise(ready => setTimeout(ready, ms));
export const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(50);
  }
  throw new Error('Recovery fixture timed out: ' + (last?.message ?? 'state not reached'));
}
async function listen(server) {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return server.address().port;
}
/** Only regular controlled fixture files are read; do not use on FIFO fixtures. */
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
export async function recoveryFixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-owned-recovery-'))), root = join(parent, 'acceptance');
  const requests = [], modelRequests = [], engines = [];
  const target = createServer((req, res) => {
    (req.url.startsWith('/v1/') ? modelRequests : requests).push({ method: req.method, url: req.url });
    req.resume(); res.setHeader('Content-Type', 'application/json'); res.end('{"code":0,"quota":1,"enabled":false,"name":""}');
  });
  const base = 'http://127.0.0.1:' + await listen(target), owner = acquireAcceptanceOwner({ root });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize();
  const current = catalog.read();
  const project = (await catalog.createProject({ expectedGenerationId: current.generationId, expectedRevision: current.revision,
    name: '恢复受控夹具' })).project;
  const legacyInput = { name: 'legacy recovery fixture', mode: 'spec', targetUrl: base + '/legacy', spec: {
    source: { id: 'RECOVERY-FIXTURE', revision: '1' }, approved: true,
    checks: [{ id: 'HEALTH', title: 'health', method: 'GET', path: '/health', expect: { status: 200 } }] } };
  function prepare({ start = false } = {}) {
    const envelope = structuredClone(archived);
    Object.assign(envelope, { operationId: 'ao-' + randomUUID(), dispatchId: 'ad-' + randomUUID(),
      runId: 'ac-' + randomUUID(), taskId: 'a-' + randomUUID() });
    envelope.targetRelease.targetUrl = base + '/managed'; envelope.plan.targetUrl = envelope.targetRelease.targetUrl;
    envelope.planFingerprint = managedSpecDispatchPlanFingerprint(envelope.plan);
    validateManagedSpecDispatchEnvelope(envelope);
    const bytes = encode(envelope), directory = join(root, 'managed-spec-dispatches', 'v1');
    fs.mkdirSync(directory, { recursive: true });
    const sidecar = join(directory, envelope.operationId + '.json'); fs.writeFileSync(sidecar, bytes, { flag: 'wx' });
    const ref = { operationId: envelope.operationId, dispatchSha256: hash(bytes) }, options = { owner, assertActive: () => true };
    const dir = join(root, envelope.runId), manifestPath = join(dir, 'manifest.json');
    if (start) createManagedAcceptanceRun(ref, options);
    return { envelope, bytes, ref, options, sidecar, dir, manifestPath, reportPath: join(dir, 'report.json') };
  }
  const legacy = () => createAcceptanceRun(legacyInput, { root });
  async function startEngine({ releaseOwner = true, consoleDir = '', token = '' } = {}) {
    if (releaseOwner) owner.release();
    const reservation = createServer(), port = await listen(reservation);
    await new Promise(ready => reservation.close(ready));
    const engineBase = 'http://127.0.0.1:' + port;
    const child = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: CORE, env: { ...process.env,
      HEIMDALL_DATA_DIR: parent, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token,
      HEIMDALL_CONSOLE_DIR: consoleDir, HEIMDALL_ENV_FILE: join(parent, 'missing.env'), HEIMDALL_LLM: '1',
      LLM_BASE_URL: base + '/v1', LLM_API_KEY: 'recovery-fixture-key', LLM_MODEL: 'recovery-fixture-model',
      LLM_PROTOCOL: 'chat', LLM_TIMEOUT_MS: '1000', LLM_MAX_RETRIES: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const get = (path, options = {}) => fetch(engineBase + path, { ...options,
      headers: { 'Content-Type': 'application/json', 'x-heimdall-token': token, ...options.headers }, signal: AbortSignal.timeout(5000) });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    };
    const engine = { child, base: engineBase, get, stop, output: () => output }; engines.push(engine);
    if (releaseOwner) try {
      await waitFor(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('engine exited: ' + output);
        return output.includes(engineBase) && (await get('/api/status')).ok;
      });
    } catch (error) { await stop(); throw error; }
    return engine;
  }
  async function cleanup() {
    for (const engine of engines) await engine.stop();
    owner.release(); target.closeAllConnections(); await new Promise(ready => target.close(ready));
    assert.ok(parent.startsWith(fs.realpathSync(tmpdir()) + sep) && parent.includes('heimdall-owned-recovery-'));
    fs.rmSync(parent, { recursive: true, force: true });
  }
  return { parent, root, base, owner, catalog, project, requests, modelRequests, engines, legacyInput, legacy, prepare, startEngine, cleanup };
}
