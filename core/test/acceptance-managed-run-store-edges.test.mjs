import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress, finishManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const cas = store => {
  const { generationId, revision } = store.read();
  return { expectedGenerationId: generationId, expectedRevision: revision };
};
const hasTemporary = (dir, name) => fs.readdirSync(dir).some(entry => entry.startsWith(name + '.') && entry.endsWith('.tmp'));
const safeFailure = (action, mayHaveCommitted) => assert.throws(action, error => {
  assert.ok(error.status >= 400);
  assert.equal(error.writeMayHaveCommitted, mayHaveCommitted);
  assert.equal(error.details.reason, 'PUBLISH_GUARD_FAILED');
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});

// This fixture deliberately builds the real approval/selection/dispatch chain.
// It is local to these fault tests so the main store suite can evolve separately.
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-store-edges-')));
  const owner = acquireAcceptanceOwner({ root }), requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json'); response.end('{"code":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    owner.release(); fs.rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const plan = normalizeSpecPlan({ name: 'managed store edge fixture', mode: 'spec', targetUrl: base + '/source', timeoutMs: 1000,
    spec: { source: { id: 'REQ-STORE-EDGES', revision: '1', type: 'manual' }, approved: false,
      checks: [{ id: 'healthy', title: 'healthy', method: 'GET', path: '/healthy', severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize();
  const project = (await catalog.createProject({ ...cas(catalog), name: 'managed edges' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'source', targetUrl: plan.targetUrl })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'target', targetUrl: base + '/target' })).release;
  const source = createAcceptanceRun(plan, { root }), sourceDir = join(root, source.runId);
  finishAcceptanceRun(source.runId, await runSpecAcceptance(plan, { runId: source.runId, outputDir: sourceDir }), { root });
  await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: source.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id,
    contentDigest: candidate.contentDigest, reason: 'approved fixture' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id,
    contentDigest: candidate.contentDigest, reason: 'selected fixture' })).selection;
  const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  const envelope = JSON.parse(record.bytes.toString('utf8')), ref = { operationId: envelope.operationId, dispatchSha256: record.sha256 };
  const dir = join(root, envelope.runId), manifestPath = join(dir, 'manifest.json'), reportPath = join(dir, 'report.json');
  const options = { owner, assertActive: () => true };
  assert.equal(requests.length, 0); assert.equal(fs.existsSync(dir), false);
  return { root, owner, dir, manifestPath, reportPath, ref, options, requests,
    raw: () => runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: dir }) };
}

test('a report appearing after progress preparation blocks the final manifest write and preserves both originals', async t => {
  const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
  const originalManifest = fs.readFileSync(f.manifestPath), partialReport = Buffer.from('{"partial":true}\n');
  let inserted = false;
  safeFailure(() => updateManagedAcceptanceProgress(f.ref, { progress: { kind: 'acceptance-heartbeat' } }, {
    ...f.options, assertActive() {
      if (!inserted && hasTemporary(f.dir, 'manifest.json')) {
        inserted = true; fs.writeFileSync(f.reportPath, partialReport);
      }
      return true;
    },
  }), false);
  assert.equal(inserted, true);
  assert.deepEqual(fs.readFileSync(f.manifestPath), originalManifest);
  assert.deepEqual(fs.readFileSync(f.reportPath), partialReport);
  assert.equal(hasTemporary(f.dir, 'manifest.json'), true);
  assert.equal(f.requests.length, 0);
});

// Freeze only the evidence inode's visible metadata. This exercises byte
// freshness directly, without relying on sleeps or the host clock resolution.
function freezeMetadata(path) {
  const lstat = nativeFs.lstatSync, fstat = nativeFs.fstatSync;
  const frozen = lstat(path, { bigint: true });
  nativeFs.lstatSync = (current, options) => {
    const observed = lstat(current, options);
    return current === path && options?.bigint ? frozen : observed;
  };
  nativeFs.fstatSync = (fd, options) => {
    const observed = fstat(fd, options);
    return options?.bigint && observed.dev === frozen.dev && observed.ino === frozen.ino ? frozen : observed;
  };
  syncBuiltinESMExports();
  return () => { nativeFs.lstatSync = lstat; nativeFs.fstatSync = fstat; syncBuiltinESMExports(); };
}

for (const stage of ['report', 'terminal']) {
  test(`same-length evidence mutation with frozen metadata at ${stage} publication cannot commit completion`, async t => {
    const f = await fixture(t); createManagedAcceptanceRun(f.ref, f.options);
    const raw = await f.raw(), evidencePath = join(f.dir, raw.checks[0].evidence.contract);
    const originalManifest = fs.readFileSync(f.manifestPath), originalEvidence = fs.readFileSync(evidencePath);
    const changedEvidence = Buffer.from(originalEvidence); changedEvidence[0] = changedEvidence[0] === 0x5b ? 0x7b : 0x5b;
    assert.equal(changedEvidence.length, originalEvidence.length); assert.notDeepEqual(changedEvidence, originalEvidence);
    let changed = false, publishedReportBytes;
    const restore = freezeMetadata(evidencePath);
    try {
      safeFailure(() => finishManagedAcceptanceRun(f.ref, raw, {
        ...f.options, assertActive() {
          const publishing = stage === 'report' ? hasTemporary(f.dir, 'report.json')
            : fs.existsSync(f.reportPath) && hasTemporary(f.dir, 'manifest.json');
          if (!changed && publishing) {
            changed = true;
            if (stage === 'terminal') publishedReportBytes = fs.readFileSync(f.reportPath);
            fs.writeFileSync(evidencePath, changedEvidence);
          }
          return true;
        },
      }), stage === 'terminal');
      assert.equal(changed, true);
      assert.deepEqual(fs.readFileSync(f.manifestPath), originalManifest);
      assert.deepEqual(fs.readFileSync(evidencePath), changedEvidence);
      assert.equal(json(f.manifestPath).status, 'running');
      assert.equal(f.requests.length, 1);
      if (stage === 'report') assert.equal(fs.existsSync(f.reportPath), false);
      else {
        const report = json(f.reportPath);
        assert.equal(report.status, 'completed'); assert.equal(report.gate, 'passed');
        const evidence = report.evidenceManifest.find(item => item.file === raw.checks[0].evidence.contract);
        assert.equal(evidence.sha256, sha(originalEvidence));
        assert.notEqual(evidence.sha256, sha(changedEvidence));
        assert.deepEqual(fs.readFileSync(f.reportPath), publishedReportBytes);
      }
      assert.equal(hasTemporary(f.dir, stage === 'report' ? 'report.json' : 'manifest.json'), true);
    } finally { restore(); }
  });
}
