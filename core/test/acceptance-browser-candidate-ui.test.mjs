/** UI trust boundaries and submission lifecycle; frozen local bytes only, no Browser or target request. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildBrowserCandidateReview } from '../src/acceptance/browser-candidate-review.mjs';
import { projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';
import { AT, uid, copy, independentHash } from './fixtures/acceptance-browser-organized-candidate.mjs';
import { browserCandidateHistory, browserCandidateCollectionState, browserCandidateReviewState,
  buildBrowserCandidateInput, validateBrowserCandidateWrite, createBrowserCandidateReadGuard,
  browserCandidateEvidencePath, fetchBrowserCandidateEvidence, createBrowserCandidateSubmission,
} from '../../console/src/acceptance-browser-candidates.js';
import { AcceptanceCatalogError } from '../../console/src/acceptance-catalog.js';

const ROOT = fileURLToPath(new URL('./fixtures/acceptance-browser-source/matrix/', import.meta.url));
const projectId = uid('ap', 101), sourceBindingId = uid('ax', 103), generationId = uid('ag', 104);
const version = { generationId, revision: 8 };
const invalid = error => error.code === 'INVALID_RESPONSE';
const refs = report => [...new Set(report.checks.flatMap(check => Object.values(check.evidence)).filter(value => value !== null))];
const material = (async () => {
  const [manifest, report, integrity] = await Promise.all(['manifest.json', 'report.json', 'integrity.json']
    .map(async name => JSON.parse(await readFile(join(ROOT, name)))));
  const files = new Map(await Promise.all(['manifest.json', 'report.json', ...refs(report)]
    .map(async name => [name, await readFile(join(ROOT, name))])));
  return { snapshot: { manifest, report, integrity }, files };
})();
async function review(side = 'baseline') {
  const captured = await material;
  const projection = projectBrowserBaselineCandidate(captured, { sourceSide: side }).projection;
  const project = { id: projectId, name: '完整合同 <script>fixture</script>', createdAt: AT };
  const release = { id: uid('ar', 102), projectId, label: 'UI fixture', targetUrl: projection.source.entryUrl, createdAt: AT };
  const { mode: _mode, contentDigest: sourceContentDigest, ...sourceProjection } = projection;
  const sourceBinding = { id: sourceBindingId, projectId, releaseId: release.id, ...sourceProjection,
    sourceContentDigest, boundAt: AT, actor: { kind: 'local-operator' } };
  return copy({ ...buildBrowserCandidateReview({ project, release, sourceBinding, material: captured }), ...version });
}
const readState = value => browserCandidateReviewState(value, { projectId, sourceBindingId, version });
const input = state => buildBrowserCandidateInput({ sourceBindingId, contentDigest: state.value.contentDigest, confirmed: true }, version, state);
function written(value) {
  const response = copy(value); response.revision++;
  response.candidate = { id: uid('bc', 105), ...copy(value.candidateContent), contentDigest: value.contentDigest,
    createdAt: AT, actor: { kind: 'local-operator' } };
  response.event = { id: uid('ae', 106), revision: response.revision, kind: 'browser-candidate-created', projectId,
    entityId: response.candidate.id, entityDigest: independentHash(response.candidate), at: AT, actor: { kind: 'local-operator' } };
  return response;
}
const collection = candidates => ({ schemaVersion: 4, ...version, revision: version.revision + 1, projectId, browserCandidates: candidates,
  verification: { scope: 'stored-candidate-metadata', currentSourceVerified: false },
  browserCandidateSupport: { available: true, requiredSchemaVersion: 4 }, executionReady: false });

test('both selected sides accept complete frozen contracts and preserve all raw literals as data', async () => {
  for (const side of ['baseline', 'target']) {
    const value = await review(side), state = readState(value);
    assert.equal(state.canConfirm, true); assert.equal(state.sourceBinding.source.side, side);
    assert.deepEqual(state.review.sourcePlan, (await material).snapshot.manifest.plan);
    assert.equal(state.review.omissions.length, 0); assert.equal(state.review.observations.length, 8);
    assert.equal(state.review.scope.length, 28); assert.equal(state.review.rules.length, 28);
    assert.deepEqual(Object.keys(input(state)).sort(), ['contentDigest', 'expectedGenerationId', 'expectedRevision', 'sourceBindingId']);
    assert.equal(input(state).contentDigest, value.contentDigest);
  }
});

test('display DTOs, partial blocks, omitted slots and crossed side associations never enable confirmation', async () => {
  const original = await review();
  assert.throws(() => readState({ viewVersion: 1, ...version, presentation: { kind: 'organization-review', completeSourceProjection: false } }), invalid);
  const mutations = [
    value => { delete value.review.sourcePlan; }, value => { delete value.organizationContext.sourceBinding; },
    value => { value.completeness.selectedRequirements = false; }, value => { value.presentation.completeSourceProjection = false; },
    value => { value.review.omissions.push('hidden-rule'); }, value => { value.review.scope.pop(); },
    value => { value.review.rules[0].rule.network = {}; }, value => { delete value.review.observations[0].expected.structure.controls; },
    value => { value.review.observations[0].mask = {}; }, value => { value.review.selectedOracles[0].oracle.entryUrl += '/changed'; },
    value => { value.sourceProjection.source.side = 'target'; }, value => { value.review.selectedEvidence[0].roles.screenshot.sha256 = 'a'.repeat(64); },
    value => { value.review.observations[0].expected.screenshotSha256 = 'b'.repeat(64); },
    value => { value.review.selectedOracles.pop(); }, value => { value.review.verifiedEvidence = []; },
  ];
  for (const mutate of mutations) { const value = copy(original); mutate(value); assert.throws(() => readState(value)); }
  assert.throws(() => buildBrowserCandidateInput({ sourceBindingId, contentDigest: original.contentDigest, confirmed: false }, version, readState(original)), error => error.code === 'INVALID_INPUT');
  assert.throws(() => readState({ ...original, revision: version.revision + 1 }), error => error.code === 'STALE_REVISION');
});

test('candidate history is metadata only and schema3 explicitly reports maintenance support', async () => {
  const response = written(await review()), candidate = response.candidate;
  assert.equal(browserCandidateCollectionState(collection([candidate]), projectId).candidates[0].id, candidate.id);
  assert.deepEqual(browserCandidateHistory({ project: { id: projectId }, browserCandidates: [],
    browserCandidateSupport: { available: false, requiredSchemaVersion: 4 } }, projectId), { candidates: [], available: false });
  const repeated = collection([candidate, candidate]); assert.throws(() => browserCandidateCollectionState(repeated, projectId), invalid);
  const forged = copy(candidate); forged.projectId = uid('ap', 999);
  assert.throws(() => browserCandidateCollectionState(collection([forged]), projectId), invalid);
  const durable = { schemaVersion: 4, ...version, candidate, review: null,
    diagnostics: { eligible: false, contentMatches: false, issues: [{ code: 'SOURCE_CHANGED', message: 'Fixture changed' }] }, executionReady: false };
  const state = browserCandidateReviewState(durable, { projectId, sourceBindingId, candidateId: candidate.id, version });
  assert.equal(state.canConfirm, false); assert.equal(state.review, null);
  assert.throws(() => readState(durable), invalid);
  assert.throws(() => browserCandidateReviewState({ ...durable, organizationContext: {} }, { projectId, sourceBindingId, candidateId: candidate.id, version }), invalid);
});

test('201 must associate exact candidate, project, source, all three digests, event and +1 lineage', async () => {
  const value = await review(), body = input(readState(value)), response = written(value);
  assert.equal(validateBrowserCandidateWrite(response, { projectId, body }), response);
  for (const mutate of [
    result => { delete result.candidate; }, result => { result.candidate.projectId = uid('ap', 999); },
    result => { result.candidate.sourceBindingId = uid('ax', 999); },
    ...['sourceContentDigest', 'organizationContextDigest', 'contentDigest'].map(key => result => { result.candidate[key] = 'f'.repeat(64); }),
    result => { result.event.entityId = uid('bc', 999); }, result => { result.event.kind = 'candidate-created'; },
    result => { result.event.projectId = uid('ap', 999); }, result => { result.event.revision++; },
    result => { result.event.entityDigest = 'invalid'; }, result => { result.generationId = uid('ag', 999); },
    result => { result.revision++; },
  ]) {
    const changed = copy(response); mutate(changed);
    assert.throws(() => validateBrowserCandidateWrite(changed, { projectId, body }), error => error.writeMayHaveCommitted === true);
  }
});

test('read guard rejects A→B→A, lineage changes, abort invalidation and unmount', () => {
  const guard = createBrowserCandidateReadGuard(), a = { projectId, sourceBindingId, candidateId: '', ...version, selectionEpoch: 1 };
  const old = guard.next(a); guard.next({ ...a, sourceBindingId: uid('ax', 999), selectionEpoch: 2 });
  const fresh = guard.next({ ...a, selectionEpoch: 3 });
  assert.equal(guard.accepts(old, { ...a, selectionEpoch: 3 }), false);
  assert.equal(guard.accepts(fresh, { ...a, selectionEpoch: 3 }), true);
  assert.equal(guard.accepts(fresh, { ...a, selectionEpoch: 3, revision: 99 }), false);
  guard.invalidate(); assert.equal(guard.accepts(fresh, { ...a, selectionEpoch: 3 }), false);
  const last = guard.next(a); guard.stop(); assert.equal(guard.accepts(last, a), false);
});

test('PNG requests use only dedicated routes, selected side roles, bounded bytes and SHA', async () => {
  const value = await review('target'), state = readState(value), observation = state.review.observations[0];
  const meta = observation.evidence.screenshot, bytes = (await material).files.get(meta.file), paths = [];
  const fetcher = async (path, settings) => { paths.push(path); assert.equal(settings.redirect, 'error'); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); };
  const result = await fetchBrowserCandidateEvidence({ state, metadata: meta, role: 'screenshot', fetcher, subtle: webcrypto.subtle });
  assert.equal(result.blob.size, bytes.length); assert.match(paths[0], /browser-source-bindings\/ax-.*\/candidate-preview\/evidence\//);
  assert.equal(paths[0].includes('/runs/'), false); assert.equal(paths[0].includes(`expectedContentDigest=${value.contentDigest}`), true);
  const saved = written(value), savedState = browserCandidateReviewState(saved, { projectId, sourceBindingId, candidateId: saved.candidate.id, version: saved });
  await fetchBrowserCandidateEvidence({ state: savedState, metadata: meta, role: 'screenshot', fetcher, subtle: webcrypto.subtle });
  assert.match(paths[1], /browser-baseline-candidates\/bc-.*\/evidence\//);
  assert.throws(() => browserCandidateEvidencePath({ projectId, sourceBindingId, contentDigest: value.contentDigest, side: 'target' }, observation.evidence.details, 'details'), invalid);
  assert.throws(() => browserCandidateEvidencePath({ projectId, sourceBindingId, contentDigest: value.contentDigest, side: 'baseline' }, meta, 'screenshot'));
  await assert.rejects(fetchBrowserCandidateEvidence({ state, metadata: meta, role: 'screenshot', subtle: webcrypto.subtle,
    fetcher: async () => new Response(Buffer.concat([bytes, Buffer.from('extra')]), { headers: { 'content-type': 'image/png' } }) }), error => error.code === 'EVIDENCE_CHANGED');
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  await assert.rejects(fetchBrowserCandidateEvidence({ state, metadata: meta, role: 'screenshot', subtle: webcrypto.subtle,
    fetcher: async () => new Response(changed, { headers: { 'content-type': 'image/png' } }) }), error => error.code === 'EVIDENCE_CHANGED');
});

test('validated 201 remains confirmed when later refresh fails and never repeats POST', async () => {
  const value = await review(), body = input(readState(value)), controller = createBrowserCandidateSubmission(); let calls = 0;
  const post = async () => { calls++; return written(value); };
  const result = await controller.submit({ projectId, body, post, refresh: async () => { throw Error('read unavailable'); } });
  assert.equal(result.refreshed, false); assert.equal(controller.facts()[0].phase, 'confirmed');
  await assert.rejects(controller.submit({ projectId, body, post, refresh: async () => true }), error => error.code === 'INVALID_INPUT');
  assert.equal(calls, 1);
});

test('lost or invalid response latches across reopen; only GET collection can reconcile without replay', async () => {
  const value = await review(), body = input(readState(value));
  for (const lost of [true, false]) {
    const controller = createBrowserCandidateSubmission(); let calls = 0;
    const post = async () => { calls++; if (lost) throw new AcceptanceCatalogError('lost', { writeMayHaveCommitted: true }); return { ...written(value), revision: 100 }; };
    await assert.rejects(controller.submit({ projectId, body, post, refresh: async () => true }));
    assert.equal(controller.facts()[0].phase, 'unknown');
    const reopened = readState(copy(value)); assert.equal(reopened.canConfirm, true, 'raw review alone does not clear parent latch');
    await assert.rejects(controller.submit({ projectId, body, post, refresh: async () => true }), error => error.code === 'INVALID_INPUT');
    assert.throws(() => controller.reconcile({ ...collection([]), generationId: uid('ag', 999) }, { projectId, sourceBindingId }), error => error.code === 'STALE_REVISION');
    assert.equal(controller.facts()[0].phase, 'unknown');
    const result = controller.reconcile(collection([written(value).candidate]), { projectId, sourceBindingId });
    assert.equal(result.phase, 'confirmed'); assert.equal(calls, 1);
  }
  const absent = createBrowserCandidateSubmission();
  await assert.rejects(absent.submit({ projectId, body, post: async () => { throw new AcceptanceCatalogError('lost', { writeMayHaveCommitted: true }); }, refresh: async () => true }));
  assert.equal(absent.reconcile(collection([]), { projectId, sourceBindingId }).phase, 'absent');
  assert.equal(absent.facts()[0].phase, 'absent', 'no POST is issued by reconciliation');
});
