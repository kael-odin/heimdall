#!/usr/bin/env node
/** D4: durable denial, a real unfinished ingress, same-origin restart and native Web Locks. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { openSlowBrowserPost, browserResolutionSha as hash, browserResolutionDelay as delay,
  browserResolutionWait as waitFor } from './fixtures/browser-resolution-stream.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace/_runs/browser-resolution-console-smoke-' + randomUUID()));
assert.equal(process.argv.length <= 3, true); assert.equal(fs.existsSync(OUT), false, 'Use a fresh evidence directory.');
fs.mkdirSync(OUT, { recursive: true });
const DATA = join(OUT, 'runtime'), ROOT = join(DATA, 'acceptance'); fs.mkdirSync(DATA);
const ingressScope = join(OUT, 'ingress-scope.json'), ingressLog = join(OUT, 'engine-ingress.jsonl');
const token = 'browser-resolution-controlled-fixture', headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const checks = {}, browserRequests = [], targetRequests = [], controlledReplies = [], pageErrors = [], consoleMessages = [], captures = [], layouts = [];
const startedAt = new Date().toISOString(), cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const save = (name, value) => fs.writeFileSync(join(OUT, name), Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const parse = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const ingress = () => fs.existsSync(ingressLog) ? fs.readFileSync(ingressLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
let engine, chromiumProcess, browser, context, page, target, base, targetBase, project, candidate, targetRelease, source, sourceAvailable = true;
let engineLog = '', chromiumLog = '', failure, slow;
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exit, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
}
async function api(path, body, status = 200) {
  const response = await fetch(base + '/api/acceptance/' + path, { headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const payload = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(payload)); return payload;
}
const latest = () => api('projects'), executionPath = () => 'projects/' + project.id + '/browser-executions';
const fullExecutionPath = () => '/api/acceptance/' + executionPath();
const receiptKey = () => 'heimdall:browser-operations:v1:' + base + ':' + project.id;
const receipts = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]'), receiptKey());
const component = () => page.getByTestId('browser-execution'), panel = () => page.getByTestId('acceptance-catalog');
const uiStarts = () => browserRequests.filter(item => item.method === 'POST' && item.path === fullExecutionPath());
const mutationCount = () => browserRequests.filter(item => item.method === 'POST').length;
function tree(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [file, fact] of Object.entries(tree(path))) result[entry.name + '/' + file] = fact;
    else { assert.equal(entry.isFile(), true); const bytes = fs.readFileSync(path); result[entry.name] = { bytes: bytes.length, sha256: hash(bytes) }; }
  }
  return result;
}
function rejectionFacts(operationId) {
  const folder = join(ROOT, 'browser-operations/v1', operationId), files = fs.readdirSync(folder).sort();
  assert.deepEqual(files, ['rejection.json'], 'A rejected decision cannot contain dispatch, run, evidence or a head.');
  const bytes = fs.readFileSync(join(folder, 'rejection.json'));
  return { files, bytes: bytes.length, sha256: hash(bytes), rejection: JSON.parse(bytes.toString('utf8')) };
}
function html(broken = false) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>D4 controlled acceptance</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial;background:#eef2f6;color:#172438}header{padding:16px 24px;background:#172438;color:white;display:flex;justify-content:space-between}main{max-width:900px;padding:24px;margin:auto}button,input{font:inherit;padding:8px}.panel{height:250px;padding:24px;border:1px solid #bbc9d7;background:' + (broken ? '#8d2b10;color:white;transform:translateY(60px)' : 'white') + '}nav[hidden]{display:none}nav{padding:12px;background:#d6e8ff}@media(max-width:500px){main{padding:16px}input{max-width:100%}}</style></head><body><header><strong>NORTHSTAR</strong><button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button></header><main><h1>Original approval is exact</h1><nav id="menu" hidden>Expanded navigation</nav><section class="panel"><h2>Captured approved source</h2><label>Test entry <input id="entry"></label><p id="literal">d4-source-memory-sentinel</p></section></main><script>document.querySelector("#menu-toggle").addEventListener("click",function(){' + (broken ? 'return;' : 'const menu=document.querySelector("#menu");menu.hidden=!menu.hidden;this.setAttribute("aria-expanded",String(!menu.hidden))') + '})</script></body></html>';
}
async function startEngine() {
  if (!base) { const socket = createServer(); base = await listen(socket); await close(socket); }
  const observer = fileURLToPath(new URL('./fixtures/browser-resolution-ingress.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', pathToFileURL(observer).href, 'src/engine-server.mjs', new URL(base).port], {
    cwd: CORE, windowsHide: true, env: { ...process.env, HEIMDALL_DATA_DIR: DATA, HEIMDALL_CONSOLE_DIR: resolve(CORE, '../console/dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0',
      HEIMDALL_BROWSER_RESOLUTION_INGRESS_SCOPE: ingressScope, HEIMDALL_BROWSER_RESOLUTION_INGRESS_LOG: ingressLog },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine = child; child.stdout.on('data', bytes => { engineLog += bytes; }); child.stderr.on('data', bytes => { engineLog += bytes; });
  await waitFor(async () => { if (child.exitCode !== null) throw Error(engineLog); return (await fetch(base + '/api/status', { headers })).ok; }, 'fixed-port engine ready');
}
function observePage(value) {
  value.setDefaultTimeout(25000);
  value.on('pageerror', cause => pageErrors.push(cause.message));
  value.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() }); });
  value.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/acceptance/')) browserRequests.push({ method: request.method(), path: url.pathname,
      ...(request.method() === 'POST' ? { body: request.postDataJSON() } : {}) });
  });
}
async function startBrowser() {
  const profile = join(OUT, 'chromium-profile'); fs.mkdirSync(profile);
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; }); chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  const active = join(profile, 'DevToolsActivePort');
  await waitFor(() => fs.existsSync(active) && fs.readFileSync(active, 'utf8').split('\n')[0], 'CDP ready');
  const cdp = 'http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0];
  save('cdp-version.json', await (await fetch(cdp + '/json/version')).json()); browser = await chromium.connectOverCDP(cdp);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('heimdall-token', value); }, token);
  page = await context.newPage(); observePage(page);
}
async function openConsole() {
  await page.goto(base, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await panel().getByTestId('catalog-toggle').click(); await panel().locator('[name="catalog-project"]').selectOption(project.id);
  await component().waitFor(); await waitFor(async () => !(await panel().getByTestId('catalog-refresh').isDisabled()), 'catalog ready');
}
async function capture(name, width, height, theme) {
  await page.setViewportSize({ width, height }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await component().scrollIntoViewIfNeeded(); await component().evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const layout = await component().evaluate(element => ({ documentWidth: document.documentElement.scrollWidth, clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth, rect: element.getBoundingClientRect().toJSON(), text: element.innerText }));
  assert.ok(layout.clientWidth > 0 && layout.documentWidth <= width + 1 && layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
  layouts.push({ name, width, height, theme, ...layout }); captures.push(name + '.png');
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false }); save(name + '-dom.txt', layout.text);
}
async function unavailable(route, kind) {
  controlledReplies.push({ kind, method: route.request().method(), path: new URL(route.request().url()).pathname, status: 503 });
  await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
    code: 'BROWSER_EXECUTION_UNAVAILABLE', error: 'Controlled smoke transport reply unavailable.', outcomeUnknown: true,
  }) });
}
async function approveStart() {
  await component().getByTestId('browser-execution-candidate').selectOption(candidate.id);
  await component().getByTestId('browser-execution-target').selectOption(targetRelease.id);
  await component().getByTestId('browser-execution-review').click(); await component().getByTestId('browser-execution-confirmation').waitFor();
  await component().getByTestId('browser-execution-confirm').check();
  await waitFor(async () => !(await component().getByTestId('browser-execution-start').isDisabled()), 'native approval ready');
  const count = uiStarts().length; await component().getByTestId('browser-execution-start').click();
  return waitFor(() => uiStarts().length === count + 1 && uiStarts().at(-1).body, 'one original UI start');
}
async function unknown(input) {
  await waitFor(async () => (await receipts()).some(value => value.operationId === input.operationId), 'durable original receipt');
  await component().locator('[data-browser-receipt="' + input.operationId + '"]').waitFor();
  assert.deepEqual((await receipts()).find(value => value.operationId === input.operationId), input);
  await waitFor(async () => !(await component().getByTestId('browser-execution-review').isDisabled()), 'unknown reply settles the original write');
  const starts = uiStarts().length;
  await component().getByTestId('browser-execution-review').click();
  await component().getByTestId('browser-execution-confirmation').waitFor();
  await component().getByTestId('browser-execution-confirm').check();
  assert.equal(await component().getByTestId('browser-execution-start').isDisabled(), true);
  assert.equal(uiStarts().length, starts);
  assert.deepEqual((await receipts()).find(value => value.operationId === input.operationId), input);
}
async function denyUI(input) {
  const confirm = component().locator('[data-testid="browser-execution-deny-confirm"][data-operation-id="' + input.operationId + '"]');
  const button = component().locator('[data-testid="browser-execution-deny"][data-operation-id="' + input.operationId + '"]');
  await confirm.check(); await waitFor(async () => !(await button.isDisabled()), 'explicit deny ready'); await button.click();
}
async function nativeLocks() {
  const secondary = await context.newPage(); observePage(secondary); await secondary.goto(base, { waitUntil: 'networkidle' });
  // A data: module cannot resolve relative imports, so its one dependency is inlined as a data: URL too.
  const dataModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
  const collectionsUrl = dataModule(fs.readFileSync(resolve(CORE, '../console/src/receipt-collections.js'), 'utf8'));
  const executionSource = fs.readFileSync(resolve(CORE, '../console/src/acceptance-browser-execution.js'), 'utf8');
  assert.equal(executionSource.split("from './receipt-collections.js'").length, 2, 'Receipt module has exactly one relative import to inline.');
  const moduleUrl = dataModule(executionSource.replace("from './receipt-collections.js'", 'from ' + JSON.stringify(collectionsUrl)));
  const lockProject = 'ap-' + randomUUID(), key = 'heimdall:browser-operations:v1:' + base + ':' + lockProject;
  const request = { operationId: 'bo-' + randomUUID(), ...cas(await latest()), candidateId: candidate.id,
    contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id };
  const a = { ...request }, b = { ...request, operationId: 'bo-' + randomUUID() }, c = { ...request, operationId: 'bo-' + randomUUID() };
  for (const item of [page, secondary]) await item.evaluate(async ({ moduleUrl, projectId, origin }) => {
    window.__d4Module = await import(moduleUrl);
    window.__d4Client = window.__d4Module.createBrowserExecutionReceipts({ projectId, origin, storage: localStorage });
    if (!window.__d4Client.canWrite) throw Error('Native Web Locks unavailable.');
  }, { moduleUrl, projectId: lockProject, origin: base });
  const evidence = [];
  async function interleave(name, first, second, expected, expectedResults = null) {
    const before = await page.evaluate(() => window.__d4Client.read());
    await page.evaluate(key => {
      window.__d4Held = false;
      window.__d4Hold = navigator.locks.request(key, { mode: 'exclusive' }, async () => {
        window.__d4Held = true; await new Promise(resolve => { window.__d4Release = resolve; }); window.__d4Held = false;
      });
    }, key);
    await waitFor(() => page.evaluate(() => window.__d4Held), 'external native lock held');
    await page.evaluate(({ method, request }) => { window.__d4Write = window.__d4Client[method](request); }, first);
    await secondary.evaluate(({ method, request }) => { window.__d4Write = window.__d4Client[method](request); }, second);
    const queued = await waitFor(async () => {
      const value = await page.evaluate(() => navigator.locks.query());
      return value.pending.filter(item => item.name === key).length === 2 && value;
    }, 'two actual native lock waiters');
    assert.deepEqual(await page.evaluate(() => window.__d4Client.read()), before, 'Queued writes cannot run under another holder.');
    await page.evaluate(() => window.__d4Release());
    const results = await Promise.all([page.evaluate(() => window.__d4Write), secondary.evaluate(() => window.__d4Write)]);
    if (expectedResults !== null) assert.deepEqual(results, expectedResults);
    const primaryValue = await page.evaluate(() => window.__d4Client.read()), secondaryValue = await secondary.evaluate(() => window.__d4Client.read());
    assert.deepEqual(primaryValue, expected); assert.deepEqual(secondaryValue, expected);
    evidence.push({ name, key, before, queued, after: primaryValue, results });
  }
  await interleave('save-save', { method: 'save', request: a }, { method: 'save', request: b }, [a, b]);
  await interleave('resolve-save', { method: 'resolveExact', request: a }, { method: 'save', request: c }, [b, c]);
  await interleave('resolve-resolve', { method: 'resolveExact', request: b }, { method: 'resolveExact', request: c }, []);
  await interleave('claim-start-claim-start', { method: 'claimForStart', request: a }, { method: 'claimForStart', request: b }, [a], [true, false]);
  await page.evaluate(request => window.__d4Client.resolveExact(request), a);
  const noLock = await secondary.evaluate(async ({ projectId, origin, request }) => {
    const client = window.__d4Module.createBrowserExecutionReceipts({ projectId, origin, storage: localStorage, locks: null });
    let rejected = false; try { await client.save(request); } catch { rejected = true; }
    return { canWrite: client.canWrite, values: client.read(), rejected };
  }, { projectId: lockProject, origin: base, request: a });
  assert.deepEqual(noLock, { canWrite: false, values: [], rejected: true });
  save('native-lock-interleavings.json', evidence); checks.nativeTwoPagesSerializeAllReceiptWrites = true; checks.noWebLocksAllowsReadAndRefusesWrite = true;
  await secondary.close();
}

console.log(JSON.stringify({ event: 'started', startedAt, outputDirectory: OUT }));
try {
  assert.equal(fs.existsSync(resolve(CORE, '../console/dist/index.html')), true, 'Build console first.');
  const owner = acquireAcceptanceOwner({ root: ROOT });
  try { await createAcceptanceCatalogStore({ root: ROOT, owner }).initialize({ createSchemaVersion: 4 }); } finally { owner.release(); }
  target = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.invalid').pathname; targetRequests.push({ method: request.method, path });
    const missing = path.startsWith('/source') && !sourceAvailable;
    response.writeHead(missing ? 410 : 200, { 'content-type': 'text/html' }); response.end(missing ? 'Captured source offline' : html(path.startsWith('/broken')));
  });
  targetBase = await listen(target); await startEngine();
  const plan = { mode: 'regression', name: 'D4 fresh fixed source', baselineUrl: targetBase + '/source?d4-url-memory-sentinel=1',
    targetUrl: targetBase + '/broken', routes: ['/'], viewports: [{ name: 'desktop', width: 960, height: 640 }, { name: 'mobile', width: 375, height: 812 }],
    timeoutMs: 4000, settleMs: 50, points: [{ id: 'menu', title: 'Expanded menu', route: '/', severity: 'high',
      steps: [{ action: 'fill', selector: '#entry', value: 'd4-fill-memory-sentinel' }, { action: 'click', selector: '#menu-toggle' }],
      assertions: [{ kind: 'visible', selector: '#menu' }, { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' },
        { kind: 'text', selector: '#literal', equals: 'd4-source-memory-sentinel' }] }] };
  source = await api('runs', plan, 202);
  await waitFor(async () => (await api('runs/' + source.runId)).status === 'completed', 'fresh source capture', 90000);
  const sourceReport = await api('runs/' + source.runId + '/report'); assert.equal(sourceReport.gate, 'failed'); assert.equal(sourceReport.checks.length, 14);
  project = (await api('projects', { ...cas(await latest()), name: 'D4 durable start decisions' }, 201)).project;
  const release = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label: 'Captured approved source', targetUrl: plan.baselineUrl }, 201)).release;
  const binding = (await api('projects/' + project.id + '/browser-source-bindings', { ...cas(await latest()), releaseId: release.id, runId: source.runId, sourceSide: 'baseline' }, 201)).binding;
  const preview = await api('projects/' + project.id + '/browser-source-bindings/' + binding.id + '/candidate-preview');
  candidate = (await api('projects/' + project.id + '/browser-baseline-candidates', { ...cas(await latest()), sourceBindingId: binding.id, contentDigest: preview.contentDigest }, 201)).candidate;
  targetRelease = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label: 'Healthy new target', targetUrl: targetBase + '/healthy' }, 201)).release;
  save('source-and-candidate.json', { source, sourceReport, project, release, binding, candidate, targetRelease });
  const originalSource = tree(join(ROOT, source.runId)), sourceRequests = targetRequests.filter(item => item.path.startsWith('/source')).length;
  sourceAvailable = false; await startBrowser(); await openConsole();

  // A: the native UI's original body is sent once on one real HTTP socket.
  let aInput;
  const slowRoute = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    aInput = route.request().postDataJSON();
    const traceId = 'resolution-smoke-' + randomUUID();
    save('ingress-scope.json', { path: fullExecutionPath(), operationId: aInput.operationId, traceId });
    slow = openSlowBrowserPost({ url: base + fullExecutionPath(), body: Buffer.from(route.request().postData()), headers, operationId: aInput.operationId, traceId });
    await slow.prefixWritten;
    await waitFor(() => ingress().some(item => item.event === 'data' && item.bytes === slow.splitAt), 'engine really received the unfinished prefix');
    await unavailable(route, 'A-original-browser-reply-only');
  };
  await page.route('**' + fullExecutionPath(), slowRoute);
  const a = await approveStart(); await unknown(a);
  await waitFor(() => aInput && ingress().some(item => item.event === 'data'), 'A prefix observed');
  assert.deepEqual(a, aInput, 'The relayed bytes belong to the exact original native UI confirmation.');
  assert.equal(ingress().some(item => item.event === 'end'), false);
  const beforeA = targetRequests.length; save('A-receipt-before-deny.json', await receipts());
  await capture('resolution-A-desktop-light', 1440, 1000, 'light');
  await denyUI(a); await waitFor(async () => !(await receipts()).some(item => item.operationId === a.operationId), 'A verified rejection clears exact receipt');
  const aProof = await api(executionPath() + '/' + a.operationId + '/resolution'); assert.equal(aProof.outcome, 'rejected');
  const aFacts = rejectionFacts(a.operationId); assert.equal(aFacts.sha256, aProof.rejectionSha256);
  assert.equal(ingress().some(item => item.event === 'end'), false, 'Deny completed before the original body ended.');
  slow.finish(); const aReply = await slow.response;
  assert.equal(aReply.status, 409); assert.equal(aReply.payload.code, 'BROWSER_START_REJECTED');
  const observed = await waitFor(() => ingress().find(item => item.event === 'end'), 'same original ingress end');
  assert.equal(observed.bytes, slow.bytes); assert.equal(observed.bodySha256, slow.bodySha256);
  assert.equal(observed.operationId, a.operationId); assert.equal(observed.traceId, slow.traceId);
  assert.equal(new Set(ingress().map(item => item.connectionId)).size, 1); assert.equal(ingress().filter(item => item.event === 'request').length, 1);
  assert.equal(uiStarts().length, 1); assert.equal(browserRequests.filter(item => item.method === 'POST' && item.path === fullExecutionPath() + '/' + a.operationId + '/deny-start').length, 1);
  assert.equal(targetRequests.length, beforeA); assert.equal((await api(executionPath())).operations.length, 0);
  assert.deepEqual(rejectionFacts(a.operationId), aFacts);
  save('A-original-request.json', { request: a, transport: { traceId: slow.traceId, bytes: slow.bytes, splitAt: slow.splitAt, bodySha256: slow.bodySha256,
    events: slow.events }, ingress: ingress(), reply: aReply.payload, proof: aProof, decision: aFacts,
    runnerEvidence: { targetRequestsAdded: 0, acceptedOperations: 0, decisionFiles: aFacts.files } });
  await page.unroute('**' + fullExecutionPath(), slowRoute);
  checks.sameOriginalUnfinishedIngressLosesToDurableDeny = true; checks.rejectedOriginalHasNoDispatchRunOrTargetNavigation = true;

  // B: original start is never delivered; real deny commits, but its browser reply is lost.
  const dropStart = route => route.request().method() === 'POST' ? unavailable(route, 'B-original-start-not-delivered') : route.continue();
  await page.route('**' + fullExecutionPath(), dropStart);
  const b = await approveStart(); await unknown(b); await page.unroute('**' + fullExecutionPath(), dropStart);
  const bPath = fullExecutionPath() + '/' + b.operationId, proofPattern = '**' + bPath + '/resolution', denyPattern = '**' + bPath + '/deny-start';
  const blockProof = route => unavailable(route, 'B-proof-transport-blocked-before-restart');
  let committedProof, lostDenyCount = 0;
  const loseDeny = async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200);
    committedProof = await response.json(); assert.equal(committedProof.outcome, 'rejected'); lostDenyCount++;
    await unavailable(route, 'B-real-deny-committed-reply-lost');
  };
  await page.route(proofPattern, blockProof); await page.route(denyPattern, loseDeny);
  const bBefore = await receipts(), beforeB = targetRequests.length; save('B-receipt-before-deny.json', bBefore);
  await denyUI(b); await waitFor(() => lostDenyCount === 1, 'B real denial committed');
  await waitFor(async () => /Controlled smoke transport/.test(await component().getByTestId('browser-execution-error').innerText()), 'B unknown reply is visible');
  assert.deepEqual(await receipts(), bBefore); const bFacts = rejectionFacts(b.operationId);
  assert.equal(bFacts.sha256, committedProof.rejectionSha256);
  await capture('resolution-B-mobile-dark', 390, 844, 'dark'); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('about:blank'); await page.unroute(proofPattern, blockProof); await page.unroute(denyPattern, loseDeny);
  const sameBase = base, sameContext = context, sameKey = receiptKey(), requestIndex = browserRequests.length, postsBeforeRestart = mutationCount();
  await stop(engine); await startEngine(); assert.equal(base, sameBase); assert.equal(context, sameContext); assert.equal(receiptKey(), sameKey);
  await openConsole(); await waitFor(async () => !(await receipts()).some(item => item.operationId === b.operationId), 'same-origin restart reads proof and precisely clears B');
  const recoveryRequests = browserRequests.slice(requestIndex).filter(item => item.path.startsWith(bPath));
  assert.ok(recoveryRequests.some(item => item.method === 'GET' && item.path === bPath + '/resolution'));
  assert.ok(recoveryRequests.every(item => item.method === 'GET')); assert.equal(mutationCount(), postsBeforeRestart);
  assert.equal(uiStarts().length, 2); assert.equal(lostDenyCount, 1);
  assert.equal(browserRequests.filter(item => item.method === 'POST' && item.path === bPath + '/deny-start').length, 1);
  assert.equal(targetRequests.length, beforeB); assert.deepEqual(rejectionFacts(b.operationId), bFacts); assert.deepEqual(await receipts(), []);
  save('B-restart-proof.json', { request: b, originalStartDelivered: false, lostDenyCount, dataRoot: ROOT, originBefore: sameBase, originAfter: base,
    storageKeyBefore: sameKey, storageKeyAfter: receiptKey(), receiptBefore: bBefore, receiptAfter: await receipts(),
    committedProof, proofAfter: await api(executionPath() + '/' + b.operationId + '/resolution'), decision: bFacts, recoveryRequests });
  checks.lostCommittedDenySurvivesSameRootOriginPortAndContextRestart = true; checks.restartRecoveryUsesOnlyGetAndPreservesDecisionBytes = true;
  await capture('resolution-recovered-desktop-dark', 1440, 1000, 'dark');

  await nativeLocks();
  const beforeFresh = uiStarts().length, fresh = await approveStart();
  assert.notEqual(fresh.operationId, a.operationId); assert.notEqual(fresh.operationId, b.operationId);
  const complete = await waitFor(async () => {
    const value = await api(executionPath() + '/' + fresh.operationId);
    assert.ok(!['failed', 'interrupted'].includes(value.state), JSON.stringify(value)); return value.state === 'completed' && value;
  }, 'new explicitly reviewed operation completes', 90000);
  assert.equal(complete.gate, 'passed'); assert.equal(uiStarts().length, beforeFresh + 1);
  await waitFor(async () => (await receipts()).length === 0, 'successful original confirmation needs complete resolution proof');
  save('fresh-after-resolution.json', { request: fresh, operation: complete, proof: await api(executionPath() + '/' + fresh.operationId + '/resolution') });
  const freshRow = component().locator(`[data-browser-operation="${fresh.operationId}"]`);
  await freshRow.getByRole('button', { name: '读取完成报告与证据', exact: true }).waitFor();
  await waitFor(async () => /已完成\s*·\s*通过/.test(await freshRow.innerText()), 'completed fresh operation is rendered as passed');
  assert.equal(await freshRow.getByTestId('browser-execution-stop').count(), 0);
  save('fresh-rendered-state.json', { operationId: fresh.operationId, text: await freshRow.innerText(),
    reportButtons: await freshRow.getByRole('button', { name: '读取完成报告与证据', exact: true }).count(),
    stopButtons: await freshRow.getByTestId('browser-execution-stop').count() });
  checks.explicitFreshReviewUsesNewBoAndRunsNormally = true;
  await capture('resolution-fresh-mobile-light', 390, 844, 'light');
  const storage = await page.evaluate(() => ({ local: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'heimdall-token')),
    session: { ...sessionStorage }, hrefs: [...document.querySelectorAll('a[href]')].map(element => element.getAttribute('href')) }));
  assert.equal(/d4-(url|fill|source)-memory-sentinel/.test(JSON.stringify(storage)), false); save('browser-storage.json', storage);
  assert.equal(targetRequests.filter(item => item.path.startsWith('/source')).length, sourceRequests);
  assert.deepEqual(tree(join(ROOT, source.runId)), originalSource); save('source-file-digests.json', originalSource);
  assert.equal(pageErrors.length, 0); assert.equal(await page.locator('vite-error-overlay').count(), 0);
  for (const message of consoleMessages) {
    assert.equal(message.type, 'error', JSON.stringify(message));
    assert.equal(message.text, 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)', JSON.stringify(message));
    assert.ok(controlledReplies.some(reply => new URL(message.location.url).pathname === reply.path), JSON.stringify(message));
  }
  assert.ok(consoleMessages.length <= controlledReplies.length);
  checks.fullSourceRemainsMemoryOnlyAndOriginalCaptureUnchanged = true; checks.renderedUiHasNoUnexpectedPageOrConsoleErrors = true;
  save('final-operation-collection.json', await api(executionPath()));
} catch (cause) {
  failure = cause; save('failure.json', { name: cause.name, message: cause.message, stack: cause.stack });
  if (page) { await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {}); save('failure-dom.txt', await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  slow?.abort();
  save('checks.json', checks); save('browser-requests.json', browserRequests); save('target-requests.json', targetRequests);
  save('controlled-transport-replies.json', controlledReplies); save('browser-errors.json', { pageErrors, consoleMessages }); save('layouts.json', layouts);
  if (browser) await browser.close().catch(() => {}); await stop(chromiumProcess); await stop(engine); await close(target);
  save('engine.log', engineLog); save('chromium.log', chromiumLog);
  save('summary.json', { status: failure ? 'failed' : 'passed', startedAt, endedAt: new Date().toISOString(),
    browserPath: 'Repository Playwright CDP, local controlled source and target', checks: Object.keys(checks).length, captures, outputDirectory: OUT });
}
if (failure) { console.error(failure.stack); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'passed', checks: Object.keys(checks).length, outputDirectory: OUT }));
