import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAcceptanceCatalogRequest } from '../src/acceptance/catalog-api.mjs';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { acceptanceRunDir, createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const ROOT = '/api/acceptance/projects';
const uid = prefix => prefix + '-' + randomUUID();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const put = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const cas = f => { const { generationId, revision } = f.store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const collection = (f, projectId = f.project.id) => ROOT + '/' + projectId + '/browser-source-bindings';
const input = (f, side = f.side, release = f.release) => ({ ...cas(f), runId: f.runId, sourceSide: side, releaseId: release.id });
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const jsonHeaders = { 'Content-Type': 'application/json' };

// Access times are excluded: a permitted read may update atime, never bytes or write metadata.
function tree(root) {
  const result = {};
  function visit(path, key) {
    const stat = fs.lstatSync(path, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false);
    result[key] = { directory: stat.isDirectory(), bytes: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      ...(stat.isFile() ? { sha256: hash(fs.readFileSync(path)) } : {}) };
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name), key ? key + '/' + name : name);
  }
  visit(root, ''); return result;
}
function assertPublic(value, forbiddenStrings = []) {
  assert.equal(Buffer.isBuffer(value), false); assert.equal(value instanceof Map, false);
  assert.notEqual(typeof value, 'function');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert.equal(['plan', 'owner', 'files', 'snapshot', 'preCommitGuard', 'rules', 'steps', 'assertions', 'entryUrl',
      'plannedUrl', 'observedFinalUrl', 'route', 'href', 'maskSelectors'].includes(key), false, 'private/raw key: ' + key);
    assertPublic(child, forbiddenStrings);
  }
  if (typeof value === 'string') for (const text of forbiddenStrings) assert.equal(value.includes(text), false, 'private text: ' + text);
}
function safeError(value, root) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(root), false); assert.equal(/ENOENT|EACCES|node:fs|"stack"|"cause"|"errno"/.test(text), false);
}
async function context(f, targetUrl, name = 'Independent project') {
  const project = (await f.store.createProject({ ...cas(f), name })).project;
  const release = (await f.store.createRelease(project.id, { ...cas(f), label: 'v1', targetUrl })).release;
  return { project, release };
}
async function fixture(t, sample = 'target-unavailable', side = 'baseline') {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-browser-http-'))), root = join(parent, 'acceptance');
  fs.mkdirSync(root);
  const original = join(FIXTURES, sample), manifest = parse(join(original, 'manifest.json')), dir = join(root, manifest.runId);
  fs.cpSync(original, dir, { recursive: true });
  const owner = acquireAcceptanceOwner({ root }), writes = [], emitted = [];
  const store = createAcceptanceCatalogStore({ root, owner, writeAtomic(file, bytes) { writes.push(file); writeAtomicFileSync(file, bytes); } });
  const f = { parent, root, dir, sample, side, runId: manifest.runId, owner, store, writes, emitted, engines: [] };
  const server = createServer(async (req, res) => {
    const json = (response, status, body) => { emitted.push(body); response.writeHead(status, jsonHeaders); response.end(JSON.stringify(body)); };
    if (!await handleAcceptanceCatalogRequest(req, res, new URL(req.url, 'http://fixture'), { catalog: store, json })) json(res, 404, { code: 'FALLTHROUGH' });
  });
  f.base = 'http://127.0.0.1:' + await listen(server);
  f.request = async (path, options = {}) => {
    const response = await fetch(f.base + path, { ...options, signal: AbortSignal.timeout(10000), headers: { ...jsonHeaders, ...options.headers } });
    const text = await response.text(); return { status: response.status, headers: response.headers, value: text ? JSON.parse(text) : null };
  };
  f.post = (path, value) => f.request(path, { method: 'POST', body: JSON.stringify(value) });
  t.after(async () => {
    for (const child of f.engines) if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
    }
    server.closeAllConnections(); await new Promise(done => server.close(done)); owner.release();
    assert.ok(parent.startsWith(fs.realpathSync(tmpdir()) + sep) && parent.includes('heimdall-browser-http-'));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  await store.initialize(); Object.assign(f, await context(f, manifest.plan[side + 'Url'], 'Browser HTTP fixture'));
  writes.length = 0; return f;
}
async function rejectedUnchanged(f, action, status, code) {
  const before = tree(f.root), count = f.writes.length, result = await action();
  assert.equal(result.status, status); assert.equal(result.value.code, code); safeError(result.value, f.parent);
  assert.deepEqual(tree(f.root), before); assert.equal(f.writes.length, count); validateAcceptanceCatalog(f.store.read());
  return result;
}
function reseal(f, mutate) {
  const manifest = parse(join(f.dir, 'manifest.json')), report = parse(join(f.dir, 'report.json'));
  mutate(manifest, report);
  for (const entry of report.evidenceManifest) {
    const path = join(f.dir, entry.file);
    if (fs.existsSync(path)) { const bytes = fs.readFileSync(path); entry.bytes = bytes.length; entry.sha256 = hash(bytes); }
  }
  put(join(f.dir, 'report.json'), report); manifest.reportSha256 = hash(fs.readFileSync(join(f.dir, 'report.json')));
  put(join(f.dir, 'manifest.json'), manifest);
}
function replaceEntry(f, side, entryUrl) {
  reseal(f, (manifest, report) => {
    manifest[side + 'Url'] = manifest.plan[side + 'Url'] = report[side + 'Url'] = entryUrl;
    report.planFingerprint = hash(JSON.stringify(manifest.plan));
  });
}
function assertStoredList(value, id, source) {
  assert.equal(value.viewVersion, 1); assert.equal(value.executionReady, false);
  assert.deepEqual(value.verification, { scope: 'stored-record-only', currentSourceVerified: false });
  assert.equal(value.bindings.length, 1); assert.equal(value.bindings[0].id, id); assert.deepEqual(value.bindings[0].source, source);
  for (const binding of value.bindings) {
    assert.equal(Object.hasOwn(binding, 'preview'), false); assert.equal(Object.hasOwn(binding, 'diagnostics'), false);
    assert.equal(Object.hasOwn(binding, 'sourcePlanDigest'), false); assertPublic(binding);
  }
}

test('four frozen Browser fixtures cross real HTTP/store boundary for every explicit side without changing source facts', async t => {
  for (const [sample, eligible] of [['matrix', ['baseline', 'target']], ['target-unavailable', ['baseline']],
    ['baseline-unavailable', ['target']], ['assertion-failed', []]]) for (const side of ['baseline', 'target']) await t.test(sample + ':' + side, async t => {
    const f = await fixture(t, sample, side), before = f.store.read(), original = tree(f.dir), request = input(f);
    if (!eligible.includes(side)) {
      const result = await rejectedUnchanged(f, () => f.post(collection(f), request), 409, 'SOURCE_NOT_ELIGIBLE');
      assert.equal(result.value.details.reason, 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE'); return;
    }
    const result = await f.post(collection(f), request), value = result.value;
    assert.equal(result.status, 201); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.equal(value.viewVersion, 1);
    assert.equal(value.generationId, before.generationId); assert.equal(value.revision, before.revision + 1);
    assert.equal(value.executionReady, false); assert.equal(value.binding.projectId, f.project.id);
    assert.equal(value.binding.releaseId, f.release.id); assert.equal(value.binding.source.runId, f.runId);
    assert.equal(value.binding.source.side, side); assert.match(value.binding.id, /^ax-[a-f0-9-]{36}$/);
    assert.equal(value.binding.source.sourceMode, 'regression'); assert.equal(value.binding.source.queryPresent, false);
    assert.equal(value.binding.source.entryUrlDisplay, f.release.targetUrl);
    assert.equal(value.event.kind, 'browser-source-bound'); assert.equal(value.event.entityId, value.binding.id);
    assert.equal(value.event.projectId, f.project.id); assert.equal(value.event.revision, value.revision);
    assert.deepEqual(value.diagnostics, { eligible: true, contentMatches: true, issues: [] });
    assert.equal(value.preview.sourceGate, parse(join(f.dir, 'report.json')).gate);
    assert.equal(value.preview.executionReady, false); assert.equal(value.preview.presentation.completeSourceProjection, false);
    assert.ok(value.preview.declaredSlots >= value.preview.observations.length);
    if (sample === 'matrix') assert.ok(value.preview.declaredSlots > value.preview.observations.length);
    for (const observation of value.preview.observations) {
      assert.ok(observation.slot.routeDisplay); assert.equal(typeof observation.slot.queryPresent, 'boolean');
      assert.equal(observation.slot.routeDisplay.endsWith('?[redacted]'), observation.slot.queryPresent);
      for (const [role, evidence] of Object.entries(observation.evidence)) {
        assert.ok(['details', 'screenshot', 'repeat'].includes(role)); assert.deepEqual(Object.keys(evidence).sort(), ['bytes', 'file', 'sha256']);
        assert.equal(typeof evidence.file, 'string'); assert.equal(evidence.file.includes('/'), false);
      }
    }
    const rawQueries = parse(join(f.dir, 'manifest.json')).plan.routes.filter(route => route.includes('?')).map(route => route.split('?')[1]);
    assertPublic(value, [f.parent, ...rawQueries]); assertPublic(f.emitted.at(-1), [f.parent, ...rawQueries]);
    const readBefore = tree(f.root), read = await f.request(collection(f) + '/' + value.binding.id);
    assert.equal(read.status, 200); assert.deepEqual(read.value.binding, value.binding);
    assert.deepEqual(read.value.preview, value.preview); assert.deepEqual(read.value.diagnostics, value.diagnostics);
    assert.equal(Object.hasOwn(read.value, 'event'), false); assertPublic(f.emitted.at(-1), [f.parent]);
    assert.deepEqual(tree(f.root), readBefore); assert.deepEqual(tree(f.dir), original);
    assert.deepEqual(f.store.read().runBindings, {}); assert.deepEqual(f.store.read().candidates, {});
    assert.deepEqual(f.store.read().approvals, {}); assert.deepEqual(f.store.read().selections, {});
  });
});

test('Browser HTTP body is a strict five-field explicit-side contract and rejects malformed or oversized JSON before mutation', async t => {
  const f = await fixture(t), base = input(f), missingSide = { ...base }; delete missingSide.sourceSide;
  for (const value of [missingSide, ...['', 'source', 'BASELINE', null, true].map(sourceSide => ({ ...base, sourceSide })),
    ...['mode', 'source', 'entryUrl', 'url', 'targetUrl', 'projection', 'contentDigest', 'sourceContentDigest', 'preview', 'plan', 'actor', 'bindingId', 'confirmed'].map(key => ({ ...base, [key]: 'injected' })),
    { ...base, expectedRevision: '2' }, { ...base, expectedRevision: -1 }, { ...base, runId: uid('ab') }, { ...base, releaseId: uid('ap') }]) {
    await rejectedUnchanged(f, () => f.post(collection(f), value), 400, 'INVALID_INPUT');
  }
  for (const body of ['', '{bad', '[]', 'null', '"text"', '123']) {
    await rejectedUnchanged(f, () => f.request(collection(f), { method: 'POST', body }), 400, 'INVALID_INPUT');
  }
  await rejectedUnchanged(f, () => f.post(collection(f), { ...base, extra: 'x'.repeat(17_000) }), 413, 'INVALID_INPUT');
});

test('Browser routes strictly reject unknown queries, malformed IDs, trailing slashes, extra segments and wrong methods', async t => {
  const f = await fixture(t), saved = (await f.post(collection(f), input(f))).value, path = collection(f), single = path + '/' + saved.binding.id;
  for (const route of [path, single]) {
    for (const query of ['side=baseline', 'filter=x', 'includePlan=1', 'path=private', 'token=a&token=b', 'token=a&token=a']) {
      await rejectedUnchanged(f, () => f.request(route + '?' + query), 400, 'INVALID_INPUT');
    }
    assert.equal((await f.request(route + '?token=historical-fallback')).status, 200);
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', ...(route === single ? ['POST'] : [])]) {
      const result = await rejectedUnchanged(f, () => f.request(route, { method }), 405, 'METHOD_NOT_ALLOWED');
      assert.equal(result.headers.get('allow'), route === single ? 'GET' : 'GET, POST');
    }
  }
  for (const route of [path + '/', single + '/', single + '/extra', ROOT + '/' + f.project.id + '/browser-bindings']) {
    await rejectedUnchanged(f, () => f.request(route), 404, 'NOT_FOUND');
  }
  for (const route of [path + '/not-an-id', path + '/' + uid('ab'), path + '/' + saved.binding.id.toUpperCase(), ROOT + '/not-an-id/browser-source-bindings']) {
    await rejectedUnchanged(f, () => f.request(route), 400, 'INVALID_INPUT');
  }
  await rejectedUnchanged(f, () => f.request(path + '/' + uid('ax')), 404, 'NOT_FOUND');
  await rejectedUnchanged(f, () => f.request(ROOT + '/' + uid('ap') + '/browser-source-bindings'), 404, 'NOT_FOUND');
  const other = await context(f, f.release.targetUrl);
  await rejectedUnchanged(f, () => f.request(collection(f, other.project.id) + '/' + saved.binding.id), 409, 'PROJECT_MISMATCH');
});

test('ordered duplicate query and sensitive query-key names remain exact internally while Browser HTTP display hides the entire query', async t => {
  const f = await fixture(t, 'baseline-unavailable', 'target'), original = f.release.targetUrl;
  const secretKey = 'SENSITIVE-QUERY-KEY-HTTP', secretValue = 'SENSITIVE-QUERY-VALUE-HTTP';
  const exact = original + '?' + secretKey + '=' + secretValue + '&duplicate=first&duplicate=second';
  replaceEntry(f, 'target', exact);
  for (const targetUrl of [original, new URL(original).origin, exact.replace(secretValue, 'changed'),
    original + '?duplicate=first&duplicate=second&' + secretKey + '=' + secretValue,
    original + '?' + secretKey + '=' + secretValue + '&duplicate=second&duplicate=first']) {
    const release = (await f.store.createRelease(f.project.id, { ...cas(f), label: 'Mismatch', targetUrl })).release;
    const result = await rejectedUnchanged(f, () => f.post(collection(f), input(f, 'target', release)), 409, 'PROJECT_MISMATCH');
    assertPublic(result.value, [secretKey, secretValue]);
  }
  // A selected target control/final observation has a redacted value but a sensitive key.
  const detailFile = join(f.dir, 'route-1-1-desktop-target.json'), details = parse(detailFile);
  const href = '/details?' + secretKey + '=' + secretValue;
  details.snapshot.controls[1].href = href;
  const final = new URL(details.snapshot.url); final.searchParams.set(secretKey, '[redacted]'); details.snapshot.url = final.href;
  put(detailFile, details);
  reseal(f, (_manifest, report) => { report.checks.find(check => check.dimension === 'structure').actual.controls[1].href = href; });
  const release = (await f.store.createRelease(f.project.id, { ...cas(f), label: 'Exact ordered query', targetUrl: exact })).release;
  const result = await f.post(collection(f), input(f, 'target', release)); assert.equal(result.status, 201);
  const value = result.value; assert.equal(f.store.read().browserSourceBindings[value.binding.id].source.entryUrl, exact);
  assert.equal(value.binding.source.entryUrlDisplay, original + '?[redacted]'); assert.equal(value.binding.source.queryPresent, true);
  assert.equal(value.preview.sourceReference.entryUrlDisplay, original + '?[redacted]');
  assert.ok(value.preview.observations.every(observation => observation.observedFinalUrlDisplay.endsWith('?[redacted]')));
  assert.equal(value.preview.observations[0].expected.structure.controls[1].hrefDisplay, '/details?[redacted]');
  assertPublic(value, [secretKey, secretValue, 'duplicate=first', 'duplicate=second', f.parent]);
  assertPublic(f.emitted.at(-1), [secretKey, secretValue, f.parent]);
  for (const route of [collection(f), collection(f) + '/' + value.binding.id]) {
    const read = await f.request(route); assert.equal(read.status, 200); assertPublic(read.value, [secretKey, secretValue, f.parent]);
  }
});

test('independent baseline and legacy target contexts fence both ordering directions over real HTTP', async t => {
  for (const order of ['legacy-first', 'browser-first']) await t.test(order, async t => {
    const f = await fixture(t, 'matrix'), manifest = parse(join(f.dir, 'manifest.json'));
    const baseline = await f.post(collection(f), input(f)); assert.equal(baseline.status, 201);
    const target = await context(f, manifest.plan.targetUrl), targetPath = collection(f, target.project.id);
    const legacyPath = ROOT + '/' + target.project.id + '/run-bindings';
    const legacy = () => f.post(legacyPath, { ...cas(f), runId: f.runId, releaseId: target.release.id });
    const browser = () => f.post(targetPath, input(f, 'target', target.release));
    assert.equal((await (order === 'legacy-first' ? legacy() : browser())).status, 201);
    const other = await context(f, target.release.targetUrl), missing = f.dir + '-retained'; fs.renameSync(f.dir, missing);
    if (order === 'legacy-first') {
      await rejectedUnchanged(f, () => f.post(collection(f, other.project.id), input(f, 'target', other.release)), 409, 'PROJECT_MISMATCH');
    } else {
      await rejectedUnchanged(f, () => f.post(ROOT + '/' + other.project.id + '/run-bindings', { ...cas(f), runId: f.runId, releaseId: other.release.id }), 409, 'PROJECT_MISMATCH');
    }
    fs.renameSync(missing, f.dir);
    assert.equal((await (order === 'legacy-first' ? browser() : legacy())).status, 201);
    const state = f.store.read(); assert.equal(Object.keys(state.browserSourceBindings).length, 2);
    assert.equal(state.runBindings[f.runId].projectId, target.project.id);
    assert.equal(state.browserSourceBindings[baseline.value.binding.id].projectId, f.project.id); validateAcceptanceCatalog(state);
    await rejectedUnchanged(f, () => f.post(collection(f, other.project.id), input(f, 'baseline', other.release)), 409, 'CONTEXT_ALREADY_BOUND');
  });
});

test('collection and project detail remain stored-only and perform zero source file reads after PNG corruption or complete source loss', async t => {
  const f = await fixture(t), saved = (await f.post(collection(f), input(f))).value;
  const png = fs.readdirSync(f.dir).find(name => name.endsWith('.png')); fs.writeFileSync(join(f.dir, png), 'corrupt PNG');
  for (const state of ['corrupt-png', 'missing-source']) {
    if (state === 'missing-source') fs.renameSync(f.dir, f.dir + '-retained');
    const before = tree(f.root), reads = [], originals = {};
    // Observe actual fs calls without substituting the router, store or reader implementation.
    for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync']) {
      originals[name] = fs[name]; fs[name] = function (path, ...args) {
        if (typeof path === 'string' && (resolve(path) === f.dir || resolve(path).startsWith(f.dir + sep))) reads.push({ name, path });
        return originals[name].call(this, path, ...args);
      };
    }
    syncBuiltinESMExports();
    try {
      const list = await f.request(collection(f)); assert.equal(list.status, 200); assertStoredList(list.value, saved.binding.id, saved.binding.source);
      const project = await f.request(ROOT + '/' + f.project.id); assert.equal(project.status, 200);
      assert.deepEqual(project.value.browserSourceBindings, list.value.bindings);
      assert.deepEqual(project.value.browserSourceVerification, list.value.verification); assert.equal(reads.length, 0);
    } finally { for (const [name, original] of Object.entries(originals)) fs[name] = original; syncBuiltinESMExports(); }
    assert.deepEqual(tree(f.root), before);
  }
});

