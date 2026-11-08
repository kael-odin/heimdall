#!/usr/bin/env node
/** Fresh Browser captures -> complete review -> explicit durable candidate; zero execution. */
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

const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every(value => !value.startsWith('--')));
const CORE = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(args[0] ?? join(CORE, 'workspace/_runs/browser-candidates-console-smoke-' + randomUUID()));
fs.mkdirSync(dirname(OUT), { recursive: true }); fs.mkdirSync(OUT);
const DATA = join(OUT, 'runtime'), ROOT = join(DATA, 'acceptance'); fs.mkdirSync(DATA);
const token = 'browser-candidates-console-local-fixture';
const headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const checks = {}, targetRequests = [], browserRequests = [], httpErrors = [], consoleMessages = [], pageErrors = [], layouts = [], captures = [], samples = [], held = [];
const runListReads = new Set();
const isRunListRead = request => request.method() === 'GET' && new URL(request.url()).pathname === '/api/acceptance/runs' && !new URL(request.url()).search;
const startedAt = new Date().toISOString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => fs.writeFileSync(join(OUT, name), Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const parse = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const delay = ms => new Promise(ready => setTimeout(ready, ms));
const profile = fs.mkdtempSync(join(tmpdir(), 'heimdall-browser-candidates-cdp-'));
let target, engine, browser, chromiumProcess, page, base, captureRequestCount = 0, engineLog = '', chromiumLog = '', failed, injectedPostPath;
console.log(JSON.stringify({ event: 'started', startedAt, outputDirectory: OUT }));

async function waitFor(fn, label, budget = 15000) {
  const deadline = Date.now() + budget; let last;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (cause) { last = cause; } await delay(75); }
  throw new Error(label + ': ' + (last?.message ?? 'expected state not reached'));
}
async function listen(server) { await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); }); return 'http://127.0.0.1:' + server.address().port; }
async function close(server) { if (server?.listening) await new Promise((ready, reject) => { server.close(cause => cause ? reject(cause) : ready()); server.closeAllConnections(); }); }
async function freePort() { const server = createServer(), address = await listen(server); await close(server); return new URL(address).port; }
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([ended, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
}
async function api(path, body, status = 200) {
  const response = await fetch(base + '/api/acceptance/' + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(value)); return value;
}
const latest = () => api('projects');
const detail = id => api('projects/' + id);
function runFiles(runId) { return fs.readdirSync(join(ROOT, runId)).sort().map(file => { const bytes = fs.readFileSync(join(ROOT, runId, file)); return { file, bytes: bytes.length, sha256: sha(bytes) }; }); }
function heads() { return Object.fromEntries(['catalog.json', 'catalog.previous.json'].map(file => [file, fs.readFileSync(join(ROOT, file)).toString('base64')])); }
function html(side) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Browser full review fixture</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial,sans-serif;background:#f0f4f8;color:#172438}header{padding:16px 24px;background:#172438;color:white;display:flex;justify-content:space-between}button,input{font:inherit;padding:9px}main{max-width:900px;padding:24px;margin:auto}h1{font-size:30px}.panel{height:260px;padding:24px;border:1px solid #bbc9d7;background:${side === 'target' ? '#8d2b10' : 'white'};color:${side === 'target' ? 'white' : '#172438'};transform:translateY(${side === 'target' ? '80px' : '0'})}nav[hidden]{display:none}nav{padding:12px;background:#d6e8ff}@media(max-width:500px){main{padding:16px}h1{font-size:24px}input{max-width:100%}}</style></head><body><header><strong>NORTHSTAR</strong><button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button></header><main><h1>Controlled candidate review</h1><nav id="menu" hidden><a href="details">Details</a></nav><section class="panel"><h2>Source evidence</h2><label>Test entry <input id="entry"></label><p id="literal">assertion-literal-review-sentinel</p></section></main><script>document.querySelector('#menu-toggle').addEventListener('click',function(){const menu=document.querySelector('#menu');menu.hidden=!menu.hidden;this.setAttribute('aria-expanded',String(!menu.hidden))})</script></body></html>`;
}
async function startEngine() {
  base = 'http://127.0.0.1:' + await freePort();
  engine = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE, windowsHide: true,
    env: { ...process.env, HEIMDALL_DATA_DIR: DATA, HEIMDALL_CONSOLE_DIR: resolve(CORE, '../console/dist'), HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.stdout.on('data', bytes => { engineLog += bytes; }); engine.stderr.on('data', bytes => { engineLog += bytes; });
  await waitFor(async () => { if (engine.exitCode !== null) throw new Error('Engine exited: ' + engineLog); return (await fetch(base + '/api/status', { headers })).ok; }, 'engine ready');
}
async function maintenance(action, flags, label) {
  const commandArgs = ['src/acceptance/catalog-maintenance-cli.mjs', action, '--target-schema', '4', '--root', ROOT, ...flags];
  const child = spawn(process.execPath, commandArgs, { cwd: CORE, windowsHide: true, env: { ...process.env, HEIMDALL_DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((ready, reject) => { child.once('error', reject); child.once('exit', ready); });
  save(label + '-command.json', { command: process.execPath, args: commandArgs, cwd: CORE, exitCode: code });
  save(label + '-stdout.log', stdout); save(label + '-stderr.log', stderr); assert.equal(code, 0, stderr); return JSON.parse(stdout);
}
async function startBrowser() {
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; }); chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  const active = join(profile, 'DevToolsActivePort'); await waitFor(() => fs.existsSync(active) && fs.readFileSync(active, 'utf8').split('\n')[0], 'CDP port');
  const endpoint = 'http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0]; save('cdp-version.json', await (await fetch(endpoint + '/json/version')).json());
  browser = await chromium.connectOverCDP(endpoint);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('heimdall-token', value); }, token);
  await context.addInitScript(() => {
    const facts = window.__browserCandidateBlobFacts = { created: [], revoked: [] }, create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); facts.created.push(url); return url; };
    URL.revokeObjectURL = url => { facts.revoked.push(url); return revoke(url); };
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', cause => pageErrors.push(cause.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() }); });
  page.on('request', request => { const url = new URL(request.url()); if (!url.pathname.startsWith('/api/acceptance/')) return;
    if (isRunListRead(request)) runListReads.add(request);
    browserRequests.push({ method: request.method(), path: url.pathname, query: url.search, ...(request.method() === 'POST' ? { body: request.postDataJSON() } : {}) }); });
  page.on('requestfinished', request => runListReads.delete(request));
  page.on('requestfailed', request => runListReads.delete(request));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() }); });
}
const catalogPanel = () => page.getByTestId('acceptance-catalog');
const component = () => page.getByTestId('browser-candidates');
const full = () => component().getByTestId('browser-candidate-review');
const posts = () => browserRequests.filter(row => row.method === 'POST' && row.path.endsWith('/browser-baseline-candidates'));
async function ready(projectId) {
  await waitFor(async () => await catalogPanel().locator('[name="catalog-project"]').inputValue() === projectId && await component().isVisible() && !(await catalogPanel().getByTestId('catalog-refresh').isDisabled()), 'candidate project ready');
}
async function selectProject(projectId) { await catalogPanel().locator('[name="catalog-project"]').selectOption(projectId); await ready(projectId); }
async function openConsole(projectId) {
  await page.goto(base, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await catalogPanel().getByTestId('catalog-toggle').click(); await selectProject(projectId);
}
async function openBinding(binding) {
  await page.locator('[data-testid="browser-binding-candidate-review"][data-binding-id="' + binding.id + '"]').click();
  await component().getByTestId('browser-candidate-plan').waitFor(); assert.equal(await full().getAttribute('data-source-binding-id'), binding.id);
}
async function openStored(candidate) {
  await component().locator('[data-testid="browser-candidate-open"][data-candidate-id="' + candidate.id + '"]').click();
  await component().getByTestId('browser-candidate-plan').waitFor(); assert.equal(await full().getAttribute('data-candidate-id'), candidate.id);
}
async function closeReview() { await component().getByTestId('browser-candidate-close').click(); await waitFor(async () => !(await full().count()), 'review closed'); }
async function assertBlobsReleased(label) {
  const facts = await page.evaluate(() => window.__browserCandidateBlobFacts); assert.deepEqual(facts.created.filter(value => !facts.revoked.includes(value)), [], label); return facts;
}
async function holdResponse(path) {
  let release, arrived = false; const gate = new Promise(ready => { release = ready; });
  const handler = async route => { const response = await route.fetch(); arrived = true; await gate; await route.fulfill({ response }).catch(() => {}); };
  await page.route('**' + path, handler, { times: 1 });
  const value = { release, arrived: () => waitFor(() => arrived, 'held response'), dispose: () => page.unroute('**' + path, handler) }; held.push(value); return value;
}
async function pauseRunListReads() {
  const queued = new Set(); let release;
  const gate = new Promise(ready => { release = ready; });
  const path = url => url.pathname === '/api/acceptance/runs' && !url.search;
  const handler = async route => {
    if (!isRunListRead(route.request())) return route.continue();
    queued.add(route.request()); await gate; await route.continue();
  };
  await page.route(path, handler);
  // Drain requests already forwarded before this route was installed. During
  // deliberate in-place corruption only candidate diagnostics should read it.
  await waitFor(() => [...runListReads].every(request => queued.has(request)), 'background run-list reads drained');
  return async () => {
    release(); await page.unrouteAll({ behavior: 'wait' });
    await Promise.all([...queued].map(request => request.response()));
  };
}
async function capture(name, width, height, theme) {
  await page.setViewportSize({ width, height }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  const results = page.getByTestId('acceptance-view-results'); if (await results.isVisible()) await results.click();
  await full().scrollIntoViewIfNeeded(); await full().evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const layout = await component().evaluate(element => ({ documentWidth: document.documentElement.scrollWidth, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, rect: element.getBoundingClientRect().toJSON() }));
  assert.ok(layout.clientWidth > 0); assert.ok(layout.documentWidth <= width + 1, JSON.stringify(layout)); assert.ok(layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
  layouts.push({ name, width, height, theme, ...layout }); await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false }); save(name + '-dom.txt', await component().innerText()); captures.push(name + '.png');
}

try {
  assert.ok(fs.existsSync(resolve(CORE, '../console/dist/index.html')), 'Build console first.');
  target = createServer((request, response) => { targetRequests.push({ method: request.method, path: request.url }); const side = new URL(request.url, 'http://fixture.invalid').pathname.split('/')[1];
    response.writeHead(['baseline', 'target'].includes(side) ? 200 : 404, { 'content-type': 'text/html' }); response.end(html(side)); });
  const fixtureBase = await listen(target); save('controlled-baseline.html', html('baseline')); save('controlled-target.html', html('target')); await startEngine();
  for (const mode of ['mirror', 'regression']) {
    const input = { name: 'Full Browser review ' + mode, mode, baselineUrl: fixtureBase + '/baseline?z=approved-query-review-sentinel&a=stable', targetUrl: fixtureBase + '/target?z=current-query-review-sentinel&a=development', routes: ['/'],
      viewports: [{ name: 'desktop', width: 960, height: 640 }, { name: 'mobile', width: 375, height: 812 }], timeoutMs: 5000, settleMs: 50,
      points: [{ id: 'menu', title: 'Menu and literal', route: '/', severity: 'high', steps: [{ action: 'fill', selector: '#entry', value: 'fill-value-review-sentinel' }, { action: 'click', selector: '#menu-toggle' }],
        assertions: [{ kind: 'visible', selector: '#menu' }, { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' }, { kind: 'text', selector: '#literal', equals: 'assertion-literal-review-sentinel' }] }] };
    const launched = await api('runs', input, 202);
    const manifest = await waitFor(async () => { const value = await api('runs/' + launched.runId); return value.status === 'completed' && value; }, 'fresh worker complete', 60000);
    // The manifest can be completed before the worker exits and releases its execution slot.
    await waitFor(async () => {
      const response = await fetch(base + '/api/status', { headers });
      assert.equal(response.status, 200);
      return (await response.json()).acceptance === null;
    }, 'acceptance slot released', 30000);
    const report = await api('runs/' + launched.runId + '/report'); assert.equal(report.gate, 'failed'); assert.equal(report.checks.length, 14);
    samples.push({ runId: launched.runId, mode, input, manifest, originalFiles: runFiles(launched.runId) });
  }
  captureRequestCount = targetRequests.length; checks.freshMirrorAndRegressionPreserveFailedComparison = true;
  // Explicit test setup. The browser steps below exercise the native candidate UI.
  const projects = {};
  for (const [key, side] of [['a', 'baseline'], ['b', 'target']]) {
    const project = (await api('projects', { ...cas(await latest()), name: 'Full review ' + side }, 201)).project;
    const release = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label: side + ' declared version', targetUrl: samples[0].input[side + 'Url'] }, 201)).release;
    const binding = (await api('projects/' + project.id + '/browser-source-bindings', { ...cas(await latest()), releaseId: release.id, runId: samples[0].runId, sourceSide: side }, 201)).binding;
    projects[key] = { project, release, binding };
  }
  const { a, b } = projects; await startBrowser(); await openConsole(a.project.id);
  const beforeMaintenance = heads(); await component().getByTestId('browser-candidate-maintenance').waitFor();
  assert.equal((await latest()).schemaVersion, 3); assert.deepEqual(heads(), beforeMaintenance); assert.equal(posts().length, 0);
  checks.schema3ShowsMaintenanceWithoutImplicitMigration = true;
  await page.goto('about:blank', { waitUntil: 'load' }); await stop(engine); const migrationPreview = await maintenance('--preview', [], 'maintenance-preview');
  const p = migrationPreview.source;
  await maintenance('--apply', ['--expected-generation-id', p.generationId, '--expected-revision', String(p.revision), '--expected-head-sha256', p.headSha256, '--expected-previous-sha256', p.previousSha256 ?? 'none', '--expected-plan-digest', migrationPreview.planDigest], 'maintenance-apply');
  await startEngine(); await openConsole(a.project.id); assert.equal((await latest()).schemaVersion, 4); checks.explicitOfflineCLIUpgradeThenOrdinaryRestart = true;
  const beforePreview = heads(); await openBinding(a.binding); assert.deepEqual(heads(), beforePreview);
  assert.equal(await component().getByTestId('browser-candidate-save').isDisabled(), true);
  const dto = await api('projects/' + a.project.id + '/browser-source-bindings/' + a.binding.id + '/candidate-preview'); save('baseline-full-preview.json', dto);
  assert.equal(dto.review.observations.length, 4); assert.equal(dto.executionReady, false); assert.equal(dto.presentation.completeSourceProjection, true);
  const bindingRead = await api('projects/' + a.project.id + '/browser-source-bindings/' + a.binding.id);
  assert.equal(JSON.stringify(bindingRead).includes('fill-value-review-sentinel'), false);
  assert.equal(JSON.stringify(bindingRead).includes('approved-query-review-sentinel'), false);
  await component().getByTestId('browser-candidate-plan').locator('summary').click();
  const planText = await component().getByTestId('browser-candidate-plan-json').innerText();
  for (const sentinel of ['?z=approved-query-review-sentinel&a=stable', '?z=current-query-review-sentinel&a=development', 'fill-value-review-sentinel', 'assertion-literal-review-sentinel']) assert.ok(planText.includes(sentinel), sentinel);
  for (const key of ['organizationContext', 'sourceProjection', 'scope', 'rules', 'selectedOracles', 'selectedEvidence', 'verifiedEvidence', 'environment', 'urlProof', 'limitations']) {
    await component().getByTestId('browser-candidate-raw-' + key).locator('summary').click();
    assert.ok((await component().getByTestId('browser-candidate-raw-' + key + '-json').innerText()).length > 1);
  }
  const behaviorIndex = dto.review.observations.findIndex(value => value.steps?.some(step => step.value === 'fill-value-review-sentinel'));
  assert.ok(behaviorIndex >= 0); const observation = component().getByTestId('browser-candidate-observation').nth(behaviorIndex); await observation.locator('summary').first().click();
  assert.ok((await observation.getByTestId('browser-candidate-observation-json').innerText()).includes('fill-value-review-sentinel'));
  await observation.locator('summary').first().click();
  const firstObservation = component().getByTestId('browser-candidate-observation').first(); await firstObservation.locator('summary').first().click();
  checks.fullTextRetainsOrderedQueryStepsAssertionsAndEveryManifest = true;
  const selected = dto.review.selectedEvidence[0].roles.screenshot;
  const imagePath = '/api/acceptance/projects/' + a.project.id + '/browser-source-bindings/' + a.binding.id + '/candidate-preview/evidence/' + selected.file;
  const originalBlobCount = await page.evaluate(() => window.__browserCandidateBlobFacts.created.length);
  await page.route('**' + imagePath + '?*', async route => { const response = await route.fetch(), bytes = Buffer.from(await response.body()); bytes[bytes.length - 1] ^= 1; await route.fulfill({ response, body: bytes }); }, { times: 1 });
  await component().getByTestId('browser-candidate-evidence-screenshot').first().click();
  await component().getByTestId('browser-candidate-evidence-error').waitFor();
  assert.equal(await page.evaluate(() => window.__browserCandidateBlobFacts.created.length), originalBlobCount);
  await component().getByTestId('browser-candidate-evidence-screenshot').first().click();
  await component().locator('[data-testid="browser-candidate-evidence-image"][data-role="screenshot"][data-observation-index="0"]').waitFor();
  await component().getByTestId('browser-candidate-evidence-repeat').first().click();
  await component().locator('[data-testid="browser-candidate-evidence-image"][data-role="repeat"][data-observation-index="0"]').waitFor();
  checks.dedicatedFreshPNGAndClientDigestValidation = true;
  for (const key of ['organizationContext', 'sourceProjection', 'scope', 'rules', 'selectedOracles', 'selectedEvidence', 'verifiedEvidence', 'environment', 'urlProof', 'limitations']) await component().getByTestId('browser-candidate-raw-' + key).locator('summary').click();
  await component().getByTestId('browser-candidate-plan').locator('summary').click(); await firstObservation.locator('summary').first().click();
  await capture('browser-candidate-desktop-dark', 1440, 1000, 'dark'); await capture('browser-candidate-mobile-light', 390, 844, 'light');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const beforeSave = parse(join(ROOT, 'catalog.json')), beforePosts = posts().length;
  await component().getByTestId('browser-candidate-confirm').check(); await component().getByTestId('browser-candidate-save').click();
  const savedA = await waitFor(async () => (await detail(a.project.id)).browserCandidates.find(value => value.sourceBindingId === a.binding.id), 'baseline candidate committed');
  await component().getByTestId('browser-candidate-notice').waitFor(); assert.equal(await full().count(), 0);
  assert.ok((await component().getByTestId('browser-candidate-notice').innerText()).includes(savedA.id));
  assert.equal(posts().length, beforePosts + 1); assert.deepEqual(Object.keys(posts().at(-1).body).sort(), ['expectedGenerationId', 'expectedRevision', 'sourceBindingId', 'contentDigest'].sort());
  const afterSave = parse(join(ROOT, 'catalog.json')); assert.equal(afterSave.revision, beforeSave.revision + 1); assert.equal(afterSave.events.length, beforeSave.events.length + 1); assert.equal(afterSave.events.at(-1).kind, 'browser-candidate-created');
  checks.explicitSaveCreatesExactlyOneCandidateEventAndRevision = true;
  await openStored(savedA); await closeReview(); await assertBlobsReleased('close');
  const late = await holdResponse('/api/acceptance/projects/' + a.project.id + '/browser-baseline-candidates/' + savedA.id);
  await component().locator('[data-testid="browser-candidate-open"][data-candidate-id="' + savedA.id + '"]').click(); await late.arrived();
  await selectProject(b.project.id); await selectProject(a.project.id); late.release(); await late.dispose(); await delay(150);
  assert.equal(await full().count(), 0); checks.projectABACannotRestoreLateFullReview = true;
  await selectProject(b.project.id); await openBinding(b.binding); assert.equal(await component().getByTestId('browser-candidate-save').isDisabled(), true);
  injectedPostPath = '/api/acceptance/projects/' + b.project.id + '/browser-baseline-candidates';
  await page.route('**' + injectedPostPath, async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); assert.equal(response.status(), 201); await route.fulfill({ status: 502, contentType: 'text/html', body: '<!doctype html><title>Controlled lost reply</title>' }); }, { times: 1 });
  const beforeLost = posts().length; await component().getByTestId('browser-candidate-confirm').check(); await component().getByTestId('browser-candidate-save').click();
  await component().getByTestId('browser-candidate-reconcile').waitFor(); assert.equal(posts().length, beforeLost + 1); assert.equal(await component().getByTestId('browser-candidate-save').count(), 0);
  await component().getByTestId('browser-candidate-reconcile').click();
  const savedB = await waitFor(async () => (await detail(b.project.id)).browserCandidates.find(value => value.sourceBindingId === b.binding.id), 'target candidate stored');
  await component().getByTestId('browser-candidate-notice').waitFor(); assert.ok((await component().getByTestId('browser-candidate-notice').innerText()).includes(savedB.id));
  await openStored(savedB); assert.equal(posts().length, beforeLost + 1);
  checks.lost201ReplyReconcilesByGETWithoutAnotherPOST = true;
  await capture('browser-candidate-desktop-light', 1440, 1000, 'light'); await capture('browser-candidate-mobile-dark', 390, 844, 'dark');
  await closeReview(); await assertBlobsReleased('project and close');
  const reportFile = join(ROOT, samples[0].runId, 'report.json'), reportBytes = fs.readFileSync(reportFile), beforeBad = heads();
  const resumeRunListReads = await pauseRunListReads();
  try {
    fs.writeFileSync(reportFile, Buffer.concat([reportBytes, Buffer.from(' ')]));
    await component().locator('[data-testid="browser-candidate-open"][data-candidate-id="' + savedB.id + '"]').click();
    await component().getByTestId('browser-candidate-diagnostics').waitFor(); assert.equal(await component().getByTestId('browser-candidate-plan').count(), 0);
    assert.equal((await api('projects/' + b.project.id + '/browser-baseline-candidates/' + savedB.id)).review, null);
    assert.equal((await api('projects/' + b.project.id + '/browser-baseline-candidates')).browserCandidates[0].id, savedB.id); assert.deepEqual(heads(), beforeBad);
  } finally {
    fs.writeFileSync(reportFile, reportBytes); assert.deepEqual(fs.readFileSync(reportFile), reportBytes);
    await resumeRunListReads();
  }
  await component().getByTestId('browser-candidate-reload').click(); await component().getByTestId('browser-candidate-plan').waitFor(); assert.equal(await full().getAttribute('data-candidate-id'), savedB.id);
  checks.badSourcePreservesHistoryAndRestoredBytesRevalidateSameCandidate = true;
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, hrefs: [...document.querySelectorAll('a[href]')].map(value => value.getAttribute('href')) }));
  assert.equal(/query-review-sentinel|fill-value-review-sentinel|assertion-literal-review-sentinel/.test(JSON.stringify(storage)), false);
  checks.fullSourceNeverEntersStorageOrHrefs = true;
  await closeReview(); save('blob-facts-before-restart.json', await assertBlobsReleased('before restart'));
  const beforeRestart = heads(); await page.goto('about:blank', { waitUntil: 'load' }); await stop(engine); await startEngine(); await openConsole(b.project.id); await openStored(savedB);
  assert.deepEqual(heads(), beforeRestart); assert.equal((await detail(b.project.id)).browserCandidates[0].id, savedB.id); checks.restartReadsSameDurableCandidateWithoutWrites = true;
  await closeReview(); save('blob-facts-after-restart.json', await assertBlobsReleased('after restart'));
  const catalog = parse(join(ROOT, 'catalog.json'));
  assert.equal(Object.keys(catalog.browserCandidates).length, 2); assert.equal(Object.keys(catalog.approvals).length, 0); assert.equal(Object.keys(catalog.selections).length, 0);
  assert.equal(fs.existsSync(join(ROOT, 'dispatches')), false); assert.equal(targetRequests.length, captureRequestCount);
  for (const sample of samples) assert.deepEqual(runFiles(sample.runId), sample.originalFiles);
  checks.noExtraTargetRequestsOrExecutionAndAllSourceBytesUnchanged = true;
  assert.deepEqual(pageErrors, []); assert.deepEqual(httpErrors, [{ method: 'POST', path: injectedPostPath, status: 502 }]);
  for (const message of consoleMessages) assert.ok(message.type === 'error' && /status of 502/.test(message.text) && new URL(message.location.url).pathname === injectedPostPath, JSON.stringify(message));
  assert.ok(consoleMessages.length <= 1); checks.onlyExactInjectedPOST502IsAllowed = true;
  save('catalog-final.json', catalog); save('projects.json', projects); save('runs.json', samples);
  save('source-file-digests.json', samples.map(value => ({ runId: value.runId, before: value.originalFiles, after: runFiles(value.runId) })));
  save('browser-checks.json', { schemaVersion: 1, status: 'passed', startedAt, finishedAt: new Date().toISOString(), evidenceLevel: 'fresh-local-fixture-real-engine-workers-native-browser-controls', browser: 'Chromium CDP', checks, checkCount: Object.keys(checks).length,
    layouts, captures, pageErrors, httpErrors, consoleMessages, browserCandidatePostCount: posts().length, captureTargetRequests: captureRequestCount, candidateAndReadTargetRequests: targetRequests.length - captureRequestCount,
    executionReady: false, boundary: 'Explicit project/release/source-binding setup; native full review, confirmation, save and read. Two real Browser captures. One controlled lost 201 reply and one restored source whitespace injection. No approval, selection, dispatch or executor.' });
  console.log(JSON.stringify({ status: 'passed', checkCount: Object.keys(checks).length, outputDirectory: OUT, checks }, null, 2));
} catch (cause) {
  failed = cause; save('failure.json', { status: 'failed', message: cause.message, stack: cause.stack, checks, outputDirectory: OUT });
  if (page) { await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {}); save('failure-dom.txt', await page.locator('body').innerText().catch(() => 'unavailable')); } throw cause;
} finally {
  for (const value of held) value.release();
  try { await browser?.close(); } finally {
    await stop(chromiumProcess); await stop(engine); await close(target);
    save('engine.log', engineLog); save('chromium.log', chromiumLog); save('target-requests.json', targetRequests); save('browser-requests.json', browserRequests); save('layouts.json', layouts); save('browser-errors.json', { pageErrors, httpErrors, consoleMessages });
    const profilePath = resolve(profile), prefix = resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/');
    assert.ok(profilePath.startsWith(prefix) && profilePath.includes('heimdall-browser-candidates-cdp-')); fs.rmSync(profilePath, { recursive: true, force: true }); if (failed) process.exitCode = 1;
  }
}
