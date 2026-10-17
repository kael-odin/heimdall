import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { browserCandidateCollectionView } from '../src/acceptance/browser-candidate-review.mjs';
import { candidateContent, organizedHash } from './fixtures/acceptance-browser-organized-candidate.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const cas = f => { const value = f.store.read(); return { expectedGenerationId: value.generationId, expectedRevision: value.revision }; };
const head = f => readFileSync(join(f.root, 'catalog.json'));
const request = (f, preview, extra = {}) => ({ ...cas(f), sourceBindingId: f.binding.id, contentDigest: preview.contentDigest, ...extra });
const preview = f => f.store.previewBrowserBaselineCandidate(f.project.id, f.binding.id);
function tree(root) {
  const rows = {};
  const walk = (file, name) => {
    const st = lstatSync(file, { bigint: true });
    assert.equal(st.isSymbolicLink(), false);
    rows[name] = { directory: st.isDirectory(), bytes: String(st.size), nlink: String(st.nlink),
      mtime: String(st.mtimeNs), ctime: String(st.ctimeNs), ...(st.isFile() ? { sha256: sha(readFileSync(file)) } : {}) };
    if (st.isDirectory()) for (const entry of readdirSync(file).sort()) walk(join(file, entry), name ? name + '/' + entry : entry);
  };
  walk(root, ''); return rows;
}
function open(f, limits = {}) {
  return createAcceptanceCatalogStore({ root: f.root, owner: f.owner, limits, writeAtomic(file, bytes) {
    f.writes.push(basename(file)); writeAtomicFileSync(file, bytes);
    if (basename(file) === 'catalog.previous.json' && f.afterPrevious) {
      const callback = f.afterPrevious; f.afterPrevious = null; callback();
    }
  } });
}
async function fixture(t, { sample = 'matrix', side = 'baseline', schema = 4, limits = {} } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-browser-candidate-store-'))), root = join(parent, 'acceptance');
  mkdirSync(root);
  const source = join(FIXTURES, sample), manifest = parse(join(source, 'manifest.json')), dir = join(root, manifest.runId);
  cpSync(source, dir, { recursive: true });
  const owner = acquireAcceptanceOwner({ root });
  t.after(() => { owner.release(); rmSync(parent, { force: true, recursive: true }); });
  const f = { parent, root, dir, owner, writes: [], afterPrevious: null, side, runId: manifest.runId };
  f.store = open(f, limits); await f.store.initialize({ createSchemaVersion: schema });
  f.project = (await f.store.createProject({ ...cas(f), name: 'Browser 完整候选' })).project;
  f.release = (await f.store.createRelease(f.project.id, { ...cas(f), label: '来源版本', targetUrl: manifest.plan[side + 'Url'], buildRef: 'candidate-fixture-v1' })).release;
  f.binding = (await f.store.bindBrowserSource(f.project.id, { ...cas(f), runId: f.runId, sourceSide: side, releaseId: f.release.id })).binding;
  f.writes.length = 0; return f;
}
function reject(code, status = 409, reason) {
  return cause => {
    assert.equal(cause.code, code); assert.equal(cause.status, status);
    if (reason) assert.equal(cause.details?.reason, reason);
    assert.equal(/[A-Z]:\\|\/tmp\/|ENOENT|EACCES/.test(JSON.stringify(cause)), false);
    return true;
  };
}
function noPrivate(value) {
  assert.equal(Buffer.isBuffer(value), false); assert.equal(value instanceof Map, false); assert.notEqual(typeof value, 'function');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert.equal(['files', 'owner', 'snapshot', 'preCommitGuard', 'responseGuard'].includes(key), false, key); noPrivate(child);
  }
}
const screenshot = value => value.review.selectedEvidence[0].roles.screenshot;

