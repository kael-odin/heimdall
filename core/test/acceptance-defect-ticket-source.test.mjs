import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, linkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDefectTicketSourceReader, DEFECT_TICKET_SOURCE_LIMITS } from '../src/acceptance/defect-ticket-source.mjs';
import { validateAcceptanceCatalog } from '../src/acceptance/catalog-schema.mjs';
import { buildBrowserCandidateReview } from '../src/acceptance/browser-candidate-review.mjs';
import { compileFixedBrowserContract } from '../src/acceptance/browser-fixed-contract.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { append, empty, copy, uid } from './fixtures/acceptance-browser-organized-candidate.mjs';
import { secondDefectTicketCandidate } from './fixtures/acceptance-defect-ticket.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const pathOf = (f, operationId, file) => join(f.root, 'browser-operations', 'v1', operationId, file);
const rejected = (reason, code) => error => {
  if (reason) assert.equal(error.details?.reason, reason);
  if (code) assert.equal(error.code, code);
  assert.equal(/[A-Z]:\\|ENOENT|EACCES/.test(JSON.stringify(error)), false);
  return true;
};
async function fixture(t) {
  const f = await browserOperationFixture(t), catalog = empty();
  append(catalog, 'projects', copy(f.project), 'project-created', f.project.id);
  append(catalog, 'releases', copy(f.review.organizationContext.release), 'release-created', f.project.id);
  append(catalog, 'releases', copy(f.targetRelease), 'release-created', f.project.id);
  append(catalog, 'browserSourceBindings', copy(f.sourceBinding), 'browser-source-bound', f.project.id);
  append(catalog, 'browserCandidates', copy(f.candidate), 'browser-candidate-created', f.project.id);
  validateAcceptanceCatalog(catalog);
  writeFileSync(join(f.root, 'catalog.json'), encode(catalog), { flag: 'wx' });
  const request = { projectId: f.project.id, candidateId: f.candidate.id, contentDigest: f.candidate.contentDigest };
  const reader = createDefectTicketSourceReader({ owner: f.owner });
  function operation({ bug = false, registered = true, beforeOperationId = null } = {}) {
    const input = f.request(); f.publish(input); const run = f.store.createRun(input.operationId);
    const value = f.store.finishRun(input.operationId, browserOperationRaw(f, run, { bug }));
    if (registered) f.store.registerResult(input.operationId, { beforeOperationId });
    return { operationId: input.operationId, value };
  }
  return { ...f, catalog, sourceRequest: request, reader, operation };
}
// Observe actual native opens without giving the production reader an injected
// store or filesystem capability. Restore synchronously before the next test.
function observeOpens(fn) {
  const native = fs.openSync, opens = [];
  fs.openSync = function (...args) { opens.push(String(args[0])); return Reflect.apply(native, fs, args); };
  syncBuiltinESMExports();
  try { fn(opens); } finally { fs.openSync = native; syncBuiltinESMExports(); }
  return opens;
}
const evidenceOpens = opens => opens.filter(path => /[\\/]evidence[\\/]/.test(path));
function foreignOperation(f) {
  const project = { ...f.project, id: uid('ap', 8001) }, release = { ...f.review.organizationContext.release,
    id: uid('ar', 8002), projectId: project.id }, sourceBinding = { ...f.sourceBinding,
    id: uid('ax', 8003), projectId: project.id, releaseId: release.id };
  const review = buildBrowserCandidateReview({ project, release, sourceBinding, material: f.material });
  const candidate = { ...f.candidate, id: uid('bc', 8004), ...copy(review.candidateContent), contentDigest: review.contentDigest };
  const targetRelease = { ...f.targetRelease, id: uid('ar', 8005), projectId: project.id };
  const compiled = compileFixedBrowserContract({ material: f.material, review, candidate, targetRelease });
  const context = { material: f.material, project, sourceBinding, review, candidate, targetRelease, ...compiled };
  const request = { ...f.request(), candidateId: candidate.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id };
  f.store.publish({ ...context, request }); const run = f.store.createRun(request.operationId);
  f.store.finishRun(request.operationId, browserOperationRaw(context, run, { bug: true }));
  f.store.registerResult(request.operationId);
  return request.operationId;
}

