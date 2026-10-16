#!/usr/bin/env node
/** Isolated real UI -> approved manual/OpenAPI plan -> API evidence -> persisted report. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startAcceptanceApiFixture, ACCEPTANCE_API_RESPONSE_SCHEMA } from '../test/fixtures/acceptance-api.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'acceptance-spec-console'));
const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-spec-console-'));
const token = 'acceptance-spec-smoke-local-fixture';
const headers = { 'Content-Type': 'application/json', 'x-heimdall-token': token };
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sleep = ms => new Promise(ready => setTimeout(ready, ms));
async function waitFor(fn, timeout = 15000) {
  let last;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await sleep(150);
  }
  throw new Error(`Spec console smoke timed out: ${last?.message ?? 'state not reached'}`);
}
async function unusedPort() {
  const server = createServer();
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const port = server.address().port;
  await new Promise(ready => server.close(ready));
  return port;
}
const manualChecks = ['/healthy', '/missing-field'].map((path, index) => ({
  id: `MANUAL-${index + 1}`, title: index ? '响应包含需求规定的名称' : '健康接口契约', method: 'GET', path, severity: 'high',
  expect: { status: 200, contentType: 'application/json', schema: ACCEPTANCE_API_RESPONSE_SCHEMA, json: [
    { pointer: '/code', kind: 'equals', value: 0 }, { pointer: '/data/name', kind: 'required' },
    { pointer: '/data/id', kind: 'type', type: 'integer' }, { pointer: '/data/active', kind: 'enum', values: [true] },
  ] },
}));
const openApiDocument = {
  openapi: '3.1.0', info: { title: 'Spec acceptance fixture', version: '2026-10-16' },
  paths: Object.fromEntries([
    ...['/healthy', '/wrong-code'].map((path, index) => [path, { get: { operationId: `readQuota${index + 1}`, summary: `${path} 契约`,
      responses: { 200: { description: '成功响应', content: { 'application/json': { schema: ACCEPTANCE_API_RESPONSE_SCHEMA } } } } } }]),
    ['/write', { post: { operationId: 'writeQuota', responses: { 200: { description: '写请求不执行' } } } }],
  ]),
};
let engine, fixture, browser;
let engineLog = '';
const observedIds = [];
try {
  mkdirSync(OUT, { recursive: true });
  fixture = await startAcceptanceApiFixture();
  const base = `http://127.0.0.1:${await unusedPort()}`;
  engine = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: resolve(CORE, '..', 'console', 'dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.stdout.on('data', data => { engineLog += data; });
  engine.stderr.on('data', data => { engineLog += data; });
  await waitFor(async () => (await fetch(base + '/')).ok);
  const api = (path = '') => fetch(base + '/api/acceptance/runs' + path, { headers });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  const page = await context.newPage();
  const errors = [], submitted = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/acceptance/runs') submitted.push(request.postDataJSON());
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await page.locator('[name="acceptance-mode"][value="spec"]').check();
  assert.equal(await page.locator('[name="acceptance-baseline"]').count(), 0);
  assert.equal(await page.locator('[name="acceptance-routes"]').count(), 0);
  assert.equal(await page.locator('[name="acceptance-points"]').count(), 0);
  assert.equal(await page.locator('[name="acceptance-masks"]').count(), 0);
  await page.locator('[name="acceptance-name"]').fill('手工需求契约验收');
  await page.locator('[name="acceptance-target"]').fill(fixture.targetUrl);
  await page.locator('[name="acceptance-spec-source"]').fill('manual-api-requirements');
  await page.locator('[name="acceptance-spec-revision"]').fill('v1');
  await page.locator('[name="acceptance-spec-checks"]').fill(JSON.stringify(manualChecks));
  assert.equal(await page.locator('[name="acceptance-spec-approved"]').isChecked(), false);
  assert.equal(await page.locator('[data-testid="acceptance-run"]').isDisabled(), true);
  assert.equal(fixture.requests.length, 0, 'editing a draft must never request target APIs');
  await page.locator('[name="acceptance-spec-approved"]').check();
  await page.locator('[name="acceptance-spec-revision"]').fill('v2');
  assert.equal(await page.locator('[name="acceptance-spec-approved"]').isChecked(), false, 'source changes revoke approval');
  await page.locator('[name="acceptance-spec-approved"]').check();
  await page.locator('[name="acceptance-spec-checks"]').fill(JSON.stringify(manualChecks, null, 2));
  assert.equal(await page.locator('[name="acceptance-spec-approved"]').isChecked(), false, 'contract edits revoke approval');
  await page.locator('[name="acceptance-spec-approved"]').check();
  await page.locator('[data-testid="acceptance-run"]').click();
  const manual = await waitFor(async () => (await (await api()).json()).runs.find(run => run.name === '手工需求契约验收'));
  observedIds.push(manual.runId);
  await waitFor(async () => (await (await api('/' + manual.runId)).json()).status === 'completed', 30000);
  await page.locator('[data-testid="acceptance-gate"]').waitFor();
  const manualReport = await (await api('/' + manual.runId + '/report')).json();
  assert.equal(manualReport.mode, 'spec');
  assert.equal(manualReport.gate, 'failed');
  assert.equal(manualReport.specSource.id, 'manual-api-requirements');
  assert.equal(manualReport.summary.dimensions.visual.total, 0);
  assert.ok(manualReport.checks.some(check => check.dimension === 'behavior' && check.verdict === 'bug'));
  assert.ok(!Object.hasOwn(submitted[0], 'baselineUrl') && !Object.hasOwn(submitted[0], 'routes'));
  assert.equal(submitted[0].spec.approved, true);
  assert.equal((await page.locator('.aw-scope dt').allTextContents()).includes('基线'), false);
  assert.match(await page.locator('.aw-dimensions').innerText(), /接口契约/);
  const bug = manualReport.checks.find(check => check.verdict === 'bug');
  const detail = page.locator(`details[data-check-id="${bug.id}"]`);
  await detail.locator('summary').click();
  await waitFor(async () => await detail.locator('.aw-json-evidence').count() === 3);
  assert.equal(await detail.locator('img').count(), 0);
  assert.match(await detail.innerText(), /请求证据/);
  assert.match(await detail.innerText(), /响应证据/);
  assert.match(await detail.innerText(), /契约依据/);
  await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  const markdownEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  await (await markdownEvent).saveAs(join(OUT, 'manual-report.md'));
  assert.match(readFileSync(join(OUT, 'manual-report.md'), 'utf8'), /manual-api-requirements/);
  writeFileSync(join(OUT, 'manual-report.json'), JSON.stringify(manualReport, null, 2));
  const requestsBeforePreview = fixture.requests.length;
  await page.locator('[name="acceptance-name"]').fill('OpenAPI 候选契约验收');
  await page.locator('.aw-openapi > summary').click();
  await page.locator('[name="acceptance-openapi"]').fill(JSON.stringify(openApiDocument));
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/acceptance/openapi/preview');
  await page.locator('[data-testid="acceptance-openapi-preview"]').click();
  const response = await previewResponse;
  assert.equal(response.status(), 200);
  const preview = await response.json();
  await page.locator('[data-testid="acceptance-spec-coverage"]').waitFor();
  assert.equal(preview.coverage.declaredOperations, 3);
  assert.equal(preview.coverage.candidateChecks, 2);
  assert.equal(preview.coverage.omittedOperations, 1);
  assert.equal(fixture.requests.length, requestsBeforePreview, 'OpenAPI preview must not call target APIs');
  assert.equal(await page.locator('[name="acceptance-spec-approved"]').isChecked(), false, 'OpenAPI import must require fresh approval');
  assert.equal(await page.locator('[data-testid="acceptance-run"]').isDisabled(), true);
  assert.equal(await page.locator('[name="acceptance-spec-source"]').inputValue(), preview.plan.spec.source.id);
  assert.match(preview.plan.spec.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.plan.spec.document, openApiDocument);
  await page.locator('[name="acceptance-spec-approved"]').check();
  const targetBeforeEdit = await page.locator('[name="acceptance-target"]').inputValue();
  await page.locator('[name="acceptance-target"]').fill(targetBeforeEdit.endsWith('/') ? targetBeforeEdit.slice(0, -1) : targetBeforeEdit + '/');
  assert.equal(await page.locator('[name="acceptance-spec-approved"]').isChecked(), false, 'target changes revoke approval');
  await page.locator('[name="acceptance-spec-approved"]').check();
  await page.locator('[data-testid="acceptance-run"]').click();
  const imported = await waitFor(async () => (await (await api()).json()).runs.find(run => run.name === 'OpenAPI 候选契约验收'));
  observedIds.push(imported.runId);
  await waitFor(async () => (await (await api('/' + imported.runId)).json()).status === 'completed', 30000);
  await waitFor(async () => (await page.locator('.aw-report-head h2').innerText()) === 'OpenAPI 候选契约验收');
  await page.locator('[data-testid="acceptance-gate"]').waitFor();
  const importedReport = await (await api('/' + imported.runId + '/report')).json();
  assert.equal(importedReport.gate, 'failed');
  assert.equal(importedReport.specSource.type, 'openapi');
  assert.equal(importedReport.specSource.sha256, preview.plan.spec.source.sha256);
  assert.deepEqual(submitted[1].spec.document, openApiDocument);
  const sourceCheck = importedReport.checks.find(check => check.verdict === 'bug');
  assert.equal(sourceCheck.evidence.source, 'requirement-source.json');
  const sourceEvidencePath = '/' + imported.runId + '/evidence/' + sourceCheck.evidence.source;
  const sourceResponse = await api(sourceEvidencePath);
  assert.equal(sourceResponse.status, 200);
  const sourceSnapshot = await sourceResponse.json();
  assert.deepEqual(sourceSnapshot.document, openApiDocument);
  assert.deepEqual(sourceSnapshot.source, importedReport.specSource);
  assert.equal(createHash('sha256').update(canonicalJson(sourceSnapshot.document)).digest('hex'), importedReport.specSource.sha256);
  assert.equal((await fetch(base + '/api/acceptance/runs' + sourceEvidencePath)).status, 401);
  const sourceDetail = page.locator(`details[data-check-id="${sourceCheck.id}"]`);
  await sourceDetail.locator('summary').click();
  await waitFor(async () => await sourceDetail.locator('.aw-json-evidence').count() === 4);
  assert.match(await sourceDetail.innerText(), /需求源文档/);
  assert.equal(await sourceDetail.locator('img').count(), 0);
  assert.ok(importedReport.checks.some(check => check.dimension === 'health' && check.status === 'blocked'));
  assert.ok(fixture.requests.every(request => ['GET', 'HEAD'].includes(request.method)));
  assert.equal(fixture.requestCounts['/write'] ?? 0, 0);
  await waitFor(async () => (await page.locator(`button[data-run-id="${imported.runId}"]`).innerText()).includes('已完成'));
  await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, 'acceptance-spec-desktop.png'), fullPage: false });
  writeFileSync(join(OUT, 'openapi-preview.json'), JSON.stringify(preview, null, 2));
  writeFileSync(join(OUT, 'openapi-report.json'), JSON.stringify(importedReport, null, 2));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await page.locator(`button[data-run-id="${imported.runId}"]`).click();
  await page.locator('[data-testid="acceptance-gate"]').waitFor();
  assert.match(await page.locator('.aw-report-head').innerText(), /需求契约验收/);
  assert.deepEqual(JSON.parse(await page.locator('[name="acceptance-openapi"]').inputValue()), openApiDocument);
  assert.equal(await page.locator('[name="acceptance-spec-source"]').inputValue(), importedReport.specSource.id);
  assert.equal(await page.locator('[name="acceptance-spec-approved"]').isChecked(), false, 'restored source requires fresh approval');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-testid="acceptance-view-results"]').click();
  await page.waitForFunction(() => document.querySelector('#aw-result-panel').getBoundingClientRect().top < 200);
  assert.ok(await page.locator('.aw-header').evaluate(element => element.getBoundingClientRect().top >= 0), 'result jump must preserve the header');
  await page.screenshot({ path: join(OUT, 'acceptance-spec-mobile.png'), fullPage: false });
  const layout = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
    results: document.querySelector('#aw-result-panel').scrollWidth }));
  assert.ok(layout.document <= layout.width + 1, 'spec report must fit a 390px viewport');
  assert.ok(await page.locator('#aw-result-panel').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'spec report contents must fit the result panel');
  await page.locator('[name="acceptance-mode"][value="spec"]').check();
  await page.locator('.aw-layout').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  assert.ok(await page.locator('.aw-layout').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'spec form must fit the mobile layout');
  await page.screenshot({ path: join(OUT, 'acceptance-spec-mobile-form.png'), fullPage: false });
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  const result = { status: 'passed', evidenceLevel: 'offline-reproduced',
    scope: '本地API夹具，真实控制台→明确批准→Spec worker→JSON证据/报告→刷新恢复。未调用生产API或模型。',
    runIds: observedIds, gates: [manualReport.gate, importedReport.gate], checks: { manualUiCreate: true, explicitApproval: true,
      editsRevokeApproval: true, openApiPreviewWithoutRequests: true, importRequiresApproval: true, omissionsStayBlocked: true,
      sourceFingerprint: true, sourceDocumentEvidence: true, sourceDocumentHashVerified: true, sourceDraftRestored: true,
      apiContractFailure: true, authenticatedJsonEvidence: true, markdownDownload: true,
      refreshRestore: true, mobileNoOverflow: true, noWriteRequests: true, consoleHealthy: true }, pageErrors: errors, layout };
  writeFileSync(join(OUT, 'browser-checks.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'engine-error.log'), engineLog);
  throw error;
} finally {
  for (const runId of observedIds) {
    const source = join(dataRoot, 'acceptance', runId);
    if (existsSync(source)) cpSync(source, join(OUT, 'run-evidence', runId), { recursive: true });
  }
  await browser?.close();
  if (engine && engine.exitCode === null) {
    engine.kill('SIGTERM');
    await Promise.race([new Promise(ready => engine.once('exit', ready)), sleep(5000)]);
  }
  await fixture?.close();
  assert.ok(resolve(dataRoot).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))
    && dataRoot.includes('heimdall-acceptance-spec-console-'), 'cleanup must stay inside the generated temporary root');
  rmSync(dataRoot, { recursive: true, force: true });
}
