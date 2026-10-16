#!/usr/bin/env node
/** Real API workers -> explicit comparison -> authenticated console/CLI, using only a local fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'acceptance-comparison-console'));
const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-comparison-console-'));
const token = 'acceptance-comparison-local-fixture';
const headers = { 'Content-Type': 'application/json', 'x-heimdall-token': token };
const delay = ms => new Promise(ready => setTimeout(ready, ms));
async function waitFor(fn, timeout = 20000) {
  let last;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Comparison smoke timeout: ${last?.message || 'state not reached'}`);
}
async function listen(server) {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = createServer();
  const url = await listen(server);
  await new Promise(ready => server.close(ready));
  return new URL(url).port;
}
const observedIds = [];
const fixtureRequests = [];
let revision = 0;
const fixture = createServer((req, res) => {
  fixtureRequests.push({ method: req.method, path: req.url, revision });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: req.url === '/quota' ? (revision ? 0 : 1) : (revision ? 1 : 0), amount: 10 }));
});
let engine, browser, engineLog = '';
const checks = {};
async function cli(args) {
  return new Promise((ready, reject) => {
    const child = spawn(process.execPath, ['src/acceptance/cli.mjs', ...args], { cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => ready({ code, stdout, stderr }));
  });
}
try {
  mkdirSync(OUT, { recursive: true });
  const targetUrl = await listen(fixture);
  const base = `http://127.0.0.1:${await freePort()}`;
  engine = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: resolve(CORE, '..', 'console', 'dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.stdout.on('data', value => { engineLog += value; });
  engine.stderr.on('data', value => { engineLog += value; });
  await waitFor(async () => (await fetch(base + '/')).ok);
  const api = (path, options = {}) => fetch(base + '/api/acceptance/' + path, { headers, ...options });
  const spec = { source: { id: 'comparison-api-fixture', revision: 'v1' }, approved: true,
    checks: ['/quota', '/stable'].map((path, index) => ({ id: index ? 'STABLE' : 'QUOTA', title: index ? '稳定接口保持通过' : '额度接口修复', path, method: 'GET',
      expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) };
  async function run(name, overrides = {}) {
    const response = await api('runs', { method: 'POST', body: JSON.stringify({ mode: 'spec', name, targetUrl, spec, ...overrides }) });
    assert.equal(response.status, 202);
    const manifest = await response.json();
    observedIds.push(manifest.runId);
    await waitFor(async () => (await (await api('runs/' + manifest.runId)).json()).status === 'completed');
    return { manifest, report: await (await api(`runs/${manifest.runId}/report`)).json() };
  }
  const before = await run('此前：额度错误');
  revision = 1;
  const after = await run('本次：额度修复且稳定接口回归');
  const relaxed = await run('判据变化：扩大响应预算', { maxResponseBytes: 524288 });
  const query = (a = before.manifest.runId, b = after.manifest.runId, format = 'json') => new URLSearchParams({ before: a, after: b, format });
  const comparisonPath = 'comparisons?' + query();
  const requestsBeforeComparison = fixtureRequests.length;
  const originals = observedIds.map(id => readFileSync(join(dataRoot, 'acceptance', id, 'manifest.json'), 'utf8'));
  assert.equal((await fetch(base + '/api/acceptance/' + comparisonPath)).status, 401);
  for (const [path, method, expected] of [
    [comparisonPath, 'POST', 405], ['comparisons', 'GET', 400],
    ['comparisons?' + query(before.manifest.runId, before.manifest.runId), 'GET', 400],
    ['comparisons?' + query(after.manifest.runId, before.manifest.runId), 'GET', 400],
    [comparisonPath + '&extra=value', 'GET', 400], [comparisonPath + '&before=' + before.manifest.runId, 'GET', 400],
    ['comparisons?' + query(before.manifest.runId, after.manifest.runId, 'html'), 'GET', 400],
    ['comparisons?' + query('../outside', after.manifest.runId), 'GET', 400],
    ['comparisons?' + query(before.manifest.runId, 'ac-00000000-0000-4000-8000-000000000000'), 'GET', 404],
  ]) assert.equal((await api(path, { method })).status, expected, `${method} ${path}`);
  checks.apiAuthAndInputGuards = true;
  const response = await api(comparisonPath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const comparison = await response.json();
  assert.equal(comparison.status, 'completed');
  assert.equal(comparison.summary.verifiedPassed, 1);
  assert.equal(comparison.summary.newFailure, 1);
  assert.equal(comparison.before.gate, 'failed');
  assert.equal(comparison.after.gate, 'failed');
  writeFileSync(join(OUT, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
  const md = await api('comparisons?' + query(before.manifest.runId, after.manifest.runId, 'md'));
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.match(md.headers.get('content-disposition'), /attachment/);
  writeFileSync(join(OUT, 'comparison.md'), await md.text());
  assert.match(readFileSync(join(OUT, 'comparison.md'), 'utf8'), /可靠复验通过/);
  checks.realFixAndNewFailure = true;
  const cliJson = await cli(['--compare', before.manifest.runId, after.manifest.runId]);
  assert.equal(cliJson.code, 0, 'a completed comparison does not replace the failed original acceptance gate');
  assert.deepEqual(JSON.parse(cliJson.stdout), comparison);
  const cliMd = await cli(['--compare', before.manifest.runId, after.manifest.runId, '--format', 'md', '--output', join(OUT, 'cli-comparison.md')]);
  assert.equal(cliMd.code, 0);
  assert.equal(readFileSync(join(OUT, 'cli-comparison.md'), 'utf8'), readFileSync(join(OUT, 'comparison.md'), 'utf8'));
  for (const args of [
    ['--compare', before.manifest.runId, before.manifest.runId],
    ['--compare', after.manifest.runId, before.manifest.runId],
    ['--compare', before.manifest.runId, after.manifest.runId, '--gate'],
  ]) assert.equal((await cli(args)).code, 1);
  const protectedFile = join(dataRoot, 'acceptance', after.manifest.runId, 'report.json');
  const originalReport = readFileSync(protectedFile, 'utf8');
  assert.equal((await cli(['--compare', before.manifest.runId, after.manifest.runId, '--output', protectedFile])).code, 1);
  const alias = join(dataRoot, 'store-alias');
  symlinkSync(join(dataRoot, 'acceptance'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await cli(['--compare', before.manifest.runId, after.manifest.runId, '--output', join(alias, after.manifest.runId, 'report.json')])).code, 1);
  assert.equal(readFileSync(protectedFile, 'utf8'), originalReport);
  checks.cliSameResultAndExplicitGate = true;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  const page = await context.newPage();
  const errors = [], submissions = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  page.on('request', req => { if (req.method() === 'POST') submissions.push(new URL(req.url()).pathname); });
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).origin, base);
  assert.match(await page.title(), /Heimdall/i);
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  const panel = page.getByTestId('acceptance-comparison');
  await panel.locator(':scope > summary').click();
  await waitFor(async () => await panel.locator('#ac-before option').count() === 4);
  assert.equal(await panel.locator('#ac-before').inputValue(), '');
  assert.equal(await panel.locator('#ac-after').inputValue(), '');
  assert.equal(await page.getByTestId('acceptance-compare').isDisabled(), true);
  await panel.locator('#ac-before').selectOption(before.manifest.runId);
  await panel.locator('#ac-after').selectOption(before.manifest.runId);
  assert.match(await panel.locator('#ac-pair-hint').innerText(), /不同/);
  assert.equal(await page.getByTestId('acceptance-compare').isDisabled(), true);
  await panel.locator('#ac-after').selectOption(after.manifest.runId);
  checks.explicitSelectionAndSameRunGuard = true;
  await page.route('**/api/acceptance/comparisons?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }), { times: 1 });
  await page.getByTestId('acceptance-compare').click();
  await panel.getByRole('alert').waitFor();
  assert.match(await panel.getByRole('alert').innerText(), /格式无效/);
  await panel.getByRole('button', { name: '重试对比', exact: true }).click();
  await page.getByTestId('acceptance-comparison-result').waitFor();
  assert.equal(await panel.locator('[data-comparison-relation="verified_passed"]').count(), 1);
  assert.equal(await panel.locator('[data-comparison-relation="new_failure"]').count(), 1);
  checks.errorRecovery = true;
  await panel.locator('[data-relation="verified_passed"]').click();
  assert.equal(await panel.locator('.ac-rows > li').count(), 1);
  await panel.getByRole('button', { name: '查看全部关系', exact: true }).click();
  await panel.locator('#ac-search').fill('稳定接口');
  assert.equal(await panel.locator('.ac-rows > li').count(), 1);
  assert.equal(await panel.locator('[data-comparison-relation="new_failure"]').count(), 1);
  await panel.locator('#ac-search').fill('');
  for (const [format, title] of [['json', '导出对比 JSON'], ['md', '导出对比 Markdown']]) {
    const event = page.waitForEvent('download');
    await panel.getByRole('button', { name: title, exact: true }).click();
    await (await event).saveAs(join(OUT, 'ui-comparison.' + format));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(OUT, 'ui-comparison.json'), 'utf8')), comparison);
  assert.equal(readFileSync(join(OUT, 'ui-comparison.md'), 'utf8'), readFileSync(join(OUT, 'comparison.md'), 'utf8'));
  checks.filterAndAuthenticatedDownloads = true;
  await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, 'comparison-desktop.png'), fullPage: false });
  let release, held = false;
  const gate = new Promise(ready => { release = ready; });
  await page.route('**/api/acceptance/comparisons?*', async route => {
    held = true;
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comparison) }).catch(() => {});
  }, { times: 1 });
  await page.getByTestId('acceptance-compare').click();
  await waitFor(() => held);
  await panel.locator('#ac-after').selectOption(relaxed.manifest.runId);
  release();
  assert.equal(await page.getByTestId('acceptance-comparison-result').count(), 0);
  await page.getByTestId('acceptance-compare').click();
  await page.getByTestId('acceptance-comparison-result').waitFor();
  await waitFor(async () => await panel.locator('[data-comparison-relation="incomparable"]').count() === 2);
  assert.equal(await panel.locator('[data-comparison-relation="verified_passed"]').count(), 0);
  assert.match(await panel.locator('.ac-reasons').first().innerText(), /definition-changed/);
  checks.staleRequestIgnoredAndRuleChangeIncomparable = true;
  let releaseExport, exportHeld = false;
  const exportGate = new Promise(ready => { releaseExport = ready; });
  await page.route('**/api/acceptance/comparisons?*', async route => {
    exportHeld = true;
    await exportGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comparison) }).catch(() => {});
  }, { times: 1 });
  await panel.getByRole('button', { name: '导出对比 JSON', exact: true }).click();
  await waitFor(() => exportHeld);
  await panel.locator('#ac-after').selectOption(after.manifest.runId);
  releaseExport();
  assert.equal(await page.getByTestId('acceptance-comparison-result').count(), 0);
  await page.getByTestId('acceptance-compare').click();
  await page.getByTestId('acceptance-comparison-result').waitFor();
  await waitFor(async () => await panel.locator('[data-comparison-relation="verified_passed"]').count() === 1);
  checks.staleExportCannotRestoreOldPair = true;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await page.getByTestId('acceptance-comparison').locator(':scope > summary').click();
  await waitFor(async () => await page.locator('#ac-after').inputValue() === after.manifest.runId);
  assert.equal(await page.locator('#ac-before').inputValue(), before.manifest.runId);
  assert.equal(await page.getByTestId('acceptance-comparison-result').count(), 0, 'reload must not present a cached reliable result');
  await page.getByTestId('acceptance-compare').click();
  await page.getByTestId('acceptance-comparison-result').waitFor();
  checks.refreshRestoresExplicitPair = true;
  const layouts = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 761) await page.getByTestId('acceptance-view-results').click();
    else await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
    const layout = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
      panel: document.querySelector('.ac-panel').scrollWidth, client: document.querySelector('.ac-panel').clientWidth }));
    assert.ok(layout.document <= layout.width + 1 && layout.panel <= layout.client + 1, `comparison overflow at ${viewport.width}x${viewport.height}`);
    layouts.push({ ...viewport, ...layout });
    await page.screenshot({ path: join(OUT, `comparison-${viewport.width}.png`), fullPage: false });
  }
  checks.mobileAndLandscapeNoOverflow = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.ac-counts').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'comparison-mobile-relations.png'), fullPage: false });
  const contrasts = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const readings = await page.evaluate(() => {
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const s = value / 255;
          return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
        });
        return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
      };
      return ['.ac-intro', '.ac-primary', '.ac-counts .ok strong', '.ac-counts .bad strong'].map(selector => {
        const element = document.querySelector(selector);
        let ancestor = element;
        while (ancestor && getComputedStyle(ancestor).backgroundColor === 'rgba(0, 0, 0, 0)') ancestor = ancestor.parentElement;
        const foreground = luminance(getComputedStyle(element).color), background = luminance(getComputedStyle(ancestor).backgroundColor);
        return { selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
      });
    });
    assert.ok(readings.every(item => item.ratio >= 4.5), `${theme} comparison text contrast`);
    contrasts.push({ theme, readings });
    if (theme === 'light') await page.screenshot({ path: join(OUT, 'comparison-mobile-light.png'), fullPage: false });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const largerText = await page.addStyleTag({ content: '.ac-panel p,.ac-panel small,.ac-panel label,.ac-panel button,.ac-panel select,.ac-panel code,.ac-row-head strong,.ac-row-head>span {font-size:24px!important;line-height:1.6!important;}' });
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'enlarged comparison text must wrap within phone width');
  await largerText.evaluate(element => element.remove());
  checks.darkLightContrastAndEnlargedText = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#ac-after').selectOption(after.manifest.runId);
  for (const runId of observedIds) cpSync(join(dataRoot, 'acceptance', runId), join(OUT, 'run-evidence', runId), { recursive: true });
  const responseFile = after.report.checks[0].evidence.response;
  const file = join(dataRoot, 'acceptance', after.manifest.runId, responseFile);
  writeFileSync(file, readFileSync(file, 'utf8') + ' ');
  await page.getByTestId('acceptance-compare').click();
  await waitFor(async () => (await page.getByTestId('acceptance-comparison-result').innerText()).includes('对比受阻'));
  assert.equal(await page.locator('[data-comparison-relation="verified_passed"]').count(), 0);
  const blocked = await (await api(comparisonPath)).json();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.summary.verifiedPassed, 0);
  assert.ok(blocked.integrity.after.errors.some(item => item.code === 'EVIDENCE_DIGEST_MISMATCH'));
  assert.match(await page.locator('.ac-integrity').innerText(), /EVIDENCE_DIGEST_MISMATCH/);
  writeFileSync(join(OUT, 'tampered-comparison.json'), JSON.stringify(blocked, null, 2) + '\n');
  const blockedCli = await cli(['--compare', before.manifest.runId, after.manifest.runId]);
  assert.equal(blockedCli.code, 1);
  assert.equal(JSON.parse(blockedCli.stdout).status, 'blocked');
  await page.locator('.aw-results').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, 'comparison-integrity-blocked.png'), fullPage: false });
  await page.locator('.ac-integrity').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'comparison-integrity-diagnostic.png'), fullPage: false });
  checks.changedEvidenceCannotVerifyFix = true;
  await page.getByTestId('acceptance-comparison').getByRole('button', { name: '查看本次原报告', exact: true }).click();
  await waitFor(async () => (await page.locator('.aw-report-head').innerText()).includes(after.report.name));
  assert.match(await page.getByTestId('acceptance-gate').innerText(), /发现缺陷/);
  checks.openOriginalReport = true;
  assert.deepEqual(observedIds.map(id => readFileSync(join(dataRoot, 'acceptance', id, 'manifest.json'), 'utf8')), originals);
  assert.equal(fixtureRequests.length, requestsBeforeComparison);
  assert.deepEqual(submissions, []);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  checks.originalGatesAndNoNewTargetRequests = true;
  checks.pageIdentityNonblankOverlayAndConsoleHealthy = true;
  const result = { status: 'passed', evidenceLevel: 'offline-reproduced', browser: 'Browser plugin not available; existing Playwright Chromium',
    scope: '本地夹具真实 Spec worker→持久证据→比较API/CLI→控制台。无生产 API、外部模型或项目级基线批准。',
    runIds: observedIds, checks, checkCount: Object.keys(checks).length, layouts, contrasts, pageErrors: errors,
    fixtureRequests: fixtureRequests.length, originalGates: [before.report.gate, after.report.gate] };
  writeFileSync(join(OUT, 'browser-checks.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'engine-error.log'), engineLog);
  throw error;
} finally {
  await browser?.close();
  if (engine && engine.exitCode === null) {
    engine.kill('SIGTERM');
    await Promise.race([new Promise(ready => engine.once('exit', ready)), delay(5000)]);
  }
  fixture.closeAllConnections();
  await new Promise(ready => fixture.close(ready));
  assert.ok(resolve(dataRoot).startsWith(resolve(tmpdir()) + sep) && dataRoot.includes('heimdall-acceptance-comparison-console-'));
  rmSync(dataRoot, { recursive: true, force: true });
}
