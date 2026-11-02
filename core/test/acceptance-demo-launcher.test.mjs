import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseAcceptanceDemoArgs, acceptanceDemoConsoleUrl, acceptanceDemoEngineEnv,
  prepareAcceptanceDemoMetadata, createAcceptanceDemoCompletion, connectAcceptanceDemoEngineChild } from '../scripts/start-acceptance-demo.mjs';

const generationId = 'ag-00000000-0000-0000-0000-000000000001';
const projectId = 'ap-00000000-0000-0000-0000-000000000001';
const fixtureOrigin = 'http://127.0.0.1:34999';

test('completion always resolves a fixed terminal fact and repeated cleanup cannot replace failure or reason', async () => {
  for (const status of ['stopped', 'failed', 'stop-failed']) {
    const completion = createAcceptanceDemoCompletion();
    const terminal = { status, reason: 'first', error: status === 'stopped' ? undefined : 'owned engine failed' };
    const first = completion.finish(terminal); terminal.reason = 'external mutation';
    assert.equal(completion.finish({ status: 'stopped', reason: 'later' }), first);
    assert.equal(await completion.closed, first); assert.equal(first.status, status); assert.equal(first.reason, 'first'); assert.ok(Object.isFrozen(first));
  }
});

function channel() { const value = new EventEmitter(); value.send = () => {}; value.connected = true; return value; }
test('engine child refuses missing or already disconnected IPC before registering engine lifecycle listeners', () => {
  for (const value of [Object.assign(channel(), { send: undefined }), Object.assign(channel(), { connected: false })]) {
    assert.throws(() => connectAcceptanceDemoEngineChild(value, () => {}), /connected launcher IPC/);
    assert.equal(value.listenerCount('message'), 0); assert.equal(value.listenerCount('disconnect'), 0);
  }
});

test('engine child rechecks IPC after installing disconnect listener and refuses a lost connection', () => {
  const value = channel(), once = value.once;
  value.once = function(name, callback) { const result = once.call(this, name, callback); if (name === 'disconnect') this.connected = false; return result; };
  assert.throws(() => connectAcceptanceDemoEngineChild(value, () => {}), /connected launcher IPC/);
  assert.equal(value.listenerCount('message'), 0); assert.equal(value.listenerCount('disconnect'), 0);
});

test('the connected child channel forwards only its exact stop message or a disconnect', () => {
  const value = channel(); let stops = 0;
  connectAcceptanceDemoEngineChild(value, () => { stops++; });
  value.emit('message', { kind: 'other' }); assert.equal(stops, 0);
  value.emit('message', { kind: 'acceptance-demo-stop' }); assert.equal(stops, 1);
  value.emit('disconnect'); assert.equal(stops, 2);
});

test('the child channel detach is repeatable and removes only its owned listeners', () => {
  const value = channel(); let stops = 0, unrelated = 0;
  value.on('message', () => { unrelated++; }); value.on('disconnect', () => { unrelated++; });
  const detach = connectAcceptanceDemoEngineChild(value, () => { stops++; });
  detach(); detach();
  assert.equal(value.listenerCount('message'), 1); assert.equal(value.listenerCount('disconnect'), 1);
  value.emit('message', { kind: 'acceptance-demo-stop' }); value.emit('disconnect');
  assert.equal(stops, 0); assert.equal(unrelated, 2);
});

test('demo options accept a fresh explicit path and reject unknown, duplicate and missing values', () => {
  assert.deepEqual(parseAcceptanceDemoArgs([]), { open: true, help: false });
  assert.deepEqual(parseAcceptanceDemoArgs(['--session-dir', 'demo-session', '--no-open']), { open: false, help: false, sessionDir: resolve('demo-session') });
  assert.equal(parseAcceptanceDemoArgs(['--help']).help, true);
  for (const args of [['--port', '1'], ['--session-dir'], ['--session-dir', '--no-open'], ['--no-open', '--no-open'], ['existing-positional']]) {
    assert.throws(() => parseAcceptanceDemoArgs(args));
  }
});

test('console link contains exactly the two constrained demo parameters and no entity ids', () => {
  const url = new URL(acceptanceDemoConsoleUrl('http://127.0.0.1:35000', fixtureOrigin));
  assert.equal(url.origin, 'http://127.0.0.1:35000'); assert.equal(url.pathname, '/');
  assert.deepEqual([...url.searchParams], [['acceptanceDemo', 'local-fixed-v1'], ['fixtureOrigin', fixtureOrigin]]);
  for (const value of ['https://127.0.0.1:34999', 'http://localhost:34999', 'http://0.0.0.0:34999', 'http://2130706433:34999',
    'http://127.0.0.1:0', 'http://127.0.0.1', fixtureOrigin + '/', fixtureOrigin + '/reference', fixtureOrigin + '?token=secret', 'http://u:p@127.0.0.1:34999', fixtureOrigin + '#x']) {
    assert.throws(() => acceptanceDemoConsoleUrl('http://127.0.0.1:35000', value), undefined, value);
    assert.throws(() => acceptanceDemoConsoleUrl(value, fixtureOrigin), undefined, value);
  }
});

