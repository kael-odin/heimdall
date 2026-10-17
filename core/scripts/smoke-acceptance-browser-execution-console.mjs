#!/usr/bin/env node
/** Fresh captured Browser side -> saved candidate -> one approved target run ->
 * explicit durable check issue/retest. Real Chromium, local controlled pages.
 * Browser plugin not available; use the repository's maintained CDP workflow. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createBrowserOperationStore } from '../src/acceptance/browser-operation-store.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace/_runs/browser-execution-console-smoke-' + randomUUID()));
assert.equal(process.argv.length <= 3, true); assert.equal(fs.existsSync(OUT), false, 'Use a fresh evidence directory.');
fs.mkdirSync(OUT, { recursive: true });
const DATA = join(OUT, 'runtime'), ROOT = join(DATA, 'acceptance'); fs.mkdirSync(DATA);
const token = 'browser-single-operation-controlled-fixture';
const headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const checks = {}, targetRequests = [], browserRequests = [], pageErrors = [], consoleMessages = [], layouts = [], captures = [];
const startedAt = new Date().toISOString(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => fs.writeFileSync(join(OUT, name), Buffer.isBuffer(value) || typeof value === 'string'
  ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const parse = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let engine, browser, chromiumProcess, page, target, base, targetBase, project, candidate, source, sourceAvailable = true;
let engineLog = '', chromiumLog = '', failure;
let lostReplies = 0;
let releaseHeldCancelReply;
const held = new Set();
async function waitFor(fn, label, budget = 25000) {
  const deadline = Date.now() + budget; let last;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (cause) { last = cause; } await delay(100); }
  throw new Error(label + ': ' + (last?.message ?? 'state not reached'), { cause: last });
}
async function listen(server) {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function api(path, body, status = 200, options = {}) {
  const response = await fetch(base + '/api/acceptance/' + path, { headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), ...options, signal: AbortSignal.timeout(30000) });
  const value = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(value)); return value;
}
const latest = () => api('projects'), detail = () => api('projects/' + project.id);
const executionPath = () => 'projects/' + project.id + '/browser-executions';
const operation = id => api(executionPath() + '/' + id);
const report = id => api(executionPath() + '/' + id + '/report');
const ledger = () => api('projects/' + project.id + '/browser-bugs');
const completed = id => waitFor(async () => { const value = await operation(id); assert.ok(!['failed', 'interrupted'].includes(value.state), JSON.stringify(value)); return value.state === 'completed' && value; }, 'Browser operation completed', 90000);
function tree(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [file, value] of Object.entries(tree(path))) result[entry.name + '/' + file] = value;
    else { assert.equal(entry.isFile(), true); const bytes = fs.readFileSync(path); result[entry.name] = { bytes: bytes.length, sha256: hash(bytes) }; }
  }
  return result;
}
function heads() { return Object.fromEntries(['catalog.json', 'catalog.previous.json'].map(file => [file, fs.readFileSync(join(ROOT, file)).toString('base64')])); }
function html(bug = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Fixed Browser acceptance fixture</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial,sans-serif;background:#eef2f6;color:#172438}header{padding:16px 24px;background:#172438;color:white;display:flex;align-items:center;justify-content:space-between}main{max-width:900px;padding:24px;margin:auto}h1{font-size:30px}button,input{font:inherit;padding:8px}.panel{height:250px;padding:24px;border:1px solid #bbc9d7;background:${bug ? '#8d2b10' : '#ffffff'};color:${bug ? '#ffffff' : '#172438'};transform:translateY(${bug ? '60px' : '0'})}nav[hidden]{display:none}nav{padding:12px;background:#d6e8ff}@media(max-width:500px){main{padding:16px}h1{font-size:24px}input{max-width:100%}}</style></head><body><header><strong>NORTHSTAR</strong><button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button></header><main><h1>Controlled target acceptance</h1><nav id="menu" hidden>Expanded navigation</nav><section class="panel"><h2>Approved captured source</h2><label>Test entry <input id="entry"></label><p id="literal">fixed-contract-source-sentinel</p></section></main><script>document.querySelector('#menu-toggle').addEventListener('click',function(){${bug ? 'return;' : "const menu=document.querySelector('#menu');menu.hidden=!menu.hidden;this.setAttribute('aria-expanded',String(!menu.hidden))"}})</script></body></html>`;
}
async function startEngine() {
  const socket = createServer(), address = await listen(socket); await close(socket); base = address;
  const child = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE, windowsHide: true,
    env: { ...process.env, HEIMDALL_DATA_DIR: DATA, HEIMDALL_CONSOLE_DIR: resolve(CORE, '../console/dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine = child;
  child.stdout.on('data', value => { engineLog += value; }); child.stderr.on('data', value => { engineLog += value; });
  await waitFor(async () => { if (child.exitCode !== null) throw Error(engineLog); return (await fetch(base + '/api/status', { headers })).ok; }, 'engine ready');
}
const component = () => page.getByTestId('browser-execution'), panel = () => page.getByTestId('acceptance-catalog');
const uiPosts = () => browserRequests.filter(value => value.method === 'POST' && value.path === '/api/acceptance/' + executionPath());
async function openConsole() {
  await page.goto(base, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await panel().getByTestId('catalog-toggle').click(); await panel().locator('[name="catalog-project"]').selectOption(project.id);
  await component().waitFor(); await waitFor(async () => !(await panel().getByTestId('catalog-refresh').isDisabled()), 'catalog ready');
}
async function startBrowser() {
  const profile = join(OUT, 'chromium-profile'); fs.mkdirSync(profile);
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  chromiumProcess.stdout.on('data', value => { chromiumLog += value; }); chromiumProcess.stderr.on('data', value => { chromiumLog += value; });
  const active = join(profile, 'DevToolsActivePort'); await waitFor(() => fs.existsSync(active) && fs.readFileSync(active, 'utf8').split('\n')[0], 'CDP ready');
  const cdp = 'http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0];
  save('cdp-version.json', await (await fetch(cdp + '/json/version')).json()); browser = await chromium.connectOverCDP(cdp);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('heimdall-token', value); }, token);
  await context.addInitScript(() => {
    const facts = window.__browserExecutionBlobs = { created: [], revoked: [] }, create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); facts.created.push(url); return url; };
    URL.revokeObjectURL = url => { facts.revoked.push(url); return revoke(url); };
  });
  page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', cause => pageErrors.push(cause.message));
  page.on('console', value => { if (['error', 'warning'].includes(value.type())) consoleMessages.push({ type: value.type(), text: value.text(), location: value.location() }); });
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/acceptance/')) browserRequests.push({ method: request.method(), path: url.pathname,
    ...(request.method() === 'POST' ? { body: request.postDataJSON() } : {}) }); });
}
async function launchUI(release, { loseReply = false } = {}) {
  await component().getByTestId('browser-execution-candidate').selectOption(candidate.id);
  await component().getByTestId('browser-execution-target').selectOption(release.id);
  await component().getByTestId('browser-execution-review').click(); await component().getByTestId('browser-execution-confirmation').waitFor();
  assert.equal(await component().getByTestId('browser-execution-start').isDisabled(), true);
  await component().getByTestId('browser-execution-confirm').check();
  await waitFor(async () => !(await component().getByTestId('browser-execution-start').isDisabled()), 'approval ready');
  const count = uiPosts().length;
  const losePattern = '**/api/acceptance/' + executionPath();
  const loseHandler = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 202);
    lostReplies++;
    await route.fulfill({ status: 502, contentType: 'text/html', body: '<!doctype html><title>Controlled lost acceptance response</title>' });
  };
  if (loseReply) await page.route(losePattern, loseHandler);
  await component().getByTestId('browser-execution-start').click();
  await waitFor(() => uiPosts().length === count + 1, 'one execution request');
  const input = uiPosts().at(-1).body;
  assert.deepEqual(Object.keys(input).sort(), ['operationId', 'expectedGenerationId', 'expectedRevision', 'candidateId', 'contentDigest', 'targetReleaseId'].sort());
  assert.equal(input.candidateId, candidate.id); assert.equal(input.targetReleaseId, release.id);
  const final = await completed(input.operationId);
  await component().getByTestId('browser-execution-refresh').click();
  await component().locator('[data-testid="browser-execution-open-report"][data-operation-id="' + input.operationId + '"]').waitFor();
  assert.equal(uiPosts().length, count + 1, 'lost replies must never auto-repost');
  if (loseReply) { await page.unroute(losePattern, loseHandler); assert.equal(lostReplies, 1); }
  return { input, final };
}
async function openReport(id) {
  await component().locator('[data-testid="browser-execution-open-report"][data-operation-id="' + id + '"]').click();
  await component().getByTestId('browser-execution-report').waitFor();
}
async function registerUI(id, before) {
  await openReport(id);
  await component().getByTestId('browser-execution-before').selectOption(before ?? '');
  await component().getByTestId('browser-execution-register').click();
  return waitFor(async () => { const value = await ledger(); return value.entries.some(entry => entry.operationId === id) && value; }, 'durable issue registration');
}
async function capture(name, width, height, theme, anchor = component()) {
  await page.setViewportSize({ width, height }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await anchor.scrollIntoViewIfNeeded();
  await anchor.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const layout = await component().evaluate(element => ({ documentWidth: document.documentElement.scrollWidth, clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth, rect: element.getBoundingClientRect().toJSON(), text: element.innerText }));
  assert.ok(layout.clientWidth > 0 && layout.documentWidth <= width + 1 && layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
  layouts.push({ name, width, height, theme, ...layout }); captures.push(name + '.png');
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false }); save(name + '-dom.txt', layout.text);
}

