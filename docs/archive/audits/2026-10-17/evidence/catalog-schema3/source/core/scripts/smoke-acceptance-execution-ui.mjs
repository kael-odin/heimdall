#!/usr/bin/env node
/** Real managed-execution buttons -> real engine -> controlled HTTP target.
 * Browser API requests may observe facts or set up adversaries; execution,
 * lookup/recovery and stop actions must pass through native UI controls. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { CORE, managedExecutionFixture, facts, json, waitFor } from './fixtures/managed-execution.mjs';
import { readAcceptanceSnapshot } from '../src/acceptance/store.mjs';

const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'execution-ui-' + randomUUID()));
assert.equal(fs.existsSync(OUT), false, 'Use a new output directory to preserve earlier evidence.');
const consoleDir = resolve(CORE, '..', 'console', 'dist');
assert.ok(fs.existsSync(join(consoleDir, 'index.html')), 'Build console/dist before the execution UI smoke.');
fs.mkdirSync(OUT, { recursive: true });
const save = (name, value) => fs.writeFileSync(join(OUT, name), typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value, null, 2) + '\n');
const token = 'managed-execution-ui-controlled-fixture', checks = {}, browserRequests = [], pageErrors = [], expectedResourceErrors = [];
const cases = [], layouts = [], captures = [], fixtures = [], contexts = [], heldResponses = [];
let fixture, engine, browser, chromiumProcess, chromiumLog = '', page, expectedConfirmationVersion;

async function until(fn, label, timeoutMs = 15000) {
  try { return await waitFor(fn, timeoutMs); }
  catch (error) { error.message = label + ': ' + error.message; throw error; }
}
async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function startBrowser(f) {
  assert.equal(chromiumProcess, undefined, 'One CDP browser owns all isolated contexts.');
  const profile = join(f.parent, 'execution-ui-chromium-profile'); fs.mkdirSync(profile);
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; });
  chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  let spawnError;
  chromiumProcess.once('error', error => { spawnError = error; });
  const activePort = join(profile, 'DevToolsActivePort');
  await waitFor(() => {
    if (spawnError) throw spawnError;
    if (chromiumProcess.exitCode !== null || chromiumProcess.signalCode !== null) throw new Error('Chromium exited: ' + chromiumLog);
    return fs.existsSync(activePort) && fs.readFileSync(activePort, 'utf8').split('\n')[0];
  });
  const base = 'http://127.0.0.1:' + fs.readFileSync(activePort, 'utf8').split('\n')[0];
  save('cdp-version.json', await (await fetch(base + '/json/version')).json());
  browser = await chromium.connectOverCDP(base);
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
    acceptDownloads: true, extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  contexts.push(context);
  const current = await context.newPage(); current.setDefaultTimeout(15000);
  current.on('pageerror', error => pageErrors.push(error.message));
  current.on('console', message => {
    if (!['error', 'warning'].includes(message.type())) return;
    if (/409|404|502|503|ERR_FAILED|net::ERR_FAILED/.test(message.text())) expectedResourceErrors.push(message.text());
    else pageErrors.push(message.text());
  });
  current.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/acceptance/') && !path.startsWith('/api/jobs/')) return;
    const entry = { method: request.method(), path };
    if (request.method() === 'POST') {
      try { entry.body = request.postDataJSON(); } catch { entry.body = request.postData(); }
    }
    browserRequests.push(entry);
  });
  return current;
}
const executionPosts = (projectId = fixture.project.id) => browserRequests.filter(request => request.method === 'POST'
  && request.path === '/api/acceptance/projects/' + projectId + '/spec-executions');
const operationGets = (operationId, projectId = fixture.project.id) => browserRequests.filter(request => request.method === 'GET'
  && request.path === '/api/acceptance/projects/' + projectId + '/spec-executions/' + operationId);
const runIds = () => fs.readdirSync(fixture.root).filter(name => /^ac-/.test(name)).sort();
const sidecarIds = () => {
  const directory = join(fixture.root, 'managed-spec-dispatches', 'v1');
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
};
async function screenshot(name) {
  if (name.startsWith('execution-')) captures.push({ name, ...await focusEvidenceState(name) });
  save(name + '-dom.txt', await page.locator('body').innerText());
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false });
  save('screenshot-rects.json', captures);
}
function assertOriginalSource() {
  assert.deepEqual(facts(fixture.sourceDir), fixture.sourceBefore);
  assert.equal(json(join(fixture.sourceDir, 'manifest.json')).plan.spec.approved, false);
  assert.deepEqual(fixture.modelRequests, []);
}
async function recordCase(name, data = {}) {
  assertOriginalSource();
  const jobs = await engine.jobs();
  cases.push({ name, ...data, runIds: runIds(), sidecarIds: sidecarIds(), jobs: jobs.body,
    targetRequestCount: fixture.requests.length, browserExecutionPostCount: executionPosts().length });
  save('cases.json', cases);
}

async function openProject(projectId = fixture.project.id, { reload = false } = {}) {
  if (reload) await page.reload({ waitUntil: 'networkidle' });
  else await page.goto(engine.base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  const catalog = page.getByTestId('acceptance-catalog');
  await catalog.getByTestId('catalog-toggle').click();
  await catalog.locator('[name="catalog-project"]').selectOption(projectId);
  await catalog.getByTestId('acceptance-baseline').waitFor();
  await until(async () => await catalog.locator('[name="catalog-project"]').inputValue() === projectId
    && !(await catalog.getByTestId('execution-review').isDisabled()), 'project execution detail ready');
  return catalog;
}
function assertStrictConfirmation(body, expectedVersion = expectedConfirmationVersion ?? fixture.version) {
  assert.deepEqual(Object.keys(body).sort(), ['operationId', 'expectedGenerationId', 'expectedRevision',
    'selectionId', 'contentDigest', 'targetReleaseId'].sort());
  assert.match(body.operationId, /^ao-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.deepEqual(body, { ...fixture.confirmation(body.operationId), ...expectedVersion });
}
async function holdResponse(path, method = 'GET') {
  const routePage = page;
  let release, arrived = false, captured;
  const gate = new Promise(ready => { release = ready; });
  const handler = async route => {
    if (route.request().method() !== method) { await route.continue(); return; }
    const response = await route.fetch();
    captured = { status: response.status(), body: await response.json() };
    arrived = true;
    await gate;
    await route.fulfill({ response }).catch(() => {});
  };
  await routePage.route('**' + path, handler, { times: 1 });
  const held = { release, wait: () => until(() => arrived, 'held ' + method + ' ' + path),
    response: () => captured, dispose: () => routePage.unroute('**' + path, handler) };
  heldResponses.push(held);
  return held;
}
async function assertLayout(name, width, height, theme) {
  await page.setViewportSize({ width, height });
  if (theme) await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.getByTestId('acceptance-execution').waitFor({ state: 'visible' });
  const mobileResults = page.getByTestId('acceptance-view-results');
  if (await mobileResults.isVisible()) await mobileResults.click();
  const rects = await focusEvidenceState(name);
  const layout = await page.evaluate(() => {
    const panel = document.querySelector('.aw-results');
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      panelClientWidth: panel?.clientWidth ?? 0, panelScrollWidth: panel?.scrollWidth ?? 0 };
  });
  assert.ok(layout.panelClientWidth > 0, JSON.stringify(layout));
  assert.ok(layout.documentWidth <= width + 1, JSON.stringify(layout));
  assert.ok(layout.panelScrollWidth <= layout.panelClientWidth + 1, JSON.stringify(layout));
  layouts.push({ name, width, height, theme, ...layout, ...rects });
  await screenshot(name);
}
const ordinaryPlan = (f, path = '/ordinary-hold') => ({ name: 'UI共享槽普通验收对手', mode: 'spec', targetUrl: f.base,
  timeoutMs: 30000, spec: { source: { id: 'REQ-UI-ORDINARY', revision: '1' }, approved: true,
    checks: [{ id: 'ORDINARY-UI', title: '共享槽普通验收合同', method: 'GET', path,
      expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });

const execution = () => page.getByTestId('acceptance-execution');
async function focusEvidenceState(name) {
  const state = execution().getByTestId('execution-operation-state');
  const expected = name.includes('completed') ? '执行已完成' : name.includes('cancelled') ? '执行已中断'
    : name.includes('prepared') ? '已准备，未启动' : name.includes('unknown') ? '启动结果待核对'
      : name.includes('stale') ? '请求未接纳' : name.includes('running') ? '正在执行' : null;
  if (expected) await until(async () => await state.innerText() === expected, 'screenshot state matches ' + name);
  await state.scrollIntoViewIfNeeded();
  await state.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  let rects;
  await until(async () => {
    rects = await page.evaluate(() => {
      const stateElement = document.querySelector('[data-testid="execution-operation-state"]');
      const panelElement = document.querySelector('[data-testid="acceptance-execution"]');
      const header = document.querySelector('.aw-header')?.getBoundingClientRect();
      const compact = rectangle => ({ x: rectangle.x, y: rectangle.y, width: rectangle.width,
        height: rectangle.height, top: rectangle.top, bottom: rectangle.bottom, left: rectangle.left, right: rectangle.right });
      return { viewportWidth: innerWidth, viewportHeight: innerHeight,
        headerBottom: header ? Math.max(0, Math.min(innerHeight, header.bottom)) : 0,
        stateText: stateElement?.textContent?.trim(), stateRect: stateElement ? compact(stateElement.getBoundingClientRect()) : null,
        executionRect: panelElement ? compact(panelElement.getBoundingClientRect()) : null };
    });
    const rectangle = rects.stateRect;
    return rectangle && rectangle.width > 0 && rectangle.height > 0 && rectangle.top >= rects.headerBottom
      && rectangle.bottom <= rects.viewportHeight && rectangle.left >= 0 && rectangle.right <= rects.viewportWidth;
  }, 'screenshot status must be fully inside viewport below header');
  if (expected) assert.equal(rects.stateText, expected);
  return rects;
}
const receiptKey = receipt => `heimdall-acceptance-execution-v1:${encodeURIComponent(receipt.apiOrigin)}:${receipt.request.expectedGenerationId}:${receipt.projectId}:${receipt.request.operationId}`;
const receiptFor = request => ({ schemaVersion: 1, apiOrigin: engine.base, createdAt: new Date().toISOString(),
  projectId: fixture.project.id, sourceRunId: fixture.source.runId, request });
async function readStoredReceipt(body) {
  const key = receiptKey(receiptFor(body));
  const raw = await page.evaluate(value => localStorage.getItem(value), key);
  assert.ok(raw, 'The immutable operation receipt must exist before the browser sends its POST.');
  const receipt = JSON.parse(raw);
  assert.deepEqual(receipt.request, body);
  assert.equal(receipt.projectId, fixture.project.id); assert.equal(receipt.sourceRunId, fixture.source.runId);
  assert.equal(receipt.apiOrigin, engine.base);
  return receipt;
}
async function seedReceipt(receipt) {
  await page.goto(engine.base, { waitUntil: 'networkidle' });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: receiptKey(receipt), value: receipt });
}
async function waitState(pattern) {
  await until(async () => pattern.test(await execution().getByTestId('execution-operation-state').innerText()), 'operation state ' + pattern);
}
async function waitCapability(pattern = /执行器可用/) {
  await until(async () => pattern.test(await execution().getByTestId('execution-capability').innerText()), 'execution capability ' + pattern);
}
async function reviewTarget({ confirm = true, targetId = fixture.targetRelease.id } = {}) {
  const panel = execution();
  await panel.getByTestId('execution-target').selectOption(targetId);
  await panel.getByTestId('execution-review').click();
  await panel.getByTestId('execution-contract').waitFor();
  if (confirm) {
    await panel.getByTestId('execution-confirm').check();
    await until(async () => !(await panel.getByTestId('execution-start').isDisabled()), 'explicit execution confirmation');
  }
}
async function refreshDirectory() {
  const catalog = page.getByTestId('acceptance-catalog');
  await catalog.getByTestId('catalog-refresh').click();
  await until(async () => await catalog.locator('.catalog-body').getAttribute('aria-busy') === 'false'
    && !(await execution().getByTestId('execution-review').isDisabled()), 'refreshed directory');
}
async function clickWithFault(kind) {
  const current = page, postsBefore = executionPosts().length;
  let captured, error;
  await current.route('**' + fixture.executionPath, async route => {
    try {
      const body = route.request().postDataJSON(); assertStrictConfirmation(body);
      const receipt = await readStoredReceipt(body);
      if (kind === 'never-forwarded') {
        captured = { kind, body, receipt, serverResponse: null }; await route.abort('failed');
      } else {
        const response = await route.fetch(), value = await response.json();
        assert.equal(response.status(), 202); assert.equal(value.runCreated, true); assert.equal(value.replayed, false);
        captured = { kind, body, receipt, serverResponse: { status: response.status(), body: value } };
        if (kind === 'html502') await route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' });
        else await route.abort('failed');
      }
    } catch (problem) { error = problem; await route.abort('failed').catch(() => {}); }
  }, { times: 1 });
  await execution().getByTestId('execution-start').click();
  await until(() => captured || error, 'captured native execution click');
  if (error) throw error;
  await until(async () => !(await execution().getByTestId('execution-query').isDisabled()), 'POST settled without replay');
  assert.equal(executionPosts().length, postsBefore + 1);
  assert.equal(await execution().getByTestId('execution-confirm').isChecked(), false);
  return captured;
}
async function assertOnlyOriginalLookup(captured, postsBefore, { reload = false } = {}) {
  const id = captured.body.operationId;
  const getsBefore = operationGets(id).length;
  if (reload) await openProject(fixture.project.id, { reload: true });
  await execution().getByTestId('execution-operation').selectOption(id);
  await execution().getByTestId('execution-query').click();
  await until(() => operationGets(id).length > getsBefore, 'GET original operation');
  assert.equal(await execution().getByTestId('execution-operation-id').innerText(), id);
  assert.equal(executionPosts().length, postsBefore + 1);
  const stored = await readStoredReceipt(captured.body);
  assert.deepEqual(stored, captured.receipt);
}

async function noExecutionScenarios() {
  fixture = await managedExecutionFixture(); fixtures.push(fixture);
  expectedConfirmationVersion = fixture.version;
  const prepared = await fixture.prepareOnly();
  engine = await fixture.startEngine({ token, consoleDir });
  if (!browser) await startBrowser(fixture);
  save('admission-chain-readonly.json', { project: fixture.project, sourceRelease: fixture.sourceRelease,
    targetRelease: fixture.targetRelease, candidate: fixture.candidate, approval: fixture.approval, selection: fixture.selection,
    version: fixture.version, preparedInput: prepared.input, preparedRunId: prepared.envelope.runId });

  page = await newPage();
  await seedReceipt(receiptFor(prepared.input));
  await openProject();
  await waitState(/已准备，未启动/); await waitCapability();
  const preparedFacts = facts(fixture.root), preparedRuns = runIds(), preparedJobs = (await engine.jobs()).body;
  const preparedPosts = executionPosts().length;
  await execution().getByTestId('execution-query').click();
  await waitState(/已准备，未启动/);
  await openProject(fixture.project.id, { reload: true });
  await waitState(/已准备，未启动/);
  assert.equal(executionPosts().length, preparedPosts);
  assert.deepEqual(runIds(), preparedRuns); assert.deepEqual((await engine.jobs()).body, preparedJobs);
  assert.deepEqual(facts(fixture.root), preparedFacts); assert.deepEqual(fixture.requests, []);
  assert.equal(fs.existsSync(fixture.diskRun(prepared.envelope.runId)), false);
  assert.equal(await execution().getByTestId('execution-open-run').count(), 0);
  assert.equal(await execution().getByTestId('execution-stop').count(), 0);
  assert.equal(await execution().getByTestId('execution-start').isDisabled(), true);
  await execution().scrollIntoViewIfNeeded(); await screenshot('execution-prepared-query-only-desktop');
  checks.preparedReceiptReloadAndNativeLookupNeverStart = true;
  await recordCase('prepared-query-only', { operationId: prepared.input.operationId });

  page = await newPage(); await openProject(); await waitCapability();
  const panel = execution();
  assert.equal(await panel.getByTestId('execution-target').inputValue(), '');
  assert.equal(await panel.getByTestId('execution-start').isDisabled(), true);
  await panel.getByTestId('execution-review').click(); await panel.getByTestId('execution-contract').waitFor();
  assert.equal(await panel.getByTestId('execution-confirm').isDisabled(), true);
  await panel.getByTestId('execution-target').selectOption(fixture.targetRelease.id);
  await panel.getByTestId('execution-confirm').check();
  await panel.getByTestId('execution-target').selectOption(fixture.alternateRelease.id);
  assert.equal(await panel.getByTestId('execution-confirm').isChecked(), false);
  await panel.getByTestId('execution-target').selectOption(fixture.targetRelease.id);
  assert.equal(await panel.getByTestId('execution-confirm').isChecked(), false);
  await panel.getByTestId('execution-confirm').check();
  const postsBeforeUnknown = executionPosts().length, unknownFacts = facts(fixture.root), unknownJobs = (await engine.jobs()).body;
  const unknown = await clickWithFault('never-forwarded');
  await waitState(/启动结果待核对/);
  await assertOnlyOriginalLookup(unknown, postsBeforeUnknown, { reload: true });
  await waitState(/启动结果待核对/);
  await panel.getByTestId('execution-query').click();
  await waitState(/启动结果待核对/);
  assert.equal(executionPosts().length, postsBeforeUnknown + 1);
  const unknownLookup = await engine.operation(unknown.body.operationId);
  assert.equal(unknownLookup.status, 404);
  assert.equal(await execution().getByTestId('execution-unresolved').count(), 1);
  assert.equal(await execution().getByTestId('execution-start').isDisabled(), true);
  assert.deepEqual(facts(fixture.root), unknownFacts); assert.deepEqual((await engine.jobs()).body, unknownJobs);
  assert.deepEqual(fixture.requests, []);
  await execution().scrollIntoViewIfNeeded(); await screenshot('execution-unknown-404-reload-desktop');
  checks.explicitTargetAndChangedTargetClearsConfirmation = true;
  checks.receiptPersistedBeforeNativePostAndUnknown404ReloadOnlyGets = true;
  await recordCase('unknown-404-stays-unresolved', { operationId: unknown.body.operationId, lookup: unknownLookup });

  page = await newPage(); await openProject(); await waitCapability(); await reviewTarget();
  const directory = await engine.request('/api/acceptance/projects');
  const changed = await engine.request('/api/acceptance/projects', { method: 'POST', body: {
    expectedGenerationId: directory.body.generationId, expectedRevision: directory.body.revision, name: '旧CAS对手项目' } });
  assert.equal(changed.status, 201);
  const staleFacts = facts(fixture.root), staleJobs = (await engine.jobs()).body, stalePosts = executionPosts().length;
  await execution().getByTestId('execution-start').click();
  await execution().getByTestId('execution-error').waitFor();
  assert.match(await execution().getByTestId('execution-error').innerText(), /STALE_REVISION/);
  await waitState(/请求未接纳/);
  assert.equal(executionPosts().length, stalePosts + 1);
  assert.deepEqual(facts(fixture.root), staleFacts); assert.deepEqual((await engine.jobs()).body, staleJobs);
  assert.deepEqual(fixture.requests, []);
  assert.equal(await execution().getByTestId('execution-confirm').isChecked(), false);
  await refreshDirectory();
  assert.equal(await execution().getByTestId('execution-target').inputValue(), fixture.targetRelease.id);
  assert.equal(await execution().getByTestId('execution-contract').count(), 0);
  assert.equal(await execution().getByTestId('execution-start').isDisabled(), true);
  assert.equal(executionPosts().length, stalePosts + 1);
  await execution().scrollIntoViewIfNeeded(); await screenshot('execution-stale-cas-requires-new-review-desktop');
  checks.oldCasRejectionCreatesNoRunAndRefreshRequiresNewReview = true;
  await recordCase('stale-cas-explicit-rejection');
}

async function realExecutionScenarios() {
  fixture = await managedExecutionFixture({ holdPaths: ['/healthy'] }); fixtures.push(fixture);
  const otherProject = (await fixture.catalog.createProject({ ...fixture.version, name: '执行响应隔离项目 B' })).project;
  const directory = fixture.catalog.read();
  expectedConfirmationVersion = { expectedGenerationId: directory.generationId, expectedRevision: directory.revision };
  engine = await fixture.startEngine({ token, consoleDir });
  await startBrowser(fixture);
  save('admission-chain-execution.json', { project: fixture.project, otherProject, sourceRelease: fixture.sourceRelease,
    targetRelease: fixture.targetRelease, candidate: fixture.candidate, approval: fixture.approval, selection: fixture.selection,
    version: expectedConfirmationVersion });
  page = await newPage(); await openProject(); await waitCapability();
  assert.equal(await execution().getByTestId('execution-target').inputValue(), '');
  await reviewTarget();
  const postCount = executionPosts().length, runCount = runIds().length;
  const heldStart = await holdResponse(fixture.executionPath, 'POST');
  await execution().getByTestId('execution-start').focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await heldStart.wait();
  assert.equal(executionPosts().length, postCount + 1, 'Repeated native Enter cannot create a second execution POST.');
  const firstInput = executionPosts().at(-1).body;
  assertStrictConfirmation(firstInput);
  const firstReceipt = await readStoredReceipt(firstInput), first = heldStart.response();
  assert.equal(first.status, 202); assert.equal(first.body.replayed, false); assert.equal(first.body.runCreated, true);
  await fixture.arrived('/healthy');
  const selector = page.getByTestId('acceptance-catalog').locator('[name="catalog-project"]');
  await selector.selectOption(otherProject.id);
  await execution().locator('.execution-empty').waitFor();
  await selector.selectOption(fixture.project.id);
  await until(async () => !(await execution().getByTestId('execution-review').isDisabled()), 'returned project A');
  heldStart.release(); await heldStart.dispose();
  await waitState(/正在执行/);
  assert.equal(await selector.inputValue(), fixture.project.id);
  assert.equal(await execution().getByTestId('execution-target').inputValue(), '');
  assert.equal(await execution().getByTestId('execution-confirm').isChecked(), false);
  assert.equal(await execution().getByTestId('execution-operation-id').innerText(), firstInput.operationId);
  assert.equal(await execution().getByTestId('execution-run-id').innerText(), first.body.runId);
  assert.equal(runIds().length, runCount + 1);
  assert.equal(fixture.matchingRequests('/healthy').length, 1); assert.equal(fixture.matchingRequests('/bug').length, 0);
  await execution().getByTestId('execution-query').click(); await waitState(/正在执行/);
  const ordinaryBusy = await engine.request('/api/acceptance/runs', { method: 'POST', body: ordinaryPlan(fixture) });
  assert.equal(ordinaryBusy.status, 409); assert.equal(ordinaryBusy.body.code, 'ACCEPTANCE_BUSY');
  assert.equal(runIds().length, runCount + 1); assert.equal(executionPosts().length, postCount + 1);
  await execution().scrollIntoViewIfNeeded(); await screenshot('execution-running-native-desktop');
  checks.nativeRepeatedClickPersistsStrictInputAndCreatesOneRun = true;
  checks.lateStartResponseAcrossProjectABACannotRestoreOldConfirmation = true;
  checks.managedSlotBlocksOrdinaryButOriginalOperationLookupWorks = true;

  await waitCapability(/已有验收占用/);
  const heldCapability = await holdResponse('/api/acceptance/execution');
  await execution().getByTestId('execution-refresh-status').click(); await heldCapability.wait();
  assert.equal(heldCapability.response().body.busy, true);
  fixture.release('/healthy');
  const completed = await engine.waitRun(first.body.runId), completedTask = await engine.waitTask(first.body.taskId, 'done');
  assert.equal(completed.gate, 'failed'); assert.equal(completedTask.history.status, 'done');
  await selector.selectOption(otherProject.id); await execution().locator('.execution-empty').waitFor();
  await selector.selectOption(fixture.project.id);
  await waitState(/执行已完成/); await waitCapability();
  heldCapability.release(); await heldCapability.dispose();
  await waitCapability();
  assert.equal(await execution().getByTestId('execution-operation-id').innerText(), firstInput.operationId);
  const snapshot = readAcceptanceSnapshot(first.body.runId, { root: fixture.root });
  assert.equal(snapshot.integrity.valid, true); assert.equal(snapshot.integrity.evidenceVerified, true);
  assert.equal(snapshot.report.summary.bugs, 1); assert.equal(snapshot.report.targetUrl, fixture.targetRelease.targetUrl);
  assert.deepEqual(snapshot.report.checks.map(check => check.verdict), ['match', 'bug']);
  assert.deepEqual(fixture.requests.map(request => request.path), ['/target/healthy', '/target/bug']);
  const firstLookupPath = fixture.executionPath + '/' + firstInput.operationId;
  await page.route('**' + firstLookupPath, route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ code: 'READ_TEMPORARILY_UNAVAILABLE', error: 'controlled terminal lookup interruption' }) }), { times: 1 });
  await execution().getByTestId('execution-query').click();
  await execution().getByTestId('execution-read-error').waitFor();
  await waitState(/执行已完成/);
  assert.equal(await execution().getByTestId('execution-open-run').count(), 1);
  await execution().getByTestId('execution-query').click();
  await until(async () => await execution().getByTestId('execution-read-error').count() === 0, 'successful reread clears diagnostic');
  checks.terminalLookupFailureRetainsCompletedStateAndReportEntry = true;
  await execution().scrollIntoViewIfNeeded();
  await assertLayout('execution-completed-mobile-dark', 390, 844, 'dark');
  await execution().getByTestId('execution-open-run').click();
  await page.getByTestId('acceptance-gate').waitFor();
  assert.match(await page.getByTestId('acceptance-gate').innerText(), /缺陷/);
  assert.equal(await page.getByTestId('acceptance-triage').count(), 0);
  await page.locator('details[data-check-id]').first().locator('summary').click();
  await until(async () => await page.locator('.aw-json-evidence').count() === 3, 'managed BUG evidence visible');
  checks.bugCompletionTaskDoneAndReportEvidenceOpenedThroughButton = true;
  checks.lateBusyCapabilityCannotOverwriteNewProjectCapability = true;
  await recordCase('native-completed-bug', { operationId: firstInput.operationId, operation: first.body,
    report: { gate: snapshot.report.gate, summary: snapshot.report.summary }, sourceHashes: fixture.sourceBefore });

  const completedReceipts = [firstReceipt];
  for (const kind of ['lost-response', 'html502']) {
    fixture.hold('/healthy');
    page = await newPage(); await openProject(); await waitCapability(); await reviewTarget();
    const beforePosts = executionPosts().length, beforeRuns = runIds().length, beforeTarget = fixture.requests.length,
      beforeHealthy = fixture.matchingRequests('/healthy').length;
    const captured = await clickWithFault(kind);
    await fixture.arrived('/healthy', beforeHealthy + 1);
    await assertOnlyOriginalLookup(captured, beforePosts, { reload: true });
    await waitState(/正在执行/);
    assert.equal(await execution().getByTestId('execution-run-id').innerText(), captured.serverResponse.body.runId);
    assert.equal(runIds().length, beforeRuns + 1); assert.equal(fixture.requests.length, beforeTarget + 1);
    assert.equal(executionPosts().length, beforePosts + 1);
    assert.equal((await engine.operation(captured.body.operationId)).body.taskId, captured.serverResponse.body.taskId);
    fixture.release('/healthy');
    await engine.waitRun(captured.serverResponse.body.runId); await engine.waitTask(captured.serverResponse.body.taskId, 'done');
    await waitState(/执行已完成/);
    assert.equal(executionPosts().length, beforePosts + 1); assert.equal(runIds().length, beforeRuns + 1);
    assert.equal(fixture.requests.length, beforeTarget + 2);
    completedReceipts.push(captured.receipt);
    await recordCase(kind + '-reload-only-gets', { operationId: captured.body.operationId, operation: captured.serverResponse.body });
  }
  checks.lost202AndHtml502ReloadRecoverOriginalRunWithOnlyGet = true;

  fixture.hold('/ordinary-hold');
  const ordinary = await engine.request('/api/acceptance/runs', { method: 'POST', body: ordinaryPlan(fixture) });
  assert.equal(ordinary.status, 202); await fixture.arrived('/ordinary-hold');
  page = await newPage(); await seedReceipt(firstReceipt); await openProject();
  await waitState(/执行已完成/); await waitCapability(/已有验收占用/); await reviewTarget({ confirm: false });
  assert.equal(await execution().getByTestId('execution-confirm').isDisabled(), true);
  assert.equal(await execution().getByTestId('execution-start').isDisabled(), true);
  const beforeOrdinaryRelease = executionPosts().length;
  const ordinaryCancel = await engine.request('/api/jobs/' + ordinary.body.taskId + '/cancel', { method: 'POST', body: {} });
  assert.equal(ordinaryCancel.status, 200);
  await engine.waitRun(ordinary.body.runId, 'interrupted'); await engine.waitTask(ordinary.body.taskId, 'cancelled');
  fixture.release('/ordinary-hold');
  await execution().getByTestId('execution-refresh-status').click(); await waitCapability();
  assert.equal(executionPosts().length, beforeOrdinaryRelease);
  checks.ordinarySharedSlotDisablesFreshManagedStartAndRecovers = true;

  fixture.hold('/healthy');
  const beforeCancellationHealthy = fixture.matchingRequests('/healthy').length;
  await execution().getByTestId('execution-confirm').check();
  const cancelStart = await holdResponse(fixture.executionPath, 'POST');
  await execution().getByTestId('execution-start').click(); await cancelStart.wait();
  const cancelInput = executionPosts().at(-1).body; assertStrictConfirmation(cancelInput);
  const cancelReceipt = await readStoredReceipt(cancelInput), cancelOperation = cancelStart.response().body;
  cancelStart.release(); await cancelStart.dispose(); await waitState(/正在执行/);
  await fixture.arrived('/healthy', beforeCancellationHealthy + 1);
  const bugsBeforeCancel = fixture.matchingRequests('/bug').length;
  const stopPath = '/api/jobs/' + cancelOperation.taskId + '/cancel';
  const heldStop = await holdResponse(stopPath, 'POST');
  await execution().getByTestId('execution-stop').click(); await heldStop.wait();
  const interrupted = await engine.waitRun(cancelOperation.runId, 'interrupted');
  const cancelledTask = await engine.waitTask(cancelOperation.taskId, 'cancelled');
  await until(() => fixture.matchingRequests('/healthy').at(-1).closed, 'cancel closes active target socket');
  assert.equal(fixture.matchingRequests('/healthy').at(-1).completed, false);
  assert.equal(fixture.matchingRequests('/bug').length, bugsBeforeCancel);
  assert.equal(interrupted.reasonCode, 'CANCELLED'); assert.equal(cancelledTask.history.status, 'cancelled');
  await waitState(/执行已中断/);
  await execution().scrollIntoViewIfNeeded();
  await assertLayout('execution-cancelled-mobile-light', 390, 844, 'light');
  await execution().getByTestId('execution-open-run').click();
  await until(async () => (await page.locator('.aw-failed').innerText()).includes('验收已中断'), 'interrupted run reader');
  assert.equal(await page.getByTestId('acceptance-gate').count(), 0); assert.equal(await page.getByTestId('acceptance-triage').count(), 0);
  await page.getByTestId('acceptance-catalog').getByTestId('catalog-toggle').click();
  await execution().getByTestId('execution-operation').selectOption(firstInput.operationId);
  await waitState(/执行已完成/);
  heldStop.release(); await heldStop.dispose();
  await waitState(/执行已完成/);
  assert.equal(await execution().getByTestId('execution-operation-id').innerText(), firstInput.operationId);
  assert.equal(browserRequests.filter(request => request.method === 'POST' && request.path === stopPath).length, 1);
  fixture.release('/healthy');
  assert.equal(fixture.matchingRequests('/bug').length, bugsBeforeCancel);
  checks.nativeStopClosesPendingTargetAndPreventsEveryLaterCheck = true;
  checks.lateStopResponseCannotOverrideAnotherSelectedOperation = true;
  checks.desktopAndBothMobileThemesHaveNoHorizontalOverflow = true;
  await recordCase('native-stop-interrupted', { operationId: cancelInput.operationId, operation: cancelOperation,
    stopResponse: heldStop.response(), finalRun: interrupted, taskHistory: cancelledTask.history });

  page = await newPage();
  await seedReceipt(completedReceipts[0]);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: receiptKey(cancelReceipt), value: cancelReceipt });
  const lateLookupPath = fixture.executionPath + '/' + cancelInput.operationId;
  const heldLookup = await holdResponse(lateLookupPath);
  await openProject(); await heldLookup.wait();
  const lateSelector = page.getByTestId('acceptance-catalog').locator('[name="catalog-project"]');
  await lateSelector.selectOption(otherProject.id); await execution().locator('.execution-empty').waitFor();
  await lateSelector.selectOption(fixture.project.id);
  await execution().getByTestId('execution-operation').selectOption(firstInput.operationId); await waitState(/执行已完成/);
  heldLookup.release(); await heldLookup.dispose();
  await waitState(/执行已完成/);
  assert.equal(await lateSelector.inputValue(), fixture.project.id);
  assert.equal(await execution().getByTestId('execution-operation-id').innerText(), firstInput.operationId);
  assert.equal(await execution().getByTestId('execution-target').inputValue(), '');
  assert.equal(await execution().getByTestId('execution-confirm').isChecked(), false);
  checks.lateOperationLookupAcrossProjectABACannotChangeSelection = true;
  await recordCase('late-operation-lookup-aba');
}

try {
  await realExecutionScenarios();
  await noExecutionScenarios();
  for (const item of fixtures) {
    assert.deepEqual(facts(item.sourceDir), item.sourceBefore); assert.deepEqual(item.modelRequests, []);
  }
  assert.deepEqual(pageErrors, []);
  save('browser-requests.json', browserRequests); save('layouts.json', layouts);
  save('browser-checks.json', { status: 'passed', evidenceLevel: 'local-fixture-real-button-flow', browser: 'Chromium CDP',
    executionUiImplemented: true, browserPluginAvailable: false, checks, cases, layouts, captures, pageErrors, expectedResourceErrors });
  console.log(JSON.stringify({ status: 'passed', checkCount: Object.keys(checks).length, checks, outputDirectory: OUT }, null, 2));
} catch (error) {
  save('failure.json', { status: 'failed', message: error.message, stack: error.stack, checks, cases, browserRequests, pageErrors });
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  throw error;
} finally {
  for (const held of heldResponses) held.release();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {}); await stopChild(chromiumProcess);
  save('chromium.log', chromiumLog);
  for (const [index, item] of fixtures.entries()) {
    save(`fixture-${index}-source-before.json`, item.sourceBefore);
    save(`fixture-${index}-source-after.json`, facts(item.sourceDir));
    save(`fixture-${index}-target-requests.json`, item.requests); save(`fixture-${index}-model-requests.json`, item.modelRequests);
    for (const [engineIndex, instance] of item.engines.entries()) save(`fixture-${index}-engine-${engineIndex}.log`, instance.output());
  }
  for (const item of [...fixtures].reverse()) await item.cleanup();
}