test('single Browser read retains historical binding and emits read-only diagnostics after missing, corrupt or coherently changed sources', async t => {
  for (const change of ['missing', 'corrupt-evidence', 'changed-plan']) await t.test(change, async t => {
    const f = await fixture(t), saved = (await f.post(collection(f), input(f))).value;
    if (change === 'missing') fs.renameSync(f.dir, f.dir + '-retained');
    else if (change === 'corrupt-evidence') fs.writeFileSync(join(f.dir, fs.readdirSync(f.dir).find(name => name.endsWith('.png'))), 'corrupt');
    else reseal(f, (manifest, report) => { manifest.name = manifest.plan.name = report.name = 'Changed historical source'; report.planFingerprint = hash(JSON.stringify(manifest.plan)); });
    const before = tree(f.root), writeCount = f.writes.length;
    const result = await f.request(collection(f) + '/' + saved.binding.id);
    assert.equal(result.status, 200); assert.deepEqual(result.value.binding, saved.binding); assert.equal(result.value.preview, null);
    assert.equal(result.value.executionReady, false);
    assert.equal(result.value.diagnostics.eligible, false); assert.equal(result.value.diagnostics.contentMatches, false);
    assert.deepEqual(result.value.diagnostics.issues.map(issue => issue.code), ['BASELINE_CHANGED']);
    safeError(result.value, f.parent); assertPublic(result.value, [f.parent]);
    assert.equal(f.writes.length, writeCount); assert.deepEqual(tree(f.root), before);
    assert.deepEqual(Object.keys(f.store.read().browserSourceBindings), [saved.binding.id]);
  });
});

