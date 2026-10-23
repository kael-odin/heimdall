import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAcceptanceCatalogRequest, acceptanceCatalogError } from '../src/acceptance/catalog-api.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';

const projectId = 'ap-11111111-1111-1111-1111-111111111111';
const releaseId = 'ar-22222222-2222-2222-2222-222222222222';
const generationId = 'ag-33333333-3333-3333-3333-333333333333';
const runId = 'ac-44444444-4444-4444-4444-444444444444';
const project = { id: projectId, name: 'Test project' };
function fakeCatalog(overrides = {}) {
  const value = { schemaVersion: 1, generationId, revision: 4, projects: { [projectId]: project },
    releases: { [releaseId]: { id: releaseId, projectId, label: 'v1' } },
    runBindings: { [runId]: { runId, projectId, releaseId } }, events: [{ projectId, kind: 'run-bound' }] };
  return { read: () => value, readRunReference: () => ({ source: { runId }, diagnostics: { evidenceVerified: false } }), ...overrides };
}
async function serving(catalog, fn) {
  const server = createServer(async (req, res) => {
    const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    const handled = await handleAcceptanceCatalogRequest(req, res, new URL(req.url, 'http://fixture'), { catalog, json });
    if (!handled) json(res, 404, { code: 'FALLTHROUGH' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const headers = { 'Content-Type': 'application/json' };

test('catalog reads expose global bindings, generation and project source diagnostics', () => serving(fakeCatalog(), async base => {
  const response = await fetch(base + '/api/acceptance/projects');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const value = await response.json();
  assert.equal(value.generationId, generationId);
  assert.equal(value.runBindings[0].projectName, 'Test project');
  assert.equal(value.runBindings[0].releaseLabel, 'v1');
  const detail = await (await fetch(base + '/api/acceptance/projects/' + projectId)).json();
  assert.equal(detail.project.id, projectId);
  assert.equal(detail.runBindings[0].source.runId, runId);
  assert.equal(detail.runBindings[0].diagnostics.evidenceVerified, false);
  assert.equal(detail.events.length, 1);
}));

test('catalog routes reject bad query, IDs, methods and malformed JSON before mutation', () => {
  let calls = 0;
  return serving(fakeCatalog({ createProject: async () => { calls++; return {}; } }), async base => {
    for (const path of ['/api/acceptance/projects?unknown=1', '/api/acceptance/projects?token=a&token=b', '/api/acceptance/projects/not-an-id']) {
      const response = await fetch(base + path); assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_INPUT');
    }
    assert.equal((await fetch(base + '/api/acceptance/projects/' + projectId, { method: 'POST', headers, body: '{}' })).status, 405);
    assert.equal((await fetch(base + '/api/acceptance/projects', { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(base + '/api/acceptance/projects/' + projectId + '/releases')).status, 405);
    assert.equal((await fetch(base + '/api/acceptance/projects/' + projectId + '/approvals', { method: 'POST', headers, body: '{}' })).status, 404);
    for (const body of ['{bad', '', '[]', 'null', '"text"']) assert.equal((await fetch(base + '/api/acceptance/projects', { method: 'POST', headers, body })).status, 400);
    assert.equal((await fetch(base + '/api/acceptance/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(17000) }) })).status, 413);
    assert.equal(calls, 0);
  });
});

test('project/release/binding writes preserve the exact structured CAS input and response', () => {
  const calls = [];
  const catalog = fakeCatalog(Object.fromEntries(['createProject', 'createRelease', 'bindRun'].map(method => [method, async (...args) => {
    calls.push({ method, args }); return { generationId, revision: 5, event: { kind: method } };
  }])));
  return serving(catalog, async base => {
    const input = { expectedGenerationId: generationId, expectedRevision: 4, name: 'new' };
    for (const suffix of ['', '/' + projectId + '/releases', '/' + projectId + '/run-bindings']) {
      const response = await fetch(base + '/api/acceptance/projects' + suffix, { method: 'POST', headers, body: JSON.stringify(input) });
      assert.equal(response.status, 201); assert.equal((await response.json()).generationId, generationId);
    }
    assert.deepEqual(calls.map(call => call.method), ['createProject', 'createRelease', 'bindRun']);
    assert.deepEqual(calls[0].args, [input]);
    assert.deepEqual(calls[1].args, [projectId, input]);
    assert.deepEqual(calls[2].args, [projectId, input]);
  });
});

test('CAS errors preserve safe current identity while IO errors never expose disk paths', () => {
  assert.deepEqual(acceptanceCatalogError({ code: 'STALE_REVISION', status: 409, message: 'C:\\private\\catalog.json', currentGenerationId: generationId, currentRevision: 7 }), {
    status: 409, payload: { code: 'STALE_REVISION', error: '目录已更新，请刷新并重新核对后操作。', currentGenerationId: generationId, currentRevision: 7 },
  });
  return serving(fakeCatalog({ createProject: async () => { throw Object.assign(new Error('C:\\private\\catalog.json'), { code: 'EACCES', status: 500 }); } }), async base => {
    const response = await fetch(base + '/api/acceptance/projects', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 503);
    const value = await response.json(); assert.equal(value.code, 'CATALOG_UNAVAILABLE'); assert.equal(JSON.stringify(value).includes('private'), false);
  });
});

test('missing source retains the binding with explicit unverified diagnostics', () => serving(fakeCatalog({ readRunReference: () => { throw new Error('/private/missing'); } }), async base => {
  const response = await fetch(base + '/api/acceptance/projects/' + projectId);
  const value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.runBindings[0].runId, runId);
  assert.equal(value.runBindings[0].diagnostics.manifestValid, false);
  assert.equal(value.runBindings[0].diagnostics.evidenceVerified, false);
  assert.equal(JSON.stringify(value).includes('/private'), false);
}));

test('real catalog HTTP mutations preserve strict fields and single-winner double CAS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-catalog-http-'));
  const owner = acquireAcceptanceOwner({ root });
  try {
    const catalog = createAcceptanceCatalogStore({ root, owner });
    await catalog.initialize();
    await serving(catalog, async base => {
      const call = async (suffix, value) => {
        const response = await fetch(base + '/api/acceptance/projects' + suffix, { method: 'POST', headers, body: JSON.stringify(value) });
        return { status: response.status, value: await response.json() };
      };
      const empty = await (await fetch(base + '/api/acceptance/projects')).json();
      const created = await call('', { name: 'Real store', expectedGenerationId: empty.generationId, expectedRevision: empty.revision });
      assert.equal(created.status, 201);
      const id = created.value.project.id;
      const version = { expectedGenerationId: created.value.generationId, expectedRevision: created.value.revision };
      const invalid = await call('', { ...version, name: 'Not allowed', approved: true });
      assert.equal(invalid.status, 400); assert.equal(invalid.value.code, 'INVALID_INPUT');
      const requests = await Promise.all(['v1', 'v2'].map(label => call('/' + id + '/releases', { ...version, label, targetUrl: 'http://127.0.0.1:39876/app?x=1' })));
      assert.deepEqual(requests.map(item => item.status).sort(), [201, 409]);
      const stale = requests.find(item => item.status === 409).value;
      assert.equal(stale.code, 'STALE_REVISION');
      assert.equal(stale.currentGenerationId, version.expectedGenerationId);
      assert.equal(stale.currentRevision, version.expectedRevision + 1);
      assert.deepEqual(stale.details, { generationId: stale.currentGenerationId, revision: stale.currentRevision });
      const detail = await (await fetch(base + '/api/acceptance/projects/' + id)).json();
      assert.equal(detail.releases.length, 1); assert.equal(detail.events.length, 2);
    });
  } finally { owner.release(); rmSync(root, { recursive: true, force: true }); }
});
