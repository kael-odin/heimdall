/** Harness-only compatibility scene. Existing Browser captures are supplied by
 * the caller. Spec drafts and lifecycle fixtures below are explicit setup;
 * the migration itself must not read a source, dispatch, or evidence file. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { acquireAcceptanceOwner } from '../../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../../src/acceptance/catalog.mjs';
import { currentSelectionsOf } from '../../src/acceptance/catalog-schema.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../../src/acceptance/spec-runner.mjs';
import { createManagedAcceptanceRun, settleManagedAcceptanceRun } from '../../src/acceptance/managed-run-store.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cas = store => { const value = store.read(); return { expectedGenerationId: value.generationId, expectedRevision: value.revision }; };
export function catalogCompatibilityTree(root, sub = '') {
  return fs.readdirSync(join(root, sub)).sort().flatMap(name => {
    const key = sub ? sub + '/' + name : name, path = join(root, key), stat = fs.lstatSync(path, { bigint: true });
    assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) return catalogCompatibilityTree(root, key);
    assert.ok(stat.isFile()); if (key === '.acceptance-owner.json') return [];
    const bytes = fs.readFileSync(path);
    return [{ path: key, bytes: bytes.length, sha256: hash(bytes), nlink: String(stat.nlink),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }];
  });
}
export async function migrateCombinedCatalogFixture(root, targetUrl) {
  const owner = acquireAcceptanceOwner({ root });
  try {
    const store = createAcceptanceCatalogStore({ root, owner }); await store.initialize();
    assert.equal(store.read().schemaVersion, 3);
    const browserBeforeSetup = structuredClone(store.read().browserSourceBindings);
    assert.ok(Object.keys(browserBeforeSetup).length >= 3);
    const project = (await store.createProject({ ...cas(store), name: 'Schema4 Spec 历史兼容夹具' })).project;
    const sourceRelease = (await store.createRelease(project.id, { ...cas(store), label: 'Spec 草稿来源', targetUrl })).release;
    const targetRelease = (await store.createRelease(project.id, { ...cas(store), label: 'Spec 明确目标', targetUrl: targetUrl + '&declared=target' })).release;
    const source = createAcceptanceRun({ name: 'Schema4 draft source', mode: 'spec', targetUrl,
      spec: { source: { id: 'SCHEMA4-COMPATIBILITY', revision: '1' }, approved: false,
        checks: [{ id: 'STATUS', title: '显式状态合同', method: 'GET', path: '/', expect: { status: 200 } }] } }, { root });
    finishAcceptanceRun(source.runId, await runSpecAcceptance(source.plan, { runId: source.runId, outputDir: join(root, source.runId) }), { root });
    await store.bindRun(project.id, { ...cas(store), runId: source.runId, releaseId: sourceRelease.id });
    const candidate = (await store.createBaselineCandidate(project.id, { ...cas(store), mode: 'spec', sourceRunId: source.runId, sourceSide: 'source' })).candidate;
    const approval = (await store.approveBaseline(project.id, { ...cas(store), candidateId: candidate.id,
      contentDigest: candidate.contentDigest, reason: '受控兼容夹具明确批准' })).approval;
    const select = () => store.selectBaseline(project.id, { ...cas(store), mode: 'spec', approvalId: approval.id,
      contentDigest: candidate.contentDigest, reason: '受控兼容夹具明确选用' });
    await select();
    await store.selectBaseline(project.id, { ...cas(store), mode: 'spec', approvalId: null, contentDigest: null, reason: '受控兼容夹具取消选用' });
    const selection = (await select()).selection;
    const dispatches = [];
    for (const reasonCode of [null, 'CANCELLED', 'ENGINE_RESTARTED']) {
      const result = await store.prepareManagedSpecDispatch(project.id, { ...cas(store), operationId: 'ao-' + randomUUID(),
        selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
      const envelope = JSON.parse(result.record.bytes.toString('utf8'));
      const ref = { operationId: envelope.operationId, dispatchSha256: hash(result.record.bytes) };
      if (reasonCode) {
        createManagedAcceptanceRun(ref, { owner, assertActive: () => true });
        settleManagedAcceptanceRun(ref, { status: 'interrupted', reasonCode, error: '受控迁移兼容夹具；未调用执行器。' }, { owner });
      }
      dispatches.push({ operationId: envelope.operationId, runId: envelope.runId, reasonCode,
        fixtureKind: reasonCode ? 'owner-bound-lifecycle-writer-without-runner' : 'prepared-only' });
    }
    const beforeCatalog = store.read(), beforeTree = catalogCompatibilityTree(root), headBytes = fs.readFileSync(join(root, 'catalog.json'));
    const previousBytes = fs.existsSync(join(root, 'catalog.previous.json')) ? fs.readFileSync(join(root, 'catalog.previous.json')) : null;
    assert.deepEqual(beforeCatalog.browserSourceBindings, browserBeforeSetup);
    const forbiddenReads = [], originals = [];
    const sourcePath = path => {
      if (typeof path !== 'string') return false;
      const key = relative(root, path).replaceAll('\\', '/');
      return /^(?:ac-[a-f0-9-]{36}|managed-spec-dispatches)(?:\/|$)/.test(key);
    };
    for (const method of ['readFileSync', 'openSync', 'lstatSync', 'statSync', 'readdirSync', 'opendirSync']) {
      const original = fs[method]; originals.push([method, original]);
      fs[method] = function(path, ...args) {
        if (sourcePath(path)) { forbiddenReads.push({ method, path: relative(root, path).replaceAll('\\', '/') }); throw new Error('MAINTENANCE_SOURCE_READ_FORBIDDEN'); }
        return original.call(this, path, ...args);
      };
    }
    syncBuiltinESMExports();
    let preview, applied;
    try {
      preview = await store.previewMigration({ targetSchemaVersion: 4 });
      applied = await store.applyMigration({ targetSchemaVersion: 4, expectedGenerationId: preview.source.generationId,
        expectedRevision: preview.source.revision, expectedHeadSha256: preview.source.headSha256,
        expectedPreviousSha256: preview.source.previousSha256, expectedPlanDigest: preview.planDigest });
    } finally {
      for (const [method, original] of originals) fs[method] = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(forbiddenReads, []); assert.equal(applied.completedSteps.length, 1);
    const afterCatalog = store.read(), afterTree = catalogCompatibilityTree(root);
    assert.equal(afterCatalog.schemaVersion, 4); assert.equal(afterCatalog.revision, beforeCatalog.revision + 1);
    assert.notEqual(afterCatalog.generationId, beforeCatalog.generationId);
    for (const key of ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'browserSourceBindings']) assert.deepEqual(afterCatalog[key], beforeCatalog[key]);
    assert.deepEqual(afterCatalog.events.slice(0, beforeCatalog.events.length), beforeCatalog.events);
    assert.deepEqual(afterCatalog.browserCandidates, {});
    assert.deepEqual(currentSelectionsOf(afterCatalog, project.id), currentSelectionsOf(beforeCatalog, project.id));
    const unaffected = list => list.filter(item => !['catalog.json', 'catalog.previous.json'].includes(item.path));
    const preimageName = 'catalog.v3.' + hash(headBytes) + '.json';
    const preimageSources = preview.preimages.flatMap(item => item.sources);
    const newPreimageNames = preimageSources.filter(item => !item.alreadyPresent).map(item => item.name).sort();
    assert.ok(newPreimageNames.every(name => /^catalog\.v3\.[a-f0-9]{64}\.json$/.test(name)));
    assert.deepEqual(unaffected(afterTree).filter(item => !newPreimageNames.includes(item.path)), unaffected(beforeTree));
    for (const source of preimageSources) {
      assert.ok(['head', 'previous'].includes(source.origin));
      const raw = source.origin === 'head' ? headBytes : previousBytes;
      assert.ok(raw); assert.equal(hash(raw), source.sha256);
      assert.deepEqual(fs.readFileSync(join(root, source.name)), raw);
    }
    assert.deepEqual(fs.readFileSync(join(root, preimageName)), headBytes);
    assert.deepEqual(fs.readFileSync(join(root, 'catalog.previous.json')), headBytes);
    assert.equal(store.readBaselineCandidate(project.id, candidate.id).diagnostics.contentMatches, true);
    for (const binding of Object.values(browserBeforeSetup)) assert.equal(store.readBrowserSourceBinding(binding.projectId, binding.id).diagnostics.contentMatches, true);
    return { status: 'passed', evidenceLevel: 'fresh-browser-captures-and-explicit-spec-lifecycle-fixtures', projectId: project.id,
      sourceRunId: source.runId, candidateId: candidate.id, selectionId: selection.id, dispatches, preview,
      beforeCatalog, afterCatalog, beforeTree, afterTree, forbiddenSourceReads: forbiddenReads,
      originalBrowserBindingCount: Object.keys(browserBeforeSetup).length, preimageName, newPreimageNames,
      boundary: 'Spec draft, approval/selection/cancel/reselection and three dispatch/lifecycle records are explicit harness setup before migration. No Spec executor or live target request is used. Browser candidates stay empty.' };
  } finally { owner.release(); }
}