test('Browser HTTP CAS races have one winner and preserve safe stale identity without creating another binding', async t => {
  const f = await fixture(t), request = input(f), before = f.store.read();
  const results = await Promise.all([f.post(collection(f), request), f.post(collection(f), request)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const stale = results.find(result => result.status === 409).value;
  assert.equal(stale.code, 'STALE_REVISION'); assert.equal(stale.currentGenerationId, before.generationId); assert.equal(stale.currentRevision, before.revision + 1);
  assert.deepEqual(stale.details, { generationId: before.generationId, revision: before.revision + 1 }); safeError(stale, f.parent);
  assert.equal(Object.keys(f.store.read().browserSourceBindings).length, 1);
  await rejectedUnchanged(f, () => f.post(collection(f), input(f)), 409, 'CONTEXT_ALREADY_BOUND');
});

test('owned single reads and unavailable catalog roots remain safe HTTP 503 rather than source-change 200', async t => {
  for (const change of ['owner-lost', 'catalog-corrupt', 'catalog-invalid-json', 'root-replaced']) await t.test(change, async t => {
    const f = await fixture(t), saved = (await f.post(collection(f), input(f))).value;
    if (change === 'owner-lost') f.owner.release();
    else if (change === 'catalog-corrupt') fs.writeFileSync(join(f.root, 'catalog.json'), '{}');
    else if (change === 'catalog-invalid-json') fs.writeFileSync(join(f.root, 'catalog.json'), '{corrupt');
    else { fs.renameSync(f.root, f.root + '-retained'); fs.mkdirSync(f.root); }
    const before = tree(f.root), count = f.writes.length;
    // The engine, separately tested below, fences every acceptance request.
    // A direct cheap catalog collection is intentionally a stored read without owner admission.
    const paths = change === 'owner-lost' ? [collection(f) + '/' + saved.binding.id] : [collection(f), collection(f) + '/' + saved.binding.id];
    for (const path of paths) {
      const result = await f.request(path); assert.equal(result.status, 503);
      assert.equal(result.value.code, change === 'owner-lost' ? 'ACCEPTANCE_OWNER_LOST' : 'CATALOG_UNAVAILABLE');
      assert.equal(Object.hasOwn(result.value, 'preview'), false); safeError(result.value, f.parent);
    }
    assert.deepEqual(tree(f.root), before); assert.equal(f.writes.length, count);
  });
});

test('legacy Spec API can bind, create/read a candidate, approve, select and cancel alongside Browser history', async t => {
  const f = await fixture(t), browser = await f.post(collection(f), input(f)); assert.equal(browser.status, 201);
  const release = (await f.store.createRelease(f.project.id, { ...cas(f), label: 'Independent Spec', targetUrl: 'http://127.0.0.1:1/spec?old=contract' })).release;
  const plan = normalizeSpecPlan({ mode: 'spec', name: 'Offline Spec HTTP regression', targetUrl: release.targetUrl,
    spec: { approved: false, source: { id: 'REQ-HTTP-SPEC', revision: '1', type: 'manual' },
      checks: [{ id: 'HEALTH', title: 'Health', method: 'GET', path: '/health', severity: 'high', expect: { status: 200 } }] } });
  const run = createAcceptanceRun(plan, { root: f.root });
  finishAcceptanceRun(run.runId, await runSpecAcceptance(plan, { runId: run.runId, outputDir: acceptanceRunDir(run.runId, f.root) }), { root: f.root });
  const path = ROOT + '/' + f.project.id;
  assert.equal((await f.post(path + '/run-bindings', { ...cas(f), runId: run.runId, releaseId: release.id })).status, 201);
  const candidate = await f.post(path + '/baseline-candidates', { ...cas(f), mode: 'spec', sourceRunId: run.runId, sourceSide: 'source' });
  assert.equal(candidate.status, 201); assert.equal(candidate.value.candidate.mode, 'spec'); assert.equal(candidate.value.executionReady, false);
  const read = await f.request(path + '/baseline-candidates/' + candidate.value.candidate.id);
  assert.equal(read.status, 200); assert.equal(read.value.diagnostics.eligible, true);
  const approval = await f.post(path + '/baseline-approvals', { ...cas(f), candidateId: candidate.value.candidate.id,
    contentDigest: candidate.value.candidate.contentDigest, reason: 'Review old Spec contract' }); assert.equal(approval.status, 201);
  const selected = await f.post(path + '/baseline-selections', { ...cas(f), mode: 'spec', approvalId: approval.value.approval.id,
    contentDigest: approval.value.approval.contentDigest, reason: 'Explicit selection' }); assert.equal(selected.status, 201);
  const canceled = await f.post(path + '/baseline-selections', { ...cas(f), mode: 'spec', approvalId: null, contentDigest: null, reason: 'Explicit cancel' });
  assert.equal(canceled.status, 201);
  await rejectedUnchanged(f, () => f.post(path + '/baseline-candidates', { ...cas(f), mode: 'browser', sourceRunId: f.runId, sourceSide: 'baseline' }), 400, 'INVALID_INPUT');
  const detail = await f.request(path); assert.equal(detail.status, 200); assert.equal(detail.value.currentSelections.spec.approvalId, null);
  assert.equal(detail.value.browserSourceBindings[0].id, browser.value.binding.id);
  assert.equal(detail.value.runBindings.find(binding => binding.runId === run.runId).source.mode, 'spec'); validateAcceptanceCatalog(f.store.read());
});

test('real engine authentication protects Browser collection, mutation and detail, preserving owner failures behind authentication', { timeout: 30_000 }, async t => {
  const f = await fixture(t), saved = await f.post(collection(f), input(f)); assert.equal(saved.status, 201);
  const token = 'http-fixture-' + randomUUID(), reservation = createServer(), port = await listen(reservation);
  await new Promise(done => reservation.close(done)); f.owner.release();
  const child = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: CORE, windowsHide: true,
    env: { ...process.env, HEIMDALL_DATA_DIR: f.parent, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token,
      HEIMDALL_JOBS_DB: join(f.parent, 'jobs.db'), HEIMDALL_ENV_FILE: join(f.parent, 'missing.env'), HEIMDALL_CONSOLE_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  f.engines.push(child);
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const base = 'http://127.0.0.1:' + port, request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
    const text = await response.text(); return { status: response.status, headers: response.headers, value: text ? JSON.parse(text) : null };
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
    t.diagnostic('isolated engine output: ' + output);
  });
  const deadline = Date.now() + 15_000;
  while (!output.includes(base)) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail('isolated engine exited: ' + output);
    assert.ok(Date.now() < deadline, 'isolated engine startup: ' + output);
    await new Promise(done => setTimeout(done, 40));
  }
  const single = collection(f) + '/' + saved.value.binding.id, before = tree(f.root);
  for (const path of [collection(f), single]) {
    for (const headers of [{}, { 'x-heimdall-token': 'wrong' }]) {
      const result = await request(path, { headers }); assert.equal(result.status, 401); assert.deepEqual(result.value, { error: 'unauthorized' });
      assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    }
    const authorized = await request(path, { headers: { 'x-heimdall-token': token } }); assert.equal(authorized.status, 200);
    assertPublic(authorized.value, [f.parent, token]);
    assert.equal((await request(path + '?token=' + encodeURIComponent(token))).status, 200);
    assert.equal((await request(path + '?token=' + encodeURIComponent(token) + '&token=' + encodeURIComponent(token))).status, 400);
  }
  const unauthorizedWrite = await request(collection(f), { method: 'POST', headers: jsonHeaders, body: '{}' }); assert.equal(unauthorizedWrite.status, 401);
  const authenticatedWrite = await request(collection(f), { method: 'POST', headers: { ...jsonHeaders, 'x-heimdall-token': token }, body: JSON.stringify(input(f)) });
  assert.equal(authenticatedWrite.status, 409); assert.equal(authenticatedWrite.value.code, 'CONTEXT_ALREADY_BOUND');
  assert.deepEqual(tree(f.root), before);
  // Replacing the owned nonce is an actual owner loss; no replacement owner is invented by the test.
  const lockPath = join(f.root, '.acceptance-owner.json'), lock = parse(lockPath); lock.nonce = '0'.repeat(64); put(lockPath, lock);
  for (const path of [collection(f), single]) {
    const lost = await request(path, { headers: { 'x-heimdall-token': token } }); assert.equal(lost.status, 503); assert.equal(lost.value.code, 'ACCEPTANCE_OWNER_LOST');
    safeError(lost.value, f.parent); assert.equal((await request(path)).status, 401);
  }
});
