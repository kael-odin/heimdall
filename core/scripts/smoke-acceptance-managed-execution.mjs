#!/usr/bin/env node
/** Real catalog admission -> real engine HTTP executor -> real Chromium CDP.
 * Existing workbench observes execution. A new execution UI is outside scope. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { CORE, managedExecutionFixture, facts, json, hash, waitFor } from './fixtures/managed-execution.mjs';
import { readAcceptanceSnapshot } from '../src/acceptance/store.mjs';
import { acceptanceMarkdown } from '../src/acceptance/report.mjs';

const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'managed-execution-' + randomUUID()));
assert.equal(fs.existsSync(OUT), false, 'Use a new output directory to preserve prior evidence.');
const consoleDir = resolve(CORE, '..', 'console', 'dist');
assert.ok(fs.existsSync(join(consoleDir, 'index.html')), 'Build console/dist before the managed execution smoke.');
fs.mkdirSync(OUT, { recursive: true });
const save = (name, value) => fs.writeFileSync(join(OUT, name), typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value, null, 2) + '\n');
const token = 'managed-execution-controlled-fixture', checks = {}, pageErrors = [], browserRequests = [];
let f, engine, browser, chromiumProcess, chromiumLog = '', page;
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function browserApi(path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json',
      'x-heimdall-token': localStorage.getItem('heimdall-token') ?? '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
async function selectRun(runId) {
  await page.locator(`[data-run-id="${runId}"]`).click();
  await page.locator('.aw-running').waitFor();
  assert.match(await page.locator('.aw-running').innerText(), /验收正在运行/);
  assert.equal(await page.getByTestId('acceptance-gate').count(), 0);
  await page.locator('.aw-running').scrollIntoViewIfNeeded();
}
try {
  f = await managedExecutionFixture({ holdPaths: ['/healthy'] });
  save('source-manifest-before.json', json(join(f.sourceDir, 'manifest.json')));
  save('source-facts-before.json', f.sourceBefore);
  save('admission-chain.json', { project: f.project, sourceRelease: f.sourceRelease, targetRelease: f.targetRelease,
    sourceRunId: f.source.runId, candidate: f.candidate, approval: f.approval, selection: f.selection, version: f.version });
  assert.equal(f.source.plan.spec.approved, false); assert.deepEqual(f.requests, []);
  engine = await f.startEngine({ token, consoleDir });
  const capability = await engine.request('/api/acceptance/execution');
  assert.equal(capability.status, 200); assert.equal(capability.body.enabled, true); assert.equal(capability.body.ready, true);
  save('capability-ready.json', capability.body);

  const profile = join(f.parent, 'chromium-profile'); fs.mkdirSync(profile);
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; });
  chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  const activePort = join(profile, 'DevToolsActivePort');
  await waitFor(() => {
    if (chromiumProcess.exitCode !== null || chromiumProcess.signalCode !== null) throw new Error('Chromium exited: ' + chromiumLog);
    return fs.existsSync(activePort) && fs.readFileSync(activePort, 'utf8').split('\n')[0];
  });
  const cdpBase = 'http://127.0.0.1:' + fs.readFileSync(activePort, 'utf8').split('\n')[0];
  const cdpVersion = await (await fetch(cdpBase + '/json/version')).json();
  browser = await chromium.connectOverCDP(cdpBase);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
    acceptDownloads: true, extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/acceptance/') || path.startsWith('/api/jobs/')) browserRequests.push({ method: request.method(), path });
  });
  await page.goto(engine.base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '项目验收', exact: true }).click();

  const input = f.confirmation(), admitted = await browserApi(f.executionPath, 'POST', input);
  assert.equal(admitted.status, 202); assert.equal(admitted.body.replayed, false); assert.equal(admitted.body.runCreated, true);
  const { runId, taskId } = admitted.body; await f.arrived('/healthy');
  await selectRun(runId);
  await page.screenshot({ path: join(OUT, 'managed-execution-running-desktop.png'), fullPage: false });
  save('browser-running-state.json', { runId, taskId, text: await page.locator('.aw-running').innerText(),
    gateCount: await page.getByTestId('acceptance-gate').count() });
  save('admission-response.json', admitted); save('managed-dispatch.json', fs.readFileSync(f.sidecar(input.operationId)));
  save('capability-running.json', (await browserApi('/api/acceptance/execution')).body);
  assert.equal(f.matchingRequests('/healthy').length, 1); assert.equal(f.matchingRequests('/bug').length, 0);
  checks.realCatalogFreshHttpAdmissionAndRunningUi = true;

  f.release('/healthy');
  const completed = await engine.waitRun(runId), completedTask = await engine.waitTask(taskId, 'done');
  await page.getByTestId('acceptance-gate').waitFor();
  assert.match(await page.getByTestId('acceptance-gate').innerText(), /缺陷/);
  assert.equal(await page.locator('.aw-running').count(), 0);
  assert.equal(await page.getByTestId('acceptance-triage').count(), 0);
  await page.getByText('此报告暂不支持 AI 解读。可下载报告与证据继续排查。', { exact: true }).waitFor();
  const snapshot = readAcceptanceSnapshot(runId, { root: f.root });
  assert.equal(snapshot.integrity.valid, true); assert.equal(snapshot.integrity.evidenceVerified, true);
  assert.equal(completed.gate, 'failed'); assert.equal(completedTask.history.status, 'done');
  assert.equal(snapshot.report.summary.bugs, 1); assert.equal(snapshot.report.targetUrl, f.targetRelease.targetUrl);
  await page.locator('.aw-report-head').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'managed-execution-completed-overview-desktop.png'), fullPage: false });
  const bug = snapshot.report.checks.find(check => check.verdict === 'bug'); assert.ok(bug);
  await page.locator(`details[data-check-id="${bug.id}"] > summary`).click();
  await waitFor(async () => await page.locator(`details[data-check-id="${bug.id}"] .aw-json-evidence`).count() === 3);
  await page.locator(`details[data-check-id="${bug.id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'managed-execution-completed-bug-desktop.png'), fullPage: false });
  save('completed-manifest.json', f.manifest(runId)); save('completed-public-head.json', completed);
  save('completed-jobs.json', completedTask.jobs); save('completed-snapshot.json', snapshot);
  save('browser-completed-state.json', { runId, taskId, gate: await page.getByTestId('acceptance-gate').innerText(),
    triageCount: await page.getByTestId('acceptance-triage').count(), evidencePanels: 3 });

  const markdownDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const markdown = await markdownDownload; await markdown.saveAs(join(OUT, 'downloaded-report.md'));
  assert.deepEqual(fs.readFileSync(join(OUT, 'downloaded-report.md')), Buffer.from(acceptanceMarkdown(snapshot.report)));
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const reportDownload = await jsonDownload; await reportDownload.saveAs(join(OUT, 'downloaded-report.json'));
  assert.deepEqual(fs.readFileSync(join(OUT, 'downloaded-report.json')), fs.readFileSync(join(f.diskRun(runId), 'report.json')));
  const evidenceDownloads = [];
  for (const item of snapshot.report.evidenceManifest) {
    const response = await engine.get('/api/acceptance/runs/' + runId + '/evidence/' + item.file);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, fs.readFileSync(join(f.diskRun(runId), item.file)));
    save('downloaded-' + item.file, bytes); evidenceDownloads.push({ file: item.file, sha256: hash(bytes), size: bytes.length });
  }
  save('download-checks.json', { markdown: hash(fs.readFileSync(join(OUT, 'downloaded-report.md'))),
    json: hash(fs.readFileSync(join(OUT, 'downloaded-report.json'))), evidence: evidenceDownloads });
  const beforeReplay = facts(f.root), replay = await browserApi(f.executionPath, 'POST', input);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.runId, runId);
  const conflict = await browserApi(f.executionPath, 'POST', { ...input, targetReleaseId: f.alternateRelease.id });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(facts(f.root), beforeReplay); assert.equal(f.requests.length, 2);
  save('replay-response.json', replay); save('conflict-response.json', conflict);
  checks.completedBugHasDoneTaskAndVerifiedDownloads = true; checks.replayAndConflictDoNotExecute = true;

  f.hold('/healthy');
  const cancelInput = f.confirmation(), cancelAdmission = await browserApi(f.executionPath, 'POST', cancelInput);
  assert.equal(cancelAdmission.status, 202);
  const cancelledRunId = cancelAdmission.body.runId, cancelledTaskId = cancelAdmission.body.taskId;
  await f.arrived('/healthy', 2); await selectRun(cancelledRunId);
  await page.screenshot({ path: join(OUT, 'managed-execution-cancel-pending-desktop.png'), fullPage: false });
  const cancellation = await browserApi('/api/jobs/' + cancelledTaskId + '/cancel', 'POST', {});
  assert.equal(cancellation.status, 200); assert.equal(cancellation.body.cancelRequested, true);
  const interrupted = await engine.waitRun(cancelledRunId, 'interrupted'), cancelledTask = await engine.waitTask(cancelledTaskId, 'cancelled');
  assert.equal(interrupted.reasonCode, 'CANCELLED'); assert.equal(interrupted.gate, 'blocked');
  await waitFor(() => f.matchingRequests('/healthy')[1].closed);
  assert.equal(f.matchingRequests('/healthy')[1].completed, false);
  await page.locator('.aw-failed').waitFor(); assert.match(await page.locator('.aw-failed').innerText(), /验收已中断/);
  await waitFor(async () => (await page.locator(`[data-run-id="${cancelledRunId}"]`).innerText()).includes('已中断'));
  await page.locator('.aw-failed').scrollIntoViewIfNeeded();
  assert.equal(await page.getByTestId('acceptance-gate').count(), 0);
  assert.equal(await page.getByTestId('acceptance-triage').count(), 0);
  await page.screenshot({ path: join(OUT, 'managed-execution-cancelled-desktop.png'), fullPage: false });
  const cancelledBeforeReplay = facts(f.root), cancelledReplay = await browserApi(f.executionPath, 'POST', cancelInput);
  assert.equal(cancelledReplay.status, 200); assert.equal(cancelledReplay.body.state, 'interrupted');
  assert.equal(cancelledReplay.body.runId, cancelledRunId); assert.deepEqual(facts(f.root), cancelledBeforeReplay);
  f.release('/healthy');
  assert.equal(f.matchingRequests('/healthy').length, 2); assert.equal(f.matchingRequests('/bug').length, 1);
  save('cancel-admission.json', cancelAdmission); save('cancel-response.json', cancellation);
  save('cancelled-manifest.json', f.manifest(cancelledRunId)); save('cancelled-jobs.json', cancelledTask.jobs);
  save('cancelled-replay.json', cancelledReplay);
  save('browser-cancelled-state.json', { runId: cancelledRunId, taskId: cancelledTaskId,
    text: await page.locator('.aw-failed').innerText(), gateCount: await page.getByTestId('acceptance-gate').count(),
    triageCount: await page.getByTestId('acceptance-triage').count(), laterBugRequests: f.matchingRequests('/bug').length - 1 });
  checks.pendingCancelStopsLaterRequestsAndUiIsInterrupted = true;
  assert.deepEqual(facts(f.sourceDir), f.sourceBefore); assert.equal(json(join(f.sourceDir, 'manifest.json')).plan.spec.approved, false);
  assert.deepEqual(f.modelRequests, []); assert.deepEqual(pageErrors, []);
  save('source-facts-after.json', facts(f.sourceDir)); save('target-requests.json', f.requests); save('model-requests.json', f.modelRequests);
  save('browser-requests.json', browserRequests); save('capability-after.json', (await browserApi('/api/acceptance/execution')).body);
  save('runtime.json', { node: process.version, platform: process.platform, architecture: process.arch,
    chromium: cdpVersion.Browser, protocol: cdpVersion['Protocol-Version'], transport: 'Chromium DevTools Protocol over loopback HTTP' });
  const result = { status: 'passed', evidenceLevel: 'real-catalog-admission-engine-cdp-browser-local-fixture',
    engineExecutorTested: true, freshCatalogAdmissionTested: true, executionUiImplemented: false,
    browserPluginAvailable: false, browserAutomation: 'Repository Playwright with an actual Chromium CDP endpoint',
    scope: 'Real legacy draft, binding, candidate, approval and selection. Browser POST invokes fresh managed engine execution; existing workbench observes running, completed BUG and cancelled interrupted states.',
    checks, pageErrors, targetRequestCount: f.requests.length, zeroModelRequests: true, originalDraftUnchanged: true, outputDirectory: OUT };
  save('browser-checks.json', result); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  save('failure.json', { message: error.message, stack: error.stack, checks, pageErrors });
  if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {}); await stopChild(chromiumProcess); save('chromium.log', chromiumLog);
  if (f) {
    save('target-requests-final.json', f.requests); save('model-requests-final.json', f.modelRequests);
    for (const [index, item] of f.engines.entries()) save('engine-' + index + '.log', item.output());
    await f.cleanup();
  }
}
