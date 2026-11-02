#!/usr/bin/env node
/** Fresh local demonstration environment. All acceptance decisions remain manual. */
import { existsSync, mkdirSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { startAcceptanceDemoPages } from '../src/acceptance/demo-pages.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));
const DEFAULT_SESSIONS = join(CORE, 'workspace', '_runs', 'acceptance-demo');
const PROJECT_NAME = '本地固定演示 · 还原度与缺陷复验';
const RELEASES = Object.freeze([
  { path: '/reference', label: '参考来源' }, { path: '/bug', label: '已知缺陷' },
  { path: '/partial', label: '部分修复' }, { path: '/fixed', label: '完全修复' },
]);
const delay = ms => new Promise(ready => setTimeout(ready, ms));
const json = value => JSON.stringify(value, null, 2) + '\n';

/** Completion is an observation, so it always resolves even when cleanup fails.
 * The first terminal fact stays fixed for every observer and repeated close. */
export function createAcceptanceDemoCompletion() {
  let finish, terminal;
  const closed = new Promise(ready => { finish = ready; });
  return Object.freeze({ closed, finish(value) {
    if (!terminal) { terminal = Object.freeze({ ...value }); finish(terminal); }
    return terminal;
  } });
}

/** Install the real child channel fence before admitting engine imports. A
 * send function may survive an already disconnected IPC channel on Node. */
export function connectAcceptanceDemoEngineChild(channel, onStop) {
  const connected = () => {
    if (typeof channel.send !== 'function' || channel.connected !== true) throw new Error('The demo engine child requires a connected launcher IPC channel.');
  };
  connected();
  const onMessage = message => { if (message?.kind === 'acceptance-demo-stop') onStop(); };
  const detach = () => { channel.off('message', onMessage); channel.off('disconnect', onStop); };
  channel.on('message', onMessage); channel.once('disconnect', onStop);
  try { connected(); }
  catch (error) { detach(); throw error; }
  return detach;
}

export function parseAcceptanceDemoArgs(args) {
  const options = { open: true, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!['--no-open', '--session-dir', '--help'].includes(arg) || seen.has(arg)) throw new Error(`Unknown or duplicate demo option: ${arg}`);
    seen.add(arg);
    if (arg === '--no-open') options.open = false;
    else if (arg === '--help') options.help = true;
    else {
      const value = args[++index];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error('--session-dir requires a fresh directory path.');
      options.sessionDir = resolve(value);
    }
  }
  return options;
}

function loopbackOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('A plain HTTP 127.0.0.1 origin with an explicit port is required.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || url.origin !== value) throw new TypeError('A plain HTTP 127.0.0.1 origin with an explicit port is required.');
  return url.origin;
}

export function acceptanceDemoConsoleUrl(engineOrigin, fixtureOrigin) {
  const url = new URL(loopbackOrigin(engineOrigin) + '/');
  url.searchParams.set('acceptanceDemo', 'local-fixed-v1');
  url.searchParams.set('fixtureOrigin', loopbackOrigin(fixtureOrigin));
  return url.href;
}

export function acceptanceDemoEngineEnv(inherited, { dataDir, consoleDir, engineOrigin }) {
  return { ...inherited, HEIMDALL_DATA_DIR: resolve(dataDir), HEIMDALL_JOBS_DB: join(resolve(dataDir), 'jobs.db'),
    HEIMDALL_ENV_FILE: join(resolve(dataDir), '.env'), LLM_API_KEY: '',
    HEIMDALL_CONSOLE_DIR: resolve(consoleDir), HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: '', HEIMDALL_LLM: '0',
    HEIMDALL_PORT: new URL(loopbackOrigin(engineOrigin)).port, HEIMDALL_CORS_ORIGIN: engineOrigin,
    HEIMDALL_ALLOWED_HOSTS: '', HEIMDALL_TRUSTED_HOSTS: '' };
}

/** The injected request has the same ordinary HTTP route/body contract used by
 * the console. This function has no access to candidates, executions or tickets. */
