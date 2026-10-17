import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createAcceptanceRun, finishAcceptanceRun, readAcceptanceSnapshot, readAcceptanceSnapshots } from '../src/acceptance/store.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createManagedAcceptanceRun, finishManagedAcceptanceRun } from '../src/acceptance/managed-run-store.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cas = catalog => { const { generationId, revision } = catalog.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const planOf = targetUrl => normalizeSpecPlan({ mode: 'spec', name: 'batch evidence final fence', targetUrl,
  spec: { source: { id: 'REQ-BATCH-EDGES', revision: '1', type: 'manual' }, approved: false,
    checks: [{ id: 'contract', title: 'contract', method: 'GET', path: '/healthy', severity: 'high', expect: { status: 200 } }] } });
async function legacy(root, plan) {
  const manifest = createAcceptanceRun(plan, { root }), dir = join(root, manifest.runId);
  finishAcceptanceRun(manifest.runId, await runSpecAcceptance(plan, { runId: manifest.runId, outputDir: dir }), { root });
  return { runId: manifest.runId, dir };
}
function tree(root, prefix = '') {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name, path = join(root, entry.name);
    return entry.isDirectory() ? Object.entries(tree(path, name + '/')) : [[name, sha(fs.readFileSync(path))]];
  }));
}
async function fixture(t, managed) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-batch-edges-')));
  const owner = managed ? acquireAcceptanceOwner({ root }) : null, requests = [];
  let server, targetUrl = 'http://127.0.0.1:9';
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    owner?.release(); fs.rmSync(root, { recursive: true, force: true });
  });
  if (managed) {
    server = createServer((request, response) => { requests.push(request.url); response.end('healthy'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    targetUrl = 'http://127.0.0.1:' + server.address().port;
  }
  const plan = planOf(targetUrl + '/source'), first = await legacy(root, plan);
  if (!managed) return { root, first, second: await legacy(root, plan), requests };
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize({ createSchemaVersion: 3 });
  const project = (await catalog.createProject({ ...cas(catalog), name: 'mixed batch final fence' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'source', targetUrl: plan.targetUrl })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'target', targetUrl: targetUrl + '/target' })).release;
  await catalog.bindRun(project.id, { ...cas(catalog), runId: first.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: first.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: 'approved' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id, contentDigest: candidate.contentDigest, reason: 'selected' })).selection;
  const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  const envelope = JSON.parse(record.bytes), ref = { operationId: envelope.operationId, dispatchSha256: record.sha256 };
  const options = { owner, assertActive: () => true }, dir = join(root, envelope.runId);
  createManagedAcceptanceRun(ref, options);
  finishManagedAcceptanceRun(ref, await runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: dir }), options);
  assert.equal(requests.length, 1);
  return { root, first, second: { runId: envelope.runId, dir }, requests };
}

// The first legacy snapshot has already validated this evidence when the
// reader starts the second run. The final batch fence must invalidate both
// results; another fresh call observing the corruption is too late.
for (const managed of [false, true]) test(`later ${managed ? 'managed' : 'legacy'} capture detects earlier legacy evidence changes and preserves the damaged bytes`, async t => {
  const f = await fixture(t, managed), ids = [f.first.runId, f.second.runId];
  const initial = readAcceptanceSnapshots(ids, { root: f.root });
  for (const snapshot of initial) {
    assert.equal(snapshot.integrity.valid, true); assert.equal(snapshot.integrity.evidenceVerified, true);
  }
  const name = Object.values(initial[0].report.checks[0].evidence)[0], path = join(f.first.dir, name);
  const original = fs.readFileSync(path), replacement = Buffer.from('{"changedDuringLaterRun":true}\n');
  assert.equal(original.equals(replacement), false);
  const before = tree(f.root), expectedRequests = f.requests.length, open = nativeFs.openSync;
  let changed = false, snapshots;
  nativeFs.openSync = (current, ...args) => {
    if (!changed && String(current) === join(f.second.dir, 'manifest.json')) {
      changed = true; fs.writeFileSync(path, replacement);
    }
    return open(current, ...args);
  };
  syncBuiltinESMExports();
  try { snapshots = readAcceptanceSnapshots(ids, { root: f.root }); }
  finally { nativeFs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(changed, true, 'fault must happen while opening the later run');
  assert.equal(snapshots.length, 2);
  for (const [index, snapshot] of snapshots.entries()) {
    assert.equal(snapshot.manifest.runId, ids[index]); assert.equal(snapshot.report, null);
    assert.equal(snapshot.integrity.valid, false); assert.equal(snapshot.integrity.evidenceVerified, false);
    assert.equal(snapshot.integrity.reportSha256, null); assert.equal(snapshot.integrity.verifiedFiles, 0);
    assert.ok(snapshot.integrity.errors.length > 0);
    assert.doesNotMatch(JSON.stringify(snapshot.integrity.errors), /[A-Z]:\\|\/tmp\//);
  }
  assert.deepEqual(fs.readFileSync(path), replacement);
  const after = tree(f.root), changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]);
  assert.deepEqual(changedFiles, [relative(f.root, path).replaceAll('\\', '/')]);
  assert.equal(f.requests.length, expectedRequests);
  assert.equal(readAcceptanceSnapshot(f.first.runId, { root: f.root }).integrity.valid, false);
});
