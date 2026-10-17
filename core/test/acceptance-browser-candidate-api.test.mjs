/** Real local HTTP/store tests over frozen captured material; no Browser or live target. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceCatalogError, handleAcceptanceCatalogRequest } from '../src/acceptance/catalog-api.mjs';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { organizedHash } from './fixtures/acceptance-browser-organized-candidate.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const ROOT = '/api/acceptance/projects';
const uid = prefix => prefix + '-' + randomUUID();
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonHeaders = { 'Content-Type': 'application/json' };
const cas = f => { const value = f.store.read(); return { expectedGenerationId: value.generationId, expectedRevision: value.revision }; };
const projectPath = f => ROOT + '/' + f.project.id;
const collectionPath = f => projectPath(f) + '/browser-baseline-candidates';
const previewPath = f => projectPath(f) + '/browser-source-bindings/' + f.binding.id + '/candidate-preview';
const candidatePath = (f, id = f.candidate.id) => collectionPath(f) + '/' + id;
const screenshot = full => full.review.selectedEvidence[0].roles.screenshot;
const evidencePath = (base, metadata, digest) => base + '/evidence/' + metadata.file + '?expectedContentDigest=' + digest;
const requestBody = (f, full) => ({ ...cas(f), sourceBindingId: f.binding.id, contentDigest: full.contentDigest });
const catalogBytes = f => ['catalog.json', 'catalog.previous.json'].map(file => fs.existsSync(join(f.root, file)) ? fs.readFileSync(join(f.root, file)) : null);

function tree(root) {
  const result = {};
  const walk = (file, name) => {
    const stat = fs.lstatSync(file, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false);
    result[name] = { directory: stat.isDirectory(), bytes: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(stat.isFile() ? { sha256: hash(fs.readFileSync(file)) } : {}) };
    if (stat.isDirectory()) for (const entry of fs.readdirSync(file).sort()) walk(join(file, entry), name ? name + '/' + entry : entry);
  };
  walk(root, ''); return result;
}
function safeError(value, parent = '') {
  const text = JSON.stringify(value);
  if (parent) assert.equal(text.includes(parent), false);
  assert.equal(/ENOENT|EACCES|node:fs|"stack"|"cause"|"errno"/.test(text), false);
}
function noPrivate(value) {
  assert.equal(Buffer.isBuffer(value), false); assert.equal(value instanceof Map, false); assert.notEqual(typeof value, 'function');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert.equal(['files', 'owner', 'snapshot', 'preCommitGuard', 'responseGuard'].includes(key), false, key); noPrivate(child);
  }
}
function secureHeaders(result) {
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
}
async function http(t, catalog) {
  const emitted = [];
  const server = createServer(async (req, res) => {
    const json = (response, status, value) => { emitted.push(value); response.writeHead(status, jsonHeaders); response.end(JSON.stringify(value)); };
    if (!await handleAcceptanceCatalogRequest(req, res, new URL(req.url, 'http://fixture'), { catalog, json })) json(res, 404, { code: 'FALLTHROUGH' });
  });
  const port = await new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const base = 'http://127.0.0.1:' + port;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15000), headers: { ...jsonHeaders, ...options.headers } });
    const bytes = Buffer.from(await response.arrayBuffer()), type = response.headers.get('content-type') ?? '';
    return { status: response.status, headers: response.headers, bytes,
      value: type.includes('application/json') && bytes.length ? JSON.parse(bytes.toString('utf8')) : null };
  };
  return { request, post: (path, value) => request(path, { method: 'POST', body: JSON.stringify(value) }), emitted };
}
async function fixture(t, { sample = 'target-unavailable', side = 'baseline', schema = 4 } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-browser-candidate-http-'))), root = join(parent, 'acceptance');
  fs.mkdirSync(root);
  const original = join(FIXTURES, sample), manifest = parse(join(original, 'manifest.json')), dir = join(root, manifest.runId);
  fs.cpSync(original, dir, { recursive: true });
  const owner = acquireAcceptanceOwner({ root }), writes = [];
  const store = createAcceptanceCatalogStore({ root, owner, writeAtomic(file, bytes) { writes.push(file); writeAtomicFileSync(file, bytes); } });
  const f = { parent, root, dir, manifest, store, owner, writes, side, runId: manifest.runId };
  t.after(() => {
    owner.release();
    assert.ok(parent.startsWith(fs.realpathSync(tmpdir()) + sep) && parent.includes('heimdall-browser-candidate-http-'));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  await store.initialize({ createSchemaVersion: schema });
  f.project = (await store.createProject({ ...cas(f), name: 'Browser HTTP full review <script>fixture</script>' })).project;
  f.release = (await store.createRelease(f.project.id, { ...cas(f), label: 'captured fixture', targetUrl: manifest.plan[side + 'Url'], buildRef: 'http-review-v1' })).release;
  Object.assign(f, await http(t, store));
  const binding = await f.post(projectPath(f) + '/browser-source-bindings', { ...cas(f), runId: f.runId, sourceSide: side, releaseId: f.release.id });
  assert.equal(binding.status, 201);
  f.binding = store.read().browserSourceBindings[binding.value.binding.id];
  writes.length = 0; return f;
}
async function rejected(f, action, status, code) {
  const before = catalogBytes(f), count = f.writes.length, result = await action();
  assert.equal(result.status, status); assert.equal(result.value.code, code); safeError(result.value, f.parent); secureHeaders(result);
  assert.deepEqual(catalogBytes(f), before); assert.equal(f.writes.length, count); validateAcceptanceCatalog(f.store.read());
  return result;
}
async function save(f) {
  const preview = await f.request(previewPath(f)); assert.equal(preview.status, 200);
  const saved = await f.post(collectionPath(f), requestBody(f, preview.value)); assert.equal(saved.status, 201);
  f.candidate = saved.value.candidate; return { full: preview.value, saved: saved.value };
}

test('both sides cross real HTTP full preview, save, stored collection/detail and selected PNG with independent organized digests', async t => {
  for (const side of ['baseline', 'target']) await t.test(side, async t => {
    const f = await fixture(t, { sample: 'matrix', side }), original = tree(f.dir), before = tree(f.root), initial = f.store.read();
    const preview = await f.request(previewPath(f)), full = preview.value;
    assert.equal(preview.status, 200); secureHeaders(preview); noPrivate(full);
    assert.deepEqual(tree(f.root), before); assert.equal(f.writes.length, 0);
    assert.equal(full.generationId, initial.generationId); assert.equal(full.revision, initial.revision);
    assert.equal(Object.hasOwn(full, 'candidate'), false); assert.equal(Object.hasOwn(full, 'event'), false);
    assert.equal(full.presentation.completeSourceProjection, true); assert.equal(full.executionReady, false);
    assert.deepEqual(full.organizationContext, { project: f.project, release: f.release, sourceBinding: f.binding });
    assert.equal(full.organizationContextDigest, organizedHash('organization-context', full.organizationContext));
    assert.equal(full.contentDigest, organizedHash('content', full.candidateContent));
    assert.equal(full.sourceProjection.source.side, side); assert.equal(full.review.sourceGate, 'failed');
    assert.deepEqual(full.review.sourcePlan.routes, ['/visual-shift?revision=one', '/identical?revision=two']);
    assert.equal(full.review.rules.length, full.review.declaredSlots); assert.equal(full.review.selectedOracles.length, 8);
    const saved = await f.post(collectionPath(f), requestBody(f, full));
    assert.equal(saved.status, 201); secureHeaders(saved); noPrivate(saved.value); f.candidate = saved.value.candidate;
    assert.match(f.candidate.id, /^bc-[a-f0-9-]{36}$/); assert.equal(saved.value.contentDigest, full.contentDigest);
    assert.equal(saved.value.revision, initial.revision + 1); assert.equal(saved.value.generationId, initial.generationId);
    assert.equal(saved.value.event.kind, 'browser-candidate-created'); assert.equal(saved.value.event.entityId, f.candidate.id);
    assert.equal(saved.value.event.revision, saved.value.revision); assert.equal(saved.value.executionReady, false);
    assert.deepEqual(saved.value.review, full.review); assert.deepEqual(tree(f.dir), original);
    const persisted = tree(f.root), writeCount = f.writes.length;
    const list = await f.request(collectionPath(f)); assert.equal(list.status, 200); secureHeaders(list);
    assert.deepEqual(list.value.browserCandidates, [f.candidate]); assert.equal(Object.keys(list.value.browserCandidates[0]).length, 11);
    assert.deepEqual(list.value.verification, { scope: 'stored-candidate-metadata', currentSourceVerified: false });
    assert.deepEqual(list.value.browserCandidateSupport, { available: true, requiredSchemaVersion: 4 });
    assert.equal(list.value.executionReady, false); assert.equal(JSON.stringify(list.value).includes(f.release.targetUrl), false);
    const detail = await f.request(candidatePath(f)); assert.equal(detail.status, 200); secureHeaders(detail); noPrivate(detail.value);
    assert.deepEqual(detail.value.candidate, f.candidate); assert.deepEqual(detail.value.review, full.review);
    assert.equal(detail.value.contentDigest, full.contentDigest); assert.equal(detail.value.diagnostics.contentMatches, true);
    const selected = [...new Map(full.review.selectedEvidence.flatMap(row => [row.roles.screenshot, row.roles.repeat]).map(row => [row.file, row])).values()];
    for (const metadata of [selected[0], selected.at(-1)]) for (const base of [previewPath(f), candidatePath(f)]) {
      const image = await f.request(evidencePath(base, metadata, full.contentDigest));
      assert.equal(image.status, 200); secureHeaders(image); assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal(image.headers.get('content-length'), String(metadata.bytes)); assert.equal(image.headers.get('x-content-sha256'), metadata.sha256);
      assert.equal(hash(image.bytes), metadata.sha256); assert.deepEqual(image.bytes, fs.readFileSync(join(f.dir, metadata.file)));
      assert.equal(image.value, null);
    }
    assert.equal(f.writes.length, writeCount); assert.deepEqual(tree(f.root), persisted); assert.deepEqual(tree(f.dir), original);
  });
});

test('schema3 dedicated preview, save, collection, detail and both PNG routes require explicit Schema4 maintenance', async t => {
  const f = await fixture(t, { schema: 3 }), candidateId = uid('bc'), file = fs.readdirSync(f.dir).find(name => name.endsWith('.png'));
  fs.renameSync(f.dir, f.dir + '-retained');
  const before = tree(f.root), digest = 'a'.repeat(64);
  for (const path of [collectionPath(f), previewPath(f), candidatePath(f, candidateId),
    evidencePath(previewPath(f), { file }, digest), evidencePath(candidatePath(f, candidateId), { file }, digest)]) {
    const result = await rejected(f, () => f.request(path), 409, 'CATALOG_MIGRATION_REQUIRED');
    assert.deepEqual(result.value.details, { reason: 'SCHEMA4_REQUIRED' });
  }
  await rejected(f, () => f.post(collectionPath(f), { ...cas(f), sourceBindingId: f.binding.id, contentDigest: digest }), 409, 'CATALOG_MIGRATION_REQUIRED');
  const project = await f.request(projectPath(f)); assert.equal(project.status, 200);
  assert.deepEqual(project.value.browserCandidates, []); assert.deepEqual(project.value.browserCandidateSupport, { available: false, requiredSchemaVersion: 4 });
  assert.equal(f.store.read().schemaVersion, 3); assert.deepEqual(tree(f.root), before); assert.equal(f.writes.length, 0);
});

test('candidate routes enforce methods and Allow, query cardinality, exact identifiers and route shape', async t => {
  const f = await fixture(t), { full } = await save(f), before = tree(f.dir), image = screenshot(full);
  const paths = [collectionPath(f), previewPath(f), candidatePath(f), evidencePath(previewPath(f), image, full.contentDigest), evidencePath(candidatePath(f), image, full.contentDigest)];
  for (const path of paths) {
    const isImage = path.includes('/evidence/'), append = query => path + (path.includes('?') ? '&' : '?') + query;
    for (const query of ['unknown=value', 'token=first&token=second', 'token=same&token=same']) {
      await rejected(f, () => f.request(append(query)), 400, 'INVALID_INPUT');
    }
    if (!isImage) await rejected(f, () => f.request(append('expectedContentDigest=' + full.contentDigest)), 400, 'INVALID_INPUT');
    assert.equal((await f.request(append('token=historical-fallback'))).status, 200);
    const allow = path === collectionPath(f) ? 'GET, POST' : 'GET';
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', ...(allow === 'GET' ? ['POST'] : [])]) {
      const result = await rejected(f, () => f.request(path, { method }), 405, 'METHOD_NOT_ALLOWED'); assert.equal(result.headers.get('allow'), allow);
    }
    const head = await f.request(path, { method: 'HEAD' }); assert.equal(head.status, 405); assert.equal(head.headers.get('allow'), allow);
  }
  for (const base of [previewPath(f), candidatePath(f)]) {
    const raw = base + '/evidence/' + image.file;
    for (const query of ['', '?token=only', '?expectedContentDigest=', '?expectedContentDigest=' + 'A'.repeat(64),
      '?expectedContentDigest=' + 'g'.repeat(64), '?expectedContentDigest=' + full.contentDigest + '&expectedContentDigest=' + full.contentDigest]) {
      await rejected(f, () => f.request(raw + query), 400, 'INVALID_INPUT');
    }
    await rejected(f, () => f.request(evidencePath(base, image, '0'.repeat(64))), 409, 'BASELINE_CHANGED');
  }
  // An empty candidate ID is invalid input; unsupported longer route shapes are absent.
  await rejected(f, () => f.request(collectionPath(f) + '/'), 400, 'INVALID_INPUT');
  for (const path of [previewPath(f) + '/', candidatePath(f) + '/extra', previewPath(f) + '/wrong/evidence/a.png']) {
    await rejected(f, () => f.request(path), 404, 'NOT_FOUND');
  }
  for (const path of [collectionPath(f) + '/not-an-id', collectionPath(f) + '/' + uid('ax'),
    projectPath(f) + '/browser-source-bindings/' + uid('bc') + '/candidate-preview', ROOT + '/not-an-id/browser-baseline-candidates']) {
    await rejected(f, () => f.request(path), 400, 'INVALID_INPUT');
  }
  await rejected(f, () => f.request(candidatePath(f, uid('bc'))), 404, 'NOT_FOUND');
  assert.deepEqual(tree(f.dir), before);
});

test('PNG endpoints refuse encoded filenames, details JSON and actual unselected/opposite/diff PNGs', async t => {
  const f = await fixture(t, { sample: 'matrix' }), { full } = await save(f), before = tree(f.root), chosen = screenshot(full);
  const selected = new Set(full.review.selectedEvidence.flatMap(row => [row.roles.screenshot.file, row.roles.repeat.file]));
  const unselected = parse(join(f.dir, 'report.json')).evidenceManifest.filter(row => row.file.endsWith('.png') && !selected.has(row.file));
  assert.ok(unselected.some(row => row.file.includes('target'))); assert.ok(unselected.some(row => row.file.includes('diff')));
  const details = full.review.selectedEvidence[0].roles.details.file;
  for (const base of [previewPath(f), candidatePath(f)]) {
    for (const file of ['%' + chosen.file.charCodeAt(0).toString(16) + chosen.file.slice(1), '%2e%2e%2f' + chosen.file,
      chosen.file + '%00', chosen.file + '%3Fprivate=1', details, 'x/y.png', 'x%5cy.png']) {
      const result = await f.request(base + '/evidence/' + file + '?expectedContentDigest=' + full.contentDigest);
      // Query validation rejects an invalid evidence route before the route fallback.
      assert.equal(result.status, 400, file); assert.equal(result.headers.get('content-type'), 'application/json');
      assert.equal(result.value.code, 'INVALID_INPUT'); safeError(result.value, f.parent); secureHeaders(result);
    }
    for (const metadata of [unselected.find(row => row.file.includes('target')), unselected.find(row => row.file.includes('diff')), { file: 'unknown.png' }]) {
      const result = await rejected(f, () => f.request(evidencePath(base, metadata, full.contentDigest)), 404, 'NOT_FOUND');
      assert.equal(result.headers.get('content-type'), 'application/json');
    }
  }
  assert.deepEqual(tree(f.root), before);
});

test('missing, corrupt and coherently changed sources preserve stored HTTP history and return JSON 409 for PNGs', async t => {
  for (const change of ['missing', 'corrupt', 'coherent-plan-change']) await t.test(change, async t => {
    const f = await fixture(t), { full } = await save(f), image = screenshot(full);
    if (change === 'missing') fs.renameSync(f.dir, f.dir + '-retained');
    else if (change === 'corrupt') fs.appendFileSync(join(f.dir, image.file), 'changed');
    else {
      const manifest = parse(join(f.dir, 'manifest.json')), report = parse(join(f.dir, 'report.json'));
      manifest.name = manifest.plan.name = report.name = 'Coherently changed source'; report.planFingerprint = hash(JSON.stringify(manifest.plan));
      fs.writeFileSync(join(f.dir, 'report.json'), JSON.stringify(report, null, 2) + '\n'); manifest.reportSha256 = hash(fs.readFileSync(join(f.dir, 'report.json')));
      fs.writeFileSync(join(f.dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    const before = tree(f.root), count = f.writes.length;
    const list = await f.request(collectionPath(f)); assert.equal(list.status, 200); assert.deepEqual(list.value.browserCandidates, [f.candidate]);
    assert.equal(list.value.verification.currentSourceVerified, false);
    const detail = await f.request(candidatePath(f)); assert.equal(detail.status, 200); secureHeaders(detail);
    assert.deepEqual(detail.value.candidate, f.candidate); assert.equal(detail.value.review, null); assert.equal(detail.value.executionReady, false);
    assert.equal(detail.value.diagnostics.eligible, false); assert.equal(detail.value.diagnostics.contentMatches, false);
    assert.equal(Object.hasOwn(detail.value, 'sourceProjection'), false); assert.equal(Object.hasOwn(detail.value, 'organizationContext'), false);
    safeError(detail.value, f.parent);
    await rejected(f, () => f.request(previewPath(f)), 409, 'BASELINE_CHANGED');
    for (const base of [previewPath(f), candidatePath(f)]) {
      const result = await rejected(f, () => f.request(evidencePath(base, image, full.contentDigest)), 409, 'BASELINE_CHANGED');
      assert.equal(result.headers.get('content-type'), 'application/json'); assert.equal(result.headers.has('x-content-sha256'), false);
    }
    const duplicate = await rejected(f, () => f.post(collectionPath(f), requestBody(f, full)), 409, 'CANDIDATE_ALREADY_EXISTS');
    assert.deepEqual(duplicate.value.details, { existingCandidateId: f.candidate.id });
    assert.deepEqual(tree(f.root), before); assert.equal(f.writes.length, count); assert.equal(Object.keys(f.store.read().browserCandidates).length, 1);
  });
});

test('candidate POST checks strict fields, malformed JSON and exact 16 KiB body boundary before any mutation', async t => {
  const f = await fixture(t), full = (await f.request(previewPath(f))).value, input = requestBody(f, full);
  for (const key of Object.keys(input)) {
    const value = { ...input }; delete value[key]; await rejected(f, () => f.post(collectionPath(f), value), 400, 'INVALID_INPUT');
  }
  for (const extra of [{ mode: 'browser' }, { candidateContractVersion: 1 }, { candidate: {} }, { contentDigest: 'A'.repeat(64) },
    { sourceBindingId: f.runId }, { expectedRevision: String(input.expectedRevision) }, { expectedGenerationId: uid('ap') }]) {
    await rejected(f, () => f.post(collectionPath(f), { ...input, ...extra }), 400, 'INVALID_INPUT');
  }
  for (const body of ['', '{bad', '[]', 'null', '123', '"string"']) {
    await rejected(f, () => f.request(collectionPath(f), { method: 'POST', body }), 400, 'INVALID_INPUT');
  }
  const serialized = JSON.stringify(input), atLimit = serialized + ' '.repeat(16 * 1024 - Buffer.byteLength(serialized));
  assert.equal(Buffer.byteLength(atLimit), 16 * 1024);
  await rejected(f, () => f.request(collectionPath(f), { method: 'POST', body: atLimit + ' ' }), 413, 'INVALID_INPUT');
  const accepted = await f.request(collectionPath(f), { method: 'POST', body: atLimit });
  assert.equal(accepted.status, 201); assert.equal(accepted.value.candidate.contentDigest, full.contentDigest);
  assert.equal(Object.keys(f.store.read().browserCandidates).length, 1);
});

test('duplicate candidate errors expose only a safe bc ID and safe current lineage, including over real HTTP serialization', async t => {
  const safeId = uid('bc'), generationId = uid('ag'), projectId = uid('ap');
  for (const value of [safeId, safeId.toUpperCase(), uid('ax'), '../private/path', 'https://private/?token=secret', 12, null, { toString() { throw new Error('must not coerce'); } }]) {
    const cause = Object.assign(new Error('secret filesystem message'), { code: 'CANDIDATE_ALREADY_EXISTS', status: 409,
      details: { existingCandidateId: value, generationId, revision: 7, reason: 'SAFE_REASON', limit: 'browserCandidates', private: 'secret', path: 'C:\\private' } });
    const expected = { generationId, revision: 7, reason: 'SAFE_REASON', limit: 'browserCandidates', ...(value === safeId ? { existingCandidateId: safeId } : {}) };
    assert.deepEqual(acceptanceCatalogError(cause), { status: 409, payload: { code: 'CANDIDATE_ALREADY_EXISTS',
      error: '此 Browser 来源已有候选，请先核对已存记录。', currentRevision: 7, currentGenerationId: generationId, details: expected } });
    const server = await http(t, { createBrowserBaselineCandidate() { throw cause; } });
    const result = await server.post(ROOT + '/' + projectId + '/browser-baseline-candidates', {});
    assert.equal(result.status, 409); assert.deepEqual(result.value.details, expected); safeError(result.value); secureHeaders(result);
    assert.equal(JSON.stringify(result.value).includes('secret'), false);
  }
  const other = acceptanceCatalogError({ code: 'BASELINE_CHANGED', status: 409, details: { existingCandidateId: safeId, reason: 'BAD reason', limit: 'private' } });
  assert.equal(Object.hasOwn(other.payload, 'details'), false);
});
