import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createBrowserOperationStore } from '../src/acceptance/browser-operation-store.mjs';
import { fixedBrowserRuntimeOf } from '../src/acceptance/browser-fixed-contract.mjs';
import { facts } from '../scripts/fixtures/managed-execution.mjs';

const SAMPLE = fileURLToPath(new URL('./fixtures/acceptance-browser-source/matrix/', import.meta.url));
const cas = f => { const value = f.catalog.read(); return { expectedGenerationId: value.generationId, expectedRevision: value.revision }; };
const copy = value => JSON.parse(JSON.stringify(value));
async function fixture(t, side = 'baseline') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-browser-execution-catalog-')));
  const manifest = JSON.parse(readFileSync(join(SAMPLE, 'manifest.json'))), sourceDir = join(root, manifest.runId);
  cpSync(SAMPLE, sourceDir, { recursive: true });
  const owner = acquireAcceptanceOwner({ root }), catalog = createAcceptanceCatalogStore({ root, owner }), operations = createBrowserOperationStore({ owner });
  t.after(() => { owner.release(); rmSync(root, { recursive: true, force: true }); });
  const f = { root, sourceDir, owner, catalog, operations }; await catalog.initialize({ createSchemaVersion: 4 });
  f.project = (await catalog.createProject({ ...cas(f), name: 'Single-operation Browser project' })).project;
  f.sourceRelease = (await catalog.createRelease(f.project.id, { ...cas(f), label: 'Captured source', targetUrl: manifest.plan[side + 'Url'] })).release;
  f.binding = (await catalog.bindBrowserSource(f.project.id, { ...cas(f), runId: manifest.runId, sourceSide: side, releaseId: f.sourceRelease.id })).binding;
  const preview = catalog.previewBrowserBaselineCandidate(f.project.id, f.binding.id);
  f.candidate = (await catalog.createBrowserBaselineCandidate(f.project.id, { ...cas(f), sourceBindingId: f.binding.id, contentDigest: preview.contentDigest })).candidate;
  f.targetRelease = (await catalog.createRelease(f.project.id, { ...cas(f), label: 'New target', targetUrl: 'https://catalog-target.test/application?version=two' })).release;
  f.request = patch => ({ ...cas(f), operationId: 'bo-' + randomUUID(), candidateId: f.candidate.id,
    contentDigest: f.candidate.contentDigest, targetReleaseId: f.targetRelease.id, ...patch });
  f.execute = (request = f.request(), options = { assertAdmission: () => true,
    publish: (context, fence) => operations.publish(context, fence) }, projectId = f.project.id) => catalog.withBrowserExecutionCandidate(projectId, request, options);
  return f;
}

test('catalog compiles a fresh private capability and publishes one target operation without catalog, selection or source writes', async t => {
  for (const side of ['baseline', 'target']) await t.test(side, async t => {
    const f = await fixture(t, side), input = f.request(), original = facts(f.sourceDir), head = readFileSync(join(f.root, 'catalog.json')),
      previous = readFileSync(join(f.root, 'catalog.previous.json')), catalog = f.catalog.read();
    let context, guards = 0;
    const result = await f.execute(input, { assertAdmission() { guards++; return true; }, publish(value, fence) {
      context = value; assert.equal(value.request.operationId, input.operationId);
      assert.equal(value.project.id, f.project.id); assert.equal(value.candidate.id, f.candidate.id);
      assert.deepEqual(value.review.organizationContext, { project: f.project, release: f.sourceRelease, sourceBinding: f.binding });
      assert.equal(value.review.diagnostics.contentMatches, true);
      return f.operations.publish(value, fence);
    } });
    assert.equal(result.replayed, false); assert.equal(result.contract, context.contract);
    assert.equal(result.sourceFiles, context.sourceFiles); assert.ok(guards >= 3);
    assert.ok(guards < result.sourceFiles.size, 'the full source fence must not be repeated for each copied artifact');
    assert.equal(result.contract.fixedBaseline.sourceSide, side); assert.equal(result.contract.observations.length, 8);
    assert.equal(result.contract.scope.length, 28); assert.equal(result.sourceFiles.size, 24);
    assert.doesNotThrow(() => fixedBrowserRuntimeOf(result.contract, result.sourceFiles));
    assert.throws(() => fixedBrowserRuntimeOf(copy(result.contract), result.sourceFiles), { code: 'BASELINE_CHANGED' });
    assert.equal(Object.isFrozen(result.contract.rules[0]), true);
    for (const [file, bytes] of result.sourceFiles) assert.deepEqual(bytes, readFileSync(join(f.sourceDir, file)));
    assert.equal(f.operations.read(input.operationId).state, 'prepared');
    assert.deepEqual(readFileSync(join(f.root, 'catalog.json')), head); assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), previous);
    assert.deepEqual(f.catalog.read(), catalog); assert.deepEqual(facts(f.sourceDir), original);
    assert.deepEqual(catalog.approvals, {}); assert.deepEqual(catalog.selections, {});
    const rerun = await f.execute(input); assert.equal(rerun.replayed, true);
    assert.notEqual(rerun.contract, result.contract, 'fresh captures compile a new private capability even for store replay');
    assert.deepEqual(rerun.contract, result.contract); assert.deepEqual(facts(f.sourceDir), original);
  });
});

