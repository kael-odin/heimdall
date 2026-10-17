import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileFixedBrowserContract, fixedBrowserRuntimeOf, validateFixedBrowserContract } from '../src/acceptance/browser-fixed-contract.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { browserFixedFixture } from './fixtures/acceptance-browser-fixed.mjs';
import { copy, uid } from './fixtures/acceptance-browser-organized-candidate.mjs';

const changed = error => error.code === 'BASELINE_CHANGED' && error.details?.reason === 'BROWSER_FIXED_CONTRACT_CHANGED';
const sha = value => createHash('sha256').update(value).digest('hex');
test('both captured sides compile the complete fixed plan and only selected original evidence', async () => {
  for (const side of ['baseline', 'target']) {
    const fixture = await browserFixedFixture(side), { contract, sourceFiles, material, review } = fixture;
    assert.equal(contract.fixedBaseline.sourceSide, side);
    assert.equal(contract.plan.baselineUrl, material.snapshot.manifest.plan[side + 'Url']);
    assert.equal(contract.plan.targetUrl, fixture.targetRelease.targetUrl);
    assert.deepEqual(contract.plan.routes, review.review.sourcePlan.routes);
    assert.deepEqual(contract.plan.points, review.review.sourcePlan.points);
    assert.deepEqual(contract.scope, review.review.scope);
    assert.equal(contract.scope.length, 28);
    assert.equal(contract.observations.length, 8);
    assert.equal(sourceFiles.size, 24);
    assert.equal(Object.isFrozen(contract.plan.points[0].assertions[0]), true);
    const expected = new Set(review.review.selectedEvidence.flatMap(value => Object.values(value.roles).map(entry => entry.file)));
    assert.deepEqual(new Set(sourceFiles.keys()), expected);
    assert.equal(sourceFiles.has('report.json'), false);
    for (const entry of contract.sourceEvidence) {
      assert.equal(entry.file, 'source-' + entry.sourceFile);
      assert.equal(entry.sha256, sha(sourceFiles.get(entry.sourceFile)));
      assert.deepEqual(sourceFiles.get(entry.sourceFile), material.files.get(entry.sourceFile));
      assert.notEqual(sourceFiles.get(entry.sourceFile), material.files.get(entry.sourceFile));
    }
    assert.deepEqual(validateFixedBrowserContract(copy(contract)), contract);
    const runtime = fixedBrowserRuntimeOf(contract, sourceFiles), route = contract.plan.routes[0], viewport = contract.plan.viewports[0];
    const observation = runtime.observation(route, viewport);
    assert.ok(observation.details.startsWith('source-'));
    assert.deepEqual(observation.image, material.files.get(observation.screenshot.slice('source-'.length)));
    const first = runtime.identity(route, viewport, 'visual');
    assert.equal(first.oracle.kind, 'captured-browser-side');
    assert.equal(first.oracle.contentDigest, contract.contentDigest);
    assert.equal(first.oracle.sourceSide, side);
    assert.equal(first.oracle.captured.screenshotSha256, sha(observation.image));
    assert.deepEqual(first, runtime.identity(route, { ...viewport, name: 'display-renamed' }, 'visual'));
  }
});

test('same-capture compilation rejects a changed review, candidate relation, selected bytes and target ownership', async () => {
  const fixture = await browserFixedFixture();
  const input = () => ({ material: fixture.material, review: fixture.review, candidate: fixture.candidate, targetRelease: fixture.targetRelease });
  const review = copy(fixture.review); review.review.observations[0].expected.httpStatus = 201;
  assert.throws(() => compileFixedBrowserContract({ ...input(), review }), changed);
  for (const patch of [{ contentDigest: 'a'.repeat(64) }, { projectId: uid('ap', 999) }, { sourceBindingId: uid('ax', 999) }]) {
    assert.throws(() => compileFixedBrowserContract({ ...input(), candidate: { ...fixture.candidate, ...patch } }), changed);
  }
  assert.throws(() => compileFixedBrowserContract({ ...input(), targetRelease: { ...fixture.targetRelease, projectId: uid('ap', 999) } }), changed);
  const file = fixture.sourceFiles.keys().next().value, before = fixture.material.files.get(file);
  fixture.material.files.set(file, Buffer.from(before).fill(0));
  assert.throws(() => compileFixedBrowserContract(input()), error => ['SOURCE_INTEGRITY_FAILED', 'SOURCE_NOT_ELIGIBLE'].includes(error.code));
  fixture.material.files.set(file, before);
});

test('serialized contracts validate as immutable data but cannot impersonate an execution capability', async () => {
  const { contract, sourceFiles } = await browserFixedFixture();
  assert.throws(() => fixedBrowserRuntimeOf(copy(contract), sourceFiles), changed);
  const tampered = new Map(sourceFiles), file = sourceFiles.keys().next().value;
  tampered.set(file, Buffer.from(sourceFiles.get(file)).fill(0));
  assert.throws(() => fixedBrowserRuntimeOf(contract, tampered), changed);
  assert.throws(() => fixedBrowserRuntimeOf(contract, new Map([...sourceFiles, ['extra.json', Buffer.from('{}')]])), changed);
  for (const mutate of [value => value.plan.points.pop(), value => value.sourceEvidence[0].file = '../escape',
    value => value.fixedBaseline.candidateId = uid('bc', 999), value => value.scope.pop()]) {
    const value = copy(contract); mutate(value); const { contractDigest: _digest, ...rest } = value;
    value.contractDigest = hashAcceptanceValue(rest);
    assert.throws(() => validateFixedBrowserContract(value), changed);
  }
});