test('complete preview is physically read-only and save creates one organized Browser fact without changing original evidence or Spec history', async t => {
  for (const side of ['baseline', 'target']) await t.test(side, async t => {
    const f = await fixture(t, { side }), before = tree(f.root), original = tree(f.dir), catalog = f.store.read();
    const full = preview(f);
    assert.deepEqual(tree(f.root), before); assert.deepEqual(f.writes, []);
    assert.equal(full.presentation.completeSourceProjection, true); assert.equal(full.executionReady, false);
    assert.equal(full.sourceProjection.source.side, side); assert.equal(full.review.sourceGate, parse(join(f.dir, 'report.json')).gate);
    assert.deepEqual(full.organizationContext, { project: f.project, release: f.release, sourceBinding: f.binding });
    assert.equal(full.organizationContextDigest, organizedHash('organization-context', full.organizationContext));
    assert.equal(full.contentDigest, organizedHash('content', full.candidateContent));
    noPrivate(full);
    const saved = await f.store.createBrowserBaselineCandidate(f.project.id, request(f, full));
    assert.equal(saved.generationId, catalog.generationId); assert.equal(saved.revision, catalog.revision + 1);
    assert.equal(saved.candidate.sourceBindingId, f.binding.id); assert.equal(saved.candidate.contentDigest, full.contentDigest);
    assert.deepEqual(candidateContent(saved.candidate), full.candidateContent);
    assert.equal(saved.event.kind, 'browser-candidate-created'); assert.equal(saved.event.entityId, saved.candidate.id);
    assert.equal(saved.event.revision, saved.revision); assert.equal(saved.event.projectId, f.project.id);
    assert.equal(saved.event.at, saved.candidate.createdAt); assert.equal(saved.executionReady, false); noPrivate(saved);
    const after = validateAcceptanceCatalog(f.store.read());
    assert.deepEqual(Object.values(after.browserCandidates), [saved.candidate]);
    assert.deepEqual(after.events.slice(0, -1), catalog.events);
    for (const map of ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'browserSourceBindings']) assert.deepEqual(after[map], catalog[map]);
    assert.deepEqual(tree(f.dir), original);
    assert.deepEqual(f.writes, ['catalog.previous.json', 'catalog.json']);
    const persisted = tree(f.root), restarted = open(f); await restarted.initialize({ createSchemaVersion: 3 });
    assert.deepEqual(tree(f.root), persisted);
    const read = restarted.readBrowserBaselineCandidate(f.project.id, saved.candidate.id);
    assert.deepEqual(read.candidate, saved.candidate); assert.deepEqual(read.review, saved.review);
    assert.equal(read.diagnostics.contentMatches, true); assert.deepEqual(tree(f.root), persisted);
  });
});

test('source failure preserves saved candidate; collection remains source-free and restoring original bytes makes the same candidate reviewable', async t => {
  const f = await fixture(t), full = preview(f), saved = await f.store.createBrowserBaselineCandidate(f.project.id, request(f, full));
  const png = screenshot(full), path = join(f.dir, png.file), bytes = readFileSync(path);
  writeFileSync(path, Buffer.concat([bytes, Buffer.from('corrupt')]));
  const before = tree(f.root);
  const stored = browserCandidateCollectionView(f.store.read(), f.project.id);
  assert.deepEqual(stored.browserCandidates, [saved.candidate]); assert.equal(stored.verification.currentSourceVerified, false);
  assert.equal(JSON.stringify(stored).includes(f.release.targetUrl), false);
  const read = f.store.readBrowserBaselineCandidate(f.project.id, saved.candidate.id);
  assert.deepEqual(read.candidate, saved.candidate); assert.equal(read.review, null); assert.equal(read.diagnostics.eligible, false);
  assert.equal(Object.hasOwn(read, 'sourceProjection'), false); assert.equal(Object.hasOwn(read, 'organizationContext'), false);
  assert.deepEqual(tree(f.root), before);
  assert.throws(() => preview(f), reject('BASELINE_CHANGED'));
  assert.throws(() => f.store.readBrowserBaselineCandidateEvidence(f.project.id, saved.candidate.id,
    { file: png.file, expectedContentDigest: full.contentDigest }), reject('BASELINE_CHANGED'));
  writeFileSync(path, bytes);
  const recovered = f.store.readBrowserBaselineCandidate(f.project.id, saved.candidate.id);
  assert.deepEqual(recovered.candidate, saved.candidate); assert.equal(recovered.contentDigest, full.contentDigest);
  assert.equal(recovered.diagnostics.contentMatches, true);
});