test('source capability rejects method-shaped owners and limits accessors without invoking them', async t => {
  let touches = 0;
  const owner = { assertOwned() { touches++; return true; }, get root() { touches++; return 'unused'; } };
  assert.throws(() => createDefectTicketSourceReader({ owner }), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE' });
  assert.equal(touches, 0);
  const f = await fixture(t), limits = {};
  Object.defineProperty(limits, 'jsonBytes', { enumerable: true, get() { touches++; return 1; } });
  assert.throws(() => createDefectTicketSourceReader({ owner: f.owner, limits }), rejected('INVALID_LIMITS', 'INVALID_INPUT'));
  assert.equal(touches, 0);
  assert.throws(() => createDefectTicketSourceReader({ owner: f.owner,
    limits: { jsonBytes: DEFECT_TICKET_SOURCE_LIMITS.jsonBytes + 1 } }), rejected('INVALID_LIMITS', 'INVALID_INPUT'));
  assert.throws(() => f.reader.capture({ ...f.sourceRequest, snapshot: {} }), rejected('INVALID_SOURCE_REQUEST', 'INVALID_INPUT'));
});

test('empty reads stay read-only and fence the absence of the operation namespace', async t => {
  const f = await fixture(t), before = readdirSync(f.root).sort(), capture = f.reader.capture(f.sourceRequest);
  assert.deepEqual(capture.facts.operations, []); assert.equal(capture.assertCurrent(), true);
  assert.deepEqual(readdirSync(f.root).sort(), before);
  assert.equal(Object.isFrozen(capture.facts), true); assert.equal(Object.isFrozen(capture.budget), true);
  assert.equal(capture.budget.namespaceOperations, 0);
  f.store.publishRejection({ projectId: f.project.id, request: f.request() });
  assert.throws(capture.assertCurrent, rejected('SOURCE_ABSENCE_CHANGED', 'STALE_FACTS'));
});

test('real ledger facts preserve original SHAs, empty registrations and immutable declared scope', async t => {
  const f = await fixture(t), failed = f.operation({ bug: true });
  const unregistered = f.operation({ registered: false });
  const fixed = f.operation({ beforeOperationId: failed.operationId });
  const empty = f.operation();
  const capture = f.reader.capture(f.sourceRequest), facts = capture.facts;
  assert.equal(facts.operations.length, 3); assert.equal(capture.budget.completedOperations, 4);
  assert.equal(facts.operations.some(operation => operation.operationId === unregistered.operationId), false);
  assert.deepEqual(facts.operations.find(operation => operation.operationId === empty.operationId).observation.observations, []);
  assert.equal(facts.operations.find(operation => operation.operationId === fixed.operationId).observation.observations[0].relation, 'verified_passed');
  for (const operation of facts.operations) {
    for (const [field, file] of [['dispatchSha256', 'dispatch.json'], ['reportSha256', 'report.json'], ['observationsSha256', 'observations.json']]) {
      assert.equal(operation[field], sha(readFileSync(pathOf(f, operation.operationId, file))));
    }
    assert.equal(Object.isFrozen(operation.report.checks[0].identity), true);
  }
  assert.equal(capture.assertCurrent(), true);
  assert.deepEqual(capture.factsFor({ candidateId: f.candidate.id, contentDigest: f.candidate.contentDigest }), facts);
  assert.throws(() => capture.factsFor({ candidateId: uid('bc', 123456), contentDigest: f.candidate.contentDigest }), { code: 'NOT_FOUND' });
  assert.throws(() => capture.factsFor({ candidateId: f.candidate.id, contentDigest: '0'.repeat(64) }), { code: 'STALE_FACTS' });
  assert.throws(() => capture.factsFor({ projectId: f.project.id, candidateId: f.candidate.id, contentDigest: f.candidate.contentDigest }), { code: 'INVALID_INPUT' });
  assert.equal(f.reader.capture(f.sourceRequest).facts.factsDigest, facts.factsDigest);
  assert.equal(f.reader.capture({ projectId: f.project.id, operationId: failed.operationId }).facts.factsDigest, facts.factsDigest);
  assert.ok(capture.budget.batchReadUpperBound > capture.budget.jsonBytes + capture.budget.evidenceBytes);
  assert.throws(() => { facts.operations[0].report.checks[0].status = 'passed'; }, TypeError);
});

test('a new empty registration invalidates a held capture and changes the complete facts digest', async t => {
  const f = await fixture(t); f.operation({ bug: true }); const pending = f.operation({ registered: false });
  const previous = f.reader.capture(f.sourceRequest);
  f.store.registerResult(pending.operationId);
  assert.throws(previous.assertCurrent, rejected('SOURCE_ABSENCE_CHANGED', 'STALE_FACTS'));
  const next = f.reader.capture(f.sourceRequest);
  assert.notEqual(next.facts.factsDigest, previous.facts.factsDigest);
  assert.equal(next.facts.operations.length, 2);
  assert.deepEqual(next.facts.operations.find(operation => operation.operationId === pending.operationId).observation.observations, []);
});

test('one verified project batch selects candidates independently and performs no extra I/O on selection', async t => {
  const f = await fixture(t), original = f.operation({ bug: true });
  const context = await secondDefectTicketCandidate(f, f.catalog), candidate = context.candidate;
  validateAcceptanceCatalog(f.catalog); writeFileSync(join(f.root, 'catalog.json'), encode(f.catalog));
  const request = { ...f.request(), candidateId: candidate.id, contentDigest: candidate.contentDigest };
  f.store.publish({ ...context, request }); const run = f.store.createRun(request.operationId);
  f.store.finishRun(request.operationId, browserOperationRaw(context, run, { bug: true })); f.store.registerResult(request.operationId);
  const capture = f.reader.capture(f.sourceRequest); let alternate;
  const opens = observeOpens(() => { alternate = capture.factsFor({ candidateId: candidate.id, contentDigest: candidate.contentDigest }); });
  assert.deepEqual(opens, []);
  assert.deepEqual(capture.facts.operations.map(operation => operation.operationId), [original.operationId]);
  assert.deepEqual(alternate.operations.map(operation => operation.operationId), [request.operationId]);
  assert.notEqual(alternate.factsDigest, capture.facts.factsDigest);
  assert.equal(capture.assertCurrent(), true);
});

test('held captures fence a new rejection, prepared head, evidence, catalog and lost owner', async t => {
  for (const scenario of ['rejection', 'head', 'evidence', 'catalog', 'owner']) await t.test(scenario, async t => {
    const f = await fixture(t), operation = f.operation({ bug: true }), prepared = f.request(); f.publish(prepared);
    const capture = f.reader.capture(f.sourceRequest);
    if (scenario === 'rejection') f.store.publishRejection({ projectId: f.project.id, request: f.request() });
    if (scenario === 'head') f.store.createRun(prepared.operationId);
    if (scenario === 'evidence') {
      const file = operation.value.report.evidenceManifest[0].file, path = pathOf(f, operation.operationId, join('evidence', file));
      const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
    }
    if (scenario === 'catalog') {
      const path = join(f.root, 'catalog.json'); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(' ')]));
    }
    if (scenario === 'owner') f.owner.release();
    assert.throws(capture.assertCurrent, error => scenario === 'owner'
      ? error.code === 'ACCEPTANCE_OWNER_LOST' : error.code === 'STALE_FACTS');
  });
});