test('child environment pins data, jobs, env settings and loopback while disabling inherited credentials/inference', () => {
  const inherited = { PATH: 'keep', HEIMDALL_DATA_DIR: 'outside', HEIMDALL_JOBS_DB: 'outside.db', HEIMDALL_ENV_FILE: 'outside.env',
    HEIMDALL_TOKEN: 'secret', HEIMDALL_HOST: '0.0.0.0', HEIMDALL_LLM: '1', LLM_API_KEY: 'secret', HEIMDALL_ALLOWED_HOSTS: '*', HEIMDALL_TRUSTED_HOSTS: '*' };
  const result = acceptanceDemoEngineEnv(inherited, { dataDir: 'new-runtime', consoleDir: 'console-dist', engineOrigin: 'http://127.0.0.1:35000' });
  assert.equal(result.PATH, 'keep'); assert.equal(result.HEIMDALL_DATA_DIR, resolve('new-runtime'));
  assert.equal(result.HEIMDALL_JOBS_DB, join(resolve('new-runtime'), 'jobs.db')); assert.equal(result.HEIMDALL_ENV_FILE, join(resolve('new-runtime'), '.env'));
  assert.equal(result.HEIMDALL_CONSOLE_DIR, resolve('console-dist')); assert.equal(result.HEIMDALL_PORT, '35000');
  assert.equal(result.HEIMDALL_HOST, '127.0.0.1'); assert.equal(result.HEIMDALL_TOKEN, ''); assert.equal(result.HEIMDALL_LLM, '0'); assert.equal(result.LLM_API_KEY, '');
  assert.equal(result.HEIMDALL_ALLOWED_HOSTS, ''); assert.equal(result.HEIMDALL_TRUSTED_HOSTS, '');
  assert.equal(inherited.HEIMDALL_LLM, '1'); assert.equal(inherited.LLM_API_KEY, 'secret');
});

function metadataTransport(mutate = () => {}) {
  const state = { schemaVersion: 4, generationId, revision: 0, projects: [], runBindings: [], releases: [], events: [],
    candidates: [], approvals: [], selections: [], browserSourceBindings: [], browserCandidates: [] };
  const calls = [];
  const request = async (path, body, status) => {
    calls.push({ path, body, status }); mutate(state, calls);
    if (body === undefined) return structuredClone(path.endsWith(projectId) ? { ...state, project: state.projects[0] } : state);
    assert.equal(status, 201); assert.equal(body.expectedGenerationId, generationId); assert.equal(body.expectedRevision, state.revision);
    state.revision++;
    if (path === '/api/acceptance/projects') {
      const project = { id: projectId, name: body.name, createdAt: '2026-10-18T00:00:00.000Z' }; state.projects.push(project); state.events.push({ kind: 'project-created' });
      return { generationId, revision: state.revision, project };
    }
    assert.equal(path, '/api/acceptance/projects/' + projectId + '/releases');
    const release = { id: 'ar-00000000-0000-0000-0000-' + String(state.revision).padStart(12, '0'), projectId, label: body.label, targetUrl: body.targetUrl, createdAt: '2026-10-18T00:00:00.000Z' };
    state.releases.push(release); state.events.push({ kind: 'release-created' }); return { generationId, revision: state.revision, release };
  };
  return { request, calls, state };
}

test('setup uses only five ordinary metadata POSTs with fresh CAS and reads back an empty business context', async () => {
  const transport = metadataTransport();
  const metadata = await prepareAcceptanceDemoMetadata(transport.request, fixtureOrigin, generationId);
  assert.equal(metadata.revision, 5); assert.equal(metadata.project.id, projectId);
  assert.deepEqual(metadata.releases.map(item => [item.label, item.targetUrl]), [['参考来源', fixtureOrigin + '/reference'], ['已知缺陷', fixtureOrigin + '/bug'], ['部分修复', fixtureOrigin + '/partial'], ['完全修复', fixtureOrigin + '/fixed']]);
  const posts = transport.calls.filter(call => call.body !== undefined);
  assert.equal(posts.length, 5); assert.deepEqual(posts.map(call => call.body.expectedRevision), [0, 1, 2, 3, 4]);
  assert.ok(transport.calls.every(call => /^\/api\/acceptance\/projects(?:\/ap-[a-f0-9-]+(?:\/releases)?)?$/.test(call.path)));
  assert.equal(transport.calls.filter(call => call.body === undefined).length, 6);
});

test('setup refuses legacy, reused or changed catalog identity before creating a project', async () => {
  for (const mutation of [state => { state.schemaVersion = 3; }, state => { state.generationId = 'other'; }, state => { state.revision = 1; },
    state => { state.projects.push({ id: projectId }); }, state => { state.runBindings.push({ runId: 'old' }); }]) {
    const transport = metadataTransport(mutation);
    await assert.rejects(prepareAcceptanceDemoMetadata(transport.request, fixtureOrigin, generationId));
    assert.equal(transport.calls.filter(call => call.body !== undefined).length, 0);
  }
});

test('setup stops after concurrent catalog changes and never retries a metadata write automatically', async () => {
  const transport = metadataTransport((state, calls) => { if (calls.length === 3) state.revision += 1; });
  await assert.rejects(prepareAcceptanceDemoMetadata(transport.request, fixtureOrigin, generationId), /changed/);
  assert.equal(transport.calls.filter(call => call.body !== undefined).length, 1);
  assert.equal(transport.state.releases.length, 0);
});

test('setup rejects readback with any precreated business record', async () => {
  for (const key of ['candidates', 'approvals', 'selections', 'browserSourceBindings', 'browserCandidates']) {
    const transport = metadataTransport((state, calls) => { if (calls.at(-1).path.endsWith(projectId)) state[key] = [{ id: 'unexpected' }]; });
    await assert.rejects(prepareAcceptanceDemoMetadata(transport.request, fixtureOrigin, generationId), /readback/);
  }
});