test('schema3 dedicated operations require explicit maintenance and never read or repair missing source evidence', async t => {
  const f = await fixture(t, { schema: 3 }), png = readdirSync(f.dir).find(name => name.endsWith('.png'));
  rmSync(join(f.dir, png)); const before = tree(f.root);
  assert.throws(() => preview(f), reject('CATALOG_MIGRATION_REQUIRED', 409, 'SCHEMA4_REQUIRED'));
  await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, { ...cas(f), sourceBindingId: f.binding.id,
    contentDigest: 'a'.repeat(64) }), reject('CATALOG_MIGRATION_REQUIRED'));
  assert.throws(() => f.store.readBrowserBaselineCandidate(f.project.id, 'bc-' + randomUUID()), reject('CATALOG_MIGRATION_REQUIRED'));
  assert.deepEqual(tree(f.root), before); assert.deepEqual(f.writes, []);
  assert.equal(f.store.read().schemaVersion, 3);
});

test('invalid fields, stale lineage and content each fail without publishing a candidate', async t => {
  const f = await fixture(t), full = preview(f);
  for (const extra of [{ mode: 'browser' }, { releaseId: f.release.id }, { confirmed: true }, { sourceBindingId: f.runId }, { contentDigest: '' }]) {
    const before = tree(f.root);
    await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full, extra)), reject('INVALID_INPUT', 400));
    assert.deepEqual(tree(f.root), before);
  }
  for (const extra of [{ expectedGenerationId: 'ag-' + randomUUID() }, { expectedRevision: full.revision - 1 }]) {
    const before = tree(f.root);
    await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full, extra)), reject('STALE_REVISION'));
    assert.deepEqual(tree(f.root), before);
  }
  const before = tree(f.root);
  await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full, { contentDigest: '0'.repeat(64) })), reject('BASELINE_CHANGED'));
  assert.deepEqual(tree(f.root), before); assert.deepEqual(f.writes, []);
});

test('same-CAS concurrent saves create one candidate; repeat with current CAS exposes only the existing candidate ID even when PNG is missing', async t => {
  const f = await fixture(t), full = preview(f), input = request(f, full);
  const results = await Promise.allSettled([f.store.createBrowserBaselineCandidate(f.project.id, input), f.store.createBrowserBaselineCandidate(f.project.id, input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STALE_REVISION');
  const saved = results.find(result => result.status === 'fulfilled').value;
  rmSync(join(f.dir, screenshot(full).file)); f.writes.length = 0;
  const before = tree(f.root);
  await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full)), cause => {
    reject('CANDIDATE_ALREADY_EXISTS')(cause); assert.deepEqual(cause.details, { existingCandidateId: saved.candidate.id }); return true;
  });
  assert.deepEqual(tree(f.root), before); assert.deepEqual(f.writes, []);
});

test('candidate and event count limits reject before missing PNG evidence is read', async t => {
  for (const limit of ['browserCandidates', 'events']) await t.test(limit, async t => {
    const f = await fixture(t), full = preview(f), count = limit === 'events' ? f.store.read().events.length : 0;
    f.store = open(f, { [limit]: count });
    rmSync(join(f.dir, screenshot(full).file)); const before = tree(f.root);
    await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full)), cause => {
      reject('CATALOG_CAPACITY')(cause); assert.equal(cause.details.limit, limit); return true;
    });
    assert.deepEqual(tree(f.root), before); assert.deepEqual(f.writes, []);
  });
});

