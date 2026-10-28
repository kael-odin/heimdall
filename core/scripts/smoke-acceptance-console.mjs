#!/usr/bin/env node
/** Real UI -> worker -> report/evidence/download -> reload, in an isolated data root. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startAcceptanceFixture } from '../test/fixtures/acceptance-site.mjs';
import { createAcceptanceRun } from '../src/acceptance/store.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'acceptance-console'));
const token = 'acceptance-smoke-local-fixture';
const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-console-'));
const headers = { 'Content-Type': 'application/json', 'x-heimdall-token': token };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error('Acceptance smoke wait expired: ' + (last?.message ?? 'state not reached'));
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
let engine, browser, fixture, modelServer;
let observedRunId;
let browserPage;
const recentResponses = [], consoleErrors = [], pageErrors = [], diagnosticReads = new Set();
const remember = (list, value, limit = 100) => { list.push(value); if (list.length > limit) list.shift(); };
const diagnosticUrl = value => {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return 'unavailable'; }
};
const modelCalls = [];
let engineLog = '';
try {
  mkdirSync(OUT, { recursive: true });
  fixture = await startAcceptanceFixture();
  modelServer = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    modelCalls.push(request);
    const evidence = JSON.parse(request.messages.find(m => m.role === 'user').content).untrustedEvidence;
    const response = { summary: '已依据菜单状态证据生成复验建议。', gate: 'passed', items: [
      ...evidence.checks.map(c => ({ checkId: c.checkId, explanation: '目标菜单展开后 aria-expanded 仍是 false，与基线和显式断言不一致。', suggestedFix: '在菜单切换状态时同步 aria-expanded。', verification: ['在三个视口点击菜单，再检查 aria-expanded=true。'] })),
      { checkId: 'invented-ai-bug', explanation: 'This must be discarded.' },
    ] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const stale = createAcceptanceRun({ name: '重启恢复夹具', baselineUrl: fixture.baselineUrl, targetUrl: fixture.targetUrl }, { root: join(dataRoot, 'acceptance') });
  const base = 'http://127.0.0.1:' + await port();
  engine = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: resolve(CORE, '..', 'console', 'dist'), HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token,
      HEIMDALL_LLM: '1', LLM_PROTOCOL: 'chat', LLM_BASE_URL: 'http://127.0.0.1:' + modelServer.address().port + '/v1', LLM_API_KEY: 'fixture-only', LLM_MODEL: 'fixture-model' }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.stdout.on('data', d => { engineLog += d; });
  engine.stderr.on('data', d => { engineLog += d; });
  await waitFor(async () => (await fetch(base + '/')).ok);
  const api = (path = '', options = {}) => fetch(base + '/api/acceptance/runs' + path, { ...options, headers });
  assert.equal((await fetch(base + '/api/acceptance/runs')).status, 401);
  assert.equal((await api('', { method: 'POST', body: JSON.stringify({ baselineUrl: 'file:///bad', targetUrl: fixture.targetUrl }) })).status, 400);
  assert.equal((await (await api('/' + stale.runId)).json()).status, 'interrupted');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
  await context.addInitScript(({ token }) => localStorage.setItem('heimdall-token', token), { token });
  const page = await context.newPage();
  browserPage = page;
  page.on('response', response => {
    const entry = { url: diagnosticUrl(response.url()), method: response.request().method(), status: response.status() };
    remember(recentResponses, entry);
    if (entry.status < 400 || diagnosticReads.size >= 100 || !response.headers()['content-type']?.includes('application/json')) return;
    const pending = response.json().then(body => {
      if (typeof body?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(body.code)) entry.code = body.code;
    }, () => {}).finally(() => diagnosticReads.delete(pending));
    diagnosticReads.add(pending);
  });
  const errors = pageErrors;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    errors.push(message.text());
    const location = message.location();
    remember(consoleErrors, { message: message.text(), location: { ...location, url: diagnosticUrl(location.url) } }, 50);
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Heimdall/i);
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await page.locator('[data-testid="acceptance-workbench"]').waitFor();
  await page.locator('[name="acceptance-name"]').fill('比赛演示 · 菜单与配额验收');
  await page.locator('[name="acceptance-baseline"]').fill(fixture.baselineUrl);
  await page.locator('[name="acceptance-target"]').fill(fixture.targetUrl);
  await page.locator('[name="acceptance-routes"]').fill('/menu-state\n/missing-field');
  await page.locator('.aw-advanced > summary').click();
  // Baseline exploration fills the points field from the approved baseline before the operator edits it.
  const pointsField = page.locator('[name="acceptance-points"]');
  await page.locator('[data-testid="acceptance-explore"]').click();
  await waitFor(async () => (await pointsField.inputValue()).includes('#menu-toggle'), 60000);
  const exploredPoints = JSON.parse(await pointsField.inputValue());
  assert.ok(exploredPoints.length >= 1, 'exploration should propose at least one point');
  assert.ok(exploredPoints.some(point => point.steps?.[0]?.action === 'click' && point.steps[0].selector === '#menu-toggle'), 'menu toggle point');
  assert.ok(exploredPoints.every(point => Array.isArray(point.assertions) && point.assertions.length > 0), 'every explored point has an assertion');
  await page.getByText(/基线生成 \d+ 个候选验收点/).first().waitFor();
  await pointsField.fill(JSON.stringify([{ id: 'MENU-OPEN', title: '菜单点击后展开', route: '/menu-state', severity: 'high', steps: [{ action: 'click', selector: '#menu-toggle' }], assertions: [{ kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' }] }]));
  await page.locator('[data-testid="acceptance-run"]').click();
  const run = await waitFor(async () => (await (await api()).json()).runs.find(x => x.name === '比赛演示 · 菜单与配额验收'));
  observedRunId = run.runId;
  assert.equal((await api('', { method: 'POST', body: JSON.stringify({ baselineUrl: fixture.baselineUrl, targetUrl: fixture.targetUrl }) })).status, 409);
  await waitFor(async () => (await (await api('/' + run.runId)).json()).status === 'completed', 120000);
  await page.locator('[data-testid="acceptance-gate"]').waitFor();
  await waitFor(async () => (await page.locator('[data-testid="acceptance-gate"]').innerText()).includes('发现缺陷'));
  const report = await (await api('/' + run.runId + '/report')).json();
  writeFileSync(join(OUT, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.gate, 'failed');
  assert.equal(report.summary.coverage.measured, report.summary.coverage.total);
  assert.ok(report.checks.some(c => c.dimension === 'behavior' && c.verdict === 'bug'));
  assert.equal(modelCalls.length, 0, 'acceptance must not automatically send evidence to a model');
  await page.locator('[data-testid="acceptance-triage"]').click();
  await waitFor(async () => (await (await api('/' + run.runId)).json()).triageAvailable);
  const triage = await (await api('/' + run.runId + '/triage')).json();
  assert.equal(triage.status, 'completed');
  assert.equal(modelCalls.length, 1);
  assert.ok(triage.items.length > 0);
  assert.ok(triage.items.every(item => item.checkId !== 'invented-ai-bug'));
  assert.equal(triage.gate, undefined);
  assert.equal((await (await api('/' + run.runId + '/report')).json()).gate, 'failed');
  await page.getByText('已依据菜单状态证据生成复验建议。', { exact: true }).waitFor();
  // Element localization is explicit too, and only adds a sidecar: the report and gate stay as the run left them.
  assert.equal((await api('/' + run.runId + '/localization')).status, 404);
  await page.locator('[data-testid="acceptance-localization"]').click();
  await waitFor(async () => (await (await api('/' + run.runId)).json()).localizationAvailable, 60000);
  const localization = await (await api('/' + run.runId + '/localization')).json();
  assert.equal(localization.status, 'completed');
  assert.equal(localization.checks.length, report.checks.filter(c => c.verdict === 'bug' && c.status === 'failed').length);
  const menuLocalized = localization.checks.find(c => c.checkId.endsWith('-MENU-OPEN'));
  assert.equal(menuLocalized?.replay?.reproduced, true);
  assert.ok(menuLocalized.findings.some(f => f.kind === 'handler' && f.source?.kind === 'inline-script' && f.source.line > 0), 'menu bug should point at its click handler');
  assert.ok(localization.checks.every(c => c.status === 'completed' && c.level === 'source'), 'every reliable failure should reach a source position');
  assert.match(menuLocalized.findings.find(f => f.kind === 'handler').delta?.baseline ?? '', /aria-expanded/, 'handler delta should name the missing state update');
  assert.equal((await (await api('/' + run.runId + '/report')).json()).gate, 'failed');
  await page.locator('.aw-localization-summary').waitFor();
  assert.equal(await page.locator('.aw-localization-summary').innerText(), localization.summary);
  await page.locator('.aw-localization').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'acceptance-localization.png'), fullPage: false });
  const bug = report.checks.find(c => c.dimension === 'behavior' && c.verdict === 'bug');
  const detail = page.locator(`details[data-check-id="${bug.id}"]`);
  await detail.locator('summary').click();
  await waitFor(async () => detail.locator('img').evaluateAll(images => images.length >= 2 && images.every(image => image.complete && image.naturalWidth > 0)));
  const evidenceName = bug.evidence.baselineDetails;
  assert.equal((await api('/' + run.runId + '/evidence/' + evidenceName)).status, 200);
  assert.equal((await api('/' + run.runId + '/evidence/manifest.json')).status, 404);
  assert.notEqual((await api('/' + run.runId + '/evidence/' + encodeURIComponent('../manifest.json'))).status, 200);
  await waitFor(async () => (await page.locator(`button[data-run-id="${run.runId}"]`).innerText()).includes('已完成'));
  await page.screenshot({ path: join(OUT, 'acceptance-evidence.png'), fullPage: false });
  await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, 'acceptance-desktop.png'), fullPage: false });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(join(OUT, 'acceptance-downloaded.md'));
  assert.match(readFileSync(join(OUT, 'acceptance-downloaded.md'), 'utf8'), /MENU-OPEN/);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await page.locator(`button[data-run-id="${run.runId}"]`).click();
  await page.locator('[data-testid="acceptance-gate"]').waitFor();
  assert.match(await page.locator('[data-testid="acceptance-gate"]').innerText(), /发现缺陷/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-testid="acceptance-view-results"]').click();
  await page.waitForFunction(() => document.querySelector('#aw-result-panel').getBoundingClientRect().top < 200);
  await page.getByText('已依据菜单状态证据生成复验建议。', { exact: true }).waitFor();
  await page.locator('.aw-localization-summary').waitFor();
  await page.screenshot({ path: join(OUT, 'acceptance-mobile.png'), fullPage: false });
  const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: innerWidth }));
  assert.ok(layout.scroll <= layout.client + 1, 'mobile console must not overflow');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  writeFileSync(join(OUT, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'ai-triage-mock.json'), JSON.stringify(triage, null, 2));
  writeFileSync(join(OUT, 'acceptance-localization.json'), JSON.stringify(localization, null, 2));
  const result = { status: 'passed', evidenceLevel: 'offline-reproduced', scope: '本地受控夹具，真实控制台→基线探索候选验收点→浏览器验收任务→证据与下载→刷新恢复；AI链路使用本地模型模拟器，不等于外部模型或真实业务站点验收。', runId: run.runId, gate: report.gate, summary: report.summary, checks: { auth: true, invalidInput: true, concurrencyLimit: true, restartRecovery: true, uiCreate: true, workerCompletion: true, behaviorFailureGate: true, authenticatedEvidence: true, pathBoundary: true, markdownDownload: true, refreshRestore: true, mobileNoOverflow: true, consoleHealthy: true, aiExplicitOnly: true, aiUnknownCheckDiscarded: true, aiCannotOverrideGate: true, aiRefreshRestore: true, localizationExplicitOnly: true, localizationSourceLevel: true, localizationKeepsGate: true, localizationRefreshRestore: true, explorationFromBaseline: true, explorationPointsStable: true }, pageErrors: errors, viewports: ['1440x1000', '390x844'] };
  writeFileSync(join(OUT, 'browser-checks.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await Promise.race([Promise.allSettled([...diagnosticReads]), sleep(250)]);
  writeFileSync(join(OUT, 'acceptance-failure.json'), JSON.stringify({ error: String(error.message), pageErrors,
    consoleErrors, recentResponses }, null, 2) + '\n');
  await browserPage?.screenshot({ path: join(OUT, 'acceptance-failure.png'), fullPage: false, timeout: 5000 }).catch(() => {});
  writeFileSync(join(OUT, 'engine-error.log'), engineLog);
  throw error;
} finally {
  if (observedRunId && existsSync(join(dataRoot, 'acceptance', observedRunId))) {
    cpSync(join(dataRoot, 'acceptance', observedRunId), join(OUT, 'run-evidence'), { recursive: true });
  }
  await browser?.close();
  if (engine && engine.exitCode === null) {
    engine.kill('SIGTERM');
    await Promise.race([new Promise(resolve => engine.once('exit', resolve)), sleep(5000)]);
  }
  await fixture?.close();
  if (modelServer) await new Promise(resolve => { modelServer.close(resolve); modelServer.closeAllConnections(); });
  rmSync(dataRoot, { recursive: true, force: true });
}
