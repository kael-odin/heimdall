#!/usr/bin/env node
/** Fresh Browser workers -> native catalog side binding -> on-demand source review. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { migrateCombinedCatalogFixture, catalogCompatibilityTree } from './fixtures/catalog-v4-compatibility.mjs';

const arguments_ = process.argv.slice(2), migrateCatalog = arguments_.includes('--migrate-catalog');
assert.ok(arguments_.filter(value => value === '--migrate-catalog').length <= 1);
const outputArguments = arguments_.filter(value => value !== '--migrate-catalog');
assert.ok(outputArguments.length <= 1 && outputArguments.every(value => !value.startsWith('--')));
const CORE = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(outputArguments[0] ?? join(CORE, 'workspace/_runs/browser-bindings-console-smoke-' + randomUUID()));
fs.mkdirSync(dirname(OUT), { recursive: true }); fs.mkdirSync(OUT);
const DATA = join(OUT, 'runtime'), ROOT = join(DATA, 'acceptance');
fs.mkdirSync(DATA);
const token = 'browser-bindings-console-local-fixture';
const headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const checks = {}, requests = [], browserRequests = [], errors = [], expectedResourceErrors = [], layouts = [], captures = [], samples = [], held = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (file, value) => fs.writeFileSync(join(OUT, file), Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const parse = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const delay = ms => new Promise(ready => setTimeout(ready, ms));
const startedAt = new Date().toISOString();
console.log(JSON.stringify({ event: 'started', startedAt, outputDirectory: OUT }));
let target, engine, browser, chromiumProcess, page, base, fixtureBase, captureRequestCount = 0, failed;
let engineLog = '', chromiumLog = '';
const profile = fs.mkdtempSync(join(tmpdir(), 'heimdall-browser-bindings-cdp-'));
async function waitFor(fn, label, budget = 15000) {
  const deadline = Date.now() + budget; let last;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(75); }
  throw new Error(label + ': ' + (last?.message ?? 'expected state not reached'));
}
async function listen(server) { await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); }); return 'http://127.0.0.1:' + server.address().port; }
async function close(server) { if (server?.listening) await new Promise((ready, reject) => { server.close(error => error ? reject(error) : ready()); server.closeAllConnections(); }); }
async function freePort() { const server = createServer(); const address = await listen(server); await close(server); return new URL(address).port; }
async function stop(child) { if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return; const ended = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([ended, delay(5000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; } }
async function api(path, body, status = 200) {
  const response = await fetch(base + '/api/acceptance/' + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(value)); return value;
}
const latest = () => api('projects');
const projectDetail = id => api('projects/' + id);
function runFiles(runId) { const directory = join(ROOT, runId); return fs.readdirSync(directory).sort().map(file => { const bytes = fs.readFileSync(join(directory, file)); return { file, bytes: bytes.length, sha256: sha(bytes) }; }); }
function heads() { return Object.fromEntries(['catalog.json', 'catalog.previous.json'].map(file => [file, fs.readFileSync(join(ROOT, file)).toString('base64')])); }
function html(side) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Browser organization fixture</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial,sans-serif;background:#f0f4f8;color:#172438}header{padding:16px 24px;background:#172438;color:white;display:flex;justify-content:space-between}button{font:inherit;padding:9px 15px}main{max-width:900px;padding:24px;margin:auto}h1{font-size:30px}.panel{height:240px;padding:24px;border:1px solid #bbc9d7;background:${side === 'target' ? '#8d2b10' : 'white'};color:${side === 'target' ? 'white' : '#172438'};transform:translateY(${side === 'target' ? '80px' : '0'})}nav[hidden]{display:none}nav{padding:12px;background:#d6e8ff}@media(max-width:500px){main{padding:16px}h1{font-size:24px}}</style></head><body><header><strong>NORTHSTAR</strong><button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button></header><main><h1>Controlled delivery review</h1><nav id="menu" hidden><a href="details">Details</a></nav><section class="panel"><h2>Source evidence</h2><p>128 declared tasks</p></section></main><script>document.querySelector('#menu-toggle').addEventListener('click',function(){const menu=document.querySelector('#menu');menu.hidden=!menu.hidden;this.setAttribute('aria-expanded',String(!menu.hidden))})</script></body></html>`;
}
async function startEngine() {
  base = 'http://127.0.0.1:' + await freePort();
  engine = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE, windowsHide: true,
    env: { ...process.env, HEIMDALL_DATA_DIR: DATA, HEIMDALL_CONSOLE_DIR: resolve(CORE, '../console/dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.stdout.on('data', bytes => { engineLog += bytes; }); engine.stderr.on('data', bytes => { engineLog += bytes; });
  await waitFor(async () => { if (engine.exitCode !== null) throw new Error('Engine exited: ' + engineLog); return (await fetch(base + '/api/status', { headers })).ok; }, 'engine ready');
}
async function startBrowser() {
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; }); chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  const active = join(profile, 'DevToolsActivePort');
  await waitFor(() => fs.existsSync(active) && fs.readFileSync(active, 'utf8').split('\n')[0], 'CDP Chromium port');
  const endpoint = 'http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0];
  save('cdp-version.json', await (await fetch(endpoint + '/json/version')).json());
  browser = await chromium.connectOverCDP(endpoint);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('heimdall-token', value);
  }, token);
  await context.addInitScript(() => {
    const facts = window.__browserBindingBlobFacts = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); facts.created.push(url); return url; };
    URL.revokeObjectURL = url => { facts.revoked.push(url); return revoke(url); };
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (!['warning', 'error'].includes(message.type())) return;
    if (/409|404|502|503|ERR_FAILED|net::ERR_FAILED/.test(message.text())) expectedResourceErrors.push(message.text()); else errors.push(message.text()); });
  page.on('request', request => { const path = new URL(request.url()).pathname; if (!path.startsWith('/api/acceptance/')) return;
    const record = { method: request.method(), path }; if (record.method === 'POST') record.body = request.postDataJSON(); browserRequests.push(record); });
}
const component = () => page.getByTestId('browser-bindings');
const panel = () => page.getByTestId('acceptance-catalog');
const posts = () => browserRequests.filter(item => item.method === 'POST' && item.path.endsWith('/browser-source-bindings'));
async function ready(projectId) {
  await waitFor(async () => await panel().locator('[name="catalog-project"]').inputValue() === projectId
    && await component().isVisible() && !(await component().getByTestId('browser-binding-run').isDisabled())
    && !(await panel().getByTestId('catalog-refresh').isDisabled()), 'Browser binding form ready');
}
async function selectProject(id) { await panel().locator('[name="catalog-project"]').selectOption(id); await ready(id); }
async function refresh(id) { await panel().getByTestId('catalog-refresh').click(); await ready(id); }
async function choose(runId, side, releaseId) {
  await component().getByTestId('browser-binding-run').selectOption(runId);
  await component().getByTestId('browser-binding-side').selectOption(side);
  await component().getByTestId('browser-binding-release').selectOption(releaseId);
}
async function bind(runId, side, releaseId, projectId) {
  await choose(runId, side, releaseId); await component().getByTestId('browser-binding-confirm').check();
  const before = posts().length; await component().getByTestId('browser-binding-submit').click();
  const record = await waitFor(async () => (await projectDetail(projectId)).browserSourceBindings.find(item => item.source.runId === runId && item.source.side === side), 'native source binding committed');
  await ready(projectId); assert.equal(posts().length, before + 1);
  assert.deepEqual(Object.keys(posts().at(-1).body).sort(), ['expectedGenerationId', 'expectedRevision', 'runId', 'sourceSide', 'releaseId'].sort());
  assert.equal(posts().at(-1).body.sourceSide, side); return record;
}
async function preview(binding) {
  await component().locator('[data-testid="browser-binding-preview"][data-binding-id="' + binding.id + '"]').click();
  await waitFor(async () => (await component().getByTestId('browser-binding-diagnostics').innerText()).includes('一致'), 'source revalidation visible');
}
async function holdResponse(path, method = 'GET') {
  let release, arrived = false, captured; const gate = new Promise(ready => { release = ready; });
  const handler = async route => { if (route.request().method() !== method) return route.continue();
    const response = await route.fetch(); captured = { status: response.status(), body: await response.json() }; arrived = true;
    await gate; await route.fulfill({ response }).catch(() => {}); };
  await page.route('**' + path, handler, { times: 1 });
  const record = { release, arrived: () => waitFor(() => arrived, 'held ' + method), captured: () => captured,
    dispose: () => page.unroute('**' + path, handler) }; held.push(record); return record;
}
async function capture(name, width, height, theme, focus = 'preview') {
  await page.setViewportSize({ width, height }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  const viewResults = page.getByTestId('acceptance-view-results'); if (await viewResults.isVisible()) await viewResults.click();
  const focused = focus === 'preview' ? component().getByTestId('browser-binding-preview-content')
    : focus === 'evidence' ? component().locator('[data-testid="browser-binding-evidence-content"][data-role="screenshot"]').first() : component();
  await focused.scrollIntoViewIfNeeded();
  await focused.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const layout = await page.evaluate(() => { const region = document.querySelector('[data-testid="browser-bindings"]'), rect = region.getBoundingClientRect();
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, clientWidth: region.clientWidth, scrollWidth: region.scrollWidth,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom } }; });
  assert.ok(layout.clientWidth > 0); assert.ok(layout.documentWidth <= width + 1, JSON.stringify(layout)); assert.ok(layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
  layouts.push({ name, width, height, theme, focus, ...layout });
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false }); save(name + '-dom.txt', await component().innerText()); captures.push(name + '.png');
}

try {
  assert.ok(fs.existsSync(resolve(CORE, '../console/dist/index.html')), 'Build console first.');
  target = createServer((request, response) => { requests.push({ method: request.method, path: request.url });
    const side = new URL(request.url, 'http://fixture.invalid').pathname.split('/')[1];
    response.writeHead(side === 'baseline' || side === 'target' ? 200 : 404, { 'content-type': 'text/html' }); response.end(html(side)); });
  fixtureBase = await listen(target); save('controlled-baseline.html', html('baseline')); save('controlled-target.html', html('target'));
  await startEngine();
  for (const mode of ['mirror', 'regression']) {
    const input = { name: 'Browser organization ' + mode, mode,
      baselineUrl: fixtureBase + '/baseline?build=approved-query-sentinel&channel=stable',
      targetUrl: fixtureBase + '/target?build=current-query-sentinel&channel=development', routes: ['/'],
      viewports: [{ name: 'desktop', width: 960, height: 640 }, { name: 'mobile', width: 375, height: 812 }], timeoutMs: 5000, settleMs: 50,
      points: [{ id: 'menu', title: 'Menu expands', route: '/', severity: 'high', steps: [{ action: 'click', selector: '#menu-toggle' }],
        assertions: [{ kind: 'visible', selector: '#menu' }, { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' }] }] };
    const result = await api('runs', input, 202);
    const manifest = await waitFor(async () => { const value = await api('runs/' + result.runId); return value.status === 'completed' && value; }, 'fresh worker complete', 60000);
    // manifest 写成 completed 与引擎释放执行槽不是同一刻：槽在 worker 子进程 exit 事件里才释放。
    // 慢机器上下一次 POST runs 会落进这段窗口拿到 409 ACCEPTANCE_BUSY —— 等槽真正空出来再继续。
    await waitFor(async () => (await (await fetch(base + '/api/status', { headers })).json()).acceptance === null, 'acceptance slot released', 30000);
    const report = await api('runs/' + result.runId + '/report'); assert.equal(report.gate, 'failed'); assert.equal(report.checks.length, 14);
    samples.push({ mode, runId: result.runId, input, manifest, reportGate: report.gate, originalFiles: runFiles(result.runId) });
  }
  captureRequestCount = requests.length; checks.freshMirrorAndRegressionWorkersPreserveFailedComparison = true;
  const projects = {};
  for (const [key, name, side] of [['a', 'Browser baseline evidence', 'baseline'], ['b', 'Browser target evidence', 'target']]) {
    const project = (await api('projects', { ...cas(await latest()), name }, 201)).project;
    const release = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label: side + ' declared release', targetUrl: samples[0].input[side + 'Url'] }, 201)).release;
    projects[key] = { project, release };
  }
  // Exercise legacy target first, leaving baseline independently unclaimed.
  await api('projects/' + projects.b.project.id + '/run-bindings', { ...cas(await latest()), runId: samples[0].runId, releaseId: projects.b.release.id }, 201);
  await startBrowser(); await page.goto(base, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Heimdall/i); assert.equal(new URL(page.url()).origin, base);
  await page.getByRole('button', { name: '项目验收', exact: true }).click(); await panel().getByTestId('catalog-toggle').click();
  await selectProject(projects.a.project.id);
  assert.equal(await component().getByTestId('browser-binding-side').inputValue(), '');
  assert.equal(await component().getByTestId('browser-binding-submit').isDisabled(), true);
  checks.noImplicitSideAndNoAutomaticBinding = true;
  await choose(samples[0].runId, 'baseline', projects.a.release.id);
  await component().getByTestId('browser-binding-confirm').check();
  await component().getByTestId('browser-binding-side').selectOption('target');
  assert.equal(await component().getByTestId('browser-binding-confirm').isChecked(), false);
  assert.equal(await component().getByTestId('browser-binding-submit').isDisabled(), true);
  checks.changingSideRequiresFreshConfirmation = true;
  const baseline = await bind(samples[0].runId, 'baseline', projects.a.release.id, projects.a.project.id);
  await capture('browser-binding-desktop-form', 1440, 1000, 'dark', 'form');
  assert.equal(baseline.source.side, 'baseline'); await preview(baseline);
  assert.equal(await component().getByTestId('browser-binding-observation').count(), 4);
  assert.equal((await component().innerText()).includes('approved-query-sentinel'), false);
  assert.equal((await component().innerText()).includes('current-query-sentinel'), false);
  checks.nativeBaselineBindingAndSelectedSideReviewAreSafe = true;
  const detail = await api('projects/' + projects.a.project.id + '/browser-source-bindings/' + baseline.id);
  assert.equal(detail.executionReady, false); assert.equal(detail.preview.observations.length, 4); assert.equal(detail.preview.declaredSlots, 14);
  save('baseline-detail.json', detail);
  await component().getByTestId('browser-binding-observation').first().locator('details').first().locator('summary').first().click();
  const screenshotPath = '/api/acceptance/runs/' + baseline.source.runId + '/evidence/' + detail.preview.observations[0].evidence.screenshot.file;
  const createdBeforeBadBlob = await page.evaluate(() => window.__browserBindingBlobFacts.created.length);
  await page.route('**' + screenshotPath, async route => {
    const response = await route.fetch(), bytes = await response.body();
    assert.ok(bytes.length > 0); bytes[bytes.length - 1] ^= 1;
    await route.fulfill({ response, body: bytes });
  }, { times: 1 });
  await component().getByTestId('browser-binding-evidence-screenshot').first().click();
  await component().locator('[data-testid="browser-binding-evidence-error"][data-role="screenshot"][data-observation-index="0"]').waitFor();
  assert.equal(await component().locator('[data-testid="browser-binding-evidence-content"][data-role="screenshot"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__browserBindingBlobFacts.created.length), createdBeforeBadBlob);
  checks.sameLengthCorruptEvidenceCannotBecomeBlobOrImage = true;
  await component().getByTestId('browser-binding-evidence-screenshot').first().click();
  await component().locator('[data-testid="browser-binding-evidence-content"][data-role="screenshot"][data-observation-index="0"] img[src^="blob:"]').waitFor();
  await component().getByTestId('browser-binding-evidence-repeat').first().click();
  await component().locator('[data-testid="browser-binding-evidence-content"][data-role="repeat"][data-observation-index="0"] img[src^="blob:"]').waitFor();
  await component().getByTestId('browser-binding-evidence-details').first().click();
  await component().locator('[data-testid="browser-binding-evidence-content"][data-role="details"][data-observation-index="0"]').waitFor();
  checks.selectedSideAllThreeEvidenceRolesOpenThroughAuthenticatedBlob = true;
  await capture('browser-binding-desktop-review', 1440, 1000, 'dark');
  await capture('browser-binding-desktop-evidence', 1440, 1000, 'dark', 'evidence');
  await selectProject(projects.b.project.id);
  const targetBinding = await bind(samples[0].runId, 'target', projects.b.release.id, projects.b.project.id);
  assert.equal(targetBinding.source.side, 'target'); await preview(targetBinding);
  checks.targetRemainsCompatibleWithLegacyAndBaselineIndependent = true;
  // A late GET must not restore an old preview after an A -> B -> A project cycle.
  await component().getByTestId('browser-binding-close-preview').click();
  const lateRead = await holdResponse('/api/acceptance/projects/' + projects.b.project.id + '/browser-source-bindings/' + targetBinding.id);
  await component().locator('[data-testid="browser-binding-preview"][data-binding-id="' + targetBinding.id + '"]').click(); await lateRead.arrived();
  await selectProject(projects.a.project.id); await selectProject(projects.b.project.id);
  lateRead.release(); await lateRead.dispose(); await delay(100);
  assert.equal(await component().getByTestId('browser-binding-preview-content').count(), 0);
  checks.projectABACannotRestoreLatePreview = true;
  // Commit succeeds at the engine but a gateway reply is lost to the UI; refresh only reads.
  await selectProject(projects.a.project.id); await choose(samples[1].runId, 'baseline', projects.a.release.id);
  const postPath = '/api/acceptance/projects/' + projects.a.project.id + '/browser-source-bindings';
  await page.route('**' + postPath, async route => { if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 201); await route.fulfill({ status: 502, contentType: 'text/html', body: '<!doctype html><title>Controlled lost reply</title>' }); }, { times: 1 });
  const beforeLost = posts().length; await component().getByTestId('browser-binding-confirm').check(); await component().getByTestId('browser-binding-submit').click();
  await panel().getByTestId('catalog-error').waitFor(); assert.equal(posts().length, beforeLost + 1);
  await refresh(projects.a.project.id); assert.equal(posts().length, beforeLost + 1);
  assert.equal((await projectDetail(projects.a.project.id)).browserSourceBindings.filter(item => item.source.runId === samples[1].runId && item.source.side === 'baseline').length, 1);
  checks.lostPostReconcilesStoredHistoryWithoutReplay = true;
  // Explicit test injection; the product must return a read-only diagnostic and preserve history.
  await preview(baseline); await component().getByTestId('browser-binding-close-preview').click();
  const reportPath = join(ROOT, samples[0].runId, 'report.json'), original = fs.readFileSync(reportPath), beforeHeads = heads();
  try {
    fs.appendFileSync(reportPath, ' ');
    const collection = await api('projects/' + projects.a.project.id + '/browser-source-bindings');
    assert.equal(collection.verification.currentSourceVerified, false); assert.ok(collection.bindings.some(item => item.id === baseline.id));
    await component().locator('[data-testid="browser-binding-preview"][data-binding-id="' + baseline.id + '"]').click();
    await waitFor(async () => (await component().getByTestId('browser-binding-diagnostics').innerText()).includes('变化')
      || (await component().getByTestId('browser-binding-diagnostics').innerText()).includes('无法'), 'changed source diagnostic');
    const read = await api('projects/' + projects.a.project.id + '/browser-source-bindings/' + baseline.id);
    assert.equal(read.preview, null); assert.equal(read.diagnostics.contentMatches, false); assert.deepEqual(heads(), beforeHeads); save('changed-source-detail.json', read);
    await capture('browser-binding-source-changed', 1440, 1000, 'dark');
  } finally { fs.writeFileSync(reportPath, original); }
  checks.changedSourceRetainsHistoryAndReadNeverWrites = true;
  await preview(baseline);
  for (const theme of ['dark', 'light']) {
    await capture('browser-binding-mobile-form-' + theme, 390, 844, theme, 'form');
    await capture('browser-binding-mobile-review-' + theme, 390, 844, theme);
  }
  checks.desktopAndBothMobileThemesHaveNoHorizontalOverflow = true;
  await component().getByTestId('browser-binding-close-preview').click();
  const blobFacts = await page.evaluate(() => window.__browserBindingBlobFacts);
  assert.ok(blobFacts.created.length >= 2);
  assert.ok(blobFacts.created.every(url => blobFacts.revoked.includes(url)));
  save('blob-lifecycle.json', blobFacts);
  checks.closingOrChangingReviewRevokesVerifiedBlobUrls = true;
  const componentText = await component().innerText(); assert.ok(componentText.length > 150); assert.equal(componentText.includes('approved-query-sentinel'), false);
  assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0); assert.deepEqual(errors, []);
  checks.pageIdentityNonblankOverlayAndConsoleHealthy = true;
  assert.equal(requests.length, captureRequestCount); assert.equal(fs.readdirSync(ROOT).filter(name => /^ac-/.test(name)).length, 2);
  for (const sample of samples) assert.deepEqual(runFiles(sample.runId), sample.originalFiles);
  let catalog = parse(join(ROOT, 'catalog.json')); assert.equal(Object.keys(catalog.candidates).length, 0); assert.equal(Object.keys(catalog.approvals).length, 0); assert.equal(Object.keys(catalog.selections).length, 0);
  checks.noNewRunNoTargetRequestAndOriginalBytesPreserved = true;
  let catalogMigration = null;
  if (migrateCatalog) {
    const expectedErrorsBeforeV4 = expectedResourceErrors.length;
    save('catalog-before-v4-setup.json', catalog);
    await page.goto('about:blank'); await stop(engine);
    catalogMigration = await migrateCombinedCatalogFixture(ROOT, fixtureBase + '/baseline?declared=spec');
    save('catalog-v4-compatibility.json', catalogMigration);
    assert.equal(requests.length, captureRequestCount, 'Spec draft/lifecycle setup and catalog migration do not request the live target.');
    for (const sample of samples) assert.deepEqual(runFiles(sample.runId), sample.originalFiles);
    checks.explicitSchema4MigrationPreservesCombinedSpecAndBrowserHistory = true;
    checks.schema4MaintenanceHasZeroSourceOrDispatchReads = true;
    await startEngine();
    assert.deepEqual(catalogCompatibilityTree(ROOT), catalogMigration.afterTree, 'Schema4 startup preserves the complete Spec/Browser/dispatch file tree and file metadata.');
    catalog = parse(join(ROOT, 'catalog.json'));
    assert.deepEqual(catalog, catalogMigration.afterCatalog);
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '项目验收', exact: true }).click();
    await panel().getByTestId('catalog-toggle').click();
    await selectProject(projects.a.project.id); await preview(baseline);
    await capture('browser-binding-v4-desktop-review', 1440, 1000, 'dark');
    await capture('browser-binding-v4-mobile-review', 390, 844, 'light');
    const specDetail = await projectDetail(catalogMigration.projectId);
    assert.equal(specDetail.candidates.length, 1); assert.equal(specDetail.approvals.length, 1); assert.equal(specDetail.selections.length, 3);
    assert.equal(specDetail.currentSelections.spec.id, catalogMigration.selectionId);
    assert.equal((await api(`projects/${catalogMigration.projectId}/baseline-candidates/${catalogMigration.candidateId}`)).diagnostics.contentMatches, true);
    for (const binding of Object.values(catalog.browserSourceBindings)) {
      const read = await api(`projects/${binding.projectId}/browser-source-bindings/${binding.id}`);
      assert.equal(read.diagnostics.contentMatches, true);
      assert.equal(read.preview.presentation.completeSourceProjection, false);
      assert.equal(read.executionReady, false);
    }
    assert.deepEqual(parse(join(ROOT, 'catalog.json')), catalogMigration.afterCatalog);
    assert.equal(requests.length, captureRequestCount);
    assert.equal(Object.keys(catalog.browserCandidates).length, 0);
    assert.deepEqual(errors, []);
    assert.equal(expectedResourceErrors.length, expectedErrorsBeforeV4, 'Schema4 restart/review has no newly ignored HTTP resource errors.');
    const afterReviewTree = catalogCompatibilityTree(ROOT);
    assert.deepEqual(afterReviewTree, catalogMigration.afterTree, 'Schema4 HTTP/UI reads preserve every original catalog, source, dispatch and lifecycle file.');
    save('catalog-v4-after-review-tree.json', afterReviewTree);
    checks.schema4RestartAndReviewPreserveEveryFileByteAndStat = true;
    checks.schema4ReviewHasZeroAdditionalResourceErrorsAndNoApprovalAuthority = true;
    checks.schema4NativeBrowserReviewAndSpecCurrentSelectionRemainReadable = true;
  }
  save('source-file-digests.json', samples.map(sample => ({ runId: sample.runId, before: sample.originalFiles, after: runFiles(sample.runId) })));
  save('catalog-final.json', catalog); save('projects.json', projects); save('runs.json', samples);
  save('browser-checks.json', { schemaVersion: 1, status: 'passed', startedAt, finishedAt: new Date().toISOString(),
    evidenceLevel: 'fresh-local-fixture-real-engine-workers-native-browser-controls', browser: 'Chromium CDP',
    browserPluginAvailable: false, browserFallbackReason: 'Browser plugin not available', checks, checkCount: Object.keys(checks).length,
    layouts, captures, pageErrors: errors, expectedResourceErrors, sourceRuns: samples.map(({ mode, runId, reportGate }) => ({ mode, runId, reportGate })),
    browserBindingPostCount: posts().length, captureTargetRequests: captureRequestCount, bindingAndReadTargetRequests: requests.length - captureRequestCount,
    catalogMigration: catalogMigration ? { schemaVersion: 4, combinedHistory: true, forbiddenSourceReads: catalogMigration.forbiddenSourceReads,
      specSetupSourceRunId: catalogMigration.sourceRunId, dispatchLifecycleFixtures: catalogMigration.dispatches,
      boundary: catalogMigration.boundary } : null,
    executionReady: false, boundary: 'Controlled organization UI only. No Browser candidate, approval, selection or executor; legacy URL surfaces remain separate. One source whitespace change is an explicit test injection restored from the original bytes. Optional schema4 mode separately labels explicit Spec draft/lifecycle setup before migration.' });
  console.log(JSON.stringify({ status: 'passed', checkCount: Object.keys(checks).length, checks, outputDirectory: OUT }, null, 2));
} catch (error) {
  failed = error;
  save('failure.json', { status: 'failed', message: error.message, stack: error.stack, checks, outputDirectory: OUT });
  if (page) { await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {}); save('failure-dom.txt', await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally {
  for (const item of held) item.release();
  try { await browser?.close(); } finally {
    await stop(chromiumProcess); await stop(engine); await close(target);
    save('engine.log', engineLog); save('chromium.log', chromiumLog); save('target-requests.json', requests); save('browser-requests.json', browserRequests);
    save('layouts.json', layouts); save('browser-errors.json', { pageErrors: errors, expectedResourceErrors });
    const resolvedProfile = resolve(profile), prefix = resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/');
    assert.ok(resolvedProfile.startsWith(prefix) && resolvedProfile.includes('heimdall-browser-bindings-cdp-'));
    fs.rmSync(resolvedProfile, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  }
}