test('whole-project JSON, evidence and repeated-read budgets reject before any evidence payload open', async t => {
  const f = await fixture(t); f.operation({ bug: true }); f.operation();
  const normal = f.reader.capture(f.sourceRequest);
  for (const [field, value, reason] of [
    ['jsonBytes', normal.budget.jsonBytes - 1, 'SOURCE_JSON_BUDGET'],
    ['evidenceBytes', normal.budget.evidenceBytes - 1, 'SOURCE_EVIDENCE_BUDGET'],
    ['readWorkBytes', normal.budget.batchReadUpperBound - 1, 'SOURCE_READ_WORK_BUDGET'],
  ]) {
    const reader = createDefectTicketSourceReader({ owner: f.owner, limits: { [field]: value } });
    const opens = observeOpens(() => assert.throws(() => reader.capture(f.sourceRequest), rejected(reason, 'CAPACITY')));
    assert.deepEqual(evidenceOpens(opens), [], field);
  }
  // Exactly the independently observed unique budgets remain sufficient.
  const exact = createDefectTicketSourceReader({ owner: f.owner, limits: { jsonBytes: normal.budget.jsonBytes,
    evidenceBytes: normal.budget.evidenceBytes, readWorkBytes: normal.budget.batchReadUpperBound } });
  assert.equal(exact.capture(f.sourceRequest).facts.factsDigest, normal.facts.factsDigest);
});