export async function prepareAcceptanceDemoMetadata(request, fixtureOrigin, expectedGenerationId) {
  const origin = loopbackOrigin(fixtureOrigin);
  const read = async () => {
    const state = await request('/api/acceptance/projects');
    if (state.schemaVersion !== 4 || state.generationId !== expectedGenerationId || !Number.isSafeInteger(state.revision)
      || state.revision < 0 || !Array.isArray(state.projects) || !Array.isArray(state.runBindings)) throw new Error('The fresh demo catalog identity could not be confirmed.');
    return state;
  };
  const cas = state => ({ expectedGenerationId: state.generationId, expectedRevision: state.revision });
  const initial = await read();
  if (initial.revision !== 0 || initial.projects.length || initial.runBindings.length) throw new Error('Demo metadata requires a new empty catalog.');
  const created = await request('/api/acceptance/projects', { ...cas(initial), name: PROJECT_NAME }, 201);
  if (!/^ap-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(created.project?.id ?? '')
    || created.project.name !== PROJECT_NAME || created.generationId !== expectedGenerationId || created.revision !== 1) throw new Error('Demo project creation returned an unexpected receipt.');
  const releases = [];
  for (const item of RELEASES) {
    const state = await read();
    if (state.revision !== releases.length + 1 || state.projects.length !== 1 || state.projects[0].id !== created.project.id || state.runBindings.length) throw new Error('Demo catalog changed during metadata setup; original records are retained.');
    const receipt = await request('/api/acceptance/projects/' + created.project.id + '/releases',
      { ...cas(state), label: item.label, targetUrl: origin + item.path }, 201);
    if (!/^ar-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.release?.id ?? '')
      || releases.some(value => value.id === receipt.release.id) || receipt.generationId !== expectedGenerationId || receipt.revision !== state.revision + 1
      || receipt.release?.projectId !== created.project.id || receipt.release?.label !== item.label || receipt.release?.targetUrl !== origin + item.path) throw new Error('Demo version creation returned an unexpected receipt.');
    releases.push(receipt.release);
  }
  const detail = await request('/api/acceptance/projects/' + created.project.id);
  if (detail.schemaVersion !== 4 || detail.generationId !== expectedGenerationId || detail.revision !== 5
    || JSON.stringify(detail.project) !== JSON.stringify(created.project) || JSON.stringify(detail.releases) !== JSON.stringify(releases) || detail.runBindings?.length !== 0
    || detail.events?.length !== 5 || detail.events.some(event => !['project-created', 'release-created'].includes(event.kind))
    || ['candidates', 'approvals', 'selections', 'browserSourceBindings', 'browserCandidates'].some(key => detail[key]?.length !== 0)) throw new Error('Demo metadata readback did not match the declared setup.');
  return { project: created.project, releases, generationId: detail.generationId, revision: detail.revision };
}

async function checkDemoDependencies(consoleDir) {
  if (!existsSync(join(consoleDir, 'index.html')) || !statSync(join(consoleDir, 'index.html')).isFile()) throw new Error('Build the console first: pnpm -C console build');
  const require = createRequire(join(CORE, 'package.json'));
  try { for (const name of ['playwright', 'parse5', 'pixelmatch', 'pngjs']) require.resolve(name); }
  catch { throw new Error('Install project dependencies first: pnpm -C core install'); }
  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath())) throw new Error('Install the local Chromium runtime first: pnpm -C core exec playwright install chromium');
}

async function reservePort() {
  const server = createServer();
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port;
  await new Promise((ready, reject) => server.close(error => error ? reject(error) : ready()));
  return port;
}

async function stopOwnEngine(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(ready => child.once('exit', ready));
  // IPC reaches Node's real signal handler on Windows as well as POSIX. The
  // engine can drain its own Browser workers before releasing its owner lock.
  if (child.connected) child.send({ kind: 'acceptance-demo-stop' }, () => {});
  else child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(ready => { timer = setTimeout(ready, 7000); })]); clearTimeout(timer);
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(ready => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', ready); killer.once('exit', ready);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  await Promise.race([exited, new Promise(ready => { timer = setTimeout(ready, 2000); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) throw new Error('The demo engine did not stop; retain the session and inspect its recorded PID.');
}

function openLocalConsole(url, onError) {
  const command = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { windowsHide: true, stdio: 'ignore' });
  child.once('error', onError); child.once('exit', code => { if (code) onError(new Error('Browser opener exited with ' + code)); }); child.unref();
}