console.log(JSON.stringify({ event: 'started', startedAt, outputDirectory: OUT }));
try {
  assert.equal(fs.existsSync(resolve(CORE, '../console/dist/index.html')), true, 'Build console first.');
  const owner = acquireAcceptanceOwner({ root: ROOT });
  try { await createAcceptanceCatalogStore({ root: ROOT, owner }).initialize({ createSchemaVersion: 4 }); } finally { owner.release(); }
  target = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.invalid').pathname;
    targetRequests.push({ method: request.method, path, at: new Date().toISOString() });
    if (path.startsWith('/hold')) { held.add(response); response.once('close', () => held.delete(response)); return; }
    const missing = path.startsWith('/source') && !sourceAvailable;
    response.writeHead(missing ? 410 : 200, { 'content-type': 'text/html' });
    response.end(missing ? 'Source intentionally unavailable after capture' : html(/^\/(broken|regressed)/.test(path)));
  });
  targetBase = await listen(target); save('controlled-healthy.html', html(false)); save('controlled-bug.html', html(true)); await startEngine();
  const input = { name: 'Fixed Browser complete acceptance', mode: 'regression', baselineUrl: targetBase + '/source?source=fixed-contract-url-sentinel',
    targetUrl: targetBase + '/broken', routes: ['/'], viewports: [{ name: 'desktop', width: 960, height: 640 }, { name: 'mobile', width: 375, height: 812 }],
    timeoutMs: 4000, settleMs: 50, points: [{ id: 'menu', title: 'Expanded menu', route: '/', severity: 'high',
      steps: [{ action: 'fill', selector: '#entry', value: 'fixed-contract-fill-sentinel' }, { action: 'click', selector: '#menu-toggle' }],
      assertions: [{ kind: 'visible', selector: '#menu' }, { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' },
        { kind: 'text', selector: '#literal', equals: 'fixed-contract-source-sentinel' }] }] };
  source = await api('runs', input, 202);
  await waitFor(async () => (await api('runs/' + source.runId)).status === 'completed', 'fresh captured source', 90000);
  const sourceReport = await api('runs/' + source.runId + '/report'); assert.equal(sourceReport.gate, 'failed'); assert.equal(sourceReport.checks.length, 14);
  project = (await api('projects', { ...cas(await latest()), name: 'Single-operation Browser acceptance' }, 201)).project;
  const release = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label: 'Captured approved source', targetUrl: input.baselineUrl }, 201)).release;
  const binding = (await api('projects/' + project.id + '/browser-source-bindings', { ...cas(await latest()), releaseId: release.id, runId: source.runId, sourceSide: 'baseline' }, 201)).binding;
  const preview = await api('projects/' + project.id + '/browser-source-bindings/' + binding.id + '/candidate-preview');
  candidate = (await api('projects/' + project.id + '/browser-baseline-candidates', { ...cas(await latest()), sourceBindingId: binding.id, contentDigest: preview.contentDigest }, 201)).candidate;
  const releases = {};
  for (const [path, label] of [['broken', 'Known broken target'], ['healthy', 'Repaired target'], ['regressed', 'Regressed target'], ['hold', 'Cancelled target']]) {
    releases[path] = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label, targetUrl: targetBase + '/' + path }, 201)).release;
  }
  save('source-and-candidate.json', { source, sourceReport, project, release, binding, candidate, releases });
  const originals = tree(join(ROOT, source.runId)), catalogBefore = heads(), sourceRequests = targetRequests.filter(value => value.path.startsWith('/source')).length;
  sourceAvailable = false; checks.freshFailedComparisonHealthySideSavedAsCandidate = true;
  const anonymous = await fetch(base + '/api/acceptance/' + executionPath()); assert.equal(anonymous.status, 401);
  checks.engineAuthenticationProtectsDedicatedBrowserRoutes = true;
  await startBrowser(); await openConsole();
  assert.ok((await page.title()).length > 0); assert.ok((await page.locator('body').innerText()).includes('项目验收'));
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  const bad = await launchUI(releases.broken); await openReport(bad.input.operationId);
  const badReport = await report(bad.input.operationId); save('broken-complete-report.json', badReport);
  assert.equal(badReport.gate, 'failed'); assert.equal(badReport.report.checks.length, 14);
  assert.ok(badReport.report.checks.some(value => value.identity.facet === 'visual' && value.verdict === 'bug'));
  assert.ok(badReport.report.checks.some(value => value.identity.facet === 'behavior' && value.verdict === 'bug'));
  assert.equal(badReport.report.environmentComparison.comparable, true); checks.nativeFreshApprovalFindsVisualAndBehaviorBugs = true;
  const firstBug = badReport.report.checks.find(value => value.identity.facet === 'visual' && value.verdict === 'bug');
  const screenshot = badReport.report.evidenceManifest.find(value => value.file === firstBug.evidence.targetScreenshot);
  const evidencePath = '/api/acceptance/' + executionPath() + '/' + bad.input.operationId + '/evidence/' + screenshot.file;
  await page.route('**' + evidencePath + '?*', async route => { const response = await route.fetch(), bytes = Buffer.from(await response.body()); bytes[bytes.length - 1] ^= 1; await route.fulfill({ response, body: bytes }); }, { times: 1 });
  await component().getByTestId('browser-execution-images').first().click();
  await waitFor(async () => /SHA-256|图片/.test(await component().getByTestId('browser-execution-error').innerText()), 'tampered image rejected');
  assert.equal(await component().locator('.images img').count(), 0);
  await component().getByTestId('browser-execution-images').first().click();
  await waitFor(async () => await component().locator('.images img').count() === 3, 'three verified original screenshots');
  await waitFor(() => component().locator('.images img').evaluateAll(images => images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0)), 'verified evidence renders');
  await capture('browser-execution-evidence-desktop', 1440, 1000, 'light', component().locator('.images'));
  const evidence = await fetch(base + evidencePath + '?expectedSha256=' + screenshot.sha256, { headers });
  assert.equal(evidence.status, 200); const original = Buffer.from(await evidence.arrayBuffer()); assert.equal(hash(original), screenshot.sha256); assert.equal(original.length, screenshot.bytes);
  checks.serverAndClientVerifyEvidenceBytesAndRejectTamperedImage = true;
  await registerUI(bad.input.operationId); const initialLedger = await ledger(); assert.ok(initialLedger.issues.some(value => value.status === 'open'));
  save('ledger-initial.json', initialLedger);
  await capture('browser-execution-desktop-dark', 1440, 1000, 'dark'); await capture('browser-execution-mobile-light', 390, 844, 'light');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const good = await launchUI(releases.healthy, { loseReply: true }); const goodReport = await report(good.input.operationId); save('repaired-complete-report.json', goodReport);
  assert.equal(goodReport.gate, 'passed'); assert.equal(goodReport.summary.passed, 14); assert.equal(goodReport.summary.bugs, 0);
  const fixedLedger = await registerUI(good.input.operationId, bad.input.operationId); save('ledger-verified-passed.json', fixedLedger);
  assert.ok(fixedLedger.issues.length > 0); assert.ok(fixedLedger.issues.every(value => value.status === 'verified_passed'));
  checks.lostAcceptedResponseUsesOnlyOriginalOperationQueries = true; checks.explicitBeforeAfterRetestVerifiesTheSameChecks = true;
  const degraded = await launchUI(releases.regressed); const reopenLedger = await registerUI(degraded.input.operationId, good.input.operationId);
  save('ledger-reopened.json', reopenLedger); assert.ok(reopenLedger.issues.some(value => value.status === 'reopened'));
  checks.reliableRegressionReopensPreviouslyVerifiedCheckIssues = true;
  const blobState = await page.evaluate(() => window.__browserExecutionBlobs);
  assert.ok(blobState.created.length >= 3); assert.deepEqual([...new Set(blobState.created)].sort(), [...new Set(blobState.revoked)].sort());
  checks.sourceEvidenceImagesRenderAndRevokeAfterContextChanges = true;
  const issues = component().getByTestId('browser-bugs');
  await issues.locator('.issues > li').first().locator('details > summary').click();
  await capture('browser-execution-issue-history-desktop', 1440, 1000, 'light', issues);
  await capture('browser-execution-issue-history-mobile', 390, 844, 'dark', issues);
  await capture('browser-execution-desktop-light', 1440, 1000, 'light'); await capture('browser-execution-mobile-dark', 390, 844, 'dark');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const cancelInput = { ...cas(await latest()), operationId: 'bo-' + randomUUID(), candidateId: candidate.id, contentDigest: candidate.contentDigest, targetReleaseId: releases.hold.id };
  await api(executionPath(), cancelInput, 202); await waitFor(() => held.size > 0, 'target navigation held');
  await component().getByTestId('browser-execution-refresh').click();
  const runningRow = component().locator('[data-browser-operation="' + cancelInput.operationId + '"]');
  const cancelPath = '/api/acceptance/' + executionPath() + '/' + cancelInput.operationId + '/cancel';
  const heldCancelReply = new Promise(resolve => { releaseHeldCancelReply = resolve; });
  let heldCancelCount = 0;
  const holdCancelReply = async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200); heldCancelCount++;
    await heldCancelReply; await route.abort('failed').catch(() => {});
  };
  await page.route('**' + cancelPath, holdCancelReply);
  await runningRow.getByTestId('browser-execution-stop').click();
  const cancelled = await waitFor(async () => { const value = await operation(cancelInput.operationId); return value.state === 'interrupted' && value; }, 'real Browser cancellation');
  assert.equal(cancelled.reasonCode, 'CANCELLED'); save('cancelled-operation.json', cancelled);
  await waitFor(() => held.size === 0, 'cancel closes held target browser'); checks.nativeStopInterruptsTargetAndNeverCompletesFalsePass = true;
  await waitFor(async () => !(await component().getByTestId('browser-execution-review').isDisabled())
    && /结果未知|请求结果|响应无法读取/.test(await component().getByTestId('browser-execution-error').innerText()), 'pending POST deadline releases UI controls', 75000);
  assert.equal(heldCancelCount, 1);
  assert.equal(browserRequests.filter(value => value.method === 'POST' && value.path === cancelPath).length, 1);
  releaseHeldCancelReply(); await page.unroute('**' + cancelPath, holdCancelReply);
  checks.pendingAcceptedStopResponseHasBoundedWaitWithoutRepeatingPost = true;
  assert.deepEqual(heads(), catalogBefore, 'Single-operation execution and issue registration cannot mutate the catalog.');
  const foreign = (await api('projects', { ...cas(await latest()), name: 'Separate Browser project' }, 201)).project;
  for (const suffix of ['', '/report', '/evidence/' + screenshot.file + '?expectedSha256=' + screenshot.sha256]) {
    await api('projects/' + foreign.id + '/browser-executions/' + bad.input.operationId + suffix, undefined, 404);
  }
  const legacy = await fetch(base + '/api/acceptance/runs/' + bad.final.runId, { headers }); assert.ok([400, 404].includes(legacy.status));
  const beforeReplay = targetRequests.length;
  const replay = await api(executionPath(), bad.input); assert.equal(replay.replayed, true); assert.equal(replay.runId, bad.final.runId);
  assert.equal(targetRequests.length, beforeReplay); checks.explicitReplayAndForeignQueriesCannotStartAnotherRun = true;
  const currentHeads = heads(); assert.notDeepEqual(currentHeads, catalogBefore, 'Only explicit creation of the foreign project advances catalog.');
  const currentCatalog = parse(join(ROOT, 'catalog.json')); assert.equal(Object.keys(currentCatalog.approvals).length, 0); assert.equal(Object.keys(currentCatalog.selections).length, 0);
  const beforeRestart = targetRequests.length, durableLedger = await ledger();
  await stop(engine);
  const offlineOwner = acquireAcceptanceOwner({ root: ROOT }); let preparedInput;
  try {
    const catalog = createAcceptanceCatalogStore({ root: ROOT, owner: offlineOwner }), store = createBrowserOperationStore({ owner: offlineOwner });
    await catalog.initialize(); preparedInput = { ...cas(catalog.read()), operationId: 'bo-' + randomUUID(), candidateId: candidate.id,
      contentDigest: candidate.contentDigest, targetReleaseId: releases.healthy.id };
    await catalog.withBrowserExecutionCandidate(project.id, preparedInput, { assertAdmission: () => true, publish: (context, options) => store.publish(context, options) });
    assert.equal(store.read(preparedInput.operationId).state, 'prepared');
  } finally { offlineOwner.release(); }
  await startEngine();
  assert.deepEqual(await ledger(), durableLedger); assert.equal((await operation(bad.input.operationId)).state, 'completed');
  assert.equal((await operation(preparedInput.operationId)).state, 'prepared');
  assert.equal((await api(executionPath(), preparedInput)).state, 'prepared'); await delay(250);
  assert.equal(targetRequests.length, beforeRestart); assert.deepEqual(heads(), currentHeads);
  save('prepared-after-restart.json', await operation(preparedInput.operationId));
  checks.restartReadsSameLedgerAndPreparedOperationsNeverAutoStart = true;
  await openConsole(); await component().getByTestId('browser-bugs-refresh').click(); await component().getByTestId('browser-bugs').waitFor();
  assert.ok((await component().innerText()).includes('再次发现')); checks.restartUiReadsPersistedCheckIssues = true;
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, hrefs: [...document.querySelectorAll('a[href]')].map(value => value.getAttribute('href')) }));
  assert.equal(/fixed-contract-(url|fill|source)-sentinel/.test(JSON.stringify(storage)), false); save('browser-storage.json', storage);
  checks.fullSourceNeverEntersStorageOrHrefs = true;
  assert.equal(targetRequests.filter(value => value.path.startsWith('/source')).length, sourceRequests);
  assert.deepEqual(tree(join(ROOT, source.runId)), originals); save('source-file-digests.json', originals);
  assert.equal(pageErrors.length, 0); assert.equal(await page.locator('vite-error-overlay').count(), 0);
  checks.fixedSourceIsNeverRevisitedAndOriginalCaptureBytesAreUnchanged = true; checks.realRenderedUiHasNoPageErrors = true;
  save('final-ledger.json', await ledger()); save('final-operation-collection.json', await api(executionPath()));
} catch (cause) {
  failure = cause; save('failure.json', { name: cause.name, message: cause.message, stack: cause.stack });
  if (page) { await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {}); save('failure-dom.txt', await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  save('checks.json', checks); save('browser-requests.json', browserRequests); save('target-requests.json', targetRequests);
  save('browser-errors.json', { pageErrors, consoleMessages }); save('layouts.json', layouts);
  for (const response of held) response.destroy(); held.clear();
  releaseHeldCancelReply?.();
  if (browser) await browser.close().catch(() => {}); await stop(chromiumProcess); await stop(engine); await close(target);
  save('engine.log', engineLog); save('chromium.log', chromiumLog);
  save('summary.json', { status: failure ? 'failed' : 'passed', startedAt, endedAt: new Date().toISOString(),
    browserPath: 'Browser plugin not available; repository Playwright CDP', checks: Object.keys(checks).length, captures, outputDirectory: OUT });
}
if (failure) { console.error(failure.stack); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'passed', checks: Object.keys(checks).length, outputDirectory: OUT }));
