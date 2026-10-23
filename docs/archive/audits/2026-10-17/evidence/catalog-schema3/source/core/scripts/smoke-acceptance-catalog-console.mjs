#!/usr/bin/env node
/** B1: real workers, explicit project/release binding, CAS and two-engine isolation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'acceptance-catalog-console',
  new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)));
const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-catalog-'));
const token = 'acceptance-catalog-local-fixture';
const headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const checks = {}, apiCases = [], fixtureRequests = [], children = [], catalogResponses = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(ready => setTimeout(ready, ms));
const save = (name, value) => writeFileSync(join(OUT, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
async function waitFor(fn, timeout = 25000) {
  let last;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Catalog smoke timeout: ${last?.message ?? 'state not reached'}`);
}
async function listen(server) {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = createServer();
  const base = await listen(server);
  await new Promise(ready => server.close(ready));
  return new URL(base).port;
}
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(ready => child.once('exit', ready));
    child.kill('SIGTERM');
    await Promise.race([ended, delay(5000)]);
  }
}
function runFiles(runId) {
  const dir = join(dataRoot, 'acceptance', runId);
  return Object.fromEntries(readdirSync(dir).sort().filter(file => statSync(join(dir, file)).isFile())
    .map(file => [file, digest(readFileSync(join(dir, file)))]));
}
let answerCode = 1, holdSlow = false, slowSeen = false, releaseSlow;
const fixture = createServer(async (req, res) => {
  fixtureRequests.push({ method: req.method, path: req.url, code: answerCode });
  if (holdSlow) { slowSeen = true; await new Promise(ready => { releaseSlow = ready; }); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: answerCode, quota: 10 }));
});
let engine, base, browser, page;
async function launch(root = dataRoot) {
  const address = `http://127.0.0.1:${await freePort()}`;
  const child = spawn(process.execPath, ['src/engine-server.mjs', new URL(address).port], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root,
      HEIMDALL_CONSOLE_DIR: resolve(CORE, '..', 'console', 'dist'), HEIMDALL_HOST: '127.0.0.1',
      HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, address, log: '' };
  children.push(record);
  child.stdout.on('data', value => { record.log += value; });
  child.stderr.on('data', value => { record.log += value; });
  return record;
}
const api = (path, options = {}) => fetch(base + '/api/acceptance/' + path, { headers, ...options });
async function json(path, body) {
  const response = await api(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  return { response, data };
}
const version = data => ({ expectedGenerationId: data.generationId, expectedRevision: data.revision });
async function expectApi(path, body, status, code) {
  const result = await json(path, body);
  assert.equal(result.response.status, status, `${path}: ${JSON.stringify(result.data)}`);
  if (code) assert.equal(result.data.code, code);
  assert.ok(!JSON.stringify(result.data).includes(dataRoot), 'API errors do not expose data root');
  apiCases.push({ path, status, ...(code ? { code } : {}) });
  return result.data;
}
try {
  mkdirSync(OUT, { recursive: true });
  const targetUrl = await listen(fixture) + '/release?tenant=alpha';
  const primary = await launch();
  engine = primary.child; base = primary.address;
  await waitFor(async () => (await fetch(base)).ok);
  const runIds = [];
  const spec = { source: { id: 'catalog-quota-requirement', revision: 'v1' }, approved: true,
    checks: [{ id: 'QUOTA', title: '额度状态符合需求', path: '/quota', method: 'GET',
      expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] };
  async function startRun(name) {
    await waitFor(async () => (await (await fetch(base + '/api/status', { headers })).json()).acceptance === null);
    const { response, data } = await json('runs', { mode: 'spec', name, targetUrl, spec });
    assert.equal(response.status, 202);
    runIds.push(data.runId);
    return { ...data, name };
  }
  async function complete(run) {
    await waitFor(async () => (await json('runs/' + run.runId)).data.status === 'completed');
    return (await json(`runs/${run.runId}/report`)).data;
  }
  const before = await startRun('归属前：目标额度失败');
  assert.equal((await complete(before)).gate, 'failed');
  answerCode = 0;
  const after = await startRun('归属前：目标额度通过');
  assert.equal((await complete(after)).gate, 'passed');
  holdSlow = true;
  const slow = await startRun('所有权反例：仍在执行的运行');
  await waitFor(() => slowSeen);
  const runningBytes = readFileSync(join(dataRoot, 'acceptance', slow.runId, 'manifest.json'));
  const alias = join(dataRoot, 'data-alias');
  symlinkSync(realpathSync(dataRoot), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [dataRoot, alias]) {
    const second = await launch(root);
    await waitFor(() => second.child.exitCode !== null || second.child.signalCode !== null);
    assert.notEqual(second.child.exitCode, 0);
    assert.match(second.log, /ACCEPTANCE_OWNER_UNAVAILABLE/);
    assert.deepEqual(readFileSync(join(dataRoot, 'acceptance', slow.runId, 'manifest.json')), runningBytes);
  }
  assert.equal((await json('runs/' + slow.runId)).data.status, 'running');
  releaseSlow(); holdSlow = false;
  await complete(slow);
  checks.secondEngineAndJunctionCannotRecoverActiveRun = true;
  const originals = Object.fromEntries(runIds.map(id => [id, runFiles(id)]));
  const requestsAtCatalog = fixtureRequests.length;
  assert.equal((await fetch(base + '/api/acceptance/projects')).status, 401);
  const emptyResponse = await api('projects');
  assert.equal(emptyResponse.status, 200);
  assert.equal(emptyResponse.headers.get('cache-control'), 'no-store');
  assert.equal(emptyResponse.headers.get('x-content-type-options'), 'nosniff');
  let catalog = await emptyResponse.json();
  assert.deepEqual(catalog.projects, []);
  assert.equal(catalog.revision, 0);
  save('catalog-before.json', catalog);
  const projectResult = await expectApi('projects', { ...version(catalog), name: '比赛验收演示项目' }, 201);
  const projectId = projectResult.project.id;
  catalog = await expectApi('projects', undefined, 200);
  const releaseResult = await expectApi(`projects/${projectId}/releases`, { ...version(catalog),
    label: 'release-v1', targetUrl, buildRef: 'fixture-build-declared-v1' }, 201);
  const releaseId = releaseResult.release.id;
  catalog = await expectApi('projects', undefined, 200);
  await expectApi(`projects/${projectId}/run-bindings`, { ...version(catalog), runId: before.runId, releaseId }, 201);
  catalog = await expectApi('projects', undefined, 200);
  const project2 = await expectApi('projects', { ...version(catalog), name: '独立项目' }, 201);
  catalog = await expectApi('projects', undefined, 200);
  const stale = version(catalog);
  const concurrent = await Promise.all(['release-v2-a', 'release-v2-b'].map(label => json(`projects/${projectId}/releases`,
    { ...stale, label, targetUrl, buildRef: label })));
  assert.deepEqual(concurrent.map(x => x.response.status).sort(), [201, 409]);
  assert.equal(concurrent.find(x => x.response.status === 409).data.code, 'STALE_REVISION');
  catalog = await expectApi('projects', undefined, 200);
  assert.equal(catalog.revision, stale.expectedRevision + 1);
  checks.concurrentRevisionHasExactlyOneWinner = true;
  const stableBytes = readFileSync(join(dataRoot, 'acceptance', 'catalog.json'));
  await expectApi('projects', { ...stale, name: '迟到写入' }, 409, 'STALE_REVISION');
  await expectApi('projects', { ...version(catalog), name: '未知字段', current: 'passed' }, 400, 'INVALID_INPUT');
  await expectApi('projects', { ...version(catalog), expectedRevision: String(catalog.revision), name: '错误版本类型' }, 400, 'INVALID_INPUT');
  await expectApi('projects', { ...version(catalog), expectedGenerationId: 'ag-' + randomUUID(), name: '错误谱系' }, 409, 'STALE_REVISION');
  await expectApi(`projects/${projectId}/run-bindings`, { ...version(catalog), runId: before.runId, releaseId }, 409, 'CONTEXT_ALREADY_BOUND');
  await expectApi(`projects/${project2.project.id}/run-bindings`, { ...version(catalog), runId: after.runId, releaseId }, 409, 'PROJECT_MISMATCH');
  await expectApi(`projects/${projectId}/releases`, { ...version(catalog), label: '无效地址', targetUrl: targetUrl + '#fragment' }, 400, 'INVALID_INPUT');
  assert.deepEqual(readFileSync(join(dataRoot, 'acceptance', 'catalog.json')), stableBytes);
  checks.rejectedWritesPreserveCatalog = true;
  // A distinct query is a distinct release, even though the origin and path match.
  const other = await expectApi(`projects/${projectId}/releases`, { ...version(catalog), label: '查询不同', targetUrl: targetUrl.replace('alpha', 'beta') }, 201);
  catalog = await expectApi('projects', undefined, 200);
  await expectApi(`projects/${projectId}/run-bindings`, { ...version(catalog), runId: after.runId, releaseId: other.release.id }, 409, 'PROJECT_MISMATCH');
  const unreadableBackup = readFileSync(join(dataRoot, 'acceptance', 'catalog.json'));
  try {
    writeFileSync(join(dataRoot, 'acceptance', 'catalog.json'), '{broken');
    await expectApi('projects', undefined, 503, 'CATALOG_UNAVAILABLE');
    await expectApi('projects', { ...version(catalog), name: '禁止损坏后重建空目录' }, 503, 'CATALOG_UNAVAILABLE');
    assert.equal(readFileSync(join(dataRoot, 'acceptance', 'catalog.json'), 'utf8'), '{broken');
  } finally { writeFileSync(join(dataRoot, 'acceptance', 'catalog.json'), unreadableBackup); }
  checks.fullUrlMatchAndCorruptionFailClosed = true;
  const beforeRestart = await expectApi(`projects/${projectId}`, undefined, 200);
  await stop(engine);
  const restarted = await launch(); engine = restarted.child; base = restarted.address;
  await waitFor(async () => (await fetch(base)).ok);
  assert.deepEqual(await expectApi(`projects/${projectId}`, undefined, 200), beforeRestart);
  checks.restartPreservesProjectReleaseBindings = true;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  page = await context.newPage();
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/acceptance/projects') && catalogResponses.length < 200) {
      catalogResponses.push({ method: response.request().method(), path, status: response.status() });
    }
  });
  page.on('requestfailed', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/acceptance/projects') && catalogResponses.length < 200) {
      catalogResponses.push({ method: request.method(), path, failure: request.failure()?.errorText ?? 'request failed' });
    }
  });
  const errors = [], expectedResourceErrors = [];
  let catalogCorruptionVisible = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (!['error', 'warning'].includes(message.type())) return;
    if (message.text().includes('409')) expectedResourceErrors.push({ reason: 'explicit revision conflict', message: message.text() });
    else if (catalogCorruptionVisible && message.text().includes('503')) expectedResourceErrors.push({ reason: 'owned fixture catalog corruption', message: message.text() });
    else errors.push(message.text());
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).origin, base);
  assert.match(await page.title(), /Heimdall/i);
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  const panel = page.getByTestId('acceptance-catalog');
  await panel.getByTestId('catalog-toggle').click();
  await panel.locator('[name="catalog-project"]').selectOption(projectId);
  await panel.locator(`[data-binding-run="${before.runId}"]`).waitFor();
  await panel.getByTestId('catalog-new-project').locator('summary').click();
  await panel.locator('[name="catalog-project-name"]').fill('控制台创建项目');
  await panel.getByTestId('catalog-create-project').click();
  await waitFor(async () => {
    const value = await panel.locator('[name="catalog-project"]').inputValue();
    return value && value !== projectId;
  });
  const uiProjectId = await panel.locator('[name="catalog-project"]').inputValue();
  await panel.getByTestId('catalog-new-release').locator('summary').click();
  await panel.locator('[name="catalog-release-label"]').fill('控制台版本');
  await panel.locator('[name="catalog-release-target"]').fill(targetUrl);
  await panel.locator('[name="catalog-release-build-ref"]').fill('ui-build-declaration');
  await panel.getByTestId('catalog-create-release').click();
  await waitFor(async () => await panel.locator('[name="catalog-binding-release"] option').count() > 1);
  const uiRelease = (await expectApi(`projects/${uiProjectId}`, undefined, 200)).releases[0];
  await panel.locator('[name="catalog-binding-release"]').selectOption(uiRelease.id);
  await panel.locator('[name="catalog-binding-run"]').selectOption(after.runId);
  assert.equal(await panel.getByTestId('catalog-bind-run').isDisabled(), true);
  await panel.locator('[name="catalog-binding-confirmed"]').check();
  await panel.getByTestId('catalog-bind-run').click();
  await panel.locator(`[data-binding-run="${after.runId}"]`).waitFor();
  assert.equal(await panel.locator('[name="catalog-binding-run"]').inputValue(), '');
  checks.consoleCreatesProjectReleaseAndExplicitBinding = true;
  await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, 'catalog-desktop.png'), fullPage: false });
  // Another window wins; this window must retain its draft without retrying the POST.
  await panel.locator('[name="catalog-project-name"]').fill('冲突后保留的项目草稿');
  const latest = await expectApi('projects', undefined, 200);
  await expectApi('projects', { ...version(latest), name: '另一个窗口写入' }, 201);
  let conflictPosts = 0;
  const countConflict = req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/acceptance/projects') conflictPosts++; };
  page.on('request', countConflict);
  await panel.getByTestId('catalog-create-project').click();
  await panel.getByTestId('catalog-error').waitFor();
  assert.match(await panel.getByTestId('catalog-error').innerText(), /STALE_REVISION|版本|变化|冲突/);
  assert.equal(await panel.locator('[name="catalog-project-name"]').inputValue(), '冲突后保留的项目草稿');
  await delay(300);
  assert.equal(conflictPosts, 1);
  page.off('request', countConflict);
  await page.screenshot({ path: join(OUT, 'catalog-conflict.png'), fullPage: false });
  await panel.getByTestId('catalog-refresh').click();
  await waitFor(async () => !(await panel.getByTestId('catalog-error').count()));
  assert.equal(await panel.locator('[name="catalog-project-name"]').inputValue(), '冲突后保留的项目草稿');
  checks.consoleConflictPreservesDraftWithoutAutomaticRetry = true;
  // A delayed detail response must not re-select or populate a different project.
  const heldDetail = await expectApi(`projects/${projectId}`, undefined, 200);
  let releaseDetail, detailHeld = false, detailFinished = false;
  const detailGate = new Promise(ready => { releaseDetail = ready; });
  await page.route(`**/api/acceptance/projects/${projectId}`, async route => {
    detailHeld = true; await detailGate;
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(heldDetail) }); }
    catch { /* Switching projects intentionally aborts this read. */ }
    finally { detailFinished = true; }
  }, { times: 1 });
  await panel.locator('[name="catalog-project"]').selectOption(projectId);
  await waitFor(() => detailHeld);
  await panel.locator('[name="catalog-project"]').selectOption(uiProjectId);
  await panel.locator(`[data-binding-run="${after.runId}"]`).waitFor();
  releaseDetail();
  await waitFor(() => detailFinished);
  assert.equal(await panel.locator('[name="catalog-project"]').inputValue(), uiProjectId);
  assert.equal(await panel.locator(`[data-binding-run="${before.runId}"]`).count(), 0);
  checks.delayedDetailsCannotReplaceCurrentProject = true;
  // The POST commits to its captured project even when its response arrives later.
  const releaseDetails = panel.getByTestId('catalog-new-release');
  if (await releaseDetails.getAttribute('open') === null) await releaseDetails.locator('summary').click();
  await panel.locator('[name="catalog-release-label"]').fill('延迟响应版本');
  await panel.locator('[name="catalog-release-target"]').fill(targetUrl);
  let releasePost, postHeld = false, postStatus, postDelivery;
  const postGate = new Promise(ready => { releasePost = ready; });
  await page.route(`**/api/acceptance/projects/${uiProjectId}/releases`, async route => {
    const result = await route.fetch();
    postStatus = result.status();
    postHeld = true; await postGate;
    try { await route.fulfill({ response: result }); postDelivery = { delivered: true }; }
    catch (problem) { postDelivery = { delivered: false, message: problem.message }; }
  }, { times: 1 });
  await panel.getByTestId('catalog-create-release').click();
  await waitFor(() => postHeld);
  assert.equal(postStatus, 201, 'the delayed release response must acknowledge a committed write');
  await panel.locator('[name="catalog-project"]').selectOption(projectId);
  await panel.locator(`[data-binding-run="${before.runId}"]`).waitFor();
  const currentDetails = panel.getByTestId('catalog-new-release');
  if (await currentDetails.getAttribute('open') === null) await currentDetails.locator('summary').click();
  await panel.locator('[name="catalog-release-label"]').fill('当前项目未提交草稿');
  releasePost();
  await waitFor(() => postDelivery);
  assert.equal(postDelivery.delivered, true, postDelivery.message);
  await waitFor(async () => {
    const errors = await panel.getByTestId('catalog-error').allTextContents();
    assert.deepEqual(errors, [], 'delayed release write failed: ' + errors.join(' '));
    return (await panel.getByTestId('catalog-notice').allTextContents()).join(' ').includes('延迟响应版本');
  });
  assert.equal(await panel.locator('[name="catalog-project"]').inputValue(), projectId);
  assert.equal(await panel.locator('[name="catalog-release-label"]').inputValue(), '当前项目未提交草稿');
  assert.ok((await expectApi(`projects/${uiProjectId}`, undefined, 200)).releases.some(item => item.label === '延迟响应版本'));
  assert.ok(!(await expectApi(`projects/${projectId}`, undefined, 200)).releases.some(item => item.label === '延迟响应版本'));
  checks.delayedPostPreservesCurrentProjectAndDraft = true;
  // Returning to A after visiting B must not make an old A response current again.
  const newProjectDetails = panel.getByTestId('catalog-new-project');
  if (await newProjectDetails.getAttribute('open') === null) await newProjectDetails.locator('summary').click();
  await panel.locator('[name="catalog-project-name"]').fill('A-B-A 迟到创建项目');
  let releaseProjectPost, projectPostHeld = false, projectPostStatus, projectPostDelivery;
  const projectPostGate = new Promise(ready => { releaseProjectPost = ready; });
  await page.route('**/api/acceptance/projects', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const result = await route.fetch();
    projectPostStatus = result.status();
    projectPostHeld = true; await projectPostGate;
    try { await route.fulfill({ response: result }); projectPostDelivery = { delivered: true }; }
    catch (problem) { projectPostDelivery = { delivered: false, message: problem.message }; }
  }, { times: 1 });
  await panel.getByTestId('catalog-create-project').click();
  await waitFor(() => projectPostHeld);
  assert.equal(projectPostStatus, 201, 'the delayed project response must acknowledge a committed write');
  await panel.locator('[name="catalog-project"]').selectOption(uiProjectId);
  await panel.locator(`[data-binding-run="${after.runId}"]`).waitFor();
  await panel.locator('[name="catalog-project"]').selectOption(projectId);
  await panel.locator(`[data-binding-run="${before.runId}"]`).waitFor();
  releaseProjectPost();
  await waitFor(() => projectPostDelivery);
  assert.equal(projectPostDelivery.delivered, true, projectPostDelivery.message);
  await waitFor(async () => {
    const errors = await panel.getByTestId('catalog-error').allTextContents();
    assert.deepEqual(errors, [], 'delayed project write failed: ' + errors.join(' '));
    return (await panel.getByTestId('catalog-notice').allTextContents()).join(' ').includes('A-B-A 迟到创建项目');
  });
  assert.equal(await panel.locator('[name="catalog-project"]').inputValue(), projectId);
  assert.equal(await panel.locator('[name="catalog-release-label"]').inputValue(), '当前项目未提交草稿');
  checks.projectSelectionEpochRejectsABAResponse = true;
  const uiCatalogBytes = readFileSync(join(dataRoot, 'acceptance', 'catalog.json'));
  try {
    catalogCorruptionVisible = true;
    writeFileSync(join(dataRoot, 'acceptance', 'catalog.json'), '{owned-ui-corruption-fixture');
    await panel.getByTestId('catalog-refresh').click();
    await panel.getByTestId('catalog-error').waitFor();
    assert.match(await panel.getByTestId('catalog-error').innerText(), /CATALOG_UNAVAILABLE/);
    assert.equal(await panel.locator('[name="catalog-project"]').inputValue(), projectId);
    assert.ok(await panel.locator('[name="catalog-project"] option').count() > 1);
    await panel.getByTestId('catalog-error').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, 'catalog-unavailable.png'), fullPage: false });
  } finally {
    writeFileSync(join(dataRoot, 'acceptance', 'catalog.json'), uiCatalogBytes);
    catalogCorruptionVisible = false;
  }
  await panel.getByTestId('catalog-refresh').click();
  await waitFor(async () => !(await panel.getByTestId('catalog-error').count()));
  assert.equal(await panel.locator('[name="catalog-release-label"]').inputValue(), '当前项目未提交草稿');
  checks.unavailableIsDistinctFromEmptyAndRecoveryPreservesDraft = true;
  const layouts = [];
  for (const size of [{ width: 390, height: 844 }, { width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    if (size.width < 761) await page.getByTestId('acceptance-view-results').click();
    else await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
    const layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      panelWidth: document.querySelector('[data-testid="acceptance-catalog"]').getBoundingClientRect().width }));
    assert.ok(layout.scrollWidth <= size.width + 1, JSON.stringify(layout));
    layouts.push({ ...size, ...layout });
    await page.screenshot({ path: join(OUT, `catalog-${size.width}.png`), fullPage: false });
  }
  checks.responsiveLayouts = true;
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = panel.getByTestId('catalog-toggle');
  await toggle.focus();
  await toggle.press('Enter');
  await waitFor(async () => await panel.getAttribute('open') === null);
  await toggle.press('Enter');
  await waitFor(async () => await panel.getAttribute('open') !== null);
  assert.equal(await toggle.evaluate(element => document.activeElement === element), true);
  checks.keyboardCanToggleWithoutLosingFocus = true;
  const contrasts = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const readings = await panel.evaluate(element => {
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
        });
        return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
      };
      return ['.catalog-hint', '.catalog-primary', '.catalog-version', '.catalog-boundary', '.catalog-new-project > summary', '.catalog-new-release > summary'].map(selector => {
        const item = element.querySelector(selector);
        let ancestor = item;
        while (ancestor && getComputedStyle(ancestor).backgroundColor === 'rgba(0, 0, 0, 0)') ancestor = ancestor.parentElement;
        const foreground = luminance(getComputedStyle(item).color), background = luminance(getComputedStyle(ancestor).backgroundColor);
        return { selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
      });
    });
    assert.ok(readings.every(item => item.ratio >= 4.5), `${theme} catalog text contrast: ${JSON.stringify(readings)}`);
    contrasts.push({ theme, readings });
    await toggle.scrollIntoViewIfNeeded();
    if (theme === 'light') await page.screenshot({ path: join(OUT, 'catalog-mobile-light.png'), fullPage: false });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const largerText = await page.addStyleTag({ content: '.catalog-panel p,.catalog-panel small,.catalog-panel label,.catalog-panel button,.catalog-panel select,.catalog-panel code {font-size:24px!important;line-height:1.6!important;}' });
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'enlarged catalog text stays inside panel');
  await largerText.evaluate(element => element.remove());
  checks.themeContrastAndEnlargedText = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.locator('[name="catalog-project"]').selectOption(projectId);
  await panel.locator(`[data-binding-run="${before.runId}"]`).waitFor();
  await panel.locator(`[data-testid="catalog-open-run"][data-run-id="${before.runId}"]`).click();
  await waitFor(async () => (await page.locator('.aw-report-head').innerText()).includes(before.name));
  assert.match(await page.getByTestId('acceptance-gate').innerText(), /发现缺陷/);
  checks.originalReportAndGateRemainVisible = true;
  assert.deepEqual(Object.fromEntries(runIds.map(id => [id, runFiles(id)])), originals);
  assert.equal(fixtureRequests.length, requestsAtCatalog);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  checks.noTargetRequestsOrOriginalRunMutations = true;
  checks.pageIdentityNonblankOverlayAndConsoleHealthy = true;
  for (const runId of runIds) cpSync(join(dataRoot, 'acceptance', runId), join(OUT, 'run-evidence', runId), { recursive: true });
  save('run-file-digests.json', originals);
  save('catalog-after.json', await expectApi('projects', undefined, 200));
  save('catalog-storage.json', JSON.parse(readFileSync(join(dataRoot, 'acceptance', 'catalog.json'), 'utf8')));
  save('project-detail.json', await expectApi(`projects/${projectId}`, undefined, 200));
  save('api-cases.json', apiCases);
  save('fixture-requests.json', fixtureRequests);
  const result = { status: 'passed', evidenceLevel: 'local-fixture-real-flow',
    browser: 'Browser plugin not available; existing Playwright Chromium',
    scope: '真实 Spec worker→项目/版本/后续归属→并发CAS→双引擎/别名→重启→真实控制台；不包含基线批准或托管执行。',
    checkCount: Object.keys(checks).length, checks, layouts, contrasts, errors, expectedResourceErrors, runIds, originalGates: ['failed', 'passed', 'passed'],
    apiCaseCount: apiCases.length, catalogTargetRequests: fixtureRequests.length - requestsAtCatalog };
  save('browser-checks.json', result);
  save('catalog-responses.json', catalogResponses);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  mkdirSync(OUT, { recursive: true });
  save('failure.json', { status: 'failed', message: error.message, checks, apiCases, catalogResponses });
  if (page && !page.isClosed()) {
    try {
      const state = await page.getByTestId('acceptance-catalog').evaluate(element => ({
        text: element.innerText, html: element.outerHTML,
        projectId: element.querySelector('[name="catalog-project"]')?.value ?? null,
        busy: element.querySelector('.catalog-body')?.getAttribute('aria-busy') ?? null,
        notices: [...element.querySelectorAll('[data-testid="catalog-notice"]')].map(item => item.textContent.slice(0, 1000)),
        errors: [...element.querySelectorAll('[data-testid="catalog-error"]')].map(item => item.textContent.slice(0, 1000)),
      }));
      save('failure-ui.json', state);
      console.error('Catalog smoke UI state: ' + JSON.stringify({ projectId: state.projectId, busy: state.busy,
        notices: state.notices, errors: state.errors, responses: catalogResponses.slice(-12) }));
      await page.screenshot({ path: join(OUT, 'catalog-failure.png'), fullPage: false });
    } catch { /* Preserve the original failure when the page is unavailable. */ }
  }
  throw error;
} finally {
  releaseSlow?.();
  await browser?.close();
  for (const record of children) { await stop(record.child); save(`engine-${children.indexOf(record)}.log`, record.log); }
  fixture.closeAllConnections();
  await new Promise(ready => fixture.close(ready));
  // Only delete the unique fixture tree after resolving and checking its boundary.
  const resolved = resolve(dataRoot);
  assert.ok(resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes('heimdall-acceptance-catalog-'));
  if (existsSync(join(dataRoot, 'data-alias'))) unlinkSync(join(dataRoot, 'data-alias'));
  rmSync(resolved, { recursive: true, force: true });
}