export async function startAcceptanceDemo({ sessionDir, open = true, signal } = {}) {
  const consoleDir = resolve(CORE, '../console/dist');
  await checkDemoDependencies(consoleDir);
  if (signal?.aborted) throw new Error('Demo startup cancelled.');
  const createdAt = new Date().toISOString();
  const directory = resolve(sessionDir ?? join(DEFAULT_SESSIONS, createdAt.replace(/[-:.TZ]/g, '') + '-' + randomUUID()));
  if (existsSync(directory)) throw new Error('Use a fresh demo session directory; existing evidence will not be overwritten: ' + directory);
  // Only the parent is recursive. The final session itself must be exclusive.
  mkdirSync(resolve(directory, '..'), { recursive: true }); mkdirSync(directory);
  const dataDir = join(directory, 'runtime'); mkdirSync(dataDir); mkdirSync(join(directory, 'exports'));
  const session = { schemaVersion: 1, kind: 'local-fixed-acceptance-demo', createdAt, status: 'starting', sessionDir: directory,
    dataDir, consoleDir, fixtureOrigin: null, engineOrigin: null, consoleUrl: null, enginePid: null, metadata: null,
    boundary: '本地固定示例；真实浏览器执行由操作者启动；固定成员人工选择；未启用模型推理。' };
  const save = () => writeFileSync(join(directory, 'session.json'), json(session));
  const event = value => appendFileSync(join(directory, 'launcher-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const completion = createAcceptanceDemoCompletion();
  let fixture, engine, closePromise, engineError, readyLine = false, engineTail = '', readyForSignals = false;
  const close = (reason = 'operator-stop') => closePromise ??= (async () => {
    signal?.removeEventListener('abort', abort);
    const results = await Promise.allSettled([stopOwnEngine(engine), fixture?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason?.message ?? String(result.reason));
    session.status = errors.length ? 'stop-failed' : session.status === 'failed' ? 'failed' : 'stopped';
    session.stoppedAt = new Date().toISOString(); session.stopReason = reason;
    if (errors.length) session.error = errors.join('; ');
    try { save(); event({ kind: 'stopped', reason, status: session.status }); }
    catch (error) {
      session.status = 'stop-failed'; session.error = 'Unable to preserve the demo terminal record: ' + error.message;
      try { save(); } catch { /* The resolving terminal fact still exposes this persistence failure. */ }
    }
    return completion.finish({ status: session.status, reason, stoppedAt: session.stoppedAt,
      ...(session.error ? { error: session.error } : {}) });
  })();
  // During startup, finish the current resource acquisition before its catch
  // closes everything. This avoids racing a close against a pending listen.
  const abort = () => { if (readyForSignals) close('signal').catch(error => console.error(error.message)); };
  signal?.addEventListener('abort', abort, { once: true });
  const assertStarting = () => {
    if (closePromise) throw new Error(session.error ?? 'Demo startup stopped.');
    if (signal?.aborted) throw new Error('Demo startup cancelled.');
  };
  save();
  writeFileSync(join(directory, 'target-requests.jsonl'), '', { flag: 'wx' });
  try {
    const { acquireAcceptanceOwner } = await import('../src/acceptance/owner.mjs');
    const { createAcceptanceCatalogStore } = await import('../src/acceptance/catalog.mjs');
    assertStarting();
    const root = join(dataDir, 'acceptance');
    const owner = acquireAcceptanceOwner({ root });
    let initialized;
    try { initialized = await createAcceptanceCatalogStore({ root, owner }).initialize({ createSchemaVersion: 4 }); }
    finally { owner.release(); }
    assertStarting();
    fixture = await startAcceptanceDemoPages({ onRequest: value => appendFileSync(join(directory, 'target-requests.jsonl'), JSON.stringify(value) + '\n') });
    session.fixtureOrigin = fixture.origin; session.pages = fixture.pages; save();
    const port = await reservePort(); assertStarting();
    const engineOrigin = 'http://127.0.0.1:' + port; session.engineOrigin = engineOrigin;
    engine = spawn(process.execPath, [SCRIPT, '--engine-child', String(port)], { cwd: CORE, windowsHide: true,
      // Avoid Windows parent Job termination so IPC disconnect can release the engine's owner.
      detached: true, env: acceptanceDemoEngineEnv(process.env, { dataDir, consoleDir, engineOrigin }), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    session.enginePid = engine.pid ?? null; save();
    engine.on('error', error => { engineError = error; });
    const log = bytes => {
      appendFileSync(join(directory, 'engine.log'), bytes);
      engineTail = (engineTail + bytes.toString()).slice(-8192);
      if (engineTail.includes('engine-server @ ' + engineOrigin)) readyLine = true;
    };
    engine.stdout.on('data', log); engine.stderr.on('data', log);
    engine.once('exit', (code, exitSignal) => {
      session.engineExit = { code, signal: exitSignal };
      try { event({ kind: 'engine-exit', ...session.engineExit }); } catch { /* close records a persistence failure independently. */ }
      if (!closePromise) {
        session.status = 'failed'; session.error = `The owned demo engine exited unexpectedly (code=${code}, signal=${exitSignal ?? 'none'}).`;
        close('engine-exit').catch(error => console.error(error.message));
      }
    });
    const request = async (path, body, expectedStatus = 200) => {
      assertStarting();
      const response = await fetch(engineOrigin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
      const payload = await response.json();
      appendFileSync(join(directory, 'metadata-http.jsonl'), JSON.stringify({ at: new Date().toISOString(), method: body === undefined ? 'GET' : 'POST', path,
        ...(body === undefined ? {} : { body }), status: response.status, payload }) + '\n');
      if (response.status !== expectedStatus) throw new Error('Demo setup HTTP ' + response.status + ' at ' + path + ': ' + (payload.code ?? 'UNEXPECTED_RESPONSE'));
      return payload;
    };
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      assertStarting();
      if (engineError || engine.exitCode !== null || engine.signalCode !== null) throw new Error('The owned demo engine could not start: ' + (engineError?.message ?? engineTail));
      if (readyLine) {
        try { const recovery = await request('/api/acceptance/recovery'); if (recovery.ready === true) { ready = true; break; } }
        catch { /* A just-listening owned engine may still be settling startup. */ }
      }
      await delay(100);
    }
    if (!ready) throw new Error('The demo engine did not become ready; inspect engine.log.');
    session.metadata = await prepareAcceptanceDemoMetadata(request, fixture.origin, initialized.generationId);
    assertStarting();
    session.consoleUrl = acceptanceDemoConsoleUrl(engineOrigin, fixture.origin); session.status = 'ready'; session.readyAt = new Date().toISOString(); readyForSignals = true; save();
    event({ kind: 'ready', engineOrigin, fixtureOrigin: fixture.origin });
    if (open) openLocalConsole(session.consoleUrl, error => { event({ kind: 'browser-open-unavailable', message: error.message }); console.error('Open the printed console URL manually.'); });
    return Object.freeze({ sessionDir: directory, session: JSON.parse(JSON.stringify(session)), close, closed: completion.closed });
  } catch (error) {
    session.status = 'failed'; session.error = error.message;
    // A failed evidence write must not skip cleanup of resources already owned
    // by this startup. close() records persistence errors in its terminal fact.
    try { save(); } catch { /* The cleanup path still runs below. */ }
    await close('startup-failed'); throw error;
  }
}

async function engineChild(port) {
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('The demo engine child requires a valid port.');
  let requested = false;
  const stop = () => { if (!requested) { requested = true; process.emit('SIGTERM'); } };
  const detach = connectAcceptanceDemoEngineChild(process, stop);
  try {
    if (!process.connected || requested) throw new Error('The launcher IPC disconnected before demo engine startup.');
    process.argv = [process.execPath, ENGINE, port];
    await import(new URL('../src/engine-server.mjs', import.meta.url));
    if (requested) process.emit('SIGTERM');
  } catch (error) {
    detach();
    if (process.connected) process.disconnect();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    if (process.argv[2] === '--engine-child') await engineChild(process.argv[3]);
    else {
      const options = parseAcceptanceDemoArgs(process.argv.slice(2));
      if (options.help) console.log('Usage: pnpm acceptance:demo [--no-open] [--session-dir <fresh-directory>]\nCreates a fresh local fixed example. Ctrl+C stops only this session and retains its evidence.');
      else {
        const controller = new AbortController();
        const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
        const demo = await startAcceptanceDemo({ ...options, signal: controller.signal });
        console.log(json({ event: 'acceptance-demo-ready', consoleUrl: demo.session.consoleUrl, sessionDir: demo.sessionDir,
          project: demo.session.metadata.project.name, versions: demo.session.metadata.releases.map(value => value.label),
          boundary: demo.session.boundary, stop: 'Ctrl+C；保留全部 session 原件。' }));
        const terminal = await demo.closed;
        if (terminal.status !== 'stopped') { console.error(terminal.error ?? 'The demo ended in ' + terminal.status); process.exitCode = 1; }
        else console.log(json({ event: 'acceptance-demo-stopped', ...terminal }));
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