test('source changes after previous publication reject the late guard and leave head, candidate and event unchanged', async t => {
  const f = await fixture(t), full = preview(f), before = head(f), catalog = f.store.read();
  const png = join(f.dir, screenshot(full).file);
  f.afterPrevious = () => writeFileSync(png, Buffer.concat([readFileSync(png), Buffer.from('late-change')]));
  await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full)), reject('BASELINE_CHANGED'));
  assert.deepEqual(head(f), before); assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), before);
  assert.deepEqual(f.store.read(), catalog); assert.deepEqual(f.writes, ['catalog.previous.json']);
});

test('external head byte change after previous is not adopted by the Browser candidate transaction', async t => {
  const f = await fixture(t), full = preview(f), before = head(f), catalog = f.store.read();
  f.afterPrevious = () => writeFileSync(join(f.root, 'catalog.json'), Buffer.concat([before, Buffer.from(' ')]));
  await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full)), reject('STALE_REVISION'));
  assert.deepEqual(f.store.read(), catalog); assert.deepEqual(f.writes, ['catalog.previous.json']);
});

test('owner loss after previous is a 503 and cannot publish a Browser candidate', async t => {
  const f = await fixture(t), full = preview(f), before = head(f);
  f.afterPrevious = () => f.owner.release();
  await assert.rejects(f.store.createBrowserBaselineCandidate(f.project.id, request(f, full)), cause => {
    assert.equal(cause.status, 503); assert.match(cause.code, /^ACCEPTANCE_OWNER_/); return true;
  });
  assert.deepEqual(head(f), before); assert.deepEqual(f.writes, ['catalog.previous.json']);
});

test('dedicated PNG captures verify the complete source and return only selected screenshot or repeat bytes from that capture', async t => {
  const f = await fixture(t), full = preview(f), saved = await f.store.createBrowserBaselineCandidate(f.project.id, request(f, full));
  const before = tree(f.root), roles = full.review.selectedEvidence[0].roles;
  for (const role of ['screenshot', 'repeat']) {
    const expected = roles[role], input = { file: expected.file, expectedContentDigest: full.contentDigest };
    const image = f.store.readBrowserCandidatePreviewEvidence(f.project.id, f.binding.id, input);
    assert.deepEqual(image.bytes, readFileSync(join(f.dir, expected.file))); assert.equal(image.sha256, expected.sha256);
    assert.deepEqual(f.store.readBrowserBaselineCandidateEvidence(f.project.id, saved.candidate.id, input), image);
    image.bytes.fill(0);
    assert.equal(sha(f.store.readBrowserCandidatePreviewEvidence(f.project.id, f.binding.id, input).bytes), expected.sha256);
  }
  const other = full.review.verifiedEvidence.find(row => row.file.endsWith('.png')
    && !full.review.selectedEvidence.some(value => [value.roles.screenshot.file, value.roles.repeat.file].includes(row.file)));
  assert.ok(other, 'fixture must include an unselected-side PNG');
  assert.throws(() => f.store.readBrowserCandidatePreviewEvidence(f.project.id, f.binding.id,
    { file: other.file, expectedContentDigest: full.contentDigest }), reject('NOT_FOUND', 404));
  for (const file of [roles.details.file, '../image.png', '%69mage.png']) assert.throws(() => f.store.readBrowserCandidatePreviewEvidence(f.project.id, f.binding.id,
    { file, expectedContentDigest: full.contentDigest }), reject('INVALID_INPUT', 400));
  assert.throws(() => f.store.readBrowserCandidatePreviewEvidence(f.project.id, f.binding.id,
    { file: roles.screenshot.file, expectedContentDigest: 'f'.repeat(64) }), reject('BASELINE_CHANGED'));
  assert.deepEqual(tree(f.root), before);
  const otherPath = join(f.dir, other.file), original = readFileSync(otherPath);
  writeFileSync(otherPath, Buffer.concat([original, Buffer.from('unselected-side-change')]));
  assert.throws(() => f.store.readBrowserCandidatePreviewEvidence(f.project.id, f.binding.id,
    { file: roles.screenshot.file, expectedContentDigest: full.contentDigest }), reject('BASELINE_CHANGED'));
});
