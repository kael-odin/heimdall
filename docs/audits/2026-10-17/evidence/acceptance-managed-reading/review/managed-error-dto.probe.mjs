import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { acquireAcceptanceOwner } from '../../../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../../../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../../../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../../../src/acceptance/spec-runner.mjs';
import { normalizeSpecPlan } from '../../../src/acceptance/spec-schema.mjs';
import { summarizeAcceptanceReport } from '../../../src/acceptance/report.mjs';
import { ManagedAcceptanceRunError } from '../../../src/acceptance/managed-run-schema.mjs';
import { createManagedAcceptanceRun, updateManagedAcceptanceProgress, finishManagedAcceptanceRun, settleManagedAcceptanceRun } from '../../../src/acceptance/managed-run-store.mjs';
import { validateManagedRunHead, validateManagedCompletedSnapshot } from '../../../src/acceptance/managed-snapshot-schema.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const cloneFiles = files => new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
const rejected = action => assert.throws(action, error => {
  assert.ok(error instanceof ManagedAcceptanceRunError);
  assert.equal(error.code, 'MANAGED_RUN_INTEGRITY_FAILED'); assert.equal(error.status, 409);
  assert.deepEqual(error.details, { reason: 'INVALID_INPUT' });
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});
const headInput = f => ({ record: f.record, manifestBytes: f.manifestBytes, manifest: f.manifest });
const inputOf = f => ({ ...headInput(f), manifest: copy(f.manifest), report: copy(f.report), reportBytes: Buffer.from(f.reportBytes), files: cloneFiles(f.files) });
const repack = input => {
  input.reportBytes = encode(input.report);
  if (input.manifest.status === 'completed') input.manifest.reportSha256 = sha(input.reportBytes);
  input.manifestBytes = encode(input.manifest); return input;
};
const resummarize = input => {
  input.report = summarizeAcceptanceReport(input.report);
  input.manifest.gate = input.report.gate; input.manifest.summary = copy(input.report.summary);
  return repack(input);
};

async function fixture(t, paths = ['/healthy', '/bug', '/large'], complete = true) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-snapshot-'))), requests = [];
  const owner = acquireAcceptanceOwner({ root });
  const server = createServer((request, response) => {
    requests.push(request.url); response.setHeader('content-type', 'application/json');
    response.end(request.url.endsWith('/bug') ? '{"code":9}' : request.url.endsWith('/large')
      ? JSON.stringify({ code: 0, payload: 'x'.repeat(2048) }) : '{"code":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const plan = normalizeSpecPlan({ name: 'pure managed snapshot', mode: 'spec', targetUrl: base + '/source', maxResponseBytes: 1024,
    spec: { source: { id: 'REQ-SNAPSHOT', revision: '1', type: 'manual' }, approved: false,
      checks: paths.map((path, index) => ({ id: 'check-' + index, title: path, method: 'GET', path, severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize();
  const project = (await catalog.createProject({ ...cas(catalog), name: 'snapshot fixture' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'source', targetUrl: plan.targetUrl })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: 'target', targetUrl: base + '/target' })).release;
  const source = createAcceptanceRun(plan, { root }), sourceDir = join(root, source.runId);
  finishAcceptanceRun(source.runId, await runSpecAcceptance(plan, { runId: source.runId, outputDir: sourceDir }), { root });
  await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: source.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: 'approved' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id, contentDigest: candidate.contentDigest, reason: 'selected' })).selection;
  const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
  const envelope = JSON.parse(record.bytes), ref = { operationId: envelope.operationId, dispatchSha256: record.sha256 };
  const options = { owner, assertActive: () => true }, dir = join(root, envelope.runId);
  createManagedAcceptanceRun(ref, options);
  const runningBytes = fs.readFileSync(join(dir, 'manifest.json')), running = JSON.parse(runningBytes);
  assert.equal(requests.length, 0);
  const f = { record, envelope, root, dir, ref, options, requests, runningBytes, running,
    manifestBytes: runningBytes, manifest: running };
  if (!complete) return f;
  const raw = await runSpecAcceptance(envelope.plan, { runId: envelope.runId, outputDir: dir });
  finishManagedAcceptanceRun(ref, raw, options);
  f.manifestBytes = fs.readFileSync(join(dir, 'manifest.json')); f.manifest = JSON.parse(f.manifestBytes);
  f.reportBytes = fs.readFileSync(join(dir, 'report.json')); f.report = JSON.parse(f.reportBytes);
  f.files = new Map(f.report.evidenceManifest.map(entry => [entry.file, fs.readFileSync(join(dir, entry.file))]));
  return f;
}

import { readAcceptanceRun } from '../../../src/acceptance/store.mjs';
import { acceptanceRunView } from '../../../src/acceptance/run-view.mjs';
const cleanups=[];
try {
 const f=await fixture({after:fn=>cleanups.push(fn)},['/healthy'],false);
 const raw='ENOENT: C:\\private\\credentials.json SECRET_TOKEN';
 settleManagedAcceptanceRun(f.ref,{status:'failed',reasonCode:'EXECUTION_FAILED',error:raw},f.options);
 const head=readAcceptanceRun(f.envelope.runId,{root:f.root});
 const dto=acceptanceRunView(head,{includePlan:true});
 console.log(JSON.stringify({status:dto.status,error:dto.error,errorUnchanged:dto.error===raw,hasAbsolutePath:/[A-Z]:\\/.test(dto.error),hasPrivatePlan:Object.hasOwn(dto,'plan'),hasManagedEnvelope:Object.hasOwn(dto,'managed'),targetRequests:f.requests.length},null,2));
} finally { for(const cleanup of cleanups.reverse()) await cleanup(); }