test('catalog rejects stale CAS, cross-project ownership and candidate digest mismatch before publication', async t => {
  const f = await fixture(t), other = (await f.catalog.createProject({ ...cas(f), name: 'Other Browser project' })).project;
  const otherRelease = (await f.catalog.createRelease(other.id, { ...cas(f), label: 'Other target', targetUrl: 'https://other-project.test/' })).release;
  const snapshot = facts(f.root); let calls = 0;
  const options = { assertAdmission: () => true, publish() { calls++; throw Error('must never publish'); } };
  for (const [projectId, input, code] of [
    [f.project.id, f.request({ expectedRevision: cas(f).expectedRevision - 1 }), 'STALE_REVISION'],
    [f.project.id, f.request({ expectedGenerationId: 'ag-' + randomUUID() }), 'STALE_REVISION'],
    [f.project.id, f.request({ targetReleaseId: otherRelease.id }), 'PROJECT_MISMATCH'],
    [other.id, f.request(), 'PROJECT_MISMATCH'],
    [f.project.id, f.request({ contentDigest: '0'.repeat(64) }), 'BASELINE_CHANGED'],
    [f.project.id, f.request({ candidateId: 'bc-' + randomUUID() }), 'NOT_FOUND'],
  ]) await assert.rejects(f.execute(input, options, projectId), { code });
  assert.equal(calls, 0); assert.deepEqual(facts(f.root), snapshot);
});

test('late source changes on either selected or unselected evidence fail the final fresh fence before dispatch commit', async t => {
  const f = await fixture(t), before = facts(f.root);
  for (const selected of [true, false]) {
    let file, original;
    await assert.rejects(f.execute(f.request(), { assertAdmission: () => true, publish(context, fence) {
      const wanted = new Set(context.sourceFiles.keys());
      const sourceReport = JSON.parse(readFileSync(join(f.sourceDir, 'report.json')));
      file = [...new Set(sourceReport.checks.flatMap(c => Object.values(c.evidence)).filter(v => typeof v === 'string' && v.endsWith('.png')))]
        .find(name => wanted.has(name) === selected);
      assert.ok(file); original = readFileSync(join(f.sourceDir, file));
      writeFileSync(join(f.sourceDir, file), Buffer.concat([original, Buffer.from('late change')]));
      return f.operations.publish(context, fence);
    } }), { code: 'BASELINE_CHANGED' });
    writeFileSync(join(f.sourceDir, file), original);
    assert.deepEqual(facts(f.root), before); assert.equal(existsSync(join(f.root, 'browser-operations')), false);
  }
});

test('catalog final fence does not adopt changed head or previous bytes and does not create operation facts', async t => {
  const f = await fixture(t), before = facts(f.root);
  for (const name of ['catalog.json', 'catalog.previous.json']) {
    const path = join(f.root, name), original = readFileSync(path);
    await assert.rejects(f.execute(f.request(), { assertAdmission: () => true, publish(context, fence) {
      writeFileSync(path, Buffer.concat([original, Buffer.from(' ')])); return f.operations.publish(context, fence);
    } }), error => ['STALE_REVISION', 'CATALOG_UNAVAILABLE'].includes(error.code));
    writeFileSync(path, original); assert.deepEqual(facts(f.root), before);
  }
});

