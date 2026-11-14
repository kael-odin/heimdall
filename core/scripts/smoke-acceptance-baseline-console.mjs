#!/usr/bin/env node
/** Real Spec workers, full contract review and independent approval/selection records. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'acceptance-baseline-console',
  new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)));
const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-baseline-'));
const acceptanceRoot = join(dataRoot, 'acceptance'), token = 'acceptance-baseline-local-fixture';
const headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const checks = {}, apiCases = [], fixtureRequests = [], errors = [], expectedResourceErrors = [], browserPosts = [], browserPostByRequest = new Map();
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(ready => setTimeout(ready, ms));
const save = (name, value) => writeFileSync(join(OUT, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
async function waitFor(fn, label = 'state', timeout = 25000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(80);
  }
  throw new Error(`Baseline smoke timeout (${label}): ${last?.message ?? 'state not reached'}`);
}
async function listen(server) {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = createServer(), address = await listen(server);
  await new Promise(ready => server.close(ready)); return new URL(address).port;
}
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(ready => child.once('exit', ready)); child.kill('SIGTERM');
    await Promise.race([ended, delay(5000)]);
  }
}
function runFiles(runId) {
  const root = join(acceptanceRoot, runId), result = {};
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name), key = prefix + name;
      if (statSync(file).isDirectory()) walk(file, key + '/');
      else result[key] = digest(readFileSync(file));
    }
  };
  walk(root); return result;
}
const runDirectories = () => readdirSync(acceptanceRoot).filter(name => /^ac-[a-f0-9-]{36}$/.test(name)).sort();
const fixture = createServer((req, res) => {
  fixtureRequests.push({ method: req.method, path: req.url });
  if (req.method === 'HEAD') { res.writeHead(204); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 1, quota: 10, enabled: false, name: '' }));
});
let engine, engineLog = '', base, browser, page, movedRun, restoredRun;
const api = async (path, body) => {
  const response = await fetch(`${base}/api/acceptance/${path}`, { headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await response.json(); apiCases.push({ path, method: body === undefined ? 'GET' : 'POST', status: response.status, code: data.code });
  assert.ok(!JSON.stringify(data).includes(dataRoot), 'HTTP does not expose private filesystem paths');
  return { response, data };
};
async function ok(path, body, status = body === undefined ? 200 : 201) {
  const { response, data } = await api(path, body); assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`); return data;
}
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const latest = () => ok('projects');
const detailOf = id => ok(`projects/${id}`);
try {
  mkdirSync(OUT, { recursive: true });
  const targetUrl = await listen(fixture) + '/release?tenant=alpha';
  base = `http://127.0.0.1:${await freePort()}`;
  engine = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: resolve(CORE, '..', 'console', 'dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.stdout.on('data', value => { engineLog += value; }); engine.stderr.on('data', value => { engineLog += value; });
  await waitFor(async () => (await fetch(base)).ok, 'engine');
  const contracts = [
    { id: 'QUOTA', title: '需求预期保持正确，即使目标额度失败', method: 'GET', path: '/quota', severity: 'high',
      expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 },
        { pointer: '/enabled', kind: 'equals', value: false }, { pointer: '/name', kind: 'equals', value: '' }],
      schema: { type: 'object', required: ['code', 'quota', 'enabled', 'name'], additionalProperties: false,
        properties: { code: { type: 'integer' }, quota: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' }, name: { type: 'string' } } } } },
    { id: 'HEALTH', title: '只读HEAD健康合同', method: 'HEAD', path: '/health', severity: 'medium', expect: { status: 204 } },
  ];
  const runs = [];
  for (const approved of [false, true]) {
    await waitFor(async () => (await (await fetch(`${base}/api/status`, { headers })).json()).acceptance === null, 'idle worker');
    const run = await ok('runs', { mode: 'spec', name: approved ? '完整需求 / 目标失败' : '完整需求草稿 / 未发请求', targetUrl,
      spec: { source: { id: 'baseline-quota-requirement', revision: 'v1', type: 'manual', title: '额度与健康需求' }, approved, checks: contracts, omissions: [] } }, 202);
    await waitFor(async () => (await ok(`runs/${run.runId}`)).status === 'completed', 'real Spec worker');
    const report = await ok(`runs/${run.runId}/report`);
    assert.equal(report.gate, approved ? 'failed' : 'blocked'); runs.push({ runId: run.runId, gate: report.gate, approved });
  }
  const [draftRun, failedRun] = runs;
  let directory = await latest();
  const projectA = (await ok('projects', { ...cas(directory), name: '需求合同验收项目 A' })).project;
  directory = await latest();
  const release = (await ok(`projects/${projectA.id}/releases`, { ...cas(directory), label: 'Spec 声明 v1', targetUrl, buildRef: 'baseline-smoke-v1' })).release;
  for (const run of runs) {
    directory = await latest(); await ok(`projects/${projectA.id}/run-bindings`, { ...cas(directory), runId: run.runId, releaseId: release.id });
  }
  directory = await latest();
  const projectB = (await ok('projects', { ...cas(directory), name: '独立项目 B' })).project;
  const originals = Object.fromEntries(runs.map(run => [run.runId, runFiles(run.runId)]));
  const requestsAtReview = fixtureRequests.length, directoriesAtReview = runDirectories();
  checks.realWorkersProduceDraftAndFailedTarget = true;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (!['error', 'warning'].includes(message.type())) return;
    if (/409|502|ERR_FAILED|net::ERR_FAILED/.test(message.text())) expectedResourceErrors.push(message.text()); else errors.push(message.text());
  });
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().includes('/baseline-')) return;
    const entry = { url: new URL(request.url()).pathname, body: request.postDataJSON(), status: null, response: null };
    browserPosts.push(entry); browserPostByRequest.set(request, entry);
  });
  page.on('response', async response => {
    const entry = browserPostByRequest.get(response.request()); if (!entry) return;
    entry.status = response.status();
    try { entry.response = await response.json(); } catch { entry.response = null; }
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Heimdall/i); assert.equal(new URL(page.url()).origin, base);
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  const panel = page.getByTestId('acceptance-catalog'); await panel.getByTestId('catalog-toggle').click();
  const projectSelect = panel.locator('[name="catalog-project"]');
  const selectProject = async id => {
    await waitFor(async () => !(await projectSelect.isDisabled()) && await projectSelect.locator('option').count() > 1, 'project selector ready');
    await projectSelect.selectOption(id);
  };
  await selectProject(projectA.id);
  const baseline = panel.getByTestId('acceptance-baseline');
  const waitReady = () => waitFor(async () => !(await panel.getByTestId('catalog-refresh').isDisabled())
    && (await baseline.getByTestId('baseline-source').count()) && !(await baseline.getByTestId('baseline-source').isDisabled()), 'ready baseline');
  const refresh = async () => { await panel.getByTestId('catalog-refresh').click(); await waitReady();
    await waitFor(async () => !(await panel.getByTestId('catalog-error').count()), 'reconciled directory'); };
  const reviewCandidate = async id => {
    await baseline.locator(`[data-testid="baseline-preview-candidate"][data-candidate-id="${id}"]`).click();
    await baseline.getByTestId('baseline-full-expect').first().waitFor();
    await waitFor(async () => (await baseline.getByTestId('baseline-eligibility').innerText()).includes('内容一致'), 'eligible preview');
  };
  const reviewApproval = async id => {
    await baseline.locator(`[data-testid="baseline-review-approval"][data-approval-id="${id}"]`).click();
    await baseline.getByTestId('baseline-selection-form').waitFor();
    await waitFor(async () => !(await baseline.getByTestId('baseline-selection-confirm').isDisabled()), 'fresh selection preview');
  };
  const approve = async (reason, expectFailure = false) => {
    await baseline.getByTestId('baseline-approval-reason').fill(reason); await baseline.getByTestId('baseline-approval-confirm').check();
    await baseline.getByTestId('baseline-approve').click();
    if (expectFailure) await panel.getByTestId('catalog-error').waitFor(); else await waitReady();
  };
  const select = async (approvalId, reason) => {
    await reviewApproval(approvalId); await baseline.getByTestId('baseline-selection-reason').fill(reason);
    await baseline.getByTestId('baseline-selection-confirm').check(); await baseline.getByTestId('baseline-select').click();
    await waitFor(async () => (await detailOf(projectA.id)).currentSelections.spec?.approvalId === approvalId, 'selected approval'); await waitReady();
  };
  const cancel = async reason => {
    await baseline.getByTestId('baseline-open-cancel').click(); await baseline.getByTestId('baseline-cancel-reason').fill(reason);
    await baseline.getByTestId('baseline-cancel-confirm').check(); await baseline.getByTestId('baseline-cancel').click();
    await waitFor(async () => (await detailOf(projectA.id)).currentSelections.spec?.approvalId === null, 'cancelled selection'); await waitReady();
    await waitFor(async () => (await baseline.getByTestId('baseline-current').innerText()).includes('尚未选用'), 'cancelled UI');
    assert.equal(await baseline.getByTestId('baseline-open-cancel').count(), 0);
  };
  await waitReady();
  for (const run of runs) {
    const previous = await detailOf(projectA.id);
    await baseline.getByTestId('baseline-source').selectOption(run.runId); await baseline.getByTestId('baseline-create-candidate').click();
    await waitFor(async () => (await detailOf(projectA.id)).candidates.length === previous.candidates.length + 1, 'candidate committed');
    await waitReady();
    const value = await detailOf(projectA.id), candidate = value.candidates.at(-1); run.candidateId = candidate.id;
    // The candidate POST is never enough to enable approve without a complete fresh GET.
    if (!(await baseline.getByTestId('baseline-full-expect').count())) await reviewCandidate(candidate.id);
    await waitFor(async () => await baseline.getByTestId('baseline-full-expect').count() === contracts.length, 'complete expected DOM');
    const preview = await ok(`projects/${projectA.id}/baseline-candidates/${candidate.id}`);
    assert.equal(preview.executionReady, false); assert.equal(preview.preview.sourceSpecApproved, run.approved);
    assert.equal(preview.preview.sourceGate, run.gate);
    assert.deepEqual((await baseline.getByTestId('baseline-full-expect').allTextContents()).map(JSON.parse), preview.preview.checks.map(check => check.expect));
    assert.equal(await baseline.getByTestId('baseline-approve').isDisabled(), true);
    const oldCurrent = value.currentSelections.spec;
    await approve(run.approved ? '已核对需求，目标失败不改变正确预期' : '已核对完整草稿，批准需求合同');
    await waitFor(async () => (await detailOf(projectA.id)).approvals.length === previous.approvals.length + 1, 'approval committed');
    const after = await detailOf(projectA.id); run.approvalId = after.approvals.at(-1).id;
    assert.deepEqual(after.currentSelections.spec, oldCurrent, 'approval cannot silently change current');
    await select(run.approvalId, run.approved ? '单独选用失败目标对应的正确需求' : '单独选用完整草稿需求');
  }
  checks.completeExpectedPreviewAndIndependentApprovalSelection = true;
  await select(draftRun.approvalId, '显式回退到第一条需求批准');
  await cancel('独立取消当前选用，保留所有历史');
  await select(failedRun.approvalId, '重新选用，准备来源变化反例');
  const afterLifecycle = await detailOf(projectA.id);
  assert.equal(afterLifecycle.approvals.length, 2); assert.equal(afterLifecycle.selections.length, 5);
  checks.cancelAndRollbackAppendHistory = true;

  await reviewCandidate(failedRun.candidateId);
  await baseline.getByTestId('baseline-review').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'baseline-desktop-contracts.png'), fullPage: false });
  save('complete-preview.json', await ok(`projects/${projectA.id}/baseline-candidates/${failedRun.candidateId}`));
  // An old A preview must stay stale even after the user visits B and returns to A.
  let releasePreview, heldPreview = false;
  const previewGate = new Promise(ready => { releasePreview = ready; });
  await page.route(`**/api/acceptance/projects/${projectA.id}/baseline-candidates/${draftRun.candidateId}`, async route => {
    const response = await route.fetch(); heldPreview = true; await previewGate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await baseline.locator(`[data-testid="baseline-preview-candidate"][data-candidate-id="${draftRun.candidateId}"]`).click();
  await waitFor(() => heldPreview, 'held preview');
  await selectProject(projectB.id);
  await waitFor(async () => (await baseline.innerText()).includes('还没有已归属'), 'project B detail');
  await selectProject(projectA.id); await waitReady();
  releasePreview(); await delay(180);
  assert.equal(await baseline.getByTestId('baseline-full-expect').count(), 0);
  assert.equal(await panel.locator('[name="catalog-project"]').inputValue(), projectA.id);
  checks.latePreviewProjectABACannotRestoreConfirmation = true;

  await reviewCandidate(failedRun.candidateId);
  await baseline.getByTestId('baseline-approval-reason').fill('冲突后保留的批准理由'); await baseline.getByTestId('baseline-approval-confirm').check();
  directory = await latest(); await ok('projects', { ...cas(directory), name: '另一个窗口更新目录' });
  const postsAtConflict = browserPosts.length;
  await baseline.getByTestId('baseline-approve').click(); await panel.getByTestId('catalog-error').waitFor();
  assert.match(await panel.getByTestId('catalog-error').innerText(), /STALE_REVISION/); await delay(150);
  assert.equal(browserPosts.length, postsAtConflict + 1);
  await panel.getByTestId('catalog-error').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(OUT, 'baseline-conflict.png'), fullPage: false });
  await refresh(); await reviewCandidate(failedRun.candidateId);
  assert.equal(await baseline.getByTestId('baseline-approval-reason').inputValue(), '冲突后保留的批准理由');
  assert.equal(await baseline.getByTestId('baseline-approval-confirm').isChecked(), false);
  checks.conflictPreservesReasonAndRequiresFreshReviewWithoutReplay = true;

  // The backend commits, but the browser receives either a non-JSON gateway error or no response.
  for (const fault of [{ kind: 'html502', reason: '网关HTML502但服务端可能已提交' },
    { kind: 'lost-response', reason: '响应丢失但服务端可能已提交' }]) {
    let uncertainId;
    await page.route(`**/api/acceptance/projects/${projectA.id}/baseline-approvals`, async route => {
      const response = await route.fetch(), value = await response.json(); assert.equal(response.status(), 201);
      uncertainId = value.approval.id;
      if (fault.kind === 'html502') await route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' });
      else await route.abort('failed');
    }, { times: 1 });
    const postsAtLoss = browserPosts.length;
    await approve(fault.reason, true);
    await waitFor(() => uncertainId, 'uncertain response committed'); await delay(150);
    assert.equal(browserPosts.length, postsAtLoss + 1);
    const afterUncertain = await detailOf(projectA.id);
    assert.ok(afterUncertain.approvals.some(value => value.id === uncertainId));
    assert.equal(afterUncertain.currentSelections.spec.approvalId, failedRun.approvalId);
    assert.match(await panel.getByTestId('catalog-error').innerText(), /可能已经提交/);
    assert.equal(await baseline.getByTestId('baseline-source').isDisabled(), true);
    await refresh(); await reviewCandidate(failedRun.candidateId);
    assert.equal(await baseline.getByTestId('baseline-approval-reason').inputValue(), fault.reason);
    assert.equal(await baseline.getByTestId('baseline-approval-confirm').isChecked(), false);
  }
  checks.nonJsonGateway502ReconcilesCommittedHistoryWithoutReplay = true;
  checks.lostPostResponseReconcilesCommittedHistoryWithoutReplay = true;

  let releasePost, heldPost = false;
  const postGate = new Promise(ready => { releasePost = ready; });
  await page.route(`**/api/acceptance/projects/${projectA.id}/baseline-approvals`, async route => {
    const response = await route.fetch(); heldPost = true; await postGate; await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await baseline.getByTestId('baseline-approval-reason').fill('项目切换后的迟到批准仍属于 A'); await baseline.getByTestId('baseline-approval-confirm').check();
  await baseline.getByTestId('baseline-approve').click(); await waitFor(() => heldPost, 'held approval');
  await selectProject(projectB.id);
  await waitFor(async () => (await baseline.innerText()).includes('还没有已归属'), 'project B while posting');
  releasePost(); await waitFor(async () => (await panel.getByTestId('catalog-notice').innerText()).includes('合同批准已记录'), 'captured project completion');
  assert.equal(await projectSelect.inputValue(), projectB.id);
  assert.equal((await detailOf(projectB.id)).approvals.length, 0);
  await selectProject(projectA.id); await waitReady();
  checks.lateApprovalDoesNotSwitchProjectOrAutoSelect = true;

  // Modifying a source after preview is caught by the final approval operation.
  await reviewCandidate(failedRun.candidateId);
  const reportFile = join(acceptanceRoot, failedRun.runId, 'report.json'), reportBytes = readFileSync(reportFile);
  const beforeTamper = await detailOf(projectA.id);
  try {
    writeFileSync(reportFile, Buffer.concat([reportBytes, Buffer.from(' ')]));
    await approve('预览后来源变更，不得批准旧摘要', true);
    assert.match(await panel.getByTestId('catalog-error').innerText(), /SOURCE_INTEGRITY_FAILED|BASELINE_CHANGED/);
    const unavailable = await ok(`projects/${projectA.id}/baseline-candidates/${failedRun.candidateId}`);
    assert.equal(unavailable.preview, null); assert.equal(unavailable.diagnostics.eligible, false);
    assert.equal((await detailOf(projectA.id)).approvals.length, beforeTamper.approvals.length);
    save('tampered-source-preview.json', unavailable);
  } finally { writeFileSync(reportFile, reportBytes); }
  await refresh();
  checks.finalApprovalRevalidatesSourceBytes = true;

  restoredRun = join(acceptanceRoot, failedRun.runId); movedRun = restoredRun + '-missing'; renameSync(restoredRun, movedRun);
  try {
    await refresh();
    await baseline.locator(`[data-testid="baseline-preview-candidate"][data-candidate-id="${failedRun.candidateId}"]`).click();
    await waitFor(async () => (await baseline.getByTestId('baseline-eligibility').innerText()).includes('不可批准'), 'missing source preview');
    assert.equal(await baseline.getByTestId('baseline-full-expect').count(), 0);
    assert.ok((await detailOf(projectA.id)).currentSelections.spec);
    await baseline.getByTestId('baseline-current').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, 'baseline-source-missing.png'), fullPage: false });
    await cancel('来源缺失仍能独立取消当前选用');
    const value = await detailOf(projectA.id);
    assert.equal(value.candidates.length, 2); assert.equal(value.approvals.length, 5); assert.equal(value.currentSelections.spec.approvalId, null);
  } finally { renameSync(movedRun, restoredRun); movedRun = null; }
  await refresh(); await select(draftRun.approvalId, '来源恢复后显式回退到完整草稿批准');
  checks.missingSourceRetainsHistoryAndCancellationDoesNotReadSource = true;

  await reviewCandidate(draftRun.candidateId);
  const layouts = [];
  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('acceptance-view-results').click();
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await baseline.getByTestId('baseline-review').scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      baselineWidth: document.querySelector('[data-testid="acceptance-baseline"]').getBoundingClientRect().width }));
    assert.ok(layout.scrollWidth <= 391, JSON.stringify(layout)); layouts.push({ theme, ...layout });
    await page.screenshot({ path: join(OUT, `baseline-mobile-${theme}.png`), fullPage: false });
  }
  checks.desktopMobileAndBothThemesRenderWithoutHorizontalOverflow = true;
  assert.deepEqual(Object.fromEntries(runs.map(run => [run.runId, runFiles(run.runId)])), originals);
  assert.equal(fixtureRequests.length, requestsAtReview); assert.deepEqual(runDirectories(), directoriesAtReview);
  assert.equal((await (await fetch(`${base}/api/status`, { headers })).json()).acceptance, null);
  checks.noTargetRequestsNewWorkersOrSourceRunMutations = true;
  assert.equal(await page.locator('vite-error-overlay').count(), 0); assert.deepEqual(errors, []);
  checks.pageIdentityNonblankOverlayAndConsoleHealthy = true;
  for (const run of runs) cpSync(join(acceptanceRoot, run.runId), join(OUT, 'run-evidence', run.runId), { recursive: true });
  save('run-file-digests.json', originals); save('catalog-storage.json', JSON.parse(readFileSync(join(acceptanceRoot, 'catalog.json'), 'utf8')));
  save('project-detail.json', await detailOf(projectA.id)); save('browser-posts.json', browserPosts);
  save('api-cases.json', apiCases); save('fixture-requests.json', fixtureRequests);
  const result = { status: 'passed', evidenceLevel: 'local-fixture-real-flow',
    browser: 'Browser plugin not available; existing Playwright Chromium', url: base,
    scope: '真实Spec draft/failed worker产物→项目绑定→完整source/expected预览→独立批准/选用/取消/回退；含真实API传输故障注入，不启动managed执行。',
    checkCount: Object.keys(checks).length, checks, layouts, errors, expectedResourceErrors, runs, browserPostCount: browserPosts.length,
    reviewTargetRequests: fixtureRequests.length - requestsAtReview, newRunCount: runDirectories().length - directoriesAtReview.length };
  save('browser-checks.json', result); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  mkdirSync(OUT, { recursive: true }); save('failure.json', { status: 'failed', message: error.message, checks, errors, expectedResourceErrors, apiCases, browserPosts });
  if (page) { await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {}); save('failure-dom.txt', await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally {
  if (movedRun && existsSync(movedRun) && !existsSync(restoredRun)) renameSync(movedRun, restoredRun);
  await browser?.close(); await stop(engine); save('engine.log', engineLog);
  fixture.closeAllConnections(); await new Promise(ready => fixture.close(ready));
  const resolved = resolve(dataRoot);
  assert.ok(resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes('heimdall-acceptance-baseline-'));
  rmSync(resolved, { recursive: true, force: true });
}
