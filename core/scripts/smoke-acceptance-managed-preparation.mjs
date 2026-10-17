#!/usr/bin/env node
/** Real owner/catalog preparation over tracked B2.1 artifacts. No engine,
 * browser or acceptance executor is started; reserved run/task IDs stay inert. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { currentSelectionsOf } from '../src/acceptance/catalog-schema.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = 'docs/audits/2026-10-16/evidence/acceptance-baseline/console';
// Provenance only: the smoke reads tracked files and works in a shallow checkout.
const FIXTURE_COMMIT = '299304b01fb38ff7a933543c82d4aa996eff164f';
const DRAFT = 'ac-1897dc22-0d21-4b6f-95c3-4dd72201063d';
const RUNS = [DRAFT, 'ac-10afe248-c3f9-4b86-b3db-373a55025c05'].sort();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cas = store => { const catalog = store.read(); return { expectedGenerationId: catalog.generationId, expectedRevision: catalog.revision }; };
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const runIds = root => readdirSync(root).filter(name => /^ac-/.test(name)).sort();

async function main() {
  assert.ok(process.argv.length <= 3, 'Usage: node core/scripts/smoke-acceptance-managed-preparation.mjs [new-output-directory]');
  const out = resolve(process.argv[2] ?? join(REPO, 'core', 'workspace', '_runs', 'acceptance-managed-preparation',
    new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)));
  assert.equal(inside(resolve(REPO, FIXTURE), out), false, 'Output must not modify the committed fixture tree.');
  assert.equal(existsSync(out), false, 'Output directory must be new; existing evidence is preserved.');
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  const checks = {}, catalogCheckpoints = [], sourceCheckpoints = [], runCheckpoints = [], requests = [];
  let stage = 'fixture', temporary, acceptanceRoot, owner, fixtureServer, originalFetch, fetchAttempts = 0, failure;
  let first, replay, reopened, fixtureInfo;
  const redact = text => temporary ? text.replaceAll(temporary, '[temporary-root]').replaceAll(temporary.replaceAll('\\', '/'), '[temporary-root]') : text;
  const save = (name, value) => writeFileSync(join(out, name), typeof value === 'string' || Buffer.isBuffer(value)
    ? value : redact(JSON.stringify(value, null, 2) + '\n'));
  const check = (name, assertion) => {
    try { assertion(); checks[name] = true; }
    catch (error) { checks[name] = false; throw error; }
  };
  try {
    const digestBytes = readFileSync(join(REPO, FIXTURE, 'run-file-digests.json'));
    const archivedDigests = JSON.parse(digestBytes.toString('utf8'));
    assert.deepEqual(Object.keys(archivedDigests).sort(), RUNS);
    const committedFiles = new Map();
    for (const runId of RUNS) {
      for (const [name, expectedSha256] of Object.entries(archivedDigests[runId])) {
        assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
        assert.match(expectedSha256, /^[a-f0-9]{64}$/);
        const bytes = readFileSync(join(REPO, FIXTURE, 'run-evidence', runId, name));
        assert.equal(sha(bytes), expectedSha256, runId + '/' + name + ': tracked bytes match archived digest');
        committedFiles.set(runId + '/' + name, bytes);
      }
    }
    const catalogBytes = readFileSync(join(REPO, FIXTURE, 'catalog-storage.json'));
    const expectedSources = Object.fromEntries([...committedFiles].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }]));
    const fixtureSources = () => Object.fromEntries([...committedFiles].map(([name]) => {
      const bytes = readFileSync(join(REPO, FIXTURE, 'run-evidence', name));
      return [name, { bytes: bytes.length, sha256: sha(bytes) }];
    }));
    check('trackedFixtureHasTwoRunsAnd14Files', () => {
      assert.equal(committedFiles.size, 14);
      assert.deepEqual([...new Set([...committedFiles.keys()].map(name => name.split('/')[0]))].sort(), RUNS);
    });
    check('trackedFixtureMatchesArchivedDigests', () => {
      assert.deepEqual(fixtureSources(), expectedSources);
      assert.deepEqual(readFileSync(join(REPO, FIXTURE, 'catalog-storage.json')), catalogBytes);
    });
    fixtureInfo = { evidenceLevel: 'tracked-real-B2.1-artifacts', commit: FIXTURE_COMMIT, path: FIXTURE,
      provenance: 'Historical source commit is recorded only; tracked files and the archived digest index are read directly.',
      digestIndex: { bytes: digestBytes.length, sha256: sha(digestBytes) },
      catalog: { bytes: catalogBytes.length, sha256: sha(catalogBytes) }, sourceFileCount: committedFiles.size,
      runIds: RUNS, sourceFiles: expectedSources };
    save('fixture-source-sha256.json', fixtureInfo);

    temporary = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-managed-preparation-')));
    acceptanceRoot = join(temporary, 'acceptance'); mkdirSync(acceptanceRoot);
    writeFileSync(join(acceptanceRoot, 'catalog.json'), catalogBytes);
    const locations = Object.fromEntries(RUNS.map(id => [id, join(acceptanceRoot, id)]));
    for (const [name, bytes] of committedFiles) {
      const destination = join(acceptanceRoot, name); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes);
    }
    const sourceDigests = () => Object.fromEntries([...committedFiles].map(([name]) => {
      const [runId, ...parts] = name.split('/'), bytes = readFileSync(join(locations[runId], ...parts));
      return [name, { bytes: bytes.length, sha256: sha(bytes) }];
    }));
    const sourcesUnchanged = phase => {
      assert.deepEqual(sourceDigests(), expectedSources, phase + ': all 14 original source bytes remain unchanged');
      sourceCheckpoints.push({ phase, files: committedFiles.size, unchanged: true,
        movedRunIds: RUNS.filter(id => locations[id] !== join(acceptanceRoot, id)) });
    };
    const heads = () => Object.fromEntries(['catalog.json', 'catalog.previous.json'].map(name => [name,
      existsSync(join(acceptanceRoot, name)) ? readFileSync(join(acceptanceRoot, name)) : null]));
    const recordHeads = phase => {
      const snapshot = heads();
      catalogCheckpoints.push({ phase, ...Object.fromEntries(Object.entries(snapshot).map(([name, bytes]) =>
        [name, bytes ? { bytes: bytes.length, sha256: sha(bytes) } : null])) });
      return snapshot;
    };
    const noRunCreated = phase => {
      const ids = runIds(acceptanceRoot), reservedRunExists = first ? existsSync(join(acceptanceRoot, first.record.envelope.runId)) : false;
      assert.ok(ids.length <= RUNS.length); assert.ok(ids.every(id => RUNS.includes(id))); assert.equal(reservedRunExists, false);
      runCheckpoints.push({ phase, activeSourceRunIds: ids, totalSourceRunsIncludingMoved: RUNS.length,
        newRunCount: ids.filter(id => !RUNS.includes(id)).length, reservedRunDirectoryExists: reservedRunExists });
    };

    fixtureServer = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, quota: 10, enabled: false, name: '' }));
    });
    await new Promise((ready, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', ready); });
    const targetUrl = `http://127.0.0.1:${fixtureServer.address().port}/managed-target?tenant=preparation`;
    originalFetch = globalThis.fetch;
    globalThis.fetch = () => { fetchAttempts++; throw new Error('Preparation smoke forbids HTTP execution.'); };
    stage = 'owner-and-selection';
    owner = acquireAcceptanceOwner({ root: acceptanceRoot });
    const store = createAcceptanceCatalogStore({ root: acceptanceRoot, owner }); await store.initialize({ createSchemaVersion: 3 });
    const catalog = store.read(), candidate = Object.values(catalog.candidates).find(item => item.source.runId === DRAFT);
    assert.ok(candidate); const projectId = candidate.projectId;
    const approval = Object.values(catalog.approvals).find(item => item.candidateId === candidate.id && item.contentDigest === candidate.contentDigest);
    assert.ok(approval);
    if (currentSelectionsOf(catalog, projectId).spec?.approvalId === approval.id) {
      await store.selectBaseline(projectId, { ...cas(store), mode: 'spec', approvalId: null, contentDigest: null, reason: '准备 smoke 重新明确选用前清除旧选择' });
    }
    const selection = (await store.selectBaseline(projectId, { ...cas(store), mode: 'spec', approvalId: approval.id,
      contentDigest: approval.contentDigest, reason: '准备 smoke 明确选用已复核的完整草稿需求' })).selection;
    const target = (await store.createRelease(projectId, { ...cas(store), label: '准备内核本地 HTTP 目标', targetUrl,
      buildRef: 'managed-preparation-smoke-no-execution' })).release;
    check('draftApprovalExplicitlyReselected', () => {
      assert.equal(currentSelectionsOf(store.read(), projectId).spec.id, selection.id);
      assert.equal(selection.approvalId, approval.id);
    });
    check('explicitTargetIsSameProjectDistinctRelease', () => { assert.equal(target.projectId, projectId); assert.notEqual(target.id, candidate.source.releaseId); });
    const input = { ...cas(store), operationId: 'ao-' + randomUUID(), selectionId: selection.id,
      contentDigest: candidate.contentDigest, targetReleaseId: target.id };
    save('preparation-input.json', { projectId, ...input });
    sourcesUnchanged('before-prepare'); noRunCreated('before-prepare');
    const before = recordHeads('before-prepare');
    check('missingOperationQueryDoesNotCreateDirectoriesOrRecords', () => {
      const names = readdirSync(acceptanceRoot).sort();
      assert.equal(store.readManagedSpecDispatch(projectId, input), null);
      assert.deepEqual(readdirSync(acceptanceRoot).sort(), names);
      assert.equal(existsSync(join(acceptanceRoot, 'managed-spec-dispatches')), false);
    });
    stage = 'prepare'; first = await store.prepareManagedSpecDispatch(projectId, input);
    save('prepared-record.json', first.record.bytes);
    const envelope = first.record.envelope;
    check('privatePreparationHasNoExecutionOrRun', () => {
      assert.equal(first.state, 'prepared'); assert.equal(first.replayed, false); assert.equal(first.executionReady, false); assert.equal(first.runCreated, false);
    });
    check('originalDraftFactAndApprovedExecutionCopyAreSeparate', () => {
      assert.equal(envelope.sourceSpecApproved, false); assert.equal(envelope.plan.spec.approved, true);
      assert.equal(JSON.parse(readFileSync(join(locations[DRAFT], 'manifest.json'))).plan.spec.approved, false);
    });
    check('provenanceAndExpectedComeFromSelectedSource', () => {
      const sourcePlan = JSON.parse(readFileSync(join(locations[DRAFT], 'manifest.json'))).plan;
      assert.equal(envelope.selection.id, selection.id); assert.equal(envelope.approval.id, approval.id); assert.equal(envelope.candidate.id, candidate.id);
      assert.equal(envelope.sourceRelease.id, candidate.source.releaseId); assert.equal(envelope.targetRelease.id, target.id);
      assert.equal(envelope.plan.targetUrl, targetUrl); assert.deepEqual(envelope.plan.spec, { ...sourcePlan.spec, approved: true });
      assert.equal(envelope.plan.timeoutMs, sourcePlan.timeoutMs); assert.equal(envelope.plan.maxResponseBytes, sourcePlan.maxResponseBytes);
      assert.equal(envelope.planFingerprint, sha(JSON.stringify(envelope.plan)));
      assert.equal(envelope.catalog.headSha256, sha(before['catalog.json']));
    });
    check('preparePreservesCatalogHeadAndPrevious', () => assert.deepEqual(recordHeads('after-prepare'), before));
    check('readOnlyQueryReturnsOriginalPreparedBytes', () => {
      const queried = store.readManagedSpecDispatch(projectId, input);
      assert.equal(queried.sha256, first.record.sha256); assert.deepEqual(queried.bytes, first.record.bytes);
      assert.deepEqual(heads(), before);
    });
    check('readOnlyQueryRejectsChangedConfirmationWithoutPublishing', () => {
      assert.throws(() => store.readManagedSpecDispatch(projectId, { ...input, expectedRevision: input.expectedRevision + 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
      assert.deepEqual(heads(), before);
      assert.deepEqual(readdirSync(join(acceptanceRoot, 'managed-spec-dispatches', 'v1')), [input.operationId + '.json']);
    });
    sourcesUnchanged('after-prepare'); noRunCreated('after-prepare');
    stage = 'same-key-replay'; replay = await store.prepareManagedSpecDispatch(projectId, input);
    check('sameKeyReplayReturnsIdenticalRecord', () => {
      assert.equal(replay.replayed, true); assert.deepEqual(replay.record.bytes, first.record.bytes);
      assert.equal(replay.record.sha256, first.record.sha256); assert.deepEqual(replay.record.envelope, envelope);
    });
    check('replayPreservesCatalogHeadAndPrevious', () => assert.deepEqual(recordHeads('after-replay'), before));
    sourcesUnchanged('after-replay'); noRunCreated('after-replay');

    stage = 'cancel-and-move-source';
    const cancelled = (await store.selectBaseline(projectId, { ...cas(store), mode: 'spec', approvalId: null, contentDigest: null,
      reason: '准备 smoke 取消当前选用后验证已接受操作只读重放' })).selection;
    check('selectionCancelledAfterPreparation', () => assert.equal(cancelled.approvalId, null));
    const movedParent = join(temporary, 'moved-source'); mkdirSync(movedParent);
    const originalSource = locations[DRAFT]; locations[DRAFT] = join(movedParent, DRAFT); renameSync(originalSource, locations[DRAFT]);
    check('sourceUnavailableAtOriginalRunPath', () => assert.equal(existsSync(originalSource), false));
    sourcesUnchanged('after-source-move'); noRunCreated('after-source-move');
    const afterCancellation = recordHeads('after-cancellation-and-move');
    stage = 'release-and-reacquire-owner';
    const oldNonce = owner.nonce; assert.equal(owner.release(), true); owner = null;
    owner = acquireAcceptanceOwner({ root: acceptanceRoot });
    check('realOwnerReleasedAndReacquired', () => { assert.notEqual(owner.nonce, oldNonce); assert.equal(owner.assertOwned(), true); });
    const reopenedStore = createAcceptanceCatalogStore({ root: acceptanceRoot, owner }); await reopenedStore.initialize({ createSchemaVersion: 3 });
    check('readOnlyQueryWithNewOwnerNeedsNeitherCurrentSelectionNorSource', () => {
      const queried = reopenedStore.readManagedSpecDispatch(projectId, input);
      assert.deepEqual(queried.bytes, first.record.bytes); assert.equal(queried.sha256, first.record.sha256);
      assert.equal(existsSync(join(acceptanceRoot, queried.envelope.runId)), false);
      assert.deepEqual(heads(), afterCancellation);
    });
    reopened = await reopenedStore.prepareManagedSpecDispatch(projectId, input);
    check('newOwnerAndCatalogReplayOriginalBytesWithoutSource', () => {
      assert.equal(reopened.replayed, true); assert.equal(reopened.state, 'prepared'); assert.equal(reopened.executionReady, false); assert.equal(reopened.runCreated, false);
      assert.deepEqual(reopened.record.bytes, first.record.bytes); assert.equal(reopened.record.sha256, first.record.sha256);
      assert.equal(reopened.record.envelope.runId, envelope.runId); assert.equal(reopened.record.envelope.dispatchId, envelope.dispatchId);
    });
    check('reopenReplayPreservesCancelledCatalog', () => assert.deepEqual(recordHeads('after-reopen-replay'), afterCancellation));
    sourcesUnchanged('after-reopen-replay'); noRunCreated('after-reopen-replay');
    check('onlyOneImmutablePreparedRecordAndNoTemporaryFiles', () => {
      const names = readdirSync(join(acceptanceRoot, 'managed-spec-dispatches', 'v1')).sort();
      assert.deepEqual(names, [input.operationId + '.json']);
      assert.deepEqual(readFileSync(join(acceptanceRoot, 'managed-spec-dispatches', 'v1', names[0])), first.record.bytes);
    });
    check('originalTrackedFixtureStillUnchanged', () => {
      assert.deepEqual(fixtureSources(), expectedSources); assert.deepEqual(readFileSync(join(REPO, FIXTURE, 'catalog-storage.json')), catalogBytes);
    });
    check('allCopiedSource14FilesUnchangedIncludingMovedSource', () => assert.deepEqual(sourceDigests(), expectedSources));
    check('targetFixtureReceivedZeroRequests', () => assert.equal(requests.length, 0));
    check('preparationAttemptedZeroFetches', () => assert.equal(fetchAttempts, 0));
    save('replay-results.json', { evidenceLevel: 'real-owner-and-private-preparation-kernel', engineRestartTested: false,
      executionTested: false, sameKeyReplay: { replayed: replay.replayed, sha256: replay.record.sha256 },
      afterCancellationSourceMoveAndNewOwner: { replayed: reopened.replayed, sha256: reopened.record.sha256 },
      operationId: envelope.operationId, dispatchId: envelope.dispatchId, reservedRunId: envelope.runId,
      preparedRecordSha256: first.record.sha256, sourceUnavailableAtOriginalPath: true, targetUrl });
    stage = 'complete';
  } catch (error) {
    failure = { stage, name: error.name, code: error.code ?? null, message: redact(String(error.message)) };
    save('failure.json', failure);
  } finally {
    if (originalFetch) globalThis.fetch = originalFetch;
    try { if (owner) assert.equal(owner.release(), true); }
    catch (error) { failure ??= { stage: 'owner-cleanup', message: redact(error.message) }; }
    try { if (fixtureServer?.listening) await new Promise((ready, reject) => fixtureServer.close(error => error ? reject(error) : ready())); }
    catch (error) { failure ??= { stage: 'fixture-cleanup', message: redact(error.message) }; }
    try {
      if (temporary) {
        assert.equal(lstatSync(temporary).isSymbolicLink(), false);
        assert.equal(realpathSync(temporary), temporary);
        assert.ok(inside(realpathSync(tmpdir()), temporary) && temporary !== realpathSync(tmpdir()), 'Cleanup is limited to this run\'s verified temporary root.');
        rmSync(temporary, { recursive: true, force: true });
        checks.ownTemporaryRootCleaned = !existsSync(temporary);
      }
    } catch (error) { checks.ownTemporaryRootCleaned = false; failure ??= { stage: 'temporary-cleanup', message: redact(error.message) }; }
    save('catalog-checkpoints.json', catalogCheckpoints); save('source-checkpoints.json', sourceCheckpoints);
    save('run-checkpoints.json', runCheckpoints); save('fixture-requests.json', { targetRequests: requests, fetchAttempts });
    save('checks.json', checks);
    const quality = { schemaVersion: 1, passed: !failure && Object.values(checks).every(Boolean),
      evidenceLevel: 'real-owner-and-private-preparation-kernel', sourceFixtureCommit: fixtureInfo?.commit ?? null,
      sourceRunCount: fixtureInfo?.runIds.length ?? 0, sourceFileCount: fixtureInfo?.sourceFileCount ?? 0,
      checks: { total: Object.keys(checks).length, passed: Object.values(checks).filter(Boolean).length },
      preparedRecordSha256: first?.record.sha256 ?? null, targetRequests: requests.length, fetchAttempts,
      engineStarted: false, engineRestartTested: false, browserStarted: false, executionTested: false, runCreated: false,
      scope: 'Private preparation, immutable replay and owner release/reacquisition only; reserved IDs do not mean a run exists.',
      failure: failure ?? null };
    save('quality-gates.json', quality);
    console.log(JSON.stringify({ ...quality, outputDirectory: out }, null, 2));
    if (!quality.passed) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