test('namespace metadata is cumulatively preflighted before opening any dispatch', async t => {
  const f = await fixture(t); f.publish(f.request()); f.publish(f.request());
  const reader = createDefectTicketSourceReader({ owner: f.owner,
    limits: { jsonBytes: readFileSync(join(f.root, 'catalog.json')).length } });
  const opens = observeOpens(() => assert.throws(() => reader.capture(f.sourceRequest), rejected('SOURCE_JSON_BUDGET', 'CAPACITY')));
  assert.deepEqual(opens.filter(path => path.endsWith('dispatch.json')), []);
});

test('manifest/stat size mismatch and unsafe lineage are rejected before full evidence reads', async t => {
  for (const scenario of ['size', 'foreign-before', 'missing-before', 'self-before']) await t.test(scenario, async t => {
    const f = await fixture(t), operation = f.operation({ bug: true });
    if (scenario === 'size') {
      const path = pathOf(f, operation.operationId, join('evidence', operation.value.report.evidenceManifest[0].file));
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('x')]));
    } else {
      const path = pathOf(f, operation.operationId, 'observations.json'), observed = JSON.parse(readFileSync(path));
      if (scenario === 'foreign-before') {
        // A valid completed, registered operation in a different project. Its
        // evidence must not be opened through this forged before edge.
        observed.beforeOperationId = foreignOperation(f);
      } else observed.beforeOperationId = scenario === 'self-before' ? operation.operationId : f.request().operationId;
      writeFileSync(path, encode(observed));
    }
    const opens = observeOpens(() => assert.throws(() => f.reader.capture(f.sourceRequest), rejected(
      scenario === 'size' ? 'EVIDENCE_SIZE_MISMATCH' : 'SOURCE_LINEAGE_UNSAFE')));
    assert.deepEqual(evidenceOpens(opens), []);
  });
});

test('forged observation relations and same-size evidence corruption never produce facts', async t => {
  for (const scenario of ['observation', 'evidence']) await t.test(scenario, async t => {
    const f = await fixture(t), operation = f.operation({ bug: true });
    if (scenario === 'observation') {
      const path = pathOf(f, operation.operationId, 'observations.json'), observed = JSON.parse(readFileSync(path));
      observed.observations[0].relation = 'verified_passed'; writeFileSync(path, encode(observed));
    } else {
      const path = pathOf(f, operation.operationId, join('evidence', operation.value.report.evidenceManifest[0].file));
      const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
    }
    assert.throws(() => f.reader.capture(f.sourceRequest), rejected(scenario === 'evidence' ? 'EVIDENCE_CHANGED' : 'SOURCE_UNAVAILABLE'));
  });
});

test('namespace shape, inode replacement and hard links remain blocked without repairs', async t => {
  for (const scenario of ['unknown', 'rename', 'hardlink']) await t.test(scenario, async t => {
    const f = await fixture(t), operation = f.operation({ bug: true });
    const capture = f.reader.capture(f.sourceRequest), folder = pathOf(f, operation.operationId, '');
    if (scenario === 'unknown') writeFileSync(join(folder, 'unknown.json'), '{}');
    if (scenario === 'rename') { renameSync(folder, folder + '.retained'); mkdirSync(folder); }
    if (scenario === 'hardlink') linkSync(join(folder, 'dispatch.json'), join(f.root, 'linked-dispatch.json'));
    assert.throws(capture.assertCurrent);
    assert.throws(() => f.reader.capture(f.sourceRequest));
    assert.equal(fs.existsSync(scenario === 'unknown' ? join(folder, 'unknown.json')
      : scenario === 'rename' ? folder + '.retained' : join(f.root, 'linked-dispatch.json')), true);
  });
});
