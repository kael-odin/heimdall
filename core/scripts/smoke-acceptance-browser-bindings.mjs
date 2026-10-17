#!/usr/bin/env node
/** Fresh controlled Chromium capture -> real owner/catalog -> explicit Browser-side binding. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { readBrowserCandidateSource } from '../src/acceptance/browser-candidate-source.mjs';
import { projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';
import { browserBindingProjectionOf } from '../src/acceptance/catalog-schema.mjs';
import { createAcceptanceRun, acceptanceRunDir, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';

assert.ok(process.argv.length <= 3, 'Usage: node core/scripts/smoke-acceptance-browser-bindings.mjs [new-output-directory]');
const CORE = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs',
  'browser-bindings-smoke-' + randomUUID()));
fs.mkdirSync(dirname(OUT), { recursive: true });
fs.mkdirSync(OUT); // New-only output; interrupted runs and their evidence remain intact.
const ROOT = join(OUT, 'runtime', 'acceptance');
fs.mkdirSync(ROOT, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const parse = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (name, value) => fs.writeFileSync(join(OUT, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value), { flag: 'wx' });
const cas = store => { const { generationId, revision } = store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const checks = {}, samples = [], records = [], rejections = [], targetRequests = [], forbiddenEvents = [];
let phase = 'capture', owner, server, store, failure, requestCountAtBinding = 0, bindingFetchAttempts = 0;
let restoreGuards = () => {};
const startedAt = new Date().toISOString();

function check(name, assertion) {
  try { assertion(); checks[name] = true; }
  catch (error) { checks[name] = false; throw error; }
}
function runFiles(directory, metadata = false) {
  return fs.readdirSync(directory).sort().map(file => {
    const path = join(directory, file), stat = fs.lstatSync(path, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Fresh run contains regular files only.');
    return { file, bytes: Number(stat.size), sha256: sha(fs.readFileSync(path)),
      ...(metadata ? { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), nlink: String(stat.nlink),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } : {}) };
  });
}
function copyRun(sample) {
  const parent = join(OUT, 'runs');
  if (!fs.existsSync(parent)) fs.mkdirSync(parent);
  const destination = join(parent, sample.mode + '-' + sample.runId);
  fs.mkdirSync(destination);
  for (const entry of sample.originalFiles) fs.writeFileSync(join(destination, entry.file), fs.readFileSync(join(sample.directory, entry.file)), { flag: 'wx' });
  assert.deepEqual(runFiles(destination), sample.originalFiles);
  return relative(OUT, destination).replaceAll('\\', '/');
}
function publicData(value, path = 'result') {
  assert.ok(!Buffer.isBuffer(value) && !(value instanceof Map) && !(value instanceof Set), path + ' contains private bytes or collections.');
  if (!value || typeof value !== 'object') { assert.notEqual(typeof value, 'function', path); return; }
  assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, path);
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['plan', 'normalizedPlan', 'owner', 'files', 'snapshot', 'preCommitGuard'].includes(key), path + '.' + key);
    publicData(child, path + '.' + key);
  }
}
function verifyOracle(preview, material, side) {
  assert.ok(preview.observations.length > 0);
  for (const observation of preview.observations) {
    const evidence = observation.evidence;
    assert.ok(evidence.details.file.endsWith('-' + side + '.json'));
    assert.ok(evidence.screenshot.file.endsWith('-' + side + '.png'));
    assert.ok(evidence.repeat.file.endsWith('-' + side + '-repeat.png'));
    for (const item of Object.values(evidence)) {
      const bytes = material.files.get(item.file);
      assert.ok(Buffer.isBuffer(bytes)); assert.equal(item.bytes, bytes.length); assert.equal(item.sha256, sha(bytes));
    }
    const details = JSON.parse(material.files.get(evidence.details.file));
    assert.equal(observation.expected.httpStatus, details.httpStatus);
    assert.deepEqual(observation.expected.structure, { title: details.snapshot.title, headings: details.snapshot.headings, controls: details.snapshot.controls });
    assert.equal(observation.expected.screenshotSha256, sha(material.files.get(evidence.screenshot.file)));
    if (observation.slot.pointId) assert.deepEqual(observation.expected.observedAssertions, details.assertions);
  }
}
function catalogHeads() {
  return Object.fromEntries(['catalog.json', 'catalog.previous.json'].map(file => [file,
    fs.existsSync(join(ROOT, file)) ? fs.readFileSync(join(ROOT, file)) : null]));
}
async function rejectUnchanged(label, operation, code) {
  const before = catalogHeads();
  let caught;
  try { await operation(); }
  catch (error) { caught = error; }
  assert.ok(caught, label + ' should reject.');
  assert.equal(caught.code, code, label + ': ' + caught.message);
  assert.deepEqual(catalogHeads(), before, label + ' changed catalog head/previous.');
  rejections.push({ label, code: caught.code, status: caught.status, details: caught.details ?? null });
}
function closeServer() {
  return new Promise((ready, reject) => {
    if (!server?.listening) return ready();
    server.close(error => error ? reject(error) : ready()); server.closeAllConnections();
  });
}
function controlledHtml(side) {
  const target = side === 'target';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Browser binding controlled fixture</title><style>
  *{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial,sans-serif;background:#f1f4f8;color:#182438}header{height:64px;padding:0 20px;background:#182438;color:white;display:flex;align-items:center;justify-content:space-between}button{font:inherit;padding:8px 14px}main{margin:28px auto;padding:0 20px;max-width:900px}h1{font-size:30px}.panel{height:240px;padding:24px;border:1px solid #c8d2df;background:${target ? '#9b2c12' : '#ffffff'};color:${target ? '#ffffff' : '#182438'};transform:translateY(${target ? '100px' : '0'})}.menu[hidden]{display:none}.menu{padding:12px;background:#dbeafe;color:#182438}@media(max-width:500px){main{padding:0 14px}h1{font-size:24px}.panel{height:280px}}
  </style></head><body><header><strong>NORTHSTAR</strong><button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button></header><main><h1>Controlled project status</h1><nav id="menu" class="menu" hidden><a href="details">Project details</a></nav><section class="panel"><h2>Release evidence</h2><p>128 controlled tasks remaining</p><a href="details">View details</a></section></main><script>document.getElementById('menu-toggle').addEventListener('click',function(){const menu=document.getElementById('menu');menu.hidden=!menu.hidden;this.setAttribute('aria-expanded',String(!menu.hidden))})</script></body></html>`;
}

try {
  server = createServer((request, response) => {
    targetRequests.push({ phase, method: request.method, url: request.url, at: new Date().toISOString() });
    const path = new URL(request.url, 'http://controlled.invalid').pathname;
    const side = path.split('/')[1];
    response.setHeader('Cache-Control', 'no-store');
    if (!['baseline', 'target'].includes(side) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Controlled fixture route only.'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? '' : controlledHtml(side));
  });
  server.requestTimeout = 10000;
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  save('controlled-fixture.html', controlledHtml('baseline'));
  save('controlled-target.html', controlledHtml('target'));
  for (const mode of ['mirror', 'regression']) {
    const input = { name: 'Fresh ' + mode + ' Browser source binding', mode,
      baselineUrl: origin + '/baseline?build=approved&channel=stable',
      targetUrl: origin + '/target?build=current&channel=development', routes: ['/'],
      viewports: [{ name: 'desktop', width: 960, height: 640 }, { name: 'mobile', width: 375, height: 812 }],
      points: [{ id: 'menu', title: 'Menu expands with declared state', route: '/', severity: 'high',
        steps: [{ action: 'click', selector: '#menu-toggle' }], assertions: [
          { kind: 'visible', selector: '#menu' }, { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' }] }],
      timeoutMs: 5000, settleMs: 50 };
    const initial = createAcceptanceRun(input, { root: ROOT }), directory = acceptanceRunDir(initial.runId, ROOT);
    const requestStart = targetRequests.length;
    const report = finishAcceptanceRun(initial.runId, await runAcceptance(initial.plan, { runId: initial.runId, outputDir: directory }), { root: ROOT });
    const manifest = parse(join(directory, 'manifest.json'));
    const sample = { mode, runId: initial.runId, directory, gate: report.gate, checks: report.checks.length,
      baselineUrl: initial.plan.baselineUrl, targetUrl: initial.plan.targetUrl,
      captureRequests: targetRequests.length - requestStart, originalFiles: runFiles(directory), originalMetadata: runFiles(directory, true) };
    samples.push(sample); sample.archivedRun = copyRun(sample);
    check(mode + ':freshCompletedFailedComparison', () => {
      assert.equal(manifest.status, 'completed'); assert.equal(report.mode, mode); assert.equal(report.gate, 'failed');
      assert.equal(report.checks.length, 14); assert.ok(sample.captureRequests > 0);
    });
    check(mode + ':completionDigestsMatchOriginalBytes', () => {
      assert.equal(manifest.reportSha256, sha(fs.readFileSync(join(directory, 'report.json'))));
      for (const evidence of report.evidenceManifest) {
        const bytes = fs.readFileSync(join(directory, evidence.file)); assert.equal(bytes.length, evidence.bytes); assert.equal(sha(bytes), evidence.sha256);
      }
    });
    console.log(json({ phase: 'capture', mode, runId: sample.runId, gate: sample.gate, checks: sample.checks, targetRequests: sample.captureRequests }));
  }

  owner = acquireAcceptanceOwner({ root: ROOT });
  requestCountAtBinding = targetRequests.length; phase = 'binding-and-read';
  const launchOriginals = [];
  const originalFetch = globalThis.fetch;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    launchOriginals.push([name, childProcess[name]]);
    childProcess[name] = () => { forbiddenEvents.push(name); throw new Error('Browser source binding must not launch a process.'); };
  }
  globalThis.fetch = () => { bindingFetchAttempts++; throw new Error('Browser source binding must not fetch.'); };
  syncBuiltinESMExports();
  restoreGuards = () => {
    for (const [name, original] of launchOriginals) childProcess[name] = original;
    globalThis.fetch = originalFetch; syncBuiltinESMExports();
  };
  store = createAcceptanceCatalogStore({ root: ROOT, owner });
  await store.initialize({ createSchemaVersion: 3 });
  for (const sample of samples) {
    const material = readBrowserCandidateSource(sample.runId, { root: ROOT, owner });
    const projected = Object.fromEntries(['baseline', 'target'].map(sourceSide => [sourceSide,
      projectBrowserBaselineCandidate(material, { sourceSide })]));
    check(sample.mode + ':bothHealthySidesHaveIndependentOracle', () => {
      assert.notEqual(projected.baseline.projection.oracleManifestKey, projected.target.projection.oracleManifestKey);
      for (const side of ['baseline', 'target']) { assert.equal(projected[side].preview.sourceGate, 'failed'); assert.equal(projected[side].preview.executionReady, false); }
    });
    check(sample.mode + ':plannedEntryQueryIdentityRetained', () => {
      for (const side of ['baseline', 'target']) assert.equal(projected[side].projection.source.entryUrl, sample[side + 'Url']);
      assert.ok(projected.target.preview.observations.every(item => item.plannedUrl.includes('build=current&channel=development')));
      assert.ok(projected.target.preview.observations.every(item => !item.observedFinalUrl.includes('build=current')));
    });
    const baselineProject = (await store.createProject({ ...cas(store), name: sample.mode + ' baseline archive' })).project;
    const targetProject = (await store.createProject({ ...cas(store), name: sample.mode + ' target archive' })).project;
    const baselineRelease = (await store.createRelease(baselineProject.id, { ...cas(store), label: 'Approved baseline', targetUrl: sample.baselineUrl })).release;
    const targetRelease = (await store.createRelease(targetProject.id, { ...cas(store), label: 'Observed target', targetUrl: sample.targetUrl })).release;
    const context = { baseline: { project: baselineProject, release: baselineRelease }, target: { project: targetProject, release: targetRelease } };
    const bindInput = side => ({ ...cas(store), runId: sample.runId, sourceSide: side, releaseId: context[side].release.id });
    if (sample.mode === 'mirror') {
      for (const [label, wrongUrl] of [
        ['query-value', sample.baselineUrl.replace('build=approved', 'build=other')],
        ['query-order', origin + '/baseline?channel=stable&build=approved'],
        ['missing-query', origin + '/baseline'],
      ]) {
        const wrong = (await store.createRelease(baselineProject.id, { ...cas(store), label: 'Wrong entry ' + label, targetUrl: wrongUrl })).release;
        await rejectUnchanged('full-entry-url-' + label, () => store.bindBrowserSource(baselineProject.id,
          { ...cas(store), runId: sample.runId, sourceSide: 'baseline', releaseId: wrong.id }), 'PROJECT_MISMATCH');
      }
      check('fullPlannedEntryUrlRejectsQueryValueOrderAndOmission', () => assert.equal(rejections.filter(item => item.label.startsWith('full-entry-url-')).length, 3));
      await store.bindRun(targetProject.id, { ...cas(store), runId: sample.runId, releaseId: targetRelease.id });
      const wrongTarget = (await store.createRelease(baselineProject.id, { ...cas(store), label: 'Same target entry different context', targetUrl: sample.targetUrl })).release;
      await rejectUnchanged('browser-target-cannot-diverge-from-legacy-project', () => store.bindBrowserSource(baselineProject.id,
        { ...cas(store), runId: sample.runId, sourceSide: 'target', releaseId: wrongTarget.id }), 'PROJECT_MISMATCH');
    }
    const baseline = await store.bindBrowserSource(baselineProject.id, bindInput('baseline'));
    const target = await store.bindBrowserSource(targetProject.id, bindInput('target'));
    check(sample.mode + ':explicitSidesBindAcrossDifferentProjects', () => {
      assert.notEqual(baseline.binding.projectId, target.binding.projectId);
      for (const [side, result] of [['baseline', baseline], ['target', target]]) {
        assert.equal(result.event.kind, 'browser-source-bound'); assert.equal(result.event.entityId, result.binding.id);
        assert.equal(result.executionReady, false); assert.equal(result.binding.source.side, side);
        assert.deepEqual(browserBindingProjectionOf(result.binding), projected[side].projection);
      }
    });
    if (sample.mode === 'regression') {
      const wrongRelease = (await store.createRelease(baselineProject.id, { ...cas(store), label: 'Same target URL different project', targetUrl: sample.targetUrl })).release;
      await rejectUnchanged('legacy-target-cannot-follow-browser-into-different-project', () => store.bindRun(baselineProject.id,
        { ...cas(store), runId: sample.runId, releaseId: wrongRelease.id }), 'PROJECT_MISMATCH');
      await store.bindRun(targetProject.id, { ...cas(store), runId: sample.runId, releaseId: targetRelease.id });
    }
    const reads = { baseline: store.readBrowserSourceBinding(baselineProject.id, baseline.binding.id),
      target: store.readBrowserSourceBinding(targetProject.id, target.binding.id) };
    check(sample.mode + ':singleReadsRevalidateExactStoredProjection', () => {
      for (const side of ['baseline', 'target']) {
        assert.deepEqual(browserBindingProjectionOf(reads[side].binding), projected[side].projection);
        assert.equal(reads[side].diagnostics.eligible, true); assert.equal(reads[side].diagnostics.contentMatches, true);
        assert.equal(reads[side].executionReady, false); assert.deepEqual(reads[side].preview, projected[side].preview);
      }
    });
    check(sample.mode + ':previewsRebuildSelectedRawDetailsAndPngOracle', () => {
      for (const side of ['baseline', 'target']) verifyOracle(reads[side].preview, material, side);
    });
    check(sample.mode + ':productPreservesOriginalRunBytesAndMetadata', () => assert.deepEqual(runFiles(sample.directory, true), sample.originalMetadata));
    records.push({ mode: sample.mode, runId: sample.runId, contexts: context, bindings: { baseline, target }, reads, projections: projected });
  }

  check('legacyTargetBothMutationOrdersKeepBaselineIndependent', () => {
    const catalog = store.read();
    for (const record of records) {
      const legacy = catalog.runBindings[record.runId], target = record.bindings.target.binding;
      assert.equal(legacy.projectId, target.projectId); assert.equal(legacy.releaseId, target.releaseId);
      assert.notEqual(record.bindings.baseline.binding.projectId, legacy.projectId);
    }
  });
  const first = records[0], originalSample = samples[0];
  await rejectUnchanged('same-side-cannot-rebind-across-projects', () => store.bindBrowserSource(first.contexts.target.project.id,
    { ...cas(store), runId: first.runId, sourceSide: 'baseline', releaseId: first.contexts.target.release.id }), 'CONTEXT_ALREADY_BOUND');
  check('sameRunAndSideGloballyUnique', () => assert.equal(Object.keys(store.read().browserSourceBindings).length, 4));
  const stale = { ...cas(store), runId: first.runId, sourceSide: 'baseline', releaseId: first.contexts.baseline.release.id };
  await store.createProject({ ...cas(store), name: 'CAS advancement evidence' });
  await rejectUnchanged('stale-cas-before-side-rebinding', () => store.bindBrowserSource(first.contexts.baseline.project.id, stale), 'STALE_REVISION');
  check('staleCasDoesNotAdvanceCatalog', () => assert.equal(rejections.at(-1).code, 'STALE_REVISION'));
  for (const [label, patch] of [['missing-side', {}], ['implicit-source-side', { sourceSide: 'source' }], ['forged-projection', { sourceSide: 'baseline', projection: {} }]]) {
    await rejectUnchanged(label, () => store.bindBrowserSource(first.contexts.baseline.project.id,
      { ...cas(store), runId: first.runId, releaseId: first.contexts.baseline.release.id, ...patch }), 'INVALID_INPUT');
  }
  check('sideIsExplicitAndClientProjectionRejected', () => assert.ok(rejections.filter(item => ['missing-side', 'implicit-source-side', 'forged-projection'].includes(item.label)).every(item => item.code === 'INVALID_INPUT')));
  await rejectUnchanged('browser-candidate-stays-disabled', () => store.createBaselineCandidate(first.contexts.target.project.id,
    { ...cas(store), mode: 'browser', sourceRunId: first.runId, sourceSide: 'target' }), 'INVALID_INPUT');
  await rejectUnchanged('binding-id-is-not-an-approval-candidate', () => store.approveBaseline(first.contexts.target.project.id,
    { ...cas(store), candidateId: first.bindings.target.binding.id, contentDigest: first.bindings.target.binding.sourceContentDigest, reason: 'Binding is not approval authority' }), 'INVALID_INPUT');
  await rejectUnchanged('browser-selection-stays-disabled', () => store.selectBaseline(first.contexts.target.project.id,
    { ...cas(store), mode: 'browser', approvalId: null, contentDigest: null, reason: 'Browser selection is closed' }), 'INVALID_INPUT');
  check('browserCandidateApprovalAndSelectionRemainClosed', () => assert.deepEqual(['candidates', 'approvals', 'selections'].map(name => Object.keys(store.read()[name]).length), [0, 0, 0]));
  await rejectUnchanged('binding-is-not-managed-execution-authority', () => store.prepareManagedSpecDispatch(first.contexts.target.project.id,
    { ...cas(store), operationId: 'ao-' + randomUUID(), selectionId: 'as-' + randomUUID(), contentDigest: first.bindings.target.binding.sourceContentDigest,
      targetReleaseId: first.contexts.target.release.id }), 'BASELINE_CHANGED');
  check('browserBindingCannotPrepareOrCreateExecution', () => {
    assert.equal(fs.readdirSync(ROOT).filter(name => /^ac-/.test(name)).length, 2);
    const dispatch = join(ROOT, 'managed-spec-dispatches', 'v1');
    assert.equal(fs.existsSync(dispatch) ? fs.readdirSync(dispatch).filter(name => name.endsWith('.json')).length : 0, 0);
  });

  const reportPath = join(originalSample.directory, 'report.json'), originalReport = fs.readFileSync(reportPath);
  const beforeDiagnostic = catalogHeads();
  let diagnostic;
  phase = 'test-source-change-and-read';
  try {
    fs.appendFileSync(reportPath, ' '); // Explicit test injection; product is expected to read only.
    diagnostic = store.readBrowserSourceBinding(first.contexts.baseline.project.id, first.bindings.baseline.binding.id);
    check('changedSourceReturnsSafeReadOnlyDiagnostics', () => {
      assert.equal(diagnostic.preview, null); assert.equal(diagnostic.diagnostics.eligible, false);
      assert.equal(diagnostic.diagnostics.contentMatches, false); assert.equal(diagnostic.executionReady, false);
      assert.deepEqual(diagnostic.binding, first.bindings.baseline.binding); assert.deepEqual(catalogHeads(), beforeDiagnostic);
      assert.equal(JSON.stringify(diagnostic.diagnostics).includes(OUT), false);
      assert.equal(Object.hasOwn(diagnostic, 'cause'), false);
    });
  } finally { fs.writeFileSync(reportPath, originalReport); }
  const recovered = store.readBrowserSourceBinding(first.contexts.baseline.project.id, first.bindings.baseline.binding.id);
  check('sourceRestorationRevalidatesWithoutRewritingHistory', () => {
    assert.equal(recovered.diagnostics.eligible, true); assert.deepEqual(catalogHeads(), beforeDiagnostic);
    assert.deepEqual(runFiles(originalSample.directory), originalSample.originalFiles);
  });
  records.push({ scenario: 'explicit-test-source-change', runId: first.runId, bindingId: first.bindings.baseline.binding.id,
    injectedChange: 'One report whitespace byte; restored from saved original after diagnostic.', diagnostic, recovered });
  const catalog = store.read(); validateAcceptanceCatalog(catalog);
  check('catalogStoresOnlyBindingsAndNoSpecAuthority', () => {
    assert.equal(catalog.schemaVersion, 3); assert.equal(Object.keys(catalog.browserSourceBindings).length, 4);
    assert.deepEqual(['candidates', 'approvals', 'selections'].map(name => Object.keys(catalog[name]).length), [0, 0, 0]);
    assert.equal(catalog.events.filter(event => event.kind === 'browser-source-bound').length, 4);
  });
  check('dtoDoesNotExposePrivatePlansBuffersOrMaps', () => {
    for (const record of records) {
      if (record.bindings) { publicData(record.bindings); publicData(record.reads); }
      else { publicData(record.diagnostic); publicData(record.recovered); }
    }
  });
  check('zeroTargetRequestsAndFetchesAfterCapture', () => {
    assert.equal(targetRequests.length, requestCountAtBinding); assert.equal(bindingFetchAttempts, 0);
    assert.equal(targetRequests.filter(item => item.phase !== 'capture').length, 0);
  });
  check('zeroProcessLaunchesDuringBindingAndReads', () => assert.deepEqual(forbiddenEvents, []));
  check('allOriginalAndArchivedRunBytesRemainIdentical', () => {
    for (const sample of samples) {
      assert.deepEqual(runFiles(sample.directory), sample.originalFiles);
      assert.deepEqual(runFiles(join(OUT, sample.archivedRun)), sample.originalFiles);
    }
  });
  assert.ok(Object.values(checks).every(Boolean), json(checks));
  restoreGuards(); restoreGuards = () => {};
  save('catalog-final.json', catalog);
  save('bindings-and-previews.json', records);
  save('capture-index.json', { schemaVersion: 1, origin, samples: samples.map(({ directory, originalMetadata, ...sample }) => ({
    ...sample, runtimeDirectory: relative(OUT, directory).replaceAll('\\', '/'), originalMetadata })) });
  save('source-digests.json', samples.map(sample => ({ mode: sample.mode, runId: sample.runId, before: sample.originalFiles,
    after: runFiles(sample.directory), beforeProductMetadata: sample.originalMetadata,
    note: sample === originalSample ? 'Metadata comparison passed before an explicit whitespace injection/restoration; final bytes match.' : 'Product-phase file metadata and final bytes are unchanged.' })));
  save('catalog-final.bytes.json', fs.readFileSync(join(ROOT, 'catalog.json')));
  const summary = { schemaVersion: 1, status: 'passed', startedAt, finishedAt: new Date().toISOString(),
    evidenceLevel: 'fresh-controlled-mirror-regression-browser-real-owner-store-binding',
    checkCount: Object.keys(checks).length, checks, browserRuns: samples.length,
    sourceRunIds: samples.map(({ mode, runId, gate }) => ({ mode, runId, gate })),
    bindings: Object.keys(catalog.browserSourceBindings).length, singleBindingReads: 6,
    captureTargetRequests: requestCountAtBinding, bindingAndReadTargetRequests: targetRequests.length - requestCountAtBinding,
    bindingFetchAttempts, forbiddenProcessEvents: forbiddenEvents, executionReady: false,
    candidateCount: 0, approvalCount: 0, selectionCount: 0, newExecutionRuns: 0,
    outputDirectory: OUT,
    scope: 'Fresh local controlled capture, explicit side organization and private per-binding revalidation only. No Browser approval/selection/executor or HTTP/UI route; no external deployment, cross-call inode guarantee or reusable execution authorization. Runtime originals and copied full run trees are preserved; one source mutation is an explicit recorded test injection.' };
  save('summary.json', summary); console.log(json(summary));
} catch (error) {
  failure = { status: 'failed', message: error.message, stack: error.stack, checks, phase,
    samples: samples.map(({ directory, originalMetadata, ...sample }) => ({ ...sample, runtimeDirectory: relative(OUT, directory).replaceAll('\\', '/') })),
    outputDirectory: OUT };
  save('failure.json', failure); throw error;
} finally {
  restoreGuards();
  try {
    save('checks.json', checks); save('target-requests.json', { captureRequests: requestCountAtBinding || targetRequests.filter(item => item.phase === 'capture').length,
      bindingAndReadRequests: targetRequests.filter(item => item.phase !== 'capture').length, bindingFetchAttempts, requests: targetRequests });
    save('rejections.json', rejections); save('forbidden-process-events.json', forbiddenEvents);
    if (records.length && failure) save('partial-bindings-and-previews.json', records);
  } finally { try { owner?.release(); } finally { await closeServer(); } }
}