test('source change during the last dispatch fence retains copied staging but cannot publish or reuse an operation fact', async t => {
  const f = await fixture(t), input = f.request(), source = facts(f.sourceDir), head = readFileSync(join(f.root, 'catalog.json'));
  let file, original, fences = 0;
  await assert.rejects(f.execute(input, { assertAdmission: () => true, publish(context, fence) {
    file = context.contract.sourceEvidence[0].sourceFile; original = readFileSync(join(f.sourceDir, file));
    return f.operations.publish(context, { assertCurrent() {
      fences++;
      if (fences === 2) writeFileSync(join(f.sourceDir, file), Buffer.concat([original, Buffer.from('last fence change')]));
      fence.assertCurrent();
    } });
  } }), { code: 'BASELINE_CHANGED' });
  assert.equal(fences, 2); writeFileSync(join(f.sourceDir, file), original);
  const operation = join(f.root, 'browser-operations', 'v1', input.operationId);
  assert.equal(existsSync(join(operation, 'evidence')), true);
  assert.equal(existsSync(join(operation, 'dispatch.json')), false); assert.equal(existsSync(join(operation, 'head.json')), false);
  assert.throws(() => f.operations.read(input.operationId), { code: 'BROWSER_OPERATION_UNAVAILABLE' });
  assert.deepEqual(facts(f.sourceDir), source); assert.deepEqual(readFileSync(join(f.root, 'catalog.json')), head);
});

test('non-synchronous callbacks and admission thenables are rejected without invoking user hooks', async t => {
  const f = await fixture(t), before = facts(f.root); let hooks = 0, publications = 0;
  const sync = () => true, publish = () => { publications++; return { record: {}, replayed: false }; };
  const proxy = new Proxy(sync, { apply() { hooks++; return true; } });
  const asyncCallback = async () => { hooks++; return true; };
  const generator = function* () { hooks++; yield true; };
  for (const options of [{ assertAdmission: asyncCallback, publish }, { assertAdmission: generator, publish },
    { assertAdmission: proxy, publish }, { assertAdmission: sync, publish: asyncCallback }, { assertAdmission: sync, publish: proxy }])
    await assert.rejects(f.execute(f.request(), options), { code: 'INVALID_INPUT' });
  const thenable = {}; Object.defineProperty(thenable, 'then', { enumerable: true, get() { hooks++; throw Error('must not inspect then'); } });
  for (const result of [false, thenable, Promise.resolve(true)])
    await assert.rejects(f.execute(f.request(), { assertAdmission: () => result, publish }), { code: 'BROWSER_EXECUTION_UNAVAILABLE' });
  assert.equal(hooks, 0); assert.equal(publications, 0); assert.deepEqual(facts(f.root), before);
});

test('invalid publication results are uncertain and cannot trigger thenable, proxy or accessor hooks', async t => {
  const f = await fixture(t), before = facts(f.root); let hooks = 0;
  const thenable = {}; Object.defineProperty(thenable, 'then', { enumerable: true, get() { hooks++; throw Error('must not inspect'); } });
  const proxy = new Proxy({ record: {}, replayed: false }, { ownKeys() { hooks++; return []; }, getPrototypeOf() { hooks++; return Object.prototype; } });
  const accessor = {}; Object.defineProperty(accessor, 'record', { enumerable: true, get() { hooks++; throw Error('must not inspect'); } });
  for (const result of [thenable, proxy, accessor, { record: {}, replayed: false, contract: {} }]) {
    await assert.rejects(f.execute(f.request(), { assertAdmission: () => true, publish: () => result }), error => {
      assert.equal(error.code, 'BROWSER_EXECUTION_UNAVAILABLE'); assert.equal(error.writeMayHaveCommitted, true); return true;
    });
  }
  assert.equal(hooks, 0); assert.deepEqual(facts(f.root), before);
});
